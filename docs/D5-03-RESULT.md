# D5-03 · MCP 中心结果（2026-09-28）—— 第三批（Streamable HTTP 流式收口 + 生命周期收尾）+ 第二批 + 第一批

> **本文件三部分**：**第三批（Streamable HTTP 流式收口 + 生命周期收尾）** 是本文正文（本批新证据与判定；被测提交 `1b78953`，本批验收脚本提交 `0aa4027`）；**第二批（MCP 授权收口，`360d94b`）** 与 **第一批（连接管理与能力发现，`d583154`）** 的原文保留在文末「附一」「附二」里，其中被后批改写的口径已就地标注 **【第三批已更新】** / **【第三批订正】** / **【第二批已更新】**。历史段落里的根目录 artifact 路径、静态 CDP 端口（9811/9812）、145/145 回归口径都只作历史，**当前有效证据以正文 §2 本轮 runId 目录为准**。第一/二批的既有结论按「不删改、只加注」处理。
> 第三批口径（用户明确定范围）：**只做 Streamable HTTP 流式收口**（POST / GET SSE、断线续传、重复事件去重、半包与超大事件、有界失败、会话失效不自动重连）**与生命周期收尾**（登出 / 锁屏 / 关应用 / 停用删除 / 撤权即时收流）；**不开放工具调用、不连真实第三方、不运行任意第三方程序、不发用户数据、不声称插件隔离通过**；**本批不新增「创建组织」产品入口**（用户明令）。文中数字全部来自真实运行输出 / 本轮 run 目录 artifact；没有实测到的项一律进「未验收」，不美化。
> **判定：D5-03 第三批（Streamable HTTP 流式收口）= PASS（限定范围）；D5-03 整体仍 = PARTIAL**（剩余缺口逐条见 §10 / §12）。

## 第三批（Streamable HTTP 流式收口 + 生命周期收尾）· 2026-09-28 · 被测提交 `1b78953`

### 1. 提交链

| 提交 | 内容 |
| --- | --- |
| `c2e96c1` | 第二批（MCP 授权收口）文档与证据定稿（同时是本批 R3 重基线的起点） |
| `3590f27` | Streamable HTTP 流式收口（POST 持续 SSE / GET SSE / 续传 / 去重 / 有界失败）+ 门禁运行证据隔离（`experiments/d5-03/run-artifacts.cjs`、独立 runId 目录与索引） |
| `1b78953` | **生命周期收尾接线（被测提交）**：关应用有界 dispose、登出/锁屏事件收流、撤权即时收流、`MCP_SESSION_ENDED` 口径 + 新增 `tests/d5-03-mcp-lifecycle.test.mjs` |
| `0aa4027` | **本批最后一次提交（HEAD）**：流式真机验收脚本（`experiments/d5-03/mcp-stream-e2e.mjs`，29 项）+ policy 门禁重基线（H2 驱动 / R3 白名单式） |

分支 `integration/ui-core`；未 push、未合并 main、未切分支。三个门禁 artifact 都记 `testedCommit=1b789537442e8eeafcaddfa291920cdc7a47c404`、`openarcBranch=integration/ui-core`、`gitDirtyLines=2` —— 那 2 个未提交文件就是本批的两个验收脚本（`mcp-policy-e2e.mjs` 重基线、`mcp-stream-e2e.mjs` 新增），随后提交成 `0aa4027`；产品源码 12 条指纹全部 `status=ok` / `inTestedCommit=true` / `worktreeMatchesCommit=true`（见 §3）。

### 2. 三门禁同轮（顺序 center → stream → policy；policy 的 R 段读本轮 center）

| 门禁 | runId | 命令 | counts | 退出码 | artifact sha256 | notVerified |
| --- | --- | --- | --- | --- | --- | --- |
| mcp-center-e2e（第一批回归） | `20260928T020242Z-fd67-mcp-center-e2e` | `node experiments/d5-03/mcp-center-e2e.mjs` | **38 PASS / 0 FAIL / 38** | 0 | `83d8e6ab49edd63d9d88f64c799f1e8f1c1523e336f605ec782fba915bab66bf` | **0 条** |
| mcp-stream-e2e（本批新增） | `20260928T020320Z-8b11-mcp-stream-e2e` | `node experiments/d5-03/mcp-stream-e2e.mjs` | **29 PASS / 0 FAIL / 29** | 0 | `09e6023f61550d72c36d9f39effde3955d84d964e77f2d1488cac25ccc99cb80` | **0 条** |
| mcp-policy-e2e（第二批回归） | `20260928T020348Z-fb87-mcp-policy-e2e` | `node experiments/d5-03/mcp-policy-e2e.mjs` | **43 PASS / 0 FAIL / 43** | 0 | `df7891ef72abcb02fe057654d1132633f64bbdfae9c83a7393bd342fb9dc2a5b` | **2 条（既有，未清零）** |

* 三个 artifact 的判定字段是 `checks[].status`（值 `PASS` / `FAIL`）+ `expected` / `actual`；三份 `counts` 声明、`len(checks)` 与 `exitCode` **三者一致**（本交付执行岗独立复算）。
* 三次运行的清理口径都是 `own-pid-tree-only`、`leftovers: []`、`pkillUsed: false`；三次各自独占 CDP 端口（center `9811`（`cdpPorts:[9811]`）、stream `9841`（`cdpPorts:[9841]`）、policy `9812–9819`（`cdpPortProbes` 8 条，逐实例探测），userData 前缀 `oa-d503-*` / `oa-d503s-*` / `oa-d503b-*`，互不共享状态。
* 脚本 sha256（供复核）：`experiments/d5-03/mcp-policy-e2e.mjs` = `56b9ba59ee896864f2922785749eda9bc525a765ba7f3088de116b2e04e798af`（与 policy artifact 的 `scriptSha256` 一致）；`experiments/d5-03/mcp-center-e2e.mjs` = `ee27d1c50580b46b44beffde3efb52d95e7b02dec1980f41149eadd25d8750d5`（policy artifact 的 `firstBatch.scriptSha256` 同一值）。
* **政策 / 顺序事实**：三次运行在时间上首尾相接（center 02:02:42–02:03:20、stream 02:03:20–02:03:47、policy 02:03:48–02:04:12），即 Electron 批次**串行执行**；policy 的 `firstBatch.artifactPath` 指向**本轮** center 的 run 目录（不是上一轮）。

### 3. 新证据布局（本批门禁修复，取代根目录可变 JSON）

* **每次运行独立目录**：`artifacts/d5-03/runs/<runId>/` 放 artifact JSON + 日志 + `.sha256` + 截图；索引只追加 `runs/index.json` 与 `runs/index.jsonl`（`experiments/d5-03/run-artifacts.cjs` 的 `createRun` / `finalize` / `appendIndex`，同一 runId 绝不改写）。**根目录不再写入可变 JSON**；`artifacts/d5-03/*.json` 现有 3 个文件（`mcp-center-e2e.json` / `mcp-policy-e2e.json` / `mcp-policy-e2e.sibling-run.json`，mtime 2026-09-24）只作**历史**引用。
* **CDP 端口每次独占探测**：`acquirePort(base)` 从基址递增、以 `127.0.0.1` 独占监听探测并**占住**候选端口，Electron 真正 spawn 前才释放；每次探测写 `cdpPortProbes`。本批实测端口都是运行期动态值（不是写死的静态端口）。
* **源码指纹集扩大为 14 条**（center / policy 各 14 条；stream 15 条 = 多自己一条），其中 **产品源码 12 条**（`electron/` 的 mcp-bootstrap / mcp-client / mcp-domain / mcp-service / mcp-store、identity-store、authorization-store、authorization-service、governance-service、executor-launcher，加 `tests/fixtures/mcp/echo-server.mjs`、`src/mcp/McpCenter.tsx`）**全部 `status=ok` / `inTestedCommit=true` / `worktreeMatchesCommit=true`**；`experiments/d5-03/mcp-center-e2e.mjs`（tracked 且未改）同为 ok。
* **脚本自身的指纹"未提交"标记（诚实自报，不是内容不一致）**：`mcp-policy-e2e.mjs` 在三份 artifact 里都是 `inTestedCommit=true` / `worktreeMatchesCommit=false` / `status="modified"`（重基线当时未提交）；`mcp-stream-e2e.mjs` 在 stream artifact 里是 `inTestedCommit=false` / `status="untracked"`（新文件当时未跟踪）。执行岗独立复算 sha256_16：policy `56b9ba59ee896864`、stream `6af0115d62fd1e3c`，与提交 `0aa4027` 当前内容**逐字节相同**。
* **指纹集整体 sha256**：center 与 policy 同为 `0b4356929ad08ce446f81b57ab875a63c6ff8c58851e21d671a16387dd9839e6`；stream 为 `b7244f7ce64b9aed0a1bca6e37b2f1c3f252d14e5cf01dd29a8ff5c583488f57`（含自身脚本）。
* **当前有效值以本轮 runId 目录为准**，历史轮次（第一批 `dca23cb7…`、第二批 `d4af5e9c…` / 并发覆盖 `0c9ea8e5…`、第三批首轮 `f32c1226…`）只作历史；索引里另有 5 个第三批早期 run（含首轮 26/29 与两次全绿重跑）。

### 4. 流式收口实测（stream 台架，29 条全 PASS）

