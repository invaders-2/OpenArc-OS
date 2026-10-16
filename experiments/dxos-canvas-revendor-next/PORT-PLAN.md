# DXOS-CANVAS-REVENDOR-NEXT · 移植清单（PORT-PLAN）

> 本包只做**准备**：改 vendor 脚本（本地源 + 干跑）、出移植清单与 RUNBOOK。**没有改 bundle** `public/novai-canvas/**` 全程 0 改动（证据见 `artifacts/dxos-canvas-revendor-next/`）。

- 抓取样本身份：**git 检出，HEAD `22feb2988570bfce5b7476e26d7e0d313ab681db`，工作区脏（141 个改动文件）**；不是固定 pin（pin=`1e20abe514…`，matchesPin=false）。
- 源根：`/Users/wepingli/Desktop/NOVAI-Infinite-Canvas-main/NOVAI-v16`（调用方传的是父目录 `…/NOVAI-Infinite-Canvas-main`，vendor 脚本在子目录里唯一命中了 `NOVAI-v16/static`）。
- 保留 63 / 排除 94 文件（源 static/ 共 157 个），内容指纹 `sha256:3b1e9e7708a547c8ba0e86a706bdc73dac5e85c419014ed70a550df7dde81a22`（kept set）。
- 抓取时间：2026-10-16T20:46:55Z / 20:47:09Z（本地时间 2026-10-17 04:46–04:47）。
- **样本在采集中就在变**：同一天 20:52:38Z（04:52）第二次抓取时，同一 HEAD 22feb298 的脏文件数已从 **141 → 143**、kept-set 内容指纹从 `3b1e9e77…` → `4dbc6d8d22c8ac3800336d61907c3d9245d50e52ea69f77a124a844da77e52c1`（63 files / 12,529,007 B）。**HEAD 没动、工作区在动** —— 说明用户正在改的是未提交文件，所以「保留 63/排除 94」这个数量暂时稳定，但**内容指纹与逐文件哈希已经变了**；受影响最大的两个文件是 `static/canvas-list.html` 与 `static/js/smart-canvas.js`。
- **所有行号都只对上面这份样本有效**；上游还在改，见文末「会失效的结论」。

---

## 0. 与并发会话的重叠（先看这条）

另一个会话正在同时改 `public/novai-canvas/**` **和** `experiments/d5-02/vendor-novai-app.mjs`：本包开工时读到的 vendor 脚本已经从 373 行涨到 399 行，新增了 `SMART_GUARD = vendor/smart-canvas-guard.js`、把 `LIST_PATCHES` 改成了「入口全部改向 smart」、并新增了「smart-canvas.js IIFE 末尾注入最小封堵」。本包的所有改动都以**当时那份**为基线（快照 `artifacts/dxos-canvas-revendor-next/vendor-novai-app.mjs.snapshot-concurrent`，sha256 `78067ca4…`），且只用**定点 edit**、不整文件重写；改动隔离为 10 个 hunk（`artifacts/dxos-canvas-revendor-next/vendor-script-my-diff.patch`）。并发会话若再整写这个文件，本包加的「本地源 + 干跑」会被覆盖 —— 需要重跑本包第 1 项。

他们那份 `smart-canvas-guard.js` 的**已知死锚点**（本包实测）：

| 它引用的 | 本地源码命中 | 后果 |
| --- | --- | --- |
| `apiKindToggle` | **0** | 视频 kind 的 disable 分支恒不执行（有 `&&` 兜底，不崩，就是不生效） |
| `syncApiKindToggleVisibility` | **0** | 同上（包装了一个 undefined） |
| `gpt-4o-mini`（C1 注释说的两处兜底） | **0**（旧 pin 有 3 处） | 该封堵对这份源码是空操作；但 `resolveChatModel` 现在返回 `''` / `models[0]`，本来就没写死模型名 |

`renderUnifiedPlatformControl` / `initChatModel` / `runGeneration` / `renderDynamicParams` / `syncRunButtonState` 仍在，命中。

---

## 1. 页面与入口

### 1.1 产品页确认

| 页面 | 结论 |
| --- | --- |
| `static/canvas-list.html` | **产品首页（列表）**。宿主 IFRAME_BASE 指向它。 |
| `static/smart-canvas.html` | **智能画布编辑器**（唯一要保留的编辑器）。`<script defer src="/static/js/smart-canvas.js">` 在 `smart-canvas.html:751`。 |
| `static/canvas.html` | 传统编辑器，**本批要删**。它只被列表页的 kind 三元和自身资源引用（`css/canvas.css`、`js/canvas.js`）。 |

保留页都带 `<head>`；闭包还会从 smart-canvas.js 带进 `tools/lossless-edit/index.html`（第 4 个 HTML 页，`<head>` 也在）。

### 1.2 列表页里所有「打开经典编辑器」的入口（逐处 file:line）

路径都相对 `static/`：

