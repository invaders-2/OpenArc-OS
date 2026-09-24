# D5-02 Full-App · 完整应用集成结果（NOVAI AI Studio）

## 范围修正（2026-09-24）

本文原记录的是「完整应用外壳」形态：入口 `openarc-canvas://bundle/index.html` = 上游 AI Studio 外壳（首页 + 左侧导航 + 子页 iframe），宿主最外层还有窗口条。**该形态已被用户 2026-09-24 的范围修正取代**：

* 入口 = 用户截图里的「无限画布」首页（`static/canvas-list.html`：开始创作 / 继续上次 / 画布卡片列表），点这些入口直接打开真实编辑器，不再有额外欢迎页或选画布遮挡层；
* 去掉 NOVAI 完整应用的左侧导航与其他子页面入口，以及 OpenArc 画布宿主顶部操作条 / 状态行 / 提示横幅（真删）；保留首页 ↔ 编辑器返回路径；
* 供应商与模型只有 OpenArc 总 API 设置一个来源（统一模型服务；不用 NOVAI 配置页、静态清单、独立密钥、直连）；未接通能力（视频等）明确不可用，不能显示为已连接；
* 不许用 CSS 遮挡冒充完成；首页→画布通信、保存、权限、账号隔离都要正常。

新的入口 / 边界 / 模型真源**以本轮为准**：提交 `b7ebaa5`（入口与单一真源）→ `ec5cbc5`（不静默替换不可用的默认模型 + 被拦导航后立即复位）→ `5b77186`（本地保存后仍呈现宿主改动；默认值显示与说明行收口）→ `4525ab8`（保存冲突三方合并；MS §6 节点淡入 + 来源标记）→ `2a97b95`（F3f 取注入层证据的路径修正，判定未动）→ `a32c53d`（回收站 FAB 按用户裁定显隐，第十五批）→ `bf8a6ba`（iframe sandbox 补 `allow-modals`，第十六批）；**最终真实 Electron 门禁 = 52 PASS / 0 FAIL / 52（exit 0，被测 commit `4dfe923`，工作树干净）**，证据 `artifacts/d5-02/d5-02-canvas-e2e.json`（sha256 `33f9de1774a204fe855c00d9ab19e3c56dc2f44be5a05fc783abdbe324e8a1a9`，本批 `shasum -a 256` 复核；比上一版新增 **F3g** 回收站 FAB 显隐四态与 **F3h** 卡片菜单真实产品路径）。
功能 / 视觉 / 动效均已取得实测证据（见 §5.1 的 G5 / G6 / G7）；**（第十七批定稿 · 2026-09-24）判定 = PASS（限定范围）**：功能 = 通过（**最终门禁 52/52、exit 0、`notVerified: []`、Z1 clean（被测 commit `4dfe923`）**，含保存冲突 F3e 与 MS §6 F3f；**第十五批新增 F3g** —— 回收站 FAB 显隐四态（本文件 `99 增 / 0 删`，逐字抽段台架 PASS）；**第十六批新增 F3h** —— 卡片菜单真实产品路径（本文件 `102 增 / 0 删`，逐字抽段台架 PASS），并修掉宿主 sandbox 忽略 `confirm` / `prompt` / `alert` 的缺口；**52 项计数已在主线重跑门禁中落定**）；视觉 = 对照已完成、可比项**一致**（**含右下角回收站 FAB**：按用户裁定实现「空 ⇒ 隐藏，非空 ⇒ 显示」并重截，空态同窗口逐像素 mean|diff| 0.62/255、max 10、>24 占 0.00%），数据项与条件项未验收（如实登记，不再阻塞），**不整体宣布"视觉通过"**（§5.2）；动效 = 本轮改动通过、**MS §6 已实现并验证**；第十五批的 FAB 显隐不引入新动效。逐项记录见 `PROGRESS.md` 末尾同名小节；tracked 证据 `docs/D5-02-SCOPE-CORRECTION-EVIDENCE.json`（**52 条 checks，已按最终 artifact 重生成**）。**关闭条件①（用户对回收站 FAB 的裁定）已满足并关闭。**

**基线 `bf82c5c`（开工核对：完整 HEAD 一致、工作树干净）**；分支 `feature/d4-03-tool-proxy`；
唯一工作区 `/Users/wepingli/Desktop/OpenArc OS-d4-01`。未 push、未合并 main、未触碰其他工作区或实例、未进入 D5-03。

上游源：`https://github.com/invaders-2/NOVAI-Infinite-Canvas` @ `6ce1a64680b669b31c2ac3b32418b54decd404f2`（vendor 脚本每次核对）。

## 1. 交付形态：入口就是原版应用（已被 2026-09-24 范围修正取代：入口改为无限画布首页）

`openarc-canvas://bundle/index.html` = **上游原版 `static/index.html`（AI Studio 外壳：首页 + 左侧导航 + 子页 iframe）**。
整棵 `static/`（103 个文件 / 14 个页面，13.8 MB）原样 vendor 到 `public/novai-canvas/static/**`，
**不做 `/static/` 路径改写**（自定义协议 `standard:true`，根绝对路径自然解析到 bundle 根），
只做三处脚本化注入（CSP + 宿主桥、入口中继、画布适配层）。重新生成：
`OA_NOVAI_SRC=/tmp/novai-canvas-src node experiments/d5-02/vendor-novai-app.mjs`。
改动与差异的全部记录见 `public/novai-canvas/SOURCE.md`；注入清单/哈希见 `experiments/d5-02/vendor/vendor-manifest.json`。

OpenArc 只在最外层加一条窗口条：当前项目/revision、画布选择、新建/回首页、只读标记、模型来源、
"更新/下载：已禁用"标记、提示区与"已拦截导航出网 N 次"。

第一阶段的"能运行的原版首页与导航"截图（本任务窗口，非单图代替）：
`artifacts/d5-02/d5-02-app-home.png`（首页）、`d5-02-app-canvas.png`（编辑器 + 节点）、
`d5-02-app-reopen.png`（返回首页后再打开同一本）、`d5-02-app-ai-approval.png` / `d5-02-app-ai-stale.png`（AI 链诊断）。

## 2. 页面 / 功能 / 产品证据 / 缺项（逐项 · 完整应用外壳形态，已被 2026-09-24 范围修正取代）

