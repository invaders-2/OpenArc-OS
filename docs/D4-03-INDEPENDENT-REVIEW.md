# D4-03 独立审查与 D4 阶段收口（Independent Review · 2026-09-18）

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`；分支：`feature/d4-03-tool-proxy`
- **Base HEAD**（开工核对，干净）：`c83e48623955430e286f350b629864a84d2030e9`
- **代码/测试提交（被测 commit）**：`f63e87ac5390e65fd733bf6467f693a5cc67a4f1`（提交后工作区干净）
- **报告/证据提交**：本文件 + `docs/D4-ACCEPTANCE-RESULT.md` + `PROGRESS.md` + `docs/D4-04/05/06-GATE-EVIDENCE.json` + `docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`
- 远端：`origin/feature/d4-03-tool-proxy = 67357ef`（本分支未 push）；`origin/main = 823242a`（未合并 main）

## 0. 结论摘要

1. **组织了未参与实现的独立审查**（两名独立审查子 Agent，只读仓库、探针仅写 /tmp，四轮：发现 → 复核 → 残留修复 → 确认）。
2. **确认并修复 2 个主缺陷 + 4 个同根因残留**：`REV-01`（高，能力层缺守卫）、`F-1`（中，参数与证据的持久化去敏契约被破坏）及 `R-1/R-2/R-3/R-5'`；全部由同一独立审查者复核 **CLOSED**。修复集中在 5 个 `electron/` 文件 + 2 个新测试文件，未扩大权限、未改工具门语义、未改执行入参语义（有 HEAD 对照证据）。
3. **D4-03 不封板**：原始封板条件明确要求"**由实现方之外的审查者（原文指名 ChatGPT）审计后裁决**，DeepSeek 无权正式封板"。本轮审查者与实现方同属一个模型家族，**只构成"未参与实现的独立审查者"内部预审，不构成外部审计**，故不据此封板。D4-03 维持 **PASS candidate（内部独立预审通过）**，缺什么见 §7。
4. **D4 整体维持 PARTIAL**：Windows / External Provider 等既有 NOT VERIFIED 项不变；新增一项待裁决（`F-2`）。真实 `electron/main.cjs` 产品入口五条必需流程在本被测 commit 复跑仍全部 PASS（`120/120`、exit 0）。

## 1. 依据：原始要求与封板条件（引用具体出处）

| 出处 | 原文要点 |
| --- | --- |
| `PLAN.md:498` | `D4-03 工具门与租约 \| 后端、运维 \| D4-02、D3-03 \| 授权执行及回报 \| 重复调用与离线结果处理正确` |
| `docs/D4-03C4-RESULT.md:14` | "（DeepSeek 无权正式封板；由 ChatGPT 审计后决定 `D4-03C = PASS`。）" |
| `docs/decisions/D4-03C-side-effect-authority.md:511` | "`D4-03D Closure = PASS candidate`、`D4-03D = PASS candidate`、`D4-03 overall = PASS candidate`（DeepSeek 无权封板，由 ChatGPT 审计后决定 `D4-03 = PASS`）。" |
| `PROGRESS.md` # D4-03 当前状态 | 各子项 A/B PASS、C1–C4 与 D/Closure 均为 PASS candidate；**D4-03 overall = PASS candidate** |

**判定**：该条件要求的是**实现方之外的审查者作出的封板裁决**（不是第三方机构、不是人工审计、不是特定环境），且明确剥夺实现方（DeepSeek）的封板权。因此本轮只能完成"内部独立预审"，并必须说明**缺什么**（§7），不得继续只写"待外部审计"。

## 2. 审查者独立性、范围与方法

**独立性**：两名审查子 Agent 均为派工前从未接触 D4-03 实现的独立实例，任务书写明"你没有参与实现、也不参与修复"；审查前后 `git status --porcelain` 一致（渲染/仓库零改动）；一切探针只写 `/tmp`；明确"不得以测试全绿代替审查结论"。**但审查者与实现方同属一个模型家族 → 本轮是内部独立预审，不是外部审计。**

