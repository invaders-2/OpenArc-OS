# D1-04 两个探针的根因定位与探针修复报告

> 工作区：`/Users/wepingli/.openarc-worktrees/dxos-port-r1`
> 范围：只改 `experiments/d1-04/perf-product.mjs`、`experiments/d1-04/ui-audit.mjs`；
> 未动 `src/`（既有界面默认不动）、未动 `electron/`；未联网；未新增依赖；未改 CSP / tokens.css；未 git commit / push；未跑 build / test。
> 浏览器来源沿用上一波收口的 `experiments/lib/chromium.mjs`：本机 playwright 解析到 chromium-1243（不存在）→ 回退系统 Chrome **155.0.8059.41**。

## 0. 摘要

| 脚本 | 修前 | 修后 |
|---|---|---|
| `node experiments/d1-04/perf-product.mjs` | exit 1（page.click 超时：资源库窗口拦截「降低材质」） | **exit 0**，4 个 K × 3 档全部跑完，产物写入 `artifacts/d1-04/perf-product.json` |
| `node experiments/d1-04/ui-audit.mjs`（需先在 5210 起 dist 静态服务） | exit 1，19/27（8 FAIL） | **exit 0，27/27**（连跑两次一致） |

**8 条 FAIL 与 perf-product 的失败全部判定为 (a) 探针口径问题，未发现 (b) 产品缺陷。** 没有修改任何界面代码。

一处与任务描述的出入：ui-audit 实际 8 条 FAIL 里 **MS-A02 是"关闭后点击无幽灵触发"失败，不是 opacity**（本次实测 opacity 反而 PASS）。原因见 §4.2——这个循环本身是时序随机的，两次跑可能分别挂 opacity 或幽灵点击；修后两者都稳定通过。

## 1. 文件清单

改动（仅探针）：
- `experiments/d1-04/perf-product.mjs`（drag 取点、reduced 标题条取样）
- `experiments/d1-04/ui-audit.mjs`（组件清单分默认/需驱动、setup 清 `oa-wins`、MS-A02 确定化）

生成产物（未被 git 跟踪要求）：
- `artifacts/d1-04/perf-product.json`

临时调试脚本 `experiments/d1-04/_dbg-window-stack.mjs` 已删除。

未改动：`src/**`、`electron/**`、`src/design-system/tokens.css`、CSP。

## 2. 真实命令与真实输出

### 2.1 perf-product.mjs

命令（工作目录 = 工作区根）：
```
node experiments/d1-04/perf-product.mjs
```

**修前（exit 1）**：
```
page.click: Timeout 5000ms exceeded.
  - waiting for locator('.segmented.text[aria-label="材质"] button:has-text("降低材质")')
  - attempting click action
      - <div class="empty-content" data-d3-04b="unavailable">…</div> from
        <section aria-label="资源库窗口" class="window active " data-window-id="resource-library">…</section>
        subtree intercepts pointer events
    at selectTier (.../perf-product.mjs:254:14)
    at .../perf-product.mjs:472:13
```

**修后（exit 0）**：关键行
```
  K=  0 轮0 full     mean  16.67 ... p50  16.7 p95  16.7 long  0  [none]
  ...
  ── K=144 solid    mean  16.67 ... | 过滤面   0 个 / 面积        0 px (0.0% 视口)
产物：artifacts/d1-04/perf-product.json
代表性：NOT REPRESENTATIVE FOR ELECTRON
EXIT=0
```
产物里三档的产品态回读：
```
full    panes144 dataGlass full    win blur(34px) saturate(1.8)  title none          synth blur(34px) saturate(1.8)
reduced panes144 dataGlass reduced win none                     title blur(10px)    synth none
solid   panes144 dataGlass solid   win none                     title none          synth none
```

### 2.2 ui-audit.mjs

命令（两个进程；静态服务与上一波的用法一致）：
```
python3 -m http.server 5210 --directory dist          # 后台常驻
node experiments/d1-04/ui-audit.mjs
```

