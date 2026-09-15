# D4-03B Result

Task Status: **D4-03B 执行引擎 = PASS**（真实 READ_ONLY 执行 + 真实 Resource/Search Domain）；**official dsh 真实 tool_call 执行 E2E = PASS**（见 docs/D4-03B-CLOSURE-RESULT.md）；**D4-03B overall = PASS**；**D4-03C = CONDITIONAL GO**。WRITE execution = 0 / MCP = 0 / Shell = 0 / Browser automation = 0。

## 1. Base
从 feature/d4-03-tool-proxy @ b411651（local HEAD == origin == b411651，working tree clean）继续；未 merge main。终点见第 36 节。

## 2. Execution Architecture
ControlledToolProxy 扩展 propose / decide / executeReadOnly / verify，未新增第二个 Tool Runtime。执行链：Task → Harness tool proposal → propose → decide(ALLOWED) → executeReadOnly（reauthorize → plan match → adapter.prepare/execute）→ verify（outputSchema + adapter.verify）→ ToolExecution → safe result → 后续 ACP prompt 交回 Harness → Artifact/Verification → Step/Task SUCCEEDED。

## 3. Tool Execution Store
schema v12 tool_executions：execution_id / proposal_id / decision_id / task_id / step_id / run_id / tool_id / tool_version / status / started_at / completed_at / result_ref / result_hash / verification_status / error_code；UNIQUE(proposal_id)。只存安全 result ref+hash 与 verification/stage，不存完整敏感输出/credential/proxy token/absolute path。无 UNKNOWN_EFFECT。

## 4. Resource Metadata Tool
resource.read.metadata 真实调用 ResourceService.get（不直接 SQL），返回 allowlist metadata：resourceRef/name/resourceType/mimeType/version/updatedAt/size/scope。

## 5. Resource Search Tool
resource.search 正式加入 Registry（READ_ONLY / sideEffect=READ / executionProvider=SearchService），真实调用 SearchService.search（不直接查 FTS），服务端授权过滤，limit 上限 20。

## 6. Input Validation
inputSchema 双向验证之一：required / additionalProperties=false / pattern / 长度 / 数值上限。resourceRef 必须是 resource://res_...；limit 上限 20；超限/未知字段 → INVALID TOOL_ARGUMENT_INVALID，0 Domain call。

## 7. Output Validation
outputSchema 与 adapter.verify 双重校验。schema 失败 → FAILED TOOL_OUTPUT_INVALID；verify 失败 → FAILED TOOL_VERIFICATION_FAILED；都不返回脏结果。

## 8. Result Redaction
safe projection 只保留声明字段；绝不返回 ownerUserId/checksum/storageDeviceId/attributes/absolute path/internal blob path；execution 只存 result hash。

## 9. Reauthorization
execute 前重新检查 Session/User/App/Task owner/Task RUNNING/未 cancel/expectedRevision/Step RUNNING/当前 run/Tool enabled+version/Resource active/Resource 权限/useByAgent；commit 前再查 revision/cancel/session/app。decision ALLOWED 不是长期授权。

## 10. useByAgent
执行前 authorize(agent=true) 强制 useByAgent；proposal 与 execution 两条路径都验证。真实链路：alice 有 resource.read 但无 useByAgent → DENY + 0 Domain read。

## 11. User Isolation
User B 读/搜 User A private resource → DENY，0 Domain call，search 返回 0 且无差异化错误。

## 12. App Isolation
同 User、App B 无 resource/tool permission → DENY + 0 Domain call。

## 13. Search Privacy
FTS 只给候选，authorizeMany 实时授权（agent=true）；隐藏资源精确名称搜索 → 0 result，total 只统计 authorized，无 count/timing/error 区分。

## 14. Session Revocation Race
proposal ALLOWED 后 revoke session → executeReadOnly → TOOL_AUTHORIZATION_REVOKED，0 Domain call。

## 15. App Disable Race
proposal ALLOWED 后 disable app → DENY + 0 Domain call。

## 16. Permission Revocation Race
proposal ALLOWED 后 revoke resource.read → DENY + 0 Domain read。

