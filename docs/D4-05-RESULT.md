# D4-05 执行关卡 · 结果记录（父级定稿）

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`；分支：`feature/d4-03-tool-proxy`
- Base HEAD（本轮起点，干净）：`a7faf060bb4b2371fdfa379118b2d9011ba7b412`
- **被测 commit**（D4 收口修复后重跑）：`ec7a732aa78ffc52e8e0ce3b4d1e09108f604dc4`（D4-05 实现 `83baad6`、审查补测 `431395d`）
- **D4-05 Closure 代码与测试被测 commit**：`70eb0b12167e513bb4eb7fa1cb4efb9ca70e509d`（A33 正式 official dsh facade 链闸门；详见 `docs/D4-05-CLOSURE-RESULT.md`）
- **D4-05 Closure-2 代码与测试被测 commit**：`77b6e857f3d5a9781ea2c218e89069b1802aaab4`（解决关联改按 (tool_id, canonical arguments)；详见 `docs/D4-05-CLOSURE2-RESULT.md`）
- Final HEAD：本轮报告/证据提交（见文末）
- 范围：只补齐 PLAN.md §41 的 D4-05 四场景（产物不符 / 结果未知 / 用量到限 / 记忆越权）；第二轮按父级指示补齐 S2 的**最小人工确认入口**以闭合 §384。不扩展真实工具面、不放宽既有检查、不 commit、不 push。
- **结论：`D4-05 = PARTIAL`**——S1/S2/S3 = PASS；**S4 = PARTIAL**（检索链 PASS、上下文链 NOT VERIFIED：无 memory→任务上下文装配入口，A36 的上下文链为空验证，见 §3/§5）。其余场景 PASS 结论不变。**S1（A33）结论以 D4-05 Closure 的 official dsh facade 正式链证据为准**（见 §7 与 `docs/D4-05-CLOSURE-RESULT.md`）。

## 1. 要求对应表

| 场景 | 原文要求 | 产品入口 | 预期产物 | 停止条件 | 验证方式 | 复用的既有证据 | 需最小补齐项 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1 产物不符（A33） | 工具报告成功但产物尺寸不符，任务不得标成功，应有限纠错或报告验证失败 | `TaskHarnessOrchestrator.runTask` → `ControlledToolProxy.propose/executeReadOnly` → `registry.validateOutput` + `adapter.verify` | 负例：0 Artifact、1 FAIL Verification（v15，含 method/expected/actual/证据）；正对照：1 Artifact + 1 PASS Verification 且互相绑定 | execution `FAILED`/`TOOL_VERIFICATION_FAILED`、`verification_status=FAIL`、Step/Task `BLOCKED`、0 第 2 个 proposal/execution | `tests/d4-05-s1-output-size.test.mjs`（真实 registry/proxy/adapter 链，仅测试内注册 test-only `test.sized`） | `controlled-tool-proxy.cjs` 既有 verify 失败分支；D4-06 执行异常/0 重试语义 | 新增 test-only `test.sized`（期望尺寸 vs 实际尺寸）+ adapter，只在测试内注册 |
| S2 结果未知（§383/384） | 目标应用不支持幂等时用可验证产物或操作状态核查；无法核查则标记结果未知；结果未知提供检查实际应用、关联产物和人工确认入口，不能直接显示成功或安全重试 | 真实受控 WRITE + 真实存活 executor（quiescence 不可证）→ `recoverOnStartup` 落 UNKNOWN_EFFECT；`TaskService.getRecoveryState` + `task/recovery`/`task/get.recovery` + `task/acknowledgeUnknownEffect` + AI 面板 `data-ai-recovery`/`data-ai-acknowledge` | Call 持久化 `UNKNOWN_EFFECT`；Task/Step `BLOCKED`；只读 recovery 投影含 call/status/errorCode/核查结论/关联产物/resumable=false；确认只追加一条 safe event | `RESUME_UNKNOWN_EFFECT_PRESENT` 拒绝续接；`AUTO_RETRY=0`；确认后 call/step/task 状态不变 | Node 真实 live-executor 路径 + `tests/d4-05-recovery-ui.mjs`（真实 Electron UI）+ `tests/d4-04-smoke.mjs` F1/F3/F5/F6/F7 | D4-03C3/C4 UNKNOWN_EFFECT；D4-06 Closure `RESUME_UNKNOWN_EFFECT_PRESENT` | **已补齐**：只读 recovery 投影 + acknowledge 命令 + UI（见 §2） |
| S3 用量到限（A35） | 任务达到预算上限，停止自动循环并保留产物及明确续接入口 | 真实 orchestrator bounded 预算 + `TaskService.getResumeEligibility/getBudgetLedger/grantBudgetResume` | `task.budget_exhausted{kind,consumed}`；已发生 Artifact 保留；显式续接产生新 bounded step/run | `BUDGET_EXHAUSTED`；`AUTO_RETRY=0`；续接总数 ≤ `MAX_BUDGET_RESUMES=3` | `tests/d4-05-s3-budget-ledger.test.mjs` + `tests/d4-06-budget.test.mjs` + `tests/d4-06-resume.test.mjs` | D4-06 + D4-06 Closure | 修正 `ledger.consumed.modelCalls` 语义（→ `modelCallEnvelopes`） |
| S4 记忆越权（A36） | 用户删除个人记忆并切换账号，检索与新任务上下文均不出现已删或他人内容 | `resourceService`（`memory` subtype）+ `searchService` + 真实 `TaskHarnessOrchestrator` | 检索链：alice 可见自己的 memory；删除后不可见且索引文档移除；dana/新 session 检索不到他人内容。上下文链：任务 model 请求体不含任何 memory token（但 `buildPrompt` 无 memory 装配入口，属空验证） | 检索链负向要求满足；上下文链未接入 → **NOT VERIFIED**，不得据此声称记忆注入隔离 | `tests/d4-05-s4-memory.test.mjs` + 既有 `tests/d3-05-data-gate.test.mjs`、`tests/governance-memory.test.mjs` | `authorization-domain.cjs` §25；`search-service.cjs` 授权过滤与 `indexResource` 删除；d3-05 Gate-Search/Gate-Lifecycle | 无（检索链新增端到端 body 捕获）；**缺口**：无 memory→任务上下文装配入口，上下文链 **NOT VERIFIED**（S4 = PARTIAL） |
| A37 / A38 | PS 部分完成 / 画布并发冲突 | — | — | — | — | — | **未纳入**：不在 PLAN §41 的 D4-05 四场景内，不自行替换进来 |

## 2. 被测行为与最小改动

- **S1**：只新增测试内 `test.sized` tool（`expectedSize` 输入、`size` 输出）与 `testSized` adapter；负例让 `execute` 报告成功但产出尺寸不符，`adapter.verify` 独立核对后 FAIL。生产 Registry / adapter allowlist 零改动。
- **S2（本轮补齐，fail-closed）**：
  - `electron/task-domain.cjs`：新增事件 `tool.side_effect.unknown_effect.acknowledged`（只作 safe 记录）。
  - `electron/task-service.cjs`：新增**只读** `getRecoveryState`（仅 task BLOCKED + 存在 UNKNOWN_EFFECT call 时 applicable；投影 callId/toolId/status/errorCode/recoveryResult/关联 Artifact(artifactId/type/checksum)/acknowledged/resumable=false，全程不改状态）+ `acknowledgeUnknownEffect`（仅对本 task 的 UNKNOWN_EFFECT call 追加一条 safe event；幂等；绝不改 call/step/task 状态、绝不授权 resume/retry/replay）。
  - `electron/task-bootstrap.cjs`：`task/get` 返回 `recovery` 投影；新增命令 `task/recovery`、`task/acknowledgeUnknownEffect`（身份/session/app 仍由主进程注入并校验）。
  - `src/desktop/components.tsx`：BLOCKED 且 recovery.applicable 时渲染 `data-ai-recovery`（停止原因/实际状态/核查结论/关联产物）+ `data-ai-acknowledge`；点击后显示 `data-ai-acknowledged`「已人工确认」；**不**出现 Success/Retry/Resume 入口（resumable=false）。
  - `tests/fixtures/harness-acp/tool-harness-fixture.mjs`：新增可选 `sideEffectExecutorTestHook`（test-only，production 默认 null）。
- **S3**：唯一行为外改动 `electron/task-service.cjs`：`consumed.modelCalls` → `consumed.modelCallEnvelopes`（`consumedAtGrant` 同步），明确它统计 `task_model_calls`（每个 step/run 一个模型调用信封），不是逐 provider 请求；逐请求真实 bounded 消耗只由 Model Proxy capability 计量、停止时记录在 `budgetStops`。
- **S4**：无生产代码改动。

## 3. 逐场景结果（expected / actual）

| 场景 | expected | actual | 结果 |
| --- | --- | --- | --- |
| S1 负例 | execute 成功但尺寸 7≠10 → verify FAIL → execution FAILED/TOOL_VERIFICATION_FAILED、verification_status=FAIL、Task/Step BLOCKED、0 Artifact、**1 FAIL Verification（v15：method/expected/actual/executionId，跨重开可查）**、恰 1 proposal/execution | 断言全成立 | **PASS** |
| S1 正对照 | 尺寸 10=10 → Task SUCCEEDED、1 Artifact（task/step/run 归属 + checksum==sha256(content)）+ 1 Verification 绑定同一 Artifact | 断言全成立 | **PASS** |
| S2 投影 | UNKNOWN_EFFECT task 的 recovery 投影含 call 与关联产物，resumable=false | `applicable=true`、call status=UNKNOWN_EFFECT、errorCode 有值、recoveryResult 三态或「尚无结论」、关联产物含 Artifact、`resumable=false`/`RESUME_UNKNOWN_EFFECT_PRESENT`；只读不改状态 | **PASS** |
| S2 确认 | ack 只追加 safe event；call 仍 UNKNOWN_EFFECT、Task 仍 BLOCKED、仍不可续接、0 第二 call/lease/retry | event=1（含 callId+operatorUserId、脱敏）、call 仍 UNKNOWN_EFFECT、Task/Step 仍 BLOCKED、`RESUME_UNKNOWN_EFFECT_PRESENT`、0 第二 call/lease、幂等重复确认不追加 | **PASS** |
| S2 UI | 真实 Electron：recovery 区块可见 + 人工确认 + 无 Success/Retry/Resume | `S2-UI-4` 显示「实际状态：UNKNOWN_EFFECT · 核查结论：尚无结论 / 关联产物：art_…（text）」；`S2-UI-5` 无 resume/retry；`S2-UI-6` 点击后显示「已人工确认」；`S2-UI-7` ack 后 call/task 状态不变、仍不可续接 | **PASS** |
| S3 | 到限停止 + 保留产物 + 续接；additions.amount == 新一轮真实 capability；历史保留、base 不重置、总数 ≤3 | `task.budget_exhausted{consumed:8,maxCalls:8}`；additions.amount=8==新 capability maxCalls；base 恒 {8,8,4}；budgetStops 历史保留；第 4 次 `RESUME_LIMIT_REACHED` 且 0 追加 | **PASS** |
| S4 | 检索链：alice 可见 → 删除后不可见 + 索引移除；dana 检索不到他人/已删。上下文链：任务上下文不出现已删/他人 memory | 检索链正负对照全部成立；任务 body 无 memory token 属“无装配入口”的空验证（`buildPrompt` 只含 goal + safe step input + prior artifact），不能证明记忆注入隔离 | **PARTIAL**（检索链 PASS；上下文链 NOT VERIFIED——无 memory→上下文装配入口；当前无泄漏路径，见 §5） |

## 4. 实际命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run test:d4-05` | **128 / 128 PASS**（Node 23 + D4-04 Electron 94 + S2 recovery UI 11），exit 0，`overallStatus=PARTIAL`（`functionalStatus=PASS`；S1/S2/S3=PASS、S4=PARTIAL） |
| `node --test tests/d4-06-resume.test.mjs` | **6 / 6 PASS**（含真实 live-unlinked UNKNOWN_EFFECT → `RESUME_UNKNOWN_EFFECT_PRESENT`） |
| `npm run test:d4-04` | **94 / 94 PASS** |
| `npm run test:d4-06` | **106 / 106 PASS** |
| `npm run test:d4-06-resume` | **19 / 19 PASS** |
| `npm run test:d3-05` | **13 / 13 PASS** |
| `npm run test:d4-03c4` | **35 / 35 PASS** + 真实 UI 22 / 22 |
| `npm run test:d4-03d` | **52 / 52 PASS** |
| `npm run test:d4-02c` | **22 / 22 PASS** |

