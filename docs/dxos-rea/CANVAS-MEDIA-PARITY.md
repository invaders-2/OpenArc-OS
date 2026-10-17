# 画布 / 媒体语义对照审计：OpenArc ↔ DX OS 0.6.1

> 任务：task-31（只读审计，不改产品代码）。产出：本文件。
> 范围：A02 / A03 / A07 / A10 / A11 / A15 / A17 / A18 / A20 / A21 / B02 / B15 / B16 / D09 / E03。
> 基线：OpenArc 工作树 HEAD `83340b0`（另含未提交的 `electron/media-domain.cjs`、`media-service.cjs`、`media-store.cjs` 等）；DX OS 0.6.1 随包源码 `app.asar.unpacked/server|shared|src`。
> 方法：只读静态阅读（源码 + 既有测试）；未启动应用、未执行目标、未联网。结论区分「观察（源码字面量）」与「推断（未运行验证）」。

## 0. 证据口径与分类

- DX 证据：`…/runtime-0.6.1-…/DX OS.app/Contents/Resources/app.asar.unpacked/{server,shared,src}` 的 file:line；复用 `docs/dxos-rea/CANVAS-APPS-CONNECTIVITY.md`（下称 CANVAS 报告）中的观察。
- OpenArc 证据：`electron/*.cjs`、`src-vue/*`、`src/*`、`tests/*` 的 file:line。
- 分类：
  - **已等价**：DX 语义在 OpenArc 有可执行等价实现（允许实现载体不同，语义一致）。
  - **需补**：DX 语义在 OpenArc 缺一部分或不等价，需要写代码。
  - **环境依赖**：代码路径在，但缺本机依赖/凭据/外部程序，当前如实结构化不可用。
  - **不适用**：产品决定 OUT（或 DX 云/商业化能力），不要求等价。

**总体结论（15 项）**：已等价 0；需补 13（A02/A03/A07/A10/A11/A15/A17/A20/A21/B02/B15/B16/D09）；环境依赖 2（A18/E03）。其中 A07/A11/A15/A17/B02/B16/D09 有「部分子能力已等价」，见各节。

## 1. 总览

| 缺口 | 域 | 分类 | 一句话结论 |
|---|---|---|---|
| A02 | 画布文档模型 | 需补 | 运行期文档仍是 nodes/connections/viewport/logs；Card 三槽只在 .dxcanvas/互传转换层出现。 |
| A03 | 内置节点 | 需补 | 17 个 builtin.* 仅作清单校验数据；运行期注册/执行未移植。 |
| A07 | 素材库复合语义 | 需补 | sourceNodeId/封面/分组/提示词版本已等价；workflow 内媒体递归复制未做。 |
| A10 | 素材库 ACL | 需补 | 仅 PRIVATE/ORGANIZATION 两档；无 publicAccess 与逐成员 read/edit。 |
| A11 | 画布媒体可见性 | 需补 | fs 共享区「文档引用即可见」已在互传端口落地；画布 ResourceRef 读取未放宽。 |
| A15 | 画布插件 | 需补 | 数据/网络已由 task-16 落地；插件注册表 registry.json 与 execute 未移植。 |
| A17 | canvas_* 工具集 | 需补 | 18 个工具映射到本仓命令面；与 DX 的 14 个 canvas_* 不是 1:1。 |
| A18 | Agent 附件 docx/xlsx | 环境依赖 | 缺 adm-zip/exceljs，docx/xlsx 结构化拒绝；文本/CSV 可用。 |
| A20 | 生成任务三元组 | 需补 | 走 ModelService/TaskService；DX 的 ai_protocol_tasks 三元组表存在但无写入方。 |
| A21 | 音频抽取/裁剪 | 需补 | 仅渲染计划内 atrim；无独立 extract-audio/trim-audio 命令。 |
| B02 | 相册共享区 | 需补 | 仅 public/department:；canvas:/asset-library: 两区不进入图库。 |
| B15 | Figma / Illustrator | 需补 | 媒体辅助模块在；无应用入口、插件注册表未登记两个 MCP（Illustrator 另需本机 Adobe）。 |
| B16 | 公共媒体 | 需补 | 本地列表/URL/JPEG 归一已等价；远端抓取/上传被显式移除。 |
| D09 | Skill 在线来源 | 需补 | 本地 skillPacks 与 zip 导入已等价；ModelScope 在线安装器未注入。 |
| E03 | 紫鸟下载 | 环境依赖 | 作业/导入/恢复命令齐全；依赖 python3+requests+selenium+openpyxl+transport。 |

