# D4-04 Closure · 结果记录（Production Executor Runtime + Vertical Completion）

Base HEAD：`232c5a21c79f822a6744b8d922c7aa0d6e74d91d`

## Task Status

`D4-04 Closure = PASS candidate`；`D4-04 = PASS candidate`；`D4-05 = NOT STARTED`。

D4-04 Gate（真实 Electron production vertical smoke）**43 / 43 checks PASS**，
READ / WRITE Approve / Deny / Cancel / UNKNOWN_EFFECT / Renderer Spoof / Renderer Reload /
UI busy reset / console 0 / main 0 / secret 0 全部成立。

## Confirmed Executor Root Cause

真实 Electron main 中记录到：

- `process.type = "browser"`；`process.execPath` 指向 Electron executable（不是 Node runtime）。
  以 Node child 语义 `spawn(process.execPath, [executor.cjs, args])` 只会让 Electron 把脚本
  当成"app main"再跑一个完整 Electron browser 进程 —— 依赖非契约行为。
- 但本轮 VERTICAL 的直接 blocker 还有第二个、且更致命的事实：
  **macOS unix socket pathname 上限约 104 字节**。
  production `runtimeDir = <userData>/runtime/side-effects`；在 probe 的临时 userData 下
  `<runtimeDir>/executors/exe_<id>.sock` = **113 字节** → executor 在自己的 lifetime endpoint
  `listen()` 直接失败（`endpoint_bind_failed`）→ **连 `{"type":"ready"}` 都不会发出** →
  executor 进程退出，但 call 停在 `APPROVED`、0 lease、0 mutation、Task `BLOCKED`。
  这正是 22/29 那一轮观察到的 `tool.side_effect.execution_blocked`。

两者都必须修：launcher 负责"起对 runtime"，socket path 负责"进得去 runtime"。

## Production Executor Launcher

新增 `electron/executor-launcher.cjs`，只做 spawn / stdio 归一化 / kill，**不做**任何
quiescence 或 death 判定；生命周期 authority 仍然只有 `RuntimeSupervisor`：

- `NodeChildProcessLauncher`：纯 Node（tests / fixtures）默认；仍支持既有 `spawnImpl` / `nodePath` seam。
- `ElectronUtilityProcessLauncher`：Electron product main 默认；用 `utilityProcess.fork()`
  （Electron 官方 Node-enabled child，不依赖 `ELECTRON_RUN_AS_NODE` / `runAsNode` fuse）。
- 归一化事件面：`spawn / stdout / stderr / exit / close / error`；launch 失败也会产生
  `exit + close`，ready handshake 永不悬空。
- utility child **不能 pipe stdin**（Electron 限制），gated test fixture 继续走 Node launcher。
- utilityProcess 的 stdout/stderr 退出后**不会**发 `end`/`close`（`readableEnded` 恒为 false）：
  launcher 用 event-loop drain（有数据就重排，连续两个 turn 无新数据才 close）正规化 `close`，
  保证 `executeApproved()` parse 之前 stdout 已完整，不靠固定 sleep 猜 flush。

注入路径（Renderer / Harness / ACP / Tool args 无法选择）：

```
createIdentityService({ executorLauncher, executorTestHook })
  → createTaskBundle(...)
    → RuntimeSupervisor({ launcher, executorTestHook })
```

真实 `electron/main.cjs` 与 probe host **都**调用 `createDefaultExecutorLauncher()`，
并共享 `createIdentityService` / `registerIdentityIpc` / `registerTaskIpc` 同一份 production 装配。

### socket path 长度归一（生产健壮性修复）

`RuntimeSupervisor.socketPath(instanceId)` 仍是"validated instanceId 派生"的单一来源；
当自然路径超过安全字节上限时（默认 100），退化到 `os.tmpdir()/oart-sock-<sha256(runtimeDir) 前 16>/`
（mode 0700）下的同名 socket。record 仍留在 `<runtimeDir>/executors`，永不落 socketPath。
actual probe path 由 supervisor 经 spawn args 注入 child（`args.socketPath`），
production executor entry 只用它，绝不自行换一套规则。

