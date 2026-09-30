# D5-03 Batch14 · E1 报告 —— D5-01 真机门禁 `test:d5-01-control` 安装段 S0a/S0b 故障定位与修复

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`
- 分支：`integration/ui-core`
- 取证时基线（工作树）：`ae17ae9da17a475f267241fae0d56804db2794d2`（干净）
- 取证时 HEAD：`ae17ae9da17a475f267241fae0d56804db2794d2`（本岗**未提交任何东西**）
- 被测 commit（上级在我交回后提交）：**`ac019a5`**，父 `ae17ae9`
- 真机命令一律 `env -u ELECTRON_RUN_AS_NODE`（本会话 shell 被注入 `ELECTRON_RUN_AS_NODE=1`）

> **证据溯源口径（必读，见 §0.0）**：全部真机/回归证据都是**在未提交的工作树上**取得的（当时 HEAD = `ae17ae9`），
> 原始输出里的 `### HEAD: ae17ae9…` 即该值、**未篡改**；被测 commit `ac019a5` 与该工作树的相关文件**逐字节相同**，故证据归属成立。

---

## 0.0 证据溯源：取证时工作树 ↔ 被测 commit `ac019a5`

**事实**：所有真机/回归命令的输出文件头部都记着 `### HEAD: ae17ae9da17a475f267241fae0d56804db2794d2`——
因为取证发生在**提交之前**，当时 `git rev-parse HEAD` 就是 `ae17ae9`。这些原始输出**未被事后改写**。

**等价性自证**：`ac019a5`（父 `ae17ae9`）**恰好只含 4 个文件**：

```
$ git diff --name-status ae17ae9 ac019a5
M	experiments/d5-01/browser-control-e2e.mjs
M	experiments/d5-01/browser-inprocess-boundary-e2e.mjs
A	experiments/d5-01/s0a-diagnose.mjs
M	experiments/d5-01/visibility-e2e.mjs
```

取证时工作树相对 `ae17ae9` 的改动**正是这同 4 个文件**（其余全部未跟踪证据目录 `experiments/d5-03/batch14/` 不含代码），
且此后**未再改动**。逐文件 blob 哈希一致（独立验收岗也独立核对过 3 个驱动）：

```
$ for f in experiments/d5-01/browser-control-e2e.mjs experiments/d5-01/browser-inprocess-boundary-e2e.mjs \
           experiments/d5-01/visibility-e2e.mjs experiments/d5-01/s0a-diagnose.mjs; do
    echo "$(git hash-object "$f")  $(git rev-parse "ac019a5:$f")  $f"; done
3af6d48930fec02aa2c1978dac5fd7ab2dc9d8ed  3af6d48930fec02aa2c1978dac5fd7ab2dc9d8ed  browser-control-e2e.mjs        MATCH
8a6186ca4774f6746994dfd489ba8e8179dd859b  8a6186ca4774f6746994dfd489ba8e8179dd859b  browser-inprocess-boundary-e2e.mjs  MATCH
7570c4b8d7802d97bbce905f7fc1eb784666632b  7570c4b8d7802d97bbce905f7fc1eb784666632b  visibility-e2e.mjs            MATCH
f15bd3b3a430a84129b5eec29e724623a0932611  f15bd3b3a430a84129b5eec29e724623a0932611  s0a-diagnose.mjs              MATCH
```

→ **取证时的工作树内容 = 被测 commit `ac019a5` 的对应文件（逐字节）**，证据归属于该 commit 成立。

**本批未改产品、测试与设计文档**（下列命令输出为**空**）：

```
$ git diff --stat ae17ae9 ac019a5 -- src/ electron/ tests/ package.json DESIGN_SYSTEM.md MOTION_SYSTEM.md PLAN.md
（空输出）
```

---

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| 根因 | **驱动过时**（旧选择器 `[data-app-id="settings"]` 在基线里根本不存在），**不是产品缺陷** |
| 产品代码改动 | **零**（`src/`、`electron/`、`tests/`、`package.json`、设计文档全部无改动，见 §0.0 的空 diff 自证） |
| 改动面 | 3 个 D5-01 驱动脚本 + 1 个新增只读诊断脚本 = 4 files / +286 / −6（随 `ac019a5` 提交） |
| `test:d5-01-control` | **PASS — 46 PASS / 0 FAIL / 2 NOT VERIFIED，EXIT=0**，与 D5-01 验收基线 **46/0/2 完全一致** |
| S0a / S0b | 均 PASS（provider/model 真机创建 + `Inference:PASS`） |
| 界面验收 | 本批未改界面，无新增视觉/动效验收 |
| 独立对抗性验收 | **通过**（`verify/BATCH14-VERIFY-REPORT.md`）：独立复现全部计数、fail-fast 独立实测、诊断重跑逐行相同、逐行审查**未发现放宽换绿** |
| 已更正的 2 处不准确表述 | **F1** 删掉无效对照（batch13 从未跑过 visibility）；**F2** 删掉"macOS 权限限制"归因（实为一次性 TCC 拒绝 + 前台争用） |
| 已知限制（登记，不改代码） | **F3–F8** 见 §6.4 |

---

## 1. 第 1 步：真机实测事实（先诊断，未改一行业务代码）

诊断脚本：`experiments/d5-01/s0a-diagnose.mjs`（**只读**：不写库、不设 plan、不点任何有副作用的控件），
启动方式与门禁**同源**（同一 `electron/main.cjs` + 隔离 `--user-data-dir` + CDP 调试口 + 同一 spawn/env），
**仅默认端口不同**（诊断 9793 / 门禁 9790；两者都读 `OA_D501_CTRL_CDP_PORT`）。

原始全量输出（stdout+stderr）：`experiments/d5-03/batch14/diagnose/10-real-machine-s0a-diagnose.txt`
关键结论 JSON：`experiments/d5-03/batch14/diagnose/10-diagnose-findings.json`

真机环境：Electron 44.3.0 / Chrome 152.0.7977.78 / Node v22.22.3，CDP 连上，主进程 stderr 只有一行 `DevTools listening`。
登录流程：`gate=uninitialized → 三步 setup 向导（setup-name → setup-identifier → setup-password/confirm → setup-submit）→ unauthenticated → login admin → gate=ready`，`loginOk=true`。

### 1.1 Dock 现状（**未点击之前**）

