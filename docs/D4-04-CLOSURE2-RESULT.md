# D4-04 Closure-2 · 结果记录（Real Product Main Assembly Seal）

Base HEAD：`001d9a4ffa7ccb98474cb5369d1fda5fe558a5a9`

## Task Status

`D4-04 Closure-2 = PASS candidate`；`D4-04 = PASS candidate`；`D4-05 = NOT STARTED`。

## Production Main Boot Ordering

真实 `electron/main.cjs` 原先在 `identity` 尚未创建时就执行：

```js
try { await identity.modelProxy.start(); } catch { /* 吞掉 */ }
```

`identity` 此时是 `undefined` → `TypeError` 被空 catch 吞掉 → **真实产品 Model Proxy 从未启动**。
这是上一轮 probe（顺序正确）与真实 main 漂移造成的 production assembly bug。

修复后的真实顺序（与 §3 图一致）：

```
app.whenReady()
  → createOpenArcRuntime({ userDataDir, safeStorage, nativeImage, executorLauncher, allowAdmin, serviceIdentity })
      → createIdentityService(...)
      → await identity.modelProxy.start()
  → new BrowserWindow(...)
  → registerIdentityIpc / registerTaskIpc（Task admission 入口）
  → win.loadURL(dist/index.html)
```

永久规则已固化在共享 helper：**No Task admission before Model Proxy boot has been attempted
against the actual created identity runtime.**

## Shared Product Runtime Boot

新增 `electron/runtime-boot.cjs`（**唯一** production boot）：

- `createOpenArcRuntime({...})`：创建 identity → 对**真实已创建的 identity** 尝试 `modelProxy.start()`
  → 返回 safe boot evidence（`bootOrder` / `modelProxyStart` / `modelProxyListening` / `noteTaskAdmission()` / `snapshot()`）。
- `startProductModelProxy(identity)`：identity 不存在或没有 `modelProxy.start` → 抛
  `OPENARC_ASSEMBLY_ORDER_VIOLATION`（loud fail，**绝不**被当成 "provider unavailable"）；
  真实启动失败只记录 safe `errorCode`（`MODEL_PROXY_START_FAILED` / `MODEL_PROXY_NOT_LISTENING`），
  Harness 之后自行 fail closed。
- `electron/main.cjs` 与 `tests/fixtures/d4-04-probe/main.cjs` **都**调用
  `createOpenArcRuntime`；`main.cjs` 不再自行 `createIdentityService`，也不再自行 start proxy。
- test-only seam 仍只有 `executorTestHook`：production main 不传（默认 null），probe 传
  `() => executorSeam.fault`（constructor-only，绝不经 Renderer / IPC / env / Harness）。

## Model Proxy Start Evidence

D4-04 artifact 新增 `productRuntime`（safe，无 token / 无绝对路径 / 无 credential）：

```json
{
  "identityCreated": true,
  "modelProxyStartAttempted": true,
  "modelProxyStarted": true,
  "modelProxyListening": true,
  "modelProxyErrorCode": null,
  "bootOrder": ["identity_created","model_proxy_start_attempted","model_proxy_started","runtime_ready"],
  "taskAdmissionAfterProxyStart": true
}
```

对应 Gate check：`A6 · Real product runtime boot assembly`。

## Task Admission Ordering

`bootOrder` 由 helper 内部按真实发生顺序记录；probe 在第一次 `task/run` 之前调用
`noteTaskAdmission()`，要求 `afterProxyStartAttempt && afterRuntimeReady` 同时为 true。
因此真实断言成立：

```
identity_created < model_proxy_start_attempted <= model_proxy_started < runtime_ready < 第一次 task/run
```

## Probe/Product Equivalence

新增 Gate：`tests/d4-04-closure2-boot.test.mjs`（9 tests，`npm run test:d4-04-closure2`）：

- static：`main.cjs` 与 probe 都 require + 调用同一个 `createOpenArcRuntime`；
  `main.cjs` 不得自行 `createIdentityService`、不得在 helper 之外 `await identity.modelProxy.start()`、
  不得用空 catch 吞掉 proxy start；
- static：两者都使用产品 `registerIdentityIpc` / `registerTaskIpc` / `createDefaultExecutorLauncher()`；
  probe 使用产品 `electron/preload.cjs` + `dist/index.html`，不得自建 `RuntimeSupervisor` /
  `SideEffectRuntime` / 测试夹具装配 / 覆盖 Tool Facade 配置；
- dynamic：真实调用 `createOpenArcRuntime`，断言 Model Proxy 真正 listen 在 `127.0.0.1`，
  且 boot 顺序正确；
- regression（§10）：`startProductModelProxy(undefined | {} | {modelProxy:{}})` 必须抛
  `OPENARC_ASSEMBLY_ORDER_VIOLATION` —— 即"modelProxy.start 早于 identity 创建"会被真实检测并失败。

允许差异仅限 test-only：temporary userData、deterministic local provider、admin setup、
`executorTestHook`、`BrowserWindow show=false`。

