# D2-02 窗口系统与原生视图架构：技术决策记录

日期：2026-09-10
范围：**D2-02A · Window Architecture Gate**。本文件只回答"窗口与原生视图该怎么搭"，
不含 D2-02B 的实现记录（组件库、命令层、Dialog primitive、持久化迁移等另见后续章节）。
未触碰 Harness、AI、MCP、Adobe、Skill、用户/团队、数据库、插件市场、画布。

状态分级：PASS / FAIL / NOT VERIFIED / BLOCKED / ARCHITECTURE DECISION REQUIRED。
凡未实机取得证据的一律不写通过。

---

## 1. 为什么必须有这个 Gate

D2-02 原本可以这样开工：把现有 `src/main.tsx` 里的 `wins: Win[]` 抽成 `Window` 组件，
加一层 `WindowManager`，然后把组件库、命令层、Dialog 依次补上。**这条路径被明确否决。**

理由是 D1-01 留下的一条硬事实：`WebContentsView` 恒定绘制在 DOM 之上，DOM 的 `z-index`
对它无效（D1-01 Browser View Findings，状态：ARCHITECTURE DECISION REQUIRED）。
这意味着"窗口系统"的拓扑不是纯前端问题 —— 它同时决定原生层的可见性、焦点与几何。

若先把一个未经确认的拓扑封装成 React 组件，之后每改一次拓扑都要穿透组件契约重写，
而组件契约又已经在测试与文档里被冻结。**先 Gate，后实现。**

Gate 的产出是本 ADR 的 §7 决策；决策之前的所有章节都是它的证据链。

---

## 2. 环境与仪器

### 2.1 运行环境

| 项 | 实测值 |
| --- | --- |
| OS | macOS 26.6.2（Build 25G83） |
| CPU / 架构 | Apple M3 Pro / arm64 |
| 显示器 | 1 × 内置 Liquid Retina XDR，3456×2234，scaleFactor = 2 |
| `display.bounds` | `{ x:0, y:0, width:1728, height:1117 }`（DIP） |
| `display.workArea` | `{ x:0, y:33, width:1728, height:990 }`（DIP） |
| Electron | 44.3.0 |
| Chromium | 152.0.7977.78 |
| Electron 内置 Node | 24.20.0 |
| 探针窗口 | `1100×760` DIP，`contentBounds = { x:40, y:72 }` |
| 启动开关 | `--no-sandbox --disable-gpu-sandbox --in-process-gpu` |

**只有一块物理显示器。** 真实拔插屏幕、双屏 DPI 迁移一律 NOT VERIFIED（见 §24）。

### 2.2 `ELECTRON_RUN_AS_NODE` —— 本机执行环境的陷阱（重要）

Gate 探针最初全线崩溃在 `app.whenReady`，症状极具误导性：
`process.type === undefined`，且 `require("electron")` 返回的是
**npm 包里的二进制路径字符串**（98 字符），不是 API 对象。

排查顺序与结论：

1. `env | grep -i electron` 为空 —— 看似没有污染。
2. 检查 `Info.plist` 的 `LSEnvironment` —— 只有 `MallocNanoZone=0`，排除。
3. `export -p | grep ELECTRON_RUN_AS_NODE` → **`export ELECTRON_RUN_AS_NODE=1`**。
4. `ELECTRON_RUN_AS_NODE= node tests/native-view.mjs` → 既有的 26/26 立刻恢复。

**结论**：本机执行环境把 `ELECTRON_RUN_AS_NODE=1` 导出给了子进程。这是**执行环境产物，
不是项目缺陷** —— 它同时也是既有 `tests/native-view.mjs` 那段时间"回归"的真正原因。

处理方式不是绕过，而是**写进 runner 契约**：`experiments/d2-02-gate/lib/gate.mjs` 的
`cleanEnv()` 显式 `delete env.ELECTRON_RUN_AS_NODE`（连带 `ELECTRON_NO_ATTACH_CONSOLE`），
并用 `hadRunAsNode()` 把"进来时是否被污染"记录进报告，避免以后有人把环境问题读成产品问题。

### 2.3 Electron 必须"以目录启动"

另一个同症状陷阱：把 `.cjs` 文件路径直接作为参数传给 Electron
（`electron probes/00-instrument.cjs`）会让 Electron **退化成 Node 模式**，`require("electron")`
同样返回路径字符串。只有 `electron <dir>`（目录内含 `package.json` 且 `main` 指向入口）
才进入 app 模式。

因此探针套件采用 `native/package.json` + `native/main.cjs` 宿主结构，
探针由 `GATE_PROBE` 环境变量按名装载。这条约束写进了 `main.cjs` 文件头。

---

## 3. 测量方法：为什么不能用 `capturePage`

### 3.1 `capturePage()` 不包含子视图（颠覆性结论）

第一轮仪器校验 4/8 失败，根因是：**`webContents.capturePage()` 只包含渲染进程自己的图层，
不包含 `WebContentsView` 子视图。** 视图可见与隐藏时，同一坐标返回**完全相同的像素**
（`inst.capturePageExcludesChildViews`：可见 `rgb(255,0,0)` / 隐藏 `rgb(255,0,0)`）。

后果：任何用 `capturePage` 做的层级、遮挡、圆角断言都是恒真断言 —— 它测的是同一个图层，
永远"通过"。这条局限本身被写成断言保留，防止后来者重犯。

**层级真值只能来自 `screencapture` 的真实合成帧。**

### 3.2 Retina 与坐标换算

`capturePage(rect)` 的 rect 单位是 DIP，但返回的 `NativeImage.getSize()` 是**物理像素**
（请求 1100×760 DIP → 得到 2200×1520 px）。把 DIP 当像素下标采样会静默采到左上角 1/4 区域，
断言全错却不报错。`grab()` 因此由 `位图宽 / 请求矩形宽` 反推 scale 并断言为整数
（`inst.screenScaleIsRetina2`：2200/1100 = 2）。

`screencapture -x -R` 的 `-R` 用**屏幕 DIP 坐标**，输出同样是 Retina 物理像素。

### 3.3 色彩空间必须做 ICC 转换

macOS 广色域屏把合成帧写成 **Display P3**。sRGB 纯色在 P3 里会被读成完全不同的值：

| 期望（sRGB） | 原生读取 | ICC→sRGB 后 |
| --- | --- | --- |
| `#00ff00` | `rgb(117,251,76)` | `rgb(3,255,0)` |
| `#0000ff` | `rgb(0,0,245)` | `rgb(0,0,255)` |

不做转换的话，颜色断言只能放到 ±130 容差 —— 那等于断言失效（`#00ff00` 与 `#00aa00` 无法区分）。
`_pixels.py` 用 PIL + `ImageCms.profileToProfile(im, src, sRGB)` 完成转换，
并同时输出 `rgb`（转换后）与 `raw`（原生）两个值供核对（`inst.screenColorManaged`）。

### 3.4 输入注入（无授权依赖）

| 手段 | 实现 | 实测 |
| --- | --- | --- |
| 指针定位 | `Quartz.CGWarpMouseCursorPosition` | 漂移 **0.0 px**（`inst.cursorWarpIsAvailable`） |
| 鼠标点击 | `/opt/homebrew/bin/cliclick` | shell 命中 0→3（`inst.osClickInjectionViable`） |
| 键盘按键 | `CGEventCreateKeyboardEvent` + `kCGHIDEventTap` | 可注入 |
| 组合键 | `CGEventSetFlags`（shift = `1<<17`） | 可注入 Shift+Tab |

**关键环境事实**：macOS 只把键盘事件投递给 **key window 内部的 focused webContents**。
窗口未成为 key 时"按键没人收到"是环境现象，不是"键盘进错了对象"。
Gate 的处理是把"窗口是否 key"拆成**独立的环境前置断言**（`inst.focusPreconditionWindowIsKey`、
`input.preconditionWindowIsKey`），其余键盘类断言全部带 `!keyWindow ||` 门控，
并在消息里标注该轮窗口是否 key。**不把环境干扰读成产品缺陷。**

### 3.5 采样点必须避开居中文字

多次假失败的共同根因：探针页面把标签文字居中渲染，而采样点恰好落在文字上 ——
`rgb(3,255,255)` 被读成 `rgb(254,255,255)`、`rgb(128,128,128)` 被读成 `rgb(237,255,233)`。

处理：`pt()` 一律取矩形**左上角内侧 16px**；网格用 `[0.12, 0.34, 0.88] × [0.12, 0.38, 0.88]`
避开正中；场景里**不放任何装饰元素**。

---

## 4. Current Architecture Map

审计沿真实调用链进行（`electron/main.cjs`、`electron/preload.cjs`、`electron/geometry.cjs`、
`electron/policy.cjs`、`src/main.tsx`），不依据文件名或目录结构推断。

### 4.1 五层拓扑

```
[Electron BrowserWindow]                 主进程，全局唯一（let win）
  └─ contentView
       ├─ Renderer Desktop               React，dist/index.html，contextIsolation + sandbox
       │    ├─ TopBar / TrafficBar / Dock / AssistantPill
       │    ├─ DOM Windows               wins[] → <section class="window" style="zIndex: 10+i">
       │    ├─ Overlays                 ContextMenu / Search / AI Panel / Folder rename
       │    └─ #viewport                浏览器窗口内的几何锚点（DOM placeholder）
       └─ WebContentsView                单例（let view），分区 openarc-browser-d1
            └─ 可见性与 bounds 由 renderer 经 IPC 单向驱动
```

