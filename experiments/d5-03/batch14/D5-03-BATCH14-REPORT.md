# D5-03 第十四批 · 执行方报告（D5-01 真机门禁安装段修复：陈旧 Dock 选择器 + 入口缺失立即失败）

- **被测 commit：`ac019a5`**（`fix(d5-01): 第十四批 D5-01 真机门禁安装段修复（陈旧 Dock 选择器 + 入口缺失立即失败）`）
- **父 commit：`ae17ae9`**（`docs(d5-03): 第十三批结果与证据定稿…`），`git log --oneline -2` 实测单提交
- 工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`）
- 取证时 HEAD 实测：`git rev-parse HEAD` = `ae17ae9da17a475f267241fae0d56804db2794d2`（**取证发生在提交之前**，见 §0.0）
- 取证目录：`experiments/d5-03/batch14/`（原始 stdout+stderr 全部留存）
- 真机命令一律 `env -u ELECTRON_RUN_AS_NODE`（本会话 shell 被注入 `ELECTRON_RUN_AS_NODE=1`，会让 `electron .` 退化成纯 Node）

---

## 0. 范围边界（如实，且已核对）

- **未** push / merge / rebase / amend / commit（全程只做取证、修复与文档写入；提交由上级统一做）。
- **未**触碰主工作树 `/Users/wepingli/Desktop/OpenArc OS`（其 17 项未提交改动原样）；**未**触碰 DSH Desktop 共享运行时；**未**触碰 `~/.dsh`。
- **未**进入 OAuth、D5-04、创建组织入口。
- 本批**只改驱动脚本**（3 个 D5-01 e2e 驱动 + 1 个新增只读诊断探针）；**产品代码、测试代码与设计文档零改动**（§0.0 空 diff 自证）。
- **没有**删除整段门禁、**没有**跳过任何场景、**没有**降低或放宽任何安全判据、**没有**把 FAIL 改成 NOT VERIFIED、**没有**预写数据库、**没有**改 `expected` 迁就实际。
- **未跑**任何真机脚本的并发（端口本就不同：control 9790 / boundary 9792 / visibility 9794 / main 9789；诊断 9793），全程串行。

---

## 0.0 证据溯源口径（取证时工作树 ↔ 被测 commit `ac019a5`）——**必读**

**事实**：本批全部真机/回归证据都是在**未提交的工作树**上取得的。当时 `git rev-parse HEAD` = **`ae17ae9`**，
因此每个原始输出文件头部的 `### HEAD: ae17ae9da17a475f267241fae0d56804db2794d2` 就是当时的真实值，**事后未被改写**。
被测代码随后由上级提交为 **`ac019a5`**（父 `ae17ae9`）。这个时间差必须自证，否则会被误读为"证据不是在 `ac019a5` 上取的"。

**等价性自证（真实输出）**：`ac019a5`（父 `ae17ae9`）**恰好只含 4 个文件**：

```
$ git diff --name-status ae17ae9 ac019a5
M	experiments/d5-01/browser-control-e2e.mjs
M	experiments/d5-01/browser-inprocess-boundary-e2e.mjs
A	experiments/d5-01/s0a-diagnose.mjs
M	experiments/d5-01/visibility-e2e.mjs
```

取证时工作树相对 `ae17ae9` 的改动**正是这同 4 个文件**（其余只有未跟踪的证据目录 `experiments/d5-03/batch14/`，不含代码），
且此后**未再改动**。逐文件 blob 哈希两侧一致：

```
$ for f in experiments/d5-01/browser-control-e2e.mjs \
           experiments/d5-01/browser-inprocess-boundary-e2e.mjs \
           experiments/d5-01/visibility-e2e.mjs \
           experiments/d5-01/s0a-diagnose.mjs; do
      printf '%s\n%s\n' "$(git hash-object "$f")" "$(git rev-parse "ac019a5:$f")"; done
工作树 == ac019a5:（逐条 MATCH）
  browser-control-e2e.mjs             3af6d48930fec02aa2c1978dac5fd7ab2dc9d8ed
  browser-inprocess-boundary-e2e.mjs  8a6186ca4774f6746994dfd489ba8e8179dd859b
  visibility-e2e.mjs                  7570c4b8d7802d97bbce905f7fc1eb784666632b
  s0a-diagnose.mjs                    f15bd3b3a430a84129b5eec29e724623a0932611
```

→ **取证时的工作树内容 = 被测 commit `ac019a5` 的对应文件（逐字节）**，**证据归属于 `ac019a5` 成立**。
独立验收岗另行核对过 3 个驱动与非本批文件（`browser-e2e.mjs` 两侧均为 `0591b86115fb8e4c632ee2b0a88862e39681f325`）。

**本批未改产品、测试与设计文档**（下列命令输出为**空**）：

```
$ git diff --stat ae17ae9 ac019a5 -- src/ electron/ tests/ package.json DESIGN_SYSTEM.md MOTION_SYSTEM.md PLAN.md
（空输出）
```

---

## 0.1 改动面

**提交后（被测 commit `ac019a5`）**：

```
$ git show --stat ac019a5
 experiments/d5-01/browser-control-e2e.mjs            |   9 +-
 experiments/d5-01/browser-inprocess-boundary-e2e.mjs |   9 +-
 experiments/d5-01/s0a-diagnose.mjs                   | 265 +++++++++++++++++++++
 experiments/d5-01/visibility-e2e.mjs                 |   9 +-
 4 files changed, 286 insertions(+), 6 deletions(-)
```

三个驱动各为 **7 增 / 2 删**（1 行"为什么"注释 + 5 行助手 + 2 行替换），诊断探针为新增 265 行。**没有任何"账外"行。**

**`src/**` 零改动**、`electron/**` 零改动、`tests/**` 零改动、`docs/**`（本批文档写入前）零改动、`SCHEMA_VERSION`/预算/审批 TTL 未动。

---

## 0.2 修前失败证据（红）

**表征**：`test:d5-01-control` 在 `S0a`（provider/model 安装段）失败，**从未到达任何浏览器读取/导航/审批场景**。

原始输出（batch13 留存，三次运行）：

