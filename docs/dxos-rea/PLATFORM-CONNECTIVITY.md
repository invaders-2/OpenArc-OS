# DX OS 0.6.1 平台功能连通性（自动化 / MCP / Skill / 市场 / 开发者 / 文件传输 / OCR / 字体 / CLI / 代理 / 媒体 / 桌面壳）

> 任务：共享 task-11（rev 2）。目标同 task-1：DX OS 0.6.1 运行时（app.asar + 同目录 app.asar.unpacked）。
> 约定：以 U/ 开头的 file:line 是随包 TS 源码阅读（非 REA Evidence）；SHELL/DIST 指 app.asar 与 app.asar.unpacked/dist；REA Evidence 复用 task-1 的 ev_501ab8…（app.asar）、ev_aea4933…/ev_b95a3cb…（asar 成员图）、ev_9178e6a…（dist）。只读分析，不含实现建议，不声称观察执行。
> 0.5.5 事实取自既有报告 DX-OS-完整逆向报告.md（附录 A/B/E），仅作对照；不能确认的已单列未知。

## 0. 方法与覆盖

- 【观察】0.6.1 的 app.asar 只含 Electron 外壳（packed 18 个文件）与依赖闭包；平台功能逻辑在 U/server 的 TS 源码，前端在 U/dist 的 49 个 JS chunk；REA 对 SHELL 的覆盖为 partial（13 个字面 IPC 通道、1 个 preload；semantic 截断），对 DIST 的 49 个 JS 覆盖完整（0 解析失败）。平台功能结论主体是源码阅读。
- 【观察】前端入口按 chunk 定位：以下 “chunk@偏移” 均为构建产物内的字符偏移（单行压缩文件），不是源码行号。
- 【观察】后台执行只有两类 Worker 进程（SHELL main.cjs 用 tsx 拉起 U/server/worker.ts）：项目任务/项目 Agent（worker.ts:40-90、279-292）与视频渲染（worker.ts:279-292）。自动化、MCP、AI 任务、市场、开发者平台均在 API 进程内跑（或由外壳/外部程序跑）。

## 1. 十行结论

