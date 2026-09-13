# D3-04C · Authorized Search / Local Index / Preview Pipeline

- **状态**：macOS Authorized Search / Local Index / Secure Preview **PASS**；overall **PARTIAL**（Windows UI/媒体行为 NOT VERIFIED；远程 Embedding / Cloud Vision / OCR / Transcription 明确不实现）
- **分支**：feature/d3-04c-resource-search-preview，基线 b0c2a96（feature/d3-04b-resource-library remote HEAD），**不合并 main**
- **日期**：2026-09-15
- **范围**：在 D3-04A Resource Store / D3-04B Resource Library 之上补齐本地授权全文检索、可重建本地索引、文本抽取、结构化 snippet、排序，以及受控 Preview（text/image/PDF/video/audio）+ 缩略图 + 安全交付。**不进入** D3-04D 治理 UI / Super Admin 权限矩阵 / App Resource Picker / Files / Projects / Canvas，也**不进入** Agent Retrieval。

---

## Local First

搜索、索引、抽取、缩略图全部在本机完成：JSON 领域模型 + SQLite FTS5 + Electron `nativeImage`。没有任何远程 Embedding / Vision / OCR / Transcription / 语义检索调用；`experiments/d3-04c/04-no-remote-call.mjs` 在运行时拦截 `fetch` / `http(s).request` / `dns.lookup` / `net.connect` / `tls.connect`，并对 5 个模块做静态扫描，全程 0 调用。

## Default Deny

`resource/search` 的 FTS 只产生**候选**；每个候选都要经 D3-02 Authorization（`authorizeMany`，一次 prepare 批量判定 `resource.search`）。未授权资源不进入 `items`、不计入 `total`、不产生 snippet / highlight / tag / owner / collection / thumbnail，也不通过总条数、`hasMore` 或错误码暗示其存在。猜 resourceId 时 get / inspector / indexStatus / preview 一律收敛为 `NOT_FOUND_OR_FORBIDDEN`。

## Authorization Boundary

- 授权仍在**服务端**：Renderer 只收到已授权结果，禁止 load-all → Renderer filter。
- `AuthorizationService.authorizeMany({ context, application, resources, action, agent })`：一次 `#prepare`（session gate + app principal + memberships + grants + appGrants），批量返回每个 resourceId 的 decision。普通搜索不逐条写安全 Audit（避免搜索放大审计噪声），敏感动作仍走 `authorize()`。
- 新增 `ACTION.SEARCH` 已在 D3-02 的 `RESOURCE_ACTIONS` 中，resource-library 的 built-in app grant 覆盖它；第三方 App 无 search grant 时搜索候选全部被 App 侧 DENY。
- Department 边界：`DEPARTMENT` scope 资源只对该 Department ACTIVE 成员 + DEPARTMENT grant 生效（探针：Dept B 成员命中，Dept A 成员与跨组织 0）。
- Agent 边界：`agent: true` 时仍要求 `resource.useByAgent`；本轮不实现 Agent Retrieval 通道。

## Index as Derived Data（不是第二数据库）

`resource_search_docs` / `resource_search_fts` / `resource_index_jobs` / `resource_preview_cache` 全部是**派生数据**：

- 权威身份 / 授权仍只在 `resource_registry`，内容 / 版本仍在 `library_resources` / `resource_versions`。
- 索引可随时整体删除并从权威表重建：`SearchService.rebuildFromAuthoritative` 清空文档，下一次 `search()` 通过惰性 reconcile 重建。
- 索引状态只做投影（并同步一份到 `library_resources.index_status` 作为 UI 缓存），不参与授权判定。

## Schema / Migration

`SCHEMA_VERSION = 6`。v6 迁移新增：

