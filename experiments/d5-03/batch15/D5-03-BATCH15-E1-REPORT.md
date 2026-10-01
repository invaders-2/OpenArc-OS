# D5-03 BATCH15 · E1 报告 — D5-01 visibility 真机门禁闭环（V9 / V11 / V12b）

- 任务：在**独占前台**条件下重跑 D5-01 visibility 真机门禁，闭环上一批（`ac019a5`）登记为未验收的 V9 / V11 / V12b。
- 工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`，分支 `integration/ui-core`，干净基线 `2d50986`。
- 结论速览：**两轮独立运行均 25 PASS / 0 FAIL / 25 total / 1 NOT VERIFIED，EXIT=0**，与 CLOSURE4 基线**汇总一致（25/0/1 + exit 0）且 25 条断言名单未变**（据此推出逐条判定口径未变；基线逐条快照未冻结，**不是**逐条快照比对 —— 更正 2 / F2）；上一批的 3 项 FAIL 全部为**环境/前台争用**，本轮在位条件下复现为 PASS。
- 判定口径：**本批（D5-01 visibility 未验收项闭环）= PASS（限定范围）；D5-03 整体 = PARTIAL**（未闭环项见 §7）。
- 本批**无任何产品/驱动代码改动**（更正 1 / F1，路径限定）：`git diff --stat -- src/ electron/ tests/ experiments/d5-01` **为空**；`git diff --stat` 非空，只有 `PROGRESS.md` 与 `docs/D5-03-GATE-EVIDENCE.json` 两处**文档**改动，另有本批未跟踪证据目录 `experiments/d5-03/batch15/`（收尾态 `git status --porcelain` = `M PROGRESS.md` / `M docs/D5-03-GATE-EVIDENCE.json` / `?? experiments/d5-03/batch15/`）。

---

## 1. 运行环境

| 项 | 值 |
| --- | --- |
| 工作树 | `/Users/wepingli/Desktop/OpenArc OS-integration` |
| 分支 | `integration/ui-core` |
| `git rev-parse HEAD` | `2d50986be46515678ad61494b09a4701565f8716` |
| 运行前 `git status --porcelain` | 空（干净基线，无未提交改动） |
| node | `v22.22.3` |
| electron | `44.3.0`（`require("electron/package.json").version`） |
| 真机命令 | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-visibility`（= `npm run build && node experiments/d5-01/visibility-e2e.mjs`） |
| 独占前台 | 整个运行期间未并发运行任何其它真机 e2e / `npm test` / 浏览器操作 |
| 本批新增目录 | `experiments/d5-03/batch15/`、`experiments/d5-03/batch15/verify/`、`experiments/d5-03/batch15/artifacts/` |

### 1.1 每次运行前的前台 App 与 pid（实测）

| 时点 | 前台 App | 前台 unix id |
| --- | --- | --- |
| 上一批交接时（本任务开始，21:14:11 CST） | `ChatGPT` | 24060 |
| 写 run1 文件头时 | `ChatGPT` | 24060 |
| run1 结束（13:15:04Z） | `Claude` | 18158 |
| run2 开始（13:16:12Z） | `Claude` | 18158 |
| run2 结束（13:17:00Z） | `Claude` | 18158 |

> **与任务书不符之处（如实报告）**：任务书写"前台 App 是 `DeepSeek Harness`"，实测运行前前台是 **ChatGPT（24060）→ Claude（18158）**，`DeepSeek Harness`（pid 83940）当时在 layer-0 顺序里**排在我们的实例之后**。这不影响结论：门禁自带的安全闸与激活逻辑（`ensureFrontmost` / `safeClick` → `activate(pid)`）在两次运行中**第一次尝试（attempt=1）就把本实例窗口带到最前并成为活跃 App**，全部真实点击均通过身份校验。

### 1.2 是否有其它自动化在跑

运行前快照（完整原文见 `00-prerun-facts.txt`）：`pgrep -fl "electron|node --test|npm" | grep -v WorkBuddy` **没有任何 electron 真机实例、`node --test`、`npm test`**。只有常驻后台服务（与屏幕/前台无关，且未在本轮运行期间活动）：

- `coze-bridge-daemon`（pid 3279）
- MCP 服务若干（`mcp-server-commands` / `server-filesystem`，pid 18205/18251/18252/18272/18288/18337/23517/23533）
- `agent-browser` 常驻守护进程（pid 34932 等，自 9 月即存在，CPU 0.0%，本轮未操作屏幕）

### 1.3 运行期间在 layer-0 顺序中排在我们之后的 App（`trace.front` 原文解析）

| pid | App |
| --- | --- |
| 18158 | `/Applications/Claude.app/Contents/MacOS/Claude` |
| 24060 | `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT` |
| 22673 | `/Applications/NOVAI.app/Contents/MacOS/NOVAI` |
| 83940 | `/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness` |

---

## 2. 运行次数与每次的 counts / EXIT / 前台状态

