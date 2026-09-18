# D4 阶段收口审查与修复 · 结果记录（Acceptance Review + Closure Fix）

- 审查 Base HEAD：`6fb68377dfe5d1eefae6b951cd89c540f2abaa51`
- 审查轮被测 commit：`431395dfe79afec8b4d9370a51b147b46b3e695c`
- 收口修复（预算/失败验证）被测 commit：`ec7a732aa78ffc52e8e0ce3b4d1e09108f604dc4`
- **D4-06 Closure 被测 commit（跨 run 累计预算 + 失败验证 UI）：`7b53458ef1611c08ab96679eab6377d1c4d0e342`（test-seed 修复 `fbbc002d1103b459b46f55172cd139345176b098`）**
- Final HEAD：本轮报告/证据提交（见文末）
- 分支：`feature/d4-03-tool-proxy`；工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`；未 push、未合并 main；默认 d3-02 工作区未触碰

## 0. D4 整体结论

**D4 = PARTIAL（macOS 核心基本完成，非整体完成）**。

- D4-01 macOS Core、D4-02 macOS Task/Harness Core、D4-03（PASS candidate）、D4-04、D4-05、D4-06 在各自声明范围内通过；**D4-05 = PASS**（D4-05 Closure-3 闭合 S4；Closure-4 修复记忆信任分层，S1/S2/S3/S4 全 PASS）。**S4 的 PASS 限定“消息结构 + 授权/执行边界”，不证明真实模型绝不受提示注入影响。**
阻塞“整体 PASS”的项（`D4 = PARTIAL`，不自动升级）：D4-01/D4-02 的 Windows / External Provider = NOT VERIFIED；**D4-03 = PASS candidate（内部独立预审完成、13 项已确认缺陷闭合；封板待实现方之外的审查者裁决，见 `docs/D4-03-INDEPENDENT-REVIEW.md`）**；**三项产品语义裁决待决**（REV-03/S2 approval 与 approver 权限、R-8 旧任务未绑定窗口、R7/R6-C2/C3 DENY 状态前置与抑制分类）；**F-2 已按既有契约修复并独立复核 CLOSED**；真实 `electron/main.cjs` 全流程 = **PASS（被测 commit `c7302dc` 干净树复跑：七条必需流程（含 flow6 模型配置绑定）全部经真实产品入口 PASS、Gate `133/133`、`overallStatus=PASS`、exit 0）**。D4-05 S4 memory 上下文缺口已由 D4-05 Closure-3 闭合。
- 本轮（D4-06 Closure）已修复：① 任务层跨 run 累计预算（续接只补被批准 kind，其他种类继承剩余）；② 失败验证 UI 的 Electron 实测。**D4-06 恢复 PASS**；当时 D4-05/D4 仍为 PARTIAL（该 memory 上下文缺口后由 D4-05 Closure-3 闭合）。
- **D4-05 Closure（代码/测试被测 commit `70eb0b12167e513bb4eb7fa1cb4efb9ca70e509d`）**：修复 A33 正式链假成功——official dsh facade 下 READ_ONLY 必需产物验证失败不再被 final text 成功掩盖（`TaskService.getUnresolvedRequiredVerificationFailures` + orchestrator 提交前闸门）。**S1 结论以正式链证据为准**；当时 **D4-05 / D4 仍为 PARTIAL**（该 S4 memory 上下文缺口后由 D4-05 Closure-3 闭合），**D4-06 通过范围不扩大**。详见 `docs/D4-05-CLOSURE-RESULT.md`。
- **D4-05 Closure-2（代码/测试被测 commit `77b6e857f3d5a9781ea2c218e89069b1802aaab4`）**：修正失败验证的**解决关联**——关联键从裸 `tool_id` 改为 `(tool_id, canonical arguments)`，无关对象/无关验证要求/无关 Step 的 PASS 不再误清除对应 FAIL；只有同对象+同要求的真实复验 PASS 才算解决，旧 FAIL 与解决关系均可追溯；缺失关联的旧数据保守保持未解决。详见 `docs/D4-05-CLOSURE2-RESULT.md`。
- **D4-05 Closure-3（代码/测试被测 commit `9691348ebf52b4854aafcb2e343e32ee2d2d608b` + `ac9af8e502c5285b7bcf06c8fc0b8e0ecc52e9f0`）**：实现受控记忆装配与任务上下文隔离（A36）——受控装配入口 + 唯一出站口逐请求注入（reference-data 标记、与系统指令分离）、发送前重新授权/重新读取、删除/撤权/切账号/跨范围隔离、无缓存、正文不落盘；真实 Electron UI 流程 15/15。**S4 与 D4-05 升为 PASS**；**D4 仍为 PARTIAL**（剩余既有未验证项不变）。详见 `docs/D4-05-CLOSURE3-RESULT.md`（其 system-role 与正文标记表述已由 Closure-4 更正）。
- **D4-05 Closure-4（代码/测试被测 commit `698117fff03f2d11d952bf94dc99035197ddd09e`）**：修复**记忆上下文信任分层**——删除把记忆正文注入 `role:"system"` 及依赖 “NOT a system instruction”/正文标记的做法；改为 `name:"openarc.reference_data"` 的 user 低信任参考消息（JSON.stringify 转义、不伪造 tool_calls）+ `name:"openarc.rules"` 常量 system 规则（零资源文本）；清理只按应用自有结构标签；结构不可安全处理 → 403 不转发。**S4 = PASS 收窄为“消息结构 + 授权/执行边界”**；**D4 仍为 PARTIAL**。详见 `docs/D4-05-CLOSURE4-RESULT.md`。
- **D4 Main-Entry E2E Closure-5（代码/测试被测 commit `4e8c6c1` + `81ced49` + `396e14c`）**：以**真实产品入口 `electron/main.cjs`**（真实 `electron .` + 真实 preload + `dist/index.html` + CDP 驱动真实 Renderer + 隔离 userData + 本地确定性 provider）验证：boot 顺序、真实 UI 首启/登录、真实 Settings provider/model、**产品治理 UI 工具授权**、AI 任务 + 审批成功 WRITE（mutation=1/SideEffectCall=1/approval=1/lease=1 RELEASED/Artifact+Verification 绑定/SUCCEEDED）、**非管理员授权被拒 + 撤权停止**（BLOCKED/`SIDE_EFFECT_AUTHORIZATION_REVOKED`/0 mutation/0 lease/0 新 executor）、**明确 WRITE 被拒不再假成功**（Task/Step BLOCKED、`deniedOperations`、`data-ai-denied`）、刷新一致性；**Gate `63/64`、`overallStatus=PARTIAL`、退出码 1**，renderer/main 错误 0；移除 `OPENARC_E2E_SEED_TOOL_GRANTS` 播种。**流程4（预算→UI 续接）仍结构性不可达（NOT_VERIFIED）**——不造多步/空产物、不放宽守卫。**D4 不自动升级。** 详见 `docs/D4-PRODUCT-MAIN-E2E-RESULT.md` 与 `docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`。
- **D4 Main-Entry E2E Closure-6（代码/测试被测 commit `5577e82` + `3c9659a`）**：补齐**产品级“同一任务追加下一步目标”入口（AppendStep）**——`TaskService.appendStep`/`getAppendEligibility`（判定+写入同一事务、只新增一个 reasoning step、绝不改旧行/重放旧 tool 请求/写 `task_budgets`）、显式放开唯一的 `SUCCEEDED→RUNNING` 边（`startTask` 仍拒绝）、`#resumeAssessment` 覆盖“无额度不建空转 run”的 step 级预算停止、`task/appendStep`（**拒绝同步返回**、运行异步）与 `task/get.appendable/appendReason`、AI 面板追加入口与步骤历史。**真实 main 五条必需流程全部 PASS（`120/120`、exit 0）**：正常任务第一步真实出产物 → 真实 UI 追加第二步（同步接收、同一 taskId、旧行逐字段不变、追加不增加预算）→ 第二步真实耗尽 `MODEL_CALLS`（Task/Step BLOCKED、第一步产物与副作用不变）→ UI 显示停止原因与明确追加额度（与后端 `nextGrant` 逐字一致）→ 点击 `[data-ai-resume]` 后续完成（3 steps `SUCCEEDED/BLOCKED/SUCCEEDED`、2 Artifact + 2 Verification、additions=1）；跨 run 账本/实际调用次数/关联链核对（provider 真实模型请求 9 == `MODEL_CALLS.consumed` 9；tool calls 6 == executions 5 + sideEffectCalls 1）与第一步副作用恰好一次；拒绝矩阵（真并发/重复/过期 revision/非 SUCCEEDED/AWAITING_APPROVAL/非 owner/执行前撤权）全部有正对照。**真实回归（干净树复跑发现并修复，`3c9659a`）**：追加入口把机器码 `APPEND_NOT_SUCCEEDED` 渲染成可见文本，命中 D4-08 UI“验证失败不得显示成功”闸门（21/22）→ 改为人话投影后 **22/22**，未放宽任何断言。**D4 仍为 PARTIAL**（Windows/External Provider、D4-03 外部审计等既有项不变）。详见 `docs/D4-PRODUCT-MAIN-E2E-RESULT.md` 与 `docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`。
- **D4-03 独立审查与收口（代码/测试被测 commit `f63e87a`）**：因 D4-03 原始封板条件要求“由实现方之外的审查者审计后裁决（DeepSeek 无权封板）”，本轮安排**两名未参与实现的独立审查者**做内部独立预审（四轮），确认并修复 **REV-01**（`TaskHarnessOrchestrator.runTask()` 第三条启动入口无未决副作用守卫 → 可在 UNKNOWN_EFFECT 期间执行第二条 WRITE 并把任务写成 SUCCEEDED）与 **F-1 + R-1/R-2/R-3/R-5'**（工具参数与失败验证证据的持久化去敏契约被破坏：绝对路径 / 明文 `tpx_` / secret 形态落库；执行入参与落库投影已解耦、冷缓存回退 fail closed），全部由同一审查者复核 **CLOSED**。**D4-03 维持 PASS candidate、本轮不封板**：缺 ① 实现方之外审查者的裁决（原文指名 ChatGPT）② F-2 产品裁决 ③ 低危残留处置（A-4/R-1'/R-4'/N-1 等）。同一被测 commit 干净树上：D4-03 十六门禁全绿、D4-04 94/94、D4-05 173/173、D4-06 119/119、真实 main 120/120（exit 0）、`npm test` 1033/1033。详见 `docs/D4-03-INDEPENDENT-REVIEW.md`。 **第二轮（F-2 + 未关闭项逐项澄清与修复，被测 commit `c7302dc`）**：① **F-2 按既有契约修实现**——产品入口 `task/run` 由后端解析并冻结 model config id/version（不信 renderer 自报、不落凭据），改版后 run/附加步骤/显式续接三入口一律显式 `MODEL_CONFIG_CHANGED` 并收敛 BLOCKED（0 capability/0 call/0 artifact），默认切换不静默跟随，旧任务同一事务懒绑定 + `task.model_config_bound` 事件（不伪造历史版本）；② **新增确认并闭合的缺陷**：S1（迟到 SUCCEEDED 覆盖另一 runtime 的 UNKNOWN_EFFECT）、S1-b（失败类迟到写回同类覆盖）、A-4（终态 call 遗留 ACTIVE lease：写终态与终结 lease 合并同事务 + recover 归属回收 + deny 回收）、R-1'（裸单段与 POSIX 双斜杠绝对路径落库）、R-7（`checkModelConfig` → 签发 capability 之间改版导致以非冻结版本签发）、R-9（配置解析类失败的对外原因码）；③ **未关闭项逐项澄清**（REV-02/REV-03+S2/A-5/A-6/S3/R-8/R7/R6-C2C3/R3/R4/R-4'/N-1/R-6/[REDACTED] 误拒，含契约/位置/分类/可达性/后果/防护层/封板影响，见 `docs/D4-03-INDEPENDENT-REVIEW.md` §4）；④ 干净树验证：D4-03 十六门禁全绿、D4-01 59/59、D4-02a/b/c 22/16/22、D4-04 94/94、D4-05 173/173、D4-06 119/119、真实 main **133/133（七条必需流程含 flow6）exit 0**、`npm test` **1061/1061**。**D4-03 仍为 PASS candidate（不封板）**：缺 ① 实现方之外审查者的裁决 ② 三项产品语义裁决（REV-03/S2、R-8、R7/R6-C2C3）③ 低危登记项处置。

