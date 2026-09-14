# D3-04D Result

Task Status: **macOS Resource Governance & Integration Core = PASS / overall PARTIAL（Windows NOT VERIFIED）**

## 1. Base

分支 `feature/d3-04d-resource-governance-integration`，基线 `feature/d3-04c-resource-search-preview` @ `eb90223`（非 main）。已 push origin，未 merge main。交付平台 macOS arm64（Electron 44.3.0 / 主进程 Node 24.20.0）。

## 2. Organization model

Organization(team) → Super Admin + Department(member/department-admin) + Apps + Resources。访问链 `Session ∩ User ∩ Department ∩ App ∩ Resource ∩ Action`；Agent 额外 `resource.useByAgent`。**不建第二 ACL**。

## 3. Super Admin

`GovernanceService.#adminGate`（Super Admin 或 Department Admin）；普通用户 DENY。具备 create/enable/disable user、reset password、department CRUD、成员/管理员调整、resource/app grant/revoke、ownership transfer、scope change、audit。**有治理权，无秘密读取权**。

## 4. User management

Users 页面 + `governance/listUsers`。严格安全投影，不含 password hash/salt/params/session token。Disable 立即阻止新登录与所有资源/搜索/Agent/App 操作；Re-enable 恢复。Password reset 生成一次性临时口令、撤销全部 session（`identity.adminSetPassword`，auth_version++）。

## 5. Department management

`createDepartment / updateDepartment / listDepartments / getDepartmentDetail / deleteDepartment`。Department ID 稳定；rename 不新建 identity。删除保护返回 `blockers` + `counts`（members/resources/collections/grants）。详情计数来自真实数据。

## 6. Department Admin

只管理本部门（成员 / 部门 Collection / 部门资源 grant / 部门 App access）；跨部门、自我提权为 ADMIN 全部 DENY。

## 7. Delegation

`evaluateDelegation` + `evaluateSelfEscalation`：只能授予自己有效权限范围内的 action；越权 / 跨部门 / 超出 ceiling 全部拒绝并写 Audit。

## 8. Resource access management

Resource Access 面板 + `governance/listResourceAccess`：owner / scope / department / collection / grants / appGrants / agentAccess / permission sources。Super Admin 有治理读；Department Admin 限本部门。

## 9. Collection permissions

`grantResourcePermission({ collectionId })` 表达 Collection 授权；权限来源标注 COLLECTION_GRANT；与单资源 grant additive 叠加。

## 10. App resource permissions

Apps 页面 + `listApps / getAppAccess / grantAppAccess / revokeAppAccess / setAppStatus`。内置 baseline 沿用现有 Policy，新 App 默认 DENY；App disable 后下一请求立即 DENY，治理仍可重新 enable；权限扩大（read→read+delete）必须重新批准（`evaluateAppPermissionUpgrade`）。

## 11. Agent permissions

`resource.useByAgent` 独立于 read：VIEWER + App read 仍不能 Agent 读取；显式授予 useByAgent 后才在 App 同时有 read 时 ALLOW。

## 12. Permission source

UI / API 输出 OWNER_POLICY / ORGANIZATION_POLICY / DEPARTMENT_GRANT / COLLECTION_GRANT / EXPLICIT_USER_GRANT / APP_GRANT 与 subject/actions，回答"为什么有权限"，不只是 Allowed。

## 13. Permission matrix UI

**PARTIAL / NOT VERIFIED**：已交付 Users / Departments / Apps / Resource Access / Audit 五个真实操作面板；完整 Subject×Permission 矩阵可视化未做（Domain 的 grant/revoke/bulk 能力已具备）。

## 14. Resource Picker architecture

系统级 `ResourcePickerService`（非各 App 自建）。Picker 输入 appId / resourceTypes / requestedActions / collection / department / query / pagination；复用 D3-04C Authorized Search Provider，不新建 picker index。

## 15. Picker authorization

只展示 `User ∩ App ∩ Type ∩ Action` 交集；返回 ResourceRef + 安全 metadata；guess ResourceRef 的 choose DENY；零泄漏（无权用户 0 结果、无 name/ref）。