- `resource_search_docs`（resource_version / content_checksum / index_version / index_status / name / description / tags_text / collection_name / content_text / content_truncated / indexed_at / error_code）
- FTS5 虚拟表 `resource_search_fts(resource_id UNINDEXED, index_version UNINDEXED, name_tokens, description_tokens, tag_tokens, collection_tokens, content_tokens, tokenize='unicode61')`
- `resource_index_jobs`（QUEUED/RUNNING/DONE/FAILED/CANCELLED，`UNIQUE(resource_id, resource_version)`）
- `resource_preview_cache`（cache_key / resource_version / content_checksum / preview_kind / preview_version / storage_key / status）

迁移逐级原子。v5 → v6 失败注入验证：`user_version` 停在 5，v6 表不残留，Users / Resources 完整，修复后可正常升级；重启后索引持久化（`resource-index-migration.test.mjs` / `resource-index-recovery.test.mjs`）。

## CJK Tokenization（硬验收）

SQLite `unicode61` 把连续 CJK 当一个 token，`trigram` 又要求 ≥3 字，无法满足 2 字中文查询。本模块用**受控本地 n-gram**，FTS5 只当分词容器：

- 索引：ASCII/Unicode 词按整词；CJK 写 **unigram + 相邻 bigram**，去重后以空格写入 token 列。
- 查询：单字 CJK → unigram；≥2 字 CJK → 全部 bigram 的 AND 链；ASCII 词按整词。
- 结果：`鞋子`→`"鞋子"`；`详情页`→`"详情" "情页"`；`生成提示`→`"生成" "成提" "提示"`。Node 与 Electron 主进程 FTS5 均验证（探针 01）。

## Full-text Search Provider

`SearchService.search({ context, query, filter, agent, limit, offset, reconcile })`：

1. session / app gate（`#actor`）；
2. `parseQuery` 校验（空 → `QUERY_EMPTY`，>256 字符 → `QUERY_TOO_LONG`）；
3. `#reconcile` 对齐 STALE / 缺失文档；
4. 分页取 FTS 候选（batch 200），每批 `authorizeMany` 过滤；
5. 结构化 filter（category / resourceType / memorySubtype / storageMode / collectionId / departmentId / tagId）；
6. 授权范围内排序、分页，`total` 只统计 authorized；扫描达到 `MAX_SCAN=5000` 时 `totalIsLowerBound=true`。

## Ranking

确定性 ranking：`score = -bm25 + 字段权重 + updatedAt 微调`。bm25 权重 `(resource_id, index_version, name, description, tag, collection, content) = (0,0,8,3,6,2,1)`；字段 boost name 6 / tag 4 / description 2 / collection 1 / content 0.5。Renderer 不重算另一套排序。

## Snippet

`buildSnippet` 返回**结构化 spans**（`{ text, match }` 数组），绝不返回 HTML 字符串；Renderer 用 `<mark>` 渲染。UI 源码断言无 `dangerouslySetInnerHTML`。特殊字符 / XSS payload 以纯文本进入 snippet 与 preview。

## Structured Filters

复用 D3-04B 的分类映射（`resource-domain.categoryTypes`）；`filter.category` 与 `resourceType` / `memorySubtype` / `storageMode` / `collectionId`（含 `unfiled`）/ `departmentId` / `tagId` 在授权结果范围内服务端过滤。

## Pagination / Scan Budget

`limit + offset` 基于 authorized 结果；无权资源不占页、不计入 `total`。FTS 扫描有 `MAX_SCAN` 预算，防止极端 ACL 造成无界扫描；超限明确 `totalIsLowerBound`，不静默截断。

## Index Lifecycle

- **惰性 reconcile**：`search()` 前用 `r.updated_at > d.indexed_at OR r.version <> d.resource_version OR index_status ∈ {PENDING,STALE,FAILED,INDEXING}` 找 STALE，用 LEFT JOIN 找缺失文档并重索引；内容 / metadata / version 变化无需在 ResourceService 里埋 mutation hook。
- **Trash / 删除**：Trash 后实时授权即 DENY；永久删除后 reconcile 清除残留文档与 FTS 行。
- **作业恢复**：`resource_index_jobs` 记录 QUEUED/RUNNING；`recoverStartup()` 把 RUNNING → QUEUED、`INDEXING` 文档 → PENDING（崩溃后可重放）。
- **重建入口**：`resource/reindex`（单个，需 EDIT）与 `resource/reindex`（mode=all，仅 ADMIN，分批 limit），UI Inspector 提供"重新索引 / 重建全部索引"。

