# Dx-FINAL-RESULT · 「没做完的 + 没做好的」全量收口报告

> 依据：用户指令「可以，把没做完的跟没做好的全部都做好」。分支 `dxos-port/r1`，起点 `b4034b1`（B7 收口）。
> 本报告只记录**本轮新增**的收口工作；B1–B7 与 UI-1…UI-5 的原始交付见各自 `Dx-*` 报告。

## 1. 本轮交付对照（逐项）

| # | 原缺口 | 处置 | 关键证据 |
|---|---|---|---|
| 1 | 协议表把 runninghub/modelscope/agnes 标 `execution: unavailable`（与实际能力不符）；`cli:jimeng/codex/gemini` 的 legacy 分支未接 B3 已交付的 CLI 桥 | 新增 `execution: conditional` + "可执行前提"文案；新增 `legacy-cli-ports.cjs` 三族端口并在 legacy 执行器接上；agnes 实现后改判 conditional；补 RunningHub 对话/图片理解端口，使**对话/图片/视频/编辑四维度**都条件可用 | 210/210 → 249/249；20 条分支矩阵探针「未注入=结构化拒绝、注入=真调用」；协议表键集合仍 71（38+33） |
| 2 | 未移植台账：agnes、领星分析/看板/导出/汇率、紫鸟 VC 行级导入、RunningHub chat/describe 与 AI 应用入口 | 逐函数移植：`plugin-agnes.cjs`、领星 +450 行、紫鸟 VC 三函数、RunningHub chat/describe + 7 个入口暴露为命令（共 19 条新命令） | 96/96；协议回归 114/114；白名单↔实现一一对应断言 |
| 3 | MCP 工具调用"只在注入假 transport 的测试对象上被证明"：无聚合命令、无真传输、无审批链、开关无 IPC | ① 后端聚合命令 `mcp/agentTools`（前端不再自算）；② `mcp-client.cjs` 边界改为**开关 + 审批决定 ALLOWED** 双条件，生产注入真实传输；③ MCP 注册为**既有 SideEffectAuthority 的 provider**（plan/execute/verify，未新建第二套权威）；④ 开关写命令 `mcp/toolInvocation/set`；⑤ 新增 `dx_task_approval_bridge`（`SCHEMA_VERSION 25→26`，只新增表）把 `dx_tasks` 步骤幂等映射到核心审批任务，使 **agent 工具循环也能真正执行 MCP** | loopback MCP 服务端到端：开关关/未审批/拒绝/超时**0 传输**；审批通过→真实 `tools/call` 到 loopback 并回结果；审计链 planned→approved→placement→started→verification_passed→succeeded；映射幂等（5 次 ensure → 1 条映射）；dx 侧任务表调用前后哈希一致；509/509 测试 |
| 4 | 工程项：`#337` 基线失败、theme 探针仍写已废弃键、UI 探针依赖手建 chromium 符号链接、health 语义变更未广播 | `#337` 改 realpath 口径（保留"不得回落共享/全局"原断言）→ **7/7 且全量 2582/2582/0**；theme-matrix 改应用真实键 + 保留旧键兼容断言（修前深色三格假失败 17 条）；新增共享 `experiments/lib/chromium.mjs`（`OA_CHROMIUM` → 官方 chromium → 系统 Chrome），**全仓 18 个脚本**收口；语义写进类型注释与文档并 grep 确认无其它消费者 | 见 §3 |
| 5 | `dx_*` 与既有 `tasks` 两套任务无统一读入口 | 新增只读 `task-unified-view.cjs`（11 态↔7 态显式映射、只读断言、无写穿断言）+ `agent/task/unified-list` 命令 + `Dx-TASK-DECISION.md`（A/B 取舍与 B 的具体代价，不替用户决定 B） | 39/39（含六表调用前后哈希不变） |
| 6 | D1-04 两个探针长期不通过 | 根因全部判定为**探针口径**（拖动取点复用旧 bbox、`.window:not(:has(.split))` 薄玻璃作用面、红灯是最小化非关闭），**产品缺陷 0**；只改探针到达路径，断言与 EXPECT 正则一字未动 | `perf-product` exit 0；`ui-audit` **27/27 连跑两次**一致 |
| 7 | UI 四处入口按批次禁用 | 技能侧（分析/保存/工作区/媒体运行+产物）、任务页四个写入口、模型页四个动作入口、MCP 中心改调后端聚合命令；写类动作接既有 Dialog 二次确认（确认前 0 命令 / 取消 0 / 确认后发送）；入口卡片样式补齐 | 单测 134/134；探针 69/62/67/88；真机窗口新增 10 张入口截图（浅/深） |
| 8 | 打包/分发链路未验收、随包与厂商路径机制缺失 | 新增离线打包脚本 + **真实 .app** 用隔离 userData 跑 CDP 验收；`resources/bundled-skill-packages/`（自写示例包，不搬上游 zip）；`resources/vendor/README.md` + 夸克/紫鸟**四级路径解析**（注入 > 环境变量 > userData > 随包） | 打包产物探针 **103 PASS / 0 FAIL**（25 键、9 条 health）；随包包在打包载荷内可列出并导入；231/231 相关测试 |
| 9 | UI 只有度量对照、无像素级回归基线 | 新增 `experiments/dxos-visual-baseline/`（零依赖 canvas 比对、阈值+逐图覆写、`--update`、87 张基准图）+ **自证有效**（注入 40×40 红块被抓住、恢复后全绿） | 29 项单测；86/87 通过 + 1 张流式帧显式排除并说明 |
| 10 | 构建/类型检查在子岗约束下被跳过，门禁才暴露 | 修掉 `SkillCenter.tsx` 的类型错误（用真实类型谓词收窄，未用 `any`/`@ts-ignore`） | `tsc --noEmit` **0 诊断**；`npm run build` exit 0 |
| 11 | 负载下探针/测试抖动被误读为回归 | 逐项定性：`#184`/`#303`/DS Toast 单独复跑通过（抖动）；D4-08 用**机制证据**证明是宿主 swap 抖动误杀 harness turn（断言未动，只加基础设施重试）；探针改为负载自适应 + 有界重试 + 崩溃守卫（修掉"异常后僵尸 Chromium 挂 10 分钟"） | 见 §3、§4 |

