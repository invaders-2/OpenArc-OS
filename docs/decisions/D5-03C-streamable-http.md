# D5-03 第三批 · Streamable HTTP 流式收口与生命周期收尾

状态：**已实现并完成真机（Electron）验收** —— 2026-09-28 同轮三门禁全绿（顺序 center → stream → policy）：

* `mcp-center-e2e`（第一批回归）**38 PASS / 0 FAIL / 38、exit 0**，runId `20260928T020242Z-fd67-mcp-center-e2e`，artifact sha256 `83d8e6ab49edd63d9d88f64c799f1e8f1c1523e336f605ec782fba915bab66bf`；
* `mcp-stream-e2e`（本批新增）**29 PASS / 0 FAIL / 29、exit 0**，runId `20260928T020320Z-8b11-mcp-stream-e2e`，artifact sha256 `09e6023f61550d72c36d9f39effde3955d84d964e77f2d1488cac25ccc99cb80`；
* `mcp-policy-e2e`（第二批回归）**43 PASS / 0 FAIL / 43、exit 0**，runId `20260928T020348Z-fb87-mcp-policy-e2e`，artifact sha256 `df7891ef72abcb02fe057654d1132633f64bbdfae9c83a7393bd342fb9dc2a5b`（`notVerified` 2 条，均属跨组织真机不可构造）。

