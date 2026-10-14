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