1. 自动化分两条执行面：桌面动作（music_play/open_app/agent_instruction）由登录的桌面客户端 POST /api/automations/claim 领取执行；业务动作（紫鸟下载/领星缓存/紫鸟数据入库/钉钉通知/workflow_sequence/app_action）由 API 进程内 15 秒轮询调度器执行（U/server/index.ts:10915-10929、10949-10952）。
2. MCP 是“配置文件 + 运行时连接池 + 工具聚合”：系统内置 6 个 MCP（video-clip/figma/illustrator/lingxing/ziniao/dingtalk-mcp，U/server/mcp.ts:243-281），用户 MCP 存 data/mcp.json、系统状态存 mcp.system.json，敏感 env/headers 经 secretVault 加密/掩码；工具以 mcp__<server>__<tool> 进入 Agent 工具目录。
3. MCP 的 HTTP 面（/api/mcp/* 管理、/api/mcp/call(-direct)、/api/mcp/test-agent）在 0.6.1 无鉴权中间件（U/server/index.ts:8213-8259、8441-8455、8730），外壳默认注入 HOST=127.0.0.1（仅 lanEnabled 时 0.0.0.0，SHELL/main.cjs:1144），server 自身直接运行时默认 HOST=0.0.0.0（U/server/index.ts:423）；这是与组织权限体系脱节的一块。
4. Skill 由三层组成：内置/自定义技能（U/server/skills.ts，data/skills.json 启停与自定义定义）、Skill Pack（U/server/skillPacks.ts，data/skill-packs + index.json + bundled-skill-packages）、以及 Agent 可发现技能（exposure=agent 且 allowImplicitInvocation!=false 才进工具目录）。
5. Skill Pack 的 Python 入口通过 Docker 沙箱执行（skills.ts 无沙箱，skillPacks.ts:25-26 配置 SKILL_SANDBOX_IMAGE 默认 fastapi-fastapi-app:latest、SKILL_SANDBOX_RUN_DIR，:538-576 dockerRun），另有“AI 测试/AI 生成参数”（LLM 读 SKILL.md/--help）两条非执行路径。
6. 应用市场是远程目录 + 本地 Release 服务双源：市场内容来自 https://api.dx-os.com/v1/market/*（marketplace.ts:1、207-335，缓存 5 分钟），APP 更新目录来自 /v1/apps/catalog（appUpdates.ts:21-22），本地发布用 Ed25519 签名 + SHA-256 存入 ccs.db app_market_releases 与 data/app-releases/<appId>/<channel>/<version>+<build>.zip（appReleases.ts:10-13、160-190）。
7. 安装/更新/回滚全链路有健康检查与数据版本迁移：POST /api/market/developer-apps/:id/install|update|rollback 依次做 目录签名/大小/SHA 校验 → importDeveloperApp 原子安装（staging→rename，保留 1 个回滚点）→ healthCheck → 失败自动回滚；dataVersion 变化必须逐级声明式迁移并做项目快照（index.ts:9195-9340、developerApps.ts:895-1005）。
8. 开发者平台的核心闭环是“Lab 草稿（AI 生成/编辑/预览/实时房间）→ publish（签名 Release）→ install/update/rollback + project 文件 + credentials/OAuth + collab/realtime + agent 任务/产物”，路由集中在 /api/market/developer-lab/*、/api/market/developer-apps/*、/api/developer-docs、/api/developer-oauth/callback、/api/codex-canvas/*（index.ts:9143-10559、1193-1410）。
9. 文件传输只有一条受控用途：photocraft 保存包（POST /api/file-transfers purpose=photocraft-save，分片+sha256+版本冲突+并发限流），由 DeveloperAppHost 宿主桥调用；OCR 走 PaddleOCR AIStudio 云端（/api/ocr/providers|recognize，32 MB/4 并发/单人 2 并发，服务端用保存的 Token 调 https://paddleocr.aistudio-app.com/api/v2/ocr/jobs）；系统字体只经宿主桥暴露给 dx-app（/api/system/fonts）。
10. 桌面壳把两类 IPC 分开：渲染进程→主进程 13 个 invoke 通道（clipboard/data dir/openExternal/update/ensureLocalAdminSession 等，preload 全部暴露为 window.dxDesktop），主进程→渲染进程 2 个事件（update-progress、system-resume）；与便携启动器之间另有 update-request/response、rollback-request/response 的 process.send 通道（SHELL/main.cjs）。本地代理探测在 API 进程（/api/desktop/proxy/detect，仅 loopback），实际代理生效在外壳（proxy.cjs + cloud-compatibility）。

## 2. 自动化（automations）

| 链路环 | 事实 | 证据 |
|---|---|---|
| 前端入口 | AutomationsApp chunk（DIST/assets/AutomationsApp-BBeEKtV2.js）+ 全局 store（DIST/assets/index-DJDR-kWU.js @349,010 起，方法：GET /automations、/automations/catalog、POST /automations/parse、创建/更新/删除/run-now/claim/complete） | DIST 静态阅读；REA DIST ev_9178e6a… |
| API 路由 | GET /api/automations（924）、GET /api/automations/catalog（927）、POST /api/automations/parse（932）、POST /api/automations（995）、PATCH/DELETE /api/automations/:id（999/1003）、POST /api/automations/:id/run-now（1007）、POST /api/automations/claim（1015）、POST /api/automation-runs/:id/complete（1018）；全部 requireAuth 且按 req.auth.user.id 作用域 | U/server/index.ts:924-1024 |
| 服务 | U/server/automations.ts：normalizeDefinition（:148-190）、nextRunAt 时区计算（:102-116）、规则解析 fallback（:205-248）、创建/更新/删除（:257-295）、桌面 claim 事务（:297-334）、服务端 claim 事务（:349-368）、complete（:383-392）；业务动作 U/server/automationBusinessActions.ts:69-148；能力目录 automationCatalog.ts:17-37 | 源码阅读 |
| 解析（自然语言→定义） | POST /api/automations/parse 先本地规则 fallback；有可用 LLM 时用 chatWithTools 让模型调用 define_automation（enum 动作表见 U/server/index.ts:944-977），失败回退规则结果 | U/server/index.ts:932-994 |
| 触发/Worker | 桌面动作：客户端每轮 POST /automations/claim（claimDueTx 只挑非 server 动作），执行后 POST /automation-runs/:id/complete；服务端动作：API 进程启动 6 秒后首次、之后每 15 秒 pollServerAutomations（claimDueServerTx 只挑 SERVER_ACTIONS），runServerAutomation 直接 await executeBusinessAutomationAction | U/server/index.ts:10915-10929、10949-10952；automations.ts:16-22、349-381 |
| 表/外部依赖 | ccs.db automations（ccsDb.ts:256）、automation_runs（:271）；外部：紫鸟 MCP（mcp.ts callDirect('ziniao'…)）、领星本地库/缓存任务、钉钉群机器人+个人消息（dingtalk.ts:206、dingtalkAgent.ts:512）、开发者 APP 声明的 automation actions（含 serverAction 白名单：ziniao/lingxing/dingtalk） | automationBusinessActions.ts:32-146；dingtalk 发送函数 |
| 审批/安全 | 无审批环节；服务端调度会校验动作声明仍存在（normalizeDefinition/claim 时读 action_json）、APP 是否安装、第三方 APP 不能调用系统内部 serverAction（白名单判断，自动化 actions:94-101）；桌面断连的 running 记录 10 分钟后标记失败（automations.ts:314-329） | 源码阅读 |
| 0.6.1 观察 | server action 集合比 0.5.5 报告更完整（含 workflow_sequence、app_action、紫鸟/领星/钉钉）；自动化仍无独立 worker 进程 | 对照既有报告附录 E |

## 3. MCP

| 链路环 | 事实 | 证据 |
|---|---|---|
| 前端入口 | McpManager 应用（DIST/assets/McpManager-B1sFnCJb.js @3,825 起做 /mcp/servers 轮询/CRUD）；各业务 APP（FigmaApp/IllustratorApp/LingxingApp）也直接调 /mcp/servers、/mcp/call；API 设置/市场文档中有 MCP 说明 | DIST 扫描（chunk@偏移）；U/server/mcp.ts |
| API 路由 | GET/POST /api/mcp/servers（8213/8214）、DELETE /api/mcp/servers/:id（8222）、POST refresh（8228）、POST enabled（8233）、GET agent-tools（8241）、GET search-tools（8242）、POST import/preview|import（8244/8252）、POST /api/mcp/call（8441）、/call-direct（8449）、POST /api/mcp/test-agent（8730） | U/server/index.ts |
| 服务 | U/server/mcp.ts：SYSTEM_SERVERS（243-281）、isSystemServer（311-312）、loadCfg 合并系统+用户配置（314-350）、persist/加解密（351-360）、listServers 掩码（725-739）、saveServer/deleteServer/setEnabled（746-818）、collectAgentTools/agentTools/agentToolsForServer/searchAgentTools（820-859）、callByName（862-880）、callDirect（883+，紫鸟 4 小时超时）；初始化/迁移 initMcp（:995）在服务启动时调用（index.ts:10948） | 源码阅读 |
| 工具聚合 | 只聚合 enabled 且 status=connected 的服务器工具；生成名 mcp__<safe(serverId)>__<safe(tool)>，schema 经 sanitizeJsonSchema；toolIndex 供 callByName 反查 | mcp.ts:820-847、862-880 |
| 表/外部依赖 | 文件存储 data/mcp.json、data/mcp.system.json（mcp.ts:14-15；敏感 env/headers 用 secretVault 加解密/掩码）；外部进程：npx 启动的 stdio MCP（video-clip/figma/illustrator/dingtalk-mcp）、python 启动的 ziniao（server/ziniao/ccs_stdio_server.py）、HTTP MCP（lingxing openmcp） | mcp.ts:243-281、297-309；REA SHELL 不覆盖该目录（不属于 asar） |
| 触发/审批 | 无审批；MCP 调用是同步等待工具返回（callTool），断连重连一次；测试代理 /api/mcp/test-agent 用 LLM 选工具（最多 4 步，领星只允许一次调用），失败不换工具 | mcp.ts:862-880；index.ts:8730-8800 |
| 鉴权（重要观察） | /api/mcp/* 与 /api/mcp/test-agent 全部没有 requireAuth/requireAppOpen；对比 /api/providers、/api/market 等前缀有 requireAppOpen。=> 同网段可达时可管理/调用 MCP（默认 HOST=0.0.0.0，外壳 lanEnabled 默认 false） | U/server/index.ts:8213-8259、8441-8455、8730；常量 HOST（index.ts 底部启动配置） |
| Canvas MCP 桥（外部 Agent 用） | Resources/dxos-canvas-mcp.cjs 是打包好的 stdio MCP server（name=dxos-canvas），工具含 connect_canvas/read_canvas/find_nodes/get_nodes/rename_node/edit_node/change_connection/create_cards；U/server/codexCanvasInstaller.ts:22-80 把它注册进 Codex（codex mcp add），桥接通过 /api/codex-canvas/* 与 API 通信；SHELL 通过 DX_DESKTOP_MCP_BRIDGE 把它传给 API 进程 | codexCanvasInstaller.ts:19-80；SHELL/main.cjs:1156；DIST 无该 chunk |

## 4. Skill（内置技能 + Skill Pack）

| 链路环 | 事实 | 证据 |
|---|---|---|
| 前端入口 | SkillsApp（DIST/assets/SkillsApp-BCwUvKLw.js @11,862 起，GET /skills、/skills/model-options、/skill-packs）；Conversation/Files 通过 /skills/:id/run 与 skill__ 工具；MarketApp 含 Skill 包文档 | DIST 扫描；U/server/skills.ts |
| API 路由（技能） | GET /api/skills（8805）、GET model-options（8806）、GET agent-tools（8820）、PATCH /:id（8821）、PATCH /:id/display（8825）、POST /api/skills（8830）、POST import/import-preview/import-analyze/import-confirm（8837/8845/8855/8875）、DELETE /:id（8993）、POST /:id/run（9001） | U/server/index.ts |
| API 路由（Skill Pack） | GET /api/skill-packs（8884）、POST import（8885）、import-online/preview|import（8893/8898）、PATCH display（8903）、translate（8907）、ai-test（8912）、run（8920）、agent-run（8927）、DELETE（8943） | U/server/index.ts |
| 服务 | U/server/skills.ts：技能定义/持久化 data/skills.json（:51、440）、listFunctionalSkills/listSystemCapabilities（:522-530）、agentSkillTools（exposure=agent 过滤，628-639）、runSkill（2099-2134，按 kind 分派 image/video/audio/procedure）、procedure 小循环（12 轮/16 次，2234-2297）、provider 解析 resolveChatTarget（672-700）；U/server/skillPacks.ts：Skill Pack 导入/解压/索引（:304-334、404-439）、bundled 包（228-295）、在线源解析（69-120）、Docker 沙箱执行（538-576）、AI 测试/生成参数（AI 读 SKILL.md/--help）；U/server/skillAnalyzer.ts 用 LLM 把 SKILL.md 分析成工作流草稿 | 源码阅读 |
| 表/外部依赖 | data/skills.json（启停+自定义）、data/skill-packs/index.json + 包目录、data/bundled-skill-packs.json、服务器随包 server/bundled-skill-packages（SHELL 之外）；Docker 镜像 fastapi-fastapi-app:latest、运行目录 C:\tmp\ccs-skill-runs（可用环境变量覆盖）；LLM provider（技能文本/分析/翻译/测试）；入服务启动时 ensureBundledSkillPacks/syncSkillPackRoutes（index.ts:411-414） | skillPacks.ts:23-27；index.ts:411 |
| 触发/审批 | 内置技能 exec 在 API 进程内同步；procedure 技能是“服务端小循环”；Skill Pack Python 入口在 Docker 里 spawn（一次运行一个进程，超时/输出上限）；无审批，靠 exposure/allowImplicit 控制是否进 Agent 目录；v2.permissions 只做元数据（task-1 已记录） | skills.ts:628-639、2099-2297；skillPacks.ts:538-576 |
| 0.6.1 变化 | skill-packs 路由与 agent-workspace 技能（agentWorkspaceSkills.ts 注册 agent_profiles + 编排 Skill）在 0.5.5 报告中未出现；是否为 0.6.1 新增不可由单侧源码确认 | 对照既有报告附录 D §6 |

## 5. 应用市场与更新

| 链路环 | 事实 | 证据 |
|---|---|---|
| 前端入口 | MarketApp（DIST/assets/MarketApp-CvteOm7x.js）；DeveloperStudioApp 也可发布/更新；设置里三处用到市场/更新 API | DIST 扫描 |
| 市场 API | GET /api/market/explore（9155）、GET /api/market/apps/:id（9159）、GET /api/market/version（9146）、GET /api/market/catalog（9149）、GET catalog/status（9189）、POST /api/market/updates/check（9176）、GET /api/market/developer-apps（9143）、install/update/rollback/history/health/runtime-health/diagnostics（9195-9340）、release download（9163）、publish（9342）、revoke（9366）、review（9377） | U/server/index.ts |
| 服务 | marketplace.ts：apiBaseUrl 只允许 HTTPS（localhost 例外）（:108-115），explore/detail 拉 /v1/market/explore|apps/{id} 并做严格白名单归一化（:207-335），5 分钟缓存；appUpdates.ts：appCatalog 远程 /v1/apps/catalog（:21-22、103-125），App 更新选择（灰度 rollout、semver、min/max system version）（:127-165），downloadCatalogRelease 校验 100MB 上限、大小、SHA-256、Ed25519 catalog 签名（:173-197）；appReleases.ts：本地 Release 发布/撤回/审核（:136-218），Ed25519 私钥 data/app-signing，包 data/app-releases/<appId>/<channel>/<v>+<b>.zip（:10-13、160-190），表 ccs.db app_market_releases | 源码阅读 |
| 安装/更新链路 | install：已安装复用→健康检查；云账号要求（appDownloadNeedsCloudAccount）；catalogRelease→灰度判定→兼容性→下载+签名校验→importDeveloperApp(expectedAppId/version/build, trustedPackageId)→healthCheck→失败删除（index.ts:9195-9235）。update：dataVersion 变化逐级迁移+项目快照，失败自动回滚旧版本（index.ts:9236-9298）。rollback：按 historyId 恢复并回滚项目快照（index.ts:9329-9341） | index.ts；developerApps.ts:895-1005；appUpdates.ts:173-197 |
| 表/外部依赖 | ccs.db app_market_releases（ccsDb.ts:413）；data/app-releases、data/app-signing；data/app-catalog.json（旧本地目录）、data/developer-apps（安装索引与文件）；外部 https://api.dx-os.com（市场/目录/更新）；安装包 100MB 上限 | appReleases.ts:10-13；appUpdates.ts:18；developerApps.ts:23 |
| 系统更新（外壳） | 系统更新不走市场 API：GET /api/desktop/update/status（无鉴权）、POST /api/desktop/update/check（requireSuperAdmin）→ requestDesktopUpdate 通过 process.send('dx-desktop:update-request') 请外壳执行，外壳 main.cjs 用 createAutoUpdateFetch（Node 直连 + 代理 session 自动选择）与兼容轻量更新 session 下载/校验/落盘；GET/POST /api/desktop/rollback 仅 loopback + requireSuperAdmin → process.send('dx-desktop:rollback-request') | U/server/index.ts:448-500、665-690；SHELL/main.cjs 更新与 env 段；task-1 已记录 0.6.1 新增 direct-update-fetch |
| 触发/审批 | 发布/撤回/审核有角色校验（发布本人或 admin/superadmin；审核仅 admin/superadmin）；安装无需审批但受云账号与灰度；系统更新检查/回滚需超管，回滚仅本机 | index.ts:9195-9400、448-500 |

## 6. 开发者平台

| 链路环 | 事实 | 证据 |
|---|---|---|
| 前端入口 | DeveloperStudioApp（DIST/assets/DeveloperStudioApp-BFL_9N-r.js @6,881 起，/market/developer-lab/*）；DeveloperAppHost（DIST/assets/DeveloperAppHost-CZ47Yu1K.js，dx-app 沙箱宿主 + window.dx 桥，含 /file-transfers、/system/fonts、/ocr/*、/market/developer-apps/*/agent、realtime.room、mcp.call、skill.run 等 action 白名单）；MarketApp 内开发者文档/发布 | DIST 扫描；hostCapabilities-CUU233J9.js 提供宿主能力清单 |
| Lab API | GET/POST /api/market/developer-lab（9817/…）、generate（9627，AI 生成草稿）、jobs（9644/9647/9672/9687，流式对话与停止）、examples/gomoku（9705）、collab（9782）、realtime/rooms（9789-9808）、文件读写（9820/9826）、icon（9841/9849）、download（9866）、simulate-install（9887）、install（9894）、publish（9342） | U/server/index.ts |
| 开发者 APP API | install/update/history/health/runtime-health/diagnostics/rollback（9195-9340）、import（10527）、delete（10543）、files/*（10551）、agent 会话/运行/委派/产物（9955-10248）、project 文件与配额（10401-10530）、network/request（10279）、credentials bind（10287/10294）、OAuth authorize/status（10301/10310）、collab（10248）、realtime/rooms（10256-10278）、reset-data（10559） | U/server/index.ts |
| 服务 | developerApps.ts：包解析/清单校验/能力声明/原子安装（staging→rename、保留 1 回滚点、失败清理；:895-1005）；developerLab.ts：AI 草稿落盘 data/developer-lab（:100-222，最多 80 文件/8MB、路径越界检查、预览 token、宿主桥注入）；developerOAuth.ts：PKCE S256 + 回调 /api/developer-oauth/callback + AES-256-GCM 存 ccs.db app_oauth_tokens（:41-114）；developerCollabProjects.ts：表 developer_collab_projects/members/invites（:22-58）；developerRealtime.ts：WS /api/developer-realtime（:161-218，64KB 上限、30 条/秒、心跳、房主 setState）；developerFileTransfers.ts：项目文件分片读写（:10-79）；developerDocs.ts：https://api.dx-os.com 文档同步+离线缓存；codexCanvas.ts/Installer.ts：Codex 桥注册与 /api/codex-canvas/* 转发 | 源码阅读 |
| 前端桥 window.dx | DeveloperAppHost 以 action 白名单响应 dx-app 请求（agent.run/agent.stream/mcp.call/skill.run/app.api/ai.task.*/system-fonts/telemetry 等），对每个 action 做参数校验（如 serverId/tool 正则、skill id 正则、字体 id 64hex），再转发到对应 API；OAuth 结果用 postMessage 回传 | DeveloperAppHost chunk 静态阅读；developerDocs/Developer Lab 文档在 MarketApp chunk |
| 表/外部依赖 | ccs.db：developer_apps 索引（文件 data/developer-apps/index.json）、app_market_releases、app_credential_bindings（:450）、app_oauth_tokens（:466）、developer_agent_artifacts（:736）、developer_collab_*（:22-58）；data 目录：developer-apps、developer-lab、developer-project-snapshots、developer-docs、app-signing、app-releases；外部：https://api.dx-os.com 开发者文档、OAuth 提供方（tokenUrl 解析后拒绝内网地址）、Codex CLI、开发者 APP MCP（managedByAppId） | 源码阅读 |
| 触发/审批 | 发布：本人项目 + 内置 APP 更新需超管；审核：admin/superadmin；安装/更新：健康检查+自动回滚；OAuth：PKCE+state+10 分钟过期+内网拒绝；实时房间：房主可 setState、成员上限/消息上限/速率限制；Agent 运行：developerAgentScope 要求 APP 声明 app.<id>.agent.run 且 canOpenApp | index.ts:9342-9400、9979-10010；developerRealtime.ts:161-218 |