| 轮次 | 命令 | 前台（运行前 → 运行后） | counts（pass/fail/total） | notVerified | EXIT | 原始输出 |
| --- | --- | --- | --- | --- | --- | --- |
| run1 | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-visibility` | ChatGPT(24060) → Claude(18158) | **25 / 0 / 25** | 1 | **0** | `10-visibility-run1.txt` |
| run2 | 同一门禁 + 只读证据补齐预载（见 §2.2） | Claude(18158) → Claude(18158) | **25 / 0 / 25** | 1 | **0** | `11-visibility-run2.txt` |

- 两轮均到 25 PASS、0 FAIL，**没有出现任何 `not-frontmost`**，因此**未使用**任务书允许的"最多 3 次因争用重跑"额度（run2 的动机是补齐证据，见 §2.2）。
- run1/run2 逐条 check 状态**完全一致**（25 条同名同状态，差异 0 条）；把两轮的隔离实例 pid / window id 归一化后逐字符比对，**V9 / V12 / V12b 以及其余各条的 `actual` 全部相同，唯一数值差异是 V10 的四帧 PNG 字节数**（run1 `[346808,346954,347041,346901]` vs run2 `[346783,346863,346958,347062]`；PNG 压缩字节本就逐次微变，V10 只判"每帧 > 5000 字节"，两轮均 PASS）。
- 归一化比对原文与结果：`experiments/d5-03/batch15/verify/06-run1-run2-normalized-diff.txt`（逐条 status 相同 = true，`actual` 归一化后仍不同的条目数 = **1**，即上条 V10 的 PNG 字节数）；逐条状态对照另见 `verify/03-tables.txt`（差异 0 条）。
- 唯一的 1 项 NOT VERIFIED 两轮相同：**页面缩放（Cmd +/-）**，属于门禁**固有不计入必需项**的既有登记项（理由原文：D5-01 原始必需项不含页面缩放，PLAN 里的"缩放"指窗口缩放、已由 V9 覆盖），不是本批新增未验收项。

### 2.1 运行的实例身份

| 轮次 | 门禁实例 pid | 本实例窗口 id | 隔离 userData | CDP 端口 |
| --- | --- | --- | --- | --- |
| run1 | 25293 | 162275 | `os.tmpdir()` mkdtemp | 9794（隔离） |
| run2 | 28497 | 162294 | `os.tmpdir()` mkdtemp | 9794（隔离） |

两轮都是门禁自己拉起的**全新隔离实例**，与主工作树实例无关（驱动只按本进程 PID 定位窗口）。

### 2.2 run2 的只读证据补齐预载（必须说明的偏差）

**发现的证据缺口**：门禁 `visibility-e2e.mjs` 的 `record()`（第 44 行）把 `actual` 截断到 **2400 字符**。V11 的 `actual` 恰好是 8 个落点的完整 JSON，实测长度超过 2400，因此**门禁自己落盘的产物 JSON 与 stdout 里都缺了最后一个落点"右下角内"，且"左下角内"被截在 trace 中间**——无法据此直接给出任务书要求的"V11 逐落点 8 行表"。

**处置（不修改任何冻结文件、不改变任何判据/阈值/返回值）**：新增 `verify/evidence-preload.mjs`，通过 `NODE_OPTIONS=--import=<无空格符号链接>` 预载，把一个**只读**的 `JSON.stringify` 旁路包装挂到门禁进程上：仅当结果字符串 > 2000 字符且含 `"probes"` / `"pixelGreen"` 等探针键时，把**原样未截断**的字符串另存一份；返回值与原函数完全相同。已先用离线冒烟脚本验证"旁路捕获 + 往返一致 + 小对象不受影响"。

- run2 的**门禁本身**（判据、阈值、结论、产物 JSON）与 run1 完全一致，未被预载改变；预载只多落了一个旁路文件 `verify/captured/payload-001-2955.json`（2955 字符，8 个落点齐全）。
- 预载文件：`experiments/d5-03/batch15/verify/evidence-preload.mjs`（**本批新增，不属于产品、不属于门禁**）；run2 命令与边界说明已写在 `11-visibility-run2.txt` 文件头。
- 附带说明：`verify/captured/_index.txt` 写的是 `captured=0`，那是因为 npm / build / 门禁是**多个 node 进程**，每个都执行了预载的退出钩子，最后退出的子进程（未捕获任何东西）覆盖了索引文件；**有效证据是 `payload-001-*.json` 本身**，索引文件不作依据。

---

## 3. 逐项结果

### 3.1 全部 check 逐条表（run1 / run2 状态一致）

| # | section | 判据（name） | run1 | run2 | expected | actual 摘要（run1） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | boot | V0 · 真实 electron . 启动（隔离 userData / 隔离 CDP 端口） | PASS | PASS | CDP 可用 | connected |
| 2 | boot | V1 · 真实 UI 登录 admin | PASS | PASS | ready | ready |
| 3 | setup | V2 · 真实视图加载纯色页面（像素判定的基准） | PASS | PASS | PAINT-MARKER-2f7d | http://127.0.0.1:5391/paint |
| 4 | safety | V3 · 真实点击前先确认「最前面的窗口就是我们自己的实例」 | PASS | PASS | 本实例窗口在最前 | `{"ours":162275,"front":[{"pid":25293,"id":162275},{"pid":18158,…}],"tries":1}` |
| 5 | pixel | V4 · 屏幕像素证明确实「看得见」网页（视口中心是页面纯绿） | PASS | PASS | 页面纯绿（绿占优） | `56,123,83` |
| 6 | pixel | V4b · 截图确实是本窗口的画面（图像尺寸 = 窗口 bounds × 缩放） | PASS | PASS | 尺寸一致 | `{"image":[2880,1880],"win":{"w":1440,"h":940},"scale":2,"titlebar":0}` |
| 7 | pixel | V4c · 三条独立通道一致：像素真值 = DOM 预留矩形 = 指针反推（\|Δ\|≤3pt） | PASS | PASS | 三路一致（\|Δ\|≤3pt） | `pixels{308,418,829.5×320.5}` / `domReserved{308,417.5,830×321.5}` / `pointerOrigin{308,418}`，Δ≤1 |
| 8 | pixel | V4d · 提示条/错误条存在时网页**让位** | PASS | PASS | 条带让位且不被网页覆盖 | `banner.kind=permission, h=115`，条带内网页绿采样 0 |
| 9 | safety | V3c · 真实指针确实到达本实例外壳（热身） | PASS | PASS | 外壳收到真实 pointerdown（≤3 次） | `{"ok":true,"tries":1,"seen":1,"point":{723,191}}` |
| 10 | safety | V3b · 真实点击只落在本实例窗口内 | PASS | PASS | 点击被安全闸放行 | `{"ok":true,"attempt":1,"trace":[{ours:162275, front[0]={pid:25293,id:162275}, activePid:25293}]}` |
| 11 | pointer | V6 · 地址栏坐标 + 真实指针 → 焦点进入输入框 | PASS | PASS | activeElement=地址栏 | `click{ok:true,attempt:1}`，trace 前台=本实例 |
| 12 | pointer | V5 · 点标签栏「新建标签」→ 多出一个标签 | PASS | PASS | 标签数 +1 且外壳收到该按钮点击 | `{"before":1,"after":2,"elementAtPoint":"新建标签"}` |
| 13 | pointer | V5b · 点第二个标签 → 活动标签切换 | PASS | PASS | 第二个标签变为活动 | `{"want":"t2","active":"t2"}` |
| 14 | pixel | V5c · 操作前后两帧像素确实不同 | PASS | PASS | 帧不同 | `02-tab-switch.png` |
| 15 | pointer | V7 · 点网页内部按钮 → 页面自己收到点击并计数 | PASS | PASS | 页面收到真实点击并计数 | `count=COUNT-2`，`click{ok:true,attempt:1}` |
| 16 | pointer | V7b · 落点就是按钮本体（误差 ≤6px） | PASS | PASS | 命中按钮 | `got{190,185,target=paint-btn}` = `wantPagePoint{190,185}` |
| 17 | pixel | V8 · 面板打开时网页让位 | PASS | PASS | 非页面绿 | `255,255,255` |
| 18 | pixel | V8b · 面板关闭后网页回到可见 | PASS | PASS | 页面绿 | `56,123,83` |
| 19 | pointer | **V9** · 窗口缩放后重新测量坐标，真实指针仍然命中（≤8px） | PASS | PASS | 落点命中 | 见 §3.2 |
| 20 | pixel | V9b · 缩放后截图尺寸随之变化 | PASS | PASS | 比例一致 | `image=[2360,1480]` = `1180×740 ×2` |
| 21 | pointer | **V11** · 网页四边近边界的真实指针命中 | PASS | PASS | 四边都命中 | 见 §3.3（8/8 落点全中） |
| 22 | pointer | **V12** · 点「最大化」→ 状态 + 布局 + 命中都成立 | PASS | PASS | 状态/布局/命中都成立 | 见 §3.4 |
| 23 | pixel | **V12b** · 恢复后矩形与布局回到原位，像素真值回位 | PASS | PASS | 尺寸/布局恢复 | 见 §3.4 |
| 24 | pixel | V10 · 连续截图可用（多帧真实落盘） | PASS | PASS | 4 帧 | `bytes=[346808,346954,347041,346901]` |
| 25 | hygiene | H1 · 主进程无未处理错误 | PASS | PASS | 无错误行 | clean |

**counts（两轮相同）**：`{"pass":25,"fail":0,"total":25}`，`notVerified` 列表 = `["页面缩放（Cmd +/-）"]`。

### 3.2 V9 — 窗口缩放后重新测量 → 真实指针命中

run1 与 run2 实测值逐字段一致（原文见 `verify/04-v9-v12-raw.txt`）：

| 项 | 值 |
| --- | --- |
| `viewRect`（缩放后实测原生视图矩形） | `{left:308, top:338, w:830, h:321}` |
| 缩放 `from`（OS 窗口，缩放前） | `{w:1440, h:940}` |
| 缩放 `to`（OS 窗口，缩放后） | `{w:1180, h:740}` |
| `click` | `{ok:true, attempt:1, trace:[{ours:162275, front[0]={pid:25293,id:162275}, activePid:25293}]}` |
| `last`（页面自己收到的落点） | `{x:190, y:185, target:"paint-btn"}` |
| 目标页面坐标 | `{x:190, y:185}` |
| 落点误差 | **dx = 0，dy = 0** |
| V9b 像素 | `image=[2360,1480]`，`win={w:1180,h:740}`，比例 2.0（与全局 scale 一致） |

**判定**：成立。缩放**之后**才做像素扫描 → 视图矩形 → 唯一换算器 → `safeClick`，页面回报的 `__lastClick` 与目标**完全相等（误差 0px ≤ 8px 判据）**，且 `target=paint-btn` 证明命中的是按钮本体；截图尺寸随窗口变化，说明确实是缩放后的画面。

### 3.3 V11 — 网页四边近边界逐落点（8 行表）

数据来源：run2 的**完整未截断**探针原文 `verify/captured/payload-001-2955.json`（run1 落盘的 V11 `actual` 只到 2400 字符：7 个落点名可见，其中 6 个完整、第 7 个"左下角内"截在 trace 中间、第 8 个"右下角内"整条缺失；这 6 个完整落点的 `pixel` / `pixelGreen` / `last` 与 run2 **逐字段一致**）。
`viewRect = {left:308, top:338, w:830, h:321}`（pw=830，ph=321，角内缩 corner=24）。

| # | 落点 name | page {x,y} | screen {x,y} | pixel | pixelGreen | click.ok | click.reason | click.attempt | last {x,y} (target) | \|dx\| | \|dy\| | 该落点单独判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 上边中点 | 415, 3 | 723, 341 | `56,123,83` | true | **true** | — | 1 | 415, 3 (`HTML`) | 0 | 0 | **PASS** |
| 2 | 下边中点 | 415, 317 | 723, 655 | `56,123,83` | true | **true** | — | 1 | 415, 317 (`BODY`) | 0 | 0 | **PASS** |
| 3 | 左边中点 | 3, 161 | 311, 499 | `56,123,83` | true | **true** | — | 1 | 3, 161 (`BODY`) | 0 | 0 | **PASS** |
| 4 | 右边中点 | 826, 161 | 1134, 499 | `56,123,83` | true | **true** | — | 1 | 826, 161 (`BODY`) | 0 | 0 | **PASS** |
| 5 | 左上角内 | 24, 24 | 332, 362 | `56,123,83` | true | **true** | — | 1 | 24, 24 (`title`) | 0 | 0 | **PASS** |
| 6 | 右上角内 | 806, 24 | 1114, 362 | `56,123,83` | true | **true** | — | 1 | 806, 24 (`title`) | 0 | 0 | **PASS** |
| 7 | 左下角内 | 24, 297 | 332, 635 | `56,123,83` | true | **true** | — | 1 | 24, 297 (`BODY`) | 0 | 0 | **PASS** |
| 8 | 右下角内 | 806, 297 | 1114, 635 | `56,123,83` | true | **true** | — | 1 | 806, 297 (`BODY`) | 0 | 0 | **PASS** |

单独判据（与门禁一致）：`pixelGreen && last && |last.x-page.x|<=6 && |last.y-page.y|<=6`。

- **实际成功发出真实点击的落点：8 / 8**，分别是**上边中点、下边中点、左边中点、右边中点、左上角内、右上角内、左下角内、右下角内**。
- **没有发出点击的落点：0 个**，无 `reason`。
- 每个落点的 `click.trace` 都是同一条：`{ours:162294, front[0]={pid:28497, id:162294}, activePid:28497}`，且都是 **attempt=1**（一次通过，未触发 1400ms 重试）。
- 8 个落点的独立像素通道全部**经判据认定为网页绿色**（站点纯色 `#0a7d4f = (10,125,79)`；色彩管理后实测读数 `56,123,83`；判据为**绿色启发式**，阈值 40/20，实测余量 67/40；`pixelGreen=true`）—— 更正 3 / F3，判据**未放宽**，只是措辞收紧 —— 证明换算出的屏幕点**确实落在网页上**，而不是"点到别处但页面恰好收到坐标"。

