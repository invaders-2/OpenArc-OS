# OpenArc Local Resource Library 产品与实施补充计划

更新日期：2026-09-12

状态：PLANNING ADDED / NOT IMPLEMENTED

本文件是 `PLAN.md` 的专项补充，正式纳入 OpenArc OS 首版范围。它不代表资源库、部门、App 权限或 Agent 调用已经实现。真实完成状态仍以 `PROGRESS.md` 与阶段验收证据为准。

---

## 1. 产品定位

OpenArc Local Resource Library（中文：资源库）是 OpenArc OS 的本地知识与资产层，不是单纯素材库。

它同时服务：

- 用户手工管理本地资源；
- OpenArc Agent 检索和调用资源；
- 文件与项目；
- 无限画布；
- AI 任务；
- Skill / MCP / App；
- 历史记忆与项目记忆；
- AI 生成产物。

默认原则：**LOCAL FIRST**。没有用户明确行为或组织策略，不自动上传、不自动同步、不自动把内容发送给远程模型建立索引。

---

## 2. 资源库 App

新增正式桌面 App：

- App ID：`resource-library`（最终以 App Registry 冻结值为准）
- 显示名称：资源库
- 可从 Desktop / Dock / Global Search / AI 打开

UI 结构：

- 左侧：分类与 Collection；
- 顶部：搜索、类型、标签、排序、导入；
- 中间：Grid / List；
- 右侧 Inspector：预览、名称、描述、标签、Collection、来源、大小、版本、引用关系、权限、App 访问与 Agent 使用记录。

固定导航至少包含：

- All
- Memory
- Documents
- Images
- Videos
- Audio
- Code
- Prompts
- Generated
- Favorites
- Recent
- Trash
- Custom Collections

---

## 3. Resource 类型

第一版 Resource Type 至少覆盖：

- memory
- text
- document
- image
- video
- audio
- code
- prompt
- generated-artifact
- file
- other

类型必须可扩展，不得把资源系统写死为图片/视频素材管理。

---

## 4. ResourceDescriptor

第一版稳定资源描述至少包含：

- resourceId
- resourceType
- mimeType
- name
- description
- ownerUserId
- organizationId / teamId
- departmentId nullable
- scope
- collectionId nullable
- tags
- storageMode
- contentRef
- checksum
- size
- source
- version
- createdAt
- updatedAt
- deletedAt
- indexStatus

资源身份必须使用稳定 `ResourceRef`，不得使用文件名、显示名称、窗口标题、绝对路径或数组位置作为对象身份。

概念引用：`resource://res_xxx`。最终格式由 D3-04 冻结。

---

## 5. Storage Mode

### MANAGED

资源复制或写入 OpenArc Local Resource Store。

适合：图片、视频、文档、代码、Prompt、Memory、Generated Artifact。

### LINKED

只引用用户已有本地文件。

必须能明确显示：

- source moved
- source deleted
- source modified
- permission lost

LINKED 失效不得伪装为可正常读取。

---

## 6. 本地存储

概念目录：

```text
OpenArc Data/
└── library/
    ├── objects/
    ├── thumbnails/
    ├── generated/
    ├── cache/
    └── trash/
```

实际路径必须遵循 macOS / Windows 平台目录规范，不得硬编码 `/Users/...`。

Metadata 继续演进当前 SQLite 数据架构，不建立第二套数据库权威。

规划表：

- resources
- resource_versions
- collections
- tags
- resource_tags
- resource_relations
- resource_usage
- full-text index

---

## 7. Import 与完整性

MANAGED Import 必须：

1. copy temp；
2. checksum；
3. metadata 校验；
4. DB transaction；
5. atomic rename；
6. 成功后才宣布 Resource available。

失败必须清理临时文件，不允许出现 DB 有记录但文件未完成的半状态。

大文件必须支持进度、取消、磁盘空间检查和 partial import cleanup。

重复导入不得仅按文件名判断。建议：底层 content object 按 checksum 去重，Resource entry 可独立存在，以支持不同 Collection / 权限语义。

---

## 8. CRUD

