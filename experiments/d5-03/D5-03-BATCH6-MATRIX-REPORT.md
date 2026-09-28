# D5-03 第六批 · 真机验收报告（App 授权组织隔离 + 登录错误行不透明内容底）

- 被测提交：`d1ba058bdfb6b7d7cdb0d9e2c4115317a74adf7b`（分支 `integration/ui-core`，工作树除本报告新增/修改的 experiments 文件外干净）
- 真机：真实 `electron .` + 隔离 userData + 独占 CDP 端口；主题 / 玻璃档 / 壁纸全部通过**真实设置面板**切换
- 规范版本：`DESIGN_SYSTEM.md` 第 3 行「设计提案 0.2，2026-09-10」；`MOTION_SYSTEM.md` 第 3 行「动效提案 0.1，2026-09-10」
- 引用行号：DS :64（text.secondary）、:108（不发丝线框）、:126-140（四层材质表 / 减少透明度映射）、:154（字重）、:164（次级说明 12/18）、:248（对比门槛 4.5:1）、:251（必须量最终合成背景）、:267 DS-A02、:270 DS-A05；MS :21（duration.instant 0ms）、:145（减少动态映射为即时或 ≤100ms）、:177（减少动态作为稳定截图条件）、:192 MS-A07；PLAN :38 §4、:801 §42
- 边界：不连真实第三方、不发用户数据、不声称插件隔离通过、工具调用入口仍 `MCP_TOOL_INVOCATION_NOT_ENABLED`、协议仍 `2025-06-18`；未改产品代码（`src/**`/`electron/**` 的 `git status` 为空）；未 commit / push / 切分支

---

## 0. 三轴判定（先给结论）

| 轴 | 结论 | 依据 |
| --- | --- | --- |
| **功能** | **PASS** | 四段 MCP 门禁 26/26、38/38、29/29、43/43 全 exit 0；`npm test` 1363/1365（仅两条已知既有失败）；`auth-error-visual` 43/43 exit 0 |
| **视觉** | **PASS** | 10 格矩阵 × 2 面（向导面 + 设置面）全部 ≥4.5:1，且每格该行底 = **该行自身 token 底**（浅 `rgb(255,255,255)` / 深 `rgb(23,23,23)` / 深实色 `rgb(14,14,14)`），不再是玻璃卡合成灰 `181,181,181`；四个第五批基准点逐张复测通过；登录页两条错误行首次量到对比度 |
| **动效** | **PASS（含 1 条口径不符的如实登记）** | 常规档与减少动态效果档帧序列都「0 → 满格、无中间帧、无位移」，`animationName=none`、`transitionDuration=0s`；reduced 档元素作用域 `--dur-quick=0ms`。**但**常规档该 token 是 160ms 而不是 0ms（见 §7 notVerified），任务书「两档都 0ms」与实现不符，按实现记录、不改成通过 |

---

## 1. 必须披露：`experiments/d5-03/auth-error-visual.mjs` 的两处判定改动（唯一例外）

### 1.1 假阳性①：`.auth-error` 规则体按**行号硬切** → 改为按**选择器**提取

**旧口径（逐字）**：

```js
const authErrorRule = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8").split("\n").slice(2464, 2472).join("\n");
record("V7b", "本批未新增动效的代码级证据：81a211e→HEAD 改动文件里没有 .css / 动效文件，.auth-error 规则本身不含 transition/animation",
  !cssChanged && !/transition|animation/.test(authErrorRule), ...);
```

**为什么是假阳性**：第六批把 `.auth-error` 规则体从 2465 挪到 **2471–2478**，而切片 `slice(2464, 2472)` 固定取第 2465–2472 行 —— 实际取到的是「5 行注释 + 空行 + `.auth-error {` + `margin-top`」。也就是说：**6 条声明里只看得到 1 条**，`background` / `border-radius` / `padding` 全都不在切片里。"规则不含 transition/animation" 于是恒真（半空断言）。第五批之所以看着正常，只是运气：那时规则体正好落在 2465–2472（27eb 的 `actual.authErrorRule` 原样保存了那次的文本）。

