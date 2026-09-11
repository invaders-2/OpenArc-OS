# D1-02 Harness Evaluation

日期：2026-09-11
分支：`feature/d1-02-harness`
目标：回答 **DeepSeek Harness 是否适合作为 OpenArc OS 的 AI 运行框架 / agent adapter**。
不是"能否聊天"，而是 **OpenArc 能不能控制它**。

判定口径：SUPPORTED / PARTIAL / NOT SUPPORTED / UNKNOWN / NOT VERIFIED。不据产品介绍推断。

> **Task Status: PARTIAL**
> **Technology Decision: ACCEPT WITH CONDITIONS**
>
> 二者不可混为一谈。技术决策是"这条技术路线可以走"，不代表 D1-02 任务完成。
> 原因：端到端 `tools/call` → OpenArc approval → tool execution → result 回灌
> **仍未真实验证**。在该链路取得证据前，D1-02 任务状态恒为 PARTIAL。
> **不得把 ACCEPT WITH CONDITIONS 当作任务 COMPLETE。**

---

## Candidate

DeepSeek Harness（`dsh`）—— DeepSeek AI 官方开源 agent harness（智能体运行时 / 外壳）。
"Everything is a Plugin" 架构，底座为 Cordis 插件框架。

## Version

| 工件 | 版本 | 证据 |
| --- | --- | --- |
| `@deepseek-ai/dsh`（CLI，npm latest） | **0.1.5-rc.1** | `npm view` + `dsh --version` 实测输出 `0.1.5-rc.1` |
| 核心子包（sdk-protocol / user-approval / llm-retry 等） | 0.1.5-rc.2 | 安装后 `package.json` |
| ACP `initialize` 自报 | `deepseek-harness-acp@0.0.1` | ACP 响应实测。**仅为 protocol self-reported version / placeholder value** |

> **版本口径（必须遵守）**：ACP `initialize` 返回的 `agentInfo.version = 0.0.1`
> **只能记录为 ACP protocol self-reported version / placeholder value**，
> **不得**当作 DeepSeek Harness ACP 包的真实发布版本。
> 真实版本一律以 **安装包 `package.json` / npm metadata / lockfile** 为准
> （本轮即 CLI `0.1.5-rc.1`、核心子包 `0.1.5-rc.2`）。
| maturity | **developer preview** | README 原文：`THERE WILL BE COMPATIBILITY-BREAKING CHANGES` |

**坑（实测）**：`npm view @deepseek-ai/<子包> version` 返回的 `latest` 标签落后于实际版本
（如 `dsh-sdk-app` 的 latest = `0.1.2-alpha.2`，而 CLI 依赖 `^0.1.5-rc.1`）。
按 latest 安装会解析失败或装到旧版，**必须按精确版本或让 CLI 自己解析依赖**。

## Source

- 官方仓库：`https://github.com/deepseek-ai/deepseek-harness`（默认分支 master）
- npm：`@deepseek-ai/dsh`，`repository.url = git+https://github.com/deepseek-ai/deepseek-harness.git`
- 文档站：`https://deepseek-harness.github.io/deepseek-harness/`
- 本轮一手证据来源：**npm registry 元数据 + 随包发布的 README（每包一份）+ 真实安装后的目录树 + 真实运行的 ACP 探针**。
  未采信任何二手博客结论作为判定依据。

## License

**MIT**。证据：包内 `LICENSE` 文件首行 `MIT License / Copyright (c) 2026 DeepSeek`；`package.json` `"license": "MIT"`。
第三方依赖见 `THIRD_PARTY_NOTICES.md`（未逐项审计）。

## Installation

| 方式 | 命令 | 实测 |
| --- | --- | --- |
| npx（官方推荐） | `npx @deepseek-ai/dsh web` | NOT VERIFIED（本环境未跑） |
| 本地安装 | `npm install @deepseek-ai/dsh` | **PASS**：`added 521 packages in 47s`，`node_modules/.bin/dsh` 可运行 |
| 源码构建 | `git clone` + `pnpm install` + `pnpm run build` + `pnpm dsh web` | NOT VERIFIED（需 Corepack pnpm@11.7.0） |

