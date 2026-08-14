/**
 * dsh-view-image — a vision bridge tool for DeepSeek Harness.
 *
 * The default DSH model cannot see images. This plugin registers a
 * `view_image` tool that sends an image to a vision-capable model through an
 * OpenAI-compatible Responses API and returns the description as text.
 *
 * Configuration precedence (highest first):
 *   1. `config` passed to the plugin row in the profile's `cordis.patch.yml`
 *   2. shared config file `~/.dsh/profiles/web/vision-bridge-config.json`
 *      { apiBase, model, apiKeyEnv, apiKey }
 *   3. environment variable fallback for the key (`apiKeyEnv`, default
 *      `VIEW_IMAGE_API_KEY`).
 *
 * The vision endpoint MUST be configured explicitly (URL + key): there is no
 * built-in provider. Without a configuration the tool answers with a readable
 * setup error.
 *
 * Security: only image extensions are accepted; the image bytes are sent to
 * the configured vision endpoint. No credentials are logged or written to
 * disk by this plugin.
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-view-image';
export const inject = ['tools'];

const DEFAULTS = {
  apiBase: '',
  model: '',
  apiKeyEnv: '',
  apiKey: '',
  visionBridgeConfigPath: '~/.dsh/profiles/web/vision-bridge-config.json',
  maxOutputTokens: 2000,
  maxImageBytes: 15 * 1024 * 1024,
  timeoutMs: 180000,
};

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function loadSharedVisionConfig(config) {
  try {
    const path = expandHome(config.visionBridgeConfigPath ?? DEFAULTS.visionBridgeConfigPath);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function resolveConfig(config = {}) {
  const shared = loadSharedVisionConfig(config);
  const merged = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    merged[key] = config[key] ?? shared[key] ?? value;
  }
  return merged;
}

function mimeForPath(path) {
  return IMAGE_MIME[extname(path).toLowerCase()] ?? null;
}

function expandHome(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

export function resolveApiKey(config) {
  const envName = config.apiKeyEnv || 'VIEW_IMAGE_API_KEY';
  if (envName && process.env[envName]) return process.env[envName];
  if (config.apiKey) return config.apiKey;
  return undefined;
}

/** Resolve the image source to a data URL, or throw a readable error. */
export async function resolveImageDataUrl(imagePath, cwd) {
  let target = String(imagePath ?? '').trim();
  if (!target) throw new Error('image_path 为空：请提供本地图片路径或 http(s) URL');

  if (/^data:image\//i.test(target)) {
    const comma = target.indexOf(',');
    if (comma < 0) throw new Error('data URL 格式无效');
    const buffer = Buffer.from(target.slice(comma + 1), 'base64');
    if (buffer.length === 0) throw new Error('data URL 图片为空');
    if (buffer.length > DEFAULTS.maxImageBytes) throw new Error(`图片过大：${buffer.length} 字节（上限 ${DEFAULTS.maxImageBytes}）`);
    return { dataUrl: target, bytes: buffer.length };
  }

  if (/^https?:\/\//i.test(target)) {
    const response = await fetch(target);
    if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status} ${response.statusText}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error('下载的图片为空');
    if (buffer.length > DEFAULTS.maxImageBytes) throw new Error(`图片过大：${buffer.length} 字节（上限 ${DEFAULTS.maxImageBytes}）`);
    const contentType = response.headers.get('content-type') ?? '';
    const mime = contentType.startsWith('image/') ? contentType.split(';')[0].trim() : 'image/png';
    return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, bytes: buffer.length };
  }

  const resolvedPath = isAbsolute(target) ? target : resolve(cwd ?? process.cwd(), target);
  const mime = mimeForPath(resolvedPath);
  if (!mime) throw new Error(`不支持的文件类型：${resolvedPath}（只接受 png/jpg/jpeg/gif/webp/bmp 图片）`);
  let buffer;
  try {
    buffer = await readFile(resolvedPath);
  } catch (error) {
    throw new Error(`无法读取图片 ${resolvedPath}：${error.message}`);
  }
  if (buffer.length === 0) throw new Error('图片文件为空');
  if (buffer.length > DEFAULTS.maxImageBytes) throw new Error(`图片过大：${buffer.length} 字节（上限 ${DEFAULTS.maxImageBytes}）`);
  return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, bytes: buffer.length, path: resolvedPath };
}

export function buildVisionRequest(config, question, dataUrl) {
  return {
    model: config.model,
    max_output_tokens: config.maxOutputTokens,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: question || '请详细描述这张图片的内容。' },
          { type: 'input_image', image_url: dataUrl },
        ],
      },
    ],
  };
}

