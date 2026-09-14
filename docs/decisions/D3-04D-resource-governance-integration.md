# D3-04D · Resource Governance / Department / App Access / Resource Picker / Files / Projects / Canvas Integration

- **状态**：macOS Resource Governance & Integration Core **PASS**；overall **PARTIAL**（Windows 治理 UI / Picker / File / Canvas **NOT VERIFIED**）
- **分支**：feature/d3-04d-resource-governance-integration，基线 `feature/d3-04c-resource-search-preview` @ `eb90223`，**未 merge main**
- **日期**：2026-09-15
- **范围**：把 D3-04A/B/C 的 Resource Store / Library / Search / Preview 与 D3-01/02/03 的 Identity / Authorization / Device 整合成可真实使用的组织治理系统。**不进入** D3-05 / D4 / D5 / D6。

---

## Scope

Super Admin 治理 UI、子用户管理、Department CRUD 与 Department Admin 边界、Resource / Collection / App 权限管理、Agent useByAgent 呈现、系统 Resource Picker、Files → Resource / Resource → File、Projects、Canvas ResourceRef 集成、Scope / Ownership 治理、Audit、v6→v7 迁移。

## Organization Model

```
Organization(team)
├── Super Admin（role=ADMIN）
├── Department（department_memberships：member / department-admin）
├── Apps（app_principals + app_resource_grants）
└── Resources（resource_registry + resource_grants）
```

访问链固定为 `Session ∩ User ∩ Department/Organization ∩ App ∩ Resource ∩ Action`；Agent 额外要求 `resource.useByAgent`。**不建第二套 ACL**：治理 UI / Pickers / Files / Projects / Canvas 全部复用 D3-02 AuthorizationService，新增表只存引用关系。

## Super Admin

`GovernanceService.#adminGate`：Super Admin 或 Department Admin；普通用户一律 DENY。Super Admin 可 create/enable/disable user、initiate password reset、create/edit/disable/delete department、assign department admin、move user、view/grant/revoke resource access、grant/revoke app access、transfer ownership、change scope、view audit。

## User Management

新增 `governance:command`（受控白名单），UI 提供 Users 页面。`listUsers` 返回严格投影：identifier / displayName / role / status / departments；**绝不返回** password hash / salt / params / session token。

## Department

`createDepartment / updateDepartment / listDepartments / getDepartmentDetail / deleteDepartment`。Department ID 稳定；rename 不新建 identity。`deleteDepartment` 在仍有 members / resources / collections / grants 时拒绝，返回 `blockers` 与 `counts`。

## Department Admin

`department-admin` membership 可管理本部门（成员 / 部门 Collection / 部门资源 grant / 部门 App access）。不能管理其他部门、不能自我提权为 ADMIN、不能跨部门授权。治理读查询按 `adminDeptIds` 过滤。

## Permission Management

资源动作沿用 D3-02 冻结的 16 个 action；UI 只提供 Permission Set（Viewer / Contributor / Editor / Manager）+ `resource.useByAgent` 独立开关。角色字符串不是授权权威，最终仍展开为 action。

## Resource Access

`listResourceAccess` 返回 owner / scope / department / collection + 权限来源清单（OWNER_POLICY / ORGANIZATION_POLICY / DEPARTMENT_GRANT / COLLECTION_GRANT / EXPLICIT_USER_GRANT / APP_GRANT），回答"为什么这个人有权限"。Super Admin 有治理读权限，但**内容读取仍按用户侧策略判定**。

## Collection Access

Collection grant 由 `grantResourcePermission({ collectionId })` 表达；`explainResourceAccess` 将 collection grant 标注为 COLLECTION_GRANT。Collection 作为资源默认/继承来源，与单资源 grant additive 叠加。

## App Access

`listApps / getAppAccess / grantAppAccess / revokeAppAccess / setAppStatus`。内置 App baseline 沿用 D3-04A 现有 Policy；新 App 默认 DENY。Memory 单独显示，第三方 App 即使有 `resource.read` 也不自动读 Memory（`appGrantCoversResource` 对 memory 要求显式 type/resource/collection grant）。App disable 后下一资源请求立即 DENY；治理仍可重新 enable（D3-04B 修复的边界保持）。

## Agent Access

`resource.useByAgent` 是独立权限：有 read ≠ Agent 可用。UI / 探针分别显示 Manual Access 与 Agent Access。

## Delegation

`evaluateDelegation` + `evaluateSelfEscalation`：任何管理员只能授予自己有效权限范围内的 action；拒绝自我提权、跨部门授权、超出 ceiling。权限变更全部写 Audit。

## Resource Picker

系统级 `ResourcePickerService`：`query` 只返回 `User Accessible ∩ App Accessible ∩ Requested Type ∩ Requested Action`；复用 D3-04C Authorized Search Provider，不新建 picker index；Preview 复用 D3-04C Secure Preview。只返回 ResourceRef + 安全 metadata，绝不返回绝对路径 / internal object key。

## Picker Capability

`choose` 返回 ResourceRef + 短时 `selectionToken`（TTL 60s，绑定 user / app / resource / actions）。`validateSelection` **每次重新 authorize**：Grant 撤销 / App disable / 用户停用 / 部门迁移后立即 DENY，token 不是授权绕过。

## Files Integration

File Manager ≠ Resource Library。提供受控 `Add to Library`（Managed / Linked，经主进程 dialog）与 `Export / Save As`（`resource.export`，路径只来自主进程 dialog）。`resource/revealSource` 仅 LINKED、本地设备、source 有效时经 `shell.showItemInFolder`（路径不回 Renderer）。

