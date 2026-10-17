# PRUNE · 只保留「无限画布」（D5-02 vendor bundle 裁剪报告）

- 上游：`invaders-2/NOVAI-Infinite-Canvas`，固定 commit 见 SOURCE.md；本报告基线 commit
  `6ce1a64680b669b31c2ac3b32418b54decd404f2`。**并发更新（2026-10-16 23:45）**：另一会话升到
  `1e20abe5145470b32f58206f692292703540107a` 并重新 vendor（`static/` 54→63、bundle 60→69、新增
  `static/tools/lossless-edit/` 等）；下面逐文件清单描述的是 `6ce1a646` 那次裁剪。本次"删 bundle 根 index.html"
  的结论、裁剪策略与"下次 vendor 不再拷回"的保证在两次 commit 下都成立。
- **最终范围（2026-10-17 · REVENDOR-NEXT，见 §6）**：只留 `canvas-list.html` + `smart-canvas.html` 两个页面；
  传统编辑器 `static/canvas.html` / `static/js/canvas.js` / `static/css/canvas.css` **已删除**（闭包实测只删这 3 个），
  入口全部改向智能画布；守卫 / 适配器 / 只读闸 / 应用内模态已按新源码移植到 `smart-canvas.js` + `openarc-smart-adapter.js`。
  下文第 1–5 节是历史基线（`6ce1a646` / 三页白名单）；**当前口径以 §6 为准**。
- 目标：把这个 vendor bundle 裁成**只有无限画布**，入口 `static/canvas-list.html`、唯一编辑器 `static/smart-canvas.html`；
  `openarc-bridge.js` / `openarc-smart-adapter.js` / `openarc-rename-modal.js` 一个不少（经典
  `openarc-adapter.js` / `openarc-canvas-guard.js` 已无页面加载，暂留作门禁重定向前的对照）。
- 裁剪方式：**页面白名单 + 依赖驱动闭包**（策略在 `experiments/d5-02/vendor-novai-app.mjs`，执行器
  `experiments/dxos-canvas-prune/prune-public.mjs`），不是手工删文件；换上游 commit 重跑自动得到裁剪后的结果。
- 实测（基线 `6ce1a646`）：文件 **109 → 60**（static/ 内 103 → 54；另删 bundle 根 1 个）；字节 **14,222,868 → 10,686,992**
  （static/ 资源净减 3,305,663 B，约 −23%；再减 bundle 根 index.html 247,709 B）；
  实机验证 0 console error / 0 pageerror / 0 个 asset-not-found（见文末第 6 节与 `artifacts/dxos-canvas-prune/`）。

---

## 1. 怎么判"可达"（静态可达性口径）

从三个入口页面出发，逐文件扫描这几类引用并做传递闭包：

- HTML：`<script src>`、`<link href>`、`<img/video/source src>`、`a href`、内联 `url(...)`、写死的 `/static/...`；
- JS：`/static/...` 字面量（含 `fetch(...)`、动态 `import(...)`、`new Worker(...)`）；
- CSS：`url('/static/...')` 与 `@import`。

三个入口页面 = `static/canvas-list.html`（产品入口，`src/canvas/CanvasHost.tsx:37` 的 `IFRAME_BASE`）、
`static/canvas.html`（编辑器）、`static/smart-canvas.html`（智能画布编辑器）。

**为什么 smart-canvas.html 算画布的一部分**：列表页按画布自身的 `kind` 直接路由过去 ——
`canvas-list.html:1260-1262`（`openCanvas`）、`:1361-1363`（`createCanvasFromPicker`）、`:1379-1381`（「继续上次」）
都是 `c.kind === 'smart' ? /static/smart-canvas.html?... : /static/canvas.html?...`；`canvas.js:2147` 也会跳它。
所以它是"智能画布"编辑器，不是旁支，保留。

闭包之外、又找不到页面/标签引用的页面与资源，才删。体积大户（images / vendor / js / css）全部**逐文件**判定，不整目录一刀切。

