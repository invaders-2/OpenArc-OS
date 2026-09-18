# D4-03 独立审查与收口（Independent Review · 2026-09-18 · v3：统一编号 + 第三轮修复收口）

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`；分支：`feature/d4-03-tool-proxy`
- **本轮 Base HEAD**（第三轮开工核对，干净）：`ad5e6003dd1fd50f928663573f75ca5db9d3ee00`
- **本轮代码/测试提交（被测 commit）**：`2c5dc2948960868be8b00a0b96a0d642fdda3910`（DENY 状态前置 / R-8 / 审批推送隔离 / effectiveApproval）+ 本轮收尾提交 `42ebe3bf0304857ce9b3e8973bb599ac9bc018f6`（F6.8 与 F4.43 的确定性 UI 接受判据、`deny_too_late` 事件登记、`resolveModel` 抛出收敛）、`1594771e94d13a6a72dd49e473a7c90390c6efc8`（A24：已绑定路径 `resolveModel` 抛出收敛）；**最终被测 commit = `1594771`**、`1594771e94d13a6a72dd49e473a7c90390c6efc8`（A24：已绑定路径 `resolveModel` 抛出收敛）；**最终被测 commit = `1594771`**
- 前序审计提交：`f63e87ac5390e65fd733bf6467f693a5cc67a4f1`（A1/B1–B5 修复）、`5577e82` + `3c9659a`（追加步骤入口）、`c83e486`（Closure-6 报告）、`c7302dcbeaca58a904c9f31f70bada3b931187ec`（B6–B9/A4/A7/A8 修复）
- **报告/证据提交**：本文件 + `docs/D4-ACCEPTANCE-RESULT.md` + `PROGRESS.md` + `docs/decisions/D4-03C-side-effect-authority.md`（新事件登记）+ `docs/D4-04/05/06-GATE-EVIDENCE.json` + `docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`
- 远端：`origin/feature/d4-03-tool-proxy = 67357ef`、`origin/main = 823242a`（未 push、未合并 main、未触碰默认工作区）

## 0. 结论摘要（三态严格区分）

| 状态口径 | 含义 | 本轮适用 |
| --- | --- | --- |
| **实现方已修复** | 执行岗已提交代码/测试 | 第一轮 A1、B1–B5；第二轮 B6–B9、A4、A7、A8；**第三轮 A9、A10、A14、A16、A17，收尾 A19、A21、A23、A24** |
| **内部独立复核通过** | 未参与实现的独立审查者在冻结修订上复现并判 CLOSED | 上述全部 22 项（十一轮复核；含真实双进程/真实 Bridge/真实 Electron UI/全库扫描/parity 对照/基线区分力对照） |
| **仍待 ChatGPT 审计** | 由实现方之外的审查者作出的封板裁决 | **全部**：本文件的 CLOSED 一律止于内部独立复核，**不等于外部审计通过**，D4-03 仍为 PASS candidate |

1. **第三轮按裁决修复（本轮主线）**：① **A9/A10（拒绝操作的状态保护）**——DENY 只在 `AWAITING_APPROVAL/APPROVED/LEASED` 生效，`RUNNING` 与任何终态一律 `SIDE_EFFECT_APPROVAL_TOO_LATE` 且**状态零变化**、只落 safe 审计/事件、不中止执行、不覆盖 `UNKNOWN_EFFECT`/`SUCCEEDED`；② **A14（R-8）**——任务未绑定且无可用默认时**绝不创建 run**（0 capability / 0 模型请求 / 0 工具执行 / 0 artifact），Step/Task 收敛 BLOCKED，任务可保持未绑定；③ **A16/A17**（复核者发现的实现缺陷）——审批推送按当前会话重投影、读取在声明 context 时必须匹配真实 session；`effectiveApproval` 过期分支由死代码修复。
2. **收尾修复（本轮复核新发现的低危项）**：④ **A19**：`tool.side_effect.deny_too_late` 与其 audit action 未登记进 `TASK_EVENT`/ADR:156 冻结清单（上一轮 `late_result_suppressed` 已登记），按同一手法补齐；⑤ **A21**：`resolveModel` **抛异常**时穿透 `runTask`，task/step 停在 RUNNING（0 run / 0 provider / 契约不破但有悬挂），按"返回失败"同一路径收敛 BLOCKED；⑥ **A23**：`approveSideEffect` 的"读状态 + 写 APPROVED"跨两个事务，可把已被 DENY 的 call **复活成 APPROVED**（DENY 决定被改写），已合并为同一事务 + 事务内状态前置（`SIDE_EFFECT_CALL_STATE`、0 写入、绝不复活）；⑦ **A24**（第十轮复核 B 发现）：已绑定路径同一 `resolveModel` 抛出 → task/step RUNNING + STARTING run 悬挂，已按“抛出 = 返回失败”同形收敛。**另登记未修项 A26**（其余 4 处 `resolveModel` 调用点未把抛出转成显式错误码；均不会留下悬挂 run）。
3. **纯测试修复（非产品缺陷）**：真实 main E2E flow6 F6.8/F6.11 与 flow4 F4.43 存在**"点完 UI 立刻读旧终态"**的测试竞态（追加/续接前任务本就是终态，产品桥读到终态早于 Renderer 渲染入口 → `setInput` 为 no-op → 按钮 disabled → 从未真正点击）。修复方式只**加确定性接受判据**（等入口渲染 + 写入生效 + 按钮可用 + 点击后 step 数增加）并**收紧断言**，未放宽任何断言；不涉及产品代码。
4. **D4-03 不封板**：封板要求"由实现方之外的审查者（原文指名 ChatGPT）裁决"，本轮两名审查者与实现方同源。**D4 维持 PARTIAL**（Windows / External Provider 等既有项不变）。
5. **REV-03 未改执行语义**：批准人在批准后失权是否影响既有批准，仍**待产品裁决**；本轮只补齐事实与三个可选方案及其影响（§4.2），未擅自选"仅文档化"、未改任何 eligibility/claim 判定。

## 1. 依据：原始要求与封板条件

| 出处 | 原文要点 |
| --- | --- |
| `PLAN.md:498` | `D4-03 工具门与租约 \| 后端、运维 \| D4-02、D3-03 \| 授权执行及回报 \| 重复调用与离线结果处理正确` |
| `PLAN.md:497` | `D4-02 任务与适配 \| 后端 \| D4-01 \| 任务状态及 Harness 适配 \| 任务版本固定且权限实时有效`（F-2 的契约来源） |
| `docs/D4-03C4-RESULT.md:14` | "DeepSeek 无权正式封板；由 ChatGPT 审计后决定 `D4-03C = PASS`。" |
| `docs/decisions/D4-03C-side-effect-authority.md:511` | "…`D4-03 overall = PASS candidate`（DeepSeek 无权封板，由 ChatGPT 审计后决定 `D4-03 = PASS`）。" |
| 同 ADR `:132-134 / :165 / :118 / :156` | 终态必终结 lease；UNKNOWN_EFFECT → VERIFY → BLOCK、禁止 retry；重启用"非本进程 ACTIVE lease→EXPIRED"且本进程 lease 保留；Audit/TaskEvent 冻结清单 |

## 2. 审查者独立性、范围与轮次

- **独立性**：两名独立审查子 Agent，均在派工前从未接触对应实现；全程**只读仓库**（入场/离场 `git status`、关键文件哈希一致；本轮复核期间 `electron/` 工作树改动为 0）；探针只写 `/tmp`；任务书明确"不得以测试全绿代替审查结论"；与实现方同源 → **内部独立预审，不是外部审计**。
- **轮次**：①初查（六块范围）→②修复复核（A1/B1）→③残留复核（B2/B3/B4/B5）→④B5' 确认→⑤**未关闭项逐项澄清**→⑥⑦修复复核（B6；A7/A8/A4；B9/B7/B8）→⑧**A9/A10 与 R-8 修复复核**→⑨**A16/A17 修复复核 + R-8 复核 + 全量回归抽检**。
- **范围**：身份/权限/工具范围/批准绑定与撤权；租约/claim/并发/重复副作用；executor 退出与 UNKNOWN_EFFECT 阻断及危险重放；配置变化/预算停止/续接/追加是否绕过工具边界；验证失败/被拒/结果未知是否被最终文本掩盖；工具协议输入与持久化信任边界。**限定 D4-03 及已发生变更的相关边界**，未扩成全仓库审计。
- **方法**：先自行写出不变量，再找反例；复用同代码同环境既有验证，仅对具体疑点补有区分力的探针（`/tmp/rev/**`、`/tmp/probe-*`、`/tmp/d403*`）；修复后由**同一审查者**在冻结修订上重跑并给 CLOSED；**新测试的区分力**用基线快照对照复核（A9 测试 2/9→9/9；A16 测试 4/8→8/8）。

## 3. 已确认缺陷：位置 / 测试 / 被测 commit / 预期 / 实际 / 三态

### 3.1 统一编号对照表（本文件此后一律用统一编号）

| 统一编号 | 旧编号 | 归属 | 一句话 |
| --- | --- | --- | --- |
| **A1** | REV-01 | A | 第三条启动入口无未决副作用守卫 |
| **A2** | REV-02 | A | `acquireLease()` 无身份/授权判定（登记加固） |
| **A3** | REV-03 / S2 | A | 批准人失权后既有 approval 是否仍有效（**待产品裁决**） |
| **A4** | A-4 | A | 终态 call 遗留 ACTIVE lease |
| **A5** | A-5 | A | 跨任务同资源操作（契约允许） |
| **A6** | A-6 | A | `BLOCKED` 被安全判定视为安全（未验证疑点） |
| **A7** | S1 | A | 迟到 SUCCEEDED 覆盖另一 runtime 的 UNKNOWN_EFFECT |
| **A8** | S1-b | A | 失败类迟到写回同类覆盖 |
| **A9** | 旧 "R7" | A | 并发 trusted DENY 期间的迟到抑制/覆盖（**本轮修复**） |
| **A10** | 旧 "R6-C2/C3" | A | DENY 覆盖 UNKNOWN_EFFECT / SUCCEEDED（**本轮修复**，与 A9 同根因） |
| **A11** | 旧 "R3" | A | 多条 ACTIVE lease 的回收排序（合成态，登记） |
| **A12** | 旧 "R4" | A | `recoverAfterExecutorExit` 的 LEASED→FAILED 与 `releaseLease` 两事务拆分（登记） |
| **A13** | S3 | A | `identity-store.transactSync` 无连接内互斥（当前不可达的结构性隐患） |
| **A14** | R-8 | A | 未绑定任务可在"默认迟到"窗口内启动真实执行（**本轮修复**） |
| **A15** | 两个微项 | A | 抑制分支 `knownNoEffect:false`；`#lateResultSuppressed` 直接解引用 call |
| **A16** | —（本轮新发现） | A | 审批推送与读取在无/他人 session 下泄漏跨账号元数据（**本轮修复**） |
| **A17** | —（本轮新发现） | A | `effectiveApproval` 读 `row.expires_at` 致过期判定为死代码（**本轮修复**） |
| **A18** | —（本轮登记） | A | `revokeApproval` 无产品入口（登记，**待裁决**） |
| **A19** | —（本轮新发现） | A | `deny_too_late` 事件/audit action 未登记进 TASK_EVENT/ADR:156（**收尾修复**） |
| **A20** | —（本轮新发现） | A | 迟到 DENY 的 `TOO_LATE` 在 UI 静默丢失（**待产品/UI 裁决**） |
| **A21** | —（本轮新发现） | A | `resolveModel` 抛异常穿透 → task/step 悬挂 RUNNING（**收尾修复**） |
| **A22** | —（本轮新发现） | A | revision 冲突败者留下 STARTING run / RUNNING step（**预先存在**，登记） |
| **A23** | —（本轮新发现） | A | `approveSideEffect` 两段事务：已被 DENY 的 call 可被在途 approve 复活成 APPROVED（**本轮修复**；复核者 A 建议编号 "A22"，因 A22 已用于 revision 冲突悬挂，本文件统一为 A23） |
| **A24** | —（第十轮复核 B 新发现） | A | 已绑定路径同一 `resolveModel` 抛出 → task/step RUNNING + STARTING run 悬挂（**本轮收尾修复**） |
| **A25** | —（第十轮复核 A 新发现） | A | approval 过期后再次 Approve 命中 duplicate 返回同一过期行、无法续期（**预先存在**，登记） |
| **A26** | —（第十一轮收尾核查） | A | 其余 4 处 `resolveModel` 调用点未把抛出转成显式错误码（**均不会留下悬挂 run**，登记健壮性缺口） |
| **A26** | —（第十一轮收尾核查） | A | 其余 4 处 `resolveModel` 调用点未把抛出转成显式错误码（**均不会留下悬挂 run**，登记健壮性缺口） |
| **B1** | F-1 | B | 声明为 string 的工具参数原样落库 |
| **B2** | R-1 | B | 非 macOS 绝对路径仍明文落库 |
| **B3** | R-2 | B | 失败验证证据第三份更弱判据 |
| **B4** | R-3 | B | 256 截断残留裸路径前缀 |
| **B5** | R-5 / R-5' | B | 冷缓存回退静默换参；标记判定可被截断绕过 |
| **B6** | F-2 | B | 产品入口不冻结 model config |
| **B7** | 旧 "R-7" | B | "读取版本后、签发 capability 前"被改版 |
| **B8** | 旧 "R-9" | B | 禁用/删除 config 的阻断码口径 |
| **B9** | 旧 "R-1'" | B | 裸单段绝对路径与 POSIX 双斜杠明文落库 |
| **B10** | 旧 "R-4'" | B | 过度遮蔽（有意取舍，数字登记） |
| **B11** | 旧 "N-1" | B | 去敏投影长度上界 271（信息级） |
| **B12** | 旧 "R-6" | B | 执行入参缓存条目无字节上限（条件性硬化） |
| **B13** | — | B | `[REDACTED]` 字面量误 fail closed（可用性取舍） |

### 3.2 已修复并内部独立复核 CLOSED 的 22 项

| # | 统一编号 | 发现 | 代码位置 | 测试名称 | 被测 commit | 预期 | 实际（复核证据） | 三态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **A1** | 第三条启动入口无未决副作用守卫 → 可在 UNKNOWN_EFFECT 期间执行第二条 WRITE 并把任务写成 SUCCEEDED | `task-harness-orchestrator.cjs:141-156`、`task-service.cjs #sideEffectSafety/getSideEffectSafety` | `tests/d4-03-run-entry-guard.test.mjs`（7） | `f63e87a` | 拒绝 + 0 状态变更 + 恢复入口保留 | `RUN_BLOCKED_UNRESOLVED_SIDE_EFFECT/UNKNOWN_EFFECT`；revision/step/run/call/lease/event/artifact 全表零变化；无第二条 call（真实双 runtime 探针） | 已修复 ✅ / 复核 CLOSED ✅ / 待外部审计 ⏳ |
| 2 | **B1** | 声明为 string 的工具参数原样落库（绝对路径 / 明文 `tpx_` / secret 形态），违反 tool-store 与 bridge 明示契约 | `controlled-tool-proxy.cjs:95-110`、`tool-domain.cjs redactProjectedArguments` | `tests/tool-argument-projection-redaction.test.mjs` | `f63e87a` | 落库去敏、执行入参不变 | 直连 Bridge / 真实 dsh / 真实 WRITE 全链 / 全库 63 表扫描 残留 0；执行入参对 HEAD 逐字符一致 | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 3 | **B2** | 非 macOS 绝对路径仍明文落库 | `tool-domain.cjs UNSAFE_PATH_PERSIST_RE` | 同上（r1） | `f63e87a` | 常见系统根/POSIX 多段/盘符/UNC/file:// 全去敏 | 7 条路径残留 = [] | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 4 | **B3** | 失败验证证据第三份更弱判据 | `task-service.cjs EVIDENCE_PATH_RE` | `tests/d4-07-verification-persistence.test.mjs`、`d4-05-s1-output-size` | `f63e87a` | 证据投影复用同一判据 + depth≥2 兜底 | 7 形态 + Windows/UNC/file:// + 深层全部去敏 | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 5 | **B4** | 256 截断残留裸路径前缀 | `tool-domain.cjs redactArgumentString` | 同上（r3） | `f63e87a` | 无裸前缀/半段目录/半截标记 | straddle 残留 = false | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 6 | **B5** | 冷缓存回退静默换参；首版标记判定可被"标记被截断"绕过 | `controlled-tool-proxy.cjs #argsOf`、`tool-domain.cjs` 截断分支 | 同上（r5/r5b） | `f63e87a` | 完整标记 fail closed + 生产侧保证截断后仍含完整标记 | 冷缓存 `TOOL_ARGUMENTS_PROJECTION_UNAVAILABLE`、0 Domain/0 execution；19 变体 + 473 例不变式 battery 违反 0 | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 7 | **B6** | 产品入口不冻结 model config → `MODEL_CONFIG_CHANGED` 对产品任务不可达、run 无模型归属 | `task-bootstrap.cjs:131-146`、`task-service.cjs #boundModelConfig/checkModelConfig/startHarnessRun`、`task-harness-orchestrator.cjs runStep` | `tests/d4-03-model-binding.test.mjs`（A–J）、`tests/d4-main-e2e.mjs` flow6 | `c7302dc` | 产品任务绑定后端配置；改版后 run/append/resume 明确拒绝；默认切换不静默跟随；旧任务显式懒绑定 | 真实 UI 建任务 → task/run/call 行绑定 == Settings 默认；改版后 append → 全 BLOCKED + `MODEL_CONFIG_CHANGED` + 0 capability/0 call/0 artifact + UI 可见；默认切到另一 config 后原任务 append/resume 仍成功且归属不变；旧任务懒绑定事件 + run 归属正确 | 已修复 ✅ / 复核 CLOSED ✅ / ⏳ |
| 8 | **B7** | "读取版本后、签发 capability 前"被改版 → 以非冻结版本签发 | `model-proxy.cjs issueCapability(expectedModelConfigVersion)`、`harness-adapter.cjs:191`、orchestrator 预检 | 同上（H/H2） | `c7302dc` | 生成 token 前比对，不等则不签发 | 四个窗口全部收口：无 token、capabilities 不增、直连非 200、run BLOCKED、0 provider | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 9 | **B8** | 禁用/删除 config 的阻断码为 `HARNESS_NOT_STARTED` | orchestrator 预检失败集合 | 同上（I） | `c7302dc` | 配置解析类失败在签发前以自身原因码阻断 | 禁用/删除 provider/撤 model grant/移除 capability 四类 → `MODEL_CONFIG_UNAVAILABLE`/`PROXY_UNAUTHORIZED`/`CAPABILITY_UNAVAILABLE`，全 BLOCKED、0 capability、0 provider | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 10 | **A7** | 迟到终态（SUCCEEDED）无条件覆盖另一 runtime 的 UNKNOWN_EFFECT → 任务卡死、恢复入口消失 | `side-effect-authority.cjs #dispatchControlledWrite` 条件写回 | `tests/d4-03-lease-state-integrity.test.mjs`（T4/T8） | `c7302dc` | 仅 RUNNING→终态；否则绝不覆盖并落 late 事件 | 真实双进程：call 保持 UNKNOWN_EFFECT、task BLOCKED、`recoveryApplicable=true`、副作用恰好 1 次 | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 11 | **A8** | 失败类迟到写回（`#finishKnownNoEffect`/`#finishUnknownEffect`）同样覆盖权威状态 | `side-effect-authority.cjs` 同上两函数 | 同上（T7/T8-a/T8-b） | `c7302dc` | 同 A7；被抑制时不写任何持久化字段、只幂等终结自身 lease | 双 runtime 三类失败结果全部抑制；call 行快照逐字不变；单 runtime parity 与 `f1bff21` diff 为空 | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 12 | **A4** | 终态 call 遗留 ACTIVE lease（崩溃窗口 + DENY-on-LEASED）→ 本进程内 append/runTask 被 ACTIVE_LEASE 拦死 | `side-effect-authority.cjs #finalizeLeaseInTx / recoverAfterExecutorExit / denySideEffect` | 同上（T1/T2/T3/T7） | `c7302dc` | 终态与 lease 终结同事务；遗留可回收；deny 回收 | 崩溃 seam 观察点已是 `{call:SUCCEEDED, activeLease:null}`；deny(LEASED) → BLOCKED + 0 ACTIVE；归属匹配回收、错配 fail closed | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 13 | **B9** | 裸单段绝对路径（`/secret-plan.txt`）与 POSIX 双斜杠（`//x`）明文落库 | `tool-domain.cjs UNSAFE_PATH_PERSIST_SRC` | 同上（r1b/r1c/r1d/r1g） | `c7302dc` | 两类形态去敏；拒绝判据与执行入参逐字节不变 | 真实 Bridge 8 例 + 全库 645 单元格 anchored 扫描：目标形态残留 0（`f1bff21` 对照分别命中）；8 例决策序列 diff 为空 | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 14 | **A9** | trusted DENY 无状态前置：在执行 in-flight 期间 DENY 会抑制/改写执行事实（"效果已发生却记未执行"） | `side-effect-authority.cjs denySideEffect` | `tests/d4-03-deny-state-protection.test.mjs`（T1–T7）、`tests/d4-03c4-approval-ui-probe`（A23–A28） | `2c5dc29` | 仅 `AWAITING_APPROVAL/APPROVED/LEASED` 可 DENY；`RUNNING`/终态 → `TOO_LATE` + 零状态变化 + 只落 safe 事件 | 两个 RUNNING 同步点：call 全字段逐字不变、+1 audit/+1 event（payload 仅 callId/toolId/observedStatus）、执行继续 SUCCEEDED/PASS、1 mutation；R7-a → UNKNOWN_EFFECT + task/step BLOCKED + `recoveryApplicable:true`；R7-c → SUCCEEDED/PASS + trashed=true；真实 Electron A23–A28 6/6（面板关闭且无"未执行/已拒绝"假象） | 已修复 ✅ / 复核 CLOSED ✅ / ⏳ |
| 15 | **A10** | DENY 可把 UNKNOWN_EFFECT（乃至已验证 SUCCEEDED）改写成 BLOCKED/APPROVAL_DENIED（pre-existing，与 A9 同根因） | 同上 | 同上 | `2c5dc29` | 终态一律不可 DENY，恢复入口保留 | deny(UNKNOWN_EFFECT) → `denyOk:false`、call 不变、`recoveryApplicable:true`；deny(SUCCEEDED) → `denyOk:false`、仍 SUCCEEDED/PASS；重复 DENY 幂等（`duplicate:true`、approval 行不增） | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 16 | **A16** | 审批推送与读取在无 session / 他人 session 下泄漏跨账号审批元数据（未登录 renderer 可读到全部待决审批） | `identity-bootstrap.cjs onApprovalRequested`、`side-effect-runtime.cjs approvalSnapshot` | `tests/d4-03-approval-push-isolation.test.mjs`（P1–P8） | `2c5dc29` | 推送按当前会话重投影；声明 context 必须有真实匹配 session，否则 null；`context==null` 内部投影语义不变 | 他人会话 0 推送 / listPending 0 / getApprovalRequest NOT_FOUND；无会话 0 推送 / NOT_FOUND；owner 路径 1 推送、13 字段白名单与 getApprovalRequest 逐字一致且决策成功；基线对照 4/8→8/8 | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 17 | **A17** | `effectiveApproval` 读不存在的 `row.expires_at` → TTL 过期分支为死代码（过期被当成有效） | `side-effect-authority.cjs effectiveApproval/evaluateExecutionEligibility` | `tests/d4-03-lease-state-integrity.test.mjs`（T5）、`side-effect-security` | `2c5dc29` | 过期如实判 EXPIRED；执行判定与基线逐字一致 | ad5e600 vs 2c5dc29 五路签名 parity：唯一差异 = 过期场景 `effectiveDecision: APPROVED→EXPIRED`；`reasonCode`/call/lease/`domainCalls` 全同（过期仍 `SIDE_EFFECT_APPROVAL_EXPIRED` / 0 mutation） | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 18 | **A14** | 未绑定任务在"默认迟到"窗口内以当前默认真实执行（run/归属仍为 null，审计归属缺失） | `task-service.cjs startHarnessRun`、`task-harness-orchestrator.cjs runStep` | `tests/d4-03-model-binding.test.mjs`（K/L/M/N/O，17） | `2c5dc29` | 未绑定 + 无可用默认 → **绝不建 run**；0 capability/模型请求/工具执行/artifact；Step/Task BLOCKED；任务可保持未绑定 | 三入口（runTask/append/resume）+ `task/run` IPC 实测 `{newRuns:0,cap:0,toolExec:0,calls:0,reqs:0,artifacts:0}`、BLOCKED、仍未绑定；默认迟到后重新解析+绑定（事件 + run/call 归属）真实 SUCCEEDED；旧未绑定 run/call 行逐字段不回填；并发绑定唯一；桩装配例外与基线同形 | 已修复 ✅ / CLOSED ✅ / ⏳ |
| 19 | **A19** | `tool.side_effect.deny_too_late` 与 audit `side_effect.deny_too_late` 未登记进 TASK_EVENT/ADR:156 冻结清单（`isKnownEventType=false`） | `electron/task-domain.cjs TASK_EVENT` | `tests/d4-03-deny-state-protection.test.mjs`（登记断言） | `42ebe3bf0304857ce9b3e8973bb599ac9bc018f6` | 与 `late_result_suppressed` 同法登记；经 `isKnownEventType` 过滤的通道不再丢弃该事件 | `ad5e600` 上 `isKnownEventType("tool.side_effect.deny_too_late")=false` → `42ebe3b` 上 `true`；测试从 `task-domain` 导入常量（不复制字面量）、断言落库类型 == 常量、T5 用真实落库的 `late_result_suppressed` 对照；`test:d4-03a` 32/32、`test:d4-03d-closure` 62/62、`task-domain` 15/15；audit action **无白名单清单**（`insertToolAudit` 直写字符串、`listAudit` 只等值过滤），无需登记；全仓 `#event/appendEvent` 字面量扫描：**无其它未登记 TaskEvent** | 已修复 ✅ / 复核 CLOSED ✅ / ⏳ |
| 20 | **A21** | `resolveModel` 抛异常（如损坏 capabilities JSON）穿透 `runTask` → task/step 停在 RUNNING（0 run/0 provider，契约不破但有悬挂） | `task-service.cjs startHarnessRun` | `tests/d4-03-model-binding.test.mjs`（`D4-03 P`，18/18） | `42ebe3b` | 抛出与返回失败同等收敛：不建 run、Step/Task BLOCKED、无 RUNNING 悬挂 | 修复前副本（`git archive 2c5dc29` 去掉 try/catch）+ 同一用例 → **not ok**（`SyntaxError: Expected property name or '}'` 穿透 `runTask`）；修复后抛出路径与返回失败路径**事件序列 / Step·Task 终态 / 错误码 / 0 执行面逐项同形**（真实 ModelStore 把真实 config 行 capabilities 写成 `{corrupt` 并 setDefault，前置断言真实 `resolveModel` 确实抛） | 已修复 ✅ / 复核 CLOSED ✅ / ⏳ |
| 21 | **A23** | `approveSideEffect` 的"读状态 + insertApproval + updateCall"跨两个事务：在途 approve 可把**已被 DENY 的 call 复活成 APPROVED**（DENY 决定被改写） | `side-effect-authority.cjs approveSideEffect` | `tests/d4-03-deny-state-protection.test.mjs`（T9/T9-b/T9-c） | `42ebe3b` | 判定+写回同一事务、事务内重读 persisted status；期间已被 DENY → `SIDE_EFFECT_CALL_STATE`、0 写入、绝不复活；重复 approve 幂等形状不变 | 修复前副本（`git archive 2c5dc29` + 同一测试）→ **12 用例 pass 10 / fail 2**：T9 真实复活证据 `{ok:true, call:{status:"APPROVED", errorCode:"SIDE_EFFECT_APPROVAL_DENIED"}, approval:{decision:"APPROVED"}}`、T9-c 出现两次 transition；修复后 T9 `{approve:{ok:false,error:"SIDE_EFFECT_CALL_STATE"}, call:"BLOCKED", latestApproval:"DENIED", approvals:["DENIED"], lease:"CALL_STATE", mutation:0, approvedEvents:0}`，T9-b/T9-c 仍 1 行 approval / 1 次 audit / 1 次 event | 已修复 ✅ / 复核 CLOSED ✅ / ⏳ |
| 22 | **A24** | 已绑定路径同一 `resolveModel` 抛出（如已绑定 config 行 capabilities 损坏）穿透 → task/step RUNNING + STARTING run 悬挂 | `task-service.cjs #boundModelConfig`、`task-harness-orchestrator.cjs startModelCall` | `tests/d4-03-model-binding.test.mjs`（`D4-03 Q`：预检窗口 + `startModelCall` 窗口） | `1594771` | 抛出与返回失败同形：不建/不留悬挂，run 与 Step/Task 收敛 BLOCKED | 修复前（`git archive 42ebe3b`）：`{thrown: JSON SyntaxError}`、task/step RUNNING/RUNNING、runs `[STARTING/RUNNING, error_code=null]`、caps=0/1、0 provider；修复后：`{ok:false,error:MODEL_CONFIG_UNAVAILABLE,blocked:true}`、task/step BLOCKED、runs `[[BLOCKED, MODEL_CONFIG_UNAVAILABLE]]`、0 call/0 provider/0 artifact、绑定 id+version 不改写、已签发 capability 事后 REVOKED + 直连 401；`MODEL_CONFIG_CHANGED` 原路径 reason/event/终态逐字未变 | 已修复 ✅ / 复核 CLOSED ✅ / ⏳ |

**修复引入/未引入副作用的独立结论**：正常单 runtime 路径与修复前**逐字一致**（parity 探针：exec 形状、call 字段、recovery 证据、lease、task/step、safety、Domain 调用数、完整 TaskEvent/audit 序列 diff 为空）；AUTO_RETRY 仍恒为 0；Domain 调用恒 1 次；无新增自动重试/收敛；无越权、无重复副作用、无错误成功。R-8 的夹具对齐经逐行核对（admin 真绑定路径保住、alice 桩回退不丢覆盖、restart-writer 保持升级前形状、d4-04 仍是真实装配）。

## 4. 逐项澄清（未关闭 / 未修项，含六要素；均为**内部独立复核**结论）

### 4.1 A2 · `acquireLease()` 无身份/授权判定
- **契约与位置**：ADR `:27/:40/:114`；`side-effect-authority.cjs:322-364`。
- **分类**：**契约允许行为 + 加固项**（非可绕过缺陷）。
- **产品可达性与复现**：IPC 只暴露 3 条 approval 命令（`side-effect-bootstrap.cjs`、`preload.cjs`），`acquireLease` 仅由 executor child（`side-effect-executor.cjs:58`，按设计传 `context:{}`）与测试调用。探针：任意 holderId 可获 ACTIVE lease，但执行主体由 task 反推（`:681-683`）并在 eligibility + claim 事务内全量重查（`:751-798`）。
- **后果**：越权否 / 重复副作用否 / 错误成功否 / 永久占用否（DoS 级残余，仍 fail closed）/ 泄漏否。
- **防护层与可绕过性**：防护在 eligibility + claim（不可绕过）；撤权、session 注销、app 禁用、approval 撤销一律 0 Domain 调用。
- **封板影响**：**不阻塞**。登记加固建议：`acquireLease` 内复用 `preflightAuthorization` 做最小权限预检；`_leaseId` test seam 与 ADR`:114`"零 caller override"字面不一致，建议记录或去掉。

### 4.2 A3 · REV-03 / S2 —— 批准人失权后既有 approval 是否仍有效（**待产品裁决，本轮未改执行语义**）

**A. 事实（复核者实测，被测 commit `ad5e600` 与 `2c5dc29` 同结论）**

1. **契约口径**：ADR `:26` 定义 Approval 绑定"内容 + 期限 + 可 revoke"，**不含 approver 的后续权限**；`:123/:126` 的 claim 期"Approval 有效"清单同样不含 approver；唯一歧义句在 `:162`。实现侧 `side-effect-authority.cjs:751-798` 只重查**执行侧主体**（task/step/run/session/app/tool grant/resource grant/useByAgent/preconditions/approval 全字段/lease 全字段），`:405-407` 的 approval 快照不含 actor。
2. **同类改动共三处，属同一类**：① approver 被 DISABLE；② approver 被 DEMOTE（撤 ADMIN）；③ approver session 注销 —— 三者在"既有 approval 是否继续有效"上是**同一个问题**（approver 维度当前 **0 项检查**），实现没有单独特殊对待任何一处。
3. **产品可达性**：ADMIN 可批准**他人**任务（`:265`）；UI 可达。实测：admin 批准 alice 任务后 admin 被 DISABLE/DEMOTE → 仍 `leaseOk+execOk+1 mutation`；对照：注销**执行主体**（alice）session → `AUTHORIZATION_REVOKED` / 0 mutation。
4. **跨账号批准的归属展示**：批准人是他人时，APPROVED 行只记 approverUserId，任务 owner 视角看不到"谁批的"以外的信息；ADMIN 跨用户批准是**既有设计**，非本轮新增权限。
5. **推送泄漏（A16）已修**：推送此前无 session 过滤（`identity-bootstrap.cjs:140`、`side-effect-runtime.cjs:110`）→ 他人/未登录会话可收到审批元数据；本轮已按当前会话重投影 + `approvalSnapshot` 严格化（见 §3 第 16 行）。
6. **没有产品撤销入口（A18）**：`revokeApproval` 在 `electron/` 无生产调用方（仅测试/内部路径）。即"撤销既有批准"目前**只能靠 TTL 自然过期**，用户无法主动收回。
7. **安全后果（不改变的事实）**：执行主体始终被全量重查；无重复副作用、无错误成功、无泄漏；**唯一条件是产品口径**——批准人失权是否应使已批准 call 失效。若口径为"应失效"，则当前实现构成**条件性越权**（需 approver 在被批准后、call 执行前失权，且被批准 call 仍在 TTL 内）。

**B. 可选方案与影响（不做选择，待裁决）**

| 方案 | 做法 | 影响 | 代价/风险 |
| --- | --- | --- | --- |
| **A. 保持解耦 + 明确文档化** | ADR 写明"Approval = 内容授权 + TTL + 显式 revoke；approver 后续失权**不**回溯已批准 call"；同时登记"产品无 revoke 入口" | 零执行语义变更；口径唯一、可审计；与现有实现一致 | 需要产品明确接受"批准人失权 ≠ 批准失效"；若不接受，方案作废 |
| **B. 执行期重查 approver（完整版）** | eligibility/claim 内加入 `approverUserId` 权限重查（DISABLE/DEMOTE/session 注销任一 → 拒执行） | 与"权限实时有效"口径最一致 | **执行语义变更**：已批准 call 可能因第三方（批准人）状态变化而失败；须定义失败码、是否允许重新批准、与 TTL/revoke 的优先级；旧数据与并发窗口需新测试 |
| **B-窄. 仅要求 approver 批准时与执行时都 ACTIVE 且仍具 ADMIN（且 approver ≠ owner）** | 只查"是否仍有批准资格"，不做 session 绑定 | 覆盖最危险的"被降权/停用者批准"场景，语义扰动小于 B | 仍是语义变更；需定义 owner 自批路径不受影响的边界 |
| **C. 补齐产品撤销能力（与 A 或 B 并行）** | 新增 `sideEffect/revokeApproval` 产品入口（owner/ADMIN）+ UI | 用户可主动收回批准，不依赖 approver 状态推断 | 新增权限面与 UI，需要单独的授权/审计设计（谁能撤谁的批准） |

**复核者（内部）建议**：**A + C 组合**（先把口径写死并补撤销入口），若产品要求"批准人失权即失效"则改 **B-窄**；不建议在无产品决定前先行改 eligibility/claim。**本轮未做任何执行语义变更**；A18（撤销入口缺失）单列为登记项。

### 4.3 A5 · 跨任务同资源操作（**契约允许**）
- **契约与位置**：ADR `:27`（Lease 非业务锁）、`:138`（Domain 事务内乐观并发）；`tool-adapters.cjs:55-66`、`#preconditionsOk`、`#authorizeLive`、`resource-service.cjs:687-716`。
- **分类**：契约允许行为（Domain 兜底有效）；"是否提升到资源维度互斥"属新功能。
- **产品可达性与复现**：admin task1 + alice task2 同资源各自真实批准：task2 先执行 1 mutation SUCCEEDED；task1 后执行 `leaseOk:true` 但 `SIDE_EFFECT_AUTHORIZATION_REVOKED`、**0 第二次 Domain 调用**、败者经 `recoverAfterExecutorExit` 收敛 FAILED 并回收 lease；trash 不改 version，真正判据是 `trash_state`/`registry_status`。
- **后果**：越权否 / **重复副作用否** / 错误成功否 / 永久占用否 / 泄漏否。
- **防护层与可绕过性**：跨任务只"绕过"第一道（task 维度安全扫描），claim 期实时授权 + Domain 乐观并发两道 fail closed。
- **封板影响**：**不阻塞**；资源维度互斥需显式产品需求（本轮**不做**）。

### 4.4 A6 · `status=BLOCKED` 被安全判定视为安全（**未验证疑点**）
- **契约与位置**：`side-effect-authority.cjs #finishKnownNoEffect`（`knownNoEffect ? FAILED : BLOCKED`）；`task-service.cjs #sideEffectSafety` 视 BLOCKED 安全。
- **分类**：**仍未验证的疑点**（不写成已确认漏洞）。
- **产品可达性与复现**：用 test-only 说谎 adapter 可证明"该模式危害成立"；生产 adapter 的 mutation 与返回值同源（`resource-service.cjs:698-713` 单事务，失败回滚），**构造不出**"已生效却为 BLOCKED"。
- **后果**：理论（仅谎报 adapter）/ 生产不可达 / 无越权、错误成功、泄漏。
- **防护层与可绕过性**：adapter 白名单 + Domain 事务原子性；被绕过前提是未来 adapter 自己说谎。
- **封板影响**：**不阻塞**；登记为**未来 REVERSIBLE_WRITE 工具的准入门槛**（新增工具必须证明 mutation 与结果同源）。

### 4.5 A13 · S3 · `identity-store.transactSync` 无连接内互斥 / 与异步 `transact` 交错（**当前不可达的结构性隐患**）
- **契约与位置**：`identity-store.cjs:1234-1250`（注释已更正为如实描述："连接级同步事务，BEGIN IMMEDIATE 在 try 外、无连接内互斥，事务体内绝不能有 await"）。
- **分类**：结构性隐患，**当前 commit 生产不可达**。
- **产品可达性与复现**：6/6 异步 `transact` 事务体全同步、KDF 均在事务外；SQL 级插桩跑 74 个进程 / 22308 BEGIN → `nestedBEGIN=0`、orphan=0；失效形态是"第二个事务硬失败"，非数据损坏。
- **后果**：均否；若未来有人在事务体加 await → 窗口内同步写硬失败（若被静默 catch 则丢写）。
- **防护层与可绕过性**：仅 `transact()` 的队列；同步路径靠 SQLite 自身报错 fail closed；不可被 Harness/用户远程触发。
- **封板影响**：**不阻塞**；登记硬化项（连接级 `isTransaction` 断言 + 禁止 await 的显式声明）。

### 4.6 A14 · R-8（**原为待裁决项 → 本轮按裁决修实现并复核 CLOSED**）
- **原事实**：F-2 的旧任务懒绑定兼容策略下，旧任务首次运行无可用默认时保持未绑定；默认若在签发 capability 前出现，则以当前默认真实执行（SUCCEEDED、1 provider 请求、1 artifact），而 task/run/call 归属仍为 `null`——无越权/重复/错误成功/泄漏，但**审计归属缺失**。
- **本轮裁决（原话口径）**："任务可以保持未绑定，但不得在未绑定时启动模型调用或工具执行。" → 实现取"**拒绝创建 run**"（而非拒绝签发 capability）：解析失败即返回错误、0 副作用，Step/Task 收敛 BLOCKED；解析成功才在同一事务绑定（`task.model_config_bound` 语义不变）；`modelService == null` 的 test-only 桩装配保持既有行为（代码内注明例外）。
- **复核（B，CLOSED）**：三入口 + `task/run` IPC 实测 `{newRuns:0,cap:0,toolExec:0,calls:0,reqs:0,artifacts:0}`、BLOCKED、任务仍未绑定；默认迟到后重新解析 + 绑定（事件 + run/call 归属）真实 SUCCEEDED；升级前旧库行经追加运行后旧 run/call **逐字段不变**；并发两个运行归属组合唯一；反例尝试 8 条命中 0。
- **夹具对齐（合规）**：`tool-harness-fixture.mjs` 改为"可解析则创建时真绑定（admin 路径实测保住：EXPLICIT + 0 次懒绑定），否则退回 test-only 桩（alice 路径：`PROXY_UNAUTHORIZED`）"；alice 的两处消费方只用该 run 做 propose/plan/approve/lease/eligibility，不经真实 TaskService 推进，不丢覆盖（39/39）；`restart-writer.mjs` 有意保持升级前"未绑定 + RUNNING"DB 形状（消费方 2/2）；`d4-04-executor-unavailable` 仍是真实装配（1/1）。
- **封板影响**：**已闭环**（不再阻塞）。

### 4.7 A18 · `revokeApproval` 无产品入口（**登记，待裁决**）
- **契约与位置**：ADR 定义 Approval "可 revoke"；`side-effect-authority.cjs revokeApproval` 在 `electron/` 内**无生产调用方**（grep 仅测试/工具路径）。
- **分类**：契约**未落地为产品能力**（口径缺口，非安全缺陷）。
- **后果**：用户无法主动收回已批准 call，只能等 TTL 过期；无越权/重复/泄漏。
- **封板影响**：**不阻塞安全封板，属于 §4.2 方案 C**（补入口）；是否做、入口归谁（owner / ADMIN / 二者）需产品裁决。

### 4.8 A20 · 迟到 DENY 的 `TOO_LATE` 在 UI 静默丢失（**本轮复核新发现，待产品/UI 裁决**）
- **契约与位置**：`electron/side-effect-authority.cjs denySideEffect` 返回 `{ok:false, error:"SIDE_EFFECT_APPROVAL_TOO_LATE"}`；renderer `ApprovalPrompt` 在 `res.ok===false` 时先 `setNotice(...)` 再 `setRequest(null)`，而 `if (!request) return null` 使 Dialog 连同 notice 一起卸载（`ApprovalPrompt.tsx:102-103,109,152`）。
- **分类**：**可用性/反馈缺口**；安全语义正确（不显示"未执行/已拒绝"假象，真实 Electron A25/A27 实测）。
- **产品可达性与复现**：需 trusted 用户在 in-flight 期间对同一请求再次做出 DENY 决策（重复/陈旧决策或第二窗口）。实测 A26：错误码确实到达 Renderer（`SIDE_EFFECT_APPROVAL_TOO_LATE`），但面板静默关闭，用户得不到"你的拒绝未生效、写入已发生"的任何反馈。
- **后果**：无越权/重复副作用/泄漏；用户对"拒绝为什么没生效"不可知（可能重复尝试或误以为系统吞掉了操作）。
- **封板影响**：**不阻塞**。选项：**(a)** 保持现状 + 文档化（最小改动）；**(b)** 用 Dialog 之外的既有反馈通道（toast/面板 error 区）展示 `TOO_LATE`（推荐，改动小且不改审批语义）；**(c)** 保留 Dialog 并就地显示 notice（需改弹窗生命周期，动 UI 状态机）。
- **补充（实现者自查，如实登记）**：① 幂等例外严格限于"call 已 BLOCKED **且** 最新有效 approval 为 DENIED"；**超时/放弃产生的 BLOCKED（无 DENIED 行）再收到 DENY → `TOO_LATE`**，其 UI 文案仍是通用"已失效"；② `src/**` 的 `ApprovalPrompt` `!res.ok` 文案（"…未执行任何操作"）**当前不可达**（`setRequest(null)` 后组件直接 `return null`），若前端将来渲染该 notice，需按 `SIDE_EFFECT_APPROVAL_TOO_LATE` 显示权威 `callStatus`（本轮不改前端）。

### 4.9 A11 / A12 · 租约收敛的两个低危残留（**登记，不阻塞**）
- **A11（合成态）**：`recoverAfterExecutorExit` 终态回收依赖 `activeLeaseOfCall` 取最新一条，多条 ACTIVE lease 的排序可致匹配 lease 不被回收（真实 API 造不出该态）。
- **A12（低）**：`recoverAfterExecutorExit` 的 LEASED→FAILED 与 `releaseLease`（`electron/` 无生产调用方）为两事务拆分，窗口产物是"LEASED + 无 ACTIVE lease"（**不违反** ADR`:132-134`），缺幂等自愈入口但可 re-acquire。
- **后果**：均无越权/重复/错误成功/泄漏；**封板影响：不阻塞**。

### 4.10 B10 · 过度遮蔽（**有意取舍，数字更新**）
- **契约与位置**：`tool-domain.cjs` 落库/投影判据（比拒绝判据宽）与 `SECRET_VALUE_RE`。
- **分类**：契约允许行为（可读性/取证保真代价）。
- **可达性与复现**：同语料实测 `0.55% → 1.82%`；prose 密集语料 `0.68% → 3.45%`；病态长串最坏 2.9ms（无 ReDoS）。
- **后果**：**反向**（不增加泄漏）；影响面：失败 Verification 证据展示（≤400 字）与落库审计文本；Approval UI 不展示参数。
- **封板影响**：**不阻塞**；建议保持现状，审计口径按上述数字登记。

### 4.11 B11 · 去敏投影长度上界（**信息级，已入注释**）
- **契约与位置**：`tool-domain.cjs` 投影判据；列 `arguments_safe TEXT` 无长度约束。
- **分类**：契约允许（文档口径差 ≤15 字符）。复现：20000 例 battery MAX=`271`（=256 + 标记余量）。
- **封板影响**：**不阻塞**；**禁止 clamp**（会切半完整标记、破坏 B5 fail-closed 不变式）——该结论已写进代码注释。

### 4.12 B12 · 执行入参缓存条目无字节上限（**条件性硬化项**）
- **契约与位置**：`controlled-tool-proxy.cjs EXECUTION_ARGUMENTS_MAX=64`（仅条数上限）；`tool-domain.projectArguments` 数组/对象元素不递归有界。
- **分类**：当前生产**不可达**的潜在风险（test-only array contract 可造 32MB/条 × 64 = 2GB；落库侧被递归去敏+截断限住）。
- **后果**：仅潜在进程内内存放大（FIFO 可回收、不落盘）。**防护**：条数 64 + Bridge 256KiB body cap；contract 只能由 trusted code 注册。
- **封板影响**：**不阻塞**；登记为"**新增任何带 array/object 属性的 Tool contract 之前必须加字节预算**"的前置条件。

### 4.13 B13 · `[REDACTED]` 字面量误 fail closed（**可用性取舍，保持**）
- **契约与位置**：`controlled-tool-proxy.cjs #argsOf`（完整标记 fail closed）。复现：合法 ALLOWED 值字面含 `[REDACTED_PATH]` + 冷缓存 → `TOOL_ARGUMENTS_PROJECTION_UNAVAILABLE`、0 执行；热缓存正常且 adapter 收原文。
- **后果**：仅可用性（最坏该 step BLOCKED，可 resume/append 恢复）；无越权/泄漏/静默换参。**拒绝方向即安全方向**。
- **封板影响**：**不阻塞**；建议保持并如实登记。

### 4.14 A15 · 两个微项（**登记**）
- 抑制分支在 known-no-effect 场景返回 `knownNoEffect:false`（保守，仅影响返回值语义）。
- `#lateResultSuppressed` 直接解引用 call；当前无任何 `DELETE FROM side_effect_calls` 路径，属理论项。

### 4.15 A22 · revision 冲突败者留下悬挂（**预先存在，登记**）
- **来源**：第十轮复核（B）在 R-8 并发探针中发现的预先存在观察，非本轮引入。
- **契约与位置**：`task-harness-orchestrator.cjs` 的 `if (!running.ok) return running;` 与 `#conflict` 早退路径（`f1bff21` 即存在；`2c5dc29` 的 `runStep` 只新增了 runRes 失败分支与 callRes 分支）。
- **分类**：既有并发语义（非本轮引入）。复现（B）：并发两运行，败者留下 1 个 STARTING run（task 已 BLOCKED）；无默认并发时败者留下 1 个 RUNNING step。
- **后果**：无越权/重复副作用；重启 recovery 会收敛；**封板影响：不阻塞**；登记为低危硬化项（冲突早退时同步收敛自身 step/run 终态）。

### 4.16 夹具对齐的两点说明（**合规，非缺陷**）
- **test-only 桩例外**：`startHarnessRun` 在 `modelService == null` 时保留"可建未绑定 run"的旧行为，仅供测试装配；产品装配（`identity.taskService`）恒有 modelService，故产品路径不存在该例外。复核者已在代码内核对并实测（探针 E）。
- **`restart-writer.mjs` 形状保持**：该夹具有意保留升级前"未绑定 task + RUNNING run"的 DB 形状，供重启恢复断言使用（行与改动前逐字段同形，消费方 `task-harness-recovery` 2/2）。
- **A21 的可达性前提**：产品 API 写入的 capabilities 始终是合法 JSON，`resolveModel` 抛出需外部改库才能触发；本轮已按"抛出 = 返回失败"同一路径收敛（见 §3 第 20 行）。

### 4.17 A26 · 其余 4 处 `resolveModel` 调用点未把抛出转成显式错误码（**登记，健壮性缺口**）
- **契约与位置**（第十一轮逐点核查，grep 全部 production 调用点）：① `task-service.cjs:216 createTask(modelConfigId)`——resolve 在 `insertTask` 之前，**不写任何状态、无悬挂**，影响是"异常代替干净拒绝"；② `task-bootstrap.cjs:139 task/run` 产品入口——同上（IPC handler reject，不建任务、无悬挂）；③ `model-proxy.cjs:35 issueCapability`——抛出发生在 `adapter.start` 内，被 orchestrator 既有 try/catch 接住 → `#blockStep` 收敛（**有收敛、无悬挂**），仅原因码退化为 `INTERNAL_ERROR`（保真度问题）；④ `model-proxy.cjs:110` 与 `model-service.cjs:216/250/337`（chat/chatStream/testConnection）——Task 状态由 orchestrator 的 harness 失败分类收敛，不产生悬挂。
- **分类**：健壮性缺口（不构成悬挂、不构成越权/重复/错误成功/泄漏）；**本轮之后不存在能留下悬挂 run 的 `resolveModel` 调用点**。
- **封板影响**：**不阻塞**；建议后续按"抛出 = 显式错误码"的统一口径逐点硬化（其中 ① 在既有实现者文件范围内，② 归产品入口 owner，③④ 归 model-service owner）。

## 5. 经核对未发现问题的方面（不变量 + 依据）

1. **claim-time TOCTOU 重校验有效**：审查者自建"eligibility 后、claim 前"注入撤权矩阵 **6/6 fail closed、0 Domain 调用**（app 禁用 / tool grant 撤销 / session 撤销 / 用户禁用 / resource grant 撤销 / useByAgent 撤销）；claim 在同一 `BEGIN IMMEDIATE` 内重读 task/cancel/RUNNING/actor/app/step/run/tool 版本与 effectClass/`#authorizeLive`/preconditions/approval 全字段/active lease。
2. **approval 精确绑定**：planHash/argsHash/toolId/version/effectClass 逐项比对；篡改 `approvedToolId` → PLAN_STALE。
3. **结构上不可能第二次 claim**：枚举全部 `updateCall` 调用点；进 LEASED 只有 `acquireLease`、进 RUNNING 只有 claim。
4. **并发/重复投递**：同 callId + 同 toolId + 同 canonical args 指纹 → 同 outcome（0 额外执行/预算）；callId 冲突 → `409 TOOL_CALL_ID_CONFLICT`；maxCalls=1 并发 unique call 恰好一个成功。
5. **idempotency**：`UNIQUE(idempotency_key)` + 同绑定校验。
6. **UNKNOWN_EFFECT / quiescence fail closed**：三态只读 recovery verification；`quiesced=true` 只能来自同一存活 supervisor 的真实 `child.on("exit")`；AUTO_RETRY 恒 0。
7. **resume/append 不绕过工具边界**：最危险状态 → resumable=true 但续接 run 仍被 denied-write 门拦成 `TOOL_FORBIDDEN`、0 执行。
8. **final text 掩盖被两道后端门拦住**（A33 验证失败门 + 被拒 WRITE 门），唯一提交点 `commitStepSuccess`。
9. **Bridge 输入信任边界正确**：body 自报 scope/session/app/task/step/run/proposalId/riskClass/approved/approvalId/leaseId/effectClass/idempotencyKey 全被忽略；WRITE route 不把 Harness callId 当 authority id。
10. **capability 不落库/事件/artifact**：真实 WRITE 全链后全库 63 表 + 事件 + artifact + DSH_HOME 扫描 0 命中。
11. **失败 Verification 关联**：键为 `(tool_id, arguments_hash)`、hash 缺失回退 execution 唯一键、顺序 `started_at,rowid`。
12. **预算门控在 run 创建之前**：任一使用到的 kind `remaining==0` → 不建 run、不消耗、直接 BUDGET_EXHAUSTED。
13. **F-2 后模型归属可查**：产品任务 task/run/call 行绑定一致；默认切换不回写历史任务；改版任务不被静默复活（需新建任务）。
14. **DENY 前置的两序竞态均已收口**（本轮新增）：claim 先提交 → DENY 读 RUNNING → `TOO_LATE`、零写入；DENY 先提交 → claim 读 BLOCKED → `CALL_STATE`、0 Domain 调用；实测无第三种结果（`afterEligibilityBeforeClaim` 真实同步点）。
15. **DENY 不是取消**（本轮新增）：RUNNING 路径不碰 call/approval/lease/恢复证据，执行按既有生命周期继续收敛（SUCCEEDED/PASS + 1 mutation + lease RELEASED）；无新增 cancel/kill/abort 能力。
16. **推送/读取过滤不影响 owner**（本轮新增）：owner 1 推送、13 字段白名单、与 `getApprovalRequest` 逐字一致、决策成功；`context==null` 内部投影语义未变（noArg/context:null 仍返回对象）。
17. **A17 修复不改变执行判定**（本轮新增）：parity 五路签名逐字对照，唯一差异是过期场景的展示字段 `effectiveDecision`。
18. **R-8 反例 8 条命中 0**（本轮新增）：未绑定仍启动 / 默认迟到沿用旧 run / 并发绑定分裂 / 历史被回填 / 桩路径越权 / caller 覆盖归属 / 解析与建 run 之间的窗口 / 未绑定经 Facade 启动真实模型。

## 6. 无法验证的事项（如实列出）

1. 真实双主进程 / 孤儿 executor 的**进程调度**级交错（A7 已用真实双进程 probe 验证；T4/T8 为同 DB 双连接 + 真实 recoverOnStartup 交错）；
2. 跨用户 approval 后 approver 被禁用/降级的**真实 Electron 双账号端到端点击**（只读约束下用同一 IPC 服务调用链替代）；
3. 跨平台：Windows 命名管道 / 路径形态（拒绝判据刻意保持窄口径）、Linux 形态；
4. 真实 Electron 主进程装配的端到端顺序（本轮以代码核对 + 隔离树真实 main E2E 覆盖产品入口）；
5. 真实 `kill -9` quiescence 与多 session 并发 approve 的新复现（复用既有 C3 套件结论）；
6. 迟到 DENY 的 UI 反馈（A20）在真实用户操作节奏下的可达频率（真实 Electron UI 探针第 23–28 条已证明路径可达，未统计频率）。

## 7. 封板判定与仍需裁决的问题

**已满足（内部独立预审层面）**：未参与实现的独立审查（两名、十一轮）已完成；**22 项已确认缺陷**全部最小修复并经**同一独立审查者**在冻结修订上复核 CLOSED（含真实双进程、真实 Bridge、真实 Electron UI、全库扫描、parity 对照、基线区分力对照）；被测 commit 干净树上 D4-03 十六门禁 + D4-01/02 相关门禁 + D4-04/05/06 + 真实 main E2E + `npm test` 全绿（数字见 §8）；未扩权、未改工具门与执行入参语义、未改 REV-03 执行语义。

**未满足（故本轮不封板）**：
1. **缺"由实现方之外的审查者作出的封板裁决"**（原文指名 ChatGPT；本轮审查者与实现方同源）；
2. **缺产品/UI 裁决**：A3 REV-03/S2（approval 是否绑定 approver 后续权限；四个方案见 §4.2）、A20（迟到 DENY 的 UI 反馈，三选项见 §4.8）、A18（是否补 `revokeApproval` 产品入口）；
3. **缺低危登记项的处置决定**：A2/A5/A6/A11/A12/A13/A15/A22/A25/A26 与 B10/B11/B12/B13。

**外部审查者需要的输入包（已备齐）**：本文件（§3 统一编号 + 逐项位置/测试/commit/预期/实际/三态 + §4 六要素澄清 + §8 命令与数字）+ 十一轮审查报告要点 + 探针清单（`/tmp/rev/**`、`/tmp/probe-*`、`/tmp/d403*`）+ 被测 commit `1594771e94d13a6a72dd49e473a7c90390c6efc8` + `docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`。

## 8. 实际检查（最终被测 commit `1594771e94d13a6a72dd49e473a7c90390c6efc8`，干净树 `workspaceState=""`；门禁/证据均在该 commit 上重跑，`42ebe3b` 的同名数字仅作历史轮次记录）

| 检查 | 结果 |
| --- | --- |
| D4-03 十六门禁 | 全 **exit 0**（`testedCommit=1594771`）：A 32/32、B 59/59、C1 48/48+52/52、C2 29/29+38/38+45/45+51/51、C3 56/56+63/63、C4 35/35+**UI 28/28**+15/15+12/12+9/9、D 52/52+62/62 |
| D4-01 / D4-02 相关 | `test:d4-01` 59/59、`test:d4-02a` 22/22、`test:d4-02b` 16/16、`test:d4-02c` 22/22（schema v16、dsh 0.1.5-rc.2、acp 1.4.0） |
| 受影响回归 | D4-04 **94/94**、D4-05 **173/173（S1–S4 PASS）**、D4-06 **119/119**、d4-06-resume **21/21**、d4-08-verification-ui **22/22** |
| 本轮新增/扩展测试 | `tests/d4-03-deny-state-protection.test.mjs` **12/12**（基线 `ad5e600` 上 8 用例仅 2 通过；收尾新增 T9/T9-b/T9-c）、`tests/d4-03-approval-push-isolation.test.mjs` **8/8**（基线 4/8）、`tests/d4-03-model-binding.test.mjs` **19/19**（含 `D4-03 P` 抛出同形、`D4-03 Q` 已绑定路径两窗口）、`tests/d4-03-lease-state-integrity.test.mjs` 10/10、`tests/d4-03-run-entry-guard.test.mjs` 7/7、`tests/tool-argument-projection-redaction.test.mjs` 21/21；本轮受影响 node 套件合计 **77/77** |
| 真实 main E2E | `node tests/d4-main-e2e.mjs` 在**干净树**连续 2 次 → **133/133、七条必需流程（boot/setup/flow1–flow6）全 PASS、`overallStatus=PASS`、exit 0、`workspaceState=""`、`testedCommit=1594771`**；gate `artifactSha256` 分别 `20c74b54c4110c87ea77b4cd4cf7a58ff0ea53eda3fb7a98ee15c50ad6bba03f` / `99ddecee23ee1856773d73a8c4f25a410a812b5056e1a9a9a61aa3d7521ae739`（证据文件 `docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json` 自身 sha256 `c528ff7db9ad70b60dd9d24979a677f33c491313441d829cdad7d09e5da9b979`） |
| 全量测试 | `npm test` **1088/1088**、exit 0；`npm run build` exit 0 |
| 独立复核（冻结修订） | A9/A10：R7-a/R7-c/R6-C2/C3 反例全关 + 真实 Electron UI 探针 6/6（探针内第 23–28 条）；A23：修复前副本 12 用例 fail 2（真实复活证据）→ 修复后 12/12；A19：`isKnownEventType` false→true 且无其它未登记 TaskEvent；A21：抛出路径与返回失败路径逐项同形；A24：已绑定路径两窗口（预检/`startModelCall`）修复前 RUNNING+STARTING 悬挂 → 修复后 BLOCKED（真实探针四段，含 capability 回收 REVOKED + 直连 401），`MODEL_CONFIG_CHANGED` 原路径逐字未变；A16：owner/他人/未登录三态 + 基线区分力 4/8→8/8；A17：五路 parity 唯一差异为展示字段；A14：三入口 0/0/0/0/0/0 + 反例 8 条命中 0 + 夹具逐行核对 |

## 9. D4 的 macOS 已验证范围与整体状态

| 子项 | 状态 | 依据 |
| --- | --- | --- |
| D4-01 模型服务（macOS Core） | PASS | `test:d4-01` 59/59 |
| D4-02 任务与适配（macOS Core） | PASS | d4-02a 22/22、d4-02b 16/16、d4-02c 22/22；F-2 已修；**R-8 已按裁决收口（未绑定不得启动）** |
| **D4-03 工具门与租约** | **PASS candidate（内部独立预审通过；本轮不封板）** | 十六门禁全绿 + 十一轮独立审查 + **22 项缺陷闭合**；封板待实现方之外的审查者（§7） |
| D4-04 纵向冒烟 | PASS（限定范围） | 94/94（`testedCommit=1594771`、`workspaceState=""`；证据文件 sha256 `5dd08728db9222738483f999f8d10213bf2a282453188386866a5f2fc8e761d6`） |
| D4-05 执行关卡 | PASS（S1–S4；S4 限定"消息结构 + 授权/执行边界"） | 173/173（`testedCommit=1594771`、`workspaceState=""`；证据文件 sha256 `a4f340fea7216ad508f0a365ae4dd49df2928cef34ffbdc16d33c6e11676cec5`） |
| D4-06 关联链与预算停止 | PASS | 119/119 + resume 21/21 + 失败验证 UI 22/22（`testedCommit=1594771`、`workspaceState=""`；证据文件 sha256 `96b5a82aee61ef167873b2ff9de745adb1d2fdd09fa0d98a0972b0a7ca6414c5`） |
| 真实 `electron/main.cjs` 产品入口 | PASS | 干净树连续 2 次 `133/133`、七条必需流程全 PASS、exit 0（`testedCommit=1594771`） |
| **D4 整体** | **PARTIAL（不自动升级）** | 剩余：**Windows / External Provider = NOT VERIFIED**；**D4-03 待实现方之外的审查者封板**；产品/UI 裁决（REV-03/S2、迟到 DENY 反馈、revoke 入口）与低危登记项处置待决；OS 级网络沙箱 / 跨重启 durable death proof 等既有挂账不变 |

Windows 与 External Provider 的限制**单独保留**，不因本轮任何结论被改写。

## 10. 唯一推荐的下一阶段任务及前置条件（不开始实施）

**推荐：D5-01 浏览器**（`PLAN.md:501`：`D5-01 浏览器 \| 前端 \| D2、D3-05、D1-01 \| 真实浏览器 \| 导航下载会话隔离及遮挡正确`）。
前置：**D2**（D2-01 设计系统 PARTIAL、边界已声明；D2-02 窗口系统 ADR `docs/decisions/D2-02-window-system.md`）、**D3-05**（macOS PASS）、**D1-01**（macOS 桌面核心 PASS；Windows NOT VERIFIED 保留）；PLAN 依赖表未把 D4 列入 D5-01 前置，D5-02/03/06/08 才以 D4-05（已 PASS）为前置。
**建议**：先完成 D4-03 封板裁决与 §7 的产品/UI 裁决，再进入 D5-01；**本轮不开始实施**。

## 11. 修改文件（本轮）

- **本轮代码/测试提交 `2c5dc29`**：`electron/side-effect-authority.cjs`（DENY 状态前置 + `TOO_LATE` + `effectiveApproval` 行名）、`electron/task-service.cjs`（未绑定不得建 run）、`electron/task-harness-orchestrator.cjs`（配置解析类失败 `#blockStep`）、`electron/identity-bootstrap.cjs`（推送按当前会话重投影）、`electron/side-effect-runtime.cjs`（`approvalSnapshot` 严格化）、`tests/d4-03-deny-state-protection.test.mjs`（新）、`tests/d4-03-approval-push-isolation.test.mjs`（新）、`tests/d4-03-model-binding.test.mjs`（K–O）、`tests/fixtures/harness-acp/tool-harness-fixture.mjs`、`tests/fixtures/harness-acp/restart-writer.mjs`、`tests/d4-04-executor-unavailable.test.mjs`、`tests/fixtures/side-effect-ui-probe/main.cjs`。
- **本轮测试提交 `51f90f0`（test-only）**：`tests/d4-main-e2e.mjs`（F6.4/F6.7/F6.8/F6.10/F6.11 与 F4.43 的确定性接受判据 + 断言收紧；**该提交不含任何产品代码**）。
- **本轮收尾提交 `42ebe3bf0304857ce9b3e8973bb599ac9bc018f6`**：`electron/task-domain.cjs`（A19 事件登记）、`electron/task-service.cjs`（A21 抛出收敛）、`electron/side-effect-authority.cjs`（A23 approve 同一事务 + 状态前置）、`tests/d4-03-deny-state-protection.test.mjs`（A19/A23 断言与 T9/T9-b/T9-c）、`tests/d4-03-model-binding.test.mjs`（`D4-03 P`）。
- **最终被测提交 `1594771e94d13a6a72dd49e473a7c90390c6efc8`**：`electron/task-service.cjs`（A24：`#boundModelConfig` 抛出收敛）、`electron/task-harness-orchestrator.cjs`（`startModelCall` 的 `callRes` 分支按 `MODEL_CONFIG_PRECONDITION_ERRORS` 收敛）、`tests/d4-03-model-binding.test.mjs`（`D4-03 Q`：预检窗口 + `startModelCall` 窗口）。
- **报告/证据提交**：本文件、`docs/D4-ACCEPTANCE-RESULT.md`、`PROGRESS.md`、`docs/decisions/D4-03C-side-effect-authority.md`（Audit/TaskEvent 清单登记 `deny_too_late`）、`docs/D4-04/05/06-GATE-EVIDENCE.json`、`docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`。
- 审查者全程未修改仓库任何文件；探针只写 `/tmp`。