> **与上一批的差别（重要，不得概括为"没发点击"）**：上一批（`51-visibility-rerun.txt`）V11 中"左边中点 / 右边中点 / 左上角内"等**部分落点是 `click.ok=true, attempt=1` 成功发点击的**，失败的只是 `not-frontmost` 那几个；本轮 **8/8 全部成功**。上一批整项 FAIL 是前台被 `pid 83502`（Google Chrome，window id 160240）占据所致。

> **证据截断的如实说明**：run1 的门禁产物 JSON 里 V11 的 `actual` 被 `record()` 截到 2400 字符，落盘只剩 7 个落点（"右下角内"整条缺失、"左下角内"截在 trace 中）。上表完整原文来自 run2 的只读旁路捕获（§2.2），**判据本身未被改动**；run1 可读的 7 个落点与 run2 逐字段一致。

### 3.4 V12 / V12b — 最大化 → 恢复

run1 与 run2 实测值逐字段一致：

**V12（最大化）**

| 项 | 值 |
| --- | --- |
| `frontOk`（`ensureFrontmost` 前置确认） | `true` |
| 按钮 | `label=最大化browser`，`rect={left:218, top:72, w:12, h:12}`，`elementAtPoint=最大化browser`（DOM 命中测试压在按钮本体） |
| 按钮屏幕点 / 该点像素 | `{x:368, y:111}` / `97,197,84`（非网页绿 → 落在窗口按钮上） |
| `click` | `{ok:true, tries:1, trace:[{i:0, click:{ok:true, attempt:1}, received:true}]}` |
| `shellGot`（外壳收到该按钮的 `isTrusted` 点击） | `true`，`shellClicks=[{trusted:true, x:224, y:78, target:"svg", button:"最大化browser"}]` |
| `stateChanged`（出现「还原」按钮） | `true` |
| `windowRect` before → after | `{left:164, top:56, w:830, h:570}` → `{left:0, top:38, w:1180, h:702}` |
| `pageSize` before → after | `{iw:830, ih:321}` → `{iw:1180, ih:453}` |
| `layoutChanged` / `pageChanged` | `true` / `true` |
| `viewFollows`（像素实测视图矩形 = 网页自报尺寸，±3pt） | `true`，`viewRectAfter={left:144, top:320, w:1180, h:453}` |
| 最大化后网页再被真实指针命中 | `hit={x:590, y:227, target:"BODY"}`，目标 `{590, 227}`，**误差 0px**，`hitOk=true` |
| 像素帧 | `10-maximize-before.png` → `10-maximized.png` |

