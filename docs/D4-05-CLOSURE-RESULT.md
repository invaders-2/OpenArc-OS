# D4-05 Closure · A33 正式链「拒绝假成功」修复与证据

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`；分支：`feature/d4-03-tool-proxy`
- Base HEAD（本轮起点，干净）：`f481ffe1c002d658288d415550fce2c65fb90ef7`
- **代码与测试被测 commit**：`70eb0b12167e513bb4eb7fa1cb4efb9ca70e509d`（8 files, +365/−23，仅 source + tests）
- **报告与证据提交**：本文件 + `docs/D4-05-RESULT.md`、`docs/D4-ACCEPTANCE-RESULT.md`、`PROGRESS.md`、`docs/D4-04/05/06-GATE-EVIDENCE.json`
- 范围：只补齐本轮报告暴露的差异——**official dsh facade 正式链下，READ_ONLY 必需产物验证失败不会阻断 Step/Task**（A33）。不实施 memory 装配、不进入 D5/D6、不扩展真实工具面、不新增自动重试、不放宽既有检查。
- **结论：S1（A33）以 official dsh facade 正式链证据为准 = PASS**；S2/S3 = PASS；S4 = PARTIAL（记忆上下文链缺口不变）→ **`D4-05 = PARTIAL`、`D4 = PARTIAL`** 不变；**D4-06 通过范围不扩大**（仍为“限定当前验收范围”）。

## 1. 根因（正式链差异）

`electron/task-harness-orchestrator.cjs` 的 `runStep` 在 `info.toolExecutionMode === "facade"` 时，READ_ONLY 工具由 **official dsh 进程内**经 `ToolFacadeBridge → ControlledToolProxy.executeReadOnly` 执行：

- proxy 已如实落 `tool_executions.status=FAILED / verification_status=FAIL / error_code=TOOL_VERIFICATION_FAILED`，并调用 `TaskService.recordVerificationFailure` 落 1 条 `task_verifications` FAIL（`artifact_id=null`），错误回给 dsh；
- 但 orchestrator 的 facade 分支只处理 WRITE proposal 与最终 `final text` verification，**从不检查上述后端产物验证记录**。

因此当 deterministic provider / 模型在工具失败后仍输出“完成”文本时，orchestrator 直接 `commitStepSuccess`：**Task SUCCEEDED + 1 Artifact，而必需产物的 FAIL 未解决**——违反 A33（工具报告成功但产物不符，任务不得标成功）。这解释了“失败验证 UI 在 fallback 链通过、正式链不阻断”的差异：D4-08 旧探针走 synthetic ACP fallback，避开了该缺口。

**修复前（正式链复现，test-only `test.sized`：execute 报告成功 size=7，verify 期望 10）**

```
ok=true  task=SUCCEEDED
execs=[{status:FAILED, verification_status:FAIL, error_code:TOOL_VERIFICATION_FAILED}]
verifications=[{type:ADAPTER_VERIFY,status:FAIL,artifact:null}, {type:EXACT_TEXT,status:PASS,artifact:art_…}]
artifacts=1
```

## 2. 最小修复（按 A33 区分普通工具错误与必需产物验证失败）

判据来自**后端契约记录**，不信任模型自述：

1. **必需产物验证失败** = tool execution 报告成功但后端 verifier 判失败：`execution.verification_status === "FAIL"`（即 `OUTPUT_SCHEMA` / `ADAPTER_VERIFY`）。
2. **普通工具调用错误**（DENY / execute 抛错 / BLOCKED / NOT_EXECUTED，`verification_status` 为空）不计入，**不因新闸门整体判失败**——保持 facade 既有语义（工具失败以 error tool result 回 Harness，模型可继续）。
3. **有限纠错**：同一 `tool_id` 之后出现真实 verify PASS 的 execution → 该失败已解决；**旧 FAIL 记录绝不删除、绝不改写**，也不因历史 FAIL 永久禁止成功。本轮**未新增自动重试**——纠错仍由模型在既有 bounded 预算内驱动；未真正复验通过则走**明确停止路径**（Step/Task BLOCKED、0 Artifact、如实报 `TOOL_VERIFICATION_FAILED`）。
4. 预算约束、权限检查、`UNKNOWN_EFFECT` 禁止重放规则**保持不变**。

实现：

- `electron/task-domain.cjs`：`ERROR` 新增 `TOOL_VERIFICATION_FAILED`（停因码；事件 `TASK_EVENT.TOOL_VERIFICATION_FAILED` 原已存在）。
- `electron/task-service.cjs`：新增只读 `getUnresolvedRequiredVerificationFailures({context,taskId})`——identity/app guard 后按 `tool_id` 的**最近一次验证结论**判定（仅 FAIL/PASS 的 execution 参与；普通错误不改结论），返回尚未解决的 `{toolId, executionId, errorCode, method}`。无副作用、不删改历史。
- `electron/task-harness-orchestrator.cjs`：`runStep` 在 final-text verification 通过后、`commitStepSuccess` 前插入 A33 闸门；存在未解决 FAIL 即 `#blockStep(TOOL_VERIFICATION_FAILED)` 并落 `tool.verification.failed` 事件（payload 只含 toolId/executionId/errorCode/method/计数）。未改 `facadeMode` 判定与其它分支。

