# dxos-design-retro · 本轮前端改动的设计语言回溯复查

定位：只产出可复核证据（截图 / 机器可读报告 / 逐项核对表），不替裁决人下「设计通过」结论。
被测对象是本轮（10-16 / 10-17）改动的全部前端页面与状态。

## 为什么有这个探针

用户要求：**回溯复查本轮所有前端改动是否符合项目既有设计语言；有偏差就最小修正**，
且**禁止自行发明新 UI 样式 / 视觉风格 / 组件库**。所以这里做两件事：

1. **逐项核对表**（文件:行 / 规范条目 / 现行写法 / 是否偏差 / 处置）——人工读规范与源码得出；
2. **真机证据**——把核对结论落到可复核的截图上，尤其是修复项的修复前后对照。

## 怎么跑

```bash
node experiments/dxos-design-retro/probe.mjs                      # 现状（after-*）
DXOS_RETRO_PHASE=before node experiments/dxos-design-retro/probe.mjs   # 修复前（before-*）
node experiments/dxos-design-retro/_debug-bridge.mjs              # 诊断：contextBridge 是否可替换
node experiments/dxos-design-retro/_debug-facts.mjs               # 诊断：协议详情事实列是否重叠
```

修复前后对照必须在**同一份 dist 语义**下取：改 `src/styles.css` 后先 `npx vite build`，
再跑 before（需先临时回退那段 CSS）；不复用旧 dist，否则两轮拍到的是同一份 CSS。

## 产物

`artifacts/dxos-design-retro/{before,after}/`

| 文件 | 内容 |
| --- | --- |
| `report.json` | 全部断言 + console/pageerror + 对比度 + ui-audit + profile 未改动 |
| `ui-audit.json` | 设置容器内的计算样式扫描：彩色 / 发丝线 / 字重 / 圆角（DS-A09、§3.2、§5、§6） |
| `confirm-button.json` | 弹层主按钮的计算样式与对比度（浅/深） |
| `rule-probe.json` | 命中 DsDialog footer 主按钮的**全部** CSS 规则（层冲突取证） |
| `shots/*.png` | 2880×1800@2（1440×900 @ DSF2）与 1640×1440（820×720 @ DSF2）截图 |

## 硬约束（与既有探针同口径）

不联网（只连本机 CDP）；不改产品代码；不新增依赖；不 git commit；
`--user-data-dir` 与 `--remote-debugging-port` 双隔离；收工对真实 profile 做只读快照比对。

## 本轮探针自身踩到的两个坑（已记，避免下次重复）

1. **contextBridge 是冻结的**：`Object.isFrozen(window.openarc.marketUpdate) === true`，
   `command` 是 `writable:false, configurable:false`，渲染层**无法**替换桥方法。
   要构造「有更新可用」的确认层，必须按产品真实读取路径预置
   `<userData>/dxos/apps/canvas/check.json`（`market-update-service.cjs#readCheckState`）。
2. **不要合成 pointerdown 到 `.window-title`**：v1 `WindowLayer.vue#startDrag` 会算位移，
   合成事件会把窗口拖到 (0,0)。换前台要用真实路径（回程序坞点图标 → `shell.activateApp`）。