## 2. 画布语义

### A02 · 画布文档模型（Card 三槽）

**DX 语义（观察）**：文档不变量是「一张 Card = 输入图 inputs + 参数 params + 结果 result」，result 独立槽、绝不自动进 inputs；另有 history、connections、viewport，见 `server/canvas.ts:10-11`、CanvasCard/CanvasDocument 定义 `server/canvas.ts:111-175`。保存为 `canvases.document_json`（`:221`）。

**OpenArc 现状（观察）**：运行期文档口径仍是 `{ nodes, connections, viewport, logs }`，见 `electron/canvas-domain.cjs:8-10`；命令层是 node.add/edit/move/copy/delete/group、edge.connect/disconnect、undo/redo（`:24-31`）；单次生成的结果不写回卡片 result/history，而是落 `canvas_run_facts.result_json`（`electron/canvas-service.cjs:1056-1073`；`canvas-store.cjs:54,76-77`）。
**已有转换层**：.dxcanvas 打包/导入时按 DX 的 cards/inputs/result/history 语义收集引用并重映射（`electron/canvas-dxos-package.cjs:17-19,65`）；相册/互传建卡走 `canvas-exchange-ports.cjs:119-137,343-358`。

**差异**：DX 旧画布与 .dxcanvas 的 Card 三槽只在包边界/互传边界被「临时转换」，运行期没有 Card 槽位；因此「result 绝不自动进 inputs」「history 多版本」这类不变量没有载体，画布内多轮生成结果只能靠 run 记录查询。

**需改文件**：`electron/canvas-domain.cjs`（文档/命令模型）、`electron/canvas-service.cjs`（run 结果写回与视图）、`electron/canvas-dxos-package.cjs`（双向转换）、`tests/`（文档不变量与转换往返）。
**验收点**：① 同一卡片连续两次生成的 result 槽等于第二次、history 保留第一次；② 把 result 复制进 inputs 只能显式操作，任何 run 完成事件都不自动追加 inputs；③ .dxcanvas 导出→导入后 Card 三槽与源一致（含 history 长度）；④ 旧 nodes 文档读取不破坏。
**分类：需补。**

### A03 · 17 个内置节点运行期注册/执行

**DX 语义（观察）**：`src/apps/canvas/builtinCanvasNodes.ts:14-146` 定义 16 个 `builtin.*` + director-3d（`nodes/director3d/definition.ts:4`）共 17 个；`:148-151` 的 `registerBuiltinCanvasNodes` 把它们注册进编辑器 `CanvasNodeRegistry`，`:153-174 builtinNodeTypeForCard` 负责卡片→节点类型推断。

**OpenArc 现状（观察）**：17 个定义已逐字移植为**纯数据**（`electron/developer-canvas-builtins.cjs:24-194`），只用于开发者清单校验；文件头明确登记「registerBuiltinCanvasNodes / builtinNodeTypeForCard 依赖 CanvasNodeRegistry / CanvasCard，属编辑器运行期，未移植」（`:19-25`；同 `developer-canvas-manifest.cjs:29-31`）。命令层只有 10 类 card kind（`canvas-domain.cjs:40`），画布运行时无节点注册表/插件节点执行入口。

**差异**：清单校验「能通过」，但画布运行期不认识 `builtin.*` 节点类型，也没有按节点端口/执行器跑节点的能力；DX 的 17 个节点无法在画布里创建/执行。

**需改文件**：新增 canvas 节点注册表（建议 `electron/canvas-node-registry.cjs`）、`electron/developer-canvas-builtins.cjs`（暴露运行期定义）、`electron/canvas-domain.cjs`（节点类型与命令）、`electron/canvas-service.cjs`（执行分派）、`tests/`。
**验收点**：① 17 个 builtin 类型全部可注册并按 manifest 端口校验；② 创建 `builtin.image-generator` 卡片能跑一次生成并回填 result；③ 未注册类型 / 端口不兼容被结构化拒绝；④ 插件节点与 builtin 同一注册路径。
**分类：需补。**

