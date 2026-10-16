# Dx-B4e 收口 · MCP 工具调用"生产真的可用"（默认关闭 + 必须审批）

日期：本轮
工作区：/Users/wepingli/.openarc-worktrees/dxos-port-r1（CommonJS + node:sqlite，离线验收）

## 结论

MCP 工具调用不再"只在注入假 transport 的测试对象上被证明"：

1. **真实传输**：`electron/mcp-live-transport.cjs` 把 McpService 的**活连接**（`mcpService.live`）投影成
   transport 端口，由 `main.cjs` 注入 bridge；`electron/mcp-client.cjs:856` 的 `callTool()` 从"一律拒绝"
   改为"**显式开关开启 + 审批凭证 ALLOWED**"双条件才发真实 `tools/call`，任一条件不满足仍同步返回既有
   `MCP_TOOL_INVOCATION_NOT_ENABLED`（形状逐字不变）。
2. **审批链走任务**：新命令 `mcp/toolInvocation/call`（`electron/mcp-bootstrap.cjs:305`）用**真实 Task** 的
   taskId/appId（session 归属 + Task row 校验，渲染层自报无效）逐调用驱动
   `ControlledToolProxy.propose({ taskId, toolId: mcpToolIdFor(...), arguments })`
   （`createTaskApprovalPort`，`mcp-agent-tools.cjs:451`）。未审批 → `APPROVAL_REQUIRED`（0 传输）；
   拒绝 → `APPROVAL_DENIED`；超时 → `APPROVAL_TIMEOUT`；均 0 传输。
3. **开关 IPC**：`mcp/toolInvocation/set`（`mcp-bootstrap.cjs:282`）—— trusted + `mcp.manage` 授权 + 审计，
   落 `<userData>/dxos/mcp.json`；审计端口缺失 → `MCP_AUDIT_UNAVAILABLE` 且**不写**；`mcp/agentTools`
   的 `enabled` 字段沿用，实时反映开关。

## ① 文件清单

新增：
- `electron/mcp-live-transport.cjs` —— 生产真实 transport（活连接 → tools/call）
- `tests/fixtures/mcp/loopback-tool-server.mjs` —— 本机 loopback MCP 服务（只监听 127.0.0.1，实现 tools/call）
- `tests/dxos-mcp-live-loopback.test.mjs` —— 端到端（真实开关/真实连接/真实传输/真实 Task+Proxy）

修改：
- `electron/mcp-client.cjs` —— `invocationGate` + 双条件 `callTool`（真实 JSON-RPC tools/call）
- `electron/mcp-agent-tools.cjs` —— taskId 逐调用透传、审批凭证签发、`createTaskApprovalPort`、TIMEOUT 码
- `electron/mcp-agent-bridge.cjs` —— 可选 taskId 的审批端口 + `trustedApproval` 注入位
- `electron/mcp-bootstrap.cjs` —— 两条新白名单命令 + 审计 + 任务内调用处理 + `createMcpBundle` 注入 gate
- `electron/mcp-service.cjs` —— `authorizeManage()`（risk=mcp.manage）
- `electron/runtime-boot.cjs` / `electron/identity-bootstrap.cjs` —— 把开关实例透传到每个真实 `McpClient`
- `electron/main.cjs` —— 开关先建、真实 transport + 审批端口注入 bridge、审计/任务上下文/调用端口接线
- `tests/d5-03-mcp-boundary.test.mjs`（C1）与 `tests/d5-03-mcp-connection.test.mjs`（A1 白名单期望值）——
  旧断言"客户端没有调用路径 / 白名单 11 条"已被本批产品变更取代，改为同等强度的新边界断言。

## ② 真实命令与真实输出

```
$ node --test tests/dxos-mcp*.test.mjs tests/tool-gate-security.test.mjs tests/task-harness-security.test.mjs
# tests 92
# suites 9
# pass 92
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5821.444459
```

```
$ node --test tests/d5-03-mcp*.test.mjs
# tests 69
# pass 69
# fail 0
```