**新口径**：新增模块 `experiments/d5-03/auth-error-css-audit.cjs`，按**选择器**提取规则体（剥块注释 → 花括号配对 → 逗号选择器列表逐项精确匹配），并给出声明数、声明名、是否含 `transition|animation`；行号只用于**报告描述**，不参与判定。新增判定 **V7c**：命中 1 条规则、≥6 条声明、必含 `background: rgb(var(--content-rgb) / 1)`、不含 `:empty` 的 `display`、不含 `transition|animation`，并且**同轮记录**旧切片只覆盖 1 条声明且不含 `background` 作为反证留痕。

**先红后绿证据（真跑）**：`experiments/d5-03/batch6-gate-rebase-proof.mjs`
- 变异 M2（在规则体**末尾**追加 `transition: color .16s var(--quick);`）：旧口径 **PASS（假绿）** / 新口径 **FAIL（抓住）**
- 变异 M4（追加 `animation: oa-fade-in .16s ease-out;`）：旧口径 **PASS（假绿）** / 新口径 **FAIL（抓住）**
- 变异 M3（不透明底退回 `/ 0.5`）：新口径 **FAIL（抓住）**，旧口径对它无感
- 真实工作树：旧口径 PASS（但只覆盖 1/6 声明）、新口径 PASS（6/6，无动效，底正确）
- 运行：`20260928T084038Z-e7c9`（9/11，先红：注入点落在切片范围内的那次也一并留档）、**`20260928T084047Z-866c`（11/11，sha256 `019a14032fafcd0a9caebdaef299c3df79964a3127bb24c3f6beabe4486c7def`，exit 0）**

### 1.2 假阳性②：`!cssChanged` 判据 → 重基线为「本批新增 transition/animation 声明数 = 0 + 运行时 V7a 全绿」

**旧口径（逐字）**：`const cssChanged = batchDiffFiles.some((f) => f.endsWith(".css")); ... !cssChanged && ...`，基线 `81a211e`。

**为什么必然 FAIL**：第六批的修复**本身就是改 `src/styles.css`**（给 `.auth-error` 加不透明内容底）。旧判据要求"本批 diff 不含任何 .css"——只要本批修的是 CSS，它就恒 FAIL。与第五批 R3 同形：**fail-closed 设计问题，不是产品缺陷**。

**新口径**：基线改为 `d4a3516`（第五批定稿提交，脚本断言它必须是 HEAD 祖先），判据 = `git diff <base> -- '*.css'` 的**新增行**里 `transition`/`animation` 声明数 **= 0**，且运行时 **V7a 仍全绿**；同轮把旧判据的结果作为反证记录（`legacy.cssChanged.wouldFail = true`）。

**先红后绿证据**：同上 harness —— 旧判据在本批 `cssChanged=true → FAIL（假红）`；新判据新增动效声明 0 条 → **PASS（真绿）**；把一条 `transition` 喂进同一个解析器能被数出来（反证新判据不是恒真）。

**未改动部分**：V1–V7a、Z1、Z2 与第一至第五批的所有断言一字未改；本批对 `auth-error-visual.mjs` 的改动只有上述两处 + 新增 V7c/V8–V12。

### 1.3 授权范围内的第三处改动：`mcp-policy-e2e.mjs` 的 R3 登记表（父 Agent 逐条授权）

旧登记表 4 项 → 新 5 项，新增 `src/styles.css`（`d1ba058 · 第六批`）。**这是门禁基线更新，不是判定削弱**：

| 判据 | 内容 |
| --- | --- |
| 必含（去空白精确匹配） | `.auth-error` 规则体内出现 `background: rgb(var(--content-rgb) / 1)` |
| 禁含① | 规则体内 `transition`/`animation` 声明数 = 0（与 V7a/V7b 运行时同口径） |
| 禁含② | 新增行不得出现 `--failed-rgb` / `--failed-alpha` |
| 禁含③ | `src/design-system/tokens.css` 的浅 `215 0 21` / 深 `255 69 58` 必须原值在（这两个 token 的定义地，不是 styles.css） |
| 范围 | 本批 `styles.css` 的**新增内容行**（剥块注释后）必须全部落在 `.auth-error` 规则体内；新增行不得出现 `{`/`}`、不得新增自定义属性 → `:root`/`.dark` 令牌块动不了 |
| 保持 | 表外 `src/` 改动一律 FAIL；`git diff` 取不到 → fail-closed FAIL；`addOnly`（只增不删）保持 |

**负向自证（真跑，仓库副本，验完不留痕）**：`experiments/d5-03/batch6-r3-rebase-proof.mjs`，用最小 git 仓库副本跑**同一个** `r3SrcDiffEvaluation`：

