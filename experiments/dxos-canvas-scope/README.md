# DXOS-CANVAS-SCOPE · 只保留「列表页 + 智能画布」的范围裁决与阻塞报告

日期：2026-10-17
范围：`public/novai-canvas/**`、`experiments/d5-02/vendor-novai-app.mjs`、`experiments/dxos-canvas-prune/**`、`experiments/dxos-canvas-scope/**`、`artifacts/dxos-canvas-scope/**`

## 1. 用户裁定与本包实际交付

用户裁定：无限画布只保留「列表页 `static/canvas-list.html`」与「智能画布 `static/smart-canvas.html`」两个页面，传统画布编辑器 `static/canvas.html` 不再提取；并把上游 `prompt()` 的重命名换成应用内模态。

| 任务 | 状态 | 说明 |
| --- | --- | --- |
| 4. `prompt()` → 应用内模态 | 第一包已交付并真机验证 | `openarc-rename-modal.js`，vendor 第 10 处改动 |
| 1. 收窄提取范围 / 删 `canvas.html`+`canvas.js`+`css` | **本轮不执行**（Lead 裁决） | 留到用户改完上游、重新 vendor 时一起做；`canvas.html` 暂时保留在包里、入口已不可达；见第 7 节 |
| 2. 入口改向列表 → 智能画布 | **已交付**（vendor 第 11 处改动） | 6 类入口全部改向 `smart-canvas.html`（同一 `id`/`project`）；逐处对照见第 7 节 |
| 3. 适配脚本迁移（三条语义不许削弱） | **最小封堵已交付**（第 12 处改动）；整体移植待重新 vendor | 只封"单一真源 / 未接通如实禁用 / 只读闸"三件事；覆盖 / 未覆盖见第 3、4 节 |
| 5. 无死引用（grep + 真机 404=0） | 成立 | 入口改向 + 最小封堵后，真机 0 console error / 0 pageerror / 0 条 404 / 0 条 5xx（第 7 节） |

一句话：本包没有删除任何文件、没有改白名单、没有改入口。原因不是没时间，是用户自己给的停手条件（无法在不削弱语义的前提下适配就先停下报告）加上一个决定性的测试冲突（第 2 节阻塞一）。

## 2. 两个硬阻塞（附证据）

### 阻塞一（决定性）：删除 `canvas.html` 必然弄红一个既有测试，而该测试在禁改清单里

`tests/dxos-canvas-asset-refs.test.mjs` 第 ⑦ 个用例（安全边界未被放宽）直接读磁盘文件：

```js
// tests/dxos-canvas-asset-refs.test.mjs:162-167
for (const page of ["canvas.html", "canvas-list.html"]) {
  const html = fs.readFileSync(path.join(ROOT, "public", "novai-canvas", "static", page), "utf8");
  const meta = /Content-Security-Policy" content="([^"]+)"/i.exec(html);
  assert.ok(meta, page + " 有 CSP");
  ...
}
```

冲突三方：1）任务要求移除 `canvas.html` 及其独占资源；2）任务要求 `node --test tests/dxos-canvas-*.test.mjs ...` 全绿；3）任务写明不要动 `tests/**` 既有文件。
三者不能同时成立：文件一删，第 ⑦ 用例的 `readFileSync` 直接抛 ENOENT。基线（未改动时）该文件 7/7 通过（见第 5 节）。
必须先由下一包把 ⑦ 的页面列表改成保留页（`smart-canvas.html`），否则无论适配脚本做得多好，验收 3 都过不去。

### 阻塞二：适配脚本迁移是重写，不是最小适配；守卫的三条语义在智能画布上没有对应注入点

经典编辑器与智能画布是两套数据模型 + 两套 DOM，逐条核对如下：

| 维度 | 经典 `canvas.js`（现适配层挂在这里） | 智能 `smart-canvas.js`（33,511 行） | 结论 |
| --- | --- | --- | --- |
| 连线存放 | 独立闭包变量 `connections` | `canvas.connections`（节点 `nodes` 仍是独立变量） | 适配层 `getState().connections` 要改成 `canvas.connections` 的活引用 |
| 撤销/重做 | 上游只有 `undoStack`，注入层补 `redoStack` | 原生已有 `undoStack` / `redoStack` / `performUndo()` / `performRedo()`，且 `pushUndo()` 会清空 `redoStack` | 语义可保留，但配对不再是注入层实现，而是改为验证页面原生栈 + 只读闸包住它 |
| 只读闸挂点 | 包装 `pushUndo` / `addNode` / `deleteSelectedNodes` | 有 `pushUndo`、`addNodeToSmartGroup`、`deleteNode`；但还有拖动、框选、`applyAgentCanvasOps` 等多条编辑路径 | 需要逐条确认每条编辑路径都经过 pushUndo 才能保证不削弱；未真机证明前不能声称等价 |
| 供应商/模型 UI | `<select class="provider-select/model-select/llm-provider-select/video-provider/video-model">` | pill + popover：`#unifiedPlatformControl [data-unified-engine]`、`.direct-option[data-smart-param="model"/"videoModel"/"provider_id"/"videoProvider"]`、`#engineSelect`（真实 select，被合并隐藏）、`#apiKindToggle`、`#chatModelSelect`、`#agentImageProviderSelect` | 守卫的 `selectRole()/applySelect()/pruneOptions()/markUnavailable()` 全部不能复用，要按新控件重写 |
| 页面侧自己造事实的兜底 | `api_providers` 为空造 comfly、`video_models` 为空填 25 个 | `volcengineProvider()` 造 provider、`DEFAULT_VIDEO_MODELS`（11 个）、`modelscopeImageModels()` 默认 Tongyi-MAI/Z-Image-Turbo、`resolveChatModel()` 默认 gpt-4o-mini、`comfyInstanceCount = Math.max(1, …)` | 这些都在 IIFE 内，外部脚本够不到；要封掉必须像 `canvas-internals.js` 那样注入进 `smart-canvas.js` 尾部 |
| 冲突三方合并 / AI 来源标记 | 注入层实现（`canvas-merge.js` + `canvas-ai-marks.js`） | 智能画布本来就有自己的 409 合并（`applyMergedServerCanvas` / `setSmartServerBase`）和渲染路径 | 不能整块搬运；需要逐条裁决哪些由页面原生承担、哪些不搬 |
| Toolbar/状态位 DOM | `.canvas-nav-meta`（守卫插状态位的地方） | 不存在；有 `.smart-title` / `#smartSaveState` | 状态位要换锚点，或放弃该可视化 |

