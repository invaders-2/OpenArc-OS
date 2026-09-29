# D5-03 第七批 · 安装重置后旧设备身份失效 + 配对组织归属以会话为准（真机验收报告）

被测提交：`ed4502d8fc1f88f5aeea9db31df38e750e96dc47`（`integration/ui-core` HEAD，工作树干净）
被测改动：`electron/identity-store.cjs`（RESET_AUTHORIZATION_DELETE_SQL 4 → 7 张表）、`electron/device-service.cjs`（组织归属唯一来源 = 会话反查的 users.team_id）
本报告的所有数字、返回体、行数、sha256 都来自本轮真实运行产物（`artifacts/d5-03/runs/<runId>/`），不接受推断。

---

## 0. 三轴判定

| 轴 | 判定 | 依据 |
| --- | --- | --- |
| **功能** | **通过** | 新增真机门禁 `mcp-device-reset-e2e` **44/44 exit 0**；`mcp-reset-e2e` **28/28 exit 0**（原 26 条一字未改 + 新增 2 条）；`mcp-policy-e2e` **43/43 exit 0**；`device-ui` **32/32 exit 0**；`identity-ui` **26/26 exit 0**；相关 node 集合 **183/183 exit 0**；`npm test` **1376 tests / 1370 pass / 6 fail exit 1**（6 条逐条给出原因，全部与本批无关：2 条既有 + 4 条环境 dsh 版本漂移） |
| **视觉** | **通过（本批无视觉改动）** | 本批改动文件只有两个 `.cjs`，不含任何 `.tsx` / `.css`；真机 UI（设备面板）只作为功能驱动路径使用（选择器取值 + 与后端逐字对照），未做新的像素量测 —— 见 notVerified |
| **动效** | **通过（本批无动效改动）** | 同上，改动面不含样式与动画 |

一句话：**重置后旧设备身份确实失效了（未消费密钥 / 已消费密钥 / 旧指纹 / 旧长连接四条路径全部被拒，设备三表 1 / 1 / 2 → 0 行），配对与设备读取的组织归属确实只认会话，自报异组织被明确拒绝；审计三表一行不删。**

---

## 1. 判定改动披露（必须先看）

### 1.1 被测提交自己改写了既有门禁的两处断言（逐字披露在源码里）

`tests/d5-03-reset-authorization-consistency.test.mjs` 文件头第 25-34 行已逐字写明「旧期望 → 新期望」：

| 位置 | 旧期望（逐字） | 新期望（逐字） | 理由（逐字摘要） |
| --- | --- | --- | --- |
| T7 | 「残留的配对凭据确实还能登记设备（已登记的残留，本批不清）」 | 「PAIRING_TOKEN_UNKNOWN，0 台新设备 / 0 条新凭据」 | 那正是「重置后还能用旧密钥登记设备」的缺陷本身 |
| 文件头结论 | 「devices / device_credentials / device_pairing_credentials —— 设备与凭据登记（配置类）……凭据本身不构成资源/应用授权」 | 「这三张是**能恢复设备身份**的事实，随重置同事务清空」 | 凭据按 fingerprint 取数、配对密钥按 secret_hash 取数，两条路径都不比对组织；heartbeat 的 Device Gate 用 role ADMIN 的合成 actor |
| T6 | 「重置要删的表集合恰好是登记的四张授权表」 | 「七张（四张授权 + 三张设备身份）」 | 删除集合本身扩到 7 条 |
| T2 | 「授权事实四表 0 行」 | 「七张全 0 行」 | 同上 |

`tests/app-policy-provisions-retention.test.mjs` 的 R6 守卫：白名单由 **1 条扩到 4 条**（新增设备三表），匹配强度未放宽（文件 + 命中形态 + 去空白逐字相等），并新增两条 fail-closed（登记项必须在重置集合内 / 每张受 watch 表必须仍被整表删）与 4 组注入负向自证 —— 属于**收紧**。

**本执行岗未删改任何既有门禁断言**；对 `experiments/d5-03/mcp-reset-e2e.mjs` 只做了「**新增** C2b / D2b 两条七表断言 + 注释与说明文案四张 → 七张」（原 26 条标题与判定一字未改，见 §5.2）。

### 1.2 真机路径披露（为什么设备侧动作要在主进程内直调）

产品 IPC 的 `device:command` 白名单只有 10 条命令（`electron/device-bootstrap.cjs:21-32`），**没有** `consumePairing`（设备侧动作）、`authenticateConnection` / `heartbeat`（TLS 后连接身份）、`grantDeviceAccess`（设备 ACL 写入）；而且 `device:command` 的 context 由主进程自建（`device-bootstrap.cjs:54`），渲染层连自报 `organizationId` 的字段都递不进去。

