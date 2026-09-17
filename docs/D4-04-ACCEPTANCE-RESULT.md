# D4-04 验收与文档收口（Acceptance / Closure）

- 本轮预期基线：`67357ef100635c42a571bc747abf2b8aaaeb4aae`
- 验收日期：2026-09-17
- 性质：只做验收与文档收口，不新增产品功能；不 reset、不覆盖未提交改动、不强推、不合并 main。

## 0. 实际工作目录 / 分支 / HEAD / 远端同步核对

| 项 | 实际值 | 说明 |
| --- | --- | --- |
| 会话默认工作目录 | `/Users/wepingli/Desktop/OpenArc OS` | 分支 `feature/d3-02-object-authorization`，HEAD `9119f85` |
| 会话默认工作区状态 | **脏**：5 个已修改（CHANGELOG.md / MOTION_SYSTEM.md / src/desktop/components.tsx / src/main.tsx / src/styles.css）+ 5 个未跟踪（Dock 放大镜等） | **不是**本轮基线；本轮全程未触碰 |
| 本轮基线工作树 | `/Users/wepingli/Desktop/OpenArc OS-d4-01` | 分支 `feature/d4-03-tool-proxy` |
| Base HEAD | `67357ef100635c42a571bc747abf2b8aaaeb4aae` | 与预期基线一致 |
| 工作区状态 | 干净（`git status --porcelain` 为空） | 全部验收在此工作树内进行 |
| 对应远端分支 | `origin/feature/d4-03-tool-proxy` | 已 `git fetch` 核对：`0 0`，远端亦为 `67357ef` |
| Final HEAD | 基线 `67357ef` + 本轮唯一一个纯文档提交（见文末） | 未 push；远端仍停在 `67357ef` |

**差异说明**：基线与会话默认工作目录不一致。基线提交不在会话默认 worktree，而在 `OpenArc OS-d4-01` worktree；其分支名 `feature/d4-03-tool-proxy` 与其携带的 D4-04 内容不一致（该分支 tip 已有 Closure-1 `001d9a4`、Closure-2 `67357ef`）。仅记录，不改名、不改分支。为避免覆盖会话工作区未提交改动，本轮验收全部在 d4-01 worktree 内只读进行。

## 1. D4-04 原始要求（路线图口径）

- `PLAN.md` 任务表：**D4-04 纵向冒烟**（测试，前置 D4-03，交付物 = 一工具真实流程记录，验收 = **真实产物、停止、撤权可核查**）。
- `PLAN_SYNC.md` §12 路线：`D4-03D → D4-04 Vertical Smoke → D4-05 Execution Gate`。
- 两个收口记录：Closure-1 = `001d9a4` + `docs/D4-04-RESULT.md`（43/43）；Closure-2 = `67357ef` + `docs/D4-04-CLOSURE2-RESULT.md`（44/44）。

## 2. 验收结论

`D4-04 = PASS candidate`（沿用仓库既有口径，本轮不升级、不封板；封板权在外部审计）。核心纵向链路与三项重点确认成立，证据可追溯到基线提交；但相对原始验收标准的字面项 **「撤权」未在 D4-04 Gate 内直接覆盖**（详见 §6）。

| 原始验收项 | 结论 | 证据 |
| --- | --- | --- |
| 一工具真实流程记录 | 成立（实际覆盖 resource.search / resource.read / resource.trash 两个受控 tool） | `tests/fixtures/d4-04-probe/main.cjs`，`artifacts/d4-04/vertical-smoke-gate.json` |
| 真实产物 | 成立（READ 返回最终文本；WRITE 真实 mutation + Domain verify PASS） | artifact `readSmoke/writeApproveSmoke=true`、`businessMutations=1`、`verifications=2` |
| 停止 | 成立（Cancel E1–E4、Deny D1–D4、UNKNOWN F1–F7） | artifact `cancelSmoke/writeDenySmoke/unknownEffectSmoke=true` |
| 撤权可核查 | **未在 D4-04 Gate 内覆盖**（D4-03C4/03D 有 revoke 证据，但未纳入本次纵向冒烟） | 见 §6，阻塞判断见 §6 |

## 3. 三项重点确认（按证据强度分级）

### 3.1 真实产品启动与 probe 共用启动逻辑 —— 成立（静态等价 + 动态 helper 证据）