结论：任务 3 要求的最小化适配在这里不成立 —— 守卫是按新 DOM 重写，internals 是按新数据模型重写，且必须给 `smart-canvas.js` 注入代码才能封掉页面侧兜底。按用户指令，先停下报告，不拿「应该差不多」糊过去。

补充：宿主侧 `/api/config` 的投影（`src/canvas/CanvasHost.tsx:179-227`）已经是完整真源 —— `api_providers` 只含可用模型的 provider、`video_models: []`、`comfy_instances: []`、`capabilities` 带 `available/transport/configured/reason/defaultUsable`。数据面本来就没问题；缺的是页面侧展示与兜底的封堵，这正是守卫要重写的那部分。

## 3. 下一包的可执行方案（锚点已核对）

### 3.1 收窄白名单并真正去掉 `canvas.html` / `canvas.js` / `canvas.css`

`extractStaticRefs` 会把 `canvas-list.html:1320-1321` 那个三元里的 `/static/canvas.html` 当成真实引用，所以只改白名单不够：必须再加一个排除页集合，在闭包遍历里跳过它。

```js
// experiments/d5-02/vendor-novai-app.mjs
export const PAGE_WHITELIST = ["canvas-list.html", "smart-canvas.html"];
export const PAGE_EXCLUDE = ["canvas.html"];          // 新：显式不再提取的页面
// computeKeepSet() 的闭包遍历里：
if (!allSet.has(ref) || keep.has(ref) || PAGE_EXCLUDE.includes(ref)) continue;
```

已用同一套闭包逻辑实测（`artifacts/dxos-canvas-scope/closure-probe.json`）：当前保留 58/63；收窄后保留 60/63（含 `EXTRA_KEEP` 策略保留），**真正的删除只有 3 个**：

| 被删 | 字节 | 依据（edges） |
| --- | --- | --- |
| `canvas.html` | 45,629 | 页面白名单外 + `PAGE_EXCLUDE`（当前只被 canvas-list.html 的 kind 三元引用） |
| `css/canvas.css` | 168,364 | 只被 `canvas.html:12` 引用 |
| `js/canvas.js` | 824,303 | 只被 `canvas.html:535` 引用（智能画布用 `smart-canvas.js`） |

其余 5 个（`system-prompts/infinite-canvas-prompt-templates.md`、`images/RunningHub-B/W.png`、`tools/lossless-edit/vendor/ag-psd.js`、`vendor/MANIFEST.md`）由 `EXTRA_KEEP` 策略保留，**不随经典编辑器消失而删除**：`tools/lossless-edit/index.html` 是 `smart-canvas.js` 的 iframe 真实依赖，闭包会保留它，它的 PSD 导出依赖 `ag-psd.js` 仍必须显式保留。

前置：先按阻塞一改 `tests/dxos-canvas-asset-refs.test.mjs:162` 的页面列表。

### 3.2 入口改向（脚本化 vendor 第 11 处）

`canvas-list.html` 的 6 处 `/static/canvas.html` 全部改向 `smart-canvas.html`（同一个 `id` / `project` 参数；智能画布 `smart-canvas.js:11-13` 读的就是 `params.get("id")` / `params.get("project")`，**参数名无需改**）：

| 入口 | 行 | 现状 | 改法 |
| --- | --- | --- | --- |
| 卡片点击 `openCanvas(c)` | 1320-1322 | `c.kind === "smart" ? smart : canvas` | 恒 `smart-canvas.html?id=…&project=…&t=…` |
| 新建 `createCanvasFromPicker(kind)` | 1420-1422 | 同上 | 恒 smart；并把 `isSmart` 恒 true（新画布 `kind: "smart"`、`icon: "sparkles"`） |
| 「继续上次」`btnContinueLast` | 1438-1440 | 同上 | 恒 smart |
| `pickerNormal` 按钮 | 1427 | `createCanvasFromPicker("classic")` | 删掉，或也建 smart |
| `btnStartCreate` / `btnNewProject` | LIST_PATCHES | `createCanvasFromPicker("classic")` | 改 `"smart"` |
| 「继续上次」空列表兜底 | LIST_PATCHES | `createCanvasFromPicker("classic")` | 改 `"smart"` |

回收站恢复后进入：`canvas-list.html` 的 restore 目前只调 API + 重渲染，不导航；恢复后仍是卡片点击路径，所以 3.2 改完就自然覆盖。

### 3.3 适配脚本迁移（脚本化 vendor 第 12 处起）

1. 新增 `experiments/d5-02/vendor/canvas-smart-internals.js`，vendor 脚本按 `canvas.js` 同样的手法内联进 `static/js/smart-canvas.js` 的收尾 `})();` 之前，暴露 `window.__openarcCanvasInternals`：
   - `getState()` → `{ canvas: {...前略, revision: canvas.updated_at}, nodes, connections: canvas.connections, viewport, settings }`；
   - 只读闸：沿用 `window.__openarcCanvasReadOnly`，包装 `pushUndo()`（智能画布所有编辑入口都会 pushUndo，**但要逐条验证**）、`addNodeToSmartGroup()`、`deleteNode()`；`openarc-canvas-context` 事件驱动；
   - 撤销/重做：直接用页面原生 `performUndo()` / `performRedo()`，只做只读拒绝；配对正确性由页面 `pushUndo` 清空 `redoStack` 保证；
   - `runNode(id)`：选中该节点并调用它自己的运行入口（`.prompt-node-run` / `runGeneration`），不另造运行路径。
2. `openarc-adapter.js` 的命令映射按智能画布节点模型改写（`node.add` 直接透传 smart 类型；`node.group` 建 `smart-group` + `items`；`edge.connect` 用 `addConnection(from,to,kind)`），并把注入点从 `canvas.html` 挪到 `smart-canvas.html`。
3. `openarc-canvas-guard.js` 按智能画布真实 DOM 重写命中面：
   - 未接通能力 → disable `#unifiedPlatformControl [data-unified-engine="comfy"]` 与 `#apiKindToggle [data-kind="video"]`，并打 `data-openarc-unavailable` 等价标记；
   - 未配置 → disable `#chatModelSelect` / `#agentImageProviderSelect` 与平台入口，给「打开 OpenArc 总 API 设置」；
   - 清单外旧值 → 通过注入层拿 `settings` + 节点 `runSettings`，清掉不在 `api_providers`/模型清单里的值；
   - 页面侧兜底（`DEFAULT_VIDEO_MODELS` 等）→ 在注入层里按 `capabilities` 清空 / fail-closed；
   - 三把 `localStorage` 模型来源键的锁定逻辑原样保留（智能画布当前不读，但锁死仍是单一真源的一部分）。