原生层只有**两个**节点：一个外壳 `BrowserWindow` 与一个 `WebContentsView`。
OpenArc 的"窗口"目前**不是**原生窗口，而是外壳内的 DOM 元素。

### 4.2 六问

| # | 问题 | 现状答案 | 证据 |
| --- | --- | --- | --- |
| 1 | **谁创建窗口** | 渲染进程。`setWins(ws => [...ws, {...}])`（`open()` / `openFolder()`）。主进程只创建一个原生 `BrowserWindow`，从未创建第二个 | `src/main.tsx` L208–226、L162–181 |
| 2 | **谁持有 geometry** | 渲染进程。`wins[].x/y/w/h`（DIP，相对窗口内容区）。工作区由 `workArea()` 现算：`innerWidth/innerHeight` + 硬编码 `AREA_TOP = 44` / `AREA_BOTTOM = 114`。原生侧只有纯函数 `geometry.cjs`（clamp/isVisible/occluded）与 `policy.cjs safeBounds` | `src/main.tsx` L51–58、L362–397；`electron/geometry.cjs` |
| 3 | **谁持有 focus** | **没有人持有。** 焦点是数组顺序的隐式结果：`const active = wins.filter(w => !w.min).at(-1)?.id`。`focus(id)` 的实现是"把该元素移到数组末尾"。没有 `focused` 字段 | `src/main.tsx` L138、L149–153 |
| 4 | **谁决定 z-order** | DOM 文档顺序 + `zIndex: 10 + i`（`i` 为数组下标）。层级规则与窗口语义同源，无法独立表达 | `src/main.tsx` L801–812 |
| 5 | **谁决定 WebContentsView visible** | 渲染进程。`useLayoutEffect` 内 `blocked = ai \|\| search \|\| !!menu \|\| geometry.occluded(target, above)` —— **单个 boolean** —— 经 `browser:layout` IPC 落到 `view.setVisible()` | `src/main.tsx` L332–361；`electron/main.cjs` L145–154 |
| 6 | **谁持久化 bounds** | 渲染进程。`useEffect` → `localStorage["oa-wins"]`；恢复时 `restoreWins()` 先 `geometry.clampAll` 再渲染。显示器变化另由主进程 `screen` 事件 → `display:changed` → `clampAll` | `src/main.tsx` L240–250、L67–81 |

### 4.3 现状的本质

三条结论：

1. **状态权威在渲染进程，而且只有一份** —— 这一点是好的，不需要重建。
   但它同时承担了 domain state、geometry、z-order、focus、原生可见性五种职责，
   且后四种是**隐式的**（顺序/下标/布尔），没有可被 AI 或测试直接寻址的对象。
2. **原生层是"一个视图"而非"一套窗口系统"** —— `let win, view` 两个全局变量，
   无法表达"两个浏览器窗口"，也无法表达"某窗口局部被遮挡"。
3. **渲染进程直接决定原生可见性** —— `blocked` 是唯一通道，且是二值。
   二值是 D1-01 遗留的所有观感问题的根源（见 §8）。

---

## 5. 现状必须由架构解决的问题

从上节审计 + D1-01 遗留，Gate 必须回答六个问题：

| # | 问题 | 若不解决的产品后果 |
| --- | --- | --- |
| Q1 | DOM 覆盖层（Dialog / ContextMenu / Search / AI）能否**盖住**网页并阻断其输入？ | §17 硬验收失败；用户在对话框上点击会点到网页 |
| Q2 | 能否同时存在**两个真实浏览器窗口**？ | §12 硬验收失败；"浏览器"只能是单例 |
| Q3 | 部分遮挡能否表达？ | 一个窄窗口压过网页时，网页要么全露要么全没 —— 观感崩坏 |
| Q4 | 圆角处会不会漏出网页？ | 网页从窗口圆角外溢，直接违反 DESIGN_SYSTEM 的圆角契约 |
| Q5 | 关闭窗口后原生资源是否真正释放？ | DOM 关了但 WebContentsView 还活着 → 内存/进程泄漏 |
| Q6 | 未来 AI 能否在**不碰 React state** 的前提下操作窗口？ | §21 失败；AI 会开出一条绕过命令层的捷径 |

---

## 6. 候选架构

五个候选，定义**先于**实测，避免倒推：

- **候选 A · DOM Window + 按遮挡区域 hide/show**
  保持"窗口即 DOM"拓扑。原生视图只有"可见/隐藏"两个状态，由遮挡判定驱动。
- **候选 B · DOM Window + 动态 setBounds/geometry coordination**
  窗口仍是 DOM。原生视图仍只有一个，但允许**改变矩形**（收缩到未遮挡区）而非仅开关。
- **候选 C · 一个窗口对应独立 WebContentsView**
  每个浏览器类窗口一个 `WebContentsView`，各自独立生命周期、分区与 bounds。
- **候选 D · 需要原生内容的 App 用独立 child / native window**
  浏览器窗口是一个真实原生窗口（`BrowserWindow` child 或独立窗口），由 OS 负责裁剪与层级。
- **候选 E · 混合**
  以 A/B 为主体，按窗口类型选择 C/D，并为无法用矩形表达的情形引入**快照补齐**。

**禁止预设**：本文件所有结论都来自 §8–§13 的实测，不来自先验偏好。

---

## 7. Architecture Matrix

24 个维度 × 5 候选。每格为 Gate 实测结论（证据见 §8–§13 与 §26）。

| # | 维度 | A（hide/show） | B（setBounds） | C（一窗口一视图） | D（原生窗口） | E（混合） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | DOM 覆盖层可盖住网页 | ❌ 需靠隐藏视图代偿 | ❌ 同 A | ❌ 同 A | ❌ **父窗口无法抬到 child 之上** | ✅ 隐藏整块让位 |
| 2 | 阻断网页鼠标输入 | ⚠️ 仅整块 | ⚠️ 仅整块 | ⚠️ 仅整块 | ❌ 永远不阻断 | ✅ 整块让位后测试全绿 |
| 3 | 阻断网页键盘输入 | ⚠️ 需显式移交焦点 | ⚠️ 同 A | ⚠️ 同 A | ❌ 同 2 | ✅ |
| 4 | 部分遮挡表达力 | ❌ 丢 50% 未遮挡区 | ⚠️ 单矩形仅保 40% | ❌ 同 B | ✅ OS 精确裁剪 | ✅ 收缩 + 快照补齐 |
| 5 | 圆角正确性 | ❌ 圆角处漏网页 | ❌ 同 A | ❌ 同 A | ✅ 窗口形状承担 | ✅ `setBorderRadius` + 形状双重 |
| 6 | 鼠标路由与视觉一致 | ⚠️ 一致但区域粗 | ⚠️ 一致 | ⚠️ 一致 | ❌ 圆角切区仍收点击 | ✅ 快照区 `pointer-events:none` |
| 7 | 键盘路由与视觉一致 | ⚠️ 隐藏后焦点落空 | ⚠️ 同 A | ⚠️ 同 A | ⚠️ 独立 key 语义 | ✅ 显式移交 |
| 8 | 多浏览器窗口独立 | ❌ 单视图 | ❌ 单视图 | ✅ | ✅ | ✅ |
| 9 | 会话/分区模型 | ⚠️ 单分区 | ⚠️ 单分区 | ✅ 按 app 共享 | ✅ | ✅ |
| 10 | 焦点唯一性 | ✅ 可保证 | ✅ | ⚠️ 多视图需调度 | ⚠️ OS 层游离 | ✅ 探针实测恒 1 个持有者 |
| 11 | z-order 可表达 | ❌ 二值 | ❌ 二值 | ❌ 二值 | ⚠️ OS 决定 | ✅ plan 可寻址 |
| 12 | 拖动/缩放时无抖动 | ⚠️ 每帧改可见性 | ⚠️ 同步延迟 | ⚠️ 同 B | ✅ | ⚠️ 快照需失效策略 |
| 13 | 状态权威唯一 | ✅ | ✅ | ⚠️ 每个视图一份 | ⚠️ 双权威风险高 | ✅ plan() 纯函数 |
| 14 | 关闭后真正释放 | ⚠️ 未验证前 | ⚠️ | ✅ 实测 3→2 | ✅ OS 窗口 2→1 | ✅ |
| 15 | 最小化/恢复语义 | ✅ | ✅ | ✅ | ⚠️ 需映射 | ✅ |
| 16 | 与 Dock/Focus 的耦合 | ⚠️ 隐式顺序 | ⚠️ 同 | ⚠️ | ❌ 需重做 | ✅ 命令层解耦 |
| 17 | 持久化 `oa-wins` 兼容 | ✅ | ✅ | ⚠️ 需扩展 | ❌ 两套 bounds | ✅ 沿用单一权威 |
| 18 | 多显示器/DPI 迁移 | ✅ | ✅ | ✅ | ⚠️ 每个窗口独立 | ✅ 复用 `geometry.cjs` |
| 19 | 不污染 Mission Control | ✅ | ✅ | ✅ | ❌ **进入系统窗口列表** | ✅ |
| 20 | 滚动/输入法连续性 | ✅ 单视图 | ✅ | ❌ 同 URL 两视图状态分叉 | ✅ | ⚠️ 已知代价 |
| 21 | 视觉时效性 | ✅ | ✅ | ✅ | ✅ | ⚠️ 快照会过期 |
| 22 | 渲染/内存成本 | ✅ 最低 | ✅ | ⚠️ 线性增长 | ⚠️ 多进程 | ⚠️ 快照有成本 |
| 23 | 平台可移植性（Windows） | ⚠️ NOT VERIFIED | ⚠️ NOT VERIFIED | ⚠️ NOT VERIFIED | ⚠️ NOT VERIFIED | ⚠️ NOT VERIFIED |
| 24 | 可回归测试性 | ✅ | ✅ | ✅ | ✅ | ✅ 已全绿 |

