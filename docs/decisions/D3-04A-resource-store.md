# D3-04A · Resource Object & Local Store

- **状态**：macOS Resource Store Core **PASS**；overall **PARTIAL**（Windows 路径 / 文件锁 / NTFS / userData NOT VERIFIED；Resource Library 完整功能属 D3-04B/C/D）
- **分支**：feature/d3-04a-resource-store，基线 7a94757（feature/d3-03-device-identity）
- **日期**：2026-09-14
- **范围**：Resource Object / Resource Metadata / Content Object / Resource Version / Managed Storage / Linked Resource / Trash / Integrity / Resource Location。**不进入** D3-04B CRUD/Collection/Tag、D3-04C Search/Index/Preview、D3-04D File/Project/App/Picker Integration。

---

## Scope

D3-04A 建立资源库的**本地存储底座**：一个资源必须能真实 Import / Persist / Read / Version / Delete / Restore / Permanently delete / Survive restart，并且权限真实经过 D3-02、位置真实经过 D3-03。

本轮不创建第二身份系统：D3-02 的 resource_registry 继续是逻辑身份 / 授权权威。

---

## Resource Identity

- Resource 身份 = 稳定 resourceId（res_xxx）+ ResourceRef（resource://res_xxx）。
- 重命名 / 移动 Collection / 替换内容都不改变 ResourceRef；只有内容 version 变化。
- 新增 library_resources 表与 resource_registry 是 **1:1**，共享 resourceId。
- 明确禁止 resource_identity / library_resource_registry / asset_registry 这类第二身份系统。

---

## Registry Relationship

- resource_registry（D3-02）：resourceId / resourceType / owner / organization / department / scope / authorization identity。
- library_resources（D3-04A）：mimeType / name / description / storageMode / contentObject / source / size / checksum / version / trash state / indexStatus / 存储位置。
- 授权判断读 resource_registry；存储语义读 library_resources。授权决策仍由 D3-02 AuthorizationService 唯一给出。

---

## ResourceDescriptor

library_resources 至少包含：resourceId / resourceType / mimeType / name / description / storageMode / contentObjectId / checksum / size / source / version / storageDeviceId / sourceLocator（内部）/ observedSize / observedMtime / generated provenance / indexStatus / trashState / deletedAt / deletedBy / createdAt / updatedAt。

渲染进程可见的是 descriptorProjection 白名单，不含 sourceLocator / 内部 key / 绝对路径。

---

## ResourceRef

继续使用 resource://res_xxx。授权与读取都只接受 resourceId / ResourceRef；不接受文件名、显示名、绝对路径、数组下标作为身份。

---

## Resource Types

复用 D3-02 的单一 RESOURCE_TYPES 清单，不新建第二套类型系统。D3-04A 真实可保存 memory / text / document / image / video / audio / code / prompt / generated-artifact / file / other。MIME 采用基础 magic-byte sniffing，不只相信 extension，也不引入巨型媒体识别系统。

---

## Storage Modes

STORAGE_MODE = MANAGED | LINKED，两套完全不同语义：

- MANAGED：OpenArc 接管内容，写入自己的 Store；原文件删除后仍可用。
- LINKED：只引用外部本地文件，记录 controlled locator / observed size / observed mtime / storageDeviceId；源变化必须诚实报告。

---

## Managed Store

- Store root = 平台规范 App Data 路径下的 <OpenArc userData>/library（由 Electron app.getPath("userData") 给出；测试传临时目录）。
- 布局：library/{objects/sha256, staging, thumbnails, generated, cache, trash}。
- 正式 object filename **只由 SHA-256 生成**：objects/sha256/ab/<64 hex>。用户文件名永不参与最终位置。

---

## Linked Resources

- 记录 storageDeviceId + sourceLocator（内部）+ observed size/mtime + 可选 checksum。
- 源不存在 -> SOURCE_MISSING；大小/mtime 变化 -> SOURCE_CHANGED；Device Offline -> DEVICE_OFFLINE；Device REVOKED/DISABLED -> DEVICE_REVOKED / DEVICE_DISABLED。**都不伪装 AVAILABLE**。
- 第一版 **拒绝 LINKED symlink**（LINKED_SYMLINK_REJECTED）：symlink 的 source identity 可能在读取间变化，无法安全解释。MANAGED symlink 则解析真实目标并复制，之后与原 link 无关（记录 TOCTOU 限制见 Remaining Gaps）。

---

## Resource Location

接入 D3-03：LINKED Resource 记录 storageDeviceId，可用性通过 DeviceService.resolveResourceLocation 计算（组织 -> 状态 -> 连通性）。禁止只保存 /Users/xxx 然后假定所有 Device 都能读。MANAGED 第一版位于当前 Control Service / local storage device，记录 storageDeviceId = local。

---

## Content Objects

content_objects：contentId（由 checksum 确定性派生）/ checksumAlgorithm / checksum / size / internalKey / refCount / status / organizationId / timestamps。refCount 只是缓存，引用关系仍以 resource_versions / library_resources 的 SQL 计算为准（§19）。

