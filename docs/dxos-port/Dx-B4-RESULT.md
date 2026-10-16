# Dx-B4-RESULT · B4（技能 + MCP + 本地账号）+ 测试报告

> 依据：本轮任务「继续」= 按 §5 推进 B4。分支 `dxos-port/r1`，工作区 `/Users/wepingli/.openarc-worktrees/dxos-port-r1`。
> 起点 = `9e4f62c`（B3 收口）。真实命令与真实输出见下；未验证项显式标注 NOT VERIFIED。

## 1. 交付对照（任务 §5 B4）

| B4 要求 | 落点 | 状态 |
|---|---|---|
| 技能注册 / 启停 / 执行 / 导入导出 / 分析 | `skill-store.cjs`(863) + `skill-runner.cjs`(1896) + `skill-analyzer.cjs` + `skill-import.cjs` | ✅ |
| 内置技能 + 技能包 ZIP + 工作区 | 15 条内置技能逐字核对（`skills.ts:135-438`，0 mismatch）、`skill-pack.cjs`(1001)、`skill-workspace.cjs` | ✅ |
| 项目 Agent 模式 | `project-agent-mode.cjs` + `agent/project/run`（IPC 已接） | ✅ |
| MCP：stdio + Streamable HTTP 客户端、工具聚合与调用、接入审批链 | 客户端沿用既有 `mcp-*.cjs`（stdio+HTTP+SSE）；新增 `mcp-agent-tools.cjs`(783) 聚合与调用 + `mcp-agent-bridge.cjs` 生产装配；调用一律**先审批后传输**（fail-closed） | ✅（远端调用受产品边界约束，见 §6） |
| 本地账号：用户/部门/角色/APP 访问/审计/会话 | `local-account-service.cjs`(980) 映射既有 `users/departments/department_memberships/app_resource_grants/audit_log/authorization_audit`；identity 域新增 14 条命令 | ✅ |
| IPC | `skill:command`(15 条) + `skill:event`、identity 域扩展、preload 第 19 个顶层键 | ✅ |

规模：实现 **8,148 行** + 测试 **4,627 行 / 187 例**（skill-store 18、skill-pack 12、skill-runner 44、analyzer+workspace 20、project-agent 9、skill IPC 10、MCP 47、本地账号 12、本地账号 IPC 8、providerAdapter 7），收口波再增 `mcp-agent-bridge` 7 例与 `agent/project/run` 6 例。

## 2. 架构决策与本地化处置

1. **不建第二套账号体系**：本地账号全部落到既有 6 张表（`users`/`departments`/`department_memberships`/`app_resource_grants`/`audit_log`/`authorization_audit`），无 `CREATE TABLE`。
2. **会员门禁按 OUT 去除**：源 `auth.ts` 的 `cloudEntitlement`/`currentSignedEntitlement`/`BASE_LOCAL_ACCOUNT_LIMIT`/`entitlementSuspended`/`requireDepartmentEntitlement`/`requireAdvancedAppPolicyEntitlement` 全部移除并逐条注明行号；本地不限账号数/部门数，**不伪造** `plan/planName/maxLocalAccounts`，对外仅标 `local:true`。
3. **云与商业化零引入**：`dxosProtocol`（云端 AI 任务）、`apiQuota`（计费）在技能域逐处删除并注明；验证岗对 6 类标识符做「非注释」过滤，**代码级命中 0**。
4. **技能配置沿用 JSON 文件**：`<userData>/dxos/skills.json`、`skill-packs/index.json`、`bundled-skill-packs.json`，不建表。
5. **providerAdapter 桥**：新增 `provider-adapter-bridge.cjs`，把 B2 的 provider store/service 投影成只读适配器（绝不返回 `api_key`），替换此前生产里的 `null`。
6. **MCP 默认边界不降级**：`mcp-client.cjs` 的 `tools/call` 仍是产品边界下的关闭状态，`mcp/callTool` 等 5 个命令仍回 `MCP_TOOL_INVOCATION_NOT_ENABLED`；本批交付的是"审批优先、可注入传输"的完整调用路径。**要默认打开需 (1) MCP 工具的 ToolRegistry contract、(2) 一次明确的产品决定** —— 未静默放开。
7. **在线安装 / docker 运行不暴露 IPC**：`importOnlineSkillPack`/`runSkillPack` 只经注入 runner，属有意离线收缩。

## 3. 真实命令与真实输出

```
$ npm run build                                              BUILD_EXIT=0
$ npm test                    （独占）
1..1945
# tests 1945 / # pass 1944 / # fail 1                       TEST_EXIT=1
唯一失败：not ok 337 - D5-03-E · ACP SDK 只认项目内那一份（worktree node_modules 符号链接的基线既有环境项）
基线对照：B2 1549/1548/1 → B3 1745/1741/4（负载敏感）→ B4 1945/1944/1

$ npm run test:model-ipc-ui   （真实 Electron，preload 19 键）
10/10 IPC checks passed                                      MODELIPC_EXIT=0

$ npm run test:design-system
5 个探针：PASS 4 / PARTIAL 1 / FAIL 0                         DS_EXIT=0

$ 逐文件复跑（B4 新增 + 收口）
skill-store 18 | skill-pack 12 | skill-runner 44 | skill-analyzer+workspace 20 | project-agent 9 |
skill-ipc 10 | mcp-agent-tools 47 | local-account 12 | local-account-ipc 8 | provider-adapter 7 |
mcp-agent-bridge 7 | agent-project-run 6 | agent-ipc 9       全绿
```

## 4. 独立验证（只读，与移植岗分离）