### A07 · 素材库复合语义

**DX 语义（观察）**：库项 upsert 的复合语义在 `server/canvasAssetLibrary.ts:144-244`：`sourceNodeId` 复制文件（`:206-211`）、`coverDataUrl` 落成本地封面（`:213-217`）、workflow 内媒体递归复制并重写 nodeId/url（`materializeWorkflowMedia`，`:113-143`）、prompt 版本历史、relation*/group 字段、系统提示词不可删。

**OpenArc 现状（观察）**：已实现大部分——`sourceNodeId` 解析并导入资源域（`electron/canvas-dxos-asset-library.cjs:473-530`）、`coverDataUrl` 落 cover Ref（`:442-458,504-512`）、group/relation 字段与 prompt 版本历史（`:439-463`）、系统提示词不可删（文件头 `:14-16`）；另有本仓增强 `syncSources`（`:372-416`，命令 `canvas/assetLibrary/syncSources`，`canvas-dxos-commands.cjs:50`）。
**差异**：`workflow` 直接存原值（`canvas-dxos-asset-library.cjs:462`），没有 DX 的 workflow 媒体递归复制/重写；workflow 里引用的媒体不会复制到库目录，源文件删除后工作流失效。

**需改文件**：`electron/canvas-dxos-asset-library.cjs`（workflow 媒体 materialize）、`tests/`。
**验收点**：① upsert kind=workflow 时，workflow.cards[].inputs/result/history 中的媒体被复制并重写为库内 ResourceRef；② 源资源被删除后，工作流仍能打开；③ 无权限媒体整单拒绝；④ 非 workflow 不受影响。
**分类：需补（仅 workflow 媒体递归一个子项；其余已等价）。**

### A10 · 素材库 visibility/publicAccess/逐成员 ACL

**DX 语义（观察）**：资产库是 `developer_collab_projects(app_id='canvas',kind='asset-library')`，`visibility private|public|restricted` + `publicAccess read|edit` + `members(read/edit)`；共享设置 `PATCH /assets-libraries/:id/members`（`server/canvasAssetLibrary.ts:257-268`；`shared/canvasAssetLibrary.ts:74-86`；`server/developerCollabProjects.ts:87-100`）。

**OpenArc 现状（观察）**：`CanvasAssetLibraryService.#access` 只认 owner 可编辑、`visibility==="ORGANIZATION"` 且同组织只读（`electron/canvas-dxos-asset-library.cjs:111-115`）；`createLibrary/updateLibrary` 把 visibility 归一为 PRIVATE/ORGANIZATION 两值（`:197-226`）；store 里只有 libraries/items 两张表，没有 members/publicAccess 列（`electron/canvas-dxos-store.cjs:16-30`）；命令表无 members 命令（`canvas-dxos-commands.cjs:44-55`）。

**差异**：无 public/restricted、无 publicAccess、无逐成员 read/edit；组织可见是粗粒度「同组织只读」。画布本身的「查看者/编辑者/管理共享」三档（本仓新提交）没有延伸到素材库。

**需改文件**：`electron/canvas-dxos-asset-library.cjs`、`electron/canvas-dxos-store.cjs`（members 表/列）、`electron/canvas-dxos-commands.cjs`（members 命令）、`tests/`。
**验收点**：① owner 可设 visibility=private/public/restricted 与 publicAccess；② restricted 时仅成员可见，成员分 read/edit；③ 非成员访问返回 NOT_FOUND_OR_FORBIDDEN（不泄露存在性）；④ 画布 ACL 与库 ACL 不同源时各按各的规则。
**分类：需补。**

### A11 · 画布媒体「文档引用即可见」放宽

**DX 语义（观察）**：`canViewCanvasMedia` 只对**画布文档实际引用的 nodeId** 放行，且明确不授予父目录或相邻文件权限（`server/canvas.ts:48-52` 注释、`:748-764`）；fs 读取经 `shareZoneOf → canSeeShare`，`canvas:` 区调用它（`server/index.ts:6028-6036,6064-6071`）。

