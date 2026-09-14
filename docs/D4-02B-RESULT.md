# D4-02B Result

Task Status: **D4-02B Official ACP Harness Adapter = PASS**（macOS，真实 official DeepSeek Harness + ACP v1 stdio）；**D4-02 overall = PARTIAL**（D4-02C Task ↔ Harness Orchestration = NOT STARTED）；**D4-03 Controlled Tool Proxy = BLOCK**。

## 1. Base
branch `feature/d4-02-task-harness`，从 `bf97c63` 继续；起点 clean，HEAD == origin == `bf97c63`；未 merge main。新增标准入口 `npm run test:d4-02b`。

## 2. Harness Version
官方 **`@deepseek-ai/dsh@0.1.5-rc.2`**（developer preview），来自冻结的 DSH Desktop managed runtime；`dsh --profile acp` 真实启动。**不依赖**全局 `/usr/local/bin/dsh` 或用户 PATH：解析顺序 `OPENARC_DSH_BIN` → repo `node_modules/.bin/dsh` → 冻结 runtime，测试断言解析到冻结路径。

## 3. ACP Version
**ACP v1**（`PROTOCOL_VERSION = 1`），官方 **`@agentclientprotocol/sdk@1.4.0`**（repo devDependencies exact PIN；运行时从 repo 或冻结 runtime 解析）。initialize 返回 `protocolVersion: 1`，否则 `HARNESS_PROTOCOL_UNSUPPORTED`。**不使用** experimental v2。

## 4. Official ACP Profile
`dsh --profile acp`（`@deepseek-ai/dsh-acp-app` + `@deepseek-ai/dsh-acp`）真实 boot。Config catalog 由 `--dump-default-config` 读取，**不猜字段**。OpenArc patch（不改 harness 源码）：`llm-pi-ai.providers.openarc`（`api: openai-completions`、`baseURL: !!js process.env.OPENARC_HARNESS_BRIDGE`、`apiKeyEnv: OPENARC_MODEL_PROXY_CAPABILITY`、`retryPolicy: {mode: normal, maxRetries: 0}`）、`agent-default-model`/`acp` → `openarc`；关闭 `llm-deepseek`/`llm-retry`/全部 tool-*/`skill`/`web`/telemetry。

## 5. Adapter Architecture
`electron/harness-adapter.cjs` = ACP client + spawn + isolated DSH_HOME + env scrub + patch + permission reject + cancel/crash/timeout + dispose；`electron/harness-model-adapter.cjs` = OpenArc Harness Model Adapter（OpenAI-compatible SSE ↔ Model Proxy JSON）。Adapter **不拥有** queue / Task status / Step status / revision / retry / recovery / lease / permission state（属于 TaskService）。

## 6. Process Transport
ACP over stdio：OpenArc Main → exclusive child → stdin/stdout NDJSON JSON-RPC。stdout 只允许 ACP protocol（Adapter 不解析/不记录，交给 SDK）；Harness 日志走 stderr。

## 7. DSH_HOME Isolation
每次 run = 一个 disposable 绝对路径 `os.tmpdir()/oa-d4-02b-*/dsh-home`；生命周期 create → run → close → scan → delete。探针断言 **真实 `~/.dsh` 前后完全不变**、DSH_HOME 在 tmp 下，且 dispose 后删除。

## 8. Environment Scrub
显式 allowlist（PATH/TMPDIR/LANG/LC_*/TZ/SHELL）+ managed HOME/DSH_HOME；显式清除 OPENAI/ANTHROPIC/DEEPSEEK/GEMINI API key、AWS_*、AZURE_*、GITHUB_TOKEN、GH_TOKEN、NPM_TOKEN、SSH_AUTH_SOCK。capability **只**进可信 child env，不写 profile/DSH_HOME/日志。

## 9. Model Proxy Route
唯一链路：Harness → OpenArc Harness Model Adapter → **OpenArc Model Proxy** → Provider。managed profile 关闭 `llm-deepseek`，Harness 无直连 Provider 出口。Adapter 不实现 Provider auth/routing/retry/SSRF/Credential Store。

## 10. Credential Isolation
Fake Provider **收到正确 Provider Authorization**（`Bearer FAKE_PROVIDER_SECRET_...`）；Harness 侧 Provider Secret hits = **0**（env / argv / stdout / stderr / DSH_HOME / workspace / ACP messages / artifacts）。

