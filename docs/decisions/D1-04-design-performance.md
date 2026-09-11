# D1-04 组件、视觉系统与性能技术验证

> **Task Status: PARTIAL**
> **Component Baseline: ESTABLISHED（清单与测量方法已冻结）**
> **Spectrum UI Verdict: REFERENCE ONLY（不引入源码）**
> **ui-light-bar-zero Verdict: ADAPT（方向采纳，两处按实测修正）**
> **D1-04B：REDUCED 档已进入产品代码（`data-glass` 三态）；主题合成已改为消费点合成**
> **D1-04B 材质性能判定：SOLID PASS / REDUCED FAIL（第 21 节，历史记录）**
> **D1-04C：REDUCED 重新定义为「选择性玻璃 / 减少过滤面积」，方向缺口 CLOSED（第 22 节）**
>
> 判定为 PARTIAL 不是"做了一半"，而是两条硬性缺口仍未关闭：
> ①性能数字只在 Chromium 取得（Electron 内 NOT VERIFIED）；②Windows 平台未验证。
> 两条都命中"测量条件"的代表性，在关闭前不得宣布 COMPLETE。
>
> 缺口变化轨迹：
> - 原"REDUCED 只定义未实现"的**实现层**缺口 → 由 D1-04B 关闭（第 20 节）。
> - D1-04B 开出的"**REDUCED 性能假设不成立**"缺口 → 由 D1-04C 关闭（第 22 节）：
>   作用面策略已进入产品代码，过滤面积实测下降 −86.6%～−99.0%，
>   高负载下不再比 FULL 差，六格主题矩阵与切换压力继续通过。
> - 因此缺口数由 3 回到 **2**。

- 分支：`feature/d1-04-design-performance`（自 `b39eb93` 拉出，不含 D1-03 Adobe 内容）
- 日期：2026-09-10（D1-04）/ 2026-09-11（D1-04B、D1-04C）
- 上游基线：PRODUCT.md / PLAN.md（D1-04、A12、A29、D2-01）/ DESIGN_SYSTEM.md / MOTION_SYSTEM.md / PROGRESS.md / CHANGELOG.md
- 实测脚本：`experiments/d1-04/`（D1-04 七个 + D1-04B 七个 + D1-04C 四个）
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
3. **REDUCED = IMPLEMENTED（D1-04B 起实现，D1-04C 重定作用面）。** 产品三个档位都是真实产品态：
   FULL（完整玻璃）/ REDUCED（`data-glass="reduced"`，**选择性玻璃**：大面积实色 + 小面积 chrome 玻璃）/
   SOLID（`data-glass="solid"`，原 `.opaque`）。D1-04 当时"用注入 CSS 模拟 REDUCED"的做法已废弃，
   仅保留为历史对照（第 21 节）。

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

> **口径说明（D1-04B 补注，不改历史数据）**：8.2 与 8.3 记录的是 **D1-04 当时**的测量口径——
> 三档全部由 `page.addStyleTag` 注入 CSS 模拟，REDUCED 在原产品代码中并不存在。
> **D1-04B 起 REDUCED = IMPLEMENTED**（`data-glass="reduced"`），三档改为切换产品正式状态，
> 重测结果见第 21 节。本节旧数据降级为 **HISTORICAL REFERENCE**，保留用于回归对照。
> D1-04B 新数据标注为 **D1-04B OFFICIAL CHROMIUM MEASUREMENT**。

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
| **FULL** | 全部表面走完整玻璃：`blur(40/44/34/32/24px) saturate(1.8)` + 半透明底色 | 已实现（默认，`data-glass="full"`） |
| **REDUCED** | **选择性玻璃 / 减少过滤面积**：大面积表面（窗口、AI 面板、搜索面板、内容区）转实色，只在小面积系统 chrome（顶栏、Dock、tooltip、右键菜单、AI 胶囊、窗口标题条）保留薄玻璃。模糊半径只是次要视觉参数 | **已实现**（`data-glass="reduced"`）。作用面策略由 **D1-04C** 重定（第 22 节），过滤面积 −86.6%～−99.0%，高负载下不再比 FULL 差 |
| **SOLID** | 无 `backdrop-filter`，全部实色 | 已实现（`data-glass="solid"`，原 `.opaque`） |

> **REDUCED 的正式定义在 D1-04C 被改写。** D1-04B 的定义是「把模糊半径从 34px 降到 10px」，
> 该假设已被实测证伪（见第 22.12 节 `Why radius reduction was rejected`）。
> 旧定义保留在第 21 节作为历史设计记录，不删除。

**自动降级：本轮明确不做，且冻结到 D1-06。**

```
【禁止】FULL --(连续 N 帧 > 33ms)--> REDUCED --(仍连续超阈)--> SOLID
```

理由（三条都要成立才允许开这条链）：

1. 现有性能数字全部是 **Chromium**（`MEASURED (Chromium)`），Electron 内 **NOT VERIFIED**，Windows **NOT VERIFIED**；
   用不可代表的数字去校准阈值，等于把误差写进产品行为。
2. 真实产品负载（≈7 个玻璃面，K=0）三档全部 120fps / 0 长帧——**当前没有需要降级的场景**。
   降级链要有意义，得先有真实 Electron 高负载数据。
3. 代表性数据到手前，降级只允许**用户在设置里手动选三档**，以及**内部测试脚本切换**。
   两者走的是同一条产品状态（`data-glass`），不做任何自动判定。

归属：D1-06 或拿到 Electron/Windows 代表性数据之后。该决定写进第 22.13 节。

REDUCED 的实现约束（已在 D1-04B 落地，见第 20 节；D1-04C 按作用面策略修订）：

- 不能只降 blur 不补底色。`saturate(1.8)` 拿掉后浅色会发灰、深色会发闷，所以同步把
  `--surface / --content / --bar / --pill` 的 alpha 上调一档（浅色 +0.22，深色按各自基线分别取值）；
- 必须保留窗口边界可辨（DESIGN_SYSTEM：窗口边界靠明度差，不用 border）——
  REDUCED 不加 border、不加 box-shadow、不加 hairline；
- 窗口的玻璃**下沉到标题条**（44px 窄带），容器转透明、正文转实色（`--content-rgb` 满 alpha）；
  实测切档只改模糊不改窗口明度（深色 FULL 24 → REDUCED 23，浅色都 255）；
- 切换档位只改 CSS 变量与 `backdrop-filter`，不重建 DOM。
  实测（`glass-switch.mjs` / `glass-switch-stress.mjs`）：63 次往返切换，窗口数与矩形全部不变，无残留 class。

---

## 10. 性能目标冻结（TARGET / MEASURED / NOT VERIFIED）

三列必须分开写，不得混用。

| 指标 | TARGET（目标，未达成） | MEASURED（Chromium 实测） | NOT VERIFIED |
|---|---|---|---|
| 拖动 p50 | ≤ 8.3ms（120fps） | FULL K≤24: 8.3ms | Electron 内全部指标 |
| 拖动 p95 | ≤ 16.7ms（60fps） | FULL K=24: 8.9ms（压线）；K=144: 41.6ms（超标） | Windows 全部指标 |
| 长帧（>33ms） | 拖动 90 帧内 0 帧 | FULL K=72: 1 帧；K=144: 5 帧；REDUCED 与 SOLID: 全 K 0 帧 | 多显示器 / 外接屏 |
| **过滤面数 / 过滤面积**（D1-04C 新增） | **REDUCED 必须显著低于 FULL** | K=0 −86.6%、K=24 −95.5%、K=72 −98.1%、K=144 −99.0%（第 22.6 节） | Electron / Windows 内 |
| 常规场景定义 | ≤ 10 个窗口 | 本轮基准 K=0~24 覆盖该区间 | 真实 10 窗口 + 真实网页内容 |
| 静态合成成本 | 不冻结 | SOLID 与 K 无关（p95 8.9–9.2） | — |

**冻结的测量条件**（后续复用必须照抄）：视口 1440×900、深色主题、`oa-motion=false`、拖动 40 步正弦轨迹、采 90 帧丢 2、负载单位为 420×300 玻璃面板、报告 p50/p95/长帧数而非平均 fps。

**D1-04C 追加冻结的条件**（三档材质性能比较必须同时报这两组数）：

