# D4 · 真实产品入口 `electron/main.cjs` 端到端验证（Main-Entry E2E · Closure-6）

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`；分支：`feature/d4-03-tool-proxy`
- **本轮任务 Base HEAD**（开工核对，干净）：`afb3eae7f06ccc6f2b2213974485f7dbe75bd470`
- **本轮代码/测试提交**：`5577e82fdfc6c20b728600584d81c1e8192b911d`（追加步骤产品入口 + 服务层测试 + 真实 main E2E 重写）、`3c9659a5bb05c351c7b215e69cd69ff44c3d4597`（真实回归修复：追加入口可见文本不再回显机器码）
- **真实 main E2E 被测 commit**：`3c9659a5bb05c351c7b215e69cd69ff44c3d4597`（`workspaceState=""`，干净树）
- **报告与证据提交**：本文件 + `docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json` + `docs/D4-ACCEPTANCE-RESULT.md` + `docs/D4-04/05/06-GATE-EVIDENCE.json` + `PROGRESS.md`
- **结论：真实 main 入口缺口已关闭**：**5/5 必需流程经真实产品入口 PASS**，`overallStatus=PASS`、**退出码 0**、`notVerified=[]`、renderer/main 错误 0（`120/120` checks）。`D4` 整体仍按剩余既有项判断，**不自动升级**（见 §9）。

## 1. 本轮补齐的产品入口：同一任务追加下一步目标

| # | 变更 | commit | 说明 |
| --- | --- | --- | --- |
| 1 | **AppendStep 服务合同** | `5577e82` | `TaskService.appendStep` / `getAppendEligibility`（同一份私有 `#appendAssessment`）；判定与写入同一 `transactSync`，只新增 1 个 reasoning step，绝不改旧 step/artifact/verification/副作用/lease，绝不重放旧 tool 请求，绝不写 `task_budgets`。拒绝原因显式：`APPEND_NOT_SUCCEEDED / _NO_ARTIFACT / _IN_FLIGHT / _SIDE_EFFECT_PENDING / _UNKNOWN_EFFECT / _ACTIVE_LEASE / _EFFECT_STATE_UNAVAILABLE`。 |
| 2 | **明确允许的状态转换** | `5577e82` | `TASK_TRANSITIONS` 只放开唯一一条离开终态的边 `SUCCEEDED→RUNNING`（注释标明仅 AppendStep 使用）；`startTask` 对 SUCCEEDED 显式拒绝（`APPEND_REQUIRED`）；其余边（SUCCEEDED→CANCELLED/WAITING/BLOCKED、FAILED→*、CANCELLED→*）仍 DENY。task 行只改 `status/updated_at/revision`，保留 `started_at/completed_at`。 |
| 3 | **无额度追加 → 显式续接** | `5577e82` | `#resumeAssessment` 新增 `stepBudgetStop`：run 未创建（`remaining==0` 不启动空转 run）而 step 因预算 BLOCKED 时，同样给出续接入口；其余守卫不变。 |
| 4 | **编排 + IPC** | `5577e82` | `orchestrator.appendStepCommand`（**拒绝同步返回、运行异步**；startStep 失败防御性 blockStep）+ `async appendStep`；`task/appendStep` 加入白名单；`task/get` 新增 `appendable`/`appendReason`（仅 safe 投影）。 |
| 5 | **真实 UI 入口 + 步骤历史** | `5577e82` `3c9659a` | AI 面板新增 `[data-ai-append-block]` / `[data-ai-append-goal]` / `[data-ai-append]`（仅在 `task/get.appendable=true` 时出现）与 `[data-ai-steps]` / `[data-ai-step=<sequence>]` / `data-ai-step-status` / `data-ai-step-appended`；不可追加时显示 `[data-ai-append-blocked]` + `[data-ai-append-reason]`（人话文案，原始码只进 `data-ai-append-reason-code`）。 |
| 6 | **真实 main E2E 重写** | `5577e82` | `tests/d4-main-e2e.mjs`：流程 4 由"结构性不可达 + NOT_VERIFIED"改为真实产品入口全链（54 条 flow4 检查）；流程 5 扩展 5 条（步骤历史/账本/续接态）；Gate 语义改为任一必需流程 FAIL/NOT_VERIFIED 即非零退出。 |

**产品侧 test seam 仍只有一处**：`OPENARC_E2E_OBSERVE=1`（只读 boot 快照，默认关闭）。本轮**未**新增任何播种 / 预造多步 / 直写数据库 seam。

