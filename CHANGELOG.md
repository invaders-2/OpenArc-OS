# 计划修订记录

## 2026-09-12：真实文件服务 —— 任意格式拖入存储（D3-04 最小落地）

用户要求：文件夹支持所有格式拖入储存（图片、视频、文件、文档等）。

- 新增 `electron/file-service.cjs`：存 `<userData>/files/<folderId>/<entryId>` + `index.json` 索引；
  folderId 白名单 `[A-Za-z0-9_-]` 从根上堵路径穿越；重名自动加 " 2"；索引先写临时文件再 rename；
  单个文件失败不影响整批。
- preload 新增 `files` 桥（**暴露面 6 → 7，显式登记**）：`pathFor` / `import` / `list` / `rename` / `remove`。
  `pathFor` 用 `webUtils.getPathForFile`（Electron 44 起 `File.path` 已移除）。
  **没有**暴露 fs / path / shell，也没有任意路径读取；渲染进程只拿条目索引（不含磁盘路径）。
- `main.cjs` 注册 `files:import|list|rename|remove`，全部过 `trusted(event)`；单批上限 200 个路径。
- 渲染层：文件夹窗口 `dragover/drop` → File 换路径 → 主进程**拷贝进** userData；
  条目网格/列表按扩展名给线性图标（图片/视频/音频/文档/文本/压缩包/其它）；
  文件条目复用同一套右键菜单（打开/重命名/删除）与就地重命名。
- 安全探针：冻结清单登记 `files` 与四条通道；`bridgeExpandedOnlyByIdentity` 改为
  `bridgeExpansionRegistered`（登记 D3-01 `identity` + D3-04 `files`）。
  **顺带修探针自身一个真实缺陷**：`guarded` 扫描用了 `[\s\S]{0,240}`，`matchAll` 不重叠，
  会把紧邻的下一个短 handler 整段跳过 —— `files:rename` 明明写了 `trusted(e)` 却判 FAIL。
  改为记住匹配位置、用 slice 看窗口（断言强度不变）。

实测：file-service 单测（导入 3 → 重名自动改名 → 重命名 → 删除 → 路径穿越被拒）；
`node experiments/d2-02/security-surface.mjs` **15/15 PASS**（7 个桥键、8 条通道、全部过 trusted）。

## 2026-09-12：窗口全屏铺满（只让开顶栏）+ 工具条也能拖动窗口

用户反馈：软件内窗口点击全屏后应铺满整个宿主、只让开软件顶栏；窗口拖动不了。

- `window-manager.maximizedBounds`：由 `{x:12,y:52,w:-24,h:-158}` 改为 **铺满宿主、只让开顶栏**
  （`TOPBAR_H = 38`，与 styles.css 的 `.topbar` 高度对齐）。实测全屏 = `0,38,1440,862`。
  非最大化窗口仍受工作区 clamp（`areaOf` 未改），所以只有全屏窗口会盖住 Dock。
- 拖动：`.pane-toolbar` 也接上 `startDrag`（空条区域可直接拖窗，按钮/输入框自动跳过）；
  窗口标题栏拖动保持原样。实测工具条拖动 Δ(-80, 60)。

实测：`npm run build` PASS；全屏 `0,38,1440,862`；工具条拖动生效。

## 2026-09-12：条目重命名（文件夹 / 文件 / 图片 / 视频通用）

用户要求：文件夹、文件、图片、视频等所有条目都支持自定义名称。

- 重命名做成**按 id 的通用操作**（`renameFolder(id, name)`），不区分条目种类 ——
  将来文件服务（D3-04）落地后，文件 / 图片 / 视频走同一条路径即可。
- 文件夹窗口内容区：条目右键菜单 = 打开 / 重命名 / 删除；重命名是就地输入框（Enter 提交、
  Esc 取消、F2 进入）。桌面磁贴重命名保持可用。
- 修两个真实缺陷：
  1. 菜单点「重命名」后，输入框被菜单卸载时的"焦点归还"抢焦而立刻提交并消失 →
     改为菜单卸载后再进入重命名（`setTimeout(..., 0)`）。
  2. 重命名输入框里的回车冒泡到磁贴 `onKeyDown`，把"提交重命名"变成"进入该文件夹" →
     输入框的 click / dblclick / keydown 全部 `stopPropagation`。

实测：右键 → 重命名 → 输入「设计稿」→ 回车，条目名更新，窗口停留在原文件夹。

## 2026-09-12：工具条与红绿灯同行、文件夹内新建子文件夹、红绿灯符号加粗、输入框去线框

用户反馈 5 项，本批完成 1 / 2 / 4 / 5：

1. **Finder 工具条与红绿灯对齐**：`.window:has(.split) .window-title` 改为只盖侧栏宽度
   （`align-self: flex-start; width: 208px`），右栏顶部让出可点区域；`.split-main` 的
   `padding-top` 由 64 改为 10。实测：红绿灯中心 y=140，工具条中心 y=141（同一行）。
2. **右键菜单与新建文件夹**：菜单打开不再自动高亮首项（焦点给面板，方向键仍可用），
   菜单项焦点用同一种填充而不是 outline 方框；「新建文件夹」现在**在当前所选文件夹里**
   建子文件夹（`Folder.parentId`），左栏只列根文件夹，内容区网格/列表渲染子文件夹，
   双击进入（同一窗口内导航）。删除根文件夹会连带删除其子文件夹。
4. **红绿灯符号加粗**：× / − 用 `strokeWidth={3}`，绿色双三角 7→8px。
5. **输入框去线框**：`.field input / .addressbar input / .composer textarea / .folder-rename`
   去掉 `1px solid var(--line)`，改用 `--sunken` 填充；焦点不再用 outline/焦点环，
   改用填充深浅变化（可见但不形成框）。

实测：`npm run build` PASS；`npm test` 96/96；子文件夹创建 1 个、左栏未新增条目。

