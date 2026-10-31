# Changelog

## 1.1.0 — 2026-10-31

对齐 OpenCode 客户端源码重做请求形状，并修复"免费模型永远被限流"的根因。

### 修复

- **传输层换成 Bun**：上游免费通道按传输指纹放行。同一份请求字节，Bun 发 `200`，
  Node `fetch` / Node `http2` / `curl` 全部 `429 FreeUsageLimitError`。新增
  `lib/transport.js` + `lib/bun-fetch.js`，HTTP 交给 `bun` 子进程（每次约 20ms），
  Node 侧只解析流。没有 Bun 时退回 `fetch` 并告警。
- **补齐会话头**：`x-opencode-session-id` 之前缺失，与 `x-opencode-session` 成对出现才能过门禁。
- **系统提示词追加 `<env>` 块**：按 `packages/core/src/instructions/builtins.ts` 的格式，
  带上 `Working directory` / 项目根 / git 仓库 / 平台 / 临时目录。门禁要求这块存在。
- **探测不再把 429 当可用**：`probeModel()` 之前把 `429` 视为"限流但放行"，
  导致门禁拒绝时选择器里仍挂着必然失败的模型。现在只有 `200` 算通过。
- **429 FreeUsageLimitError 映射成确定性失败**：`MODEL_UNAVAILABLE`，不进重试队列。

### 变更

- 推理入口改为 OpenCode 客户端实际使用的
  `https://opencode.ai/inference/openai/v1/chat/completions`（原为 `/zen/v1`）。
- user-agent 改为 `opencode/<channel>/<version>/cli`（原为 `opencode/<version> (<平台> <架构>)`）。
- 新增 `b3` / `traceparent` 头，与 OpenCode 的 HTTP 层一致。
- 输出上限字段改为 `max_completion_tokens`（原 `max_tokens`）。
- 项目 id 改为 40 位十六进制（原 `prj_<24hex>`）。
- 目录刷新周期默认 `1800` 秒（原 `900`），减少探测带来的无效请求。
- 新增配置项：`transport`、`bunPath`、`baseUrl`、`clientVersion`、`channel`、
  `workspaceDirectory`、`workspaceRoot`、`tmpDirectory`。

### 测试

- 离线：32 项通过（新增 env 块、trace 头、项目 id、`withEnvironment`、门禁失败码等用例）。
- 联网：`npm run test:live` 全绿——目录 7 个可用、文本流返回 `pong`、工具调用成功。
