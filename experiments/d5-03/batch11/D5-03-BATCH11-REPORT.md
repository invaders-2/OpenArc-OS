# D5-03 第十一批 · 执行方报告（应用退出时收尾 Harness）

被测 commit：`0eed84c`（父 `7569016`，单提交）
工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`）
范围：**只处理 will-quit 遗漏 `orchestrator.dispose()`**；R2（取消后 model call 停在 `STARTED`）**未动**。
未做 OAuth / D5-04 / 创建组织入口；未 push；未触碰主工作树 17 项改动、DSH Desktop 共享运行时、`~/.dsh`。

## 0. 改动面

```
electron/app-shutdown.cjs                                  +80 / −0   （新增：唯一收尾顺序）
electron/main.cjs                                          +23 / −19  （will-quit 改调同一份收尾）
package.json                                               +1 / −0    （test:d5-03-exit）
tests/app-shutdown.test.mjs                                +92 / −0   （新增：有界 / 不吞错 / 不跳过关库）
tests/fixtures/harness-acp/echo-agent.mjs                  +31 / −0   （新增：正常完成对照探针）
experiments/d5-03/batch11/verify/{exit-e2e.mjs,app/**,quit-microtask-repro.mjs}  +778 / −0（真实 Electron 退出验收）
tests/**, src/**                                           0 行既有代码改动（除上述新增文件）
```

### 0.1 收尾顺序（`electron/app-shutdown.cjs`）

```
disposeAppResources({ identity })
  ├─ Promise.all ─┬─ MCP 有界 dispose        (2s,  DISPOSE_TIMEOUT)
  │               └─ Harness 有界 dispose    (8s,  HARNESS_DISPOSE_TIMEOUT)  ← orchestrator.dispose()
  ├─ identity.modelProxy.stop()
  └─ identity.store.close()
```

* **Harness 收尾 = `orchestrator.dispose()`**（既有实现）：对 `starting` 的登记 `abortStart → revoke → await dispose`，
  对已启动的登记 `revoke 两类能力 → await adapter.dispose()`（closeSession → stdin close → SIGTERM → bounded SIGKILL
  → `bridge.stop()` → 删临时目录），最后 `registry.clear()`。
* **先停 Harness、后停 proxy / 关库**：能力撤销要有 proxy 在、临时目录清理不依赖 store。
* **有界**：每项超时或抛错只留痕；单项失败绝不跳过后面的 `modelProxy.stop` / `store.close`。
* **应用退出不是用户取消**：这条链只收资源，**不写任何 Task / Step / HarnessRun 状态**；
  未完成任务保持 `RUNNING` 落库，重启后由既有 `recoverRunning()` 转 `BLOCKED + RECOVERY_REQUIRED`。
* **重复 quit 安全**：`quitting` 标志在 `preventDefault()` 之前同步置位，第二次 will-quit 直接放行，不会跑两套收尾。

### 0.2 顺带修掉的真实缺陷（门禁暴露，不修则本批根本测不出退出）

原实现（本批之前的 `main.cjs`）：
`event.preventDefault(); disposeMcpBounded(...).then(() => { ...; app.quit(); })`

实测（Electron 44.3.0）：**在 `.then()` 微任务里再调 `app.quit()`，退出序列不会继续** —— 事件停在
`will-quit`、`before-quit` / `quit` 都不再来、进程只能被外部杀掉。最小复现
`experiments/d5-03/batch11/verify/quit-microtask-repro.mjs`（两个真实 Electron 进程，同一段代码只改调度）：

| 模式 | 观测 | 结果 |
| --- | --- | --- |
| 微任务（`.then` 里 `app.quit()`） | `TRIGGER → BEFORE_QUIT → DISPOSED`，之后**没有**第二次 `BEFORE_QUIT` / `WILL_QUIT` / `QUIT` | **挂死**，8.2s 后 SIGKILL |
| 宏任务（`setImmediate` 里 `app.quit()`） | `TRIGGER → BEFORE_QUIT → DISPOSED → BEFORE_QUIT → QUIT` | 正常退出，1.29s，exit 0 |

修法：收尾完成后的 `app.quit()` 放进 `setImmediate`，并加 **3s 有界保险丝** `app.exit(0)`
（万一退出序列仍不推进，也绝不把「关不掉的应用」留给用户）。

## 1. 真实 Electron 退出验收（6 场景 + 重启核对）

运行：`npm run test:d5-03-exit` → `experiments/d5-03/batch11/verify/exit-e2e.mjs`
（真实 Electron 进程 + 真实 `dist` 渲染层 / preload / IPC + 真实 `createOpenArcRuntime` + 真实
`HarnessAdapter` / `TaskHarnessOrchestrator` + **真实 `disposeAppResources`**；
受控假体：harness 子进程 = `tests/fixtures/harness-acp/*` 探针，Provider = 独立进程假 Provider（只监听 127.0.0.1），
MCP 服务 = `tests/fixtures/mcp/echo-server.mjs --http`；**不靠测试进程结束自动杀子进程**）

**计数：86 / 86 PASS，exit 0，41s**（`verify/01-exit-e2e.txt`）

| 场景 | 退出码 | 退出时长 | 在途后代进程峰值 | 退出后孤儿 | 退出前库中状态 | 重启后 |
| --- | --- | --- | --- | --- | --- | --- |
| A `session/new` 启动中 | 0 | 418ms | 4 | **0** | task `RUNNING` / run `STARTING` | task `BLOCKED` / run `BLOCKED + RECOVERY_REQUIRED` |
| B `prompt` 执行中（模型请求在途） | 0 | 564ms | 4 | **0** | task `RUNNING` / run `RUNNING` | task `BLOCKED` / run `BLOCKED + RECOVERY_REQUIRED` |
| C MCP 流 + Harness 同时活跃 | 0 | 139ms | 6 | **0** | task `RUNNING` / run `RUNNING` | task `BLOCKED` / run `BLOCKED + RECOVERY_REQUIRED` |
| D 重复 quit（两次） | 0 | 111ms | 4 | **0** | task `RUNNING` / run `RUNNING` | task `BLOCKED` / run `BLOCKED + RECOVERY_REQUIRED` |
| E 对照：正常任务成功 | 0 | 156ms | 4 | **0** | task `SUCCEEDED` / run `SUCCEEDED` | task `SUCCEEDED`（**未被改写**） |
| F 对照：用户主动取消 | 0 | 135ms | 6 | **0** | task `CANCELLED` / run `CANCELLED` / `cancel_requested=1` | task `CANCELLED`（**未被改写**） |

每个场景另外逐项通过：`proxyStopped=true` 且 `storeClosed=true`（收尾在关库前完成）；`harness.timedOut=false`；
探针内 `uncaughtException` / `unhandledRejection` 计数 0；`PRAGMA integrity_check` = ok（`walBytes=0`）；
旧能力请求被拒（进程内 Model Proxy 随退出消失，原 baseUrl `ECONNREFUSED`）；
MCP：服务端 `getSse.openStreams = 0`（56 条事件后由客户端关闭），连接在库中收尾；
全批结束后按命令行标记自检 **0 残留进程**（`firstPass:5 → remaining:[]`）。

## 2. 门禁计数（被测 commit `0eed84c`）

| 门禁 | 结果 | 耗时 |
| --- | --- | --- |
| `npm run test:d5-03-exit`（真实 Electron 退出） | **86 / 86 PASS，exit 0** | 41s |
| `tests/app-shutdown.test.mjs`（新增单测） | **5 / 5 PASS** | <1s |
| `npm run test:d4-02c`（Harness 受影响面） | **33 / 33 PASS，exit 0**（dsh 0.1.5-rc.2 / acp 1.4.0 / schema 21） | 47s |
| MCP 生命周期 + 流 `tests/d5-03-mcp-{lifecycle,stream}.test.mjs` | **17 / 17 PASS，exit 0** | 17s |
| `tests/app-shutdown.test.mjs` + `tests/d4-04-closure2-boot.test.mjs`（boot 顺序） | **14 / 14 PASS，exit 0** | <1s |
| 全量 `npm test` | **exit 1：1399 tests / 1397 pass / 2 fail**（duration 139671ms） | 139s |

全量失败名单（**恰为既有两条确定性失败，本批未修、未放宽断言**）：
① `d4-03-approval-push-isolation` P2「当前会话 = A（owner）：推送投递，载荷 = 白名单投影且与 getApprovalRequest 一致」；
② `side-effect-c4-gates`「No Direct Domain Bypass：resource.trash 的唯一 Domain 调用点在 allowlisted adapter + controlled execution 内」。
1394 → 1399 = 本批新增单测 5 条（新增文件 `tests/app-shutdown.test.mjs`），无既有断言被改。

## 3. 断言变化清单

**无既有断言被修改 / 放宽 / 跳过**。新增：`tests/app-shutdown.test.mjs` 5 条领域断言 +
真实退出驱动的 86 条过程/状态断言（含 6 场景 × 退出码、时长、孤儿、库状态、重启恢复）。

## 4. 未验收 / 单列

* **未做界面截图**：本批 `src/**` 0 行改动，退出过程无界面变化（退出前窗口仍是既有渲染）。
* **新发现（本次不修，另案）**：场景 F 暴露「用户取消后 `runTask` promise 在有在途模型调用时不收敛」——
  取消后 20s 内 `runTask` 仍未 settle，而 task / run 已是 `CANCELLED`；与第十批登记的 R2 同一片区域
  （取消路径与在途 model call），但**证据不同**：本次观测的是 run promise 不收敛，R2 观测的是 call 停在 `STARTED`。
  建议与 R2 同批裁决。
* **未验**：崩溃 / SIGKILL 退出（无 `will-quit` 机会）不在本批；退出保险丝 `app.exit(0)` 的触发路径未构造用例
  （正常收尾耗时可忽略，保险丝只在退出序列不推进时生效）。
* `quitting` 标志之外的多窗口 / 二次 `app.quit()` 并发路径已用场景 D 覆盖（两次连续 quit）。
