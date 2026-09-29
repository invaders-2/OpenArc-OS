# D5-03 第九批 · 启动超时不再冒充执行超时（错误归属）+ 取消测试按可观察阶段等待

状态：**已实现并完成独立验收（node 真实分类链路 + 真机 Electron 界面三轴）** —— 2026-09-29 独立验收（报告 `experiments/d5-03/batch9/verify/BATCH9-VERIFY-REPORT.md`，证据目录 `experiments/d5-03/batch9/verify/` 附 `MANIFEST.sha256`；执行方报告 `experiments/d5-03/batch9/D5-03-BATCH9-REPORT.md`）：两种错误码走真实分类路径 **60 项检查 = 59 PASS + 1 条「必须变红」按预期红（exit 0）**；界面真机验收 runId `20260929T094444Z-3a33-batch9-harness-timeout-ui` **75/75 exit 0**（浅 / 深 / 深色减少动态共 5 个场景、20 张截图）；受影响门禁只有 `test:d4-02c` → **26/26 exit 0**；全量 `npm test` **1387 tests / 1385 pass / 2 fail / exit 1**（2 条既有确定性失败，逐条列名）；**本批 `src/**` 0 行改动**（视觉 / 动效 = 通过；界面可见文案随错误码变化）。

* **判定：D5-03 第九批（启动超时错误归属 + 取消测试按可观察阶段等待）= PASS（限定范围：两项收口成立；2 条既有确定性失败与 R1 / R2 遗留如实单列）；D5-03 整体仍 = PARTIAL**（剩余缺口见 §7 / §8 / §9 / §11）。
* 被测内容 = 提交 `f9133f5d5b8cc4af30c3ca96ee66e0f3c8d39422`（`f9133f5`，父提交 `668238e`）：**24 个文件 `+18989 / −25`**，其中**产品 / 测试改动面 = 7 个文件 `+345 / −25`**（见 §1），其余 17 个为 `experiments/d5-03/batch9/**` 证据文件；**`src/**` 0 行**（`git diff --stat 668238e f9133f5 -- src/` 为空）。
* 验收证据提交 = `d2d928131e0655d9ec8e768f52a49b9cc55d6cad`（`d2d9281`，**当前 HEAD**）：22 个文件 `+15670 / −0`，全部在 `experiments/d5-03/batch9/verify/**`（含探针宿主 `harness-timeout-ui-probe/`）；`artifacts/` 被 `.gitignore:3` 忽略，run 产物不入提交。
* **当前有效证据 = 第九批 runId + 两种码探针 + 复用门禁证据**：`experiments/d5-03/batch9/verify/`（`batch9-01-codes-probe.json` 两种码探针、`batch9-02-ui-acceptance.mjs` 真机界面验收 → runId `20260929T094444Z-3a33-batch9-harness-timeout-ui`、`batch9-03-affectedness.json` 机械受影响性分析、`04-gate-d4-02c.txt` 重跑门禁、`05-npm-test-full.txt` 全量、`batch9-04-r1-observation.json` R1 观察、`batch9-05-residue-integrity.json` 残留与索引完整性）；**复用门禁证据**（其余 32 个门禁，机械判据「改动分支不可达」，逐条依据见验收报告 §3.1）。
* 本批决策 = 本文件；结果正文 = `docs/D5-03-RESULT.md` 第九批节；进度 = `PROGRESS.md` 第九批节；tracked 证据 = `docs/D5-03-GATE-EVIDENCE.json` 的 `batch9` 段（**纯插入**：旧段逐字节 / 逐键未改）。
* 被测工作区：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`）。未 push、未合并 main、未切分支；验收提交后工作树干净（`git status --porcelain` 为空）。

## 1. 被测内容、提交链与证据口径披露（必读）

| 项 | 值 |
| --- | --- |
| 分支 / HEAD | `integration/ui-core`，现行 HEAD = `d2d928131e0655d9ec8e768f52a49b9cc55d6cad`（`d2d9281` = 验收证据提交） |
| 提交链 | `668238e`（前批定稿）→ **`f9133f5`（被测提交，单个提交）** → **`d2d9281`（独立验收证据提交，单个提交）**；`git log --oneline 668238e..f9133f5` = **1 行**；未 merge main |
| 产品 / 测试改动面（7 个文件 `+345 / −25`） | `electron/task-domain.cjs` `+2/−0`（新增枚举成员）；`electron/task-harness-orchestrator.cjs` `+1/−1`（分类器一行）；`tests/task-harness-orchestrator.test.mjs` `+137/−1`（两码正反例 + 真实 IPC 入口断言）；`tests/task-harness-cancel.test.mjs` `+156/−23`（等阶段机制改造，判据未放宽）；**新增 3 个夹具探针** `tests/fixtures/harness-acp/{start-hang-agent,turn-hang-agent,session-new-hang-agent}.mjs` `+8 / +22 / +19` |
| 界面代码改动 | **0 行**：`git diff --stat 668238e f9133f5 -- src/` 为空；本批**未加**「错误码 → 人话」映射，可见文案变化是 `[data-ai-error]` **原样渲染错误码**的既有行为（§4） |
| 证据口径 | 本批**有 runId**（界面真机验收 `…-3a33`）**且**有机器可读汇总 JSON（`experiments/d5-03/batch9/verify/batch9-01-codes-probe.json` / `batch9-03-affectedness.json` / `batch9-04-r1-observation.json` / `batch9-05-residue-integrity.json` + run artifact `batch9-harness-timeout-ui.json`）；计数一律取真实 TAP / 真实 run artifact 的 exit code，未实测项进 §8 notVerified |
| 界面验收产物 | runId `20260929T094444Z-3a33-batch9-harness-timeout-ui`，**75/75 · exit 0 · notVerified 0**；artifact sha256 `7ed60d0be05c80790d53f2d285814bf27b00af739fe523ec746a23a356f77d56`；`testedCommit` = `f9133f5…`；脚本 sha256 `bcad56796543d7e41541218d6e4a5926941ca9fb19d348ba605091ea73687904`；20 张截图逐文件 sha256 记在 artifact `screenshots[]` |
| 本批新增 run 目录（如实登记） | 定稿前有 **5 个调试 / 中途版本**：`…-0dc2`（exit 2，counts 0/0/0）、`…-1244`（exit 2，2/3）、`…-fccc`（exit 2，2/2）、`…-a352`（exit 1，73/74）、`…-2a0e`（**exit 0，75/75，已被 `…-3a33` 取代**）；另有 `…-be39` **空目录**（一次被中断的尝试，未 finalize，不在 `index.json`）。定稿 = `…-3a33`（75/75，exit 0） |
| 索引完整性（验收方复核） | `artifacts/d5-03/runs/index.json` **81 条**（sha256 `a83c1ec0704e623605b265411c06334e2d36fc354b6286d5ecc8f8cd27d65266`）逐条复查 artifact 与 log 摘要：**0 条不一致**；近 3 小时被改动的文件**仅本批 6 个 run 目录 + `index.json` / `index.jsonl`**（索引追加属设计行为）→ **历史 run 产物未被改写** |

## 2. 决策一：启动超时保留原始错误码（新增 `ERROR.HARNESS_START_TIMEOUT`）

**本批唯一的产品语义改动 = 分类器一行**：`electron/task-harness-orchestrator.cjs:101` 不再把 adapter 抛出的 `HARNESS_START_TIMEOUT` 改写成 `HARNESS_TURN_TIMEOUT`，而是**原样返回**；同时 `electron/task-domain.cjs` 的 `ERROR` 冻结枚举新增成员 `HARNESS_START_TIMEOUT: "HARNESS_START_TIMEOUT"`（位于 `HARNESS_* ` 族内）。修复前是「**启动超时冒充执行超时**」——错误码不精确、失败无法归因。

### 2.1 完整路径（逐跳 文件:行）

| # | 跳 | 位置 | 事实 |
| --- | --- | --- | --- |
| 1 | 错误码定义（adapter 侧） | `electron/harness-adapter.cjs:29` | `START_TIMEOUT: "HARNESS_START_TIMEOUT"`（`HARNESS_ERROR` 枚举） |
| 2 | 抛出点 | `electron/harness-adapter.cjs:272-275` | `#withTimeout(this.conn.initialize({...}), startTimeoutMs, HARNESS_ERROR.START_TIMEOUT)` —— 只有 **ACP initialize** 受启动预算约束（`:278` 的 `newSession` 无上界 = R1，见 §10） |
| 3 | 超时实现 | `electron/harness-adapter.cjs:321-325` / `:90` | `#withTimeout` = `Promise.race` + `setTimeout(reject)`；`harnessError(code)` 造出 `e.code` |
| 4 | 预算来源 | `electron/task-harness-orchestrator.cjs:31-32` → `:110/:126` → `:235` | `DEFAULT_START_TIMEOUT_MS = 30000` / `DEFAULT_TURN_TIMEOUT_MS = 180000`，经构造参数注入 `adapter.start(...)`；**预算未动**（§3） |
| 5 | 编排器捕获（撤销能力 + dispose） | `electron/task-harness-orchestrator.cjs:236-240` | catch → `revokeToolCapability()` / `revokeModelCapability()` / `await adapter.dispose()` + `facade.bridge.stop()` → `#blockStep({ reason: classifyHarnessError(e), event: HARNESS_RUN_UNKNOWN_EFFECT })` |
| 6 | **分类（本批修复点）** | `electron/task-harness-orchestrator.cjs:96-107`（原 `:101`） | 修复前：`if (code === "HARNESS_START_TIMEOUT") return ERROR.HARNESS_TURN_TIMEOUT;`；修复后：返回 `ERROR.HARNESS_START_TIMEOUT` |
| 7 | 领域枚举（新增） | `electron/task-domain.cjs:131-135` | 新增成员（`HARNESS_PROCESS_EXITED` 与 `HARNESS_TURN_TIMEOUT` 之间）；**schema / `SCHEMA_VERSION` 未动**（§3） |
| 8 | 步骤 / 任务终态 + 事件 | `task-harness-orchestrator.cjs:720-727` `#blockStep` → `task-service.cjs:592-618` `blockStep` | Step → **BLOCKED**（`:606`）、Task → **BLOCKED**（`:613`）；事件 `harness.run.unknown_effect`（`:608`，reason = 该码）、`step.blocked`（`:609`）、`task.blocked`（`:615`） |
| 9 | run 行 + 停因 | `task-harness-orchestrator.cjs:725` → `task-service.cjs:565` `blockHarnessRun({errorCode: reason, stopReason: "blocked"})` → `:539-562` | run.status=`BLOCKED`、`error_code` = 该码、`stop_reason` = `"blocked"`（`:555-556`）；事件 `harness.run.blocked`（`:559`，safePayload `{runId, stepId, status, stopReason, errorCode}`） |
| 10 | 事件读取 | `task-service.cjs:445-450` `getEvents`（→ `task-domain.cjs:343-346` `safeEvent`） | **事件是唯一持久化的失败事实来源** |
| 11 | 日志 | — | **没有独立日志 sink**：`orchestrator.logger` 只透传给 `ToolFacadeBridge` / model bridge（`task-harness-orchestrator.cjs:123/:646`），**不落 harness 错误码**；失败事实只存在于 task events + `task_harness_runs.error_code/stop_reason` 行 |
| 12 | 停因投影（后端） | `task-service.cjs:780-823` `#resumeAssessment` | `:798` `runBudgetStop = error_code === BUDGET_EXHAUSTED` → 启动超时为 false；`:802` `stopReason = lastRun.error_code \|\| lastRun.stop_reason` = `HARNESS_START_TIMEOUT`；`:815` 拒绝原因 `NOT_BUDGET_STOP`；`:821` `resumable` 保持 **false** |
| 13 | IPC 投影 | `task-bootstrap.cjs:152-183` `task/get`（`:175` resumable / `:176` stopReason）；`:119-130` `emitResult`（`:128` `error: r.error`）→ `main.cjs:470` `win.webContents.send("task:event", event)`（注册 `:464-471`） | 后端 → 渲染层的唯一通道 |
| 14 | 渲染层 | `preload.cjs:141-147` → `src/desktop/components.tsx:932-944`（`:939` `setError(ev.error)`；`:941` 再拉 `task/get` → `:871-885` `applyTaskState`，`:881` `setStopReason`） | `:1009` 状态文字；`:1010` `[data-ai-error] · {error}`；`:1012-1014` `[data-ai-stop-reason]`（**仅 `resumable` 时渲染**） |

