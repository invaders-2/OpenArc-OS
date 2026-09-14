# D4-02C Final Result

Task Status: **D4-02C Task ↔ Harness Orchestration = PASS**（macOS，真实 official DeepSeek Harness + ACP v1 + Model Proxy + Fake Provider）；**D4-02 macOS Task / Harness Core = PASS**；**cross-platform = PARTIAL**（Windows NOT VERIFIED）；**D4-03 Controlled Tool Proxy = BLOCK**（C PASS 后 CONDITIONAL GO，不自动开始）。本轮未进入 Tool / MCP / Canvas / App Center。

## 1. Base
- branch feature/d4-02-task-harness，起点 local HEAD == origin == 2b11648，working tree clean；未 merge main。
- 终点见第 34 节；local HEAD == origin HEAD，working tree clean。
- 新增标准入口 npm run test:d4-02c（experiments/d4-02c/run-all.mjs）。

## 2. Orchestrator Architecture
- 新增 electron/task-harness-orchestrator.cjs：TaskHarnessOrchestrator，职责 startTaskRun/startStepRun/prompt/cancel/dispose。
- 它只做编排：不保存 task/step status、revision、queue、retry、permission state；不直写 SQLite。所有持久 mutation 经 TaskService。
- 垂直链路：Task → TaskStep(reasoning) → Harness Run → ACP v1 → Model Proxy → Provider → ACP updates → safe TaskEvent → Artifact → Verification → Step/Task 终态。
- 顺序硬约束：Task PENDING→RUNNING → Step PENDING→RUNNING → spawn Harness → initialize → session/new → session/prompt。

## 3. Task Authority
- OpenArc = Task Authority；Harness = Ephemeral Reasoning Runtime。Harness 不拥有 persistent queue/state/step/retry/tool/lease/permission authority。
- Orchestrator 无第二份 authority；事件与状态同事务，状态 mutation 一律 TaskService + expectedRevision。
- ACP sessionId 仅 ephemeral runtime correlation，不等于 taskId/stepId。

## 4. Harness Run Model
- schema v10 的 task_harness_runs：run_id / task_id / step_id / status / harness_version / acp_version / model_config_id / model_config_version / started_at / completed_at / stop_reason / error_code。
- 状态冻结 STARTING / RUNNING / SUCCEEDED / BLOCKED / CANCELLED / FAILED。
- 禁止落 proxy token / provider key / 完整 ACP transcript。

## 5. Model Capability
- 启动前重新 authorize + resolve model + verify config version；Harness 只拿 Proxy endpoint + scoped capability + safe model snapshot。
- 每次 run 独立 capability；新增 executionBinding（taskId/stepId/runId）存内存、不进 Provider 权限合同、不落盘。
- Harness Model Adapter 以 expectedToken 绑定本 run：A run token 用于 B run → 401。
- turn 结束（success/failure/cancel/timeout/crash/conflict/blocked）立即 revoke，不等 TTL。

## 6. ACP Mapping
- 显式表：text.delta → harness.text.delta（只聚合 chunks/chars）；reasoning.delta → drop；tool.proposed → harness.tool_proposed；plan → harness.plan；usage → harness.usage；session/request_permission → harness.permission_requested + harness.permission_rejected。
- 未知 ACP 事件丢弃；每 turn maxPersistedHarnessEvents 上限（flood protection）；reasoning 不持久化。

## 7. Prompt / Context
- 只放 Task.goal + safe Step.input + 可选 prior artifact；不塞 DB dump / audit / credentials / 绝对 Resource 路径 / 全历史。
- 默认不保存完整 prompt；保存 promptSchemaVersion + inputHash（+ 安全 verification details）。

## 8. Task Events
- 新增 harness.run.started/succeeded/blocked/unknown_effect、harness.text.delta、harness.plan、harness.usage、harness.tool_proposed、harness.permission_requested/rejected、artifact.created、verification.completed、step.blocked/cancelled、task.blocked。
- Event payload 继续敏感 key 打码 + 长度截断；event ≠ state authority，Harness event 不能改 status。

## 9. Artifact
- task_artifacts：artifact_id / task_id / step_id / run_id / type(text|json) / safe_content / checksum(sha256) / created_at。
- Task Runtime 内部产物，不写 Resource Library、不创建文件、不上传、不产生文件 side effect。

## 10. Verification
- task_verifications：verification_id / artifact_id / task_id / type(EXACT_TEXT|SCHEMA_VALID) / status(PASS|FAIL) / safe_details / created_at。
- 成功必须 Artifact persisted + Verification PASS。

## 11. Success Atomicity
- Artifact + Verification + Step + Task + Events 同一事务提交（TaskService.commitStepSuccess）。
- Artifact 写入失败（注入故障）→ 事务回滚，Step/Task 绝不 SUCCEEDED，0 artifact。
- 永久冻结：assistant says done != Task succeeded。