| 页面 | 状态 | 核心操作是否真的可用（不是"打开就 501"） | 证据 |
| --- | --- | --- | --- |
| `index.html`（应用外壳：首页 + 侧栏 + 状态栏） | **已接入** | 侧栏 5 个入口逐项切换、子页真的加载（contentDocument 就绪）；`/api/app-info`、`/api/queue_status` 由宿主回答（队列数 = OpenArc 运行中任务数） | A1/A2/B6 |
| `home.html`（首页） | **已接入** | 最近画布来自 OpenArc 存储；「新建项目」建库并进入画布；点最近项目回到那一本 | A1/A3/A6/A7 |
| `canvas-list.html`（画布管理器） | **已接入** | 列表来自 OpenArc；新建/重命名/删除/恢复/清空回收站；卡片位置会话内记忆 | A2/F3b（由首页卡片进入） |
| `canvas-list.html` 卡片菜单（复制 / 删除 / 重命名 / 错误提示） | **已接入（删除 / 复制 / alert 真可用；重命名只到对话框弹出）** | 宿主 iframe sandbox 补 `allow-modals`（`bf8a6ba`）后 confirm / prompt / alert 真弹出：删除 ⇒ 真进回收站 + FAB 出现且角标 = 回收站长度；复制 ⇒ 真出副本；服务端失败 ⇒ `alert('删除失败')` 真的弹出；**重命名只到 prompt 对话框弹出**（Electron 本身不支持 `prompt()`，见 §7 第 9 条） | F3h |
| 首页右下角回收站 FAB 显隐 | **已接入（用户裁定）** | 回收站为空 ⇒ 隐藏（`hidden` + computed `display:none` + 不占布局 + 命中落空 + 角标不显示）；有已删除画布 ⇒ 显示且角标 = 回收站列表长度、命中落在 FAB 内；恢复 / 清空后回到隐藏 | F3g |
| `canvas.html`（无限画布编辑器） | **已接入** | 增删改移/连线命令层、撤销/重做、自动保存、关闭重开恢复、文本与图片真实模型链、任务级预算/停止/迟到保护 | A3–A7/B1–B4/D1–D5/F1 |
| `online / zimage / enhance / klein / angle / gpt-chat`（生图与对话页） | **保留入口，未接入** | 页面可达；`/api/generate`、`/api/history`、`/api/online-image`、`/api/chat/stream` 等在桥里明确返回 501 `OPENARC_UNSUPPORTED`，窗口条一次性提示"该功能未接入 OpenArc（保留入口）" | A2/B5 |
| `asset-manager.html` / `api-settings.html` / `comfyui-settings.html` | **保留入口，未接入** | 同上（素材库 / 提示词库 / ComfyUI 端点 501） | A2 |
| `smart-canvas.html`（智能画布 Agent） | **保留入口，未接入** | 上游页面与入口都在；agent/工作流端点 501 | A2 |
| `/ws/stats` 实时状态通道 | **明确不可用** | WebSocket 替身立刻触发 `onerror/onclose`（不假装已连接），状态栏改用宿主 `/api/queue_status` | B6 |
| 桌面更新器（`/api/check-update`、`/api/update-*`、GitHub/Gitee/ModelScope 直连） | **禁用** | 501 `OPENARC_UPDATE_DISABLED` + 界面"更新/下载：已禁用" + 出网接收端 0 命中 | B6/E5 |
| pywebview 11 个宿主方法 | **明确不可用** | 不定义 `window.pywebview`（页面自动走网页版分支，桌面标题栏与退出入口自行隐藏）；读取即计数 + console 记录；不提供退出 OpenArc / 任意文件路径 / 任意宿主方法转发 | 页面分支 + E1 |

## 3. 五项既有缺口（结论已按 2026-09-24 范围修正更新）

> 2026-09-24 真实 Electron 门禁 **52 PASS / 0 FAIL / 52**（exit 0，比上轮新增 F3e / F3f / **F3g** / **F3h**，`notVerified: []`；被测 commit `4dfe923`，工作树干净）；五项缺口全部闭合。

| # | 缺口 | 结论（2026-09-24） | 证据 |
| --- | --- | --- | --- |
| 1 | 任务模型绑定（不静默换模型） | **闭合**：指定配置被停用 / 能力不符 / 不存在 → 明确拒绝且 provider 0 新增请求 | F1 PASS |
| 2 | D1 撤权路径 | **闭合**：撤销 → 明确拒绝 + 0 请求；页面模型区真的变不可用；恢复授权回到可用 | D1 / N5a PASS + `tests/governance-app-model-grant.test.mjs` 4/4 |
| 3 | 图片资源产品链 | **闭合**（F3b 由 `9aabefe` 修复） | F3a / F3b / F3c PASS |
| 4 | AI 编辑正式链 | **闭合**（F4 由 `527176e` 修复）：提议 → 审批 → 授权执行 → 呈现 → 保存重开仍在（旧 revision 不覆盖用户内容） | F4b / F4 PASS + `tests/d5-02-canvas-edit-proposal.test.mjs` 4/4 |
| 5 | 宿主隔离与导航出网 | **闭合** | E1–E8 PASS（含被拦自我导航后立即整帧复位） |

### 3.1 历史记录（完整应用外壳形态 · 2026-09-20；结论已被 2026-09-24 范围修正取代）

> 原表中缺口 3（F3b FAIL）与缺口 4（未闭合）的结论已被取代：F3b 由 `9aabefe` 修复、F4 由 `527176e` 修复，2026-09-24 门禁 F3a / F3b / F3c / F4b / F4 全 PASS。

| # | 缺口 | 结论（原记录） | 证据 |
| --- | --- | --- | --- |
| 1 | 任务模型绑定（不静默换模型） | **闭合**：指定配置被停用 / 能力不符 / 不存在 → 明确拒绝且 provider 0 新增请求 | F1 PASS |
| 2 | D1 撤权路径 | **闭合**：根因是 `getAppAccess` 的动作投影只认 `resource.*`，画布的 `model.*` 授予被投影成 `actions: []`（DB 行一直在），撤销拿不到句柄、恢复也是空操作；修复后撤销 → `canvas/run` = PROXY_UNAUTHORIZED 且 0 请求，重新授予恢复 | D1 PASS + `tests/governance-app-model-grant.test.mjs` 4/4 |
| 3 | 图片资源产品链 | **部分闭合**：导入只写 `openarc-asset:<ref>`（F3a PASS）；资源删除后当场失效缓存 + 提示 + 重开不复活（F3c PASS）；**重开后重新解析成 data URL 仍失败**（F3b FAIL，画布页保留 ref 显示不可用 —— 明确不是拿旧缓存顶替）。过程中修掉两个真实缺陷：`importAsset` 把注入的 tempDir 字符串当函数调用（导入必然 INTERNAL_ERROR）；`readAsset/assetStates` 只查应用 grant（已改为"应用授权 OR 资源属于本人"）。F3b 的残余失败说明**还有第二处授权/解析口径**在挡（下一步见 §7） | F3a/F3c PASS；F3b FAIL |
| 4 | AI 编辑正式链 | **未闭合**：`canvas.edit` 已进入 Harness 广播面（`dsh-tool-profile.cjs`）且模型**真的提议** `canvas_edit`（provider 侧 `toolCalls=["canvas_edit"]`），但 Harness → Tool Facade 的派发没有产生任何 proposal：`side_effect_calls[canvas.edit]=0`、`tool_executions=0`、无审批面板、任务以 `end_turn` 结束且只有 1 个 reasoning 步骤。同一网关链用 `resource.trash` 对照全链 PASS（提议→审批→批准→受监督执行→SUCCEEDED/PASS），故缺环定位在**画布工具的派发这一跳**，不在网关/审批/执行 | F4 FAIL + `artifacts/d5-02/agent-canvas-probe.json`（6 PASS / 3 FAIL） |
| 5 | 宿主隔离与导航出网 | **闭合**：无桥/Node/IPC、端点白名单、协议白名单、当前实例校验、后端不信自报身份、出网与自我导航 0 命中且被拦后应用仍可用、账号边界（帧销毁 + 存储分桶） | E1–E8 全 PASS |

