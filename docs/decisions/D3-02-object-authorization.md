# D3-02 · Object Authorization / Department / App / Agent / Resource Permission Core

- **状态**：macOS Object Authorization Core **PASS**；overall **PARTIAL**（Windows OS enforcement NOT VERIFIED；Third-party App Identity Integrity NOT VERIFIED）
- **分支**：feature/d3-02-object-authorization，基线 8b46eb4（feature/resource-library-planning）
- **日期**：2026-09-12
- **范围**：只回答「当前用户，通过当前 App / Agent Context，能否对这个逻辑 Resource 执行这个 Action」。**不进入** 完整 Resource Library UI、文件管理器、预览系统、Embedding、Department Admin UI、App Registry、D3-03 Device Identity、D3-04 Resource Store、D4 Agent Retrieval、D5 Plugin/App Lifecycle。

---

## Scope

D3-01 回答「你是谁 / session 是否有效」。D3-02 在其上建立 OpenArc **唯一**的 Object Authorization Core：

身份主体（USER / DEPARTMENT / APP）+ 逻辑资源（Resource Registry）+ 授权（Grant / Permission Set）+ 权限查询（authorize / capabilities / search）+ 数据边界（anti-enumeration / session gate）。

后续 UI、Resource Library、File Manager、Canvas、Global Search、Agent、Harness、MCP、Skill、App、Adobe **全部复用**同一套 authorize()，不得各自发明 ACL。

冻结公式：

    Effective Resource Access
      = Session Valid
      AND User Authorized
      AND App Authorized
      AND Resource Scope Authorized
      AND Department Policy Authorized
      AND Action Authorized

Agent 场景额外要求 resource.useByAgent。任一项不成立 → DENY。默认 DEFAULT DENY，禁止任何 implicit allow。

---

## Threat Model

| 攻击者 | 能力 | 本轮防御 |
|---|---|---|
| A. 同机同 uid 进程 | 读同 uid 文件、连 127.0.0.1 | 授权核心是主进程服务；渲染进程只能下发只读查询；sessionRef 由主进程注入 |
| B. 被篡改的 Renderer | 能跑 JS、能改 DOM / localStorage | 权限判断不在渲染进程；userId / organizationId / sessionRef 一律不信 Renderer |
| C. 恶意 / 越权 App Context | 声称自己是别的 App | App 身份来自 App Principal 表；disabled / unknown App 默认 DENY |
| D. 越权 Agent | 借高权限 App 或 User 提权 | Agent 必须 User ∩ App ∩ useByAgent 同时成立 |
| E. 枚举攻击 | 猜 resourceId 探测存在性 | 无权 getResource / search 一律 NOT_FOUND_OR_FORBIDDEN，零 metadata |
| F. 管理员越权 | Department Admin 跨部门 / 自提权 | Delegation Ceiling + 跨部门边界 + No Self Escalation |
| G. 并发写入 | 两连接同时 grant / revoke | 数据库 UNIQUE 约束 + 单连接事务队列 + busy_timeout |

明确不是安全边界的东西（继承 D1-06 / D3-01 口径）：JS 路径检查、文件权限、应用层参数校验。它们负责正确性与防呆，不负责抵御恶意代码。D3-02 不关闭 D1-05 OS Sandbox blocker。

---

## Identity Inputs

authorize 的身份输入只有一个可信来源：**D3-01 Session**。

- sessionRef → identity.validateSession(sensitive) → user（真值）
- userId / organizationId / teamId / departmentIds 一律由主进程从 Session Membership + Resource Registry 推导，**不采信命令参数**
- App 身份来自 application.appId / context.appId → app_principals 表
- source（manual / ui / agent / system）**只进 Audit / Diagnostics，不参与提权**；代码里不存在 if source === agent allow
- agentSessionId 非空或 agent 标记为真，才进入 Agent 额外检查；source 不触发 Agent 语义（否则 manual / AI parity 会被破坏）

---

## Principals

第一版 Principal：

- USER
- DEPARTMENT
- APP

未来扩展 DEVICE / SERVICE；Device 属 D3-03，本轮不实现。所有 Principal 由数据库行承载，不使用显示名称、窗口标题、PID 作为身份。

---

## Super Admin

D3-01 的 Initial Admin（users.role = ADMIN）在 v2 迁移后成为 **Super Admin**，是 Organization Governance Role。