| 场景 | 实测（artifact `actual` 原文摘录） |
| --- | --- |
| **持续 POST SSE**（服务端回响应事件后继续推通知、流不结束） | `mcp/connect` **29ms** 完成（脚本判定 < 4000ms，客户端超时上界 `requestTimeoutMs=8000`）；服务端 `{"streams":2,"notifications":2,"closedByClient":2,"openStreams":0,"droppedByServer":0}`；记录 `READY` / `lastErrorCode=null` / `toolsHash` 与参照值一致 —— **"等整段 SSE 结束"的缺陷已修** |
| **GET SSE**（服务端支持） | `getStream {supported:true,state:open,status:200,error:null}`；收到通知后（`events.total=4`）仍 `READY` + `lastErrorCode=null`；服务端 `opens=1 / openStreams=1` |
| **GET 405**（服务端不支持 server→client 流） | `getStream {supported:false,state:unsupported,status:405,error:null}`；连接仍 `READY` + `lastErrorCode=null`；随后 `mcp/test` 仍 ok（工具哈希一致，test 后仍 READY）—— **POST 未被连带判死** |
| **带事件 ID 的断线续传** | 服务端 `lastEventIdSeen="3" / replayedFrom=3 / replays=1 / closesByServer=1 / opens=2 / distinctSent=4`；客户端 `reconnects=1 / hasLastEventId=true / duplicates=0 / total=4`，流仍 `open` |
| **无事件 ID 的断线** | 服务端 `lastEventIdSeen=null / replays=0`（`opens=2` 证明确实重连过）；客户端 `hasLastEventId=false / duplicates=0`——**不续传、不重放** |
| **重复事件** | 服务端 `duplicatesSent=2 / distinctSent=2` → 客户端 `duplicates=2 / total=2`（按 `(channel,id)` 去重，**不当成新结果**） |
| **半包跨 chunk** | 服务端按 5 字符分片写入，`splitWrites=134` → 客户端拼接出匹配响应，`connectMs=464`、`READY`、工具表 2 条、`toolsHash` 一致 |
| **超大单事件** | 单事件 393216B > 上界 262144B → `MCP_STREAM_EVENT_TOO_LARGE`（**11ms**）；记录 `ERROR` + 同码；服务端 `byMethod.initialize=1`（**未重发**）、`openStreams=0` |
| **无响应超时** | 服务端只推通知、永不回匹配响应 → `MCP_TIMEOUT` 实测 **8007ms**（上界 8000ms），期间 **79 条通知**；记录 `ERROR/MCP_TIMEOUT`，客户端释放流（`closedByClient=1`） |
| **服务端→客户端请求** | HTTP 下真的把 `-32601` POST 回去：服务端侧实收 `{"sent":1,"responses":[{"id":"srv-1","code":-32601}]}` |

* 新错误码（A3 逐条自检存在于 `electron/mcp-domain.cjs` 的 `ERROR_CODE`）：`MCP_STREAM_INTERRUPTED`、`MCP_STREAM_EVENT_TOO_LARGE`、`MCP_SESSION_EXPIRED`、`MCP_SESSION_ENDED`（后两者与会话/生命周期同批）。
* **协议版本仍是 `2025-06-18`**（未升级）；边界②实测三处一致：`{"record":"2025-06-18","clientConstant":"2025-06-18","domainConstant":"2025-06-18"}`（全文扫描无 `2024-11-05` / `2025-03-26` 残留）。

### 5. 会话失效与"不自动重连"

* **POST 侧失效**（404 + session 信号）：`MCP_SESSION_EXPIRED`（**15ms**）、记录 `ERROR` + 同码、无 `getStream`（不 live）；**2.5s 后服务端计数不变**（`session.created=1/expired=1`、`byMethod.initialize=1`、`posts=3`）——不自动重连 / 不自动重发。
* **GET 流重连 404**（曾跑通的流回 404）：服务端 `reconnect404=1`、`opens` 停在 1、`openStreams=0`；记录 `ERROR/MCP_SESSION_EXPIRED`、`getStream=null`——同样不自动重连。
* 流中断（服务端 destroy 且无响应）由单元级 `tests/d5-03-mcp-stream.test.mjs` S5 钉住 `MCP_STREAM_INTERRUPTED` 且请求级不重发。

### 6. 生命周期收尾实测（登出 / 关应用 / 停用删除 / 撤权）

| 场景 | 实测 |
| --- | --- |
| **登出**（真实 UI 顶栏退出） | 服务端 `getSse.openStreams` **1→0**；DB `enabled=1 / status=DISABLED / last_error_code=MCP_SESSION_ENDED`；日志 `SESSION_ENDED detail=logout`；重新登录后详情页显示"会话已结束…"（`data-mcp-note=session-ended`），`enabled` 仍显示"已启用"，再 `mcp/connect` → `READY`（**213ms**） |
| **关应用**（退出前有活连接 GET 流 + 在途 POST 流） | 走 `page.close()`（关窗 → `window-all-closed` → `app.quit` → `will-quit`）；退出码 **0**（无信号）、`quitMs=80`；主进程 stdout 留痕 `{"ok":true,"closed":1,"aborted":1,"ended":1,"error":null,"failures":[]}`；服务端两条流全部归零；无后代进程残留 |
| **停用 / 删除**（HTTP，带 GET 流） | 停用后服务端 `openStreams=0`、记录 `DISABLED/enabled=false`、`mcp/connect` = `MCP_CONNECTION_DISABLED`；删除后界面列表与 DB 都不再有该记录 |
| **停用 / 删除**（本地 stdio） | 连接期间新起的受控子进程（pid 57070 = Electron + 仓库 fixture `--stdio`）停用后全部退出；删除后 DB 无记录、无残留，`mcp/connect` = `MCP_CONNECTION_NOT_FOUND` |
| **撤权** | 不发任何 mcp 命令流就被立刻收掉（服务端 `openStreams` **1→0**，`collectedWithoutAnyCommand=true`）；随后 `mcp/list｜get｜connect｜test` 全 `MCP_UNAUTHORIZED`；DB `ERROR / MCP_UNAUTHORIZED`；工具名 / 描述 / 参数 / hash / DOM 工具表 **0 投影** |
| **重授 view-only** | `toolsHidden=true / tools=[] / toolsHash=null`；DOM 0 行 0 命中；`mcp/connect` 仍 `MCP_UNAUTHORIZED`（缺 `mcp.use`） |
| 单元级（`tests/d5-03-mcp-lifecycle.test.mjs` L1–L5） | L1 登出收流且 `enabled` 不被改写、L2 锁屏同样收流（不是留到解锁）、L3 撤权即时收流且后续命令拒、L4 dispose 幂等 + 关应用有界超时不阻塞退出、L5 登出中止在途握手（状态如实 `DISABLED + MCP_SESSION_ENDED`） |

### 7. 生命周期状态策略（为什么这么定）

* **不新增第六状态**：新增状态会强制 schema **v22 重建表**，并使 8 个冻结断言失效；现有 `enabled`（用户意图）与 `status` 已够表达"非故障的会话结束"与"权限失败"两类语义。
* **登出 / 锁屏 / 关应用 → `DISABLED + MCP_SESSION_ENDED`**：`enabled` 不改写（用户"启用"意图保留），详情页给人话说明 + 连接日志 `SESSION_ENDED`；重新登录后可再次连接。
* **撤权 → `ERROR + MCP_UNAUTHORIZED`**：这是权限失败，不是会话结束；连接日志同时记 `AUTHORIZATION_REVOKED`。
* **在途握手被收尾中止不再伪装成超时 / 不可达**：收尾路径用明确的中断码（`MCP_STREAM_INTERRUPTED` / 会话码），不会冒充 `MCP_TIMEOUT` 或 `MCP_UNREACHABLE`。
* 接线位置（`1b78953`）：`electron/main.cjs` `will-quit` 先有界 `await disposeMcpBounded(2s)` 再停 modelProxy / 关 store（超时或异常不阻塞退出）；`electron/mcp-bootstrap.cjs` 的 `attachMcpSessionLifecycle` 监听既有 `identity/logged-out` / `locked` 事件做 dispose，装配在 `identity-bootstrap` 唯一路径（产品与探针共用）；撤权走 `authorization-service` 的 `onAppGrantRevoked` 唯一漏斗 → 过滤 `resourceType=mcp` → `mcp-service.closeAppConnections` 同步摘活连接并 abort 在途握手。

### 8. 边界（本批"没做什么"怎么证明）

* **不开放工具调用**：5 个调用入口（`mcp/callTool` / `mcp/call` / `mcp/invoke` / `mcp/invokeTool` / `mcp/toolCall`）× 2 种形状（nested / flat）仍全部 `MCP_TOOL_INVOCATION_NOT_ENABLED`；未登记命令仍 `MCP_COMMAND_NOT_ALLOWED`。
* **不发用户数据 / 不跑任意第三方程序**：stream artifact `boundary = {thirdPartyServices:false, userDataSent:false, arbitraryLocalPrograms:false, pluginIsolationClaimed:false}`（note：只连自建 fixture，流式收口通过 ≠ 插件隔离通过）；policy artifact 另有 `databaseWritesByProbe:false / writesOnlyByProduct:true`（验收对库只读，所有写入都走产品命令路径）。
* **只连自建受控服务**：全部 MCP 连接端点指向仓库 fixture（stdio 白名单 `serverKey=openarc-test-echo` + `127.0.0.1` 动态端口，本轮 HTTP 实例如 `56124 / 56127 / 56137…`，全部只监听 `127.0.0.1`）。
* **不声称插件隔离**：`pluginIsolationClaimed=false`；插件隔离属 D5-08。

### 9. 门禁重基线披露（逐条，不隐瞒）

| 变更 | 内容 | 对判定的影响 |
| --- | --- | --- |
| policy 脚本 **H2 驱动**（H 段） | 只补**一次真实 `mcp/connect`** 前置：重授四动作后先真实连回 `READY`，再收窄成 `view-only`（`H1` 是 grant 收窄、不是 revoke，按第三批契约不收流）。**H2 判定与 `expected` 一字未动** | 无（判定强度不变；全文件 44 个 `record` 调用点 id 序列与 `c2e96c1` 完全一致，执行岗 `diff` 复核） |
| policy 脚本 **R3 重基线** | 基线由 `d583154` 改为 `c2e96c1`，并改**白名单式**：仅允许 `src/mcp/McpCenter.tsx`；只增不删（`numstat=8\t0`）；补丁必须含 `MCP_SESSION_ENDED`；**白名单外任何 `src/` 改动 FAIL**；`git` 拿不到 diff 时 fail-closed（判 FAIL）。K 段级联判据原样 | 无（判据更严，不是放宽；R3 实测 `srcDiffOutsideWhitelist=[]`、`srcWhitelistAddOnly=true`、`kFailures=[]`、`kAllCascade=true`） |
| 其余判定 | policy 43 条里**只有 R3 的判定被重写**，其余 **42 条判定逐字未动**；center 38 条判定未动（脚本 sha256 `ee27d1c5…` 与 policy `firstBatch.scriptSha256` 一致） | 无 |

重基线原因：第三批在 `1b78953` 合法改了渲染层一行说明（`src/mcp/McpCenter.tsx` 的"会话已结束"提示），旧 R3 的"`src/` 零改动"判据已过期。

### 10. 未验收与缺口（逐条，不美化）

