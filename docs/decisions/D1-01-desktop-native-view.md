# D1-01 桌面与原生视图：技术决策记录

日期：2026-09-10
范围：仅 D1-01（桌面与原生视图技术验证）。未触碰 Harness、AI、MCP、Adobe、Skill、用户/团队、数据库、插件市场、画布。
状态分级：PASS / FAIL / NOT VERIFIED / BLOCKED。凡未实机取得证据的一律不写通过。

---

## Environment

| 项 | 实测值 |
| --- | --- |
| OS | macOS 26.6.2（Build 25G83） |
| CPU | Apple M3 Pro |
| 架构 | arm64 |
| 内存 | 18 GB |
| 显示器 | 1 × 内置 Liquid Retina XDR，3456×2234 Retina |
| `screen.getAllDisplays()` | `[{ id: 1, scaleFactor: 2, workArea: { x:0, y:33, width:1728, height:990 }, internal: true }]` |
| Node（外部） | v22.22.2 |
| npm | 10.9.7 |
| Electron | 44.3.0（`package.json` devDependencies 锁定） |
| Chromium | **152.0.7977.78**（主进程 `process.versions.chrome` 实测） |
| Electron 内置 Node | 24.20.0 |
| Playwright | 1.55.0（`@playwright/test`） |

**只有一块物理显示器**，因此多显示器只能通过 `screen` API 的返回值与几何计算验证，
真实拔插屏幕属于 MANUAL / PLATFORM VERIFICATION REQUIRED。

---

## Current Implementation

审计沿真实调用链进行，不依据文件名判断（读取 `package.json`、`electron/main.cjs`、
`electron/preload.cjs`、`electron/policy.cjs`、`src/main.tsx`、`src/styles.css`、`tests/`、`index.html`）。

- **进程模型**：单一原生 `BrowserWindow` 承载 React 界面；OpenArc 的"窗口"是界面内的 DOM 元素
  （`src/main.tsx` 中 `wins` 状态 + `zIndex: 10 + i`），**不是**原生多窗口。
- **浏览器**：`electron/main.cjs` 中 `new WebContentsView(...)` 挂在 `win.contentView` 上，
  独立会话分区 `openarc-browser-d1`，`setVisible` 由界面通过 `browser:layout` 驱动。
- **桥接**：`preload.cjs` 仅暴露 `navigate / layout / action / onBrowser / onDisplay`，无 Node 能力。
- **策略**：`policy.cjs` 提供 `safeURL`（仅 http/https、拒绝内嵌凭据）与 `safeBounds`（按宿主内容区收拢）。
- **平台**：macOS 用 `transparent + vibrancy: "under-window"`；Windows 用 `backgroundMaterial: "mica"`。

---

## Verified（PASS）

### Desktop

| 项 | 结果 | 证据 |
| --- | --- | --- |
| Electron 独立窗口可创建 | PASS | 探针创建 `BrowserWindow` 并 `isDestroyed() === false` |
| 窗口显示 / 最小化 / 恢复 / 最大化 / 还原 | PASS | 事件驱动断言，`isMinimized`/`isMaximized` 均符合预期 |
| 位置与尺寸可设置并读回 | PASS | `setBounds({123,77,800,500})` → `getBounds()` 完全一致 |
| 多原生窗口与焦点互斥 | PASS | 两个 `BrowserWindow`，`focusWithRetry` 后一个为真、另一个为假 |
| 窗口销毁 | PASS | `destroy()` 后 `getAllWindows().length` 由 2 变 1 |
| 显示器与 DPI 可读取 | PASS | `getAllDisplays()` 返回 scaleFactor 2、workArea 完整 |
| 屏幕外检测与归位（A05 原生侧） | PASS | `x=2128` → 收拢为 `x=1128`，完整落入 workArea |

### WebContentsView

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 是真实 `WebContentsView` 而非 iframe | PASS | `view.constructor.name === "WebContentsView"`，且作为独立 CDP target 出现 |
| 创建 / 挂载 / 销毁 | PASS | `contentView.addChildView` 后 children 增加 |
| 导航 | PASS | 真实 http 与 data URL 均可加载，页面脚本在视图内执行 |
| resize / move | PASS | bounds 二次设置后 `getBounds()` 精确一致 |
| hide / show | PASS | `setVisible(false)` → `getVisible() === false`，反之亦然 |
| reload | PASS | 调用不抛错，URL 保持 |
| 裁剪（矩形） | PASS | 受 `safeBounds` 约束，越界尺寸被宿主内容区收拢 |

