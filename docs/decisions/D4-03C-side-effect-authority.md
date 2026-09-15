# D4-03C1 · Side-effect Authority / Approval / Lease Contract（macOS）

- **状态**：**D4-03C1 = PASS**、**D4-03C2 = PASS**（已由 ChatGPT 审计）；**D4-03C3 = PASS candidate**、**D4-03C3 Closure = PASS candidate**（Ambiguous Result / Idempotency / Crash Recovery + Trusted Quiescence Authority）；**D4-03C overall = PARTIAL**；**D4-03C4 = 未开始**
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

## Unknown Effect / Ambiguous Result（C3 生产合同）

仅当执行已发出但无法可靠判断是否发生时进入。`UNKNOWN_EFFECT` 永不自动 retry；`AUTO_RETRY = 0`（不因 `idempotencySupport = true` 就擅自重试）。`RUNNING` + crash → `UNKNOWN_EFFECT`（不是 FAILED）。

`verifyUnknownEffect()` 是**真实 production recovery path**（不再依赖 test-only verifier）：
```
SideEffectCall → exact historical Tool Contract（toolId + toolVersion + effectClass）
→ allowlisted adapter → read-only Domain verifier（mutation = 0）
```
三态 outcome：**APPLIED** / **NOT_APPLIED** / **INDETERMINATE**。`resource.trash` 用 `ResourceService` 只读 `sideEffectPrecondition` 判定。

- **APPLIED**（trashed = true + registryStatus = deleted）→ `UNKNOWN_EFFECT → SUCCEEDED`，`verificationStatus = PASS`，0 retry / 0 second Domain execution。
- **NOT_APPLIED** 只有在 **executionQuiesced = true**（OpenArc trusted fact）时才 → `FAILED` / `verificationStatus = FAIL`。
- **INDETERMINATE**（resource missing / version changed / state 矛盾 / read failed / verifier unavailable）→ 保持 `UNKNOWN_EFFECT`，不猜。

**Late Result / Timeout Rule**：`"现在没看到 effect" != "effect 永远不会发生"`。live timeout（同 runtime）时 `quiesced = false`，即使 verifier 看到 NOT_APPLIED 也保持 UNKNOWN_EFFECT；只有 **trusted Runtime Quiescence Authority** 真实观测到 origin runtime 进程退出，才认定 quiesced（见下）。verification 只读，绝不 `execute / retry / restore / delete / repair`，也绝不受当前 session / app / tool disabled 影响（exact historical contract lookup）。Tool disabled ≠ verification disabled。

## Trusted Quiescence Authority（C3 Closure final seal）

永久规则：**different runtime instance != proof that the previous runtime is dead**。

`RuntimeLifecycleAuthority`（trusted，supervisor-level）是唯一能回答
`"Can an operation owned by <previousRuntimeInstanceId> still produce a late effect?"` 的组件。
它只在**真实观测到进程退出**（waitpid / child `exit`）后写 `status = EXITED`；`isQuiesced()` 只对 EXITED 返回 true。

- `quiesced` 只能来自该 Authority 的 proof；**禁止**由 Harness / ACP / Model / Tool args / Renderer / IPC / ordinary caller / `holderId` / different instanceId / 旧 lease EXPIRED|REVOKED|RELEASED / time elapsed 单独推导。
- ***Lease state is not liveness proof***；***Runtime instance mismatch is not liveness proof***。
- fail closed：无法确认旧 runtime 是否仍活着 → `quiesced = false` → 保持 UNKNOWN_EFFECT / Task BLOCKED / Step BLOCKED，绝不为了让状态“好看”而收敛成 FAILED。
- live UNKNOWN_EFFECT 持久化 safe runtime attribution：`originRuntimeInstanceId + originLeaseId + source(live_timeout|live_ambiguous) + recordedAt`。
- `recoverOnStartup()` 额外 reconcile 已持久化的 `UNKNOWN_EFFECT(quiesced=false)`：只有 trusted proof 成立时，才升级 non-authoritative `recovery_safe.quiesced = true`（`source = cold_restart_confirmed`），**Call 状态仍保持 UNKNOWN_EFFECT**。它只回答"旧 execution 是否还可能 late-arrive"，绝不推断 APPLIED / NOT_APPLIED。
- **Multiple live runtime safety**：Runtime A 仍 live 时，Runtime B 的 recovery 不得声明 quiesced，也不得把早到的 NOT_APPLIED 收敛成 FAILED；A 的 late mutation 到达后仍可 APPLIED → SUCCEEDED。
- APPLIED 不依赖 quiescence：只要 read-only verifier 可靠看到 desired effect 已存在，即允许 `UNKNOWN_EFFECT → SUCCEEDED`。
- `AUTO_RETRY = 0`；不因 NOT_APPLIED / cold restart / runtime death proof 而 retry 或自动重新 acquire lease。