### 7.1 决策

> **CHOOSE HYBRID（候选 E）**
>
> 以 **DOM Window 为主体**（保留现有状态权威与持久化），
> 原生层升级为**多 `WebContentsView`**（每个浏览器类窗口一个，各自分区与生命周期），
> 可见性不再由单个 boolean 决定，而由 `electron/occlusion.cjs` 的 `plan()`
> 产出四态策略：**`live` / `clip+snapshot` / `snapshot` / `hidden`**。
> 不采用原生 child / 独立窗口（候选 D）。

§8–§13 是这条决策的证据链。

---

## 8. 候选 A 的实测边界（仅 hide/show）

### 8.1 全遮挡：A 成立但必须显式移交焦点

`01-occlusion` 全遮挡组：

- `occl.full.pagePaintsOverDomWindow` —— 不缓解时网页盖住 DOM 窗口，采样点全为 `rgb(0,0,255)`。
- `occl.full.hideMitigationRevealsDom` —— `setVisible(false)` 后同一区域露出 DOM。
- `occl.full.clickInOverlapGoesToPage` —— 不缓解时重叠区点击 **DOM 0 次 / 网页 3 次**
  （`pointerdown`/`mousedown`/`click`）。**这就是 §17 失败的具体形态。**

结论：全遮挡用 hide 可以解决**视觉**，但**焦点不会自动交还外壳**
（`inst.hideDoesNotTransferFocus`：`setVisible(false)` 后 `view=false / win=false`，
即焦点直接落空）。架构必须显式 `webContents.focus()`。

### 8.2 部分遮挡：A 不成立

`01-occlusion` 左移部分遮挡组（`partialLeft`）：

| 量 | 值 |
| --- | --- |
| 视口 | `{ x:288, y:368, w:524, h:324 }`（169,776 DIP²） |
| 遮挡窗口 | `{ x:200, y:368, w:350, h:324 }` |
| 重叠宽 / 未遮挡宽 | 262 / 262 |
| 未遮挡面积 | 84,888 DIP² |

- `occl.partial.hideLosesUnobstructedArea` —— 整块隐藏后 `lostDipArea = 84,888`，
  **`lostRatio = 0.5`**：为了挡住一个半透明压过来的窗口，**把一半本应可见的网页一起丢了**，
  露出的是外壳灰 `rgb(128,128,128)`。

这就是候选 A 的判决性缺陷：**它是一个二值决策，而部分遮挡是一个连续问题。**

### 8.3 A 的结论

- 可用于"整块覆盖"场景（Dialog / Search / AI 面板 —— 这些本来就该整块让位）。
- **不足以作为一般窗口遮挡的方案**。
- 焦点必须由架构显式移交，不能指望 hide 的副作用。

---

## 9. 候选 B 的实测边界（收缩到未遮挡矩形）

`partialLeft` 的 `rectShrink` 组：把视图矩形从整视口收缩到右侧未遮挡区
`{ x:550, y:368, w:262, h:324 }`。

- `occl.partial.rectShrinkRevealsDomInOverlap` —— 重叠区 `rgb(255,255,5)`（DOM 窗口 B 的黄）
  正确露出，未遮挡区 `rgb(0,0,255)` 仍是网页。
- 点击验证（`partialLeft.clicks`）：未遮挡区 **DOM 0 / 网页 3**（正确）；
  重叠区 **DOM 3（target `wB`）/ 网页 0**（正确）。
  **视觉与鼠标路由一致** —— 这是候选 B 相对 A 的实质进步。

但中心挖洞情形揭穿了它的天花板（`partialCenter`）：

| 量 | 值 |
| --- | --- |
| 视口面积 | 129,776 DIP² |
| 遮挡窗口 | `{ x:450, y:430, w:200, h:200 }`（挖在正中） |
| 四条空闲矩形面积 | top 32,488 / bottom 32,488 / left 52,488 / right 52,488 |
| 最大单矩形可保住 | **52,488**（占名义可见量的 **40.4%**） |

- `occl.partialCenter.singleRectCannotRepresent` —— 最大单矩形只能保住 40%，
  另外三条带（含 60%）在 "只留最大矩形" 策略下全部变成外壳灰。
- 而且四块空闲带**互不相连**，一个矩形在拓扑上就不可能同时表达它们。

### 9.1 B 的结论

候选 B 把"二值"升级为"单矩形"，可处理**窗口贴边**这类常见情形，
但**无法表达一般性的部分遮挡**（挖洞、多块、交叉）。
需要一个能把"多个不相连区域"表达出来的机制 —— 这正是 §12 引入快照的动机。

---

## 10. 候选 C 的实测边界（一窗口一 WebContentsView）

`03-multiview` 10/10：

- `multi.twoViewsCoexist` / `viewsAreDistinctWebContents` —— 两个视图并存，webContents id 不同。
- `multi.hideOneDoesNotAffectOther` / `reloadOneDoesNotAffectOther` —— 生命周期互不干扰。
- `multi.destroyOneLeavesOtherAlive` / `destroyReleasesWebContents` —— 销毁一个后
  **webContents 数量 3 → 2**，确实释放，不是留着空壳。
- `multi.allViewsDestroyedReleasesResources` —— 全部销毁后回到初始计数，
  屏幕上视口区回到桌面底色。**没有"DOM 关了但 WebContentsView 还活着"。**
- `multi.viewZOrderIsControllable` —— 两个视图重叠于同一矩形时，默认上层是后加入者；
  `removeChildView` + `addChildView(view, index)` 重排后可改变上下关系。
  **`addChildView` 支持索引** → 原生视图之间的 z 序由挂载顺序决定且可改。
- `multi.sessionIsolationContract` —— 外壳会话 ≠ 网页会话；同分区的两个视图共享会话，
  不同分区隔离。**§13 冻结预期成立**（见 §16）。

**必须记录的代价**：`multi.sameUrlViewsAreIndependentDocuments` ——
同一 URL 的两个视图，把 T1 滚到 900 后 T2 仍停在 0。它们**不是"同一个页面的两块"**，
用多视图拼一片网页会让滚动/表单/播放状态分叉。这条限制了 C 的使用方式：
多视图用于"多个独立窗口"，**不能**用于"把一个窗口切碎"。

---

## 11. 候选 D 的实测边界（原生 child / 独立窗口）

`04-childwindow` 8/8。候选 D **收益真实存在**：

- `child.partialOverlapClippedByOs` —— DOM 窗口与 child 部分重叠时，
  两个原生窗口之间的遮挡**由 OS 精确裁剪**。这是单矩形原生视图做不到的。
- `child.roundedCornersApplied` —— 圆角由窗口形状承担，原生窗口支持真实圆角。
- `child.createdAsNativeWindow` / `appearsInSystemWindowList` —— child 是**真实 OS 窗口**。

**但它的三项代价是决定性的：**

1. `child.shellDomCannotCoverChild` —— 把 DOM 窗口放大到完全覆盖 child 区域后，
   child 内仍是自己的页面色。**外壳里的 DOM 覆盖层盖不住原生 child 窗口。**
2. `child.shellCannotBeRaisedAboveChild` —— 外壳 `setAlwaysOnTop(true, "floating")` + `moveTop`
   之后 child 内仍是自己的页面色，且 `win.isAlwaysOnTop() === true` **已生效但仍然无效**。
   **父窗口无法被抬到自己的 child 窗口之上。**
   → 候选 D 下，外壳里的右键菜单 / 对话框 / 搜索 / AI 面板**永远盖不住浏览器窗口**，
   而 §17 是硬验收。**这一条单独就否决了候选 D。**
3. `child.appearsInSystemWindowList` —— OS 窗口数 1 → 2，会进入 **Mission Control 与窗口切换**。
   一个"应用内的浏览器窗口"变成系统级窗口，是明确的产品可见后果。

`child.destroyRemovesSystemWindow` 说明销毁可控（2 → 1），但这不改变前三条。

### 11.1 D 的结论

**否决。** 它换来了 OS 级裁剪与圆角，代价是架构上永远无法满足 §17，
并污染系统窗口管理。收益不足以抵消。

---

## 12. 快照补齐：把"连续遮挡"折成"矩形 + 位图"

`05-snapshot` 7/7。第三种缓解：把 `view.webContents.capturePage()` 的结果作为 DOM 图片
贴回视口（`pointer-events:none`），原生视图只保留最大空闲矩形或整块隐藏。

| 策略 | 四条空闲带是否都呈现网页 | 代价 |
| --- | --- | --- |
| 不缓解 | 全部是网页（`rgb(0,0,255)`×5） | DOM 窗口完全不可见 |
| 只收缩到最大矩形 | 仅 1/4 带保留，其余变 `rgb(128,128,128)` | 观感仍坏 |
| **收缩 + 快照补齐** | **4/4 全部呈现网页**，且 B 自身 `rgb(255,255,5)` 正常 | 快照区不可交互、会过期 |
| 整块隐藏 | 0/4 | 代价最大 |

