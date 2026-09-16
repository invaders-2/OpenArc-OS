# D4-03D · 结果记录（Full Tool Proxy Gate）

Base HEAD：`eb1d16d6011e880ae4e267a1c53f33ed6a300e07`
入口：`npm run test:d4-03d`
Artifact：`artifacts/d4-03d/full-tool-proxy-gate.json`

## Task Status

`D4-03D = PASS candidate`；`D4-03 overall = PASS candidate`；`D4-04 = NOT STARTED`。
D4-03D 不新增生产工具、不改 side-effect architecture，只把已 PASS 的 D4-03A/B/C 收敛成一个统一、不可绕过的 Tool Proxy 并加 Gate。

## Tool Surface（§4 · 冻结）

Harness-visible 精确为 `resource.search` / `resource.read.metadata` / `resource.trash`；
forbidden tool count = 0（无 shell / terminal / filesystem / run_code / process / web / MCP / browser /
Device Agent / Canvas / App Center / Adobe）。WRITE surface 仍只有 `resource.trash`。

## Full Route Matrix（§6 · 永久冻结）

| Route | Contract |
|---|---|
| `READ_ONLY` | Proposal → Decision → Reauthorization → Controlled Execution → Verification |
| `SIDE_EFFECT_PROPOSAL` | Proposal → Decision → SideEffectPlan → Approval → Lease → Controlled Execution → Verification |
| unknown / unsupported | BLOCK |
| irreversible / external / privileged | BLOCK |

无第三条隐藏 execution route。READ 绝不创建 SideEffectCall / Approval / Lease；WRITE 绝不经过 `executeReadOnly`。

## Official dsh Manifest（§9）

真实 `@deepseek-ai/dsh@0.1.5-rc.2` + `@agentclientprotocol/sdk@1.4.0`（ACP v1）。
advertised tools 精确等于 allowlist（`resource_search / resource_read_metadata / resource_trash`）；
forbidden = 0；空 manifest → 0 tool（不伪造）。官方 profile bundle 真实注册且 plugin 不 import 任何业务模块。

## Single Tool Facade（§11）

混合 E2E 中一个 run 只创建 1 个 `ToolFacadeBridge`（bridgeFactory 计数断言），
一个 Registry projection、一个 `tpx_` capability；route 由 Registry riskClass 决定。
run 完成后 bridge `server=null` / `capabilities.size=0`。

## READ Route（§7）

READ 只经 `ControlledToolProxy.propose → executeReadOnly → verify`；结果来自 allowlisted adapter，
Harness arguments 不能伪造 `result` / `verificationStatus`（schema 拒绝）。
READ 不创建 SideEffectCall / Approval / Lease。

## WRITE Route（§8）

WRITE 只走 `SideEffectRuntime.proposeWrite`（`SIDE_EFFECT_APPROVAL_REQUIRED`）；
ledger：proposal 阶段 0 mutation / 0 lease / 0 execution；approve 后受监督 executor exactly-once + read-only verification。
`resourceService.delete` 真实调用点只允许 allowlisted side-effect adapter（+ Resource UI command handler）。

## Mixed READ + WRITE E2E（§10 · official dsh）

一条真实 Task：`resource_search` → `resource_read_metadata` → `resource_trash`（WAITING_APPROVAL）
→ trusted user approve → 受监督 exactly-once → read-only verification PASS → Task/Step **SUCCEEDED**。
1 Task / 1 Step / 1 Harness Run / 1 Facade；READ 受控执行；WRITE mutation exactly 1；SideEffectCall exactly 1；AUTO_RETRY=0。

## tpx Scope（§12）

capability 绑定 `session / app / taskId / stepId / runId / allowedTools / maxCalls / expiry`；
body 自报 `taskId / stepId / runId / appId / sessionRef / userId / role` 一律忽略（proposal 仍归属绑定 task/step/run）；
app mismatch → `TOOL_CAPABILITY_SCOPE_INVALID`。

## tpx vs mpx（§13）

