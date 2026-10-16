# opencode2dsh

在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 里原生使用
[OpenCode Zen](https://opencode.ai/zen) 的**匿名免费模型**。

无需 API Key，无需注册，无子进程，**零运行时依赖**。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)

---

## 这是什么

OpenCode 的 CLI 无需登录即可访问一批 Zen 免费模型。本插件把这条匿名通道接成 DSH 的
原生 `LlmAdapter`：装好后，`opencode2dsh` 会作为一个普通 provider 出现在模型选择器里，
和内置 provider 一样直接选用。

## 特性

- **零凭据**：匿名通道的凭据是字面量 `public`，不需要任何个人密钥
- **零依赖**：只用 `node:` 内置模块，没有 `dependencies`，安装时不会触发依赖构建脚本
- **只暴露能用的模型**：拉取上游模型列表后逐个真实探测，把地区受限、协议不支持的模型挡在选择器外
- **原生 adapter**：不拉起 sidecar、不占本地端口、不注册子进程
- **自动刷新**：目录定时刷新，失败后短周期重试，结果落盘作为离线兜底
- **可解释的失败**：限流、地区封锁、鉴权拒绝、超时分别映射成 DSH 的稳定失败码，重试交给 DSH 的 `llm-retry`

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

## 配置

默认配置开箱即用。需要覆盖时，在 profile 的 `cordis.patch.yml` 里改这一行：

```yaml
- id: opencode2dsh
  name: opencode2dsh
  config:
    refreshSeconds: 900
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `providerId` | `opencode2dsh` | provider 路由名，也是模型选择器里的分组名 |
| `refreshSeconds` | `900` | 模型目录刷新周期（秒） |
| `startDelayMs` | `3000` | 首轮探测的延后，避免与启动期请求抢连接 |
| `requestTimeoutMs` | `300000` | 单次请求总超时（毫秒） |
| `exposeAll` | `false` | `true` 时跳过可用性探测，直接暴露全部免费候选 |
| `modelOverrides` | `{}` | 按模型 id 覆盖展示名与容量，见下 |

```yaml
- id: opencode2dsh
  name: opencode2dsh
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
POST https://opencode.ai/zen/v1/chat/completions
   Authorization: Bearer public
   user-agent: opencode/<版本> (<平台> <架构>; node<版本>)
   x-opencode-client / -session / -request / -project
```

### 免费通道的三道门

上游按客户端形状放行匿名通道，三者缺一即 `403 FreeTierError`：

1. `user-agent` 必须是 `opencode/<版本> (...)` 的形状，**追加任何后缀都会被拒**；
2. 会话头必须是 canonical 形状：`ses_` + 12 位小写 hex + 14 位 Base62。
   那 12 位 hex 不是随机串，而是把真实毫秒时钟加每毫秒序号后整体按位取反，
   上游会解回时间戳并校验低 12 位序号；
3. 请求体必须 `stream: true`，且 `tools` 数组里出现 `bash` 与 `read`。

插件的处理：

- 会话 id 由会话首条用户消息派生，同一对话复用同一个 id，便于复用上游 prompt cache；
- 真实工具声明原样透传；缺 `bash` / `read` 时补占位定义；
- 完全没有工具（会话标题、上下文压缩这类内部调用）时只发两个占位，
  并带 `tool_choice: "none"`，模型不会真的去调用它们。

### 模型目录

`listModels` 只返回**探测通过**的模型：

1. `GET /v1/models` 拉取上游在售列表；
2. 过滤免费候选（`-free` 后缀，或已知的免费别名）；
3. 逐个发一次最小流式请求探测；`200` 与 `429`（被限流但已放行）算通过，
   地区封锁与协议不支持排除；
4. 通过的模型写入 `$DSH_HOME/opencode2dsh/catalog.json`，供下次启动直接使用。

刷新失败不会清空现有列表：插件保留上一次的结果并记录原因，然后按短周期重试。

## 常见问题

**只有两三个模型**

首轮探测尚未完成，或当前出口 IP 被上游按地区限制。看
`$DSH_HOME/opencode2dsh/catalog.json` 里的 `lastError`。等待一次刷新周期即可补齐。

**对话中报限流**

匿名通道按 IP 共享配额，`429` 很常见。插件已把 provider 重试策略放宽到 8 次、1s→20s 退避，
并把 `RATE_LIMIT` 交给 DSH 的 `llm-retry`。仍被打满时，换一个竞争较小的模型再试。

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
lib/protocol.js   请求伪装：会话 id、请求头、工具闸门
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
