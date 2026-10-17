# OpenArc OS.app · 构建后连通性验证计划（REA 静态验收）

> 用途：task-13（构建后用 REA 复核功能连通性）的执行清单，也是 task-13 的前置只读文档。
> 本文件不构建、不运行应用、不改产品代码；只定义看什么产物、预期链路、失败判据、REA 怎么取证。
> 依据：OPENARC-DX-MAPPING.md、openarc-gap-list.json、CANVAS-APPS-CONNECTIVITY.md、AI-ORG-CONNECTIVITY.md 与当前工作树源码。

## 0. 边界与状态基线

### 0.1 这次验证能证明什么、不能证明什么

- **能证明（静态）**：构建产物里是否存在预期文件/命令/桥键/IPC 通道；renderer 字面量到 preload 桥、main 命令白名单、域服务分支是否四段齐全；命令是否被 allowlist 接受；返回值投影是否仍按“主进程注入身份”设计；与上一版构建相比是否少命令/少通道。
- **不能证明**：真实执行结果、UI 交互、权限在运行期的实际拒绝、模型/网络行为、性能与稳定性。运行级证据需要 task-13 另配冒烟测试；REA 结论只能写“静态连通”，不能写“功能可用”。
- **本仓构建产物不是 asar**：scripts/sync-app.mjs:45,158-184 把 dist/、electron/、resources/（若存在）、package.json 复制到 OpenArc OS.app/Contents/Resources/app/，并写 openarc-build.json（branch/commit/dirty/builtAt）。因此验证目标是目录，不是 app.asar。若后续构建改成 asar，用同一 REA 流程分析 Resources/app.asar，并补 inspect_artifact 成员清单。

### 0.2 构建产物与预检清单（只读）