## 4. 桥与同源兼容（安全不变式；完整应用外壳形态的中继描述，已被 2026-09-24 范围修正取代）

> 2026-09-24 后入口只有「画布首页 / 编辑器」这一个应用帧，没有外壳中继与子页；安全不变式（无桥 / 端点与协议白名单 / 当前实例 token / 出网 0 命中 / 账号分桶）仍成立，E1–E8 已按新形态重跑全 PASS。以下中继细节为原完整应用形态的记录。

* 应用页面在 `sandbox="allow-scripts allow-same-origin allow-modals"` 的 iframe 里（上游跨页交互严重依赖同源：
  外壳丢弃非同源消息、`BroadcastChannel('studio-api')`、跨页 localStorage、`theme.js` 的 `window.self !== window.top`）。
  bundle origin = `openarc-canvas://bundle`，与 OpenArc 外壳（`file://`）**不同源** → 页面拿不到 `window.openarc` / IPC / fs / 凭据（E1）。`allow-modals`（第十六批补，`src/canvas/CanvasHost.tsx:721`）只放行 `alert` / `confirm` / `prompt` / `print` 这类模态对话（上游首页卡片菜单的删除 / 重命名 / 复制与所有错误提示要用；缺它时 Chromium 直接忽略），**不新增**文件系统 / 网络 / origin / 脚本执行 / 跨源能力 —— 实例 token 校验、CSP、只读闸一字未动。
* 宿主**只接受当前外壳实例**：`event.source` 必须是本帧 + 每次挂载的随机 token；子页调用由外壳中继附加 token，
  子页自己拿不到 token；其他 iframe / 外壳自发的伪造调用一律不执行（E4）。
* 子页 → 外壳 → 宿主是**逐项限定的中继协议**（`call/command/undo/redo/state-request/reload-doc/notice/alive`，
  回包按 `f<帧号>:<子页 id>` 路由回去）；非本页 iframe、已卸载帧、身份不符的消息直接丢弃。
* 端点白名单之外一律 501；更新/下载端点即使被页面直连也 501；CSP `connect-src openarc-canvas:`（只放行本 bundle 的只读协议，
  http/https/ws 全拒）、`img/media/font` 只允许 bundle 与 data:/blob:、`form-action none`、`object-src none`、`base-uri none`。
* 出网五通道 + `window.open` + **iframe 自我导航**：本地接收端 **0 命中**，主进程 `will-navigate`/`will-frame-navigate` 留痕（E5/E5b/E6）。
* 账号边界：真实同源存储按 `oa:<本次挂载钥匙>:` 前缀分桶，换挂载整片清除（页面内自证：0 个外账号键）；
  切账号后旧应用帧全部销毁（E7）；B 看不到也打不开 A 的私有画布。
* token 不替代后端判定：身份 / 资源权限 / 版本 / 任务状态一律由主进程按会话重判（E3 + 服务层既有实现）。

## 5. 门禁与证据

### 5.1 2026-09-24 范围修正后（最新口径）

| # | 命令 | 结果 |
| --- | --- | --- |
| G0 | `npm run build` | exit 0（`tsc --noEmit` + `vite build`） |
| G1 | `OPENARC_TESTED_COMMIT=$(git rev-parse HEAD) node experiments/d5-02/canvas-e2e.mjs`（真实 Electron；被测 commit `4dfe923`，工作树干净） | **52 PASS / 0 FAIL / 52，exit 0**（比上轮新增 **F3e** 保存冲突双向保留、**F3f** MS §6 标记 + 160ms 淡入、**F3g** 回收站 FAB 显隐四态、**F3h** 卡片菜单真实产品路径）；`notVerified: []`；Z1 = clean；日志尾行 `结论：PASS — {"pass":52,"fail":0,"total":52,"notVerified":0}` |
| G2 | `node --test tests/d5-02-canvas-*.test.mjs tests/d5-02-model-list-authorization.test.mjs`（整套 d5-02，本批复跑） | **45 pass / 0 fail**（比上轮新增 `tests/d5-02-canvas-merge.test.mjs` **12/12**、`tests/d5-02-canvas-ai-marks.test.mjs` **11/11**；旧的 22/22 是其中 4 个文件的口径） |
| G3 | `tests/governance-app-model-grant.test.mjs`；`tests/model-*.test.mjs`（8 个文件） | **4/4**；**59/59**（文档岗复跑核对，取代旧的 60/60 口径） |
| G4 | 两条预存在失败（干净 HEAD 导出树同样复现） | `tests/side-effect-c4-gates.test.mjs:474`、`tests/d4-03-approval-push-isolation.test.mjs:103`；与本轮改动无关，登记为既有缺口 |
| G5 | 视觉核对（`artifacts/d5-02/visual/`：25 张截图 + 3 份 manifest + `visual-checks.md` + `computed-styles*.json` + `pixel-samples.json`） | 我们新增 / 改动元素 **通过**（12/18、说明行对比 18.16/19.05、chip 4.50–4.65、焦点环 2px+2px、`var(--radius-md,8px)`、省略 + `title`）；上游原版外观按用户指令保留 |
| G6 | 动效核对（`artifacts/d5-02/motion/`：8 段 1824 帧 PNG + `motion-summary.md` + `motion-report.json` + `ai-node-report.json`） | 本轮改动 **通过**（c1 95ms / 约 190ms；c2 约 190ms + 上游 fadeUp 0.7s；c3 160–210ms；c4 0ms；c5 无反馈）；**MS §6 = 已实现并验证**（`4525ab8`：160ms `cubic-bezier(.2,0,0,1)` 淡入 + 中性「AI」标记 + 减少动态效果立即呈现；门禁 F3f + `tests/d5-02-canvas-ai-marks.test.mjs` 11/11） |
| G7 | 首页视觉基准对照（第十一批对照 / 第十五批收口；`artifacts/d5-02/visual-baseline/`：12 张 PNG + FAB 证据图 + `manifest.json`（含 `fabFix` 段）） | 基准已落盘（sha256 `557ce43d…`，2238x1654 = 1119x827 @dpr2，浅色）+ 真实 Electron 元素级截图：结构 / 尺寸 / 字体层级 / 按钮主次 / 网格列数 / 徽标 / 圆点 / 主题 / dpr / 缩放 / 背景 **一致**（多数量到 0px 差）；**右下角回收站 FAB 第十五批按用户裁定实现并重截后判「一致」**（空 ⇒ 隐藏、非空 ⇒ 显示；空态 FAB 窗口逐像素 mean\|diff\| 0.62/255、max 10、>24 占 0.00%）；整幅平移 (2.0, 9.0)px、布局视口宽 2px、真实窗口可达内容区 1119x758、画布数量 13 vs 5 与卡片数据 **未验收**（如实登记，不再阻塞）；**不整体通过**（§5.2） |
| G8 | 第十六批（`allow-modals`）：`npm run build` = **exit 0**；`node --test tests/d5-02-canvas-*.test.mjs tests/d5-02-model-list-authorization.test.mjs` = **45 pass / 0 fail**（6 文件逐个复跑）；真机前后对照探针 `experiments/d5-02/card-menu-modals-probe.mjs --phase=pre|post`（证据 `artifacts/d5-02/modals/{pre,post}-evidence.json` + 截图）；新增 **F3h** 逐字抽出的单独台架真机 **PASS**（A0×2 + F3h，exit 0）；E1 / E4 / E5 轻量复验通过（同台架） | 见 §7 第 9 条；**完整门禁 = 52 / 52、exit 0（第十七批定稿，见 G1）** |

