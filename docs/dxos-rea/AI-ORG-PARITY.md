# OpenArc ↔ DX OS 0.6.1 语义对照审计：AI / 组织（F01/F03/F04/F05/F06/F10/F14/F15/F16）

> 任务：共享 task-30（rev 2）。只读审计；审计对象为 OpenArc 当前工作树（/Users/wepingli/Desktop/OpenArc OS）。
> 对照基线：DX OS 0.6.1 的两份本期产出 docs/dxos-rea/AI-ORG-CONNECTIVITY.md、docs/dxos-rea/PLATFORM-CONNECTIVITY.md（及 REA Evidence ev_501ab8…/ev_9178e6a…）。
> 标注：DX 事实为 REA/源码复核结论；OpenArc 事实为当前源码阅读（file:line），未运行、未构建。结论分「已等价 / 需补 / 不适用」。
> 工作树状态：审计时 AI/org 相关 electron 文件无未提交改动（git status 显示改动集中在 docs、media-domain/media-service/media-store 与 src-vue 设置/市场面板），因此下引行号对应当前提交态。

## 0. 结论总表

| 项 | 语义 | 判定 | 一句话依据 |
|---|---|---|---|
| F01 | 全局助理 Jarvis（Dock orb → agent gateway SSE，profile system-jarvis） | **需补** | Vue 壳已有 AssistPanel（全局 AI 浮层），但走 task 桥/task harness，不走 agent gateway；system-jarvis capsule 在 OpenArc 只有定义、无运行入口；harness 工具面不含 open_app/music/media/file |
| F03 | 项目文件助手（/api/projects/:id/converse，assistant/thinking/agent 三模式） | **需补** | electron/project-agent-mode.cjs 已移植且可跑，但语义是 0.5.5 版（maxSteps=18/40 工具/复审≤2），缺 0.6.1 的 30 分钟执行窗口与续跑；默认 Vue 壳（ProjectsApp/FilesApp）无 Agent 入口，仅旧 React TaskConsole 可调用 |
| F04 | 第三方 App Agent（app.<id>.agent.run + capabilityBoundary） | **需补** | 只有清单解析与工具目录投影（app source / developer-app capsule 定义 / RunManager 过滤代码），没有 app 作用域的 agent 运行入口、权限校验与项目/会话隔离 |
| F05 | dx-agent-request/v1 envelope + 5 内置 profile 白名单/能力交集 | **已等价（2 个收口点）** | envelope/profiles/contracts/RunManager.prepare 逐字移植；收口点：actor 允许字符串但 RunManager.create 用 actor.id、developer-app 入口依赖 F04 |
| F06 | toolCatalog 7 组工具 + x_dx_capability | **已等价（动态枚举/装配待验证）** | system/media/file/app/canvas/mcp/skill 七组与 x_dx_capability、runCatalogTool 分派逐字移植；canvas 工具来自注入的 nodeTypes/extraTools，需验证实时 registry 装配 |
| F10 | 监督子代理（3/8/3）+ 检查点/验收 | **需补** | supervisor/checkpoint 代码逐字移植；但 4 条内置 agent_profiles 种子未植入（委派/reviewer 无 profile 可用）、无持久化检查点恢复、无委派管理面 |
| F14 | api-quotas.db 部门×平台金额、模型白名单、reserve/settle | **需补** | 账本原语与 v1 三表已建；0.6.1 的 v2 规则（user/department×period）、CNY 计价、模型白名单过滤与模型调用接线全部缺失（createQuotaLedger 无调用方）；若产品判“计费 OUT”可改记不适用 |
| F15 | 数据隔离（fs ownerId+共享区、画布 ACL、资产库、线程可见性、project_members） | **需补（口径映射）** | OpenArc 有更细的统一授权域（SCOPE/GRANT/ACTION）与各域 ACL，但与 DX 的 fs share、canvas invites、project_members 字段不是一一对应，需补映射与逐表验收；部分能力（画布邀请）无运行时实现 |
| F16 | 0.6.1 桌面壳自动超管会话（ensureLocalAdminSession → /api/auth/desktop-session） | **不适用（有意差异，待产品确认）** | OpenArc 采用首启三步初始化 + 显式登录/锁屏 + sessionRef 会话；无 DX_DESKTOP_AUTH_SECRET / desktop-session / 主窗口自动超管链路。若产品要求 DX 单机体验则转为需补 |

判定口径说明：本表按“DX 0.6.1 的可观察语义”逐项核对，不要求实现同名文件/同名 IPC。F09（审批）此前已被认定为“加强而非缺口”，本表不重复。

## 1. F01 全局助理 Jarvis

### 现状（OpenArc）
- 前端入口已存在：默认 UI 是 Vue 壳（electron/main.cjs:222-227，OA_UI=react 才回退旧 React；默认 dist/vue.html）。全局 AI 浮层 src-vue/shell/AssistPanel.vue（225 行）：Dock/Store 通过 shell.aiOpen 控制（src-vue/stores/shell.ts:192、431-434），浮层只有输入 + 当前任务卡（AssistPanel.vue:9-14）。
- 桥接：AssistPanel 只拿 window.openarc.task（AssistPanel.vue:15），命令为 task/run、task/get、task/cancel、task/resume、task/acknowledgeUnknownEffect，并订阅 task/result 事件（AssistPanel.vue:53-140）；task 命令白名单见 electron/task-bootstrap.cjs:106。
- 执行：task 桥 → task-service/task-harness-orchestrator（DSH Harness + Tool Facade + 审批 + 模型代理；task-harness-orchestrator.cjs:119-238、313-380、540-620、750）。全局助理可“派发任务”，写操作需审批（ChatApp.vue:170 文案“写操作会先请你确认”）。
- Agent 桥存在但默认 UI 不用：electron/preload.cjs:162-176 暴露 openarc.agent.command/onEvent；electron/agent-domain.cjs:46-100 的命令白名单（agent/project/run、agent/tool/call、agent/capability/route 等）；Vue 壳内没有任何 window.openarc.agent 调用（src-vue/ 全量 grep 为 0），只有旧 React 控制台 src/projects/TaskConsole.tsx 使用（taskConsoleLogic.ts:894）。
- profile system-jarvis 只有定义：electron/agent-runtime-profiles.cjs:8-13；全仓无 system-jarvis 的调用点（grep 仅 profiles 1 处）。

