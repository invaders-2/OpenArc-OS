# D5-03 第九批 · 执行岗结果（两项收口）

工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`，基线 HEAD `668238e`，工作树原本干净）
本批可写面：`electron/task-domain.cjs`、`electron/task-harness-orchestrator.cjs`、`tests/**`、`experiments/d5-03/**`。**未改 `src/**`**，未跑 Electron 门禁，未动 DSH 共享运行时 / `~/.dsh`，未 push / 未切分支。

---

## 一、目标一：保留准确的「启动超时」原因

### 1.1 完整路径追溯（逐跳 文件:行）

| # | 跳 | 位置 | 事实 |
|---|---|---|---|
| 1 | 错误码定义（adapter 侧） | `electron/harness-adapter.cjs:29` | `START_TIMEOUT: "HARNESS_START_TIMEOUT"`（`HARNESS_ERROR` 枚举） |
| 2 | 抛出点 | `electron/harness-adapter.cjs:272-275` | `#withTimeout(this.conn.initialize({...}), startTimeoutMs, HARNESS_ERROR.START_TIMEOUT)` —— 只有 **ACP initialize** 受启动预算约束 |
| 3 | 超时实现 | `electron/harness-adapter.cjs:321-325` | `#withTimeout` = `Promise.race(promise, setTimeout(reject))`；`harnessError(code)` 在 `:90` 造出 `e.code` |
| 4 | 预算来源 | `electron/task-harness-orchestrator.cjs:32` `DEFAULT_START_TIMEOUT_MS = 30000` → `:110/:126` 构造参数 → `:235` `adapter.start({ ..., startTimeoutMs: this.startTimeoutMs, ... })` | 预算**未改动**（本批禁止改预算） |
| 5 | 编排器捕获 | `electron/task-harness-orchestrator.cjs:236-240` | catch → `adapter.revokeToolCapability()` / `revokeModelCapability()` / `await adapter.dispose()` + `facade.bridge.stop()` → `#blockStep({ reason: classifyHarnessError(e), event: TASK_EVENT.HARNESS_RUN_UNKNOWN_EFFECT })` |
| 6 | 分类（**错配点**） | `electron/task-harness-orchestrator.cjs:96-107`，原 `:101` | 修复前：`if (code === "HARNESS_START_TIMEOUT") return ERROR.HARNESS_TURN_TIMEOUT;` —— 启动超时被改写成执行超时。修复后：返回 `ERROR.HARNESS_START_TIMEOUT` |
| 7 | 领域枚举（新增） | `electron/task-domain.cjs:131-135` | 新增 `HARNESS_START_TIMEOUT: "HARNESS_START_TIMEOUT"`（HARNESS_* 族内，位于 `HARNESS_PROCESS_EXITED` 与 `HARNESS_TURN_TIMEOUT` 之间）。**schema / `SCHEMA_VERSION` 未动**（见 §四） |
| 8 | 步骤/任务终态 | `electron/task-harness-orchestrator.cjs:720-727` `#blockStep` → `electron/task-service.cjs:592-618` `blockStep` | Step → **BLOCKED**（`:606`）、Task → **BLOCKED**（`:613`）；事件 `harness.run.unknown_effect`（`:608`，safePayload.reason）= 该码、`step.blocked`（`:609`）、`task.blocked`（`:615`） |
| 9 | run 行 + 停因 | `electron/task-harness-orchestrator.cjs:725` → `electron/task-service.cjs:565` `blockHarnessRun({ errorCode: reason, stopReason: "blocked" })` → `:539-562` `#runTransition` | run.status=`BLOCKED`、`error_code` = 该码、`stop_reason` = `"blocked"`（`:555-556`）；事件 `harness.run.blocked`（`:559`，safePayload 含 `{runId, stepId, status, stopReason, errorCode}`） |
| 10 | 任务事件读取 | `electron/task-service.cjs:445-450` `getEvents`（→ `task-domain.cjs:343-346` `safeEvent`） | 事件是唯一持久化的失败事实来源 |
| 11 | 日志 | 无独立日志 sink：`orchestrator.logger` 只透传给 `ToolFacadeBridge` / model bridge（`task-harness-orchestrator.cjs:123/:646`），**不落 harness 错误码**；失败事实只存在于 task events + `task_harness_runs.error_code/stop_reason` 行 |
| 12 | 停因投影（后端） | `electron/task-service.cjs:780-823` `#resumeAssessment` | `:798` `runBudgetStop = error_code === BUDGET_EXHAUSTED` → 启动超时为 false；`:802` `stopReason = lastRun.error_code || lastRun.stop_reason` = `HARNESS_START_TIMEOUT`；`:815` 拒绝原因 `NOT_BUDGET_STOP`；`:821` `resumable` 保持 false |
| 13 | IPC 投影 | `electron/task-bootstrap.cjs:152-183` `task/get`：`:176` `stopReason`、`:175` `resumable`；`:119-130` `emitResult`：`:128` `error: r.error` → `electron/main.cjs:470` `win.webContents.send("task:event", event)`（注册于 `:464-471`） |
| 14 | 渲染层 | `electron/preload.cjs:141-147`（`task.command` / `task.onEvent` ← `ipcRenderer.on("task:event")`）→ `src/desktop/components.tsx:932-944`（`:939` `setError(ev.error)`，`:941` 再拉 `task/get` → `:871-885` `applyTaskState`，`:881` `setStopReason`） | `:1009` 状态文字；`:1010` `[data-ai-error] · {error}`；`:1012-1014` `[data-ai-stop-reason]`（**仅 `resumable` 时渲染**） |

### 1.2 界面结论（明确、可用于验收工单）

- **会变的可见文案**：``[data-ai-error]``（`src/desktop/components.tsx:1010`）**原样渲染错误码**。启动超时场景由 `· HARNESS_TURN_TIMEOUT` 变为 `· HARNESS_START_TIMEOUT`（长度 20 → 21 字符）。链路：`task-bootstrap.cjs:128` → `main.cjs:470` → `preload.cjs:145` → `components.tsx:939` → `:1010`。既有 e2e 已证明这种"原样显示错误码"的行为（`tests/d4-main-e2e.mjs:1159-1163` 断言 `[data-ai-error]` 含 `MODEL_CONFIG_CHANGED`）。
- **不会变的**：状态文字（`:1009`，`BLOCKED · Recovery Required`，因为 `resumable=false`）、`[data-ai-stop-reason]`（`:1012` 起整块只在 `resumable=true` 渲染 → 启动超时**不出现该节点**）、恢复块 `[data-ai-recovery]`（`:1026` 要求 `recovery.applicable`）、验证失败块、按钮可用性。
- **未加任何"错误码→人话"映射**，`src/**` 零改动；可见文案变化属"任务界面文案变化"，按上级口径交**验收工单**做浅/深主题 + 布局 + 动效实机验收。
- **node/单元层已断言该渲染路径**（不跑 Electron）：`tests/task-harness-orchestrator.test.mjs:282-311` 经**真实 IPC 入口** `task/run` 断言 `task/result.error === "HARNESS_START_TIMEOUT"`、`task/get.stopReason === "HARNESS_START_TIMEOUT"`、`resumable === false`。

### 1.3 不变量（逐项证据）

| 不变量 | 证据（新用例 / 既有） |
|---|---|
| 有界停止（不无限挂） | 启动超时：`tests/task-harness-orchestrator.test.mjs:236`（`elapsedMs < 700+15000`，实测 ~1.2s）；执行超时：`:278`（`elapsedMs < 700+20000`，实测 ~1.2s）；真实 dsh 探针 0 孤儿（`ps -axo command= \| grep -c '[h]ang-agent'` = 0）。既有：`tests/harness-acp-cancel.test.mjs:47-52`（C3 turn timeout bounded） |
| `BLOCKED` 终态 | 启动超时：`:216-217`（step/task）、`:223`（run）；执行超时：`:256-257`、`:263` |
| 能力撤销 | 启动超时：`:229-231`（至少 1 张已签发且全部 `REVOKED`）；执行超时：`:271-273` |
| 零自动重试 | 启动超时：`:218` `starts === 1`、`:219` `prompts === 0`、`:222` runs 恰 1 条、`:226` calls 0 条；执行超时：`:258` `starts === 1`、`:259` `prompts === 1`、`:262` runs 恰 1 条、`:266` calls 恰 1 条 |
| 预算未变 | `electron/task-harness-orchestrator.cjs:31-32`：`DEFAULT_TURN_TIMEOUT_MS = 180000`、`DEFAULT_START_TIMEOUT_MS = 30000`（测试只**注入**更小值，默认值未改） |

### 1.4 消费方排查（全仓，产品 / 测试 / 实验 / 脚本）

| 位置 | 用法 | 结论 |
|---|---|---|
| `electron/harness-adapter.cjs:26-34` | `HARNESS_ERROR.START_TIMEOUT` / `.TURN_TIMEOUT` 的**生产端** | 不改（两个码都真实存在，各自真实抛出） |
| `electron/task-harness-orchestrator.cjs:96-107` | 唯一分类器 | **本批唯一产品语义改动** |
| `tests/harness-acp-cancel.test.mjs:29-52` | adapter 层：child crash → `HARNESS_PROCESS_EXITED`；turn timeout → `HARNESS_TURN_TIMEOUT` | 不改：这正是"执行超时仍必须是 TURN_TIMEOUT"的既有反例 |
| `tests/task-harness-orchestrator.test.mjs:32,151-158` | stub adapter 抛 `HARNESS_TURN_TIMEOUT` → 断言 `HARNESS_TURN_TIMEOUT` | 不改：执行阶段语义仍然正确 |
| `tests/d4-03-run-entry-guard.test.mjs:182,185,222`；`tests/d4-09-append-step.test.mjs:305` | 直接给 `blockStep/blockHarnessRun` 传 reason 字符串 `"HARNESS_TURN_TIMEOUT"` 造状态 | 不改：这些是"任取一个合法停因码"的夹具用法，与分类器无关 |
| `tests/task-harness-cancel.test.mjs:31` | `cancelled \|\| HARNESS_CANCELLED \|\| TASK_CANCELLED` | 不改 |
| `tests/task-harness-recovery.test.mjs:29`；`tests/d4-03-model-binding.test.mjs:625,632,728` | `HARNESS_PROCESS_EXITED` / `notEqual(..., "HARNESS_NOT_STARTED")` | 不改 |
| `experiments/d5-03/**`（历史证据）、`docs/decisions/D5-03H-dsh-runtime-pinning.md:87,89,147`、`PROGRESS.md:1820` | 第八批把"保留原始错误码"登记为**单独批次裁决项**（选项 B） | 只读，不改历史证据；**本批即选项 B 的实施**（文档更新不在本批可写面内，留给上级） |

**结论：没有任何既有断言需要修改。** 错的是**产品映射**（把启动超时冒充执行超时），不是断言。因此"旧断言为何错"在本批只体现为**新增断言的反向验证**：

- 反向验证（同一断言、修复前必须红）：`experiments/d5-03/batch9/00-prefix-orchestrator-test.txt` —— 修复前 2 个新用例 FAIL：
  - `classifyHarnessError(...)` actual `'HARNESS_TURN_TIMEOUT'` vs expected `'HARNESS_START_TIMEOUT'`（`:194`）；
  - 真实 adapter 启动超时用例 actual `'HARNESS_TURN_TIMEOUT'` vs expected `'HARNESS_START_TIMEOUT'`（`:213`），且 run JSON 里 `"stopReason":"blocked","errorCode":"HARNESS_TURN_TIMEOUT"` —— 错配在真实链路上复现。
- 正向验证（修复后必须绿）：`experiments/d5-03/batch9/02-postfix-orchestrator-ipc.txt` —— 13/13 pass。
- **两种码各自的正反例都有**：启动超时→START（`:213-214`，并 `notEqual` TURN）；执行超时→TURN（`:253-254`，并 `notEqual` START）；adapter 层执行超时→TURN（`tests/harness-acp-cancel.test.mjs:52`，既有、未改、仍绿）。

---

## 二、目标二：cancel 测试按「可观察的正确阶段」等待

### 2.1 旧实现的缺陷（已核实的事实）

- 旧 `tests/task-harness-cancel.test.mjs:84-99`：`while (fx.fp.state.requests < 1 && Date.now() < deadline)` + `deadline = Date.now() + 20000` —— **固定 20s 魔数窗**；超窗后**不检查任何阶段**就继续 cancel，最终在 `:96` 断言 `requests === 1`，于是失败信息退化成 `0 !== 1`（W49 实测：`experiments/d5-03/batch8/17-npm-test-full.txt:7522`，`duration_ms 51723`）。
- 同文件 `:24-26`（Cancel E2E）有**同形魔数窗**，一并改为同一等待函数（判据不变）。

### 2.2 新实现（`tests/task-harness-cancel.test.mjs`）

- **等待上界与产品启动预算挂钩**：`WAIT_LIMIT_MS = PRODUCT_START_TIMEOUT_MS(30000) + START_MARGIN_MS(15000) = 45000`（`:15-17`）。不是把 20s 简单调大：上界来自产品自己的 `DEFAULT_START_TIMEOUT_MS`。
- **等待的是产品可观察阶段**（`waitForProviderRequest`，`:90-114`）：`fx.fp.state.requests >= 1`（模型请求已发起）为成功；期间用单调时钟记录
  `phase:child-spawned(observed)`（adapter.child 首次出现）、`phase:session-created(observed)`（adapter.sessionId 首次出现）、`phase:harness-running`（run 行 STARTING→RUNNING）、`phase:provider-request`。
- **失败必有诊断**（`:116-127` `failWithTimeline`，负载快照 `hostLoadSnapshot` `:33-46`）：等待原因 + 上界与实测耗时 + **完整阶段时间线** + **宿主负载**（`os.loadavg()`、CPU 数、进程数、内存）+ 产品状态（task.status / run.status/errorCode/stopReason）。产品自己先收敛（run 变终态）也立即失败并说明。
- **原有判据一字未放宽**：`requests === 1`（`:163`、`:228`）、`getCalls().items.length === 1`（`:229`）、`cancelled` 终态与 capability `REVOKED`（`:149-167`）全部保留；没有 `<=` / 0 次 / skip。
- **阶段记录点**（`makeTimeline` `:21-30`、`instrumentFactory` `:49-74`，全部用 `process.hrtime.bigint()` 相对时间）：`run:dispatch`、`adapter:start:begin/done|error`、`adapter:prompt:begin/done|error`、`adapter:cancel:begin/done|error`、`cancel:begin/done`、`run:converged`、`settle:300ms`、`exit`。
  ACP 握手本身没有独立钩子（`harness-adapter.cjs` 不在本批可写面），其完成以 `start()` 解析 / run `RUNNING` / `adapter.sessionId` 观测，粒度 = 轮询 10ms。

### 2.3 实测：连续 5 次单跑（全过）

证据文件 `experiments/d5-03/batch9/04-cancel-5x-single.txt`（`OPENARC_PHASE_TIMELINE=1`，每次 3 个用例、exit=0）：

| 单跑 | 3 用例结果 | 启动阶段（start:begin→done） | 请求发起 | 取消 | 收敛 |
|---|---|---|---|---|---|
| 1 | 3/3 pass | 1032.7ms | +1154.6ms | +1155.4ms | +1252.5ms `HARNESS_CANCELLED` |
| 2 | 3/3 pass | 953.7ms | +1074.3ms | +1074.9ms | +1192.6ms |
| 3 | 3/3 pass | 677.7ms | +773.9ms | +774.7ms | +859.9ms |
| 4 | 3/3 pass | 693.7ms | +791.0ms | +791.8ms | +902.0ms |
| 5 | 3/3 pass | 784.3ms | +897.3ms | +898.2ms | +981.0ms |

（上表是第三个用例 `Cancel 后不存在 Provider retry` 的时间线；`requests>=1` 距 `start:done` 仅 90–170ms。）

### 2.4 实测：全量 `npm test` 语境

见 §四（结论：**未复现** W49 的 0 次请求失败；全量下 cancel 三用例均绿）。

### 2.5 是否复现 0 次请求？——**未复现**，以及已查明与已排除

**未复现**：本机全量 `npm test` 2 次 + 6 路并发压测，cancel 三用例 0 次失败（见 §2.4/§2.6）。因此"W49 那次到底是哪一段慢"**未直接观测到**，不作"已证实是负载"的结论。

**已排除（有实测证据）**：
1. 不是"provider 慢/请求迟迟不来"：低载单跑与 6 路并发下，`requests>=1` 都出现在 `start:done` 后 90–260ms。
2. 不是 ACP 握手固有慢：`adapter:start` 低载 0.58–1.10s，6 路并发 1.05–1.10s（负载 46/12 CPU）。
3. 不是 cancel 路径：失败发生在其后的 `:96`，说明 `cancelWithRetry` 与 `c.ok` 已通过。
4. 不是测试等待逻辑本身的产物：新实现等待的是产品可观察量，且上界来自产品预算。

**已查明的另一条「0 次请求」可行路径（受控实验证实，且是本批新发现的既有限制）**：
- 代码事实：`harness-adapter.cjs:272-275` 只把 **ACP initialize** 包在 `startTimeoutMs` 里；紧随其后的 `harness-adapter.cjs:278` `await this.conn.newSession({...})` **没有任何超时**。
- 受控实验 `experiments/d5-03/batch9/new-session-unbounded-probe.mjs`（探针 `tests/fixtures/harness-acp/session-new-hang-agent.mjs`：initialize 正常回，session/new 永不回）：注入 `startTimeoutMs=700`，观察 6000ms 后 —— run **仍未收敛**（`runSettled:false`）、task=`RUNNING`、run=`STARTING`、`providerRequests:0`、`promptCalls:0`、子进程仍存活；时间线只有 `+489.7ms adapter:start:begin | +6487.3ms watch:end`。→ **启动预算不覆盖 session/new，这一段可无界悬挂，期间必然 0 次 provider 请求。**
- 与 W49 失败形态的一致性（**推断，非直接观测**）：那次 `duration_ms 51723` 且结束时 `requests===0`。若 `initialize` 在 30s 预算处超时，run 应在 ~30s 收敛（随后 dispose 有界），总时长不会到 51.7s；51.7s 更像"启动的**无界段**（`session/new`）拖到 ~51s 才让 run 收敛"，而 cancel 在 20s 已落地（run 已被置 CANCELLED，`markHarnessRunRunning` 失败 → 直接返回）。
- **仍需的证据**：W49 那次的 dsh 子进程 stderr / 启动各子阶段耗时（当前产品在启动期不落任何事件，只在 start 抛错时才有码）；若要让此类"启动无界"可诊断，需要产品在 start 前后落 safe 阶段事件或给 `session/new` 加同预算上界 —— **都超出本批可写面**（`harness-adapter.cjs` 未授权），登记为遗留 R2。

### 2.6 并发压测（尝试逼近 W49 环境）

`6` 路并发同一 cancel 测试文件（`experiments/d5-03/batch9/06-stress-cancel-[1-6].txt`，宿主 12 CPU，loadavg ≈ 46）：**6/6 实例 × 3 用例全过、exit=0**；启动阶段 1.05–1.10s、请求发起 +1.19～1.26s，仍远小于 20s 旧窗与 45s 新上界。

---

## 三、断言变更清单

### 3.1 新增断言（`tests/task-harness-orchestrator.test.mjs`）

| 行 | 断言 | 目的 |
|---|---|---|
| 194 | `classifyHarnessError({code:"HARNESS_START_TIMEOUT"}) === "HARNESS_START_TIMEOUT"` | 启动超时分类（修复前红） |
| 195 | `classifyHarnessError({code:"HARNESS_TURN_TIMEOUT"}) === "HARNESS_TURN_TIMEOUT"` | 执行超时分类（反例） |
| 196 | `ERROR.HARNESS_START_TIMEOUT === "HARNESS_START_TIMEOUT"` | 领域枚举存在且逐字一致 |
| 197 | `classifyHarnessError(start) !== ERROR.HARNESS_TURN_TIMEOUT` | 绝不互相改写 |
| 213-214 | 真实启动超时 `r.error === "HARNESS_START_TIMEOUT"` 且 `!== "HARNESS_TURN_TIMEOUT"` | 端到端码正确 |
| 215-217 | `ok===false`、step/task `BLOCKED` | 终态 |
| 218-219 | `starts===1`、`prompts===0` | 0 重试 / 0 进入 prompt |
| 222-225 | runs 恰 1 条、run `BLOCKED`、`errorCode/stopReason` 正确 | 0 respawn + run 行如实 |
| 226-227 | calls 0 条、artifacts 0 条 | 0 模型调用 / 无产物 |
| 229-231 | capability ≥1 且全部 `REVOKED` | 能力撤销 |
| 234-235 | `step.blocked` 与 `harness.run.blocked` 事件携带该码 | 事件如实 |
| 236 | `elapsedMs < 15700` | 有界停止 |
| 253-254 | 真实执行超时 `r.error === "HARNESS_TURN_TIMEOUT"` 且 `!== "HARNESS_START_TIMEOUT"` | 反面：不许反向错配 |
| 255-259 | BLOCKED、`starts===1`、`prompts===1` | 恰好 1 次 prompt（0 重试） |
| 262-268 | runs 恰 1、run `BLOCKED`、calls 恰 1 且 `FAILED`/`providerErrorCode` 正确 | 0 二次 call |
| 269-273 | artifacts 0、capability 全部 `REVOKED` | 能力撤销 |
| 276-278 | 两个事件携带 `HARNESS_TURN_TIMEOUT`、`elapsedMs < 20700` | 事件 + 有界 |
| 299-309 | 真实 IPC：`task/result.error`、`task/get.stopReason` = 该码；`status==="BLOCKED"`；`resumable===false` | 渲染层可见载荷（node 层，不跑 Electron） |

### 3.2 新增/替换断言（`tests/task-harness-cancel.test.mjs`）

| 行 | 变化 | 理由 |
|---|---|---|
| 旧 `:24-26`（Cancel E2E）、旧 `:90-91`（第三个用例）| 旧 `deadline = +20000` + `while(requests<1 && Date.now()<deadline)` → 新 `waitForProviderRequest`（`:90-114`，上界 45s = 产品启动预算+余量，失败带时间线/负载诊断），两处调用点 `:140-141` / `:217-218` | 旧写法在阶段未达成时**静默继续**，把失败推迟到旧 `:96` 变成 `0 !== 1` |
| `:141` / `:218` | 新增 `if (!waited.ok) failWithTimeline(...)` | 超上界/产品先收敛必须显式失败并给证据 |
| `:163` / `:228` | `assert.equal(fx.fp.state.requests, 1)`（原判据保留，第三处补上说明性 message） | "恰好 1 次请求、0 重试"不许放宽 |
| `:229` | `getCalls().items.length === 1`（原判据保留） | 0 二次 call |
| `:149-167` | CANCELLED/cancelRequested/step CANCELLED/artifact 0/closed≥1/runs CANCELLED/capability REVOKED（原判据逐条保留） | 未放宽 |
| — | 删除的只有 `deadline`/`deadline2` 形式的 harness 启动等待（`deadline2` 是 provider 连接关闭窗口，保留） | 见上 |

---

## 四、验证计数与 exit（全部为真实运行结果）

### 4.1 改动文件

```
electron/task-domain.cjs                 |   2 +
electron/task-harness-orchestrator.cjs   |   2 +-
tests/task-harness-cancel.test.mjs       | 179 +++++++++++++++++++++++++++----
tests/task-harness-orchestrator.test.mjs | 138 +++++++++++++++++++++++-
4 files changed, 296 insertions(+), 25 deletions(-)
```
新增（untracked）：
- `tests/fixtures/harness-acp/start-hang-agent.mjs`（可控阻塞 initialize 探针）
- `tests/fixtures/harness-acp/turn-hang-agent.mjs`（可控阻塞 prompt 探针）
- `tests/fixtures/harness-acp/session-new-hang-agent.mjs`（可控阻塞 session/new 探针，诊断用）
- `experiments/d5-03/batch9/**`（本报告 + 全部证据）

`src/**` 零改动（`git status` 无 `src/` 项）。

### 4.2 定向验证

| 命令 | 结果 | exit | 证据 |
|---|---|---|---|
| `node --test tests/task-harness-orchestrator.test.mjs`（修复前） | 12 tests / 10 pass / **2 fail**（两个新用例红，红的原因正是错配） | 1 | `00-prefix-orchestrator-test.txt` |
| `node --test tests/task-harness-orchestrator.test.mjs`（修复后） | 12/12 pass | 0 | `01-postfix-orchestrator-test.txt` |
| `node --test tests/task-harness-orchestrator.test.mjs`（含 IPC 用例，最终） | **13/13 pass**，duration 9009ms | 0 | `02-postfix-orchestrator-ipc.txt` |
| `node --test tests/task-harness-cancel.test.mjs`（改造后单跑 ×5） | 每次 **3/3 pass** | 每次 0 | `04-cancel-5x-single.txt` |
| 6 路并发同一 cancel 文件（压测） | **6/6 实例 × 3 用例 pass** | 每个 0 | `06-stress-cancel-[1-6].txt` |
| `node experiments/d5-03/batch9/new-session-unbounded-probe.mjs` | run 未收敛（0 请求 / 0 prompt / STARTING），证实 session/new 无上界 | 0 | 本报告 §2.5 |

### 4.3 全量 `npm test`（`node --test tests/*.test.mjs`）

| 次 | tests | pass | fail | cancel 三用例 | duration | exit | 证据 |
|---|---|---|---|---|---|---|---|
| 1 | 1387 | 1385 | 2 | 全绿（5941ms / 615ms / 6428ms） | 186266ms | npm 退出 1（仅两条既有失败） | `05-npm-test-full-1.txt` |
| 2 | 1387 | 1385 | 2 | 全绿（5977ms / — / 5835ms） | 155018ms | npm 退出 1（仅两条既有失败） | `07-npm-test-full-2.txt` |

两次全量运行的 fail 项**完全相同**，且都是本批之外的既有确定性失败：
1. `P2 · 当前会话 = A（owner）：推送投递，载荷 = 白名单投影且与 getApprovalRequest 一致`（`tests/d4-03-approval-push-isolation.test.mjs`）
2. `No Direct Domain Bypass：resource.trash 的唯一 Domain 调用点在 allowlisted adapter + controlled execution 内`（`tests/side-effect-c4-gates.test.mjs`）

**按要求：如实单列，未修，不计入本批改动面。**

### 4.4 上级指定的相关集合

```
node --test tests/task-harness-*.test.mjs tests/tool-d4-03d*.test.mjs tests/d4-03-*.test.mjs tests/d4-09-*.test.mjs
→ tests 142 · pass 141 · fail 1 · cancelled 0 · skipped 0 · todo 0 · duration_ms 40745 · exit 1
```
- 17 个文件：`task-harness-{cancel,e2e,orchestrator,recovery,security}`、`tool-d4-03d-{audit,authority,closure,e2e}`、`d4-03-{approval-push-isolation,approver-eligibility,deny-state-protection,lease-acquire-state-protection,lease-state-integrity,model-binding,run-entry-guard}`、`d4-09-append-step`。
- 唯一的 fail = 上表既有确定性失败 #1（`d4-03-approval-push-isolation`，本批未触碰该文件）。
- 既有失败 #2（`side-effect-c4-gates.test.mjs`）**不在**该集合内，但两次全量里都出现，一并如实列出。
- 证据：`08-subset-run.txt`。

### 4.5 `SCHEMA_VERSION` 仍 21 的证据

- `electron/identity-store.cjs:68`：`const SCHEMA_VERSION = 21;`（未改）。
- `git diff --stat` 不含 `electron/identity-store.cjs`、不含任何 store / migration 文件。
- 本批新增的只是 `task-domain.cjs` 里 `ERROR` 这个**冻结 JS 枚举的一个成员**；`task-store.cjs` 的 `error_code` / `stop_reason` 是自由 TEXT 列（`grep -n CHECK electron/task-store.cjs` 无约束），无需迁移。

### 4.6 预算未变

`electron/task-harness-orchestrator.cjs:31-32`：`DEFAULT_TURN_TIMEOUT_MS = 180000`、`DEFAULT_START_TIMEOUT_MS = 30000`（与批前一致；测试仅注入更小值）。

---

## 五、遗留与不确定项

- **R1（新发现，超出本批可写面）｜`session/new` 没有上界**：`electron/harness-adapter.cjs:272-275` 只把 ACP `initialize` 包进 `startTimeoutMs`；`:278` 的 `await this.conn.newSession(...)` 无任何超时。受控实验（§2.5）证实：探针 initialize 正常、session/new 不回时，注入 700ms 启动预算后 6s 仍 `run=STARTING / task=RUNNING`、0 请求、0 prompt、子进程存活。→ 这条路径上"有界停止"不成立，且必然产生"0 次 provider 请求"。`harness-adapter.cjs` 不在本批授权写入面，**未改**，建议单独裁决（给 session/new 同预算上界，或在启动各子阶段落 safe 事件）。
- **R2｜界面可见文案变化待实机验收**：`[data-ai-error]` 由 `· HARNESS_TURN_TIMEOUT` 变为 `· HARNESS_START_TIMEOUT`（`components.tsx:1010`）。按上级口径由验收工单做浅/深主题 + 布局 + 动效实机验收；本执行岗未跑 Electron。
- **R3｜文档更新不在本批可写面**：`PROGRESS.md:1820`、`docs/decisions/D5-03H-dsh-runtime-pinning.md:87/89/147` 把"保留原始错误码"登记为待裁决项；本批已实施该选项，但我无权写这两个文件，需上级更新。
- **R4｜W49 那次 0 次请求的确切子阶段未查明（未复现）**：13 次执行（5 单跑 + 6 并发 + 2 全量）0 次失败，因此无法给出那次失败的阶段时间线（旧代码也没有阶段记录）。已排除项与 R1 这条已证实的可行路径见 §2.5；仍需要的证据是 dsh 子进程 stderr / 启动各子阶段耗时（当前产品在启动期不落任何事件）。
- **R5｜两条既有确定性失败**：`d4-03-approval-push-isolation` 与 `side-effect-c4-gates` 各次运行如实失败，未修（按要求）。
- **R6｜测试侧余量常量**：`START_MARGIN_MS = 15000` 是测试侧余量，与产品 `DEFAULT_START_TIMEOUT_MS = 30000` 成对出现（`tests/task-harness-cancel.test.mjs:15-17`，注释已写明来源）。若产品未来调整启动预算，该常量需同步；它是"上界与产品预算挂钩"的实现方式，不是新的魔数窗。
- **R7｜取消测试的成功判据仍是"恰好 1 次"**：新实现只在"等待阶段"上更严谨，判据未放宽（`requests === 1`、calls === 1）。若将来需要证明"0 请求也不许通过"，已在等待阶段显式失败覆盖。