| # | 位置 | 现状 | 删除 canvas.html 后怎么改 | 干跑锚点 |
| --- | --- | --- | --- | --- |
| 1 | `canvas-list.html:1063` | `btnStartCreate → openCanvasPicker()` | 改 `createCanvasFromPicker('smart')` | vendor LIST_PATCHES #1 已 hit |
| 2 | `canvas-list.html:1064` | `btnNewProject → openCanvasPicker()` | 同上 | #2 已 hit |
| 3 | `canvas-list.html:1315-1317` | `openCanvas(c)`：`c.kind==='smart' ? smart-canvas : canvas.html` | 恒 `smart-canvas.html?id=&project=` | #4 已 hit |
| 4 | `canvas-list.html:1387-1421`（跳转 1416-1418） | 新建后按 `nc.kind` 三元 | 恒 smart；把 `isSmart` 恒 true（`kind:'smart'`、`icon:'sparkles'`） | #5 + #6 已 hit |
| 5 | `canvas-list.html:1423` | `pickerNormal → createCanvasFromPicker('classic')` | 改 `'smart'`（或删按钮） | #8 已 hit |
| 6 | `canvas-list.html:1434-1436` | 「继续上次」按 `latest.kind` 三元 | 恒 smart | #7 已 hit |
| 7 | `canvas-list.html:1438` | 「继续上次」空列表兜底 `openCanvasPicker()` | 改 `createCanvasFromPicker('smart')` | #3 已 hit |
| 8 | `canvas-list.html:1056` | `openCanvasPicker()` 自身 | 入口都改向后它变成死函数（可留着） | — |

**不在列表页、但同源可见的引用**（删页面时一并消失或无需处理）：
- `static/home.html:1341`：kind 三元 —— home.html 不在白名单闭包里（已排除）。
- `static/js/canvas-list.js:508-509`：同样三元 —— **该文件未被任何保留页加载**（`canvas-list.html:1634` 明确写「canvas-list.js 未被任何页面加载」），且闭包不含它。
- `static/js/asset-manager.js:713,5051`：asset-manager 页面已裁掉，该 JS 也不在闭包。
- `static/js/canvas.js:2433`：经典画布自己跳 smart —— 整个文件删掉后自然消失。

**参数兼容性：兼容，无需改传参名。**
- 智能画布读的就是 `id` / `project`：`smart-canvas.js:11-13` 的 `params.get('id') / params.get('project')`。
- 经典画布读的也是 `id`（`canvas.js:15723`）/ `project`（`canvas.js:3014`）。
- 三元的 `t=1786289367` 只是 cache-buster，两页都不读；`project` 缺省时 smart-canvas 传空串，宿主 `canvas/get` 用画布自身 project，与经典页一致。

### 1.3 收窄白名单时要注意的闭包陷阱

`extractStaticRefs` 会把 `canvas-list.html` 三元里的 `/static/canvas.html` 当真实引用。入口改向补丁（#4/#6/#7）落盘后三元就不再指向它；**但收窄白名单和入口改向要在同一次脚本执行里做**，否则 canvas.html 还会被闭包带进来。上一包已给出 `PAGE_EXCLUDE = ['canvas.html']` 方案（`experiments/dxos-canvas-scope/README.md` 3.1），仍然适用；实测收窄后真正消失的只有 3 个文件：`canvas.html`、`css/canvas.css`、`js/canvas.js`。

---

## 2. 守卫 / 适配器移植锚点（智能画布）

### 2.1 供应商 / 模型选择 UI 的真实锚点

智能画布没有 `.llm-provider-select / .llm-body / .video-provider / .video-model / .llm-run*`（实测 0 命中），等价面是「pill + popover + 真 select」：

| 语义 | 锚点（file:line） | 说明 |
| --- | --- | --- |
| 引擎总入口（真 select，被隐藏合并） | `smart-canvas.html:212-218` `#engineSelect` | 5 个 option：`api / volcengine / modelscope / comfy / runninghub`；`smart-canvas.js:4656` 加 `is-merged` |
| 平台合一控件（运行时创建） | `smart-canvas.js:4650-4655` `#unifiedPlatformControl`（插在 engineSelect 前） | 选项渲染 4664-4673：`[data-unified-engine]` + `[data-unified-id]`；点击 4683-4690 → `applyUnifiedPlatform()` 4696 |
| 平台分组 | `unifiedPlatformEntries()` 4629-4637 | 「我的 API 平台」= 宿主投影的 image/video providers；「其它引擎」= volcengine/modelscope/comfy/runninghub |
| 生图平台 pill | `smart-canvas.js:5021-5031` `renderProviderControl()` → `.direct-option[data-smart-param="provider_id"]`（5027） | 参数栏（`#dynamicParams`，html:232） |
| 生图模型 pill | `smart-canvas.js:5032-5042` `renderModelControl()` → `[data-smart-param="model"]`（5038） | — |
| 视频平台 pill | `smart-canvas.js:4127` → `[data-smart-param="videoProvider"]` | `renderApiVideoParams()` 4726 |
| 视频模型 pill | `smart-canvas.js:4138` → `[data-smart-param="videoModel"]` | — |
| 参数总渲染 | `renderDynamicParams()` 4586；点击分发 6055 `[data-smart-param]` → `setDynamicSetting()` 5888 | 守卫「清清单外旧值」的落点 |
| 助手对话模型 | `smart-canvas.html:731` `#chatModelSelect`；`initChatModel()` 6463；`changeChatModel()` 6504 | 渲染 6481-6502 |
| 助手生图平台 | `smart-canvas.html:732` `#agentImageProviderSelect`；`initAgentImageProvider()` 6523；`changeAgentImageProvider()` 6536 | 渲染 6531-6534 |
| 运行按钮 | `smart-canvas.html:235-236` `#cascadeRunBtn / #runBtn`；`syncRunButtonState()` 10780 | 「未接通就 disable 运行」的落点 |
| 状态位 / 引导（经典是 `.canvas-nav-meta`，智能画布**没有**） | 候选：`#smartTitle`（html:249）、`#smartSaveState`（html:250，`aria-live`） | 新增状态位只能挂这两个或 `#engineSelect` 的父节点 |