---

## 2. 逐项结论（用户点名要判断的）

| 项 | 结论 | 依据 |
| --- | --- | --- |
| `static/smart-canvas.html` | **保留**（是画布的一部分） | 列表按 kind 路由到它：canvas-list.html:1260-1262 / 1361-1363 / 1379-1381；canvas.js:2147。它是"智能画布(Agent)"编辑器，与经典画布共用节点/表格/i18n/调色与适配层之外的安全不变式。 |
| `static/api-settings.html` | **删除** | 只被外壳 `index.html`/`static/index.html` 引用（grep `.html` 在 canvas-list/canvas/smart-canvas 三个入口内 0 命中）。画布页里的"去 API 设置"文案由守卫改成宿主命令 `app.openModelSettings`（→ OpenArc 总设置），从不打开这个页面。 |
| `static/asset-manager.html` | **删除** | 只被外壳引用。canvas.html 自带内联素材库弹层 `#assetManagerModal`（canvas.html:382-400，由 canvas.js:6738+ 渲染），与这个独立页面无关。 |
| `index.html`（bundle 根） | **删除（本轮）** | 它唯一用途是被 `experiments/d5-02/canvas-e2e.mjs` 的 E4 边界测试加载造伪造帧；E4 已改到保留的产品页 `static/canvas-list.html`（旧外壳 eager 的 `#frame-home` 指向已删的 `static/home.html`，加载即 1 条 404）。改后全仓零真实引用 ⇒ 删除；vendor 脚本第 5 步同步移除并清残留。 |
| `static/index.html` | **删除** | 它是根 `index.html` 的**未注入副本**：根 index.html = 它 + `openarc-shell.js`（vendor 脚本生成）。运行时无人请求 `/static/index.html`（全 bundle 无 `/static/index.html` 引用）；本轮根 index.html 也一并删除。 |
| `static/runninghub/**` | **删除**（6 张缩略图 + .gitkeep，40,608 B） | 只被 `static/js/api-settings.js:998` 与 `:2192` 当工作流缩略图扫描；api-settings 页已删。画布自身只用 `/api/runninghub/*`（HTTP，不受影响，`canvas.js:8541+`）。 |
| `static/system-prompts/**` | **保留**（1 个 .md，48,844 B） | 无限画布的提示词模板数据（文件名 `infinite-canvas-prompt-templates.md`）。页面通过 `/api/smart-canvas/prompt-templates` 拿模板（`smart-canvas.js:6536`），这个文件是 vendor 侧模板来源；不在 `<script>/<link>` 里，脚本闭包判不出，故写进 `EXTRA_KEEP`。 |
| `static/vendor/**` | **逐文件保留/删除** | 保留 `css/fonts.css`、5 个 JS（tailwind / lucide / glfx / html-to-image / three）、9 个字重文件（fonts.css:6/14/22/30/38/46/54/62/70）；删除 3 个 `space-grotesk-*.ttf`（无任何 `@font-face`：theme.css:1806 只是 `--font-display: 'Space Grotesk', …` 的**回落名**，fonts.css 里没有对应 face）。`MANIFEST.md` 无运行时引用，作为来源记录保留。 |
| `static/images/**` | **逐文件保留/删除** | 保留 `logo.png`（favicon，canvas-list.html:8 等）、3 张 concept 素材（canvas-list.html:804/815/826）、`RunningHub-B/W.png`（被 OpenArc 产品代码 `src-vue/settings/providerLogos.ts:71` 引用，删了设置页缺图）。删除 logo 变体 / icon.icns / icon.ico / modelscope gif / volcengine svg / 5 张 screenshots（全 bundle 无引用，详见第 3 节）。 |

---

## 3. 删除清单（static/ 内 49 个文件 3,305,663 B + bundle 根 1 个文件 247,709 B）

