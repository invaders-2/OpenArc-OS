# OpenArc OS — Master Plan Sync

更新日期：2026-09-15

> 本文件是 `PLAN.md` 的最新同步层（Current Master Plan Overlay）。
> `PLAN.md` 保留完整详细实施基线；`PLAN_SYNC.md` 记录已经冻结的新架构、当前阶段、最新 WBS 与后续路线；`PROGRESS.md` 记录真实完成状态与证据。
>
> 冲突时优先级：真实代码 / runtime evidence > RESULT / PROGRESS > PLAN_SYNC > PLAN。

---

## 1. 当前接力点

```text
Repo: invaders-2/OpenArc-OS
Branch: feature/d4-03-tool-proxy
Validated base HEAD before this sync: 809e8fa57f6c282f43645f96ad2d2ab84b86106c

D1 = PARTIAL
D2 macOS Core = PASS
D3 macOS Identity & Data = PASS
D4-01 macOS Model Service / Model Proxy Core = PASS
D4-02 macOS Task / Harness Core = PASS
D4-03A Tool Contract / Registry / Authorization Gate = PASS
D4-03B Controlled Read-only Execution = PASS
D4-03 overall = PARTIAL

NEXT = D4-03C1 Side-effect Authority / Approval / Lease Contract
```

当前硬边界：

```text
READ_ONLY execution = ENABLED
production WRITE execution = 0
business mutation = 0
MCP = 0
Shell = 0
Browser automation = 0
```

---

## 2. 永久 Authority 架构

永久冻结：

```text
OpenArc = Authority
Harness = Reasoning Runtime

Harness proposes.
OpenArc decides.
OpenArc executes.
OpenArc verifies.
```

OpenArc 唯一拥有：

```text
persistent task queue
persistent task state
step authority
retry authority
permission authority
tool authority
lease authority
side-effect authority
artifact authority
verification authority
```

Harness 不拥有上述任何持久 authority，也不得拥有 hidden retry 或 production side-effect execution。

---

## 3. Model / Credential 永久规则

```text
HARNESS_RAW_PROVIDER_KEY = FORBIDDEN
```

唯一链路：

```text
Harness
↓
OpenArc Harness Model Adapter
↓
OpenArc Model Proxy
↓
Provider
```

Harness 只允许获得：Model Proxy endpoint、scoped Model Proxy capability、safe model snapshot。

禁止获得：Provider API Key、credentialRef、CredentialStore、Provider Authorization header、OpenArc Model DB。

macOS Credential 准确表述：

```text
Electron safeStorage encryption backed by OS credential facilities
```

无 plaintext fallback。

---

## 4. Task / Recovery 永久规则

```text
AUTO_RETRY = 0
UNKNOWN EFFECT → VERIFY → BLOCK
```

禁止：

```text
UNKNOWN EFFECT → RETRY
```

Restart / crash 后未知执行状态必须进入 `BLOCKED / RECOVERY_REQUIRED`，不能自动 replay。

模型或 Harness 声称 done 不等于 `Task SUCCEEDED`；成功必须由 OpenArc Artifact + Verification + authoritative Task/Step state 决定。

---

## 5. Tool 永久安全模型

所有 Tool：

```text
Harness Tool Proposal
↓
OpenArc Tool Registry
↓
Schema Validation
↓
Authorization
↓
Risk Classification
↓
Approval（如需要）
↓
Lease（side effect）
↓
Controlled Execution
↓
Verification
```

Harness 永远不能直接：shell、filesystem mutation、MCP、browser automation、Device Agent、Resource DB、业务 Domain mutation。

Tool Registry 是唯一 Tool Contract Authority。Harness 不能决定 user / app / role / permission / risk / approval / lease / callId / idempotencyKey。

---

## 6. D4-01 — Model Service / Model Proxy

状态：

```text
D4-01 macOS = PASS
cross-platform = PARTIAL
```

已完成：Provider Registry、Credential Boundary、Model Registry、Capabilities、Personal/Organization Defaults、Endpoint/SSRF、Model Proxy、Scoped Capability、Per-call Authorization、Child Credential Isolation、Streaming、Cancel、Timeout、Partial Disconnect、0 hidden retry、Redirect protection、model.command IPC、Settings→Models、User B isolation、Organization boundary、macOS secure restart、secret scan、regression。

