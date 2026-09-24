# D5-02 Full-App · 完整应用集成结果（NOVAI AI Studio）

## 范围修正（2026-09-24）

本文原记录的是「完整应用外壳」形态：入口 `openarc-canvas://bundle/index.html` = 上游 AI Studio 外壳（首页 + 左侧导航 + 子页 iframe），宿主最外层还有窗口条。**该形态已被用户 2026-09-24 的范围修正取代**：

* 入口 = 用户截图里的「无限画布」首页（`static/canvas-list.html`：开始创作 / 继续上次 / 画布卡片列表），点这些入口直接打开真实编辑器，不再有额外欢迎页或选画布遮挡层；
* 去掉 NOVAI 完整应用的左侧导航与其他子页面入口，以及 OpenArc 画布宿主顶部操作条 / 状态行 / 提示横幅（真删）；保留首页 ↔ 编辑器返回路径；
* 供应商与模型只有 OpenArc 总 API 设置一个来源（统一模型服务；不用 NOVAI 配置页、静态清单、独立密钥、直连）；未接通能力（视频等）明确不可用，不能显示为已连接；
* 不许用 CSS 遮挡冒充完成；首页→画布通信、保存、权限、账号隔离都要正常。

新的入口 / 边界 / 模型真源**以本轮为准**：提交 `b7ebaa5`（入口与单一真源）→ `ec5cbc5`（不静默替换不可用的默认模型 + 被拦导航后立即复位）→ `5b77186`（本地保存后仍呈现宿主改动；默认值显示与说明行收口）→ `4525ab8`（保存冲突三方合并；MS §6 节点淡入 + 来源标记）→ `2a97b95`（F3f 取注入层证据的路径修正，判定未动）；**最终真实 Electron 门禁 = 50 PASS / 0 FAIL / 50（exit 0，被测 commit `2a97b95`）**，证据 `artifacts/d5-02/d5-02-canvas-e2e.json`（sha256 `7579e32c…`）。
功能 / 视觉 / 动效均已取得实测证据（见 §5.1 的 G5 / G6 / G7）；**判定 = PARTIAL（限定范围，仅剩 1 项待用户裁定）**：功能 = 通过（50/50、exit 0、`notVerified: []`、Z1 clean，含保存冲突 F3e 与 MS §6 F3f）；视觉 = 对照已完成、可比项一致，数据项与条件项未验收（如实登记，不再阻塞），**1 项版本差异（回收站 FAB）待用户裁定**，**不整体宣布"视觉通过"**（§5.2）；动效 = 本轮改动通过、**MS §6 已实现并验证**。逐项记录见 `PROGRESS.md` 末尾同名小节；tracked 证据 `docs/D5-02-SCOPE-CORRECTION-EVIDENCE.json`（**50 条 checks，已按新 artifact 重生成**）。**一旦用户裁定 FAB → 可升级 PASS（限定范围）。**

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
| `canvas.html`（无限画布编辑器） | **已接入** | 增删改移/连线命令层、撤销/重做、自动保存、关闭重开恢复、文本与图片真实模型链、任务级预算/停止/迟到保护 | A3–A7/B1–B4/D1–D5/F1 |
| `online / zimage / enhance / klein / angle / gpt-chat`（生图与对话页） | **保留入口，未接入** | 页面可达；`/api/generate`、`/api/history`、`/api/online-image`、`/api/chat/stream` 等在桥里明确返回 501 `OPENARC_UNSUPPORTED`，窗口条一次性提示"该功能未接入 OpenArc（保留入口）" | A2/B5 |
| `asset-manager.html` / `api-settings.html` / `comfyui-settings.html` | **保留入口，未接入** | 同上（素材库 / 提示词库 / ComfyUI 端点 501） | A2 |
| `smart-canvas.html`（智能画布 Agent） | **保留入口，未接入** | 上游页面与入口都在；agent/工作流端点 501 | A2 |
| `/ws/stats` 实时状态通道 | **明确不可用** | WebSocket 替身立刻触发 `onerror/onclose`（不假装已连接），状态栏改用宿主 `/api/queue_status` | B6 |
| 桌面更新器（`/api/check-update`、`/api/update-*`、GitHub/Gitee/ModelScope 直连） | **禁用** | 501 `OPENARC_UPDATE_DISABLED` + 界面"更新/下载：已禁用" + 出网接收端 0 命中 | B6/E5 |
| pywebview 11 个宿主方法 | **明确不可用** | 不定义 `window.pywebview`（页面自动走网页版分支，桌面标题栏与退出入口自行隐藏）；读取即计数 + console 记录；不提供退出 OpenArc / 任意文件路径 / 任意宿主方法转发 | 页面分支 + E1 |

