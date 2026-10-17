# OpenArc OS.app 构建后连通性复核（REA 静态验收）

> task-13 交付。对象：`/Users/wepingli/Desktop/OpenArc OS.app/Contents/Resources/app`（目录，非 asar）。
> 方法：REA `analyze_javascript_application` 对 `electron/` 与 `dist/` 各做一次静态分析，经 MCP `import_evidence_bundle` 导入后用 `inspect_analysis_view` 取 summary/modules/item 视图；另以产物源码 file:line 做字符串/命令面核对。**未启动应用、未改产物**。
> 机读台账：`docs/dxos-rea/openarc-verify-evidence.json`。

## 0. 结论摘要

- 构建来源：`main @ 9c14bb0`，`dirty=false`，`builtAt 2026-10-17T14:34:51Z`（`openarc-build.json`）。目录内容 sha256（逐文件 sha 排序后再 sha）与 lead 给定一致：`ec9214cdbf9f21d2b9acadfb571bc75570c6d5d9f2449fed86226db3763b933a`。
- 关键文件 sha256：`package.json` = `ba4473cf…7f584c`、`electron/main.cjs` = `9a7cca12…b40e9809c`、`dist/vue.html` = `0baf1aeb…4242efb8`（均与 lead 给值一致）。
- 验收项：**49 条（A8 + B8 + C8 + D12 + E13）** → **通过 47、部分通过 2（B7、C4）、不通过 0、未知 0**；**a0740a1 复验后 B7/C4 转通过，最终 49/49 通过（见 §11 Addendum）**。
- 产品 OUT / 不适用：A14 画布云同步、F17 云账号权益、D02 云市场审核灰度、F14 本地计费配额（`electron/ai-org-parity-notes.cjs:8-10`）、F16 桌面自动超管（有意差异，`:12-13`）、D07 开发者 OAuth/发布（既有产品决定）。
- 已知部分/差异（不算失败，按 task-13 口径）：A02 画布文档模型仍是 nodes/edges（未检出 Card 三槽转换）、A11 未检出 `canViewCanvasMedia` 等价放宽、A13 .dxcanvas 内联导出仍受 32MB 限制（包解析上限 500MB/1GB 存在）、A18 docx/xlsx 默认解析器不可用（可注入 parser，缺省结构化拒绝）。
- 关键观察：preload 40 个顶层键与 57 个唯一 invoke/send 通道全部在主进程侧有注册；58 个 `ipcMain.handle` 中 100% 在上下文内出现 `trusted(`/`isTrusted`（静态邻近检查，0 例外）。
- 未确证：运行期行为（权限实际拒绝、LAN 鉴权、迁移实际执行、模型/网络调用、UI 交互）不在静态分析范围内；REA 覆盖为 partial（见 §10）。**本报告所有“通过”仅指静态连通（观察）；是否运行可用属推断/未知，不等同于功能验收通过。**

## 1. 证据基线

| 项 | 值 |
|---|---|
| 产物根 | `/Users/wepingli/Desktop/OpenArc OS.app/Contents/Resources/app`（477 文件，22 MB；dist 15 MB、electron 276 个 .cjs） |
| 构建标记 | `branch=main`、`commit=9c14bb0`、`dirty=false`、`ref=HEAD`、`builtAt=2026-10-17T14:34:51.209Z` |
| 目录 sha256 | `ec9214cdbf9f21d2b9acadfb571bc75570c6d5d9f2449fed86226db3763b933a`（与 lead 一致） |
| 文件 sha256 | package.json `ba4473cf…`；electron/main.cjs `9a7cca12…`；dist/vue.html `0baf1aeb…`（均与 lead 一致） |
| 参考基线（lead 提供） | npm test 3604/3604/0；build exit 0；真机总探针 48/48（`artifacts/fe-acceptance/report.json`） |
| REA（主进程） | `ev_a85d2fcb10a8007d1cbcb992e29a781d0027990fc1bc1b216793e455df8a1bfc`；目录 digest `eed43c76…`；307 文件 / 306 JS / 1604 findings / 0 解析失败 / 0 完整性矛盾 |
| REA（渲染层） | `ev_ee028b590873d3a4da746a783b6ec235d002f6586ed094c52a7238fa42dbcb9a`；目录 digest `933dea85…`；49 文件 / 42 JS / 1229 findings / 0 解析失败 |
| REA IPC 统计（主进程） | literal_channels 72、renderer_transmissions 62、main_handlers 30、paired 33、unpaired 29、preload 1、context bridge 1、exposed 112、sender_validation 0 |
| 视图证据 | 主进程 summary `ev_d713cddec47b9f46977c7e8185498d637a0d9bea7ba04a3073fe0d10aabd76f0`；渲染 summary `ev_d30e21fe8e7de5221c9ad1c9f883e62678b56971e55a4e32836b32d3e78bd85a`；modules 分页 `ev_9e3c9abf72d71a1cb19eb1beeaf832686777d08027dbc5962b44404aed80fad1`、`ev_cc665322a02e0be487ba5182321dc0ffedd10f07a3c2ac1c35afa22c97cff2a0` |
| 限制 | REA 是静态分析；`sender_validation_observations=0` 属识别限制（源码邻近检查已补）；覆盖 partial/预算截断见 §10。 |