**修复后（同一正式链）**：`ok=false / error=TOOL_VERIFICATION_FAILED / Task·Step BLOCKED / 1 execution FAIL·FAIL / 1 条 FAIL Verification / 0 Artifact`。

## 3. 修改文件（被测 commit 70eb0b1）

- 生产：`electron/task-domain.cjs`、`electron/task-service.cjs`、`electron/task-harness-orchestrator.cjs`。
- 测试：`tests/d4-05-s1-facade-a33.test.mjs`（新，5 项）、`tests/d4-05-smoke.mjs`（NODE_FILES 纳入新测试）、`tests/fixtures/d4-08-verification-ui/main.cjs`（探针切正式链）、`tests/d4-08-verification-ui.mjs`（gate 元数据）、`tests/fixtures/d4-04-provider.mjs`（新增可选 `finalText` 与 `sized` 模式，既有模式默认行为不变）。

## 4. 检查结果（均在 `70eb0b1`；工作区为干净版本，首条 smoke / UI 探针 `workspaceState=""`）

| 命令 | 结果 | exit |
| --- | --- | --- |
| `node --test tests/d4-05-s1-facade-a33.test.mjs` | **5 / 5 PASS**（真实 official dsh，非 fallback） | 0 |
| `node --test tests/d4-05-s1-output-size.test.mjs tests/d4-07-verification-persistence.test.mjs` | 8 / 8 PASS | 0 |
| `npm run test:d4-03b-dsh` | **26 / 26 PASS** | 0 |
| `npm run test:d4-05` | **133 / 133 functional PASS**；`overallStatus=PARTIAL`；S1/S2/S3=PASS、S4=PARTIAL；`workspaceState=""` | 0 |
| `npm run test:d4-04` | **94 / 94 PASS** | 0 |
| `npm run test:d4-06` | **119 / 119 PASS** | 0 |
| `npm run test:d4-06-resume` | **21 / 21 PASS** | 0 |
| `npm run test:d4-08-verification-ui` | **22 / 22 PASS**（正式链；`officialDshFacade=true`） | 0 |
| `npm run test:d4-08` | 13 / 13 PASS | 0 |
| `npm run test:d4-02c` | 22 / 22 PASS | 0 |
| `npm run test:d3-05` | 13 / 13 PASS | 0 |
| `npm run test:d4-03c4` | Node 35 / 35 + UI 22 / 22 | 0 |
| `npm test` | **963 / 963 PASS**（958 基线 + 新增 5） | 0 |

渲染/主进程 console error、unhandled、secret hit 均为 **0**。

## 5. 正式链证据要点

