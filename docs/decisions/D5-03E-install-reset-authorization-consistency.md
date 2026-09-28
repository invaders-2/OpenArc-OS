# D5-03 第五批 · 安装重置同事务清授权状态 + 登录失败文案收口

状态：**已实现并完成真机（Electron）验收** —— 2026-09-28 串行重跑：安装重置门禁 **26/26**、policy **43/43**（R3 重基线后）、center **38/38**、stream **29/29**、expiry-idle **26/26**（M1 假阳性修正后）、受影响性分析 **10/10**，**全部 exit 0**；文案视觉 **16/17**（唯一失败 = 浅色向导卡 `.auth-error` 实测 **2.62:1** 不达 4.5:1，**既有缺口，本批未改样式**）；本批改动文件**不含任何 `.css`**。 【**第六批已更新**：本节为第五批的历史正文，结论一条未删；被第六批改写的口径就地加【第六批已更新】。**第六批（App 授权组织隔离 + 登录错误行不透明内容底，`d1ba058` + `2944e45`）的判定 = PASS（限定范围）；D5-03 整体仍 = PARTIAL**，见 `docs/decisions/D5-03F-app-grant-org-isolation-and-auth-error-contrast.md` 与本文件的就地标注。第五批的 reset / center / stream / policy / 视觉五项已由第六批**同提交新鲜重跑**取代；`27eb` 的 **16/17 与 2.62:1 保留为修复前历史证据**。】

