# D4-03C1 · Side-effect Authority / Approval / Lease Contract（macOS）

- **状态**：**D4-03C1 = PASS candidate**（合同 + fail-safe recovery + 真实 contention / persisted restart）；**D4-03C2 = PASS candidate**（1 条受控真实 REVERSIBLE_WRITE：resource.trash，待 ChatGPT 审计）；**D4-03C overall = PARTIAL**；**D4-03C3 = 未开始**
- **分支**：feature/d4-03-tool-proxy，基线 809e8fa，未 merge main
- **日期**：2026-09-15

## 核心原则（永久冻结）

```
ToolDecision = ALLOWED
!= Approval
!= Lease
!= Execution
!= Verified Effect
```

五层 authority 彻底分开。**Harness proposes. OpenArc decides. OpenArc executes. OpenArc verifies.** D4-03C1 production WRITE execution = 0；D4-03C2 只开放**一条**受控真实 REVERSIBLE_WRITE（resource.trash → ResourceService.delete），不扩大成通用 WRITE Runtime。

## 六层合同

```
Proposal → Decision → Plan → Approval → Lease → Execution Eligibility
```

- **Proposal / Decision / Plan**：D4-03A/B 已有；C1 为 write proposal 增加 `SideEffectPlan`（adapter.plan 只读生成 targets/preconditions/expectedEffects）。
- **Approval**：只来自 trusted OpenArc user action；绑定 callId/toolId/toolVersion/argumentsHash/effectClass/expectedEffects/planHash；有限期（默认 10 分钟）；可 revoke。
- **Lease**：side-effect 执行资格，不是业务锁；每 call 至多一个 ACTIVE；绑定 holderId + runtime instance id；有限期（默认 60 秒）。
- **Execution Eligibility**：纯 Domain `evaluateExecutionEligibility`，逐 gate 判定，最多返回 ELIGIBLE，**绝不执行**。

## SideEffectCall

OpenArc 生成 `callId`（`scall_`）、`idempotencyKey`（`idem_`）、`planHash`；`UNIQUE(call_id)` + `UNIQUE(idempotency_key)`。状态机：PLANNED / AWAITING_APPROVAL / APPROVED / LEASED / RUNNING / SUCCEEDED / FAILED / CANCELLED / BLOCKED / UNKNOWN_EFFECT。C1 最多到 LEASED/ELIGIBLE；C2 对 resource.trash 可走到 SUCCEEDED（必须先 claim RUNNING + verifier PASS）。

## effectClass

READ_ONLY 继续走 D4-03B（不是 side effect）。C1 只研究 REVERSIBLE_WRITE；IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED 一律 `SIDE_EFFECT_EFFECT_CLASS_BLOCKED`。

## Approval ≠ Lease

有 Approval 无 Lease 不能执行；有 Lease 但 Approval 过期/撤销不能执行。`acquireLease` 前重新校验 approval（decision/planHash/argsHash/tool/version/expiry/revoke）。

## Idempotency

同一 `idempotencyKey` 只能绑定同一 binding（callId/tool/version/argsHash/target refs）；不同 args → `SIDE_EFFECT_IDEMPOTENCY_CONFLICT`。新 proposal 语义相同 write 不自动合并，仍按新 call（§28）。

## Preconditions

SideEffectCall 只存 `preconditions_safe`（resourceRef/expectedVersion/expectedHash/targetRef…），绝不复制业务对象。target version 变化 → `SIDE_EFFECT_PRECONDITION_CHANGED`，必须重新 proposal/approval。

## Unknown Effect

仅当执行已发出但无法可靠判断是否发生时进入。`UNKNOWN_EFFECT` 永不自动 retry；`RUNNING` + crash → `UNKNOWN_EFFECT`（不是 FAILED）。`verifyUnknownEffect` 接口保留；无 verifier → `VERIFICATION_NOT_AVAILABLE` 且保持 BLOCKED。

## Restart semantics（fail closed）

Approval/Lease 都持久化。`recoverOnStartup()` 是 fail-safe contract：**没有 production 开关**（旧 `blockTask` 参数已删除）。发现 `RUNNING` call 时无条件：
1. SideEffectCall → `UNKNOWN_EFFECT`（绝不回退 LEASED/APPROVED/FAILED）；
2. 通过 Task Authority `TaskService.recoverRunning()` 将 Step/Task → `BLOCKED`（RECOVERY_REQUIRED）+ event；
3. 非本进程 ACTIVE lease → `EXPIRED`（execution ownership 不可继承）。

若 TaskService/Task/Step 不可用或无法安全 block → 记录安全事件、保持 UNKNOWN_EFFECT、fail closed；不得 replay / retry / respawn。真实 persisted restart（关闭 DB handle、Runtime B 新 instanceId 重开同一 disk DB）已验证 0 replay / 0 retry / 0 execution。

## Lease contention（真实）

两个独立 child executor（独立 DB connection / 独立 instanceId）通过 barrier 同时 `acquireLease` 同一 APPROVED call：check+insert 在同一 `BEGIN IMMEDIATE` 事务内，结果恰好 1 ACTIVE / 1 success / 1 `SIDE_EFFECT_LEASE_CONFLICT`；SQLite contention 收敛为安全业务语义，不暴露裸 `SQLITE_BUSY`。

