# D2-01 · OpenArc Design System v1

状态：**PARTIAL**
分支：`feature/d2-01-design-system`
基线：`74d4c21`（D1-06 技术 Gate + Boss 决策落定后的 HEAD）
范围纪律：本记录只交付**设计系统**。不碰窗口架构、不改 WebContentsView 组合、不做通知中心、
不做权限逻辑。凡未真实验证的，一律写 NOT VERIFIED。

---

## 1. 范围（Scope）

**做**：把 D1-04 验证过的视觉 / 材质 / 动效 / 无障碍决策，冻结成一套可供整个 OpenArc OS
复用的正式设计系统 —— token 架构、P0 基础组件、状态矩阵、页面状态规范、无障碍契约、
回归测试矩阵、ADR 交接。

**不做**（越界即违反本轮指令）：

| 不做 | 归属 | 原因 |
| --- | --- | --- |
| 重写 Window Manager | D2-02 | 本轮只定义 Window 组件的**视觉契约** |
| 改 WebContentsView 架构 / 决定 native BrowserWindow 组合 | D2-02 | 触碰窗口拓扑就跨了阶段 |
| 处理复杂窗口遮挡 | D2-02 | 同上 |
| 完整通知中心（持久化 / 历史 / 分组） | 后续 | 本轮只建 Toast 原语 |
| 真实权限判定 | D3-02 | Unauthorized 只冻结视觉与组件契约 |
| 自动材质降级（FULL→REDUCED→SOLID） | 未定 | 需 Electron 基线 + Windows 基线 + 空闲机重跑证据 |
| 迁移 `styles.css` 全部历史字面值 | 持续 | 目标是**减少** magic number，不要求一次性清零 |

**目录决策（指令 §16 允许二选一，这里给理由）**：使用 `src/design-system/`，
**不**新建 `packages/design-system/`。理由：当前是单包仓库，没有第二个消费者；
建包会引入构建/解析配置成本而无收益，且指令明确禁止"为了目录美观大规模搬迁"
与"创建空壳包"。触发条件写进 §20 交接：当出现第二个 npm 包或构建目标需要消费
设计系统时，再升级为 workspace 包。

---

## 2. D1 输入（本轮继承并冻结的既有决策）

| 来源 | 继承内容 | 是否改动 |
| --- | --- | --- |
| D1-04 | light/dark 主题、玻璃 full/reduced/solid、REDUCED = **选择性玻璃**（大面积转实色，非调小半径） | 不改，改为 token 化 |
| D1-04 | 动效 normal/reduced 与 `prefers-reduced-motion` | 补齐两条路径一致性 |
| D1-04 | 中性灰阶单色体系；禁用蓝色与彩色品牌强调；禁止发丝线框分层 | 不改，写成静态断言 |
| D1-04 | 标题/强调 500，正文/控件 400，禁 700 | 不改，token 化为 `--fw-*` |
| D1-04 | 极轻 elevation；深色顶部 inset 高光（材质厚度，不是边框） | 不改，收进 `--elevation-N` |
| D1-05 | 凭据不下发应用插件、密钥由后端凭据库保管 | 与组件层无交集 |
| D1-06 §23 | 治理：D1 = PARTIAL 与 CONDITIONAL GO 不冲突 | 不改，本节记录照此口径 |

**本轮对 D1-04 的唯一结构性改动**：把散落在 `styles.css` 里的自定义属性整层迁到
`src/design-system/tokens.css`，并把三条合成规则（下称 T1/T2/T3）写成显式契约与静态断言。

---

## 3. Token 架构

### 3.1 三条合成规则（本轮的核心机制）

D1-04B 修掉的 bug（深色拿到浅色合成色）在源码里"看起来对"，只在运行时会炸。
把它的**成因**抽象成三条不变量，就能在改 token 的那一刻拦住它：

| 规则 | 内容 | 违反后的症状 |
| --- | --- | --- |
| **T1** | 原料（`*-rgb` 通道 / `*-alpha` 透明度）声明在主题作用域；**主题作用域只改原料，绝不改已合成结果** | 改主题时部分面停在上一个主题的合成色 |
| **T2** | alpha 随玻璃档位变化的 token 必须在**消费点**合成（`rgb(var(--surface-rgb) / var(--surface-alpha))`），**绝不在 token 层合成**。`var()` 替换发生在声明元素上，继承下去的是已算好的值 | 切玻璃档位时表面不跟着变（拿到的是父级算好的固定值） |
| **T3** | 只随主题变化的 token（`text`/`muted`/`placeholder`/`line`/`accent`/`focus`/`failed`）可以在主题作用域合成，但**每个重新声明原料的作用域也必须重新声明合成值** | 深色下标题用浅色文字色 |

T2 与 T3 的分界是**"这个值会不会随玻璃档位变"**：会变的走 T2（消费点合成），
只随主题变的走 T3（作用域合成）。

⚠ **T3 的一个真实例外，必须知道**：`body` 位于 `.dark` 子树**之外**，
继承不到 `.dark` 作用域里的重定义。所以基底色用两个独立原料
（`--base-rgb` / `--base-dark-rgb`）配 `body:has(.dark)`。
这不是"忘了重声明"，而是"作用域根本够不着"。