**OpenArc 现状（观察）**：fs 节点侧已有等价实现——`canViewCanvasMedia(nodeId, view.c, canvasId)` 在 `canvas-exchange-ports.cjs:398-402`，并被 `canRead` 用于 `canvas:` 共享区（`:418-423`）；photos/app-exchange 的导入路径用它。**但画布文档的媒体身份是资源域 ResourceRef**，`canvas-service.readAsset` 只认「应用授权 OR 资源 owner」（`electron/canvas-service.cjs:1174-1191`，`:1186` ASSET_FORBIDDEN），没有「本画布文档引用了该 nodeId/resource 就放行」的等价放宽。

**差异**：本仓模型里画布引用的是 ResourceRef 而非 fs nodeId，因此 DX 的放宽规则要么映射到资源授权（需自动 grant/判定），要么在 readAsset 增加「画布文档引用集合」判定；当前没有。

**需改文件**：`electron/canvas-service.cjs`（readAsset 引用判定）、`electron/canvas-exchange-ports.cjs`（引用集合复用）、`electron/main.cjs`（如需注入 canRead）、`tests/`。
**验收点**：① A 把资源共享给画布后，B 能按画布打开该媒体；② B 不能读取同目录/相邻未引用资源；③ 从文档移除引用后 B 立即不可读；④ 未共享画布仍 403。
**分类：需补（fs 节点路径已等价，ResourceRef 路径缺）。**

### A15 · 画布插件运行期注册表与执行

**DX 语义（观察）**：`rebuildCanvasPluginRegistry` 遍历开发者应用 `manifest.canvas`，读 nodeManifests/templateManifests 注册进 `CanvasNodeRegistry`，落 `data/canvas-plugins/registry.json`，无安装记录保留 tombstone（`server/canvasPlugins.ts:62-135`）；执行 `POST /api/canvas/plugins/execute` 按 executor.type 分派 skill/mcp-tool/agent-tool/workflow，`app-bridge` 409、`builtin` 403（`server/index.ts:3304-3325`）；插件数据/网络见 `:3290-3303`。

**OpenArc 现状（观察）**：清单/模板/内置节点/端口兼容校验已移植（`electron/developer-canvas-manifest.cjs:38-41,320-427`；`developer-domain.cjs:450-452`）；**插件数据与受控网络已落地**（`electron/canvas-dxos-plugins.cjs:1-17`；命令 `canvas/plugins/data|network`，`canvas-dxos-commands.cjs:72-73`；main 装配点 `main.cjs:1206,1223`）。但**没有**注册表（registry.json/tombstone）、没有 `canvas/plugins/execute`、没有运行期 `CanvasNodeRegistry`（全仓 grep 无 `CanvasNodeRegistry` 实现，仅注释引用）。

**差异**：插件「数据/网络」可用，但插件节点既不能注册也不能执行；DX 的 skill/mcp-tool/agent-tool/workflow 四类执行器不可达。

**需改文件**：新增 canvas 插件注册表模块（registry.json/tombstone/启停）、`electron/canvas-dxos-commands.cjs`（list/execute 命令）、`electron/developer-canvas-manifest.cjs`（注册数据源）、`tests/`。
**验收点**：① 安装声明 `manifest.canvas` 的开发者应用后 registry.json 出现插件，卸载后转 tombstone；② execute 按 executor.type 分派且 builtin 403/app-bridge 409；③ 未启用插件不可执行；④ 注册表重建幂等。
**分类：需补（数据/网络部分已等价）。**

### A17 · canvas_* Agent 客户端工具集

**DX 语义（观察）**：`server/canvasKernelCapabilities.ts:25-67` 产出 14 个工具：3 个动态（`canvas_create_node` / `canvas_operate_node` / `canvas_execute_node`，枚举已安装节点 manifest 的 nodeType/operation/action）+ 11 个静态（`canvas_run_workflow`、`canvas_compose_workflow`、`canvas_rename_node`、`canvas_move_node`、`canvas_resize_node`、`canvas_group_nodes`、`canvas_ungroup_nodes`、`canvas_connect_nodes`、`canvas_disconnect_nodes`、`canvas_delete_nodes`、`canvas_arrange`）。

