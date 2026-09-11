# D2-02 Result

**Task Status: macOS 范围 COMPLETE / overall PARTIAL**

（D2-02A Gate = COMPLETE（有决策）；D2-02B = macOS 范围内 COMPLETE；
D2-02 overall 保持 PARTIAL —— 因为 Windows 与若干性能/E2E 项未验证，不得外推）

本轮**已停止**，未进入 D2-03 / D3 / D4 / D5。

---

## 1. Task Status

| 层级 | 结论 | 依据 |
|------|------|------|
| D2-02A Window Architecture Gate | **COMPLETE（有决策）** | CHOOSE HYBRID（E），116/116 断言，本轮已复跑复现 |
| D2-02B Window System Implementation | **macOS 范围 COMPLETE** | 7/7 探针 PASS，179 条产品侧断言 + 75 条纯逻辑单测 |
| **D2-02 overall** | **PARTIAL** | Windows / 真实多显示器 / GPU 性能 / 快照性能 / UI E2E 未验证 |

## 2. 结论摘要

Window Domain 与 Window Manager 成为**唯一状态权威**（9 条冻结命令 + 3 条系统变更），
手动 UI 与未来 AI 走同一命令层；原生视图的遮挡与生命周期在**产品真实模块**上
46/46 通过；四态结算 `live / clip+snapshot / snapshot / hidden` 全部可达。

本轮审出并修掉 **9 个真实产品缺陷**（见 §25），其中"层级泄漏成数组顺序"
是最严重的一个：它让**点击后台窗口的红绿灯按钮要点两次**。

## 3. 基线与环境

- 基线：D1-01 = PARTIAL、D1-06 = PARTIAL / CONDITIONAL GO、D2-01 = PARTIAL、
  D2-02 = CONDITIONAL GO（仅 macOS 范围）、Windows = NOT VERIFIED
- 环境：macOS arm64、Electron 44.3.0 / Chromium 152 / Node 24.20、
  单屏、无 Windows 真机
- 本机硬约束：Chromium 沙箱无法初始化，原生探针必须带
  `--no-sandbox --disable-gpu-sandbox --in-process-gpu`；
  因此"运行时沙箱强制执行"在**本机**记 NOT VERIFIED（不是 PASS）

## 4. 分支与提交

分支 `feature/d2-02-window-system`，从 `feature/d2-01-design-system`
（HEAD = `effd5dc`）切出。**未 merge main。**

| 提交 | 内容 |
|------|------|
| `6994dcd` | `docs(D2-02): evaluate window and native-view architecture`（Gate） |
| `a337f02` | `D2-02: establish window domain and manager` |
| `6a3c3e9` | `D2-02: componentize desktop window surfaces` |
| `b6d8521` | `D2-02: implement native-view occlusion and lifecycle` |
| `083fc57` | `D2-02: fix window focus pointer and occlusion integration` |
| `5f34414` | `test(D2-02): verify window focus dialog motion and security surfaces` |
| `d8ba2b3` | `docs(D2-02): record window system implementation` |

已推送 `origin/feature/d2-02-window-system`。

> 偏离说明：§46 建议 5 条原子提交，本轮实际 7 条。原因是 B 阶段除了探针之外
> 还审出并修掉了一批真实产品缺陷，把它和"测试"塞进同一条提交会让修复不可复核。
> 因此拆成"产品修复 / 探针 / 文档"三段，仍保持每条提交可独立理解。

## 5. Current Architecture Map（§3）

五层拓扑：Desktop → Window → System Overlay → Modal → Lock Screen。
六问已逐条回答（ADR §4）。本质：原先窗口状态散落在 React component state 里，
没有唯一权威，也就没有"AI 可操控"的接口。

## 6. Window Domain Model（§4，冻结）

`electron/window-domain.cjs`，纯函数、零 Electron/DOM/React 依赖。
字段：`id / appId / kind / bounds / state / restore / minSize / meta / visible /
displayId / z`。**`appId` 与 `id` 是两个独立的键**（§17）。
常量 token 化：`MIN_WINDOW_W 560`、`MIN_WINDOW_H 400`、`AREA_TOP 44`、`TITLE_BAR_H 44`。

## 7. Window Manager 是唯一状态权威（§5）

`electron/window-manager.cjs`。未知命令原样返回原状态（不抛异常）——
命令层要能承接未来 AI 生成的内容。几何复用 `geometry.clampAll`，
**不重新发明第二套 clamp**（§24）。

## 8. 候选架构评估与 CHOOSE HYBRID（§6 / §7）

A（仅 hide/show）在全遮挡下成立但部分遮挡下不成立；B（收缩到未遮挡矩形）不满足圆角；
C（一窗口一 WebContentsView）可行；D（原生 child 窗口）代价高于收益；
**E = HYBRID：DOM 窗口层 + WebContentsView + 遮挡结算 + 快照补齐**，被选中。
被否决方案有决定性证据（截图为证），不是偏好。

## 9. Prototype 与 A12 原生层级回归（§8 / §9）

