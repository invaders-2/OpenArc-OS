# D3-04C Result

## 1. Base

- 分支：\`feature/d3-04c-resource-search-preview\`
- 基线：\`feature/d3-04b-resource-library\` remote HEAD \`b0c2a96\`（**不是 main**）
- 交付平台：macOS arm64（Electron 44.3.0 / 主进程 Node 24.20.0 / 测试 Node 22.22.3）
- 已 push origin；**未 merge main**。

## 2. Scope（已交付）

Authorized Search Provider、本地全文索引、Index Lifecycle、Text Extraction、结构化 Search Snippet、Ranking、Preview Service（text / image / PDF / video / audio）、Thumbnail、Secure Preview Delivery（capability + Range）、Preview Cache 与失效、v5→v6 迁移、真实 Electron UI 验收。

## 3. Not In Scope（明确未进入）

D3-04D 治理 UI / Super Admin 权限矩阵 / App Resource Picker / Files / Projects / Canvas；Agent Retrieval；D3-05 / D4 / D5；远程 Embedding / Cloud Vision / OCR / Transcription。

## 4. Local First

搜索 / 索引 / 抽取 / 缩略图全部本机完成：纯 JS 领域模型 + SQLite FTS5 + Electron \`nativeImage\`。运行时拦截 \`fetch\` / \`http(s).request\` / \`dns.lookup\` / \`net.connect\` / \`tls.connect\` 后执行完整链路：**0 网络调用**。

## 5. Default Deny

FTS 只产候选；每个候选必须经 D3-02 Authorization。未授权资源不进入 \`items\`、不计入 \`total\`、无 snippet / highlight / tag / owner / collection / thumbnail，也不经条数或错误码暗示存在。

## 6. Authorization Boundary

\`AuthorizationService.authorizeMany({ context, application, resources, action, agent })\` 一次 prepare 批量判定，授权始终在服务端；禁止 load-all → Renderer filter。\`resource.search\` 属 \`RESOURCE_ACTIONS\`，受 User ∩ App ∩ Scope ∩ Department 交集约束；Agent 仍需 \`useByAgent\`。

## 7. Authorized Search Provider

\`SearchService.search()\`：session/app gate → \`parseQuery\` → 惰性 reconcile → FTS 候选分批 → \`authorizeMany\` → 结构化 filter → 授权范围内排序分页。\`total\` 只统计 authorized。

## 8. Schema / Migration

\`SCHEMA_VERSION = 6\`。新增 \`resource_search_docs\`、FTS5 虚拟表 \`resource_search_fts\`、\`resource_index_jobs\`、\`resource_preview_cache\`。迁移逐级原子；v5→v6 失败注入回滚到 v5 且表不残留；重启后索引持久化。

## 9. FTS5 Capability

Node SQLite 与 Electron 主进程 SQLite 均验证 FTS5 / unicode61 / bm25 / snippet 可用。trigram 仅作能力确认，不用于 2 字中文。

## 10. Chinese Search（硬验收）

真实单测 + 真实 Electron UI 双重验证：\`鞋子\`、\`详情页\`、\`生成提示\` 均命中 1 条。

## 11. Tokenization

受控本地 n-gram：ASCII/Unicode 整词；CJK 写 unigram + 相邻 bigram。查询：单字 → unigram；≥2 字 → bigram AND 链。FTS5 只作分词容器。

## 12. Ranking

确定性 \`score = -bm25 + 字段权重 + updatedAt 微调\`；bm25 权重 name 8 / tag 6 / description 3 / collection 2 / content 1。Renderer 不重算排序。

## 13. Snippet

\`buildSnippet\` 返回结构化 spans（\`{text, match}\`），绝不返回 HTML；Renderer 用 \`<mark>\` 渲染；源码无 \`dangerouslySetInnerHTML\`；XSS payload 以纯文本处理。

## 14. Structured Filters

category / resourceType / memorySubtype / storageMode / collectionId（含 unfiled）/ departmentId / tagId，全部在授权结果范围内服务端过滤。

## 15. Pagination

\`limit + offset\` 基于 authorized 结果；无权资源不占页、不计入 total。单测验证 25 条分页不重复不遗漏。

## 16. Scan Budget

\`MAX_SCAN = 5000\`，FTS \`FTS_BATCH = 200\`；超限时 \`totalIsLowerBound = true\`，不静默截断。

## 17. Index Lifecycle

惰性 reconcile：\`updated_at > indexed_at OR version 不一致 OR status ∈ {PENDING,STALE,FAILED,INDEXING}\` → 重索引；缺失文档补齐；永久删除后清除。无需在 ResourceService 埋 mutation hook。

## 18. Index Jobs

\`resource_index_jobs\`（QUEUED/RUNNING/DONE/FAILED/CANCELLED，UNIQUE(resource_id, version)）持久化；本轮主路径为惰性 reconcile，作业表提供恢复语义。

## 19. Recovery

\`recoverStartup()\` 将 RUNNING → QUEUED、INDEXING 文档 → PENDING；重启后 FTS / docs 落盘仍可命中；幂等。

## 20. Rebuild From Authoritative

\`rebuildFromAuthoritative\` 清空派生文档，权威 Resource 不受影响；下一次 search 从 \`resource_registry\` / \`library_resources\` 重建。证明 Index 不是第二数据库。

## 21. Text Extraction

memory / text / code / prompt + text/*、json、xml 抽取正文（\`MAX_INDEX_TEXT_BYTES = 2MB\`，超限标 truncated）；二进制 / 媒体 NO_TEXT；仅主进程读取。

## 22. PDF Handling

\`application/pdf\` 仅 metadata-only 索引，正文抽取记 \`UNSUPPORTED_TEXT_EXTRACTION\`，**不做 OCR、不伪造正文**；PDF 预览经 capability 交 Chromium viewer。

## 23. Preview Service

\`previewKindOf\` 按 MIME + resourceType 决定；text 返回受 \`MAX_PREVIEW_TEXT_BYTES = 256KB\` 限制的正文，其余签发 capability。

## 24. Preview Kinds

text / image / pdf / video / audio / unsupported 全部实现；Trash 资源永不交付内容（无 \`includeTrashed\` 绕过）。真实 Electron 验证 text、image+thumbnail、pdf iframe、真实 WAV 音频、MediaRecorder 真实 WebM 视频（metadata + seek）。

## 25. Thumbnail

image 资源用 Electron \`nativeImage\` 本地生成 256px PNG（0700/0600），落 Preview Cache。Node 无 nativeImage 时明确 \`PREVIEW_UNSUPPORTED\`，不伪造。真实 Electron 验证 256px + capability 200 image/png。

## 26. Poster

视频 / 音频 Poster 帧 **DEFERRED / NOT VERIFIED**（仅 image 缩略图；未伪造）。

## 27. Secure Preview Delivery

特权 scheme \`openarc-resource\` 在 app ready 前注册；\`protocol.handle\` 每次请求重新授权后流式返回。Renderer 只拿到短时 capability URL，永不接触本地路径 / internalKey / checksum 目录。

## 28. Capability Model

capability 绑定 userId / sessionRef / appId / resourceId / version / action / nonce / 到期；TTL 60s，仅存主进程。非法 403、过期 410。

## 29. Range Delivery

支持 HTTP Range：206 + \`Content-Range\`，越界 416，单段上限 \`MAX_RANGE_BYTES = 8MB\`。image / video / audio / protocol 层均验证。

## 30. Preview Cache

cache key = resourceId + resourceVersion + checksum + kind + previewVersion（sha256），元数据落 \`resource_preview_cache\`。

## 31. Cache Invalidation

内容 / 版本 / checksum / kind / preview 版本变化即 miss 重建；\`cleanupForResource\` 清理派生行与文件，不触碰权威 Resource；缓存存在 ≠ 有权读。

## 32. No Remote Services

明确不调用远程 Embedding / Vision / OCR / Transcription；无网络依赖；运行时网络拦截探针 0 调用；静态扫描 5 个模块无远程端点。

## 33. Renderer Boundary

preload 仅新增 \`resource/search\` / \`resource/indexStatus\` / \`resource/reindex\` / \`resource/preview\` / \`resource/thumbnail\`（仍走字面量 \`resource:command\`）。无通用 fs；绝对路径不回渲染进程。D2-02 security-surface 15/15（桥接 9 键 / IPC 7 通道与冻结清单一致）。

## 34. UI Integration

query 非空走 \`resource/search\`，空则保留 D3-04B 结构化 \`resource/query\`；卡片展示结构化 snippet + 命中字段；Inspector 新增 Preview 与 Index 区（状态 / 版本 / 重新索引 / 重建全部）。

## 35. CSP

真实 Electron 探针暴露 capability 图片 / 媒体 / PDF 被 \`ERR_BLOCKED_BY_CSP\`。最小化放开 \`img-src ... openarc-resource:\`、\`media-src openarc-resource:\`、\`frame-src openarc-resource:\`；\`connect-src 'none'\` 保持不变。

## 36. Security / Privacy

零泄漏：\`Omega\` / \`TopSecretBody\` / \`部门B\` / \`机密\` 对无权用户 0 结果且响应无资源名 / ref；Dept B 成员命中、Dept A 与跨组织 0；猜 ID 一律 \`NOT_FOUND_OR_FORBIDDEN\`；Trash preview 拒绝；DOM 无本地路径。

## 37. Performance

10,000 条授权索引：reconcile p50 ≈ 351ms / p95 ≈ 368ms；纯索引 p95 ≈ 24ms；RSS ≈ 267MB；\`scanned\` 受预算约束。

## 38. Platform Status

- **macOS arm64：PASS**（上述全部真实执行）。
- **Windows：NOT VERIFIED**（自定义 scheme / 媒体解码 / 文件选择器未在真机验证）。

## 39. Tests

新增 14 个 \`.test.mjs\`（55 用例）+ 2 个真实 Electron UI 探针（16 + 19 checks）+ 5 个 D3-04C 探针（60 用例）。维护性更新：迁移测试适配 v6，D3-04B 探针与 D2-02 安全探针适配新的 main.cjs 加载顺序。

## 40. Evidence

| 入口 | 结果 |
| --- | --- |
| npm test | **403 / 403 PASS** |
| npm run build | **PASS** |
| npm run test:d3-04c | **5 探针 PASS / FAIL 0（60 用例）** |
| npm run test:resource-search-ui | **16 / 16** |
| npm run test:resource-preview-ui | **19 / 19** |
| npm run test:d3-04b | PASS 2/2（15 + 10） |
| npm run test:d3-04a | PASS 4/4（34 用例） |
| npm run test:d3-01 / d3-02 / d3-03 | 12/12 / 6/6 / TLS 12/12 |
| npm run test:d2-02 | PASS 7/7（security-surface 15/15） |
| npm run test:resource-ui / resource-library-ui | 10/10 / 24/24 |
| npm run test:identity-ui / authorization-ui / device-ui | 24/24 / 14/14 / 32/32（2 NOT VERIFIED 属 D3-03） |
| npm run test:security / design-system / theme-baseline | FAIL 0 / PARTIAL 2 / PASS 6；PASS 4 / PARTIAL 1；PASS |

## 41. Commits / Artifacts

6 个原子提交，已 push origin（\`feature/d3-04c-resource-search-preview\`）：\`6da54c3\` index → \`e34fa2d\` preview → \`c83e107\` bootstrap → \`a2c020b\` UI → \`d892ec2\` tests → \`ce3da94\` docs。产物：\`artifacts/d3-04c/*.json\`。

## 42. Remaining Gaps / Next Phase Admission

Windows NOT VERIFIED；PDF OCR / 转写 / 远程 Embedding 明确不实现；video poster DEFERRED；预览缓存无后台 GC 定时器；>10k 数据集与超长文档基准未覆盖；\`resource_index_jobs\` 后台 worker 属后续优化。
**D3-04D = BLOCK，直到 D3-04C 验收通过；本轮不进入 D3-04D / D3-05 / D4 / D5。**
