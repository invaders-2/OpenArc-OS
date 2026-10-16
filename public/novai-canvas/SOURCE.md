# 上游来源与改动记录（D5-02 · 完整应用）

- 仓库：https://github.com/invaders-2/NOVAI-Infinite-Canvas
- **固定的源 commit：按 vendor 脚本的 `SOURCE_COMMIT` 核对（`git rev-parse HEAD`）**。本报告"只保留无限画布"的
  裁剪基线是 `6ce1a64680b669b31c2ac3b32418b54decd404f2`；**并发更新（2026-10-16 23:45）**：另一会话把上游升到
  `1e20abe5145470b32f58206f692292703540107a` 并重新 vendor（新增无损改图页 `static/tools/lossless-edit/` 等，
  `static/` 54→63、bundle 60→69），下游同一套白名单 + 闭包策略。**本次"删 bundle 根 index.html"的结论与保证不受影响**
  （vendor 第 5 步已移除、`prune-public.mjs` 会拒绝根 index.html 存在）。
- 裁剪基线（`6ce1a646`）：vendor **只保留无限画布**（页面白名单 + 依赖驱动闭包，见下「裁剪策略」）：`static/` 由上游 103 个文件
  裁到 **54 个文件 / 10,559,150 B**，bundle 共 **60 个文件 / 10,686,992 B**（bundle 根 6 + static/ 54；static/ 资源净减 3,305,663 B）。
  （并发升级到 `1e20abe5` 后：`static/` 63、bundle 69 / 12,613,133 B。）
  **产品入口 = 上游原版 `static/canvas-list.html`（"画布工作台"：无限画布标题 + 开始创作 / 继续上次 /
  新建画布 + 画布卡片列表）；它上面的每个入口都直接打开真实编辑器 `static/canvas.html?id=…`，
  编辑器自带的返回按钮回到列表页 —— 首页 ⇄ 编辑器就是完整往返路径；`kind === 'smart'` 的卡片去
  `static/smart-canvas.html`（智能画布编辑器，同属画布功能）。**
  bundle 根 `index.html`（AI Studio 外壳：首页 + 左侧导航 + 子页）**已删除**：它只被 E4 边界测试加载，
  而该外壳 eager 的 `#frame-home` 指向已删的 `static/home.html`（加载即 1 条 404）；E4 改到保留的产品页
  `static/canvas-list.html` 造伪造帧后它**零引用**。它的上游副本 `static/index.html` 更早已删。
  上游的 Python 后端与桌面壳不在本目录内（OpenArc 用受控能力替代，见下）。
  逐项依赖分析与删除/保留证据见 `PRUNE.md`。

## 本轮范围裁决（2026-10-17 · 第二包）· 入口已改向，经典编辑器**仍在包里**

用户裁决：无限画布只保留「列表页 + 智能画布」；经典编辑器 `static/canvas.html` / `js/canvas.js` /
`css/canvas.css` 的**物理删除**与**守卫 / 适配器按最终源码的整体移植**留到用户改完上游、**重新 vendor**
的那一次一起做（否则要基于旧源码写一遍、拉新源码再写一遍）。本包已落盘：

1. **入口改向（第 11 处改动）**：`static/canvas-list.html` 所有打开编辑器的入口一律改向
   `static/smart-canvas.html`（同一 `id` / `project` 参数，`smart-canvas.js` 读的就是这两个）：
   新建 `btnStartCreate` / `btnNewProject` / `pickerNormal`、卡片点击 `openCanvas(c)`、
   继续上次 `btnContinueLast`（及其空列表兜底）、新建函数 `createCanvasFromPicker` 内部。
   回收站恢复后仍走卡片点击路径，因此被同一条改向覆盖；「返回列表」不受影响。
2. **智能画布最小封堵（第 12 处改动）**：`static/js/smart-canvas.js` 的 IIFE 末尾内联
   `experiments/d5-02/vendor/smart-canvas-guard.js`，只封"服务商 / 模型清单只来自宿主"、
   "未接通能力（视频 / ComfyUI）如实禁用 / 标注"、"只读画布不可编辑"三件事；
   覆盖 / 未覆盖逐条见 `experiments/dxos-canvas-scope/README.md` 第 7.2、8 节。
3. **`static/canvas.html` 暂时保留在包里**（用户已从入口到不了它，但它仍在 bundle 中）。