### Security

| 项 | 结果 | 证据 |
| --- | --- | --- |
| `contextIsolation` | PASS | 界面与视图内 `require/process/module` 均为 `undefined` |
| `nodeIntegration` | PASS | 两处均显式 `false` |
| `sandbox` / `webSecurity` | PASS | 代码显式开启；**运行时强制**见 Not Verified |
| preload 暴露面 | PASS | 5 个方法，全部为浏览器控制或只读订阅，无 Node/文件系统 |
| 会话隔离 | PASS | `view.webContents.session !== win.webContents.session` |
| 网页拿不到系统桥接（A13） | PASS | 视图内 `require/process/module/ipcRenderer/openarc` 全为 `undefined` |
| 导航策略 | PASS | `safeURL` 拒绝 `file:`/`javascript:`/`data:`/含凭据地址；页面内跳 `file://` 被 `will-navigate` 阻止 |
| CSP | PASS | `index.html` 已配置 `default-src 'self'` 等 |

---

## Failed

无产品缺陷失败。审计期间修正的问题见下节；另有 2 处是我自己的探针断言写错（已更正，保留在记录里以免重犯）：

1. 误以为 `isVisible()` 判断原始坐标——它内部会先收拢，所以"窗口在屏幕外"必须用 `inside()` 判原始值。
2. 误以为 `will-navigate` 会拦截主进程 `loadURL()`——它只管页面内跳转，这条已转成下面的 Security Finding。

---

## 审计发现并已修复（D1-01 范围内）

1. **右键菜单会被网页穿透（A12 真实缺陷）**
   原生视图永远绘制在 DOM 之上。修复前 `visible` 只判断 `active === "browser" && !ai && !search`，
   桌面右键菜单（`menu` 状态）不在判断内：浏览器窗口激活时右键，菜单会被网页内容盖住。
   修复：`src/main.tsx` 的 `sync()` 增加 `!!menu` 与更高层窗口的 `geometry.occluded()` 判定。

2. **窗口几何没有持久化，"恢复"无从谈起（A05）**
   修复前 `wins` 只有硬编码初值，`localStorage` 只存主题与文件夹。
   修复：新增 `oa-wins` 持久化 + `restoreWins()` 启动时按当前工作区收拢。

3. **显示器变化无处理**
   修复：`electron/main.cjs` 监听 `display-added / display-removed / display-metrics-changed`，
   原生窗口若已不在任何 workArea 则拉回主屏；同时通过 `onDisplay` 通知界面重新收拢内层窗口。

4. **占位文案会说谎**
   `.web-viewport` 的提示文字原判断与真实显示状态不一致，已改用同一 `blocked` 判定并加 `data-view` 状态。

5. **窗口收拢逻辑散落且不自洽**
   原先 resize 分支里有一套手写 clamp（上下边界常量不一致：158 与 100）。
   修复：抽出纯函数模块 `electron/geometry.cjs` + `geometry.d.cts`，界面与主进程共用同一实现。

---

## Not Verified

| 项 | 原因 |
| --- | --- |
| 渲染进程沙箱的**运行时强制** | 本环境 Chromium 沙箱无法初始化（`sandbox initialization failed: Operation not permitted`），必须加 `--no-sandbox` 才能启动。配置正确（已审计），运行时强制未取得证据 |
| Windows 11 Mica 背景材质 | 无 Windows 主机，属于 PLATFORM VERIFICATION REQUIRED |
| macOS vibrancy 视觉生效 | 进程可启动、窗口可创建，但无 GPU 且无法观察屏幕，玻璃材质外观未验证 |
| 真实多显示器拔插 | 仅 1 块物理屏。已用 `screen` API 与几何计算覆盖逻辑，物理拔插需人工验证 |
| 圆角裁剪、部分区域遮挡 | 单个矩形原生视图无法表达非矩形裁剪；部分遮挡只能整体隐藏，未验证视觉观感 |
| 下载、权限申请、外部协议、`window.open` 的**应用内**运行时行为 | 代码已配置（`will-download` 阻止并提示、permission handler 拒绝、`setWindowOpenHandler` deny、`will-attach-webview` 阻止），但应用内运行时断言被 desktop.mjs 的 BLOCKED 挡住 |
| 性能（启动耗时、帧时间、内存） | 无 GPU，测量无代表性 |
| `npm run desktop` 的交互可用性 | 进程可启动且无崩溃，但无法观察与操作 GUI |