## 3. 五项既有缺口（结论已按 2026-09-24 范围修正更新）

> 2026-09-24 真实 Electron 门禁 **50 PASS / 0 FAIL / 50**（exit 0，比上轮新增 F3e / F3f，`notVerified: []`；被测 commit `2a97b95`）；五项缺口全部闭合。

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

* 应用页面在 `sandbox="allow-scripts allow-same-origin"` 的 iframe 里（上游跨页交互严重依赖同源：
  外壳丢弃非同源消息、`BroadcastChannel('studio-api')`、跨页 localStorage、`theme.js` 的 `window.self !== window.top`）。
  bundle origin = `openarc-canvas://bundle`，与 OpenArc 外壳（`file://`）**不同源** → 页面拿不到 `window.openarc` / IPC / fs / 凭据（E1）。
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
| G1 | `OPENARC_TESTED_COMMIT=$(git rev-parse HEAD) node experiments/d5-02/canvas-e2e.mjs`（真实 Electron；被测 commit `2a97b95`） | **50 PASS / 0 FAIL / 50，exit 0**（比上轮新增 **F3e** 保存冲突双向保留、**F3f** MS §6 标记 + 160ms 淡入）；`notVerified: []`；Z1 = clean |
| G2 | `node --test tests/d5-02-canvas-*.test.mjs tests/d5-02-model-list-authorization.test.mjs`（整套 d5-02，本批复跑） | **45 pass / 0 fail**（比上轮新增 `tests/d5-02-canvas-merge.test.mjs` **12/12**、`tests/d5-02-canvas-ai-marks.test.mjs` **11/11**；旧的 22/22 是其中 4 个文件的口径） |
| G3 | `tests/governance-app-model-grant.test.mjs`；`tests/model-*.test.mjs`（8 个文件） | **4/4**；**59/59**（文档岗复跑核对，取代旧的 60/60 口径） |
| G4 | 两条预存在失败（干净 HEAD 导出树同样复现） | `tests/side-effect-c4-gates.test.mjs:474`、`tests/d4-03-approval-push-isolation.test.mjs:103`；与本轮改动无关，登记为既有缺口 |
| G5 | 视觉核对（`artifacts/d5-02/visual/`：25 张截图 + 3 份 manifest + `visual-checks.md` + `computed-styles*.json` + `pixel-samples.json`） | 我们新增 / 改动元素 **通过**（12/18、说明行对比 18.16/19.05、chip 4.50–4.65、焦点环 2px+2px、`var(--radius-md,8px)`、省略 + `title`）；上游原版外观按用户指令保留 |
| G6 | 动效核对（`artifacts/d5-02/motion/`：8 段 1824 帧 PNG + `motion-summary.md` + `motion-report.json` + `ai-node-report.json`） | 本轮改动 **通过**（c1 95ms / 约 190ms；c2 约 190ms + 上游 fadeUp 0.7s；c3 160–210ms；c4 0ms；c5 无反馈）；**MS §6 = 已实现并验证**（`4525ab8`：160ms `cubic-bezier(.2,0,0,1)` 淡入 + 中性「AI」标记 + 减少动态效果立即呈现；门禁 F3f + `tests/d5-02-canvas-ai-marks.test.mjs` 11/11） |
| G7 | 首页视觉基准对照（第十一批；`artifacts/d5-02/visual-baseline/`：11 张 PNG + `manifest.json`） | 基准已落盘（sha256 `557ce43d…`，2238x1654 = 1119x827 @dpr2，浅色）+ 真实 Electron 元素级截图：结构 / 尺寸 / 字体层级 / 按钮主次 / 网格列数 / 徽标 / 圆点 / 主题 / dpr / 缩放 / 背景 **一致**（多数量到 0px 差）；整幅平移 (2.0, 9.0)px、布局视口宽 2px、真实窗口可达内容区 1119x758、画布数量 13 vs 5 与卡片数据 **未验收**（如实登记，不再阻塞）；右下角回收站 FAB 为 **1 项版本差异，待用户裁定**；**不整体通过**（§5.2） |

证据：`artifacts/d5-02/d5-02-canvas-e2e.json`（sha256 `7579e32c49f4aaafddb197be4a1b4e65336ddc8d6a01a4a30352e0b198b4f645`，本批 `shasum -a 256` 复核）+ 同名 `.log` + `d5-02-app-*.png`；tracked 证据 `docs/D5-02-SCOPE-CORRECTION-EVIDENCE.json`（50 条 checks，已按新 artifact 重生成）；视觉 / 动效证据见 G5 / G6；首页基准对照证据见 G7 / §5.2。