export function parseVisionResponse(json) {
  const parts = (json?.output ?? [])
    .filter((item) => item && (item.type === 'output_text' || item.type === 'message' || item.type === 'reasoning'))
    .map((item) => {
      if (item.type === 'output_text') return item.text ?? '';
      if (item.type === 'message') {
        if (item.content?.type === 'output_text') return item.content.text ?? '';
        if (Array.isArray(item.content)) {
          return item.content
            .filter((block) => block && (block.type === 'output_text' || block.type === 'text'))
            .map((block) => block.text ?? '')
            .join('\n');
        }
        return '';
      }
      if (item.type === 'reasoning' && Array.isArray(item.summary)) {
        return item.summary
          .filter((part) => part && part.type === 'summary_text')
          .map((part) => part.text ?? '')
          .join('\n');
      }
      return '';
    })
    .filter((text) => text.trim());
  return parts.join('\n').trim();
}

/** Full pipeline: image + question → text description. */
export async function describeImage({ imagePath, question, cwd, config = {} }) {
  const cfg = resolveConfig(config);
  if (!cfg.apiBase) {
    throw new Error(
      '视觉接口未配置：请在 ~/.dsh/profiles/web/vision-bridge-config.json 中设置 apiBase（接口地址，如 https://api.openai.com/v1）与 apiKeyEnv 或 apiKey（密钥）。',
    );
  }
  if (!cfg.model) {
    throw new Error('视觉接口未配置模型名：请在 ~/.dsh/profiles/web/vision-bridge-config.json 中设置 model（如 gpt-5.1 / grok-4-fast）。');
  }
  const { dataUrl, bytes } = await resolveImageDataUrl(imagePath, cwd);
  const apiKey = resolveApiKey(cfg);
  const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let response;
  try {
    response = await fetch(`${cfg.apiBase.replace(/\/+$/, '')}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildVisionRequest(cfg, question, dataUrl)),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new Error(`视觉接口请求失败（${cfg.apiBase}）：${error.name === 'AbortError' ? '超时' : error.message}`);
  }
  clearTimeout(timer);
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message ?? parsed?.error ?? text;
    } catch {
      /* keep raw body */
    }
    throw new Error(`视觉模型返回错误：HTTP ${response.status} — ${String(detail).slice(0, 500)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('视觉接口返回了无法解析的响应');
  }
  const description = parseVisionResponse(json);
  if (!description) throw new Error('视觉模型没有返回任何文字描述');
  return { description, model: cfg.model, bytes };
}

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);

  const viewImageTool = defineTool({
    name: 'view_image',
    description:
      '用具备视觉能力的模型查看并描述一张图片。当前主模型不能直接看图片，因此只要任务涉及看图——用户发来图片、要求"看这张图/图片里有什么/这是什么图"、分析截图/图表/照片/界面设计等——就必须调用本工具。输入 image_path（本地图片绝对路径或 http(s) URL；相对路径按工作目录解析）和可选的 question（关注点或具体问题）；返回图片的详细文字描述。图片内容会发送给所配置的视觉模型接口。',
    parameters: {
      image_path: {
        type: 'string',
        required: true,
        description: '要查看的图片：本地绝对路径、相对工作目录的路径，或 http(s) URL。',
      },
      question: {
        type: 'string',
        description: '可选的关注点或问题，例如"图中公式写的是什么""这张图的配色是什么"。缺省时详细描述图片内容。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', required: true },
          model: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.description }],
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
      const result = await describeImage({ imagePath: args.image_path, question: args.question, cwd, config: cfg });
      return result;
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: '查看图片',
        kind: 'read',
        rawInput: String(args.image_path ?? ''),
      };
    },
  });

  ctx.tools.register(viewImageTool);
  if (!cfg.apiBase || !cfg.model) {
    ctx.logger?.warn?.('[dsh-view-image] vision endpoint NOT configured — set vision-bridge-config.json (apiBase, model, apiKeyEnv/apiKey)');
  } else {
    ctx.logger?.info?.(`[dsh-view-image] loaded: vision endpoint ${cfg.apiBase} model ${cfg.model}`);
  }

  /* The adapter-level conversion (user messages keep their image blocks; the
   * upstream request gets a text description) lives in the pi-ai adapter,
   * applied by apply-vision-patch.js. Warn at boot when the patch is gone
   * (e.g. after a dsh upgrade): node apply-vision-patch.js re-applies it. */
  try {
    const adapterSource = readFileSync(
      join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'),
      'utf8',
    );
    if (!adapterSource.includes('VISION-BRIDGE-PATCH')) {
      ctx.logger?.warn?.('[dsh-view-image] pi-ai vision patch is MISSING — run: node apply-vision-patch.js');
    }
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-view-image] could not verify pi-ai vision patch: ${String(error)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Self-test (run directly: node dsh-view-image.js)                    */
/* ------------------------------------------------------------------ */

function assert(nameText, actual, expected) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) {
    console.log(`  PASS ${nameText}`);
    return true;
  }
  console.log(`  FAIL ${nameText}`);
  console.log(`    expected: ${expectedJson}`);
  console.log(`    actual:   ${actualJson}`);
  return false;
}

