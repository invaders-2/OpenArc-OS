# D4-03C1 Result

Task Status: **D4-03C1 Side-effect Authority / Approval / Lease Contract = PASS**（Proposal → Decision → Plan → Approval → Lease → Execution Eligibility 六层合同建立、持久化 schema v13、全部 Domain 测试 PASS）；**production WRITE execution = 0**；**D4-03C overall = PARTIAL**；**D4-03C2 Controlled Reversible Write = 下一阶段**。

## 1. Base
从 feature/d4-03-tool-proxy @ 809e8fa（local HEAD == origin == 809e8fa，working tree clean）继续；未 merge main。

## 2. SideEffectCall
OpenArc 生成 `callId`（scall_）、`idempotencyKey`（idem_）、`planHash`；持久化 side_effect_calls（UNIQUE(call_id) + UNIQUE(idempotency_key)）；状态机 PLANNED / AWAITING_APPROVAL / APPROVED / LEASED / RUNNING / SUCCEEDED / FAILED / CANCELLED / BLOCKED / UNKNOWN_EFFECT。C1 最多到 LEASED/ELIGIBLE。

## 3. Effect Classification
READ_ONLY 继续走 D4-03B（非 side effect）；REVERSIBLE_WRITE 为 C1 唯一研究对象；IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED → SIDE_EFFECT_EFFECT_CLASS_BLOCKED。

## 4. SideEffect Plan
adapter.plan() 只读生成 targets / preconditions / expectedEffects；expectedEffects 由 Domain state 决定，Harness rationale 只能参考。planHash = f(callId,toolId,version,argsHash,risk,targets,preconditions,expectedEffects)。

## 5. Approval Authority
ToolApproval 持久化（approval_id/call_id/actor/session/decision/plan_hash/approved_* /created_at/expires_at/revoked_at）。decision ∈ APPROVED/DENIED/REVOKED/EXPIRED。只来自 trusted user action；agent / ACP permission / model text / tool args 一律 APPROVAL_FORBIDDEN。

## 6. Approval Binding
绑定 callId/toolId/toolVersion/argumentsHash/effectClass/expectedEffects/planHash；任一改变 → PLAN_STALE / TOOL_VERSION_CHANGED。one call one approved effect（无通配）。

## 7. Approval Expiry / Revoke
默认 TTL 10 分钟（有限期）；过期 → APPROVAL_EXPIRED；revoke → APPROVAL_REVOKED；approval 不能盖过实时授权。

## 8. Lease Authority
SideEffectLease 持久化表示"当前只有 holder 有资格尝试该 side effect"，不是业务锁。状态 ACTIVE/RELEASED/EXPIRED/REVOKED。

## 9. Lease Concurrency
每 call 至多 1 个 ACTIVE；同 holder 重复 acquire 幂等；不同 holder → SIDE_EFFECT_LEASE_CONFLICT；check+insert 在同一 transactSync 内原子。

## 10. Lease Restart Semantics
lease 带 holder + holder_instance_id；recoverOnStartup 将非本进程 ACTIVE lease → EXPIRED；旧 execution ownership 不可继承，必须重新 acquire。

## 11. Idempotency
每个 call 有 OpenArc 生成的 idempotencyKey（绑定 callId/tool/version/argsHash/target refs）；同 key 不同 args → SIDE_EFFECT_IDEMPOTENCY_CONFLICT；同 call 重复只返回当前 authority 状态；新 proposal 语义相同不自动合并。

## 12. Execution Eligibility
纯 Domain `evaluateExecutionEligibility` 逐 gate：call → task/session/app → step/run → tool contract（含 verificationStrategy）→ reauthorization → plan/args → approval → lease → preconditions。输出 ELIGIBLE / DENIED / APPROVAL_REQUIRED / LEASE_REQUIRED / STALE / BLOCKED + 安全 reasonCode；最多 ELIGIBLE，绝不执行。

## 13. Preconditions
只存 safe refs + version/hash；target version 变化 → SIDE_EFFECT_PRECONDITION_CHANGED；必须重新 proposal/approval。

## 14. Reauthorization
eligibility 每次实时读取 AuthorizationService；session revoke / app disable / tool grant revoke / useByAgent 缺失 → AUTHORIZATION_REVOKED 或 APP_DISABLED；approval 不能代替实时授权。

## 15. Task Cancel
approval + lease 都存在时 cancelTask → eligibility TASK_CANCELLED。

## 16. Stale Run
新 run 出现后旧 call → SIDE_EFFECT_STALE_RUN。

## 17. Tool Version Change
Registry 出现 v2 后旧 v1 call → SIDE_EFFECT_TOOL_VERSION_CHANGED；Tool disabled → SIDE_EFFECT_TOOL_DISABLED。

## 18. Plan Change
execution 携带不同 arguments hash → SIDE_EFFECT_PLAN_STALE；手工插入 plan_hash 不匹配的 approval → PLAN_STALE。

## 19. Unknown Effect
状态语义冻结：仅"已发出但无法可靠判断是否发生"时进入；≠ FAILED；永不自动 retry。

## 20. Crash Recovery
RUNNING + process crash → UNKNOWN_EFFECT（不是 FAILED/PLANNED/RUNNING）+ tool.side_effect.unknown_effect event；0 respawn / 0 replay；旧 lease EXPIRED。

## 21. Verification Contract
write contract 必须有 verificationStrategy，否则 SIDE_EFFECT_VERIFICATION_UNAVAILABLE；verifyUnknownEffect 接口保留，无 verifier → VERIFICATION_NOT_AVAILABLE 且保持 BLOCKED。

## 22. Harness Spoof Protection
arguments 中 approved/approvalId/leaseId/callId/idempotencyKey/effectClass/expectedEffects 一律 TOOL_ARGUMENT_INVALID 或忽略；不能改变 authority。

