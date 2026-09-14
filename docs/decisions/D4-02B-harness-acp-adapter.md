# D4-02B · Official ACP Harness Adapter / Model Adapter Boundary

- **状态**：**D4-02B Official ACP Harness Adapter = PASS**（macOS）；**D4-02 overall = PARTIAL**（D4-02C Task ↔ Harness Orchestration = NOT STARTED）；**D4-03 Controlled Tool Proxy = BLOCK**
- **分支**：feature/d4-02-task-harness，基线 feature/d4-01-model-service @ `5afece6`，未 merge main
- **日期**：2026-09-15

## 官方来源与版本（PIN）

- Harness：**官方 DeepSeek Harness `@deepseek-ai/dsh@0.1.5-rc.2`**（developer preview），由 DSH Desktop managed runtime 冻结安装；`dsh --profile acp` 是官方 ACP profile（`@deepseek-ai/dsh-acp-app` / `@deepseek-ai/dsh-acp`）。
- ACP：**v1**，官方 `@agentclientprotocol/sdk@1.4.0`（`PROTOCOL_VERSION = 1`）；**不使用** experimental v2。repo devDependencies 以 exact 版本 PIN；运行时可从 repo `node_modules` 或冻结 DSH runtime 解析。
- 启动**不依赖全局 PATH**：`OPENARC_DSH_BIN` → repo `node_modules/.bin/dsh` → 冻结 runtime `node_modules/.bin/dsh`；测试报告输出 dsh version / ACP SDK version / protocol version。

## Transport

**ACP over stdio**：OpenArc Main → exclusive child process → stdin/stdout JSON-RPC（NDJSON）。stdout **只允许 ACP protocol**，Harness 普通日志走 stderr；Adapter 不解析/不记录 stdout，交给 SDK。

## 链路

```
Harness（dsh --profile acp）
  → OpenArc Harness Model Adapter（OpenAI-compatible SSE ↔ Model Proxy JSON）
  → OpenArc Model Proxy（scoped capability，per-call reauthorize）
  → Provider
```
Harness **不能**直连 DeepSeek/OpenAI Provider；managed profile 关闭 `llm-deepseek`。唯一模型出口是 OpenArc Model Proxy。

## Harness 只获得

proxy endpoint、scoped proxy capability（经 env 注入，非 profile 文件）、safe model metadata（modelConfigId / modelConfigVersion / capabilities）。**不得获得** credentialRef / Provider API Key / Provider Authorization / CredentialStore / Keychain 位置 / OpenArc Model DB。

## DSH_HOME 隔离

每次 run = 一个 **disposable 绝对路径 DSH_HOME**（`os.tmpdir()/oa-d4-02b-*/dsh-home`），生命周期 create → run → close → scan → delete。**绝不**使用用户真实 `~/.dsh`（探针断言真实 `~/.dsh` 前后不变）。cwd 是隔离 workspace，**不**把 repo root / Home / Desktop 交给 Harness；`additionalDirectories = []`。

## Environment

显式 **allowlist**（PATH/TMPDIR/LANG/LC_*/TZ/SHELL）+ managed HOME/DSH_HOME，其余不继承；**显式 scrub**：OPENAI/ANTHROPIC/DEEPSEEK/GEMINI API key、AWS_*、AZURE_*、GITHUB_TOKEN、GH_TOKEN、NPM_TOKEN、SSH_AUTH_SOCK 等。capability 可进可信 child env；**不写** profile yaml / DSH_HOME 持久文件 / 日志 / ACP transcript。

## Managed ACP Profile（patch，不改 harness 源码）

