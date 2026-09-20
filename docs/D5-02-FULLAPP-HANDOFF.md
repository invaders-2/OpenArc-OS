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