Web UI 默认 `http://127.0.0.1:3080`（README 原文），`--no-open` 可只起服务。

## Runtime

| 项 | 值 | 状态 |
| --- | --- | --- |
| 语言 | TypeScript（monorepo，241 个 `@deepseek-ai/*` 包随 CLI 落地） | SUPPORTED |
| `engines.node` 声明 | **未声明**（实测 CLI `package.json` 的 `engines` 为 `null`） | UNKNOWN |
| 原生 addon 要求 | `node-addon-system` 系列声明 `>=20` | PARTIAL |
| 本轮运行 Node | v22.22.2（managed）| 实测可用 |
| macOS | arm64 原生 addon 存在，本轮全部实测在 macOS 26 / arm64 上跑通 | SUPPORTED |
| Windows / Linux | 存在 `dsh-sandbox-windows-acl`、`dsh-pwsh-sandbox` 等平台包 | NOT VERIFIED |
| 平台沙箱后端 | `dsh-sandbox` / `dsh-fs-sandbox` / `dsh-bash-sandbox` / `dsh-pwsh-sandbox` / `dsh-sandbox-policy` / `dsh-sandbox-windows-acl` | PARTIAL（包存在，行为未验） |

> 网传"Node 要求 `^22.19.0 || >=24.0.0`"**在本轮未获得证据**——已发布的 CLI 清单里没有 `engines` 字段。记为 UNKNOWN，不写入结论。

## API Surface

五种 profile，实测 `dsh --profile <name>` 可用：`web`、`sdk`、`sdk-minimal`、`headless`、`acp`。

| 接入面 | 形态 | 方法 | 评价 |
| --- | --- | --- | --- |
| **ACP**（Agent Client Protocol） | stdio 换行分隔 JSON-RPC | `initialize`、`session/new`、`session/list`、`session/resume`、`session/prompt`、`session/cancel`、`session/close` | **OpenArc 应走的接入面**——唯一具备取消与会话生命周期控制 |
| SDK JSON-RPC | stdio 换行分隔 JSON-RPC | `initialize`、`session/prompt`、`shutdown` + 4 个通知 | 方法集**没有 cancel**，只能整体 shutdown；不满足 Gate 4 |
| 进程内 Cordis 服务 | `ctx.agents` / `ctx.llm` / `ctx.credentials` / `ctx.sessionPersistence` | — | 能力最全（`agent.cancel()` 在此），但要求 OpenArc 与 Harness 同进程 |
| Python SDK | 打包 CLI 为 sdk-runtime | 镜像 TS 形状 | NOT VERIFIED |

ACP 实测响应（本轮探针真实输出）：

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":1,
  "agentInfo":{"name":"deepseek-harness-acp","version":"0.0.1"},
  "agentCapabilities":{
    "mcpCapabilities":{"http":true},
    "promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},
    "sessionCapabilities":{"close":{},"list":{},"resume":{}}
  },
  "authMethods":[]
}}
```

## Session Model

- 会话由 `sessionId` 驱动：ACP server "creates one agent per `sessionId` on first use"（SDK server 同理）。
- ACP 具备 `list` / `resume` / `close` 三项会话能力（实测在 capabilities 中）。
- **实测行为**：`session/new` 返回的 `sessionId` **不在** `session/list` 结果中（list 返回 0 条）。
  说明 `list` 只反映**已持久化**的会话，不是活动会话枚举。
  → OpenArc 必须自己持有 `user / project / task / session` 映射，**不能依赖 `list`**。
  这与 OpenArc "持久状态唯一权威" 的要求方向一致，不构成阻塞。
- 持久化格式：`dsh-session-persistence-jsonl`（另有 `dsh-session-query-sqlite`、`dsh-session-format-v0→v3` 迁移链）。

## Tool Calling

**工具集由外部组合决定，不是框架内置**——这是本轮最重要的发现之一。

- 官方文档（sdk-jsonrpc-server）：`The profile composition owns each root agent's tools.`
  即：profile 组合决定根 agent 有哪些工具，OpenArc 作为组合方即可决定工具集。