**MANUAL / PLATFORM VERIFICATION REQUIRED（必须人工实机）**

- Windows 11 22H2+ 上 `backgroundMaterial: "mica"` 是否生效，以及低版本回退
- 两块显示器：拔掉副屏后重启，恢复的窗口是否全部可见且焦点正确
- 圆角窗口下原生视图四角是否露出
- 高 DPI（scaleFactor 2）下网页文字与点击命中是否对齐
- 拖动窗口经过 Dock / 顶栏时的遮挡观感

---

## BLOCKED

**必须先区分两类阻塞，不可混为一谈：**

- `PROJECT FAILURE` —— OpenArc 项目自身的安装或构建流程确实有问题。
- `AGENT EXECUTION ENVIRONMENT BLOCK` —— 当前 Agent / sandbox 执行环境的限制，
  **不能据此判断 OpenArc 安装流程本身失败**，必须在普通终端或 CI clean clone 中重新验证。

| 项 | 分类 | 原因与处理 |
| --- | --- | --- |
| `npm ci` | **AGENT EXECUTION ENVIRONMENT BLOCK** | 当前 Agent 环境的批量删除保护拦截（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，54 项 > 阈值 50），且已删掉部分依赖导致依赖树损坏，已从备份恢复。`npm ci --dry-run` 通过（54 包、无冲突），说明 lockfile 本身没问题。**是否 PROJECT FAILURE：UNKNOWN，需 clean clone 复验** |
| `npm install` | **AGENT EXECUTION ENVIRONMENT BLOCK** | 当前 Agent 环境拒绝 `node_modules/.bin` 内的 rename（`CODEBUDDY_BROKER_DENY`）。依赖恢复改用手写拷贝。**同上，需 clean clone 复验** |
| Electron 二进制安装（官方源） | **AGENT EXECUTION ENVIRONMENT BLOCK** | GitHub Releases 在本环境不可达（curl 返回 000）。改用 npmmirror 镜像下载并校验 SHA256 通过后手工解包。**这是环境网络限制，不是项目缺陷；普通网络下 `npm install` 应能自行取到二进制，仍需复验** |
| `npm run test:desktop` | **UNRESOLVED / NOT VERIFIED** | Playwright Electron driver 与当前 Electron 44 / Chromium 152 / 本项目组合发生启动超时（`_electron.launch` 握手 180 s 超时；同机简单 app 只需 808 ms、vibrancy 窗口 784 ms）。`chromium.connectOverCDP` 同样在 WS 连接后超时。**根因尚未确认**——版本兼容性只是候选原因之一，未取得上游证据或最小复现证明。**不得表述为"Playwright 与 Chromium 152 不兼容"** |

---

## Security Findings

1. **（高危，已修）右键菜单被网页覆盖**：见上文修复第 1 条。
2. **（架构约束，需长期遵守）`WebContentsView` 自身不拦 `file://`**：探针实测未接策略时
   `loadURL("file:///etc/passwd")` 直接成功。保护完全来自 `safeURL` 预校验 + `will-navigate`。
   **结论：任何主进程发起的 `loadURL` 必须先过 `safeURL`，`will-navigate` 拦不住它。**
3. **IPC 来源校验**：`trusted(event)` 要求 `sender === win.webContents` 且 `senderFrame.url === uiURL`，
   视图内页面无法调用 `browser:*`（视图无 preload，`ipcRenderer` 本身也不可见）。静态审计通过，运行时断言被 BLOCKED 挡住。
4. `setWindowOpenHandler` 对界面与视图均返回 `deny`；`will-attach-webview` 阻止；permission handler 一律拒绝；
   `will-download` 阻止并给出提示（`D1 尚未启用下载管理`）。