**范围（六块，按任务书）**：
1. 身份/权限/工具范围/批准内容绑定，撤权后能否执行；
2. 租约/claim/并发/重复请求 → 是否可能重复副作用；
3. executor 退出、无法证明停止（quiesced=false）与 UNKNOWN_EFFECT 是否正确阻断、有无危险重放；
4. 模型配置变化/预算停止/显式续接/追加步骤是否绕过工具边界；
5. 验证失败/执行被拒/结果未知是否可能被最终文本掩盖；
6. 工具协议输入与持久化记录的信任边界是否违反既有契约。

**方法**：先自行形成"该机制应保证什么"的不变量，再找反例；复用同代码同环境下仍有效的既有验证（D4-03 十六门禁 + 相关 Node 套件），只对具体疑点补充有区分力的只读探针；协调者对每条已确认发现**亲自复现**后才授权修复。

## 3. 已确认问题、修复与复核

| ID | 严重级别 | 发现（触发条件 / 影响 / 位置） | 复现证据 | 最小修复 | 独立复核 |
| --- | --- | --- | --- | --- | --- |
| **REV-01** | 高（能力层缺守卫；当前 Renderer 不可达，属"未来任何入口即被击穿"） | `TaskHarnessOrchestrator.runTask()` 是第三条"启动新 run"入口，无任何未决副作用守卫。任务 BLOCKED + call=UNKNOWN_EFFECT 时 resume/append 都拒绝，runTask 却开新 step/run，official dsh 再次提出同一 WRITE 并真实执行**第二条 SideEffectCall**，任务最终写成 SUCCEEDED，`getRecoveryState().applicable=false`，恢复入口消失。位置：`task-harness-orchestrator.cjs:141-150`、`task-service.cjs:185-204`、`task-domain.cjs:202-211` | `/tmp/probe-e-finalstate.mjs`（协调者亲自复现）：`task=BLOCKED call1=UNKNOWN_EFFECT` → `runTaskAccepted=true / secondCallCreated=true / task=SUCCEEDED` | `TaskService` 新增 `#sideEffectSafety` 单一来源 + 只读 `getSideEffectSafety`；resume/append 改消费同一判定（`RESUME_*/APPEND_*` 字符串逐字不变）；`runTask` 在 `startTask` 之前守卫，命中返回 `RUN_BLOCKED_UNRESOLVED_SIDE_EFFECT`（reason=UNKNOWN_EFFECT/SIDE_EFFECT_PENDING/ACTIVE_LEASE），**0 状态变更**。`startTask` 的 BLOCKED→RUNNING 冻结语义（`tests/task-recovery.test.mjs:64`）未改 | 第二轮：**CLOSED**。状态逐项零变化（revision/step/run/call/lease/27 条 event/artifact 全表一致）、无第二条 call、call1 仍 UNKNOWN_EFFECT、`recovery.applicable=true` 保留、0 mutation |
| **F-1** | 中（契约破坏 + 静态数据泄露） | Harness 声明为 string 的工具参数被原样写入 `task_tool_proposals.arguments_safe`（绝对路径、运行期明文 `tpx_` capability、secret 形态），与 `tool-store.cjs:4-5`"不存 absolute path / raw provider key / proxy bearer"、`tool-facade-bridge.cjs:8-9`"capability 绝不落 SQLite/TaskEvent/Audit/Artifact"冲突；且 `executeReadOnly` 经 `#argsOf` 从该字段回读执行入参 | `/tmp/probe-p1-abs-path.mjs`（协调者亲自复现）：`ABSOLUTE_PATH_PERSISTED=true`；`probe-p3`：`CAPABILITY_TOKEN_PERSISTED=true` / `SECRET_VALUE_PERSISTED=true`；`probe-p1b-dsh-abs` 真实 official dsh 同样可达 | 落库投影与执行入参**彻底解耦**：`projectArguments`（执行用，语义与 HEAD 逐字符一致）+ 新增 `redactProjectedArguments`（落库用，path/capability/credential 值级去敏，递归有界）；执行侧改用进程内存有界缓存（≤64、FIFO、绝不落库）；`arguments_hash` 仍对 raw args | 第二轮：**CLOSED**。四条路径（直连 Bridge / 真实 dsh / 真实 WRITE 全链 / 全库扫描）残留 0；执行语义与 pre-fix `projectArguments` 逐字符一致 |
| **R-1** | 低-中 | 同根因未闭合面：非 macOS 绝对路径（`/tmp`、`/etc/passwd`、`/Volumes`、`/home`、`/Library`、`/opt`、`/root`）仍明文落库 | `probe-n1-redaction-edges.mjs`（审查者） | 新增**持久化去敏判据** `UNSAFE_PATH_PERSIST_RE`（常见系统根 + 通用 POSIX 绝对路径 + 盘符/裸盘符 + UNC + `file://` + 含空格续写）；**冻结的拒绝判据** `UNSAFE_STRING_RE` 逐字符不变（收紧拒绝会改工具门语义） | 第三轮：**CLOSED**（残留 = []，含真实 dsh 与真实 WRITE 全链） |
| **R-2** | 低-中（renderer 可见） | `task-service.EVIDENCE_PATH_RE` 是第三份更弱判据（无 C:\/UNC），失败验证证据经 `task/get → verifications` 投影时除 `/Users` 外全部明文 | `probe-n9-evidence.mjs` | 证据投影复用同一份持久化判据；`depth>=2` 的 JSON 兜底分支也纳入（原本是明文旁路） | 第三轮：**CLOSED**（7 形态 + Windows/UNC/file:// + 深层全部去敏） |
| **R-3** | 低 | 256 截断可能切断路径，留下裸前缀（如 `/Users`，无用户名） | `probe-n1` | 截断分支先清路径残留与半截标记 | 第三轮：**CLOSED** |
| **R-5 / R-5'** | 低（生产不可达） | 冷缓存回退会用**已去敏**的 DB 文本当执行入参（静默换参）；第一版护栏按"完整去敏标记"判定，审查者构造出"标记本身被截断"的反例使其 fail-open | `probe-n2-cache.mjs`、`probe-r5prime.mjs`（审查者） | 护栏：`#argsOf` 回退时命中完整标记即 fail closed（`TOOL_ARGUMENTS_PROJECTION_UNAVAILABLE`，0 Domain / 0 execution record）；**生产侧保证**："被截断且发生过去敏"的值必然含完整标记（预算内补 `[REDACTED]`） | 第三轮 R-5 PARTIALLY → 第四轮 **CLOSED**（原反例 + 19 种变体 + 473 例不变式 battery 违反 0） |