* **判定：D5-03 第五批 = PASS（限定范围：功能通过、视觉部分通过）；D5-03 整体仍 = PARTIAL**（剩余缺口见 §10）。
* 被测内容 = 提交 `09dccf9`（产品修复）+ `7ad424c`（门禁脚本与报告）；**artifact 记录的 `testedCommit` = `09dccf9c2cba5f21e787160de376a166db61a38d`**（10 个 batch5 artifact 全部同值）—— 逐条披露见 §1。
* 真机报告：`experiments/d5-03/D5-03-BATCH5-RESET-REPORT.md`（§9 = R3 重基线）；机器可读汇总：`experiments/d5-03/d5-03-batch5-summary.json`；tracked 证据：`docs/D5-03-GATE-EVIDENCE.json` 的 `batch5` 段。
* 被测工作区：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`）。未 push、未合并 main、未切分支。

## 1. 被测内容、提交链与证据口径披露

| 项 | 值 |
| --- | --- |
| 分支 | `integration/ui-core` |
| 产品修复（被测提交） | `09dccf9`：6 个文件 = 3 个产品文件（`electron/identity-store.cjs`、`src/identity/types.ts`、`src/identity/AuthScreens.tsx`）+ 3 个测试文件（`tests/app-policy-provisions-retention.test.mjs`、`tests/d5-03-reset-authorization-consistency.test.mjs` 新增、`tests/identity-session-expired-ui.test.mjs`） |
| 门禁脚本与报告（HEAD） | `7ad424c`：7 个文件，**全部在 `experiments/d5-03/`**（新增 `mcp-reset-e2e.mjs` / `auth-error-visual.mjs` / `batch5-affectedness.mjs`，`mcp-policy-e2e.mjs` R3 重基线，`mcp-expiry-e2e.mjs` M1 口径修正，报告与汇总），`+2719 / −24` |
| artifact 记录的 testedCommit | `09dccf9c2cba5f21e787160de376a166db61a38d`（重置门禁 `9cd0`/`d18e`、policy `b56c`/`db3d`、center `c7ba`、stream `cce3`、expiry `5288`/`f078`、视觉 `27eb`、受影响性 `e3b6` 全部同值） |
| **区分（如实披露，不含糊）** | 重置门禁 `mcp-reset-e2e` 与 `auth-error-visual` 是**本批新增、运行时仍未跟踪**的脚本，它们**就是在 `09dccf9` 上跑的**（artifact 记 `testedCommit=09dccf9`）；R3 重基线那次 policy 重跑（`db3d`）发生在 `mcp-policy-e2e.mjs` 的改动**已写入工作树但尚未提交**时（该 artifact 记 `gitDirtyLines=7`），随后才提交成 `7ad424c`。`git diff 09dccf9 7ad424c --stat` = **只改 `experiments/` 7 个文件，产品代码零改动** —— 所以「产品修复 = `09dccf9`」「门禁脚本/报告 = `7ad424c`」与 artifact 的 `testedCommit=09dccf9` 不矛盾。**不写成「测试提交 = 7ad424c」，也不写成「产品修复测试无关」。** |
| 汇总 JSON 的时点（如实披露） | `d5-03-batch5-summary.json` 的 `at=2026-09-28T07:09:52.721Z`，**冻结在 §9 的 R3 重跑（07:17）之前**：它记的 policy 是首轮 **42/43**、`indexRuns=43`，且不含 `db3d`。**当前有效的 policy 证据 = `20260928T071705Z-db3d-mcp-policy-e2e` 43/43**（索引现在 **44** 条）。两个数字并列，不互相顶替。 |
| 证据根 | `artifacts/d5-03/runs/<runId>/`（artifact + `.sha256` + `.log`；视觉 run 另有 `visual/` 截图；reset run 另有 `node-reset-consistency.log`）；索引 `artifacts/d5-03/runs/index.json`（只追加；§9.7 对 44 个 runId 重算 sha256：checked 44 / mismatch 0 / missing 0） |

**batch5 证据清单（10 个 artifact，串行、同一份 `09dccf9` 代码）—— 其中 7 个为当前有效证据（`9cd0` / `db3d` / `c7ba` / `cce3` / `f078` / `27eb` / `e3b6`），另 3 个（`d18e` 首轮探针参数缺陷、`b56c` R3 未重基线、`5288` M1 修前）仅作历史对照**：

| 用途 | runId | counts / exit | artifact sha256 |
| --- | --- | --- | --- |
| 安装重置一致性（最终有效） | `20260928T070842Z-9cd0-mcp-reset-e2e` | **26/26 · exit 0** | `17202b482ffea7aa587f7fb0f9d0e6cd92342997b424852450fa6e00fee37766` |
| 安装重置（首轮，含探针参数缺陷披露） | `20260928T065649Z-d18e-mcp-reset-e2e` | 26/26 · exit 0 | `495964b8ca826caf078dd542e9d88af027f2d4e6b07292fa32c38ad8d913d315` |
| policy（首轮，R3 未重基线） | `20260928T065727Z-b56c-mcp-policy-e2e` | 42/43 · exit 1 | `34d9fdd8866128cf181b9d9bafa1b73133f072db77a6760c62f07ed2f132e233` |
| **policy（重基线后，当前有效）** | `20260928T071705Z-db3d-mcp-policy-e2e` | **43/43 · exit 0 · notVerified 2** | `18fe75ba8a651b1427632ef2134955dc9af73bda593d988951912e147c0efa2f` |
| center（第一批回归） | `20260928T065801Z-c7ba-mcp-center-e2e` | 38/38 · exit 0 | `f40caac71cb5e8298b7659dde956775bc1a8ca31369c38ac83f467c7ebd85575` |
| stream（第三批回归） | `20260928T065841Z-cce3-mcp-stream-e2e` | 29/29 · exit 0 | `47ce54542391bd97806491c129077f63ce1a4ba225243c81eb6de4c1fa42960a` |
| expiry-idle（M1 修前，仅历史对照） | `20260928T065912Z-5288-mcp-expiry-e2e` | 24/25 · exit 1 | `0ed39614269dad2c12fb4a74a22a824b5698450063c06deba4ca8b639dd72259` |
| **expiry-idle（M1 修后，当前有效）** | `20260928T070551Z-f078-mcp-expiry-e2e` | **26/26 · exit 0** | `37e9dbb9d93cbe2d662f981a70e18d3a5d13f4273950cf4e90c43d5e25955176` |
| **视觉 + 动效（当前有效）** | `20260928T070627Z-27eb-auth-error-visual` | **16/17 · exit 1**（唯一 FAIL = 浅色对比度 V6a） | `506f2a48ad42f906591487583f17a0162eef57d4940d24866509a2fcc41759a8`【**第六批已更新**：本行是**第五批当时的**视觉证据；第六批已由 `20260928T094556Z-c729`（43/43 · exit 0）取代，`27eb` 的 16/17 与 2.62:1 保留为**修复前历史证据**（见本文件开头的【第六批已更新】与 `docs/decisions/D5-03F-app-grant-org-isolation-and-auth-error-contrast.md`）。】 |
| 受影响性分析（静态） | `20260928T070745Z-e3b6-batch5-affectedness` | 10/10 · exit 0 | `259d3dafa011e886714f604c45b564e0cc3250e8451df5b68d965e7f888c006f` |

## 2. 决策一：安装重置在**既有的那个** `transactSync` 内先清授权事实，再删身份

背景（第四批登记的残留）：`resetInstallation` 原本只删身份五表（`sessions` / `login_attempts` / `users` / `teams` / `installations`），**授权状态一行不动** —— 真机与 node 都复现过：重置后 `app_policy_provisions` 残留 15 行、`app_resource_grants` 残留 15 行，全部指向已从 `teams` 删除的组织。

* `electron/identity-store.cjs:1574` 新增常量 `RESET_AUTHORIZATION_DELETE_SQL`（**Object.freeze 的字面量数组**，恰好四条整表删除）：`app_policy_provisions` / `app_resource_grants` / `resource_grants` / `device_access`。
* `resetInstallation`（同文件 `:2767`）在 `this.transactSync(() => { … })` 内：先 `for (const sql of RESET_AUTHORIZATION_DELETE_SQL) this.db.exec(sql)`，**随后**才删 `sessions` → `login_attempts` → `users` → `teams` → `installations`。任一语句抛错 `transactSync` 整体 `ROLLBACK`。
* **为什么必须是字面量**：R6 守卫（`tests/app-policy-provisions-retention.test.mjs`）按**源码字符串字面量**逐条核对组织删除路径；把表名拼进 SQL 会让守卫看不见这条删除（fail-open）。
* **同事务证据（T1a / T1b 两个注入点，测试侧手段，产品代码没有后门）**：`tests/d5-03-reset-authorization-consistency.test.mjs` 只包住那一次 `db.exec` 注入抛错 ——
  * **T1a**：打在第 2 条授权删除语句上 → 逐表逐行与重置前一致（授权四表 + 身份五表 + 审计三表全表 dump 比对）；
  * **T1b**：打在身份最后一条语句（`DELETE FROM installations`）上 → 授权清理同样回滚。
  * 两个不同注入点都全量回滚，**排除「其实是两个独立事务、只是看起来像一起」的可能**。
* **审计三表一行不删**：`audit_log` / `authorization_audit` / `device_audit`。**口径逐字写清，不写成「行数不变」**：`audit_log` 既有行一行不删（前缀逐行相等），重置自身**恰好新增两条**（`OK_REQUESTED` + `OK`）；被拒的错误 confirm 各留一条 `DENY`（`error_code=INVALID_INPUT`）。`authorization_audit` / `device_audit` 在快照之间**逐行相等**。
* **真机只读 DB 快照（`runId …9cd0`，探针只读 `DatabaseSync readOnly`，没有任何写库代替主路径）**：

| 快照 | app_policy_provisions | app_resource_grants | resource_grants | device_access | installations/teams/users/sessions | 墓碑 | audit_log 行数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A_seeded（首次播种后） | **15** | **16** | 0 | 0 | 1/1/1/1 | 无 | 2 |
| B_before_reset（撤两条授权后） | 15 | 14 | **1** | 0 | 1/1/1/1 | canvas\|model、mcp-center\|mcp | 2 |
| C_after_bad_confirm（两次错误 confirm 后） | 15 | 14 | 1 | 0 | 1/1/1/1 | 同上（逐行不变） | **4** |
| **D_after_reset（正确重置后）** | **0** | **0** | **0** | **0** | **0/0/0/0** | 无 | **6** |
| E_reseeded（重新初始化 + 登录后） | **15** | **16** | 0 | 0 | 1/1/1/1 | 无 | 8 |

* 重置时四张授权表**都先有行**（15 / 14 / 1 / 0）→ 重置后全 0；**`device_access` 是 0 → 0，不构成清理证据**（见 §10）；node T1/T2 在四表都非空（含 `device_access`）下验了清理与回滚。
* 等价只读自检 `invariantsEquivalentReadonly`（与 `identity-store invariants()` 判定逐条等价）在 A/B/C/D/E 五个快照全部为 `[]`（真机 `identity:command` 白名单没有 `invariants()` 的原生入口，见 §10）。

## 3. 决策二：不做整库扫删 —— 27 张带 `organization_id` 的表逐表判据

用户明令禁止整库扫删，因此清理范围只认**授权事实**。判据表如下（表集合与数量由机器核对：`tests/d5-03-reset-authorization-consistency.test.mjs` 的 `ORG_SCOPED_TABLE_COUNT = 27`，`orphanInventory()` 逐表盘点 `rows/orphans`，T2 断言「带 `organization_id` 的表集合变了 → 必须重新逐表判定清理范围」）。

**清（授权事实，4 张）**

| 表 | 是否授权事实 | 能否复活 / 误导（为什么） | 处理 | 可复核取数路径 |
| --- | --- | --- | --- | --- |
| `app_policy_provisions` | 是（策略提供记录 + 撤销墓碑） | 组织 id 复用时旧墓碑**静默抑制新组织首次播种**（T3 实测：重置前同 id 播种 `seeded:false`，重置后 `seeded:true`） | **清** | `authorization-store.cjs:93 policyProvisionByKey(organization_id, app_id, policy_key)` |
| `app_resource_grants` | 是（App 侧 ACL） | **能直接复活权限**：取数 `appGrantsForApp(app_id)` **不带组织过滤**，判定 `evaluateAppAuthorization` 只看 `grant.app_id` + 目标覆盖（T5 实测：往不存在的组织写一条同形 grant → ALLOW，`allowSources` 含 `APP_GRANT`；删掉 → DENY） | **清** | `authorization-store.cjs:80` → `authorization-service.cjs:114` → `authorization-domain.cjs:547` |`authorization-store.cjs:80` → `authorization-service.cjs:114` → `authorization-domain.cjs:547`【**第六批已更新**：取数已改为按 **(app_id, organization_id)**（`authorization-store.cjs:80`）且组织为空/缺失 **fail-closed 返回空集**；判权层 `evaluateAppAuthorization` 逐条跳过异组织 grant（`authorization-domain.cjs:568`）。第五批「取数 `appGrantsForApp(app_id)` 不带组织过滤」是**第五批当时的事实**，其取证价值不变（本批即据此修复），**不再是当前口径**。详见 `docs/decisions/D5-03F-app-grant-org-isolation-and-auth-error-contrast.md`。】 |
| `resource_grants` | 是（User / Department ACL） | 判定按 `user.team_id` 过滤（`authorization-domain.cjs:490`），组织整体消失后不可达；但在**组织 id 复用**下会命中 —— 组织消失时就该一起消失 | **清** | `authorization-store.cjs:59 / :62`；判定 `authorization-domain.cjs:490` |
| `device_access` | 是（设备 ACL） | 取数 `accessOfDevice(device_id)`，`ORGANIZATION` 分支**不比对 `organization_id`** → 与「组织是否还在」无关 | **清** | `device-store.cjs:61 / :62`；`device-service.cjs #accessAllows` |