因此新增门禁用**真实 `electron .` + Node 主进程调试口**（`--inspect`，只监听 127.0.0.1、端口独占）在真实主进程里：

1. 给 `DeviceService.prototype` 的公开方法装一层**只记录、不改变行为**的包装，捕获产品自己在真实 UI 路径上创建的那个 DeviceService 实例与它收到的真实会话上下文；
2. 用**被捕获的同一个实例**直接调用上面那几个没有 IPC 入口的服务方法（等价于另一台设备 / 管理端在真机上调用产品服务）。

约束（脚本自证）：**不改任何产品文件、不写任何 SQL**（探针查库一律 `DatabaseSync readOnly`）；会话 token 只在主进程内存里流转，回传探针的只有长度 + sha256 前 16 位；`OPENARC_SERVICE_IDENTITY` 是产品既有配置项（`electron/main.cjs:253`），本轮的 Control Service 身份 = `svc_d503h_device_reset`。

---

## 2. 真机主场景（隔离安装，走真实产品入口）

真机门禁：`experiments/d5-03/mcp-device-reset-e2e.mjs`

- **最终运行**：runId `20260929T023418Z-448b-mcp-device-reset-e2e`，**44/44 PASS，exit 0**
- artifact sha256：`c56ff79a4e2929bc13e082115b03ce3b0c7aa55f0c77774a8c903c90b32a5f81`
- 日志 sha256：`ab44c432ba98474638fd6b9f6df7b4d86dc4e8c436684bbc3d5b28b2684b023c`（8719 bytes）
- notVerified 0 / productDefects 0
- 原始库证据：`identity.db.evidence`（4096 bytes，sha256 `97e8d54f8a7255106f66cf1b213c4a4d7b558d21310b1c2bfedc3d0d526dddda`）
- 注入的 confirm：被拒 `[null（缺字段）, "delete-all-identity-data"（大小写不符）]`；被接受 `"DELETE-ALL-IDENTITY-DATA"`
- 组织：会话组织 1 = `team_DrIyMMRbV2p-ymo_wX8nsLjgHMRDo6wB`；会话组织 2 = `team_UPm3nkSYkSNRKjDIT11qvwcTh6lLyBsb`；自报异组织 = `team_d503h_foreign00000000001`（**不是真实组织**，只用于自报字段）

### 2.1 逐步结果（命令 → 返回 → 断言）