> **待重新 vendor 时删除**：`static/canvas.html` / `static/js/canvas.js` / `static/css/canvas.css`（连同
> 只被它引用的资源），**并把 `openarc-canvas-guard.js` / `openarc-adapter.js` /
> `experiments/d5-02/vendor/canvas-internals.js` 按最终源码移植到智能画布**。逐条移植清单（本包最小封堵
> 之外的剩余项）见 `experiments/dxos-canvas-scope/README.md` 第 8 节。

受影响的门禁（`experiments/d5-02/canvas-e2e.mjs` 等）需要重定向到智能画布的用例清单见同 README 第 9 节。

本轮落盘前的阻塞（已由本包裁决解决）：① `tests/dxos-canvas-asset-refs.test.mjs` ⑦ 的页面列表原先只读
`canvas.html` / `canvas-list.html`，删文件必然 ENOENT；本包已按"对实际发布的每个页面都断言 CSP"改为
动态列表（含 `smart-canvas.html`），经典页删除后自动只剩保留页。② 便捷适配 = 重写而非最小适配；
本包只做能证明"不假可用"的最小封堵，其余留到重新 vendor。
## 裁剪策略（只保留无限画布，脚本化）

vendor 脚本不再整棵拷贝 `static/`，而是 **页面白名单 + 依赖驱动闭包**：

- `PAGE_WHITELIST = static/canvas-list.html, static/canvas.html, static/smart-canvas.html`
  （列表页 + 编辑器 + 按 `kind === 'smart'` 路由到的智能画布编辑器）；
- 从白名单页面出发解析 `/static/...` 引用（script/link/img、CSS `url()`、JS 里的写死路径 / fetch /
  动态 `import()`），传递闭包 = 保留集；闭包外的页面与资源一律不拷贝；
- `EXTRA_KEEP` 补齐标签之外的引用方：`static/system-prompts/infinite-canvas-prompt-templates.md`
  （画布提示词模板数据）、`static/images/RunningHub-B.png` / `RunningHub-W.png`
  （被 `src-vue/settings/providerLogos.ts:71` 引用）、`static/vendor/MANIFEST.md`（来源记录）。

删除的（`static/` 内 49 个文件 / 3,305,663 B）：外壳的 10 个子页面与它们的专属 JS/CSS；
未加载的 `js/canvas-list.js`、`js/i18n/validate-i18n.js`；未引用的图片（logo 变体 / icon.icns / icon.ico /
modelscope gif / volcengine svg / screenshots）；没有 `@font-face` 的 3 个 Space Grotesk 字体；
RunningHub 缩略图；`update-notes.json`；`static/index.html`。逐文件依据见 `PRUNE.md` 第 3 节。
**本轮又删 1 个（不在 `static/` 内）**：bundle 根 `index.html`（247,709 B）—— 详见 `PRUNE.md` 第 3 节末。

**必须保留、不能当"未引用"删的运行时数据**：`static/vendor/fonts/*`（只被 `vendor/css/fonts.css` 的
`url()` 引用）、`static/system-prompts/infinite-canvas-prompt-templates.md`（画布提示词模板，
`smart-canvas.js:6536` 经 `/api/smart-canvas/prompt-templates` 取用）、`js/i18n/api-settings.js` 与
`js/i18n/comfyui-settings.js`（名字像设置页，但被 `js/i18n.js:4-10` **无条件**加载，删了就是 404）。

执行器（没有上游检出时也能跑，只删不拷）：
```
node experiments/dxos-canvas-prune/prune-public.mjs --check   # 只报告
node experiments/dxos-canvas-prune/prune-public.mjs           # 落盘
```

## 生成方式（唯一入口，可重复执行）

```
OA_NOVAI_SRC=/tmp/novai-canvas-src node experiments/d5-02/vendor-novai-app.mjs
```

**不做 `/static/` 路径改写**：`openarc-canvas:` 是 `standard:true` 的自定义协议，
页面里的根绝对 `/static/...` 会自然解析成 `openarc-canvas://bundle/static/...`。
改写页面路径 + i18n 动态注入 + 动态 `import()` 的风险远大于原样服务，所以闭包内的文件**原样拷贝**（只按白名单裁剪，不改路径）。