关键断言：

- `snap.clipPlusSnapshotCompositeCorrect` —— 收缩 + 快照后合成结果与"窗口压住网页"一致。
- `snap.snapshotAreaIsNotInteractiveWithPage` —— 快照区点击 **DOM 3（`viewport`）/ 网页 0**。
  快照是静态图，代价明确：**被快照覆盖的区域不能与网页交互。**
- `snap.domWindowStillInteractiveOverSnapshot` —— 重叠区点击 **DOM 3（`wB`）/ 网页 0**，
  DOM 窗口在快照之上仍然可交互。
- `snap.staleSnapshotDetectable` —— 页面底色改为 `rgb(0,170,0)` 后，
  活动矩形内 `rgb(1,171,1)` 已更新，快照区仍是旧色 `rgb(0,0,255)`。
  **快照会过期，必须有失效策略。**

### 12.1 快照的定位

快照不是"更好的方案"，而是**把不可表达的东西降级为可表达的东西**：
把"任意形状的可见区域"换成"矩形 + 位图"。它的代价（不可交互、会过期）
必须由架构**显式承担**，不能假装不存在：

- 快照区必须 `pointer-events: none`，让点击穿透到正确目标；
- 必须有失效键（内容/几何变化即重取），见 §14.3。

---

## 13. 圆角问题的三种处置

`01-occlusion` 圆角组。原生视图是**方角矩形**，而窗口有圆角：

- `occl.corner.domBorderRadiusClipsOwnContent` —— DOM 的 `border-radius` 会裁掉自己的内容，
  但**不裁原生视图**。
- `occl.corner.nativeViewLeaksThroughRoundedWindow` —— 窗口底角采样 `rgb(0,0,255)`（网页），
  **网页从圆角处外溢**。
- `occl.corner.nativeWindowShapeClipsNativeView` —— 但 **macOS 原生窗口自身的圆角会裁剪它**
  （`bottomCornersClippedByWindowShape: true`，底角采到 `rgb(169,169,169)` / `rgb(178,178,178)`），
  而顶部因为标题栏区域不是窗口圆角，仍漏 `rgb(0,0,255)`。
- `occl.corner.setBorderRadiusAvailable` + `borderRadiusFixesNativeCorner` ——
  Electron 44 提供 `View.setBorderRadius(radius)`，应用后圆角处
  `windowBottomLeft/Right` 从 `rgb(0,0,255)` 变为 `rgb(3,255,0)`，**漏色修好**。
- `occl.corner.cutoutStillCapturesClick` —— 但文档注明"被圆角切掉的区域仍然接收点击"，**实测成立**：
  在 `{ x:292, y:372 }`（视觉上已是外壳）点击得到 **DOM 0 / 网页 3**。

### 13.1 结论

圆角必须**双层处置**：

1. 视觉层：`setBorderRadius` + 窗口自身形状共同裁剪。
2. 交互层：**被圆角切掉的区域仍然收点击，必须由上层显式屏蔽**
   （在窗口圆角处放一个 `pointer-events: auto` 的 DOM 覆盖块，把点击截在外壳里）。

只做第 1 层会得到"看起来对、点起来错"的结果 —— 这正是本项目最忌讳的验收形态。

---

## 14. Occlusion Model

§10 明确要求：**不能只用一个 boolean。** 冻结为三态 + 一条策略函数。

### 14.1 三态

| 状态 | 判据 |
| --- | --- |
| `visible` | 空闲区域覆盖率 ≥ `FULL_RATIO`（0.999） |
| `fullyOccluded` | 空闲面积 ≈ 0 |
| `partiallyOccluded` | 介于两者之间 |

实现为 `electron/occlusion.cjs`（**纯函数，无 Electron / DOM 依赖**）：

```
freeRects(viewport, occluders)  // 视口减所有遮挡，返回互不重叠的矩形集合
classify(freeArea, viewportArea) // → visible | fullyOccluded | partiallyOccluded
plan({ viewport, occluders, minimized, overlayOpen, interactive })
```

### 14.2 四态处置

`plan()` 的输出：

| 输出 | 触发条件 | 语义 |
| --- | --- | --- |
| `hidden` | `minimized` / 空视口 / **`overlayOpen`** | 整块让位 |
| `live` | `visible` | 原生视图全量实时 |
| `clip+snapshot` | `partiallyOccluded` 且 `interactive` 且最大空闲矩形占比 ≥ 阈值 | 矩形保实时，其余用快照 |
| `snapshot` | 其余部分遮挡（含占比低于阈值） | 整块改快照 |

**系统级覆盖层（Dialog / Search / AI 面板）一律整块 `hidden`**，
不走 `clip+snapshot` —— 因为它们本该完全遮住网页，且必须阻断输入。

### 14.3 `CLIP_MIN_RATIO = 0.35` 的取值理由

不是拍的，来自两条实测：

- `partialCenter`：最大空闲矩形占名义可见量 **40.4%** → 收缩仍有意义，应走 `clip+snapshot`。
- `06-stress` 第 9 步（拖窗口 C 穿过 A）：最大空闲矩形占比 **27%** → 此时矩形只剩边角，
  收缩会有明显观感割裂，**整块改快照更稳**。

0.35 落在 0.27 与 0.404 之间。**这是一个有实测支撑的阈值，不是经验值**，
后续如要调整必须重新跑 `06-stress` 并更新本文件。

### 14.4 快照失效键

`snapshotKey({ viewport, occluders, url })` —— 只有视口、遮挡集合或 URL 变化时才需重取。
用于避免每帧重拍（`snap.staleSnapshotDetectable` 证明不重取会留下旧画面）。

---

## 15. 焦点移交语义

三条实测事实：

1. `inst.hideDoesNotTransferFocus` —— `setVisible(false)` 后 `view=false / win=false`，
   **焦点直接落空，不会自动交还外壳**。
2. `inst.reshowDoesNotStealFocus` —— `setVisible(true)` **不会**自动抢回焦点。
   这一条是**安全性**结论：恢复可见不会打断用户当前的输入目标。
3. `inst.shellCanTakeFocusAfterHide` —— 显式 `webContents.focus()` 之后
   `win=true`（`windowKey=true`）。**可以移交，但必须主动做。**

因此架构规则：

- 视图从可见变隐藏时，**必须显式把焦点移交给外壳**（或移交给新的焦点目标）。
- 不移交的后果不是"焦点留在网页"，而是"键盘没有人收到" —— 这是最容易被误判成产品 bug 的形态。
- 移交必须**幂等且可重试**：`focusShell()` 实测需要多轮重试才能稳定拿到焦点。

---

## 16. 会话与分区

`multi.sessionIsolationContract` 实测：外壳会话 ≠ 网页会话；同分区的两个视图共享会话，
不同分区隔离。

**§13 冻结预期成立**：**同一个 OpenArc Browser App 默认共享其 app session。**

理由：用户对"同一应用的多个窗口"的预期是登录态共享（像 Chrome 的同一 profile），
不是每窗口一个全新会话。因此多视图按 **App** 绑定分区，而不是按 Window。

---

## 17. Z-order 与层级契约

冻结层级（PLAN.md §23 授权）：

```
Desktop  <  Window  <  System Overlay  <  Modal  <  Lock Screen
```

- 普通窗口不能覆盖锁屏。
- 系统级覆盖层（Dialog / Search / AI 面板）整块让位原生视图 → 排除了"覆盖层与网页争层级"。
- 右键菜单**不是**系统级覆盖层（它不阻断整块交互）→ 走 `clip+snapshot`
  （`06-stress` 第 5 步期望值已按此修正）。
- 原生视图之间的 z 序由 `addChildView(view, index)` 控制（§10 实测）。

---

## 18. §17 Dialog 阻断硬验收

`02-input` 12/12。四段递进：

**B 段（对话框打开、视图仍可见、未缓解）**

- `input.dialog.viewKeepsKeyboardWhenVisible` —— 焦点仍在网页（`view.isFocused = true`）→
  DOM 拿不到键盘。
- `input.dialog.escapeReachesPageNotDialog` —— 按 Esc 后 **DOM 收不到，网页收到 `Escape`**。
- `input.dialog.clickOnDialogReachesPage` —— 点对话框中心 **DOM 0 / 网页 3**。

**C 段（缓解：隐藏视图 + 显式移交焦点）**

- `input.dialog.hideAndRefocusRestoresKeyboardToDom` —— `view=false / shell=true`。
- `input.dialog.escapeReachesDialogAfterMitigation` —— **Esc 到达 DOM 对话框，网页 0 次**。
- `input.dialog.clickReachesDialogAfterMitigation` —— **DOM > 0，网页 0 次**。

**D 段（关闭后恢复）**

- `input.dialog.pageResumesAfterClose` —— 关闭对话框并恢复视图后，网页**重新接收输入**。

**E 段（焦点陷阱的仪器阳性对照）**

- `input.focusTrail.tabIsInjectable` —— 连续 Tab 的 `activeElement` 轨迹为
  `dlgA → dlgB → outsideBtn → dlgA → dlgB → outsideBtn → dlgA`。
- `input.focusTrail.escapeDetectable` —— 轨迹**出现 `outsideBtn`**，
  即当前**没有焦点陷阱**，焦点会逃出对话框。