**不清（用户内容 / 配置 / 审计，23 张）** —— 判据是「不是授权结论的来源」或「授权生效另需活用户 / 权威授权表，已不可达」；不是「应该没事」：

| 表 | 类别 | 为什么可以不清 | 可复核取数路径 |
| --- | --- | --- | --- |
| `departments` | 组织架构 | 无 `actions` / 权限列，不是 grant 事实；`DEPARTMENT` 授权生效必须同时命中 `membershipsOfUser(活用户 id)`，而用户 id 是 24 字节随机、重置后无活用户 → 不可达。**清了反而新造不一致**：`collections` / `resource_registry` / `devices` 的 `department_id` 会悬空 | `authorization-store.cjs:22 / :23` |
| `department_memberships` | 组织架构 | 同上（成员关系不是授权结论） | `authorization-store.cjs:29 / :30 / :31` |
| `collections` | 用户内容（集合） | 授权判定的**目标**，不是来源 | `authorization-store.cjs:37 / :38` |
| `resource_registry` | 用户内容（资源目录） | 同上（判定要活 session + 活用户） | `authorization-store.cjs:44 / :50` |
| `content_objects` | 用户内容（内容实体） | 不参与授权判定 | `resource-store.cjs:35 / :36 / :37` |
| `resource_relations` | 用户内容 | 不参与授权判定 | `resource-store.cjs:63 / :64` |
| `resource_import_jobs` | 用户内容（任务态） | 不参与授权判定 | `resource-store.cjs:68 / :70` |
| `tags` | 用户内容 | 不参与授权判定 | `resource-store.cjs:85 / :86` |
| `resource_tags` | 用户内容（关联） | 不参与授权判定 | `resource-store.cjs:94 / :95` |
| `resource_favorites` | 用户态 | 不参与授权判定 | `resource-store.cjs:100 / :101` |
| `resource_recent` | 用户态 | 不参与授权判定 | `resource-store.cjs:105` |
| `projects` | 用户内容 | 不参与授权判定 | `integration-store.cjs:16` |
| `canvas_boards` | 用户内容 | 授权判定的**目标**，不是来源 | `canvas-store.cjs:13 / :18` |
| `devices` | 设备登记（配置） | 访问权威是 `device_access`（已清）；设备行本身不构成资源 / 应用授权 | `device-store.cjs:22` |
| `device_credentials` | 设备凭据（配置） | 同上 | `device-store.cjs:50 / :51 / :52` |
| `device_pairing_credentials` | 配对凭据（配置） | **本批新登记的残留**：重置前签发的配对凭据仍可再登记设备，但 T7 证明它**不产生授权结论**（`device_access` 已清 → 全部 DENY）；是否清属产品裁定 | `device-store.cjs:38 / :39` |
| `model_providers` | 模型配置 | 模型授权权威是 `app_resource_grants(resource_type='model')`（已清） | `model-store.cjs:7 / :8` |
| `model_configs` | 模型配置 | 同上 | `model-store.cjs:13 / :14` |
| `model_defaults` | 模型配置 | 同上 | `model-store.cjs:18 / :19` |
| `model_credentials` | 模型凭据引用 | 凭据引用本身不构成授权 | `model-store.cjs:21` |
| `mcp_connections` | 连接配置 | mcp 授权权威是 `app_resource_grants(resource_type='mcp')`（已清）；连接自身按 `organization_id` 取 | `mcp-store.cjs:16 / :17` |
| `mcp_credentials` | 连接凭据引用 | 同上 | `mcp-store.cjs:21` |
| `device_audit` | 审计（三表之一） | 历史事实，不是授权状态 —— **一行不删** | `device-store.cjs:68 / :69` |