## 2. 宿主环境发现（重要）

本轮大量"失败"的共同根因是**本机资源耗尽**，不是代码问题：

- `vm.swapusage`：total 25,600 MB / **used 23,988 MB** / free 1,612 MB
- 进程数 **734**；loadavg 在 5 → **22** 之间大幅波动
- 现象：真实 `dsh` 子进程卡在 ACP prompt，恢复瞬间撞上 180s turn 预算 → `HARNESS_TURN_TIMEOUT`；#184/#303/Toast 等阈值型断言随机失败；探针单次耗时从 40s 涨到 771s / 3101s（其中大部分是 `ffmpeg CRF8` 单线程录像编码，观测到稳定 99% CPU）
- 同一份代码在停顿结束后一次通过（D4-08 已给出逐条对照）

结论：**建议清理占用内存的进程**（例如长期运行的浏览器/编辑器）。清理后所有验证会快一个量级。

## 3. 真实验收结果（本轮）

```
npm run build                BUILD_EXIT=0
tsc --noEmit                 0 诊断
npm test                     2582 / 2582 / 0   （#337 已修）
npm run test:model-ipc-ui    真实 Electron 10/10（preload 25 键）
五套 UI 探针                  skills 69 / mcp 62 / tasks 67 / org 51 / model 88（各自 exit 0）
真实窗口探针                  PASS 176 / FAIL 1（唯一失败为 model 探针报告缺失的连带，见 §4）
真机只读 E2E                  PASS 103 / FAIL 0 / NOT_VERIFIED 1
真机写链路 E2E                PASS 133 / FAIL 0 / NOT_VERIFIED 1
打包产物 E2E                  PASS 103 / FAIL 0（--app-path 直载）
媒体真机探针                  全部通过（真实 ffmpeg 全链路）
视觉像素基线                  87 帧（V1 采集与自证）
各域测试                      developer/plugin/integration 249+96；MCP+side-effect+安全门 509；tool 143；side-effect 198；dxos-agent 202
```

## 4. 仍未闭合 / 未验证（如实）

