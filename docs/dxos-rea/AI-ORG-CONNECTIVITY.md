# DX OS 0.6.1 全局 AI 与组织权限连通性（REA 复核）

> 任务：共享 task-1（rev 2）。目标：/Users/wepingli/Downloads/DXOS-Portable-0.5.1-mac-arm64/.dx-runtime/versions/runtime-0.6.1-c2699917-1363-460d-97c3-da88f6d3fbe5/DX OS.app/Contents/Resources/app.asar
> 产出范围：docs/dxos-rea/ 下方；本文只做只读逆向分析，不含实现建议，不声称观察到任何执行行为。

## 0. 证据基线与标注约定

### 0.1 工件与路径

| 工件 | 路径缩写 | 事实 | 证据 |
|---|---|---|---|
| Electron 壳 app.asar | SHELL | SHA-256 f14ed0a66f5ca0b5c3e244c37b25ca0fb663b7cade445cbe0a1feacee96d7933；format=asar；REA 统计 relevant_files 6502、text_bytes 83,324,302、parsed_javascript_files 936–1552（多次留存记录）、IPC literal channels 13、main handlers 13、preload entrypoints 1、browser windows 2 | 【观察】REA ev_501ab896b74854e3c2f890b52d3a26578a0ede727e97fed6e020d56c40ec7f18（summary 视图）；交叉记录 ev_67fa657047e2ef4ad47f50a0dfc9851454f4e610302641f2b7fb4238b7668212、ev_bdc8a14851bd7134bba3dbad5c70275444ef5173d4cf6c00d2d21b9285e66dd6、ev_c7071ae57cfde65961a2b4712ffe65fc30b4bf89518bc729c99397d5a5e002d3 |
| asar 成员/完整性图 | SHELL | inventory_artifact 与 inspect_artifact 各留存一份完整记录 | 【观察】REA ev_aea49337a1ff99d102c499da86fd9de0d57bc0e227ed9dc4b21a9d300f99ebe0、ev_b95a3cb387a5334a2f02b2c4ec13dc7783b3ec8b118584b763bb1dcdd7be344f |
| 前端构建产物 dist/ | DIST = U/dist | SHA-256 36c57d6ba263406c75711f30f4ba55b22113a1baea12080a4f836e69b632bf6b；52 个 relevant files、49 个 JS、0 解析失败 | 【观察】REA ev_9178e6af633b32894db81e4f74448e4aec964b1db5678e9116b61ce73e9c8217（及视图记录 ev_027b5212ad469dd229d30e481460d34a1f5d756844aa155d0d14e8e3d25d778a） |
| 后端 TypeScript 源码 | U = .../Resources/app.asar.unpacked | 152 个顶层条目、137 个 .ts（含 server/index.ts 631,672 B）；不属于 app.asar 打包内容 | 【观察】源码阅读（非 REA Evidence），U/server/index.ts:1 起；目录与文件尺寸由本地只读列目录得到 |

标注：本文【观察】= 代码/字节可直接读到；【推断】= 由结构合理推出；【未知】= 本次未取得证据。凡以 U/ 开头的 file:line 都是“随包 TS 源码阅读”，不是 REA Evidence；REA Evidence 只覆盖 app.asar、dist 与 asar 成员图。

### 0.2 关键结构前提（决定本文证据类型）