1. **notVerified 未清零**：`mcp-policy-e2e` **2 条**（同一安装内第二个组织无产品入口 → 跨组织行为级只到 schema + node 级）；`mcp-center-e2e` **0 条**；`mcp-stream-e2e` **0 条**。
2. **本批不新增"创建组织"产品入口**（用户明令）；因此上述 2 条 notVerified 仍然无法在真机构造。
3. 既有缺口继续单列：**OAuth**（只有 `NONE` / `BEARER`）、**真实第三方服务与 Adobe / PS 等本地服务**（D5-04 / D5-05）、**插件隔离**（D5-08，连接成功 ≠ 插件隔离通过）、**`BASELINE_POLICY_PROVIDERS` 手工对齐、无漂移守卫**、**`app_policy_provisions` 无清理策略**、**D5-02 的「重命名依赖 Electron 不支持的 `prompt()`」**。
4. **第三批新登记的残留**：**会话空闲过期没有身份事件** —— 会话自然过期时不触发 `identity/logged-out|locked`，因此活连接要等下一次收尾动作才被收掉；期间靠命令层实时判权拒绝（命令面不会给出越权结果）。**未验收**：无"空闲过期即时收流"的证据。
5. **policy 脚本收尾留 2 个 `oa-d503b-*` 临时目录**（既有行为，脚本不在本批允许改动范围内；如实登记）。
6. **证据归因订正（第三批）**：第二批文档曾把一次 `Z0 FAIL(exit 2)` 与 CDP 端口冲突记成"另一个并发 DSH 会话"；经复核，那**不是外部会话，就是本任务自己并行跑的批次**。第三批的机制性修复：每次运行独立 `runId` 目录、每次 `acquirePort` 独占探测 CDP 端口、只清理自己的 pid 树（`own-pid-tree-only` / `pkillUsed:false`）、Electron 批次**串行执行**。历史 artifact 里当时的文字保留不改（那是当时的记录），文档结论按此订正（附一原文就地加注 **【第三批订正】**）。

### 11. 三轴判定（分列）

* **功能 = 通过**：三门禁同轮 **38/38 + 29/29 + 43/43** 全绿、`exit 0`；真实 `electron .`、真实产品命令面（`window.openarc.mcp.command` 与界面同一命令面）、自建受控 fixture；边界四项自证（§8）。
* **视觉 = 部分通过 / 含未验收**：第三批**新增了一行界面说明**（`src/mcp/McpCenter.tsx` 的"会话已结束（登出 / 锁屏 / 应用退出）…"，`data-mcp-note="session-ended"`），**复用既有 `mcp-muted` 次级文字与既有 neutral 状态徽标；无新 token / 组件 / 颜色 / 动效**（`1b78953` 的 `src/` diff = 8 增 0 删，只有该文件；`styles.css` 未动）。实机截图：`artifacts/d5-03/runs/20260928T020320Z-8b11-mcp-stream-e2e/visual/session-ended-note.png` 与 `…/visual/unauthorized.png`。**未验收**：**浅 / 深主题对照**与**对比度量测**本批未做 —— 这两项如实标未验收（原因：本批只新增一行文案、无颜色 / token 变化；已有证据是上述两张实机截图 + 中心台架本轮深色 L1–L5 仍 PASS）。第一批 / 第二批已验的其余界面沿用其结论。
* **动效 = 沿用既有通过结论、本批无新增动效需验**：流式 / 生命周期改动都是**非视觉行为**，本批未新增动效；既有结论不变（插入 / 删除 `--dur-quick=160ms`、减少动态效果 `--dur-quick=0ms` 且删除 4ms、详情按 `connectionId` 重挂载、发现中不造假进度）——引用附二 §6，以及中心台架**本轮** K1–K4 实测（K1 `mcp-row-in / 0.16s`、K2 退场 `mcp-row-out / 0.16s`、K4 `reducedDeleteMs=4` vs `normalDeleteMs=169`）。

### 12. 判定

* **D5-03 第三批（Streamable HTTP 流式收口 + 生命周期收尾）= PASS（限定范围）**：流式 29/29（持续 POST SSE 29ms 完成、GET SSE、GET 405 保留 POST、带/无 ID 续传、重复去重、半包 134 次分片、超大事件 11ms 明确失败不重发、无响应 8007ms 有界、会话失效不自动重连、服务端请求 `-32601`）+ 生命周期真机全绿（登出 / 关应用 / 停用删除 / 撤权 / 重授）+ 第一批回归 38/38 + 第二批回归 43/43；单测 **143/143、exit 0**（本交付执行岗复跑核对：`node --test tests/d5-03-mcp-*.test.mjs tests/authorization-*.test.mjs tests/governance-*.test.mjs tests/identity-store.test.mjs`，其中新增 `lifecycle 5/5`、`stream 8/8`、`get-stream 7/7`）；`npm run build` exit 0（本批执行期间记录为 exit 0，未在本交付复核时复跑以免改写 `distFingerprint`）；**两条预存在失败**（`tests/side-effect-c4-gates.test.mjs`、`tests/d4-03-approval-push-isolation.test.mjs`）继续单列、未改断言。**限定**：`notVerified` 仍 2 条（跨组织真机不可构造）、会话空闲过期无即时收流证据、视觉两项未验收（§10 / §11）。
* **D5-03 整体仍 = PARTIAL**，剩余缺口逐条 = §10 第 2–5 条（OAuth、真实第三方 / Adobe（D5-04/05）、插件隔离（D5-08）、`BASELINE_POLICY_PROVIDERS` 无漂移守卫、`app_policy_provisions` 无清理策略、D5-02 `prompt()` 遗留、跨组织真机入口、空闲过期即时收流）。
* tracked 证据：`docs/D5-03-GATE-EVIDENCE.json` 的 `batch3` 段（三次 run 的 runId / 路径 / sha256 / counts / notVerified / 指纹集 / 重基线 / 边界 / 回归 / 缺口 / 三轴判定）；本批决策 `docs/decisions/D5-03C-streamable-http.md`；第二批决策 `docs/decisions/D5-03B-app-policy-persistence.md`（含第三批更新节）。

---

## 附一：第二批（MCP 授权收口）历史原文（`360d94b`，2026-09-24）

> **本附为第二批当时原文**（§1–§13 原样保留，不删改）；其中被第三批改写的口径已就地加注 **【第三批已更新】** / **【第三批订正】**。本附里的根目录 artifact 路径（`artifacts/d5-03/*.json`）、sha256、`145/145` 回归口径、`9811/9812` 端点都只作历史 —— **当前有效证据以正文 §2 本轮 runId 目录为准**。

### 1. 提交链

| 提交 | 内容 |
| --- | --- |
| `140182f` | D5-03 第一批文档定稿（D5-02 收口 + D5-03 第一批结果与判定） |
| `91bc436` | 撤权持久化（内置策略提供记录 v21）+ MCP 部分授权写路径 |
| `360d94b` | **本批最后一次提交（HEAD，2026-09-24 22:58）**：授权审计归属目标 App；迁移按命名空间归属撤销证据；按新契约更新旧断言 + 本批两个验收脚本 |

分支 `integration/ui-core`；未 push、未合并 main、未切分支。本批执行期间工作树的未提交改动只有一处 = `experiments/d5-03/mcp-center-e2e.mjs` 的 notVerified 文案订正（§9）—— 重跑 artifact 记录的 `gitDirtyLines=1` 就是指它。

### 2. 真机结果（两个台架互不共享状态：独立 userData 前缀 + 独立 CDP 端口）

| 台架 | 命令 | 结果 | artifact | sha256 | notVerified |
| --- | --- | --- | --- | --- | --- |
| 第一批回归（本批重跑，本次文案订正后） | `node experiments/d5-03/mcp-center-e2e.mjs` | **38 PASS / 0 FAIL / 38、exit 0**；`productDefects: []`；Z1 clean | 【第三批已更新：当前有效证据 = `artifacts/d5-03/runs/20260928T020242Z-fd67-mcp-center-e2e/mcp-center-e2e.json`，sha256 `83d8e6ab…`；下行同】`artifacts/d5-03/mcp-center-e2e.json` | **`d8f9a23781ff590aaa395b076defcb1f2cb141eef24618424ed102913b86a2e0`**（`shasum -a 256` 自行复核） | **0 条**（`[]`） |
| 第二批（授权收口） | `node experiments/d5-03/mcp-policy-e2e.mjs` | **43 PASS / 0 FAIL / 43、exit 0**；内嵌 firstBatch **38/38** | 【第三批已更新：当前有效证据 = `artifacts/d5-03/runs/20260928T020348Z-fb87-mcp-policy-e2e/mcp-policy-e2e.json`，sha256 `df7891ef…`】`artifacts/d5-03/mcp-policy-e2e.json` | **`d4af5e9cbf6e7b8b6b8643f67d3dd38d040ee35baabb937fbeb338141c71d831`**（本批执行岗 22:59 与 23:00 两次 `shasum -a 256` 复核，与交付口径一致）—— **注意**：该路径于 23:01:50 被另一个并发 DSH 会话重跑覆盖，当前磁盘值 = `0c9ea8e5187f2cc08e3c823381fb67113aff941df7af90f6534b1e61a69119d6`（同为 43/43、firstBatch 38/38、同一 2 条 notVerified、同一 `scriptSha256`），见 §12 第 7 条。【第三批订正：那次覆盖来自本任务自身并行的批次，不是外部 DSH 会话。】 | 2 条（§10） |