## 4. 决策三：守卫**收紧**（`ALLOWED_ORG_DELETION_PATHS` 空数组 → 恰好一条）

| 项 | 第四批 | 第五批 |
| --- | --- | --- |
| 白名单 | `ALLOWED_ORG_DELETION_PATHS = []`（空 = 产品里没有合法删除路径） | **恰好一条**：`{file:"identity-store.cjs", pattern:"DELETE FROM", statement:"DELETE FROM app_policy_provisions", entry:"resetInstallation → RESET_AUTHORIZATION_DELETE_SQL", reason:…}` |
| 放行判据 | ——（空数组，无放行） | **文件 + 命中形态 + 去空白后逐字相等的完整语句**三者同时成立；**取消 `includes` 模糊匹配**（多一个 `WHERE` 就不放行） |
| fail-closed 加固 | 白名单外的删除 FAIL | 追加四条：登记项**必须在源码有对应字面量**；必须**位于 `RESET_AUTHORIZATION_DELETE_SQL` 内**；`resetInstallation` **必须真的迭代它**；迭代必须**在 `transactSync` 里** |
| 永久负向自证 | 无 | 新增 **R6b**（`tests/app-policy-provisions-retention.test.mjs:537`）：把真品 `electron/` 复制到临时目录，注入四类白名单外命中（别的文件 / 同文件多一个 `WHERE` / cleanup 式 / 跨字面量拼接）→ 同一份判据必须判为未登记命中；反向：登记的那一条必须仍放行 |
| 外跑留证 | —— | 本岗复跑（命令 + 结果原文见 §11）：`OA_RETENTION_ELECTRON_DIR` 指向**未注入**副本 → 7/7、exit 0；追加一条白名单外同表删除后 → **exit 1、6/7、R6 FAIL**，命中原文 `{"rel":"authorization-store.cjs","kind":"DELETE FROM","text":"DELETE FROM app_policy_provisions"}`；临时副本验完即删 |