| 副本 | 变异 | 期望 | 实测 |
| --- | --- | --- | --- |
| control | 未改动 | PASS | **PASS** |
| case-i | 去掉不透明内容底 | FAIL | **FAIL** |
| case-ii | 深色 `--failed-rgb` 改成 `255 69 59` | FAIL | **FAIL** |
| case-iii | `.auth-error` 里加一条 `transition` | FAIL | **FAIL** |

- harness 末行：`R3 负向自证：全部符合预期（4 个副本）`
- 最终运行 **`20260928T092753Z-e537`**（4/4，sha256 `9c7f00e904a2fe6d08635a7525e76e70c10e9f8c5b4657e9dab10d595a835966`，exit 0）；两次中途运行（`3e07` / `7871`，3/4）一并留档
- **case-iii 抓出了我这个审计自己的真漏洞**：规则体第一条声明会和选择器粘在一起（`".auth-error {\n  transition: ..."`），导致"第一条就是 transition"漏检。已修为只取花括号内部再按分号切，修前它确实放过了 case-iii
- 副本在 `/tmp/d503f-r3-selftest`，跑完即删；`/var/folders/*/*/T/oa-d503f-r3-*` 残留为空
- **重跑对比**：`74ec`（42/43，exit 1）→ **`2780`（43/43，exit 0，notVerified 2，sha256 `79483f1db9cb8b7b4ec7a2bde9ed4f711fc2d3858c7ef2b3f1fc1eab4d76631e`）**；逐条比对 43 条，**状态不同的只有 1 条：R3 FAIL→PASS**；其它 42 条与 notVerified 2 条一字未动

---

## 2. 渲染与对比度矩阵（用户核心要求）

方法：`measureContrast` 裁行截图 → 页面内 canvas 解码 → **合成后**背景取众数像素（mode）、文字取与背景亮度差最大的像素 → WCAG 相对亮度。每格两个真实面：**初始化向导错误行**（`[data-d3-id="auth-error"]`，`.auth-card` 内）+ **系统设置错误行**（`[data-d3-id="settings-error"]`）。壁纸 = 产品内置两张（`theme-dark` 深色主题色 / `theme-light` 浅色主题色），玻璃档 = 设置「材质」分段控件（完整玻璃 / 降低材质 / 实色），全部走真实面板。

窗口 1440×940 / DPR 2 / 与第五批 27eb 同口径；新图存新 runId（**`20260928T094556Z-c729`**），未覆盖 27eb。

### 2.1 10 格矩阵（每格两面，全部 ≥4.5:1）

| # | 格（主题 × 玻璃 × 壁纸） | 向导面 ratio | 向导面 mode 像素 / modeShare | 设置面 ratio | 设置面 mode 像素 / modeShare | 静态预期 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | light × full × 深壁纸 | **5.372** | `255,255,255` / 0.6807 | **5.372** | `255,255,255` / 0.7103 | 5.38 |
| 2 | light × full × 浅壁纸 | **5.372** | `255,255,255` / 0.6809 | **5.372** | `255,255,255` / 0.7105 | 5.38 |
| 3 | light × reduced × 深壁纸 | **5.372** | `255,255,255` / 0.6807 | **5.372** | `255,255,255` / 0.9780 | 5.38 |
| 4 | light × solid × 深壁纸 | **5.372** | `255,255,255` / 0.6809 | **5.372** | `255,255,255` / 0.7102 | 5.38 |
| 5 | dark × full × 深壁纸 | **5.261** | `23,23,23` / 0.9309 | **5.261** | `23,23,23` / 0.7878 | 5.26 |
| 6 | dark × full × 浅壁纸 | **5.261** | `23,23,23` / 0.6807 | **5.261** | `23,23,23` / 0.7102 | 5.26 |
| 7 | dark × reduced × 深壁纸 | **5.261** | `23,23,23` / 0.6813 | **5.261** | `23,23,23` / 0.9780 | 5.26 |
| 8 | dark × reduced × 浅壁纸 | **5.261** | `23,23,23` / 0.6807 | **5.261** | `23,23,23` / 0.9780 | 5.26 |
| 9 | dark × solid × 深壁纸 | **5.665** | `14,14,14` / 0.6809 | **5.665** | `14,14,14` / 0.7103 | 5.67 |
| 10 | light × reduced × 浅壁纸（V9 也落在这一格） | **5.372** | `255,255,255` / 0.9485 | **5.372** | `255,255,255` / 0.9780 | 5.38 |

