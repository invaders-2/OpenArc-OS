# D4-03B Official dsh Closure Result

Task Status: **official dsh Tool 暴露 = PASS**；**official dsh 真实 tool_call 执行 E2E = PASS**（plugin execute → Tool Facade Bridge → ControlledToolProxy → Search/Resource Domain → safe result → dsh Tool Runtime → 续推理 → Artifact/Verification/Task SUCCEEDED）；**D4-03B overall = PASS**；**D4-03C = CONDITIONAL GO**。WRITE execution = 0 / MCP = 0 / Shell = 0 / Browser = 0。

## 1. Base
从 feature/d4-03-tool-proxy @ 7a44cd8（local HEAD == origin == 7a44cd8，working tree clean）继续；未 merge main。终点见第 36 节。

## 2. Tool Facade Bridge
新增 electron/tool-facade-bridge.cjs（OpenArcToolFacadeBridge）：只 listen 127.0.0.1:0（随机 loopback port），唯一路由 POST /tool-call；authenticate scoped capability → validate run binding → map facade tool name → ControlledToolProxy → safe result / cancel / dispose。Bridge **不**直接调用 ResourceService/SearchService，绝不持有第二份 Tool Authority。

## 3. Tool Capability
每次 run 独立 opaque token（前缀 **tpx_**，与 Model Proxy 的 **mpx_** 完全分离），绑定 userId/sessionRef/appId/taskId/stepId/runId/allowedTools/maxCalls/issuedAt/expiresAt/nonce/status。allowedTools = [resource.search, resource.read.metadata]。capability 只活 bridge 进程内存；只经 trusted child env（OPENARC_TOOL_FACADE_URL / OPENARC_TOOL_FACADE_CAPABILITY）与 Authorization: Bearer 传递。

## 4. Capability Domain Isolation
Model capability（mpx_）打到 Tool Facade → 401 TOOL_CAPABILITY_UNAUTHORIZED；Tool capability（tpx_）打到 Model Proxy → 401 PROXY_UNAUTHORIZED；bridge A 的 token 在 bridge B → 401。跨域 0 proposal / 0 Domain call。

## 5. Managed dsh Profile
每个 run 在 disposable DSH_HOME 下生成隔离 profile openarc-acp：bundles = [@deepseek-ai/dsh-base, @deepseek-ai/dsh-acp-app, dsh-openarc-read-tools]；bundle 复制进 profile/node_modules；profile patch 为空；模型路由走 --patch（OpenArc Model Proxy）。真实 ~/.dsh 未被触碰。

## 6. Harness-visible Tools
boot 后 official dsh 模型侧恰好看到 2 个 OpenArc tool：resource_search / resource_read_metadata；模型请求中的 tools 列表实测只有这两个（无 run_code / shell / terminal / filesystem / write / web / MCP / process / exit_plan_mode）。bundle patch 禁用了全部生产工具插件与 plan-mode。

## 7. Real Search Tool Call
official dsh 真实 model turn 1 产生 tool_call resource_search（query=OPENARC_DSH_VISIBLE_RESOURCE, limit=5）；dsh Tool Runtime 调用 plugin.execute() → Tool Facade Bridge → ControlledToolProxy.propose/executeReadOnly → SearchService.search exactly 1 次。

## 8. Search Result → dsh
Bridge 返回 safe result；plugin execute() 返回给 dsh；dsh 把它作为真实 tool result 交给下一轮 model。ACP session/update 实测类型：tool_call、tool_call_update、agent_message_chunk、usage_update（未发明事件名）。

## 9. Real Metadata Tool Call
model turn 2 从真实 search tool result 里读到 resourceRef，产生 tool_call resource_read_metadata；dsh Tool Runtime → Bridge → ControlledToolProxy → ResourceService.get exactly 1 次。

## 10. Metadata Result → dsh
safe metadata（resourceRef/name/resourceType/mimeType/version/updatedAt…）经 plugin execute() 回到 dsh Tool Runtime，再进入 model context（provider 请求 3 的 messages 里可见该 tool result）。

## 11. Harness Continuation
dsh 在同一 ACP session/prompt 内继续 model loop；turn 3 model 返回最终文本 OPENARC_DSH_TOOL_OK。tool result 不再由 OpenArc 拼成新的 ACP prompt（这是与上一轮 synthetic 路径的本质区别）。

## 12. Task Artifact
最终 official dsh 答案持久化为 TaskArtifact（content = OPENARC_DSH_TOOL_OK，checksum sha256），TaskEvent artifact.created。

## 13. Verification
EXACT_TEXT 校验 PASS（verification.completed PASS）。只有 artifact 持久 + verification PASS 才 step/task SUCCEEDED。

## 14. Task Completion
Step SUCCEEDED + Task SUCCEEDED + harness.run.succeeded；真实 model 请求 = 3（无 hidden retry），provider 无额外调用。