`tpx_` 打 Model Proxy → 401；`mpx_` 打 Tool Facade → 401；cross-domain 0 privilege gain。

## Capability Lifecycle（§15）

ACTIVE → TTL EXPIRED（401）/ maxCalls EXHAUSTED（429）/ revoke REVOKED（401）；
run 完成 / cancel / bridge stop 后 `capabilities.size = 0`，旧 token 不可用；绝不重建 capability。

## Cross-run Replay（§16）

同 task 新 run 成为 latest 后，旧 run capability 的 proposal → stale DENY + 0 Domain execution。

## Cross-task Replay（§17）

capability 绑定 task，body 自报 `taskId` 不改变归属；wrong-bridge / 跨域 token → 401。

## Cross-step Replay（§18）

capability 绑定 step，body 自报 `stepId` 被忽略；proposal 的 `step_id` 恒为绑定 step。

## Session / Permission Revocation（§20 / §21）

READ 成功后：session logout / tool permission revoke / 非 owner 用户 resource permission revoke
→ 下一次 call DENY + 0 new Domain execution；旧 capability 不能绕过 D3 authority。

## Registry / Version Stale（§22 / §23）

Tool Facade 启动后 Registry contract 改变 → 下一次 READ / WRITE 都返回 `TOOL_CONTRACT_STALE`
（409），0 execution / 0 SideEffectCall；绝不 silent fallback 到 latest version。

## Duplicate Delivery（§24）

同 `callId` 重复送达：READ → 1 次 Domain execution、结果一致；WRITE → 1 个 SideEffectCall、
同一 `approvalRequestId`；duplicate **不消耗 maxCalls**（capability.calls 不递增）。

## Concurrent Duplicate（§25）

并发同 `callId`：READ in-flight promise 收敛为 1 execution；WRITE proposeWrite binding 收敛为 1 SideEffectCall。

## Malformed Tool Body（§27）

invalid JSON（400）/ oversized（413 或连接终止）/ missing toolId（403）/ bad toolId（403）/
not allowlisted（403）/ wrong type / schema violation / forbidden field → 全部 DENY + 0 Domain execution。
independent malformed ACP injection 仍是单独 Remaining Gap，未因此标 PASS。

## Authority Spoof（§28）

arguments 注入 userId / sessionRef / appId / role / risk / effectClass / requiresApproval / approved /
approvalId / leaseId / idempotencyKey / verificationStatus / quiesced / runtimeDead / retry / providerKey /
credentialRef → schema reject（0 ALLOWED decision / 0 execution）；top-level scope spoof 被忽略。

## Domain Bypass Audit（§29 / §30）

Harness-facing（harness-adapter / tool-facade-bridge / model-proxy / dsh-tool-profile）与 ACP plugin
剥离注释后不引用 ResourceService / SearchService / resource-service / search-service /
side-effect-authority / side-effect-runtime / node:sqlite；`resourceService.delete` 调用点白名单
= {tool-adapters.cjs, resource-bootstrap.cjs}；`ControlledToolProxy` 只有 `executeReadOnly`，无通用 `execute()`。

## Safe Result Projection（§31）

READ result 与 Approval snapshot 不含绝对路径 / store root / `tpx_` / `mpx_` / lease internals。

## Mixed UNKNOWN_EFFECT（§35）

READ 成功 + WRITE UNKNOWN_EFFECT → Task/Step **BLOCKED**，Harness STOP，0 second write call；
READ 成功不能让 Task SUCCEEDED。

## Mixed Cancellation（§36）

READ success → WRITE WAITING_APPROVAL → Task cancel → 0 write / 0 lease / capability revoked / bridge 关闭。

## Bridge Disconnect（§38）

READ 在途 client 断开 → abort，execution BLOCKED，绝不返回 stale / verified PASS；
WRITE proposal 持久化后 client 断开 → 保持 AWAITING_APPROVAL，0 auto approve / 0 lease / 0 mutation。

## Bridge Shutdown（§39）

bridge stop → server 关闭、capabilities 清空；旧 token / 旧端口不可用；绝不重建 capability。