**修前（exit 1，19/27）**：
```
FAIL  组件存在：ContextMenu  — DOM 命中 0
FAIL  组件存在：SearchPanel  — DOM 命中 0
FAIL  组件存在：AIPanel  — DOM 命中 0
FAIL  组件存在：BrowserContainer  — DOM 命中 0
FAIL  组件存在：AddressBar  — DOM 命中 0
FAIL  组件存在：Badge  — DOM 命中 0
FAIL  组件存在：SettingsRow  — DOM 命中 0
...
PASS  MS-A02 无半透明残留（opacity 归位）  — opacity=1
FAIL  MS-A02 关闭后点击无幽灵触发  — 点击后窗口 2
19/27 checks passed
EXIT=1
```

**修后（exit 0，27/27，连跑两次一致）**：
```
PASS  组件存在：ContextMenu  — 右键桌面后 DOM 命中 1
PASS  组件存在：SearchPanel  — Cmd+K 后 DOM 命中 1
PASS  组件存在：AIPanel  — 助手胶囊后 DOM 命中 1
PASS  组件存在：BrowserContainer  — 浏览器窗口 DOM 命中 1
PASS  组件存在：AddressBar  — 浏览器窗口 DOM 命中 1
PASS  组件存在：Badge  — 资源库窗口 DOM 命中 1
PASS  组件存在：SettingsRow  — 系统设置窗口 DOM 命中 10
PASS  MS-A02 快速开关 10 次无残留窗口  — 剩余窗口 1
PASS  MS-A02 无半透明残留（opacity 归位）  — opacity=1
PASS  MS-A02 关闭后点击无幽灵触发  — 点击后窗口 1
27/27 checks passed
EXIT=0
```

## 3. perf-product：根因与探针改动

### 3.1 click 超时 = 探针用旧的 boundingBox 取点，把焦点送给了下层窗口（(a)）

产品侧把窗口的 `pointerdown` 解释为"聚焦/置顶"是有意语义（`src/desktop/components.tsx:593` `onPointerDown={() => !focused && onCommand({ type: "window/focus", id: w.id })}`）。探针错在"拖动用的坐标是第一趟量到的、窗口被拖走后没重新量"。

用真实 Chromium 复现的窗口轨迹（设置窗口 = 首个非分栏之外的最后打开的窗口）：
```
before drags : home(90,94) resource-library(142,118) settings(164,136,active,z=12)
warmup drag  : settings 被拖到 (126,156)          # 只是预热，窗口已经移位
timed drag   : 仍按旧 box(164,136) 起手 → pointerdown(364,154)
               (364,154) 在设置窗口新顶边 156 之上 → 命中资源库窗口标题栏
               → window/focus(resource-library) → resource-library z=12 active，settings z=11
hit-test 于「降低材质」中心 (843,441): ".empty-content in resource-library"
```
首次拖动之所以能点开设置窗口，是因为 setup 里 0/3 两个窗口按层叠偏移错开；错开量（22/18）小于窗口标题条高度（44），所以第一次命中设置标题条，第二趟起就滑出去了。

**探针改动**（`experiments/d1-04/perf-product.mjs`）：
- `drag(page, box, timed)` → `drag(page, target, timed)`，`target` 是 locator；每一趟（预热趟、计时趟）起手前都重新 `boundingBox()`。
- 冷口径调用点（`p.locator(".window").last()`）与热口径调用点（`page.locator(".window").last()`）同步改。
- 没有动被测行为：拖拽还是真的 40 步正弦位移，档位还是通过设置里的分段控件驱动。

### 3.2 reduced 标题条断言 = 取到了分栏窗口（(a)）

过了点击后，`reduced → none`（`EXPECT.reduced.title = /^blur\(10px\)$/`）。

- 产品实现：`src/styles.css:65`
  ```css
  .desktop[data-glass="reduced"] .window:not(:has(.split)) .window-title {
    background: rgb(var(--surface-rgb) / var(--surface-alpha));
    backdrop-filter: var(--glass-filter-window);   /* reduced 下 = blur(10px) */
  }
  ```
  排除分栏窗口是**有意的**（同文件 62-64 行注释：分栏窗口标题条只有 208px 宽、压在侧栏上，上材质会在红绿灯下多出一块底框；提交 `4f15a07 fix(ui): no title-bar backing frame in split windows (reduced tier)`）。
