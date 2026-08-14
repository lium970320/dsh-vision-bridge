/**
 * apply-vision-patch.js — patch the pi-ai adapter's request assembly so image
 * blocks never reach the text-only upstream model.
 *
 * User-visible messages keep their image blocks (the UI renders the picture);
 * when the adapter assembles the upstream request, the image branch is routed
 * through a vision-capable model and replaced with a text description.
 *
 * Vision endpoint is configured EXPLICITLY via
 * `~/.dsh/profiles/web/vision-bridge-config.json`:
 *   { "apiBase": "https://api.openai.com/v1", "model": "gpt-5.1",
 *     "apiKeyEnv": "OPENAI_API_KEY" }   // or "apiKey": "<key>" directly
 * There is no built-in provider; when nothing is configured the image is
 * replaced with a readable setup-error text.
 *
 * Re-run this script after any `dsh` upgrade/reinstall that refreshes
 * profiles/node_modules: node apply-vision-patch.js
 *
 * States: no marker → full patch; v1-v3 helper → upgrade helper in place;
 * v4 helper (EXPLICIT marker) → no-op.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js');
const MARKER = 'VISION-BRIDGE-PATCH';
const HELPER_MARK = 'VISION-BRIDGE-PATCH helper';
const EXPLICIT_MARK = 'VISION-BRIDGE-PATCH explicit';

const OLD_CASE = `\t\tcase "image": {
\t\t\tconst stored = await attachments.readImage(block.attachment);
\t\t\tcontent.push({
\t\t\t\ttype: "image",
\t\t\t\tdata: Buffer.from(stored.data).toString("base64"),
\t\t\t\tmimeType: stored.ref.mediaType
\t\t\t});
\t\t\tbreak;
\t\t}`;

const NEW_CASE = `\t\tcase "image": {
\t\t\t/* ${MARKER}: route image blocks through a vision-capable model and hand
\t\t\t * the text-only model a description instead of raw pixels. */
\t\t\tconst stored = await attachments.readImage(block.attachment);
\t\t\tlet description;
\t\t\ttry {
\t\t\t\tdescription = await visionBridgeDescribe(stored.data, stored.ref.mediaType);
\t\t\t} catch (error) {
\t\t\t\tdescription = \`（图片视觉转换失败：\${String(error?.message ?? error).slice(0, 300)}）\`;
\t\t\t}
\t\t\tcontent.push({
\t\t\t\ttype: "text",
\t\t\t\ttext: \`[用户发来一张图片（\${stored.ref.mediaType}），已由视觉模型查看，内容如下]\\n\${description}\`
\t\t\t});
\t\t\tbreak;
\t\t}`;

const HELPER = `
/* ${HELPER_MARK}: describe image bytes via a vision-capable model. */
async function visionBridgeDescribe(data, mediaType) {
\tconst { readFileSync: patchReadFileSync } = await import("node:fs");
\tconst { homedir: patchHomedir } = await import("node:os");
\tconst { join: patchJoin } = await import("node:path");
\t/* ${EXPLICIT_MARK}: the endpoint comes ONLY from vision-bridge-config.json
\t * (apiBase/model/apiKeyEnv/apiKey) or environment variables. */
\tlet cfg = {};
\ttry {
\t\tcfg = JSON.parse(patchReadFileSync(patchJoin(patchHomedir(), ".dsh", "profiles", "web", "vision-bridge-config.json"), "utf8")) ?? {};
\t} catch {}
\tconst apiBase = (cfg.apiBase ?? "").replace(/\\/+$/, "");
\tconst model = cfg.model ?? "";
\tif (!apiBase || !model) throw new Error("vision endpoint not configured: set vision-bridge-config.json (apiBase, model, apiKeyEnv/apiKey)");
\tconst apiKey = process.env[cfg.apiKeyEnv ?? "VIEW_IMAGE_API_KEY"] || cfg.apiKey || "";
\t/* ${MARKER} retry: up to 3 attempts; empty descriptions retry after a short wait. */
\tlet lastError;
\tfor (let attempt = 1; attempt <= 3; attempt++) {
\t\tconst controller = new AbortController();
\t\tconst timer = setTimeout(() => controller.abort(), 180000);
\t\ttry {
\t\t\tconst response = await fetch(\`\${apiBase}/responses\`, {
\t\t\t\tmethod: "POST",
\t\t\t\theaders: { "content-type": "application/json", ...(apiKey ? { authorization: \`Bearer \${apiKey}\` } : {}) },
\t\t\t\tbody: JSON.stringify({
\t\t\t\t\tmodel,
\t\t\t\t\tmax_output_tokens: 2000,
\t\t\t\t\tinput: [{ role: "user", content: [
\t\t\t\t\t\t{ type: "input_text", text: "请详细描述这张图片的内容，包括其中的文字、数字、图表和视觉元素。" },
\t\t\t\t\t\t{ type: "input_image", image_url: \`data:\${mediaType};base64,\${Buffer.from(data).toString("base64")}\` }
\t\t\t\t\t] }]
\t\t\t\t}),
\t\t\t\tsignal: controller.signal
\t\t\t});
\t\t\tif (!response.ok) throw new Error(\`vision endpoint HTTP \${response.status}\`);
\t\t\tconst json = await response.json();
\t\t\tconst parts = [];
\t\t\tfor (const item of json?.output ?? []) {
\t\t\t\tif (item?.type === "output_text" && item.text) parts.push(item.text);
\t\t\t\telse if (item?.type === "message") {
\t\t\t\t\tif (item.content?.type === "output_text" && item.content.text) parts.push(item.content.text);
\t\t\t\t\telse if (Array.isArray(item.content)) for (const block of item.content) {
\t\t\t\t\t\tif ((block?.type === "output_text" || block?.type === "text") && block.text) parts.push(block.text);
\t\t\t\t\t}
\t\t\t\t} else if (item?.type === "reasoning" && Array.isArray(item.summary)) {
\t\t\t\t\tfor (const part of item.summary) if (part?.type === "summary_text" && part.text) parts.push(part.text);
\t\t\t\t}
\t\t\t}
\t\t\tconst description = parts.join("\\n").trim();
\t\t\tif (!description) throw new Error("vision model returned no description");
\t\t\treturn description;
\t\t} catch (error) {
\t\t\tlastError = error;
\t\t\tif (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500));
\t\t} finally {
\t\t\tclearTimeout(timer);
\t\t}
\t}
\tthrow lastError ?? new Error("vision model returned no description");
}
`;

let source = readFileSync(target, 'utf8');

if (source.includes(EXPLICIT_MARK)) {
  console.log('patch already at v4 (explicit-config helper), no-op');
  process.exit(0);
}

if (source.includes(HELPER_MARK)) {
  // v1-v3 → v4: swap the helper in place (between its marker comment and userContent).
  const start = source.indexOf(`/* ${HELPER_MARK}`);
  const end = source.indexOf('async function userContent(blocks, attachments) {');
  if (start < 0 || end < 0 || start > end) {
    console.error('ERROR: helper boundaries not found — adapter source may have changed. No changes written.');
    process.exit(1);
  }
  source = source.slice(0, start) + HELPER + '\n' + source.slice(end);
  writeFileSync(target, source, 'utf8');
  console.log('upgraded helper to v4 (explicit config):', target);
  process.exit(0);
}

if (!source.includes(OLD_CASE)) {
  console.error('ERROR: target case block not found — adapter source may have changed. No changes written.');
  process.exit(1);
}

source = source.replace(OLD_CASE, NEW_CASE);
const anchor = 'async function userContent(blocks, attachments) {';
const idx = source.indexOf(anchor);
if (idx < 0) {
  console.error('ERROR: helper anchor not found — adapter source may have changed. No changes written.');
  process.exit(1);
}
source = source.slice(0, idx) + HELPER + source.slice(idx);
writeFileSync(target, source, 'utf8');
console.log('patched (v4):', target);
