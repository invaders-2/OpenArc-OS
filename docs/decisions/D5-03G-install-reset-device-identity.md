# D5-03 第七批 · 安装重置后旧设备身份失效 + 配对组织归属以会话为准

状态：**已实现并完成真机（Electron）验收** —— 2026-09-29 串行运行：新门禁 `mcp-device-reset-e2e` **44/44 exit 0**、安装重置门禁 **28/28 exit 0**、policy **43/43 exit 0**（notVerified 2，既有）、`batch7-gates-rerun` **4/4**（内含 device-ui **32/32**、identity-ui **26/26**、相关 node 集合 **183/183**、`npm test` **1376 tests / 1370 pass / 6 fail**）、受影响性分析 **6/6**、索引完整性 **8/8**；**本批改动文件不含任何界面文件**（视觉 / 动效 = 通过，本批无界面改动）。

* **判定：D5-03 第七批（安装重置后旧设备身份失效 + 配对组织归属以会话为准）= PASS（限定范围：功能通过；视觉 / 动效本批无界面改动）；D5-03 整体仍 = PARTIAL**（剩余缺口见 §10 / §12）。
* 被测内容 = 提交 `ed4502d`（产品修复）+ `cd06927`（门禁脚本与报告）；**artifact 记录的 `testedCommit` = `ed4502d8fc1f88f5aeea9db31df38e750e96dc47`**（11 个 batch7 artifact 全部同值）—— 逐条披露见 §1。
* 真机报告：`experiments/d5-03/D5-03-BATCH7-DEVICE-RESET-REPORT.md`；tracked 证据：`docs/D5-03-GATE-EVIDENCE.json` 的 `batch7` 段（**纯插入**：旧段逐字节未改）；**本批没有机器可读汇总 JSON**。
* 被测工作区：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`）。未 push、未合并 main、未切分支。

## 1. 被测内容、提交链与证据口径披露

| 项 | 值 |
| --- | --- |
| 分支 | `integration/ui-core` |
| 产品修复（被测提交） | `ed4502d`：**5 个文件** = 2 个产品文件（`electron/identity-store.cjs` 重置删除集合 4 → 7 张、`electron/device-service.cjs` 组织归属唯一来源）+ 3 个测试文件（`tests/d5-03-reset-authorization-consistency.test.mjs` 4 处断言改写、`tests/app-policy-provisions-retention.test.mjs` 守卫收紧、**新增** `tests/d5-03-reset-device-identity.test.mjs` 11 用例）；`+934 / −111` |
| 门禁脚本与报告（HEAD） | `cd06927`：**6 个文件，全部在 `experiments/d5-03/`**（新增 `mcp-device-reset-e2e.mjs` / `batch7-affectedness.mjs` / `batch7-gates-rerun.mjs` / `batch7-index-integrity.mjs` / `D5-03-BATCH7-DEVICE-RESET-REPORT.md`，改 `mcp-reset-e2e.mjs`），`+1865 / −5`；父提交 = `ed4502d` |
| artifact 记录的 `testedCommit` | `ed4502d8fc1f88f5aeea9db31df38e750e96dc47`（11 个索引 batch7 run 全部同值） |
| **区分（如实披露，不含糊）** | 真机运行发生在新增门禁脚本**已写入工作树但尚未跟踪 / 提交**时：受影响性分析（`2abd`）A2 记工作树只有 `?? experiments/d5-03/batch7-affectedness.mjs`、`?? experiments/d5-03/mcp-device-reset-e2e.mjs`，且 `trackedModified: []`、`productModified: []`；随后才提交成 `cd06927`。**本岗复核：HEAD 版 `mcp-device-reset-e2e.mjs` 的 sha256 `c7f809b6ef2a33f4a5620462d59f2a3a4b785646b156f5c654645ccb7ed5ddf5` 与 `448b` artifact 的 `scriptSha256` 逐字相等**（`mcp-policy-e2e.mjs` 同理：`df361aad…`）。**不写成「测试提交 = cd06927」，也不写成「产品修复与测试无关」。** |
| 证据根 | `artifacts/d5-03/runs/<runId>/`（artifact + `.sha256` + `.log`；新门禁另有 `identity.db.evidence` 4096 bytes、sha256 `97e8d54f8a7255106f66cf1b213c4a4d7b558d21310b1c2bfedc3d0d526dddda`）；索引 `artifacts/d5-03/runs/index.json`（只追加） |
| 索引复核（本岗独立复算） | 索引 **75 条** = 本批 **11 条** + 历史 **64 条**；75 个 artifact 逐条重算 sha256 = **75 一致 / 0 不一致 / 0 缺失**；报告 §6 记「扫描时 74 条 / 本批完成后 75 条」，与复核一致 |
| 未入索引目录（如实登记） | **3 个孤儿目录**（均无产物 JSON）：`20260928T084553Z-f364-auth-error-visual`（历史）、`20260928T092533Z-cf4e-batch6-r3-rebase-proof`（历史）、`20260929T023320Z-e3fc-batch7-affectedness`（本批自己的一次崩溃运行） |

## 2. 决策一：重置删除集合 4 → 7 张（子表先删，仍在既有的那个 `transactSync` 内）

背景（第五批登记的残留 + 本批核实的判据链）：`resetInstallation` 从第五批起清四张授权事实表，但**设备身份事实**一行不动 —— 旧设备在重置后仍能拿到连接与心跳放行（§3）。

* `electron/identity-store.cjs` 的 `RESET_AUTHORIZATION_DELETE_SQL` 由 4 条扩到**恰好 7 条**整表删除字面量：`app_policy_provisions` / `app_resource_grants` / `resource_grants` / `device_access`（授权四张，第五批）+ **`device_credentials` → `device_pairing_credentials` → `devices`**（设备身份三张，第七批）。顺序 = **子表 → 父表**：`device_credentials.device_id REFERENCES devices(id)`，`PRAGMA foreign_keys = ON` 下顺序反了会直接抛 FK 违约 → 被 `transactSync` **整体回滚**（表现为「重置失败」，而不是「删了一半」）。
* `resetInstallation` 仍在**既有的那个** `this.transactSync(() => { … })` 内：先 `for (const sql of RESET_AUTHORIZATION_DELETE_SQL) this.db.exec(sql)`，**随后**才删 `sessions` → `login_attempts` → `users` → `teams` → `installations`。
* **审计三表一行不删**：`audit_log` / `authorization_audit` / `device_audit`。真机：`device_audit` **8 → 8 逐行不变**、`authorization_audit` 逐行不变、`audit_log` 既有行一行不删（重置自身恰好 `DENY,DENY,OK_REQUESTED,OK`）。**口径逐字写清，不写成「行数不变」。**
* **常量名保留不改**：`RESET_AUTHORIZATION_DELETE_SQL` 现在含设备身份三张、名字偏窄，但它是 docs / 守卫 fail-closed 定位串与既有引用的**稳定锚点** —— 保留未改名，已在代码注释中显式披露。
* **为什么必须是字面量**：R6 守卫按**源码字符串字面量**逐条核对删除路径；把表名拼进 SQL 会让守卫看不见这条删除（fail-open）。
* **同事务证据（node，三个注入点，测试侧手段，产品代码没有后门）**：`tests/d5-03-reset-device-identity.test.mjs` 的 **T4**（打在第 1 条设备删除语句 `DELETE FROM device_credentials` 上）/ **T5**（打在 `DELETE FROM devices` 上）/ **T6**（打在身份最后一条 `DELETE FROM installations` 上）—— 每个注入点各证「逐表逐行回到重置前」，合起来排除「其实是两个独立事务、只是看起来像一起」。真机侧不可注入（notVerified ①）。

## 3. 决策二：为什么必须清 —— 判据链（本批核心，逐条可复核）

第五批只清授权表**不足以**让旧设备身份失效。四条旧事实的重置后可用性：

| 旧事实 | 取数 / 判定路径 | 为什么重置后仍能用 |
| --- | --- | --- |
| `device_credentials`（ACTIVE） | `credentialByFingerprint(fingerprint)`（`electron/device-store.cjs:51`）→ `authenticateConnection`（`electron/device-service.cjs:514`，`:520` 取数） | 指纹是 TLS 握手后「这个连接是谁」的**唯一查找键**，只看指纹与凭据可用性、**不看组织**；命中即 ALLOW（SUPER_ADMIN）。 |
| `devices`（Registry 行） | 上者的落点；`authorizeDevice` 的组织来源、凭据可用性判定要读 `credential_version` | 与 `device_credentials` 互为父子：只要两行都在，`authenticateConnection` 就能拿到设备身份。 |
| 心跳（旧长连接） | `heartbeat`（`electron/device-service.cjs:575`，`:585` 重新按指纹取凭据）→ `authorizeDevice` 用 `role:"ADMIN"` 的**合成 actor**（`:601`）走 Device Gate | 合成 actor **直接放行** —— 整条路径**不经过 `device_access`**，第五批清掉设备 ACL 也挡不住「旧凭据 + 旧 devices 行」。 |
| `device_pairing_credentials`（未消费未过期） | `consumePairing`（`electron/device-service.cjs:180`）只按 `pairingBySecretHash(sha256(secret))`（`electron/device-store.cjs:39/:43`）反查 | **不校验组织是否仍存在** → 重置后仍能把设备登记进那个**已删组织**（第五批 T7 实测的残留）；组织 id 一旦被复用，它还会变成新安装里的「既有设备」。 |

真机结果（runId `20260929T023418Z-448b-mcp-device-reset-e2e`，44/44 exit 0，探针只读 DB 全列逐行比对）：

| 快照 | devices | device_credentials | device_pairing_credentials | 授权四表（provisions / app grants / resource grants / device_access） | 身份五表 | device_audit |
| --- | --- | --- | --- | --- | --- | --- |
| B2_baseline（设备动作之后、两次错误 confirm 的基线） | 1 | 1 | 2 | 15 / 16 / 0 / **1** | 1/1/1/1/1 | **8** |
| C_after_bad_confirm（两次错误 confirm 后，逐行不变） | 1 | 1 | 2 | 15 / 16 / 0 / 1 | 1/1/1/1/1 | 8 |
| **D_after_reset（正确重置后）** | **0** | **0** | **0** | **0 / 0 / 0 / 0** | **0/0/0/0/0** | **8（逐行不变）** |

* 四条旧路径的重置后结果：旧**未使用**密钥 → `PAIRING_TOKEN_UNKNOWN` 且 **0 新设备 / 0 新凭据**（指纹反查 null）；旧**已消费**密钥 → 稳定拒绝（两次同码、不留任何行）；旧指纹 → `DEVICE_CREDENTIAL_UNKNOWN`；旧长连接心跳 → `DEVICE_CREDENTIAL_MISMATCH`。
* 重新初始化（新组织 id ≠ 旧组织 id）后：新密钥配对成功（1 设备 + 1 凭据，组织 = 新组织）；旧设备对新组织 `authorizeDeviceById` / `getDevice` → `DEVICE_NOT_FOUND`（对外理由 `NOT_FOUND_OR_FORBIDDEN`），设备列表 0 行。
* **`device_access` 1 → 0 的意义**：第五批的 notVerified「`device_access` 真机 0 → 0 不构成清理证据」**本轮闭环** —— 新门禁在真实主进程对产品自己的 `DeviceService` 直调 `grantDeviceAccess` 造 1 行，重置后真机 **1 → 0**（`device_access` 的产品 IPC 入口仍不存在，路径披露见 §7）。
* **明文 secret 0 命中并反证**：5 把密钥的明文在 DB 文件 / WAL / SHM / 68 张表逐字段 dump / 审计 payload / `userData` 下日志与 JSON / 主进程输出**全部 0 命中**；同时反证库里确有 `secret_hash` = **64 hex = sha256(明文)**。

## 4. 决策三：不清什么 + 理由（逐表判据，不做整库扫删）

用户明令禁止整库扫删，因此本批只把「**能恢复设备身份 / 权限**」的事实并入重置集合。判据 = 这张表的行**能不能恢复身份或权限**（不是「应该没事」）：

| 表 | 类别 | 为什么不清 | 可复核取数路径 |
| --- | --- | --- | --- |
| `device_audit` | 审计（三表之一） | 历史事实，不是身份 / 权限状态 —— **一行不删**（真机 8 → 8 逐行不变） | `device-store.cjs:68 / :69` |
| `resource_registry.device_id`（列） | 用户内容（资源目录的关联列） | 不产生身份 / 权限：判定要活 session + 活用户；该列只描述「资源与设备的关联」。**不整库扫删** | `authorization-store.cjs:44 / :50` |
| `departments` / `department_memberships` | 组织架构 | 无 `actions` / 权限列；`DEPARTMENT` 授权生效必须同时命中活用户成员关系，重置后无活用户 → 不可达。清了反而制造悬空引用 | `authorization-store.cjs:22 / :23 / :29 / :30 / :31` |
| `collections` / `resource_registry` / `content_objects` / `resource_relations` / `resource_import_jobs` / `tags` / `resource_tags` / `resource_favorites` / `resource_recent` / `projects` / `canvas_boards` | 用户内容 / 用户态 | 授权判定的**目标**，不是来源；不参与授权判定 | `authorization-store.cjs` / `resource-store.cjs` / `integration-store.cjs` / `canvas-store.cjs` |
| `model_providers` / `model_configs` / `model_defaults` / `model_credentials` | 模型配置 / 凭据引用 | 模型授权权威是 `app_resource_grants(resource_type='model')`（已清）；**凭据引用本身不产生身份 / 权限**（不像设备指纹那样当查找键放行） | `model-store.cjs:7 / :8 / :13 / :14 / :18 / :19 / :21` |
| `mcp_connections` / `mcp_credentials` | 连接配置 / 凭据引用 | mcp 授权权威是 `app_resource_grants(resource_type='mcp')`（已清）；连接自身按 `organization_id` 取 | `mcp-store.cjs:16 / :17 / :21` |
| `app_principals` | 安装级配置 | 无 `organization_id`，不是组织授权事实（第五批起登记为不受重置影响） | 第五批 §10 残留登记 |

**判据的边界如实说明**：本批只对**设备相关**的表做了「能否恢复身份 / 权限」的复核；其余表沿用第五批的逐表判据（`ORG_SCOPED_TABLE_COUNT = 27` = 清 7 张 + 不清 20 张，`orphanInventory()` 逐表盘点）—— 本批**未改**该判据集合，因为改动只落在设备三表与 `#sessionGate`，没有新增 / 删除带 `organization_id` 的表。

