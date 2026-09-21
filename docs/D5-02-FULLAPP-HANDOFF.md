# D5-02 Full-App · 续接记录（2026-09-20 · 上下文耗尽前保存）

> 本文件是**精确续接记录**：下一位接手的上下文请从这里继续，不要重新调查。

## 0. 状态与基线（已核对）

| 项 | 值 |
| --- | --- |
| 工作区（唯一允许操作） | `/Users/wepingli/Desktop/OpenArc OS-d4-01` |
| 分支 | `feature/d4-03-tool-proxy` |
| 完整 HEAD | `eeaccdf8863be7a77dad905dbc2c99f39252ed49`（开工核对一致、工作树干净、无并发提交） |
| NOVAI 源 | `https://github.com/invaders-2/NOVAI-Infinite-Canvas` @ `6ce1a64680b669b31c2ac3b32418b54decd404f2` |
| 本地源检出 | `/tmp/novai-canvas-src`（git clone，只读参照） |
| 约束 | 不 push、不合并 main、不触碰默认/`integration` 等其他工作区、不操作其他运行中的实例、不进入 D5-03、不扩大 D4/D5-01 结论 |

## 1. 范围纠正（本指令替代此前"只提取画布编辑器"）

Boss 要的是 **NOVAI 完整应用**：**必须保留原有首页**与完整流程（首页 → 创建/打开/管理项目 → 进入画布 → 返回首页）；此前"首页与其他模块全部剔除"的决定**作废**；已删除的智能画布 / 素材库 / 提示词库等入口**逐项纳回**；依赖未接通的列为缺项，不静默删除。第三方服务入口可保留，但**不允许自动联网或购买服务**。

## 2. 已核对的源应用结构（下一步据此展开清单）

页面（`static/*.html`，14 个）：`index.html`(247KB)、`home.html`、`canvas.html`、`canvas-list.html`、`smart-canvas.html`、`asset-manager.html`、`gpt-chat.html`、`online.html`、`api-settings.html`、`comfyui-settings.html`、`angle.html`、`klein.html`、`zimage.html`、`enhance.html`。

**`index.html` 才是真正的应用外壳/首页**（`<title>AI Studio</title>`）：左侧导航 `switchUI(el, id)` 把每个子页放进 `<iframe id="frame-<id>" data-src="...">` 并按需加载（`static/index.html:3985-4010`）。导航项包括：首页(home)、在线生图(online)、GPT 对话(gpt-chat)、无限画布(canvas)、素材库(asset-manager) 等。

`index.html` 自身调用的后端端点：`/api/app-info`、`/api/changelog`、`/api/queue_status`、`/api/check-update`、`/api/update-*`（桌面更新器，含 GitHub 拉取）、`/api/update-connectivity*`。→ 更新器相关端点必须由宿主**明确拒绝**（不得因此联网）。

## 3. 集成决策（已定，直接实施）

1. **入口 = `openarc-canvas://bundle/index.html`**（完整外壳，含首页与左侧导航），不再只加载画布编辑器；子页仍走 `iframe`，因此**桥必须支持中继**：
   - 子页(iframe) → `index.html`(本身在 OpenArc sandbox iframe 里) → OpenArc 宿主；
   - 子页发的 `canvas->host` 消息由外壳**转发**给它的 parent，并把结果按来源路由回去；token 由外壳持有并在转发时附加；
   - 宿主侧校验不变：`event.source` 必须是 OpenArc 那一帧 + token 匹配。
2. **vendor 范围 = 整个 `static/`**（全部 14 个页面 + `js/`(含 smart-canvas.js / asset-manager.js / api-settings.js / canvas-list.js / history-bulk-manager.js / image-preview.js) + `css/` + `images/` + `vendor/` + `system-prompts/` + `runninghub/`），路径改写 `/static/` → `./`，**每一页都注入** `openarc-bridge.js`（+ 画布页注入适配器）；CSP 与 image/tool 白名单同样逐页注入。
3. **安全不变式（页面扩大后仍然成立）**：sandbox `allow-scripts`（opaque origin）、无 openarc 桥/Node/IPC/fs/凭据；所有出网经宿主受控命令；CSP `connect-src none` 等；`openarc-canvas://` 只读白名单；后端按会话重判身份/权限/版本；模型只来自 OpenArc。
4. **未接通即缺项**：桌面更新器、GUID 变更日志之外的更新链路、以及任何需要真实第三方供应商/付费的页面能力，一律**保留入口 + 明确报错**，不静默删页面。

## 4. 本轮已完成且**仍然有效**的成果（不要重做）