- 【观察】0.6.1 的 app.asar 只打包 Electron 外壳：asar header 共 16,405 个条目，其中 16,387 个为 unpacked 依赖闭包；真正 packed 的仅 18 个文件（main.cjs、preload.cjs、proxy.cjs、cloud-compatibility.cjs、compat-update-fetch.cjs、direct-update-fetch.cjs、portable-*.cjs、update-*.cjs、path-encoding.cjs、package.json 与 5 个 assets 图标）。字节层面：packed 内容合计 520,352 B；app.asar 文件 4,763,200 B，其余为 asar header JSON（含完整性清单）。
- 【观察】后端 server 不是 asar 内容，而是同目录 app.asar.unpacked/server 的 TS 源码；SHELL/main.cjs 以 runtime 内 tsx 启动（main.cjs 形如 tsx: path.join(runtimeRoot, ...) 与 spawn(..., [tsx, entry])；模板字符串在 REA 提取件与 SHELL 的 main.cjs 中可见）。因此 AI/组织链路的主体是源码阅读，REA 图对外壳的 coverage 是 partial（见 0.3）。
- 【观察】前端 dist 是独立目录（U/dist），分析入口 index.html → assets/index-DJDR-kWU.js；应用为按 chunk 懒加载（Conversation、Files、Dock、AccountsApp 等 49 个 JS chunk）。
- 【观察】画布应用在 0.6.1 前端注册表中是 delivery: dx-app（index chunk 字符偏移约 144,072），即运行时安装的独立 APP 包，不在 dist 的 49 个 chunk 中；随包只带了 src/apps/canvas/*.ts 的共享运行时片段（120 KB）。

### 0.3 REA 覆盖与限制（必须与结论一起读）

- 【观察】REA 对 SHELL 的多次分析记录 coverage.application.status=partial、semantic.truncated=true，semantic budget 曾被压到 0/6380 字节；因此模块/关系图不是全量，本文不把“图里没有”当作“代码里不存在”。
- 【观察】REA 报出容器完整性矛盾（unpacked 条目声明哈希与落盘字节不一致），示例：node_modules/@babel/parser/package.json 声明 sha256=102f9938905803a03fee6a24a162e7966b6596cb8174427500d348eed3da88d0，实测 sha256=808c30900ff9e55aafff6361e55c21a39556bdcd2d349e0474fde1e985d855af；REA 返回 artifact_integrity_mismatch，用 integrity_policy=record-and-continue 后继续，并把此类条目记为 untrusted。REA 报文中注明“打包工具常在写入 asar 后重写 unpacked 文件”。
- 【观察】REA SHELL summary 的 electron.exposed_api_members=0、context_bridge_apis=0，但静态读取 SHELL/preload.cjs 可见 contextBridge.exposeInMainWorld('dxDesktop', {...}) 与约 20 个方法；两者矛盾，本文以 preload.cjs 字节为准，并把 REA 该字段视为识别/覆盖限制（未知）。
- 【观察】本次未对目标执行任何启动、联网或写操作；所有 REA 调用均为静态分析。
- 【观察】REA MCP 可用；对 4.7 MB app.asar 的 analyze_javascript_application 调用在 60 秒客户端超时（MCP 传输限制），但服务端随后完成并留存证据记录，可用 get_evidence_bundle(detail=summary) 发现、inspect_analysis_view 分页读取；因此本文引用的 asar 分析结果来自这些留存记录，而非重新运行。dist 的分析记录由同一 REA 会话留存（52 文件），可直接读取。

## 1. 十行结论

1. 0.6.1 的 app.asar 只是 Electron 壳 + 依赖闭包（真实 packed 文件 18 个），AI 与权限逻辑在随包 TS 源码 app.asar.unpacked/server；REA 对 asar 的图只可靠覆盖外壳（13 个 IPC 字面通道、1 个 preload、2 个窗口），所以本文 AI/组织结论以 U/ 源码为准。
2. 全局 AI 有 5 条正式入口 + 2 条快车道：Jarvis 悬浮助手（profile system-jarvis）、对话 App（conversation）、项目文件助手（project-assistant：assistant 即时 / thinking 后台 / agent 任务）、画布 Agent（canvas-agent）、第三方 APP Agent（developer-app 受控入口）；快车道是 /api/agent/step(-stream) 裸单步与 /api/ai/tasks 媒体任务提交。
3. 准入是 envelope + profile 双层：source.type/appId/entryPoint 必须命中 profile 白名单；能力再与 capsule.capabilityScopes、envelope.capabilityBoundary 取交集；actor.userId 由服务端会话强制覆盖（客户端传 current-session 无效）。
4. 工具统一由 U/server/toolCatalog.ts 汇总 7 类（system/media/file/canvas/app/mcp/skill），每个工具带 x_dx_capability（id/domain/intents），模型先调 capability_discover 才会看到具体工具；服务端负责把 V2 目标（provider/model/operation/参数 schema）回填进工具描述。
5. 执行分两域：服务端执行 media/file/skill/mcp/app(skill|mcp-tool|frontend-bridge)；客户端执行 open_app/music、画布全部工具、对话里的文件工具。客户端执行器在 DIST/assets/index-DJDR-kWU.js（字符偏移约 335,807 起）；画布真实执行器不在随包前端，属未知。
6. 模型路由由 capabilityRouter + modelResolver 生成有序链（缺能力数→满足数→偏好→模型 cap_sort→平台 sort→score），回退只包住一次推理；可回退错误含 408/409/425/429/5xx/超时/网络/模型不存在/图片数量限制；autoFallback 默认开，其开关路由 /api/providers/auto-fallback 无需登录。
7. 审批/确认服务端只记录不强制：interactionPolicy 写进 envelope 后无消费点；app 工具的 confirmation 只进入 ToolDescriptor；前端 localStorage 权限 store 只有 5 项（files.create/modify/delete、mcp.call、skill.run），且只在 Files/Conversation 等用户主动操作处调用 guard，Jarvis 工具循环未调用（静态代码未见，非运行证明）。
8. 组织由四层拼成：本地 auth.db（users/departments/roles + app_access_rules + app_permission_policies）、云端 Ed25519 签名权益（maxLocalAccounts/maxDepartments/departmentsEnabled/advancedAppPolicyEnabled）、api-quotas.db（用户/部门额度 + 部门模型白名单）、业务隔离（project_members、线程可见性、fs ownerId+共享区、画布 ACL、资产库 ACL）。
9. 0.6.1 最重要的组织/鉴权新增是“桌面壳自动超管会话”：main.cjs 生成 DX_DESKTOP_AUTH_SECRET 只注入 API 进程，前端启动时经 IPC ensureLocalAdminSession 调 POST /api/auth/desktop-session 换取 superadmin Cookie；0.5.5 报告未出现该链路。
10. 0.6.1 的项目 Agent 取消了步数/工具数硬上限，改为每 30 分钟一个“用户续跑窗口”，验证不通过会持续回退重跑；0.5.5 报告记录的是 maxSteps=18、单 Run 40 次工具、reviewAttempts≤2。

## 2. 全局 AI / 助理 / 对话 / 项目 Agent 链路

### 2.1 入口 → 路由 → 处理器（前端入口为 DIST 构建产物静态阅读）

| 入口（前端） | 触发/事件 | 请求 | 服务端路由/处理器 | 关键服务 | 表/持久化 | 证据 |
|---|---|---|---|---|---|---|
| Jarvis 全局助理：Dock 的 agent orb（DIST/assets/Dock-BFhmm1L8.js 偏移 2,245）→ 全局 overlay 组件（DIST/assets/index-DJDR-kWU.js 偏移约 338,190） | 用户提交目标文本 → 构造 envelope：source{type:desktop|automation, appId:agent, entryPoint:jarvis-overlay}、profileId system-jarvis、interactionPolicy confirm-risky、deliveryTarget desktop/jarvis；maxSteps:6；progressiveCapabilities.surface=Jarvis | POST /api/agent/gateway/run-stream（SSE） | requireAuth → agentGatewayContext（index.ts:7642）→ normalizeAgentRequestEnvelopeV1 → agentRunManager.prepare/create → serverAgentToolLoops.advance | agent-kernel/kernel.ts、progressiveCapabilityRouter.ts、capabilityTargetResolver.ts、modelFallback.ts | ccs.db agent_runs/agent_run_events/agent_usage_events（ccsDb.ts:631/655/845），checkpoint 事件 loop.checkpoint | 【观察】源码 index.ts:7750-7828、7642-7653；前端静态偏移（DIST index chunk @338,190）；【观察】REA DIST ev_9178… 证明该 chunk 属于被分析产物 |
| 对话 App：DIST/assets/Conversation-DB35y8Nt.js | 发送消息 → envelope：source{type:app, appId:tasks, entryPoint:conversation}、profileId conversation、interactionPolicy interactive；先 GET /api/agent/tools?source=system&executableOnly=1 预取 media_ 工具 | POST /api/agent/gateway/run-stream；工具可能由客户端执行后回传 | 同上（requireAuth → agentGatewayContext → RunManager → 服务端 tool loop） | conversation capsule 能力范围 system:*/media.*/skill:*/mcp:*（profiles.ts:23-26） | 同上 | 【观察】Conversation chunk @11,338-11,497、@9,119；index.ts:7750 起 |
| 项目文件助手：Files App 的 agent-panel（DIST/assets/Files-B0LBzpp0.js @3,684） | 选择 assistant/thinking/agent 模式后发消息 | POST /api/projects/:id/converse（index.ts:7292 → handleProjectConverse:7161） | projectActor → ensureShareMembership → requireProjectAccess(…,true) → mode 分支：assistant→runAssistantDirect；thinking→start_task → createProjectTask；agent→createProjectTask+RunManager.prepare | assistantDirect.ts / projectAgentMode.ts / worker.ts | ccs.db projects/project_members/threads/tasks/task_checkpoints/agent_runs（ccsDb.ts:23/31/46/98/132/631）；线程可见性 threads.visibility（taskStore.ts:1071-1073） | 【观察】index.ts:7161-7291；taskStore.ts:69-89、318-348；前端 POST /projects/:id/converse 于 DIST index chunk @299,612 |
| 画布 Agent：canvas 是 dx-app（不在 dist；随包仅 U/src/apps/canvas 共享片段） | Canvas 客户端以 profile canvas-agent / entryPoint agent-panel 走同一 gateway；工具为 canvas_* 客户端工具 | POST /api/agent/gateway/run-stream（ctx scope.canvasId）；客户端工具被暂停后由 Canvas 客户端执行并回传 observations | agentGatewayContext → capsule canvas-agent（profiles.ts:32-36）；gatewayAllowedToolNames 仅在 profile=canvas-agent 且 appId=canvas 时加入 CANVAS_CLIENT_TOOL_NAMES（index.ts:7679-7694） | canvasKernelCapabilities.ts 从实时 manifest 生成工具；画布 ACL 用 canvas.ts canvasAccess | ccs.db canvases/canvas_members/canvas_invites；fs share canvas:<id>（fs.ts:921-936） | 【观察】index.ts:7679-7694、canvasKernelCapabilities.ts:25-67、canvas.ts:721-738；【未知】Canvas 客户端执行器与 agent-panel UI 不在 app.asar/dist（dx-app 包运行时安装） |
| 第三方 APP Agent：/api/market/developer-apps/:id/agent/* | 宿主页面调用 tasks/runs 接口 | GET/POST /api/market/developer-apps/:id/agent/tasks（index.ts:10150-10210 区段） | requireAuth → developerAgentScope：APP 清单必须声明 app.<id>.agent.run 且 canOpenApp(user,appId) 通过；capabilityBoundary 固定 ['media.*','file:*','app:<id>:*']；envelope profileId developer-app、source.type app、entryPoint developer-app-bridge | RunManager.prepare 对 developer-app 只保留本 APP 的 app 工具（runManager.ts:92-101） | 每个 APP 独立项目根 ensureDeveloperProjectRoot；project_members 自动成员 | 【观察】index.ts:9979-9999、10150-10210、runManager.ts:92-101 |
| 裸单步快车道：Calendar 等 App 直接调 /agent/step（DIST/assets/Calendar-fmYVXHIK.js @23,502） | 一次性 function-call 解析（如 calendar_add_entry） | POST /api/agent/step（index.ts:7938）/api/agent/step-stream（index.ts:8049） | requireAuth → revealProvider/firstUsableProvider → chatWithTools；无 kernel/profile/能力发现/审批 | protocols.ts chatWithTools；/api/chat 与 /api/chat/stream 无鉴权（index.ts:2990、7607） | 无 Run 记录 | 【观察】index.ts:7938-7954、8049-8089、2990、7607 |
| 媒体任务快车道：Canvas/App 生成 | 提交 dx-ai-task/v1|v2 | POST /api/ai/tasks、/api/ai-tasks/generate、/api/canvas/generate（index.ts:5201-5209）；/api/ai-tasks 前缀 requireAuth（index.ts:1416） | handleAiTaskSubmitInternal：v2 先取 surface adapter 并 authorize（canvas→canEditCanvas；app/plugin/skill/comic/test→无操作）→ 选择 comfy/legacy/declarative/agent 执行 | ai-tasks/*、protocol-engine、capabilityTargetResolver | protocol-tasks.db ai_protocol_tasks/events/artifacts；legacy ai-tasks.db；api-quotas.db 预扣 | 【观察】index.ts:5033-5195、4447-4518 |

### 2.2 Envelope 与 Profile 准入（服务端强制）

- 【观察】请求契约：shared/agentRequestContract.ts:1-45（dx-agent-request/v1）；合法 source.type = desktop|project|app|automation|channel|api；interactionPolicy = interactive|non-interactive|confirm-risky；scope 含 projectId/canvasId/appWorkspaceId/knowledgeScopeIds；actor 含 userId/organizationId。
- 【观察】规范化：U/server/agent-runtime/envelope.ts:33-97；actor.userId 用登录用户覆盖（:60-64）；source.type=app 必须带 appId（:49）；goal 上限 20,000（:12）。客户端可传 organizationId（:63），服务端未做校验或使用（见 6 未知）。
- 【观察】内置 capsule：U/server/agent-runtime/profiles.ts:16-42 —— system-jarvis（desktop/automation，入口 jarvis-overlay，能力 system:*/media.*/file:*/skill:*/mcp:*/app:*，8 模型/32 工具）、conversation（app/tasks，入口 conversation，system:*/media.*/skill:*/mcp:*，8/24）、project-assistant（project/app，入口 project-assistant/project-converse，12/40）、canvas-agent（app/canvas，入口 agent-panel，media.*/skill:*/app:*，12/48）、developer-app（app，入口 developer-app-bridge，10/32）。
- 【观察】准备阶段：U/server/agent-runtime/runManager.ts:53-119。①profile 不存在→400；②入口/来源不在白名单→403（:58-66）；③developer-app 必须带 entryPoint（:61-63）；④developer-app 只保留 sourceId==本 appId 的 app 工具（:92-101）；⑤capabilityScopes 与 capabilityBoundary 双过滤 capabilities/toolDescriptors/tools（:102-114）。
- 【观察】gateway 另加两道：agentGatewayContext 拒绝 profileId=developer-app 直连（index.ts:7645-7647），要求 scope.projectId 有写权限（:7648），source.type=app 时 canOpenApp（:7649-7651）；gatewayAllowedToolNames 在 route 工具之外只额外放 capability_discover，system-jarvis 放 17 个客户端系统/文件工具名，canvas-agent 放 16 个画布工具名（index.ts:7671-7695）。