| 实测项 | 实际值 |
|---|---|
| `document.querySelectorAll('.dock-item').length` | **12** |
| 全部 `.dock-item` 的 `data-dock-id` 值列表 | `["home","browser","files","resource-library","canvas","projects","organization","skills","mcp-center","settings",null,null]` |
| `document.querySelectorAll('[data-app-id]').length` | **0** |
| `!!document.querySelector('[data-dock-id="settings"]')` | **true** |
| `!!document.querySelector('[data-app-id="settings"]')` | **false** |

> `data-dock-id` 列表里两个 `null` 是 Dock 尾部的非应用条目（回收站/AI 球之类），不影响本次判定。

### 1.2 设置入口点击结果（两次点击分别记录）

| 观测点 | 被点选择器 | `!!el` | `click()` 返回值 | 设置窗口是否打开 | 设置窗口标题 |
|---|---|---|---|---|---|
| A. 点击前 | — | — | — | **false** | 仅 `应用中心窗口|home` |
| B. 只点新选择器 | `[data-dock-id="settings"]` | **true** | **`"ok"`** | **true** | `["应用中心窗口|home","系统设置窗口|settings"]` |
| C. 再点旧选择器 | `[data-app-id="settings"]` | **false** | **`"missing"`** | 仍为 true（未变化） | 同上 |

**设置窗口确实能打开**：观测点 B 之后 `[data-settings-pane]` 的全部 pane id 实测为
`["appearance","model","devices"]`，`[data-settings-active]` = `appearance`；
观测点 D 点击 `[data-settings-pane="model"]` 返回 `"ok"`，`[data-settings-active]` 变为 `model`，
`[data-d4-01="settings"]` 随之为 true。

### 1.3 当前页面 / 状态

| 实测项 | 实际值 |
|---|---|
| `location.href` | `file:///Users/wepingli/Desktop/OpenArc%20OS-integration/dist/index.html` |
| `.desktop[data-identity-gate]` | **`ready`** |
| 窗口标题 | `OpenArc OS` |
| 窗口列表（`[data-window-id]` + aria-label） | 观测点 B/C/D：`["应用中心窗口|home","系统设置窗口|settings"]` |
| `[aria-label]` 中含"设置"的项（观测点 B） | `["切换到系统设置","系统设置窗口","设置分类","打开系统设置"]` |
| 同上（观测点 D，进了模型 pane 后） | `["切换到系统设置","系统设置窗口","设置分类","模型设置分区","打开系统设置"]` |

`document.body.innerText` 前 400 字（观测点 B，设置窗口已开、停在「外观与交互」）：

```
本机 · D1
锁定
D5-01 Ctrl Admin
9月30日
全局 AI
未连接
应用
全部应用
最近使用
专业
专业应用
应用中心

一个桌面，连接你的应用、创意与 AI。

浏览器
真实网页 · 隔离运行
访达
本地文件 · 真实存储
资源库
规划中 · 查看说明
AI Studio
规划中 · 查看说明
项目
规划中 · 查看说明
组织治理
规划中 · 查看说明
Skill 中心
规划中 · 查看说明
MCP 中心
规划中 · 查看说明
系统设置
外观与全局模型
回收站
已删除的文件 · 可恢复
⌟
系统
外观与交互
模型 / AI
设备
外观与交互

整个工作空间，遵循你的习惯。

外观
跟随系统
浅色
深色
减少动态效果
材质
完整玻璃
降低材质
实色
程序坞图标大小 拖动滑块调整 Dock 图标尺寸
47px
桌面图标大小 拖动滑块调整桌面文件夹与文件的尺寸
58px
使
```

`document.body.innerText` 前 400 字（观测点 D，已切到「模型 / AI」）：

```
本机 · D1
锁定
D5-01 Ctrl Admin
9月30日
全局 AI
未连接
应用
全部应用
最近使用
专业
专业应用
应用中心

一个桌面，连接你的应用、创意与 AI。

浏览器
真实网页 · 隔离运行
访达
本地文件 · 真实存储
资源库
规划中 · 查看说明
AI Studio
规划中 · 查看说明
项目
规划中 · 查看说明
组织治理
规划中 · 查看说明
Skill 中心
规划中 · 查看说明
MCP 中心
规划中 · 查看说明
系统设置
外观与全局模型
回收站
已删除的文件 · 可恢复
⌟
系统
外观与交互
模型 / AI
设备
模型 / AI

统一配置所有应用使用的模型服务。

Providers
Models
Defaults
PERSONAL
ORGANIZATION
创建 Provider

No model providers configured

⌟
```

### 1.4 关键控件存在性（逐个实测）

设置窗口打开后**通用**控件（当 D4-01 面板停在初始 `providers` tab 时采集）：

| 选择器 | `!!document.querySelector(...)` |
|---|---|
| `[data-settings-pane="model"]` | **true** |
| `[data-d4-01="settings"]` | **true** |
| `[data-d4-01-provider-name]` | **true** |
| `[data-d4-01-provider-create]` | **true** |
| `[data-d4-01-tab="models"]` | **true** |
| `[data-d4-01-default-personal-chat]` | false（**未切 tab 时不渲染**） |
| `[data-settings-pane]` 全部 pane id | `["appearance","model","devices"]` |

`[data-d4-01-pane=...]` 内容是**按 tab 条件渲染**的，所以又逐个 tab 实测了一遍（顺序与初始 tab 一致：providers → models → defaults）：

| tab | `click([data-d4-01-tab=...])` | 该 tab 下实测存在的选择器 | 缺失 |
|---|---|---|---|
| `providers`（初始） | n/a | `[data-d4-01-pane="providers"]` = true | 无 |
| `models` | `"ok"` | `[data-d4-01-pane="models"]`、`[data-d4-01-model-provider]`、`[data-d4-01-model-scope]`、`[data-d4-01-model-remote]`、`[data-d4-01-model-name]`、`[data-d4-01-model-create]` **全部 true** | 无 |
| `defaults` | `"ok"` | `[data-d4-01-pane="defaults"]`、`[data-d4-01-default-personal-chat]`、`[data-d4-01-default-org-chat]` **全部 true** | 无 |

**按 tab 实测缺失的控件：`[]`（空）**。

> 说明：第一版诊断脚本把 `providers` 排在 `Object.entries` 最后采集，切走之后才查它，报了 1 个假缺失；
> 改为按初始 tab 顺序采集后为 `[]`。这是我诊断脚本的采集顺序 bug，已在脚本内修正，**不是产品问题**。

### 1.5 renderer 错误