UNKNOWN_EFFECT 不能 `acquireLease` / `executeSideEffect`；recovery 收敛后 Task/Step **保持 BLOCKED**（Explicit Resume = DEFERRED，禁止自动 resume/restart/rerun）。

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

## Execution ownership（mandatory，runtime-owned）

`ACTIVE Lease ownership = callId + exact leaseId + holderId + runtime instance (SideEffectAuthority.instanceId)`。

- **runtime identity 是 OpenArc 自身事实**：production `executeSideEffect({ callId, leaseId, holderId })` 不再接受 caller 提供的 `holderInstanceId`（即使传入也**完全忽略**）；判断一律为 `lease.holderInstanceId === this.instanceId`。调用方无法声明"我是哪个 runtime"，跨进程 Runtime B 即使知道 `instA` 字符串也不能伪装。
- `acquireLease` 同样把 lease 绑定到 `this.instanceId`（后续 Closure-3 已彻底删除任何 test-only runtime override，见下）。
- 缺少 callId / leaseId / holderId → `SIDE_EFFECT_LEASE_NOT_HELD` / 0 Domain invocation。
- eligibility 的 lease snapshot 带 `lease_id + call_id + holder_id + holder_instance_id + expires_at`，同时校验 exact leaseId + holder + runtime instance。

## Runtime identity surface（Closure-3 final seal）

`Runtime Identity = SideEffectAuthority.instanceId` 覆盖 Lease acquire / Execution eligibility / Execution claim / Startup recovery / Lease recovery，**零 caller override**：

- `acquireLease({ context, callId, holderId, ttlMs })`：不再有 `_testInstanceId`；lease 永远 `holderInstanceId = this.instanceId`。需要"别的 runtime 拥有 lease"时，测试必须 `new SideEffectAuthority({ instanceId })`（§5），不新增任何 `instanceIdOverride / runtimeIdOverride` 参数。
- `acquireLease` duplicate 语义：`holderId === holderId **AND** holderInstanceId === this.instanceId` 才是 duplicate；**同 holderId 不同 runtime instance → `SIDE_EFFECT_LEASE_CONFLICT`**，绝不返回 duplicate。
- `recoverOnStartup()`：不再接受 `instanceId` 参数，内部只用 `this.instanceId`。当前 runtime 自己的 ACTIVE lease 保留；其它 instance 的 lease 一律 `EXPIRED`（真实 restart 必然是新 runtime → 旧 lease 必 EXPIRED）。
- Authority `evaluateExecutionEligibility({ callId, leaseId, holderId })`：runtime identity 由 Authority 注入（`this.instanceId`），普通 caller 不能自报当前 runtime；底层纯函数 `side-effect-domain.evaluateExecutionEligibility(snapshot)` 仍接收 `holder_instance_id`（纯 snapshot evaluator）。

## Execution claim（exactly once + TOCTOU-safe）

`executeSideEffect` 先同步完成 gate（tool/version、eligibility、exact leaseId + holder + runtime instance），再在**一个 BEGIN IMMEDIATE 事务内**重新读取 persisted authority state（Task RUNNING/未 cancel、Step RUNNING、run 仍 current、session/auth 有效、app enabled、tool permission + resource permission/useByAgent 有效、Approval 有效、**exact Lease ACTIVE + expectedLeaseId + holder + runtime instance 匹配**、precondition/version 未变）并**原子 claim** `LEASED → RUNNING`——只有唯一 claim 成功者能 dispatch Domain mutation。

- **exact leaseId 是 claim authority**：即使同一 holderId + 同一 runtime，只要 ACTIVE lease 已换成 `lease_B`，携带 `lease_A` 的旧 invocation 一律 `SIDE_EFFECT_LEASE_NOT_HELD`；只有携带 `lease_B` 且重新通过完整 gate 的全新 invocation 才可执行。
- **claim-time approval binding 不得比 Eligibility 更弱**：planHash / argumentsHash / toolId / toolVersion / effectClass / decision / expiry / revoke 全部精确匹配。
- `Eligibility snapshot != execution authority forever`；跨连接 SQLite contention 收敛为 `SIDE_EFFECT_EXECUTION_CLAIM_LOST`，不暴露可 retry 语义。

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