## 23. WRITE Execution Boundary
executeReadOnly 与 executeSideEffect 对非 READ_ONLY 一律 WRITE_EXECUTION_DISABLED；mutationCount = 0；0 tool_executions。

## 24. Audit
authorization_audit 记录 side_effect.planned / approval_requested / approved / denied / approval_revoked / lease_acquired / lease_released / blocked / unknown_effect；只存安全投影，不是 execution authority。

## 25. Task Events
tool.side_effect.planned / tool.approval_required / tool.approved / tool.denied / tool.lease_acquired / tool.execution_eligible / tool.execution_blocked / tool.side_effect.unknown_effect。

## 26. Secret Scan
side_effect_calls / tool_approvals / side_effect_leases / TaskEvent / Audit / tool DB 扫描：Provider Secret 0 hit、mpx_ 0 hit、tpx_ 0 forbidden persistence、绝对路径/store root 0 hit、raw Authorization 0 hit。

## 27. Migration
SCHEMA_VERSION = 13；v1→current…v12→current 与 v13 级失败整级回滚 PASS；旧迁移测试同步更新为 v13。

## 28. D4-03B Regression
npm run test:d4-03b = **59/59 PASS**（READ_ONLY 执行链不受影响）。

## 29. D4-03A Regression
npm run test:d4-03a = **32/32 PASS**。

## 30. D4-02 Regression
npm run test:d4-02a = **22/22**；test:d4-02b = **16/16**；test:d4-02c = **22/22** PASS。

## 31. D4-01 Regression
npm run test:d4-01 = **59/59 PASS**。

## 32. Security
npm run test:security = **FAIL 0 / PARTIAL 2 / PASS 6**；npm test = **719/719 PASS**；npm run build = **PASS**；未新增 Renderer IPC。

## 33. Tests
新增 tests/side-effect-domain.test.mjs、side-effect-approval.test.mjs、side-effect-lease.test.mjs、side-effect-idempotency.test.mjs、side-effect-recovery.test.mjs、side-effect-security.test.mjs、side-effect-migration.test.mjs；夹具 tests/fixtures/harness-acp/side-effect-fixture.mjs；标准入口 npm run test:d4-03c1 = 46/46。

## 34. Files Changed
`git diff --name-only 809e8fa...HEAD` 真实输出：
```text
PROGRESS.md
docs/D4-03C1-RESULT.md
docs/decisions/D4-03-controlled-tool-proxy.md
docs/decisions/D4-03C-side-effect-authority.md
electron/identity-store.cjs
electron/side-effect-authority.cjs
electron/side-effect-domain.cjs
electron/side-effect-store.cjs
electron/task-domain.cjs
electron/tool-adapters.cjs
electron/tool-registry.cjs
experiments/d4-03c1/run-all.mjs
package.json
tests/device-migration.test.mjs
tests/fixtures/harness-acp/side-effect-fixture.mjs
tests/fixtures/harness-acp/tool-harness-fixture.mjs
tests/migration.test.mjs
tests/resource-index-migration.test.mjs
tests/resource-library-migration.test.mjs
tests/resource-migration.test.mjs
tests/side-effect-approval.test.mjs
tests/side-effect-domain.test.mjs
tests/side-effect-idempotency.test.mjs
tests/side-effect-lease.test.mjs
tests/side-effect-migration.test.mjs
tests/side-effect-recovery.test.mjs
tests/side-effect-security.test.mjs
tests/task-orchestration-migration.test.mjs
tests/task-store.test.mjs
tests/tool-execution-migration.test.mjs
tests/tool-migration.test.mjs
```

## 35. Commits
```text
D4-03: add side-effect approval and lease authority
test(D4-03): verify side-effect recovery and idempotency boundary
docs(D4-03): freeze side-effect authority contract
```
local HEAD == origin/feature/d4-03-tool-proxy（push 后）；working tree clean；未 merge main。

## 36. Evidence
| 入口 | 结果 |
|---|---|
| test:d4-03c1 | 46 / 46 PASS |
| schema | 13 |
| Approval binding / expiry / revoke | PASS |
| Lease 唯一 ACTIVE / 并发 / restart | PASS |
| Idempotency binding | PASS |
| Execution Eligibility（reauthorization / cancel / stale run / version / plan / precondition） | PASS |
| UNKNOWN_EFFECT（RUNNING-after-crash） / 0 auto retry | PASS |
| Harness spoof / WRITE boundary | PASS |
| Secret scan / migration | PASS |
| D4-03B / D4-03A / D4-02 / D4-01 regression | PASS |
| npm test / build / security | PASS / PASS / FAIL 0 |

## 37. Remaining Gaps
OS-level network sandbox、external workspace read audit、malformed ACP independent injection、Windows、External Provider 全部 NOT VERIFIED；Explicit Resume = DEFERRED；**Final Approval UI = NOT IMPLEMENTED**（本阶段只有 Domain）；**official dsh 发起 test.write → WAITING 的 official-dsh 变体 NOT VERIFIED**（C1 facade manifest 仅 READ_ONLY；Harness 门由 synthetic official-ACP 路径 + test:d4-03a 覆盖）。不因 C1 关闭。

## 38. D4-03C2 Admission
**D4-03C2 Controlled Reversible Write**：才第一次允许真实 REVERSIBLE_WRITE，必须走 Proposal → Decision → Plan → Approval → Lease → Execute exactly once → Verify → Release，并遵守业务 Domain 的 version/lock。D4-03C overall 在 C2 完成前保持 PARTIAL。本轮到此停止，未进入 C2 / real WRITE / MCP / Shell / Browser / Canvas / App Center。
