# DX OS 后端是怎么做的 · OpenArc 移植进度与剩余工作

> 2026-10-09 · 依据：DX OS 0.5.1 随包源码（`app.asar.unpacked/server/`、`app.asar` 内 `main.cjs`）、本机 `data/` 目录、OpenArc 主仓库与 `~/.openarc-worktrees/dxos-port-r1`。只读分析，未改任何代码。
> 已有的详细移植计划见 `~/Downloads/DXOS-Portable-0.5.1-mac-arm64/DXOS-PORT-IMPLEMENTATION-PLAN.md`（P0–P8）；本文不重复计划，只回答"它怎么做的、我们做到哪、剩下什么、先做什么"。

---

## 1. DX OS 后端的整体形态

```
DX OS.app（Electron，主进程 main.cjs 1,589 行，很薄）
 ├─ 窗口：一个 1440×920 主窗口，加载 http://127.0.0.1:5275（前端由后端服务直接下发）
 ├─ 管：端口、数据目录迁移、代理、更新、局域网开关、剪贴板、选目录
 └─ spawn 内置 node + tsx 运行 TypeScript 源码（不预编译）
     ├─ server/index.ts   Express 服务（10,142 行）：~560 条 /api 路由 + 静态前端 + SSE 流
     └─ server/worker.ts  后台 Worker：每 700ms 领取任务，8s 租约心跳；跑 Agent 任务、ReAct 任务、视频渲染
```

**几个关键设计**

| 方面 | DX OS 的做法 |
|---|---|
| 前后端通信 | 普通 HTTP `fetch('/api/...')` + Server-Sent Events 做流式（对话、任务事件、Agent 运行事件共 8 处） |
| 登录 | Cookie 会话 `ccs_session`；每个用户同时只允许一个活动会话 |
| 局域网 | 开关打开后服务监听 `0.0.0.0`，同网其他电脑**直接用浏览器打开** `http://本机IP:5275` 就是完整 DX OS——多人协作靠这个 |
| 数据 | 数据目录下多个 SQLite：`ccs.db`（核心，约 50 张表）、`auth.db`、`ai-tasks.db`、`protocol-tasks.db`、`api-quotas.db`、`lingxing-local.db`；配置是 JSON（`mcp.json`、`skills.json`、`fs.json`…）；文件是本地目录 |
| 重活 | 独立 Worker 进程 + SQLite 任务表做队列（租约、心跳、检查点、可恢复） |
| 外部能力 | 子进程跑 CLI（即梦、Pippit、OpenAI CLI）、Python（紫鸟）、ComfyUI、FFmpeg、onnxruntime 抠图 |

**代码量分布（server/，共 63,422 行）**

| 子系统 | 行数 | 主要文件 |
|---|---|---|
| 模型 / 协议（多服务商统一调用） | 15,466 | `protocols.ts` 6,785、`protocol-engine/` 12 文件、`modelDescriptor` `protocolManifest` |
| HTTP 装配层 | 10,142 | `index.ts`（路由、中间件、启动自愈） |
| Agent / 任务 / 工具 | 9,044 | `agent-kernel/` `agent-runtime/` `taskStore` `worker` `toolCatalog` `cliTools` |
| 技能 Skill | 3,473 | `skills.ts` 2,298、`skillPacks` `skillImport` `skillAnalyzer` |
| 第三方集成 | 3,465 | 领星、紫鸟、钉钉、夸克、天气、黄历 |
| 开发者平台 + 市场 | 3,335 | `developerApps` 等 12 个、`marketplace` |
| 文件 / 系统 / 诊断 | 3,295 | `fs.ts` 1,451、`ccsDb`、快照、更新、诊断 |
| 生成任务（图像 / 视频提交与恢复） | 2,924 | `ai-tasks/` 19 文件 |
| 媒体（视频渲染、抠图、短剧、音乐库） | 2,928 | `video/` `backgroundRemoval` `shortDrama` `library` |
| 画布 | 2,558 | `canvas.ts` + 协作 / 素材库 / 插件 / 打包 |
| ComfyUI | 2,435 | `comfyui` `comfyBridge` `comfyWorkflows` |
| 账号 / 配额 / 密钥 | 1,398 | `auth` `apiQuota` `secretVault` |
| 云账号 / 权益 | 1,199 | `cloudAccount` `cloudEntitlement` `dxosProtocol` |
| MCP | 1,129 | `mcp.ts` |
| 自动化 | 577 | `automations` + 目录 + 业务动作 |