## 2. 验收项 A：画布 → 资源库 / 素材库

| # | 检查点 | 观察（产物证据） | 结论 | Evidence |
|---|---|---|---|---|
| A1 | 画布宿主→canvas 命令桥 | preload `canvas` 键（`electron/preload.cjs:141`）；`canvas:command` 在 8 个 electron 文件中注册；dist 中 `openarc.canvas`（vue-FjsmuJ9E.js、ApprovalPrompt 块） | 通过 | EV_MAIN；preload view ev_61cbce8716a7271faa9f5feac8ed57bf88000773c943005f3028c4568bfada3b |
| A2 | 素材库命令族（11 条） | `canvas/assetLibrary/{list,ensure,create,get,items,import,upsert,update,reference,attach,delete}` 均在 electron 命中（1–2 文件/条）；dist 命中 list/ensure（其余经动态 command 分发） | 通过 | EV_MAIN；canvas-cmds view ev_31839811fba8e6e72093dc765e238acce97d33929f6d5bcd4776fdf13065a95e |
| A3 | syncSources | `canvas-dxos-commands.cjs:51,235`；dist 含 `canvas/assetLibrary/syncSources` | 通过 | EV_MAIN；canvas-cmds view ev_3183… |
| A4 | 画布↔资源域引用 | `canvas/importAsset`、`canvas/readAsset`（canvas-service.readAsset 路径，`canvas-dxos-commands.cjs:195-204`）；`openarc-asset` 在 electron 11 文件、dist 3 文件 | 通过 | EV_MAIN；EV_DIST |
| A5 | 素材库 ACL/可见性 | `canvas-dxos-asset-library.cjs:36` 四档 PRIVATE/ORGANIZATION/PUBLIC/RESTRICTED；`:37` publicAccess READ/EDIT；`:134-139` 成员/公开判定；`:262-280` 逐成员 ACL（仅 owner 可改） | 通过 | EV_MAIN；asset-lib view ev_bd9b8ae6074cefe8c43ab59af88613c75dcf888ced188ea917dd24dcb39f21c9 |
| A6 | 相册→画布/素材库导入 | `photos/importImage`（`photos-domain.cjs:183`）；canvas-exchange importer 在 main 装配（`main.cjs` 含 canvas-exchange）；dist 3 文件命中 | 通过 | EV_MAIN；photos view ev_ebf42dcb4ccba0a6ad40c626ea8c65a1664f8004971b7b175301776785af771f |
| A7 | 画布插件数据/网络 | `canvas/plugins/data`、`canvas/plugins/network`（`canvas-dxos-commands.cjs:76-77,293-305`）；`canvas-dxos-plugins.cjs` 存在；main 装配 pluginHost；dist 各 1 文件 | 通过 | EV_MAIN；plugins view ev_27df3cde67478c149b01d1f793be0160da9e6eef437b7c172fdce264e78f513d |
| A8 | 画布邀请码 | `canvas/invites/{get,create,revoke,redeem}`（`canvas-dxos-commands.cjs:67-70,279`）；dist 命中 create/redeem | 通过 | EV_MAIN；canvas-cmds view ev_3183… |

## 3. 验收项 B：全局 AI → 工具 / 功能