**未完成**：3. 外部拖入文件 + 空格预览 —— 需要真实文件服务（D3-04）与 preload 能力登记。

## 2026-09-12：文件夹窗口 = 窗口内切换 + Finder 工具条 + 右键菜单；红绿灯对齐原生

用户反馈 3 项：

1. **窗口内切换文件夹**：左栏点击只改当前窗口的浏览状态（`folderUI[windowId]`），
   **不再新建窗口**（实测 window 数 2 → 2）；带前进/后退历史栈。
2. **Finder 式工具条 + 右键菜单**：`.pane-toolbar` 含 后退/前进、位置名、搜索框、
   查看方式（图标/列表分段）、排序、共享/标签；内容区右键菜单含 新建文件夹 / 显示简介 /
   使用群组 / 排序方式（名称·日期·大小）/ 查看显示选项。搜索、排序、群组是**真实状态**
   （作用于当前为空的条目集，不放假文件）；无后端支撑的项明确 `disabled`。
3. **窗口内红绿灯对齐原生**：12pt 圆、8pt 间距、0.5px 描边、原生色值
   (#ff5f57 / #febc2e / #28c840)、符号 8pt；最大化仍为原生双三角。

新增 CSS：`.icon-button` / `.search-field` / `.segmented` / `.folder-body` / `.pane-title`。

实测：`npm run build` PASS；`npm test` 96/96；窗口数切换前后 2→2；右键菜单可开。

## 2026-09-12：文件夹窗口改为 Finder 式布局（左栏 + 工具条 + 内容）

用户复审（附原生 Finder 截图）：文件夹这边同样处理，按截图布局，用我们自己的设计语言。

- `content()` 的 folder 分支由"居中空态"改为 `.split`：
  - 左栏 `.split-side`：分组「桌面」列出桌面上的文件夹（**真实数据** `folders`，不造 mock），
    当前项高亮，点击切换/聚焦；
  - 右栏 `.split-main`：顶部 `.pane-toolbar` 显示位置名（原页面中央的大标题移到这里），
    下面是空态（folder 图标 + 「暂无内容」+ 说明）。
- `.split-main` 改为 flex column；新增 `.pane-toolbar`；`.split-main > .empty-content` 改为 `flex: 1`。

实测：`npm run build` PASS；`npm test` 96/96；截图核对（左栏高亮 + 工具条位置名 + 空态）。

## 2026-09-12：空态去掉右侧底色框

用户复审：Skill 中心右边的底色框去掉。

- `.empty-content` 删除 `background: rgb(var(--content-rgb) / var(--content-alpha))`。
  该空态同时用于 Skill 中心 / 文件 / 无限画布 / 文件夹窗口，全部一并生效，不再出现"右边一个框"。
- 内容直接落在窗口材质上；浮层对比只由左侧栏卡片承担。

实测：`npm run build` PASS；`npm test` 96/96；截图核对。

## 2026-09-12：窗口标题栏不再显示标题文字

用户复审：窗口顶部不需要写「应用中心 / 系统设置」这类标题，其他窗口也是。

- `TitleBar` 删除 `<strong>{title}</strong>`；`TitleBarProps.title` 与 `Window` 调用处一并移除。
- 窗口标题栏保留：左侧红绿灯（14×14）、44px 拖动区、双击最大化/还原。
- 身份仍由 Dock 图标、顶栏最近应用、以及各 App 自身内容表达；
  `section aria-label="${title}窗口"` 保留，无障碍信息不丢。

实测：`npm run build` PASS；`npm test` 96/96；`.window-title strong` 计数 0。

## 2026-09-12：顶栏去掉应用名 + 侧栏改用设计语言材质 + 分栏标题按区块标题

用户复审：顶部栏不需要「应用中心 / 系统设置」这类标题；左侧边栏颜色改用设计语言里的；
「全局模型服务」这种大标题不要那么大，按设计语言。

- 顶栏删除活动窗口标题（`TopBar` 的 `activeTitle`）——应用名由 Dock 与窗口自身表达，顶栏不再重复。
- `.split-side` 背景改为设计语言材质 `rgb(var(--content-rgb) / var(--content-alpha))`
  （surface.content，比窗口外壳略实一档），不再用 ad-hoc 的 `rgb(var(--text-rgb) / 0.06)`。
- `.split-main h1` 由页面主标题 27px 改为**区块标题** `--fs-title`（21px），上边距收紧；副标题下边距 20px。
- 侧栏分组标题保持（系统 / 应用 / 专业 / Skill / 本机）。

实测：`npm run build` PASS；`npm test` 96/96；截图核对顶栏无标题、分栏标题变小、侧栏材质来自 token。

## 2026-09-12：侧栏数值逐项对齐原生 Finder 实测

从原生 Finder 截图逐像素量得：选中行高 **31.5px**、侧栏宽约 **192px**、高亮左右各内缩 **8px**、
行距 **31.7px**、组标题 11px、图标 **16pt**。据此调整：

- `.split-nav`：`padding: 8px` + `line-height: 1.2` → 行高 **32px**（原 28.3 偏紧）；导航图标 15 → **16**。
- `.split-side`：`flex-basis` 188 → **192px**；卡片四周 `margin: 8px`；内边距 `6px 8px 10px`。
- `.split-section`：`padding: 14px 8px 5px`。

实测（Playwright 读数）：`.split-nav` 176×32、gap 8、radius 6、13px/1.2/-0.08px；
`.split-side` 192×554、margin 8、radius 12 —— 与原生 Finder 基本一致。

## 2026-09-12：侧栏间距/字号按原生 Finder 收紧

用户复审：「边距没有做好，字体的间距也没有做好，看看原生 Apple Mac 的窗口」。
对照原生 Finder 侧栏实测：行距约 31–33、图标 16、标签 13、行内边距更紧、组标题 11 且更收。

- `.split-nav`：`padding 8px 10px → 6px 8px`、`gap 10 → 8`、`radius 8 → 6`，
  新增 `line-height: 1.25` 与 `letter-spacing: -0.08px`（行高 28.3px，对齐 macOS 侧栏节奏）。
- `.split-section`：`padding 13px 8px 5px → 12px 8px 4px` + `line-height: 1.2`。
- `.split-side`：卡片四周距统一为 `margin: 8px`（原 10/8/10/10 不齐），
  内边距 `6px 8px 10px`，红绿灯下方首项间距 52px → 44px。

实测（Playwright 读数）：`.split-side` 188×554、margin 8、radius 12；`.split-nav` 高 28.3、
字号 13/行高 16.25/字距 -0.08/内距 6×8/图标间距 8；`.split-section` 高 22.2、字号 11。

## 2026-09-12：侧栏改为内缩浮层卡片（红绿灯在卡片内）

用户复审：「左侧边栏上下左右的边距要离窗口有一点点距离，那样才有浮窗效果」。
即：不是贴边通高，而是**上下左右都内缩的圆角玻璃卡片**，红绿灯嵌在卡片顶部。

- `.split-side`：`margin: 10px 8px 10px 10px` + `border-radius: var(--radius-lg)`
  + `box-shadow: var(--elevation-1)` + `rgb(var(--text-rgb) / 0.06)` 半透明材质 + 玻璃模糊。
- 仍保留 `.window:has(.split) .window-body { margin-top: -44px }`：body 上提盖住标题栏，
  卡片顶边才能到窗口顶部附近，原生红绿灯落在卡片内部。
- `trafficLightPosition` y 13 → 16，让三灯在卡片顶部更居中。

实测：`npm run build` PASS；深色截图核对（`artifacts/ui-fix/sidebar-inset-floating.png`）。

## 2026-09-12：分栏侧栏顶到窗口最上沿，红绿灯落在侧栏浮层内

用户复审：「浮窗效果还是要有，红绿灯在浮窗里面，你看看 apple mac 的左侧边栏是怎样的」。
上一版把侧栏做成与标题栏分开的两层，方向不对。

- `.window:has(.split) .window-body { margin-top: -44px }`：把 body 上提 44px 盖住标题栏，
  于是侧栏材质从窗口顶边一路铺到底，**原生红绿灯正好落在侧栏这块浮层里**。
- `.window:has(.split) .window-title { position: relative; z-index: 2 }`：标题栏提到上层，
  顶栏 44px 仍可拖动/可点红绿灯。
- `.window:has(.split) .split-main { padding-top: 64px }`（内容让开标题栏）、
  `.split-side { padding-top: 52px }`（导航项让开红绿灯）。
- 侧栏材质略提亮到 `rgb(var(--text-rgb) / 0.05)` + `backdrop-filter`，与内容区拉开层次。

实测：`npm run build` PASS；`npm test` 96/96；深色截图核对（侧栏顶到最上沿、红绿灯在侧栏内）。

## 2026-09-12：侧栏按 Finder 口径重做（贴边通高 + 分组 + 灰色选中）

用户以原生 Finder 侧栏为参照复审：「左侧边栏要这样」。上一版的"内缩浮层卡片"方向不对。

- `.split-side`：去掉 margin / 圆角 / 投影，改为**贴左上左下边、通高**（窗口自身
  `overflow:hidden` 负责圆角裁切），只用一层 `rgb(var(--text-rgb) / 0.04)` 半透明材质
  与内容区分；深色下是"略亮"而不是"更深"。
- 新增 `.split-section` 分组标题（muted、micro 字号），三处侧栏分组：
  应用（应用 / 专业）、设置（系统）、Skill（Skill / 本机）。
- 选中态由 accent 胶囊改为 **Finder 式灰色高亮** `rgb(var(--text-rgb) / 0.1)`。

实测：`npm run build` PASS；`npm test` 96/96；深色截图核对（`artifacts/ui-fix/finder-sidebar-*.png`）。

## 2026-09-12：浮层侧栏 + 窗口内红绿灯换原生符号（复审修正）

用户复审分栏效果：「左侧边栏是浮窗效果，跟原生 Apple Mac 那样，不需要深灰色底色框」；
「软件内的窗口红绿灯要使用原生的」。

- **侧栏**：`.split-side` 去掉 `background: var(--sunken)`（实心深灰块，且深色下比窗口更暗），
  改为 macOS 式浮层 —— `rgb(var(--text-rgb) / 0.05)` 半透明材质（随主题变亮/变暗）
  + `backdrop-filter: var(--glass-filter-window)` + 圆角 + `--elevation-1`，
  并内缩 10px 浮在窗口背景之上。设置 / 应用中心 / Skill 中心三处共用。
- **窗口内红绿灯**：最大化按钮 `Maximize2`（对角箭头，不像原生）→ macOS 原生绿色按钮的
  **双三角**缩放符号（内联 SVG，`fill: currentColor`）。

实测：`npm run build` PASS；`npm test` 96/96；深色 Skill 中心截图核对浮层侧栏；
窗口标题栏悬停截图放大核对三个符号（× / − / 双三角）。

## 2026-09-12：顶栏线性图标 + 最近应用 + 控制中心（UI 反馈第二批）

用户反馈第 5 项：顶栏 icon 全线性、显示最近打开的 app、加控制中心（类 Apple）。

- **图标全线性**：顶栏改用 lucide 线性图标 —— 搜索 `Search`、全局 AI `Sparkles`、
  控制中心 `SlidersHorizontal`、锁定 `Lock`、退出 `LogOut`；替换原彩色 PNG
  （spotlight / siri）。应用身份图标（Dock 那套彩色）保持不变，两者不是一层。
- **最近应用**：顶栏按 z 序倒序显示当前打开的窗口（`state.windows` 的投影，不是第二份
  状态），线性图标按 appId 映射（home/browser/files/canvas/skills/settings），点击
  `window/focus`。
- **控制中心**：右上角浮层 `.control-center`；`overlays.control` 参与 `overlayOpen`，
  打开时原生视图整块让位。内容：深色外观 / 减少动态效果（胶囊开关）、材质档位、
  本机 · D1 状态、身份操作（锁定 / 退出）。不压暗桌面，点击外部或 Esc 关闭。
  （浏览器里无主进程时不显示身份两项。）

**实测**：`npm run build` PASS；`npm test` 96/96；Playwright 核对顶栏图标、最近应用
（打开 3 个窗口时 recent=3）、控制中心可开（cc=1），零脚本错误。

**仍未完成**：第 6 项"全部交互动效对齐 Spectrum"—— 与 D1-04 冻结的
"Spectrum UI 全目录 REFERENCE ONLY，不引入源码（Tailwind + Motion）"冲突，
需先定方向（见 CHANGELOG 下一条或对话）。

## 2026-09-12：窗口 chrome + 左右分栏（UI 反馈第一批，完成 1–4）

用户反馈 6 项，本批完成 1–4：

1. **顶部红绿灯可用**：顶栏不再自绘红绿灯，改用**系统原生红绿灯**
   （`electron/main.cjs`：macOS `titleBarStyle:"hidden"` + `trafficLightPosition {x:20,y:13}`；
   Windows `frame:false`）。原生三灯操作 **OpenArc 窗口本身**（关闭/最小化/缩放）；
   之前的 DOM 三灯只能操作"当前聚焦的内部窗口"，没有聚焦窗口时三灯全灰 = 不可用。
   `src/desktop/components.tsx` 删除 `TrafficBar`；`.topbar` 左侧留 92px 给原生三灯。
   每个内部窗口标题栏仍保留自己的红绿灯。
2. **内部窗口标题栏右侧去掉 "OpenArc"**：`TitleBar` 删除 `.title-meta`。
3. **系统设置改左右分栏**：新增 `.split / .split-side / .split-main / .split-nav`；
   左栏"外观与交互 / 全局模型服务"；去掉 `SYSTEM PREFERENCES` 英文眉标；
   布尔项改用胶囊开关 `role="switch"`（`.switch`）。
4. **应用中心 / Skill 中心改左右分栏**：应用中心左栏"全部应用 / 专业应用 / 最近使用"
   （最近使用列出当前打开窗口，可点击聚焦）；Skill 中心左栏"市场 / 我的技能 / 已安装"。

顺带修：默认工作区窗口缺 meta，导致窗口标题与顶栏一直显示 appId `home`
（`src/desktop/useDesktop.ts` 默认 `window/open` 补上 `meta`，现为"应用中心"）。

**实测**：`npm run build` PASS；`npm test` 96/96；浏览器逐屏核对 `/tmp/oa-ui/new-01..04`；
`.app` 截图确认左上为系统原生三灯（红/黄/绿、可用），顶栏左侧留位正确。
未触碰 renderer 白名单与身份边界。

**未完成（下一批）**：5 顶栏 icon 全线性 + 最近应用 + 控制中心；6 交互动效对齐 Spectrum。

## 2026-09-12：修复 .app 顶部透明原生标题栏 + 顶栏拖动区 + 产品菜单

**问题（仅 .app 可见，浏览器预览不受影响）**：`BrowserWindow` 用了 `transparent: true` 但没有关原生标题栏，
窗口顶部多出一条 **32px 透明标题栏**，透出后方窗口，并把应用内容整体下推 32px。
本机 Electron 实测 `getBounds().height - getContentBounds().height = 32`；红色测试页第一行出现在逻辑 y=32。

**实现**（`electron/main.cjs`）
- `BrowserWindow` 增加 `frame: false`：内容与窗口同高（实测 `innerHeight = 940 = window height`，inset 0；
  `first_red_row = 0`）。
- 新增 `installApplicationMenu()`：用 `appMenu / editMenu / windowMenu` 组成最小产品菜单，
  取代 Electron 默认菜单里的 `File` 与 `View → Reload / Toggle Developer Tools`；
  未打包（`electron .`）时额外挂 `Developer` 子菜单，打包后不出现。
  **必须保留 `editMenu` 角色**，否则 macOS 上复制粘贴快捷键失效。

**样式**（`src/styles.css`）
- `.topbar` 增加 `-webkit-app-region: drag`：`frame:false` 后顶栏是拖动整个原生窗口的唯一区域。
- `.topbar button / .bar-icon / a / input` 增加 `-webkit-app-region: no-drag`，保证按钮仍可点击。

**实测**：`npm test` 96/96；`npm run build` 通过；D2-01 探针 PASS 4 / PARTIAL 1 / FAIL 0（无回归）；
探针实测菜单 = `[appMenu, Edit, Window]`（未打包时 + `Developer`）。证据 `artifacts/ui-fix/`（gitignore）。

## 2026-09-10：顶栏左侧加红绿灯（控制当前活动窗口）

用户："我是说软件最顶部那边，openarc的左边加一个红绿灯"。
注意：窗口标题栏内**本来就有**红绿灯（实测 x=104—160 三个圆点），本次是在**系统顶栏**字标左侧再加一组。

**实现**（`src/main.tsx`）
- 新增 `const activeWin = wins.find((w) => w.id === active && !w.min)`，作为顶栏红绿灯的操作目标。
- `<header className="topbar">` 内在 `<strong className="wordmark">` 之前插入 `.traffic.traffic-bar`，
  三个按钮分别关闭（过滤 wins）、最小化（`update(id, {min:true})`）、最大化（复用 `maximize(w)`）。
- 无可控窗口（全部关闭或当前窗口已最小化）时 `disabled`，避免误操作；
  Dock 点击可恢复最小化窗口（`focus()` 内部已置 `min:false`），不存在死路。

**样式**（`src/styles.css`）
- `.traffic-bar { position: static; gap: 8px; margin-right: -12px }` —— 覆盖 `.traffic` 的绝对定位，
  跟随文档流排在字标左侧；`margin-right:-12px` 抵消顶栏 26px gap，实测灯组与字标间距 14px。
- 按钮 12×12（窗口内为 14×14），颜色沿用系统 `#FF625B / #FFBF3E / #2BC94E`。
- `.traffic button:disabled { background: rgba(125,125,125,0.5) }` 中性灰置灰。
- DESIGN_SYSTEM 3.1 白名单追加说明：顶栏红绿灯与窗口红绿灯同属"平台约定例外"，
  且这三个色不得反过来用于表达产品语义（成功/失败/警告）。

**实测**：按钮位于 x=23/43/63、y=13、12×12，字标 x=89（间距 14）；
像素采样 红 `rgb(255,98,91)` / 黄 `rgb(255,191,62)` / 绿 `rgb(43,201,78)`；
最大化 830×570@90,94 → 1416×742@12,52，还原正常；最小化后按钮置灰为 `rgba(125,125,125,0.5)` 且 `disabled=true`。
`npm run build` 通过、`npm test` 2/2 通过。截图 `docs/snapshots/2026-09-10-topbar-traffic-lights.png`。

## 2026-09-10：顶栏 / Dock / 标题栏透明度归零

用户："顶栏 / Dock透明度为0，标题栏透明度为0"。

- `--bar` 深色值 `rgba(23,23,23,.72)` → **`rgba(23,23,23,0)`**，只保留 `backdrop-filter`。
  实测顶栏整行（y=19，x 从 0 到 1440）全为 `0`，Dock 下缘 3—5（即桌面本身）——底板已完全消失，
  纯黑桌面上只剩图标与文字悬浮，窗口滑到下方时才由模糊显现。
- `.dark .window-title` 白 4.5% → **`transparent`**，标题栏与窗口外壳同值，不再有材质分区。
- 拆出新 token **`--pill`**：桌面 AI 胶囊原本与顶栏共用 `--bar`，若一并透明则在纯黑上只剩一行裸字。
  现 `--pill` 深色保留 `rgba(23,23,23,.72)`（实测 17/255），浅色仍为白色 58%。
- `.opaque.dark`（减少透明度模式）`--bar` 回落 `#111111`，保证无障碍场景下顶栏/Dock 仍可辨识。
- 浅色主题未动：`--bar` 白 58%、`.window-title` 黑 3.5% 保持原样。

实测（截图后逐像素采样）：顶栏 0 / Dock 底板 3—5 / 标题栏与窗口外壳同值 / 窗口顶边高光 38（非活动）/ AI 胶囊 17。
`npm run build` 通过、`npm test` 2/2 通过。截图 `docs/snapshots/2026-09-10-bars-transparent.png`。

## 2026-09-10：深色再压暗，基色统一 #171717 @ 50%

用户："再深一点用这个色值：#171717，透明度再降一点，50%吧"。
上一版深灰阶梯（#262629 / #2D2D30 / #333336 / #3A3A3E）整体偏亮，改为**单一基色 #171717 + alpha 分档**。

**深色 token（src/styles.css `.dark`）**
| token | 之前 | 现在 | 合成于纯黑桌面 |
| --- | --- | --- | --- |
| `--surface` 窗口外壳 | rgba(45,45,48,.76) | **rgba(23,23,23,.50)** | ≈ #0C0C0C（实测 13/255） |
| `--content` 内容区 | rgba(38,38,41,.94) | **rgba(23,23,23,.60)** | ≈ #0E0E0E |
| `--sunken` 凹槽 | rgba(0,0,0,.22) | rgba(0,0,0,.28) | — |
| `--bar` 顶栏/Dock | rgba(58,58,62,.72) | **rgba(23,23,23,.72)** | ≈ #111111（实测 17—18/255） |
| `.opaque.dark` 实色兜底 | #2d2d30 / #262629 / #3a3a3e | #0c0c0c / #0e0e0e / #111111 | 与半透明版视觉一致 |

**标题栏**：`.dark .window-title` 白 5% → **4.5%**，在外壳 #0C0C0C 上合成后正好是 **#171717**（实测 22/255）。
标题栏落在基色实色上，是材质分区不是分隔线，仍然没有底框。

**窗口边缘补偿**：表面合成值从 34 降到 13，顶部 `inset 0 1px 0` 高光相应从 白 6%/10% 提到 **12%/18%**
（非活动/活动），实测顶边像素 65/255。浮层 8% → 12%，卡片 5% → 8%。
侧边与底边仍靠明度差，不使用 `border`。

**桌面环境光必须压低（本次发现的硬约束）**：表面变暗后，桌面装饰球 `rgba(255,255,255,0.06)`
合成后桌面右上角达 12/255，与窗口 13 几乎重合——窗口在光晕区域内整体消失。
限定环境光合成值低于窗口外壳：径向渐变 5% → **3%**，装饰球 6%/1.5% → **2.2%/0.6%**，内阴影 3% → 1.2%。
压低后实测桌面全域 0—5/255，窗口 13—15，差值 8—13，边界重新可辨。
此约束已写入 DESIGN_SYSTEM.md 第 3.2 节"桌面环境光上限"。

**实测**（Playwright 截图后逐像素采样，`docs/snapshots/2026-09-10-dark-171717-50.png`）：
桌面 0—5 / 窗口 13—20 / 标题栏 22 / 顶栏 17 / Dock 18 / 窗口顶边高光 65。
`npm run build` 通过、`npm test` 2/2 通过。

## 2026-09-10：深色主题改用深灰磨砂玻璃（桌面仍纯黑）

用户拍板"可以用深灰色磨砂玻璃，顶部标题栏也是一样"，替代上一轮的"纯黑 + 白色 inset 高光"方案。

**动机**：上一轮为了让窗口在纯黑桌面上可见，把 surface 做成极淡白色叠加（#0A0A0A/#171717/#121212），
本质仍是"黑上加白"，材质发灰发脏，且靠 inset 白环描边——离"禁止发丝线框"的边界很近，属于擦边。
深灰磨砂玻璃是正解：用明度差建立层级，不需要任何描边。

**深色 token 重写**（`src/styles.css` `.dark`）：
- `--surface`（窗口外壳）`rgba(45,45,48,0.76)` ← 原 `rgba(255,255,255,0.04)`
- `--content`（内容区）`rgba(38,38,41,0.94)` ← 原 `rgba(255,255,255,0.09)`
- `--sunken`（凹槽）`rgba(0,0,0,0.22)` ← 原 `rgba(255,255,255,0.02)`
- `--bar`（顶栏/Dock）`rgba(58,58,62,0.72)` ← 原 `rgba(255,255,255,0.07)`
- `.opaque.dark` 实色版 `#2d2d30 / #262629 / #3a3a3e`
- 桌面底色**保持纯黑** `linear-gradient(130deg, #000000, #000000)`，不做改动

**窗口边缘**：`inset 0 0 0 1px` 白环降级为**仅顶部一条高光** `inset 0 1px 0 rgba(255,255,255,0.06)`
（活动窗口 0.1），外阴影 `0 18px 46px rgba(0,0,0,0.7)` / 活动 `0 24px 60px rgba(0,0,0,0.85)`。
窗口可见性现在由"深灰玻璃 ↔ 纯黑桌面"的明度差承担，inset 只做材质高光，不再是边界手段。

**顶部标题栏**：加 `background: rgba(0,0,0,0.035)`（深色 `rgba(255,255,255,0.05)`），
在窗口外壳基础上形成材质分区——是明度差，不是分隔线，仍然没有底框。

**层级阶梯**（DESIGN_SYSTEM.md 3.2 节"纯黑桌面的边界处理"）：
桌面 #000000 → 内容区 #262629 → 窗口外壳 #2D2D30 → 卡片/浮层 #333336 → 顶栏与 Dock #3A3A3E。
DESIGN_SYSTEM.md 第 3 节深色列、第 4 节玻璃材质表 M0—M3 同步改为深灰值。

实测（Playwright 读计算样式）：body `rgb(0,0,0)`；`.window` bg `rgba(45,45,48,0.76)` +
`blur(34px) saturate(1.8)` + `rgba(255,255,255,0.06) 0 1px 0 inset`；`.window.active` inset 提到 0.1；
`.window-title` bg `rgba(255,255,255,0.05)`；Dock `rgba(58,58,62,0.72) blur(44px)`；
顶栏 `rgba(58,58,62,0.72) blur(40px)`。

视觉验证：`docs/snapshots/2026-09-10-dark-gray-glass.png`。`npm run build` 通过、`npm test` 2/2 通过。

## 2026-09-10：字体统一为 macOS 系统字体；深色主题改为纯黑

按用户"字体也统一，不要那么粗，按 mac 系统的字体来做；深色为纯黑色，不要灰色"指示。

**字体栈**：`:root` font-family 从 `system-ui, "PingFang SC", "Microsoft YaHei"` 改为
`-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`。
macOS Chrome 解析为 SF Pro（实测 family 第一项 `-apple-system`），Windows 落到 YaHei UI。
开启 `-webkit-font-smoothing: antialiased` 避免深色背景下中文字重被渲染得更粗。

**字重全面降档**：之前 `h1/区域标题/窗口标题 600`，`strong/h2/h3 默认 bold(700)`——浏览器默认把 `<strong>` 加到 700，在系统字体下视觉过粗。
- 新增全局 `h1/h2/h3/h4/strong/b { font-weight: 500 }`，避免浏览器默认 700
- `h1`：600 → 500，加 `letter-spacing: -0.02em`
- `h3`：默认 bold → 500
- `.desktop-brand` 65px 大字：600 → 400（Apple 官网 hero 用 Regular，大字号本身就够重）
- `.eyebrow`：600 → 400
- `.section-title`：600 → 500
- `.adobe`（Ps/Ai 文字块）：600 → 500
- 按钮、导航、次级说明统一 400（macOS 系统按钮用 Regular，不加粗）
- DESIGN_SYSTEM.md 第 5 节同步重写表格

实测：`getComputedStyle(h1).fontWeight === "500"`、`strong === "500"`、`brand 65px === "400"`。

**深色主题改为纯黑**：之前用 Apple 系统色 `#1D1D1F / #2C2C2E / #1C1C1E / #161617`，整体发灰。
现在：所有表面 `--surface/--content/--bar` 全部改成 `rgba(0,0,0, *` ；
桌面 `background` 改成纯黑（叠加极淡白色 5% 高光表达层次）；
装饰大球 `.dark::before` 从 `rgba(70,70,74,0.35)` 灰色改成 `rgba(255,255,255,0.06)` 极淡白；
`--text.secondary` 从 `#86868b` 改 `#98989d`（纯黑背景下更可读）；
`.opaque.dark` 全部 `#000000`，仅 `--content #0a0a0a`（1 层极轻层次）；
`.ps / .illustrator` 深色下从 `#1d1d1f / #48484a` 灰块改为 `rgba(255,255,255,0.06)` 与 `rgba(255,255,255,0.12)` 极淡白叠加，不再发灰。
DESIGN_SYSTEM.md 第 3 节深色初始值、第 4 节玻璃材质表同步改为"纯黑"，并显式加约束：
> 深色主题使用**纯黑**，不使用 #1D1D1F、#2C2C2E、#3A3A3C 一类 Apple 深灰。
> 纯黑下不用深灰做层次，层次改由极淡白色叠加（白 5%—12%）与阴影表达，避免整体发灰。

实测深色：`--surface=rgba(0,0,0,0.72)`、`--content=rgba(0,0,0,0.9)`、`--bar=rgba(0,0,0,0.6)`、`body.background=#000`。

**视觉验证**：docs/snapshots/2026-09-10-{typography-light, pure-black-dark}.png。
`npm run build` 通过、`npm test` 2/2 通过。

### 修复：纯黑主题下窗口边界消失

用户反馈"窗口框看不到了"。原因：上一轮把深色 surface 改成 `rgba(0,0,0,0.72)` 在纯黑桌面上接近不可见，
且 `border-radius: 16px` 加深色黑色阴影在纯黑背景下完全失效，窗口和桌面融为一体。

修复（仍然不用 `border` 描边、不破坏"禁发丝线框"原则）：
- 深色 token 改为极淡白色叠加，让层次浮起来：
  - `--surface` (窗口外壳) `rgba(255,255,255,0.04)` ≈ #0A0A0A
  - `--content` (内容/卡片) `rgba(255,255,255,0.09)` ≈ #171717（更亮，靠 surface 衬）
  - `--sunken` `rgba(255,255,255,0.02)`
  - `--bar` (顶栏/Dock) `rgba(255,255,255,0.07)` ≈ #121212
  - `.opaque.dark` 实色版 `#0a0a0a / #171717 / #121212`
- `.dark .window` 加 `inset 0 0 0 1px` 极淡白内高光表达边缘（非活动 0.07，活动 0.14），同时加重外阴影到 `0 18px 46px / 0 24px 60px` —— `inset` 是内阴影技术，不是描边，符合"禁发丝线框"
- `.dark .ai-panel / .search-panel / .context-menu / .app-card / .connection-card` 同样加 inset 高光
- DESIGN_SYSTEM.md 第 3.2 节追加"纯黑主题例外"段落：纯黑下黑色阴影失效时允许 inset 内高光与明度差建立边界，但仅限纯黑主题，浅色不得引入

实测：`.dark .window` inset `rgba(255,255,255,0.07) 0 0 0 1px inset` + 外阴影 `rgba(0,0,0,0.72) 0 18px 46px`；
`.dark .window.active` inset `rgba(255,255,255,0.14)` + 外阴影 `0.85 / 0 24px 60px`；Dock 与顶栏 `rgba(255,255,255,0.07)` 可见。

视觉验证：docs/snapshots/2026-09-10-pure-black-dark-bordered.png 显示应用中心、文件夹窗口、Dock、顶栏在大字标题旁都清晰可见，活动窗口聚焦层级通过更亮的内高光表达。
`npm run build` 通过、`npm test` 2/2 通过。

## 2026-09-10：系统图标替换为本机 macOS 原生图标 + Dock 交互动态

按用户"用 mac 原生图标，不要自己画，加交互动态"指示。

**图标资源来源**：从本机 macOS 26 Tahoe 系统 app 包内提取原生 .icns，通过 iconutil + sips 转为 256x256 PNG，存到 `public/icons/`。共 9 个映射：

| OpenArc 应用 | macOS 原生 | 来源 |
| --- | --- | --- |
| 应用中心 | **Apps.app** | macOS Tahoe 替代 Launchpad 的 Launchpad |
| 浏览器 | **Safari** | /Applications/Safari.app |
| 文件 | **Finder** | /System/Library/CoreServices/Finder.app |
| 无限画布 | **Freeform** | /System/Applications/Freeform.app |
| Skill 中心 | **Shortcuts** | /System/Applications/Shortcuts.app |
| 系统设置 | **System Settings** | /System/Applications/System Settings.app |
| 全局 AI | **Siri** | /System/Applications/Siri.app |
| 全局搜索 | **Spotlight** | /System/Library/CoreServices/Spotlight.app |
| 桌面文件夹 | **GenericFolderIcon** | CoreTypes.bundle |

不使用外部来源（macosicons.com 已有 CDN，但作者为社区上传、GitHub raw 不通、tarball 体积过大；本机提取更快、更可靠、无第三方许可纠纷）。
提取流程沉淀到 .workbuddy/memory/2026-09-10.md，可复用于后续 macOS 版本升级。

**实现**：`src/main.tsx` 移除 lucide-react 的 Globe/Sparkles/Grid2X2/Folder/Search/Layers/Puzzle/Grid2X2 与 LucideIcon 类型导入（保留 X/Minus/Maximize2/ArrowLeft/ArrowRight/RotateCw/Monitor 用于窗口与浏览器导航）；新增 `icon(name)` 助手读取 `./icons/{name}.png`；`apps` 数组的 icon 字段从组件改为字符串；桌面文件夹、空内容占位、浏览器占位、顶栏 AI/搜索、assistant-pill、AI 面板、Dock、搜索结果全部改用 img。
`src/styles.css`：`.app-icon` 从彩色渐变容器改为 47x47 object-fit:contain 的 img（macOS 原生图标自带圆角与阴影，无需装饰）；删除 `.blue/.purple/.orange/.gray/.ai` 五个系统颜色类；`.folder-icon` → `.desktop-folder-icon`；`.large-icon` 与 `.ai-orb` 改为 img；新增 `.viewport-icon / .bar-icon / .pill-icon / .heading-icon / .search-icon / .result-icon` 六类小图标尺寸。

**Dock 交互动态**（macOS 风格）：
- **距离驱动波浪放大**：pointermove 监听 dock 容器，按每个图标中心到鼠标 x 的距离计算 smoothstep 放大倍数（最大 1.62x，相邻 1.35x，再远 1.01x 递减），写入 `--s` CSS 变量；`transform-origin: bottom center` 让放大时向上抬起。实测 hover 第二个图标时 scales = [1.012, 1.348, 1.620, 1.348, 1.012, 1.000, 1.000]。
- **应用名 tooltip**：玻璃磨砂气泡，绝对定位于 dock-item 上方，hover/focus-visible 浮现。
- **点击弹跳**：`@keyframes dock-bounce` 760ms 七关键帧（落地-26px-落地-13px-落地-5px-落地），macOS Dock 经典 bounce 节奏；在 `open()` 与 AI 按钮里调用 `bounce(id)`，state 760ms 后自动清除。
- **减少动态效果**：CSS `--quick` 在 `.reduced` 下被设为 0ms；同时 dock 缩放 effect 在 reduced 模式下不写 `--s`，全部归 1。

**视觉验证**：docs/snapshots/2026-09-10-{macos-icons-light,dock-hover,macos-icons-dark}.png 通过 Playwright 截图。`npm run build` 通过、`npm test` 2/2 通过。
**与"黑白灰"原则的冲突**：macOS 原生图标本身是彩色的（Safari 蓝罗盘、Finder 蓝白脸、Freeform 紫粉、Shortcuts 紫立方、Siri 紫粉）。这与 DESIGN_SYSTEM.md 0.2"以黑白灰为主、不要蓝色"的明确要求相悖。本次按"mac 原生"指示优先完成。
后续若想恢复黑白灰一致性，有两条路：(a) `.app-icon / .dock-icon` 加 `filter: grayscale(1) saturate(0.6)` 把彩度降下来；(b) 用 macOS Sonoma 风格的"单色填充"图标（GitHub `elrumo/macOS_Big_Sur_icons_replacements` 仓库有部分单色变体）。等用户决定。

## 2026-09-10：磨砂玻璃质感、窗口透明度、桌面文件夹

按用户反馈将桌面外壳的玻璃感做到位，同时让窗口更透、去掉标题栏底框、并把"桌面创建文件夹"做成真实可用的功能。

**Electron 层**：`electron/main.cjs` 根据平台启用原生玻璃背景：macOS `transparent: true` + `vibrancy: "under-window"`，Windows 11 `backgroundMaterial: "mica"`，`backgroundColor` 设为透明。配合 `<body>` 的兜底色使 WebContentsView 在原生玻璃不可用时仍呈中性灰。
标注：原生玻璃 + WebContentsView 的合成需在真机 macOS/Windows 上 D1-01 验证；目前 sandbox 缺 Electron 二进制，未实机验证。

**样式层**：`src/styles.css` 全量上调玻璃参数：窗口 `--surface` 透明度从 0.86→0.68、顶栏 0.72→0.58、`--bar` 0.66、`backdrop-filter` 从 22px 升至 34–44px 并加 `saturate(180%)`；桌面壁纸渐变改 rgba 让毛玻璃透出；窗口标题栏去掉 `var(--sunken)` 底框，与窗口体融为一体；新增 `--failed` 状态色。

**功能层**：`src/main.tsx` 重构窗口系统支持多实例：把 `Win.id` 从 `AppId` 扩到 `string`，新增 `FOLDER_PREFIX = "folder:"`、`folderOf / titleOf / iconOf` 辅助，新增桌面右键菜单与文件夹右键菜单、新建/重命名/删除/拖拽/打开/持久化（localStorage `oa-folders`）；窗口标题和图标都改为基于 `titleOf/iconOf` 计算，让任意实例有正确显示。文件夹窗口内容显示"暂无内容"占位并说明文件服务属于 D3 范围，不显示模拟文件。

**视觉验证**：`docs/snapshots/2026-09-10-{light,dark}-glass-folders.png` 与 `...-folder-window.png` 通过 Playwright + 本地 chromium 截图。`npm run build` 通过、`npm test` 2/2 通过。
实测：`getComputedStyle(.window).backdropFilter === "blur(34px) saturate(1.8)"`、`backgroundColor === "rgba(255,255,255,0.68)"`、`.window-title` background 为透明；右键桌面创建文件夹 → 输入名称 → Enter 确认 → 双击打开窗口 → 持久化通过 reload 验证。

## 2026-09-10：色彩体系改为中性灰阶单色

将 DESIGN_SYSTEM.md 0.2 修订为"以黑白灰为主"的色彩方向，参照 Apple 官网做法。
删除 accent 蓝色及所有彩色品牌强调；禁止发丝线框作为分层手段；红、绿、琥珀收敛为极少数语义色并列入白名单。
新增第 3.1 节"色彩使用边界"与第 3.2 节"禁止发丝线框"，并在验收表加入 DS-A09。
同步改写 src/styles.css：:root 与 .dark 变量全部中性化（Apple 官网常用灰阶 + Apple 系统色近似值）；
去除窗口、面板、菜单、徽章、卡片、Dock、顶栏、设置项、AI 面板、搜索面板的装饰性 1px 描边，改用背景明度差 + 阴影 + 间距分层；
应用图标、AI orb、Adobe 入口、桌面装饰球、搜索遮罩、连接卡片按钮全部去彩，主按钮改为近黑/近白实心底；
修复 .dark::before 选择器（之前误写为后代选择器 `.dark .desktop:before`，因 .dark 与 .desktop 是同元素而永不匹配）。
视觉验证：构建后通过 Playwright 截图 docs/snapshots/2026-09-10-light.png 与 ...-dark.png 确认浅深双主题符合预期。

## 2026-09-10：设计规范与实施授权

新增 DESIGN_SYSTEM.md 与 MOTION_SYSTEM.md，分别定义全局设计语言和可中断交互动效，已纳入 PLAN.md 第 42 节及 DS/MS 验收。用户授权按计划实施，进入 D1 技术验证；文档规范不代表实际功能已通过。

## 2026-09-09：从模块计划细化到任务与验收

用户反馈：上一版 PLAN.md 仍不够详细，模块清单不足以直接执行。

本次调整：保留已确认产品范围，补充具体页面操作与状态、身份与设备流程、权限和执行边界、任务 ID 与前置关系、32 项场景验收、发布恢复及需求追溯。明确一条真实工具冒烟不等于首版验收，Photoshop 与 Illustrator 必须分别验证。

防再犯规则：今后计划交付逐项写明负责人、依赖、交付物、通过条件与证据，明确待验证提案和已验证事实；主代理审查时检查需求追溯，不以篇幅或模块数量代替可执行性。

实施状态：本次仅修订文档，未安装依赖、未编码、未连接任何真实应用。

用户追加重点：整个软件架构与 AI 闭环。补充进程和服务边界、单机与局域网部署、唯一调度权威、产物验证、预算与有界纠错、记忆范围、三张图及两个端到端实例；验收增至 38 项。
