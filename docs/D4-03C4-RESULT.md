# D4-03C4 · Side-effect Final Gate · 结果记录

Base HEAD：\`e371637fd3c8e512242649c16129251349bb300e\`
入口：\`npm run test:d4-03c4\`（node gate + Approval UI probe）／\`npm run test:d4-03c4-ui\`

## Task Status

\`\`\`
D4-03C4 = PASS candidate
D4-03C overall = PASS candidate
D4-03D = NOT STARTED
\`\`\`

（DeepSeek 无权正式封板；由 ChatGPT 审计后决定 \`D4-03C = PASS\`。）

## 1. 唯一 production 装配

新增 \`electron/side-effect-runtime.cjs\`（\`SideEffectRuntime\`）与 \`electron/task-bootstrap.cjs\` 装配：

\`\`\`
ToolRegistry → ControlledToolProxy → SideEffectAuthority
                                 ↘ RuntimeSupervisor → SideEffectRuntime
\`\`\`

不新增第二套 Task / Tool permission / Approval / Resource ACL / Execution state machine。

## 2. 谁真正拥有 resource.trash execution

**受监督 executor runtime 子进程**（\`electron/side-effect-executor.cjs\` + \`side-effect-executor-bundle.cjs\`）。

- \`acquireLease\` / claim \`LEASED → RUNNING\` / 真实 \`ResourceService.delete\` / 真实 Domain verification 全部在 executor runtime 内；
- 主进程只做 plan / approve / spawn / 读取收敛结果 / read-only recovery verification；
- 因此 mutation 真实归属于该 executor 的 lifetime。

## 3. Trusted Supervisor / Liveness proof

\`electron/runtime-supervisor.cjs\` 是**唯一**调用 \`registerRuntime / observeExit\` 的 production 代码：

- 同一 supervisor lifetime：真实 \`child.on("exit")\` → 自动 \`observeExit\`；
- cross-restart：executor 在自身生命周期内独占 bind \`<runtimeDir>/executors/<instanceId>.sock\`，
  新 supervisor 用 **OS-backed liveness probe** 判定（connect 成功 = 存活；ECONNREFUSED/ENOENT = 进程已不存在）。
  **不用内存中的旧 authority 自我证明。**
- \`observeExit / registerRuntime\` 不导出给 Renderer / IPC / ACP / Harness / Tool Facade；
  \`SideEffectAuthority.lifecycle\` 只拿到 \`{ isQuiesced }\`。

## 4. 两条写入路径

\`buildBridgeManifest\` 按 Registry riskClass 标注唯一 route：

| route | 流程 | 结果 |
|---|---|---|
| \`READ_ONLY\` | propose → reauthorize → executeReadOnly → verify | 真实只读执行 |
| \`SIDE_EFFECT_PROPOSAL\` | propose → decision → SideEffectPlan(AWAITING_APPROVAL) | 立即 \`SIDE_EFFECT_APPROVAL_REQUIRED\`；0 mutation / 0 lease / 0 execution |

\`buildWriteToolManifest\` 只接受 \`REVERSIBLE_WRITE\` + \`CONTROLLED_REVERSIBLE_WRITE\`。

## 5. Trusted Approval Gateway / UI

- \`sideeffect:command\` 唯一通道；Renderer 只能发 \`{ type, approvalRequestId, decision }\`；
- \`sessionRef\` 由 main process 注入；\`userId/role/appId/risk/planHash/argumentsHash/effectClass\` 自报一律忽略；
- \`src/approval/ApprovalPrompt.tsx\`：显示 App/Agent、Tool、Risk、Target、Expected Effect、Precondition version，
  只提供 批准 / 拒绝；字段全部来自 Tool Registry + SideEffectPlan + Resource Domain。

## 6. Harness 续接规则

只有**未经 UNKNOWN_EFFECT** 的 direct verified success 才把 safe result 交回同一个 dsh session；
一旦经过 UNKNOWN_EFFECT（含最终 APPLIED）→ \`recovered=true\` → Orchestrator 必须 BLOCK Step/Task。

## 7. 验证结果

| 入口 | 结果 |
|---|---|
| test:d4-03c4（node gate） | **35 / 35 PASS** |
| Approval UI probe | **22 / 22 PASS** |
| test:d4-03c3 | 56 / 56 PASS |
| test:d4-03c3-closure | 63 / 63 PASS |
| test:d4-03c2 | 29 / 29 PASS |
| test:d4-03c2-closure | 38 / 38 PASS |
| test:d4-03c2-closure2 | 45 / 45 PASS |
| test:d4-03c2-closure3 | 51 / 51 PASS |
| test:d4-03c1 | 48 / 48 PASS |
| test:d4-03c1-closure | 52 / 52 PASS |
| test:d4-03b | 59 / 59 PASS |
| test:d4-03a | 32 / 32 PASS |
| test:d4-02a / b / c | 22 / 16 / 22 PASS |
| test:d4-01 | 59 / 59 PASS |
| npm test | **835 / 835 PASS** |
| npm run build | PASS |
| test:security | FAIL 0 / PARTIAL 2 / PASS 6（无新增） |

official dsh WRITE E2E artifact（\`artifacts/d4-03c4/write-e2e-stats.json\`）：

\`\`\`
officialDsh=true acpV1=true
advertisedTools=[resource_read_metadata, resource_search, resource_trash]
modelRequests=3 hiddenRetryCount=0
writeToolCalls=1 sideEffectProposals=1 plans=1 approvals=1 leases=1
domainInvocations=1 businessMutations=1 verifications=1
taskFinalState=SUCCEEDED stepFinalState=SUCCEEDED sideEffectCallFinalState=SUCCEEDED
autoRetry=0
\`\`\`

## 8. 关闭的缺口

- \`Final Approval UI = IMPLEMENTED / VERIFIED\`（真实 Electron probe 22/22）。
- \`official dsh WRITE waiting/approval E2E = VERIFIED\`（happy / deny / timeout / UNKNOWN_EFFECT / APPLIED recovery）。

## 9. 仍挂账（不因本轮关闭）

OS-level network sandbox NOT VERIFIED；external workspace read audit NOT VERIFIED；
independent malformed ACP injection NOT VERIFIED；Windows NOT VERIFIED；External Provider NOT VERIFIED；
Explicit Resume = DEFERRED；broader Domain verifiers NOT VERIFIED。

## 10. 边界

WRITE surface 仍只有 \`resource.trash\`；\`AUTO_RETRY = 0\`；
IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED / Shell / Terminal / filesystem generic mutation /
MCP / Browser automation / Device Agent / Canvas mutation / App Center mutation / Adobe control 全部 BLOCKED。
C4 PASS 不代表所有 side effects 已开放。