**R5 的期望值更新（本批唯一允许改期望值处，逐字披露）**：`tests/app-policy-provisions-retention.test.mjs` 的 R5 旧期望刻画的是**缺陷现状**（重置后 `provisions=15` / `grants=15` / `墓碑原样保留`），本批修掉该缺陷后改为 **`0` / `0` / `null`**（并补「重置前墓碑必须真实存在」与四表整表归零断言）。测试文件头已写明「这是本轮唯一改期望值的地方」。**守卫本身没有被放宽** —— 它从「空数组」变成「恰好一条且逐字匹配安装重置的那条语句」。

## 5. 决策四：组织 ID 复用闭合（node 受控 T3）

* 真机**没有**「用指定 id 创建组织」的产品入口（`identity/initialize` 的组织 id 由产品随机生成；渲染层命令白名单里没有创建组织入口），**本批也没有新增该入口** —— 所以按第四批惯例用 node 受控测试作证据（T3），不靠改库构造。
* **T3 实测（现场重跑 `node --test tests/d5-03-reset-authorization-consistency.test.mjs` = 9/9、exit 0；日志 `artifacts/d5-03/runs/20260928T070842Z-9cd0-mcp-reset-e2e/node-reset-consistency.log`）**：同一个组织 id 上 —— 重置前播种被旧墓碑压制（`seeded:false`）→ 重置清除墓碑与授权行 → 重新初始化后同一 id `seeded:true`，且授权形状与**全新安装逐行同形**。
* 真机侧可观测的等价面：重置后旧组织 `app_policy_provisions` **0 行**、全表 0 条墓碑、新组织 id 与旧不同且 15 条提供记录逐条等于期望集合、`app_resource_grants` 16 条与重置前首次播种「组织无关形状集合」逐行同形（diff=[]）。

## 6. 决策五：登录失败文案收口（`SHOWABLE_ERROR_DETAIL`）

背景（第四批登记）：`errorText` 是通用括注实现，把内部 detail 原样括注给用户（真机出现过 `（idle）`；限流路径会把对象 detail 括注成 `（[object Object]）`）。

* `src/identity/types.ts:95` 新增 `SHOWABLE_ERROR_DETAIL`：**4 条，全挂 `INVALID_INPUT`，每条带 `text` / `codes` / `why`** —— `password-too-short`（「密码至少需要 8 位。」）、`password-mismatch`（「两次输入的密码不一致。」）、`identifier-taken`（「换一个账号名再试。」）、`display-name-too-long`（「显示名太长了。」）。`why` 写清「为什么这句话对用户可理解、可照做」。
* `errorText` = 「code 那一句 + 可展示 detail 白名单」；detail **只能经 `showableDetailText` 查表进来**，表外一律过滤（模板串 / `String(detail)` / 括号括注都不允许）。`RATE_LIMITED` 的 detail 是对象 `{retryAfterMs}`，按对象键查找必然查不到 → 被过滤（**但也未映射成人话**，见 §10 残留）。
* `src/identity/AuthScreens.tsx`：向导两次密码不一致**只发标记 `password-mismatch`**，不写第二份人话（两份文案会各自漂移）。
* **内部诊断原样保留**：日志 / 审计 / 连接的 `detail=expired:idle`、事件 payload 的 `reason` 都不变；被过滤的只是**进用户文案**这一条路径。
* 证据：node `tests/identity-session-expired-ui.test.mjs`（11/11，含对 **253 个内部标记**的全量断言「一律不进用户文案」）；真机 `auth-error-visual` 五个界面状态全文扫描 **11 个内部标记 + 旧括号形态 0 命中**，实测文案逐字正确：`输入不合法。两次输入的密码不一致。` / `输入不合法。显示名太长了。` / `账号或密码不正确。` / `尝试过于频繁，请稍后再试。`。

## 7. 决策六：R3 门禁重基线（固定 rev + 单文件白名单 → **登记表式**）

背景：R3 原口径是「本批 `c2e96c1`→HEAD 的 `src/` 改动 ⊆ 白名单 `['src/mcp/McpCenter.tsx']`」。第四/五批的 src 改动提交后，同一条检查把它们一并算进 diff → 实测 `srcDiff` 4 个文件（`src/mcp/McpCenter.tsx`、`src/identity/useIdentity.ts`、`src/identity/types.ts`、`src/identity/AuthScreens.tsx`），policy 42/43。**定性：功能行为零回归；这是「对着第三批基线的陈旧白名单」，不是判定削弱。**

| 项 | 旧口径 | 新口径 |
| --- | --- | --- |
| 基线 | `R3_BASE_REV = "c2e96c1"` | **同左（不变）** |
| 放行集合 | `R3_ALLOWED_SRC`：一个写死的文件数组 | `R3_REGISTRY`：**4 条登记项**，每条带 `batch`（哪一批 · 什么改动）、`why`（为什么允许改）、`requireAdded`（必含标记）、`forbidCode`（禁含形态）、`addOnly`（是否只增不删） |
| 逐条判据 | 只增不删 + 补丁含 `MCP_SESSION_ENDED` | 必含标记按**词边界正则** `\bMARKER\b`（旧实现是 `String.includes` → 改名成 `…_OFF` 不算命中）；**标记必须在 HEAD 存在**（防整段回退）；禁含形态在「新增行代码」与「HEAD 代码行」两处都必须 0 命中；`McpCenter.tsx` 的 `N TAB 0 TAB` 只增判据原样保留 |
| 表外 src 改动 | FAIL | **FAIL（不变）** |
| 取不到 git | FAIL | **FAIL**（`diffOk=false`；每个登记项的 patch / numstat / HEAD blob 任一为 null 也 FAIL，比旧版更严） |
| 判定式 | `outsideWhitelist.length===0 && addOnly && (kFails.length===0 \|\| kAllCascade)` | `r3Src.ok && (kFails.length===0 \|\| kAllCascade)` |
| k 段级联判据 | K1–K4/L2/L4 + 空态正则 | **逐字符未动**（同一段代码、同一个正则、同一个选取集合；检查文案与 expected 仍写明「下游失败的实际值全是列表空 / 没有行可采样 / 删除即时 / NO_MCP_GRANT 的授权已撤上下文」） |