- **结构对照**：`skills.ts`/`skillPacks.ts`/`skillImport.ts`/`skillAnalyzer.ts`/`agentWorkspaceSkills.ts`/`projectAgentMode.ts`/`mcp.ts`/`auth.ts` 的源 export 全部在 .cjs 侧有位（含跨文件拆分）；多余项均为注入 seam / 测试投影。
- **语义抽查 12 处**（源行号 vs 代码行号）：runSkill 分派、procedure 小循环（PROC_MAX_ROUNDS=12/CALLS=16）、generate_image 与 generate_video 参数构造、ZIP 危险路径拒绝（独立探针实测 `../evil.txt`、`/etc/passwd`、`C:/win.txt` 全拒）、skillAnalyzer 推断、projectAgentMode 一轮驱动（maxSteps=18/toolCalls=40/reviewAttempts<=2）、**MCP 先审批后传输**（DENIED/未注入/APPROVAL_REQUIRED 时 transport 调用=0，ALLOWED=1）、parseImport、本地账号审计写点、providerAdapter firstUsable 顺序（cap_sort→sort→created_ts）、trusted 边界。**未发现功能性偏差**。
- **约束**：受保护文件 B4 零改动；preload 顶层键恰好 19 且含 `agent`/`skill`、无裸 `ipcRenderer`；云/商业化代码级命中 0；B4 文件 0 处 `fetch/http/https/WebSocket`；无新增依赖；`skill:command`/`agent:command`/`identity:command` 的 trusted 边界真实存在。
- **运行**：B4 196 例 + 受影响既有 76 例 = **272 例全过，0 失败**；socket 级守护 **BLOCKED=0**。
- **验证发现并已收口（本轮内，不留到下一批）**：
  1. 【中】`createMcpAgentTools` 无生产调用方 → 新增 `mcp-agent-bridge.cjs` 并在 `main.cjs` 装配（catalog 的 mcp 来源从恒 `available:false` 变为如实反映已连接 server）；未连接/停用 server 只给 `executable:false`，不伪造 connected。
  2. 【中】`project-agent-mode.cjs` 无生产调用方 → 新增 `agent/project/run`（命令表 26→27）并接入真实适配器；经 IPC 真跑通"能力发现→fs_read→结果回填→完成验收"。
  3. 【真 bug】`project-agent-mode.cjs` 对 async `runTool` 漏 `await`（会把 Promise 当观察结果，模型只看到 `{}`）→ 已补并加测试。
- **低优先级差异（已登记，未改）**：providerAdapter `isUsable` 未探测 CLI 是否安装（实际会以依赖缺失失败，非静默成功）；`all()` 未等价 `allProviders()` 的 `applyModelOrders` 用户排序；本地账号审计丢失源 `detail/resourceId/ip`（`audit_log` 无对应列，已在映射表登记）。

## 5. 源事实勘误与映射损失（诚实登记）

1. **角色三值→两值**：源允许"无部门的 admin"，既有 `users.role` 两值 + 部门成员角色无法表达 → 该情形返回 `DXOS_ERR_INVALID_INPUT`（未伪造）。
2. **`resolveVisionTargets` 近似**：源依赖 `modelResolver`/`modelDescriptor`（不在 B4），改为按 `model.caps` + 注入 `imageLimit` 判定；缺上限时视为不限（=源 `maximum==null`）。
3. **`mcp` 描述符 parameters 为空对象 schema**：MCP 域落库只存 `inputSchemaSummary`，完整 inputSchema 不持久化 → 照实给空对象，不伪造参数。
4. **MCP 源无审批、本批新增审批门**：未注入审批时行为从"直接执行"变为"拒绝"（任务要求的安全增强）。
5. **随包技能包未入库**：源分发里的 `bundled-skill-packages/minimax-h3-skills.zip` **未复制进本仓**（不为对齐而搬运上游二进制内容）；移植支持随包目录 + 本地导入，打包阶段可用 `DX_BUNDLED_SKILL_PACKAGES_DIR` 指定。

## 6. 未验收 / NOT VERIFIED

1. **未启动真实 Electron**：`main.cjs`/`identity-bootstrap.cjs` 的 boot 只做 `node --check` + 离线装配验证（`test:model-ipc-ui` 覆盖 preload 键契约，不覆盖 skill/agent/identity 命令的真机投递）。
2. **agent/project/run 生产完整循环未通**：会停在首个 `fs_list`（B6 fsAdapter 未落地 → 结构化 `AGENT_DEPENDENCY_UNAVAILABLE`，不折成内部错误）。
3. **真实 model/cli/media adapter 在 main 中仍为 null/未装配**：技能生成媒体、CLI 执行的真实路径结构上不可用；未对真实 provider 端到端验证（外部凭据仍缺，沿用 B2/B3）。
4. **MCP 远端工具调用未打通**：产品边界关闭 + 无 ToolRegistry contract（见 §2.6）。
5. **14 个内置技能全量参数构造**只深核 2 个（generate_image/generate_video），其余靠 runner 44 例背书。
6. **UI 未做**：技能中心 / 账号管理 / MCP 中心的界面需要单独一份符合 §4 规范的 UI 任务计划。
7. **全量测试**：唯一失败是基线既有 `#337`；B3 曾出现的负载敏感超时在本轮独占运行中未复现（反证其为争用所致）。

## 7. 结论

B4 三域（技能 / MCP / 本地账号）**结构完整、12 处语义抽查无偏差、约束未降级、云与商业化零引入**；门禁：build ✅ / 全量测试 ✅（仅基线既有 #337）/ 真机 preload 探针 ✅ / design-system ✅。验证岗抓出的两条「已实现未接入」与一个 async 漏 `await` 的真 bug **已在本批内收口并加测试**。未验收项已逐条列明。B5（媒体 + 画布）可在本批基础上开始 —— 其中 fsAdapter（B6）与 mediaAdapter（B5）正是本批多处结构化拒绝的解锁点。