### 18.1 结论

> **§17 的"视觉覆盖 + 阻断鼠标 + 阻断键盘 + 关闭后恢复"四项全部成立，
> 成立的条件是"原生视图整块让位 + 显式移交焦点"。**

E 段的两条不是缺陷登记，而是**仪器的阳性对照**：
它证明注入的 Tab 能真实驱动 DOM 焦点，因此 D2-02B 装上焦点陷阱后
"逃不出去"才是可信结论（一条从未失败过的断言不算证据）。

**Dialog 的 `CLOSED BY D2-02` 判定不允许在 Gate 阶段给出** ——
必须等 D2-02B 的实现被产品自身消费并回归通过（见 §25）。

---

## 19. 决策

> **CHOOSE HYBRID（候选 E）**
>
> 1. **窗口仍是 DOM Window。** 保留"渲染进程持有唯一状态权威"这一现有优点，
>    不引入第二权威。
> 2. **原生层升级为多 `WebContentsView`。** 每个浏览器类窗口一个视图，
>    按 **App** 绑定会话分区，生命周期独立（create/attach/load/show/hide/setBounds/
>    focus/blur/reload/detach/destroy 全链可控，关闭后真正释放）。
> 3. **可见性由 `electron/occlusion.cjs` 的 `plan()` 决定**，输出四态：
>    `live` / `clip+snapshot` / `snapshot` / `hidden`。**废除单一 `blocked` boolean。**
> 4. **系统级覆盖层整块让位。** Dialog / Search / AI 面板 → `hidden` +
>    显式移交焦点。这是 §17 成立的机制。
> 5. **部分遮挡走"收缩 + 快照补齐"。** 阈值 `CLIP_MIN_RATIO = 0.35`（§14.3）。
> 6. **圆角双层处置**：`setBorderRadius` 修视觉，DOM 覆盖块收点击。
> 7. **不采用原生 child / 独立窗口。**

---

## 20. 被否决方案的理由

| 候选 | 否决理由 |
| --- | --- |
| A（仅 hide/show） | 二值决策无法表达部分遮挡，实测丢失 **50%** 未遮挡区域 |
| B（仅 setBounds） | 单矩形在中心挖洞场景只能保住 **40.4%**，四块空闲带拓扑上不可能用一个矩形表达 |
| C（单用多视图） | 本身是 E 的组成部分，但**单独使用**无法解决遮挡；且同 URL 两视图状态分叉，不能用来切碎一个窗口 |
| D（原生窗口） | **父窗口无法被抬到自己的 child 之上**（实测已生效的 `alwaysOnTop` 仍无效）→ 永远无法满足 §17；且污染 Mission Control |

**特别记录**：候选 D 被否决**不是**因为"实现复杂"，而是因为它有一个**架构上不可修复**的缺陷。
这是本 Gate 最有价值的一条否定结论 —— 它把一个看似合理的方向彻底关掉，
避免 D2-02B 在错的拓扑上做半年。

---

## 21. 冻结的架构边界与依赖方向

```
Window Manager              唯一状态权威（domain state / focus / z-order）
   ↓ commands / state
Renderer Window Components  Window({window, children, onCommand}) —— 不拥有业务状态
   ↓ geometry / native intents
Electron Main               IPC 边界（trusted 校验）
   ↓
Native View Controller      只管原生资源，不拥有 Window domain 规则
   ↓
WebContentsView             原生资源

Overlay / Occlusion state
   ↓
Native View Controller visibility
```

硬规则：

- **依赖方向单向**，不允许原生控制器反向写 Window domain state。
- `Native View Controller`（`electron/native-view-controller.cjs`，D2-02B 建立）
  **不拥有 Window domain business rules** —— 它只回答"这个视图现在该以什么形态存在"。
- **渲染进程不得直接获得 Electron 对象**：维持 `contextIsolation: true` /
  `nodeIntegration: false` / `sandbox: true`；**禁止暴露 `ipcRenderer` 原始对象、
  `webContents`、文件系统、`shell`**。
- `WebViewport` 只是 **DOM placeholder / geometry anchor**，
  **不允许 React component 直接拥有 Electron `WebContents` 对象**。

---

## 22. 已知代价（必须显式承担，不得隐藏）

1. **快照区不可与网页交互**（`snap.snapshotAreaIsNotInteractiveWithPage`）。
   缓解：快照层 `pointer-events: none`，点击穿透到正确目标；
   被快照覆盖的区域在视觉上是网页、交互上是外壳 —— **这个不一致是真实的，必须写进产品文档**。
2. **快照会过期**（`snap.staleSnapshotDetectable`）。
   缓解：`snapshotKey` 失效策略；内容变化或交互时立即重取。
3. **被圆角切掉的区域仍收点击**（`occl.corner.cutoutStillCapturesClick`）。
   缓解：DOM 覆盖块显式屏蔽。
4. **多视图 = 多 document**（`multi.sameUrlViewsAreIndependentDocuments`）。
   缓解：多视图只用于"多个独立窗口"，**不得**用于"把一片网页切成几块"。
5. **内存/进程随视图数线性增长**。
   当前未做性能测量（§24）。

---

## 23. 安全边界不变式（Gate 阶段未变更）

Gate 只增加探针与一个纯函数模块，**没有扩大任何暴露面**：

- `electron/preload.cjs` **未修改** —— 仍只暴露
  `navigate / layout / action / onBrowser / onDisplay`。
- `electron/main.cjs` **未修改** —— `trusted(event)` 校验保持
  `event.sender === win.webContents` + `senderFrame.url === uiURL`；
  `safeURL` / `safeBounds` 策略未放宽。
- 新增的 `electron/occlusion.cjs` 是**纯函数**，无副作用、无系统访问。

→ `window.openarc` surface **未扩大**。A13 相关安全 probe 的完整重跑安排在 D2-02B（§38）。

---

## 24. 未验证 / 未覆盖

| # | 项 | 状态 |
| --- | --- | --- |
| 1 | **Windows 平台全部**（mica、窗口行为、圆角、多显示器、遮挡） | **NOT VERIFIED**，不得用 CSS 模拟后宣布跨平台 PASS |
| 2 | 真实多显示器拔插、双屏 DPI 迁移 | NOT VERIFIED（只有一块屏） |
| 3 | GPU 性能、GPU 进程 | NOT VERIFIED（本机需 `--in-process-gpu`） |
| 4 | 渲染进程 sandbox 运行时强制 | NOT VERIFIED（Chromium sandbox 在本机起不来） |
| 5 | 快照策略的性能成本（重拍频率、内存占用） | NOT VERIFIED |
| 6 | 长时间运行下的快照内存回收 | NOT VERIFIED |
| 7 | 锁屏层（Lock Screen）与原生视图的交互 | NOT VERIFIED（D2-02 无锁屏实现） |
| 8 | UI E2E（Playwright） | BLOCKED（与 Electron 44 / Chromium 152 组合启动超时，根因未确认） |
| 9 | 原生视图的 `blur` 语义在窗口切换时的表现 | 仅覆盖同窗口内焦点迁移，跨窗口未测 |

---

## 25. 对 D2-02B 的强制约束（交接）

1. `Window Manager` 必须是**唯一状态权威**，**禁止第二状态权威**。
2. 冻结 9 条 Window Command（OPEN / CLOSE / FOCUS / MOVE / RESIZE / MINIMIZE /
   RESTORE / MAXIMIZE / UNMAXIMIZE），**不得散落 `setWindows(prev => ...)`**。
3. Manual 与未来 AI **共用同一 WindowCommand 层**，
   **禁止留一条 AI 直接改 React state 的捷径**。
4. Domain model 必须支持 `appId → windowIds[]`，**不得把"一个 App = 一个 Window"写死**。
5. `Window({window, children, onCommand})` 或等价，**Window 不拥有业务状态**。
6. 禁止为了"看起来组件化"创建几十个随意 props。
7. 持久化继续用 `oa-wins`，但**必须经 Window Manager**；
   **不保存** temporary focus / opening / closing / modal ephemeral state。
8. Display change 继续复用 `electron/geometry.cjs`，**不要重新发明另一套 clamp**。
9. 每个窗口必须有 minimum width/height，取 design token / constant，**不得硬编码散落**。
10. 状态推进**严禁依赖 `transitionend` / `animationend`**。
11. Reduce Motion 三路径（normal / reduced class / `prefers-reduced-motion`）
    窗口功能状态必须完全一致。
12. Dialog primitive 必须含 focus trap / inert / Esc / close button / focus return。
13. 圆角必须**双层处置**（视觉 `setBorderRadius` + 交互屏蔽），只做视觉不算完成。
14. `overlayOpen` 的判定必须由 Window Manager 输出，**不允许各覆盖层自己各写一份**。

---

## 26. 证据

### 26.1 探针矩阵（116/116）

| 探针 | 通过 | 覆盖 |
| --- | --- | --- |
| `00-instrument` | **14/14** | capturePage 局限、screencapture 真值、ICC、Retina、焦点语义、输入注入 |
| `01-occlusion` | **23/23** | 全遮挡、部分遮挡（贴边/挖洞）、圆角三处置、点击路由 |
| `02-input` | **12/12** | §17 四项 + 焦点陷阱仪器阳性对照 |
| `03-multiview` | **10/10** | 并存、隔离、reload、销毁释放、会话、z 序重排 |
| `04-childwindow` | **8/8** | 候选 D 收益（OS 裁剪/圆角）与代价（不可被盖/进系统窗口列表） |
| `05-snapshot` | **7/7** | 三种缓解策略 + 交互与时效代价 |
| `06-stress` | **42/42** | 15 步连续流程，**270 采样点 0 处不一致**，焦点恒 1 个持有者 |