环境：Electron 44.3.0 / Node 24.20.0（Electron 内建）/ darwin arm64；Node 实验链 Node v22.22.3；`rendererConsoleErrors` / `mainUnhandledErrors` / `secretHits` = 0。

## 5. 未满足 / 缺口 / 不适用

1. **S2 = PASS（§384 人工确认入口已闭合）**：只读 recovery 投影 + 人工确认事件 + 真实 UI 入口均已实现并验证；确认动作绝不改变 authority 状态、绝不授权 resume/retry。
2. **S4 = PARTIAL（检索链 PASS；上下文链 NOT VERIFIED）**：`buildPrompt` 只含 goal + safe step input + prior artifact，**没有** memory 检索/装配入口。检索链（删除前可见 / 删除后不可见 + 索引移除 / 跨账号不可见）正负对照全部成立；「新任务上下文不出现已删/他人内容」在没有注入入口时是**空验证**——只能说明当前无泄漏路径，不能证明“具备记忆注入时的上下文隔离”。因此 **`D4-05 = PARTIAL`**。最小后续方案（本轮不改产品）：先新增受控 memory 检索/装配入口，再以正负对照重新验证上下文隔离（授权记忆可见且注入；已删/他人记忆不出现），通过后再将 S4 升为 PASS。
3. **A37 / A38 未纳入**：不在 PLAN §41 的 D4-05 四场景内。
4. **继承的 NOT VERIFIED（未扩大）**：真实 `electron/main.cjs` 全流程（Gate 用 probe host + 共享 production boot/Renderer/orchestrator）；真实外部 provider / 真实凭据；Windows；OS 级网络沙箱。
5. **范围冲突 / 未授权项**：无。未新增付费服务、未接真实外部 provider、未改默认 d3-02 工作区、未 commit。