**修复后的关键不变式（独立对照证据）**：
- 执行入参语义未变：`projectArguments` 与 HEAD 对照 77 例不一致 0；ALLOWED 长值场景 adapter 收到值与 pre-fix 投影逐字符相等。
- 工具门拒绝语义未变：`ABSOLUTE_PATH_RE` / `FORBIDDEN_ARGUMENT_KEY` / `containsAbsolutePath.toString()` / `UNSAFE_STRING_RE.source` 全部 === HEAD；端到端 propose 决策对照 18 例不一致 0（`/etc/passwd`、`/api/v2`、`/tmp/x` 等**未新增拒绝**）。
- 全库/事件/audit/artifact 对路径、`tpx_/mpx_`、secret 形态 0 命中（含真实 dsh 与真实 WRITE 全链）。

## 4. 未决项、需裁决项与已知残留（均已登记，不静默）

| ID | 级别 | 内容 | 状态 |
| --- | --- | --- | --- |
| **F-2** | 中（契约措辞反例，**非安全阻塞**） | 产品入口 `task/run` 不传 `modelConfigId` → 产品任务 `tasks.model_config_id/version = NULL`，`MODEL_CONFIG_CHANGED`（§59/§60"config 变化绝不启动"）对产品任务**不可达**，resume/append 的新 run 也不留模型归属；运行中变化仍被 ModelProxy 的 capability→version 绑定拦截（`STALE_CAPABILITY`），**非提权**。位置：`task-bootstrap.cjs:131-141`、`task-service.cjs:331`、`task-harness-orchestrator.cjs:209` | **需产品裁决**：修实现（`task/run` 解析当前默认 configId 传给 `createTask`，形参已存在）或把 ADR/D4-02 口径改为"不冻结"。属 D4-02/D4-04 范围，**本轮报告并停止修改** |
| REV-02 | 低（加固） | `SideEffectAuthority.acquireLease()` 不做身份/授权判定（真实执行仍被 eligibility + claim 事务内全量重校验拦截；`acquireLease` 仅 executor child 与测试调用，未暴露到 IPC/Harness） | 登记，建议加最小权限守卫 |
| REV-03 | 低（需产品口径） | approval 只绑定内容（plan/args/tool/version/effectClass/TTL/revoked_at），不绑定授权人后续权限/角色变化；ADMIN 可批准他人任务 | 登记，需口径 |
| A-4 | 低 | 终态 call（SUCCEEDED/PASS）若在"已提交、lease 未 finalize"窗口崩溃，ACTIVE lease 不会在进程内回收 → 同会话内 append/runTask 被 `ACTIVE_LEASE` 挡死（应用重启经 lease 过期循环自愈）；建议对终态 call 一并 finalize 自身 lease | 登记（未修，非本轮引入） |
| A-5 | 需裁决 | `#sideEffectSafety` 只扫描同 task 的 SideEffectCall；同资源跨任务的未决写入不参与判定（探针实测可达，但需一次全新用户批准，且 `resource.trash` 有 Domain 前置兜底 NO_PLAN） | 登记，需裁决是否提升到资源维度 |
| A-6 | 未验证疑点 | `status=BLOCKED` 的 call 被视为安全；`#finishKnownNoEffect({knownNoEffect:false})` 分支下"代码未证明无效果"却落 BLOCKED。对 `resource.trash` 未能构造真实反例 | 登记为疑点（**不写成已确认漏洞**） |
| S1 / S2 / S3 | 未验证疑点 | ① 真实双主进程 / 孤儿 executor 时序；② 跨用户 approval 后 approver 撤权；③ `transactSync` 无连接内互斥与异步 `transact` 交错 | 登记，缺真实复现条件 |
| R-1' | 低 | 单段绝对路径（`/x`、`/data`、`/secret-plan.txt`）按"≥1 完整目录段"设计取舍未去敏（无用户名/目录结构） | 登记；若要求字面闭合可加裸 `/[\w.-]+` 分支 |
| R-4' | 低（可读性） | 过度遮蔽取舍：`token:` / `Bearer ` / `api_key =` 形式的普通文本、含系统根名段的相对路径或 URL（`src/tmp/gen.js`、`https://x.io/var/data`）会被改写；执行与 approval UI 不受影响 | 登记 |
| N-1 | 信息级 | 去敏投影长度上界实测 ≤271（TEXT 列、有界、无明文；截断分支注入标记后未再 clamp 到 256） | 登记 |
| — | 信息级 | 执行入参缓存条目按字节无上限（条数 ≤64）；该数据在修复前同样会直接进 SQLite，属既有语义 | 登记 |