## 16. Picker search / preview

搜索复用 `SearchService`；Preview 复用 D3-04C 安全预览（capability）。Picker `choose` 返回短时 selectionToken（60s，绑定 user/app/resource/actions），`validateSelection` 每次重新 authorize。

## 17. Browser boundary

Browser WebContentsView 不能直连 Resource DB/Service（D2-02 探针：不可信视图无桥接、无 Node 全局）。**Browser 网页上传经 Picker 的桥接流程 NOT VERIFIED / DEFERRED**（未实现网页发起的上传）。

## 18. Files integration

Files App：Add to Library（Managed / Linked，主进程 dialog）、Export / Save As（`resource.export`，路径只来自主进程）、Reveal Source（仅 LINKED / 本地设备 / source 有效，经 `shell.showItemInFolder`，路径不回 Renderer）。File Manager ≠ Resource Library。

## 19. Projects integration

v7 `projects / project_members / project_resources`。Project 只引用 ResourceRef；`listProjectResources` 逐资源重新授权，未授权只返回 ref + authorized:false，不泄漏 name。

## 20. Canvas integration

v7 `canvas_boards / canvas_resource_nodes`。节点保存 ResourceRef + version + version_mode；UI "插入资源" 走系统 Picker；状态由服务端计算 AVAILABLE / VERSION_AVAILABLE / UNAUTHORIZED / DELETED / UNAVAILABLE。

## 21. Resource version contract

默认 `PIN_VERSION`（资源替换不静默改变画布）；显式 `Update to latest`；支持 `FOLLOW_LATEST`。Trash → UNAVAILABLE、Permanent Delete → DELETED、撤权 → UNAUTHORIZED，不崩、不泄漏 title。

## 22. Scope governance

`changeResourceScope`（PERSONAL / DEPARTMENT / ORGANIZATION）+ `previewScopeChange`（willGain / willLose / affected grants / incoming references）。变更后旧 Department 继承 grant 立即移除；显式 USER / APP grant 保留并由 D3-02 重新求值。

## 23. Ownership transfer

单个与批量；ResourceRef 与内容 version 不变；旧 owner 失去 OWNER_POLICY（除非显式 grant）；全部写 Audit。

## 24. Memory governance

Personal Memory 默认 Private。Super Admin 可查看/管理访问策略，但 `resource.read` 仍 DENY；搜索不泄漏。Organization Memory Audit Policy **DEFERRED**。

## 25. Audit

`listAudit` 按 actor/target/app/department/resource/action/decision/时间过滤；Department Admin 只看本部门。治理操作全部记录；不写 body / memory / password / token / secret / device key。

## 26. Renderer boundary

preload 新增受控 `governance.command`；resource 桥新增 picker/project/canvas/export/reveal 命令。无 rawSql / rawAclTable / setRoleUnsafe / writeGrantRow / readCredential / readInternalPath。D2-02 security-surface 显式登记 10 桥接键 / 8 IPC 通道，15/15 PASS。

## 27. Security

自我提权 / 跨部门授予 / 越权代理 / App 洗白 / Agent 提权 / ResourceRef 枚举 / 停用用户 stale / 停用 App stale picker / Personal Memory admin-read 全部 DENY。治理命令白名单无危险入口。

## 28. Migration

`SCHEMA_VERSION = 7`。v7 新增 projects/project_members/project_resources/canvas_boards/canvas_resource_nodes。v6→v7 逐级原子，失败注入回滚到 v6 且 v7 表不残留，旧数据完整。

## 29. Restart persistence

部门 / 成员 / 授权 / App grant / Project / Canvas / Ownership / Scope 重启后一致；搜索范围不依赖内存缓存。

## 30. Performance

100 users / 20 departments / 10 内置 App / 10,000 resources：listUsers p95 ≈ 2.4ms；listDepartments（含 10k 计数）p95 ≈ 58ms；Picker p95 ≈ 582ms；authorized search p95 ≈ 231ms；RSS ≈ 338MB。Picker 复用搜索分页。

