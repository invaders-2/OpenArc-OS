# D4-04 Closure-3 · 结果记录（真实撤权纵向 + executor 不可用运行验证 + 证据绑定）

- 上一轮收口提交（本轮 Base HEAD）：`ce8ea9f765a319757b78748612392521641c6e11`（D4-04 验收与文档收口）
- 本轮代码与测试提交（= **被测 commit**）：`e989842a3f1c4df16ea70b8352d618f5d7a1cfad`
- 本轮报告/证据提交：见文末（本文件所在提交，单独标明被测 commit）
- 分支：`feature/d4-03-tool-proxy`；工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`
- 运行前工作区状态（被测干净版本）：`git status --porcelain` 为空

## 1. Task Status

`D4-04 = PASS（限定当前验收范围）`。`PLAN.md` 对 D4-04 的原始验收（一工具真实流程记录；**真实产物、停止、撤权可核查**）在**当前验收范围**内全部成立。
`D4-05 / D4-06 = NOT STARTED`，禁止自动进入 D4-05 / D5 / D6。
真实 `electron/main.cjs` 全流程未端到端实测；其余 `NOT VERIFIED` / `DEFERRED` 项一律保持原状（见 §7）。

## 2. 本轮补齐的两个缺口

### 2.1 真实撤权的纵向验证（原始验收字面项）

原有 Gate 只有 Cancel / Deny / stale-approval，没有真实撤权。本轮新增两个真实场景（真实 Electron + 真实 Renderer UI + 产品 governance API）：

- **R1 待批准时撤权，再使用旧批准**：WRITE 到 `AWAITING_APPROVAL`（同步点）→ 经产品 `AuthorizationService.revokeAppResourcePermission` 撤销 app tool 权限 → 点击真实 Approve（撤权前发出的旧 approval request）。
- **R2 任务进行中撤权（已有副作用保留）**：任务先对 refA 完成真实 WRITE（SUCCEEDED + mutation），refB 到 `AWAITING_APPROVAL`（同步点）→ 撤权 → 点击真实 Approve refB。

同步点全部为**状态轮询**（`waitFor` / `waitApprovalFor`），无固定延时；撤权只经产品 governance API，未直改 DB、未绕过权限检查、未用 Cancel 代替。

### 2.2 产品修复：spawn executor 之前的实时授权 preflight（缺陷修复）

原实现中 `SideEffectRuntime.executeApproved()` 先 `spawnExecutor`，子进程先 `acquireLease`，之后才在 executor 内部 `evaluateExecutionEligibility` 发现撤权 —— 会先起一个 executor、先建一个 lease，不满足"D4-04 撤权后无 executor 启动、无新 lease"。

- 新增 `SideEffectAuthority.preflightAuthorization({ callId })`（只读）：`#executionContext(task)` + `#resolveAgent` + `#toolFor(call)` + `#authorizeLive(...)`；失败返回 `SIDE_EFFECT_AUTHORIZATION_REVOKED`。
- `executeApproved()` 在 SUCCEEDED duplicate 判断之后、`spawnExecutor` 之前调用 preflight；失败即 `#blockPending(callId, reason)`，**0 spawn / 0 lease / 0 mutation**。
- 未放宽任何既有检查；正常（未撤权）路径语义不变。

### 2.3 executor 不可用时的产品运行验证

原有证据只到 `RuntimeSupervisor.spawnExecutor` 拒绝。新增 `tests/d4-04-executor-unavailable.test.mjs`：用 `createIdentityService({..., executorLauncher: new UnavailableExecutorLauncher()})` 装真实产品栈，经产品 API 造出 APPROVED 的 WRITE call，再调用产品 `executeApproved`。断言 `error=EXECUTOR_LAUNCHER_UNAVAILABLE`、call `BLOCKED`、`supervisor.snapshot().length===0`、`executorEvidence().length===0`、0 lease、0 mutation，并把上层 task/run 经 `TaskService.blockStep/blockHarnessRun`（orchestrator 使用的同一产品合同）收敛到 `BLOCKED`（不一直 RUNNING）。

## 3. 场景检查项（被测 commit `e989842`，干净版本运行）

### R1 revokePendingApproval（11/11 PASS）