Windows / External Provider 真机继续 `NOT VERIFIED`。

---

## 7. D4-02 — Task / Harness Core

状态：

```text
D4-02 macOS = PASS
cross-platform = PARTIAL
```

### D4-02A = PASS

Task / TaskStep / ModelCall / TaskEvent / revision / cancelRequested / persistent authority / recovery。

### D4-02B = PASS

当前 pinned runtime：

```text
@deepseek-ai/dsh@0.1.5-rc.2
@agentclientprotocol/sdk@1.4.0
ACP v1
```

Official dsh + ACP over stdio + isolated DSH_HOME + Model Proxy-only route PASS；Provider Secret hits = 0。

### D4-02C = PASS

真实闭环：

```text
Task
↓
TaskStep
↓
official DeepSeek Harness
↓
ACP
↓
OpenArc Model Proxy
↓
Provider
↓
ACP updates
↓
TaskArtifact
↓
Verification
↓
Step SUCCEEDED
↓
Task SUCCEEDED
```

Cancel / Harness crash / timeout / restart recovery / 0 respawn / 0 replay / 0 hidden retry 已验证。

---

## 8. D4-03A — Tool Contract / Registry / Authorization

状态：

```text
D4-03A = PASS
```

已建立：Tool Registry、Tool Contract、Tool Proposal、Tool Decision、Risk Classification、Approval Policy、D3 Authorization reuse、useByAgent、ResourceRef、Schema Validation、Version Validation、Stale Proposal、Duplicate Proposal、ExecutionPlan、Audit、Task Events。

当前 Registry 至少：

```text
test.echo
test.write
resource.read.metadata
resource.search
```

---

## 9. D4-03B — Controlled Read-only Execution

状态：

```text
D4-03B = PASS
```

真实执行：

```text
resource.search
resource.read.metadata
```

真实 Domain：

```text
SearchService.search
ResourceService.get
```

禁止 Tool Adapter 直接 SQL 绕过 Domain。

### official dsh READ_ONLY Tool E2E = PASS

已真实闭环：

```text
OpenArc Task
↓
official dsh
↓
real model tool_call
↓
OpenArc dsh Tool Plugin
↓
Tool Facade Bridge
↓
ControlledToolProxy
↓
SearchService.search
↓
safe tool result
↓
official dsh Tool Runtime
↓
next model turn
↓
resource_read_metadata
↓
Tool Facade Bridge
↓
ControlledToolProxy
↓
ResourceService.get
↓
safe tool result
↓
official dsh
↓
continued reasoning
↓
final answer
↓
Artifact
↓
Verification
↓
Task SUCCEEDED
```

Harness-visible OpenArc tools exactly 2：

```text
resource_search
resource_read_metadata
```

不存在：

```text
run_code
shell
terminal
filesystem
write
web
MCP
process
exit_plan_mode
```

真实基线：

```text
model requests = 3
hidden retry = 0
SearchService.search = exactly 1
ResourceService.get = exactly 1
proposals = 2
decisions = 2
executions = 2
Artifact PASS
Verification PASS
Task SUCCEEDED
```

official dsh hidden resource = 0 leak；`useByAgent=false` = DENY + 0 Domain call。

Tool Facade：

```text
127.0.0.1:0
```

Capability domains：

```text
mpx_ = Model Proxy capability
tpx_ = Tool Facade capability
```

二者独立，cross-use DENY。

最后 regression baseline：

```text
npm run test:d4-03b = 59 / 59 PASS
npm run test:d4-03a = 32 / 32 PASS
npm run test:d4-02a = 22 / 22 PASS
npm run test:d4-02b = 16 / 16 PASS
npm run test:d4-02c = 22 / 22 PASS
npm run test:d4-01 = 59 / 59 PASS
npm test = 673 / 673 PASS
npm run build = PASS
npm run test:security = FAIL 0 / PARTIAL 2 / PASS 6
security-surface = 15 / 15 PASS
```

---

## 10. D4-03C — Side-effect Safety