## 6. 证据

- `docs/D4-05-GATE-EVIDENCE.json`（tracked、脱敏）：`testedCommit` / 运行前 `workspaceState` / `command` / `env` / 逐条 `{name,expected,actual,ok}`（128 条：S1 3 / S2 22 / S3 14 / S4 2 / REUSE_D4_04 87）/ `scenarioStatus` / `gaps` / `sourceArtifacts`（含 SHA-256）/ `artifactSha256`。
- `artifactSha256 = 01e3d3ef01fcf0cfd2968addf7031af2105d6c24ad207b624ca62371f392e78a`（testedCommit `ec7a732`，运行前 `workspaceState=""`；Node 23 / D4-04 Electron 94 / recovery UI 11 = 128，全 true）。
- 原始 artifact（gitignored）SHA-256：`artifacts/d4-04/vertical-smoke-gate.json=2276cd72ac47d075483bb8d8cca4649bbb2c78d4faf5bfbf4842d75c103edbee`；`artifacts/d4-05/node-tests.tap=b46cee10418e0c4d258e41a4f248abc95165a3cb1916de1a63db558cecb097d3`；`artifacts/d4-05-recovery/recovery-ui-gate.json=2353b8af9eef75adf358bd3e8fd64b9d6c763b20a08f02af51ddf9eec05427f0`。
- 已脱敏：无 `/Users`、`/private`、`/var/folders`、`mpx_`、`tpx_`、`credential`。

