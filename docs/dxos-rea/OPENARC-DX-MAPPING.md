# DX OS 0.6.1 连通性 → OpenArc 域映射与缺口清单

> 只读对照分析。DX 侧证据来自 `docs/dxos-rea/` 三份 REA 产物（画布/应用矩阵、AI/组织）；OpenArc 侧证据来自当前工作树的源码 file:line。未改产品代码、未启动目标、未联网。

## 0. 范围、证据与快照

| 项 | 值 |
|---|---|
| DX 证据 | `CANVAS-APPS-CONNECTIVITY.md`（30 应用+画布连通性）、`app-connectivity-matrix.json`（机读）、`AI-ORG-CONNECTIVITY.md`（AI/组织 10 行结论+链路表） |
| OpenArc 证据 | 当前工作树：`electron/*.cjs`（268 个文件）、`electron/preload.cjs`（40 个顶层桥）、`src-vue/`（Vue 壳与应用）、`src/`（既有 React 域/画布/相册） |
| OpenArc 快照 | 2026-10-17 工作树，含并行未提交改动：`electron/model-resolver.cjs`、`electron/desktop-executor.cjs`、`src-vue/apps/{IntegrationsApp,OcrPanel,TransferCenter,DevApp}.vue`、`src-vue/bridge/domain.ts` 等；这些条目的状态以当前文件为准，可能随并行任务变化 |
| 状态口径 | `已实现`=等价实现（口径差异已注明）；`部分`=主能力存在但有明确缺口/依赖未装配；`缺失`=无实现；`不适用`=产品决定不移植（含明确 OUT） |

**统计（77 条连通关系）**：已实现 39、部分 35、缺失 0、不适用 3。应用一一对照（32 行，含 OpenArc 新增/合并项）见 §7。

三条总判断（观察/推断）：

1. **画布域“主链路已移植、口径未对齐”**：画布域文件几乎与 DX 同构（`canvas-domain.cjs`/`canvas-service.cjs`/`canvas-dxos-*`），素材库、协作、.dxcanvas、附件、Codex 桥、生成都有等价命令；但文档模型是 nodes/edges 而不是 DX 的 Card 三槽，插件运行期注册/执行、邀请码、云同步未移植。
2. **媒体/相册域完成度最高**：photos/photocraft/fileTransfer/ocr/systemFonts/localProxy/appExchange 七域在 0.6.1/0.6.2 名义下均有 domain+service+bootstrap，主进程按 `registerDomainOrDegrade` 逐域装配；缺口集中在“入口是否注册”“依赖是否注入”（如 docx/xlsx 解析缺依赖、image-studio 未注册、ComfyUI/贪吃蛇未移植）。
3. **市场/开发者与 DX 的形态不同**：OpenArc 只做本地 catalog + 在线更新（GitHub Releases/ModelScope 源 + 验签/回滚），没有 DX 的云市场目录/审核/灰度；开发者 OAuth/发布/灰度是**有意拒绝**（manifest 出现即拒），不是遗漏。

## 1. 画布与素材（DX §2 / matrix canvas）

