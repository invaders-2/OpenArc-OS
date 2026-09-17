# D4-06 · 结果记录（关联链完整性 + 预算到限停止）

- Base HEAD（本轮起点）：`1feafeb9e179d7b1190c74418f936a754b96cb39`
- **被测 commit**（代码与测试提交）：`17df98e95e258995070e499a7970f465aa276a07`
- Final HEAD：本轮报告/证据提交（见文末）
- 分支：`feature/d4-03-tool-proxy`；工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`
- 运行前工作区：`test:d4-04` 干净（workspaceState=""）；`test:d4-06` 记录到上一轮同 commit 的生成物 `docs/D4-04-GATE-EVIDENCE.json` 刷新（代码零改动，见 §6）

## 1. 结论

**`D4-06 = PASS（限定当前验收范围）`**（由 D4-06 Closure 升级，见 `docs/D4-06-CLOSURE-RESULT.md`）。

- 关联链完整性（Task→Step→Call→Artifact→Verification）在真实产品链路通过（L1–L15 全 PASS）。
- 预算到限停止在真实产品 orchestrator + 确定性 provider 下通过（Y1–Y5 含 Electron UI 一致性；预算 Node 测试 6/6）。
- **A35 的“明确续接入口”已由 D4-06 Closure 满足**：Boss 批准仅在本范围解除 Explicit Resume 延期；预算耗尽 → 用户显式续接 → 成功（Electron UI 19/19、Node 续接 6/6，bounded ≤3 次）。其他恢复场景仍 `EXPLICIT_RESUME_DEFERRED`。

## 2. 预算种类 / 计量 / 作用范围 / 停止时机（依现有契约，未发明新预算）

| # | 预算 | 定义/计量 | 作用范围 | 停止时机 | 代码位置 |
| --- | --- | --- | --- | --- | --- |
| ① | Model Proxy capability `maxCalls = DEFAULT_MAX_CALLS = 8` | 每 Harness run 一条 capability；每次 prompt 原子消费；用尽 429 `CAPABILITY_EXHAUSTED` | 单个 Harness run | 下一次 prompt 被拒 → `adapter.prompt` 抛错 → orchestrator `#blockStep` | `electron/task-harness-orchestrator.cjs:30,165`；`electron/model-proxy.cjs #check` |
| ② | Tool Facade capability `maxCalls`（production=8） | 原子 reserve：`cap.calls >= cap.maxCalls` → 429 `TOOL_CAPABILITY_EXHAUSTED`；exact duplicate 不二次消耗 | 每个 run 独立 bridge / 独立 `tpx_` capability | 超限的受控 tool call 被拒（**执行前**），Domain 不执行 | `electron/task-bootstrap.cjs`；`electron/tool-facade-bridge.cjs:203` |
| ③ | 编排层 `MAX_TOOL_ROUNDS = 4` | 自动 tool loop 轮数上界 | 非 facade（openarc）READ tool loop，每个 run | 第 4 轮后仍有 proposal → orchestrator 自己 `#blockStep`+`blockHarnessRun`（reason `BUDGET_EXHAUSTED{TOOL_ROUNDS}`） | `electron/task-harness-orchestrator.cjs:31,213,236` |

`task.budget_snapshot` 仅是信息快照、**未被强制执行**，未当作预算使用。

## 3. 关联链审计（真实 Electron 链路，L1–L15 全 PASS）

- **L1–L7 归属/无孤立/无跨任务**：step / model call / tool execution / side-effect call / harness run / artifact / verification 的 task·step·run 归属违规集合均为 `[]`。
- **L8**：本次运行 10 个 task 全部被场景枚举（`{total:10, unenumerated:[]}`）。
- **L9**：成功 step（READ / WRITE-approve / SPOOF-approve）**必有 Artifact 且 checksum==sha256(content)**，每个 Artifact **必有同 task Verification**，成功任务收敛 SUCCEEDED。
- **L10**：Deny / Cancel / UNKNOWN / REVOKE_PENDING / REVOKE_MID / EXECUTION_EXCEPTION / BUDGET_STOP 七类**如实 0 Artifact / 0 Verification** 且非 SUCCEEDED，逐条标注“不适用（该路径无 artifact 提交）”——**未创建假记录凑关联链**。
- **L11**：同一 task 内 SideEffectCall `callId` 唯一（无重复副作用）。
- **L12**：成功 WRITE 恰好 1 次 mutation（write/spoof 各 1 条 SUCCEEDED call，目标均 trashed）。
- **L13**：R2 撤权中任务恰好 2 条 call（A `SUCCEEDED` / B `BLOCKED`）。
- **L14**：所有 task 收敛终态（无 RUNNING / PENDING）。
- **L15**：预算停止 task 的 bounded 受控 READ execution 保留且归属正确，0 Artifact。

