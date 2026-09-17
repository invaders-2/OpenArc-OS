# D4 阶段收口审查与修复 · 结果记录（Acceptance Review + Closure Fix）

- 审查 Base HEAD：`6fb68377dfe5d1eefae6b951cd89c540f2abaa51`
- 审查轮被测 commit：`431395dfe79afec8b4d9370a51b147b46b3e695c`
- 收口修复（预算/失败验证）被测 commit：`ec7a732aa78ffc52e8e0ce3b4d1e09108f604dc4`
- **D4-06 Closure 被测 commit（跨 run 累计预算 + 失败验证 UI）：`7b53458ef1611c08ab96679eab6377d1c4d0e342`（test-seed 修复 `fbbc002d1103b459b46f55172cd139345176b098`）**
- Final HEAD：本轮报告/证据提交（见文末）
- 分支：`feature/d4-03-tool-proxy`；工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`；未 push、未合并 main；默认 d3-02 工作区未触碰

## 0. D4 整体结论

**D4 = PARTIAL（macOS 核心基本完成，非整体完成）**。

- D4-01 macOS Core、D4-02 macOS Task/Harness Core、D4-03（PASS candidate）、D4-04、D4-06 在各自声明范围内通过；D4-05 = **PARTIAL**（S1/S2/S3 PASS、S4 上下文链 NOT VERIFIED）。
- 阻塞“整体 PASS”的项：D4-05 S4 依赖尚不存在的 memory→任务上下文装配能力（空验证）；D4-01/D4-02 的 Windows / External Provider = NOT VERIFIED；D4-03 待外部审计封板。
- 本轮（D4-06 Closure）已修复：① 任务层跨 run 累计预算（续接只补被批准 kind，其他种类继承剩余）；② 失败验证 UI 的 Electron 实测。**D4-06 恢复 PASS**；D4-05/D4 仍为 PARTIAL（memory 上下文缺口不变）。

## 1. D4 原始要求 → 实现 → 证据 → 限制 → 结论

| 要求（PLAN.md） | 实现位置 | 验证证据 | 限制 | 结论 |
| --- | --- | --- | --- | --- |
| **D4-01 模型服务**：统一配置及用量；继承、隔离、并发、撤权通过 | `electron/model-*.cjs`、`model-proxy.cjs`、`credential-store.cjs`、Settings UI | `test:d4-01` 59/59；model-ipc-ui 10/10、model-settings-ui 16/16、model-keychain-restart 64/64、model-secret-scan 13/13、model-secret-ui 20/20、model-isolation 10/10 + UI 26/26、model-performance 10/10 | Windows（Credential/Proxy/Firewall/Settings）NOT VERIFIED；External Provider NOT VERIFIED | macOS Core **PASS**；cross-platform overall **PARTIAL** |
| **D4-02 任务与适配**：任务版本固定且权限实时有效 | `task-domain/store/service.cjs`、`harness-adapter.cjs`、`task-harness-orchestrator.cjs` | `test:d4-02a` 22/22、`test:d4-02b` 16/16、`test:d4-02c` 22/22（schema v15）；MODEL_CONFIG_CHANGED 真实测试 | Windows NOT VERIFIED | macOS Core **PASS**；cross-platform overall **PARTIAL** |
| **D4-03 工具门与租约**：授权执行及回报；重复调用与离线结果处理正确 | `tool-registry.cjs`、`controlled-tool-proxy.cjs`、`tool-facade-bridge.cjs`、`side-effect-authority/store/runtime.cjs`、`runtime-supervisor.cjs` | A 32/32；B 59/59；C1 46/46+50/50；C2 29/29 + closure 38/38/45/45/51/51；C3 56/56、closure 63/63；C4 35/35 + UI 22/22 + closure 15/15/12/12/9/9；D 52/52、closure 62/62 | **PASS candidate，待外部审计封板**；OS 网络沙箱/独立 malformed ACP/跨重启 durable death proof NOT VERIFIED/DEFERRED | **PASS candidate** |
| **D4-04 纵向冒烟**：一工具真实流程记录；真实产物、停止、撤权可核查 | `tests/fixtures/d4-04-probe/main.cjs`、`tests/d4-04-smoke.mjs`、`runtime-boot.cjs`、`executor-launcher.cjs`、`side-effect-*.cjs` | `test:d4-04` **94/94**；Closure-3 **67/67**（`e989842`）；撤权 R1/R2；executor-unavailable | Gate 宿主 = probe host（非真实 `electron/main.cjs`） | **PASS（限定范围）** |
| **D4-05 执行关卡**：门控验收，未通过禁止扩展真实工具面 | `task-service.cjs`（recovery/resume/ledger）、`task-bootstrap.cjs`、AI 面板 | `test:d4-05` **128/128 functional**，`overallStatus=PARTIAL`，S1/S2/S3 PASS、S4 PARTIAL | S4 上下文链 NOT VERIFIED（无 memory 装配入口）；见 §2 | **PARTIAL** |
| **D4-06 关联链与预算停止**（§41） | `task-service.cjs`、`task-harness-orchestrator.cjs`、`task-store.cjs`、D4-05 recovery | `test:d4-06` **119/119**；`test:d4-06-resume` **21/21**；失败验证 UI `test:d4-08-verification-ui` **22/22**；`test:d4-08` **13/13** | 上层收敛为 TaskService 合同验证；失败验证 UI 走产品 orchestrator/proxy + test-only ACP agent（非 official dsh facade）；真实 main.cjs 未端到端 | **PASS** |
| **A14–A19** | 见审查轮报告 | D4-01/02/03 真实证据；A15 复用 | Windows / External Provider | **PASS**（复用） |

## 2. 重点审查发现与本轮修复

### 2.1 D4-05 S1 失败证据（A33）—— 已修复：失败 Verification 持久化（v15）
- 原缺口：`task_verifications.artifact_id NOT NULL` 只允许 Artifact 提交时的 PASS；schema/adapter verify 失败 0 记录，`verify` 的 `{expected,actual}` 被丢弃。
- 修复：**schema v15 最小兼容迁移**（`task_verifications` 重建为 `artifact_id` 可空 + `step_id/run_id/execution_id`，旧行原样复制、索引重建）；`TaskService.recordVerificationFailure`（owner/app 隔离；`status=FAIL`、`artifact_id=null`、`safe_details{method,expected,actual,evidence.executionId}`；expected/actual 有界（≤200）且去敏键/私有路径/`mpx_`/`tpx_`；**不建 Artifact、不改 Step/Task 终态**）；`ControlledToolProxy` 注入 `taskService`，在 `OUTPUT_SCHEMA`/`ADAPTER_VERIFY` 失败时先落证据再 `#finishExecution`；`task/get` 返回 safe verifications；UI 在 BLOCKED+FAIL 时显示 `data-ai-verification`（检查方法/预期/实际/证据），绝不显示成功。
- 实测：`tests/d4-07-verification-persistence.test.mjs` **5/5**（失败=1 FAIL/or Artifact=0/Step·Task BLOCKED；成功=1 Artifact+1 PASS 无回归；同盘重开证据完整；跨用户 `TASK_FORBIDDEN`；证据脱敏）；`tests/d4-05-s1-output-size.test.mjs` 失败断言更新为新契约（1 FAIL / 0 Artifact）；`tests/migration.test.mjs` 新增 v14→v15（旧 PASS 行保留 + 新列可用），migration 集合 **27/27**。
- **A33 结论不变**：工具报告成功但产物不符 → Task 不得标成功（BLOCKED、0 Artifact、无重试）。