| 目录/文件 | 来源 | 说明 |
| --- | --- | --- |
| `static/**` | `static/**` | **按白名单 + 依赖闭包裁剪**（139→63 文件），其余原样，仅做下面十二处改动 |
| `index.html` | — | **不再生成 / 已删除**：E4 边界测试改到产品页 `static/canvas-list.html` 后零引用；vendor 脚本第 5 步已移除并清残留 |
| `openarc-bridge.js` | OpenArc 新增 | 每页最先执行：端点白名单、账号作用域存储、pywebview 明确不可用、出网拒绝；含 2026-10 补登记的 **流式** LLM 端点（见下「OpenArc 自加脚本的同步改动」） |
| ~~`openarc-shell.js`~~ | OpenArc 新增（**已删除**） | 原先只注入 bundle 根 `index.html`：子页 ↔ 外壳 ↔ 宿主的中继协议。外壳删除后全仓零加载（无加载/注入点）⇒ 本轮裁决删除；vendor 第 5 步不再生成/保留并清旧副本，`prune-public.mjs` 把它列为「必须不存在」 |
| `openarc-adapter.js` | OpenArc 新增 | 只注入画布页：把宿主命令翻译成画布自己的原语（同一命令层 + 只读闸） |
| `openarc-canvas-guard.js` | OpenArc 新增 | **只注入画布编辑器页**：供应商/模型单一真源守卫（读 `/api/config` 的能力事实、真实 disable 未接通/未配置的下拉、清清单外旧值、锁死三把页面侧模型来源键、提供"打开 OpenArc 总 API 设置"引导） |
| `openarc-rename-modal.js` | OpenArc 新增 | 应用内模态输入（`window.__openarcPrompt`）：Electron 的 Chromium 不支持 `window.prompt`，上游在**列表页**（重命名画布）与**智能画布**（提示词模板分组 新建/重命名）的三处 `prompt()` 全部改走它；Esc / 遮罩取消、空值不提交、提交失败给结构化错误（HTTP 状态 + 原因）|

## 对上游文件的十二处改动（脚本化、可审计）

1. 每个页面 `<head>` 开头：CSP meta + `<script src="/openarc-bridge.js">`；
2. `static/js/canvas.js` 的 IIFE 末尾追加适配层（模板：`experiments/d5-02/vendor/canvas-internals.js`）：
   暴露画布原语（`window.__openarcCanvasInternals`）、只读闸、与撤销配对的 redo；
3. `static/canvas.html` 在 `canvas.js` 之后依次注入 `openarc-adapter.js`、`openarc-canvas-guard.js`
   （defer 顺序 = 执行顺序，守卫在 `window.onload` 里的首次 `loadConfig()` 之前装好 `fetch` 包装）；
   bundle 根 `index.html` 与其 `openarc-shell.js` 注入随外壳一起移除（不再生成）；该脚本本轮裁决删除（全仓零加载）；
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

9. `static/js/canvas.js` 的 `apiImageSize()` 改为**按比例对称求解、并受该档位像素上限约束**（补丁在
   `vendor-novai-app.mjs` 的 `CANVAS_JS_PATCHES` 第 5 条，幂等、缺目标即报错）：
   · 上游对 `custom` / `source` 比例只把像素上限压在一侧（长边恒等于该档 `RES_LONG_SIDE`），于是出现
     非方形与超上限结果（实测）：`custom 1:1 @1k → 1536x1248`（不是 1:1）、`4:3@1k → 1536x1072`、
     `3:4@1k → 1072x1536`、`1:1@4k → 3840x2880`、`3:2@4k → 3840x2336`、`2:3@4k → 2336x3840`
     （后四条面积都超过该档像素上限）。
   · 现改为：任意比例 / 自定义比例先按长边 `RES_LONG_SIDE[档位]` 等比定基线，再按
     `min(1, 长边上限/最长边, √(该档像素上限/面积))` 等比缩放后 16 对齐 —— 与宿主
     `electron/image-params.cjs` 的 `sizeFromRatio` 同一口径（`1:1@1k` 两边都得 1248x1248）。
     具名比例沿用 `SIZE_MAP` 预设，只在预设自身超上限时等比收窄（`square@4k` 的 4096x4096 → 2880x2880），
     1k/2k 及其余 4k 逐格不变。
   · 上游不是"刻意非对称"：具名比例是另一套稳定预设（本修补逐格保留），只有 custom/source 分支的单侧
     压限是几何缺陷；未发现任何后端约束依赖这个非对称结果。

