# Dx-B3-RESULT · B3（任务 / Agent / 工具）+ 测试报告

> 依据：本轮任务「开始 B3」。分支 `dxos-port/r1`，工作区 `/Users/wepingli/.openarc-worktrees/dxos-port-r1`。
> 起点 = `fe94be9`（B2 收口）。全部结论带真实命令与真实输出；未验证项显式标注 NOT VERIFIED。

## 1. 交付对照（任务 §5 B3）

| B3 要求 | 落点 | 状态 |
|---|---|---|
| 任务状态机（11 态）、租约心跳、worker、恢复 | `electron/agent-task-store.cjs`（1760 行，导出 82 名，逐函数移植 `taskStore.ts` 1069 行） | ✅ |
| 计划 / 步骤 / 事件 / 检查点 / 交付物 / 观测 / 预算 / 断点续跑 | `task_plans`/`task_checkpoints`/`deliverables`/`task_observations`/`task_attempts`/`agent_turns`（v22 已建，原样复用）+ 新增 `dx_tasks`/`dx_task_steps`/`dx_task_events` | ✅ |
| 项目快照 / 记忆 | `electron/agent-project-snapshot.cjs` + `project_memories` | ✅（fs 部分依赖 B6） |
| Agent 回合组装 / 能力注册 / 上下文分段 / 巡检 | `agent-kernel.cjs`、`capability-{types,discovery,router,target-resolver}.cjs`、`progressive-capability-router.cjs`、`agent-kernel-inspection.cjs` | ✅ |
| 父子委派 深 3 / 每 Run 8 子 / 并行 3 | `agent-kernel-supervisor.cjs`（常量 3/8/3）+ 并行闸门在 `agent-task-store.cjs` 的 `claimNextTask`（同根 <3，与源一致） | ✅ |
| Run 生命周期 / 请求信封 / 服务端工具循环 / 工作区隔离 / 用量 / 模型回退 | `agent-runtime-{envelope,profiles,fallback,usage,workspace,manager,tool-loop,deps}.cjs` | ✅ |
| 工具目录七类（system/媒体/文件/画布/app/mcp/skill）与解析 | `agent-tool-catalog.cjs`、`agent-tool-resolver.cjs`（未落地的来源如实 `unavailable`+原因） | ✅ 结构完成，来源接线待 B4/B5/B7 |
| 内置工具 / CLI 桥 / ReAct | `agent-builtin-tools.cjs`、`agent-cli-tools.cjs`（即梦）、`agent-cli-bridge.cjs`（codex/gemini/antigravity）、`agent-pippit-tools.cjs`、`agent-react-driver.cjs` | ✅（CLI 未安装即 `CLI_UNAVAILABLE`） |
| IPC 接线 | `agent-domain.cjs`（26 条命令）+ `agent-service.cjs` + `agent-bootstrap.cjs` + `agent:command` / `agent:event` + preload 第 18 个顶层键 | ✅ |

新增实现约 **12,900 行**（`.cjs`）+ 测试 **3,700 行**（11 个文件、195 例）。

## 2. 架构决策（含一处必须知悉的张力）

1. **既有 OpenArc 任务域一字不动**：`tasks`/`task_steps`/`task_events`（7 态 CHECK）继续服务既有 DSH/ACP 链路；DX 的任务域落到**新表** `dx_tasks`(39 列)/`dx_task_steps`(15 列)/`dx_task_events`(7 列)，来源 `ccsDb.ts` 的 base CREATE + 全部 ALTER 机械抽取（`scripts/extract-dxos-agent-schema.mjs` 可复算）。v22 已建的 DX 表原样复用，**不改任何既有表结构**。
2. **张力（显式登记）**：既有代码写着「绝不建立第二套 Task / permission / approval / execution state」（`task-bootstrap.cjs:12`）。本批选择"两套表并存、互不写对方表"，原因是既有 `tasks.status` 的 7 态约束无法承载 DX 的 11 态，且 D5 的租约/副作用权威有大量测试守着。若要合一，需要一次明确的表结构合并决策 —— **本轮不做，留待决策**。
3. **桥接表 `dx_project_roots`**：OpenArc `projects` 没有 `root_node_id` 且禁止改列，为不把 `projectForRoot`/`projectSnapshot` 做成假实现，新增桥接表（随 v23 建，schema 模块标注"非抽取、OpenArc 桥接"）。
4. **跨批次依赖一律注入**：模型调用经 B2 `provider-protocol-service.call`；工具执行经 `agent-builtin-tools.runTool`；fs 虚拟文件树（B6）、技能与本地账号（B4）、画布（B5）、开发者 App/第三方集成（B7）未落地 → 结构化 `AGENT_DEPENDENCY_UNAVAILABLE`，不做假实现。
5. **云与商业化**：`apiQuota`/`withApiQuotaOwner`/`assertApiModelAccess` 全部移除并注明；独立验证抓到的 `agent-cli-bridge.cjs` 里 `api.dx-os.com` 默认下载端点**已收口**（改结构化不可用 + 断言零 fetch）。