**没有 `#apiKindToggle`**（本地源码 0 命中）。图片/视频不是全局开关，而是**按节点类型**：`smart-canvas.html:252-253` 创建菜单 `data-create-type="image|video"` → `createNodeFromMenu()` 29292 → `createImageNodeAt(p, [], {type:'smart-video'})` 29304。`settings.apiKind` 只在选中节点时由 `applyRecentSmartSettingsForCurrentMode`（1640-1656）推导。**按经典思路找「视频 kind 开关」会落空。**

### 2.2 smart-canvas.js 的 IIFE 尾部

- 收尾 `})();` 在 **`smart-canvas.js:34579`**（文件总行数 34579；`lastIndexOf` 命中这一处，vendor 脚本已用它作为注入点）。
- 已有只读暴露面 `window.__smartAgentTestHooks`（34240-34249）：`node/nodes/connections/selectedId/busy/setLocal/applyOps/save` —— **`applyOps` 直接调 `applyAgentCanvasOps()`，是现成的「Agent 应用画布操作」入口**，只读闸必须一起关掉（见 §4）。
- 适配层/守卫的**页面侧脚本注入点**：`smart-canvas.html:751` 的 `<script defer src="/static/js/smart-canvas.js">` 之后（经典页是在 canvas.js 标签后加 adapter+guard）。当前 vendor 只把「最小封堵」内联进 JS 尾部，**没有**在 HTML 里加 `openarc-adapter.js` / `openarc-canvas-guard.js`。

### 2.3 既有暴露面盘点（能否复用）

| 经典侧 | 智能画布现状 | 结论 |
| --- | --- | --- |
| `__openarcCanvasInternals`（注入层） | 不存在；只有 `__smartAgentTestHooks` | 需要新建注入层（同 IIFE 尾部） |
| `openarc-adapter.js` 命令面 | 不存在 | 需按 smart 节点模型重写（`nodes` 变量 + `canvas.connections`） |
| `openarc-canvas-guard.js` 的三条语义 | 并发会话的 `smart-canvas-guard.js` 只做最小封堵 | §2.1 的锚点表是按它重写的输入 |
| 三把 `canvas_*` localStorage 键 | **智能画布不读**（0 命中）；它读 `smart_chat_model` / `smart_chat_provider` / `smart_agent_image_provider` / `smart_canvas_recent_run_settings_v1` | 锁键逻辑不能照搬，要换新键 |

---

## 3. 页面侧「自己造事实」的兜底清单（逐条）