## 5. 决策四：配对与设备读取的组织归属唯一来源 = 会话反查的 `users.team_id`

背景：`context.organizationId || this.organizationId || gate.actor.organizationId` 这种「调用方自报优先」的兜底写法，让「配对签发给哪个组织」「设备列表读哪个组织」变成调用方说了算；`"org_default000000000000"` 更是一个**不存在的假组织**。

* `#sessionGate`（`electron/device-service.cjs:87`）新增**自报组织校验**（`:108`）：`context.organizationId` 与会话反查的 `user.team_id`（`users.team_id NOT NULL`）不一致 → **`SESSION_ORGANIZATION_MISMATCH`**（稳定错误码，**明确拒绝**）；与既有 `SESSION_USER_MISMATCH` **同形态**，**不静默忽略** —— 静默忽略会让越权调用以为自己成功了。
* **6 处**取数 / 判定改用 `gate.actor.organizationId`：`#createPairing`（签发组织）、`listPairings`、`listDevices`、`getDevice`、`#authorize`（Device Gate 的 actor）、`deviceAudit`。
* **删掉服务级 `organizationId` 入口**与 `"org_default000000000000"` 假组织兜底（全仓 `electron/` + `src/` grep 该串 = **0 命中**）。
* **`consumePairing` 的组织仍来自签发时的 `pairing.organization_id`**：设备侧动作没有会话，组织归属的唯一权威就是「这把密钥签发时属于谁」；调用方自报 `deviceIdentity.organizationId` 与之不匹配 → `PAIRING_TOKEN_ORGANIZATION_MISMATCH`（匹配也改不了落库组织，落库组织始终 = `pairing.organization_id`）。
* **真机证据（runId `448b`）**：写路径自报异组织 → `SESSION_ORGANIZATION_MISMATCH`，异组织行 0；读路径 5 个入口（`listPairings` / `listDevices` / `deviceAudit` / `getDevice` / `authorizeDeviceById`）各 1 条 `SESSION_ORGANIZATION_MISMATCH`，另自报异 `userId` 1 条 `SESSION_USER_MISMATCH`（同形态）；对照组（自报值 = 会话 / 不传自报字段）全部正常；跨组织 `pairing` → `PAIRING_TOKEN_ORGANIZATION_MISMATCH` 且 token 仍 `ISSUED`、0 新设备 / 0 新凭据。
* **为什么真机要这么取证**：渲染层递不进 `context.organizationId`（`device:command` 的 context 由主进程自建，`electron/device-bootstrap.cjs:54`）—— 这条校验的真机证据只能在真实主进程里对**同一个 `DeviceService` 实例**直调取得（§7）。