| # | 检查点 | 观察（产物证据） | 结论 | Evidence |
|---|---|---|---|---|
| B1 | agent 桥与命令面 | preload `agent`（`preload.cjs:166`）；`agent:command` 注册；`agent/task/*`、`agent/run/*`、`agent/tool/{catalog,describe,call}`、`agent/capability/route`、`agent/jarvis/run`（dist；主进程经 `agent/project/run` 的 `gateway=jarvis` 落实现，`agent-service.cjs:830`）、`agent/project/*`、`agent/developer-app/run`；dist 命中多处 | 通过 | EV_MAIN；agent view ev_137f46b3a968417a1cb55d0e93ab0adfb7d7feb79a896011e9cc4398a323b613 |
| B2 | 工具目录/能力发现 | `agent-tool-catalog.cjs`；`tool-registry.cjs` 出现 system/file/app/mcp/skill/media/canvas 源；`capability-discovery.cjs`；dist 中 `agent/tool/catalog` 2 文件 | 通过 | EV_MAIN |
| B3 | 能力路由与模型回退 | `capability-router.cjs`、`capability-target-resolver.cjs`、`progressive-capability-router.cjs`、`model-resolver.cjs`、`model-service.cjs` 均在包；`agent/capability/route`（`agent-service.cjs:792`） | 通过（静态） | EV_MAIN |
| B4 | 模型/协议引擎 | `model:command` 命令面；`protocol-engine/` 30 个文件；`provider-protocol-domain/store/service` 28 文件；dist 命中 `provider-protocol` 与 model 命令 | 通过 | EV_MAIN |
| B5 | task 运行时（对话/项目） | preload `task`（`preload.cjs:151`）；`task:command`；`task/run`、`task/appendStep` 在 electron+dist；ChatApp/AssistPanel 走 task 桥 | 通过 | EV_MAIN；EV_DIST；vue view ev_abb07fbf447b29c846ea1e059eedb7f40725c11b797ee47961d6baf5cb120282 |
| B6 | skill/media/mcp 工具接入 | preload `skill/media/mcp`；三域命令表；dist 命中各域命令 | 通过 | EV_MAIN |
| B7 | 审批/确认（sideEffect） | preload `sideEffect`（`preload.cjs:212`）含 command/revokeApproval；`sideeffect:command`；electron 有 `sideEffect/{approvalRequested,decideApproval,listPending,revokeApproval}`；dist 有 approvalRequested/decideApproval/listPending + ApprovalPrompt 块，但**未见 `revokeApproval` 字面量** | **部分通过**：审批/决策链路在；renderer 撤销入口未检出 | EV_MAIN；approval view ev_401033deb9bacb10c0469d0e6d673f765b955f0b3e5c027137bb91345a868f14 |
| B8 | 画布 Agent 能力投影 | `canvas/capabilities/list`（`canvas-dxos-commands.cjs:86,339`）；`canvas/run`、`canvas/modelChat/modelImage`；`canvas_*` 工具名在 capabilities 文件 | 通过（静态） | EV_MAIN |
## 4. 验收项 C：组织权限