可以：创建/管理 Department；管理子用户状态与角色；指定 Department Admin；Grant / Revoke Resource Permission；Grant / Revoke App Resource Permission；Transfer Resource Ownership；管理 Collection Access；查看 Authorization Audit。

但 Super Admin **不是**代码里的 if admin → allow everything。所有能力集中在 Policy 中表达，且**治理权限与 Credential Secret 完全分开**：Super Admin 也不能获得 password / verifier / raw session token / 个人 API Key / OAuth token / Adobe 凭据 / MCP 凭据 / Keychain secret。

---

## Department

最小 Department Domain：departmentId / organizationId / name / description / status / createdBy / createdAt / updatedAt。

第一版层级：

    Organization（D3-01 root team）
    └── Department
        └── User

不提前实现无限层级 Sub Department。数据库约束：UNIQUE(organization_id, name)；organization consistency 由复合外键 (department_id, organization_id) REFERENCES departments(id, organization_id) 强制。

---

## Department Membership

departmentId / userId / membershipRole / status / createdAt。

角色只有 department-admin 与 member。Department Admin **不是**系统全局管理员。UNIQUE(department_id, user_id) 保证成员唯一。成员被移除或禁用后，下一请求立即失去该部门继承权限。

---

## Department Admin

Department Admin 只能管理自己部门范围：Department Resource、Department Collection、Department App Access、Department Member Resource Grants。

禁止：跨 Department、给自己 Super Admin、给自己超出 Delegation Ceiling 的权限。治理动作也走统一 Policy，而不是散落的 if。

---

## Delegation Ceiling

任何授权动作必须验证：

    grantorCanManage(target)
    AND
    grantorEffectivePermissions ⊇ permissionsBeingGranted

否则 DELEGATION_EXCEEDS_AUTHORITY。grantorCanManage = Super Admin，或目标部门的 Department Admin，或有效权限包含 resource.manageAccess。

**No Self Escalation**（真实测试）：普通 User grant self manageAccess → DENY；Department Admin grant self department-admin → SELF_ESCALATION_DENIED；Department Admin → Super Admin → NOT_SUPER_ADMIN；Department Admin grant OtherDepartment → CROSS_DEPARTMENT_DENIED；Editor 无 delete 时 grant delete → DELEGATION_EXCEEDS_AUTHORITY。

---

## Resource Registry

D3-02 使用**中央轻量 Resource Registry**，不是 Resource Library 内容数据库。只保存授权所需身份信息：

resourceId / resourceType / ownerUserId / organizationId / departmentId / collectionId / scope / parentResourceId / name / description / tags / version / status / createdAt / updatedAt

内容、文件路径、thumbnail、媒体 metadata 不在 D3-02，属 D3-04。resourceId 由 PRIMARY KEY 强制唯一，可用显式稳定 id（如 res_xxx）。

---

## ResourceRef

冻结稳定 ResourceRef，概念形如 resource://res_xxx。授权逻辑使用 resourceId；ResourceRef 只是稳定投影。**不得**用 filename、display name、absolute path、array index、window title 作为权限身份。

parseResourceRef / toResourceRef 在 authorization-domain.cjs；服务层 getResource / resolveResourceRef 只返回 ResourceRef，不返回绝对路径。

---

## Resource Scope

冻结：

- PERSONAL —— 默认 owner Policy；显式 USER grant 可分享
- DEPARTMENT —— 依赖 Department Membership + Grant；非本部门成员即使有显式 grant 也不生效
- ORGANIZATION —— 依赖组织 Policy / Explicit Grant；同组织成员获得 ORG_POLICY 基线（Viewer）

跨组织一律 DENY（ORGANIZATION_DENIED），organizationId 不信 Renderer，由 Session + Registry 决定。

---

## Actions

第一版冻结：

    resource.view / resource.search / resource.preview / resource.read
    resource.create / resource.edit / resource.delete / resource.restore
    resource.permanentDelete / resource.download / resource.export
    resource.share / resource.tag / resource.move
    resource.useByAgent / resource.manageAccess

其它 Domain 以后可增加自己的 action namespace。

---

## Permission Sets

逻辑 Permission Set 只是动作集合映射，本轮冻结：

| Set | Actions |
| --- | --- |
| VIEWER | view search preview read download export |
| CONTRIBUTOR | VIEWER + create edit tag move |
| EDITOR | CONTRIBUTOR + delete restore share |
| MANAGER | EDITOR + permanentDelete manageAccess |

**resource.useByAgent 有意排除在所有常规集合之外**：Agent 使用必须单独授予。

