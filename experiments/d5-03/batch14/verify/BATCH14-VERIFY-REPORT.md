# D5-03 Batch14 · D5-01 真机门禁安装段修复 —— 对抗性独立验收报告

- 验收岗：独立验收（与执行方 E1 无关联），默认立场**怀疑**
- 验收时间：2026-09-30 23:19–23:27 (+0800)
- 被测 commit：`ac019a598d29284e449aae7a90210fda60d56195`（`git rev-parse HEAD` 核实一致），父提交 `ae17ae9`
- 工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`，分支 `integration/ui-core`
- 未 commit / push / merge / rebase / amend；未触碰主工作树、DSH 共享运行时、`~/.dsh`
- 所有真机命令均为 `env -u ELECTRON_RUN_AS_NODE …`，全程串行，无并发

---

## 0. 结论速览

| 声明 | 判定 | 依据 |
|---|---|---|
| 1 根因=驱动过时（非产品缺陷） | **成立** | 独立重跑诊断；`src/` 中 `data-app-id` 0 处、`components.tsx:334` 有 `data-dock-id` |
| 2 只动 3 驱动 + 新增 mustClick | **成立** | 逐行 diff：4 文件 / +286 / −6，无一处判定改动 |
| 3 达标 `46/0/46 + 2 NV`，EXIT=0 | **成立（2/2 复现）** | 亲手跑 2 次，均 EXIT=0，产物 JSON 逐条解析 46×PASS |
| 4 S2 三处一致 | **成立** | 自己解析 `actual` 原值：三处同为 `http://127.0.0.1:5391/page2` |
| 5 回归 37/0、32/0/1、1412/0 | **成立** | 亲手复现，逐条一致 |
| 6 visibility 22/3/1 与本批无关 | **核心成立，附 2 处不准确表述** | 机制与代码行号核实；"batch13 记录 8 项 FAIL"与"macOS 权限限制"两说不成立 |
| 7 `test:d5-01` 首次 EXIT=2 属既有偶发 | **归因成立；偶发性我 4/4 未复现** | blob 逐字节相同、487 行确为真实脆弱点 |
| 8 证据路径齐备 | **成立** | 所列文件均存在且可解析 |

**本批（D5-01 真机门禁安装段修复）独立判定：通过。** 修复真实、最小、加严而非放宽，未以任何方式"换绿"。
**D5-03 整体判定：本报告只覆盖"D5-01 安装段修复"这一子项，不构成 D5-03 整体通过**（visibility 门禁未过、2 项 NOT VERIFIED 依旧、A04-10 成因未查）。

---

## 1. 卫生与改动面

### 1.1 基本状态

```
$ git rev-parse HEAD
ac019a598d29284e449aae7a90210fda60d56195      ← 与被测 commit 一致
$ git rev-parse --abbrev-ref HEAD
integration/ui-core
$ git show --stat ac019a5
 experiments/d5-01/browser-control-e2e.mjs          |   9 +-
 experiments/d5-01/browser-inprocess-boundary-e2e.mjs |   9 +-
 experiments/d5-01/s0a-diagnose.mjs                 | 265 +++++++++++++++++++++
 experiments/d5-01/visibility-e2e.mjs               |   9 +-
 4 files changed, 286 insertions(+), 6 deletions(-)
$ git status --porcelain
?? experiments/d5-03/batch14/          ← 唯一未跟踪项（本批证据目录，非代码）
$ git diff --stat
(空)
```

### 1.2 受保护路径零改动（逐条核实）

```
$ for p in src electron tests package.json DESIGN_SYSTEM.md MOTION_SYSTEM.md PLAN.md; do
    git show --stat ac019a5 -- "$p"; done
→ 8 条全部为空输出
$ git diff --name-status ae17ae9 ac019a5
M experiments/d5-01/browser-control-e2e.mjs
M experiments/d5-01/browser-inprocess-boundary-e2e.mjs
A experiments/d5-01/s0a-diagnose.mjs
M experiments/d5-01/visibility-e2e.mjs
```

→ `ac019a5` 全仓库只动这 4 个文件，`src/` `electron/` `tests/` `package.json` `docs/` 零改动。**声明 2 的"产品/界面/测试代码零改动"成立。**

### 1.3 主工作树未被污染

```
$ cd "/Users/wepingli/Desktop/OpenArc OS" && git status --porcelain | wc -l
      17
$ cd "/Users/wepingli/Desktop/OpenArc OS" && git status --porcelain | md5
f53fad2f3a84d843ea45b66e93ded39e      ← 与要求逐字一致
```

### 1.4 未 push（判定命令与结果）

```
$ git branch -vv | grep '^\* integration/ui-core'
* integration/ui-core ac019a5 fix(d5-01): 第十四批 …      ← 方括号内无 [origin/…]，即无上游
$ git ls-remote --heads origin 2>/dev/null | grep -c integration/ui-core
0
```

→ **未 push、无远端对应分支。** 同时 `git status` 无 origin 领先/落后提示，`git log origin/…` 不存在该分支参照。

### 1.5 worktree / 进程

```
$ git worktree list
… 共 15 条：主树 + 既有 d3-04a/b/c/d、d3-05、d4-01、/private/tmp/*（prunable）、~/.codex/… + 本树
→ 无本批新增 worktree，无本批遗留
$ pgrep -fl "OpenArc OS-integration/node_modules/electron"   → (无)
$ pgrep -fl "node --test"                                    → (无)
$ lsof -nP -iTCP:9790..9793 -sTCP:LISTEN                     → 四个端口全空闲
```