- 探针原取样 `document.querySelector(".window-title")` 取到的是**第一个**窗口，也就是 setup 打开的"应用中心"，而应用中心是 `.split`（`src/main.tsx:2541`）→ 计算值 none。

实测三档 × 逐窗口：
```
full    : home(split)=none  resource-library(非split)=none  settings(split)=none
reduced : home(split)=none  resource-library(非split)=blur(10px)  settings(split)=none
solid   : home(split)=none  resource-library(非split)=none  settings(split)=none
```

**探针改动**：取样改成 `document.querySelector(".window:not(:has(.split)) .window-title")`（`perf-product.mjs:263`），即产品这条规则实际作用的面。`EXPECT` 三个正则一字未改（full/solid=none，reduced=blur(10px)）。若以后没有任何非分栏窗口，`t` 为 null → 断言照旧失败（fail-closed），没有"找不到就算过"。

### 3.3 拖到第 N 趟时被 Dock 拦截（(a)）

修前面之后，K=0 全过，K=24 第 10 次点击被 `<nav class="dock">` / `<div class="window-title">` 拦截。原因是拖动轨迹**两端不对称**：`sin(39/4)*120 ≈ -38`、`y` 项多 `+20`，每趟把窗口往左下固定推一截（每趟 `drag()` 含预热+计时两段 → -76.8px / +40px）。几趟之后设置窗口的材质行就滑到 Dock 下面/视口外。

**探针改动**：两段位移在 `mouse.up()` 前先 `mouse.move` 回起点，使一趟拖动的净位移为 0——拖拽压力测试要的是"原地反复拖"，不是把窗口开出屏幕。同样是改"如何施加压力"，断言未动。

## 4. ui-audit：8 条 FAIL 逐条定位

### 4.1 组件存在 ×7 = 探针在"未打开"的默认态找组件（(a)）

这 7 个组件只在各自的状态下存在，探针却在一个只开着"应用中心"的页面里对所有选择器一起数 0：

| FAIL | 产品里何时存在（file:line） | 探针改法（到达状态） |
|---|---|---|
| ContextMenu | 桌面空白处右键（`src/main.tsx:3332-3339`） | `mouse.click(1200,700,{button:"right"})` |
| SearchPanel | `Cmd+K`（`src/main.tsx:1761`） | `Meta+k` |
| AIPanel | 点助手胶囊（`src/main.tsx:3615` 起 `overlays.ai`） | 点 `.assistant-pill` |
| BrowserContainer | 打开浏览器 App（`src/browser/BrowserApp.tsx:365`） | 点 dock `[data-dock-id="browser"]` |
| AddressBar | 同上（`BrowserApp.tsx:211`） | 同上 |
| Badge | 资源库无主进程服务时的"不可用"徽标（`src/resource/ResourceLibraryApp.tsx:358`） | 点 dock `[data-dock-id="resource-library"]` |
| SettingsRow | 打开系统设置（`src/main.tsx:2686` 等） | 点 dock `[data-dock-id="settings"]` |

逐条实测命中：右键 1、Cmd+K 1、胶囊 1、浏览器 1/1、资源库 badge 1、设置 setting-row 10。
**断言没有放宽**：每条仍是同一个 `rec("组件存在：X", count > 0, ...)`，只是先驱动到该状态。

配套的探针卫生：窗口会持久化在 localStorage `oa-wins`（`src/desktop/useDesktop.ts:20`），这一节为了取组件开的浏览器/资源库/设置窗口会带进后面的 MS-A02（"剩余窗口"变成 4）。所以 `setup()` 里加了 `localStorage.removeItem("oa-wins")`，让每个场景都从默认工作区（只有应用中心）开始。这是改起点状态，不碰任何断言。

### 4.2 MS-A02 幽灵点击失败 = 点击落点当时还在窗口里（(a)）

探针注释写的是"关闭后点原窗口区域"，但：

