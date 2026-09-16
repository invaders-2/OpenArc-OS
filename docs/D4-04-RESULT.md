# D4-04 · 结果记录（Production Vertical Smoke）— PARTIAL

Base HEAD：`43d0738439bf95737eee77976923a138fd21c3d0`

## Task Status

`D4-04 = PARTIAL`（不是 PASS candidate）；`D4-05 = NOT STARTED`。
本轮把 D4-01/02/03 放进真实 Electron production 装配链，新增 production Task IPC + Renderer AI 面板 +
deterministic local provider edge + 真实 Electron 垂直 smoke；READ / Cancel 场景已真实贯通，
WRITE / UNKNOWN_EFFECT / spoof / reload 场景尚未收敛，故**不满足 D4-04 PASS Gate**。

## 已完成的 production 改动

- `electron/task-bootstrap.cjs`：新增 `registerTaskIpc`（task/run、task/get、task/list、task/cancel）+
  `TASK_COMMANDS`；并修复 production Tool Facade capability 预算（未设置 maxCalls 会退化成 1，
  第二次 tool call 直接 `TOOL_CAPABILITY_EXHAUSTED`）→ `maxCalls:16, ttlMs:300000`。
- `electron/main.cjs`：注册 task IPC；**boot 时启动 Model Proxy**（此前 production 从不 start，
  Harness 直接 `HARNESS_MODEL_PROXY_UNAVAILABLE`）；will-quit 停止 proxy。
- `electron/preload.cjs`：新增窄桥 `task: { command, onEvent }`。
- `src/desktop/components.tsx`：AIPanel 接入真实 Task Runtime（goal/Run/Cancel/状态/结果；
  reload 后从 `task/list`+`task/get` 恢复 backend 权威状态）。
- `electron/runtime-supervisor.cjs` / `electron/side-effect-authority.cjs`：env-gated
  `OPENARC_EXECUTOR_FAULT=crash_after_claim` 受控 fault seam（默认关闭，仅用于最小真实
  UNKNOWN_EFFECT 垂直 smoke）。

## 新增 smoke 基础设施

- `tests/fixtures/d4-04-provider.mjs`：deterministic local HTTP provider edge（只替代最后一跳）。
- `tests/fixtures/d4-04-probe/main.cjs`：真实 Electron probe host（`createIdentityService` +
  `registerIdentityIpc` + `registerTaskIpc` + 产品 `dist/index.html` + 产品 preload）。
- `tests/d4-04-smoke.mjs`：启动 provider + Electron，驱动真实 Renderer UI，输出
  `artifacts/d4-04/vertical-smoke-gate.json`。
- `package.json`：`test:d4-04` = `npm run build && node tests/d4-04-smoke.mjs`。

## 真实 Electron 运行记录

macOS arm64 / Electron `44.3.0` / Node `24.20.0` / official dsh `0.1.5-rc.2` / ACP `1.4.0`。

上一次完整 smoke：**22 / 29 checks PASS**。

已 PASS（真实贯通）：
- production Electron 启动、真实 UI 登录、preload 窄桥、Renderer 无 Domain/TaskRuntime；
- **READ vertical smoke**：Renderer Run → task:command → Task Runtime → official dsh → ACP →
  Model Proxy → provider edge → resource.search/read → verification PASS → Task SUCCEEDED → UI 显示结果；
- **Cancel while waiting**：Approval UI 可见 → UI Cancel → Task CANCELLED、0 mutation、capability revoked；
- Deny 的 0 mutation（部分断言）。

未 PASS（本轮 blocker）：
- `C2/C6/C7` WRITE：Approval APPROVED 后 `tool.side_effect.execution_blocked`，0 lease、0 mutation、
  Task BLOCKED（受监督 executor 未成功执行；需继续定位 production `spawnExecutor` 路径）；
- `F1–F4` UNKNOWN_EFFECT：Task 停在 RUNNING，未收敛到 BLOCKED；
- spoof / reload 场景未到达；
- 最后一次 probe 因 UI Run 按钮 busy 未复位而提前中止。

## Remaining Gaps（未关闭）

`OS-level network sandbox = NOT VERIFIED`；`external workspace read audit = NOT VERIFIED`；
`independent malformed ACP injection = NOT VERIFIED`；`Windows = NOT VERIFIED`；
`External Provider = NOT VERIFIED`；`Explicit Resume = DEFERRED`；
`broader Domain verifiers = NOT VERIFIED`；
`authenticated durable cross-restart process-death proof = DEFERRED / NOT VERIFIED`。

## 说明

- 主 Gate **未**使用 `createToolHarnessFixture` / 手工 `new SideEffectRuntime`；它使用 production
  bootstrap 函数 + 产品 Renderer/preload。`main.cjs` 现在与 probe host 注册同一份 task IPC。
- 本轮**未**重跑完整 D4-03 / D4-02 / D4-01 regression（gate 未绿，未提交“完成”声明）；
  下一轮应先修复 WRITE/UNKNOWN 再补全回归。
- 不声明 `D4-04 = PASS candidate`。