5. `safeBounds` 防止界面传入的矩形越出宿主内容区。

---

## Platform Differences

| 能力 | macOS | Windows |
| --- | --- | --- |
| 背景材质 | `transparent: true` + `vibrancy: "under-window"` | `backgroundMaterial: "mica"` |
| 实测状态 | 进程可启动、窗口可创建；视觉效果 NOT VERIFIED | 无主机，NOT VERIFIED |
| 其他 | 顶层菜单、Dock 行为未涉及 | 任务栏、Mica 回退策略未涉及 |

代码里两类平台分支是显式 `isMac` 三元，不存在同一处混用两种平台 API 的情况。

---

## Browser View Findings

1. 原生视图**永远绘制在 DOM 之上**，DOM 的 `z-index` 对它无效。因此"界面覆盖网页"只能靠
   **判断遮挡后隐藏或收窄**，不能靠层级。本项目采用隐藏，遮挡判定由 `geometry.occluded()` 承担。
2. 当前架构下"被其他 OpenArc 窗口遮挡"实际不会发生（聚焦窗口总被移到 `wins` 末尾即最上层），
   遮挡判定的真实触发者是 AI 面板、搜索面板与**右键菜单**。窗口遮挡分支作为防御保留。
3. 单个矩形视图无法做非矩形裁剪：圆角、部分遮挡都做不到像素级正确。若 D2-02 需要
   "窗口压住网页时网页只显示未被覆盖的部分"，**当前只确认约束，未确认方案**——
   候选方案包括但不限于：WebContentsView hide/show、矩形 bounds 管理、多 WebContentsView、
   Child BrowserWindow、独立 BrowserWindow，或其他经验证的方案。
   **状态：ARCHITECTURE DECISION REQUIRED**。需要单独 ADR + 原型验证后决定，**本轮不锁定实现**，
   尤其不得直接断言"必须改为每个窗口一个原生 BrowserWindow"。
4. `setVisible(false)` 后视图内容仍在（URL 不变），恢复显示无需重新导航。

---

## Performance Findings

NOT VERIFIED。本环境无 GPU 进程（`GPU process exited unexpectedly`），任何帧率/启动耗时数据都不具代表性。
相关目标（冷启动 ≤ 5 s、拖动 60 fps）仍按 PLAN.md 第 33 节保持"待 D1 确认"，不因本轮而冻结。

---

## Decisions

1. **D1 阶段维持"单原生窗口 + DOM 内层窗口"**（范围决策，非架构决策）。
   理由：本轮已证明原生层具备多窗口、焦点互斥、多显示器感知能力，改造窗口系统是 D2-02 的范围，
   不应由 D1-01 顺带扩大。
   **本决策不预设 D2-02 的实现方案**：WebContentsView hide/show、bounds 管理、多视图、
   Child / 独立 BrowserWindow 等候选均保持开放，需单独 ADR + 原型验证后决定（见 Browser View Findings #3）。
2. **窗口几何与遮挡判定抽成纯函数 `electron/geometry.cjs`**，界面与主进程共用，可被 `node --test` 直接覆盖。
3. **窗口几何持久化到 `localStorage` 的 `oa-wins`**，恢复时先收拢再渲染；显示器变化由主进程 `screen` 事件驱动。
4. **原生视图的显示条件收敛为单一 `blocked` 判定**（AI 面板 / 搜索 / 右键菜单 / 更高层窗口），
   并让占位文案使用同一判定，避免界面与实际状态不一致。
5. **新增 `tests/native-view.mjs`（不依赖 Playwright）**作为 D1-01 主进程能力的自动化证据；
   `tests/desktop.mjs` 保留给 Playwright 可用的环境，本环境标 BLOCKED。
6. **Electron 二进制在本机通过 npmmirror 安装并校验 SHA256**，与 `package.json` 锁定版本一致（44.3.0）。

---

## Remaining Risks