- 普通 App 的红灯**不是关闭，是最小化**（`src/desktop/components.tsx:598`：`closeAction={w.appId === "settings" ? "close" : "minimize"}`）。所以"应用中心关闭后"这个前提在当前产品里不存在。
- 10 次循环用的是 `click({ force: true })`，且开关之间不等动画；`min-out/min-in` 是 320ms，末态取决于最后一次点击落在哪一帧。用真实 Chromium 逐次打印的中间态就是"显示/收起交替"：
  ```
  after load  home minimized=false op=0.692
  iter 0      home minimized=true  minOut=true op=1
  iter 1      home minimized=false minIn=true  op=0
  ... 交替 ...
  after loop+400ms  home minimized=true op=0 visibility=hidden
  ```
  另一次跑（就是 ui-audit 的修前实跑）末态停在"显示"，于是 `document.querySelector(".window")` 读到 opacity=1；紧接着 `mouse.click(500,300)`——这个点落在应用中心窗口内、正好是应用卡片——于是开出一个新 App 窗口，窗口数 2 → 幽灵点击 FAIL。那不是幽灵，是点到了卡片。

**探针改动**（`ui-audit.mjs:126-160`）：
1. 循环后先等动画落定（700ms），若窗口停在 `.minimized` 则合法地还原一次，让 opacity 读到稳定值——`opacity === null || opacity === 1` 这条断言一字未改。
2. 幽灵点击前把窗口**确定地收起**（`.window .minimize`，普通 App 的红灯语义），再点它原来的位置 (500,300)。此时命中点是桌面（`elementFromPoint(500,300) === .desktop`），窗口数应保持 1——`after <= 1` 这条断言也一字未改。

因此这条 FAIL 不是产品留了幽灵，而是探针在一个"其实还开着"的窗口上点到了应用卡片。修后连跑两次都是 opacity=1 / 点击后窗口 1。

## 5. "改了探针什么 / 为什么不等于放宽断言"

1. **drag 取点**：由"一次量、反复用"改成"每趟重新量"。断言的被测对象（窗口、档位、材质回读）不变，只是让指针始终落在目标窗口上。
2. **拖拽轨迹**：抬手前回到起点，净位移归零。压力测试强度不变（仍是 40 步正弦、仍是真的拖动）。
3. **reduced 标题条取样**：由"第一个 `.window-title`"改成"`.window:not(:has(.split)) .window-title`"，即产品规则真正作用的面；正则期望原样保留。不是把"必须有 blur(10px)"改成"可以 none"——full/solid 仍要求 none，reduced 仍要求 blur(10px)。
4. **组件存在 ×7**：断言仍是 `count > 0`，只是先把面板/App 打开。没有任何一条从"必须存在"变成"可不存在"。
5. **MS-A02**：两条断言（`opacity===1` / `after<=1`）文本未动，改的是"先把动画走完、再进到确定态"这个到达方式；幽灵点击的取点前提（窗口已收起）现在由探针自己保证，而不是依赖一次随机点击的末态。
6. **setup 清 `oa-wins`**：让每个场景从默认工作区开始，消除上一场景窗口对下一场景的污染；不改变任何断言语义。

## 6. 未完成 / 未验证项

1. **未发现 (b) 产品缺陷，因此没有最小复现/影响面判断需要上报。** 但不排除本机环境差异：以上全部在系统 Chrome 155（非 Electron）上跑通，Electron 内 GPU/原生视图（WebContentsView、occlusion）路径未覆盖。
2. **perf-product 的数值不代表 Electron**：本轮只验证它能跑完并 exit 0；机器 loadavg 8-11，帧数据（K=0 也被 16.7ms 截平、丢 120Hz 100%）受无 GPU 与非 Electron 影响，脚本自己也打印 `NOT REPRESENTATIVE FOR ELECTRON`。产物 `artifacts/d1-04/perf-product.json` 已生成，是否作为基线由上层决定。
3. **hot 口径下 K=72/144 的过滤面积结论未复核**：本轮只跑默认热口径一次；冷口径（`OA_MODE=cold`）与浅色主题未跑。
4. **ui-audit 的 MS-A02 是时长敏感场景**：修后连跑两次均为 27/27，但机器负载极高时 700ms 的落定等待可能仍需调大；这是探针时序余量，不是产品问题。
5. **未跑 `npm run build` / `npm test`、未 commit/push**（按硬约束）。