证据：`artifacts/d5-02/d5-02-canvas-e2e.json`（sha256 `33f9de1774a204fe855c00d9ab19e3c56dc2f44be5a05fc783abdbe324e8a1a9`，本批 `shasum -a 256` 复核）+ 同名 `.log`（尾行 `结论：PASS — {"pass":52,"fail":0,"total":52,"notVerified":0}` / `GATE_EXIT=0`）+ `d5-02-app-*.png`；tracked 证据 `docs/D5-02-SCOPE-CORRECTION-EVIDENCE.json`（**52 条 checks**，已按最终 artifact 重生成，含 F3g / F3h）；视觉 / 动效证据见 G5 / G6；首页基准对照证据见 G7 / §5.2。

### 5.2 首页视觉基准对照（第十一批对照 · 第十五批 FAB 收口 · 2026-09-24）

> 本节是**更正**：此前记录的"与用户截图对照 = 未验收（当时基准图不在本工作区）"已不成立 —— 用户首页基准图已由主线落盘本工作区（见下），本批按同一条件重截我们的首页并逐项对照。**判定不整体通过**：能比的项判「一致」，数据性与条件性差异判「未验收」；**（第十五批）右下角回收站 FAB 已按用户裁定实现、四态实测并在"回收站为空"的条件下重截 → 这一项从「不一致（版本差异）」改判「一致」，本节不再有不一致项。**

**基准（不再缺失）**

| 项 | 值 |
| --- | --- |
| 原始来源（Codex 剪贴板临时文件，仍存在） | `/var/folders/49/m7hfshm96vl9xkmkpjrygqqc0000gn/T/codex-clipboard-48126615-7162-4f0d-b262-6ee0d399e5d8.png` |
| 工作副本 | `artifacts/d5-02/baseline/user-home-baseline.png`（gitignored） |
| tracked 副本 | `docs/snapshots/2026-09-24-user-home-baseline.png` |
| sha256（三处相同） | `557ce43d865a1a08cd883daf116eea1ef54793dac7438d916753dddaae80d127` |
| 尺寸 | 2238x1654 像素 = **1119x827 逻辑 @dpr2**；浅色主题 |
| 复制留档时间 | 2026-09-24 15:43:13 |

**我们的取图条件**（真实 Electron + 隔离 userData + CDP + 三步初始化向导）：目标 = **画布应用窗口内容区**（宿主 iframe 元素本身；不含宿主窗口标题栏与桌面），Playwright 元素级截图；浅色、dpr2、缩放 100%（页面 `data-studio-scale="off"`，ui-scaled 未加、body transform none、html zoom 1）、宿主默认玻璃（`--content-alpha .94` / `--surface-alpha .68` / blur(34px) saturate(1.8)）、`scrollY=0`、轮播固定第 1 张（点圆点，activeSlide=0，与基准同一份 `carousel-image-generation.jpg`）。**第十五批在同一条件下重截**（隔离 userData 只播 5 本画布、**不删任何一本 ⇒ 回收站为空**，与基准"右下角没有 FAB"可比），覆盖旧产物并重跑对照管线；FAB 判定窗口改用 FAB 自己的真实 DOM rect `(1039,747,48,48)`（旧口径区域里混着第三列卡片的深色角标）。

尺寸口径：Electron 未实现 Browser.getWindowForTarget，OS 窗口改不动；物理口径上限 **1119x758**（宿主窗口固定 1440x940，`electron/window-manager.cjs` 的 resize 把 h 夹到 `host.h-100-y`）。827 高由 CDP `Emulation.setDeviceMetricsOverride(width=tw, height=th+82, deviceScaleFactor=2)` + 页面内画布窗口最大化达到（dpr 仍 2）；两条口径都留产物。

**产物**（`artifacts/d5-02/visual-baseline/`，gitignored）：`home-firstscreen-1119x827@2x.png`（2238x1654，与基准同像素尺寸，判定主图；**第十五批在回收站为空的条件重截**）、`home-firstscreen-1152x827@2x.png`（2304x1654，按基准版面反推的布局视口宽）、`home-firstscreen-1119x758@2x-physical.png`（真实夹取上限旁证）、`home-cards-*.png`、`host-window-context-*.png`（含窗口条，仅留证）、`side-by-side-firstscreen-1152.png` / `-1119.png` / `side-by-side-cards-1152.png`、`baseline-home.png` / `baseline-home-cards.png`、`manifest.json`（每张图的 inner/outer 尺寸、dpr、缩放、主题、背景与透明度、滚动位置、画布数量、时间 + 条件对照 + 逐项判定 + 位移证据 + 像素差；**第十五批新增 `fabFix` 段**）。**FAB 专项证据（第十五批）**：`fab-state-1-empty.png` / `fab-state-2-deleted.png` / `fab-state-3-restored.png` / `fab-state-3-overlay-open.png`（回收站面板打开、列表长度可见）/ `fab-state-4-cleared.png`（四态截图，条件同基准：内容区 1119x827、dpr2、浅色、`scrollY=0`、轮播第 1 张）、`side-by-side-fab-region.png`（FAB 窗口 `(1039,747)-(1087,795)` 3 倍放大：基准 / 我们空回收站 / 四态）。