用户可在资源库真实执行：

- Add / Import
- Drag & Drop
- Paste
- Create
- Preview
- Open
- Rename
- Edit
- Tag
- Move Collection
- Favorite
- Delete
- Restore
- Permanent Delete

普通删除进入 Trash。Trash 默认不进入 normal search、Agent retrieval、Canvas picker。

永久删除后，已有 `ResourceRef` 不得静默指向其他同名资源，而应显示 unavailable。

---

## 9. Collection 与 Tag

Collection 是逻辑组织，不等同文件夹路径。

建议第一版：

- Collection = primary organization；
- Tag = many-to-many secondary classification。

Tag 来源需区分：

- user
- system
- agent

Agent 自动标签不得静默覆盖用户标签。

---

## 10. Memory 作为正式 Resource

Memory 不是隐藏数据库能力，而是资源类型。

至少包含：

- Personal Preference
- Project Memory
- Decision Memory
- Conversation Memory
- Agent Memory

每条 Memory 必须有 ResourceRef、source/provenance、scope、createdAt、updatedAt、tags。

用户必须能够查看、编辑、删除和分类自己的 Memory。

Agent 只有在用户明确要求“记住/保存到资源库”或后续明确批准的自动记忆策略下创建 Memory；禁止把全部聊天默认永久写入资源库。

Personal Memory 默认不因加入组织或部门而自动共享。

---

## 11. Organization / Department

组织治理模型第一版：

```text
Organization / Team
└── Department
    ├── Department Admin
    └── User
```

第一版优先保持 Organization → Department → User，不提前实现无限层级组织树。

Department 至少包含：

- departmentId
- organizationId / teamId
- name
- description
- status
- createdBy
- createdAt
- updatedAt

支持创建、重命名、成员调整、管理员指定、停用与删除前重分配。

---

## 12. Super Admin

Super Admin 是组织内最高治理角色，可以：

- 创建、启用、禁用子用户；
- 发起密码重置流程；
- 创建、编辑、停用、删除 Department；
- 调整 Department 成员；
- 指定 Department Admin；
- 管理用户 / Department / Collection / Resource 权限；
- 管理 App Resource Access；
- 转移 Resource Ownership；
- 查看权限审计。

但 Super Admin 的“管理全部权限”**不等于读取原始凭据**。不得读取成员密码、个人 API Key、OAuth Token、Adobe/MCP Credential Secret。

默认也不把“能管理 Personal Memory 的访问策略”解释成“自动读取所有 Personal Memory 内容”。若未来企业模式需要管理员审计私人内容，必须做成显式组织策略并向用户可见。

---

## 13. Department Admin

Department Admin 只管理自己部门内被授予的范围，可管理部门成员、部门 Collection、部门 Resource 权限和部门级 App Access。

不得：

- 管理其他 Department；
- 创建/授予 Super Admin；
- 给自己提权；
- 授予自己无权管理的组织权限；
- 跨 Department 授权。

---

## 14. Resource Scope

第一版至少支持：

- PERSONAL
- DEPARTMENT
- ORGANIZATION

PERSONAL 默认仅 owner 可见；DEPARTMENT 只向对应 Department 内获授权用户开放；ORGANIZATION 用于全组织共享规范、公共素材、品牌资料、公共 Prompt 等。

从 PERSONAL → DEPARTMENT、Department A → Department B 等 scope/reparent 操作必须重新计算授权，不沿用不适用的旧继承权限。

---

## 15. Resource Permission Actions

第一版至少冻结以下逻辑 Action：

- resource.view
- resource.search
- resource.preview
- resource.read
- resource.create
- resource.edit
- resource.delete
- resource.restore
- resource.permanentDelete
- resource.download
- resource.export
- resource.share
- resource.tag
- resource.move
- resource.useByAgent
- resource.manageAccess

角色最终映射为 Permission Set，不能在业务代码中用角色名称代替动作授权。

建议 Permission Set：Viewer / Contributor / Editor / Manager，具体动作集合由 D3-02 冻结。