4. 文档同步：`SOURCE.md` 差异表第 7 / 10 条要改写（智能画布不在安全不变式内不再成立）。

### 3.4 门禁重定向（下一包）

`experiments/d5-02/canvas-e2e.mjs`（1714 行）是按经典编辑器写的，本包未改。删除 `canvas.html` 后需要重定向：

| 用例族 | 现状（按经典编辑器写） | 删除后 |
| --- | --- | --- |
| E1 / E2 编辑器加载、节点命令（`node.add` / `edge.connect` / `runNode`） | 打到 `canvas.html` + `window.__openarcCanvas` | 改打 `smart-canvas.html`，命令面按 3.3 的映射 |
| E3 只读闸 / 撤销重做 | 经典注入层 | 智能内建栈 + 注入层只读闸 |
| E4 边界（伪造帧、白名单、出网 501） | 已改到 `canvas-list.html` | 不变 |
| 供应商/模型真源断言 | 经典 DOM 的 `data-openarc-*` 标记 | 智能画布新标记（3.3-3） |
| 冲突三方合并 / AI marks | 经典注入层 | 智能原生 409 合并；AI marks 需单独裁决是否搬 |

另外真机探针 `experiments/dxos-canvas-llm-stream/real-device-smart-canvas-stream.mjs` 的 C7（经典画布回归）要一并重定向/删除；`tests/dxos-canvas-asset-refs.test.mjs:162` 的页面列表同理。

## 4. 本包已交付内容（任务 4：`prompt()` → 应用内模态）

### 4.1 改动清单

| 文件 | 改动 |
| --- | --- |
| `public/novai-canvas/openarc-rename-modal.js` | 新增（bundle 根）：`window.__openarcPrompt(opts) -> Promise<string|null>`；Esc / 遮罩 / 取消关闭；空值不提交；`onSubmit` 拒绝时结构化错误留在模态内；焦点管理 / `role=dialog` / `aria-modal` / Tab 困窗 / 减少动态效果 |
| `experiments/d5-02/vendor-novai-app.mjs` | 新增 `MODAL` 常量 + 存在性检查 + `modalHash`；`SMART_CANVAS_JS_PATCHES`（2 条）；`LIST_PATCHES` 新增 2 条（重命名调用 + `renameCanvasAPI` 抛错）；第 4 步把模态脚本插到 `openarc-bridge.js` 之后（只 `canvas-list.html` / `smart-canvas.html`） |
| `public/novai-canvas/static/canvas-list.html` | 由 vendor 重生成：`handleCardAction` 的 `prompt(...)` → `window.__openarcPrompt(...)`；`renameCanvasAPI` 抛结构化错误；`<head>` 注入模态脚本 |
| `public/novai-canvas/static/js/smart-canvas.js` | 由 vendor 重生成：`createPromptTemplateGroup()` / `renamePromptTemplateGroup()` 的 `window.prompt` → `await window.__openarcPrompt(...)` |
| `public/novai-canvas/static/smart-canvas.html` | 由 vendor 重生成：`<head>` 注入模态脚本 |
| `experiments/dxos-canvas-prune/prune-public.mjs` | `REQUIRED_ROOT` 增加 `openarc-rename-modal.js` |
| `public/novai-canvas/SOURCE.md` / `PRUNE.md` | 登记第 10 处改动、新脚本、本轮范围裁决 |
| `experiments/dxos-canvas-scope/**` + `artifacts/dxos-canvas-scope/**` | 真机探针、闭包实测、证据 |

### 4.2 vendor 第 10 处改动（内容与理由）

上游在三个入口用 `prompt()` 取名，Electron 的 Chromium 直接不支持（调用即 `prompt() is not supported`），所以这三个入口在真机上都是死路（不是体验差，是点了没反应/抛错）。改成页面内模态是功能修复，不是外观优化。上游代码原样保留 `tr()` 文案键与 24 字上限，只换取值方式。

## 5. 验证证据

- 真机模态探针：`experiments/dxos-canvas-scope/rename-modal-probe.mjs` → `artifacts/dxos-canvas-scope/RESULT.json` + `RESULT.md` + `shots/*.png`。
- 闭包/裁剪口径实测：`artifacts/dxos-canvas-scope/closure-probe.json`（用 vendor 脚本导出的 `extractStaticRefs` 跑同一套闭包 + 同口径 `EXTRA_KEEP`）。
- 基线单测（改动前）：`node --test tests/d5-02-canvas-*.test.mjs tests/dxos-canvas-*.test.mjs tests/canvas-library-list.test.mjs` = 217 pass / 0 fail。
- `npm run build` exit 0（含 `tsc --noEmit`）。
- `node experiments/dxos-canvas-prune/prune-public.mjs --check` ⇒ 源 63 / 保留 63 / 删除 0（本轮没删东西）。

## 6. 遗留（第一包结束时；1 已解决、2 部分解决，现状见第 7–10 节）

1. 阻塞一需要用户/下一包授权改 `tests/dxos-canvas-asset-refs.test.mjs:162`。
2. 阻塞二需要按 3.3 重写守卫与 internals；在真机证明只读闸覆盖所有编辑路径之前，不得声称三条语义未削弱。
3. `canvas.js` 里的 18 处 `prompt()` 本包未动（用户要求只改智能画布/列表）；若最终删除 `canvas.js`，它们自然消失。
4. `openarc-adapter.js` / `openarc-canvas-guard.js` / `canvas-internals.js` 本包未动，仍只注入 `canvas.html`。

---

## 7. 第二包交付（2026-10-17）· 入口改向 + 智能画布最小封堵

Lead 裁决：① 授权把 `tests/dxos-canvas-asset-refs.test.mjs` 的页面列表改成"对我们实际发布的每个页面都断言 CSP"；
② 经典页删除与守卫/适配器整体重写**留到用户改完上游、重新 vendor 的那一次**（避免基于旧源码写一遍、拉新源码再写一遍）。

### 7.1 入口改向（vendor 第 11 处改动，`LIST_PATCHES`）