被测提交 `1b78953`（本批最后一次提交 = `0aa4027`，两个验收脚本）；分支 `integration/ui-core`；协议版本保持 `2025-06-18`（本批不升级）。完整口径与判定见 `docs/D5-03-RESULT.md` 正文 §1–§12；tracked 证据见 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch3` 段。

## 1. 背景：本批修掉的真实缺陷

1. **等整段 SSE 结束**：POST 的 SSE 上，客户端把"响应事件到达"当成还没结束，一直等服务端关闭流 —— 服务端只要持续推通知，请求就永远不返回。
2. **GET SSE 与断线续传缺失**：只做了 streamable HTTP 的单响应，GET 流、`Last-Event-ID` 续传、重复事件去重都不存在。
3. **生命周期事件不收流**：登出 / 锁屏 / 关应用 / 撤权之后，活连接与在途握手仍留在内存里；关应用时也没有有界的 dispose，退出时机与残留都不可控。
4. **门禁证据写在根目录可变 JSON**：同一路径被每轮重跑覆盖，无法区分"哪一轮的哪份证据"（第二批已发生过一次覆盖事故）。

## 2. 决策一：POST SSE 以"响应事件到达"为请求完成

服务端在 SSE 上回完响应事件后**可以继续推通知且流不结束**；客户端收到匹配响应即完成本次请求，流在响应后由客户端释放（服务端侧可见 `closedByClient`）。

* 实测：`mcp/connect` **29ms** 完成（脚本判定 < 4000ms；客户端超时上界 `requestTimeoutMs=8000`）；服务端 `{"streams":2,"notifications":2,"closedByClient":2,"openStreams":0,"droppedByServer":0}`；连接 `READY`、`toolsHash` 与参照值一致。
* 单元级：`tests/d5-03-mcp-stream.test.mjs` S1 用时间 + 服务端侧证据钉住该语义。

## 3. 决策二：GET SSE 是可选能力，"不支持"不等于连接故障

* 服务端支持时建 GET 流：`getStream {supported:true,state:open,status:200,error:null}`；收到通知后连接仍 `READY`、`lastErrorCode=null`。
* 服务端回 `405`（另含 `404` / `501`，单元级 G2）时：`{supported:false,state:"unsupported",error:null}`，**连接不判 ERROR**、`lastErrorCode=null`，随后 `mcp/test` 仍成功（POST 不被连带判死）。
* HTTP 传输下服务端 → 客户端的请求（sampling 等）一律 `-32601`，且**真的把错误 POST 回服务端**（服务端侧实收 `[{"id":"srv-1","code":-32601}]`），不是"未实现所以挂着"。
* 单元级：`tests/d5-03-mcp-get-stream.test.mjs` G1 / G2 / G6。

## 4. 决策三：续传只认显式事件 ID，去重按 `(channel,id)`

* **带 ID 断线**：客户端重连时发 `Last-Event-ID`，服务端实收 `lastEventIdSeen="3"`、`replayedFrom=3`、`replays=1`、`opens=2`、`distinctSent=4`；客户端 `reconnects=1 / hasLastEventId=true / duplicates=0 / total=4`。
* **无 ID 断线**：不发送 `Last-Event-ID`、不重放（`lastEventIdSeen=null / replays=0`），但仍有界重连（`opens=2` 证明重连过）；客户端 `hasLastEventId=false / duplicates=0`。
* **重复事件**：服务端同一 `id` 重发（`duplicatesSent=2 / distinctSent=2`）→ 客户端 `duplicates=2 / total=2`，**不当成新的结果**。
* 单元级：G3 / G4 / G5。

## 5. 决策四：有界失败（大小 / 超时 / 中断 / 会话失效），且不重发、不自动重连

| 情形 | 结果 |
| --- | --- |
| 单个事件超界 | 393216B > `maxEventBytes=262144` → `MCP_STREAM_EVENT_TOO_LARGE`（**11ms**）、记录 `ERROR` + 同码；服务端 `byMethod.initialize=1`（**不重发**）、`openStreams=0` |
| 服务端只推通知、永不回响应 | `MCP_TIMEOUT` 实测 **8007ms**（上界 8000ms，期间 **79 条通知**），客户端释放流 |
| 流被中断且无响应 | `MCP_STREAM_INTERRUPTED`（S5，请求级不重发） |
| 会话失效（POST 404 + session 信号） | `MCP_SESSION_EXPIRED`（**15ms**）、记录 `ERROR` + 同码、无 `getStream`；**2.5s 后服务端计数不变**（`initialize=1` / `posts=3`）→ **不自动重连、不自动重发** |
| GET 流重连 404 | `reconnect404=1`、`opens` 停在 1；连接转 `ERROR/MCP_SESSION_EXPIRED`、`getStream=null` |

半包跨 chunk：服务端按 5 字符分片写入（`splitWrites=134`）仍能正确拼接，`connectMs=464`、`READY`、工具表与哈希一致。

## 6. 决策五：生命周期状态策略（不新增第六状态）

**理由**：新增连接状态会强制 schema **v22 重建表**，并使 8 个冻结断言失效；现有 `enabled`（用户意图）+`status` 足以表达"非故障的会话结束"与"权限失败"两类语义。

| 事件 | 状态口径 |
| --- | --- |
| 登出 / 锁屏 / 关应用 | `DISABLED + MCP_SESSION_ENDED`；**`enabled` 不改写**；详情页人话 + 连接日志 `SESSION_ENDED`；重新登录后可再次连接 |
| 撤权（`mcp.*` 被撤） | `ERROR + MCP_UNAUTHORIZED`；日志 `AUTHORIZATION_REVOKED`；工具名 / 描述 / 参数 / hash 0 投影；`list/get/connect/test` 全拒 |
| 在途握手被收尾中止 | 用明确中断码，**不伪装** `MCP_TIMEOUT` / `MCP_UNREACHABLE` |

接线（`1b78953`）：

* `electron/main.cjs`：`will-quit` 先有界 `await disposeMcpBounded(2s)` 再停 modelProxy / 关 store；超时或异常**不阻塞退出**（实测关应用 `exit 0`、`quitMs=80`，stdout `{"ok":true,"closed":1,"aborted":1,"ended":1,"error":null,"failures":[]}`）。
* `electron/mcp-bootstrap.cjs`：`attachMcpSessionLifecycle` 监听既有 `identity/logged-out` / `locked` 事件做 dispose，装配在 `identity-bootstrap` 唯一路径（产品与探针共用）。
* 撤权：`electron/authorization-service.cjs` 撤销成功后回调 `onAppGrantRevoked`（治理两条撤销入口的唯一漏斗）→ 过滤 `resourceType=mcp` → `mcp-service.closeAppConnections` 同步摘活连接并 abort 在途握手。
* 单元级：`tests/d5-03-mcp-lifecycle.test.mjs` L1–L5（登出 / 锁屏 / 撤权 / dispose 幂等与有界超时 / 登出中止在途握手）。

## 7. 决策六：门禁证据隔离、端口独占与批次串行

* **每次运行独立目录**：`artifacts/d5-03/runs/<runId>/`（artifact JSON + 日志 + `.sha256` + 截图）；索引**只追加** `runs/index.json` / `runs/index.jsonl`，同一 runId 绝不改写（`experiments/d5-03/run-artifacts.cjs`）。**根目录不再写可变 JSON**（旧的 `artifacts/d5-03/*.json` 只作历史）。**当前有效证据以本轮 runId 目录为准**（本轮三个 runId 见文首），历史轮次只作历史。
* **端口独占探测**：`acquirePort(base)` 从基址递增、以 `127.0.0.1` 独占监听探测并占住候选端口，真正 spawn 前释放，并记 `cdpPortProbes` —— 端口是运行期动态值，不是写死的静态端口。
* **只清理自己**：三次运行都是 `own-pid-tree-only`、`leftovers: []`、`pkillUsed: false`；Electron 批次**串行执行**（center 02:02:42–02:03:20、stream 02:03:20–02:03:47、policy 02:03:48–02:04:12）。
* **归因订正（第三批）**：第二批文档曾把一次 `Z0 FAIL(exit 2)` 与 CDP 端口冲突记成"另一个并发 DSH 会话"；经复核那是**本任务自己并行跑的批次**。以上三条机制性修复就是针对它的。

## 8. 源码指纹集（14 条口径）

center / policy artifact 各 14 条，stream 15 条（多自己一条）：**产品源码 12 条**（`electron/` 的 mcp-bootstrap / mcp-client / mcp-domain / mcp-service / mcp-store、identity-store、authorization-store、authorization-service、governance-service、executor-launcher，加 `tests/fixtures/mcp/echo-server.mjs`、`src/mcp/McpCenter.tsx`）全部 `status=ok` / `inTestedCommit=true` / `worktreeMatchesCommit=true`；tracked 未改的 `mcp-center-e2e.mjs` 同为 ok。

**脚本自身的标记要按字面读**：`mcp-policy-e2e.mjs` 三份 artifact 里都是 `inTestedCommit=true` / `worktreeMatchesCommit=false` / `status="modified"`（重基线当时未提交）；`mcp-stream-e2e.mjs` 在 stream artifact 里 `inTestedCommit=false` / `status="untracked"`（新文件当时未跟踪）。这是**诚实自报"脚本当时未提交"，不是内容不一致**：sha256_16 复算为 `56b9ba59ee896864` / `6af0115d62fd1e3c`，与 `0aa4027` 当前内容逐字节相同（policy 全量 `56b9ba59ee896864f2922785749eda9bc525a765ba7f3088de116b2e04e798af`）。指纹集整体 sha256：center / policy `0b435692…`；stream `b7244f7c…`（含自身）。

## 9. 门禁重基线（policy 脚本，两处）

* **H2 驱动**：只补一次真实 `mcp/connect` 前置（重授四动作后先连回 `READY`，再收窄 `view-only`）；**H2 判定与 `expected` 一字未动**；全文件 44 个 `record` 调用点 id 序列与基线 `c2e96c1` 一致。
* **R3 白名单式**：基线由 `d583154` 改为 `c2e96c1`；仅允许 `src/mcp/McpCenter.tsx`；只增不删（`numstat=8\t0`）；补丁必须含 `MCP_SESSION_ENDED`；白名单外任何 `src/` 改动 FAIL；`git` 失败 fail-closed。K 段级联判据原样。其余 **42 条判定逐字未动**。

## 10. 未闭合项与残余（如实登记）

* **`notVerified` 仍 2 条**（`mcp-policy-e2e`）：同一安装内第二个组织无产品入口（单 root 团队约束）→ 跨组织**行为级**只到 schema + node 级；**本批不新增"创建组织"入口**（用户明令）。
* **会话空闲过期没有身份事件**：会话自然过期不触发 `identity/logged-out|locked`，活连接要等下一次收尾动作才被收掉；期间靠命令层实时判权拒绝。**"空闲过期即时收流"未验收**。
* **视觉两项未验收**：新增的一行"会话已结束"说明复用既有 `mcp-muted` 与 neutral 徽标（无新 token / 组件 / 颜色 / 动效），有实机截图；但**浅 / 深主题对照**与**对比度量测**本批未做。
* **policy 脚本收尾留 2 个 `oa-d503b-*` 临时目录**（既有行为，脚本不在本批允许改动范围）。
* 既有缺口不变：OAuth、真实第三方 / Adobe（D5-04/05）、插件隔离（D5-08）、`BASELINE_POLICY_PROVIDERS` 无漂移守卫、`app_policy_provisions` 无清理策略、D5-02 `prompt()` 遗留。
* **协议版本不升级**：仍 `2025-06-18`（记录 / 客户端常量 / 域常量三处一致）——升级不在本批范围。

## 11. 相关代码

* `electron/mcp-client.cjs`：POST / GET SSE 解析、`Last-Event-ID` 续传、`(channel,id)` 去重、事件大小上界、请求超时、中断与会话失效收尾；
* `electron/mcp-domain.cjs`：新错误码（`MCP_STREAM_INTERRUPTED` / `MCP_STREAM_EVENT_TOO_LARGE` / `MCP_SESSION_EXPIRED` / `MCP_SESSION_ENDED`）与客户端上界常量；
* `electron/mcp-service.cjs`：`closeAppConnections`、GET 流生命周期、状态口径；
* `electron/mcp-bootstrap.cjs`：`attachMcpSessionLifecycle`、撤权回调接线、dispose 装配；
* `electron/main.cjs` / `electron/identity-bootstrap.cjs` / `electron/authorization-service.cjs`：关应用有界 dispose / 身份事件 / 撤权唯一漏斗；
* `src/mcp/McpCenter.tsx`：`MCP_SESSION_ENDED` 文案与 `data-mcp-note="session-ended"`（`1b78953`，8 增 0 删，无样式改动）；
* `experiments/d5-03/run-artifacts.cjs`：runId 目录 / 索引 / `acquirePort`；
* `experiments/d5-03/mcp-stream-e2e.mjs`（29 项）、`tests/d5-03-mcp-stream.test.mjs`（S1–S8）、`tests/d5-03-mcp-get-stream.test.mjs`（G1–G7）、`tests/d5-03-mcp-lifecycle.test.mjs`（L1–L5）、`tests/fixtures/mcp/echo-server.mjs`（可控失败模式：持续通知 / 事件 ID / 重复 ID / 分片 / 超大 / 无响应 / 会话失效 / GET 405）。

---

## 12. 第四批影响（2026-09-28，`7b75ea3`）

第四批（**会话自然到期 → MCP 收流 + 策略收口**）在本决策的结论上落地 / 改写了下面几处；本节只登记影响，**本文 §1–§11 的第三批结论不删改**（被本批改写的口径在本节说明）：

* **§6 生命周期状态策略：多一条收尾事件，状态口径不变**。第三批 §10 登记的「会话空闲过期没有身份事件」由第四批闭环：新事件 `identity/session-expired`（reason / sessionId / sessionRef）并入 `MCP_SESSION_END_EVENTS`，走 §6 同一条既有 dispose —— 活连接与在途请求立刻收掉、**`enabled` 不改写**、状态如实 `DISABLED + MCP_SESSION_ENDED`、连接日志 `detail = expired:idle | expired:absolute`；登出 / 锁屏 / 关应用 / 撤权的既有 detail（`logout` / `user` / `app-quit` / `app-grant-revoked`）**一字未改**。**仍不新增第六状态、`SCHEMA_VERSION` 仍 21** —— 与 §6 决策一致。
* **§10 未闭合项：四项闭环 / 改写**。①「会话空闲过期即时收流」—— 真机验收通过（idle 25/25：`dueAt→revoked_at` 偏差 0ms、事件 3ms、收流 53ms、`expired:idle`；absolute 5/5：`reason=absolute`、`expired:absolute`；extend 越过原到期点 3004ms 仍 READY）；②「视觉两项未验收」—— 已验收通过（浅/深实机截图 1660×1140 与第一批基准逐像素同尺寸；说明行 12px/400 按普通文本门槛实测浅 4.94:1 / 深 6.30:1，指定色 / 合成背景 / 实机像素三方一致）；③「policy 脚本收尾留临时目录」—— 已闭环（`owner.json` 归属标记 + 只按本次创建清单清理 + SIGINT/SIGTERM 兜底 + 三条件 orphan 清理，残留 4 → 0）；④ 既有缺口里的「`BASELINE_POLICY_PROVIDERS` 无漂移守卫」「`app_policy_provisions` 无清理策略」—— 已闭环（行为级 15 对 = resource 10 + model 4 + mcp 1 逐项相等 + 反向穷举表外 0 + 源码级 fail-closed + 负向自证 T5/T6；保留规则 R1–R6 + 空白名单源码守卫；按总经理裁定**不实现删除**）。
* **§3 / §4 / §5（流式语义与有界失败）不受影响**；协议版本仍 `2025-06-18`；`notVerified` 仍 2 条（跨组织真机入口，第四批未新增「创建组织」入口）。
* 第四批判定 = **PASS（限定范围）**，D5-03 整体仍 = **PARTIAL**。证据：`docs/D5-03-RESULT.md` 第四批正文、`docs/D5-03-GATE-EVIDENCE.json` 的 `batch4` 段、决策 `docs/decisions/D5-03D-session-expiry-and-policy-retention.md`、真机报告 `experiments/d5-03/D5-03-BATCH4-EXPIRY-REPORT.md`。

