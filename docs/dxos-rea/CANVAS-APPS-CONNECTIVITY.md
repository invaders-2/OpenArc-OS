# DX OS 0.6.1 · 画布 / 素材 / 媒体连通性 + 30 应用矩阵 + 0.5.5→0.6.1 差异

> 只读逆向分析（研究性）。目标：DX OS 0.6.1 便携运行时。本文所有结论按「观察 / 推断 / 未知」标注；「观察」附 REA Evidence ID 或随包源码 file:line。未启动、未执行、未联网、未修改目标。

## 0. 目标、证据与方法

| 项 | 值 |
|---|---|
| app.asar | `…/runtime-0.6.1-c2699917-…/DX OS.app/Contents/Resources/app.asar`，4,763,200 B，sha256 `f14ed0a66f5ca0b5c3e244c37b25ca0fb663b7cade445cbe0a1feacee96d7933` |
| REA（app.asar） | `ev_3921218edff6ecf6f0668fb731f95c478843328643e3ca4c2b2e6e863871e16b`；6,502 相关文件 / 5,074 解析 JS / 19,933 findings / 19 parse failures；图 26,944 节点 / 27,929 边 |
| REA（前端 dist） | `ev_9178e6af633b32894db81e4f74448e4aec964b1db5678e9116b61ce73e9c8217`；52 相关文件 / 49 解析 JS / 1,087 findings；summary 视图 `ev_027b5212ad469dd229d30e481460d34a1f5d756844aa155d0d14e8e3d25d778a`；module 分页 `ev_f3faa43f4e668c28dd757390b0bbb7beb67c36a904ec54b96cef517c2c8eb68c` |
| 前端 dist | `app.asar.unpacked/dist`，sha256 `36c57d6ba263406c75711f30f4ba55b22113a1baea12080a4f836e69b632bf6b`，118 个 assets |
| 后端 | `app.asar.unpacked/server/`（含子目录共 195 个 .ts，TypeScript 源码）+ `shared/`（41 个 .ts）；**不在 app.asar 内** |
| 0.5.5 基线 | `DX-OS-完整逆向报告.md`（348 KB）+ `_re_analysis/routes-0.5.5.tsv`（584 条）+ `_re_analysis/asar55/`（外壳源码）；复用其结论处均标注「复用 0.5.5」 |
| 取证方式 | REA `analyze_javascript_application` 用同版本 CLI 6.4.0 跑完（MCP 直连因响应预算超时）→ 组装 bundle 经 MCP `import_evidence_bundle` 导入（imported=2）→ `inspect_analysis_view` 取 summary/modules 视图。源码结论另标 `源码阅读` |

方法上的两个硬事实（会影响回答边界）：

1. **观察**（REA + asar 清单）：0.6.1 的 `app.asar` 只是外壳，根级仅 `main.cjs / preload.cjs / proxy.cjs / direct-update-fetch.cjs / compat-update-fetch.cjs / cloud-compatibility.cjs / update-*.cjs / portable-*.cjs / path-encoding.cjs` + `node_modules` + `/assets`；`server/`、`shared/`、`dist/` 全部位于 `app.asar.unpacked/`（asar 解包侧车）。因此 REA 的 app.asar 图只覆盖外壳；前端另做一次 REA 分析（上表 dist 记录）。
2. **观察**：app.asar 声明完整性与其 unpacked 伴生文件存在 **364 条矛盾**（如 `node_modules/@babel/parser/package.json`、`@esbuild/darwin-arm64/bin/esbuild`），REA 将这些字节标为 `observed-untrusted`。本报告结论尽量以 `server/*.ts` 源码、路由声明和 REA 前端图为准，未把相互矛盾的字节当作等价凭据。

---

## 1. 结论（10 行）

1. **画布是外部 dx-app，不是 dist 内置页**：0.6.1 注册表 30 项里 `canvas` 用 `delivery:"dx-app"` + `OnDemandAppPlaceholder` 占位；真实前端由 DeveloperAppHost 以 iframe + 运行时令牌加载（本机已装 canvas 1.0.288，`dx-app.json` 声明 `entry:index.html`、`backgroundMode:keep-alive`、`multiInstance:true`）。【观察；运行态包非 asar】
2. **「素材库 / 资源库」在服务端是同一套「资产库」对象**：`ccs.db.developer_collab_projects` 中 `app_id='canvas'`、`kind='asset-library'` 的协同项目；每个库绑定一个 fs 目录 `项目/无限画布/资产库/<库名>`，目录上打共享标记 `asset-library:<libraryId>`（`server/canvasAssetLibrary.ts:20-55`、`server/fs.ts:938-954`）。
3. **画布引用素材的方式是「FS 节点 ID + `/api/fs/raw/<nodeId>` URL」，不是 blob 内联、不是路径**：`MediaRef = { nodeId, url:'/api/fs/raw/<nodeId>', role, kind, … }`（`server/canvas.ts:18-43`），库项 `media` 同构（`shared/canvasAssetLibrary.ts:24-31`、`server/canvasAssetLibrary.ts:90-100`）。
4. **导入/复制一律在服务端复制文件**：库项 upsert 的 `sourceNodeId` 会 `copyNode` 到库目录（`server/canvasAssetLibrary.ts:206-211`）；相册导入画布/库也是服务端复制并建节点（`server/index.ts:5924-5996`）；`.dxcanvas` 导入为每个素材建新节点并重映射所有 URL/ID（`server/canvasPackage.ts:126-163`、`server/index.ts:3381-3420`）。
5. **权限双层**：画布 `private/public/restricted` + `canvas_members` + 邀请码（只存 hash）；资产库 `access read/edit/owner` + `visibility private/public/restricted` + `publicAccess` + members（`server/canvas.ts:149-151,721-738`、`server/developerCollabProjects.ts:87-100`、`shared/canvasAssetLibrary.ts:74-86`）。fs 读取经 `shareZoneOf → canSeeShare`，其中 `asset-library:` 区调用 `canvasAssetLibraryAccess`（`server/index.ts:6028-6036,6064-6071`）。
6. **画布媒体有单独的“文档引用即可见”放宽**：`canViewCanvasMedia` 只对画布文档实际引用的 nodeId 放行，且明确不授予父目录或相邻文件权限（`server/canvas.ts:758-764`）；编辑权限另由 `canEditCanvas` 控制（`:734-738`）。
7. **生成链路分叉**：`POST /api/canvas/generate` 在非 comfy/非 CLI 时转成 V2 AI 任务（`extensions.protocolExecutionMode='agent'`），任务落 `protocol-tasks.db`，产物下载/校验后写入「画布数据/<canvasId>/生成结果」fs 节点并 `saveBlob`，再把 `MediaRef[]` 返回前端（`server/index.ts:5203-5209,3651-3690`；`server/canvasPackage.ts` 的 `resolveAsset` 亦从同一 fs 读取）。
8. **协作与插件都是“画布文档 + 服务端中介”模型**：WS `/api/canvas/collab` 上行只允许 cursor，presence/cursor/patch 由服务端广播；文档保存走 `POST /api/canvas/:id/sync` 的逐卡 upsert/patch + 版本冲突 409（`server/canvasCollab.ts:40-80`、`server/canvas.ts:1002-1087`）。插件**只能**来自开发者应用 `manifest.canvas`，注册表落 `data/canvas-plugins/registry.json`，卸载保留 tombstone（`server/canvasPlugins.ts:62-135`）。
9. **30 个内置应用在 0.6.1 没有增删**：注册表仍是 30 项（18 个 dist chunk + canvas/comfyui/snake 三个 dx-app 占位 + ziniao 内联组件），与复用基线（0.5.5 报告 §2 表）逐 id 对齐；变化在**相册后端扩张**（photocraft/OCR/抠图模型/导入画布与资产库）与**文件传输**（新增 `file-transfers` + 迁移 53/54）。【观察 + 复用】
10. **0.6.1 相对 0.5.5 的可确证增量**：路由静态提取 584→648（+70/−8，其中 8 条是模板路由提取差异，非删除）；新表 4 张（`photo_source_visual_features`/`photo_source_related_rankings`/`photocraft_projects(+members)`/`app_exchanges`，migration 50/51/53/54）；preload 新增 4 个 IPC（剪贴板图片 3 个 + `ensure-local-admin-session`），暴露成员 9→15；外壳新增 `direct-update-fetch.cjs`，`main.cjs` +4,247 B；新增 OCR（PaddleOCR-VL）、系统字体、分块文件传输、本机代理探测、`/api/codex-canvas/relay`、`/api/canvas/asset-libraries/:id/sync-sources` 等路由。【观察】

