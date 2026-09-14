# D3-05 Result

Task Status: **D3-05 macOS Identity & Data Gate = PASS / D3 overall macOS = PASS / cross-platform overall = PARTIAL（Windows NOT VERIFIED）**

## 1. Base
分支 `feature/d3-05-identity-data-gate`，基线 `feature/d3-04d-resource-governance-integration` remote HEAD `b5a9b49`（规范写 `76104ee`；该分支随后增加了用户要求的 D2-02 可视探针 opt-in commit，本阶段基于最新远端 HEAD，未 merge main）。平台 macOS arm64 / Electron 44.3.0 / 主进程 Node 24.20.0。

## 2. D3 master status
D3-01～D3-04D 全部 macOS PASS（`test:d3-01` 12/12、`d3-02` 6/6、`d3-03` TLS 12/12、`d3-04a` 4/4、`d3-04b` 2/2、`d3-04c` 5/5、`d3-04d` 5/5）；`npm test` **463/463 PASS**（D3-04D 基线 450 + D3-05 新增 13）。

## 3. Fresh install
全新 DB：initialize → admin login → Department → User → membership → Resource → Collection → grant → App grant → search → preview → picker → Project → Canvas → restart 全部真实通过（`tests/d3-05-gate.test.mjs`）。

## 4. Identity lifecycle
Session 创建/校验/过期/锁定保持 D3-01；Lock → `LOCKED`，受保护动作 DENY。**Gate fix #1**：Re-enable 不再静默恢复旧 session（authVersion++ + 撤销全部旧 session，必须重新认证）。

## 5. Lock / Session
锁屏后 Search / Preview / Picker / Edit / Governance 的 `validateSession(sensitive)` 返回 `LOCKED`，`authorize` DENY。

## 6. User disable / reset
Disable → 下一请求全 DENY（login/search/preview/picker/resource/agent）。Re-enable → 旧 session 失效、需重新登录。Password reset → 旧口令 DENY、旧 session DENY、新临时口令 PASS、Audit 记录。

## 7. Organization
唯一权威：IdentityStore / AuthorizationService / DeviceStore / resource_registry / D3-04A Store / 派生 Index / 派生 Preview；未发现第二套 ACL / Session / Resource Identity / Device Identity / Permission Store。

## 8. Department
CRUD / 详情计数 / 删除保护 / A→B 迁移：旧 Department 继承权限立即消失、新 Department 生效；显式 USER/APP grant 按冻结规则重新求值。

## 9. Delegation
自提权 → `SELF_ESCALATION_DENIED`；跨部门授权 / Department Admin 管理他部门 / 给自己 ADMIN → DENY；Delegation Ceiling 生效。

## 10. User × App authorization
User ALLOW + App DENY → DENY；User DENY + App ALLOW → DENY；User ALLOW + App ALLOW → ALLOW（search/read/preview/export）。

## 11. Agent authorization
无 `useByAgent` → agent read DENY；授予 → ALLOW；撤销 → 下一请求 DENY。Agent 借高权限 App / App 借 Agent 提权 → DENY。

## 12. Device authorization
LINKED 资源受 Device 约束（D3-03 `test:d3-03` TLS 12/12 + D3-04A `02-linked-device.mjs` 8/8）：Device use DENY 或 Resource read DENY 都最终 DENY；disabled/revoked → preview/read/reveal DENY；`REMOTE_DEVICE_CONTENT_UNSUPPORTED` 保持。**未新增 D3-05 专属 device 测试**，结论来自既有套件。

## 13. Resource lifecycle
import → search → preview → v2 → restore v1 → trash（search 0 / preview denied）→ restore（同 ResourceRef）→ permanent delete（search/picker/project/canvas unavailable，无幽灵 grant）。

## 14. Resource version
两客户端基于 v1，第二个保存 expectedVersion=1 → `VERSION_CONFLICT`，不覆盖 v2。

## 15. Ownership / Scope
Owning transfer：ResourceRef / 内容 version 不变，旧 owner 失去 OWNER_POLICY；Scope PERSONAL→DEPARTMENT：旧 owner-only 继承变更、新 Department policy 生效、search/picker/app grant 重新求值，无需重登。

## 16. Search zero leakage
无权资源 `GATE_SECRET_NAME/BODY/TAG` 全部 0 结果；响应无 name / ref / snippet / tag / owner / raw total。