| 入口 | 改前 | 改后 |
| --- | --- | --- |
| `btnStartCreate` | `createCanvasFromPicker(classic)` | `createCanvasFromPicker(smart)`（函数内也恒 `isSmart=true`） |
| `btnNewProject` | 同上 | 同上 |
| 继续上次空列表兜底 | `openCanvasPicker()` → 第 10 处已改 `classic` | `createCanvasFromPicker(smart)` |
| 卡片点击 `openCanvas(c)` | `c.kind==="smart" ? smart : canvas` | 恒 `smart-canvas.html?id&project&t` |
| `createCanvasFromPicker` 内部导航 | `nc.kind==="smart" ? smart : canvas` | 恒 smart（并强制建 smart 画布） |
| `btnContinueLast` 导航 | `latest.kind==="smart" ? smart : canvas` | 恒 smart |
| `pickerNormal` | `classic` | `smart` |
| `pickerSmart` | `smart` | 不变 |

回收站"恢复后进入"只调 API + 重渲染、不导航，恢复后仍走卡片点击路径 ⇒ 被同一条改向覆盖。
「返回列表」（`smart-canvas.html` 的 `.smart-back` / `backToCanvasList()`）不受影响。
智能画布读取的就是 `params.get("id")` / `params.get("project")`，参数名无需改。
改后 `canvas-list.html` 里 `/static/canvas.html` 与 `createCanvasFromPicker(classic)` 均为 0 处。

### 7.2 智能画布最小封堵（vendor 第 12 处改动）

模板：`experiments/d5-02/vendor/smart-canvas-guard.js`；vendor 脚本把它内联进 `static/js/smart-canvas.js`
的 IIFE 收尾 `})();` 之前（必须同域 —— 页面侧兜底都在闭包里，外部脚本够不到）。

| 覆盖项 | 做法 | 证据面 |
| --- | --- | --- |
| C1 服务商/模型清单只来自宿主 | `volcengineProvider` 无真实投影时返回空模型 stub（不再带 `DEFAULT_VIDEO_MODELS`）；`volcengineVideoModels`/`modelscopeImageModels` 无投影时返回 `[]`；`resolveChatModel` 不再回落 `gpt-4o-mini`；`initChatModel` 在宿主无对话模型时清掉 `gpt-4o-mini` 并置"未配置"；`unifiedPlatformEntries` 的"其它引擎"只列 `api_providers` 里真实存在的 | `window.__openarcSmartGuard.providers()` |
| C2 未接通能力如实禁用/标注 | 视频 kind 按钮 `disabled` + `aria-disabled` + `data-openarc-unavailable="video-generation"` + 复用经典守卫的 `.openarc-guard-note` 文案；`#engineSelect` 未接通引擎 option `disabled`；`#chatModelSelect` 未配置时 `disabled`；运行入口按能力事实在页面侧拒绝；`/api/canvas-video` 与 `/api/canvas-comfy-tasks` 返回明确 501 | `window.__openarcSmartGuard.facts()` / `blocked()` |
| C3 只读画布不可编辑 | 桥的 `openarc-canvas-context` → `window.__openarcCanvasReadOnly`；`html[data-openarc-readonly=1]` 下 `#composer`/`#createMenu`/`.node`/`.smart-node-toolbar`/`.canvas-zoombar` `pointer-events:none`；`pushUndo` 拒绝并记 blocked；运行按钮恒 disable；Cmd/Ctrl 与 Delete/Backspace 捕获阶段拦截 | `data-openarc-readonly` 属性 / `blocked()` |

### 7.3 `canvas.html` 暂留与重新 vendor 待办

`static/canvas.html` / `js/canvas.js` / `css/canvas.css` 仍在 bundle 中（用户已从入口到不了），**待重新 vendor 时删除**，
并把 `openarc-canvas-guard.js` / `openarc-adapter.js` / `canvas-internals.js` 按最终源码移植到智能画布。删除后 `static/`
从 3 个页面减到 2 个；体积对比不能按删除后读。`SOURCE.md` / `PRUNE.md` 已同步标注。

## 8. 待重新 vendor 时的移植清单（守卫 / 适配器 / internals 逐条）

本包最小封堵**只做了** C1/C2/C3；下面每一条都要在最终源码上核一遍（能由页面原生承担的就不搬，能证伪的就删掉）：

1. 新增 `experiments/d5-02/vendor/smart-canvas-internals.js`，内联进 `smart-canvas.js` 收尾，暴露 `window.__openarcCanvasInternals`：
   `getState()` 返回 `{ canvas{id,title,revision}, nodes, connections: canvas.connections, viewport, settings }`；
   primitives 至少含 `addNode` / `deleteNode` / `pushUndo` / `performUndo` / `performRedo` / `render` / `scheduleSave` / `saveNow` / `markSynced`。
2. **只读闸覆盖全部编辑路径**（本包只覆盖 pointer-events + `pushUndo` + 快捷键）：逐条核 `pushUndo`、`addNodeToSmartGroup`、
   `deleteNode`、节点拖动 / 框选 / 多选、`applyAgentCanvasOps`、表格内联编辑、图片编辑弹窗；未实测证明前不得声称等价。
3. 撤销/重做：直接用页面原生 `performUndo()` / `performRedo()`，注入层只做只读拒绝；配对正确性由页面 `pushUndo()` 清 `redoStack` 保证，需真机验证。
4. `runNode(id)`：选中节点并调用它自己的运行入口（`.prompt-node-run` / `runGeneration`），不另造运行路径。
5. `openarc-adapter.js` 命令映射按智能节点模型改写：`node.add` 透传 smart 类型、`node.group` 建 `smart-group`+`items`、
   `edge.connect` 用 `addConnection(from,to,kind)`；注入点从 `canvas.html` 挪到 `smart-canvas.html`。
6. 供应商/模型 DOM 重写（经典守卫的 `selectRole/applySelect/pruneOptions/markUnavailable` 全部不能复用）：
   `#unifiedPlatformControl [data-unified-engine]`、`.direct-option[data-smart-param=model|videoModel|provider_id|videoProvider]`、
   `#engineSelect`、`#apiKindToggle`、`#chatModelSelect`、`#agentImageProviderSelect` 逐条 disable / mark / 清值。
7. 页面侧兜底清理（本包只做"默认值不回落"）：`sanitizeSmartApiSelection` 之后，清掉不在 `api_providers` / 模型清单里的
   历史 `settings`、节点 `runSettings`、`llmModel` / `videoModel` 值（经典守卫的清清单外旧值语义）。