* 重跑 artifact 的运行时事实：`openarcCommit=360d94b7092527ad18ead4b909d507f3efc42208`、`openarcBranch=integration/ui-core`、`gitDirtyLines=1`、`at=2026-09-24T14:59:34.766Z`；`mcpSourceFingerprint` 8 个文件与工作树**逐条相同**（按 `mcp-center-e2e.mjs:86` 的 `fileSha` 复核）；`distFingerprint=./assets/main-Ct-YFunl.js / 371576 bytes / 2026-09-24T14:52:09.743Z`（本批未复跑 `npm run build`，避免改写它）。
* 第二批 artifact 的运行时事实：`openarcCommit=91bc436`、`gitDirtyLines=6` —— 那 6 个未提交文件正是随后提交成 `360d94b` 的同一批改动（`git diff --stat 91bc436 360d94b` = 6 files changed）；artifact 里 7 个源码指纹（`identity-store.cjs` / `authorization-store.cjs` / `authorization-service.cjs` / `mcp-bootstrap.cjs` / `mcp-service.cjs` / `mcp-domain.cjs` / `src/mcp/McpCenter.tsx`）与 HEAD 工作树**逐条相同**，故该轮 43/43 实际受验的就是 `360d94b` 的内容。该台架共启动 8 个真实 Electron 实例（首用 / 跨重启 / 重授后重启 / 再撤销重启 / 新组织 / 新组织重启 / 回第一组织 / v20 升级库）。
* 日志：`artifacts/d5-03/mcp-center-e2e.run-batch3-rerun.log`（末行 `结论：PASS — {"pass":38,"fail":0,"total":38,"notVerified":0}` + `EXIT=0`）与 `artifacts/d5-03/mcp-policy-e2e.log`（后者也被 23:01:50 的并发重跑覆盖，尾行 `结论：PASS — {"pass":43,"fail":0,"total":43,"notVerified":2,"firstBatch":{"pass":38,"fail":0,"total":38},"combined":81}`，判定一致）；`artifacts/` 被 gitignore。

### 3. 目标一：撤权持久（跨登录 / 跨重启 / 只有正式治理入口重授才恢复 / 新组织仍有既定初始授权）

* **撤权即时**（第一批 `H1` 未改；本批重跑仍 PASS）：整条撤销 → `mcp/list`、`mcp/get`、`mcp/connect` 全部 `MCP_UNAUTHORIZED`，界面无权且工具描述 0 暴露。
* **跨登录不复活**（第二批 `C1/C2` + 第一批 `H2` 新契约，都在真机跑过）：登出 → 重新登录（**不重启进程**）后 `mcp/list=MCP_UNAUTHORIZED`；库内该组织 mcp grant 行 **0**；墓碑 `(organization_id, 'mcp-center', 'mcp')` 的 `revoked_at` **非空且等于撤权当时那一刻的值**（登录播种没清掉 / 没改写），`provisioned_at` 保留。重跑 artifact 的 `H2` 现场：`afterReloginList={ok:false,error:"MCP_UNAUTHORIZED"}`、`mcpGrantRowsAfterRelogin=[]`、`provision.revoked_at` 非空。
* **跨重启**（第二批 `D1–D4`）：杀掉整个 Electron 进程树（含 Helper）→ 用**同一个 userData 目录**重启（新 pid、端口已释放）→ 登录后 `mcp/list`、`mcp/get`、`mcp/connect` 仍全部 `MCP_UNAUTHORIZED`；界面工具名 / 描述 / 参数 / hash 0 命中；库内 mcp 行仍 0、`revoked_at` 与撤权当时**同一个值**。
* **只有正式治理入口重授才恢复**（第二批 `E1–E4`）：`governance/grantAppAccess(appId=mcp-center, resourceType=mcp, 四动作)` → 落库 1 行 + **清墓碑** + `provisioned_at` 保留 → `mcp/list` / `mcp/get` 可用、`toolsHidden=false`、工具表 2 行；重授后**再重启仍然有效**；再次撤销 → 再重启 → 仍保持撤销。
* **新组织首次使用仍有既定初始授权**（第二批 `F1/F2`）：全新安装（新 `organization_id`）首用即拿到 mcp baseline（`mcp/list` / `mcp/get` ok、库内 1 行、`provisioned_at` 非空）；该新组织撤销后重启仍撤销 —— 与第一个组织同一口径。
* **阳性对照**：`H0`（授权完整时工具名 / 描述 / 参数 / hash 在 DOM、`mcp/get`、`mcp/testLog` 三面都看得见）与 `H5`（再授 `mcp.use` 立刻可见）证明后面的 0 命中是权限判定，不是「没数据 / 扫描器坏」。

### 4. 目标二：MCP 部分授权（`mcp.view` only，工具描述不外泄）

真机（第二批 `H0–H6`，全部走正式治理入口写路径）：

| 步骤 | 实测 |
| --- | --- |
| `H1` 用正式入口把 mcp grant 置为 `[mcp.view]`（baseline 形状覆盖同一行） | `{"ok":true,"created":false,...}`；库 **1 行**、`actions=["mcp.view"]`、`revoked_at` NULL |
| `H2` 能力面 | `toolsHidden=true`、`tools=[]`、`toolsHash=null`；但**连接状态仍可见**（`mcp/list` ok、状态 `READY`、界面行与状态徽标都在，工具列显示「无权查看」） |
| `H3` 三面 0 命中 | 工具名 / 描述 / 参数 / hash 在 **DOM 文本 + DOM 属性 + `mcp/get` + `mcp/testLog`** 全部 0 命中（含 64 位 hex 与 `hash=`；`faceHits` 四面全 0） |
| `H4` 旁路 | `mcp/connect` / `mcp/test` → `MCP_UNAUTHORIZED`（`reason=app-action-missing`），拿不到工具目录的旁路被堵 |
| `H5` 阳性对照 | 再授 `[mcp.view, mcp.use]` → 工具目录**立刻可见**（`toolsHidden=false`、DOM 工具表 2 行、hash 一致） |
| `H6` | 整条撤销 → 再正式重授 view-only → 三面仍 0 命中（墓碑写过又清） |
| 跨命名空间（`I1`） | mcp grant 里带 `model.*` / `resource.*` / `tool.*`、model grant 带 `mcp.*`、空资源类型 / 空动作 / `permissionSet` → **9/9 `INVALID_INPUT`**，被拒的写入不留任何 grant 行 |
| 越权（`I2` / `I3`） | MEMBER 账号（真实登录）发 `getAppAccess` / grant / revoke → `NOT_SUPER_ADMIN`，库内授权行未被改动；非管理员授 ORGANIZATION scope 的 `mcp.manage` 两种形状都被拒，同一组合只有 SUPER_ADMIN 能过（验完立刻撤销恢复原状） |

**第一批那条 notVerified 的消灭**：本批重跑时第一批脚本里的 `governance/grantAppAccess(resourceType=mcp, actions=[mcp.view])` 返回 `{"ok":true,"created":false,...}`（覆盖同一行），不再是被拒的旧行为。

### 5. 审计归属（本批修复点）

* `J2`：撤销审计行必须记**被撤销授权的那个 App** —— 实测 4 条撤销审计行 `app_id` **全部 = `mcp-center`**（`appIdValues=["mcp-center"]`）；修复前记的是发起治理的上下文 App（`resource-library`，真实缺陷 **D5-03B-D1**，真机 `L3` 复现）。
* `J1`：`authorization_audit` 里 grant / revoke 各有行，`old_permissions` / `new_permissions` 如实 —— 例如 `mcp.view,use,manage,test → [mcp.view]` 的授权行、`[mcp.view,use] → []` 的撤销行、撤销后 `new=[]`。
* `L1` **保留旧缺陷现场**：用 `git archive 140182f` 的 v20 `electron/`（跑它自己的 `createIdentityService` + `governanceService`，**不写一行 SQL**）建出 v20 库并真实撤销一次 → 该库审计行仍是旧口径 `app_id=resource-library`（`old_permissions=["mcp.view","mcp.use","mcp.manage","mcp.test"]`、`new_permissions=[]`）。迁移的归属判据正是要处理这种历史行。

### 6. 升级路径 v20 → v21（真机，第二批 `L1–L3`）

* `L1`：v20 库（`user_version=20`、无 `app_policy_provisions` 表、4 行既有授权）里已发生一次真实撤销，撤销审计行是旧口径。
* `L2`：在该库上启动当前 Electron → **自动迁移到 v21**：`user_version=21`、建 `app_policy_provisions`、`app_resource_grants` 唯一键 = `UNIQUE (organization_id, app_id, resource_id, collection_id, resource_type, department_id, scope)`、**既有授权行 4 → 4 一条不丢**（`noRowLost=true`、`lostRows=[]`）、启动时 `newRowsAtBoot=[]`、主进程无迁移错误。
* `L3`：迁移补写把旧撤销证据归属到 `(organization_id, 'mcp-center', 'mcp')`：`revoked_at` **非空**、`provisioned_at` **空**（= 「有撤销证据、无提供证据」）；升级后登录 `mcp/list` 仍 `MCP_UNAUTHORIZED`、mcp grant 行 0 —— **登录不再复活**。（同一库上 `resource-library`/`model` 的补写方向相反：`provisioned_at` 非空、`revoked_at` 空，可作对照。）

### 7. 契约变更披露（逐条，不隐瞒）

| 变更 | 内容 | 对判定的影响 |
| --- | --- | --- |
| 第一批 `H2` **改写** | 旧 H2 断言的正是本批要修掉的旧语义（「重新登录触发内置 baseline upsert → 权限回来」）；新 H2 断言「**跨登录不复活**（`MCP_UNAUTHORIZED` + 库内 mcp 行 0 + 墓碑 `revoked_at` 非空）+ **正式治理入口重授后恢复**（`toolsHidden=false`、工具表 2 条、界面恢复）」—— 强度高于旧断言 | 只有这一条断言的条件被改写；旧行为已不可能通过 |
| 第一批 `L3` **只插驱动步骤** | 登出 → 登录 → 正式重授（把状态驱回「已授权可用」），**判定条件一字未动** | 无 |
| 第一批 `R1`（在第二批脚本里）**标题文案** | 标题写明「H2 已按新契约更新，其余 37 条一字未动」 | 无（判定只是 counts 38/38） |
| 其余 | 第一批 38 条里**其余 37 条** + 第二批 43 条：判定条件**零改动** | 无 |

### 8. 边界（本批「没做什么」怎么证明）