| # | commit | 文件 | 最后到达的 check | 中止点 | exit |
|---|---|---|---|---|---|
| 1 | `312dc60`（batch13 HEAD） | `batch13/verify/30-electron-d5-01-control.txt` | setup `S0a` | `:255 page closed` | 2 |
| 2 | `48a867c`（batch13 父提交） | `batch13/verify/32-d5-01-control-at-parent-48a867c.txt` | setup `S0b` → S0c, U1–U6 | `:297 TypeError` | 2 |
| 3 | `312dc60` | `batch13/verify/33-d5-01-control-rerun-at-312dc60.txt` | setup `S0b` → S0c, U1–U6 | `:297 TypeError` | 2 |

三次**共有**（判据一致性）：

```
! [FAIL] setup · S0a · 真实 UI 创建确定性 provider/model 并设为默认 chat — 期望 provider+model+default，实际 {"pid":"","cid":"","defaultOk":false}
! [FAIL] setup · S0b · 真实 UI 连接测试 Inference:PASS — 期望 Inference:PASS，实际
! [FAIL] S1 · S1.0 · 真实 UI 启动任务（official dsh + Tool Facade） — 期望 新 task id，实际
E2E 异常：TypeError: Cannot read properties of undefined (reading 'status')
    at main (…/experiments/d5-01/browser-control-e2e.mjs:297:106)
# EXIT CODE: 2
```

- `S0a` 均 FAIL，失败串**逐字相同**：`实际 {"pid":"","cid":"","defaultOk":false}`；
- 均 `EXIT CODE: 2`、均未产出 `artifacts/d5-01/d5-01-browser-control-e2e.json`；
- **`S1` 起的全部浏览器副作用场景（S1–S6）从未执行**——门禁连"读取/导航/审批"都没跑到。

**关键点（必须写清，否则会误判为"崩溃点随机"）**：`S0a` 的失败是**确定性**的（三次逐字相同）；
非确定性的只是**崩溃点**（`:255` vs `:297`）——那是失败之后的下游连锁（`S0a` 没建出 provider/model → S1 任务起不来 → 读 `task.status` 抛错）。
**根因只有一个，且发生在 `S0a` 之前的第一步。**

---

## 0.3 修后达标证据（绿）

命令：`env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-control`（含 `npm run build`）
原始全量输出：`experiments/d5-03/batch14/20-control-after-fix.txt`（**EXIT=0**）
产物快照：`experiments/d5-03/batch14/artifacts-control-after-fix/d5-01-browser-control-e2e.json`

```
结论：PASS — {"pass":46,"fail":0,"total":46,"notVerified":2}
```

| 检查 | 结果 | 实际值 |
|---|---|---|
| M1 · 真实 electron . 启动并暴露 CDP | **PASS** | connected |
| M2 · 真实 UI 登录 admin | **PASS** | ready |
| **S0a** · 真实 UI 创建确定性 provider/model 并设为默认 chat | **PASS** | `{"pid":"prv_1LuZ0Zlp7xnB9g","cid":"mcf_VHZI_oISpsuyJQ","defaultOk":true}` |
| **S0b** · 真实 UI 连接测试 Inference:PASS | **PASS** | `Endpoint:PASS Credential:PASS Model:PASS Inference:PASS Capabilities:NOT VERIFIED` |
| **S0c** · 真实治理 UI 授予 ai 两个浏览器工具动作 | **PASS** | `{"ok":true,"reason":"ui-granted"}` |
| S1–S6 | **全部 PASS** | 见 §4 逐场景表 |
| hygiene H1 · 主进程无未处理错误 | **PASS** | clean |

> `pid`/`cid` 是每轮隔离临时库里新建的真实记录，值随运行而变（独立验收轮为 `prv_QLt2YARIZKALmQ` / `mcf_5dLnPV0yySxWvA`），这不是缺陷。

---

## 1. 第 1 步真机实测事实（先诊断，未改一行业务代码）

诊断脚本：`experiments/d5-01/s0a-diagnose.mjs`（**只读**：不写库、不设 plan、不点任何有副作用的控件）。
启动方式与门禁**同源**（同一 `electron/main.cjs` + 隔离 `--user-data-dir` + CDP 调试口 + 同一 spawn/env），
**仅默认端口不同**（诊断 `:22` = 9793 / 门禁 `:35` = 9790；两者都读 `OA_D501_CTRL_CDP_PORT`）。

原始全量输出：`diagnose/10-real-machine-s0a-diagnose.txt`；关键结论：`diagnose/10-diagnose-findings.json`。
真机环境：Electron 44.3.0 / Chrome 152.0.7977.78 / Node v22.22.3。
登录流程实测：`gate=uninitialized → 三步 setup 向导（setup-name → setup-identifier → setup-password/confirm → setup-submit）→ unauthenticated → login admin → gate=ready`，`loginOk=true`。

### 1.1 Dock 现状（**未点击之前**）

| 实测项 | 实际值 |
|---|---|
| `document.querySelectorAll('.dock-item').length` | **12** |
| 全部 `.dock-item` 的 `data-dock-id` 值列表 | `["home","browser","files","resource-library","canvas","projects","organization","skills","mcp-center","settings",null,null]` |
| `document.querySelectorAll('[data-app-id]').length` | **0** |
| `!!document.querySelector('[data-dock-id="settings"]')` | **true** |
| `!!document.querySelector('[data-app-id="settings"]')` | **false** |

### 1.2 设置入口点击结果（两次点击分别记录）

| 观测点 | 被点选择器 | `!!el` | `click()` 返回值 | 设置窗口是否打开 | 窗口列表 |
|---|---|---|---|---|---|
| A. 点击前 | — | — | — | **false** | 仅 `应用中心窗口|home` |
| B. 只点新选择器 | `[data-dock-id="settings"]` | **true** | **`"ok"`** | **true** | `["应用中心窗口|home","系统设置窗口|settings"]` |
| C. 再点旧选择器 | `[data-app-id="settings"]` | **false** | **`"missing"`** | 仍为 true（未变化） | 同上 |

### 1.3 当前页面 / 状态

