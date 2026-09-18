# D4-03 独立审查与 D4 阶段收口（Independent Review · 2026-09-18 · v2：F-2 修复 + 未关闭项逐项澄清）

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`；分支：`feature/d4-03-tool-proxy`
- **本轮 Base HEAD**（开工核对，干净）：`f1bff21612f08a50d80c108dbbed24f4222b5eb2`
- **本轮代码/测试提交（被测 commit）**：`c7302dcbeaca58a904c9f31f70bada3b931187ec`（提交后工作区干净；不含 docs）
- 前序审计提交：`f63e87ac5390e65fd733bf6467f693a5cc67a4f1`（REV-01 / F-1 / R-1 / R-2 / R-3 / R-5' 修复）、`5577e82` + `3c9659a`（追加步骤入口）、`c83e486`（Closure-6 报告）
- **报告/证据提交**：本文件 + `docs/D4-ACCEPTANCE-RESULT.md` + `PROGRESS.md` + `docs/decisions/D4-03C-side-effect-authority.md`（新事件登记）+ `docs/D4-04/05/06-GATE-EVIDENCE.json` + `docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`
- 远端：`origin/feature/d4-03-tool-proxy = 67357ef`、`origin/main = 823242a`（未 push、未合并 main、未触碰默认工作区）

## 0. 结论摘要（三态严格区分）

| 状态口径 | 含义 | 本轮适用 |
| --- | --- | --- |
| **实现方已修复** | 执行岗已提交代码/测试 | REV-01、F-1、R-1、R-2、R-3、R-5'、**F-2**、**R-7**、**R-9**、**S1**、**S1-b**、**A-4**、**R-1'** |
| **内部独立复核通过** | 未参与实现的独立审查者在冻结修订上复现并判 CLOSED | 同上 13 项（四~七轮复核；含真实双进程/真实 Bridge/全库扫描/parity 对照） |
| **仍待 ChatGPT 审计** | 由实现方之外的审查者作出的封板裁决 | **全部**：本文件的 CLOSED 一律止于内部独立复核，**不等于外部审计通过**，D4-03 仍为 PASS candidate |

1. **F-2 已按既有契约修复（未降低 ADR 要求）**：真实产品入口 `task/run` 由后端解析并冻结 model config id/version；版本变化时 run / 追加步骤 / 显式续接三入口一律显式 `MODEL_CONFIG_CHANGED` 并收敛 BLOCKED；默认切换不会静默跟随；旧任务采用显式懒绑定兼容（不伪造历史版本）。独立复核 CLOSED（隔离树与冻结树真实 main E2E `133/133`、flow6 `13/13`、exit 0）。
2. **未关闭项已逐项澄清**（§4）：其中 **S1-b、A-4、R-7、R-9、R-1'** 属明确违反既有契约或契约字面冲突，已最小修复 + 独立复核 CLOSED；其余为契约允许行为、不可达隐患或**需产品语义裁决**的项，已给出选项与影响，未擅自改约定。
3. **D4-03 不封板**：封板要求"由实现方之外的审查者（原文指名 ChatGPT）裁决"，本轮审查者与实现方同源。**D4 维持 PARTIAL**（Windows / External Provider 等既有项不变）。

## 1. 依据：原始要求与封板条件

| 出处 | 原文要点 |
| --- | --- |
| `PLAN.md:498` | `D4-03 工具门与租约 \| 后端、运维 \| D4-02、D3-03 \| 授权执行及回报 \| 重复调用与离线结果处理正确` |
| `PLAN.md:497` | `D4-02 任务与适配 \| 后端 \| D4-01 \| 任务状态及 Harness 适配 \| 任务版本固定且权限实时有效`（F-2 的契约来源） |
| `docs/D4-03C4-RESULT.md:14` | "DeepSeek 无权正式封板；由 ChatGPT 审计后决定 `D4-03C = PASS`。" |
| `docs/decisions/D4-03C-side-effect-authority.md:511` | "…`D4-03 overall = PASS candidate`（DeepSeek 无权封板，由 ChatGPT 审计后决定 `D4-03 = PASS`）。" |
| 同 ADR `:132-134 / :165 / :118 / :156` | 终态必终结 lease；UNKNOWN_EFFECT → VERIFY → BLOCK、禁止 retry；重启用"非本进程 ACTIVE lease→EXPIRED"且本进程 lease 保留；Audit/TaskEvent 冻结清单 |

## 2. 审查者独立性、范围与轮次

- **独立性**：两名独立审查子 Agent，均在派工前从未接触对应实现；全程**只读仓库**（入场/离场 `git status`、关键文件哈希一致）；探针只写 `/tmp`；任务书明确"不得以测试全绿代替审查结论"；与实现方同源 → **内部独立预审，不是外部审计**。
- **轮次**：①初查（六块范围）→②修复复核（REV-01/F-1）→③残留复核（R-1/R-2/R-3/R-5）→④R-5' 确认→⑤**未关闭项逐项澄清**（REV-02/REV-03/A-4/A-5/A-6/S1/S2 与 R-1'/R-4'/N-1/R-6/[REDACTED]/S3）→⑥⑦**修复复核**（F-2；S1/S1-b/A-4；R-1'/R-7/R-9）。
- **范围**：身份/权限/工具范围/批准绑定与撤权；租约/claim/并发/重复副作用；executor 退出与 UNKNOWN_EFFECT 阻断及危险重放；配置变化/预算停止/续接/追加是否绕过工具边界；验证失败/被拒/结果未知是否被最终文本掩盖；工具协议输入与持久化信任边界。**限定 D4-03 及已发生变更的相关边界**，未扩成全仓库审计。
- **方法**：先自行写出不变量，再找反例；复用同代码同环境既有验证，仅对具体疑点补有区分力的探针（`/tmp/rev/**`、`/tmp/probe-*`、`/tmp/d403*`）；修复后由**同一审查者**在冻结修订上重跑并给 CLOSED。

## 3. 已确认缺陷：位置 / 测试 / 被测 commit / 预期 / 实际 / 三态

| # | 发现 | 代码位置 | 测试名称 | 被测 commit | 预期 | 实际（复核证据） | 三态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **REV-01**（高）第三条启动入口无未决副作用守卫 → 可在 UNKNOWN_EFFECT 期间执行第二条 WRITE 并把任务写成 SUCCEEDED | `task-harness-orchestrator.cjs:141-156`、`task-service.cjs #sideEffectSafety/getSideEffectSafety` | `tests/d4-03-run-entry-guard.test.mjs`（7） | `f63e87a` | 拒绝 + 0 状态变更 + 恢复入口保留 | `RUN_BLOCKED_UNRESOLVED_SIDE_EFFECT/UNKNOWN_EFFECT`；revision/step/run/call/lease/event/artifact 全表零变化；无第二条 call（真实双 runtime 探针） | 已修复 ✅ / 复核 CLOSED ✅ / 待外部审计 ⏳ |
| 2 | **F-1**（中）声明为 string 的工具参数原样落库（绝对路径 / 明文 `tpx_` / secret 形态），违反 tool-store 与 bridge 明示契约 | `controlled-tool-proxy.cjs:95-110`、`tool-domain.cjs redactProjectedArguments` | `tests/tool-argument-projection-redaction.test.mjs` | `f63e87a` | 落库去敏、执行入参不变 | 直连 Bridge / 真实 dsh / 真实 WRITE 全链 / 全库 63 表扫描 残留 0；执行入参对 HEAD 逐字符一致 | 已修复 ✅ / 复核 CLOSED ✅ / ⏳ |
| 3 | **R-1**（低-中）非 macOS 绝对路径仍明文落库 | `tool-domain.cjs UNSAFE_PATH_PERSIST_RE` | 同上（r1） | `f63e87a` | 常见系统根/POSIX 多段/盘符/UNC/file:// 全去敏 | 7 条路径残留 = [] | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 4 | **R-2**（低-中，renderer 可见）失败验证证据第三份更弱判据 | `task-service.cjs EVIDENCE_PATH_RE` | `tests/d4-07-verification-persistence.test.mjs`、`d4-05-s1-output-size` | `f63e87a` | 证据投影复用同一判据 + depth≥2 兜底 | 7 形态 + Windows/UNC/file:// + 深层全部去敏 | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 5 | **R-3**（低）256 截断残留裸路径前缀 | `tool-domain.cjs redactArgumentString` | 同上（r3） | `f63e87a` | 无裸前缀/半段目录/半截标记 | straddle 残留 = false | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 6 | **R-5/R-5'**（低）冷缓存回退静默换参；首版标记判定可被"标记被截断"绕过 | `controlled-tool-proxy.cjs #argsOf`、`tool-domain.cjs` 截断分支 | 同上（r5/r5b） | `f63e87a` | 完整标记 fail closed + 生产侧保证截断后仍含完整标记 | 冷缓存 `TOOL_ARGUMENTS_PROJECTION_UNAVAILABLE`、0 Domain/0 execution；19 变体 + 473 例不变式 battery 违反 0 | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 7 | **F-2**（中）产品入口不冻结 model config → `MODEL_CONFIG_CHANGED` 对产品任务不可达、run 无模型归属 | `task-bootstrap.cjs:131-146`、`task-service.cjs #boundModelConfig/checkModelConfig/startHarnessRun`、`task-harness-orchestrator.cjs runStep` | `tests/d4-03-model-binding.test.mjs`（12：A–J）、`tests/d4-main-e2e.mjs` flow6（13：F6.0–F6.12） | **`c7302dc`** | 产品任务绑定后端配置；改版后 run/append/resume 明确拒绝；默认切换不静默跟随；旧任务显式懒绑定 | 真实 UI 建任务 → task/run/call 行绑定 == Settings 默认；改版后 append → 全 BLOCKED + `MODEL_CONFIG_CHANGED` + 0 capability/0 call/0 artifact + UI 可见；默认切到另一 config 后原任务 append/resume 仍成功且归属不变；旧任务懒绑定事件 + run 归属正确；无默认可解旧任务与 f1bff21 逐字一致（A/B 隔离树） | 已修复 ✅ / 复核 CLOSED ✅ / ⏳ |
| 8 | **R-7**（低）"读取版本后、签发 capability 前"被改版 → 以非冻结版本签发（实测 token 存活 661ms 且直连 200） | `model-proxy.cjs issueCapability(expectedModelConfigVersion)`、`harness-adapter.cjs:191`、orchestrator 预检 | 同上（H/H2） | `c7302dc` | 生成 token 前比对，不等则不签发 | 四个窗口（签发前/直接调用/签发后/真实 facade await）全部收口：无 token、capabilities 不增、直连非 200、run BLOCKED、0 provider | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 9 | **R-9**（低·口径）禁用/删除 config 的阻断码为 `HARNESS_NOT_STARTED` | orchestrator 预检失败集合 | 同上（I） | `c7302dc` | 配置解析类失败在签发前以自身原因码阻断 | 禁用/删除 provider/撤 model grant/移除 capability 四类 → `MODEL_CONFIG_UNAVAILABLE`/`PROXY_UNAUTHORIZED`/`CAPABILITY_UNAVAILABLE`，全 BLOCKED、0 capability、0 provider；恢复后新建任务正常 | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 10 | **S1**（高）迟到终态（SUCCEEDED）无条件覆盖另一 runtime 的 UNKNOWN_EFFECT → 任务卡死、恢复入口消失 | `side-effect-authority.cjs #dispatchControlledWrite` 条件写回 | `tests/d4-03-lease-state-integrity.test.mjs`（T4/T8） | `c7302dc` | 仅 RUNNING→终态；否则绝不覆盖并落 late 事件 | 真实双进程：call 保持 UNKNOWN_EFFECT、task BLOCKED、`recoveryApplicable=true`、副作用恰好 1 次、无 succeeded 事件 | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 11 | **S1-b**（同类，复核新发现）失败类迟到写回（`#finishKnownNoEffect`/`#finishUnknownEffect`）同样覆盖权威状态 | `side-effect-authority.cjs` 同上两函数 | 同上（T7/T8-a/T8-b） | `c7302dc` | 同 S1；被抑制时不写任何持久化字段、只幂等终结自身 lease | 双 runtime（Domain 进行中收敛）三类失败结果全部抑制；call 行快照逐字不变；无 FAILED/BLOCKED 覆盖事件；单 runtime parity 与 f1bff21 diff 为空 | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 12 | **A-4**（低）终态 call 遗留 ACTIVE lease（崩溃窗口 + DENY-on-LEASED）→ 本进程内 append/runTask 被 ACTIVE_LEASE 拦死 | `side-effect-authority.cjs #finalizeLeaseInTx / recoverAfterExecutorExit / denySideEffect` | 同上（T1/T2/T3/T7） | `c7302dc` | 终态与 lease 终结同事务；遗留可回收；deny 回收 | 崩溃 seam 观察点已是 `{call:SUCCEEDED, activeLease:null}`；deny(LEASED) → BLOCKED + 0 ACTIVE；归属匹配回收、错配 fail closed；四类收敛路径无"收敛态/ACTIVE"跨事务共存 | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 13 | **R-1'**（低）裸单段绝对路径（`/secret-plan.txt`）与 POSIX 双斜杠（`//x`）明文落库（且 `containsAbsolutePath` 判其为绝对路径） | `tool-domain.cjs UNSAFE_PATH_PERSIST_SRC` | 同上（r1b/r1c/r1d/r1g） | `c7302dc` | 两类形态去敏；拒绝判据与执行入参逐字节不变 | 真实 Bridge 8 例 + 全库 645 单元格 anchored 扫描：目标形态残留 0（f1bff21 对照分别命中）；8 例决策序列 diff 为空；adapter 仍收原文 | 已修复 ✅ / CLOSED ✅ / ⏳ |

**修复引入/未引入副作用的独立结论**：正常单 runtime 路径与修复前**逐字一致**（parity 探针：exec 形状、call 字段、recovery 证据、lease、task/step、safety、Domain 调用数、完整 TaskEvent/audit 序列 diff 为空）；AUTO_RETRY 仍恒为 0；Domain 调用恒 1 次；无新增自动重试/收敛；无越权、无重复副作用、无错误成功。

## 4. 逐项澄清（未关闭 / 未修项，含六要素；均为**内部独立复核**结论）

### 4.1 REV-02 · `acquireLease()` 无身份/授权判定
- **契约与位置**：ADR `:27/:40/:114`；`side-effect-authority.cjs:322-364`。
- **分类**：**契约允许行为 + 加固项**（非可绕过缺陷）。
- **产品可达性与复现**：IPC 只暴露 3 条 approval 命令（`side-effect-bootstrap.cjs`、`preload.cjs`），`acquireLease` 仅由 executor child（`side-effect-executor.cjs:58`，按设计传 `context:{}`）与测试调用。探针：任意 holderId 可获 ACTIVE lease，但执行主体由 task 反推（`:681-683`）并在 eligibility + claim 事务内全量重查（`:751-798`）。
- **后果**：越权否 / 重复副作用否 / 错误成功否 / 永久占用否（DoS 级残余，仍 fail closed）/ 泄漏否。
- **防护层与可绕过性**：防护在 eligibility + claim（不可绕过）；撤权、session 注销、app 禁用、approval 撤销一律 0 Domain 调用。
- **封板影响**：**不阻塞**。登记加固建议：`acquireLease` 内复用 `preflightAuthorization` 做最小权限预检；`_leaseId` test seam 与 ADR`:114`"零 caller override"字面不一致，建议记录或去掉。

### 4.2 REV-03 / S2 · 批准人失权后既有 approval 是否仍有效（**需产品裁决**）
- **契约与位置**：ADR `:26`（Approval 绑定内容+期限+可 revoke，**不含 approver 后续权限**）、`:123/:126`（claim 期"Approval 有效"清单同样不含 approver）、唯一歧义句 `:162`；实现 `side-effect-authority.cjs:751-798`（只重查执行侧主体）、`:405-407`（approval 快照不含 actor）。
- **分类**：**契约未覆盖（口径缺口）**，非实现偏离。
- **产品可达性与复现**：ADMIN 可批准他人任务（`:265`）；`onApprovalRequested` 推送无 session 过滤（`identity-bootstrap.cjs:140`、`side-effect-runtime.cjs:110`）→ UI 可达。实测：admin 批准 alice 任务后 admin 被 DISABLE/DEMOTE → 仍 `leaseOk+execOk+1 mutation`；对照注销 alice session → `AUTHORIZATION_REVOKED`/0 mutation。
- **后果**：**条件性越权**（取决于产品口径：批准人失权是否应使 approval 失效）；执行主体始终被重查；无重复副作用/错误成功/泄漏。
- **防护层与可绕过性**：批准时刻防护有效且不可伪造；执行期**approver 维度无防护**（契约未要求）。
- **封板影响**：**不阻塞安全封板，阻塞口径完整性**。选项：**(A) 仅文档化**（ADR 写明"Approval 是内容授权 + TTL，approver 后续失权不影响已批准 call，须显式 revoke"，零代码，并登记"产品无 revoke 入口"）；**(B) 执行期重查 approver**（eligibility/claim 加入 `approverUserId` 重查，语义变更：批准人失权 ⇒ 已批准 call 失效）。**本轮未改，待裁决。**

### 4.3 A-5 · 跨任务同资源操作（**契约允许**）
- **契约与位置**：ADR `:27`（Lease 非业务锁）、`:138`（Domain 事务内乐观并发）；`tool-adapters.cjs:55-66`、`#preconditionsOk`、`#authorizeLive`、`resource-service.cjs:687-716`。
- **分类**：契约允许行为（Domain 兜底有效）；"是否提升到资源维度互斥"属新功能。
- **产品可达性与复现**：admin task1 + alice task2 同资源各自真实批准：task2 先执行 1 mutation SUCCEEDED；task1 后执行 `leaseOk:true` 但 `SIDE_EFFECT_AUTHORIZATION_REVOKED`、**0 第二次 Domain 调用**、败者经 `recoverAfterExecutorExit` 收敛 FAILED 并回收 lease；trash 不改 version，真正判据是 `trash_state`/`registry_status`。
- **后果**：越权否 / **重复副作用否** / 错误成功否 / 永久占用否 / 泄漏否。
- **防护层与可绕过性**：跨任务只"绕过"第一道（task 维度安全扫描），claim 期实时授权 + Domain 乐观并发两道 fail closed。
- **封板影响**：**不阻塞**；资源维度互斥需显式产品需求（本轮**不做**）。

### 4.4 A-6 · `status=BLOCKED` 被安全判定视为安全（**未验证疑点**）
- **契约与位置**：`side-effect-authority.cjs #finishKnownNoEffect`（`knownNoEffect ? FAILED : BLOCKED`）；`task-service.cjs #sideEffectSafety` 视 BLOCKED 安全。
- **分类**：**仍未验证的疑点**（不写成已确认漏洞）。
- **产品可达性与复现**：用 test-only 说谎 adapter 可证明"该模式危害成立"；生产 adapter 的 mutation 与返回值同源（`resource-service.cjs:698-713` 单事务，失败回滚），**构造不出**"已生效却为 BLOCKED"。
- **后果**：理论（仅谎报 adapter）/ 生产不可达 / 无越权、错误成功、泄漏。
- **防护层与可绕过性**：adapter 白名单 + Domain 事务原子性；被绕过前提是未来 adapter 自己说谎。
- **封板影响**：**不阻塞**；登记为**未来 REVERSIBLE_WRITE 工具的准入门槛**（新增工具必须证明 mutation 与结果同源）。

### 4.5 S3 · `identity-store.transactSync` 无连接内互斥 / 与异步 `transact` 交错（**当前不可达的结构性隐患**）
- **契约与位置**：`identity-store.cjs:1234-1250`（注释已在本轮更正为如实描述："连接级同步事务，BEGIN IMMEDIATE 在 try 外、无连接内互斥，事务体内绝不能有 await"）。
- **分类**：结构性隐患，**当前 commit 生产不可达**。
- **产品可达性与复现**：6/6 异步 `transact` 事务体全同步、KDF 均在事务外；SQL 级插桩（包装 `DatabaseSync.prototype.exec`）跑 74 个进程 / 22308 BEGIN → `nestedBEGIN=0`、orphan=0；失效形态是"第二个事务硬失败"，非数据损坏。
- **后果**：均否；若未来有人在事务体加 await → 窗口内同步写硬失败（若被静默 catch 则丢写）。
- **防护层与可绕过性**：仅 `transact()` 的队列；同步路径靠 SQLite 自身报错 fail closed；不可被 Harness/用户远程触发。
- **封板影响**：**不阻塞**；登记硬化项（连接级 `isTransaction` 断言 + 禁止 await 的显式声明），本轮仅更正注释。

### 4.6 R-8 · 旧任务"未绑定 + 默认迟到"窗口（**需产品裁决**）
- **契约与位置**：F-2 的兼容策略（`startHarnessRun` 懒绑定）；`task-service.cjs`。
- **分类**：契约**未规定**的兼容窗口（设计取舍）。
- **产品可达性与复现**：旧任务 `startHarnessRun` 时无默认可解 → 保持未绑定；默认若在 capability 签发前出现 → 以当前默认真实执行（SUCCEEDED、1 provider 请求、1 artifact），而 task/run/call 行归属仍为 `null`（探针 X3）。
- **后果**：无越权/重复/错误成功/泄漏；**审计归属缺失**（该窗口内运行期模型不可查）。
- **防护层与可绕过性**：无（属兼容策略本身）。
- **封板影响**：**不阻塞**；选项：**(a)** `checkModelConfig` 处也尝试懒绑定（只缩小窗口）；**(b)** 未绑定则拒绝签发 capability（闭合但给旧任务新增失败面，与"不新增失败面"取舍冲突）；**(c)** 完成时按 capability 的 resolved config 事后补记归属（不改可用性，只补审计）。**本轮未改，待裁决。**

### 4.7 R7 · 并发 trusted DENY 期间的迟到抑制（**本轮复核新发现，低危，需语义裁决**）
- **契约与位置**：`denySideEffect` 无状态前置（`side-effect-authority.cjs:291-310`）+ 本轮 S1/S1-b 抑制出口 `#lateResultSuppressed`。
- **分类**：**语义边界问题**（非越权/非重复副作用）。
- **产品可达性与复现**：需在执行器 in-flight 期间发生一次 trusted DENY（UI 正常流程在 spawn 前已消费提示，需重复/陈旧决策、第二窗口或直接 IPC）。实测：deny@claim + ambiguous → call BLOCKED/APPROVAL_DENIED、task RUNNING、`recoveryApplicable:false`、无 blockStep（基线 f1bff21 为 UNKNOWN_EFFECT + 全 BLOCKED）；deny@mutation 后 verified PASS → **trashed=true 但 call BLOCKED**、verificationStatus null（基线为 SUCCEEDED）。
- **后果**：无越权/重复副作用（`resource.trash` 二次 trash 被 Domain 拒绝）/无泄漏；**状态表达不精确**（效果已发生却记 BLOCKED，且无恢复入口）。
- **防护层与可绕过性**：S1/S1-b 的"绝不覆盖"是**有意**的（保护另一写者的权威状态）；缺的是"被抑制方的结果分类"。
- **封板影响**：**不阻塞**；选项：**(A)** 抑制事件 payload 增加 safe 结果分类（`resultClass=UNKNOWN_EFFECT/KNOWN_NO_EFFECT/VERIFIED_APPLIED`）；**(B)** 当 `observedStatus !== UNKNOWN_EFFECT` 且本 runtime 结果为 ambiguous 时仍 `blockStep`（由第一写者之外的写者承担失败关闭）；**(C)** 给 `denySideEffect` 加状态前置（仅 AWAITING_APPROVAL/APPROVED 可 deny）。**本轮未改，待裁决。**

### 4.8 R6-C2/C3 · trusted DENY 覆盖 UNKNOWN_EFFECT / SUCCEEDED（**pre-existing，非本轮引入**）
- **契约与位置**：`denySideEffect` 无状态前置（同上）；复核实测 deny 可把 UNKNOWN_EFFECT（甚至已验证 SUCCEEDED）改写成 BLOCKED/APPROVAL_DENIED。
- **分类**：**已确认缺陷（pre-existing）**，属 4.7 的根因之一（DENY 缺状态前置）。
- **产品可达性与复现**：同 4.7 的 trusted-user 触发条件；对 `resource.trash` 无重复副作用/无假成功（效果真实存在，仅状态表达被改写）。
- **后果**：无越权/重复/泄漏；**状态权威被 trusted 用户动作改写**，恢复入口可能消失。
- **防护层与可绕过性**：无（deny 无前置）；但需要 trusted user 在 in-flight 期间动作。
- **封板影响**：**不阻塞**（pre-existing、需 trusted 用户、无越权/重复）；与 4.7 选项 (C) 一并裁决。

### 4.9 R3 / R4 · 租约收敛的两个低危残留（**登记，不阻塞**）
- **R3**（合成态）：`recoverAfterExecutorExit` 终态回收依赖 `activeLeaseOfCall` 取最新一条，多条 ACTIVE lease 的排序可致匹配 lease 不被回收（真实 API 造不出该态）。
- **R4**（低）：`recoverAfterExecutorExit` 的 LEASED→FAILED 与 `releaseLease`（electron/ 无生产调用方）为两事务拆分，窗口产物是"LEASED + 无 ACTIVE lease"（**不违反** ADR`:132-134`），缺幂等自愈入口但可 re-acquire。
- **后果**：均无越权/重复/错误成功/泄漏；**封板影响：不阻塞**。

### 4.10 R-4' · 过度遮蔽（**有意取舍，数字更新**）
- **契约与位置**：`tool-domain.cjs` 落库/投影判据（比拒绝判据宽，见注释）与 `SECRET_VALUE_RE`。
- **分类**：契约允许行为（可读性/取证保真代价）。
- **可达性与复现**：同语料实测 `0.55% → 1.82%`（新增裸单段分支为主；双斜杠分支仅 +1 例）；prose 密集语料 `0.68% → 3.45%`；病态长串最坏 2.9ms（无 ReDoS）。
- **后果**：**反向**（不增加泄漏）；影响面：失败 Verification 证据展示（≤400 字）与落库审计文本；Approval UI 不展示参数；denied 面板实际≈0（唯一 WRITE 工具参数是 `resource://id`）。
- **防护层与可绕过性**：无需防护；边界由投影 256/271 与证据 200 字兜住。
- **封板影响**：**不阻塞**；建议保持现状（放宽会比漏路径代价更大），审计口径按上述数字登记。

### 4.11 N-1 · 去敏投影长度上界（**信息级，已入注释**）
- **契约与位置**：`tool-domain.cjs` 投影判据；列 `arguments_safe TEXT` 无长度约束。
- **分类**：契约允许（文档口径差 ≤15 字符）。复现：20000 例 battery MAX=`271`（=256 + 标记余量）。
- **后果**：均否。**防护/绕过**：无需；**禁止 clamp**（会切半完整标记、破坏 R-5' fail-closed 不变式）——本轮已把该结论写进代码注释。
- **封板影响**：**不阻塞**。

### 4.12 R-6 · 执行入参缓存条目无字节上限（**条件性硬化项**）
- **契约与位置**：`controlled-tool-proxy.cjs EXECUTION_ARGUMENTS_MAX=64`（仅条数上限）；`tool-domain.projectArguments` 数组/对象元素不递归有界。
- **分类**：当前生产**不可达**的潜在风险。复现：内置 contract 单条 273B、64 条 ≈17.5KB；test-only array contract 可造 32MB/条 × 64 = 2GB（落库侧被递归去敏+截断限住）。
- **后果**：仅潜在进程内内存放大（FIFO 可回收、不落盘）。**防护/绕过**：条数 64 + Bridge 256KiB body cap；contract 只能由 trusted code 注册。
- **封板影响**：**不阻塞**；登记为"**新增任何带 array/object 属性的 Tool contract 之前必须加字节预算**"的前置条件。

### 4.13 [REDACTED] 字面量误 fail closed（**可用性取舍，保持**）
- **契约与位置**：`controlled-tool-proxy.cjs #argsOf`（完整标记 fail closed）。
- **分类**：契约允许行为（fail closed 的必然误报面）。复现：合法 ALLOWED 值字面含 `[REDACTED_PATH]` + 冷缓存 → `TOOL_ARGUMENTS_PROJECTION_UNAVAILABLE`、0 执行；热缓存正常且 adapter 收原文。
- **后果**：仅可用性（最坏该 step BLOCKED，可 resume/append 恢复）；无越权/泄漏/静默换参。**防护/绕过**：该拒绝方向即安全方向。
- **封板影响**：**不阻塞**；建议保持并如实登记。

### 4.14 两个微项（**登记**）
- 抑制分支在 known-no-effect 场景返回 `knownNoEffect:false`（保守，仅影响返回值语义）。
- `#lateResultSuppressed` 直接解引用 call；当前无任何 `DELETE FROM side_effect_calls` 路径，属理论项。

## 5. 经核对未发现问题的方面（不变量 + 依据）

1. **claim-time TOCTOU 重校验有效**：审查者自建"eligibility 后、claim 前"注入撤权矩阵 **6/6 fail closed、0 Domain 调用**（app 禁用 / tool grant 撤销 / session 撤销 / 用户禁用 / resource grant 撤销 / useByAgent 撤销）；claim 在同一 `BEGIN IMMEDIATE` 内重读 task/cancel/RUNNING/actor/app/step/run/tool 版本与 effectClass/`#authorizeLive`/preconditions/approval 全字段/active lease（leaseId+holderId+runtimeInstance+有效期）。
2. **approval 精确绑定**：planHash/argsHash/toolId/version/effectClass 逐项比对；篡改 `approvedToolId` → PLAN_STALE。
3. **结构上不可能第二次 claim**：枚举全部 `updateCall` 调用点；进 LEASED 只有 `acquireLease`、进 RUNNING 只有 claim；`releaseLease` 在 `electron/` 内无调用方。
4. **并发/重复投递**：同 callId + 同 toolId + 同 canonical args 指纹 → 同 outcome（0 额外执行/预算）；callId 冲突 → `409 TOOL_CALL_ID_CONFLICT`；maxCalls=1 并发 unique call 恰好一个成功。
5. **idempotency**：`UNIQUE(idempotency_key)` + 同绑定校验。
6. **UNKNOWN_EFFECT / quiescence fail closed**：三态只读 recovery verification；`quiesced=true` 只能来自同一存活 supervisor 的真实 `child.on("exit")`；persisted EXITED / ENOENT / 任意 errno / 超时都不是死亡证明；AUTO_RETRY 恒 0。
7. **resume/append 不绕过工具边界**：最危险状态（BLOCKED + artifact + 未解决 DENIED WRITE + lastRun=预算停止）→ resumable=true 但续接 run 仍被 denied-write 门拦成 `TOOL_FORBIDDEN`、0 执行。
8. **final text 掩盖被两道后端门拦住**（A33 验证失败门 + 被拒 WRITE 门），唯一提交点 `commitStepSuccess`。
9. **Bridge 输入信任边界正确**：body 自报 scope/session/app/task/step/run/proposalId/riskClass/approved/approvalId/leaseId/effectClass/idempotencyKey 全被忽略；WRITE route 不把 Harness callId 当 authority id。
10. **capability 不落库/事件/artifact**：真实 WRITE 全链后全库 63 表 + 事件 + artifact + DSH_HOME 扫描 0 命中（连"工具参数"通道也已去敏）。
11. **失败 Verification 关联**：键为 `(tool_id, arguments_hash)`、hash 缺失回退 execution 唯一键、顺序 `started_at,rowid`。
12. **预算门控在 run 创建之前**：任一使用到的 kind `remaining==0` → 不建 run、不消耗、直接 BUDGET_EXHAUSTED。
13. **F-2 后模型归属可查**：产品任务 task/run/call 行绑定一致；默认切换不回写历史任务；改版任务不被静默复活（需新建任务）。

## 6. 无法验证的事项（如实列出）

1. 真实双主进程 / 孤儿 executor 的**进程调度**级交错（S1 已用真实双进程 probe 验证；T4/T8 为同 DB 双连接 + 真实 recoverOnStartup 交错）；
2. 跨用户 approval 后 approver 被禁用/降级的**真实 Electron 双账号端到端点击**（只读约束下用同一 IPC 服务调用链替代）；
3. 跨平台：Windows 命名管道 / 路径形态（拒绝判据刻意保持窄口径）、Linux 形态；
4. 真实 Electron 主进程装配的端到端顺序（本轮以代码核对 + 隔离树真实 main E2E 覆盖产品入口）；
5. 真实 `kill -9` quiescence 与多 session 并发 approve 的新复现（复用既有 C3 套件结论）。

## 7. 封板判定与仍需裁决的问题

**已满足（内部独立预审层面）**：未参与实现的独立审查（两名、七轮）已完成；13 项已确认缺陷全部最小修复并经**同一独立审查者**在冻结修订上复核 CLOSED（含真实双进程、真实 Bridge、全库扫描、parity 对照）；被测 commit 干净树上 D4-03 十六门禁 + D4-01/02 相关门禁 + D4-04/05/06 + 真实 main 133/133 + `npm test` 1061/1061 全绿；未扩权、未改工具门与执行入参语义。

**未满足（故本轮不封板）**：
1. **缺"由实现方之外的审查者作出的封板裁决"**（原文指名 ChatGPT；本轮审查者与实现方同源）；
2. **缺三项产品语义裁决**：REV-03/S2（approval 是否绑定 approver 后续权限）、R-8（旧任务未绑定窗口的归属策略）、R7/R6-C2/C3（DENY 状态前置与抑制结果分类）；
3. **缺低危登记项的处置决定**（R3/R4/R-4'/N-1/R-6/[REDACTED] 误拒/微项）。

**外部审查者需要的输入包（已备齐）**：本文件（§3 逐项位置/测试/commit/预期/实际/三态 + §4 六要素澄清 + §8 命令与数字）+ 七轮审查报告要点 + 探针清单（`/tmp/rev/**`、`/tmp/probe-*`、`/tmp/d403*`）+ 被测 commit `c7302dc` + `docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`。

## 8. 实际检查（被测 commit `c7302dc`，干净树 `workspaceState=""`）

| 检查 | 结果 |
| --- | --- |
| D4-03 十六门禁 | 全 **exit 0**：A 32/32、B 59/59、C1 48/48+52/52、C2 29/29+38/38+45/45+51/51、C3 56/56+63/63、C4 35/35+**UI 22/22**+15/15+12/12+9/9、D 52/52+62/62 |
| D4-01 / D4-02 相关（受 model-proxy 改动影响） | `test:d4-01` 59/59、`test:d4-02a` 22/22、`test:d4-02b` 16/16、`test:d4-02c` 22/22（schema v16、dsh 0.1.5-rc.2、acp 1.4.0） |
| 受影响回归 | D4-04 **94/94**、D4-05 **173/173（S1–S4 PASS）**、D4-06 **119/119**、d4-06-resume **21/21**、d4-08-verification-ui **22/22**、d4-08 **13/13** |
| 本轮新增测试 | `tests/d4-03-model-binding.test.mjs` 12/12、`tests/d4-03-lease-state-integrity.test.mjs` 10/10、`tests/d4-03-run-entry-guard.test.mjs` 7/7、`tests/tool-argument-projection-redaction.test.mjs` 21/21（合计 50/50） |
| 真实 main E2E | `node tests/d4-main-e2e.mjs` → **133/133、七条必需流程全 PASS（含 flow6 13/13）、overallStatus=PASS、exit 0、workspaceState=""**；`artifactSha256=245f6cc1ff62d2b40aae65c51576111405726b4566e7c9b48dafe198733db9f1` |
| 全量测试 | `npm test` **1061/1061**；`npm run build` exit 0 |
| 独立复核（冻结修订） | parity 正对照 diff 为空；真实双进程 S1/S1-b 抑制；A-4 七项探针；R-1' 全库 645 单元格 anchored 残留 0；R-7 四窗口收口；R-9 四类原因码 |

## 9. D4 的 macOS 已验证范围与整体状态

| 子项 | 状态 | 依据 |
| --- | --- | --- |
| D4-01 模型服务（macOS Core） | PASS | `test:d4-01` 59/59 |
| D4-02 任务与适配（macOS Core） | PASS | d4-02a 22/22、d4-02b 16/16、d4-02c 22/22；**F-2 已修：产品任务绑定实际配置版本** |
| **D4-03 工具门与租约** | **PASS candidate（内部独立预审通过；本轮不封板）** | 十六门禁全绿 + 七轮独立审查 + 13 项缺陷闭合；封板待实现方之外的审查者（§7） |
| D4-04 纵向冒烟 | PASS（限定范围） | 94/94 |
| D4-05 执行关卡 | PASS（S1–S4；S4 限定"消息结构 + 授权/执行边界"） | 173/173 |
| D4-06 关联链与预算停止 | PASS | 119/119 + resume 21/21 + 失败验证 UI 22/22 |
| 真实 `electron/main.cjs` 产品入口 | PASS | 133/133、七条必需流程、exit 0（被测 commit 复跑） |
| **D4 整体** | **PARTIAL（不自动升级）** | 剩余：**Windows / External Provider = NOT VERIFIED**；**D4-03 待实现方之外的审查者封板**；三项产品语义裁决（REV-03/S2、R-8、R7/R6-C2/C3）待决；OS 级网络沙箱 / 跨重启 durable death proof 等既有挂账不变 |

Windows 与 External Provider 的限制**单独保留**，不因本轮任何结论被改写。

## 10. 唯一推荐的下一阶段任务及前置条件（不开始实施）

**推荐：D5-01 浏览器**（`PLAN.md:501`：`D5-01 浏览器 \| 前端 \| D2、D3-05、D1-01 \| 真实浏览器 \| 导航下载会话隔离及遮挡正确`）。
前置：**D2**（D2-01 设计系统 PARTIAL、边界已声明；D2-02 窗口系统 ADR `docs/decisions/D2-02-window-system.md`）、**D3-05**（macOS PASS）、**D1-01**（macOS 桌面核心 PASS；Windows NOT VERIFIED 保留）；PLAN 依赖表未把 D4 列入 D5-01 前置，D5-02/03/06/08 才以 D4-05（已 PASS）为前置。
**建议**：先完成 D4-03 封板裁决与 §7 的三项语义裁决，再进入 D5-01；**本轮不开始实施**。

## 11. 修改文件（本轮）

- **代码/测试提交 `c7302dc`**：`electron/task-bootstrap.cjs`、`electron/task-service.cjs`、`electron/task-harness-orchestrator.cjs`、`electron/task-domain.cjs`（MODEL_CONFIG_BOUND / 新事件登记）、`electron/model-proxy.cjs`、`electron/harness-adapter.cjs`、`electron/side-effect-authority.cjs`、`electron/tool-domain.cjs`、`electron/identity-store.cjs`（注释）、`tests/d4-main-e2e.mjs`（flow6）、`tests/d4-03-model-binding.test.mjs`（新）、`tests/d4-03-lease-state-integrity.test.mjs`（新）、`tests/tool-argument-projection-redaction.test.mjs`。
- **报告/证据提交**：本文件、`docs/D4-ACCEPTANCE-RESULT.md`、`PROGRESS.md`、`docs/decisions/D4-03C-side-effect-authority.md`（Audit/TaskEvent 清单登记 late_result_suppressed）、`docs/D4-04/05/06-GATE-EVIDENCE.json`、`docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`。
- 审查者全程未修改仓库任何文件；探针只写 `/tmp`。
