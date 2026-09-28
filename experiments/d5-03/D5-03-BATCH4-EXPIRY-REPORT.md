# D5-03 第四批 · 会话自然到期 → MCP 收流 真机验收报告

被测工作区：/Users/wepingli/Desktop/OpenArc OS-integration（分支 integration/ui-core，HEAD 8cbf8df2df63bf542661148ceb629dd264d53884 + 第四批未提交改动）
被测提交（首轮 9 次 + 统一重跑 9 次，共 18 次真机运行一致）：8cbf8df2
**首轮验收时间（修复前）**：2026-09-28 03:48–03:54 UTC（本机本地 11:48–11:54）
**EXP-01 修复 + idle 单场景复测时间（修复后）**：2026-09-28 04:00–04:01 UTC（本机本地 12:00–12:01）
**统一重跑时间（修复后 · 最终口径 · 6 场景 + 3 门禁，全程串行）**：2026-09-28 04:34:53–04:37:43 UTC（本机本地 12:34–12:37；修复改动仍在工作树、未 commit）
验收脚本：experiments/d5-03/mcp-expiry-e2e.mjs（每个场景一次独立运行、独立 runId 产物目录）
产物：artifacts/d5-03/runs/<runId>/**（gitignored 证据目录）+ 追加式索引 artifacts/d5-03/runs/index.json / index.jsonl
**口径声明**：首轮（修复前）与「1R 单场景复测」的 runId 只作历史对照；**当前有效交付证据全部出自修复后的同一份代码 = 本轮统一重跑的 9 个 runId**（清单见 §2 / §6 / §10）。

---

## 0. 结论（功能 / 视觉 / 动效 三轴分开判定）

| 轴 | 判定 | 依据 |
| --- | --- | --- |
| 功能 | **通过**（首轮附 1 条文案缺陷 EXP-01；已修复，并已在统一重跑中对 6 个场景全量复验，未结缺陷 0） | 6 个场景 56 条新增断言全过（**本轮统一重跑 = 最终口径**）：到期偏差 0–1ms（空闲/绝对）、事件送达延迟 1–3ms、收流 10–53ms、4.2s 无自动重连、旧会话到期不误关新会话、登出/锁屏/撤权 detail 未变。修复后 6 场景 **25 / 7 / 5 / 7 / 7 / 5 全过、defects 0**：登录页文案 = 「登录状态已过期，请重新登录。」（§2 本轮明细、§8.1） |
| 视觉 | **通过** | 浅/深实机截图各一张（同状态同页面），尺寸 1660×1140 与第一批基准逐像素同尺寸；说明行实测对比度 浅色 4.94:1 / 深色 6.30:1，均 ≥ 4.5:1（普通文本门槛） |
| 动效 | **通过** | 本批未新增动效（McpCenter 本批只改了一行文案）；该说明行常规与减少动态效果下都无过渡/动画，减少动态效果下元素作用域 --dur-quick = 0ms 且信息不丢；既有动效（列表入场 160ms）抽样复测正常 |

- 三个既有门禁在**修复后的同一份代码**上统一重跑，计数不降：mcp-center-e2e **38/38**、mcp-stream-e2e **29/29**、mcp-policy-e2e **43/43**（notVerified 仍 2 条，与首轮同两条）—— 本轮 runId 见 §6。
- 本轮（统一重跑）三轴 notVerified：**0 条**。首轮实测 1 条产品文案缺陷（EXP-01）已修复，并已在本轮 6 场景全量复验中确认消失（6 个产物 `productDefects` 均为空，§2）；另有 2 条口径说明，见 §8。
- **本轮为「把全部真机证据收敛到同一份最终代码」**：先冻结当前改动清单与逐文件 sha256（24 个文件，见汇总 JSON `freezeSnapshot`），再串行重跑 6 场景 + 3 门禁。**本轮只跑不改**：产品代码、验收脚本、既有证据与索引一律未改，仅更新本报告与汇总 JSON。
- 未接真实第三方、未发用户数据、未运行任意第三方本地程序；工具调用入口仍全部 MCP_TOOL_INVOCATION_NOT_ENABLED；协议仍 2025-06-18；不声称插件隔离通过。

---

## 1. 被测内容与规范

第四批未提交改动（git status/diff，未 commit、未 push、未切分支）：

- electron/identity-service.cjs：权威到期调度（单一定时器 #expiryTimer、代次 #expiryGen、按持久层 min(expires_at, idle_expires_at) 排程、到点重读权威行、懒判定收敛 #reconcileExpiry）
- electron/identity-store.cjs：expireSession(ref) 幂等落权威终态（REVOKE_REASON.EXPIRED）
- electron/identity-domain.cjs：sessionExpiry() 单一判据 + EXPIRY_REASON / EXPIRY_DETAIL + evaluateSession 到期优先
- electron/mcp-bootstrap.cjs：identity/session-expired → dispose，detail = expired:idle / expired:absolute
- electron/identity-bootstrap.cjs + electron/main.cjs：短有效期双重开关（OPENARC_ALLOW_SESSION_TTL_OVERRIDE=1 + 十进制整数 ≥ 2000）与留痕
- src/identity/types.ts + src/identity/useIdentity.ts：identityEventConvergence 纯函数 + 订阅收敛（与登出同一条）
- src/mcp/McpCenter.tsx：会话已结束说明行文案补「会话过期」（本批 src/ 唯一改动，只增不删）

读到的规范版本与行号（验收当时的工作树）：

- DESIGN_SYSTEM.md 第 3 行「版本：设计提案 0.2，2026-09-10」；第 64 行 text.secondary = 浅 #6E6E73 / 深 #98989D；第 154/164 行「次级说明 12 / 18 px，字重 400」；**第 248 行「普通文本对比初始验收门槛为 4.5:1，大字为 3:1，必要控件边界和状态标记为 3:1」**
- MOTION_SYSTEM.md 第 3 行「版本：动效提案 0.1，2026-09-10」；第 21 行 duration.instant = 0 ms（减少动态效果）
- PLAN.md 第 3 行更新日期 2026-09-10；§4 第 38–52 行（全局视觉与动效规范）；§42 第 801–806 行（设计语言与交互动效交付）

短有效期注入（仅测试/运维用；默认路径不受影响）：OPENARC_ALLOW_SESSION_TTL_OVERRIDE=1 且 OPENARC_SESSION_IDLE_MS / OPENARC_SESSION_TTL_MS 为 ≥2000 的十进制整数；产品默认 12h 绝对（43200000ms）/ 2h 空闲（7200000ms），下限 2000ms。

---

## 2. 场景实测（每条都有实测时刻与偏差，不写「约」）

统一测量口径：dueAt = 只读 DB 权威行 min(expires_at, idle_expires_at)；revoked_at = 库时钟在 expireSession 落终态那一刻写入的值；偏差 = revoked_at − dueAt；事件延迟 = 渲染层收到 identity/session-expired 的时刻 − revoked_at。有界窗口上界 EXPIRY_BOUND_MS = 2000ms。

**两轮口径**：同一分支 integration/ui-core、同一被测提交 8cbf8df2，差别只在工作树 —— **首轮 = EXP-01 修复前**那棵树，**本轮 = EXP-01 修复后**那棵树。**本轮（统一重跑）是最终口径**：本报告一切结论以本轮 runId 为准；首轮与「1R 修复后复测」的 runId 仅作历史对照。

**首轮（修复前）—— 历史行，逐条保留备查（其产物由修复前那棵树产生，不再作为交付证据）：**

| # | 场景 | runId（后缀） | 注入 TTL | 断言 | 计数 |
| --- | --- | --- | --- | --- | --- |
| 1 | 空闲自然到期收流 + 界面收敛 + 0 投影 + 视觉/动效/开关自证 | 20260928T035051Z-5aef | idle 8000 / abs 120000 + ack | 25 | 25/25 |
| 1R | 空闲自然到期 **EXP-01 修复后复测**（同场景、同注入值、独立 runId） | 20260928T040019Z-e88c | idle 8000 / abs 120000 + ack | 25 | 25/25（defects 0）|
| 2 | 合法活动延长空闲期限、旧安排不误关 | 20260928T035120Z-b180 | idle 8000 / abs 120000 + ack | 7 | 7/7 |
| 3 | 绝对到期（空闲永不到期） | 20260928T035142Z-6466 | idle 60000 / abs 10000 + ack | 5 | 5/5 |
| 4 | 旧会话到期不关随后登录的新会话 | 20260928T035158Z-b8fc | idle 8000 / abs 120000 + ack | 7 | 7/7 |
| 5 | 既有路径回归：登出 / 锁屏 / 撤权 | 20260928T035219Z-4daa | 默认（无覆写） | 7 | 7/7 |
| 7a | 开关自证 (a)：不给 ack → 忽略 | 20260928T035229Z-a761 | idle 8000 / abs 60000 无 ack | 5 | 5/5 |

**本轮（统一重跑 · 最终口径）—— 6 个场景在修复后的同一份代码上串行重跑（每次独立 runId 目录 + 只追加索引 + 独立 `.sha256`；同一时刻只有一个 Electron）：**

| # | 场景 | runId（后缀） | 注入 TTL | 计数 | 相对首轮计数 | 相对首轮的行为差异（如实） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 空闲自然到期（idle） | 20260928T043453Z-140a | idle 8000 / abs 120000 + ack | **25/25**（defects 0） | 25 → 25，不降 | 登录页文案已无内部枚举（EXP-01 修复生效，见 §8.1）；偏差 1ms→**0ms**、事件延迟 2ms→**3ms**、收流 57ms→**53ms**（都在有界窗口内） |
| 2 | 合法活动延长（extend） | 20260928T043517Z-7ab7 | idle 8000 / abs 120000 + ack | **7/7** | 7 → 7，不降 | 一次活动把 idle 推后 6005ms（首轮 6010ms，= 活动时刻 + 8001ms ≈ idle 8000ms）；偏差 0ms→**1ms**、收流 18ms→**10ms** |
| 3 | 绝对到期（absolute） | 20260928T043538Z-4e4c | idle 60000 / abs 10000 + ack | **5/5** | 5 → 5，不降 | 偏差 **1ms 与首轮相同**；事件 reason 仍 **absolute**、日志 detail 仍 **expired:absolute**（运维口径未变）；收流 16ms→**48ms**；空闲余量 57794ms→**58767ms** |
| 4 | 旧会话到期不关新会话（relogin） | 20260928T043554Z-e52c | idle 8000 / abs 120000 + ack | **7/7** | 7 → 7，不降 | 偏差 54ms→**71ms**（同量级）；B 仍只在自己到期点被终结、A 仍是 LOGOUT |
| 5 | 既有路径回归（regress） | 20260928T043611Z-561b | 默认（无覆写） | **7/7** | 7 → 7，不降 | **无**：三条 detail（logout / user / app-grant-revoked）与边界复验逐字未变 |
| 7a | 开关自证 (a)（override-deny） | 20260928T043615Z-3f55 | idle 8000 / abs 60000 无 ack | **5/5** | 5 → 5，不降 | **无**：绝对上限仍 43200000ms 整、idle 仍是默认 2h 档且 ≠ 注入值 |

**当前有效证据 = 本轮 runId 清单**：`20260928T043453Z-140a` · `20260928T043517Z-7ab7` · `20260928T043538Z-4e4c` · `20260928T043554Z-e52c` · `20260928T043611Z-561b` · `20260928T043615Z-3f55`（各后缀 `-mcp-expiry-e2e`），加 §6 三个门禁本轮 runId。**判定不变**：无任一场景计数低于首轮，无与首轮不同的功能性结果，无需改判定、无需改脚本掩盖。

### 本轮统一重跑明细（最终口径，逐条实测）

- **idle（20260928T043453Z-140a，25/25、defects 0、exitCode 0）**：dueAt = 2026-09-28T04:35:03.442Z（idle 归因）→ revoked_at = 同刻，**偏差 0ms**；事件送达渲染层延迟 **3ms**；收流 1→0 实测 **53ms**；恰好 1 条 identity/session-expired(reason=idle)、1 条 expire 审计、1 条 SESSION_ENDED 且 detail = **expired:idle**；DB enabled = **1 未改写**、status = DISABLED、last_error_code = MCP_SESSION_ENDED、revoked_reason = EXPIRED。零交互窗口内 DOM 投影 0、命令面 mcp/get = MCP_UNAUTHORIZED 且 0 连接数据；之后 4.2s /__state 差异字段 = []（零变化）。登录页 [data-d3-id="auth-error"] 实测 = **「登录状态已过期，请重新登录。」**（无任何内部枚举）。视觉 4.94:1 / 6.30:1、1660×1140 设备像素、窗口 1440×940；M1 动效 0s/none、--dur-quick 0ms；定时器单测 21/21。
- **extend（20260928T043517Z-7ab7，7/7、exitCode 0）**：t0+6002ms 一次真实命令层合法活动（mcp/get 经 validateSession → #touch）把 idle_expires_at 从 04:35:27.096Z 推到 04:35:33.101Z（+6005ms，= 活动时刻 + **8001ms** ≈ 8000ms）。越过原到期点 t0+11002ms（超 **3004ms**）连接仍 READY、openStreams = 1、revoked_at = null、渲染层过期事件 0 —— 旧安排没有误关。最后一次活动 + idle 才到期：revoked_at = 04:35:33.102Z，**偏差 1ms**、事件延迟 2ms、收流 **10ms**、detail = expired:idle、enabled = 1。
- **absolute（20260928T043538Z-4e4c，5/5、exitCode 0）**：绝对到期点 04:35:49.375Z；期间 5 次真实命令层合法活动（identity/status，~2s 一次）把 idle_expires_at 推到 04:36:48.142Z，比绝对到期点晚 **58767ms**（空闲永不到期）。仍在绝对到期点收流：revoked_at = 04:35:49.376Z，**偏差 1ms**、事件 reason = **absolute**、事件延迟 1ms、日志 detail = **expired:absolute**、收流 **48ms**、enabled = 1 未改写、revoked_reason = EXPIRED。
- **relogin（20260928T043554Z-e52c，7/7、exitCode 0）**：会话 A = ses_D31JKCY8pClaICOiMGwAtehwsezydsFj（A 到期点 04:36:03.642Z）；t0+5002ms 真实 UI 登出 → t0+5052ms 重新登录得到会话 B = ses_Ho6puIeo4MUITNCH55F3le0Etmsk7Dlk（id 与 ref 都与 A 不同，B 到期点 04:36:08.798Z）。到 A 的原到期点（+**302ms**）：B 连接仍 READY、B 流仍开、B 的 revoked_at = null、渲染层 0 条过期事件；A 的状态 = LOGOUT（未被旧到期二次改写）。B 在自己最后一次活动 + idle 到期：revoked_at = 04:36:08.869Z（**偏差 71ms**）、唯一过期事件的 sessionId = B、收流 **38ms**、detail = expired:idle；A 的连接记录仍是登出时的 SESSION_ENDED(detail = logout) 且只有 1 条。
- **regress（20260928T043611Z-561b，7/7、exitCode 0）**：登出（真实 UI 顶栏）流 1→0、enabled = 1 未改写、DISABLED + MCP_SESSION_ENDED、detail = **logout**；锁屏（真实 UI 顶栏）同上但 detail = **user**，解锁后回到 ready；撤权（governance/revokeAppAccess）流 1→0、enabled = 1、ERROR + MCP_UNAUTHORIZED、AUTHORIZATION_REVOKED 恰好 1 条且 detail = **app-grant-revoked**，随后经正式治理入口恢复。边界复验：5 个工具调用入口仍全部 MCP_TOOL_INVOCATION_NOT_ENABLED、未登记命令仍 MCP_COMMAND_NOT_ALLOWED、协议仍 2025-06-18。
- **override-deny（20260928T043615Z-3f55，5/5、exitCode 0）**：给 OPENARC_SESSION_IDLE_MS = 8000 / TTL = 60000 但**不给** ack → 主进程日志恰好 1 条忽略记录；只读 DB 证明权威行仍是默认值：expires_at − created_at = **43200000ms**（默认 12h 整）、idle_expires_at − created_at = **7200032ms**（默认 7200000 + 登录 touch 漂移 32ms，距今 7199947ms），都**不等于**注入值 8000/60000；解析入口 record = {event: session-ttl-override, result: **DENY**, error_code: OVERRIDE_NOT_ACKNOWLEDGED}。补充（7a-2）：同值**加上** ack 后确实生效，证明上一条不是因为值本身非法而被拒。

### 脚本期望核对（特别核对项，逐字披露）

- idle 场景 `1h` 的**期望串逐字** = `gate=unauthenticated + 登录表单在 + auth-error 含「登录状态已过期，请重新登录。」`；断言实现是 `errText.includes("登录状态已过期，请重新登录。")`。**期望里不含 `（idle）`，也不含 `（absolute）`。**
- 脚本里唯一出现 `（idle|absolute）` 的地方是 EXP-01 的**缺陷探测器**（`mcp-expiry-e2e.mjs:875` 的 `/（(idle|absolute)）/.test(errText)`）：命中才登记一条产品缺陷，它**不是期望值**。
- absolute 场景**没有**对登录页文案的任何断言：本轮产物该字段为空对象（`uiTexts = {}`），全文不含「登录状态已过期」。因此不存在需要从 `（absolute）` 更新的期望。
- **结论：本轮没有发生任何「旧期望 → 新期望」的改写**。脚本期望本来就是修复后的那一句（用子串断言 + 独立缺陷探测），无需更新，也未更新 —— 脚本文件 sha256 与本轮冻结快照一致（`experiments/d5-03/mcp-expiry-e2e.mjs` = `586ab535dfae67b8ca72658d7cfcc09b334087e63682a7fd37be5f2c5c8d5024`）。**本轮只跑了脚本、一行未改。**

以下为**首轮（修复前）明细**，逐条保留备查（其中 idle 的登录页文案即 EXP-01 的原始实测）：

### 场景 1（idle · 首轮=修复前，20260928T035051Z-5aef；产物 artifacts/d5-03/runs/20260928T035051Z-5aef-mcp-expiry-e2e/mcp-expiry-e2e.json，sha256 9a3b1b8c782ef51d…）

- 真实 electron . + 三步向导 + 真实 UI 登录 admin；首条连接经**界面表单**创建（http，127.0.0.1 动态端口），启用 → connect → 详情 READY，工具表 = 本次参照握手（echo_sum / describe_self），toolsHash 一致。
- 注入值落在权威行（只读 DB）：idle_expires_at − last_seen_at = **8000ms**（= 注入值；相对 created_at 为 9238ms，差的 1238ms 是登录/建连那次 #touch 的漂移）、expires_at − created_at = **120000ms**（= 注入值）。
- 零交互窗口（不点任何按钮、不发任何命令；只做只读 DB 轮询 + fixture /__state 轮询）：dueAt = 2026-09-28T03:51:03.955Z（idle 归因）→ revoked_at = 2026-09-28T03:51:03.956Z，**偏差 1ms**；渲染层收到 event 延迟 **2ms**；恰好 1 条 identity/session-expired(reason=idle)。
- 收流：服务端 getSse.openStreams 1→0（**实测 57ms**），GET 打开次数停在 1（无重连），POST 流未释放数 0。
- DB 只读：enabled = **1（未被改写）**、status = DISABLED、last_error_code = MCP_SESSION_ENDED、revoked_reason = EXPIRED；mcp_connection_logs 里 SESSION_ENDED 恰好 1 条且 **detail = expired:idle**。
- 权威事件只一次：audit_log 里 event = expire 恰好 1 条（result = OK / error_code = SESSION_EXPIRED）+ 渲染层事件 1 条 + SESSION_ENDED 1 条。
- 渲染层收敛：gate = unauthenticated；登录页 [data-d3-id="auth-error"] **修复前**实测文案 = 「登录状态已过期，请重新登录。（idle）」（EXP-01，见 §8）；**修复后复测**（20260928T040019Z-e88c）实测文案 = 「登录状态已过期，请重新登录。」—— 无任何内部枚举（§8.1）。
- 未认证窗口内 DOM 投影 0：0 个 [data-mcp-tool]、无工具表、工具名/描述/参数/hash 全 0 命中、MCP 中心不在 DOM；命令面 mcp/get = MCP_UNAUTHORIZED 且响应里 0 连接数据。
- **之后 4.2s 服务端计数零变化**：/__state 全量对比差异字段 = []（已剔除本脚本自身观测口计数 http.requests / http.stateRequests），GET 打开 1→1、POST 次数不变，渲染层事件总数 3→3（无自动重连、无盲目重发）。
- 重新登录后：详情出现 data-mcp-note="session-ended"，文案含「会话过期」；enabled 显示「已启用」；mcp/get 无 getStream（客户端不再持有活连接）。

### 场景 2（extend · 首轮=修复前，20260928T035120Z-b180）

- t0 建连 + 选中详情后 idle_expires_at − now = 7978ms；GET 流已建立。
- t0+5997ms 用**真实命令层**做一次合法活动（mcp/get → 授权守卫 validateSession → #touch）：只读 DB 证明 idle_expires_at 从 03:51:31.980Z 推到 03:51:37.990Z（+6010ms，= 活动时刻 + **8002ms** ≈ idle 8000ms）。
- 越过原到期点检查：t0+10998ms（比原到期点晚 **3009ms**）连接仍 status = READY、服务端 openStreams = 1、会话 revoked_at = null、渲染层过期事件 0 条 —— 旧安排没有误关。
- 最后一次活动 + idle（03:51:37.990Z）才到期：revoked_at = 03:51:37.990Z，**偏差 0ms**，事件延迟 2ms，收流 1→0（**18ms**），detail = expired:idle，enabled = 1。

### 场景 3（absolute · 首轮=修复前，20260928T035142Z-6466）

- idle 60000ms（远大于观察窗）/ absolute 10000ms；绝对到期点 = 03:51:54.138Z。
- 期间每 ~2s 一次真实命令层合法活动（identity/status）：活动把 idle_expires_at 推到 03:52:51.932Z，比绝对到期点晚 **57794ms**（空闲永不到期）。
- 仍在绝对到期点收流：revoked_at = 03:51:54.139Z，**偏差 1ms**，事件 reason = **absolute**，日志 detail = **expired:absolute**，收流 1→0（16ms），enabled = 1 未改写，会话 revoked_reason = EXPIRED。

### 场景 4（relogin · 首轮=修复前，20260928T035158Z-b8fc）

- t0 登录（会话 A = ses_vv4vWEKE…）+ 界面表单建连 + GET 流；A 到期点 = t0+7998ms。
- t0+5001ms 用**真实 UI** 登出 → t0+5089ms 重新登录：会话 B = ses_Q1FI8PZNC…（id 与 ref 都与 A 不同）+ 建 B 的连接 + GET 流；B 到期点 = 03:52:15.387Z。
- 到 A 的原到期点（+301ms）：B 的连接仍 READY、B 的流仍开、B 会话 revoked_at = null、渲染层 0 条过期事件；A 的状态是 revoked_reason = LOGOUT（被登出终结，未被旧到期二次改写）。
- B 在「自己最后一次活动 + idle」到期：revoked_at = 03:52:15.441Z（**偏差 54ms**），唯一过期事件的 sessionId = B，B 连接 detail = expired:idle；A 的连接记录仍是登出时的 SESSION_ENDED(detail = logout) 且只有 1 条。

### 场景 5（regress · 首轮=修复前，20260928T035219Z-4daa；默认有效期）

三条既有路径都按第三批口径收流，detail 一个字符没变：

| 路径 | 触发方式 | 服务端流 | enabled | status / last_error_code | 日志 detail |
| --- | --- | --- | --- | --- | --- |
| 登出 | 真实 UI 顶栏「退出登录」 | 1→0 | 1（未改写） | DISABLED / MCP_SESSION_ENDED | **logout** |
| 锁屏 | 真实 UI 顶栏「锁定」 | 1→0 | 1（未改写） | DISABLED / MCP_SESSION_ENDED | **user** |
| 撤权 | governance/revokeAppAccess | 1→0 | 1（未改写） | ERROR / MCP_UNAUTHORIZED | **app-grant-revoked** |

每条路径的 SESSION_ENDED / AUTHORIZATION_REVOKED 都恰好 1 条；锁屏后解锁回到 ready；撤权后经正式治理入口 grantAppAccess 恢复可用。边界回归：5 个工具调用入口仍全部 MCP_TOOL_INVOCATION_NOT_ENABLED，未登记命令仍 MCP_COMMAND_NOT_ALLOWED，协议仍 2025-06-18。

### 场景 7a / 7b（开关双重保险 · 首轮=修复前）

- 7a（20260928T035229Z-a761）：给了 OPENARC_SESSION_IDLE_MS=8000 / OPENARC_SESSION_TTL_MS=60000 但**不给** ack → 主进程日志恰好 1 条忽略记录（「…必须同时设置 OPENARC_ALLOW_SESSION_TTL_OVERRIDE=1…本次沿用默认有效期。」）；只读 DB：expires_at − created_at = **43200000ms**（默认 12h 整）、idle_expires_at 距今 **7199985ms**（默认 2h 档），都**不等于**注入值。解析入口 record = {event: session-ttl-override, result: DENY, error_code: OVERRIDE_NOT_ACKNOWLEDGED}。
- 7b（20260928T035051Z-5aef）：同值 + ack → 主进程日志恰好 1 条「会话有效期覆写生效」且含「idleMs 7200000 → 8000，ttlMs 43200000 → 120000」；解析入口 record = {event: session-ttl-override, result: OK}。
- 口径说明（如实记录，不是失败）：main.cjs 只打印 record.message，该句正文**不含**事件名 session-ttl-override；事件名只存在于解析结果 record.event（证据里两处都留了）。

---

## 3. 视觉（实机对照，不只看源码）

截图（浅/深同一状态、同一页面；窗口尺寸/缩放/背景/透明度/主题与第一批基准一致）：

- artifacts/d5-03/runs/20260928T035051Z-5aef-mcp-expiry-e2e/visual/light-session-expired.png
- artifacts/d5-03/runs/20260928T035051Z-5aef-mcp-expiry-e2e/visual/dark-session-expired.png
- artifacts/d5-03/runs/20260928T035051Z-5aef-mcp-expiry-e2e/visual/dark-reduced-session-expired.png（减少动态效果下同状态）
- 修复轮复测重出同三张（同状态、同页面；V1–V5 逐项 PASS，对比度浅 4.94:1 / 深 6.30:1 与首轮一致）：artifacts/d5-03/runs/20260928T040019Z-e88c-mcp-expiry-e2e/visual/{light,dark,dark-reduced}-session-expired.png

窗口/缩放/设置（实测，与基准同口径）：

- 截图设备像素 **1660×1140**（DPR 2，CSS 裁剪 830×570，即 MCP 中心窗口）——与第一批基准 visual/light-02-list.png、dark-02-detail.png 的 1660×1140 **逐像素同尺寸**。
- 应用窗口 innerWidth/innerHeight = **1440×940**（electron/main.cjs:272 默认值，未设缩放）；主题由真实设置面板「外观」切换（浅 → 深），非注入；背景/透明度/壁纸为默认值（未开不透明模式、未改壁纸）；desktop 根元素类在浅色下无 dark、深色下有 dark。
- 视觉/动效阶段用只读身份命令保活，截图结束时 gate = ready、说明行仍在、会话未终结（否则截图可能是过期后的空壳，证据无效）。

文字对比度量测（说明行 = [data-mcp-note="session-ended"]，即 .mcp-muted）：

| 主题 | 计算样式（元素自身） | 字号/字重 | 实测合成背景（像素） | 实测字形像素 | 对比度 | 门槛 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 浅色 | color rgb(110,110,115)；--muted = rgb(110 110 115)；--fs-caption = 12px；行高 20.4px | 12px / 400 | rgb(252,252,252)（占该区域 40.5%） | rgb(110,110,115) | **4.94:1** | 4.5:1 | 通过 |
| 深色 | color rgb(152,152,157)；--muted = rgb(152 152 157)；--fs-caption = 12px；行高 20.4px | 12px / 400 | rgb(22,22,22)（占 35.2%） | rgb(152,152,157) | **6.30:1** | 4.5:1 | 通过 |

- 量测方法：截取说明行（含 6px 边距）→ 在页面内用 canvas 解码截图 → 背景取区域内出现次数最多的颜色（合成后的真实表面），文字取与背景亮度差最大的像素（字形实心处）；对比度用 WCAG 2.x 相对亮度公式 (L1+0.05)/(L2+0.05)。
- **门槛归属**：12px、字重 400 → 按 DESIGN_SYSTEM.md:248「普通文本 4.5:1，大字 3:1」属**普通文本**，不适用 3:1（大字定义为 ≥24px，或约 ≥18.67px 粗体）；该行不缩小到脚注以下、不在 3:1 口径里放水。
- 计算样式与 token 真值一致：color 就等于 --muted（浅 #6e6e73 / 深 #98989d，即 DESIGN_SYSTEM.md:64 的 text.secondary 两档），字号就等于 --fs-caption = 12px（DESIGN_SYSTEM.md:164 的次级说明），字重 400。
- 指定色合成值与实测像素值三方一致（contrastMeasuredPx = contrastSpecified = contrastTokenSpecified），说明该行没有用颜色偏差掩盖对比度问题。未达标即如实判不通过，本轮浅深都达标。

---

## 4. 动效（本批未新增动效）

- 本批 src/ 改动只有一行文案：src/mcp/McpCenter.tsx 的 git diff -U0 只有 -/+ 各一行（「会话已结束（登出 / 锁屏 / **会话过期** / 应用退出）」），allAreCopy = true；列表入场 / 退场 / 详情切换动效一行未动，结论沿用第一/三批。
- 该说明行本身无动效：常规 transitionProperty = "all" / transitionDuration = "0s" / animationName = "none"；减少动态效果下同样 0s / none。
- 减少动态效果（真实设置面板开关，非注入）：.desktop.reduced = true、说明行元素自身 --dur-quick = **0ms**（.reduced 作用域已压掉；:root 仍是 0.16s，所以必须读元素作用域），说明行文本仍完整显示（信息不丢）；关掉后回到常规。
- 既有动效抽样复测（只记录，不改前批结论）：列表入场 .mcp-row.is-new → animationName = mcp-row-in、duration = 0.16s，与第一/三批口径一致。

---

## 5. 无高频轮询自证

- 主进程 / 运行层面：到期**只有一次**权威事件（audit_log event = expire 恰好 1 条，result = OK / error_code = SESSION_EXPIRED）与**一次**收尾（连接日志 SESSION_ENDED 恰好 1 条），渲染层 identity/session-expired 恰好 1 条；之后 4.2s 服务端计数零变化。
- 源码层面（到期链路文件：identity-service / identity-store / identity-domain / identity-bootstrap / mcp-bootstrap / mcp-service / runtime-boot / useIdentity / types / McpCenter）：**setInterval 合计 = 0**；排程只有 **1 处** this.timers.setTimeout；句柄只有单字段 #expiryTimer（7 处引用）；定时器与懒判定共用 domain.sessionExpiry；渲染层用 identityEventConvergence 纯函数收敛，hook 内没有第二条过期分支。
- 在途定时器 ≤ 1 的精确计数与「已出队旧回调不得动新会话」由注入式定时器单测锁定，首轮一并重跑、**统一重跑再跑一次结果相同**：node --test tests/identity-session-expiry.test.mjs tests/d5-03-mcp-lifecycle.test.mjs → **# tests 21 / # pass 21 / # fail 0**（首轮与本轮 idle 的产物 `timerUnitTests` 都是这三行；该夹具自身就用 setInterval 抛错 + pending() 计数来锁这两条）。
- 口径说明：真机上「登出后旧到期点」这一路径会先被 logout 清掉安排，所以真机验到的是**结果**（A 的到期点过后 B 安然无恙）；「clearTimeout 拦不住的已出队旧回调」这一竞态由单测 L7 覆盖，两者证据互补，不能互相顶替。

---

## 6. 既有门禁重跑（串行，各自独立 runId）

**本轮（统一重跑 · 最终口径）—— 在修复后的同一份代码上串行重跑（各自独立 runId、只追加索引、独立 `.sha256`；同一时刻只有一个 Electron）：**

| 门禁 | runId | counts | notVerified | 退出码 | artifact sha256（前 16 位 + 全值见汇总 JSON） |
| --- | --- | --- | --- | --- | --- |
| mcp-center-e2e | 20260928T043622Z-b4df-mcp-center-e2e | **38 / 38** | 0 | 0 | 2f1ac645d20641bd… |
| mcp-stream-e2e | 20260928T043657Z-8d65-mcp-stream-e2e | **29 / 29** | 0 | 0 | 699aae6b216fd94c… |
| mcp-policy-e2e | 20260928T043724Z-25c6-mcp-policy-e2e | **43 / 43** | **2**（与首轮/上一轮同两条：同一安装内的第二个组织在真机不可构造） | 0 | 8cd21321c64cab38… |

**本轮计数与首轮逐项相等（38/29/43 不降），三个门禁都在被测提交 8cbf8df2 上；既有断言一条未改、一条未删。** 本轮相对首轮唯一的差异是运行时刻与 runId（门禁脚本与产品代码在本轮一字未动）：
- 首轮 idle 场景的登录页文案缺陷（EXP-01）不在这三个门禁的断言范围内 —— 门禁计数与 notVerified 条数与首轮完全一致，**无差异需要报告**。
- mcp-policy-e2e 在本轮的一次自我保护记录：启动第 8 个实例前先杀掉仍存活的上一实例 `{"pid":77458,"tree":[77458,77459,77460],"mainGone":true,"leftovers":[],"cdpPort":9818}`（该实例是本轮脚本自己的第 8 次 launch，属脚本内既有机制，非残留泄漏；收尾 leftovers = []）。

**首轮（修复前）—— 历史行，逐条保留备查：**

| 门禁 | runId | counts | notVerified | 退出码 | artifact sha256 |
| --- | --- | --- | --- | --- | --- |
| mcp-center-e2e | 20260928T035243Z-19c3-mcp-center-e2e | **38 / 38** | 0 | 0 | d4cefed34e42b15cb69b755f… |
| mcp-stream-e2e | 20260928T035324Z-ef6b-mcp-stream-e2e | **29 / 29** | 0 | 0 | 555271ee446a3bdcc45eb61b… |
| mcp-policy-e2e | 20260928T035356Z-73cd-mcp-policy-e2e | **43 / 43** | **2**（与上一轮同两条：共库双组织在真机不可构造） | 0 | 0c0ecc2bd17ede0b89deb917… |

首轮三次运行都在被测提交 8cbf8df2 上，但由**修复前**那棵树产生；计数不降（38/29/43 逐项相等），既有断言一条未改、一条未删（首轮只新增 experiments/d5-03/mcp-expiry-e2e.mjs）。

---

## 7. 清理与既有证据完好

### 7.1 本轮（统一重跑 · 最终口径，串行 9 次运行）

- **临时目录归属清理**：本轮 9 次运行各自 mkdtempSync 出 `oa-d503b-<tag>-*`（stream 门禁用 `oa-d503s-`）并写 owner.json（script / runId / pid / createdAt / kind），收尾只删「本次自建 + 标记确属本进程 + 位于 os.tmpdir() 下」的目录；9 次全部 `userDataDirsKept = []`。产物 JSON 里 `cleanup.userDataDirsRemoved` 逐条列出本次自建目录：
  - idle 20260928T043453Z-140a → `["oa-d503b-20260928T043453Z-140a-FFDWUk"]`
  - extend 20260928T043517Z-7ab7 → `["oa-d503b-20260928T043517Z-7ab7-94OXFJ"]`
  - absolute 20260928T043538Z-4e4c → `["oa-d503b-20260928T043538Z-4e4c-PMKZ9L"]`
  - relogin 20260928T043554Z-e52c → `["oa-d503b-20260928T043554Z-e52c-r6zeDw"]`
  - regress 20260928T043611Z-561b → `["oa-d503b-20260928T043611Z-561b-89sTo0"]`
  - override-deny 20260928T043615Z-3f55 → `["oa-d503b-20260928T043615Z-3f55-UVxC85"]`
  - mcp-policy-e2e 20260928T043724Z-25c6 → 5 个（`…-25c6-Snm7Ok` / `-SgCMjw` / `-i6Rq7u` / `-upgrade-jYACQo` / `-legacy-UcTjuz`，日志里逐行 `[REMOVED]`）
- **临时目录结果**：本轮 9 次运行结束后 `ls -d /var/folders/*/*/T/oa-d503b-*` → **0 个（glob 无匹配，退出码 1）**。
- **进程清理**：9 次全部 `pkillUsed = false`、`leftovers = []`、`strategy = own-pid-tree-only`，只用本次运行自己的 pid 树（electron 主进程 + 后代 + fixture 子进程）；被测工作区外的 `/Users/wepingli/Desktop/OpenArc OS.app`（用户自己的实例，pid 65824，userData 为 `~/Library/Application Support/openarc-os`）全程未被触碰。
- **既有证据未被改写（逐项重算）**：本轮运行结束后，对 `artifacts/d5-03/runs/index.json` 的 **30 条**索引项逐条重算现存产物 JSON 的 sha256 并与索引里的 `artifactSha256` 比对 —— **历史 21 条 0 处不一致、本轮新增 9 条 0 处不一致、重复 runId 0 条**；`index.jsonl` 同为 30 条且全部唯一，本轮 9 条的 artifactSha256 与 `index.json` 逐条一致。另外，每次运行的 Z1 断言逐字节核对了运行前已存在的 `artifacts/d5-03/runs/**` 文件（**changedExisting = []、removed = []**），索引按设计只追加。

### 7.2 首轮（修复前）—— 历史行，保留备查

- 临时目录归属清理：首轮 6 次运行各自 mkdtempSync 出 oa-d503b-<tag>-* 并写 owner.json（script / runId / pid / createdAt / kind），收尾只删「本次自建 + 标记确属本进程 + 位于 os.tmpdir() 下」的目录。每次运行的产物 JSON 里 cleanup.userDataDirsRemoved 列出本次自建目录（例：["oa-d503b-20260928T035051Z-5aef-owknUd"]），userDataDirsKept = []。
- 运行结束后 ls -d /var/folders/*/*/T/oa-d503* → **0 个**。该 T 目录下另有 70372 个 oa-* 目录，全部是历史/其它实验的命名空间（oa-c4-runtime-*、oa-d3-04a-src-*、oa-bisect-*、oa-abdbg-* 等），前缀都不是 oa-d503b-，本次一个都没动。
- 进程清理只用本次运行自己的 pid 树（electron 主进程 + 后代 + fixture 子进程），pkillUsed = false，每次 leftovers = []。
- 既有证据未被触碰：index.jsonl 里 **20 条历史运行的 artifactSha256 与现存文件逐一重算比对，0 处不一致**（含本轮之前第一/二/三批的全部 8 次运行）；新脚本每次运行的 Z1 也逐字节核对了运行前已存在的 artifacts/d5-03/runs/** 文件（changedExisting = []、removed = []），索引按设计只追加。

---

## 8. notVerified、缺陷与遗留

**本轮三轴 notVerified：0 条**（6 个场景的产物 JSON 里 notVerified 均为空数组）。

产品缺陷（1 条，**已修 + 已真机复测**）：

- **EXP-01 · 登录页把内部到期枚举拼进了用户可见文案 —— 已修（修复记录与复测证据见 §8.1）**
  - 位置：src/identity/useIdentity.ts 的事件订阅回调（absorb({ ok:false, error: intent.errorCode, detail: event.reason })）配合 src/identity/types.ts:70-75 的 errorText（detail 非 code 时括注在文案后）
  - 复现：会话空闲自然到期后，登录页 [data-d3-id="auth-error"] 实测文案 = 「登录状态已过期，请重新登录。（idle）」；绝对到期会是「（absolute）」。detail 是事件 payload 的 reason，不是给人看的说法。
  - 影响面：只影响登录页那一句文案，不影响收敛行为与收流行为（1h 的功能断言本身通过）。

### 8.1 EXP-01 修复记录（单场景复测：20260928T040019Z-e88c；**统一重跑全量复验：20260928T043453Z-140a**）

修法：两条候选里选「事件订阅不再把 reason 当 detail 传」—— 不采用 errorText 白名单那条。

- 改动文件：
  - `src/identity/useIdentity.ts`：事件订阅的失败收敛由 `absorb({ ok:false, error: intent.errorCode, detail: event.reason }, "unauthenticated")` 改为 `absorb({ ok:false, error: intent.errorCode }, "unauthenticated")`。本工单净改动 = **1 行调用改写 + 2 行说明注释**（该文件 git diff 里其余行是第三批既有未提交改动，未回退）。
  - `tests/identity-session-expired-ui.test.mjs`：**只新增** U5 / U6 两组断言（U1–U4 一行未改、期望值一个未改）。
  - 未动的：`src/identity/types.ts`（errorText 与身份域一个字节未改）、`electron/**`、`experiments/d5-03/mcp-expiry-e2e.mjs`、其它门禁脚本。
- 为什么不用白名单：白名单只会放行 idle-expiry / absolute-expiry 这类**域内/运维**说法，登录页仍会出现「（idle-expiry）」这种带内部词的括注，与「到期就显示规范那一句」冲突；而且会连带改掉命令失败路径既有的括注行为，不是最小改动。
- 旧 / 新文案原文（同一状态：会话空闲自然到期后的登录页 `[data-d3-id="auth-error"]`）：
  - 修复前（首轮真机实测 20260928T035051Z-5aef）：`登录状态已过期，请重新登录。（idle）`
  - 修复后（复测真机实测 20260928T040019Z-e88c）：`登录状态已过期，请重新登录。`
- 新增断言清单（只加不删）：
  - **U5** · 到期事件给用户的就是规范那一句，内部枚举（idle / absolute / SESSION_EXPIRED）一个都不出现：① 交给 absorb 的失败结果等于 `{ ok:false, error:"SESSION_EXPIRED" }`、**没有 detail**；② `errorText(码, detail)` 的产出 === `IDENTITY_ERROR_TEXT.SESSION_EXPIRED`（逐字锁定规范那一句），且不含 idle / absolute / SESSION_EXPIRED / expired；③ 源码锁：`/detail:\s*event\.reason/` 不得出现在 useIdentity.ts；④ absorb 调用形状仍是 `absorb({ ok:false, error: intent.errorCode }, "unauthenticated")`（与 U4 同口径）。
  - **U6** · 既有四类事件（logged-out / locked / unlocked / session-changed）行为不变：不写错误、登录页不产出任何解释行；到期仍是唯一写错误的那条（与旧实现一致）。
  - 先红后绿（不是补一条永远为真的断言）：修复前 U5 在 ③ 上失败 —— `事件 reason 是运维口径，不得当 detail 传给 absorb` expected false / actual true，U1–U4 全绿；修复后 27/27 全绿。
- 收敛行为一个字节没变：identityEventConvergence 与 absorb 的状态迁移一行未改；复测 1e/6a 仍是 phase → unauthenticated + 恰好 1 条 identity/session-expired + 恰好 1 条 expire 审计；U1–U4、E1–E12、L1–L9 全绿。
- 运维口径保持不变（本缺陷范围外）：复测 1g 连接日志 SESSION_ENDED 恰好 1 条且 `detail = expired:idle`（绝对到期 `expired:absolute` 由 tests/d5-03-mcp-lifecycle.test.mjs L9 锁定）；事件 payload 的 reason 仍原样发出，只是不再进用户文案。
- 复测证据：runId `20260928T040019Z-e88c-mcp-expiry-e2e`；counts **25 / 25（fail 0）**、notVerified 0、defects 0、exitCode 0；产物 `artifacts/d5-03/runs/20260928T040019Z-e88c-mcp-expiry-e2e/mcp-expiry-e2e.json`，sha256 `98d67724c0af165d4ce5577bd070700242eb5c05bdec764b57978897b8f984e0`；偏差 1ms、事件送达延迟 3ms、收流 23ms；1h 实测 `authError = "登录状态已过期，请重新登录。"`；Z1 既有证据未被触碰（changedExisting = []、removed = []）、Z2 本次自建 userData 已删（oa-d503b-20260928T040019Z-e88c-GczShI，oa-d503b-* 残留 0）。
- 单元测试与构建：`node --test tests/identity-session-expired-ui.test.mjs tests/identity-session-expiry.test.mjs tests/d5-03-mcp-lifecycle.test.mjs` → **# tests 27 / # pass 27 / # fail 0 / # skipped 0**（修复前同一命令为 25/25）；`npm run build`（tsc --noEmit + vite build）**EXIT=0**。
- 遗留与口径（如实）：
  1. ~~修复轮**只重跑了 idle 场景**（本工单要求的范围），未重跑 extend / absolute / relogin / regress / 7a / 7b，也未重跑 §6 三个既有门禁；报告中那些行的计数与 runId 仍是首轮（8cbf8df2）结果，未被本次改动覆盖或改写。~~ **【已由「统一重跑」消除】** 统一重跑已在修复后的同一份代码上把 6 个场景 + 3 个门禁全部重跑（§2 / §6 本轮行），**当前有效证据 = 本轮 9 个 runId**；首轮行按工单要求逐条保留并标注「首轮=修复前」，未被删除、也未被冒充成本轮。
  2. `errorText` 仍是通用括注实现：命令失败路径的 detail（idle-expiry、session-missing 等）照旧显示。本工单只修「事件 reason 被当 detail 传进用户文案」这一条根因，未扩大或改写错误文案口径。
  3. 修复轮复测重出了 idle 场景的浅 / 深 / 减少动态效果三张截图（同状态同页面，对比度浅 4.94:1 / 深 6.30:1，与首轮一致），产物在本次新 runId 目录下。

口径说明（不算缺陷，但交付时必须一并说明）：

1. 「客户端在途请求 0」的真机口径：本轮用**服务端侧**证据（每个 POST 流都已由客户端释放、GET 流 1→0 且打开次数停在 1）+ 重新登录后 mcp/get 不再有 getStream；主进程客户端的精确 inflightRequests 计数**没有渲染层出口**，该数字由单测 tests/d5-03-mcp-lifecycle.test.mjs L6 断言为 0。
2. 「工具名/描述/参数/hash 0 投影（DOM 与 DB 两处）」的口径：未认证窗口内 DOM 全页 0 命中、命令面 0 连接数据（这是产品自己的投影路径）；重新登录后详情页显示的是**权威记录里的能力快照**（mcp_connections.tools_json / tools_hash 属连接记录，不是活投影，产品设计如此），此时**活投影** getStream 为空、DB status = DISABLED。若按「DB 里连能力快照也必须清空」理解则该条不成立 —— 本报告按「活投影为 0」判定，并把这个区别写在 1l 的证据里。

脚本自身修正（都是验收脚本的口径/读取问题，**未改任何产品代码**；中间有 3 次失败运行留在 index 里可查）：

- 20260928T034844Z-5b3f（override-deny 首次）：断言把 idle_expires_at − created_at 当默认值比，忽略了登录后 #touch 的毫秒漂移 → 改成「绝对上限按 created_at 精确比 + idle 期限按 last_seen_at 精确比」。
- 20260928T034906Z-12f5（idle 首次）：属性名写成 lightView.localStorage.oa-opaque（被解析成减法）→ 抛 ReferenceError，改成方括号取值。
- 20260928T034945Z-7208（idle 第二次）：--dur-quick 读的是 document.documentElement（:root 的 0.16s），而 .reduced 作用域才压到 0ms → 改成读元素自身计算样式；同时把 4.2s 稳定性对比里 fixture 自身的观测口计数 http.requests / http.stateRequests（本脚本轮询 /__state 造成的）剔除。

---

## 9. 边界声明

全程只连自建受控 fixture（tests/fixtures/mcp/echo-server.mjs，只监听 127.0.0.1 动态端口；本地 stdio 走白名单 serverKey → 固定 entry/args），不连任何真实第三方服务、不发送用户数据、不运行任意第三方本地程序。连接/启用/登出/锁屏/撤权重授全部走真实产品入口（界面表单 + window.openarc.mcp.command + governance.command + identity.command 只读活动），DB 只做只读检查（DatabaseSync readOnly），**没有直接改库构造任何状态**。工具调用入口仍全部 MCP_TOOL_INVOCATION_NOT_ENABLED；协议仍 2025-06-18。本报告不声称插件隔离通过（属 D5-04）。

---

## 10. 产物索引

脚本：experiments/d5-03/mcp-expiry-e2e.mjs

**本轮（统一重跑 · 最终口径）—— 当前有效证据：**

| 场景 | runId | 产物 JSON（artifacts/d5-03/runs/<runId>/） | artifact sha256（全值） | 截图 |
| --- | --- | --- | --- | --- |
| idle | 20260928T043453Z-140a-mcp-expiry-e2e | mcp-expiry-e2e.json（+ .sha256 / .log） | `ccf7ce7531e935f466e470ae6eb99c7ec7c2d9c3da86f16aac2b1c80f27e5704` | light-session-expired.png / dark-session-expired.png / dark-reduced-session-expired.png |
| extend | 20260928T043517Z-7ab7-mcp-expiry-e2e | mcp-expiry-e2e.json（+ .sha256 / .log） | `cae60a6e0ead7186304ac25696edcd89e2ecdcbc524c215accb74013c4415c3c` | — |
| absolute | 20260928T043538Z-4e4c-mcp-expiry-e2e | mcp-expiry-e2e.json（+ .sha256 / .log） | `6f3c8f7400a22611bfcc8d34a61c3a3dfe53467e62ac4fb5d9728fc04f7b1681` | — |
| relogin | 20260928T043554Z-e52c-mcp-expiry-e2e | mcp-expiry-e2e.json（+ .sha256 / .log） | `f85d1fdd654ea7c7e8f02a8b19d449a6d6b317ef595d86532fc9f2b0a9b170c3` | — |
| regress | 20260928T043611Z-561b-mcp-expiry-e2e | mcp-expiry-e2e.json（+ .sha256 / .log） | `eb6f7f3f59c16bbe1bc01b798f96b475970dfd4a4a04d1b303b374acda9c40a1` | — |
| override-deny | 20260928T043615Z-3f55-mcp-expiry-e2e | mcp-expiry-e2e.json（+ .sha256 / .log） | `7f62fa4cee268e1d961e0ce018fee1cd77a0f15d2b50e5b6e7b45de7b50f3db6` | — |
| 门禁 mcp-center-e2e | 20260928T043622Z-b4df-mcp-center-e2e | mcp-center-e2e.json（+ .sha256 / .log） | `2f1ac645d20641bd13f7489ad93dd374f319cbfc8ca35efeb919f310b11cadaf` | 门禁自带浅/深视觉组 |
| 门禁 mcp-stream-e2e | 20260928T043657Z-8d65-mcp-stream-e2e | mcp-stream-e2e.json（+ .sha256 / .log） | `699aae6b216fd94c9c5c2474356c1ae31d8ff911d0a4991894db63faae7393e8` | — |
| 门禁 mcp-policy-e2e | 20260928T043724Z-25c6-mcp-policy-e2e | mcp-policy-e2e.json（+ .sha256 / .log） | `8cd21321c64cab38d046b12c1ea0d5511bdb9ded730918be9704731e379cb95b` | 门禁自带 policy-visual 组 |

**首轮（修复前）—— 历史行，逐条保留备查（不再作为交付证据）：**

| 场景 | 产物 JSON（artifacts/d5-03/runs/<runId>/mcp-expiry-e2e.json） | 截图 |
| --- | --- | --- |
| idle | 20260928T035051Z-5aef-mcp-expiry-e2e | light-session-expired.png / dark-session-expired.png / dark-reduced-session-expired.png |
| idle（EXP-01 修复后复测） | 20260928T040019Z-e88c-mcp-expiry-e2e | light-session-expired.png / dark-session-expired.png / dark-reduced-session-expired.png |
| extend | 20260928T035120Z-b180-mcp-expiry-e2e | — |
| absolute | 20260928T035142Z-6466-mcp-expiry-e2e | — |
| relogin | 20260928T035158Z-b8fc-mcp-expiry-e2e | — |
| regress | 20260928T035219Z-4daa-mcp-expiry-e2e | — |
| override-deny | 20260928T035229Z-a761-mcp-expiry-e2e | — |

每个产物 JSON 内含：runId、被测提交/分支、注入的 TTL + ack 状态、measures（每个到期点的 dueAt / revoked_at / 偏差 / 事件延迟 / 收流耗时）、dbSnapshots（sessions + mcp_connections + mcp_connection_logs + audit_log 只读快照）、uiTexts（登录页文案、说明行文案）、checks（逐条断言，含期望与实际）、notVerified / observations / productDefects、cleanup（userDataDirsRemoved 等）、sourceFingerprint（逐文件 sha 与 missing/modified 标注）。