### 2.2 消费方排查（全仓）

| 位置 | 用法 | 结论 |
| --- | --- | --- |
| `electron/harness-adapter.cjs:26-34` | 两个码的**生产端** | 不改：两码各自真实抛出 |
| `electron/task-harness-orchestrator.cjs:96-107` | 唯一分类器 | **本批唯一产品语义改动** |
| `tests/harness-acp-cancel.test.mjs:29-52` | adapter 层：turn timeout → `HARNESS_TURN_TIMEOUT` | 不改：执行超时仍必须是 TURN_TIMEOUT 的既有反例 |
| `tests/task-harness-orchestrator.test.mjs:32,151-158` | stub adapter 抛 TURN → 断言 TURN | 不改 |
| `tests/d4-03-run-entry-guard.test.mjs:182,185,222`、`tests/d4-09-append-step.test.mjs:305` | 直接给 `blockStep/blockHarnessRun` 传 reason 字符串造状态 | 不改：夹具用法，与分类器无关 |
| `tests/task-harness-cancel.test.mjs:31`、`tests/task-harness-recovery.test.mjs:29`、`tests/d4-03-model-binding.test.mjs:625,632,728` | 各自取合法停因码 / `notEqual` | 不改 |
| 渲染层 / 全仓 | **不按码分支**；无 `ERROR` 枚举整体遍历；停因只特判 `BUDGET_EXHAUSTED` | 故启动超时仍 `resumable=false`、不出现恢复块 |