基于真实配置 catalog（`--dump-default-config`）写 patch：
- `llm-pi-ai.providers.openarc`：`api: openai-completions`、`baseURL: !!js process.env.OPENARC_HARNESS_BRIDGE`、`apiKeyEnv: OPENARC_MODEL_PROXY_CAPABILITY`、`retryPolicy: { mode: normal, maxRetries: 0 }`、手声明 model。
- `agent-default-model` / `acp` → provider `openarc`。
- **关闭**：`tool-bash`、`tool-pwsh`、`tool-fs`、`tool-fs-search`、`tool-web`、`tool-jobs`、`tool-skill`、`tool-goal`、`tool-ralph`、`tool-workflow`、`tool-present`、`tool-subagent*`、`skill`、`skill-filesystem`、`web`、`web-search-deepseek`、`web-fetch-http`、`llm-deepseek`、`llm-retry`、`session-telemetry-otel`。
- MCP：session 参数固定 `mcpServers: []`；profile 不挂 MCP client。
- `session-persistence-jsonl` **保持启用**：`dsh-acp` 与 `session-checkpoint-policy` 硬依赖 `sessionPersistence` service（禁用会导致 boot 失败）。它写在隔离 DSH_HOME 内，且**非权威**：OpenArc 永不使用 `session/list | resume | load` 来恢复 Task。

## Permission / Tool 策略

ACP client 实现 `session/request_permission` → **一律 reject**（ACP v1 outcome `cancelled`）；client 能力不声明 `fs.readTextFile` / `writeTextFile` / terminal。`session/update` 的 `tool_call` / `tool_call_update` 只记录安全 metadata，**不执行**。D4-03 未建立前没有工具执行授权来源。production tool execution = 0。

## Task 权威

Harness session persistence / sessionId **非权威**；sessionId 只是 ephemeral diagnostic。OpenArc 恢复只认 Task DB / TaskEvent / Task revision / `RECOVERY_REQUIRED`，**绝不**问 Harness "上次做到哪了"。本阶段**不**把 ACP event 升级为 TaskEvent（留给 D4-02C）。

## Retry

`llm-retry` 关闭 + pi-ai route `maxRetries: 0` → Harness 侧 0 自动 retry；Adapter / bridge 0 retry；Model Proxy 0 隐藏 retry。取消与失败都不重发。

## Cancel / Crash / Timeout

- Cancel：`session/cancel` → Harness 停止 → bridge 检测 client 断开并 abort 上游 → Model Proxy 检测 res close 并 AbortController 取消在途 Provider 调用 → Provider 连接关闭；0 retry。
- Crash：child 被杀 → `HARNESS_PROCESS_EXITED`，**0 respawn / 0 retry**。
- Timeout：start → `HARNESS_START_TIMEOUT`；turn → `HARNESS_TURN_TIMEOUT`，之后 cancel/terminate。
- Protocol：非法 JSON-RPC / 版本不支持 → `HARNESS_PROTOCOL_ERROR` / `HARNESS_PROTOCOL_UNSUPPORTED`，fail closed。
- Shutdown：`session/close` → stdin close → grace → SIGTERM → bounded SIGKILL；timers/listeners/临时目录清理。

## Developer Preview Compatibility

Harness 处于 developer preview。`tests/harness-acp-protocol.test.mjs` 断言 expected executable / expected ACP profile / initialize / required capabilities / patch keys / dsh+sdk+protocol 版本；依赖升级时该 probe 必须先红。

## 未验证 / 边界

- **OS-level network isolation = NOT VERIFIED**：本阶段只做到 application-level（Harness 模型目标仅 OpenArc bridge）。D1-05 尚无完整 OS network sandbox。
- **Harness-driven permission request = NOT VERIFIED in managed profile**：managed profile 工具全关，不会产生真实 tool permission；permission 策略用 `tests/harness-acp-permission.test.mjs`（强制 ACP `session/request_permission`）验证 client 一律 reject + 0 执行。真实 dsh + 开启工具的对抗性 probe 留待 D4-03。
- **Workspace 外文件 "未被访问" = NOT VERIFIED**：只证明未被删除/修改（无 OS 级审计）。
- Windows = NOT VERIFIED（继承 D4-01）。

## D4-02C Handoff

D4-02C 才做 Task ↔ Harness Orchestration：Task → Step → Harness Turn → TaskEvent mapping → Result Artifact → Cancel → Recovery。D4-02B 只在 adapter 内处理 ACP event。**D4-03 = BLOCK**，直到 D4-02 自身 PASS。
