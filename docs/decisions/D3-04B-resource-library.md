# D3-04B · Resource Library App / CRUD / Memory / Collection / Tag / Favorite / Recent

- **状态**：macOS Resource Library CRUD Core **PASS**；overall **PARTIAL**（Windows UI / picker / drag-drop / clipboard NOT VERIFIED；Search/Index/Preview 属 D3-04C，Department/App/Picker/File/Project 集成属 D3-04D）
- **分支**：feature/d3-04b-resource-library，基线 469f78b（feature/d3-04a-resource-store）
- **日期**：2026-09-14
- **范围**：把 D3-04A 的 Resource Store Core 做成用户可用的资源库 App。**不进入** D3-04C 全文检索 / Embedding / 语义检索 / 缩略图 / 转写，也不进入 D3-04D Department 权限 UI / App Picker / Files / Projects / Canvas / D4 Agent Retrieval。

---

## Scope

D3-04B 交付：Resource Library App（三栏）、Resource CRUD、Memory、Collection、Tag、Favorite、Recent、Trash UI、Metadata Inspector、文本编辑、Version-aware editing、Import / Link、结构化过滤。所有能力复用 D3-04A ResourceService / D3-02 Authorization / D3-03 Device Location，不重建存储层或 ACL。

---

## UI Architecture

三栏布局（Navigation / Resource Content / Inspector），通过现有 App / Window / Dock 体系打开（appId = resource-library），不是独立网页壳。全部经 window.openarc.resource.command 访问资源；没有 raw fs / 绝对路径。

---

## Navigation

固定分类：All / Memory / Documents / Images / Videos / Audio / Code / Prompts / Generated / Favorites / Recent / Trash，下方为 Collections 与 Tags。分类到 resourceType 的映射在 resource-domain.cjs 冻结（CATEGORY_TYPES），Renderer 不按扩展名猜。

---

## Resource Listing

默认只显示：非 Trash、当前 User 有权查看、当前 resource-library App 有权查看。授权查询由 ResourceService.queryResources 在服务端完成（D3-02 getCapabilities 过滤）；禁止 load all → Renderer filter。Grid / List 切换，偏好存 localStorage（只影响视图，不是 Domain 权威）。

---

## Inspector

安全字段：name / description / resourceType / MIME / size / storageMode / owner / scope / department / collection / tags / version / created / updated / availability / storageDeviceId / source type / relations summary / provenance / capabilities。**不展示** sourceLocator / 绝对路径 / internalKey / content object path。Access 区显示 Owner / Scope / Department / User capabilities / App capabilities / effective capabilities（canRead/canEdit/canDelete/canManageAccess/canUseByAgent）；权限编辑留 D3-04D。

---

## CRUD

Create（Memory / Text / Code / Prompt，真实写入 ResourceService，形成 v1）；Import（resource/pickImport，主进程 dialog）；Link（resource/pickLink）；Read（readText）；Edit（replaceText，version-aware）；Delete（软删除）；Restore；Permanent Delete；updateMetadata（name / description / collection / memory subtype / language / attributes）。所有动作再次调用 D3-02 authorize；UI 的 canEdit 只控制 UX。

---

## Memory

Memory 是正式 Resource（resourceType = memory），不再有隐藏数据库。subtype 冻结为 personal-preference / project-memory / decision-memory / conversation-memory / agent-memory（只做 metadata 分类，不新增 Resource Type）。用户可 create / view / edit / rename / tag / move collection / delete / restore。source 记录 user / agent / imported / system；本轮用户手工创建 source = user。Agent 自动写入 Memory **不实现**，数据模型与 UI 已就绪但必须来自用户明确要求或明确批准的 Memory Policy。

---

## Memory Privacy

Personal Memory 默认 scope = PERSONAL，走 D3-02 OWNER_POLICY；加入 Department 不自动共享。同组织 User B / 跨组织 / direct ResourceRef 全部不可见（get / read / inspector / query 均验证）。Recent 只对当前 User 可见；Super Admin 不通过普通 Resource Library 查看所有人的 Recent。App 侧：resource-library 可读（built-in 显式 memory grant），其他普通内置 App 无 Memory grant 时不可读。

