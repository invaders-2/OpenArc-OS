# 上游来源与改动记录（D5-02 · 完整应用）

- 仓库：https://github.com/invaders-2/NOVAI-Infinite-Canvas
- **固定的源 commit：`6ce1a64680b669b31c2ac3b32418b54decd404f2`**（vendor 脚本每次核对 `git rev-parse HEAD`）
- 本轮 vendor **整个 `static/`**（14 个页面 + js/css/images/vendor/system-prompts/runninghub，103 个文件）：
  **产品入口 = 上游原版 `static/canvas-list.html`（"画布工作台"：无限画布标题 + 开始创作 / 继续上次 /
  新建画布 + 画布卡片列表）；它上面的每个入口都直接打开真实编辑器 `static/canvas.html?id=…`，
  编辑器自带的返回按钮回到列表页 —— 首页 ⇄ 编辑器就是完整往返路径。**
  `index.html`（AI Studio 外壳：首页 + 左侧导航 + 子页）仍然 vendor 到 bundle 根，但**不再是入口**，
  只留给宿主级边界测试使用。
  上游的 Python 后端与桌面壳不在本目录内（OpenArc 用受控能力替代，见下）。

## 生成方式（唯一入口，可重复执行）

```
OA_NOVAI_SRC=/tmp/novai-canvas-src node experiments/d5-02/vendor-novai-app.mjs
```

**不做 `/static/` 路径改写**：`openarc-canvas:` 是 `standard:true` 的自定义协议，
页面里的根绝对 `/static/...` 会自然解析成 `openarc-canvas://bundle/static/...`。
改写 14 个页面 + i18n 动态注入 + 动态 `import()` 的风险远大于原样服务，所以整棵树原样拷贝。

| 目录/文件 | 来源 | 说明 |
| --- | --- | --- |
| `static/**` | `static/**` | **原样**，仅做下面八处改动 |
| `index.html` | `static/index.html` | 上游外壳副本（桥 + 中继），**已不是产品入口**，只留给边界测试；根绝对 `/static/` 指向同一份资源 |
| `openarc-bridge.js` | OpenArc 新增 | 每页最先执行：端点白名单、账号作用域存储、pywebview 明确不可用、出网拒绝 |
| `openarc-shell.js` | OpenArc 新增 | **只注入 bundle 根 `index.html`**（已不是产品入口）：子页 ↔ 外壳 ↔ 宿主的中继协议 |
| `openarc-adapter.js` | OpenArc 新增 | 只注入画布页：把宿主命令翻译成画布自己的原语（同一命令层 + 只读闸） |
| `openarc-canvas-guard.js` | OpenArc 新增 | **只注入画布编辑器页**：供应商/模型单一真源守卫（读 `/api/config` 的能力事实、真实 disable 未接通/未配置的下拉、清清单外旧值、锁死三把页面侧模型来源键、提供"打开 OpenArc 总 API 设置"引导） |

## 对上游文件的八处改动（脚本化、可审计）

1. 每个页面 `<head>` 开头：CSP meta + `<script src="/openarc-bridge.js">`；
2. `static/js/canvas.js` 的 IIFE 末尾追加适配层（模板：`experiments/d5-02/vendor/canvas-internals.js`）：
   暴露画布原语（`window.__openarcCanvasInternals`）、只读闸、与撤销配对的 redo；
3. `static/canvas.html` 在 `canvas.js` 之后依次注入 `openarc-adapter.js`、`openarc-canvas-guard.js`
   （defer 顺序 = 执行顺序，守卫在 `window.onload` 里的首次 `loadConfig()` 之前装好 `fetch` 包装）；
   bundle 根 `index.html` 在桥之后注入 `openarc-shell.js`；
4. `static/canvas-list.html`（产品入口）的三个"新建"入口改成**直接进编辑器**：
   `btnStartCreate` / `btnNewProject` / 「继续上次」空列表兜底，从 `openCanvasPicker()` 改成
   `createCanvasFromPicker('classic')`（该函数本来就是"建完直接跳 canvas.html"）。
   同一个文件里还有**右下角回收站 FAB 的显隐**（第十五批，用户裁定：空 ⇒ 隐藏、非空 ⇒ 显示）：
   按钮标记加 `hidden`、样式补 `.trash-fab[hidden] { display: none; }`（`.trash-fab` 自带
   `display: flex`，会盖过 `[hidden]` 的 UA 规则）、`updateTrashBadge()` 里用**已经存在的那一个事实**
   （`v4DeletedCanvases.length`）切换 —— 上游每次回收站变化（初始 `loadTrash` / 删除后 `loadTrash` /
   恢复 / 彻底删除 / 清空 / 拦到 trash 响应）都经过它，所以 FAB 与角标永远同源；页面还没有回收站数据时
   按"空"呈现（与角标 `style="display:none"` 同一约定），由 `loadTrash()` 的响应决定是否显示。
   显隐是**真隐藏**（不占布局 / 不进 tab 顺序 / 不接收点击），不是 CSS 遮挡。
   两处补丁都写在 `vendor-novai-app.mjs` 的 `LIST_PATCHES` 里，幂等，且目标找不到就**报错退出**（不静默跳过）。