| 产物 | 路径（构建后） | 预检动作 |
|---|---|---|
| 构建标记 | …/Contents/Resources/app/openarc-build.json | 记录 branch/commit/dirty/builtAt；dirty=true 必须写进报告（产物含未提交改动） |
| 渲染层入口 | …/Resources/app/dist/vue.html（默认；index.html 为 React 回退，main.cjs:216-221） | 记录入口与 dist 文件清单 |
| 渲染层 chunk | …/Resources/app/dist/assets/*.js、*.css | 列清单 + 记录总字节；哈希名不固定，定位靠内容字符串，不靠文件名 |
| 主进程 | …/Resources/app/electron/main.cjs、preload.cjs、*-domain.cjs、*-service.cjs、protocol-engine/*.cjs、cli-runtime/ | 记录 preload/main/关键域文件 sha256（用于证据复用判定） |
| 随包资源 | …/Resources/app/resources/（若存在） | 记录市场 catalog / bundled 包清单 |
| 原生身份（可选） | …/Contents/MacOS/OpenArc OS、Contents/Info.plist | 记录版本与签名；不参与连通性判定 |

预检输出（写入证据台账）：build_marker、sha256(openarc-build.json)、sha256(preload.cjs)、sha256(main.cjs)、dist_file_count、dist_sha_list_digest。

### 0.3 状态基线刷新（相对 OPENARC-DX-MAPPING.md 快照）

映射文档写于 2026-10-17 20:47；此后并行任务合入，部分缺口已关闭。本计划按当前工作树给期望：

| 项 | 旧状态（mapping） | 当前状态 | 证据（file:line） |
|---|---|---|---|
| A06 素材库 sync-sources | 缺失 | **已实现** | electron/canvas-dxos-commands.cjs:50,174 |
| A09 画布邀请码 | 缺失 | **已实现** | electron/canvas-dxos-commands.cjs:67-70,211-215 |
| A16 画布插件数据/网络 | 缺失 | **已实现** | electron/canvas-dxos-commands.cjs:72-73,229-248；electron/canvas-dxos-plugins.cjs:1-30；electron/main.cjs:1207-1214 |
| 访达共享盘/部门盘/快照 | 未单列 | **新增，需验收** | electron/platform-domain.cjs:72-77；electron/files-shared-bridge.cjs:1-40 |
| 市场第三方目录/安装/回滚 | 部分（仅本地 catalog） | **部分增强**：thirdparty 命令已有，仍无云端目录/审核/灰度 | electron/market-domain.cjs:52-56 |
| 本机代理保存/清除 | — | **已出现**：命令表已有 desktop/proxy/set 与 desktop/proxy/clear（任务 22 在途，以构建为准） | electron/local-proxy-domain.cjs:86,93；electron/local-proxy-service.cjs:61-62 |
| 产品 OUT 决策（2026-10-17） | — | **A14 画布云同步 / F17 云账号权益 / D02 云市场审核灰度 = 产品 OUT**，task-13 记“不适用” | 见 §6.1 O1-O3 |
| 无归属缺口归属 | — | **task-25（画布语义）、task-26（媒体/集成）、task-27（AI/组织）已建**；task-13 只验“已实现/如实不可用”，不因未全部等价判失败 | 见 §6.5 |
| 旧映射 F01/F03 | 部分（“Vue 无 Jarvis/项目 Agent”） | **可能已过期**：src-vue/shell/AssistPanel.vue 已落地并用 task 桥（:15） | 以构建产物为准，不得据旧映射直接报缺口 |

因此：**A06/A09/A16 在本次验收按“必须通过”判**；旧映射的“缺失”标签作废，若构建产物里找不到这三组命令才判失败。产品 OUT 项按“不适用”记录（§6.1）。

## 1. REA 取证流程（统一配方）

### 1.1 建议的取证顺序

1. 预检（§0.2）→ 记录构建标记与关键文件 sha256。
2. 主进程图：analyze_javascript_application 分析 …/Resources/app/electron（目录）→ 得 EV_MAIN。
3. 渲染图：analyze_javascript_application 分析 …/Resources/app/dist（目录）→ 得 EV_DIST。
4. 用 summary/modules 视图取证每条命令/通道/桥键（§1.2）。
5. 对关键链路做 trace_application_feature（种子=命令名字面量）与（可选）compare_application_versions（对比上一版构建）。
6. 汇总到证据台账（§8），逐项给 通过/部分通过/不通过/证据不足。

> 若 MCP 直连在 60s 客户端超时：改用同版本 rea CLI 跑完并 --format json > /tmp/...，再用 import_evidence_bundle 导入 MCP 取视图（DX 0.6.1 分析时已验证该路径可行）。

### 1.2 REA 操作配方

| 编号 | 操作 | 参数/视图 | 产出 |
|---|---|---|---|
| R1 | analyze_javascript_application | input_path=…/Resources/app/electron，artifact_format=directory，detail=summary | EV_MAIN + summary（文件数/解析数/IPC 统计） |
| R2 | analyze_javascript_application | input_path=…/Resources/app/dist，artifact_format=directory，detail=summary | EV_DIST + summary（chunk 数/结构） |
| R3 | inspect_analysis_view | source={kind:retained-evidence,evidence_id:EV_MAIN或EV_DIST}，view={kind:summary} | summary 视图证据（记录 view evidence id） |
| R4 | inspect_analysis_view | view={kind:page,collection:modules,offset,limit} | 模块分页（列出 assets/*.js、main.cjs、preload.cjs、域文件） |
| R5 | inspect_analysis_view | view={kind:item,collection:modules,selector:{path:"main.cjs"}}（或 preload.cjs / 具体 chunk） | 单模块事实（导入、字符串、调用候选） |
| R6 | trace_application_feature | 用 EV_MAIN/EV_DIST + 种子字符串（如 canvas/assetLibrary/syncSources、agent/tool/call） | 命中字符串/过程/引用链；实际参数以服务端 schema 为准 |
| R7 | compare_application_versions | 候选构建图 vs 上一版构建图（两个 authenticated application graphs） | 新增/删除/变更模块、命令、通道差异 |
| R8 | get_evidence_bundle | detail=summary + filters:{operation,target_sha256} | 发现已留存记录；不重跑分析 |
| R9 | export_evidence_bundle / import_evidence_bundle | 输出到 artifacts/re-verify/<build-ref>/bundle.json / 从该文件导入 | 跨会话/跨 agent 复用同一份证据 |
| R10 | inspect_macho（可选） | …/Contents/MacOS/OpenArc OS | Electron 版本/架构（不参与连通性判定） |

**失败判据的取证要求**：每条“失败”必须给出“在哪个视图/哪个模块/搜了什么种子/返回什么”，不能只写“没找到”。静态搜不到只能判“未发现”，要结合 modules 视图与 trace 再判“缺失”。

### 1.3 Evidence ID 复用规则

1. **同产物复用**：preload.cjs、main.cjs、dist/assets 文件清单的 sha256 与上次记录一致 → 直接复用上次 EV_MAIN/EV_DIST 与视图 id，不重跑 analyze_javascript_application。
2. **目录级 digest**：REA 记录的 subject.digest.sha256 是目录快照；构建产物差异会导致新 digest。先 get_evidence_bundle(detail=summary) 按 target_sha256 查旧记录，命中即复用。
3. **跨会话/跨成员复用**：export_evidence_bundle → import_evidence_bundle；报告里同时写 evidence_id 与 view_digest，保证别人能复核同一视图。
4. **DX 基线证据只作对照**：ev_3921218e…（DX app.asar）与 ev_9178e6af…（DX dist）证明的是 DX 0.6.1，不能当作 OpenArc 等价证据；只用于“预期命令名/形态来源”引用。
5. **比较前先验身份**：compare_application_versions 只在两个图都来自同一 OpenArc 构建链路时使用；不得拿 DX 图与 OpenArc 图直接比较当等价结论。
6. **不重跑原则**：同一 commit 的重复验收复用证据；只有 commit/文件 sha 变化才新增分析，并把旧证据 id 作为 baseline 保留。

## 2. 验收项 A：画布 → 资源库 / 素材库

| # | 要观察的产物 | 预期链路 | 失败判据 | REA 操作 |
|---|---|---|---|---|
| A1 | dist/vue.html + dist/assets/*.js（画布 chunk，含 CanvasHost 桥调用）；electron/preload.cjs 的 canvas 键（:141-143）；electron/main.cjs 的 canvas:command 注册；electron/canvas-bootstrap.cjs:19-60 命令表 | UI 窗口（appId=canvas）→ ReactIsland 加载画布 → window.openarc.canvas.command({command,payload}) → canvas:command → RENDERER_COMMANDS allowlist → canvas-service/canvas-dxos-commands | renderer 无 canvas.command 字面量；preload 无 canvas 键；main 无 canvas:command；allowlist 不含实际下发的命令名 | R1+R2；R5 看 preload.cjs/main.cjs；R6 种子 canvas/assetLibrary/、canvas/command |
| A2 | canvas/assetLibrary/{list,ensure,create,get,items,import,upsert,update,reference,attach,delete}；electron/canvas-dxos-asset-library.cjs；canvas-dxos-store.cjs（canvas_dxos_asset_libraries 表） | 画布素材面板 → 上述命令 → assetLibrary service → 表/资源域；系统提示词条目受保护不可删（canvas-dxos-asset-library.cjs:36,104） | 命令集合缺项；命令在表里但 dispatch 无实现；系统提示词可被 delete；列表不按 owner/组织过滤 | R1；R5 看 canvas-dxos-commands.cjs；R6 种子 canvas/assetLibrary/upsert |
| A3 | canvas/assetLibrary/syncSources；canvas-dxos-commands.cjs:50,174；assetLibrary syncSources 实现 | 画布/文件夹来源勾选 → syncSources(payload items) → 校验 owner/可见性 → sourceKey 去重 → 素材入库 | 命令不存在/未进 allowlist；无 owner/可见性校验；无 sourceKey 去重；payload 上限缺失 | R1；R5/R6 种子 syncSources |
| A4 | canvas/importAsset、canvas/readAsset、canvas/libraryList；src/canvas/canvasAssetRefs.ts；electron/resource-bootstrap.cjs 的 resource 命令 | 画布节点引用 openarc-asset:<ref> → readAsset 经 resource 域取字节/缩略图 → 画布只存引用不存 blob | 画布出现磁盘路径/HTTP URL 引用；readAsset 缺资源域授权；blob 直接内联进画布文档 | R1+R2；R6 种子 openarc-asset:、canvas/readAsset |
| A5 | 素材库 visibility（PRIVATE/ORGANIZATION）；canvas-dxos-asset-library.cjs:104,190-224；asset library 命令的授权分支 | 列表/读取按 owner 或同组织 ORGANIZATION 过滤；更新需 owner + baseVersion | 跨组织可见；只读库可写；渲染层可自报 userId；无 baseVersion 冲突检查 | R1；R5 看 asset-library 模块；R6 种子 ORGANIZATION |
| A6 | photos/importImage；electron/photos-service.cjs:650-663；electron/canvas-exchange-ports.cjs；electron/main.cjs:1456-1459（importer 注入） | 相册图片 → photos/importImage → canvas-exchange importer → 画布节点（node.add + openarc-asset:）或素材库 importAssetItem | importer 未注入（运行期 DEPENDENCY_UNAVAILABLE）；落点只支持一种；无 revision/校验；写画布绕过 canvas 命令 | R1；R5 看 photos-service、canvas-exchange-ports；R6 种子 photos/importImage |
| A7 | canvas/plugins/data、canvas/plugins/network；electron/canvas-dxos-plugins.cjs；electron/main.cjs:1207-1214（pluginHost 装配） | 插件命令 → 校验已安装且启用的开发者 App + manifest.canvas → data 落 dxos/canvas-plugins/data/...；network 委托 developer/network/request（白名单+DNS+限流+审计） | 命令存在但 pluginHost 未装配；未校验插件启用/manifest；key 非法可写；network 绕过 developer 网络策略 | R1；R5 看 canvas-dxos-plugins.cjs、main 装配；R6 种子 canvas/plugins/data |
| A8 | canvas/invites/{get,create,revoke,redeem}；canvas-dxos-commands.cjs:67-70,211-215 | 所有者创建邀请 → 只存 sha256+末4位 → 明文只返回一次；兑换后按权限加入（只读→VIEWER/编辑→EDITOR） | 明文入库；邀请无过期/撤销；兑换不校验画布存在；非管理员可创建 | R1；R5/R6 种子 canvas/invites/ |

## 3. 验收项 B：全局 AI → 工具 / 功能

| # | 要观察的产物 | 预期链路 | 失败判据 | REA 操作 |
|---|---|---|---|---|
| B1 | electron/preload.cjs 的 agent 键（:166-173）；agent:command/agent:event；electron/agent-service.cjs:533-779 命令表（agent/task/*、agent/run/*、agent/tool/*、agent/capability/route、agent/project/*、agent/memory/*、agent/react/run、agent/health） | UI（对话/任务面板）→ window.openarc.agent.command({command,payload}) → agent:command → AgentService dispatch → runtime/kernel；事件经 agent:event 下行 | 命令缺项；dispatch 无分支；事件通道缺失；渲染层可传 userId/sessionRef 且被采信 | R1；R5 看 preload.cjs、agent-service.cjs；R6 种子 agent/tool/call、agent/capability/route |
| B2 | electron/agent-tool-catalog.cjs、electron/tool-registry.cjs、electron/tool-adapters.cjs；工具 descriptor 的类别/schema | agent/tool/catalog 返回 7 类（system/media/file/canvas/app/mcp/skill）+ 每项 schema/risk/sideEffects；agent/tool/describe 可单查 | 类别缺项；catalog 与 registry 不同源；schema 缺失；工具名存在但 adapters 无执行分支 | R1；R5 看 catalog/registry；R6 种子 tool/catalog；必要时 trace_javascript_semantics |
| B3 | electron/capability-router.cjs、capability-target-resolver.cjs、progressive-capability-router.cjs、model-resolver.cjs、model-service.cjs；agent/capability/route | 能力路由 → 目标解析 → 模型候选链/回退（model-resolver）→ model-service 调用；缺能力时返回结构化错误而不是静默降级 | 路由结果无模型候选；回退链缺失；配置了 provider 仍回 AGENT_DEPENDENCY_UNAVAILABLE；能力边界未取交集 | R1；R5 看 capability/model 模块；R6 种子 capability/route、resolveModel |
| B4 | electron/protocol-engine/*.cjs（compiler/transport/bindings/builtins-models/modelProfile）、provider-protocol-domain/store.cjs、model:command 命令面（model-bootstrap.cjs:89-158） | model:command → model-service → provider-protocol store → protocol-engine 编译/传输；协议三元组/模型 profile 参与路由 | 协议引擎文件未随包；模型命令绕过 store；transport 直接 fetch 无白名单；协议内置清单缺失 | R1；R4 列出 protocol-engine 模块；R6 种子 protocol、providerProtocol |
| B5 | electron/preload.cjs 的 task 键；task:command/task:event；electron/task-service.cjs；src-vue/apps/ChatApp.vue:18-119（task 桥调用） | 对话 UI → task/run/appendStep/get → task-service → runtime；结果经 artifact + task:event | renderer 无 task 桥调用；任务命令缺 run/appendStep/get；事件缺失；任务归属不按 sessionRef | R1+R2；R5 看 ChatApp chunk 与 task-service；R6 种子 task/appendStep |
| B6 | preload 的 skill/media/mcp 键；skill-domain.cjs:53-73、media-domain.cjs:76-152、mcp-bootstrap.cjs:74-101 命令表；agent tool catalog 中对应工具 | UI/Agent 工具 → 对应域命令 → 域服务；agent 侧通过 tool catalog/handler 路由到同一命令面 | 域命令存在但 agent catalog 未收录；catalog 收录但 handler 未接域；MCP 工具调用绕过审批 | R1；R5 看三域命令表与 catalog；R6 种子 skill/run、mcp/toolInvocation/call |
| B7 | preload 的 sideEffect 键（:212-221）；sideeffect:command/sideeffect:event；electron/side-effect-domain.cjs、side-effect-service.cjs、dx-task-approval-bridge.cjs | 高风险写操作 → 生成 approval 请求 → 用户批准/撤销 → 执行器执行；事件下发审批状态 | 写操作无审批直接执行；approval 无 revoke；审批参数可由 renderer 伪造（callId/planHash 等）；事件缺失 | R1；R5 看 side-effect 模块；R6 种子 sideEffect/revokeApproval、approval |
| B8 | electron/canvas-dxos-capabilities.cjs；canvas/capabilities/list；agent tool catalog 中 canvas 工具；canvas-service.cjs:770-950（run/modelCall） | Agent 画布工具 → capability 投影 → canvas/run/modelChat/modelImage → 模型/任务域；结果写回画布节点 | 能力清单缺项；catalog 有但 canvas 无执行分支；run 不记账 taskService；越权改他人画布 | R1；R5 看 capabilities/canvas-service；R6 种子 canvas/capabilities/list、canvas/run |

## 4. 验收项 C：组织权限

| # | 要观察的产物 | 预期链路 | 失败判据 | REA 操作 |
|---|---|---|---|---|
| C1 | preload 的 identity 键（:50-57）；identity:command（identity-bootstrap.cjs / identity-service.cjs:276-361）；src-vue/stores/identity.ts:58,187-190 | 初始化/登录/会话 → identity/initialize/login/status/restore/logout/lock/unlock/... → identity-service；sessionRef 只由主进程持有 | renderer 可读 token/sessionRef；命令缺项；登录不校验；初始化可跳过本地指引 | R1+R2；R5 看 preload/identity-service；R6 种子 identity/login |
| C2 | preload 的 authorization 键；authorization:command；electron/authorization-bootstrap.cjs:23-29（authorize/capabilities/resource/resolve/notification/list/search） | 资源访问 → authorization 命令 → authorization-service 决策（decision/capabilities/safe metadata） | 返回原始 ACL/凭据；决策可被 renderer 覆盖；缺 capability 计算 | R1；R5 看 authorization 模块；R6 种子 authorization/authorize |
| C3 | preload 的 governance 键；governance:command；electron/governance-bootstrap.cjs:30-61（用户/部门/角色/资源/App/审计） | 组织管理 UI → governance 命令 → governance/authorization service → store；每个写操作校验超管/部门管理员 | 缺用户/部门/角色命令；写操作无角色校验；返回 password hash/salt | R1；R5 看 governance 模块；R6 种子 governance/grantAppAccess |
| C4 | governance/{listApps,getAppAccess,grantAppAccess,revokeAppAccess,getAppToolAccess,grantAppToolAccess,revokeAppToolAccess,setAppStatus}；identity/app-access-rule-save、app-permission-policy-save、app-permission-snapshot | 管理员给用户/部门授权 App 与工具 → 运行时每次命令检查授权（命令面 + 工具级） | 仅 App 级授权无工具级；授权不落库/不生效；运行时绕过授权服务 | R1；R5 看 governance/identity 命令；R6 种子 grantAppToolAccess |
| C5 | resource:command（resource-bootstrap.cjs:20-60，63 条命令，含 list/get/import/trash/collection/tag/version）；resource-domain.cjs scope（PERSONAL/DEPARTMENT/ORGANIZATION） | 资源列表/读取 → resource service → authorization 决策 + scope 过滤 | 跨部门/跨组织泄露；trash 后可读；linked 资源路径暴露 | R1；R5 看 resource 模块；R6 种子 resource/list |
| C6 | governance/audit-list、identity/audit-list、app_network_audit/app_runtime_events 写入点（developer-domain.cjs:223-262） | 管理/高风险操作 → 审计表写入 → 审计查询可回溯 | 写操作无审计；审计返回敏感字段；审计可被 renderer 伪造 | R1；R5 看 governance/developer 模块；R6 种子 audit |
| C7 | electron/main.cjs trusted(event)（:276 及每个 ipcMain.handle 首行）；preload.cjs 40 个顶层键 | 所有 invoke 通道必须 trusted(event) 校验；下行事件只走 send | 任一通道无 trusted 校验；暴露 ipcRenderer/webContents/BrowserWindow/fs/shell 原始对象 | R1；R5 看 main.cjs/preload.cjs；对照 40 键清单逐项核 |
| C8 | 首启/本地账号链路：src-vue/identity/SetupScreen.vue + src-vue/stores/identity.ts + electron/local-account-service.cjs + identity/initialize；main.cjs 本地管理员绑定分支 | 首启三步 → identity/initialize（本地管理员）→ 会话建立；之后所有命令用主进程 sessionRef | 初始化无本地绑定即授予超管；密码明文落盘；初始化接口绕过 trusted | R1+R2；R5 看 local-account/identity；R6 种子 identity/initialize |

## 5. 验收项 D：开发者 / 集成 / 市场 / 媒体 / 文件共享

| # | 要观察的产物 | 预期链路 | 失败判据 | REA 操作 |
|---|---|---|---|---|
| D1 | developer:command（70 条：developer-domain.cjs:223-280）；developer/install、uninstall、enable、disable、rollback、validate、health；developer-bootstrap.cjs | 开发者 UI → developer 命令 → developer service → 本地安装目录/store；安装做清单校验+原子替换+回滚点 | 命令缺项；安装不校验 dx-app/v2；回滚点缺失；路径逃逸 | R1；R5 看 developer 模块；R6 种子 developer/install |
| D2 | developer/lab/*（草稿/模板/文件/zip/模拟安装）、developer/collab/*、developer/realtime/*（developer-realtime.cjs:408-422，含 LAN 入口） | 实验室/协作/实时房间 UI → developer 命令 → lab/collab/realtime 服务 | lab 命令缺项；realtime 无鉴权/无重放；LAN 入口未显式 authorize | R1；R5 看 developer 扩展命令；R6 种子 developer/realtime/join |
| D3 | developer/credential/{bind,list,unbind}、developer/network/{evaluate,request}、developer/runtime/report；app_network_audit | App 凭据绑定（只存元数据）→ 出网判定（HTTPS+白名单+DNS）→ 请求 → 审计 | 密钥过桥/落明文；出网绕过白名单；无审计/限流 | R1；R5 看 developer 模块；R6 种子 developer/network/request |
| D4 | market:command（market-domain.cjs:44-56：catalog/apps/skillpacks/thirdparty）；market-update-domain.cjs:61-67（status/check/install/rollback/health/sources/source-set） | 市场 UI → market 命令 → 本地 catalog / thirdparty 安装端 / 在线更新（验签→摘要→解压围栏→原子切换→回滚） | 无第三方安装端；更新不做验签/摘要；安装路径可逃逸；灰度/审核被误当作已实现 | R1；R5 看 market 模块；R6 种子 market/thirdparty/install |
| D5 | integration:command（plugin-service.cjs，91 条 integration 命令）；plugin-registry.cjs（9 插件依赖探测）；src-vue/apps/IntegrationsApp.vue:20-25 | 集成 UI → integration 命令 → 插件注册表/服务；默认全关；缺依赖结构化拒绝；网络类需显式开启+探测 | 插件未登记；默认开启；缺依赖假成功；凭据回明文 | R1+R2；R5 看 plugin 模块与 IntegrationsApp chunk；R6 种子 integration/plugins/health |
| D6 | media:command（media-domain.cjs:76-152）；video:* IPC（main.cjs）；image:declare；weather:* | 视频/短剧/音乐/声明/天气 UI → 域命令 → media/video/weather service | 命令缺项；渲染无 worker/租约；声明改写不校验 mime；天气出网 URL 未固定 | R1+R2；R5 看 media 模块与对应 UI chunk；R6 种子 media/render/submit |
| D7 | photos:command（photos-domain.cjs:174-191）、photocraft:command（photocraft-domain.cjs:132-351）、fileTransfer:command（file-transfer-domain.cjs:157）、appExchange:command（app-exchange-domain.cjs:209） | 相册/图像工坊/传输中心/应用互传 UI → 域命令 → 域服务；文件传输分块+哈希；互传只传引用 | 命令缺项；传输无 offset/哈希校验；互传传字节/URL；image-studio target 不可达 | R1+R2；R5 看四域模块与 UI chunk；R6 种子 fileTransfer/chunk、appExchange/exchange |
| D8 | files:* IPC（main.cjs 16 个 handler）；files-shared-bridge.cjs；platform/fs/shared/roots、platform/fs/shared/list、platform/fs/search、platform/fs/stats、platform/fs/snapshot/create、platform/fs/snapshot/restore（platform-domain.cjs:72-77） | 访达 UI → files IPC / platform 命令 → file-service / fsStore；共享盘按 public/department 可见性过滤；快照不回 blob/绝对路径 | 共享盘泄露他人/跨部门；快照返回 blob/路径；文件操作无 folderId 围栏 | R1+R2；R5 看 main files handler、files-shared-bridge、platform-domain；R6 种子 platform/fs/shared/list |
| D9 | 0.6.1 五域：systemFonts:command（system-fonts-domain.cjs:91）、ocr:command（ocr-domain.cjs:94）、fileTransfer:command、codexCanvas:command（codex-canvas-bootstrap.cjs:25-31）、desktop:command（local-proxy-domain.cjs:82-83） | 设置/相册/传输中心/画布 → 各域命令 → 域服务；字体只读本机、OCR 走 provider、代理默认零出网 | 域未装配（*_NOT_READY）；字体返回绝对路径；OCR 无 provider 仍成功；代理默认出网 | R1；R5 看五域模块；R6 种子 systemFonts/list、ocr/recognize、desktop/proxy/detect |
| D10 | cli:command（cli-domain/cli-service）；cli-runtime/；integration/quark/* 等外部 CLI 通道 | CLI UI → cli 命令 → 受控 CLI 运行器；外部 CLI 探测/登录/模型 | CLI 命令缺项；子进程参数由渲染层控制；凭据过桥 | R1；R5 看 cli 模块；R6 种子 cli/status |
| D11 | preload 40 键逐项；main.cjs 各域 registerDomainOrDegrade 块（如 :1342-1500）；*_NOT_READY 稳定错误 | 每域装配失败→降级为 NOT_READY，不拖死启动；40 键与 preload/main 双向一致 | preload 有键但 main 无 handler；main 有 handler 但 preload 无键；装配失败静默崩溃/白屏 | R1；R5 看 main.cjs 注册块 + preload.cjs；逐键表对照 |
| D12 | market/thirdparty/* + marketUpdate:command（同 market:command 通道）与 openarc-build.json | 市场第三方列表 → source get/set → install/rollback；更新检查只从注册表选 owner/repo（不接受任意 URL） | 任意 URL 可配；安装无 confirm；与内置版本表不一致 | R1；R5 看 market 模块；R6 种子 market/thirdparty |

### 5.1 验收项 E：扩展能力（非 DX parity；task-13 单列检查）

> 说明：这些能力不在 DX 30 应用/映射的 parity 范围，但任务板已排期；task-13 按“已实现/如实不可用”验收，**不以 DX 等价判失败**；任务仍为 pending 的，记录“未实现/未开始”，不算失败。

| # | 要观察的产物 | 预期链路 | 失败判据（按任务范围） | REA 操作 |
|---|---|---|---|---|
| E1 | i18n：src-vue/i18n/{index,locale,en-US}.ts；壳层/设置的 en-US keys；语言切换入口 | 设置切换语言 → i18n store → 壳层/应用名/菜单渲染 | 词典文件缺失；切换后仍硬编码中文；语言状态不落盘 | R2；R5 看 dist chunk 中 en-US 字符串；R6 种子语言键 |
| E2 | 相册扩图/宫格：src-vue/apps/photoGridSlice.ts、PhotosApp 相关 UI；ONNX 依赖探测 | 相册 → 扩图/宫格 → 本地能力（缺 onnxruntime 如实不可用） | UI 无入口；缺依赖却假成功；输出不落文件 | R2；R6 种子 grid、expand、onnxruntime |
| E3 | 日历提醒/农历/AI 建日程：src-vue/apps/CalendarApp.vue、scheduleParse.ts；黄历走 integration/almanac | 日历 → 农历/提醒（Notification + 定时器）→ AI 建日程（本地解析或 task 桥） | 提醒不触发/重启不恢复；AI 不可用却假成功；农历请求失败不降级 | R2+R1；R6 种子 almanac、scheduleParse、Notification |
| E4 | 访达共享盘/部门盘/快照 UI：src-vue/apps/SharedDrivePanel.vue、sharedDrive.ts；后端 platform/fs/shared*（D8） | 访达侧栏 → platform/fs/shared/roots/list → 浏览/搜索/统计；快照 create/restore 按权限显示 | UI 无入口；越权按钮仍可点；快照返回 blob/绝对路径 | R2；R5 看 SharedDrivePanel chunk；R6 种子 shared、snapshot |
| E5 | 视频多轨/Agent 粗剪：src-vue/apps/VideoApp.vue、electron/media-domain.cjs 时间线扩展；task-20 | 多轨时间线 → media/render/submit → worker 渲染；Agent 粗剪入口 | 多轨命令缺失；渲染计划不支持多轨；Agent 入口假成功 | R1+R2；R6 种子 track、timeline、render/submit |
| E6 | 短剧素材登记/成片导出：src-vue/apps/DramaApp.vue、electron/media-short-drama.cjs、media render | 短剧 → 素材登记资源库 → 成片导出 | 登记不落资源库；导出无产物；只写本地路径 | R1+R2；R6 种子 short-drama、artifact、export |
| E7 | 画布 .dxcanvas UI / 协作房间 UI：src/canvas/CanvasHost.tsx 及新面板（CanvasAssetSyncPanel/InvitePanel/PluginsPanel） | 画布 UI → canvas/package/*、canvas/collab/*、canvas/invites/* | 面板无入口；命令存在但 UI 未接；协作为空房间仍显示在线 | R2；R6 种子 canvas/package、canvas/collab、canvas/invites |
| E8 | 市场第三方 UI + 全应用更新：src-vue/apps/MarketApp.vue；market/thirdparty/*、market/update/*（task-24） | 市场 UI → thirdparty list/install/rollback + update status/check | 第三方列表不显示来源/版本；安装无 confirm；更新入口缺失 | R2+R1；R6 种子 market/thirdparty、market/update |
| E9 | 设置真实能力：desktop/proxy/set 与 desktop/proxy/clear（local-proxy-domain.cjs:86,93）、缓存清理、系统更新检查（task-22 / task-17） | 设置 → 代理保存/清除 → 状态读取；缓存扫描/删除；更新检查 | 命令存在但无落盘/无校验；缓存删除越界；更新源硬编码不可配 | R1；R6 种子 desktop/proxy/set、cache、update/check |
| E10 | 桌面小组件音乐/天气：src-vue/shell 或 Desktop 组件 | 小组件 → media 播放状态 / integration weather | 组件无数据源；假数据；点击不跳转 | R2；R6 种子 widget、weather |
| E11 | 窗口标签合并：electron/window-domain.cjs（tabGroupId）、WindowLayer（task-21） | 多窗口 → 合并/拆分/切换标签组 | 当前工作树未检出 tabGroupId（task-21 pending）→ 按“未实现”记录，不判失败 | R1；R6 种子 tabGroupId、mergeInto、detachTab |
| E12 | 任务双表 v29 合并 + 局域网协作服务（task-8） | 启动迁移（备份/回滚/foreign_key_check）；WS 局域网入口鉴权 | 迁移无开关/无备份；LAN 无鉴权 | R1；R6 种子 v29、foreign_key_check、lanServer |
| E13 | 开发者工作台/集成入口/0.6.1 五域 UI（task-4 已完成）：DevApp、IntegrationsApp、OcrPanel、TransferCenter、SystemFontsPanel、LocalProxyPanel | UI → 对应域命令（developer/integration/ocr/fileTransfer/systemFonts/desktop） | 面板无桥调用；命令缺；浏览器预览无桥时未如实提示 | R2；R5/R6 看各面板 chunk 与种子 |

## 6. 当前未实现项 / 不适用项 / 已知部分项

### 6.1 产品 OUT（task-13 记“不适用”，不判失败）

| # | 项 | 决策与边界 | 证据/说明 |
|---|---|---|---|
| O1 | A14 画布云同步/云备份（DX /api/canvas/cloud*、canvas_cloud_sync_baselines） | **产品 OUT**（本地部署 + 在线更新，不接 api.dx-os.com） | canvas-dxos-collab.cjs:25-26 明确 OUT；task-12 描述同 |
| O2 | F17 云账号/权益/兑换/席位（api.dx-os.com Ed25519 权益） | **产品 OUT** | electron/ 无 entitlement 模块；本地部署形态 |
| O3 | D02 云市场审核/灰度（api.dx-os.com 目录/审核/灰度/发布） | **产品 OUT**；替代形态=本地 catalog + 第三方目录 + GitHub Releases/ModelScope 在线更新 | market-domain.cjs:44-56；market-update-domain.cjs:61-67；task-19 已完成第三方部分 |

> task-13 对 O1-O3 的记录方式：结论写“不适用（产品 OUT）”，不出现在“缺失/不通过”清单；若构建产物出现云端命令，只记“超出当前产品边界”，不判失败。

### 6.2 不适用（N/A，产品决定不移植，补充）

| # | 项 | 依据 | 若出现的判据 |
|---|---|---|---|
| X1 | D07 开发者 OAuth/PKCE、发布/审核/灰度、云市场目录字段 | developer-domain.cjs:30,39,519,545：manifest 出现 oauth/publish/gray/rollout 即拒绝 | 若这些字段被接受或出现对应桥命令 → 说明产品决定变更，需更新映射与验收口径 |

### 6.3 已知部分项（验收按“部分通过”预期，除非出现退步）

| # | 项 | 当前缺口（预期仍存在） | 验收关注点 |
|---|---|---|---|
| P1 | A10 素材库共享 | 仅 PRIVATE/ORGANIZATION，无 publicAccess/逐成员 ACL（canvas-dxos-asset-library.cjs:104,190-224） | 不因缺 ACL 判失败；若出现跨组织泄露判失败 |
| P2 | A12 画布协作 | 同进程房间，无跨机传输层（canvas-dxos-collab.cjs） | LAN 能力来自 task-8；未合入前不判失败 |
| P3 | A13 .dxcanvas 大包 | 内联 ≤32MB（canvas-dxos-commands.cjs:31），无 multipart/1GB 通道 | 大于 32MB 的包被拒是已知限制，不算断链 |
| P4 | A18 Agent 附件 | docx/xlsx 因缺依赖不可用（canvas-dxos-agent-attachments.cjs:6-13,38） | 文本/CSV 通即通过；docx/xlsx 返回结构化不可用属预期 |
| P5 | B02 相册共享区 | 仅 public/department 两态（main.cjs:1451-1453） | canvas/asset-library 共享区判定缺失不算失败 |
| P6 | B10 音乐在线封面/歌词 | 需注入 fetch；在线抓取能力弱于 DX | 本地扫描/歌词缓存通即通过 |
| P7 | B15 Figma/Illustrator | 仅媒体辅助模块，无应用入口/插件登记 | 不因缺应用判失败；若模块被删判退步 |
| P8 | C02 dx-app 宿主加载 | 无 DX DeveloperAppHost 等价容器 | 本地安装/回滚通即通过 |
| P9 | D02 云市场审核/灰度 | 有第三方目录/安装/回滚，无云端审核/灰度 | 第三方命令通即通过；不得声称云市场等价 |
| P10 | D08 image-studio 应用 | appExchange target 映射 image-studio，但 src-vue/apps.ts 未注册该应用（工作树当前） | target 不可达不算断链；若注册则复核 |
| P11 | F04/F05/F06/F10/F14/F15/F16 | AI/组织为概要映射，profile/边界/配额口径未逐条核对；已由 task-27 承接 | 域与桥存在即通过；未等价不判失败；行为等价需运行测试 |
| P12 | F01/F03 | **旧映射可能已过期**：src-vue/shell/AssistPanel.vue 已落地并用 task 桥（:15），Vue 侧 Jarvis/项目 Agent 入口以构建产物为准 | 不得据旧映射直接报缺口；构建里找不到 AssistPanel/项目 Agent 才记“未实现” |

> task-13 对 P1-P12 的判定：**只验“已实现或如实不可用”**，不因未达到 DX 等价而判失败；新增缺口（若有）按 task-25/26/27 归属记录。

### 6.4 已关闭项（本次按必须通过判）

| # | 项 | 必过证据 |
|---|---|---|
| S1 | A06 sync-sources | 构建产物含 canvas/assetLibrary/syncSources，且在 allowlist 与实现分支中 |
| S2 | A09 邀请码 | 构建产物含 canvas/invites/get、create、revoke、redeem，且邀请只存哈希、明文一次性返回 |
| S3 | A16 插件数据/网络 | 构建产物含 canvas/plugins/data、canvas/plugins/network，且 main.cjs 装配 canvas pluginHost |
| S4 | 访达共享盘/部门盘/快照 | 构建产物含 platform/fs/shared/roots、shared/list、search、stats、snapshot/create、snapshot/restore |

### 6.5 无归属缺口的新任务归属（lead 决策 2026-10-17）

| 新任务 | 承接的旧缺口 | task-13 判定 |
|---|---|---|
| task-25 画布语义补齐 | A02/A03/A07/A10/A11/A15/A17/A18/A20/A21 | 审计后“已实现/如实不可用/未实现”如实记录；不因未全部等价判失败 |
| task-26 媒体/集成语义补齐 | B02/B15/B16/D09/E03 | 同上 |
| task-27 AI/组织语义复核 | F01/F03/F04/F05/F06/F10/F14/F15/F16 | 同上；F01/F03 以 AssistPanel 构建产物为准 |
| 产品 OUT | A14/F17/D02 云审核灰度 | 记“不适用” |

## 7. 失败判据与结论口径（汇总）

**通用失败判据（任一命中即该条不通过）**：

1. 产物缺失或指纹与 openarc-build.json 不一致（构建来源不明）。
2. 四段断链：renderer 字面量 → preload 桥键 → main handler/通道 → 域命令白名单/服务分支，任一环缺失。
3. 命令在 renderer 出现但 RENDERER_COMMANDS/域命令表不含它；或命令表有、dispatch 无实现（假登记）。
4. 身份由渲染层提供且被采信（userId/role/appId/sessionRef 可由 renderer 指定）。
5. 写操作缺少权限/审计/审批（对应域要求时）；只读返回原始凭据/绝对路径/blob。
6. 与 mapping/gap 基线矛盾且未记录（例如旧映射写“缺失”但出现新命令、或写“已实现”但命令消失）→ 判“证据冲突”，先更新映射。
7. 证据不足：REA 覆盖 partial 或只找到一端 → 判“证据不足”，不得写成通过或失败。
8. **产品 OUT 项**（§6.1 O1-O3）不适用本判据，结论写“不适用”。
9. **扩展能力项**（§5.1 E1-E13）按任务范围判定：任务已完成/在途且产物存在 → 通过或部分通过；任务 pending → 记“未实现/未开始”，不判失败。
10. **已知部分项**（§6.3 P1-P12）已有 task-25/26/27 归属，未达到等价不判失败；只有出现退步（原已实现变缺失/越权）才判失败。

**单条结论枚举**：通过（四段齐全+无通用失败）、部分通过（链路在主进程成立，但 renderer 无调用/或已知部分项）、不通过（命中任一失败判据）、证据不足（静态取证不足）、不适用（产品决定）。

**报告必须写**：每条的 evidence_id、view_digest（若用视图）、检索种子、结论、失败判据项；整包再加 build marker 与文件 sha256。

## 8. 证据台账模板

| 字段 | 填法 |
|---|---|
| build | branch/commit/dirty/builtAt（openarc-build.json） |
| target_digest | R1/R2 记录的目录 sha256 |
| EV_MAIN / EV_DIST | R1/R2 的 evidence_id |
| views | summary/modules/item 的 view evidence id + view_digest |
| probes | 每条用的种子字符串/模块路径 |
| result | 通过/部分通过/不通过/证据不足/不适用 |
| fail_reasons | 通用失败判据编号（1-7） |
| notes | 与 mapping 的差异（新增/关闭/口径变化） |

## 9. 限制

1. REA 是静态分析：不执行应用、不验证运行行为；trace_* 命中不等于运行时会走到。
2. 前端 chunk 经 Vite 压缩/编码：命令名通常保留为字符串，但动态拼接/变量间接调用可能无法静态还原；找不到时先看 modules 视图与 trace，再判“未发现”。
3. REA 覆盖可能 partial（DX 经验：app.asar semantic budget 被压缩、request 族为 0）；本仓 Resources/app 无 node_modules，预计解析更快，但仍以 summary 的 coverage 字段为准。
4. 构建可能含 dirty=true 的未提交改动：报告必须注明，结论只对应该构建快照。
5. 本计划不覆盖 UI 视觉/动效/运行期权限拒绝；这些属于 task-13 的运行测试与三轴验收，不由 REA 替代。
6. 若后续构建改为 asar/DMG：asar 用同流程分析 Resources/app.asar；DMG/ZIP 需先 inspect_artifact 记录成员清单，再对解包后的 JS 做 R1/R2。

## 附录 A：静态探针清单（REA 种子 / grep 关键字）

| 域 | 关键产物 | 种子/关键字 |
|---|---|---|
| IPC 通道（invoke） | preload.cjs + main.cjs | windows:sync、browser:command、identity:command、authorization:command、device:command、resource:command、governance:command、model:command、mcp:command、canvas:command、task:command、agent:command、skill:command、media:command、automation:command、platform:command、developer:command、integration:command、market:command、sideeffect:command、codexCanvas:command、desktop:command、photos:command、photocraft:command、fileTransfer:command、appExchange:command、cli:command、systemFonts:command、ocr:command、window:control、files:* |
| 下行事件 | preload.cjs | native:state、display:changed、identity:event、sideeffect:event、task:event、agent:event、model:event、skill:event、media:event、automation:event、systemFonts:event、ocr:event、codexCanvas:event、window:state |
| preload 顶层键（40） | preload.cjs | sync、navigate、action、browser、onNativeState、onDisplay、identity、authorization、device、resource、governance、model、mcp、canvas、task、agent、skill、media、sideEffect、files、automation、platform、developer、integration、market、video、image、system、weather、systemFonts、ocr、fileTransfer、codexCanvas、desktop、photos、photocraft、appExchange、cli、marketUpdate、windowControl |
| 画布 | canvas-* + dist chunk | canvas/assetLibrary/、canvas/invites/、canvas/plugins/、canvas/capabilities/list、canvas/package/export、canvas/package/import、canvas/collab/、canvas/agentAttachments/、canvas/run、canvas/importAsset、openarc-asset: |
| AI | agent-*、capability-*、model-*、protocol-engine | agent/tool/catalog、agent/capability/route、capability_discover、AGENT_DEPENDENCY_UNAVAILABLE、resolveModel、providerProtocol、protocol 三元组 |
| 组织 | identity/authorization/governance | identity/initialize、identity/login、authorization/authorize、governance/grantAppAccess、governance/grantAppToolAccess、audit-list |
| 开发者/市场 | developer-*、market-* | developer/install、developer/realtime/join、developer/network/request、market/thirdparty/install、market/update/check |
| 集成 | plugin-*、integration-* | integration/plugins/health、integration/plugins/enable、integration/dingtalk/send、integration/lingxing/cache/query、integration/ziniao/jobs/start、integration/quark/search、integration/weather/query、integration/almanac/years |
| 媒体/文件 | media-*、file-service、platform/files-shared | media/render/submit、media/background-removal/remove、media/library/scan、media/short-drama/create、media/ai-declaration/process、platform/fs/shared/list、platform/fs/snapshot/create、files:import |
| 0.6.1 五域 | systemFonts/ocr/fileTransfer/codexCanvas/desktop | systemFonts/list、systemFonts/read、ocr/providers、ocr/recognize、fileTransfer/begin、fileTransfer/chunk、codexCanvas/pair、codexCanvas/relay、desktop/proxy/detect |

## 附录 B：REA 参数模板（构建后照填）

```json
{
  "op": "analyze_javascript_application",
  "input_path": "/Users/wepingli/Desktop/OpenArc OS.app/Contents/Resources/app/electron",
  "artifact_format": "directory",
  "detail": "summary"
}
```

```json
{
  "op": "inspect_analysis_view",
  "source": { "kind": "retained-evidence", "evidence_id": "<EV_MAIN 或 EV_DIST>" },
  "view": { "kind": "page", "collection": "modules", "offset": 0, "limit": 64 }
}
```

```json
{
  "op": "inspect_analysis_view",
  "source": { "kind": "retained-evidence", "evidence_id": "<EV_MAIN>" },
  "view": { "kind": "item", "collection": "modules", "selector": { "path": "preload.cjs" } }
}
```

```json
{
  "op": "compare_application_versions",
  "left":  { "kind": "retained-evidence", "evidence_id": "<上一版构建 EV_MAIN>" },
  "right": { "kind": "retained-evidence", "evidence_id": "<候选构建 EV_MAIN>" }
}
```

> compare_application_versions 的输入字段名以服务端 schema 为准；本模板仅表达“同链路两版比较”的意图。若服务端要求 inline evidence 而非 retained ref，先 export/import 再传 inline。

## 附录 C：与 task-13 的衔接

- 本计划产出：每条验收项的“期望链路 + 失败判据 + 取证操作”。
- task-13 执行时：按 §1 顺序取 EV，按 §2-§5 逐项填 §8 台账，按 §7 给结论，按 §6 把“未实现/不适用/部分”单列。
- 结论交付：按 task-13 描述写到 `docs/dxos-rea/OPENARC-VERIFY.md`（观察/推断/未知 + Evidence ID + 差异回填任务板），另附证据台账 JSON（evidence_id / view_digest / 结论）；本计划不预写结果。