## 7. D4-05 Closure · A33 正式链（本 Closure 更新，取代 S1 的 fallback 限定）

- **代码与测试被测 commit**：`70eb0b12167e513bb4eb7fa1cb4efb9ca70e509d`（Base HEAD `f481ffe`，干净）。
- 根因：`task-harness-orchestrator.cjs` 的 facade 分支只处理 WRITE proposal 与 final text verification，不检查 dsh 进程内经 `ToolFacadeBridge → ControlledToolProxy` 落下的 `verification_status=FAIL` 记录 → 模型输出“完成”即可假成功。
- 修复：`TaskService.getUnresolvedRequiredVerificationFailures`（只读、按 `tool_id` 最近一次验证结论判定、旧 FAIL 不删改、后续真实 PASS 即解决）+ orchestrator 在 `commitStepSuccess` 前插入 A33 闸门（未解决即 `#blockStep(TOOL_VERIFICATION_FAILED)`、0 Artifact、无自动重试）。普通工具调用错误（`verification_status` 为空）不参与判定。
- 正式链证据：`tests/d4-05-s1-facade-a33.test.mjs` **5/5**（真实 official dsh，负例/正对照/有限纠错/普通 READ 错误/跨重开持久化）；`npm run test:d4-08-verification-ui` **22/22**（`officialDshFacade=true` 的真实 Electron UI：BLOCKED/0 Artifact/1 FAIL Verification、刷新一致、非 owner 不可读）。
- 回归：`npm run test:d4-05` **133/133 functional（S1/S2/S3=PASS、S4=PARTIAL）**；`test:d4-04` 94/94、`test:d4-06` 119/119、`test:d4-06-resume` 21/21、`test:d4-03b-dsh` 26/26、`npm test` 963/963。
- 详细根因/改动/逐条检查/限制见 `docs/D4-05-CLOSURE-RESULT.md`。