## Text Extraction

`ResourceExtractorRegistry`：

- memory / text / code / prompt + `text/*` / json / xml → 抽取正文（受 `MAX_INDEX_TEXT_BYTES=2MB` 限制，超限标 `contentTruncated`）；
- `application/pdf` → **metadata-only**，正文抽取记 `UNSUPPORTED_TEXT_EXTRACTION`，不做 OCR，不伪造正文；仍可按文件名 / metadata 检索；
- 二进制 / 媒体 → `NO_TEXT`，只索引 name / description / tags / collection；
- MANAGED 走 `managedStore.objectPath(checksum)`，LINKED 走受控 location，抽取只在主进程。

## Preview Service

`previewKindOf`：image/pdf/video/audio/text/unsupported，由 MIME + resourceType 决定，不在 Renderer 按扩展名猜。`preview()` 先授权（VIEW 等），再按 kind 返回：text 直接返回受 `MAX_PREVIEW_TEXT_BYTES=256KB` 限制的正文；其余签发**短时 capability URL**。

## Secure Preview Delivery

- 自定义特权 scheme `openarc-resource`，`protocol.registerSchemesAsPrivileged` 在 app ready **之前**注册（standard / secure / supportFetchAPI / stream / corsEnabled:false）。
- `previewService.handleProtocolRequest` 每次请求**重新授权**，校验 capability 绑定的 userId / sessionRef / appId / resourceId / version / action / nonce / 到期时间，再按 HTTP Range 流式返回（支持 206，`Content-Range`，越界 416，非法 capability 403，过期 410）。
- capability 只存在主进程内，TTL 60s，不是永久 token；Renderer 永远拿不到本地路径、internalKey 或 checksum 目录。

## Thumbnail

image 资源用 Electron `nativeImage` 本地生成 256px PNG，写入 managed store 的 `thumbnails/`（0700/0600），结果按 cache key 落库。Node 测试环境无 `nativeImage` 时明确返回 `PREVIEW_UNSUPPORTED`，**不伪造**。真实 Electron UI 探针验证 256px 缩略图 + capability 200 image/png。

## Preview Cache & Invalidation

cache key = `resourceId + resourceVersion + checksum + kind + previewVersion`（sha256）。内容 / 版本 / checksum / kind / preview 版本任一变化即 miss 并重建；`cleanupForResource` 清理派生行与文件，**不触碰权威 Resource**。缓存存在 ≠ 有权读：每次协议请求仍重新授权。

## Preview Kinds

- **text**：直接返回纯文本（截断标记）。
- **image**：capability 流 + 本地缩略图。
- **pdf**：capability 流交 Chromium 内置 viewer（不做 OCR / 转写）。
- **video / audio**：capability + Range（206），支持 seek；真实 Electron 探针用 renderer `MediaRecorder` 生成 WebM、用真实 WAV 验证 metadata / duration / seek。
- Trash 资源**永不**交付内容（无 `includeTrashed` 绕过）。

## No Remote Services

明确不调用远程 Embedding / Vision / OCR / Transcription。`package.json` 未新增网络依赖；搜索 / 抽取 / 预览模块无 HTTP 客户端；运行时网络拦截探针 0 调用。语义检索 / 向量索引属后续阶段且必须用户显式允许。

## Renderer Boundary

preload 只新增受控命令：`resource/search` / `resource/indexStatus` / `resource/reindex` / `resource/preview` / `resource/thumbnail`（仍走 `resource:command` 字面量通道）。没有通用 fs；绝对路径 / internalKey 不回渲染进程；UI 探针断言 DOM 不含临时目录与 `objects/sha256`。