---

## 2. 无限画布连通性

> 本节「观察」的前端/外壳依据为 REA `ev_9178e6af…`（dist 应用图）/ `ev_3921218e…`（app.asar 外壳图）与随包源码 file:line；来自本机已安装 dx-app 包的观察会单独标注「运行态包」。

### 2.1 端到端链路（观察）

```
注册表(canvas, dx-app) → DeveloperAppHost(iframe, window.dx.invoke/受控桥)
  → /api/developer-runtime/<token>/…（dx-app.json.appApi 白名单 + permissions）
  → /api/canvas/*（requireAuth；画布前缀本身无 requireAppOpen，外部 Codex 桥另有 loopback 限制）
  → server/canvas*.ts（ccs.db + fs.json/blobs + protocol-tasks.db）
  → 模型/Comfy/RunningHub/CLI 或 云 /v1/canvas-cloud
```

- **前端入口**：`dist/assets/index-DJDR-kWU.js` 注册表项 `{id:"canvas",name:"无限画布",delivery:"dx-app",component:da}`（`da` = OnDemandAppPlaceholder）；真实 UI 在 `data/developer-apps/.versions/canvas/1.0.288+10288-d128aaae/source/`（`dx-app.json` + `assets/index-BNPFwRtS.js` 1,167,155 B）。【观察；运行态包，非 app.asar 静态内容】
- **窗口/状态**：`multiInstance:true`，`backgroundMode:keep-alive`；窗口由外壳 `windows` store 管理（每个实例一个 windowId），画布文档状态在服务端 `canvases.document_json`，视口 `viewport{x,y,scale}` 随文档保存；前端另有 `dx-canvas-asset-groups:<libraryId>`（资产库分组）等 localStorage 键。【观察：dx-app.json + `We.patch('/canvas/...')` 字面量 + `server/canvas.ts:160-175`】
- **API 白名单**（`dx-app.json.appApi`，观察）：`/canvas`、`/fs`、`/skills`、`/agent`、`/ai-tasks`、`/ai/tasks`、`/ai/models`、`/comfyui`、`/director3d`、`/protocols`、`/market/developer-apps`、`/canvas/plugins(/registry)`、`/codex-canvas/*`；权限 `app.canvas.app-api.call / ui.* / system.user-summary / clipboard.* / file.write`。
- **路由守卫**：`app.use('/api/canvas', requireAuth)`（`server/index.ts:1414`）；部分应用级前缀另有 `requireAppOpen('canvas')` 等（如 `/api/ai-image-declaration`、`/api/video`）。

### 2.2 画布 ↔ 素材库 / 资产库（重点）

**服务端对象与存储**

| 内容 | 实现 | 证据 |
|---|---|---|
| 资产库项目 | `developer_collab_projects(app_id='canvas', kind='asset-library', document_json)` | `server/canvasAssetLibrary.ts:20-75`；`server/developerCollabProjects.ts:25-60` |
| 库成员/邀请 | `developer_collab_members` / `developer_collab_invites(code_hash)` | 同上 `:39-59,87-100` |
| 库的 fs 目录 | `项目/无限画布/资产库/<库名>`，`share='asset-library:<libraryId>'` | `server/canvasAssetLibrary.ts:33-40`；`server/fs.ts:938-954` |
| 文档结构 | `dx-canvas-asset-library/v1`，`items[]`：kind(asset/prompt/workflow)、media{nodeId,name,url,kind,mime,poster}、cover、versions、sourceKey、relation* | `shared/canvasAssetLibrary.ts:1-86` |
| 容量/去重 | `MAX_ITEMS=1000`；`sourceKey`（`asset-source:<nodeId>` / `photo:<sourceId>`）与 `id` 决定 upsert 去重 | `server/canvasAssetLibrary.ts:23,173-178`；`server/index.ts:5854-5855,5986` |

**引用方式（观察）**

- 库项 `media = { nodeId, name, url: '/api/fs/raw/<nodeId>', kind, mime? }`；视频可带 `poster`（data URL），封面也是库目录下的一个 fs 文件（`materializeDataUrl`，`server/canvasAssetLibrary.ts:90-111`）。
- 放置到画布：前端资产选择器按 `media.nodeId` 取素材，卡片 `inputs[]` 记录同一结构 `{nodeId,url,kind,role:'input'}`；保存时随整份文档写入 `canvases.document_json`。**不把二进制写进画布 JSON**（画布只存引用）。
- 从画布/文件夹「导入来源」：前端枚举 fs 节点（`/fs`、`/api/fs/raw/`），勾选后 `POST /api/canvas/asset-libraries/:id/sync-sources`，body `{items:[{nodeId,name,canvasId}]}`；服务端 owner-only、先逐项做 `canReadNode || canViewCanvasMedia` 权限检查，再以 `sourceNodeId` 触发 `copyNode`，`sourceKey='asset-source:<nodeId>'`。（`server/index.ts:5844-5873`；canvas 前端 `index-BNPFwRtS.js` 中 `sync-sources` 字面量）
- 相册跨应用导入：`POST /api/photos/import-image`，`destination='canvas'` 复制到画布存储目录、创建卡片并按视口定位、`broadcastCanvasPatch`；`destination='library'` 复制到库目录并 upsert 库项（`server/index.ts:5924-5996`）。