| # | 位置 | 现在造什么 | 封堵方式 | 探针 |
| --- | --- | --- | --- | --- |
| 1 | `smart-canvas.js:4074` `DEFAULT_VIDEO_MODELS`（11 个写死模型） | 被 `volcengineProvider()` 兜底（3772）和 `volcengineVideoModels()`（4090）使用 | 尾部覆盖 `volcengineProvider`：宿主 `api_providers` 里没有 volcengine 就返回 `null`；覆盖 `volcengineVideoModels` 返回 `[]`；`videoApiProviders()`（4075）在 `video_models` 恒空时自然为 `[]` | anchor-probe hit L4074 |
| 2 | `smart-canvas.js:3767-3775` `volcengineProvider()` | provider 不存在时**凭空造**一个带 `image_models:[]`、`video_models:DEFAULT_VIDEO_MODELS` 的「火山引擎」 | 同 #1：改成「只返回宿主投影里真实存在的 provider，否则 null」，所有调用点（3935/3948/4079/4741/4759）跟着 fail-closed | hit L3767 |
| 3 | `smart-canvas.js:4064-4066` `modelscopeImageModels()` | 没 provider 时返回 `['Tongyi-MAI/Z-Image-Turbo']` | 尾部覆盖为「无宿主 modelscope provider ⇒ `[]`」 | hit L4064 |
| 4 | `smart-canvas.js:450-455` `MS_GEN_MODELS` + `4856` 默认 `msgenModel='zimage'` + `28147` 兜底 `MS_GEN_MODELS.zimage` | ModelScope 的 modelId（`Tongyi-MAI/Z-Image-Turbo` 等）写死在页面 | 宿主无 modelscope 能力时：disable `[data-unified-engine="modelscope"]`、disable `[data-smart-param="msgenModel"]/["msCustomModel"]`，并在 `runGeneration` 前 fail-closed | hit L450 |
| 5 | `smart-canvas.js:3899-3903` `resolveChatModel()` | **已经不是** `gpt-4o-mini`（本地 0 命中）；现在是 `model || models[0] || ''` —— 残留事实只有「自动取第一个」 | 只要 `chatApiProviders()`（3887）只看到宿主投影就没问题；要更严可显式化「无 chat 能力 ⇒ 返回空串」 | hit L3899 |
| 6 | `smart-canvas.js:6463-6503` `initChatModel()` | 无模型时 6481-6486 给 `tr('canvas.noModelsHint')` 占位、`chatModel=''` —— **没有写死模型名** | 并发守卫针对 `gpt-4o-mini` 的补丁对这份源码是空操作；真正要封的是 #8 的记忆值 | hit L6463 |
| 7 | `smart-canvas.js:112` + `6268` + `27385` `comfyInstanceCount` | `6268`：`Math.max(1, (comfy_instances || []).length || 1)` —— 宿主给空数组时算出 **1**；`27385` 无 comfy 时返回 6 | 尾部覆盖：空/未接通 ⇒ `comfyInstanceCount = 0`；disable `[data-unified-engine="comfy"]` 与 `[data-smart-param="comfyMode"]/["comfyWorkflow"]`，`/api/canvas-comfy-tasks` 页面侧明确失败 | hit L112 |
| 8 | `smart-canvas.js:6488-6489 / 6510-6511`、`6527 / 6539`：`smart_chat_model`、`smart_chat_provider`、`smart_agent_image_provider` | 页面记住的「上次模型/平台」，是第二来源（渲染时会跟清单校验，但宿主清单变了而页面没刷新的窗口里会残留） | 按经典三把键同一手法锁读写：读恒 null、写丢弃、旧值清除；至少也要在 `initChatModel/initAgentImageProvider` 后清掉清单外值 | hit |
| 9 | `smart-canvas.js:1594` `smart_canvas_recent_run_settings_v1`（1606-1638） | 按模式缓存的整套 run settings（含 provider/model/engine），`applyRecentSmartSettingsForCurrentMode()` 1640 会合并回 `settings` | 同 #8：按宿主清单清洗，或锁掉该键 | hit L1594 |

**结论**：智能画布的「自己造事实」不是上一包列的 `gpt-4o-mini`，而是**火山 / ModelScope / ComfyUI 三处凭空造 provider/模型** + **四把 localStorage 记忆键**。封堵必须在 IIFE 内（同域），外部脚本够不到这些闭包变量。

---

## 4. 只读闸

### 4.1 现状（实测）

智能画布**完全不消费**宿主下发的 `context{canEdit,readOnly}`：`smart-canvas.js` 里 `canEdit` / `readOnly` / `__openarcCanvasReadOnly` **0 命中**。桥已经把事实准备好了，只是没人听：
- `openarc-bridge.js:129/141` 把 `hello/context` 的 `canEdit` 写进 `ctx`；
- `openarc-bridge.js:136/145` 派发 `window` 上的 `openarc-canvas-context` 事件（`detail: {readOnly, canEdit, canvasId, models, top}`）；
- `openarc-bridge.js:191` `isReadOnly()`。
并发会话的 `smart-canvas-guard.js` 已监听该事件并写 `window.__openarcCanvasReadOnly`（246-251），也用 `syncReadOnly`（233-245）——**但只包了 `pushUndo` 和 `syncRunButtonState`，覆盖不了下面这些路径**。

### 4.2 所有编辑入口（逐条 file:line）

坐标全部相对 `static/js/smart-canvas.js`（HTML 的另标）。

**A. 结构编辑（新增/删除/分组/复制）**

| 路径 | 入口 | 最终落到 |
| --- | --- | --- |
| 创建菜单（图片/视频/分组/提示词/文本/标签/表格/批量） | `createMenu` click 30821-30825 → `createNodeFromMenu()` 29292 | `createImageNodeAt()` 2128 / `createPromptNode` 等 |
| 键盘删除 | `window keydown` 30316-30322 | `deleteNode()` 21045 |
| 节点菜单删除/复制/分组/解组 | `onSmartNodeMenuClick()` 34398-34428 | `deleteNode` / `duplicateSelectedSmartNodes` 11823 / `groupSelectedNodes` 28730 / `ungroupNode` 28762 |
| Ctrl+D 复制 | 30273-30277 | `duplicateSelectedSmartNodes()` 11823 |
| Ctrl+V 粘贴 / 素材入库粘贴 | 30289-30296 / `pasteAssetsFromInbox` | `pasteNodes()` 11870 / 11919 |
| 节点删除按钮 | `deleteNodeFromButton()` 21087 | `clearNodeMediaBeforeDelete()` 21063 或 `deleteNode()` |
| 分组成员吸收 | `addNodeToSmartGroup()` 2211 | — |
| 自动整理 | `arrangeSelectedSmartNodes()` 3490 / `arrangeSmartGroupMembers` | — |
| 媒体拖入节点 | anonymous `el.ondrop` 20975-20981 | `handleSmartImageDropPayload()` 24904 |
| 本地文件选择 | `pickLocalMediaForNode()` 20478 | — |
| 首页种子铺节点（load 时） | `applyHomeCanvasSeed()` 34498 / `consumeHomeCanvasSeed()` 34556 | 直接 `nodes.push` |