## 6. 决策五：守卫收紧（白名单 1 → 恰好 4 条 + `WATCHED_TABLES` + 两条 fail-closed）

| 项 | 第五批 | 第七批 |
| --- | --- | --- |
| 白名单 | 恰好 1 条（`app_policy_provisions`） | **恰好 4 条**（+ `device_credentials` / `device_pairing_credentials` / `devices`），每条带 `entry` / `reason` |
| 放行判据 | 文件 + 命中形态 + 去空白后逐字相等的完整语句 | **不变**（一处未放宽：多一个 `WHERE` 就不放行） |
| 独立清单 | 无 | **新增 `WATCHED_TABLES`**（4 张，`tests/app-policy-provisions-retention.test.mjs:426`）：出现这些表的 `DELETE FROM` / `DROP TABLE` / `TRUNCATE` / cleanup 式字面量都必须登记 —— **独立于白名单**：白名单里删掉一条登记项，这里仍然要求该表被整表删（fail-closed） |
| fail-closed 断言 | 四条（源码字面量 / 位于删除集合内 / `resetInstallation` 真的迭代它 / 在 `transactSync` 里） | **新增两条**：登记项必须在重置集合内；每张受 watch 表必须仍被**整表删** |
| 负向自证 | R6b 四类注入 | **4 组注入全 FAIL、对照组 PASS**（同形态重跑） |
| 有意不纳入 watch 的表 | —— | `app_resource_grants` / `resource_grants` / `device_access`：它们在正常业务路径上本来就有**带 WHERE 的单行删除**（`authorization-store.cjs:63/:66/:82/:83`、`device-store.cjs:64`）；把它们塞进「整表删除」白名单会逼着白名单接受带 `WHERE` 的条目 —— **那是放宽，不是收紧** |

