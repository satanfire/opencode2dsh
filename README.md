# opencode2dsh

在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 里原生使用
[OpenCode Zen](https://opencode.ai/zen) 的**匿名免费模型**。

无需 API Key，无需注册，**零 npm 依赖**。HTTP 传输交给本机的 Bun（OpenCode 本体用的运行时），
因为上游免费通道只放行 Bun 的传输指纹。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)

---

## 这是什么

OpenCode 的 CLI 无需登录即可访问一批 Zen 免费模型。本插件把这条匿名通道接成 DSH 的
原生 `LlmAdapter`：装好后，`opencode2dsh` 会作为一个普通 provider 出现在模型选择器里，
和内置 provider 一样直接选用。

## 特性

- **零凭据**：匿名通道的凭据是字面量 `public`，不需要任何个人密钥
- **零 npm 依赖**：只用 `node:` 内置模块，安装时不会触发依赖构建脚本
- **形状对齐源码**：请求头、`<env>` 上下文块、工具表都对齐 OpenCode 客户端源码
  （`session/model-request.ts`、`instructions/builtins.ts`）
- **Bun 传输**：HTTP 交给 `bun` 子进程（每次约 20ms），Node 只解析流；没有 Bun 时退回
  `fetch` 并给出明确告警
- **只暴露能用的模型**：拉取上游模型列表后逐个真实探测，把门禁拒绝、地区受限、协议不支持的
  模型挡在选择器外
- **自动刷新**：目录定时刷新，失败后短周期重试，结果落盘作为离线兜底
- **可解释的失败**：门禁拒绝、限流、地区封锁、超时分别映射成 DSH 的稳定失败码

## 安装

从 GitHub 安装：

```sh
dsh plugin --profile web add github:satanfire/opencode2dsh
```

从本地目录安装：

```sh
git clone https://github.com/satanfire/opencode2dsh.git
dsh plugin --profile web add ./opencode2dsh
```

装好后重启 `dsh web`，在模型选择器的 **OpenCode Zen 免费** 分组里选模型即可。
不需要修改默认模型配置。

> **包名与 provider 名不是一回事。**
> 包名是 `@satanfire/opencode2dsh`，装到 `node_modules/@satanfire/opencode2dsh`；
> provider 名是 `opencode2dsh`，也就是模型选择器里的分组，以及请求里的 `provider` 字段。
> 两者都可以用配置里的 `providerId` 单独调整（包名除外）。

## 配置

默认配置开箱即用。需要覆盖时，在 profile 的 `cordis.patch.yml` 里改这一行：

```yaml
- id: opencode2dsh
  name: '@satanfire/opencode2dsh'
  config:
    refreshSeconds: 900
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `providerId` | `opencode2dsh` | provider 路由名，也是模型选择器里的分组名 |
| `refreshSeconds` | `1800` | 模型目录刷新周期（秒） |
| `startDelayMs` | `3000` | 首轮探测的延后，避免与启动期请求抢连接 |
| `requestTimeoutMs` | `300000` | 单次请求总超时（毫秒） |
| `exposeAll` | `false` | `true` 时跳过可用性探测，直接暴露全部免费候选 |
| `modelOverrides` | `{}` | 按模型 id 覆盖展示名与容量，见下 |
| `transport` | `auto` | `auto` / `bun` / `fetch`。`auto` 有 Bun 就用 Bun |
| `bunPath` | `bun` | Bun 可执行文件路径 |
| `baseUrl` | `https://opencode.ai/inference/openai/v1` | 推理入口 |
| `clientVersion` | `2.0.29` | user-agent 里的客户端版本 |
| `channel` | `latest` | user-agent 里的渠道段 |
| `workspaceDirectory` | 插件进程 cwd | `<env>` 块里的 `Working directory` |
| `workspaceRoot` | 同 `workspaceDirectory` | `<env>` 块里的项目根 |
| `tmpDirectory` | `$TMPDIR` | `<env>` 块里的首选临时目录 |

```yaml
- id: opencode2dsh
  name: '@satanfire/opencode2dsh'
  config:
    modelOverrides:
      big-pickle:
        name: Big Pickle
        contextWindow: 262144
        maxTokens: 32768
```

上游不公布免费模型的上下文窗口，插件默认按保守值申报（上下文 131072、输出上限 16384）。
知道确切值时用 `modelOverrides` 覆盖，避免 DSH 过早压缩或请求超出模型容量。

## 工作原理

```
DSH 会话
  │  StreamChunk（block-start / text-delta / reasoning-delta / tool-call-delta / usage / finish）
  ▼
ZenAdapter（本插件注册的 LlmAdapter）
  │  OpenAI chat/completions 流式协议
  ▼
bun 子进程（HTTP/2 + BoringSSL 指纹，与 OpenCode 本体一致）
  ▼
POST https://opencode.ai/inference/openai/v1/chat/completions
   Authorization: Bearer public
   user-agent: opencode/latest/2.0.29/cli
   b3 / traceparent
   x-opencode-client / -session / -session-id / -project
```

### 免费门禁：2026-10 实测的四条

上游不公开规则，下面四条来自对本机 OpenCode 2.0.29 真实请求的抓包与 A/B 复核：

1. **会话头成对出现**：`x-opencode-session` 与 `x-opencode-session-id` 必须都在，
   值是 canonical `ses_` id（`ses_` + 12 位小写 hex + 14 位 Base62；12 位 hex 是
   毫秒时钟加每毫秒序号后整体按位取反）。少一个就 `429`。