10. **`prompt()` → 应用内模态**（补丁在 `vendor-novai-app.mjs` 的 `SMART_CANVAS_JS_PATCHES` 与 `LIST_PATCHES`，
    幂等、缺目标即报错）。Electron 的 Chromium **不支持 `window.prompt`**（调用即被忽略 / 抛
    `prompt() is not supported`），上游三处改名入口因此是死路：
    · `static/canvas-list.html` 卡片菜单「重命名画布」；
    · `static/js/smart-canvas.js` 的 `createPromptTemplateGroup()` / `renamePromptTemplateGroup()`（提示词模板分组）。
    三处都改成 `window.__openarcPrompt(opts)`（新脚本 `openarc-rename-modal.js`，`<head>` 里紧跟桥注入，**只给这两个产品页**）。
    模态用画布页自己的 token（`--panel` / `--shadow` / `--v4-*` / `--danger-text`）与交互习惯：Esc / 点遮罩 / 取消按钮关闭，
    空值不提交（内联错误、模态保持打开），`onSubmit` 拒绝时把「HTTP 状态 + 原因」结构化留在模态内（不 alert、不静默、不关窗）；
    同时补上焦点进入/回位、Tab 困在面板内、`role=dialog` + `aria-modal`、减少动态效果（宿主开关 / 系统偏好）。
    列表页的 `renameCanvasAPI()` 也从「catch + alert + refreshAll」改为**抛出结构化错误**，由模态呈现。
注入清单与哈希写在 `experiments/d5-02/vendor/vendor-manifest.json`（每次 vendor 重新生成）。

11. **入口改向（第 11 处改动）**：`static/canvas-list.html` 所有打开编辑器的入口改向
    `static/smart-canvas.html`（同一 `id` / `project`）—— 见上面「本轮范围裁决」与
    `experiments/dxos-canvas-scope/README.md` 第 2 节的逐处对照；补丁在 `vendor-novai-app.mjs` 的
    `LIST_PATCHES`，幂等、缺目标即报错。经典页 `canvas.html` 仍在包里但已无入口可达。
12. **智能画布最小封堵（第 12 处改动）**：`static/js/smart-canvas.js` 的 IIFE 末尾内联
    `experiments/d5-02/vendor/smart-canvas-guard.js`（`SMART_CANVAS_JS_PATCHES` 之后、收尾 `})();` 之前；
    必须同域才能封掉闭包里的页面侧兜底）。它只做三件事：
    · **服务商 / 模型清单只来自宿主 `/api/config` 投影**：`volcengineProvider` / `volcengineVideoModels` /
      `modelscopeImageModels` 的页面内置兜底失效，`resolveChatModel` 不再回落 `gpt-4o-mini`，
      `initChatModel` 在宿主没有对话模型时清掉 `gpt-4o-mini` 下拉，`unifiedPlatformEntries` 的
      「其它引擎」只列宿主 `api_providers` 里真实存在的 provider；
    · **未接通能力如实禁用 / 标注**：视频 kind 按钮真实 `disabled` + `data-openarc-unavailable` +
      复用经典守卫的 `.openarc-guard-note` 文案契约，`#engineSelect` 对应 option disable，
      能力不可用时运行入口在页面侧就被拒（`/api/canvas-video`、`/api/canvas-comfy-tasks` 返回明确 501，
      不会先点再撞）；
    · **只读画布不可编辑（V0.01 授权补齐为「逐条编辑路径被拒」）**：桥的 `openarc-canvas-context`
      事实落到 `window.__openarcCanvasReadOnly`（`readOnly` / `canEdit` 两个字段都认，后到的 context
      同样生效；桥默认 `readOnly:true` 是 fail-closed）；编辑面 `pointer-events` 关闭 + 光标
      `not-allowed`，与闸一致；三道页面侧闸逐条封堵 —— ① 事件闸（window 捕获阶段）拦下编辑面上的
      `mousedown/pointerdown/click/dblclick/contextmenu/dragstart/dragover/drop/paste/cut/beforeinput/input/change`
      与键盘编辑键（Delete/Backspace/方向键/Cmd+Z、Y、V、A、D、G、X）；② 函数闸把 173 个会改文档的
      闭包函数（拖动/缩放/框选/连线/增删/分组/表格内联/参数面板/右键菜单/撤销重做/模板库写/素材库写/
      Agent ops/生成落图/保存…）逐个包成「只读即拒」，并把页面提前 `window.*` 导出的那些重新指到包装实现
      （HTML 的 `onclick` 走 window，不重指会绕过闸）；③ fetch 闸把只读时任何非 GET/HEAD/OPTIONS 的
      请求在页面侧拒绝。三条都复用既有的 `data-openarc-readonly` / `openarc-canvas-blocked` 约定。
    证据面 `window.__openarcSmartGuard.facts()/providers()/blocked()/snapshot()/wrapped()/writeBlocked()/surfaces()`
    供门禁与真机探针读取。逐条清单、真机用例与结果见 `experiments/dxos-canvas-scope/README.md` 第 10 节。
    **这不是经典守卫的移植**：清单外旧值逐条清理、节点级可用性徽标、状态位、
    "打开 OpenArc 总 API 设置"引导、409 合并 / AI 来源标记等一律未搬 —— 逐条列在
    `experiments/dxos-canvas-scope/README.md` 第 4 节，留待重新 vendor 时按最终源码补齐。