**OpenArc 现状（观察）**：`electron/canvas-dxos-capabilities.cjs:33-53` 登记 **18** 个工具（read/create_node/edit_node/move_node/copy_node/delete_nodes/group_nodes/connect_nodes/disconnect_nodes/undo/run_generation/stop_generation/asset_library.list|import|reference/agent_attachments.list|mount|unmount），文件头说明「OpenArc 没有 manifest operation/action，把静态工具表映射到真实存在的画布命令，做不到的不列出」（`:9-20`）；命令投影见 `canvas-dxos-commands.cjs:75` `canvas/capabilities/list`。

**差异**：数量 18 vs 14；命名不同（`canvas.read` vs `canvas_rename_node` 等）；DX 的 create/operate/execute 依赖节点 manifest 的 nodeType/operation/action 枚举，本仓没有 manifest 运行期，故这三个工具在 OpenArc 不存在对应动态枚举；反过来 OpenArc 多出素材库/附件/undo/生成停止等工具。

**需改文件**：`electron/canvas-dxos-capabilities.cjs`（工具表/语义对齐）、`electron/agent-tool-catalog.cjs`（目录投影）、`tests/`。
**验收点**：① 工具清单数量与命名与 DX 对齐（或文档化差异白名单）；② 每个工具都有可执行命令与 risk/sideEffects；③ 无对应能力的工具不登记（不造假）；④ 能力发现（capability discovery）能列出画布工具。
**分类：需补（不是 1:1，能力覆盖有重叠）。**

## 3. 媒体 / 生成语义

### A18 · Agent 附件 docx/xlsx 解析

**DX 语义（观察）**：`server/canvasAgentAttachments.ts:80-104` 抽取文本：文本类按 BOM 解码（`:23-34`）、docx 用 adm-zip 抽 `word/document.xml`（`:47-52`）、xlsx/xlsm/csv 用 exceljs（`:54-72`）、PDF 明确不支持；单文件 40k 字符（`:5`）、整体 80k（`server/index.ts:3814-3819`）、12 文件 × 20MB（`:3797-3800`）。

**OpenArc 现状（观察）**：文本/CSV/JSON/代码可用；`.docx/.xlsx/.xlsm` 被显式标为「当前构建未包含该解析依赖」并结构化拒绝（`electron/canvas-dxos-agent-attachments.cjs:13-14,84-91`）；`package.json` 无 adm-zip/exceljs，`node_modules` 也没有（本次 grep/ls 为空）。文件头说明这是硬约束（不新增依赖）下的如实降级（`:15-20`）。

**差异**：docx/xlsx 不可解析；其余（文本、CSV、截断预算、PDF 拒绝、挂载语义）已等价。

**需改文件**：`electron/canvas-dxos-agent-attachments.cjs`（接入解析器注入）、`package.json`（只有产品允许新增依赖时）。
**验收点**：① 有依赖时 docx/xlsx 抽取正文；② 无依赖时仍返回结构化 parseError 而非空内容；③ 40k/80k/20MB 上限与截断标记；④ PDF 明确拒绝。
**分类：环境依赖（依赖缺失；代码路径已如实处理）。**

### A20 · 画布生成任务三元组

**DX 语义（观察）**：非 comfy/CLI 的画布生成被包装成 `dx-ai-task/v2`（`extensions.protocolExecutionMode='agent'`），任务落 `protocol-tasks.db` 的 `ai_protocol_tasks / ai_protocol_task_events / ai_protocol_artifacts`；产物下载/校验后写「画布数据/<canvasId>/生成结果」fs 节点并 `saveBlob`，回传 MediaRef（`server/index.ts:5203-5209,3651-3690`）。任务行固定携带 provider/model protocol 的 id/version/hash + profile_id + intent（三元组）。

**OpenArc 现状（观察）**：画布生成走 `CanvasService.modelCall`（`electron/canvas-service.cjs:897`），依次权限→run→任务停止态→预算→TaskService 记账→ModelService；产物解析为资源域 ResourceRef（`readAsset` 口径）。DX 的三张 `ai_protocol_tasks` 表**结构已存在于** `electron/dxos-foundation-schema.cjs:272-275`，但全仓没有写入方（本次 grep `ai_protocol_tasks` 只命中 schema/注释）。