1. **最终一轮完整串联复跑未完成**：宿主 loadavg 22 下，仅 model 探针单次就需 13–50 分钟、且录像编码占满单核；基线与真机对照需要它先产出报告。已确认**各组件单独均通过**（见 §3），但"同一次无并发跑完整套"未取得结果。
2. **model 探针的 report.json 当前缺失**（被我中途终止的基线作业影响），因此真机 UI 的 model 页对照项暂为 FAIL；重跑一次 model 探针即可恢复。
3. **视觉像素基线未在最终探针代码上重跑**：基线由 V1 在该 UI 冻结态采集并自证有效；此后 UI 只改了一处类型收窄守卫（不影响渲染）。重跑一次即可确认逐图一致。
4. **凭据与外部网络**：无任何供应商 Key，且全程不联网；MCP 之外的第三方（RunningHub/ModelScope/agnes/领星/紫鸟/钉钉/天气）只到"请求构造/轮询/降级"层。
5. **Windows / Linux 未测**（仅 macOS + Electron 44）。
6. **上游厂商二进制不入仓**：486KB 夸克 CLI、紫鸟 Python 运行时、分发里的迷你技能包 zip 一律不搬运，改为四级路径注入 + 结构化不可用（合规决定，非能力缺失）。
7. **D4-08 的 containment 只在测试前置层**：宿主 swap 病根未消除；若一次 freeze 让 3 次重试全部超预算，测试仍会失败（不会假绿）。
8. **自动化动作仍不可达的项**：`desktop` 类（`music_play`/`open_app`，本仓无桌面执行端）、领星/紫鸟同步的 `mcpCallDirect/transportFactory` 注入、`app_action`（清单 `automation` 字段被拒绝）、`agent_instruction`（需可用模型站点）。
9. **skill 文本分支成功产出**：离线无模型站点，如实返回 `SKILL_DEPENDENCY_UNAVAILABLE`。
10. **`dx_*` 与 `tasks` 的表级合并**：仍是你未决的产品选择；本轮交付的是低风险统一读模型 + 决策文档。

## 5. 机器空闲时的收尾命令

```bash
cd /Users/wepingli/.openarc-worktrees/dxos-port-r1
node experiments/dxos-ui-model/run-all.mjs      # 恢复 model 报告
node experiments/dxos-ui-real/run-all.mjs       # 真机对照应回到 177/177
node experiments/dxos-visual-baseline/run-all.mjs   # 87 帧逐图确认
npm test                                        # 全量回归
```

## 6. 结论

本轮把清单里**能做的都做了**：协议可用性语义与实际能力对齐、未移植台账清空到只剩明确 OUT 项、MCP 工具调用从"纸面可用"变成"开关+审批+真实传输+既有权威+端到端 loopback 证明"、两套任务有了统一读模型与决策文档、UI 四处禁用入口补齐并加二次确认与真机截图、打包链路与随包/厂商路径成体系、视觉像素基线可自证、构建门禁恢复全绿（2582/2582/0）。剩余未闭合项集中在**宿主资源耗尽导致的最终串联复跑**与**无凭据/跨平台**两类，已在 §4 逐条列明并给出收尾命令。


---

# 追加：Z 轮（定位即授权、资源库入口、MCP 开关 UI 与台架修复）

> 本段追加于 Dx-FINAL-RESULT 之后，记录 Z 轮（用户批准"定义即授权"与"资源库入口并回访达"之后的持续收口）。

## Z1 · 定时自动化同步「定义即授权」

- 授权来源：认证管理员**创建/启用/改动作**某个自动化定义时落授权（principal + 定义 id + 动作范围快照 + 时间 + sessionRefHash），停用/删除即撤销，每次运行落 `automation.execute` 并可按 run 追溯；**复用既有 `authorization_audit`，不新增表，SCHEMA_VERSION 仍 26**（未新建第二套审批权威）。
- 执行：集成动作前过闸门；无授权记录 / 定义停用 / 动作超范围 / 传输未注入 → 结构化拒绝且 **0 次外发**（四条均有断言）。
- 与 MCP 的关系：自动化链路把定义授权翻译成 MCP 客户端认的审批凭证；**临时发起的集成命令不带该凭证**，因此 MCP「开关 + 审批决定」双条件**原样生效**（`mcp-client.cjs`/`mcp-switch.cjs`/`side-effect-*.cjs` 代码零改动）。
- 生产仍需 MCP 工具调用总开关打开（`<userData>/dxos/mcp.json`），即"总开关 + 定义授权"两把锁。
- 升级后果（已覆盖）：变更前已启用但无授权记录的定义会被拒绝，管理员点一次"启用"即补写授权。
- 验收：495/495（含 4 条"0 次外发"断言）。

## Z2 · 「加入资源库 / 导出」并回访达窗口