- 真实 `electron/main.cjs`：`require("./runtime-boot.cjs")`（L11）并调用 `createOpenArcRuntime({...})`（L45）。
- probe：`require(ROOT/electron/runtime-boot.cjs)`（L14）并调用同一个 `createOpenArcRuntime({...})`（L94）。
- 二者都使用产品 `registerIdentityIpc` / `registerTaskIpc` / `createDefaultExecutorLauncher()`；probe 使用产品 `electron/preload.cjs` + 产品 `dist/index.html`。
- **证据分级**：这是**静态源码等价**（`tests/d4-04-closure2-boot.test.mjs` 的前 3 个 test 用正则断言）+ **动态 helper 证据**（第 4 个 test 真实调用 `createOpenArcRuntime` 并断言 Model Proxy 真 listen 在 `127.0.0.1`）。
- **不是**：真实 `electron/main.cjs` 全流程启动已实测。D4-04 Gate 跑的是 probe host，不是真实 main。二者共享同一份 boot/装配代码，差异仅为 test-only（临时 userData、deterministic local provider、admin setup、`executorTestHook`、`show=false`），probe 另以 stub 取代 native 窗口层（`windows:sync` / `NativeViewController`）。

### 3.2 Model Proxy 启动尝试先于任务接入 —— 成立（顺序有真实结构断言；非真实 main E2E）

- 共享 helper `electron/runtime-boot.cjs` 按真实发生顺序记录 `bootOrder`：`identity_created → model_proxy_start_attempted → model_proxy_started → runtime_ready`；`noteTaskAdmission()` 要求 `afterProxyStartAttempt && afterRuntimeReady`。
- 真实 main：`await createOpenArcRuntime(...)`（L45）在 `registerTaskIpc(...)`（L150）之前，Task 接入排在 proxy start 尝试之后。
- probe：`createOpenArcRuntime`（L94）→ `registerTaskIpc`（L125）→ `noteTaskAdmission()`（L153）→ 第一次 `task/run`（L161 起）。
- **证据**：`tests/d4-04-closure2-boot.test.mjs` 第 4 个 test（动态顺序）+ 第 5 个 test（`startProductModelProxy(undefined|{}|{modelProxy:{}})` 必抛 `OPENARC_ASSEMBLY_ORDER_VIOLATION`）；artifact `productRuntime.bootOrder` 与 `taskAdmissionAfterProxyStart=true`；Gate check `A6`。
- **不是**：真实 main 的 proxy start 未在真实 main 进程里被独立实测；其顺序来自共享 helper 的静态调用位置 + helper 的动态断言。

### 3.3 Electron executor 不可用时拒绝执行 —— 成立（supervisor 级动态验证；runtime 收敛为静态分支）

- `electron/executor-launcher.cjs`：Electron main + `utilityProcess.fork` 不可用 → `UnavailableExecutorLauncher`（`available=false`，`launch()` 抛 `EXECUTOR_LAUNCHER_UNAVAILABLE`），**绝不回退** `spawn(process.execPath, ...)`。
- `electron/runtime-supervisor.cjs` `spawnExecutor()`：`launcher.available === false` → 直接 `{ok:false, error:"EXECUTOR_LAUNCHER_UNAVAILABLE"}`（不注册 runtime、不 spawn）。
- `electron/side-effect-runtime.cjs` `executeApproved()`：admission 失败 → `#blockPending()` 把 pending call 明确收敛为 `BLOCKED`（0 lease / 0 mutation / 0 retry）。
- **动态证据**：`tests/d4-04-closure2-boot.test.mjs` 第 6、7 个 test（本轮复用同环境重跑，9/9 PASS）：launcher 选择 fail-closed、`spawnExecutor` fail-closed 且 `snapshot().length===0` / `executorEvidence().length===0`。
- **静态证据**：`executeApproved() → #blockPending` 这条 runtime 级收敛分支**没有**专门 test 驱动（只有 supervisor 级动态证据）；真实 Electron main 中该不可用分支也**未在真实故障条件下运行**（生产实际走 `ElectronUtilityProcessLauncher`，见 artifact `executor.launcher`）。

## 4. 六条路径证据（区分「实际运行」与「静态/单元」）

全部六条路径均由真实 Electron probe 内的真实 Renderer UI 动作驱动（`executeJavaScript` 点击 Run/Approve/Deny/Cancel、`webContents.reload()`），走产品 IPC + 真实 `SideEffectStore` / `RuntimeSupervisor` / utility executor。**这是实际运行验证**，但运行宿主是 probe host，不是真实 `electron/main.cjs`。