### 5.2 首页视觉基准对照（第十一批 · 2026-09-24）

> 本节是**更正**：此前记录的"与用户截图对照 = 未验收（当时基准图不在本工作区）"已不成立 —— 用户首页基准图已由主线落盘本工作区（见下），本批按同一条件重截我们的首页并逐项对照。**判定不整体通过**：能比的项判「一致」，数据性与条件性差异判「未验收」。

**基准（不再缺失）**

| 项 | 值 |
| --- | --- |
| 原始来源（Codex 剪贴板临时文件，仍存在） | `/var/folders/49/m7hfshm96vl9xkmkpjrygqqc0000gn/T/codex-clipboard-48126615-7162-4f0d-b262-6ee0d399e5d8.png` |
| 工作副本 | `artifacts/d5-02/baseline/user-home-baseline.png`（gitignored） |
| tracked 副本 | `docs/snapshots/2026-09-24-user-home-baseline.png` |
| sha256（三处相同） | `557ce43d865a1a08cd883daf116eea1ef54793dac7438d916753dddaae80d127` |
| 尺寸 | 2238x1654 像素 = **1119x827 逻辑 @dpr2**；浅色主题 |
| 复制留档时间 | 2026-09-24 15:43:13 |

**我们的取图条件**（真实 Electron + 隔离 userData + CDP + 三步初始化向导）：目标 = **画布应用窗口内容区**（宿主 iframe 元素本身；不含宿主窗口标题栏与桌面），Playwright 元素级截图；浅色、dpr2、缩放 100%（页面 `data-studio-scale="off"`，ui-scaled 未加、body transform none、html zoom 1）、宿主默认玻璃（`--content-alpha .94` / `--surface-alpha .68` / blur(34px) saturate(1.8)）、`scrollY=0`、轮播固定第 1 张（点圆点，activeSlide=0，与基准同一份 `carousel-image-generation.jpg`）。

尺寸口径：Electron 未实现 Browser.getWindowForTarget，OS 窗口改不动；物理口径上限 **1119x758**（宿主窗口固定 1440x940，`electron/window-manager.cjs` 的 resize 把 h 夹到 `host.h-100-y`）。827 高由 CDP `Emulation.setDeviceMetricsOverride(width=tw, height=th+82, deviceScaleFactor=2)` + 页面内画布窗口最大化达到（dpr 仍 2）；两条口径都留产物。

**产物**（`artifacts/d5-02/visual-baseline/`，gitignored）：`home-firstscreen-1119x827@2x.png`（2238x1654，与基准同像素尺寸，判定主图）、`home-firstscreen-1152x827@2x.png`（2304x1654，按基准版面反推的布局视口宽）、`home-firstscreen-1119x758@2x-physical.png`（真实夹取上限旁证）、`home-cards-*.png`、`host-window-context-*.png`（含窗口条，仅留证）、`side-by-side-firstscreen-1152.png` / `-1119.png` / `side-by-side-cards-1152.png`、`baseline-home.png` / `baseline-home-cards.png`、`manifest.json`（每张图的 inner/outer 尺寸、dpr、缩放、主题、背景与透明度、滚动位置、画布数量、时间 + 条件对照 + 逐项判定 + 位移证据 + 像素差）。

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
| 右下角回收站 FAB | **没有**（右下区域最暗像素 238） | **有**（同区域最暗 22） | **不一致（版本差异 · 唯一待用户裁定项）** —— 上游 6ce1a64 的 .trash-fab 是静态元素（无显隐逻辑）→ 基准侧版本与我们 vendor 的 commit 不同；也可能是 (2.0, 9.0)px 偏移的来源。裁定 = 接受现状 或 要求对齐（一行可逆改动） |
| 整幅绝对位置 | 内容在 (0,0) | 整体右移 2.0px、下移 9.0px | **未验收**（差 2.0 / 9.0px） |
| 布局视口宽（页面左边缘反推） | `~1156（页面左 98）~` | 1119（页面左 79.5）/ 1152（页面左 96） | **未验收**（差 2px） |
| 真实窗口可达内容区 | —— | 1119x758 | **未验收**（高差 69px；827 靠 CDP 视口模拟） |

**位移证据（"差的只是平移，不是布局"）**：内部相对距离逐项相同 —— 轮播顶→主按钮顶 195.0/195.0；轮播顶→「所有画布」顶 377.5/377.5；轮播顶→「新建画布」顶 363.0/363.0；轮播顶→卡片标题顶 601.5/601.5；标题 ink 顶→轮播顶 −55.5/−55.5；按钮 144.5x51、新建按钮 116.5x39.5、列宽 312、列距 324 全为 0 差。基准图内白字 bbox 差恰好 (2.0, 9.0)px；位移补偿后 hero 图区域 mean|diff| 6.59/255（>24 占 2.51%），不补偿 17.63。结论：**布局与基准一致，整幅只差一个 (2.0, 9.0)px 平移**；基准侧更像"内容被上移 9px（滚动或被裁切）+ 视口宽约多 4px"。