### 3.2 单一权威

`tokens.css` 是唯一声明自定义属性的地方。组件层（`primitives.css` /
`page-states.css` / `gallery.css` / `styles.css`）**不得重声明任何 token 名** ——
同一个名字两个权威，改 token 不会生效。组件自有局部变量（如 `.dock-item { --s: 1 }`）
允许存在，仅登记不禁止。

规模：`:root` 92 个 token，`.dark` 覆盖 39 个。

### 3.3 三维正交

| 维度 | 属性 | 取值 | 改它**只能**影响 |
| --- | --- | --- | --- |
| 主题 | `class="dark"` / `:root` | light / dark | 颜色原料 |
| 玻璃 | `data-glass` | full / reduced / solid | 材质参数（alpha / filter） |
| 动效 | `class="reduced"` + 媒体查询 | normal / reduced | 时长 |

**任何一维都不得代偿另一维。** 三组探针各自独立验证正交性
（02 验主题×玻璃、05 验动效 vs 主题/材质/排版）。

---

## 4. 颜色（Color）

### 4.1 语义色原料

| token | light | dark | 用途 |
| --- | --- | --- | --- |
| `--text-rgb` | `29 29 31` #1d1d1f | `245 245 247` #f5f5f7 | 正文、标题、控件文字 |
| `--muted-rgb` | `110 110 115` #6e6e73 | `152 152 157` #98989d | 次要文字、图标、hint |
| `--placeholder-rgb` | `88 88 93` #58585d | `160 160 165` #a0a0a5 | placeholder（**独立一档**，见下） |
| `--surface-rgb` | `255 255 255` | `23 23 23` | 抬起表面基色 |
| `--content-rgb` | `255 255 255` | `23 23 23` | 实色内容面 |
| `--sunken-rgb` | `0 0 0` | `0 0 0` | 下沉面 / 内嵌槽 |
| `--bar-rgb` | `255 255 255` | `23 23 23` | 顶栏 / 标题栏 |
| `--pill-rgb` | `255 255 255` | `23 23 23` | AI 胶囊 |
| `--line-rgb` | `0 0 0` | `255 255 255` | 边界（用 alpha 表达） |
| `--accent-rgb` | `29 29 31` | `245 245 247` | 强调 = 中性体系里最深/最亮灰 |
| `--on-accent-rgb` | `255 255 255` | `0 0 0` | 强调面上的文字 |
| `--focus-rgb` | `29 29 31` | `255 255 255` | 焦点环 |
| `--failed-rgb` | `215 0 21` #d70015 | `255 69 58` #ff453a | 失败（配文字/图标，不单独依赖颜色） |
| `--base-rgb` | `245 245 247` | `0 0 0` | 页面 / 桌面基底 |
| `--base-dark-rgb` | `0 0 0` | — | 仅供 `body:has(.dark)` 使用（见 §3.1 例外） |

**为什么 placeholder 是独立一档（不是复用 `--muted`）**：搜索框是**下沉槽**，
表面用 alpha 合成、合成值随上下文浮动，实测浅色下为 `rgb(229,229,231)`。
`--muted` 落在上面只有 **4.03:1**，达不到 AA。表面会变、文字必须稳，所以该稳的是文字色。
取 `--muted` 再深一档后：浅色 7.02:1 / 深色 7.42:1（TextField），
5.73:1 / 7.25:1（SearchField）。这是 03 探针实测值，不是估算。

### 4.2 硬约束

- **中性灰阶单色体系**。禁止蓝色与任何彩色品牌强调。
- 红 / 绿 / 琥珀**只作极少语义色**，且必须配文字或图标，不得单独依赖颜色传达状态
  （error 字段同时带 `role="alert"` 文案）。
- 红黄绿三色属"平台约定例外"（交通灯），**不可反过来**当产品语义色用。
- 组件层零颜色字面值：`primitives.css` / `page-states.css` / `gallery.css` 已由静态断言强制。

---

## 5. 排版（Typography）

| 组 | token | 值 |
| --- | --- | --- |
| 字体族 | `--font-ui` | `-apple-system` → SF Pro → PingFang SC → Microsoft YaHei UI，**不打包字体** |
| | `--font-mono` | `ui-monospace` → SF Mono → Menlo → Consolas |
| 字号 | `--fs-display / title / heading / body / secondary / caption / micro / eyebrow` | 27 / 21 / 14 / 14 / 13 / 12 / 11 / 10 px |
| 字重 | `--fw-regular / medium / bold` | 400 / 500 / **500**（`--fw-bold` 是语义别名，映射到 500） |
| 行高 | `--lh-tight / normal / relaxed` | 1.25 / 1.5 / 1.7 |
| 字距 | `--tracking-tight / normal / wide` | -0.02em / 0 / 2px |

- **品牌字体不得扩散到系统 UI**。Space Grotesk / Inter / Poppins 等只允许出现在品牌展示位；
  静态断言会拦（`--font-ui` 里出现任一品牌字体即 FAIL）。