| 实测项 | 实际值 |
|---|---|
| `location.href` | `file:///Users/wepingli/Desktop/OpenArc%20OS-integration/dist/index.html` |
| `.desktop[data-identity-gate]` | **`ready`** |
| `document.title` | `OpenArc OS` |
| `[data-settings-pane]` 全部 pane id | **`["appearance","model","devices"]`** |
| `[data-settings-active]` | 观测点 B = `appearance`；观测点 D（点 `[data-settings-pane="model"]` → `"ok"`）后 = `model` |
| `[aria-label]` 中含"设置"的项 | B：`["切换到系统设置","系统设置窗口","设置分类","打开设置"]`；D：多一项 `"模型设置分区"` |
| `document.body.innerText` 前 400 字 | 见 `diagnose/10-diagnose-findings.json` 的 `attempts[].observe.bodyText400`（B 停在「外观与交互」正文；D 已渲染「模型 / AI」+ Providers/Models/Defaults + 创建 Provider） |

### 1.4 关键控件存在性（逐个实测）

D4-01 面板按 tab **条件渲染**，故逐 tab 实测（顺序与初始 tab 一致：providers → models → defaults）：

| tab | `click([data-d4-01-tab=…])` | 该 tab 下的实测选择器 | 缺失 |
|---|---|---|---|
| `providers`（初始） | n/a | `[data-d4-01-pane="providers"]` = true | 无 |
| `models` | `"ok"` | `[data-d4-01-pane="models"]`、`[data-d4-01-model-provider]`、`[data-d4-01-model-scope]`、`[data-d4-01-model-remote]`、`[data-d4-01-model-name]`、`[data-d4-01-model-create]` **全部 true** | 无 |
| `defaults` | `"ok"` | `[data-d4-01-pane="defaults"]`、`[data-d4-01-default-personal-chat]`、`[data-d4-01-default-org-chat]` **全部 true** | 无 |

**按 tab 实测缺失的控件：`[]`（空）**；另有通用项 `[data-settings-pane="model"]`、`[data-d4-01="settings"]`、`[data-d4-01-provider-name]`、`[data-d4-01-provider-create]`、`[data-d4-01-tab="models"]` 全为 true
（`[data-d4-01-default-personal-chat]` 在未切 tab 时为 false，属预期条件渲染）。

> 说明：诊断脚本第一版把 `providers` 排在采集顺序最后，切走之后才查它，报了 1 个**假缺失**；改为按初始 tab 顺序采集后为 `[]`。
> 这是**诊断脚本的采集顺序 bug**，已在脚本内修正，**不是产品问题**。

### 1.5 renderer 错误

| 项 | 实际值 |
|---|---|
| `pageerror` | **0 条** |
| `console` error | **0 条** |
| 主进程 stderr | 仅 `DevTools listening on ws://127.0.0.1:9793/devtools/browser/…` |

### 1.6 本步判定

1. **设置入口点击是否成功** —— 新选择器 `[data-dock-id="settings"]`：**成功**（`!!el=true`，`click()` → `"ok"`）；旧选择器 `[data-app-id="settings"]`：**元素不存在**（`!!el=false`，`click()` → `"missing"`）。
2. **设置窗口是否打开** —— **是**。出现 `[data-window-id][aria-label="系统设置窗口"]`，三个 pane 齐备，可切到「模型 / AI」并渲染出 `[data-d4-01="settings"]`。
3. **关键控件是否齐** —— **齐**。S0a 用到的每个选择器在其对应 tab 下实测全部存在，按 tab 缺失集 `[]`。
4. **失败发生在哪一步** —— **恰好是"设置入口点击"这一步**：`await click('[data-app-id="settings"]')` 返回 `"missing"`，
   但**返回值被丢弃**、脚本静默继续；随后一连串 `waitSel(…, 20000)` 各自空转到超时，`providerIds()` 为空 → `pid=""`、`cid=""`、`defaultOk=false`，
   直到最后才以 `S0a FAIL · 实际 {"pid":"","cid":"","defaultOk":false}` 暴露，**看不出原因**。

---

## 2. 根因判定：**驱动过时**（附实测数字；"已知线索"**被证实**）

| 判据 | 实测数字 | 排除了什么 |
|---|---|---|
| 产品侧入口存在 | `.dock-item` 12 个，`data-dock-id` 含 `"settings"`；`[data-dock-id="settings"]` `!!el=true` | 排除"产品没有设置入口" |
| 产品侧入口可用 | `click('[data-dock-id="settings"]')` 返回 `"ok"` | 排除"入口被禁用" |
| 产品侧窗口真能开 | 点击后窗口列表出现 `系统设置窗口|settings`，pane id `["appearance","model","devices"]` | 排除"设置窗口打不开" |
| 产品侧控件齐 | 按 tab 缺失集 `[]`，S0a 全部选择器在其 tab 下 true | 排除"缺 hook / 缺控件" |
| 无运行时错误 | `pageerror` **0**、`console` error **0**、主进程 stderr 仅 DevTools 行 | 排除"渲染期崩溃导致 DOM 不出现" |
| 旧选择器不存在 | `document.querySelectorAll('[data-app-id]').length` = **0**；`!!el=false`；`click()` → `"missing"` | **直接锁定驱动侧失效点** |
| 失败点吻合 | 丢弃返回值 → 后续 waitSel 全超时 → `pid=""`/`cid=""`/`defaultOk=false`，与门禁 `S0a` FAIL 表征**逐字一致** | 排除"另有隐藏失败在前面" |
| 产品侧静态证据 | `grep -rn "data-app-id" src/` → **0** 处；`src/desktop/components.tsx:334` 的 `<button className="dock-item">` 渲染 `data-dock-id={id}`（引入提交 `b6b5aa1`） | 交叉印证选择器改名，非选择器丢失 |

**判定：这是「驱动过时」，不是产品缺陷。产品侧入口、窗口、3 个 pane、全部 D4-01 控件均正常，0 页面错误。本批未做任何产品修复。**

**关于"已知线索"**：线索称"Dock 已由 `data-app-id` 改为 `data-dock-id`，三个驱动仍用旧选择器"——
**被证实**（`[data-app-id]` 在全文档计数 **0**，`[data-dock-id="settings"]` 存在且可用），
且本次实测**独立定位到它确实是首个失败点**（而非仅"停在某一处"）：
`S0a` 的 `pid`/`cid` 为空**唯一**可由"入口点击未生效"解释，源头就在 `S0a` 的第一行。