### OpenArc 自加脚本的同步改动（不属于上面九处，改它不触发 vendor）

`openarc-bridge.js` / `openarc-canvas-guard.js` 是 OpenArc **新增**的脚本，不来自上游、不打上游补丁，因此
改它们**不需要重跑 vendor**，但必须在这里登记。

| 时间 | 文件 | 改动 | 边界 |
| --- | --- | --- | --- |
| 2026-10 | `openarc-bridge.js` | 登记一条**流式** LLM 路由：`POST /api/canvas-llm/stream` → 宿主 `model.chatStream`（`stream:true`）。桥把宿主的 `stream-open / stream-chunk / stream-end / stream-error` 消息拼成 `ReadableStream` + SSE，页面拿到的仍是受控 `Response`；取消时向宿主发 `abort`（带实例 token） | **只加登记项、不加通配**：未登记端点继续 501 `OPENARC_UNSUPPORTED`、出网继续 `OPENARC_EGRESS_BLOCKED`、CSP / 只读闸 / token 一律未动；分块只走既有 `postMessage` 通道，页面依旧没有网络与凭据 |
| 2026-10 | `openarc-bridge.js` | 登记尺寸策略路由：`GET /api/ai/size-policy` → 宿主 `model.sizePolicy`。宿主把唯一真源 `electron/image-params.cjs` 的 `GPT_IMAGE_2_SIZE_POLICY` 展开成页面 `shared/size-policy.js` 期望的 `{format, default, models}` 表（`models[画布模型显示名] = 策略`，非 gpt-image-2 走 `default` free + 同一份 tiers），桥按既有 JSON 通道原样回给页面 | **只加登记项、不加通配**；策略不含地址/凭据，出网、CSP、只读闸、实例 token 一律未动；不登记时页面恒为默认 free 模式（gpt-image-2 的 size 不会被吸附，见 `PRUNE.md`/本文件差异表） |

上游 `1e20abe514` 起 smart-canvas 的 LLM 节点改走 `/api/canvas-llm/stream`（旧版 `6ce1a646` 走非流式），
不登记这条就会出现"智能画布 LLM 拿到 501"的功能回退。**只登记这一条**；同一批升级里新增的
`/api/agent/*`、`/api/image/upscale`、`/api/image/matting`、`/api/video/frame|concat|segments`、
`/api/personas` 等**没有语义对等的既有能力**，**保持 501**（见下「未接入即缺项」）。

## 与上游行为的差异（全部在集成层，不改上游文件）

