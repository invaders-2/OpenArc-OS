# D1-04 组件、视觉系统与性能技术验证

> **Task Status: PARTIAL**
> **Component Baseline: ESTABLISHED（清单与测量方法已冻结）**
> **Spectrum UI Verdict: REFERENCE ONLY（不引入源码）**
> **ui-light-bar-zero Verdict: ADAPT（方向采纳，两处按实测修正）**
> **D1-04B：REDUCED 档已进入产品代码（`data-glass` 三态）；主题合成已改为消费点合成**
>
> 判定为 PARTIAL 不是"做了一半"，而是两条硬性缺口仍未关闭：
> 性能数字只在 Chromium 取得（Electron 内 NOT VERIFIED）、Windows 平台未验证。
> 这两条都直接命中"测量条件"的代表性，在关闭前不得宣布 COMPLETE。
> （原第三条"REDUCED 档只定义未实现"已由 D1-04B 关闭，见第 20 节。）

- 分支：`feature/d1-04-design-performance`（自 `b39eb93` 拉出，不含 D1-03 Adobe 内容）
- 日期：2026-09-10（D1-04）/ 2026-09-11（D1-04B）
- 上游基线：PRODUCT.md / PLAN.md（D1-04、A12、A29、D2-01）/ DESIGN_SYSTEM.md / MOTION_SYSTEM.md / PROGRESS.md / CHANGELOG.md
- 实测脚本：`experiments/d1-04/`（D1-04 七个 + D1-04B 七个）
- 产物：`artifacts/d1-04/`

---

## 1. 结论摘要

| 交付项 | PLAN D1-04 要求 | 本轮结果 |
|---|---|---|
| 组件许可清单与基准 | 建立 | **ESTABLISHED** — 20 Primitives + 11 Desktop 矩阵，16 个现有组件逐个定级 |
| 动效可采用 | 判定 | **可采用** — MS-A02 / A29 / 可打断性 / 对比度全部实测通过，修掉 1 个真实 a11y 缺陷 |
| 测量条件及目标冻结 | 冻结 | **已冻结** — 固定负载单位（420×300 玻璃面板）+ 三档材质 + 拖动采样；TARGET/MEASURED/NOT VERIFIED 三分离 |

三件必须记住的事：

1. **Spectrum UI 整体 REFERENCE ONLY。** 仓库级 Apache-2.0 已确认，但目录中确实混入第三方 MIT 源码（Dynamic Island 与 Toast Stack 页面自述来自 beUI / beui.dev MIT），且第三方聚合站对同一仓库同时声称 MIT 与 Apache-2.0。更决定性的是：Spectrum 依赖 Tailwind CSS + Motion，OpenArc 是无 Tailwind 的纯 CSS token 体系，引入等于换样式范式，属被禁止的大重构。
2. **性能数字不代表 Electron。** 本机 Electron 的 GPU 进程在代理执行环境下起不来，全部数据取自 Chromium 152 + ANGLE Metal（M3 Pro）。方法可复用，数字不可直接外推。
3. **REDUCED 档位只有定义没有实现。** 产品现在只有 FULL（`blur(34px) saturate(1.8)`）与 SOLID（`.opaque`）。本次用注入 CSS 模拟 REDUCED 测出它值多少钱，但产品代码里它不存在。

---

## 2. 执行环境（代表性声明）

| 项 | 值 |
|---|---|
| 机型 | Mac15,7 / Apple M3 Pro / 12 核（6P+6E）/ 18 GB |
| 系统 | macOS 26.6.2 |
| 显示器 | 3456×2234 Retina（测量视口固定 1440×900） |
| GPU | ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro) |
| 浏览器 | Chromium 152（本地 `chromium-1228`），**非 Electron** |
| Electron | 44.3.0 / Chromium 152.0.7977.78（二进制存在，但 GPU 进程在本环境不可用） |

**代表性判定：NOT REPRESENTATIVE。** 原因有两条，都必须写在每个数字旁边：

- 承载件是 Chromium 不是 Electron，窗口合成路径不同；
- 本机 Chromium sandbox 起不来（`Operation not permitted`），必须 `--no-sandbox --disable-gpu-sandbox --in-process-gpu`，GPU 进程形态被改过。

因此本 ADR 中所有性能数字标注为 **MEASURED (Chromium)**，Electron 内的对应值一律 **NOT VERIFIED**。

---

## 3. 现有 UI 组件审计（16 项）

定级口径：IMPLEMENTED = 有真实 DOM 与交互；PARTIAL = 存在但覆盖面不足；PLACEHOLDER = 有壳无真实数据；MISSING = 不存在。

| 组件 | 定级 | 证据 |
|---|---|---|
| TopBar | IMPLEMENTED | DOM 命中 1，含 5 个按钮、字标、traffic bar |
| TrafficLights | IMPLEMENTED | 命中 2（窗口标题栏内 14px + 顶栏字标左侧 12px） |
| Dock | IMPLEMENTED | 7 个 `<button>`，均带 aria-label；距离波浪放大 + tooltip + 弹跳 + 运行指示点 |
| Window | IMPLEMENTED | 命中 1，拖动/缩放/最小化/最大化实测可用 |
| TitleBar | IMPLEMENTED | 命中 1，本轮改为 transparent |
| ContextMenu | IMPLEMENTED | 右键后 DOM 1，Esc 可关（本轮修复） |
| SearchPanel（Cmd+K） | IMPLEMENTED | Cmd+K 命中 1，Esc 命中 0 |
| AIPanel | IMPLEMENTED | 命中 1，含 connection-card |
| WebViewport | IMPLEMENTED | 真实 WebContentsView，非 iframe（D1-01 已证） |
| AddressBar | IMPLEMENTED | 浏览器应用内命中 |
| Badge | IMPLEMENTED | 浏览器/文件等应用内命中 |
| AppCard / AppGrid | IMPLEMENTED | 应用中心命中 5 |
| SettingsRow | IMPLEMENTED | 设置内命中 |
| EmptyContent | IMPLEMENTED | 命中 1 |
| AdobeRow | **PLACEHOLDER** | 有 UI 无真实探测，`src/main.tsx` 中状态为硬编码 |
| Toast / Notification | **MISSING** | 全仓无 toast 类 |