## 15. Hidden Resource
alice 搜 admin 的 HIDDEN resource → 0 items / count 0，tool result 不含 HIDDEN 名称，无法知道其存在。official dsh 主链已 PASS；该隐私 probe 在 Tool Facade 层（同一 ControlledToolProxy + SearchService 授权路径）验证。

## 16. useByAgent
alice 有 resource.read 但无 resource.useByAgent → resource_read_metadata DENY（TOOL_FORBIDDEN / TOOL_AGENT_USE_NOT_AUTHORIZED）+ 0 Domain call + 0 execution。Facade 层验证。

## 17. Session Revocation
Tool 1 成功后 logout(sessionRef) → Tool 2 DENY + 0 Domain call。

## 18. App Disable
Tool 1 成功后 app disable → Tool 2 DENY + 0 Domain call。

## 19. Permission Revocation
Tool 1 成功后 revoke tool grant → Tool 2 DENY + 0 Domain call。

## 20. Resource Delete Race
search 返回 ResourceRef 后删除 resource → metadata 返回 RESOURCE_NOT_AVAILABLE，绝不返回 stale metadata。

## 21. Task Cancel
Tool 执行中 cancelTask → Tool execution BLOCKED / TASK_CANCELLED，不返回数据；Task CANCELLED 后再尝试 Tool → DENY + 0 Domain call。

## 22. Harness Crash
tool chain 中 kill dsh → Task BLOCKED，Step BLOCKED，run BLOCKED，Tool capability REVOKED / bridge stopped，0 respawn、0 replay（harness_runs 仍为 1）。

## 23. Timeout
Bridge / ControlledToolProxy bounded timeout；超时 → TOOL_TIMEOUT，execution FAILED，0 retry，返回安全 error。

## 24. Duplicate Tool Call
同一 runId + toolCallId 重复送达 → 返回同一 safe outcome，只 1 次 proposal / execution / Domain call。

## 25. Mutation Boundary
2-tool E2E 前后 Resource version / updated_at / checksum / resource_registry 计数不变；只新增 TaskEvent / proposal / decision / execution / verification / artifact / audit。

## 26. Secret Scan
Tool DB / TaskEvent / Audit / Artifact / Verification / Harness stderr / ACP updates / DSH_HOME / profile / manifest 扫描：Provider Secret 0 hit、mpx_ 0 hit、tpx_ 0 forbidden persistence、绝对路径/store root 0 hit。

## 27. Lifecycle
每 run：start bridge → issue capability → run → revoke capability → stop bridge。5 次连续 run：0 orphan dsh（每 adapter processExited=true）、0 orphan listener（server=null / baseUrl=null）、0 capability leak（capabilities.size=0）、旧 port connection refused、5 个独立 DSH_HOME / session / model capability / tool capability。

## 28. Concurrency
2 个 Task 使用独立 dsh / DSH_HOME / model capability / tool capability / runId；跨 bridge token cross-use → 401。

## 29. D4-03B Regression
npm run test:d4-03b = **57/57 PASS**（原 36 + Closure 21：facade / e2e / security / cancel / lifecycle）。

## 30. D4-03A Regression
npm run test:d4-03a = 32/32 PASS。

## 31. D4-02 Regression
npm run test:d4-02c = 22/22 PASS；npm run test:d4-02b = 16/16 PASS；npm run test:d4-02a = 22/22 PASS。

## 32. D4-01 Regression
npm run test:d4-01 = 59/59 PASS。

## 33. Security
npm run test:security = FAIL 0 / PARTIAL 2 / PASS 6；npm test = PASS；npm run build = PASS。Renderer IPC 未新增（15/15）。

## 34. Tests
新增 tests/tool-dsh-e2e.test.mjs（official dsh 垂直 E2E）、tests/tool-dsh-security.test.mjs（capability/撤销/隐私/跨域/重复/contract stale）、tests/tool-dsh-cancel.test.mjs（cancel/timeout/crash）、tests/tool-dsh-lifecycle.test.mjs（cleanup/5-run/2-run isolation）；tests/tool-dsh-facade.test.mjs 保留。standard entry npm run test:d4-03b（57）与 npm run test:d4-03b-dsh。

## 35. Files Changed
见最终报告第 35 节的 git diff 真实输出。

## 36. Commits
见最终报告第 36 节。local HEAD == origin/feature/d4-03-tool-proxy；working tree clean；未 merge main。

## Remaining Gaps
OS-level network isolation（D1-05）、external workspace read audit、independent malformed ACP injection、Windows、External Provider real credentials、Explicit Resume DEFERRED 继续挂账，不因本 closure 关闭。D4-03C 才允许 REVERSIBLE_WRITE 与 approval/lease/idempotency/unknown-effect。