- ACP `session/new` 接受 `mcpServers` 参数（**必填**，缺失直接 `-32602 Invalid params`）。
- **实测**：传入自建的假 MCP 服务器后，Harness 确实连上并执行了
  `initialize` → `notifications/initialized` → `tools/list`（取证日志文件证实）。
  → 工具可见性可被 OpenArc 在会话创建时控制。
- 工具调用经过 guarded tool pipeline；`maxParallelToolCalls` 限制并发，exclusive 调用保序。
- **`tools/call` 未触发**——本轮无可用模型 API Key，模型没有提议工具调用。
  → 端到端"提议→拦截→执行→回灌" **NOT VERIFIED**。

## Cancellation

| 机制 | 位置 | 状态 |
| --- | --- | --- |
| `session/cancel` | ACP | 方法存在；实测空闲调用 no-op 不报错。文档原文：`without an ACP prompt in flight it cancels autonomous work, while unknown session ids are no-ops` |
| `session/close` | ACP | 实测可调用。文档原文：`Quiescent cancellation, update draining, descendant disposal, persistence flush, and disposal of only the addressed Agent scope` |
| `agent.cancel()` | 进程内 | 文档原文：`aborts the current activity and, unless keepInbox is set, clears pending work; a cancelled stream finalizes the text already delivered to the user` |
| 未派发工具调用 | agent-loop | `Undispatched model tool calls after cancellation receive synthetic tool/call plus ABORTED_BEFORE_DISPATCH result pairs` |
| turn budget | — | **无内建**。文档原文：`No built-in turn budget — a policy that bounds runaway turns must cancel from an existing lifecycle extension point such as agent/turn-stopping` |
| SDK JSON-RPC | — | **没有 cancel 方法**，只能 `shutdown` 整个 runtime |

**结论**：Gate 4 在 ACP 接入面上成立；在 SDK 接入面上不成立。

## Retry Semantics

`dsh-llm-retry`（web profile 默认挂载）逐字证据：

- `Mount @deepseek-ai/dsh-llm-retry to retry failed **model requests** at durable agent-step boundaries.`
- 触发条件：`rate limits, server errors, timeouts, transport errors`。
- normal 模式：5 次重试，覆盖 `EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`，退避 500ms→10s + 10% 抖动。
- always 模式：`retries every model-request failure without an attempt limit`，直到成功、取消或插件销毁。
- `Nothing here is model-visible`；`Cancellation or plugin disposal aborts active backoff`。
- 直接 `ctx.llm.stream()` 调用是 single-attempt，不走重试。

**判定**：重试作用域是**模型请求**，不是工具执行——不会重放已产生副作用的工具调用。
且该插件**可以不挂载**（不挂载即无重试），或把 provider 的 `retryPolicy` 配为受控策略。
→ Gate 3 成立，但需以"不挂载 always 模式"为条件。
本轮**未实测**重试行为（无可用 Key），记 NOT VERIFIED。

## Persistence

- `dsh-session-persistence-jsonl`：会话事件流写 JSONL。
- 数据根：`@deepseek-ai/dsh-home-paths` —— `An explicit path wins over $DSH_HOME, which wins over ~/.dsh`。
  → OpenArc 可把 Harness 数据根指到自己管理的目录。
- 会话日志是模型可见上下文的 source of truth（`deriveMessages()` 从中投影）。
- **风险**：这是 Harness 自有的持久状态。OpenArc 必须把它当作**可丢弃的执行痕迹**，
  任务状态仍以 OpenArc 为准；否则会出现第二套任务真相。
- 另有 checkpoint policy、telemetry-otel、session-format 迁移链 v0→v3，说明格式仍在演进。

## Model Configuration

`dsh-credentials-local` 逐字证据：