8. ComfyUI 的 fail-closed：`comfyInstanceCount = Math.max(1, …)` 与 `comfyWorkflows` / 工作流下拉要按 `capabilities.comfy` 明确禁用 + 标注（本包未做）。
9. 未配置（不是未接通）呈现：chat/image 未配置 / 显式默认不可用时的等价标记 + "打开 OpenArc 总 API 设置"引导按钮（`app.openModelSettings`）。
10. 节点级可用性徽标 + 运行按钮 `data-openarc-blocked="<cap>"`（本包只在 `runGeneration` 入口拒绝，未打节点级标记）。
11. 状态位：经典守卫的 `.canvas-nav-meta` 在智能画布不存在；状态 chip 要换到 `.smart-title` / `#smartSaveState` 锚点或放弃该可视化。
12. 冲突三方合并 / AI 来源标记：智能画布原生已有 409 合并（`applyMergedServerCanvas` / `setSmartServerBase`）与渲染路径；
    需逐条裁决哪些由页面原生承担、哪些从 `canvas-merge.js` / `canvas-ai-marks.js` 搬，不能整块搬运。
13. 三把 classic localStorage 模型来源键（`canvas_custom_image_models` / `canvas_image_models_ordered` / `canvas_chat_models_ordered`）：
    智能画布当前**不读**，本包未锁；重新 vendor 后若最终源码引入读取，再按单一真源锁掉。
14. 收窄提取：`PAGE_WHITELIST` 去掉 `canvas.html` + 新增排除页集合（`extractStaticRefs` 会把列表页 kind 三元里的
    `/static/canvas.html` 当真实引用）；删 `canvas.html` / `js/canvas.js` / `css/canvas.css`。
15. `tests/dxos-canvas-asset-refs.test.mjs` ⑦ 页面列表本包已改为动态（只对实际存在的发布页断言 CSP，且强制保留页存在）；
    删 `canvas.html` 后无需再改。

## 9. 门禁重定向清单（`experiments/d5-02/canvas-e2e.mjs`，本包**未改**该文件）

`canvasFrame()` 现在匹配的是 `openarc-canvas://bundle/static/canvas.html`；入口改向 + 经典页下线后应改匹配
`smart-canvas.html`。受影响用例（按 ID）：

| 用例族 | 现状（按经典编辑器写） | 重定向后 |
| --- | --- | --- |
| A3 / A4 / A5 / A6 | 断言进入 `canvas.html` + 适配器就绪；A4 用 `#backToManagerBtn` | 断言进入 `smart-canvas.html` + 智能 internals 就绪；A4 用 `.smart-back` / `backToCanvasList()` |
| A7 / A8 | `window.__openarcCanvas.applyCommand` / `undo` / `redo` | 智能节点模型 + 注入层的命令映射（移植清单 1/5），或改成驱动页面原生入口 |
| A9 / A10 | 列表 ↔ 编辑器往返，编辑器就绪判据是 canvas.html | 往返仍成立，编辑器 URL / 就绪判据改 smart-canvas |
| B1 / B5 / N1 / N2 / N3 / N5a / N5c / N5d / N6 | 经典守卫 DOM 契约 `data-openarc-*`、页头状态位、引导按钮 | 智能画布新标记（本包只落了 `data-openarc-unavailable`（视频 kind / engine option）与 `#chatModelSelect` disabled；其余待移植后补） |
| B2 / B3 / B4 / D1–D5 / F1 / F3a–F3c / F3f | 经典节点类型 / `__openarcCanvasInternals` primitives / `runNode` | 智能节点模型 + 移植后的 internals（清单 1/2/3/4/10） |
| F3d / F3e / F4 / F4b | 命令层 + 三方合并 + AI 标记（经典注入层） | 智能画布原生 409 合并 + 裁决后的 merge / ai-marks 取舍（清单 12） |
| E1–E8 | 锚在 `canvas-list.html`（伪造帧 / 出网 / 账号边界） | 不变；仅 E5 的"被拦后重新进入画布仍可用"一步改到 smart-canvas |
| F3g / F3h / Z1 | 列表页卡片 / 回收站 / 主进程错误 | 不变 |

另有 `experiments/dxos-canvas-llm-stream/real-device-smart-canvas-stream.mjs` 的 C7（经典画布回归）要一并重定向 / 删除。
本包的真机证据在 `artifacts/dxos-canvas-scope/entry-guard-probe.json` / `ENTRY-GUARD-RESULT.md` / `shots-entry/*.png`。

## 10. 遗留（第二包结束时）

1. `canvas.html` / `js/canvas.js` / `css/canvas.css` 未删；守卫 / 适配器 / internals 整体移植未做 —— 见第 8 节，重新 vendor 时一起做。
2. `canvas.js` 里的 18 处 `prompt()` 未动（该页已无入口可达；若最终删除 `canvas.js` 自然消失）。
3. `experiments/d5-02/canvas-e2e.mjs` 未改（本包写入范围外）；重定向清单见第 9 节。
4. 只读闸未覆盖"不经 pushUndo 的编辑路径"（拖动 / 框选 / 表格内联），已在第 8 节第 2 条列为必测项。
---

## 11. V0.01 授权补齐：智能画布只读闸逐条封堵（第三包）

日期：2026-10-17
范围：`experiments/d5-02/vendor/smart-canvas-guard.js`（模板）、`public/novai-canvas/static/js/smart-canvas.js`（vendor 重生成）、`experiments/d5-02/vendor-novai-app.mjs`（注释/编号同步）、`public/novai-canvas/SOURCE.md`、`experiments/dxos-canvas-scope/readonly-gate-probe.mjs`、`artifacts/dxos-canvas-scope/**`。

第二包的只读闸只包了经 `pushUndo()` 的路径（第 10 节遗留 4）。本包把它补到**每一条编辑路径都被拒**：
事件闸（窗口捕获）为主防线 + 173 个改文档闭包函数的函数闸 + fetch 写请求页面侧拒绝 + 与闸一致的 UI。
只读态不再有任何一条路径能改文档或发出后端写请求；可编辑态同一批操作全部照常。

### 11.1 三道页面侧闸 + UI