## 11. Proxy Capability
每次 Harness run 申请独立 scoped capability（绑定 user/session/app/modelConfig/modelConfigVersion/allowed capability/maxCalls/expiry/nonce），`maxCalls` 显式 bounded（探针 4）。capability 经 env 注入 → 作为 Bearer 发到 Adapter → 转发给 Model Proxy。**不落盘**（DSH_HOME/workspace/profile/日志均 0）；跨 proxy 复用 DENY（401），`maxCalls=1` 第二次 429。

## 12. ACP Initialize
真实 `initialize({protocolVersion:1, clientCapabilities:{fs:{readTextFile:false,writeTextFile:false}}})` → `agentInfo.name === "deepseek-harness-acp"`；不支持版本 fail closed。有 `HARNESS_START_TIMEOUT`。

## 13. Session New
真实 `session/new({ cwd: <隔离 workspace 绝对路径>, mcpServers: [], additionalDirectories: [] })`；返回真实 `sessionId`；repo root / Home / Desktop 不交给 Harness。

## 14. Prompt / Streaming
固定 prompt `Return exactly: OPENARC_ACP_OK` → 真实 `session/prompt` → 捕获 `session/update` 的 `agent_message_chunk` 与 `usage_update`，文本 = fake provider 的 `"hello from fake"`；`stopReason === "end_turn"`。ACP update 归一化为内部 HarnessEvent（`text.delta` / `reasoning.delta` / `tool.proposed` / `plan` / `usage`），**保留原始类型**，不发明事件。

## 15. Permission Policy
ACP client 实现 `session/request_permission` → **一律 reject**（v1 outcome `cancelled`）。强制 permission probe：真实 ACP 请求 → client 返回 cancelled，**0 执行**。同时 client 不声明 fs/terminal 能力。

## 16. Tool Boundary
managed profile 关闭全部工具；`session/update` 的 `tool_call`/`tool_call_update` 只记安全 metadata，**不执行**。**production tool execution = 0**。

## 17. MCP Boundary
session `mcpServers: []` 固定空数组；profile 不挂 MCP client。**MCP = 0**。

## 18. Cancel
真实慢 Provider：prompt → `session/cancel` → Harness 停止（`stopReason: cancelled`）；bridge 检测 client 断开并 abort 上游；Model Proxy 检测 res close → AbortController → **Provider 连接关闭**（fake provider `closed` 计数 ≥1）；**0 retry**（Provider 只被请求 1 次）。

## 19. Timeout
`HARNESS_START_TIMEOUT`（initialize）；`HARNESS_TURN_TIMEOUT`（turn 超时 → cancel/terminate，不无限挂）；bounded shutdown：session/close → stdin close → grace → SIGTERM → bounded SIGKILL。

## 20. Child Crash
真实 kill child → prompt 以 **`HARNESS_PROCESS_EXITED`** 失败；`processExited=true`；**0 respawn**（pid 不变）、**0 retry**。

## 21. Protocol Error
非法/不支持协议 → `HARNESS_PROTOCOL_ERROR` / `HARNESS_PROTOCOL_UNSUPPORTED`，fail closed，不 retry。（版本不支持由 initialize 分支覆盖；malformed 由 SDK 解析异常经 Adapter 归类。）

## 22. Retry
`llm-retry` 关闭 + pi-ai route `maxRetries: 0` → Harness 0 自动 retry；Adapter/bridge 0 retry；Model Proxy 0 隐藏 retry（并发/取消/crash 均断言请求数不增）。

## 23. Workspace Isolation
cwd = 隔离 workspace；`protected.txt` hash 前后不变（**0 filesystem mutation**）；workspace 外 `OPENARC_HARNESS_FORBIDDEN_FILE` 未被删除。**"未被访问" = NOT VERIFIED**（无 OS 级审计）。

## 24. Persistence Authority
Harness session persistence / sessionId **非权威**。`session-persistence-jsonl` 因 `dsh-acp` 硬依赖 `sessionPersistence` service 而保持启用，但写在隔离 DSH_HOME 内；OpenArc 永不使用 `session/list|resume|load` 恢复 Task。恢复只认 Task DB / TaskEvent / revision / `RECOVERY_REQUIRED`。

## 25. Lifecycle
5 次连续 run 全部自然结束、child exited、bridge 关闭、无 orphan / listener 累积；dispose 清理 timers/listeners/临时目录。

## 26. Concurrency
2 个独立 Harness 进程并行：独立 DSH_HOME、独立 capability、独立 ACP session（sessionId/capabilityId 不同），不串；两者 prompt 均成功。

## 27. Secret Scan
Provider Secret 0 hit（Harness env/argv/stdout/stderr/DSH_HOME/workspace/ACP messages/artifacts）；完整 Proxy capability 不落盘；`~/.dsh` 未触碰；OpenArc 侧 adapter/bridge 只记录 method/status/error code/timing，不记录 prompt/transcript。