**卫生观察（非本批产生）**：会话内存在一条前序遗留 shell `pid 14895 = bash -c sleep 600; cd …/batch14/verify …`（已运行 7 分钟）。它既不是 electron 也不是 `node --test`，不占用 CDP 端口，与本批验收无关；如非必要建议清理。

---

## 2. 独立复现计数表（全部亲手执行）

| # | 命令 | 我的真实结果 | EXIT | 耗时 | 与声明 |
|---|---|---|---|---|---|
| 1 | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-control`（`V-20-control.txt`） | `PASS — {"pass":46,"fail":0,"total":46,"notVerified":2}`；产物 46 条 `status` **全为 PASS** | 0 | 15.0s | 一致 ✓ |
| 2 | 同上复跑（`V-21-control-rerun.txt`） | `PASS — {"pass":46,"fail":0,"total":46,"notVerified":2}` | 0 | 16.6s | 一致 ✓（2/2 稳定） |
| 3 | `node --test` × D5-01 六文件（`V-50-unit-d501.txt`） | `# tests 37 / # pass 37 / # fail 0` | 0 | 6.9s | 一致 ✓ |
| 4 | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-boundary`（`V-51-boundary.txt`） | `PASS — {"pass":32,"fail":0,"total":32,"notVerified":1}` | 0 | 24.0s | 一致 ✓ |
| 5 | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01` ×1（`V-52-d501-main-run1.txt`） | `PASS — {"pass":64,"fail":0,"total":64,"notVerified":1}` | 0 | 18.8s | 声明"首次 EXIT=2"**未复现** |
| 6 | 同上 ×3（`…run2/3/4.txt`） | 三次均 `PASS — 64/0/64, 1 NV` | 0,0,0 | 18.3/18.2/18.4s | **4/4 未复现崩溃** |
| 7 | `npm test`（`V-53-npm-test.txt`） | `# tests 1412 / # pass 1412 / # fail 0` | 0 | 116.0s | 一致 ✓ |
| 8 | `env -u ELECTRON_RUN_AS_NODE node experiments/d5-01/s0a-diagnose.mjs`（`V-40/V-41-*`） | 全部事实复现，见 §4 | 0 | 1.3s | 一致 ✓ |
| 9 | fail-fast 对抗实测（`V-30/V-31-*`） | EXIT=2、错误指名选择器、运行段 1.10s | 2 | 5.05s / 1.10s | 成立 ✓ |

**计数解析方式（自我防错）**：判定字段名确实是 `status`（值 `"PASS"`），不是 `pass`/`ok`：

```
$ node -e "… artifacts/d5-01/d5-01-browser-control-e2e.json …"
counts={"pass":46,"fail":0,"total":46}   statusDistribution={"PASS":46}   notVerified=2
```

**声明 3 成立**：与基线 46/0/2 逐项一致，EXIT=0，且 S1–S6 真实跑完未提前中止。
从操作记录 46 条的 `at` 时间戳可见检查真实推进：M1 @+0.0s → S1 @+1.0s → S2 @+2.9s → S3 @+4.0s → S4 @+4.8s → S5 @+6.6s → S6 @+8.9s → H1 @+10.3s（运行段跨度 10.3s，非空跑）。

---

## 3. S2 三处一致性：我自己解析的 `actual` 原值

（来源：`artifacts/d5-01/d5-01-browser-control-e2e.json` 的 `checks[].actual`，非执行方的一致性表）

| 检查 | 判定式（驱动源码） | `expected` | **`actual` 原值** | 判定 |
|---|---|---|---|---|
| S2.1 | `text('[data-approval-url]').trim() === PAGE2`（:325） | `http://127.0.0.1:5391/page2` | **`http://127.0.0.1:5391/page2`** | PASS |
| S2.2 | `text('[data-approval-target]').includes(VIEW)`，`VIEW="browser#t1"`（:326） | `browser#t1` | **`浏览器标签 browser#t1browser#t1http://127.0.0.1:5391/page2`** | PASS，**包含** `browser#t1` ✓ |
| S2.6 | 真实视图内 `#page2-marker` 文本 `=== "PAGE2-MARKER-9f3a"`；展示 `view.url()`（:335） | `PAGE2-MARKER-9f3a` | **`http://127.0.0.1:5391/page2`** | PASS（判据比"地址"更强：页面内 marker 文本） |
| S2.7 | `pre.url === PAGE2 && pre.targetRef === VIEW`，`pre = JSON.parse(call.preconditions_safe)`（:336–337） | `http://127.0.0.1:5391/page2` | **`{"targetRef":"browser#t1","targetType":"browser-tab","url":"http://127.0.0.1:5391/page2"}`** | PASS |

**我的独立判定：声明 4 成立。**
- UI 显示地址（S2.1）= 真实视图落地地址（S2.6）= 批准记录 `preconditions_safe.url`（S2.7）= **`http://127.0.0.1:5391/page2`**，三处确为同一个值；
- `preconditions_safe.targetRef` = `browser#t1` = 授权 viewId（U5 `actual` = `[{"viewId":"browser#t1",…}]`，U7 之后变为 `browser#t2`），`targetType` = `browser-tab`；
- UI 目标文案（S2.2）**包含** `browser#t1` ✓。

顺带核实安装段原值：

