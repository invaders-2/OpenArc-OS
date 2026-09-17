# D4-04 验收报告（Acceptance Result · 含撤权与 executor 缺口补齐）

- D4-04 原始基线：`67357ef100635c42a571bc747abf2b8aaaeb4aae`（Closure-2）
- 本轮缺口补齐 Base HEAD：`ce8ea9f765a319757b78748612392521641c6e11`
- **被测 commit**：`e989842a3f1c4df16ea70b8352d618f5d7a1cfad`（代码与测试提交，干净工作区上运行）
- Final HEAD：本验收报告所在提交（报告/证据提交，单独标明被测 commit）
- 分支：`feature/d4-03-tool-proxy`；工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`；未 push、未合并 main

## 0. 工作目录 / 分支 / HEAD / 远端

| 项 | 实际值 |
| --- | --- |
| 会话默认工作目录 | `/Users/wepingli/Desktop/OpenArc OS`（分支 `feature/d3-02-object-authorization`，HEAD `9119f85`，脏：5 改 + 6 未跟踪）；**不是**本轮工作树，全程未触碰 |
| 本轮工作树 | `/Users/wepingli/Desktop/OpenArc OS-d4-01`，分支 `feature/d4-03-tool-proxy` |
| Base HEAD | `ce8ea9f`（上一轮验收/文档收口提交） |
| 代码与测试提交（= 被测 commit） | `e989842a3f1c4df16ea70b8352d618f5d7a1cfad` |
| Final HEAD | 报告/证据提交（见文末 git log；单独标明被测 commit） |
| 远端 | `origin/feature/d4-03-tool-proxy`；本轮未 push |

分支名 `feature/d4-03-tool-proxy` 与其承载的 D4-04 内容不一致（仅记录，不改名、不改分支）。

## 1. D4-04 原始要求（路线图口径）

- `PLAN.md` 任务表：**D4-04 纵向冒烟**（测试，前置 D4-03，交付物 = 一工具真实流程记录，验收 = **真实产物、停止、撤权可核查**）。
- `PLAN_SYNC.md` §12 路线：`D4-03D → D4-04 Vertical Smoke → D4-05 Execution Gate`。
- 收口记录：Closure-1 = `001d9a4` + `docs/D4-04-RESULT.md`（43/43）；Closure-2 = `67357ef` + `docs/D4-04-CLOSURE2-RESULT.md`（44/44）；**Closure-3（本轮缺口补齐）= `e989842` + `docs/D4-04-CLOSURE3-RESULT.md`（67/67）**。

## 2. 验收结论

**`D4-04 = PASS（限定当前验收范围）`**。原始验收的四项在**当前验收范围**内全部成立；真实 `electron/main.cjs` 全流程端到端与其余 `NOT VERIFIED` / `DEFERRED` 项保持原状（§6）。

| 原始验收项 | 结论 | 证据（被测 commit `e989842`） |
| --- | --- | --- |
| 一工具真实流程记录 | 成立（resource.search / resource.read / resource.trash，official dsh + 受监督 executor） | `tests/fixtures/d4-04-probe/main.cjs`；A/B/C 段 checks |
| 真实产物 | 成立（READ 返回最终文本；WRITE 真实 mutation + Domain verify PASS） | artifact `readSmoke/writeApproveSmoke=true`、`businessMutations=1`、`verifications=2` |
| 停止 | 成立（Cancel E1–E4、Deny D1–D4、UNKNOWN F1–F7） | artifact `cancelSmoke/writeDenySmoke/unknownEffectSmoke=true` |
| **撤权可核查** | **成立（本轮补齐）**：真实撤权纵向 R1/R2 全 PASS，撤权后 0 新 executor / 0 新 lease / 0 mutation | artifact `revokePendingApproval/revokeMidTask=true`；`docs/D4-04-CLOSURE3-RESULT.md` §3 |

## 3. 四项重点确认

### 3.1 真实产品启动与 probe 共用启动逻辑 —— 成立（静态等价 + 动态 helper 证据）

真实 `electron/main.cjs` 与 probe 都 require 并调用同一个 `createOpenArcRuntime`（`electron/runtime-boot.cjs`），都用产品 `registerIdentityIpc` / `registerTaskIpc` / `createDefaultExecutorLauncher()`；probe 用产品 `electron/preload.cjs` + 产品 `dist/index.html`。证据 = 静态等价（`tests/d4-04-closure2-boot.test.mjs` 前 3 test）+ 动态 helper（第 4 test 真实 listen `127.0.0.1`）。**不是**真实 `main.cjs` 全流程已实测。

### 3.2 Model Proxy 启动尝试先于任务接入 —— 成立（结构断言；非真实 main E2E）

`bootOrder = identity_created → model_proxy_start_attempted → model_proxy_started → runtime_ready`；真实 main 中 `await createOpenArcRuntime` 先于 `registerTaskIpc`；probe 在首次 `task/run` 前调 `noteTaskAdmission()`。证据 = 动态顺序 test + `OPENARC_ASSEMBLY_ORDER_VIOLATION` regression + artifact `A6/productRuntime`。

### 3.3 Electron executor 不可用时拒绝执行 —— 成立（本轮升级为产品 `executeApproved` 路径动态验证）

- `UnavailableExecutorLauncher`（不回退 `spawn(process.execPath)`）→ `RuntimeSupervisor.spawnExecutor` 返回 `EXECUTOR_LAUNCHER_UNAVAILABLE`（0 runtime / 0 spawn）。
- **本轮新增** `tests/d4-04-executor-unavailable.test.mjs`：真实产品栈注入 `UnavailableExecutorLauncher`，经产品 `executeApproved` 路径，断言 `error=EXECUTOR_LAUNCHER_UNAVAILABLE`、call `BLOCKED`、`snapshot().length===0`、`executorEvidence().length===0`、0 lease、0 mutation，上层 task/run 收敛 `BLOCKED`（不一直 RUNNING）。
- 限制：上层收敛经 orchestrator 使用的同一 `TaskService` 产品合同（`blockStep`+`blockHarnessRun`）驱动；真实 Electron main 的不可用故障条件未跑（生产实际走 `ElectronUtilityProcessLauncher`，见 artifact `executor.launcher`）。

## 4. 八条路径证据（区分「实际运行」与「静态/单元」）

全部路径由真实 Electron probe 内真实 Renderer UI 动作驱动，走产品 IPC + 真实 `SideEffectStore` / `RuntimeSupervisor` / utility executor；**实际运行宿主是 probe host**，不是真实 `electron/main.cjs`。

| 路径 | Gate check | 关键实际运行证据 | 结论 |
| --- | --- | --- | --- |
| WRITE | C1–C10 | SideEffectCall=1 / Approval=1 / Lease=1(RELEASED) / mutation=1 / verify=PASS；executor exit 0 | 实际运行 PASS |
| UNKNOWN_EFFECT | F1–F7 | claim 先于真实 child exit；executor exit 9；Task/Step BLOCKED；0 第二 call / lease / retry | 实际运行 PASS |
| Deny | D1–D4 | 0 mutation / 0 lease / 0 executor；call 安全终态；UI busy 复位 | 实际运行 PASS |
| Cancel | E1–E4 | Task CANCELLED；0 mutation / 0 lease；旧 approval 再点被拒 | 实际运行 PASS |
| renderer spoof | G1–G3 | 自报 actor/risk 被忽略；伪造 approvalRequestId → DENY；伪造 actor 的真实 approve 仍受控 | 实际运行 PASS |
| reload | H1 | `webContents.reload()` 后仅凭 backend authoritative state 恢复 | 实际运行 PASS |
| **撤权（待批准）** | **R1.1–R1.11** | AWAITING_APPROVAL → 产品 API 撤权 → 旧批准 Approve → call BLOCKED / `SIDE_EFFECT_AUTHORIZATION_REVOKED` / 0 mutation / leases=0 / executor 3→3 / Task BLOCKED / calls=1 | **实际运行 PASS** |
| **撤权（任务中，已发生副作用保留）** | **R2.1–R2.12** | refA 真实 WRITE 成功 → refB AWAITING_APPROVAL → 撤权 → Approve refB → refB BLOCKED / 0 mutation / 0 lease / executor 4→4 / 任务共 2 call / Task·Step·Harness run BLOCKED / UI BLOCKED + Run 复位；refA 副作用保留（不回滚） | **实际运行 PASS** |

补充实际运行事实：`rendererConsoleErrors=0`、`mainUnhandledErrors=0`、`secretHits=0`、`AUTO_RETRY=0`、`maxToolCallsPerTask=2`。

## 5. 证据可追溯性（本轮已闭合）

- Gate：`npm run test:d4-04`（= `npm run build && node tests/d4-04-smoke.mjs`）；Closure-3 轮被测 commit `e989842`，运行前 `workspaceState=""`（67/67）。
- **后续（D4-06 复用）**：同一 probe 被 D4-06 复用并增量加入执行异常/预算到限/关联链检查；当前共享 probe 在 `17df98e` 干净运行 **94/94**（原 67 项不变 + 新增 27），`docs/D4-04-GATE-EVIDENCE.json` 已刷新为 94 项。D4-04 结论不受影响。
- artifact `artifacts/d4-04/vertical-smoke-gate.json`（gitignored）与**版本管理**的 `docs/D4-04-GATE-EVIDENCE.json` 内容一致：`testedCommit` / `workspaceState` / `command` / `env` / 逐条脱敏 `checks={name,expected,actual,ok}` / `artifactSha256`。
- 原始 artifact SHA-256：`01baf7ef3da3f86424e306d5266eaa828d51cf94d57f65040d1c997ff5d6e71b`（覆盖去掉该字段的 canonical JSON；stored == recomputed）。
- 证据文件已实测无绝对路径 / `mpx_` / `tpx_` / credential 泄漏。
- 限制：`officialDsh=true`、`dshVersion="0.1.5-rc.2"` 仍为 Gate 中的常量声明（真实 dsh 版本由 `tests/tool-dsh-facade.test.mjs` / `tests/harness-acp-*.test.mjs` 断言）。

## 6. 未解决问题与是否阻塞

| # | 问题 | 是否 D4-04 必须项 | 是否阻塞 | 说明 / 后续 |
| --- | --- | --- | --- | --- |
| 1 | 「撤权可核查」 | 是 | **已关闭** | R1/R2 实际运行 PASS（本轮） |
| 2 | executor 不可用 runtime 级收敛 | 是（验收要求） | **已关闭（有界）** | 新增产品 `executeApproved` + `UnavailableExecutorLauncher` 动态 test；上层收敛经产品 TaskService 合同驱动，未跑完整 orchestrator |
| 3 | 证据未绑定 commit / 无逐条明细 | 否 | **已关闭** | artifact + `docs/D4-04-GATE-EVIDENCE.json` 记录 testedCommit / workspaceState / 逐条 checks / SHA-256 |
| 4 | `PROGRESS.md` 过时 BLOCK / NOT STARTED | 文档一致性 | **已关闭** | 本轮同步为 `D4-04 = PASS（限定当前验收范围）` |
| 5 | 真实 `electron/main.cjs` 全流程未端到端实测 | 非 D4-04 字面必须项 | **不阻塞（保持 NOT VERIFIED）** | 未来以真实 main + 受控注入跑同类垂直冒烟 |
| 6 | 其余仓库缺口 | 见右 | **不阻塞（保持原状）** | `OS-level network sandbox / external workspace read audit / independent malformed ACP injection / Windows / External Provider = NOT VERIFIED`；`Explicit Resume = DEFERRED`；`broader Domain verifiers = NOT VERIFIED`；`authenticated durable cross-restart process-death proof = DEFERRED / NOT VERIFIED` |

## 7. 唯一推荐的下一阶段任务

**D4-06**（`PLAN.md` §41 定义，非编造）：后端与测试管理岗验证 Task、Step、Call、Artifact、Verification 关联及预算停止。`D4-05 执行关卡同时依赖 D4-06`（`PLAN.md` §41），故 D4-04 完成后直接可执行的是 D4-06，其后进入 D4-05。目标/范围/排除项/前置/完成标准见 `docs/D4-04-CLOSURE3-RESULT.md` 与上一轮报告，本轮不实施。

## 8. 本轮修改文件与实际执行的检查

**代码与测试提交 `e989842`**：`electron/side-effect-authority.cjs`、`electron/side-effect-runtime.cjs`、`tests/fixtures/d4-04-provider.mjs`、`tests/fixtures/d4-04-probe/main.cjs`、`tests/d4-04-smoke.mjs`、`tests/d4-04-executor-unavailable.test.mjs`、`docs/D4-04-GATE-EVIDENCE.json`。
**报告提交**：`docs/D4-04-GATE-EVIDENCE.json`（干净运行重写）、`docs/D4-04-CLOSURE3-RESULT.md`、`docs/D4-04-ACCEPTANCE-RESULT.md`、`PROGRESS.md`。

**实际执行（被测 commit `e989842`，干净工作区）**：
- `npm run test:d4-04` → exit 0，**67/67**，12 gate 全 true。
- `node --test tests/d4-04-closure2-boot.test.mjs tests/d4-04-executor-unavailable.test.mjs` → **10/10**。
- 受影响回归：`test:d4-03c4` 35/35 + UI 22/22、`test:d4-03c4-closure2` 12/12、`test:d4-03c4-closure3` 9/9、`test:d4-03d` 52/52、`test:d4-03d-closure` 62/62，全部 exit 0。
- 全过程未跑真实 External Provider、未使用真实凭据、未新增服务。

## 9. 诚实边界

- 撤权场景宿主是 probe host（产品 preload + 产品 dist Renderer + 共享 production 装配），不是真实 `electron/main.cjs`。
- R2 如实记录 refA 已发生的副作用并保留；**不宣称撤权能回滚**。
- 本轮只把 D4-04 在**当前验收范围**内记为 PASS；真实 main 端到端与其余 `NOT VERIFIED` / `DEFERRED` 保持原状。