**V12b（恢复）**

| 项 | 值 |
| --- | --- |
| `restState`（重新出现「最大化」按钮） | `true` |
| `click` | `{ok:true, tries:1, trace:[{i:0, click:{ok:true, attempt:1}, received:true}]}` |
| `windowRect` before / max / restored | `{164,56,830×570}` / `{0,38,1180×702}` / **`{164,56,830×570}`** |
| `pageSize` before / restored | `{iw:830, ih:321}` / **`{iw:830, ih:321}`** |
| `backLayout` / `backPage` / `backView` | `true` / `true` / `true` |
| `viewRectRestored`（恢复后像素实测） | `{left:308, top:338, w:830, h:321}` —— 与最大化前 V11/V9 的视图矩形**完全相同** |
| 像素帧 | `11-restore-before.png` → `11-restored.png` |

**判定**：成立。最大化 → 窗口矩形、网页布局（`innerWidth/Height`）、像素实测视图矩形三者同步变化，且最大化后网页仍能被真实指针精确命中（误差 0px）；恢复 → 「窗口矩形」「网页布局」「像素实测视图矩形」三项**逐值回到最大化之前**，`backLayout/backPage/backView` 全为 true。

---

## 4. 每次真实点击前的窗口身份检查证据（safeClick trace）

门禁 `record()` 落盘里带完整 `{ours, front, activePid}` 的 trace 共 **12 条/轮**（V11 的探针 trace 因 2400 截断落盘 7 条，完整 8 条见对照文件）：