| 检查 | `actual` 原值 | 说明 |
|---|---|---|
| S0a | `{"pid":"prv_QLt2YARIZKALmQ","cid":"mcf_5dLnPV0yySxWvA","defaultOk":true}` | 判据 `!!pid && !!cid && defaultOk`，**三者皆真** |
| S0b | `Endpoint:PASS Credential:PASS Model:PASS Inference:PASS Capabilities:NOT VERIFIED` | 判据 `indexOf("Inference:PASS")>=0` |
| S0c | `{"ok":true,"reason":"ui-granted"}` | 真实治理 UI 授权 |

> 观察（既有、非本批）：S0b 是**子串匹配**，因此产品自报 `Capabilities:NOT VERIFIED` 时门禁仍为绿。这不是本批引入，也不构成"换绿"，但如实登记。

---

## 4. fail-fast 对抗性实测（本批关键要求）

### 4.1 步骤与原始结果

前置：`git diff --exit-code` = 0（干净）。

改动（仅 1 行，`experiments/d5-01/browser-control-e2e.mjs:229`）：

```diff
-  await mustClick('[data-dock-id="settings"]', "打开系统设置");
+  await mustClick('[data-dock-id="settings-NOPE"]', "打开系统设置");
```

**A. 完整 npm 命令（含 build）——`V-30-failfast.txt`**

```
### RUN
E2E 异常：Error: 入口点击失败：打开系统设置 [data-dock-id="settings-NOPE"] → missing
    at mustClick (…/experiments/d5-01/browser-control-e2e.mjs:132:25)
    at async main (…/experiments/d5-01/browser-control-e2e.mjs:229:3)
    at async …/experiments/d5-01/browser-control-e2e.mjs:480:14
WALL_SECONDS=5.05   EXIT=2
```

**B. 只跑运行段（dist 已构建，排除 build）——`V-31-failfast-nodeonly.txt`**

```
  [PASS] boot · M1 · 真实 electron . 启动并暴露 CDP
  [PASS] boot · M2 · 真实 UI 登录 admin
E2E 异常：Error: 入口点击失败：打开系统设置 [data-dock-id="settings-NOPE"] → missing
NODE_ONLY_WALL_SECONDS=1.10   EXIT=2
```

### 4.2 build 段与运行段的区分方法（回应"请说明你如何区分"）

- 完整命令 5.05s = **build 段（`tsc --noEmit` + `vite build`，vite 自报 1.09s，含 tsc 约 3.9s）+ 运行段**；
- 把 build 从式子里去掉：单独跑 `node experiments/d5-01/browser-control-e2e.mjs`（§4.1 B），**运行段 = 1.10s**；
- 两者相减一致（5.05 − 1.10 ≈ 3.95s ≈ build），交叉自洽。
- 阳性对照的运行段 ≈ 15.0 − 3.9 ≈ 11.1s（与操作记录 10.3s 跨度 + 启动 ≈ 1s 吻合），说明测量方法可靠。

### 4.3 判据达成

| 判据 | 结果 |
|---|---|
| 立即失败（远小于 20s `waitSel` 超时） | **达成**：运行段 **1.10s**，失败点在 M2 之后、`waitSel('[data-settings-pane="model"]', 20000)` **之前**；若退化为超时，运行段会 ≥ ~21s（实测阳性 11.1s、若加 20s 超时 ≈ 31s）。**阴性比阳性更快**，正是 fail-fast 的签名 |
| 非 0 退出 | **达成**：EXIT=2 |
| 错误信息指名选择器 | **达成**：原文 `入口点击失败：打开系统设置 [data-dock-id="settings-NOPE"] → missing` |

→ **未退化成超时，未出现"看不出原因"的失败。声明中 mustClick 的即时失败语义实测成立。**

### 4.4 逐字还原证明

```
$ git checkout -- experiments/d5-01/browser-control-e2e.mjs
$ git hash-object experiments/d5-01/browser-control-e2e.mjs
3af6d48930fec02aa2c1978dac5fd7ab2dc9d8ed
$ git rev-parse HEAD:experiments/d5-01/browser-control-e2e.mjs
3af6d48930fec02aa2c1978dac5fd7ab2dc9d8ed        ← 完全相同
$ git diff --exit-code ; echo $?
0
$ git status --porcelain
?? experiments/d5-03/batch14/                    ← 仅证据目录（未跟踪），无源码残留
```

### 4.5 探索性正对照：去掉 `await`（如实报告，不改）

任务描述假设"不 await → 返回值成 Promise 恒 ≠ ok → 误报"。**实测该假设不成立**，但发现了另一面的敏感性：

| 变体 | 结果 | 文件 |
|---|---|---|
| `mustClick(...)`（不 await）+ **不存在的选择器** | **EXIT=1**，进程被 **unhandled rejection** 直接终止：`Error: 入口点击失败：打开系统设置 [data-dock-id="settings-NOPE"] → missing`（仍指名选择器，**没有误报成功**）；因未经驱动的 `catch`/清理路径，**留下孤儿 electron 进程**（我实测到 `pid 15771` 仍 `LISTEN 127.0.0.1:9790`） | `V-32-noawait-badsel.txt` |
| `mustClick(...)`（不 await）+ **正确选择器** | **PASS — 46/0/46，2 NV，EXIT=0**，**无误报失败** | `V-33-noawait-goodsel.txt` |

结论：该助手的判定在**函数内部**（`r !== "ok"` 即 throw），不是靠返回值传递，因此**不 await 不会把成功误判为失败**；但**在失败路径上对调用方式敏感**——会退化为 unhandled rejection（EXIT=1 + 孤儿实例），而不是设计中的 EXIT=2 + 清理。
（孤儿实例是我这次实验造成的，已用 `pkill -f oa-d501-ctrl-AOxHAD` 清理，四个 CDP 端口现已全部空闲。）