| 项 | 实际值 |
|---|---|
| `pageerror` | **0 条** |
| `console` error | **0 条** |
| 主进程 stderr | 仅 `DevTools listening on ws://127.0.0.1:9793/devtools/browser/...` |

### 1.6 本步判定（明确回答四个问题）

1. **设置入口点击是否成功** —— 新选择器 `[data-dock-id="settings"]`：**成功**（`!!el=true`，`click()` → `"ok"`）；
   旧选择器 `[data-app-id="settings"]`：**元素不存在**（`!!el=false`，`click()` → `"missing"`）。
2. **设置窗口是否打开** —— **是**。点击后 `[data-window-id][aria-label="系统设置窗口"]` 出现，三个 pane 齐备，可切到「模型 / AI」并渲染出 `[data-d4-01="settings"]`。
3. **关键控件是否齐** —— **齐**。S0a 驱动用到的每一个选择器，在其对应 tab 下实测全部存在，按 tab 缺失集为 `[]`。
4. **失败发生在哪一步** —— **恰好发生在"设置入口点击"这一步**：
   `await click('[data-app-id="settings"]')` 返回 `"missing"`，但**返回值被丢弃**，脚本静默继续；
   随后的 `waitSel('[data-settings-pane="model"]', 20000)` 等一连串等待各自空转到超时，
   `providerIds()` 为空 → `pid=""`、`cid=""`、`defaultOk=false`，
   直到最后才以 `S0a FAIL · 实际 {"pid":"","cid":"","defaultOk":false}` 的形式暴露，看不出原因。

**据实测判定：这是「驱动过时」，不是产品缺陷。**产品侧入口、窗口、pane、控件、hook 全部正常，0 页面错误。

**关于"已知线索"**：线索称"Dock 已由 `data-app-id` 改为 `data-dock-id`，三个驱动仍用旧选择器"——
**被证实**（`[data-app-id]` 在全文档计数 0，`[data-dock-id="settings"]` 存在且可用），
且本次实测**独立定位到它确实是首个失败点**（而非仅"停在某一处"）。

---

## 2. 根因判定

**根因：驱动过时。依据是以下实测数字，不是"已知线索"的照抄：**

| 判据 | 实测数字 | 排除了什么 |
|---|---|---|
| 产品侧入口存在 | `.dock-item` 12 个，`data-dock-id` 含 `"settings"`；`[data-dock-id="settings"]` `!!el=true` | 排除"产品没有设置入口" |
| 产品侧入口可用 | `click('[data-dock-id="settings"]')` 返回 `"ok"` | 排除"入口被禁用" |
| 产品侧窗口真能开 | 点击后窗口列表出现 `系统设置窗口|settings`，pane id `["appearance","model","devices"]` | 排除"设置窗口打不开" |
| 产品侧控件齐 | 按 tab 缺失集 `[]`，S0a 全部选择器在其 tab 下 true | 排除"缺 hook / 缺控件" |
| 无运行时错误 | `pageerror` 0、`console` error 0、主进程 stderr 仅 DevTools 行 | 排除"渲染期崩溃导致 DOM 不出现" |
| 旧选择器不存在 | `document.querySelectorAll('[data-app-id]').length = 0`；`!!el=false`；`click()` → `"missing"` | **直接锁定驱动侧失效点** |
| 失败点吻合 | 丢弃返回值 → 后续 waitSel 全超时 → `pid=""`/`cid=""`/`defaultOk=false`，与门禁 S0a FAIL 表征逐字一致 | 排除"另有隐藏失败在前面" |

**产品侧无缺陷，本批未做任何产品修复。**

---

## 3. 改动面

**取证时（工作树，相对 `ae17ae9`）**：

```
$ git diff --stat
 experiments/d5-01/browser-control-e2e.mjs            | 9 +++++++--
 experiments/d5-01/browser-inprocess-boundary-e2e.mjs | 9 +++++++--
 experiments/d5-01/visibility-e2e.mjs                 | 9 +++++++--
 3 files changed, 21 insertions(+), 6 deletions(-)
```

**提交后（被测 commit `ac019a5`，含新增诊断脚本）**：

```
$ git show --stat ac019a5
 experiments/d5-01/browser-control-e2e.mjs            |   9 +-
 experiments/d5-01/browser-inprocess-boundary-e2e.mjs |   9 +-
 experiments/d5-01/s0a-diagnose.mjs                   | 265 +++++++++++++++++++++
 experiments/d5-01/visibility-e2e.mjs                 |   9 +-
 4 files changed, 286 insertions(+), 6 deletions(-)
```

`src/`、`electron/`、`tests/`、`package.json`、`DESIGN_SYSTEM.md`、`MOTION_SYSTEM.md`、`PLAN.md` **零改动**（§0.0 空 diff 自证）。
新增文件只有：诊断脚本 `experiments/d5-01/s0a-diagnose.mjs`（已随 `ac019a5` 提交）与未跟踪证据目录 `experiments/d5-03/batch14/`。

### 3.1 每处改动：旧句 → 新句 → 依据

**(1) `experiments/d5-01/browser-control-e2e.mjs`（主门禁，必须修）**

| | 内容 |
|---|---|
| 旧句 | `await click('[data-app-id="settings"]');` |
| 新句 | `await mustClick('[data-dock-id="settings"]', "打开系统设置");` |
| 依据 | 诊断 1.1/1.2：`[data-app-id]` 全文档计数 0；`[data-dock-id="settings"]` `!!el=true` 且 `click()` → `"ok"`，点击后设置窗口真实打开 |

| | 内容 |
|---|---|
| 旧句 | `await click('[data-settings-pane="model"]');` |
| 新句 | `await mustClick('[data-settings-pane="model"]', "切到模型/AI 分区");` |
| 依据 | 诊断 1.2 观测点 D：该点击实测返回 `"ok"` 并让 `[data-settings-active]` 变为 `model`；同为安装段入口，缺失即应立刻失败 |

| | 内容 |
|---|---|
| 新增 | 在既有 `click` 之后加最小助手：<br>`async function mustClick(sel, label) { const r = await click(sel); if (r !== "ok") throw new Error("入口点击失败：" + label + " " + sel + " → " + r); }` |
| 依据 | 交付要求「入口缺失/被禁用时立即明确失败」，且**必须写明选择器与返回值**。原驱动丢弃 `click` 返回值，使真实原因被 20s 超时掩盖（诊断 1.6 第 4 点）。该助手**只影响这两处入口点击**，不放宽、不删除、不改动任何既有安全判据 |