**修正一处此前口径（F1）**：本批**不主张**"visibility 较上一批有改善"。
batch13 **从未跑过** visibility 门禁（其 `D5-03-BATCH13-REPORT.md:248–249` 的"8 PASS / 3 FAIL"是 **`test:d5-01-control`** 在 `48a867c` 上的结果，属跨门禁混用）。
visibility 的**已验收基线**是 CLOSURE4 的 **25/0/1 全绿**（`docs/D5-01-CLOSURE4-RESULT.md:100`、`docs/D5-01-CLOSURE4-EVIDENCE.json` `gates[0]`，commit `f9564b7`，2026-09-20），本次为 **22/3/25**。

---

## 3. 每处改动：旧句 → 新句 → 依据

### 3.1 `experiments/d5-01/browser-control-e2e.mjs`（主门禁，必须修）

| | 内容 |
|---|---|
| 旧句 | `await click('[data-app-id="settings"]');` |
| 新句 | `await mustClick('[data-dock-id="settings"]', "打开系统设置");` |
| 依据 | §1.1/§1.2：`[data-app-id]` 全文档计数 0；`[data-dock-id="settings"]` `!!el=true` 且 `click()` → `"ok"`，点击后设置窗口真实打开 |

| | 内容 |
|---|---|
| 旧句 | `await click('[data-settings-pane="model"]');` |
| 新句 | `await mustClick('[data-settings-pane="model"]', "切到模型/AI 分区");` |
| 依据 | §1.2 观测点 D：该点击实测返回 `"ok"` 并让 `[data-settings-active]` 变为 `model`；同为安装段入口，缺失即应立刻失败 |

| | 内容 |
|---|---|
| 新增 | 在既有 `click` 之后加最小助手：<br>`async function mustClick(sel, label) { const r = await click(sel); if (r !== "ok") throw new Error("入口点击失败：" + label + " " + sel + " → " + r); }` |
| 依据 | 交付要求「入口缺失/被禁用时立即明确失败」，且**必须写明选择器与返回值**。原驱动丢弃 `click` 返回值，使真实原因被 20s 超时掩盖（§0.2 的三次 FAIL 都看不出原因）。该助手**只作用于这两处入口点击**，不放宽、不删除、不改动任何既有安全判据 |

### 3.2 `experiments/d5-01/browser-inprocess-boundary-e2e.mjs`（同一缺陷的受影响驱动，一并修）

| | 内容 |
|---|---|
| 旧句 | `await click('[data-app-id="settings"]');` |
| 新句 | `await mustClick('[data-dock-id="settings"]', "打开系统设置");` |
| 旧句 | `await click('[data-settings-pane="model"]');` |
| 新句 | `await mustClick('[data-settings-pane="model"]', "切到模型/AI 分区");` |
| 新增 | 同款 `mustClick` 助手（复用该文件既有 `click`） |
| 依据 | 同一陈旧选择器、同一"丢弃返回值"缺陷类；`grep -rn 'data-app-id' experiments/` 显示这是同一缺陷的另外两个受影响点之一 |

### 3.3 `experiments/d5-01/visibility-e2e.mjs`（同一缺陷的受影响驱动，一并修）

| | 内容 |
|---|---|
| 旧句 | `await clickDom('[data-app-id="settings"]');` |
| 新句 | `await mustClickDom('[data-dock-id="settings"]', "打开系统设置");` |
| 旧句 | `await clickDom('[data-settings-pane="model"]');` |
| 新句 | `await mustClickDom('[data-settings-pane="model"]', "切到模型/AI 分区");` |
| 新增 | 同款 `mustClickDom` 助手（复用该文件既有 `clickDom`，其原型不含 disabled 检查，**保持原语义不动**） |
| 依据 | 同上；`visibility-e2e.mjs:139` 是交付说明点名的同一处 |

> 三个驱动都在 `main()` 外层有 `try/catch`，抛错即打印 `入口点击失败：… → missing` 并以 **EXIT=2** 结束。
> 入口一旦再被改名，门禁会**立刻大声失败并指名选择器**，不再退化成 20s 超时后的 `S0a FAIL`（独立验收已对抗实测，见 §7）。

### 3.4 明确未改（只列清单，超出本批范围）

同一陈旧选择器仍存在于**别的门禁的探针**里，本批**未碰、未验证**：

- `tests/d4-main-e2e.mjs:284` — `click('[data-app-id="settings"]')`
- `tests/fixtures/model-isolation-ui-probe/main.cjs:59`、`model-settings-ui-probe/main.cjs:50`、`model-secret-ui-probe/main.cjs:90` — `[data-app-id="settings"]`
- `tests/fixtures/resource-ui-probe/main.cjs:120`、`resource-library-ui-probe/main.cjs:127`、`resource-search-ui-probe/main.cjs:84`、`resource-preview-ui-probe/main.cjs:113` — `[data-app-id="resource-library"]`
- `tests/fixtures/governance-ui-probe/main.cjs:82 / 117 / 136` — `[data-app-id="organization" / "canvas" / "files"]`

---

## 4. S0a/S0b/S0c 与 S1–S6 逐场景结果与最终 counts

命令：`env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-control`（含 build），原始输出 `20-control-after-fix.txt`，**EXIT=0**。

| 场景 | PASS | FAIL | 该场景关键实际值 |
|---|---|---|---|
| boot | 2 | 0 | M1 CDP 连上 / M2 登录 `ready` |
| setup | 3 | 0 | S0a `{pid,cid 真实, defaultOk:true}`；S0b `Inference:PASS`；S0c `{"ok":true,"reason":"ui-granted"}` |
| ui（U1–U6 + U7） | 7 | 0 | U5 授权目标 `[{"viewId":"browser#t1","origin":"http://127.0.0.1:5391/inject",…}]`；U6 `t1:1`；U7 `{"before":"browser#t1","now":"browser#t2"}` |
| **S1 读取闭环 + 不可信正文** | **7** | **0** | 真实受控读取执行 `SUCCEEDED` + verification `PASS`；正文带 `untrusted` 标记回传；`INJECT-MARKER-7c21` **未**进 system/developer；0 自动导航、地址不变；审计含工具记录**不含**正文 |
| **S2 导航获批闭环** | **8** | **0** | 见 §5；`SideEffectCall SUCCEEDED / READ_AFTER_WRITE PASS / lease=1` |
| **S3 导航被拒** | **5** | **0** | 用户 DENY → call `BLOCKED`；真实地址仍 `/page2`；0 lease / 0 execution；无"已回滚"式幻觉文案 |
| **S4 目标失效** | **4** | **0** | 未授权 viewId → `FAILED(BROWSER_CONTROL_NOT_SELECTED)`；撤权后同一 viewId → 同码 FAILED（不回落、不改绑）；关被授权标签 → 授权目标 1 → 0 |
| **S5 URL/协议策略** | **4** | **0** | `file:` / `javascript:` / 含凭据 `https://u:p@…` 三个提案均 `TOOL_ARGUMENT_INVALID` + 每任务 0 side-effect call + 0 新增导航 |
| **S6 停止与预算** | **5** | **0** | 审批等待中取消 → 任务非 SUCCEEDED 且 call `BLOCKED(TASK_CANCELLED)`、0 导航 0 lease、地址不变；预算到限 → 成功读取 ≤8 且有界停止、非 SUCCEEDED，UI 如实显示停止原因 |
| hygiene | 1 | 0 | 主进程无未处理错误 |