## 5. 经核对未发现问题的方面（不变量 + 依据）

1. **claim-time TOCTOU 重校验有效**：审查者自建"eligibility 之后、claim 之前"注入撤权矩阵 **6/6 fail closed、0 Domain 调用**（app 禁用 / tool grant 撤销 / session 撤销 / 用户禁用 / resource grant 撤销 / useByAgent 撤销）；claim 在同一 `BEGIN IMMEDIATE` 事务内重读 task/cancel/RUNNING/actor/app/step/run/tool 版本与 effectClass/`#authorizeLive`/preconditions/approval 全字段/active lease（leaseId+holderId+runtimeInstance+有效期）。
2. **approval 精确绑定**：planHash/argsHash/toolId/version/effectClass 逐项比对；篡改 `approvedToolId` → PLAN_STALE 拒绝。
3. **结构上不可能第二次 claim**：枚举全部 `updateCall` 调用点；进 LEASED 只有 `acquireLease`、进 RUNNING 只有 claim；`releaseLease` 在 `electron/` 内无调用方。
4. **并发/重复投递**：同 callId + 同 toolId + 同 canonical args 指纹 → 同 pending/同 outcome（0 额外执行、0 额外预算）；callId 冲突 → `409 TOOL_CALL_ID_CONFLICT`；maxCalls=1 并发 unique call 恰好一个成功。
5. **idempotency**：`UNIQUE(idempotency_key)` + 同绑定校验（toolId/version/argsHash/preconditions 不一致 → IDEMPOTENCY_CONFLICT）。
6. **UNKNOWN_EFFECT / quiescence fail closed**：三态只读 recovery verification；只有 APPLIED 或 (NOT_APPLIED + quiesced) 落终态；`quiesced=true` 只能来自同一存活 supervisor 真实 `child.on("exit")`；persisted EXITED / ENOENT / 任意 errno / 超时都不是死亡证明；AUTO_RETRY 恒 0。
7. **resume/append 不绕过工具边界**：构造最危险状态（BLOCKED + artifact + 未解决 DENIED WRITE + lastRun=预算停止）→ 后端判 resumable=true，但续接的新 run 仍被 task 级 denied-write 门拦成 `TOOL_FORBIDDEN`、0 执行；BLOCKED 时 append 返回 `APPEND_NOT_SUCCEEDED`。
8. **final text 掩盖被两道后端门拦住**：A33 验证失败门 + 明确 WRITE 被拒门都在唯一提交点 `commitStepSuccess` 之前；`commitStepSuccess/completeTask` 只被 orchestrator 调用。
9. **Bridge 输入信任边界正确**：body 自报 scope/sessionRef/appId/taskId/stepId/runId/proposalId/riskClass/approved/approvalId/leaseId/effectClass/idempotencyKey 全部被忽略；WRITE route 不把 Harness callId 当 authority id。
10. **capability 不落库/事件/artifact**：本轮修复后连"工具参数"通道也已去敏，全库 63 张表 + 事件 + artifact + DSH_HOME 文件扫描 0 命中。
11. **失败 Verification 关联（D4-05 Closure-2 声称已修）独立复核通过**：键为 `(tool_id, arguments_hash)`、hash 缺失回退 execution 唯一键、顺序 `started_at,rowid`。
12. **预算门控在 run 创建之前**：任一使用到的 kind `remaining==0` → 不建 run、不消耗、直接 `BUDGET_EXHAUSTED`；无"无额度仍执行"通路。

