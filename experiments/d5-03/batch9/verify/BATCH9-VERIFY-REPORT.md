# D5-03 第九批 · 独立验收报告（执行岗）

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`）
- 被测提交（HEAD）：**`f9133f5d5b8cc4af30c3ca96ee66e0f3c8d39422`**（`fix(d5-03): 第九批 启动超时不再冒充执行超时 + cancel 测试按可观察阶段等待`）
- 验收开始时工作树干净（`git status --porcelain` 只有本报告目录为新增）
- 本验收**只新增** `experiments/d5-03/batch9/verify/**` 与 `artifacts/d5-03/runs/<runId>/**`；**未改任何产品代码 / 测试 / 断言**（`git diff --stat HEAD -- electron/ src/ tests/` 为空）
- 未 push、未切分支、未触碰主工作树 `/Users/wepingli/Desktop/OpenArc OS`、未触碰 DSH 共享运行时与 `~/.dsh`
- 规范版本：`DESIGN_SYSTEM.md` 设计提案 0.2 / 2026-09-10（第 3 行，sha256 `0fe8ab7e…`）；`MOTION_SYSTEM.md` 动效提案 0.1 / 2026-09-10（第 3 行，sha256 `c5bcb79f…`）；`PLAN.md` 更新日期 2026-09-10（sha256 `9103993a…`）
- 证据清单（含 sha256）：`experiments/d5-03/batch9/verify/MANIFEST.sha256`

**结论速览**：一（两种错误码）= **通过**（60 项检查：59 PASS + 1 条"必须变红"的反向验证按预期变红）；二（界面）= **通过**（75/75，浅/深截图、布局、对比度、动效分别达标）；三（门禁与全量）= **通过**（受影响门禁只有 `test:d4-02c`，26/26 绿；全量 `npm test` 1387/1385 pass，仅两条既有确定性失败）。**未发现本批产品回归**；另发现 1 条既有限制的加重后果（R1 子进程在 dispose 后仍存活），如实登记不改。

---

## 一、两种错误码用可控阻塞验证（真实产品分类路径）

证据：`01-codes-probe.stdout.txt`、`batch9-01-codes-probe.json`、脚本 `batch9-01-codes-probe.mjs`
命令：`node experiments/d5-03/batch9/verify/batch9-01-codes-probe.mjs` → **exit 0**；计数 `{total:60, pass:59, fail:0, expectedRed:1, unexpectedGreen:0}`

不 mock 产品：真实 `HarnessAdapter`（真实 spawn 子进程 + 真实 ACP SDK）、真实 `TaskService/TaskStore/ModelProxy`、真实 `classifyHarnessError`。唯一可控项 = 既有夹具探针充当 Harness 子进程 + **构造参数**注入更小预算（默认 30000/180000 一字未改，A5 已断言）。

### 1.1 启动阻塞 → `HARNESS_START_TIMEOUT`

注入 `startTimeoutMs = 1200`（`turnTimeoutMs=60000`），探针 `tests/fixtures/harness-acp/start-hang-agent.mjs`（initialize 永不返回）：

| # | 断言 | expected | actual |
|---|---|---|---|
| B1 | 错误码 | `HARNESS_START_TIMEOUT` | `HARNESS_START_TIMEOUT` |
| B2 | 不冒充执行超时 | `!== HARNESS_TURN_TIMEOUT` | 成立 |
| B3/B4/B5 | step / task / run 终态 | `BLOCKED` ×3 | `BLOCKED` / `BLOCKED` / `BLOCKED` |
| B6/B7 | run 行如实 | `HARNESS_START_TIMEOUT` / `blocked` | 同 |
| B8/B9 | 0 respawn / 0 二次 start | runs=1 / starts=1 | 1 / 1 |
| **B10/B11/B12** | **0 prompt / 0 provider 请求 / 0 call** | 0 / 0 / 0 | 0 / 0 / 0 |
| B13 | artifact | 0 | 0 |
| **B14/B15** | capability 撤销 | ≥1 且全 `REVOKED`；旧 token 打 Model Proxy 一律 401 | `["REVOKED"]`；行为探测 `[401]` |
| B16/B17 | 事件如实携带该码 | `step.blocked.reason` = 该码；`harness.run.blocked.errorCode` = 该码 | 同（另有 `harness.run.unknown_effect.reason` 与 `task.blocked.reason` 也是该码） |
| **B18** | 有界停止与注入预算**同量级** | < 5×1200ms | **1268.0ms（≈1.06× 预算）** |
| B19/B20 | 0 孤儿 / 终态 1.5s 不翻转 | 0 / true | 0 / true |

事件原文（原始输出）：
```
harness.run.unknown_effect {reason: "HARNESS_START_TIMEOUT"}
step.blocked               {reason: "HARNESS_START_TIMEOUT"}
task.blocked               {reason: "HARNESS_START_TIMEOUT"}
harness.run.blocked        {status:"BLOCKED", stopReason:"blocked", errorCode:"HARNESS_START_TIMEOUT"}
```

### 1.2 执行阻塞 → `HARNESS_TURN_TIMEOUT`

注入 `turnTimeoutMs = 1200`（`startTimeoutMs=20000`），探针 `turn-hang-agent.mjs`（prompt 永不返回）：

| # | 断言 | expected | actual |
|---|---|---|---|
| C1/C2 | 错误码 / 不反向错配 | `HARNESS_TURN_TIMEOUT` / `!= START` | 同 |
| C3/C4 | step+task / run | `BLOCKED` / `BLOCKED+HARNESS_TURN_TIMEOUT+blocked` | 同 |
| **C5/C6** | **prompts 恰好 1 / start 恰好 1** | 1 / 1 | **1 / 1** |
| **C7/C8** | **call 恰好 1 条**，`FAILED` + `providerErrorCode=HARNESS_TURN_TIMEOUT` | 1 / FAILED+TURN | 同 |
| C9/C10 | artifact 0 / capability 撤销+行为 401 | 0 / true | 0 / true |
| **C11** | 有界停止 | < 5×1200ms | **1254.0ms（≈1.05×）** |
| C12/C13 | 0 孤儿 / 终态稳定 | 0 / true | 0 / true |

> 说明：两条路径的 `provider 真实 HTTP 请求` 都是 0——因为夹具探针自己就是"Harness"，从不向 Model Proxy 发模型请求。**F1 是计数器活性对照**（直发 1 次 HTTP 后 fake provider 计数 +1），证明"0 次"不是恒零计数器。

### 1.3 反向验证（只在副本里改回旧映射）

- 副本：把产品 orchestrator 源码复制到 `verify/`，**只改一行**为旧映射（`HARNESS_START_TIMEOUT → ERROR.HARNESS_TURN_TIMEOUT`），其余逐字相同；副本 sha256 `e1221a42b4ede63ecb59486b7696ed4b296d3a01cbd22fb5f82c2fff3951a8a6`
- **D0**：副本里 `classifyHarnessError(START)` = `HARNESS_TURN_TIMEOUT`（旧映射确实生效）
- **D1（必须变红）**：启动阻塞用例 → `[EXPECTED-RED]` 期望 `HARNESS_START_TIMEOUT`，**实际 `HARNESS_TURN_TIMEOUT`**，且 run 行 `errorCode` 也变成 `HARNESS_TURN_TIMEOUT` → **红/绿对照成立**
- **D2（对照保持绿）**：执行阻塞用例在旧映射下仍是 `HARNESS_TURN_TIMEOUT` → 证明反向补丁是外科式的
- **D3**：副本已删除（`patched-orchestrator-OLD-MAPPING.cjs` 不存在）
- **D4**：产品 `electron/task-harness-orchestrator.cjs` sha256 前后一致 = `aa6142e15365c170463ab229bae913a4b365fbd098e6ab8622c9da3a9e589e2c`（**未被改动**）

### 1.4 竞争（取消 vs 超时，各一例）

| 项 | R1 启动阻塞中途取消 | R2 执行阻塞中途取消 |
|---|---|---|
| 注入预算 | start=4000ms / turn=60000ms | start=20000ms / turn=20000ms |
| 取消时刻 | +902.0ms（cancel ok=true） | +167.0ms（prompt 于 +45ms 发起后 122ms） |
| **终态（唯一）** | **CANCELLED**（task rev8 / run CANCELLED / cancel_requested=true） | **CANCELLED**（task rev10 / run CANCELLED） |
| 终态稳定性 | 收敛后 1.5s 不翻转 | 同 |
| task 终态 == run 终态 | 成立 | 成立 |
| **0 孤儿（自己 spawn 的）** | 0（全局扫描 0） | 0（全局扫描 0） |
| **无能力残留** | 全部 `REVOKED` + 旧 token 行为 **401** | 同 |
| 取消后 runTask 的最终返回 | `TASK_REVISION_CONFLICT`（**fail-closed：取消之后不再产生任何 post-cancel mutation**） | 同 |

- 两条竞争的取消都**赢了**，终态一致且唯一 = CANCELLED；**没有出现"终态翻转"或"双终态"**。
- 观察（如实登记，未修）：R1 取消不缩短在飞的 `initialize` 等待（runTask 在 4011ms 才结束，仍被启动预算封顶）；R2 取消后 in-flight model call 行停在 `STARTED`（非终态）——**其后续是否被终结未观测**（`notVerified`），且属既有 cancel 路径，非本批改动面。

### 1.5 与"已实现"条目的对照

与题面完全一致：`task-domain.cjs:133` 新增独立枚举；`task-harness-orchestrator.cjs:101` 原样保留启动码；预算 `:31-32` 仍 30000/180000；`harness-adapter.cjs:272-275` 只包 initialize、`:278` `newSession` 无超时（R1 未改，见 §三·3）。**无不符点。**

---

## 二、任务界面视觉/动效验收（真机 Electron）

证据：`02-ui-acceptance.stdout.txt` + run 目录 `artifacts/d5-03/runs/20260929T094444Z-3a33-batch9-harness-timeout-ui/`（runId **20260929T094444Z-3a33**，**75/75 PASS，exit 0**，artifact sha256 `7ed60d0be05c80790d53f2d285814bf27b00af739fe523ec746a23a356f77d56`）

### 2.1 真机链路与隔离

真实 Electron 44.3.0 + **真实产品 Renderer**（`dist/index.html`）+ 真实产品 preload + 真实 `registerIdentityIpc`/`registerTaskIpc` + 真实 TaskService/TaskStore/ModelProxy；真实登录、**真实设置面板**切主题与"减少动态效果"。唯一替换 = Harness **子进程**换成既有夹具阻塞探针 + 构造参数注入 700ms 预算（场景由界面里真实输入的目标标记 `[PROBE:START]`/`[PROBE:TURN]` 选择）。隔离：独立 runId 目录 + `acquirePort` 独占探测（CDP `cdpPortProbes` 有记录）+ **只清自己 pid 树**（`strategy=own-pid-tree-only, pkillUsed=false, tree=[58714,58715,58717], leftovers=[]`）+ 串行执行。
后端事实与界面一致（探针宿主原始行）：`task/result {error:"HARNESS_START_TIMEOUT", status:"BLOCKED"}` + `facts {taskStatus:"BLOCKED", runs:[{errorCode:"HARNESS_START_TIMEOUT",stopReason:"blocked"}], capabilities:["REVOKED"], resumable:false, stopReason:"HARNESS_START_TIMEOUT"}`。

### 2.2 基准（与既有任务界面基准一致）

既有任务界面（AI 面板）门禁探针族 `d4-04/05/06/08-*-probe` 统一用 `new BrowserWindow({width:1360,height:900})`；本验收使用**同一参数**。实测：内容区 1360×868（原生标题栏 32px）、dpr=2（本机显示器缩放；产品**无 `setZoomFactor`** → 缩放 100%）、玻璃 `full`、壁纸 `theme-dark`（产品默认，浅深都不改）、主题经真实设置面板显式置为 light/dark。截图为 2720×1736（@2x）。

### 2.3 浅色 + 深色实机截图（两种码各一）

| 场景 | 窗口截图 | 状态行裁图 | 面板裁图 | 对比度裁图 |
|---|---|---|---|---|
| 浅色 · `HARNESS_START_TIMEOUT` | `light-start-window.png` | `light-start-state-row.png` | `light-start-panel.png` | `light-start-error-contrast.png` |
| 浅色 · `HARNESS_TURN_TIMEOUT` | `light-turn-window.png` | `light-turn-state-row.png` | `light-turn-panel.png` | `light-turn-error-contrast.png` |
| 深色 · `HARNESS_START_TIMEOUT` | `dark-start-window.png` | `dark-start-state-row.png` | `dark-start-panel.png` | `dark-start-error-contrast.png` |
| 深色 · `HARNESS_TURN_TIMEOUT` | `dark-turn-window.png` | `dark-turn-state-row.png` | `dark-turn-panel.png` | `dark-turn-error-contrast.png` |
| 深色+减少动态 · `HARNESS_TURN_TIMEOUT` | `dark-reduced-turn-window.png` | `dark-reduced-turn-state-row.png` | `dark-reduced-turn-panel.png` | `dark-reduced-turn-error-contrast.png` |

（均在 run 目录下，逐文件 sha256 记在 artifact 的 `screenshots[]`；状态行可见文案即 `状态： BLOCKED · Recovery Required · HARNESS_START_TIMEOUT` 与 `… · HARNESS_TURN_TIMEOUT`。）

### 2.4 布局：更长的码不溢出不挤压

两种码只差 1 个字符（21 vs 20）。同一主题下实测：

| 量 | `HARNESS_START_TIMEOUT` | `HARNESS_TURN_TIMEOUT` | 差 |
|---|---|---|---|
| 错误行矩形 | x=1016 y=487.66 **w=246.91 h=35** right=1262.91 | 完全相同 | 0 |
| 状态行容器 `.ai-state` | x=1016 **w=306 h=36.5** right=1322 | 完全相同 | 0 |
| 容器溢出 | clientWidth 306 = scrollWidth 306（**无横向溢出**） | 同 | 0 |
| 面板 `.ai-panel` | w=350，clientWidth 350 = scrollWidth 350（**无溢出**） | 同 | 0 |
| 祖先链（到 body） | 全部 `horizontalOverflow=false` | 同 | — |
| 错误行**行数** | **2 行**（lineTops [488, 506]） | **2 行**（同 tops） | 0 |
| 状态行行数 | 2 | 2 | 0 |
| 最长一行宽 | 184.36px（错误行）/ 197.12px（状态行） | 179.16px / 197.12px | +5.20px |
| 按钮矩形 | run {x1016,y464.16,w68,h22}、cancel {x1084,…,w40} | 完全相同 | 0 |
| 剩余余量 | 内容宽 306 − 最长行 197.12 = **108.88px** | — | — |

结论：更长的码只让最后一行多 5.20px，**行数、行高、状态行高度、按钮矩形、面板矩形全部不变，无换行/裁剪/挤压/溢出**；面板固定 350px 宽（不随窗口变化），窗口尺寸变化不构成该行布局风险。

### 2.5 对比度（按 `DESIGN_SYSTEM.md:248`）

量测方法：裁行截图 → 页面内 canvas 解码 → **背景取众数（= 最终合成后的真实表面）** → 文字取与背景亮度差最大像素 → WCAG 2.x 相对亮度比；同时用计算样式 color 与同一背景像素复核（两法结果一致）。

| 场景 | 合成背景 | 文字色 | 实测比值 | 字号/字重 | 门槛归属 | 判定 |
|---|---|---|---|---|---|---|
| 浅色（两种码同值） | `rgb(181,181,181)` | `rgb(29,29,31)` = #1D1D1F | **8.208 : 1** | 14px / 400 | **普通文本 4.5:1**（14px < 24px，非大字） | **通过** |
| 深色（两种码同值） | `rgb(22,22,22)` | `rgb(245,245,247)` = #F5F5F7 | **16.62 : 1** | 14px / 400 | 普通文本 4.5:1 | **通过** |
| 深色+减少动态 | `rgb(22,22,22)` | `rgb(245,245,247)` | **16.62 : 1** | 14px / 400 | 普通文本 4.5:1 | **通过** |

背景众数像素占比 86.2–86.4%，即背景是**合成后的实际表面**（面板半透明材质叠在壁纸上），不是 token 候选值（符合 `:251`）。文字用 `text.primary`（`:63`），**不用颜色单独传意**（`PLAN.md:45`），状态由文字承担。

### 2.6 动效：本批未新增（有证据）

| 量 | 浅色 | 深色 | 深色+减少动态 |
|---|---|---|---|
| `animationName`（错误行） | `none` | `none` | `none` |
| `animationDuration` | `0s` | `0s` | `0s` |
| `transitionDuration` | `0s`（`transitionProperty: all` 但时长 0） | `0s` | `0s` |
| `transitionDelay` | `0s` | `0s` | `0s` |
| 元素作用域 `--dur-quick` | `.16s` | `.16s` | **`0ms`** ✓ |
| 根作用域 `--dur-quick` | `.16s` | `.16s` | `.16s`（减少动态只在 `.reduced` 作用域内归零，符合 `MOTION_SYSTEM.md:21`） |

- **像素级旁证**：`dark-turn-state-row.png` 与 `dark-reduced-turn-state-row.png` **sha256 完全相同**（`22f44dce143f63a7…`）→ 减少动态效果下该行渲染逐字节一致，不存在被关掉/改变的行内动画。
- 机械证明：本批 `src/**` **0 行改动**（`git diff --stat HEAD~1 HEAD -- src/` 空），因此**结构上不可能新增 CSS 动效**。
- 如实说明：`.ai-panel` 自身有**既有**的 `animation: appear var(--standard)`（`src/styles.css:1381`，面板入场），那是面板级既有动效、非本批、也非该错误行；该行本身无任何动效。

### 2.7 三轴结论（分别判定，未放宽门槛）

| 轴 | 结论 | 依据 |
|---|---|---|
| **功能** | **通过** | 真实 UI 输入 → 真实 `task/run` → 真实分类器 → `[data-ai-error]` 原样显示 `HARNESS_START_TIMEOUT` / `HARNESS_TURN_TIMEOUT`；状态文字 `BLOCKED · Recovery Required`；无 `[data-ai-stop-reason]`、无恢复块、无验证块；后端 facts 与界面一致 |
| **视觉** | **通过** | 浅/深实机截图；无溢出/换行/裁剪/挤压；对比度 8.208:1（浅）/ 16.62:1（深）≥ 4.5:1；按钮与面板几何在两种码下完全相同 |
| **动效** | **通过** | 该行 `animationName=none` / `transitionDuration=0s`；减少动态下元素作用域 `--dur-quick=0ms`；无误减、无新增；本批 0 行 src 改动 |

---

## 三、门禁与全量

### 3.1 受影响性分析（机械证据）

脚本 `batch9-03-affectedness.mjs` → `03-affectedness.txt` / `batch9-03-affectedness.json`
方法：`package.json` 门禁脚本 → 其**真实执行的测试文件清单**（run-all.mjs 的 `FILES[]` / `node --test` 参数）→ 逐文件 import/require **传递闭包**（含 fixtures）→ ① 是否加载本批改动模块 ② 是否**可达改动分支**。判据②用唯一决定性证据：闭包里存在真的产生启动超时的用例（spawn `start-hang-agent.mjs`）。

全仓交叉核对（决定性）：`grep -rn "start-hang-agent\.mjs" tests/ experiments/ electron/ src/` 在产品/门禁空间内**只命中一个文件** `tests/task-harness-orchestrator.test.mjs`；而该文件只被**一个门禁**执行 → `test:d4-02c`。

消费方排查（证明改动面极窄）：两个码在产品内只有 3 处引用（`harness-adapter.cjs` 生产端、`task-harness-orchestrator.cjs:99/101` 分类器、`task-domain.cjs` 枚举声明），渲染层**不按码分支**，全仓**无 ERROR 枚举整体遍历**，停因判定只特判 `BUDGET_EXHAUSTED`（故启动超时仍 `resumable=false`）。

| 门禁 | 真实执行文件数 | 闭包加载改动模块 | 可达改动分支 | 判定 | 处置 |
|---|---|---|---|---|---|
| **`test:d4-02c`** | 6 | **是**（两个） | **是** | **真受影响** | **重跑**（见 3.2） |
| `test:d4-02b` | 5 | 否 | 否 | 不受影响 | 复用 |
| `test:d4-03b` / `d4-03d` / `d4-03d-closure` / `d4-03a` / `d4-03c1(+closure)` / `d4-03c2(+3 closures)` / `d4-03c3(+closure)` / `d4-03c4(+3 closures)` / `d4-03-cg01` / `d4-03b-dsh` / `d4-08` / `d4-04-closure2` | 1–11 | 是 | **否**（无启动超时产生点 → 分支不可达，行为逐字节不变） | 复用 |
| `test:d4-01` / `d4-02a` / `d4-04` / `d4-05` / `d4-05-memory-ui` / `d4-06` / `d4-06-resume` / `d4-08-verification-ui` / `d4-03c4-ui` | 1–8 | 否（d4-02a 仅加载 task-domain 的**新增枚举**） | 否 | 不受影响 | 复用 |

**复用证据的 runId/sha256（如实引用，未重跑）**：
| 门禁 | 产物 | mtime (UTC) | sha256(16) |
|---|---|---|---|
| d4-02b | `artifacts/d4-02b/d4-02b-gate.json` | 2026-09-29T05:09:02Z | `fbc0be522014a9e4` |
| d4-03b | `artifacts/d4-03b/d4-03b-gate.json` | 2026-09-29T05:10:17Z | `38c7ca7fbaaf0259` |
| d4-03d | `artifacts/d4-03d/full-tool-proxy-gate.json` | 2026-09-29T05:11:35Z | `0dfcb89bbf8d2e82` |
| d4-03d-closure | `artifacts/d4-03d-closure/d4-03d-closure-gate.json` | 2026-09-29T05:12:30Z | `1c86646b38ab0246` |
| d4-05/d4-04/d4-06/d4-08 等 UI 门禁 | 无 JSON 产物（run-all 自清目录 / 不落盘） | — | — |

> 诚实说明：上述复用产物的 mtime 早于本批提交（本批提交时间 09:32Z），且它们**没有内嵌被测 commit 字段**，因此"复用"的依据是**改动分支机械不可达**（同一代码+环境下结论仍有效），不是产物里的提交戳；其中 `artifacts/d4-04/*.json` 的 `testedCommit` 为更早的 `64c58e83ec`，同样按"不受影响"复用。

### 3.2 重跑的受影响门禁

`npm run test:d4-02c` → 证据 `04-gate-d4-02c.txt`
- **`# tests 26 / pass 26 / fail 0`，exit 0**，duration 33656ms
- 结论行：`PASS — {"tests":26,"pass":26,"fail":0,"versions":{"dsh":"0.1.5-rc.2","dshBin":"…/node_modules/.bin/dsh","acpSdk":"1.4.0","protocolVersion":1,"schemaVersion":21}}`
- 产物：`artifacts/d4-02c/d4-02c-gate.json` sha256 `7f8184772953892666df469346ccc9d808cfa6c907839d1b577118e7a6a7e69f` → **`4950ac7fb81198ca3ba03048b040d7008b557511c3b09c583f481b7d30f2bf9e`**（被该门禁自身按设计重写）

### 3.3 一次全量 `npm test`

命令 `npm test`（= `node --test tests/*.test.mjs`）→ 证据 `05-npm-test-full.txt`（sha256 `874ca4b0586808fc17dae08da967deac951d873325ae30af5367ae93da624c63`）

```
# tests 1387   # suites 0   # pass 1385   # fail 2
# cancelled 0  # skipped 0  # todo 0      # duration_ms 130873.5
NPM_TEST_EXIT=1
```

**失败清单（逐条，共 2 条，全部为既有确定性失败 → 未修，不计入本批）**
1. `not ok 64 - P2 · 当前会话 = A（owner）：推送投递，载荷 = 白名单投影且与 getApprovalRequest 一致`（`tests/d4-03-approval-push-isolation.test.mjs:94`，断言在 `:103`）——`AssertionError: 推送不得新增/泄露字段`：actual 比 expected 多 `targetRef`、`url` 两个字段。
2. `not ok 1064 - No Direct Domain Bypass：resource.trash 的唯一 Domain 调用点在 allowlisted adapter + controlled execution 内`（`tests/side-effect-c4-gates.test.mjs:444`，断言在 `:474`）——`AssertionError: 主进程绝不 in-process 执行 write`，expected true / actual false。

**本批相关用例全绿（无新失败）**：
- `ok 1181` classifyHarnessError 两个码各自映射；`ok 1182` 启动超时；`ok 1183` 执行超时（恰好 1 次 prompt）；`ok 1184` 真实 IPC 入口
- `ok 1166` Cancel E2E；`ok 1167` Cancel Race；`ok 1168` Cancel 后不存在 Provider retry（第三条 = 改造后的"按可观察阶段等待"，**未复现** W49 的 0 次请求失败）

### 3.4 R1 观察（只观察，不修）

脚本 `batch9-04-r1-observation.mjs` → `06-r1-observation.txt` / `batch9-04-r1-observation.json`（计数 `{total:6, pass:5, fail:0, observations:1, observationFindings:1}`，exit 0）

**R1 复现：是。** 注入 `startTimeoutMs=700`，探针 `session-new-hang-agent.mjs`（initialize 正常、session/new 不回）：

| 项 | 对照（initialize 阻塞） | R1（session/new 阻塞） |
|---|---|---|
| 阶段时间线 | `+6.2ms start:begin → +757.0ms start:error HARNESS_START_TIMEOUT → +774.7ms runTask:resolved` | `+2.2ms start:begin → +8005.8ms watch:end`（**8s 观察窗内无任何收敛**） |
| 8s 内是否收敛 | 是（≈0.79s） | **否** |
| 期间状态 | 终态 BLOCKED | **run=STARTING / task=RUNNING** |
| 期间 provider 请求 / prompt | — | **0 / 0** |
| 期间子进程 | 已退出 | **仍存活** |
| 负载 | — | `loadavg [7.64, 11.91, 15.45]`，12 CPU，18 GiB |

**代码事实**：`harness-adapter.cjs:272-275` 只把 ACP `initialize` 包进启动预算；`:278` 的 `await this.conn.newSession(...)` **没有任何超时** → 启动阶段存在无界段。

**本次独立验收的附加发现（R1-e，observation，未修）**：该无界段里 `orchestrator.dispose()` **无法回收子进程**——实测 dispose 后子进程 ps 状态仍为 `S`（对照场景为 `gone`）。机制：`task-harness-orchestrator.cjs:241` 的 `registry.set(...)` 在 `adapter.start()` **返回之后**才登记，而 `dispose()`（`:824-831`）与 `cancel()`（`:746`）都只遍历 `registry` → 卡在 `start()` 里的 adapter 对二者不可见。该子进程只在主进程退出（stdin 关闭）后消失——脚本退出后复查 **0 残留**。**属既有 R1 的加重后果，不是本批回归，未修。**

### 3.5 残留与历史完整性

脚本 `batch9-05-residue-integrity.mjs` → `07-residue-integrity.txt` / `batch9-05-residue-integrity.json`（exit 0）
- ① `/var/folders/*/*/T/oa-d503*`：**`[]`（0 残留）**
- ② 本任务进程残留：**0**（脚本内自匹配的 bash/node 属该检查自身；收尾单独复查亦为空）
- ③ **`artifacts/d5-03/runs/index.json` 81 条索引 sha256 逐条复算：0 条不一致**（artifact 与 log 摘要全部匹配）；`index.json` sha256 `a83c1ec0704e623605b265411c06334e2d36fc354b6286d5ecc8f8cd27d65266`
- ④ 近 3 小时内 `runs/` 下被改动的文件：**仅本批 batch9 的 6 个 run 目录 + `index.json`/`index.jsonl`**（索引追加属设计行为）；`④b 不属于本批 run 的文件 = 只有这两个索引文件` → **历史 run 产物未被改写**
- 本批新增 run 目录：`…-0dc2`、`…-1244`、`…-fccc`、`…-a352`、`…-2a0e`（**前 5 个为调试/中途版本，均 exitCode=2 或被后续版本取代**，如实保留在索引中）+ **定稿 `…-3a33`（75/75，exit 0）** + `…-be39`（空目录，一次被中断的尝试，未 finalize）

---

## 四、notVerified 清单

1. **R2 竞争后 in-flight model call 的最终归宿**：取消后 1.5s 观测到该 call 行仍为 `STARTED`（非终态）；未观测更长时间后是否被终结。属既有 cancel 路径，非本批改动面。
2. **R1 的 UI 表现**：R1 场景（session/new 无界）在界面上会长期停在"运行中"，本次未做该场景的实机截图（不影响本批两种错误码的界面验收）。
3. **`providerErrorCode` 语义**：执行超时时 `TaskService` 的 model call 行记录了 `providerErrorCode = HARNESS_TURN_TIMEOUT`；该字段名为 provider 侧语义而实际装的是 harness 超时码，本次只如实记录、未判定是否为缺陷。
4. **复用门禁的证据强度**：§3.1 表中"分支不可达"的门禁沿用早于本批的运行产物；产物内不含被测 commit 戳，复用依据是机械不可达证明（同代码同环境仍有效），未重跑。
5. **`d4-02a`**：闭包只加载 `task-domain.cjs`（本批为**纯新增枚举**），判为不受影响；未重跑。
6. **极端窄窗口**：面板宽度固定 350px，本次未做窗口 <1000px（产品 minWidth）的实测。
7. **`openarc-resource` / `openarc-canvas` 协议**：探针宿主只接入了 `openarc-file`（用于 AI 球的原生素材）；另外两个协议未接入（本次未触发相关控制台错误/请求失败）。

## 五、遗留

- **R1（在册，本批未改）**：`harness-adapter.cjs:278` 的 `newSession` 无上界 → 启动阶段可无界悬挂；本次已独立复现（8s 不收敛、run STARTING、0 请求、子进程存活）。
- **R1 加重后果（本次新发现，未修）**：无界段中 `orchestrator.dispose()` / `cancel()` 均无法触及该 adapter（`registry.set` 晚于 `start()` 返回），子进程只能靠主进程退出回收。
- **R2 竞争账本残留（本次观测，未修）**：取消竞争中 in-flight model call 行可停在 `STARTED`。
- **两条既有确定性失败**（`d4-03-approval-push-isolation` 的 P2、`side-effect-c4-gates` 的 No Direct Domain Bypass）：按要求未修，如实单列。
- **文档更新不在本岗可写面**：`PROGRESS.md`/`docs/decisions/*` 关于"保留原始错误码"的登记需上级按本批结论更新。