**结论：没有任何既有断言需要修改**——错的是**产品映射**，不是断言（§6 断言变更清单 = 无）。

## 3. 决策二：预算与 schema 一字未动

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 启动预算 | `DEFAULT_START_TIMEOUT_MS = 30000`（`electron/task-harness-orchestrator.cjs:32`）**未改**；测试只**注入**更小值（1200 / 700 / 4000ms） | 验收 A5 断言默认值；`git diff` 只见 `:101` 一行 |
| 执行预算 | `DEFAULT_TURN_TIMEOUT_MS = 180000`（`:31`）**未改** | 同上 |
| schema / `SCHEMA_VERSION` | 仍 **21**（`electron/identity-store.cjs:68`）；`task-store.cjs` 的 `error_code` / `stop_reason` 是自由 TEXT 列（无 CHECK 约束）→ 新增枚举成员**无需迁移** | `test:d4-02c` 门禁产物计数行 `schemaVersion:21`；`git diff --stat` 不含任何 store / migration 文件 |
| 等待窗口（测试侧） | `tests/task-harness-cancel.test.mjs` 上界 = 产品预算 `30000` + 余量 `START_MARGIN_MS = 15000`（`:15-17`，注释写明来源）；**产品预算若调整，该常量需同步** | §5 |

## 4. 界面影响（如实：只变一个字符串，且未改 `src/**`）