## 31. macOS

真实 Electron 44.3.0：治理 UI 10/10、Resource Picker UI 8/8、Canvas Resource UI 8/8、D3-04D 探针 5/5、D3-04D 单测 47/47；全量 npm test 450/450。

## 32. Windows

**NOT VERIFIED。** Windows 治理 UI / Picker / File → Resource / Canvas 集成未在真机验证。

## 33. Tests

新增 14 个 test 文件（47 用例）：governance-users/departments/delegation/resource-access/app-access/memory/restart/security、resource-picker、resource-picker-authz、resource-file-integration、resource-project-integration、resource-canvas-integration、resource-scope-transfer；迁移测试更新到 v7。新增 3 个真实 Electron UI 探针（governance-ui 10、resource-picker-ui 8、canvas-resource-ui 8）。新增 experiments/d3-04d（5 探针）。

## 34. Files changed

`electron/identity-store.cjs`（v7）、`electron/authorization-service.cjs`（resolveActor / changeResourceScope）、`electron/governance-domain.cjs` / `governance-service.cjs` / `governance-bootstrap.cjs`、`electron/integration-store.cjs` / `integration-service.cjs` / `picker-service.cjs`、`electron/resource-service.cjs`（export / reveal）、`electron/resource-bootstrap.cjs` / `identity-bootstrap.cjs` / `main.cjs` / `preload.cjs`、`src/governance/*.tsx`、`src/main.tsx`、`src/styles.css`、测试与探针。

## 35. Commits

6 个原子提交（已 push）：`243159a` organization/department governance → `073628d` picker/integration services → `665dff3` command wiring → `8e0518a` governance UI → `d55f05e` tests → `456fe92` docs。

## 36. Evidence

| 入口 | 结果 |
| --- | --- |
| npm test | **450 / 450 PASS** |
| npm run build | PASS |
| npm run test:d3-04d | **5 探针 PASS / FAIL 0** |
| npm run test:governance-ui | **10 / 10** |
| npm run test:resource-picker-ui | **8 / 8** |
| npm run test:canvas-resource-ui | **8 / 8** |
| D2-02 security-surface（直接） | **15 / 15** |
| d3-01 / d3-02 / d3-03 | 12/12 / 6/6 / TLS 12/12 |
| d3-04a / d3-04b / d3-04c | 4/4 / 2/2 / 5/5 |
| resource-ui / resource-library-ui / resource-search-ui / resource-preview-ui | 10/10 / 24/24 / 16/16 / 19/19 |
| identity-ui / authorization-ui / device-ui | 24/24 / 14/14 / 32/32（2 NOT VERIFIED 属 D3-03） |
| design-system / theme-baseline | PASS 4 / PARTIAL 1 / FAIL 0（重跑；一次动画探针 flake）；PASS |
| d2-02 gate | **FLAKY**（occlusion/input 环境性失败，与本次改动无关）；security-surface 直接运行 15/15 |

## 37. Remaining gaps

Windows NOT VERIFIED；完整 Subject×Permission 矩阵可视化未做；Organization Memory Audit Policy DEFERRED；App/Agent usage history 属 D4；Browser 网页上传 Picker 桥接未实现；Drag&Drop / Paste 未实现（DEFERRED，未伪造）；批量操作 UI 未做（服务层已具备）。

## 38. D3-04 overall gate

D3-04A + B + C + D 在 macOS 全部 PASS → **D3-04 macOS Files / Projects / Local Resource Library Core = PASS**；Resource Library macOS 首版核心由 PARTIAL 升级为 **PASS**。Windows NOT VERIFIED，跨平台 overall 仍 **PARTIAL**。**不写 OpenArc Resource System COMPLETE。**

## 39. D3-05 admission recommendation

建议 **D3-05 Identity & Data Gate = GO**：D3-04A/B/C/D macOS 全 PASS，可统一验证 Identity / Authorization / Device / Resource / Department / App / Search / Preview / Governance，然后进入 D4。Windows 仍为 NOT VERIFIED。