| 轮次 | trace 条数 | `front[0].id === ours` | `front[0].pid === activePid` | `ours`（窗口 id） | `activePid` |
| --- | --- | --- | --- | --- | --- |
| run1 | 12 | **12 / 12** | **12 / 12** | `162275` | `25293`（= 本实例 pid） |
| run2 | 12 | **12 / 12** | **12 / 12** | `162294` | `28497`（= 本实例 pid） |

代表性命中摘录（原文）：

- V3b：`{"ok":true,"attempt":1,"trace":[{"ours":162275,"front":[{"pid":25293,"id":162275},{"pid":18158,"id":152537},{"pid":24060,"id":162238},{"pid":22673,"id":162008},{"pid":83940,"id":160275}],"activePid":25293}]}`
- V9：`{"ok":true,"attempt":1,"trace":[{"ours":162275,"front":[{"pid":25293,"id":162275},…],"activePid":25293}]}`
- V11（8 个落点各 1 条，run2 完整）：`{"ours":162294,"front":[{"pid":28497,"id":162294},{"pid":18158,…},{"pid":24060,…},{"pid":22673,…},{"pid":83940,…}],"activePid":28497}`，8 条**完全相同**且均 `attempt=1`

**判读**：两次运行中，**每一次真实点击前的校验都满足"最前的 layer-0 窗口属于本进程，且本进程就是活跃 App"**，因此 `makeSafeClick` 从未走到 `activate` 重试分支，也**没有任何一次返回 `not-frontmost`**。这正面回答了上一批的疑点：那 3 项 FAIL 是前台被别的 App 抢走的**环境问题**，不是产品缺陷。