授权第一版采用：**DEFAULT DENY + ADDITIVE ALLOW**。不同时引入复杂 explicit deny precedence；若未来需要，单独升级 Policy Version。

---

## 16. Delegation

任何管理员只能授予自己有权管理范围内的权限。

必须拒绝：

- 普通用户给自己 manager/manageAccess；
- Department Admin 给自己 Super Admin；
- 用户授予别人自己并不拥有的权限；
- Department Admin 跨部门授权。

权限变更必须审计。

---

## 17. App 也是授权主体

每个访问资源库的 App 必须有稳定 `appId`，由 App Registry 冻结。

禁止使用显示名称、窗口标题、PID 作为 App 身份。

候选主体包括：

- resource-library
- canvas
- browser
- ai
- image-generator
- video-generator
- photoshop
- illustrator
- mcp-center
- skill-runtime

Internal App 也不等于无限权限。

---

## 18. 有效权限交集

Resource 访问必须满足：

```text
Session Valid
AND User Authorized
AND App Authorized
AND Resource Scope Authorized
AND Department Policy Authorized
AND Action Authorized
```

Agent 使用资源时额外要求：

```text
resource.useByAgent
```

任一条件不成立：DENY。

用户有权限不代表 App 自动有权限；App 有权限也不能替代用户权限。

---

## 19. AppResourceGrant

规划 App Resource Grant：

- appId
- resourceType / collectionId / resourceId
- departmentId / scope
- actions
- grantedBy
- createdAt
- expiresAt nullable

App 可以被限制到 Resource Type、Department、Collection 或单个 Resource。

App 更新若新增权限（例如 read → delete），必须重新授权；权限缩小可自动收紧。App disabled/uninstalled 后新的 Resource Access 立即 DENY，不删除用户 Resource。

---

## 20. App Manifest

App Manifest 需规划 Resource permission declaration，但最终字段名由 App Registry 阶段冻结。

概念：

```json
{
  "appId": "canvas",
  "resourcePermissions": ["resource.search", "resource.preview", "resource.read"],
  "resourceTypes": ["image", "video", "document"]
}
```

权限申请扩大必须触发重新授权。

---

## 21. Resource Picker

普通 App 不应先拿到全量资源库列表再自行过滤。

由 OpenArc 控制 Resource Picker，只展示：

```text
User Accessible ∩ App Accessible
```

用户选择后返回 `ResourceRef`，不是绝对路径。

后续可支持 Persistent Grant / Session Grant / One-time Capability。

Browser 的网页环境不能直接访问 Resource DB/API。网页上传资源只能通过 OpenArc Resource Picker 和明确用户动作。

---

## 22. Agent Resource Access

Agent 没有独立超级权限，也不能借高权限 App 提权。

标准链：

```text
User Request
→ Agent
→ Resource Search
→ Session Validation
→ D3-02 Authorization
→ App Context / resource.useByAgent
→ Resource Library Service
→ Authorized ResourceRef / Metadata / Snippet
→ 再 authorize(resource.read)
→ 读取必要内容
```

禁止：Agent arbitrary local filesystem scan。

Agent Search 返回 ResourceRef、安全 metadata、ranking、snippet；真正读取正文必须再次 authorize(read)。

Agent 的 create / update / delete / move / tag 属副作用，后续必须进入 D4-03 Tool Gate。

---

## 23. Context Builder

Agent 不得把大资源完整塞入模型上下文。

需规划 Resource Context Builder：

- 文本截断 / range；
- 代码 snippet / range；
- PDF page range；
- 图片引用；
- 视频 metadata / selected frames；
- Memory snippets。

500MB 视频搜索命中不等于把完整视频注入模型。

---

## 24. Search / Index

D3-04 第一版至少支持本地：

- name
- description
- tags
- collection
- text content

优先 SQLite FTS 或等价本地索引。

语义检索 / Embedding 属后续增强。未经明确允许，本地内容不得发送远程 embedding API；可以使用本地 embedding，或继续 metadata + FTS。

搜索必须发生在服务/Repository 授权边界，禁止 SELECT all → Renderer/Agent → 再过滤。