* **不开放工具调用**：第二批 `K1` —— 5 个调用命令（`mcp/callTool` / `mcp/call` / `mcp/invoke` / `mcp/invokeTool` / `mcp/toolCall`）× 2 种形状（nested + flat）= **10 次全部 `MCP_TOOL_INVOCATION_NOT_ENABLED`**，未登记命令仍 `MCP_COMMAND_NOT_ALLOWED`；第一批 `I1` / `I2` 本批重跑仍 PASS（界面 0 个调用入口、桥只暴露 `command`）。
* **不连真实第三方 / 不运行任意第三方程序**：第二批 `K2` —— 本次全部 MCP 连接端点只指向自建 fixture（`127.0.0.1` 动态端口）；第一批 `J1a` / `J1b` 本批重跑仍 PASS（端点 100% 白名单 key / 本机；子进程命令行为 Electron 运行时 + 仓库 fixture）。
* **不发用户数据**：两个台架都只有连接管理与授权读写，没有工具调用面、没有外发数据。
* **验收全程只读查库**：第二批 artifact 的 `boundary = {thirdPartyServices:false, userDataSent:false, arbitraryLocalPrograms:false, pluginIsolationClaimed:false, databaseWritesByProbe:false, writesOnlyByProduct:true}` —— 探针用 `DatabaseSync` **只读**打开库，所有写入都由产品自己的命令路径完成。
* **不声称插件隔离通过**：`pluginIsolationClaimed=false`；连接成功 ≠ 插件隔离通过（D5-08）。
* v20 建库只用 `git archive 140182f` 的旧代码跑旧服务，不写 SQL、不改当前产品代码。

### 9. 证据订正（必做项）与本轮重跑

* **移除的 notVerified**：`experiments/d5-03/mcp-center-e2e.mjs` 里「『工具描述不暴露』的 mcp.use-only 主路径（toolsHidden=true、mcp.view 仍在）」这一条已**从列表移除** —— 它的旧 reason 现场写的 `governance/grantAppAccess(resourceType=mcp, actions=[mcp.view])` 被拒，本批已修好（真机实测 `{"ok":true,...}`）；该路径现由 `experiments/d5-03/mcp-policy-e2e.mjs` 覆盖（见其 artifact 的 view-only 组 `H0–H6`）。
* **只动这一条**：`git diff` = **4 增 1 删**（原位换成一段注释，注明覆盖来源）；38 条判定的布尔表达式与所有其它字段**一字未动**。
* **重跑**：`node experiments/d5-03/mcp-center-e2e.mjs` → **38 PASS / 0 FAIL / 38、exit 0**；`notVerified: []`（**0 条**）、`productDefects: []`、38 条 checks 全 PASS；新 artifact sha256 **`d8f9a23781ff590aaa395b076defcb1f2cb141eef24618424ed102913b86a2e0`**。
* 订正后脚本 sha256 = `9055e62d014e57b99b4fe24d3f1ca79ddc0b12dfecfd210c5d7fe4e762009970`；订正前 = `e1ce85c5497eebdf4583a924bc25bd2699cbd51b74571fcd7499ac5af28abb02`（第二批 artifact 的 `relation.regression` 文本里记的是这个订正前的值；两版之间只差这条 notVerified 文案，38 条判定与断言值未变，故第二批 `R1` 的第一批 38/38 结论不受影响）。

### 10. notVerified 现状（整体未清零）

* 第一批台架（`mcp-center-e2e`）：**0 条**。
* 第二批台架（`mcp-policy-e2e`）：**2 条**，都是「真机不可构造」类，**不是产品失败**：
  1. **同一安装内的第二个组织（两组织共库）无法用产品入口构造**：真机上「组织」= `teams` 行，只在 `identity/initialize` 里建 root 团队（`electron/identity-store.cjs` 的唯一部分索引 `idx_teams_single_root` 只允许一行 `root=1`）；渲染层可用的命令白名单里没有任何创建组织的入口；`governance/createUser` 又把 `teamId` 钉死在 `gate.user.team_id`。既有 node 测试造「第二组织」是直接 INSERT `teams` —— 那正是本批禁止的「直接改库」。
  2. **跨组织行为级互不覆盖**（同一库里 A 撤销 → B 不受影响，两种登录顺序各验一次）：真机不可构造（同上），**真机只到 schema 级**（`G1`：`app_resource_grants` 唯一键含 `organization_id`、`app_policy_provisions` 主键含 `organization_id`，两个组织的库都验了）+ **node 行为级**（`tests/d5-03-mcp-policy-persistence.test.mjs` 11/11、`tests/authorization-app-grant-scope.test.mjs` 6/6：不同 `organization_id` 各一行、两种写入顺序同结论）。**跨组织真机 = 未验收**，如实标。
* 结论：**整体 notVerified 未清零**；跨组织真机验收需要产品先有「新建组织」入口或多租户安装。

### 11. 回归

| 命令 | 结果 |
| --- | --- |
| `node --test tests/d5-03-mcp-*.test.mjs tests/authorization-*.test.mjs tests/governance-*.test.mjs tests/*-migration.test.mjs tests/identity-store.test.mjs` | **145 / 145 pass、exit 0**（第二批当时复跑，日志 `artifacts/d5-03/regression-batch2.log`）——【第三批已更新：第三批的回归命令不含 `tests/*-migration.test.mjs`，本轮复跑为 **143/143、exit 0**，见正文 §12】 |
| `node --test tests/d5-03-mcp-policy-persistence.test.mjs`（本批新增） | **11 / 11 pass** |
| `node --test tests/authorization-app-grant-scope.test.mjs`（本批新增） | **6 / 6 pass** |
| `npm run build` | **exit 0**（`tsc --noEmit` + `vite build`）；本批执行期间**未复跑**，避免改写第一批 artifact 里记录的 `distFingerprint` |
| 两条**预存在**失败（与本批无关，继续单列、未改断言） | `tests/side-effect-c4-gates.test.mjs:474` / `:444`、`tests/d4-03-approval-push-isolation.test.mjs:94`（已在干净 HEAD 导出树复现） |
| `d583154` → `360d94b` 的 `src/` diff | **空**（第二批 `R3`：本批渲染层一个文件都没改） |

### 12. 证据完整性缺口（如实登记，不掩盖）

1. **第一批 artifact 的指纹集不含本批改动的两个文件**：`artifacts/d5-03/mcp-center-e2e.json` 的 `mcpSourceFingerprint` 仍只 pin 8 个文件（`mcp-{domain,store,client,service,bootstrap}.cjs` / `executor-launcher.cjs` / `src/mcp/McpCenter.tsx` / `tests/fixtures/mcp/echo-server.mjs`，见脚本里的指纹清单），**不含本批实际改动的 `electron/authorization-service.cjs` 与 `electron/identity-store.cjs`**。按执行边界（只允许改那条 notVerified 文案），**脚本指纹逻辑一字未动** —— 因此**不声称第一批 artifact 的指纹覆盖本批全部改动文件**；覆盖这两个文件的是第二批 artifact 的 `fingerprints`（7 条，与 HEAD 工作树逐条相同）。两个台架合起来才可复核本批受验源码。
2. **同一 artifact 路径被重跑覆盖**：`artifacts/d5-03/mcp-center-e2e.json` 每次重跑都会改写，第一批当时的 sha256（`dca23cb7…`）、第二轮（`80d3fc0c…`）只在文档 / 本文「附」里留痕；`artifacts/` 被 gitignore，不随提交保存。**当前有效值以 §2 的 `d8f9a237…` 为准。**【第三批已更新：该“同一路径被重跑覆盖”缺口已由第三批的**门禁证据隔离**修复 —— 每次运行写独立 `artifacts/d5-03/runs/<runId>/`（artifact + 日志 + `.sha256` + 截图），索引只追加（`runs/index.json` / `index.jsonl`，同一 runId 绝不改写），根目录不再写可变 JSON；当前有效证据见正文 §2/§3。】
3. **脚本内仍留第一批的过时文案（不在本轮允许改动范围，登记不改）**：① 原位注释下方仍保留的 `note("最小修法建议（未动手）：…")` —— 写入路径本批已修（`H1` 实测 `partialGrantAttempt={"ok":true,...}` 取代了它），但它是 `observations` 字段、不是 notVerified 列表项，按边界未动，因此新 artifact 的 `observations` 里仍能看到这条；② 第一批 `J1b` 判定**标题**仍带修复前的括号（判定与 PASS 内容都是修复后的正常路径，与「附 §9」第 10 条同一件事）。
4. **环境事件（一行，非产品结论）**：本批执行期间另一个 DSH 会话在同一工作树并发跑同一脚本、抢 CDP 端口，导致一次运行 `Z0 FAIL(exit 2)`，且其 Electron 实例被按前缀误杀；受影响日志保留在 `artifacts/d5-03/*.run-batch3.log` / `.run-final.log`，**最终 artifact 是在端口空出后重跑产生的**。本轮重跑前后 `pgrep -fl "oa-d50"` 均为空、CDP 9811 空闲；脚本只按自己的前缀 `oa-d503-` 清理，没有杀别人的进程。**【第三批订正：经复核，那次并发**不是“另一个 DSH 会话”（外部会话），就是本任务自己并行跑的批次**；“实例被按前缀误杀”的归因一并撤回。保留的事实：曾发生 CDP 端口冲突、一次 `Z0 FAIL(exit 2)`。第三批的机制性修复 = 每次运行独立 runId 目录 + `acquirePort` 独占探测 CDP 端口 + 只清理自己的 pid 树（`own-pid-tree-only` / `pkillUsed:false`）+ Electron 批次串行执行。】
5. **`BASELINE_POLICY_PROVIDERS` 手工对齐**（迁移归属表与三处播种点）：新增 baseline 提供者若忘同步，该 App 的历史撤销会退回「只认审计行 `app_id`」的旧口径 —— **无漂移守卫**（§13 第 6 条）。
6. **`app_policy_provisions` 无清理策略**：记录随组织与 App 数增长（量级很小，见第二批决策文档 §5）。
7. **第二批 artifact 也被并发会话重跑覆盖（环境事件）**：`artifacts/d5-03/mcp-policy-e2e.json` 在执行岗复核（22:59 / 23:00，sha256 `d4af5e9c…`）之后，于 **23:01:50** 被**另一个并发 DSH 会话**在同一工作树重跑同一脚本覆盖 → 当前磁盘 sha256 = `0c9ea8e5…`。两轮判定一致（43 PASS / 0 FAIL / 43、exit 0、firstBatch 38/38、同样的 2 条 notVerified、同一 `scriptSha256=6d19a2eb…`、boundary 同一口径）；差别只在运行时事实：交付口径那轮记 `openarcCommit=91bc436` + 6 个未提交改动（= 随后提交成 `360d94b` 的同一批），覆盖那轮记 `openarcCommit=360d94b` + 2 个未提交改动（本批的脚本文案订正 + 本文档）。**两个 sha256 都如实列出**，不择其一冒充另一；判定与缺口不因这次覆盖改变。**【第三批订正：同 §12 第 4 条 —— 那次覆盖来自本任务自身并行的批次，不是外部 DSH 会话；第三批起不再有“同一路径被覆盖”（独立 runId 目录 + 只追加索引）。】**