## Renderer Integration / UI

Resource Library 搜索框在 query 非空时改走 `resource/search`，空时保留 D3-04B 结构化 `resource/query`；卡片展示结构化 snippet（`<mark>`）与命中字段；Inspector 新增 Preview 区（text/image/video/audio/pdf/不可用）与 Index 区（index_status / indexed version / 重新索引 / 重建全部）。

## CSP

Renderer CSP 原先只允许 `img-src 'self' data:`，导致 capability 图片 / 媒体 / PDF iframe 被 `ERR_BLOCKED_BY_CSP`。真实 Electron 预览探针暴露该缺陷后，最小化放开：`img-src 'self' data: openarc-resource:; media-src openarc-resource:; frame-src openarc-resource:`，`connect-src 'none'` 保持不变（Renderer 不能 fetch）。

## Performance

10,000 条授权索引（`experiments/d3-04c/05-performance.mjs`）：reconcile 路径 p50 ≈ 351ms / p95 ≈ 368ms，纯索引（FTS + 批量授权）p95 ≈ 24ms，RSS ≈ 267MB，`scanned` 受 `MAX_SCAN` 约束。搜索分页 batch 200，不一次把全量候选交给 Renderer。

## macOS

真实 Electron 44.3.0 / Node 24.20.0（主进程）/ Node 22.22.3（测试）：中文检索、零泄漏、capability 交付、Range、真实缩略图、真实 WebM seek 全部在 macOS arm64 验证。

## Windows

**NOT VERIFIED。** Windows 下的自定义 scheme / 媒体解码 / 文件选择器行为未在真机验证。

## Handoff（下一阶段）

- D3-04D：Department / Super Admin 权限矩阵、App Resource Picker、治理编辑、Files / Projects / Canvas 集成。D3-04C 冻结的 search/index/preview 语义与 capability 交付必须复用。
- 后续：Agent Retrieval 只能通过 `authorizeMany` 同一授权边界；语义 / 向量检索与任何远程模型调用必须用户显式允许。
- **不进入** D3-04D / D3-05 / D4 / D5。

## Tests

新增 14 个 test 文件（55 用例）：resource-extractor / resource-search-chinese / resource-search-index / resource-search-authz / resource-search-lifecycle / resource-search-pagination / resource-search-injection / resource-preview / resource-preview-authz / resource-preview-cache / resource-preview-security / resource-index-migration / resource-index-recovery / resource-search-performance。

真实 Electron UI 探针：`tests/resource-search-ui.mjs`（16 checks）、`tests/resource-preview-ui.mjs`（19 checks）。

## Evidence

| 入口 | 结果 |
| --- | --- |
| npm test | （见下） |
| npm run build | PASS（tsc --noEmit && vite build） |
| npm run test:d3-04c | 5 探针 PASS / FAIL 0（60 用例） |
| npm run test:resource-search-ui | 16 / 16 UI checks PASS |
| npm run test:resource-preview-ui | 19 / 19 UI checks PASS |
| npm run test:d3-04b / d3-04a / resource-ui / resource-library-ui | 见回归章节 |

产物：`artifacts/d3-04c/*.json`。

## Remaining Gaps

1. Windows scheme / 媒体 / picker NOT VERIFIED
2. PDF 正文抽取（OCR）明确不实现，只做 metadata-only —— 属"未做"而非"失败"
3. 远程 Embedding / 语义检索不实现（需用户显式允许的后续阶段）
4. 音频 / 视频 poster 帧（Poster）未生成，仅 image 缩略图；video poster 标 DEFERRED
5. 预览缓存无后台 GC 定时器（仅按资源清理 + 惰性失效）
6. `resource_index_jobs` 作业表已具备恢复语义，但本轮以惰性 reconcile 为主路径，后台 worker 属后续优化
7. 超大数据集（>10k）与超长文档的基准未覆盖