业务代码禁止 if role === editor；Role 只映射为 Permission Set，最终都调用 authorize()。

---

## Default Deny

DEFAULT DENY + ADDITIVE ALLOW。暂不引入 ALLOW / DENY / inherit deny / override deny 优先级系统；若未来需要 Explicit Deny，升级 Policy Version（当前 d3-02-v1）。

Grant 语义为**并集**：重复 grant 同一 principal/target 只保留一行并合并 actions，不会因一次不完整 grant 意外收回已授予动作。

---

## Owner Policy

PERSONAL Resource owner 通过**显式** OWNER_POLICY 获得全部动作（含 useByAgent / manageAccess）。这不是「没有 ACL 行 → allow」：探针能指出 Allow Source = OWNER_POLICY。

---

## Department Policy

- Department A → Collection A → Resource A 继承 VIEWER：read ALLOW / edit DENY
- Department grant 只对非 PERSONAL 资源、且用户是该部门 ACTIVE 成员时生效
- 撤销 Department Membership / Grant 后，下一请求立即失效，无需重登 / 重启
- 跨部门 / 跨组织全部 DENY

---

## Grants

ResourceGrant：grantId / principalType / principalId / resourceId / collectionId / resourceType / departmentId / scope / actions / permissionSet / grantedBy / createdAt / updatedAt。

只有一个授权权威：authorization-store.cjs + authorization-service.cjs。数据库 UNIQUE(principal_type, principal_id, resource_id, collection_id, resource_type, department_id, scope) 保证不产生不可解释的重复权限。所有目标字段 NOT NULL DEFAULT 空串（SQLite 对 NULL 不去重）。

---

## App Principal

正式加入 APP Principal。每个 App 使用稳定 appId；内置 Fixture：resource-library / canvas / browser / ai / image-generator / video-generator / photoshop / illustrator / mcp-center / skill-runtime。

app_principals 表：appId / name / publisher / status(enabled|disabled) / builtIn / createdAt / updatedAt。

D3-02 只实现逻辑 App Identity Contract + Built-in / Fixture Principal。App package integrity / Publisher / Version 属 D5：**Third-party App Identity Integrity = NOT VERIFIED**。

---

## App Grants

AppResourceGrant：appId / resourceType nullable / collectionId nullable / resourceId nullable / departmentId nullable / scope nullable / actions / grantedBy / createdAt / expiresAt nullable。

App 默认 DENY。User 授权不代表 App 授权；App 授权也不能替代 User 授权。

---

## Agent Permission

Agent 不是 Super Principal。Agent 使用 userId + session + appId（AI app / caller app）+ agentSessionId + action。

Agent 必须同时通过：User Authorization AND App Authorization AND resource.useByAgent。Agent 不能借高权限 App 提权；App 也不能借 Agent 已缓存的权限提权 —— App Context 必须参与真实调用授权。

---

## Authorization Intersection

    User ALLOW + App DENY → DENY
    User DENY + App ALLOW → DENY
    User ALLOW + App ALLOW → ALLOW

这是 D3-02 的核心铁律，已由 app-authorization.test 与 02-app-authorization 探针真实覆盖。

---

## Session Gate

所有 authorize 首先进入 D3-01 Session Validation：

- session revoked → SESSION_REVOKED
- session expired → SESSION_EXPIRED
- user disabled → USER_DISABLED
- session locked（受保护动作）→ SESSION_LOCKED + challenge REAUTH
- userId 与 Session user 不一致 → SESSION_USER_MISMATCH

ACL Grant 不能绕过身份状态：资产被撤销 / 过期 / 锁定时，即使 ACL 允许也是 DENY。

---

## Inheritance

Department / Collection 继承通过纯函数 evaluateUserAuthorization 计算，来源标记为 DEPARTMENT_GRANT；探针能指出 Allow Source。继承权限随 Membership / Grant / Reparent 的变化在下一请求重算，无缓存。

---

## Reparent

Resource 从 Department A → B：移除旧 Department inherited grant（deleteDepartmentGrantsForResource），B 的 Policy 重新计算。显式 USER grant 第一版保留，但若在新的 scope 下不合法（例如用户已不属于该部门）则不生效、不静默沿用。规则写入本 ADR。

---

## Query Filtering

建立服务端 listAuthorizedResources / searchAuthorizedResources（等价 Repository Predicate）。候选集只能来自 Resource Registry，且**只有通过 authorize 的**才进入返回结果。

禁止 SELECT all → Renderer → filter；禁止 SELECT all → Agent → filter。