```
$ node --test tests/dxos-mcp-live-loopback.test.mjs
ok 1 - 端到端（本机 loopback 真实传输）：开关关 → NOT_ENABLED；开+未审批 → APPROVAL_REQUIRED；审批通过 → 真实 tools/call；拒绝/超时 → 0 传输
ok 2 - mcp-client 双条件门：未注入开关 / 未带审批凭证 → 既有 NOT_ENABLED；注入开关 + ALLOWED 凭证才放行
ok 3 - mcp/toolInvocation/set：trusted + mcp.manage + 审计，落 mcp.json；未授权/无审计端口结构化拒绝
ok 4 - mcp/toolInvocation/call：缺 taskId / 任务上下文解析失败 → 结构化拒绝；未注入端口 → 结构化不可用
# tests 4
# pass 4
# fail 0
```

loopback 端到端证据（测试内 console.log，服务端视角）：

```json
[loopback-evidence] {"loopbackOrigin":"http://127.0.0.1:51778","observedOrigins":["http://127.0.0.1:51778"],"serverByMethod":{"initialize":1,"notifications/initialized":1,"tools/list":1,"tools/call":1},"toolsCalls":[{"name":"loop_echo","arguments":{"a":1,"b":2}}],"taskId":"task_DexxFv0Z0xvyVw","controlledProxyToolId":"mcp.mcp.z02zrhjmnhhypg.loop.echo"}
```

- `observedOrigins` 只有 loopback；guarded fetch 对任何非 127.0.0.1 请求直接 reject。
- `tools/call` 只在"审批通过"后出现 1 次；开关关 / 未审批 / 拒绝 / 超时四种情形均为 0 次（测试断言）。
- `controlledProxyToolId` 即 `mcpToolIdFor(connectionId, "loop_echo")`：propose 用真实 Registry 合同。

源码 + 语法：
```
$ node --check electron/{mcp-client,mcp-live-transport,mcp-agent-tools,mcp-agent-bridge,mcp-bootstrap,mcp-service,runtime-boot,identity-bootstrap,main}.cjs
ALL_SYNTAX_OK
```

## ③ 未完成 / 未验证项（如实上报）

1. **生产尚未注入 trustedApproval（唯一未闭合项）**：MCP 工具是 `EXTERNAL_SIDE_EFFECT`（requiresApproval=true），
   `ControlledToolProxy.propose` 必然收敛为 `APPROVAL_REQUIRED`，且该代理**没有** approve/execute 方法。
   真正能"批准并执行"的既有权威是 SideEffectAuthority，但 MCP 工具还不是它的可 plan/execute provider
   （缺 `McpExternal` adapter 与 in-process 执行位），因此 `main.cjs` 目前不注入 `trustedApproval`：
   生产路径会停在"等待可信用户审批"（0 传输，fail closed），而不是自动放行。
   端到端"审批通过 → 真实 tools/call"由测试注入的可信决定端口证明（`createTaskApprovalPort` 的
   `trustedApproval` 是可复用同一条既有审批 UI 的注入位；不新建第二套审批权威）。
   闭合它需要在 side-effect authority 里把 MCP 接成可执行 provider（下一批）。
2. **agent 工具循环（dsh / mcpAdapter）仍未携带 taskId**：`agent-service.cjs:408-409` 的 mcpAdapter 传 `{}`，
   因此该路径的 MCP 调用在开关开启时会 fail closed 成 `AGENT_DEPENDENCY_UNAVAILABLE`（缺 taskId）。
   任务内调用入口本次走的是新 IPC 命令 `mcp/toolInvocation/call`。
3. **未跑真机 Electron**：本轮只跑离线 `node --test`（硬约束：不跑 npm build/test、不改界面、不联网）。
   main.cjs 的接线经 `node --check`，未在真实 Electron 窗口内启动验证（开关 IPC 的 UI 侧入口也未新增——
   "不改既有界面"约束下本次不交付 UI 控件）。
4. `tests/d5-03-mcp-boundary.test.mjs` C1 被修改：它原断言"客户端源码不得出现 tools/call 字面量"，
   与本批"实现真实 tools/call"直接冲突；已改为断言"默认关闭 + 双条件门 + 5 个旧命令仍拒绝"。