**B. 位置 / 尺寸 / 连线（手势）**

| 路径 | 入口 | 提交点 |
| --- | --- | --- |
| 拖动节点 | `beginNodeDrag` **闭包内 const**（20892-20927，绑定在 20973） | `commitPendingUndo()` 210（快照在 20926 `capturePendingUndo`） |
| 缩放节点 | resize 把手 mousedown 20870-20890（`resizeState` 20887） | `finishNodeResize()` 29566（`capturePendingUndo` 20889） |
| 端口拖线（新建/删除连线） | port mousedown 20931-20950（`portDragState`） | `handlePortDrop()` 20370（`capturePendingUndo` 20947）→ `addConnection()` 25176 / `connectInputNode()` 25183 |
| 方向键微调 | 30278-30281 | `nudgeSelectedSmartNodes()` 11854（`pushUndo` 11861） |
| Alt+对齐 | 30311-30315 | `alignSelectedSmartNodes()` 34269（`pushUndo` 34280） |
| 框选 | `shell.onmousedown` 29343-29362（`selectionState`） | `finishSelection()` 28711 —— **只改选中，不改文档，只读下可放行** |
| 画布平移/缩放 | 29363-29368、wheel | 只改 `viewport`（可放行；保存口径见 4.4） |

**C. 撤销 / 重做**

| 路径 | 位置 |
| --- | --- |
| Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | 30301-30309 |
| 栈原语 | `pushUndo()` 261、`performUndo()` 290、`performRedo()` 282、`restoreUndoSnapshot()` 268 |

**D. Agent / 模型驱动的画布改动**

| 路径 | 位置 |
| --- | --- |
| `window.__smartAgentTestHooks.applyOps` | 34247 → `applyAgentCanvasOps()` 7618 |
| Agent 流式事件 `canvas_ops` | 7768、7797 |
| `/api/agent/apply-prompt` 回包 | 8146（同函数） |
| Agent 方案「执行 / 回滚 / 预览」 | `agentPlanAction()` 9002：apply 9055-9118、rollback 9120+、preview 9028（preview 只读，可不拦） |

**E. 参数 / 设置（会写进 `canvas.settings` 并 scheduleSave）**

| 路径 | 位置 |
| --- | --- |
| 参数 pill 点击 | 6055 → `setDynamicSetting()` 5888 |
| 平台 pill 点击 | 4683-4690 → `applyUnifiedPlatform()` 4696 |
| 引擎 select | 30341-30349 |
| 助手模型/平台 select | `changeChatModel()` 6504 / `changeAgentImageProvider()` 6536 |
| 提示词文本保存 | `saveSmartPromptTextFromComposer()` 23910、promptInput 30881 |
| 标签面板 | 30815-30817 |
| 画布标题就地重命名 | `bindSmartTitleRename` 33621-33650 |
| 提示词模板增删改 | `createPromptTemplateGroup()` 10295（vendor 已改走 __openarcPrompt）、`renamePromptTemplateGroup()` 10318、`deletePromptTemplate()` 10267、`deletePromptTemplateGroup()` 10340 |
| 版本还原/删除 | `restoreCanvasVersion()` 31338-31366（整篇换 nodes）、`deleteCanvasVersion()` 31367 |
| 生成/运行（改节点 runStatus/images/output 并落库） | `runGeneration()` 27628、`runSmartNodeToolbarAction()` 18492、`rerunSmartNode()` 33836 |
| 保存 | `saveCanvas()` 11653（PUT /api/canvases/:id） |

### 4.3 注入方案（按「不加新上游结构」的最小集合）

在 `smart-canvas.js` IIFE 尾部（34579 前）注入只读闸，四层：

1. **上下文层**：监听 `openarc-canvas-context`，写 `__oaReadOnly`；首次 `bridge().isReadOnly()` 兜底；只读时给 `document.documentElement` 加 `[data-openarc-readonly="1"]`（只做观感，不是功能拦截）。
2. **手势闸（capture 阶段，覆盖闭包内匿名处理器）**：`document.addEventListener('mousedown'/'pointerdown'/'touchstart', handler, true)`：只读且 `e.target.closest('.image-node, .node-port, .resize-handle, .create-menu, .asset-panel, .smart-title')` 时 `preventDefault()+stopPropagation()`。这能拦住 §4.2-B 全部手势（拖动/缩放/端口拖线）以及创建菜单，**不需要改 20892 那个闭包内 const**。
   - 拖拽/缩放已在进行中（只读状态是运行中变的）：在 `commitPendingUndo()` 210 包一层，只读时 `restoreUndoSnapshot(pendingUndoSnapshot); discardPendingUndo();` —— 用**已有的**快照回滚，不新造状态。
   - `dragover/drop` 也挂 capture：只读时 `preventDefault()`（同时避免浏览器默认导航）。