### 差异（相对 DX 0.6.1 F01）
1. 链路不同：DX 是 Dock orb → agent gateway（POST /api/agent/gateway/run-stream SSE）→ profile system-jarvis（AI-ORG §2.1）；OpenArc 是 Dock orb → task/run → DSH Harness。等价性取决于“全局助理能做什么”，而两者工具面不同。
2. 能力面不同：DX system-jarvis 的客户端工具包含 open_app/music_play/music_control/create_project_task 与文件类工具（JARVIS_CLIENT_TOOL_NAMES，AI-ORG §2.3）；OpenArc Harness 的 Tool Registry 只注册 test/resource.read.metadata/resource.search/browser.read.page/browser.navigate/canvas.read/canvas.edit/resource.trash/resource.read.content/resource.save.text + 动态 MCP 合同（electron/tool-registry.cjs:8-11、70-320），**没有** open_app/music/media/file 工具。
3. 无 capability_discover 渐进披露：OpenArc 的 capability discovery（electron/progressive-capability-router.cjs）只服务 agent 路径（project agent/react driver），不在 task harness 的全局助理链路。
4. 无 profile/能力边界：task harness 靠 Tool Facade 合同 + 审批，不存在 system-jarvis 的 capabilityScopes ∩ capabilityBoundary。
5. SSE 形态不同：DX 有 run-stream/step-stream 事件；OpenArc task 桥是 task/result 事件 + task/get 快照（AssistPanel.vue:35-60）。

### 需要改的实现点（若以 DX 0.6.1 F01 为验收口径）
- 默认 Vue 壳的全局助理接 agent 路径：AssistPanel 增加/切换到 window.openarc.agent.command，构造 source{type:desktop, appId:"agent", entryPoint:"jarvis-overlay"}、profileId:"system-jarvis" 的 envelope（OpenArc envelope 已支持该结构）。
- 打通 system-jarvis 运行入口：在 agent-service 增加对应的 run 命令（当前白名单没有 jarvis/global 命令），并让 RunManager（agent-runtime-manager.cjs:109-171）按 capsule 过滤工具与能力。
- 工具面：把 system（open_app/music）、媒体、file、canvas 客户端工具接入 agent 路径（agent-tool-catalog.cjs 已有这些 descriptor；缺的是运行时注入与客户端执行器回调）。
- 若坚持 task harness 为等价实现：需在 Tool Registry 增补系统/媒体/文件客户端工具与 capability 披露，并补审批覆盖，否则不能宣称与 DX F01 等价。

### 涉及文件
- src-vue/shell/AssistPanel.vue、src-vue/stores/shell.ts、src-vue/shell/Dock.vue、src-vue/apps/ChatApp.vue
- electron/preload.cjs（agent 桥已暴露）、electron/agent-bootstrap.cjs、electron/agent-domain.cjs、electron/agent-service.cjs
- electron/agent-runtime-profiles.cjs、agent-runtime-envelope.cjs、agent-runtime-manager.cjs、agent-kernel.cjs、agent-tool-catalog.cjs
- electron/task-bootstrap.cjs、task-service.cjs、task-harness-orchestrator.cjs、tool-registry.cjs（若走 harness 路线）

### 验收点
- 在默认 Vue 壳内从 Dock orb 发起“打开应用/播放音乐/读写项目文件/生成一张图片/MCP 查询/运行技能”，每条都能得到成功/失败的结构化结果。
- 写操作先审批、拒绝后 0 副作用；事件流能驱动任务卡状态（运行/等待/完成/失败）。
- 非法 profileId/entryPoint/能力边界被 403；渲染层自报身份被忽略（主进程注入 actor）。
- 对照 DX：system-jarvis 的能力清单在 OpenArc 侧有明确映射表（或产品明确接受 task harness 口径）。

## 2. F03 项目文件助手（三模式）

### 现状
- 代码已移植且可运行：electron/project-agent-mode.cjs:230-487（runProjectAgentMode），envelope 固定 source{type:project, entryPoint:project-assistant}、profileId project-assistant、interactionPolicy confirm-risky（:235-242）；能力发现 → 工具执行 → 独立完成验收（:375-406）。
- 入口：agent:command “agent/project/run” 分发（electron/agent-domain.cjs:89；electron/agent-service.cjs:727-748），会话/项目权限校验（accessOrForbidden）；只有旧 React TaskConsole 调用（src/projects/taskConsoleLogic.ts:894、TaskConsole.tsx 由 src/App.tsx:2855 挂载，仅 OA_UI=react）。
- 默认 Vue 壳：src-vue/apps/ProjectsApp.vue（152 行，仅项目创建/列表）与 FilesApp.vue（783 行，文件操作）均无 Agent/任务入口（grep agent|task|converse 为 0）；无 /projects/:id/converse 等价 HTTP 面。
- 语义：maxSteps=18（project-agent-mode.cjs:312）、单 Run 工具 40 次（:412）、验收不通过最多回 2 次（:395），超限返回 complete:false；无 30 分钟执行窗口/续跑问题；Agent 运行在 main 进程同步 IPC，没有项目 Agent 的 worker/后台队列（electron 仅有 video-render-worker.cjs 用于视频渲染）；taskId 场景不调用 complete/fail（由任务域接管）。
- 检查点：仅 core.agentRuntime.append("loop.checkpoint", snapshot)（:325-330），session.saveCheckpoint 未传（agent-service.cjs:738 只传 requestId/threadId），无 task_checkpoints 持久化/恢复。