最小真实 Prototype 已建。A12 回归用**连续交互 15 步**验证（`06-stress`），
而不是单点截图 —— 单张截图证明不了层级在各种交互后仍然正确。

## 10. Occlusion Model（§10）

三态分类（visible / fullyOccluded / partiallyOccluded）→ 四态处置
（`live` / `clip+snapshot` / `snapshot` / `hidden`）。`CLIP_MIN_RATIO = 0.35`。
快照失效键 = `windowId + bounds + url`。

## 11. 原生视图生命周期 11 项（§11）

`native-view-lifecycle` **46/46**。含创建/复用/几何、四态结算、快照缓存、
导航策略、会话与权限、视图内安全、事件回报、多视图独立、释放、与 Window Manager 接线。

## 12. 多视图与 Session / Partition（§12 / §13）

至少 Browser A + Browser B 互相独立（`two-browser` 37/37）。
同一 App 默认共享其 app session —— 且这条是**冻结契约**，有专门断言。

## 13. 焦点与 Z-order（§14 / §15）

任一时刻**唯一 focused window**；`focused` 不得指向不存在或已最小化的窗口（由
`reindex()` 收口）。置顶是**稳定**的：抬 A 不颠倒其余窗口的相对顺序。

## 14. Dialog / Modal primitive（§16 / §17 / §40）

`src/desktop/Dialog.tsx`：焦点陷阱、`aria-modal`、Esc、关闭后焦点归还原触发元素。
`dialog-a11y` **33/33**。与原生视图的硬验收：对话框打开时原生视图必须让位
（`mode.hidden`）—— 由 `native-view-lifecycle` 与 `02-input` 双重覆盖。
**D2-01 的 Dialog 无障碍缺口因此 CLOSED BY D2-02。**

## 15. Desktop Components 组件化（§18 / §19 / §41）

12 个 Desktop Component 真正拆分；`Window({window, children, onCommand})`
**不拥有任何业务状态** —— 位置尺寸来自 `window.bounds`、层级来自 `window.z`、
聚焦来自 `focused`，它自己只有"拖拽中"一个纯交互状态且不回写域。
且**由产品自身消费**（不是只在 gallery 里存在）。
**D2-01 的"12 个组件只有视觉契约"缺口因此 CLOSED BY D2-02。**

## 16. 9 条 Window Commands（§20 / §21）

`open / close / focus / move / resize / minimize / restore / maximize / unmaximize`，
外加 3 条系统变更 `hydrate / reflow / native-state`。
手动 UI 与未来 AI 共用同一条命令层，**无旁路**。

`window/unmaximize` 原先在产品里**不可达**（按钮与双击都只发 maximize）——
用户放大后回不来。已修，并有守卫断言。

## 17. Window Persistence（§22）

沿用 `oa-wins` 键，经 Window Manager 序列化。只写跨会话成立的字段，
**不写** `focused / order / z` —— 上次退出时谁在最上层不该决定下次启动的层级。
恢复路径任何字段坏掉都不抛异常，而是降级。

## 18. Display Change / reflow / 最小尺寸（§23 / §24 / §25）

显示器变化、分辨率变化、**宿主窗口尺寸变化**走**同一条** `system/reflow`、
同一个 `geometry.clampAll`。每窗口有 `minimum width/height`。
`reflow` 加"无变化返回原状态"避免持续事件空转。

## 19. Drag / Resize 与指针捕获（§26 / §27）

`setPointerCapture` 在本机 Chromium **不可靠**（调用成功、
`hasPointerCapture()` 返回 true，但 `gotpointercapture` 从不触发）→
监听器改挂 `window`，正确性不依赖捕获。
状态推进**严禁**依赖 `transitionend` / `animationend`（§27）。

## 20. Reduce Motion 三路径（§28）

`motion-parity` **22/22**。非空验证：三条路径确实是三种渲染配置 ——
normal `transition-duration 0.16s`、产品内开关 `.reduced` `0s`、
系统媒体查询 `0s`（且**不带类名**）。三边功能状态逐项相同。

## 21. styles.css 迁移与颜色范围（§29 / §30）

迁移到设计系统 token：**迁 14 处、保留 4 处并逐条注明理由**，视觉零变化。
颜色迁移只限本轮触碰到的组件（§30）。回归：`test:design-system`
4 PASS / 1 PARTIAL / 0 FAIL，`test:theme-baseline` 全过。

## 22. ContextMenu / Dock / TopBar 接线（§31 / §32 / §33 / §34）

- ContextMenu 是真组件：方向键 / Home / End / Enter / Esc / 焦点管理 / disabled / separator
- Dock 消费 `appId → windowIds[]`，按 **聚焦 / 恢复 / 新建** 三分支
- TopBar / TrafficBar 操作 `focusedWindowId`，无 focused 时 disabled
- WebViewport 只是 DOM placeholder，**不持有任何 Electron 对象**

## 23. 架构边界与安全边界（§35 / §36 / §37 / §38）