补充：桌面态可 Tab 元素 22 个（Dock 7 + 顶栏 5 + 其余），不存在"桌面态键盘不可达"。

---

## 4. 组件基线矩阵

### 4.1 Primitives（20）

需求等级：P0 = D2 前必须有；P1 = D5 前；P2 = 可延后。

| # | Primitive | 等级 | 现状 | 说明 |
|---|---|---|---|---|
| 1 | Button | P0 | IMPLEMENTED | `.primary` / `.danger` / 图标按钮 |
| 2 | IconButton | P0 | IMPLEMENTED | 全部带 aria-label（实测缺失 0） |
| 3 | TextField | P0 | PARTIAL | `search-input` / `folder-rename` 有，无通用输入框 |
| 4 | SearchField | P0 | IMPLEMENTED | SearchPanel 内 |
| 5 | Textarea | P1 | MISSING | AI composer 为单行 |
| 6 | Select | P1 | MISSING | 设置里无下拉 |
| 7 | Checkbox | P1 | MISSING | |
| 8 | Switch | P1 | MISSING | 设置项用按钮代替 |
| 9 | Radio | P1 | MISSING | |
| 10 | Slider | P2 | MISSING | |
| 11 | Tooltip | P0 | PARTIAL | 仅 Dock tooltip，非通用 |
| 12 | Badge | P0 | IMPLEMENTED | |
| 13 | Avatar | P2 | MISSING | |
| 14 | Progress | P1 | MISSING | |
| 15 | Spinner | P1 | MISSING | |
| 16 | Divider | P0 | IMPLEMENTED | `.dock-divider` |
| 17 | Kbd | P2 | MISSING | |
| 18 | Link | P2 | MISSING | |
| 19 | ScrollArea | P0 | IMPLEMENTED | `settings-content` / `window-body` |
| 20 | Surface/Card | P0 | IMPLEMENTED | `app-card` / `connection-card` |

### 4.2 Desktop Components（11）

| # | 组件 | 等级 | 现状 | 说明 |
|---|---|---|---|---|
| 1 | TopBar | P0 | IMPLEMENTED | |
| 2 | TrafficBar | P0 | IMPLEMENTED | 操作 `activeWin`，无目标时置灰 |
| 3 | Dock | P0 | IMPLEMENTED | |
| 4 | DockItem | P0 | IMPLEMENTED | 真 `<button>` |
| 5 | DockTooltip | P0 | IMPLEMENTED | |
| 6 | Window | P0 | IMPLEMENTED | |
| 7 | TitleBar | P0 | IMPLEMENTED | |
| 8 | WebViewport | P0 | IMPLEMENTED | 原生视图，遮挡只能靠 `setVisible(false)` |
| 9 | AddressBar | P0 | IMPLEMENTED | |
| 10 | ContextMenu | P0 | IMPLEMENTED | 本轮补 Esc |
| 11 | AssistantPill / AIPanel | P0 | IMPLEMENTED | 独立 `--pill` token |

**结论：** P0 共 17 项，其中 IMPLEMENTED 14、PARTIAL 2（TextField / Tooltip）、MISSING 1（无）。D2-01 的前置在组件面上是满足的。

---

## 5. Spectrum Component Audit

### 5.1 License 判定（先于一切）

| 来源 | 说法 |
|---|---|
| `github.com/arihantcodes/spectrum-ui` API `license` | `apache-2.0`（GitHub 检测） |
| 该仓库根 `LICENSE` 文件 | Apache License 2.0（实际抓到正文） |
| 官网 `ui.spectrumhq.in` 组件页 FAQ | "available under the Apache License 2.0" |
| 官网组件页自述 | Dynamic Island = **beUI（beui.dev, MIT）**；Toast Stack = **beUI（beui.dev, MIT）** |
| 第三方聚合站 allshadcn.com | "MIT license" |
| 第三方聚合站 shadcn.io | 同一页内既写 "Apache-2.0 licensed project" 又写 "every Spectrum UI file is MIT-licensed" |

**判定：仓库级授权明确为 Apache-2.0，但"逐文件来源"不统一。** 目录内确实存在第三方 MIT 源码（至少 Dynamic Island、Toast Stack 两个页面自述来自 beUI）。MIT → Apache-2.0 再授权本身可行，但依赖逐文件归因是否保留，本轮未做逐文件审计。

按 D1-04 预设规则"License 不清楚的记为 REFERENCE ONLY"，并且这里出现了第二个更强的理由（见 5.3），因此：**全目录 REFERENCE ONLY。**

### 5.2 六个组件的 15 属性

状态：ADOPT（直接采用）/ ADAPT（改造后采用）/ REFERENCE ONLY（只看不抄）/ REJECT（不采用）/ UNKNOWN（未验证）。

**① Command Search** — `motion`, `lucide-react`

| 属性 | 值 | 属性 | 值 |
|---|---|---|---|
| 依赖 | motion, lucide-react, @spectrumui/use-typewriter | Radix | 无 |
| ARIA | listbox（源码含 ARIA） | 键盘 | 方向键 + Enter |
| 受控 | 否（内部管 query） | reduced-motion | **未检测到** |
| Tailwind | 是 | Next.js 约定 | 是（`use client`） |
| 动效 | 自动打字 + 实时过滤 | 默认行为 | `autoType=true` 自动播放 |
| 尺寸 | `height=408` 固定 | 可定制 | className + 改源码 |
| 许可证 | Apache-2.0（页面声明） | 来源 | Spectrum 自研 |