| # | 检查点 | 观察（产物证据） | 结论 | Evidence |
|---|---|---|---|---|
| C1 | identity 桥/命令 | preload `identity`（`preload.cjs:50`）；`identity:command`；`identity/{status,initialize,login,restore,logout,lock,unlock,change-password,validate,...}`（`identity-service.cjs:276-312`）；dist 命中 `identity/initialize` 2 文件 | 通过 | EV_MAIN |
| C2 | authorization 命令/决策 | preload `authorization`（`:67`）；`authorization:command`；`authorization/{authorize,capabilities,resource,resolve,notification,list,search}`（`authorization-bootstrap.cjs:23-29`）；dist 命中 `authorization/capabilities`（直接 authorize 未见：UI 不直接调，属预期） | 通过（主进程面完整） | EV_MAIN |
| C3 | governance 用户/部门/角色 | preload `governance`（`:101`）；`governance:command`；命令含 listUsers/getUser/createUser/setUserRole/listDepartments/createDepartment/updateDepartment/deleteDepartment/add-remove member/listResourceAccess/grant-revoke/bulk/transfer...（`governance-bootstrap.cjs:30-61`）；dist 命中 listUsers/createUser/listDepartments/listAudit 等 | 通过 | EV_MAIN；gov view ev_cc4326271d075ee3c78274cf83cbc8e2838f13d2ff5b9a333a3d057980d63775 |
| C4 | App 授权与工具级权限 | electron：`governance/grantAppAccess`（`governance-bootstrap.cjs:55,100`）、getAppAccess、getAppToolAccess、grantAppToolAccess、revokeAppToolAccess、setAppStatus；dist：命中 getAppToolAccess/grantAppToolAccess/revokeAppToolAccess/setAppStatus/listApps，**未命中 grantAppAccess/revokeAppAccess** | **部分通过**：工具级授权 UI 已接；App 级 grant/revoke 未见 renderer 调用 | EV_MAIN |
| C5 | 资源 scope/隔离 | preload `resource`（`:90`）；`resource:command`；`resource-bootstrap.cjs:20-60` 63 条命令（list/get/import/trash/collection/tag/version/relations）；`resource-domain.cjs` scope（PERSONAL/DEPARTMENT/ORGANIZATION） | 通过 | EV_MAIN |
| C6 | 审计 | `governance/listAudit`（`governance-bootstrap.cjs:61,106`）；`identity/audit-list`；`app_network_audit`/`app_runtime_events` 在 electron 多文件写入/查询；dist 命中 audit 4 文件 | 通过 | EV_MAIN |
| C7 | trusted(event) 边界 | `main.cjs:285 function trusted(event)`；全包 58 个 `ipcMain.handle`，邻近 20 行内 100% 出现 `trusted(`/`isTrusted`；preload 40 顶层键、57 个唯一通道全部在主进程侧有注册 | 通过（静态） | EV_MAIN；main view ev_cce0145236a335bf8cac16ec8342d0e9a0f1598636b968cbe60b1f6760525422 |
| C8 | 首启/本地会话 | `identity/initialize`、`identity/local-account-info`（identity-service）；`local-account-service.cjs`；dist 命中 identity/initialize 2 文件 + SetupScreen/identity store | 通过（与 DX 有意差异：sessionRef 显式登录，不做桌面自动超管） | EV_MAIN；EV_DIST |

## 5. 验收项 D：开发者 / 集成 / 市场 / 媒体 / 文件共享