### 2.3 工具目录：注册、schema、选择、执行、前置条件（7 类）

统一入口：U/server/toolCatalog.ts:339-371（listToolDescriptors/toolCatalogSnapshot，actor 参与 app 工具授权）；工具元数据结构 ToolDescriptor（:14-37）；OpenAI function 包装与 x_dx_capability 生成（:47-64）。按来源拆分的执行路由在 runCatalogTool（:384-437）。

| 类别 | 注册来源/函数 | 工具名与 schema | 选择机制 | 执行位置 | 权限/前置条件 | 风险/副作用 |
|---|---|---|---|---|---|---|
| 系统（客户端） | toolCatalog.ts systemTools:70-128 | open_app（app 必填）、music_play（query/shuffle）、music_control（action 枚举） | capability_discover 暴露；intents app.open/music.play/music.control | 客户端：DIST index chunk 工具执行器 @335,807 起（open_app 用应用注册表打开；music_* 调音乐 store） | handler.type=client，runCatalogTool 明确拒绝服务端执行（toolCatalog.ts:387）；gateway 仅 system-jarvis profile 额外放行这 3 个名字（index.ts:7673-7677） | risk=read；sideEffects open:window/play:music/control:music |
| 媒体（服务端能力） | toolCatalog.ts capabilityTools:316-337，listSystemCapabilities()（skills.ts:526）；工具→capabilityId 映射 :288-306 | media_generate_image、media_midjourney、media_upscale_image、media_generate_video（7 个视频 intent）、media_edit_image、media_batch_image、media_describe_image、media_text_to_speech、media_transcribe_audio、media_generate_music | capability_discover → 服务端解析 V2 目标并回填参数 schema | 服务端 runCatalogTool → runSkill(skillId)（toolCatalog.ts:388-399）→ skills.ts runSkill:2099 → 协议引擎/原生适配器 | 能力定义 enabled；skill store 未停用（skills.ts:2110-2113）；withApiQuotaOwner 计费上下文（:2104）；模型由 resolveChatTarget/协议路由决定 | risk=external（image_describe/audio_transcribe 为 read）；sideEffects create:artifact、call:model-provider |
| 文件（服务端） | toolCatalog.ts fileTools:142-164 + agentTools.ts FILE_TOOLS:83-272 | fs_list/fs_read/fs_mkdir/fs_create/fs_write/fs_append/fs_edit/fs_rename/fs_move/fs_copy/fs_delete | capability_discover（intents file.read/write/delete）；schema 来自 FILE_TOOLS.parameters | 服务端 runTool（agentTools.ts:288-303） | 路径必须是项目根内规范相对路径（:53-60）；目标必须在 project root（:62-64）；系统共享文件夹不可改（:70）；写操作在 runId 场景过 assertRunWorkspaceWrite（:292-299，workspaceStore.ts:120-125） | risk read/write/delete；sideEffects write:files/delete:files；幂等判定 fs_create/fs_append（:136、179） |
| 画布（客户端） | canvasKernelCapabilities.ts:25-67，实时读取 BUILTIN_CANVAS_NODES + 插件 manifest | canvas_create_node（nodeType 枚举当前节点）、canvas_operate_node（operationId 枚举）、canvas_execute_node（actionId 枚举）、canvas_run_workflow、canvas_compose_workflow、canvas_rename/move/resize/group/ungroup/connect/disconnect/delete/arrange | 同上（intents canvas.*） | 客户端（handler.type=client）；真实执行器在 canvas dx-app，不在 dist/SHELL | 仅 canvas-agent + appId canvas 时进入 gateway 允许名（index.ts:7692-7694）；经 POST /api/agent/tools/:name/run 且 context.canvasId 时先 canEditCanvas（index.ts:7975-7978） | risk write/external/delete；sideEffects modify:canvas、call:model-provider、create:artifact |
| App（开发者 APP 声明） | toolCatalog.ts developerTools/appTool:203-236，来自 listDeveloperApps().capabilities.tools | 工具名由 APP 清单声明；inputSchema 来自声明 | capability_discover + app 域（domain=app.<id>） | 服务端 runCatalogTool：frontend-bridge 天气映射到 getWeather；skill→runSkill；mcp-tool→callDirect；app-api 无执行映射会抛错（:401-435） | 工具 enabled 需 serverStatus.executable 且 allowed（canUseAppPermission(actor, tool.permission)，:205）；执行前 ensurePermissions（:378-382） | 由 APP 声明 risk/sideEffects/confirmation（developerApps.ts:147、735-755） |
| MCP | toolCatalog.ts mcpTools:238-260；mcp.ts listServers:725-739、collectAgentTools:820-847 | mcp__<serverId>__<toolName>；schema 经 sanitizeJsonSchema | capability_discover（domain=mcp） | 服务端 callByName（mcp.ts:862-880）；客户端也可能直接 POST /mcp/call（DIST 执行器） | server.enabled 且 status=connected（toolCatalog.ts:240）；工具必须存在于 rt.tools（:183-186） | risk=external；sideEffects call:mcp |
| 技能 | toolCatalog.ts skillTools:262-286；skills.ts agentSkillTools:628-639 | skill__<skillId>；schema 来自 skill.inputSchema | capability_discover（domain=skill） | 服务端 runSkill：内置 kind 分派（image/video/audio/procedure…，skills.ts:2115-2125）；procedure 走内部小循环（:2234-2296） | 只暴露 exposure=agent 且 allowImplicitInvocation!==false（toolCatalog.ts:263）；skill enabled；v2.permissions 只映射为权限标签，未见执行前校验（见 6） | risk 由 v2.permissions.network/writesFiles 推导（:280） |
| 能力发现（框架工具） | shared/progressiveCapabilityRouter.ts:69-160 | capability_discover（intents/domains 枚举来自当前工具集，另有 references/requirements） | 模型必须先调用它；服务端本地 discover 后把 targets 回填参数 schema | 服务端 loop 内执行（serverToolLoop.ts:150-162；assistantDirect.ts:230-247） | 只能激活本轮已声明的工具（authorizeCapabilityDiscovery，capabilityDiscovery.ts:7-23；/api/agent/capabilities/discover 还会用 run.capabilityIds 收窄，index.ts:10733-10740） | 无副作用 |