3. **命名函数闸**：包装（只读时 return null / 走 blocked 通道，并派发与经典一致的 `openarc-canvas-blocked {reason:'READ_ONLY'}` 证据事件）：
   `pushUndo` 261、`performUndo` 290、`performRedo` 282、`deleteNode` 21045、`createNodeFromMenu` 29292、`createImageNodeAt` 2128、`duplicateSelectedSmartNodes` 11823、`pasteNodes` 11870、`pasteAssetsFromInbox` 11919、`nudgeSelectedSmartNodes` 11854、`alignSelectedSmartNodes` 34269、`groupSelectedNodes` 28730、`ungroupNode` 28762、`addNodeToSmartGroup` 2211、`arrangeSelectedSmartNodes` 3490、`handlePortDrop` 20370、`finishNodeResize` 29566、`handleSmartImageDropPayload` 24904、`pickLocalMediaForNode` 20478、`applyAgentCanvasOps` 7618、`agentPlanAction` 9002（只拦 apply/rollback）、`runGeneration` 27628、`runSmartNodeToolbarAction` 18492、`rerunSmartNode` 33836、`setDynamicSetting` 5888、`applyUnifiedPlatform` 4696、`saveSmartPromptTextFromComposer` 23910、`restoreCanvasVersion` 31338、`deleteCanvasVersion` 31367、`createPromptTemplateGroup` 10295、`renamePromptTemplateGroup` 10318、`deletePromptTemplate` 10267、`deletePromptTemplateGroup` 10340、`applyHomeCanvasSeed` 34498。
   这些是 `function` 声明，尾部注入可以重新赋值；但 `beginNodeDrag`（20892）是闭包内 `const`，**够不到**，只能靠第 2 层。
4. **保存闸**：只读时 `saveCanvas()`（11653）不 PUT；但平移/缩放的 `viewport` 仍可本地记住（`persistViewportLocally`）。做法：只读时若 `canvasContentSignature`（11664）没变就照旧 return，否则也跳过 PUT 并保持 `setSmartSaveState('saved')` —— 具体口径需真机确认（否则宿主 revision 会因只读页浏览而增长）。

### 4.4 明确无法「不改上游结构」拦住的

| # | 拦不住的点 | 原因 | 可接受兜底 |
| --- | --- | --- | --- |
| 1 | 拖动/缩放**过程中**节点已经在屏幕上移动（`node.x/y/w/h` 在 mousemove 里直接写） | 手势处理器是闭包内匿名/const，尾部注入够不到；capture 闸只能拦「手势一开始」，运行中切只读的瞬间会有一帧已应用的位移 | capture 闸 + `commitPendingUndo` 回滚；接受极端时序下的一帧视觉位移（真机确认） |
| 2 | 触屏经 `js/touch-mouse.js` 合成鼠标事件 | 合成路径是否冒泡到 document capture 需真机确认 | 同时挂 `pointerdown/touchstart` |
| 3 | 节点内联 `contenteditable`（promptInput 224、chatInput 725、标签面板）直接改 DOM 文本 | 文本只在 save/run 时回写节点，`contenteditable` 本身不是函数 | 拦 `saveSmartPromptTextFromComposer`；纯本地输入不改文档，可放行 |
| 4 | 服务端副作用：版本还原/删除、Agent apply/rollback、生成 | 是 HTTP 调用；拦的是**页面侧入口函数**，不是服务端 | 拦入口；宿主侧权限（`model.use` / 画布写权限）仍是最后一道 |
| 5 | 别的窗口 / 宿主 IPC 对同一本画布的写入 | 那不是「页面只读闸」的职责 | 保持现状（经典画布也一样） |

---

## 5. 门禁重定向清单（`experiments/d5-02/canvas-e2e.mjs`）

文件 1714 行；`canvasFrame()` 定义在 **L71**（正则匹配 `/static/canvas.html`），`shellFrame()` L75（`listFrame() || canvasFrame()`），`reopenCurrentCanvasFromHome()` L196-209。**上一包的初版清单只到「E1/E2/E3/E4 + 供应商断言 + 冲突合并」粒度，下面是逐用例补全。**