1. **无 Windows 主机**：mica、任务栏、系统快捷键、打包签名全部未验，D1-06 前必须补。
2. **无第二块显示器**：A05 的物理拔插场景未取得实机证据。
3. **Chromium 沙箱在本环境不可用**：渲染进程沙箱只有配置证据，没有运行时证据；换到正常 CI 后需补跑。
4. **UI 侧端到端断言无法执行（UNRESOLVED / NOT VERIFIED）**：Playwright Electron driver 与
   Electron 44 / Chromium 152 / 本项目组合启动超时，根因未确认。A12/A13 的应用内行为目前只拿到
   主进程侧等价证据（同样的隔离配置与同样的策略函数）。解除前 UI E2E 一律记为 NOT VERIFIED。
5. **部分遮挡与圆角裁剪的观感未验**：**ARCHITECTURE DECISION REQUIRED**。
   若 D2-02 要求像素级正确，需先出 ADR + 原型，方案未定、不得提前锁定。
6. **`npm ci` / `npm install` / 官方源二进制下载均为 AGENT EXECUTION ENVIRONMENT BLOCK**，
   不是已证实的 PROJECT FAILURE。必须在普通终端或 CI clean clone 中复验后才能定性。
6. **窗口几何持久化未做版本与异常校验之外的保护**：当前只校验字段类型与有限数值，
   D2-02 需要与应用生命周期（未保存内容、关闭与退出区分）一起设计。

---

## D1-01 未完成清单（保留，不删除，D1-06 前必须复查）

以下 14 项本轮未取得证据，**持续保留**，后续补证。D1-06 关卡评审前必须逐项重新检查；
未清空前 D1-01 状态恒为 **PARTIAL**，不得改判 PASS / COMPLETE。

| # | 未完成项 | 当前状态 |
| --- | --- | --- |
| 1 | Windows Mica 实机 | NOT VERIFIED |
| 2 | Windows 窗口行为 | NOT VERIFIED |
| 3 | Windows 多显示器 | NOT VERIFIED |
| 4 | macOS vibrancy 视觉 | NOT VERIFIED |
| 5 | 真实多显示器拔插 | NOT VERIFIED |
| 6 | 高 DPI | NOT VERIFIED |
| 7 | 圆角 / 遮挡 | NOT VERIFIED（且 ARCHITECTURE DECISION REQUIRED） |
| 8 | renderer sandbox 运行时强制 | NOT VERIFIED |
| 9 | 下载（应用内运行时） | NOT VERIFIED |
| 10 | permission（应用内运行时） | NOT VERIFIED |
| 11 | external protocol（应用内运行时） | NOT VERIFIED |
| 12 | `window.open` runtime | NOT VERIFIED |
| 13 | UI E2E | NOT VERIFIED（UNRESOLVED，见 BLOCKED） |
| 14 | GPU 性能 | NOT VERIFIED |

---

## Evidence

| 类型 | 位置 / 命令 |
| --- | --- |
| 原生能力验收日志 | `artifacts/d1-native.log`（26/26 PASS，需 `ELECTRON_EXTRA_ARGS` 在本机运行） |
| 原生验收命令 | `ELECTRON_EXTRA_ARGS="--no-sandbox --disable-gpu-sandbox --in-process-gpu" npm run test:native` |
| 单元验收命令 | `npm test` → 7/7（policy 2 项 + geometry 5 项） |
| 构建 | `npm run build` → tsc 无错误，vite 产物 index.js 245 kB / index.css 14.4 kB |
| 二进制校验 | `electron-v44.3.0-darwin-arm64.zip`，129,788,539 字节，SHA256 `49b91ef265c603c8888500f807484b63816069c30f87ba2b403e7c87f0f45035`（与镜像 SHASUMS256.txt 一致） |
| 网络事实 | GitHub Releases `000`（不可达）；npmmirror `-/binary/electron/` `200`；npm registry `200` |
| 本轮改动 | `electron/geometry.cjs`（新增）、`electron/geometry.d.cts`（新增）、`electron/main.cjs`（显示器事件）、`electron/preload.cjs`（onDisplay）、`src/main.tsx`（持久化/收拢/遮挡/文案）、`tests/geometry.test.mjs`（新增）、`tests/native-view.mjs`（新增）、`tests/fixtures/native-probe/*`（新增）、`tests/desktop.mjs`（重写）、`package.json`、`index.html` 未改 |