## 1. D4 原始要求 → 实现 → 证据 → 限制 → 结论

| 要求（PLAN.md） | 实现位置 | 验证证据 | 限制 | 结论 |
| --- | --- | --- | --- | --- |
| **D4-01 模型服务**：统一配置及用量；继承、隔离、并发、撤权通过 | `electron/model-*.cjs`、`model-proxy.cjs`、`credential-store.cjs`、Settings UI | `test:d4-01` 59/59；model-ipc-ui 10/10、model-settings-ui 16/16、model-keychain-restart 64/64、model-secret-scan 13/13、model-secret-ui 20/20、model-isolation 10/10 + UI 26/26、model-performance 10/10 | Windows（Credential/Proxy/Firewall/Settings）NOT VERIFIED；External Provider NOT VERIFIED | macOS Core **PASS**；cross-platform overall **PARTIAL** |
| **D4-02 任务与适配**：任务状态及 Harness 适配（任务版本固定且权限实时有效） | `task-domain/store/service.cjs`、`harness-adapter.cjs`、`task-harness-orchestrator.cjs`、`task-bootstrap.cjs`、`model-proxy.cjs` | `test:d4-02a` **22/22**、`test:d4-02b` **16/16**、`test:d4-02c` **22/22**（schema v16）；**F-2 已按既有契约修复（被测 commit `c7302dc`）**：产品入口 `task/run` 由后端解析并冻结 model config id/version（不信 renderer 自报、不落凭据），配置改版后 run / 附加步骤 / 显式续接三入口一律显式 `MODEL_CONFIG_CHANGED` 并收敛 BLOCKED（0 capability / 0 call / 0 artifact），默认切换不静默跟随；`issueCapability(expectedModelConfigVersion)` 关闭“读版本→签发 capability”窗口；旧任务同一事务懒绑定 + `task.model_config_bound` 事件（不伪造历史版本）；新增 `tests/d4-03-model-binding.test.mjs` **12/12** + 真实 main flow6 **13/13** | 历史任务在“懒绑定前、默认迟到”窗口内 task/run/call 归属仍为 null（R-8，需产品裁决）；Windows NOT VERIFIED | **PASS（macOS Core）** |
| **D4-03 工具门与租约**：授权执行及回报；重复调用与离线结果处理正确 | `tool-registry.cjs`、`controlled-tool-proxy.cjs`、`tool-facade-bridge.cjs`、`side-effect-authority/store/runtime.cjs`、`runtime-supervisor.cjs`、`model-proxy.cjs` | A 32/32；B 59/59；C1 48/48+52/52；C2 29/29+38/38/45/45/51/51；C3 56/56+63/63；C4 35/35+UI 22/22+15/15/12/12/9/9；D 52/52+62/62（**均为被测 commit `c7302dc` 干净树复跑**）；D4-01 59/59、D4-02a/b/c 22/16/22；**独立审查七轮**：确认 13 项缺陷（REV-01 / F-1 / R-1 / R-2 / R-3 / R-5' / **F-2** / **R-7** / **R-9** / **S1** / **S1-b** / **A-4** / **R-1'**）全部修复并经同一审查者复核 CLOSED；新增测试 `tests/d4-03-model-binding.test.mjs` 12/12、`tests/d4-03-lease-state-integrity.test.mjs` 10/10、`tests/d4-03-run-entry-guard.test.mjs` 7/7、`tests/tool-argument-projection-redaction.test.mjs` 21/21 | **PASS candidate（内部独立预审通过，本轮不封板）**：封板缺 ① 实现方之外的审查者裁决（原文指名 ChatGPT）② 三项产品语义裁决（REV-03/S2、R-8、R7）③ 低危登记项处置；OS 网络沙箱 / 独立 malformed ACP / 跨重启 durable death proof NOT VERIFIED/DEFERRED 不变 | **PASS candidate** |
| **D4-04 纵向冒烟**：一工具真实流程记录；真实产物、停止、撤权可核查 | `tests/fixtures/d4-04-probe/main.cjs`、`tests/d4-04-smoke.mjs`、`runtime-boot.cjs`、`executor-launcher.cjs`、`side-effect-*.cjs`、`tests/d4-main-e2e.mjs` | `test:d4-04` **94/94**；Closure-3 **67/67**（`e989842`）；撤权 R1/R2；executor-unavailable；**D4 Main-Entry E2E Closure-6 `3c9659a` 在真实 `electron/main.cjs` 下经产品入口复验五条必需流程（含追加步骤 → 预算停止 → UI 显式续接），Gate `120/120`、exit 0** | probe gate 宿主仍为 probe host；真实 main 五条必需流程已用产品入口复验（追加入口 `5577e82`、工具授权 `4e8c6c1`、明确拒绝修复 `81ced49`）；服务层与真实 main 的差异仅在不可达拒绝项（无产物/未决副作用等，见 `docs/D4-PRODUCT-MAIN-E2E-RESULT.md` §8/§9） | **PASS（限定范围）** |
| **D4-05 执行关卡**：门控验收，未通过禁止扩展真实工具面 | `task-service.cjs`、`task-bootstrap.cjs`、`memory-context.cjs`、`harness-model-adapter.cjs`、AI 面板 | `test:d4-05` **173/173 functional**（D4-05 Closure-5 `81ced49`：新增 S1 denied-write 4/4；S1 正式链 A33、S2/S3、S4 记忆装配 + 信任分层），`overallStatus=PASS`，S1/S2/S3/S4 全 PASS；真实 Electron 记忆 UI 15/15；**D4 Main-Entry E2E Closure-6 `3c9659a` 真实 main 下 S1 拒绝闸门（流程3）+ 授权/撤权链路 + 追加步骤/预算续接全链 PASS** | 真实 `main.cjs` 全流程 = **PASS（Main-Entry E2E Closure-6 `3c9659a`：五条必需流程含追加步骤/预算停止/UI 续接经产品入口 PASS，Gate `120/120`、exit 0）**；追加 run 复用 D4-05 S4 的 per-run 受控装配（未单独重测记忆删除/撤权对追加 step 的影响）；S4 = PASS **限定“消息结构 + 授权/执行边界”**（不证明抗真实模型提示注入）；见 §2/§10 | **PASS** |
| **D4-06 关联链与预算停止**（§41） | `task-service.cjs`、`task-harness-orchestrator.cjs`、`task-store.cjs`、D4-05 recovery | `test:d4-06` **119/119**；`test:d4-06-resume` **21/21**；失败验证 UI `test:d4-08-verification-ui` **22/22**；`test:d4-08` **13/13** | 上层收敛为 TaskService 合同验证；失败验证 UI 已由 D4-05 Closure 切到 official dsh facade 正式链（见 §2.5）；真实 main.cjs 已由 Main-Entry E2E Closure-6 全流程复验（含追加步骤 → 预算停止 → UI 显式续接）；追加不改变任务级账本 authorized | **PASS** |
| **A14–A19** | 见审查轮报告 | D4-01/02/03 真实证据；A15 复用 | Windows / External Provider | **PASS**（复用） |