**(2) `experiments/d5-01/browser-inprocess-boundary-e2e.mjs`（同一缺陷的受影响驱动，一并修）**

| | 内容 |
|---|---|
| 旧句 | `await click('[data-app-id="settings"]');` |
| 新句 | `await mustClick('[data-dock-id="settings"]', "打开系统设置");` |
| 旧句 | `await click('[data-settings-pane="model"]');` |
| 新句 | `await mustClick('[data-settings-pane="model"]', "切到模型/AI 分区");` |
| 新增 | 同款 `mustClick` 助手（复用该文件既有 `click`） |
| 依据 | 同一陈旧选择器、同一丢弃返回值的缺陷类；`grep -rn 'data-app-id' experiments/` 显示这是同一缺陷的另外两个受影响点之一 |

**(3) `experiments/d5-01/visibility-e2e.mjs`（同一缺陷的受影响驱动，一并修）**

| | 内容 |
|---|---|
| 旧句 | `await clickDom('[data-app-id="settings"]');` |
| 新句 | `await mustClickDom('[data-dock-id="settings"]', "打开系统设置");` |
| 旧句 | `await clickDom('[data-settings-pane="model"]');` |
| 新句 | `await mustClickDom('[data-settings-pane="model"]', "切到模型/AI 分区");` |
| 新增 | 同款 `mustClickDom` 助手（复用该文件既有 `clickDom`，其原型不含 disabled 检查，保持原语义不动） |
| 依据 | 同上；`visibility-e2e.mjs:139` 是交付说明点名的同一处 |

> 三个驱动都在 `main()` 外层有 `try/catch`，抛错即打印 `入口点击失败：… → missing` 并以 **EXIT=2** 结束——
> 入口一旦再被改名，门禁会**立刻大声失败并指名选择器**，不再退化成 20s 超时后的 `S0a FAIL`。

### 3.2 明确未改（只列清单，超出本批范围）

同一陈旧选择器仍存在于**别的门禁的探针**里，本批**未碰**：

- `tests/d4-main-e2e.mjs:284` — `click('[data-app-id="settings"]')`
- `tests/fixtures/resource-ui-probe/main.cjs:120` — `[data-app-id="resource-library"]`
- `tests/fixtures/resource-library-ui-probe/main.cjs:127` — `[data-app-id="resource-library"]`
- `tests/fixtures/resource-search-ui-probe/main.cjs:84` — `[data-app-id="resource-library"]`
- `tests/fixtures/resource-preview-ui-probe/main.cjs:113` — `[data-app-id="resource-library"]`
- `tests/fixtures/model-isolation-ui-probe/main.cjs:59` — `[data-app-id="settings"]`
- `tests/fixtures/model-settings-ui-probe/main.cjs:50` — `[data-app-id="settings"]`
- `tests/fixtures/model-secret-ui-probe/main.cjs:90` — `[data-app-id="settings"]`
- `tests/fixtures/governance-ui-probe/main.cjs:82 / 117 / 136` — `[data-app-id="organization" / "canvas" / "files"]`

**观察（未验证）**：这些探针在同一基线上大概率也点不到目标。本批未对它们做任何验证或修改，
交上级决定是否单开一批处理。

---

## 4. S0a/S0b/S0c 与 S1–S6 逐场景结果与最终 counts

命令：`env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-control`（含 `npm run build`）
原始全量输出：`experiments/d5-03/batch14/20-control-after-fix.txt`（**EXIT=0**）
产物快照：`experiments/d5-03/batch14/artifacts-control-after-fix/d5-01-browser-control-e2e.json`

### 4.1 安装段

| 检查 | 结果 | 实际值 |
|---|---|---|
| M1 · 真实 electron . 启动并暴露 CDP | **PASS** | connected |
| M2 · 真实 UI 登录 admin | **PASS** | ready |
| **S0a** · 真实 UI 创建确定性 provider/model 并设为默认 chat | **PASS** | `{"pid":"prv_1LuZ0Zlp7xnB9g","cid":"mcf_VHZI_oISpsuyJQ","defaultOk":true}` |
| **S0b** · 真实 UI 连接测试 Inference:PASS | **PASS** | `Endpoint:PASS Credential:PASS Model:PASS Inference:PASS Capabilities:NOT VERIFIED` |
| **S0c** · 真实治理 UI 授予 ai tool.browser.read / tool.browser.navigate | **PASS** | `{"ok":true,"reason":"ui-granted"}` |

> 对照上一批：S0a 曾是 `FAIL · 实际 {"pid":"","cid":"","defaultOk":false}`；现为真实 id + `defaultOk=true`。

### 4.2 逐场景（真实跑完 S1–S6，未提前中止）

| 场景 | PASS | FAIL | 该场景关键实际值 |
|---|---|---|---|
| boot | 2 | 0 | M1/M2 |
| setup | 3 | 0 | S0a/S0b/S0c |
| ui（U1–U6 + U7） | 7 | 0 | U5 授权目标 `[{"viewId":"browser#t1","origin":"http://127.0.0.1:5391/inject",...}]`；U7 `{"before":"browser#t1","now":"browser#t2"}` |
| **S1 读取闭环 + 不可信正文** | **7** | **0** | 真实读取执行 `SUCCEEDED`+verification `PASS`；正文带 `untrusted` 回传；`INJECT-MARKER-7c21` 未进 system/developer；0 自动导航、地址不变 |
| **S2 导航获批闭环** | **8** | **0** | 见 §5 三处一致性表；`SideEffectCall SUCCEEDED / READ_AFTER_WRITE PASS / lease=1` |
| **S3 导航被拒** | **5** | **0** | 用户 DENY → call `BLOCKED`；真实地址仍 `/page2`；0 lease / 0 execution；无"已回滚"式幻觉文案 |
| **S4 目标失效** | **4** | **0** | 未授权 viewId → `FAILED(BROWSER_CONTROL_NOT_SELECTED)`；撤权后同一 viewId → 同码 FAILED（不回落）；关标签 → 授权目标 1 → 0 |
| **S5 URL/协议策略** | **4** | **0** | `file:` / `javascript:` / 含凭据 `https://u:p@…` 三个提案均 `TOOL_ARGUMENT_INVALID` + 每个任务 0 side-effect call + 0 新增导航 |
| **S6 停止与预算** | **5** | **0** | 审批中取消 → 任务非 SUCCEEDED 且 call `BLOCKED(TASK_CANCELLED)`、0 导航 0 lease、地址不变；预算到限 → 成功读取 ≤8 且有界停止、非 SUCCEEDED，UI 如实显示停止原因 |
| hygiene | 1 | 0 | 主进程无未处理错误 |