---

## 5. 诊断探针只读性裁定 + 独立重跑

### 5.1 `experiments/d5-01/s0a-diagnose.mjs` 是否只读 —— **是（就产品库而言）**

| 关键点 | 行号 | 核实 |
|---|---|---|
| 隔离 userData：`fs.mkdtempSync(os.tmpdir(), "oa-d501-ctrl-diag-")` | `:29` | ✓ 临时目录，非产品库 |
| 隔离下载目录：`mkdtempSync(… "-dl-")` | `:30` | ✓ |
| 启动参数带 `--user-data-dir=<临时目录>` | `:58` | ✓ 与门禁同参数 |
| 产品身份库位置 = `app.getPath("userData")` → 由 `--user-data-dir` 决定 | `electron/main.cjs:243`、`identity-bootstrap.cjs:132/226` | ✓ 落在临时目录，**不写产品库** |
| 无 `DatabaseSync` / `INSERT` / `UPDATE` / 无 `src|electron` 模块 import | 全文件 grep | ✓ 仅 import `@playwright/test`、`node:child_process|module|url|path|fs|os` |
| 唯一写文件动作 = 写自己的产物 JSON | `:259–260` | ✓ `experiments/d5-03/batch14/diagnose/10-diagnose-findings.json` |
| 清理用 `pkill -f "oa-d501-ctrl-diag-"` / `pkill -f <自己 userData>` | `:49–50` | ✓ 模式只匹配自己的临时目录，不会误杀别人的 electron |
| 是否"跳过场景" | — | 未跳过：完整走 启动→登录→Dock 基线→点 Dock→点旧选择器→切 pane→逐 tab 覆盖→stderr/结论 |

→ **裁定：只读性成立，不写产品库、不注入、不跳过场景。** 唯一副作用是它自己的诊断产物文件（且它会把产物写在 batch14 目录，我已在重跑前备份 E1 原件、重跑后**原样还原**，证据目录未被改变）。

一处表述不精确（低）：脚本头注释写"启动方式与 `browser-control-e2e.mjs` **完全一致**"，实际默认 CDP 端口不同（诊断 `:22` 默认 **9793**，控制门禁 `:35` 默认 **9790**；两者都读 `OA_D501_CTRL_CDP_PORT`）。端口不参与被测行为，不影响结论。

### 5.2 独立重跑结果（`V-40-diagnose-rerun.txt`、`V-41-diagnose-rerun2.txt`）

我亲手跑 2 次，均 EXIT=0：

| 待复现事实 | E1 结论 | **我的独立结果** | 一致 |
|---|---|---|---|
| `document.querySelectorAll('[data-app-id]').length` | 0 | **0** | ✓ |
| `[data-dock-id="settings"]` 存在且 `click()` | 存在 / `"ok"` | **`true` / `"ok"`** | ✓ |
| 点击后设置窗口真的打开（`[data-settings-pane="model"]` 出现） | true | **true**（`[data-d4-01="settings"]` 也出现） | ✓ |
| `[data-app-id="settings"]` 存在 / `click()` | false / `"missing"` | **`false` / `"missing"`** | ✓ |
| S0a 驱动全部选择器缺失集 `byTabMissing` | `[]` | **`[]`**（common 13 项中仅 `data-app-id` 为 false，byTab 15 项全 true） | ✓ |
| pageerror / console error | 0 / 0 | **0 / 0** | ✓ |
| Dock 项数 / dockIds | 12 项含 `settings` | **`dockItemCount:12`，`["home","browser","files","resource-library","canvas","projects","organization","skills","mcp-center","settings",null,null]`** | ✓ |

进一步做了**逐行机器比对**：把我的 `findings.json` 与重跑前备份的 E1 原件标准化后对比（剔除 `at`/`env.userData`/`env.node`/`launch.stderrHead`/`stderrTail`/逐次 observe 快照），**105 行逐行完全相同，无一行 DIFF**；`conclusion` / `dock` / `byTabMissing` 三处关键字段对象级全等。

→ **声明 1 的诊断事实全部可复现，无一条不成立。**

产品侧静态证据（我直接查的，不是照抄）：

```
$ grep -rn "data-app-id" src/ | wc -l          → 0
$ grep -rn "data-dock-id" src/
src/desktop/components.tsx:334:      data-dock-id={id}        ← 在 <button className="dock-item">
src/desktop/components.tsx:570 / src/desktop/useDockArrange.ts:41 / src/styles.css:713
$ git log --oneline -1 -S 'data-dock-id' -- src/desktop/components.tsx
b6b5aa1 feat(ui): dock arrange + Finder windows + top bar unify + wallpaper picker
```

（补充：`data-app-id` 从 `src/` 消失发生在 ui-core 与 feature 线的合流处——batch13 记录为 merge `7d707ab`，而 `b6b5aa1` **不是** `f9564b7` 的祖先，两条线各自演进；这不影响"当前树里旧选择器 0 处"这一事实。）

---

## 6. 回归与另两条门禁的独立裁定

### 6.1 声明 5（回归）—— 全部成立

- D5-01 单测六文件：**37 / 37 pass / 0 fail，EXIT=0** ✓
- `test:d5-01-boundary`：**PASS 32/0/32，1 NOT VERIFIED，EXIT=0**（产物 JSON 32 条全 PASS）✓
- `npm test`：**1412 tests / 1412 pass / 0 fail，EXIT=0**，115.98s ✓（声明"约 2 分钟"，实测 116s，一致）