## 7. 路径披露：设备侧动作真的没有产品 IPC 入口

* `device:command` 白名单只有 10 条命令（`electron/device-bootstrap.cjs:21-32`），**没有** `consumePairing`（设备侧动作）/ `authenticateConnection` / `heartbeat`（TLS 后连接身份）/ `grantDeviceAccess`（设备 ACL 写入）；而且 `device:command` 的 context 由主进程自建（`:54`），渲染层连自报 `organizationId` 的字段都递不进去。
* 新门禁的做法：真实 `electron .` + **Node 主进程调试口**（`--inspect`，只监听 127.0.0.1、端口独占）在真实主进程里给 `DeviceService.prototype` 的公开方法装一层**只记录、不改变行为**的包装，捕获**产品自己在真实 UI 路径上创建的那个 `DeviceService` 实例**与它收到的真实会话上下文；再用**被捕获的同一个实例**直调上面那几个没有 IPC 入口的服务方法（等价于另一台设备 / 管理端在真机上调用产品服务）。
* 约束（脚本自证）：**不改任何产品文件、不写任何 SQL**（探针查库一律 `DatabaseSync readOnly`；产物记 `databaseWritesByProbe=false`、`writesOnlyByProduct=true`）；会话 token 只在主进程内存里流转，回传探针的只有**长度 + sha256 前 16 位**；`OPENARC_SERVICE_IDENTITY` 是产品既有配置项（`electron/main.cjs:253`），本轮 Control Service 身份 = `svc_d503h_device_reset`。
* 这条路径披露本身就是一条 notVerified 的边界（`device_access` 的产品 IPC 入口仍不存在，见 §9 ③）。