**路由前缀前 10**：market 77 · canvas 54 · comfyui 33 · fs 26 · agent 25 · providers 23 · lingxing 22 · cli 22 · protocols 19 · library 14。

---

## 2. OpenArc 的形态与 DX OS 的根本差异

| | DX OS | OpenArc |
|---|---|---|
| 进程模型 | Electron 壳 + 独立 Node 服务 + Worker | Electron 主进程内的领域模块（32,718 行 CJS） |
| 通信 | HTTP + SSE | `ipcMain.handle("<域>:command")`，经 `preload.cjs` 的 `window.openarc` 单一桥；生产 CSP `connect-src 'none'`，前端不能访问任何端口 |
| 现有域 | — | identity、authorization、device、resource、files、model、task、sideeffect、mcp、canvas、governance、browser、windows（共 13 个命令通道） |
| 数据 | 多个 SQLite + JSON | 单库 `identity.db`（`node:sqlite`）+ safeStorage 凭据 |
| Agent 执行 | 自研 agent-kernel / runtime + Worker 队列 | DeepSeek DSH Harness（ACP 协议）+ 任务编排 + 受控工具代理 + 副作用审批 |
| 安全 | 中间件鉴权 + 配额 | 对象授权（用户 ∩ App ∩ 资源范围 ∩ 部门 ∩ 动作）、副作用审批链、执行隔离 |

结论：**OpenArc 的安全与权限地基比 DX OS 更严**，而 **DX OS 的能力面（模型协议、技能、媒体、市场、自动化）比 OpenArc 宽得多**。所以移植是"把 DX OS 的能力装进 OpenArc 的地基"，不是换后端。已有计划选的"IPC 域为主 + 受监督子进程做重活"方向是对的。

**需要你注意的一个分歧——局域网协作**：DX OS 的局域网多人使用是"开个 HTTP 服务、别人用浏览器访问"，几乎零成本。OpenArc 走 IPC，前端不能联网，局域网协作必须另做一个带认证的局域网服务（`PLAN.md` §26 已规划但未实现）。这不影响单机移植，但会决定"多人协作"什么时候能有。

---

## 3. 移植做到哪了（"一半"的实际含义）

按 DX OS 子系统逐项对照：

| DX OS 子系统 | OpenArc 现状 | 程度 |
|---|---|---|
| 账号 / 部门 / 角色 / 会话 | identity + authorization + governance 已成体系（D3），比 DX 更细 | ✅ 已有等价 |
| 设备身份 | device 域（D3-03） | ✅ OpenArc 特有 |
| 文件系统 | files + resource 域 + 资源库 | ✅ 基本等价（缺快照 / 内容寻址对齐） |
| MCP | 连接、配置、能力发现已有；**工具调用未开放** | ◐ 约一半 |
| 任务 / Agent 执行 | task 编排 + DSH Harness + 工具代理 + 审批（D4）已打通单任务链路 | ◐ 骨架有，缺委派、检查点恢复、项目记忆对齐 |
| 模型服务商 / 协议 | 基础 model 域（D4-01）在主仓库；**DX 协议引擎（P2）只在 worktree，未提交**；18 个 v2 协议只通 1 个（openai-images） | ◐ 约 1/5 |
| 移植地基（P1：52 张 DX 表并入、路径、错误、事件、运行器、配额） | worktree 已完成；**今天正在被复制进主仓库（未提交）** | ◐ |
| 画布 | canvas 域 + CanvasHost 已有；缺素材库、打包、协作 | ◐ |
| 浏览器 | browser 域（D5-01） | ✅ OpenArc 特有 |
| 技能 Skill | — | ○ |
| 生成任务（图像 / 视频提交、轮询、恢复） | — | ○ |
| 媒体（视频渲染、抠图、短剧、音乐库） | — | ○ |
| ComfyUI | — | ○ |
| 自动化 | — | ○ |
| 应用市场 / 开发者平台 | — | ○ |
| 配额 / 成本 | P1 有配额原语 | ○ 未接入 |
| 云账号 / 权益 | — | ○（建议只留关闭开关） |
| 第三方集成（领星 / 紫鸟 / 钉钉 / 夸克） | — | ○（建议做成可选插件，最后做） |