### 6.2 声明 6（visibility 未通过且与本批无关）—— **核心成立；两处表述不成立**

**（a）3 项 FAIL 的具体名字与原因 —— 核实一致**

产物 `artifacts/d5-01/d5-01-visibility-e2e.json`：`counts={"pass":22,"fail":3,"total":25}`，`dist={"PASS":22,"FAIL":3}`，NOT VERIFIED 1。失败者恰为：

1. `V9 · 窗口缩放后重新测量坐标，真实指针点击仍然命中页面内部`（驱动 `visibility-e2e.mjs:393`）
2. `V11 · 网页四边近边界的真实指针命中`（`:432`）
3. `V12b · 恢复后窗口矩形与网页布局回到最大化之前`（`:497`）

三项的 `actual` 里 `click.ok=false`、`reason="not-frontmost:…"`，重试 3 轮 trace 全为 `{"ours":161656, "front":[{"pid":83502,…},{"pid":10403,"id":161656},…], "activePid":83502}`。

**（b）驱动做该判定的代码行号 —— 定位到**

`experiments/d5-01/screen-geometry.mjs:180–205` 的 `makeSafeClick()` 是"真实点击的安全闸"：

- `:184–186` 本实例窗口是否存在 / 窗口 id 是否漂移；
- `:187–189` 采集 `frontmostLayer0()` 与 `frontmostAppPid()` 写入 `trace`；
- **`:192` 判据**：只有"最前面的 layer-0 窗口属于本进程 **且** 本进程是活跃 App"才继续；
- `:193–194` 落点必须在本窗口内容区内，否则 `outside-content:`；
- `:195–198` 才发 `cliclick` 真实指针；
- **`:203` 三轮都不满足 → 返回 `{ok:false, reason:"not-frontmost:"+label}`，一次点击都不发。**
- 上层 `visibility-e2e.mjs:207–219` 的 `clickUntil()` 以"外壳自己收到这次点击"为准，收不到则 `not-received:`（V12b 的嵌套 trace 正是 `not-received:restore` 包着三次 `not-frontmost:restore(-retry1/2)`）。

→ **"非最前窗口拒绝真实点击"的安全判据确实存在且在正确工作，不是断言坏了。** 这一条我完全同意。

**（c）`activePid=83502` 的前台证据 —— 我独立复核，仍然成立**

```
$ ps -p 83502 -o pid,comm=
83502 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
$ osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'
Google Chrome                                    ← 此刻最前仍是 Chrome
```

**（d）安装段 V0/V1/V2 是否真的 PASS —— 是**

产物 JSON 中 `V0 · 真实 electron . 启动（隔离 userData / 隔离 CDP 端口）`、`V1 · 真实 UI 登录 admin`、`V2 · 真实视图加载纯色页面（像素判定的基准）`**全部 PASS**。V2 位于被我方修复的"设置入口 → provider → model"链路之后，它通过 + 后续 V3/V3b/V3c/V4…V8b 一系列**真实指针点击成功**（只有 V9 起才丢前台），确实支持"修复在 visibility 驱动上同样生效"。

**我另外找到一条 E1 没引用的独立佐证**：
`docs/D5-01-CLOSURE4-EVIDENCE.json`（`testedCommit=f9564b7`）的 `gates[0]` = **"完整可见性门禁 `npm run test:d5-01-visibility`" → 25/0/25，exit 0**。同一台机器、同为 25 项，曾经全绿 → 强佐证当前 3 项 FAIL 由环境（前台争用）而非产品造成。

**（e）`osascript -1719` / `screencapture -l` 是否确为 macOS 权限限制 —— 我的只读实测：**不能这么归纳**

| 只读探测（我亲手做） | 结果 |
|---|---|
| `screencapture -x /tmp/v2-scr.png`（全屏） | **exit 0**，产出 6.17 MB PNG → 屏幕录制权限**已授予** |
| `screencapture -x -o -l 160240 /tmp/v2-win-chrome.png`（当前最前 layer-0 窗口 = Chrome） | **exit 0**，产出 4.96 MB PNG → **窗口级截图可用**，`-l` 并非权限受限 |
| `osascript -e 'tell application "System Events" to tell process "Google Chrome" to get size of window 1'`（需要辅助访问） | **`1708, 970`，exit 0** → 辅助访问权限**当前可用** |
| `osascript … process "NoSuchProcessZZZ" …`（对照） | `-1728 不能获得 process` → 说明 `-1719` 是 `errAEEventNotPermitted`（**不允许辅助访问**），与"对象不存在"是两码事 |

→ 裁定：`-1719` 确实是一次**辅助访问（TCC）拒绝**，但**不是持续状态**（我实测同一能力当前可用）；`could not create image from window` 也不是权限限制（我实测对最前窗口成功）。二者最合理的解释是 **E1 报告正文自己写的那句**："本次运行窗口当时未取得前台 / backing store"——即**前台与 backing-store 争用 + 一次性 TCC 拒绝**，而不是"macOS 权限限制"。
**因此把这两项统称为"属 macOS 权限限制"的表述不准确（轻微夸大）；E1 报告 §6.1 的正文说法反而更准确。**

**（f）"上一批 8 FAIL → 3 FAIL" —— 不成立（跨门禁混用）**