## 8. 门禁断言改写与门禁变更披露（逐字）

### 8.1 被测提交自己改写的既有断言（4 处，出自 `tests/d5-03-reset-authorization-consistency.test.mjs` 文件头）

| 位置 | 旧期望（逐字） | 新期望（逐字） | 理由（逐字摘要） |
| --- | --- | --- | --- |
| T7 | 「残留的配对凭据确实还能登记设备（已登记的残留，本批不清）」 | 「`PAIRING_TOKEN_UNKNOWN`，0 台新设备 / 0 条新凭据」 | 那正是「重置后还能用旧密钥登记设备」的缺陷本身 |
| 文件头结论 | 「devices / device_credentials / device_pairing_credentials —— 设备与凭据登记（配置类）……凭据本身不构成资源/应用授权」 | 「这三张是**能恢复设备身份**的事实，随重置同事务清空」 | 凭据按 fingerprint 取数、配对密钥按 secret_hash 取数，两条路径都不比对组织；heartbeat 的 Device Gate 用 `role:"ADMIN"` 的合成 actor |
| T6 | 「重置要删的表集合恰好是登记的四张授权表」 | 「七张（四张授权 + 三张设备身份）」 | 删除集合本身扩到 7 条 |
| T2 | 「授权事实四表 0 行」 | 「七张全 0 行」 | 同上 |