1. 每次测量同时记录 `filteredCount`（带非 `none` `backdrop-filter` 的元素数）与 `filteredArea`
   （这些元素裁剪到视口后的面积之和）及其覆盖率；
2. 判据以**过滤面积是否显著下降**为机制判据，以 p95 / 长帧为性能判据，两者都要报，不得只报其一；
3. 模糊半径不得作为性能主张的依据（第 22.12 节），只能作为视觉参数记录。

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
| 2 | ~~REDUCED 档位的实现~~ | — | **已关闭（D1-04B 实现 / D1-04C 重定作用面）** |
| 3 | Windows 平台（mica、打包、多显示器） | 双平台一致性是硬性要求 | D1-04 判 COMPLETE |
| 4 | 真实 Adobe 探测（AdobeRow 为 PLACEHOLDER） | 设置页显示的是假数据 | 与 D1-03 联动 |
| 5 | 屏幕阅读器 / Windows 高对比度 | 可访问性只做了对比度与键盘 | A29 之外的一致性 |
| 6 | 焦点可见性在玻璃上的表现 | 可能与"禁用发丝线框"冲突 | DESIGN_SYSTEM 补充 |
| 7 | Spectrum 逐文件来源审计 | 只允许 REFERENCE ONLY，不能 ADOPT | 任何"抄源码"的提议 |
| 8 | 自动降级触发阈值 | 未实测校准 | **D1-04C 起冻结到 D1-06**（第 22.13 节）：代表性数据到手前不做自动降级 |
| 9 | 大量真实窗口（≈10）下的过滤面积 | REDUCED 的成本曲线预期仍为平线，但未实测 | 不阻塞，记入第 22.14 节 |

---

## 17. 对 D2-01 的前置影响

D2-01 的前置里，本轮**已满足**的：组件清单与需求等级（P0 17 项中 14 IMPLEMENTED / 2 PARTIAL / 1 无）、动效可打断性、A29、对比度、键盘可达、**三档材质均为产品态且各有独立定义**（第 22 节）。

**未满足、且必须在 D2-01 前关闭的（两条）：**

1. 在 Electron 内重跑一次材质性能方法（`perf-product.mjs`），把数字从"Chromium MEASURED"变成"Electron MEASURED"；
2. Windows 上复跑同组测量。

~~实现 REDUCED 档位~~ —— **代码层已由 D1-04B 关闭**（`data-glass="reduced"` 已进入产品代码，六格主题矩阵 PASS）。

~~REDUCED 档的性能假设未成立~~ —— **由 D1-04C 关闭**（第 22 节）：作用面策略已进入产品代码，
过滤面积实测下降 −86.6%～−99.0%，高负载下不比 FULL 差，视觉/功能无回归。
该缺口关闭后，D2-01 的阻塞项回到"只能在 Electron / Windows 上关闭"的两条代表性缺口。

其余（Toast 缺失、AdobeRow 假数据）不阻塞 D2-01，记入 D5。

---

## 18. 后续动作

| 动作 | 归属 | 时限 |
|---|---|---|
| ~~实现 REDUCED 档（代码层）~~ | — | **已完成（D1-04B）** |
| ~~深色 SOLID `--bar` #111111 → #000000~~ | — | **已完成（D1-04B，Boss 已确认）** |
| ~~REDUCED 档的性能对比（真实产品实现 × 4 档负载）~~ | — | **已完成（D1-04B，第 21 节）；结论：不通过** |
| ~~REDUCED 档方向重定（三选项 A/B/C）~~ | — | **已完成（D1-04C，Boss 选 A；第 22 节）** |
| ~~REDUCED 改为选择性玻璃并验证过滤面积下降~~ | — | **已完成（D1-04C）** |
| ~~实色面板上的行级 hover 回归~~ | — | **已完成（D1-04C，第 22.11 节）** |
| 在**空载**主机上重跑一次官方基线（当前机 loadavg ≈ 8–10） | 新增 | D2-01 之前 |
| Electron 内重跑官方基线 | D2-01 之前 | 阻塞 D2-01 |
| Windows 复跑 | D2-01 之前 | 阻塞 D2-01 |
| **大量真实窗口（≈10）下的过滤面积实测** | **新增**（第 22.14 节） | D2-01 之前，不阻塞 |
| 把 Spectrum 三条写法写进 MOTION_SYSTEM | D2 期间 | 不阻塞 |
| 自动降级触发链（FULL→REDUCED→SOLID）的阈值校准 | **冻结到 D1-06 或代表性数据到手**（第 22.13 节） | 不阻塞 |
| Toast 组件（按 Toast Stack 的 API 形状自研） | D5 | 不阻塞 |
| AdobeRow 真实探测 | 与 D1-03 联动 | D1-03 当前 BLOCKED |

---

## 19. 状态判定依据

PLAN D1-04 通过条件为"动效可采用，测量条件及目标冻结"。

- **动效可采用：达成。** MS-A02 / MS-A03 / A29 / 可打断性 / 对比度全部有实测证据，且修掉一个真实缺陷。
- **测量条件及目标冻结：方法冻结达成，代表性未达成。** 方法可复现（负载单位、三档材质、采样口径、报告 p95 与长帧而非平均 fps 均已固定），且三档材质已是真实产品实现；但性能数字只在 Chromium 取得，产品是 Electron，Windows 未测。
- **D1-04B 缺口（第 21 节）：REDUCED 档的性能收益不成立。** → **已由 D1-04C 关闭**（第 22 节）。
  关闭依据（第 22.11 节的验收规则逐条对照）：
  1. REDUCED 作用面策略进入真实产品代码（`--glass-filter-large` 开关 + 显式白名单）；
  2. 六格主题矩阵继续 PASS；
  3. 63/63 切换压力继续 PASS，结构（窗口数/矩形/视口）全程不变；
  4. **过滤面积确实下降**：K=0 −86.6%，K=24 −95.5%，K=72 −98.1%，K=144 −99.0%；
     过滤面数 K=144 由 150 → 6；
  5. 无视觉/功能回归（层级差、对比度、a11y、单元测试全绿），并修掉一条实色面板 hover 回归。
  注意：**关闭的是"内部方向缺口"，不是"性能已代表 Electron"**。所以本条不把整体状态推向 COMPLETE。

因此 **Task Status = PARTIAL**，剩余缺口 **2 条**，两条都是代表性缺口：
①Electron 内性能未验；②Windows 未验。
缺口清空前不得改为 COMPLETE。阶段验收失败不得用下一阶段掩盖，也不得用"方向已定"顶替"数字未代表"。

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
| D1-04B 的 REDUCED 性能对比 | **已完成（第 21 节）**：用修复后的产品代码重跑。结论 REDUCED 不通过，且第 8 节的旧数字降级为 HISTORICAL REFERENCE |



## 21. D1-04B Official Material Performance

> **⚠️ 本节是 D1-04B 的历史记录，其中 REDUCED 的判定已被 D1-04C 取代。**
> 本节测的是「REDUCED = blur 34px → 10px」这条路线，结论是**该路线不通过**。
> D1-04C 据此把 REDUCED 重定义为「选择性玻璃 / 减少过滤面积」并重新验收：
> 新的正式结论见 **第 22 节**，REDUCED 由不通过变为**通过**。
> 本节的数字、方法与三条读数（`backdrop-filter` 有无才是强杠杆 / 半径不是可靠杠杆 /
> 当前产品玻璃负载不构成性能问题）全部保留，它们是 D1-04C 结论的直接依据。
>
> **产物文件说明**：D1-04C 用同名输出重跑过 `perf-product-dark.json` / `-dark-cold.json` /
> `-light.json`，磁盘上这三个文件现在装的是 D1-04C 数据。D1-04C 的正式产物另存为
> `perf-product-c-*.json`；本节表格里的 D1-04B 数字以**本文档的表格**为准（表格即记录）。
> 本节的 `perf-product-dark-grid.json` / `-dark-saturation.json` 未被覆盖，仍是 D1-04B 原物。

> **判定（D1-04B 当时口径）：不通过（仅 REDUCED 一项不通过）。**
> SOLID 通过；运行时切换压力通过；浅色 sanity 通过；**REDUCED 未达到第 8 节的验收目标**——
> 在冻结的 K 集合内只有「稳态 × K=144」一格出现可重复收益，其余点位与 FULL 不可分辨，
> 且冷启动口径下 REDUCED 的 p95 反而更差。因此 **D1-04 的内部实现缺口不关闭**，
> 整体状态仍为 PARTIAL（第 19 节已同步）。

