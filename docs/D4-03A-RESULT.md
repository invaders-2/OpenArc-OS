# D4-03A Result

Task Status: **D4-03A Tool Contract / Registry / Authorization Gate = PASS**（macOS）；**D4-03 overall = PARTIAL**；**D4-03B Controlled Read-only Execution = BLOCK**（A PASS 后 CONDITIONAL GO，不自动开始）。全阶段 **production tool execution = 0 / MCP = 0 / Shell = 0**。

## 1. Base
从 feature/d4-02-task-harness @ 5d37d64（local HEAD == origin == 5d37d64，working tree clean）创建 feature/d4-03-tool-proxy；未 merge main。

## 2. Tool Registry
electron/tool-registry.cjs 是唯一权威。内置 3 个测试 Tool：test.echo、test.write（审批探针）、resource.read.metadata；**未注册** shell/terminal/filesystem.write/process.spawn/MCP/browser side-effect（测试断言）。Harness 不能 register / modify schema / enable / 改 risk class（重复注册、非法 toolId、frozen contract 均被拒）。

## 3. Tool Contract
每个 contract 含 toolId/version/displayName/description/inputSchema/outputSchema/riskClass/sideEffect/requiresApproval/requiredPermissions/resourceActions/executionProvider/enabled/expectedSideEffects，注册后 Object.freeze。inputSchema.type=object 且 additionalProperties=false。

## 4. Tool Proposal
proposal 的 taskId/stepId/runId/user/session/app 来自 OpenArc trusted context；Harness 只能提供 toolId + arguments（+ optional rationale）。Proposal != Execution，初始 status PROPOSED、落 task_tool_proposals。忽略 payload 自报 userId/role/appId/permission/approval。

## 5. Tool Decision
tool_decisions 每 proposal 至多一条；decision ∈ ALLOWED / DENIED / APPROVAL_REQUIRED / INVALID / BLOCKED；含 reason_code / risk_class / approval_required。ALLOWED 只代表 policy 允许潜在执行，**不代表已执行**。

## 6. Risk Classification
riskClass = READ_ONLY / REVERSIBLE_WRITE / IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED（带 side-effect 语义）；sideEffect = NONE/READ/WRITE/EXTERNAL。Risk 只来自 Registry；Harness arguments 里的 risk/riskClass 因 additionalProperties=false 被判 INVALID，decision 不变。

## 7. Approval Policy
READ_ONLY → ALLOWED（无审批）；WRITE/EXTERNAL/PRIVILEGED → APPROVAL_REQUIRED。test.write 实测 APPROVAL_REQUIRED、approval_required=1。D4-03A 不实现可执行 approval token；真正 lease/approval binding 留 D4-03C。

## 8. Authorization
复用 D3 AuthorizationService：Session ∩ User ∩ App ∩ Tool permission ∩ Resource action ∩ Department policy。Tool 权限 namespace（tool.test.echo / tool.resource.readMetadata）与 resource.action 同级，存同一 app_resource_grants（scope=TOOL），经 authorizeTool / grantAppToolPermission 管理，不建第二权限系统。authorized owner + app tool permission + resource.read → ALLOWED；wrong user / wrong app / missing app tool permission / disabled app / bogus session / missing resource permission → DENY。

## 9. useByAgent
Agent proposal 走 agent=true：资源即使 User can read，未授予 resource.useByAgent → DENY TOOL_AGENT_USE_NOT_AUTHORIZED（真实 E2E：alice 有 resource.read 但无 useByAgent）。

## 10. ResourceRef
资源型 Tool 只接受 ResourceRef（pattern ^resource://res_...）；absolute path / rawPath / filesystemPath / filePath 被 schema 与防御检查拒绝。除未来经 Device/File Broker 专门合同外，Tool schema 不出现 absolute path。

## 11. Identity Spoof Protection
arguments 里 userId / appId / role / approved 一律无效：additionalProperties=false → INVALID，且 trusted app/user 仍来自 Task context + D3 actor；payload 值不落库。

## 12. Schema Validation
极简 JSON Schema 子集校验：type/properties/required/additionalProperties:false/pattern/minLength/maxLength/minimum/maximum/maxItems/items/enum。失败 → TOOL_ARGUMENT_INVALID，Harness 不得自行修正重试（AUTO_RETRY=0，不重新询问 Harness）。

## 13. Version Validation
每个 contract 必须有 version；未知版本 → DENIED TOOL_VERSION_UNSUPPORTED（返回 supportedVersions）。不会静默沿用旧 proposal。

## 14. Stale Proposal
proposal.runId 必须是该 task/step 的当前（最新）run，否则 BLOCKED TOOL_PROPOSAL_STALE。decision 绑定 taskRevision；revision 变化必须重新授权。

## 15. Duplicate Proposal
同一 proposalId 重复送达 → 幂等：返回既有 decision，不生成第二个（UNIQUE(proposal_id) 兜底）。不同 proposalId 但相同 (task/step/run/tool/arguments hash) 本阶段允许两条，不做复杂去重（side-effect idempotency 留 C）。

## 16. Execution Plan
dry-run ExecutionPlan：toolId/toolVersion/resourceRefs/riskClass/sideEffect/requiredPermissions/resourceActions/approvalRequired/expectedSideEffects/executionProvider，且 dryRun=true、execute=false。prepare() 只生成 plan，绝不偷偷执行。

## 17. Audit
authorization_audit 记录 tool.proposed / tool.validation_failed / tool.authorization_denied / tool.approval_required / tool.execution_blocked；只记 action/decision/reason/toolRef，不 dump 完整 arguments（安全 projection + hash）。