2. **系统提示词要带 `<env>` 块**：块内必须有 `  Working directory: <路径>` 一行。
   空块、只放 Platform、块内随便写两行都会被拒。
3. **`tools` 数组不能为空**。会话标题、上下文压缩这类没有工具的调用，用两个占位
   工具补齐即可。
4. **传输必须是 Bun 的指纹**：同一份请求字节，Bun 发 `200`，Node `fetch` / Node `http2` /
   `curl` 全部 `429`。所以 HTTP 这一步交给 `bun` 子进程。

不满足这些形状时，上游回的是 `429 FreeUsageLimitError`，文案是
"Free usage limit reached. Free models work in OpenCode..."——
这不是额度用尽，而是"看起来不是 OpenCode 客户端"。

插件的处理：

- 会话 id 由会话首条用户消息派生，同一对话复用同一个 id，便于复用上游 prompt cache；
- 系统提示词末尾追加 OpenCode 同形的 `<env>` 块（只是环境信息，不改人设）；
- 真实工具声明原样透传；缺 `bash` / `read` 时补占位定义；
- 完全没有工具时只发两个占位，并带 `tool_choice: "none"`，模型不会真的去调用它们。

### 模型目录

`listModels` 只返回**探测通过**的模型：

1. `GET /v1/models` 拉取上游在售列表；
2. 过滤免费候选（`-free` 后缀，或已知的免费别名）；
3. 逐个发一次最小流式请求探测；只有 `200` 算通过。`429 FreeUsageLimitError` 是门禁拒绝，
   地区封锁与协议不支持也排除；
4. 通过的模型写入 `$DSH_HOME/opencode2dsh/catalog.json`，供下次启动直接使用。

只有**确定性拒绝**（地区封锁、协议不支持）才会把模型从列表里摘掉。
探测撞上网络错误、两次都拿不到结论时，上一轮已知可用的模型会被保留——
网络抖动不该让正在使用的模型从选择器里消失。从未成功过的候选不给这个豁免。

刷新失败不会清空现有列表：插件保留上一次的结果并记录原因，然后按短周期重试。

## 常见问题

**只有两三个模型**

首轮探测尚未完成，或当前出口 IP 被上游按地区限制。看
`$DSH_HOME/opencode2dsh/catalog.json` 里的 `lastError`。等待一次刷新周期即可补齐。

**对话中报"客户端形状未通过门禁"**

上游判定请求不像 OpenCode 本体。检查：本机是否装了 `bun`（`bun --version`）、
插件日志里的传输类型是不是 `bun`；`catalog.json` 的 `lastError` 是否为空。
如果 Bun 在但依旧被拒，说明上游门禁又变了——这时以上游真实客户端的抓包为准更新
`lib/protocol.js`。

**没有 Bun 会怎样**

插件会退回 Node `fetch` 并打一条 warn。请求形状仍然正确，但传输指纹过不了门禁，
真实调用会以 `MODEL_UNAVAILABLE` 失败。装一个 Bun 即可。

**某个模型报"当前网络地区不可用"**

Zen 不向该地区提供这个模型。这是上游限制，换用当前地区可用的模型即可。

**装好后模型列表里没有这个 provider**

重启 `dsh web`。DSH 的插件加载器按模块名缓存已导入的模块，替换已安装的包必须重启
才会加载新的 JS 代际。

**和参考实现能一起装吗**

不能。本插件与 `@opencode2dsh/dsh-plugin` 都注册 `opencode2dsh` 这个 provider 名，
同时启用会因为路由重名而注册失败。

## 开发

```sh
npm test          # 离线单元测试，不联网
npm run test:live # 联网集成测试：目录探测 + 文本流 + 工具调用
```

目录结构：

```
lib/protocol.js   请求伪装：会话 id、请求头、trace 头、<env> 块、工具闸门
lib/transport.js  传输层：Bun 子进程 / Node fetch 兜底
lib/bun-fetch.js  Bun 侧转发器：stdin 收请求，stdout 吐响应
lib/models.js     模型元数据：展示名、容量、免费候选判定
lib/messages.js   DSH 消息 → OpenAI 消息
lib/errors.js     上游失败 → DSH 失败码
lib/catalog.js    免费模型目录：发现、探测、落盘、刷新
lib/stream.js     SSE 解析 + 流式块翻译
lib/adapter.js    LlmAdapter 实现
lib/index.js      插件入口
```

改动后必须重启 `dsh web` 才会加载新代码。

## 致谢

这条通道能走通，靠的是前人的逆向与验证：

- [**opencode2dsh**](https://github.com/FishBottle7/opencode2dsh)，作者
  [@FishBottle7](https://github.com/FishBottle7)——公开了匿名通道的请求伪装细节，
  本插件的 canonical 会话 id 算法与之同源；
- [**opencode2api**](https://github.com/jasonxu114514/opencode2api)，作者
  [@jasonxu114514](https://github.com/jasonxu114514)——匿名通道实现的源头；
- [OpenCode](https://opencode.ai)——运营 Zen 免费通道；
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)——插件运行时。

本插件是独立实现，不使用上述项目的代码；协议事实均以对上游的真实请求复核为准。

## 许可

[MIT](./LICENSE)