本节全部数字标注 **D1-04B OFFICIAL CHROMIUM MEASUREMENT**。
第 8 节的 D1-04 数字自本轮起降级为 **HISTORICAL REFERENCE**（不删除，留作回归对照）。

### 21.1 Environment

| 项 | 值 |
|---|---|
| 机型 / CPU | Mac15,7 / Apple M3 Pro / 12 核（6P+6E） |
| 内存 | 18 GB |
| OS | Darwin 25.6.0（macOS 26.6.2）/ arm64 |
| GPU | ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro) |
| 承载件 | Chromium **149.0.7827.55**（本地 `chromium-1228`），**非 Electron** |
| Electron | 44.3.0（已安装；GPU 进程在本环境不可用，未参与任何测量） |
| 视口 / DPR | 1440×900 / deviceScaleFactor = 1（物理屏 3456×2234 Retina） |
| 启动参数 | `--no-sandbox --disable-gpu-sandbox --in-process-gpu` |
| 主机负载 | 测量期间 loadavg ≈ 8.1–9.9（12 核），**存在外部持续负载**（见 21.9） |
| 主题 / 动效 | dark（另有 light sanity，见 21.8）/ Reduce Motion 关闭 |

> 更正记录：D1-04 写的是「Chromium 152」，那是 Electron 内置 Chromium 的版本号。
> 本地 Playwright `chromium-1228` 实际报告 **149.0.7827.55**。本轮以实测为准。

**代表性：NOT REPRESENTATIVE FOR ELECTRON。** 每个数字旁都必须带 `MEASURED (Chromium)`；
Electron 侧一律 `NOT VERIFIED`。

### 21.2 Product glass implementation（测量如何驱动产品）

D1-04 的 `perf2.mjs` 用 `page.addStyleTag` 注入材质值，三档是脚本凭空模拟的。
本轮官方脚本 `experiments/d1-04/perf-product.mjs` **不注入任何材质值**：

| 环节 | 做法 |
|---|---|
| 档位切换 | 打开产品 Settings 窗口，驱动正式控件 `.material-select`（`page.selectOption`） |
| 状态载体 | 产品把 `data-glass="full\|reduced\|solid"` 挂到 `.desktop` 上 |
| 材质来源 | 全部来自 `src/styles.css` 的产品 token（`--glass-filter-window` 等） |
| 载荷单元 | 只注入载荷**自身**（`.oa-synth`），且只引用产品 token：<br>`backdrop-filter: var(--glass-filter-window);`<br>`background: rgb(var(--content-rgb) / var(--content-alpha));` |
| 载荷挂载点 | 挂在 `.desktop` **内部**（不是 `body`）——否则拿不到 token 继承，也够不着 SOLID 的 `.desktop[data-glass="solid"] *` 规则 |
| 断言 | 每格回读 `data-glass` / `localStorage` / `select` 三者一致，并校验 `.window` 与 `.oa-synth` 的**实际** `backdrop-filter` 命中预期正则；不符即抛错，不静默继续 |

实测取证（`perf-product-*.json` → `productModes`，K=24）：

| 档位 | `data-glass` | `.window` backdrop | `.oa-synth` backdrop | `.oa-synth` 底色 | `--surface-alpha` |
|---|---|---|---|---|---|
| full | `full` | `blur(34px) saturate(1.8)` | `blur(34px) saturate(1.8)` | `rgba(23,23,23,0.6)` | `.5` |
| reduced | `reduced` | `blur(10px)` | `blur(10px)` | `rgba(23,23,23,0.82)` | `.72` |
| solid | `solid` | `none` | `none` | `rgb(14,14,14)` | `1` |

这证明三档的差异**确实来自产品 token**，载荷跟着档位一起变。

**两种口径**（脚本内 `OA_MODE`）：

- `cold` = **冻结口径**，复刻 D1-04 perf2 的采样方式：每格独立新页面、无预热，
  因此每格含"新图层首次光栅化 + 首次 backdrop 模糊"的一次性成本。与历史方法的唯一区别是档位走产品状态。
- `warm` = 同页交错、每档先走一遍不计分的预热拖动，测**稳态**交互成本。加预热是因为：
  拉丁方第 0 轮总把 FULL 排在最前，不预热就会把一次性开销记在 FULL 头上，伪造出档位差异
  （实测 K=72 首轮 mean 20.0ms、后续轮 8.3ms）。

两种口径都用**同页交错 + 每轮档位顺序轮转（拉丁方）**消除负载漂移与顺序偏置。

### 21.3 FULL results

`mean / p95 / >33ms 长帧数`，单位 ms。

**稳态（warm，scatter 布局，7 轮）**

| 档位 | K=0 | K=24 | K=72 | K=144 |
|---|---|---|---|---|
| **FULL** | 8.33 / 9.2 / 0 | 8.36 / 9.1 / 0 | 9.27 / 9.3 / 1 | **10.51 / 25.6 / 4** |
| **REDUCED** | 8.32 / 9.1 / 0 | 8.32 / 9.1 / 0 | 9.15 / 9.3 / 1 | **9.65 / 16.8 / 2** |
| **SOLID** | 8.33 / 9.1 / 0 | 8.32 / 9.1 / 0 | 8.33 / 9.2 / 0 | 8.33 / 9.1 / 0 |

**冷启动（cold，scatter 布局，5 次独立新页面）**

| 档位 | K=0 | K=24 | K=72 | K=144 |
|---|---|---|---|---|
| **FULL** | 8.33 / 9.2 / 0 | 10.06 / 16.7 / 0 | 26.56 / 50.1 / 39 | 48.99 / 83.4 / 42 |
| **REDUCED** | 8.33 / 9.1 / 0 | 9.23 / 16.7 / 0 | 24.29 / **58.2** / 38 | 41.02 / **90.8** / 43 |
| **SOLID** | 8.33 / 9.2 / 0 | 8.26 / 9.1 / 0 | 8.32 / 9.0 / 0 | 8.33 / 9.0 / 0 |

三条读数：

1. **p50 在所有格子都是 8.3–9.3ms**，即被 120Hz 垂直同步截平。**p50 与平均 fps 在这组实验里没有分辨力**，
   只有 p95、>33ms 长帧数、以及与 vsync 成线性关系的 mean 有分辨力。
2. **产品自身的玻璃几乎不花钱。** K=0（场景只有 4 个真实窗口 + 顶栏 + Dock + 设置窗 ≈ 7 个玻璃面）时
   三档全部 8.33ms / 120fps / 0 长帧。玻璃成本要到 K≥72 才出现。
3. **冷启动成本远大于稳态成本**：同样是 FULL K=144，冷启动 mean 48.99ms、42 帧长帧；
   预热后稳态 mean 10.51ms、4 帧长帧。前者是"一次性光栅化"，后者才是"持续拖动"。

### 21.4 REDUCED results

按第 8 节的四条判据逐条对照：

| 判据 | 结果 | 证据 |
|---|---|---|
| p95 明显下降 | **仅 warm/K=144 成立** | 25.6 → 16.8（−34%，正好低一个 vsync 档）；K=0/24/72 与 FULL 完全一致；cold/K=72 与 K=144 **反向变差**（50.1→58.2、83.4→90.8） |
| 长帧数下降 | **仅 warm/K=144 成立** | 4 → 2；K=72 为 1 → 1；K≤24 双方都是 0 |
| K=24 不得变差 | **通过** | warm 8.36 → 8.32；cold 10.06 → 9.23（更快，不是更慢） |
| K=72/144 高负载下有明确收益 | **仅 K=144 的稳态口径成立** | warm/K=144 mean −8.2%；K=72 无（9.27 → 9.15，落在噪声内） |

**同轮配对**（同一页面、同一负载、相邻两格相减，消除负载漂移）：

| K | 各轮 (FULL − REDUCED) mean 差 | 均值 | 为正 |
|---|---|---|---|
| 0 | 0.04, 0, 0, 0, 0, 0, 0 | +0.01 | 1/7 |
| 24 | 0, −0.09, 0.01, 0.15, 0, 0.10, 0.09 | +0.04 | 4/7 |
| 72 | 0.20, −0.30, 0.48, 0, 0, 0.19, 0.27 | +0.12 | 4/7 |
| 144 | 1.80, 0.77, 0.67, 1.03, 0.48, 0.67, 0.66 | **+0.87** | **7/7** |