## 2. 重点审查发现与本轮修复

### 2.1 D4-05 S1 失败证据（A33）—— 已修复：失败 Verification 持久化（v15）
- 原缺口：`task_verifications.artifact_id NOT NULL` 只允许 Artifact 提交时的 PASS；schema/adapter verify 失败 0 记录，`verify` 的 `{expected,actual}` 被丢弃。
- 修复：**schema v15 最小兼容迁移**（`task_verifications` 重建为 `artifact_id` 可空 + `step_id/run_id/execution_id`，旧行原样复制、索引重建）；`TaskService.recordVerificationFailure`（owner/app 隔离；`status=FAIL`、`artifact_id=null`、`safe_details{method,expected,actual,evidence.executionId}`；expected/actual 有界（≤200）且去敏键/私有路径/`mpx_`/`tpx_`；**不建 Artifact、不改 Step/Task 终态**）；`ControlledToolProxy` 注入 `taskService`，在 `OUTPUT_SCHEMA`/`ADAPTER_VERIFY` 失败时先落证据再 `#finishExecution`；`task/get` 返回 safe verifications；UI 在 BLOCKED+FAIL 时显示 `data-ai-verification`（检查方法/预期/实际/证据），绝不显示成功。
- 实测：`tests/d4-07-verification-persistence.test.mjs` **5/5**（失败=1 FAIL/or Artifact=0/Step·Task BLOCKED；成功=1 Artifact+1 PASS 无回归；同盘重开证据完整；跨用户 `TASK_FORBIDDEN`；证据脱敏）；`tests/d4-05-s1-output-size.test.mjs` 失败断言更新为新契约（1 FAIL / 0 Artifact）；`tests/migration.test.mjs` 新增 v14→v15（旧 PASS 行保留 + 新列可用），migration 集合 **27/27**。
- **A33 结论不变**：工具报告成功但产物不符 → Task 不得标成功（BLOCKED、0 Artifact、无重试）。