粗算：按 DX OS 代码量加权，**有等价或已移植的约占 35–40%**；按"用户能感知的功能面"算更低，因为技能、生成、媒体、市场、自动化这些看得见的能力都还没有。说"一半"是偏乐观的。

---

## 4. 当前风险（需要马上处理）

1. **P2 成果没有提交**：协议引擎（15 个文件）、服务商协议域、能力清单、8 个新 IPC 动作，全部只在 `~/.openarc-worktrees/dxos-port-r1` 的工作区里，`dxos-port/r1` 分支没有任何新提交。这个工作区在主仓库的 git 记录里已被标为"可清理"（prunable），执行一次 `git worktree prune` 就会和仓库断开。**建议先提交到分支。**
2. **有另一个会话正在同时改主仓库**：今天 11:27–11:38 有 `electron/dxos-foundation-*.cjs` 7 个文件和 `identity-store.cjs` 被写入主仓库，同时还在做 Vue 页面布局统一（`artifacts/layout-unify/`）。主仓库目前有 20+ 个已修改文件和十几个未跟踪目录，都没提交。两个会话同时改同一工作区，容易互相覆盖。
3. **桌面上的 `OpenArc OS.app` 是用 worktree 构建的**，和主仓库代码不一致（`PROJECT-STATUS-REVIEW.md` §0 已指出）。

---

## 5. 建议的推进顺序（按用户能看到的价值排，而不是按代码依赖排）

| 顺序 | 内容 | 为什么先做 | 依赖 |
|---|---|---|---|
| 0 | 收口：P1/P2 提交到 `dxos-port/r1`；主仓库 Vue 改动提交；定一个唯一的集成分支 | 防止丢代码、防止两条线越走越远 | 无 |
| 1 | **模型协议补齐**（剩 17 个协议族，先做 OpenAI 兼容对话、Gemini、火山、MiniMax、Midjourney 五族） | 这是所有 AI 能力的入口；设置 · 模型与服务商页面靠它 | P2 |
| 2 | **对话 + 生成任务**（ai-tasks：提交 / 轮询 / 恢复 / 产物落资源库） | 用户最先感知的就是"能聊、能出图出视频" | 1 |
| 3 | **Skill 系统**（注册、启停、技能包导入导出、执行）+ **MCP 工具调用开放并接审批** | Agent 能力面的主体 | 2 |
| 4 | **Agent 内核补齐**（委派、检查点恢复、项目记忆）——在现有 DSH Harness 上扩，不另起一套 | 让项目 Agent 能跑长任务 | 3 |
| 5 | 自动化 + 日历 / 天气（小） | 量小、可见度高 | 2 |
| 6 | 媒体：视频渲染 Worker、抠图、视频剪辑 / 短剧后端；ComfyUI | 依赖 FFmpeg / Python / 模型文件，环境准备耗时 | 2，本机依赖 |
| 7 | 应用市场 + 开发者平台（本地目录源） | 最大的单块，放在核心能力稳定之后 | 3 |
| 8 | 局域网协作服务 | 见 §2 分歧 | 身份 / 授权已有 |
| 9 | 第三方集成插件；云能力关闭开关 | 可选 | — |

前端节奏跟着走：每完成一块后端，就用设计语言 1.0 的对应原型把界面迁成 Vue（例如 1 → 设置 · 模型与服务商；2 → 对话 + 助理浮层；3 → Skill 中心）。

---

## 6. 需要你决定的后端问题

1. **局域网协作**：首版就要（那需要尽早做局域网服务），还是先单机、二期再做？
2. **范围**：应用市场 + 开发者平台（DX 的第二大模块）是否进首版？
3. **第三方集成**（领星 / 紫鸟 / 钉钉 / 夸克）：是你的业务需要，还是只是 DX OS 里有？不需要的话直接不做，能省约 3,500 行。
4. **本机依赖**：FFmpeg 已有；ComfyUI、onnxruntime、抠图模型要不要装到这台 Mac 上？