## 2. 真实启动入口与隔离配置

- **入口**：仓库根 `electron/main.cjs`（package.json `main`），正常产品方式 `electron .` + 真实 preload + `dist/index.html` + 真实 IPC / runtime-boot / Model Proxy / Task Runtime / ControlledToolProxy / SideEffectRuntime。
- **命令**：`spawn(require("electron"), [".", "--user-data-dir=<mkdtemp 隔离目录>", "--remote-debugging-port=9788"], { cwd: <worktree>, env })` + `chromium.connectOverCDP` 驱动真实 Renderer。不用 probe host、不用复制的 main、不用 `_electron.launch`。
- **隔离/测试配置 vs 正常启动**：`--user-data-dir` 隔离；`OPENARC_IDENTITY_ADMIN=1`（首启 ADMIN，产品本身需要）；`OPENARC_E2E_OBSERVE=1`（唯一只读 boot 观测 seam）；本地确定性 provider（loopback）；显式删除 `OPENARC_E2E_SEED_TOOL_GRANTS`。主进程内部状态只经**只读** `node:sqlite` + executor 计数取得；不写库、不设终态、不替换 orchestrator。

## 3. boot 顺序（真实 main）

```json
{"identityCreated":true,"modelProxyStartAttempted":true,"modelProxyStarted":true,
 "modelProxyListening":true,"modelProxyErrorCode":null,
 "bootOrder":["identity_created","model_proxy_start_attempted","model_proxy_started","runtime_ready"]}
```
断言：严格有序、`modelProxyListening=true`、boot 观测早于首个 task。

## 4. 五条必需流程（expected / actual）

| 流程 | 结果 | actual 摘要 |
| --- | --- | --- |
| **1 管理员授权 → WRITE 审批 → 一次副作用 → 成功** | **PASS** | 真实治理 UI 授予 `tool.resource.search/readMetadata/trash`；真实 AI 任务 search→trash → 真实 Approve → Task/Step `SUCCEEDED`；SideEffectCall=1 `SUCCEEDED`、approval=1、lease=1、Artifact=1 + Verification=1、mutation=1、production executor 真实 spawn |
| **2 非管理员被拒；待批准时撤权 → 旧批准不能执行** | **PASS** | 真实 MEMBER `grantAppToolAccess` → `NOT_SUPER_ADMIN`；`revokeAppToolAccess changed=true`、`grantedActions=[]`、DB TOOL rows=0；旧批准 → Call `BLOCKED`/`SIDE_EFFECT_AUTHORIZATION_REVOKED`；0 mutation / 0 lease / 0 新 executor；Task/Step BLOCKED |
| **3 无工具权限的明确 WRITE → 无副作用，不显示完成** | **PASS** | 只授 search/readMetadata（不授 trash）→ 真实 AI WRITE + finalText"完成" → Task/Step `BLOCKED`（不再假成功）；0 mutation、0 SideEffectCall；`task/get.deniedOperations` 含 `resource.trash/TOOL_APP_NOT_GRANTED`；`data-ai-denied` 可见 |
| **4 正常任务 → 真实成果 → 追加第二步 → 真实预算停止 → UI 显式续接 → 后续完成** | **PASS** | 见 §5/§6：真实 UI 首次成功出产物 → `[data-ai-append-goal]`+`[data-ai-append]` 追加第二步（同步接收、同一 taskId）→ 第二步真实耗尽 `MODEL_CALLS`、Task/Step BLOCKED、第一步产物与副作用不变 → UI 显示停止原因与明确追加额度 → 点击 `[data-ai-resume]` → 3 steps `SUCCEEDED/BLOCKED/SUCCEEDED`、Task SUCCEEDED、2 Artifact + 2 Verification |
| **5 刷新后权限/任务/预算/产物/步骤历史一致** | **PASS** | Reload 后 gate=ready；TOOL 权限与后端一致；flow1/flow3 权威状态一致；主任务面板恢复 3 条步骤历史（含追加目标与 `data-ai-step-appended`）、`[data-ai-append-block]` 可见、`[data-ai-resume]` 不可见；`task/get` 账本 authorized/consumed/remaining/additions/resumeCount 与刷新前逐项相等 |

## 5. 流程 4 主任务：跨步骤 / 跨 run 的预算与调用次数（真实产品入口）