- 优先级：**启动环境 > 存储文件 > 项目 `.env` > `$DSH_HOME/.env`**。
- `Only your OS user can read the file, but agent tool processes run as that same user, so this store cannot isolate secrets from the agent.`
- `That is discretion, not a boundary: a deployment that must keep provider keys away from its own agent cannot get there with file permissions.`

**判定**：OpenArc 可以提供模型配置（启动 env / 凭据文件 / 自定义 llm adapter 三路都通），
但**只要密钥进入 Harness 进程，就无法用文件权限把它与 agent 隔离开**——这是官方自承的边界。
满足 OpenArc "密钥由后端凭据库保管" 的唯一干净做法：
**由 OpenArc 提供自定义 llm adapter 插件，把请求代理到 OpenArc Model Proxy，真实密钥不进入 Harness 进程**。
（`dsh-llm` / `dsh-llm-deepseek` / `dsh-llm-pi-ai` 说明 provider abstraction 是一等扩展点。）

## MCP / Skill Relationship

| 能力 | 包 | 状态 |
| --- | --- | --- |
| MCP 客户端 | `dsh-mcp-client` | SUPPORTED（包存在；ACP `mcpCapabilities.http=true`；stdio MCP 实测连上） |
| Skill | `dsh-skill`、`dsh-skill-filesystem`、`dsh-tool-skill` | PARTIAL（包存在，行为未验） |
| 子 agent | `dsh-subagent`、`dsh-tool-subagent`、`dsh-tool-subagent-control` | PARTIAL |
| 计划 / todo | `dsh-plan-mode`、`dsh-tool-todo`、`dsh-goal`、`dsh-goal-round-driver` | PARTIAL |
| 后台任务 / 定时 | `dsh-jobs-local`、`dsh-schedule` | PARTIAL |
| webhook | `dsh-webhook`、`dsh-webhook-github` | PARTIAL |

**冲突提示**：Harness 自带 MCP / Skill / jobs / schedule 能力族，与 OpenArc 的
MCP 中心、Skill 体系、任务队列**职责重叠**。若两边都启用，会出现第二套调度。
→ 必须以"OpenArc 唯一权威"为条件裁剪 Harness 侧能力（见 Decision 条件）。

## Capability Matrix（20 项，逐项定性）

| # | 项 | 判定 | 依据 |
| --- | --- | --- | --- |
| 1 | 官方仓库 / 文档来源 | SUPPORTED | `github.com/deepseek-ai/deepseek-harness` + npm + 随包 README |
| 2 | 当前版本 | SUPPORTED | `0.1.5-rc.1`（`dsh --version` 实测），developer preview |
| 3 | License | SUPPORTED | MIT（LICENSE 文件 + package.json） |
| 4 | 安装方式 | SUPPORTED | npm / npx / 源码三种；本地实测 521 包 47s |
| 5 | 支持平台 | PARTIAL | macOS 实测通过；Windows/Linux 有对应沙箱包但未验 |
| 6 | Node / runtime 要求 | UNKNOWN | CLI 未声明 `engines.node`；addon 声明 `>=20` |
| 7 | 启动方式 | SUPPORTED | `dsh --profile <name>`，五种 profile 实测可用 |
| 8 | API / SDK | SUPPORTED | ACP + SDK JSON-RPC + 进程内 ctx.* + Python SDK（后者未验） |
| 9 | session | SUPPORTED | sessionId 外部驱动；new/list/resume/close 齐备 |
| 10 | conversation | PARTIAL | 会话事件流 + `deriveMessages()` 投影；多轮未实测 |
| 11 | task | PARTIAL | 有 `dsh-goal` / `dsh-tool-todo` / jobs，但与 OpenArc 任务模型冲突未评估 |
| 12 | tool calling | PARTIAL | 工具集外部可控 + 假 MCP 实测连上；`tools/call` 未触发 |
| 13 | MCP | SUPPORTED | `dsh-mcp-client`；ACP `mcpCapabilities.http=true`；stdio MCP 实测连上 |
| 14 | skill | PARTIAL | `dsh-skill` / `dsh-skill-filesystem` / `dsh-tool-skill` 存在，行为未验 |
| 15 | streaming | PARTIAL | agent-loop 描述 chunk→durable frame 结算；未实测 |
| 16 | cancellation | SUPPORTED | ACP `session/cancel` / `session/close`；`agent.cancel()`；无 SDK cancel |
| 17 | persistence | SUPPORTED | `dsh-session-persistence-jsonl`；`DSH_HOME` 可控；格式 v0→v3 迁移中 |
| 18 | retry behavior | SUPPORTED | `dsh-llm-retry` 仅重试模型请求，不重放工具副作用；可关闭 |
| 19 | context handling | PARTIAL | `dsh-compaction-basic` / `tool-result-pruner` / token-meter 存在，未实测 |
| 20 | model provider abstraction | SUPPORTED | `dsh-llm` + `dsh-llm-deepseek` / `dsh-llm-pi-ai`；自定义 adapter 是一等扩展点 |