- 禁用浏览器默认 bold(700)：`--fw-bold` 直接映射 500，从命名上堵住误用。
- `-webkit-font-smoothing: antialiased`，`font-synthesis: none`。

---

## 6. 间距（Spacing）

4pt 刻度：`--space-1/2/3/4/5/6/8` = 4 / 8 / 12 / 16 / 20 / 24 / 32 px。

目标明确是**减少 magic number，不要求全仓一次性清零**。`styles.css` 里仍有历史值，
属迁移欠账（见 §19），不假装已清零。

---

## 7. 圆角（Radius）

| token | 值 | 用途 |
| --- | --- | --- |
| `--radius-xs` | 4px | 内联编辑框 |
| `--radius-sm` | 6px | badge / tooltip / 菜单项 |
| `--radius-md` | 8px | 输入框 / 列表行 / 小控件 |
| `--radius-lg` | 12px | 卡片 |
| `--radius-xl` | 16px | 面板 |
| `--radius-window` | 16px | 窗口外壳 |
| `--radius-pill` | 999px | 胶囊 / 圆点 |

**禁止新建 17px / 19px / 23px 这类 magic radius。** 组件层（含 gallery）
不得出现字面 px 圆角，由静态断言强制。

---

## 8. 材质（Material）

每个表面**一条完整滤镜**，而不是 `blur()` + `saturate()` 拼接 ——
这样 reduced 能真正去掉 saturate（写成 `saturate(1)` 视觉等价但仍会保留一条滤镜链、
仍要付合成成本）。

| token | FULL（light 基线） | 适用 |
| --- | --- | --- |
| `--glass-filter` | `blur(40px) saturate(1.8)` | 通用浮层 / 输入槽 / Toast |
| `--glass-filter-window` | `blur(34px) saturate(1.8)` | 窗口外壳与标题条 |
| `--glass-filter-pill` | `blur(32px) saturate(1.8)` | AI 胶囊 |
| `--glass-filter-dock` | `blur(44px) saturate(1.8)` | Dock |
| `--glass-filter-tip` | `blur(24px) saturate(1.8)` | tooltip |

**四条分层底线**：

1. **层级优先靠 surface / material / brightness / position**，不靠阴影。
2. **禁止用 border 或发丝线体系分层**。边界用 `inset 0 0 0 1px` 的 box-shadow 或 alpha 表达。
   静态断言禁止组件层出现 `border: 1px`（除 `transparent` / 0）。
3. **elevation 保持极轻**。断言禁止 >80px 模糊、禁止非 inset 且 alpha >0.5 的投影。
4. 深色下的顶部 inset 高光是**材质厚度**，不是边框，已烘焙进 `--elevation-N`，
   消费方只写 `box-shadow: var(--elevation-2)`。

---

## 9. 动效（Motion）

| token | 值 | 说明 |
| --- | --- | --- |
| `--dur-quick` | 160ms | 状态反馈 |
| `--dur-standard` | 220ms | 常规进出 |
| `--dur-slow` | 320ms | **仅必要时**，当前未使用 |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | 常规进出 |
| `--ease-spring` | `cubic-bezier(0.3, 0, 0.4, 1)` | Dock 弹跳 |

硬要求：**功能不能依赖动画结束**。任何 `transitionend` 回调都不得作为状态推进的唯一路径 ——
否则 reduced 下功能会卡死。05 探针用"0ms 内是否已到终态"验证这一点。

---

## 10. 高度（Elevation）

`--elevation-0 … --elevation-5`（另 `--elevation-card-hover`、`--shadow` 兼容别名）。
浅色为极轻投影；深色逐档重定义，并把顶部 `inset 0 1px 0` 材质高光**并进同一个值**。

**分层的第一手段不是 elevation，而是 surface / material / brightness / position。**
elevation 只在需要"离开平面"时使用，且必须保持极轻。

---

## 11. 组件契约（Component Contracts）

### 11.1 P0 基础组件（本轮正式建立）

| 组件 | 关键 props | 契约要点 |
| --- | --- | --- |
| `Button` | `variant`(primary/secondary/ghost/danger) `size`(sm/md) `status`(idle/loading/success/error) `full` `iconStart/iconEnd` | `loading` 时 `aria-busy` **且不触发 onClick**；`disabled` 时 `disabled` 属性成立 |
| `IconButton` | `label`（**必填**）`variant` `size` `pressed` `status` | 纯图标按钮的唯一可读名；`pressed` 存在时渲染为 toggle（`aria-pressed`） |
| `TextField` | `label`（必填）`hint` `error` `status` `readOnly` `disabled` `required` `labelHidden` `prefix/suffix` | label 恒有（可 sr-only）；hint+error 都进 `aria-describedby`；error 用 `role="alert"`；**error 与 readonly 互斥** |
| `SearchField` | `value` `onValueChange` `onClear` `placeholder` `kbd` `label` | `type="search"`；内建清除键；**Esc 只清内容且不吞事件**（外层面板仍能用 Esc 关自己） |
| `Tooltip` | `content` `placement`(top/bottom/left/right) `disabled` | **hover 与键盘 focus 都打开** + `aria-describedby` 指到它。三件事缺一不算完成 |
| `Badge` | `tone`(neutral/success/warning/danger) `size` | tone 只允许系统语义色，**不许引入品牌彩色** |
| `ScrollArea` | `maxHeight` `label` | 可聚焦 + `role="region"` + 方向键可实际滚动 |
| `Surface` | `material`(glass/solid/none) `level`(0-5) `radius` `padded` `large` | `large` 是**显式选择加入大面积白名单**（见 §17） |
| `Toast` | `kind`(info/success/warning/error/progress) `title` `description` `duration` `dismissLabel` | 见 §11.2 |