### 差异
1. 控制模型落后：DX 0.6.1 是 maxSteps=null、无工具次数上限、验收不通过无限回退、每 30 分钟一个用户续跑窗口（AI-ORG §2.1、§5.2；shared/projectAgentExecutionPolicy.ts:1-11）；OpenArc 仍是 0.5.5 的 18/40/2 硬上限（对照既有 0.5.5 报告附录 D 的记录）。
2. 无续跑窗口：OpenArc 无 PROJECT_AGENT_CONTINUE_QUESTION/窗口过期/“继续任务”答问语义；长任务只能一次性跑完或失败。
3. 无后台执行：DX 有 worker 领取任务、心跳续租、checkpoint 恢复、用户答问后重入；OpenArc 没有项目 Agent 的后台 worker（electron 目录只有 video-render-worker.cjs，用于视频渲染；项目 Agent 由 agent-service 在 main 进程同步 IPC 执行）。
4. 默认 UI 无入口：DX 是项目/文件应用内的 assistant/thinking/agent 三模式（/api/projects/:id/converse）；OpenArc Vue 壳没有该入口，React 控制台是可选旧 UI。
5. 工具选择：项目 Agent 走 agent toolCatalog（7 组）与 capability_discover，这部分与 DX 0.5.5/0.6.1 基本一致；差异集中在“上限/窗口/后台化/UI”。

### 需要改的实现点
- 对齐 0.6.1 的 projectAgentMode：state.maxSteps=null、去掉 40 次上限、验收不过持续回退；引入 30 分钟窗口常量与“继续任务”问句，窗口到期 checkpoint + waitForUser，用户答复后续跑（可在 task 域实现）。
- 项目 Agent 后台化：接 worker/队列 + lease/heartbeat + task_checkpoints 持久化/恢复（对齐 DX worker.ts:40-90 的恢复语义：未回填调用按失败记账，不自动重试副作用）。
- 默认 Vue UI：ProjectsApp/FilesApp 增加 assistant/thinking/agent 三模式入口（或统一“项目 Agent”面板），并接 agent/project/run 或 task 桥。
- 保留 DX 的完成验收器与 artifact 门禁（OpenArc workspace/artifact 代码已有，需确认项目 Agent 运行也走 runManager.complete 的 artifact 校验）。

### 涉及文件
- electron/project-agent-mode.cjs、agent-service.cjs、agent-domain.cjs、task-bootstrap.cjs、task-service.cjs、task-harness-orchestrator.cjs
- electron/agent-runtime-manager.cjs、agent-runtime-tool-loop.cjs、agent-runtime-workspace.cjs、agent-kernel-store.cjs、task-store（checkpoint 持久化）
- src-vue/apps/ProjectsApp.vue、src-vue/apps/FilesApp.vue、src/projects/TaskConsole.tsx（旧 UI，仅参考）

### 验收点
- 三模式在默认 Vue 壳可用，assistant 走即时/任务、thinking/agent 进入后台队列。
- 单任务工具调用可超过 40 次而不被硬中断；30 分钟后进入“等待继续”，答复后可续跑，checkpoint 在进程重启后可恢复。
- 完成验收不通过 → 继续补齐直到通过或用户停止；失败/暂停/取消状态与事件可查。
- 文件作用域仍在项目根内，越权路径/系统共享目录被拒绝。

## 3. F04 第三方 App Agent

### 现状
- 声明解析与投影已存在：developer-domain.cjs 解析 manifest.agent（summary/toolManifest/skillDocs，:757-819）、capabilities.tools、permissions、canvas 节点动作（:1007-1060）；developer-app capsule 定义（agent-runtime-profiles.cjs:30-33）；RunManager 对 developer-app 的过滤代码（agent-runtime-manager.cjs:117-122 入口限制、:146-155 只留本 APP 的 app 工具）；agent-tool-catalog 的 app source（appTool，:288-325）。
- 工具目录会把 APP 声明的工具投影为 source:app，并按 APP 打开权限过滤（canUseAppPermission，agent-tool-catalog.cjs:122、290-305）。
- 自动化/画布动作投影：developer-domain.cjs projectDeveloperAppActions（:1020-1060）只投影真实有执行出口的工具/画布 agent-tool run 动作。

### 差异
1. 无运行入口：DX 有 /api/market/developer-apps/:id/agent/{session,run,tasks,runs,...}，以 envelope source{type:app, appId, entryPoint:"developer-app-bridge"}、profileId developer-app 运行（AI-ORG §2.1）；OpenArc 的 agent:command 白名单没有 developer/app-agent 命令，agent-service 也没有 app 作用域运行分支。
2. 无权限码：DX 要求 APP 清单声明 app.<id>.agent.run 且 canOpenApp 通过（PLATFORM §6）；OpenArc 没有该权限码的校验点（全仓 grep agent.run 无运行时校验）。
3. 无 capabilityBoundary：DX developer-app 固定 ["media.*","file:*","app:<id>:*"]（index.ts 9989）；OpenArc 有通用 boundary 过滤（agent-runtime-manager.cjs:156-166），但没有为该入口构造固定边界。
4. 无项目/会话隔离：DX 为每个 APP+用户建独立 project/thread/session 并校验 appId+projectId+sessionId（developerAgentScope/TaskScope/RunScope）；OpenArc 没有 app agent session/project 绑定。
5. 只有声明投影，无执行闭环：APP 工具的 frontend-bridge 仅天气映射、skill/mcp-tool 有映射，app-api 仍未接入（runCatalogTool 抛“已登记但未接入”，agent-tool-catalog.cjs:560）。

### 需要改的实现点
- 增加 developer app agent 命令/入口（例如 agent/developer-app/run），强制 entryPoint developer-app-bridge、appId 必填、profileId developer-app；复用 RunManager 现有过滤。
- 权限：执行前校验 APP 清单 permissions 含 app.<id>.agent.run，且当前用户 canOpenApp；拒绝跨 APP。
- 边界：构造固定 capabilityBoundary（media.*、file:*、app:<id>:*），并只允许本 APP 的 app tools。
- 隔离：按 appId+userId 确保独立项目根/线程/session；run/task 查询按该作用域过滤。
- 工具执行：补齐 APP 工具 handler 映射（尤其 app-api 或明确产品不支持），否则投影了工具但执行会失败。