**发现的产品缺陷**：无本批引入的缺陷 —— 页面就是上游 static/canvas-list.html 原文件（vendor 只改了 3 处"新建"入口），基准与我们在同一份文件下的内部布局逐项 0 差；差异来自条件（基准侧 9px 平移 / 视口宽、宿主窗口尺寸与 resize 夹取）与**基准侧版本不同**（右下角回收站 FAB：基准没有、上游 6ce1a64 有；该元素无显隐逻辑），不是本分支的布局缺陷。**最小修法建议（不动手）**：回收站 FAB 的取舍待用户裁定 —— 接受现状，或要求对齐（对齐是一行可逆改动）；9px 平移与 2px 视口宽不需要改代码。**未闭合**：见 §7 第 1 条。

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

## 7. 未闭合 / 下一步

（2026-09-24 范围修正后最终口径）

1. **视觉对照里剩下的"未验收"项（按"条件无法完全匹配 → 未验收"如实登记，不再是阻塞项；§5.2）**：① **数据项** —— 画布数量 13 vs 5、「所有画布 · N 个」、卡片标题 / 缩略图 / 时间戳内容（隔离 userData 里是宿主 `canvas/create` 播的 5 本，需要真实数据才能比）；② **条件项** —— 整幅 (2.0, 9.0)px 平移、布局视口宽差 2px、真实窗口可达内容区 1119x758（宿主窗口固定 1440x940 + `electron/window-manager.cjs` 的 resize 夹取 maxH=host.h-100-y，827 高靠 CDP 视口模拟达到）；③ **1 项版本差异待用户裁定（关闭条件①）** —— 基准图右下角没有回收站 FAB、我们 vendor 的 6ce1a64 有（静态元素、无显隐逻辑）→「接受现状」或「要求对齐」（一行可逆改动）。**这是当前唯一待用户裁定的关闭条件；裁定后可升级 PASS（限定范围）。**
2. **两条预存在失败测试继续单列、不改断言（关闭条件②）**：`tests/side-effect-c4-gates.test.mjs:474`、`tests/d4-03-approval-push-isolation.test.mjs:103`（干净 HEAD 导出树同样复现，与本轮无关）。
3. **既有 NOT VERIFIED 不变（关闭条件③）**：Windows / 多屏 / 高 DPI 等（逐条见 `docs/D5-02-SCOPE-CORRECTION-EVIDENCE.json` 的 `notVerified`）。
4. **F3d / F4-presented 依赖页面 2.5s 轮询与窗口前台状态**：被完全遮挡时 Chromium 会节流；F3d 已 `bringToFront` 兜住。
5. **其他 NOVAI 子页文件仍在 bundle 内但无入口不可达**（smart-canvas 亦不可达，未注入适配层 / 守卫）。
6. **视频 / ComfyUI / RunningHub 等保持「明确不可用」**，未接通链路未启用。
7. **MS §6 的已知边界（见 §6 第 7 条）**：账本只记命令本身 —— `node.copy` / 不带 id 的 AI 新增对不上号，不猜不标记；marks 只取最近 200 条账本。

**判定：D5-02 = PARTIAL（限定范围，仅剩 1 项待用户裁定）。** 功能 = **通过**（真实 Electron 门禁 **50/50、exit 0**、`notVerified: []`、Z1 clean；含保存冲突 F3e 与 MS §6 F3f）；视觉 = 对照已完成、可比项一致（多数量到 0px 差），数据项与条件项 **未验收**（如实登记，不再是阻塞项），**1 项版本差异（回收站 FAB）待用户裁定**，**不整体宣布"视觉通过"**（§5.2）；动效 = 本轮改动 **通过**、**MS §6 已实现并验证**。关闭条件：① **用户对回收站 FAB 的裁定**（接受现状 或 要求对齐；其余视觉项已按"条件无法完全匹配 → 未验收"如实登记，不再是阻塞项）；② 两条**预存在**失败测试（`tests/side-effect-c4-gates.test.mjs:474`、`tests/d4-03-approval-push-isolation.test.mjs:103`，已在干净 HEAD 导出树复现，与本轮无关）继续单列、不改断言；③ 既有 NOT VERIFIED（Windows / 多屏 / 高 DPI 等）不变。**一旦用户裁定 FAB → 可升级 PASS（限定范围）（唯一的升级条件）。**

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