### 4.1 会变 / 不会变

* **会变的可见文案**：`[data-ai-error]`（`src/desktop/components.tsx:1010`）**原样渲染错误码** —— 启动超时场景由 `· HARNESS_TURN_TIMEOUT` 变为 `· HARNESS_START_TIMEOUT`（20 → 21 字符）。链路：`task-bootstrap.cjs:128` → `main.cjs:470` → `preload.cjs:145` → `components.tsx:939` → `:1010`。既有 e2e 已证明这种「原样显示错误码」行为（`tests/d4-main-e2e.mjs:1159-1163` 断言 `[data-ai-error]` 含 `MODEL_CONFIG_CHANGED`）。
* **不会变的**：状态文字（`:1009`，`BLOCKED · Recovery Required`，因 `resumable=false`）；`[data-ai-stop-reason]`（`:1012` 起整块**只在 `resumable=true` 渲染 → 启动超时该节点不出现**）；恢复块 `[data-ai-recovery]`（`:1026` 要求 `recovery.applicable`）；验证失败块；按钮可用性。
* **未加任何「错误码 → 人话」映射**，`src/**` 零改动；node 层已用**真实 IPC 入口**断言渲染层可见载荷（`tests/task-harness-orchestrator.test.mjs:282-311`：`task/result.error` / `task/get.stopReason` = 该码、`resumable === false`）。