> 完整逐文件字节见 `artifacts/dxos-canvas-prune/prune-report.json`。分组如下：

**外壳子页面（10 个，669,122 B）** —— 只被 `index.html`/`static/index.html` 引用，画布三入口 0 引用：
`home.html` `enhance.html` `klein.html` `angle.html` `online.html` `zimage.html` `gpt-chat.html` `asset-manager.html` `api-settings.html` `comfyui-settings.html`

**外壳子页面的 JS/CSS（8 个，685,336 B）** —— 只被上面这些页面加载：
`js/api-settings.js`（api-settings.html）`js/asset-manager.js`（asset-manager.html）`js/comfyui-settings.js`（comfyui-settings.html）
`css/api-settings.css` `css/asset-manager.css` `css/comfyui-settings.css` `css/nv-beam.css`（只 home.html:12）
`js/history-bulk-manager.js`、`js/image-preview.js`（只 zimage/angle/klein/online/enhance）

**未加载 / 未引用的共享脚本（3 个，58,104 B）**：
`js/canvas-list.js`（**页面没有 `<script src>` 它**：canvas-list.html 只有 5-18 行的 9 个脚本，页面逻辑在 960 行起的内联脚本；
全 bundle 对它的提及只有注释 canvas-list.html:961/1098/1100/1101/1108/1538、viewport.js:2）
`js/i18n/validate-i18n.js`（无引用）`static/index.html`（见上表）

**图片（14 个，1,135,043 B）**：
`images/icon.icns`（317,843）`images/icon.ico`（29,168）—— 无引用；打包脚本用的是独立的 `build/icon.icns`（scripts/pack-app-offline.mjs:85、scripts/sync-app.mjs:179）
`images/logo.svg` `logo_48/128/256/512.png`（无引用）
`images/modelscope.gif` `modelscope-1.gif`（只 shell 页 / api-settings.js；产品改用 `provider-logos/modelscope.svg`，providerLogos.ts:66）
`images/volcengine-theme-light/dark.svg`（只 api-settings.js；产品用 `provider-logos/volcengine.svg`，providerLogos.ts:67）
`images/screenshots/{assets,canvas,generate,home,settings}.png`（全 bundle 的 HTML/JS/CSS 0 引用，文档配图用）

**字体（3 个，208,124 B）**：`vendor/fonts/space-grotesk-8/9/10.ttf`（无 `@font-face`，见上表）

**RunningHub 缩略图（7 个，40,608 B）**：`runninghub/thumbnails/*`（只 api-settings.js）

**其它（1 个，20,837 B）**：`update-notes.json`（只在 shell 的更新器代码里作为 **ModelScope 远端 URL** 的 FilePath 出现，static/index.html:4867；本地从不 fetch）

**bundle 根（2 个）**：`index.html`（247,709 B）—— 上游 AI Studio 外壳副本 + `openarc-shell.js` 注入；
`openarc-shell.js`（15,029 B）—— 只被该外壳注入。
E4 边界测试改到产品页 `static/canvas-list.html` 后 index.html 零真实引用 ⇒ 随外壳删除；`openarc-shell.js`
随之全仓零加载 ⇒ 本轮裁决一并删除（vendor 第 5 步不再生成/保留，`prune-public.mjs` 列它为「必须不存在」）。

---

## 3b. 本轮**未删除**、待重新 vendor 时删除并移植（2026-10-17 第二包）

用户裁决：入口已改向智能画布，但经典编辑器 `static/canvas.html` / `js/canvas.js` / `css/canvas.css` 的**物理删除**，
以及 `openarc-canvas-guard.js` / `openarc-adapter.js` / `experiments/d5-02/vendor/canvas-internals.js` 的**整体移植**，
留到用户改完上游、**重新 vendor** 的那一次一起做（避免基于旧源码写一遍、拉新源码再写一遍）。