**差异**：任务存储与产物落点语义不同（本仓 Task/Model 域 + 资源域 vs DX 协议任务表 + fs 生成目录）；三元组（protocol id/version/hash、profile、intent）没有固定承载。

**需改文件**：`electron/canvas-service.cjs`（生成提交/结果映射）、`electron/protocol-engine/*`（任务三元组读写入）、`electron/dxos-foundation-schema.cjs`（如需要索引）、`tests/`。
**验收点**：① 一次画布生成能写入 ai_protocol_tasks 且三元组完整；② 事件表按 sequence 落库；③ 产物 sha256 去重且回传 ResourceRef；④ 失败/取消状态可查询；⑤ 与既有 Task 记账不双写冲突。
**分类：需补。**

### A21 · 音频抽取 / 裁剪 / 公共媒体工具

**DX 语义（观察）**：`POST /api/canvas/media/extract-audio`（视频→音频，`server/index.ts:3827-3852`）与 `POST /api/canvas/media/trim-audio`（start/end，≤3600s，`:3854-3873`），产物由 `saveCanvasDerivedAudio` 落画布派生媒体；公共媒体上传在 `:3895-3986`（见 B16）。

**OpenArc 现状（观察）**：`media-domain.cjs` 命令表只有 `media/public-media/list|url|normalize`（`:155-157`），没有独立的 extract/trim 音频命令；音频裁剪只出现在渲染计划内部（`media-service.cjs:537-543` 的 ffmpeg `atrim` 链），不对外提供命令/产物。

**差异**：画布不能「把视频抽音轨」「裁一段音频」生成新媒体；只能整体进渲染。

**需改文件**：`electron/media-domain.cjs`（命令登记）、`electron/media-service.cjs`（ffmpeg 抽取/裁剪 + 结果落盘）、`tests/`。
**验收点**：① extract-audio 仅接受视频、产物为音频资源引用；② trim-audio 校验 start/end/≤3600s/仅音频；③ 无编辑权限 403；④ 产物进资源域且可预览。
**分类：需补。**

### B02 · 相册共享区判定

**DX 语义（观察）**：图库按共享区可见性过滤，`shareZoneOf → canSeeShare` 覆盖 `public`、`department:`、`canvas:`、`asset-library:` 四类；`canvas:` 调 `canViewCanvasMedia`，`asset-library:` 调 `canvasAssetLibraryAccess`（`server/index.ts:6028-6036,6064-6071`；`server/canvas.ts:748-764`）。

**OpenArc 现状（观察）**：`photos-service.defaultShareAccess` 只认 `public` 与 `department:`，其余一律 false（`electron/photos-service.cjs:311-318`）；宿主装配时 `shareAccess: null`（`electron/main.cjs:1596-1600`），注释明确「本仓没有以 (user, share) 为形状的独立共享判定服务，不新造一套」。dxos-fs 侧已有 `shareZoneOf` 与 `canvas:`/`asset-library:` 标记能力（`electron/dxos-fs.cjs:835-843,845-860,862-...`）。

**差异**：画布共享区与素材库共享区的照片不会出现在图库；DX 的四区判定未等价。

**需改文件**：`electron/photos-service.cjs`（defaultShareAccess 扩展或注入）、`electron/main.cjs`（装配 shareAccess，复用 canvas-service/exchange 判定）、`tests/`。
**验收点**：① public/department/canvas/asset-library 四类共享照片均出现在有权限用户图库；② 无权限用户列表不含、按 id 读取 403；③ 画布移除共享后立即不可见；④ 私有照片不外泄。
**分类：需补（public/department 已等价）。**

### B15 · Figma / Illustrator

**DX 语义（观察）**：Figma 应用（`FigmaApp` chunk）走 `/api/figma/*` + Framelink MCP（`npx figma-developer-mcp`）；Illustrator 应用走 `/api/illustrator/*` + `/api/local/{illustrator-previews,illustrator-exports,...}` + Illustrator MCP，本机 Adobe 为外部依赖（CANVAS 报告 §3.3：193-194 行）。MCP 注册在 `data/mcp.json`。