| # | 上游行为 | OpenArc 里的处理 | 为什么 |
| --- | --- | --- | --- |
| 1 | `DEFAULT_PAGE_ID='zimage'`(3901) 与预载 `frame-home`(3279) 不一致，首启停在"在线生图" | 中继在页面脚本之前把 `studio_active_page` 默认写成 `home`（**只在用户从未选过时**） | 首启必须是原版首页；用户选过就完全按上游记忆还原 |
| 2 | 首页点"最近项目"= 只切到画布管理器（`open-canvas` 消息只服务"待导入图片"） | 中继记下 `navigate` 里的 canvasId，直接驱动 `frame-canvas` 打开**那一本**编辑器 | 产品流程要求"返回首页 → 再打开项目"真的回到那本书 |
| 3 | 依赖 pywebview 桌面壳（11 个宿主方法） | 明确不可用：`window.pywebview` 读取即记录 + 明确提示，页面自动走网页版分支 | 不提供退出 OpenArc / 任意文件路径 / 任意宿主方法转发 |
| 4 | `localStorage`/`BroadcastChannel` 按同源共享 | 按 **OpenArc 账号 + 本次挂载** 的钥匙分桶（真实存储加 `oa:<key>:` 前缀，换挂载整片清掉） | "同一个 bundle origin"不等于不同账号已隔离 |
| 5 | `/ws/stats` 实时推送、桌面更新器（GitHub/Gitee/ModelScope 直连） | `/ws/stats` 明确失败（状态栏改用宿主队列计数）；更新/下载一律 501 并在界面标注"已禁用" | 不出网、不下载、不安装上游程序 |
| 6 | 首页「开始创作 / 新建画布」只弹"选画布"picker，「继续上次」空列表也落到 picker | 三处都改成 `createCanvasFromPicker('classic')`：建完立刻跳 `canvas.html` | 产品要求点入口**直接进真实编辑器**，不要额外欢迎页/选画布遮挡层 |
| 7 | picker 的「智能画布」走 `smart-canvas.html`（没有 OpenArc 适配层，不在安全不变式内） | 列表仍按画布 `kind === 'smart'` 路由/打开它（`canvas-list.html:1260/1361/1379`、`canvas.js:2147`），所以它**可达**且属于无限画布：本轮裁剪**保留**该页及其依赖；不为它补适配层，也不隐藏任何入口 | 它不在 OpenArc 适配层/守卫的安全不变式内，只能如实记录，不能拿遮挡层糊过去 |
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

> 上表 1、2 两条只作用于 `openarc-shell.js`，而它原先只注入 bundle 根 `index.html`。产品入口早就是
> `static/canvas-list.html`，该外壳页随零引用一起删除；`openarc-shell.js` 随之全仓零加载，本轮裁决**删除文件**
> ⇒ 这两条**当前不生效**（vendor 第 5 步不再生成/保留，`prune-public.mjs` 把它列为「必须不存在」）。

| 18 | `.trash-fab` 是**无显隐逻辑的静态元素**（上游只有角标按删除数显隐），回收站为空时右下角照样挂着一个回收站按钮 | 同一个真源（`updateTrashBadge()` 里的 `v4DeletedCanvases.length`）同时决定角标与 FAB：`hidden` 属性 + `.trash-fab[hidden] { display: none; }`；页面还没有回收站数据时按"空"呈现，`loadTrash()` 的响应决定是否显示 | 用户裁定"回收站为空时隐藏右下角按钮，有已删除画布时显示"；显隐必须是真实语义（DOM 属性 + 真实不渲染），不许用 CSS 遮挡冒充 |

## 未接入即缺项（独立页面已裁掉；端点仍明确报错）

裁成"只有无限画布"后，素材库 / 提示词库 / ComfyUI 与工作流设置 / 第三方供应商设置等**独立页面已不在 bundle 里**
（逐项依据见 `PRUNE.md`）；智能画布保留（`kind === 'smart'` 路由可达，见上表第 7 条）。
画布内**仍存在**的入口（编辑器自带的素材库弹层等）和这些能力相关的端点，在桥里照旧**明确返回
501 `OPENARC_UNSUPPORTED`**，并作为一次性提示写进宿主状态（宿主已无窗口条/状态行/提示横幅；
见 `src/canvas/CanvasHost.tsx` 的 `data-canvas-asset-notice-text` 只读证据通道）。
`/output`、`/assets` 历史文件浏览 / `/api/download-output`、`/api/view`、`/api/media-preview`
等未接入端点维持 501，不受本次裁剪影响。

**智能画布（`kind === 'smart'`）本轮只接通「流式 LLM」这一条**（`POST /api/canvas-llm/stream`）；
同一批升级新增、OpenArc 没有语义对等能力的端点一律**保持 501**（结构化 `OPENARC_UNSUPPORTED`，
桥按既有"未接通"模式给一次性界面提示，不静默、不假成功）：