| 层 | 做法 | 位置 | 证据面 |
| --- | --- | --- | --- |
| 事件闸 | `window` 捕获阶段拦下编辑面（`#world` / `#composer` / `#createMenu` / `#imageEditModal` / `#smartTextModal` / `#smartLabelPanel` / `#promptTemplatePanel` / `#promptPresetPanel` / `#assetPanel` / `#smartWorkflowTransferModal` / `#smartTitle` / 端口·工具条·浮层…）上的 `mousedown/pointerdown/click/dblclick/contextmenu/dragstart/dragover/drop/paste/cut/beforeinput/input/change`；键盘编辑键（Delete/Backspace/方向键/Cmd+Z、Y、V、A、D、G、X）同样拦下 | `smart-canvas-guard.js` C3（内联进 `smart-canvas.js`） | `openarc-canvas-blocked` 事件 + `blocked()` 计数 |
| 函数闸 | 把 173 个会改文档的闭包函数逐个包成"只读即拒、返回调用方需要的'没发生'值"：拖动/缩放/框选/连线/增删/分组/表格/内联编辑/参数面板/右键菜单/撤销重做/模板库写/素材库写/Agent ops/生成落图/保存…；并把页面提前 `window.*` 导出的那批**重新指到包装实现**（HTML `onclick="applyImageEdit()"` 走 window，不重指会绕过闸） | 同文件 C3 `guardFn` + `WRAPPED` 重指 | `wrapped()` ⇒ `{count:173, missing:[]}` |
| fetch 写闸 | 只读时任何非 GET/HEAD/OPTIONS 的 `fetch` 都在页面侧返回 403 `READ_ONLY`，不落到宿主/网络；`CAPABILITY_UNAVAILABLE` 的老行为不变 | 同文件 C3 fetch 包装 | `writeBlocked()` 计数 + 直连 PUT 的 403 状态 |
| UI 一致 | `html[data-openarc-readonly="1"]` 下编辑面 `pointer-events:none`、`#world`/节点 `cursor:not-allowed`；运行/整理/挑图/拼接/撤销重做/创建菜单等入口 `disabled + aria-disabled`；被拒时复用既有 `toast("只读画布不可编辑","!")`（600ms 去抖） | 同文件 C3 `applyReadOnlyUi` + CSS | `data-openarc-readonly` + 截图 |

状态来源仍是桥的唯一事实 `openarc-canvas-context`（`readOnly` / `canEdit` 两个字段都认，桥默认 `readOnly:true` 是 fail-closed）；
**后到的 context 同样生效**：先可编辑打开、再推 `readOnly` ⇒ 之后每条操作都被拒（11.4 的 S4 用例）。

### 11.2 穷举清单（路径 / file:line / 封堵方式 / 真机用例）

坐标 = `public/novai-canvas/static/js/smart-canvas.js`（vendor 生成件，行号已核对）。

