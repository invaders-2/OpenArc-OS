# D4-03B · Controlled Read-only Tool Execution（macOS）

- **状态**：**D4-03B 执行引擎 = PASS**；**D4-03B overall = PARTIAL**（official dsh read-tool E2E = NOT VERIFIED）；**D4-03C = BLOCK**
- **分支**：feature/d4-03-tool-proxy，基线 b411651，未 merge main
- **日期**：2026-09-15

## 目标

第一次允许 OpenArc 真正执行 Tool，但仅 READ_ONLY。第一批：resource.read.metadata / resource.search（+ test.echo 测试 Tool）。仍然禁止 WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED / Shell / Filesystem mutation / Browser / MCP / App mutation。

## 执行链

Task → Harness tool proposal → ControlledToolProxy.propose → decide(ALLOWED) → executeReadOnly（reauthorize → ExecutionPlan match → adapter.prepare/execute）→ verify（outputSchema + adapter.verify）→ ToolExecution record → safe result → 后续 ACP prompt 交回 Harness → Artifact/Verification → Step/Task SUCCEEDED。

## 执行前重新授权（冻结）

Decision ALLOWED 不是长期授权。executeReadOnly 在执行前重新检查：Session、User、App、Task owner、Task RUNNING 且未 cancel、expectedRevision、Step RUNNING、当前 run（stale run → BLOCK）、Tool enabled/version、Resource 仍 active、Resource 权限、useByAgent。任一变化 → DENY/BLOCK，且返回 0 数据。commit 前再次检查 revision / cancel / session / app，失败即丢弃结果。

## Tool Adapter（静态 allowlist）

接口 prepare/execute/verify。Registry 的 executionProvider → 受信任 adapter（test / ResourceService / SearchService）；Harness 不能提供 module/path/function/command。禁止动态 require / import(arguments.path) / eval / new Function。Adapter 只调用既有 Domain（ResourceService.get / SearchService.search），绝不直接 SQL，也不新增 Tool 专用无权限 search。

## 输入 / 输出验证与 redaction

inputSchema + outputSchema 双向验证（additionalProperties=false）。输出只保留 allowlist 字段（resourceRef/name/resourceType/mimeType/version/updatedAt/size/scope；search items 另加 bounded snippet），绝不返回 ownerUserId/checksum/storageDeviceId/absolute path/internal blob path。outputSchema 失败 → FAILED TOOL_OUTPUT_INVALID；adapter.verify 失败 → FAILED TOOL_VERIFICATION_FAILED；两者都不把脏结果交给 Harness。

## Execution 记录（schema v12）

tool_executions：execution_id / proposal_id / decision_id / task_id / step_id / run_id / tool_id / tool_version / status / started_at / completed_at / result_ref / result_hash / verification_status / error_code。UNIQUE(proposal_id) 保证同一 proposal 不执行两次（duplicate → 返回既有 execution，0 Domain call）。**无 UNKNOWN_EFFECT**（READ_ONLY 正常执行）；side-effect unknown effect 留 D4-03C。

## 执行状态 / 错误

status：PENDING / RUNNING / SUCCEEDED / FAILED / CANCELLED / BLOCKED。错误码：TOOL_NOT_EXECUTABLE / TOOL_EXECUTION_STALE / TOOL_PLAN_STALE / TOOL_TIMEOUT / TOOL_EXECUTION_FAILED / TOOL_OUTPUT_INVALID / TOOL_VERIFICATION_FAILED / TOOL_AUTHORIZATION_REVOKED / RESOURCE_NOT_AVAILABLE / WRITE_EXECUTION_DISABLED。AUTO_RETRY = 0；超时/失败 0 retry。

## Cancel / Race

executeReadOnly 接受 AbortSignal；中断 → BLOCKED/CANCELLED 且不返回数据。Task cancel、session revoke、app disable、permission revoke、useByAgent revoke、resource delete、revision 变化都在执行前或 commit 前 gate，失败即 0 Domain 返回。禁止 Task CANCELLED + ToolExecution SUCCEEDED 后继续。

## Search 隐私

resource.search 复用服务端授权搜索（FTS 只给候选，authorizeMany 实时授权，agent=true → useByAgent）；limit 上限 20（maxLimit 冻结），total 只统计 authorized；隐藏资源返回 0 且无差异化错误。

## Task / Event

READ_ONLY 执行期间 Task/Step 保持 RUNNING；TaskEvent：tool.execution.started / succeeded / failed、tool.verification.failed。Event 只放 executionId/result hash/error code，不 dump 完整 result。Audit：tool.execution_started / succeeded / failed / verification_failed，只存安全投影。

## Harness 结果回传（诚实边界）

ACP 没有标准 client→agent tool-result 消息。OpenArc 执行并 verify 后，把 bounded 安全结果作为**后续 ACP prompt** 交回 Harness 继续推理；Harness 不能自己伪造 tool result。本轮垂直链使用 official ACP v1 协议的受控 test agent（openarc-readonly-tool-probe），**official dsh 自身 read-tool E2E = NOT VERIFIED**：managed profile 工具全关，未启用任何 shell/filesystem/web 或自定义 dsh tool facade。因此按规格 §90，D4-03B overall = PARTIAL。

## 冻结

1. OpenArc executes / verifies；Harness 不能伪造 tool result。
2. execute 前必须 reauthorize；decision 不是长期授权。
3. 只 READ_ONLY 可执行；WRITE 仍 APPROVAL_REQUIRED + 0 执行。
4. Adapter 只能静态 allowlist + 既有 Domain；无动态 require / raw SQL。
5. output schema + redaction 双向；脏结果不交 Harness。
6. duplicate 0 二次执行；AUTO_RETRY=0。
7. 人工 UI 与 Agent 复用同一 Domain（ResourceService / SearchService）。

## Migration

SCHEMA_VERSION = 12；v1→current … v11→current 与 v12 级失败整级回滚 PASS。

## 下一步

D4-03C 才允许 REVERSIBLE_WRITE 与 approval/lease/idempotency/unknown-effect。D4-03C = BLOCK，直到人工开启（并解决 official dsh read-tool E2E）。