| 端点族 | 处理 | 理由 |
| --- | --- | --- |
| `/api/agent/` 下的全部子路径（plan、apply、preview、rollback、sessions、run、undo、review、memory、thread、apply-prompt） | **保持 501** | 页面自带的"画布 Agent"（规划/执行/记忆/线程）；OpenArc 的画布 AI 走受控 `canvas/*` 命令与命令账本，没有页面对等的 agent 出口可承接（旧版 smart-canvas 已有 plan、apply、preview、rollback、sessions，升级前就 501，本次不是回退） |
| `/api/image/upscale`、`/api/image/upscale/runtime*`、`/api/image/matting*`、`/api/image/select-region`、`/api/matting/model/*` | **保持 501** | 新功能（放大/抠图/选区的本地模型运行时），OpenArc 没有对应传输 |
| `/api/video/`（frame、concat、blur-faces、segments）、`/api/angle/generate`、`/api/jimeng/query-media`、`/api/ms/generate`、`/api/runninghub/*` | **保持 501** | 视频/第三方站点能力；OpenArc 未接通视频传输（守卫与宿主投影都如实标不可用） |
| `/api/personas`、`/api/smart-canvas/prompt-templates`、`/api/prompt-libraries*` | **保持 501** | 提示词库/人设数据面，OpenArc 资源库暂未投影到这些形状（旧版同样为 501） |
| `/api/canvas-llm/stream` | **已登记** → `model.chatStream` | 升级引入的流式 LLM 回归；见上「OpenArc 自加脚本的同步改动」 |
| `/api/ai/size-policy` | **已登记** → `model.sizePolicy` | 上游 `shared/size-policy.js` 启动时 `GET /api/ai/size-policy` 拉尺寸策略；不登记会 501，`NovaSizePolicy` 恒为默认 free 模式（gpt-image-2 的显式 size 不被吸附）。宿主的值只来自 `electron/image-params.cjs` 的 `GPT_IMAGE_2_SIZE_POLICY` 唯一真源 |

## 上游升级记录（2026-10-16 · `6ce1a64680` → `1e20abe514`）

上游 `main` 从上一 pin 前进 18 个 commit：`git diff --shortstat 6ce1a64..1e20abe -- static` = **83 files changed**
（`static/js/canvas.js` 是被 OpenArc 注入的唯一核心文件）。上游新增的 `web/`（新前端产物）与 `static/v2/`
不在 `static/` 白名单闭包内，自然不保留。

### 复现（唯一入口，可重复执行）

```
git clone https://github.com/invaders-2/NOVAI-Infinite-Canvas.git /tmp/novai-canvas-src
git -C /tmp/novai-canvas-src checkout 1e20abe5145470b32f58206f692292703540107a
git -C /tmp/novai-canvas-src rev-parse HEAD   # 必须等于 vendor 脚本里的 SOURCE_COMMIT
OA_NOVAI_SRC=/tmp/novai-canvas-src node experiments/d5-02/vendor-novai-app.mjs
```

vendor 脚本启动时核对 `git rev-parse HEAD`，不符即退出；任何补丁锚点找不到目标即**报错退出**（不静默跳过）。

### 结果

- 裁剪：上游 `static/` **139 文件 → 保留 63 文件 / 12,484,000 B**；bundle **69 文件 / 12,613,133 B**。
  对比上一 pin（54 文件 / 10,559,150 B）：新增 10、删除 1、重写 22、+1,924,850 B。
- 新增 10 个：`css/nv2-skin.css`、`css/glide.css`、`css/image-adjust.css`、`js/shared/glide.js`、
  `js/shared/morph-button.js`、`js/shared/psd-writer.js`、`js/shared/size-policy.js`、
  `js/image-adjust-engine.js`、`tools/lossless-edit/index.html`、`tools/lossless-edit/vendor/ag-psd.js`。
- 删除 1 个：`static/vendor/js/glfx.js`（上游已不再引用任何保留页）。

### 适配点变动清单（8 处脚本改动 + 4 个适配脚本）