K≤24 是掷硬币（4/7），K=72 也是掷硬币（4/7）——**差异不可分辨**。
只有 K=144 是 7/7 一致（+0.87ms，≈8%）。

> **后续（D1-04C）**：上表判定的对象是"降半径版 REDUCED"，该实现已被替换为"选择性玻璃版 REDUCED"。
> 新实现下 REDUCED 在 K=0/24/72/144 全部恒定 8.3ms、0 长帧，过滤面积与 SOLID 同量级（第 22 节）。
> 本节数据不删，作为"半径不是杠杆"的证据保留。

### 21.5 SOLID results

| 判据（第 9 节） | 结果 |
|---|---|
| 不随 K 明显退化 | **通过**。K=0/24/72/144 全部 8.33 / 9.1 / 0；拓展到 K=288/432/648 仍为 8.33 / 9.2 / 0 |
| K=144 是否出现与 FULL 相似的高分位退化 | **没有**。p95 9.1，与 K=0 完全一致 |
| 是否混入其他性能变量 | **没有**。SOLID 在此实验中是唯一的"零 backdrop-filter"对照组，全负载范围内恒定 |

拓展探针（warm，scatter，3 轮，同一批产物）：K=288 / 432 / 648 时
FULL 24.65 / 43.49 / 50.58，REDUCED 24.18 / 34.41 / 54.70，SOLID 8.33 / 8.34 / 8.33。
**在系统饱和区，FULL 与 REDUCED 的差异不再有方向性**（K=432 REDUCED 好 21%，K=648 REDUCED 差 8%）。

### 21.6 Historical comparison（与 D1-04 注入式 REDUCED 的 A/B）

| 来源 | 口径 | REDUCED K=24 p95 | FULL K=24 p95 | 结论 |
|---|---|---|---|---|
| D1-04 记录（`perf2.json`，注入 CSS） | 冷，分档块状，无预热 | **9.2** | **16.3** | 当时记为"REDUCED 省 43%" |
| **今天用同一支 `perf2.mjs` 重跑** | 同上，一字未改 | **16.7** | **16.8** | **历史那条 9.2 不可复现** |
| 产品态（本轮 `perf-product.mjs`，cold） | 冷，交错，拉丁方 | 9.23 | 10.06 | REDUCED 略好 |
| 产品态（本轮，warm） | 稳态，交错，拉丁方 | 8.32 | 8.36 | 无差异 |

**旧实验注入的 REDUCED 与产品 REDUCED 并不矛盾——两者在重跑后都指向"与 FULL 差不多"。**
真正的分歧在**历史记录**与**重跑**之间。原因（已定位，非接受）：

- 旧方法**按档位分块**测量（先把 FULL 的四个 K 跑完，再跑 REDUCED 的四个 K）。
  主机负载在这段时间内漂移，漂移会被整块记到某一档头上，制造出档位差异。
- 旧方法**没有预热**，每格都含一次性光栅化成本；分块顺序让这份成本系统性地落在先测的档位上。

同布局 A/B 对照（warm，**复刻 D1-04 的 8 列网格**，3 轮）：K=72 / K=144 时
FULL 8.81 / 8.71，REDUCED 8.59 / 8.40，SOLID 8.33 / 8.33。
即使在旧布局下用新仪器测，差异也只有 ~0.3ms（3%），与历史记录的 43% 不是一个量级。

### 21.7 Runtime switching

`experiments/d1-04/glass-switch-stress.mjs`：**21 轮 × 3 = 63 次** FULL→REDUCED→SOLID→FULL 往返，
全部通过产品 Settings 控件驱动。

| 检查项 | 结果 |
|---|---|
| `data-glass` / `localStorage` / `select` 三者一致 | **63/63** |
| 窗口是否丢失 | 全程保持（基线 3 个窗口，结束时仍 3 个可见） |
| 窗口矩形是否变化 | **全程不变**（逐轮比对，无一例外） |
| 是否重新布局 | 否。矩形全程一致即为其证据 |
| 残留错误 token | 无。末态 `class="desktop dark"`，旧键 `oa-opaque` 为 `null` |
| 切换期长帧尖峰 | 373 帧：p50 8.3ms / p95 9.2ms / max 9.4ms / **>33ms 0 帧** / >100ms 0 帧 |
| 闪白 / 闪黑 | `flash_check.py` 复核 6 步 × 4 帧 × 3 采样点 = 72 个采样，**全部落在切换前后两档的区间内**（容差 ±4） |
| WebContentsView 状态 | **NOT VERIFIED**——它是 Electron 独有对象，Chromium 里不存在。本次记录 DOM 侧 `.web-viewport` 计数（全程 0 → 保持 0）作为代理 |

材质切换未破坏任何功能状态。

### 21.8 Light sanity

浅色 K=24（warm，5 轮）：FULL 8.33 / 9.2 / 0，REDUCED 8.34 / 9.2 / 0，SOLID 8.33 / 9.1 / 0。
**三档在浅色下与深色走同一条性能路径**（浅色 `--surface-alpha` 更高只是改 alpha，不产生新的合成分支）。
未做第二轮完整基线，符合"至少一次 sanity"的要求。

### 21.9 Interpretation

本轮的可靠结论只有三条：

1. **`backdrop-filter` 的"有无"是唯一强成本杠杆。** SOLID 关掉它之后，K 从 0 到 648 全部恒定 8.33ms、0 长帧；
   FULL/REDUCED 在 K≥72 之后开始掉帧。这是 3 套独立测量设计下都成立的结果。
2. **模糊半径不是可靠的成本杠杆。** 把 `blur(34px) saturate(1.8)` 降到 `blur(10px)` 并去掉 `saturate`，
   在冻结的 K 集合里只在稳态 K=144 拿到 8% 与一个 vsync 档；轻载完全无差别，冷启动下 p95 反而更差。
   机制上说得通：Chromium 会按半径对 backdrop 做降采样，半径越大处理的像素反而越少，
   于是"半径"在 10–34px 区间几乎是平的。**REDUCED 试图用"更小的模糊"换性能，方向本身不成立。**
3. **当前产品的玻璃负载不构成性能问题。** 真实场景（≈7 个玻璃面，K=0）三档全部 120fps、0 长帧。
   需要 REDUCED 的负载水平（K≥144，即额外 144 个 420×300 玻璃面）在当前产品里并不存在。

**因此 REDUCED 档的结论是"不通过"，但原因不是实现有缺陷，而是它的性能假设被证伪。**
实现本身（产品态切换、无功能回归、与动效解耦、浅色一致）全部通过。

**给下一轮的选项**（不在本轮实施）：

- **A. 重新定义 REDUCED 的作用面**：不降半径，改为**减少参与 backdrop-filter 的面**——大表面（窗口正文）
  在 REDUCED 下直接走实色（等价 SOLID 的表面策略），只给顶栏、Dock、tooltip 这类小面积面保留玻璃。
  这与实测的"成本由面数/面积决定"一致。
- **B. 把 REDUCED 并掉**：既然中间档无稳定收益，降级链直接 `FULL → SOLID`，少一个状态与一套测试面。
- **C. 维持现状但明确声明**：保留三档作为"视觉档位"（用户偏好），**不承诺性能收益**，并在 UI 上不要暗示它更省。

> **Boss 决策（2026-09-11）：选 A。** 实施与验收见第 22 节。B / C 不再考虑。

**测量可信度声明**：本机存在**外部持续负载**（loadavg ≈ 8–10 / 12 核，非本实验进程造成，
在实验间隙的空载采样中同样维持）。绝对数值因此高于空载环境，**不可与 D1-04 的绝对数直接比较**。
相对比较通过"同页交错 + 同轮配对 + 多轮重复"设计保持有效：K=144 的 7/7 配对一致与
SOLID 的全负载恒定，都证明仪器仍有分辨力。但**空载环境下重测一次仍是必要的**（见第 18 节）。

### 21.10 Electron limitation

**Electron 内的材质性能：NOT VERIFIED。** 本机 Electron 44.3.0 的 GPU 进程在代理执行环境下起不来
（Chromium sandbox `Operation not permitted`，必须 `--no-sandbox --disable-gpu-sandbox --in-process-gpu`），
窗口合成路径与 Chromium 不同。本节全部数字**不得**作为 Electron 性能结论引用。