**判定：REJECT。** 两个硬性冲突：`autoType=true` 默认自动打字是装饰性循环播放，直接违背 A29 与 MOTION_SYSTEM；且 OpenArc 的 Cmd+K 是真实搜索，不需要"演示式自动输入"。无 reduced-motion 路径是第二个独立否决理由。

**② Animated Switch** — `framer-motion`

| 属性 | 值 | 属性 | 值 |
|---|---|---|---|
| 依赖 | framer-motion | Radix | 无 |
| ARIA | `role="switch"` + `aria-checked` | 键盘 | 支持 |
| 受控 | 支持 `checked` / `defaultChecked` | reduced-motion | **已处理** |
| Tailwind | 是 | Next.js | 是 |
| 尺寸 | sm 32×18 / md 44×24 / lg 56×30 | disabled | 支持 |
| label | `"Toggle"` 可配 | 图标 | onIcon/offIcon 交叉淡入 |
| 拖拽 | 支持（拉/甩） | 许可证 | Apache-2.0 |

**判定：REFERENCE ONLY。** 交互定义（role=switch + 拖拽 + reduced-motion）值得抄进规范，但源码本身要 Tailwind + framer-motion，不引入。注意它用的是 `framer-motion`，而 Command Search 用 `motion` —— 同一个库两个包名，混用存在双份打包风险，这是该目录工程一致性的一个信号。

**③ Dynamic Island** — `motion`, `clsx`, `tailwind-merge`

| 属性 | 值 | 属性 | 值 |
|---|---|---|---|
| 依赖 | motion, clsx, tailwind-merge | Radix | 无 |
| ARIA | 源码含 ARIA | 键盘 | 未声明 |
| 受控 | `view: string \| null` | reduced-motion | **已处理** |
| Tailwind | 是 | Next.js | 是 |
| 动效 | 真实宽高 + 长弹簧 + 视图交叉淡入模糊 | 视图 | DynamicIslandView id 匹配 |
| 第三方来源 | **beUI（MIT）** | 许可证 | Apache-2.0（页面声明） |
| 尺寸 | 由内容决定 | | |

**判定：REFERENCE ONLY。** 这正是 OpenArc 桌面 AI 胶囊的同类形态，动效手法（真实宽高动画 + 长弹簧 + 视图交叉淡入）值得写进 MOTION_SYSTEM 的补充案例；但它是第三方 MIT 源码再分发，且要 Tailwind + clsx + tailwind-merge 三件套。

**④ Tree Nav** — `motion`

| 属性 | 值 | 属性 | 值 |
|---|---|---|---|
| 依赖 | motion, @spectrumui/use-typewriter | Radix | 无 |
| ARIA | 源码含 ARIA（`ul` 结构） | 键盘 | 焦点行跟随 |
| 受控 | `activeHref` | reduced-motion | **未检测到**（正文却声称"Reduced-motion users get instant moves"，自相矛盾） |
| Tailwind | 是 | Next.js | 是（需传 `linkComponent`） |
| 动效 | 共享背景 pill + 菱形标记，临界阻尼弹簧 | 性能写法 | motion values，hover 不触发 re-render，只动 transform/opacity |
| badge | 支持 | external | 支持 |
| 许可证 | Apache-2.0 | | |

**判定：REFERENCE ONLY。** 值得抄的是它的**性能写法**：hover 用 motion values 驱动、只动 transform/opacity、不触发列表 re-render、行中心实测避免 badge 错位。这套写法应当进 MOTION_SYSTEM 作为"列表指示器"的标准做法。reduced-motion 的页面自述与检测结果互相矛盾 → 该属性记 UNKNOWN，不能作为 A29 达标的依据。

**⑤ Toast Stack** — `motion`, `clsx`, `tailwind-merge`, `lucide-react`

| 属性 | 值 | 属性 | 值 |
|---|---|---|---|
| 依赖 | motion, clsx, tailwind-merge, lucide-react | Radix | 无 |
| ARIA | 源码含 ARIA | live region | 未声明 |
| 受控 | `useAnimatedToastStack` hook | reduced-motion | **已处理** |
| Tailwind | 是 | Next.js | 是 |
| 能力 | 状态原地 morph（loading→success/error）、滑动关闭、portal、maxVisible | 位置 | 四角/边缘可配 |
| duration | 默认 4200ms，0 = 常驻 | 第三方来源 | **beUI（MIT）** |
| 许可证 | Apache-2.0（页面声明） | | |

**判定：REFERENCE ONLY。** OpenArc 当前 Toast = MISSING，这是最有参考价值的一个（状态 morph 与"0 = 常驻"的 API 设计都对），但同样是第三方 MIT 源码 + Tailwind 三件套。真要做，按它的 API 形状自研，不抄源码。

**⑥ Animated Drawer** — `lucide-react`, `motion`, `vaul`, `react-use-measure`

| 属性 | 值 | 属性 | 值 |
|---|---|---|---|
| 依赖 | lucide-react, motion, **vaul**, **react-use-measure** | shadcn/ui | **是（本地 primitives）** |
| ARIA | **未检测到** | 焦点陷阱 | 未声明 |
| Esc / 外部点击 | 未声明 | reduced-motion | **未检测到** |
| Tailwind | 是 | Next.js | 是 |
| Props 契约 | **无统一 Props 类型**（页面原文："No shared Props type"） | | |
| 许可证 | Apache-2.0 | | |

**判定：REJECT。** 六个里唯一依赖 shadcn/ui 的，且没有统一 Props 契约、未检测到 ARIA 与 reduced-motion。对 OpenArc 无参考价值之外的价值。

### 5.3 Spectrum 不得控制 OpenArc 设计语言

三条独立理由，任一条都足以支撑：

