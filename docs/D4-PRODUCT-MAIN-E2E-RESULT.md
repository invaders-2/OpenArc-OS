# D4 · 真实产品入口 `electron/main.cjs` 端到端验证（Main-Entry E2E）

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`；分支：`feature/d4-03-tool-proxy`
- **实际 Base HEAD**（开工核对，干净，无并发变更）：`3cc4638a0cee09a3f61ad4b15b94cc8fee915d70`
- **代码与测试被测 commit**：`89af97acf8c24f83c0c7d839a1f77bf33f530e1f`（仅 `electron/main.cjs` + 新增 `tests/d4-main-e2e.mjs`）
- **报告与证据提交**：本文件 + `docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json` + `PROGRESS.md` + `docs/D4-ACCEPTANCE-RESULT.md` + `docs/D4-04/05-GATE-EVIDENCE.json`
- 范围：只关闭“真实 `electron/main.cjs` 产品入口未全流程验证”这一缺口；不扩大 Windows / External Provider / D4-03 外部审计等结论；**D4 不自动升级**。

## 1. 真实启动入口与隔离配置

- **入口**：仓库根 `electron/main.cjs`（package.json `main`），即正常产品的唯一启动方式；真实 `electron .`、真实 `preload.cjs`、真实 `dist/index.html` Renderer、真实 IPC / runtime-boot / Model Proxy / Task Runtime / ControlledToolProxy / SideEffectRuntime。
- **启动命令（测试驱动）**：
  ```
  spawn(require("electron"), [".", "--user-data-dir=<mkdtemp 隔离目录>", "--remote-debugging-port=9788"], { cwd: <worktree>, env })
  ```
  再用 `@playwright/test chromium.connectOverCDP("http://127.0.0.1:9788")` 连真实 Renderer，以真实 UI + `window.openarc` 产品桥驱动。**不使用 probe host、不使用复制的 main、不使用 Playwright `_electron.launch`**（`tests/desktop.mjs` 已记录该启动器在本环境超时）。
- **隔离 / 测试配置**（与正常启动的差异，全部默认关闭）：
  - `--user-data-dir=<临时隔离目录>`：identity DB / library / runtime 全在该目录，不触碰真实用户数据。
  - `OPENARC_IDENTITY_ADMIN=1`：允许首次 ADMIN 初始化（产品正常首启需要；非新增产品行为）。
  - `OPENARC_E2E_OBSERVE=1`：唯一一处默认关闭的**只读 boot 观测** seam——把 `runtime.snapshot()` 写到 `<userData>/openarc-e2e-boot.json`；正常启动不写文件。
  - `OPENARC_E2E_SEED_TOOL_GRANTS=1`：第二处、也是最后一处默认关闭的 **test-only 播种** seam——在**真实 ADMIN 会话建立后**调用真实 `authorization.grantAppToolPermission`（仍过 SUPER_ADMIN 校验，不直写 DB、不改授权/执行链）；正常启动不进入。
  - 本地确定性 provider（loopback HTTP）+ `OPENARC_D4_PROVIDER_URL`；不读真实凭据、不接外部服务。
- **状态获取（只读）**：boot 文件 + `node:sqlite DatabaseSync(<userData>/identity.db, { readOnly:true })` + 只读统计 `<userData>/runtime/side-effects/executors/*.json`。**绝不写库、绝不手工设终态、绝不替换 orchestrator。**

## 2. 启动顺序（boot snapshot，真实 main）

```json
{"identityCreated":true,"modelProxyStartAttempted":true,"modelProxyStarted":true,
 "modelProxyListening":true,"modelProxyErrorCode":null,
 "bootOrder":["identity_created","model_proxy_start_attempted","model_proxy_started","runtime_ready"]}
```
断言：bootOrder 严格有序、`modelProxyListening=true`、boot 观测文件 mtime 早于首个 task 接入（`bootMtime=…728751 < firstTask=…730979`）。

## 3. 四条流程（expected / actual / 副作用计数）

| 流程 | expected | actual | 结果 |
| --- | --- | --- | --- |
| **1 启动与成功执行**（前置 tool grant = test-only 播种） | 真实 UI 首启 + 登录 → Settings→Models 真实 UI 建本地 provider/model/default 并连接测试 → 产品桥造资源 → AI 面板 search→trash → 真实 Approve → Task/Step SUCCEEDED、恰 1 mutation、Artifact/Verification 齐全且绑定 | Task/Step=`SUCCEEDED`；`mutation=1`；SideEffectCall=1 `SUCCEEDED`+verification `PASS`；approval=1 `APPROVED`；lease=1 `RELEASED`；Artifact=1 / Verification=1 相互绑定且 `checksum==sha256(content)`；production executor 真实 spawn | **PASS** |
| **2 撤权停止**（前置 tool grant = test-only 播种） | 待审批时经产品治理入口撤权 → 点旧批准 → 无副作用 / 无新 lease / 无新 executor / 任务停止 / UI 复位 | `governance/revokeAppAccess ok=true,changed=true`；Call=`BLOCKED` + `SIDE_EFFECT_AUTHORIZATION_REVOKED`；`mutation=0`、`lease=0`、executor 1→1；Task/Step `BLOCKED`；UI busy 复位 | **PASS** |
| **3 预算停止与显式续接** | 有产物保留、到预算停止；真实 UI 追加预算并续接、其他预算不重置、不重放 | 预算停止 = **PASS**（Task `BLOCKED` / `BUDGET_EXHAUSTED`）；**续接 = NOT VERIFIED**（见 §5） | **PARTIAL / NOT VERIFIED** |
| **4 记忆隔离**（纯产品路径，不用播种） | 授权 memory 进入本地 provider 请求（低信任参考数据），删除 / 撤权后不再注入；刷新 / 切账号状态与权限正确 | provider 请求体含 `name:"openarc.reference_data"` 的 user 参考消息（`trust:"untrusted"`、JSON 正文）紧邻 `name:"openarc.rules"` 常量 system；system/developer 不含 secret/标题；删除后请求不含注入结构与 secret；刷新 gate=ready；切 MEMBER 后 SUCCEEDED 且请求不含旧 memory/secret | **PASS** |

副作用计数（真实 main）：流程1 mutation=1 / SideEffectCall=1 / approval=1 / lease=1(RELEASED)；流程2 mutation=0 / 新 lease=0 / 新 executor=0。

## 4. 错误与门禁

- `rendererConsoleErrors=0`、`mainUnhandledErrors=0`；checks `56/58`（2 条为 gap 标记，非硬失败），exit 0。
- 脱敏证据：`docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`（`testedCommit=89af97a`、`workspaceState=""`、逐条 checks、boot snapshot、flows、notVerified、observations；`artifactSha256=5e741dab7273f6eacd9f957b276875806045e21c6b2791af74886058921d9302`）；无 `/Users`、`/private`、`/var/folders`、`mpx_`、`tpx_`、provider secret、memory 正文。
- 回归（`89af97a`，串行）：`d4-05-s4-memory-context` **15/15**；`test:d4-04` **94/94**；`test:d4-05` **169/169（S1–S4 全 PASS，overallStatus=PASS）**；`test:d4-08-verification-ui` **22/22**。

## 5. NOT VERIFIED（如实保留，未以 probe 替代）

1. **产品入口 · 授予 App TOOL-scope 权限（UI/IPC）= 缺口**：产品**没有**任何入口能创建 app TOOL-scope grant——`authorization` 桥只读；`governance/grantAppAccess` 经 `normalizeGrantActions` 只接受 `RESOURCE_ACTIONS`，`tool.*` 动作实测返回 `INVALID_INPUT`；`grantAppToolPermission` 只是主进程 `AuthorizationService` 方法。流程 1/2/3 的前置 grant 由上述**默认关闭 test-only 播种**代偿，证据中已标注 `prerequisiteGrant="test-only seeded"`；**该产品入口本身并未被验证**。
2. **流程3 · 预算停止后显式续接**：真实 UI `task/run` 每次只创建一个 step；预算耗尽路径产出 0 Artifact，而 `getResumeEligibility` 要求 `artifactsOfTask>0`（否则 `RESUME_NO_SAFE_CONTINUATION`），因此经**产品入口**拿不到可续接状态与续接 UI。`d4-06-resume` 是先经主进程 API 构造 2-step 任务（step1 成功 WRITE 出 Artifact，step2 预算停止）才触达，该构造不是产品入口。故保留 NOT VERIFIED（预算停止本身 PASS）。
3. 观察项（不修）：**无 tool grant 时再次发起 WRITE，task 仍收敛 `SUCCEEDED`**，但 `tool_decisions` 全为 `TOOL_APP_NOT_GRANTED`、0 mutation / 0 审批 / 0 副作用。属既有“普通工具错误不阻断任务”语义，记录待产品裁决。

## 6. 结论与边界

- **本次关闭**：真实 `electron/main.cjs` 产品入口的启动、boot 顺序、真实 UI 首启/登录、真实 Settings provider/model 配置、真实 AI 任务与审批、成功 WRITE 全链、撤权停止、记忆信任分层与隔离——这些在真实 main 下验证通过。
- **本次未关闭**：产品 TOOL-scope 授权入口（缺失）；真实 main 下“预算→显式续接”产品入口（缺失）。二者均保留 NOT VERIFIED。
- **不自动升级**：Windows、External Provider、D4-03 外部审计、真实外部凭据/服务等保持原状；`D4 = PARTIAL`。
- 未 push、未合并 main；未触碰默认工作区与 integration 工作区；产品侧 test seam 恰好两处且默认关闭。