---

## Collection

复用 D3-02 已存在的 collections 表（不建第二套 Collection identity）。冻结：**一个 Resource 一个 primary Collection**（resource_registry.collection_id）；Tag 为多对多。CRUD：create / rename / edit description / move resource / remove（move to unfiled）/ delete collection（资源转 Unfiled，绝不级联删除）。删除前返回 resourceCount。

---

## Tag

tags + resource_tags（多对多）。Tag 规范化冻结：trim + 空白折叠；显示名保留大小写，比较用 normalized（小写）；空 / 超长 / 控制字符拒绝；同一组织内 normalized 唯一（Shoes == shoes）。User / System / Agent 三种 source；系统 Tag 普通用户不能改。删除 Tag 不改变 Resource 内容与 version。registry.tags JSON 作为去规范化缓存同步更新。

---

## Favorite

per-user（resource_favorites: user_id + resource_id）。User A 收藏 ≠ User B 收藏。Favorite 不产生内容 version；Trash 后不出现在 Favorites，Restore 后恢复。

---

## Recent

per-user（resource_recent: user_id + resource_id + last_opened_at + open_count）。只有用户真实打开（touchRecent）才更新；背景 list / query 不算打开。Trash 后不出现在 Recent。

---

## Trash

Trash 分类展示软删除 Resource；支持 Restore 与 Permanent Delete。Delete = 软删除，ResourceRef 保持。Permanent Delete 必须二次确认；若 incomingReferences > 0，确认框显示"被 N 个对象引用"，不静默删除。

---

## Version Editing

Memory / Text / Code / Prompt 提供真实文本编辑器；打开记录 expectedVersion，保存调用 replaceText(expectedVersion) 形成新版本。VERSION_CONFLICT 时 UI 不覆盖，显示"资源已被其他操作更新"，提供 Reload 与 Save As New Resource。restoreVersion 继续 vN → vN+1，不倒退。

---

## Metadata

resource/updateMetadata 允许 name / description / collection / memorySubtype / language / attributes；**不接受** ownerUserId / organizationId / resourceId / internal path / checksum。Metadata 修改不产生内容 version（§79 冻结）。

---

## Structured Filtering

支持 Type（分类）/ Collection / Tag / Storage Mode / Availability / Favorite / Trash / Name filter。**不做全文搜索**；Search 输入框只做 Name filter，ADR 明确 D3-04C 会替换为 FTS / Authorized Search Provider。排序：Name / Created / Updated / Size，在授权结果范围内。分页：limit + offset（页面 60，加载更多）。

---

## Authorization

所有 read / edit / delete / restore / permanentDelete / tag / move / metadata 再次调用 D3-02 Authorization。Create 走 D3-02 authorizeCreate（对 target container / scope）。授权失败资源不显示；read 失败资源仍保留在 Library 并显示 Availability（例如 Source Missing），不因读失败从 UI 消失。

---

## App Access

内置 App 也必须有真实 app grant（D3-04A BUILTIN_APP_BASELINE）。禁用 resource-library App 后下一查询/打开 DENY；撤销 grant 后下一请求 DENY，不需要重启。Inspector 显示 user / app / effective 能力交集。**本轮发现并修复真实缺陷**：治理闸门原先依赖调用方 App enabled，导致"禁用某 App 后无法再重新启用"；现在治理授权的判据是 User role，resource 操作仍严格要求 App enabled。

---

## Agent Boundary

本轮不做 Agent Retrieval。所有 Store API 保留 AuthorizationContext；Agent 仍需 resource.useByAgent（单测/探针：无 → AGENT_USE_NOT_AUTHORIZED，grant 后 ALLOW）。UI 编辑 Memory 不绕过 ResourceService。

---

## Department Boundary

资源卡 / Inspector 可显示安全的 Department metadata。Department Resource Admin / Permission Matrix 属 D3-04D，本轮不做。

---

## Renderer Boundary

preload 只新增受控 Resource Commands（query / inspector / create / updateMetadata / setCollection / collections / tags / favorites / recent / replaceText / restoreVersion / pickImport / pickLink …）。没有 readFile/writeFile/deleteFile 通用 fs；导入/链接在主进程 dialog，绝对路径不回渲染进程；UI 探针断言页面 DOM 不含源文件绝对路径。