* 4 条登记项（本轮实测，HEAD `09dccf9`、区间 `c2e96c1`→HEAD）：`src/mcp/McpCenter.tsx`（第三批 1b78953，addOnly，numstat 8/0，`MCP_SESSION_ENDED` HEAD=2 / 新增=2）、`src/identity/types.ts`（第五批 09dccf9，`SHOWABLE_ERROR_DETAIL`，禁含 `R3_DETAIL_LEAK` 0/0）、`src/identity/useIdentity.ts`（第四批 7b75ea3，`identityEventConvergence`，禁含 `R3_EVENT_REASON_DETAIL` 0/0）、`src/identity/AuthScreens.tsx`（第五批 09dccf9，`password-mismatch`）。
* **6 例负向自证全过**（副本注入 + 同一份判定函数；harness 末行「R3 负向自证：全部符合预期（6 个副本）」，exit 0）：对照 PASS；白名单外新增 / 白名单外修改既有文件 / 把 `detail: event.reason` 塞回 `useIdentity.ts` / `types.ts` 整段退回 `c2e96c1` / 只把标记改名 `…_OFF` → 全部 FAIL。
* **首轮抓到实现自身两个漏洞（如实披露，均已修并复跑）**：① 第一版「登记项不在 diff 里 → 直接跳过」放过了整段回退 → 改成 HEAD 不变量；② 第一版用 `String.includes` 匹配标记，`SHOWABLE_ERROR_DETAIL_OFF` 含该子串被放过 → 改成词边界正则。另有一轮对照 FAIL 是自证用例写错（对照组用了已被 checkout 的副本 HEAD），改显式 sha 后对照 PASS —— 工装问题，一并记录。
* 重跑结果：`20260928T071705Z-db3d-mcp-policy-e2e` → **43/43、notVerified 2、exit 0**；与上一轮 42/43 逐位置比对 → **唯一差异 = R3：FAIL → PASS**，其余 42 条（R1/R2 与全部 A–L、Z 段）状态一字未变。

## 8. 决策七（**订正**）：第四批的「孤儿行不可达、不致权限复活」只对 **user 侧**成立

**订正对象**：第四批文档写「重置后残留的旧组织授权行**不可达、不致权限复活**」。**该判定仅对 user 侧取数成立（判定按 `organization_id = user.team_id` 过滤），对 App 侧取数不成立** —— 本批已用代码 + 实测推翻。

* **代码（App 侧不过滤组织）**：`electron/authorization-store.cjs:80` 的 `appGrantsForApp: "SELECT * FROM app_resource_grants WHERE app_id = ? ORDER BY created_at, id"` —— **只按 app_id 过滤，完全不看 `organization_id`**；`electron/authorization-domain.cjs:547 evaluateAppAuthorization` 也只比对 `grant.app_id` 与资源覆盖，**没有任何组织判断**；取数调用链 `authorization-service.cjs:114 → authorization-store.cjs:80 → authorization-domain.cjs:547`。取数调用链 `authorization-service.cjs:114 → authorization-store.cjs:80 → authorization-domain.cjs:547`。【**第六批已更新**：该取数与判权实现已在第六批改掉 —— `appGrantsForApp(appId, organizationId)` 按组织取且空组织返回空集，`evaluateAppAuthorization` 逐条挡异组织行（含 `organization_id=''` 的无主行）；本条是**第五批当时的事实**，历史结论与取证价值不变。】
* **代码（user 侧确实过滤）**：`electron/authorization-domain.cjs:490` `if (user.team_id !== resource.organization_id)` —— user 侧判定的取数按 `organization_id = user.team_id`，所以第四批那句对 user 侧是对的。
* **实测（W37 的 T5 / T5b）**：往**不存在的组织** id（`team_ghost00000000000000000000`，`SELECT COUNT(*) FROM teams WHERE id = ?` = 0）写一条同形 grant → **立刻 ALLOW**，`allowSources` 含 `APP_GRANT`；删掉该行 → 回到 **DENY**（证明那次 ALLOW 的唯一来源就是这条孤儿行）。**T5b 产品级后果**：重置 → 重新初始化新组织 → 在新组织撤销 canvas 是**真 DENY**；把旧组织那条残留行种回去立刻变 **ALLOW（撤销失效）**。
* **这正是本批把授权表纳入重置同事务清理的原因 —— 不是卫生问题，是撤销失效路径。** 第四批原文保留不删，就地加【第五批订正】；本文件 §3 的判据表把 `app_resource_grants` 的「能否复活」一栏按实测填写。

## 9. 总经理裁定（本批决策，写进本文件即生效）

