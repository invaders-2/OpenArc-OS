# D4-06 Closure · 结果记录（预算停止后的显式续接）

- Base HEAD（本轮起点）：`3a31754daea258639a521c60b0e2f2008dd55063`
- **被测 commit**（代码与测试提交）：`207f9462e03e204594be5dc6e313041afda8efdb`
- Final HEAD：本轮报告/证据提交（见文末）
- 分支：`feature/d4-03-tool-proxy`；工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`

## 1. 授权范围与结论

Boss 已批准**仅在本范围**解除 Explicit Resume 延期：**只允许用户主动续接“因 bounded 预算耗尽而停止、且不存在未决副作用”的任务**。其他 Explicit Resume 场景仍 `EXPLICIT_RESUME_DEFERRED`；不得借此恢复 UNKNOWN_EFFECT / 撤权 / 拒绝 / 取消 / 执行异常等停止。

**`D4-06 Closure = PASS`**；据此 **`D4-06 = PASS（限定当前验收范围）`**：A35（达到预算上限 → 停止自动循环 + 保留产物 + 明确续接入口）全部必需项满足。仅解除“预算耗尽 → 用户显式续接”一种；其余恢复场景与既有 `NOT VERIFIED` / `DEFERRED` 保持原状。

## 2. 后端设计（最小、fail-closed）

- **可辨识的预算停止**：新增 `ERROR.BUDGET_EXHAUSTED`；orchestrator 三类边界统一归类：
  - `MODEL_CALLS`：`adapter.prompt` 抛错且 Model Proxy capability 真实 `EXHAUSTED`（`HarnessAdapter.budgetExhausted()` 只读查 `modelProxy.capabilityState`）；
  - `TOOL_CALLS`：Tool Facade capability 真实 `EXHAUSTED`；
  - `TOOL_ROUNDS`：非 facade READ loop 第 4 轮后仍有 proposal（不再与 no-proxy gate 的 `TOOL_EXECUTION_NOT_AVAILABLE` 混用）；
  - 均写 `task.budget_exhausted{kind, consumed, maxCalls/maxRounds}` + run `error_code=BUDGET_EXHAUSTED`。
- **后端判定（不信 renderer）** `TaskService.getResumeEligibility`：真实 guard（actor/session/app enabled）+ owner/app 匹配 + `BLOCKED` + 无 STARTING/RUNNING run 与 RUNNING/PENDING step + **无 UNKNOWN_EFFECT call** + 无未决 side-effect call（AWAITING_APPROVAL/APPROVED/LEASED/RUNNING）+ 无 ACTIVE lease + 最后 run `error_code=BUDGET_EXHAUSTED` 且 kind 合法 + 有 committed Artifact + 续接次数 < 3。任一步不满足返回**显式** `RESUME_*` 原因。
- **原子追加预算** `grantBudgetResume`（单事务）：重新判定 → 写 `task.budget.granted{amount, operatorUserId, resumeIndex, kind, consumedAtGrant}` 账本 → 新建 `reasoning` step（input 只含 prior artifact 文本 + “do not re-issue”指令，**绝不含旧 tool 请求**）→ `BLOCKED→RUNNING`；`expectedRevision` + 状态守卫保证重复/并发只成功一次。
- **有界、保留历史**：`BUDGET_BASE = { MODEL_CALLS:8, TOOL_CALLS:8, TOOL_ROUNDS:4 }`；每次追加一个同类 bounded 额度；`MAX_BUDGET_RESUMES=3` 硬上界；账本只追加、绝不清零；`getBudgetLedger` 只读返回 base + additions + consumed（含每次 budgetStop 的真实 consumed）。
- **安全续接位置**：`orchestrator.resumeBudgetExhausted` 经 `getResumeEligibility` + `grantBudgetResume` + `startStep` + `runStep`（**新 run / 新 mpx_ & tpx_ capability**）；旧 step/call/artifact/verification/副作用全部保留；旧 capability 在 run finally 已 revoke，旧 approval/lease 因续接前置拒绝或在既有实时检查下 fail closed。无已提交 Artifact 时以 `RESUME_NO_SAFE_CONTINUATION` 拒绝（不盲目重放）。
- **IPC/UI**：`TASK_COMMANDS` 增加 `task/resume`；`task/get` 返回 `{resumable, stopReason, resumeReason, budgetLedger}`（主进程注入 sessionRef/appId，忽略 renderer 自报身份/预算/可续接状态）。AI 面板仅在 `resumable` 时渲染停止原因 / 本次追加预算 / 续接按钮（`data-ai-resume`），点击走 `task/resume`；非 resumable 不渲染入口；刷新由 `task/get` 恢复。

## 3. 验收 A–F（真实产品 orchestrator + deterministic provider + Electron UI）

| 项 | 预期 | 实际 | 结果 |
| --- | --- | --- | --- |
| A 预算停止 → 续接成功 | 已有产物保留、已成功副作用不重复 | Node：step1 真实 WRITE 成功（Artifact/Verification/trashed）+ step2 `BUDGET_EXHAUSTED`；续接后 Task SUCCEEDED、2 Artifact/2 Verification、SideEffectCall 仍恰好 1 条 SUCCEEDED、续接 step 0 tool execution、continuation 带 step1 artifact。Electron UI R1–R4 全 PASS | PASS |
| B 续接后再次到限 | 再次停止、无额外调度、只追加一次预算 | 真实 dsh：resume 后再 `BUDGET_EXHAUSTED`，Task/2 step BLOCKED，runs +1，`budget_exhausted` +1，grant=1，resumeIndex=2，无 RUNNING/STARTING | PASS |
| C 重复/并发续接 | 一次有效续接、一次预算追加 | `Promise.all` 同 revision 两次 → 恰好 1 ok / 1 `RESUME_NOT_BLOCKED`、1 grant、新增 1 step；成功后再次点击不追加 | PASS |
| D 续接前/中撤权 | 后续受保护执行被拒绝并收敛 | 续接中 WRITE 到 AWAITING_APPROVAL 后撤 app tool 权限，旧 approval → call BLOCKED / `SIDE_EFFECT_AUTHORIZATION_REVOKED`、0 mutation、0 ACTIVE lease、Task/Step BLOCKED、1 grant；D4-04 Electron R1/R2 回归亦 PASS | PASS |
| E 非预算/UNKNOWN/伪造身份或预算 | 后端显式拒绝 | 非预算停 → `RESUME_NOT_BUDGET_STOP`；**真实 live-unlinked 崩溃遗留持久化 UNKNOWN_EFFECT call → `RESUME_UNKNOWN_EFFECT_PRESENT`、0 grant、Task 不变**；伪造 session/Actor/错误 app → `TASK_FORBIDDEN`；stale revision → `TASK_REVISION_CONFLICT`；renderer 报错 kind/amount → `RESUME_UNKNOWN_BUDGET_KIND`；app disabled → `TASK_FORBIDDEN`；Electron 真实非预算停 → UI 无 `data-ai-resume` | PASS |
| F 刷新恢复 + 关联链 + 账本 | 从后端恢复、链路一致、账本正确 | Electron Reload 后 `task/get` 恢复 resumable/stopReason/budgetLedger，`data-ai-resume` 出现且显示 `MODEL_CALLS +Δ`；Node 用新 TaskService 重读同一持久层仍 resumable 且 ledger 一致；Artifact↔Verification 同 task、`checksum==sha256(content)`；grant 事件含 operatorUserId/consumedAtGrant | PASS |

## 4. 实际命令与结果（被测 commit `207f946`，代码干净）

| 命令 | 结果 |
| --- | --- |
| `npm run test:d4-06` | **106 / 106 PASS**（Electron 94 + 预算 Node 6 + 续接 Node 6），exit 0，`workspaceState=""` |
| `npm run test:d4-06-resume` | **19 / 19 PASS**（真实 Electron UI：刷新恢复 → 点击 `data-ai-resume` → SUCCEEDED） |
| `npm run test:d4-04` | **94 / 94 PASS**（共享 probe，无回归） |
| `test:d4-02c` / `test:d4-03d` / `test:d4-03d-closure` / `test:d4-03c4` | 22/22、52/52、62/62、35/35 + UI 22/22 全 PASS |

环境：Electron 44.3.0 / darwin arm64 / Electron 内建 Node 24.20.0；rendererConsoleErrors / mainUnhandledErrors / secretHits = 0。

## 5. 证据（版本管理）

- `docs/D4-06-GATE-EVIDENCE.json`：testedCommit `207f946`、workspaceState `""`、逐条 expected/actual（106）、`artifactSha256=a8d8150c…51e7`。
- `docs/D4-06-RESUME-UI-EVIDENCE.json`：真实 UI 19 项、testedCommit `207f946`、`artifactSha256=22bb2087…e5c4`。
- `docs/D4-04-GATE-EVIDENCE.json`：共享 probe 94 项、`artifactSha256=c6b7ebf1…b24a1`（其 workspaceState 记录了同 commit 上 D4-06 证据的刷新，代码零改动）。
- 原始 artifact：`artifacts/d4-06-resume/resume-ui-gate.json`、`artifacts/d4-04/vertical-smoke-gate.json`、`artifacts/d4-06/budget-tests.tap`（gitignored）。均已脱敏（无 `/Users`、`/private`、`/var/folders`、`mpx_`、`tpx_`、credential）。

## 6. 预算耗尽位置 → 下一步（为何不重放）

- `MODEL_CALLS`：已发生 = Model Proxy capability 请求被 429 `CAPABILITY_EXHAUSTED`；下一步 = 该 prompt 失败 → `#promptFailure` 读真实 capability 状态 → `BUDGET_EXHAUSTED`；续接 = 新 run/新 capability。
- `TOOL_CALLS`：已发生 = Tool Facade capability `calls≥maxCalls` 的第 N+1 个 tool call 被 429 `TOOL_CAPABILITY_EXHAUSTED`（执行前拒绝）；若经 prompt 传播则归 `BUDGET_EXHAUSTED{TOOL_CALLS}`，否则由模型预算兜底（同一次停止仍 bounded）。
- `TOOL_ROUNDS`：已发生 = READ loop 第 4 轮后仍有 proposal；下一步 = 不发第 5 次 prompt，orchestrator 自己 `#blockStep(BUDGET_EXHAUSTED{TOOL_ROUNDS})`。
- 三者续接均新开 bounded step/run，不重放旧 tool 请求；“存在未决/UNKNOWN 副作用”为续接硬前置。