### 4.2 真机界面验收（浅 / 深 / 减少动态，三轴分列）

证据：runId `20260929T094444Z-3a33-batch9-harness-timeout-ui`（**75/75 · exit 0**）。隔离：独立 runId 目录 + `acquirePort` 独占探测 + **只清自己 pid 树**（`strategy=own-pid-tree-only, pkillUsed=false, leftovers=[]`）+ 串行。基准：与既有任务界面门禁探针族一致 `new BrowserWindow({width:1360,height:900})`，内容区 1360×868、dpr=2、产品无 `setZoomFactor`（缩放 100%）。

| 轴 | 结论 | 依据 |
| --- | --- | --- |
| **功能** | **通过** | 真实 UI 输入 → 真实 `task/run` → 真实分类器 → `[data-ai-error]` 显示两种码；状态文字 `BLOCKED · Recovery Required`；无 `[data-ai-stop-reason]` / 恢复块 / 验证块；后端 facts 与界面一致（`task/result {error:"HARNESS_START_TIMEOUT", status:"BLOCKED"}` + `facts {...}`） |
| **视觉** | **通过** | 5 场景（浅·两种码 / 深·两种码 / 深色+减少动态）各 4 张截图（窗口 / 状态行 / 面板 / 对比度）；两种码只差 1 字符 → 错误行矩形 / 状态行容器 / 按钮矩形**完全相同**，错误行 **2 行**，`clientWidth == scrollWidth`（**无横向溢出**），祖先链到 body 全 `horizontalOverflow=false`，剩余余量 **108.88px**；对比度 **浅 8.208:1 / 深 16.62:1**（14px / 400 → 按 `DESIGN_SYSTEM.md:248` 普通文本门槛 **4.5:1**）；量测用「背景取众数（合成后真实表面）+ 与背景亮度差最大像素」并按计算样式复核（`DESIGN_SYSTEM.md:251` / 文字 `text.primary` `:63`） |
| **动效** | **通过** | 该行 `animationName=none` / `transitionDuration=0s`（浅 / 深 / 减少动态）；减少动态下元素作用域 `--dur-quick=0ms`（根作用域仍 `.16s`，符合 `MOTION_SYSTEM.md:21`）；`dark-turn-state-row.png` 与 `dark-reduced-turn-state-row.png` **sha256 完全相同**（`22f44dce143f63a7…`）；机械证明：本批 `src/**` **0 行改动** → 结构上不可能新增 CSS 动效。如实说明：`.ai-panel` 自身有**既有** `animation: appear var(--standard)`（`src/styles.css:1381`，面板入场），非本批、非该行 |

## 5. 决策三：取消测试按「产品可观察阶段」等待（不调大魔数窗）

* **旧实现的缺陷**：`tests/task-harness-cancel.test.mjs:84-99` 用固定 `deadline = Date.now() + 20000` 的魔数窗等 `fx.fp.state.requests >= 1`；超窗后**不检查任何阶段**就继续 cancel，失败信息退化成 `0 !== 1`（第八批 W49 实测 `duration_ms 51723`）。同文件 `:24-26`（Cancel E2E）有同形魔数窗。
* **新实现**：`waitForProviderRequest`（`:90-114`）等待的是**产品可观察阶段**（`requests >= 1` 为成功；期间用单调时钟记录 `phase:child-spawned` / `phase:session-created` / `phase:harness-running` / `phase:provider-request`）；上界 `WAIT_LIMIT_MS = PRODUCT_START_TIMEOUT_MS(30000) + START_MARGIN_MS(15000) = 45000`（**与产品常量成对**，不是新的魔数）；超限或产品先收敛 → `failWithTimeline`（`:116-127`）打印**完整阶段时间线 + 宿主负载（loadavg / CPU / 进程数 / 内存）+ 产品状态（task.status / run.status/errorCode/stopReason）**。
* **判据一字未放宽**：`requests === 1`（`:163/:228`）、`getCalls().items.length === 1`（`:229`）、`CANCELLED` 终态与 capability `REVOKED`（`:149-167`）全部保留；**未 skip / 未删除**；无 `<=` / 0 次放行。
* **实测**：单跑 **5 次 × 3 用例全过 exit 0**（启动阶段 677.7–1032.7ms，请求发起距 `start:done` 仅 90–170ms）；6 路并发压测（loadavg ≈ 46）**6/6 实例 × 3 用例全过**；全量 2 次 + 验收全量 1 次中 cancel 三用例均绿 → **第八批那条环境型 flake 未再出现**，且 **W49 记录的「0 次请求」未复现**。
* 已排除（有实测证据）：不是「provider 慢 / 请求迟迟不来」、不是 ACP 握手固有慢、不是 cancel 路径、不是测试等待逻辑自身产物；**未复现即不下「已证实是负载」的结论**。