| # | 编辑路径 | 入口 file:line | 真正改文档的地方 | 封堵方式 | 用例 |
| --- | --- | --- | --- | --- | --- |
| 1 | 节点拖动 | `.image-node` `el.onmousedown = beginNodeDrag` :19939（判定 :19858-19893） | `window.onmousemove` 原地改 `node.x/y` :28822-28827；`window.onmouseup` 提交 :28900-29015 | 事件闸（mousedown）+ 函数闸 `capturePendingUndo`/`commitPendingUndo`/`pushUndo` | P01 |
| 2 | 节点缩放 | `.node-resize-handle` mousedown :19817-19856（表格/批量 :13210-13232） | 同上 mousemove :28603+ / `finishNodeResize` :28485 | 事件闸 + 函数闸 | P02 |
| 3 | 缩略图拖出拆图 | `.thumb-item` mousedown :19797-19813 | mousemove `source.images.splice` :28755-28776 | 事件闸 + 函数闸 | P01/P02 同类 |
| 4 | 框选 | `shell.onmousedown` :28262-28288（`isRKeyDown`/Ctrl 分支） | `updateSelectionBox` :27623 / `finishSelection` :27633（选中态） | 事件闸（mousedown 冒泡自 `#world`） | P03 |
| 5 | 多选 | 同上（Ctrl 分支 :28274） | 同上 | 事件闸 | P04 |
| 6 | 新增节点（底栏） | `window.zoomBarCreate` :30441 → `createNodeFromMenu` :28214 | `createNode` :11170 / `createImageNodeAt` :1955 / `createPromptNode` :11183 / `createLoopNode` :11212 / `createSmartGroupNode` :11221 / `createSmartTextNode` :27954 / `createSmartLabelNode` :27964 / `createSmartTableNode` :27983 / `createSmartBatchNode` :27865 | 函数闸 | P05 |
| 7 | 新增节点（创建菜单/空画布引导） | `shell.oncontextmenu` :28289 / `shell.ondblclick` :28315 / `#smartEmptyGuide` click :32626 → `openCreateMenu` :27839 | 同上 | 事件闸（contextmenu/dblclick/click）+ 函数闸 `openCreateMenu` | P06 |
| 8 | 删除节点（键盘） | `window` keydown Delete/Backspace :29269-29276 | `pushUndo` + `deleteNode` :20011 | 键盘闸 + 函数闸 | P07 |
| 9 | 删除节点（按钮） | `.node-delete` click :19603-19610 / `.image-delete` :19648-19655 | `deleteNodeFromButton` :20053 / `deleteImage` :20140 / `clearNodeMediaBeforeDelete` :20029 | 事件闸 + 函数闸 | P08 |
| 10 | 连线（端口拖拽） | `.node-port` mousedown :19897-19916 → `handlePortDrop` :19338 | `connectInputNode` :24143 / `addConnection` :24136 | 事件闸 + 函数闸 | P09 |
| 11 | 断线（点连线） | `bindConnectionEvents` click :18815-18828 | `disconnectConnections` :20061 / `disconnectConnection` :20057 | 事件闸 + 函数闸 | P10 |
| 12 | 分组 | Ctrl+G :29283-29286 | `groupSelectedNodes` :27652 | 键盘闸 + 函数闸 | P11 |
| 13 | 取消分组 | Ctrl+Shift+G :29277-29282 | `ungroupNode` :27684 | 键盘闸 + 函数闸 | P12 |
| 14 | 拖入分组 / 多图合并 | 拖动落点判定 :28940-28961 | `addDraggedNodesToSmartGroup` :27813 / `addNodeToSmartGroup` :2037 / `mergeImageNodesIntoGroup` :27767 | 事件闸 + 函数闸 | P01/P12 同类 |
| 15 | 表格内联编辑 | `mountSmartTableNodes` :13367；外部 `window.NovaTableNode`（`ensureTableApi` :32443-32474） | 模块内部（无可包装注入点） | 事件闸整体挡在交互层（`beforeinput`/`input`/`change`/`mousedown`/`click` + `[contenteditable]` 归属 `#world`） | P13 |
| 16 | 属性面板 / 参数编辑 | `#composer`（`#promptInput`、`#engineSelect` onchange :29294、`#apiKindToggle` :29313、`#dynamicParams` 委托） | `setDynamicSetting` :5368 / `applyUnifiedPlatform` :4143 / `persistActiveSmartSettings` :1760 / `saveSmartPromptTextFromComposer` :22876 | 事件闸（input/change/click）+ 函数闸 | P14 |
| 17 | 右键菜单各项 | `shell.oncontextmenu` :28289 → `openCreateMenu` :27839 / `openSmartNodeMenu` :33291 → `onSmartNodeMenuClick` :33346 | `runSmartNodeToolbarAction` :17460 / `duplicateSmartNodeMediaToCanvas` :15230 / `replaceSmartNodeMedia` :14332 / `deleteNode` :20011 … | 事件闸（contextmenu/click）+ 函数闸 | P15（同类 P06/P08） |
| 18 | 键盘（方向键微移） | keydown 方向键 :29231-29234 | `nudgeSelectedSmartNodes` :11302 | 键盘闸 + 函数闸 | P16 |
| 19 | 键盘（Cmd+V / paste） | `window` paste :29178-29193 / Cmd+V :29242 | `handleFiles` :23843 / `pasteNodes` :11318 / `createImageNodeAt` :1955 | 键盘闸 + paste 事件闸 + 函数闸 | P17 |
| 20 | 键盘（Cmd+A / D / C / Alt 对齐） | :29221 / :29226 / :29235 / :29264 | `selectAllSmartNodes` / `duplicateSelectedSmartNodes` :11271 / `alignSelectedSmartNodes` :33217 | 键盘闸 + 函数闸 | P11/P16 同类 |
| 21 | 拖拽落点（侧栏/素材库拖入） | `shell.ondrop` :29159-29177 / `.image-node` `el.ondrop` :19941 / `assetPanel` drop :29740（`handleAssetPanelDrop` :29692） | `createImageNodeAt` :1955 / `handleSmartImageDropPayload` :23864 / `addUrlToAssetLibrary` :10846 | 事件闸（dragstart/dragover/drop）+ 函数闸 | P18 |
| 22 | 图片/视频参数修改 | `openImageEditor` :22352；`#imageEditApplyBtn` onclick → `applyImageEdit` :22858 | `applyImageCrop` :22630 / `applyImageOutpaint` :22646 / `applyImageMask` :22675 / `applyImageBrush` :22708 / `applyImageGridSplit` :22724 / `applyImageGridJoin` :22794 / `applyImageResize` :22835 / `replaceEditedImage` :22609 / `transformSmartNodeImage` :15513 | 事件闸（`#imageEditModal`）+ 函数闸（含 window 重指） | P19 |
| 23 | Agent 应用画布操作 | `agentRunStepResult` :7230 / `agentRunPlanHandoff` :7259 / `agentConfirmCardAdd` :7608；测试钩子 `__smartAgentTestHooks.applyOps` :33195 | `applyAgentCanvasOps` :7087 / `agentRunClientActions` :9061 / `agentUndoRun` :7523 | 函数闸（+ 事件闸挡聊天面板 + fetch 写闸挡 `/api/agent/*`） | P20 |
| 24 | 撤销 / 重做入口 | `window.zoomBarUndo/Redo` :30448-30449 / Cmd+Z :29259 / Cmd+Shift+Z、Cmd+Y :29254 | `performUndo` :291 / `performRedo` :283 / `pushUndo` :262 / `restoreUndoSnapshot` :269 | 键盘闸 + 函数闸 | P21 |
| 25 | 提示词模板库写操作 | `#composerTemplateBtn` → `renderPromptTemplatePanel` :9405；面板按钮 `[data-template-save-current]`/`[data-template-edit-save]` | `saveCurrentPromptAsTemplate` :9614 / `savePromptTemplateEdit` :9667 / `deletePromptTemplate` :9712 / `createPromptTemplateGroup` :9740 / `renamePromptTemplateGroup` :9771 / `deletePromptTemplateGroup` :9800 / `applyPromptTemplateToNode` :9588 / `savePromptNodeAsPreset` :9340 / `editPromptPresetForNode` :9826 / `savePromptPresets` :5777 | 事件闸（`#promptTemplatePanel`/`#promptPresetPanel`）+ 函数闸 + fetch 写闸（`/api/prompt-libraries/*` :9624/9649/9676/9717/9755/9787/9806） | P22 |
| 26 | 版本恢复 / 删除 | `window.restoreCanvasVersion` :30411 / `window.deleteCanvasVersion` :30399 | `restoreCanvasVersion` :30316 / `deleteCanvasVersion` :30345 | 函数闸 + 事件闸（版本面板按钮 disabled）+ fetch 写闸 | P19 |
| 27 | 任何 `/api/*` 写请求 | `saveCanvas` :11094（PUT `/api/canvases/:id`）、`scheduleSave` :11050 | 素材库写 :10720/10744/10812/10837/10850/10870/10887/10908；Agent 写 :6156/6207/6216/6238/6699/7529/7604/7742/8493/8569/8586/10179；任务 :26940/27072/32745 … | fetch 写闸（只读时非 GET/HEAD/OPTIONS ⇒ 页面侧 403，不落网络） | P23 |
| 28 | 生成落图 / 运行 | 运行入口 :26575+（`runGeneration`/`runPromptLLMNode`/`runApiGeneration`/…） | `finalizePendingNode` :25198 / `completeSmartNodeWithImages` :10144 / `autoPlaceGeneratedNode` :25242 / `createPendingOutputFromSource` :25035 | 函数闸 + 运行按钮恒 disable + fetch 写闸 | P05/P19/P20（同类） |

**非编辑路径（明确保留，不封）**：滚轮/触控板缩放平移（只改视口，本机存 `novai_smart_viewport`）、选择节点、打开日志/快捷键/版本历史查看、
导出（下载）——它们在只读态仍可用；只有真正的编辑动作才会触发 `openarc-canvas-blocked`。