| 步 | 做了什么（真实入口） | 实测返回 | 判定 |
| --- | --- | --- | --- |
| A1 | 真实 `electron .` + 真实 UI 三步向导初始化 + 登录 admin | gate=ready；CDP + 主进程调试口均独占可用；schema v21 | PASS |
| A1b | 真实登录表单**故意错口令一次** | 被拒（gate != ready），`login_attempts` 1 行；随后正确口令 gate=ready | PASS |
| A3 | 真实 UI：系统设置 → 设备面板 | `data-device-available=true` / `data-device-role=ADMIN` | PASS |
| A4 | 真实 UI 点「开始配对」→ `device/pairing.create` | 界面加入码 sha256 **=** 服务返回值 sha256（43 字符）；库里 1 行 `ISSUED`、组织 = 会话组织；`secret_hash` = 64 hex = sha256(明文) | PASS |
| B1 | 消费该密钥（捕获到的真实 DeviceService 实例） | `dev_KT18uyyURFeW-AXt74ClhwOTZIZjBZFz` + `dcr_ESgjKcqqZrRudS6AR-sw1NSRZ2ahm3pM`，组织 = 会话组织，状态 ACTIVE，凭据版本 1；devices 1 / device_credentials 1 / device_pairing_credentials 2 / device_access 1 | PASS |
| B2 | 旧凭据三件事（重置前必须都成立） | 指纹认证 ALLOW / Device Gate 授权 ALLOW（SUPER_ADMIN）/ 心跳 ALLOW | PASS |
| B3 | 真实 UI 设备列表 | 1 行，deviceId / 名称 / ACTIVE 与 registry 一致 | PASS |
| B4 | 真实 UI 再签发一把**未消费**密钥 | 库里 2 行密钥（1 CONSUMED + 1 ISSUED） | PASS |
| B5 | 配对时自报**错误的 Control Service 身份** | `SERVICE_IDENTITY_MISMATCH`，token 仍 ISSUED，0 新设备 / 0 新凭据 | PASS |
| C1/C2 | 缺 confirm / 大小写不符 | 两次 `INVALID_INPUT` | PASS |
| C2/C2b/C3 | 被拒后逐行比对 | 7 张重置表 + 5 张身份表**逐行不变**；审计 `authorization_audit` / `device_audit` 逐行不变；`audit_log` 前缀不变、恰 +2 条 DENY | PASS |
| C4 | 被拒后会话仍有效 | gate=ready + `identity/status` ok + 设备面板仍在 | PASS |
| D1 | 正式重置（正确 confirm） | ok=true，`initialized=false` / `userCount=0` | PASS |
| **D2** | 重置后**三张设备身份表** | devices **1 → 0**、device_credentials **1 → 0**、device_pairing_credentials **2 → 0**（逐行 dump 为空） | PASS |
| **D3** | 重置后四张授权事实表 | app_policy_provisions **15 → 0**、app_resource_grants **16 → 0**、resource_grants 0 → 0、**device_access 1 → 0** | PASS |
| D4 | 重置后身份五表 | 全部 0（重置前 4 张有行 + login_attempts 1 行） | PASS |
| D5 | 审计 | `device_audit` **8 → 8 行逐行不变**；`authorization_audit` 逐行不变；`audit_log` 既有行一行不删，重置自身序列 = `DENY,DENY,OK_REQUESTED,OK` | PASS |
| D6 | 旧的**未使用**密钥再消费 | `PAIRING_TOKEN_UNKNOWN`，devices 0 / credentials 0，指纹反查 null | PASS |
| D7 | 旧的**已消费**密钥再消费 | 两次同码拒绝，不留任何行 | PASS |
| D8 | 旧设备指纹认证 | `DEVICE_CREDENTIAL_UNKNOWN` | PASS |
| D9 | 重置前建立、仍握在手里的**旧长连接**发心跳 | `DEVICE_CREDENTIAL_MISMATCH` | PASS |
| D10 | 渲染层重新询问身份 | reload 后 gate=uninitialized | PASS |
| E1–E3 | 重新初始化（新 admin）→ 新组织 → 新密钥 | 新组织 `team_UPm3nkSY...` ≠ 旧组织；新密钥 1 行 ISSUED、组织 = 新组织；会话 sha256 前 16 位变化 | PASS |
| E4 | 新组织对**旧设备**取数 / 判权 | `authorizeDeviceById` → `DEVICE_NOT_FOUND`（对外理由 `NOT_FOUND_OR_FORBIDDEN`）；`getDevice` → `DEVICE_NOT_FOUND`；列表 0 行；registry 里该行不存在 | PASS |
| E5 | 新密钥配对 | `dev_scIl3wz-n2ZyvxTlw5VwODbn30L51JsE` + 凭据 v1，组织 = 新组织；真实 UI 列出该设备 | PASS |
| F1 | `deviceIdentity.organizationId` = 另一个组织去消费 | `PAIRING_TOKEN_ORGANIZATION_MISMATCH`；token 仍 ISSUED；0 新设备 / 0 新凭据 | PASS |
| F2 | 自报 `context.organizationId` = 异组织调 `createPairing` | `SESSION_ORGANIZATION_MISMATCH`；异组织行 0 | PASS |
| F3 | 对照：自报值与会话一致 | 允许，且落库组织 = 会话组织（自报值改变不了它） | PASS |
| F4 | 读路径自报异组织（listPairings / listDevices / deviceAudit / getDevice / authorizeDeviceById）+ 自报异 userId | 5 条 `SESSION_ORGANIZATION_MISMATCH` + 1 条 `SESSION_USER_MISMATCH`（同一形态） | PASS |
| F5 | 对照：不传自报字段 | 读路径正常（1 行设备） | PASS |
| G1 | 同一密钥**两路并发**消费（两套独立 SQLite 连接） | 恰好 1 胜 1 负；输家 `PAIRING_TOKEN_ALREADY_USED`；devices / credentials 各 +1；token 归属赢家 | PASS |
| G2 | **Worker 线程真并发**（两个 OS 线程抢同一 token） | worker 输（`PAIRING_TOKEN_ALREADY_USED`）、主线程赢；仍然恰好 1 设备 / 1 凭据 | PASS |
| H1 | 5 把密钥的界面显示值 = 服务返回值 | 5/5 sha256 逐字相等 | PASS |
| H2 | 反证库里确有 sha256 形态 | 重置前行（已被重置删除，hash 在重置前取）与当前行都是 64 hex 且 = sha256(明文) | PASS |
| H3 | 明文 secret 扫描（5 把） | DB 文件 / WAL / SHM / 全表逐字段 dump / 审计 payload / userData 下日志与 JSON / 主进程输出 —— **0 命中** | PASS |
| H4/H5 | 审计保留与 payload | `device_audit` 前缀逐行不变；payload 里没有明文 secret | PASS |
| H6 | 结束时旧组织残留 | 旧组织在设备三表里 0 行；所有设备行都属于当前组织 | PASS |
| Z1 | 主进程 stderr | 无未处理错误；渲染层控制台错误样本 [] | PASS |