---

## Dedupe

冻结：Content Object dedupe ≠ Resource Entry dedupe。

- 同一内容导入两次 -> 底层 1 份 binary，但可以有 2 个 Resource（不同 name / Collection / Tag / Owner / Department / 权限 / description）。
- 禁止根据文件名判断重复。
- 唯一约束 (checksum_algorithm, checksum, size) 保证内容对象唯一。

---

## Import State Machine

IMPORT_PHASE：STAGING -> HASHED -> OBJECT_READY -> COMMITTING -> AVAILABLE，另有 FAILED / CANCELLED / ORPHANED。resource_import_jobs 持久化每个阶段。

Managed Import 流程：validate request -> authorizeCreate（对 target container/scope）-> stream copy 到 staging 并增量 SHA-256 -> 校验 size/type -> promote 到 objects（内容已存在则复用）-> 独立提交 content_objects 行 -> 在一个 DB 事务里提交 registry + library + version -> 清理 staging -> 返回 ResourceRef。

---

## Crash Recovery

recoverStartup()：
- 未完成 job：若 resource 已存在 -> 标记 AVAILABLE；否则清 staging 并标记 ORPHANED。
- staging 目录中无 job 的临时文件 -> 清理（**不删除 objects 下未知文件**）。
- content_objects 缺文件 / size 不符 -> 记录 objectMismatches。
- 无任何 current / historical 引用的 OBJECT_READY content -> 物理回收并标记 DELETED。

明确：**不写 "DB + filesystem atomic transaction"**。FS promote 与 DB commit 是两个边界；中间允许留下可检测孤儿，由 recovery / GC 解释。

---

## Large Files

Import / hash / copy / verify 全部 stream（1MB highWaterMark），O(1) 内存，不做 readFile -> Buffer 整文件读入。实测 100MB：53ms，external 增量 13MB。

---

## Versioning

resource_versions：resourceId / version / contentObjectId / checksum / size / storageMode / storageDeviceId / sourceLocator / source / createdBy / createdAt。版本单调递增；UNIQUE(resource_id, version)。library_resources.version 与 resource_registry.version 同步。

---

## Optimistic Version

replaceContent / restoreVersion 接受 expectedVersion。客户端基于 v3、实际已 v4 -> VERSION_CONFLICT，绝不静默覆盖。

---

## Trash

Delete = SOFT DELETE：library_resources.trash_state=TRASHED + resource_registry.status=deleted。ResourceRef 保持。默认查询 includeDeleted=false；Trash 不出现在 normal list、D3-02 授权层查询、未来 Agent retrieval / Canvas / App picker。direct get 安全报告 trashed=true；read 被拒 RESOURCE_TRASHED。

---

## Permanent Delete

必须 authorize(resource.permanentDelete)。删除 registry（级联 library + versions + relations）、清理 resource_grants 与 app_resource_grants；Audit retention 不随资源删除消失。生命周期动作（restore / permanentDelete）通过 authorization 的 allowInactiveResource 显式开关在 trashed 资源上重新求值，普通调用默认仍 DEFAULT DENY。

---

## GC

永久删除 A 时若 content object 仍被 B 的 current / historical version 或其它 Resource 引用，**不物理删除**；只有 refs=0 才删文件并标记 content_objects.status=DELETED。共享内容对象存活由单测与探针真实覆盖。

---

## Relations

resource_relations：fromResourceId / toResourceId / relationType（references / derived-from / generated-from）/ createdBy / createdAt。incomingReferences 在永久删除前可查影响面（Domain API）。

---

## Integrity

verifyResourceIntegrity：
- MANAGED：object exists + size + 重新流式 SHA-256。
- LINKED：Device 可用性 + source exists + observed size/mtime。
返回 status / reason / checks，不伪装 AVAILABLE。

---

## Authorization

- Create 针对 target container / scope：新增 AuthorizationService.authorizeCreate（PERSONAL 走显式 Personal Library Owner Policy；DEPARTMENT 要求 ACTIVE 成员 + create grant；ORGANIZATION 需显式授权；Super Admin 仍必须过 App 授权）。
- Read / Edit / Delete / Restore / PermanentDelete / useByAgent 全部复用 D3-02 authorize，User ∩ App 同时成立。
- DEPARTMENT create 校验 department 属于组织且 ACTIVE；不接受 Renderer 提供的 departmentId 直接决定归属。

---

## App Access

系统内置 App 也必须有真实 app grant。D3-04A 由系统策略写入 BUILTIN_APP_BASELINE（granted_by = system:builtin-policy）：resource-library 全动作 + memory 类型显式覆盖；canvas / browser / ai / image-generator / video-generator / photoshop / illustrator / mcp-center / skill-runtime 各自最小集合。全局 grant 不覆盖 memory（D3-02 保护语义不变）。第三方 App 默认无 grant。

---

## Agent Boundary