| 用例 | 现依赖（行） | 处置 | 改法 |
| --- | --- | --- | --- |
| A0 | 启动/登录（227/249） | **保留** | 页面无关 |
| A1 | canvas-list 入口（255-261） | **保留** | 不涉及 canvas.html |
| A2 | 子页不可达；`SUBPAGES` 含 `smart-canvas`（266-271） | **改** | 智能画布已是唯一编辑器，`SUBPAGES` 必须去掉 `smart-canvas`，否则与新入口自相矛盾 |
| A3 | `canvasFrame` + `__openarcCanvas/Internals` + `#canvasPickerOverlay`（285-296） | **改指向智能画布** | frame 断言换 smart；适配器就绪换新注入面；遮挡层判定（列表页）保留 |
| A4 | `#backToManagerBtn`（298-304） | **改** | 智能画布返回按钮是 `.smart-back`（html:248，`onclick=backToCanvasList()`） |
| A5 | canvas.html + `__openarcCanvas.state()`（312-318） | **改** | 同 A3/A4 |
| A6 | 卡片直达（326-330） | **改** | 断言 smart 帧 + 同一 canvasId |
| A7 | 命令层 add/connect/move（333-344） | **改（依赖新适配层）** | 智能画布无 `__openarcCanvas`；需先建 smart 命令面，否则降级为真机探针 |
| A8 | undo/redo（347-356） | **改** | 用智能画布原生 `performUndo()/performRedo()`；`primitives.getNode` 换成 `__smartAgentTestHooks.node(id)` |
| A9 | 返回列表（442-448） | **改** | `.smart-back` |
| A10 | 重开同一本（452-457） | **改** | smart 帧 + `__smartAgentTestHooks.nodes()` |
| N1 | `.canvas-nav-meta[data-openarc-model-status]`、`.llm-provider-select/.llm-model/.generator-body .provider-select`（365-390） | **改（守卫重写后）** | 换 §2.1 锚点：`#engineSelect`、`#unifiedPlatformControl [data-unified-engine]`、`[data-smart-param=provider_id/model]`、`#chatModelSelect`；状态位要新加 |
| N2 | 引导按钮 `.canvas-nav-meta [data-openarc-open-model-settings]`（393-405） | **改** | 新状态位/引导锚点（`#smartSaveState` 或 `#smartTitle` 旁） |
| N3 | 视频节点/下拉/运行按钮、`data-openarc-guard-note`（408-436） | **改** | pill `[data-smart-param=videoProvider/videoModel]`、视频节点运行按钮；guard-note 契约需新守卫补 |
| B1 | `/api/config` 投影（477-505） | **保留**（帧换 smart） | 与 DOM 无关 |
| B2 | LLM 链，用 primitives + runNode（507-517） | **改（依赖新注入面）** | 换成智能画布节点模型 |
| B3 | 图片链（519-529） | **改** | 同上 |
| B4 | 失败如实展示（531-540） | **改** | 同上 |
| N4 | 经典四下拉 + 三把 `canvas_*` 键（544-575） | **改** | 换智能画布锚点 + 新键（§3 #8/#9） |
| N6 | `/api/canvas-llm` 清单外模型 502（580-597） | **保留**（帧换 smart） | 页面无关 |
| B5 | `/api/canvas-video` 501（599-604） | **保留** | 依赖守卫在页面侧回答 |
| B6 | 更新/队列（606-611） | **保留** | shellFrame |
| D1 | 撤权 IPC canvas/run（614-627） | **保留** | 无页面依赖 |
| N5a | 经典模型区快照（622-634） | **改** | 换智能画布模型区快照 |
| D2 | 跨能力 IPC（636-653） | **保留** | — |
| N5c | `data-openarc-default-unavailable` 快照（655+） | **改** | 新守卫要在智能画布补同样契约 |
| D3/D4/D5 | 预算/停止/失败收敛（669-710） | **保留** | IPC 层 |
| F1 | 任务模型绑定（722） | **保留** | IPC |
| N5d | 停用默认文本模型（731+） | **改** | 智能画布模型区快照 |
| F3a/F3b/F3c | 资源 ref 链（750-791） | **部分改** | 存储/资源断言保留；页面呈现换 smart |
| F3d | 本地保存后宿主新增能进来（795-834） | **改** | 依赖 `__openarcCanvasInternals`；且经典的 D1 补丁（saveTimer）是 canvas.js 的，smart 的同步轮询是 `canvasSyncInFlight/dragState/selectionState`（10967），**要单独核** |
| F3e | 500ms 交错 + 三方合并 + `<id>-remote`（836-915） | **改 / 待裁决** | smart 有**原生** 409 合并 `applyMergedServerCanvas()` 10908，但**没有** `<id>-remote` 副本语义；要么移植，要么降级并登记缺项 |
| E1 | 无桥/Node/IPC（918-923） | **保留**（帧换 smart） | — |
| E2 | 协议穿越：白名单内抓 `/static/js/canvas.js`（925） | **改** | 换成 `/static/js/smart-canvas.js`（否则断言打到已删文件） |
| E3 | 伪造身份（932） | **保留** | — |
| E4 | 伪造帧用 canvas-list（951-988） | **保留** | — |
| E5/E5b/E6 | 出网拦截（988-1003） | **保留**（帧换 smart） | — |
| E7/E8 | 账号边界（1016-1029） | **保留** | — |
| F4 | AI 编辑链（1044+） | **改** | 依赖经典命令面；同 A7 |
| F3f | AI 来源标记 + 淡入（1096-1150） | **改 / 待裁决** | 经典是在 `renderNode()` 上补标记；smart 是 `render()` 整层重建，移植点不同；不搬就删该用例并登记缺项 |
| F3g | 回收站 FAB（1195+） | **保留** | 列表页 |
| F3h | 卡片菜单（1307+） | **保留** | 列表页 |
| Z1 | 主进程错误（1320） | **保留** | — |
| F4b | AI chain2 前置（1685+） | **改** | 同 F4 |