## Persistence（schema v14）

`side_effect_calls` / `tool_approvals` / `side_effect_leases`。只存 safe refs + hash + 状态机；禁止 credential / proxy capability / tool facade capability / raw Authorization / full unsafe payload。

v14（D4-03C3）新增 **non-authoritative** `side_effect_calls.recovery_safe`（JSON）：保存 `{ outcome, reason, quiesced, verifiedAt, resourceRef, expectedVersion, currentVersion }` 安全投影。**最终状态仍由 `status` 决定**；未新增第二套 execution/retry authority。

## Audit / Task Events

Audit：`side_effect.planned / approval_requested / approved / denied / approval_revoked / lease_acquired / lease_released / lease_revoked / blocked / unknown_effect / execution_started / verification_passed / verification_failed / succeeded / verification_started / verification_applied / verification_not_applied / verification_indeterminate / recovery_resolved`。TaskEvent：`tool.side_effect.planned / tool.approval_required / tool.approved / tool.denied / tool.lease_acquired / tool.execution_eligible / tool.execution_blocked / tool.side_effect.unknown_effect / tool.side_effect.execution_started / tool.side_effect.verification_passed / tool.side_effect.succeeded / tool.side_effect.verification_started / tool.side_effect.verification_applied / tool.side_effect.verification_not_applied / tool.side_effect.verification_indeterminate / tool.side_effect.recovery_resolved`。只存安全投影，无 raw arguments / content / secret / credential / capability / 绝对路径。Audit **不是** execution authority；SideEffectCall 仍是唯一 authoritative execution state（不建第二套真值）。

## 冻结

1. callId / idempotencyKey / effectClass / expectedEffects 只由 OpenArc 生成；Harness 同名字段无效或 INVALID。
2. Approval 只来自 trusted user；Harness / ACP permission / model text / tool args 都无权。
3. Approval 与 Lease 独立；都要实时 reauthorization。
4. Lease 是执行资格，不取代业务 Domain 的 version/lock/optimistic concurrency。
5. write tool 必须有 verificationStrategy；否则 `SIDE_EFFECT_VERIFICATION_UNAVAILABLE`。
6. UNKNOWN_EFFECT → VERIFY → BLOCK；禁止 retry。
7. 人工 UI 与 Agent 复用同一侧 Domain 命令，不为 AI 建后门。

## 下一步（D4-03C3 时点）

`D4-03C3` 已建立真实 ambiguous-result / crash recovery / idempotency 收敛，并由 trusted Runtime Quiescence Authority 保证"不同 runtime instance 不等于已死证明"。

## D4-03C4 · Production Side-effect Runtime / Trusted Approval / Official dsh WRITE

C4 不发明新的 side-effect architecture，只把 C1 Authority + C2 Controlled Write + C3 Ambiguous Recovery
收敛成一条**真实、不可绕过**的 production contract：

