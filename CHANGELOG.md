# 计划修订记录

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