- 本轮**暂不删**：`canvas.html`（45,629 B）、`css/canvas.css`（168,364 B）、`js/canvas.js`（824,303 B）仍在 bundle 里，
  用户已从入口到不了它。体积对比因此**不能按删除后**读；删了它们才能把 `static/` 从 3 个页面减到 2 个。
- **待重新 vendor 时删除**：上面三个文件 + 只被 `canvas.html` 引用的资源。闭包实测见
  `artifacts/dxos-canvas-scope/closure-probe.json`（当前保留 58/63；收窄白名单 + 排除页后 60/63，真正的删除只有这 3 个）。
- **同时按最终源码移植到智能画布**：逐条移植清单（守卫 / 适配器 / internals，共 12 点）见
  `experiments/dxos-canvas-scope/README.md` 第 4 节；本包只做了其中"能证明不假可用"的最小封堵（第 12 处 vendor 改动）。

---

## 4. 前后体积对比

| 目录 | 裁剪前 | 裁剪后 | 说明 |
| --- | --- | --- | --- |
| `public/novai-canvas/` 总体 | **14M / 109 文件** | **10.2M / 60 文件**（含新增 PRUNE.md） | static/ 内 −3,305,663 B（−23.2%）+ 根 index.html −247,709 B |
| `static/`（页面） | 9 文件 | 3 文件 | 只留 canvas-list / canvas / smart-canvas |
| `static/js/` | 2.9M | 2.3M | 留 canvas.js / smart-canvas.js / 共享 / i18n |
| `static/css/` | 828K | 544K | 留 canvas-list / canvas / smart-canvas / table-node / theme / marvis-shared |
| `static/images/` | 4.7M | 3.5M | 留 concept 素材 3.5M（画布列表轮播）+ logo + RunningHub 字标 |
| `static/vendor/` | 3.8M | 3.6M | 留 tailwind/lucide/glfx/html-to-image/three 1.7M + 字体 1.9M |
| `static/runninghub/` | 48K | 0（目录已清） | api-settings 用 |
| `static/system-prompts/` | 48K | 48K | 画布提示词模板，保留 |

> 字节数：before 14,222,868 B / 109 文件（`before.json`）；裁剪后 static/ 资源 10,559,150 B / 54 文件
> （`prune-report.json`）；bundle（根文件 + 新增 PRUNE.md）共 **60 文件 / 10,686,992 B**。static/ 内净减 3,305,663 B，另删根 index.html 247,709 B。

---

## 5. 保留清单（含"被谁引用"依据）

**bundle 根（4 + PRUNE.md）**
| 文件 | 依据 |
| --- | --- |
| `openarc-bridge.js` | 每个页面 `<head>` 最先注入（vendor-novai-app.mjs 的 HEAD_INJECT；canvas-list.html:5 等） |
| ~~`openarc-shell.js`~~ | **已删除**：原先只注入根 index.html；外壳删除后全仓零加载 ⇒ 本轮裁决删除（vendor 第 5 步清旧副本，`prune-public.mjs` 列「必须不存在」） |
| `openarc-adapter.js` | 仍只注入 canvas.html（vendor-novai-app.mjs 第 4 步）；**待重新 vendor 时删 canvas.html 并移植到智能画布**（见 3b） |
| `openarc-canvas-guard.js` | 仍只注入 canvas.html；**待重新 vendor 时删 canvas.html 并按智能画布新 DOM 重写移植**（见 3b） |
| `openarc-rename-modal.js` | **只注入 canvas-list.html 与 smart-canvas.html**（vendor-novai-app.mjs 第 4 步）：`window.__openarcPrompt` 替代 Electron 不支持的 `window.prompt`（列表重命名画布、智能画布提示词模板分组） |
| `SOURCE.md` | 上游来源与改动记录 |
| `PRUNE.md` | 本文件 |