### 涉及文件
- electron/developer-domain.cjs、developer-service.cjs、developer-store.cjs、agent-service.cjs、agent-domain.cjs
- electron/agent-runtime-profiles.cjs、agent-runtime-manager.cjs、agent-tool-catalog.cjs、agent-tool-resolver.cjs
- electron/authorization-service.cjs / authorization-domain.cjs（app 权限）、agent-task-store.cjs（project/thread）

### 验收点
- APP 声明 app.<id>.agent.run 后，只有本 APP/本用户/本会话能运行；未声明的 APP 403。
- 子能力只出现 media/file/本 APP app 工具；其他 APP 工具、系统工具被过滤。
- 跨 APP appId/project/session 混用被拒绝；运行记录/产物只能按作用域查询。
- 无权限、未安装、APP 被停用时返回结构化错误码，且 0 工具/0 模型调用。

## 4. F05 envelope + 5 内置 profile

### 现状
- envelope 逐字移植：agent-runtime-envelope.cjs:50-127（schema dx-agent-request/v1、source 枚举、interactionPolicy、goal 20000、app 来源必须 appId、actor 身份覆盖、scope/capabilityBoundary/modelPreference/deliveryTarget/correlation）；schema 校验（:179-239）与 middleware 管线（:138-161）也移植。
- profiles 逐字移植：agent-runtime-profiles.cjs:8-50（system-jarvis/conversation/project-assistant/canvas-agent/developer-app 的字段、预算、入口、能力域与提示词）。
- 准入逐字移植：agent-runtime-manager.cjs:109-171（profile 不存在 400、来源/入口 403、developer-app 必带入参、developer-app app 工具过滤、capabilityScopes∩boundary、系统提示追加）。
- contracts：agent-contracts.cjs:16-49（AGENT_REQUEST_SCHEMA_V1、x_dx_capability、capability_discover、supervisor 状态、capabilityMetadata）。
- kernel：agent-kernel.cjs:289-330 prepareAgentTurn（trace/capabilityRouter/context/capabilities）。

### 差异 / 收口点
1. actor 形状：envelope 支持 actor 为字符串（:41-44）以兼容 B4 传 userId；但 RunManager.create 使用 context.actor.id（agent-runtime-manager.cjs:177）。若调用方传字符串，create 的归属校验会失效/抛错。当前 agent-service 的 resolveActor 传的是用户对象（:798-805），主链路安全；属口径收口点而非现存故障。
2. developer-app 入口：profiles 里存在，但 F04 没有运行入口，因此该 capsule 实际不可达。
3. 5 个 profile 中只有 project-assistant 被实际使用（project-agent-mode.cjs:237-239）；system-jarvis / canvas-agent 无调用点；conversation 未被 agent 路径使用（ChatApp 走 task 桥）。
4. organizationId：envelope 接受并透传（:74-77），无任何消费点（与 DX 0.6.1 相同，DX 也未用于授权）。
5. 预算字段（maxModelCalls/maxToolCalls）在 RunManager 里只作为 capsule 数据携带，未见强制执行点（DX 0.6.1 同样在 profile 里定义，执行上限由 loop 控制）；OpenArc agent-runtime-tool-loop 有 maxSteps 控制。

### 需要改的实现点
- 统一 actor 契约：要么只接受 AuthUser 对象，要么在 RunManager.create 用 envelope.actor.userId/兼容字符串。
- 让 5 个 capsule 真正可达：F01（system-jarvis）、F03（project-assistant 已有）、F04（developer-app）、canvas agent（画布 agent-panel 入口）分别接运行入口；否则 profiles 只是静态数据。
- 若保留 budget 字段，明确由哪一层消费（loop maxSteps/usage）并在测试中断言。

### 涉及文件
- electron/agent-runtime-envelope.cjs、agent-runtime-profiles.cjs、agent-runtime-manager.cjs、agent-contracts.cjs、agent-runtime-deps.cjs、agent-kernel.cjs、agent-runtime-tool-loop.cjs、agent-service.cjs

### 验收点
- 5 个 profile 的 (sourceType, appId, entryPoint) 准入矩阵：命中放行、不命中 403；profileId 不存在 400。
- capabilityScopes ∩ capabilityBoundary 的交集正确（含通配 *），未被授权的工具/能力不出现在 route.tools。
- actor 伪造（渲染层给 userId/appId/role）被忽略；字符串 actor 场景不产生空归属。
- developer-app 只能从 developer-app-bridge 入口、只保留本 APP 工具。

## 5. F06 toolCatalog 7 组工具

### 现状
- 工具目录逐字移植：agent-tool-catalog.cjs 定义 5 个 source type（:12），七组工具：systemTools（open_app/music_play/music_control，:146-208）、capabilityTools（media_* 10 个，:389-440）、fileTools（fs_* 11 个，:221-247）、developerTools（APP 声明，:288-325）、canvasTools（:327-331）、mcpTools（mcp__<server>__<tool>，:333-358）、skillTools（skill__<id>，:360-387）。
- 元数据逐字：x_dx_capability（id/domain/intents/appId/requiredContext，agent-contracts.cjs:29-41、agent-tool-catalog.cjs:34-52）；ToolDescriptor 字段与 DX 相同；listToolDescriptors 顺序 system/capability/file/app/canvas/mcp/skill（:457-467），snapshot summary（:477-497）。
- 执行入口：runCatalogTool（:510-563）分派 system-capability→callSkill、app→权限+frontend-bridge(天气)/skill/mcp-tool、其余抛“未接入”；客户端工具禁止服务端执行（:513）。
- 依赖装配：agent-service.cjs buildMcpCatalogSource/buildSkillCatalogSource/buildCanvasCatalogSource + configureToolCatalog（:224-270、346-420）；tool-resolver（agent-tool-resolver.cjs）负责按名解析与权限判定；capability-discovery（capability-discovery.cjs）与 progressive-capability-router（176 行）已移植。
- canvas 工具：canvas-dxos-capabilities.cjs buildCanvasKernelCapabilities（:132-170）从注入的 nodeTypes/extraTools 生成 canvas_create_node/operate/execute/run_workflow/compose/rename/move/resize/group/ungroup/connect/disconnect/delete/arrange 等，与 DX canvasKernelCapabilities.ts 同构。