---

## 5. 截图 / 产物路径清单

### 5.1 原始路径（门禁自己的产物，脚本每次会覆盖）

原始路径 `artifacts/d5-01/d5-01-visibility-e2e.json` **会被脚本每次覆盖**，本轮结束后该路径上留的是 **run2** 的产物（`at=2026-10-01T13:17:00.232Z`，mtime 21:17）；run1 的产物已在 run1 结束后**立即**拷出，是本批唯一的 run1 快照。

| 用途 | 原始路径 | 本批拷贝路径 | 快照时间 |
| --- | --- | --- | --- |
| run1 产物 JSON | `artifacts/d5-01/d5-01-visibility-e2e.json`（已被 run2 覆盖） | `experiments/d5-03/batch15/artifacts/run1-visibility-e2e.json` | 2026-10-01 21:15 |
| run2 产物 JSON | `artifacts/d5-01/d5-01-visibility-e2e.json`（现留此份） | `experiments/d5-03/batch15/artifacts/run2-visibility-e2e.json` | 2026-10-01 21:17 |
| 截图目录 | `artifacts/d5-01/visibility/**`（同样被覆盖） | `.../artifacts/run1-visibility-frames/`、`.../artifacts/run2-visibility-frames/` | 见下 |

本次新增（覆盖写入）的截图文件名与 mtime（run1，18 张）：

```
01-paint-before.png      21:14:25     07-after-resize.png      21:14:40     10-maximize-before.png   21:14:51
02-tab-switch.png        21:14:32     08-burst-0.png           21:15:02     10-maximized.png         21:14:54
03-addressbar-focus.png  21:14:30     08-burst-1.png           21:15:02     11-restore-before.png    21:14:55
04-page-click.png        21:14:34     08-burst-2.png           21:15:03     11-restored.png          21:14:58
05-panel-open.png        21:14:36     08-burst-3.png           21:15:03     12-zoom.png              21:15:01
06-panel-closed.png      21:14:37     09-edges-frame.png       21:14:42
                                      09-edges.png             21:14:51
```

run2 同名单组，mtime 集中在 21:17:02。

### 5.2 本批证据文件

| 路径 | 说明 |
| --- | --- |
| `experiments/d5-03/batch15/00-prerun-facts.txt` | 运行前事实快照（date/HEAD/前台 App+pid/进程扫描） |
| `experiments/d5-03/batch15/10-visibility-run1.txt` | run1 全量 stdout+stderr（含文件头与 `EXIT CODE: 0`） |
| `experiments/d5-03/batch15/11-visibility-run2.txt` | run2 全量 stdout+stderr（含预载说明、文件头、`EXIT CODE: 0`） |
| `experiments/d5-03/batch15/artifacts/run1-visibility-e2e.json` | run1 产物 JSON 快照 |
| `experiments/d5-03/batch15/artifacts/run2-visibility-e2e.json` | run2 产物 JSON 快照 |
| `experiments/d5-03/batch15/artifacts/run1-visibility-frames/` | run1 的 18 张截图副本 |
| `experiments/d5-03/batch15/artifacts/run2-visibility-frames/` | run2 的 18 张截图副本 |
| `experiments/d5-03/batch15/verify/01-key-checks-raw.txt` | V3/V4c/V9/V9b/V11/V12/V12b 的 check 原文 |
| `experiments/d5-03/batch15/verify/02-v11-full-probes.txt` | V11 完整 8 落点原文（来自只读捕获） |
| `experiments/d5-03/batch15/verify/03-tables.txt` | run1/run2 对照表、V11 汇总、25 条 check 列表 |
| `experiments/d5-03/batch15/verify/04-v9-v12-raw.txt` | run1/run2 的 V9/V9b/V12/V12b 原文对照 |
| `experiments/d5-03/batch15/verify/05-check-table.md` | 25 条 check 的 markdown 表 |
| `experiments/d5-03/batch15/verify/06-run1-run2-normalized-diff.txt` | run1/run2 归一化逐字符比对（pid 归一），差异条目数 = 1（仅 V10 PNG 字节） |
| `experiments/d5-03/batch15/verify/evidence-preload.mjs` | 只读证据补齐预载（新增工具，非产品、非门禁） |
| `experiments/d5-03/batch15/verify/captured/payload-001-2955.json` | run2 V11 未截断探针原文（2955 字符，8 落点） |
| `experiments/d5-03/batch15/D5-03-BATCH15-E1-REPORT.md` | 本报告 |

---

## 6. 与 CLOSURE4 基线（25 / 0 / 1，exit 0）的对照 —— 汇总一致 + 断言名单未变（更正 2 / F2）

**基线来源**：`docs/D5-01-CLOSURE4-RESULT.md` §4 表 G1（`:100`）—— 完整可见性门禁 `npm run test:d5-01-visibility` = **25 PASS / 0 FAIL / 1 NOT VERIFIED，退出码 0**。