补充断言：

- 【观察】所有工具在发给模型前都被包成 function + x_dx_capability（toolCatalog.ts:47-64；toolResolver.ts:37-51）；模型不看工具列表，只看 capability_discover 的内嵌目录（progressiveCapabilityRouter.ts:76-114）。
- 【观察】服务端目标解析：capabilityTargetResolver.ts:7-24 映射能力 intent→协议 intent；:73-111 为每个 intent 选前 8 个可用 target；:130-190 对已登录用户合并本地 providers 与 DXOS 积分云 provider，并按 API 设置模型顺序 + 分辨率支持排序。
- 【观察】gateway 客户端声明的工具必须命中 allowedNames；对非规范工具要求 x_dx_capability 合法（serverToolLoop.ts:45-77；index.ts:7656-7669）。

### 2.4 模型路由与回退

- 【观察】路由请求：capabilityRouter.ts:36-40 推断 taskIntent（有图片→agent.analyze_image_and_write 且 requiresAll=[llm.chat.vision,llm.tools]；否则 agent.project.write + llm.tools）；:42-75 组 route。
- 【观察】候选排序：modelResolver.ts:154-173 —— 先缺能力数升序，再满足数降序、偏好 weight、模型 cap_sort、平台 sort、score；显式 providerId/model 时 fallbackPolicy=strict 并锁定候选（:156、:175-180）；resolveModelRoutesFromProviders 返回整条可用链（:234-239）。
- 【观察】回退：agent-runtime/modelFallback.ts:16-35；可回退错误分类 :1-10（408/409/425/429/5xx、overloaded、timeout、网络、模型不存在/未开放/未配置路由/图片数量限制；AbortError 不回退）；注释明确 fallback 只包一次推理、不重放工具（:12-15）。
- 【观察】是否启用整条链由 getAutoFallback() 决定（store.ts:282，默认 autoFallback!==false）；调用点：index.ts:7704、7759 区、projectAgentMode.ts:135、assistantDirect.ts:27。开关路由 GET/POST /api/providers/auto-fallback（index.ts:2154-2155）无鉴权中间件。
- 【观察】用量：beginAgentUsage/finishAgentUsage 记录 model/tool 调用（agent-runtime/usageStore.ts；调用点 index.ts:7706-7721、projectAgentMode.ts:137-146）。

### 2.5 审批、确认、验收与子代理

| 环节 | 服务端事实 | 客户端事实 | 结论 |
|---|---|---|---|
| 交互策略 | envelope.interactionPolicy 只被规范化保存（envelope.ts:43-45、79、108）；grep 全 server 只有 5 处生成 envelope 时写 confirm-risky/interactive，无任何读取分支 | 未见按 interactionPolicy 的确认 UI | 【观察】服务端不强制；【未知】是否有未打包的运行期分支 |
| 工具 confirmation | developerApps.ts:147/735-755 把 confirmation 写入 APP 工具声明；toolCatalog.ts:229 透传 | 前端未检索到对 ToolDescriptor.confirmation 的消费 | 【观察】声明存在、执行链未校验 |
| 前端权限 guard | — | localStorage key ccs-os:permissions；5 项默认值：files.create=allow、files.modify=allow、files.delete=ask、mcp.call=ask、skill.run=allow；guard 使用点：Files 新建/改名/保存/移动/删除、Conversation 上传与 skill 运行、创建项目任务（DIST index chunk @290,040；Conversation chunk @6,361/@13,676/@15,397；index chunk @291,494 起 14 处 guard） | 【观察】权限是前端本地设置，不是服务端授权；Jarvis 工具执行器（index chunk @335,807 起）未调用 guard |
| 项目 Agent 完成验收 | projectAgentMode.ts:242-267：终态后再调模型做“独立完成验收器”，返回 {complete,reason,missingActions}；不通过则写回消息继续，无次数上限；任务因 30 分钟窗口暂停时用 PROJECT_AGENT_CONTINUE_QUESTION 等用户续跑（:196-201、:329-332） | — | 【观察】完成不由模型正文决定 |
| 产物门禁 | runManager.complete:145-168：task.expected_output_schema 校验；artifact 状态 produced/conflicted/rejected 或 validated 未提交/未审查都 409；workspaceStore.artifactReviewState:185-203 要求 reviewer 决策且产物哈希匹配 | — | 【观察】项目 Agent 交付有服务端强门禁 |
| 子代理委派 | supervisor.ts:9 限额 maxDepth=3、maxChildrenPerRun=8、maxParallelPerRoot=3；:54-63 子能力=父 capabilityIds ∩ profile.capabilityScopes；:83-169 为每个 spec 建 task+run+独立 workspace 并写 agent_delegations，request_hash 唯一防重；:146-154 再按 allowedRisks 过滤；reviewer 单轮纠错 :182-230 | — | 【观察】委派仅限绑定项目任务且未终态的 Run；不能代他人委派（:86） |
| 路由面 | /api/agent/runs/:id/delegations 需 requireAgentRunAccess（index.ts:7431-7444，7340-7346）；steer/stop 同样 | — | 【观察】 |

## 3. AI 调用“每个功能”的链路清单（按功能域）

| 功能 | AI 触发方式 | 执行链 | 前置条件 | 证据 |
|---|---|---|---|---|
| 打开应用/切窗口 | open_app 工具（system-jarvis 客户端） | gateway → 客户端 executor → 应用注册表打开窗口 | profile=system-jarvis + desktop 入口；工具名在 JARVIS_CLIENT_TOOL_NAMES | index.ts:7673-7677；DIST index chunk @335,807 |
| 播放/控制音乐 | music_play / music_control | 客户端 executor → 音乐 store 播放队列 | 同上；曲库有歌 | 同上；toolCatalog.ts:90-127 |
| 生成/编辑/描述图片、生成视频、TTS/转写/音乐 | media_* | capability_discover → 目标 V2 → runCatalogTool → runSkill → 协议/原生适配 → 产物写回项目 | 项目根/画布输出目录；能力 enabled；模型路由可用；媒体 API 配额（image/video） | toolCatalog.ts:316-337；skills.ts:2099-2134；capabilityTargetResolver.ts:130-190；apiQuota.ts:231-286 |
| 项目文件读写 | fs_* | 服务端 runTool（任务场景 workspace 校验） | 项目成员 + 项目根；system 共享文件夹只读；runId 时根必须等于 workspace root | agentTools.ts:53-72、288-303；workspaceStore.ts:120-125 |
| 画布建节点/连节点/跑节点 | canvas_* | gateway 暂停 → Canvas 客户端执行 → observations 回传 → 服务端继续 | canvas-agent profile + appId canvas；画布编辑权限；节点/动作 id 在实时 manifest 中 | index.ts:7679-7694；canvasKernelCapabilities.ts:25-67；canvas.ts:721-738 |
| 第三方 APP 声明工具 | APP 自定义工具名 | capability_discover → runCatalogTool：frontend-bridge(天气)/skill/mcp-tool | APP 已安装 + 当前用户 canOpenApp(APP) + 工具 status=ready | toolCatalog.ts:203-236、384-437 |
| MCP 工具 | mcp__* | callByName → MCP SDK callTool（断连重连一次） | server enabled + connected + 工具在 rt.tools | mcp.ts:820-880；toolCatalog.ts:238-260 |
| 技能 | skill__* | runSkill → 内置 kind 分派或 procedure 小循环（12 轮/16 次） | exposure=agent + 隐式调用允许 + enabled | skills.ts:628-639、2099-2297 |
| 创建项目后台任务 | create_project_task（客户端系统工具） | 客户端 guard(files.create) → POST /projects/:id/tasks → 队列 → worker | 项目写权限（can_create_tasks） | DIST index chunk @335,807 区；index.ts:7130-7152 |
| 项目 Agent 后台执行 | thinking/agent 模式 | worker 领取任务 → runProjectAgentMode（30 分钟窗口、完成验收）→ 断点续跑 | 绑定项目任务；profile project-assistant | worker.ts:40-90；projectAgentMode.ts:112-340 |
| 子代理 | delegate_agents / POST delegations | supervisor.delegateAgentWork → 子 task/run/workspace → job 队列 | 父 Run 有 taskId+projectId、未终态、同用户、深度<3、子数≤8 | supervisor.ts:83-169；index.ts:7431-7444 |
| 媒体任务（AI Task 快车道） | /api/ai/tasks 系列 | surface adapter authorize → comfy/legacy/declarative/agent 分支 | v2 需已注册 surface adapter；canvas surface 需 canEditCanvas | index.ts:5033-5195、4447-4518 |
| 裸单步 function call | /api/agent/step(-stream) | chatWithTools 一次 | 有可用 LLM 站点；无 kernel 准入 | index.ts:7938-7960 |