## 12. Cancel
- 用户 cancel：先持久 cancel_requested=1（task.cancel_requested）→ ACP session/cancel → bridge abort → Provider 连接关闭 → capability revoke → finalizeCancel（Step/Task CANCELLED）。
- 真实 slow provider 实测：Provider closed ≥ 1、requests = 1（0 retry）、capability 全部 REVOKED。

## 13. Cancel Race
- commitStepSuccess 在事务内再次检查 cancel_requested；revision 决定唯一解。
- 实测 cancel 先行 + turn 完成竞争：绝不出现 Task CANCELLED + Step SUCCEEDED。

## 14. Harness Crash
- 真实 kill Harness child → HARNESS_PROCESS_EXITED；Step BLOCKED、Task BLOCKED、harness.run BLOOCKED/unknown_effect。
- 0 respawn / 0 rerun / 0 provider retry（runs 长度保持 1）。

## 15. Timeout
- HARNESS_TURN_TIMEOUT → cancel + terminate + revoke capability；Step BLOCKED，不自动第二次 prompt。

## 16. Restart Recovery
- 跨进程重启探针：写入 Task RUNNING / Step RUNNING / Run RUNNING 后 process.exit；重启 reopen + recoverRunning。
- 结果：Task BLOCKED、Step BLOCKED、run BLOCKED/RECOVERY_REQUIRED、event task.recovery_blocked + step.recovery_blocked + harness.run.unknown_effect；harness.run.started 计数仍 1（0 自动 replay）；recovery 幂等。

## 17. Explicit Resume
- Explicit Resume = DEFERRED（接口保留，返回 EXPLICIT_RESUME_DEFERRED）；不阻塞核心 Orchestration PASS。

## 18. Retry Policy
- AUTO_RETRY = 0；attempt = 1；maxAttempts = 1。TaskService / Orchestrator / Harness / Adapter / Proxy 全 0 隐藏 retry。

## 19. Tool Proposal Boundary
- tool_call → 0 execute；TaskEvent harness.tool_proposed；Step BLOCKED / TOOL_EXECUTION_NOT_AVAILABLE；绝不 SUCCEEDED；0 artifact。

## 20. Permission Boundary
- session/request_permission → 一律 reject；TaskEvent harness.permission_requested + permission_rejected；Step BLOCKED / PERMISSION_NOT_AVAILABLE；0 execution。

## 21. MCP Boundary
- mcpServers = []；任何 MCP 能力不可达；MCP = 0。

## 22. User Isolation
- User B 不能 run / cancel / getTask / getEvents / getHarnessRuns / getArtifacts User A Task（TASK_FORBIDDEN）。

## 23. App Isolation
- App B 不能 orchestrate App A Task（TASK_FORBIDDEN）。actor 来源仅 Task trusted owner/session/app，不是 Harness payload。

## 24. Artifact Isolation
- Artifact 访问继承 Task ownership + App context，无新增 Artifact ACL；非 owner 读取返回 TASK_FORBIDDEN。

## 25. Credential / Capability Isolation
- Fake Provider 收到正确 Provider Authorization；Provider Secret 在 Task DB / Event / Artifact / Run 0 hit。
- 完整 proxy capability（mpx_ token）不落 Task DB / Event / Artifact；A run token 不能用于 B run（401）。

## 26. Migration
- SCHEMA_VERSION = 10；v9 之上加 task_harness_runs / task_artifacts / task_verifications。
- v1→current … v9→current 与 v10 级失败整级回滚（user_version 停 9、v10 表不残留）全部 PASS；既有 migration 测试同步补 v10 表。

## 27. Vertical E2E
- 真实跑通：Create Task → Create Step(reasoning) → Run → official DeepSeek Harness → ACP v1 → OpenArc Model Proxy → Fake Provider → ACP updates → Artifact(OPENARC_TASK_OK) → Verification EXACT_TEXT PASS → Step SUCCEEDED → Task SUCCEEDED。
- 记录：taskId/stepId/runId/modelConfigVersion/harnessVersion/ACP version/provider request count=1/artifact checksum/verification PASS/final revision。

## 28. D4-02A Regression
- npm run test:d4-02a = 22 / 22 PASS（Task Authority 未重写）。

## 29. D4-02B Regression
- npm run test:d4-02b = 16 / 16 PASS（dsh 0.1.5-rc.2 / ACP SDK 1.4.0 / protocol 1）。

## 30. D4-01 Regression
- npm run test:d4-01 = 59 / 59 PASS；npm test = 582 / 582 PASS；npm run build = PASS。

## 31. Security
- npm run test:security = FAIL 0 / PARTIAL 2 / PASS 6。
- 修正 docs/D4-02B-RESULT.md 中触发密钥字面量扫描的 Bearer 示例（改为不带可匹配长串的写法）；未改变任何 D4-02B 架构结论。