### 21.11 Windows limitation

**Windows 平台：NOT VERIFIED。** 未在 Windows 主机上运行。Windows 走 mica/DWM 合成，
与 macOS 的 vibrancy 路径不同，`backdrop-filter` 的落地方式也不同（D3 才验证）。本节结论不外推到 Windows。

---

## 22. D1-04C 选择性玻璃（REDUCED 作用面重定）

> **判定：PASS。D1-04 的内部方向缺口 CLOSED（D1-04 整体仍为 PARTIAL，只剩两条代表性缺口）。**
> REDUCED 的作用面策略已进入真实产品代码；过滤面积在四个负载点下降 **−86.6% / −95.5% / −98.1% / −99.0%**；
> 六格主题矩阵继续 PASS；63/63 切换压力继续 PASS 且结构性指标全程不变；无视觉/功能回归。
> REDUCED 在高负载下**不再比 FULL 差**（冷启动口径 K=144：FULL 34.19ms / 43 帧长帧 vs REDUCED 8.33ms / 0 帧）。
>
> **本节数字标注 `D1-04C OFFICIAL CHROMIUM MEASUREMENT`，代表性一律 `NOT REPRESENTATIVE FOR ELECTRON`。**
> 它们证明的是**机制成立**（过滤面积确实降下来了），不是"Electron 上已经更快"。
> Electron 内与 Windows 上均为 **NOT VERIFIED**（第 22.14 节）。

### 22.1 决策：选 A —— 减面积，不减半径

Boss 在 D1-04B 给出的 A/B/C 三个选项中**选 A**：

- **不降模糊半径**，改为**减少参与 `backdrop-filter` 的面数与面积**；
- 大表面（窗口正文、AI 面板、搜索面板、内容区）在 REDUCED 下直接走实色；
- 只在小面积系统 chrome（顶栏、Dock、tooltip、右键菜单、AI 胶囊、窗口标题条）保留玻璃。

**为什么方向是面积而不是半径**——D1-04B 的三条读数（第 21.9 节）已经指向这一点：
`backdrop-filter` 的"有无"是唯一的强成本杠杆（SOLID 全负载恒定 8.33ms），
而半径在 10–34px 区间几乎没有分辨力。机制上说得通：**Chromium 会按半径对 backdrop 做降采样，
半径越大处理的像素反而越少**，于是"把半径调小"这一侧的收益被"降采样变弱"吃掉了。

因此把这条写进正式定义：

| 项目 | 定位 | 说明 |
|---|---|---|
| **filtered area / filtered surface count** | **性能杠杆（primary）** | 降档的唯一性能机制。REDUCED 的过滤面积必须显著低于 FULL，否则该档没有存在意义 |
| **blur radius** | **次要视觉参数（secondary）** | 允许在 REDUCED 下取更小的值（10–13px）用于视觉一致性，但**不得声称"34→10px 本身降低了成本"** |

### 22.2 正式定义与实现载体

| 档位 | `data-glass` | 正式定义 |
|---|---|---|
| FULL | `full` | 全部表面走完整玻璃 |
| REDUCED | `reduced` | **选择性玻璃 / 减少过滤面积**：大面积表面转实色，小面积 chrome 保留薄玻璃 |
| SOLID | `solid` | 全部表面无 `backdrop-filter` |

实现只有一个开关，放在产品 token 层：

```css
/* 大面积表面开关：只在把大面积转实色的档位里被定义。
   引用它的选择器就是"大面积白名单"成员；别处不定义 ⇒ FULL 自动回退到完整玻璃。 */
.desktop[data-glass="reduced"] { --glass-filter-large: none; }

.window      { backdrop-filter: var(--glass-filter-large, var(--glass-filter-window)); }
.ai-panel    { backdrop-filter: var(--glass-filter-large, var(--glass-filter)); }
.search-panel{ backdrop-filter: var(--glass-filter-large, var(--glass-filter)); }
```

窗口这一面还多做了一步（比"容器直接转实色"更好）：**玻璃下沉到标题条**。
`.window` 容器转 `transparent`，`.window-title` 承接 `backdrop-filter: var(--glass-filter-window)`
与 `rgb(var(--surface-rgb) / var(--surface-alpha))`，`.window-body` 接 `rgb(var(--content-rgb) / 1)`。
理由是设计系统规定「窗口边界靠明度差」：容器若整块转实色，窗口会变成一块死板矩形；
下沉后窗口仍有一条 44px 的材质带，窗口层级不变（量见第 22.10 节）。

### 22.3 Surface × tier 矩阵（作用面白名单）

这是本轮最该被复用的表。`过滤面` = 该面是否带非 `none` 的 `backdrop-filter`（即计入成本）；
`染色面` = 只有底色、从不带滤镜。

| # | Surface | FULL | **REDUCED** | SOLID | REDUCED 归类 |
|---|---|---|---|---|---|
| 1 | `.topbar` | 玻璃 `blur40` | **玻璃 `blur12`** | 实色 | 保留玻璃 |
| 2 | `.dock` | 玻璃 `blur44` | **玻璃 `blur13`** | 实色 | 保留玻璃 |
| 3 | `.dock-tooltip` | 玻璃 `blur24` | **玻璃 `blur7`** | 实色 | 保留玻璃（短时浮层） |
| 4 | `.context-menu`（含小 popover） | 玻璃 `blur40` | **玻璃 `blur12`** | 实色 | 保留玻璃（小面积菜单） |
| 5 | `.assistant-pill` | 玻璃 `blur32` | **玻璃 `blur10`** | 实色 | 保留玻璃（短时浮层） |
| 6 | `.window-title` | 无滤镜（随窗口） | **玻璃 `blur10`** ← 玻璃下沉到这里 | 实色 | 新增过滤面（44px 窄带） |
| 7 | `.window`（容器） | 玻璃 `blur34` | **实色 `transparent`** | 实色 | **转出过滤面** |
| 8 | `.window-body` | 无滤镜（随窗口） | **实色 `rgb(23 23 23 / 1)`** | 实色 | 内容区转实色 |
| 9 | `.ai-panel`（AI 面板主面） | 玻璃 `blur40` | **实色 `rgb(23 23 23 / 1)`** | 实色 | **转出过滤面** |
| 10 | `.search-panel`（搜索主面，也是唯一 `role="dialog"`） | 玻璃 `blur40` | **实色 `rgb(23 23 23 / 1)`** | 实色 | **转出过滤面** |
| 11 | `.content-region`（卡片 / 设置内容 / 浏览器壳 / 视口 / composer） | 染色面无滤镜 | **染色面，`--content-alpha: 1`** | 实色 | 内容区转实色 |
| 12 | `.app-card` 等卡片 | 染色面无滤镜 | 染色面无滤镜 | 染色面无滤镜 | 三档一致（不参与过滤面积统计） |

> **关于"large Dialog body"**：产品当前**没有**独立 Dialog 组件——全仓只有一个 `role="dialog"`，
> 就是 `.search-panel`（第 10 行）。所以本轮把它按"大面积浮层"处理（REDUCED 下实色）。
> 未来若引入独立 Dialog，规则已经写好：**大 Dialog 主体走实色、短时小浮层保留玻璃**。
> 同理，`.context-menu` 就是当前唯一的"小 popover"。

**深色 computed 实测**（`artifacts/d1-04/glass-matrix.json`，未删）证明上表不是文档承诺而是产品行为：

