# Dx-E2E-RESULT · 真实 Electron 端到端验收（补齐贯穿 B2–B7 的唯一验收缺口）

> 依据：交付前把"真实 Electron 端到端投递"这一条反复挂着的 NOT VERIFIED 补上。分支 `dxos-port/r1`。
> 全部为真实进程 + 真实主进程/预加载 + 真实构建产物，仅通过 CDP 驱动渲染层的 `window.openarc.*`。

## 1. 运行方式与安全边界

```
$ node experiments/dxos-e2e/run-all.mjs          # 自包含探针，失败 exit≠0
$ node --test tests/dxos-e2e-contract.test.mjs   # 纯离线契约测试（9/9）
```

- 启动：真实 `electron .`（真实 `electron/main.cjs` + `electron/preload.cjs` + 真实 `dist/index.html`）。
- **隔离 userData**：`/var/folders/.../oa-dxos-e2e-XXXX`（≠ 真实 profile），主进程 boot 观测与 `identity.db` 均建在隔离目录；未启用任何播种/admin 开关。
- **真实 profile 只读保护证明**（探针开工前/收工后对照）：

| 文件 | mtime | 大小 | sha256（前后） |
|---|---|---|---|
| `identity.db` | 2026-10-09T10:02:42.562Z | 3,489,792 B | `17b81523ff44d728…` **完全一致** |
| `identity.db-wal` | 2026-10-12T18:16:29.888Z | 1,227,792 B | `7c105ff535c481d3…` **完全一致** |
| `identity.db-shm` | 2026-10-12T09:58:36.487Z | 32,768 B | `cda5971d453455fa…` **完全一致** |

整个 profile 目录顶层 35 项快照 **0 变化**；探针从未用 SQLite 打开真实库（避免动 `-shm`）。收工后清理隔离目录、无残留进程、`exit 0`。

## 2. 实测结论（连续 3 次一致：PASS 102 / FAIL 0 / NOT_VERIFIED 1，约 3.5s）

1. **契约**：`window.openarc` 顶层键**恰为 25**，与契约逐字一致：
   `sync,navigate,action,browser,onNativeState,onDisplay,identity,authorization,device,resource,governance,model,mcp,canvas,task,agent,skill,media,sideEffect,files,automation,platform,developer,integration,market`
   （6 个函数键 + 19 个域对象；成员逐个核对，如 `sideEffect={command,revokeApproval,onEvent}`、`files` 17 个方法；对象 `frozen=true / extensible=false`）。
2. **健康（登录后全部 `ok:true`）**：`agent/health`、`skill/health`、`media/health`、`automation/health`、`platform/health`、`developer/health`、`integration/health`、`market/health`、`protocol/list`、`mcp/list`、`canvas/list`、`task/list` —— 全部结构化返回，**0 抛异常、0 "No handler registered"**。
3. **真实只读命令 21 条**，0 未捕获异常。样例：
   ```
   agent/tool/catalog      -> {ok:true,value:{descriptors:[{name:"open_app",...}]}}
   skill/list              -> {ok:true,value:{items:[{id:"chat",name:"对话回复",...}]}}
   platform/data/integrity -> {ok:true,value:{ok:true,dataRoot:"<userData>/dxos",available:true,failures:[]}}
   developer/list          -> {ok:true,value:{apps:[],count:0}}
   integration/plugins/list-> 8 个插件，enabled:[]（默认全关）
   market/catalog          -> local，present:true，appCount:0
   model/provider/list / mcp/list / canvas/list / task/list -> 均为空列表（新库）
   mcp/get|task/get（不存在）-> MCP_CONNECTION_NOT_FOUND / TASK_NOT_FOUND（结构化，非异常）
   ```
4. **trusted 边界**：`ipcRenderer`/`require`/`process`/`webContents`/`BrowserWindow`/`shell`/`fs` 在渲染层**全部 undefined**；桥面 0 个原始能力成员；伪造 `userId/role/appId/sessionRef/token` 调 `identity/status` **仍返回真实会话**（自报身份被忽略）；`about:blank` 子框架拿不到 `window.openarc`（preload 不注入子框架）；`main.cjs` 的 `trusted()` 双条件（`event.sender===win.webContents && senderFrame.url===uiURL`）静态核对通过。
5. **console/网络**：`error=0`、`pageerror=0`、`"No handler registered"=0`；渲染层请求 12 条**全为本地**（`file://` 与 `openarc-file://`），**非本地 0**。
6. **事件**：订阅 `agent.onEvent` 后调 `agent/health`，收到 2 条 P1 信封（`channel/domain/kind/sequence/at/payload` 齐备，`sequence [5,6]` 严格单调）；8 个带 `onEvent` 的域都返回退订函数。
7. **退出**：`window.close()` 正常退出、无残留进程、隔离目录已删除。

## 3. 对既有 NOT VERIFIED 清单的影响

