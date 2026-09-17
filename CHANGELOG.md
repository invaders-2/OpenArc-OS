# 计划修订记录

## 2026-09-17（十九）：光标缩小 + 全用自绘 + 设置里的「光标」两行

用户口径（三条一起做）：
1. 光标太大，要小一点。
2. app 内所有光标都用我们自己内置的，不要再出现系统光标 —— 凡是 CSS 能控制的地方一律命中自绘 SVG。
3. 设置「外观与交互」栏加「光标」设置：药丸开关（开/关）+ 光标大小调节。

### 改了什么

- **全部改成运行时 data URL 的 CSS 变量**（新增 `src/desktop/cursors.ts`）：
  `public/cursors/*.svg` 仍是唯一来源，用 Vite 的 `?raw` 把源文件内联进 bundle
  （CSP 是 `connect-src 'none'`，不能在运行时 fetch），按 size 改写 SVG 的 width/height，
  并按 size/32 同步缩放热点，生成 `data:image/svg+xml,…` 写到根上的
  `--cursor-arrow / --cursor-text / --cursor-resize-se / --cursor-crosshair / --cursor-grab /
  --cursor-not-allowed / --cursor-copy / --cursor-pointer`。理由：CSS 的 cursor 没有尺寸参数，
  "大小"和"开关"都只能在运行时重组这条声明。
- **CSS 只负责"哪个元素用哪个变量"**（`src/styles.css` / `primitives.css`），每条都保留关键字兜底
  （`var(--cursor-resize-se, nwse-resize)` 这种）。等价于一个总开关：变量写成 data URL 就是自绘，
  写成关键字就是系统光标。
  - 文本 / 可编辑区从**系统 text** 换成自绘 `text-*.svg`（本轮重点口径）。
  - `a[href] / [role="link"]` 从系统 pointer 换成自绘手型（新增 `--cursor-pointer`；不在用户列的
    变量清单里，但不加就会在链接上漏出系统手型）。
  - 非文本表单控件在原有 range / file / checkbox / radio / color 上**补 select**（Chromium 的 UA
    样式会盖过继承）。
  - 探针抓到一个真实漏点：Chromium 的 UA 样式给 `<label>` 声明了 `cursor:default`，
    文件窗口的 `label.search-field`（含它的 svg/circle/path，共 4 个元素）因此漏出系统箭头。
    加 `label { cursor: inherit; }` 修掉。
- **设置两行**（`src/main.tsx`，appearance 分支，照现有 Switch / setting-range 写法）：
  - 「使用自绘光标」药丸开关：关掉后整套变量写成关键字，全部退回系统光标。
  - 「光标大小」滑块 16–40px，默认 **18px**；**关闭时禁用（变暗）而不是隐藏** —— 保留位置、不产生
    布局跳动，并明确表达"该设置当前不可用"。
  - 持久化沿用 `oa-` 前缀 localStorage：`oa-cursor-custom` / `oa-cursor-size`，重启后仍生效。

### 尺寸是怎么定的（先量系统箭头）

用**一次性**全屏纯色背板（#808080，拍完即退）+ cliclick 移指针 + screencapture -C（含光标）与
无光标帧做差集，量系统箭头在 2× Retina 下的实际足印：

| 阈值 | 系统箭头足印（设备像素） | CSS 像素 |
|---|---|---|
| ≥48（实体） | 21×34 | 10.5×17 |
| ≥16 | 22×37 | 11×18.5 |
| ≥6（含 1px 阴影） | 25×38 | 12.5×19 |

自绘箭头（从**生产构建**里读出的真实 data URL）同法实测，并用无头 SVG 解码复核：

| 档位 | screencapture 足印 | 无头 SVG 解码（实体） | CSS 像素 |
|---|---|---|---|
| 默认 18px | 34×34 设备 | 17×17 | 17×17 |
| 20px | 38×38 设备 | 19×19 | 19×19 |
| 40px | 76×76 设备 | 38×38 | 38×38 |
| 旧 32px（改前） | 61×61 设备 | — | 30.5×30.5 |

→ 默认 18px 的足印（17 CSS）与系统箭头实体高度（17 CSS）齐平、略小于其含阴影足印（19 CSS），
线性尺寸只有旧值的约 56%。I 型（text@18）实测 12×29 设备 = 6×14.5 CSS，无头解码实体 6×16；
热点取竖笔中点略偏上（16,15 / 32 网格 → 18px 时 9,8），实测热点比字形中心高 1 CSS 像素。
其它热点（18px）：箭头 1,1；缩放 9,9；十字 9,9；握紧手 9,10；禁止 1,1；拷贝 1,1；手型指尖 6,3。

### 无系统光标 · 探针清单（无头：mock 桥 + 本地静态服务跑生产构建）

开关打开时，遍历全部元素，computed cursor 不以 `url(` 开头的一律列出 —— **清单为空**：

