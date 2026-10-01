# D5-03 第十五批 · 执行方报告（D5-01 visibility 未验收项闭环：V9 / V11 / V12b 真机实测）

- **被测代码树：`2d50986`**（`docs(d5-01): 第十四批结果与证据定稿（D5-01 真机门禁安装段修复）`）
- **父 commit：`ac019a5`**（`fix(d5-01): 第十四批 D5-01 真机门禁安装段修复（陈旧 Dock 选择器 + 入口缺失立即失败）`），`git log --oneline -2` 实测单父提交
- 工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`）
- 取证时 HEAD 实测：`git rev-parse HEAD` = `2d50986be46515678ad61494b09a4701565f8716`（先确认后开工）
- **本批无任何代码改动（路径限定，可核查）**：`2d50986` 是**文档提交**，本批**不产生新提交**，取证直接落在该 commit 的工作树上；`git diff --stat -- src/ electron/ tests/ experiments/d5-01` 为**空**；`git diff --stat` 本身**非空** —— 只有 `PROGRESS.md`（`82 +`）与 `docs/D5-03-GATE-EVIDENCE.json`（`628 +`）两处**文档**改动
- 取证目录：`experiments/d5-03/batch15/`（两轮真机原始 stdout+stderr 全部留存；逐项对照见 `verify/03-tables.txt`、`verify/05-check-table.md`）

## 0. 范围边界与本批「无代码改动」自证

### 0.1 范围边界（如实）

- **未** push / merge / rebase / amend / **commit**（本批由上级统一裁定，本岗只取证 + 写文档）。
- **未**触碰 `src/`、`electron/`、`tests/`、`package.json`、`DESIGN_SYSTEM.md`、`MOTION_SYSTEM.md`、`PLAN.md`；**未**触碰 `experiments/d5-01/**`（含被登记为截断点的 `visibility-e2e.mjs`）。
- **未**触碰 batch13（`experiments/d5-03/batch13/**`）与 batch14（`experiments/d5-03/batch14/**`）的既有证据 —— 旧批次证据保持原样。
- **未**触碰主工作树 `/Users/wepingli/Desktop/OpenArc OS`、DSH Desktop 共享运行时与 `~/.dsh`。
- **未**运行 `test:d5-01-visibility` 以外的任何真机前台脚本；两轮运行**串行**、中间无并发自动化。
- **未**新增、删除、放宽、跳过任何断言；**未**改任何判据 / 阈值 / expected；**未**把 FAIL 改成 NOT VERIFIED。
- 本批只**新增**两类非产品文件：① 只读证据补齐预载 `verify/evidence-preload.mjs`（挂在 run2 的 `NODE_OPTIONS=--import` 上，只旁路另存超长探针 JSON，**返回值与原函数完全相同**）；② 本报告与 `verify/**` 下的整理产物。

### 0.2 无代码改动自证（收尾态实测）

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
```

- **口径（路径限定，可核查）**：本批**无代码改动** —— `git diff --stat -- src/ electron/ tests/ experiments/d5-01` 为**空**；`git diff --stat` 本身**非空**，且**只有** `PROGRESS.md` 与 `docs/D5-03-GATE-EVIDENCE.json` 两处**文档**改动（本批三份 tracked 交付物中的两份；`experiments/d5-03/batch15/**` 为未跟踪证据目录）。
- **时点说明**：在写这三份文档**之前**（取证阶段），`git diff --stat` 确实是空的；本批文档写入后它不再为空。上面的输出是**收尾态**，不是取证态。
- `2d50986` 与其父 `ac019a5` 的差异**只有文档与 batch14 取证产物**：`git show --stat 2d50986` = `PROGRESS.md`、`docs/D5-03-GATE-EVIDENCE.json`、`experiments/d5-03/batch14/**`（报告 + 原始证据），**不含 `src/`、`electron/`、`tests/`、`package.json`、`experiments/d5-01/**`**；产品代码、测试代码、驱动脚本与 `ac019a5` **逐字节相同**。因此本批两轮真机结果直接归属于 **`2d50986` 的代码树**（= `ac019a5` 的产品代码）。

## 1. 运行环境

| 项 | 值 |
| --- | --- |
| 工作树 | `/Users/wepingli/Desktop/OpenArc OS-integration` |
| 分支 | `integration/ui-core` |
| HEAD（`git rev-parse HEAD`） | `2d50986be46515678ad61494b09a4701565f8716` |
| node | `v22.22.3` |
| electron | `44.3.0` |
| 真机命令 | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-visibility`（= `npm run build && node experiments/d5-01/visibility-e2e.mjs`，`package.json:61`） |
| 隔离实例 | 每轮由门禁自己拉起全新 Electron（`os.tmpdir()` mkdtemp 隔离 userData、隔离 CDP 端口 **9794**），与主工作树实例无关 |
| 并发 | 两轮期间**未**并发运行任何其它真机 e2e / `npm test` / 浏览器操作；未抢两台机器的前台 |

### 1.1 每轮运行前的前台 App 与 unix id（实测，原文见两轮文件头）

| 轮次 | 运行前前台 App | 运行前前台 unix id | 运行后前台 App |
| --- | --- | --- | --- |
| run1 | `ChatGPT` | `24060` | `Claude`（18158） |
| run2 | `Claude` | `18158` | `Claude`（18158） |

> 与任务书草稿的差异（如实）：任务书一度写"前台 App 是 `DeepSeek Harness`"，实测 **run1 运行前 = ChatGPT(24060)、run2 运行前 = Claude(18158)**；`DeepSeek Harness`（pid 83940）当时在 layer-0 顺序里**排在本实例窗口之后**（见 `verify/03-tables.txt` 的 `trace.front` 原文）。这不影响任何结论：两轮中门禁的安全闸与激活逻辑**第一次尝试（`attempt=1`）就把本实例窗口带到最前并成为活跃 App**（§5）。

### 1.2 确认无并发自动化（运行前快照 `00-prerun-facts.txt`）

`pgrep -fl "electron|node --test|npm" | grep -v WorkBuddy` 的输出里**没有任何 `electron .` 真机实例、没有任何 `node --test`、没有任何 `npm test`**。仅有与本轮屏幕/前台无关的常驻后台服务：

- `coze-bridge-daemon`（pid 3279）
- MCP 服务若干（`mcp-server-commands` / `@modelcontextprotocol/server-filesystem`，pid 18205/18251/18252/18272/18288/18337/23517/23533）
- 自 9 月即存在的 `agent-browser` 常驻守护进程（pid 34932，CPU 0.0%，本轮未操作屏幕）

### 1.3 两轮的实例身份

| 轮次 | 门禁实例 pid | 本实例窗口 id | 隔离 userData | CDP 端口 |
| --- | --- | --- | --- | --- |
| run1 | 25293 | 162275 | `os.tmpdir()` mkdtemp | 9794（隔离） |
| run2 | 28497 | 162294 | `os.tmpdir()` mkdtemp | 9794（隔离） |

## 2. 两轮 counts、EXIT 与逐条 status 对照

| 轮次 | 命令 | counts（pass / fail / total） | notVerified | EXIT | 原始输出 |
| --- | --- | --- | --- | --- | --- |
| run1（**纯运行，无预载**） | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-visibility` | **25 / 0 / 25** | 1 | **0** | `10-visibility-run1.txt` |
| run2（同一门禁 + 只读证据补齐预载） | 同上 + `NODE_OPTIONS=--import=<无空格符号链接入口>` | **25 / 0 / 25** | 1 | **0** | `11-visibility-run2.txt` |

- 两轮的**结论行逐字相同**：`结论：PASS — {"pass":25,"fail":0,"total":25,"notVerified":1}`，`EXIT CODE: 0`。
- **两轮逐条 status 完全相同**（25 条同名同状态，差异 **0** 条）。把两轮的隔离实例 pid / window id 归一化后逐字符比对：**唯一数值差异是 `V10` 的四帧 PNG 字节数**（run1 `[346808,346954,347041,346901]` vs run2 `[346783,346863,346958,347062]`；PNG 压缩字节逐次微变，而 V10 只判"每帧真实落盘且 > 5000 字节"，两轮均 PASS）。比对原文与结论：`verify/06-run1-run2-normalized-diff.txt`（`逐条 status 相同: true`、差异条目数 = **1**）。
- 两轮**均未出现任何 `not-frontmost`**，也**未出现任何 `outside-content`**，因此**一次都没用到**"因争用重跑"的额度；run2 的唯一动机是补齐证据（§7）。
- 唯一的 1 项 `NOT VERIFIED` 两轮相同：**页面缩放（Cmd +/-）** —— 这是门禁**固有不计入必需项**的既有登记项（原文理由：D5-01 原始必需项不含页面缩放，PLAN 里的"缩放"指窗口缩放、已由 V9 覆盖；产品无缩放入口、本轮不新增）。**本批不放宽、不改写该登记。**

### 2.1 全部 25 条逐条 status（run1 / run2 一致）

| # | section | 判据（name） | run1 | run2 |
| --- | --- | --- | --- | --- |
| 1 | boot | V0 · 真实 electron . 启动（隔离 userData / 隔离 CDP 端口） | PASS | PASS |
| 2 | boot | V1 · 真实 UI 登录 admin | PASS | PASS |
| 3 | setup | V2 · 真实视图加载纯色页面（像素判定的基准） | PASS | PASS |
| 4 | safety | V3 · 真实点击前先确认「最前面的窗口就是我们自己的实例」 | PASS | PASS |
| 5 | pixel | V4 · 屏幕像素证明确实「看得见」网页（视口中心是页面纯绿） | PASS | PASS |
| 6 | pixel | V4b · 截图确实是本窗口的画面（图像尺寸 = 窗口 bounds × 缩放） | PASS | PASS |
| 7 | pixel | V4c · 三条独立通道一致：像素真值 = DOM 预留矩形 = 指针反推（\|Δ\|≤3pt，宽高也对） | PASS | PASS |
| 8 | pixel | V4d · 提示条/错误条存在时网页**让位**（条带高度 > 0，且条带内像素不是网页绿） | PASS | PASS |
| 9 | safety | V3c · 真实指针确实到达本实例外壳（热身点击） | PASS | PASS |
| 10 | safety | V3b · 真实点击只落在本实例窗口内（每次点击前重新校验前台与内容区） | PASS | PASS |
| 11 | pointer | V6 · 统一换算给出的地址栏坐标 + 真实指针 → 焦点真的进入输入框 | PASS | PASS |
| 12 | pointer | V5 · 真实指针点击标签栏「新建标签」→ 真的多出一个标签（外壳收到 `isTrusted` 点击） | PASS | PASS |
| 13 | pointer | V5b · 真实指针点击第二个标签 → 活动标签真的切换 | PASS | PASS |
| 14 | pixel | V5c · 操作前后两帧像素确实不同（画面真的变了） | PASS | PASS |
| 15 | pointer | V7 · 真实指针点击**网页内部**按钮 → 页面自己收到点击并计数 | PASS | PASS |
| 16 | pointer | V7b · 落点就是按钮本体（页面收到坐标 = 目标，误差 ≤ 6px，`target=paint-btn`） | PASS | PASS |
| 17 | pixel | V8 · 面板打开时网页**让位**（视口中心像素不再是页面绿） | PASS | PASS |
| 18 | pixel | V8b · 面板关闭后网页回到可见（像素回到页面绿） | PASS | PASS |
| 19 | pointer | **V9** · 窗口缩放后重新测量坐标，真实指针点击仍然命中页面内部（落点误差 ≤ 8px） | **PASS** | **PASS** |
| 20 | pixel | V9b · 缩放后截图尺寸随之变化（画面确实是缩放后的窗口） | PASS | PASS |
| 21 | pointer | **V11** · 网页**四边近边界**的真实指针命中（坐标由实测视图矩形换算；落点像素独立证明在网页内） | **PASS** | **PASS** |
| 22 | pointer | V12 · 真实指针点窗口「最大化」按钮 → 窗口状态 + 网页布局真的变化，且最大化后网页仍能被真实指针命中 | PASS | PASS |
| 23 | pixel | **V12b** · 恢复后窗口矩形与网页布局回到最大化之前，且像素真值跟着回到原位 | **PASS** | **PASS** |
| 24 | pixel | V10 · 连续截图可用（一段连续操作的多帧都真实落盘） | PASS | PASS |
| 25 | hygiene | H1 · 主进程无未处理错误 | PASS | PASS |

（完整 `actual` 摘要表见 `verify/05-check-table.md`；含 `expected` 的逐条清单见 `verify/03-tables.txt` 末段。）

## 3. 与 CLOSURE4 基线（25 / 0 / 1，exit 0）的对照 —— 汇总一致 + 断言名单未变（含证据强度限制）

**基线判据出处**：`docs/D5-01-CLOSURE4-RESULT.md:100` 的表 G1 行 —— 完整可见性门禁 `npm run test:d5-01-visibility` = **25 PASS / 0 FAIL / 1 NOT VERIFIED**，**退出码 0**（同表其余行：G2 `test:d5-01` 64/0/1、G3 `test:d5-01-control` 46/0/2、G4 窗口回归 55/0、G5 native 26/26、G6 提示可操作性 16/0）。

**（a）可直接核实的汇总对照**：

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

→ **结论：与基线【汇总一致（25 / 0 / 1 + exit 0）】且【断言名单未变】—— 据此推出「逐条判定口径未变」。**

**证据强度限制（如实登记，不允许高估）**：

- CLOSURE4 期的 **25 条逐条状态快照并未冻结** —— `artifacts/` 被 `.gitignore` 忽略且早已被后续运行覆盖，仓库内**不存在**该快照；`docs/D5-01-CLOSURE4-EVIDENCE.json` 的 `gates[0]` 只记录了 counts / notVerified / exitCode。
- 因此本批**不是**"与基线逐条快照的直接比对"，**只是**"汇总一致 + 断言名单未变"的**推论**；上表 (b) 是**判据口径**对照，不是状态快照对照。
- 真正**同环境实测快照对照**的是 §3.2 的上一批（batch14 · `ac019a5`）对照（有 `experiments/d5-03/batch14/50-…`、`51-…` 原始输出）。
- **不得**把本批写成"与 CLOSURE4 基线逐条一致/无差异需解释"。

### 3.1 基线提交标识的澄清（避免看起来像矛盾）

任务书引用的 CLOSURE4 标识 **`fe6c9bf`** 与文档正文里的 `ebc9d21` / `f9564b7` **都对，只是指代对象不同**：

| 标识 | 对象 | 实测 |
| --- | --- | --- |
| `fe6c9bf` | **文档提交** —— `docs(D5-01 Closure-4): 提示遮挡判定 + 最小修复 + 仪器收口报告与脱敏证据（D5-01 = PASS 限定范围）`，2026-09-20 17:14:29 +0800。`git show --stat fe6c9bf` = `PROGRESS.md` / `docs/D5-01-CLOSURE4-EVIDENCE.json`（新增 288 行）/ `docs/D5-01-CLOSURE4-RESULT.md`，共 3 files / +449 / −32，**不含产品代码** | 即"把 `docs/D5-01-CLOSURE4-RESULT.md` 加进来的那个提交" |
| `ebc9d21` | **代码提交 · 修复前基线** —— `test(d5-01): 权限提示遮挡取证探针 + Closure-4 追加结论（未定论，如实登记）`（该文档正文记录的"基线"） | 25/0/1 这一判据的**被测代码起点** |
| `f9564b7` | **代码/测试提交 · 修复后** —— `fix(d5-01): 提示条被原生视图盖住（网页不让位）+ 可见性仪器统一坐标换算`，2026-09-20 17:10:14 +0800 | 25/0/1 这一判据的**被测代码终点**（CLOSURE4 的绿证据于此取得） |

- 因此：**`fe6c9bf`（文档）与 `ebc9d21 → f9564b7`（代码/测试）不是矛盾，而是"文档提交"与"它记录的被测代码提交"两类不同对象。**
- 本批的对照基准取**文档正文的判据表**：`docs/D5-01-CLOSURE4-RESULT.md:100` 的 G1 行（25 PASS / 0 FAIL / 1 NOT VERIFIED，exit 0）。
- 与本批的对象关系：本批被测树 `2d50986` 是 `f9564b7` 的**后代**（`f9564b7` 是 D5-01 验收期基线），且**本批不改动任何与可见性几何相关的代码**（§0.2），故本批判定口径与基线**可比**；但基线逐条快照未冻结（见上文"证据强度限制"），**不主张逐条快照级一致**。

### 3.2 与上一批（batch14 · `ac019a5`）实测的对照 —— 本批要闭环的对象

上一批在同一条门禁上实测 **22 pass / 3 fail / 25 total / 1 NV，EXIT=1**，3 项 FAIL = `V9` / `V11` / `V12b`，全部 `reason="not-frontmost:…"`（前台 layer-0 首位始终是 Google Chrome，驱动**拒绝发送真实点击**）：

| 项 | 上一批（`ac019a5`）实测 | 本批（`2d50986`）实测 | 差异原因 |
| --- | --- | --- | --- |
| V9 | **FAIL** `not-frontmost:page-button-after-resize`，内层 3 次重试全失败、`click.ok=false` | **PASS** `click.ok=true`、`attempt=1`、落点误差 **0px** | 前台争用消除（上一批 `front[0]` = Chrome pid 83502 / win 160240；本批 `front[0]` = 本实例） |
| V11 | **FAIL**：8 个落点中**只有部分成功发出点击**（左/右边中点等 `attempt=1` 成功），另一些被拒为 `not-frontmost`，整项判 FAIL | **PASS**：**8/8 落点全部成功发出真实点击**、全部 `attempt=1`、误差 **0px** | 同上，纯环境 |
| V12b | **FAIL** `not-received:restore`，内层 3 次全 `not-frontmost:restore`、`restState=false`、窗口停在最大化态 | **PASS** `attempt=1`、`received=true`、`restState=true`，矩形与布局**逐值回位** | 同上，纯环境 |
| 其余 22 条 | PASS | PASS | 无 |
| 合计 | 22 / 3 / 25，EXIT=1 | **25 / 0 / 25，EXIT=0** | 3 项差异**全部**由前台争用消除 |

→ 上一批的 3 项 FAIL **不是产品缺陷**，是一次**前台被别的 App 抢走**的环境争用；本批在**独占前台**的窗口期两轮复现为 PASS。

## 4. 重点三项逐项（V9 / V11 / V12b）

### 4.1 V9 · 窗口缩放后重新测量坐标 → 真实指针仍然命中

| 观测项 | 实测值（run1 = run2） |
| --- | --- |
| 缩放 | `1440×940` → **`1180×740`** |
| 缩放后重测 viewRect | `{left:308, top:338, w:830, h:321}` |
| 点击 | `click.ok = true`，**`attempt = 1`**，无 reason |
| `last`（页面自报收到的落点） | `{x:190, y:185, target:"paint-btn"}` = **目标落点** |
| 落点误差 | **0px**（判据 ≤ 8px） |
| V9b 截图 | `image = [2360,1480]`，`win = 1180×740` → `2360 = 1180×2`、`1480 = 740×2`（比例一致） |

**判定：V9 从"未验收"改为"已验收"**（真机实测，非推断）。

### 4.2 V11 · 网页四边近边界的真实指针命中（8 行逐落点表）

数据源（**两轮证据强度不对称，必须看清**）：

- **run2**：逐落点原始值来自只读旁路文件 **`verify/captured/payload-001-2955.json`**（**未截断**，2955 字符、8 个落点齐全）。
- **run1**：**落点 7「右下角内」在 run1 无任何原始值** —— run1 无预载，其 `actual` 被 `record()` 截到 2400，落点 7 整条从未落盘（落点 6 也被截在 `trace` 中间）。run1 的"8 落点全部成立"由**门禁进程内对 8 项 `edgeOk` 求值后该 check 为 PASS** 支撑（而不是原始值逐条可读）。
- 因此本表**逐落点原始值只代表 run2**；**不得**把两轮写成证据强度等量齐观。

坐标口径：`page` = 网页内坐标（落点距网页左上角），`screen` = 屏幕 pt 坐标（由实测 viewRect `{left:308,top:338,w:830,h:321}` 换算）；`dx/dy = last − page`。

| # | 落点 | page | screen | pixel | pixelGreen | click.ok | reason | last（页面自报） | dx/dy | 单点判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 上边中点 | (415, 3) | (723, 341) | `56,123,83` | true | **true**（attempt=1） | — | (415, 3) `target=HTML` | 0 / 0 | **PASS** |
| 2 | 下边中点 | (415, 317) | (723, 655) | `56,123,83` | true | **true**（attempt=1） | — | (415, 317) `target=BODY` | 0 / 0 | **PASS** |
| 3 | 左边中点 | (3, 161) | (311, 499) | `56,123,83` | true | **true**（attempt=1） | — | (3, 161) `target=BODY` | 0 / 0 | **PASS** |
| 4 | 右边中点 | (826, 161) | (1134, 499) | `56,123,83` | true | **true**（attempt=1） | — | (826, 161) `target=BODY` | 0 / 0 | **PASS** |
| 5 | 左上角内（内缩 24pt） | (24, 24) | (332, 362) | `56,123,83` | true | **true**（attempt=1） | — | (24, 24) `target=title` | 0 / 0 | **PASS** |
| 6 | 右上角内（内缩 24pt） | (806, 24) | (1114, 362) | `56,123,83` | true | **true**（attempt=1） | — | (806, 24) `target=title` | 0 / 0 | **PASS** |
| 7 | 左下角内（内缩 24pt） | (24, 297) | (332, 635) | `56,123,83` | true | **true**（attempt=1） | — | (24, 297) `target=BODY` | 0 / 0 | **PASS** |
| 8 | 右下角内（内缩 24pt） | (806, 297) | (1114, 635) | `56,123,83` | true | **true**（attempt=1） | — | (806, 297) `target=BODY` | 0 / 0 | **PASS** |

**关键判读（必须写清）**：

- **8/8 个落点都成功发出了真实点击**，`click.ok=true`；**全部 `attempt=1`**，**没有一次**被安全闸拒绝，**没有任何 `not-frontmost` / `outside-content`**。**不得**概括为"没发点击" —— 那是上一批 `V9`/`V12b` 的情形，与本项不同。
- 8 个落点 `pixel` 全部**经判据认定为网页绿色**：站点纯色是 `#0a7d4f = (10,125,79)`，实测读数 `56,123,83` 是**色彩管理后的读数**（**不是**"纯绿"）；驱动判据是**绿色启发式**且有余量（**判据阈值 40/20，实测余量 67/40**），`pixelGreen=true` → **独立于门禁的坐标换算**，用屏幕像素证明落点确实在网页内容区内。判据**未放宽**，此处只是措辞收紧。
- 8 个落点的落点误差 **全部 0px**（判据 ≤6px），`last` 与 `page` 逐项相等。
- 8 条 `trace`（每次点击前的窗口身份检查）**完全相同**：`front[0] = {pid:28497, id:162294} = 本实例`，且 `front[0].pid === activePid`（§5）。
- **上一批对照**：上一批 V11 的 8 个落点里**只有部分成功发出点击**（左/右边中点等 `attempt=1` 成功），其余落点被拒为 `not-frontmost`，**整项判 FAIL**；本批 8/8 全部成功、整项 **PASS**。
- **残余信任边界（如实登记，独立验收 F4）**：payload 的第 **2400–2955** 字符（落点 6 尾部 + 落点 7 全条）**除该旁路文件外无外部绑定** —— 冻结产物只能校验到第 2400 字符。支撑性交叉核对有三条：**(a)** 落点 7 与落点 3/6 构成 `830−24=806`、`321−24=297` 的**镜像自洽**（第 4 个角正是该对称性所要求的位置）；**(b)** 门禁在**进程内**对 8 项 `edgeOk` 做 `every()` 求值后才 `record()`，故 PASS 在进程内**覆盖落点 7**；**(c)** run1（**无预载、独立进程**）同样 PASS。→ 判定该边界**不影响本批结论**，但它确实存在。
- **判定：V11 从"未验收"改为"已验收"**（run2 8/8 逐落点原始值 + run1/run2 两轮 PASS）。

### 4.3 V12b · 最大化 → 恢复的窗口矩形 / pageSize / viewRect 逐值回位

| 观测项 | 最大化前 | 最大化后 | 恢复后 | 回位判定 |
| --- | --- | --- | --- | --- |
| windowRect | `{left:164, top:56, width:830, height:570}` | `{left:0, top:38, width:1180, height:702}` | `{left:164, top:56, width:830, height:570}` | **逐值相同** |
| pageSize（网页自报） | `830×321` | `1180×453` | `830×321` | **逐值相同** |
| viewRect | `{left:308, top:338, w:830, h:321}` | `{left:144, top:320, w:1180, h:453}` | **`{left:308, top:338, w:830, h:321}`** | **逐值相同** |

- `V12`（最大化）：窗口「最大化browser」按钮真实点击 `click.ok=true`、`tries=1`、`received=true`；`stateChanged=true`、`layoutChanged=true`、`pageChanged=true`、**`viewFollows=true`**（原生视图跟着窗口走）、最大化后 `hit={x:590,y:227,target:"BODY"}`、`hitOk=true`。
- `V12b`（恢复）：`click.ok=true`、`tries=1`、`received=true`；**`restState=true`、`backLayout=true`、`backPage=true`、`backView=true`** —— 窗口矩形、网页布局、页面尺寸、视图矩形**四路同时回位**。
- **上一批对照**：上一批 `V12b` **FAIL** `not-received:restore`（内层 3 次全 `not-frontmost:restore`），`restState=false`、窗口停在最大化态，**根本没有还原**；本批 `attempt=1` 首次即成功、逐值回位。
- **判定：V12 / V12b 从"未验收"改为"已验收"**（真机实测）。

## 5. 安全闸证据

| 判据 | 实测（run1 / run2） |
| --- | --- |
| `not-frontmost` 出现次数 | **0 / 0**（两轮 stdout 与产物 JSON 均为 0） |
| `outside-content` 出现次数 | **0 / 0** |
| 每次点击前的窗口身份检查 `{ours, front, activePid}` | 两轮各自落盘 12 条完整 trace，**12/12 满足 `front[0].id === ours` 且 `front[0].pid === activePid`** |
| `attempt` 字段 | 两轮产物 JSON 各 **34 处**、合计 **68 处**（同一行数据在 JSON 的 `checks` 与 `operationRecord` 两处各出现一次），**全部 = 1，无 2、无 3** —— 每次点击前的前台身份判据**第一次尝试即满足**，从未走到 `activate` 重试 |
| V11 的 8 个落点 | 8 条 trace 完全相同（`front[0]` = 本实例、`activePid` = 本实例 pid），**8/8 `attempt=1`** |
| `trace` 数据所在路径 | run1/run2 的 `actual` 原文在 `artifacts/run1-visibility-e2e.json` / `artifacts/run2-visibility-e2e.json` 的 `checks[*].actual` 与 `operationRecord[*].actual`；节选整理见 `verify/01-key-checks-raw.txt`（V3c/V3b/V9/V12/V12b）、`verify/03-tables.txt`（V11 trace 去重）、`verify/04-v9-v12-raw.txt`（两轮 V9/V9b/V12/V12b 对照）；V11 完整 8 条见 `verify/captured/payload-001-2955.json` 与 `verify/02-v11-full-probes.txt` |

**判读**：两次运行中**每一次真实点击前的校验都成立**（最前的 layer-0 窗口属于本进程，且本进程就是活跃 App），安全闸全程**零拒绝**；这正面回答了上一批的疑点 —— 上一批那 3 项 FAIL 是**前台被抢**的环境问题，不是产品缺陷，也不是判据被放宽。**本批没有放宽任何一条安全判据**。

## 6. 截图与产物清单

### 6.1 门禁原生产物（脚本每次运行会覆盖原始路径，本批均在运行结束后立即拷出）

| 用途 | 门禁原始路径 | 本批副本 | 性质 |
| --- | --- | --- | --- |
| run1 产物 JSON | `artifacts/d5-01/d5-01-visibility-e2e.json`（随后被 run2 覆盖） | `artifacts/run1-visibility-e2e.json`（31701 字节） | 门禁原生产物快照 |
| run2 产物 JSON | 同上（现留此份，`at=2026-10-01T13:17:00.232Z`） | `artifacts/run2-visibility-e2e.json`（31701 字节） | 门禁原生产物快照 |
| run1 截图 | `artifacts/d5-01/visibility/**` | `artifacts/run1-visibility-frames/`（**18 张**） | 门禁原生产物快照 |
| run2 截图 | 同上（覆盖） | `artifacts/run2-visibility-frames/`（**18 张**） | 门禁原生产物快照 |

18 张截图（两轮同名）：`01-paint-before.png`、`02-tab-switch.png`、`03-addressbar-focus.png`、`04-page-click.png`、`05-panel-open.png`、`06-panel-closed.png`、`07-after-resize.png`、`08-burst-0.png`、`08-burst-1.png`、`08-burst-2.png`、`08-burst-3.png`、`09-edges-frame.png`、`09-edges.png`、`10-maximize-before.png`、`10-maximized.png`、`11-restore-before.png`、`11-restored.png`、`12-zoom.png`。

### 6.2 本批整理 / 只读补齐产物

| 路径 | 性质 | 说明 |
| --- | --- | --- |
| `00-prerun-facts.txt` | 本批整理 | 运行前事实快照（date / HEAD / 前台 App+pid / 进程扫描） |
| `10-visibility-run1.txt` | 本批整理 | run1 全量 stdout+stderr（含文件头与 `EXIT CODE: 0`） |
| `11-visibility-run2.txt` | 本批整理 | run2 全量 stdout+stderr（含预载说明与边界） |
| `verify/01-key-checks-raw.txt` | 本批整理 | V3/V4c/V9/V9b/V11/V12/V12b 的 check 原文（**门禁产物**的摘录） |
| `verify/02-v11-full-probes.txt` | **只读补齐** | V11 完整 8 落点原文（来自只读旁路捕获） |
| `verify/03-tables.txt` | 本批整理 | run1/run2 对照、V11 逐落点汇总、发点击统计、trace 去重、25 条 check 列表 |
| `verify/04-v9-v12-raw.txt` | 本批整理 | 两轮 V9/V9b/V12/V12b 原文对照（另注明 run1 落盘被截断的事实） |
| `verify/05-check-table.md` | 本批整理 | 25 条 check 的 markdown 表 |
| `verify/06-run1-run2-normalized-diff.txt` | 本批整理 | run1/run2 归一化逐字符比对（pid 归一；差异条目数 = 1，仅 V10 PNG 字节） |
| `verify/evidence-preload.mjs` | **只读补齐工具** | **本批新增，不属于产品、不属于门禁**；包装 `JSON.stringify` 后返回值与原函数完全相同，只把 > 2000 字符的探针 JSON 另存一份 |
| `verify/captured/payload-001-2955.json` | **只读补齐** | run2 的 V11 未截断探针原文（2955 字符、8 个落点齐全） |
| `verify/captured/_index.txt` | 只读补齐（旁路副产物） | 写的是 `captured=0` —— npm / build / 门禁是**多个 node 进程**，每个都执行预载的退出钩子，最后退出的子进程（未捕获任何东西）覆盖了索引文件。**有效证据是 `payload-001-*.json` 本身，索引文件不作依据（如实登记，不掩盖）** |

> 门禁原生产物 = `10/11-*.txt`、`artifacts/run*-visibility-e2e.json`、`artifacts/run*-visibility-frames/`；只读补齐产物 = `verify/02-*`、`verify/captured/payload-001-2955.json`、`verify/evidence-preload.mjs`；其余是本批对原生产物的整理摘录（不含新事实来源）。

## 7. 门禁自身的证据截断：登记与裁决（重要）

### 7.1 事实（登记）

`experiments/d5-01/visibility-e2e.mjs:44` 的 `record()`：

```js
const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 2400), at: Date.now() };
```

即把 `actual` 切片到 **2400 字符**。V11 的 `actual` 是 8 个落点的完整 JSON（未截断时 **2955 字符**），因此：

- **门禁自己的产物 JSON（`artifacts/d5-01/d5-01-visibility-e2e.json`）与 stdout 里**：最后一个落点 **"右下角内"整条缺失**，"左下角内"被**截在 `trace` 中间**（实测 V11 落盘 `actual.length = 2400`，run1/run2 均是）。
- 因此 **run1 的落点 7「右下角内」没有任何原始值**（run1 无预载，从未落盘）；**未截断的逐落点原始值只有 run2 有**（`verify/captured/payload-001-2955.json`）。run1 的 8 落点结论由「门禁进程内对 8 项 `edgeOk` 求值 + 该 check PASS」支撑（详见 §4.2）。
- 这也是本批需要"补齐证据"才能给出 8 行逐落点表的唯一原因。

### 7.2 该截断**不影响判定**（必须写明）

- `status` 来自调用方传入的 **`ok` 参数**（`status: ok ? "PASS" : "FAIL"`），**不是**从 `actual` 字符串解析出来的；
- `failed` 计数（`if (ok) passed += 1; else failed += 1;`）与**退出码**同样只由 `ok` 决定；
- 因此 `.slice(0, 2400)` **只影响落盘 / 打印的证据字符串**，**不可能把 FAIL 变成 PASS，也不可能把 PASS 变成 FAIL**；本批 25/0/1、EXIT=0 的判定与这 2400 上限无关。

### 7.3 补齐方式（只读，不改任何冻结文件）

- 本批新增**只读旁路预载** `experiments/d5-03/batch15/verify/evidence-preload.mjs`，通过 `NODE_OPTIONS=--import=<无空格符号链接入口>` 挂在 **run2** 的门禁进程上；
- 它包装 `JSON.stringify`：**返回值与原函数完全相同**，只在结果字符串 > 2000 字符且含 `"probes"` / `"pixelGreen"` / `"hitOk"` / `"backView"` 等探针键时，把**原样未截断**的字符串另存一份到 `verify/captured/`；
- **不改任何冻结文件**（`experiments/d5-01/**` 一行未动）、**不改判据 / 阈值 / 返回值**、**不改 expected**、**不改门禁产物 JSON**；
- 旁路自身失败被 `try/catch` 吞掉且**绝不影响门禁**。

### 7.4 结论不依赖该预载

- **run1 是纯运行（无预载），同样 25 / 0 / 1、EXIT=0**；
- run2（带只读预载）与 run1 的 counts、EXIT、逐条 status **完全一致**，唯一 `actual` 数值差异是 V10 的四帧 PNG 字节数（与预载无关）；
- 因此 **"V9 / V11 / V12b 已验收"的结论不依赖只读预载**；预载只用于把 V11 的第 7、8 个落点从被截断的门禁产物里补齐出来。

### 7.5 裁决（上级）

**本批不改这个 2400 上限。** 理由：

1. **验收判据已满足** —— 两轮 25/0/1、EXIT=0，与 CLOSURE4 基线**汇总一致且断言名单未变**（§3，**不是**逐条快照比对），截断不影响判定（§7.2）；
2. **完整未截断数据已用只读方式留存并独立复算** —— `verify/captured/payload-001-2955.json`（2955 字符、8 落点，**仅 run2**）、`verify/02-v11-full-probes.txt`、`verify/03-tables.txt` 的 8 行表；另**如实登记残余信任边界**：payload 第 2400–2955 字符无外部绑定（§4.2），支撑性交叉核对成立；
3. **改动这个已冻结的仪器会作废本批两轮绿证据** —— `visibility-e2e.mjs` 属 D5-01 已冻结仪器，改它就需要重跑并重新取证，代价高于收益。

→ **登记为遗留项（§9 第 ① 条）**。**独立验收 F7 与我方一致认为本批不改，但不同意长期留作普通遗留项**：该缺陷使**门禁自身产物无法完整回溯**，会持续抬高每一轮独立验收的成本 → **建议尽快另开批次修**（例如把上限提高，或**按落点分段截断**，使门禁自身产物即可完整回溯，而不必依赖任何旁路）。

## 8. 回归复用说明（本批**未**运行回归）

**本批无代码改动，故不重复运行回归**，直接引用上一批（batch14）仍有效的结果：

| 项 | 结果 | 出处 |
| --- | --- | --- |
| `npm test` 全量 | **1412 tests / 1412 pass / 0 fail，EXIT=0**（`# tests 1412`、`# fail 0`、`# cancelled 0`、`# skipped 0`、`### EXIT=0`） | `experiments/d5-03/batch14/70-npm-test-full.txt` |
| D5-01 单测合并集 | **37 / 37 / 0，EXIT=0** | `experiments/d5-03/batch14/30-unit-d501-suite.txt` |
| D5-01 boundary 门禁 | **32 pass / 0 fail / 32 total / 1 NOT VERIFIED，EXIT=0** | `experiments/d5-03/batch14/40-boundary-after-fix.txt` |

**为何仍然有效**：

1. 本批**零代码改动** —— `git diff --stat -- src/ electron/ tests/ experiments/d5-01` 为空；`git diff --stat` 非空（仅 `PROGRESS.md` 与 `docs/D5-03-GATE-EVIDENCE.json` 两处文档改动）；
2. 上述结果取自 batch14 在 **`ac019a5` 的工作树**上的实测，而本批被测树 `2d50986` 与该 commit 的**产品代码 / 测试代码 / 驱动脚本逐字节相同**（`git show --stat 2d50986` 只列 `PROGRESS.md`、`docs/D5-03-GATE-EVIDENCE.json`、`experiments/d5-03/batch14/**`）；
3. 本批两轮真机门禁**重新覆盖了可见性链路本身**（`V0`–`V12b` 共 25 条），与回归结论不冲突、不重复。

**本批明确不主张**：本批**没有**运行 `npm test`、D5-01 单测、boundary 门禁；上表是**复用**而非**本批实测**。

## 9. 未验收项与遗留项（如实）

1. **`visibility-e2e.mjs:44` 的 2400 字符截断（本批唯一新发现的工具局限，非产品缺陷）**：见 §7。**本批不改**（理由见 §7.5），**登记为遗留项**；**独立验收 F7 建议尽快另开批次修**（提高上限，或按落点分段截断，使门禁自身产物即可完整回溯，不再依赖旁路）。**相关证据强度限制**：V11 **未截断**原始值**仅 run2 有**，run1 落点 7 无原始值；payload 第 2400–2955 字符无外部绑定（残余信任边界，见 §4.2）。
2. **其它 9 个仍使用陈旧 `data-app-id` 选择器的探针（本批未验证、未修改，仅列清单；均属另批范围）**：
   - `tests/d4-main-e2e.mjs:284`（`[data-app-id="settings"]`）
   - `tests/fixtures/model-isolation-ui-probe/main.cjs:59`
   - `tests/fixtures/model-settings-ui-probe/main.cjs:50`
   - `tests/fixtures/model-secret-ui-probe/main.cjs:90`
   - `tests/fixtures/resource-ui-probe/main.cjs:120`
   - `tests/fixtures/resource-library-ui-probe/main.cjs:127`
   - `tests/fixtures/resource-search-ui-probe/main.cjs:84`
   - `tests/fixtures/resource-preview-ui-probe/main.cjs:113`
   - `tests/fixtures/governance-ui-probe/main.cjs:82 / :117 / :136`（`organization` / `canvas` / `files`）

   （背景：产品树中 `data-app-id` **0 处**，batch14 已把 D5-01 的三个真机驱动改为 `[data-dock-id=…]` 并加即时失败守卫；以上文件与 D5-01 驱动同类，但**不在本批授权范围**。）
3. **`experiments/d5-01/browser-e2e.mjs:487` 的 `waitView` 脆弱点（本批未验证、未修改，属另批范围）**：`waitView("/cookie")` 超时返回 `undefined` 后，`:487` 直接 `JSON.parse(aCookie2).cookie.includes(...)` → `TypeError` **中止整段**，把"视图 15s 内未出现"这类**可能是真实产品症状**的信号变成脚本崩溃（batch14 记为 F3/F4，复现频次未知）。本批**不改它**（另一个门禁的驱动，超出授权）。
4. **`页面缩放（Cmd +/-）` 的 1 项 `NOT VERIFIED`（两轮相同，既有）**：属门禁**固有不计入必需项**的登记项（D5-01 原始必需项不含页面缩放），**本批不放宽、不改写该登记**，也不算本批新增未验收项。
5. **前台独占要求（复跑注意事项，非产品缺陷）**：本批两轮期间没有并发自动化，但机器上仍有常驻 `agent-browser` 守护进程与 Claude / ChatGPT / NOVAI / DeepSeek Harness 等 App。**若后续要复跑 `test:d5-01-visibility`，仍需一段确认无人操作屏幕的独占前台窗口**；否则会重现 batch14 的 `not-frontmost`（判据**不得**因此放宽）。
6. **上游继续单列（本批未动）**：跨组织真机 2 条 `notVerified`、两条探针门禁既有失败（`governance-ui`、`model-keychain-restart`）、OAuth、插件隔离（D5-08）、D5-02 `prompt()` 遗留、SIGKILL 边界、第五批登记其余残留。

## 10. 判定

- **本批（D5-01 visibility 未验收项闭环）= PASS（限定范围）**：
  - `test:d5-01-visibility` **两轮独立真机运行均 25 PASS / 0 FAIL / 25 total / 1 NOT VERIFIED，EXIT=0**（run1 纯运行、run2 同一门禁 + 只读证据补齐预载），与 CLOSURE4 基线 **25 / 0 / 1（exit 0，`docs/D5-01-CLOSURE4-RESULT.md:100` G1）汇总一致、且 25 条断言名单未变**（据此推出逐条判定口径未变；**不是**逐条快照比对，见 §3）；
  - **`V9` / `V11` / `V12b` 三项从"未验收"改为"已验收"**：V9 缩放后真实指针命中、落点误差 **0px**；**V11 8/8 个落点全部成功发出真实点击、全部 `attempt=1`、误差 0px**（落点像素经判据认定为**网页绿色**：站点纯色 `#0a7d4f`、实测读数 `56,123,83`、判据阈值 40/20、余量 67/40）；V12b 最大化→恢复的窗口矩形 / pageSize / viewRect **逐值回位**（`restState`/`backLayout`/`backPage`/`backView` 全 true）；
  - **安全闸全程零拒绝**：`not-frontmost` **0**、`outside-content` **0**，两轮 68 处 `attempt` 字段**全为 1**（首次即满足前台身份判据，未触发 `activate` 重试）；
  - **本批无代码改动（路径限定）**：`git diff --stat -- src/ electron/ tests/ experiments/d5-01` 为空；`git diff --stat` 非空（仅 `PROGRESS.md` 与 `docs/D5-03-GATE-EVIDENCE.json` 两处文档改动）；**未 commit / push / merge / rebase / amend**；
  - **回归复用**上一批（batch14）仍有效的结果（`npm test` 1412/1412/0、D5-01 单测 37/37、boundary 32/0/1），**本批未重复运行**。
- **本批不主张的部分**：① 不改任何门禁仪器（含 2400 截断）与判据；② 不主张 `页面缩放（Cmd +/-）` 的 1 项 NOT VERIFIED 有任何改变；③ 不主张 §9 第 2/3 条（9 个陈旧 `data-app-id` 探针、`browser-e2e.mjs:487`）有任何改善；④ 不主张与 CLOSURE4 基线"逐条快照一致"（基线逐条快照未冻结）。
- **D5-03 整体 = PARTIAL**（理由：本批只闭环了 D5-01 visibility 的 3 个未验收项；其余批次范围内项目未完成 —— 9 个陈旧选择器探针、`browser-e2e.mjs:487` 脆弱点、门禁 2400 截断、以及 §9 第 6 条全部上游遗留仍在）。

## 11. 独立验收发现与处置（F1–F7）

本批另有一名**独立对抗性验收岗**（全新上下文、与执行方无关联、**全程未运行任何真机/前台脚本、未抢前台**），报告在 **`experiments/d5-03/batch15/verify/BATCH15-VERIFY-REPORT.md`**（**他人产出，本批未改写**）。其结论：**未发现伪造或放宽**；两轮 `25/0/25`、逐条 status 差异 0、`attempt` 取值集合 `{1}`、`not-frontmost`/`outside-content` `0/0`、V11 8/8 且误差 0px、V9 误差 0px、V12b 逐值回位**均经其**重新解析 + 独立复算**确认**；它另实测**只读预载 18/18 用例输出逐字节相同**，并以 `captured/` 目录 **birthtime** 独立证明 **run1 期间该目录不存在**（故结论不依赖预载）；**阈值未放宽**（`f9564b7` ↔ 当前整文件 diff 仅 3 hunk / 49 行，全是 `ac019a5` 的向导与 dock 选择器；V9 ≤8 / V11 ≤6+`pixelGreen` / V12 ≤6 / `status = ok?"PASS":"FAIL"` 逐字未变，25 条断言名单 diff 为空）。

| # | 发现 | 处置（本批文档已改） |
| --- | --- | --- |
| **F1** | 「`git diff --stat` 为空」字面**不成立**（工作区有 `PROGRESS.md 82 +` 与 `docs/D5-03-GATE-EVIDENCE.json 628 +` 两处文档改动）；实质主张（无代码改动）成立 | **已更正为路径限定**：`git diff --stat -- src/ electron/ tests/ experiments/d5-01` 为空；`git diff --stat` 非空且**只有**两处文档改动。三份文档 + JSON 内同类表述**全部改掉**（§0、§8、§10 与 PROGRESS、E1 报告、JSON） |
| **F2** | 「与 CLOSURE4 基线逐条一致」**证据强度被高估**（基线逐条快照未冻结） | **已降级表述**为「**汇总一致 + 断言名单未变**（据此推出逐条判定口径未变）」；并**登记为证据强度限制**（§3：`artifacts/` 被 gitignore 且已被覆盖，`CLOSURE4-EVIDENCE.json` 的 `gates[0]` 只有 counts/notVerified/exitCode） |
| **F3** | 「像素**纯绿** `56,123,83`」不严谨（站点纯色 `#0a7d4f=(10,125,79)`，实测为色彩管理后读数；判据是绿色启发式） | **已改措辞**：统一写「落点像素**经判据认定为网页绿色**（站点纯色 `#0a7d4f`；色彩管理后实测读数 `56,123,83`；判据为绿色启发式，阈值 40/20，余量 67/40）」。判据**未放宽**（独立验收已复核） |
| **F4** | V11 **未截断**原始值**仅 run2 有**；run1 落点 7 **无任何原始值**；两轮证据强度**不对称** | **已标明**：run2 逐落点原始值来自只读旁路文件；**run1 落点 7 无原始值**，run1 的 8 落点结论由「门禁进程内 `edgeOk` 对 8 项 `every` 求值 + 该 check PASS」支撑；并**登记残余信任边界**：payload 第 **2400–2955** 字符（落点 6 尾 + 落点 7 全条）除该旁路文件外**无外部绑定**，支撑性交叉核对为「落点 7 与落点 3/6 构成 `830−24=806`、`321−24=297` 的镜像自洽 + 进程内对 8 项求值 + run1（无预载）同样 PASS」（§4.2） |
| **F5** | （独立验收**预设**的疑点）batch14 的 `experiments/d5-01/**` 驱动类回归结果被当作"零代码改动故可复用"，而 batch14 日志头部是 `HEAD: ae17ae9`、声称被测是 `ac019a5`，疑似归属不实 | **已排除，无需更正**：独立验收逐条复核 batch14 `testedCommitNote` 给出的 **4 个 blob 哈希与 `ac019a5:<path>` 及当前工作树三者一致**，且 `git diff --stat ae17ae9 ac019a5 -- src/ electron/ tests/ package.json …` 为空 → **复用前提成立**（本报告 §8 的复用仍有效） |
| **F6** | 任务书引用的 `ebc9d47` **不存在**（`fatal: ambiguous argument`）；真实修复前基线为 `ebc9d21` | **任务书笔误，执行方用对了**：本批三份文档 + JSON **一律写 `ebc9d21`**（§3.1 已澄清 `fe6c9bf`=文档提交、`ebc9d21`=修复前代码基线、`f9564b7`=修复后被测） |
| **F7** | `visibility-e2e.mjs:44` 的 **2400 字符截断仍在**：它使**门禁自身产物无法完整回溯** V11 最后一落点，独立验收必须依赖旁路文件 | **本批不改**（避免作废既有两轮绿证据，裁决见 §7.5）；**不同意长期留作普通遗留项** —— **建议尽快另开批次修**（提高上限或按落点分段截断，使门禁自身产物即可完整回溯） |

> 本报告已按独立验收的 **F1–F4 全部落笔更正**（F5 排除、F6 为任务书笔误、F7 建议另批尽快修）；**未改动的**：`verify/**`（含 `BATCH15-VERIFY-REPORT.md`）、`10-/11-*.txt`、`artifacts/**`、batch13/batch14 证据与任何代码。
