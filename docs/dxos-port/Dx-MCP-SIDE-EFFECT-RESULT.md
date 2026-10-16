# D5-04 · MCP 外部工具接入既有 SideEffectAuthority（生产路径闭合）

工作区：/Users/wepingli/.openarc-worktrees/dxos-port-r1（CommonJS + node:sqlite，离线验收）
约束：DX OS 只读；不联网（仅 127.0.0.1 loopback）；不新增依赖；不改 CSP/tokens.css/既有界面；不 commit/push；
只跑自己的 `node --test`（未跑 npm build / npm test）。未新建第二套审批权威。

## 结论

1. MCP 外部工具现在是**既有 SideEffectAuthority** 的一个 provider（plan/execute/verify/recoveryVerify 四个方向），
   走的是同一套 approval / lease / claim / exactly-once / verify / audit，**没有**第二套审批或状态机。
   执行位显式登记为 IN_PROCESS（MCP 活连接只在 main 进程，受监督 executor 子进程没有这条连接）。
2. `main.cjs` 已把 provider 注册进既有 adapters 注册表，并注入真实审批端口
   `createSideEffectExecutionPort`：proposeWrite(plan) → 既有 `sideEffect/decideApproval` 命令作出 trusted 决定
   → 既有 lease/claim/verify 执行 → 结果回传。未批准 / 被拒 / 超时一律 0 传输。
3. C2 报的第 2 条（agent 工具循环 mcpAdapter 不带 taskId）：已把任务上下文逐调用透传下去；
   同时审批端口会从**真实 Task** 只读解析当前 RUNNING step + 最新 harness run（不新建、不伪造）。
4. 离线 loopback 端到端用**真实审批命令路径**（sideeffect:command → sideEffect/decideApproval）证明：
   提议 → 批准 → 真实 tools/call 到达 127.0.0.1 服务 → 回结果（恰好 1 次）；
   拒绝 / 超时 / 开关关一律 0 传输。

## ① 文件清单

新增：
- `electron/mcp-side-effect-provider.cjs` —— MCP → 既有 SideEffectAuthority 的 provider。
  · plan：只读；把一次 MCP 调用投影成 SideEffectPlan；参数摘要**只回字段名 + 类型/长度**（绝不回值）；
    原始 args 绑定到进程内存 bindRef，bindRef 随 plan 持久化（preconditions.targetRef）。
  · execute：只在 authority claim 之后调用真实 transport（活连接）发 tools/call；argsDigest 与批准计划逐字节比对；
    失败结构化（确定没发出去 = knownNoEffect → FAILED；已发出但不可知 = ambiguous → UNKNOWN_EFFECT）。
  · verify：外部副作用唯一可用证据 = 服务端对这次批准请求的成功应答（argsDigest + responseDigest），
    明确标注为 EXTERNAL_ACKNOWLEDGED，不冒充 READ_AFTER_WRITE。
  · recoveryVerify：外部状态不可观测 → INDETERMINATE（UNKNOWN_EFFECT 不自动收敛、不 retry）。
- `tests/dxos-mcp-side-effect-loopback.test.mjs` —— 离线端到端（本机 loopback + 真实审批命令路径）。

修改：
- `electron/side-effect-domain.cjs` —— 新增 `EXECUTION_POLICY.CONTROLLED_EXTERNAL_EFFECT` 与
  `executionPolicyForEffectClass`；eligibility 的 effect-class 硬门改为"存在受控 policy 的 class"才放行
  （REVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT；IRREVERSIBLE / PRIVILEGED 仍 BLOCKED）。
- `electron/side-effect-authority.cjs` —— plan / claim / execute 三处按 effectClass→executionPolicy 精确门禁；
  execute 时把持久化的 expectedEffects 交给 verifier。
- `electron/side-effect-runtime.cjs` —— IN_PROCESS 白名单加 `McpExternal`；safeToolResult 不再给外部 call
  凭空加 `trashed`；in-process / resolvePendingForStep 回传真实执行 result；审批快照对 mcp-tool 显示 server·tool。