---

## OpenArc Controlled Tool Proxy Compatibility

| Gate | 问题 | 判定 | 依据 |
| --- | --- | --- | --- |
| **1 外部任务控制** | OpenArc 能自建 taskId 并只让 Harness 执行该任务？ | **PARTIAL** | `sessionId` 由外部传入并驱动 agent 创建；但 SDK 的 `session/prompt` 只回 `messageId`（入队回执），不是 OpenArc 预建 taskId。需 OpenArc 自己维护 `taskId ↔ sessionId` 映射 |
| **2 工具拦截** | 所有工具调用可否被 OpenArc 拦截？ | **PARTIAL（架构可行，端到端未验）** | 工具集由 profile 组合 + `session/new.mcpServers` 决定（实测假 MCP 被连上并枚举）；`approval/request` 是 waterfall 监听器，OpenArc 可注册为终审答复者；无答复者时 `fail closed`。**但 `tools/call` 未实测** |
| **3 重试归属** | Harness 会自行重试有副作用的工具？ | **SUPPORTED（可关）** | `dsh-llm-retry` 只重试**模型请求**，不重放工具副作用；可不挂载或受限配置 |
| **4 取消** | STOP 后能否停止后续 reasoning 与 tool request？ | **SUPPORTED（仅 ACP）** | ACP `session/cancel` + `session/close`；未派发工具调用得 `ABORTED_BEFORE_DISPATCH`。SDK 接入面无 cancel |
| **5 会话归属** | OpenArc 能否管理 user/project/task/session 映射？ | **SUPPORTED** | sessionId 外部驱动；list/resume/close 齐备。但 `list` 不含活动会话，需自持映射 |
| **6 模型配置** | 由 OpenArc 提供配置而非 Harness 持有密钥？ | **PARTIAL（有明确路径，需自建 adapter）** | 三路可注入；但进入进程的密钥无法用权限隔离。干净解=自定义 llm adapter 代理到 OpenArc Model Proxy |
| **7 持久化** | 能否避免 Harness 建一套不受管的永久任务状态？ | **PARTIAL（可控但需约束）** | `DSH_HOME` 可指向 OpenArc 目录；但 JSONL 会话状态客观存在，须定位为可丢弃执行痕迹 |
| **8 可替换性** | 未来只换 `packages/agent-adapter`？ | **SUPPORTED（条件：只走 ACP）** | 若 OpenArc 只依赖 ACP 这层标准协议（外部标准 Agent Client Protocol），换 runtime 只需换 adapter；若依赖进程内 `ctx.*` 或 DSH 特定插件，则不可 |

## Security Boundaries

1. **（高危）ACP 无鉴权**：实测 `authMethods: []`。任何能连上该 stdio 管道的进程即可完全控制 agent。
   OpenArc 必须：只在自己派生的子进程上使用 ACP，**不得监听端口**，管道句柄不外泄。
2. **（高危）凭据与 agent 同权**：官方自承文件权限无法隔离密钥。见 Model Configuration。
3. **（中）工具执行面较大**：随 CLI 落地了 bash / pwsh / fs / str-replace-editor / web / subagent / workflow 等工具族。
   OpenArc 必须用 profile 组合**把工具集裁到最小**，而不是沿用默认 web profile。