## 8. D4-05 Closure-2 · 失败验证的解决关联修正（`77b6e857f3d5a9781ea2c218e89069b1802aaab4`）

- **漏洞**：Closure-1 的 `getUnresolvedRequiredVerificationFailures` 按裸 `tool_id` 的“最近一次验证结论”判定解决——同一工具对象 A FAIL、对象 B PASS 时，B 的无关 PASS 会误清除 A 的 FAIL，导致假成功（正式链已复现：Task SUCCEEDED + 1 Artifact，同时 A 的 FAIL 未解决）。
- **修复**：关联键改为 `(tool_id, canonical arguments)`（`task_tool_proposals.arguments_hash`）；只有**同一操作对象 + 同一验证要求**的真实复验 PASS 才算解决；顺序敏感（FAIL→PASS→FAIL 仍未解决）；缺 `arguments_hash` 的旧数据用 execution 唯一键保守保持未解决；返回 `resolved` 关联证据；原始 FAIL 绝不删改。
- **正式链证据（Closure-2）**：`tests/d4-05-s1-facade-association.test.mjs` **6/6**（无关对象/无关要求/无关 Step 不误清除、有效纠错可成功并关联、DB 重开一致、普通错误语义不变）；`npm run test:d4-05` **139/139 functional（S1/S2/S3=PASS、S4=PARTIAL）**；`test:d4-08-verification-ui` 22/22 无回归；`test:d4-04` 94/94、`test:d4-06` 119/119、`test:d4-06-resume` 21/21。
- **支持范围（如实）**：产品未区分“必需/探索”工具契约；`verification_status=FAIL` 仅由“工具 `execute` 成功但 `OUTPUT_SCHEMA`/`ADAPTER_VERIFY` 失败”写入（DENY/执行错误不参与判定）。跨 run/跨 step 无可达纠错入口，未新增恢复能力。
- 详见 `docs/D4-05-CLOSURE2-RESULT.md`。
