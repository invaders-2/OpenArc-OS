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