### 2.2 D4-05 S2 人工确认（结果未知）—— 含义与入口（审查轮结论不变）
- 用户能找到待核查对象（`task/get.recovery`/`task/recovery`：callId/toolId/status/errorCode/核查结论/关联产物，脱敏）；“确认”= “我已人工核查”，只追加 safe event，**不表示成功、不解除 UNKNOWN_EFFECT、不授权重试/续接**；非 owner（真实用户 dana）读写均 `TASK_FORBIDDEN`；重复确认幂等；无产物时显示“无”。

### 2.3 D4-05 S4 记忆越权（A36）—— PARTIAL（本轮不变）
- **检索链 = PASS（正负对照）**；**上下文链 = NOT VERIFIED**：`buildPrompt` 无 memory 检索/装配入口，“请求体不含记忆”属空验证——只能说明当前无泄漏路径，不能声称已验证记忆注入时的隔离。故 S4 与 D4-05 = **PARTIAL**；最小后续方案见 §7。

### 2.4 预算实际值 / 停止原因 / 追加账本
- 根因：① `getBudgetLedger().base` 硬编码 `BUDGET_BASE`，忽略实际配置；② `HarnessAdapter.budgetExhausted()` 先判 MODEL_CALLS，工具预算真实耗尽被掩盖；③ 成功 prompt 后即使 TOOL_CALLS 已 EXHAUSTED 仍会 commit success。
- 修复：`TaskService.attachBudgetConfig({modelMaxCalls,toolMaxCalls,maxToolRounds})`（缺失回退默认），`base`/`nextGrant.amount` 用实际额度；`budgetExhausted()` 改为 **TOOL_CALLS 优先** 并返回只读脱敏 `observed{model,tool}`；orchestrator 每次 prompt 成功后若 TOOL_CALLS EXHAUSTED 立即 `BUDGET_EXHAUSTED{TOOL_CALLS}` + `task.budget_exhausted{observed}`（0 成功提交、0 后续调度）。
- 实测：`tests/d4-07-budget-consistency.test.mjs` **3/3**；`d4-05-s3` 四类预算 **4/4**（`base={8,1,4}`、`nextGrant={TOOL_CALLS,1}`、additions 仅 1 条同 kind）。**①②③ 已修复**。
- **已修复（D4-06 Closure，schema v16 `task_budgets`）**：保留 capability 按 run 签发，任务层维护跨 run 累计预算（每类 `authorized/consumed/remaining`）。一次续接**只抬升被批准 kind** 的 authorized，其他种类继承剩余；新 run 的 model/tool capability 额度 = 该类 remaining、轮次上界 = `min(MAX_TOOL_ROUNDS, remaining.TOOL_ROUNDS)`；run 结束一次性按真实计量扣减（失败/重复/在途不重不漏）；某类 remaining==0 → 不创建 run、直接 `BUDGET_EXHAUSTED`（不偷补）。旧任务无可靠消耗证据 → 保守基线（consumed=authorized 或 0）并落 safe baseline 事件，不反推历史。
- **before → after（真实链路）**：MODEL_CALLS M{8,8,0} T{100,7,93} R{4,0,4} → grant M+8 → M{16,8,8}（T/R 不变）；TOOL_CALLS M{100,10,90} T{2,2,0} R{4,0,4} → grant T+2 → T{4,2,2}（M/R 不变）；TOOL_ROUNDS M{8,0,8} T{8,0,8} R{4,4,0} → grant R+4 → R{8,4,4}（M/T 不变）。
- 实测：`tests/d4-08-budget-carryover.test.mjs` **13/13**（三类各自 before/after、实际调用次数受 remaining 约束、并发续接只一次、再耗尽/撤权/UNKNOWN、UI==账本==运行时、TOOL_CALLS 正反对照）。

