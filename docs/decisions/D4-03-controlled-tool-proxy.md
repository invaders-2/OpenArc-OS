# D4-03 · Controlled Tool Proxy（macOS）

- **状态**：**D4-03A = PASS**；**D4-03B 执行引擎 = PASS / overall = PARTIAL**（official dsh read-tool E2E NOT VERIFIED）；**D4-03 overall = PARTIAL**；**D4-03C = BLOCK**
- **分支**：feature/d4-03-tool-proxy，基线 feature/d4-02-task-harness @ 5d37d64，未 merge main
- **日期**：2026-09-15

## 核心原则（永久冻结）

**Harness proposes. OpenArc decides. OpenArc executes. OpenArc verifies.**

Harness 永远不能直接执行 Tool / shell / filesystem mutation / MCP / browser automation / Device Agent。D4-03A 只建立合同与 Gate：**execute() = forbidden**，任何 proposal 最终 executionStatus = **NOT_EXECUTED**。

## 唯一 Tool Authority

OpenArc Tool Registry 是唯一权威。Harness 不能 register tool / modify schema / enable tool / change risk class；Registry 只由 OpenArc trusted code 管理。Tool ID 必须稳定且点分小写 namespace（例：resource.read.metadata / test.echo），路径与注入字符一律 TOOL_NOT_FOUND。每个 contract 有 version；schema 改变必须新版本，不静默沿用旧 proposal。

## Tool Contract

toolId / version / displayName / description / inputSchema / outputSchema / riskClass / sideEffect / requiresApproval / requiredPermissions / resourceActions / executionProvider / enabled / expectedSideEffects。inputSchema 为 object，默认 additionalProperties=false。

## Risk / Side Effect / Approval

riskClass 必须带 side-effect 语义：READ_ONLY / REVERSIBLE_WRITE / IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED（禁止 low/medium/high 单一分类）。sideEffect = NONE / READ / WRITE / EXTERNAL。READ_ONLY 未来可 auto-approve；WRITE / EXTERNAL / PRIVILEGED 必须显式审批。Risk 只来自 Registry，Harness payload 自报 risk 无效（additionalProperties=false 直接拒绝）。D4-03A 所有 decision 仍 0 执行。

## Proposal / Decision

ToolProposal != ToolExecution。proposal 的 taskId/stepId/runId/user/session/app 全部来自 OpenArc trusted context，Harness 只能提供 toolId + arguments + optional rationale。Decision 状态：ALLOWED / DENIED / APPROVAL_REQUIRED / INVALID / BLOCKED；ALLOWED 只代表 policy 允许潜在执行。任一 decision 都 executionStatus = NOT_EXECUTED。

## D3 Authorization（复用，不建第二权限系统）

资源动作复用 AuthorizationService.authorize：Session ∩ User ∩ App ∩ Tool permission ∩ Resource action ∩ Department policy，Agent 追加 useByAgent。Tool 权限 namespace 与 resource.action 同级（tool.test.echo / tool.resource.readMetadata），存于同一 app_resource_grants（scope=TOOL），由 authorizeTool / grantAppToolPermission 管理。资源型 Tool 只接受 ResourceRef；禁止 absolutePath / rawPath / filesystemPath / credential / apiKey。

## Persistence（schema v11）

task_tool_proposals（proposal_id/task_id/step_id/run_id/tool_id/tool_version/arguments_safe/arguments_hash/status/created_at）与 tool_decisions（decision_id/proposal_id/decision/reason_code/risk_class/approval_required/created_at）。UNIQUE(proposal_id) 保证同一 proposalId 幂等，不生成第二个 decision。**无 tool_executions 表**（D4-03A 不存在真实执行）。arguments_safe 只存 schema 声明字段的安全 projection；绝不存完整 raw arguments。

## Stale / Terminal / Cancel

proposal 属于旧 run → BLOCKED TOOL_PROPOSAL_STALE。Task 已 SUCCEEDED/FAILED → DENIED TASK_TERMINAL；CANCELLED / cancel_requested → BLOCKED TASK_CANCELLED。decision 绑定 taskRevision；revision 变化必须重新授权，不复用旧 decision。

## Task 状态映射

READ_ONLY ALLOWED 但执行未开放 → Step/Task BLOCKED，reason TOOL_EXECUTION_NOT_AVAILABLE。Authorization DENY → Step/Task BLOCKED，reason TOOL_FORBIDDEN（或其具体码）。Schema invalid → TOOL_ARGUMENT_INVALID。APPROVAL_REQUIRED → Step BLOCKED + Task WAITING，reason TOOL_APPROVAL_REQUIRED。

## Tool Proposal E2E

真实链路 Task → Harness(synthetic ACP tool_call) → TaskHarnessOrchestrator → ControlledToolProxy → Registry → D3 Authorization → Decision；0 Tool execution。测试只用 synthetic ACP tool proposal fixture / 受控测试 Tool，**绝不为测试打开生产 shell / filesystem tools**；MCP 继续 0。

## 人工 UI 与 Agent 共用同一条命令（冻结）

未来人工审批/执行 UI 与 Agent 必须复用 same domain command / same authorization / same lock / same audit，不为 AI 建特殊后门。真正执行时 Tool Adapter 只能调用既有 Domain Command（ResourceService / WindowCommand / BrowserCommand 等），不得另写业务。真正 lease / approval binding / side-effect idempotency 放 D4-03C。

## Migration

SCHEMA_VERSION = 11，v10 之上加 task_tool_proposals / tool_decisions。v1→current … v10→current 与 v11 级失败整级回滚全部 PASS。

## Remaining

D4-03B Controlled Read-only Execution = BLOCK，直到人工开启。D4-02B 遗留（OS-level network isolation / external workspace read audit / malformed ACP injection / Windows / External Provider）继续挂账，不因 D4-03A 关闭。