> **提交标识澄清（已由上级确认，不再待确认）**：任务书引用的 CLOSURE4 标识 **`fe6c9bf` 是「文档提交」**（把 `docs/D5-01-CLOSURE4-RESULT.md` 加进来的那个提交）；该文档正文记录的**代码提交**是 **`ebc9d21`（修复前基线）→ `f9564b7`（修复后被测）**。两者都对、指代不同对象，**不是矛盾**。（另：任务书某处引用的 `ebc9d47` 不存在 —— `fatal: ambiguous argument`；真实修复前基线为 `ebc9d21`，本报告用对了。）

**（a）可直接核实的汇总对照（有出处，可核对）**：

| 项 | CLOSURE4 基线 | 本批 run1 | 本批 run2 | 差异 |
| --- | --- | --- | --- | --- |
| pass / fail / total | 25 / 0 / 25 | 25 / 0 / 25 | 25 / 0 / 25 | 无 |
| EXIT | 0 | 0 | 0 | 无 |
| NOT VERIFIED 项 | 1（页面缩放 Cmd +/-） | 1（同名、同理由） | 1（同名、同理由） | 无 |

**（b）由「断言名单未变」推出的逐条口径对照（不是快照比对）**：

| 项 | `f9564b7`（CLOSURE4 被测版） | 当前（`2d50986`） | 差异 |
| --- | --- | --- | --- |
| `record()` 25 条断言**名单**（name 清单 diff） | 25 条 | 逐条**同名**，名单 diff 为空 | 无 |
| NOT VERIFIED 项名单 | 页面缩放（Cmd +/-） | 同名 | 无 |
| 判据 / 阈值 | V9 ≤8px、V11 ≤6px + `pixelGreen`、V12 ≤6px、`status = ok ? "PASS" : "FAIL"` | **逐字未变** | 无 |

→ **结论：与基线【汇总一致（25 / 0 / 1 + exit 0）】且【断言名单未变】→ 据此推出「逐条判定口径未变」。**

**证据强度限制（如实登记，不允许高估 —— 更正 2 / F2）**：

- CLOSURE4 期的 **25 条逐条状态快照并未冻结**：`artifacts/` 被 `.gitignore` 忽略且已被后续运行覆盖，仓库内**不存在**该快照；`docs/D5-01-CLOSURE4-EVIDENCE.json` 的 `gates[0]` 只有 counts / notVerified / exitCode。
- 故本报告**不是**"与基线逐条快照的直接比对"，**只是**"汇总一致 + 断言名单未变"的**推论**；真正的**同环境实测快照对照**是下面的「与上一批（batch14）」对照。
- **不得**写成"与 CLOSURE4 基线逐条一致/无差异需解释"。

**与上一批（`ac019a5` / batch14）的差异对照（本批要闭环的对象）**：

| 项 | 上一批实测 | 本批实测 | 差异原因 |
| --- | --- | --- | --- |
| V9 | **FAIL** `not-frontmost:page-button-after-resize`，3 次重试全失败；`click.ok=false` | **PASS**，`click.ok=true, attempt=1`，落点误差 0px | 前台争用：上一批 `front[0]={pid:83502（Google Chrome）, id:160240}`、`activePid=83502`；本批 `front[0]=本实例`、`activePid=本实例` |
| V11 | **FAIL**，8 个落点里部分 `not-frontmost`（如"上边中点/下边中点"），部分成功（如"左边中点/右边中点"，`attempt=1`） | **PASS**，**8/8 成功发点击**，误差 0px | 同上，纯环境 |
| V12b | **FAIL** `not-received:restore`，内层 3 次全 `not-frontmost:restore`；`restState=false`，窗口停在最大化态 | **PASS**，`attempt=1`、`received=true`、`restState=true`，矩形与布局逐值回位 | 同上，纯环境 |
| 其余 22 条 | PASS | PASS | 无 |
| 合计 | 22 / 3 / 25，EXIT=1 | **25 / 0 / 25，EXIT=0** | 3 项差异全部由前台争用消除 |

---

## 7. 未验收项与遗留项（如实）