### 11.2 Toast / 通知原语

D1-04 里 Toast = MISSING。本轮**只建设计系统层能力**，不做通知中心。

| 项 | 规则 |
| --- | --- |
| `info` / `success` | `role="status"` + `aria-live="polite"`（不打断用户） |
| `warning` / `error` | `role="alert"` + `aria-live="assertive"` |
| `progress` | **恒为常驻**（进度条自动消失会让用户错过结果） |
| `duration: number` | 自动关闭 |
| `duration: null` | 常驻，只能手动关。**"未提供"与"显式 null"必须分开判断**（见 §19 bug 5） |
| 容器 | `role="region"` + `aria-label="通知"` |
| 关闭 | 每条独立关闭（不是"一次全关"）；按钮是真实 `<button>` + `aria-label`，可 Tab 到达；焦点在通知上时 **Esc 关闭该条** |

### 11.3 桌面端视觉契约（本轮**只定义视觉契约**，不实现组件）

`TopBar` / `TrafficBar` / `Dock` / `DockItem` / `DockTooltip` / `Window` / `TitleBar` /
`WebViewport` / `AddressBar` / `ContextMenu` / `AssistantPill` / `AIPanel`。

这些在 gallery 的 `?view=desktop` 里以**产品真实类名**渲染成可探测的样例
（`.topbar` `.traffic-bar` `.assistant-pill` `.window` `.window-title` `.window-body`
`.dock` `.dock-item` `.dock-tooltip` `.context-menu` `.search-shade` `.search-panel`
`.search-result` `.ai-panel` `.connection-card` `.app-card` `.resize`），
供探针验证视觉与材质行为。

**本轮不做**：把这些做成 React 组件、定义完整 props API、重写其实现。
**为什么**：它们全部依赖窗口/面板拓扑，属 D2-02。现在把它们组件化会必然触碰
窗口架构，违反范围纪律。**这不算已完成**，写进 §20 交接。

---

## 12. 组件状态（Component States）

**只设计默认态视为未完成。** 状态清单按组件族**分别定义**，不是一套套所有组件：

| 族 | 状态 |
| --- | --- |
| 按钮族 | default / hover / active / focus-visible / disabled |
| 输入族 | empty / hover / filled / error / readonly / focus-visible / disabled |
| 异步 | idle / loading / success / error |

**为什么输入族不列 `active`**：给文本输入塞一个"按下"态不是真实交互，
属虚假完备。输入族用 `filled` 承载"有内容"，这才是用户真正感知的状态。
同理 **empty 与 filled 的差别由内容承载**（placeholder → value），
不靠给 box 加一条描边；硬造 box 差异是"为测试而设计"。
探针改为验证 placeholder 与正文有色差、且 placeholder 对合成背景达 AA。

### 12.1 禁用（disabled）的正确判据

`<button disabled>` 的 `tabIndex` IDL 属性**仍返回 0**（它是内容属性的反射），
**不能**用来判断可聚焦性。唯一可靠判据是**真的试着聚焦一次**，看焦点有没有落上去。

同理 `aria-disabled` 对原生控件是冗余的：原生 `disabled` 属性即权威。
断言写的是"**原生控件**：`disabled` 属性成立；**复合控件**：必须补 `aria-disabled`"，
而不是一刀切要求两者都有。

### 12.2 focus-visible 的验证方法

必须用**真实 Tab 键**触发。程序化 `el.focus()` 在 Chromium 里不保证匹配
`:focus-visible`，用它验焦点环会得到假阴性（05 探针第一版就踩了这个坑）。
Tab 只做**一次前向遍历**顺路记录所有目标，不做 N×tabbables 次。

---

## 13. 页面状态（Page States）

七种状态。**不允许自己发明第八种。**

| 状态 | 何时用 | role / live | 动作 | 需要真实失败原因 |
| --- | --- | --- | --- | --- |
| Empty | 已成功拿到结果，但结果集为空 | status / polite | 无 | 否 |
| Loading | 仍在等**首屏**数据（局部刷新用骨架，不用它） | status / polite | 无 | 否 |
| Error | 请求失败且**可重试** | alert / assertive | 重试 | **是** |
| Unauthorized | 身份或对象权限不足 | alert / assertive | 去登录 | **是** |
| Offline | 网络不可达；**与 Error 的区别是可自动恢复**，所以给"重新连接"而非"重试" | status / polite | 重新连接 | 否 |
| Unavailable | 功能在当前环境不可用（平台不支持 / 能力未就绪 / 被策略关闭） | status / polite | 无 | 否 |
| Partial Result | 部分成功：有数据可用，但**有明确缺失项要告知** | status / polite | 重试 | **是** |