1. **技术栈冲突（决定性）。** OpenArc 依赖为 `react` / `react-dom` / `lucide-react`，无 Tailwind、无 Motion。Spectrum 每个组件页的 Technologies 都是 `React + TypeScript + Tailwind CSS + Motion`。引入等于把"纯 CSS token 体系"换成"Tailwind 工具类体系"，是被明确禁止的大重构，且会直接推翻 DESIGN_SYSTEM 的 token 层。
2. **来源混杂。** 目录内含第三方 MIT 源码（beUI 至少 2 个），逐文件归因未审计。
3. **设计语言方向相反。** Spectrum 的定位是"animation-ready、SaaS 落地页/仪表盘"，MOTION_SYSTEM 要求的是克制的系统级动效；Command Search 的自动打字、Drawer 的无契约 API 都与"桌面系统"的语境不符。

**唯一允许的输入：** 把 ② 的 switch 交互定义、④ 的"motion values + 只动 transform/opacity"性能写法、⑤ 的 toast 状态 morph API 形状写进 MOTION_SYSTEM / DESIGN_SYSTEM 作为**规范条目**，不引入任何源码。

---

## 6. 动效验证（含可打断性）

脚本：`experiments/d1-04/ui-audit.mjs`、`a11y-check.mjs`。

| 项 | 结果 |
|---|---|
| MS-A02 快速开关 10 次 | PASS — 剩余窗口 0，无残留 |
| MS-A02 半透明残留 | PASS — opacity 归位 |
| MS-A02 幽灵点击 | PASS — 关闭后点击命中 0 |
| MS-A03 可打断性（Esc 关菜单） | PASS（本轮修复后）— context-menu 1→0，menu-shade 1→0 |
| Cmd+K 打开 / Esc 关闭搜索 | PASS |
| 可聚焦元素 | 22（桌面态） |
| 图标按钮可访问名称 | 缺失 0 |

**可打断性的判定口径：** 动效"可打断"不等于"能提前触发关闭"。真正的判据是打断后**状态必须收敛**——窗口不残留、遮罩不继续拦事件、后续点击不落到已消失的对象上。三条实测都满足。

---

## 7. Reduce Motion（A29）实测

| 检查 | 结果 |
|---|---|
| 用户开启"减少动效"后 token | `--quick=0ms` `--standard=0ms` |
| 窗口动画 | `animation-name: none` |
| 窗口是否仍能打开 | 能，opacity = 1（不是"动画结束后才可见"的依赖） |
| Dock 缩放变量 | 全部为 1（波浪放大关闭） |
| 系统级 `prefers-reduced-motion` | 另有 `@media (prefers-reduced-motion: reduce)` 兜底（styles.css:897） |

**A29 判定：PASS。** 关键是"减少动效"没有变成"功能不可用"——窗口照常打开，只是没有过渡。这是很多实现会踩的坑。

补充发现：系统级媒体查询与产品内 `.reduced` 类**双通道都存在**，且都把 token 归零，没有互相覆盖的问题。

---

## 8. 玻璃性能基准

### 8.1 v1 方法的失败（必须记录）

第一版 `perf.mjs` 用"5 窗口 + 1000 压力节点 + 拖动"，结果是 FULL 与 SOLID 的 p50 都等于 8.3ms。这不是"玻璃不花钱"，而是 **120Hz 垂直同步把帧时间截断了**——两个档位都跑满 120fps，差异被吃掉。若据此写"玻璃无成本"，就是一个由测量方法制造的假结论。

### 8.2 v2 方法（冻结）

`experiments/d1-04/perf2.mjs`：

- **负载单位**：420×300px、圆角 16px、带 `backdrop-filter` 的合成玻璃面板，数量 K ∈ {0, 24, 72, 144}
- **基础场景**：真实应用（顶栏 + Dock + 4 个真实窗口）
- **采样**：按住最上层窗口标题栏做正弦拖动 40 步，采 90 帧，丢弃前 2 帧
- **变量**：只改 `.window / .topbar / .dock` 的 `backdrop-filter` + `background`
- **档位**：FULL `blur(34px) saturate(1.8)` / REDUCED `blur(12px)` 无 saturate / SOLID 无 backdrop-filter

REDUCED 档以注入 CSS 模拟，**产品代码中不存在该档**。

### 8.3 实测数据（MEASURED，Chromium + M3 Pro）

拖动中帧时间，单位 ms：

| 档位 | K=0 | K=24 | K=72 | K=144 |
|---|---|---|---|---|
| **FULL** | p50 8.3 / p95 9.2 / long 0 | 8.3 / **16.3** / 0 | **9.2** / **25.7** / **2** | **9.2** / **32.3** / **3** |
| **REDUCED** | 8.3 / 9.2 / 0 | 8.3 / 9.2 / 0 | 8.4 / 25.0 / 1 | 8.5 / 25.3 / **0** |
| **SOLID** | 8.3 / 9.1 / 0 | 8.3 / 9.2 / 0 | 8.3 / 9.1 / 0 | 8.3 / 9.2 / 0 |

（long = 单帧 > 33ms 的帧数）

三条读数：

1. **SOLID 完全不随 K 变化**（p95 恒定 9.1–9.2）→ 说明 backdrop-filter 是这组实验里唯一的有效变量，测量本身成立。
2. **FULL 从 K=24 起 p95 翻到 16.3ms**，正好压在 60fps（16.7ms）边界；K=72 起出现 >33ms 长帧；K=144 时 p95 32.3ms、3 帧长帧。
3. **REDUCED 的收益在 p95 与长帧数，不在 p50**：K=24 时 p95 从 16.3 降到 9.2（省 7.1ms，约 43%），K=144 时长帧从 3 降到 0。p50 差异很小（8.3 → 8.5），因为 p50 仍被 vsync 兜住。