## 18. Task Events
新增 task.waiting、tool.proposed、tool.validated、tool.denied、tool.approval_required、tool.execution_blocked；与既有 harness.tool_proposed 一起落 append-only TaskEvent。TaskEvent 仍不是 Tool Authority。

## 19. Tool Proposal E2E
真实链路 Task → Harness(synthetic ACP tool_call) → TaskHarnessOrchestrator → ControlledToolProxy → Registry → D3 Authorization → Decision，最终 0 Tool execution。READ_ONLY → decision ALLOWED + Task BLOCKED TOOL_EXECUTION_NOT_AVAILABLE；resource tool 授权通过 → ALLOWED；WRITE → APPROVAL_REQUIRED + Task WAITING；未注册/注入 toolId → BLOCKED TOOL_NOT_FOUND + tool.denied。使用 test-only synthetic ACP tool proposal fixture，未打开生产 shell/filesystem。

## 20. Tool Execution Boundary
execute() = forbidden；无 tool_executions 表；任何 decision 都 executionStatus = NOT_EXECUTED、executed=false；0 artifact 由 tool 产生。

## 21. MCP Boundary
mcpServers=[] 继续，MCP = 0；Registry 未注册任何 MCP tool。

## 22. Secret Scan
Tool arguments 里的 apiKey/secret 不落 proposal/decision/event/audit；Provider Secret 与 proxy capability（mpx_）在 Task/Tool DB 0 hit；Tool DB 扫描断言通过。

## 23. Migration
SCHEMA_VERSION = 11，v10 之上加 task_tool_proposals / tool_decisions；v1→current … v10→current 与 v11 级失败整级回滚（user_version 停 10、v11 表不残留）PASS。无 tool_executions 表。

## 24. D4-02 Regression
npm run test:d4-02c = 22/22 PASS；npm run test:d4-02b = 16/16 PASS；npm run test:d4-02a = 22/22 PASS（同步 schema v11 断言）。

## 25. D4-01 Regression
npm run test:d4-01 = 59/59 PASS；npm test = 614/614 PASS；npm run build = PASS。

## 26. Security
npm run test:security = FAIL 0 / PARTIAL 2 / PASS 6；security-surface（D2-02 A13）= 15/15 PASS（未新增 Renderer IPC，暴露面不变）。

## 27. Tests
新增 tests/tool-registry.test.mjs、tool-proposal.test.mjs、tool-authorization.test.mjs、tool-gate-security.test.mjs、tool-proposal-e2e.test.mjs、tool-migration.test.mjs；夹具 tests/fixtures/harness-acp/tool-harness-fixture.mjs、tool-proposal-agent.mjs；入口 experiments/d4-03a/run-all.mjs + npm run test:d4-03a = 32/32 PASS。

## 28. Files Changed
产品：electron/tool-domain.cjs、tool-registry.cjs、tool-store.cjs、controlled-tool-proxy.cjs（新）；identity-store.cjs（schema v11）；authorization-domain.cjs / authorization-service.cjs（Tool 权限 namespace + authorizeTool/grantAppToolPermission）；task-domain.cjs / task-service.cjs（tool events + waitForApproval）；task-harness-orchestrator.cjs（toolProxy 接线）；harness-adapter.cjs（tool title/rawInput 安全捕获）；task-bootstrap.cjs / identity-bootstrap.cjs。
测试/入口：6 个 tool-*.test.mjs、tool fixtures、6 个 migration 测试同步 v11、experiments/d4-03a/run-all.mjs、package.json。
文档：docs/decisions/D4-03-controlled-tool-proxy.md、docs/D4-03A-RESULT.md、PROGRESS.md。

## 29. Commits
- 313aa6c D4-03: add controlled tool registry and authorization gate
- b787a8c test(D4-03): verify tool proposal isolation and policy
- docs(D4-03): freeze controlled tool boundary（本文件所在提交）
local HEAD == origin/feature/d4-03-tool-proxy；working tree clean；未 merge main。

## 30. Evidence
| 入口 | 结果 |
|---|---|
| npm run test:d4-03a | 32 / 32 PASS |
| schema | 11 |
| Registry tools | test.echo / test.write / resource.read.metadata |
| npm run test:d4-02c | 22 / 22 PASS |
| npm run test:d4-02b | 16 / 16 PASS |
| npm run test:d4-02a | 22 / 22 PASS |
| npm run test:d4-01 | 59 / 59 PASS |
| npm test | 614 / 614 PASS |
| npm run build | PASS |
| npm run test:security | FAIL 0 / PARTIAL 2 / PASS 6 |
| security-surface | 15 / 15 PASS |
| production tool execution | 0 |
| MCP / Shell | 0 / 0 |
| READ_ONLY decision | ALLOWED + NOT_EXECUTED |
| WRITE decision | APPROVAL_REQUIRED + Task WAITING |
| useByAgent=false | DENY |
| Provider Secret / capability persistence | 0 hit |

## 31. Remaining Gaps
OS-level network isolation = NOT VERIFIED；external workspace read audit = NOT VERIFIED；independent malformed ACP injection = NOT VERIFIED；Windows = NOT VERIFIED；External Provider = NOT VERIFIED；Explicit Resume = DEFERRED。真实 dsh 工具开启后的 proposal = NOT VERIFIED（managed profile 工具全关，proposal 经 synthetic ACP fixture 验证 Gate 策略）。不因 D4-03A 关闭。

## 32. D4-03B Admission
**D4-03B Controlled Read-only Execution = CONDITIONAL GO**（D4-03A PASS 后），但**不自动开始**。B 才允许第一批真正执行 READ_ONLY Tool（resource.read.metadata / resource.search），仍不允许写；C 处理 side effects / lease / idempotency / ambiguous result / unknown effect / explicit approval；D 才是 full Tool Proxy Gate，通过后才进入 D4-04 Vertical Smoke。