**说明**：这 4 处由**产品提交 `ed4502d` 自己改写**并在文件头逐字披露；理由 = 这些断言刻画的正是本批要修的缺陷本身。**本岗未删改任何既有门禁断言。**

### 8.2 本岗对门禁脚本的改动（只增不删）

`experiments/d5-03/mcp-reset-e2e.mjs`：**只增** C2b（被拒后三张设备身份表逐行不变；如实标注本流程里设备三表 0 → 0，**不作为清理证据**）、D2b（重置后三张设备身份表 0 行，与 D2 的四张合计 = 七张全 0）+ 文案更新（四张 → 七张；`device_access` 的 notVerified 文案指向本批新门禁）；**原 26 条断言的标题与布尔表达式一字未改**，计数 **26 → 28**。对照：本批前 `20260928T091457Z-f559`（26/26，sha `9c2c91a1eb5e9dc4b33d134ea377fa7c43511338ea133f5270a56de26133e254`）→ 本轮 `20260929T023431Z-91f9`（**28/28**）。

### 8.3 runId 清单（11 个索引 run + 1 次崩溃运行）

| 用途 | runId | counts / exit | artifact sha256 |
| --- | --- | --- | --- |
| **新门禁**：设备身份重置真机 | `20260929T023418Z-448b-mcp-device-reset-e2e` | **44/44 · exit 0 · notVerified 0** | `c56ff79a4e2929bc13e082115b03ce3b0c7aa55f0c77774a8c903c90b32a5f81` |
| 安装重置一致性 | `20260929T023431Z-91f9-mcp-reset-e2e` | **28/28 · exit 0 · notVerified 3** | `42af070f04d70ec067d09649f8f6163d577b3240c7384a0bd3609abc790f64eb` |
| policy（第一批回归） | `20260929T023443Z-2442-mcp-policy-e2e` | **43/43 · exit 0 · notVerified 2** | `76f6442cc684d14237d742dac4f6089671e150c4a10d7acf60d5a95ad1931e80` |
| node 面串行复核（4 步） | `20260929T023535Z-73ed-batch7-gates-rerun` | **4/4 · exit 0** | `82ef8862cd5e1afd9fc8b167b91b75f51cf19323aae4ddfb0d44eddd3b1b8fae` |
| ↳ 设备界面 / 身份界面 / 相关 node 集合 / `npm test` | 同上 run 目录 | **32/32 · 26/26 · 183/183 · 1376-1370-6（exit 1）** | 日志见该 run 目录 |
| 受影响性分析（机械） | `20260929T023327Z-2abd-batch7-affectedness` | **6/6 · exit 0** | `f1b704601be6338289815bbaf043af8f540c9c29e602aec0bb79ab3c983f2f9e` |
| 索引与历史产物核对 | `20260929T024221Z-fd34-batch7-index-integrity` | **8/8 · exit 0** | `457f634ec0b896da1cc8ccd01d20b1d31929f2d567f328418a9fdaa06283174b` |
| 历史对照（探针缺陷轮，不作当前有效值） | `20260929T023111Z-0ab7` / `20260929T023217Z-d1e4` | 30/41 exit 1 / 42/43 exit 1 | `2ebf7f13…` / `d4b30e61…` |
| 历史对照（工装迭代轮） | `20260929T023303Z-0d3a` / `20260929T023324Z-2e4e` / `20260929T024157Z-d0ec` | 5/5 exit 0 / 5/6 exit 1 / 5/7 exit 1 | `1b0e191c…` / `8c5b569e…` / `8ebbd660…` |
| 崩溃运行（无产物、未 finalize） | `20260929T023320Z-e3fc-batch7-affectedness` | — | — |

**复用的第六批证据**（受影响性分析机械判据：源码 0 命中本批改动符号；本轮复算 artifact sha256 未变）：`mcp-center-e2e` `20260928T091508Z-967d` **38/38**（`6726b742034d49c1f4bb09d252e6e8585339b94e1af567859421e26d6c070b1e`）、`mcp-stream-e2e` `20260928T091545Z-23e3` **29/29**（`8df59d5277f10d1034f75a21a1ed953266f9057715752476fe99386edd044b34`）。

**全量 `npm test` 的 6 条失败（逐条给因，全部与本批无关）**：2 条既有 = `tests/d4-03-approval-push-isolation.test.mjs`（P2 推送投递）、`tests/side-effect-c4-gates.test.mjs`（No Direct Domain Bypass）；4 条环境 dsh 版本漂移 = `harness-acp-isolation` I5、`harness-acp-protocol` P1 / P2、`tool-dsh-facade`（断言写死 `dsh 0.1.5-rc.2`，环境已是 `0.2.0-rc.1`）。这 5 个文件对本批改动符号命中数**全为 0**；总数 1365 → 1376 的 +11 正是本批新增的 `tests/d5-03-reset-device-identity.test.mjs`。