- **8 格主矩阵 + 2 格 solid 补充**；每格的 `computed backgroundColor` 也逐格核对等值（`bgIsToken=true`），不是只看像素。
- 该行底**只随主题变**（与壁纸、玻璃档解耦）：浅 `rgb(255,255,255)`、深 `rgb(23,23,23)`；深色实色档因为 `.dark[data-glass="solid"]` 把 `--content-rgb` 覆写成 `14 14 14`（tokens.css:283-284），该格底 = `rgb(14,14,14)`，同样只随主题+档位确定，与壁纸无关。
- 旧值对照：浅色 full + 默认深色壁纸的向导卡合成灰是 `181,181,181`（2.62:1）。

### 2.2 四个既有基准点复测（逐张对照 27eb）

| 文件（本次 runId `…-c729`，同名不同目录） | 27eb 旧值 | 本次实测 | 该行底 | 期望 | 判定 |
| --- | --- | --- | --- | --- | --- |
| `light-02-auth-error-row.png` | 2.620 | **5.372** | `255,255,255` (share 0.6807) | 5.38 | ✅ |
| `light-04-auth-error-row.png` | 5.192 | **5.372** | `255,255,255` (share 0.7103) | 5.38 | ✅ |
| `dark-02-auth-error-row.png` | 5.310 | **5.261** | `23,23,23` (share 0.8243) | 5.26 | ✅ |
| `dark-reduced-02-auth-error-row.png` | 5.159 | **5.261** | `23,23,23` (share 0.7878) | 5.26 | ✅ |

深色两点从 5.310/5.159 变成 5.261（微降 0.05/0.10），与提交信息一致；仍远超 4.5。

### 2.3 新增覆盖

- **登录页错误行（第五批从未量过对比度）**，配置 = light × reduced × 浅壁纸（第五批完全未覆盖的组合）：
  - `账号或密码不正确。`（错误口令，无 detail）→ **5.372**，mode `255,255,255` share 0.6976，clip 352×48
  - `尝试过于频繁，请稍后再试。`（**第 9 次**触发限流；RATE_LIMITED 的 detail 是对象，文案仍走白名单）→ **5.372**，mode `255,255,255` share 0.6845
- **浅色 × reduced**：矩阵第 3/10 格两个面 + 登录面，全部覆盖。

---

## 3. 布局证据

| 检查 | 结果 |
| --- | --- |
| 向导面错误行高度 | 36.40px ≥ 该元素 computed line-height 20.40px（≥1 行）✅ |
| 向导面「消失后不留空洞」 | 无错误行时元素**整段不在 DOM**（`display:none` 都到不了，`AuthErrorLine` 直接返回 null）；出现错误行后 `.auth-actions` 在 `.auth-card` 内容坐标下移 **48.4px = 行高 36.4 + margin-top 12.0**，与期望**完全相等** ✅ |
| 设置面错误行高度 | 36.40px ≥ 20.40px ✅；消失后元素整段移出 DOM ✅；内容区释放 61px（行高+margin = 48.4px，**残余 12.6px 成因未查明** → 见 §7 notVerified，不写成产品缺陷） |
| `.auth-actions` 按钮在卡内 + 与错误行不相交 | 向导面：全部按钮矩形 ⊂ `.auth-card`，`errorRect ∩ actionsRect = ∅` ✅；设置面：保存按钮 ⊂ 窗口卡，与错误行不相交 ✅ |
| 100/125/150/200% 缩放 × 长文案（注入 126 字） | 两个面 × 四档 = 8 组全绿：文档无横向溢出（`docScrollW == innerWidth`，1440→1152→960→720）、卡片横向不出视口、文字在自己盒内换行（`scrollW ≤ clientW`）、错误行与按钮行不相交、按钮在卡内 ✅ |

缩放口径说明：产品**没有缩放 UI**（Electron 菜单无 `zoomIn/zoomOut/resetZoom` 角色，渲染层也没有 zoom API），所以用 CDP `Emulation.setDeviceMetricsOverride` 复现浏览器缩放的**布局效果**（CSS 视口 1440/Z × 940/Z、设备像素比 2Z）。这一条按探针模拟登记，见 §7。长文案检查里的 126 字是把文本注入到错误行 DOM 上做**排版压力测试**（产品真实文案只有 7–13 字），真实文案在四档缩放下也各自量过。