**导入 / 复制 / 删除 / 重命名（观察）**

| 操作 | 接口 | 服务端行为 |
|---|---|---|
| 新增/更新库项 | `POST /api/canvas/asset-libraries/:id/items` | 只读库拒绝；`baseVersion` 乐观版本；`sourceNodeId` 复制文件；`coverDataUrl` 落 blob；`workflow` 内媒体递归复制并重写 nodeId/url（`server/canvasAssetLibrary.ts:144-244`） |
| 重命名/分组 | 同上（带 `id` + `title`/`group`） | 按 id upsert，标题截 160、分组截 40；保留 `versions` 历史 |
| 删除库项 | `DELETE /api/canvas/asset-libraries/:id/items/:itemId?baseVersion` | 系统提示词（`promptRole`）拒删；其余从 items 过滤（文件本身不在此接口删除） |
| 共享设置 | `PATCH /api/canvas/asset-libraries/:id/members` | `visibility/publicAccess/members` → developer_collab_projects + members |
| 导入来源 | `POST /api/canvas/asset-libraries/:id/sync-sources` | 仅 owner；单次 ≤600 项；容量不足报错；逐项复制 |

**可见性与权限（观察 + 推断）**

- 库级：`access = owner | edit | read`（owner→成员→publicAccess；`server/developerCollabProjects.ts:87-100`）；库 `summary` 携带 `visibility/publicAccess/members`（`shared/canvasAssetLibrary.ts:74-86`）。
- 文件级：库目录是 fs 共享区 `asset-library:<id>`；读取时 `canReadNode → shareZoneOf → canSeeShare`，后者对 `asset-library:` 调 `canvasAssetLibraryAccess(libraryId, userId)`（`server/index.ts:6028-6036`）。**推断**：非库成员即便能在画布看到卡片引用，读取 `/api/fs/raw/<nodeId>` 也可能 403——本次未做运行时验证。
- 画布级：`private` 仅 owner；`public` = 所有登录用户 edit；`restricted` = owner+members edit；邀请码按 `canvas_invite_members` 给 read/edit（`server/canvas.ts:721-728`）。系统管理员**不**自动获得私有画布权限（`server/canvas.ts` 的 `canvasAccess` 完全不看 role，`:721-728`）。
- 复制语义：库/画布/导入来源的「复制」都是 `copyNode`（递归文件夹、含 blob），因此副本与源文件是不同 fs 节点，删除其一不影响另一；`sourceKey` 只用于去重，不维持同步。

### 2.3 图片 / 视频生成任务

- **入口**：`POST /api/canvas/generate`（`server/index.ts:5203`）。`platform==='comfy'` 或带 CLI 工具（`codex`/`gemini`）→ legacy 路径；否则 `legacyCanvasRequestAsV2` 包装为 `dx-ai-task/v2`，`extensions.protocolExecutionMode='agent'` → 走 `/api/ai/tasks` 同一提交器。
- **任务存储**：`protocol-tasks.db`：`ai_protocol_tasks` / `ai_protocol_task_events` / `ai_protocol_artifacts`；产物文件在 `protocol-artifacts/<sha256(taskId)>/<artifactId>.bin`（0.5.5 报告附录 D §5；0.6.1 目录结构同名）。
- **轮询**：`POST /api/ai/tasks/statuses`（批量 ≤50，含 DXOS 远端 pending 的特殊处理，`server/index.ts:5211-5278`）；legacy 查询 `POST /api/canvas/query-generation`（`:5280`）。
- **交付落盘**：协议产物经 `saveCanvasProtocolArtifacts` 下载→sha256 去重→在「画布数据/<canvasId>/生成结果」建 fs 节点→`saveBlob`→返回 `{nodeId,url:'/api/fs/raw/<nodeId>',role:'result',kind,prompt,w,h}`（`server/index.ts:3651-3690`）；即梦结果同构（`:3625-3649`）。前端把结果写入 `card.result/history` 后再 `sync`。
- **文本生成**：`POST /api/canvas/generate-text` 与 `/generate-text/:id/query`（`:5687,5719`）。

### 2.4 `.dxcanvas` 打包 / 导入

- 格式 `dx-canvas-package/v1`：ZIP 内 `canvas.json`（`{format,exportedAt,document,assets[]}`）+ `assets/00001-<name>`（`server/canvasPackage.ts:12-80`）。
- 导出：`GET /api/canvas/:id/export`，按文档中实际出现的 `nodeId` 收集素材（含 director3D 引用），逐个权限校验后读 `content` 或 `readBlob`；文件名 `<title>.dxcanvas`，`Content-Type: application/vnd.dxos.canvas+zip`（`server/index.ts:3364-3380`）。
- 上限：≤5000 文件、单素材 ≤500MB、总量 ≤1GB、`canvas.json` ≤20MB（`server/canvasPackage.ts:13-15,92-101`）。
- 导入：`POST /api/canvas/import`（multipart `package`，≤1GB）→ 校验路径/重复/size → 新建画布（private）→ 每个素材 `createNode+saveBlob` → `remapCanvasPackageValue` 重写 `nodeId`、`/api/fs/raw|thumbnail|video-poster/<id>`、`?canvasId=`、对象键；清空 `assetLibrarySources`，所有 `card.run` 置 `idle`（`server/canvasPackage.ts:126-163`；`server/index.ts:3381-3420`）。失败回滚：purge 存储目录 + trash/purge 画布。

### 2.5 协作 WebSocket

- 端点 `WS /api/canvas/collab?canvasId&clientId`；升级时 `getAuth` + `getCanvasVersion` 校验读权限（`server/canvasCollab.ts:40-49`）。
- 服务端广播 `presence`（用户列表）、`cursor`（x/y/cardId）、`patch`（来自 `/api/canvas/:id/sync` 的 version/upserts/patches/deletedIds/connections/assetLibrarySources）（`:21-38`）。
- 客户端上行只接受 `{type:'cursor',x,y,cardId}`，其余忽略（`:56-72`）；房间为进程内 `Map<canvasId,Set<Peer>>`，无持久化。
- 邀请：`POST /api/canvas/:id/invite` 生成 `XXXX-XXXX` 口令，仅存 `code_hash`；`POST /api/canvas/invites/redeem` 兑换（`server/canvas.ts:1221-1276`）。