## 9. notVerified 清单（7 条，以真机报告 §8 为准）

| # | 项 | 原因 | 替代证据 |
| --- | --- | --- | --- |
| 1 | **真机上的事务中途失败回滚（注入式）** | 真机没有注入入口，且本批不许改产品代码 | `tests/d5-03-reset-device-identity.test.mjs` **T4 / T5 / T6** 三个注入点；本轮现场重跑 **183/183** |
| 2 | **视觉 / 动效量测** | 本批改动文件只有两个 `.cjs` + 三个测试文件，不含任何界面文件 → 没有像素变化可量 | 真机 UI 仅作功能驱动（配对密钥由真实 UI 设备面板签发，界面加入码与服务返回值 sha256 逐字相等；设备行与后端一致） |
| 3 | `device_access` 的**产品 IPC** 入口 | `device:command` 白名单只有 10 条命令，**没有**授权入口 | 本轮在真实主进程对同一 `DeviceService` 直调 `grantDeviceAccess` 造 1 行 → 重置后真机 **1 → 0**（路径已披露）。**第五批的「0 → 0 不构成清理证据」至此闭环** |
| 4 | 「产品侧 `invariants()` 的原生可读入口」 | `identity:command` 白名单里没有该命令（不新增产品入口） | `mcp-reset-e2e` 用同一判定的只读复算（结果为空） |
| 5 | 「组织 ID 复用的**真机**对照」 | 产品没有「用指定 id 创建组织」的入口（`identity/initialize` 的组织 id 由产品随机生成） | node 受控 T3（`91f9` 现场重跑 exit 0，日志 `node-reset-consistency.log`） |
| 6 | 「共库双组织的**真机行为级**场景」 | 无产品入口可构造第二个组织（`mcp-policy-e2e` 既有 notVerified 2 条） | node 层 fixture 证据（该门禁既有口径，本批未改）；**本批未新增「创建组织」入口** |
| 7 | 真实第三方接入 / 插件隔离 | 不在本批范围 | 未连真实第三方、未发用户数据、未运行任意第三方程序；**不声称插件隔离通过**（D5-08） |

**继续单列（不并入本批）**：两条既有探针门禁（`governance-ui` **1/5**、`model-keychain-restart` **3/15**，**第六批**已用一次性授权 A/B 实证为既有失败）、**跨组织真机 2 条**、**OAuth**（仅 `NONE` / `BEARER`）、**插件隔离（D5-08）**、**D5-02 重命名受 Electron 不支持 `prompt()` 限制**、**SIGKILL 边界**、第五批登记其余残留（`app_principals.status` / `RATE_LIMITED` 对象 detail / `invariants()` 无孤儿行检查）。

## 10. 遗留与建议

1. **工具缺口（既有）**：`experiments/d5-03/run-artifacts.cjs` 的索引条目**不去记录 `logSha256`**（条目引用 `artifacts.logSha256`，而该字段写在 artifact 上）→ `index.json` 一致地缺该字段（核对时 74/74 都缺）。建议后续批次修一行（`artifacts.logSha256` → `artifact.logSha256`）；**本轮不改工具**，改用产物 JSON 里的值核对。
2. **孤儿 run 目录**：历史 2 个（`f364-auth-error-visual`、`cf4e-batch6-r3-rebase-proof`）+ 本批 1 个（`e3fc`，本批自己的一次崩溃运行）。都不含产物 JSON，不影响判定；建议后续统一清理或补一条索引说明。
3. **环境漂移**：`npm test` 的 4 条失败来自环境 dsh 已升到 `0.2.0-rc.1`，而测试里写死 `0.1.5-rc.2`。这不是本批回归，但会让「全量绿」长期不可得 —— 建议**维护方**决定是钉住 dsh 版本还是把断言改成读冻结 runtime 的自报版本（**本批不擅自改断言**）。
4. **设备侧动作缺产品通道**：`consumePairing` / `authenticateConnection` / `heartbeat` / `grantDeviceAccess` 在真机上只有主进程服务对象入口（无 IPC）。本批以「真实主进程 + 采集到的同一实例直调」取证并披露；是否要开一条设备侧命令通道属于**产品方向**，留给下一批决策。
5. **常量名偏窄**：`RESET_AUTHORIZATION_DELETE_SQL` 含设备身份三张表但保留原名（守卫与 docs 的定位串锚在它上面）；后续若要改名，必须同步更新守卫的 fail-closed 定位串、docs 引用与负向自证。