### 2.5 失败 Verification 的 Electron UI 实测（D4-06 Closure 补齐）
- 新增 `tests/d4-08-verification-ui.mjs` + 真实 Electron probe：test-only 尺寸探针经**产品 TaskHarnessOrchestrator + 产品 ControlledToolProxy + 真实 TaskService/DB** 触发 `ADAPTER_VERIFY` 失败 → Task/Step BLOCKED、0 Artifact、1 条 FAIL verification；真实 Renderer 显示 `data-ai-verification`（检查方法 ADAPTER_VERIFY / 预期 / 实际 / 证据 executionId，**不显示成功**）；Reload 后从 `task/get` 恢复一致；非 owner（第二真实用户）读写均 `TASK_FORBIDDEN`、UI 不可见。实测 **22/22**。
- **限制**：该 UI 探针走产品 orchestrator/proxy 链 + test-only synthetic ACP agent，未走 official dsh facade、工具调用非由 deterministic provider 发出（facade 模式下 READ_ONLY 验证失败不回落到 Step/Task BLOCK，无法确定性得到“验证失败→BLOCKED”）。

## 3. 仍未验证的能力及其对收口的影响

| 能力 | 状态 | 对 D4 收口的影响 |
| --- | --- | --- |
| memory→任务上下文装配与隔离（A36 上下文链） | NOT VERIFIED | **阻塞 D4-05/D4 整体 PASS** |
| D4-03 外部审计封板 | PASS candidate | 影响“D4-03 = PASS”的正式性 |
| Windows / External Provider | NOT VERIFIED | D4-01/D4-02 overall = PARTIAL |
| OS 级网络沙箱 / external workspace read audit / independent malformed ACP injection | NOT VERIFIED | 安全纵深挂账，不属 D4-05 四场景 |
| 跨重启 authenticated durable process-death proof | DEFERRED / NOT VERIFIED | 当前 fail closed 到 UNKNOWN_EFFECT |
| 失败 Verification 的 Electron UI | 已实测 22/22（fallback 链） | 已满足；链路限制见 §2.5 |

## 4. 唯一推荐的下一阶段任务

**D4-05 Closure · 受控 memory 检索/装配与上下文隔离**（建议；见 §7 方案）。范围/前置/完成标准见审查轮（不变）；完成并通过后 S4 与 D4-05 方可升 PASS。路线图下一个正式阶段为 **D5-01 浏览器**（不受 D4-05 门控）；D5-02/03/06/08 以 D4-05 通过为前置。

