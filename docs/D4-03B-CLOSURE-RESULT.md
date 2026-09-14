# D4-03B Official dsh Closure Result

Task Status: **official dsh Tool 暴露路径 = PASS**（managed openarc-acp profile 通过 official bundle 加载 OpenArc Tool Plugin，注册 exactly 2 个 manifest 驱动 READ_ONLY tool）；**D4-03B overall = PARTIAL**（Tool Facade 执行 E2E 未完成，见第 34 节）；**D4-03 overall = PARTIAL**；**D4-03C = BLOCK**。

## 1. Base
从 feature/d4-03-tool-proxy @ 7ab8fbe（local HEAD == origin == 7ab8fbe，working tree clean）继续；未 merge main。终点见第 32 节。

## 2. Pinned Harness Audit
审计本地 frozen @deepseek-ai/dsh@0.1.5-rc.2（不照网页文档）：tool 注册 API = ctx.tools.register(definition) + defineTool；plugin shape = { name, inject, apply, Config }（ESM，loader unwrapExports）；profile = $DSH_HOME/profiles/<name> 的 package.json（dsh.profile.bundles + dependencies）+ cordis.patch.yml；bundle = 声明 dsh.bundle.patch 的 npm 包；module 解析 = dsh 安装优先、其次 profile 目录（profile/node_modules 优先）；patch 语法 = id 覆盖/disable + insert 列表；ACP profile bundle = dsh-base + dsh-acp-app。

## 3. Official Plugin Extension
不使用 fork、不使用 monkey patch、不使用社区 ACP adapter、不打开 shell/filesystem/web/MCP。新增 OpenArc-managed bundle electron/dsh-openarc-read-tools/（package.json + index.js + cordis.patch.yml），通过 official profile bundle 加载。

## 4. Managed ACP Profile
每次 run 在 disposable DSH_HOME 下生成隔离 profile openarc-acp：bundles = [@deepseek-ai/dsh-base, @deepseek-ai/dsh-acp-app, dsh-openarc-read-tools]；bundle 复制进 profile/node_modules；cordis.patch.yml 为空。未污染默认 acp profile。未碰真实 ~/.dsh。

## 5. Tool Manifest
bundle 的 patch 用 insert 加入 openarc-read-tools 入口，config 从 env 读 OPENARC_TOOL_FACADE_MANIFEST / OPENARC_TOOL_FACADE_URL / OPENARC_TOOL_FACADE_CAPABILITY。plugin 启动时读取 manifest（只读），按 manifest 逐条注册 tool。manifest 只含安全 schema metadata。

## 6. Harness-visible Tools
实测（--dump-default-config + boot stderr）：openarc-read-tools 入口成功插入根条目；plugin apply 输出 [openarc-read-tools] registered resource_search,resource_read_metadata，即 official dsh 模型侧恰好看到 2 个 OpenArc READ_ONLY tool。

## 7. Tool Facade Architecture
plugin execute() 只做：serialize {toolId, args} → POST 127.0.0.1 Tool Facade /tool-call（Bearer capability）→ 等待安全 result → 返回。plugin **不** import ResourceService/SearchService/DB/fs 业务/child_process（静态断言）；业务执行权威仍是 ControlledToolProxy。

## 8. Tool Facade Capability
设计：每次 run 独立 capability，绑定 user/session/app/taskId/stepId/runId + allowedTools(resource.search, resource.read.metadata) + maxCalls + expiry + nonce；与 Model Proxy capability 独立 domain。**本轮未实现 Bridge 服务本身**（见第 34 节），仅冻结设计并完成 plugin/暴露侧。

## 9. Credential Isolation
plugin 只经 env 拿 facade URL/capability；capability 不写 DSH_HOME/profile/Task DB/Event/Audit/Artifact/logs。Provider Secret 继续 0。

## 10. Search Tool
Harness-visible schema resource_search 由 manifest 直接取自 OpenArc Registry 的 resource.search（READ_ONLY）。真实 ControlledToolProxy → SearchService.search 的执行在 D4-03B（synthetic ACP）已验证；official dsh 触发的执行链路本轮未完成。

## 11. Metadata Tool
Harness-visible schema resource_read_metadata 取自 Registry 的 resource.read.metadata（READ_ONLY）。

## 12. Real official dsh Tool Calls
**NOT VERIFIED**。official dsh 已能注册并暴露这两个 tool，但尚未在本轮用真实 model tool_call 驱动 official dsh 执行它们（缺 Facade Bridge + provider tool-call loop）。

## 13. Tool Results → dsh
**NOT VERIFIED**（同上）。

## 14. Harness Continuation
**NOT VERIFIED**（同上）。

## 15. Task Artifact / Verification
official dsh 工具链驱动的 Task SUCCEEDED **NOT VERIFIED**。D4-03B（synthetic ACP）已 PASS：Artifact OPENARC_TASK_OK + Verification PASS + Task SUCCEEDED。

## 16. Hidden Resource
D4-03B（synthetic ACP）已验证 search 隐私 0 leak；official dsh 路径 **NOT VERIFIED**。

## 17. useByAgent
D4-03B（synthetic ACP）已验证 proposal/execution 双路径 useByAgent；official dsh 路径 **NOT VERIFIED**。