## 17. Search revocation
Revoke 后**无需 reindex** 下一搜索立即消失；Department 迁移后原 Department 资源立即消失（Index ≠ Authorization）。

## 18. Preview capability
60s capability：resource revoke / App disable 后即使 capability 未过期，协议请求不再 200。Range / 206 / 416 / MAX_RANGE 保持（D3-04C `03-preview` 19/19）。

## 19. Picker
只返回 User ∩ App ∩ Type ∩ Action；ResourceRef + 安全 metadata；selectionToken 每次 validate 重新 authorize；撤权后 stale selection DENY。

## 20. Project
Project 只引用 ResourceRef；project member 无 resource grant → resource DENY；撤权后下一 project access DENY。

## 21. Canvas
ResourceRef 节点；默认 PIN_VERSION；资源 v2 后节点仍 v1，显式 Update to latest；Trash → UNAVAILABLE、Permanent Delete → DELETED、撤权 → UNAUTHORIZED，不泄漏旧 title/content。

## 22. Memory privacy
Personal Memory `PRIVATE_GATE_SECRET_9382`：其他用户 / Department Admin / Super Admin 正文 read 与搜索全部 DENY；Super Admin 仅能治理访问说明。**硬 Gate PASS**。

## 23. Governance
Super Admin 治理权 ≠ 内容读取权；Department Admin 边界；治理命令全部由 Domain 校验 + Audit。

## 24. Audit
user disable / membership / resource grant/revoke / app grant/revoke / ownership / scope / password reset 均有可解释 Audit；无 secret 写入。

## 25. Renderer / IPC
preload 10 桥接键 / 8 IPC 通道重新冻结；未知 channel FAIL；`security-surface.mjs` 直接运行 **15/15**。Renderer DOM / preload response 不含 password hash/salt / token / device key / sourceLocator / internalKey。

## 26. Concurrency
login × authorization、grant vs revoke、disable vs read、department transfer vs search、scope/ownership vs read、delete vs preview、update vs index、app revoke vs picker：结果一致、无 DB 损坏、无越权窗口（D3-05 gate + 既有 D3 测试）。

## 27. Migration matrix
v1→current（`migration.test.mjs`）、v2→current（`device-migration.test.mjs`）、v3→current（`resource-migration.test.mjs`）、v4/v5→current（`resource-library-migration.test.mjs`）、v5→v6（`resource-index-migration.test.mjs`）、v6→v7（D3-04D 更新后的同批测试）、current→current（fresh DB）全部 PASS；失败注入同级回滚（user_version 不提前、半建表不存在、旧数据完整、可重试）。历史 fixture 均由可信 schema 常量构造，未伪造。

## 28. Recovery
import 中断 / index RUNNING 中断 / preview cache 缺失 / 迁移失败 → 权威数据不损坏，`recoverStartup` / reindex 可恢复（D3-04A/04C/04D 套件）。

## 29. Performance
100 users / 20 departments / 10 内置 App / 10,000 resources：listUsers p95 ≈ 2.4ms、listDepartments p95 ≈ 58ms、Picker p95 ≈ 582ms、authorized search p95 ≈ 231ms、RSS ≈ 338MB（D3-04D `05-performance` + D3-04C `05-performance`）。

## 30. D2-02 flaky analysis
**NOT VERIFIED（按用户明确要求，未运行 5 次可视化 Gate，避免打扰桌面）**。已知：D2-02A Gate 的可视 occlusion/input 探针本机环境性 flaky（需独占物理屏/指针且显示真实窗口）；D2-02 `security-surface.mjs` 直接运行 15/15。可视探针默认 opt-in（`OPENARC_RUN_VISUAL_PROBES=1`）。判定：KNOWN FLAKY / 非 D3 回归，但 5-run 归因未执行。

## 31. D1 security blockers
`npm run test:security` 保持 FAIL 0 / PARTIAL 2 / PASS 6；OS sandbox / network sandbox / hard memory limit 仍为 D1-05 blocker，D3-05 未关闭；`UNTRUSTED CODE EXECUTION = DISABLED BY DEFAULT` 保持。

## 32. macOS gate
Identity/session lifecycle、authorization、department isolation、app intersection、agent useByAgent、device gate、resource lifecycle、search zero leakage、preview revoke、picker revoke、project/canvas reauthorization、personal memory privacy、governance、audit、migration、concurrency、restart/recovery、renderer boundary 全部真实通过，新增 Security FAIL = 0 → **D3-05 macOS Identity & Data Gate = PASS；D3 overall macOS = PASS**。