- 每种状态都有**文字标题**，不靠图标单独表达语义。
- `Partial Result` 必须列出缺失项（这是它存在的理由）。
- 只有 Error 与 Unauthorized 用 `alert` —— 别把普通空态做成打断式播报。

### 13.1 Unauthorized 的边界（必须说清）

⚠ **真实权限判定依赖 D3-02。** 本轮冻结**只有视觉与组件契约**：
什么时候显示、显示什么、给谁看。**不接任何权限逻辑。**

- 在 D3-02 完成前，Unauthorized **只能由显式传入的 `kind` 触发**，
  不允许由任何"当前用户是谁"的判断自动推出。
- **不传 `onAction` 时不画任何动作按钮** —— 探针专设样例验证这一点，
  防止"假装权限流程已接通"。
- 传了 `onAction` 才画"去登录"，此时它只是视觉示范。

---

## 14. 无障碍（Accessibility）

### 14.1 冻结的最低标准

| 项 | 要求 | 验证方式 |
| --- | --- | --- |
| 对比度 | WCAG AA —— 正文 4.5:1，大字号 3:1 | 02 / 03 探针按**合成后的有效背景**逐目标实测 |
| 键盘可达 | 所有交互元素 Tab 可达 | 03 真实 Tab 遍历 |
| 焦点可见 | `:focus-visible` 命中，`outline: 2px solid var(--focus)` + `offset 2px` | 03 / 05 实测计算值 |
| 焦点顺序 | **不得有 `tabindex > 0`**（会打乱自然顺序） | 04 全页扫描 |
| 可读名 | 每个 `<button>` 要么有可见文本、要么有 `aria-label` | 04 全页扫描 |
| Esc | 覆盖层可退出（本轮：Toast 可用 Esc 关闭焦点所在那一条） | 04 实测 |
| Enter / Space | 原生 `<button>` 语义保障 | 由语义元素承担，不自行模拟 |
| ARIA 关联 | `aria-describedby` 必须指向**真实存在**的元素 | 04 检查 id 可解析 |
| 减弱动效 | 见 §16 | 05 |
| 玻璃不得降低可读性 | 对比度按**合成后有效背景**判定（沿祖先链 alpha 合成，不是取父元素背景） | 02 六格 × 6 文本目标 |

### 14.2 明确未验证

**对话框焦点陷阱 + 焦点返回 = NOT VERIFIED。**
D2-01 的 P0 清单里没有 Dialog / Modal，也没有真正的覆盖层组件
（ContextMenu 本轮只有视觉契约）。**不为了让清单好看而临时造一个 Dialog** ——
那是虚假完备。该项绑定 D2-02，届时必须验证。

---

## 15. 平台差异（macOS / Windows）

跨平台设计，**允许平台行为差异，但共享视觉与语义**：

| 共享（必须一致） | 允许差异（平台约定例外） |
| --- | --- |
| 颜色 / 材质层级 | macOS 交通灯 vs Windows 窗口控件 |
| 排版 / 间距 / 圆角刻度 | 窗口控制按钮的位置与形态 |
| 组件状态语义 | 原生菜单 / 系统对话框 |
| 无障碍契约 | 键位映射（⌘ vs Ctrl） |

红黄绿三色属"平台约定例外"（DESIGN_SYSTEM 3.1），**不可反过来**用于产品语义的成功/失败/警告。

⚠ **Windows 视觉保真度 = NOT VERIFIED。** 本机为 macOS，全部探针证据只覆盖 macOS + Chromium。
Windows 的 mica、字体回退（Microsoft YaHei UI）、窗口控件、多显示器全部未验证。
**不得**把 macOS 的探针结论外推为"双端已一致"。

---

## 16. 减弱动效（Reduced Motion）

**两条触发路径，必须走同一套结果**：

| 路径 | 触发方式 |
| --- | --- |
| ① 产品内开关 | 根节点 `.reduced` 类 |
| ② 系统级设置 | `@media (prefers-reduced-motion: reduce)` |

只把 `--dur-*` 归零**不够**。spinner 与进度条的可见性靠 `animation` 而非
`transition-duration`；只停动画不做**结构性替代**，用户看到的是"卡住的半圈"
和"永远填不满的进度条" —— 是"坏了"，不是"安静了"。

因此两条路径都要：
1. 归零 `--dur-quick / standard / slow`；
2. `*` 级兜底 `animation: none !important` + `transition-duration: 0ms !important`；
3. 结构性静态替代：spinner 停转后是**四边同色的完整圆环**；进度条 `width: 100%` + `opacity: .5` 仍可见。

**媒体查询里没法加类，所以第 3 项的声明必须写两遍 —— 两遍必须逐条一致。**
这个约束由静态断言强制（比较两条路径的声明集合，数量与取值都要对齐），
不靠人记。运行时另有 05 探针直接比较两条路径的 computed `transition-duration`。

`reduced` **不等于禁用**：点击、焦点环、可读性在 reduced 下必须照旧成立，探针逐项验证。