## 6. 无法验证的事项（如实列出）

1. 真实双主进程 / 孤儿 executor 时序（需真实 Electron 双开或 kill -9 保留 child）；
2. 跨用户 approval 后 approver 被禁用/降级的端到端（缺用例）；
3. 跨平台：Windows 命名管道/路径形态、Linux 路径形态（本机 macOS，且拒绝判据刻意保持窄口径）；
4. 真实 Electron 主进程装配的端到端装配顺序（本轮审查只读、未启动 Electron；改为审查者自读 `task-bootstrap.cjs` 确认装配顺序，并用夹具复刻同一序列）；
5. 真实 `kill -9` quiescence 与多 session 并发 approve 未做新复现（复用既有 C3 套件结论）；
6. UI 层套件（`test:d4-03c4-ui` 等）由协调者在被测 commit 复跑（见 §8），审查者侧未跑（只读约束）。

## 7. D4-03 封板判定：满足什么 / 缺什么

**已满足**：
- 未参与实现的独立审查已完成（两名审查者，四轮：发现 → 复核 → 残留修复 → 确认），审查输入完整（真实命令、真实输出、复现探针、残留清单与级别）；
- 确认缺陷已最小修复并由同一独立审查者复核 **CLOSED**（REV-01 / F-1 / R-1 / R-2 / R-3 / R-5'）；
- 被测 commit `f63e87a` 干净树上，D4-03 十六门禁 + 受影响回归 + 真实 main Gate + `npm test` 全绿（§8）；
- 未扩大权限、未改工具门语义、未改执行入参语义（有 HEAD 对照证据）。