### 2.2 与题目第 2/4/7 条的逐条对照

- 「重置前：消费密钥 → 1 台设备 + 1 条凭据（组织 = 会话组织）」→ B1 ✔
- 「旧未使用密钥 → PAIRING_TOKEN_UNKNOWN，0 新设备 / 0 新凭据」→ D6 ✔
- 「旧已消费密钥 → 稳定拒绝」→ D7 ✔
- 「旧设备指纹认证 → DEVICE_CREDENTIAL_UNKNOWN」→ D8 ✔
- 「旧设备对新组织取数 → DEVICE_NOT_FOUND / NOT_FOUND_OR_FORBIDDEN」→ E4 ✔（顺序说明：这一步需要新会话，所以在重新初始化之后执行；重置后到重新初始化之间的三条（D6–D9）都不需要会话）
- 「身份五表 0 行」→ D4 ✔
- 「审计三表一行不删（audit_log 既有行逐行不变 + 重置自身留痕）」→ D5 ✔
- 「重新初始化后新密钥配对成功」→ E5 ✔
- 「跨组织 deviceIdentity → PAIRING_TOKEN_ORGANIZATION_MISMATCH」→ F1 ✔
- 「自报 context.organizationId → SESSION_ORGANIZATION_MISMATCH（真机证据）」→ F2 + F4 ✔（写路径 + 读路径 + 对照组；渲染层路径不可达的原因见 §1.2）
- 「并发单次消费 → 恰好 1 设备 / 1 凭据」→ G1（两连接）+ G2（真并发）✔
- 「明文 secret 0 命中 + 反证 sha256」→ H3 + H2 ✔

---

## 3. 回滚

| 路径 | 覆盖方式 | 证据 |
| --- | --- | --- |
| 产品可见的回滚（确认词错误） | **真机**：`identity/reset-installation` 缺 confirm / 大小写不符 → `INVALID_INPUT`，7 张重置表 + 5 张身份表逐行不变，`device_audit` / `authorization_audit` 逐行不变，`audit_log` 只 +2 条 DENY | runId `20260929T023418Z-448b`（C1–C4、B6 基线披露） |
| 事务中途失败的整体回滚（注入式） | **node 层**（本批未在真机重复注入：真机没有注入入口，且不改产品代码无法注入）：`tests/d5-03-reset-device-identity.test.mjs` 的 **T4**（`DELETE FROM device_credentials` 注入）/ **T5**（`DELETE FROM devices` 注入）/ **T6**（`DELETE FROM installations` 注入）—— 三个注入点各证「逐表逐行回到重置前」，合起来排除「其实是两个独立事务」 | 本轮现场重跑：`batch7-gates-rerun` 的相关集合 **183/183 exit 0**（含这三条）；日志 `node-related.log` |

---

## 4. 受影响性分析（机械证据）

脚本：`experiments/d5-03/batch7-affectedness.mjs`，runId `20260929T023327Z-2abd-batch7-affectedness`，**6/6 PASS exit 0**，artifact sha256 `f1b704601be6338289815bbaf043af8f540c9c29e602aec0bb79ab3c983f2f9e`。

判据（机械）：一段门禁的源码里**是否出现** `openarc.device.command` / `device/*` 命令串、`identity/reset-installation"` 或 `resetInstallation(`、`SESSION_ORGANIZATION_MISMATCH` —— 出现即「执行到本批改动的符号」。