主任务 `task_GBxZiBkMtyJuog`（第一步 plan write、第二步 plan budget、续接 run plan final）：

| 阶段 | MODEL_CALLS authorized/consumed/remaining | TOOL_CALLS | TOOL_ROUNDS |
| --- | --- | --- | --- |
| 追加前（step1 成功） | 8 / 4 / 4 | 8 / 2 / 6 | 4 / 1 / 3 |
| 第二步预算停止 | **8 / 8 / 0** | 8 / 6 / 2 | 4 / 1 / 3 |
| 续接后最终 | **16 / 9 / 7** | 8 / 6 / 2 | 4 / 1 / 3 |

- **追加不增加预算**：`[data-ai-append]` 接受前后三类 `authorized` 逐项相等（F4.34）。
- **只有被批准 kind 抬升**：additions 恰好 1 条 `{kind:MODEL_CALLS, amount:8, consumedAtGrant:有}`，`resumeCount=1`；只有 `MODEL_CALLS` authorized 8→16，其余两类不变（F4.45/F4.46）。
- **实际调用次数 == 账本**：该任务三次 run 的真实 provider 模型请求 **9**（write 4 + budget 4 + final 1）== `MODEL_CALLS.consumed` **9**（`modelCallEnvelopes` 只有 3，信封 ≠ 逐请求）；`TOOL_CALLS.consumed` **6** == DB `tool_executions` 5 + `side_effect_calls` 1 == provider 观测发出的 tool_call **6**（F4.48/F4.49）。
- **关联链**：2 Artifact（`art_ljideIddmLA4Og`@`step_sUL1oybs8DvAwA`/`hrun_B1cuKx_6HV-fbw`、`art_7QgXKMJUulpZyg`@`step_QUH7SYJIHKZ-lw`/`hrun_aDSSBr_muUYWDA`）+ 2 Verification（按 artifactId 绑定；verification 行不承载 step/run）+ harness runs=3；两条 artifact `checksum == sha256(safe_content)`，均为 `c0b3fbff51ccc40b8bf1a81666e7ecced016187cbe2ac6f1d627e0d7a287e04d`（确定性 provider 两次收尾文本相同 → 内容相同；step/run 身份各自独立）（F4.50）。
- **第一步副作用恰好一次**：`side_effect_calls==1`（SUCCEEDED）、0 条 `resource.trash` execution、资源 `updated_at` 在停止/续接前后不变（只 trash 一次）、executor 记录数不变（F4.51）。
- **无额度不空转**：服务层测试证明某"会用到"的 kind `remaining==0` 时**不创建 run**、step 直接 BLOCKED/BUDGET_EXHAUSTED，且因存在真实产物仍给出续接入口（`tests/d4-09-append-step.test.mjs` J，11/11）。

## 6. 追加步骤拒绝矩阵（含正对照，全部真实产品入口）

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 同一 revision **真并发**两次（Promise.all 产品桥） | 恰好 1 次接受、step 只 +1；拒绝方同步 `TASK_REVISION_CONFLICT`（无 running 异步面） | F4.4 / F4.5 |
| 追加被接受后再用同一 revision / 过期页面 revision | 同步 `TASK_REVISION_CONFLICT`，step 数不增 | F4.6 / F4.35 / F4.39 |
| 目标任务非 SUCCEEDED（flow3 BLOCKED） | `APPEND_NOT_ALLOWED` + `APPEND_NOT_SUCCEEDED`，0 新 step、状态/revision 不变 | F4.8 / F4.9 |
| 目标任务处于 AWAITING_APPROVAL（在途） | `APPEND_NOT_ALLOWED` + `APPEND_IN_FLIGHT`，0 新 step | F4.15 |
| 真实 MEMBER 会话对 admin 任务 | `TASK_FORBIDDEN`，steps 3→3 不变 | F4.53 |
| **执行前撤权**：追加 WRITE 第二步 → AWAITING_APPROVAL → 撤 ai TOOL grant → 点真实 Approve | Call `BLOCKED`/`SIDE_EFFECT_AUTHORIZATION_REVOKED`、0 mutation、0 新 lease、0 新 executor；第一步 Artifact/Verification 保留、该任务仍只有 1 条 SUCCEEDED 副作用 | F4.17–F4.21 |
| 正对照（可追加时确实可追加） | 7 条 | F4.3 / F4.5 / F4.10 / F4.12 / F4.16 / F4.23（真实治理 UI 重授予）/ F4.52 |