## Electron Launcher Fail-closed

`electron/executor-launcher.cjs` 新增：

- `UnavailableExecutorLauncher`（`available=false`，`launch()` 抛 `EXECUTOR_LAUNCHER_UNAVAILABLE`）；
- `selectExecutorLauncher({ isElectronMain, utilityProcess })`：
  Electron main + `utilityProcess.fork` 可用 → utility launcher；
  Electron main + 不可用 → **UnavailableExecutorLauncher（fail closed）**，**绝不**回退
  `spawn(process.execPath, ...)`（Electron executable 不是普通 Node contract）；
  纯 Node → 既有 `NodeChildProcessLauncher`（`spawnImpl` / `nodePath` test seam 保留）。

`RuntimeSupervisor.spawnExecutor()` 在 `launcher.available === false` 时直接返回
`EXECUTOR_LAUNCHER_UNAVAILABLE`（不注册 runtime、不 spawn、0 lease / 0 mutation）；
`SideEffectRuntime.executeApproved()` 在 admission 失败时把 pending call 明确收敛为
`BLOCKED`，绝不留一条可被再次触发的 APPROVED call。

## Utility Process Regression

未回退：WRITE executor `spawned=true / ready=true / exited=true / exitCode=0`；
UNKNOWN executor `spawned=true / ready=true / exited=true / exitCode=9`；
`launcher=ElectronUtilityProcessLauncher / processType=browser`。

## Socket Path Regression

长 `runtimeDir` 仍派生短 socket 目录（`os.tmpdir()/oart-sock-<sha256(runtimeDir)>/`），
`ready=true`；persisted executor record **不含** `socketPath`；cold restart semantics 不变
（D4-03C4 Closure-2/3 全 PASS）。

## WRITE / UNKNOWN_EFFECT / Deny / Cancel / UI Busy / Spoof / Reload

全部继续 PASS（与 Closure-1 相同语义）：WRITE `SideEffectCall=1 / Approval=1 / Lease=1(RELEASED) /
mutation=1 / verification=PASS`；UNKNOWN 真实 child claim → 真实 exit → `UNKNOWN_EFFECT` →
Step/Task `BLOCKED`（0 retry / 0 第二 call / 0 第二 lease）；Deny 0 mutation / 0 lease / 0 executor；
Cancel `CANCELLED`；UI busy 由 backend authoritative `task/get` 复位；Spoof actor/risk 被忽略；
Reload 从 backend 恢复；无 parent direct mutation 制造 `UNKNOWN_EFFECT`。

## AUTO_RETRY

`AUTO_RETRY = 0`。

## D4-04 Gate

`npm run test:d4-04` = **44 / 44 checks PASS**（在 Closure-1 的 43 项之上新增
`A6 · Real product runtime boot assembly`）；`productRuntimeBoot=true`，
`providerRequests=4`，`rendererConsoleErrors=0`，`mainUnhandledErrors=0`，`secretHits=0`。
artifact：`artifacts/d4-04/vertical-smoke-gate.json`。

## Regressions

```
D4-03d 52/52 · d4-03d-closure 62/62 · d4-03c4 35/35（UI 22/22）· c4-closure 15/15 ·
c4-closure2 12/12 · c4-closure3 9/9 · c3 56/56 · c3-closure 63/63 · c2 29/29 ·
c2-closure 38/38 · c2-closure2 45/45 · c2-closure3 51/51 · c1 48/48 ·
c1-closure 52/52 · c3b 59/59 · c3a 32/32    全部 PASS
D4-02a 22/22 · D4-02b 16/16 · D4-02c 22/22 · D4-01 59/59   全部 PASS
D4-04 Closure-2 boot/equivalence 9/9 PASS
npm test = 911/911 PASS
npm run build = PASS
npm run test:security = FAIL 0 / PARTIAL 2 / PASS 6（= 基线，无新增）
```

## Files Changed

见 §23 的 `git diff --name-only 001d9a4...HEAD`。

## Remaining Gaps（未关闭）

`OS-level network sandbox = NOT VERIFIED`；`external workspace read audit = NOT VERIFIED`；
`independent malformed ACP injection = NOT VERIFIED`；`Windows = NOT VERIFIED`；
`External Provider = NOT VERIFIED`；`Explicit Resume = DEFERRED`；
`broader Domain verifiers = NOT VERIFIED`；
`authenticated durable cross-restart process-death proof = DEFERRED / NOT VERIFIED`。

## 诚实说明

- 本轮采用 §8 明确允许的路径：**共享唯一 production runtime boot helper** +
  static/behavioral equivalence Gate，而不是把真实 `electron/main.cjs` 改成可测试双模式。
  真实 main 与 probe 的 boot/装配是同一份代码；差异仅限 test-only 配置。
- 主 Gate 仍未使用 `createToolHarnessFixture` / 手工 `SideEffectRuntime`；走 production
  bootstrap + 产品 `dist/index.html` + 产品 `electron/preload.cjs`。