| # | DX 连通关系（证据） | OpenArc 落点 | 状态 | 缺口 |
|---|---|---|---|---|
| A01 | 画布是 dx-app 包，由 DeveloperAppHost iframe + 运行时令牌加载（matrix canvas.frontend / CANVAS §2.1） | src-vue/apps.ts:35；src-vue/shell/WindowLayer.vue:218；src/canvas/CanvasHost.tsx；electron/preload.cjs:141-143 | 部分 | 画布以内置 React 岛屿（AI Studio）替代 dx-app 沙箱包，缺少运行时包安装/加载通路。 |
| A02 | Card 三槽 inputs/params/result/history + connections/viewport 的文档模型（CANVAS §2.1 / server/canvas.ts:111-175） | electron/canvas-domain.cjs:8-10；electron/canvas-domain.cjs:43-47；electron/canvas-domain.cjs:53-92 | 部分 | 文档是 nodes/edges/viewport/logs，不是 Card 三槽；DX 旧画布/.dxcanvas 需转换层。 |
| A03 | 17 个内置节点（16 个 builtin.* + director-3d）（CANVAS §2.6 / developer-canvas-builtins.cjs 头注释） | electron/canvas-domain.cjs:40；electron/developer-canvas-builtins.cjs:39-194 | 部分 | 命令层只有 10 类 card kind；DX 17 个 builtin.* 仅作清单校验数据，未进入画布运行期注册/执行。 |
| A04 | 素材库=developer_collab_projects(kind=asset-library)+fs 目录；CRUD/系统提示词保护（CANVAS §2.2 / server/canvasAssetLibrary.ts:20-261） | electron/canvas-dxos-asset-library.cjs；electron/canvas-dxos-commands.cjs:42-52 | 已实现 | 等价实现（库条目以 ResourceRef+引用计数代替 fs nodeId；系统提示词保护保留）。 |
| A05 | 引用方式=FS nodeId + /api/fs/raw/<nodeId> URL（CANVAS §2.2 / server/canvas.ts:18-43） | electron/canvas-dxos-asset-library.cjs:541；src/canvas/canvasAssetRefs.ts；electron/canvas-service.cjs | 已实现 | 等价口径：引用为不透明 ResourceRef/openarc-asset:，字节经 IPC/resource 域读取；未提供 /api/fs/raw 这类 HTTP URL。 |
| A06 | 画布/文件夹来源→素材库：sync-sources（owner-only、≤600、copyNode、sourceKey 去重）（CANVAS §2.2 / server/index.ts:5844-5873） | electron/canvas-dxos-commands.cjs:42-52 | 已实现 | 已实现：canvas/assetLibrary/syncSources（owner/可见性校验 + sourceKey 去重） |
| A07 | 库项新增/更新/删除/重命名/分组/封面/工作流克隆（CANVAS §2.2 / server/canvasAssetLibrary.ts:144-254） | electron/canvas-dxos-commands.cjs:42-52；electron/canvas-dxos-asset-library.cjs | 部分 | upsert/update/delete 已有；DX 的 sourceNodeId 复制、封面 data URL、workflow 递归重写等复合语义未逐项核对。 |
| A08 | 画布可见性 private/public/restricted + members（邀请码见 A09）（CANVAS §2.2 / server/canvas.ts:721-728） | electron/canvas-domain.cjs:315-331；electron/canvas-bootstrap.cjs:19-46 | 已实现 | 等价且更细（OWNER/SHARE 角色/ORGANIZATION 只读底线）；public=全员可编辑 与 ORGANIZATION=同组织只读 的语义差异需映射。 |
| A09 | 邀请码 XXXX-XXXX（只存 code_hash）+ redeem（CANVAS §2.5 / server/canvas.ts:1221-1276） | electron/canvas-dxos-commands.cjs:42-83 | 已实现 | 已实现：canvas/invites/get\|create\|revoke\|redeem（只存 sha256 + 末4位，明文只返回一次） |
| A10 | 资产库 visibility private/public/restricted + publicAccess + members(read/edit)（shared/canvasAssetLibrary.ts:74-86 / index.ts:3151-3153） | electron/canvas-dxos-asset-library.cjs:104；electron/canvas-dxos-asset-library.cjs:180-214 | 部分 | 资产库仅 PRIVATE/ORGANIZATION 两档，无 publicAccess 与逐成员 ACL。 |
| A11 | canViewCanvasMedia：画布文档引用的 nodeId 单独放行，不授予父目录（CANVAS §2.2 / server/canvas.ts:758-764） | electron/canvas-service.cjs；electron/canvas-dxos-asset-library.cjs:104 | 部分 | 画布侧未检出等价“文档引用即可见”放宽；媒体可见性主要走资源域授权，交叉边界未验证。 |
| A12 | WS /api/canvas/collab：presence/cursor/patch 广播，客户端仅 cursor 上行（CANVAS §2.5 / server/canvasCollab.ts:40-80） | electron/canvas-dxos-collab.cjs:239；electron/canvas-dxos-collab.cjs:314-338；electron/canvas-dxos-commands.cjs:54-62 | 部分 | 有同进程房间/事件/补丁命令，但无网络传输层（DX 用 WebSocket，跨机需局域网服务）。 |
| A13 | .dxcanvas 导出/导入（ZIP+canvas.json+assets，≤5000 文件/单 500MB/总 1GB）（CANVAS §2.4 / server/canvasPackage.ts） | electron/canvas-dxos-package.cjs；electron/canvas-dxos-commands.cjs:74-77 | 部分 | 有 package/export\|import（内联 ≤32MB）；DX 的 multipart 大包通道与 1GB 上限未等价。 |
| A14 | 云备份/同步 + canvas_cloud_sync_baselines + /api/canvas/cloud*（CANVAS §2.7 / server/canvasCloudSync.ts） | electron/canvas-dxos-commands.cjs:16 | 不适用 | 产品 OUT：本地部署 + 在线更新，不接 api.dx-os.com；DX 的画布云同步/云备份不适用 |
| A15 | 插件只来自开发者应用 manifest.canvas，注册表 registry.json + tombstone（CANVAS §2.6 / server/canvasPlugins.ts:62-135） | electron/developer-canvas-manifest.cjs:38-41；electron/developer-canvas-manifest.cjs:320-407；electron/developer-domain.cjs:424-458 | 部分 | 清单/内置节点/模板校验已移植；运行期插件注册表与插件节点执行未迁移。 |
| A16 | 插件数据 get/set/delete/list（host.storage.maxBytes）与插件网络白名单（CANVAS §2.6 / server/index.ts:3290-3303） | electron/developer-domain.cjs:223-280 | 已实现 | 已实现：canvas/plugins/data 与 canvas/plugins/network（pluginHost 在 main.cjs 装配） |
| A17 | 画布 14 个 canvas_* Agent 客户端工具（run/operate/execute/布局等）（CANVAS §2.6 / server/canvasKernelCapabilities.ts:25-67） | electron/canvas-dxos-capabilities.cjs:59-73；electron/agent-tool-catalog.cjs | 部分 | 有能力投影与 canvas/run/modelCall，但客户端工具集与 DX canvas_* 的语义/数量未对齐。 |
| A18 | Agent 附件读取：docx/xlsx/csv/text，PDF 不支持，≤40000 字符（CANVAS §2.6 / server/canvasAgentAttachments.ts:80-104） | electron/canvas-dxos-agent-attachments.cjs:6-13；electron/canvas-dxos-agent-attachments.cjs:38-85 | 部分 | docx/xlsx 因缺 adm-zip/exceljs 依赖被显式标为不可用（仅文本/CSV 可用）。 |
| A19 | Codex Canvas 桥：安装/配对/回环 API/AES-GCM 中继/MCP 文件（CANVAS §2.8 / server/index.ts:1191-1310） | electron/preload.cjs:393-400；electron/codex-canvas-bootstrap.cjs:25-31；electron/codex-canvas-relay.cjs:2,254 | 已实现 | 等价实现（IPC 命令 + 注入 dispatch 替代 HTTP；中继语义保留）。 |
| A20 | 画布生成任务：非 comfy/CLI→dx-ai-task/v2（protocol-tasks.db 三元组），产物落画布生成目录回传 MediaRef（CANVAS §2.3 / server/index.ts:5203-5209,3651-3690） | electron/canvas-service.cjs:770-950；electron/model-service.cjs；electron/task-service.cjs；electron/protocol-engine/index.cjs | 部分 | 走 model/task 域 + protocol-engine，但 DX 的 protocol-tasks.db 固定三元组与 legacy Comfy/CLI 分支未逐项等价。 |
| A21 | extract-audio/trim-audio/public-media 媒体工具（CANVAS §2.2 / server/index.ts:3827-3894） | electron/media-domain.cjs:149-152；electron/media-domain.cjs:415-436 | 部分 | 本地公共媒体映射/归一有；独立音频抽取/裁剪命令缺失（仅在渲染计划内 atrim）。 |