---

## 17. 玻璃模式（Glass Modes）

| 档位 | 语义 | 机制 |
| --- | --- | --- |
| FULL | 完整玻璃 | 各面自带完整滤镜；`--glass-filter-large` **未定义** |
| REDUCED | **选择性玻璃**：大面积表面转实色，小尺寸系统 chrome 保留玻璃 | `--glass-filter-large: none` 是开关 |
| SOLID | 全实色，无模糊 | 唯一允许覆盖 RGB 通道的档位（无模糊 → 基础色必须等于其下方实际合成的桌面颜色，否则出现亮度带） |

### 17.1 REDUCED = 减面积，不是减半径

性能杠杆是**被 backdrop-filter 覆盖的总面积与表面数量**，不是模糊半径
（半径在 10–34px 之间几乎无影响，因为 Chromium 会下采样 backdrop）。
D1-04C 已定案，本轮只是 token 化，**不回到"34px → 10px = 性能优化"**。

**大面积白名单机制**：判据是"引用 `--glass-filter-large` 的选择器即白名单"。
白名单必须**显式登记**，当前为：

```
.window  /  .ai-panel  /  .search-panel  /  .ds-surface--large
```

静态断言双向强制：① 出现未登记引用 → FAIL；② 白名单条目无人引用（腐烂成死名字）→ FAIL。
禁止 `.desktop[data-glass="reduced"] *` 这类全局规则。

⚠ **档位属性是子树级，不是桌面级。** 选择器是 `[data-glass="..."]` 而**不是**
`.desktop[data-glass="..."]` —— 否则任何非桌面子树（含 gallery 自己）档位完全不生效。
这是本轮探针抓到的真实 bug（见 §19 bug 2）。

### 17.2 自动材质降级仍被禁止

**不得**出现 FULL→REDUCED→SOLID 自动触发，直到
①Electron 基线 ②Windows 基线 ③空闲机器重跑 三者都有证据。
**仅允许**手动选择 + 内部测试切换。

---

## 18. 测试

### 18.1 探针矩阵

| 探针 | 判定对象 | 断言 | 结论 |
| --- | --- | --- | --- |
| `01-token-contract` | 静态契约（不需浏览器）：T2 / T3、单一权威、刻度、字面值、发丝线、大面积白名单、两条 reduced 路径一致 | 26 | PASS |
| `02-theme-glass-matrix` | 6 格 × (primitive 视图 + desktop 视图)：主题通道、玻璃语义、正交性、对比度 AA | 32 | PASS |
| `03-component-states` | 五态矩阵、焦点环、placeholder 可读性、禁用语义+行为学、loading 抑制点击 | 56 | PASS |
| `04-keyboard-a11y` | Tab 可达、ARIA 关联、Tooltip 键盘可见、Toast 播报与 Esc、ScrollArea 方向键、页面状态规范 | 33 | **PARTIAL**（含 1 条 NOT VERIFIED） |
| `05-motion-matrix` | normal / reduced(类) / reduced(系统) 三路径：时长、终态一致、即时到达、spinner 替代、正交性、reduced≠禁用 | 18 | PASS |
| 合计 | | **166 通过 / 0 失败 / 1 NOT VERIFIED** | |

入口：`npm run test:design-system`（先 build 再串行跑 5 个探针）。
产物：`artifacts/d2-01/*.json`（gitignore），含环境、逐条用例、实测值表。

### 18.2 永久回归基线（不得删除）

**D1-04 的 `theme-matrix` 保留为永久回归基线**，入口 `npm run test:theme-baseline`。
它验证的是**像素值**（六格窗口内容取样 + computed style），比 D2-01 的断言更底层。
本轮 token 整层搬迁后它逐格重现，**连像素值都与 D1-04 完全一致** ——
这是"抽层没有改变任何行为"的最强证据。

### 18.3 三层测试的分工

| 层 | 命令 | 测什么 |
| --- | --- | --- |
| 纯逻辑 | `npm test` | 几何/纯函数，7 通过 |
| 设计系统 | `npm run test:design-system` | 渲染后的计算值与行为 |
| 视觉基线 | `npm run test:theme-baseline` | 像素值与 computed style |

**核心方法论**：判定基于**渲染后的计算值、行为与像素**，不是源码文本。
静态断言（01）只用来锁"成因类不变量"（T2/T3、白名单、字面值、两条路径一致），
因为这些问题在源码里"看起来对"。

---

## 19. 已知限制（Known Limitations）

### 19.1 本轮探针抓出的真实缺陷（已修，附反证）