- batch13 全树 grep `visibility`：**只命中一条"线索"**（`D5-03-BATCH13-REPORT.md:297`，讲旧选择器），**batch13 从未跑过 visibility 门禁**；
- batch13 报告 `:248–249` 的"8 PASS / 3 FAIL"是 **`test:d5-01-control`** 在基线 `48a867c` 的结果，**不是** visibility 的 8 项 FAIL；
- visibility 的历史基线在 `docs/D5-01-CLOSURE4-EVIDENCE.json` 里是 **25/0/25 全绿**，根本没有 8 FAIL 的记录。

→ **"对照上一批（batch13 记录 8 项 FAIL）"这句话不成立**，应删除或改写为"batch13 未运行 visibility 门禁；visibility 上一次全绿记录为 CLOSURE4 的 25/0/25"。

**（g）最终裁定**：这 3 项 FAIL = **驱动的安全判据正常工作 + 环境前台争用**，**不是产品缺陷** —— 我同意。
**但证据仍有缺口**：FAIL 时驱动**一次点击都没发**，所以 V9/V11/V12b 所测的**产品行为**（缩放后真实指针命中、四边近边界命中、最大化后还原回原几何）在本机**依旧未被验证**。要闭环只需一次"独占前台"的窗口期重跑 visibility；在拿到那次结果之前，不应把这三项描述成"已证明无问题"。

### 6.3 声明 7（`test:d5-01` 首次 EXIT=2 属既有偶发）—— **归因成立；偶发性我未复现**

- **文件未被本批触碰**：
  ```
  $ git diff ae17ae9 ac019a5 -- experiments/d5-01/browser-e2e.mjs   → 空
  $ git rev-parse ae17ae9:experiments/d5-01/browser-e2e.mjs → 0591b86115fb8e4c632ee2b0a88862e39681f325
  $ git rev-parse ac019a5:experiments/d5-01/browser-e2e.mjs → 0591b86115fb8e4c632ee2b0a88862e39681f325   ← 逐字节相同
  ```
- **第 487 行确实是真实脆弱点**：
  ```
  485:  const aView2 = await waitView("/cookie");
  486:  const aCookie2 = aView2 ? await viewEval(aView2, "return JSON.stringify(window.__whoami)") : "{}";
  487:  record("A04", "A04-10 · …", JSON.parse(aCookie2).cookie.includes("d501=USERA"), …);
  ```
  `waitView` 默认超时 15s（`browser-e2e.mjs:161`）；超时返回 `null` → `aCookie2 = "{}"` → `JSON.parse("{}").cookie` 为 `undefined` → `.includes` 抛 `TypeError`。**判据对"可能为 undefined 的对象"直接调 `.includes`，属既有脆弱点，登记为缺口。**
- E1 证据 `60-d501-main-after-fix.txt` 末行确有 `PROBE_THREW TypeError: Cannot read properties of undefined (reading 'includes') … browser-e2e.mjs:487:88`，`61-…` 复跑 `PASS 64/0/64, 1 NV, EXIT=0` —— 与声明一致。
- **我的独立复现：连跑 4 次，4/4 `PASS 64/0/64`，EXIT=0，崩溃一次都没出现。**
- **裁定**：归因"与本批修复无关"**成立**（文件零改动，产品 `src/` 零改动，故不是本批引入）；但"既有**偶发**"我只做到"不推翻"（4 次未复现），其**触发条件与频次未被确认**。更要紧的是：487 行的崩溃点会**掩盖**一个可能是真实症状的信号（重新登录 + 导航 `/cookie` 后，视图在 15s 内没有出现），该症状的成因**没有人查过**，不能仅凭"与本批无关"就关闭。**登记为仍未查明的缺口。**

---

## 7. 「是否靠放宽换绿」——逐行审查结论

审查对象：`git diff ae17ae9 ac019a5 -- experiments/`（我读了全部 hunk，共 3 个驱动文件的 3×3 段 + 1 个新文件）。

### 7.1 每一处改动清单

`experiments/d5-01/browser-control-e2e.mjs`、`browser-inprocess-boundary-e2e.mjs`（各 7+/2−）：

| 类型 | 内容 |
|---|---|
| +5 行 | 1 行"为什么"注释 + `async function mustClick(sel,label){ const r = await click(sel); if (r!=="ok") throw new Error("入口点击失败："+label+" "+sel+" → "+r); }` |
| 替换 1 行 | `await click('[data-app-id="settings"]')` → `await mustClick('[data-dock-id="settings"]', "打开系统设置")` |
| 替换 1 行 | `await click('[data-settings-pane="model"]')` → `await mustClick('[data-settings-pane="model"]', "切到模型/AI 分区")` |

`experiments/d5-01/visibility-e2e.mjs`（7+/2−）：同上，助手名为 `mustClickDom`（包装 `clickDom`），两处替换同上。

`experiments/d5-01/s0a-diagnose.mjs`：**新增 265 行只读诊断脚本**（见 §5.1）。

合计 `+286 / −6`，与 `git show --stat` 完全吻合（265 + 7×3 = 286；2×3 = 6）。**改动面没有任何"账外"行。**

### 7.2 负面清单逐项确认