- 依赖单向：`native-view-controller.cjs` 不拥有 Window domain 业务规则，只吃 intent
- 渲染进程拿不到危险对象：桥接面恰 5 个成员，无 IPC / Node / Electron 原语
- **A13 安全回归 15/15**：不可信视图内 `window.openarc === undefined`、
  无任何 Node 全局；伪 URL（`javascript:` / `file://` / 含凭据 / `data:`）全被拒；
  超量意图（>32）被拒；合法调用仍成功
- 暴露面**成员数未扩大（5 → 5）**，但 `layout→sync`、`onBrowser→onNativeState`
  是更名，`navigate/action` 增加 `windowId` 是多视图必需 —— 逐条断言，不含糊说"没变"
- D1-05 全量安全探针复跑：**FAIL 0**（6 PASS / 3 PARTIAL），与基线结构一致

## 24. D2-01 缺口关闭（§40 / §41）

| D2-01 §22 缺口 | 现在 |
|----------------|------|
| 12 个组件只有视觉契约，尚未组件化 | **CLOSED BY D2-02**（真组件化 + 产品自身消费） |
| 对话框焦点陷阱 + 焦点返回 NOT VERIFIED | **CLOSED BY D2-02**（Dialog.tsx + 33/33） |
| Windows 视觉保真度 NOT VERIFIED | 仍未关闭 |
| `styles.css` 迁移欠账 | 部分关闭（仅限本轮触碰到的组件） |

D2-01 的记录只做**追加标注**（新增 §23），不改写其 §22 的原始 PARTIAL 判定。

## 25. 本轮审出并修掉的真实产品缺陷（9 条）

1. **焦点吃掉 click** —— 层级泄漏成数组顺序，点后台窗口的红绿灯按钮要点两次
2. **`mode` 字段错位** —— 控制器读 `plan.strategy`，遮挡三件事同时静默失效
3. **快照取图顺序错** —— 先隐藏再取图，快照恒为 `null`
4. **快照坐标错** —— `capturePage` 的 rect 是页面坐标，先收缩后取图取到空图
5. **`UnknownVizError` 无重试** —— 瞬时合成器错误导致永久留白
6. **`window/unmaximize` 不可达** —— 最大化后无法还原
7. **宿主缩小不 reflow** —— 窗口落到工作区外，抓不到也关不掉
8. **Dock 未消费 `appId → windowIds[]`** —— 窗口 id ≠ appId 时多开窗口
9. **`setPointerCapture` 不可靠** —— 指针一离开元素窗口就不跟手

另外修掉一个**探针自身的**缺陷：Gate 汇总会读到上一轮的陈旧产物，
探针崩溃时仍显示旧数字（实测：未带必需参数时 00–06 全部崩溃，汇总却显示
14/14、42/42）。现在跑之前先删产物，没有产物就显式显示"未产出结论"。

## 26. 验证矩阵与复现

```bash
npm test                       # 纯逻辑单测 75/75
npm run test:d2-02             # D2-02A Gate + 6 个产品侧探针（总入口）
npm run test:security          # D1-05 全量安全探针 FAIL 0（永久回归基线）
npm run test:design-system     # D2-01 设计系统 4 PASS / 1 PARTIAL / 0 FAIL
npm run test:theme-baseline    # D1-04 主题矩阵 全过
```

| 探针 | 断言 | 打的是什么 |
|------|------|-----------|
| Gate（7 组） | 116/116 | Electron API 能力边界（复跑复现） |
| `security-surface` | 15/15 | 真实主进程 + preload + WebContentsView |
| `dialog-a11y` | 33/33 | 产品页里的 Dialog 原语 |
| `motion-parity` | 22/22 | 产品页 × 三路径 |
| `window-stress` | 26/26 | 产品页 vs 真实 Window Manager 逐步差分 |
| `two-browser` | 37/37 | 模块契约 + 产品页双浏览器 |
| `native-view-lifecycle` | 46/46 | 真实 `native-view-controller.cjs` |

**7/7 探针 PASS；179 条产品侧断言 + 75 条纯逻辑单测。**

## 27. 未验证 / BLOCKED

| 项 | 状态 |
|----|------|
| Windows（mica / 打包 / 窗口行为 / 多显示器） | **NOT VERIFIED**（无真机，不得外推） |
| 真实多显示器 / 热插拔 | **NOT VERIFIED** |
| GPU 合成性能、快照性能与内存 | **NOT VERIFIED**（未做量化测量） |
| UI 端到端流程 | **BLOCKED**（Playwright 1.55 与 Electron 44 CDP 握手失败） |
| 运行时沙箱强制执行 | **NOT VERIFIED**（本机沙箱无法初始化） |
| 屏幕合成取证（拍照比色）的稳定性 | **NOT VERIFIED**（4 次里 2 次拍到屏幕上的其它内容） |

**未实测项目一律写 NOT VERIFIED，不用 macOS 结论外推到双平台。**

## 28. 停止声明与下一步

D2-02 到此**停止**。未进入 D2-03 / D3 / D4 / D5。

`feature/d2-02-window-system` 已推送，**未 merge main**。

下一阶段的入口条件（不由本轮决定）：
Windows 真机验证、真实多显示器、性能量化、UI E2E 通道打通
（或明确接受这三项长期作为 CONDITIONAL GO 的条件）。