### 2.2 D4-05 S2 人工确认（结果未知）—— 含义与入口（审查轮结论不变）
- 用户能找到待核查对象（`task/get.recovery`/`task/recovery`：callId/toolId/status/errorCode/核查结论/关联产物，脱敏）；“确认”= “我已人工核查”，只追加 safe event，**不表示成功、不解除 UNKNOWN_EFFECT、不授权重试/续接**；非 owner（真实用户 dana）读写均 `TASK_FORBIDDEN`；重复确认幂等；无产物时显示“无”。

### 2.3 D4-05 S4 记忆越权（A36）—— PASS（Closure-3 闭合；Closure-4 修复信任分层并收窄结论）
- **检索链 = PASS（正负对照）**。**上下文链 = PASS（限定“消息结构 + 授权/执行边界”）**：`electron/memory-context.cjs` 受控装配 + `HarnessModelAdapter` 唯一出站口逐请求重装配；每次发送前 `validateSession`→授权检索（agent）→逐条 `getCapabilities`+`readText` 最后检查；无缓存、无权限不注入、删除/撤权/切账号/跨范围皆隔离、续接重检。
- **Closure-4 更正**：记忆正文**不再**作为 `role:"system"` 注入，也不再依赖 “NOT a system instruction”/正文标记；改为 `name:"openarc.reference_data"` 的 **user** 低信任参考消息（JSON 转义、结构不可注入）+ `name:"openarc.rules"` 常量 system 规则（零资源文本）；清理只按应用结构标签；`messages` 结构不安全 → 403。
- **边界（重要）**：这些测试证明消息结构、逐请求授权与执行边界（越权 WRITE 仍走 `ControlledToolProxy`/审批、0 自动批准），**不证明真实模型绝不遵循恶意记忆指令**；真正兜底是后端权限/审批。故 **S4 与 D4-05 = PASS（限定范围）**；详见 `docs/D4-05-CLOSURE3-RESULT.md`、`docs/D4-05-CLOSURE4-RESULT.md`。