### 2.6 插件

- 来源：`rebuildCanvasPluginRegistry` 遍历 `listDeveloperApps()` 的 `manifest.canvas`，读取 `nodeManifests`/`templateManifests`（≤256 KB/清单），注册进 `CanvasNodeRegistry`；无安装记录的旧插件保留 `status:'missing'` tombstone（`server/canvasPlugins.ts:62-135`）。
- 持久化：`data/canvas-plugins/registry.json`；`getCanvasPluginRegistry` 按 install 列表/releaseKey 判过期并重建（`:137-144`）。
- 启停/卸载：`setCanvasPluginEnabled`、`deleteCanvasPlugin`（卸载=删开发者应用，保留插件用户数据）（`:146-174`）。
- 执行：`POST /api/canvas/plugins/execute` 按 `executor.type` 分派 skill / mcp-tool / agent-tool / workflow；`app-bridge` 需插件前端容器（返回 409），`builtin` 执行器禁止（403）（`server/index.ts:3304-3325`）。
- 插件数据：`POST /api/canvas/plugins/:pluginId/data`（get/set/delete/list，容量由 manifest `host.storage.maxBytes` 声明）；插件网络：`POST …/network/request` 校验 `manifest.network` 白名单（`server/index.ts:3290-3303`）。
- 内置节点：`src/apps/canvas/builtinCanvasNodes.ts` 共 16 个 `builtin.*` + `builtin.director-3d`（`nodes/director3d/definition.ts:4`）= 17 个节点定义；端口类型见 `shared/canvasPlugin.ts:7-21`。

### 2.7 云同步

- 路由：`GET /api/canvas/cloud`；`GET /api/canvas/:id/cloud-sync/progress`；`POST …/pause`；`GET …/diff`；`POST …/initialize`；`DELETE /api/canvas/:id/cloud-sync`；`POST …/apply`；`POST /api/canvas/cloud/:id/download`（`server/index.ts:3155-3201`），全部要求 `canvas.ownerId === 当前用户`。
- 客户端：`server/canvasCloudSync.ts`（`dx-canvas-cloud/v1` 清单、资源 PUT/GET/HEAD、>100MB multipart）；基线表 `canvas_cloud_sync_baselines`（0.5.5 报告附录 D §4.7；0.6.1 同名）。


### 2.8 Codex Canvas 桥（画布 ↔ 外部 Codex CLI / MCP）

- **观察**：桥接程序 `Resources/dxos-canvas-mcp.cjs`（559,990 B）；`server/codexCanvasInstaller.ts` 负责安装/校验（`codexCanvasBridgeFile`，开发态用 esbuild 从 `scripts/dxos-canvas-mcp.mjs` 构建到 `data/cache/codex/`）。
- **安装/配对**：`GET /api/codex-canvas/setup`（可 `?bridge=1` 返回 base64 + sha256）、`POST /api/codex-canvas/install`（仅 loopback）、`POST /api/codex-canvas/permissions/pair`（签发一次性配对码，绑定 userId/sessionId/canvasId）、`POST /api/codex-canvas/permissions/revoke`（`server/index.ts:1191-1216`）。
- **本机 API**：`/api/codex-canvas/{connect,snapshot,nodes/find|get|rename|edit,connections/change,cards,generation/preview|execute|query,generation/images}`，全部 `isLoopbackRequest` + Bearer grant 校验（`:1260-1310+`）。
- **跨机中继**：`POST /api/codex-canvas/relay` 用一次性码派生 AES-256-GCM 密钥，只放行固定操作集合（`/snapshot`、`/image-models`、`/nodes/*`、`/connections/change`、`/cards`、`/generation/*`），并校验 nonce 防重放；中继最终仍以本机 Bearer 调用 `127.0.0.1` 的 codex-canvas API（`:1219-1259`）。
- **与画布文档的关系**：`server/codexCanvas.ts` 在 grant 范围内改文档并 `syncCanvas`，节点改名同步所有媒体引用（0.5.5 报告附录 D §4.6；0.6.1 代码同结构）。**推断**：这是 Agent/Codex 操作画布的受控写入通道之一，与 14 个 `canvas_*` 客户端工具并列；本次未做运行时配对验证。

### 2.9 画布未确证项

- dx-app 前端完整源码不随 app.asar 提供；本机 1.0.288 包只能证明该版本行为，不能证明 0.6.1 运行时一定安装该版本（安装记录为运行态数据）。
- 库文件「画布可见但库不可读」时的 403 行为为**推断**，未做运行时验证。
- 云端 `/v1/canvas-cloud` 的请求/响应字段未逐项核对（本次不做联网）。

---

## 3. 30 个内置应用连通矩阵

图例（归类）：`本地`=纯前端/本机后端，无外部网络；`混合`=本机后端 + 模型或云；`云`=目录/权益等云服务为主；`外部云`=第三方 SaaS/MCP；`外部本地`=驱动本机外部软件。所有应用的前端入口都是 0.6.1 dist 中实际存在的 chunk（哈希为该版本实测；0.5.5 的哈希不同）。

**应用级闸门（观察）**：`server/index.ts:1181-1190,1419` 用 `requireAppOpen(appId)` 给整段 API 加“应用已打开/可用”前置校验：`/api/providers|midjourney|runninghub|cli → api-settings`、`/api/dingtalk → dingtalk`、`/api/market → market`、`/api/comfyui → comfyui`、`/api/datasets → dataset-maker`、`/api/quark → quark`、`/api/ai-image-declaration → ai-image-declaration`、`/api/video → video-editor`。矩阵中“API 路由”列出的路径均受对应闸门与 `requireAuth` 约束，未逐条测试放行结果。

### 3.1 第 1 组（系统 / 文件 / 对话 / 账户）