## Executor Ready Handshake

`spawnExecutor()` 现在返回 `box.ready`：只有真实读到 `{"type":"ready"}` 才算
"runtime successfully entered executor"。spawned 但未 ready 就退出：

- `executeApproved()` → `EXECUTOR_START_FAILED`（fail closed，0 lease / 0 mutation）；
- 已有的 lease（若 child 已 acquire）走 `recoverAfterExecutorExit` 收敛；
- 新增 `SIDE_EFFECT_EXECUTOR_START_FAILED` 错误码；绝不模糊成业务 Domain failure。

`RuntimeSupervisor.executorEvidence()` 记录 safe 证据（instanceId / spawned / ready / exited /
exitCode / signal / launchError），**不含 executable path / pid / env**，供 gate 直接断言。

## Production Fault Seam Removal

- 删除 `process.env.OPENARC_EXECUTOR_FAULT` 及其在 `SideEffectAuthority` 里的
  `process.exit(9)`；删除 Supervisor 对该 env 的 passthrough。
- 换成 constructor-only seam：`executorTestHook`（production 默认 null），只有 D4-04 probe
  assembly 显式注入 `() => "CRASH_AFTER_CLAIM"`；child 只认 spawn args 里的固定值，
  绝不读 env / IPC / Harness / ACP / tool args / model text。
- UNKNOWN 场景是真实 `claim RUNNING → 子进程 process.exit(9)` → production supervisor
  真实观测 child exit → `recoverAfterExecutorExit` → `UNKNOWN_EFFECT`；**没有**任何 parent
  直接写 `UNKNOWN_EFFECT` 的捷径。

## WRITE Vertical Smoke

真实链路：Renderer Run → official dsh → `resource.trash` → Approval UI → 真实 Approve →
utility executor ready → lease → claim → `ResourceService.delete` exactly once → Domain verify PASS →
`SideEffectCall SUCCEEDED` → Harness continuation → Task/Step SUCCEEDED → Renderer 显示最终文本。

- SideEffectCall = 1；Approval = 1；Lease = 1（RELEASED）；mutation = 1；verification = PASS；AUTO_RETRY = 0。
- executor evidence：`spawned=true / ready=true / exited=true / exitCode=0`。

## UNKNOWN_EFFECT Vertical Smoke

Approve → ready → acquire lease → **claim RUNNING（TaskEvent `tool.side_effect.execution_started`）**
→ 注入 child fault 真实 `process.exit(9)` → production supervisor 真实 child exit →
`recoverAfterExecutorExit` → `UNKNOWN_EFFECT` → quiesced=true（同一 supervisor lifetime）→
`verifyUnknownEffect` NOT_APPLIED → Call FAILED、Step/Task BLOCKED、Harness STOP、Renderer BLOCKED。

- SideEffectCall = 1；crash_after_claim 的 mutation = 0；第二 call = 0；第二 lease = 0；AUTO_RETRY = 0。
- executor evidence：`ready=true / exited=true / exitCode=9`。

## Deny / Cancel / UI Busy Reset

- Deny：0 mutation / 0 lease / 0 executor / SideEffectCall `BLOCKED` / Task 非 RUNNING / Harness STOP / UI busy=false。
- Cancel：Task `CANCELLED`、0 mutation、0 lease、capability 回收、UI busy=false；Cancel 后旧 approval 再点 = `SIDE_EFFECT_CALL_STATE`（0 authority）。
- UI busy 不再只依赖 happy-path `task/result`：AIPanel 以 backend authoritative `task/get` 轮询收敛，
  任何 terminal（SUCCEEDED / FAILED / BLOCKED / CANCELLED）都复位 Run/Cancel；BLOCKED 显示
  `BLOCKED · Recovery Required`，绝不显示 Succeeded / 自动重试。

## Renderer Spoof / Renderer Reload