### 2.4 预算实际值 / 停止原因 / 追加账本
- 根因：① `getBudgetLedger().base` 硬编码 `BUDGET_BASE`，忽略实际配置；② `HarnessAdapter.budgetExhausted()` 先判 MODEL_CALLS，工具预算真实耗尽被掩盖；③ 成功 prompt 后即使 TOOL_CALLS 已 EXHAUSTED 仍会 commit success。
- 修复：`TaskService.attachBudgetConfig({modelMaxCalls,toolMaxCalls,maxToolRounds})`（缺失回退默认），`base`/`nextGrant.amount` 用实际额度；`budgetExhausted()` 改为 **TOOL_CALLS 优先** 并返回只读脱敏 `observed{model,tool}`；orchestrator 每次 prompt 成功后若 TOOL_CALLS EXHAUSTED 立即 `BUDGET_EXHAUSTED{TOOL_CALLS}` + `task.budget_exhausted{observed}`（0 成功提交、0 后续调度）。
- 实测：`tests/d4-07-budget-consistency.test.mjs` **3/3**；`d4-05-s3` 四类预算 **4/4**（`base={8,1,4}`、`nextGrant={TOOL_CALLS,1}`、additions 仅 1 条同 kind）。**①②③ 已修复**。
- **已修复（D4-06 Closure，schema v16 `task_budgets`）**：保留 capability 按 run 签发，任务层维护跨 run 累计预算（每类 `authorized/consumed/remaining`）。一次续接**只抬升被批准 kind** 的 authorized，其他种类继承剩余；新 run 的 model/tool capability 额度 = 该类 remaining、轮次上界 = `min(MAX_TOOL_ROUNDS, remaining.TOOL_ROUNDS)`；run 结束一次性按真实计量扣减（失败/重复/在途不重不漏）；某类 remaining==0 → 不创建 run、直接 `BUDGET_EXHAUSTED`（不偷补）。旧任务无可靠消耗证据 → 保守基线（consumed=authorized 或 0）并落 safe baseline 事件，不反推历史。
- **before → after（真实链路）**：MODEL_CALLS M{8,8,0} T{100,7,93} R{4,0,4} → grant M+8 → M{16,8,8}（T/R 不变）；TOOL_CALLS M{100,10,90} T{2,2,0} R{4,0,4} → grant T+2 → T{4,2,2}（M/R 不变）；TOOL_ROUNDS M{8,0,8} T{8,0,8} R{4,4,0} → grant R+4 → R{8,4,4}（M/T 不变）。
- 实测：`tests/d4-08-budget-carryover.test.mjs` **13/13**（三类各自 before/after、实际调用次数受 remaining 约束、并发续接只一次、再耗尽/撤权/UNKNOWN、UI==账本==运行时、TOOL_CALLS 正反对照）。