| 门禁 | device 命令 | reset 调用 | sessionOrgMismatch | 启动 electron . | 执行到改动符号 | 本批决定 | 理由 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mcp-reset-e2e` | 0 | **6** | 0 | 2 | **是** | **重跑** | 直接执行 identity/reset-installation（删除集合就是本批改动本身） |
| `mcp-device-reset-e2e`（本批新增） | **3** | 6 | **7** | 2 | **是** | **重跑** | 本批新增的真机门禁 |
| `device-ui` | **1** | 0 | 0 | 2 | **是** | **重跑** | 设备命令与 DeviceService 构造都在其执行路径上 |
| `identity-ui` | 0 | 0 | 0 | 2 | 否 | **重跑（保守）** | 它驱动的 init/login/restore/lock/logout 正是被改文件 `identity-store.cjs` 的主路径，也是 MCP 门禁依赖的同一段身份流程 |
| `mcp-center-e2e` | 0 | 0 | 0 | 2 | 否 | **复用第六批证据** | 源码 0 命中改动符号；身份公共路径由 identity-ui 的新鲜重跑覆盖 |
| `mcp-stream-e2e` | 0 | 0 | 0 | 2 | 否 | **复用第六批证据** | 同上 |
| `mcp-policy-e2e` | 0 | 0 | 0 | 2 | 否 | **重跑（保守）** | 最贴近身份/授权取数的 MCP 门禁（43 条），重跑成本约 90 秒，不留复用歧义 |

补注：**所有 7 段门禁都启动 `electron .`**，因此在启动期都会 require 被改的两个模块（`identity-store.cjs` 的 `RESET_AUTHORIZATION_DELETE_SQL` 是模块级常量，加载即求值）—— 这条「加载级影响」由本批 4 段新鲜重跑（reset / device / device-ui / identity-ui）覆盖，且它们与复用的 MCP 门禁走**同一个 `electron .` 入口 + 同一份 dist**（`dist/index.html` mtime 2026-09-28T08:37:38Z，sha256 前 16 位 `bbf403280bd809d8`；`src/` 最后一次提交 2026-09-28 16:36，dist 晚于它）。

---

## 5. 各门禁运行全值

### 5.1 本轮新鲜运行

| 门禁 | runId | counts | exit | artifact sha256 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `mcp-device-reset-e2e`（新） | `20260929T023418Z-448b-mcp-device-reset-e2e` | **44/44** | 0 | `c56ff79a4e2929bc13e082115b03ce3b0c7aa55f0c77774a8c903c90b32a5f81` | notVerified 0 |
| `mcp-reset-e2e` | `20260929T023431Z-91f9-mcp-reset-e2e` | **28/28** | 0 | `42af070f04d70ec067d09649f8f6163d577b3240c7384a0bd3609abc790f64eb` | 原 26 条不变 + 新 C2b/D2b |
| `mcp-policy-e2e` | `20260929T023443Z-2442-mcp-policy-e2e` | **43/43** | 0 | `76f6442cc684d14237d742dac4f6089671e150c4a10d7acf60d5a95ad1931e80` | notVerified 2（既有） |
| `batch7-gates-rerun`（node 面串行复核） | `20260929T023535Z-73ed-batch7-gates-rerun` | **4/4**（自身判定） | 0 | `82ef8862cd5e1afd9fc8b167b91b75f51cf19323aae4ddfb0d44eddd3b1b8fae` | 内含下面四步 |
| ↳ `node tests/device-ui.mjs` | 同上 run 目录 | **32/32** | 0 | 日志 `device-ui.log` | 真实 Electron |
| ↳ `node tests/identity-ui.mjs` | 同上 run 目录 | **26/26** | 0 | 日志 `identity-ui.log` | 真实 Electron |
| ↳ `node --test` 相关集合（29 文件） | 同上 run 目录 | **183/183** | 0 | 日志 `node-related.log` | 与 W45 报数一致 |
| ↳ `npm test`（全量） | 同上 run 目录 | **1376 tests / 1370 pass / 6 fail** | 1 | 日志 `npm-test.log` | 6 条失败见 §5.3 |
| `batch7-affectedness`（受影响性分析） | `20260929T023327Z-2abd-batch7-affectedness` | **6/6** | 0 | `f1b704601be6338289815bbaf043af8f540c9c29e602aec0bb79ab3c983f2f9e` | |
| `batch7-index-integrity`（索引与历史产物核对） | `20260929T024221Z-fd34-batch7-index-integrity` | **8/8** | 0 | `457f634ec0b896da1cc8ccd01d20b1d31929f2d567f328418a9fdaa06283174b` | 74 条索引逐条复算（核对自身在 finalize 前尚未入索引） |

### 5.2 `mcp-reset-e2e` 的文案更新与新增断言（逐字披露）

- **只改文案**：文件头「先删四张**授权事实**表 → 先删**七张**表（授权事实四张 + 第七批新增的设备身份三张 device_credentials → device_pairing_credentials → devices，子表先删）」；段说明 D 行同步；`AUTHZ_TABLES` 上方注释补一行说明新增的 `DEVICE_TABLES`；原 `device_access 0 → 0` 的 notVerified 文案里「node 受控测试 T1/T2 在四表都非空」→「**七张重置表都非空**」，并指向本批新门禁。
- **只增判定**（原 26 条标题与布尔表达式一字未改）：
  - `C2b`：被拒后三张设备身份表逐行不变（**如实标注**：本流程里设备三表本来就是 0 行，0 → 0 不作为清理证据）；
  - `D2b`：重置后三张设备身份表 0 行，并与 D2 的四张合计 = 重置删除集合**七张全 0**。
- 计数：`26 → 28`，两次运行可对照：本批前 `20260928T091457Z-f559`（26/26，sha `9c2c91a1eb5e9dc4b33d134ea377fa7c43511338ea133f5270a56de26133e254`，改动未生效的原始口径）→ 本轮 `20260929T023431Z-91f9`（28/28）。
- `C2b` / `D2b` 实测：`{"deviceSame":true,"before":{"devices":0,"device_credentials":0,"device_pairing_credentials":0},"after":{...0}}`；`{"deviceZero":[{"table":"devices","before":0,"rows":0},...],"sevenTables":{全部 0}}` —— 即该流程里设备三表 0 → 0，真正的 **1 / 1 / 2 → 0** 证据在新门禁。

### 5.3 全量 `npm test` 的 6 条失败（逐条给因，全部与本批无关）

| 失败用例 | 文件 | 实测原因 | 归类 |
| --- | --- | --- | --- |
| P2 · 当前会话 = A（owner）：推送投递…… | `tests/d4-03-approval-push-isolation.test.mjs` | 既有失败（第五/六批基线里同样两条之一） | 既有 |
| No Direct Domain Bypass：resource.trash 的唯一 Domain 调用点…… | `tests/side-effect-c4-gates.test.mjs` | 既有失败（同上） | 既有 |
| D4-02B-I5 · dsh / SDK 版本来自冻结路径 | `tests/harness-acp-isolation.test.mjs:95` | `expected '0.1.5-rc.2' / actual '0.2.0-rc.1'` | 环境漂移 |
| D4-02B-P1 · initialize / session-new / prompt / update / close | `tests/harness-acp-protocol.test.mjs:12` | 同上（版本断言） | 环境漂移 |
| D4-02B-P2 · Model 链路：Harness → Adapter → Model Proxy → Fake Provider | `tests/harness-acp-protocol.test.mjs:33` | 「Fake Provider 必须收到请求」—— 同文件版本漂移的连带 | 环境漂移 |
| official dsh 0.1.5-rc.2 通过 official profile bundle 加载…… exactly 2 个 READ_ONLY tool | `tests/tool-dsh-facade.test.mjs:32` | 同上（版本断言） | 环境漂移 |

机械佐证：这 5 个失败文件里对本批改动符号（`device/*`、`DeviceService`、`reset-installation`、`RESET_AUTHORIZATION_DELETE_SQL`、`device_credentials`）命中数 **全部为 0**；4 条环境漂移的断言文本就是被写死的 `0.1.5-rc.2`，而环境里 dsh 已升到 `0.2.0-rc.1`（第六批基线 1363/1365 时未出现）。总数 `1365 → 1376` 的 +11 条正是本批新增的 `tests/d5-03-reset-device-identity.test.mjs`（11 用例），与提交说明一致。

### 5.4 复用的第六批证据（同提交 d1ba058，未改写）

| 门禁 | runId | counts | exit | artifact sha256 | 复用判据 |
| --- | --- | --- | --- | --- | --- |
| `mcp-center-e2e` | `20260928T091508Z-967d-mcp-center-e2e` | 38/38 | 0 | `6726b742034d49c1f4bb09d252e6e8585339b94e1af567859421e26d6c070b1e` | 源码 0 命中 `device/*` 与 `reset-installation` |
| `mcp-stream-e2e` | `20260928T091545Z-23e3-mcp-stream-e2e` | 29/29 | 0 | `8df59d5277f10d1034f75a21a1ed953266f9057715752476fe99386edd044b34` | 同上 |

这两次的 artifact 在本轮核对里逐条重算 sha256 一致（见 §6），**没有被本轮验收改写**。

---

## 6. 索引 / 历史产物 / 临时目录核对

脚本：`experiments/d5-03/batch7-index-integrity.mjs`，runId `20260929T024221Z-fd34`，**8/8 PASS exit 0**：

- **I1/I2**：扫描时索引里 **74 条**产物的 `artifactSha256` 全部重新计算一致 —— 其中本批之前的 **64 条**历史产物逐条一致（历史 artifact 一条都没被改写），本批当时已入索引的 **10 条**也一致；本次核对自身在 finalize 之前尚未入索引，核对完成后索引 = **75 条**，其中本批共 **11 条**；
- **I3**：每条 `*.sha256` 边车内容与索引一致；
- **I4**：`index.jsonl` 与 `index.json` 逐条一致（无重复 / 无缺失 / 内容相等）—— 只追加索引没有丢过历史项；
- **I5**：没有「已 finalize 却没进索引」的运行。**如实列出 3 个孤儿目录**（都建立于 finalize 之前就退出，不含产物 JSON）：`20260928T084553Z-f364-auth-error-visual`（历史）、`20260928T092533Z-cf4e-batch6-r3-rebase-proof`（历史）、`20260929T023320Z-e3fc-batch7-affectedness`（**本批我自己的一次崩溃运行**：分析的 B1 期望值写错 → 异常退出 → 未 finalize；随后重跑两次，最终 `20260929T023327Z-2abd` 6/6）；
- **I6/I6b**：每条运行日志与其产物 JSON 里记录的 `logSha256` 一致；同时披露一个**既有工具缺口**：`run-artifacts.cjs` 的索引条目引用 `artifacts.logSha256`，而该字段是写在 artifact 上的，于是索引条目一致地没有 `logSha256`（扫描时 74/74 都缺，条目数变多也一致地缺）。本批**不改工具**，核对改用产物 JSON 里的值；
- **I7**：本批新增的每次运行都有 counts / artifactSha256 / cleanupSummary 且 `pkillUsed=false`。

**临时目录**：`ls -d /var/folders/*/*/T/oa-d503*` → **空**（本任务命名空间无残留）。每次运行的收尾日志都能看到 `[REMOVED] oa-d503b-<runId>-* ` 与「只清理本次运行 spawn 的 pid 树，未使用 pkill」「leftovers: []」。

---

## 7. 本执行岗自己的两次失败运行（如实披露）

| runId | counts | exit | 失败原因（全部是我的探针期望值/选择器 bug，不是产品缺陷） |
| --- | --- | --- | --- |
| `20260929T023111Z-0ab7-mcp-device-reset-e2e` | 30/41 | 1 | 基线快照取早了（心跳会 `touchDevice` 并写 `device_audit`，B2/B3 的动作落在基线之后 → C2/C3/D5 把正常写入误报成「被拒的重置改了状态」）；UI 设备行选择器 `[data-device-id]` 把行内 rename/disable/revoke 按钮也数进去（1 台设备数成 4 行）；新写的辅助函数返回字段叫 `equal` 而调用点写 `.ok`；D4 的「重置前计数」取错了字段；H2 想读「重置前那行」的 `secret_hash`，但那行已经被重置删掉了 |
| `20260929T023217Z-d1e4-mcp-device-reset-e2e` | 42/43 | 1 | 只剩 D4 一条：`login_attempts` 重置前 0 行（没造失败登录）→ 改为先故意错口令一次（真实 UI 表单），让身份五表在重置前全部有行 |
| `20260929T023320Z-e3fc-batch7-affectedness` | — | 2 | 脚本异常（B1 期望值字符串写错）→ 未 finalize、无产物；已修并重跑 |
| `20260929T023324Z-2e4e-batch7-affectedness` | 5/6 | 1 | B1 期望集合写漏了一段（`device-ui` 也机械命中改动符号）→ 已按实测改写期望并重跑为 6/6 |
| `20260929T024157Z-d0ec-batch7-index-integrity` | 5/7 | 1 | 我的核对脚本自身两处 bug：把「本次运行自己的 run 目录」算成孤儿；把日志 sha 去索引条目里取（索引一致地不记该字段，见 §9 遗留 1）→ 已修，改为排除自身 + 从产物 JSON 取 `logSha256`，重跑为 8/8 |

三条失败运行的 artifact（前两条）与目录（第三条）都留在 `artifacts/d5-03/runs/` 里，没有被覆盖或删除。

---

## 8. notVerified 清单

| # | 项 | 原因 | 替代证据 |
| --- | --- | --- | --- |
| 1 | **真机上的事务中途失败回滚（注入式）** | 真机没有注入入口，且本批不许改产品代码；W45 已在 node 层逐行证明 | `tests/d5-03-reset-device-identity.test.mjs` T4/T5/T6（三个注入点）；本轮现场重跑 183/183 |
| 2 | **视觉 / 动效量测** | 本批改动文件只有两个 `.cjs`，不含任何界面文件；没有像素变化可量 | 真机 UI 仅作功能驱动（设备面板选择器取值 + 与后端逐字对照，见 §2.1 A3/A4/B3/E2/E5） |
| 3 | 真机 `device_access` 的**产品 IPC** 入口 | `device:command` 白名单只有 10 条命令，没有授权入口 | 本轮在真实主进程对同一 DeviceService 直调 `grantDeviceAccess` 造 1 行 → 重置后 1 → 0（路径已披露）；`mcp-reset-e2e` 仍保留其 0 → 0 notVerified 并指向本报告 |
| 4 | 「产品侧 invariants() 的原生可读入口」 | `identity:command` 白名单里没有该命令（不新增产品入口） | `mcp-reset-e2e` 用同一判定的只读复算（结果为空）——该 notVerified 仍在本批的 reset 门禁产物里 |
| 5 | 「组织 ID 复用的真机对照」 | 产品没有「用指定 id 创建组织」的入口 | node T3（`mcp-reset-e2e` 现场重跑 exit 0） |
| 6 | 「共库双组织的真机行为级场景」 | 无产品入口可构造第二个组织（`mcp-policy-e2e` 既有 notVerified 2 条） | node 层 fixture 证据（该门禁既有口径，本批未改） |
| 7 | 真实第三方接入 / 插件隔离 | 不在本批范围 | 未连真实第三方、未发用户数据、未运行任意第三方程序；**不声称插件隔离通过** |

---

## 9. 遗留与建议

1. **工具缺口（既有）**：`run-artifacts.cjs` 的索引条目不去记录 `logSha256`（引用错了对象），导致 `index.json` 一致地缺该字段。建议后续批次修一行（`artifacts.logSha256` → `artifact.logSha256`）；本轮不改工具、改用产物 JSON 核对。
2. **孤儿 run 目录**：历史 2 个（`f364-auth-error-visual`、`cf4e-batch6-r3-rebase-proof`）+ 本批 1 个（我的一次崩溃运行）。都不含产物 JSON，不影响判定；建议后续统一清理或补一条索引说明。
3. **环境漂移**：`npm test` 的 4 条失败来自环境 dsh 已升到 `0.2.0-rc.1`，而测试里写死 `0.1.5-rc.2`。这不是本批回归，但会让「全量绿」长期不可得 —— 建议由维护方决定是钉住 dsh 版本还是把断言改成读冻结 runtime 的自报版本。
4. **设备侧动作缺产品通道**：`consumePairing` / `authenticateConnection` / `heartbeat` / `grantDeviceAccess` 在真机上只有主进程服务对象入口（无 IPC）。本批以「真实主进程 + 采集到的同一实例直调」取证并披露；是否要开一条设备侧命令通道属于产品方向，留给下一批决策。

---

## 10. 产物清单（本批全部运行）

| runId | 脚本 | counts | exit | artifact sha256 |
| --- | --- | --- | --- | --- |
| `20260929T023111Z-0ab7-mcp-device-reset-e2e` | mcp-device-reset-e2e | 30/41 | 1 | `2ebf7f1390b60e2d943680dfd390c5c1d6b43f381a0815e80a7e8ab3170d2b86` |
| `20260929T023217Z-d1e4-mcp-device-reset-e2e` | mcp-device-reset-e2e | 42/43 | 1 | `d4b30e6138775d47ac13dd81fadec90c698d4dc78b685b7d5a02925fe4e18c08` |
| `20260929T023418Z-448b-mcp-device-reset-e2e` | mcp-device-reset-e2e | **44/44** | **0** | `c56ff79a4e2929bc13e082115b03ce3b0c7aa55f0c77774a8c903c90b32a5f81` |
| `20260929T023431Z-91f9-mcp-reset-e2e` | mcp-reset-e2e | **28/28** | **0** | `42af070f04d70ec067d09649f8f6163d577b3240c7384a0bd3609abc790f64eb` |
| `20260929T023443Z-2442-mcp-policy-e2e` | mcp-policy-e2e | **43/43** | **0** | `76f6442cc684d14237d742dac4f6089671e150c4a10d7acf60d5a95ad1931e80` |
| `20260929T023535Z-73ed-batch7-gates-rerun` | batch7-gates-rerun | 4/4 | 0 | `82ef8862cd5e1afd9fc8b167b91b75f51cf19323aae4ddfb0d44eddd3b1b8fae` |
| `20260929T023327Z-2abd-batch7-affectedness` | batch7-affectedness | 6/6 | 0 | `f1b704601be6338289815bbaf043af8f540c9c29e602aec0bb79ab3c983f2f9e` |
| `20260929T024221Z-fd34-batch7-index-integrity` | batch7-index-integrity | 8/8 | 0 | `457f634ec0b896da1cc8ccd01d20b1d31929f2d567f328418a9fdaa06283174b` |
| `20260929T023303Z-0d3a-batch7-affectedness` | batch7-affectedness | 5/5 | 0 | `1b0e191c338799704763408600bf2ededf8056b89373896ff663edd4fd4c31ec` |
| `20260929T023324Z-2e4e-batch7-affectedness` | batch7-affectedness | 5/6 | 1 | `8c5b569e14289bbc128c977843d7bfe1110086c8efbcd89c7cbc98c824dd9c9b` |
| `20260929T024157Z-d0ec-batch7-index-integrity` | batch7-index-integrity | 5/7 | 1 | `8ebbd660c997e5a65b6daa67be7f076978b1c81e5b7316e9e5255e91c97d639e` |
| （崩溃，无产物）`20260929T023320Z-e3fc-batch7-affectedness` | batch7-affectedness | — | 2 | — |

边界声明（每次都写在产物里）：不接真实第三方、不发用户数据、不运行任意第三方程序、不声称插件隔离通过、探针不写 SQL（`databaseWritesByProbe=false`，写操作只经产品服务）、不改产品代码、不新增「创建组织」入口。