- `electron/tool-adapters.cjs` —— adapterFor 支持动态 `allowsTool(toolId)` 谓词（MCP toolId 由目录派生，无法装配期写死）。
- `electron/tool-registry.cjs` —— CONTRACT_FIELDS 登记 `externalTarget`。
- `electron/mcp-tool-contract.cjs` —— MCP contract 显式声明
  `executionPolicy=CONTROLLED_EXTERNAL_EFFECT / idempotencySupport=true / verificationStrategy=EXTERNAL_ACKNOWLEDGED /
  externalTarget={serverId,toolName}`。
- `electron/mcp-agent-tools.cjs` —— 新增 `createSideEffectExecutionPort`（真实审批链端口）与 step/run 只读解析；
  executed=true 时 callResolved 跳过第二次传输；executed 结果成败都结构化回传。
- `electron/main.cjs` —— 创建 provider 并挂到既有 `identity.adapters.providers.McpExternal`；
  审批端口换成 `createSideEffectExecutionPort`（不再需要 trustedApproval 桩）。
- `electron/agent-service.cjs` / `project-agent-mode.cjs` / `agent-react-driver.cjs` —— mcpAdapter 逐调用携带任务上下文。
- `tests/side-effect-c4-gates.test.mjs` —— in-process 白名单静态断言同步为三项（同等强度：单一声明 /
  只允许字符串字面量 / 只允许两处 .has / 不允许运行时改写）。

## ② 真实命令与真实输出

```
$ for f in side-effect-domain side-effect-authority side-effect-runtime tool-adapters tool-registry \
    mcp-tool-contract mcp-side-effect-provider mcp-agent-tools mcp-agent-bridge main \
    agent-service project-agent-mode agent-react-driver; do node --check electron/$f.cjs; done
ALL_SYNTAX_OK
```

验收（`tests/dxos-side-effect*.test.mjs` 在仓库中不存在；等价 glob 为 `tests/side-effect*.test.mjs`）：

```
$ node --test tests/dxos-mcp*.test.mjs tests/dxos-side-effect*.test.mjs tests/tool-gate-security.test.mjs \
    tests/task-harness-security.test.mjs tests/dxos-agent-ipc.test.mjs
EXIT=0    # tests 104 / pass 104 / fail 0   （未匹配的 glob 不报错）

$ node --test tests/dxos-mcp*.test.mjs tests/side-effect*.test.mjs tests/tool-gate-security.test.mjs \
    tests/task-harness-security.test.mjs tests/dxos-agent-ipc.test.mjs
EXIT=0    # tests 302 / pass 302 / fail 0
```

扩展（含被改动模块的既有回归）：
```
$ node --test tests/dxos-mcp*.test.mjs tests/side-effect*.test.mjs tests/tool-gate-security.test.mjs \
    tests/task-harness-security.test.mjs tests/dxos-agent-ipc.test.mjs tests/dxos-project-agent-mode.test.mjs \
    tests/dxos-agent-project-run.test.mjs tests/dxos-agent-react-driver.test.mjs \
    tests/d5-01-browser-inprocess-boundary.test.mjs tests/d5-02-canvas-edit-proposal.test.mjs tests/d5-03-mcp*.test.mjs
EXIT=0    # tests 405 / pass 405 / fail 0
```

