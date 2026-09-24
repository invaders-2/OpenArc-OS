# D5-03 第一批 · MCP 中心（连接管理与能力发现）结果（2026-09-24）

## 0. 口径与范围（用户明确定范围，本文档不改范围）

**本批 = 连接管理与能力发现**。用户明确：本批**不开放 MCP 工具调用、不运行任意第三方本地程序、不连真实第三方、不发用户数据、不把连接成功写成插件隔离已通过**。
文中所有数字与结论来自命令输出或证据文件；没有实测到的项一律进「未验收 / 缺口」，不美化。

**分支 / 提交 / 工作树**：分支 `integration/ui-core`；首轮验收脚本提交 `4dfe923`（首轮 **34/38**，暴露三个真实产品缺陷 D5-03-D1/D2/D3）；修复提交 **`d583154`**（HEAD；最终门禁在该提交上以**干净代码树**复跑，运行时只有本批 5 个文档未提交，无代码改动）。未 push、未合并 main、未切分支。

**验收代码内容 = `d583154`（干净代码树复跑，2026-09-24 21:54）**：最终门禁用 `OPENARC_TESTED_COMMIT=$(git rev-parse HEAD) node experiments/d5-03/mcp-center-e2e.mjs` 在 HEAD `d583154a7b4dbb3b249f288b4ed23c09eb286fc2` 上重跑；artifact 的 `openarcCommit=d583154a7b4dbb3b249f288b4ed23c09eb286fc2`、`gitDirtyLines=5` —— **这 5 个未提交文件全部是本批文档**（`PROGRESS.md`、`docs/D5-02-FULLAPP-RESULT.md`、`docs/D5-02-SCOPE-CORRECTION-EVIDENCE.json`、`docs/D5-03-RESULT.md`、`docs/D5-03-GATE-EVIDENCE.json`），**运行时没有任何代码 / 脚本 / 断言未提交改动**（`git diff d583154 <文档提交> --stat` 可核对；本文档不写成"完全干净树"）。artifact 记录的 8 个 MCP 源码指纹与本工作树**逐条相同**（文档岗按 `experiments/d5-03/mcp-center-e2e.mjs:86` 的 `fileSha` 算法复核）。**（历史，仅备查）** 上一轮（21:40）artifact 写的是 `openarcCommit=4dfe923` + `gitDirtyLines=12`（修复提交前的树）；本轮以干净代码树复跑的新 artifact 为准。

**首轮 → 现在的口径变化**：首轮 34/38 的 FAIL 由三个真实产品缺陷造成；修复后全绿，artifact 的 `productDefects: []`、`notVerified` 只剩 1 条。修复前 D2 分支里登记的三条未验收（本地重连稳定性 / test 日志的能力发现段 / 子进程正常生命周期）随修复消失 —— 脚本里这三条只在 stdio 握手失败的分支登记（`experiments/d5-03/mcp-center-e2e.mjs:664-666`），最终 artifact 里不再出现。

---

## 1. 验收结果（真实 `electron .` + 真实产品 UI + 自建受控测试服务）

| 项 | 值 |
| --- | --- |
| 命令 | `OPENARC_TESTED_COMMIT=$(git rev-parse HEAD) node experiments/d5-03/mcp-center-e2e.mjs`（HEAD = `d583154`，干净代码树复跑） |
| 结果 | **38 PASS / 0 FAIL / 38，exit 0**；`productDefects: []`；`notVerified: 1`（见 §9 第 7 条） |
| 产物 | `artifacts/d5-03/mcp-center-e2e.json`，sha256 **`dca23cb7b78df4997852500cebcabc5e2ad4e013795259b23b692ee8fc7aca23`**（文档岗 `shasum -a 256` 复核）；日志 `artifacts/d5-03/mcp-center-e2e-rerun.log`（末行 `结论：PASS — {"pass":38,"fail":0,"total":38,"notVerified":1}` + `E2E_EXIT=0`）；旧的 `artifacts/d5-03/mcp-center-e2e.log` 保留作首轮 / 上一轮历史 |
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