**最终 counts**：

```
结论：PASS — {"pass":46,"fail":0,"total":46,"notVerified":2}
```

**与 D5-01 验收基线 `46 PASS / 0 FAIL / 2 NOT VERIFIED` 逐项一致，无差异需要解释。**
**S1–S6 真实跑完、未提前中止**（操作记录时间戳从 M1 @+0.0s 推进到 H1 @+10.3s；S1 @+1.0s → S2 @+2.9s → S3 @+4.0s → S4 @+4.8s → S5 @+6.6s → S6 @+8.9s）。

2 项 NOT VERIFIED（沿用既有口径，本批**未改其判定**）：

1. 「崩溃 / 强杀后的浏览器控制目标恢复」——不在本轮契约内：控制目标是会话内授权，进程重启后一律清空。
2. 「像素级层级真值（截图证明原生视图压在外壳之上）」——本机屏幕被其它应用占用，无法独占前台截图；层级由 domain 常量与 DOM/视口几何断言覆盖，不冒充像素证据。

---

## 5. S2 审批目标/地址三处一致性对照表

被批准的那一次导航：目标标签 `browser#t1`，目标地址 `http://127.0.0.1:5391/page2`。

| 项 | ① UI 审批面板显示值 | ② 批准记录 `SideEffectCall.preconditions_safe` | ③ 执行后读取与真实落地 |
|---|---|---|---|
| **地址 URL** | `[data-approval-url]` = **`http://127.0.0.1:5391/page2`**（S2.1 PASS，`actual` 与 `expected` 逐字相同） | **`url` = `http://127.0.0.1:5391/page2`**（S2.7 PASS） | 真实 WebContentsView 落地地址 = **`http://127.0.0.1:5391/page2`**（S2.6 PASS）；页面内 marker 实测 `PAGE2-MARKER-9f3a` |
| **目标 targetRef** | `[data-approval-target]` 实际文本 = `浏览器标签 browser#t1browser#t1http://127.0.0.1:5391/page2`（**包含** `browser#t1`，S2.2 PASS） | **`targetRef` = `browser#t1`**，`targetType` = `browser-tab`（S2.7 PASS） | 主进程授权目标 viewId = **`browser#t1`**（U5 `actual` = `[{"viewId":"browser#t1",…}]`）；READ_AFTER_WRITE verification = **`PASS`** |
| 租约 / 执行 | — | S2.5：`{"status":"SUCCEEDED","verification":"PASS","leases":1}` | `leasesOf(rid).length === 1`，`callsOfTask(run2.taskId,"browser.navigate").length === 1` |
| 批准前 | S2.3：批准前地址未变（仍为 `…/inject`） | — | 批准后才真正导航（S2.6）；执行地址来自 plan 持久化，Harness 批准后**无法换目标**（S2.7） |

**三处一致**：URL 三处**完全相等**；`targetRef` 三处**完全相等**（UI 文案为包含关系）。
独立验收岗另行**自己解析 `actual` 原值**复核，结论同样成立（§7）。

---

## 6. 回归与 `npm test` 真实计数

全部原始输出（含命令、`git rev-parse HEAD`、退出码）在 `experiments/d5-03/batch14/`。所有真机脚本**顺序执行，绝无并发**。

| 证据文件 | 命令 | 真实计数 | 退出码 |
|---|---|---|---|
| `30-unit-d501-suite.txt` | `node --test tests/d5-01-browser-control.test.mjs tests/d5-01-browser-control-chain.test.mjs tests/d5-01-browser-control-surface.test.mjs tests/d5-01-browser-inprocess-boundary.test.mjs tests/d5-01-browser-policy.test.mjs tests/d5-01-browser-tabs.test.mjs` | **37 tests / 37 pass / 0 fail** | **0** ✓ 与基线 37/37 一致 |
| `40-boundary-after-fix.txt` | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-boundary` | **PASS — 32 pass / 0 fail / 32 total，1 NOT VERIFIED** | **0** ✓ |
| `50-visibility-after-fix.txt` | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-visibility`（第 1 次） | 未产出 counts：**V4 截图**处异常中止（`screencapture -l 161601` → `could not create image from window`，伴 `osascript … 不允许辅助访问 (-1719)`） | **2** ✗ |
| `51-visibility-rerun.txt` | 同上（第 2 次） | **FAIL — 22 pass / 3 fail / 25 total，1 NOT VERIFIED** | **1** ✗ |
| `60-d501-main-after-fix.txt` | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01`（第 1 次） | 跑到 A04-9 后于 **A04-10** 抛 `Cannot read properties of undefined (reading 'includes')`（`browser-e2e.mjs:487`，未产出 counts） | **2** ✗ |
| `61-d501-main-rerun.txt` | 同上（第 2 次） | **PASS — 64 pass / 0 fail / 64 total，1 NOT VERIFIED** | **0** ✓ |
| `70-npm-test-full.txt` | `npm test` | **1412 tests / 1412 pass / 0 fail** | **0** ✓ 与基线 1412/1412/0 一致 |
| `20-control-after-fix.txt` | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-control` | **PASS — 46 pass / 0 fail / 46 total，2 NOT VERIFIED** | **0** ✓ |

### 6.1 `test:d5-01-visibility` 失败归因（**未为了让脚本变绿而改动它的任何判定**）