## 6. 数字（分列，全部来自真实运行输出与 exit code）与断言变更清单

| 面 | 结果 | 证据 |
| --- | --- | --- |
| **两种码探针（真实分类链路）** | **60 项检查 = 59 PASS + 1 条「必须变红」按预期红（`unexpectedGreen 0`），exit 0**：启动阻塞 → `HARNESS_START_TIMEOUT`（BLOCKED ×3、0 prompt / 0 请求 / 0 call、capability 全 `REVOKED` + 旧 token 401、有界 1268ms ≈ 1.06× 注入预算、0 孤儿）；执行阻塞 → `HARNESS_TURN_TIMEOUT`（恰好 1 prompt / 1 call、`FAILED`、有界 1254ms） | `batch9-01-codes-probe.json` / `01-codes-probe.stdout.txt` |
| ↳ 反向验证（只改副本） | 副本把映射改回旧写法（只一行，其余逐字相同，副本 sha256 `e1221a42…`）→ `classifyHarnessError(START)` = `HARNESS_TURN_TIMEOUT`；启动用例 `[EXPECTED-RED]` **实际 `HARNESS_TURN_TIMEOUT`**（run 行同错）；执行用例仍绿（外科式）；产品源码 sha256 前后一致 `aa6142e1…`；副本已删除 | 验收报告 §1.3 |
| ↳ 竞争（取消 vs 超时，各一例） | 两例终态一致且**唯一 `CANCELLED`**（无翻转 / 无双终态）、task 终态 == run 终态、**0 孤儿**、能力全 `REVOKED` + 401、取消后 `runTask` 返回 `TASK_REVISION_CONFLICT`（**fail-closed**：取消后无任何 post-cancel mutation） | 验收报告 §1.4 |
| **受影响门禁（机械分析）** | **只有 `test:d4-02c` 真受影响**（闭包加载两个改动模块且**可达改动分支**——唯一产生启动超时的夹具 `start-hang-agent.mjs` 全仓只被 `tests/task-harness-orchestrator.test.mjs` 使用，而该文件只被这一个门禁执行）→ 重跑 **26/26 · exit 0**（duration 33656ms；计数行含 `schemaVersion:21`）；其余 32 个门禁机械判为**分支不可达**，复用证据并写清依据（含「产物无被测 commit 戳」的诚实说明） | `batch9-03-affectedness.json` / `04-gate-d4-02c.txt`；`artifacts/d4-02c/d4-02c-gate.json` |
| **真机界面验收** | `…-3a33` **75/75 · exit 0**（三轴见 §4.2） | run artifact `7ed60d0b…` |
| **全量 `npm test`（验收轮）** | **1387 tests / 1385 pass / 2 fail / cancelled 0 / skipped 0 / todo 0，exit 1**；失败**恰好 2 条且均为既有确定性失败**（逐条见下）；**无新失败**；本批相关用例全绿（`ok 1181-1184` 两码分类 / 启动 / 执行 / 真实 IPC；`ok 1166-1168` cancel E2E / race / 无 retry——第三条 = 改造后的等阶段机制，**未复现** W49 的 0 次请求） | `05-npm-test-full.txt`（sha256 `874ca4b0…`） |
| ↳ 既有失败 1（未修，单列） | `P2 · 当前会话 = A（owner）：推送投递，载荷 = 白名单投影且与 getApprovalRequest 一致`（`tests/d4-03-approval-push-isolation.test.mjs:94`，断言 `:103`）：actual 比 expected 多 `targetRef` / `url` | 同上 |
| ↳ 既有失败 2（未修，单列） | `No Direct Domain Bypass：resource.trash 的唯一 Domain 调用点在 allowlisted adapter + controlled execution 内`（`tests/side-effect-c4-gates.test.mjs:444`，断言 `:474`）：`主进程绝不 in-process 执行 write` expected true actual false | 同上 |
| **断言变更清单** | **无**：**本批没有任何既有断言需要修改**（错的是产品映射）。**新增断言**：`tests/task-harness-orchestrator.test.mjs` 的两码正反例（`:194-197`、`:213-214` / `:253-254`）与真实 IPC 入口对渲染层可见载荷的断言（`:299-309`）；`tests/task-harness-cancel.test.mjs` 的等阶段机制（**判据未变**）。**反向验证**：修复前新用例为红（真实链路得到 `HARNESS_TURN_TIMEOUT`，`00-prefix-orchestrator-test.txt` 2 fail） | 执行方报告 §三；验收报告 §1.3 |