## 32. Tests
- 新增 tests/task-harness-orchestrator.test.mjs、task-harness-e2e.test.mjs、task-harness-cancel.test.mjs、task-harness-recovery.test.mjs、task-harness-security.test.mjs、task-orchestration-migration.test.mjs。
- 夹具：tests/fixtures/harness-acp/task-harness-fixture.mjs、tool-agent.mjs、restart-writer.mjs；fake provider 增 exact 行为。
- 入口 experiments/d4-02c/run-all.mjs + npm run test:d4-02c = 22 / 22 PASS（--test-concurrency=1）。

## 33. Files Changed
- 产品：electron/task-harness-orchestrator.cjs（新）、electron/task-domain.cjs、task-store.cjs、task-service.cjs、task-bootstrap.cjs、identity-bootstrap.cjs、identity-store.cjs（schema v10）、harness-adapter.cjs、harness-model-adapter.cjs、model-proxy.cjs。
- 测试/入口：tests/task-harness-*.test.mjs、tests/task-orchestration-migration.test.mjs、tests/fixtures/harness-acp/*、tests/model-fake-provider.mjs、tests/{migration,resource-migration,resource-library-migration,resource-index-migration,device-migration,task-store}.test.mjs、experiments/d4-02c/run-all.mjs、package.json。
- 文档：docs/decisions/D4-02C-task-harness-orchestration.md、docs/decisions/D4-02-task-authority.md、docs/D4-02B-RESULT.md（扫描修正）、docs/D4-02C-RESULT.md、PROGRESS.md。

## 34. Commits
- 见最终提交（D4-02: orchestrate tasks through ACP harness / test(D4-02): verify task harness cancel recovery and isolation / docs(D4-02): close macOS task harness gate）。
- local HEAD == origin/feature/d4-02-task-harness；working tree clean；未 merge main。

## 35. Evidence
| 入口 | 结果 |
|---|---|
| npm run test:d4-02c | 22 / 22 PASS |
| 版本 | dsh 0.1.5-rc.2 / ACP SDK 1.4.0 / protocol 1 / schema 10 |
| npm run test:d4-02a | 22 / 22 PASS |
| npm run test:d4-02b | 16 / 16 PASS |
| npm run test:d4-01 | 59 / 59 PASS |
| npm test | 582 / 582 PASS |
| npm run build | PASS |
| npm run test:security | FAIL 0 / PARTIAL 2 / PASS 6 |
| 垂直 E2E | Artifact OPENARC_TASK_OK / Verification PASS / Task SUCCEEDED |
| Provider request count | 1（0 retry） |
| Cancel | Provider closed >= 1 / requests 1 / capability REVOKED / Step+Task CANCELLED |
| Crash / Timeout | HARNESS_PROCESS_EXITED / HARNESS_TURN_TIMEOUT → BLOCKED，0 respawn |
| Restart | BLOCKED / RECOVERY_REQUIRED，0 replay |
| Tool / Permission / MCP | 0 execution / reject / 0 |

## 36. Remaining Gaps
- OS-level network isolation = NOT VERIFIED（D1-05 无 OS network sandbox，本阶段仅 application-level：Harness 模型目标仅 OpenArc bridge）。
- external workspace read audit = NOT VERIFIED（无 OS 审计）。
- independent malformed ACP injection = NOT VERIFIED。
- Windows = NOT VERIFIED。
- External Provider 真机 = NOT VERIFIED（继承 D4-01）。
- Explicit Resume = DEFERRED。
- 真实 dsh 工具开启后的 tool proposal = NOT VERIFIED（managed profile 工具全关，tool proposal 经真实 ACP tool_call 探针验证 0 execution 策略）。

## 37. D4-02 Final Gate
- Task Authority = OpenArc；Harness Authority = none；垂直 E2E PASS；ACP→TaskEvent mapping PASS；Artifact persistence PASS；Verification PASS；成功必须 verification PASS；cancel propagation + provider abort + capability revoke PASS；crash → BLOCK 0 respawn 0 retry PASS；restart → RECOVERY_REQUIRED 0 replay PASS；tool 0 execute / permission reject / MCP 0 PASS；user/app/artifact isolation PASS；Provider Secret 0 hit；proxy bearer 0 forbidden persistence；Migration PASS；D4-02A/B、D4-01 regression PASS；Security FAIL 0；npm test PASS；build PASS。
- 结论：**D4-02 macOS Task / Harness Core = PASS**；cross-platform = **PARTIAL**（Windows NOT VERIFIED）。

## 38. D4-03 Admission
- D4-03 Controlled Tool Proxy = **CONDITIONAL GO**（D4-02C PASS 后），但**不自动开始**。
- 直到 D4-03：production tool execution = 0、MCP = 0。D4-02B 遗留（OS-level network isolation / external workspace read audit / malformed ACP injection / Windows / External Provider）继续挂账，不因 C PASS 自动关闭。