5. `static/js/canvas.js` 的 `saveCanvas()` 里补一句 `if(saveTimer){ clearTimeout(saveTimer); saveTimer = null; }`：
   上游只在 `beforeunload` 里清 `saveTimer`，定时器触发过一次之后句柄一直留着，而远端同步入口
   `applyRemoteCanvasData()` 的判空条件里含 `saveTimer` ⇒ 恒真 —— 同一页做过一次本地编辑/保存之后，
   宿主 / AI 对画布的改动只反复延后 1s 重试，20s 都进不到**已经打开的编辑器**里（第八批真机复现的 D1）。
   补丁写在 `vendor-novai-app.mjs` 的 `CANVAS_JS_PATCHES` 里，幂等，且目标找不到就**报错退出**（不静默跳过）。
6. `static/js/canvas.js` 的 IIFE 末尾（适配层**之前**）依次内联两个纯数据模块（都不碰 DOM、
   不读画布闭包，因此 Node 单测 require 的是**同一份文本**，不是影子实现）：
   · 三方合并 `experiments/d5-02/vendor/canvas-merge.js`（单测 `tests/d5-02-canvas-merge.test.mjs`）；
   · AI 新增标记 / 入场去重 `experiments/d5-02/vendor/canvas-ai-marks.js`
     （单测 `tests/d5-02-canvas-ai-marks.test.mjs`，见下面第 8 条与差异表第 17 条）。
7. `static/js/canvas.js` 的 `saveCanvas()` 三处补丁（同 `CANVAS_JS_PATCHES`，幂等、缺目标即报错）：
   `saveCanvas()` 记录"这次真正发出去的文档"；保存成功时把它交给注入层（下一次冲突的 base）；
   **409 分支改为交给注入层做三方合并**（不再"换上新基线 → 重发同一份旧文档"）。见下面第 15、16 条差异。

8. `static/js/canvas.js` 的注入层增加**AI 新增节点的来源标记 + 160ms 淡入**（MOTION_SYSTEM §6，
   模板：`experiments/d5-02/vendor/canvas-internals.js` 的 `__ai*` 段）。它只做四件事：
   · 包装 `renderNode()`：节点元素生成的**那一刻**就补标记（`render()` 每次整层重建节点元素，
     渲染完再扫 DOM 补会漏帧）；
   · 包装 `syncRemoteCanvasNow()`：远端同步**之前**先取一次 marks（有界 400ms）；
   · `openCanvas()` 加载完成后再取一次（重开保留来源标记；此刻节点已在 DOM 里，只补标记不补动画）；
   · `applyRemoteCanvasData()` / 冲突合并写回之后再取一次（这两条路径没走同步前预取）。
   取 marks 走桥的**唯一一条只读路由** `GET /api/canvases/{id}/agent-marks` → 宿主
   `canvas.agentMarks` → 既有 `canvas/log` + `canvas/get`（**没有新增命令面、没有放宽任何白名单**）。

注入清单与哈希写在 `experiments/d5-02/vendor/vendor-manifest.json`（每次 vendor 重新生成）。

## 与上游行为的差异（全部在集成层，不改上游文件）