**因此"玻璃成本"的正确度量是 p95 与长帧数，不是 p50 或平均 fps。** 这条要写进后续所有性能验证的口径。

---

## 9. 降级策略 FULL / REDUCED / SOLID

| 档位 | 定义 | 产品现状 |
|---|---|---|
| **FULL** | `blur(40/44/34/32/24px) saturate(1.8)` + 半透明底色 | 已实现（默认，`data-glass="full"`） |
| **REDUCED** | `blur(12/13/10/10/7px)`，**整条滤镜重写以真正去掉 saturate**，底色 alpha 上调补偿 | **已实现**（`data-glass="reduced"`，D1-04B） |
| **SOLID** | 无 `backdrop-filter`，全部实色 | 已实现（`data-glass="solid"`，原 `.opaque`） |

建议的触发链（只冻结口径，自动降级尚未实现）：

```
FULL --(连续 N 帧 > 33ms)--> REDUCED --(仍连续超阈)--> SOLID
```

N 的建议初值：拖动场景下连续 10 帧。该值**未经实测校准**，标为 TARGET。

REDUCED 的实现约束（已在 D1-04B 落地，见第 20 节）：

- 不能只降 blur 不补底色。`saturate(1.8)` 拿掉后浅色会发灰、深色会发闷，所以同步把
  `--surface / --content / --bar / --pill` 的 alpha 上调一档（浅色 +0.22，深色按各自基线分别取值）；
- 必须保留窗口边界可辨（DESIGN_SYSTEM：窗口边界靠明度差，不用 border）——
  REDUCED 不加 border、不加 box-shadow；
- 切换档位只改 CSS 变量与 `backdrop-filter`，不重建 DOM。
  实测（`glass-switch.mjs`）：6 次往返切换，窗口数与矩形全部不变，无残留 class。

---

## 10. 性能目标冻结（TARGET / MEASURED / NOT VERIFIED）

三列必须分开写，不得混用。

| 指标 | TARGET（目标，未达成） | MEASURED（Chromium 实测） | NOT VERIFIED |
|---|---|---|---|
| 拖动 p50 | ≤ 8.3ms（120fps） | FULL K≤24: 8.3ms | Electron 内全部指标 |
| 拖动 p95 | ≤ 16.7ms（60fps） | FULL K=24: 16.3ms（压线）；K=72: 25.7ms（超标） | Windows 全部指标 |
| 长帧（>33ms） | 拖动 90 帧内 0 帧 | FULL K=72: 2 帧；K=144: 3 帧；REDUCED K=144: 0 帧 | 多显示器 / 外接屏 |
| 常规场景定义 | ≤ 10 个窗口 | 本轮基准 K=0~24 覆盖该区间 | 真实 10 窗口 + 真实网页内容 |
| 静态合成成本 | 不冻结 | SOLID 与 K 无关（p95 9.1–9.2） | — |

**冻结的测量条件**（后续复用必须照抄）：视口 1440×900、深色主题、`oa-motion=false`、拖动 40 步正弦轨迹、采 90 帧丢 2、负载单位为 420×300 玻璃面板、报告 p50/p95/长帧数而非平均 fps。

**明确不冻结为目标的：** 平均 fps（会被 vsync 截平，无分辨力）、JS 堆（与玻璃成本无关）。

---

## 11. `feature/ui-light-bar-zero` 处置

### 11.1 先 compare

分支 = `8a0a1e5 + 1 commit (d0ccd69)`，改动两个文件：`src/styles.css`（15 行）、新增 `tests/visual-light-bar.mjs`（54 行）。不含 PROGRESS.md / D1-01 ADR 改动——这一点与初判不同，实际分支是干净的。

### 11.2 十问

| # | 问题 | 回答 | 证据 |
|---|---|---|---|
| 1 | 改了哪些文件 | `src/styles.css`、`tests/visual-light-bar.mjs`（新增） | `git diff --stat` |
| 2 | 改了哪些 token | `--bar`（light 0.58→0）、`.opaque --bar`（#ececed→#f5f5f7）、`.window-title` background（rgba(0,0,0,.035)→transparent）、`.topbar box-shadow`（删除）、删掉冗余的 `.dark .window-title` | 见 CSS diff |
| 3 | 是否只影响 light theme | **否**。前三条只影响浅色，但**删除 `.topbar box-shadow` 同时影响深色** | 深色也有该投影，删除后深色一并消失 |
| 4 | 是否破坏 dark theme | **未破坏**。8 个采样点改前改后像素**完全一致**；深色对比度 6.77:1 不变 | `hier_calc.py`：dark 全部 Δ=0 |
| 5 | 是否影响 contrast | 影响但全部达标。浅色最低 4.86:1 → 4.86:1（副标题未变）；顶栏字标 16.14→15.34；窗口标题 14.92→16.13（变好） | `contrast_calc.py` |
| 6 | 是否影响 glass hierarchy | 影响，且方向要看清：顶栏/桌面 ΔL 31.4→10.5（变弱仍可辨）；标题栏/内容 32.6→13.3；Dock 内/外 8.2→**39.2**（变得更强） | `hier_calc.py` |
| 7 | 是否符合 DESIGN_SYSTEM | 符合。禁用发丝线框与投影作为分层手段；无底色表面本就不该投影 | DESIGN_SYSTEM 3.x |
| 8 | 是否产生 hard-coded style | 否。全部走 token / 既有选择器，只删不增硬编码 | CSS diff |
| 9 | 是否影响 reduced transparency | 影响，且**原值错误** —— 见 11.3 | `opaque-probe.mjs` |
| 10 | 是否值得保留 | **值得**，两处按实测修正后保留 | — |

### 11.3 两处按实测修正

**（a）`.opaque` 浅色 `--bar` 原值不成立。**

实测（`opaque-probe.mjs`，隐藏顶栏/Dock 后直接读它们压着的桌面）：