| # | 检查点 | 观察（产物证据） | 结论 | Evidence |
|---|---|---|---|---|
| D1 | developer 本地装载/回滚 | preload `developer`（`:290`）；`developer:command`；`developer-domain.cjs:223-280` 70 条命令（install/uninstall/enable/disable/rollback/validate/health/credential/network/runtime...）；dist 命中 install/rollback | 通过 | EV_MAIN |
| D2 | lab/collab/realtime | electron 含 `developer/lab`、`developer/collab`、`developer/realtime/join`（`developer-realtime.cjs:408-422`）；dist 命中 `developer/realtime/join` | 通过 | EV_MAIN |
| D3 | 凭据/出网审计 | `developer/credential/bind`、`developer/network/request`（`developer-domain.cjs`）；`app_network_audit` 写入；dist 无 network 命令字面量（App 侧调用，非 UI） | 通过（主进程面完整） | EV_MAIN |
| D4 | 市场目录/第三方/更新 | preload `market`（`:311`）；`market:command`；`market-domain.cjs:44-56`（catalog/apps/skillpacks/thirdparty list/install/rollback/source get-set）；`market-update-domain.cjs:61-67`（status/check/install/rollback/health/sources/source-set）；dist 命中 thirdparty/install、update/check | 通过 | EV_MAIN；market view ev_ada633c5568481636b747d29228429e02043669cd1809269ed864b81e93e17b2 |
| D5 | integration 插件 | preload `integration`（`:302`）；`integration:command`；`plugin-service.cjs:87-153` 91 条 integration 命令；`plugin-registry.cjs` 依赖探测；dist 命中 `integration/plugins/health` | 通过 | EV_MAIN；plugin-svc view ev_df2b9def8d3df540522b7c13a57348111c49e96ca7aaafbcccccb0128e8966f0 |
| D6 | media / video / image / weather | preload `media`（`:196`）、`video`（`:321`）、`image`（`:333`）、`weather`（`:340`）；`media:command`；`media/render/submit`、`media/audio/{extract,trim}`（`media-domain.cjs:92-94`）、short-drama、ai-declaration；`image:declare`、`weather:*` handler；dist 命中 media 命令 | 通过 | EV_MAIN |
| D7 | photos/photocraft/fileTransfer/appExchange | preload `photos`（`:420`）、`photocraft`（`:430`）、`fileTransfer`（`:382`）、`appExchange`（`:440`）；四通道均注册；命令 `photos/importImage`、`fileTransfer/{begin,chunk}`、`appExchange/*`；dist 均有命中 | 通过 | EV_MAIN；photos view ev_ebf4…；ft view ev_eff9ba31b48afc1d4b27c1ce1b81cf4483437800610dce5b4f0a9dc795a1d1a6 |
| D8 | files IPC + 共享盘/快照 | preload `files`（`:234`，16 个 files:* handler）+ `platform`（`:280`）；`platform/fs/shared/{roots,list}`、`search`、`stats`、`snapshot/{create,restore}`（`platform-domain.cjs:72-77`）；`files-shared-bridge.cjs`；dist 命中 shared/roots 与 snapshot | 通过 | EV_MAIN |
| D9 | 0.6.1 五域 | systemFonts（`:352`）/ocr（`:367`）/fileTransfer（`:382`）/codexCanvas（`:393`）/desktop（`:409`）键与通道均在；命令 `systemFonts/list`、`ocr/recognize`、`desktop/proxy/{detect,set,clear,state}`；dist 均有命中 | 通过 | EV_MAIN；fonts view ev_7bb0…；ocr view ev_0ed3… |
| D10 | CLI | preload `cli`（`:452`）；`cli:command`；`cli/status` 等命令；`cli-runtime/` 随包；dist 命中 cli/status | 通过 | EV_MAIN |
| D11 | 桥/通道一致性 | preload 40 顶层键；57 个唯一 invoke/send 通道；主进程侧注册覆盖 57/57；58 个 handler 全部 trusted 邻近；域装配失败降级 NOT_READY（main registerDomainOrDegrade 块） | 通过 | EV_MAIN；preload view ev_61cb… |
| D12 | market thirdparty/更新源 | `market/thirdparty/{list,install,rollback,source/get,source/set}`（`market-domain.cjs:52-56`）；`market/update/*`（`market-update-domain.cjs:61-67`）；dist 命中 thirdparty 与 update/check | 通过 | EV_MAIN |
## 6. 验收项 E：扩展能力（非 DX parity）