- **谱系（已更正，F1）**：visibility 的**已验收基线**是 CLOSURE4 的 **25 PASS / 0 FAIL / 1 NOT VERIFIED（exit 0）**；
  本次 = **22 pass / 3 fail / 25 total / 1 NV**。**batch13 从未跑过 visibility**，不存在"8 FAIL → 3 FAIL"这条对照。
- **3 项 FAIL（`V9` / `V11` / `V12b`）全部是"前台争用"**：失败原因都是 `not-frontmost:<label>`，重试 3 次全失败。
  证据（逐次 trace 都在输出里）：前台 layer-0 窗口首位始终是 `{"pid":83502,"id":160240}` —— **Google Chrome 的窗口**，
  `activePid` 也是 `83502`；测试实例自己的窗口 `{"pid":10403,"id":161656}` 排在第二。
  驱动（`screen-geometry.mjs:180–205` 的 `makeSafeClick()`，`:192` 为判据，`:203` 三轮不满足即返回 `not-frontmost`）
  在"自己不是最前窗口"时**拒绝发送真实点击**——这是它的**安全判据在正确工作**，不是断言坏了。
  凡是在它短暂抢到前台的那几次（`V11` 的左边/右边中点 `click.ok=true, attempt=1`；`V12` 最大化命中），click 都成功。
- **第 1 次的硬中止不是权限限制（F2 更正）**：经独立验收**只读复测**，本机**截图与辅助访问当前可用** ——
  `screencapture -x`（全屏）成功、`screencapture -x -o -l 160240`（窗口定向）成功、
  `osascript … tell process "Google Chrome" to get size of window 1` → `1708, 970` 成功。
  因此当时的 `-1719` 是**一次性 TCC（辅助访问）拒绝**、`could not create image from window` 是**前台/backing-store 争用**，
  **不是持续权限缺失**。**归因是前台争用，不是权限限制。**
- **本批对 visibility 的结论（严格限定）**：这 3 项差异**由环境/前台争用所致**，**不是产品缺陷、也不是本批引入**；
  **本批不主张对 visibility 有任何改善**。能确证的只有：**安装段 V0/V1/V2 全 PASS**，
  说明同一处入口选择器修复在该脚本上**同样生效**（`V2 · 真实视图加载纯色页面` 位于被修链路之后）。
- **证据缺口（如实）**：FAIL 时驱动**一次点击都没发**，所以 `V9`/`V11`/`V12b` 所测的**产品行为**
  （缩放后真实指针命中、四边近边界命中、最大化后还原回原几何）在本机**依旧未被验证** ——
  在拿到一次"独占前台"的重跑结果之前，**不得**把这三项描述成"已证明无问题"。

### 6.2 `test:d5-01`（主门禁）首次失败归因

- 第 1 次在 **`A04-10`** 抛错：`browser-e2e.mjs:487` 的 `JSON.parse(aCookie2).cookie.includes("d501=USERA")` ——
  `waitView(site.base + "/cookie")` 返回 null（`waitView` 默认超时 15s），`aCookie2` 落成 `"{}"`，`.cookie` 为 `undefined` → 抛错并中止，后续 restore 段未跑。
- **归因成立**：`browser-e2e.mjs` 与 `src/` 均与 `ae17ae9` **逐字节相同**
  （`git rev-parse ae17ae9:…` 与 `git rev-parse ac019a5:…` 均为 `0591b86115fb8e4c632ee2b0a88862e39681f325`），**故非本批引入**。
- **但"偶发性"不得作为结论（F4）**：**复现频次未知** —— 独立验收岗**连跑 4 次全部 PASS、崩溃 0/4 未复现**；本岗 2 次中 1 次崩溃。
  **触发条件未查明。**
- **F3（既有真实脆弱点，本批不改）**：487 行的判据对**可能为 `undefined`** 的对象直接调 `.includes`，
  使 `waitView` 超时 → `TypeError` **中止整段**，**A04 之后的 restore 段根本没跑**。
  它把一个**可能是真实产品症状**的信号（重新登录 + 导航 `/cookie` 后视图 15s 内未出现）变成一个脚本 TypeError。
  建议：先取 `cookie` 再判空并记 FAIL，让门禁如实暴露信号。**本批不改它**（另一个门禁的驱动，超出授权范围）；该信号成因**无人排查，登记为仍未查明的缺口**。

### 6.3 环境登记（非产品缺陷）

`ELECTRON_RUN_AS_NODE=1` 由本会话 shell 注入，会让 `electron .` 退化成纯 Node（`electron` 报 `v24.20.0`）。
真机链一律 `env -u ELECTRON_RUN_AS_NODE` 运行（带变量剥离后报 `v44.3.0`）——这是**还原基线 shell，不是放宽**；
**未**改产品代码或 `experiments/` 脚本去防御它。

---

## 7. 独立对抗性验收（第三方独立复现）

独立验收岗（全新上下文、与本岗无关联、默认立场怀疑）报告：`experiments/d5-03/batch14/verify/BATCH14-VERIFY-REPORT.md`。
**它的独立判定：本批（D5-01 真机门禁安装段修复）通过；未发现任何"靠放宽换绿"。**

| 项 | 独立结果 |
|---|---|
| 声明 1 根因 = 驱动过时 | **成立**（独立重跑诊断；`src/` 中 `data-app-id` 0 处、`components.tsx:334` 有 `data-dock-id`） |
| 声明 2 只动 3 驱动 + 新增 mustClick | **成立**（逐行 diff：4 文件 / +286 / −6，无一处判定改动） |
| 声明 3 达标 `46/0/46 + 2 NV` | **成立（2/2 复现）**：亲手跑 2 次均 `EXIT=0`；它自己按 `status` 字段解析产物，**46 条全为 PASS** |
| 声明 4 S2 三处一致 | **成立**：**自己解析 `actual` 原值**（非引用本报告）→ 三处同为 `http://127.0.0.1:5391/page2`，`targetRef` = `browser#t1` = U5 授权 viewId |
| 声明 5 回归 37/0、32/0/1、1412/0 | **成立**：亲手复现，逐条一致 |
| 声明 6 visibility 22/3/25 与本批无关 | **核心成立，附 2 处不准确表述**（即 F1、F2，已在本报告更正） |
| 声明 7 A04-10 归属 | **归因成立；偶发性 4/4 未复现**（即 F4） |
| 声明 8 证据路径齐备 | **成立** |