## 3. 真实命令与真实输出

```
$ npm run build
✓ 1638 modules transformed.  ✓ built in ...                 BUILD_EXIT=0

$ npm test                     （独占，无其它负载）
1..1745
# tests 1745 / # pass 1741 / # fail 4                        TEST_EXIT=1
失败：121 D4-03 E（HARNESS/waitFor 超时）、177 D4-05 S4 A36（HARNESS_START_TIMEOUT）、
      337 D5-03-E（基线既有环境项）、1535 Provider Secret（HARNESS_START_TIMEOUT）

$ node --test --test-concurrency=4 tests/*.test.mjs           （受限并发，第二次全量）
# tests 1745 / # pass 1741 / # fail 4
失败：195 D4-06、200 D4-06 Closure B、337、1502 取消时序 5 —— **与上一轮失败集合不同**

$ 逐个文件独占复跑（上述 8 个文件全部单独跑）
d4-03-model-binding 19/19 | d4-05-s4-memory-context 15/15 | task-harness-security 3/3 |
tool-gate-security 5/5 | d4-06-budget 6/6 | d4-06-resume 6/6 | task-harness-cancel-convergence 9/9  全 EXIT=0

$ npm run test:model-ipc-ui     （真实 Electron，preload 18 键新契约）
10/10 IPC checks passed                                      MODELIPC_EXIT=0

$ npm run test:design-system
01 PASS / 02 PASS / 03 PASS / 04 PARTIAL{"PASS":33,"NOT VERIFIED":1} / 05 PASS
合计 5 个探针：PASS 4 / PARTIAL 1 / FAIL 0                    DS_EXIT=0

$ node experiments/dxos-p2/stub-call.mjs
checks=15 failures=0                                         EXIT=0

$ node --test tests/dxos-agent-*.test.mjs    （195 例）
schema 7 | task-store 16 | migration 7 | kernel 24 | runtime 30 | tool-catalog 17 |
tool-resolver 20 | cli-tools 33 | cli-bridge 24 | react-driver 9 | ipc 9   → 195/195
```

**全量测试失败的口径（诚实结论）**：4 条失败中 1 条是基线既有环境项（`#337`，worktree `node_modules` 符号链接）；另 3 条在三轮全量里**集合各不相同**（D4-03/D4-05/安全 → D4-06/D4-06/取消时序），错误性质均为 `HARNESS_START_TIMEOUT` / `waitFor 超时`（duration_ms ≈ 900s），且**每个受影响文件单独跑都全绿**。判定：新增 195 例后全量并发负载升高，触发真实 spawn harness 的子进程启动超时（B2 阶段已登记过同类 flaky）。**非本批逻辑回归**；建议把该族（D4-02B/D4-03/D4-05/D4-06/取消时序）拆到受限并发或独立串行组。

## 4. 独立验证（只读，与移植岗分离）