| # | 检查点 | 观察（产物证据） | 结论 | Evidence |
|---|---|---|---|---|
| E1 | i18n / 英文界面 | dist 含 `en-US` 2 文件、`locale` 6 文件、`language` 7 处；`novai-canvas/static/js/i18n*`；切语言运行行为未验证 | 通过（静态） | EV_DIST |
| E2 | 相册扩图/宫格 | dist 命中 `宫格` 7、`扩图` 13、`grid` 17、`onnxruntime` 1；ONNX 依赖缺失时结构化不可用（源码可见，未运行） | 通过（静态） | EV_DIST |
| E3 | 日历提醒/农历/AI 建日程 | dist 命中 `almanac` 1、`Notification` 3、`提醒` 2；integration/almanac 命令在 electron；定时恢复未验证 | 通过（静态） | EV_DIST；EV_MAIN |
| E4 | 访达共享盘/部门盘/快照 UI | dist 命中 `共享盘` 17、`快照` 32、`部门盘` 1；`platform/fs/shared/{roots,list}`、`snapshot/{create,restore}` 在 electron；越权拒绝运行未验证 | 通过（静态） | EV_DIST；EV_MAIN |
| E5 | 视频多轨/Agent 粗剪 | dist 命中 `多轨` 14、`trackType` 9、`timeline` 92、`Agent 粗剪` 1；`media/render/submit`、media-domain 时间线；多轨渲染运行未验证 | 通过（静态） | EV_DIST；EV_MAIN |
| E6 | 短剧素材登记/成片导出 | dist 命中 `成片` 20、`登记` 42、`资源库` 28；`media/short-drama/*` 命令在 electron；导出落盘运行未验证 | 通过（静态） | EV_DIST；EV_MAIN |
| E7 | 画布 .dxcanvas/协作/邀请 UI | `canvas/package/export`、`canvas/collab/join`、`canvas/invites/create` 均在 dist 命中；新面板文件（CanvasAssetSyncPanel/InvitePanel/PluginsPanel）随源码提交，构建 chunk 含命令 | 通过（静态） | EV_DIST；EV_MAIN |
| E8 | 市场第三方 UI + 全应用更新 | dist 命中 `market/thirdparty/list`、`market/update/check`；electron 命令表完整 | 通过（静态） | EV_DIST；EV_MAIN |
| E9 | 设置真实能力（代理/缓存/更新） | electron+dist 均命中 `desktop/proxy/{set,clear,state}`、`desktop/cache/clear`、`desktop/update/{check,download,source/get,source/set}` | 通过（静态） | EV_MAIN；EV_DIST |
| E10 | 桌面小组件音乐/天气 | dist 命中 `widget` 68、`widgets` 15、`小组件` 10、weather 命令；数据源真实性未验证 | 通过（静态） | EV_DIST |
| E11 | 窗口标签合并（tabGroupId） | `window-domain.cjs:204,210-212,260-265` 含 tabGroupId/tabGroups；dist 命中 tabGroupId 2 文件；合并/拆分 UI 实际交互未验证 | 通过（静态） | EV_MAIN；window view ev_5db92e324cb5f7154b69bd1fddf630965231bb425fe38e798c0266226af94935 |
| E12 | 任务双表 v29 + LAN 协作 | `task-merge-migration.cjs` 含 TASKS_V29_DDL/foreign_key_check/开关文件；`lan-collab-service.cjs` 含 desktop/lan/{start,stop,status,pair...}；dist 含 lan 命令；迁移实际执行未验证 | 通过（静态） | EV_MAIN |
| E13 | 开发者/集成/0.6.1 五域 UI | dist 命中 developer/health、integration/plugins/health、ocr/providers、fileTransfer/health、systemFonts/list、desktop/proxy/detect；对应面板源码在 src-vue | 通过（静态） | EV_DIST；EV_MAIN |

## 7. 部分通过明细（2 条，不判失败）

> 2026-10-17 a0740a1 复验：B7/C4 两处均已修复并通过，见 §11 Addendum；本节保留 9c14bb0 时点的记录。

### 7.1 B7 审批/撤销

- 观察：preload `sideEffect` 键（`preload.cjs:212-221`）暴露 `command` 与 `revokeApproval`；electron 侧命令含 `sideEffect/approvalRequested`、`decideApproval`、`listPending`、`revokeApproval`（`side-effect-*` / approval 相关 24 个文件出现 `sideEffect`）；dist 命中 `sideEffect/approvalRequested`、`decideApproval`、`listPending` 与 ApprovalPrompt 块，但**未命中 `revokeApproval`**。
- 结论：审批/决策/待办链路存在；renderer 是否提供“撤销已批准未执行操作”的入口未检出。按 VERIFY-PLAN B7 判据（写操作无审批直接执行才算失败）不判失败，记部分通过。
- Evidence：EV_MAIN；approval view `ev_401033deb9bacb10c0469d0e6d673f765b955f0b3e5c027137bb91345a868f14`。

### 7.2 C4 App 级授权 UI

- 观察：electron 侧 `governance/grantAppAccess`（`governance-bootstrap.cjs:55,100`）、`getAppAccess` 等存在；dist 只命中工具级 `getAppToolAccess`/`grantAppToolAccess`/`revokeAppToolAccess`/`setAppStatus`/`listApps`，未命中 `grantAppAccess`/`revokeAppAccess`/`getAppAccess`。
- 结论：App 级授权命令在主进程可用；组织/治理 UI 是否暴露 App 级授权入口未检出（工具级已接）。按判据不判失败，记部分通过。
- Evidence：EV_MAIN；gov view `ev_cc4326271d075ee3c78274cf83cbc8e2838f13d2ff5b9a333a3d057980d63775`。

## 8. 产品 OUT / 不适用 / 有意差异