## 4. 预算到限停止（真实调度链，不手工 blockStep）

**Electron 真实链路 Y1–Y5（全 PASS）**：provider mode `budget` = 14 次受控 `resource.search`（超过 bounded 预算）。
- Y1：Task/Step BLOCKED，Harness run 停止（非 RUNNING）。
- Y2：0 Artifact / 0 Verification（不适用：该路径无 artifact 提交）。
- Y3：实际仅发生 8 次受控 READ（`execs:8`，工具仅 `resource.search`，task modelCalls=1）。
- Y4：0 SideEffectCall / 0 mutation / 无自动重试。
- Y5：**Renderer `data-ai-status=BLOCKED` 且 Run 复位（busy=false）** → 预算停止的 **UI 一致性已在 Electron 实测通过**。

**执行异常 X1–X7（全 PASS）**：真实 WRITE proposal 到 AWAITING_APPROVAL 后，用产品 API `resourceService.replaceText`（受控同步点，非固定延时）把 Domain version 改走 → 真实 Approve → 受控执行**真实发生并失败**。
- X3：Task/Step/Run BLOCKED；X4：0 Artifact / 0 Verification（不适用）；X5：0 mutation，call `FAILED` / `errorCode=SIDE_EFFECT_DOMAIN_WRITE_FAILED`，受控执行恰好 1 次（executor evidence 4→5），0 active lease；X6：无自动重试（1 条 call）；X7：UI BLOCKED + Run 复位。

**预算 Node 测试 `tests/d4-06-budget.test.mjs`（6/6 PASS，真实产品 `TaskHarnessOrchestrator`，无手工 blockStep）**：
1. 轮次预算：`proposeSequence=5` → 恰好 4 次 execution = `MAX_TOOL_ROUNDS`、4 个 proposal、5 次 model prompt（初始 1 + bounded 4，无第 5 轮后 prompt）；Task/Step BLOCKED、run 非 RUNNING 且 error_code=`TOOL_EXECUTION_NOT_AVAILABLE`；已发生 4 条 execution 保留且归属正确；0 Artifact；AUTO_RETRY=0。
2. 调用预算边界：`facadeMaxCalls=2` + plan(9) → `bridge.stats.calls=2`、Domain 执行数=2、capability `calls=2/maxCalls=2`；第 3 个 tool call 的 tool result 含 `TOOL_CAPABILITY_EXHAUSTED`；Task BLOCKED、0 Artifact。重复请求不二次消耗预算复用既有单元证据（`tests/tool-d4-03d-closure.test.mjs` / `tests/tool-dsh-security.test.mjs`，未重造）。
3. 保留产物：step1 真实 WRITE 成功（Artifact+Verification，checksum 匹配，resource 真 trashed，lease 已释放）→ step2 轮次预算停止 → step1 产物/副作用保留、归属正确，step2 0 Artifact、恰好 4 execution；**不补发第二个 SideEffectCall、不回滚已提交副作用**。
4. 执行异常（Domain 抛错）：execution `FAILED` / `TOOL_EXECUTION_FAILED` → Task/Step BLOCKED，0 Artifact/Verification/SideEffectCall，恰好 1 次执行。
5. 执行异常（目标不存在）：`resource://res_d4_06_missing` → proposal `DENIED / RESOURCE_NOT_AVAILABLE` → Task/Step BLOCKED，0 execution / 0 Artifact / 0 mutation。
6. `orchestrator.resume()` 仍返回 `EXPLICIT_RESUME_DEFERRED`。

**已发出在途 vs 尚未开始**：预算停止前已提交的副作用/产物**保留**；尚未开始的下一步（第 5 轮 operation）**不执行**；停止**不回滚**已发生副作用（未作回滚声明）。

## 5. 实际命令与环境（被测 commit `17df98e`，干净代码）

| 命令 | 结果 |
| --- | --- |
| `npm run test:d4-04`（共享 probe，含 L/X/Y） | **94/94**，exit 0（原 67 + D4-06 新增 27） |
| `npm run test:d4-06` | **100/100**（Electron 94 + 预算 6），exit 0 |
| `npm run test:d4-02c` | 22/22 PASS |
| `npm run test:d4-03d` | 52/52 PASS |
| `npm run test:d4-03d-closure` | 62/62 PASS |
| `npm run test:d4-03c4` | 35/35 + UI 22/22 PASS |