## 4. 组织：账号、部门、角色、授权、配额、数据隔离

### 4.1 账号、会话、角色

| 环节 | 路由/函数 | 服务/校验 | 表/默认值 | 证据 |
|---|---|---|---|---|
| 初始化 | POST /api/auth/bootstrap（index.ts:844-853） | 仅当 auth_users=0；建第一个 superadmin；claimOwnerlessNodes 把无主文件归首位超管 | auth_users；默认角色 superadmin | auth.ts:312-331；fs.ts:880-886 |
| 登录 | POST /api/auth/login（index.ts:865-873） | scrypt 校验；status=active；loginEligibleUserIds 内；单账号单会话（撤销旧会话+部分唯一索引） | auth_users/auth_sessions；会话 30 天（AUTH_SESSION_DAYS） | auth.ts:231-243、209-221、291-305、196-207 |
| 桌面自动超管会话（0.6.1 新） | SHELL IPC dx-desktop:ensure-local-admin-session → POST /api/auth/desktop-session（index.ts:854-864） | 仅 127.0.0.1/::1；必须带 x-dx-desktop-auth（与 DX_DESKTOP_AUTH_SECRET 做 sha256 定时比较）；取最早 superadmin，无则自建；返回 Cookie | auth_users/auth_sessions；secret 由 main.cjs 每次启动随机生成，只注入 API 进程（worker 环境删除） | SHELL/main.cjs；SHELL/preload.cjs；auth.ts:353-398；前端 DIST index chunk @98,522 |
| 鉴权中间件 | requireAuth（auth.ts:416-424）→ requireSuperAdmin（:426-434）→ requireLocalSuperAdmin 别名（:438）→ requireAppOpen(appId)（:837-847） | 取 ccs_session Cookie→sha256→auth_sessions JOIN auth_users；非 active/过期/撤销→401；超额度账号登录被拒并标记 entitlementSuspended | auth_sessions（单活索引） | auth.ts:400-424；【观察】/api/projects、/api/tasks 走 projectActor（index.ts:6987-6992） |
| 角色 | role ∈ superadmin/admin/user（auth.ts:17；表 CHECK :117） | requireSuperAdmin 只认 superadmin；admin 仅在 app_access_rules.mode='admins' 与 GET /api/app-permissions 的“管理员可见”判断中出现（auth.ts:736-741；index.ts:1079-1081） | 首个账号 superadmin，其余默认 user（:576） | auth.ts:17、576、736-741、1041-1057 |
| 保护最后超管 | update/delete 前 ensureAnotherSuperAdmin（auth.ts:601-606、613、653） | 禁止把唯一启用超管降级/停用/删除 | — | 【观察】0.5.5 报告未提该函数；是否新增属未知 |

### 4.2 部门与资源范围

- 【观察】表：auth_departments（id/name UNIQUE/parent_id/status；auth.ts:102-109）。parent_id 字段存在但创建时固定为 null（:523-527），即当前只有一级部门。
- 【观察】创建/改名/删除路由：POST/PATCH/DELETE /api/accounts/departments（index.ts:1058-1077），全部 requireSuperAdmin；服务层先过会员权益门禁 requireDepartmentEntitlement（auth.ts:497-505，未开通部门功能直接报错“部门和成员分配属于会员功能”），再校验名称长度/唯一。
- 【观察】部门与文件资源绑定：创建部门后 ensureDepartmentRoot 在系统根下建 share=department:<id> 的系统文件夹（index.ts:1061；fs.ts:900-907）；改名同步 renameShareRoot（:1068；fs.ts:957-961）；删除先解绑成员（department_id=NULL），再删部门并 removeShareRoot 把文件夹移入废纸篓（auth.ts:558-563；fs.ts:964-968）。
- 【观察】可见性：canSeeShare —— public 全员；department:<id> 仅同部门或 superadmin（index.ts:6028-6036）；桌面只显示本部门共享区（showShareOnDesktop，:6043-6047，超管不无脑显示所有部门）。
- 【观察】共享区内的项目自动加入成员：ensureShareMembership → ensureProjectMember（index.ts:6993-6997；taskStore.ts:79-83）。

### 4.3 APP 授权（打开规则）