**逐项对照（判定只用三档；"一致"仅限条件可比项）**

| 项目 | 基准 | 我们 | 判定 |
| --- | --- | --- | --- |
| 图幅 / 逻辑尺寸 | 2238x1654 = 1119x827 | 2238x1654 = 1119x827 | 一致 |
| 主题 / dpr / 缩放 | 浅色 #f5f5f7 / 2 / 100% | 同 | 一致 |
| 背景 / 玻璃透明度 | 页面自身不透明底 | 同（宿主玻璃在页面之下，不影响内容区像素） | 一致 |
| 页面内容宽与居中 | 960 居中 | 960 居中 | 一致 |
| 标题「无限画布」 | ink 189.5x44.5 | ink 189.5x44.5（48px/400/.02em） | 一致 |
| 说明两行 | 行距 24、ink 高 39 | 同 | 一致 |
| 主按钮「＋ 开始创作」 | 144.5x51 实心黑 | 144.5x51 实心黑 | 一致 |
| 次按钮「继续上次」 | 白底 + 时钟图标 | 同（146.6x51） | 一致 |
| hero 轮播块 | 450x298（CSS 452x300） | 450x298 | 一致 |
| hero 图与信息条 | 第 1 张 jpg +「文生图创作 / 输入提示词…」ink 399x32 + 右侧「图像生成」 | 同一份 jpg、同文字同尺寸 | 一致 |
| 轮播圆点 | 3 个（active 药丸 24x8 + 2 点） | 3 个（同） | 一致（用户口述"4 个"与图不符，按图判 3 个） |
| 「所有画布 · N 个」 | 「所有画布 · 13 个」ink 86.5x10 | 「所有画布 · 5 个」ink 81.5x10 | **未验收**（数据不同；字阶 / 位置一致） |
| 「＋ 新建画布」 | 116.5x39.5 | 116.5x39.5 | 一致 |
| 卡片网格列数 / 列宽 / 间距 | 3 列 x 312、gap 12 | 3 列 x 312、gap 12（列距 324 同） | 一致 |
| 卡片预览区结构 / 徽标「智能」 | 高 140、2x2、16:10 / 40.5x21 | 同 / 同 | 一致 |
| 卡片缩略图 / 标题 / 时间戳内容 | 用户 13 本真实画布（有缩略图） | 隔离 userData 播的 5 本「智能画布 HH:MM」（缩略图空占位） | **未验收**（数据不同；字号 / 字重 / 颜色一致） |
| 第二行被裁切构图 | 有 | 有 | 一致 |
| 右下角回收站 FAB（判定窗口 = FAB 自己的真实 DOM rect (1039,747)-(1087,795)） | **没有**（该窗口最暗 237、非背景 5.16%、darkPct 0） | **没有**（同窗口最暗 244、非背景 0.00%、darkPct 0 —— 回收站为空 ⇒ 真实隐藏；非空态该窗口非背景 90.68%、darkPct 5.16%、最暗 76） | **一致** —— 第十五批按用户裁定实现「空 ⇒ 隐藏，非空 ⇒ 显示」并重截：同窗口逐像素 mean\|diff\| 0.62/255、max 10、>24 占 0.00%；四态实测与门禁 F3g 见 §7 第 1 条。旧口径区域里那个「最暗 22」是第三列卡片的深色角标、不是 FAB |
| 整幅绝对位置 | 内容在 (0,0) | 整体右移 2.0px、下移 9.0px | **未验收**（差 2.0 / 9.0px） |
| 布局视口宽（页面左边缘反推） | `~1156（页面左 98）~` | 1119（页面左 79.5）/ 1152（页面左 96） | **未验收**（差 2px） |
| 真实窗口可达内容区 | —— | 1119x758 | **未验收**（高差 69px；827 靠 CDP 视口模拟） |

**位移证据（"差的只是平移，不是布局"）**：内部相对距离逐项相同 —— 轮播顶→主按钮顶 195.0/195.0；轮播顶→「所有画布」顶 377.5/377.5；轮播顶→「新建画布」顶 363.0/363.0；轮播顶→卡片标题顶 601.5/601.5；标题 ink 顶→轮播顶 −55.5/−55.5；按钮 144.5x51、新建按钮 116.5x39.5、列宽 312、列距 324 全为 0 差。基准图内白字 bbox 差恰好 (2.0, 9.0)px；位移补偿后 hero 图区域 mean|diff| 6.59/255（>24 占 2.51%），不补偿 17.63。结论：**布局与基准一致，整幅只差一个 (2.0, 9.0)px 平移**；基准侧更像"内容被上移 9px（滚动或被裁切）+ 视口宽约多 4px"。

**发现的产品缺陷（第十五批收口）**：本批（第十一批对照）没有引入布局缺陷 —— 基准与我们在同一份上游文件下的内部布局逐项 0 差；差异来自条件（基准侧 9px 平移 / 视口宽、宿主窗口尺寸与 resize 夹取）。当时登记的唯一"不一致"是**右下角回收站 FAB**：上游 `static/canvas-list.html` 的 `.trash-fab` 是无显隐逻辑的静态元素（只有角标按删除数显隐），回收站为空时也挂着按钮。**用户已裁定「回收站为空时隐藏，有已删除画布时显示」，第十五批已实现并验证**（vendor 幂等补丁 4 处，与角标同一个 `v4DeletedCanvases.length`；真实 Electron 四态实测：空 ⇒ `hidden` + `display:none` + 不占布局 + 命中落空；真删一本 ⇒ 显示 + 角标 = 回收站列表长度 + 仍在右下角 + 命中落在 FAB 内；恢复 / 清空 ⇒ 回到隐藏），并**在回收站为空的条件下重截首页**：FAB 窗口（(1039,747)-(1087,795)，取真实 DOM rect）与基准逐像素 mean|diff| 0.62/255、max 10、>24 占 0.00% → 判定 **一致**。9px 平移与 2px 视口宽不需要改代码（条件项，如实登记）。**第十六批修复**：宿主 iframe 的 sandbox 补上 `allow-modals`（`src/canvas/CanvasHost.tsx:721`，工作树 HEAD `8cbab9b`）——「删除 / 复制画布 / alert 错误提示」三条入口经真机验证已可用（删除 ⇒ 真进回收站 + FAB 出现；复制 ⇒ 真出副本；服务端失败 ⇒ `alert('删除失败')` 真的弹出），详见 §7 第 9 条与 §5.1 的 G8。**未闭合**：见 §7。