async function runSelfTest() {
  const results = [];
  const check = async (title, fn) => {
    try {
      if (await fn()) results.push({ title, passed: true });
      else results.push({ title, passed: false });
    } catch (error) {
      results.push({ title, passed: false, error: String(error) });
      console.log(`  FAIL ${title} (threw: ${error.message})`);
    }
  };

  console.log('== dsh-view-image self-test ==');

  const NO_CONFIG = { visionBridgeConfigPath: '~/.dsh/__nonexistent-vision-bridge__.json' };

  await check('no config source leaves the endpoint unconfigured', async () =>
    assert('', resolveConfig(NO_CONFIG).apiBase, ''));

  await check('api key resolves from apiKeyEnv environment variable', async () => {
    const old = process.env.__VIEW_TEST_KEY__;
    process.env.__VIEW_TEST_KEY__ = 'test-key-123';
    try {
      const key = resolveApiKey(resolveConfig({ ...NO_CONFIG, apiKeyEnv: '__VIEW_TEST_KEY__' }));
      return assert('', key, 'test-key-123');
    } finally {
      if (old === undefined) delete process.env.__VIEW_TEST_KEY__;
      else process.env.__VIEW_TEST_KEY__ = old;
    }
  });

  await check('api key resolves from config.apiKey', async () => {
    const key = resolveApiKey(resolveConfig({ ...NO_CONFIG, apiKey: 'direct-key-456' }));
    return assert('', key, 'direct-key-456');
  });

  await check('unconfigured endpoint gives a readable setup error', async () => {
    try {
      await describeImage({ imagePath: 'data:image/png;base64,AA==', cwd: 'C:/Temp', config: NO_CONFIG });
      return false;
    } catch (error) {
      return assert('', error.message.includes('视觉接口未配置'), true);
    }
  });

  await check('mime rejects non-image paths', async () => {
    try {
      await resolveImageDataUrl('C:/Windows/System32/drivers/etc/hosts', 'C:/Temp');
      return false;
    } catch (error) {
      return assert('', error.message.includes('不支持的文件类型'), true);
    }
  });

  await check('missing file gives readable error', async () => {
    try {
      await resolveImageDataUrl('C:/no/such/image.png', 'C:/Temp');
      return false;
    } catch (error) {
      return assert('', error.message.includes('无法读取图片'), true);
    }
  });

  await check('vision response parsing extracts output_text', async () =>
    assert(
      '',
      parseVisionResponse({ output: [{ type: 'message', content: { type: 'output_text', text: '红色' } }] }),
      '红色',
    ));

  await check('vision response parsing skips empty blocks', async () =>
    assert('', parseVisionResponse({ output: [] }), ''));

  await check('adapter patch marker is present in pi-ai adapter', async () => {
    const source = readFileSync(
      join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'),
      'utf8',
    );
    return assert('', source.includes('VISION-BRIDGE-PATCH'), true);
  });

  let livePassed = false;
  await check('live vision call (configured endpoint)', async () => {
    const config = resolveConfig({});
    if (!config.apiBase || !config.model) {
      console.log('  vision endpoint not configured — live call skipped');
      return true;
    }
    try {
      const result = await describeImage({
        imagePath:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        question: '用一句话描述这张图片。',
        cwd: 'C:/Temp',
        config,
      });
      livePassed = result.description.length > 0;
      console.log(`  live answer: ${result.description.slice(0, 80)}`);
      return livePassed;
    } catch (error) {
      console.log(`  live call unavailable: ${error.message.slice(0, 120)}`);
      return false;
    }
  });

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);
  console.log(`== ${passed}/${results.length} passed${livePassed ? '' : '（live 调用未执行，不影响本地逻辑）'} ==`);
  if (failed.length > 0) {
    console.log('failures:', failed.map((r) => r.title).join(' | '));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  runSelfTest();
}