## Loopback Boundary（§40）

Tool Facade 只 `127.0.0.1`（baseUrl 断言）。这是应用层防线，**不是** OS-level network sandbox，
该 Gap 继续 `NOT VERIFIED`。

## Audit Ordering（§45）

WRITE 事件链断言 `tool.side_effect.planned → tool.approval_required → tool.side_effect.waiting_approval
→ tool.approved → tool.lease_acquired → tool.side_effect.execution_started →
tool.side_effect.verification_passed → tool.side_effect.succeeded → task.succeeded`；
approval 在 WAITING 之后、lease 在 approval 之后、verification 在 execution 之后、Task 成功在 WRITE verified 之后。

## AUTO_RETRY

所有路径 `AUTO_RETRY = 0`：0 hidden retry / 0 second SideEffectCall / 0 lease reacquire / 0 Domain replay。

## Secret Scan（§14 / §55）

全 SQLite 表 + TaskEvent + artifacts 扫描：`tpx_ = 0`、`mpx_ = 0`、provider secret = 0、
绝对路径 = 0、store root = 0、credential 形态字段 = 0。capability 只活进程内存。

## 生产改动

唯一生产改动：`DEFAULT_MAX_CALLS` 4 → 8（一个 Harness run 内的 bounded 模型调用预算）。
混合 READ + WRITE 的 turn 需要 tool calls + 1 次 final + 1 次 verified-continuation；仍是 bounded budget，
`AUTO_RETRY = 0`，不引入 hidden retry，不扩大 WRITE surface。

## D4-03D Gate

`npm run test:d4-03d` = **52 / 52 PASS**
（`tool-d4-03d-e2e` 5 + `tool-d4-03d-authority` 12 + `tool-d4-03d-audit` 4 + official dsh facade/e2e/security/cancel/lifecycle + C4 dsh write）。
artifact `full-tool-proxy-gate.json`：`mixedE2E.taskStatus = SUCCEEDED`、`dshVersion = 0.1.5-rc.2`、`acpVersion = 1.4.0`、
contract 全部 true、`schemaBumped = false`。

## D4-03C regressions

`test:d4-03c4` = 35/35 + UI 22/22 + build PASS；closure = 15/15；closure2 = 12/12；closure3 = 9/9；
`test:d4-03c3` = 56/56；closure = 63/63；`test:d4-03c2` = 29/38/45/51；`test:d4-03c1` = 48/52。

## D4-03B / A regressions

`test:d4-03b` = 59/59；`test:d4-03a` = 32/32。

## D4-02 regressions

`test:d4-02a` = 22/22；`test:d4-02b` = 16/16；`test:d4-02c` = 22/22。

## D4-01 regression

`test:d4-01` = 59/59。

## npm test

**892 / 892 PASS**（0 failed；含 3 个新 D4-03D 文件共 21 条）。

## build

`npm run build` = PASS。

## security

`npm run test:security` = FAIL 0 / PARTIAL 2 / PASS 6。

## Files Changed

`git diff --name-only eb1d16d6011e880ae4e267a1c53f33ed6a300e07...HEAD`：

    PROGRESS.md
    docs/D4-03D-RESULT.md
    docs/decisions/D4-03C-side-effect-authority.md
    electron/task-harness-orchestrator.cjs
    experiments/d4-03d/run-all.mjs
    package.json
    tests/tool-d4-03d-audit.test.mjs
    tests/tool-d4-03d-authority.test.mjs
    tests/tool-d4-03d-e2e.test.mjs

## Remaining Gaps

`OS-level network sandbox = NOT VERIFIED`；`external workspace read audit = NOT VERIFIED`；
`independent malformed ACP injection = NOT VERIFIED`；`Windows = NOT VERIFIED`；
`External Provider = NOT VERIFIED`；`Explicit Resume = DEFERRED`；
`broader Domain verifiers = NOT VERIFIED`；`authenticated durable cross-restart process-death proof = DEFERRED / NOT VERIFIED`。
D4-03D **不自动关闭**任何一项。