**static/（54 个）**
| 保留物 | 被谁引用（证据） |
| --- | --- |
| `canvas-list.html` | `src/canvas/CanvasHost.tsx:37` IFRAME_BASE（产品入口） |
| `canvas.html` | canvas-list.html:1262/1363/1381；`src/canvas/CanvasHost.tsx:6` |
| `smart-canvas.html` | canvas-list.html:1260/1361/1379；canvas.js:2147 |
| `css/canvas-list.css` `css/theme.css` `css/marvis-shared.css` | canvas-list.html:19/20/21（canvas.html:13/15 也引 theme/marvis） |
| `css/canvas.css` `css/table-node.css` | canvas.html:12/16（smart-canvas.html:14 也引 table-node） |
| `css/smart-canvas.css` | smart-canvas.html:12 |
| `vendor/css/fonts.css` | canvas.html:14、smart-canvas.html:15 |
| `js/canvas.js` | canvas.html:535 |
| `js/smart-canvas.js` | smart-canvas.html:639 |
| `js/image-adjust-editor.js` | canvas.html:534、smart-canvas.html:638 |
| `js/i18n.js` | canvas-list.html:18、canvas.html:30、smart-canvas.html:29 |
| `js/i18n-core.js` `js/i18n/{common,studio,api-settings,canvas,smart-canvas,comfyui-settings}.js` | i18n.js:4-10 **无条件并行加载这 7 个文件**（名字虽带 api-settings/comfyui，但都在画布入口的加载路径上，删了会 404） |
| `js/theme.js` | canvas-list.html:14、canvas.html:20、smart-canvas.html:19 |
| `js/touch-mouse.js` | canvas-list.html:17、canvas.html:29、smart-canvas.html:28 |
| `js/shared/icons.js` `utils.js` `viewport.js` `media.js` `workflow-utils.js` `node-registry.js` `table-model.js` `table-node.js` `dropdown.js` | canvas-list.html:13/15/16；canvas.html:19-28；smart-canvas.html:18-27 |
| `vendor/js/tailwindcss-cdn.js` | canvas-list.html:11、canvas.html:17 |
| `vendor/js/lucide-subset.js` | canvas-list.html:12、canvas.html:18、smart-canvas.html:16 |
| `vendor/js/glfx.js` | canvas.html:533、smart-canvas.html:637 |
| `vendor/js/html-to-image.js` | smart-canvas.html:17 |
| `vendor/js/three-0.160.0.module.js` | smart-canvas.js:12507（全景图按需 `import()`） |
| `vendor/fonts/{Geist-Variable,GeistMono-Variable,inter-1..5,jetbrains-mono-6,7}` | vendor/css/fonts.css:6/14/22/30/38/46/54/62/70（9 个 `@font-face`） |
| `images/logo.png` | canvas-list.html:8 等所有页面 favicon |
| `images/concept/{carousel-image-generation,carousel-node-workflow}.jpg` `concept/pinterest_carousel.mp4` | canvas-list.html:804/826/815（列表页轮播，3.5M，画布 UI 的一部分） |
| `images/RunningHub-B.png` `RunningHub-W.png` | `src-vue/settings/providerLogos.ts:71`（OpenArc 设置页品牌 logo）；测试 tests/dxos-model-settings-ui.test.mjs:116/117 |
| `system-prompts/infinite-canvas-prompt-templates.md` | 无限画布提示词模板数据（EXTRA_KEEP） |
| `vendor/MANIFEST.md` | 上游 vendor 目录来源记录（EXTRA_KEEP，无运行时引用） |

**运行期不直接请求、但被保留的目录**：`static/vendor/fonts/`（只被 `fonts.css` 的 `url()` 引用）。

---

## 6. 复现与验证