| # | 缺陷 | 成因 | 修复 | 反证 |
| --- | --- | --- | --- | --- |
| 1 | 通用小 `Surface` 与 `Toast` 在 REDUCED 下**失去玻璃** | 它们引用了大面积开关 `--glass-filter-large`，被误当作大面积表面 | 改用基础 `--glass-filter`；新增大面积**显式选择加入**的 `Surface large` | 新增静态白名单断言 + 02 的 large/小面对照断言 |
| 2 | 玻璃档位**在任何非桌面子树上完全不生效** | 选择器写成 `.desktop[data-glass=…]`，而档位属性是子树级 | 改为 `[data-glass=…]`（5 处） | 修复前六格全渲染出 `blur(40px)`、9 个过滤面 |
| 3 | `SearchField` **没有 hover 态** | 与 `TextField` 对同一基本状态的判断不一致 | 补 `.ds-search:hover` + transition | 03 的"empty/hover 可区分"断言 |
| 4 | `SearchField` 的 placeholder **根本没接 token**，落到浏览器 UA 默认灰 | 漏写 `::placeholder` 规则；UA 灰不受主题切换影响 | 补 `::placeholder`；新增 `--placeholder-rgb` 独立一档 | 实测浅色 3.66:1 / 深色 4.16:1（均不达 AA）→ 修复后 5.73 / 7.25 |
| 5 | 显式 `duration: null`（常驻）的通知被**静默改成 4000ms 自动关闭** | `t.duration ?? 4000` 中 `??` 把显式 `null` 当作"未提供" | 分开判断"未提供"与"显式 null" | 04 的"4.6s 后仍在"断言 |
| 6 | 系统级 Reduce Motion 下 spinner 是**卡住的半圈** | 结构性替代只绑了 `.reduced` 类，媒体查询那侧缺失 | 媒体查询里补同组声明 | 反证：隔离系统级路径后 spinner 断言红 |
| 7 | 系统级 Reduce Motion 下**硬编码时长的组件仍会播放** | 媒体查询缺 `transition-duration: 0ms !important` 兜底，而产品内开关有 | 补齐兜底，两条路径逐条对齐 | 断言实测 `0s` vs `0s, 0s, 0s` |
| 8 | 基底色**没有 token**，`#f5f5f7` / `#000` 在两个文件里各一份 | 基底色不参与玻璃叠加，建立 token 时被漏掉 | 新增 `--base-rgb` / `--base-dark-rgb` | 静态断言禁止这三处再出现字面值 |

### 19.2 本轮探针自身的缺陷（同样是"看起来对"）

| # | 缺陷 | 后果 | 修正 |
| --- | --- | --- | --- |
| a | 输入类指纹打在 `<input>` 上 | 输入框自身透明，得到"三态无差异"**假阳性** | 指纹改打在承载表面的 box 上 |
| b | 用程序化 `el.focus()` 验焦点环 | Chromium 不匹配 `:focus-visible` → **假阴性** | 改真实 Tab 触发 |
| c | reduced 系统级路径的 URL 也带了 `motion=reduced` | `.reduced` 类**遮蔽**了系统级路径 → "两条路径一致"断言**空转**，连 bug 6 都测不出来 | URL 用 `motion=normal` + `emulateMedia` 隔离；并加"隔离守卫"断言防止再退化 |

一条断言从未失败过不算证据。§19.1 的 6 / 7 与 §18 的白名单一致性断言
都做过**受控反证**（临时删掉修复，确认断言变红，再恢复）。

### 19.3 未覆盖 / 未验证

| 项 | 状态 | 绑定 |
| --- | --- | --- |
| 对话框焦点陷阱 + 焦点返回 | **NOT VERIFIED** | D2-02 |
| Windows 视觉保真度（mica / 字体回退 / 窗口控件 / 多显示器） | **NOT VERIFIED** | Windows 机器到位 |
| 真实设备 / 高 DPI / 多显示器下的对比度 | NOT VERIFIED | 同上 |
| 屏幕阅读器实测（VoiceOver / NVDA） | NOT VERIFIED（只验证了 ARIA 结构与关联，未做真人/真 SR 实测） | 后续 |
| 桌面端 12 个组件只有视觉契约，**不是可用组件** | 未实现（有意） | D2-02 |
| `ContextMenu` 不可交互（只有视觉契约） | 未实现（有意） | D2-02 |
| 自动材质降级 | **禁止**，非未完成 | 见 §17.2 |

### 19.4 迁移欠账（诚实计数，不假装已清零）

`styles.css`（898 行，产品历史样式）：

| 项 | 现状 |
| --- | --- |
| 圆角声明 | 22 处：1 处 token 化，3 处百分比（圆形，本就不属刻度），18 处字面值 |
| └ 其中**在刻度上**只是没换 token | 10 处（4/6/8/12×2/16×2 px）→ 机械替换即可 |
| └ 其中**不在刻度上** | 8 处：`7px`×2、`9px`×1、`10px`×3、`20px`×1、`30px`×1 → **需设计判断**，不是纯机械改 |
| 颜色字面值 | 75 次出现 / 48 个不同值（多为玻璃与桌面环境光的合成值） |
| 硬编码 transition 时长 | **0 处**（已全部走 token） |

**注意**：组件层（`src/design-system/`）已由断言强制零颜色字面值、零字面圆角、
零 1px 边框分层。欠账集中在 `styles.css` 的产品历史样式。
本轮目标只是**减少** magic number，不要求一次性清零；`styles.css` 的迁移
与桌面组件组件化一起做（同一批文件、同一批改动）更划算。

---

## 20. D2-02 交接

D2-02 必须处理以下事项，**本轮明确未做**：