无权限对象不得泄漏 name、path、thumbnail、description、tags、snippet 或存在性统计。

---

## 25. Provenance / Usage

Agent 使用 Resource 时至少保留：

- resourceRef
- resourceVersion
- source
- retrievedAt

AI 生成结果可保存到 Library，并记录 source task / source model / createdAt。

`resource_usage` 记录 Resource 使用关系，但普通日志不保存完整敏感内容。

---

## 26. File Manager 与 Resource Library

File Manager ≠ Resource Library。

File Manager 管理文件系统 / 项目文件；Resource Library 管理用户主动纳入 OpenArc 的知识与资产对象。

文件可以存在于 File Manager 但尚未进入 Library；Memory / Prompt 则可以没有普通文件语义。

Canvas 引用资源优先保存 ResourceRef。资源版本策略（pin version / follow latest）由 D3-04 + Canvas 阶段进一步冻结。

---

## 27. 权限管理 UI

资源库与设置中规划以下界面：

### Super Admin

- Users
- Departments
- Collections
- Resources
- Apps
- Permission Matrix
- Audit

### Department

- Department List / Detail
- Members
- Department Admin
- Resource Collections
- Permissions
- App Access

### User

- Profile
- Department
- Status
- Resource Permissions
- Collections
- Agent Access
- Recent Permission Changes

### Resource Inspector / Access

显示：

- Owner
- Scope
- Department
- Inherited Access
- Explicit Grants
- Apps With Access
- Agent Access
- Permission Source

---

## 28. Audit

敏感治理与资源访问至少记录：

- actorUserId
- targetUserId nullable
- appId nullable
- departmentId nullable
- resourceRef / collectionId
- action
- decision
- permissionSource / reasonCode
- oldPermissions / newPermissions（权限变更时）
- requestId
- timestamp

不得写入密码、token、credential secret 或完整 Resource 内容。

---

## 29. 用户与部门生命周期

User Disable：D3-01 session 立即失效；新的 Resource Search / Read / Agent Retrieval 全部 DENY，Resource ownership 不自动删除。

User Delete：先 Disable，再 Transfer Ownership，再 Delete，避免遗留 Personal Resource / Collection / Generated Artifact。

Department Transfer：Department inherited permissions 立即重新计算；显式 User Grant 第一版建议保留，除非对应 scope 已非法。

Department Delete：建议 Disable → Reassign members/resources/collections → Delete，不允许仍有归属对象时直接删除。

---

## 30. Security Boundary

Resource Authorization 不能替代 OS filesystem sandbox。

- MANAGED Store 属 OpenArc 自己管理的数据；
- LINKED Resource 仍受真实 OS 文件权限约束；
- 不可信 Plugin 不得获得原始路径或任意 fs；
- App / Agent 必须通过 Resource Service；
- Browser WebContentsView 不得直接连接 Resource DB；
- Super Admin 也不得绕过 Credential Boundary。

当前冻结仍有效：`UNTRUSTED CODE EXECUTION = DISABLED BY DEFAULT`。

---

## 31. WBS 集成

现有依赖顺序不改变：

```text
D3-02 Object Authorization
↓
D3-03 Device Identity / TLS
↓
D3-04 Files / Projects / Local Resource Library
↓
D3-05 Identity & Data Gate
↓
D4 Agent Resource Retrieval / Execution
↓
D5 App / Skill / MCP / Plugin Integration
```

### D3-02 增补

Authorization Core 必须支持：

- User Principal
- Department Membership / Principal
- App Principal / Application Context
- Resource Scope
- Permission Action / Set
- Delegation Ceiling
- Collection / Resource Grant contract
- Agent `resource.useByAgent`
- User ∩ App ∩ Scope 权限交集
- query filtering / anti-enumeration

D3-02 不实现完整 Resource Library。

### D3-04 拆分

D3-04 改为：Files / Projects / Local Resource Library

- D3-04A Resource Object & Local Store
- D3-04B Resource Library CRUD & Classification
- D3-04C Index / Search / Preview
- D3-04D Files / Projects / Collection / Department / App Access Integration