**OpenArc 现状（观察）**：后端辅助模块已在——Figma 预览构建/抓取（`electron/media-figma-preview.cjs:28-108`）、Illustrator 配置/缩略图/临时导出（`electron/media-illustrator.cjs:35-...`），命令 `media/figma-preview/files|build`、`media/illustrator/config/get|update`、`media/illustrator/temp-export/prepare|cleanup`（`electron/media-domain.cjs:136-143`）。但：① `apps.ts` 无 figma/illustrator 应用入口；② `plugin-registry.cjs` 未登记 figma/illustrator MCP（本次 grep 无命中）；③ 旧 React 有 Adobe 入口，Vue 壳层无。

**差异**：无前端入口、无 MCP 注册；Illustrator 还需本机 Adobe（环境依赖）。

**需改文件**：`electron/plugin-registry.cjs`（两个 MCP 登记/依赖探测）、`src-vue/apps.ts` + 新应用组件或设置入口、`electron/media-domain.cjs`（如需新命令）、`tests/`。
**验收点**：① 设置/应用里能看到 Figma/Illustrator 入口并显示依赖状态；② 未装 MCP/Adobe 时结构化不可用；③ 有依赖时预览/导出链路能跑；④ 出网走既有白名单。
**分类：需补（Illustrator 另含环境依赖）。**

### B16 · 公共媒体（远端抓取/上传）

**DX 语义（观察）**：`POST /api/canvas/public-media` 支持 service=apimart/runninghub/free/dxos，把本地输入素材上传到外部图床/云并回传 URL，带进度接口 `/api/canvas/public-media-progress/:requestId`（`server/index.ts:3895-3986`）；`server/publicMedia.ts:1-84` 含 `normalizePublicImageForApimartVideo`、`verifyDirectMediaUrl`、`uploadCanvasFreeMedia`（litterbox）。

**OpenArc 现状（观察）**：只保留本地部分——本地公共媒体目录/相对 URL 映射 + `normalizePublicImageForApimartVideo`（`electron/media-public-media.cjs:1-80`）；远端直链校验与 litterbox 上传被整段删除并标注 `PUBLIC_MEDIA_UPLOAD_REMOVED = true`（`:1-23`）；命令 `media/public-media/list|url|normalize`（`media-domain.cjs:155-157`）。

**差异**：本地归一/列表已等价；远端抓取与上传（外部图床/云）缺失。按本仓既有口径，这类外发能力属产品 OUT；若要 DX 同款则需补，并需产品确认外发。

**需改文件**（仅当确认要补）：`electron/media-public-media.cjs`、`electron/media-service.cjs`、`electron/main.cjs`（出网白名单/凭据）、`tests/`。
**验收点**：① 本地 list/url/normalize 与今天一致；② 若补远端：上传成功回传 URL、失败结构化、进度可查、域名白名单；③ 不把绝对路径/凭据过 IPC。
**分类：需补（远端）；本地部分已等价；“远端上传”建议按产品 OUT 改不适用（待决策）。**

### D09 · Skill 包市场与在线来源

**DX 语义（观察）**：Skill 市场/包：`/api/skill-packs*`；`server/skillPacks.ts:439-474` 的 `importOnlineSkillPack` 支持 ModelScope 在线安装（spawn npx），`:65-99` 解析在线来源；市场矩阵见 CANVAS 报告 §3.2（skills 行，172）；本地 `data/skills.json` + `skill-packs/` + 随包 `bundled-skill-packages`。

**OpenArc 现状（观察）**：本地能力已等价——`market-domain.cjs:48-49` 的 `market/skillpacks/list|get` 读本地 catalog.json 的 `skillPacks`（`:182-214`）；`skill-pack.cjs` 支持 ZIP 导入/导出/校验与 `parseOnlineSkillSource`（`:307-340`，纯字符串解析，不联网）；**在线安装未实现**：`importOnlineSkillPack` 需要注入 `runner.onlineInstaller`，未注入即 `AGENT_DEPENDENCY_UNAVAILABLE`（`:818-822`），文件头写明「ModelScope 在线安装（spawn npx，联网）改注入 runner；本文件不发起网络请求（OUT：云端）」（`:23-28`）。

**差异**：本地市场条目与 zip 导入已等价；在线（ModelScope）安装/授权未实现，只是结构化不可用。