`06-stress` 步序与 `plan()` 输出：

```
01-open-A            A=live            B=hidden
02-open-B            A=live            B=clip+snapshot
03-open-C            A=live            B=clip+snapshot
04-focus-A           A=live            B=clip+snapshot
05-open-contextmenu  A=clip+snapshot   B=clip+snapshot
06-close-contextmenu A=live            B=clip+snapshot
07-open-dialog       A=hidden          B=hidden
08-close-dialog      A=live            B=clip+snapshot
09-drag-C-across-A   A=snapshot        B=live
10-focus-B           A=live            B=clip+snapshot
11-open-search       A=hidden          B=hidden
12-close-search      A=live            B=clip+snapshot
13-minimize-A        A=hidden          B=clip+snapshot
14-restore-A         A=live            B=clip+snapshot
15-close-B           A=live            B=hidden
```

### 26.2 复现

```bash
ELECTRON_EXTRA_ARGS="--no-sandbox --disable-gpu-sandbox --in-process-gpu" \
  node experiments/d2-02-gate/run-all.mjs
```

单测（纯逻辑，不依赖 Electron）：

```bash
npm test        # 25/25（原 7 条 + occlusion 18 条）
```

### 26.3 产物

- 汇总：`artifacts/d2-02/gate-summary.json`
- 各探针报告：`artifacts/d2-02/0X-*.json`
- 真实合成帧：`artifacts/d2-02/*.png`（41 张，含每一步的层级帧）
- 仪器自证（无子视图）：`artifacts/d2-02/inst-capturepage-{visible,hidden}.png`（两者字节完全相同）

### 26.4 关键实测数字（供事后对比，防口径漂移）

| 量 | 值 |
| --- | --- |
| 合成帧 scale | 2（1100 DIP → 2200 px） |
| sRGB 绿原生 P3 读数 | `rgb(117,251,76)` |
| sRGB 绿 ICC 转换后 | `rgb(3,255,0)` |
| 指针注入漂移 | 0.0 px |
| 全遮挡不缓解时重叠区点击 | DOM 0 / 网页 3 |
| 部分遮挡整块隐藏丢失比 | **0.5**（84,888 / 169,776 DIP²） |
| 中心挖洞最大单矩形占比 | **0.4045**（52,488 / 129,776） |
| 拖窗口穿过时的最大矩形占比 | **0.27** → 触发整块快照 |
| `CLIP_MIN_RATIO` | **0.35** |
| 圆角切区点击 | DOM 0 / 网页 3（**仍收点击**） |
| 销毁一视图后 webContents | 3 → 2 |
| 候选 D 下 OS 窗口数 | 1 → 2 |

### 26.5 本轮改动

新增：

- `electron/occlusion.cjs`（产品真实模块，纯函数）
- `tests/occlusion.test.mjs`（18 条，含 300 组确定性随机场景的不变量测试）
- `experiments/d2-02-gate/`（lib + native 宿主 + 7 个探针 + 7 个 runner + `run-all.mjs`）

修改：

- `tests/native-view.mjs`（加固 `ELECTRON_RUN_AS_NODE` / `ELECTRON_NO_ATTACH_CONSOLE` 剥离）

**未修改**：`electron/main.cjs`、`electron/preload.cjs`、`electron/geometry.cjs`、
`electron/policy.cjs`、`src/main.tsx`、`src/styles.css`。

---

## 27. 结论

**D2-02A Window Architecture Gate：COMPLETE（有决策）**

- 架构问题**已回答**：CHOOSE HYBRID（E）。
- 决策**有实测支撑**：116 项断言全部通过，7 组探针覆盖视觉/输入/生命周期/压力全链路。
- 被否决方案**有决定性证据**，不是偏好。
- 仪器**自身可信**：14 项自校验，且包含"一条从未失败过的断言不算证据"的对照设计。

**未随本 Gate 关闭的**：Windows（NOT VERIFIED）、真实多显示器（NOT VERIFIED）、
GPU 性能（NOT VERIFIED）、快照性能与内存（NOT VERIFIED）、UI E2E（BLOCKED）。

**因此 D2-02 overall 保持 PARTIAL**，即使 D2-02B 在 macOS 范围内 9 项全部成立，
也不得写双平台 COMPLETE。

下一步：进入 **D2-02B · Window System Implementation**，按 §25 的 14 条约束实施。

---

# D2-02B · Window System Implementation

以上 1–27 节是 **D2-02A Gate**（架构前提）的决策记录。以下 28–44 节是 **D2-02B**
（在 Gate 冻结的架构上实施）的记录。两者同属 D2-02，但**阶段不同**：
Gate 证明"Electron 能不能做到"，B 证明"我们写的那段代码是否真的做到"。

---

## 28. D2-02B 的范围与不变量

**范围（只做这些）**：Window Domain Model / Window Manager / 原生视图生命周期与遮挡结算 /
Desktop Components 组件化 / Dialog 原语 / Dock–TopBar 与 Window Manager 接线 / 持久化 /
Reduce Motion 三路径一致性 / A13 安全回归。

**不做**：D2-03 及以后的任何内容；Windows 侧任何结论；不引入第二套队列、不偷偷重试工具。

贯穿全部改动的不变量（每一条都有对应断言）：

| # | 不变量 | 由谁强制 |
|---|--------|----------|
| I1 | `order` 是层级唯一真值，`window.z` 只是它的缓存 | `reindex()` + `domain.invariants()` |
| I2 | **层级不得由 `windows` 数组顺序表达**（见 §31） | `tests/zorder.test.mjs` |
| I3 | `focused` 不得指向不存在或已最小化的窗口 | `reindex()` 收口 |
| I4 | 手动 UI 与未来 AI 走同一条 WindowCommand 层，不开旁路 | `src/main.tsx` 只有 `onCommand` 一个入口 |
| I5 | 状态推进不得依赖 `transitionend` / `animationend` | `experiments/d2-02/motion-parity.mjs` |
| I6 | 原生视图不拥有 Window domain 业务规则 | `electron/native-view-controller.cjs` 只吃 intent |
| I7 | 渲染进程拿不到危险对象（IPC / Node / Electron 原语） | `experiments/d2-02/security-surface.mjs` |

---

## 29. Window Domain Model（§4 冻结）

新增 `electron/window-domain.cjs`，纯函数、零 Electron / DOM / React 依赖 ——
因此主进程与渲染进程可以同时引用它，且 `node --test` 能直接覆盖。

冻结的字段：`id / appId / kind / bounds / state / restore / minSize / meta / visible /
displayId / z`。`appId` 与 `id` 是**两个独立的键**（§17 的硬要求：同一 App 可以有多个窗口，
`browser-a` / `browser-b` 这类场景不允许被"一个 App 一个窗口"写死）。

常量一律 token 化，不在各处散落硬编码：

| 常量 | 值 | 理由 |
|------|----|------|
| `MIN_WINDOW_W` / `MIN_WINDOW_H` | 560 / 400 | §25；沿用既有拖拽路径的取值，**不为了 token 化改变既有行为** |
| `AREA_TOP` | 44 | 桌面工作区上沿 |
| `TITLE_BAR_H` | 44 | **必须与 `src/styles.css` 的 `.window-title { height: 44px }` 一致** —— 不一致会让原生视图与 DOM 视口锚点错位，表现为"网页整体偏移一截" |

`toPersisted()` 只写跨会话仍然成立的字段：`appId / kind / bounds / state / restore /
minSize / meta / displayId`。**不写** `focused`、`order`、`z` —— 上次退出时谁在最上层
不该决定下次启动的层级。恢复路径**任何字段坏掉都不抛异常**，而是降级（坏窗口丢弃、
坏 bounds clamp、未知 state 退回 normal）：恢复路径抛异常等于"一次崩溃后永久打不开"。

---

## 30. Window Manager 是唯一状态权威（§5）

新增 `electron/window-manager.cjs`。它是唯一的状态变更入口：

- **9 条冻结的 Window Command**（`WINDOW_COMMANDS`，供契约测试与未来的 AI 工具绑定）：
  `window/open`、`window/close`、`window/focus`、`window/move`、`window/resize`、
  `window/minimize`、`window/restore`、`window/maximize`、`window/unmaximize`
- **3 条系统级变更**（`SYSTEM_MUTATIONS`，刻意与命令层分开，避免"命令"被稀释）：
  `system/hydrate`、`system/reflow`、`system/native-state`
- 未知命令**原样返回原状态**（不抛异常）：命令层要能承接未来 AI 生成的内容，
  不能因为一个拼错的 `type` 把整个 UI 打死。

几何 **复用 `electron/geometry.cjs` 的 `clampAll`，不重新发明第二套 clamp**（§24）。
显示器增删、分辨率变化、宿主窗口尺寸变化走**同一条** `system/reflow`。

---

## 31. 层级不得泄漏成数组顺序（本轮审出的最严重产品缺陷）

### 31.1 现象

点一个**后台窗口**的关闭 / 最小化 / 最大化按钮，**第一次没反应** ——
窗口只是被提到了前面，按钮不生效；再点第二次才好。