1. **守卫只放行「安装重置」这一条路径，不开放通用清理**：`ALLOWED_ORG_DELETION_PATHS` 恰好一条且逐字匹配；表外任何 `app_policy_provisions` 行删除（`DELETE` / `DROP` / `TRUNCATE` / cleanup 式 / 拼接式）一律 FAIL。**不做整库扫删**，用户内容与配置登记为不清（§3）。
2. **R3 采用登记表式基线，跨批不复位**：登记项带批次 / 理由 / 必含标记 / 禁含形态；**第六批若合法改到这 4 个文件之外，或改掉任一条的必含标记 / 引入禁含形态，R3 会 FAIL —— 这是 fail-closed 设计意图**，届时按同一形态新增或更新登记项，并重跑负向自证。届时按同一形态新增或更新登记项，并重跑负向自证。【**第六批已更新**：第六批正是按此形态处理的 —— R3 登记表**新增第 5 项 `src/styles.css`**（经总经理逐条授权），前 4 项一字未改，并重跑负向自证（runId `20260928T092753Z-e537`，4/4）；「登记表式基线、跨批不复位」的口径继续有效。】
3. **浅色 `.auth-error` 2.62:1 本批不改**（涉及设计值 / 视觉，属产品决策）：**登记为未闭合缺陷**，不做「看起来更达标」的临时改色，也不把不达标写成达标。

## 10. 未闭合项与残留（如实登记，不美化）

1. **`notVerified`：跨组织真机 2 条继续保留**（`mcp-policy-e2e`）—— 同一安装内第二个组织无产品入口 → 跨组织行为级只到 schema + node 级；**本批未新增「创建组织」入口**。
2. **本批新增并逐条列出（6 条）**：
   ① **组织 ID 复用真机不可构造** → 用 node 受控 T3（理由：产品没有「用指定 id 创建组织」的入口，不用改库构造）；
   ② **`device_access` 真机 0 → 0 不构成清理证据**（`consumePairing` 需要另一台设备带服务身份消费配对密钥，产品 IPC 没有授权入口）→ node T1/T2 在四表非空下覆盖；
   ③ **产品侧 `invariants()` 原生入口缺失** → 真机用等价只读复算 `invariantsEquivalentReadonly`（逐条等价），五个快照全空；
   ④ **`session-missing` / `not-locked` 真机不可达**（restore 失败时渲染层只回登录页、不显示错误行；unlock 只在锁屏可用）→ 五处真机 DOM 扫描 0 命中 + node 对 253 个内部标记的全量断言；
   ⑤ **浅色向导卡 `.auth-error` 实测 2.62:1 < 4.5:1** —— **判定不通过**（视觉轴因此为「部分通过」，不是「未验收」）；⑤ **浅色向导卡 `.auth-error` 实测 2.62:1 < 4.5:1** —— **判定不通过**（视觉轴因此为「部分通过」，不是「未验收」）；【**第六批已更新**：**已修复** —— `.auth-error` 加不透明内容底 `rgb(var(--content-rgb) / 1)`；真机复测向导面 **5.372:1 ≥ 4.5:1**（矩阵 10 格 × 2 面全绿，runId `20260928T094556Z-c729`，43/43、exit 0）。本条作为第五批的历史 notVerified 保留。】
   ⑥ **整窗截图与第四批窗口裁剪非逐像素同尺寸** —— 认证界面是全窗表面（2880×1880 设备像素 = 1440×940 CSS × DPR 2），第四批基准是 MCP 窗口 830×570 CSS 裁剪；窗口 / 缩放 / 背景 / 透明度同口径，**截图范围不同**。
3. **本批新登记的残留**：
   * `device_pairing_credentials` **未清**：重置前签发的配对凭据仍可再登记设备；T7 证明**不产生授权结论**（`device_access` 已清 → 全部 DENY）。建议下批处理或由产品裁定。
   * `app_principals.status` **不受重置影响**（安装级配置，`app_principals` 无 `organization_id`，不在 27 张表内）。
   * `RATE_LIMITED` 的 `{retryAfterMs}` 对象 detail **现被过滤，但未映射成人话**（用户只看到「尝试过于频繁，请稍后再试。」）。
   * `invariants()` **未加「孤儿授权行」检查**：本批把孤儿行清零了，但自检本身仍不检查该形态（理由：`invariants()` 是交付给 node 测试的判据、改动会牵动既有断言；代价：将来若再出现孤儿行，自检不会报）。
   * **浅色 `.auth-error` 2.62:1 未闭合**（§9 裁定 ③）。* **浅色 `.auth-error` 2.62:1 未闭合**（§9 裁定 ③）。【**第六批已更新**：**已闭环** —— 不透明内容底让该行合成背景与壁纸 / 玻璃档解耦，真机 **5.372:1**；`27eb` 的 2.62:1 保留为修复前历史证据，不作为当前有效值。】
4. 既有缺口继续单列（不并入本批）：**OAuth**（仅 `NONE` / `BEARER`）、**真实第三方与 Adobe / PS**（D5-04 / D5-05）、**插件隔离**（D5-08，连接成功 ≠ 插件隔离通过）、**D5-02 重命名受 Electron 不支持 `prompt()` 限制**、**SIGKILL 边界**（临时目录归属清理靠 `SIGINT` / `SIGTERM` + 收尾块，`kill -9` 靠 `cleanOrphans` 事后按三条件清理、默认 dry-run）。
5. 协议版本仍 `2025-06-18`；`SCHEMA_VERSION` **仍 21**；5 个工具调用入口仍全部 `MCP_TOOL_INVOCATION_NOT_ENABLED`。