- 访达窗口新增「资源库」工具栏入口、5 个菜单项与右键子菜单（`data-files-library-*`）；未选中禁用并把原因写进 aria-label/title，执行中 `disabled + aria-busy`，成功/失败/取消各有可见反馈。
- **唯一一份实现** `src/governance/filesLibraryActions.ts`（界面与单测共用）；主进程白名单 +2（`resource/importFromFiles`、`resource/linkFromFiles`）复用既有导入逻辑；磁盘路径**只在主进程解析、绝不过桥**；废弃组件 `FilesApp.tsx` 删除。
- 已知能力边界（如实）：虚拟文件夹不是磁盘目录 → 只选文件夹时入口禁用并说明；「导出资源」需 ResourceRef，仅对"本窗口刚加入过"的条目可用。
- 验收：单测 23/23 + 真机台架 **23/23**（含浅/深截图、连续录屏、只发白名单命令、DOM 不泄漏路径）。

## Z3 · MCP 中心「工具调用」开关 UI

- 新增区块：读真实开关状态、可开可关；写失败**回到真实状态**（不乐观切换）；文案讲清"默认关闭 + 打开后仍需逐次审批 + 无人值守暂不开放"；**不提供任何直接调用入口**。
- 验收：单测 27/27；探针 **95/95**（既有 62 项零回归；9 张状态图 + 开关录屏 + 深色对照）。

## Z 轮发现并修掉的**既有故障**（都与本次移植无关，但长期没人发现）

| 故障 | 证据 | 处置 |
|---|---|---|
| 治理/取景器/画布台架选择器全部失效 | 修前 `governance 1/5`、`picker 2/8`、C1–C4/P1/P2 FAIL；`[data-app-id]` 在 src+dist 均 0 处 | 更新到现行 DOM（`data-dock-id`/`data-org-*`/CanvasHost）；废弃能力断言删除并**指名取代者**；修后 **9/9、7/7、4/4、17/17** |
| 治理台架**未隔离 Electron userData** | 默认 userData 里残留的 `oa-dock` localStorage 把"组织治理"从程序坞删掉 → G1 直接失败 | 改用临时 userData（修后 **10/10**） |
| `d4-main-e2e.mjs` 走不到治理段 | setup 仍用旧"单页初始化表单"，而产品已改**三步向导**（`setup-next`→`setup-submit`），A2 恒失败 | 按三步向导驱动；治理授权改现行"权限策略"真实 UI + 产品桥 TOOL 授予；修后 **138/138**（连跑两次） |
| AI 面板追加/步骤/denied 钩子已删 | `data-ai-append*/steps/step/denied` 在 src+dist 均 0 处，能力迁到任务控制台/后端 | 断言切到产品桥与后端（`task/appendStep` + `task/get`），确无 UI 的 denied 断言删除并指名取代者 |
| 多份文档/注释"宣称与实际不符" | 工具调用旧口径、`未移植` 过时措辞、`execution: unavailable` 等 | 逐条改正（多次成批）；现在 electron 下**返回给调用方的 detail 里已无"未移植"** |

## Z 轮最终门禁（真实输出）

```
npm run build            BUILD_EXIT=0（重建 dist，解决"dist 落后于 src"）
npm test                 2747 / 2739 / 8
  → 8 条失败**全部经单独复跑证伪为宿主抖动**：
    d4-03-model-binding 19/19 · d4-05-s1-facade-association 6/6 · d4-05-s3-budget-ledger 4/4
    d4-05-s4-memory-context 15/15 · d4-06-resume 6/6 · side-effect-c4-dsh-write 5/5
    （均为真实 dsh 子进程 + 180s 墙钟预算，在 loadavg 22 下被误杀）
npm run test:model-ipc-ui  MODELIPC_EXIT=0
npm run test:design-system  DS_EXIT=0
tests/governance-ui.mjs     10/10
tests/files-library-ui.mjs  23/23
```

## 暴露出的方法论教训（写入台账）

1. **探针必须独占端口**（并发跑同一探针会 `EADDRINUSE` 且互相 `rmSync` 产物目录）。
2. **探针必须隔离 Electron userData**（默认 userData 的 localStorage 会改变程序坞等真实状态）。
3. **宿主资源耗尽会误杀**依赖真实子进程与墙钟预算的台架；这类失败必须**单独复跑证伪**，不能当回归也不能当通过。
4. **"不跑 build/test"的子岗约束**会让类型错误与半成品漏到门禁——门禁必须真正跑 `tsc`/`build`，并单独跑相关套件兜底。

## 仍未决（需产品判断）

1. **core 任务在任务控制台里只读**：统一读模型把 `tasks` 任务作为只读文本展示，不可选中/继续/追加；flow4/5/6 因此改走产品桥。要不要把 core 任务接成**可操作**（属新 UI 面）。
2. **`dx_*` 与 `tasks` 是否表级合并**（维持"双表 + 统一读模型"，见 Dx-TASK-DECISION.md）。