严格拆分：

```text
D4-03C1 Side-effect Authority / Approval / Lease Contract
D4-03C2 Controlled Reversible Write
D4-03C3 Ambiguous Result / Idempotency / Crash Recovery
D4-03C4 Side-effect Final Gate
```

不得合并，不得跳 Gate。

### D4-03C1 — 当前 NEXT

只建立副作用执行安全合同，不执行真实 WRITE。

建立：

```text
SideEffectCall
ToolApproval
SideEffectLease
Idempotency Key
Execution Eligibility
Precondition Snapshot
SideEffectPlan
UNKNOWN_EFFECT state
Verification Contract
```

永久冻结：

```text
ToolDecision
!= Approval
!= Lease
!= Execution
!= Verified Effect
```

C1 只建立 `REVERSIBLE_WRITE` contract；`IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED` 全部 BLOCKED。

即使：

```text
Approval = APPROVED
Lease = ACTIVE
Eligibility = ELIGIBLE
```

C1 最终仍必须：

```text
WRITE_EXECUTION_DISABLED
business mutation = 0
```

C2 才第一次允许真实 `REVERSIBLE_WRITE`。

---

## 11. D4-03C1 Authority Contract

### SideEffectCall

至少绑定：

```text
callId
proposalId
decisionId
taskId
stepId
runId
toolId
toolVersion
effectClass
status
idempotencyKey
argumentsHash
planHash
preconditions
expectedEffects
verificationStatus
errorCode
```

`callId` 与 `idempotencyKey` 必须由 OpenArc 生成，Harness 无权提供。

### Effect Class

```text
REVERSIBLE_WRITE
IRREVERSIBLE_WRITE
EXTERNAL_SIDE_EFFECT
PRIVILEGED
```

C1 只做 `REVERSIBLE_WRITE` contract。

### Approval

Approval 必须来自 OpenArc trusted user action，不得来自 Harness、ACP permission、model output 或 tool arguments。

Approval 精确绑定：

```text
callId
toolId
toolVersion
argumentsHash
planHash
effectClass
expectedEffects
```

任一变化即 stale。

### Lease

同一 `callId` 最多一个 ACTIVE lease。

并发 acquire：只有一个成功；另一方必须 `SIDE_EFFECT_LEASE_CONFLICT`。

```text
Lease != Approval
Lease != Resource Lock
```

### Idempotency

OpenArc 生成 idempotencyKey。Harness 无权设置 `idempotencyKey / callId / leaseId / approvalId`。

同一 SideEffectCall 不能产生第二份副作用 execution authority。

### Execution Eligibility

真正允许 side effect 前必须实时检查：

```text
Task RUNNING
Step RUNNING
current run
session valid
app enabled
tool enabled
tool version current
authorization current
approval APPROVED
approval not expired/revoked
ACTIVE lease exists
lease owned by current executor
task not cancelled
argumentsHash matches
planHash matches
preconditions unchanged
target state valid
```

任一失败：不得执行。

### Preconditions

未来 Resource write 至少绑定：

```text
resourceRef
expectedVersion
```

Approval 后 target version 改变 → `SIDE_EFFECT_PRECONDITION_CHANGED`。

### SideEffectPlan

由 `Tool Adapter.prepare()` 根据真实 Domain state 生成。Harness 不能决定 expectedEffects / preconditions / risk。

C1 中：

```text
prepare() mutation count = 0
```

### UNKNOWN_EFFECT

永久：

```text
UNKNOWN_EFFECT
→ VERIFY
→ BLOCK
```

未来 persisted `side_effect_call.status = RUNNING` 后 process crash/restart：

```text
UNKNOWN_EFFECT
Task BLOCKED
Step BLOCKED
0 replay
0 retry
```

C1 推荐 schema：

```text
SCHEMA_VERSION = 13
side_effect_calls
tool_approvals
side_effect_leases
```

---

## 12. D4-03 后续路线

```text
D4-03C1
↓
D4-03C2
↓
D4-03C3
↓
D4-03C4
↓
D4-03D Full Tool Proxy Gate
↓
D4-04 Vertical Smoke
↓
D4-05 Execution Gate
```