**两码口径（全文一致）**：`HARNESS_START_TIMEOUT` 只作**当前事实**（真实抛出、原样分类、原样显示）；「`HARNESS_START_TIMEOUT` → `HARNESS_TURN_TIMEOUT`」的旧映射只作**被本批订正**的历史口径出现；执行超时仍 `HARNESS_TURN_TIMEOUT`（未放宽、未改名）。

## 7. notVerified（未验证项，逐条不美化）

| # | 项 | 原因 |
| --- | --- | --- |
| 1 | **R2 竞争后 in-flight model call 的最终归宿** | 取消后 1.5s 观测到该 call 行仍 `STARTED`（非终态）；未观测更长时间后是否被终结。属既有 cancel 路径，非本批改动面 |
| 2 | **R1 场景的界面表现** | R1（`session/new` 无界）在界面上会长期停在「运行中」；本批**未做该场景实机截图**（不影响两种错误码的界面验收） |
| 3 | **`providerErrorCode` 语义** | 执行超时时 model call 行记录 `providerErrorCode = HARNESS_TURN_TIMEOUT`；该字段名为 provider 侧语义而实际装的是 harness 超时码 —— 本批只如实记录，**未判定是否为缺陷** |
| 4 | **复用门禁证据强度** | §6 表中「分支不可达」的 32 个门禁沿用**早于本批的运行产物**，产物**不含被测 commit 戳**；复用依据是**机械不可达证明**（同代码同环境仍有效），**未重跑**。其中 `test:d4-02a` 闭包只加载 `task-domain.cjs` 的**新增枚举**，同样按「不受影响」处理、未重跑 |
| 5 | **极端窄窗口** | 面板宽度固定 350px；本批未做窗口 **< 1000px**（产品 `minWidth`）的实测 |
| 6 | **`openarc-resource` / `openarc-canvas` 协议** | 探针宿主只接入了 `openarc-file`（AI 球原生素材）；另两个协议未接入（本次未触发相关控制台错误 / 请求失败） |

## 8. 遗留