| 位置 | 真实桌面 9 点均值 | 极值 |
|---|---|---|
| 顶栏处 | `#efeff1`（239,239,241） | 235…244 |
| Dock 处 | `#e4e4e8`（228,228,232） | 225…235 |

分支给的 `#f5f5f7`（245）**比桌面上限 244 还亮**，opaque 模式下会浮出一条亮带。修正为两端中点 `#e9e9ec`（233），两端偏差 ≤6 级。效果实测：顶栏内/紧邻桌面 ΔL 由约 9 级降到 **2.0 级**（不可辨）。

**（b）测试脚本不应进 `tests/`。** `tests/` 是 `npm test`（`node --test tests/*.test.mjs`）的纯逻辑测试目录，而该脚本依赖 Playwright + 硬编码本地 chromium 绝对路径，混进去会让 `npm test` 环境假设被污染。本轮把同类验证统一放在 `experiments/d1-04/light-bar-check.mjs`，`tests/visual-light-bar.mjs` 不引入。

### 11.4 判定：**ADAPT**

方向采纳（顶栏/Dock/标题栏透明度归零，与深色口径对齐），但按上面 (a)(b) 两处修正后落地，且**该分支不整体合并**——它的基线 `8a0a1e5` 落后于当前，改动已由 D1-04 分支以等价形式承载。

### 11.5 顺带发现（不属于该分支，但必须记录）

深色 `.opaque.dark --bar = #111111`（17,17,17），而实测顶栏处真实桌面为 **#000000**（0,0,0），差 **17 个 RGB 级**。也就是说 SOLID 档下深色顶栏会浮出一条亮带，与半透明版的"完全不可见"不一致。

**本轮不改。** 理由：深色观感是 Phase A 多轮迭代、用户已验收的结果，改它需要一次明确的设计决策，不该由技术验证顺手推翻。记为待办，建议值 `#000000`，等 Boss 确认。

---

## 12. 深浅色专项检查

| 项 | 浅色 | 深色 |
|---|---|---|
| 最低文字对比度 | 4.86:1（副标题，在窗口内白底上） | 6.77:1 |
| 顶栏/桌面 ΔL | 10.5（可辨） | 0.3（顶栏完全不可见，只剩图标与文字悬浮） |
| 标题栏/内容 ΔL | 13.3 | 0.9 |
| 窗口外壳/桌面 ΔL | 46.9 | 1.5 |
| Dock 内/外 ΔL | 39.2 | 0.2 |
| 幽灵边（顶栏下方梯度） | ΔL 10.1，属桌面自身渐变 | 0.0 |

两点说明：

- **深色的 ΔL 数值都很小，这是刻意的**，不是缺陷：深色桌面是纯黑 `#000000`，顶栏 alpha 0，所以顶栏确实等于桌面，只靠图标与文字悬浮。这是 Phase A 已验收的方向。
- **浅色 Dock 内比桌面暗约 16 级**（220 vs 240），方向是"内凹"而非"浮起"，与"抬起 = 白叠加"的材质定义相反。但**深色下是同一个现象**（Dock 内 6 vs 外 8），且深色已验收，所以浅色保持与深色一致。Dock 保留投影（0 8px 28px）维持可辨识度。

---

## 13. Design Token 现状与建议（不做大重构）

> **本节记录的是 D1-04 当时的形态。D1-04B 已按"原料 + 消费点合成"重构，
> 现状见第 20 节，下面的建议 1 已落地。**

D1-04 当时的 token（`src/styles.css`）：`--surface / --content / --sunken / --bar / --pill / --line / --accent / --on-accent / --focus / --failed / --shadow / --radius / --quick / --standard / --ease`，加 `--text / --muted`。

**现状判定：够用，不做大重构。** 理由：D1-04 的目标是冻结测量条件与组件许可，不是换样式体系；引入 Spectrum 必然带 Tailwind，是被禁止的大重构。

**三点小建议：**

1. ~~补 `--glass-blur` / `--glass-saturate` 变量~~ → **D1-04B 已落地为每表面一条完整 `--glass-filter-*`**
   （顶栏 / 窗口 / 胶囊 / Dock / 提示各一条），REDUCED 档整条重写，真正移除 saturate 段。
2. `--pill` 保持独立（不并入 `--bar`）。当前桌面 AI 胶囊因此在纯黑上仍有 #171717@72% 底板，合并会让它在深色下消失。**D1-04B 后 pill 有独立的 `--pill-rgb` / `--pill-alpha`，仍然独立。**
3. `--failed` 目前是唯一语义色，配合 `--focus`，建议保持"语义色 ≤ 3 个"的红线写进 DESIGN_SYSTEM 正文。

---

## 14. 可访问性

| 检查 | 结果 |
|---|---|
| WCAG AA 正文对比度（4.5:1） | 浅色最低 4.86:1 / 深色最低 6.77:1，**均通过** |
| 图标按钮可访问名称 | 缺失 0（全部有 aria-label） |
| Dock 语义 | 真 `<button>`，非 div + onClick |
| 键盘可达 | 桌面态 22 个可 Tab 元素 |
| Cmd+K 打开搜索 | 通过 |
| Esc 关闭搜索 | 通过 |
| **Esc 关闭右键菜单** | **本轮修复前失败，修复后通过** |

未验证：屏幕阅读器实际朗读、Windows 高对比度模式、焦点可见性在玻璃背景上的表现。

---

## 15. 本轮修复的缺陷（真实缺陷，非顺手改动）

**桌面右键菜单无法用 Esc 关闭（`src/main.tsx`）。**