### 31.2 根因

`reindex()` 返回的 `windows` 数组曾经是 `order.map(...)`，也就是**让数组顺序跟着层级走**。
看着更整齐，但它把层级泄漏成了数组顺序 —— 而数组顺序在 React 里就是 DOM 顺序。

于是点后台窗口的按钮时：

1. `pointerdown` 命中按钮，冒泡到 `section.window` 的 `onPointerDown` → 派发 `window/focus`
2. 状态变更被提交，`order` 变了 → `windows` 数组跟着重排 → **React 移动了那个
   `<section class="window">` 节点**
3. 这次移动落在 `mousedown` 与 `mouseup` 之间 → 浏览器放弃合成这次手势的 `click`

### 31.3 证据（`experiments/d2-02/window-stress` 07 步）

真实鼠标序列里**根本不存在 `click`**：

```
1211ms pointerdown path < svg < button.minimize[最小化settings]
1212ms mousedown   div.desktop-surface        ← 目标已经变了
1214ms pointerup   path < svg < button.minimize
1214ms mouseup     path < svg < button.minimize
（没有 click）
```

同一时刻 `pointerdown` 却是命中的 —— 这也解释了为什么"纯聚焦"类操作一切正常、
只有"按钮"失灵。对照组：改用 `element.click()` 直接派发时，`window/minimize`
立即生效（`settings` 被最小化、焦点交还给 `browser`），证明处理器本身没问题。

两个旁证：窗口**已经在前台**时按钮一次就生效（`pointerdown` 不产生状态变更 → 不重排）；
`window-stress` 里 01 步"点标题栏聚焦"也一直通过（它只需要 `pointerdown`）。

### 31.4 修法

`windows` 数组**保持创建序不变**，层级只由 `order` / `z` 表达。置顶于是只改 `z-index`，
不改节点身份，`click` 不会再被吃掉。

这不是绕过现象，而是把一条冗余表达删掉：数组位置与 `z` 原本是同一件事的两种写法。
所有不变量与查询本来就是按 `id` / `order` 表达的（`invariants()` 用
`order.indexOf(w.id)`，`aboveWindows()` 用 `state.order.slice(i+1)`，
`nativeIntents()` 逐窗口算 `occluders`），因此**没有任何行为依赖数组顺序**。

### 31.5 守卫

`tests/zorder.test.mjs` 新增两条：置顶后 `windows` 数组顺序必须原样，
且 z 必须跟着 `order` 走、z 没变的窗口保持同一引用；关闭再开之后数组顺序仍按创建序。
`window-stress` 的 07 步是端到端的守卫。

---

## 32. 原生视图：一个字段名错位让整条遮挡链路静默失效

`electron/occlusion.cjs` 的 `plan()` 返回的字段名是 **`mode`**，
而 `electron/native-view-controller.cjs` 读的是 `plan.strategy` —— 恒为 `undefined`。

后果是三件事**同时**静默失效，而任何 DOM 侧探针都看不到：

1. 最小化不隐藏视图（`mode === "hidden"` 判断永不成立）
2. 系统级覆盖层打开时原生视图不让位（§17 硬验收失去实现）
3. 快照永不补齐（`mode === "snapshot"` 分支不可达）

修法是全链路统一到 `mode`（控制器、`useDesktop.ts` 的 `NativeResult.mode`、
快照层与 `nativeVisibleOf`）。同时把这条经验固化成断言：
`native-view-lifecycle` 的第一条硬断言就是**结算结果的 mode 必须落在四个已知取值之内**。

---

## 33. 快照有两条隐性前提

### 33.1 必须先取图，再隐藏

原实现先 `hide` 再 `capturePage` —— 隐藏后视图不再产像素，快照恒为 `null`。
顺序必须反过来：**先取图，再隐藏**。

### 33.2 `capturePage` 的 rect 是页面坐标，且页面会随视图尺寸重排

先收缩到 `plan.bounds` 再取补丁，补丁区域在页面里已经不存在，取到空图。
正确顺序是：**先把视图铺满完整视口 → 取图 → 再收缩到 `plan.bounds`**，
并在 `#snapshots(..., origin)` 里做"视口坐标 → 页面坐标"的换算。

### 33.3 `UnknownVizError` 是瞬时的

合成器还没为新区域产出帧时会抛这个错，一次失败就永久留白。
改为**有界重试**（3 次 × 40ms），并且 catch 里写日志留痕（原来是静默吞掉）。

### 33.4 其它同批修掉的

- `plan.mode === "snapshot"` 时 `plan.bounds` 是 `null`，控制器 `setBounds(null)` 抛
  `TypeError: conversion failure from null` 并打断整次 sync → 该分支不再 `setBounds`
- `webContents.close()` 是**异步**的 → 断言改为"最终真的释放"，而不是"同步已释放"
- `destroyAll()` 末尾置 `destroyed` 标记，防止关闭后再被 sync 唤醒

---

## 34. `setPointerCapture` 在本机 Chromium 不可靠（§26）

现象：拖标题栏 / 拉缩放手柄时，指针一离开元素窗口就不跟手；缩放手柄只有 22px，更早断。

诊断：`setPointerCapture` 调用成功、`hasPointerCapture()` 当场返回 `true`，
但**从没有触发过 `gotpointercapture`**，随后 `pointermove` 被投给了指针下方的其他元素。
（排除过程：标记节点未被替换、捕获确实返回 true、合成页里捕获正常、产品里单窗口也正常 ——
所以问题不在 React 也不在 Playwright 路径，而在"捕获不生效"这个前提本身。）

修法：新增 `trackPointer()`，把 `pointermove` / `pointerup` / `pointercancel`
挂到 **`window`** 上。捕获仍然尝试建立（减少重定向抖动），但**正确性不依赖它**。

---

## 35. `window/unmaximize` 曾经在产品里不可达（§20）

按钮与双击都只派发 `window/maximize` —— 用户把窗口放大之后**再也回不来**，
而这条命令明明在冻结清单里。

修法：`TrafficBar` / `TopBar` / `TitleBar` 一律改成**切换语义**，
由 `maximized` 这个投影决定派发 `maximize` 还是 `unmaximize`。
`window-stress` 的 09 / 12 步是守卫（双击已最大化的窗口 → 必须还原）。

---

## 36. 宿主窗口缩小必须走同一条 reflow（§23 / §24）

原先 `resize` 事件只更新宿主尺寸、不 reflow —— 外壳被拖小时窗口会落到工作区之外，
**既抓不到也关不掉**。

修法：`resize` 与 `onDisplay` 共用同一条 `system/reflow`（同一条 A05 不变量、
同一个 `geometry.clampAll`）。`reflow` 另外加了"无变化 → 返回原状态"以避免空转：
尺寸变化事件会持续触发，每次都产生新对象会让持久化与重渲染跟着空转。

---

## 37. Dock 必须消费 `appId → windowIds[]`（§32）

原先 Dock 只派发 `window/open`（按 id 幂等）。当**窗口 id ≠ appId** 时就错了：
点 Dock 既恢复不了最小化的窗口，还会因为 id 对不上**多开一个**。

修法（macOS 语义的三条分支，由持有 Window Manager 的那一层判断）：

1. 该 App 有可见窗口 → 聚焦**最上面**那个
2. 全部最小化 → 恢复最上面那个
3. 一个都没有 → 新建

Dock 只上抛 `appId`，**不自己决定派发哪条窗口命令**。

---

## 38. Desktop Components 组件化与 styles.css 迁移（§16 / §18 / §29 / §31）

- 12 个 Desktop Components 真正拆成组件；`Window({window, children, onCommand})`
  **不拥有任何业务状态** —— 位置尺寸来自 `window.bounds`，层级来自 `window.z`，
  聚焦来自 `focused`，它自己只有"拖拽中"这一个纯交互状态且不回写域
- ContextMenu 是真组件：`ArrowUp/Down`、`Home/End`、`Enter`、`Esc`、焦点管理、
  `disabled`、`separator`
- `styles.css` 迁移到设计系统 token：**迁移 14 处、保留 4 处并逐条注明理由**，
  视觉零变化（`test:design-system` 与 `test:theme-baseline` 复跑通过）

---

## 39. Dialog 原语与无障碍（§16 / §40）

`src/desktop/Dialog.tsx` 提供焦点陷阱、`aria-modal`、`Esc` 关闭、关闭后焦点归还原触发元素。
产品自身消费它有两条真实路径：桌面文件夹的删除确认、以及控制中心的确认。

`dialog-a11y` 33/33：焦点进入 / 陷阱 / `Esc` / 焦点归还 / `aria` 语义 / 背景 inert
逐条实测。**§40 的 Dialog Accessibility 因此满足**。

---

## 40. Reduce Motion 三路径的功能状态一致性（§28）

三条路径必须"过程不同、结果相同"：① normal ② 产品内开关 `.reduced` ③
系统级 `@media (prefers-reduced-motion: reduce)`。

`motion-parity` 的做法是**同一串真实交互逐字重放三遍**，每一步比对
窗口的位置 / 尺寸 / 层级 / 焦点 / 最小化 / 缩放手柄是否逐项相同 ——
若任何状态推进挂在 `transitionend` 上，reduced 把时长压到 0 后就会卡死或分岔。

非空验证（否则"三边相等"可能只是因为三边跑在同一个配置上）：