### 4.3 最终 counts

```
结论：PASS — {"pass":46,"fail":0,"total":46,"notVerified":2}
```

**与 D5-01 验收基线 `46 PASS / 0 FAIL / 2 NOT VERIFIED` 逐项一致，无差异需要解释。**

2 项 NOT VERIFIED（沿用既有口径，本批未改其判定）：

1. 「崩溃 / 强杀后的浏览器控制目标恢复」——不在本轮契约内：控制目标是会话内授权，进程重启后一律清空。
2. 「像素级层级真值（截图证明原生视图压在外壳之上）」——本机屏幕被其它应用占用，无法独占前台截图；层级由 domain 常量与 DOM/视口几何断言覆盖，不冒充像素证据。

---

## 5. 审批目标/地址三处一致性对照表（S2）

被批准的那一次导航：目标标签 `browser#t1`，目标地址 `http://127.0.0.1:5391/page2`。

| 项 | ① UI 审批面板显示值 | ② 批准记录 `SideEffectCall.preconditions_safe` | ③ 执行后读取与真实落地 |
|---|---|---|---|
| **地址 URL** | `[data-approval-url]` = **`http://127.0.0.1:5391/page2`**（S2.1 PASS，actual 与 expected 逐字相同） | **`url` = `http://127.0.0.1:5391/page2`**（S2.7 PASS） | 真实 WebContentsView 落地地址 = **`http://127.0.0.1:5391/page2`**（S2.6 PASS）；页面 marker 实测 `PAGE2-MARKER-9f3a` |
| **目标 targetRef** | `[data-approval-target]` 实际文本 = `浏览器标签 browser#t1browser#t1http://127.0.0.1:5391/page2`（含 **`browser#t1`**，S2.2 PASS） | **`targetRef` = `browser#t1`**，`targetType` = `browser-tab`（S2.7 PASS） | 主进程授权目标 viewId = **`browser#t1`**（U5 actual `[{"viewId":"browser#t1",...}]`）；READ_AFTER_WRITE verification = **`PASS`** |
| 租约 | — | S2.5：`{"status":"SUCCEEDED","verification":"PASS","leases":1}` | `leasesOf(rid).length === 1`，`callsOfTask(run2.taskId,"browser.navigate").length === 1` |

**三处一致：URL 完全相等；targetRef 完全相等（UI 文本包含 `browser#t1`，记录与授权目标均为 `browser#t1`）。**
批准前地址未变（S2.3：仍为被批准前的 `…/inject`），批准后才真正导航（S2.6），
且执行地址来自 plan 持久化、Harness 批准后无法换目标（S2.7）。

---

## 6. 回归与 `npm test` 真实计数

全部原始输出（含命令、`git rev-parse HEAD`、退出码）在 `experiments/d5-03/batch14/`。
所有真机脚本**顺序执行**，绝无并发（端口本就不同：control 9790 / boundary 9792 / visibility 9794 / main 9789；诊断用 9793）。

| 证据文件 | 命令 | 真实计数 | 退出码 |
|---|---|---|---|
| `30-unit-d501-suite.txt` | `node --test tests/d5-01-browser-control.test.mjs tests/d5-01-browser-control-chain.test.mjs tests/d5-01-browser-control-surface.test.mjs tests/d5-01-browser-inprocess-boundary.test.mjs tests/d5-01-browser-policy.test.mjs tests/d5-01-browser-tabs.test.mjs` | **37 tests / 37 pass / 0 fail** | **0** ✓ 与基线 37/37 一致 |
| `40-boundary-after-fix.txt` | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-boundary` | **PASS — 32 pass / 0 fail / 32 total，1 NOT VERIFIED** | **0** ✓ |
| `50-visibility-after-fix.txt` | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-visibility`（第 1 次） | 未产出 counts：在 **V4 截图**处异常中止（`screencapture -l 161601` → `could not create image from window`，伴随 `osascript … 不允许辅助访问 (-1719)`）。**注意（F2 更正）**：这**不是**持续的权限限制——独立验收只读实测全屏截图、窗口定向截图、需辅助访问的 `osascript` **当前全部可用**；当时的 `-1719` 是一次性 TCC 拒绝、`could not create image from window` 是前台/backing-store 争用 | **2** ✗ |
| `51-visibility-rerun.txt` | 同上（第 2 次） | **FAIL — 22 pass / 3 fail / 25 total，1 NOT VERIFIED** | **1** ✗ |
| `60-d501-main-after-fix.txt` | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01`（第 1 次） | 跑到 A04-9 后于 **A04-10** 抛错 `Cannot read properties of undefined (reading 'includes')`（`browser-e2e.mjs:487`，未产出 counts） | **2** ✗ |
| `61-d501-main-rerun.txt` | 同上（第 2 次） | **PASS — 64 pass / 0 fail / 64 total，1 NOT VERIFIED** | **0** ✓ |
| `70-npm-test-full.txt` | `npm test` | **1412 tests / 1412 pass / 0 fail** | **0** ✓ 与基线 1412/1412/0 一致 |
| `20-control-after-fix.txt` | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-control` | **PASS — 46 pass / 0 fail / 46 total，2 NOT VERIFIED** | **0** ✓ |

### 6.1 `test:d5-01-visibility` 的失败如实归因（**未为了让脚本变绿而改动它的判定**）

- **3 个 FAIL 全部是"前台争用"，不是产品缺陷，也与我的选择器修复无关**：
  `V9`、`V11`、`V12b` 的失败原因都是 `not-frontmost:<label>`，重试 3 次全失败。
  证据（逐次 trace 都在输出里）：前台 layer-0 窗口首位始终是 `{"pid":83502,"id":160240}`——
  **Google Chrome 的窗口**，`activePid` 也是 `83502`；测试实例自己的窗口 `{"pid":10403,"id":161656}` 排在第二。
  驱动在"自己不是最前窗口"时**拒绝发送真实点击**，这是它的安全判据在**正确工作**，不是断言坏了。
  凡是在它短暂抢到前台的那几次（`V11` 的左边/右边中点 `click.ok=true, attempt=1`；`V12` 最大化命中），click 都成功。