* `ce5dd21` + `eeaccdf`：画布生成 = 一个 Task（`canvas_runs` v18）；任务级预算/停止/迟到结果护栏；`canvas/importAsset`/`canvas/readAsset`（资源库稳定引用）；宿主 token 校验 + CSP + 协议白名单；画布页面的模型调用只经 `canvas:command` 的 run 链。
* 门禁 `experiments/d5-02/canvas-e2e.mjs` 现 25 条：**24 PASS / 1 FAIL**（FAIL = D1 无权限路径），干净树 `ce5dd21` 复跑一致；`tests/d5-02-canvas-{service,tool}.test.mjs` 12/12；`test:d5-01` 64/64。
* 仍未闭合的既定缺项（本指令 §四要求继续做）：① D1 撤权路径（`governance/getAppAccess` 拿不到 `model.use` 授予句柄 → 撤销未落地）；② 图片资源口径的产品验证（保存重开/账号隔离/删除或撤权提示/缓存失效）；③ AI 编辑真实产品链（提议→审批→执行→画布变化→保存恢复 + 旧 revision 对照）

## 5. 下一步（按顺序，逐块留证）

1. 全量 vendor `static/`（脚本化改写 + 逐页注入桥/CSP），`npm run build` 后确认 `dist/novai-canvas/` 含全部页面。
2. 桥加**中继**逻辑（见 §3.1），扩展端点白名单到外壳必需：`/api/app-info`、`/api/changelog`、`/api/queue_status`；更新器端点明确 `501 OPENARC_UNSUPPORTED`。
3. 宿主 `CanvasHost` 改为加载 `index.html`（顶部条保留 OpenArc 侧状态：只读/模型/停止），并保留 per-canvas `?id=` 的进入路径（由首页/项目列表点击进入画布）。
4. 门禁扩展（同一份 `canvas-e2e.mjs` 或新 `d5-02-app-e2e.mjs`）：首页呈现、导航逐项可达、创建/打开/管理项目、进入画布并返回首页、编辑保存关闭重开一致、模型结果落节点、失败/停止/预算如实、切账号隔离、AI 编辑全链（含旧 revision 对照）；并补 §4 的三个缺项。
5. 截图/录屏：本任务窗口的**首页 + 主要页面 + 完整导航流程**（不能用首页单图代替）。
6. 干净树复跑（build + 单测 + D5-02 门禁 + D5-01 基础/控制/可见性回归）→ 单独提交 `docs/D5-02-RESULT.md`、`docs/D5-02-GATE-EVIDENCE.json`、`PROGRESS.md`、`public/novai-canvas/SOURCE.md`（来源与改动清单）。

判定口径：首页或主要必需流程缺失、或 §4 已知安全缺项未闭合 → **D5-02 维持 PARTIAL**，不得以"单个画布可用"宣布 PASS。
## 6. 源应用全量清单（子 Agent 产出，已并入本记录；实现时直接照此执行）

**入口结论（再次确认）**：后端 `GET /` → `index.html`（`main.py:12890-12892`，`/` 是唯一非 `/static` 的页面路由）；`home.html` 只是 `index.html:3279` 的 iframe 子页；`home.html` 自身零跨页链接，全靠 `parent.postMessage({type:'navigate'…})`。

**一级导航（index.html 侧栏）**：首页→`/static/home.html` · 在线生图→`/static/online.html` · GPT 对话→`/static/gpt-chat.html` · 无限画布→`/static/canvas-list.html` · 素材库→`/static/asset-manager.html`；设置弹窗内嵌 `/static/api-settings.html?embed=1` 与 `/static/comfyui-settings.html?embed=1`。

**iframe 舞台**（`index.html:3279-3289`）：frame-home / zimage / enhance / klein / angle / online / gpt-chat / asset-manager / api-settings / comfyui-settings / canvas-list（`switchUI` 按需设 `src=data-src`）。已知上游坑：`DEFAULT_PAGE_ID='zimage'`(3901) 与预载 active 的 frame-home(3279) 不一致，首启可能高亮丢失（**不要在本轮"修上游"**，如实记录）。

**导航图要点**：`canvas-list.html` → `canvas.html` 或 `smart-canvas.html`（`window.location.href`，1256-1258/1357-1359/1375-1377，新建先 `POST /api/canvases` 再跳）；`canvas.js` → `canvas-list.html`（2715/439/2277/14878）与 `smart-canvas.html`（2129）；`asset-manager.js` → `canvas/smart-canvas`（707）。所有跳转都是**根绝对 `/static/*.html`**。