**需改文件**：`electron/skill-pack.cjs`（在线安装器注入/网络）、`electron/skill-service.cjs`（命令接线）、`electron/market-domain.cjs`（如市场要展示在线来源）、`tests/`。
**验收点**：① 本地 skillPacks 列表/安装/卸载不变；② 在线来源 URL 解析正确；③ 未配置网络/安装器时结构化拒绝（不假成功）；④ 配置后可安装并校验来源与权限。
**分类：需补（本地部分已等价；在线属外发，需产品确认）。**

### E03 · 紫鸟浏览器 VC 下载

**DX 语义（观察）**：紫鸟应用内联组件走 `/api/ziniao/download-jobs*`、`/api/ziniao/download-control`、`/api/lingxing/local-cache/ziniao/*`，底层是紫鸟 Python MCP/webdriver（CANVAS 报告 §3.2：181 行；`server/ziniaoDownloadJobs.ts`）。

**OpenArc 现状（观察）**：命令齐全——`integration/ziniao/status|jobs/list|jobs/current|jobs/start|jobs/control|jobs/delete|jobs/recover|vc/files|vc/import|vc/rows`（`electron/plugin-service.cjs:127-136`）；实现 `electron/integration-ziniao.cjs`；依赖在插件注册表声明为 python3（必需）、requests/selenium/openpyxl（可选）、凭据、网络（`electron/plugin-registry.cjs:234-290`）；缺依赖/未注入 transport 时结构化拒绝（命令表 `:130` 标注「需注入 transport」）。

**差异**：命令与依赖探测已等价；真实抓取依赖本机 Python 运行时、Selenium、紫鸟账号与 transport 注入——未配置时不可用（如实）。另：紫鸟前端入口在 Vue 壳层不存在（与 task-26 的「集成入口」相关，非本项核心）。

**需改文件**：通常无需改代码；若补前端入口 → `src-vue/apps.ts` + 集成页（跨 B15/E03 的入口工作）。
**验收点**：① 依赖缺失时 status/health 如实报告；② 作业创建/控制/恢复结构化错误；③ 有依赖时能真实下载并导入 VC XLSX；④ 不泄露凭据/绝对路径。
**分类：环境依赖。**

## 4. 状态漂移与任务归属

1. **本审计相对 `openarc-gap-list.json`（20:47 快照）的漂移**：
   - A06/A09/A16 已在 task-12/16 落地（`canvas/assetLibrary/syncSources`、`canvas/invites/*`、`canvas/plugins/data|network`，`canvas-dxos-commands.cjs:50,67-70,72-73`），不再按「缺失」处理。
   - A15 的「插件数据/网络」子项已完成（`electron/canvas-dxos-plugins.cjs`），只剩注册表/执行。
   - A07 的 sourceNodeId/cover/group/版本子项已完成（`canvas-dxos-asset-library.cjs:439-530`），只剩 workflow 媒体递归。
   - 本审计与 gap-list 的 15 条状态大部分一致；**新增证据**：A11 的 fs 节点放宽已落地（`canvas-exchange-ports.cjs:398-423`），A20 的 ai_protocol_tasks 表已在 schema 但无写入方。
2. **归属**：A02/A03/A07/A10/A11/A15/A17/A18/A20/A21 → task-25（pending）；B02/B15/B16/D09/E03 → task-26（pending）。本文件只读审计，任务状态未改。
3. **与总任务的关系**：task-25/26 的「先审计再补」以本文件为输入；具体实现项已在各节「需改文件」「验收点」。

## 5. 未确证项（不声称）

1. 未运行应用/未做 E2E：所有「已等价」均为静态语义判断，不代表运行时行为已验证。
2. 画布前端是 dx-app 外部包（DX 侧）：0.6.1 不随 asar 提供画布前端源码，A02/A03/A15/A17 的「运行期」行为为源码+注释推断（DX 侧为随包 server 源码观察）。
3. A11 的「画布可见但库不可读是否 403」在 DX 侧本身也是推断（CANVAS 报告 §5 第 6 条）；本仓未做运行时验证。
4. B16/D09 的远端/在线部分是否产品 OUT 未由本次审计决定；本文按「需补 + 待决策」记录。
5. 未检查所有测试文件是否已覆盖上述缺口；「验收点」是建议，不是现有测试的结论。