## 11. 相关代码与测试

* `electron/identity-store.cjs`：`RESET_AUTHORIZATION_DELETE_SQL`（**恰好 7 条**整表删除字面量，子表先删）+ `resetInstallation`（既有的那个 `transactSync` 内先清授权与设备身份事实、再删身份五表）+ 代码注释显式披露「常量名偏窄但保留」；
* `electron/device-service.cjs`：`#sessionGate` 自报组织校验（`SESSION_ORGANIZATION_MISMATCH`）+ **6 处** `gate.actor.organizationId` + 删假组织兜底与服务级 `organizationId`；`consumePairing` 的组织仍取 `pairing.organization_id`；
* `electron/device-store.cjs`：`credentialByFingerprint`（`:51`）、`pairingBySecretHash`（`:39/:43`）—— 两条**都不比对组织**的取数路径（本批判据链的落点）；
* 测试：`tests/d5-03-reset-device-identity.test.mjs`（**新增，11 用例**）、`tests/d5-03-reset-authorization-consistency.test.mjs`（4 处断言改写）、`tests/app-policy-provisions-retention.test.mjs`（白名单 4 条 + `WATCHED_TABLES` + 两条 fail-closed + 负向自证）；
* 验收脚本：`experiments/d5-03/mcp-device-reset-e2e.mjs`（新增）、`batch7-affectedness.mjs`、`batch7-gates-rerun.mjs`、`batch7-index-integrity.mjs`（新增）、`mcp-reset-e2e.mjs`（只增 C2b / D2b）。

## 12. 判定

* **D5-03 第七批（安装重置后旧设备身份失效 + 配对组织归属以会话为准）= PASS（限定范围）**：重置删除集合 4 → 7 张（子表先删、仍在既有的那个 `transactSync` 内）；真机设备三表 **1 / 1 / 2 → 0**、授权四表 **15 / 16 / 0 / 1 → 0**（含 `device_access` **1 → 0**）、身份五表 0、审计三表一行不删（`device_audit` **8 → 8**）；旧未使用密钥 `PAIRING_TOKEN_UNKNOWN` + **0 新设备 / 0 新凭据**、旧已消费密钥稳定拒绝、旧指纹 `DEVICE_CREDENTIAL_UNKNOWN`、旧长连接心跳 `DEVICE_CREDENTIAL_MISMATCH`；重初始化后新密钥配对成功、旧设备对新组织 `DEVICE_NOT_FOUND`；跨组织 `PAIRING_TOKEN_ORGANIZATION_MISMATCH`、自报组织 `SESSION_ORGANIZATION_MISMATCH`（写 + 读 + 对照）；并发恰好 1 设备 / 1 凭据；明文密钥 0 命中并反证 sha256；守卫 1 → 恰好 4 条 + `WATCHED_TABLES` + fail-closed；新增门禁 **44/44**、reset **28/28**、policy **43/43**、`batch7-gates-rerun` **4/4**、受影响性 **6/6**、索引完整性 **8/8**；`SCHEMA_VERSION` **仍 21**（无 schema 变更，只删行不删表）。
* **D5-03 整体仍 = PARTIAL**，剩余缺口 = §9 与 §10 逐条（跨组织真机 2 条继续保留 / 两条探针门禁既有失败待排期 / OAuth / 插件隔离（D5-08）/ D5-02 `prompt()` / SIGKILL 边界 / 本批新登记遗留 / 第五批登记其余残留）。
* **本批闭环的旧缺口**：第五批「`device_pairing_credentials` 未清 = 已登记的残留能力」（随重置同事务清空，真机 **1 / 1 / 2 → 0**、旧密钥 `PAIRING_TOKEN_UNKNOWN`、**0 新设备 / 0 新凭据**）；第五批 `device_access` 真机「0 → 0 不构成清理证据」（补成真机 **1 → 0**）；「重置后旧设备身份仍可用」这条缺陷本身。
* tracked 证据：`docs/D5-03-GATE-EVIDENCE.json` 的 `batch7` 段（纯插入）；本批决策 = 本文件；真机报告 `experiments/d5-03/D5-03-BATCH7-DEVICE-RESET-REPORT.md`。