**fail-fast 对抗性实测（独立做，不是复述我的）**：把入口选择器改成 `[data-dock-id="settings-NOPE"]` 后 ——

```
E2E 异常：Error: 入口点击失败：打开系统设置 [data-dock-id="settings-NOPE"] → missing
    at mustClick (…/experiments/d5-01/browser-control-e2e.mjs:132:25)
    at async main (…/experiments/d5-01/browser-control-e2e.mjs:229:3)
完整 npm 命令（含 build）WALL = 5.05s，EXIT=2
只跑运行段（dist 已构建）NODE_ONLY_WALL = 1.10s，EXIT=2
```

→ **未退化成 20s `waitSel` 超时**；失败点在 M2 之后、`waitSel('[data-settings-pane="model"]', 20000)` **之前**；
"阴性比阳性更快"（阳性运行段 ≈ 11.1s）正是 fail-fast 的签名。**即时失败语义实测成立。**

**诊断探针只读性裁定**：**成立** —— 隔离 `--user-data-dir`/下载目录、无 `DatabaseSync`/`INSERT`/`UPDATE`、
不 import 产品模块、只写自己的产物 JSON、`pkill` 模式只匹配自身临时目录、未跳过场景。

**诊断重跑逐行相同**：独立跑 2 次均 `EXIT=0`；与本报告原件的 `findings.json` 做**逐行机器比对 —— 105 行逐行完全相同，无一行 DIFF**；
`conclusion` / `dock` / `byTabMissing` 三处关键字段对象级全等。

**逐行审查全 diff（是否靠放宽换绿）**：**未发现**删除/跳过场景、判据改宽、FAIL 改 NOT VERIFIED、预写数据库、
改 `expected` 迁就实际、加 `try/catch` 吞失败、削弱复现性（端口/超时/选择器语义全未改）。
核对了 `record(...)` 一条未少（产物 46 条与基线相同）、`notVerified()` 调用仍在 diff 之外（NOT VERIFIED 仍为 2）。
**净效果是加严**：把已不存在于产品树的选择器换成真实选择器（修的是**驱动**），并给两个入口点击加"返回值必须为 `ok`"的守卫。

**它不同意我的 3 点 —— 我已全部接受并更正**：① F1 跨门禁混用的无效对照；② F2 权限归因；③ F3/F4 把 A04-10 只记"既有偶发"就收尾。

**它对证据溯源的独立核对**：3 个驱动的 `git hash-object` == `git rev-parse ac019a5:<path>`（`3af6d489…8ed` 等），
`git diff --exit-code` = 0，驱动**逐字还原**；它自己的对抗实验产物未污染源码。

---

## 8. 已知限制 / 脆弱点（登记，本批**不做代码改动**）

| # | 严重度 | 内容 | 处置 |
|---|---|---|---|
| F3 | 中低 | `browser-e2e.mjs:487` 既有脆弱点：`waitView` 15s 超时 → `aCookie2="{}"` → `.cookie` 为 `undefined` → `TypeError` **中止后续 restore 段**，掩盖可能的真实症状 | 登记为既有缺口 + 建议；**本批不改**（超出授权范围） |
| F4 | 中低 | `test:d5-01` A04-10 崩溃**复现频次未知**（独立 4/4 未复现，本岗 2 次中 1 次） | 归因成立但触发条件未查明；如实登记 |
| F5 | 低 | `mustClick` 若被漏掉 `await`，失败路径走 **unhandled rejection**：仍立即非 0（EXIT=1）且**指名选择器、不会误报成功**，但绕过驱动的 `catch`/清理，**留下孤儿 electron 占住 CDP 端口**（独立验收已复现 `pid 15771 @9790` 并清理） | 登记为**使用注意事项**：新加调用一律必须 `await` |
| F6 | 低 | 安装段**其余**入口点击（`[data-d4-01-provider-create]`、`[data-d4-01-model-create]` 等）**未加即时失败守卫**，"入口缺失立即明确失败"目前**不普适** | 登记为**已知限制** + 后续建议。**上级裁定不做代码改动**：本批达标判据已满足、该发现为 Low，且把 create 按钮改成 `mustClick` 有"按钮瞬时 disabled 导致误报"的真实风险；**给已独立验证过的代码加东西会作废那次验证**。若要加，建议用**只断言存在性**的 `mustExist` 而非 `mustClick`，并需 **≥2 次连续复跑**证明不引入 flake |
| F7 | 低 | `S0b` 判据是**子串匹配**（`indexOf("Inference:PASS") >= 0`），产品自报 `Capabilities:NOT VERIFIED` 时门禁仍判绿 | 登记为**既有判据口径**（**非本批引入、不构成"换绿"**）；本批不改 |
| F8 | 低 | `s0a-diagnose.mjs` 头注释称启动方式与门禁"完全一致"，实际**默认 CDP 端口不同**（9793 vs 9790） | 报告口径已改为"同源、仅默认端口不同"；**脚本注释本身未改**（代码已冻结在 `ac019a5`，改动会作废独立验收），登记为低severity 措辞遗留 |

**没有任何一条发现动摇"修复本身成立"**：声明 1–5 全部被独立复现成立，本批改动**加严而非放宽**。

---

## 9. 未验收项与剩余缺口（如实）

1. **`test:d5-01-visibility` 未通过**：**22 pass / 3 fail / 25 total / 1 NV，EXIT=1**（已验收基线 = CLOSURE4 的 **25/0/1 全绿**）。
   **未验收的是产品行为本身**：`V9`（缩放后真实指针命中）、`V11`（四边近边界命中）、`V12b`（最大化后还原回原几何）——
   FAIL 时驱动**未发任何点击**，故这些行为在本机**仍未被验证**。闭环条件 = 一次**独占前台**的窗口期重跑（同机同规格）。