### 13. 判定

* **D5-03 第二批（MCP 授权收口）= PASS（限定范围）**：真实 Electron 台架 **43 PASS / 0 FAIL / 43、exit 0**（撤权即时 / 跨登录 / 跨重启 / 正式重授恢复 / 新组织首用 / v20→v21 升级 / `mcp.view`-only 三面 0 命中 / 审计归属 / 跨命名空间与越权拒绝 / 边界），内嵌第一批回归 **38/38**；第一批台架在文案订正后**重跑 38/38、`notVerified` 0 条**；单测 145/145 + 新增 11/11 + 6/6；`npm run build` exit 0；`src/` 零改动。**限定**：跨组织只到 schema 级 + node 行为级（真机未验收）；证据完整性缺口见 §12。
* **D5-03 整体 = PARTIAL**，剩余缺口逐条：
  1. **OAuth**（只有 `NONE` / `BEARER` 两种认证模式）；
  2. 【第三批已更新：**已闭环**】**远程长连接流**（GET SSE / 断线续传）与 streamable HTTP 单响应之外的部分 —— 第三批已真机验收持续 POST SSE、GET SSE、GET 405 不判死、带 / 无事件 ID 的续传、重复事件去重、半包与超大事件、无响应有界超时、会话失效不自动重连（见正文 §4/§5）；协议版本仍 `2025-06-18`；
  3. **真实第三方服务**与 **Adobe / PS 等本地服务**（D5-04 / D5-05）；
  4. **插件隔离**（D5-08）—— 连接成功 ≠ 插件隔离通过；
  5. **第二个组织的真机入口 / 跨组织真机行为级验收**（§10）；
  6. **`BASELINE_POLICY_PROVIDERS` 手工对齐，无漂移守卫**；
  7. **第一批 artifact 指纹集不含本批改动的两个文件**（§12 第 1 条）；
  8. **`app_policy_provisions` 无清理策略**（§12 第 6 条）。
* **D5-02 的「重命名依赖 Electron 不支持的 `prompt()`」仍是 D5-02 的独立遗留**，不并入本批（见 `PROGRESS.md` 的 D5-02 段与其关闭条件）。
* tracked 证据：`docs/D5-03-GATE-EVIDENCE.json`（第一批 38 条 checks + 本批 `batch2` 段：两个 artifact 的路径 / sha256 / counts / notVerified、修复链、契约变更、审计与迁移证据、边界、回归计数）；本批决策：`docs/decisions/D5-03B-app-policy-persistence.md`。

---

# 附二：第一批（连接管理与能力发现）历史原文（`d583154`，2026-09-24）

> 以下 §0–§10 **是第一批当时的原文**，保留作历史；被第二批改写的口径已就地标注 **【第二批已更新】**，被第三批改写的另标 **【第三批已更新】**。三批合起来的判定与剩余缺口见正文 §12。本附里的 `artifacts/d5-03/*` 根目录路径、`9811` 端口、`145/145` 等数字都只作历史。

## 0. 口径与范围（用户明确定范围，本文档不改范围）

**本批 = 连接管理与能力发现**。用户明确：本批**不开放 MCP 工具调用、不运行任意第三方本地程序、不连真实第三方、不发用户数据、不把连接成功写成插件隔离已通过**。
文中所有数字与结论来自命令输出或证据文件；没有实测到的项一律进「未验收 / 缺口」，不美化。

**分支 / 提交 / 工作树**：分支 `integration/ui-core`；首轮验收脚本提交 `4dfe923`（首轮 **34/38**，暴露三个真实产品缺陷 D5-03-D1/D2/D3）；修复提交 **`d583154`**（HEAD；最终门禁在该提交上以**干净代码树**复跑，运行时只有本批 5 个文档未提交，无代码改动）。未 push、未合并 main、未切分支。

**验收代码内容 = `d583154`（干净代码树复跑，2026-09-24 21:54）**：最终门禁用 `OPENARC_TESTED_COMMIT=$(git rev-parse HEAD) node experiments/d5-03/mcp-center-e2e.mjs` 在 HEAD `d583154a7b4dbb3b249f288b4ed23c09eb286fc2` 上重跑；artifact 的 `openarcCommit=d583154a7b4dbb3b249f288b4ed23c09eb286fc2`、`gitDirtyLines=5` —— **这 5 个未提交文件全部是本批文档**（`PROGRESS.md`、`docs/D5-02-FULLAPP-RESULT.md`、`docs/D5-02-SCOPE-CORRECTION-EVIDENCE.json`、`docs/D5-03-RESULT.md`、`docs/D5-03-GATE-EVIDENCE.json`），**运行时没有任何代码 / 脚本 / 断言未提交改动**（`git diff d583154 <文档提交> --stat` 可核对；本文档不写成"完全干净树"）。artifact 记录的 8 个 MCP 源码指纹与本工作树**逐条相同**（文档岗按 `experiments/d5-03/mcp-center-e2e.mjs:86` 的 `fileSha` 算法复核）。**（历史，仅备查）** 上一轮（21:40）artifact 写的是 `openarcCommit=4dfe923` + `gitDirtyLines=12`（修复提交前的树）；本轮以干净代码树复跑的新 artifact 为准。

**首轮 → 现在的口径变化**：首轮 34/38 的 FAIL 由三个真实产品缺陷造成；修复后全绿，artifact 的 `productDefects: []`、`notVerified` 只剩 1 条。**【第二批已更新】** 该条已由第二批的 `mcp-policy-e2e` 覆盖并从列表移除：第一批台架在文案订正后重跑 `notVerified: []`（0 条），当前 artifact sha256 见正文 §2 / §9。修复前 D2 分支里登记的三条未验收（本地重连稳定性 / test 日志的能力发现段 / 子进程正常生命周期）随修复消失 —— 脚本里这三条只在 stdio 握手失败的分支登记（`experiments/d5-03/mcp-center-e2e.mjs:664-666`），最终 artifact 里不再出现。

---

## 1. 验收结果（真实 `electron .` + 真实产品 UI + 自建受控测试服务）

| 项 | 值 |
| --- | --- |
| 命令 | `OPENARC_TESTED_COMMIT=$(git rev-parse HEAD) node experiments/d5-03/mcp-center-e2e.mjs`（HEAD = `d583154`，干净代码树复跑） |
| 结果 | **38 PASS / 0 FAIL / 38，exit 0**；`productDefects: []`；**【第二批已更新】`notVerified` 现为 0 条**（`[]`；见正文 §9 / §10） |
| 产物 | `artifacts/d5-03/mcp-center-e2e.json`，sha256 **`dca23cb7b78df4997852500cebcabc5e2ad4e013795259b23b692ee8fc7aca23`**【第二批已更新：该 artifact 路径已被重跑覆盖，当前 sha256 = `d8f9a23781ff590aaa395b076defcb1f2cb141eef24618424ed102913b86a2e0`，见正文 §2 / §12 第 2 条】（文档岗 `shasum -a 256` 复核）；日志 `artifacts/d5-03/mcp-center-e2e-rerun.log`（末行 `结论：PASS — {"pass":38,"fail":0,"total":38,"notVerified":1}` + `E2E_EXIT=0`）；旧的 `artifacts/d5-03/mcp-center-e2e.log` 保留作首轮 / 上一轮历史 |
| 运行时未提交文件 | **5 个，全部为本批文档**（见 §0）；**代码 / 脚本 / 断言 0 改动** |
| 视觉产物 | `artifacts/d5-03/visual/` **17 张**（浅色 9 + 深色 8，覆盖 9 / 8 类状态） |
| 动效产物 | `artifacts/d5-03/motion/` **66 帧**（列表插入 / 删除、详情切换、发现中、减少动态效果，详见 §6） |
| 运行环境 | darwin / arm64；Node `v22.22.3`；Electron `44.3.0`；隔离 CDP 端口 `9811`；隔离 userData 前缀 `oa-d503-` |
| 测试服务 | 仓库内受控 fixture `tests/fixtures/mcp/echo-server.mjs`（stdio 子进程 + 4 个 127.0.0.1 动态端口 HTTP 实例：正常 / 鉴权失败 / 协议不符 / 无响应） |
| Z1 | 主进程 stderr **clean**（无未处理错误）；控制台错误样本 `[]`；对话框样本 `[]` |

**检查项分组（38 条）**：A 装配与登录 3（A × 2 + A0 错误码自检）；B 空态 3（B1–B3）；C 本地 stdio 3（C0 参照握手 / C1 界面新建 / C2 真实协商）；D 重连 + 测试 2（D1 / D2）；E 停用 + 删除 2（E1 / E2）；F 远程 http 3（F0 参照 / F1 / F1a）；G 负例 6（G1 非白名单 key / G2 不可达 / G3a 鉴权 / G3b 重授权入口 / G4 协议不符 / G5 挂死超时）；H 权限 2（H1 撤销 / H2 恢复）；I 不开放工具调用 2（I1 界面 0 入口 / I2 十个调用命令全拒）；J 边界自证 2（J1a 端点 / J1b 子进程）；K 动效 4；L 深色 5；Z1 收尾 1。

---

## 2. 首轮 → 修复：三个真实产品缺陷（全部有根因与 file:line）