## 7. 文件传输

| 链路环 | 事实 | 证据 |
|---|---|---|
| 前端入口 | DeveloperAppHost 宿主桥（DIST/assets/DeveloperAppHost-CZ47Yu1K.js @4,898 起）：dx-app（如 Photocraft）通过 host action 调 /file-transfers；普通 Files 应用用 /api/fs/* 而非该模块 | DIST 扫描 |
| API | POST /api/file-transfers（创建，purpose 必须 photocraft-save，kind=source|preview）、GET /:id、PUT /:id/chunks（二进制分片）、POST /:id/complete（sha256 校验）、DELETE /:id（取消）、POST /api/photocraft/projects/:id/save-bundle（消费并发布到项目） | U/server/fileTransferRoutes.ts:31-79 |
| 服务 | registerFileTransferRoutes 注册于 index.ts:5750（挂 requireAuth）；DiskTransfers 落在 data/file-transfers（fileTransfers.ts），60 秒清理；限额：preview ≤16MB、并发分片 单人 2/全局 16、项目版本 revision 冲突 409、chunk SHA-256、完成后发布 PhotoCraft 项目 | fileTransferRoutes.ts；fileTransfers.ts:1-117 |
| 表/外部依赖 | 无 SQLite 表；文件 data/file-transfers/*（盘上临时分片）+ photocraft 项目（data/photocraft-projects? 由 photocraftProjects.ts 管理）；发布时写 PhotoCraft 项目版本与 fs 节点 | fileTransferRoutes.ts:60-79 |
| 触发/审批 | 无审批；唯一准入是 requireAuth + purpose/kind + 项目版本 + 配额限流；不允许任意用途上传 | fileTransferRoutes.ts |

## 8. OCR

| 链路环 | 事实 | 证据 |
|---|---|---|
| 前端入口 | 通用 OCR 客户端在 DIST/index-DJDR-kWU.js @352,524 起（/ocr/providers、/ocr/recognize，32MB Blob、abort/进度），被照片/画布等复用；API 设置与市场文档中也出现 PaddleOCR 说明（ApiSettings chunk @34,268；MarketApp @45,853） | DIST 扫描 |
| API | GET /api/ocr/providers、POST /api/ocr/recognize（registerOcrRoutes 默认 authorize=requireAuth） | U/server/ocrRoutes.ts:10-60；index.ts:2056 |
| 服务 | ocrRoutes.ts：只接受 protocol=PADDLE_OCR_PROTOCOL 且 enabled、有 api_key、模型为 PP-StructureV3/PaddleOCR-VL 的 provider；上传上限 32MB、maxPixels 24MP、模式 detect|recognize；并发 4/全局、单人 2，300 秒 abort；服务端用保存的 token 调 PaddleOCR AIStudio https://paddleocr.aistudio-app.com/api/v2/ocr/jobs（multipart file、model、可选 payload，轮询拿 JSONL 并解析 layoutParsingResults）；ocr.ts requestPaddleOcr 封装协议 | U/server/ocrRoutes.ts:10-60；U/server/ocr.ts:1-170；shared/ocr.ts |
| 表/外部依赖 | provider 配置在 data/providers.json（PaddleOCR 站点/AccessToken，secretVault 加密）；无本地 OCR 回退；计费上下文 withApiQuotaActor + withDirectApiQuota(kind=ocr)（配额规则只对 image/video 计费，OCR 实际不扣 api-quota 金额） | ocrRoutes.ts:10-60；apiQuota.ts:235-237 |
| 触发/审批 | 无审批；有并发限流与 401/403 由 requireAuth 负责；外部调用失败返回 400 并提示云端可能仍在处理 | ocrRoutes.ts |

## 9. 系统字体

| 链路环 | 事实 | 证据 |
|---|---|---|
| 前端入口 | 无独立应用；只通过 dx-app 宿主桥 action “system-fonts/system-font”调用（DeveloperAppHost chunk @24,204；hostCapabilities chunk） | DIST 扫描 |
| API | GET /api/system/fonts（requireAuth）、GET /api/system/fonts/:id（64 位 hex id，返回 application/octet-stream） | U/server/systemFonts.ts:registerSystemFontRoutes（index.ts:2057） |
| 服务 | systemFonts.ts：按平台列目录（macOS /System/Library/Fonts 等，Windows Fonts，Linux fontconfig 目录），递归深度 ≤5、最多 10000 文件，跳过符号链接并 realpath 校验路径 jail；解析 SFNT/TTC name 表（平台 0/1/3，name id 1/16，长度上限），id=sha256(path:size:mtime)，5 分钟缓存；读取时校验 size/mtime 未变，单文件 ≤64MB | systemFonts.ts:1-130 |
| 表/外部依赖 | 无表；直接读宿主机字体目录文件 | systemFonts.ts |
| 触发/审批 | requireAuth；只读，无写/安装字体入口 | systemFonts.ts |

## 10. CLI（即梦/剪映系/Codex/Gemini/Pippit）

| 链路环 | 事实 | 证据 |
|---|---|---|
| 前端入口 | ApiSettings（DIST/assets/ApiSettings-IQGb5LPa.js，CLI provider 配置/登录/模型）、部分 APP（Illustrator/Figma/ShortDrama 等）通过 /cli/* 或 CLI provider 调用 | DIST 扫描 |
| API | /api/cli/dreamina-canvas/status|download-info|login|logout（2218-2246）、/api/cli/jimeng/*（2247-2281、2332-2365）、/api/cli/pippit/*（2282-2287）、POST /api/cli/codex/generate-image|edit-image（2298/2303）、/api/cli/gemini/generate-image|edit-image（2313/2318）；前缀 /api/cli 有 requireAppOpen('api-settings')（index.ts:1184） | U/server/index.ts |
| 服务 | cliTools.ts：即梦 CLI 运行时解析（内置 server/cli-runtime/jimeng/bin → JIMENG_BIN/本机 PATH → WSL，:220-329），登录会话/状态/额度/模型/help（:370-624），图片/视频/多模态/首尾帧参数构造与提交/查询/任务列表（:662-1066），输出 data/cli-output、临时目录、CLI home data/cli-home/jimeng；agentCliTools.ts：codex/gemini/antigravity 运行时（bundled/host，:73-160），登录/状态/models/help/chat（:278-624），用本机 auth.json 生成图片/编辑（:711-914）；ai-tasks/jimengNativeTasks.ts 把即梦 CLI 包装成统一 AI 任务原生适配器 | 源码阅读 |
| 表/外部依赖 | 无 SQLite 表（CLI 登录态在宿主 CLI home 或 data/cli-home，任务在宿主 CLI 自己目录）；外部：dreamina/codex/gemini/antigravity 可执行文件、WSL、网络；输出文件 data/cli-output | cliTools.ts:1-40；agentCliTools.ts:73-160 |
| 触发/审批 | 路由层 /api/cli 受 requireAppOpen('api-settings') + 内部各 handler；CLI 进程 spawn 无审批，有超时（即梦 10 分钟等）；登录 start/status 用 session 轮询 | index.ts:1184、2218-2380 |

## 11. 本地代理

| 链路环 | 事实 | 证据 |
|---|---|---|
| 前端入口 | Settings 应用（DIST/assets/Settings-J_ijGC-J.js @21,727 /desktop）；API 设置里也可触发（DIST/assets/ApiSettings） | DIST 扫描 |
| API | GET /api/desktop/config、PUT /api/desktop/config（仅 loopback；开发版只允许改代理）、POST /api/desktop/proxy/detect（仅 loopback）；代理模式 off/system/manual，manual URL 校验仅 http/https 且不允许带路径/查询；返回时用户名密码打码 | U/server/index.ts:632-690、5893-5901 |
| 服务 | localProxyDetection.ts：候选来自 当前设置、HTTPS_PROXY 环境、Windows 注册表系统代理、netstat+Powershell 识别 VPN 进程（mihomo/clash/verge/v2ray/sing-box/…）、macOS scutil 系统代理与 lsof 监听；probeLocalProxy 用子进程 Node fetch 访问 https://generativelanguage.googleapis.com/v1beta/models 测可达性；最多 12 个候选 | localProxyDetection.ts:1-160 |
| 生效面（外壳） | 实际代理由 SHELL/main.cjs 应用：applyProxyEnvironment 注入会议/HTTP(S)_PROXY，DX_PROXY_MODE/DX_PROXY_EFFECTIVE；createUpdaterFetch 用 proxy session；0.6.1 新增 createCloudCompatibilityFetch（仅 https://api.dx-os.com/v1/，独立 partition，支持 direct/system/fixed_servers，credentials omit）与 cloudAccountNetwork=direct|proxy；cloudCompatibility 默认启用（config !== false） | SHELL/main.cjs/proxy.cjs（task-1 已列差异）；SHELL 环境注入段 |
| 表/外部依赖 | 无表；配置 data/desktop.json（外壳写，API 读 DX_DESKTOP_CONFIG_PATH 指定路径）；外部：系统代理设置、VPN 进程、Google Gemini 模型端点仅用于探测 | index.ts:632-690；localProxyDetection.ts |
| 触发/审批 | 探测与配置修改仅 loopback；无会话也能读 GET config；PUT 无登录但限 loopback | index.ts:632-690、5893 |

## 12. 媒体生成（图片/视频/音频/相册/短剧/画布）

| 链路环 | 事实 | 证据 |
|---|---|---|
| 前端入口 | 画布（dx-app，节点生成）、PhotosApp（DIST/assets/PhotosApp-B__Mar7O.js，OCR/背景移除/素材）、ShortDramaApp（DIST/assets/ShortDramaApp-VJezH5SI.js，/short-drama/*）、VideoEditorApp（DIST/assets/VideoEditorApp-DbcIEgBe.js，/video/*）、AiImageDeclarationApp（DIST/assets/AiImageDeclarationApp-CqSwoMcj.js）、ComfyUI（dx-app，无 chunk）、ApiSettings（模型/协议测试） | DIST 扫描 |
| API | 统一任务：POST /api/ai/tasks、/api/ai-tasks/generate（5201/5202）、/api/canvas/generate（5203）；查询/取消/事件：/api/ai/tasks/:id/query（5469）、/api/ai-tasks/query（5476）、/:id/events（5521）、cancel（5575）；媒体产物：GET /api/ai/artifacts/:id（5546）；ComfyUI：/api/comfyui/*（10592-10822）；视频：/api/video/media/probe、assets、render-jobs（6470-6535）；短剧：/api/short-drama/*（8947-8990）；照片：/api/photos/*（5743-6100）、/api/photocraft/*（5760-5840）、/api/file-transfers（见 7）；AI 图片声明：POST /api/ai-image-declaration/process（6697）；DXOS 云任务：/api/dxos/jobs*（1551-1561） | U/server/index.ts |
| 服务 | 入口 handleAiTaskSubmitInternal（5033-5195）：v2 先 surface adapter authorize（canvas→canEditCanvas，app/plugin/skill/comic/test 空操作，4447-4518）→ comfy 分支→ DXOS 分支→ CLI 分支→ declarative/agent 分支；ai-tasks/service.ts 负责 compile/execute/start/resume/checkpoint（152-345），artifacts.ts 物化产物；declarativeRouter.ts 选择 V2 协议路线（含 runninghub/relay/自定义协议）；nativeAdapters.ts 是代码白名单（codex-cli/gemini-cli/媒体桥/jimeng/pippit/dreamina-canvas），自定义协议只能 declarative；comfyui.ts 管理本地/云端 ComfyUI 实例（config data/comfyui.json，spawn python main.py，桥扩展 zip 由 comfyBridge.ts 生成）；comfyWorkflows/comfyProjects 存 data/comfy-workflows.json、comfy-projects.json；shortDrama.ts 调 LLM 生成剧本/设定/分镜并调图片模型；video/* 用 ffprobe/ffmpeg 渲染；backgroundRemoval.ts 用本地 onnx 模型；aiImageDeclaration.ts 给图片写 IPTC 合成内容标记 | 源码阅读 |
| 触发/Worker | AI 任务在 API 进程内执行，异步轮询/恢复由 setInterval 5 秒的 recoverDueProtocolTasks（index.ts:10990-11002）与 /api/ai-tasks/query 推动；视频渲染任务由 ccs worker 领取（worker.ts:279-292、video/videoWorker.ts:59-80）；项目任务/项目 Agent 同 worker；ComfyUI 实例是外部 python 进程（comfyui.ts:595-681）；RunningHub/CLI 是外部 HTTP/进程 | index.ts:10990-11002；worker.ts；comfyui.ts；videoWorker.ts |
| 表/外部依赖 | protocol-tasks.db ai_protocol_tasks/events/artifacts（ai-tasks/store.ts:57-118；产物文件 data/protocol-artifacts，ai-tasks/artifacts.ts:20）、data/legacy ai-tasks.db；api-quotas.db（image/video 预扣）；data/comfyui.json、comfy-workflows.json、comfy-projects.json、comfy-workflow-runs.json；ccs.db video_projects/assets/render_jobs（video/videoStore.ts:17/25/37）；data/short-drama-projects.json（shortDrama.ts）、photos 索引/缓存、data/cli-output；外部：模型供应商 API、DXOS 云、RunningHub、ComfyUI 服务器、FFmpeg/FFprobe、PaddleOCR（OCR 另列） | 上述文件 |
| 审批/门禁 | surface adapter 授权（canvas 编辑权）；V2 协议执行开关默认关闭（protocol-engine/flags.ts:65-69 只有显式规则 enabled=true 才启用），所以 declarative 默认走 legacy 兼容；APP/CLI 原生适配器是代码白名单；视频渲染有 lease/heartbeat/尺寸时长校验；ComfyUI 工作流有 manifest/字段/输出声明与 agent manifest | flags.ts:55-85；nativeAdapters.ts:9-40；videoWorker.ts:59-80 |

## 13. 桌面壳 IPC 与前端桥

| 通道 | 方向 | 事实 | 证据/来源 |
|---|---|---|---|
| dx-desktop:get-info | renderer→main | 返回应用/窗口/版本信息 | SHELL/main.cjs；preload.cjs |
| dx-desktop:ensure-local-admin-session | renderer→main | 仅主窗口主 frame；POST /api/auth/desktop-session，用 x-dx-desktop-auth（DX_DESKTOP_AUTH_SECRET）换 superadmin Cookie 并写入 defaultSession | main.cjs（0.6.1 新增）；task-1 已记录 |
| dx-desktop:clipboard-read-text / -read-image / -has-image / -write-text / -write-image | renderer→main | 文本/图片剪贴板；写图片校验 data:image/png 且 ≤80MB | main.cjs；preload.cjs |
| dx-desktop:choose-data-parent / choose-directory | renderer→main | 数据目录/目录选择对话框 | main.cjs；preload.cjs |
| dx-desktop:open-external | renderer→main | 打开外部 URL | main.cjs；preload.cjs |
| dx-desktop:check-update / compatible-update / get-update-status | renderer→main | 触发系统更新/兼容轻量更新/查询状态 | main.cjs；preload.cjs |
| dx-desktop:update-progress | main→renderer | 下载/安装进度事件 | main.cjs:387 webContents.send |
| dx-desktop:system-resume | main→renderer | 系统唤醒事件（powerMonitor） | main.cjs:1318 |
| dx-desktop:update-request / update-response | API 进程↔外壳 | API 的 /api/desktop/update/* 经 process.send 请求外壳执行更新，外壳回 update-response；等待 30 分钟超时 | U/server/index.ts:448-500；SHELL/main.cjs |
| dx-desktop:rollback-request / rollback-response | API 进程↔外壳 | 同上，回退运行时 | U/server/index.ts:476-500；SHELL/main.cjs |
| 进程与环境 | 外壳→API/Worker | 用 tsx 拉起 server/index.ts 与 worker.ts；注入 DX_DATA_DIR、DX_DESKTOP_VERSION/PID/RUN_ID、DX_DESKTOP_AUTH_SECRET（仅 API）、DX_DESKTOP_CONFIG_PATH、DX_DESKTOP_MCP_NODE/BRIDGE、DX_PORTABLE、DX_CLOUD_ACCOUNT_NETWORK、代理环境；worker 额外剥离 auth secret | SHELL/main.cjs:1129-1230 |
| 前端桥 | renderer | window.dxDesktop（preload 13 方法 + onUpdateProgress/onSystemResume）；dx-app 另有 window.dx.invoke 宿主桥（DeveloperAppHost）覆盖 agent/ai.task/mcp.call/skill.run/files/system-fonts 等 action | SHELL/preload.cjs；DIST DeveloperAppHost chunk |
| REA 观察 | — | ev_501ab8… 报告 13 个字面通道/13 个 main handler/browser windows 2/preload 1；但 renderer_listeners=0、contextBridge exposed=0 与实际 preload（2 个 on、13 个方法）不符，属识别限制（本文以字节为准） | task-1 已记录 |

## 14. 触发 / Worker / 审批 汇总

| 子系统 | 执行位置 | 触发方式 | 审批/门禁 |
|---|---|---|---|
| 自动化（桌面动作） | 桌面客户端 | POST /automations/claim 轮询 | owner 作用域；无审批 |
| 自动化（服务端动作） | API 进程 | 15 秒 pollServerAutomations | 动作声明/APP 安装/紫鸟-领星-钉钉 serverAction 白名单；无审批 |
| MCP | API 进程 + 外部 MCP 进程 | 工具调用（Agent/HTTP） | 无（且 HTTP 面未鉴权） |
| Skill（内置） | API 进程 | /skills/:id/run、skill__ 工具 | exposure/allowImplicit；无审批 |
| Skill Pack（Python） | Docker | /skill-packs/:id/run|agent-run | 沙箱镜像/超时/输出上限；无审批 |
| 市场安装/更新 | API 进程 | /market/developer-apps/:id/install|update | 云账号/灰度/签名/健康检查/自动回滚 |
| 发布/审核 | API 进程 | /market/developer-lab/:id/publish、/releases/review | 本人/超管/管理员 |
| 开发者 APP Agent | API + worker | /market/developer-apps/:id/agent/* | APP 声明 agent.run 权限 + canOpenApp + Run/项目作用域 |
| 文件传输 | API 进程 | /file-transfers 分片 | requireAuth + purpose/kind + revision + 限流 |
| OCR | API 进程→PaddleOCR 云 | /ocr/recognize | requireAuth + 并发限流 + 模型白名单 |
| 字体 | API 进程 | /system/fonts | requireAuth，只读路径 jail |
| CLI | API 进程→宿主 CLI 进程 | /cli/* | requireAppOpen('api-settings') + 超时 |
| 本地代理 | 外壳（生效）+ API（探测） | 设置页/loopback | 仅 loopback；PUT 无会话但限本机 |
| AI 媒体任务 | API 进程 + 外部供应商 | /ai/tasks、/canvas/generate、/comfyui、/video、/short-drama | surface adapter（canvas）/协议执行开关/原生适配器白名单 |
| 视频渲染 | ccs worker | 渲染任务队列（lease/heartbeat） | 尺寸/时长校验 |
| 项目任务/项目 Agent | ccs worker | 任务队列 | 完成验收 + artifact 门禁（task-1 已述） |
| 系统更新/回退 | 外壳 | /api/desktop/update|rollback | 超管 + loopback（回退） |

## 15. 未确证项与未知

1. 【未知】/api/mcp/*、/api/mcp/call(-direct)、/api/mcp/test-agent 无鉴权是设计还是遗漏；默认 127.0.0.1 与 lanEnabled 的实际暴露面未运行验证。
2. 【未知】MCP 工具执行时是否还有客户端侧审批（0.5.5/0.6.1 前端权限 store 含 mcp.call=ask，但 agent 执行器未见调用 guard；可能只在用户手动触发路径生效）。
3. 【未知】Skill Pack Docker 沙箱的具体镜像/挂载/网络策略只从代码看（SKILL_SANDBOX_IMAGE、RUN_DIR、dockerRun 参数），运行期是否禁用网络未知。
4. 【未知】aiproto 执行开关默认全关（protocolExecutionEnabled 无规则=false），因此多数模型走 legacy 原生桥；哪些平台实际走 declarative 取决于运行期 flags 数据（data/protocol-execution-flags.json），本次未读取该数据文件。
5. 【未知】Remote 市场/目录（api.dx-os.com/v1/market、/v1/apps/catalog、/v1/developer/docs、/v1/quick-settings/catalog）的服务端实现与内容不在包内。
6. 【未知】系统更新的 update-request/response 通道由便携启动器实现，启动器代码不在 app.asar；只从 main.cjs 的请求/响应映射推断。
7. 【未知】本地代理探测只测 Google Gemini 端点；其它域名（OpenAI/Anthropic/火山/RunningHub）是否经同一路由生效未验证。
8. 【未知】文件传输只支持 photocraft-save 用途（代码硬校验）；其它 dx-app 是否另有传输通道（如 host bridge 全量文件）未穷举。
9. 【未知】OCR 的 withDirectApiQuota(kind='ocr') 在 apiQuota 中不会进入 image/video 计费分支，OCR 是否完全不消耗配额（或另有计费）未取证。
10. 【未知】字体接口只暴露给宿主桥（DeveloperAppHost），是否有应用实际使用（Photos/Illustrator/画布）未逐应用确认。
11. 【未知】CLI 工具（dreamina/codex/gemini）是否随包内置二进制：server/cli-runtime/jimeng 只有 README，安装包内可能在别处；本次仅确认运行时解析会优先 server/cli-runtime/jimeng/bin 与 PATH。
12. 【未知】短剧/照片/Photocraft 的持久化文件具体结构（data/short-drama-projects.json、photos 索引、photocraft 项目存储）未逐字段读取；只确认模块与表/文件位置。
13. 【未知】0.5.5 对应实现不可得：本文件中“0.6.1 变化”仅能对照既有报告，不能逐行 diff；skill-packs/developer collab/realtime/codex-canvas 等在 0.5.5 报告中覆盖不足，是否新增未知。
14. 【未知】app.asar 完整性矛盾（unpacked 条目 hash 不一致）对上述功能的影响：外壳加载的是 packed 之外的文件，REA 将这些字节标为 untrusted。

## 附录：本文用到的证据与源码索引

- REA Evidence（复用 task-1）：ev_501ab896b74854e3c2f890b52d3a26578a0ede727e97fed6e020d56c40ec7f18（SHELL 图：13 IPC/1 preload/2 窗口、6502 文件）、ev_aea49337a1ff99d102c499da86fd9de0d57bc0e227ed9dc4b21a9d300f99ebe0 / ev_b95a3cb387a5334a2f02b2c4ec13dc7783b3ec8b118584b763bb1dcdd7be344f（asar 成员/完整性）、ev_9178e6af633b32894db81e4f74448e4aec964b1db5678e9116b61ce73e9c8217（dist：52 文件/49 JS）。
- 前端 chunk 位置：AutomationsApp/BBeEKtV2.js、McpManager/B1sFnCJb.js、SkillsApp/BCwUvKLw.js、MarketApp/CvteOm7x.js、DeveloperStudioApp/BFL_9N-r.js、DeveloperAppHost/CZ47Yu1K.js、PhotosApp/B__Mar7O.js、ShortDramaApp/VJezH5SI.js、VideoEditorApp/DbcIEgBe.js、AiImageDeclarationApp/CqSwoMcj.js、Settings/J_ijGC-J.js、ApiSettings/IQGb5LPa.js、index/DJDR-kWU.js（偏移见各节）。
- 后端源码：U/server/index.ts（路由与装配）、automations.ts、automationCatalog.ts、automationBusinessActions.ts、mcp.ts、codexCanvasInstaller.ts、skills.ts、skillPacks.ts、skillAnalyzer.ts、marketplace.ts、appUpdates.ts、appReleases.ts、developerApps.ts、developerLab.ts、developerOAuth.ts、developerCollabProjects.ts、developerRealtime.ts、developerFileTransfers.ts、developerDocs.ts、codexCanvas.ts、fileTransferRoutes.ts、fileTransfers.ts、ocrRoutes.ts、ocr.ts、systemFonts.ts、localProxyDetection.ts、cliTools.ts、agentCliTools.ts、ai-tasks/*、protocol-engine/flags.ts、comfyui.ts、comfyBridge.ts、comfyWorkflows.ts、comfyProjects.ts、shortDrama.ts、video/*、backgroundRemoval.ts、aiImageDeclaration.ts、ccsDb.ts、dataPaths.ts、secretVault.ts、dingtalk.ts、dingtalkAgent.ts、ziniaoDownloadJobs.ts、lingxingLocalData.ts。
- 外壳：SHELL/main.cjs、preload.cjs、proxy.cjs、direct-update-fetch.cjs、cloud-compatibility.cjs、update-metadata.cjs（task-1 的 0.5.5↔0.6.1 字节对照）。

报告完。