| 被禁止的手法 | 是否出现 | 核查方式 |
|---|---|---|
| 删除 / 跳过场景 | **否** | 全 diff 无删除的可执行语句；`~50` 行 `record(...)` 一条未少（产物 46 条与基线 46 条相同） |
| 判定由严格改宽松 | **否** | 无任何 `record(...)` 判据被改；唯一的语义变化是**加严**（入口缺失从"沉默超时"变"立即 throw"） |
| FAIL 改 NOT VERIFIED | **否** | `notVerified()` 调用共 2 处，均在 diff 之外；NOT VERIFIED 数仍为 2，与基线一致 |
| 预写数据库 / 直接造 provider | **否** | S0a（`:229–255`）逐行走真实 UI：Dock 点击 → `[data-settings-pane="model"]` → 逐 tab `setInput` 填表单 → `[data-d4-01-provider-create]` → `providerIds()` 读回**真实** `pid` → `[data-d4-01-model-create]` → `attr(...,"data-d4-01-model")` 读回**真实** `cid` → defaults 设为 `cid` → `defaultOk` 由真实输入框 value 回读；判据 `!!pid && !!cid && defaultOk`。该行**不在 diff 中**（与 `ae17ae9` 相同）。全文件无 `DatabaseSync`/SQL/直接 import 产品 store |
| 改 `expected` 迁就实际 | **否** | diff 中没有一行出现在 `record(...)` 的 expected 位置 |
| 加 `try/catch` 吞失败 | **否** | 3 个驱动的 diff 中**没有新增任何 `try`/`catch`**；新增助手只 `throw` |
| 复现性削弱（换端口/放宽超时/换选择器语义） | **否** | 超时值（20000/15000/40000）与端口默认值（9790/9791/9792/9793）全未改 |

**`setPlan(...)` 说明（`:187–189`）**：它向**驱动自己启动的本地确定性 provider**（`isolation` 字段自述"本地确定性 provider（只替代最后一跳网络）"）的 `/__plan` 端点 POST，用于确定性地驱动 dsh 的工具提案；这是**既有**测试替身，不是产品库写入，也不在本批 diff 中。

### 7.3 结论

**未发现任何"靠放宽换绿"的痕迹。** 本批改动的净效果是**加严**：
1. 把已经不存在于产品树的选择器换成真实的 `[data-dock-id="settings"]`（修复的是**驱动**，不是产品）；
2. 给两个入口点击加"返回值必须为 `ok`，否则立即指名失败"的守卫。

补一条**未覆盖项**（小缺口，不违背声明）：安装段其余点击仍丢弃返回值——`click('[data-d4-01-provider-create]')`（`:237`）、`click('[data-d4-01-model-create]')`（`:247`）等。这些入口若缺失，仍会退化成 20s `waitSel` 超时后"看不出原因"的 FAIL。声明只说"各加 `mustClick`/`mustClickDom` 让入口缺失立即失败"，未宣称普适，故不构成夸大；但"立即失败"的覆盖范围有限，建议推广（见 §9 建议）。

---

## 8. 发现清单（按严重度）

| # | 严重度 | 发现 | 证据 |
|---|---|---|---|
| F1 | **中** | **声明 6 中"对照上一批（batch13 记录 8 项 FAIL）"不成立**：batch13 从未运行 visibility 门禁；其"8 PASS / 3 FAIL"是 `test:d5-01-control` 在基线 `48a867c` 的结果。跨门禁混用，纵向比较无效 | `D5-03-BATCH13-REPORT.md:248–249`；`grep -rn visibility batch13/` 仅 1 条"线索"；`docs/D5-01-CLOSURE4-EVIDENCE.json` gates[0] 记载 visibility 上次为 25/0/25 |
| F2 | **中** | **声明 6 中"`screencapture -l`/`osascript -1719` 属 macOS 权限限制"表述不准确**：实测全屏截图、窗口截图均成功；辅助访问 AppleScript 当前可用。`-1719` 是一次性 TCC 拒绝，`could not create image from window` 是前台/backing-store 争用所致。E1 报告正文的说法（"前台占用/仪器层面"）比该归纳更准确 | 我的只读探测见 §6.2(e)；E1 报告 §6.1 |
| F3 | 中低 | **`browser-e2e.mjs:487` 的既有脆弱点会掩盖真实症状**：`waitView` 15s 超时 → `aCookie2="{}"` → `JSON.parse("{}").cookie` undefined → `.includes` 抛错中止，后续 restore 段整段未跑。它把"视图未出现"这一可能的产品信号变成一个脚本 TypeError。该信号成因**无人排查** | `browser-e2e.mjs:161/485–487`；`60-d501-main-after-fix.txt` 崩溃原文 |
| F4 | 中低 | **"既有偶发"未被独立确认**：我连跑 4 次 `test:d5-01` 全 PASS，崩溃 0 次。归因"与本批无关"成立（文件逐字节相同），但触发条件/频次未知 | `V-52-d501-main-run1..4.txt` |
| F5 | 低 | **`mustClick` 未 `await` 会走 unhandled-rejection 路径**：仍会立即非 0（EXIT=1）且指名选择器、**不会误报成功**，但绕过驱动的 `catch`/清理，**留下孤儿 electron 占住 CDP 端口**（我实测复现 `pid 15771 @9790` 并清理）。即"对调用方式敏感"只体现在失败路径 | `V-32-noawait-badsel.txt`、`V-33-noawait-goodsel.txt` |
| F6 | 低 | 安装段其余入口点击（provider-create / model-create 等）未加即时失败守卫，"立即失败"未普适 | `browser-control-e2e.mjs:237/247`；diff 只覆盖 2 处 |
| F7 | 低 | `S0b` 判据为子串匹配：产品自报 `Capabilities:NOT VERIFIED` 时门禁仍绿（**既有、非本批**） | S0b `actual` 原值 |
| F8 | 低 | `s0a-diagnose.mjs` 注释称启动方式与门禁"完全一致"，但默认 CDP 端口不同（9793 vs 9790） | `s0a-diagnose.mjs:22`、`browser-control-e2e.mjs:35` |
| F9 | 观察 | 会话内存在前序遗留 shell `pid 14895`（`bash -c sleep 600; … batch14/verify`），非 electron、非 `node --test`、不占端口，与本批无关 | `ps -p 14895` |