| 缺陷 | 现象（首轮实测） | 根因 | 修复（`d583154`） |
| --- | --- | --- | --- |
| **D5-03-D2**（最严重） | 本地 stdio 连接在真实 Electron 里**永远握不上手**：`CONNECT_START` 后立刻 `CONNECT_FAILED MCP_UNREACHABLE detail=stdin-unavailable`，记录 `status=ERROR`、无 protocolVersion / 工具表；单元测试 31/31 却全过 | `electron/executor-launcher.cjs:114-131`（`ElectronUtilityProcessLauncher` 的 `handle.stdin = child.stdin \|\| null`，而 Electron 44 的 `utilityProcess.fork()` 返回句柄**没有 stdin**）+ `electron/mcp-client.cjs:157-167`（`#write` 无 stdin → `MCP_UNREACHABLE`/`stdin-unavailable`）。根因探针（真实 Electron 44.3.0）`electron experiments/d5-03/utility-stdin-probe.cjs`：`stdinType=undefined` / `stdinHasWrite=false`，子进程确实起来但子进程侧 `process.stdin` 立即 end。单测之所以过：`tests/mcp-fixtures.mjs` 走 `NodeChildProcessLauncher`（Node child 有 stdin），只有生产路径用 utilityProcess | 新增 `createMcpStdioLauncher`（`electron/executor-launcher.cjs:226-251`）：**Electron main = `process.execPath` + 子进程 `ELECTRON_RUN_AS_NODE=1`，纯 Node 同一实现**；测试与生产**共用同一个 `NodeChildProcessLauncher`**，不再有双路径。白名单 entry/args/env 仍由 `mcp-domain` 固定映射（渲染层只能给 serverKey，`ELECTRON_RUN_AS_NODE` 由 launcher 追加、调用方 env 覆盖不了）；**D4-04 执行器 launcher 一字未动** |
| **D5-03-D1** | 全新 userData 下打开「MCP 中心」：空态**没有任何「新建连接」入口**（`[data-mcp-empty] button` = 0、无 `[data-mcp-action=create]`），首条连接在界面上建不出来（PLAN §22「无连接可添加」不满足）；列表头的「新建」只在非空分支渲染 | `src/mcp/McpCenter.tsx:962-970`（空态分支把 `onAction/actionLabel` 传给 `PageState`）+ `src/design-system/page-states.tsx:46`（`PAGE_STATE_SPEC.empty.action='none'`）与 `:82`（`showAction = spec.action!=='none' && Boolean(onAction)`）——**共享组件把传入的动作静默忽略** | 不动 PageState 共享语义，空态由本页自己渲染 `<Button data-mcp-action="create">新建连接</Button>` 包在 `[data-mcp-empty]` 内（`src/mcp/McpCenter.tsx:963-974` + `src/styles.css:3614-3626` 的 `.mcp-empty`）；首条连接**从真空态完全走界面表单**创建（C1 断言 `placeholderUsed=null`，无用占位连接绕过） |
| **D5-03-D3** | 连接 / 重连 / 测试失败后**不刷新列表与详情**：鉴权失败当下界面不出现「认证失败 → 重新授权」入口（`[data-mcp-auth-required]` 不存在），必须手动重选该行才出现；协议不符时详情里也不是真实协商版本 | `src/mcp/McpCenter.tsx:435-455`（`runAction`：`res.ok !== true` 时 `setFailure` 后直接 return，不执行 `loadList/loadDetail`），而失败状态 `status/lastErrorCode/protocolVersion` 后端已经落库 | `runAction` 失败分支也 `await loadList({silent:true})` + `await loadDetail(connectionId)` 再 `setFailure`（`src/mcp/McpCenter.tsx:445-452`）。实测：鉴权失败**当下**出现重授权入口（G3a）、协议不符显示真实 `1999-01-01`（G4） |

**顺带的观察件（不是新缺陷，如实登记）**：治理侧的 app 授权投影原本只认 `resource.*` / `model.*`，MCP 的 `mcp.view/use/manage/test` 被投影成空动作，治理界面拿不到可撤销的 grantId。`d583154` 把 `mcpGrantActions` 并入 `#appGrantActions`（`electron/governance-service.cjs:278-287`、`electron/authorization-service.cjs:1174`）—— **【第二批已更新】** 当时"只开可见性与整条撤销，写路径仍不支持部分动作的 mcp grant"的边界已在本批改掉：写路径支持部分动作的 mcp grant，`mcp.view`-only 由第二批 `mcp-policy-e2e` 的 view-only 组（H0–H6）验收；这一段其余内容（投影并入 `mcp.*` 的原因与位置）保持当时口径。

**测试与生产共用同一实现**：新增单测 `tests/d5-03-mcp-stdio-launcher.test.mjs`（3 例）钉住 launcher 选择与 `ELECTRON_RUN_AS_NODE` 追加口径。

---

## 3. 交付内容

**后端（`electron/`）**

| 文件 | 内容 |
| --- | --- |
| `mcp-domain.cjs` | 传输 / 位置 / 认证模式 / 状态机 / 20 个稳定错误码（`ERROR_CODE`，A0 逐条自检存在）；`LOCAL_SERVERS` 白名单（本批只有 `openarc-test-echo` → 仓库内固定 entry + `["--stdio"]`，渲染层只能给 key）；远程 URL **复用 `model-domain.validateEndpoint`**（SSRF / 协议 / 内嵌凭据 / 明文远程都在那里被拒） |
| `mcp-store.cjs` | 连接记录 / 凭据元数据 / 有界测试日志（`LOG_KEEP=50`）三张表的读写；**raw secret 永不落库**（只有 `credential_ref`）；可写列白名单，无动态 SQL 拼接面 |
| `mcp-client.cjs` | 真实 MCP 握手：`initialize → initialized → tools/list`（分页）；协议版本不支持 / 超时 / 鉴权 / 不可达都映射成稳定错误码；`tools/call` 相关命令一律 `MCP_TOOL_INVOCATION_NOT_ENABLED`（第一批不开放调用） |
| `mcp-service.cjs` | 连接生命周期（`DISABLED → CONNECTING → READY/ERROR/AUTH_REQUIRED`）、重连与退避、测试、日志；工具目录上限 **200 个 / 10 页**，超出标记 `truncated`（完整 `inputSchema` 不入库，只存摘要） |
| `mcp-bootstrap.cjs` | 主进程命令面：**10 条白名单命令**（`list/get/create/update/delete/setEnabled/connect/reconnect/test/testLog`）+ 5 条调用命令显式拒绝；授权与审计走 D3-02 的 `mcp.view/use/manage/test`；内置 App baseline 登录时 upsert |

**持久层**：身份库 schema **v20** 迁移（`electron/identity-store.cjs:58-59,1201-1256`）新增 `mcp_connections` / `mcp_credentials` / `mcp_connection_logs` 三张表（DDL 全 `IF NOT EXISTS`，与 v17/v18 同口径可重放）。

**前端**：`src/mcp/McpCenter.tsx`（1594 行）+ `src/styles.css` 的 61 条 `.mcp-*` 规则 —— 「MCP 中心」窗口：连接列表 / 配置详情（含凭据"只写不读"）/ 能力表 / 测试日志；PLAN §22 的四态（空 / 无连接可添加 / 认证失败重授权 / 无权）都有落点；**界面 0 个「调用 / 运行工具」入口**（不是藏起来，是它不存在）。

**测试服务**：`tests/fixtures/mcp/echo-server.mjs`（stdio + HTTP 两种传输，可控失败模式：`--auth-token` 鉴权失败 / 协议版本 `1999-01-01` / `--no-response` 挂死；工具 `echo_sum` / `describe_self`）。

---

## 4. 功能结论（= 通过，限定范围）

* **本地 stdio（C 系列）**：界面新建 → 启用 → 连接，**实际协商值与 fixture 参照逐字一致** —— `protocolVersion=2025-06-18`、`serverName=openarc-test-echo`、`serverVersion=1.4.0`、`capabilities={tools:{listChanged:false},logging:{}}`、工具 `echo_sum` / `describe_self`、`toolsHash=7db033b3636227f94fc2a51859637cbb7b93c7e865a0e12b79d86c9dda7721ce`、执行位置 = 本地设备、状态 `READY`；重连后 `toolsHash` 不变（D1）；`mcp/test` 真握手并产生界面可见日志 `CONNECT_START → TOOLS_DISCOVERED`（D2，新增 2 条日志）。
* **远程 http（F 系列）**：127.0.0.1 动态端口，协商常量与 stdio **同一组**；执行位置 = 远程服务；列表非空时界面新建路径完全走 DOM 表单（F1a：`entry.needed=false`，无绕过）。
* **生命周期（E 系列）**：停用 → `DISABLED`、连接与子进程收掉（进程级证据：连接时新起的后代 pid 46768 在停用后退出）、停用态再连接 = `MCP_CONNECTION_DISABLED`；删除 → 记录消失、列表回空态、DB 两张相关表清空、无子进程残留（删除耗时 174ms，退场动画 `mcp-row-out`）。
* **失败与负例（G 系列，全部有稳定错误码 + 人话提示 + 有界）**：
  ① 非白名单 serverKey（`/bin/sh`、`openarc-test-echo; rm -rf /`、未知 key、路径穿越）→ 4/4 `MCP_LOCAL_SERVER_NOT_ALLOWED`，界面白名单下拉只有 `openarc-test-echo`；
  ② 已关闭端口 → `MCP_UNREACHABLE`（138ms）；
  ③ fixture 401 → `MCP_AUTH_REQUIRED` + 记录 `status=AUTH_REQUIRED` + **失败当下**出现重授权入口（G3a/G3b）；
  ④ 协议版本不符 → `MCP_PROTOCOL_VERSION_UNSUPPORTED`，并**如实记录服务端返回的 1999-01-01**；
  ⑤ 挂死服务 → 有界 `MCP_TIMEOUT`（**干净树复跑实测 8068ms**，上限 15s），期间界面显示「发现工具中」（6 帧采样）。
* **权限（H 系列）**：整条撤销 mcp grant → 全部 mcp 读命令 `MCP_UNAUTHORIZED`、界面「无权」且**不暴露任何工具描述**；**【第二批已更新】** 旧口径「重新登录触发内置 baseline upsert → 列表 / 详情 / 工具表恢复」正是本批修掉的语义：第二批起**跨登录不复活**（库内 mcp 行 0 + 墓碑 `revoked_at` 非空），恢复只走正式治理入口 `governance/grantAppAccess`（见正文 §3）。

---

## 5. 视觉结论（截图齐全；不整体宣布"视觉通过"）