### 5.3 历史记录（完整应用外壳形态 · 2026-09-20；**已被 2026-09-24 范围修正取代**）

| # | 命令 | 结果（原记录） |
| --- | --- | --- |
| G0 | `npm run build` | 通过（tsc --noEmit + vite build） |
| G1 | `node --test tests/governance-app-model-grant.test.mjs` | 4 PASS / 0 FAIL |
| G2 | `node experiments/d5-02/canvas-e2e.mjs`（真实 electron . + 真实产品 UI + 本地确定性 provider） | **33 PASS / 2 FAIL / 35**；`artifacts/d5-02/d5-02-canvas-e2e.json` |
| G3 | `node experiments/d5-02/agent-canvas-probe.mjs`（AI 编辑链专项探针） | 6 PASS / 3 FAIL（画布链未取得；对照链 PASS） |
| G4 | 既有相关用例（governance / authorization / model / d5-02 canvas 单测） | 164 PASS / 0 FAIL |

FAIL 明细：F3b（图片资源重开解析）、F4（AI 编辑链缺环）。

**干净树复跑**：`git rev-parse HEAD` = `6bca089`（工作树干净，`OPENARC_TESTED_COMMIT=6bca089`）复跑同一门禁 → **33 PASS / 2 FAIL / 35**，与提交前一致（同一失败项 F3b/F4）。门禁按"页面/功能/产品证据/缺项"逐项断言，未删断言、未放宽口径。

## 6. 本轮修掉的真实缺陷（都是门禁逼出来的）

1. `electron/canvas-service.cjs` `importAsset`：注入的 `tempDir` 是字符串却被当函数调用 → 任何图片导入都 `INTERNAL_ERROR`。
2. `electron/canvas-service.cjs` `readAsset/assetStates`：只查 canvas 应用对资源的 grant，用户**自己导入**的图重开画布即不可用 →
   改为"应用授权 OR 资源属于当前用户本人"（与画布 OWNER_POLICY 同一口径）。
3. `electron/governance-service.cjs` / `authorization-service.cjs`：app 授权投影只认 `resource.*`，`model.*` 授予被投影成空动作
   （D1 撤权路径失效的根因）。
4. `electron/dsh-tool-profile.cjs`：`canvas.read`/`canvas.edit` 不在 Harness 广播面（加入后模型才能看到并提议画布工具）。
5. 桥：同源 bundle 资源被 fetch 覆盖层误伤成 501；上传依赖 FormData 过 postMessage（改为页面内读 data URL 再交宿主）。
6. **保存竞争（关闭条件③，`4525ab8` 修复）：页面 500ms 待保存窗口内的本地编辑撞上宿主 / AI 改动被静默覆盖。** 上游 409 分支"换新基线 → 重发旧文档"会覆盖对方；改为**三方合并**（base = 最后一次成功同步 / local / remote），按 node / edge id 合并、字段互不重叠各自保留、**同一字段两边都改 → 本地留原位 + 远端复制为 `<id>-remote`**（`oaConflictCopyOf` 标记 + 并排偏移）+ 中性可恢复提示；只重发合并结果、**最多 2 次**，达上限明确呈现"无法自动合并，双方内容都已保留"并停止（**不盲重试 409、debounce 一字未动**）。真机前后对照：修复前宿主改动在页面与存储双双消失、同字段冲突无副本；修复后两边都在且重开仍在；回归：自动保存 / saveNow / 撤销重做 / 重开 / 旧 revision PUT→409 不覆盖 / 只读闸 全通过。宿主侧两处：base 按存储当前事实对齐（`src/canvas/CanvasHost.tsx:381-395`）、冲突回包按 `canvas.get` 口径解析资源引用（`:408`）。新增单测 `tests/d5-02-canvas-merge.test.mjs` **12/12**；门禁 F3e。
7. **MOTION_SYSTEM §6（关闭条件②，`4525ab8` 实现）：「AI 新增节点 160ms 淡入 + 来源标记」之前未实现。** 以命令账本为唯一真源（`actorKind=AGENT` + `outcome=APPLIED`，**不是**"远端同步=AI"的猜测口径）：命中节点 **160ms `cubic-bezier(.2,0,0,1)` 淡入一次**（整层重建不重播）+ 中性「AI」标记（12/18、字重 500、`#737373`、`border-width 0`、`--radius-sm 6px`、`pointer-events:none`、不挡节点按钮、节点尺寸不变）；减少动态效果下 `animation:none`、opacity 立即 1。真机实测（F3f）：11ms 采样 0 → 8 个中间帧 → 187ms 到 1（同期另一组采样 161ms ≈0.999 / 177ms = 1），与解析曲线拟合整体时移 **2ms**、最大偏差 **0.0068**；三类反证（页面手工新增 / 宿主 USER / 用户新增被 AI 改过）全部无标记无动画；重开从账本重新推导保留标记；去重（每节点最多 1 个徽标、不重播）。**已知边界**：账本只记命令本身 → `node.copy` / 不带 id 的 AI 新增不猜不标记；marks 只取最近 200 条账本。新增单测 `tests/d5-02-canvas-ai-marks.test.mjs` **11/11**；门禁 F3f。