- **Node 正式链（`tests/d4-05-s1-facade-a33.test.mjs`，5 项）**：① 负例（provider 宣称完成后拒绝假成功）；② 正对照（尺寸符合 → SUCCEEDED + 1 Artifact + 1 PASS Verification 绑定）；③ 有限纠错（首次 FAIL 后同 tool 真实 PASS 才成功，旧 FAIL 仍在）；④ 普通 READ 错误不整体失败；⑤ 同盘 DB 重开拒绝证据可追溯。
- **Electron UI 正式链（`npm run test:d4-08-verification-ui`，22/22）**：`chain.mode = official-dsh-facade+product-orchestrator+controlled-tool-proxy`、`officialDshFacade=true`；Task/Step BLOCKED、0 Artifact、1 条 FAIL Verification（`ADAPTER_VERIFY`，expected `{expectedSize:10,actualSize:7}` / actual `{label:"box",size:7}`）；真实 Renderer 显示 `data-ai-verification`「验证失败」+ 证据引用且**不显示成功**；Reload 后一致（来自 `task/get`，不依赖 Renderer 内存）；非 owner 读 `verification/task/artifacts` 一律 `TASK_FORBIDDEN`、UI 不可见。
- 证据文件：`docs/D4-05-GATE-EVIDENCE.json`（133 条，`artifactSha256=4087c5c6…23fc`；S1 共 8 条=3 旧 fallback + 5 新正式链）；`docs/D4-04-GATE-EVIDENCE.json`（94 条，`8872c957…7b27`）；`docs/D4-06-GATE-EVIDENCE.json`（119 条，`114383a2…7ff2`）。原始 UI artifact（gitignored）`artifacts/d4-08-verification-ui/verification-ui-gate.json`（`artifactSha256=163e4376…a255`）。
- 已脱敏：无 `/Users`、`/private`、`/var/folders`、`mpx_`、`tpx_`、credential。

## 6. 与 A33 逐条对应

| A33 要求 | 本轮结果 |
| --- | --- |
| 工具报告成功但产物不符，任务不得标成功 | 正式链已阻断（负例 BLOCKED / 0 Artifact / 无 `task.succeeded`） |
| 应有限纠错或报告验证失败 | 保留既有 bounded 模型驱动纠错；未真正复验通过 → 明确停止 `TOOL_VERIFICATION_FAILED`，未新增自动重试 |
| 纠错后需新的实际验证通过且可关联 | 同 tool 后续真实 PASS 的 execution 才解除；旧 FAIL Verification 保留并关联首个 execution；PASS Verification 绑定新 Artifact |
| 不因历史 FAIL 永久禁止成功 | 以“最近一次验证结论”判定，后续 PASS 即解决 |
| 普通探索性 READ 失败不一刀切 | 仅 `verification_status=FAIL` 参与；执行错误/DENY 不变 |
| 保留预算/权限/UNKNOWN_EFFECT | 未改动；既有回归全绿 |

## 7. 剩余限制

1. **S4 = PARTIAL 不变**：`buildPrompt` 无 memory 检索/装配入口，“请求体不含记忆”仍是空验证；**本轮不实施 memory 装配**。故 `D4-05 = PARTIAL`、`D4 = PARTIAL` 维持。
2. **D4-06 通过范围不扩大**：仍为“限定当前验收范围”；本轮未改 D4-06 判定。
3. 继承的 NOT VERIFIED 不扩大：真实 `electron/main.cjs` 全流程（Gate 用 probe host + 共享 production boot/Renderer/orchestrator）、真实外部 provider / 真实凭据、Windows、OS 级网络沙箱；Explicit Resume 其它场景仍 DEFERRED。
4. 跨 run 的“历史 FAIL 在后续 run 被真实 PASS 解决”由同一套 task 级判据覆盖，但本轮未单独 e2e 构造；与“不永久禁止成功”语义一致。
5. 未新增付费服务、未接真实外部 provider、未改默认 d3-02 工作区、未 push、未合并 main。