本轮不做真正 Agent Retrieval。所有 Store API 都保留 AuthorizationContext；Agent 场景仍要求 resource.useByAgent（单测覆盖：无 useByAgent -> DENY，grant 后 ALLOW）。Store 不提供绕过 Service 直接拿路径的接口。

---

## Device Boundary

LINKED Resource 与 Device 是交集：Resource 授权通过但 Device OFFLINE/REVOKED 仍不可读。这是 D3-03 authorizeExecution 语义在存储层的复用，不重写 ACL。

---

## Renderer Boundary

preload 只新增 resource.command（受控 Resource Commands），**没有** readFile(path) / writeFile(path) / deleteFile(path) 通用 fs 能力。导入 / 链接的文件选择在主进程 dialog 完成，路径从不回渲染进程；返回值恒为 safe descriptor。UI 探针实测页面 DOM 不含源文件绝对路径。

---

## Path Security

- 对象路径只由 OpenArc 从 checksum 生成；resolveKey 拒绝 traversal / 逃出 store。
- 前导斜杠只归一化为 store 内相对 key，永不逃逸。
- 用户的 name / filename 只作为 display name，不参与最终路径。
- 继续明确：path validation 只是 defense-in-depth；Store Service 运行在受信 OpenArc 服务边界，不代表 Plugin Sandbox 已解决。

---

## Migration

schema v3 -> v4，新增 library_resources / content_objects / resource_versions / resource_relations / resource_import_jobs。逐级原子迁移；D3-04A 的迁移失败注入验证：user_version 保持 3、v4 表不存在、Users / Departments / Authorization / Devices 完整，修复后可正常升到 v4。D3-02 / D3-03 的迁移测试同步更新为对 SCHEMA_VERSION 的断言。

---

## macOS

已实测（真实 Electron 44.3.0 / Node 24.20.0 / darwin arm64）：
- userData 下 library Store 真实创建与写入
- Managed Import / Linked / 大文件 streaming / 权限 / restart / trash / version / integrity 全部成立
- 真实 Electron UI 探针 10/10：Import / Link、safe descriptor、路径不泄漏

---

## Windows

**NOT VERIFIED。** Store 领域逻辑跨平台可测（纯 Node），但 Windows 路径语义 / 文件锁行为 / NTFS / userData 位置未在真机验证。不外推 macOS。

---

## Performance

- 10MB streaming import：external 增量约 11MB，耗时约 11ms。
- 100MB streaming import：external 增量约 13MB，耗时约 53ms。
- 结论：执行路径没有按文件大小线性吃 RAM 的整文件 Buffer。D3-04A 不做完整性能 Gate。

---

## D3-04B Handoff

D3-04B 必须复用本轮的 ResourceStore / ResourceService / Import State Machine / Version / Trash / GC / authorizeCreate，不得重新发明 ACL 或第二身份系统。重点：Collection / Tag CRUD、Memory 分类、用户编辑界面、批量操作、Trash UI。Search/Index/Preview 属 D3-04C；File/Project/App/Picker 属 D3-04D。

---

## Evidence

| 入口 | 结果 |
| --- | --- |
| npm test | 307 / 307 PASS（含 D3-04A 新增 59） |
| npm run build | PASS |
| npm run test:d3-04a | 4 探针 PASS / PARTIAL 0 / FAIL 0（34 条用例） |
| npm run test:resource-ui | 10 / 10 UI checks PASS（真实 Electron） |
| npm run test:d3-01 | PASS 12 / PARTIAL 0 / FAIL 0 |
| npm run test:d3-02 | PASS 6 / PARTIAL 0 / FAIL 0 |
| npm run test:d3-03 | TLS 矩阵 12/12，exit 0 |
| npm run test:d2-02 | PASS 7/7（含 security-surface 15/15；暴露面 8 → 9 已显式登记） |
| npm run test:identity-ui / authorization-ui / device-ui | 24/24 / 14/14 / PASS（device-ui 2 项 NOT VERIFIED 属 D3-03 既有缺口） |
| npm run test:security | FAIL 0 / PARTIAL 2 / PASS 6 |
| npm run test:design-system / theme-baseline | 与基线一致 |

产物：artifacts/d3-04a/*.json。

---

## Remaining Gaps

1. Windows 路径 / 文件锁 / NTFS / userData 未验证
2. MANAGED symlink 的 TOCTOU（导入过程中 target 被替换）只记录、未消除
3. LINKED symlink 第一版直接拒绝，未提供安全的 source identity 跟踪
4. 远程 Device 上的 LINKED content transport 未实现（REMOTE_DEVICE_CONTENT_UNSUPPORTED）
5. 完整 Resource Library UI / CRUD / Search / Index / Preview 属 D3-04B/C/D
6. 共享内容对象的物理去重只在单 content object 层；block-level dedupe 未做
7. Thumbnails / generated / cache 目录已建但未使用（属 D3-04C）
8. DB 本身未加密-at-rest；备份 / 迁移策略仍属发布前事项