## 2. 媒体 / 相册 / 图像（DX matrix photos、music、video 等 + 0.6.1 五域）

| # | DX 连通关系（证据） | OpenArc 落点 | 状态 | 缺口 |
|---|---|---|---|---|
| B01 | 相册来源/虚拟文件夹/图库（matrix photos（/api/photos/sources\|folders\|library）） | electron/photos-domain.cjs:174-181；src-vue/apps/PhotosApp.vue | 已实现 | 等价实现（来源绝对路径只在主进程，IPC 回 base64/缩略图）。 |
| B02 | 图库按共享区可见性过滤（public/department/canvas/asset-library）（matrix photos + server/index.ts:6028-6036） | electron/photos-domain.cjs:180；electron/main.cjs:1451-1453 | 部分 | 仅 public/department 两态共享判定；DX 的 canvas/asset-library 共享区判定未等价。 |
| B03 | 视觉模型反推提示词（matrix photos（reverse-prompt/vision-models）） | electron/photos-domain.cjs:188-189；electron/photos-service.cjs | 已实现 | 等价实现（无供应商时结构化不可用）。 |
| B04 | 本地 ONNX 抠图（ben2-base，模型从 api.dx-os.com 下载）（matrix photos（background-removal + models）） | electron/photos-domain.cjs:190；electron/media-background-removal.cjs | 已实现 | 等价实现；模型下载源/云依赖与 DX 不同（是否仍走 api.dx-os.com 未核对）。 |
| B05 | 相册图片导入画布卡片/资产库（复制文件+定位+广播）（matrix photos（import-image→canvas\|library）） | electron/photos-domain.cjs:183；electron/main.cjs:1456-1459；electron/canvas-exchange-ports.cjs | 已实现 | 等价实现（importer=canvas-exchange 适配层，画布节点+素材库两落点）。 |
| B06 | photocraft 项目 + 分块文件传输（source/preview，revision 校验）（matrix photos + version_diff.file_transfer/photocraft） | electron/photocraft-domain.cjs:132-351；electron/file-transfer-domain.cjs:157；src-vue/apps/TransferCenter.vue | 部分 | 两域与传输中心已存在且可从访达进入；DX 的 dev-photocraft 等价物 image-studio 未注册为应用入口，appExchange 的 image.edit/receive target 可能不可达。 |
| B07 | PaddleOCR-VL OCR（providers/recognize，32MB，并发限制）（matrix api-settings（/api/ocr/*）+ 0.6.1 OCR） | electron/ocr-domain.cjs:94-354；electron/ocr-service.cjs；src-vue/apps/OcrPanel.vue；src-vue/apps/PhotosApp.vue:1591 | 已实现 | 等价实现；入口在相册内（PhotosApp.vue:1591 挂 OcrPanel），非独立应用。 |
| B08 | 系统字体清单/按 id 读字节（0.6.1 系统字体（/api/system/fonts*）） | electron/system-fonts-domain.cjs:91；electron/system-fonts-service.cjs；src-vue/settings/SystemFontsPanel.vue；src-vue/settings/AppearancePane.vue:462 | 已实现 | 等价实现并已挂设置›外观。 |
| B09 | 本机/系统/VPN 代理候选探测（默认探测 Gemini 端点）（0.6.1 本机代理（/api/desktop/proxy/detect）） | electron/local-proxy-domain.cjs:82；electron/local-proxy-service.cjs；src-vue/settings/LocalProxyPanel.vue | 已实现 | 等价实现且更严格：默认零出网，probe=true 才试连。 |
| B10 | 本地音乐库：扫描/曲目/歌词/封面/AI 整理（matrix music（/api/library/*）） | electron/media-domain.cjs:126-133；src-vue/apps/MusicApp.vue | 部分 | 扫描/曲目/歌词/封面写入有；DX 的 iTunes/Deezer 在线封面与 AI 整理后处理未逐项等价。 |
| B11 | 短剧项目/大纲/视觉设定/分镜/出图（matrix short-drama（/api/short-drama/*）） | electron/media-domain.cjs:104-125；electron/media-short-drama.cjs；src-vue/apps/DramaApp.vue | 已实现 | 等价实现（模型网关未注入时结构化不可用）。 |
| B12 | 视频项目/素材/渲染任务 + 成片文件（matrix video-editor（/api/video/*）） | electron/media-domain.cjs:76-100；electron/video-service.cjs；src-vue/apps/VideoApp.vue | 已实现 | 等价实现（ffmpeg 受监督子进程 + 租约/恢复）。 |
| B13 | AI 图片声明（XMP/IPTC，批量 ZIP）（matrix ai-image-declaration（/api/ai-image-declaration/process）） | electron/media-domain.cjs:139-144；electron/media-ai-image-declaration.cjs；src-vue/apps/DeclareApp.vue | 已实现 | 等价实现。 |
| B14 | 视觉特征 192 维 + 相关排序缓存（迁移 50/51）（matrix photos（source-features/source-related）） | electron/photos-domain.cjs:184-187 | 已实现 | 等价实现。 |
| B15 | Figma 预览/生成 Vue、Illustrator 模板/预览/导出（MCP 驱动）（matrix figma/illustrator（应用+媒体后端）） | electron/media-figma-preview.cjs；electron/media-illustrator.cjs；electron/plugin-registry.cjs | 部分 | 媒体辅助模块存在，但无 Figma/Illustrator 应用入口，插件注册表也未登记这两个 MCP。 |
| B16 | 公共媒体（本地/远端 URL 归一为生成输入）（CANVAS §2.2 / server/index.ts:3895-3986） | electron/media-domain.cjs:149-152；electron/media-public-media.cjs | 部分 | 本地公共媒体列出/URL/JPEG 归一有；DX 的远端抓取/上传语义未等价。 |

## 3. 应用与入口（DX 30 应用注册表 → OpenArc 25 应用）

| # | DX 连通关系（证据） | OpenArc 落点 | 状态 | 缺口 |
|---|---|---|---|---|
| C01 | 30 个内置应用注册表与分发形态（matrix apps[30] / app-connectivity-matrix.json） | src-vue/apps.ts:32-57；src-vue/shell/WindowLayer.vue:187-219 | 部分 | OpenArc 25 个应用（合并/新增/缺失见 appMatrix），不是 30 项一一对应。 |
| C02 | dx-app（dx-app/v2）运行时包分发与加载（matrix canvas.comfyui/snake；version_diff.apps） | electron/developer-domain.cjs:223-280；electron/developer-service.cjs；src-vue/apps/DevApp.vue | 部分 | 本地 dx-app 安装/回滚/凭据/出网有；画布宿主式 dx-app 加载容器（DX DeveloperAppHost）未见等价入口。 |
| C03 | 按应用开关拦截 API 前缀（providers/cli/dingtalk/market/comfyui/quark/…）（matrix 应用级闸门 requireAppOpen） | electron/preload.cjs:13-489；electron/authorization-bootstrap.cjs:23-29；electron/governance-bootstrap.cjs:53-60 | 已实现 | 等价安全边界：每域命令过 trusted(event)+sessionRef+授权；语义是能力授权而非“应用已打开”。 |
| C04 | 应用窗口实例/多实例/窗口几何/Dock/Launchpad（matrix 窗口/状态（window store）） | src-vue/shell/WindowLayer.vue；src-vue/stores/shell.ts；electron/window-domain.cjs | 已实现 | 等价实现（既有壳层 8 模块）。 |
| C05 | API 设置：供应商/协议/模型/CLI/RunningHub（matrix api-settings（路由/协议/模型）） | src-vue/apps/ProtocolApp.vue；src-vue/settings/ModelSettings.vue；electron/provider-protocol-domain.cjs；electron/model-service.cjs | 已实现 | 拆分到“协议中心 + 设置›模型”，能力等价；DX 的 cli 登录入口在 OpenArc CliPanel（未逐项核对）。 |
| C06 | 账户/部门/角色/App 授权（matrix accounts（/api/accounts/*）） | src-vue/apps/GovernanceApp.vue；electron/governance-bootstrap.cjs:30-61；electron/authorization-service.cjs | 已实现 | 等价且更细（资源授权/App 工具授权/审计）。 |
| C07 | 欢迎/文稿/项目/组织等基础入口（matrix welcome/text-editor/projects） | src-vue/apps/HomeApp.vue；src-vue/apps/NotesApp.vue；src-vue/apps/ProjectsApp.vue；src-vue/apps/GovernanceApp.vue | 已实现 | 以应用中心/文稿/项目/组织呈现，等价合并。 |

## 4. 市场与开发者（DX market / developer-studio）

| # | DX 连通关系（证据） | OpenArc 落点 | 状态 | 缺口 |
|---|---|---|---|---|
| D01 | 应用市场本地目录（随包/本地 catalog.json）（matrix market（本地注册表 + 内置包）） | electron/market-domain.cjs:44-52；electron/market-service.cjs:5,19-35；src-vue/apps/MarketApp.vue | 已实现 | 等价实现（只读本地 catalog，不联网/不安装）。 |
| D02 | 云端目录 api.dx-os.com/v1/market/explore、apps/:id、灰度发布、审核（CANVAS §2.7 / version_diff.market） | electron/market-service.cjs；electron/market-update-sources.cjs:1-20 | 部分 | 第三方目录/安装/回滚已实现（task-19）；云端市场目录/审核/灰度=产品 OUT；替代为本地 catalog + 第三方目录 + GitHub/ModelScope 在线更新 |
| D03 | 应用在线更新（发现/下载/验签/安装/回滚）（version_diff（应用更新/在线更新）） | electron/market-update-domain.cjs:61-66；electron/market-update-service.cjs；electron/market-update-sources.cjs | 已实现 | 等价实现（验签→摘要→解压围栏→原子切换→回滚；两源适配器）。 |
| D04 | dx-app/v2 安装/启用/禁用/回滚/清单校验/凭据绑定/出网判定/运行时事件（matrix developer-studio（开发者平台本地能力）） | electron/developer-domain.cjs:223-262；electron/developer-service.cjs；src-vue/apps/DevApp.vue | 已实现 | 等价实现（16 条基础命令 + 健康检查）。 |
| D05 | 开发者实验室草稿/模板/模拟安装/zip（matrix developer-studio（实验室/沙箱）） | electron/developer-lab.cjs；electron/developer-domain.cjs:272-280；src-vue/apps/DevApp.vue:39-42 | 已实现 | 等价实现（lab 命令族并入 developer:command 白名单）。 |
| D06 | 实时房间/协作项目邀请码/断线重放（matrix developer-studio（实时房间/协作）） | electron/developer-realtime.cjs:408-422；electron/developer-collab.cjs；src-vue/apps/DevApp.vue:279-301 | 已实现 | 等价实现，并有可选局域网入口（lanServer，需显式 authorize/ws）。 |
| D07 | 开发者 OAuth/PKCE、发布/审核/灰度、云市场字段（version_diff / developer-domain.cjs:30,39,519,545） | electron/developer-domain.cjs:30；electron/developer-domain.cjs:39；electron/developer-domain.cjs:519；electron/developer-domain.cjs:545 | 不适用 | 产品决定不开放：manifest 出现 oauth/publish/gray/rollout 即拒绝（不是遗漏）。 |
| D08 | 应用互传（targets/get/inspect/exchange/images），只传引用（matrix app-exchange（/api/app-exchange*）） | electron/app-exchange-domain.cjs:209-215；electron/app-exchange-domain.cjs:61-77；electron/preload.cjs:440-442 | 部分 | 5 条命令已移植；DX 的 dev-photocraft target 映射到 image-studio，但 image-studio 未注册为应用。 |
| D09 | Skill 包市场与在线导入（matrix market/skill-packs） | electron/market-domain.cjs:44-52；electron/skill-import.cjs；electron/skill-pack.cjs | 部分 | 本地 catalog skillPacks 与导入逻辑存在；在线来源/授权与 DX 的 ModelScope 在线导入未逐项核对。 |

## 5. 第三方集成（DX 钉钉/领星/紫鸟/夸克/天气/黄历/RunningHub 等）

| # | DX 连通关系（证据） | OpenArc 落点 | 状态 | 缺口 |
|---|---|---|---|---|
| E01 | 钉钉机器人/Stream Agent/OpenAPI（matrix dingtalk + plugin registrar） | electron/plugin-registry.cjs:125-150；electron/integration-dingtalk.cjs；electron/plugin-service.cjs:94-103；src-vue/apps/IntegrationsApp.vue | 已实现 | 等价实现（凭据安全存储，默认关闭）。 |
| E02 | 领星 ERP：官方 MCP + 本地 SQLite 缓存 + 广告报表 + 汇率（matrix lingxing） | electron/plugin-registry.cjs:208-232；electron/integration-lingxing.cjs；electron/integration-lingxing-local-data.cjs；electron/plugin-service.cjs:106-126 | 已实现 | 等价实现（云同步需注入 transport）。 |
| E03 | 紫鸟浏览器 VC 数据下载（Python MCP/webdriver）（matrix ziniao） | electron/plugin-registry.cjs:234-290；electron/integration-ziniao.cjs；electron/plugin-service.cjs:127-136 | 部分 | 作业/导入/恢复命令齐全，但依赖 python3+requests+selenium+openpyxl，缺依赖时结构化拒绝。 |
| E04 | 夸克网盘登录/搜索/浏览/上传/下载（CLI 子进程）（matrix quark） | electron/plugin-registry.cjs:292-314；electron/integration-quark.cjs；electron/plugin-service.cjs:140-153 | 已实现 | 等价实现（依赖 quark CLI 探测）。 |
| E05 | 天气与黄历在线查询（matrix weather/calendar（open-meteo/uapis.cn）） | electron/plugin-registry.cjs:151-205；electron/integration-weather.cjs；electron/integration-almanac.cjs；electron/weather-service.cjs | 已实现 | 等价实现（网络依赖缺省关闭，需显式开启插件）。 |
| E06 | RunningHub/ModelScope/Agnes 供应商与插件（matrix api-settings（RunningHub/ModelScope/Agnes）） | electron/plugin-runninghub.cjs；electron/plugin-modelscope.cjs；electron/plugin-agnes.cjs；electron/plugin-registry.cjs:340-408 | 已实现 | 以插件+供应商双形态存在；DX 的协议三元组/模型元数据口径未逐项核对。 |
| E07 | 第三方集成统一入口/健康/开关/审计（matrix integrations（前端入口）） | src-vue/apps/IntegrationsApp.vue:20-25；electron/plugin-registry.cjs:1-30 | 已实现 | 等价实现（默认全关、依赖探测、缺依赖结构化拒绝、仅显式测试才 probeNetwork）。 |

## 6. AI 与组织（DX AI-ORG 文档 → OpenArc agent/identity/authorization/governance）

> 说明：本节为**首版概要**。DX 侧依据 `AI-ORG-CONNECTIVITY.md` 的十行结论与 §2/§4 链路表；OpenArc 侧依据域文件与 preload 桥，逐条只判定“是否有等价实现”，未做行为等价验证（需运行/测试证据）。

| # | DX 连通关系（证据） | OpenArc 落点 | 状态 | 缺口 |
|---|---|---|---|---|
| F01 | 全局助理 Jarvis：Dock orb → agent gateway SSE（profile system-jarvis）（AI-ORG §2.1（Jarvis）） | electron/preload.cjs:166-173；electron/agent-service.cjs:533-700；src/projects/TaskConsole.tsx | 部分 | agent 域与任务控制台在 React 侧；Vue 壳层未检出 Jarvis 悬浮入口与 agent 桥调用。 |
| F02 | 对话 App：/api/agent/gateway/run-stream + 工具预取（AI-ORG §2.1（对话）） | src-vue/apps/ChatApp.vue:7-119；electron/task-service.cjs；electron/agent-runtime-manager.cjs | 已实现 | 等价口径：DX 走 /api/agent/gateway/run-stream+SSE，OpenArc ChatApp 走 task 运行时（task/run\|appendStep\|get + task:event，ChatApp.vue:18-119）。 |
| F03 | 项目文件助手：/api/projects/:id/converse，assistant/thinking/agent 三模式（AI-ORG §2.1（项目 Agent）） | electron/task-service.cjs；electron/task-harness-orchestrator.cjs；electron/project-agent-mode.cjs；src-vue/apps/ProjectsApp.vue | 部分 | 任务/项目域与 React 任务控制台存在；Vue 项目应用只接 resource 桥，Agent 入口待接。 |
| F04 | 第三方 App Agent：app.<id>.agent.run + capabilityBoundary 固定（AI-ORG §2.1（developer-app agent）） | electron/developer-domain.cjs:1021-1065；electron/agent-service.cjs；electron/developer-service.cjs | 部分 | App 清单可声明并投影 agent-tool，运行期 agent 入口与 DX 的 developer-app profile 未逐项对齐。 |
| F05 | dx-agent-request/v1 envelope + 5 个内置 profile 白名单/能力交集（AI-ORG §2.2（envelope/profile 准入）） | electron/agent-runtime-envelope.cjs；electron/agent-runtime-profiles.cjs；electron/agent-runtime-manager.cjs；electron/agent-contracts.cjs | 部分 | envelope/profile/准入分层存在；profile 集与能力边界是否 1:1 未逐项核对。 |
| F06 | toolCatalog 7 类（system/media/file/canvas/app/mcp/skill）+ x_dx_capability（AI-ORG §2.3（工具目录 7 类）） | electron/agent-tool-catalog.cjs；electron/tool-registry.cjs；electron/tool-adapters.cjs；electron/capability-discovery.cjs | 部分 | 工具目录与能力发现存在；7 类覆盖度与 schema 投影未逐条对齐。 |
| F07 | 客户端执行 open_app/music/画布/文件工具（AI-ORG §2.3（客户端执行器）） | electron/canvas-dxos-capabilities.cjs；electron/desktop-executor.cjs；electron/agent-builtin-tools.cjs | 部分 | 桌面执行端与画布能力存在；客户端执行器集合/回传 observations 语义未核对（desktop-executor 为并行新增文件）。 |
| F08 | capabilityRouter+modelResolver 有序链 + 一次回退 + autoFallback 开关（AI-ORG §2.4（模型路由回退）） | electron/capability-router.cjs；electron/capability-target-resolver.cjs；electron/progressive-capability-router.cjs；electron/model-resolver.cjs；electron/model-service.cjs | 部分 | 路由/回退代码存在；modelResolver 为并行新增（工作树未提交），能力依赖不可用问题由 task-3 收口中。 |
| F09 | interactionPolicy/confirmation 记录型审批（DX 服务端只记录不强制）（AI-ORG §2.5（审批/确认）） | electron/side-effect-domain.cjs；electron/side-effect-service.cjs；electron/dx-task-approval-bridge.cjs；electron/task-authority.cjs | 已实现 | 等价且更强制：审批网关 + 撤销 + 事件；DX 的“只记录”不是等价缺口。 |
| F10 | 监督子代理（深度/并行/每 Run 上限）+ 检查点/验收（AI-ORG §2.5（子代理/检查点）） | electron/agent-kernel-supervisor.cjs；electron/agent-checkpoint-contract.cjs；electron/agent-kernel.cjs | 部分 | 监督与检查点模块存在；深度/并行/每 Run 上限与 reviewer 门禁未逐项核对。 |
| F11 | auth.db 用户/部门/角色 + 会话（AI-ORG §4.1（账号/角色）） | electron/identity-service.cjs；electron/authorization-service.cjs；electron/local-account-service.cjs；src-vue/apps/GovernanceApp.vue；src-vue/identity/SetupScreen.vue | 已实现 | 等价实现（本地账号引导 + 治理端）。 |
| F12 | 部门/资源 scope（PERSONAL/DEPARTMENT/ORGANIZATION）（AI-ORG §4.2（部门/资源范围）） | electron/authorization-domain.cjs；electron/governance-service.cjs；electron/resource-domain.cjs | 已实现 | 等价实现（validateScope + 部门管理命令）。 |
| F13 | app_access_rules + app_permission_policies + 工具级权限（AI-ORG §4.3/4.4（App 授权/精细权限）） | electron/governance-bootstrap.cjs:53-60；electron/authorization-service.cjs；electron/identity-service.cjs | 已实现 | 等价且更细（grantAppAccess/getAppToolAccess/setAppStatus/审计）。 |
| F14 | api-quotas.db：部门×平台金额/次数、模型白名单、reserve/settle（AI-ORG §4.5（配额）） | electron/dxos-foundation-quota.cjs；electron/dxos-foundation-schema.cjs | 部分 | 本地配额账本（reserved→spent/released）存在；部门×平台规则/模型白名单与 DX 计量口径未逐项对齐。 |
| F15 | fs ownerId+共享区、画布 ACL、资产库 ACL、线程可见性、project_members（AI-ORG §4.6（数据隔离）） | electron/resource-domain.cjs；electron/canvas-domain.cjs:315-331；electron/integration-service.cjs；electron/authorization-store.cjs | 部分 | 各域各自实现隔离；跨域统一口径未逐表核对（integration-service 实际是 Projects/Canvas 集成服务）。 |
| F16 | 0.6.1 新增 ensureLocalAdminSession → /api/auth/desktop-session（AI-ORG §1 结论 9（桌面自动超管会话）） | src-vue/identity/SetupScreen.vue:16,135；electron/local-account-service.cjs；electron/preload.cjs:50-57 | 部分 | 本地账号/绑定流程存在；是否等价“桌面壳自动超管会话 + 短期 secret”未核对。 |
| F17 | api.dx-os.com Ed25519 权益、兑换码、席位/部门上限（AI-ORG §4.5/7.1（云权益/兑换/席位）） | — | 不适用 | 产品 OUT：本地部署形态无云账号/权益/兑换/席位链路 |

## 7. 30 个 DX 应用 → OpenArc 落点

| DX 应用 | OpenArc 落点 | 状态 | 说明 |
|---|---|---|---|
| 贾维斯（agent） | agent 域 + src/projects/TaskConsole.tsx | 部分 | Vue 壳无 Jarvis 悬浮入口/agent 桥调用 |
| 应用（welcome） | src-vue/apps/HomeApp.vue（应用中心） | 已实现 | 合并为应用中心 |
| 文件夹（files） | src-vue/apps/FilesApp.vue + openarc.files | 已实现 | 等价 |
| 对话（tasks） | src-vue/apps/ChatApp.vue + agent/task 域 | 已实现 | 走 task 运行时（task 桥），与 DX 的 agent gateway/SSE 口径不同 |
| API 设置（api-settings） | src-vue/apps/ProtocolApp.vue + settings/ModelSettings.vue | 已实现 | 拆分为协议中心+模型设置 |
| 账户管理（accounts） | src-vue/apps/GovernanceApp.vue + governance/authorization | 已实现 | 更细的资源/App/工具授权 |
| 系统设置（settings） | src-vue/settings/*（系统/外观/网络/字体/CLI/模型/协议） | 已实现 | 含 0.6.1 字体/代理/CLI 面板 |
| 日历（calendar） | src-vue/apps/CalendarApp.vue | 已实现 | 黄历走 integration plugin |
| 自动化（automations） | src-vue/apps/AutomationApp.vue + automation 域 | 已实现 | 等价 |
| MCP 管理（mcp） | src-vue/apps/McpCenter.vue + mcp 域 | 已实现 | 含工具审批开关 |
| Skill（skills） | src-vue/apps/SkillsApp.vue + skill 域 | 已实现 | 等价 |
| 应用市场（market） | src-vue/apps/MarketApp.vue + market/marketUpdate | 部分 | 本地目录+在线更新，无云市场目录/审核/灰度 |
| 音乐（music） | src-vue/apps/MusicApp.vue + media library | 部分 | 无在线封面/歌词抓取等 DX 后处理 |
| 领星（lingxing） | src-vue/apps/IntegrationsApp.vue + lingxing plugin | 已实现 | 并入第三方集成 |
| 钉钉（dingtalk） | src-vue/apps/IntegrationsApp.vue + dingtalk plugin | 已实现 | 并入第三方集成 |
| 天气（weather） | src-vue/apps/WeatherApp.vue + integration weather | 已实现 | 等价（插件需开启） |
| 相册（photos） | src-vue/apps/PhotosApp.vue + photos 域 | 已实现 | 来源/虚拟文件夹/反推/抠图/特征/导入 |
| 文本编辑器（text-editor） | src-vue/apps/NotesApp.vue + files writeText | 已实现 | 等价 |
| 废纸篓（trash） | src-vue/apps/TrashApp.vue + resource/files trash | 已实现 | 等价 |
| 紫鸟浏览器（ziniao） | src-vue/apps/IntegrationsApp.vue + ziniao plugin | 部分 | 依赖 python 包，缺依赖结构化拒绝 |
| 视频工坊（short-drama） | src-vue/apps/DramaApp.vue + media short-drama | 已实现 | 等价（模型需注入） |
| ComfyUI（comfyui） | （无应用入口） | 缺失 | 无 ComfyUI 应用/画布 comfy 节点执行链路 |
| 无限画布（canvas） | src/canvas/CanvasHost.tsx（ReactIsland）+ canvas 域 | 部分 | 见 A 组：Card 模型/插件/邀请码/云同步等缺口 |
| 贪吃蛇（snake） | （无） | 缺失 | 未移植 |
| Agent 剪辑（video-editor） | src-vue/apps/VideoApp.vue + media render | 已实现 | 等价 ffmpeg 渲染 |
| AI图片声明（ai-image-declaration） | src-vue/apps/DeclareApp.vue + media ai-declaration | 已实现 | 等价 |
| Figma（figma） | electron/media-figma-preview.cjs（模块） | 部分 | 预览模块存在；无应用入口、无 figma MCP 插件登记 |
| Illustrator（illustrator） | electron/media-illustrator.cjs（模块） | 部分 | 媒体模块存在；无应用入口 |
| 夸克网盘（quark） | src-vue/apps/IntegrationsApp.vue + quark plugin | 已实现 | 并入第三方集成 |
| DX Developer（developer-studio） | src-vue/apps/DevApp.vue + developer 域（70 命令） | 已实现 | 本地能力等价；发布/OAuth/审核为产品决定不开放 |
| 资源库（（新增）resource-library） | src-vue/apps/ResourceLibraryApp.vue + resource 域 | 已实现 | DX 的 fs+资产库能力的整合面 |
| 项目/组织/第三方集成/协议中心/浏览器/应用中心（（新增）projects/organization/integrations/protocols/browser/home） | src-vue/apps/*.vue | 已实现 | DX 对应能力拆分/整合，见 C 组 |

## 8. 缺口清单摘要

### 8.1 缺失（0 条）

> 0 条：A06/A09/A16 已由 task-16/task-12 关闭；A14、F17 按产品 OUT 记“不适用”；D02 的云市场审核/灰度子项同属产品 OUT（第三方目录/安装/回滚已实现）。


### 8.2 部分（35 条，按域）

- **画布**：A01 画布以内置 React 岛屿（AI Studio）替代 dx-app 沙箱包，缺少运行时包安装/加载通路；A02 文档是 nodes/edges/viewport/logs，不是 Card 三槽；DX 旧画布/.dxcanvas 需转换层；A03 命令层只有 10 类 card kind；DX 17 个 builtin.* 仅作清单校验数据，未进入画布运行期注册/执行；A07 upsert/update/delete 已有；DX 的 sourceNodeId 复制、封面 data URL、workflow 递归重写等复合语义未逐项核对；A10 资产库仅 PRIVATE/ORGANIZATION 两档，无 publicAccess 与逐成员 ACL；A11 画布侧未检出等价“文档引用即可见”放宽；媒体可见性主要走资源域授权，交叉边界未验证；A12 有同进程房间/事件/补丁命令，但无网络传输层（DX 用 WebSocket，跨机需局域网服务）；A13 有 package/export|import（内联 ≤32MB）；DX 的 multipart 大包通道与 1GB 上限未等价；A15 清单/内置节点/模板校验已移植；运行期插件注册表与插件节点执行未迁移；A17 有能力投影与 canvas/run/modelCall，但客户端工具集与 DX canvas_* 的语义/数量未对齐；A18 docx/xlsx 因缺 adm-zip/exceljs 依赖被显式标为不可用（仅文本/CSV 可用）；A20 走 model/task 域 + protocol-engine，但 DX 的 protocol-tasks.db 固定三元组与 legacy Comfy/CLI 分支未逐项等价；A21 本地公共媒体映射/归一有；独立音频抽取/裁剪命令缺失（仅在渲染计划内 atrim）
- **媒体**：B02 仅 public/department 两态共享判定；DX 的 canvas/asset-library 共享区判定未等价；B06 两域与传输中心已存在且可从访达进入；DX 的 dev-photocraft 等价物 image-studio 未注册为应用入口，appExchange 的 image.edit/receive target 可能不可达；B10 扫描/曲目/歌词/封面写入有；DX 的 iTunes/Deezer 在线封面与 AI 整理后处理未逐项等价；B15 媒体辅助模块存在，但无 Figma/Illustrator 应用入口，插件注册表也未登记这两个 MCP；B16 本地公共媒体列出/URL/JPEG 归一有；DX 的远端抓取/上传语义未等价
- **应用**：C01 OpenArc 25 个应用（合并/新增/缺失见 appMatrix），不是 30 项一一对应；C02 本地 dx-app 安装/回滚/凭据/出网有；画布宿主式 dx-app 加载容器（DX DeveloperAppHost）未见等价入口
- **市场**：D02 第三方目录/安装/回滚已实现（task-19）；云端市场目录/审核/灰度=产品 OUT；替代为本地 catalog + 第三方目录 + GitHub/ModelScope 在线更新；D08 5 条命令已移植；DX 的 dev-photocraft target 映射到 image-studio，但 image-studio 未注册为应用；D09 本地 catalog skillPacks 与导入逻辑存在；在线来源/授权与 DX 的 ModelScope 在线导入未逐项核对
- **集成**：E03 作业/导入/恢复命令齐全，但依赖 python3+requests+selenium+openpyxl，缺依赖时结构化拒绝
- **AI**：F01 agent 域与任务控制台在 React 侧；Vue 壳层未检出 Jarvis 悬浮入口与 agent 桥调用；F03 任务/项目域与 React 任务控制台存在；Vue 项目应用只接 resource 桥，Agent 入口待接；F04 App 清单可声明并投影 agent-tool，运行期 agent 入口与 DX 的 developer-app profile 未逐项对齐；F05 envelope/profile/准入分层存在；profile 集与能力边界是否 1:1 未逐项核对；F06 工具目录与能力发现存在；7 类覆盖度与 schema 投影未逐条对齐；F07 桌面执行端与画布能力存在；客户端执行器集合/回传 observations 语义未核对（desktop-executor 为并行新增文件）；F08 路由/回退代码存在；modelResolver 为并行新增（工作树未提交），能力依赖不可用问题由 task-3 收口中；F10 监督与检查点模块存在；深度/并行/每 Run 上限与 reviewer 门禁未逐项核对
- **组织**：F14 本地配额账本（reserved→spent/released）存在；部门×平台规则/模型白名单与 DX 计量口径未逐项对齐；F15 各域各自实现隔离；跨域统一口径未逐表核对（integration-service 实际是 Projects/Canvas 集成服务）；F16 本地账号/绑定流程存在；是否等价“桌面壳自动超管会话 + 短期 secret”未核对

### 8.3 已实现但口径不同（需在迁移/测试中注意）

- 画布素材引用：DX=`fs nodeId + /api/fs/raw`；OpenArc=`ResourceRef/openarc-asset:` + IPC/resource 域（A05）。
- 画布权限：DX=`public=全员编辑 / restricted=成员`；OpenArc=`OWNER/SHARE 角色 + ORGANIZATION=同组织只读`（A08）。
- 鉴权边界：DX=登录 Cookie + `requireAppOpen` 应用闸门；OpenArc=每域 `trusted(event)` + `sessionRef` 主进程注入 + 授权服务（C03）。
- 审批：DX 的 interactionPolicy/confirmation 服务端只记录；OpenArc 是审批网关（可撤销、可审计），属加强而非缺口（F09）。
- 市场：DX=云目录/审核/灰度；OpenArc=本地 catalog + GitHub/ModelScope 更新（D01-D03）。

## 9. 未确证与限制

1. OpenArc 工作树有并行未提交改动（`model-resolver.cjs`、`desktop-executor.cjs`、多个 Vue 应用、`bridge/domain.ts`），本清单是**快照**；相关条目的状态可能随并行任务完成而变化。
2. 本对照是**静态映射**：只证明“文件/命令/桥存在”，未运行任何 OpenArc 命令或测试，不声称行为等价、性能等价或 UI 等价。
3. DX 侧“AI/组织”以 `AI-ORG-CONNECTIVITY.md` 为准（其本身为 REA/源码阅读，部分链路标注未知）；本节 F 组只做概要判定，未逐条复算 DX 的 profile/能力边界。
4. 部分 OpenArc 文件注释已声明“OUT/不实现”的边界（云同步、publicMedia 上传、dxosProtocol 云 AI），本清单按其自述判为缺失/不适用，未验证是否被其它路径补偿。
5. 前端可达性按“文件存在 + 挂载点”判断：OcrPanel 挂在相册（PhotosApp.vue:1591）、TransferCenter 挂在访达（FilesApp.vue:540）、SystemFonts 挂在设置›外观、LocalProxy 挂在设置›网络；未注册为独立应用/未接桥的（如 image-studio、ComfyUI、Snake）按部分/缺失记。
6. 计数口径：77 条连通关系 + 32 行应用对照；D07 为“不适用”，不进入“缺失”统计。

## 10. 机读清单

同目录 `openarc-gap-list.json`：`meta`（证据/快照/口径）、`statusCounts`、`items[]`（id/area/dx/dxSummary/openarc[]/status/gap/confidence）、`appMatrix[]`（dxApp/dxName/openarc/status/note）。