| 路径 | Gate check | 关键实际运行证据 | 结论 |
| --- | --- | --- | --- |
| WRITE | C1–C10 | `SideEffectCall=1 / Approval=1 / Lease=1(RELEASED) / mutation=1 / verification=PASS`；executor `spawned/ready/exited=true, exitCode=0` | 实际运行 PASS |
| UNKNOWN_EFFECT | F1–F7 | claim RUNNING 先于真实 child `exit`；executor `exitCode=9`；`UNKNOWN_EFFECT` → Task/Step BLOCKED；0 第二 call / 0 第二 lease / 0 retry | 实际运行 PASS |
| Deny | D1–D4 | 0 mutation / 0 lease / 0 executor；call 安全终态；UI busy 复位 | 实际运行 PASS |
| Cancel | E1–E4 | Task CANCELLED；0 mutation / 0 lease；Cancel 后旧 approval 再点被拒 | 实际运行 PASS |
| renderer spoof | G1–G3 | 自报 userId/role/sessionRef/riskClass 全被忽略；伪造 `approvalRequestId` → DENY；伪造 actor 的真实 approve 仍走完整受控执行 | 实际运行 PASS |
| reload | H1 | `webContents.reload()` 后仅凭 backend authoritative state 恢复 Task 结果 | 实际运行 PASS |

补充实际运行事实：`rendererConsoleErrors=0`、`mainUnhandledErrors=0`、`secretHits=0`、`AUTO_RETRY=0`、`maxToolCallsPerTask=2`。

## 5. 证据可追溯性（重要限制）

- 主 Gate 启动器：`tests/d4-04-smoke.mjs` = `npm run build && node tests/d4-04-smoke.mjs`；宿主 probe = `tests/fixtures/d4-04-probe/main.cjs`。
- 落盘 artifact：`artifacts/d4-04/vertical-smoke-gate.json`，生成时间 `2026-09-16T17:24:42+08:00`，`checks.total=44 / pass=44 / fail=0`。
- **时间线可追溯**：源码最后修改 17:23（probe/launcher/runtime-boot 等）→ artifact 17:24:42 → 基线提交 `67357ef` 17:35:30（该提交相对 `001d9a4` 仅改动 electron/tests/package.json + 两个文档）；`src/` 最后一次变更是 `001d9a4` 17:14。当前 worktree 干净 == `67357ef`，故 artifact 与基线提交同源。
- **限制 1**：`artifacts/` 被 `.gitignore`（第 3 行），artifact **不在版本库**；且其中 `commit: null`（`OPENARC_COMMIT` 未设置），artifact 自身不绑定 commit。
- **限制 2**：artifact 只保存**汇总布尔值与计数**，不保存 44 条 check 的逐条明细；逐条断言只能从 probe 源码重建，或重跑 `npm run test:d4-04`。
- **限制 3**：`officialDsh=true` 与 `dshVersion:"0.1.5-rc.2"` 在 `tests/d4-04-smoke.mjs`（L56–57）中为常量声明，非本次运行实测；真实 dsh 版本另有 `tests/tool-dsh-facade.test.mjs` / `tests/harness-acp-*.test.mjs` 断言为 `0.1.5-rc.2`。

## 6. 未解决问题与是否阻塞验收

| # | 问题 | 是否 D4-04 必须项 | 是否阻塞本阶段验收 | 后续取得真实证据的方式 |
| --- | --- | --- | --- | --- |
| 1 | 「撤权」未纳入 D4-04 Gate（Gate 只有 Cancel/Deny/stale-approval；无 live session/app/tool/resource permission revoke 场景） | 按 `PLAN.md` 验收字面是；按 D4-03C4/03D 低层证据可间接覆盖 | **需审计裁量**：核心纵向主线不受阻；字面验收未闭合 | 在 D4-04/D4-05 Gate 增加一条真实 revoke 场景，或由审计明确引用 `D4-03D` revoke 证据并记录等效性 |
| 2 | 真实 `electron/main.cjs` 全流程未实测（仅共享 helper + 静态等价 + helper 动态） | 非 D4-04 字面必须项（Gate 明确用 probe host + 共享装配） | 不阻塞 | 未来以真实 main + 受控注入跑同类垂直冒烟，作为独立 Gate |
| 3 | artifact 未绑定 commit、不落库、无逐条明细 | 否（测试记录可用性） | 不阻塞 | 重跑 Gate 时设 `OPENARC_COMMIT`，并把逐条 check 明细落盘 |
| 4 | Electron executor 不可用分支的 runtime 级收敛无专门 test，且真实故障条件未跑 | 否（supervisor 级已有动态证据） | 不阻塞 | 增加 `executeApproved` + `UnavailableExecutorLauncher` 的动态 test |
| 5 | `PROGRESS.md` 仍写 `D4-04 纵向冒烟 = BLOCK`（L80）、`D4-04 = NOT STARTED`（L832），与两个 RESULT 文档/artifact 的 `PASS candidate` 冲突 | 文档一致性 | 不阻塞，但影响唯一口径 | 由审计裁量是否在 `PROGRESS.md` 更新为 `D4-04 = PASS candidate`；本轮按「不升级结论」原则**未改** |
| 6 | 仓库既有剩余缺口 | 见右 | 不阻塞 | **保持原状，不升级**：`OS-level network sandbox = NOT VERIFIED`；`external workspace read audit = NOT VERIFIED`；`independent malformed ACP injection = NOT VERIFIED`；`Windows = NOT VERIFIED`；`External Provider = NOT VERIFIED`；`Explicit Resume = DEFERRED`；`broader Domain verifiers = NOT VERIFIED`；`authenticated durable cross-restart process-death proof = DEFERRED / NOT VERIFIED` |

