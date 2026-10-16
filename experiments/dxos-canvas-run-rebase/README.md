# DXOS-CANVAS-RUN-REBASE · 无限画布异步生图结果写回

## 缺陷

画布页 `runGenerator` 在 POST `/api/canvas-image-tasks` 之后会 `scheduleSave + saveCanvas` 落盘
「pending 卡片」→ 画布 revision 在模型返回之前前进。修复前 `electron/canvas-service.cjs` 的
`modelCall` 用**整画布** `run.base_revision` 判定：revision 已变 → `CANVAS_CHANGED`，结果被丢弃。
真实中转站 45–90s，必然触发；d5-02 用毫秒级本地 provider，在页面落盘之前就返回，把时序掩盖了。

## 探针

```bash
# 修复前（预期 red：页面生图链 runStatus=failed + 输出节点 0 图 + run stopReason=CANVAS_CHANGED）
node experiments/dxos-canvas-run-rebase/run.mjs --expect=red --delay=4000

# 修复后（预期 green：输出节点有图 + 页面截图能看到图）
node experiments/dxos-canvas-run-rebase/run.mjs --expect=green --delay=4000

# 慢模型（桩延迟 45s，替代真实中转站 45–90s）
node experiments/dxos-canvas-run-rebase/run.mjs --expect=green --delay=45000
```

真实 Electron（`electron .` + 隔离 `--user-data-dir` + 唯一 CDP 端口），走画布页真实链路：

* `[宿主命令链]` `canvas/run` → 期间用 `canvas/command` 编辑别的节点推进 revision → `canvas/modelImage`；
* `[画布页生图链]` `window.__openarcCanvas.runNode('n_gen')`（与节点 ▶ 同一入口）。

`delayed-canvas-provider.mjs` 是**只替代最后一跳网络**的桩 provider：图像路径可控延迟，
返回一张 320×320 渐变 PNG（截图里肉眼可确认「图真的回来了」）。

## 证据

产物在 `artifacts/dxos-canvas-run-rebase/`（gitignore）：

* `RESULT-red.json` —— 修复前：revision 4→5（pending 落盘），run `SUPERSEDED`/`CANVAS_CHANGED`，输出节点 0 图；
* `RESULT-green-4s.json` / `shots/page-chain-green-4s.png` —— 修复后 4s：输出节点 1 图；
* `RESULT-green-45s.json` / `shots/page-chain-green-45s.png` —— 桩延迟 45s（模型真的在途 45.6s）后结果仍写入。

## 注意

DSH/CI 会话可能带 `ELECTRON_RUN_AS_NODE=1`（会让 Electron 以 Node 模式跑 `main.cjs`）；探针在
spawn 时显式删掉它。当前工作树默认加载 Vue 壳 `dist/vue.html`（不是 `dist/index.html`）。