### D4

D4-02 新增 Agent Resource Retrieval Adapter：search / list / metadata / read。

D4-03 新增 Resource Mutation Tool Gate：create / update / delete / move / tag；每次副作用重新验证 Session + User + App + Resource 权限。

### D5

App Registry / Skill / MCP / Plugin 最终接入 App Identity、Publisher、Version、Integrity、Permission Manifest 与 Resource Authorization。

---

## 32. 关键验收场景

### Resource

- LR-01 导入图片后出现在 Images，可预览；
- LR-02 创建 Memory 后可见、可编辑、Agent 在授权下可检索；
- LR-03 导入 Code 后可全文搜索片段；
- LR-04 Delete → Trash 后普通搜索和 Agent retrieval 均不可见；
- LR-05 Restore 后 ResourceRef 不变；
- LR-06 Permanent Delete 后引用显示 unavailable；
- LR-07 LINKED 文件移动后显示 source missing；
- LR-08 Canvas 引用 Resource 删除时显示影响范围；
- LR-09 Memory 修改后 Agent 下一次读取新版本；
- LR-10 Memory 删除后 Agent 不再可调用；
- LR-11 未授权 remote embedding 不上传本地内容；
- LR-12 Agent 直接扫描未纳入 Library 的任意本地路径 → DENY。

### Organization / Permission

- RP-01 Super Admin 创建 Department 与 User；
- RP-02 Department A 用户访问 Department B 资源 → DENY；
- RP-03 Department Admin 只能管理本部门；
- RP-04 Department Admin 自我提权 → DENY；
- RP-05 Viewer 可读不可写；
- RP-06 无 `resource.useByAgent` 时 Agent DENY；
- RP-07 Grant `resource.useByAgent` 后 Agent 可在其他权限同时满足时读取；
- RP-08 Revoke 后 UI / Agent 下一请求立即失效；
- RP-09 用户转 Department 后旧部门继承权限消失；
- RP-10 Disabled User 所有新 Resource 操作 DENY；
- RP-11 Personal Memory 其他子用户不可读取；
- RP-12 批量 Grant 部分失败返回逐项结果；
- RP-13 权限修改全部有 Audit。

### App

- AP-01 User ALLOW + App DENY → DENY；
- AP-02 User DENY + App ALLOW → DENY；
- AP-03 User ALLOW + App ALLOW → ALLOW；
- AP-04 App 只允许 Images，读取 Memory → DENY；
- AP-05 Photoshop 只授权 Design Collection，Marketing → DENY；
- AP-06 App 搜索无权资源 → 0 结果；
- AP-07 App 权限撤销后下一读取立即 DENY；
- AP-08 App 更新新增 delete 权限必须重新授权；
- AP-09 App 卸载后 Grant 失效，Resource 保留；
- AP-10 Browser WebContentsView 直接请求 Resource API → DENY；
- AP-11 Resource Picker 只显示 User ∩ App 结果；
- AP-12 Agent 借高权限 App 提权 → DENY；
- AP-13 App 借 Agent 提权 → DENY；
- AP-14 Disabled App 新 Resource Access 全 DENY；
- AP-15 App Access 有 Audit；
- AP-16 无权 App 不泄漏 Resource metadata；
- AP-17 Memory 默认不授权普通第三方 App；
- AP-18 Department Admin 不得给 App 授权其他部门；
- AP-19 Super Admin 可统一撤销某 App Resource Access；
- AP-20 stale capability 在真实调用时必须重新 authorize 并 DENY。

---

## 33. 当前执行决策

本计划加入后，**当前下一开发任务仍然是 D3-02 Object Authorization**。

原因：Resource Library、Department、App、Agent 都必须复用同一个 Authorization Core；如果先做 D3-04 Library UI/CRUD，再补 User/App/Department 权限，必然导致数据模型、查询、资源选择器和 Agent API 二次重构。

因此 D3-02 必须在实现前纳入本文件定义的 User / Department / App / Agent / Resource 授权契约，但不得提前实现完整 Library。