---

## Migration

schema v4 → v5，新增 tags / resource_tags / resource_favorites / resource_recent，以及 library_resources.memory_subtype / language / attributes。迁移逐级原子；失败注入验证 user_version 停留在 4、v5 表不残留、Users / Departments / Authorization / Devices / D3-04A Resource 完整，修复后正常升 v5。

---

## Accessibility

Grid/List item 具备可读 aria-label；工具栏按钮有可见文本或 aria-label；Dialog 复用 D2-02 Dialog primitive（焦点陷阱 / Esc / 焦点返回）；:focus-visible 样式；键盘 Enter/双击打开编辑器，Esc 关闭 Dialog。

---

## Performance

query 在 1,000 Resource metadata 上完成 filter / sort / pagination，单测断言 < 5s（实测远低于此）。列表 limit 60 + 加载更多，不一次渲染无限项。本轮不做百万级 Benchmark。

---

## macOS

真实 Electron 44.3.0 / Node 24.20.0 / darwin arm64：348/348 单测、2 探针 25 用例、D3-04B UI 探针 24/24（open / import / create memory / edit / version conflict / collection / move / tag / favorite / delete / trash / restore / capabilities）。

---

## Windows

**NOT VERIFIED。** Windows Resource Library UI / file picker / drag-drop / clipboard / path behavior 未在真机验证。

---

## D3-04C Handoff

D3-04C 必须替换 Name filter 为真正的 FTS / Authorized Search Provider，并复用 queryResources 的授权边界；缩略图 / 预览 / 媒体 metadata / 转写 / Embedding 属 D3-04C。不得在 Renderer 重建索引或过滤。

---

## D3-04D Handoff

D3-04D 负责 Department / Super Admin 权限管理 UI、App Resource Picker、Files / Projects / Canvas 集成、Ownership / Scope 治理编辑。D3-04B 已冻结的 Collection primary / Tag 多对多 / Metadata revision 语义必须复用。

---

## Tests

新增：resource-library-crud / resource-metadata / resource-memory / resource-library-version / resource-collections / resource-tags / resource-favorites / resource-recent / resource-library-authz / resource-library-migration / resource-library-restart（11 个 test 文件，41 个测试）+ resource-library-ui.mjs（真实 Electron，24 checks）+ experiments/d3-04b（2 探针）。

---

## Evidence

| 入口 | 结果 |
| --- | --- |
| npm test | 348 / 348 PASS |
| npm run build | PASS |
| npm run test:d3-04b | 2 探针 PASS / FAIL 0（25 用例） |
| npm run test:resource-library-ui | 24 / 24 UI checks PASS |
| npm run test:d3-04a / resource-ui | PASS 4/4 / 10/10 |
| npm run test:d3-01 / d3-02 / d3-03 | 12/12 / 6/6 / TLS 12/12 |
| npm run test:d2-02 | PASS 7/7（含 security-surface 15/15） |
| npm run test:identity-ui / authorization-ui / device-ui | 24/24 / 14/14 / PASS（device-ui 2 NOT VERIFIED 属 D3-03） |
| npm run test:security / design-system / theme-baseline | FAIL 0 / PASS 4 / 与基线一致 |

产物：artifacts/d3-04b/*.json。

---

## Remaining Gaps

1. Windows UI / picker / drag-drop / clipboard NOT VERIFIED
2. Paste（text / clipboard image）未实现，标记 DEFERRED；未伪造
3. Drag & Drop 导入未实现（属本轮可选，未做则标 DEFERRED）
4. 全文搜索 / 缩略图 / 预览 / 转写 / Embedding 属 D3-04C
5. Department / App Picker / Files / Projects / Canvas 集成属 D3-04D
6. 批量操作（multi-select）未实现（不影响 PASS）
7. Collection / Tag 的 Department / Organization 高级权限编辑属 D3-04D
8. Reveal Source（受控 OS action）DEFERRED
9. Store 仍无加密-at-rest / 备份恢复策略