## 18. Reauthorization
ControlledToolProxy.executeReadOnly 的 reauthorize-before-execute 已 PASS；Tool Facade 将复用同一条路径（设计冻结）。

## 19. Capability Isolation
设计冻结（wrong-run/expiry/maxCalls）；Bridge 未实现 → **NOT VERIFIED**。

## 20. Cancel
D4-03B cancel/abort race 已 PASS；official dsh 中途 cancel **NOT VERIFIED**。

## 21. Duplicate Execution
D4-03B UNIQUE(proposal_id) 幂等已 PASS。

## 22. Mutation Boundary
D4-03B READ_ONLY 0 mutation 已 PASS；official dsh 路径 **NOT VERIFIED**。

## 23. Secret Scan
bundle/plugin 不含 credential/capability；D4-03B 全量扫描 PASS。official dsh 路径 **NOT VERIFIED**。

## 24. DSH_HOME / Profile Scan
本轮 boot 用 disposable DSH_HOME；profile 只含 package.json/cordis.patch.yml/node_modules(plugin 副本)，无完整 bearer 持久化。

## 25. D4-03B Regression
npm run test:d4-03b = **36/36 PASS**（新增 tool-dsh-facade 3 项：official dsh 注册 exactly 2 tool / plugin 无业务 import / 空 manifest 0 tool）。

## 26. D4-03A Regression
npm run test:d4-03a = **32/32 PASS**。

## 27. D4-02 Regression
npm run test:d4-02c = **22/22 PASS**；npm run test:d4-02b = **16/16 PASS**；npm run test:d4-02a = **22/22 PASS**。

## 28. D4-01 Regression
npm run test:d4-01 = **59/59 PASS**。

## 29. Security
npm run test:security = **FAIL 0 / PARTIAL 2 / PASS 6**；npm test = **650/650 PASS**；npm run build = **PASS**。

## 30. Tests
新增 tests/tool-dsh-facade.test.mjs（3）；standard entry npm run test:d4-03b（36）与 npm run test:d4-03b-dsh。

## 31. Files Changed
git diff --name-only 7ab8fbe...HEAD 真实输出：electron/dsh-openarc-read-tools/cordis.patch.yml、electron/dsh-openarc-read-tools/index.js、electron/dsh-openarc-read-tools/package.json、experiments/d4-03b/run-all.mjs、package.json、tests/tool-dsh-facade.test.mjs。
文档：docs/D4-03B-CLOSURE-RESULT.md、docs/D4-03B-RESULT.md、docs/decisions/D4-03B-readonly-execution.md、PROGRESS.md。

## 32. Commits
- d3edd4b D4-03: add official dsh read-only tool facade
- docs(D4-03): close read-only execution gate（本文件所在提交）
local HEAD == origin/feature/d4-03-tool-proxy；working tree clean；未 merge main。

## 33. Evidence
| 入口 | 结果 |
|---|---|
| official dsh binary | 0.1.5-rc.2 PASS |
| official ACP v1 | PASS |
| managed openarc-acp profile 加载 | PASS（insert 入口 + bundle 解析） |
| official dsh 注册 OpenArc tools | exactly 2：resource_search,resource_read_metadata |
| shell/filesystem/web/MCP/run_code/工具包 | 全部 disabled（patch 层） |
| plugin 无业务 import | PASS |
| 空 manifest | 0 tool registered（不伪造） |
| npm run test:d4-03b | 36 / 36 PASS |
| npm test | 650 / 650 PASS |
| npm run build | PASS |
| npm run test:security | FAIL 0 / PARTIAL 2 / PASS 6 |
| official dsh 真实 tool_call 执行 E2E | **NOT VERIFIED** |

## 34. Remaining Gaps
**Official dsh Tool 暴露（plugin + profile + manifest + 2 tools）= VERIFIED。** 未完成的唯一缺口：Tool Facade Bridge 服务（capability 校验 + 调 ControlledToolProxy）、provider 真实 tool-call loop（turn1 search / turn2 metadata / turn3 final）、以及 official dsh 驱动的 Artifact/Verification/Task SUCCEEDED E2E。该缺口是纯实现进度，不是接口不可用（§61 的 OFFICIAL_DSH_CONTROLLED_TOOL_EXTENSION_UNAVAILABLE 不成立）。其余 D4-03B 遗留（OS-level network isolation / external workspace read audit / malformed ACP injection / Windows / External Provider / Explicit Resume）继续挂账。

## 35. D4-03B Final Gate
official dsh binary / ACP / 工具暴露 / 2-tool allowlist / 禁止工具全关：PASS。真实 tool_call 执行 → 结果回 dsh → 续推理 → Artifact/Verification/Task SUCCEEDED：**NOT VERIFIED**。因此 **D4-03B overall = PARTIAL**（执行引擎与 official 暴露均 PASS，官方 dsh 执行闭环未完成）。未假 PASS。

## 36. D4-03C Admission
**D4-03C = BLOCK**。开启前提：completed official dsh Tool Facade 执行 E2E（或由人工接受该边界）。D4-03C 才允许第一次 REVERSIBLE_WRITE 及 approval/lease/idempotency/unknown-effect。本轮未进入 D4-03C / WRITE execution / MCP / Shell / Browser / Canvas / App Center。
