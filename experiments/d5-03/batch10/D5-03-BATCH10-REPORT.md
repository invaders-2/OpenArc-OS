# D5-03 第十批 · 执行方报告（R1 + R1-e 收口）

被测 commit：`4c90364`（父 `05fa678`，单提交）
工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`）
范围：**只做第九批登记的 R1、R1-e**。R2 只做同根因排查（结论：不同根因，另案）；未做 OAuth / D5-04 / 创建组织入口。

## 0. 范围与口径

| 项 | 内容 |
| --- | --- |
| R1 | `harness-adapter.cjs` 的启动预算只包 `initialize`，`session/new` 无上界 |
| R1-e | 该无界段里 `orchestrator.dispose()` / `cancel()` 触达不到 adapter（`registry.set` 晚于 `adapter.start()` 返回） |
| 不改 | 启动 / 执行预算 `30000 / 180000`、`SCHEMA_VERSION`（仍 21）、`src/**`（0 行）、任何既有断言 |
| 不新增 | 没有新增错误码；启动段收敛仍走 `HARNESS_START_TIMEOUT` + `BLOCKED` 既有路径 |

## 1. 改动面

```
electron/harness-adapter.cjs                       +115 / −28
electron/task-harness-orchestrator.cjs              +71 / −12
tests/fixtures/harness-acp/session-new-hold-agent.mjs  +30 / −0   （新增探针）
tests/task-harness-cancel.test.mjs                 +200 / −0
tests/task-harness-orchestrator.test.mjs           +166 / −0
```

### 1.1 adapter（R1）

* `start(args)`：进入时算一次**绝对截止时间** `deadlineAt = clock() + startTimeoutMs`；
  `initialize` 与 `session/new` 都经 `#withDeadline(promise, deadlineAt, code)` —— 剩余预算 = `deadlineAt - now()`，
  为 0 立刻超时；**绝不每段各自重新获得一份预算**。
* 启动失败（超时 / 被中断 / 协议错 / 子进程死亡）时 `start` 自己收尾：`#runTeardown()`（幂等、只跑一次）
  撤销 tool + model 能力 → `closeSession` → stdin close → SIGTERM → bounded SIGKILL → `bridge.stop()` → 删临时目录。
* 迟到响应：`#assertNotInterrupted()` 在 `newSession` 之后与返回前各查一次；`this.disposed` / `this.interrupted`
  一旦置位，`#runStartup` 立刻抛 `HARNESS_START_TIMEOUT`，**绝不复活**、绝不进入 prompt。
* 新增最小接口 `abortStart()`：置中断位并让在途 `start` 有界收敛（`cancel()` / `dispose()` 都会调用）。
* 启动段内子进程死亡：ACP 连接先关、`exit` 事件通常同 tick 才到 → 先等 ≤250ms 再判定，
  归因为 `HARNESS_PROCESS_EXITED`（与 `prompt` 的失败归类同口径，绝不退化成 `INTERNAL_ERROR`）。
  `session/new` 未返回 `sessionId` 一律 `HARNESS_PROTOCOL_ERROR`，绝不把「没有 session 的成功」交给编排器。

### 1.2 orchestrator（R1-e）

* `adapter.start()` **之前**就 `registry.set(runId, { ..., starting: true })` → 启动中也能被找到。
* `cancel()`：先持久 `cancel_requested=1`（保持既有 race 判定顺序），再对 `starting` 的登记
  `abortStart → revoke 两类能力 → await dispose()`，然后照旧 `cancelHarnessRun` → `finalizeCancel`。
* `dispose()`：对 `starting` 的登记走同一条 `#cancelEntry`，并先置 `this.disposed`。
* `#cancelEntry` 立刻从 registry 注销该 run：**迟到的启动结果无处复活**。
* 启动段返回后做阶段复核 `#isStartCancelled(runId)`（登记已被取消 / dispose 摘掉）→ 收敛成唯一 `CANCELLED`；
  启动段 catch 里若 `cancelRequested` 已置位 → 同样走 `#finalizeCancelled`，**绝不翻转成 BLOCKED**。
* `#finalizeCancelled` 增加「revision 冲突时重读一次」：取消与启动/归并并发时 run 绝不留在非终态。
* run 主体 `finally` 先注销登记再收尾，避免与启动段重复收尾同一个 adapter。

## 2. 验收证据（红 → 绿）

### 2.1 红（修复前，工作树回到 `05fa678` 的两个产品文件）

| 证据 | 结果 |
| --- | --- |
| 第九批探针 `experiments/d5-03/batch9/new-session-unbounded-probe.mjs` | `runSettled=false`、run `STARTING`、task `RUNNING`、0 请求、0 prompt、`childAlive=true`（700ms 预算 + 8s 观察窗**不收敛**） |
| 新增 3 个编排器用例（有界注入预算 600ms + 4s 观察窗） | 全部 `RED-HANG`（`HARNESS_START_TIMEOUT` 期望值 vs 实际 4s 未收敛） |
| 新增 adapter 自清用例 | 观察窗内未收敛，测试进程被外部有界杀停 |
| 新增「启动未返回时取消」用例 | 全程挂住（`cancel()` 等 `dispose()` 无上界），30s 外层有界杀停，无任何 TAP 断言产出 |

### 2.2 绿（修复后，同一批用例，未放宽任何断言）

| 证据 | 结果 |
| --- | --- |
| 第九批探针 | `runSettled=true`、`HARNESS_START_TIMEOUT`、task/run `BLOCKED`、`childAlive=false`、`hasSessionId=null`、0 请求、0 prompt（`00-r1-probe-green.json`） |
| `npm run test:d4-02c` | **33 / 33 pass，exit 0，45s**（`01-gate-d4-02c.txt`） |
| 独立复跑 23 用例（两文件） | 23 / 23 pass，duration 33.3s |
| `task-harness-recovery` 单文件 3 连跑 | 3 × 2/2 pass（含「启动段内 kill child」） |

### 2.3 新增用例逐条

| 用例 | 断言要点 |
| --- | --- |
| 启动预算覆盖整段 `session/new`（永不回应） | `HARNESS_START_TIMEOUT`；task/step/run 三处 `BLOCKED` + `error_code`；`elapsed < 预算+15s`；0 请求 / 0 prompt / 0 调用；能力全 `REVOKED`；registry 无残留 |
| 共享绝对截止时间 | 注入时钟在 `session/new` 发出的那一刻已走 600/700ms → 该调用的剩余预算 `>0 且 ≤ 600ms`（旧行为必然重新获得 700ms） |
| 迟到 `session/new` 响应（延迟 1800ms vs 预算 700ms） | 响应窗口过后仍是同一条 `BLOCKED`；不新建 run、0 调用、0 请求、0 prompt、无 artifact、无 `harness.run.succeeded` |
| adapter 启动失败自清理 | `sessionId=null`、`processExited=true`、`bridge=null`、临时目录已删、能力全 `REVOKED`、`dispose()` 幂等 |
| 启动未返回时取消 | 唯一 `CANCELLED`（task / step / run 三处）、0 孤儿（`process.kill(pid,0)`）、能力 `REVOKED`、**旧 token 实际请求 401 `PROXY_UNAUTHORIZED`**、重复取消幂等 |
| 启动临界点竞争（`session/new` 700ms 后回应，取消先行） | 取消后等 1.5s 窗口：终态不翻转、无 `CANCELLED + SUCCEEDED` 矛盾、0 孤儿、0 prompt、0 请求 |
| 启动未返回时 dispose | `runTask` 有界收敛且绝不抛异常、run 不悬挂在 `STARTING`、0 孤儿、能力 `REVOKED`、`unhandledRejection` 计数 = 0 |

## 3. 断言变化清单

**无既有断言被修改 / 放宽 / 跳过**。新增断言 7 条用例（§2.3），另在既有两个用例文件中
新增 1 个探针夹具（`session-new-hold-agent.mjs`，延迟从 `argv[2]` 读，不传 = 永不回应）。

## 4. R2 同根因排查（只给证据，不修）

诊断脚本（`/tmp/oa-b10-red/r2-diagnose.mjs`，未入库）：真实 adapter + slow provider，
等到 provider 请求已发起后 `cancel()`，观察 0 / 200 / 1000 / 3000 / 6000ms 五个时点的账本：

| 观测 | 值 |
| --- | --- |
| `cancel()` | `ok=true` |
| run / task / step | `CANCELLED` / `CANCELLED` / `CANCELLED` |
| model call 状态 | 五个时点**始终 `STARTED`**，`providerErrorCode=null`（首次观测在 cancel 返回后） |

结论：R2 的可见事实与 R1 / R1-e **不同根因**——R2 期间启动早已完成、registry 正常登记，
问题在「取消路径不终结 in-flight model call 信封」（`TaskService` 的 `finalizeCancel` / `cancelHarnessRun`
都不触碰 `task_model_calls`，运行时内联调用 `failModelCall`/`completeModelCall` 两处都在 `callRes.ok` 之后；
非取消路径的 `#blockStep` 也只 `blockHarnessRun`）。本批**未改**任何 related 代码。

## 5. 未验收 / 单列

* 未做真机界面截图：本批 `src/**` 0 行改动，界面影响 = 取消启动段后 task / run 显示 `CANCELLED`（既有文案与组件路径）。
* `orchestrator.dispose()` 在应用退出路径**未被调用**（`electron/main.cjs:836-860` 的 `will-quit` 只
  `disposeMcpBounded` + `modelProxy.stop` + `store.close`）→ 本批未改，单列待裁决。
* 复用门禁证据不含被测 commit 戳（沿用第九批口径，如实披露）。
* 环境型 flake 观察：全量 `npm test` 的既有确定性失败名单见验收报告。
