# D4 · 真实产品入口 `electron/main.cjs` 端到端验证（Main-Entry E2E · Closure-5）

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`；分支：`feature/d4-03-tool-proxy`
- **本轮任务 Base HEAD**（开工核对，干净）：`ed5ab04bdfe5b1dd47de586c755b6d4fc40c7cca`
- **本轮代码/测试提交**：`4e8c6c155f7643ca2f3f3db792139dd1fcdc608c`（工具权限产品入口）、`81ced49c1e77b8fa0e60f08b47487a503a4fe733`（拒绝后假成功修复）、`396e14ca958ad6b5bba48a474a1dcfe8fa2d708f`（真实 main E2E 重写 + 移除播种 seam）
- **真实 main E2E 被测 commit**：`396e14ca958ad6b5bba48a474a1dcfe8fa2d708f`
- **报告与证据提交**：本文件 + `docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json` + `PROGRESS.md` + `docs/D4-ACCEPTANCE-RESULT.md` + `docs/D4-04/05-GATE-EVIDENCE.json`
- **结论：真实 main 缺口 = PARTIAL（不整体关闭）**：5 条必需流程中 4 条产品入口 PASS（含工具授权、撤权、明确拒绝、刷新一致性），**预算停止→UI 显式续接仍不可达（结构性）→ Gate PARTIAL 且退出码 1**。`D4` 整体不自动升级。

## 1. 本轮补齐的产品入口

| # | 变更 | commit | 说明 |
| --- | --- | --- | --- |
| 1 | App **TOOL-scope 权限**产品入口 | `4e8c6c1` | 治理服务新增 `getAppToolAccess`/`grantAppToolAccess`/`revokeAppToolAccess`（均先过 `#adminGate` 真实会话）；治理 IPC 白名单/路由新增三条命令；治理 UI App 权限区新增“工具权限”逐动作勾选（默认全不勾、无自动授权）。旧 `grantAppAccess` 对 `tool.*` 仍 `INVALID_INPUT`（入口分离）。 |
| 2 | **明确 WRITE 被拒不再假成功** | `81ced49` | `TaskService.getDeniedRequiredWriteOperations`（只统计 `decision=DENIED` 且 `risk_class` 非 READ_ONLY、且无同一 tool+canonical arguments 后续真实成功者）；orchestrator 在提交成功前拦截 → `#blockStep(reason=真实 reasonCode, event=tool.denied)`；`task/get` 暴露 `deniedOperations`；AI 面板渲染 `data-ai-denied`。**READ_ONLY 拒绝不参与**，普通 READ 错误语义不变。 |
| 3 | 真实 main E2E 重写 + 移除播种 | `396e14c` | `tests/d4-main-e2e.mjs` 改为**产品入口**驱动（治理 UI/产品桥授权、撤权、拒绝、刷新）；`electron/main.cjs` 删除 `OPENARC_E2E_SEED_TOOL_GRANTS` 播种块。 |

**产品侧 test seam 只剩一处**：`OPENARC_E2E_OBSERVE=1`（只读 boot 快照，默认关闭）。工具授权不再依赖任何播种。

## 2. 真实启动入口与隔离配置

- **入口**：仓库根 `electron/main.cjs`（package.json `main`），正常产品方式 `electron .` + 真实 preload + `dist/index.html` + 真实 IPC / runtime-boot / Model Proxy / Task Runtime / ControlledToolProxy / SideEffectRuntime。
- **命令**：`spawn(require("electron"), [".", "--user-data-dir=<mkdtemp 隔离目录>", "--remote-debugging-port=9788"], { cwd: <worktree>, env })` + `chromium.connectOverCDP` 驱动真实 Renderer。**不用 probe host、不用复制的 main、不用 `_electron.launch`**。
- **隔离/测试配置 vs 正常启动**：`--user-data-dir` 隔离；`OPENARC_IDENTITY_ADMIN=1`（首启 ADMIN，产品本身需要）；`OPENARC_E2E_OBSERVE=1`（唯一只读 boot 观测 seam）；本地确定性 provider（loopback）；显式删除 `OPENARC_E2E_SEED_TOOL_GRANTS`。状态只经只读 `node:sqlite` + executors 计数取得；不写库、不设终态、不替换 orchestrator。

## 3. boot 顺序（真实 main）

```json
{"identityCreated":true,"modelProxyStartAttempted":true,"modelProxyStarted":true,
 "modelProxyListening":true,"modelProxyErrorCode":null,
 "bootOrder":["identity_created","model_proxy_start_attempted","model_proxy_started","runtime_ready"]}
```
断言：严格有序、`modelProxyListening=true`、boot 观测早于首个 task。

## 4. 五条必需流程（expected / actual）