- 现象：右键打开菜单后按 Esc 无反应；`.menu-shade` 继续拦截全部指针事件，形成功能性陷阱——用户只能靠点击遮罩退出。
- 根因：全局 keydown 的 Escape 分支只 `setSearch(false); setAI(false);`，漏了 `setMenu(null)`；而 `.menu-shade` 只有 `onPointerDown` / `onContextMenu`，没有键盘出口。
- 修复：Escape 分支增加 `setMenu(null)`。
- 验证：`a11y-check.mjs` —— 打开后 context-menu 1 / menu-shade 1，按 Esc 后均变 0。
- 对应规范：MS-A03（动效/浮层必须可打断）。

这是在跑对比度脚本时被 `.menu-shade` 拦截点击才暴露出来的，说明"跑不通的自动化"有时比"跑通的"更有价值。

---

## 16. 未验证项与风险

| # | 未验证项 | 影响 | 阻塞什么 |
|---|---|---|---|
| 1 | Electron 内的玻璃性能 | 全部性能数字不可外推到产品 | 性能目标从 MEASURED 升级为 PASS |
| 2 | REDUCED 档位的实现 | 降级链缺中间档 | D2-01 前的降级策略落地 |
| 3 | Windows 平台（mica、打包、多显示器） | 双平台一致性是硬性要求 | D1-04 判 COMPLETE |
| 4 | 真实 Adobe 探测（AdobeRow 为 PLACEHOLDER） | 设置页显示的是假数据 | 与 D1-03 联动 |
| 5 | 屏幕阅读器 / Windows 高对比度 | 可访问性只做了对比度与键盘 | A29 之外的一致性 |
| 6 | 焦点可见性在玻璃上的表现 | 可能与"禁用发丝线框"冲突 | DESIGN_SYSTEM 补充 |
| 7 | Spectrum 逐文件来源审计 | 只允许 REFERENCE ONLY，不能 ADOPT | 任何"抄源码"的提议 |
| 8 | 自动降级触发阈值 N=10 | 未实测校准 | 降级策略自动化的安全性 |

---

## 17. 对 D2-01 的前置影响

D2-01 的前置里，本轮**已满足**的：组件清单与需求等级（P0 17 项中 14 IMPLEMENTED / 2 PARTIAL / 1 无）、动效可打断性、A29、对比度、键盘可达。

**未满足、且必须在 D2-01 前关闭的：**

1. 在 Electron 内重跑一次 `perf2` 方法，把性能数字从"Chromium MEASURED"变成"Electron MEASURED"；
2. Windows 上复跑同组测量。

~~实现 REDUCED 档位~~ —— **已由 D1-04B 关闭**（`data-glass="reduced"` 已进入产品代码，六格主题矩阵 PASS）。

其余（Toast 缺失、AdobeRow 假数据）不阻塞 D2-01，记入 D5。

---

## 18. 后续动作

| 动作 | 归属 | 时限 |
|---|---|---|
| ~~实现 REDUCED 档~~ | — | **已完成（D1-04B）** |
| ~~深色 SOLID `--bar` #111111 → #000000~~ | — | **已完成（D1-04B，Boss 已确认）** |
| REDUCED 档的性能对比（真实产品实现 × 4 档负载） | D1-04B 剩余部分 | 阻塞 D2-01 |
| Electron 内重跑 perf2 | D2-01 之前 | 阻塞 D2-01 |
| Windows 复跑 | D2-01 之前 | 阻塞 D2-01 |
| 把 Spectrum 三条写法写进 MOTION_SYSTEM | D2 期间 | 不阻塞 |
| 自动降级触发链（FULL→REDUCED→SOLID）的阈值校准 | D2-01 之后 | 不阻塞 |
| Toast 组件（按 Toast Stack 的 API 形状自研） | D5 | 不阻塞 |
| AdobeRow 真实探测 | 与 D1-03 联动 | D1-03 当前 BLOCKED |

---

## 19. 状态判定依据

PLAN D1-04 通过条件为"动效可采用，测量条件及目标冻结"。

- **动效可采用：达成。** MS-A02 / MS-A03 / A29 / 可打断性 / 对比度全部有实测证据，且修掉一个真实缺陷。
- **测量条件及目标冻结：方法冻结达成，代表性未达成。** 方法可复现（负载单位、三档材质、采样口径、报告 p95 与长帧而非平均 fps 均已固定），且三档材质已是真实产品实现；但性能数字只在 Chromium 取得，产品是 Electron，Windows 未测。

因此 **Task Status = PARTIAL**。剩余缺口清空前不得改为 COMPLETE。

---

## 20. D1-04B 主题合成修复（Token 架构）

D1-04B 在实现 REDUCED 档时，把颜色拆成「通道 + alpha」两段原料，但**把合成结果留在了 `:root`**。
结果：`.dark` 覆盖通道时，`--surface` / `--content` 早已在 `:root` 用浅色通道算完并继承下去。
探测抓到的真实回归：

```
Dark + FULL · Window Content
  期望（D1-04 baseline）  (20, 20, 20)
  实际                    (250, 250, 250)   ← 深色拿到了浅色合成色
```

### 20.1 根因

`var()` 替换发生在**声明该自定义属性的元素**上，替换结果再作为计算值继承。
所以「原料在上层、合成也在上层」这个写法本身就是错的——
只要原料在下层被覆盖，上层的合成结果就已经定型了。

### 20.2 修复前后

| | 修复前（错误） | 修复后 |
|---|---|---|
| `:root` | 原料 + **合成结果** `--surface` / `--content` / `--bar` / `--pill` | **只放原料**：`--surface-rgb` / `--content-rgb` / `--bar-rgb` / `--pill-rgb` + 各 alpha + 滤镜 token |
| `.dark` | 只覆盖 `--glass-tint` | 只覆盖 `--*-rgb` 与 alpha 基线 |
| 组件 | `background: var(--surface)`（拿继承来的合成值） | `background: rgb(var(--surface-rgb) / var(--surface-alpha))`（**在消费点合成**） |
| 已删除的提前合成 token | `--glass-tint`、`--glass-alpha-boost`、`--surface`、`--content`、`--bar`、`--pill` | — |