| # | 适配点 | 1e20abe51 上的状态 | 处理 |
| --- | --- | --- | --- |
| 1 | 每页 `<head>` 注入 CSP meta + `openarc-bridge.js` | `<head>` 结构未变 | 不变；现在逐页注入 4 个 HTML |
| 2 | `canvas.html` 在 `canvas.js` 之后注入 `openarc-adapter.js` / `openarc-canvas-guard.js` | 脚本标签仍在 | 不变（正则命中） |
| 3 | `canvas.js` IIFE 末尾内联 merge / ai-marks / internals | 收尾仍是外层 `})();` | **注入点不变**；适配层引用的 **39 个闭包符号全部仍在外层作用域声明**（逐个核对，无重命名） |
| 4 | `canvas-list.html` 三个"新建"入口 + 回收站 FAB 显隐 | 7 个补丁锚点全部命中 | 不变 |
| 5 | `saveCanvas()` 清 `saveTimer`（D1） | 锚点命中 | 不变 |
| 6 | 两个纯数据模块内联（merge / ai-marks） | 同上 | 不变 |
| 7 | `saveCanvas()` 三处补丁（记录发出文档 / 保存成功交 base / 409 三方合并） | 锚点命中 | 不变 |
| 8 | AI 来源标记 + 160ms 淡入 | 同上 | 不变 |
| — | `openarc-canvas-guard.js` 的 DOM/读取点：`.canvas-nav-meta`、`.llm-provider-select`、`.video-provider`、`.video-model`、`.generator-body .provider-select`、`.comfy-body`、`.llm-body`、`#assetManagerModal`、三把 localStorage 模型来源键、`/api/config` 的 `api_providers`/`*_models`/`capabilities` | **全部仍在** | **零改动**（三条语义经真机回归全部通过） |
| — | `openarc-adapter.js` 依赖的上游全局：`window.createImageCardFromUrl`、`__openarcCanvasInternals` | **仍在** | 零改动 |
| — | `openarc-bridge.js` 端点白名单 | 核心编辑器只新增 `/api/video/segments`（视频，本就未接通）；**智能画布**新增 `POST /api/canvas-llm/stream`（流式 LLM，2026-10 补登记） | 白名单**未放宽**（只加登记项）；未登记端点仍 501、出网仍拒绝 |

**结论：本次升级没有一处必须放宽白名单 / 只读闸 / 出网拒绝，也没有一处注入点需要重新定位。**
唯一显式补的是一条**提取器盲区**依赖 `tools/lossless-edit/vendor/ag-psd.js`（无损改图页以
`loadScript('vendor/ag-psd.js')` 运行时相对加载，页面标签 / CSS `url()` / `/static/` 字面量都看不见），
已进 `EXTRA_KEEP`，否则会"点导出 PSD 才 404"。

### 真机验收（`experiments/dxos-canvas-revendor/real-device-canvas.mjs`）

真实 Electron `electron .`（隔离 userData + 唯一 CDP 端口）+ 确定性本地 provider（只替代最后一跳网络）：

```
PASS 14 / FAIL 0        （明细见 artifacts/dxos-canvas-revendor/RESULT.json）
404 = 0；console error = 0；pageerror = 0；5xx = 0；loadingFailed = 0
provider: chats = 1, authSeen = 1（OpenArc 凭据只在服务侧）
S1 供应商/模型单一真源：三把键被锁死、0 个清单外选项、视频真实 disable、生图"未配置"disable
S2 只读闸：node.add → READ_ONLY，节点数 4→4，恢复后 canEdit
S3 撤销/重做：add +1 → undo 还原 → redo +1（redo 随即清空）
S4 白名单/出网：出网 501 OPENARC_EGRESS_BLOCKED、未登记端点 501 OPENARC_UNSUPPORTED、
   更新 501 OPENARC_UPDATE_DISABLED、/api/config 200
截图：shots/{list,editor}-{light,dark}.png（2880×1800 @2x）；真实 profile 收工前后 sha256 完全一致
```

自动化门禁：`npm run build` exit 0、`npx tsc --noEmit` 0、
`node --test tests/d5-02-canvas-*.test.mjs tests/dxos-canvas-*.test.mjs tests/canvas-library-list.test.mjs`
= **145 pass / 0 fail**。

### 安全回退

升级只改了 bundle 里的 `static/`（4 个 `openarc-*.js` 与文档均未改）。升级前整包备份在
`artifacts/dxos-canvas-revendor/backup/novai-canvas/`（60 文件 / 10,688,283 B，逐文件 sha256 见
`backup-profile.json`）。一键回到升级前：

```
rm -rf public/novai-canvas/static
cp -R artifacts/dxos-canvas-revendor/backup/novai-canvas/static public/novai-canvas/static
# 并把 experiments/d5-02/vendor-novai-app.mjs 的 SOURCE_COMMIT 改回 6ce1a64680b669b31c2ac3b32418b54decd404f2
```