**未满足（因此本轮不封板）**：
1. **缺"由实现方之外的审查者作出的封板裁决"** —— 原始条件指名 ChatGPT，本轮审查者与实现方同源，只能给内部独立审查意见；
2. **缺 F-2 的产品裁决**（修实现冻结 model config，或改 ADR/D4-02 口径为"不冻结"）——非安全阻塞，但属契约措辞反例；
3. **缺对低危残留的处置决定**（A-4 / R-1' / R-4' / N-1 / 缓存条目上限）：随封板一并登记，或授权下一轮硬化。

**封板审查者需要的输入包（已备齐）**：本文件（含全部 findings/复现/修复/复核/残留）+ 四轮审查报告（要点已并入本文件）+ 探针清单（`/tmp/probe-p1*,p2,p3,p4,p5,p6,n1,n2,n9,r5prime,e-finalstate` 等）+ 被测 commit `f63e87a` + §8 的全部命令与数字 + `docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`。

## 8. 实际检查（被测 commit `f63e87a`，干净树）

| 检查 | 结果 |
| --- | --- |
| D4-03 十六门禁（`test:d4-03a/b/c1/c1-closure/c2/c2-closure/c2-closure2/c2-closure3/c3/c3-closure/c4/c4-closure/c4-closure2/c4-closure3/d/d-closure`） | 全部 **exit 0**：32/32、59/59、48/48、52/52、29/29、38/38、45/45、51/51、56/56、63/63、**35/35 + Approval UI 22/22**、15/15、12/12、9/9、52/52、62/62 |
| 本轮新增审计回归 | `tests/d4-03-run-entry-guard.test.mjs` **7/7**、`tests/tool-argument-projection-redaction.test.mjs` **15/15** |
| 受影响回归 | `test:d4-04` **94/94**；`test:d4-05` **173/173（S1–S4 全 PASS，overallStatus=PASS）**；`test:d4-06` **119/119**；`test:d4-06-resume` **21/21**；`test:d4-08` **13/13**；`test:d4-08-verification-ui` **22/22** |
| 真实 main E2E | `node tests/d4-main-e2e.mjs` → **120/120、五条必需流程全 PASS、overallStatus=PASS、exit 0、workspaceState=""**；`artifactSha256=37133dfab90b408e13b51f41ebddd02e622aec5313c9b920e92a382c415d718c` |
| 全量测试 | `npm test` **1033/1033**；`npm run build` exit 0 |
| 探针复跑 | p1/p1b/p2/p3 泄漏扫描 0 命中；n1/n9 残留 0；n2 执行语义逐字符一致 + 回退 fail closed；`probe-e-finalstate` 第三入口被拒且 0 状态变化 |

## 9. D4 的 macOS 已验证范围与整体状态