| # | 项 | 依据（产物） | 结论 |
|---|---|---|---|
| O1 | A14 画布云同步/云备份 | 包内无 `/api/canvas/cloud*`、无 `canvas_cloud_sync` 命令；canvas 模块注释明确 OUT（源 task-12 产品口径） | 不适用（产品 OUT） |
| O2 | F17 云账号/权益/兑换/席位 | electron 无 entitlement/cloud account 服务；与本地部署口径一致 | 不适用（产品 OUT） |
| O3 | D02 云市场审核/灰度 | `market-domain.cjs` 只含本地 catalog + thirdparty；`market-update-domain.cjs` 只有 GitHub/ModelScope 在线更新；无云审核/灰度/目录 | 不适用（产品 OUT）；第三方/在线更新已通过 D4/D12 |
| O4 | F14 本地计费/配额 | `ai-org-parity-notes.cjs:8-10`：`NOT_APPLICABLE`，计费/配额判 OUT；`api_quota_rules` 原语保留不对模型调用接线 | 不适用（产品 OUT） |
| O5 | F16 桌面自动超管会话 | `ai-org-parity-notes.cjs:12-13`：`INTENTIONAL_DIFFERENCE`，用首启初始化 + 显式登录/锁屏 + sessionRef | 不适用（有意差异） |
| O6 | D07 开发者 OAuth/发布/灰度 | `developer-domain.cjs:30,39,519,545`：manifest 出现 oauth/publish/gray/rollout 即拒绝；无对应桥命令 | 不适用（产品决定） |

## 9. 已知部分/差异（不进入本次 49 项判定，按口径记录）

| # | 项 | 本次产物观察 | 判定 |
|---|---|---|---|
| P1 | A02 画布文档模型（Card 三槽） | `canvas-domain.cjs` 仍为 nodes/edges/viewport/logs；未检出 Card 的 inputs/params/result/history 转换层（仅通用 params/result 字符串命中） | 已知差异（task-25 已审计；未等价） |
| P2 | A11 画布媒体可见性放宽 | 未检出 `canViewCanvasMedia` 等价实现；媒体可见性主要走 resource/authorization | 已知差异/未知（静态未检出） |
| P3 | A13 .dxcanvas 大包 | `canvas-dxos-commands.cjs:32,403` 内联上限 32MB；`canvas-dxos-package.cjs:29-32` 解析上限 500MB/1GB（导出走内联仍受限） | 已知限制，不算断链 |
| P4 | A18 docx/xlsx 附件 | `canvas-dxos-agent-attachments.cjs:39` `BINARY_PARSERS_UNAVAILABLE`；支持注入 parser，缺省结构化 parseError（如实不可用） | 按“已实现/如实不可用”判通过，不判失败 |

## 10. 未确认与限制

1. **未启动应用**：所有结论均为静态产物分析；权限实际拒绝、LAN 鉴权、v29 迁移执行、模型/网络调用、UI 交互与动效均未运行验证。
2. **REA 覆盖 partial**：主进程 summary 视图 coverage examined 393/972；渲染 summary 679/834；limitations 条目主进程 580、渲染 62；`sender_validation_observations=0` 属识别限制（源码邻近检查补足）；unpaired renderer transmissions 29 与“域通道由 bootstrap 动态注册”一致，不当作断链。
3. **字符串探测的边界**：命令可能经变量/动态拼接下发（如 A2 的部分素材库命令），未命中不等于未接线；本报告对每条结论分别标注“通过（静态）/部分/未知”。
4. **dirty 状态**：构建 `dirty=false`，结论只对该 commit（9c14bb0）与上述 sha256 的产物有效。
5. **产品 OUT 项**按 lead 决策与产物口径记“不适用”，不从“缺失/失败”统计。

## 11. Addendum：a0740a1 聚焦复验（B7/C4 修复）

### 11.1 构建与证据