| id | 名称 | 前端入口（0.6.1 chunk） | 窗口/状态 | API 路由（要点） | 服务 / 表 | 外部依赖 | 归类 |
|---|---|---|---|---|---|---|---|
| agent | 贾维斯 | index-DJDR-kWU.js（内嵌 Assistant） | 悬浮面板 role:assistant | `/api/agent/capabilities/discover`、`/api/agent/gateway/run-stream\|step-stream\|runs/:id/complete\|tool-results`、`/api/agent/runs/:id/cancel`、`/api/assistant/bootstrap`、`/api/projects*`、`/api/tasks/:id/*` | `server/assistantDirect.ts`、`agent-kernel/*`、`agent-runtime/*`、`toolCatalog.ts`、`capabilityRouter.ts`；表 `agent_runs/agent_run_events/agent_checkpoints/agent_turns/agent_delegations/agent_workspaces/tool_operations/projects/threads/thread_messages` | 模型站点；MCP | 混合 |
| welcome | 应用 | Welcome-D3hPRNIk.js | 620×480（复用 0.5.5） | 无 | 无后端 | — | 本地 |
| files | 文件夹 | Files-B0LBzpp0.js（fs 操作多在 index 共享模块） | multiInstance | `/api/fs`、`/api/fs/node\|count\|copy\|search\|tree\|upload\|download-zip\|raw\|thumbnail\|video-poster\|trash*` | `server/fs.ts`；`fs.json` + `blobs/<id>` + `blobs/sha256/xx/<sha>` + `cache/fs-thumbnails` | — | 本地 |
| tasks | 对话 | Conversation-DB35y8Nt.js | showInDock:false | `/api/tasks`、`/api/tasks/:id/events/stream`、`/api/agent/tools[/:name/run]`、`/api/skills[/:id/run]`、`/api/assistant/bootstrap`、`/api/assistant/conversations/:id/cache`、`/api/providers` | `assistantDirect.ts`、`taskStore.ts`；表 `tasks/threads/thread_messages/task_*` | 模型站点 | 混合 |
| api-settings | API 设置 | ApiSettings-IQGb5LPa.js | showInDock:false | `/api/providers*`、`/api/protocols[/models\|/v2/*]`、`/api/cli/:tool/*`、`/api/runninghub/*`、`/api/modelscope/keys`、`/api/agnes/keys`、`/api/ai/tasks/:id/events`、`/api/quick-settings/catalog` | `store.ts`、`protocols.ts`、`protocol-engine/*`、`cliTools.ts`、`agentCliTools.ts`；`providers.json`、`provider-settings.json` | OpenAI/Anthropic/Gemini/xAI/MiniMax/火山/百炼/APIMart/AGToken/ZKKI/ModelScope/Agnes/RunningHub/ComfyUI 等 | 混合 |
| accounts | 账户管理 | AccountsApp-C9kLuOmR.js | showInDock:false | `/api/accounts/{snapshot,users*,departments*}`、`/api/app-permissions*`、`/api/providers/quotas*`、`/api/auth/*` | `auth.ts`、`authDb.ts`、`apiQuota.ts`；`auth.db`、`api-quotas.db` | `api.dx-os.com`（云账号/权益/配额） | 混合 |
| settings | 系统设置 | Settings-J_ijGC-J.js | 唯一带 locales（复用 0.5.5） | `/api/desktop/config\|update/status\|check\|rollback\|proxy/detect`、`/api/fs/storage*`、`/api/system/fonts*`、`/api/dxos/redeem\|credits/check-in`、`/api/preferences/*`、`/api/library/config`、`/api/cloud-account/*` | `userPreferences.ts`、`systemFonts.ts`、`localProxyDetection.ts`、`cloudAccount.ts`、`cloudEntitlement.ts`；`user_preferences/system_preferences/user_wallpapers`、`wallpapers/` | `api.dx-os.com`；Google Gemini（代理探测目标） | 混合 |
| calendar | 日历 | Calendar-fmYVXHIK.js | showInDock:false | `/api/calendar/almanac`、`/api/agent/step` | `calendarAlmanac.ts`；事件持久化在 `localStorage: ccs-os:calendar` | `uapis.cn`（黄历/节假日）；模型（自然语言解析） | 混合 |
| automations | 自动化 | AutomationsApp-BBeEKtV2.js | — | `/api/automations*`、`/api/automation-runs/:id/complete`、`/api/automations/claim\|parse` | `automations.ts`、`automationCatalog.ts`、`automationBusinessActions.ts`；表 `automations/automation_runs` | 模型（AI 指令）；音乐/系统动作 | 混合 |
| mcp | MCP 管理 | McpManager-B1sFnCJb.js | — | `/api/mcp/servers*`、`/api/mcp/import[/preview]`、`/api/mcp/test-agent`、`/api/mcp/call\|call-direct`、`/api/mcp/agent-tools\|search-tools` | `mcp.ts`；`data/mcp.json`、`mcp.system.json` | stdio 子进程 / Streamable HTTP MCP 服务器 | 混合 |

### 3.2 第 2 组（内容与媒体）

| id | 名称 | 前端入口（0.6.1 chunk） | 窗口/状态 | API 路由（要点） | 服务 / 表 | 外部依赖 | 归类 |
|---|---|---|---|---|---|---|---|
| skills | Skill | SkillsApp-BCwUvKLw.js | — | `/api/skills*`、`/api/skill-packs*`、`/api/skills/model-options`、`/api/skills/agent-tools` | `skills.ts`、`skillPacks.ts`、`skillImport.ts`、`skillAnalyzer.ts`；`data/skills.json`、`skill-packs/`、`server/bundled-skill-packages` | ModelScope（在线导入）；模型 | 混合 |
| market | 应用市场 | MarketApp-CvteOm7x.js | permissionManaged | `/api/market/explore\|apps/:id\|version\|developer-apps*\|developer-lab/*\|updates/check`、`/api/apps/:id/tools`、`/api/developer/docs*` | `marketplace.ts`、`appReleases.ts`、`appUpdates.ts`、`developerDocs.ts`、`developerApps.ts`；表 `app_market_releases/user_installed_apps/user_app_install_state` | `api.dx-os.com` | 云 |
| music | 音乐 | MusicApp-D__HK4w0.js | — | `/api/library/config\|tracks\|scan\|upload\|meta\|lyrics/:id\|stream/:id\|artwork/:id`、`/api/library/ai-classify-artists\|cache-artwork\|generate-artists-artwork\|scrape` | `library.ts`；`data/library.json/library-meta.json/library-tags.json/library-lyrics.json/library-artwork.json/artwork/` | `itunes.apple.com`、`api.deezer.com`；本地音乐文件夹 | 混合 |
| lingxing | 领星 | LingxingApp-yAmJyzNg.js | accessScope:external | `/api/lingxing/currency-rates\|mapping\|local-cache*[:广告/紫鸟]`、`/api/mcp/servers`、`/api/mcp/call-direct\|test-agent` | `lingxingLocalData.ts`、`lingxingMappings.ts`、`mcp.ts`；`data/lingxing-local.db`（6 表，复用 0.5.5） | `openmcp.lingxing.com`；`api.frankfurter.app`；紫鸟 | 外部云 |
| dingtalk | 钉钉 | DingTalkApp-Dh-WpOSD.js | accessScope:external | `/api/dingtalk/channels\|send\|agent/config\|agent/status\|agent/test-ai` | `dingtalk.ts`、`dingtalkAgent.ts`；`data/dingtalk.json`（AES-GCM） | `oapi.dingtalk.com`；dingtalk-stream | 外部云 |
| weather | 天气 | WeatherApp-BuEInuVW.js + shared weather-OxlcHzRl.js | showInDock:false | `/api/weather` | `weather.ts`（内存缓存） | `geocoding-api.open-meteo.com`、`api.open-meteo.com`、`nominatim.openstreetmap.org` | 云 |
| photos | 相册 | PhotosApp-B__Mar7O.js | multiInstance | `/api/photos/library\|sources*\|folders*\|source-file/:id\|source-thumbnail/:id\|import-image\|reverse-prompt\|source-features*\|source-related*\|background-removal*\|vision-models`、`/api/canvas[/asset-libraries]`、`/api/ai/models` | `photoSources.ts`、`photoLibraryIndex.ts`、`photoSourceVisualFeatures.ts`、`backgroundRemoval.ts`、`canvasAssetLibrary.ts`/`canvas.ts`（导入）；表 `photo_source_visual_features/photo_source_related_rankings`；`data/photos/`、`data/models/background-removal` | `api.dx-os.com`（抠图模型）；视觉/LLM 模型；onnxruntime 本地 | 混合 |
| text-editor | 文本编辑器 | TextEditorApp-Dmnh_tb_.js | multiInstance | `/api/fs/raw/:id`、`/api/fs/:id (PATCH)`、`/api/fs`、`/api/fs/upload` | `fs.ts`；`fs.json`+`blobs` | — | 本地 |
| trash | 废纸篓 | TrashApp-DGH8QGhk.js | — | `/api/fs/trash`、`/api/fs/trash/:id/restore`、`/api/fs/trash/:id`、`/api/fs/trash/empty` | `fs.ts`（`trashed/trashedTs` 软删） | — | 本地 |
| ziniao | 紫鸟浏览器 | 内联组件（无 chunk） | accessScope:external | `/api/ziniao/download-jobs*`、`/api/ziniao/download-control`、`/api/lingxing/local-cache/ziniao/*`、`/api/mcp/*` | `ziniaoDownloadJobs.ts`、`lingxingLocalData.ts`、`mcp.ts` | 紫鸟浏览器（Python MCP/webdriver）；Vendor Central | 外部云 |