App 搜索 = User Accessible ∩ App Accessible；Agent 搜索再 ∩ useByAgent。

---

## Enumeration Protection

Secret Resource Omega：无权用户猜 resourceId 调用 getResource() 得到 NOT_FOUND_OR_FORBIDDEN，不泄漏 name / owner / path / description / thumbnail / tag / collection / size / resourceType。search Omega / Secret / memory 返回 0，不泄漏 count / title / tag / owner。内部 Authorization Audit 记录真实原因（如 DEPARTMENT_DENIED），但不写 Resource name。

---

## Capability Projection

getCapabilities() 给 UI 生成 canRead / canEdit / canDelete / canShare / canUseByAgent / canManageAccess 等投影，**只是 UI projection**。最终 command 必须重新 authorize(action)。stale capability：UI 拿到 canEdit=true 后权限被撤销，绕过按钮直接调用 edit 仍然 DENY。

---

## Revocation

所有 Grant / Membership / App Grant 撤销下一请求立即生效：

- 不需要重新登录
- 不需要重启 App
- 不需要重启 OpenArc

实现原因：authorize 每次重新读 session / user / membership / grants，无进程内权限缓存。重复 revoke 幂等返回 NO_CHANGE。

---

## Concurrency

机制：连接内互斥队列 + BEGIN IMMEDIATE + SQLite 写锁 + busy_timeout 有界等待 + 数据库 UNIQUE 约束。

**本轮修掉一个真实缺陷**：identity-store.transact 原先无条件 await fn()，对同步事务体也会在 BEGIN 与 COMMIT 之间让出事件循环；两条连接并发写时，第二条同步阻塞在 BEGIN IMMEDIATE 上，事件循环被占住，第一条永远无法 COMMIT → 双方 5s 后 SQLITE_BUSY。现改为只对真正返回 Promise 的体（或 hook）await。

Grant Race：两连接并发 grant 同一 principal/resource → 最终恰好一行，动作并集；并发 revoke → 一个 changed、一个 NO_CHANGE，不抛异常。

---

## Migration

schema_version v1 → v2。v2 新增：departments / department_memberships / collections / resource_registry / resource_grants / app_principals / app_resource_grants / authorization_audit。

迁移按版本逐级前进，每一级各自是一个原子事务。任一级失败只回滚该级，不会留下 user_version 已升级但表不完整的半状态。已有 Installation / User / Session 迁移后 login / validate / lock / unlock 全部成立；Initial Admin 成为 Super Admin。

迁移失败注入：onMigration 在 v2 抛错 → 整级回滚 → user_version 保持 1、无 v2 表、v1 用户数据完整；修复后重开可正常迁移。

---

## Audit

authorization_audit 至少记录：actorUserId / targetUserId nullable / appId nullable / departmentId nullable / resourceRef / action / decision / reasonCode / permissionSource / requestId / timestamp；Grant / Revoke 记录 oldPermissions / newPermissions。

不记录 Resource 完整内容、password、session token、API key、Credential Secret。所有 User / Department / App Permission 与 Ownership Transfer 都产生 Audit。

---

## Unauthorized UI

D2-01 的 Unauthorized Page State 第一次真实接入。最小 Protected Resource Fixture：

- Viewer → 显示资源、只读（canEdit=false）
- 无权限 → 显示 Unauthorized，且不显示任何 Resource name
- 渲染进程不判断 role，只消费主进程 authorization/capabilities 结果

真实 Electron UI 探针 14/14 通过。

---

## Security Boundaries

D3-02 PASS 只代表 **Logical Object Authorization PASS**：

- 不代表 filesystem sandbox PASS
- 不关闭 D1-05 OS Sandbox blocker
- 不可信 Plugin 仍拿不到 fs / 原始路径
- Browser WebContentsView 内网页仍然 window.openarc === undefined；网页不能直接访问 Resource DB / Resource Service / Authorization API
- 上传文件必须由 OpenArc Resource Picker + User Action（D3-04）

Renderer 只能得到：safe identity snapshot、resource capabilities、safe Resource metadata、structured authorization error。禁止得到 raw Grant DB、password verifier、raw session token、credential secret、authorization internal SQL。

---

## D2-03 Handoff

已交付（缺任意关键能力 D2-03 继续 BLOCK）：

- authorize()
- getCapabilities()
- searchAuthorizedResources()
- listAuthorizedResources()
- resolveResourceRef()
- notificationReauthorize()