8. **首页右下角回收站 FAB 没有任何显隐逻辑（`a32c53d`，第十五批按用户裁定修掉）**：上游 `6ce1a64` 的 `.trash-fab` 是静态元素（只有角标按删除数显隐）—— 回收站为空时右下角照样挂着按钮，与用户基准图不一致，是第十一批视觉对照里**唯一待裁定的版本差异**。裁定 = **空 ⇒ 隐藏、非空 ⇒ 显示**。修法：**不新造第二套事实**，用上游 `updateTrashBadge()` 里已经存在的 `v4DeletedCanvases.length` 同时决定角标与 FAB（按钮加 `hidden` + 补 `.trash-fab[hidden]{display:none}` + DOM ref + `trashFab.hidden = count === 0`），全部写在 `experiments/d5-02/vendor-novai-app.mjs` 的 `LIST_PATCHES`（幂等、目标缺失即报错）、登记 `public/novai-canvas/SOURCE.md`。**真隐藏**：不占布局（0x0）、不进 tab 顺序、`elementFromPoint` 命中落空 —— 不是 CSS 遮挡。**真实 Electron 四态实测**（隔离 userData + CDP）：空 ⇒ `hidden` + `display:none` + 命中落空；真删一本 ⇒ 显示 + 角标 = 回收站列表长度 + 仍在右下角 + 命中落在 FAB 内；恢复 / 清空 ⇒ 回到隐藏。随后在**回收站为空**的条件下重截首页：FAB 窗口（FAB 自己的 DOM rect `(1039,747)-(1087,795)`）与基准逐像素 mean|diff| 0.62/255、max 10、>24 占 0.00% → 该项判定从「不一致（版本差异）」改为**一致**。门禁 **F3g**（只新增，本文件 99 增 / 0 删）。
9. **宿主 iframe sandbox 缺 `allow-modals` ⇒ 卡片菜单「删除 / 重命名 / 复制画布」与所有 `alert` 错误提示在宿主里点不动（`bf8a6ba`，第十六批修复）**：`src/canvas/CanvasHost.tsx:721` 的 sandbox 由 `allow-scripts allow-same-origin` 补为 `allow-scripts allow-same-origin allow-modals` —— 只放行 `alert` / `confirm` / `prompt` / `print` 这类模态对话，**不加**文件系统 / 网络 / origin / 脚本执行 / 跨源能力；应用帧仍与外壳（file://）不同源，实例 token 校验、CSP、只读闸**一字未动**。**修复前对照**（未改 dist，真机）：菜单点下去 0 个对话框事件 + 控制台 3 条 `Ignored call to 'prompt()' / 'confirm()'. The document is sandboxed, and the 'allow-modals' keyword is not set.`、回收站 0 条、FAB 保持隐藏。**修复后（同一台架）**：删除（confirm）⇒ 卡片消失 + 真进回收站（长度 1）+ FAB `hidden=false` + 角标 `1`；复制（confirm）⇒ 列表真的多出「… 副本」；服务端 404 ⇒ 上游 `alert('删除失败')` 真的弹出；重命名（prompt：消息 `重命名画布` + 默认值 = 画布名）对话框真的弹出；E1 / E4 / E5 轻量复验通过。**仍存在的宿主边界（与 sandbox 无关）**：Electron 本身不支持 `prompt()`（顶层页实测 `prompt() is not supported.`，sandbox 帧里返回 `null`）⇒ 重命名只到「对话框真的弹出」为止，要真可用需把上游 `prompt` 换成应用内模态（vendor 补丁 + 产品决定）。门禁只新增 **F3h**（本文件 102 增 / 0 删），F3g 与全部既有断言一行未改。

## 7. 未闭合 / 下一步

（2026-09-24 范围修正后最终口径 · 第十七批定稿）

1. **视觉对照里剩下的"未验收"项（按"条件无法完全匹配 → 未验收"如实登记，不再是阻塞项；§5.2）**：① **数据项** —— 画布数量 13 vs 5、「所有画布 · N 个」、卡片标题 / 缩略图 / 时间戳内容（隔离 userData 里是宿主 `canvas/create` 播的 5 本，需要真实数据才能比）；② **条件项** —— 整幅 (2.0, 9.0)px 平移、布局视口宽差 2px、真实窗口可达内容区 1119x758（宿主窗口固定 1440x940 + `electron/window-manager.cjs` 的 resize 夹取 maxH=host.h-100-y，827 高靠 CDP 视口模拟达到）；③ **原来的「1 项版本差异待用户裁定」（关闭条件①）已关闭** —— 用户裁定「回收站为空时隐藏右下角按钮，有已删除画布时显示」；第十五批已实现（vendor 幂等补丁 4 处，与角标同一个 `v4DeletedCanvases.length`）+ 真实 Electron 四态实测（空 ⇒ `hidden` + `display:none` + 不占布局 + 命中落空；真删一本 ⇒ 显示 + 角标 = 回收站列表长度 + 右下角 + 命中落在 FAB 内；恢复 / 清空 ⇒ 回到隐藏）+ 在空回收站条件下重截对照，判定从「不一致（版本差异）」改为**一致**（§5.2）。**关闭条件①已满足。**
2. **两条预存在失败测试继续单列、不改断言（关闭条件②）**：`tests/side-effect-c4-gates.test.mjs:474`、`tests/d4-03-approval-push-isolation.test.mjs:103`（干净 HEAD 导出树同样复现，与本轮无关）。
3. **既有 NOT VERIFIED 不变（关闭条件③）**：Windows / 多屏 / 高 DPI 等（逐条见 `docs/D5-02-SCOPE-CORRECTION-EVIDENCE.json` 的 `notVerified`）。
4. **F3d / F4-presented 依赖页面 2.5s 轮询与窗口前台状态**：被完全遮挡时 Chromium 会节流；F3d 已 `bringToFront` 兜住。
5. **其他 NOVAI 子页文件仍在 bundle 内但无入口不可达**（smart-canvas 亦不可达，未注入适配层 / 守卫）。
6. **视频 / ComfyUI / RunningHub 等保持「明确不可用」**，未接通链路未启用。
7. **MS §6 的已知边界（见 §6 第 7 条）**：账本只记命令本身 —— `node.copy` / 不带 id 的 AI 新增对不上号，不猜不标记；marks 只取最近 200 条账本。
8. **回收站 FAB 的更新时机与角标同源（如实登记，不是缺陷）**：FAB 显隐与角标都由 `updateTrashBadge()` 决定，随**页面自己**的回收站刷新时机更新（页面加载、删除后 `loadTrash()`、恢复、彻底删除、清空、拦到 trash 响应）；宿主侧绕过页面直接改回收站（当前产品没有这条用户路径）要等下一次页面自取才跟上 —— 与上游角标行为一致，本轮不加轮询。
9. **宿主 sandbox 忽略 `confirm()` / `prompt()` / `alert()` —— 第十六批已修复（见 §5.1 G8）**：`src/canvas/CanvasHost.tsx:721` 的 iframe sandbox 由 `allow-scripts allow-same-origin` 补为 `allow-scripts allow-same-origin allow-modals`（只放行模态对话；不新增 fs / 网络 / origin / 脚本执行 / 跨源能力；实例 token 校验、CSP、只读闸未动）。**修复前对照（未改 dist，真机）**：卡片菜单「删除 / 重命名 / 复制画布」点下去 0 个对话框事件、控制台 3 条 `Ignored call to 'prompt()' / 'confirm()'. The document is sandboxed, and the 'allow-modals' keyword is not set.`、回收站 0 条、FAB 保持隐藏。**修复后（同一台架）**：`confirm: 确定要删除画布「…」吗？此操作可在回收站撤销。` 弹出并 accept ⇒ 卡片消失、`/api/canvases/trash` 长度 1、FAB `hidden=false` + `display:flex` + 角标 `1`；`confirm: 确定要复制画布「…」吗？` ⇒ 列表真的多出「… 副本」；`prompt: 重命名画布`（默认值 = 画布名）真的弹出；服务端 404 时上游 `alert('删除失败')` 真的弹出；跑完用产品入口（FAB → 清空回收站 → 二次确认）清回 0 条 + FAB 隐藏。**仍存在的宿主边界（与 sandbox 无关，如实登记）**：Electron 本身不支持 `prompt()`（顶层页实测 `prompt() is not supported.`；sandbox 帧里返回 `null`，对话框事件能捕获但拿不到输入）⇒「重命名」入口只到「prompt 对话框真的弹出」为止，要让重命名真正可用需把上游 `prompt` 换成应用内模态（产品决定，本批未做）。门禁 F3g（命令层路径）逐字未动；新增 **F3h** 钉真实产品路径（卡片菜单删除 → 确认真弹出 → 真进回收站 + FAB 出现）。**第十七批最终门禁（被测 commit `4dfe923`，工作树干净）= 52 PASS / 0 FAIL / 52、exit 0、`notVerified: []`、Z1 clean**；artifact sha256 `33f9de1774a204fe855c00d9ab19e3c56dc2f44be5a05fc783abdbe324e8a1a9`（本批 `shasum -a 256` 复核）。