| # | 上游行为 | OpenArc 里的处理 | 为什么 |
| --- | --- | --- | --- |
| 1 | `DEFAULT_PAGE_ID='zimage'`(3901) 与预载 `frame-home`(3279) 不一致，首启停在"在线生图" | 中继在页面脚本之前把 `studio_active_page` 默认写成 `home`（**只在用户从未选过时**） | 首启必须是原版首页；用户选过就完全按上游记忆还原 |
| 2 | 首页点"最近项目"= 只切到画布管理器（`open-canvas` 消息只服务"待导入图片"） | 中继记下 `navigate` 里的 canvasId，直接驱动 `frame-canvas` 打开**那一本**编辑器 | 产品流程要求"返回首页 → 再打开项目"真的回到那本书 |
| 3 | 依赖 pywebview 桌面壳（11 个宿主方法） | 明确不可用：`window.pywebview` 读取即记录 + 明确提示，页面自动走网页版分支 | 不提供退出 OpenArc / 任意文件路径 / 任意宿主方法转发 |
| 4 | `localStorage`/`BroadcastChannel` 按同源共享 | 按 **OpenArc 账号 + 本次挂载** 的钥匙分桶（真实存储加 `oa:<key>:` 前缀，换挂载整片清掉） | "同一个 bundle origin"不等于不同账号已隔离 |
| 5 | `/ws/stats` 实时推送、桌面更新器（GitHub/Gitee/ModelScope 直连） | `/ws/stats` 明确失败（状态栏改用宿主队列计数）；更新/下载一律 501 并在界面标注"已禁用" | 不出网、不下载、不安装上游程序 |
| 6 | 首页「开始创作 / 新建画布」只弹"选画布"picker，「继续上次」空列表也落到 picker | 三处都改成 `createCanvasFromPicker('classic')`：建完立刻跳 `canvas.html` | 产品要求点入口**直接进真实编辑器**，不要额外欢迎页/选画布遮挡层 |
| 7 | picker 的「智能画布」走 `smart-canvas.html`（没有 OpenArc 适配层，不在安全不变式内） | 因此**不可达**；不为它补实现，也不隐藏任何入口 | 该页不在本次范围内，如实记录而不是拿遮挡层糊过去 |
| 8 | 子页的心跳由外壳页（`index.html`）中继 | 入口换成列表页后，**每个页面**靠 `openarc-bridge.js` 的 800ms `alive` 心跳喂宿主看门狗 | 入口不再固定是带中继的外壳页；没心跳会被看门狗按"帧被非预期导航打断"整帧重置 |
| 9 | 页面内部跳转（列表 → 编辑器）不带任何账号标记 | 桥的 `readAccountKey()` 在 fragment 无 `oa=` 时回落到同源真实存储的 `oa:mount`；两处都读不到就**跳过那次清理**，交给宿主 hello 的 `applyAccount` | 否则新页把账号读成 `anon` 并 `clear()` 掉刚写入的真实数据（来回一次就丢主题/项目记忆/待导入） |
| 10 | `api_providers` 为空时凭空造 `comfly` 供应商（`canvas.js:697-699/1705/1721`，provider 下拉显示 "Comfly"） | `/api/config` 的 `api_providers` 由宿主按 **OpenArc provider 真实投影**给出（`id`=providerId、`name`=displayName，只含该能力下有可用模型的 provider；不含 baseUrl/凭据）；守卫再按真源清单删掉任何不在清单里的下拉选项 | 供应商只能有一个来源：OpenArc 总 API 设置 |
| 11 | `video_models` 为空时填 25 个写死模型（`:586-606/1702`），视频节点默认 `veo3-fast`（`:8240/10484`），提交才撞 501 | `video_models` 恒为空 + `capabilities["video-generation"]={available:false,transport:null,reason}`；守卫把 provider/model 下拉**真实 disable**、写死"OpenArc 未接通视频传输（不可用）"、清掉节点里的写死模型、禁用运行按钮，拦截 `/api/canvas-video` 返回明确不可用错误 | 后端没有视频传输就不许显示成已连接 |
| 12 | ComfyUI 实例数 `Math.max(1, comfy_instances.length)`（`:1704`）、工作流下拉指向已死设置页 | `comfy_instances` 恒为空；守卫禁用 ComfyUI 节点的运行/模式/工作流控件并写"OpenArc 未接入 ComfyUI（不可用）"；`/api/canvas-comfy-tasks` 页面侧明确失败 | 同上，"0 个实例"不得显示成 1 个 |
| 13 | 第二套模型来源：localStorage 的 `canvas_custom_image_models` / `canvas_image_models_ordered` / `canvas_chat_models_ordered`（`:578-580/669-688/877-880`）会覆盖或追加清单外的模型名 | 守卫把这三把键的读写都拦掉（读恒为 null、写丢弃、旧值当场删除），并清掉下拉里任何不在 OpenArc 清单中的选项与选中值 | 模型清单只有 OpenArc 一个真源 |
| 14 | 所有"去 API 设置"文案指向已 501 / 已不可达的上游设置页（`canvas.js:1143/1147/1157/1739`、`js/i18n/canvas.js:5-7`） | 守卫把 `<option>` 文本里的"API 设置"改指"OpenArc 总 API 设置"，并在未配置处给出真实可点的引导按钮（`app.openModelSettings` → 宿主 `activateApp("settings")` 且停在「模型 / AI」） | 唯一能配置模型的地方是 OpenArc 总 API 设置 |