### 2.5 失败 Verification 的 Electron UI 实测（D4-06 Closure 补齐）
- 新增 `tests/d4-08-verification-ui.mjs` + 真实 Electron probe：test-only 尺寸探针经**产品 TaskHarnessOrchestrator + 产品 ControlledToolProxy + 真实 TaskService/DB** 触发 `ADAPTER_VERIFY` 失败 → Task/Step BLOCKED、0 Artifact、1 条 FAIL verification；真实 Renderer 显示 `data-ai-verification`（检查方法 ADAPTER_VERIFY / 预期 / 实际 / 证据 executionId，**不显示成功**）；Reload 后从 `task/get` 恢复一致；非 owner（第二真实用户）读写均 `TASK_FORBIDDEN`、UI 不可见。实测 **22/22**。
- **D4-05 Closure 更新（限制已消除）**：该 UI 探针现已走 **official dsh facade 正式链**（产品 TaskHarnessOrchestrator + 产品 ControlledToolProxy + deterministic provider `mode=sized`），不再使用 synthetic ACP fallback；新增 A33 闸门后，READ_ONLY 必需产物验证失败确定性地 → Task/Step BLOCKED + 0 Artifact + 1 FAIL Verification（`test:d4-08-verification-ui` 22/22，`officialDshFacade=true`）。