| 状态 | 元素总数 | 命中自绘 url( | 漏出系统光标 |
|---|---|---|---|
| 桌面 | 169 | 169 | 0 |
| 设置窗口 | 262 | 262 | 0 |
| 文件窗口 | 373 | 373 | 0 |
| AI 面板 | 403 | 403 | 0 |
| 右键菜单 | 380 | 380 | 0 |
| 删除确认对话框 | 387 | 387 | 0 |

开关关闭后，同一份清单 url( 命中 **0**，全部是系统关键字：default（大多数）、
nwse-resize（3 个缩放手柄）、text（1–2 个文本输入）；「光标大小」滑块 disabled=true。
再打开又全部回到 data URL。

### 持久化实测

用**无窗口**持久化 profile 跑生产构建：设成 `oa-cursor-custom=false` / `oa-cursor-size=40`，
**关掉进程再重开** →
before {custom:"false", size:"40"} / after {custom:"false", size:"40", --cursor-arrow="default",
root cursor="default"}。两个值都留在磁盘 profile 里，重开后仍生效（关闭态下根光标就是关键字 default）。

### 门禁

`npx tsc --noEmit` clean、`npm test` 96/96；`npx vite build` 通过（?raw 从 public/ 内联，
不产生额外产物）。

### 不能控制的两处（如实说明）

- **拖到系统**：把文件从 app 里 ⌘ 拖到 Finder / 桌面时，那一帧的拖拽光标由 macOS / Electron 画，
  不走 CSS。
- **原生网页视图里的第三方页面**：浏览器 App 用 WebContentsView，里面站点的光标由该页面自己的
  CSS 决定，我们控制不到。

### 实测截图

- 设置两行（生产构建、无头实拍）：/tmp/oa-probe/cursor-headless/settings-cursor-light-on.png、
  …-dark-on.png、…-light-off.png（关闭态滑块变暗）。
- 系统箭头 + 18/20/40 + I 型并排：/tmp/oa-cursor-probe/cursor-compare.png。
- 开/关两种状态的真实 screencapture -C：/tmp/oa-cursor-probe/cursor-onoff-compare.png
  （原始帧 cursor-on-arrow18-with.png、cursor-off-default-with.png、cursor-on-text18-with.png）。
- 探针原始报告：/tmp/oa-probe/cursor-headless/report.json。

### 说明

- 早前一轮曾在 `npm run dev:app` 上取过 computed cursor / 尺寸结论；按用户口径"实时预览影响正常用机"，
  该实例已停用。上面的清单与尺寸已改用**无窗口无头探针**（mock 桥 + 本地静态服务 + 生产构建）重跑，
  像素证据用**一次性**背板（拍完即退，独立 userData）。当前无任何残留 vite / Electron 进程。

## 2026-09-17（十八）：实时更新预览（`npm run dev:app`）

用户口径：「改代码后 app 窗口自己就更新，不用每次重新构建 + 重启。」

### 做了什么

- `scripts/dev-app.mjs` + `npm run dev:app`：一条命令起 Vite dev server，并用**仓库里的**
  Electron（`node_modules/electron`，44.3.0）打开它。Ctrl+C 同时收掉 Vite 与 Electron 两个进程组。
- userData 默认隔离到 `~/Library/Application Support/openarc-os-preview`（产品是 `openarc-os`），
  可用 `--user-data` 换；`--port` / `--no-watch` 见脚本头注释，其余参数原样转给 Electron。
- `electron/main.cjs`：**只在显式设了 `OA_DEV_SERVER` 时**把 `uiURL` 指向 dev server；
  信任判据 `trusted()`、`will-navigate`、麦克风 `isAppPage()` 同步按 dev 来源放行。
  没设变量时 `devURL` / `devOrigin` 恒为 `null`，所有分支原样短路 —— 产品路径逐字节不变。
- `vite.config.ts`（三个 dev-only 插件，`vite build` 一个都不执行）：
  - `devCsp()`：把 dev 下 index.html 的 CSP 放宽到 `script-src 'self' 'unsafe-inline'`、
    `connect-src 'self' ws://127.0.0.1:*`（React Refresh 内联脚本 + HMR WebSocket）。
  - `devCjs()`：渲染层从 electron/ 直接 import 的 `.cjs` 领域模块，dev 下用 esbuild 打成 ESM
    （不这么做会 "does not provide an export named 'default'"，已实测）。
  - `react()`（`@vitejs/plugin-react`，**只在 serve 挂**）：真 Fast Refresh；build 路径不挂，产物不动。
- 主进程没有 HMR：`scripts/dev-app.mjs` 监听 `electron/`，改动后**等旧进程真正退出**再重启 Electron
  （同一 userData 不能两个实例同开），`src/` 的 HMR 不受影响。

### 实测（macOS 26.6.2 / Electron 44.3.0 / Vite 7.3.6，真实窗口 + CDP 截图）

- 改 `src/styles.css` 的 `.auth-card` 圆角（16px → 48px）：3 次 **30 / 33 / 193 ms（中位 33 ms）**。
  同窗口前/后截图：`/tmp/oa-hmr/css-card-before.png`、`/tmp/oa-hmr/css-card-after.png`
  （整窗 `css-before.png` / `css-after.png`）。
- 改 `src/identity/AuthScreens.tsx` 一句文案（React Fast Refresh，文档未重载）：3 次
  **81 / 145 / 147 ms（中位 145 ms）**；截图 `/tmp/oa-hmr/tsx-card-before.png`、`/tmp/oa-hmr/tsx-card-after.png`。
- dev 下能力：`window.openarc` 在；`files.list("desktop")`、`sync({intents:[]})` 走桥成功
  （说明 `trusted()` 已按 dev 来源放行）；自绘光标 =
  `url("http://127.0.0.1:5173/cursors/arrow-light.svg") 2 2, default`。
- 主进程自动重启：改 `electron/` 后打印「自动重启主进程」，Vite 仍 200、新窗口重新加载 dev URL（两次触发都验过）。
- 产品路径：`npm run oa:app -- HEAD --no-restart` 构建成功；`dist/index.html` 的 CSP 与 HEAD 干净构建
  **逐字节相同**（两边都是 `default-src 'self'; script-src 'self'; … connect-src 'none'`），
  index.html 唯一差异是 hash 化的资源文件名（来自本轮其它源改动）。
- 门禁：`npx tsc --noEmit` clean、`npm test` 96/96。

### 边界（哪些改动需要重启）

- `src/**`：不重启，HMR 毫秒级（CSS ≈30ms、TSX ≈145ms）。
- `electron/**`：自动重启主进程（约 1–2s）。
- `index.html` / `vite.config.ts`：需要重启 `dev:app`（dev CSP 与页面加载方式在这里）。
- 依赖变化：需要 `npm install` 后重启。

### 依赖新增

`@vitejs/plugin-react@^5.2.0`（devDependency；只在 `vite dev` 挂，生产构建不引用）。

## 2026-09-17（十七）：身份库打不开导致整片空白 —— 改成「初始化失败 + 原因 + 重试」

**现象**：启动时身份库拒绝打开，应用窗口正常出现（菜单栏 / 红绿灯都在），但渲染层整片空白 ——
顶部栏、程序坞、任何提示都没有。用户看到的等价于「软件坏了」。

**根因**：`electron/identity-store.cjs` 的 `#migrate` 在 `schema_version=2 > 1` 时抛错，
经 `createIdentityService`（`identity-bootstrap.cjs:30`）冒到 `electron/main.cjs` 的
`app.whenReady().then(...)` 回调里。回调是**同步**的，异常变成**未处理的 Promise rejection**，
并在 `win.loadURL(uiURL)` **之前**中断 —— 窗口创建了，页面永远没加载。
这不是「加载慢」，是**启动失败没有出口**：主进程没有 catch，渲染层也没有收到任何失败信号。

**改法**（只补这一条路，不动用户数据）：

- `electron/main.cjs`：
  - `createIdentityService` 用 `try/catch` 兜住；失败原因登记到**已有的**身份命令通道 ——
    下面的 `registerIdentityIpc` 照常装配，把 `{ ok:false, error:"BOOT_FAILED", detail } ` 交回渲染层。
    catch 之后装配继续走完（文件服务 / 原生视图 / `win.loadURL` 都照常），界面因此正常加载。
  - `app.whenReady().then(...)` 整链再加 `.catch(recoverFromStartupFailure)`：
    其它启动期 rejection（safeStorage / 钥匙串被拒、其它装配异常）走同一条出口，不再白屏。
  - `describeStartupFailure` 把结构化原因翻成人话；schema 过新时**不迁移、不降级、不重置**，
    只说清楚「本机数据未被改动」。
- `electron/identity-bootstrap.cjs`：`registerIdentityIpc` 支持 `bootError`；
  `service` 为空且有 `bootError` 时返回 `BOOT_FAILED`，没有时维持原来的 `INTERNAL_ERROR/identity-not-ready`；
  事件订阅加 `send && service` 守卫（service 为空时不再对 null 调 `onEvent`）。
- `electron/identity-store.cjs`：schema 过高改成结构化 `SchemaTooNewError`（`code=SCHEMA_TOO_NEW`、
  `found/supported`），异常原文不变；主进程不必猜文本。
- `src/identity/useIdentity.ts`：启动询问 `identity/status` 返回 `!ok` 时（含 `BOOT_FAILED`）
  走已有的 `bootError → BootRetry`，**不再往下落到登录页**；启动询问本身 reject（主进程没响应 / 握手被拒）
  也兜到 `bootError` —— 原来 `finally` 会清掉超时计时器，导致永久停在 BootSurface（同样是一片空白）。

**实测**（探针 `/tmp/oa-probe/probe`，真实 Electron + 产品 `electron/main.cjs`；
临时 userData + 预置一份 `user_version=2` 的 identity.db 复现，`OA_PROBE_ROOT` 指向 HEAD 版 electron 做对照）：

- 修复前（HEAD=ff86248）失败注入：`UnhandledPromiseRejectionWarning: 身份库 schema_version=2 …`
  抛在 `identity-store #migrate` → `main.cjs:185`；DOM 无 `.desktop`、`capturePage` 尺寸 `0x0`（全白）——
  `/tmp/oa-probe/shots/boot-failure-before.png`（0 字节）、`/tmp/oa-probe/logs/before.log`。
- 修复后同一注入：`gate=checking`、`[data-d3-id="boot-retry"]` 在、`[boot-surface]` 不在，
  文案 = 「本机身份库版本（schema 2）高于当前程序支持的版本（1），这个构建打不开它。本机数据未被改动。」
  并有「重试」按钮；截图 `/tmp/oa-probe/shots/boot-failure.png`（capturePage 全窗）、
  `boot-failure-center.png`（放大）、`boot-failure-screen.png`（`screencapture` 实拍，含原生红绿灯）。
- 正常路径：空 userData 启动 `gate=uninitialized`，照常进入初始化界面，截图 `/tmp/oa-probe/shots/boot-normal.png`。
- 真实用户数据 `~/Library/Application Support/openarc-os/identity.db` **未被读写**（探针全程用临时目录；
  sha256 前后一致：`d4d6bb6c…`）。

**补充（同日 · 父级验收）**：启动失败界面的对比度 —— 浅色主题下「重试」几乎不可见。

- 现象：BootRetry 直接压在桌面基底上（内置壁纸默认 `theme-dark` = `#171717`，**不随主题变**），
  而全局 `.control-button` 是 `--sunken` 底 + `--text` 字，浅色主题下就是「深字压深底」。
  实测浅色：按钮文字 / 按钮底 **1.08:1**、说明文字 / 屏底 **3.54:1**；深色主题反而是好的（17.34 / 6.24）。
- 改法：只在 `[data-d3-id="boot-retry"]` 作用域里加一块跟随主题的实底面板
  （`background: rgb(var(--surface-rgb) / 0.96)`），面板内说明文字改用 `--text`、
  按钮改用 `--accent` / `--on-accent` 配对。**没有改 `.control-button` 的全局样式**，
  也没有碰 `[data-d3-id="boot-surface"]`（启动中态）。
- 实测（探针像素级 WCAG，浅 / 深各一组；同一条注入，只替换 dist 的 CSS）：

  | 对比项 | 浅色 改前 | 浅色 改后 | 深色 改前 | 深色 改后 |
  | --- | --- | --- | --- | --- |
  | 按钮文字 vs 按钮底 | 1.08 | 16.83 | 17.34 | 19.29 |
  | 按钮底 vs 所在底 | 1.01 | 15.57 | 1.05 | 16.47 |
  | 说明文字 vs 所在底 | 3.54 | 15.57 | 6.24 | 16.47 |

  「所在底」= 元素实际压着的表面（改前 = 壁纸底 `#171717`，改后 = BootRetry 面板）。
  截图：`/tmp/oa-probe/shots/contrast-{before,after}-light.png`、
  `contrast-{before,after}-dark.png`（各带 `-center` 放大图），日志 `/tmp/oa-probe/logs/contrast-*.log`。

**门禁**：`npx tsc --noEmit` clean、`npm test` 96/96。

## 2026-09-16（十六）：按钮 / 可点条目改成箭头，只有链接保留手型（macOS 规矩）

用户口径：「手型改成箭头（按 macOS 的规矩 —— 按钮显示箭头，只有链接才显示手型）」。

### 清单 · 改前

声明层（改后全没了，只剩给真链接的一条）：
- `src/design-system/tokens.css`：`button { cursor: pointer }`（最广的一条，把手型带给所有 `<button>`）。
- `src/styles.css`：`.control-button`、`.rb-folder-inner`（span）、`input[type="button"/"submit"/"reset"]`。

运行时（探针 `document.querySelectorAll('*')` 筛 `getComputedStyle().cursor === 'pointer'`，浅色，7 个状态）：
- 命中元素数：桌面 116 / 设置窗口 162 / AI 面板 171 / 右键菜单 175 / 对话框 177 / 文件窗口 216。
- 真正的「源头」（父节点不是 pointer 的）约 20 类，其余全是这些控件的后代继承：
  `button.bar-app`、无名 `button`（顶栏 / 分段 / 菜单项）、`span.rb-folder-inner`、`button.assistant-pill`、
  `button.close / .minimize / .maximize`（红绿灯）、`button.split-nav`（侧栏）、`button.app-card`、
  `button.dock-item`（程序坞）、`button.switch`、`label.control-button`、`button.wallpaper-option`、
  `button.control-button`、`button.icon-button`、`button.ghost / .danger / .primary.danger` 等。

### 改了什么

- `button` 的 `cursor` 从 `pointer` 改成 `var(--cursor-arrow)`；`.control-button`、`.rb-folder-inner`、
  `input[type=button/submit/reset]` 同样改成 `var(--cursor-arrow)`。**不再有任何 `cursor: pointer` 声明**
  （除了下一条给真链接的）。
- 新增 `a[href], [role="link"] { cursor: pointer }` —— 真链接保留手型。仓库里目前没有任何 `<a>` / `[role=link]`，
  所以这条现在没有命中对象，只是把规矩固定下来。
- **「查看统一设置 →」是 `<button>`**（`src/desktop/components.tsx:847`），不是 `<a>`，所以现在显示箭头；
  用户口径允许，这里明确说明。

### 变量作用域 · 谁覆盖谁

- 确认：`main.tsx` 的根 return 就是 `<div class="desktop dark?">`，`BootSurface`（启动）/ `SetupScreen`（初始化）/
  `LoginScreen`（登录）/ `LockScreen`（锁屏）都渲染在它内部 —— 所以它们本来就能拿到自绘箭头。
- 按要求仍把变量提到**真正的根**：`:root { --cursor-arrow: 浅色版; cursor: var(--cursor-arrow); }`。
- 深色覆盖落在**同一个根**上：`:root:has(.dark) { --cursor-arrow: 深色版; }`（`.dark` 挂在 `.desktop` 上，
  `:has()` 反查到 html）。旧 `.desktop` / `.desktop.dark` 的定义删掉。
- 覆盖关系：`:root:has(.dark)`（特指度 0,2,0）> `:root`（0,1,0）；两处都在同一个根上，深色模式不会退回浅色箭头。
- 语义光标仍各自显式声明、优先级更高：文本 `text`、缩放 `resize-se`、框选 `crosshair`、抓取 `grabbing`、
  禁止 `not-allowed`、拷贝 `copy`，以及禁用的 `.traffic button:disabled` / `.ds-btn:disabled` 等。

### 实测

- 探针（改后）：**`pointer` 源头 = 0 个**（仓库里没有真链接）；抽查全部命中自绘箭头：
  `.desktop` / `.window` / `.split-nav` / `.traffic .close|.minimize|.maximize` / `label.control-button` /
  `.wallpaper-option` / `.file-cell` / `.rb-folder-inner` / `.context-menu button` / `.dialog-footer button`
  = `url("…/cursors/arrow-light.svg") 2 2, default`（深色为 `arrow-dark.svg`）；
  `.window .resize` = `resize-se-light.svg`；`.search-input input` 与设置里的文本输入 = `text`；
  临时注入 `a[href]` / `[role="link"]` = `pointer`。
- 真实 Electron 实拍（`screencapture -C`，抢回前台 + 校验落点后拍）：程序坞图标、侧栏导航项、窗口红绿灯、
  对话框按钮（浅色）+ 深色程序坞 / 对话框：`/tmp/oa-probe/ptr-{dock,sidebar,traffic,dialog}-{light,dark}.png`，
  合成图 `/tmp/oa-probe/pointer-states-composite.png` —— 全部是自绘箭头（浅色黑、深色白），没有手型。

### 门禁

`npx tsc --noEmit` clean、`npm test` 96/96。

### 没做

- 文本 I 型、缩放、框选、抓取、禁止、拷贝一律没动。
## 2026-09-16（十五）：其余光标全部改成同一套实心圆角风格，凑成一套

用户口径：「深色模式用白、浅色模式用黑这个做法对了，现在要把其余的光标也照这个风格重画，凑成一套」——
之前只有箭头（含 copy / not-allowed 里嵌的那只）是新风格，其余 15 只还是旧的「1px 白/黑描边 + 尖角 +
(0,-1) 阴影副本」，摆在一起不搭。这次只画形状，不接新状态。

### 统一风格（和箭头同一套参数）

- **实心填充**：浅色 `#000000`、深色 `#ffffff`，100% 不透明。
- **描边**：`1px` 的 30% 对比色（浅 `rgba(255,255,255,0.3)` / 深 `rgba(0,0,0,0.3)`），一律
  `paint-order="stroke fill"`（描边压在填充下面，只露外面半条）。
- **没有阴影**：删掉所有 `(0,-1)` 阴影副本（仓库里已 0 命中）。
- **圆角**：线状形状用「粗线 + 圆头圆角」的轮廓，多边形用 Shapely `buffer(r).buffer(-r)` 统一倒圆角，
  转角都是圆角、不留尖角。
- `viewBox="0 0 32 32"` 不变，**文件名一个没改**、**CSS 热点值没动**（resize 16 16、crosshair 16 16、
  grab 16 17、copy / not-allowed 2 2）。

### 各形状怎么重画（语义照旧，只换画风）

- `crosshair`：细而长的实心十字（臂宽 2.4、圆角端），不再是 1px 描线。
- `text`：带衬线端的实心 I 型（顶/底横杠 + 竖笔，圆角）。
- `move`：实心四向箭头（十字 + 四个圆角箭头）。
- `resize-n/s/e/w/ne/nw/se/sw`：实心双向箭头、箭头圆角（n 与 s、e 与 w 本来就是同形的对称双箭头）。
- `pointer` / `open-hand`：**保留原手指轮廓**，只把「描线稿」换成实心 + 淡描边。
- `grab`：拳头实心，三条指缝改成**负空间镂空槽**（`fill-rule="evenodd"` 挖 3 个圆角槽），不靠描边分缝 ——
  1× 下分缝仍然看得见（下方有真实实拍）。
- `copy` / `not-allowed`：徽标（绿加号 / 灰禁止圈）**保留**，继续压在箭头右下；徽标阴影也一并去掉。

### 实测

- **全套对照图**（4×，浅底 / 深底各一张，一眼能看出是一套）：
  `/tmp/oa-probe/compare-light.png`、`/tmp/oa-probe/compare-dark.png`。
- **1× 对照图**（原始 32px 大小；另附最近邻 6× 放大方便看像素）：
  `/tmp/oa-probe/compare-1x-light.png`、`compare-1x-dark.png`，放大 `compare-1x-*-zoom6.png`。
- **徽标对照**：`/tmp/oa-probe/compare-badges.png`（arrow / copy / not-allowed 三只同形状）。
- **真实 Electron 实拍**（`screencapture -C`；先 `osascript` 抢回前台 + 校验指针落点，确认焦点与落点后再拍）：
  缩放手柄 / 框选十字 / 程序坞整理握紧手，浅色与深色主题各一遍，浅色主题 + 默认深壁纸再各一遍：
  `/tmp/oa-probe/state-{resize,crosshair,grab}-{L,D,LDW}.png`，放大 `…-zoom.png`。实测分别是：自绘的
  黑色双向斜箭头（深色主题为白）、细长实心十字、实心拳头带镂空指缝。
- **深壁纸档描边读数**（浅色主题 + 默认深壁纸 `#171717`，背景灰阶 23；把每只经真实 Electron 光标画在深色
  壁纸上量，2× 设备像素灰阶）：`arrow` halo max 89 / median 61（落差 66 / 38）；`crosshair` 93 / 56
  （70 / 33）；`text` 93 / 93（70 / 70）；`move` 93 / 56（70 / 33）；`resize-ne` 93 / 59（70 / 36）；
  `pointer` 93 / 56（70 / 33）；`open-hand` 93 / 76.5（70 / 53.5）；`grab` 93 / 58（70 / 35）。
  轮廓都能读出来（halo 最大 89–93，已接近 0.3 alpha 的理论上限 ≈93）。
- **手型 1× 分缝**（真实实拍放大）：`/tmp/oa-probe/halo-pointer-zoom.png`、`halo-open-hand-zoom.png`、
  `halo-grab-zoom.png` —— 手指轮廓与拳头三条镂空指缝在 1× 下都清楚。

### 门禁

`npx tsc --noEmit` clean、`npm test` 96/96。

### 没做 / 备注

- 手型「要不要在按钮上全局启用」是另一个问题，这次**没动**（只画）。
- 文本框仍用**原生 `text`** 做 I 型；自绘 `text-*.svg` 只进套装、没接进 CSS。
- 本 worktree 的 `node_modules/electron` 的 `dist` 曾丢失，实拍用隔壁 worktree 同版本 Electron 44.3.0 完成，
  仓库不受影响。
## 2026-09-16（十四）：箭头换成实心大圆角样式（+淡描边），并全局启用

用户口径：「箭头光标换成用户指定的这种样式，并且 app 全局都用它」——参考图是**实心、没有白色描边、
顶点大圆角、比 macOS 那只更饱满**的箭头。只重画箭头，其它光标形状先不动。
后续拍板（可见性实测之后）选「方案①」：给箭头补一条**很淡的描边**来救深色背景（详见新增的一条）。

### 改了什么

- **重画箭头** `public/cursors/arrow-light.svg` / `arrow-dark.svg`（`viewBox="0 0 32 32"`、
  `width/height="32"` 不变）：把参考图（512×512 位图）阈值化取轮廓，量出「4 个角 + 1 个凹口」的
  几何——三个外角圆角半径约 16 / 16 / 15.5（512 坐标），凹口很小；用「4 条边线 + 3 个圆角弧 +
  1 个小凹口弧」还原成**一条 `<path>`**。再缩放/平移，让**尖端顶点精确落在 (2,2)**，热点仍是 `2 2`。
  浅色 = 纯黑填充，深色 = 纯白填充，**初始交付两种都不描边、也不加阴影**（与参考图一致）；后来按
  可见性拍板补了淡描边（见下一段）。与参考图位图归一化 IoU = **0.992**（`/tmp/oa-probe/arrow/` 下的分析脚本与渲染对照）。
- **全局应用**（`src/styles.css` 末尾「自绘光标」块）：真正的根是 `.desktop`（`height:100vh`，铺满视口；
  桌面 / 窗口内部 / 侧栏 / 程序坞 / 顶栏 / 弹层全在它里面），所以只在根上设一次 cursor：
  `.desktop { --cursor-arrow: url("/cursors/arrow-light.svg") 2 2, default; cursor: var(--cursor-arrow); }`，
  `.desktop.dark` 把变量换成 `arrow-dark.svg`。**没有**用 `* { cursor }`，也不逐个组件声明。
- 把原先 4 处显式 `cursor: default` 全部换成 `var(--cursor-arrow)`：`.traffic button:disabled`、
  `.icon-button:disabled`、`.desktop-folder`、`.file-cell`（它们本来就显示系统箭头）。
- **显式保住 I 型**：`.desktop textarea`、`[contenteditable="true"]`、以及文本类 `input`（排除
  `range / file / checkbox / radio / button / submit / reset / color`）写 `cursor: text`。选**原生 `text`**
  而不是自绘 `text-*.svg`：原生 I 型在每个 DPI / 缩放下都清晰，位图那根 1px 线在 32 网格里最脆。
  另外，Chromium 的 UA 样式给 `range / file / checkbox` 声明了 `cursor: default`、会盖过继承，
  也一并显式换成 `var(--cursor-arrow)`（按钮类保持 `pointer`，与 `<button>` 一致）。
- **没有改**缩放 / 框选 / 拖拽 / 禁止 / 拷贝这五条语义光标的规则；但把 `copy` / `not-allowed` 两只里嵌的
  底箭头同步成了新形状（见下一条）。
- **同步 `copy` / `not-allowed` 的底箭头**：这两只原来内嵌的是旧尖角箭头，按住 ⌘ 拖拽 / 拖到非法落点时
  箭头会肉眼可见地变回旧版。现在把里面的箭头换成与 `arrow-*` 完全相同的新 path（描边见下一条同步补上），
  **绿加号 / 禁止圈等其余部分原样不动**。两只的放大对照：`/tmp/oa-probe/compare-badges.png`。
- **补一条淡描边**（可见性拍板后的追加改动）：`arrow-light.svg` 黑箭头 + **1px rgba(255,255,255,0.3)**，
  `arrow-dark.svg` 白箭头 + **1px rgba(0,0,0,0.3)**；两者都用 **`paint-order="stroke fill"`**（描边压在填充
  **下面**，只露出外面一半，不会把箭头啃瘦）。**同时同步进 `copy-light/dark`、`not-allowed-light/dark` 里嵌的
  那只箭头**，三只状态切换时形状与描边完全一致（按 ⌘ / 拖到非法落点不会变细）。**最终选 1px**（不是 1.5px）：
  下面实测最亮描边已接近 0.3 alpha 的理论上限，1px 就足够读出轮廓。

### 实测 · 全局生效（`getComputedStyle(el).cursor` 原样字符串）

探针在**真实 Electron 44**（`dist`）与真实 Chromium（`dist` + 静态服务）里各读一遍，浅色 / 深色都命中
我们的 SVG（不是系统关键字）。下表是 Electron 里的实测（`file://` 前缀略为 `…`）：

| 取的元素 | 浅色实测 | 深色实测 |
| --- | --- | --- |
| `.desktop`（桌面 / 根） | `url("…/cursors/arrow-light.svg") 2 2, default` | `url("…/cursors/arrow-dark.svg") 2 2, default` |
| `.topbar`（顶栏） | 同上 `arrow-light` | 同上 `arrow-dark` |
| `.dock`（程序坞） | 同上 `arrow-light` | 同上 `arrow-dark` |
| `.window` / `.window-body`（窗口内部） | 同上 `arrow-light` | 同上 `arrow-dark` |
| `.split-side`（侧栏） | 同上 `arrow-light` | 同上 `arrow-dark` |
| `.dialog` / `.dialog-body`（对话框） | 同上 `arrow-light` | 同上 `arrow-dark` |
| `.window .resize`（缩放手柄） | `url("…/cursors/resize-se-light.svg") 16 16, nwse-resize` | `url("…/cursors/resize-se-dark.svg") 16 16, nwse-resize` |
| `.window input`（文本框） | `text` | `text` |
| 桌面 / 文件区框选 `[data-marquee]` | `url("…/cursors/crosshair-light.svg") 16 16, crosshair` | `…/crosshair-dark.svg` |
| 程序坞整理 `.dock.arranging .dock-item` | `url("…/cursors/grab-light.svg") 16 17, grabbing` | `…/grab-dark.svg` |
| 非法落点 `[data-drop-invalid="1"]` | `url("…/cursors/not-allowed-light.svg") 2 2, not-allowed` | `…/not-allowed-dark.svg` |
| ⌘ 拷贝 `[data-cmd="1"]` | `url("…/cursors/copy-light.svg") 2 2, copy` | `…/copy-dark.svg` |
| `.dock-item` / `.split-nav`（按钮） | `pointer`（手型，见下「保留」） | `pointer` |

### 实测 · 真实 Electron 实拍（`screencapture -C`，光标已拍入）

- 浅色主题桌面：`/tmp/oa-probe/cursor-light-with.png`（放大图 `cursor-light-zoom.png`）。
- 深色主题桌面：`/tmp/oa-probe/cursor-dark-with.png`（放大图 `cursor-dark-zoom.png`）。
- 浅色主题 + 深壁纸（风险态）：`/tmp/oa-probe/cursor-light-darkwp-with.png`（放大图 `cursor-light-darkwp-zoom.png`）。
- 每张都同时拍了「无光标」版（`cursor-<tag>-without.png`）用来定位光标像素。
- 热点落点：实拍反推尖端相对指针的位置为 `(0,-1)`、`(0,-3)`、`(0,0)` 设备像素（2× Retina），
  即**尖端落在热点 ±1.5 CSS px 内**，与 CSS 的 `2 2` 一致。

### 实测 · 深色背景对比度（箭头像素 vs 周围背景，WCAG 相对亮度与对比度）

| 场景 | 箭头像素 RGB | 背景像素 RGB | Δ相对亮度 | WCAG 对比度 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 浅色主题 + 浅壁纸（`#f2f2f4`） | (0, 0, 0) | (244, 242, 242) | 0.8915 | **18.83** | 清晰 |
| 深色主题 + 深壁纸（`#171717`） | (255, 255, 255) | (23, 23, 23) | 0.9914 | **17.93** | 清晰 |
| 浅色主题 + 深壁纸（`#171717`，错配） | (0, 0, 0) | (23, 23, 23) | 0.0086 | **1.17** | **几乎不可见** |

> 注意：app 的默认壁纸就是 `theme-dark`（`#171717`），系统浅色时默认走到第三行——黑箭头压在深色桌面上
> 对比度只有 1.17，这是真实风险，不是假想。**后来用户拍板选「方案①」给箭头加了淡描边**，重测见下。
- 同一张实拍（`cursor-light-darkwp-with.png`）的局部分辨率数据（2× Retina，单位为设备像素灰阶）：
  光标足印 **61×61 px / 1468 像素**；实心区（腐蚀后深核 1001 px）灰阶 **0**，周围背景均匀 **23**，
  原差 **23 / 255（≈9%）**；箭头**最亮像素 16**，其周围 **8 邻域平均 12.88**，差 **3.12**；
  足印内单点相对自身 8 邻域平均的**最大局部分差 9.25**（出现在边缘）；足印内 **1468/1468（100%）**
  像素比背景暗 ≥1 灰阶、**1369/1468（93.3%）** 暗 ≥20 灰阶；足印内出现的灰阶为 **0–16（共 17 级）**。
- **加淡描边后的重测**（浅色主题 + 深壁纸，`cursor-s-light-darkwp-with2.png`，2× Retina 设备像素灰阶）：
  沿箭头轮廓共 **298** 个描边像素；灰阶 min **26** / max **89** / median **61**（背景 23）。
  **描边最亮像素 89，比背景高 66 灰阶；中位描边 61，比背景高 38 灰阶**；WCAG 对比度 max **2.56** / 中位 **1.65**，
  轮廓可读（放大图 `cursor-s-light-darkwp-zoom.png`）。**最终选 1px**：最亮描边已接近 0.3 alpha 的理论上限
  （0.3×255 + 0.7×23 ≈ 93），1px 就够读出轮廓，不需要 1.5px。
- **浅色壁纸档「几乎看不出来」**（同机浅色主题 + 浅壁纸；加描边前 `cursor-light-with.png` vs 加描边后
  `cursor-s-light-with2.png`）：箭头足印**内**像素灰阶差 max **4 / 255**、mean **0.234**；足印**外**（≤3px 带）
  max **4 / 255**、mean **0.461**（放大图 `cursor-s-light-zoom.png`）。视觉上可忽略。
- **对称那半**（深色主题 + 浅色壁纸，白箭头 + `rgba(0,0,0,0.3)`，`cursor-s-dark-lightwp-zoom.png`）：
  描边最暗 **172**、背景 244、落差 **72 灰阶**、WCAG **1.76**——与浅色版救深色背景同一量级。

- 对照图（全部光标放大，浅底 / 深底各一张，箭头格已是新样式）：
  `/tmp/oa-probe/compare-light.png`、`/tmp/oa-probe/compare-dark.png`。

### 门禁

`npx tsc --noEmit` clean、`npm test` 96/96。

### 保留 / 没做（等用户拍板）

- **手型仍在**：`src/design-system/tokens.css` 的 `button { cursor: pointer }` 让**所有 `<button>`** 都是手型——
  顶栏按钮、程序坞图标、侧栏 `.split-nav`、对话框 / 右键菜单按钮、窗口红绿灯、`.control-button`、
  以及 `.rb-folder-inner`。按用户口径「保持现状」，**没改成箭头**。macOS 里按钮不显示手型、只有链接显示。
- **箭头淡描边 vs 其余形状的 1px 不透明描边**：箭头是「约 0.5px 可见的淡色描边」，其余形状是 1px 不透明
  描边，观感上箭头那条更轻；浅底上箭头描边几乎不可见（实测差 ≤4/255），深底上能读出轮廓。可选项：
  (a) 箭头也用不透明描边（会明显改变参考图观感）；(b) 其余形状也改淡描边；(c) 维持现状。
- **可见性风险（已按用户拍板处理）**：黑箭头在深壁纸 / 深色界面上原本看不见（实测 1.17，见上表）。用户选
  「方案①」：浅色版加 1px `rgba(255,255,255,0.3)` 描边，对称地深色版加 1px `rgba(0,0,0,0.3)`；实测见上。方案②
  （按背景 / 壁纸切换）**未做**，仍按主题切换。

## 2026-09-16（十三）：自绘一套 OpenArc 光标（照原生形状，不拷文件）

用户口径：「为 OpenArc 自绘一套自己的鼠标光标（照着 macOS 原生光标的形状，但不是拷贝文件），接进 app 里」。

### 形状来源 · 只做参考，仓库不放系统文件

形状对着系统自带的
`/System/Library/Frameworks/ApplicationServices.framework/Versions/A/Frameworks/HIServices.framework/Versions/A/Resources/cursors/`
（40 只，每只 `cursor.pdf` + `info.plist`，plist 里有热点 `hotx/hoty` 与阴影 `shadowcolor/shadowoffset/blur`）
用 `sips` 转成 PNG 后**照着轮廓重画**（`pointinghand` / `openhand` / `closedhand` / `cross` / `move` /
`copy` / `notallowed` / `ibeamvertical` / `resize*` 逐只放大看比例与热点）。**没有拷贝、嵌入或引用任何
系统 PDF/PNG/plist**，仓库里只有我们自己的 SVG。

### 交付 · `public/cursors/`（构建后 → `dist/cursors/`）

17 种形状 × 2 套外观 = **34 个 SVG**：

- 形状：`arrow`、`text`、`pointer`、`open-hand`、`grab`、`crosshair`、`move`、`copy`、
  `not-allowed`、`resize-n/s/e/w/ne/nw/se/sw`。
- 外观：浅色 UI = 黑填充 + 白描边（`-light`），深色 UI = 白填充 + 黑描边（`-dark`），跟 macOS 一样；
  纯线条字形（`text` / `crosshair`）用「描边色 3px 垫底 + 填充色 1px 芯」，否则白线画在浅底上等于隐形。
- 规格：`viewBox="0 0 32 32"` 且**显式写 `width="32" height="32"`**（Chromium 对光标图有尺寸上限，32 安全）；
  1px 描边、`stroke-linecap/linejoin="round"`；阴影是 `(0,-1)` 方向的低透明度偏移副本，
  **不用 SVG filter**（光标位图里 filter 不稳）。
- 热点（写进 CSS 的 `url(...) X Y`）：箭头尖端 `2,2`；十字 / 双箭头中心 `16,16`；手型 `16,17`。

### 接入（`src/styles.css`，每条都带原生兜底）

```css
.resize { cursor: url("/cursors/resize-se-light.svg") 16 16, nwse-resize; }
```

- `.resize` 窗口右下角缩放手柄 → `resize-se`（`nwse-resize` 兜底）。
- 桌面 / 文件区按住框选 → `crosshair`：新增 `data-marquee` 状态（桌面 `desk`、文件夹 `.folder-body` `files`）。
- 拖拽进行中（程序坞整理 `.dock.arranging`）→ `grab`（`grabbing` 兜底）。
- 拖到非法落点（桌面图标跟手拖到程序坞 / 顶栏）→ `not-allowed`：`dragDesktopSelection` 的 move 里
  用 `elementsFromPoint` 判「指针下是不是 `.dock` / `.topbar`」，新增 `data-drop-invalid`。
- ⌘ 按住（拖到系统 = 拷贝 / 别名）→ `copy`：新增 `data-cmd`（keydown/keyup 读 `e.metaKey`）。
- 路径用 public/ 根的绝对写法（与 `/openarc-mark.svg` 同一路子），Vite 构建时重写成 `../cursors/…`。
- **没有** `* { cursor }` 一类的全局覆盖：`arrow` / `text` / `pointer` 只画进套装、先不全局启用
  （macOS 辅助功能里用户能调大光标 / 提高对比度，固定 32px 的 SVG 全局盖掉会破坏它）。

### 实测

探针：`dist` + 本地静态服务 + 真实 Chromium，逐一触发真实状态后读 `getComputedStyle(el).cursor`
（探针与产物在 `/tmp/oa-probe/`，不进仓库）：

| 接入点 | 浅色实测 | 深色实测 |
| --- | --- | --- |
| `.resize` 缩放手柄 | `url("…/cursors/resize-se-light.svg") 16 16, nwse-resize` | `…/resize-se-dark.svg` |
| 桌面框选（`data-marquee=desk`） | `url("…/cursors/crosshair-light.svg") 16 16, crosshair` | `…/crosshair-dark.svg` |
| 文件区框选（`data-marquee=files`） | `url("…/cursors/crosshair-light.svg") 16 16, crosshair` | `…/crosshair-dark.svg` |
| 程序坞整理（`.dock.arranging`） | `url("…/cursors/grab-light.svg") 16 17, grabbing` | `…/grab-dark.svg` |
| 非法落点（`data-drop-invalid=1`） | `url("…/cursors/not-allowed-light.svg") 2 2, not-allowed` | `…/not-allowed-dark.svg` |
| ⌘ 拷贝（`data-cmd=1`） | `url("…/cursors/copy-light.svg") 2 2, copy` | `…/copy-dark.svg` |

- 6 个接入点命中的都是我们的 SVG 文件名（不是系统关键字）；探针同时看到 Chromium 真实发起了这些
  SVG 的请求，且 `Image` 解码 `ok / 32×32`。
- 对照图（全部光标放大 4×，浅底 / 深底各一张）：`/tmp/oa-probe/compare-light.png`、`compare-dark.png`。
- 真实 Electron 44（`dist` + `--no-sandbox`）用 `screencapture -C` 实拍：
  `/tmp/oa-probe/resize-final.png`（最上层窗口右下角手柄上是自绘的黑色双向斜箭头）、
  `/tmp/oa-probe/real-test.png`（把 `.window-body` 临时改成 `not-allowed`，验证灰色禁止符号确实由 OS 绘出）。
- 实测位置取的是**最上层窗口**的 `.resize`：用 `document.elementFromPoint` 确认命中的就是它本身
  （`hit===el` 为真），不是被内容盖住。

### 门禁

`npx tsc --noEmit` clean、`npm test` 96/96。

### 未做 / 已知

- ⌘ 拖动一旦进入 Electron 原生 `startDrag`，光标由 macOS / Electron 接管，页面 CSS 不再生效；
  `data-cmd` 只覆盖「按住 ⌘ 悬停在可拖条目上」这一段。
- 非法落点目前只覆盖「桌面图标跟手拖到程序坞 / 顶栏」这一路（CSS 可控的那一路）；
  页面内 HTML5 拖拽（拖到文件夹）的落点光标由 Chromium 的拖拽层决定，CSS 改不了。
- `arrow` / `text` / `pointer` / `open-hand` / `move` / `resize-n/s/e/w/ne/nw/sw` 已入套装，暂未接线。

## 2026-09-16（十二）：系统设置 / Skill 中心 / 应用中心 —— 顶栏整条都能拖

用户口径：「系统设置 / Skill 中心 / 应用中心这三个窗口，顶栏只有左边一条能拖，
右边那一条按不动；Finder 不受影响」。

### 根因 · `.window:has(.split)` 的 208px 例外

`styles.css` 里分栏窗口把 `.window-body` 上提 44px 盖住标题栏，再把
`.window-title` 收窄成 `width: 208px; align-self: flex-start`（208 = 侧栏 8+192+8），
目的是把右栏顶部让出来，好让 Finder 的 `.pane-toolbar`（它自己挂了
`onPointerDown={startDrag}`）与红绿灯同一行、且可点可输入。

Finder 的 `.split-main` 顶部就是 `.pane-toolbar`（自带拖拽），所以它能拖；
系统设置 / Skill 中心 / 应用中心这三个的 `.split-main` 顶部只有 `padding-top: 64px`、
一个可交互元素都没有（探针核对：三窗顶部 44px 内
`button/input/a/select/textarea/[role=button]` 命中数均为 **0**），
于是 208px 以外那一条顶上没有任何 `startDrag` 入口 —— 死区。

### 改法 · 只给「没有工具条」的分栏窗口放开宽度

```css
.window:has(.split):not(:has(.pane-toolbar)) .window-title {
  width: 100%;
}
```

- 选择器比原规则多一个 `:not(:has(.pane-toolbar))`，特异性更高，稳定覆盖 208px。
- Finder（有 `.pane-toolbar`）不进这条，仍是 208px，工具栏按钮仍可点、仍能从工具栏拖。
- `.traffic` 是 `position:absolute; left:14px`（不参与 `justify-content:center`），
  标题栏左边缘不动，所以红绿灯逐像素不变。
- `startDrag` 的抓取偏移、最大化不拖、`closest("button,input")` 拦截、缩放手柄、
  最小化动画一律没碰（只加一条 CSS）。

### 实测（真实 Electron 44 + CDP 合成拖拽；窗口固定种在 (400,200,560,400)）

三个窗口顶部中间 / 右上角各拖一次（鼠标位移 = 窗口位移）：

| 窗口 | 拖拽点 | 鼠标位移 | 拖前 left/top | 拖后 left/top | 实测位移 |
| --- | --- | --- | --- | --- | --- |
| 系统设置 | 顶中 | +40,+26 | 400,200 | 440,226 | +40,+26 |
| 系统设置 | 右上 | +30,+22 | 440,226 | 470,248 | +30,+22 |
| 应用中心 | 顶中 | +40,+26 | 400,200 | 440,226 | +40,+26 |
| 应用中心 | 右上 | +30,+22 | 440,226 | 470,248 | +30,+22 |
| Skill 中心 | 顶中 | +40,+26 | 400,200 | 440,226 | +40,+26 |
| Skill 中心 | 右上 | +30,+22 | 440,226 | 470,248 | +30,+22 |

改前（同一探针、同一坐标）：三个窗口六个点实测位移全部 **0,0**（按到的都是 `.split-main`）。

Finder 未被影响：

| 项 | 改前 | 改后 |
| --- | --- | --- |
| `.window-title` 实宽 | 208px | **208px** |
| 从工具栏 `.pane-title` 拖 +30,+22 | 400,200 → 430,222 | 400,200 → 430,222 |
| 工具栏「列表」按钮 `aria-pressed` | false → true（可点） | false → true（可点） |
| 顶中 / 右上（落在工具条按钮上） | 不移动 | 不移动 |

红绿灯（窗口在 (400,200) 时）改前/改后完全相同：
`关闭 (414,216,12×12)`、`最小化 (434,216,12×12)`、`最大化 (454,216,12×12)`，
`.traffic` 相对窗口 `(14,16)` 不变。

双击标题栏：最大化 `(0,38,1440×902)`，再双击还原到双击前的 `(470,248,560×400)`；
最大化状态下顶中拖 +40,+26 —— **不移动**（left/top 仍 0,38）。

顶部截图（窗口顶 84px）：三窗改前/改后 **PNG 逐字节相同**（MD5 一致）。

### 门禁

`npx tsc --noEmit` clean、`npm test` 96/96。

## 2026-09-16（十一）：球收成正圆 + 顶栏也换成同一颗球

两条用户口径：

1. 「球的轮廓不是正圆，右边有缺、右下还多一块」——圆底羽化 12px 太宽，球体自己那点不规则外沿从渐变带里透了出来。
2. 「顶栏那个星形 sparkle 图标，换成和程序坞一样的球」。

### A · 把轮廓收成一个正圆

1. **羽化收窄 + 挪到圆外**：`inside = 1 - smoothstep(96, 98, length(p))` —— **实心到 R=96**、
   外沿 2px 羽化（原来 `smoothstep(82, 94)` 等于在 94 半径上开 12px 渐变带）。
   R=96 是实测的球体外沿（见（十）：毛刺到 ~97px），整颗玻璃球都在圆内。
2. **圆外按亮度决定去留**：`bright = smoothstep(0.16, 0.30, m)`，
   抠黑层 alpha 乘 `max(inside, bright)`。圆外暗的一律按圆裁掉（那条灰尾巴、压缩噪声），
   够亮的允许留在圆外，免得把偶尔伸出来的亮光带尖角切成生硬圆弧。
   实测 **m≥0.2 的内容最外只到 ~91px（在 R=96 以内）**，这道门实际上几乎不触发 ——
   留着是给没抽到的帧兜底；试过直接整圆硬裁，观感与带门几乎无差别，故按更稳的带门。
3. **分母下限 `c/max(a,0.35)` 保留**（（十）加的，与小圆底互为保险）。
4. 着色器仍只在 `src/desktop/SiriBlob.tsx`，仓库不放任何 Apple 素材。

**三个数字**（真实 Electron，AI 面板大球画布 238×238，`readPixels` 取 180 个角度，目标 R=96 视频像素）：

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| (a) R-2px 圆周 alpha 最小值 | 0 | **255** |
| (a) R-2px 圆周 alpha<250 的角度数 | 174 / 180 | **0 / 180** |
| (b) R+4px 圆周「alpha>30 且亮度<0.15」的角度数 | 0 / 180 | **0 / 180** |
| (c) 轮廓半径极差（180 角度） | 11.5 px | **3.0 px** |
| (c) 轮廓半径标准差 | 2.33 px | **0.59 px** |

> (b) 改前也是 0：那条灰尾巴比 R+4 更靠里/更淡，这个阈值量不到它；但 4× 截图里改后确实没了。
> (c) 的 3px 极差 ≈ 2px 羽化 + 0.5px 采样步长，属预期；标准差 0.59px 说明轮廓是干净的圆。

### B · 顶栏「全局 AI」换成同一颗球

1. `TopBar` 里 `<Sparkles size={15} />` → `<OrbIcon size={18} className="topbar-orb" animated={animated} />`；
   **onClick 与 aria-label「全局 AI」一个字没动**；Sparkles 已无其它引用，import 一并删掉。
2. **减少动态效果**：`TopBar` 新增可选 `animated`（默认 true），main.tsx 传现有 `reduced`
   （`animated={!reduced}`）——不新引状态，和 Dock / 胶囊同一条开关。
3. **尺寸与对齐**：整条顶栏高度 **38px → 38px 不变**；AI 按钮 27×27 → 30×30（内容 15→18px），
   两者垂直中心都在 **y=19**，即图标仍居中、整行对齐没动。
4. **小尺寸观感（老实说）**：18px 槽位里球直径 ≈13.5px。4× 实拍里它是一颗**小彩色玻璃球**，
   能看出和程序坞是同一颗，**不是糊成一团黑**；但 18px 下几条光带已经揉在一起、分不出条数。
   判断：这个大小**可用**（它是"一颗球"的符号，不需要看清花瓣），建议先按 18px 交付。
   如果以后更看重小尺寸的清晰度，程序化那颗（矢量式、小尺寸更利）会比原生这条更锐，代价是和 dock 不是同一颗。

**证据**：
- 点击顶栏球 → `.ai-panel` 打开（`panelOpened=true`）。
- 减少动态效果：顶栏球 `paused=true, currentTime=8, readyState=4`，截图里是静态球（非黑帧）。
- 顶栏球实测 `.orb orb-native topbar-orb`、canvas **52×52**（18×1.45×2）、video `readyState=4` 且在走。

### 门禁

`npx tsc --noEmit` clean、`npm test` 96/96。

## 2026-09-16（十）：给原生 Siri 球垫同心近黑圆底 —— 修浅色背景上的毛边

用户口径：「在浅色面板（白卡片）上，球的外缘是毛的、碎的」；用户自己的判断是：
球里面是不是需要一个**一样大小的圆底**。

### 根因（用改前构建实测）

亮度抠黑 + `c / max(a, ·)` 把 h264 的压缩噪声放大了：球体那圈暗玻璃只有 **1~5/255**，
`a = smoothstep(0, 0.06, max(r,g,b))` 在那里落在 **0~0.5**，而颜色按 `c/a` 还原 ——
a 越小放大越狠（a=0.05 时噪声被放大 20 倍），于是球缘变成一圈被放大的灰白麻点。
深色程序坞看不出来（噪声本身是暗的），白卡片一衬就全暴露。
改前在真实 Electron 里沿球体圆周量 alpha：**0.88R 处标准差 113.56**，180 个角度里 **70 个 alpha<200**。

### 改法

1. **同心近黑圆底**，用标准 over 合成垫在抠黑层**之下**，只在球内 —— 球外那点柔光不受影响：
   `vec2 p = (vUv - center) * vec2(256, 255); disc = 1 - smoothstep(82, 94, length(p))`。
   R = **94px**、外沿 **12px 羽化**；颜色取球体环带 **0.6R~0.85R 的 RGB 中位 (1,5,6)/255**
   —— 近黑带一点冷色，避免垫出一块死黑。
2. **分母下限**：`c / max(a, 0.35)`（原来是 `c / max(a, 1e-4)`），a 很小时颜色不再被放大；
   成本为零，即使有圆底也留着。
3. 顺手修正（八）里 `ZOOM` 注释的旧数字：视频里球体直径实测 **≈0.73 画面宽**，不是 62%
   （1.45 是多出来的分辨率，CSS 缩回槽位后显示大小不变，见（九）的纠正）。
4. 着色器仍在 `src/desktop/SiriBlob.tsx` 里，仓库不放任何 Apple 素材。

### 圆底几何的来历（不是照抄常数）

ffmpeg 抽 **t=2 / 8 / 16 / 24 四帧**：

- 球心 = 亮色光带（`max(r,g,b) ≥ 20`）的强度加权质心 → **(122.55, 122.47)**，
  比画面正中**偏左 ~5px、偏上 ~5px**，所以圆底跟着偏；
- 从球心做角向**中位数**亮度曲线：球体边缘（中位亮度掉到 1/255）在 **半径 ~92px**，
  最外毛刺到 ~96px，故取 94px + 12px 羽化，正好盖住这圈噪声。

### 实测

- **毛刺数字**（真实 Electron，AI 面板大球画布 238×238，`readPixels` 取 180 个角度）：
  0.88R 处圆周 alpha **标准差 113.56 → 2.58（约 44 倍）**；
  alpha<200 的「缺口」角度 **70/180 → 0/180**；0.85R std 114.57 → 0、0.80R std 110.95 → 0。
  边缘半径极差只从 15.5px 降到 11.5px —— 这条会被伸到球缘的**真实光带尖角**顶住，不代表噪声，故不以此为准。
- **浅底 4× 前后**：改前是一圈啃过的灰白麻点环，改后是干净的近黑圆底；
  **深色程序坞**轮廓也更干净（原来是歪的缺口），**球外柔光没被切**
  （1.0R 处 alpha 均值改前 10.53 / 改后 11.87）。
- **减少动态效果**：`paused=true, currentTime=8`，静态帧非黑、正常。
- **语音联动**：往 `AnalyserNode` 注入已知波形，电平 0.8 → 球外层 `scale(1.0733)|brightness(1.64135)`、
  电平条 0.916；0.02 → `scale(1.03059)|brightness(1.26766)`、0.382 —— level→adapter→球 CSS 这条链一行未改、完好。
- 门禁：`npx tsc --noEmit` clean、`npm test` 96/96。

### 已知残留（不是这次改出来的）

球外右下角还有一小块很淡的灰尾巴：视频里球体轮廓外面本来就有一点暗玻璃/光带的延伸，
圆底只在 R 内、盖不到。深底基本看不见，浅底上是一块淡灰印；**改前也有**，只是被麻点环盖住了。
没顺手动 R 或阈值 —— 那正好会破坏这次刚验过的轮廓。

## 2026-09-16（九）：老系统也要有球 —— 程序化 Siri 球做第二级兜底

用户口径：「老系统也要有球看，不能是原来那颗不好看的 orb-ui 球」。

（八）只解决了有原生素材的机器：`Siri Blob.mov` 只存在于装了 SiriUI.framework 的 macOS 版本里，
别的版本 `openarc-file://native/siri-blob` 直接 404，那些机器仍然退到 orb-ui 那颗球 —— 也就是
用户说「不好看」的那颗。这一版补上中间那一级：自己画一颗。

### 做了什么

1. **新增 `src/desktop/SiriOrbProcedural.tsx`**：原创 WebGL 片元着色器。着色器**内联在这个文件里，
   是仓库里唯一一份** —— 仓库里不放 `orb.frag` / demo / 任何 Apple 参考帧或它们的 base64，
   运行时也不读任何 Apple 素材（只读系统的 GPU 能力）。
2. **`OrbIcon` 里一个 state 三态**：`native(SiriBlob) → procedural(SiriOrbProcedural) → orb-ui(OrbUiFallback)`。
   调用方（DockItem / AssistantPill / AIPanel）一行未动。
3. **尺寸对齐原生那条**：球占槽位半宽的 **0.675**，和原生那条**量出来**的一致
   （47px 槽位的 canvasBacking 两边都是 136×136 @dsf2，球直径都 ≈ 槽位的 0.675）。

   > **顺手纠正（八）里的一处记法**：（八）写「ZOOM=1.45 裁掉黑边让球填满槽位」，这个说法是错的。
   > `SiriBlob` 把 backing 画成 `size × 1.45 × dpr`，但 CSS 又把画布缩回 `size`
   > （`.orb-siri > canvas { width: 100% }`）——**1.45 只是多出来的分辨率，被缩放抵消掉了**，
   > 球的显示大小仍然是槽位半宽的 0.675。第一版程序化球照着 1.45 当放大倍数用，
   > 实测球比原生大 45%（截图里一眼能看出）。改成「backing ×1.45 + 球半径 0.675」后两边一模一样。
4. **语音联动走 imperative handle**：`adapter.subscribe(signal => setLevel(signal.inputVolume))`，
   电平只写 ref、下一帧直接进 uniform，**不 setState**（原生那条由 SiriBlob 自己订阅，同一份 adapter）。
5. **CSS**：`.orb-native::after { display: none }` 扩到 `.orb-native::after, .orb-procedural::after` ——
   自发光的两级都要挡掉 orb-ui 那圈蓝柔光，否则程序化球会被盖成一颗灰球。
6. **减少动态效果**：程序化球只画一帧（`STATIC_TIME = 8`，和原生那条同一个静态帧时刻）、不挂 rAF；
   原生那条保持原样（暂停 + seek 8s）。

### 还差在哪（老实记）

- **花瓣位置对不上**：平均像素误差 13.65 → **13.81 / 255，等于打平**。近黑、径向剖面都明显改善，
  但像素误差是被「Apple 的花瓣落在哪一帧的哪个位置」主导的，**不是靠调参能解决的** ——
  要逐帧拟合那 2057 帧，或者手写关键帧。对一颗兜底球不值当，所以到此为止。
- **偏对称、偏图形化**：苹果是 4~6 条宽窄 / 长度 / 角度都不等的臂，还和花瓣融在一起；
  我这颗是 5 条比较均匀的臂 + 花瓣，整体更像一个规整的花轮。
- **p99 略低、亮区略热**：p99 0.9628（苹果 0.9805），亮区最大通道 0.6552（苹果 0.5910）。

### 实测（对着 Apple 自己那 8 帧，160px 1:1，8 帧汇总）

| 指标 | Apple | 上一版 | 这一版 |
| --- | --- | --- | --- |
| 球内近黑占比（L < 0.02） | 0.3264 | 0.0691 | **0.3615** |
| 径向亮度剖面 RMSE | — | 0.0626 | **0.0338** |
| 平均像素误差 | — | 13.65 / 255 | 13.81 / 255（打平） |
| 平均帧亮度 | 0.0848 | 0.0893 | 0.0880 |
| p99 亮度 | 0.9805 | 0.9578 | 0.9628 |
| L > 0.12 处平均饱和度 | 0.4685 | 0.4832 | 0.4611 |

- **成本**：CPU **0.82 µs/帧**（47px，5 个 uniform + 1 次 `drawArrays`，逐帧零分配）；
  GPU **≤ 0.022 ms/帧**（32~256px @dsf2，ANGLE/Metal 真机，非 SwiftShader）。
- **真实 Electron 44.3.0 截图**（把主进程 `NATIVE_RESOURCES` 指向不存在路径）：
  dock 球 `.orb-procedural`、面板球 `.orb-procedural`，容器里是自家 canvas 而不是 orb-ui 的
  `.orb-canvas`；backing store **136×136**（47px @dsf2）/ **238×238**（82px @dsf2）——
  和原生那条量出来的是同一组数（47×1.45×2=136.3→136，82×1.45×2=237.8→238）。
  **既不是空白，也不是 orb-ui 球。**
- **减少动态效果**：同一场景连拍两张，**像素完全一致**（静态帧，不是黑帧）。
- **原生路径回归**：不动 `NATIVE_RESOURCES` 时仍是 `.orb-native` + `.orb-siri video`，
  `readyState=4`、`currentTime` 在走、`error=null` —— 这一轮没改坏。
- **门禁**：`npx tsc --noEmit` clean、`npm test` 96/96。

### 两个坑（已写进组件头注释，免得下次再踩）

1. **`pow(负底, y)` 是 UB，ANGLE/Metal 上返回 NaN。** 一帧里只要一个像素 NaN，整颗球就变黑
   （只剩核心）。凡是有符号的量进 `pow` 之前必须 `abs()`；`pow(d * d, k)` 看着安全只是因为
   平方之后非负，换个写法就中招。
2. **`exp(-max(rr - 1.0, 0.0) / k)` 在 rr < 1 时恒等于 1。** 想写「球外那点溢出光」这么写，
   等于给整颗球加了一层底光 —— 球内近黑会被它从 0.36 拉回 0.07。球外的项必须显式夹到球外。

## 2026-09-16（八）：换成系统原生的 Siri Blob —— dock 的球不再用 orb-ui

用户口径：「orb-ui 那颗球不好看，我要苹果原生的 Siri 动态图标」。

素材就在系统里：`/System/Library/PrivateFrameworks/SiriUI.framework/Versions/A/Resources/Siri Blob.mov`
（256×255 / h264 / 60fps / 34.283s / 2057 帧，纯黑底）。**只在运行时从该绝对路径读取，不复制进仓库、dist 或安装包**
—— 它是 Apple 的版权素材。

### 做了什么

1. **主进程**（`electron/main.cjs`）：`openarc-file` 协议加 `native` 分支，模块级白名单
   `NATIVE_RESOURCES{ "siri-blob": 绝对路径 }`；渲染进程只能报逻辑名、拿不到路径，未知名/文件不存在回 404。
   media 分支一行未动。
2. **渲染层**（新增 `src/desktop/SiriBlob.tsx`）：`<video muted loop playsInline preload="auto" crossorigin>`
   留在渲染树里（`display:none` 会挂起解码），逐帧上传 GPU 纹理，片元着色器按
   `a = smoothstep(0, 0.06, max(r,g,b))`、`rgb/a` 未预乘把黑底抠掉。画布 backing = `round(size × 1.45 × dpr)`、
   CSS = 槽位，1.45 是裁掉黑边让球填满槽位。`OrbIcon` 里只留**一个开关**：`native ? <SiriBlob/> : <OrbUiFallback/>`
   （原 orb-ui 渲染整块挪进 `OrbUiFallback`，以后换兜底只改那个组件）。
3. **减少动态效果**：暂停并 seek 到 8s 画一帧（0s 是纯黑，不能取）。
4. **兜底**：video error / WebGL 起不来 / `webglcontextlost` / 8s 看门狗 → 退回 orb-ui，不新增 IPC 通道。

### 两处代价（老实记）

- **给协议加了 CORS**：`openarc-file` scheme 加 `corsEnabled: true`，且**只在那一条 native 分支**回
  `Access-Control-Allow-Origin: *`（media 分支没有任何 CORS 头）。原因是跨源视频画进 canvas 后读像素
  （`getImageData` / `texImage2D`）会被判污染并抛 `SecurityError`，不加这个头画面根本进不了 canvas。
- **老 macOS 上没有这个资源**：会退回 orb-ui 那颗球，也就是用户觉得「不好看」的那颗在这些机器上仍然存在；
  后续用程序化替代版解决（本次不动兜底视觉）。

### 被否决的方案（实测数字）

先按 2D canvas 做（下采样 → `getImageData` → 亮度抠黑 → `putImageData`）：
`ctx.drawImage(video)` 把硬件解码帧写进 CPU 画布要 **5.7~11.4 ms/帧**（画布 38/48/94/164px 四种），
主线程直接超预算 5~7 倍；抠黑本身只有 0.05~0.18 ms/帧。于是改 WebGL（纹理上传无回读）。

### 实测

- 真实 Electron 44.3.0 / Chromium 152.0.7977.78，`deviceScaleFactor=2`，remote-debugging + `connectOverCDP`：
  `readyState=4`、`currentTime` 两次采样 1.648617 → 3.172019、`videoSize[256,255]`、`duration 34.283333`、
  `error=null`；`seekable=[0, 34.283333]`；WebGL `readPixels` 四角 alpha 全 0、中心 255，两帧像素不同。
- **每帧成本**（主线程，包裹 `texImage2D`/`drawArrays`）：dock 单球 **0.128 ms/帧**（136px backing）、
  胶囊 0.151 ms/帧；AI 面板四球合计 **约 0.48 ms/帧**（55/136/70/238）。对照 2D 方案 5.7~11.4 ms/帧。
- 减少动态效果：`paused=true`、`currentTime=8`、900ms 后仍为 8。
- 兜底：把主进程 map 指向不存在路径 → `.orb-siri=0`、orb-ui canvas 正常，球不变空白。
- 门禁：`npx tsc --noEmit` clean、`npm test` 96/96；`preload` 暴露面未动（`exposeInMainWorld` 仍只有 `openarc`）。

## 2026-09-16（七）：球改成「散发式柔光」——外圈直接羽化掉

用户澄清：「不是这样的，我说的是那种柔光，散发出来的，越往外越看不清」。

上一版加的是一圈**亮边**（band），看起来像镶了个环；用户要的是**从球面向外一路衰减到看不见**的光。所以：

- 球体本身用 **mask 羽化**：`.orb-canvas canvas` 上加 `radial-gradient(circle closest-side, #000 0 74%,
  → 0.8@84% → 0.45@92% → 0.16@97% → transparent 100%)`，球的最外圈直接变半透明、融进背景；
- 外面那圈 `::after` 也从"亮带"改成**单调衰减**（54% 最亮 → 84% 只剩 0.06 → 100% 归零），整体再调淡一档；
- 结果就是"越往外越看不清"：没有可看的边，顺带连锯齿也没有了（不用再靠超采样遮）。超采样仍保留（1.37 倍）。

### 踩到的坑（记一笔，免得下次再踩）

mask 一开始加在 `.orb-canvas` 上 —— 那是 orb-ui 的**根 div**（61px），比球（41px）大一圈，
`closest-side` 按 61px 算，羽化圈整个落在球内部，**等于没羽化**（截图看不出来）。
mask 必须落在**画布本身**上（`.orb-canvas canvas`）才对。

### 实测（模拟 Retina，deviceScaleFactor: 2）

外框 47px、球 41px、画布 112×112 backing、超采样 1.37 倍；4 倍最近邻放大与整条程序坞的真实尺寸截图
都确认：边缘是一圈渐隐的柔光，没有硬边、没有台阶。
回归：`npm test` 96/96、桌面 24/24、拖拽落点 7/7、鼠标旁边 7/7、越界 6/6、图标大小 13/13、壁纸 16/16、orb 6/6、语音 10/10。

## 2026-09-16（六）：球加一圈光晕 —— 顺带把硬边的锯齿盖掉

用户口径：「锯齿感还是很大，要么你跟他一样，加一个光晕」。

上一版超采样（2 倍画再缩回）已经把边缘采样点提上去了，但 orb-ui 的圆是**片元里切**的硬边，
缩到 47px 槽位后那条 1px 的硬边还是能看出来。既然参考图本身就是"发光的球"，就按它的做法加光晕：

- `.orb::after` 加一圈**静态**径向渐变光晕（`inset: -8%`，光带落在 58%–79% 半径处）；
  **光带压在球边缘上**，硬边被这层柔光盖住 —— 这才是治锯齿的关键，不一定只是"好看"；
- 球从"顶满槽位"退回 **~85%（40px / 47px 槽位）**，把外面那圈让给光晕；
  超采样仍保留（实测 1.40 倍，backing 112×112）；
- 光晕是静态渐变、不参与动画，逐帧成本为零。

### 实测（模拟 Retina，deviceScaleFactor: 2）

外框 47px、球 40px（占槽位 0.85）、画布 112×112 backing、超采样 1.40 倍；
4 倍最近邻放大与整条程序坞的真实尺寸截图都确认：边缘是一圈柔光，没有台阶。
回归：`npm test` 96/96、桌面 24/24、拖拽落点 7/7、鼠标旁边 7/7、越界 6/6、图标大小 13/13、壁纸 16/16、orb 6/6、语音 10/10。

## 2026-09-16（五）：修「图标有锯齿」——球按 2 倍画、再缩回槽位

用户口径：「图标有锯齿」+ 三张不同尺寸的球截图（Dock 47px、面板标题 24px、面板大球 82px），边缘都是台阶。

### 根因

orb-ui 的球是在**片元着色器里直接切**出来的硬边（`distance > r` 就丢片元）；它虽然会按
`min(devicePixelRatio, 2)` 放大画布 backing，但**最多也就 1:1**（Retina 上 47px 槽位 → 43px 画布 →
86 设备像素），边缘采样点不够就出现台阶。也就是说这不是"CSS 缩放糊了"，是**画布本身分辨率不够**。

### 做法（不动它的库，只加一层壳）

- `OrbIcon` 里加 `.orb-scale` 包一层：球按 `size × 2` 画（orb-ui 再叠它自己的 DPR 倍率），
  再用 `transform: scale(...)` 缩回槽位 —— 等于做了一次 **1.34 倍超采样**，台阶被平均掉；
- 顺手把球放大到填满槽位：实测 orb-ui 的球只画到 `size` 的 ~69%（47px 槽位里只有 32.4px，
  比左右图标小一号），现在乘 1.33 → 球 43px / 槽位 47px（= 原来的观感，与相邻图标同量级）；
- `boost` / `fill` 两个常数都写明了实测来源，不是拍脑袋。

### 实测

模拟 Retina（`deviceScaleFactor: 2`）：外框 47px、球 43.5px（占槽位 0.93）、画布 backing 115×115，
**超采样 1.34 倍**；4 倍最近邻放大截图确认边缘是平滑圆，没有台阶。DPR=1 与 DPR=2 下球/槽位比例一致（0.91/0.93），
不会出现"换屏幕尺寸就变形"。
回归：`npm test` 96/96、桌面 24/24、拖拽落点 7/7、鼠标旁边 7/7、越界 6/6、图标大小 13/13、壁纸 16/16、orb 6/6、语音 10/10。

## 2026-09-16（四）：修「会闪屏」—— 逐帧信号不再进 React

用户口径：「会闪屏」。

### 排查（先说没复现到什么）

浏览器探针里对程序坞球与面板球各高频采样 40 帧：**没有白帧/空帧离群值**（min/max 只差 15%），
面板里也没有 canvas 增删、没有 `webglcontextlost` —— 也就是说"闪"不是球自己在闪。

### 真机上最可能的成因：逐帧 setState

上一版电平存在 React state 里，30fps 更新 → **AI 面板（玻璃层，backdrop-filter）每帧整棵重渲染**。
本项目里"玻璃 + 逐帧重渲染"出过好几次合成层残留/闪动的毛病，这条路径本身就是白烧。所以把逐帧的东西整个挪出 React：

- `useMicLevel` → `useMicSignal`：只暴露 `subscribe()` 与 `error`，电平在 rAF 里算好**直接推**给订阅者；
  React 只在"开/关麦克风、出错"这类真状态变化时重渲染（监听期间为零次）；
- 球改用 orb-ui 的 **adapter**（`subscribe` 里推 `{state, inputVolume}`），不再每帧换一个 `signal` 对象；
- 电平条改成 `ref` + 每帧直接写 `transform`，同样不经过 React。

### 实测

语音探针仍 10/10：电平跟随 0.519 → 0.935 → 回落 0.817、球在动、点停止与关面板都把 track 变 `ended`。
**这一条还没在真机上复现过**：如果换成命令式之后仍然闪，请说明是"整块屏幕 / 面板 / 球"哪一块、什么时候闪
（开面板时 / 点开始聆听时 / 持续监听时），我按那个方向继续查。

## 2026-09-16（三）：AI 球支持语音 —— 跟着你的声音动（本地）

用户口径：「能做成跟 Siri 一样吗？动态的，然后支持语音，根据用户声音说话进行变化」。

### 能做到的 / 做不到的（先说清楚）

- **能做到**：球跟着你说话的实时音量变化（动态 ✓ 语音驱动 ✓）—— 麦克风采集**只在本机算一个 dB 电平**，
  不录音、不缓存、不上传；
- **做不到（要等后端）**：真正的"听懂并回答"需要语音识别 + 模型服务，而模型服务是 D4-01、现在还没接
  （面板里那句"后端未接入"就是它）。所以现在**不假装听懂** —— 面板里明写了这一点。

### 做了什么

1. **主进程权限收窄**（`electron/main.cjs`）：只有本应用自己的页面能要 `media`，而且只要 `audio`、不要 `video`；
   其余权限维持原状。**不写这张表的话 Electron 默认放行一切** —— 浏览器窗口里那些不受信网页也能顺手开麦
   （A13 的反面：不可信网页不得拿到系统能力）。`Info.plist` 里本来就有 `NSMicrophoneUsageDescription`，不用改打包。
2. `src/desktop/useMicLevel.ts`：getUserMedia → AnalyserNode → 每帧算 RMS 再按 **−60..0dB 映射到 0..1**（+指数平滑）。
   用 dB 而不是线性：麦克风读数天然很小，线性要么几乎不动、要么一下顶满（实测线性版两档音量都读到 1.0）。
   三条纪律：只在本机算电平；停止时 `track.stop()`（否则 macOS 麦克风指示灯一直亮）；约 30fps 且**只改 transform**。
3. AI 面板加「开始/停止聆听」+ 电平条 + 一句实话；球的 `signal` 用它驱动（`listening` + 真实音量），
   没开麦时退回装饰性的 `thinking` 动效。**关掉面板 = 组件卸载 = 麦克风自动释放**。

### 实测（Playwright + 假麦克风：振荡器 → MediaStream，10/10）

音量 0.05 → 0.9：电平 0.518 → 0.935（跟着变大）；调小后 0.817（跟着回落）；球两帧像素不同（在动）；
麦克风 track 从 `live` → 点停止后 `ended`；**开着麦关面板也会 `ended`**（不留灯）。
回归：`npm test` 96/96、桌面 24/24、拖拽落点 7/7、鼠标旁边 7/7、越界 6/6、图标大小 13/13、壁纸 16/16、orb 6/6。

### 下一步（要你点头才做）

真正的语音交互要接 STT（语音转文字）+ 模型服务；一旦接上就意味着**把录音发出去**，属于"外发数据"，
按规矩要你明确同意之后我才接。

## 2026-09-16（二）：程序坞那颗球去掉 App 图标底板

用户口径：「底部这边，去掉边框」+ 一张程序坞里带浅色圆角底板的截图。

- 程序坞的全局 AI 不再套浅色 squircle 底板：`OrbIcon` 去掉 `squircle` 分支，`.orb-app` 规则与调用点一起删；
  现在就是一颗**裸球**（球占满 47px 槽位，与左右图标同高对齐，实测 icon/canvas 都是 47/47、y 与相邻图标一致）；
- 助手胶囊、面板标题、面板大球本来就是裸球，不受影响；
- 减少动态效果仍不挂 WebGL、退回静态帧。

实测：orb 探针 6/6（程序坞 canvas + 真在动 + 减少动态效果回退 + 帧间隔 p50 8.3ms / p95 9.1ms）；
整屏截图确认：一排图标之后是分隔线 + 一颗裸蓝球，四周没有底板边框。

## 2026-09-16：AI 球的颜色改成蓝紫（用户给图）

用户口径：「颜色我想要这样的」+ 一张柔和的蓝紫云球图。

- `ORB_THEME.appearance` 换成 **orb-ui cloud 的默认那套蓝紫**：
  `#5c63fb`（深）/ `#7a8ffb`（上）/ `#b8c7f9`（下）/ `#e3eafa`（高光）；
  上一版那套青 `#35d6ff` / 品红 `#ff4fa3` 是我自己配的，已撤掉。
- 几何不动（`diameterRatio: 0.92`），`state="thinking"` 仍只为取动效。

实测：orb 探针仍 6/6（程序坞 canvas + 真在动 + 减少动态效果回退静态帧 + 帧间隔 p50 8.3ms / p95 9.2ms）。

## 2026-09-15（十一）：AI 球改用 orb-ui（接管上一轮手写的那颗）

用户口径：「你不要自己写，看看其他这种 ai 动态前端 ui 的有没有网站」→ 选定 https://orb-ui.com/ 。

### 调研结论（网站与许可）

| 站点 / 库 | 是什么 | 许可 | 代价 |
| --- | --- | --- | --- |
| [orb-ui](https://orb-ui.com)（npm `orb-ui`） | 专做语音 Agent 的球，WebGL + rAF，`<Orb/>` 一行接入，零运行时依赖 | **MIT** | 59KB，**已采用** |
| [ElevenLabs UI](https://ui.elevenlabs.io) | 语音 Agent 组件库（Orb / 波形 / 会话），Orb 是 three + R3F + GLSL | MIT | three 三件套 ≈600KB+，备选 |
| [magicui.design](https://magicui.design) | 动画组件合集 | MIT | Tailwind/shadcn 生态，要手工搬 |
| [21st.dev](https://21st.dev) | 组件注册表聚合站（含社区 Siri Orb/Wave） | ⚠️ 抽样的几个**无 license** | 不可用 |
| [reactbits.dev](https://reactbits.dev) | 动画组件合集（项目里文件夹图标来自这里） | ⚠️ MIT + Commons Clause | 可用于产品，不能转卖组件本身 |
| 项目自带 Spectrum UI 注册表 | AI 分类有 voice-input / thinking-dots 等 | 项目内 | **没有 orb 类组件** |

### 这一版做了什么

- `npm i orb-ui`（`^0.8.0`，MIT，© Alexander Chen）；`OrbIcon` 里手写的那颗 CSS 球整块删掉，换成它的 `<Orb/>`；
- 观感参数（`ORB_THEME`）：`cloud` 主题 + 照用户那张图配的调色（上青 `#35d6ff` / 下品红 `#ff4fa3` / 白高光 / 深蓝底 `#1b2f7a`），
  `diameterRatio: 0.92` 让球基本填满框；
- **`state="thinking"` 只取它的动效**：实测 orb-ui 的 `idle` 两帧像素完全一致（静止），而用户口径要的就是"动态的"；
  代码里写明了这一条 —— 真接上后端后换成真实状态即可；
- 四处都换：Dock（保留浅色 squircle，球占外框 ~74%，与原来那张 PNG 比例一致）、助手胶囊、面板标题、面板大球（82px）；
- **减少动态效果**（产品内开关）下**不挂 WebGL**，退回同一张静态帧 `siri.png`（orb-ui 只认系统级 `prefers-reduced-motion`，认不到产品开关）；
- 静态 `siri.png` 只在这个回退路径里用，不再出现在正常路径。

### 实测（Playwright + 真实 dist，6/6）

Dock 的全局 AI 挂的是 orb-ui 的 canvas（外框 47px、球 35px）、两帧像素不同（真的在动）；
胶囊 / 面板标题 / 面板大球也都是它的 canvas；产品内「减少动态效果」下不挂 WebGL、退回静态帧；
**悬停扫过程序坞时帧间隔 p50 8.3ms / p95 9.1ms**（120Hz 满帧，dock + 胶囊两处 WebGL 一起跑都没拖累）。
主包体积 108KB → **159KB**（+51KB，orb-ui 的 59KB 压进去了）。
回归：桌面 24/24、拖拽落点 7/7、鼠标旁边 7/7、越界 6/6、图标大小 13/13、壁纸 16/16、`npm test` 96/96。

## 2026-09-15（十）：全局 AI 换成动态球

用户口径：「这个图标，你找找有没有动态的」。（给的是现在 Dock 里那颗静态 siri.png）

### 先找了一圈

- `aaaa-zhen/glsl-playground`：Apple 新 Siri 动画 + Liquid Glass 的纯 GLSL 复刻，67 star，**没有 license**；
- `Thijs2004/LiquidSiri`：同类 Siri 球，**没有 license**；
- 21st.dev / CodePen 上那些散件：多为个人作品，授权同样不清。
没有 license 的代码不能抄进产品（这是公司法务意义上的红线，不是洁癖）。所以**没抄**，按观感自己写了一版。

### 这一版（`.orb`，`OrbIcon`）

- 纯 CSS、零素材、零依赖：深蓝球底 + 品红/青两块饱和色域 + 球中球高光边 + 一颗会呼吸的核心；
  两层"绕着球心慢慢转的发光斑"（`screen` 叠加，9s / 15s 反向）负责"流动感"；
- 只动 `transform` / `opacity` —— 走合成器，不参与主线程；尺寸靠 `font-size` 的 em 缩放，
  Dock 那一版直接吃 `--dock-icon`，所以它会跟着「程序坞图标大小」滑块一起变；
- Dock 里保留原来的 App 图标外观（浅色 squircle + 球内缩 13%），助手胶囊 / 面板标题 / 面板大球用裸球；
- 「减少动态效果」（产品开关与系统级 `prefers-reduced-motion`）由既有兜底整体停掉动画 ——
  停掉后仍是一颗完整的静态球，不会留空壳；
- 静态 `siri.png` 不再被引用（文件先留着，想退回静态版随时能退）。

### 实测（Playwright + 真实 dist，6/6）

Dock 里确实是 App 图标版动态球（47px、球体 35px、两层动画 orb-spin 7s/11s→9s/15s）；
旋转的 transform 随时间变化（真的在动）；胶囊 / 面板标题 / 面板大球（82px）都换了；
系统级「减少动态效果」下 `animation-name: none` 且球体底色仍在；
**悬停扫过程序坞时帧间隔 p50 8.3ms / p95 9.3ms**（120Hz 满帧，没被这颗球拖累）。
回归：桌面 24/24、拖拽落点 7/7、鼠标旁边 7/7、越界 6/6、图标大小 13/13、壁纸 16/16、`npm test` 96/96。

## 2026-09-15（九）：修掉「桌面拖一下就消失进某个文件夹」

用户口径：「我在桌面上拖拽移动文件或者文件夹，会消失，然后出现在某个文件夹里」。

根因是上一轮「叠到文件夹上就自动放进去」里那条**几何兜底**把**窗口正文区**也当成了投放目标：
窗口正文是 830×570 的大矩形，被拖的图标（96×110）只要和它叠出 ~29px 就满足「三成重叠」，
于是**指针明明在窗口外的桌面上**、只是图标压到了窗口边缘，文件就被吞进那个窗口所在的文件夹 ✗。
桌面大半被窗口盖着，所以这几乎必然发生。

- 判据 1 改用 `elementsFromPoint`（取整摞元素）：正在拖的图标永远压在指针下，跳过它看下面那一层 ——
  这样「把图标挪到文件夹上」照样认得出，而且只认指针位置（与 macOS 一致）；
- 几何兜底**只保留桌面文件夹磁贴**（小、不会认错），窗口正文区不再参与兜底：
  指针没进窗口就一定不会搬走，指针真的在窗口里才搬（这条 macOS 也是这么做的）。

### 实测（Playwright + 真实 dist，5/5）

窗口盖住桌面中间（x=120、宽 830）的前提下：指针在窗口外（110,400）、图标叠着窗口 → 文件**留在桌面**；
指针在窗口里（600,400）→ 照样搬进该文件夹；指针落在文件夹磁贴上 → 搬进那个文件夹；落在桌面空白 → 留在桌面。
回归：拖拽落点 7/7（含「图标叠着磁贴自动进去」）、鼠标旁边落点 7/7、桌面 24/24、越界 6/6、
图标大小 13/13、壁纸 16/16、`npm test` 96/96。

## 2026-09-15（八）：落到桌面上的东西摆在鼠标旁边

用户口径：「文件、文件夹等按住移动到桌面或者文件夹里，落脚点在鼠标旁边」。

**问题不在拖动过程**（拖动一直 1:1 跟手），而在"从别处搬进桌面"这一路：
`onDrop` 只把条目 move/copy 进 `desktop` 这个存储文件夹，位置谁也没管 ——
于是它们按 `gridPos(index)` 渲染，落到右上角第一格去，跟鼠标差着大半个屏幕（文件夹克隆还固定在 0,0）。

- 新增 `placeAtDrop(clientX, clientY, ids)`：落点 = 鼠标位置（左上角按磁贴中心对齐、再夹一次边界），
  多个条目按 22px 递进错开成一小叠，像 macOS 那样；
- `onDrop` 接住鼠标坐标后调用它：移动用原 id、⌥ 复制用文件服务回读的新 id +
  `copyInto` 现在返回克隆出来的文件夹 id（原来只 clone 不管位置，克隆体固定落在 0,0）；
- 桌面内拖动保持"最近的格位"（离鼠标不超过半格）—— 这是之前就有的口径，没改。

### 实测（Playwright + 真实 dist，7/7）

窗口里的文件拖到桌面（1150,700）→ 磁贴落在 1102,686（中心正对鼠标）；⌥ 复制同样落在鼠标旁边；
文件夹拖到桌面（1100,300）→ 1052,286；搬走的子文件夹不再挂在原窗口里；
桌面内拖动落在最近格位（偏差 ≤ 半格）。
回归：桌面 24/24、拖拽落点 7/7、越界 6/6、图标大小 13/13、壁纸 16/16、`npm test` 96/96。

## 2026-09-15（七）：桌面图标支持自定义大小，栅格跟着大小走

用户口径：「桌面上的文件夹、文件等支持自定义大小，桌面那边的网格吸附改一下，根据文件夹、文件大小进行排列，间距跟 apple mac 的桌面一样。」

### 1 · 大小可调（设置 → 外观与交互 → 桌面图标大小）

- 新增 `oa-desk-icon`（40–96px，默认 58）；桌面磁贴的宽高、文件夹图标、缩略图 / 线性图标全部改吃 `--desk-icon`
  这个变量（与 `--dock-icon` 同一套做法），一个滑块带齐"文件夹 + 文件 + 标签容器"的尺寸；
- 默认 58 时渲染结果与改前**逐像素一致**（文件夹磁贴 88、文件磁贴 96、图标 58），加设置不会顺手把桌面挪位。

### 2 · 栅格跟着图标大小走

- 栅格从写死的 `{108,118}` 换成 `deskLattice(icon, hostW, hostH)`：磁贴 = 图标 + 内边距，
  间距 = round(图标 × 0.35) —— 图标越大间距越大，比例上跟 macOS 桌面一致
  （58 → 116/115，96 → 168/167，40 → 92/91）；
- 首格从「1150,88 往右下两列」改成**右上角第一格、往下排满一列再往左一列** —— 就是 macOS 桌面的顺序；
  行数按窗口高度算，窗口尺寸变了会重算；
- 落格（`snapPos`）与整理（`gridPos`）共用同一条点阵。

### 3 · 整理现在连文件夹一起排

`arrangeDesktop()` 原来只排文件，用户截图里那三个叠在一起的文件夹**按整理也分不开**。
现在文件夹在前、文件在后（与文件夹窗口里的分组同一口径）一起落到栅格上。

### 实测（Playwright + 真实 dist，13/13）

默认 58：磁贴 88/96、图标 58，与改前一致；三个故意叠在一起的文件夹 → 整理后 12 个图标全部落格、两两不重叠；
首格在最右上（right=1420=1440−20，top=60=52+8）；96 → 磁贴 126/134、图标 96、间距 168/167；
40 → 磁贴 70/78、图标 40、间距 92/91；间距随图标大小单调变化；设置落进 localStorage。
回归：桌面 24/24、拖拽落点 7/7、越界 6/6、壁纸 16/16、`npm test` 96/96。

## 2026-09-15（六）：桌面图标不许压到顶栏

用户口径：「桌面顶部那边不可越界」。

根因是上一轮改整组拖拽时留下的：松手落格算的是 `snapPos(s.x + dx, s.y + dy)` —— **没夹取的位移**。
在顶栏上方松手时 `(y - 88) / 118` 会向上取整成负数，格位直接算到 **y = −30**，图标就跑到顶栏上面去了
（截图里那张只露一半的文件夹就是这么来的）。

- 边界抽成模块级一份：`DESK_BOUND = { top: 52, right: 96, bottom: 140 }` + `clampDeskPos()`；
  顶栏 38px、禁入线 52px，右侧与底部也各留一点，别让图标半挂在屏幕外；
- `gridPos` / `snapPos` / `settleEntry` 全部过一遍夹取 —— 落格函数自己保证结果合法，不能指望调用方记得夹；
- **载入旧数据时也夹一次**（`oa-folders` 与 `oa-desktop-icons`）：已经压在顶栏上的图标会被拉回 52，
  不用等用户再拖一次才修好。

### 实测（Playwright + 真实 dist，6/6）

喂进去两处坏数据（文件夹 y=−40、文件 y=−30）→ 载入后所有图标 top ≥ 52（顶栏底边 38）；
往上拖到屏幕外沿松手（开网格吸附，就是会算出负格位那条路）→ 停在 52；往右下拖出画面 → 整个图标仍在可视区内；
桌面文件夹同样压不进顶栏。回归：桌面 24/24、拖拽落点 7/7、壁纸 16/16、`npm test` 96/96。

## 2026-09-15（五）：拖到文件夹上就自动放进去

用户口径：「移动文件到文件夹，自动放进文件夹里」。

### 原来为什么会「没进去」

桌面拖拽松手时是拿 `document.elementFromPoint(指针)` 找投放目标，于是有两处死角：

1. **必须精确压在文件夹磁贴上**才算 —— 指针压在「正在拖的这个图标」上（图标叠着文件夹）时完全不算；
2. 文件夹拖文件夹更容易失效：被拖的磁贴自己就有 `data-drop-folder` 且就在指针下，被判成「自己」、
   被「不能拖到自己身上」的守卫挡掉（只有「后面的文件夹拖到前面的文件夹上」才碰巧能成）。

### 现在

`resolveTarget()` 三条判据从严到宽：

1. 指针底下就是文件夹（**窗口里的子文件夹格子优先于它所在的窗口** —— 拖到哪个文件夹上就进哪个，
   不再一律进窗口当前目录）；
2. 指针压在正在拖的图标上时，用**图标真实矩形**与文件夹求交（矩形按状态算、不读 DOM —— 读 DOM 会慢一帧，
   高亮要晚一步）；
3. 重叠面积要盖住图标三成：路过蹭一下不算，摆上去才算。

拖动过程中落点那一个文件夹/格子会亮一层底色（`.drop-target`，只加底色不画线框，与选中态同一口径），松手即灭。

### 实测（Playwright + 真实 dist，7/7）

指针停在文件夹上方 5px、图标叠着它 → 仍自动进 f1，过程中高亮恰好 1 个、松手消失；
文件夹拖到「排在前面」的文件夹上 → 变成它的子文件夹（旧实现这条路走不通）；
拖到打开窗口里的**子文件夹格子** → 进的是那个子文件夹（不是窗口当前目录）；
拖到桌面空白（什么都没叠上）→ 不高亮、也不搬走。
回归：桌面探针 24/24、壁纸探针 16/16、`npm test` 96/96。

## 2026-09-15（四）：选中态去掉线框、底色调淡

用户口径：「选择文件时，不要出现线框，底部框再淡一点。」

- `.desktop-folder.selected` / `.desktop-file.selected` 去掉那圈 `box-shadow: inset 0 0 0 1.5px`。
  其实这个文件里早就立过同一条口径：`focus` 那一段写着"桌面磁贴的选中/焦点**不要线框**，
  浏览器默认的 focus ring 会画出一个明显黑框，改用**填充高亮**表达" —— 是我自己新加的框违背了它。
- 选中的底色 0.12 → **0.08**；文件夹窗口的 `.file-cell.selected` 同步 0.1 → **0.08**，两处保持一档。

实测：桌面探针 24/24、壁纸探针 16/16 不变（断言按 class 走，不吃样式）；截图确认选中只剩一层淡底色。

## 2026-09-15（三）：桌面框选 + 整组拖拽 + 右键简介 / 编组

用户口径：「1. 文件支持拖拽移动到桌面、文件夹里 2. 支持鼠标按住框选功能拖拽移动，鼠标按住框选后，
右键可编辑群组新建文件夹、删除等 3. 桌面支持鼠标按住框选功能 4. 桌面选择文件右键支持查看简介等功能」。

### 先说哪些本来就有

文件夹窗口里的框选、多选一起拖、多选菜单；访达窗口 → 桌面；桌面图标 → 桌面上的文件夹磁贴 —— 这些**已经存在**。
缺的是：**桌面框选**、桌面**多选整组拖**（原来只能一个一个拖）、桌面图标**拖进"打开的文件夹窗口"**、
桌面右键**没有「显示简介」**、也没有"用所选新建文件夹"。

### 做了什么

1. **桌面框选**：`.desktop` 空白处按下拉橡皮筋（与文件夹窗口共用 `.marquee`），命中判定用图标真实矩形求交；
   点空白清空、Shift 追加；橡皮筋层级在图标之上（z 3）、窗口之下（z 10+）。
2. **选中态**：`.desktop-folder.selected` / `.desktop-file.selected`，与 `.file-cell.selected` 同一套语言。
3. **整组拖拽**：`dragDesktopSelection` 把文件夹（`folders.x/y`）与文件（`desktopIcons`）放进同一套 1:1 跟手逻辑：
   一起位移、松手一起落格；⌘ 仍是"拖到系统"。
4. **放到哪儿**：给打开的文件夹窗口 `.folder-body` 加 `data-drop-folder`，于是桌面（含整组）能拖进文件夹窗口；
   磁贴与窗口统一走 `[data-drop-folder]`。拖动中的图标本身不再算投放目标 ——
   否则拖到自己身上会把文件搬进"自己 id"那个文件夹（探针当场抓到，已修）。
5. **右键**：桌面文件 / 文件夹各加「显示简介」；多选加「显示简介（项数 + 总大小）」与
   「用所选 N 项新建文件夹」；`describeEntry` 把桌面与文件夹窗口的简介合并成一份实现，字段不会两头漂移。
6. 文件夹窗口的多选菜单也补了「用所选 N 项新建文件夹」（用户口径里的"编辑群组"）。

### 顺带修掉一个真缺陷

文件夹窗口框选松手后，浏览器补发的那次 `click` 会走 `.split-main` 的"点空白 = 取消选择"，
把刚框到的东西**全部清空**（探针实测：松手前 2 项、松手后 0 项）。现在用 `marqueeDrag` 标记吃掉这一下。

### 实测（Playwright + 真实 dist + mock 文件桥，24/24）

桌面初始 2 文件夹 + 4 文件；框选命中 4 个文件且不误选文件夹；橡皮筋按下出现、松手消失；点空白清空；
单击 / Ctrl 加选；整组拖拽两个位移一致（−70,+50）且保持选中；文件拖到磁贴进 f1；
文件夹拖到另一个文件夹变成子文件夹；文件拖进打开的窗口进 f2；文件 / 文件夹 / 多选三种「显示简介」都是真实字段；
多选菜单三项齐；「用所选新建文件夹」新文件夹吃下整组且桌面清空；
窗口里框选 3 项 → 新建文件夹吃下（文件进存储、子文件夹改 parentId）。
`tsc --noEmit` 0 error、`npm test` 96/96、壁纸选择器探针 16/16 无回归。

## 2026-09-15（二）：壁纸选择器统一尺寸 + 上传壁纸可调尺寸 / 替换

用户口径：「设计壁纸选择那边，不管是系统壁纸还是用户上传的壁纸，预览图尺寸改为一样，一排 5 个显示，
第六个改为点击显示全部再显示。用户上传的壁纸支持自定义改变尺寸、替换等功能。」
（追问确认：「改变尺寸」= 桌面显示方式 —— 填充 / 适应 / 拉伸 + 自定义缩放与位置，**不动原图**。）

### 1 · 选择器：一个网格、一套尺寸

- 内置主题色与上传壁纸合成一份列表（`wallpaperItems`），共用同一个 `.wallpaper-option` 与 16:10 的盒子。
  之前上传的预览按图片自身比例撑开，和主题色那块差一截 —— 这就是截图里"三块不一样大"的来源；
- 网格固定 **5 列**：默认只铺**一排 5 张**，第 6 张起藏起来；右上角一颗**胶囊按钮「查看更多」**，
  点一下**就地展开**（不是弹窗、不是下拉），再点变「收起」。口径三步到位：第 6 个格子"点击显示全部" →
  胶囊下拉（被否：「不要弹窗形式」）→ 现在这一版：一排 5 张 + 「查看更多」就地展开；
- 上传完新图排在最后、仍在折叠区外 —— 桌面已经换成它，看全点「查看更多」（用户口径就是要它先藏着）。

### 2 · 上传壁纸的 ⋯ 菜单（右键同款）

- **调整尺寸…**：对话框里 填充 / 适应 / 拉伸 + 缩放 50–200% + 水平 / 垂直位置 −50–50%，
  边拖边生效 —— 桌面壁纸与预览图吃同一份 `mediaStyle`，所见即所得；
- **替换图片…**：新图入库后把显示设置搬到新条目、再删旧条目，对用户就是"同一张壁纸换了张图"，大小位置不变；
- **删除**。设置按条目 id 存 `oa-wallpaper-style`，只改画法；删条目时顺手清掉它那份设置。

### 3 · 顺带修掉一个真缺陷

「删除文件夹」的确认框原先挂在 `overlays.dialog`（"有对话框开着"的聚合开关）上，
而新加的「调整尺寸」也要用这个开关 —— 两个对话框会同时打开（探针直接抓到两个 `role=dialog`）。
改成 `open={pendingDelete !== null}`：各自的真值管各自的开关，聚合开关只负责 inert 与原生视图让位。

### 实测（Playwright + 真实 dist，mock 文件桥喂 6 张上传壁纸）

16/16：默认一排 5 张（5 列、1 行、尺寸完全一致 106×66）且第 6 张确实看不到；「查看更多」胶囊
`aria-expanded` 跟着开合走、点开 8 张就地铺成 2 行、再点收回 5 张；全程没有任何下拉面板；
⋯ 菜单三项齐、调整尺寸对话框只有一个；上传后默认仍是一排 5 张、桌面已换新图、点开后新图在列表里（共 9 张）。
（另一轮 13/13 覆盖显示方式：填充 / 适应 / 拉伸 + 缩放 + 位置在桌面与预览图上比例一致、
设置落 localStorage、替换后设置跟到新条目。）
`tsc --noEmit` 0 error，`npm test` 96/96。

## 2026-09-15：顶栏把文件夹统一进访达；程序坞右键加「关闭应用」

用户口径：「打开文件夹上方不需要显示 icon，全部统一到访达里面。程序坞右键添加关闭应用」。

先定位那张截图：红绿灯右侧那排就是 `TopBar` 的「最近窗口」，共 5 个图标 —— 1 个访达 + **4 个方块**。

### 1 · 顶栏一个 App 一个图标，文件夹折进访达

文件夹窗口的 appId 是 `folder:<id>`（见 `openFolder`），而顶栏的 `appLineIcon` 表里没有这一项，
于是每个打开的文件夹都掉进 `|| LayoutGrid` 兜底 —— 用户看到的就是一排一模一样的占位方块。

- 新增 `appIdentity()`：`files` 与 `folder:*` 归一成**访达**这一个身份；
- 顶栏的 `recent` 改成 `recentApps`：**一个 App 一个图标**（保留该身份最新的那个窗口）。
  开多少个文件夹，顶栏都只有那一个访达图标，点它聚焦最近的文件夹窗口。

### 2 · 程序坞右键「关闭应用」

- 顺序：打开 / **关闭应用** / 从程序坞中移除 / 还原默认程序坞；
- 「关闭应用」= 关掉该 App 的全部窗口（逐条 `window/close`，红灯那套"只最小化"的口径不适用于显式退出）；
- 访达的文件夹窗口算访达的窗口（`appWindowIds` 与 `appIdentity` 同一份判据），一起关；
- 没有窗口可关时置灰，不做无效动作。

### 实测（同一份状态种子：应用中心 1 + 访达 1 + 文件夹 4）

用 Playwright 打开 dist + 真实域状态（`manager.serialize` 落的 `oa-wins`），同一套断言跑新旧两份构建
（旧构建 = 当前 .app 里的 dist，只有 `main-*.js` 不同，其余产物哈希一致）：

| 断言 | 旧构建 | 新构建 |
| --- | --- | --- |
| 顶栏图标数 | 6（`layout-grid`×5 + `folder`×1） | **2**（`folder`×1 + `layout-grid`×1） |
| 顶栏最左（最近）图标 | 子文件夹 4（占位方块） | 子文件夹 4（**访达线性图标**） |
| 程序坞菜单 | 打开 / 从程序坞中移除 / 还原默认程序坞 | 打开 / **关闭应用** / 从程序坞中移除 / 还原默认程序坞 |
| 点「关闭应用」 | —（无此项） | 访达 + 4 个文件夹窗口全关，剩应用中心 1 个 |
| 无窗口的 App（系统设置） | — | 「关闭应用」置灰 |

`tsc --noEmit` 0 error，`npm test` 96/96。

## 2026-09-14（五）：Dock 还能挤多少 —— 量清楚后挤掉两笔

用户口径：「还能再流畅丝滑一点吗？」。

先量再动。240 步横扫（约 241 帧）的 CDP trace 显示帧率早就满（120 Hz、p95 9.2 ms、无 >20 ms 长帧），
但**每帧都在重复做一笔没用的工作**。同一份代码、运行时注入 style 关掉某个元素做 A/B/C/D 对照：

| 关掉什么 | RendererRasterWorker | RunStyleAndLayout | BeginMainFrame | SwapBuffers |
| --- | --- | --- | --- | --- |
| A 现状 | 325 / 155.8 ms | 732 / 127.9 ms | 252 / 372.3 ms | 261 / 218.6 ms |
| B 玻璃不模糊 | 275 / 155.9 ms | 732 / 127.1 ms | 250 / 372.9 ms | 258 / **160.6 ms** |
| C 关掉提示气泡 | 206 / **88.9 ms** | 484 / **96.2 ms** | 242 / **291.7 ms** | 241 / 145.7 ms |
| D 两个都关 | 187 / 90.7 ms | 484 / 84.4 ms | 242 / 280.8 ms | 241 / **80.7 ms** |

### 1 · 提示气泡每帧被整批重建（最大一笔）

气泡定位写的是 `bottom: calc(100% + 7px + (var(--s) - 1) * --dock-icon)` —— `bottom` 是**布局**属性，
而 `--s` 每帧都在 7 个槽位上变，于是 7 个带 `backdrop-filter` 的气泡一起重新布局 + 重新栅格化。

- 抬升改走 `transform`（合成器属性，不再触发布局）；
- `--s` **只写给指针下那一个**槽位（其余保持默认 1，它们的气泡本来就不可见）；
- 图标缩放从 `transform: scale(var(--s))` 改成直接写内联 `transform`，不再借道自定义属性；
- 撑开期间气泡只过渡 `opacity`（transform 要跟着 `--s` 逐帧走，再叠一条过渡就慢半拍）。

### 2 · 玻璃底板被 scaleX 拉变形

`backdrop-filter` 在元素的**本地坐标**里对背景取样，transform 作用在结果上 —— 也就是 `scaleX(k)` 会把
已经糊好的背景一起横向拉伸，指针一动背景就在玻璃后面滑。

- 底板拆成两层：`.dock-shadow` 只画投影、照旧 scaleX 撑开；`.dock-glass` **尺寸静止**，
  每帧只改 `clip-path` 把它裁成底板那一段（`--dock-slack: 90px` 与 hook 里的 `SLACK` 必须一致；实测全程所需 ≤61 px）；
- 顺带把逐帧的 `--bg-k` / `--bg-tx` 换成直接写内联 —— 现在**一个自定义属性都不写**
  （写在父元素上的自定义属性会沿继承树失效，实测 UpdateLayoutTree 0.52 ms/帧）。

### 实测（同样 240 步横扫）

RendererRasterWorker 325 → **225**（155.8 → **111.2 ms**，−29%）；
RunStyleAndLayoutLifecyclePhases 732 → **493**（127.9 → 102.2 ms，−20%）；
BeginMainFrame 372.3 → 356.3 ms；SwapBuffers 不变（它由 GPU 侧的 backdrop-filter 决定）。

**结论**：B 行说明玻璃模糊只花 SwapBuffers（约 58 ms / 241 帧 ≈ 0.24 ms/帧）、不花 raster，
真正被每帧重建的是气泡。主线程全程约 1.5 ms/帧，距 8.3 ms 预算还很远 —— 这块**没有掉帧可修**，
能挤的只有这些「每帧重复做、结果却没变」的工作。

验证：`tsc --noEmit` 0 error；`npm run build` PASS；`npm test` 96/96；
实测 `--s` 只出现在指针下那 1 个槽位（静止时 0 个）；气泡底边在放大图标顶边之上 7 px。

## 2026-09-14（四）：Dock 跟随改回原生 1:1（撤掉弹簧）

用户口径：「程序坞那个动效，还是用 apple mac 原生的动效吧」。

- 去掉（三）里加的阻尼弹簧（SPRING_M / K / C、子步长积分、每个图标的目标值与速度数组），
  回到 rAF 逐帧 1:1：指针在哪，放大就在哪。
- 仍然保留的只有**离开**那一下的 CSS 过渡（`.settling`，220 ms）。
- 实测（单次阶跃，指针落在第 3 个图标，`t → 各图标 --s`）：
  0 ms / 10 ms [1.00 …] → **17 ms（下一帧）就已经是终值** [1.12 1.43 1.59 1.43 1.12 1.00 1.00] 并一直保持。
  对比弹簧版同一阶跃要约 **324 ms** 才收敛 —— 这就是「原生」与「追着指针跑」的区别。
- 跟手精度：指针停在 1 / 4 / 7 号图标中心时，最高的那个图标中心分别落在 **480 / 705 / 960**，
  与指针 x **完全一致**（±0 px）—— 悬停的图标始终停在光标下。
- 峰值仍为 1.59；离开后 `.dock` 先 `settling`、随后回到静止（inline 值清空）。

验证：`tsc --noEmit` 0 error；`npm run build` PASS。CDP 探针 6/7 —— 唯一的 FAIL 是断言写错了
（它把「事件到达前的那一帧」当成第一帧来比；逐帧数据显示下一帧即全部到位）。

## 2026-09-14（三）：Dock 跟随加阻尼弹簧；文件夹换成 React Bits 的可开合图标

用户口径两条：

1. 「程序坞的动效这个比较流畅一点：reactbits.dev/components/dock」；
2. 「文件夹的动效：reactbits.dev/components/folder」（追问确认 = 桌面上的文件夹图标 + 访达窗口里的文件夹图标；
   点击行为保持双击打开窗口，悬停时纸张探头、**不播展开动画**）。

### 1 · Dock 跟随：加阻尼弹簧

- 读了 React Bits 的 Dock 源码（`reactbits.dev/r/Dock-JS-TW`）：它顺的原因**不是几何**，而是每个图标的尺寸都过了一条
  `useSpring`（mass .1 / stiffness 150 / damping 12 → ζ≈1.55 过阻尼、时间常数 ≈70 ms，无过冲）；
  它的几何其实是 ±200px 的**线性帐篷**，比我们的 raised-cosine 粗。
- 所以**保留 macOS 几何**，把同一条弹簧加在每个图标的高度上（半隐式欧拉 + 固定 1/240 s 子步长）。
- **弹簧加在哪很关键**：第一版加在指针 x 上，进场时放大会从 Dock 左侧扫过来（像一道浪）；
  改到「每个图标的高度」后实测是整排**同时**长起来，与 React Bits 一致。
- 实测（单次阶跃，指针落在第 3 个图标）`t → 各图标 --s`：
  **0 ms** [1.00 1.00 1.00 1.00 1.00 1.00 1.00] → **24 ms** [1.01 1.05 1.06 1.05 1.01 1.00 1.00]
  → **98 ms** [1.08 1.29 1.40 1.29 1.08 1.00 1.00] → **324 ms** [1.12 1.42 1.58 1.42 1.12 1.00 1.00]（单调无过冲）。
- 收敛后 rAF 会停（不常驻），并停在精确值上。

### 2 · 文件夹图标换成 React Bits 的 Folder（合上态）

- 新增 `FolderIcon`（components.tsx）+ `.rb-folder` 一套 CSS：几何照抄原组件（100×80 底板 + 三张纸 + 两片前板），
  用 `--folder-w` 整体缩放、内部一律 em（1em = 文件夹宽度）。
- 只取**合上态**：悬停时整体上浮、两片前板 `skew(±15deg) scaleY(0.6)` 张开成开口、三张纸各探出 10%。
  没有 open 状态、没有纸张飞出、没有纸张跟鼠标的视差 —— 用户口径是「不播展开动画」，双击仍然直接开窗口。
- 两处使用：桌面磁贴（58px）与访达条目（网格 46 / 列表 24）；颜色 `#278fff`（用户给的），深色下提亮为 `#3f96ff`。
- 悬停触发同时认 `.desktop-folder` / `.file-cell` / `.rb-folder`，所以悬停磁贴的任意位置都会掀开。

验证：`tsc --noEmit` 0 error；`npm run build` PASS；`npm test` **96/96**。
CDP 实测：桌面 2 个文件夹各 2 片前板 + 3 张纸、尺寸 58×46；静止 front `none`、paper y=+10%；
悬停 front `matrix(1, 0, 0.16077, 0.6, 0, 0)`、paper y=0、inner `translateY(-4.64px)`。
快照：`docs/snapshots/2026-09-14-folder-rest.png`、`-folder-hover.png`、`-finder-folders.png`。

## 2026-09-14（二）：访达化文件 App、Dock 菜单气泡化、修掉右键把桌面顶上去了

用户口径四条：

1. 「文件 app 那个改为访达，跟 Apple 一个逻辑，打开就是打开文件夹的意思」；
2. 「app 缩放动态效果一般，不自然」（追问确认 = 点红灯最小化 / 从程序坞唤回那下）；
3. 「程序坞右键弹窗也是上面气泡显示内容」；
4. 「我在程序坞旁边右键后 …… 程序坞会被顶上去」。

### 1 · 文件 → 访达

- App 名改为**访达**（图标本来就是 finder）；
- `content()` 里给 `appId === "files"` 补一个根目录文件夹（`DESKTOP_ID`，显示名「桌面」），
  于是点访达打开的是**同一个文件夹窗口**（侧边栏 + 工具栏 + 图标/列表视图），不再是「尚未实现」占位图；
- 子项筛选从 `f.parentId === shown.id` 改成 `(f.parentId ?? DESKTOP_ID) === shown.id` ——
  桌面根下的文件夹 parentId 是 `undefined`，不归一就一个都列不出来；
- 缩略图 / 取条目 / 快速查看三处原先只认 `FOLDER_PREFIX` 窗口，统一收进 `windowFolderId(win)`；
- 应用中心里访达的副标题从「规划中」改为「本地文件 · 真实存储」。

### 2 · 最小化动效重做

上一版是四段关键帧 + 非等比压扁 + linear，实测读起来像一块被揉掉的纸。改成 macOS 的**缩放效果**：

- **等比**缩放（scaleX === scaleY）到 0.05，不再压扁；
- 72% 之前完全不透明，只在最后一段淡出（提前淡出 = 溶解，不像被吸走）；
- 缓动 `cubic-bezier(0.4, 0, 0.25, 1)`。

实测 `currentTime → scale / opacity`：
**0/58/117/182/242/299/320 ms → 1.000/0.906/0.535/0.211/0.092/0.053/0.050**，
opacity 在 242 ms 仍是 0.96、299 ms 才 0.04；全部采样 scaleX === scaleY。

### 3 · 程序坞右键菜单改成上方气泡

- `ContextMenu` 新增 `anchorAbove` / `className`：菜单**底边**贴在图标上沿上方 12px、水平居中于图标，
  并带一个指向图标的小尾巴（`.context-menu.dock-menu::after`），口径与 `dock-tooltip` 一致；
- 右键空白同样锚在程序坞上沿。实测菜单 box `[top 698, bottom 836]`、程序坞 `top 838` —— 完整浮在上方。

### 4 · 右键把桌面顶上去（真因）

不是程序坞被顶上去，是**整个桌面被滚了**：

- `ContextMenu` 打开时会 `ref.current?.focus()`，焦点移动让最近的滚动容器滚到可见；
- `.desktop` 是 `overflow: hidden` —— **hidden 仍然允许程序化滚动**，于是整块内容（含 Dock）被滚上去；
- 菜单位置还按 `innerHeight - 150` 估算，比 150px 高的菜单本来就伸到屏幕外。

修法：焦点一律 `focus({ preventScroll: true })`；菜单位置改用 `useLayoutEffect` 按**真实高度**算并夹进视口（paint 前一次算完，不产生第二帧跳动）。
实测在程序坞旁边右键：菜单 `[659, 933]` 完整可见，.desktop / document / body 的 scrollTop 全为 0，Dock top 前后都是 838。

验证：`tsc --noEmit` 0 error；`npm run build` PASS；CDP 探针 **12/12 PASS**。
快照：`docs/snapshots/2026-09-14-finder-window.png`、`-dock-menu-bubble.png`、`-dock-menu-beside.png`。

## 2026-09-14：Dock 可右键编辑 + 长按排序；窗口关闭改为最小化

用户口径三条：

1. Dock 还是有点不流畅、掉帧；
2. 要能**右键编辑**，固定的图标要能**长按移动位置**；
3. "app 窗口不要自动关闭，除了设置。其他点关闭按钮默认最小化，动效跟 Apple 一样。"

第 1 条复核后用户明确"目前可以接受"，本轮**不动**（实测 120 Hz 下横扫 240 帧，
p95 9.3 ms、无 >20 ms 长帧；主线程与该动效无关）。

### Dock · 右键编辑

- 右键**图标** → `打开` / `从程序坞中移除` / `还原默认程序坞`；
- 右键**空白** → `添加到程序坞`（子菜单列出被移除的 App）/ `还原默认程序坞`；
- 成员与顺序存在 `oa-dock`。**数组本身就是唯一真值**（缺谁 = 谁被移除），
  读取时**不自动补回**缺失的 App —— 补回来的话用户永远删不掉任何一个；
- 至少保留 1 个（只剩"全局 AI"就没有入口把它加回来了）；被移除的 App 仍可从
  应用中心 / 全局搜索启动，不是不可达。

### Dock · 长按拖动排序（`src/desktop/useDockArrange.ts`）

- 长按 **420 ms** 进入整理态：图标抖动（挂在独立的 `rotate` 属性上，不跟 `--s` 的 scale 抢 transform）；
- 按住期间位移超过 **6 px** 就把这次手势交回普通点击 —— 否则从 Dock 起手拖窗口会被误判成整理；
- 拖动项跟手（`transform: translate(…) scale(1.14)`，`z-index: 5`）；
- 顺序的**真值仍在 App**：拖动中实时回调 `onReorder`，hook 不缓存第二份顺序；
- 兄弟项换位用 **FLIP** 补间 200 ms（React 换 DOM 顺序是一帧内完成的，不补间就是硬跳）；
- 松手后拖动项 180 ms 归位再退出整理态；被长按吃掉的那次 `click` 不启动 App；
- 整理期间 `useDockMagnify` 挂起（槽位交给拖动手势），结束后按新的 `signature` 重新测量。

### 窗口 · 关闭 → 最小化

- 红灯语义由 `appId` 决定：**`settings` 真关闭，其余一律最小化**；
- 最小化 / 恢复动效复刻 macOS 的"吸进 Dock"：目标点 = 该 App 的 Dock 图标中心，
  **在状态翻转那一帧量一次**。必须用窗口 `bounds` 算中心，**不能用 `getBoundingClientRect()`** ——
  最小化态带着上一次动画的缩放，量出来的是那个已经缩到 0.06 的小方块，恢复时会从错的地方展开；
- 关键帧分四段（0 → 挤压 → 0.35×/0.66 → 0.78×/0.30 → 归位 0.06×/0.04），**用 linear**。
  第一版用 `--ease`(0.2,0,0,1) 实测 **117 ms 就已经缩到 0.54**，肉眼是"啪一下消失"；
  换成 linear + 分段后实测 `currentTime → scale`：
  **0/83/125/166/207/241/291/324 ms → 1/0.86/0.72/0.58/0.42/0.30/0.15/0.06**；
- 动画类加上后**不清掉**（换回另一个即可重放）：清掉会立刻恢复 `.window` 的 `appear`，
  恢复窗口时会闪一下。

实测：`tsc --noEmit` 0 error；`npm run build` PASS；`npm test` **96/96**；
CDP 探针 26/27 —— 唯一 FAIL 是探针自己读错了属性（鱼眼写的是 `--s`，不是 `style.transform`）；
用 `--s` 复核：峰值 **1.5902**、撑开区间 **[-55.01 … +55.01] px**、底板 `--bg-k 1.2083`，未回归。
快照：`docs/snapshots/2026-09-14-dock-arrange.png`、`-dock-context-menu.png`、`-window-restore.png`。

## 2026-09-12：顶栏品牌字标整块移除

用户口径："顶部的这个 openarc 去掉"（截图里是红绿灯 + `◈ OpenArc`）。

- `components.tsx` 顶栏里的 `<strong className="wordmark">◈ OpenArc</strong>` **整行删除**；
- 顶栏左侧保留为 **macOS 原生红绿灯**预留的空位（`.topbar` 的 `padding-left`，未动）；
- 顶栏现在只剩：左侧空位 → 最近窗口图标 → 右侧功能按钮 / 本机标签 / 日期；
- `.wordmark` 类**保留**（设计系统画廊仍在用）。

实测：`.topbar .wordmark` 数量 **0**；顶栏文本仅 `本机 · D1`（右侧标签），深浅色各验一遍；
`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：按用户澄清重新启用品牌 mark（登录界面 + 应用图标）

用户澄清：**只去掉顶栏那个**；其它地方仍用他给的矢量，但**只取圆形 mark，不要 "OpenArc OS" 字母**。

- **素材**：从原矢量切出**前两段子路径**（实测 `getBBox()` = `194,659,138×154` 正是那个圆），
  存为 `public/openarc-mark.svg`；字母部分丢掉。
- **登录 / 启动界面**（`BootSurface` / `BootRetry`）：`<strong>OpenArc</strong>` → `.brand-mark`
  （CSS mask + `currentColor`）。实测深色 `rgb(245,245,247)` / 浅色 `rgb(29,29,31)`，尺寸 **46×51**。
- **应用图标**（桌面 / Dock 上看到的那个）：此前是 **Electron 默认图标** ——
  现生成"黑底圆角 + 白色 mark"的 1024 图，`iconutil` 打包为 `build/icon.icns`，
  安装到 `.app/Contents/Resources/electron.icns`（`CFBundleIconFile` 本来就是它），
  再 `touch` + `lsregister -f` 刷新图标缓存。实测安装前后 sha256 一致：`e61be32e402f3944…`。
- 顶栏保持文字 `◈ OpenArc`，未动。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：logo 全部撤掉（顶栏 + 启动界面 + 素材与样式）

用户口径："都去掉吧"。

- 启动界面 `BootSurface` / `BootRetry` 恢复 `<strong>OpenArc</strong>` 文字；
- 删除 `.brand-logo` / `.brand-logo-lg` 样式；
- 删除 `public/openarc-os.svg`（构建后 `dist/` 里也不再出现）；
- 顶栏此前已恢复 `◈ OpenArc` 文字。

实测：`.brand-logo` 数量 **0**、顶栏 `.wordmark` 文本 `◈ OpenArc`、`dist/openarc-os.svg` 不存在；
`npm run build` PASS；`npm test` 96/96。

> 用户提供的原始矢量仍在附件里（`OpenArc_OS_4x3_vector.svg`），需要再启用时随时可重新提取。

## 2026-09-12：顶栏撤掉 logo，恢复文字字标

用户口径："顶部标题栏不需要用这个 logo"。

- `components.tsx` 顶栏恢复 `<strong className="wordmark">◈ OpenArc</strong>`；
- **logo 仍留在启动/登录界面**（`BootSurface` / `BootRetry` 两处 126×30）；
- `public/openarc-os.svg` 与 `.brand-logo` / `.brand-logo-lg` 样式保留（启动界面仍在用）；
- 未触碰其它任何地方。

实测：顶栏文本恢复为 `◈ OpenArc`（浅色/深色都验证过）；`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：接入真实品牌 logo（深浅色自动取色）

用户提供了 `OpenArc_OS_4x3_vector.svg`（1024×768，**黑底白字**）并要求"logo 用这个，深浅色注意颜色"。

- **素材处理**：从原矢量里**去掉黑底 `<rect>`**，只保留字母与圆形 mark，
  viewBox 收紧到图形实际范围 `191 307 645 155`（实测 `getBBox()` 得到），存为 `public/openarc-os.svg`；
- **取色方式**：用 **CSS mask + `background-color: currentColor`**（不是 `<img>`）——
  于是 logo 颜色**自动等于当前文字色**：深色主题 = 白、浅色主题 = 深，**不需要两份素材**；
- **接入位置**：应用顶栏原来的占位文字 `◈ OpenArc` → 真实 logo（84×20）；
  启动态 `BootSurface` 与 `BootRetry` 两处 `OpenArc` 文字 → 大号 logo（126×30）；
- 旧的 `.wordmark` 类**保留**（设计系统画廊仍在用，避免动到 D2-01 的品牌字体断言）。

实测（worktree 构建 + 独立预览端口 4291）：
深色 `color: rgb(245,245,247)` / 浅色 `color: rgb(29,29,31)`，尺寸 84×20；
`npm run build` PASS；`npm test` 96/96；`public/openarc-os.svg` 已随构建进入 `dist/`。

## 2026-09-12：桌面背景去掉 OpenArc 字标与装饰圆

用户口径：桌面背景上的 "OpenArc" 字标、副标题和那个大圆去掉。

- 删掉 `main.tsx` 里的 `.desktop-brand` 区块（字标 + "A space for everything you create."）；
- 删掉 `styles.css` 里的 `.desktop::before`（1050×1200、`border-radius: 48%`、`rotate(-32deg)` 的装饰圆）
  以及 `.desktop-brand` 的全部样式；
- 更新 `tokens.css` 里"品牌字体只允许出现在品牌展示位"的注释：该展示位已按用户口径移除，约束仍有效。

实测：`.desktop-brand` 数量 **0**、`.desktop::before` 计算内容 **none**；
`npm run build` PASS；`npm test` 96/96。

> 注：本次在独立 worktree（`/tmp/oa-wt`，分支 `fix/ui-window-chrome`）完成 ——
> 因为主工作区当时被另一个会话切到了 `feature/d3-02-object-authorization`，
> 为避免在两边的未提交改动里互相污染。

## 2026-09-12：移除顶部磨砂渐变 + 窗口阴影调小调浅

用户口径：① 窗口阴影不要那么大那么深；② 深浅色下顶部出现"角"，穿帮；③ 模糊渐变去掉；
④ 不要乱改代码，避免修一个坏一个。

本次**只动这两处**：

1. **顶部磨砂渐变整层移除**：删掉 `.desktop-scrim` 的元素、CSS（含 `::before` / `::after` 两层模糊、
   mask、`[data-split]` 规则）与 `main.tsx` 里的渲染块和 `isSplitApp` 辅助函数；
   并**一并撤回它带来的副作用** —— `.pane-toolbar` 的 `position: sticky`（没有磨砂兜着，贴顶会压在
   滚动内容上）。全仓已无 `desktop-scrim` / `isSplitApp` 引用。
   → 用户说的"顶部出现角"就是这个磨砂层方角压在窗口圆角上造成的，随之消失。
2. **窗口阴影调小调浅**：
   - 浅色：`.window` `0 6px 20px / 0.08` → `0 4px 14px / 0.07`；
     `.window.active` `var(--shadow)`(12px/40px/0.16) → `0 6px 18px / 0.1`；
   - 深色：`.window` `0 18px 46px / 0.7` → `0 8px 20px / 0.35`；
     `.window.active` `0 24px 60px / 0.85` → `0 10px 26px / 0.45`。

验证：`npm run build` PASS；`npm test` 96/96；**D1-04 `glass-tiers` 与 `glass-switch` 两个探针均 exit 0**
（确认没有连带破坏）。

## 2026-09-12：顶部磨砂常驻 + 找到"看不见"的真正原因（Chromium 行为）

**根因（实测）**：给磨砂条临时加一个红底，它确实在正确位置绘制（顶部 R=154）——
但**底色为全透明时，Chromium 不把 `backdrop-filter` 的结果画出来**（同一画面开/关像素差 = 0）。
这就解释了为什么：
- 我做成"只有模糊、底色全透明" → **看不见**（用户连续说"没有"）；
- 我做成"接近实心的材质" → 又像贴着一块板（用户说"有一层颜色 / 太刻意"）。

**现在的做法（= macOS 真正的做法）**：半透明材质 **+** 模糊，**常驻**：
```
background: linear-gradient(surface/1 × 0.40 → 0.22 → 0.08 → 0)   顶部约 40%，向下渐隐
::before blur(7px) + ::after blur(16px)                           两层渐进模糊
```
同时：整窗宽、mask 挖掉侧栏卡（卡片与红绿灯清晰）、不动任何布局（`.split-main` 仍是 64px）。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：回退我自己多加的两处改动（止住反复横跳）

用户反馈"越改越差"。复盘：最近两轮我**自己加了两个你没要求的东西**，是这轮变差的直接来源 ——

1. 把设置类窗口的 `.split-main` 上边距从 64px 改成 **120px**（为了让标题让开磨砂带）；
2. 把设置类窗口的磨砂改成**常驻**。

两处都已**回退**：
- 上边距恢复 **64px**（实测 `h1` 距窗口顶 64px，与之前一致）；
- 磨砂恢复成你明确说过的口径：**只在该窗口内容滚动后出现**（未滚动时 `scrims = 0`）。

其余保持不变：整窗宽、mask 挖掉侧栏卡（红绿灯与卡片清晰）、**纯 blur 无底色**。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：设置类窗口的顶部磨砂改为**常驻**（文件夹窗口仍"滚动才触发"）

先在**真实 `.app`** 里验证机制：设置窗口 `scrollH 777 / clientH 570`（可滚动），
`scrollTop = 120` → `.desktop-scrim` **出现 1 个**。所以机制没问题，
用户那张截图是**没滚动的顶部**，按上一轮口径那里本来就不出现。

既然要看得见，改成：

- **非文件夹的分栏窗口（设置 / 应用中心 / Skill）：磨砂条常驻**；
- 并把它们的 `.split-main` `padding-top: 64px → 120px`，让标题落在磨砂带**下面** ——
  否则标题自己会被糊掉（那正是最初"太刻意"的来源）；
- **文件夹窗口保持"滚动才触发"**（它顶部就是工具条，常驻会把工具条糊掉）；
- 其余不变：整窗宽 + mask 挖掉侧栏卡 + 纯 blur 无底色。

实测：设置窗口未滚动时 `.desktop-scrim` 已存在，`h1` 距窗口顶 **120px**（在磨砂带之下）。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：磨砂条的滚动状态改为"每次渲染都核对"（避免状态陈旧）

用户反馈"顶部的模糊渐变怎么没了"。复现结论：**机制是好的** —— 内容确实溢出且真的滚动之后，
磨砂条会出现（实测 `scrollTop = 98` → `.desktop-scrim` 出现，且 box 与窗口框完全对齐 142..972）。
用户截图那一帧是**内容没滚动**的状态（该窗口高度下 `scrollHeight == clientHeight`，设置页并不溢出），
按此前"滑上去才触发"的口径，这时本来就不该出现。

顺手把这个状态做稳：原来只靠 scroll 事件，会漏掉"容器被换掉 / 内容变短后 scrollTop 归零 / 切换标签"
这类情况，状态会停在旧值。现在**每次渲染后再核对一次真实 `scrollTop`** 并上报。

实测：滚动前 scrim 0 个、滚动后 1 个且与窗口框对齐；`npm test` 96/96。

## 2026-09-12：顶部磨砂恢复整窗宽 + 用 mask 挖掉侧栏卡（边缝不再穿帮）

用户反馈：侧栏卡四周那圈 8px 边缝没被糊到，露出没处理过的桌面 → 穿帮；
但**也不要把侧栏卡和红绿灯糊掉**。

- 磨砂条恢复**整窗宽**（`left = w.bounds.x`、`width = w.bounds.w`），分栏窗口不再从 208px 处才开始；
- 用 **CSS mask 挖洞**排除侧栏卡：`mask-image: <纵向渐隐>, linear-gradient(#000,#000)`、
  `mask-size: 100% 100%, 192px 68px`、`mask-position: 0 0, 8px 8px`、**`mask-composite: exclude`**
  （`-webkit-mask-composite: xor`）。本体 + 两层模糊伪元素各写一份（每层带自己的渐隐）；
- 结果：**卡片四周那圈边缝被糊到，卡片与红绿灯保持清晰**；
- 非分栏窗口（没有侧栏卡）仍只避开左侧 76px 的红绿灯区。

实测：`.desktop-scrim` 的 box 与窗口 box 完全对齐（142..972）、`data-split="1"`、
`mask-composite: xor`；截图里红绿灯与侧栏卡顶清晰、内容顶行被糊。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：隐藏应用内滚动条

用户口径：滑动时右边不要出现那条滚动条。

- `.desktop * { scrollbar-width: none }` +
  `.desktop *::-webkit-scrollbar { width: 0; height: 0; display: none }` ——
  覆盖应用内**所有**可滚动容器（窗口内容、侧栏、Quick Look 文本…）；
- 只影响我们自己的 DOM；内置浏览器窗口的原生视图是独立 `WebContentsView`，不受影响；
- **滚动能力不变**，只是不画轨道/滑块。

实测：`.split-main` 的 `::-webkit-scrollbar` 计算值为 `display: none` / `width: 0px`，
同时 `scrollTop = 200` 仍然生效。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：顶部「透明磨砂」终于对了 —— 把它从窗口里挪到**窗口外**

用户第三次说"还是有一层颜色"。这次做了**像素级对照实验**（同画面 scrim 开/关逐行比对），
量出顶部那条的**蓝色被压掉 74 级**，且两个反直觉现象：
- **给 scrim 加 `saturate()` 完全没用**（计算值已生效，像素零变化）；
- **把窗口自身的 `backdrop-filter` 关掉，色偏方向立刻反转**（-74 → +86）。

结论：**嵌套 `backdrop-filter`**。scrim 画在窗口内部时，窗口自己那层
`blur(40px) saturate(1.8)` 会在该区域被丢掉，于是顶部显示的是"没被滤镜处理过的原始底色"。
也就是说，这一层必须画在**窗口之外**，才能采样到真实合成结果。

修法：
- `Window` 不再自己渲染磨砂条，改为通过 `onScrolledChange` 只上报"内容是否已滚动"；
- 由**桌面层**按该窗口的 `bounds` 绘制 `.desktop-scrim`（`z-index = 11 + w.z`；
  分栏窗口避开 208px 侧栏卡、非分栏窗口避开 76px 的红绿灯区）；
- 纯 `blur(7px)` / `blur(16px)`：**无底色、无 saturate**。

**实测（同画面开/关，取工具栏空白区）**：色差从 **-74 / +60 级** 降到 **≤ 3 级**；
整体差异 8.77 全部来自"内容被糊掉"——这正是要的效果。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：顶部改为「透明磨砂」—— 只有模糊，没有底色

用户原话澄清：**滚动时顶部那边的文字 / 图片会变模糊，但那一层本身没有任何底色**。
（我前几轮把"材质底色"当成磨砂的必需品，方向错了 —— 那正是用户否掉的那块板子。）

- `.window-scrim { background: none }` —— 彻底没有底色（连渐变都没有）；
- 效果**全部来自 `backdrop-filter`**：`::before blur(20px)`（铺满整段）+
  `::after blur(52px)`（只在最上层），各带向下渐隐 mask；
- 只在滚动之后出现；工具条 `sticky` 保留。

实测：`.window-scrim` → `background-image: none`、`background-color: rgba(0,0,0,0)`、
`::before blur(20px)`、`::after blur(52px)`；截图里滚上去的图标被糊掉，但**没有任何色块 / 板子**。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：把磨砂找回来 —— 关键是"窗面色材质层"

用户连否两版，其实分别撞在两个极端：
- 第一版：材质底色几乎实心 → **"太刻意"**；
- 第二版：把底色归零（只剩 blur）→ **"壁纸花色直接透出来"**。

**物理上磨砂必须同时有两样东西**：模糊负责"磨砂质感"，材质层负责"把背后壁纸的颜色压住"。
这次按 macOS `headerView` 的口径重做：

- `background` 用 **`--surface` 渐变**（0.96 → 0.88 → 0.5 → 0），把壁纸颜色压住；
- `::before blur(20px)`（铺满整段）+ `::after blur(52px)`（只在最上层）→ **渐进模糊**；
- **只在滚动之后出现**（`Window` 的 `scrolled` 状态 + document 捕获级 scroll 监听）；
- 工具条恢复 `position: sticky`（下面有磨砂层兜着，内容不会糊成一团）；
- 不加深色高光、不加落影。

实测（浅色 + 亮色壁纸）：滚动前 `.window-scrim` **0** 个 → 滚动后 **1** 个；计算值
`linear-gradient(rgba(255,255,255,0.65), …)`、`::before blur(20px)`、`::after blur(52px)`、工具条 `sticky`。
顶部读起来是"磨砂玻璃板"，而不是"透出来的花色"。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：撤掉窗口顶部磨砂层（用户要"全透明"）

用户连续三次反馈顶部"还是有主题色"。**根因就是这个功能本身**：只要这一层存在（哪怕是纯 `blur()`），
背后那张高饱和壁纸就一定会透出来（只是被糊成一片渐变）。所以"全透明"唯一成立的做法是**不要这一层**。

- 删掉 `.window-scrim` 的元素与全部样式（含 `::before` / `::after` 两层 backdrop blur 与 mask）；
- 以及 `Window` 里为它服务的 `scrolled` 状态与 document 捕获级 scroll 监听；
- 连带把 `.pane-toolbar` 的 `position: sticky` 撤回 —— 磨砂层没了之后，贴顶的工具条会悬在滚动内容上、
  又没有背景可依靠。工具条恢复"随内容一起滚"。
- 清理了顶栏注释里对 window-scrim 的引用。全仓已无 `window-scrim` 引用。

实测：`.window-scrim` 计数 **0**、工具条 `position: static`、滚动后顶部**没有任何色带 / 底框**。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：磨砂层去掉提色（顶部不再"染主题色"）+ 侧栏再降透明

用户反馈：顶部"还是有主题色"；侧栏还要更透、更有磨砂质感。

- **顶部那层"主题色"的真因是 `saturate()`**：模糊层带 `saturate(1.6 / 1.9)` 时会把背后的壁纸颜色
  **提亮**，看起来就像顶部又染了一层主题色。→ 两层模糊改为**纯 `blur()`**（16px / 64px），
  不提色、不加亮；磨砂条本身依旧是**零材质底色**（`background: none`）。
- **侧栏**：底色 `0.34 → 0.24`；磨砂 `blur(36px) saturate(2) brightness(1.16)`
  → `blur(46px) saturate(1.6)`（更透、更厚，去掉 brightness 提亮）。

实测：`.window-scrim` → `background-image: none`、`::before blur(16px)`、`::after blur(64px)`（无 saturate）；
侧栏 → `rgba(23,23,23,0.24)` + `blur(46px) saturate(1.6)`。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：窗口顶部改为「纯磨砂」（材质底色透明度 0%）

用户口径：窗口顶部那条渐变，**材质底色直接归零** —— 只要磨砂玻璃本身。

- `.window-scrim { background: none }`（原来是 content 色的四段渐变）；
- 同时删掉深色下那层白色高光叠加（`.desktop.dark .window-scrim`）——它也属于"材质底色"；
- **两层渐进模糊与 mask 原样保留**：`::before blur(14px) saturate(1.6)`、
  `::after blur(56px) saturate(1.9)`（越靠顶越糊、向下连续衰减）。

实测：`.window-scrim` 计算值 `background-image: none`、`background-color: rgba(0,0,0,0)`，
`::before` / `::after` 的 `backdrop-filter` 仍在。滚上去的内容依旧被糊掉，**没有任何底色或硬边**。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：修「降低材质」红绿灯底框 + 顶部渐变透明度减半 + 玻璃档位回归修正

1. **降低材质时红绿灯"穿帮、多一层底框"** —— 真因在设计系统那侧：
   `.desktop[data-glass="reduced"] .window-title` 会把材质下沉到标题条那条 44px 窄带；
   但**分栏窗口的标题条只有 208px 宽、正好压在侧栏上**，于是侧栏之上多出一块"白底框"，
   红绿灯像浮在一块白板上。→ 把这条规则**排除分栏窗口**（`:not(:has(.split))`）——那块区域本来
   就由侧栏负责；`inset` 高光那条同样排除。
   实测：降低材质档下分栏窗口标题条 `rgba(0,0,0,0)`、`box-shadow: none`。
2. **窗口顶部渐变透明度降至 50%**：`.window-scrim` 材质 stops 由 0.45 / 0.38 / 0.16
   → **0.225 / 0.19 / 0.08**；深色下的白色高光 0.03 / 0.012 → 0.015 / 0.006。
3. **顺带修一个我自己引入的档位回归**：之前为"侧栏玻璃"加的正文/侧栏透化只排除了 `solid`，
   于是**降低材质档也被透化**（正文 0.27），而 D1-04C 对该档的定义是"**正文实色、只去模糊**"。
   → 三条规则改为只作用于 `[data-glass="full"]`。实测三档：
   - full：正文 `rgba(23,23,23,0.27)`、侧栏 `rgba(23,23,23,0.34)`
   - reduced：正文 **`rgb(23,23,23)`（实色）**、侧栏实色
   - solid：正文透明（由窗口自身承担）、侧栏 `rgb(14,14,14)`

验证：`npm run build` PASS；`npm test` 96/96；**D1-04 两个探针都 exit 0**
（`glass-switch` 日志 6× `select 同步 storage 同步`；`glass-switch-stress` 477 帧 p95 9.3ms、>33ms 0 帧）。

## 2026-09-12：材质也改胶囊三态 + 同步更新 D1-04 探针的驱动方式

- **材质**（完整玻璃 / 降低材质 / 实色）从 `select` 改为与"外观"同款的 `.segmented.text` 胶囊分段控件，
  设置页与控制中心一致。实测：点击「降低材质」→ `oa-glass = reduced`、桌面 `data-glass = reduced`。
- **D1-04 探针必须同步**：`glass-switch.mjs` / `glass-switch-stress.mjs` / `perf-product.mjs`
  原来都靠 `page.selectOption(".material-select", tier)` **驱动产品设置窗口**（这是回归基线），
  改成胶囊后这条路失效 —— 已把它们改成**点击对应胶囊**，回读也改为读 `aria-pressed` 的当前项、
  再映射回 `full/reduced/solid`，**断言契约（data-glass / storage / select 三者一致）完全不变**。
  设计系统画廊（`src/design-system/gallery.tsx`）里的 `.material-select` 属于另一个面，**保持原样**。

实测：`node experiments/d1-04/glass-switch.mjs` → **exit 0**，日志逐档打印 `select 同步 storage 同步`，
产物 `artifacts/d1-04/glass-switch.json` 中 `baseline.select = "full"`（从新控件读出来的）。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：磨砂条改为「滚动才触发」+ 外观改胶囊三态 + 去掉全部小字说明

1. **顶部磨砂只在内容滚上去后才出现**（用户口径：常驻太刻意）：在 `Window` 里给 body 挂一个
   document **捕获级** scroll 监听（scroll 不冒泡，捕获能收到所有滚动容器的事件），
   当 `.split-main` 的 `scrollTop > 4` 才渲染 `.window-scrim`。
   实测：顶部 **0** 个 → 滚动后 **1** 个 → 滚回顶部又变 **0** 个。
2. **外观改胶囊三态**：下拉换成 `.segmented.text` 胶囊分段控件（跟随系统 / 浅色 / 深色），
   设置页与控制中心一致；当前项高亮走 `aria-pressed`。
   实测：`["跟随系统","浅色","深色"]`，`aria-pressed` 命中「跟随系统」。
3. **去掉全部小字说明**：`footnote` 全清（外观 / 材质 / 壁纸三处行内说明 + Adobe 与 API 密钥两段）。
   实测 `.footnote` 计数 = **0**。
   - 顺带修一处对比度：浅色色板（`theme-light`）上的标签改用深色字，原先白字看不清。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：壁纸只留「浅色 / 深色主题色」+ 外观可跟随系统

用户口径：壁纸只保留深浅色主题色、其他删掉；并加"主题跟随系统"。

- **壁纸**：内置预设从 4 套渐变（极光 / 石墨 / 午夜 / 纯黑）**加上**动态 Aurora，收敛为**两种主题色**
  （浅色主题色 / 深色主题色）；同时**删掉动态 Aurora 的整套实现**（Canvas/WebGL 着色器、配色常量、
  桌面菜单里的"动态 · Aurora"入口、`.aurora-canvas` 样式、删除自定义壁纸时的旧回退值）——
  全仓已无 `aurora` 残留（`grep` = 0）。**自定义壁纸（上传静态 / 动图 / 视频）保留**。
- **外观跟随系统**：`深色外观` 开关改为**三态选择**：跟随系统 / 浅色 / 深色（设置页与控制中心都有）：
  - 新增 `oa-theme`；读取时优先它，缺省回退旧的 `oa-dark` 布尔（兼容既有数据），并继续写 `oa-dark`；
  - 用 `matchMedia("(prefers-color-scheme: dark)")` 并监听 `change` —— 系统切换时**实时跟随**，无需重启；
  - 默认值 = **跟随系统**。
- 默认壁纸 = 深色主题色。

实测：
- `colorScheme: light` + `oa-theme=system` → 桌面**无** `.dark`；切 `dark` → 有；切 `light` → 无；
  切回 `system` → 跟随系统（无）；`oa-theme` 正确持久化。
- 壁纸选项 = `["浅色主题色","深色主题色"]`；桌面右键子菜单 =
  `["浅色主题色","✓深色主题色","自定义壁纸请到设置里上传"]`。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：顶栏下沿那条"小框" —— 去掉顶栏的 backdrop-filter（合成层残留）

用户补充关键线索：**点开全局 AI 就没、关掉又出现**。

排查过程：
- 在**真实应用**里扫描顶部 150px 内所有"有底色 / 有 backdrop-filter / 有阴影"的元素：
  只有 `.topbar` 与 `.assistant-pill` 两个，**没有任何元素对应那条带**；
- 打开 AI 前后的元素差集是**空**（打开态只多出 `.ai-panel`）；
- 打开/关闭的截图对比也没有稳定复现（我的机器/GPU 上不复现）。

→ 结论：那是**渲染层残留**，不是 DOM。它紧贴顶栏下沿、横贯全宽、带蓝色（极光壁纸被模糊后的颜色），
  形状与尺寸正是**顶栏 `backdrop-filter` 的合成面**；开关覆盖层会触发重新合成，所以"开就没、关就又出现"。
  与 Chromium 在"透明窗口 + `app-region: drag` + `backdrop-filter`"组合下的层错位已知问题一致。

处理：**去掉顶栏的 `backdrop-filter`**（它底色本来就是 0，这层 blur 几乎没有视觉产出 —— 改动前后
顶栏截图一致，已逐像素核对），并给它加 `transform: translateZ(0)` 固定到自己的合成层。
窗口滑到顶栏下方时的磨砂由窗口自己的 `.window-scrim` 承担，不受影响。

**诚实说明**：这条残留我**没能在本机复现**（真实应用 DOM 无对应元素、开关前后截图也无稳定差异），
所以以上是"按证据定位 + 消除成因"，需要你那边再确认一次。若仍在，下一个嫌疑是 `.window-scrim` 的
两层 backdrop-filter，我会用同样方式摘掉。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：窗口顶部"多出来的小框"—— 根因是上一轮把磨砂条顶部设成了全实心

用户问：软件窗口顶部那边为什么有一个小框？

**查证**：那是 `.window-scrim` 的**全实心顶带** —— 上一轮为了"不穿帮"，我把 0–20% 直接设成
`rgb(surface / 1)`；而窗口正文此刻只有 **0.27**。两者透明度差太大，接缝就在窗口顶边形成一条
**硬边横带/小方块**，看起来像凭空多了一个框。

修法（**无缝 + 依然不穿帮**）：
- 磨砂条底色改成**与正文同一透明度起步**（`content` × 0.45 → 0.38 → 0.16 → 0），
  不再出现任何硬边材质缝；
- "不穿帮"改用**更狠的模糊**实现：顶层 `blur(34px)` → **`blur(56px)`**，mask 覆盖 30–70%。
  效果是"糊到不可读"，而不是"被一块实心板盖住"。

**实测**（最大化窗口，最容易复现该现象的场景）：逐行扫描窗口顶部 36–68px 的亮度，
窗口内部 38→68px 为 **31.2 → 27.9 平滑过渡（相邻行最大差 < 1）**；唯一的台阶在 36→38，
那是**顶栏与窗口的正常交界**，不是接缝。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：红绿灯提到最上层 + 磨砂顶部做实（不再"穿帮"）

1. **窗口红绿灯要在最上层**：根因是 DOM 渲染的红绿灯与侧栏卡片**同为 `z-index: 2`**，
   而侧栏在 DOM 里更靠后 → 侧栏把它盖住了。
   → 标题栏（含红绿灯）提到 **`z-index: 3`**（侧栏 2、磨砂条 1）。
   实测：`titleZ 3 / sideZ 2 / scrimZ 1`；在红绿灯中心做 `elementFromPoint`，命中 **`.traffic`**（不是侧栏）。
2. **顶部磨砂要越来越实，否则"穿帮"**：顶部给了接近实色，再往下才渐隐 ——
   `surface/1` 0% → `surface/1` 20% → `surface×0.62` 48% → `surface×0.28` 74% → `0` 100%。
   这样内容滚上去会被**完全吃掉**，不会从磨砂里透出半截文字/图标。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：磨砂条横跨整窗（侧栏在上层）+ 侧栏再调透 + 找回被误删的搜索框

1. **磨砂条覆盖全窗口、侧栏在最上层**：`.window-scrim` 恢复 `left: 0`（横跨整窗），
   并把 `.window:has(.split) .split-side` 提到 `position: relative; z-index: 2`（磨砂条是 1）——
   于是磨砂条横跨整窗，而侧栏这块卡片始终盖在它上面、不会被压住。
   实测：窗口 x142..972，**scrim x142..972（整窗）**，侧栏 z-index **2** > scrim **1**。
2. **侧栏还是太实**：alpha 0.5 → **0.34**，材质层 6% → 7% 白，vibrancy 提到
   `blur(36px) saturate(2) brightness(1.16)`。实测 `rgba(23,23,23,0.34)`。
3. **"文件夹里的搜索功能被删了"** —— 这是我上一轮改坏的：窄窗口的容器查询把 `.search-field`
   直接 `display: none`（830px 窗口命中 ≤920 那条），看起来就像功能被删。
   → 删掉那条规则，改成**搜索框永不隐藏、自己收缩**
   （`flex: 1 1 auto; min-width: 108px; max-width: 240px`，输入框 100%）。
   实测：`display: flex`、宽 240px、输入框 206px，830px 窗口下正常显示。
   顺带把"隐藏排序"也去掉（现在只隐藏两个本来就 disabled 的共享/标签）。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：磨砂条收手（去阴影 / 不盖侧栏）+ 侧栏给到"材质差"

用户反馈：① 顶部磨砂太刻意（去掉阴影、不要覆盖到左侧边栏）；② 侧栏还是很实、没有玻璃质感。

- **① 磨砂条收手**：
  - 去掉落影（实测计算值 `box-shadow: none`）；
  - 材质底色与高光都调淡（surface 0.62 / 0.36 / 0.14；高光 0.03 / 0.012）；
  - 强模糊层 44px → **34px**；
  - **有侧栏的窗口 `.window:has(.split) .window-scrim { left: 208px }`** —— 磨砂条从侧栏右侧开始。
    实测：窗口 x=142 宽 830；侧栏 x=150..342；**scrim x=350..972**（完全避开侧栏）。
- **② 侧栏"实"的根因有两个，不是一个**：
  1. **背后没有东西可磨** —— 正文太实（上一轮 `* 0.62`，本轮 `* 0.45`，实测
     `rgba(23,23,23,0.27)`）；
  2. **侧栏与正文同色同透明度** → 看起来就是一块实心板。macOS 侧栏"是另一种材料"主要靠
     **比正文略亮一档 + vibrancy（提饱和、提亮）**。
     → 侧栏加 6% 白色材质层 + `blur(34px) saturate(1.9) brightness(1.1)`。
     实测：侧栏均值 RGB **[39,39,39]** vs 正文 **[25,30,39]**（每通道差 [15,9,1]）。
- "实色"档仍然全程不受影响。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：磨砂条横跨整个窗口 + 窗口正文更透（侧栏玻璃才有东西可"磨"）

用户反馈：① 侧栏还是看不出磨砂质感与透明度；② 顶部渐变只在主内容区，要整个窗口生效。

- **① 的根因**：**窗口正文接近实色**，侧栏背后就是一块纯色 —— 玻璃背后没有可"磨"的东西，
  侧栏再透明也看不出质感。→ 玻璃档下把正文调透：
  `.desktop:not([data-glass="solid"]) .window-body { background: rgb(var(--content-rgb) /
  calc(var(--content-alpha) * 0.62)); }`（实测 `rgba(23,23,23,0.373)`）；
  侧栏保持 50% + `blur(34px) saturate(1.8)`。两者叠加后壁纸能透过窗口与侧栏。
- **② 磨砂条从"分栏内容区"提到窗口层级**：`Window` 组件在 `.window-body` 之后渲染 `.window-scrim`，
  `position: absolute; top/left/right 0; height: 76px; z-index: 1`。
  实测：窗口宽 830、scrim 宽 **830**（完全对齐，横跨侧栏 + 内容区）；工具条（z-index 3）仍在它之上。
- 上一轮的渐进模糊（两层 `backdrop-filter` + 不同斜率 mask）保持不变，只是作用面变成整窗。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：磨砂玻璃按 macOS 口径复刻（多层渐进模糊）+ 侧栏透明度 50%

用户反馈：侧栏透明度要到 50%；窗口顶部的磨砂依然看不出来，要求按 Apple 的做法复刻。

- **macOS 的口径是"渐进模糊"**：不是一条硬边模糊，而是**多层 `backdrop-filter` 叠在同一段高度**、
  每层用**不同斜率的 mask**，模糊强度自上而下连续衰减。按这个重写 `.split-scrim`：
  - 第 1 层 `blur(14px) saturate(1.6)`，mask 覆盖近整段（顶→52%→100% 渐隐）
  - 第 2 层 `blur(44px) saturate(1.9)`，只在最上面一段（顶→24%→62%）
  - 材质底色（surface 渐变）+ 深色下额外一层极淡高光，让这条工具栏**自己成立**（不靠内容）
  - 底沿一道柔和落影，把它"托"出来
  - 父层**刻意不加** `backdrop-filter`：否则子层的 backdrop 采样不到真实内容
  - 高度 64 → **76px**，渐变更连续
- **侧栏透明度 = 50%**：显式 `rgb(var(--content-rgb) / 0.5)`（不再乘 token），模糊提到 `blur(34px) saturate(1.8)`；
  "实色"档仍不受影响。

**客观实测（不是看感觉）**：同一窗口滚动后，取顶部那条做"有 scrim / 无 scrim"对比 ——
- 高频细节（FIND_EDGES 均值）：**6.15 vs 9.75**（降 37% → 模糊确实生效）
- 亮度：**44.0 vs 34.2**（顶条亮出一档 → 成了一条可辨识的材质带，不再隐形）

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：极光"动起来"（真的看得出来）+ 窗口顶磨砂可见 + 自定义壁纸可删除

1. **动态壁纸"没动"** —— 连进**正在运行的 .app** 读真实状态：`oa-wallpaper = "aurora-live"`、
   `oa-motion = "false"`、桌面无 `.reduced`，且相隔 1.5s 的两帧**确实不同**：
   它一直在动，只是**动得太慢太淡**（速度 0.030/s、增益 0.9×，深色底上肉眼看不出来）。
   → 着色器速度提到 `0.115 + i×0.075`、纵向漂移 3 倍、增益 1.5×；2D 兜底版漂移也提速。
   实测：1.2s 内 **20.8% 的像素发生变化**（平均差 2.28）。
   另：之前用探针读到的 `oa-wallpaper` 是**另一个 file:// 源**的 localStorage，不是应用自己的；
   已改用 CDP 直连运行中的应用读取，避免再被误导。
2. **窗口顶部磨砂看不出来** —— `.split-scrim` 之前只有 `backdrop-filter`、**没有底色**，
   内容没滚上去时等于隐形。→ 增加可见玻璃渐变
   `linear-gradient(rgba(23,23,23,0.46) → 0.25@44% → 0)`，与原有的 blur + 向下渐隐 mask 叠加。
3. **自定义壁纸支持删除** —— 设置页每个自定义壁纸右上角加 `✕`（悬停/聚焦才出现），
   删除走真实的 `files.remove("wallpapers", id)`；删掉的正好是当前壁纸就退回内置极光。
   实测：点 ✕ → `remove("wallpapers","w1")`。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：窗口内的顶部磨砂渐变（纠正上一轮的理解偏差）

用户澄清：磨砂渐变要的是**窗口内部**（内容往上滚时钻进工具栏下面被吃掉），不是软件顶栏。

- 撤掉上一轮加在**软件顶部**的 `.topbar-scrim`（元素与样式都删）。
- 新增 `.split-scrim`：`position: sticky` + `top: 0` + 负 `margin-bottom`（**不占布局高度**），
  56px 高、`backdrop-filter: blur(16px) saturate(1.4)`、向下渐隐 mask，`z-index: 2`。
  它始终贴在滚动容器顶部，blur 作用在**从它下面滚过去的内容**上。
- `.pane-toolbar` 改 `position: sticky; top: 0; z-index: 3`：工具条自己贴顶，内容从它下面滚过去。
- 四个分栏窗口（文件夹 / 应用中心 / 系统设置 / Skill 中心）都插入了 `.split-scrim`。

实测：`.topbar-scrim` 0 个；设置窗口与文件夹窗口各 1 个 `.split-scrim`；
文件夹工具条 `position: sticky`；滚动 900px 后工具条 y 仍为 **146**（钉住不动）。

验证：`npm run build` PASS；`npm test` 96/96；`security-surface` 17/17。

## 2026-09-12：动态壁纸换 WebGL 极光帘 + 顶栏磨砂渐变 + 侧栏玻璃 + 系统文字不可选

1. **动态壁纸（Aurora）真的动起来**：把 Canvas 2D 柔光版换成 **WebGL 片段着色器**
   （对齐 reactbits.dev/backgrounds/aurora 的极光帘观感）：5 阶 fbm 噪声塑形的三层帘幕横向漂移，
   颜色用用户给的三色 `#6b6b6b / #717171 / #292929`；无第三方依赖；`reduced` 时冻结时间；
   WebGL 不可用时回退到 Canvas 2D。
   实测：canvas 拿到 `webgl` 上下文，相隔 1.4s 的两帧**不同**（218720 → 219392 字节）。
2. **顶栏磨砂渐变**：新增 `.topbar-scrim` —— fixed / 96px / `backdrop-filter: blur(18px) saturate(1.5)` /
   向下渐隐 mask / `z-index: 79`（正好在顶栏 80 之下、窗口之上）：窗口往上滑到顶栏下面时会被它"吃掉"。
3. **侧栏玻璃更透**：`.desktop:not([data-glass="solid"]) .window:has(.split) .split-side` 用
   `calc(var(--content-alpha) * 0.72)` + `blur(30px) saturate(1.7)`（"实色"档不动，尊重它的语义）。
   实测计算值 `rgba(23,23,23,0.43)` + `blur(30px) saturate(1.7)`。
4. **系统文字不可选中**：`.desktop { user-select: none }`；输入框 / `textarea` / `contenteditable` /
   `.quicklook-text` / `pre` 仍可选中。实测 `.desktop` 计算值 `user-select: none`。

验证：`npm run build` PASS；`npm test` 96/96；`security-surface` 17/17。

## 2026-09-12：排查「软件空白」+ 加两道防白屏兜底

用户报"软件空白了"。**排查结论：应用本身没有白屏。** 证据链：
- 用 `--remote-debugging-port` 连进**打包版**读 DOM：`#root` 内容 **81,607 字符**、
  `data-identity-gate="ready"`、`.desktop` 1 个、`.window` 2 个、`visibility: visible`；
  浅色与深色两种主题各截图一次，设置页（壁纸色板/上传）、桌面缩略图、顶栏、Dock **全部在**。
- 之前的"空白"截图来自 `screencapture -l <windowId>` —— 我们的窗口是 `transparent: true`，
  **按窗口抓表面会得到空帧**（这是抓图方式的假象，不是界面真的空）。整屏截图 + 裁剪则完全正常
  （区域亮度 min/avg/max = 0/34/247，不是一块底色）。

**但仍然补了两道兜底**（既然"看起来空白"这件事已经发生过，就不允许它真的发生）：

1. **启动超时可重试**：`useIdentity` 的启动询问（`identity/status` → `identity/restore`）加 10s 超时，
   超时后不再停在近乎空白的 BootSurface，而是给一句人话 + **「重试」**按钮（`BootRetry`）。
   实测：mock 一个永不返回的身份命令 → 10s 后 BootSurface 0 / BootRetry 1，文案与按钮都在；
   点「重试」后身份命令再次发起（调用数 1 → 2）。
2. **渲染错误边界**：`AppErrorBoundary` 包住 `<App />`，任何渲染期异常都给一个最朴素的
   「界面遇到了一个错误 / 重新加载」界面（不读任何应用状态，自己几乎不可能再挂）。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：吸附改「松手落格」+ 壁纸（子菜单 / 设置 / 上传 / 动态 Aurora）

1. **网格吸附不再生硬**：拖动过程严格 **1:1 跟手**，松手才用 `--dur-standard` 过渡落到栅格。
   实测：拖动中位移 27/23（1:1、未吸附）；松手后带 `.settling` 过渡并停在栅格 1150/88。
   顺带修一个真实缺陷：桌面图标原先挂了 HTML5 `draggable`，浏览器把"按下+移动"判成 HTML5 拖拽，
   **指针事件被吞掉**，位置根本拖不动。改为纯指针拖动（⌘+按下仍走原生拖出）。
2. **桌面文件可拖位置 / 拖到电脑**：位置持久化；**⌘+按下 = `startDrag` 拖到 Finder**；
   拖动松手若落在桌面文件夹磁贴上 = 搬进该文件夹。实测 ⌘ → `startDrag("desktop","d1")`。
3. **壁纸**：
   - 桌面右键只显示一条 **「壁纸 ›」**，悬停展开**子菜单**（新增 `MenuItem.submenu` 能力），
     子项勾选当前壁纸；内置 4 套 + 动态 Aurora + 自定义（没有自定义时给一条去设置上传的入口，不放假菜单）。
   - **设置 → 外观与交互** 新增壁纸区：色板预览 + 上传（接受 `image/*,video/*`）。
   - **自定义壁纸**存进真实的 `wallpapers` 存储文件夹，经 `openarc-file` 协议显示；
     动图 / 视频自动循环（`<video muted loop autoplay>`），静态图用 `<img>`。
   - **动态壁纸 · Aurora**：按用户给的 ReactBits 链接配色（#6b6b6b / #717171 / #292929）
     **自绘 Canvas**（不引第三方库），三团缓慢漂移的柔光；`reduced` 时只画一帧。
   实测：子菜单文本 `✓极光/石墨/午夜/纯黑/动态 · Aurora/…`；选 Aurora 后画布存在且**读到非空像素**；
   上传后 `import("wallpapers",[…])` → 壁纸变 `custom:w1` → `.wallpaper-media` 出现。

验证：`npm run build` PASS；`npm test` 96/96；`security-surface` 17/17。

## 2026-09-12：psd/ai 空预览 + 分辨率 + ⌘拖出到 Finder + 桌面图标与壁纸

用户反馈：

1. **`.psd` / `.ai` 空格预览**：浏览器渲染不了这两种格式，`openarc-file` 协议给它的是
   二进制流。改为**向主进程要大尺寸位图**：`files:thumb` 增加 `size` 参数（夹在 32–1024），
   Quick Look 对这类格式请求 **1024** 位图。实测空格后桥调用 `thumb("f1","i1",1024)` 且 `.quicklook img` 出现。
2. **点空白取消选择**：之前只挂在 `.folder-body` 上，工具栏下方/内容区底部那一片点不到。
   现在整块 `.split-main` 都接（`.file-cell` 除外）。实测：点网格下方空白 → `.selected` 0。
3. **显示简介加分辨率**：新增 `files:info`，用 `nativeImage.createFromPath` 读真实像素尺寸；
   读不出来就不编。实测简介出现「分辨率 1920 × 1080」。
4. **⌘ + 拖动 = 拖出到 Finder**：走 Electron 原生 `webContents.startDrag`（不是 HTML5 拖拽，
   两者互斥，所以挂在 ⌘ 上；不按 ⌘ 的拖动仍是**应用内移动**，Option 是**应用内复制**）。
   安全探针**新增对 `ipcMain.on` 面的冻结与审计**（之前只扫 `handle`）：
   `sec.ipcOnChannelsMatchFrozenList` + `sec.everyOnChannelTrustsSender` —— 现在 **17/17 PASS**。
   实测 ⌘ 拖动 → `startDrag("f1","i1")`。
5. **桌面图标**：桌面本身也是一个**真实存储文件夹**（`folderId = "desktop"`）。
   从文件夹窗口把文件拖到桌面空白 → `move("f1",["i1"],"desktop")`；桌面上的图标和文件夹里一样
   **显示真实缩略图**、可拖动（位置持久化在 `oa-desktop-icons`）。
6. **桌面右键菜单**：新建文件夹 / 粘贴 / **整理** / **网格吸附（可勾选）** /
   **排列方式：名称·日期·大小（勾选当前项）** / **壁纸：极光·石墨·午夜·纯黑（勾选当前项）**。
   菜单项新增 `checked` 能力（`MenuItem.checked`，渲染成左侧勾）。
   实测菜单文本带 ✓，壁纸切换后 `.desktop[data-wallpaper="midnight"]`，整理后图标落到栅格。

验证：`npm run build` PASS；`npm test` 96/96；`security-surface` **17/17**。

## 2026-09-12：条目搬运 —— 拖拽移动 / 复制 / 剪切 / 粘贴 / 导出到电脑

用户要求：文件夹支持拖拽移动位置、拖到别的文件夹或电脑、以及复制粘贴剪切（键盘 + 右键）。

- **后端**：`file-service` 新增 `copy`（新 id + 目标内去重名）与 `move`（优先 rename，
  跨卷退化为"复制 + 删除"）；`main` 新增 `files:copy` / `files:move` / `files:export`，
  `export` 走 `dialog.showOpenDialog` 选一个**真实目录**后复制出去（不动我们的存储）。
  安全探针冻结清单同步登记这三条通道。
- **应用内拖拽**：条目可拖动，放置目标 = **子文件夹磁贴 / 文件夹空白处 / 侧栏文件夹行 /
  桌面文件夹磁贴**。默认**移动**，按住 **Option = 复制**（与 macOS 的直觉一致）。
  内部拖拽用专用 MIME `application/x-openarc`，不会与"从电脑拖入文件"混淆。
- **复制 / 剪切 / 粘贴**：键盘 `Cmd/Ctrl+C / X / V` 与右键菜单共用同一套动作；
  剪贴板是应用内的 `{ mode, folderId, ids }`；粘贴进当前文件夹，剪切粘贴后清空剪贴板。
- **子文件夹**：移动 = 改 `parentId`（带**环检测**，不能移进自己或子孙）；
  复制 = 递归深拷贝（虚拟树 + 每层调用文件服务复制文件）。
- **右键菜单**：文件 = 打开 / 显示简介 / 重命名 / 拷贝名称 / 拷贝 / 剪切 / 导出到电脑… / 删除；
  文件夹 = 打开 / 显示简介 / 重命名 / 拷贝 / 剪切 / 删除；多选 = 拷贝 N 项名称 / 拷贝 N 项 /
  剪切 N 项 / 导出到电脑… / 删除 N 项；空白处菜单在剪贴板非空时顶部出现"粘贴（…）"。

实测（mock 记录桥调用）：
- 空白菜单出现 `粘贴（拷贝 1 项）`，粘贴 → `copy("f1",["i1"],"f1")`；
- 剪切 + 进入子文件夹粘贴 → `move("f1",["i1"],"sub")`；
- 拖到侧栏文件夹 → `move("f1",["i1"],"f2")`；
- 右键"导出到电脑…" → `exportTo("f1",["i1"])`。

`npm run build` PASS；`npm test` 96/96；`security-surface` 15/15。

**未做（诚实说明）**：**字面意义的"拖到 Finder"** 需要 Electron `webContents.startDrag`
（要新增一条 IPC 通道并同步安全探针面）。本轮给的是右键"导出到电脑…"（选真实目录复制出去）。
要 literal 拖拽导出，下一轮加。

## 2026-09-12：多选 / 框选 + 文件右键菜单 + 空白菜单全部可用 + 窄窗口工具条

用户反馈 4 项：

1. **多选与框选**：`selected` 改为按窗口存**一组 id**。单击=单选、Cmd/Ctrl=加减选、
   Shift=按当前顺序扩选；空白处按下拖动 = **橡皮筋框选**（与指针 1:1，命中的条目整体选中；
   遵循 apple-design 的"手势驱动位移永远跟随当前值，不加过渡"）。
   实测：单击 1 → Cmd 再点 2 → 框选命中多个。
2. **文件右键菜单**（对齐 Finder 常用项）：打开 / 显示简介 / 重命名 / 拷贝名称 / 删除；
   多选时给"拷贝 N 项名称 / 删除 N 项"，打开与显示简介置灰。实测菜单文本：
   单选 `["打开","显示简介","重命名","拷贝名称","删除"]`；
   多选 `["打开","显示简介","拷贝 2 项名称","删除 2 项"]`。
3. **`.ai` / `.psd` / `.eps` 缩略图**：归入图片类并走系统缩略图。实测 `.ai`（PDF 兼容）→
   **4254 字节真实页面缩略图**；`.pad` 系统没有缩略器 → 返回 37412 字节的"通用文档图标"，
   因此主进程新增**通用图标拦截**：与系统通用图标逐字节比对，命中就回 `{ok:false}`，
   渲染层改用线性图标 —— 不再出现白页。
4. **空白处右键菜单全部可用**（原来 4 项里 3 项是置灰占位）：
   - 新建文件夹（原有，真实）；
   - 显示简介 → 真实浮层（种类 / 包含子文件夹数 / 位置；文件则是种类 / 大小 / 修改时间 / 所在）；
   - 使用群组 → 真实分组（文件夹 / 图片 / 视频 / 音频 / 文档 / 压缩包 / 其它）；
   - 排序方式：名称 / 日期 / 大小 → **真实排序**（组内生效，与 Finder 行为一致）；
   - 查看显示选项 → 拆成"显示为图标 / 显示为列表"。
   实测：by size `["b-big","c-mid","a-small"]`、by date `["c-mid","b-big","a-small"]`，图标/列表切换生效。

**顺带修用户报的窄窗口缺陷**：窗口缩到最小时工具条标题被挤成**竖排**。
`.pane-title` 改为单行截断；工具条用**容器查询**按窗口自身宽度依次收起次要控件
（≤920 隐藏搜索、≤780 隐藏排序/共享/标签、≤680 隐藏查看方式）；侧栏名字同样截断。
实测 560px 宽：标题高 18px（单行）、无横向溢出、搜索已收起。

**另修一个真实缺陷**：`Esc` 关不掉"显示简介"浮层（当时只加了 `setPreview(null)`）——
被用户后续操作撞出来，已补 `setInfo(null)`。

验证：`npm run build` PASS；`npm test` 96/96；`security-surface` **15/15**。

## 2026-09-12：视频/文档缩略图 + 视频流式播放 + 空白处取消选择

用户问：视频、文档有没有缩略图？视频能播吗？点空白要能取消选择。

- **缩略图**：取缩略图的后缀集合扩展为 图片 / 视频 / 文档（`THUMB_EXTS`）。真实 Electron 实测：
  - `.mp4` → 缩略图 OK（界面格子 `thumbs:1 / glyphs:0`）；
  - `.pdf` → 4254 字节**页面缩略图**；`.txt` → 5247 字节文本缩略图；
  - 对照：无扩展名时拿到的是"通用文档图标"，**37KB** —— 差一个量级，说明现在是真实内容。
- **视频播放**：新增只读协议 `openarc-file://media/<folderId>/<id>`
  （`registerSchemesAsPrivileged` + `protocol.handle` + `net.fetch(file://)`）。
  图片 / 视频 / 音频预览改走**流式协议**，不再塞 data URL —— 大视频能播、能拖进度条；
  文本 / 其它仍需主进程读回内容。协议只注册在**默认 session**，原生网页视图用的独立 partition
  **够不到它**。CSP 在 `img-src` / `media-src` 放行 `openarc-file:`。
  实测：`<img>` 加载原始 **2320×1560**；`<video>` `loadeddata` **320×240 / 1s**。
- **选择语义**：点条目 = 选中；点文件夹空白处 = **取消选择**（`selected[windowId]` 置空）。
  实测：点条目 `.selected` = 1；点空白 = 0。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：缩略图根因修复（无扩展名落盘）+ 右键菜单只属于文件夹/桌面

用户反馈：缩略图还是看不到内容、只是图标；且不要每个窗口右键都能"新建文件夹"。

**缩略图根因（实测对比）**：我们把数据文件存成**无扩展名**的 `<entryId>`。
- `createThumbnailFromPath("x.png")` → **6233 字节的真实内容缩略图**；
- `createThumbnailFromPath("x")`（无扩展名）→ **系统"通用文档图标"**（512×512 白页，
  正是用户截图里那个白页图标）。macOS 靠扩展名判断类型。

修复：
- `importPaths` 改为 `<id>.<ext>` 落盘，索引新增 `file` 字段；
- 新增一次性迁移 `migrateLegacyFiles()`：把老数据的物理文件补上扩展名并写回索引
  （幂等；失败保持旧路径，读/删仍可用）；
- `read` / `remove` / `resolve` 一律走索引里的 `file`；MIME 以**物理扩展名**为准
  （改名不应改变文件真实类型），显示名仅作回退。
- 实测：迁移后条目 `file: "…png"`、缩略图 6233 字节真实图片；
  用真实文件服务 + 真实数据复现 DOM：`cells 2 / thumbs 2 / glyphs 0`。

**右键菜单范围**：`.desktop` 的 `onContextMenu` 增加 `closest(".window")` 判断 ——
只有桌面自己弹桌面菜单（含"新建文件夹"）；窗口内部由各窗口决定（文件夹有内容菜单，其余不弹）。
实测：设置窗口内右键 → 桌面菜单 0；桌面右键 → 1。

验证：`npm run build` PASS；`npm test` 96/96。

## 2026-09-12：分栏内容上边距区分（设置 / 应用 / Skill 恢复呼吸空间）

用户反馈：系统设置右边的「外观与交互」太靠上，其他分栏也是。

- 之前为了让**文件夹工具条**与原生红绿灯同一行，把 `.window:has(.split) .split-main` 的
  `padding-top` 统一压到 10px，连带把设置 / 应用中心 / Skill 的标题也顶到了最上面。
- 现在拆开：
  - `.window:has(.split) .split-main { padding-top: 64px }` —— 普通分栏内容让开标题栏再留呼吸空间；
  - `.window:has(.split):has(.pane-toolbar) .split-main { padding-top: 10px }` —— 只有"顶部是工具条"的
    文件夹窗口才贴上去。

实测：设置页标题距窗口顶 **64px**；文件夹工具条仍在窗口顶下 10px，与红绿灯中心同一行
（工具条中心 159 / 红绿灯中心 158）。

## 2026-09-12：回退 Spectrum 映射接入（自引用圆角 token 导致全局直角）

用户反馈：侧栏与所有框都变成直角了；要求退回未做映射前的状态。

**根因（我的实现缺陷）**：`src/tailwind.css` 的 `@theme` 里写了
`--radius-sm: var(--radius-sm)`、`--radius-md: var(--radius-md)` 这类**自引用循环**。
浏览器把循环定义判为无效 → `--radius-*` 解析为空 → 所有 `border-radius: var(--radius-*)`
全部落到 0。颜色映射本身没问题，是"把圆角 token 又指回自己"这一步错了。

- 处理：`git revert 90d129c`（提交 `e6a55d7`），移除 `@tailwindcss/vite` 接线、
  `src/tailwind.css` 与 `main.tsx` 的引入；Tailwind / Motion 依赖保留但当前未被使用。
- 验证：`npm run build` PASS；`.window` 16px、`.split-side` 12px、`.segmented` 999px、
  `.search-field` 8px、`.app-card` 12px、`.dock` 20px、`--radius-lg` 12px —— 全部恢复。

**若将来还要接 Spectrum，正确做法**：Tailwind 的 `@theme` 里只能映射**颜色**，
且要用**不同名字**（如 `--color-*`），**绝不重新声明我们自己的 `--radius-*` / `--fs-*`**；
接入后必须先跑 D2-01 探针 + 目视核对圆角再继续。

## 2026-09-12：拖入的图片/视频显示真实缩略图

用户反馈：文件拖进去后还是显示图标，要能看到缩略图。

- `file-service` 新增 `resolve(folderId, id)` —— **只给主进程用**，拿条目磁盘路径，
  刻意**不挂到 preload**：渲染进程依然拿不到任何路径。
- `main.cjs` 新增 `files:thumb`：用 Electron `nativeImage.createThumbnailFromPath(path, 160×160)`
  生成缩略图，只回 data URL；`preload` 与安全探针冻结清单同步登记 `files:thumb`。
- 渲染层给图片/视频条目**懒加载缩略图并缓存**（空串表示"确认没有缩略图"，避免反复请求）：
  网格里 46×46 圆角缩略图，列表视图 22×22；取不到才回退到线性图标。

实测：缩略图 API 探针（真实 Electron）→ `{"width":160,"height":160}` PNG data URL；
`npm test` 96/96；`security-surface` 15/15。

## 2026-09-12：显示方式分段控件的图标居中

用户反馈：胶囊分段控件里的 icon 没对齐居中。

- 根因：全局 `button { padding: 1px 6px }` 给 22px 的方按钮加了不对称的水平内边距，
  15px 图标在 10px 的内容盒里 `place-items: center` 反而**水平偏右 2.5px**
  （垂直方向本来是正的，所以看起来"只差一点"）。
- `.segmented button` 的内边距归零。实测：按钮 22×22、图标 15×15，
  水平与垂直偏移都是 3.5px（正好是 (22-15)/2，居中）。

## 2026-09-12：Quick Look 空格预览 + 全屏 Dock 自动隐藏 + 显示方式改胶囊

用户反馈 4 项，本批完成 1–3：

1. **空格 Quick Look**：`file-service` 新增 `read(folderId, id)`（>12MB 直接拒绝；只回
   data URL / 文本，**不回磁盘路径**），preload / main / 安全探针冻结清单同步登记 `files:read`。
   文件夹里点选条目后按**空格**打开预览：图片 / 视频 / 音频 / 文本；Escape 或再按空格关闭。
   CSP 增加 media-src self data:（音视频预览必需，data: 无外联能力）。
2. **全屏 Dock 自动隐藏**：任一窗口最大化时 Dock 下沉隐藏，底部 8px hover 带唤回。
3. **显示方式（网格/列表）改胶囊**：`.segmented` 与其按钮圆角改为 `--radius-pill`。

实测：file-service read 单测（png → data:image/png;base64、md → 文本、不存在 → NOT_FOUND）；
`npm test` 96/96；`security-surface` 15/15；浏览器核对全屏后 `.dock.hidden=1` + `.dock-hint=1`。

**未完成**：4. 引入 Spectrum 源码（构建级重构，方案与影响见对话）。

## 2026-09-12：AREA_TOP 对齐顶栏高度 + 修正被旧几何钉住的断言

- `electron/window-domain.cjs`：`AREA_TOP` 44 → **38**（= `.topbar` 高度）。
  否则"全屏铺满、只让开顶栏"的 y=38 会被 `normalizeBounds` 夹回 44，
  `reflow` 与持久化往返都不是不动点 —— 单测 `persistence.test.mjs` 直接抓到。
- `window-manager.maximizedBounds` 直接引用 `AREA_TOP`，不再维护第二个常量。
- 更新 `tests/window-manager.test.mjs` 里被旧几何钉住的断言（工作区 y、最大化宽度与 y、公式）。

验证：`npm test` **96/96**；`security-surface` **15/15**；`d2-02-gate` **7/7 全通过**
（00-instrument 14/14、06-stress 42/42）。
注：中途几次 gate 失败已定位为**环境干扰**——我自己的 `.app` 窗口盖住了探针窗口，
`screencapture` / `cliclick` 打不到探针；退出 `.app` 后全部恢复。

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