17 个消费点全部改为就地合成（surface ×5、content ×9、bar ×2、pill ×1）。
`:root` 里不再存在任何"已经算好的颜色"。

### 20.3 三维正交

```
Theme   light / dark          → 只管 *-rgb 与 alpha 基线
Glass   full / reduced / solid → 只管材质（blur / saturate / alpha）
Motion  normal / reduced       → 只管动效时长（.reduced 类）
```

- 材质档位用 `data-glass` 属性，**不复用 `.reduced`**——那个类名此前已经表示 Reduce Motion，
  复用会造成语义碰撞。
- SOLID 是唯一允许覆盖 RGB 的档位：没有模糊时底色必须等于它压着的桌面合成色，否则会浮出亮条。
- 每档的滤镜写成**整条完整值**（`blur(34px) saturate(1.8)` / `blur(10px)`），
  而不是拼接 `blur()` + `saturate()`。拼接时 REDUCED 只能写成 `saturate(1)`，
  视觉等价但仍保留一条滤镜链。

### 20.4 修复后主题矩阵（六格全 PASS）

`experiments/d1-04/theme-matrix.mjs` + `matrix_pixels.py`：

| 格 | Window | WindowContent | TopBar | Dock | Menu | Window 滤镜 |
|---|---|---|---|---|---|---|
| light-full | (185,185,187) | (234,234,234) | (237,237,242) | (169,169,173) | (232,232,233) | blur(34px) saturate(1.8) |
| light-reduced | (190,190,190) | (249,249,249) | (242,242,243) | (174,174,176) | (249,249,249) | blur(10px) |
| light-solid | (184,184,185) | (245,245,247) | (233,233,236) | (175,175,177) | (245,245,247) | none |
| dark-full | (11,11,11) | **(19,19,19)** | (0,0,0) | (4,4,4) | (17,17,17) | blur(34px) saturate(1.8) |
| dark-reduced | (14,14,14) | (21,21,21) | (5,5,5) | (7,7,7) | (21,21,21) | blur(10px) |
| dark-solid | (9,9,9) | (12,12,12) | (0,0,0) | (0,0,0) | (12,12,12) | none |

**Dark FULL 已回到 baseline**：同一套探测（`solid-bar-probe.mjs`）的逐点对照显示
7 个采样点与 D1-04 基线**完全一致**，其中 Window Content = (20,20,20)。
Light FULL / Light SOLID 同样逐点一致，没有反向回归。

### 20.5 防回归断言

`theme-matrix.mjs` 内置两类断言，任何后续 token 重构都会第一时间报错：

1. **主题原料断言**：`--surface-rgb` 必须是本主题的 `23 23 23` / `255 255 255`（SOLID 另外取值）。
2. **合成结果断言**：Window / Menu / Search / AI / Card 的 computed 背景通道不得跨主题
   （深色格里出现 R/G/B > 200 即失败，浅色格里全 < 70 即失败）；
   全透明背景的元素跳过，避免把 `rgba(0,0,0,0)` 误判成"深色"。
3. **像素断言**：深色格的窗口内容必须落在暗部区间（dark-full `[12,30]`、dark-solid `[8,20]`）；
   浅色格不得接近深色。

### 20.6 受影响的历史证据

| 证据 | 处置 |
|---|---|
| `solidbar-after` 第一次运行（`dark-full` Window Content = 250 / 173） | **保留为缺陷证据**，不退换。这是发现该 bug 的一次采样 |
| `solidbar-after` 第二次运行起 | 有效（`.desktop` 合成版） |
| `glass-tiers` / `glass-switch` / `flash_check` | 有效，但为通过**消费点合成**版重新跑过一遍，结果一致 |
| D1-04 阶段（修复前）的 `perf2` 数据 | **不受该 bug 影响**——perf2 只测 frame timing，不读颜色；且当时样式路径尚未引入该 bug。保留作参考，但 D1-04B 正式验收必须用修复后的产品代码重跑 |
| D1-04B 的 REDUCED 性能对比 | 尚未进行，本轮不产出。**必须用修复后的产品代码跑** |



## 21. 复现命令

```bash
npm run build

# 起静态服务（dist）
cd dist && python3 -m http.server 5210 --bind 127.0.0.1 &

node experiments/d1-04/ui-audit.mjs          # 组件清单 + MS-A02 + A29 + 键盘
node experiments/d1-04/a11y-check.mjs        # Esc / 右键菜单 / Cmd+K
node experiments/d1-04/contrast2.mjs         # 字心背景采样（OA_TAG=before|after）
node experiments/d1-04/hierarchy.mjs         # 玻璃层级采样（OA_TAG=before|after）
node experiments/d1-04/opaque-probe.mjs      # SOLID 档真实桌面底色
node experiments/d1-04/opaque-verify.mjs     # SOLID 档是否浮出亮带
node experiments/d1-04/perf2.mjs             # 三档 × 四档负载性能基准
node experiments/d1-04/light-bar-check.mjs   # 顶栏归零后的合成样式

# D1-04B 主题矩阵与材质档位
node experiments/d1-04/theme-matrix.mjs      # 六格矩阵 + computed 断言 + 像素断言
node experiments/d1-04/solid-bar-probe.mjs   # 深色 SOLID 顶栏取证（OA_TAG=before|tokenfix）
node experiments/d1-04/glass-tiers.mjs       # 三档 × 10 个面的材质矩阵
node experiments/d1-04/glass-switch.mjs      # 运行时切换 + 动效解耦

python3 experiments/d1-04/contrast_calc.py   # WCAG 对比度（改前/改后对照）
python3 experiments/d1-04/hier_calc.py       # 层级明度差（改前/改后对照）
python3 experiments/d1-04/flash_check.py     # 切换过渡期闪白/闪黑
```