## 33. Windows
**NOT VERIFIED。** 无 Windows 真机；不外推。

## 34. Attack matrix
| Attack | Expected | Actual | Status | Evidence |
| --- | --- | --- | --- | --- |
| self escalation | DENY | SELF_ESCALATION_DENIED | PASS | d3-05-gate.test |
| cross department | DENY | CROSS_DEPARTMENT_DENIED | PASS | d3-05-gate.test |
| cross organization | DENY | DENY | PASS | D3-03 / authorization |
| user disabled stale session | DENY | USER_DISABLED / SESSION_REVOKED | PASS | d3-05-gate / policy |
| app disabled stale permission | DENY | DENY | PASS | d3-05-data-gate |
| device revoked stale connection | DENY | DEVICE_REVOKED | PASS | d3-03 |
| search enumeration | 0 | 0，无泄漏 | PASS | d3-05-data-gate |
| preview capability after revoke | DENY | 403 | PASS | d3-05-data-gate |
| personal memory admin read | DENY | DENY | PASS | d3-05-gate |
| agent privilege laundering | DENY | AGENT_USE_NOT_AUTHORIZED | PASS | d3-05-data-gate |
| app privilege laundering | DENY | DENY | PASS | governance-security |
| raw filesystem path | 不暴露 | DOM/响应无路径 | PASS | resource-*-ui / d3-04c |
| direct IPC | DENY/受限 | security-surface 15/15 | PASS | d2-02 security-surface |
| migration failure | 回滚 | user_version 不提前 | PASS | migration 套件 |
| stale version overwrite | VERSION_CONFLICT | VERSION_CONFLICT | PASS | d3-05-data-gate |
| picker stale selection | DENY | validateSelection false | PASS | d3-05-data-gate |

## 35. Remaining gaps
Windows；D2-02 5-run flaky 归因未执行；Subject×Permission 完整矩阵 UI；Browser 网页上传 Picker bridge；Organization Memory Audit Policy；Drag&Drop / Paste；App/Agent usage history；产品化 Backup/Restore（D6）。以上均非 D4 数据层 blocker。

## 36. D4-01 admission recommendation
**D4-01 Model Service / Model Proxy / Credential Boundary = CONDITIONAL GO**，受 D1-02 Harness 条件与 D1-05 Security Freeze 约束。D4 不自动获得工具执行权；严格 D4-01→D4-02→D4-03→D4-04→D4-05。Harness raw provider key = FORBIDDEN，走 OpenArc Model Proxy。Resource Agent Contract：`resource.search/getMetadata/preview/read`，必须 Session ∩ User ∩ App ∩ Resource ∩ useByAgent；Mutation 属 D4-03 Tool Gate；No Raw Path Contract（只用 ResourceRef）。

## 37. Commits
见最终提交（`test(D3-05): add identity and data integration gate` + `docs(D3-05): record master gate and D4 admission`；如发现 gate-blocking 缺陷则追加 fix commit）。已 push origin，未 merge main。

## 38. Evidence
| 入口 | 结果 |
| --- | --- |
| npm test | **463 / 463 PASS** |
| npm run build | PASS |
| D3-05 Gate 测试 | d3-05-gate 6/6 + d3-05-data-gate 7/7 |
| d3-01 / d3-02 / d3-03 | 12/12 / 6/6 / TLS 12/12 |
| d3-04a / d3-04b / d3-04c / d3-04d | 4/4 / 2/2 / 5/5 / 5/5 |
| D2-02 security-surface（直接） | 15 / 15 |
| test:security | FAIL 0 / PARTIAL 2 / PASS 6 |
| 既有 UI 探针 | identity 24 / authorization 14 / device 32（2 NOT VERIFIED 属 D3-03）/ resource 10 / resource-library 24 / resource-search 16 / resource-preview 19 / governance 10 / picker 8 / canvas 8 |

**Gate-blocking fixes**：① Re-enable 不恢复旧 session（`identity-store.setUserStatus`）；② 资源 owner / manageAccess manager 可撤销 PERSONAL 资源的显式授权（`authorization-service.revokeResourcePermission`）。两处均有回归测试（authorization-policy 更新为新的冻结语义；d3-05-data-gate 覆盖 owner revoke）。