4. **（中）沙箱不等于边界**：多平台沙箱包存在，但本轮未验证；且沙箱是 Harness 侧机制，
   不能替代 OpenArc 自己的权限裁决。
5. **（低）developer preview**：README 明示会有破坏性变更，且 session format 已有 v0→v3 三次迁移。

## Replaceability

- 走 **ACP**（外部标准协议）→ 替换 Harness 只需实现同一协议的 adapter，UI / Task / Permission / Device Agent / MCP / Skill / Model Proxy 均不动。**这是唯一满足 Gate 8 的接入方式。**
- 走 **SDK JSON-RPC** → 协议是 DSH 自有，且缺 cancel，替换成本更高且功能受损。
- 走 **进程内 Cordis** → 与 Harness 深度绑定，替换等于重写。**不建议**。

## Verified

本轮实测（证据：`experiments/harness/acp-probe.mjs`，10/10 通过）：

| # | 项 | 结果 |
| --- | --- | --- |
| 1 | ACP `initialize` 握手 | PASS，`protocolVersion=1`，`deepseek-harness-acp@0.0.1` |
| 2 | session 能力 list/resume/close 存在 | PASS |
| 3 | ACP 鉴权方式 | PASS（值为空 → 无鉴权，记为安全发现） |
| 4 | MCP 挂载能力 | PASS，`{"http":true}` |
| 5 | `session/new` 建会话 | PASS，返回 UUID |
| 6 | `session/new` 挂自建假 MCP 工具 | PASS |
| 7 | `session/list` 可用 | PASS（返回数组） |
| 8 | Harness 真的连上假 MCP（initialize + tools/list） | PASS，取证日志证实 |
| 9 | 空闲 `session/cancel` no-op 不破坏服务 | PASS |
| 10 | `session/close` 可调用 | PASS |
| 11 | 未知 sessionId 的 cancel 不误伤 | PASS |
| 12 | 本地 `npm install` + `dsh --version` | PASS，521 包 / 47s / `0.1.5-rc.1` |
| 13 | `session/new` 缺 `mcpServers` 报 `-32602` | PASS（协议必填项） |

## Unsupported

- **SDK JSON-RPC 没有取消方法**（只有 `initialize` / `session/prompt` / `shutdown`）。
- **无内建 turn budget**：`No built-in turn budget`，需自己在 `agent/turn-stopping` 扩展点实现。
- **凭据无法用文件权限与 agent 隔离**（官方自承）。
- ACP 侧：deletion、forks、transcript replay、additional directories 不支持（文档明示）。

## Unknown

- `engines.node` 真实下限（已发布 CLI 未声明该字段）。
- Windows / Linux 上的实际行为（沙箱、路径、编码）。
- `dsh-llm-retry` 在真实失败下的行为（未触发）。
- Skill / subagent / workflow / schedule 的实际语义与 OpenArc 的冲突面。
- 是否会建立 OpenArc 无法观测的内部队列（jobs-local 未验）。
- 长会话 compaction 行为（`dsh-compaction-basic`、`tool-result-pruner` 未验）。
- 性能（模型往返除外）：未测。

## Risks

1. **能力重叠导致第二套权威**：Harness 自带 MCP / Skill / jobs / schedule / subagent，
   与 OpenArc 的"任务队列、调度、权限唯一权威"直接冲突。**必须裁剪。**
2. **developer preview + 三次会话格式迁移**：协议与持久格式都还在动，D2 前需锁定版本策略。
3. **无鉴权 ACP**：管道泄露等于 agent 被接管。
4. **凭据边界**：默认方案下 OpenArc 无法真正"不下发密钥"，需自建 model adapter。
5. **端到端工具链路未验**：Gate 2 的关键一环（拦截→裁决→执行→回灌）本轮无 Key，未跑通。
6. **Windows 未验**：与 D1-01 同一个洞，D1-06 前必须补。
7. **`session/list` 语义**：不能当活动会话枚举用，设计上要自持映射。