* **产物**：`artifacts/d5-03/visual/` 17 张 = 浅色 9 张（空态 / 列表 / 详情 / 能力表 / 测试日志 / 远程详情 / 发现中 / 认证失败 / 无权）+ 深色 8 张（列表 / 详情 / 能力表 / 测试日志 / 发现中 / 认证失败 / 无权 / 空态）。**浅深两套主题都覆盖 PLAN §22 的四态与主要状态**。
* **实现口径（可复核）**：复用既有组件 —— `Button` / `TextField` / `Badge`（`src/design-system/primitives`）、`PageState`（`src/design-system/page-states`）、`Dialog`（`src/desktop/Dialog`）；`src/styles.css` 里 61 条 `.mcp-*` 规则**0 条硬编码颜色**（无 `#hex` / 无字面 `rgb()`/`hsl()`，颜色只经 `rgb(var(--*))`），共用 **27 个既有 token**（`--text`/`--muted`/`--failed`/`--line`/`--sunken`/`--radius-*`/`--space-*`/`--fs-*`/`--dur-quick`/`--ease-standard` 等）；`src/mcp/McpCenter.tsx` 0 处硬编码颜色。因此**中性灰、无新增彩色**。
* **未验收（如实登记）**：没有做逐像素 / 色值量测与对比度量测（本批视觉判定 = 截图齐全 + 实现只用既有 token 与组件；**不写成"视觉通过"**）；深色详情页也没有单独截图（深色覆盖到能力表 / 测试日志 / 无权 / 空态）。

---

## 6. 动效结论（= 通过，限定范围）

| 场景 | 实测 | 帧产物 |
| --- | --- | --- |
| 列表插入 | 新行 `is-new` + `mcp-row-in`，`--dur-quick = 0.16s`（160ms） | `light-insert-* 12 帧` |
| 列表删除 | 退场 `is-leaving` + `mcp-row-out` 160ms，8ms 采样到 21 个退场帧，行摘除耗时 195ms | `light-delete-* / light-delete-motion-* 各 8 帧` |
| 详情切换 | 按 `connectionId` 重挂载，8ms 采样覆盖两个详情名（远程回显服务 → 鉴权失败服务） | `light-detail-switch-* 8 帧` |
| 发现中 | 界面显示「发现工具中」，不造假进度（采样含 discovering 帧） | `light-discovering-* 6 帧` + `dark-discovering-* 4 帧` |
| 减少动态效果 | `.desktop.reduced` + `--dur-quick=0ms` + `animationName=none`；删除 **4ms**（常规 195ms），插入即时 | `reduced-insert 8 / reduced-delete 6 / reduced-detail-switch 6 帧` |

**未验收（如实登记）**：详情切换的 **loading 态**是数据态、进程内 IPC 可能短于 8ms 采样间隔（实测 `loadingFrames=0`），**不作动效判定**，只记录；不做逐帧像素差 / 时长曲线拟合（与 D5-02 的 MS §6 口径不同，本批没有需要拟合的入场曲线）。

---

## 7. 边界证据（本批"没做什么"怎么证明）

| 边界 | 证据 |
| --- | --- |
| 不连真实第三方服务 | `boundary.thirdPartyServices=false`；J1a：DB 里全部连接的 endpoint **100%** 是白名单 key `openarc-test-echo` 或 `127.0.0.1` 动态端口（`endpointScope=LOCALHOST`）；全程只连仓库内 fixture |
| 不运行任意第三方本地程序 | `boundary.arbitraryLocalPrograms=false`；本地连接只认白名单 `serverKey`，entry/args 在主进程固定映射，界面下拉只有 `openarc-test-echo`；G1 的 4 个恶意 key 全被拒；J1b：连接期间新起的子进程命令行为 **Electron 运行时 + 仓库内 fixture `--stdio`**，不含 shell / python / curl 等任意外部程序 |
| 不发用户数据 | `boundary.userDataSent=false`；本批只有连接管理与能力发现，没有工具调用面（I1/I2）；凭据只写不读、投影无 `credentialRef` |
| 不开放工具调用 | `boundary` 无对应字段但行为可证：I1 界面交互元素扫描 **0 个调用 / 运行入口**、桥只暴露 `command`；I2 直接对 `window.openarc.mcp.command` 发 **5 个调用命令 × 2 种形状 = 10 次**，全部 `MCP_TOOL_INVOCATION_NOT_ENABLED`，未登记命令仍是 `MCP_COMMAND_NOT_ALLOWED` |
| 不声称插件隔离已通过 | `boundary.pluginIsolationClaimed=false`；**连接成功 ≠ 插件隔离通过**，插件隔离属 D5-08，本批不验也不声称 |

---

## 8. 其它测试与回归（第十七批文档岗复跑核对）

| 命令 | 结果 |
| --- | --- |
| `node --test tests/d5-03-mcp-*.test.mjs` | **34 / 34 pass**（含 `tests/d5-03-mcp-stdio-launcher.test.mjs` 新增 3 例） |
| `node --test tests/d5-03-mcp-*.test.mjs tests/d5-02-canvas-*.test.mjs` | **74 / 74 pass** |
| `node --test tests/d4-04-*.test.mjs tests/governance-*.test.mjs` | **52 / 52 pass**（第十七批文档岗复跑核对；整套 d4-04 + governance 口径，0 失败） |
| `npm run build` | 本批记录 **exit 0**（`tsc --noEmit` + `vite build`）；文档岗**未复跑**（避免改写 artifact 里记录的 `distFingerprint`：`./assets/main-Ct-YFunl.js` / 371576 bytes / 2026-09-24T13:37:10.479Z） |

---

**【第二批已更新】** 本表是第一批当时的回归口径；第二批的回归（145/145 + 新增 11/11 + 6/6 + `npm run build` exit 0 + 两条预存在失败继续单列）见正文 §11。

## 9. 缺口（逐条，不美化）

1. **本批不开放工具调用**（设计如此，不是缺漏）：界面无入口，5 个调用命令 × 2 形状全 `MCP_TOOL_INVOCATION_NOT_ENABLED`。
2. **无 OAuth**：只有 `NONE` / `BEARER` 两种认证模式。
3. **远程只做 streamable HTTP 单响应**：未做 GET SSE 长连接流与断线续传；服务端 → 客户端请求（sampling / roots / elicitation）一律 `-32601`。
4. **工具目录上限 200 个 / 10 页**，超出标记 `truncated`；完整 `inputSchema` 不入库（只存摘要）。
5. **本地白名单只有测试 fixture**：真实 Adobe / PS 等本地服务属 D5-04 / D5-05，本批没有接。
6. **`ELECTRON_RUN_AS_NODE` 依赖 Electron fuse**：当前仓库没有打包 / 关 fuse 配置；若将来关掉 RunAsNode，握手会在有界超时内 fail closed（`MCP_UNREACHABLE` / `MCP_TIMEOUT`），不会假装连接成功。
7. **`notVerified: 1`（【第二批已更新】现为 0 条）**：`toolsHidden=true`（只有 `mcp.view`、没有 `mcp.use`）的 `mcp.use-only` 主路径无法构造 —— 治理写路径不支持部分动作的 mcp grant（`grantAppAccess(resourceType=mcp, actions=[mcp.view])` → `INVALID_INPUT`；`grantAppToolAccess` → `INVALID_INPUT`），内置 baseline 是单条含 `mcp.view/use/manage/test` 的 grant，`revokeAppAccess` 只能整条撤销；真机上只能验「`mcp.view` 也被撤 → 详情整块无权」这一支。**【第二批已更新：该项已闭合】** 治理写路径已支持部分动作的 mcp grant（真机 `grantAppAccess(resourceType=mcp, actions=[mcp.view])` → `{"ok":true,...}`）；`mcp.view`-only 的「工具描述不外泄」已由第二批 `mcp-policy-e2e` 的 view-only 组（`H0–H6`：`toolsHidden=true` / `tools=[]` / `hash=null` / DOM + `mcp/get` + `mcp/testLog` 三面 0 命中 / connect + test 被拒 / 再授 `mcp.use` 立即可见）验收，第一批台架的 `notVerified` 因此从 1 条变为 0 条（见正文 §4 / §9）。
8. **撤销不跨登录保持**：内置 App baseline 是「登录时对该组织再 upsert 一次」（`electron/identity-bootstrap.cjs:131-139 → electron/mcp-bootstrap.cjs:41-50`），与 model / canvas 同一内置模式 —— 用户视角是"撤了 mcp 权限，重新登录又有了"。恢复路径因此可用，但撤销**不跨登录**。**【第二批已修复】** v21 起撤销写墓碑，跨登录 / 跨重启都不复活，只有正式治理入口重授才恢复（真机 `C1/C2`、`D1–D4`、`E1–E4`；见正文 §3）。
9. **插件隔离属 D5-08**：本批**未验也不声称**。
10. **门禁脚本里一条 check 名字过期（不影响判定，登记不改）**：J1b 的标题还带着「本地 stdio 握手本身在 D5-03-D2 下失败」的括号（修复前写下的字样），其判定条件与 PASS 内容都已是修复后的正常路径。按"只允许改文档"的边界，本轮**不改脚本**，只在此登记。**【第二批已更新】** 第二批按允许范围只动了 notVerified 文案列表（移除已过期的那一条；38 条判定一字未动，`git diff` = 4 增 1 删）；`J1b` 标题按「不改判定文字」继续保留，脚本内还留有一条第一批的 `note("最小修法建议（未动手）…")`，一并登记在正文 §12 第 3 条。

---

## 10. 判定

* **D5-03 第一批（连接管理与能力发现）= PASS（限定范围）**：真实 Electron 门禁 **38 PASS / 0 FAIL / 38、exit 0**、`productDefects: []`、Z1 clean；功能 = 通过（本地 stdio 与远程 http 都取得**真实协商值**；四个失败类有稳定错误码与有界时延；权限撤销 / 恢复可用）；视觉 = 截图齐全（浅 9 + 深 8）、只用既有 token 与组件、中性灰无彩色，**未做色值与对比度量测 → 不宣布"视觉通过"**；动效 = 通过（插入 / 删除 160ms、详情重挂载、发现中不造假进度、减少动态效果 0ms 且删除 4ms）；loading 态采样 <8ms **未判定**。
* **D5-03 整体 = PARTIAL**：剩余 = OAuth、长连接流（GET SSE / 断线续传）、真实第三方与 Adobe / PS 等本地服务（D5-04 / D5-05）、插件隔离（D5-08）、部分授权主路径（`mcp.view`-only 写路径）与**撤销跨登录**缺口。**【第二批已更新】** 其中「部分授权主路径（`mcp.view`-only 写路径）」与「撤销跨登录」两项已由第二批闭环；整体剩余缺口以正文 §13 的 8 条为准。
* tracked 证据：`docs/D5-03-GATE-EVIDENCE.json`（38 条 checks 逐条复制并脱敏 + counts / artifactSha256 / boundary / 缺陷修复链 / 回归计数 / notVerified）。