- 第 1 次的硬中止（`V4` 截图 `could not create image from window` + `osascript -1719 不允许辅助访问`）是**同一前台争用的更严重表现**。
  **F2 更正（不得再写成"macOS 权限限制"）**：经独立验收只读复测，本机**截图与辅助访问当前可用**——
  `screencapture -x`（全屏）成功、`screencapture -x -o -l 160240`（窗口定向）成功、
  `osascript … tell process "Google Chrome" to get size of window 1` → `1708, 970` 成功；
  因此当时的 `-1719` 是**一次性 TCC（辅助访问）拒绝**、`could not create image from window` 是**前台/backing-store 争用**，
  **不是持续权限缺失**。visibility 的失败归因是**前台争用**，不是权限限制。
- **F1 更正：删除无效对照。**~~"较上一批（batch13 记录 8 项 FAIL）降为 3 FAIL"~~ **不成立**——
  batch13 **从未跑过** visibility 门禁（全树 grep 只命中一条讲旧选择器的"线索"；`D5-03-BATCH13-REPORT.md:248–249` 的"8 PASS / 3 FAIL"是 **`test:d5-01-control`** 在基线 `48a867c` 上的结果，属跨门禁混用）。
  **已核实的正确谱系**：
  - visibility 的**已验收基线**是 CLOSURE4 的 **25 PASS / 0 FAIL / 1 NOT VERIFIED，exit 0**
    （`docs/D5-01-CLOSURE4-RESULT.md:100` 与 `docs/D5-01-CLOSURE4-EVIDENCE.json` `gates[0]`，commit `f9564b7`，2026-09-20）；
  - 本次 = **22 pass / 3 fail / 25 total / 1 NOT VERIFIED**。
  → 两者的 **3 项差异（V9 / V11 / V12b）全部由前台被别的应用占据、驱动拒绝发送真实点击所致** → 属**环境/前台争用**，
  **不是产品缺陷、也不是本批引入**。**本批不主张对 visibility 有任何改善**；能确证的只有：
  **安装段 V0/V1/V2 全 PASS**，说明同一处入口选择器修复在该脚本上同样生效。
- **本批未改它的任何判定、未放宽、未把 FAIL 改成 NOT VERIFIED。**它现在不绿，如实记为未通过。
- **证据缺口（如实）**：FAIL 时驱动**一次点击都没发**，所以 V9/V11/V12b 所测的**产品行为**
  （缩放后真实指针命中、四边近边界命中、最大化后还原回原几何）在本机**依旧未被验证**——
  在拿到一次"独占前台"的重跑结果之前，**不得**把这三项描述成"已证明无问题"。

### 6.2 `test:d5-01`（主门禁）的首次失败如实归因

- 第 1 次在 **`A04-10`** 抛错：`browser-e2e.mjs:487` 的 `JSON.parse(aCookie2).cookie.includes("d501=USERA")`——
  `waitView(site.base + "/cookie")` 返回 null（该处 `waitView` 超时 15s），`aCookie2` 落成 `"{}"`，`.cookie` 为 `undefined` → 抛错并中止，后续 restore 段未跑。
- **该文件与我的改动无关：`git diff` 显示我只动了 3 个文件，`browser-e2e.mjs` 未在其中，与 `ae17ae9` 逐字节相同
  （`git rev-parse ae17ae9:…` 与 `git rev-parse ac019a5:…` 均为 `0591b86115fb8e4c632ee2b0a88862e39681f325`）；
  `src/`、`electron/` 亦零改动。**因此归因"**不是本批引入**"成立。
- **F4 更正（不得再简单记作"既有偶发"）**：**复现频次未知** —— 独立验收岗**连跑 4 次 `test:d5-01` 全部 PASS、崩溃 0/4 未复现**；
  本岗 2 次中 1 次崩溃。故正确表述是：
  **"归因成立（该文件与 `src/` 均与 `ae17ae9` 逐字节相同，故非本批引入），但复现频次未知：独立验收 4/4 未复现；触发条件未查明。"**
- **F3 登记（中低，既有真实脆弱点，本批不改）**：`browser-e2e.mjs:487` 的判据对**可能为 `undefined`** 的对象直接调 `.includes`：
  `waitView` 15s 超时 → `aCookie2 = "{}"` → `JSON.parse("{}").cookie` 为 `undefined` → 抛 `TypeError` **中止整段**，
  使 **A04 之后的 restore 段根本没跑**。它把一个**可能是真实产品症状**的信号（重新登录 + 导航 `/cookie` 后视图 15s 内未出现）
  变成一个脚本 TypeError。**建议**：先取 `cookie` 再判空并记 FAIL，让门禁如实暴露信号。
  **本批不改它**（超出授权范围：它是另一个门禁的驱动）；该信号成因**无人排查，登记为仍未查明的缺口**。

### 6.3 独立对抗性验收（第三方独立复现，报告 `verify/BATCH14-VERIFY-REPORT.md`）

独立验收岗（全新上下文、与本岗无关联、默认立场怀疑）已完成，结论：**本批（D5-01 真机门禁安装段修复）通过**，
**未发现任何靠放宽换绿**。它独立复现/裁定的要点：