### 差异 / 待验证
1. canvas 动态枚举：DX 从实时 BUILTIN_CANVAS_NODES + 插件 registry 计算 nodeTypes/operationIds/actionIds；OpenArc 由 canvas-dxos-commands.cjs:254 传入 nodeTypes，agent-service 装配处需确认 nodeTypes 是否来自实时 registry（buildCanvasCatalogSource(canvasExtension)）。若注入空数组，则 enum 为空/描述不完整。
2. app 工具执行映射：DX 支持 skill/mcp-tool/frontend-bridge(天气) 且 app-api 明确未映射；OpenArc 相同，但 mcp-tool 调用参数形式为 callMcp(toolName,args,{serverId,actor})（:557-559），DX 是 callDirect(serverId,toolName,args)，需核对注入实现是否等价。
3. 客户端工具执行器：DX 客户端执行集合（open_app/music/canvas + 会话文件工具）在渲染层；OpenArc 的 agent 路径没有客户端 executor 回调（F01 差异的一部分），因此这些 descriptor 在 agent 路径“可见但不可执行”。
4. 去重：OpenArc 比 DX 多了 mergeDescriptors 名称去重（:442-455），属加强，不构成缺口。
5. 能力发现：progressive-capability-router 的 discover 激活/目标回填与 DX 同构，需用测试确认 7 组 intents 全覆盖。

### 需要改的实现点
- 确认/补齐 canvas nodeTypes、extraTools 的实时来源（registry→configureToolCatalog），保证 enum 与节点类型同步。
- 补齐客户端工具执行器（F01）或明确 agent 路径不支持；否则 F06 的 system/canvas 工具只有声明没有执行。
- 核对 app 工具 mcp-tool 的执行适配签名；补 app-api 的执行口或产品声明。
- 增加工具目录快照测试（7 组计数、source 分布、x_dx_capability 合法性、风险/副作用映射）。

### 涉及文件
- electron/agent-tool-catalog.cjs、agent-tool-resolver.cjs、capability-discovery.cjs、progressive-capability-router.cjs、agent-contracts.cjs
- electron/agent-service.cjs、canvas-dxos-capabilities.cjs、canvas-dxos-commands.cjs、mcp-tool-contract.cjs、skill-service/skill-runner

### 验收点
- 工具目录快照：7 组均出现，source 分布正确，每个工具 x_dx_capability.schema=dx-agent-capability/v1。
- capability_discover 能按 intents/domains 激活对应工具，未激活工具不出现在 tools。
- runCatalogTool：system-capability→skill、app→权限+frontend-bridge/skill/mcp-tool、客户端工具拒绝服务端执行；错误码稳定。
- canvas 工具 enum 与当前节点/操作/动作一致（新增节点后自动出现）。

## 6. F10 监督子代理 + 检查点/验收

### 现状
- supervisor 逐字移植：agent-kernel-supervisor.cjs:37 限额（maxDepth 3/maxChildrenPerRun 8/maxParallelPerRoot 3）；:93-103 capabilityGrantForProfile（父能力∩profile scopes）；:105-122 validateSpecs（key/依赖/reviewer 单依赖/schema）；:124-209 delegateAgentWork（profile 校验、request_hash 去重、task+run+workspace、agent_delegations、child.created 事件）；:218-300 reviewer 单轮纠错；:303-313 recordAndScheduleReviewerDecision；:335-440 tree/steer/stop/cancel 导出。
- 检查点契约逐字移植：agent-checkpoint-contract.cjs:14-26（6 phase、state 字段含 turnId/pendingToolCalls 等），与 DX shared/agentCheckpointContract.ts 完全一致。
- 生命周期检查点：agent-runtime-manager.cjs:78-99 在 waitForUser/complete/fail/cancel 时 appendAgentCheckpoint（phase waiting_user/terminal），属对源 runManager 的扩展。
- agent_kernel_store/agent-kernel：agent_runs/agent_run_events 持久化、事件链、delegate_agents 工具（agent-react-driver.cjs:852 调 supervisor.delegateAgentWork）。

### 差异
1. 内置 profile 种子缺失：DX ccsDb 有 4 条内置 agent_profiles（general/researcher/maker/reviewer，AI-ORG §2.5 引 ccsDb:726-730）；OpenArc 只建了 agent_profiles 表（dxos-foundation-schema.cjs:257-262），DX 迁移里的种子 INSERT 被明确“不抽取”（dxos-foundation-schema.cjs:43-46），且全仓没有补种代码（grep 无 INSERT INTO agent_profiles）。后果：listAgentProfiles() 为空 → delegate_agents 的 profile enum 为空/委派必失败；reviewer 门禁无 reviewer profile 可用（agent-kernel-supervisor.cjs:78-86 查询 enabled=1）。
2. 无持久化检查点恢复：project agent 的 session 不传 saveCheckpoint（agent-service.cjs:738-743），checkpoint 仅作为 loop.checkpoint 事件 append（project-agent-mode.cjs:325-330）；没有 task_checkpoints 落库/重启恢复，也没有 worker 续租。
3. 无委派管理面：DX 有 /api/agent/runs/:id/delegations、children/steer、children/stop 等 HTTP 面（AI-ORG §2.5）；OpenArc 只有 supervisor 内部调用与 agent 事件，无对应命令/IPC（agent-domain.cjs 白名单无 delegation 命令）。
4. 没有任务/Agent 后台 Run：DX worker 领任务、心跳、恢复；OpenArc 项目 Agent 同步跑在 main 进程（见 F03；electron 仅有 video-render-worker.cjs 处理视频渲染）。
5. reviewer 纠错链代码在，但因 1 不可达（reviewer profile 不存在）。