| 项 | 事实 | 证据 |
|---|---|---|
| 数据模型 | app_access_rules(app_id PK, mode ∈ all|superadmins|admins|departments, department_ids_json, updated_by, updated_at) | auth.ts:146-152、171-188（旧库 CHECK 约束迁移） |
| 默认值 | defaultAppAccessRule：lingxing→admins，其它→all；应用列表=内置 market/developer-studio + 当前用户已安装 APP；market 永远强制默认（不能被历史策略锁） | auth.ts:672-696、779-802 |
| 判定 | canOpenApp：superadmin 全通过；api-settings/accounts 对非超管恒 false；未安装 APP 直接 true；否则按规则 ruleAllows（all→true；superadmins→false，非超管；admins→role==='admin'；departments→departmentId ∈ 列表） | auth.ts:736-751 |
| 配置入口 | PUT /api/app-permissions/open/:appId（requireSuperAdmin）；GET /api/app-permissions 允许 superadmin/admin 查看 | index.ts:1079-1092 |
| 服务端强制点 | ①requireAppOpen 前缀中间件：/api/providers、/api/midjourney、/api/runninghub、/api/cli、/api/dingtalk、/api/market、/api/comfyui、/api/datasets、/api/quark、/api/ai-image-declaration、/api/video，以及 /api/protocols/v2/*、/api/ai-tasks/protocol/*、runninghub target-metadata 等（index.ts:1181-1190、1419、1573-1716、2751-2769）；②GET /api/auth/access 返回 appAccessSummary 供前端隐藏入口；③agentGatewayContext 校验 source.type=app 的 appId；④developerAgentScope 校验 canOpenApp；⑤APP 工具描述 enabled=canUseAppPermission（其本质只解析 code 里的 appId 再 canOpenApp） | index.ts:883-887、7649-7651、9979、10355；toolCatalog.ts:203-236 |
| 前端事实 | 组织面板 GET /accounts/snapshot、GET/PUT /app-permissions 与 /app-permissions/open/:appId（DIST index chunk @157,057/@158,739/@159,502） | DIST 静态阅读；REA DIST ev_9178 覆盖该构建 |

### 4.4 精细权限策略（app_permission_policies）

- 【观察】表结构：permission_code PK、decision allow|deny、user_ids_json、department_ids_json、roles_json、data_scope ∈ all|department|departments|self|none（auth.ts:154-163、72-79）。
- 【观察】写入：PUT /api/app-permissions/policies/:permissionCode（requireSuperAdmin，index.ts:1088-1092）→ saveAppPermissionPolicy（auth.ts:816-829）：校验权限码（已知 manifest 或正则 app.<id>.<code>）、目标部门/用户存在；受会员功能门禁 requireAdvancedAppPolicyEntitlement（auth.ts:507-511）。
- 【观察】读取：appPermissionSnapshot 把策略行读成 permissionPolicies（auth.ts:779-802），随 /accounts/snapshot 与 /app-permissions 返回。
- 【观察】服务端授权判定中没有任何地方读取 permissionPolicies/decision/dataScope（全仓 grep：只有 auth.ts 内写入/读取/规范化；toolCatalog 的 canUseAppPermission 只做 canOpenApp）。→ 该表现在是“可配置但未参与服务端拒绝”的状态；dataScope 语义未知。

### 4.5 成员配额、席位与计费配额

| 配额 | 来源/字段 | 校验点/拒绝点 | 默认值 | 证据 |
|---|---|---|---|---|
| 本地账号数 | 云端签名权益 maxLocalAccounts；否则 BASE_LOCAL_ACCOUNT_LIMIT | 创建用户事务内 currentAccounts>=max → 拒绝；超额度账号 loginEligibleUserIds 只放行最早 N 个（超管优先保 1 个），登录/getAuth 拒绝并撤销会话 | 基础 3 个 | auth.ts:15、209-221、476-495、573-599；cloudEntitlement.ts:16-35 |
| 部门数与部门功能 | 权益 maxDepartments、departmentsEnabled | requireDepartmentEntitlement：未开通→拒绝；创建时 current>=max→拒绝 | 未签名权益时 0 个、功能关闭 | auth.ts:497-505、519-523 |
| 精细 APP 权限功能 | 权益 advancedAppPolicyEnabled | saveAppAccessRule / saveAppPermissionPolicy 前检查；未开通时 appPermissionSnapshot 返回全 all | 关闭 | auth.ts:507-511、804-805、816-817、782-789 |
| 权益有效期/宽限 | CloudEntitlementPayload expiresAt/graceUntil/subscriptionStatus | currentCloudMembership：过期且在 graceUntil 前为宽限期；plan≠free 且 active/trialing 才算 active；验签失败/绑定不匹配/时钟回拨→null | 离线宽限 | cloudEntitlement.ts:130-210 |
| 媒体 API 金额配额 | api-quotas.db api_quota_rules_v2(scope_type user|department, subject_id, provider_id, period total|monthly, limit_amount 微元) | reserveApiQuota 事务内按用户+部门、平台/总规则双校验，used+additional>limit → 拒绝；旧直连入口在存在配额/模型限制且无 taskId 时被拒绝，要求走统一 AI 任务入口 | 无规则=不计费 | apiQuota.ts:71-96、231-286、51-62 |
| 部门模型白名单 | api_model_access(department_id, models_json ≤5000) | assertApiModelAccess/apiModelAccessFilter：部门有规则时，模型/平台/地址必须命中，否则 403；/api/ai/models 也按此过滤 | 无规则=全部 | apiQuota.ts:131-188、164-170 |
| 计费结算 | api_quota_usage(status reserved/spent/released) | reserve→settle；只有 image/video 计费，LLM 不走该表（kind 判定 :235-237） | — | apiQuota.ts:231-308 |
| 开发者 APP 项目存储 | MAX_DEVELOPER_PROJECT_QUOTA_BYTES 默认 256 MiB（可用 DX_DEVELOPER_PROJECT_QUOTA_BYTES 覆盖）；单文件文本 2 MiB/二进制 24 MiB/分片 1 MiB；上传并发 8 | ensureDeveloperProjectQuota 超限抛错（index.ts:10349-10350）；文件传输路由带 authorize(appId,user,read|write)（index.ts:10355；developerFileTransfers.ts:10-31） | 256 MiB | index.ts:9901-9913、10349-10355 |

### 4.6 数据隔离（表/条件/默认）

| 域 | 隔离键与条件 | 拒绝点 | 证据 |
|---|---|---|---|
| 项目 | projects.created_by + project_members(project_id,user_id,role owner|member,can_create_tasks) | requireProjectAccess：非成员或无 can_create_tasks（创建任务时）→ 抛错；listProjects 只列成员项目 | taskStore.ts:44-89；ccsDb.ts:23、132 |
| 对话线程 | threads.visibility(private|project) + created_by | threadMessages：private 只允许 created_by（或 created_by IS NULL）；project 对项目成员可见 | taskStore.ts:341-348、1071-1073、327-330 |
| 任务 | tasks.project_id + project_members | listTasks 用 JOIN project_members；getTask 路由要求项目访问；pause/cancel/resume 先 projectActor + requireProjectAccess | taskStore.ts:318-324；index.ts:7293-7310、7458-7505 |
| 虚拟文件系统 | fs 节点 ownerId；共享区 share（public|department:<id>|canvas:<id>|asset-library:<id>） | canReadNode：private 只有 owner 或无主（历史无主文件放行）；共享区按 canSeeShare；写入时禁止在他人私有目录建内容（fs.ts:612-632）；回收站删除只允许 owner | index.ts:6064-6071；fs.ts:30、612-632、910-918 |
| 画布 | canvases.owner_id/visibility(public|restricted)/members；canvas_invites+canvas_invite_members(permission read|edit) | canvasAccess：owner→owner；public→edit；restricted 且成员→edit；否则邀请权限；deleted/project 根被删→null | canvas.ts:709-738、812-830 |
| 画布媒体文件 | 只对文档实际引用的 nodeId 开放 | canViewCanvasMedia 遍历画布引用集，不授予父目录 | canvas.ts:758-764 |
| 资产库 | developer_collab_projects 的成员/口令访问 | canvasAssetLibraryAccess 走 getDeveloperCollabProject；fs share=asset-library:<id> 只对 ACL 通过者可见 | canvasAssetLibrary.ts:263-270；fs.ts:938-954；index.ts:6034 |
| Agent Run/Workspace | agent_runs.user_id/project_id/session_id/app_id；agent_workspaces.user_id + workspace_root_id | requireAgentRunAccess：有 projectId 走 requireProjectAccess，否则 owner 校验；assertRunWorkspaceWrite：workspace 属于本 run 且 root 匹配；complete 时检查 artifact 审查状态 | index.ts:7340-7346；workspaceStore.ts:110-168、185-203；runManager.ts:121-134、145-168 |
| 自动化 | automations/automation_runs 按 owner | 所有路由 requireAuth + user.id 传参 | index.ts:923-1024 |
| 助理空间/对话缓存 | 每用户 ensureUserFolder('助理空间'/'助理缓存')；助理项目 created_by | projectHistory/threadMessages + private 线程 | index.ts:7006-7075；taskStore.ts:327-348 |
| 第三方 APP 项目 | 每 APP 每用户独立 project root（ensureDeveloperProjectRoot）+ project_members | developerAgentScope/TaskScope/RunScope 校验 appId+projectId+sessionId 一致 | index.ts:9979-10010 |

### 4.7 “组织怎么分配”的完整链路（从超管操作到数据可见）

1. 【观察】超管在组织面板添加用户（POST /api/accounts/users → createAuthUser）：默认角色 user，可指定部门；事务内校验本地账号额度（auth.ts:573-599）；创建后写 auth_users 与审计 auth_audit_logs。
2. 【观察】超管创建部门（POST /api/accounts/departments → createAuthDepartment）：先过部门权益，再写 auth_departments，同时 ensureDepartmentRoot 在系统根建 department:<id> 共享文件夹（index.ts:1058-1063）。
3. 【观察】超管把用户分配到部门（PATCH /api/accounts/users/:id → updateAuthUser，:608-630）：可改 role/status/departmentId；部门变更需部门权益；角色/状态变化会撤销该用户全部会话（:626）。
4. 【观察】超管配置 APP 打开规则（PUT /api/app-permissions/open/:appId → app_access_rules）与精细策略（PUT /policies/:code → app_permission_policies，需 advancedAppPolicyEnabled）；APP 工具与 API 前缀按 canOpenApp 放行，精细策略暂不参与判定。
5. 【观察】超管配置部门计费配额与模型白名单：PUT /api/providers/quotas、/quotas/models（requireSuperAdmin，index.ts:2004-2039）→ api_quota_rules_v2 / api_model_access；用户调用媒体能力时按 用户+部门 双作用域预扣（apiQuota.ts:231-286），部门模型限制在 assertApiModelAccess 拒绝。
6. 【观察】成员获得资源可见性的方式：部门共享文件夹（同部门可读写，超管可读）、项目添加成员（owner/member + can_create_tasks）、画布加成员/邀请（read|edit）、资产库成员、共享区项目自动加入。
7. 【观察】默认值与继承：APP 打开默认 all；lingxing 默认 admins；market 永远默认；未安装 APP 直接允许；部门内所有成员继承部门共享区的读写；项目成员继承项目内线程（project 可见性）与任务；private 线程不继承。
8. 【观察】拒绝点汇总：auth required（401）；角色不符（403）；APP 打开规则（403）；部门/高级策略权益未开通（业务错误）；账号/部门额度用尽（业务错误）；项目非成员/无建任务权（业务错误）；private 线程非创建者（业务错误）；画布非 edit（403）；配额/模型未授权（业务错误）。

## 5. 0.6.1 相对 0.5.5 的相关变化

方法说明：0.5.5 运行时目录已不在本机，0.5.5 事实取自既有报告 /Users/wepingli/Downloads/DXOS-Portable-0.5.1-mac-arm64/DX-OS-完整逆向报告.md（附录 B/D/E，含 0.5.5 的 U55 file:line）与 _re_analysis/asar55 的 0.5.5 asar 提取件；0.6.1 事实取自本次 REA Evidence 与 U/ 源码。0.5.5 的服务端源码不在手，无法做逐行 diff，故只列“有正反证据”的变化，其余标未知。

### 5.1 Electron 外壳（有正反字节对照）

| 项 | 0.5.5（asar55 提取件/报告） | 0.6.1（SHELL 提取件 + REA ev_501ab8…） | 性质 |
|---|---|---|---|
| main.cjs | 82,935 B | 87,182 B | 【观察】字节变化 |
| preload.cjs | 1,431 B，暴露 dxDesktop（getInfo/chooseDataDirectory/chooseDirectory/openExternal/readClipboardText/writeClipboardText/更新相关） | 1,812 B，新增 ensureLocalAdminSession、readClipboardImage、hasClipboardImage、writeClipboardImage | 【观察】新 IPC 面 |
| proxy.cjs | 5,446 B，无 createCloudCompatibilityFetch | 7,219 B，新增 createCloudCompatibilityFetch：仅 https://api.dx-os.com/v1/、独立 session partition dxos-cloud-compatibility、支持 direct/system/fixed_servers 代理、credentials omit | 【观察】 |
| 更新传输 | createUpdaterFetch（proxy session）单一传输 | 新增 direct-update-fetch.cjs；fetchSystemUpdate=createAutoUpdateFetch(directFetch, proxyFetch)，带下载重试包装；兼容更新仍用独立 session | 【观察】0.6.1 新文件在 0.5.5 提取件中不存在 |
| 云兼容默认 | cloudCompatibility === true 才启用 | config.cloudCompatibility !== false（默认启用），新增 cloudAccountNetwork direct|proxy | 【观察】 |
| 服务进程环境 | 不注入桌面凭据 | 生成 DX_DESKTOP_AUTH_SECRET（两段 UUID）只注入 API 进程；worker 环境删除该变量；新增 DX_CLOUD_ACCOUNT_NETWORK；启动时删除继承的 DX_CLOUD_COMPAT_URL/TOKEN | 【观察】 |
| 桌面会话 IPC | 无 | ipcMain.handle('dx-desktop:ensure-local-admin-session')：仅主窗口主 frame；POST /api/auth/desktop-session；把返回 Cookie 写入 defaultSession | 【观察】与服务端 auth.ts:353-398、index.ts:854-864 对应 |
| IPC 统计 | 报告口径 0.5.5：11 个字面量通道/9 个 handler | REA 0.6.1：13 个字面通道/13 个 main handler（3 次分析记录一致） | 【观察】通道增加 |
| package.json | 900 B | 900 B（version=0.6.1；依赖含 tsx/express/better-sqlite3 等） | 【观察】 |

### 5.2 服务端 AI / 组织（0.6.1 源码 vs 0.5.5 报告）

| 主题 | 0.5.5（报告事实） | 0.6.1（源码事实） | 结论 |
|---|---|---|---|
| 桌面超管会话 | 报告仅列 /api/auth/status|bootstrap|login|logout|me|access|change-password；无 desktop-session，无 DX_DESKTOP_AUTH_SECRET | 新增 validDesktopAuthSecret/desktopAdminLogin（auth.ts:353-398）与 POST /api/auth/desktop-session（index.ts:854-864）；前端启动自动调用（DIST index chunk @98,522） | 【观察】新增；影响“本地桌面=超管”这一默认行为 |
| 项目 Agent 步数/工具上限 | projectAgentMode.ts maxSteps=18，单 Run 工具 40 次；reviewAttempts≤2 | projectAgentMode.ts:171 state.maxSteps=null；无工具次数上限；完成验收不通过无限回退（:242-267）；改为 PROJECT_AGENT_EXECUTION_WINDOW_MS=30 分钟窗口（shared/projectAgentExecutionPolicy.ts:1-7），窗口到期 checkpoint 并等待用户答“继续”（:196-201、:329-332）；worker 只在用户答复/恢复事件后开新窗口（worker.ts:54-70） | 【观察】控制模型由“次数硬上限”改为“时间窗+用户续跑”；【推断】旧报告中的 18/40/2 在 0.6.1 不再成立 |
| ReAct 预算 | 报告称 assistant 10/24、thinking DEFAULT_BUDGET（未给值） | reactDriver.ts:126-129 assistant 10/24、thinking DEFAULT_BUDGET；taskStore.ts:361 DEFAULT_BUDGET={maxModelCalls:null,maxToolCalls:null}，另有 DEFAULT_TREE_BUDGET 40/120 | 【观察】DEFAULT_BUDGET 在 0.6.1 是无上限（树预算 40/120）；0.5.5 同字段值未知 |
| HTTP 路由集 | 报告 604 处注册（表格 585 条可解析） | 源码 612 条带路径注册（解析口径）；相对报告新增：POST /api/auth/desktop-session、POST /api/desktop/proxy/detect、POST /api/codex-canvas/relay、photo/photocraft 系列（约 30 条）；cli 模板路由因解析口径差异被列为“删除”（0.6.1 仍有 /api/cli 前缀，见 requireAppOpen） | 【观察】AI/组织相关新增只有 desktop-session；其它为照片/摄影/代理域 |
| APP 工具授权 | 报告未写 actor 参与 | toolCatalog.ts:203-236 appTool(actor)、allowed=canUseAppPermission；listToolDescriptors(actor)（:339-341）；gateway/route 传 req.auth.user | 【观察】0.6.1 有按用户 APP 打开权限的过滤；0.5.5 是否已有属未知（同文件行号结构一致，倾向未变，见 6） |
| AI Task surface 授权 | 报告未提及 surface adapter 机制 | index.ts:4447-4518 注册 canvas/test/comic/app/plugin/skill 适配器；canvas 的 authorize=canEditCanvas，其它 surface 为空操作；提交入口强制 adapter 存在（:5047-5051） | 【观察】0.6.1 新结构；0.5.5 报告无对应描述 |
| 云端权益 | 0.5.5 报告已有 Ed25519 权益、部门/账号额度、apiQuota、模型白名单 | 结构一致：cloudEntitlement.ts:5-210、auth.ts:476-511、apiQuota.ts:71-96 与报告行号描述基本对应 | 【推断】该区域 0.5.5→0.6.1 未见实质变化（结构/行号一致，非字节 diff） |
| 工具目录/能力发现 | 0.5.5 报告：toolCatalog 7 类、capability_discover、x_dx_capability、capabilityTargetResolver:130 | 0.6.1 行号与函数名一致（toolCatalog.ts:339/384；capabilityTargetResolver.ts:130；serverToolLoop.ts:45/79；profiles.ts:16-42；supervisor.ts:9/54/83/182） | 【推断】基本未变 |
| 画布 | 0.5.5 报告：canvas 为内置 chunk，Agent 工具 client 执行 | 0.6.1：画布注册为 delivery:dx-app；dist 无 Canvas chunk；canvasKernelCapabilities 仍生成同一组工具 | 【观察】交付方式变化；【未知】新包内执行器实现 |
| 桌面凭据边界 | 报告：host 校验+loopback | 0.6.1：secret 只注入 API、worker 剥离、仅 loopback + 主窗口 IPC；desktop-session 可签发超管 Cookie | 【观察】新增信任边界，安全性评估不在本文范围 |

### 5.3 前端

- 【观察】0.6.1 DIST 有 49 个 JS chunk，含新增的 PhotosApp-B__Mar7O.js（照片应用），账户管理、Conversation、Files、Dock 等仍为独立 chunk。
- 【观察】Jarvis overlay 的 envelope 与执行器在 DIST/assets/index-DJDR-kWU.js（@338,190 与 @335,807），0.5.5 报告把同一逻辑描述在 dist；具体 chunk 组成无法逐字节对照（0.5.5 dist 未留存）。
- 【观察】前端启动自动确保本机管理员会话（index chunk @98,522）：/auth/status → window.dxDesktop.ensureLocalAdminSession() → 成功后 /auth/me + /auth/access；无该 IPC 时回退到普通登录/初始化流程。0.5.5 报告无此启动逻辑。

## 6. 未确证项与未知

1. 【未知】云端组织：api.dx-os.com 的 organization/成员/角色/权限模型不在随包内；本地仅保存 organizationId/deviceId 绑定与签名权益，云端角色不参与本地授权判定。
2. 【未知】app_permission_policies 的预期语义：有 allow/deny、user/department/role、dataScope 字段与写入路由，但服务端无任何判定消费点；是否由前端/未来版本执行未知。
3. 【未知】审批的运行时行为：服务端 interactionPolicy/confirmation 无强制；前端 Jarvis 工具循环静态代码未见 guard，但未运行目标，不能断言“绝不会弹确认”。
4. 【未知】画布客户端执行器：canvas 是 dx-app 安装包，不在 app.asar/unpacked/dist；canvas_* 的真实执行、节点 operation 到 executorBinding 的映射、失败/取消语义未取证。
5. 【未知】skill v2.permissions 是否在别处执行：runSkill 未见 readsFiles/writesFiles/network/sensitive 校验，仅 toolCatalog 映射为权限标签；是否有客户端/其它路径校验未知。
6. 【未知】MCP 边界：/api/mcp/*（servers CRUD、import、call、call-direct、agent-tools）无鉴权中间件（index.ts:8213-8259、8441-8455）；默认仅 127.0.0.1 监听（外壳 lanEnabled 默认 false，见既有报告），开启局域网后的实际暴露面未在本期验证。
7. 【未知】/api/chat、/api/chat/stream 无鉴权（index.ts:2990、7607），可被同网段调用消耗用户已配置模型额度；运行时是否另有网关限制未知。
8. 【未知】0.5.5 服务端源码不可得：5.2 的“变化”以既有报告的 file:line/描述为对照，凡报告未提到而 0.6.1 存在的结构（如 ensureAnotherSuperAdmin、surface adapter、256 MiB 开发者项目配额、agentProtocolParams/capabilityTypes/agentSupervisorContract/projectAgentExecutionPolicy 文件）无法确认是新增还是报告遗漏。
9. 【未知】app.asar 解包完整性：REA 记录到大量 unpacked 条目声明哈希与实测不一致；这些文件的“发布态是否被重写/签名”未知，REA 将观测字节标为 untrusted。
10. 【未知】REA SHELL 图的 contextBridge 字段为 0 与 preload.cjs 实际暴露矛盾；本文以 preload 字节为准，但 REA 的 IPC 关联（谁调用谁）不完整。
11. 【未知】envelope.actor.organizationId：客户端可传（envelope.ts:63），服务端未校验、未用于任何数据过滤；其用途未知。
12. 【未知】LLM 调用是否计入任何配额：apiQuota 只对 image/video 计费（:235-237）；LLM token 是否有其它计费/限流层未取证。
13. 【未知】项目 Agent 的“完成验收器”使用同一模型路由且无次数上限（projectAgentMode.ts:242-267）；极端情况下是否会持续循环仅能从代码结构判断，未运行验证。
14. 【未知】0.5.5 的桌面管理员登录：既有报告未提 desktop-session/secret；若 0.5.5 服务端也有但报告遗漏，则“新增”判断需下调为“报告未覆盖”。

## 附录 A：本文引用的 REA Evidence（同一 REA 会话留存记录）

| Evidence ID | 操作 | 主题 | 覆盖/限制 |
|---|---|---|---|
| ev_501ab896b74854e3c2f890b52d3a26578a0ede727e97fed6e020d56c40ec7f18 | analyze_javascript_application | app.asar（sha256 f14ed0a6…7933） | summary 视图覆盖 6502 文件/13 IPC/1 preload/2 窗口；semantic partial（预算被压低），模块关系不全 |
| ev_67fa657047e2ef4ad47f50a0dfc9851454f4e610302641f2b7fb4238b7668212 | analyze_javascript_application | 同上（另一次运行） | parsed_js 1552，parse_failures 4，semantic truncated |
| ev_bdc8a14851bd7134bba3dbad5c70275444ef5173d4cf6c00d2d21b9285e66dd6 | analyze_javascript_application | 同上 | parsed_js 936，parse_failures 0，semantic truncated |
| ev_c7071ae57cfde65961a2b4712ffe65fc30b4bf89518bc729c99397d5a5e002d3 | analyze_javascript_application | 同上 | parsed_js 1418，semantic truncated |
| ev_aea49337a1ff99d102c499da86fd9de0d57bc0e227ed9dc4b21a9d300f99ebe0 | inventory_artifact | app.asar 成员图 | 完整性矛盾记录为 untrusted |
| ev_b95a3cb387a5334a2f02b2c4ec13dc7783b3ec8b118584b763bb1dcdd7be344f | inspect_artifact | app.asar 图/发现 | 响应超出传输预算，需经 retained evidence 读取；integrity mismatch 记录 |
| ev_9178e6af633b32894db81e4f74448e4aec964b1db5678e9116b61ce73e9c8217 | analyze_javascript_application | dist（sha256 36c57d6b…bf6b） | 52 文件/49 JS/0 失败；semantic truncated |
| ev_027b5212ad469dd229d30e481460d34a1f5d756844aa155d0d14e8e3d25d778a | inspect_analysis_view | dist 视图 | 派生视图记录 |

注：另外还通过 inspect_analysis_view 的 page/summary 派生视图读取了 ev_501…/ev_9178…（派生记录会带自身 evidence id，如 ev_0f188ed9…、ev_f3faa43f…）；本表只列被引用的父记录。

## 附录 B：本文常用源码位置索引（U/ 相对 app.asar.unpacked）

- AI 路由：U/server/index.ts:7750-8089（gateway）、7938-7954（step）、7957-7990（工具目录 HTTP）、10703-10752（capabilities）、7161-7292（项目对话）、5033-5209（AI 任务）、4447-4518（surface adapter）、7340-7460（Run/委派）。
- Agent 内核：U/server/agent-kernel/kernel.ts:7-47、capabilityRegistry.ts:13-50、contextBuilder.ts:4-50、supervisor.ts:9-230。
- Agent 运行时：U/server/agent-runtime/profiles.ts:16-54、envelope.ts:33-109、runManager.ts:53-200、serverToolLoop.ts:45-168、modelFallback.ts:1-35、usageStore.ts:33-100。
- 工具：U/server/toolCatalog.ts:14-437、agentTools.ts:53-314、skills.ts:628-639/2099-2297、mcp.ts:725-880、canvasKernelCapabilities.ts:25-67。
- 路由/能力：U/server/capabilityRouter.ts:36-75、toolResolver.ts:21-68、capabilityDiscovery.ts:7-23、shared/progressiveCapabilityRouter.ts:69-160、capabilityTargetResolver.ts:7-194、modelResolver.ts:154-247。
- 项目 Agent：U/server/projectAgentMode.ts:112-342、worker.ts:40-90、reactDriver.ts:37-129、shared/projectAgentExecutionPolicy.ts:1-11、taskStore.ts:318-348。
- 组织/权限：U/server/auth.ts:17-847、index.ts:835-1092、9979-10010、10349-10355；U/server/apiQuota.ts:51-308；U/server/cloudEntitlement.ts:5-210；U/server/cloudAccount.ts:136-155/316/413；U/server/canvas.ts:709-738/812-830；U/server/taskStore.ts:44-89/341-348/1071-1073；U/server/fs.ts:30/612-632/880-968；U/shared/appAccess.ts:1-9。

---

报告完。
