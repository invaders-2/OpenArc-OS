# D4-02C · Task ↔ Harness Orchestration（macOS）

- **状态**：**D4-02C = PASS**（macOS）；**D4-02 macOS Task/Harness Core = PASS**；**cross-platform = PARTIAL**（Windows NOT VERIFIED）；**D4-03 Controlled Tool Proxy = BLOCK**
- **分支**：feature/d4-02-task-harness，基线 `2b11648`，未 merge main
- **日期**：2026-09-15

## 核心权威原则（永久冻结）

**OpenArc = Task Authority；Harness = Ephemeral Reasoning Runtime。**

Orchestrator 不是第二 authority：不保存 task/step status、revision、queue、retry count、permission state。所有持久 mutation 一律经 `TaskService`（绝不直写 SQLite）。Harness event / ACP update 永远不能自己改 Task/Step status；终态只由 Orchestrator 依据 stopReason / cancel state / errors / revision 显式决定。

## 垂直链路

```
Task → TaskStep(reasoning) → Harness Run → ACP v1 → OpenArc Model Proxy
→ Provider → ACP updates → safe TaskEvent → Artifact → Verification
→ Step/Task SUCCEEDED
```

顺序硬约束：Task PENDING→RUNNING → Step PENDING→RUNNING → spawn Harness → initialize → session/new → session/prompt。禁止 Harness 先跑再补 Task 状态。

## Harness Run 模型（schema v10 · `task_harness_runs`）

`run_id / task_id / step_id / status / harness_version / acp_version / model_config_id / model_config_version / started_at / completed_at / stop_reason / error_code`。
状态冻结：`STARTING / RUNNING / SUCCEEDED / BLOCKED / CANCELLED / FAILED`。
**禁止**落 proxy token / provider key / 完整 ACP transcript。ACP `sessionId` 只是 ephemeral runtime correlation，`ACP sessionId != taskId/stepId`。

## Capability Execution Binding

Model Proxy capability 新增可选 `binding:{taskId,stepId,runId}`（存于内存 capability，不进 Provider 权限合同、不落盘）。Harness Model Adapter 以 `expectedToken` 绑定本 run 的 capability：run A 的 token 用于 run B → **401**。Harness turn 结束（success/failure/cancel/timeout/crash/conflict/blocked）**立即 revoke**，不等 TTL。

## Prompt / Context（§16/§17）

只放 `Task.goal + safe Step.input + 可选 prior artifact`；不塞 DB dump / audit / credentials / Resource 绝对路径 / 全历史。默认不保存完整 prompt：保存 `promptSchemaVersion + inputHash`（以及需要时的安全结构）。

## ACP → TaskEvent Mapping（显式表）

`text.delta → harness.text.delta`（只聚合计数字符/块数）、`reasoning.delta → drop（transient）`、`tool.proposed → harness.tool_proposed`、`plan → harness.plan`、`usage → harness.usage`、`session/request_permission → harness.permission_requested + harness.permission_rejected`。未知事件丢弃；每 turn 有 `maxPersistedHarnessEvents` 上限（flood protection），deltas 只做 transient summary，不影响最终 Artifact。

## Artifact / Verification（§25–§29/§79/§80）

只做 `text` / `json` 两类 Task Runtime 内部产物（`task_artifacts`：type/safe_content/checksum/created_at），**不写 Resource Library / 不产生文件 side effect**。`task_verifications` 第一版 `EXACT_TEXT` / `SCHEMA_VALID`，状态 `PASS/FAIL`。

## Success Atomicity（§31/§32/§81/§82/§83/§84）

只有 **Artifact persisted + Verification PASS** 才允许 Step SUCCEEDED，进而 Task SUCCEEDED（无其它未完成 step）。Artifact + Verification + Step + Task + Events 在**同一事务**提交；Artifact 写入失败或 cancel 竞争 → 绝不允许 SUCCEEDED（BLOCKED/FAILED）。永久冻结：assistant says "done" != Task succeeded。

## Cancel / Cancel Race（§33/§34）

用户 cancel：先持久 `cancel_requested=1`（`task.cancel_requested`）→ ACP `session/cancel` → bridge abort → Provider 连接关闭 → capability revoke → `finalizeCancel`（Step/Task CANCELLED）。`commitStepSuccess` 在事务内再次检查 `cancel_requested`，因此竞争唯一解，绝不产生 `Task CANCELLED + Step SUCCEEDED`。

## Crash / Timeout / Restart（§36/§37/§38/§43/§44/§45/§69）

Harness crash → Step/Task `BLOCKED` + `HARNESS_PROCESS_EXITED`，**0 respawn / 0 rerun / 0 provider retry**。turn timeout → `BLOCKED` + `HARNESS_TURN_TIMEOUT`，不自动第二次 prompt。进程重启：recovery 把 RUNNING Task/Step 转 `BLOCKED/RECOVERY_REQUIRED`，未收尾 run 转 `BLOCKED` 并落 `harness.run.unknown_effect`；**0 自动 session/resume、0 ACP reconnect、0 rerun**。`UNKNOWN EFFECT → VERIFY/BLOCK`，绝不 RETRY。Explicit Resume = **DEFERRED**。

## Retry / Attempt（§40/§41/§42）

`AUTO_RETRY = 0`，`attempt = 1`，`maxAttempts = 1`。TaskService / Orchestrator / Harness / Adapter / Proxy 均 0 隐藏 retry。

## Tool / Permission / MCP（§21/§22/§23/§71/§72）

tool_call → **0 execute** + `harness.tool_proposed` + Step `BLOCKED/TOOL_EXECUTION_NOT_AVAILABLE`（绝不 SUCCEEDED）。`session/request_permission` → 一律 reject + `harness.permission_requested/rejected` + Step `BLOCKED/PERMISSION_NOT_AVAILABLE`。`mcpServers = []`。

## Model Snapshot / Mid-turn（§59/§60）

运行前 config 变化 → `MODEL_CONFIG_CHANGED`，Harness 不启动。capability 签发后 config 变化 → Model Proxy `STALE_CAPABILITY` → Block，不 fallback。Model call 关联：OpenArc 生成 `requestId (mreq_<runId>)` 绑定 taskId/stepId/runId，写入 `task_model_calls` + `harness.usage`。

## Migration（schema v10）

`SCHEMA_VERSION = 10`，v9 之上加 `task_harness_runs / task_artifacts / task_verifications`。`v1→current … v9→current` 与 v10 级失败整级回滚（`user_version` 停 9、v10 表不残留）全部 PASS。

## Isolation

User / App / Artifact access 继承 Task ownership + App context（无 Artifact ACL）。Provider Secret 0 hit；完整 proxy capability 不落 Task DB / Event / Artifact / Audit。

## D4-03 Handoff

D4-02C PASS 后：**D4-03 Controlled Tool Proxy = CONDITIONAL GO**，但**不自动开始**。直到 D4-03：production tool execution = 0、MCP = 0。D4-02B 遗留（OS-level network isolation / external workspace read audit / malformed ACP injection / Windows / External Provider）继续挂账，**不因 C PASS 自动关闭**。