## 7. 遗留限制（保持原状）

1. 仅解除“预算耗尽 → 用户显式续接”；UNKNOWN_EFFECT / 撤权 / 拒绝 / 取消 / 执行异常等恢复路径仍 `EXPLICIT_RESUME_DEFERRED`。
2. 无任何 committed Artifact 的预算停止以 `RESUME_NO_SAFE_CONTINUATION` 拒绝（fail-closed 的更保守边界：必须先有一个可追溯的安全续接锚点）。
3. `RESUME_SIDE_EFFECT_PENDING` / `RESUME_ACTIVE_LEASE` 守卫已实现但未单独 e2e 命中（其安全语义由“拒绝未决/ACTIVE 状态”保证）。
4. 真实 `electron/main.cjs` 全流程 = NOT VERIFIED（Gate 用 probe host + 共享 production boot/Renderer/orchestrator）。
5. 其余仓库级限制不变：OS-level network sandbox / external workspace read audit / independent malformed ACP injection / Windows / External Provider = NOT VERIFIED；broader Domain verifiers = NOT VERIFIED；authenticated durable cross-restart process-death proof = DEFERRED / NOT VERIFIED。

## 8. 诚实边界

- 所有断言均为 worktree 内真实 Electron / Node 运行结果；停止与续接均由产品 orchestrator 自己触发，无手工 `blockStep`/`blockHarnessRun`、无直改 DB、无造假 Artifact/Verification、无固定 sleep。
- “测试环境等价”不等于“真实 `electron/main.cjs` 全流程已实测”。
- 预算停止/续接不回滚已发生副作用；已发出在途与尚未开始的操作已明确区分。