环境：Electron 44.3.0 / darwin arm64 / Electron 内建 Node 24.20.0；`officialDsh=true`、`dshVersion=0.1.5-rc.2`、`acpVersion=1.4.0`；rendererConsoleErrors / mainUnhandledErrors / secretHits = 0。

## 6. 证据与可追溯性

- `docs/D4-06-GATE-EVIDENCE.json`（tracked，脱敏）：`testedCommit=17df98e…`、逐条 `{name, expected, actual, ok}`（100 条）、env、command、`artifactSha256=f4cd1547fafe98134c6a05fd85592d5982a3dfbf22827bce42926dab3eb7f68e`。
- 原始 artifact：`artifacts/d4-04/vertical-smoke-gate.json`（Electron，sha256=`5c0dcc5bafe14ec967452a964510889fa4149a2be299a9cb59e4e756e6bbf37a`）、`artifacts/d4-06/budget-tests.tap`。
- `docs/D4-04-GATE-EVIDENCE.json` 已刷新为共享 probe 的 94/94（`testedCommit=17df98e`，`workspaceState=""`）；D4-04 原有 67 项全部保留 PASS（增量、非回归）。
- `test:d4-06` 的运行前 `workspaceState` 如实记录为 `M docs/D4-04-GATE-EVIDENCE.json`：这是**同一被测 commit 上**上一轮 gate 刷新生成的证据文件，**代码零改动**；D4-06 的全部断言执行的都是提交后的 `17df98e` 代码。
- 证据已扫描：无 `/Users`、`/private`、`/var/folders`、`mpx_`、`tpx_`、credential。

## 7. 未满足 / 无法验证 / 范围冲突（影响结论）

1. **A35 “明确续接入口” = NOT delivered（范围冲突）**：`task-harness-orchestrator.cjs` `resume() → {ok:false, error:"EXPLICIT_RESUME_DEFERRED"}`；`TASK_COMMANDS` 白名单无 resume；Renderer `src/` 无 resume/续接入口。与既有 `Explicit Resume = DEFERRED` 冲突。**未实现 resume、未判定通过**；需 Boss/审计裁定该 clause 是否以“保留产物 + 不展示无效入口”视作满足。
2. **单次受控 tool 失败不直接阻断 Task（产品语义观察）**：facade 契约下，受控 tool 失败/目标不存在以 error tool result 回 Harness，dsh 仍可产出 final → Task 可能 SUCCEEDED。Electron 侧改用“真实受控执行失败”（version 变化 → execution FAILED → BLOCKED）证明执行异常收敛；非 facade Node 侧证明 READ 缺失/Domain 抛错 → BLOCKED。若产品要求 tool 失败即 block，需在 orchestrator facadeMode 增加对 `tool_executions FAILED/DENIED` 的终态判定——**属产品语义变更，本轮未擅自实现**，列为最小修复建议。
3. **真实 `electron/main.cjs` 全流程 = NOT VERIFIED**：D4-06 复用 D4-04 probe（真实 Electron + 产品 preload/dist Renderer + 共享 production boot/orchestrator），非真实 main.cjs 端到端。
4. **executor-unavailable 的上层验证口径**：为 **`TaskService` 合同验证**（`blockStep`+`blockHarnessRun`，orchestrator 使用的同一合同），**不是**完整 orchestrator 实测。
5. 其余仓库级限制保持原状：OS-level network sandbox / external workspace read audit / independent malformed ACP injection / Windows / External Provider = NOT VERIFIED；Explicit Resume = DEFERRED；broader Domain verifiers = NOT VERIFIED；authenticated durable cross-restart process-death proof = DEFERRED / NOT VERIFIED。

## 8. 推荐（唯一）

**不进入 D4-05**（D4-05 依赖 D4-06）。先由 Boss/审计裁定 A35 “明确续接入口” clause：**关闭 Deferral 并为 D4-06 补一个受控续接入口**，或**明确以“保留产物 + 不展示无效入口”收口并据此把 D4-06 记为 PASS**。在此之前 D4-06 保持 **PARTIAL**。

## 9. 诚实边界

- 关联链与预算停止均为 worktree 内真实 Electron / Node 运行结果；停止全部由产品 orchestrator 自己触发，无手工 `blockStep`/`blockHarnessRun`、无造假 Artifact/Verification、无固定 sleep 碰运气。
- “测试环境等价”不等于“真实 `electron/main.cjs` 全流程已实测”。
- 预算停止不回滚已发生副作用；已发出在途与尚未开始的操作已明确区分。