| Surface | FULL | REDUCED | SOLID |
|---|---|---|---|
| TopBar | `blur(40px) saturate(1.8)` / `rgba(23,23,23,0)` | `blur(12px)` / `rgba(23,23,23,.22)` | `none` / `rgb(0,0,0)` |
| Dock | `blur(44px) saturate(1.8)` / `rgba(23,23,23,0)` | `blur(13px)` / `rgba(23,23,23,.22)` | `none` / `rgb(0,0,0)` |
| Window | `blur(34px) saturate(1.8)` / `rgba(23,23,23,.5)` | **`none`** / `transparent` | `none` / `rgb(12,12,12)` |
| WindowTitle | `none` / `transparent` | **`blur(10px)`** / `rgba(23,23,23,.72)` | `none` / `transparent` |
| Menu | `blur(40px) saturate(1.8)` / `rgba(23,23,23,.5)` | `blur(12px)` / `rgba(23,23,23,.72)` | `none` / `rgb(12,12,12)` |
| Search | `blur(40px) saturate(1.8)` | **`none`** / `rgb(23,23,23)` | `none` / `rgb(12,12,12)` |
| AI | `blur(40px) saturate(1.8)` | **`none`** / `rgb(23,23,23)` | `none` / `rgb(12,12,12)` |
| Card | `none` / `rgba(23,23,23,.6)` | `none` / `rgb(23,23,23)` | `none` / `rgb(14,14,14)` |
| Pill | `blur(32px) saturate(1.8)` | `blur(10px)` / `rgba(23,23,23,.94)` | `none` / `rgb(0,0,0)` |
| Tip | `blur(24px) saturate(1.8)` | `blur(7px)` / `rgba(23,23,23,.72)` | `none` / `rgb(12,12,12)` |

**正交性**：本轮的改动**只**发生在 Glass 维度。
Theme（`light` / `dark`，`.dark` 类）与 Motion（`.reduced` 类，Reduce Motion）未被触碰；
`.reduced` 这个类名仍然只表示动效，没有被拿去表示材质档位。

### 22.4 为什么不用 `.desktop[data-glass="reduced"] *`

如果用全局规则把 REDUCED 下所有 `backdrop-filter` 清掉，会同时打掉顶栏、Dock、tooltip、右键菜单——
那是 SOLID 的策略，不是 REDUCED 的策略，三档就没有区分度了。

本轮的做法是**显式白名单**：唯一开关是 `--glass-filter-large`，
**引用它的选择器就是白名单成员**（`.window` / `.ai-panel` / `.search-panel`，性能脚本里的载荷 `.oa-synth` 同款引用）。
好处有两个：

1. 新增一个大面积面时，只要它引用 `--glass-filter-large` 就自动获得三档语义，不需要再写一条 `reduced` 规则；
2. 不引用它的面在 FULL 下与 REDUCED 下行为一致，**"忘了加规则"的失败模式被消除**。

静态检查（本轮实做）：`src/styles.css` 中不存在 `.desktop[data-glass="reduced"] *` 这类全局规则，
`--glass-filter-large` 只出现 1 处定义 + 3 处引用（`.window` / `.ai-panel` / `.search-panel`）。

### 22.5 Filtered surface count（过滤面数）

脚本侧新增 `measureFiltered(page)`：遍历全部元素，取 `getComputedStyle` 里 `backdropFilter`
非 `none` 的节点，排除 `display:none` / `visibility:hidden` / `opacity:0`，把包围盒裁剪到视口后累加。
这个数**就是"成本面数"**，与第 21 节推断的"成本由面数/面积决定"直接对齐。

| K（额外 420×300 玻璃面板数） | FULL | **REDUCED** | SOLID |
|---|---|---|---|
| 0 | 6 | **6** | 0 |
| 24 | 30 | **6** | 0 |
| 72 | 78 | **6** | 0 |
| 144 | 150 | **6** | 0 |

**REDUCED 的过滤面数与 K 完全无关**：产品自身的 6 个面（顶栏 / Dock / AI 胶囊 / 3 条窗口标题条）
是全部，载荷面板一个都不进过滤集合（载荷引用的是 `--glass-filter-large`，在 REDUCED 下为 `none`）。
这正是"选择性玻璃"该有的形状：**负载增长时，REDUCED 的成本曲线是平的。**

### 22.6 Filtered area（过滤面积）

`filteredArea` = 各过滤面裁剪到视口后的像素面积之和（面积为**叠加**值，因此 coverage 可以 >100%）。

| K | FULL 过滤面数 / 面积 / 覆盖率 | **REDUCED 过滤面数 / 面积 / 覆盖率** | SOLID | 面积降幅 |
|---|---|---|---|---|
| 0 | 6 / 1,523,824 px / 117.6% | **6 / 203,564 px / 15.7%** | 0 / 0 / 0% | **−86.6%** |
| 24 | 30 / 4,547,824 px / 350.9% | **6 / 203,564 px / 15.7%** | 0 / 0 / 0% | **−95.5%** |
| 72 | 78 / 10,595,824 px / 817.6% | **6 / 203,564 px / 15.7%** | 0 / 0 / 0% | **−98.1%** |
| 144 | 150 / 19,667,824 px / 1517.6% | **6 / 203,564 px / 15.7%** | 0 / 0 / 0% | **−99.0%** |

视口面积 1,296,000 px（1440×900）。FULL/REDUCED 的面积比随负载拉大：7.5× → 22.3× → 52.1× → 96.6×。

**REDUCED 那 203,564 px 的构成**（K=0，深色）：

| 面 | 尺寸 | 面积 |
|---|---|---|
| `.topbar` | 1440 × 38 | 54,720 |
| `.window-title` ×3 | 840×44 / 840×44 / 830×44 | 36,960 + 36,960 + 36,520 |
| `.dock` | 479 × 69 | 33,051 |
| `.assistant-pill` | 145 × 37 | 5,353 |
| **合计** | | **203,564** |

对照 FULL 同点位的 1,523,824 px：三块 `.window`（840×570、840×570、830×570）就占了 1,430,700 px，
也就是**86% 的过滤面积本来花在窗口容器这一件事上**。把它转实色，就是本轮的全部收益来源。

### 22.7 FULL comparison

深色稳态（warm，scatter 布局，5 轮/格）。`mean / p95 / >33ms 长帧数`，单位 ms。

| 档位 | K=0 | K=24 | K=72 | K=144 |
|---|---|---|---|---|
| **FULL** | 8.20 / 9.10 / 0 | 8.33 / 8.90 / 0 | 9.25 / 9.40 / 1 | **11.35 / 41.60 / 5** |
| **REDUCED** | 8.33 / 9.00 / 0 | 8.33 / 9.00 / 0 | 9.18 / 8.90 / 0 | **8.33 / 9.10 / 0** |
| **SOLID** | 8.33 / 9.10 / 0 | 8.33 / 9.10 / 0 | 8.33 / 8.90 / 0 | 8.33 / 9.00 / 0 |

冷启动（cold，每格独立新页面、无预热，3 次重复）——这一栏是 D1-04B 判 REDUCED 不通过的地方，本轮反过来了：

| 档位 | K=0 | K=24 | K=72 | K=144 |
|---|---|---|---|---|
| **FULL** | 8.33 / 9.10 / 0 | 9.09 / 16.70 / 0 | **19.72 / 40.20 / 29** | **34.19 / 66.70 / 43** |
| **REDUCED** | 8.33 / 9.20 / 0 | 8.33 / 9.20 / 0 | **8.33 / 9.20 / 0** | **8.33 / 9.20 / 0** |
| **SOLID** | 8.33 / 9.20 / 0 | 8.33 / 9.10 / 0 | 8.33 / 9.10 / 0 | 8.33 / 9.20 / 0 |

三条读数：

1. **p50 依旧没有分辨力**（全格 8.3–9.3ms，被 120Hz 垂直同步截平）。判据只用 p95、>33ms 长帧数、mean。
2. **REDUCED 与 SOLID 现在是同一条成本曲线**：K=0/24/72/144 全部 8.33ms、p95 8.9–9.2、0 长帧。
   也就是说，"大面积实色 + 小面积玻璃"的组合**没有为玻璃 chrome 付可测的代价**。
3. **FULL 的代价随面积线性出现**：冷启动 K=72 起 mean 19.72、29 帧长帧；K=144 mean 34.19、43 帧长帧。
   稳态下 K=144 也已经有 5 帧长帧、p95 41.60。

### 22.8 REDUCED comparison

按 Boss 给的新判据（不要求 K=24 有巨大 p95 差）逐条对照：

| 新判据 | 结果 | 证据 |
|---|---|---|
| **(a) 过滤面积确实显著下降** | **通过** | K=0 −86.6% → K=144 −99.0%；过滤面数 150 → 6（第 22.5/22.6 节） |
| **(b) 高负载下不比 FULL 差** | **通过** | 稳态 K=144：FULL 11.35/41.60/5 vs REDUCED 8.33/9.10/0；冷启动 K=144：34.19/66.70/43 vs 8.33/9.20/0 |
| **(c) 随压力上升比 FULL 更稳** | **通过** | REDUCED 的 mean 从 K=0 到 K=144 变化 +0.00ms（8.33→8.33）；FULL 变化 +3.02ms（8.33→11.35 稳态）/ +25.86ms（8.33→34.19 冷启动） |
| **(d) SOLID 仍是最低成本基线** | **通过** | SOLID 全负载 8.33ms / 0 长帧；REDUCED 与之同线但不低于它 |