## 5. 修改文件与实际检查

- **审查轮被测提交 `431395d`**（产品零改动）：`tests/d4-05-s1/s2/s3*.test.mjs`、`tests/d4-05-smoke.mjs`、`docs/D4-05-RESULT.md`、`docs/D4-05-GATE-EVIDENCE.json`。
- **收口修复被测提交 `ec7a732`**：`electron/{controlled-tool-proxy,harness-adapter,identity-store,side-effect-executor-bundle,task-bootstrap,task-harness-orchestrator,task-service,task-store}.cjs`、`src/desktop/components.tsx`、`tests/{d4-05-s1-output-size,d4-05-s3-budget-ledger,migration,device-migration,side-effect-migration,task-orchestration-migration,task-store,tool-execution-migration,tool-migration}.test.mjs`、`tests/fixtures/harness-acp/tool-harness-fixture.mjs`、新增 `tests/d4-07-budget-consistency.test.mjs`、`tests/d4-07-verification-persistence.test.mjs`。
- **D4-06 Closure 被测 commit `7b53458`**：`electron/{identity-store,task-domain,task-store,task-service,task-harness-orchestrator,tool-facade-bridge,harness-adapter}.cjs`、`src/desktop/components.tsx`、`package.json`、`tests/d4-08-budget-carryover.test.mjs`（新）、`tests/d4-08-verification-ui.mjs` + `tests/fixtures/d4-08-verification-ui/*`（新）及 migration/fixture 断言更新；`fbbc002` 仅修 3 个 resource-* migration seed（DROP task_budgets）。
- **报告提交**：`docs/D4-ACCEPTANCE-RESULT.md`、`docs/D4-05-RESULT.md`、`docs/D4-04/05/06-GATE-EVIDENCE.json`、`PROGRESS.md`。
- **实际执行（D4-06 Closure，被测 commit `7b53458`，干净工作区）**：`test:d4-06` **119/119**、`test:d4-06-resume` **21/21**、`test:d4-08-verification-ui` **22/22**、`test:d4-05` **128/128（PARTIAL）**、`test:d4-04` 94/94、`test:d4-02c` 22/22（schema v16）、`test:d4-03c4` 35/35+UI 22/22；`npm test` **958/958 PASS**（`fbbc002` 修 3 个 resource-* migration seed 后）。
- 证据脱敏：无 `/Users`、`/private`、`/var/folders`、`mpx_`、`tpx_`、credential。

## 6. 诚实边界

- 本轮**只修两个既有缺口**，未新增 memory 装配、未进入 D5/D6、未扩展工具面、未放宽检查。
- **未把“一次续接只补一个 kind”写成已满足**：账本层面成立，运行时 per-run capability 仍会重新签发其他 kind，已如实标为 OPEN 并交裁决。
- D4-05/D4 保持 **PARTIAL**；不因两个缺口修复而升级（记忆上下文缺口不变）。
- “测试环境等价”不等于“真实 `electron/main.cjs` 全流程已实测”。

## 7. 受控 memory 装配最小方案（仅方案，未实施）

- **记忆来源**：`Resource type=memory`（D3-04B），subtype = personal-preference / project-memory / decision-memory / conversation-memory / agent-memory；只取用户本人或被授权项目的记忆，不取跨组织/他人记忆。
- **检索范围**：经 `SearchService`/`ResourceService` 的**授权过滤**查询（同 D3-05 Gate-Search），限定 task 的 user + app + project/department；按相关性 + 上限条数/字符数取最小必要片段。
- **权限检查时点**：**装配时**（task 启动/组装 prompt 前）与**每次受控读取时**都重新授权；memory 高敏——全局 grant 不覆盖（D3-02 §25），必须有显式 Resource-Type/Resource/Collection grant；无授权则 0 注入。
- **删除与切账号处理**：删除仍走现有删除路径（资源删除 + 派生索引移除，已由检索链验证）；装配每次实时读取，不缓存跨会话 → 已删记忆下个任务即不可见；切账号后授权过滤使他人/已删内容不进入上下文。
- **是否进入模型请求**：进入——但**仅授权且最小化的片段**（有界长度、脱敏、无凭据/绝对路径）；绝不 dump 全部记忆或完整文件。
- **留存方式**：**不**为“证明隔离”而持久化完整私人记忆或模型请求正文；只保留 safe 引用（resourceRef/artifactId/checksum）与授权/审计记录；隔离用确定性 provider 的 test-only 唯一 token + 正负对照验证（授权可见且注入 / 已删·他人不出现）。