## 28. D4-02A Regression
`npm run test:d4-02a` **22 / 22 PASS**。Task Authority 未被重写。

## 29. D4-01 Regression
`npm run test:d4-01` **59 / 59 PASS**（含 model-proxy 取消接线后的 proxy/child/stream 测试）。`npm test` **560 / 560 PASS**；`npm run build` PASS。

## 30. Security
`npm run test:security`：**FAIL 0 / PARTIAL 2 / PASS 6**（既有基线）。未新增 secret 通道；未改动 D1-05 未关闭项。

## 31. Tests
新增 `tests/harness-acp-protocol.test.mjs`（4）、`harness-acp-isolation.test.mjs`（5）、`harness-acp-cancel.test.mjs`（3）、`harness-acp-lifecycle.test.mjs`（3）、`harness-acp-permission.test.mjs`（1）；fixtures `tests/fixtures/harness-acp/{fixture.mjs, permission-agent.mjs}`；入口 `experiments/d4-02b/run-all.mjs` + `npm run test:d4-02b`（**16 / 16 PASS**，`--test-concurrency=1`）。这些文件也被 `npm test` 覆盖。

## 32. Files Changed
产品：`electron/harness-adapter.cjs`（新）、`electron/harness-model-adapter.cjs`（新）、`electron/model-proxy.cjs`（res-close → AbortController 取消在途 Provider 调用 + safe send）。
测试/入口：`tests/harness-acp-*.test.mjs`、`tests/fixtures/harness-acp/*`、`tests/model-fake-provider.mjs`（closed 计数）、`experiments/d4-02b/run-all.mjs`、`package.json`、`package-lock.json`（`@agentclientprotocol/sdk@1.4.0` exact PIN + `test:d4-02b`）。
文档：`docs/decisions/D4-02B-harness-acp-adapter.md`、`docs/D4-02B-RESULT.md`、`PROGRESS.md`。

## 33. Commits
（本轮）`D4-02: add official ACP harness adapter`、`test(D4-02): verify harness proxy and credential isolation`、`docs(D4-02): freeze ACP harness boundary`。

## 34. Evidence
| 入口 | 结果 |
| --- | --- |
| npm run test:d4-02b | **16 / 16 PASS** |
| 版本 | dsh **0.1.5-rc.2** / ACP SDK **1.4.0** / protocol **1** |
| test:d4-02a | **22 / 22 PASS** |
| test:d4-01 | **59 / 59 PASS** |
| npm test | **560 / 560 PASS** |
| npm run build | PASS |
| test:security | FAIL 0 / PARTIAL 2 / PASS 6 |
| Fake Provider 收到 Provider key | **PASS** |
| Harness Provider Secret hits | **0** |
| production tool execution / MCP | **0 / 0** |
| permission request | **reject all** |
| cancel / crash / timeout | **PASS / HARNESS_PROCESS_EXITED / HARNESS_TURN_TIMEOUT** |
| Harness retry / Adapter retry | **0 / 0** |
| 5-run lifecycle / 2-process isolation | **PASS / PASS** |

## 35. Remaining Gaps
**D4-02C Task ↔ Harness Orchestration = NOT STARTED**（Task→Step→Harness Turn→TaskEvent→Artifact→Cancel→Recovery）；OS-level network isolation = **NOT VERIFIED**（D1-05 无 OS network sandbox，本阶段只做到 application-level：Harness 模型目标仅 OpenArc bridge）；Harness-driven permission request in managed profile = **NOT VERIFIED**（工具全关，改用强制 ACP permission probe 验证 reject 策略）；workspace 外文件"未被访问" = **NOT VERIFIED**；Windows = NOT VERIFIED；External Provider 真机 = NOT VERIFIED（继承 D4-01）。

## 36. D4-02C Admission
**D4-02C Task ↔ Harness Orchestration = CONDITIONAL GO**（D4-02A 持久权威 + D4-02B 真实 ACP adapter 均已 PASS）。冻结条件：ACP ONLY；`HARNESS_RAW_PROVIDER_KEY = FORBIDDEN`；Harness 只经 OpenArc Model Proxy；只接收 endpoint + scoped capability + safe snapshot；Harness 不拥有 persistent queue/state/step/retry/tool/lease/permission authority；ACP event 只在 D4-02C 显式映射为 TaskEvent。**D4-03 Controlled Tool Proxy = BLOCK**，直到 D4-02 自身 PASS。本阶段到此停止，未进入 D4-02C / D4-03 / Harness Tool / MCP。