### 需要改的实现点
- 补 4 条内置 agent_profiles 种子（general/researcher/maker/reviewer，字段对齐 DX ccsDb：capability_scopes_json/model_profile/max_model_calls/max_tool_calls/allowed_risks_json/system_prompt/enabled/builtin），并保证升级迁移幂等（INSERT OR IGNORE）。
- 让 delegate_agents 工具在 profile 集非空时暴露 enum；委派/评审端到端流程接 worker/任务域（含 run/task/workspace 创建）。
- 项目 Agent 检查点：把 checkpoint 快照持久化到 task_checkpoints（或等价表），进程重启后恢复；明确“工具结果未知不重试副作用”的恢复语义。
- 可选：补委派管理命令（list/steer/stop/cancel）以对齐 DX 的管理面。

### 涉及文件
- electron/dxos-foundation-schema.cjs（种子/迁移）、identity-store.cjs（迁移执行）、agent-kernel-supervisor.cjs、agent-react-driver.cjs、agent-service.cjs、agent-domain.cjs
- electron/agent-runtime-manager.cjs、agent-checkpoint-contract.cjs、agent-kernel-store.cjs、agent-task-store.cjs、task-service.cjs/task-bootstrap.cjs、worker（若新增）

### 验收点
- 4 条内置 profile 可查、enabled、能力域/风险白名单正确；重复迁移不重复插入。
- 委派：≤8 子、深度≤3、request_hash 去重、子能力=父∩profile、依赖顺序校验。
- reviewer：拒绝→创建纠正 producer+二次 reviewer→二次拒绝记 skipped_attempt，不产生第三轮。
- 检查点：进程重启后能从最后 checkpoint 恢复（未回填调用不重试副作用）；事件序列完整。
- 管理面：能查询委派树、steer/stop，权限只允许同一用户/项目。

## 7. F14 配额账本

### 现状
- 账本原语：dxos-foundation-quota.cjs:38-155 createQuotaLedger：reserve（同 id 冲突拒绝、按部门+平台或部门总额度校验、微元正安全整数）、settle（completed→spent，其余→released，只结算 reserved）、usageFor（reserved+spent 不含 released）、remainingMicros（总额度与平台规则取更紧）、listRules/saveRule/removeRule；缺表 fail-closed（DXOS_ERR_QUOTA_LEDGER_MISSING）。
- 表：v1 三张 api_quota_rules/api_quota_usage/api_model_access（dxos-foundation-schema.cjs:212-216、269-272）；v2 api_quota_rules_v2 被明确排除（:63-70，理由：0.6.1 计费配额属云计费不入移植）。
- 接线：createQuotaLedger 全仓无调用方（grep 只有定义与导出）；model-service/agent-service/src-vue 无 quota 引用（grep 0）；UI 无配额面板。

### 差异
1. 规则模型：DX 0.6.1 用 api_quota_rules_v2（scope_type user|department、subject_id、provider_id、period total|monthly、limit_amount），并把 v1 迁移到 v2（apiQuota.ts:76-96）；OpenArc 只有 v1（部门×平台、无用户 scope、无 period）。
2. 计价：DX 有 estimateApiQuotaCost（CNY pricing、resolution_tiers 1k/2k/4k、video_seconds、count/duration、上限校验）；OpenArc 无任何计价函数。
3. 接线：DX 在 reserve 时事务内双作用域校验、任务终态 settle、旧直连入口在有限制时拒绝、/api/ai/models 按部门模型白名单过滤；OpenArc 账本未接模型调用，api_model_access 无过滤实现。
4. 计费范围：DX 仅 image/video 计费、LLM 不计费；OpenArc 连 image/video 也未接。
5. 若产品判定“计费/配额 OUT”（与 F17 云权益同口径），则该项可记不适用；否则需补。

### 需要改的实现点（若以 DX 0.6.1 为验收口径）
- 建 api_quota_rules_v2（或等价 user/department×period 规则表）+ 从 v1 迁移；保存/删除规则命令与 UI。
- 计价器：CNY 价格、分辨率档/视频秒、count/duration 校验、微元换算（SCALE=1e6）。
- 接线：模型/媒体任务提交前 reserve（用户+部门双作用域）、终态 settle、旧直连入口拒绝、模型目录按部门白名单过滤。
- UI：部门配额/模型白名单配置（可复用 Governance/设置面板），以及用户可见的剩余额度。

### 涉及文件
- electron/dxos-foundation-quota.cjs、dxos-foundation-schema.cjs、identity-store.cjs（迁移）
- electron/model-service.cjs（模型调用前置/结算）、media 域提交点、agent-service（媒体能力调用）
- src-vue/settings/ModelSettings.vue、GovernanceApp.vue、Accounts/配额面板

### 验收点
- 规则：部门/用户、平台/总额、total/monthly 组合；超限拒绝且不写入 usage。
- 流程：reserve→reserved；completed→spent；failed/cancelled→released；重复 id 冲突；金额精度微元。
- 模型白名单：部门限制时未授权模型不可见/不可调用；旧入口拒绝。
- UI 与账本一致：剩余额度=limit-used-reserved。

## 8. F15 数据隔离