## Production WRITE tool（D4-03C2）

本阶段唯一 production write tool：`resource.trash` v1，riskClass = REVERSIBLE_WRITE，executionProvider = ResourceService，resourceActions = [`resource.delete`]，requiredPermissions = [`tool.resource.trash`]，verificationStrategy = READ_AFTER_WRITE，idempotencySupport = true，executionPolicy = **CONTROLLED_REVERSIBLE_WRITE**。输入只允许 `resourceRef`；`expectedVersion` / expectedEffects 由 adapter.plan() 从真实 Domain state 生成。真实 mutation 只能经 **ResourceService.delete()**，绝不直接 SQL。

## Execution claim（exactly once）

`executeSideEffect` 先同步完成全部 gate（tool/version、eligibility、lease holder、leaseId），再在**一个 BEGIN IMMEDIATE 事务内**原子 claim `LEASED → RUNNING`——只有唯一 claim 成功的 executor 能 dispatch Domain mutation。未进入 RUNNING 前，approval revoke / lease revoke / task cancel / permission revoke / tool disable / version change / precondition change 全部阻止执行。

## Verification（Execution != Verified Effect）

dispatch 后必须调用真实 Domain verifier（重新读取 Resource Domain，`trashed == true`）：
- verifier PASS → `RUNNING → SUCCEEDED`，`verificationStatus = PASS`，lease `RELEASED`；
- Domain 明确 known no-effect / version conflict / precondition changed → `FAILED`（0 retry），lease RELEASED；
- exception / timeout / verifier unavailable / 无法判断 → `UNKNOWN_EFFECT`，lease `REVOKED`，Step/Task → BLOCKED，绝不 retry。

## Business optimistic concurrency

Lease ≠ business lock。`ResourceService.delete({ expectedVersion })` 在**真实 mutation transaction 内**重新读取并校验 resource 存在 / version == expectedVersion / 当前 active，不匹配即 `VERSION_CONFLICT`（映射为 `SIDE_EFFECT_PRECONDITION_CHANGED`），0 mutation / 0 retry，无 TOCTOU。

## Reversibility

`resource.trash` 是 REVERSIBLE_WRITE，用真实 `ResourceService.restore()` 证明效果可恢复；**restore proof ≠ AI 获得绕过 SideEffect Authority 的 production restore 权限**，本阶段不开放 `resource.restore` Tool。

## WRITE execution boundary

只有声明 `executionPolicy = CONTROLLED_REVERSIBLE_WRITE` 的 contract 可执行；其余 write contract（`test.write` / `test.noverify` 等）仍 `WRITE_EXECUTION_DISABLED`，`executeReadOnly` 遇 write 一律 `WRITE_EXECUTION_DISABLED`，mutationCount = 0。IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED / Shell / Terminal / filesystem generic mutation / MCP / Browser automation / Device Agent / Canvas / App Center mutation 全部 BLOCKED。

## Persistence（schema v13）

`side_effect_calls` / `tool_approvals` / `side_effect_leases`。只存 safe refs + hash + 状态机；禁止 credential / proxy capability / tool facade capability / raw Authorization / full unsafe payload。

## Audit / Task Events

Audit：`side_effect.planned / approval_requested / approved / denied / approval_revoked / lease_acquired / lease_released / lease_revoked / blocked / unknown_effect / execution_started / verification_passed / verification_failed / succeeded`。TaskEvent：`tool.side_effect.planned / tool.approval_required / tool.approved / tool.denied / tool.lease_acquired / tool.execution_eligible / tool.execution_blocked / tool.side_effect.unknown_effect / tool.side_effect.execution_started / tool.side_effect.verification_passed / tool.side_effect.succeeded`。只存安全投影，无 raw arguments / content / secret / credential / capability / 绝对路径。Audit **不是** execution authority；SideEffectCall 仍是唯一 authoritative execution state（不建第二套真值）。

## 冻结

1. callId / idempotencyKey / effectClass / expectedEffects 只由 OpenArc 生成；Harness 同名字段无效或 INVALID。
2. Approval 只来自 trusted user；Harness / ACP permission / model text / tool args 都无权。
3. Approval 与 Lease 独立；都要实时 reauthorization。
4. Lease 是执行资格，不取代业务 Domain 的 version/lock/optimistic concurrency。
5. write tool 必须有 verificationStrategy；否则 `SIDE_EFFECT_VERIFICATION_UNAVAILABLE`。
6. UNKNOWN_EFFECT → VERIFY → BLOCK；禁止 retry。
7. 人工 UI 与 Agent 复用同一侧 Domain 命令，不为 AI 建后门。

## 下一步

`D4-03C2` 已完成第一条受控真实 REVERSIBLE_WRITE。**`D4-03C3 Ambiguous Result / Idempotency / Crash Recovery` = 未开始**，由 ChatGPT 审计后决定，禁止自动进入；`D4-03D Full Tool Proxy Gate` 之后才 D4-04。