| 原缺口 | 现状 |
|---|---|
| 真实 Electron 端到端投递（preload 契约 / 各域命令面 / trusted / 事件） | ✅ **已验收**（本文件；覆盖 25 键契约、9 域 health、21 条只读命令、trusted 边界、事件信封、console/网络） |
| 真实 Electron 端到端投递（**写操作**：建任务/跑技能/装 App/渲染媒体等） | ⏳ 仍未验收：本轮只驱动只读命令，未做会产生持久副作用的写链路 |
| 真实 GUI 视觉（打包窗口内的页面渲染） | ⏳ 仍未验收：五套 UI 探针仍是 Chromium 挂载壳 |
| 真实凭据与外部网络（模型/第三方插件） | ⏳ 仍未验收：无凭据、不联网 |
| 本机缺失依赖（onnxruntime/ComfyUI 已移除） | ⏳ 抠图仍为依赖缺失态（如实报错） |
| 伪造 `senderFrame` 的**运行时**反例 | ⚠️ NOT_VERIFIED 1 条：渲染层无法构造带桥面的非外壳 sender（preload 不注入子框架，已实测子框架无桥面），只能给间接证据 + 源码级双条件核对 |

## 4. 结论

贯穿 B2–B7 的"真实 Electron 端到端"缺口**已实质补齐**：真实进程、真实主进程与预加载、隔离数据目录，25 键契约、9 域健康、21 条真实命令、trusted 边界、事件信封、console/网络全部通过，且**真实用户 profile 经 sha256 前后对照证明零改动**。剩余未验收项已逐条重列（写链路、打包窗口视觉、真实凭据/网络、本机缺失依赖），口径不放松。

## 5. 写链路真机端到端（本轮补）

探针：`experiments/dxos-e2e-write/run-all.mjs`（自包含、可重复、失败 exit≠0）+ 离线契约测试 `tests/dxos-e2e-write-contract.test.mjs`（9/9）。启动**两次**真实 Electron（同一隔离 userData，用于验证重启持久化），并使用**真实 ffmpeg**。

**结果：PASS 133 / FAIL 0 / NOT_VERIFIED 1**；写命令 115 条、未捕获异常 0、`No handler` 0、console error 0、pageerror 0、非本地请求 0；重启前后状态 JSON 完全一致；无残留进程，隔离目录已删。

| 链路 | 真实证据 |
|---|---|
| 任务域 | `agent/project/create → task/create → get(queued) → events(seq [1,2] 单调) → answer(非等待态被拒) → pause(paused) → list → cancel(cancelled)`；只读打开隔离库读回 `dx_tasks=2 / dx_task_events=4 / dx_project_roots=1 / projects=1` |
| 开发者平台 | 自造 dx-app/v2 包 → validate → install 1.0.0 → enable → disable → enable → **升级 1.0.1** → history → **rollback 回 1.0.0** → uninstall → 重装保留持久化；`app_runtime_events` 实落 8 行；3 个非法包分别以 `DEVELOPER_MANIFEST_INVALID`/`DEVELOPER_PERMISSION_REJECTED`/`DEVELOPER_PATH_ESCAPE` 被拒且**零残留** |
| 媒体域 | 真实 ffmpeg 造输入 → `asset/save`(ffprobe durationMs=2000) → `render/submit` → `render/run` **真实渲染出片**（`dxos/media/renders/<jobId>.mp4`，系统 ffprobe 读回 duration=1.000s）；取消作业 `cancelled` 且无 mp4 |
| 自动化 | `automation_runs` 落 3 行；失败重试真实发生（`attempt-failed`×3，maxAttempts=3）；取消终态 `cancelled`（绝不写 success）；**接线后至少一条动作真实成功**：`dingtalk_group_notify` 打到本机 loopback 夹具，`runNow` 返回 `success`，夹具收到 1 次 POST 且内容命中 |
| 平台 | `snapshot/create → list → verify(valid) → restore` 往返（先停用 weather 制造差异，restore 后 `integrations.json` 恢复）；快照 9 个文件且**不含 `credentials/`**（预置哨兵被排除） |
| 集成插件 | weather enable → `dxos/integrations.json` 落盘 → **重启后仍 enabled** |
| 拒绝路径 | 未登录 `*_UNAUTHENTICATED`；未白名单 `AGENT_COMMAND_NOT_ALLOWED`；白名单外主机 `DEVELOPER_NETWORK_BLOCKED`；依赖缺失 `AGENT_DEPENDENCY_UNAVAILABLE`；伪造 `userId/sessionRef/role` 被忽略；登出后伪造 sessionRef 写入被拒 —— 隔离库关键表除合法 `automation_runs +1` 外零变化 |

**本轮由此发现并关闭的两处真缺陷 + 一处已知缺口**：