**同轮配对**（同一页面、同一负载，`FULL mean − REDUCED mean`，消除负载漂移）：

| K | 各轮差值 (ms) | 均值 | 为正 |
|---|---|---|---|
| 0 | 0.00, 0.00, −0.02, −0.48, −0.15 | −0.13 | 0/5 |
| 24 | 0.01, 0.00, 0.01, −0.01, −0.01 | +0.00 | 2/5 |
| 72 | 0.86, −3.14, 0.52, 0.29, 1.80 | +0.07 | 4/5 |
| 144 | 2.56, 2.27, 5.40, 2.28, 2.56 | **+3.01** | **5/5** |

**K≤24 依旧不可分辨**（0/5 与 2/5，就是这个量级下的掷硬币），**K=144 变成 5/5 一致且差 3.01ms**。
这正好符合新判据的精神：**轻载谈不上差异，重载必须不差、且趋势一致。**

与 D1-04B 的"降半径版 REDUCED"直接对比（同为稳态 K=144）：

| 实现 | REDUCED 过滤面积 | REDUCED K=144 mean / p95 / 长帧 | FULL K=144 mean / p95 / 长帧 |
|---|---|---|---|
| D1-04B 降半径版 | 与 FULL 同面数（面积未测） | 9.65 / 16.80 / 2 | 10.51 / 25.60 / 4 |
| **D1-04C 选择性玻璃版** | **203,564 px（−99.0%）** | **8.33 / 9.10 / 0** | 11.35 / 41.60 / 5 |

降半径版只能"好一点点"，选择性玻璃版直接把 REDUCED 压到 SOLID 的成本水平上。
**这就是"性能杠杆是面积、不是半径"最直接的证据。**

### 22.9 SOLID comparison

| 判据 | 结果 |
|---|---|
| 不随 K 明显退化 | **通过**。K=0/24/72/144 全部 8.33ms / p95 8.9–9.2 / 0 长帧（冷启动同） |
| 过滤面积是否为 0 | **通过**。四个 K 全为 0 面 / 0 px |
| 是否被本轮改动影响 | **否**。SOLID 的 token 与 `.desktop[data-glass="solid"] *` 规则本轮未改（只加了 `.search-result:hover` 一条，见 22.11） |

### 22.10 Light / Dark verification

**浅色 sanity（warm，K=24，5 轮）**

| 档位 | mean / p95 / 长帧 | 过滤面数 / 面积 |
|---|---|---|
| FULL | 8.33 / 9.10 / 0 | 30 / 4,547,824 px |
| REDUCED | 8.33 / 9.10 / 0 | 6 / 203,564 px |
| SOLID | 8.33 / 9.00 / 0 | 0 / 0 px |

**浅色的过滤面积与深色完全一致**（同 K 下逐字节相同）——因为面积只由"哪些面带滤镜"决定，与主题颜色无关。
这意味着浅色不需要独立的面积基线，只需一次性能 sanity；本轮满足。

**层级不被拉平**（`experiments/d1-04/reduced_probe.py`，取窗口正文/标题条/桌面/顶栏/Dock 的众数色）

| 主题 | 档位 | 窗口正文 | 桌面 | 正文−桌面 | 标题条 | 标题条−正文 |
|---|---|---|---|---|---|---|
| light | FULL | (255,255,255) | (243,243,245) | 11.3 | (247,247,248) | −8 |
| light | **REDUCED** | (255,255,255) | (243,243,245) | **11.3** | (252,252,252) | −3 |
| dark | FULL | (24,24,24) | (3,3,3) | 21.0 | (11,11,11) | −13 |
| dark | **REDUCED** | (23,23,23) | (3,3,3) | **20.0** | (16,16,16) | −7 |

- **切档不改窗口明度**：浅色 0 级变化，深色 −1 级（24 → 23）。窗口边界仍靠明度差成立。
- **标题条仍是一条更亮的材质带**（深色 +7 相对正文、浅色 −3），窗口的"材质厚度"没丢。
- **窗口正文实色取自设计系统自己的基色**（深色 `#171717`、浅色 `#fff`），没有引入新颜色，
  也没有用"压暗"去凑层级——在近黑桌面上压暗反而会削弱窗口与桌面的明度差。

**对比度（WCAG，REDUCED 档专项）**

| 主题 | 最低对比度 | 位置 | 判定 |
|---|---|---|---|
| light | **5.07:1** | 副标题 `.subtitle`（`rgb(110,110,115)` on `#fff`） | AA 通过（≥4.5:1） |
| dark | **6.24:1** | 副标题 `.subtitle`（`rgb(152,152,157)` on `#171717`） | AA 通过 |

其余采样点（顶栏字标 / 窗口标题栏 / 应用卡片 / AI 面板正文）在 REDUCED 下均在 15.6–18.7:1。

### 22.11 Runtime switching 与回归测试

**切换压力**（`glass-switch-stress.mjs`，21 轮 × 3 = **63 次** FULL→REDUCED→SOLID→FULL 往返，全部走产品 Settings 控件）：

| 检查项 | 结果 |
|---|---|
| `data-glass` / `localStorage` / `select` 三者一致 | **63/63** |
| 窗口是否丢失 | 全程保持（基线 3 个，结束时仍 3 个可见） |
| 窗口矩形 / 是否重新布局 | **全程不变**（逐轮比对） |
| 残留错误 token / 类名 | 无。末态 `class="desktop dark"`，旧键 `oa-opaque` 为 `null` |
| 切换期帧统计 | 366 帧：p50 8.3ms / p95 9.1ms / max 9.4ms / **>33ms 0 帧** / >100ms 0 帧 |
| 闪白 / 闪黑 | 无（`flash_check.py` 72 个采样全部落在切换前后两档区间内，容差 ±4） |
| WebContentsView 状态 | **NOT VERIFIED IN CHROMIUM**（Electron 独有对象）。以 DOM 侧 `.web-viewport` 计数作代理，全程 0 → 保持 0 |

**六格主题矩阵**（`theme-matrix.mjs`，computed 断言 + 像素断言）：**6/6 PASS**。
深色三格的窗口内容像素分别落在 `[12,30] / [12,30] / [8,20]` 的暗部区间内（`dark-reduced` 实测 (23,23,23)）。

**逐档材质矩阵**（`glass-tiers.mjs`，10 个面 × 3 档）：与第 22.3 节表格逐行一致。

**本轮修掉的真实缺陷（1 条，非顺手改动）**：把大面积面板转实色后，`.search-result:hover` 原来靠
`rgb(var(--content-rgb) / var(--content-alpha))` 表达 hover，**在实色底上叠同色 rgba 合成结果不变，hover 消失**。
这是一条真实的层级回归。修法沿既有手段（不加 border / 不加重阴影）：
浅色复用既有 `--sunken`（4% 黑），深色用 3% 白抬亮——因为深色 `--sunken` 是 28% 黑，
在 `#0C0C0C` 这种近黑面上压黑只有 Δ3 级（实测 ΔL\* 0.85，肉眼不可辨）。
新探针 `experiments/d1-04/hover_probe.py`（六格 × 未 hover/已 hover 截图取众数色）：

| 主题 | 档位 | 修前 ΔL\* | **修后 ΔL\*** | 判定 |
|---|---|---|---|---|
| light | full / reduced / solid | — / 不可辨 / 3.41 | 8.02 / **3.46** / **3.49** | 可辨 |
| dark | full / reduced / solid | 2.25 / 不可辨 / **0.65** | 2.25 / **3.52** / **3.00** | 可辨 |

其他回归：`npm test` **7/7 通过**；`a11y-check.mjs` 右键菜单 1→0（Esc 后）、`menu-shade` 1→0、
桌面可 Tab 元素 0、`Cmd+K` 搜索面板 1→0；`npm run build` 干净（`tsc --noEmit` 无报错）。

### 22.12 Why radius reduction was rejected