### 2.6 失败 Verification 的解决关联（D4-05 Closure-2 修正）
- **原漏洞**：Closure-1 的 `getUnresolvedRequiredVerificationFailures` 按裸 `tool_id` 的“最近一次验证结论”判定解决，导致同一工具对象 A FAIL、对象 B PASS 时 B 的无关 PASS 误清除 A 的 FAIL（正式链已复现：Task SUCCEEDED + 1 Artifact 而 A 的 FAIL 未解决）。
- **修复**：关联键改为 `(tool_id, canonical arguments)`（`task_tool_proposals.arguments_hash`）；同一键内顺序敏感（FAIL→PASS→FAIL 仍未解决）；缺 `arguments_hash` 的旧数据用 execution 唯一键保守保持未解决；返回 `resolved{failedExecutionId→resolvedByExecutionId}` 可追溯；原始 FAIL 绝不删改。
- **关联隔离证据**：`tests/d4-05-s1-facade-association.test.mjs` **6/6**（无关对象 / 无关要求 / 无关 Step 不误清除；有效纠错可成功并关联；DB 重开一致；普通工具错误语义不变）。`test:d4-05` **139/139 functional**；`test:d4-08-verification-ui` 22/22 无回归。
- **支持范围（如实）**：产品未区分“必需/探索”工具契约；`verification_status=FAIL` 仅由“工具 `execute` 成功但 `OUTPUT_SCHEMA`/`ADAPTER_VERIFY` 失败”写入，DENY/执行错误不参与判定；跨 run/跨 step 无可达纠错入口，未新增恢复能力。

## 3. 仍未验证的能力及其对收口的影响