| # | 检查项 | 期望 | 实际 |
| --- | --- | --- | --- |
| R1.1 | 撤权前 proposal 到 AWAITING_APPROVAL 且 Approval UI 可见 | AWAITING_APPROVAL + UI 可见 | AWAITING_APPROVAL/ui=true |
| R1.2 | 产品 governance API 撤销 app tool 权限 | ok=true, changed=true | {"ok":true,"changed":true} |
| R1.3 | 撤权只针对 tool 权限：resource grant 仍在 | true | true |
| R1.4 | 使用旧批准（真实 UI Approve） | ok | ok |
| R1.5 | 旧批准不得执行：call 终态 BLOCKED | BLOCKED | BLOCKED |
| R1.6 | call error_code | SIDE_EFFECT_AUTHORIZATION_REVOKED | SIDE_EFFECT_AUTHORIZATION_REVOKED |
| R1.7 | 0 mutation（resource 未 trashed） | false | false |
| R1.8 | 0 lease | 0 | 0 |
| R1.9 | 0 新 executor（preflight 先于 spawn） | 数量不变 | 3→3 |
| R1.10 | Task 非 SUCCEEDED 且终态 + 无自动重试 | 终态非 SUCCEEDED + calls=1 | BLOCKED/calls=1 |
| R1.11 | 场景结束后重新授予 tool 权限 | ok=true | ok=true |

### R2 revokeMidTask（12/12 PASS）

| # | 检查项 | 期望 | 实际 |
| --- | --- | --- | --- |
| R2.1 | refA 的 trash 到 AWAITING_APPROVAL | AWAITING_APPROVAL + UI 可见 | AWAITING_APPROVAL/ui=true |
| R2.2 | 批准并执行 refA 的真实 WRITE | ok | ok |
| R2.3 | refA SUCCEEDED 且 trashed（撤权前已有真实副作用） | SUCCEEDED + trashedA=true | SUCCEEDED/trashedA=true |
| R2.4 | refB 的 trash 到 AWAITING_APPROVAL（撤权同步点） | AWAITING_APPROVAL + UI 可见 | AWAITING_APPROVAL/ui=true |
| R2.5 | 任务进行中经产品 governance API 撤权 | ok=true, changed=true | {"ok":true,"changed":true} |
| R2.6 | 已发生副作用保留：refA trashed=true（**不宣称撤权回滚**） | true | true |
| R2.7 | 使用旧批准（真实 UI Approve refB） | ok | ok |
| R2.8 | refB 未 trashed（撤权后 fail closed，0 mutation） | false | false |
| R2.9 | 第二个 call 终态 BLOCKED + 0 lease + 0 新 executor | BLOCKED + 0 lease + 0 新 executor | BLOCKED/leases=0/exec=4→4 |
| R2.10 | 无自动重试：任务只有 2 条 call（refA/refB 各 1） | 2 | 2 |
| R2.11 | Task/Step BLOCKED + Harness run 停止（不是 RUNNING） | BLOCKED/BLOCKED/非 RUNNING | BLOCKED/step=BLOCKED/run=BLOCKED |
| R2.12 | UI 最终 BLOCKED 且 Run 复位（busy=false） | BLOCKED + run enabled | BLOCKED |

**在途操作/停止状态语义遵循现有权限契约**：撤权后 call 收敛 `BLOCKED`，`error_code=SIDE_EFFECT_AUTHORIZATION_REVOKED`；Task/Step/Harness run 收敛 `BLOCKED`；不自动重试；已发生的副作用保留、不声称可回滚。

## 4. 实际执行命令与结果（被测 commit `e989842`，干净工作区）

| 命令 | 结果 |
| --- | --- |
| `npm run test:d4-04` | **exit 0；67 / 67**；12 个 gate 全 true（含 `revokePendingApproval` / `revokeMidTask`）；`rendererConsoleErrors=0`、`mainUnhandledErrors=0`、`secretHits=0` |
| `node --test tests/d4-04-closure2-boot.test.mjs tests/d4-04-executor-unavailable.test.mjs` | **10 / 10 PASS**（9 + 1） |
| `npm run test:d4-03c4` | PASS：tests **35/35** + approval UI **22/22** |
| `npm run test:d4-03c4-closure2` | **12 / 12 PASS** |
| `npm run test:d4-03c4-closure3` | **9 / 9 PASS** |
| `npm run test:d4-03d` | **52 / 52 PASS** |
| `npm run test:d4-03d-closure` | **62 / 62 PASS** |