### 现状（OpenArc 已有）
- 统一授权域：authorization-domain.cjs:105-110 SCOPE（PERSONAL/DEPARTMENT/ORGANIZATION）、:149-233 ACTION/角色（VIEWER/CONTRIBUTOR/EDITOR/MANAGER/OWNER）、:478-545 决策（OWNER/显式 USER grant/DEPARTMENT grant/ORG 基线；PERSONAL 仅 owner/显式 grant）；authorization-service.cjs 1278 行命令面；authorization-store.cjs 持久化 grants。
- 项目：integration-service.cjs:13 PROJECT_ROLE（viewer/editor/manager）、:37-59 #projectAccess（组织匹配、owner、成员、部门成员/部门管理员），成员 CRUD/资源关联。
- 共享盘：platform-domain.cjs:72-73 platform/fs/shared/roots|list；platform-service.cjs:557-590 filesSharedCommand；src-vue/apps/sharedDrive.ts:5-8,131-133 显示 public/department 共享根（权限判定在主进程）。
- 画布：canvas-domain.cjs:328（visibility ORGANIZATION + organization_id）、:333-348 授权 action 判定（READ/EDIT/MANAGE_ACCESS/SHARE/DELETE/RESTORE/PERMANENT_DELETE）；canvas-dxos-asset-library.cjs 资产库 visibility（org/personal）。
- 线程/任务：agent-task-store.cjs:283-300 createThread 默认 visibility=project、支持 private；:490 删除 private 线程按 created_by；:627 列表按 visibility!='private' OR created_by；:1682 threadVisibility。
- 其它域：photocraft（private/public/restricted+members，photocraft-projects）、developer collab（visibility private/public/restricted + members/invite code hash）、resource domain（scope/owner/版本/标签）。

### 差异
1. 模型映射不是 1:1：DX 的 fs 是 ownerId + share（public / department:<id> / canvas:<id> / asset-library:<id>）（AI-ORG §4.6、fs.ts:880-968）；OpenArc 用资源库 scope + 共享盘 roots，share 语义（public/department）在 platform 层实现，但文件 ownerId/部门根/画布共享标记的对应关系需要一张映射/验收表。
2. 画布 ACL：DX 有 canvases.visibility public|restricted + canvas_members + canvas_invites/canvas_invite_members（邀请权限 read|edit，canvas.ts:709-738）；OpenArc canvas-domain 未使用 canvas_invites（grep 0），访问走授权 ACTION/GRANT；邀请码等价物缺失（若产品要求邀请加入画布）。
3. 项目成员：DX project_members(role owner|member, can_create_tasks)（taskStore.ts:44-89）；OpenArc integration-service 用 viewer/editor/manager，另有 DX 表 project_members 在 schema 中；两套角色的映射（owner/member→manager/editor/viewer）需确认，can_create_tasks 语义无直接对应。
4. 资产库：DX asset-library share + canvasAssetLibraryAccess（developer_collab ACL）；OpenArc canvas-dxos-asset-library 用 visibility org/personal + 成员（需确认是否等价）。
5. app_access_rules：DX 按 app 打开规则（all/superadmins/admins/departments，auth.ts:736-751）；OpenArc 走授权 GRANT/APP 权限（F13 判定已实现），但 F15 的“资源范围”映射需确认 App 权限与资源 scope 的组合。
6. 线程可见性：OpenArc 已有 private/project 过滤（与 DX 同构，默认 project），属等价；但列表/历史的默认参数需测试。

### 需要改的实现点
- 建立“DX 资源模型 → OpenArc 资源授权模型”的映射表：fs share（public/department/canvas/asset-library）↔ 资源 scope/共享盘；canvas 邀请 ↔ grant/manage_access；project_members role ↔ PROJECT_ROLE；资产库 ACL ↔ 资源库 ACL。
- 若要求画布邀请：补 invite code/成员表与 read|edit 权限（或明确由 grant 替代并更新验收口径）。
- 项目创建任务权限：对齐 can_create_tasks 语义（谁能创建任务/追加步骤）。
- 删除/恢复/清理权限：DX 有 owner-only 删除、回收站恢复、部门删除迁移；OpenArc 需逐域核对（resource trash 已有 side-effect verifier；canvas delete 走 ACTION.DELETE；线程/项目删除权限需确认）。

### 涉及文件
- electron/authorization-domain.cjs、authorization-service.cjs、authorization-store.cjs
- electron/resource-domain.cjs、resource-service.cjs、platform-domain.cjs、platform-service.cjs
- electron/canvas-domain.cjs、canvas-dxos-collab.cjs、canvas-dxos-asset-library.cjs、photocraft-projects/模型
- electron/integration-service.cjs、agent-task-store.cjs、task-service.cjs
- src-vue/apps/SharedDrivePanel.vue、ResourceLibraryApp.vue、GovernanceApp.vue

### 验收点
- 同一用户对 fs/资源库/画布/资产库/项目/线程的可见性口径一致（映射表逐项通过）。
- PERSONAL/DEPARTMENT/ORGANIZATION/显式 grant 四条路径的正反例；越权返回稳定错误码。
- 画布：owner/授权/公开/组织可见与编辑、删除/恢复/管理访问权限；邀请（若保留）read|edit 生效。
- 线程：private 仅创建者可见；project 对项目成员可见；默认可见性与 DX 一致。
- 项目：viewer/editor/manager 与 owner/member 的映射有测试；无权限者不能创建任务/追加步骤。

## 9. F16 桌面自动超管会话

### 现状（OpenArc）
- 默认 UI 有首启初始化向导：src-vue/identity/SetupScreen.vue:1-60（三步：显示名 → 登录账号 name@openarc.local → ≥8 位管理员密码；末步提交前只校验两次密码一致），并有 LoginScreen/LockScreen/BootSurface（src-vue/identity/）。
- 账号/会话：local-account-service.cjs:325-360（auth/status、bootstrap 首建超管 + 登录、login、logout），密码 scrypt，会话由 identity-service/identity-store 管理（sessionRef，不把 token 暴露给渲染层；identity-bootstrap.cjs:264-358 处理登出/锁屏/审批投影）；session-secret-store 持久化会话密钥。
- IPC/桥：preload.cjs:40-70 只有 identity.command/onEvent 与 authorization 只读查询；没有任何 ensureLocalAdminSession / 桌面超管自动会话；electron 全仓 grep DX_DESKTOP_AUTH_SECRET/desktop-session/autoLogin 为 0。
- 渲染层身份：主进程从当前 authenticated session 注入 actor/sessionRef，渲染层自报 userId/role/appId 被忽略（preload 注释 :179-200）。