| 能力 | 状态 | 对 D4 收口的影响 |
| --- | --- | --- |
| D4-03 封板（须由实现方之外的审查者裁决） | 内部独立预审完成（两轮：13 项缺陷闭合）；**未封板** | 缺：① 由实现方之外的审查者（原文指名 ChatGPT）作出的 PASS/FAIL 裁决；② 三项产品语义裁决：REV-03/S2（approval 是否绑定 approver 后续权限）、R-8（旧任务未绑定窗口的归属策略）、R7/R6-C2/C3（DENY 状态前置与抑制结果分类）；③ 低危登记项处置（R3/R4/R-4'/N-1/R-6/[REDACTED] 误拒）。审查输入包见 `docs/D4-03-INDEPENDENT-REVIEW.md` §7 |
| D4-03 外部审计封板 | PASS candidate | 影响“D4-03 = PASS”的正式性 |
| Windows / External Provider | NOT VERIFIED | D4-01/D4-02 overall = PARTIAL |
| OS 级网络沙箱 / external workspace read audit / independent malformed ACP injection | NOT VERIFIED | 安全纵深挂账，不属 D4-05 四场景 |
| 跨重启 authenticated durable process-death proof | DEFERRED / NOT VERIFIED | 当前 fail closed 到 UNKNOWN_EFFECT |
| 失败 Verification 的 Electron UI | 已实测 22/22（**official dsh facade 正式链**，D4-05 Closure `70eb0b1`） | 已满足；原 fallback 链路限制已消除（见 §2.5） |

## 4. 唯一推荐的下一阶段任务

**D4-03 独立预审已完成（两轮，13 项已确认缺陷闭合；见 `docs/D4-03-INDEPENDENT-REVIEW.md`）**：REV-01 / F-1 / R-1 / R-2 / R-3 / R-5' / F-2 / R-7 / R-9 / S1 / S1-b / A-4 / R-1' 全部由同一独立审查者复核 CLOSED。**D4-03 仍为 PASS candidate（不封板）**——封板要求“由实现方之外的审查者裁决”，本轮审查者与实现方同源；另有三项产品语义裁决待决（REV-03/S2、R-8、R7/R6-C2/C3）。路线图下一个正式阶段为 **D5-01 浏览器**（`PLAN.md:501`；前置 D2、D3-05、D1-01，PLAN 依赖表未把 D4 列入其前置）；D5-02/03/06/08 以 D4-05（已 PASS）为前置。建议在进入 D5 前完成 D4-03 封板裁决与上述三项语义裁决。D4 整体仍为 **PARTIAL**：D4-01/D4-02 Windows / External Provider NOT VERIFIED、D4-03 待封板。

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
- 当时 D4-05/D4 保持 **PARTIAL**；不因两个缺口修复而升级（该记忆上下文缺口后由 D4-05 Closure-3 闭合）。
- “测试环境等价”不等于“真实 `electron/main.cjs` 全流程已实测”。

## 7. 受控 memory 装配最小方案（**已由 D4-05 Closure-3 实施**；以下为当时方案）

- **记忆来源**：`Resource type=memory`（D3-04B），subtype = personal-preference / project-memory / decision-memory / conversation-memory / agent-memory；只取用户本人或被授权项目的记忆，不取跨组织/他人记忆。
- **检索范围**：经 `SearchService`/`ResourceService` 的**授权过滤**查询（同 D3-05 Gate-Search），限定 task 的 user + app + project/department；按相关性 + 上限条数/字符数取最小必要片段。
- **权限检查时点**：**装配时**（task 启动/组装 prompt 前）与**每次受控读取时**都重新授权；memory 高敏——全局 grant 不覆盖（D3-02 §25），必须有显式 Resource-Type/Resource/Collection grant；无授权则 0 注入。
- **删除与切账号处理**：删除仍走现有删除路径（资源删除 + 派生索引移除，已由检索链验证）；装配每次实时读取，不缓存跨会话 → 已删记忆下个任务即不可见；切账号后授权过滤使他人/已删内容不进入上下文。
- **是否进入模型请求**：进入——但**仅授权且最小化的片段**（有界长度、脱敏、无凭据/绝对路径）；绝不 dump 全部记忆或完整文件。
- **留存方式**：**不**为“证明隔离”而持久化完整私人记忆或模型请求正文；只保留 safe 引用（resourceRef/artifactId/checksum）与授权/审计记录；隔离用确定性 provider 的 test-only 唯一 token + 正负对照验证（授权可见且注入 / 已删·他人不出现）。