## 7. 门禁、回归与错误

- **`overallStatus = PASS`；实际退出码 = 0**；checks `120/120`（0 hard fail、0 notVerified）；`requiredFlows` 全部 `PASS`；`rendererConsoleErrors=0`、`mainUnhandledErrors=0`。
- 证据：`docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`（`testedCommit=3c9659a`、`workspaceState=""`、`requiredFlows`、`overallStatus=PASS`、`productEntries`（含 appendStepEntry/resumeEntry/stepsProjection）、`flows.flow4`（预算 before/stop/final、调用次数、artifact checksums/refs、拒绝矩阵）、逐条 checks；**`artifactSha256=0461ad44d37af0ca05a0381cbe8a5515b650c138ba5e10e92e3da5a8eb0f7bcd`**（文件本身 sha256 `faf5192…`）；已脱敏，无 secret/私有路径）。
- **同一个被测 commit `3c9659a` 的干净树回归（全部 exit 0）**：新增服务层 `tests/d4-09-append-step.test.mjs` **11/11**；`test:d4-04` **94/94**；`test:d4-05` **173/173**（S1–S4 全 PASS，overallStatus PASS）；`test:d4-06` **119/119**；`test:d4-06-resume` **21/21**；`test:d4-08` **13/13**；`test:d4-08-verification-ui` **22/22**；权限回归 `governance-tool-grant + governance-security + governance-restart` **17/17**；`npm test` **1011/1011**；`npm run build` exit 0。
- **本轮发现的真实回归（已修，`3c9659a`）**：追加入口把后端机器码 `APPEND_NOT_SUCCEEDED` 直接渲染成可见文本，命中 D4-08 UI 闸门"验证失败时页面绝不显示 Succeeded/SUCCEEDED/成功" → `test:d4-08-verification-ui` 由 21/22 修复为 **22/22**；修法是最小的人话投影（原始码只进 `data-ai-append-reason-code`），未放宽任何闸门。

## 8. 服务层通过 vs 产品入口通过（明确区分）

- **服务层（本轮新增/通过）**：`appendStep`/`getAppendEligibility`/`appendStepCommand` 合同、拒绝矩阵（含真实 crash 遗留 `UNKNOWN_EFFECT`、遗留 active lease、待批准、非 owner、并发/过期 revision）、无额度追加→显式续接、新 step 只承载本任务自身产物作低信任参考数据 —— `tests/d4-09-append-step.test.mjs` **11/11**；既有 `test:d4-04/05/06/08` 全绿。
- **产品入口通过（本轮）**：真实 main 下经真实 UI 完成"任务→产物→追加第二步→预算停止→UI 显式续接→完成"，以及 §6 的拒绝/撤权与 §7 的刷新一致性。
- **产品入口不可达但服务层已覆盖（如实）**：`APPEND_NO_ARTIFACT`（成功态产品路径必然有产物）、`APPEND_UNKNOWN_EFFECT` / `APPEND_ACTIVE_LEASE` / `APPEND_EFFECT_STATE_UNAVAILABLE`（production main 无 executor fault seam，无法确定性制造；由服务层真实崩溃恢复/夹具构造）。

## 9. 剩余限制

1. **`D4 = PARTIAL` 不自动升级**：本轮只关闭"真实 main 产品入口"这一缺口。D4-01/D4-02 的 Windows / External Provider = NOT VERIFIED；D4-03 待外部审计封板；D4-05 S4 的 PASS 仍限定"消息结构 + 授权/执行边界"；OS 级网络沙箱 / 跨重启 durable death proof 等既有挂账不变。
2. **追加步骤是最小入口**：一次显式用户动作只新增一个 bounded step；**不做**自动拆解、并行步骤、复杂工作流、步骤调度队列；不与外部服务交互。
3. **追加后立即运行**：命令同步完成"判定 + 建 step"，run 立即开始；没有"仅建 step、稍后手工启动"的入口。
4. **预算停止 kind 取决于装配额度与第一步真实消耗**（当前 base `{MODEL_CALLS 8, TOOL_CALLS 8, TOOL_ROUNDS 4}` → 本次停在 `MODEL_CALLS`）；E2E 断言全部为关系式（不硬编码绝对数），若额度或 provider 计划变化，停止 kind 与数字随之变化。
5. **追加 run 的记忆/权限复用既有路径**：新 run 走与续接相同的 per-run 受控装配（发送前重新授权/重新读取，D4-05 S4 证据），本轮未在真实 main 单独重测记忆删除/撤权对"追加 step"的影响。
6. 面板其余位置仍如实显示后端机器码（错误码 / 停止原因 / 拒绝原因 / 预算 kind）；本轮只把**追加拒绝原因**改为可读投影（原始码在 `task/get.appendReason` 与 `data-ai-append-reason-code`）。
7. 未 push、未合并 main；未触碰默认或 integration 工作区。