| 项 | 独立结果 |
|---|---|
| 核心门禁 `test:d5-01-control` | **亲手跑 2 次，均 `46/0/46 + 2 NV`、EXIT=0**（2/2 稳定）；它自己解析产物 JSON 的 `status` 字段，46 条**全为 PASS** |
| 未提前中止 | 从操作记录时间戳核对：M1 @+0.0s → S1 @+1.0s → S2 @+2.9s → S3 @+4.0s → S4 @+4.8s → S5 @+6.6s → S6 @+8.9s → H1 @+10.3s（运行段跨度 10.3s） |
| S2 三处一致 | **自己解析 `actual` 原值**（不是引用我的表）：S2.1 = `http://127.0.0.1:5391/page2`、S2.7 `preconditions_safe.url` 同值、`targetRef` = `browser#t1` = U5 授权 viewId；裁定**成立** |
| D5-01 单测 / boundary / `npm test` | **37/37**、**32/0/32 + 1 NV**、**1412/1412/0**，与我的计数逐条一致 |
| **fail-fast 对抗实测** | 注入 `[data-dock-id="settings-NOPE"]`：**EXIT=2**、错误原文指名选择器 `入口点击失败：打开系统设置 [data-dock-id="settings-NOPE"] → missing`；**运行段仅 1.10s**（完整 npm 命令 5.05s − build ≈ 3.95s 交叉自洽），**未退化成 20s `waitSel` 超时**——且"阴性比阳性更快"正是 fail-fast 的签名 |
| 诊断探针只读性 | 裁定**成立**：隔离 userData/下载目录、无 `SQLite`/`INSERT`/`UPDATE`、不 import 产品模块、只写自己的产物 JSON、`pkill` 模式只匹配自身临时目录 |
| 诊断重跑 | 亲手跑 2 次均 EXIT=0；与我的原件做**逐行机器比对：105 行逐行完全相同，无一行 DIFF**；关键字段对象级全等 |
| 逐行审查全 diff | **未发现删除/跳过场景、判据改宽、FAIL 改 NOT VERIFIED、预写数据库、改 `expected` 迁就实际、加 `try/catch` 吞失败、削弱复现性**；净效果是**加严** |
| 驱动逐字还原 | 对抗实验后 `git hash-object` == `git rev-parse HEAD:<path>`（`3af6d489…8ed`），`git diff --exit-code` = 0 |
| 对声明 6 / 7 的独立裁定 | 声明 6 **核心成立，但 2 处表述不成立**（= 本报告 F1、F2 更正的来源）；声明 7 **归因成立，但"偶发性"4/4 未复现**（= F4） |

**它不同意我的地方（已全部接受并更正）**：① 用"batch13 记录 8 项 FAIL"当 visibility 对照（F1，跨门禁混用）；
② 把 `-1719` / `could not create image from window` 归纳为权限限制（F2）；③ 把 A04-10 只记"既有偶发"就收尾（F3/F4）。

### 6.4 已知限制 / 脆弱点（登记，本批**不做代码改动**）

| # | 严重度 | 内容 | 处置 |
|---|---|---|---|
| F3 | 中低 | `browser-e2e.mjs:487` 既有脆弱点：`waitView` 15s 超时 → `aCookie2="{}"` → `.cookie` 为 `undefined` → 抛 `TypeError` **中止后续 restore 段**，掩盖可能的真实症状 | 登记为既有缺口 + 建议；**本批不改**（另一个门禁的驱动，超出授权范围） |
| F4 | 中低 | `test:d5-01` A04-10 崩溃**复现频次未知**（独立验收 4/4 未复现，本岗 2 次中 1 次） | 归因成立但触发条件未查明；如实登记 |
| F5 | 低 | `mustClick` 若被漏掉 `await`，失败路径会走 **unhandled rejection**：仍会立即非 0（EXIT=1）且**指名选择器、不会误报成功**，但绕过驱动的 `catch`/清理，**留下孤儿 electron 占住 CDP 端口**（独立验收已复现 `pid 15771 @9790` 并清理） | 登记为**使用注意事项**：新加调用一律必须 `await` |
| F6 | 低 | 安装段**其余**入口点击（`[data-d4-01-provider-create]`、`[data-d4-01-model-create]` 等）**未加即时失败守卫**，"入口缺失立即明确失败"目前**不普适** | 登记为**已知限制** + 后续建议。**上级裁定不做代码改动**：本批达标判据已满足、该发现为 Low，且把 create 按钮改成 `mustClick` 有"按钮瞬时 disabled 导致误报"的真实风险；**给已独立验证过的代码加东西会作废那次验证**。若要加，建议用**只断言存在性**的 `mustExist` 而非 `mustClick`，并需 **≥2 次连续复跑**证明不引入 flake |
| F7 | 低 | `S0b` 判据是**子串匹配**（`text('[data-d4-01-test-result="…"]').indexOf("Inference:PASS") >= 0`），产品自报 `Capabilities:NOT VERIFIED` 时门禁仍判绿 | 登记为**既有判据口径**（**非本批引入、不构成"换绿"**）；本批不改 |
| F8 | 低 | `s0a-diagnose.mjs` 头注释写"启动方式与 `browser-control-e2e.mjs` 完全一致"，但**默认 CDP 端口不同**（诊断 `:22` = 9793 / 门禁 `:35` = 9790；两者都读 `OA_D501_CTRL_CDP_PORT`）。端口不参与被测行为，不影响结论 | **仅更正本报告口径**（§1 首段已改为"同源、仅默认端口不同"）。**脚本注释本身未改**——代码已冻结在 `ac019a5`，改动它会作废独立验收；登记为低severity 措辞遗留 |

---

## 7. 未验收项、剩余缺口、以及我不同意的判定

### 7.1 本批已验收（有真机证据）

- `test:d5-01-control` 安装段 S0a/S0b/S0c 与 S1–S6：**46/0/2 PASS，EXIT=0**。
- S2 审批目标/地址三处一致性：**已逐值对照，一致**（§5）。
- D5-01 单测套件 37/37、boundary 32/0/1、`npm test` 1412/1412/0。
- 根因判定：驱动过时，**产品代码零改动**。

### 7.2 未验收 / 剩余缺口

1. **`test:d5-01-visibility` 未通过**：**22/3/25 + 1 NV**（已验收基线是 CLOSURE4 的 **25/0/1 全绿**；**本批不主张任何改善**）。
   3 项 FAIL（`V9` 缩放后指针命中、`V11` 四边近边界命中、`V12b` 最大化后还原）**全为前台争用**（`not-frontmost`），
   另有一次在同段硬中止。**关键缺口**：FAIL 时驱动**一次点击都没发**，所以这三项所测的**产品行为在本机仍未被验证**；
   闭环条件 = 一次"独占前台"的窗口期重跑。**本批不宣称它通过、也不宣称这三项无问题。**
2. **`test:d5-01` 主门禁**：第 1 次在 A04-10 抛错中止（未产出 counts），复跑 PASS 64/0/1。
   **归因成立**（该驱动与 `src/` 均与 `ae17ae9` 逐字节相同 → 非本批引入），但**复现频次未知**（独立验收 4/4 未复现），**触发条件未查明**；
   且 487 行的崩溃**掩盖**了"重新登录 + 导航 `/cookie` 后视图 15s 内未出现"这个**可能是真实症状**的信号 → 见 F3。
3. `tests/d4-main-e2e.mjs` 与 `tests/fixtures/**` 里同类陈旧 `data-app-id` 选择器**未验证、未修改**（§3.2 清单）。
4. `test:d5-01-control` 里 2 项 NOT VERIFIED 沿用既有口径，本批未新增验证手段。
5. **F6 的覆盖缺口**：安装段其余入口点击未加即时失败守卫，"入口缺失立即明确失败"**不普适**（上级裁定本批不做代码改动）。