### 6.1 复现裁剪
```
# 换上游 commit 后重新 vendor：自动只拷贝白名单 + 依赖闭包；bundle 根 index.html 不再生成（会清掉旧残留）
OA_NOVAI_SRC=/tmp/novai-canvas-src node experiments/d5-02/vendor-novai-app.mjs

# 没有上游检出时，直接对已 vendor 的 bundle 应用同一策略（--check 只报告）
node experiments/dxos-canvas-prune/prune-public.mjs --check
node experiments/dxos-canvas-prune/prune-public.mjs
```
策略唯一来源：`experiments/d5-02/vendor-novai-app.mjs` 的 `PAGE_WHITELIST` / `EXTRA_KEEP` / `computeKeepSet()`。

### 6.2 实机验证（PASS 9 / FAIL 0）

探针 `experiments/dxos-canvas-prune/real-device-canvas.mjs`，结果 `artifacts/dxos-canvas-prune/RESULT.md` + `RESULT.json` + `shots/*.png`。
真实 Electron（隔离 userData + 唯一 CDP 端口 9821）打开 appId=canvas：

- 列表页渲染（`画布工作台` / 开始创作 / 继续上次 / 新建画布 / 卡片网格）✔
- 「新建画布」→ 编辑器 `static/canvas.html`（适配器就绪、非只读、真新建）→ 返回列表 ✔
- 真实模型调用（编辑器 `runNode` → OpenArc 模型服务 → 本地 provider → 节点拿到 `OPENARC-CANVAS-LLM:…`；provider chats=1、authSeen=1）✔
- **产品画布流全程 0 条 404（asset not found）、0 console error、0 pageerror** ✔
- 截图 4 张（列表/编辑器 × 浅/深，2880×1880 @2x）✔
- 真实 profile `~/Library/Application Support/openarc-os` 收工前后 mtime+size+sha256 完全一致；隔离 userData 已删 ✔

**逐条 404**：产品画布流 0 条。原唯一的已知 404 来自**非产品入口**的 bundle 根 `index.html`：它的 `#frame-home` 是 eager `src="/static/home.html"`，而 home.html 已删 —— 只有加载这个测试用外壳时才有 1 条 `/static/home.html` 404。
本轮把 E4 边界测试的伪造帧来源改成保留的产品页 `static/canvas-list.html`（断言语义不变，另加"伪造帧加载 0 条 bundle 404"与"伪造帧确实加载了目标文档"两条），旧外壳因此零引用并删除。
对照证据：`artifacts/dxos-canvas-prune/E4-BOUNDARY.json`（修复前旧外壳 1 条 404 → 修复后产品页 0 条 404，边界断言都通过）；复现探针 `experiments/dxos-canvas-prune/e4-boundary-probe.mjs`。

---

## 6. 本轮（2026-10-17 · DXOS-CANVAS-REVENDOR-NEXT）· 白名单收窄，传统编辑器已删

白名单从 3 页收窄到 2 页，并新增排除页集合（`extractStaticRefs` 会从列表页入口改向前留下的
kind 三元 / 注释里抽出 `/static/canvas.html`，只改白名单不够）：

```js
PAGE_WHITELIST = ['canvas-list.html', 'smart-canvas.html']
PAGE_EXCLUDE   = ['canvas.html']
```

上游 `static/` **157 文件** → 保留 **60** / 排除 **97**；bundle 共 **67 文件 / 11,784,658 B**
（static/ 60 文件 / 11,606,625 B + bundle 根 7 个）。相比上一轮 bundle 69 文件 / 12,684,800 B，
净减 2 文件 / 900,142 B。

### 6.1 本轮真正删除的 3 个文件（闭包实测）

| 文件 | 字节 | 删除前被谁引用（证据） |
| --- | --- | --- |
| `static/canvas.html` | 45,629 | 只被 `canvas-list.html` 的 kind 三元（`openCanvas(c)` / `createCanvasFromPicker` 内导航 / `btnContinueLast`）引用；入口改向补丁（LIST_PATCHES #4/#6/#7）落盘后列表页 **0 处** `/static/canvas.html`，且 `PAGE_EXCLUDE` 兜住源里残留的注释/三元字面量 |
| `static/js/canvas.js` | 824,303 | 只被 `canvas.html` 的 `<script>` 标签引用（`canvas.html:535`）；智能画布用 `js/smart-canvas.js` |
| `static/css/canvas.css` | 168,364 | 只被 `canvas.html:12` 的 `<link>` 引用 |