---

## 4. 焦点证据（DS-A05 / DESIGN_SYSTEM:270）

| 目标 | Tab 路径 | 结果 |
| --- | --- | --- |
| 设置页「保存」 | 从相邻控件「显示名」起 **1 次 Tab** | `:focus-visible=true`、`outline: 2px solid`、`outline-offset: 2px` ✅；焦点环矩形（外扩 4px）与错误行矩形**不相交** ✅ |
| 向导「创建管理员」 | 从「确认密码」起 2 次 Tab | 同上四项全绿 ✅ |
| 向导「确认密码」 | 从「密码」起 1 次 Tab | `:focus-visible=true` ✅；产品在 `src/styles.css:1634-1639` **显式声明**「全应用输入框：不用任何线框/焦点环 —— 焦点只靠填充深浅变化表达」，所以该项按「焦点态填充 ≠ 失焦态填充」判：聚焦 `rgba(29,29,31,0.08)` vs 失焦 `rgba(0,0,0,0.04)` ✅；`outline-style: none` 如实记录 |

「错误行出现前 / 后各一次」都做了：出现前那一轮先整页回到干净向导并确认**错误行不在 DOM**（`errAbsentBeforeFocus=true`），再走同样的 Tab 路径。

> 口径披露：任务书要求「Tab 到确认密码…2px 焦点环 + 2px 间隔完整」。实现里**输入框不用焦点环**（产品显式设计，且不是本批引入）。按钮两处按 2px/2px 严格判定并通过；输入框改判为"可见焦点反馈"，原始 `outline-style: none` 一并留档。

---

## 5. 动效证据（MS:21/:145/:177，MS-A07）

方法：页面内定时器触发（改确认密码 → 40ms 后点「创建管理员」），Playwright 连续截图裁到错误行矩形 ±3px；指标用**红色像素数**（`r-g>40`）与**平均红度**，而不是"非底色像素"——错误行消失后下方按钮行会上移进入同一矩形，用底色差会被按钮文字污染。

| 档位 | 帧数 / 帧间隔 | 首现帧 | 中间帧（2%–75% 区间） | 末帧与首现帧矩形 | animationName | transitionDuration | 元素作用域 --dur-quick |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 常规 | 34 帧 / 中位 73ms | 第 8 帧 = 满格 2812 像素 | **0 个** | **一致（无位移）** | `none` | `0s` | `.16s`（160ms） |
| 减少动态效果 | 34 帧 / 中位 82ms | 第 2 帧 = 满格 2812 像素 | **0 个** | **一致（无位移）** | `none` | `0s` | `0ms` |

- 两档都是「0 → 2812 像素」的一步跳变，没有任何中间帧 ⇒ **即时出现、无淡入、无位移**；帧间隔中位 73/82ms，所以"即时"的分辨率上界 ≈ 80ms，满足 MS:145「≤100ms」。
- 减少动态效果档由**真实设置面板**开启（`.desktop.reduced=true` 实测）。
- 每档抓帧前先确认错误行**不在 DOM**（`absent1/absent2 = true`），触发路径与真实用户一致（改输入框 + 点提交）。
- 帧序列逐帧 PNG 保存在 `artifacts/d5-03/runs/20260928T094556Z-c729-auth-error-visual/visual/motion-frames/`（`wizard-normal-00..33.png`、`wizard-reduced-00..33.png`），每档另存一张整窗图。**说明：这是连续帧序列（≈13fps 采样）而不是视频文件**，对"有无淡入/位移"这类逐帧可判的性质，帧序列比视频更便于核验；不声称做过视频编码。

---

## 6. 门禁与回归（全部真机、串行、各自 runId / sha256）