### 7.3 我不同意的判定

- **不同意"这批失败是产品缺陷 / 需要改产品补 hook"**：实测显示产品侧入口、窗口、3 个 pane、全部 D4-01 控件均正常，
  0 pageerror、0 console error。改产品属过度修复。
- **不同意"visibility 的 FAIL 与选择器修复有关"**：3 项 FAIL 的证据链全部指向前台被 Google Chrome 占用（`activePid=83502`），
  且失败点位于指针/像素段，远在我改动的安装段之后；安装段的 `V2` 已 PASS。
- **不同意把 `test:d5-01` 首次的 A04-10 中止算到本批**：该驱动与产品代码均与基线逐字节相同（`git diff` 可证）。
- **不同意把 visibility 的失败说成"macOS 权限限制"**（F2 更正）：独立复测证明本机截图与辅助访问**当前可用**，
  当时的失败是**一次性 TCC 拒绝 + 前台争用**。口径写歪会污染后续批次判断（下次再遇 `-l` 失败会误以为是权限问题而不去查前台）——**我接受这一更正**。
- **不同意用"batch13 记录 8 项 FAIL"当 visibility 对照**（F1 更正）：batch13 从未跑过 visibility，属跨门禁混用——**我接受这一更正**。
- **不同意把 A04-10 只记"既有偶发"就收尾**（F3/F4）：487 行确实与 `ae17ae9` 逐字节相同，所以"非本批引入"没问题；
  但它掩盖了一个可能真实的产品症状，**该症状成因无人排查**——**我接受这一更正**，已登记为仍未查明的缺口。
- **提醒（不构成判定）**：`[data-app-id]` 在 `src/` 中出现 **0** 次，说明这类探针整体尚未跟进 Dock 的 hook 改名；
  建议单开一批统一核对，本批不动。

---

## 8. 界面改动纪律

**本批未改界面**（`git status --porcelain -- src/ electron/ package.json DESIGN_SYSTEM.md MOTION_SYSTEM.md PLAN.md` 为空），
故**无新增视觉/动效验收**，沿用 D5-01 既有已验收基准。

为免误读，明确未做：未新增 hook、未改样式/token、未改组件、未产生新截图或录屏交付物。
`artifacts/d5-01/visibility/*.png` 是 visibility 门禁自身运行产生的仪器截图（含失败轮次），**不作为本批界面验收证据**。
规范版本（供记录，本批未据其做任何改动）：`DESIGN_SYSTEM.md` = 设计提案 0.2 / 2026-09-10；`MOTION_SYSTEM.md` = 动效提案 0.1 / 2026-09-10。

---

## 9. 结束状态（真实计数）

**取证时（本岗交回时）的状态**：

```
$ git rev-parse HEAD
ae17ae9da17a475f267241fae0d56804db2794d2

$ git status --porcelain
 M experiments/d5-01/browser-control-e2e.mjs
 M experiments/d5-01/browser-inprocess-boundary-e2e.mjs
 M experiments/d5-01/visibility-e2e.mjs
?? experiments/d5-01/s0a-diagnose.mjs
?? experiments/d5-03/batch14/

$ git diff --stat
 experiments/d5-01/browser-control-e2e.mjs            | 9 +++++++--
 experiments/d5-01/browser-inprocess-boundary-e2e.mjs | 9 +++++++--
 experiments/d5-01/visibility-e2e.mjs                 | 9 +++++++--
 3 files changed, 21 insertions(+), 6 deletions(-)
```

**后续（上级提交后）**：上述改动被提交为被测 commit **`ac019a5`**（父 `ae17ae9`），
含 `browser-control-e2e.mjs`、`browser-inprocess-boundary-e2e.mjs`、`visibility-e2e.mjs`（各 9 行）与新增 `s0a-diagnose.mjs`（265 行），
`4 files changed, 286 insertions(+), 6 deletions(-)`。**本报告 §0.0 已自证：工作树内容与该 commit 逐字节相同，产品/测试/设计文档零改动。**

**本岗未做任何 `git commit` / push / merge / rebase / amend；未碰主工作树、DSH Desktop 运行时、`~/.dsh`。**

### 9.1 交付物清单

| 路径 | 内容 |
|---|---|
| `experiments/d5-01/s0a-diagnose.mjs` | 只读真机诊断脚本（第 1 步仪器）——已随 `ac019a5` 提交 |
| `experiments/d5-03/batch14/diagnose/10-real-machine-s0a-diagnose.txt` | 诊断全量原始输出（stdout+stderr） |
| `experiments/d5-03/batch14/diagnose/10-diagnose-findings.json` | 诊断关键结论（结构化，含每次观测快照） |
| `experiments/d5-03/batch14/20-control-after-fix.txt` | 修复后 `test:d5-01-control` 全量输出（EXIT=0） |
| `experiments/d5-03/batch14/artifacts-control-after-fix/` | 该轮门禁产物 JSON + 操作记录 JSONL |
| `experiments/d5-03/batch14/30-unit-d501-suite.txt` | D5-01 单测套件 37/37 |
| `experiments/d5-03/batch14/40-boundary-after-fix.txt` | boundary e2e 32/0/1 PASS |
| `experiments/d5-03/batch14/50-visibility-after-fix.txt` | visibility 第 1 次（截图段异常中止） |
| `experiments/d5-03/batch14/51-visibility-rerun.txt` | visibility 第 2 次（22/3/25 + 1 NV FAIL） |
| `experiments/d5-03/batch14/60-d501-main-after-fix.txt` | 主门禁第 1 次（A04-10 中止） |
| `experiments/d5-03/batch14/61-d501-main-rerun.txt` | 主门禁第 2 次（64/0/1 PASS） |
| `experiments/d5-03/batch14/70-npm-test-full.txt` | `npm test` 1412/1412/0 |
| `experiments/d5-03/batch14/verify/BATCH14-VERIFY-REPORT.md` | 独立对抗性验收报告（**他人产出，本岗未改写**） |
| `experiments/d5-03/batch14/D5-03-BATCH14-E1-REPORT.md` | 本报告（已按 F1/F2 更正 + F3–F8 登记） |
| `experiments/d5-03/batch14/D5-03-BATCH14-REPORT.md` | 汇总执行方报告（定稿） |