## Projects Integration

v7 新增 `projects / project_members / project_resources`。Project 只引用 ResourceRef；`listProjectResources` 逐资源重新授权，未授权资源只返回 ref + `authorized:false`，不泄漏 name / metadata。加入 Project 不自动越权。

## Canvas Integration

v7 新增 `canvas_boards / canvas_resource_nodes`。节点保存 ResourceRef + resource_version + version_mode，不保存路径。状态由服务端计算：AVAILABLE / VERSION_AVAILABLE / UNAUTHORIZED / DELETED / UNAVAILABLE；未授权 / 删除节点不返回 resource metadata。

## Resource Version Contract

默认 `PIN_VERSION`：资源被替换不会静默改变画布内容；显式 `Update to latest` 才跟进。支持 `FOLLOW_LATEST` 模式。Trash → UNAVAILABLE，Permanent Delete → DELETED，撤权 → UNAUTHORIZED，且不崩溃、不泄漏 title。

## Scope Governance

`changeResourceScope` 支持 PERSONAL / DEPARTMENT / ORGANIZATION 互转；Super Admin 或 manageAccess manager 可执行。变更后**旧 Department 继承 grant 立即移除**；显式 USER / APP grant 保留并由 D3-02 冻结规则重新求值。`previewScopeChange` 返回 willGain / willLose / affected grants / incoming references。

## Ownership Transfer

`transferResourceOwnership` 与 `bulkTransferOwnership`：ResourceRef 不变、内容 version 不变；PERSONAL 资源转移后旧 owner 失去 OWNER_POLICY（除非显式 grant）。全部写 Audit。

## Memory Governance

Personal Memory 继续默认 Private。Super Admin 可以查看/管理 Access Policy，但默认不能读正文（`resource.read` 仍 DENY）。Organization Memory Audit Policy **DEFERRED**，未实现"管理员读所有 Memory"。

## Audit

`listAudit` 支持按 actor / target / app / department / resource / action / decision / 时间过滤；Department Admin 只能看本部门记录。治理操作（user / department / grant / revoke / app / ownership / scope）全部记录。**禁止写入** Resource body / Memory content / password / token / pairing secret / device key。

## Renderer Boundary

preload 新增受控 `governance.command`；resource 桥新增 picker / project / canvas / export / reveal 命令。没有 rawSql / rawAclTable / setRoleUnsafe / writeGrantRow / readCredential / readInternalPath。D2-02 security-surface 探针已显式登记桥接 10 键 / IPC 8 通道，15/15 通过。

## Migration

`SCHEMA_VERSION = 7`。v7 新增 projects / project_members / project_resources / canvas_boards / canvas_resource_nodes。v6→v7 逐级原子；失败注入回滚到 v6 且 v7 表不残留；Identity / Authorization / Device / Resource / Library / Search / Preview 数据不损坏。

## Performance

100 users / 20 departments / 10 内置 App / 10,000 resources：listUsers p95 ≈ 2.4ms，listDepartments（含 10k 资源计数）p95 ≈ 58ms，Picker p95 ≈ 582ms，authorized search p95 ≈ 231ms，RSS ≈ 338MB。Picker 复用 Search Provider 分页，不加载全量 DOM。

## macOS

真实 Electron 44.3.0 / Node 24.20.0：治理 UI 10/10、Resource Picker UI 8/8、Canvas Resource UI 8/8、5 个 D3-04D 探针 PASS、47 个 D3-04D 单测 PASS。

## Windows

**NOT VERIFIED。** Windows 治理 UI / Picker / File → Resource / Canvas 集成未在真机验证。

## D3-04 Gate

D3-04A/B/C/D 在 macOS 全部 PASS → **D3-04 macOS Files / Projects / Local Resource Library Core = PASS**；Resource Library macOS 首版核心由 PARTIAL 升级为 PASS。Windows NOT VERIFIED，跨平台 overall 仍 **PARTIAL**。**不写 OpenArc Resource System COMPLETE。**

## D3-05 Handoff

建议 **D3-05 Identity & Data Gate = GO**：统一验证 Identity / Authorization / Device / Resource / Department / App / Search / Preview / Governance，然后再进入 D4 大规模 Agent Resource 使用。D3-04D 冻结的治理边界、Picker 交集、ResourceRef 版本契约必须复用。

## Evidence

| 入口 | 结果 |
| --- | --- |
| npm test | 见 PROGRESS / Result（全部通过） |
| npm run build | PASS |
| npm run test:d3-04d | 5 探针 PASS / FAIL 0 |
| npm run test:governance-ui | 10 / 10 |
| npm run test:resource-picker-ui | 8 / 8 |
| npm run test:canvas-resource-ui | 8 / 8 |
| D2-02 security-surface | 15 / 15（桥接 10 键 / IPC 8 通道显式登记） |
| 回归 d3-01 / d3-02 / d3-03 / d3-04a / d3-04b / d3-04c + 既有 UI 探针 | 见 Result |

## Remaining Gaps

1. Windows 治理 / Picker / File / Canvas **NOT VERIFIED**
2. Renderer-only 治理权限矩阵 UI 只做真实操作入口，未做完整 Subject×Permission 矩阵可视化（Domain 能力已具备）
3. Organization Memory Audit Policy **DEFERRED**（未实现管理员读私人内容）
4. App Access History / Agent Use History：D4 未存在，界面显示"No recorded usage"，不伪造
5. 批量操作 UI（multi-select）未实现；bulkGrant / bulkTransfer 已在服务层与命令层可用
6. Projects / Canvas 的实时协同与冲突合并属后续阶段