| 15 | 保存冲突（HTTP 409）时上游 `saveCanvas()` 把基线换成远端新值后**立刻重发同一份基于旧 revision 的整篇文档** = 对方（宿主 / AI / 其它窗口）那次改动被静默覆盖（第八 / 十 / 十一批真机实测） | 409 分支改为**三方合并**：base = 页面最后一次成功同步的文档（打开画布 / 整篇远端刷新 / 宿主 `reload-doc` / 保存成功四处维护），local = 页面当前文档，remote = 冲突回包里的远端文档。按 **node id / edge id / log id** 合并：只在一侧新增 → 保留；一侧删除、另一侧未改 → 删除；两侧都改同一项 → 字段级各自保留；**同一字段两边都改了 → 不猜**：本地那一版留在原位，远端那一版另存为可辨认副本（id 后缀 `-remote`、带 `oaConflictCopyOf` 标记、并排偏移 48px），并弹页面自己的 toast + 写只读证据 `window.__openarcCanvasConflicts`。合并结果写回页面（与 `applyRemoteCanvasData` 同一类"远端变更"路径：不压撤销栈），基线换成远端值后**只重发一次**；再冲突就重复合并但**有界（最多 2 次）**，仍冲突则明确呈现"无法自动合并，双方内容都已保留"并且**不再重试**（页面文档一旦再变才重新开始计数） | 用户硬要求：两方内容都必须保留，或明确呈现可恢复的冲突；不得静默覆盖任何一方；不许用盲目重试 409 / 延长定时器掩盖冲突 |
| 16 | `base_updated_at` 由宿主按 `current`（React 快照）里的 `updatedAt` 映射成 revision；而该快照在别处写入后最多落后 2.5s（2.5s 的 meta 轮询才刷新） | `src/canvas/CanvasHost.tsx` 的 `canvas.save`：页面声明的基线若与快照不一致，先按**存储的当前事实**（`canvas/meta`，只在真的不一致时多这一次调用）对齐快照再做映射；冲突回包里的远端文档按与 `canvas.get` 同一口径**解析资源引用**（ref → 当前用户有权读的 data URL） | ① 拿过期快照判定会把"已经对齐的基线"误判成过期（-1），页面只能靠反复重试等快照追上 —— 而追上那一刻它就用手里的旧文档覆盖了对方：这正是缺陷的最后一环，合并结果也必须落在正确 revision 上才谈得上"只重发一次"；② 冲突回包若给 ref 而页面本地是 data URL，合并会把"没改过的图片字段"误判成远端改动并换掉显示地址 |

| 17 | 上游画布**没有节点入场动画、也没有来源标记**：`render()` 每次整层重建节点元素，宿主 / AI 新增的节点在同一帧直接以终态出现，"哪个节点是 AI 加的"在界面上无从分辨（第八批真机证据） | 注入层按**命令账本**（`canvas/log`：`actorKind=AGENT` + `outcome=APPLIED` + `command.node.id`）给对应节点加一个中性来源徽标（`.openarc-ai-badge`，12/18、字重 500、中性灰、无描边、`--radius-sm`，`pointer-events:none` 不吃节点按钮的命中），节点元素带稳定契约 `data-openarc-ai-source="agent"`；**只有本次新增的那一个节点**播 160ms `cubic-bezier(.2,0,0,1)` 淡入（`data-openarc-ai-enter="1"`），已播过的 id 记在去重集合里，整层重建不重播；`html[data-openarc-reduced-motion="1"]` 与 `@media (prefers-reduced-motion: reduce)` 下 `animation:none;opacity:1`（即时呈现） | MOTION_SYSTEM §6「AI 新增节点采用 160 ms 淡入并保留来源标记」+ §8 减少动态效果；判据必须来自**命令账本**而不是"这次改动是远端同步来的"（后者会把本地用户新增、别的窗口的 USER 操作一起打成 AI） |

> 上表 1、2 两条只作用于 `openarc-shell.js`，而它只注入 bundle 根 `index.html`。产品入口换成
> `static/canvas-list.html` 后该外壳页不再是入口，这两条只在那次边界测试加载 `index.html` 时生效。

| 18 | `.trash-fab` 是**无显隐逻辑的静态元素**（上游只有角标按删除数显隐），回收站为空时右下角照样挂着一个回收站按钮 | 同一个真源（`updateTrashBadge()` 里的 `v4DeletedCanvases.length`）同时决定角标与 FAB：`hidden` 属性 + `.trash-fab[hidden] { display: none; }`；页面还没有回收站数据时按"空"呈现，`loadTrash()` 的响应决定是否显示 | 用户裁定"回收站为空时隐藏右下角按钮，有已删除画布时显示"；显隐必须是真实语义（DOM 属性 + 真实不渲染），不许用 CSS 遮挡冒充 |

## 未接入即缺项（保留入口 + 明确报错，不删页面）

素材库 / 提示词库 / 智能画布(Agent) / ComfyUI 与工作流 / RunningHub·即梦·Codex·Gemini-CLI 等第三方供应商 /
`/output`、`/assets` 历史文件浏览 / `/api/download-output`、`/api/view`、`/api/media-preview`
—— 这些页面照常可达，但它们的端点在桥里**明确返回 501 `OPENARC_UNSUPPORTED`**，
并作为一次性提示写进宿主状态（宿主已无窗口条/状态行/提示横幅；见 `src/canvas/CanvasHost.tsx` 的
`data-canvas-asset-notice-text` 只读证据通道）。