合计删除 **1,038,296 B**。除此之外没有多删/少删：`tools/lossless-edit/index.html`（智能画布的 iframe 依赖）
及其 PSD 依赖 `vendor/ag-psd.js` 仍由闭包 + EXTRA_KEEP 保留。

### 6.2 落盘自检

```
$ node experiments/dxos-canvas-prune/prune-public.mjs --check
[prune] 源 static/ 文件 60；保留 60；删除 0
[prune] vendor-manifest: 源 157 / 保留 60 / 裁剪 97（本次 bundle 内再删 0）
```

bundle 里已无 `static/canvas.html` / `static/js/canvas.js` / `static/css/canvas.css`；
列表页与智能画布对它们的引用均为 0。真机 0 条 404 见 `artifacts/dxos-canvas-revendor-next/ENTRY-RESULT.md`。

### 6.3 体积对照（本轮）

| 目录 | 上一轮 bundle | 本轮 bundle | 说明 |
| --- | --- | --- | --- |
| `public/novai-canvas/` 总体 | 69 文件 / 12,684,800 B | **67 文件 / 11,784,658 B** | 删 3 个经典页资源；上游同时改了 10 个文件；新增 `openarc-smart-adapter.js` |
| `static/` | 63 文件 / 12,530,609 B | **60 文件 / 11,606,625 B** | −1,038,296 B 删除 + 上游 10 文件增删 |
| `static/` 页面 | 3 个 HTML | **2 个 HTML**（canvas-list / smart-canvas）+ 闭包带入的 lossless-edit | 传统编辑器下线 |

### 6.4 本轮（2026-10-17 · DXOS-CANVAS-FIX-LATENCY）· 文件集合不变

- 没有新增 / 删除 bundle 文件：宿主推送接收层（第 16 处改动）内联在 `static/js/smart-canvas.js` IIFE 末尾，
  兜底轮询（第 17 处改动）与守卫 v4 也是同文件的补丁/内联模板，不产生新的 bundle 根脚本。
- 体积：`public/novai-canvas/` **67 文件 / 11,808,169 B**；`static/` **60 文件 / 11,629,670 B**
  （较上一轮 +23,511 B / +23,045 B，全部是 `smart-canvas.js` 里的 live-sync + 守卫 v4）。
- 白名单/闭包/EXCLUDE 未改；`prune-public.mjs --check` 仍 60/60/0，manifest 源 157 / 保留 60 / 裁剪 97。
- vendor 幂等：连跑两次 manifest sha256 = `cffa65658bbe3e64273e5e6955780a7e05bba732400f0f16dd7981b2c755144d`；
  `--dry-run` 新增 0 / 删除 0 / 内容变化 0 / 相同 60。

### 6.5 本轮（2026-10-17 · DXOS-CANVAS-SHARING · P2）· 文件集合不变

- 只在 `static/canvas-list.html` 的卡片菜单加一项「共享…」（第 18 处改动，见 `SOURCE.md`）；
  共享面板/成员/角色/可见性全部在 **OpenArc 宿主浮层**，列表页只发一条消息，不新增页面或脚本。
- 文件集合与体积基线不变：`static/` 60 文件 / 11,629,670 B（只有 canvas-list.html 内容变化）；
  白名单/闭包/EXCLUDE 未改；`prune-public.mjs --check` 仍 60/60/0。
- vendor 幂等：连跑两次 manifest 逐字节一致（sha256 = 5acd748a53ea439804828912ecbf44deace016bb0ca5578967c1f392923076af）；
  `--dry-run` 新增 0 / 删除 0 / 内容变化 1（canvas-list.html）/ 相同 59。