### 3.3 第 3 组（画布 / 生成 / 开发）

| id | 名称 | 前端入口（0.6.1） | 窗口/状态 | API 路由（要点） | 服务 / 表 | 外部依赖 | 归类 |
|---|---|---|---|---|---|---|---|
| short-drama | 视频工坊 | ShortDramaApp-VJezH5SI.js | — | `/api/short-drama/projects*[:outline\|visual-design\|storyboards\|shots]`、`/api/fs` | `shortDrama.ts`；`data/short-drama-projects.json` + fs 目录 | 模型（剧本/图像编辑） | 混合 |
| comfyui | ComfyUI | dx-app（占位；本机已装 1.4.30） | —（复用基线未列 multiInstance） | `/api/comfyui/projects*\|workflows*\|workflow-runs*\|agent-workflows\|status\|bridge/version` | `comfyui.ts`、`comfyWorkflows.ts`、`comfyProjects.ts`、`comfyBridge.ts`；`data/comfyui.json`、`comfy-workflows.json` | 本地 ComfyUI 实例；随包工作流 | 本地 |
| canvas | 无限画布 | dx-app（占位；本机已装 1.0.288） | multiInstance | 见 §2（全部 `/api/canvas/*` + `/api/ai/tasks*` + `/api/fs/*` + `/api/agent/*` + `/api/skills/*`） | 见 §2 | 模型；Comfy/RunningHub/CLI；`api.dx-os.com` 云同步 | 混合 |
| snake | 贪吃蛇 | dx-app（占位） | — | `WS /api/snake/room` | `snakeCollab.ts`（内存房间） | — | 本地 |
| video-editor | Agent 剪辑 | VideoEditorApp-DbcIEgBe.js | multiInstance | `/api/video/media/probe\|assets\|projects/:id/assets\|render-jobs*\|file` | `video/videoStore.ts`、`renderPlan.ts`、`videoWorker.ts`、`mediaProbe.ts`、`posterCache.ts`；表 `video_projects/video_assets/video_render_jobs`；`data/video/` | 本机 ffmpeg | 本地 |
| ai-image-declaration | AI图片声明 | AiImageDeclarationApp-CqSwoMcj.js | permissionManaged | `/api/ai-image-declaration/process` | `aiImageDeclaration.ts`（sharp + ZIP + XMP/IPTC，无持久化） | — | 本地 |
| figma | Figma | FigmaApp-BpeiLJVQ.js | permissionManaged | `/api/figma/projects\|generate-vue[/:id]`、`/api/mcp/servers[/figma/enabled\|refresh]`、`/api/mcp/call-direct` | `figmaPreview.ts`、`mcp.ts`；`data/figma-previews`、`data/mcp.json` | figma.com（Framelink MCP：`npx figma-developer-mcp`）；模型 | 外部云 |
| illustrator | Illustrator | IllustratorApp-C2y_bzkg.js | permissionManaged | `/api/illustrator/config\|templates/:id/thumbnail`、`/api/local/{illustrator-previews,illustrator-exports,write-text,close-illustrator}`、`/api/mcp/*` | `illustratorConfig.ts`、`illustratorTempExports.ts`、`mcp.ts` | 本机 Adobe Illustrator；Illustrator MCP | 外部本地 |
| quark | 夸克网盘 | QuarkApp-wrpneGYt.js | accessScope:external | `/api/quark/status\|login\|logout\|browse\|search\|search-history[/clear]` | `quark.ts` + `vendor/quark-drive.cjs`；`data/quark` | 夸克网盘（子进程 CLI） | 外部云 |
| developer-studio | DX Developer | DeveloperStudioApp-BFL_9N-r.js | permissionManaged | `/api/market/developer-lab*`、`/api/market/developer-apps*`、`/api/developer/docs*`、`WS /api/developer-realtime` | `developerLab.ts`、`developerApps.ts`、`developerRuntime.ts`、`developerRealtime.ts`、`developerOAuth.ts`、`developerFileTransfers.ts`、`developerNetwork.ts`；`data/developer-apps/`；表 `app_credential_bindings/app_oauth_tokens/app_network_audit/app_runtime_events/app_exchanges` | 发布走 `api.dx-os.com` | 本地 |

### 3.4 逐应用补充（只列容易误判的）