**每页必需端点（★）**：home ★`/api/recent-canvases`（+POST `/api/canvases`、`/api/lan-info`）；canvas-list ★`/api/projects`、★`/api/canvases`（+`/{id}`/`meta`/`touch`/`restore`/`purge`、`/trash`）；canvas ★`/api/canvases/{id}`、★`/api/workflows(/{id})`、★`/api/config`；smart-canvas ★`/api/canvases/{id}`、★`/api/workflows/{id}`、★`/api/tasks`、★`/api/canvas-llm`（+`/api/agent/*`）；asset-manager ★`/api/asset-library*`、★`/api/prompt-libraries*`；api-settings ★`/api/providers`、★`/api/settings/output-dir`；comfyui-settings ★`/api/comfyui/instances`、★`/api/workflows`；online ★`/api/config`、★`/api/online-image`；gpt-chat ★`/api/conversations`、★`/api/personas`、★`/api/memories`、★`/api/chat/stream`；zimage/enhance/klein ★`/api/generate`（+`/api/history`、`/api/view`）；angle ★`/api/angle/generate`+`/api/angle/poll_status`。index.html 自身 ★无，只有状态栏 `/api/queue_status` + WS 与更新器端点。

**除 /api 之外还必须替代**：`/ws/stats`（WS，index/zimage/angle/smart-canvas）；`/output`、`/assets`（后端静态挂载被当 URL 用）；`/api/download-output`、`/api/view`、`/api/media-preview`、`/api/canvas-assets/{check,download}`；上传类 `/api/upload`、`/api/ai/upload`、`/api/local-assets/upload`、`/api/cloud-video/upload`；**11 个 pywebview 宿主方法**（`save_file/select_directory/quit_app/minimize/maximize/close/get_data_dir/open_data_dir/set_auto_start/set_titlebar_theme`，出现在 index.html:3843-3864/4295/4306/4318、asset-manager.html:719/753/765、zimage.html:587-593、js/theme.js:42-46）→ 必须垫片或明确报错；index.html:4865-4868 **直接 fetch GitHub/Gitee/ModelScope**（更新流程）→ 必须由 CSP `connect-src none` 拦住并显示"更新不可用"。

**体积**：`static/` 13.8 MB（HTML 1.08 MB / js 2.89 MB / images 4.91 MB / vendor 3.98 MB（含 three 1.27 MB、tailwind 0.41 MB、fonts 2.18 MB）/ css 0.83 MB / system-prompts 0.05 MB / runninghub/thumbnails 0.04 MB）。

### 6.1 由清单导出的两处**设计修正**（覆盖第 3 节的写法）

1. **不做 `/static/` 路径改写**：把整棵 `static/` 原样放到 `public/novai-canvas/static/**`，入口仍是 `openarc-canvas://bundle/index.html`。自定义协议是 `standard:true`，因此页面里的**根绝对 `/static/...` 会自然解析为 `openarc-canvas://bundle/static/...`** —— script/link/iframe/字体/i18n 动态注入/`three-0.160.0.module.js` 的 `import()` 全部无需改写（改写 14 个页面 + 动态注入 + 动态 import 的风险远大于照原样服务）。协议处理器需放行 `bundle/static/**`（仍只读、白名单扩展名、无目录穿越）。
2. **iframe 必须 `allow-same-origin`**：上游跨页交互**严重依赖同源**（`index.html:4039` 丢弃 `event.origin !== location.origin` 的消息；`BroadcastChannel('studio-api')`；localStorage 键跨页共享；`theme.js:116 window.self !== window.top` 判定）。opaque origin 会静默打断 home→canvas 导航与主题/语言/缩放同步。**安全上可接受**：画布 bundle 的 origin 是 `openarc-canvas://bundle`，与 OpenArc 外壳（`file://`）**不同源**，因此画布仍无法触达外壳 DOM/`window.openarc`；隔离继续由 CSP、协议白名单、宿主 token+`event.source` 校验、后端按会话重判身份/权限/版本共同保证。
3. 桥需**中继**：子页 →（同一 bundle 内的）`window.top`（即 index.html 外壳页）→ OpenArc 宿主；token 由最外层 bundle 帧持有并在转发时附加，宿主仍只接受 `event.source === 画布帧` 且 token 匹配的消息。

### 6.2 未接通即缺项的候选（保留入口 + 明确报错，不删页面）

`/ws/stats` 实时队列、桌面更新器（`/api/update-*`、`/api/check-update`、GitHub/Gitee/ModelScope 直连）、`/output` 与 `/assets` 历史文件浏览、ComfyUI 实例与工作流执行、RunningHub/即梦/Codex/Gemini-CLI 等第三方供应商入口、pywebview 的 11 个宿主方法（可用 OpenArc 已有能力替换的：目录选择/保存文件→由宿主对话框代理；其余明确不适用）。所有第三方入口**只保留 UI 与明确错误，不自动联网、不购买服务**。