## 11. 相关代码与测试

* `electron/identity-store.cjs`：`RESET_AUTHORIZATION_DELETE_SQL`（:1574，四条整表删除的字面量数组）+ `resetInstallation`（:2767，同事务先清授权再删身份）；
* `src/identity/types.ts`：`SHOWABLE_ERROR_DETAIL`（:95，4 条）+ `showableDetailText` + `errorText`（detail 只能查表进来）；
* `src/identity/AuthScreens.tsx`：向导只发 `password-mismatch` 标记；
* 测试：`tests/d5-03-reset-authorization-consistency.test.mjs`（新增，T1a/T1b/T2/T3/T4/T5/T5b/T6/T7 = 9）、`tests/app-policy-provisions-retention.test.mjs`（R1–R6 + R6b = 7，R5 期望改 0/0/null）、`tests/identity-session-expired-ui.test.mjs`（11）、`tests/identity-session-expiry.test.mjs`（12）、`tests/identity-store.test.mjs`（16）；
* 验收脚本：`experiments/d5-03/mcp-reset-e2e.mjs`（新增）、`experiments/d5-03/auth-error-visual.mjs`（新增）、`experiments/d5-03/batch5-affectedness.mjs`（新增）、`experiments/d5-03/mcp-policy-e2e.mjs`（R3 重基线）、`experiments/d5-03/mcp-expiry-e2e.mjs`（M1 口径修正 + M1b 负向自证；实质动效断言 0 处被改）。

**§4 表里「外跑留证」的命令与结果原文（本岗复跑，原仓库零写入）**：

```bash
T=$(mktemp -d /tmp/oa-d503e-guard-proof.XXXXXX); cp -R <workspace>/electron "$T/electron"
OA_RETENTION_ELECTRON_DIR="$T/electron" node --test tests/app-policy-provisions-retention.test.mjs
#   → # tests 7 / # pass 7 / # fail 0（未注入副本，基线全绿）
printf '\nconst OA_D503E_GUARD_INJECTED = "DELETE FROM app_policy_provisions";\n' >> "$T/electron/authorization-store.cjs"
OA_RETENTION_ELECTRON_DIR="$T/electron" node --test tests/app-policy-provisions-retention.test.mjs
#   → exit 1，# tests 7 / # pass 6 / # fail 1
#   → not ok 6 - R6 · 源码级：electron/** 只有安装重置这一条登记的 app_policy_provisions 行删除…
#   → 发现未登记的政策提供记录行删除…：[{"rel":"authorization-store.cjs","kind":"DELETE FROM","text":"DELETE FROM app_policy_provisions"}]
```

## 12. 判定

* **D5-03 第五批（安装重置同事务清授权状态 + 登录失败文案收口）= PASS（限定范围：功能通过、视觉部分通过）**：重置门禁 **26/26**、policy **43/43**（notVerified 2）、center **38/38**、stream **29/29**、expiry-idle **26/26**、受影响性分析 **10/10**，**全部 exit 0**；四张授权事实表真机 15/14/1/0 → **0/0/0/0**，审计三表一行不删（`audit_log` 既有行不删 + 恰好多重置自身两条）；27 张 `organization_id` 表逐表判据 + 整库扫删被拒；守卫收紧到「恰好一条 + 逐字匹配」并有永久负向自证 R6b；文案收口后内部标记 0 命中；视觉 = **部分通过**（唯一失败 = 浅色向导卡 2.62:1，既有缺口、本批未改样式）；**动效 = 通过**（本批改动文件不含任何 `.css`）。
* **D5-03 整体仍 = PARTIAL**，剩余缺口 = §10 逐条（跨组织真机 2 条 / OAuth / 真实第三方与 Adobe、PS（D5-04/05）/ 插件隔离（D5-08）/ D5-02 `prompt()` / SIGKILL 边界 / 本批新登记 5 条残留，含浅色对比度 2.62:1）。/ 本批新登记 5 条残留，含浅色对比度 2.62:1）。【**第六批已更新**：剩余缺口更新为「跨组织真机 2 条 / 两条探针门禁既有失败待排期（`governance-ui` 1/5、`model-keychain-restart` 3/15）/ OAuth / 设备配对凭据重置 / 插件隔离（D5-08）/ D5-02 `prompt()` / SIGKILL 边界 / 第六批新登记残留」；其中「浅色对比度 2.62:1」已闭合。】
* **本批闭环的旧缺口**：`resetInstallation` 孤儿授权残留（第四批登记，且其「不可达」判定被本批订正为「App 侧可复活」）；`errorText` 通用括注泄漏内部 detail（第四批登记）；R3 陈旧 src 白名单（第五批过程中暴露并重基线）。
* tracked 证据：`docs/D5-03-GATE-EVIDENCE.json` 的 `batch5` 段；本批决策 = 本文件；真机报告与汇总 JSON 见 §0 口径行；第三批决策 `docs/decisions/D5-03C-streamable-http.md`、第四批决策 `docs/decisions/D5-03D-session-expiry-and-policy-retention.md`（含【第五批订正】标记与第五批节）。