| 门禁 | counts | exit | notVerified | runId | artifact sha256 |
| --- | --- | --- | --- | --- | --- |
| `mcp-reset-e2e` | 26/26 | 0 | 3 | `20260928T091457Z-f559` | `9c2c91a1eb5e9dc4b33d134ea377fa7c43511338ea133f5270a56de26133e254` |
| `mcp-center-e2e` | 38/38 | 0 | 0 | `20260928T091508Z-967d` | `6726b742034d49c1f4bb09d252e6e8585339b94e1af567859421e26d6c070b1e` |
| `mcp-stream-e2e` | 29/29 | 0 | 0 | `20260928T091545Z-23e3` | `8df59d5277f10d1034f75a21a1ed953266f9057715752476fe99386edd044b34` |
| `mcp-policy-e2e`（R3 重基线后） | **43/43** | **0** | **2** | `20260928T095113Z-2780` | `79483f1db9cb8b7b4ec7a2bde9ed4f711fc2d3858c7ef2b3f1fc1eab4d76631e` |
| ↳ 同一门禁（重基线前，留档） | 42/43 | 1 | 2 | `20260928T091621Z-74ec` | `95ae1de005e2a8695156630028f6be7eea6df0dd3df3152f82955f704f8201fe` |
| `auth-error-visual`（本批门禁修正 + 矩阵） | **43/43** | **0** | 2 | `20260928T094556Z-c729` | `1e87ced41e3b9c453e206d2b63e44290e244f06d8dcbe50fd27a9340778ca86b` |

**计数不得低于上一轮**：reset 26 ≥ 26 ✅、center 38 ≥ 38 ✅、stream 29 ≥ 29 ✅、policy 43 ≥ 43 ✅（重基线前那一轮 42/43 已按"如实报告并停下说明"处理，并经父 Agent 逐条授权后重基线）。

### 6.1 探针改动复核（第六批按新契约改了三个真机 fixture）

| 门禁 | 结果 | 说明 |
| --- | --- | --- |
| `node --test tests/d4-04-closure2-boot.test.mjs` | **9/9 pass，exit 0** | 该 fixture 的「全表读取」改动被真实执行到 ✅ |
| `node tests/governance-ui.mjs` | 1/5 UI checks，**exit 1** | 崩在探针 `main.cjs:91-92`（`userByIdentifier` 返回 null → `u2.id` 抛错），在**改动行 104/106/108 之前**；stderr 全是 `No handler registered`（browser:command / files:list / canvas:command），是该探针只注册部分 IPC 的固有形态 |
| `node tests/model-keychain-restart.mjs` | 3/15，**exit 1** | 崩在 `appById("settings") === null` → `createProvider` 直接 `PROXY_UNAUTHORIZED`；改动的第 97 行只换 grant 的**读**法，失败发生在它**上游**的 `!app` 检查 |

**A/B 实测（父 Agent 一次性授权：临时回退这两个 fixture → 跑 → 立刻恢复）**：

| 门禁 | 本批 fixture（HEAD） | 回退到 `d4a3516`（本批之前） | 失败点 |
| --- | --- | --- | --- |
| governance-ui | 1/5，exit 1 | **1/5，exit 1** | 完全相同（G1/G2/G3 + `null.id`） |
| model-keychain-restart | 3/15，exit 1 | **3/15，exit 1** | 完全相同（D1.2 `null` / D1.4 `PROXY_UNAUTHORIZED` / 4 个 phase 抛错） |

⇒ **两条都是既有失败，与本批改动无关**（实测，不只是结构推断）。恢复后逐字节验证：`shasum -a 256` 与回退前一致（`b8cfbd089c9a5a8b…` / `cf71d77a018d286f…`），`git status --porcelain -- <两个 fixture>` 为空，工作树的 blob 与 `HEAD` 一致。**未改动任何 `tests/**`**（恢复后 `git status` 里没有任何 tests 改动）。

补充证据：`settings` 这个 App Principal 由 `electron/model-bootstrap.cjs:44` 的 `seedModelAppPolicy` 在**拿到会话时**补种，而该探针的 `boot()` 从未调用它；并且 `git show 81a211e:electron/identity-store.cjs` 的内置种子表里**本来就没有 `settings`**（早于本批两个批次）。

### 6.2 全量回归 `npm test`

```
# tests 1365
# pass 1363
# fail 2
exit 1
```

两条失败正是任务书已知的既有失败，与本批无关：
1. `P2 · 当前会话 = A（owner）：推送投递，载荷 = 白名单投影且与 getApprovalRequest 一致`（`tests/d4-03-approval-push-isolation.test.mjs`）
2. `No Direct Domain Bypass：resource.trash 的唯一 Domain 调用点在 allowlisted adapter + controlled execution 内`（`tests/side-effect-c4-gates.test.mjs`）

### 6.3 过程中另有 4 次运行（全部留档，未删）