### 11.3 真机用例（只读）

一条路径一个用例；断言 = ① 操作被拒（`blocked+≥1`）② 画布文档逐字节未变（`snapshot()` 含 `nodes/connections/title/icon/logs/settings/updated_at`）③ 后端 0 写请求（`writeBlocked` 不变 + `updated_at` 不变 + 直连写返回 403）。
`node experiments/dxos-canvas-scope/readonly-gate-probe.mjs` ⇒ **PASS 56 / FAIL 0**。

| 编号 | 路径 | 被拒（blocked+） | 文档逐字节 | 后端写 |
| --- | --- | --- | --- | --- |
| P01 | 节点拖动 | 1 | 未变 | 0 |
| P02 | 节点缩放 | 1 | 未变 | 0 |
| P03 | 框选 | 1 | 未变 | 0 |
| P04 | Ctrl 框选（多选） | 1 | 未变 | 0 |
| P05 | 底栏新增节点 | 1 | 未变 | 0 |
| P06 | 右键创建菜单 | 1 | 未变 | 0 |
| P07 | Delete 删除 | 2 | 未变 | 0 |
| P08 | 工具条删除钮 | 1 | 未变 | 0 |
| P09 | 端口拖拽连线 | 1 | 未变 | 0 |
| P10 | 点连线断线 | 1 | 未变 | 0 |
| P11 | Ctrl+G 分组 | 4 | 未变 | 0 |
| P12 | Ctrl+Shift+G 取消分组 | 1 | 未变 | 0 |
| P13 | 表格内联编辑 | 5 | 未变 | 0 |
| P14 | 属性面板/参数编辑 | 3 | 未变 | 0 |
| P15 | 右键菜单（节点/空白） | 2 | 未变 | 0 |
| P16 | 方向键微移 | 5 | 未变 | 0 |
| P17 | Cmd+V / paste | 1 | 未变 | 0 |
| P18 | 素材库拖入 | 2 | 未变 | 0 |
| P19 | 图片参数/版本恢复删除 | 3 | 未变 | 0 |
| P20 | Agent `applyOps` | 1 | 未变 | 0 |
| P21 | 撤销/重做（底栏+Cmd+Z） | 4 | 未变 | 0 |
| P22 | 模板库写操作 | 1 | 未变 | 0 |
| P23 | saveCanvas + 直连 PUT | 2（直连 PUT 被 fetch 闸 403） | 未变 | 0 |
| S2.1 | 服务端 revision | - | `updated_at` 未变 | 0 |

### 11.4 可编辑回归 + 后到 context

| 编号 | 用例 | 结果 |
| --- | --- | --- |
| R01 | 新增节点 | 文档变化 |
| R02 | 选中后 Delete | 文档变化 |
| R03 | 撤销 | 文档变化 |
| R04 | 重做 | 文档变化 |
| R05 | 连线（applyOps） | 文档变化 |
| R06 | 断线（点连线） | 文档变化 |
| R07 | Agent 落节点 | 文档变化 |
| R09 | 端口拖拽真连线 | 文档变化 |
| R08 | 直连 PUT | 服务端真收到（非 403），页面 `writeBlocked` 不变 ⇒ 写闸只在只读态生效 |
| L01–L08 | 先可编辑 → 推 `readOnly` → 节点拖动/新增/连线/删除/参数/Agent/撤销/保存 | 每条 `blocked+≥1`、文档未变、0 写 |

全局健康：0 console error / 0 pageerror / 0 条 404 / 0 条 5xx。

### 11.5 覆盖不足 / 确实拦不住的路径

| 路径 | 为什么不能用"包装函数"封 | 现状 | 代价 / 后续 |
| --- | --- | --- | --- |
| 表格/批量节点内部模型改动 | 表格是外部 `shared/table-node.js` 模块（`window.NovaTableNode`），只通过回调 `addNode`/`connectNodes`/`pushUndo`/`saveCanvas` 与画布交互，内部单元格编辑不经过任何画布闭包函数 | **已覆盖**：事件闸在交互层就把 `mousedown`/`beforeinput`/`input`/`change` 全拦在 `#world` 内（P13 真机 5 个 blocked、文档未变、0 写）；回调侧的 `connectNodes`→`connectInputNode`、`saveCanvas`、`pushUndo` 也都有函数闸 | 不改上游即可；若上游改用程序化路径（非用户事件）改 `node.table`，需要上游给一个可注入的编辑入口 |
| 视口（缩放/平移） | 它不是文档内容（不写 `nodes/connections`，只本机存视口；保存时会跟着 PUT，但只读时无保存） | 有意保留（只读用户仍可查看） | 无 |
| 只读态下的"查看类"动作 | 选择/预览/日志/导出不是编辑 | 有意保留 | 无 |

**回退方案（若裁决为"不改上游就拦不住"）**：本包没有出现这种路径 —— 上述唯一无函数注入点的表格路径已由事件闸覆盖并通过真机用例。
若后续上游把某条编辑改成**非事件驱动**（例如定时器或 WebSocket 消息直接改 `nodes`），回退方案是把 `canvas-list.html` 的
6 个入口从 `smart-canvas.html` 改回经典 `canvas.html`（`vendor-novai-app.mjs` 的 `LIST_PATCHES` 第 4-7 条反向；
经典页 + `openarc-adapter.js` + `openarc-canvas-guard.js` + `canvas-internals.js` 仍在包里），代价是放弃智能画布入口。

### 11.6 证据与重跑

- 探针：`experiments/dxos-canvas-scope/readonly-gate-probe.mjs`（真实 Electron + CDP 9866）。
- 结果：`artifacts/dxos-canvas-scope/readonly-gate-probe.json`（每个用例的 `docChanged/blockedDelta/apiDelta`）、`READONLY-GATE-RESULT.md`。
- 截图：`artifacts/dxos-canvas-scope/shots-readonly/editable-seeded-light.png`、`editable-after-edits-light.png`、`readonly-blocked-toast-light.png`（只读态 + "只读画布不可编辑"被拒提示）。
- 重跑：`node experiments/dxos-canvas-scope/readonly-gate-probe.mjs`。
- 单测：`node --test tests/d5-02-canvas-*.test.mjs tests/dxos-canvas-*.test.mjs tests/canvas-library-list.test.mjs` = **221 pass / 0 fail**；
  `npm run build`（含 `tsc --noEmit`）= exit 0；`npx tsc --noEmit` = exit 0。