## 10. 修改文件（本轮）

- **代码/测试提交 `5577e82`**：`electron/task-domain.cjs`（APPEND_REASON + 唯一 `SUCCEEDED→RUNNING` 边）、`electron/task-service.cjs`（`appendStep`/`getAppendEligibility`/`#appendAssessment`/`#appendedStepCount`、`startTask` 拒绝 SUCCEEDED、stepBudgetStop）、`electron/task-harness-orchestrator.cjs`（`appendStepCommand` + async `appendStep`）、`electron/task-bootstrap.cjs`（`task/appendStep` + `task/get.appendable/appendReason`）、`src/desktop/components.tsx` + `src/styles.css`（追加入口 + 步骤历史）、`tests/d4-09-append-step.test.mjs`（新，11 tests）、`tests/task-domain.test.mjs`（TD7 期望随唯一解禁边更新）、`tests/d4-main-e2e.mjs`（流程 4 重写 + 流程 5 扩展 + Gate 语义）。
- **回归修复提交 `3c9659a`**：`src/desktop/components.tsx`（appendReason 人话投影；原始码移入 `data-ai-append-reason-code`）。
- **报告/证据提交（本次）**：`docs/D4-PRODUCT-MAIN-E2E-RESULT.md`、`docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`、`docs/D4-ACCEPTANCE-RESULT.md`、`docs/D4-04-GATE-EVIDENCE.json`、`docs/D4-05-GATE-EVIDENCE.json`、`docs/D4-06-GATE-EVIDENCE.json`、`PROGRESS.md`。

## 11. 状态与预算契约（本轮冻结）

- **Task 状态**：唯一新增边 `SUCCEEDED→RUNNING`，仅 AppendStep 使用；`startTask` 对 SUCCEEDED 显式拒绝（`APPEND_REQUIRED`）；`SUCCEEDED→CANCELLED/WAITING/BLOCKED`、FAILED→*、CANCELLED→* 仍 DENY。追加只改 `status/updated_at/revision`，`started_at/completed_at` 与旧 step/artifact/verification/执行记录原样保留。
- **Step**：只新增一个 `PENDING` reasoning step（新 stepId、新 sequence、独立 `input.goal` 与低信任 `priorArtifacts`）；旧 step 终态不可变；不重放旧 tool 请求。
- **拒绝码**：非 SUCCEEDED / 已取消 → `APPEND_NOT_ALLOWED+APPEND_NOT_SUCCEEDED`（取消时 `TASK_CANCELLED`）；无产物 → `APPEND_NO_ARTIFACT`；在途 → `APPEND_IN_FLIGHT`；未决副作用 → `APPEND_SIDE_EFFECT_PENDING`；结果未知 → `APPEND_UNKNOWN_EFFECT`；活动租约 → `APPEND_ACTIVE_LEASE`；副作用账本不可用 → `APPEND_EFFECT_STATE_UNAVAILABLE`；所有者/应用不符 → `TASK_FORBIDDEN`；过期 revision → `TASK_REVISION_CONFLICT`。
- **预算**：任务级三类跨 run 累计账本（`authorized/consumed/remaining`）；**append 不写 `task_budgets`**，新 run 的 model/tool/rounds 额度 = 该类 remaining（`remaining==0` → 不创建 run、直接 `BUDGET_EXHAUSTED`）；续接只抬升**被批准 kind** 的 authorized（金额 = `#grantBase` 实际生效额度，本次 `MODEL_CALLS +8`），续接总次数上界 `MAX_BUDGET_RESUMES=3`；追加不重置 `resumeCount`，也不能绕过额度或次数限制。
- **契约一致性证据**：E2E F4.34（追加前后 authorized 全等）、F4.45/F4.46（additions/resumeCount/仅批准 kind 抬升）、F4.48/F4.49（账本 consumed == 真实调用次数）、F4.51（副作用恰好一次）、F5.9（刷新后账本逐项相等）；服务层 `d4-09` A/B/D/E/F/J。