环境（本次运行实测）：Electron `44.3.0`、platform `darwin`、arch `arm64`、Electron 内建 Node `24.20.0`；命令 `npm run test:d4-04`。

## 5. 证据与可追溯性（本轮已闭合）

- `npm run test:d4-04` 的 artifact 现在记录：`testedCommit`、`workspaceState`、`command`、`env`、逐条 `checks={name,expected,actual,ok}`（递归脱敏）、`artifactSha256`。
- 本次干净运行：`testedCommit=e989842a3f1c4df16ea70b8352d618f5d7a1cfad`，`workspaceState=""`，`checks.total=67 / pass=67 / fail=0`。
- `artifacts/` 被 `.gitignore`：完整 artifact `artifacts/d4-04/vertical-smoke-gate.json` 仍在本地；同一份脱敏证据写入**版本管理**的 `docs/D4-04-GATE-EVIDENCE.json`。
- 原始 artifact 的 SHA-256：`01baf7ef3da3f86424e306d5266eaa828d51cf94d57f65040d1c997ff5d6e71b`（覆盖去掉 `artifactSha256` 字段后的 canonical JSON，2 空格缩进；已实测 stored == recomputed）。
- 已实测证据文件无 `/Users`、`/private`、`/var/folders`、`mpx_`、`tpx_`、credential 泄漏。

## 6. 改动文件

**代码与测试提交（`e989842`）**：
- `electron/side-effect-authority.cjs`（新增只读 `preflightAuthorization`）
- `electron/side-effect-runtime.cjs`（`executeApproved` spawn 前置 preflight）
- `tests/fixtures/d4-04-provider.mjs`（`resourceRefs` + `revoke2` follow-aware 计划）
- `tests/fixtures/d4-04-probe/main.cjs`（`expected/actual`；R1/R2；`runTaskViaUI` 新 taskId；F4 条件轮询）
- `tests/d4-04-smoke.mjs`（撤权 gate 布尔 + 证据/traceability 字段）
- `tests/d4-04-executor-unavailable.test.mjs`（新增）
- `docs/D4-04-GATE-EVIDENCE.json`（运行前快照；运行后由新一轮覆盖）

**报告提交**：`docs/D4-04-GATE-EVIDENCE.json`（干净运行重写）、`docs/D4-04-CLOSURE3-RESULT.md`、`docs/D4-04-ACCEPTANCE-RESULT.md`、`PROGRESS.md`。

## 7. 剩余限制（未关闭，保持原状）

`真实 electron/main.cjs 全流程端到端 = NOT VERIFIED`（Gate 用 probe host + 共享 production 装配）；`OS-level network sandbox = NOT VERIFIED`；`external workspace read audit = NOT VERIFIED`；`independent malformed ACP injection = NOT VERIFIED`；`Windows = NOT VERIFIED`；`External Provider = NOT VERIFIED`；`Explicit Resume = DEFERRED`；`broader Domain verifiers = NOT VERIFIED`；`authenticated durable cross-restart process-death proof = DEFERRED / NOT VERIFIED`。

executor-unavailable 的**上层收敛**由 orchestrator 使用的同一 `TaskService` 产品合同（`blockStep` + `blockHarnessRun`）驱动验证，未跑完整 orchestrator（完整 orchestrator 需要外部模型；本轮按约束不接真实 Provider）。

## 8. 诚实边界

- 撤权场景的真实宿主是 probe host（产品 preload + 产品 `dist/index.html` + 共享 production 装配），不是真实 `electron/main.cjs`。
- R2 如实记录 refA 的副作用已发生并保留；**不宣称撤权能回滚**。
- 未以现有测试全绿扩大结论：本轮只把 D4-04 在**当前验收范围**内记为 PASS；真实 main 端到端与其余 `NOT VERIFIED` / `DEFERRED` 保持原状。