## 17. useByAgent Revocation Race
proposal ALLOWED 后只 revoke useByAgent（read 仍有效）→ TOOL_AGENT_USE_NOT_AUTHORIZED + 0 Domain read。

## 18. Resource Delete Race
proposal ALLOWED 后 resource 被删除/trash → RESOURCE_NOT_AVAILABLE，不返回 stale metadata。

## 19. Task Cancel Race
proposal ALLOWED 后 Task cancel → TASK_CANCELLED + 0 Domain call；AbortSignal 中止 → BLOCKED/CANCELLED，不返回数据。

## 20. Duplicate Execution
同一 proposal 第二次 executeReadOnly → duplicate=true 返回既有 execution，0 额外 Domain call。UNIQUE(proposal_id) 兜底。

## 21. Retry Policy
AUTO_RETRY = 0；timeout/失败 0 retry；READ_ONLY 也不自动重试。

## 22. Cancel
executeReadOnly 接受 signal 与 bounded timeout（默认 15s，测试 120ms）；超时 → TOOL_TIMEOUT；adapter throw → TOOL_EXECUTION_FAILED；都不泄漏 stack/SQL/path。

## 23. Audit
authorization_audit 记录 tool.execution_started / succeeded / failed / verification_failed，只存安全投影（tool/actor/decision/reason），不 dump result。

## 24. Task Events
新增 tool.execution.started / succeeded / failed、tool.verification.failed；READ_ONLY 执行期间 Task/Step 保持 RUNNING；event 只含 executionId/resultHash/errorCode，不含完整 result。

## 25. Tool Result → Harness
OpenArc 执行 + verify 后才把 bounded 安全结果作为后续 ACP prompt 交回 Harness；Harness 收到后才能继续推理并产出最终答案（受控 agent 未收到 Tool result 会返回 MISSING_TOOL_RESULT）。Harness 不能自己伪造 success。

## 26. Official Harness E2E
**PASS**（D4-03B Final Closure）。official dsh 0.1.5-rc.2 经 managed openarc-acp profile 加载 OpenArc Tool Plugin（exactly 2 READ_ONLY tool），真实 model tool_call → plugin.execute() → Tool Facade Bridge（tpx_ capability）→ ControlledToolProxy → SearchService/ResourceService → safe result → dsh Tool Runtime → 续推理 → Artifact/Verification/Task SUCCEEDED。细节见 docs/D4-03B-CLOSURE-RESULT.md。

## 27. Mutation Boundary
READ_ONLY 执行前后：Resource version / updated_at / checksum 不变、resource_registry 计数不变；只新增 task events / tool execution records / audit / artifacts / verification。

## 28. Secret Scan
扫描 tool_executions / task_tool_proposals / tool_decisions / TaskEvent / Artifact / authorization_audit / Harness / ACP：Provider Secret 0 hit、proxy capability（mpx_）0 hit、绝对路径/store root 0 hit。

## 29. Migration
SCHEMA_VERSION = 12；v1→current … v11→current 与 v12 级失败整级回滚（user_version 停 11、v12 表不残留）PASS。

## 30. D4-03A Regression
npm run test:d4-03a = 32/32 PASS（D4-03A gate 路径改为断言 tool_executions 存在且 0 行）。

## 31. D4-02 Regression
npm run test:d4-02c = 22/22 PASS；npm run test:d4-02b = 16/16 PASS；npm run test:d4-02a = 22/22 PASS。

## 32. D4-01 Regression
npm run test:d4-01 = 59/59 PASS。

## 33. Security
npm run test:security = FAIL 0 / PARTIAL 2 / PASS 6；security-surface（D2-02 A13）= 15/15 PASS（未新增 Renderer IPC）。npm test = PASS（0 failed）；npm run build = PASS。