- Spoof：Renderer 自报 `userId / role / sessionRef / riskClass` 全部被忽略，真实 session 决定 actor
  （admin）与 effect class（REVERSIBLE_WRITE），并且仍然 exactly-once 受控执行 + verify；
  伪造 `approvalRequestId` → 拒绝，0 authority gain。
- Reload：真实 `webContents.reload()` 后只经 `task/list` + `task/get` 从 backend authoritative
  state 恢复 Task 状态与 artifact，不依赖 Renderer memory。

## READ Regression / Tool Capability Budget / AUTO_RETRY

- READ：ToolExecution = 2（search + read）且 verification PASS、0 SideEffectCall、0 mutation、
  Task SUCCEEDED、Renderer 显示最终文本。
- Tool budget：真实观测每任务最多 **2** 次受控 tool call → 回到 D4-03D 冻结默认 `maxCalls: 8`
  （bounded；`MAX_TOOL_ROUNDS` 不变）。`AUTO_RETRY = 0`。

## D4-04 Gate

`npm run test:d4-04`（= `npm run build && node tests/d4-04-smoke.mjs`）：

```
43 / 43 vertical smoke checks passed
readSmoke/writeApproveSmoke/executorReady/writeDenySmoke/cancelSmoke/unknownEffectSmoke/
uiBusyReset/rendererSpoof/rendererReload = true
rendererConsoleErrors=0  mainUnhandledErrors=0  secretHits=0
maxToolCallsPerTask=2  businessMutations=1  leases=1  approvals=1  sideEffectCalls=1
```

artifact：`artifacts/d4-04/vertical-smoke-gate.json`（gitignored）。

## Regression

```
D4-03d 52/52 · D4-03d-closure 62/62 · D4-03c4 35/35 + UI 22/22 · c4-closure 15/15 ·
c4-closure2 12/12 · c4-closure3 9/9 · c3 56/56 · c3-closure 63/63 · c2 29/29 ·
c2-closure 38/38 · c2-closure2 45/45 · c2-closure3 51/51 · c1 48/48 ·
c1-closure 52/52 · c3b 59/59 · c3a 32/32       全部 PASS
D4-02a 22/22 · D4-02b 16/16 · D4-02c 22/22 · D4-01 59/59   全部 PASS
npm test = 902/902 PASS
npm run build = PASS
npm run test:security = FAIL 0 / PARTIAL 2 / PASS 6（与 D4-03D 基线一致，无新增）
```

## Files Changed

- `electron/executor-launcher.cjs`（新增）
- `electron/runtime-supervisor.cjs`
- `electron/side-effect-authority.cjs`
- `electron/side-effect-domain.cjs`
- `electron/side-effect-executor.cjs`
- `electron/side-effect-runtime.cjs`
- `electron/task-bootstrap.cjs`
- `electron/identity-bootstrap.cjs`
- `electron/main.cjs`
- `src/desktop/components.tsx`
- `tests/d4-04-smoke.mjs`
- `tests/fixtures/d4-04-probe/main.cjs`
- `docs/D4-04-RESULT.md`

## Remaining Gaps（未关闭）

`OS-level network sandbox = NOT VERIFIED`；`external workspace read audit = NOT VERIFIED`；
`independent malformed ACP injection = NOT VERIFIED`；`Windows = NOT VERIFIED`；
`External Provider = NOT VERIFIED`；`Explicit Resume = DEFERRED`；
`broader Domain verifiers = NOT VERIFIED`；
`authenticated durable cross-restart process-death proof = DEFERRED / NOT VERIFIED`。

## 诚实说明

- 主 Gate 未使用 `createToolHarnessFixture` / 手工 `SideEffectRuntime`：它使用 production
  bootstrap 函数 + 产品 `dist/index.html` + 产品 `electron/preload.cjs`。probe host 与真实
  `electron/main.cjs` 调用同一 production assembly；差别仅是"谁创建 BrowserWindow"。
- OpenArc 决定 / 执行 / 验证：Harness 只能 propose；approval 只来自 trusted user action；
  真实 mutation 只发生在 supervisor 监督的 utility executor 进程里。