### 差异
1. 语义相反：DX 0.6.1 是“桌面主窗口自动获得 superadmin 会话”（main.cjs 生成 DX_DESKTOP_AUTH_SECRET → IPC ensure-local-admin-session → POST /api/auth/desktop-session → 写 ccs_session Cookie；AI-ORG §1 结论 9、§4.1），无需密码；OpenArc 是显式初始化 + 登录/锁屏，渲染层拿不到 token，多用户/组织模型下更严格。
2. 无等价 secret/IPC/路由；无“主窗口=超管”的约定，也没有 loopback+主窗口限制的自动会话入口。
3. 风险面不同：DX 自动超管会话意味着本机主窗口即最高权限；OpenArc 至少需要密码/锁屏，属安全加强而非功能缺口。

### 需要改的实现点
- 若产品要求 DX 单机体验：新增受控的本机会话 IPC（仅主窗口主 frame、仅 loopback、一次性 secret 由主进程生成且不落盘/不进渲染层）+ 服务端等价的短时会话签发；并明确它与多用户/锁屏语义的冲突处理。
- 若保持现状（推荐按 OpenArc 现有安全模型）：记“不适用（有意差异）”，在验收口径中写明“桌面首次使用需初始化/登录；不存在自动超管会话”。

### 涉及文件
- electron/preload.cjs、local-account-service.cjs、identity-service.cjs、identity-bootstrap.cjs、session-secret-store.cjs
- src-vue/identity/SetupScreen.vue、LoginScreen.vue、LockScreen.vue
- （若新增）electron/main.cjs、agent/identity 的 IPC 注册与测试

### 验收点
- 首启：未初始化时只能进入 SetupScreen；初始化后必须登录/解锁；错误码稳定。
- 会话：sessionRef 只在主进程；渲染层无法读取/伪造 token、userId、role；登出/锁屏后旧会话失效。
- 多用户：切换用户不泄漏上一用户数据；锁屏期间后台任务/审批行为明确。
- 若新增自动会话：仅主窗口主 frame + loopback，secret 不出主进程，失败不降级为密码绕过。

## 10. 跨项依赖与审计备注

- F01 与 F06/F05 强耦合：全局助理要“能调用每个功能”，必须同时有 agent 路径（F01）+ 工具目录装配（F06）+ profile 准入（F05）+ 客户端执行器；只补 UI 不补执行/工具面无法通过验收。
- F03 与 F10 强耦合：项目 Agent 的时间窗/续跑依赖检查点持久化与后台执行（F10 的 worker/恢复能力）；建议同一批次验收。
- F04 依赖 F05 的 developer-app capsule 与 F06 的 app 工具执行映射；F04 完成后 F05 的 developer-app 收口点才真正可用。
- F14 与 F15：配额依赖部门/用户身份与模型白名单；若组织域（authorization）未对齐，配额按部门/用户作用域无法验收。
- F10 的内置 profile 种子属于“数据迁移/种子”，与 F14 的 v2 规则同属“schema 已建、数据/逻辑未接”的同类问题；建议在审计后单列“种子与迁移”任务，避免散落在各域。
- 既有 GAP-TASK-COVERAGE.md/OPENARC-DX-MAPPING.md 中 F01/F03 “Vue 无入口/未检出”的旧结论已被本次源码核对修正：AssistPanel 已存在且走 task 桥；F01 的真实缺口是“不是 agent 路径 + 能力面不足”，不是“没有全局助理”。

## 11. 未确证项

1. 【未知】F01 的等价口径：产品是否接受“task harness 为全局助理的等价实现”。若接受，F01 的差异应记为“实现不同、能力面待补”；若不接受，需按 DX agent gateway 补齐。
2. 【未知】F06 canvas 工具动态枚举的实际装配：agent-service 里 canvasExtension 由谁注入、nodeTypes 是否来自实时 canvas registry；本次未运行验证 enum 完整性。
3. 【未知】F06 app 工具 mcp-tool 的 callMcp 注入实现是否与 DX callDirect(serverId,toolName,args) 等价（参数顺序/审批/错误码）。
4. 【未知】F10 内置 profile 种子是否在 identity-store 迁移的其它分支已补（本次 grep 未发现 INSERT INTO agent_profiles，但不能排除运行时由外部脚本/测试注入）。
5. 【未知】F14 是否产品判定“计费 OUT”：与 F17 云权益同属云能力；若 OUT，F14 应改不适用而非长期缺口。
6. 【未知】F15 画布邀请：OpenArc 是否用 grant 替代邀请码；若产品要求邀请链接，需要新增表/命令。
7. 【未知】F15 项目成员角色映射：DX owner/member + can_create_tasks ↔ OpenArc viewer/editor/manager 的正式映射未在代码/文档中找到定义。
8. 【未知】F16 产品意向：是否需要在本地部署保留 DX 的“桌面自动超管”体验；若不需要，应正式标 OUT。
9. 【未知】所有结论基于当前工作树静态阅读；未运行 OpenArc，也未跑测试。运行期行为（IPC 装配、任务 harness 工具面、审批链）可能与静态阅读有差异，正式验收需运行测试佐证。
10. 【未知】工作树存在未提交的 media/UI 改动（electron/media-*.cjs、src-vue 设置/市场面板），本次审计的 AI/org 相关 electron 文件不在改动列表，但若后续改动波及 agent/task 模块，行号与结论需复核。

---

审计基线：DX OS 0.6.1（AI-ORG-CONNECTIVITY.md / PLATFORM-CONNECTIVITY.md，REA Evidence ev_501ab8…、ev_9178e6a…）；OpenArc 当前工作树（本文件所引 electron/*.cjs、src-vue/*、src/*）。