## 7. 唯一推荐的下一阶段任务

**D4-06**（编号与内容来自仓库既有路线图 `PLAN.md` §41，非编造）：

> 后端与测试管理岗验证 Task、Step、Call、Artifact、Verification 关联及预算停止。

**为什么是它而不是 D4-05**：`PLAN.md` §41 明确 `D4-05 执行关卡同时依赖 D4-06`；D4-04 完成后，拓扑上直接可执行的下一项是 D4-06，其后再进入 D4-05。

- **目标**：证明一条真实任务链上 Task ↔ Step ↔ ToolExecution/SideEffectCall ↔ Artifact ↔ Verification 的关联完整可核查；并证明达到预算上限时停止自动循环、保留产物、给出明确续接入口（对应 §41 新增验收 `A35`）。
- **范围**：只读审计 + 证据 Gate（新增/扩展只读测试与 artifact）；不改产品行为、不改冻结架构。
- **排除项**：不实现 D4-05 的四种执行关卡场景（产物不符 / 结果未知 / 用量到限 / 记忆越权）的完整产品功能；不扩展真实工具面；不接 MCP/浏览器/画布/Adobe；不做 Windows；不做 External Provider；不使用真实凭据。
- **前置条件**：D4-03 与 D4-04 具备可核查证据（当前均为 `PASS candidate`）；先澄清 §6 第 1 项「撤权」口径，避免把 D4-04 结论升级为已封板。
- **可检查的完成标准**：Gate 落盘 artifact，且满足——关联链每个 Task/Step/Call/Artifact/Verification 均可从权威存储回溯；`AUTO_RETRY=0`；预算到限产生可解释的停止事件且产物保留、续接入口明确；artifact 绑定当轮 commit。

## 8. 本轮修改文件与实际执行的检查

**修改文件**：仅本文档 `docs/D4-04-ACCEPTANCE-RESULT.md`（新增，纯文档）；**未改任何产品代码、未改测试、未改 PROGRESS/PLAN**。

**本轮实际执行（d4-01 worktree 内）**：
1. `git status / branch / rev-parse / log / worktree list`：确认基线、分支、工作区、各 worktree。
2. `git fetch origin feature/d4-03-tool-proxy`：确认远端同步 `0 0`。
3. 只读核对 `electron/runtime-boot.cjs`、`electron/executor-launcher.cjs`、`electron/main.cjs`、`electron/runtime-supervisor.cjs`、`electron/side-effect-runtime.cjs`、`tests/fixtures/d4-04-probe/main.cjs`、`tests/d4-04-smoke.mjs`、`tests/d4-04-closure2-boot.test.mjs`。
4. **重跑** `node --test tests/d4-04-closure2-boot.test.mjs` → **9/9 PASS**（同环境：Node v22.22.3、Electron 44.3.0），用于 §3 三项确认。

**未重跑项及复用依据**：
- `npm run test:d4-04`（44/44）：**未重跑**。复用依据：§5 时间线证明 artifact 与基线提交 `67357ef` 同源，且 worktree 干净。测试记录位置：`artifacts/d4-04/vertical-smoke-gate.json` + `docs/D4-04-CLOSURE2-RESULT.md`。
- `npm test`（911/911）、`npm run build`（PASS）、`npm run test:security`（FAIL 0 / PARTIAL 2 / PASS 6）：**未重跑**，复用 `docs/D4-04-CLOSURE2-RESULT.md` §Regressions 记录。
- D4-03C1/C2/C3/C4/03D 及 D4-01/02 各回归：**未重跑**，复用同上记录。

## 9. 诚实边界

- 本轮是**验收与文档收口**，不是新实现；未以任何方式把 `PASS candidate` 升级为 `PASS`，未把测试环境等价性写成真实 `main.cjs` 全流程已实测。
- D4-04 Gate 的实际运行宿主是 probe host（产品 preload + 产品 dist Renderer + 共享 production 装配），不是真实 `electron/main.cjs`。
- 所有 `NOT VERIFIED` / `DEFERRED` 项保持原状。