- **结构对照**：28 个模块逐一比对源 TS export 与 `.cjs` 导出 → **缺失 runtime 导出 = 0**；多余 202 个全部是注入/测试 seam（38）、TS 类型运行时投影（47）、内部 helper 提升供测试（117），未发现改名或语义替换。
- **表结构独立重算**：`dx_tasks` 39 列（CREATE 46-65 的 18 列 + 21 处 ALTER）、`dx_task_steps` 15 列、`dx_task_events` 7 列，与移植 DDL 列名/类型/NOT NULL/默认值/UNIQUE **逐字符一致**；`REFERENCES` 0 处、`PRAGMA foreign_key_list` 全空、重复执行幂等；v23 接线隔离（`identity-store.cjs:1532`）。
- **语义抽查 10 个关键函数**（claimNextTask / heartbeatTask / completeStep / consumeBudget / persistAgentTurn / advanceAgentTurn / delegateAgentWork / serverToolLoop / workspaceStore.commit / reactDriver 取消与预算）逐行一致，无偏差；`withApiQuotaOwner` 已按 OUT 删除。
- **上限与闸门**：深 3 / 每 Run 8 子（源 `supervisor.ts:9`）、并行 3 的真实闸门在 `claimNextTask` 同根 <3 子查询（源 `taskStore.ts:765-767`）。
- **约束**：`package.json`/`package-lock.json`/`index.html`/`tokens.css`/`DESIGN_SYSTEM.md`/`MOTION_SYSTEM.md` **零改动**；preload 顶层键**恰好 18 且含 `agent`**、无裸 `ipcRenderer`；`agent:command` 的 `trusted(event)` fail-closed；无新增依赖。
- **运行**：195/195 + 13 个受影响的既有测试文件全通 + stub 探针 15/15；socket 级离线守护 **0 条非回环连接**。
- **验证发现并已修**：`agent-cli-bridge.cjs` 的 `api.dx-os.com` 默认下载端点（未接线、渲染层不可达）→ 改为结构化 `AGENT_DEPENDENCY_UNAVAILABLE` + 新增"零 fetch / 无该 host"断言，24/24 通过。

## 5. 源事实勘误

- 任务书曾要求 `cliTools.ts` 删除 ffmpeg 与 apiQuota 调用；**实测该文件内两者都不存在**（ffmpeg 在 `server/video/*.ts`，属 B5；apiQuota 在 `protocols.ts`/`store.ts`，B2 已处理）。已按源码事实修正，不做无依据的"删除"。

## 6. 未验收 / NOT VERIFIED

1. **真实 Electron 端到端**：`agent:command` 只有源码接线核对 + 假 ipcMain 单测；未在真实窗口里跑过命令（`test:model-ipc-ui` 覆盖的是 preload 键契约，不是 agent 命令）。**UI 未做**：本批只交付数据/IPC 能力，Agent 控制台/会话界面未做 —— 按项目规范，UI 需要单独一份列明页面状态、规范章节、token/组件、基准与验收方法的 UI 任务计划。
2. **真实模型调用未触发**：`modelAdapter` 已接 `provider-protocol-service.call`，但测试用 `modelService:null`；外部供应商仍无凭据（沿用 B2 的 NOT VERIFIED）。
3. **CLI 真实执行未验证**：codex/gemini/即梦/pippit 全部只验证"未安装探测 + 参数拼装 + 结构化失败"；本机未安装、未真跑。
4. **fs 虚拟文件树（B6）未落地**：文件工具执行、`project/snapshot`、工作区提交真值通道保持结构化拒绝；`agent-runtime-workspace` 只用注入的假适配器驱动。
5. **`agent/capability/route` 固定结构化拒绝**：本仓无 `modelResolver`，需要模型路由适配器批次。
6. **工具来源接线**：catalog 中 app/mcp/skill/canvas 来源未接真实实现（B4/B5/B7），当前如实 `unavailable`。
7. **`sharp` 未声明**：仅惰性 require（缺失即 `SHARP_UNAVAILABLE`），登记为 B5 前置项。
8. **全量测试的 3 条负载敏感失败**：见 §3 口径，未"修绿"也未掩盖。

## 7. 结论

B3 三项（任务域 / Agent / 工具）**结构完整、语义抽查一致、约束未降级、云与商业化未引入**；build ✅、195 例新测试 ✅、真机 preload 探针 10/10 ✅、design-system ✅、stub 端到端 ✅；全量测试仅剩 1 条基线既有环境项 + 3 条已定性的负载敏感超时（逐文件全绿为证）。未验收项已逐条列明。B4（技能 + MCP + 本地账号）可在本批基础上开始。