| 类型 | 问题 | 处置 |
|---|---|---|
| 真缺陷 | `automation/cancel` 把 `payload.automationId` 当 `runId` 传给 `cancelRun(userId, runId)` → 传自然字段 `{runId}` 反而 `AUTOMATION_INVALID_INPUT` | 改为 `runId` 自然字段优先、`automationId` 仅作别名且**按运行记录语义解析成功才接受**；错误时提示该传哪个字段。真机复跑：`{runId}` 成功 `cancelling→cancelled`；`{automationId:<runId>}` 仍兼容；缺字段/错值结构化拒绝 |
| 真缺陷 | `skill/run` 无可用模型站点时被归一成 `DXOS_ERR_INTERNAL` | 新增目标解析包装，把"没有可用模型站点"归一成带 `dependency=modelSite` 的依赖缺失错误；`skill-service` 归一到 `SKILL_DEPENDENCY_UNAVAILABLE` 时保留 `dependency+reason` |
| 缺口（已接线） | `main.cjs` 给 automation 注入的 `developerApps/integrations/toolCatalog/agent` 全为 null → 无一条动作可成功 | 接上真实实现（developer 已装 App 列举、plugin-service、agent 工具目录、agent-service 的 `runInstruction`）；`desktop` 本仓无实现保持 null，但在 `automation/health.dependencyDetails` 如实列出注入状态与原因，并点名不可达动作（`music_play`/`music_control`/`open_app`、领星/紫鸟需 `mcpCallDirect/transportFactory` 等） |

**真实 profile 零改动**：`identity.db`/`-wal`/`-shm` 的 size+mtime+sha256 前后完全一致，顶层目录快照 0 项变化（全程只读 stat/hash，未用 SQLite 打开真实库）。

## 6. 真实打包窗口内的页面渲染（本轮补）

探针：`experiments/dxos-ui-real/run-all.mjs` → **PASS 135 / FAIL 0**，**20 张 PNG**（5 页 × {空态, 就绪态} × {light, dark}，每张 2880×1800）。

- 数据全部经 `window.openarc.*` 产品桥真实落库：`skill/save`、`mcp/create`、`agent/project/create`+`agent/task/create`、`identity/department-create`、`provider/create`；空态趟用只读命令确认五个来源全为 0。
- 深色经**应用真实外观设置**切换（系统设置→外观与交互→深色），并开启应用真实"减少动态效果"。
- 断言：console error 0、pageerror 0、非本地请求 0；组织治理页 DOM 文本无"会员/权益/套餐/积分"；全页无"尚未实现"占位。
- 与 Chromium 探针对照（`compare-notes.md`）：**字号逐项一致**（页面标题 21px / 行标题 14px / 行元信息 11px），**容器宽一致**（`.split-main` 1232、`.root/.split` 1180、列表栏 288）；行高差异逐条归因于**真实数据内容**（skills 108→88、mcp 88→85、tasks 108→106、org 110→108、model 164→132，笔记附真实行文本）。
- 未验证：截图像素级 OCR（离线无依赖，改用 DOM `innerText` 断言）；OS 窗口物理尺寸（真实 `BrowserWindow` 为 1440×940，视图经 CDP 钉到 1440×900/dsf 2 以与 Chromium 探针同条件）；主机级抓包（只断言渲染层非本地请求=0）。

## 7. 更新后的剩余未验收项

1. **skill 文本分支成功产出**（NOT_VERIFIED 1）：离线无可用模型站点，现如实返回 `SKILL_DEPENDENCY_UNAVAILABLE`；配好 provider 后可成功。
2. 仍不可达的 automation 动作：`desktop` 类（`music_play`/`music_control`/`open_app`，本仓无桌面执行端实现）；领星/紫鸟同步（需 plugin-service 注入 `mcpCallDirect/transportFactory`）；`app_action`（developer 清单当前把 `automation` 字段列为拒绝字段）；`agent_instruction`（需可用模型站点）。
3. 真实凭据与外部网络往返；Windows/Linux 未测；伪造 `senderFrame` 的运行时反例（渲染层无法构造带桥面的非外壳 sender）。



## 8. 收口后最终门禁

```
$ npm run build                                              BUILD_EXIT=0
$ npm test                    （独占）
1..2444
# tests 2444 / # pass 2443 / # fail 1                      TEST_EXIT=1
唯一失败：not ok 337 - D5-03-E（基线既有环境项，自 B1 起从未新增失败）
$ node experiments/dxos-e2e/run-all.mjs           PASS 102 / FAIL 0 / NOT_VERIFIED 1
$ node experiments/dxos-e2e-write/run-all.mjs     PASS 133 / FAIL 0 / NOT_VERIFIED 1
$ node experiments/dxos-ui-real/run-all.mjs       PASS 135 / FAIL 0
$ node --test tests/dxos-e2e-contract.test.mjs tests/dxos-e2e-write-contract.test.mjs   全绿
```