C2 第一次允许真实 REVERSIBLE_WRITE，必须经过：

```text
Proposal
↓
Decision
↓
Plan
↓
Approval
↓
Lease
↓
Execute exactly once
↓
Verify
↓
Release
```

C3 专门处理 ambiguous result / idempotency / crash recovery / UNKNOWN_EFFECT verification，永久禁止 blind retry。

---

## 13. Canvas 集成冻结决策

OpenArc 无限画布不重写。

正式集成：

```text
https://github.com/invaders-2/NOVAI-Infinite-Canvas
```

架构：

```text
OpenArc Desktop
↓
App Registry / Runtime
↓
Canvas Host Adapter
↓
NOVAI local sidecar/backend
↓
smart-canvas.html
```

NOVAI 负责：Canvas UI、nodes、edges、workflow、image/video/LLM nodes、matrix tasks、canvas assistant。

OpenArc 负责：Identity、Authorization、ResourceRef、Projects、Model Service、Agent、App lifecycle、Update。

NOVAI 不得直接访问 OpenArc DB、raw credential、protected absolute path。

现有 CanvasApp Resource Contract fixture 演进为 Host Adapter / Domain bridge，不直接丢弃。

正式实现放 D5。

---

## 14. App Center 冻结决策

内置 App：

```text
独立版本
独立 package
独立更新
permission diff
staging
health check
atomic switch
rollback
```

唯一 Update Authority：

```text
OpenArc App Center
```

禁止用 `git pull` 作为用户产品更新方案。

NOVAI standalone 可保留自身 updater；嵌入 OpenArc 后禁用 NOVAI self-updater，由 OpenArc App Center 管理版本和更新。

D5 建议先建立最小 App Registry / Runtime foundation，再接 Canvas；完整 Package Manager / Updater 后续完成。

---

## 15. 长期 Remaining Gaps

持续挂账：

```text
OS-level network sandbox = NOT VERIFIED
external workspace read audit = NOT VERIFIED
independent malformed ACP injection = NOT VERIFIED
Windows = NOT VERIFIED
External Provider = NOT VERIFIED
Explicit Resume = DEFERRED
```

这些不因 D4-03C / D4-03D PASS 自动关闭。

---

## 16. 文档权威分工

```text
PLAN.md
= 原始完整详细实施基线

PLAN_SYNC.md
= 当前最新 Master Plan Overlay / 新冻结架构 / 当前 WBS / 后续路线

PROGRESS.md
= 当前真实完成状态 / PASS-PARTIAL-BLOCKED-NOT VERIFIED / branch-HEAD / regression baseline

docs/decisions/*
= ADR / 冻结技术决策

docs/D4-xx-RESULT.md
= 阶段真实验收报告与 evidence
```

如果发生冲突：

1. 真实代码、runtime 和测试 evidence 优先。
2. RESULT / PROGRESS 的实际状态优先于计划文本。
3. 新冻结决策以最新 ADR / PLAN_SYNC 为准。
4. PLAN 中出现某能力，不等于该能力已实现。

---

## 17. 固定协作流程

```text
Boss
↓
ChatGPT（总经理 / 技术总负责人）
↓
DeepSeek / Coding Agent（执行）
```

DeepSeek 负责：代码审计、实现、修改、测试、真实 E2E、Regression、Commit、Push、阶段 Result。

DeepSeek 不负责：降低 Gate、跳阶段、改变冻结架构、把 PARTIAL 写成 PASS、擅自进入下一阶段。

每个阶段完成后必须 STOP。

审计结论只允许：

```text
PASS
PARTIAL
BLOCKED
NOT VERIFIED
```

PASS → 下一小阶段。
PARTIAL → Closure/Fix。
BLOCKED → Blocker Investigation/Fix。

风险越高，阶段拆得越细。

---

## 18. 当前下一步

```text
D4-03C1
Side-effect Authority / Approval / Lease Contract
```

C1 完成前始终保持：

```text
production WRITE execution = 0
business mutation = 0
MCP = 0
Shell = 0
Browser automation = 0
```

只有 C1 真实 PASS 后，D4-03C2 才能 `CONDITIONAL GO`。