| 项 | 9c14bb0（首验） | a0740a1（复验） |
|---|---|---|
| 构建目录 sha256 | `ec9214cdbf9f21d2b9acadfb571bc75570c6d5d9f2449fed86226db3763b933a` | `3934d24598b85676fcdc1e8515106ec23f9528a7e14562acea3a883ca71cc94c` |
| dirty / builtAt | false / 2026-10-17T14:34:51Z | false / 2026-10-17T14:49:26Z |
| electron/main.cjs | `9a7cca12…b40e9809c` | `9a7cca12…b40e9809c`（未变） |
| dist/vue.html | `0baf1aeb…4242efb8` | `08207f64fbc1a8e123a85dace61c601b96760081ec102ab1a4bc751734ead194` |
| REA 主进程 | `ev_a85d2fcb…8a1bfc`（digest eed43c76） | 重新分析 digest 仍为 `eed43c76dbed9c3b5e1f0f686e51d02fcc7c5147585fb1b0d812f95b63a89cb2` → 按复用规则继续用 `ev_a85d2fcb…8a1bfc`（新记录 ev_62f39ef4… 仅为同一 digest 的重复分析） |
| REA 渲染层 | `ev_ee028b59…dcb9a`（digest 933dea85） | 新 digest `1872ae3729d14ebf784f10f1f1f407f1cbd64cb061441ac1553ad5abcc47fda5` → 新 Evidence `ev_db677751c8ee35ff9646d9d80d3a04ea75e62ad15b691dd90bb53b4736a75e60`；summary `ev_3b55aac9ae0f6d84481b290d022c1ec10fd9b93bf2a2e4c744ee9fd3d9516109`；modules `ev_75cf20b3dc160a6433e6a69c026c861a89f0a3f872f3b69094a9e6871dce2c9e` |
| 变更 chunk | — | `ApprovalPrompt-BDsWYXk0.js`、`vue-DGjggzKl.js`、`main-luqkwsX-.js`（旧 BB / DVBZ6OQI 等） |

### 11.2 聚焦复验结果

| # | 检查点 | 观察（a0740a1 产物） | 结论 | Evidence |
|---|---|---|---|---|
| B7 | 审批撤销入口 | `ApprovalPrompt-BDsWYXk0.js` 命中 `sideEffect/revokeApproval`（撤销处理器：command type=sideEffect/revokeApproval）、`approval-revocable`、`data-approval-revocable`、`SIDE_EFFECT_APPROVAL_TOO_LATE`、提示“已撤销；这次操作不会执行。”；`ApprovalPrompt` 被 `main-luqkwsX-.js` 与 `vue-DGjggzKl.js` 引用；electron 侧 `preload.cjs:215` 暴露 `revokeApproval`，`side-effect-bootstrap.cjs:20,70` 有命令与分支 | **通过**（静态） | EV_DIST2 `ev_db6777…5e60`；ApprovalPrompt item `ev_93eda6be4e0ded75bc45985bc2cd48a461f49e50cfb1276165affc23ddf8792f`；EV_MAIN `ev_a85d…` |
| C4 | App 级授权 UI | `vue-DGjggzKl.js` 命中 `governance/getAppAccess`、`governance/grantAppAccess`、`governance/revokeAppAccess`，含确认对话框“授予 App 级权限”“撤销 App 级权限”、动作多选与说明；electron 侧 `governance-bootstrap.cjs:54-56,99-101` 命令与分支完整 | **通过**（静态） | EV_DIST2；vue item `ev_faf0fde4b80188ff369c69f486876aebba740f06f82fd160dcc7797927b80245`；EV_MAIN `ev_a85d…` |

### 11.3 复验后计数

- **49/49 通过**（原 47 通过 + B7/C4 两处转通过）；部分通过 0、不通过 0、未知 0。
- 原先为 B7/C4 建的 task-43 已按“已修复并静态复验”关闭（见任务板）。
- 复用规则：electron digest 未变 → 沿用 `ev_a85d2fcb…`；dist digest 变化 → 新证据 `ev_db6777…`，旧 `ev_ee028b59…` 保留为 9c14bb0 baseline。

### 11.4 本次复验限制

- 仍是静态分析：未启动应用、未点击撤销/授权按钮；UI 入口通过“命令字面量 + 处理器上下文 + chunk 被主入口引用”判定，不等于运行交互通过。
- 新 dist summary coverage examined 674/837；REA 覆盖 partial 的既有结论不变（见 §10）。
- 结论只对 a0740a1 与上述产物 sha256 有效。

## 12. 证据台账

- 机读台账：`docs/dxos-rea/openarc-verify-evidence.json`（build、产物 sha256、REA evidence/view id、49 项结论、OUT/部分/未知、限制）。
- 复用规则：本报告引用的 `EV_MAIN`/`EV_DIST` 与各 view id 已在本 REA 会话留存；同一产物 sha256 的复验可直接 `inspect_analysis_view` 复用，产物变化时按 VERIFY-PLAN §1.3 重新分析或 `compare_application_versions`。