D2-03 的 Unauthorized / 搜索过滤 / 结果计数必须复用这些服务端接口，不得在 Renderer 重新过滤。

---

## D3-04 Handoff

明确交给 D3-04，不得重新发明 ACL：Resource Registry、ResourceRef、Scope、Owner Policy、Department Policy、Collection Authorization、User Grant、App Grant、Resource Picker Query Contract、Reparent、Delete grant cleanup、Search filtering、Agent useByAgent。

D3-04A/B/C/D 在此之上实现内容、CRUD、索引、预览、文件/项目集成。

---

## D4 Handoff

每个 Agent / Harness Resource 操作必须包含：validateSession → authorizeUser → authorizeApp → authorizeResource → authorizeAgentUsage。

副作用属 D4-03 Tool Gate：每个新副作用前重新 authorize；Authorization snapshot 不能给整个长任务无限复用。

---

## D5 Handoff

D5 App Registry 最终负责 appId / publisher / version / integrity / permission manifest / enabled state / permission upgrades。D3-02 当前只冻结 App Authorization Contract。

第三方 App 防伪：**NOT VERIFIED**。

App 权限扩大 contract 已冻结：read → read + delete 必须重新批准，不能静默继承；缩小权限可自动收紧。

---

## macOS

已实测（真实 Electron 44.3.0 / Node 24.20.0 / darwin arm64）：

- Authorization Core 在纯 Node 下 193/193 单测通过，6 个探针 56 条用例 PASS
- 真实 Electron UI 探针 14/14：Viewer 只读、无权限 Unauthorized、bridge 防枚举
- 授权与身份共用同一条 SQLite 连接与同一套装配

---

## Windows

**NOT VERIFIED。**

- Authorization **领域逻辑**跨平台可测（纯 Node，无平台分支），可以跑跨平台单测
- Windows Named Pipe / DPAPI / Windows App Identity / OS enforcement 全部未验证
- 不关闭既有 Windows Gate

---

## Tests

新增 unit test（node --test）：

    authorization-policy.test / department-policy.test / resource-scope.test /
    resource-grant.test / app-authorization.test / agent-authorization.test /
    delegation.test / inheritance.test / cross-department.test / cross-team.test /
    query-filter.test / enumeration.test / stale-capability.test /
    session-revalidation.test / migration.test / authorization-race.test

新增探针（experiments/d3-02，产物 artifacts/d3-02/*.json）：

    01-authorization-policy / 02-app-authorization / 03-agent-authorization /
    04-governance-delegation / 05-query-enumeration / 06-migration-race-session

新增真实 Electron UI 验收：tests/authorization-ui.mjs（npm run test:authorization-ui）。

---

## Evidence

| 入口 | 结果 |
| --- | --- |
| npm test | 193 / 193 PASS（D3-01 基线 96 + D3-02 新增 97） |
| npm run build | PASS |
| npm run test:d3-02 | 6 探针 PASS / PARTIAL 0 / FAIL 0（56 条用例） |
| npm run test:authorization-ui | 14 / 14 UI checks PASS（真实 Electron） |
| npm run test:d3-01 | PASS（D3-01 回归） |
| npm run test:identity-ui | 24 / 24 PASS（真实 Electron） |
| npm run test:d2-02 | PASS（含 security-surface，暴露面 6 → 7 已显式登记） |
| npm run test:design-system | 与基线一致 |
| npm run test:theme-baseline | 与基线一致 |
| npm run test:security | 与基线一致（D3-02 未扩大 Credential / IPC / Renderer 暴露面） |

产物：artifacts/d3-02/*.json。

---

## Remaining Gaps

1. Windows OS enforcement / Named Pipe / DPAPI / App Identity 未验证
2. Third-party App Identity Integrity 未验证（属 D5）
3. Resource Library 内容、CRUD、索引、预览、Resource Picker UI 未实现（属 D3-04）
4. Embedding / 语义检索未实现；本地内容不得未经允许发送远程 embedding
5. Department Admin / Super Admin 权限管理 UI 未实现（本轮只交付服务层 + 最小 Unauthorized fixture）
6. D1-05 OS filesystem sandbox blocker 仍然存在，D3-02 不关闭
7. 组织层级仍是 Organization → Department → User，未实现 Sub Department
8. Explicit Deny / Deny precedence 未引入，Policy Version 仍为 d3-02-v1
9. Resource 删除 / 永久删除 / Trash 语义属 D3-04，本轮只有 status + grant cleanup 契约