| 路径 | 根节点 `.reduced` 类 | `--dur-standard` | `.window` transition-duration |
|------|---------------------|------------------|-------------------------------|
| ① normal | 否 | `.22s` | `0.16s` |
| ② product | **是** | `0ms` | `0s` |
| ③ system | 否（走媒体查询） | `0ms` | `0s` |

22/22 通过。刻意允许不同的量（属"过程"而非"结果"）：Dock 弹跳类、Dock 波浪 `--s`、
以及全部 transition / animation 时长。

---

## 41. A13 安全回归（§37 / §38）

A13（PLAN.md）：**不可信网页尝试访问系统桥接 → 无法读取凭据或调用本机执行端。**

`security-surface` 15/15，打的是**真实主进程入口**与**真实 preload**：

- 静态面：`exposeInMainWorld("openarc", …)` 的键集合、`ipcMain.handle` 的通道集合
  与冻结清单逐字比对；三条上行通道**全部**过 `trusted(event)`；
  外壳窗口 `nodeIntegration:false / contextIsolation:true / sandbox:true`
- 运行时：外壳页里 `window.openarc` 恰为 5 个成员；`require / process / module /
  Buffer / ipcRenderer / electron / webContents` 全部 `undefined`
- **不可信视图**（真实 `WebContentsView` + 独立分区）：`window.openarc === undefined`，
  无任何 Node 全局 → A13 核心断言成立
- 伪输入：`javascript:` / `file://` / 含凭据 URL / `data:` 全部被拒；
  对不存在窗口的 `action("exec")` 被拒；一次投递 64 条意图被拒（上限 32）；
  合法调用仍然成功（证明拒绝不是因为通道坏了）

**关于暴露面是否扩大 —— 不含糊地说**：成员数**未扩大**（5 → 5），
但有两处变化必须记录，不能写成"没变"：

- `layout` / `browser:layout` → **`sync` / `windows:sync`**（多视图需要一次结算多条意图）
- `onBrowser` / `browser:state` → **`onNativeState` / `native:state`**（更名）
- `navigate` / `action` **增加 `windowId` 参数**（§11 / §12 多视图的必需条件）

D1-05 全量安全探针同步复跑：**FAIL 0**，6 PASS / 3 PARTIAL，
与 D1-05 基线结论结构一致 —— **无安全回归**。

---

## 42. 测试与复现

一次性命令（**顺序有依赖**：先跑纯逻辑单测，再跑 Gate 与产品侧探针）：

```bash
npm test                       # 纯逻辑单测，75/75
npm run test:d2-02             # D2-02A Gate + D2-02B 产品侧探针（总入口）
npm run test:security          # D1-05 全量安全探针（永久回归基线）
npm run test:design-system     # D2-01 设计系统探针（永久回归基线）
npm run test:theme-baseline    # D1-04 主题矩阵（永久回归基线）
```

D2-02B 产品侧探针（打的是产品真实模块 / 真实页面 / 真实主进程）：

| 探针 | 断言 | 打的是什么 |
|------|------|-----------|
| `security-surface` | 15/15 | 真实主进程 + 真实 preload + 真实 WebContentsView |
| `dialog-a11y` | 33/33 | 真实产品页里的 Dialog 原语 |
| `motion-parity` | 22/22 | 真实产品页 × 三路径 |
| `window-stress` | 26/26 | 真实产品页 vs 真实 Window Manager 的逐步差分 |
| `two-browser` | 37/37 | 真实模块契约 + 产品页双浏览器 |
| `native-view-lifecycle` | 46/46 | 真实 `native-view-controller.cjs`（Electron 主进程） |

**合计 179 条产品侧断言**，加 75 条纯逻辑单测。

### 42.1 关于 Gate 的复跑：它可复现，但**对屏幕与指针的占用极其敏感**

**本轮最终一次复跑：Gate 116/116 全部通过**（含 06-stress 42/42），
与提交时的结论一致 —— 也就是说 Gate 的结论在本轮**得到了复现**。

但必须把过程写出来，因为它是一个真实的仪器限制。同一个套件本轮一共跑了 4 次，
其中 3 次出现**与产品无关**的失真，而且每次形态不同：

| 次数 | 现象 | 判定依据 |
|------|------|----------|
| 1 | `06-stress` 的 `compositeMatchesPlan` 连续 9 步失败 | 失败帧体积从 ~100KB 跳到 ~6.5MB；缩略图肉眼可见是**正在播放的视频**；失败帧相互 RMS 随步序**单调增大**（40 → 66 → 96） |
| 2 | 同上（完全相同的步位与计数） | 同上 |
| 3 | `inst.cursorWarpIsAvailable` 失败，Gate 自行中止 | `CGWarpMouseCursorPosition` 要求把指针放到 (270,724)，实测落在 (236,739)，**漂移 37.2px** —— 有别的进程/人在同时动指针 |
| 4 | **全部通过** | — |

为了把"是不是产品问题"钉死，另外做了一个**与产品完全无关**的对照：
一个静态 fixture 窗口、采样期间不碰 DOM、不引入任何产品模块，
14 次采集里第 05 次照样拍到了别的内容（620KB 照片 vs 前后 75KB 纯色帧）。
**产品代码不可能解释这个现象**，所以这一类失败不能算回归。

由此固化两条工程约定：

1. `experiments/d2-02/run-all.mjs` 对"屏幕拍照比色"与"物理屏/指针仪器前提"
   做了**窄口径**分类（只认那几个具体 id），并把理由**印在输出里**；
   Gate 里任何其它失败仍然是 FAIL 并立即中止。分类结果一律记
   **PARTIAL / NOT VERIFIED**，既不写成 PASS，也不写成回归。
2. 想让 Gate 结论可信，必须**独占屏幕与指针**再跑一次（本轮最后一次即满足此条件）。
   在屏幕上放着视频、或有人同时操作鼠标的机器上，这组探针的结论不成立。

> 顺带修掉一个会让"没跑起来"伪装成"全通过"的缺陷：Gate 汇总原先会读到**上一轮的产物**，
> 探针崩溃时仍显示旧数字。现在每个探针跑之前先删除自己的产物，
> 没有产物就显式显示"未产出结论（探针未跑起来）"。

---

## 43. 已知代价与本轮未验证

**已知代价（必须显式承担）**：

- 部分遮挡的缓解策略会牺牲被遮挡窗口的可交互性（`CLIP_MIN_RATIO = 0.35` 以下整块改用快照）——
  这是刻意的取舍
- 快照是静态位图，被补丁覆盖的区域**不接收交互**（已用 `pointer-events: none` 避免变成交互黑洞）
- 系统级覆盖层打开时**所有**原生视图一律让位（含未被覆盖的那一个）—— 刻意的保守策略
- `TITLE_BAR_H` 在 domain 与 CSS 各写一份，靠"必须一致"的约定 + 注释约束，
  **没有编译期强制**

**本轮未验证（NOT VERIFIED，不得写成通过）**：

| 项 | 状态 | 说明 |
|----|------|------|
| Windows（mica / 打包 / 窗口行为 / 多显示器） | NOT VERIFIED | 无真机；双平台一致性是硬要求，不能用 macOS 结论外推 |
| 真实多显示器 / 热插拔 | NOT VERIFIED | 单屏环境 |
| GPU 合成性能、快照性能与内存 | NOT VERIFIED | 未做量化测量 |
| UI 端到端流程 | BLOCKED | 本机 Playwright 1.55 与 Electron 44 无法完成 CDP 握手（D1-01 已记录） |
| 运行时沙箱强制执行 | NOT VERIFIED | 本机 Chromium 沙箱无法初始化，探针必须带 `--no-sandbox` 等三项才能跑 |
| 屏幕合成取证（拍照比色）的稳定性 | NOT VERIFIED | 最后一次复跑 42/42 通过，但同一套件 4 次里有 2 次拍到屏幕上的其它内容，见 §42.1 |

---

## 44. D2-02B 结论

**D2-02B · Window System Implementation：macOS 范围内 COMPLETE**

- Window domain / manager 是**唯一状态权威**：9 条命令 + 3 条系统变更，
  每一步都有 DOM ↔ 域的逐步差分断言（`window-stress` 26/26）
- 原生视图生命周期与遮挡结算**打的是产品真实模块**（46/46），
  且四态 `live / clip+snapshot / snapshot / hidden` 全部可达
- 本轮审出并修掉 **7 个真实产品缺陷**：层级泄漏成数组顺序、`mode` 字段错位、
  快照取图顺序与坐标换算、`UnknownVizError` 无重试、`window/unmaximize` 不可达、
  宿主缩小不 reflow、Dock 未消费 `appId → windowIds[]`
- Reduce Motion 三路径功能状态**逐项一致**（22/22），且经由非空验证
- A13 安全回归 15/15，D1-05 全量复跑无回归
- D2-02A Gate 在**独占屏幕与指针**的条件下复跑 **116/116**，结论得到复现

**本轮 7/7 探针全部 PASS**（Gate + 6 个产品侧探针），179 条产品侧断言 + 75 条纯逻辑单测。
Gate 对屏幕与指针占用的敏感性作为仪器限制记录在 §42.1，不隐去。

**D2-02 overall 仍为 PARTIAL** —— 因为 Windows、真实多显示器、GPU 性能、
快照性能、UI E2E 全部未验证。**macOS 的实现结论不得外推到双平台 COMPLETE。**