| 子项 | 状态 | 依据（本轮或既有） |
| --- | --- | --- |
| D4-01 模型服务（macOS Core） | PASS | `test:d4-01` 59/59 等既有证据 |
| D4-02 任务与适配（macOS Core） | PASS（限定范围） | `test:d4-02a/b/c` 22/22+16/16+22/22；**产品入口未冻结 model config（F-2）待裁决** |
| **D4-03 工具门与租约** | **PASS candidate（内部独立预审通过；本轮不封板）** | 十六门禁全绿 + 独立审查四轮 + 6 项缺陷闭合；封板待实现方之外的审查者（§7） |
| D4-04 纵向冒烟 | PASS（限定范围） | 94/94；真实 main 产品入口流程 1/2/3/5 复验 |
| D4-05 执行关卡 | PASS（S1–S4；S4 限定"消息结构 + 授权/执行边界"） | 173/173 |
| D4-06 关联链与预算停止 | PASS | 119/119 + resume 21/21 + 失败验证 UI 22/22 |
| **真实 `electron/main.cjs` 产品入口** | **PASS（五条必需流程）** | 120/120、exit 0（本被测 commit 复跑） |
| **D4 整体** | **PARTIAL（不自动升级）** | 剩余：**Windows / External Provider = NOT VERIFIED**；**D4-03 待实现方之外的审查者封板**；**F-2 待产品裁决**；D4-05 S4 范围限定；OS 级网络沙箱 / 跨重启 durable death proof 等既有挂账不变 |

Windows 与 External Provider 的限制**单独保留**，不因本轮任何结论被改写。

## 10. 唯一推荐的下一阶段任务及前置条件（不开始实施）

**推荐：D5-01 浏览器**（`PLAN.md:501`：`D5-01 浏览器 \| 前端 \| D2、D3-05、D1-01 \| 真实浏览器 \| 导航下载会话隔离及遮挡正确`）。

前置条件（按当前口径）：
1. **D2**：D2-01 设计系统 = PARTIAL（边界已声明：对话框焦点陷阱 NOT VERIFIED、桌面端组件契约 PARTIAL）；D2-02 窗口系统 ADR 已存在（`docs/decisions/D2-02-window-system.md`，CONDITIONAL GO 仅 macOS）；
2. **D3-05** = macOS PASS（D3 overall macOS PASS；cross-platform PARTIAL）；
3. **D1-01** = macOS 桌面核心 PASS（Windows 6 项 NOT VERIFIED 保留）；
4. 与 D4 的关系：PLAN 依赖表**未把 D4 列入 D5-01 前置**；D5-02/03/06/08 才以 D4-05（已 PASS）为前置，"未通过 D4-05 禁止扩展真实工具面"的禁令已满足；
5. 但建议在进入 D5 前完成两项并行治理项：**D4-03 封板裁决**（§7）与 **F-2 裁决**，避免口径漂移；本轮**不开始实施** D5-01。

## 11. 修改文件（本轮）

- **代码/测试提交 `f63e87a`**：`electron/tool-domain.cjs`（持久化去敏判据 + 递归投影去敏 + 标记/残留收口）、`electron/controlled-tool-proxy.cjs`（执行入参/落库投影解耦 + 内存有界缓存 + 回退 fail closed）、`electron/tool-facade-bridge.cjs`（拒绝判据单一来源，语义不变）、`electron/task-service.cjs`（`#sideEffectSafety` 单一来源 + `getSideEffectSafety` + 证据投影复用同一判据 + depth≥2 兜底）、`electron/task-harness-orchestrator.cjs`（`runTask` 前置守卫）、`tests/d4-03-run-entry-guard.test.mjs`（新，7 用例）、`tests/tool-argument-projection-redaction.test.mjs`（新，15 用例）。
- **报告/证据提交**：本文件、`docs/D4-ACCEPTANCE-RESULT.md`、`PROGRESS.md`、`docs/D4-04/05/06-GATE-EVIDENCE.json`（更新到被测 commit）、`docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`（同 commit 复跑）。
- 审查者未修改仓库任何文件；探针只写 `/tmp`。