- **agent vs tasks**：两者都用 agent 运行时，但 `agent`（贾维斯）走 `/api/agent/gateway/*` 全局流式网关；`tasks`（对话）走 `/api/tasks/*` 会话任务与 `/api/agent/tools`。0.6.1 前端两处都在 index chunk 与 Conversation chunk 的字面量中出现（观察）。
- **photos**：0.6.1 的相册已不是单纯图库：`/api/photos/sources`（本机目录登记 `data/photos/sources-*.json`）、`photo_source_visual_features`/`photo_source_related_rankings`（迁移 50/51）、`import-image` 导入画布或资产库、`reverse-prompt` 视觉反推、`background-removal` 本地 ONNX（模型从 `api.dx-os.com` 下载）。`/api/photocraft/*` 与 `/api/file-transfers/*` 由 DeveloperAppHost 里的 `dev-photocraft` 调用，**不属于**这 30 个内置应用（观察：dist index 中 `badge: b.id==="dev-photocraft"?"PS"`）。
- **ai-image-declaration**：前端确实调 `/api/ai-image-declaration/process`（chunk 字面量）；但 0.5.5 的 `routes-0.5.5.tsv:285` 已存在同一路由，而 0.5.5 报告称“纯前端本地处理”——两处证据冲突，是否 0.6.1 才改为后端处理**未确证**。
- **video-editor**：0.6.1 后端已有 `video_projects/video_assets/video_render_jobs` 真实表与 `/api/video/render-jobs`（本机 ffmpeg 渲染）；0.5.5 报告称 Agent 粗剪“等待 Action Runtime 接入”，本次未在 0.6.1 发现该运行时调用点的直接证据（未确证）。
- **developer-studio**：验证/安装/发布都经过本地 harness 与 `data/developer-apps`；市场的发布才触云。

---

## 4. 0.6.1 相对 0.5.5 的新增 / 变更

> 基线：`routes-0.5.5.tsv`（584 条）+ 0.5.5 报告 + `asar55/` 外壳源码。下表的「新增」是**静态提取差集**（0.6.1 用单引号路由；0.5.5 tsv 含 `${tool}` 模板路由，两边口径不同，条数只作方向性参考）。

### 4.1 路由

- 静态提取：0.5.5 **584** → 0.6.1 **648**；规范化 `:param` 后 added **70**、removed **8**。
- `removed` 的 8 条全是 `/api/cli/${tool}/*` 模板：0.6.1 仍在 `server/index.ts:2289-2296` 以模板字面量注册，属提取正则差异，**不是删除**。
- 新增分组（静态提取）：`/api/photos` 17、`/api/photocraft` 16、`/api/file-transfers` 5、`/api/app-exchange` 4、`/api/comfyui` 2、`/api/ocr` 2、`/api/system/fonts` 2、`/api/canvas` 2（另有零散 1 条级）。
- 重点新路由：`/api/ocr/providers`、`/api/ocr/recognize`、`/api/system/fonts[/:id]`、`/api/file-transfers*`、`/api/photocraft/*`、`/api/photos/{library,sources,folders,import-image,reverse-prompt,source-features,source-related,vision-models}`、`/api/app-exchange*`、`/api/desktop/proxy/detect`、`/api/canvas/asset-libraries/:id/sync-sources`、`/api/codex-canvas/relay`、`/api/auth/desktop-session`、`/api/comfyui/bridge/version`。

### 4.2 表（ccs.db migrations）

0.6.1 `ccsDb.ts` 最高 migration **54**；以下表在 0.5.5 报告的表清单中未出现（推断为 0.6.1 新增，未取得 0.5.5 源码逐条比对）：

| migration | 新表 | 用途 |
|---|---|---|
| 50 | `photo_source_visual_features` | 相册外部源图片的视觉特征缓存 |
| 51 | `photo_source_related_rankings` | 相似/相关排序结果缓存 |
| 53 | `photocraft_projects`、`photocraft_project_members` | 图像项目（dev-photocraft 后端）与成员 |
| 54 | `app_exchanges` | 应用间交换（请求去重 fingerprint + result_json） |

另：migration 47（0.5.5 已有）给 `canvases` 增加 `card_count/thumbnail`；0.6.1 的 `canvases` 结构与之相同。

### 4.3 应用

- 30 个内置应用 **零增删**；0.6.1 注册表仍为：agent、welcome、files、tasks、api-settings、accounts、settings、calendar、automations、mcp、skills、market、music、lingxing、dingtalk、weather、photos、text-editor、trash、ziniao、short-drama、comfyui、canvas、snake、video-editor、ai-image-declaration、figma、illustrator、quark、developer-studio。
- 前端承载方式：18 个 `*App-*.js` chunk + 7 个非 App 命名 chunk（Welcome/Files/Conversation/ApiSettings/Settings/Calendar/McpManager）+ 1 个内联于主包（agent）+ 3 个 dx-app 占位（canvas/comfyui/snake）+ 1 个内联组件（ziniao）= 30；0.5.5 报告也是同一分发形态。
- **非内置新增**：`dev-photocraft`（开发者应用，PS 徽标，宿主 DeveloperAppHost 内加载）使用 `/api/photocraft/*` + `/api/file-transfers/*`；这是 0.6.1 新增的后端域（迁移 53/54 与新路由可证）。`server/index.ts:1113-1149` 还显示宿主对 `dev-photocraft` 的运行时目录有原生产物分支（`.tmp/photocraft-v0.5.0/.../dist/web`，含 `photocraft-web_bg.wasm` 的补丁与 `snippets/` 资源），但本机 app.asar.unpacked 内**不存在** `.tmp/photocraft-v0.5.0`，且该 dx-app 本机未安装——前端细节未知。

### 4.4 协议

- **观察**：新增 PaddleOCR 原生协议适配 `paddleocr-vl`（`server/protocols.ts:287,2627`；`shared/ocr.ts:17-21` 定义 `PADDLE_OCR_PROTOCOL/MODEL/BASE_URL`；`server/protocol-engine/providerIdentity.ts:63` 按域名 `paddleocr.aistudio-app.com` 识别）。
- 协议引擎目录结构（validator/compiler/workflow/repository/transport/bindings/modelProfile/flags）与 0.5.5 一致；协议条目数量未按同一口径复算（**未知**）。

### 4.5 OCR