2. **`test:d5-01` A04-10 的触发成因与频次未查明**（独立 4/4 未复现）；且该崩溃点**掩盖**一个可能真实的信号（F3），成因无人排查。
3. **F6 的覆盖缺口**：安装段其余入口点击未加即时失败守卫，"立即失败"不普适（本批按上级裁定不改代码）。
4. **同类陈旧 `data-app-id` 选择器**仍在 `tests/d4-main-e2e.mjs` 与 8 个 `tests/fixtures/**-probe` 中，**未验证、未修改**（§3.4 清单）。
5. **门禁自报的 2 项 NOT VERIFIED**（崩溃/强杀后控制目标恢复；像素级层级真值）**依旧未验证**，未因本批而变化。
6. **F5 的使用注意事项**（`mustClick` 必须 `await`）未加任何静态防护。
7. **F7 的判据口径**（`S0b` 子串匹配）未收紧。
8. **D5-03 整体不因此批而通过**：visibility 仍 **22/3/25**；`V9`/`V11`/`V12b` 所测产品行为在本机仍未被验证。

---

## 10. 判定

**判定：D5-03 第十四批（D5-01 真机门禁安装段修复）= PASS（限定范围：`test:d5-01-control` 安装段 S0a/S0b/S0c 与浏览器场景 S1–S6 全部真机通过，**46 PASS / 0 FAIL / 2 NOT VERIFIED，EXIT=0**，与基线 46/0/2 逐项一致；根因经真机实测判定为**驱动过时**、产品代码**零改动**；回归 37/37、boundary 32/0/1、`npm test` 1412/1412/0 全绿；独立对抗性验收通过且未发现放宽换绿）；D5-03 整体仍 = PARTIAL。**

**本批闭环的旧缺口**：第十三批登记的「真机 D5-01 受控浏览器链未取得（`S0a` 既有失败，**回归时点未定位**，`data-app-id` 选择器为线索而非已定位根因）」
—— 本批**已定位并修复**：真机实测确认线索成立（`[data-app-id]` 在 `src/` 中 0 处、`[data-dock-id="settings"]` 可用），
门禁现已跑到 S1–S6 并全部通过。

**本批不主张的部分**：① 对 `visibility` 无任何改善主张（其基线是 25/0/1，本批测得 22/3/25，3 项 FAIL 为前台争用）；
② 未解决 F3–F8 任何一条（均按裁定登记，不做代码改动）；③ 产品行为在 `V9`/`V11`/`V12b` 处仍未被验证。

**剩余缺口逐条**：① visibility 的 `V9`/`V11`/`V12b` 需独占前台重跑闭环；② A04-10 触发条件与频次未查明（F3/F4）；
③ 安装段其余入口点击无即时失败守卫（F6）；④ `tests/d4-main-e2e.mjs` + 8 个 fixtures 探针的同类陈旧选择器（§3.4）；
⑤ 2 项 NOT VERIFIED 依旧；⑥ `mustClick` 必须 `await` 的注意事项（F5）；⑦ `S0b` 子串判据（F7）；⑧ `s0a-diagnose.mjs` 注释端口口径（F8）；
⑨ 上游遗留：跨组织真机 2 条、两条探针门禁既有失败、OAuth、插件隔离（D5-08）、D5-02 `prompt()` 遗留、SIGKILL 边界、第五批登记其余残留。

**下一步建议**：① 找一次独占前台的窗口期重跑 `test:d5-01-visibility`，把 `V9`/`V11`/`V12b` 的产品行为闭环或如实判红；
② 单开一批处理 `browser-e2e.mjs:487`（先取 `cookie` 再判空并记 FAIL）以暴露被掩盖的信号；③ 单开一批统一核对 `tests/` 下同类陈旧 `data-app-id` 探针；
④ 若要推广"入口即时失败"，用 `mustExist` 只断言存在性并做 ≥2 次连续复跑防 flake；⑤ 收紧 `S0b` 判据（`Capabilities` 也应纳入结论）。

---

## 11. 收尾状态（本报告定稿时）

```
$ git rev-parse HEAD
ac019a598d29284e449aae7a90210fda60d56195

$ git show --stat ac019a5
 experiments/d5-01/browser-control-e2e.mjs            |   9 +-
 experiments/d5-01/browser-inprocess-boundary-e2e.mjs |   9 +-
 experiments/d5-01/s0a-diagnose.mjs                   | 265 +++++++++++++++++++++
 experiments/d5-01/visibility-e2e.mjs                 |   9 +-
 4 files changed, 286 insertions(+), 6 deletions(-)

$ git diff --stat ae17ae9 ac019a5 -- src/ electron/ tests/ package.json DESIGN_SYSTEM.md MOTION_SYSTEM.md PLAN.md
（空）
```

**本岗未做 `git commit` / push / merge / rebase / amend；产品代码、测试代码与设计文档零改动；未碰主工作树、DSH Desktop 运行时、`~/.dsh`。**

### 本报告使用的证据文件

| 文件 | 内容 |
|---|---|
| `20-control-after-fix.txt` | 核心门禁 `test:d5-01-control` 全量输出（**46/0/46 + 2 NV，EXIT=0**） |
| `artifacts-control-after-fix/d5-01-browser-control-e2e.json` | 该轮门禁产物（46 条 check + 2 条 notVerified） |
| `artifacts-control-after-fix/d5-01-browser-control-operation-record.jsonl` | 46 条操作记录（含 `at` 时间戳，证明真实推进） |
| `diagnose/10-real-machine-s0a-diagnose.txt` | 第 1 步只读诊断全量输出（stdout+stderr） |
| `diagnose/10-diagnose-findings.json` | 第 1 步诊断关键结论（结构化，含每次观测快照） |
| `30-unit-d501-suite.txt` | D5-01 单测六文件 **37/37** |
| `40-boundary-after-fix.txt` | `test:d5-01-boundary` **32/0/32 + 1 NV PASS** |
| `50-visibility-after-fix.txt` / `51-visibility-rerun.txt` | visibility 两次（截图段中止 / **22/3/25 + 1 NV**） |
| `60-d501-main-after-fix.txt` / `61-d501-main-rerun.txt` | `test:d5-01` 两次（A04-10 中止 / **64/0/64 + 1 NV PASS**） |
| `70-npm-test-full.txt` | `npm test` **1412/1412/0** |
| `verify/BATCH14-VERIFY-REPORT.md` + `verify/V-*.txt` | 独立对抗性验收报告与证据（**他人产出，本岗未改写**） |
| `D5-03-BATCH14-E1-REPORT.md` | 执行岗 E1 报告（已按 F1/F2 更正 + F3–F8 登记） |