\`\`\`
official dsh → Harness Tool Proposal → OpenArc Tool Registry → Schema Validation
→ Authorization → Risk Classification → SideEffectPlan → AWAITING_APPROVAL
→ Trusted OpenArc User Approval → SideEffectLease → Execution Claim
→ 受监督 Executor Runtime 执行 exactly once → Verification → Safe Tool Result → dsh 继续
\`\`\`

### 唯一 production 装配（§5）

新增 \`electron/side-effect-runtime.cjs\`（\`SideEffectRuntime\`）+ \`electron/task-bootstrap.cjs\` 装配：
ToolRegistry → ControlledToolProxy → SideEffectAuthority → RuntimeSupervisor → SideEffectRuntime。
不新增第二套 Task / permission / approval / Resource ACL / execution state machine。

### 谁真正拥有 resource.trash execution（§8）

**受监督的 executor runtime 子进程**（\`electron/side-effect-executor.cjs\`）。
主进程从不 in-process 执行 write：

- \`acquireLease\` + \`executeSideEffect\`（claim \`LEASED → RUNNING\`）+ 真实 \`ResourceService.delete\` + 真实 Domain verification **全部发生在 executor runtime**；
- 主进程只做：plan / approve / spawn / 读取收敛结果 / read-only recovery verification；
- 因此 mutation **真实归属于该 executor 的 lifetime**。

### Trusted Supervisor 与 liveness proof 模型（§6 / §7 / §31 / §32）

\`electron/runtime-supervisor.cjs\`（\`RuntimeSupervisor\`）是**唯一**调用
\`RuntimeLifecycleAuthority.registerRuntime / observeExit\` 的 production 代码：

1. **同一 supervisor lifetime**：真实 \`child.on("exit")\` → 自动 \`observeExit\`（测试不得自行调用）；
2. **cross-restart**：每个 executor runtime 在自己的整个生命周期内独占 bind
   \`<runtimeDir>/executors/<instanceId>.sock\`；cold restart 后新 supervisor 用 **OS-backed
   liveness probe** 重新判定（tri-state ALIVE / DEFINITELY_GONE / UNKNOWN，见下方
   "Tri-state liveness probe（D4-03C4 Closure · 永久）"）。
   **绝不使用内存中的旧 authority 自我证明。**

精度纠正：\`RuntimeLifecycleAuthority.isQuiesced()\` 本身只返回 \`UNKNOWN→false / ACTIVE→false / EXITED→true\`；
\`SELF_RUNTIME_ACTIVE\` 是 \`SideEffectAuthority.#quiescenceProof()\` 层的额外保护，不是 authority 自身语义。

\`observeExit\` / \`registerRuntime\` 不导出给 Renderer / IPC / ACP / Harness / Tool Facade；
\`SideEffectAuthority.lifecycle\` 只拿到 supervisor 的 \`{ isQuiesced }\` 面。

### Tri-state liveness probe（D4-03C4 Closure · 永久）

**Probe failure is not death proof.**

Socket liveness probe 永远是三态，禁止退化成 boolean：

| probe 结果 | 分类 | 后果 |
|---|---|---|
| connect() 成功 | ALIVE | runtime ACTIVE；绝不 quiesced |
| ENOENT | DEFINITELY_GONE | **唯一**允许 observeExit() / trusted quiescence 的结果 |
| timeout | UNKNOWN | 不 observeExit；quiesced=false |
| EACCES / EMFILE / ENFILE / ENOBUFS / ENOMEM | UNKNOWN | 不 observeExit；quiesced=false |
| ECONNREFUSED | UNKNOWN | 不 observeExit；quiesced=false |
| 任意其它 errno / 无 code | UNKNOWN | 不 observeExit；quiesced=false |
| probe 自身抛异常 / 返回不可信形态（含旧 boolean） | UNKNOWN | 不 observeExit；quiesced=false |

为什么 ECONNREFUSED 不是 DEFINITELY_GONE：在 Unix domain socket 上无法跨平台证明它不是
timeout / backlog / 权限 / 资源耗尽的别名，因此按"安全优先、不追求自动 recovery 成功率"
一律 fail closed。白名单 DEFINITELY_GONE_ERRNOS 当前只含 ENOENT，匹配必须显式，默认分支必须是 UNKNOWN。

后果（有意接受）：被 SIGKILL 的 executor 会留下 stale socket 文件 → 新 runtime 的 probe 为 UNKNOWN →
该 UNKNOWN_EFFECT 不会被判成 FAILED，而是保持 UNKNOWN_EFFECT + Task/Step BLOCKED；只有 APPLIED
（authoritative read-only Domain verifier 可靠观察到 desired effect）才允许
UNKNOWN_EFFECT → SUCCEEDED，且该路径不依赖 quiescence。

rehydrate() 的 tri-state 契约：

    ALIVE           → register ACTIVE；alive++
    DEFINITELY_GONE → register ACTIVE；trusted observeExit；dead++
    UNKNOWN         → register ACTIVE；no observeExit；unknown++（persisted record 保持 ACTIVE）

UNKNOWN 必须单独计数，不得归入 dead；persisted executor record 不得被改写成 EXITED /
OS_EXECUTOR_ENDPOINT_ABSENT。UNKNOWN liveness 只记录 safe 事件
（runtime_liveness_unknown + instanceId + 归一化 reason），绝不记录绝对路径。

静态 + 动态 Gate：timeout callback 与任意 socket.on("error") 都不得调用 observeExit /
#observeExit（tests/side-effect-c4-closure.test.mjs 的 Static Gate 解析源码断言）。

### 两条写入路径显式分离（§11）

\`buildBridgeManifest\` 给每个 toolId 标注唯一 route（由 Tool Registry 的 riskClass 推导）：

- \`READ_ONLY\` → \`propose → reauthorize → executeReadOnly → verify\`；
- \`SIDE_EFFECT_PROPOSAL\` → \`propose → decision → SideEffectPlan(AWAITING_APPROVAL)\`，
  **立即返回 \`SIDE_EFFECT_APPROVAL_REQUIRED\`，0 mutation / 0 lease / 0 execution**。

\`buildWriteToolManifest\` 只接受 \`riskClass === REVERSIBLE_WRITE\` 且
\`executionPolicy === CONTROLLED_REVERSIBLE_WRITE\` 的 contract。WRITE 不经过 READ_ONLY execution route。

### Trusted Approval Gateway（§13 / §43 / §44 / §45）

\`electron/side-effect-bootstrap.cjs\`：唯一 \`sideeffect:command\` 通道。

- Renderer 只能发送 \`{ type, approvalRequestId, decision }\`；
- \`sessionRef\` 由 main process 从 IdentityService 当前 authenticated session 注入；
- \`userId / role / appId / risk / planHash / argumentsHash / effectClass\` Renderer 自报一律忽略；
- appId 由 SideEffectRuntime 从 call 绑定的真实 Task 反推；
- 快照只含 safe 投影，且只在同一 session 时返回。

### Approval UI（§14）

\`src/approval/ApprovalPrompt.tsx\` + preload \`sideEffect\` 桥：显示 App/Agent、Tool、Risk、Target、
Expected Effect、Precondition version，只提供 批准 / 拒绝。全部字段来自 Tool Registry + SideEffectPlan +
Resource Domain，**绝不展示也不相信 Harness 文案**。

### Harness 续接规则（§25 / §27 / §28）

只有**未经 UNKNOWN_EFFECT** 的 direct verified success 才允许把 safe tool result 交回同一个 dsh session。
一旦经过 UNKNOWN_EFFECT（含最终 APPLIED），\`executeApproved\` 返回 \`recovered=true\`，
Orchestrator 必须 BLOCK Step/Task，绝不自动续接 Harness（Explicit Resume = DEFERRED）。

### Harness 单次 propose（§12 / §19 / §35）

Orchestrator 用 \`SideEffectRuntime.sideEffectCallsOfStep()\`（任何状态）判断"这一轮是否产生过 write proposal"，
而不是只看 pending —— 否则 turn 期间已被 Deny / timeout / crash 收敛的 call 会被漏掉，
导致 unverified 结果被当成功提交。同一 step + tool/version + argumentsHash 的重复送达
收敛为同一条 SideEffectCall（\`side_effect.duplicate_delivery\`）。

### Concurrent approval / executor（§36 / §37）

- 同一绑定下重复 Approve 幂等（\`duplicate: true\`），只产生一个 authoritative approval transition；
- 同一条 call 的第二个 executor 抢不到 execution authority（\`LEASE_CONFLICT\` / \`CALL_STATE\`），
  且 **loser 绝不触碰 winner 的 lease**：只有本 runtime 自己 spawn 的 executor instance 才允许对
  该 call 做 \`recoverAfterExecutorExit\` 收敛（\`SIDE_EFFECT_EXECUTION_CLAIM_LOST\`）。

### 重启语义（§53 – §56）

\`SideEffectRuntime.recoverOnStartup()\` = 既有 authority recovery + pending（\`AWAITING_APPROVAL / APPROVED / LEASED\`）
在 Task 已非 RUNNING 时一律明确 \`BLOCKED\`（\`SIDE_EFFECT_APPROVAL_ABANDONED\`）。
**绝不自动 approve / lease / execute / replay / 重启 dsh。**

### 边界不变

WRITE surface 仍只有 \`resource.trash\`；\`AUTO_RETRY = 0\`；IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT /
PRIVILEGED / Shell / Terminal / filesystem generic mutation / MCP / Browser automation / Device Agent /
Canvas mutation / App Center mutation / Adobe control 全部 BLOCKED。

## 下一步

\`D4-03C4 = PASS candidate\`（DeepSeek 无权封板，由 ChatGPT 审计后决定 \`D4-03C = PASS\`）。
**\`D4-03D\` = NOT STARTED**；禁止自动进入 D4-03D / D4-04 / D4-05 / D5 / D6。

