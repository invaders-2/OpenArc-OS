# BATCH15 · 独立验收报告（D5-01 visibility 未验收项闭环）

- 验收角色：**独立验收岗**，与执行方无关联；默认立场 = 怀疑，执行方与上级结论一律视为**待验证声明**。
- 工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`，分支 `integration/ui-core`
- 被测基线：**`2d50986be46515678ad61494b09a4701565f8716`**（`git rev-parse HEAD` 实测一致）
- 验收方式：**只读证据 + 重新解析 + 非屏幕复算**。**未运行** `test:d5-01-visibility`、**未运行** `experiments/d5-01/**` 下任何 `*.mjs`、**未启动** electron、**未抢占前台**。
- 未 commit / push / merge / rebase / amend；未修改任何冻结文件或既有证据；临时脚本仅置于 `/tmp/d5b15v/`。

---

## 0. 结论速览

| 项 | 我的独立判定 |
| --- | --- |
| 本批（D5-01 visibility 未验收项闭环） | **PASS（限定范围）** |
| D5-03 整体 | **PASS（限定范围）** —— 本批范围通过，D5-03 仍有未验证项（见 §10） |
| 结论独立性（run1 无预载） | **成立**（有独立于执行方叙述的物证，非依据其自述） |
| 阈值是否被放宽 | **未放宽**（V9 ≤8 / V11 ≤6+pixelGreen / V12 ≤6 / record 状态口径 与 CLOSURE4 版逐字相同） |
| 篡改/伪造迹象 | **未发现** |
| 执行方声明 | 7 条**全部成立**（其中 1 条字面表述不准确 F1、1 条证据强度被高估 F2、2 处措辞需收紧 F3/F4；1 个预设疑点经复核排除 F5） |

---

## 1. 卫生核实

```
$ git rev-parse HEAD                      → 2d50986be46515678ad61494b09a4701565f8716   ✓ 与声明一致
$ git rev-parse --abbrev-ref HEAD         → integration/ui-core                      ✓
$ git status --porcelain
   M PROGRESS.md
   M docs/D5-03-GATE-EVIDENCE.json
  ?? experiments/d5-03/batch15/
$ git diff --stat                         → PROGRESS.md 82+ , docs/D5-03-GATE-EVIDENCE.json 628+  （710 insertions, 0 deletions）
$ git diff --stat -- src/ electron/ tests/ experiments/d5-01   → 空 ✓（有代码路径零改动）
$ git status --porcelain experiments/d5-03/batch13 experiments/d5-03/batch14 → 空 ✓（旧批次证据未被修改）
```

**主工作树**（`/Users/wepingli/Desktop/OpenArc OS`，分支 `feature/d3-02-object-authorization`，HEAD `9119f857`）：

```
$ git status --porcelain | wc -l   → 17                       ✓ 须为 17
$ git status --porcelain | md5     → f53fad2f3a84d843ea45b66e93ded39e   ✓ 须为该值
```

**未 push**：

```
$ git ls-remote --heads origin | grep -c integration/ui-core   → 0    ✓
$ git branch -vv  → "* integration/ui-core 2d50986 docs(d5-01): 第十四批…"（无 upstream 标记，即未 push）✓
```

**无残留进程**：`pgrep -fl "electron|node --test|npm" | grep -v WorkBuddy` 输出中**没有** electron 实例、**没有** `node --test`、**没有** `npm test`（只有与本任务无关的 MCP server / agent-browser 常驻进程）✓

**我方零写入**：`find <worktree> -newermt '2026-10-01 21:24' -type f`（我方入场时刻之后）→ **空**。`artifacts/d5-01/visibility/*.png`、`dist/*` 的 mtime 为 21:16–21:17（执行方运行期），且均被 `.gitignore` 忽略（`.gitignore:3 artifacts/`、`:2 dist/`）。✓

> 执行方声明 6「`git diff --stat` 为空、`git status` 仅 `?? experiments/d5-03/batch15/`」**字面不成立**（见 §10-F1）；其实质主张「本批无代码改动」成立。

---

## 2. 我方独立解析计数表

解析对象：`experiments/d5-03/batch15/artifacts/run{1,2}-visibility-e2e.json`（**未使用**执行方的 `verify/0X-*.txt` 结论）。

| 项 | run1 | run2 |
| --- | --- | --- |
| 文件 sha256 | `c38f731204bd189b0d8a76c1fbe2108b3eea92c805a3287dc802e7d52fd8cb03` | `50fd9c0f548b3ccdce5b903fad5213551dd895dc3361cf1a3852de8db53becca` |
| `counts` | `{"pass":25,"fail":0,"total":25}` | `{"pass":25,"fail":0,"total":25}` |
| `pass+fail == total` | True | True |
| `checks` 长度 | 25 | 25 |
| `status` 取值分布（字段名确为 `status`） | `{"PASS": 25}` | `{"PASS": 25}` |
| `notVerified` 长度 / 内容 | 1 / `页面缩放（Cmd +/-）`（"不适用…V9 已覆盖"） | 1 / 同 run1，逐字相同 |
| `operationRecord` 长度 | 25 | 25 |
| 顶层键 | `phase,title,testedCommit,command,env,isolation,framesDir,checks,counts,notVerified,observations,operationRecord,at` | 同 run1 |
| 日志 `结论：PASS` / `EXIT CODE` | `{"pass":25,"fail":0,"total":25,"notVerified":1}` / `0` | 同 run1 / `0` |

> 注意：产物 JSON 里**没有** `exitCode` 字段（`d.get("exitCode")` 为 `None`）；退出码只在 `10-/11-visibility-run{1,2}.txt` 记 `EXIT CODE: 0`。若有人把"JSON 里 exitCode=0"当作证据，那是**读错字段**。

**两轮逐条 status 比对**：`checks` 与 `operationRecord` 各自 25 条 `(section, name, status)` 三元组 **两轮完全相同，差异项 0 条**。进一步逐字符比对：两轮 `actual` 归一化（隔离实例 pid/window id 归一）后**唯一差异**是 `V10` 四帧 PNG 的字节数（run1 `[346808,346954,347041,346901]` vs run2 `[346783,346863,346958,347062]`；V10 只判"每帧真实落盘"，两轮均 PASS）。→ 与执行方声明**一致**。

**`attempt` / 安全闸扫描（去重口径已说明）**：

- `checks` 与 `operationRecord` 是**同一批行对象的两次引用**（逐条 `section/name/status/expected/actual/at` 完全相等，实测 True）。因此**同一处 `attempt` 会被数两遍**。
- 去重口径：以 **`checks` 为一份**。

| 统计（以 checks 为一份，×2 得双写口径） | run1 | run2 |
| --- | --- | --- |
| `"attempt":1` 次数 | 17（双写 34） | 17（双写 34） |
| `attempt` 不同取值集合 | **{1}** | **{1}** |
| `"tries":1` 次数 | 5（前置前台身份判据） | 5 |
| `not-frontmost` 出现次数 | **0** | **0** |
| `outside-content` 出现次数 | **0** | **0** |
| `window-gone: / window-changed: / no-geometry` | 0 / 0 / 0 | 0 / 0 / 0 |
| `reason` 取值集合 | **空集** | **空集** |
| `{ours, front, activePid}` 完整 trace 条数 | 12 | 12 |
| 12/12 满足 `front[0].id===ours` 且 `front[0].pid===activePid` | True | True |

→ 声明 3（安全闸全程零 `not-frontmost`、零 `outside-content`，所有点击 `attempt=1`）**成立**。我复算的"每轮 34 处 attempt 双写、取值集合 {1}"与执行方 JSON 的 `safetyGate.attemptFields`（`perRunArtifact:34, bothRuns:68, distinctValues:[1], anyTwoOrThree:0`）**逐值一致**。

> 关于 `ours` 字段的口径（对抗性核对时的陷阱）：`ours` 是**窗口 id**（`win.id`），`activePid` 是**进程 pid**（`frontmostAppPid()`）。二者"不相等"是正常的，不是异常；正确判据是 `front[0].id === ours` 且 `front[0].pid === activePid`（`screen-geometry.mjs:189/192`）。我按正确判据复算：12/12 通过。

**run1 命令无 `NODE_OPTIONS` / run2 有**（读日志头部原文）：

- `10-visibility-run1.txt:4` → `命令: env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-visibility`（**无 NODE_OPTIONS**）✓
- `11-visibility-run2.txt:4` → `命令: env -u ELECTRON_RUN_AS_NODE NODE_OPTIONS=--import=/tmp/d5b15/preload.mjs npm run test:d5-01-visibility`（**有**）✓
- 另有**物证**（我方独立取得，不依赖执行方叙述）：`verify/captured/` 目录的 **birthtime = 21:16:12**，恰为 run2 起始时刻（run2 头 `开始时间(UTC) 13:16:12` = 本地 21:16:12）；run1 起始为 21:14:14。**run1 运行期间该目录尚不存在** → run1 不可能有旁路落盘。→ 「结论不依赖预载」**成立**。

---

## 3. V11 逐落点复算（我方 8 行表）

数据源：`experiments/d5-03/batch15/verify/captured/payload-001-2955.json`
—— 我方自行确认：**合法 JSON**（`json.load` 成功）、顶层键 `{viewRect, probes}`、`probes` **长度 8**、含 `viewRect`；sha256 `9584d84155fd7eb16595c14bb331247973ab37dd516b1ad0db2ee8109f8dcf3b`；2955 字符 / 3019 字节（差额 64 = 8 个中文落点名 UTF-8 额外字节，与**文件名声明长度 2955 自洽**）。
`viewRect = {left:308, top:338, w:830, h:321}`；判据（与门禁 `visibility-e2e.mjs:431` 一致）：`pixelGreen && last && |last.x-page.x| ≤ 6 && |last.y-page.y| ≤ 6`。

| # | 落点 | page | screen | pixel | pixelGreen | click.ok | click.reason | attempt | last (target) | \|dx\|,\|dy\| | **我方复算** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 上边中点 | (415, 3) | (723, 341) | 56,123,83 | true | true | — | 1 | (415, 3, HTML) | 0, 0 | **PASS** |
| 1 | 下边中点 | (415, 317) | (723, 655) | 56,123,83 | true | true | — | 1 | (415, 317, BODY) | 0, 0 | **PASS** |
| 2 | 左边中点 | (3, 161) | (311, 499) | 56,123,83 | true | true | — | 1 | (3, 161, BODY) | 0, 0 | **PASS** |
| 3 | 右边中点 | (826, 161) | (1134, 499) | 56,123,83 | true | true | — | 1 | (826, 161, BODY) | 0, 0 | **PASS** |
| 4 | 左上角内 | (24, 24) | (332, 362) | 56,123,83 | true | true | — | 1 | (24, 24, title) | 0, 0 | **PASS** |
| 5 | 右上角内 | (806, 24) | (1114, 362) | 56,123,83 | true | true | — | 1 | (806, 24, title) | 0, 0 | **PASS** |
| 6 | 左下角内 | (24, 297) | (332, 635) | 56,123,83 | true | true | — | 1 | (24, 297, BODY) | 0, 0 | **PASS** |
| 7 | 右下角内 | (806, 297) | (1114, 635) | 56,123,83 | true | true | — | 1 | (806, 297, BODY) | 0, 0 | **PASS** |

- **`click.ok = true` 的实际落点数：8 / 8**（不是"部分成功"，也不是"未发点击"）。
- **`reason` 非空的落点数：0**（不存在任何 `not-frontmost` / `outside-content`）。
- `attempt` 全部 = 1；8 条 `trace` 对象**彼此全等**（`front` 5 项列表完全相同）。
- 换算自洽：8/8 满足 `screen = (viewRect.left + page.x, viewRect.top + page.y)`。
- **声明 4 的 V11 部分成立**（逐落点 `pixelGreen=true`、`last` 与 `page` 误差 **0px** ≤ 6px）。

**对抗性检查 1 —— `last.target` 是否自洽**：`site.mjs:68` 定义 `target = e.target.id || e.target.tagName`；`site.mjs:26` 的 `html()` 会生成 `<body><h1 id="title">…`。因此：

- `y=3 → HTML`：由同产物 **V7 的 `pageGeo`**（`{scrollY:0, innerH:321, docH:342, innerW:830}`）解释——`docH - innerH = 21`，正是 `h1` 默认 `margin-top: 0.67em × 32px ≈ 21.4px` 塌陷到 body 之外的效果，故 `y=3` 落在 body 盒**之上**、命中最外层 `HTML`；**该数值不是旁路文件独有的，冻结产物里可独立核对**。
- `y=24 → title`：`h1#title` 盒约 `y∈[21.4, 59.8]`，`24` 落在其中；`x=24 / 806` 均在 830 宽内 ✓
- `y=161 / 297 / 317 → BODY`：均 > 59.8，落到 body ✓
- 未发现"`page == last` 但 `pixelGreen=false`"之类不一致；8/8 均为 `last == page` 且 `pixelGreen=true`。

**对抗性检查 2 —— 像素读数的口径（措辞需收紧）**：站点纯色是 `#0a7d4f = (10,125,79)`，而实测像素是 `(56,123,83)`。两者不同：这是 `screencapture` 色彩管理后的稳定读数，不是"纯色原值"。门禁判据 `isPageGreen` 是绿色启发式（`g-r ≥ 40 && g-b ≥ 20`），`(56,123,83)` 以 `67/40` 的余量通过（阈值 `40/20`）。→ 判据**未被放宽**，但执行方"全部为网页**纯绿** 56,123,83"的措辞不严谨（应写"经色彩管理的页面绿读数"）。该通道的作用是"落点确实在网页上而非别处"，与 `last==page` 互为独立佐证，本批结论不依赖该措辞。

### 3.1 截断影响的交叉核对（我方独立完成）

`record()`（`visibility-e2e.mjs:44`）为 `actual: String(...).slice(0, 2400)`：两轮 V11 的 `actual` 长度实测均为 **2400**，可见落点名 **7 个**（`上边中点…左下角内`，其中前 6 个完整、`左下角内` 截在 `trace` 中间），**`右下角内` 整条缺失**。与执行方报告的描述**逐字相符**。

逐字节比对（不解释、直接比字符串）：

| 比对 | 结果 |
| --- | --- |
| run2 冻结 `actual`(2400) vs payload 紧凑重排前缀(2400) | **逐字节相同 = True** |
| run1 冻结 `actual`(2400) vs payload 前缀(2400)，pid/window-id 归一化后 | **逐字节相同 = True** |
| 比对字段数 | 落点 0–5 **全部字段**（name/page/screen/pixel/pixelGreen/click.ok/click.reason/click.attempt/click.trace/last）+ 落点 6 的前段（name/page/screen/pixel/pixelGreen/click.ok/attempt）→ **全部相等，无一处被改写** |
| 落点在紧凑串中的起始偏移 | 0:62、1:421、2:784、3:1143、4:1507、5:1867、6:2230、**7:2591** |

**结论：截断只是"丢数据"，没有改写任何数值**；且 2400 之前的全部内容与冻结产物**逐字节绑定**。

**残余信任边界（如实登记）**：payload 的**第 2400–2955 字符**（`左下角内` 尾部 + `右下角内` 全条）**没有外部绑定**——它只存在于旁路捕获文件里，冻结产物无法校验。旁证有三：(a) 落点 7 的 `screen` 与 `viewRect+page` 自洽；(b) 落点 3/4/5/6 已构成左右/上下镜像（`830-24=806`、`321-24=297`），落点 7 正是该对称性的第 4 个角；(c) 门禁的 `edgeOk` 是在 `probes` 全部 8 项上 `every()` 求值后才 `record()`，故 run2 的 PASS **在进程内覆盖落点 7**，且 run1（无预载、独立进程）同样 PASS。→ 我判定该边界**不影响本批结论**，但它确实存在。

---

## 4. V9 复算

| 项 | run1 | run2 |
| --- | --- | --- |
| `last` | `{x:190, y:185, target:"paint-btn"}` | 同 run1 |
| `click.ok` / `attempt` | true / 1 | true / 1 |
| `viewRect` | `{left:308, top:338, w:830, h:321}` | 同 run1 |
| `from → to` | `1440×940 → 1180×740` | 同 run1 |
| `|last.x-190| ≤ 8` | 0 ≤ 8 ✓ | 0 ≤ 8 ✓ |
| `|last.y-185| ≤ 8` | 0 ≤ 8 ✓ | 0 ≤ 8 ✓ |
| **我方复算** | **PASS** | **PASS** |

`V9b`：`image=[2360,1480]`、`win={w:1180,h:740}` → 比例 2.0 = 全局 scale；`07-after-resize.png` 实测 **2360×1480**（`sips -g pixelWidth -g pixelHeight`）✓。缩放前 6 帧实测 2880×1880（=1440×940×2），与窗口尺寸一致 ✓。

→ 声明 4 的 V9 部分**成立**（缩放后误差 0px ≤ 8px，`click.ok=true`）。

---

## 5. V12b 复算

| 观测项 | before（最大化前） | restored（恢复后） | max（最大化态） |
| --- | --- | --- | --- |
| `windowRect` | `{left:164, top:56, width:830, height:570, cx:579, cy:341}` | `{left:164, top:56, width:830, height:570, cx:579, cy:341}` | `{left:0, top:38, width:1180, height:702, cx:590, cy:389}` |
| `pageSize` | `{iw:830, ih:321}` | `{iw:830, ih:321}` | `{iw:1180, ih:453}` |
| `viewRectRestored` | — | `{left:308, top:338, w:830, h:321}` | （V11/V9 同值） |

- `windowRect.restored == windowRect.before` **逐值全等 = True**（6/6 字段），`|Δw|=0 ≤ 4`、`|Δh|=0 ≤ 4` ✓
- `pageSize.before.iw/ih == restored` ✓
- `|viewRectRestored.w - iw| = 0 ≤ 3`、`|…h - ih| = 0 ≤ 3` ✓
- `restState = true`、`backLayout = true`、`backPage = true`、`backView = true`、`click.ok = true`
- **我方独立重算 `restoreOk` = True** ✓（run1 / run2 同值）

→ 声明 4 的 V12b 部分**成立**（恢复后 windowRect / pageSize / viewRect 逐值回位）。

---

## 6. 阈值未放宽 —— 版本对比结论

对比对象：**当前** `experiments/d5-01/visibility-e2e.mjs` ↔ **CLOSURE4 被测版 `git show f9564b7:experiments/d5-01/visibility-e2e.mjs`**（`f9564b7e5d75a831f694478f9b6c88536292fb4d`，2026-09-20 17:10:14，`fix(d5-01): 提示条被原生视图盖住…`；已确认是 HEAD 的祖先，且是 CLOSURE4 文档正文记录的被测代码提交）。

**整文件 diff 只有 3 个 hunk / 49 行**，全部落在"三步初始化向导驱动"与"Dock 选择器 `data-app-id`→`data-dock-id` + `mustClickDom` 入口即时失败"（即 `ac019a5` 的改动）：

```
@@ -59,6 +59,11 @@     入口点击即时失败 mustClickDom
@@ -110,10 +115,22 @@   三步初始化向导（setup-next 分步）
@@ -124,9 +141,9 @@    data-app-id → data-dock-id
```

**判定表达式逐字对比**：

| 断言 | f9564b7 | 当前 | 结论 |
| --- | --- | --- | --- |
| V7b | `|last.x-190| ≤ 6 && |last.y-185| ≤ 6 && target==="paint-btn"` | 同 | 未变 |
| **V9** | `r3.ok && last3 && |last3.x-190| ≤ **8** && |last3.y-185| ≤ **8**` | 同 | **阈值仍 ≤8** |
| **V11** | `every(e => e.pixelGreen && e.last && |last.x-page.x| ≤ **6** && |last.y-page.y| ≤ **6**)` | 同 | **阈值仍 ≤6、`pixelGreen` 仍为必需** |
| V12 | `hitMax.r.ok && last && |last.x-iw/2| ≤ 6 && …` | 同 | 未变 |
| V12b | `restState && backLayout(≤4) && backPage && backView(≤3)` | 同 | 未变 |
| **`record()`** | `status: ok ? "PASS" : "FAIL"`，`actual.slice(0,2400)` | 同 | **状态仍只由 `ok` 决定；不存在"把 FAIL 改记 NOT VERIFIED"的路径** |
| `notVerified()` | 独立函数，仅由显式调用触发 | 同 | 未变 |

**断言清单 diff（调用点名字级）**：`record("…","…")` 与 `notVerified("…")` 的**名字清单 diff 为空** → 25 条断言的**集合与名称两版逐条相同**；`record` / `notVerified` 调用点数两版相同。

→ **结论：阈值未被放宽、安全判据未被删除、未把 FAIL 改成 NOT VERIFIED。** 对比版本号：`f9564b7e5d75a831f694478f9b6c88536292fb4d` ↔ `2d50986`（实际代码树 = `ac019a5`）。

> 附带发现（非本批责任）：`ac019a5` 改动的是**门禁驱动脚本**，属"测试仪器"变更。它**只影响安装/登录段如何被驱动**，不触及 V9/V11/V12/V12b 的判定与阈值；但严格说 CLOSURE4 的 25/0/1 与本次 25/0/1 的可比性因此多了一层"仪器驱动变更"的中介。我判定该变更**只会让门禁更严**（入口缺失立即抛错，而不是 20s 超时后模糊 FAIL），不构成放宽。

---

## 7. 只读预载真的只读 —— 我方实测

对象：`experiments/d5-03/batch15/verify/evidence-preload.mjs`（sha256 `9140b61a093a52c2085d15693ba0e586bfc9105e581c7817e74bfd4b71a7dc2f`）。

**实测方法**：`/tmp/d5b15v/preload-test.mjs` —— import **前**抓住未打补丁的 `JSON.stringify` 存入局部变量 `before`，`BATCH15_CAPTURE_DIR=/tmp/d5b15v/cap`，`await import('file://…/evidence-preload.mjs')`，再取**新引用** `JSON.stringify`，对每个用例比较 `patched(x) === before(x)`（避免自递归）。

| 结果 | 值 |
| --- | --- |
| 用例数 | **18** |
| 逐字节相同 | **18 / 18** |
| 差异 | **0** |
| 覆盖用例 | 小对象、数组、字符串（含引号/换行/中文）、数字、`null`、`undefined`、布尔、含 `toJSON` 对象、40 层嵌套深对象、>2000 字符含 `pixelGreen`、>2000 含 `probes`、>2000 **不含** marker、含 `hitOk`、含 `backView`、`replacer` 参数、`space=2`、`space="\t"` |
| 补丁确实生效 | `patched !== before` = True（且实测产生了 3 个 payload 文件） |
| 旁路落盘正确性 | 写入的每个 payload：文件字符数 **== 文件名声明长度**；且 `patched(JSON.parse(txt)) === txt`（往返一致） |

**写入范围**：代码里仅 **3 处** fs 调用（`mkdirSync(OUT)`、`writeFileSync(path.join(OUT,name),text)`、`writeFileSync(path.join(OUT,"_index.txt"),…)`），OUT 只来自 `BATCH15_CAPTURE_DIR` 或 `verify/captured/`。实测把 OUT 指向 `/tmp/d5b15v/cap` 后，产物只出现在该目录；仓库侧 `find -newermt '<我方入场时刻>'` 为空 → **不写任何其它文件**。✓

**`_index.txt = captured=0` 的成因核实（并判断是否影响数据可信度）**：

- 机制核实：`process.on("exit")` 里用**各进程自己的 `seq`** 写 `_index.txt`，**后退出者覆盖先退出者**。我实测复现了同一现象：跑完测试后 `_index.txt` 内容为 `captured=6`，而它 `btime=…` 早于最后一次写入。
- 仓库内的证据链：`_index.txt` **btime 21:16:16**（run2 早期，某子进程 seq=0）→ **mtime 21:17:00**（run2 结束，另一个进程再写 `captured=0`）；而 `payload-001-2955.json` 的 btime 是 **21:16:47**（捕获者进程写入）。→ **最后的写入者不是捕获者**，故 `captured=0` 是"多进程退出钩子互相覆盖"的产物，**不是"没有捕获到"**。
- **是否影响第 3 步数据可信度：不影响**。理由：payload 的可信度不依赖 `_index.txt`，而依赖三条硬绑定 —— (a) 文件名声明长度 2955 == 文件字符数 2955（字节数 3019 = 2955 + 64，与 8 个中文名的 UTF-8 开销精确吻合）；(b) 其**前 2400 字符与 run2 冻结产物逐字节相同**（且 run1 归一化后亦然），把内容钉死在被审计的产物上；(c) 结构合法（`probes` 8 项、`viewRect` 齐备）且逐落点数值全自洽。执行方"`_index.txt` 不作依据"的说法**成立**。
- 唯一残余：第 2400–2955 字符无外部绑定（已在 §3.1 登记）。

---

## 8. 文档与旧证据核实

### 8.1 `docs/D5-03-GATE-EVIDENCE.json`

| 检查 | 实测 |
| --- | --- |
| `git diff --numstat` | **`628  0`** → **删除列 = 0** ✓（纯插入） |
| 自 `"batch14"` 起至 EOF vs `git show 2d50986:…` 对应区段 | 两侧 **len 均 295050**，**sha256 均 `44f957e8c67b85f9a4812ae8be908e6bd79daaee7eb18729c2a3a9f8561ca957`**，`==` 为 **True** ✓ |
| 我采用的偏移口径 | 从 `"batch14"` 前 **2 个字符**（即该行的行首缩进）起切片；执行方 `atNote` 声明的哈希正是此口径，**可精确复现**。说明：若改从 `"`（第 0 字符）起切片，两侧同为 `69fd4902…`/295048，**同样逐字节相同**——结论与口径无关 |
| `json.load` | **成功**（顶层 40 键） |
| `batch15` 是否首键 | **是**（键顺序 `batch15, batch14, batch13, …`）✓ |
| 与 `batch14` 同构 | **True**（双方键集完全相同：`assertionChanges, at, atNote, fix, judgement, leftovers, notVerified, openarcBranch, phase, redEvidence, rootCause, scopeBoundaries, testedCommit, testedCommitNote, verification`）✓ |

### 8.2 `PROGRESS.md`

| 检查 | 实测 |
| --- | --- |
| `git diff --numstat` | **`82  0`** → 删除列 = 0 ✓ |
| `git diff PROGRESS.md` 中以 `-` 开头的行 | **仅 1 行，且是 diff 头 `--- a/PROGRESS.md`**；**无任何 `-` 开头的实质内容行** ✓ |
| 纯追加的更强证明 | 2d50986 版全文是当前文件的**前缀**（`startswith` = True），增量区段以 `\n---\n\n# D5-03 第十五批 …` 开头 ✓ |

### 8.3 判据出处与提交标识

- `docs/D5-01-CLOSURE4-RESULT.md` 共 169 行；**第 100 行 = 表 G1 行**：`| G1 | 完整可见性门禁 | npm run test:d5-01-visibility | **25 PASS / 0 FAIL / 1 NOT VERIFIED** | **0** |` ✓ **与声明 2 的判据出处逐字相符**。
- `fe6c9bf` = **文档提交**（`docs(D5-01 Closure-4): 提示遮挡判定 + 最小修复 + 仪器收口报告与脱敏证据`，2026-09-20 17:14:29；`git show --stat` = `PROGRESS.md` + `docs/D5-01-CLOSURE4-EVIDENCE.json` + `docs/D5-01-CLOSURE4-RESULT.md`，3 files/+449/−32，**不含产品代码**）✓
- `ebc9d21` = **修复前基线（代码/测试提交）**（`test(d5-01): 权限提示遮挡取证探针 + Closure-4 追加结论`，16:33:29）✓；`f9564b7` = **修复后被测（代码/测试提交）**（17:10:14）✓
- `docs/D5-01-CLOSURE4-EVIDENCE.json` 的 `baseHead = ebc9d21…`、`testedCommit = f9564b7` ✓ —— 与文档正文一致。
- → **「两标识不矛盾」成立**（`fe6c9bf` 是承载文档的提交，`ebc9d21→f9564b7` 是文档所记录的代码前后态）。
- ⚠️ **任务书里的 `ebc9d47` 在本仓库不存在**（`git log -1 ebc9d47` → `fatal: ambiguous argument`）。执行方用的是正确的 `ebc9d21`；这是**任务书笔误**，不是执行方问题。

### 8.4 复用 batch14 的 `npm test 1412/1412/0`（声明 6）

- `experiments/d5-03/batch14/70-npm-test-full.txt` 尾部：`1..1406` / `# tests 1412` / `# pass 1412` / `# fail 0` / `# duration_ms 116538` / `### EXIT=0` ✓ **数值相符**。
- 该日志头部 `### HEAD: ae17ae9da17a475f267241fae0d56804db2794d2`（batch14 提交**之前**的父提交），而 batch14 声称的被测提交是 `ac019a5`。**我方独立核实该差异已被 batch14 如实解释，且解释可验证**：
  - batch14 的 `testedCommitNote` 明写：「全部真机/回归证据取证于**提交前的工作树**——当时 HEAD = `ae17ae9`，原始输出头部即该值、**未事后改写**」，并给出 4 个文件的 blob 哈希作为归属依据。
  - 我方逐条复核（`git rev-parse ac019a5:<path>` 与 `git hash-object <worktree>`）：

    | 文件 | 声明的 blob | `ac019a5:` | 当前工作树 |
    | --- | --- | --- | --- |
    | `experiments/d5-01/browser-control-e2e.mjs` | `3af6d489…d8ed` | 一致 | 一致 |
    | `experiments/d5-01/browser-inprocess-boundary-e2e.mjs` | `8a6186ca…859b` | 一致 | 一致 |
    | `experiments/d5-01/visibility-e2e.mjs` | `7570c4b8…632b` | 一致 | 一致 |
    | `experiments/d5-01/s0a-diagnose.mjs` | `f15bd3b3…2611` | 一致 | 一致 |

  - `git diff --stat ae17ae9 ac019a5 -- src/ electron/ tests/ package.json DESIGN_SYSTEM.md MOTION_SYSTEM.md PLAN.md` → 空（batch14 声明，我复核其文件清单：`ac019a5` 仅 4 个 `experiments/d5-01/*.mjs`）。
- → **复用合法**：`tests/**` 与 `src/**` 在两版之间零改动（`npm test` 前提成立）；`experiments/d5-01/**` 驱动类结果归属 `ac019a5` 的 blob，与**当前工作树逐字节相同**（上表）。这正是我此前预设的疑点，**核实后排除**（见 §10-F5）。

---

## 9. 截图清单与尺寸核实（只读）

| 目录 | PNG 数 | 非 PNG / 损坏 | 尺寸 |
| --- | --- | --- | --- |
| `artifacts/run1-visibility-frames/` | **18** | 无（`file` 全部为 `PNG image data`） | `01`–`06`：**2880×1880**（=1440×940×2）；`07`–`12`：**2360×1480**（=1180×740×2） |
| `artifacts/run2-visibility-frames/` | **18** | 无 | 同上 |

- `07-after-resize.png` **存在**，实测 **2360×1480** ✓ 与 `V9b` 声称的 `image=[2360,1480]` 一致。
- `11-restored.png` **存在**，实测 **2360×1480** ✓。
- 18 张/轮 与批次报告声明一致；尺寸分段（缩放前 2880×1880、缩放后 2360×1480）与窗口 `1440×940 → 1180×740` + scale=2 完全自洽 ✓。
- **溯源**：仓库活动产物 `artifacts/d5-01/d5-01-visibility-e2e.json` 的 sha256 **等于 run2 快照**（`50fd9c0f…`），`artifacts/d5-01/visibility/{07-after-resize,11-restored}.png` 也**等于 run2 快照**（`a9e3791a…` / `5015cdfd…`，run1 快照为不同 hash）→ 印证批次报告"run1 产物随后被 run2 覆盖"的如实披露 ✓（这是**诚实披露**，不是隐瞒）。

---

## 10. 发现清单（按严重度）

**无 S0 / S1（无造假、无阈值放宽、无结论不成立）。**

| 编号 | 严重度 | 发现 | 证据 |
| --- | --- | --- | --- |
| **F1** | S3（表述） | 声明 6 与证据 JSON 的 `fix.codeChanges` / `regressionReuse.reason` 写「`git diff --stat` 为空；`git status --porcelain` 仅 `?? experiments/d5-03/batch15/`」——**字面不成立**。实测 `git diff --stat` = `PROGRESS.md 82 +` / `docs/D5-03-GATE-EVIDENCE.json 628 +`；`git status --porcelain` 为 `M PROGRESS.md`、`M docs/…`、`?? experiments/d5-03/batch15/`。**实质主张（无代码改动）成立**（代码路径 diff 为空），但措辞应改为「`git diff --stat -- src/ electron/ tests/ experiments/d5-01` 为空；工作区另有本批自身的两份文档改动」。 | §1 命令输出 |
| **F2** | S3（表述） | 「与 CLOSURE4 基线**逐条一致**」的可验证边界未被写明：CLOSURE4 期的 25 条**逐条快照未冻结**（`artifacts/` 被 `.gitignore`，已被后续运行覆盖；仓库内不存在该快照）。可独立核实的只有：汇总 `25/0/1 + exit 0`（`CLOSURE4-RESULT.md:100`）、**断言清单与 `f9564b7` 逐条同名**（`record`/`notVerified` 名字清单 diff 为空）、NV 项同名。故"逐条一致"是**由"断言清单未变 + 两轮全 PASS"推出**，**不是**与基线逐条状态快照比对得来。建议改写为「与基线汇总一致，且断言清单相对 CLOSURE4 被测版逐条未变」。 | §6 断言清单 diff；`docs/D5-01-CLOSURE4-EVIDENCE.json` 的 `gates[0]` 只有 counts/notVerified/exitCode |
| **F3** | S4（措辞） | 「8 个落点的独立像素通道全部为网页**纯绿** 56,123,83」——`(56,123,83) ≠ #0a7d4f(10,125,79)`，是色彩管理后的读数。判据未被放宽，但"纯绿"不严谨。 | §3 对抗性检查 2 |
| **F4** | S4（限定） | V11 的**未截断**原始数据仅覆盖 **run2**；run1 的落点 6 尾部与落点 7 的原始值**从未落盘**（run1 无预载）。run1 的"8/8"只能由门禁进程内 `edgeOk`（8 项 `every`）与"前 2400 字符归一化后与 run2 逐字节相同"支撑。payload 第 2400–2955 字符无外部绑定。 | §3.1 偏移表（落点 7 起于 2591）；§1 btime 物证 |
| **F5** | ~~S4~~ **已排除** | **原疑点（我方预设）**：`regressionReuse` 把 `test:d5-01-boundary`（32/0/32）等 `experiments/d5-01/**` 驱动类结果作为"零代码改动故可复用"，而 batch14 日志头部是 `HEAD: ae17ae9`、声称的被测提交是 `ac019a5`，二者不同 → 疑似归属不实。**核实结果：疑点排除**。batch14 的 `testedCommitNote` 已如实说明证据取自"提交前工作树（HEAD=ae17ae9）"且未事后改写，并给出 4 个 blob 哈希；我方逐条复核这 4 个哈希与 `ac019a5:<path>` **及当前工作树**三者一致，且 `git diff --stat ae17ae9 ac019a5 -- src/ electron/ tests/ package.json …` 为空 → 复用前提**成立**。 | §8.4 哈希对照表 |
| **F6** | S4（信息） | 任务书引用的 `ebc9d47` **不存在**（`fatal: ambiguous argument`）；真实修复前基线为 `ebc9d21`。执行方用对了，任务书有笔误。 | §8.3 |
| **F7** | S4（残留工具缺陷） | `visibility-e2e.mjs:44` 的 2400 字符截断仍在（本批按裁决未改）。它使**门禁自身产物无法完整回溯** V11 最后一落点，独立验收必须依赖旁路文件。我认同"本批不改以免作废既有绿证据"，但该缺陷应尽快在独立批次修复（提高上限或按落点分段截断）。 | `visibility-e2e.mjs:44`；§3.1 |

**声明成立性逐条裁定**：

| 声明 | 裁定 |
| --- | --- |
| 1. 两轮均 25/0/1 EXIT=0；run1 纯运行（无预载），结论不依赖 run2 预载 | **成立**（并被我方独立物证加强） |
| 2. 与 CLOSURE4 基线 25/0/1 逐条一致（判据出处 `CLOSURE4-RESULT.md:100`） | **成立（口径需收紧，见 F2）** |
| 3. 零 `not-frontmost`、零 `outside-content`，所有 `attempt` 全为 1 | **成立** |
| 4. V11 8/8 真实点击、逐落点 `pixelGreen=true`、误差 0px（≤6px）；V9 0px（≤8px）；V12b 逐值回位 | **成立** |
| 5. 2400 截断不可能影响判定；完整数据已由只读预载留存 | **成立**（"不可能影响判定"经代码核实；"完整"限 run2，见 F4） |
| 6. 本批无代码改动，故复用 batch14 的 `npm test 1412/1412/0` | **成立**（措辞错，见 F1；复用前提经 blob 哈希独立复核成立，见 F5/§8.4） |
| 7. `D5-03-GATE-EVIDENCE.json` 纯插入、`PROGRESS.md` 纯追加、旧批次证据未动 | **成立**（哈希逐字节复现，`batch13/14` status 为空） |

---

## 11. 我不同意的地方

1. **不同意在证据 JSON 里保留"`git diff --stat` 为空"这句**（F1）。这是**可被判为不实的事实陈述**，虽不影响结论，但独立验收的第一原则是"可核查的陈述必须为真"。应改为限定路径的表述。
2. **不同意"与 CLOSURE4 基线逐项一致"的强表述**（F2）。在基线逐条快照未冻结的前提下，这句话的**证据强度被高估**了；正确表述是"断言清单未变 + 汇总一致"。
3. **不同意"像素纯绿"的措辞**（F3）。
4. **不同意把 run1 与 run2 的 V11 证据强度等量齐观**（F4）：run1 的落点 7 原始值根本没有独立证据，只有门禁自己的布尔结论。批次报告在这一点上写得很清楚（§3.3 明确标注数据源是 run2），但汇总表"run1: PASS（8/8 点击、误差 0px）"把两轮写成对称，**读者容易误以为两轮都有完整原始值**。
5. **对"不改截断"的裁决**：我**认同本批不改**（避免作废既有绿证据），但**不同意把它长期留作遗留项**（F7）。"门禁自身产物不可完整回溯"会持续抬高每一轮独立验收的成本。
6. **关于 D5-03 整体**：我**不同意**由本批通过就宣称 D5-03 整体闭环。本批只闭环了 visibility 的 3 项；D5-03 仍有真机 `test:d5-01-control` 不可达（S0a 安装段）、其回归时点未定位等缺口（`PROGRESS.md:2066` 等）。

---

## 12. 最终独立判定

- **本批（D5-01 visibility 未验收项闭环）：PASS（限定范围）**
  限定范围 = ①「所有已声明的计数、逐落点值、阈值、安全闸、文档纯插入/纯追加、旧证据未动」经我方**重新解析 + 独立复算**全部成立；② 残余 = V11 未截断原始值仅 run2 有外部绑定、run1 落点 7 无原始值（F4）；③「与基线逐条一致」为推论而非快照比对（F2）；④ 1 项 NOT VERIFIED（页面缩放，既有登记，不新增、不改写）。
- **D5-03 整体：PASS（限定范围）** —— 本批范围内通过；整体仍**未**闭环。
- **仍未验证项**（不因本批通过而消解）：
  1. `页面缩放（Cmd +/-）`：1 项 NOT VERIFIED（既有登记，判定为"不适用"，非本批新增）。
  2. `test:d5-01-control` 真机受控浏览器链：安装段 `S0a` 失败、回归时点未定位（本批未复跑，仅确认 `f9564b7` 是祖先）。
  3. `visibility-e2e.mjs:44` 的 2400 字符截断（工具缺陷，未修）。
  4. 其它 9 个仍用陈旧 `data-app-id` 的探针（`tests/d4-main-e2e.mjs`、`tests/fixtures/*-probe` 等）。
  5. V11 旁路载荷第 2400–2955 字符无外部绑定（残余信任边界）。
  6. 上游遗留（跨组织真机 2 条、OAuth、插件隔离 D5-08、SIGKILL 边界等，见 `PROGRESS.md`）。

---

## 13. 收尾状态（本报告写完时的实测）

```
$ git rev-parse HEAD          → 2d50986be46515678ad61494b09a4701565f8716
$ git status --porcelain      →  M PROGRESS.md
                                 M docs/D5-03-GATE-EVIDENCE.json
                                ?? experiments/d5-03/batch15/
$ git diff --stat             → PROGRESS.md 82+ | docs/D5-03-GATE-EVIDENCE.json 628+   （0 deletions）
```

我方**新增的唯一文件**为本报告 `experiments/d5-03/batch15/verify/BATCH15-VERIFY-REPORT.md`（位于本批未跟踪目录内）；未改动任何既有文件、未 commit/push、未运行任何真机/前台脚本；`/tmp/d5b15v/` 为临时脚本目录。