## Decision

**ACCEPT WITH CONDITIONS**

理由：架构上满足 OpenArc 的八道门控中的六道半，且**工具集、会话、取消三者都可被外部控制**，
这是可替换 adapter 的关键前提；官方自带的调度/权限/持久能力**可以裁剪**，不构成硬冲突。
但本轮**未取得端到端工具拦截证据**，且存在凭据边界与 ACP 无鉴权两个高危项，因此不能判 ACCEPT。

必须满足的条件。**落实时限：启用 D4 AI 真实执行链之前，以及 D1-06 最终技术关卡之前**
（二者取先到）。届时要么已落实，要么已形成明确的阻断结论。
**D2 不由 Harness 阻塞**——D2 是视觉与桌面基础，与 Harness 是否就绪无关：

1. **只走 ACP 接入面**，禁止依赖进程内 `ctx.*` 与 DSH 自有 SDK JSON-RPC（保 Gate 8 可替换性）。
2. **OpenArc 自建 llm adapter 插件**，把模型请求代理到 OpenArc Model Proxy，真实密钥不进入 Harness 进程（保 Gate 6）。
3. **裁剪 profile**：不挂载 `dsh-jobs-local` / `dsh-schedule` / `dsh-webhook*` / 默认 bash-persistent 等与
   OpenArc 调度权威冲突的插件；`dsh-llm-retry` 只允许 normal 模式或整体不挂载（保 Gate 3）。
4. **OpenArc 注册为 `approval/request` 的终审答复者**，所有工具调用走 OpenArc 权限裁决；
   默认策略设为 `never`（fail-closed），按需临时放行（保 Gate 2）。
5. **ACP 进程由 OpenArc 独占派生，stdio 管道，不监听端口，不外泄句柄**（化解无鉴权风险）。
6. **`DSH_HOME` 指向 OpenArc 管理目录**；Harness 会话状态定位为可丢弃执行痕迹，
   任务真相只在 OpenArc（保 Gate 7）。
7. **补齐端到端工具链路 Probe**（需要可用的模型 Key 或 mock adapter），
   覆盖：allow / deny / stop / timeout / tool error / duplicate call / retry。
   未补齐前，本 ADR 的 Gate 2 维持 PARTIAL。

**不因本 ADR 授权任何产品实现。** D1-02 仅完成技术验证，不进入 D1-03 / D1-04 / D1-05 / D2。

**任务完成判定**：本 ADR 出具后 D1-02 的 *技术决策* 成立（ACCEPT WITH CONDITIONS），
但 *任务状态* 仍为 **PARTIAL**。转为 COMPLETE 的唯一条件是上述端到端工具链路
（allow / deny / stop / timeout / tool error / duplicate call / retry）取得真实运行证据。

---

## Evidence

| 类型 | 位置 / 命令 |
| --- | --- |
| ACP 控制面探针 | `DSH_BIN=<dsh> DSH_MCP_TOOL=1 node experiments/harness/acp-probe.mjs` → 10/10 |
| 假 MCP 服务器 | `experiments/harness/fake-mcp-server.mjs`（只暴露无副作用 `openarc_echo`） |
| 版本/许可元数据 | `npm view @deepseek-ai/dsh version license repository.url` |
| 安装实测 | `npm install @deepseek-ai/dsh` → `added 521 packages in 47s` |
| CLI 自报 | `dsh --version` → `0.1.5-rc.1`；`dsh --help`；`dsh --profile web --dump-default-config` |
| 官方文档（随包） | `node_modules/@deepseek-ai/dsh-llm-retry/README.md`、`dsh-user-approval/README.md`、`dsh-agent-loop/README.md`、`dsh-sdk-jsonrpc-server/README.md`、`dsh-acp/README.md`、`dsh-credentials-local/README.md`、`dsh-home-paths/README.md` |
| 未做 | 未发送真实 prompt，未使用真实模型 Key，未触碰 Photoshop / 真实文件删除等有风险工具 |