| 流程 | 结果 | actual 摘要 |
| --- | --- | --- |
| **1 管理员授权 → WRITE 审批 → 一次副作用 → 成功** | **PASS** | 真实治理 UI 授予 `tool.resource.search/readMetadata/trash`；真实 AI 任务 search→trash → 真实 Approve → Task/Step `SUCCEEDED`；`mutation=1`；SideEffectCall=1 `SUCCEEDED`/verification `PASS`；approval=1 `APPROVED`；lease=1 `RELEASED`；Artifact=1 + Verification=1 绑定且 checksum 正确；production executor 真实 spawn |
| **2 非管理员被拒；待批准时撤权 → 旧批准不能执行** | **PASS** | 真实 MEMBER `grantAppToolAccess` → `NOT_SUPER_ADMIN`；`revokeAppToolAccess changed=true`、`grantedActions=[]`、DB TOOL rows=0；旧批准 → Call `BLOCKED`/`SIDE_EFFECT_AUTHORIZATION_REVOKED`；0 mutation/0 新 lease/0 新 executor；Task/Step BLOCKED；Run 复位 |
| **3 无工具权限的明确 WRITE → 无副作用，不显示完成** | **PASS** | 只授 search/readMetadata（不授 trash）→ 真实 AI WRITE + finalText“完成” → **Task/Step BLOCKED**（不再假成功）；0 mutation、0 SideEffectCall、0 trash execution；`task/get.deniedOperations` 含 `resource.trash/TOOL_APP_NOT_GRANTED`；AI 面板 `data-ai-denied` 可见（“BLOCKED · Operation Denied”），无成功显示 |
| **4 正常任务 → 真实成果 → 预算停止 → UI 续接 → 后续完成** | **NOT_VERIFIED（必需项失败）** | 预算停止 = BLOCKED / `BUDGET_EXHAUSTED`，但 0 Artifact → `resumable=false`、`resumeReason=RESUME_NO_SAFE_CONTINUATION`、无 `data-ai-resume`。**结构冲突**：真实 UI `task/run` 每次只创建一个 step，预算耗尽发生在该推理 step 内直接 BLOCKED 且 0 Artifact，而 `getResumeEligibility` 要求 `artifactsOfTask>0`；`d4-06-resume` 是先经主进程 API 构造 2-step（step1 成功出 Artifact、step2 预算停止）才触达，该构造不是产品入口。本轮**不**用测试 API 造多步、**不**造空产物/假成功、**不**放宽续接守卫。**最小方案**：新增产品级“分阶段/追加步骤”入口，让正常任务先完成一个带 Artifact 的真实步骤，再在后续步骤预算停止并续接。 |
| **5 刷新后权限/任务/预算/产物一致** | **PASS** | Reload 后 gate=ready；TOOL 权限与后端一致；flow1 task/get 权威 `SUCCEEDED`+1 Artifact+1 Verification；flow3 `BLOCKED`+`deniedOperations`；预算账本 kinds 前后一致 |

副作用计数（真实 main）：流程1 mutation=1 / SideEffectCall=1 / approval=1 / lease=1(RELEASED) / executor spawn；流程2 mutation=0 / 新 lease=0 / 新 executor=0；流程3 mutation=0 / SideEffectCall=0。

## 5. 门禁与错误

- **`overallStatus = PARTIAL`；实际退出码 = 1**（必需项 flow4 不可达 → 按约定非零退出，未把 NOT_VERIFIED 当通过）。
- checks `63/64`（0 hard fail，1 notVerified）；`rendererConsoleErrors=0`、`mainUnhandledErrors=0`。
- 证据：`docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`（`testedCommit=396e14c`、`workspaceState=""`、`requiredFlows`、`overallStatus=PARTIAL`、`notVerified`（含流程4冲突+最小方案）、`productSeams`（seeding removed）、逐条 checks；`artifactSha256=a1da89acced437312512d1c09c66120fa6c39179bbe86d77edf66a37797a7cc4`；已脱敏，无 secret/私有路径）。
- 回归（`396e14c`，串行，全部 exit 0）：`governance-tool-grant` **12/12**；`d4-05-s1-facade-denied-write` **4/4**；`test:d4-04` **94/94**；`test:d4-05` **173/173（S1–S4 全 PASS，overallStatus=PASS）**；`test:d4-08-verification-ui` **22/22**。

## 6. 服务层通过 vs 产品入口通过（明确区分）

- **服务层（本轮已通过）**：`grantAppToolPermission`/`revoke`、`getDeniedRequiredWriteOperations`、`getResumeEligibility`/`resumeBudgetExhausted` 等合同级行为；D4-04 94/94、D4-05 173/173、D4-06 119/119+21/21 仍为依据。
- **产品入口通过（本轮）**：真实 main 下经治理 UI/产品桥完成工具授权、撤权、明确拒绝阻断、刷新一致性；成功 WRITE 全链与副作用计数。
- **产品入口未通过（本轮）**：预算停止后的 UI 显式续接（结构性不可达，见流程 4）。

## 7. 剩余限制

1. **流程 4 未关闭**（产品级“分阶段/追加步骤”入口缺失）→ 真实 main 缺口保持 **PARTIAL**；Gate 退出码非零。
2. 工具授权入口：授予是**并集追加**（底层单行 upsert），撤销为**整条 TOOL grant 撤销**（未做逐动作撤销）——如需逐动作撤销需另开最小项。
3. flow2 撤权与 flow3 部分授权经产品桥 `window.openarc.governance.command`（flow2 因审批模态遮挡 UI）；治理 UI 的 revoke 按钮路径本轮未单独驱动（revoke 已由产品桥+service 验证）。
4. `D4 = PARTIAL` 不自动升级：Windows / External Provider / D4-03 外部审计 / 真实外部凭据与服务等保持原状。
5. 未 push、未合并 main；未触碰默认或 integration 工作区。