1. **R1（新登记的产品面遗留，本批未修）**：`electron/harness-adapter.cjs:278` 的 `newSession` **无任何超时**（启动预算 `:272-275` 只包 ACP `initialize`）。受控实验：注入 `startTimeoutMs=700`、探针 `session-new-hang-agent.mjs`（initialize 正常回、`session/new` 不回）→ **8s 观察窗内不收敛**（run=`STARTING` / task=`RUNNING` / 0 请求 / 0 prompt / 子进程存活）；对照（`initialize` 阻塞）`+757.0ms` 即收敛（`HARNESS_START_TIMEOUT`）。`harness-adapter.cjs` 不在本批授权写入面 → **未改**。
2. **R1-e（本次新增的附加发现，未修）**：该无界段里 `orchestrator.dispose()` / `cancel()` **触达不到 adapter** —— `task-harness-orchestrator.cjs:241` 的 `registry.set(...)` 在 `adapter.start()` **返回之后**才登记，而 `dispose()`（`:824-831`）与 `cancel()`（`:746`）都只遍历 `registry`；实测 dispose 后子进程仍存活（ps 状态 `S`，对照场景为 `gone`），**只在主进程退出后消失**（脚本退出后复查 0 残留）。
3. **R2 竞争账本残留（本次观测，未修）**：取消竞争中 in-flight model call 行可停在 `STARTED`（其最终归宿 = §7 第 1 条 notVerified）。
4. **两条既有确定性失败**（`d4-03-approval-push-isolation` 的 P2、`side-effect-c4-gates` 的 No Direct Domain Bypass）：按要求**未修**，如实单列。
5. **`START_MARGIN_MS = 15000` 与产品预算成对**（`tests/task-harness-cancel.test.mjs:15-17`）：它是「上界与产品预算挂钩」的实现方式，不是新魔数窗；**产品未来调整 `DEFAULT_START_TIMEOUT_MS` 时该常量需同步**。
6. **本批新增的调试 / 中途 run 目录如实登记**（§1 表）：`…-0dc2` / `…-1244` / `…-fccc`（均 exit 2）、`…-a352`（exit 1，73/74）、`…-2a0e`（exit 0，75/75，已由 `…-3a33` 取代）+ `…-be39` 空目录（未 finalize，不入索引）；历史 run 产物未被改写（索引逐条复核 0 不一致）。

## 9. 继续单列（不并入本批）

**跨组织真机 2 条 notVerified**、**OAuth**（仅 `NONE` / `BEARER`）、**两条既有探针门禁失败**（`governance-ui` **1/5**、`model-keychain-restart` **3/15**，第六批已 A/B 实证为既有失败）、**插件隔离（D5-08）**、**D5-02 重命名受 Electron 不支持 `prompt()` 限制**、**SIGKILL 边界**；**本批未新增「创建组织」入口**。

## 10. 与第八批决策文档的关系（就地加注，原文未删）

`docs/decisions/D5-03H-dsh-runtime-pinning.md` 的 §6 裁定 1/3、§7 flake 归因尾巴、§10 遗留 1/2、§12 判定把「保留原始错误码」「cancel 20s 窗口」登记为**留给单独批次的选项**；**第九批即该选项 A/B 中「保留原始错误码」的实施 + cancel 等待改造的实施**，已就地在原行加【第九批已实施：…】/【第九批已更新：…】写明结果，**原文一字未删**。

## 11. 判定

* **D5-03 第九批（启动超时错误归属 + 取消测试按可观察阶段等待）= PASS（限定范围）**：`HARNESS_START_TIMEOUT` 成为独立错误码并走真实分类路径（60 项检查 = 59 PASS + 1 条按预期红；反向验证、竞争两例、能力撤销 / 401、有界停止、0 孤儿全部成立）；界面真机 **75/75**（功能 / 视觉 / 动效三轴分别通过，对比度 8.208:1 / 16.62:1 ≥ 4.5:1，无溢出，无新增动效）；取消测试等待产品可观察阶段且**判据一字未放宽**；受影响门禁只有 `test:d4-02c`（**26/26 exit 0**），其余 32 个按机械不可达复用证据。
* **全量 `npm test` = exit 1（1387 / 1385 / 2）如实呈现**：**2 条既有确定性失败**逐条列名，**无新失败**；第八批那条环境型 flake **未再出现**，W49 的「0 次请求」**未复现**；**未调宽超时预算、未改断言**。
* **D5-03 整体仍 = PARTIAL**：剩余缺口 = §7 notVerified + §8 遗留逐条（R1 / R1-e / R2 / 2 条既有失败 / `START_MARGIN_MS` 同步 / 调试 run 目录）+ §9 继续单列项。
* tracked 证据：`docs/D5-03-GATE-EVIDENCE.json` 的 `batch9` 段（**纯插入**：旧段逐字节 / 逐键未改）；本批决策 = 本文件；结果正文 = `docs/D5-03-RESULT.md` 第九批节；进度 = `PROGRESS.md` 第九批节；独立验收报告 = `experiments/d5-03/batch9/verify/BATCH9-VERIFY-REPORT.md`；执行方报告 = `experiments/d5-03/batch9/D5-03-BATCH9-REPORT.md`。