| runId | 脚本 | 结果 | 用途 |
| --- | --- | --- | --- |
| `20260928T085957Z-9d2a` / `090057Z-6571` | `batch6-matrix-diag` / v2 | — | 定位「reset 后渲染层立刻落到登录页」的状态机诊断（见下） |
| `20260928T090142Z-1ff2` | `batch6-matrix-diag2` | — | 逐字复现矩阵转场，证明 reload 后确实回到 `uninitialized` |
| `20260928T090234Z-5720` / `090853Z-0bde` / `092420Z-f1b8` / `092716Z-6234` / `093950Z-8fcf` | `auth-error-visual` | 26/31、26/32、38/41、38/43、41/43 | 矩阵/布局/焦点/动效的工装迭代轮次 |
| `20260928T084553Z-f364`（目录存在，**无 JSON / 无索引项**） | `auth-error-visual` 冒烟（`OA_D503F_CELL_LIMIT=2`） | 中止 | 冒烟跑发现状态机缺陷后有意识终止，未走 `finalize`（所以没有索引项），`visual/` 截图作为缺陷证据保留 |

**诊断结论（对后续门禁脚本有用）**：`identity/reset-installation` 会让**正在运行的渲染层立刻落到登录页**（主进程发 `LOGGED_OUT` → `useIdentity` 清空 snapshot → `gate=unauthenticated`），此时 `identity/status` 已经是 `UNINITIALIZED` 但页面上还没有向导 —— **只有 reload 之后才会出现向导**。所以任何门禁在 reset 之后**必须 reload 并按「gate=uninitialized 且 `[data-d3-id=setup-name]` 在」双条件判定**，光看 gate 会在登录页上误判（登录页也有同一条 `.auth-error`，会把两个面混成一个）。这个坑本批踩到并已修进矩阵脚本。

---

## 7. notVerified 清单

1. **「normal 与 reduced 下元素作用域 `--dur-quick` 都是 0ms」** —— 实现里 `--dur-quick` 只在 `.reduced` 作用域被置 0（`src/design-system/tokens.css:358`），常规档是 160ms（同文件 `:170`，computed 值 `.16s`）。该行自身没有 `transition`/`animation` 声明，两种档位 computed `transitionDuration` 都是 `0s`，所以「立即出现」在两种档位都成立（帧序列已证）。**任务书写「都 0ms」与实现不符，按实现记录，不改成通过。**
2. **设置面错误行消失后的空间释放量精确等于「行高 + margin」** —— 实测释放 61px，行高+margin = 48.4px，**残余 12.6px 成因未查明**。已确认元素整段移出 DOM 且空间确有释放；同一判据在向导面（错误行下方有 `.auth-actions`，可量位移）**精确成立**（48.4 = 48.4）。不作为产品缺陷登记。
3. **产品 Zoom 的"真实入口"** —— 产品没有缩放 UI / API，四档缩放的布局效果由 CDP `Emulation.setDeviceMetricsOverride` 复现，不是按了产品的缩放快捷键。
4. **缩放矩阵里的长文案** —— 126 字是把文本注入错误行 DOM 做排版压力测试，不是产品真实文案（真实文案 7–13 字也各自在四档缩放下量过）。
5. **动效证据是连续帧序列而不是视频文件** —— 帧间隔中位 73/82ms；对"有无淡入/位移"逐帧可判，但没有做视频编码，也没有做人工节奏评审。
6. **`mcp-policy-e2e` 的两条既有 notVerified**（与本批无关，第二次重跑仍为 2 条）：同一安装内第二个组织无法用产品入口构造；跨组织**行为级**不互相覆盖。
7. **`governance-ui` / `model-keychain-restart` 两条探针门禁本身** —— 已用 A/B 实测证明是**既有失败**（与本批改动无关），但这两条门禁**在当前提交上不通过**，需要单独的修复排期；我不在本次范围内改 `tests/**`。
8. **`.auth-error` 在「减少透明度（= 产品实色档 solid）」下的浅色 token** —— `light × solid` 的 `--content-rgb` 仍是 `255 255 255`，与 `light × full` 同值，所以这一格只证了"等于自身 token"，没有额外的区分度；深色实色档有区分度（`14 14 14` ≠ `23 23 23`）。

---

## 8. 索引、临时目录与工作树核对

