# CHANGELOG · dsh-vision-bridge

## 0.1.2 · 未发布

目录整理为分层结构：

- 插件本体移入 `plugin/`（`dsh-view-image.js` / `apply-vision-patch.js` / `cordis.patch.yml`），配置样例移入 `config/`，根目录只留文档与安装/发布元数据；
- `install.ps1` 插件源目录优先 `plugin/`，兼容 `payload/` 与仓库根等旧布局；
- `package.json` 发布文件清单与 bundle patch 入口（`./plugin/cordis.patch.yml`）同步更新。

## 0.1.1 · 2026-08-14

视觉接口改为**显式配置（网址 + API）**，彻底移除内置中转地址与自动发现：

- 插件与适配器补丁不再内置任何视觉服务商：接口只从 `vision-bridge-config.json`（`apiBase` / `model` / `apiKeyEnv` / `apiKey`）或环境变量读取；
- 未配置时给出清晰的设置错误（工具报错、启动日志告警、补丁侧降级为文字提示），不会静默失败；
- `install.ps1` 把视觉接口配置作为必做步骤：带参数直接写入（`-ApiBase` / `-ApiKeyEnv` / `-ApiKey` / `-VisionModel`），无参数时交互询问，`-NonInteractive` 跳过并提示手工配置；
- 视觉接口完全由 `vision-bridge-config.json`（`apiBase` / `model` / `apiKeyEnv` / `apiKey`）或环境变量提供，仓库不内置、不包含任何服务商地址与凭据；
- 补丁升级 v4（`EXPLICIT` marker，幂等三态）；自测 10/10（含未配置报错、环境变量/直读 key、live 调用）。

## 0.1.0 · 2026-08-14

首个归档版本。功能与验证历史：

- **view_image 工具**：视觉桥接，支持本地路径 / http(s) URL / data URL。
- **会话图片直通**：settings `modelOverrides` 声明主模型 `input: [text, image]`，让 `session.prompt` 准入放行图片。
- **适配器层转换**：`apply-vision-patch.js` 对 `dsh-llm-pi-ai` 的 `userContent` image 分支打补丁，图片在模型请求组装层转文字，用户消息保留图片。
- **v2 重试**：视觉调用偶发空返回 → 最多 3 次自动重试 + 宽容解析（output_text / message / reasoning 结构）。
- **v3 参数化**（0.1.1 已重做为显式配置）：曾引入 `vision-bridge-config.json`，但默认仍兜底内置中转。
- 验证：插件自测 8/8；真实会话多次发图端到端通过；用户确认消息框显示图片、模型侧读取正常。