D1-04B 的 REDUCED 定义是"把模糊半径从 34px 降到 10px，并整条滤镜重写以真正去掉 `saturate`"。
这个方向在 D1-04B 被实测证伪，D1-04C 正式否决。四条理由：

1. **暖态（warm）下，K ≤ 72 与 FULL 完全不可分辨。**
   第 21.4 节的同轮配对：K=0 是 1/7、K=24 是 4/7、K=72 是 4/7——都在掷硬币区间。
   只有 K=144 是 7/7 一致，且只赢 8%。
2. **冷启动高负载下反而更差。**
   第 21.3 节 cold：K=72 FULL 50.1 → REDUCED 58.2；K=144 FULL 83.4 → REDUCED 90.8。
   降半径在这两个点上让 p95 变坏了。
3. **历史记录的"省 43%"不可复现。**
   D1-04 记的 REDUCED K=24 p95 = 9.2（FULL 16.3）；今天**一字未改**地用同一支 `perf2.mjs` 重跑，
   得到 REDUCED 16.7 / FULL 16.8。原因已定位（非"接受"）：旧方法**按档位分块**测量 + **无预热**，
   主机负载漂移与一次性光栅化成本被整块记到某一档头上，制造出档位差异。
   同布局 A/B（复刻旧的 8 列网格）用新仪器测，差异只有 ~0.3ms（3%），与 43% 不是一个量级。
4. **SOLID 证明"滤镜的有无"才是强变量。**
   SOLID 关掉 `backdrop-filter` 后，K 从 0 到 648 全部恒定 8.33ms、0 长帧。
   而半径从 34px 到 10px 几乎什么都没改变。
   **机制解释**：Chromium 按半径对 backdrop 做降采样——半径越大，需要处理的像素越少；
   "半径变小"与"降采样变弱"两个效应在 10–34px 区间相互抵消。
   所以半径不是可以拿来做性能梯级的旋钮。

**结论**：`REDUCED = blur 10px` 降级为**历史设计**（记录留在第 21 节与第 9 节的引用里，不删除）；
正式定义改为 **`REDUCED = selective glass / reduced filtered area`**。
`Blur radius` 保留为**次要视觉参数**（REDUCED 下取 7–13px 做视觉一致性），不得作为性能主张的依据。

### 22.13 自动降级：冻结到 D1-06

**本轮不实现 FULL→REDUCED→SOLID 的自动性能触发链，并且把这条冻结到 D1-06。**
当前只允许两种切换方式：

- 用户在设置里**手动**选择三档（`.material-select`，产品正式控件）；
- 内部测试脚本按同一路径切换（用于本 ADR 的全部测量）。

冻结理由：①现有数据全部是 Chromium，Electron NOT VERIFIED、Windows NOT VERIFIED，
用不可代表的数字校准阈值等于把误差写进产品行为；②真实产品负载（≈7 个玻璃面）三档都是 120fps / 0 长帧，
**当前没有需要自动降级的场景**；③代表性数据到手前，任何"自动降级"都无法验收。

解锁条件（全部满足）：Electron 内跑完 `perf-product.mjs` 拿到真实分位数；Windows 复跑；
在**空载**主机上重跑一次基线（当前机 loadvar ≈ 8–10）。

### 22.14 未验证项与残余风险

| 项 | 状态 |
|---|---|
| Electron 内材质性能 | **NOT VERIFIED**。本机 Electron 44.3.0 的 GPU 进程起不来（sandbox `Operation not permitted`），窗口合成路径与 Chromium 不同 |
| Windows 平台 | **NOT VERIFIED**。未在 Windows 主机运行；Windows 走 mica/DWM，`backdrop-filter` 落地方式不同（D3 才验证） |
| Windows / macOS 一致性 | 本次改动**只用 CSS token 与选择器**，无平台分支，理论上两端同构；但"理论上"不算验证 |
| 大量真实窗口（≈10 个）下的过滤面积 | **待实测**。本轮 K=0 场景只有 3 个真实窗口 + 顶栏 + Dock + 胶囊。按 `filteredCount` 的规律，真实窗口数增加只会让 FULL 更贵、REDUCED 不变，但**该预测未实测** |
| 外接屏 / 多显示器 | NOT VERIFIED |
| WebContentsView 在档位切换时的状态 | NOT VERIFIED IN CHROMIUM（Chromium 里无此对象） |
| 本机外部持续负载 | loadavg 8–10 / 12 核，绝对数值高于空载环境，**不可与 D1-04 的绝对数直接比较**；相对比较靠同页交错 + 同轮配对 + 多轮重复保持有效 |

**测量可信度声明**：本轮所有数字在**同一天、同一台机、同一冻结代码版本**上取得（`src/styles.css`
在测量前最后一次修改为 hover 修复，之后未再改动）。三个口径（深色稳态 5 轮 / 深色冷启动 3 次 /
浅色 sanity 5 轮）各自内部可比；跨口径不可混用。

---

## 23. 复现命令

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
node experiments/d1-04/perf2.mjs             # 【历史口径】三档 × 四档负载，注入 CSS 模拟
node experiments/d1-04/light-bar-check.mjs   # 顶栏归零后的合成样式

# D1-04B 主题矩阵与材质档位
node experiments/d1-04/theme-matrix.mjs      # 六格矩阵 + computed 断言 + 像素断言
node experiments/d1-04/solid-bar-probe.mjs   # 深色 SOLID 顶栏取证（OA_TAG=before|tokenfix）
node experiments/d1-04/glass-tiers.mjs       # 三档 × 10 个面的材质矩阵
node experiments/d1-04/glass-switch.mjs      # 运行时切换 + 动效解耦
node experiments/d1-04/glass-switch-stress.mjs  # §22.11 21 轮 × 3 档切换压力
```

D1-04C 选择性玻璃（**切换产品状态，不注入材质值；同时记录过滤面数与过滤面积**）：

```bash
# 深色官方基线：稳态口径（同页交错 + 预热 + 拉丁方），5 轮 —— 第 22.7 节
OA_MODE=warm OA_THEME=dark OA_LAYOUT=scatter OA_KS=0,24,72,144 OA_REPEAT=5 \
  OA_OUT=perf-product-c-dark.json node experiments/d1-04/perf-product.mjs

# 深色官方基线：冷启动口径（每格独立新页面、无预热），3 次 —— 第 22.7 节
OA_MODE=cold OA_THEME=dark OA_LAYOUT=scatter OA_KS=0,24,72,144 OA_COLD_REPEAT=3 \
  OA_OUT=perf-product-c-dark-cold.json node experiments/d1-04/perf-product.mjs

# 浅色 sanity（K=24，5 轮）—— 第 22.10 节
OA_MODE=warm OA_THEME=light OA_KS=24 OA_REPEAT=5 \
  OA_OUT=perf-product-c-light.json node experiments/d1-04/perf-product.mjs

# 产物里看这三个字段：runs[].filteredCount / filteredArea / filteredCoverage 与顶层 filtered[]
```

> 命名说明：D1-04C 的正式产物统一带 `-c`（`perf-product-c-*.json`）。
> `perf-product-dark.json` / `-dark-cold.json` / `-light.json` 这三个旧名字在 D1-04C 被**重跑覆盖**过，
> 磁盘上现在装的是 D1-04C 数据；D1-04B 的数字以第 21 节的表格为准。
> `perf-product-dark-grid.json` 与 `-dark-saturation.json` 未被覆盖，仍是 D1-04B 原物。

```bash
# REDUCED 档视觉与层级取证
OA_GLASS=reduced OA_TAG=reduced-c node experiments/d1-04/contrast2.mjs  # REDUCED 对比度
node experiments/d1-04/reduced-color-probe.mjs   # 六格截图 + 几何
python3 experiments/d1-04/reduced_probe.py       # 窗口正文/标题条/桌面 众数色与层级差

# 实色面板上的行级 hover 回归（第 22.11 节）
node experiments/d1-04/reduced-hover-probe.mjs  # 六格 × 未 hover/已 hover 截图
python3 experiments/d1-04/hover_probe.py        # 众数色差与 ΔL*，六格必须都可辨
```

```bash
python3 experiments/d1-04/contrast_calc.py   # WCAG 对比度（改前/改后对照）
python3 experiments/d1-04/hier_calc.py       # 层级明度差（改前/改后对照）
python3 experiments/d1-04/flash_check.py     # 切换过渡期闪白/闪黑
```