- 索引 `artifacts/d5-03/runs/index.json`：**64 条**，本次会话新增 20 个 run 目录；**逐条复核 64 个 artifact 的 sha256 与索引记录全部一致（0 不一致）**；旁挂 `.sha256` 64/64 一致；`runId` 无重复；`index.jsonl` 64 行（只追加）。【**第六批订正（定稿复核）**：报告初稿写「61 条 / 60 行」，经定稿岗复核为 **64 条 / 64 行**（会话前 44 条 + 本次会话 20 条 = 64）；64 个 artifact 的 sha256 全部一致、**0 缺失、0 重复**。初稿数字的来源不改写历史，以本节订正值为准。】
- **报告初稿未提及的两个运行目录（第六批定稿补登，如实标注性质）**：① `artifacts/d5-03/runs/20260928T092533Z-cf4e-batch6-r3-rebase-proof` —— **空目录**：无 JSON、无索引项、无任何 artifact，不参与任何判定；② `artifacts/d5-03/runs/20260928T093239Z-fcfa-auth-error-visual` —— 工装迭代轮，counts **39/40 · exit 1**，产物已入索引并留档，报告 §6.3 的迭代清单未列。
- **历史 artifact 未被改写**：会话前已有的 44 个 run 目录，本次会话中被修改过的 **0 个**（含 27eb 的 `auth-error-visual.json` / 截图，mtime 仍是 15:06）
- **临时目录**：跑完 `ls -d /var/folders/*/*/T/oa-d503*` 只剩 **`oa-d503f-probe-AGgbdV`**（mtime 16:25，**早于本会话首次运行**；仓库里没有任何代码产出这个前缀 —— 唯一相近的是 `tests/d5-03-app-grant-org-isolation.test.mjs:58` 的 `oa-d503f-seed-`，且该测试会自清理）。按"只清自己的"原则未删除，如实登记；本次所有 electron userData 目录均经 `userdata-ownership.cjs` 建后即清（每个 run 的 `cleanup.leftovers` 都是 `[]`，`pkillUsed=false`）
- 进程：本次 spawn 的 pid 树全部回收（`leftovers: []`），`pkill` 未使用；收尾时无我方 Electron 残留
- 工作树：`git status --porcelain -- src electron` **为空**（产品代码未改）；HEAD 仍 `d1ba058`，分支仍 `integration/ui-core`，未 commit / push

---

## 9. 交付物

| 文件 | 说明 |
| --- | --- |
| `experiments/d5-03/auth-error-visual.mjs` | 本批门禁：两处假阳性修正（按选择器提取 + V7b 重基线）+ 新增 V7c/V8–V12 |
| `experiments/d5-03/auth-error-css-audit.cjs` | 新：按选择器提取 `.auth-error` 规则体（含旧口径复现，仅作反证） |
| `experiments/d5-03/auth-error-matrix.cjs` | 新：10 格矩阵 + 布局 + 焦点 + 动效帧序列 |
| `experiments/d5-03/batch6-gate-rebase-proof.mjs` | 新：V7b 两处假阳性的先红后绿反证（11/11） |
| `experiments/d5-03/batch6-r3-rebase-proof.mjs` | 新：R3 新增项的负向自证（4/4，含 harness 末行） |
| `experiments/d5-03/batch6-matrix-diag.mjs` / `batch6-matrix-diag2.mjs` | 新：状态机诊断（reset 后必须 reload 才能回向导） |
| `experiments/d5-03/mcp-policy-e2e.mjs` | 改：R3 登记表 4 项 → 5 项（父 Agent 逐条授权），其余未动 |
| `artifacts/d5-03/runs/20260928T094556Z-c729-auth-error-visual/` | 本批正式矩阵证据（JSON + 日志 + 41 张截图 + 68 帧动效序列） |

## 10. 遗留

1. `governance-ui` / `model-keychain-restart` 两条探针门禁在当前提交上不通过（**既有失败**，A/B 已证），需要单独修复排期；两者都是探针自身缺少宿主职责（governance 探针只注册部分 IPC；keychain 探针的 `boot()` 不调用 `seedModelAppPolicy`），不是产品缺陷。
2. 设置面错误行消失后的 12.6px 残余释放量成因未查明。
3. `oa-d503f-probe-AGgbdV` 这个会话前遗留的空临时目录未清（不属于本次运行）。
4. `auth-error-visual` 的矩阵段单轮约 20 分钟（10 格 × 2 面 + 布局/焦点/动效），后续若要常态化回归，建议拆分或按 `OA_D503F_CELL_LIMIT` 冒烟。