## 34. Tests
tests/tool-execution-readonly.test.mjs（9）、tool-resource-read.test.mjs（6）、tool-resource-search.test.mjs（4）、tool-execution-cancel.test.mjs（7）、tool-execution-security.test.mjs（5）、tool-execution-migration.test.mjs（2）、tool-dsh-facade.test.mjs（3）、tool-dsh-e2e.test.mjs（1）、tool-dsh-security.test.mjs（14）、tool-dsh-cancel.test.mjs（4）、tool-dsh-lifecycle.test.mjs（2）；入口 experiments/d4-03b/run-all.mjs + npm run test:d4-03b = 57/57 PASS。

## 35. Files Changed
git diff --name-only b411651...HEAD 的真实输出：
electron/authorization-domain.cjs, electron/controlled-tool-proxy.cjs, electron/harness-adapter.cjs, electron/identity-store.cjs, electron/task-domain.cjs, electron/task-harness-orchestrator.cjs, electron/tool-adapters.cjs, electron/tool-domain.cjs, electron/tool-registry.cjs, electron/tool-store.cjs, experiments/d4-03b/run-all.mjs, package.json, tests/device-migration.test.mjs, tests/fixtures/harness-acp/tool-harness-fixture.mjs, tests/fixtures/harness-acp/tool-proposal-agent.mjs, tests/migration.test.mjs, tests/resource-index-migration.test.mjs, tests/resource-library-migration.test.mjs, tests/resource-migration.test.mjs, tests/task-orchestration-migration.test.mjs, tests/task-store.test.mjs, tests/tool-execution-cancel.test.mjs, tests/tool-execution-migration.test.mjs, tests/tool-execution-readonly.test.mjs, tests/tool-execution-security.test.mjs, tests/tool-gate-security.test.mjs, tests/tool-migration.test.mjs, tests/tool-resource-read.test.mjs, tests/tool-resource-search.test.mjs。
文档：docs/decisions/D4-03B-readonly-execution.md、docs/decisions/D4-03-controlled-tool-proxy.md、docs/D4-03B-RESULT.md、PROGRESS.md。

## 36. Commits
- 5cfd367 D4-03: add controlled read-only tool execution
- ab5a3f7 test(D4-03): verify resource tool execution and revocation races
- docs(D4-03): record read-only execution boundary（本文件所在提交）
local HEAD == origin/feature/d4-03-tool-proxy；working tree clean；未 merge main。

## 37. Evidence
| 入口 | 结果 |
|---|---|
| npm run test:d4-03b | 57 / 57 PASS |
| schema | 12 |
| Registry tools | test.echo / test.write / resource.read.metadata / resource.search |
| npm run test:d4-03a | 32 / 32 PASS |
| npm run test:d4-02c | 22 / 22 PASS |
| npm run test:d4-02b | 16 / 16 PASS |
| npm run test:d4-02a | 22 / 22 PASS |
| npm run test:d4-01 | 59 / 59 PASS |
| npm test | PASS（0 failed） |
| npm run build | PASS |
| npm run test:security | FAIL 0 / PARTIAL 2 / PASS 6 |
| security-surface | 15 / 15 PASS |
| READ_ONLY real execution | resource.search + resource.read.metadata，real Domain，EXACT verification PASS |
| Domain call count | authorized exactly 1；unauthorized/revoked 0 |
| duplicate execution | 0 二次执行 |
| mutation | Resource version/updated_at/checksum/registry 数不变 |
| WRITE / MCP / Shell / Browser | 0 / 0 / 0 / 0 |
| official dsh read-tool E2E | **PASS**（见 docs/D4-03B-CLOSURE-RESULT.md） |

## 38. Remaining Gaps
OS-level network isolation = NOT VERIFIED；external workspace read audit = NOT VERIFIED；independent malformed ACP injection = NOT VERIFIED；Windows = NOT VERIFIED；External Provider = NOT VERIFIED；Explicit Resume = DEFERRED；official dsh read-tool E2E = **PASS**。上述 NOT VERIFIED 项不因 D4-03B 关闭。

## 39. D4-03C Admission
**D4-03C Side-effect Lease / Approval / Idempotency / Unknown Effect = CONDITIONAL GO**（人工开启后实施，本轮不开始）。D4-03C 才允许第一次 REVERSIBLE_WRITE，并处理 approval / lease / idempotency / side-effect call id / ambiguous result / no blind retry。
