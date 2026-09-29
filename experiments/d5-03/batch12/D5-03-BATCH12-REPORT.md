# D5-03 第十二批 · 执行方报告（用户取消在途模型调用后的完整收敛）

被测 commit：`10075b2`（父 `63a8ed5`，单提交；提交时 `--amend` 一次，仅并入验收驱动的残留清扫，产品代码未变）
工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`）
范围：**只含 R2（model call 留在 STARTED）与第十一批发现的 runTask promise 不返回**；未进入 OAuth / D5-04 / 创建组织入口；未 push；未触碰主工作树 17 项改动、DSH Desktop 共享运行时、`~/.dsh`。

## 0. 改动面

```
electron/harness-adapter.cjs             +40 / −11  （取消后 turn 有界收敛；迟到结果不复活）
electron/task-service.cjs                +36 / −0   （cancelStartedModelCalls：取消的账本终态）
electron/task-harness-orchestrator.cjs   +50 / −11  （取消优先 + 先落 call 终态 + 用量证据）
electron/task-domain.cjs                 +2  / −0   （MODEL_CALL_CANCELLED 安全事件）
tests/task-harness-cancel-convergence.test.mjs  +331 / −0（新增 9 条时序用例）
tests/fixtures/harness-acp/prompt-late-agent.mjs +33 / −0（迟到 turn 结果探针）
experiments/d5-03/batch12/verify/**      +1035 / −0（Probe 宿主 / 时序矩阵 / 真实 Electron 取消验收）
.gitignore                               +3  / −0
```

### 0.1 红证据（父提交 `63a8ed5` 的产品代码）

时序矩阵 7 个时序（`verify/00-red-matrix.json`）：

| 时序 | runTask 收敛 | task/step/run | **call** | 产物 | 子进程 |
| --- | --- | --- | --- | --- | --- |
| 请求前取消 | ✅ 1228ms | CANCELLED | **STARTED** | 0 | 已回收 |
| 已收到请求后取消 | ✅ 991ms | CANCELLED | **STARTED** | 0 | 已回收 |
| 正常响应与取消同刻 | ✅ 786ms | CANCELLED | **STARTED** | 0 | 已回收 |
| Provider 永不回应 | ✅ 739ms | CANCELLED | **STARTED** | 0 | 已回收 |
| 迟到结果 | ✅ 768ms | CANCELLED | **STARTED** | 0 | 已回收 |
| 重复取消 | ✅ 764ms | CANCELLED | **STARTED** | 0 | 已回收 |

**R2 复现成立**：六个取消时序下，任务 / 步骤 / run 都正确收敛成 `CANCELLED`，唯独 model call 永远停在
`STARTED`（无 `completed_at`、无事件）。**矩阵 0 / 7 通过**（判据含「call 必须 CANCELLED」）。

第十一批登记的「runTask 不返回」：本轮在真实 Electron 场景复现为
`PROBE_CANCEL_CONVERGED {"settled":"timeout","taskStatus":"CANCELLED","runs":["CANCELLED"]}`
—— 任务已取消、runTask 20s 仍不 settle；机制见 §0.3。

### 0.2 绿证据（被测提交 `10075b2`）

同一矩阵 **7 / 7 通过**（`verify/01-green-matrix.json`）：

| 时序 | runTask 收敛 | call 终态 | completed_at | Provider 失败码 | 产物 |
| --- | --- | --- | --- | --- | --- |
| 请求前取消 | ✅ 972ms | CANCELLED | 已写 | 空 | 0 |
| 已收到请求后取消 | ✅ 674ms | CANCELLED | 已写 | 空 | 0 |
| 正常响应与取消同刻 | ✅ 656ms | CANCELLED | 已写 | 空 | 0 |
| Provider 永不回应 | ✅ 637ms | CANCELLED | 已写 | 空 | 0 |
| 迟到结果 | ✅ 658ms | CANCELLED | 已写 | 空 | 0 |
| 重复取消 | ✅ 654ms | CANCELLED | 已写 | 空 | 0 |
| **正常成功对照** | ✅ 646ms | **SUCCEEDED** | 已写 | 空 | **1** |

（每个取消时序都另有：`registry` 清空、capability 全 `REVOKED`、harness 子进程退出。）

### 0.3 根因（两条，缺一不可）

1. **账本从不在取消路径收尾**：`startModelCall` 在 `runStep` 里建信封，只有成功（`completeModelCall`）
   与失败（`failModelCall`）两条路径会写终态；用户取消走的是 `#finalizeCancelled` → `cancelHarnessRun`
   → `finalizeCancel`，**三处都不碰 `task_model_calls`** → call 停在 `STARTED`。
2. **乐观并发 token 过期**：即便在取消路径补上收尾，取消竞态里 `revision` 一直在动
   （`requestCancel` / `cancelHarnessRun` / `finalizeCancel` 各推一格），首次带旧 `expectedRevision`
   的收尾会被 `TASK_REVISION_CONFLICT` 拒掉 —— 实测日志：`rev0=7` 而当前已是 `10`，收尾被静默跳过。
   → 修法：冲突时重读一次再收尾（有界一次）。
3. **runTask 不返回**：ACP 的 `session/cancel` 是**通知**（协议允许 agent 不回 `cancelled`），
   原实现 `await conn.cancel(...)` 后继续等 agent 回话 → 只能等满执行预算（180s）。

## 1. 修复（最小面）

* `TaskService.cancelStartedModelCalls()`：只收敛**本次任务里仍为 `STARTED`** 的 call →
  `CANCELLED` + `completed_at` + 安全事件 `model.call.cancelled`（与取消同一事务）。
  已 `SUCCEEDED` / `FAILED` / `CANCELLED` 的历史行由 `#callCommand` 的
  `status !== "STARTED"` 前置判定守住，**绝不改写**；已观测到的真实 `usage` 原样落库
  （不声称 Provider 从未执行 / 从未计费）。
* 编排器 `#finalizeCancelled`：先落 call 取消终态（冲突重读一次）再收 run / task；
  正常返回路径改成**取消优先** —— 已取消的 turn 绝不把 call 写成 `SUCCEEDED`；
  本 turn 的 `usage` 一旦观测到就记账，供取消路径保留。
* adapter：`prompt` 侧在**用户真的取消过**之后只等一个 750ms 窗口，仍不回来就按真实取消结果收尾；
  没取消过绝不武装该窗口（否则正常慢 turn 会被误判成取消 —— 本批开发中真实踩到过，
  由 `tests/tool-dsh-cancel.test.mjs` 的「tool chain 中 kill dsh」用例暴露并已修）。

## 2. 验证

### 2.1 领域用例（`tests/task-harness-cancel-convergence.test.mjs`，9 / 9 PASS，51s）

| 用例 | 关键断言 |
| --- | --- |
| 1 请求发出前取消 | runTask 有界返回；call=CANCELLED + completed_at + 事件；0 产物 |
| 2 Provider 已收到请求后取消 | 同上 + 0 孤儿 + registry 空 + **只读重开库**后四处状态一致 |
| 3 正常响应与取消同刻竞争 | 终态唯一，绝不 `SUCCEEDED` 与 `CANCELLED` 并存 |
| 4 Provider 永不回应（turn-hang） | runTask 仍有界返回，取消→收敛远小于执行预算 |
| 5 迟到 turn 结果 | 绝不产生产物 / 绝不新建 call/run / 绝不翻转终态 |
| 6 重复取消 | 幂等：终态不翻转、call 不被改写（`completed_at` 不变）、取消事件恰好一条 |
| 7 正常成功对照 | call=SUCCEEDED + 产物 1 + `model.call.completed`，**无**取消事件 |
| 8 历史 call 不被改写 | 真实 Provider 失败仍是 FAILED（`provider_error_code` 保留），后续取消不改写 |
| 9 副作用账本隔离 | 独立 `side_effect_calls` 仍 `AWAITING_APPROVAL`：状态 / 完成时间 / 错误码 / 审批 / 执行记录全不动 |

### 2.2 真实 Electron 取消路径（隔离安装，**只启动两次**，18 / 18 PASS，6s）

`npm run` 方式：`node experiments/d5-03/batch12/verify/electron-cancel-e2e.mjs`
（真实 Electron + 真实 dist/preload + 真实 `createOpenArcRuntime` + 真实 adapter/orchestrator；
受控慢 Provider 独立进程；harness 子进程 = 夹具探针）

* 取消经**真实渲染层**：`window.openarc.task.command({command:'task/cancel'})` → preload → IPC → 产品 handler；
* `PROBE_IPC_CANCEL {"ok":true,"via":"preload->ipc"}`；`PROBE_RUN_CONVERGED`
  `{"elapsedMs":2861,"done":"resolved","error":"HARNESS_CANCELLED","cancelled":true,"callsFinalized":["mcall_…"]}`；
* 退出前在途 harness 子进程峰值 6；退出后**0 孤儿**；退出码 0；
* 只读重开库：`task/step/run` 三处 `CANCELLED`、`cancel_requested=1`、恰好一个 call
  `CANCELLED` + `completed_at` 已写 + `provider_error_code` 空、0 产物、
  事件链 `…task.cancel_requested → step.cancelled → task.cancelled → model.call.cancelled`
  （**无** `model.call.failed` / `model.call.completed`）；
* 第二次启动（真实重启路径）后仍是 `CANCELLED`（取消终态不被恢复流程改写）。

### 2.3 门禁计数（被测 commit `10075b2`）

| 门禁 | 结果 | 耗时 |
| --- | --- | --- |
| `test:d4-02c`（Harness 受影响面） | **33 / 33 PASS，exit 0**（dsh 0.1.5-rc.2 / acp 1.4.0 / schema 21） | 60s |
| 收敛套件（新增 9 条） | **9 / 9 PASS，exit 0** | 51s |
| 相关门禁 `tool-dsh-cancel` + `d4-06-resume` + `d4-07-budget-consistency` + `tool-d4-03d-audit` | **17 / 17 PASS，exit 0** | 43s |
| 真实 Electron 取消验收 | **18 / 18 PASS，exit 0** | 6s |
| 全量 `npm test` | **exit 1：1408 tests / 1406 pass / 2 fail**（129852ms） | 130s |

全量失败名单（**恰为既有两条确定性失败，本批未修、未放宽断言**）：
① `d4-03-approval-push-isolation` P2；② `side-effect-c4-gates` No Direct Domain Bypass。
1399 → 1408 = 本批新增 9 条用例，无既有断言被改。

## 3. 断言变化清单

**无既有断言被修改 / 放宽 / 跳过**。新增 `tests/task-harness-cancel-convergence.test.mjs` 9 条 +
真实 Electron 取消验收 18 条；新增探针夹具 `tests/fixtures/harness-acp/prompt-late-agent.mjs`。

## 4. 未验收 / 单列

* **迟到「Provider 真实回包」未单独构造**：用例 5 的迟到结果来自 agent 侧（探针不在 prompt 时发 bridge
  请求）；「provider 已收到请求后取消」由用例 2 与真实 Electron 场景覆盖，两者合起来覆盖同一语义。
* **真实计费 / 实际 token 数**不可观测（假 Provider 不返回 usage）；本批只保证「已观测到的 usage 原样保留」。
* **取消后 `usage` 落库路径**在假 Provider 下恒为 null（无 usage 事件），该分支仅由代码路径与
  单测（直接调用 `cancelStartedModelCalls` 传 usage）覆盖。
* **应用退出（第十一批）与取消的交叉**（退出时正在取消）未单独构造用例。
* **未做界面截图**：`src/**` 0 行改动，取消路径无新增界面文案。
* 本批开发期间的**工具清理**：多次调试运行留下过 24 个 Electron 探针进程，已全部清掉（0 残留），
  并把「按命令行标记清扫」并入验收驱动，后续批次不再外溢。