loopback 端到端证据（测试内 console.log，服务端视角；只监听 127.0.0.1）：
```json
[mcp-side-effect-evidence] {"loopbackOrigin":"http://127.0.0.1:61737","observedOrigins":["http://127.0.0.1:61737"],
 "serverByMethod":{"initialize":1,"notifications/initialized":1,"tools/list":1,"tools/call":1},
 "toolsCalls":[{"name":"loop_echo","arguments":{"a":1,"b":2,"text":"SECRET_VALUE_SHOULD_NOT_PERSIST"}}],
 "taskId":"task_xX-5FHtZ-X5-zg","toolId":"mcp.mcp.hhxk2rjcfqvjyg.loop.echo",
 "callId":"scall_TWnD_yhw5VW0cQ","callStatus":"SUCCEEDED","verificationStatus":"PASS",
 "expectedEffects":[{"action":"tools/call","serverRef":"mcp_hHxk2rJcfQVjYg","toolRef":"loop_echo",
   "argsDigest":"c3d6824109e5f71566502e16e3fd536886cacef8d2bf3c642ae1a57bdb3387a1",
   "argsSummary":"a(number), b(number), text(string:31)"}]}
```

"生产路径真的走既有权威"的取证（同一测试内断言）：
- `side_effect_calls` 行：`effectClass=EXTERNAL_SIDE_EFFECT`、`toolId=mcpToolIdFor(connectionId,"loop_echo")`、
  `status=SUCCEEDED`、`verificationStatus=PASS`、终态无 ACTIVE lease；`tool_executions` 0 行（不产生第二套权威）。
- `authorization_audit` 依次出现既有权威动作：`side_effect.planned` / `side_effect.approved` /
  `side_effect.execution_placement`(decision=IN_PROCESS, reason=PROCESS_LOCAL_DOMAIN) /
  `side_effect.execution_started` / `side_effect.verification_passed` / `side_effect.succeeded`。
- 审批走**真实命令**：`sideeffect:command` handler（`registerSideEffectIpc`）→ `sideEffect/decideApproval`
  → `SideEffectRuntime.decideApproval` → `SideEffectAuthority.approveSideEffect`；未注入 trustedApproval 桩。
- 审批快照（既有 `listPendingApprovals`/`approvalSnapshot` 通道）能看到这条 MCP 调用：
  `toolDisplayName="MCP ..."`、`targetDisplayName="MCP <connectionId> · loop_echo"`、`riskClass=EXTERNAL_SIDE_EFFECT`，
  且不含原始参数值。
- 拒绝 / 超时 / 开关关：loopback `tools/call` 计数为 0；全程 `observedOrigins` 只有 loopback。

## ③ 未完成 / 未验证项（如实上报）

1. **未跑真机 Electron**：本轮只跑离线 `node --test`（硬约束）。E2E 用**进程内等价装配**
   （同一个 SideEffectAuthority / SideEffectRuntime / 真实 IPC handler 形状），未覆盖
   "真实渲染层按钮 → `ipcRenderer.invoke('sideeffect:command')`" 这一段 UI 传输。
2. **agent 工具循环（project-agent-mode / react-driver）仍无法真正执行 MCP**：
   这两条路径的 `taskId` 是 `dx_tasks`（agent task），而既有审批链定位的是 Task Runtime 的 `tasks` 表，
   两者没有映射。任务上下文现已逐调用透传（不再是 `{}` → `AGENT_DEPENDENCY_UNAVAILABLE`），
   但会收敛为既有权威的结构化拒绝（`INVALID_INPUT` / TASK_NOT_FOUND），0 传输。
   要真正闭合，需要让 agent 工具循环运行在**真实 Task Runtime 任务**里（或建立 agent task → Task Runtime task
   的既有语义映射）——那会新建任务/映射，超出本次"不新建第二套"的范围。
3. **in-task 路径（`mcp/toolInvocation/call`）**：现在按真实 Task 的 RUNNING step + 最新 harness run 完成
   提议→审批→执行→回结果。若调用时该任务没有 RUNNING step/run，审批通过后会在既有 eligibility 处
   fail closed（0 传输），不会伪造绑定。
4. **UNKNOWN_EFFECT 恢复**：外部 MCP 副作用的 `recoveryVerify` 只能回 INDETERMINATE
   （本仓无法独立观测外部系统状态），因此崩溃后的 UNKNOWN_EFFECT 会保持 UNKNOWN_EFFECT + Task BLOCKED，
   需人工处理。这是有意的 fail closed，不是遗漏。