**同批必须一起改的（本包顺带核出，上一包只点了 asset-refs）**：

| 文件 | 依赖 | 处置 |
| --- | --- | --- |
| `tests/dxos-canvas-asset-refs.test.mjs:162-171` | 已改成「按实际存在的页面过滤」 | **不用改**（删 canvas.html 后自动只剩两页，语义未放松） |
| `tests/dxos-canvas-size-policy.test.mjs:25` | **顶层** `readFileSync(public/.../js/canvas.js)` + C 段抽 `fitApiSizePair` | **硬阻塞**：删 canvas.js 会 ENOENT。要么把 C 段改指 `smart-canvas.js` 的 `apiImageSize()`（4331，**没有** `fitApiSizePair`，需重写断言），要么删掉 C 段并登记 |
| `tests/dxos-image-params.test.mjs:128` | 读 `public/.../js/canvas.js` 的 `SIZE_MAP` | 改读 `smart-canvas.js`（`SIZE_MAP` 在 456，形状一致） |
| `tests/dxos-canvas-online-update.test.mjs`、`tests/d5-02-canvas-static-web.test.mjs` | 用临时目录造 canvas.html | 不受影响 |
| `experiments/d5-02/canvas-e2e.mjs:925` | E2 抓 canvas.js | 见上表 E2 |
| `experiments/d5-02/agent-canvas-probe.mjs`、`experiments/dxos-canvas-*/**` 多个真机探针 | 按 canvas.html 取帧 | 下一批统一重定向或归档（不在本包范围） |

---

## 6. 上游继续改动 → 哪些结论会失效

| 结论 | 失效条件 | 现在的证据 |
| --- | --- | --- |
| 所有 file:line | 上游再改 `static/js/smart-canvas.js` / `static/canvas-list.html` / `smart-canvas.html` | HEAD 22feb298 + 脏 141 文件；每次重跑 `anchor-probe.mjs` 对齐行号 |
| 入口锚点（LIST_PATCHES 14/14） | 列表页再改 `openCanvas/createCanvasFromPicker/btnContinueLast` 结构 | 干跑 14/14 hit |
| `apiImageSize` 补丁（1 处 MISS） | 上游已改这段函数，OpenArc 补丁 from 失配 | 干跑唯一 MISS；本地新实现已自带「长边定档 + 等比」但改为交给 `NovaSizePolicy.constrain`，**必须重新推导或删除该补丁** |
| `apiKindToggle` / `syncApiKindToggleVisibility` / `gpt-4o-mini` 不再是锚点 | 上游若回退这些名字 | anchor-probe 6 条 ABSENT |
| IIFE 尾部 = 34579 | 上游增删行 | anchor-probe js-tail |
| 63/94 保留/排除、内容指纹 | 上游新增/删除 static/ 文件 | 干跑输出 + 指纹 |

---

## 7. 本包产物

| 文件 | 说明 |
| --- | --- |
| `experiments/d5-02/vendor-novai-app.mjs` | 加 `OA_NOVAI_SRC` 本地源支持 + `--dry-run`；10 个 hunk（`artifacts/dxos-canvas-revendor-next/vendor-script-my-diff.patch`） |
| `experiments/dxos-canvas-revendor-next/SOURCE.md.template` | 来源块模板 |
| `experiments/dxos-canvas-revendor-next/anchor-probe.mjs` | 只读锚点探针（66 MUST / 6 ABSENT），`--json` 可机读 |
| `experiments/dxos-canvas-revendor-next/PORT-PLAN.md` | 本文档 |
| `experiments/dxos-canvas-revendor-next/RUNBOOK.md` | 用户说「好了」之后要跑的那一条命令 |
| `artifacts/dxos-canvas-revendor-next/dry-run-console.txt` | 本地源干跑完整输出 |
| `artifacts/dxos-canvas-revendor-next/dry-run-pinned.txt` | 不传 OA_NOVAI_SRC 的对照干跑（0 差异 / 0 MISS） |
| `artifacts/dxos-canvas-revendor-next/dry-run-stderr.txt` | 空（证明无警告/无错误） |
| `artifacts/dxos-canvas-revendor-next/anchor-probe.txt` | 锚点探针输出 |
| `artifacts/dxos-canvas-revendor-next/vendor-novai-app.mjs.snapshot-concurrent` | 并发会话改到一半的 vendor 脚本快照（本包编辑基线） |
| `artifacts/dxos-canvas-revendor-next/vendor-script-my-diff.patch` | 本包对 vendor 脚本的完整 diff |
| `artifacts/dxos-canvas-revendor-next/vendor-script-sha-before.txt` | 编辑前 sha256 |
