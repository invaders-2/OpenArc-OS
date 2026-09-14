# D4-02 · Task Authority / Harness Boundary

- **状态**：**D4-02A Task Domain / Persistent Authority = PASS**（macOS）；**D4-02B ACP Harness Adapter = NOT STARTED**；**D4-02 overall = PARTIAL**；**D4-03 Controlled Tool Proxy = BLOCK**
- **分支**：feature/d4-02-task-harness，基线 feature/d4-01-model-service @ `5afece6`，未 merge main
- **日期**：2026-09-15

## 核心权威原则（永久冻结）

**OpenArc = Task Authority；Harness = Reasoning Runtime。**

Harness 永远不能拥有：persistent task queue / persistent task state / step authority / retry authority / tool execution authority / lease authority / permission authority。D4-02A 只建立 OpenArc 侧的权威数据模型与 Domain Command，**不接 Harness / ACP / Tool / MCP**。

## Scope

Task / TaskStep / ModelCall / TaskEvent 的持久化、显式状态机、revision 乐观并发、append-only event、D3 授权复用、模型 snapshot 冻结、cancel 持久化、进程重启 recovery。**不实现** Task 调度器、Tool 执行、Harness task loop、IPC/Renderer UI。

## Store Schema（schema v9）

`tasks` / `task_steps` / `task_model_calls` / `task_events` + 索引：
`tasks(user_id, status)`、`tasks(app_id)`、`task_steps(task_id, sequence)`、`task_events(task_id, sequence)`、`task_model_calls(task_id, step_id)`。
`task_events` 有 `UNIQUE(task_id, sequence)`；**禁止** `task_acl` / `task_role` / `task_permissions`（无第二套权限系统）。

## Task Status

`PENDING / RUNNING / WAITING / SUCCEEDED / FAILED / CANCELLED / BLOCKED`。不增加模糊状态。

## Step Status

`PENDING / RUNNING / SUCCEEDED / FAILED / CANCELLED / BLOCKED`。

## State Machine（显式 transition table）

```
PENDING  → RUNNING | CANCELLED | BLOCKED
RUNNING  → WAITING | SUCCEEDED | FAILED | CANCELLED | BLOCKED
WAITING  → RUNNING | CANCELLED | BLOCKED
BLOCKED  → RUNNING | CANCELLED
SUCCEEDED / FAILED / CANCELLED → （终态，不可变）
```
Step：`PENDING → RUNNING | CANCELLED | BLOCKED`，`RUNNING → SUCCEEDED | FAILED | CANCELLED | BLOCKED`，`BLOCKED → RUNNING | CANCELLED`。
**禁止** `SUCCEEDED→RUNNING` / `FAILED→SUCCEEDED` / `CANCELLED→RUNNING`。

## Revision / Concurrency

Task 有 `revision`；每次状态 mutation `revision++`。所有 mutation 必须带 `expectedRevision`；不匹配返回 `TASK_REVISION_CONFLICT`（不 silent last-write-wins），且**不产生任何副作用**。缺失 `expectedRevision` → `INVALID_INPUT`。revision 是 Task aggregate 的唯一并发令牌（step / model call mutation 同样 bump task revision）。

## Events（append-only，state 与 event 同 transaction）

Event 类型：`task.created/started/cancel_requested/cancelled/succeeded/failed/recovery_blocked`、`step.created/started/succeeded/failed/recovery_blocked`、`model.call.started/completed/failed`。
`sequence` 每 task 严格递增（1,2,3…），由 `UNIQUE(task_id, sequence)` 兜底。**禁止**"改 state 不写 event"与"写 event 但 state 未变"。event payload 走白名单 + 敏感 key 打码 + 长度截断。

## Authorization

所有 Task command 的 actor 一律由 **D3 `AuthorizationService.resolveActor`** 从可信 `context.sessionRef` 解析，忽略 payload 自报的 `userId/role/appId`；App 必须 enabled。Personal Task 只对 **owner + 创建它的 App** 可见/可控（User isolation + App isolation 均硬断言）。无 super 覆盖。

## Model Snapshot / Config Change

Task 创建时冻结 `modelConfigId + modelConfigVersion`；调用时**重新 authorize + 重新检查 model/provider status**。若 current version ≠ snapshot version → `MODEL_CONFIG_CHANGED`，**不静默升级**（resume/update 策略留给 D4-02B）。

## Cancel

`cancelTask` 持久化 `cancelRequested = 1`（不是只发内存 AbortSignal），并落 `task.cancel_requested` + `task.cancelled` 两个 event；跨进程重启后仍知道用户已取消。

## Retry / Attempt

**AUTO_RETRY = 0**，`attempt = 1`，`maxAttempts = 1`。model failure / timeout / disconnect **绝不**自动创建新 call。显式重试只能由上层用户/命令决定。

## Tool Boundary / Side Effect

D4-02A **不存在 side effect execution**；ToolProposal 即使后续建表也只有 proposal，`TOOL_EXECUTION = FORBIDDEN`。production tool execution = 0。

## Migration

`SCHEMA_VERSION = 9`（v8 之上只加 Task Runtime 表）。`v1→current … v8→current` 与 v9 级失败整级回滚（`user_version` 保持 8、task 表不残留）全部 PASS。

## Recovery / Unknown Effect

启动即执行一次 recovery：重启前 `RUNNING` 的 Task/Step 一律转 `BLOCKED` + `RECOVERY_REQUIRED`，并落 `task.recovery_blocked`（RUNNING step 另落 `step.recovery_blocked`）。**0 自动 replay / 0 retry**。永久冻结 `UNKNOWN EFFECT → VERIFY / BLOCK`：进程在 call 中途崩溃不得 blind retry。

## Error Codes

`TASK_NOT_FOUND / TASK_FORBIDDEN / TASK_INVALID_STATE / TASK_REVISION_CONFLICT / TASK_CANCELLED / MODEL_CONFIG_CHANGED / RECOVERY_REQUIRED / INVALID_INPUT`。

## Audit

`task.create / task.start / task.cancel / task.complete / task.fail` 走 D3 `authorization_audit`；TaskEvent 与 Audit 用途不同，二者都保留。Recovery 不伪造 user audit，只落 TaskEvent。

## Performance（smoke，非 SLA）

测试机 macOS arm64：create 100 tasks ≈27ms；append 1000 events（单事务）≈18.5ms；load task ≈0.11ms；list 100 user tasks ≈0.37ms。**MEASURED ON TEST MACHINE · NOT PRODUCT SLA。**

## D4-02B Handoff

D4-02A 已交付持久权威。**D4-02B ACP Harness Adapter = 下一阶段**，冻结条件：ACP ONLY；`HARNESS_RAW_PROVIDER_KEY = FORBIDDEN`；Harness 只与 Model Proxy 通信，只接收 Proxy endpoint + scoped capability + safe model snapshot；不拥有 persistent queue/state/retry/tool/lease/permission authority。**D4-03 = BLOCK**，直到 D4-02 自身 PASS。
