# dsh-vision-bridge · DSH 视觉桥接

> **DSH 插件**：本仓库已打上 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 标签，可在 DeepSeek Harness 官方插件发现页被检索到。

让 **DeepSeek Harness（DSH）** 里没有视觉能力的主模型（如 deepseek-v4-pro）能够"看图"：

1. **会话直接收图**：用户在会话里发送图片不再被"模型不支持图片"拦截；
2. **消息保留图片**：用户消息框显示图片缩略图，转换不在用户消息上发生；
3. **内部自动转文字**：图片在模型请求组装层被自动交给视觉模型转成文字描述，主模型只收到文字；
4. **自觉看图工具**：`view_image` 工具供模型在需要看图时自行调用（支持本地路径 / URL / data URL）。

## 项目结构

```
dsh-vision-bridge/
├── plugin/                        # DSH 插件本体（npm bundle patch 入口）
│   ├── dsh-view-image.js          #   view_image 工具：图片 → 视觉模型 → 文字描述
│   ├── apply-vision-patch.js      #   pi-ai 适配器补丁（幂等，可重复运行）
│   └── cordis.patch.yml           #   bundle patch 声明（name 相对本目录解析）
├── config/
│   └── vision-bridge-config.example.json   # 视觉接口配置样例（复制为 vision-bridge-config.json 使用）
├── install.ps1                    # 一键安装脚本（复制/登记/声明/配置/补丁/自测）
├── package.json                   # npm 发布元数据（files 白名单 + bundle patch 入口）
├── README.md / CHANGELOG.md / LICENSE / VERSION.txt / .gitignore
```

## 快速开始（30 秒）

没装过 DeepSeek Harness？先看官方快速开始：<https://deepseek-harness.github.io/deepseek-harness/guide/quickstart>

1. **准备一个视觉接口（网址 + 密钥）**，例如 OpenAI 官方：网址 `https://api.openai.com/v1`、模型 `gpt-5.1`、密钥环境变量 `OPENAI_API_KEY`（先 `setx OPENAI_API_KEY "<your-api-key>"`）；
2. **运行安装脚本**，带上接口参数：

   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1 -ApiBase https://api.openai.com/v1 -ApiKeyEnv OPENAI_API_KEY -VisionModel gpt-5.1
   ```

   没有参数也可以直接运行，脚本会逐步询问网址 / 模型名 / 密钥。
3. **重启 `dsh web`**，在任意会话里发一张图片——消息框显示图片、模型能读出内容，即安装成功。

详细配置说明见下文"配置视觉接口（必做）"。

## 前置条件

- DeepSeek Harness 已安装且 `dsh web` 启动过至少一次（`~/.dsh/profiles/web/` 存在）；
- 主模型走 `dsh-llm-pi-ai` 适配器（settings.yaml 里 `llm-pi-ai.providers.<provider>` 已配置），**或** 你愿意手工在 settings 里声明图片输入；
- **一个视觉接口（网址 + API 密钥）**——本插件不内置任何服务商，必须显式配置，例如：
  - OpenAI 官方：`https://api.openai.com/v1` + `OPENAI_API_KEY`；
  - xAI Grok：`https://api.x.ai/v1` + `XAI_API_KEY`；
  - 任何 OpenAI 兼容 Responses API（本地网关、中转等）。

## 一键安装（推荐）

**视觉接口是必做步骤**：带参数直接写配置，不带参数会交互询问。

```powershell
# OpenAI 官方（推荐方式：密钥走环境变量）
powershell -ExecutionPolicy Bypass -File install.ps1 -ApiBase https://api.openai.com/v1 -ApiKeyEnv OPENAI_API_KEY -VisionModel gpt-5.1

# xAI Grok
powershell -ExecutionPolicy Bypass -File install.ps1 -ApiBase https://api.x.ai/v1 -ApiKeyEnv XAI_API_KEY -VisionModel grok-4-fast

# 交互式：脚本逐步询问网址 / 模型名 / 密钥
powershell -ExecutionPolicy Bypass -File install.ps1
```