1. **桌面端 12 个组件的真组件化**：`TopBar` / `TrafficBar` / `Dock` / `DockItem` /
   `DockTooltip` / `Window` / `TitleBar` / `WebViewport` / `AddressBar` / `ContextMenu` /
   `AssistantPill` / `AIPanel`。本轮只冻结视觉契约（真实类名 + 可探测样例）。
   **禁止**在 D2-02 之前自行发明这些组件的 props API。
2. **对话框焦点陷阱 + 焦点返回**（本轮 NOT VERIFIED）。
   同时需覆盖：焦点陷阱边界、`inert` 背景、关闭后焦点返回触发元素。
3. **窗口/面板遮挡与层级**：D1-01 已确认 WebContentsView 恒定绘制在 DOM 之上、
   DOM z-index 对它无效，遮挡只能靠检测后 `setVisible(false)`。任何覆盖 UI 的设计
   都要先考虑这条。
4. **动效的 `transitionend` 审查**：D2-02 引入窗口进出动画时，
   必须确保没有任何状态推进依赖动画结束（§9 硬要求）。
5. **设计系统升级为 workspace 包**的触发条件：出现第二个 npm 包或构建目标时。
   在此之前继续用 `src/design-system/`。
6. **`styles.css` 迁移**：与桌面组件组件化同批进行，优先清 8 处非刻度圆角。

**D2-01 不得被描述为"设计系统已完成"**：它是 PARTIAL —— 桌面端组件未组件化、
对话框无障碍未验证、Windows 未验证。

---

## 21. 证据（Evidence）

### 21.1 环境

- macOS 26.6.2（Darwin 25.6.0）ARM64，Apple M3 Pro
- Node `v22.22.2`，Chromium（Playwright，`chromium-1228`）
- ⚠ 渲染引擎是 **Chromium，不是 Electron**。设计系统的计算值/对比度证据在两者间
  应等价，但**玻璃合成与原生 vibrancy 的最终观感仍需 Electron 侧确认** ——
  Electron 侧证据见 D1-04 的 `matrix_pixels.py` 与 `npm run test:native`。

### 21.2 产物

| 文件 | 内容 |
| --- | --- |
| `artifacts/d2-01/01-token-contract.json` | 26 条静态契约 + token 规模 |
| `artifacts/d2-01/02-theme-glass-matrix.json` | 12 格（6 primitive + 6 desktop）实测背景/滤镜/对比度 |
| `artifacts/d2-01/03-component-states.json` | 每组件五态指纹、焦点环、placeholder 实测色与对比度、点击计数 |
| `artifacts/d2-01/04-keyboard-a11y.json` | Tab 遍历、ARIA 关联、Toast 时序、页面状态 role/live |
| `artifacts/d2-01/05-motion-matrix.json` | 三条动效路径的时长/终态/spinner 实测 |

产物被 gitignore；本文记录的是**判定与口径**，原始实测值在产物里可复核。

### 21.3 复现

```bash
npm test                          # 纯逻辑 7 通过
npm run test:design-system        # 5 个探针：166 通过 / 0 失败 / 1 NOT VERIFIED
npm run test:theme-baseline       # D1-04 像素基线，逐格重现
npm run build                     # tsc --noEmit + vite build（含 design-system.html 第二入口）
```

### 21.4 关键实测数字（供事后对比，防口径漂移）

| 指标 | 实测 |
| --- | --- |
| REDUCED 过滤面数 | primitive 视图 10 → 9（只有 `Surface large` 转实色）；desktop 视图 `.window`/`.ai-panel`/`.search-panel` 全部 `none` |
| SOLID 过滤面数 | 0（六格全部） |
| 对比度最低值 | 浅色 4.66:1（caption+muted+micro）／深色 6.16:1（error），全部 ≥ 4.5 |
| placeholder 对比度 | 7.02 / 5.73 / 7.42 / 7.25:1 |
| 状态矩阵 | 56 条全通过；点击计数 `{ok:1}`（loading 与 disabled 均为 0） |
| 动效 | normal `160ms/220ms`；两条 reduced 路径 computed `transition-duration` 均为 `0s` |

---

## 22. 结论

**Task Status: PARTIAL**

设计 token 架构 / P0 基础组件 / 三维状态矩阵 / 页面状态规范 / 无障碍契约 /
回归测试矩阵**已真正达到稳定基线**（166 条断言通过，D1-04 像素基线逐格重现）。

**不判 PASS 的原因**（不掩盖、不折价）：

1. 桌面端 12 个组件**只有视觉契约**，尚未组件化（依赖 D2-02 窗口拓扑）；
2. 对话框焦点陷阱 + 焦点返回 **NOT VERIFIED**（本轮无 Dialog 组件，拒绝临时造一个充数）；
3. Windows 视觉保真度 **NOT VERIFIED**（无 Windows 机器）；
4. `styles.css` 存在明确计量的迁移欠账（8 处非刻度圆角 + 75 次颜色字面值）。

**"当前 UI 已经很好看了"不是 PASS 条件。** 上述四项都是可复现、可计量的缺口，
不是主观判断。