1. **页面缩放（Cmd +/-）— NOT VERIFIED（1 项，两轮相同）**：这是门禁**固有不计入必需项**的既有登记项（原文理由：D5-01 原始必需项不含页面缩放，PLAN 的"缩放"指窗口缩放、已由 V9 覆盖；产品无该入口、本轮不新增）。实测补充记录：真实按键 `{iw:830,ih:321,dpr:2}` → 同值 → 同值（未改变页面缩放），缩放态像素真值与网页自报 `innerWidth×dpr` 一致。**本批不放宽、不改写该登记。**
2. **门禁自身的证据截断（新发现的工具局限，非产品缺陷）**：`visibility-e2e.mjs:44` 把 `actual` 截到 2400 字符，导致 V11 最后一个落点在**门禁自己的产物**里不可读。本批用**只读旁路捕获**（§2.2）补齐，**未修改门禁文件**。（更正 4 / F4）**两轮证据强度不对称**：未截断的逐落点原始值**只有 run2 有**（`verify/captured/payload-001-2955.json`），**run1 的落点 7「右下角内」无任何原始值**，run1 的 8 落点结论由「门禁进程内对 8 项 `edgeOk` 求值 + 该 check PASS」支撑；payload 第 **2400–2955** 字符除该旁路文件外**无外部绑定**（残余信任边界），支撑性交叉核对为「落点 7 与落点 3/6 构成 `830−24=806`、`321−24=297` 的镜像自洽 + 进程内对 8 项求值 + run1（无预载）同样 PASS」。**本批不改截断上限**（避免作废既有两轮绿证据，属上级裁决）；**独立验收 F7 建议尽快另开批次修**（提高上限或按落点分段截断，使门禁自身产物即可完整回溯）。
3. **V13 页面缩放 / 其它 D5-01 必需项**：本轮不在范围内，未动。
4. **前台环境**：本轮两次运行期间没有并发自动化，但机器上仍有常驻的 `agent-browser` 守护进程与 Chrome/Claude/ChatGPT/NOVAI/DeepSeek Harness 等 App。若后续要复跑，仍需一段确认无人操作屏幕的**独占前台**窗口；否则会重现上一批的 `not-frontmost`（判据不得因此放宽）。
5. **未做的事**：未 commit / push / merge / rebase / amend；未碰主工作树 `/Users/wepingli/Desktop/OpenArc OS`；未碰 `src/`、`electron/`、`tests/`、`DESIGN_SYSTEM.md`、`MOTION_SYSTEM.md`、`PLAN.md`；未改 `experiments/d5-01/**`。
6. **判定口径**：**本批（D5-01 visibility 未验收项闭环）= PASS（限定范围）**；**D5-03 整体 = PARTIAL**（其余批次范围内项目未完成 —— 9 个陈旧 `data-app-id` 探针、`browser-e2e.mjs:487` 脆弱点、门禁 2400 截断、及 batch14 登记的上游遗留）。
7. **独立验收（本报告定稿后到达）**：独立对抗性验收报告 `experiments/d5-03/batch15/verify/BATCH15-VERIFY-REPORT.md` 逐条列出 **F1–F7**；本报告已按其 F1（路径限定）/ F2（汇总一致 + 名单未变，登记证据强度限制）/ F3（像素措辞收紧）/ F4（两轮证据强度不对称 + 残余信任边界）**更正**，F5 疑点**已排除**（4 个 blob 哈希与 `ac019a5` 及当前工作树三者一致）、F6 为**任务书笔误**（`ebc9d47` 不存在，真实为 `ebc9d21`）、F7 建议**尽快另批修** 2400 截断。逐条处置表见 `D5-03-BATCH15-REPORT.md` §11。

---

## 8. 回归说明（无代码改动）

**本批无代码改动，故复用上一批仍有效的回归结果（`npm test` = 1412 tests / 1412 pass / 0 fail，EXIT=0），未重复运行。**

依据：`experiments/d5-03/batch14/70-npm-test-full.txt` 尾部原文 —— `# tests 1412 / # pass 1412 / # fail 0 / # cancelled 0 / # skipped 0 / ### EXIT=0`。（更正 1 / F1，路径限定）**本批无代码改动** = `git diff --stat -- src/ electron/ tests/ experiments/d5-01` 为空；`git diff --stat` 本身非空，只有 `PROGRESS.md` 与 `docs/D5-03-GATE-EVIDENCE.json` 两处**文档**改动，冻结区（`src/`、`electron/`、`tests/`、`experiments/d5-01/**`）无改动。真机可见性门禁本身已在本批用两轮独立实跑重新覆盖。

---

## 9. 结束状态

```
$ git diff --stat -- src/ electron/ tests/ experiments/d5-01
(空)

$ git diff --stat
 PROGRESS.md                   |  82 ++++++
 docs/D5-03-GATE-EVIDENCE.json | 628 ++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 710 insertions(+)

$ git status --porcelain
 M PROGRESS.md
 M docs/D5-03-GATE-EVIDENCE.json
?? experiments/d5-03/batch15/

$ git rev-parse HEAD
2d50986be46515678ad61494b09a4701565f8716

counts（run1 = run2）: {"pass":25,"fail":0,"total":25,"notVerified":1}   EXIT=0
```

- （更正 1 / F1）**无代码改动是路径限定的真陈述**：`git diff --stat -- src/ electron/ tests/ experiments/d5-01` **为空**；`git diff --stat` 非空且只有两处文档改动。上面是**收尾态**；取证阶段（写文档之前）`git diff --stat` 确实为空。
- 上一批登记为未验收的 **V9 / V11 / V12b 在本批全部实测为 PASS**（V11 为 8/8 落点、误差 0px），依据是两轮独立真机运行，非推断、非复用旧结论。
- **判定：本批（D5-01 visibility 未验收项闭环）= PASS（限定范围）；D5-03 整体 = PARTIAL。**
