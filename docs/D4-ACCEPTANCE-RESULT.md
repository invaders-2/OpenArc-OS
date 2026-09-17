# D4 阶段收口审查 · 结果记录（Acceptance Review）

- 审查 Base HEAD：`6fb68377dfe5d1eefae6b951cd89c540f2abaa51`
- **被测 commit（本轮补测 + 结论修正）**：`431395dfe79afec8b4d9370a51b147b46b3e695c`
- Final HEAD：本轮报告/证据提交（见文末）
- 分支：`feature/d4-03-tool-proxy`；工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`；未 push、未合并 main；默认 d3-02 工作区未触碰

## 0. D4 整体结论

**D4 = PARTIAL（macOS 核心基本完成，非整体完成）**。

- D4-01 macOS Core、D4-02 macOS Task/Harness Core、D4-03（PASS candidate）、D4-04、D4-06 在各自声明范围内通过；D4-05 = **PARTIAL**（四场景中 S1/S2/S3 PASS、S4 上下文链 NOT VERIFIED）。
- 阻塞“整体 PASS”的项：D4-05 S4 依赖尚不存在的 memory→任务上下文装配能力（空验证）；D4-01/D4-02 的 Windows / External Provider = NOT VERIFIED；D4-03 仍为 PASS candidate，待外部审计封板。
- 不因远期无关缺口否定已完成范围：macOS 上 D4 的工具门/租约/审批/受控写入/纵向冒烟/关联链/预算停止/撤权/结果未知处置均已真实验证。

## 1. D4 原始要求 → 实现 → 证据 → 限制 → 结论

| 要求（PLAN.md） | 实现位置 | 验证证据 | 限制 | 结论 |
| --- | --- | --- | --- | --- |
| **D4-01 模型服务**：统一配置及用量；继承、隔离、并发、撤权通过 | `electron/model-*.cjs`、`model-proxy.cjs`、`credential-store.cjs`、Settings UI | `test:d4-01` 59/59；model-ipc-ui 10/10、model-settings-ui 16/16、model-keychain-restart 64/64、model-secret-scan 13/13、model-secret-ui 20/20、model-isolation 10/10 + UI 26/26、model-performance 10/10 | Windows（Credential/Proxy/Firewall/Settings）NOT VERIFIED；External Provider NOT VERIFIED | macOS Core **PASS**；cross-platform overall **PARTIAL** |
| **D4-02 任务与适配**：任务版本固定且权限实时有效 | `task-domain/store/service.cjs`、`harness-adapter.cjs`、`task-harness-orchestrator.cjs` | `test:d4-02a` 22/22、`test:d4-02b` 16/16、`test:d4-02c` 22/22；schema v9/v10 migration；MODEL_CONFIG_CHANGED 真实测试 | Windows NOT VERIFIED | macOS Core **PASS**；cross-platform overall **PARTIAL** |
| **D4-03 工具门与租约**：授权执行及回报；重复调用与离线结果处理正确 | `tool-registry.cjs`、`controlled-tool-proxy.cjs`、`tool-facade-bridge.cjs`、`side-effect-authority/store/runtime.cjs`、`runtime-supervisor.cjs` | A 32/32；B 59/59；C1 46/46+50/50；C2 29/29 + closure 38/38/45/45/51/51；C3 56/56、closure 63/63；C4 35/35 + UI 22/22 + closure 15/15/12/12/9/9；D 52/52、closure 62/62 | **PASS candidate，待外部审计封板**；OS 网络沙箱/独立 malformed ACP/跨重启 durable death proof NOT VERIFIED/DEFERRED | **PASS candidate** |
| **D4-04 纵向冒烟**：一工具真实流程记录；真实产物、停止、撤权可核查 | `tests/fixtures/d4-04-probe/main.cjs`、`tests/d4-04-smoke.mjs`、`runtime-boot.cjs`、`executor-launcher.cjs`、`side-effect-*.cjs` | `test:d4-04`（当前共享 probe）**94/94**；Closure-3 **67/67**（`e989842`）；真实撤权 R1/R2；executor-unavailable | Gate 宿主 = probe host（非真实 `electron/main.cjs`）；无 artifact 的预算停止不可续接 | **PASS（限定范围）** |
| **D4-05 执行关卡**：门控验收，未通过禁止扩展真实工具面 | `task-service.cjs`（recovery/resume/ledger）、`task-bootstrap.cjs`、AI 面板 | `test:d4-05` **128/128 functional**，`overallStatus=PARTIAL`，S1/S2/S3 PASS、S4 PARTIAL | S4 上下文链 NOT VERIFIED（无 memory 装配入口）；见 §2 | **PARTIAL** |
| **D4-06 关联链与预算停止**（§41） | `task-service.cjs`、`task-harness-orchestrator.cjs`、`task-store.cjs`、D4-05 recovery | `test:d4-06` **106/106**；`test:d4-06-resume` **19/19** | 上层收敛为 TaskService 合同验证（非完整 orchestrator 实测）；真实 main.cjs 未端到端 | **PASS（限定范围）** |
| **A14** 团队默认模型可用；个人覆盖再清除，本人切换、他人不变 | D4-01 Model Defaults/Resolution + App/User 隔离 | D4-01 model-isolation 10/10 + UI 26/26 | 同上 | **PASS**（macOS） |
| **A15** 模型无图像能力；设为图像默认并测试 | D4-01 Capabilities 校验 | D4-01 Capabilities/默认解析 + model-service 测试 | 复用阶段证据，本审查未逐条重跑 | **PASS**（复用） |
| **A16** 任务配置已快照；撤销模型权限后调用被拒 | D4-02A model snapshot 冻结 + `startModelCall` 实时 reauthorize；D4-02B per-call | D4-02A 真实 `MODEL_CONFIG_CHANGED`（expected=1/current=2，0 call/0 revision bump） | Windows | **PASS** |
| **A17** 任务工具执行中停止；后续步骤停止、已发生据实展示 | D4-02C cancel 两阶段 + D4-03C4/03D cancel race | D4-03C4 UI 22/22、D4-04 E1–E4、D4-03D mixed cancel | — | **PASS** |
| **A18** 执行端完成但回报丢失；不再次执行或进入结果未知核查 | D4-03C3/C4 UNKNOWN_EFFECT + recovery verification | D4-04 F1–F7、D4-03C3 closure 63/63、D4-05 S2 | 人工确认入口为本轮补齐 | **PASS** |
| **A19** 租约过期且设备断线；不盲目换设备重发副作用 | D4-03C1/C4 lease + trusted quiescence authority | D4-03C4 closure 15/15、closure2 12/12、closure3 9/9 | 跨重启 **authenticated durable death proof = DEFERRED / NOT VERIFIED**（当前 fail closed 到 UNKNOWN_EFFECT） | **PASS**（fail closed；durable proof 挂账） |

## 2. 重点审查发现

### 2.1 D4-05 S1 失败证据（A33）—— 失败结论已持久化、跨重开可追溯
- 新增同盘 DB 重开用例（`tests/d4-05-s1-output-size.test.mjs`）：负例（execute 成功但 size 7≠10）后 `close → reopenToolHarnessRuntime → recover() → 新 TaskService/ToolStore`，仍可追溯：
  - `tool_executions` 行在（`task_id/step_id/run_id` 归属一致、`status=FAILED`、`verification_status=FAIL`、`error_code=TOOL_VERIFICATION_FAILED`）；
  - 持久化 `tool.verification.failed` 事件在、无 `tool.execution_succeeded`；重开后 Task/Step 仍 BLOCKED；
  - `task_verifications` 对失败路径 = 0（如实记录，不造假）。
- **失败结论不依赖测试日志**：由 `tool_executions` + `task_events` 持久化承载（均可按 Task/Step/Call 查询）。
- **潜在契约缺口（已报告，未改产品）**：PLAN §39 描述 Verification 保存“检查方法、预期、实际结果、证据引用及通过时间”，schema `task_verifications.status` 支持 FAIL，但代码只在成功提交时写 Verification；失败时 `adapter.verify` 的 `{expected,actual}` 被丢弃。最小修复：验证失败时插入 `status=FAIL` 的 `task_verifications`（`artifact_id` 需可空或新增 `execution_id`，需 migration）。
- **A33 结论不变**：工具报告成功但产物不符 → Task 不得标成功（BLOCKED、0 Artifact、无重试）已成立；上述是 Verification 记录完整性的契约细化，不影响 A33 验收。

### 2.2 D4-05 S2 人工确认（结果未知）—— 含义与入口
- 用户能找到待核查对象：`task/get.recovery` / `task/recovery` 返回 UNKNOWN_EFFECT 的 `callId/toolId/status/errorCode`、核查结论（APPLIED/NOT_APPLIED/INDETERMINATE/尚无结论）、**关联产物**（artifactId/type/checksum，脱敏），UI 渲染 `data-ai-recovery`。
- “确认”语义明确：按钮为“我已人工核查”，确认后显示“已人工确认”；仅追加一条 safe event `tool.side_effect.unknown_effect.acknowledged`，**绝不**表示执行成功、**不**解除 UNKNOWN_EFFECT、**不**授权重试/续接（`resumable=false`，无 Success/Retry/Resume 入口）。
- 权限：非 owner（真实用户 dana）调 `getRecoveryState`/`acknowledgeUnknownEffect` → `TASK_FORBIDDEN`，不返回恢复详情、不追加 event、不改变状态；重复确认幂等（`changed=false`，仍 1 条 event）。
- 缺少产物时投影显示“关联产物：无”，不制造关联。

### 2.3 D4-05 S4 记忆越权（A36）—— 修正为 PARTIAL（排除空验证）
- **检索链 = PASS（正负对照）**：alice 删除前可检索；删除后不可检索 + 派生索引文档移除；切账号 dana 检索不到已删或他人 memory。
- **上下文链 = NOT VERIFIED**：`buildPrompt` 只含 goal + safe step input + prior artifact，**不存在真实 memory 检索/装配入口**；“真实任务 model 请求体不含 memory token”在此前提下是**空验证**——只能说明当前无泄漏路径，**不能**声称“具备记忆注入时的上下文隔离”。
- 因此 **S4 = PARTIAL、D4-05 = PARTIAL**；最小后续方案（本轮不改产品）：先新增受控 memory 检索/装配入口，再用正负对照验证上下文隔离（授权记忆可见且注入；已删/他人记忆不出现），通过后 S4 才可升 PASS。

### 2.4 预算追加的实际约束（MODEL_CALLS / TOOL_CALLS / TOOL_ROUNDS）
- 三类停止均新增/复用账本断言：`task.budget_exhausted{kind,consumed,maxCalls/maxRounds}` 与 `getBudgetLedger().additions` 的最后一类 `kind`/`amount` 一致，且与**新一轮实际生效限制**一致：
  - MODEL_CALLS：additions.amount=8 == 新 model capability maxCalls=8（复用 D4-05 S3 用例）；
  - TOOL_ROUNDS：additions.amount=4 == `MAX_TOOL_ROUNDS`，新 run 实际只跑 4 轮并再次停止；
  - TOOL_CALLS：additions.amount=1 == facade maxCalls=1，新 run 再次 `{TOOL_CALLS,1,1}`。
- **一次续接只追加一个 kind**（additions 长度 1、kind 唯一），账本未遗漏其它类，UI 显示 `nextGrant.kind + amount`；未发现“补多类但只显示一种”的缺陷。
- **两处产品缺口（已报告，未改产品）**：① TOOL_CALLS 真实耗尽后 dsh 不单独中止，`HarnessAdapter.budgetExhausted()` 先判 MODEL_CALLS，实测 kind 常记为 MODEL_CALLS（用户/账本无法区分真实工具边界；已记录最小建议：持久化“最早耗尽的 kind”）；② `ledger.base.TOOL_CALLS` 名义值 8 与实时 facade maxCalls 不一致（additions 承载真实额度，base 可能误导）。

## 3. 仍未验证的能力及其对收口的影响

| 能力 | 状态 | 对 D4 收口的影响 |
| --- | --- | --- |
| memory→任务上下文装配与隔离（A36 上下文链） | NOT VERIFIED | **阻塞 D4-05/D4 整体 PASS**（D4-05 = PARTIAL） |
| D4-03 外部审计封板 | PASS candidate（未封板） | 影响“D4-03 = PASS”的正式性；不影响 macOS 已验行为 |
| Windows（模型服务/任务/工具门全链路） | NOT VERIFIED | D4-01/D4-02 cross-platform overall = PARTIAL |
| External Provider（真实供应商接入） | NOT VERIFIED | 影响“统一配置及用量”在真实 provider 上的完整性 |
| OS 级网络沙箱 / external workspace read audit / independent malformed ACP injection | NOT VERIFIED | 安全纵深挂账，不属 D4-05 四场景，不阻塞 macOS 核心收口 |
| 跨重启 authenticated durable process-death proof | DEFERRED / NOT VERIFIED | 当前 fail closed 到 UNKNOWN_EFFECT；不阻塞 D4 |
| 失败 Verification 独立记录（§39 契约细化） | 潜在缺口 | 不影响 A33 结论；建议后续最小修复 |

## 4. 唯一推荐的下一阶段任务

**D4-05 Closure · 受控 memory 检索/装配与上下文隔离**（建议；若路线图认为 A36 上下文链须依赖 memory 能力，则这是解除 D4-05 门控的唯一前置；编号不是已批准的阶段编号，D5-* 才是路线图正式阶段）。

- **目标**：提供**受控**的 memory 检索→任务上下文装配入口（仅授权范围内的个人/项目记忆），使 A36 的上下文链成为可验证的正负对照，而非空验证。
- **范围**：最小装配入口 + 授权过滤接入（复用 D3-02 §25 memory 授权语义）；不新增记忆类型/UI 功能、不扩大工具面。
- **排除项**：D5-* 各阶段；真实外部 provider；Windows；不实现完整记忆产品。
- **前置条件**：D4-05 检索链已 PASS；D3-02 memory 授权规则已冻结；D4-02C orchestrator prompt 构造点（`buildPrompt`）已存在。
- **可检查的完成标准**：真实任务在授权范围内装配 memory 并可从持久化的 model 请求体追溯；**授权记忆可见且注入**（正对照）、**已删/他人记忆绝不出现**（负对照）、切换账号后一致、无未授权检索；通过后 S4 与 D4-05 方可从 PARTIAL 升 PASS。
- **之后**：路线图下一个正式阶段为 **D5-01 浏览器**（前置 D2、D3-05、D1-01，不受 D4-05 门控的“扩展真实工具面”约束）；D5-02/03/06/08 均以 D4-05 通过为前置，须待上述门控关闭。

## 5. 本轮修改文件与实际检查

- **被测提交 `431395d`**：`tests/d4-05-s1-output-size.test.mjs`、`tests/d4-05-s2-recovery.test.mjs`、`tests/d4-05-s3-budget-ledger.test.mjs`（补测）、`tests/d4-05-smoke.mjs`（S4 gap → PARTIAL）、`docs/D4-05-RESULT.md`、`docs/D4-05-GATE-EVIDENCE.json`。**产品零改动。**
- **报告提交**：`docs/D4-ACCEPTANCE-RESULT.md`、`docs/D4-05-RESULT.md`、`docs/D4-05-GATE-EVIDENCE.json`、`PROGRESS.md`。
- **实际执行**（被测 commit `431395d`，干净工作区）：`npm run test:d4-05` → **128/128 functional**，`overallStatus=PARTIAL`，S1/S2/S3=PASS、S4=PARTIAL，`workspaceState=""`；`node --test tests/d4-06-resume.test.mjs` → **6/6**；补测单独运行 9/9。未机械重跑全部阶段测试；D4-01/02/03/04/06 结论复用各自阶段证据（见 §1）。
- 证据脱敏：无 `/Users`、`/private`、`/var/folders`、`mpx_`、`tpx_`、credential。

## 6. 诚实边界

- 本轮是**只读审查 + 必要补测 + 结论修正**，未新增产品能力、未修产品缺陷（发现的缺口只给影响与最小修复建议）。
- D4-05 的 PASS **已被主动修正为 PARTIAL**；不因此前已写 PASS 而回避。
- “测试环境等价”不等于“真实 `electron/main.cjs` 全流程已实测”；D4 的 Electron 证据均为 probe host + 共享 production 装配。