**顺带的观察件（不是新缺陷，如实登记）**：治理侧的 app 授权投影原本只认 `resource.*` / `model.*`，MCP 的 `mcp.view/use/manage/test` 被投影成空动作，治理界面拿不到可撤销的 grantId。`d583154` 把 `mcpGrantActions` 并入 `#appGrantActions`（`electron/governance-service.cjs:278-287`、`electron/authorization-service.cjs:1174`）——**只开可见性与整条撤销，写路径仍不支持部分动作的 mcp grant**（见 §9 ⑦）。

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
* **权限（H 系列）**：整条撤销 mcp grant → 全部 mcp 读命令 `MCP_UNAUTHORIZED`、界面「无权」且**不暴露任何工具描述**；重新登录触发内置 baseline upsert → 列表 / 详情 / 工具表恢复。

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

## 9. 缺口（逐条，不美化）

1. **本批不开放工具调用**（设计如此，不是缺漏）：界面无入口，5 个调用命令 × 2 形状全 `MCP_TOOL_INVOCATION_NOT_ENABLED`。
2. **无 OAuth**：只有 `NONE` / `BEARER` 两种认证模式。
3. **远程只做 streamable HTTP 单响应**：未做 GET SSE 长连接流与断线续传；服务端 → 客户端请求（sampling / roots / elicitation）一律 `-32601`。
4. **工具目录上限 200 个 / 10 页**，超出标记 `truncated`；完整 `inputSchema` 不入库（只存摘要）。
5. **本地白名单只有测试 fixture**：真实 Adobe / PS 等本地服务属 D5-04 / D5-05，本批没有接。
6. **`ELECTRON_RUN_AS_NODE` 依赖 Electron fuse**：当前仓库没有打包 / 关 fuse 配置；若将来关掉 RunAsNode，握手会在有界超时内 fail closed（`MCP_UNREACHABLE` / `MCP_TIMEOUT`），不会假装连接成功。
7. **`notVerified: 1`**：`toolsHidden=true`（只有 `mcp.view`、没有 `mcp.use`）的 `mcp.use-only` 主路径无法构造 —— 治理写路径不支持部分动作的 mcp grant（`grantAppAccess(resourceType=mcp, actions=[mcp.view])` → `INVALID_INPUT`；`grantAppToolAccess` → `INVALID_INPUT`），内置 baseline 是单条含 `mcp.view/use/manage/test` 的 grant，`revokeAppAccess` 只能整条撤销；真机上只能验「`mcp.view` 也被撤 → 详情整块无权」这一支。
8. **撤销不跨登录保持**：内置 App baseline 是「登录时对该组织再 upsert 一次」（`electron/identity-bootstrap.cjs:131-139 → electron/mcp-bootstrap.cjs:41-50`），与 model / canvas 同一内置模式 —— 用户视角是"撤了 mcp 权限，重新登录又有了"。恢复路径因此可用，但撤销**不跨登录**。
9. **插件隔离属 D5-08**：本批**未验也不声称**。
10. **门禁脚本里一条 check 名字过期（不影响判定，登记不改）**：J1b 的标题还带着「本地 stdio 握手本身在 D5-03-D2 下失败」的括号（修复前写下的字样），其判定条件与 PASS 内容都已是修复后的正常路径。按"只允许改文档"的边界，本轮**不改脚本**，只在此登记。

---

## 10. 判定

* **D5-03 第一批（连接管理与能力发现）= PASS（限定范围）**：真实 Electron 门禁 **38 PASS / 0 FAIL / 38、exit 0**、`productDefects: []`、Z1 clean；功能 = 通过（本地 stdio 与远程 http 都取得**真实协商值**；四个失败类有稳定错误码与有界时延；权限撤销 / 恢复可用）；视觉 = 截图齐全（浅 9 + 深 8）、只用既有 token 与组件、中性灰无彩色，**未做色值与对比度量测 → 不宣布"视觉通过"**；动效 = 通过（插入 / 删除 160ms、详情重挂载、发现中不造假进度、减少动态效果 0ms 且删除 4ms）；loading 态采样 <8ms **未判定**。
* **D5-03 整体 = PARTIAL**：剩余 = OAuth、长连接流（GET SSE / 断线续传）、真实第三方与 Adobe / PS 等本地服务（D5-04 / D5-05）、插件隔离（D5-08）、部分授权主路径（`mcp.view`-only 写路径）与**撤销跨登录**缺口。
* tracked 证据：`docs/D5-03-GATE-EVIDENCE.json`（38 条 checks 逐条复制并脱敏 + counts / artifactSha256 / boundary / 缺陷修复链 / 回归计数 / notVerified）。