**判定：D5-02 = PASS（限定范围）。**（**第十七批定稿**：最终真实 Electron 门禁 = **52 PASS / 0 FAIL / 52、exit 0**（被测 commit `4dfe923`，工作树干净）、`notVerified: []`、Z1 clean、artifact sha256 `33f9de1774a204fe855c00d9ab19e3c56dc2f44be5a05fc783abdbe324e8a1a9`；比上一版新增 **F3g**（回收站 FAB 显隐四态）与 **F3h**（卡片菜单真实产品路径；宿主 iframe 补 `allow-modals` 后删除 / 复制 / alert 真可用，**重命名只到 prompt 对话框弹出**）。两条新断言都是**纯新增**（`a32c53d` 99 增 / 0 删、`bf8a6ba` 102 增 / 0 删），F3g 与全部既有断言一行未改。） 功能 = **通过**（**52/52、exit 0、`notVerified: []`、Z1 clean**；含保存冲突 F3e、MS §6 F3f、FAB F3g、卡片菜单 F3h）；视觉 = 对照已完成、可比项**一致**（含右下角回收站 FAB：空态同窗口逐像素 mean|diff| 0.62/255、max 10、>24 占 0.00%），数据项与条件项 **未验收**（如实登记，不再是阻塞项），**不整体宣布"视觉通过"**（§5.2）；动效 = 本轮改动 **通过**、**MS §6 已实现并验证**；**第十五批的 FAB 显隐不引入新动效**（显隐即时，上游 FAB 自带 hover / active 过渡原样沿用）。关闭条件（第十七批定稿）：① **用户对回收站 FAB 的裁定 —— 已满足并关闭**（实现 + 四态实测 + 重截判「一致」）；② 两条**预存在**失败测试（`tests/side-effect-c4-gates.test.mjs:474`、`tests/d4-03-approval-push-isolation.test.mjs:103`，已在干净 HEAD 导出树复现，与本轮无关）继续单列、不改断言；③ 既有 NOT VERIFIED（Windows / 多屏 / 高 DPI 等）不变；④ 已知边界如实登记不变：AI 标记只覆盖账本里带 id 的新增、marks 只取最近 200 条账本、视觉数据 / 条件项未验收、FAB 与角标同源（随页面自身的回收站刷新时机）；**「宿主 sandbox 忽略 `confirm` / `prompt` / `alert`」已在第十六批修掉**（sandbox 补 `allow-modals`，只放行模态对话；F3g 与全部既有断言一行未改，只新增 F3h），**`prompt` 的 Electron 宿主边界保留**（重命名入口只到「prompt 对话框真的弹出」为止，要真可用需把上游 prompt 换成应用内模态，属产品决定）。

### 7.1 历史记录（完整应用外壳形态 · 2026-09-20；已被 2026-09-24 范围修正取代）

**F3b 图片资源重开解析**：
* 已实测：import 落 `openarc-asset:<ref>` ✓；删除后 `canvas/readAsset` = ASSET_UNAVAILABLE、`assetStates` = UNAVAILABLE、当场缓存失效 + 重开不复活 ✓；
  **重开画布后同一个 ref 仍解析不出 data URL**（画布页保留 ref → 按不可用显示）。
* 下一步：`canvas/readAsset` 现在用的是"应用授权 OR 资源属于本人"，但 `resourceService.readDataUrl({context, resourceRef})` 内部还有一层按 appId 的授权
  （context 的 appId = `canvas`，导入时用的是 `resource-library`）。用只读探针把 `readAsset` 的中间返回（row 状态 / auth decision / readDataUrl 错误码）逐层打出来，
  定位后按"同一个用户自己的资源，画布特性经宿主读取"的口径收口（或让导入时显式记录一条 canvas 应用的资源读授权）。

**F4 AI 编辑链**（另一处未闭合的既有缺口）：

* 已实测的事实：`canvas.edit` 在广播面（`advertised` 含 `canvas_edit`）；provider 侧 `toolCalls=["canvas_edit"]`
  （模型真的提了）；`side_effect_calls[canvas.edit]=0`、`tool_executions(canvas.edit)=0`；审批面板从未出现；
  任务 `SUCCEEDED / end_turn`、只有 1 个 `reasoning` 步骤；对照 `resource.trash` 同样两条请求就能走到审批与执行。
* 下一步（按顺序）：
  1. 在 `electron/tool-facade-bridge.cjs` 的 HTTP 入口加一条**只读**诊断日志（tool 名 + 路由 + 响应码），
     用 `node experiments/d5-02/agent-canvas-probe.mjs` 复跑，确认 harness 是否真的发出了 `canvas_edit` 调用、
     以及桥是否拒了它（`403 NOT_ALLOWED` / `400 INVALID_ARGS` / 未到达）。
  2. 若属于 dsh 侧的路由/工具名匹配问题，对照 `canvas.edit` 合同（`riskClass=REVERSIBLE_WRITE`、`requiredPermissions=["tool.canvas.edit"]`、
     `executionProvider="CanvasControl"`）与 `resource.trash` 的差异逐字段核对；`executeApproved` 侧的 in-process 白名单已加入 `CanvasControl`。
  3. 修好后把 F4 的两段断言（正常链 + 旧 revision 对照）跑成 PASS；门禁 F4 已写好，无需改断言。

判定（历史，已被 2026-09-24 范围修正取代）：**D5-02 维持 PARTIAL** —— 完整应用必需流程已实际运行并通过（A/B/C/D/F1/F3/E 全绿），
但缺口 4 未取得"提议 → 审批 → 执行 → 呈现 → 保存恢复"的完整证据，按验收口径仍为 PARTIAL，不以单个编辑器通过代替整体通过。