**没有任何一条发现动摇"修复本身成立"**：声明 1–5 全部亲手复现成立，本批改动**加严而非放宽**。

---

## 9. 我不同意的地方

1. **不同意**用"batch13 记录 8 项 FAIL"当对照（F1）。事实是 batch13 没跑 visibility；该对照应删除，或替换为 CLOSURE4 的 25/0/25 全绿作为唯一有效历史基线。
2. **不同意**把 `-1719` / `could not create image from window` 归纳为"macOS 权限限制"（F2）。正确写法是"一次性 TCC 辅助访问拒绝 + 本机前台/backing-store 争用"。E1 报告正文已经写对了，是结论口径被写歪了——口径歪会污染后续批次的判断（例如下次再遇到 `-l` 失败会误以为是权限问题而不去查前台）。
3. **不同意**把 A04-10 只记为"既有偶发"就收尾（F3/F4）。487 行确实与 `ae17ae9` 逐字节相同，所以"不是本批引入"没问题；但它**掩盖**了一个可能真实的产品症状（重新登录 + 导航后视图 15s 内未出现）。建议：先做**只读/最小**的排查（把该处改为"先取 `cookie` 再判空并记 FAIL"，让门禁如实暴露信号），再判定是不是产品缺陷。按本岗授权我不改任何代码，仅登记。
4. **建议**（非反对）：`mustClick`/`mustClickDom` 全部统一 `await`，并把同样的即时失败守卫推广到 `provider-create`、`model-create` 等入口点击；同时把 `mustClick` 做成"失败时先完成清理再退出"，以免出现孤儿实例。

---

## 10. 仍未验证项（不得当成已通过）

1. **visibility 的 V9 / V11 / V12b 所测产品行为**：缩放后真实指针命中、四边近边界命中、最大化后还原回原几何。FAIL 时驱动**未发任何点击**，故产品行为在本机**未被验证**。闭环条件：一次独占前台的窗口期重跑 `test:d5-01-visibility`（同机同规格）。
2. **`test:d5-01` A04-10 的触发成因与频次**（我 4/4 未复现）。
3. 门禁自报的 2 项 NOT VERIFIED：`崩溃/强杀后浏览器控制目标恢复`（契约外）、`像素级层级真值`（无法独占前台截图，层级由 domain 常量 + DOM/视口几何断言覆盖）。这两项**依旧未验证**，未因本批而变化。
4. **D5-03 整体**：本报告只覆盖 D5-01 安装段修复这一子项；visibility 门禁整体仍 FAIL（22/3/25），**不构成 D5-03 整体通过**。

---

## 11. 收尾状态（验收结束时）

```
$ git rev-parse HEAD
ac019a598d29284e449aae7a90210fda60d56195
$ git status --porcelain
?? experiments/d5-03/batch14/
$ git diff --stat
(空)
$ git worktree list
… 15 条，无本批新增（与 §1.5 相同）
$ pgrep -fl "OpenArc OS-integration/node_modules/electron"   → (无)
$ pgrep -fl "node --test"                                    → (无)
$ lsof -nP -iTCP:9790..9793 -sTCP:LISTEN                     → 全部空闲
$ git hash-object experiments/d5-01/browser-control-e2e.mjs
3af6d48930fec02aa2c1978dac5fd7ab2dc9d8ed   ==   git rev-parse HEAD:experiments/d5-01/browser-control-e2e.mjs
```

驱动脚本**逐字还原**，温度计（诊断产物）**原样归还**，唯一遗留物是本报告与 `verify/` 下我自己的证据文件（均在未跟踪的 `experiments/d5-03/batch14/` 内）。

### 本报告使用的证据文件

| 文件 | 内容 |
|---|---|
| `verify/V-20-control.txt` / `V-21-control-rerun.txt` | 核心门禁 2 次复现（46/0/46、2 NV、EXIT=0） |
| `verify/V-30-failfast.txt` / `V-31-failfast-nodeonly.txt` | fail-fast 阴性：EXIT=2、指名选择器、5.05s / 1.10s |
| `verify/V-32-noawait-badsel.txt` / `V-33-noawait-goodsel.txt` | `await` 敏感性正对照（EXIT=1 孤儿实例 / 无误报失败） |
| `verify/V-40-diagnose-rerun.txt` / `V-41-diagnose-rerun2.txt` / `V-41-findings-MINE.json` | 诊断独立重跑 |
| `verify/V-40-findings-BEFORE-E1.json` / `V-40-stdout-BEFORE-E1.txt` | 重跑前的 E1 原件备份（已原样归还） |
| `verify/V-50-unit-d501.txt` | 单测 37/37 |
| `verify/V-51-boundary.txt` | boundary 32/0/1 |
| `verify/V-52-d501-main-run1..4.txt` / `V-52-d501-main-runs234.txt` | `test:d5-01` ×4（全 PASS，崩溃未复现） |
| `verify/V-53-npm-test.txt` | `npm test` 1412/1412/0 |

---

**独立验收签署（立场：怀疑；凡未亲手复现者不采信）**
本批 D5-01 真机门禁安装段修复：**通过**。声明 1、2、3、4、5 全部独立复现成立；声明 6 核心成立但含 2 处不准确表述（F1、F2）；声明 7 归因成立但偶发性未复现（F3、F4）。未发现靠放宽换绿。D5-03 整体**不因此批而通过**。