安装脚本依次完成：复制插件文件 → 在 profile 的 `cordis.patch.yml` 登记插件行 → 在 `settings.yaml` 给主模型声明图片输入 → **写视觉接口配置**（参数或交互）→ 打 pi-ai 适配器补丁 → 自测。

**参数**：

| 参数 | 默认 | 说明 |
|---|---|---|
| `-ApiBase` | 无（必填） | 视觉接口地址，如 `https://api.openai.com/v1` |
| `-ApiKeyEnv` | 无 | 密钥环境变量名（优先）；与 `-ApiKey` 二选一 |
| `-ApiKey` | 无 | 直接写密钥（仅存本机配置文件，不会被提交） |
| `-VisionModel` | 无（必填） | 视觉模型名，如 `gpt-5.1` / `grok-4-fast` |
| `-Provider` | `opencode-go` | settings 里 `llm-pi-ai.providers` 下的主模型路由名 |
| `-Model` | `deepseek-v4-pro` | 主模型 id（给它声明 `input: [text, image]`） |
| `-SkipSettings` | 关 | 跳过 settings 的模型声明（自己手工改） |
| `-NonInteractive` | 关 | 无人值守：跳过交互询问（之后手工写配置文件） |

安装后 **重启 dsh web**，然后在任意会话里发一张图片验证。

## 手动安装（想自己控制每一步时）

1. 复制 `plugin/dsh-view-image.js`、`plugin/apply-vision-patch.js` 到 `~/.dsh/profiles/web/`；
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: dsh-view-image
         name: './dsh-view-image.js'
   ```

3. 在 `~/.dsh/settings.yaml` 给主模型声明图片输入：

   ```yaml
   llm-pi-ai:
     providers:
       opencode-go:
         apiKeyEnv: OPENCODE_GO_API_KEY
         modelOverrides:
           deepseek-v4-pro:
             input:
               - text
               - image
   ```

4. **写视觉接口配置** `~/.dsh/profiles/web/vision-bridge-config.json`（样例见 `config/vision-bridge-config.example.json`）：

   ```json
   {
     "apiBase": "https://api.openai.com/v1",
     "model": "gpt-5.1",
     "apiKeyEnv": "OPENAI_API_KEY",
     "apiKey": ""
   }
   ```

   `apiKeyEnv`（环境变量名，优先）与 `apiKey`（直读 key）二选一；两者都留空时表示匿名端点。未配置时工具会明确报错，不会静默失败。

5. 运行 `node apply-vision-patch.js`（对 pi-ai 适配器打补丁）；
6. 运行 `node dsh-view-image.js` 自测；
7. 重启 dsh web。

## 视觉接口配置优先级

`cordis.patch.yml` 的插件 config ＞ `vision-bridge-config.json` ＞ 环境变量（密钥）。**没有内置默认服务商**。

## 维护 / 升级

- **每次 `dsh` 升级或重装后**，适配器补丁会丢失：进入 `~/.dsh/profiles/web/` 重新运行 `node apply-vision-patch.js` 即可（脚本幂等，多版本自动识别）；
- 插件每次启动都会检查补丁是否在位，缺失时在日志告警（`[dsh-view-image] pi-ai vision patch is MISSING`）；
- settings 的模型声明热生效；插件文件与补丁改动需重启 dsh web。

## 回滚

- 停用插件：删除 `cordis.patch.yml` 里的 `dsh-view-image` 块；
- 恢复适配器：删除补丁后重新安装 `dsh` 即还原（或手工把 `case "image"` 分支改回原始图片输出）；
- 恢复 settings：删除 `modelOverrides` 下对应模型的 `input` 声明。

## 安全说明

- 视觉接口密钥只存本机 `vision-bridge-config.json`（该文件已被 `.gitignore` 排除）或环境变量；
- 插件无日志、无缓存、无运行数据写盘。