- 路由：`GET /api/ocr/providers`（返回 available/providers/local=false/maxBytes=32MB/maxPixels/boundingBoxes/modes=[detect,recognize]）、`POST /api/ocr/recognize`（multipart `image`，32MB 上限，全局限 4 并发、每用户 2，300s 超时）。
- 服务：`server/ocrRoutes.ts` + `server/ocr.ts`；协议 `paddleocr-vl`，模型 `PP-StructureV3`（兼容 `PaddleOCR-VL-1.6`），端点 `https://paddleocr.aistudio-app.com/api/v2/ocr/jobs`。
- 准入：必须已有启用且带 key 的 PaddleOCR provider，且通过 `apiModelAccessFilter` 与配额（`withDirectApiQuota(...,'ocr',...)`）。
- 前端：ApiSettings chunk 出现 `/api/v2/ocr/jobs` 与 `https://paddleocr.aistudio-app.com`（域名清单）；`index` chunk 另有 `FETCH /api/ocr/recognize`。

### 4.6 系统字体

- 路由：`GET /api/system/fonts`、`GET /api/system/fonts/:id`。
- 服务 `server/systemFonts.ts`：按平台扫描字体目录（macOS `/System/Library/Fonts`、`/Library/Fonts`、`~/Library/Fonts`；Windows `%WINDIR%/Fonts`、`%LOCALAPPDATA%/Microsoft/Windows/Fonts`；Linux 常见目录），只解析 SFNT/TTC name 表，≤64MB/字体、最多 10,000 文件、5 分钟缓存；id = sha256(path:size:mtime)，读取时二次 realpath + mtime/size 校验。
- 前端：DeveloperAppHost 与 Settings 都出现 `/api/system/fonts` 调用（`GET /api/system/fonts/:id` 取字节）。

### 4.7 文件传输

- 新路由：`POST /api/file-transfers`、`GET /api/file-transfers/:id`、`PUT /api/file-transfers/:id/chunks`、`POST /api/file-transfers/:id/complete`、`DELETE /api/file-transfers/:id`，以及 `POST /api/photocraft/projects/:id/save-bundle`。
- 语义：仅 purpose=`photocraft-save`，kind=`source`（image/vnd.adobe.photoshop）或 `preview`（image/png ≤16MiB）；创建时校验 `photoCraftSaveRevision`（版本变化 409）；分块上传带 `X-Chunk-SHA256`，每用户 2 并发 / 全局 16，超限 429；完成后 `transfers.use` 校验文件属于当前项目+revision 再发布。
- 存储：`data/file-transfers`（`DiskTransfers`）；前端由 DeveloperAppHost 调 `/api/file-transfers/*`。

### 4.8 CLI

- CLI 路由在 0.6.1 仍在 `server/index.ts:2218-2366`：`/api/cli/{jimeng,dreamina-canvas,pippit,codex,gemini}/*` 与模板 `/api/cli/:tool/{status,download-info,login/start,login/status,logout,help,models,chat}`。
- `server/agentCliTools.ts:73` 工具集仍是 `codex | gemini`；`server/cli-runtime/{jimeng,pippit,openai}` 随包。
- `server/claudecode/config.json` 存在（72 B，内容为 deviceId/platform；与 0.5.5 报告一致），本次未发现后端调用点（**观察**）。
- 结论：**CLI 在 0.6.1 未见结构性新增**；0.5.5 报告的“未发现 claude CLI”在 0.6.1 仍成立（未发现调用点）。

### 4.9 本机代理

- 新路由 `POST /api/desktop/proxy/detect`：仅 loopback 请求（`isLoopbackRequest`），返回候选代理与对 Google Gemini models 端点的探测结果，提示 requiresRestart。
- 服务 `server/localProxyDetection.ts`：候选=当前设置/env/macOS `scutil --proxy`/Windows 注册表系统代理 + macOS `lsof`、Windows `netstat.exe`+PowerShell 识别 VPN 进程（mihomo/clash/verge/v2ray/sing-box/shadowsocks/nekoray/hiddify/flclash/surge）的 loopback 监听；最多 12 个候选；探测用 Node 子进程带 `HTTP(S)_PROXY/NODE_USE_ENV_PROXY` 请求 `https://generativelanguage.googleapis.com/v1beta/models`。
- 前端：Settings chunk 出现 `POST /desktop/proxy/detect`。

### 4.10 外壳（app.asar）

- 新增根文件 `direct-update-fetch.cjs`（0.5.5 无）；`main.cjs` 87,182 B（0.5.5 82,935 B，+4,247 B）。
- preload 新增 4 个 IPC：`dx-desktop:clipboard-has-image`、`clipboard-read-image`、`clipboard-write-image`、`ensure-local-admin-session`；暴露成员 9→15 个（REA app.asar 记录：`exposed_api_members:15`、`ipc.main_handlers:13`）。
- `Resources/dxos-canvas-mcp.cjs` 559,990 B：0.5.5 已有（557,773 B），非 0.6.1 新增；`main.cjs` 仍通过 `DX_DESKTOP_MCP_BRIDGE` 指向它。

---

## 5. 未确证项（明确不声称）

1. **画布/ComfyUI/贪吃蛇的 dx-app 前端实现**不在 app.asar 内；画布前端行为来自本机已安装 1.0.288 包的静态阅读（运行态数据），不代表 0.6.1 一定分发该版本；其内部组件/状态机未逐行审计。
2. **0.5.5 的前端 dist 未留档**（只有 routes tsv、报告和外壳源码），因此「仅前端」的变化（文案、交互、样式、组件拆分）无法逐条 diff。
3. **路由条数 584/648、+70/−8 是静态提取口径**；模板路由与 `app.use` 前缀会造成差异，只能作方向性参考；未对每一条 added 路由做 0.5.5 的 `${}` 模板等价核对。
4. **协议条目数量**（0.5.5 报告 15 平台 + 18 模型）未按同一方法在 0.6.1 复算，故不给出数量差；只确证 `paddleocr-vl` 是新增适配。
5. **系统字体实际生效范围**（哪些应用能用系统字体渲染）、**OCR 真实识别质量**、**文件传输吞吐/断点续传实测**、**本地代理连通性**均未做运行时验证（本次禁止执行目标/联网）。
6. **画布媒体「文档引用即可见」与资产库 ACL 的交叉边界**（画布可见但无库权限时 `/api/fs/raw` 是否 403）为推断，未实测。
7. **ai-image-declaration 是否 0.6.1 才改为后端处理**：0.5.5 报告与 0.5.5 路由表相互矛盾，未确证。
8. **REA 覆盖限制**：app.asar 分析仅覆盖外壳（19 parse failures，364 条完整性矛盾标 observed-untrusted）；dist 分析 52/281 文件、semantic 族 partial、request 族 retained_relations=0（URL 动态），所以「路由调用关系」以源码字面量为准，REA 前端图只作模块级佐证。
9. **cloud（canvas-cloud / market / entitlement）** 的接口字段与错误码未逐项核对（不联网）。
10. **canvas.document_json 的单条上限**、1000 项资产库之外的容量限制、以及多实例画布窗口的状态同步细节未逐项验证。
