# OpenArc OS 前端设计系统汇总

- 取证时间：2026-10-14
- 取证版本：`git rev-parse HEAD` = `128e21da472ecc2defa83ae2982303407aad5fe6`
- 工作树有未提交改动，本文按当时工作树内容取证；另有改动在进行中，行号以取证当时为准，引用前请复核。
- 引用格式：`文件名:行号`。文件名省略目录时指：`tokens.css` / `primitives.css` / `primitives.tsx` / `page-states.css` / `page-states.tsx` / `gallery.tsx` 在 `src/design-system/`；`styles.css` 指 `src/styles.css`；`DESIGN_SYSTEM.md`、`MOTION_SYSTEM.md`、`PLAN.md` 在项目根；`DESIGN_LANGUAGE_1.0.md` 在 `docs/plans/`；`FRONTEND-ARCHITECTURE-MAPPING.md` 在 `docs/`；`Ds*.vue` 在 `src-vue/design-system/`；壳层 `.vue` 在 `src-vue/shell/`。

---

## 1. 一页看懂

### 1.1 设计方向

- **Apple 式磨砂玻璃 + 中性灰阶单色**：整体只用黑白灰，层次靠明度差、留白、阴影和玻璃材质建立（`DESIGN_SYSTEM.md:8`、`DESIGN_SYSTEM.md:17`）。
- **禁蓝**：不用任何彩色品牌强调色，蓝色一律不用，包括链接蓝、焦点蓝、渐变蓝、壁纸蓝（`DESIGN_SYSTEM.md:18`、`DESIGN_SYSTEM.md:97`）。
- **禁发丝线框**（发丝线框 = 1px 细描边当作分层手段）：卡片、面板、菜单、通知、窗口默认不描边，深色下禁止浅色半透明"玻璃描边"（`DESIGN_SYSTEM.md:104-109`）。唯一例外是输入框等控件边界，允许 1px（`DESIGN_SYSTEM.md:110`）。
- **红黄绿只用于两处**：① 状态语义色（失败红、成功绿、警告琥珀），且必须配文字或图标（`DESIGN_SYSTEM.md:88-94`）；② 窗口与顶栏的红黄绿窗口按钮，沿用系统色 `#FF625B / #FFBF3E / #2BC94E`，不得借用来表达产品语义（`DESIGN_SYSTEM.md:98-101`）。
- 主操作用近黑 / 近白实心块，不用彩色底（`DESIGN_SYSTEM.md:19`）。
- 字重只有 400 和 500，禁止 600 以上与浏览器默认 bold（`DESIGN_SYSTEM.md:153-155`、`tokens.css:57-59`）。

### 1.2 各文档的地位

| 文件 | 版本 / 日期 | 地位 | 依据 |
| --- | --- | --- | --- |
| `src/design-system/tokens.css` | "Design System v1" | **代码里唯一的 token（token = 集中定义的设计值变量）权威**，页面与组件不得自己发明颜色、圆角、间距、时长、阴影 | `tokens.css:2`、`tokens.css:5-6`；Vue 侧同样以它为准：`FRONTEND-ARCHITECTURE-MAPPING.md:32`、`main.ts:6` |
| `DESIGN_SYSTEM.md` | 设计提案 0.2，2026-09-10 | 现行设计规范（色彩、材质、字体、尺寸、可访问性、验收 DS-A01–A09） | `DESIGN_SYSTEM.md:3`、`DESIGN_SYSTEM.md:264-274` |
| `MOTION_SYSTEM.md` | 动效提案 0.1，2026-09-10 | 现行动效规范（时长曲线、中断、减少动效、验收 MS-A01–A09） | `MOTION_SYSTEM.md:3`、`MOTION_SYSTEM.md:184-194` |
| `docs/plans/DESIGN_LANGUAGE_1.0.md` | 1.0 草案，2026-10-09 | **待用户确认的草案**。原话："待用户确认的设计决定稿。确认后取代 `DESIGN_SYSTEM.md` 0.2 中与本文冲突的条目，并据此修订 `src/design-system/tokens.css`"；并说明 DESIGN_SYSTEM 与 MOTION_SYSTEM "继续有效"，本文只在其上补齐 | `DESIGN_LANGUAGE_1.0.md:3`、`DESIGN_LANGUAGE_1.0.md:4`、`DESIGN_LANGUAGE_1.0.md:5` |
| `PLAN.md` §42 | — | **流程约束**：规定 DS / MS 两份文档负责什么、由哪些任务实现与验收。全文未提到 DESIGN_LANGUAGE 1.0（`grep -n 'DESIGN_LANGUAGE' PLAN.md` 无结果） | `PLAN.md:801-806` |
| `PLAN.md` §4 | — | 早期总体视觉要求，部分措辞已被 0.2 推翻（见冲突 20、29） | `PLAN.md:38-51` |
| `docs/FRONTEND-ARCHITECTURE-MAPPING.md` §3-4 | 2026-10-08 | Vue 迁移时 token 接入方式与取舍记录 | `FRONTEND-ARCHITECTURE-MAPPING.md:30-68` |

一句话：**写代码以 tokens.css 为准；讲设计意图以 DS 0.2 + MS 0.1 为准；DL 1.0 一旦用户确认，凡与 0.2 冲突处改按 1.0，再回改 tokens.css。**

---

## 2. 设计值速查表

说明：第二列是 `tokens.css` 当前实际值（权威）。"文档规定值（若不同）"一列只在文档写法与代码不一致时填写，留空表示一致或文档未规定。

### 2.1 颜色与表面（浅色 / 深色）

| token | 浅色 | 深色 | 文档规定值（若不同） |
| --- | --- | --- | --- |
| `--base-rgb` 桌面基底 | 245 245 247 = #F5F5F7（`tokens.css:101`） | 0 0 0（`tokens.css:238`；body 用 `--base-dark-rgb` `tokens.css:102`、`tokens.css:443-445`） | |
| `--surface-rgb` / `--surface-alpha` 窗口外壳 | 白 @ 0.68（`tokens.css:84`、`tokens.css:104`） | #171717 @ 0.5（`tokens.css:239`、`tokens.css:250`） | 浅色 DS 写"白色 68—80%"（`DESIGN_SYSTEM.md:46`），落在范围内 |
| `--content-rgb` / `--content-alpha` 内容区 | 白 @ 0.94（`tokens.css:85`、`tokens.css:105`） | #171717 @ 0.6（`tokens.css:240`、`tokens.css:251`） | 浅色 DS 表写 #FFFFFF 实色（`DESIGN_SYSTEM.md:47`），材质表写 94—100%（`DESIGN_SYSTEM.md:126`） |
| `--sunken` 凹槽 | 黑 @ 0.04（`tokens.css:86`、`tokens.css:106`） | 黑 @ 0.28（`tokens.css:241`、`tokens.css:252`） | 浅色 DS 写 #E8E8ED（`DESIGN_SYSTEM.md:49`），见冲突 7 |
| `--bar-rgb` / `--bar-alpha` 顶栏、Dock | 白 @ **0**（`tokens.css:87`、`tokens.css:110`） | #171717 @ 0（`tokens.css:242`、`tokens.css:255`） | 浅色 DS 写白 58—72%（`DESIGN_SYSTEM.md:50`、`DESIGN_SYSTEM.md:129`），见冲突 3 |
| `--pill-rgb` / `--pill-alpha` AI 胶囊 | 白 @ 0.58（`tokens.css:88`、`tokens.css:111`） | #171717 @ 0.72（`tokens.css:243`、`tokens.css:257`） | |
| 浮起面板（toast / 菜单）`--toast-alpha` | 0.96（`tokens.css:204`） | 0.94（`tokens.css:271`） | DS 有 `surface.raised` #171717@72%（`DESIGN_SYSTEM.md:48`），token 无同名项 |
| `--accent` 主操作实心底 | #1D1D1F（`tokens.css:90`） | #F5F5F7（`tokens.css:245`） | |
| `--on-accent` 实心底上的字 | 白（`tokens.css:91`） | 黑（`tokens.css:246`） | |
| `--failed` 失败红 | #D70015（`tokens.css:93`） | #FF453A（`tokens.css:248`） | |
| 成功绿 / 警告琥珀 | **无 token** | **无 token** | DS 写 #0F7B34/#30D158、#8A4B00/#FFD60A（`DESIGN_SYSTEM.md:76-77`），见冲突 8 |
| `--hover-tint` 悬停抬亮 | 同 `--sunken`（`tokens.css:125`） | 白 @ 0.03（`tokens.css:269`） | |
| 窗口按钮红黄绿 | 不在 tokens.css | 同左 | `#FF625B / #FFBF3E / #2BC94E`，无窗口时 `rgba(125,125,125,0.5)`（`DESIGN_SYSTEM.md:100-101`） |
| 桌面环境光 `--shell-wallpaper-glow` / `-edge` | 0.85 / 0.05（`tokens.css:226-227`） | 0.03 / 0.03（`tokens.css:289-290`） | DS 上限：径向渐变白 ≤3%、装饰球 ≤2.2%（`DESIGN_SYSTEM.md:120`） |
| 遮罩 `--shell-scrim` | 0.28（`tokens.css:228`） | 0.5（`tokens.css:291`） | |

### 2.2 文字

| token | 浅色 | 深色 | 文档规定值（若不同） |
| --- | --- | --- | --- |
| `--text` 正文 | #1D1D1F（`tokens.css:76`） | #F5F5F7（`tokens.css:235`） | |
| `--muted` 次级 | #6E6E73（`tokens.css:77`） | #98989D（`tokens.css:236`） | |
| `--placeholder` 占位 | #58585D（`tokens.css:83`） | #A0A0A5（`tokens.css:237`） | DS 浅 #86868B / 深 #6E6E73（`DESIGN_SYSTEM.md:65`），见冲突 4 |
| 禁用 | 不用颜色，用 `--disabled-opacity: 0.45`（`tokens.css:201`） | 同左 | DS 浅 #A1A1A6 / 深 #6E6E73（`DESIGN_SYSTEM.md:66`），见冲突 5 |

### 2.3 描边与焦点

| token | 浅色 | 深色 | 文档规定值（若不同） |
| --- | --- | --- | --- |
| `--line` 控件边界 | 黑 @ 0.12（`tokens.css:89`、`tokens.css:107`） | 白 @ 0.16（`tokens.css:244`、`tokens.css:253`） | DS `border.subtle`：#D2D2D7 @ 60% / 白 14%（`DESIGN_SYSTEM.md:69`），见冲突 6 |
| `--focus` 焦点环颜色 | #1D1D1F（`tokens.css:92`） | 白（`tokens.css:247`） | |
| 焦点环形状 | `outline: 2px solid var(--focus); outline-offset: 2px`，挂在 `:focus-visible`（`tokens.css:457-464`） | 同左 | DS 要求 2px 环 + 2px 间隔（`DESIGN_SYSTEM.md:111`、`DESIGN_SYSTEM.md:203`），一致 |
| 输入框焦点 | `.ds-field__box:focus-within` / `.ds-search:focus-within` 画同样外环（`primitives.css:198-201`、`primitives.css:290`）——`focus-within` 鼠标点击也会触发 | 同左 | DL D3 要求鼠标点击不出环（`DESIGN_LANGUAGE_1.0.md:20`、`DESIGN_LANGUAGE_1.0.md:142`），见冲突 31 |
| 深色材质顶部高光（不算描边） | — | 白 @ 0.12 / 活动 0.18（`tokens.css:195-196`） | DS 允许白 8%—18%（`DESIGN_SYSTEM.md:115`），一致 |

### 2.4 材质模糊（blur）

| token | full 值 | reduced 值 | 文档规定值（若不同） |
| --- | --- | --- | --- |
| `--glass-filter` 通用浮层 / 顶栏 | `blur(40px) saturate(1.8)`（`tokens.css:132`） | `blur(12px)`（`tokens.css:356`） | DS M2 浮层 32—44px，M3 桌面栏 36—48px（`DESIGN_SYSTEM.md:128-129`） |
| `--glass-filter-window` 窗口 | `blur(34px) saturate(1.8)`（`tokens.css:133`） | `blur(10px)`（`tokens.css:357`） | DS M1 24—34px（`DESIGN_SYSTEM.md:127`） |
| `--glass-filter-pill` AI 胶囊 | `blur(32px) saturate(1.8)`（`tokens.css:134`） | `blur(10px)`（`tokens.css:358`） | |
| `--glass-filter-dock` Dock | `blur(44px) saturate(1.8)`（`tokens.css:135`） | `blur(13px)`（`tokens.css:359`） | DS M3 36—48px |
| `--glass-filter-tip` 提示气泡 | `blur(24px) saturate(1.8)`（`tokens.css:136`） | `blur(7px)`（`tokens.css:360`） | |
| `--glass-filter-large` 大面积开关 | 未定义（`tokens.css:140`） | `none`（`tokens.css:364`） | |

所有 full 档滤镜都带 `saturate(1.8)`（saturate = 饱和度放大），见冲突 27。

### 2.5 圆角

| token | 值 | 文档规定值（若不同） |
| --- | --- | --- |
| `--radius-xs` | 4px（`tokens.css:146`） | DS 无此档 |
| `--radius-sm` | 6px（`tokens.css:147`） | DS 无此档 |
| `--radius-md` | 8px（`tokens.css:148`） | DS 小控件 8（`DESIGN_SYSTEM.md:179`） |
| `--radius-lg` | 12px（`tokens.css:149`） | DS 卡片 12 |
| `--radius-xl` / `--radius-window` | 16px / 16px（`tokens.css:150-151`） | DS 窗口 16 |
| `--radius-pill` | 999px（`tokens.css:152`） | |
| （缺） | — | DS 浮层 14、Dock 20（`DESIGN_SYSTEM.md:179`）；DL 再加应用图标 22.5%（`DESIGN_LANGUAGE_1.0.md:132`） |

### 2.6 间距

| token | 值 | 文档规定值（若不同） |
| --- | --- | --- |
| `--space-1/2/3/4` | 4 / 8 / 12 / 16px（`tokens.css:157-160`） | |
| `--space-5` | 20px（`tokens.css:161`） | DS 常用值不含 20（`DESIGN_SYSTEM.md:177`）；DL 含 20（`DESIGN_LANGUAGE_1.0.md:130`） |
| `--space-6` | 24px（`tokens.css:162`） | |
| `--space-8` | 32px（`tokens.css:163`） | |
| （缺） | — | DS、DL 都有 48（`DESIGN_SYSTEM.md:177`、`DESIGN_LANGUAGE_1.0.md:130`） |

### 2.7 字体、字号、字重、行高、字距

| token | 值 | 文档规定值（若不同） |
| --- | --- | --- |
| `--font-ui` | -apple-system … Microsoft YaHei, sans-serif（`tokens.css:39-42`） | 与 DS 字体栈一致（`DESIGN_SYSTEM.md:148-149`） |
| `--font-mono` | ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace（`tokens.css:43-45`） | DS 只列 ui-monospace / SFMono-Regular / Consolas / monospace（`DESIGN_SYSTEM.md:151`） |
| `--fs-display` | 27px（`tokens.css:47`） | DS 页面主标题 26（`DESIGN_SYSTEM.md:159`）；DL 28（`DESIGN_LANGUAGE_1.0.md:113`） |
| `--fs-title` | 21px（`tokens.css:48`） | DS 区域标题 17（`DESIGN_SYSTEM.md:160`）；DL 20（`DESIGN_LANGUAGE_1.0.md:114`） |
| `--fs-heading` | 14px（`tokens.css:49`） | DL 废弃，改 `--fs-headline` 15（`DESIGN_LANGUAGE_1.0.md:115`、`DESIGN_LANGUAGE_1.0.md:121`） |
| `--fs-body` | 14px（`tokens.css:50`） | DS 14/22（`DESIGN_SYSTEM.md:162`） |
| `--fs-secondary` | 13px（`tokens.css:51`） | DS 窗口标题、按钮 13/18（`DESIGN_SYSTEM.md:161`、`DESIGN_SYSTEM.md:163`） |
| `--fs-caption` | 12px（`tokens.css:52`） | DS 12/18（`DESIGN_SYSTEM.md:164-165`） |
| `--fs-micro` | 11px（`tokens.css:53`） | DS 无 11；DL 11/14（`DESIGN_LANGUAGE_1.0.md:119`） |
| `--fs-eyebrow` | 10px（`tokens.css:54`） | DL 废弃（`DESIGN_LANGUAGE_1.0.md:121`） |
| `--fs-clock` | clamp(58px, 12vh, 118px)（`tokens.css:55`） | DL 不变（`DESIGN_LANGUAGE_1.0.md:124`） |
| `--fw-regular` / `--fw-medium` / `--fw-bold` | 400 / 500 / 500（`tokens.css:57-59`） | 一致（`DESIGN_SYSTEM.md:153-154`） |
| `--lh-tight` / `--lh-normal` / `--lh-relaxed` | 1.25 / 1.5 / 1.7（`tokens.css:61-63`，比例值） | DS 写 px：34/24/18/22/18（`DESIGN_SYSTEM.md:159-165`）；DL 也写 px（`DESIGN_LANGUAGE_1.0.md:113-119`） |
| `--tracking-tight` / `normal` / `wide` | -0.02em / 0 / 2px（`tokens.css:65-67`） | DS 另有桌面大字 -0.06em（`DESIGN_SYSTEM.md:167`），无 token |

### 2.8 阴影 elevation 0–5（浅 / 深）

elevation = 表面"抬起高度"对应的阴影档位。

| token | 浅色 | 深色 | 文档规定值（若不同） |
| --- | --- | --- | --- |
| `--elevation-0` | none（`tokens.css:185`） | 未覆盖，同浅色 | |
| `--elevation-1` 卡片静置 | `0 1px 3px rgb(0 0 0/.08)`（`tokens.css:186`） | `inset 0 1px 0 高光, 0 2px 10px rgb(0 0 0/.45)`（`tokens.css:277`） | |
| `--elevation-2` 窗口静置 | `0 6px 20px rgb(0 0 0/.08)`（`tokens.css:187`） | `inset 高光, 0 18px 46px rgb(0 0 0/.7)`（`tokens.css:278`） | DS 窗口 `0 12px 40px` 黑 16%，深色试 28%（`DESIGN_SYSTEM.md:137`） |
| `--elevation-3` Dock | `0 8px 28px rgb(0 0 0/.15)`（`tokens.css:188`） | `inset 高光, 0 8px 28px rgb(0 0 0/.5)`（`tokens.css:279`） | |
| `--elevation-4` 活动窗口 / 浮层面板 | `0 12px 40px rgb(0 0 0/.16)`（`tokens.css:189`） | `inset 活动高光, 0 18px 46px rgb(0 0 0/.7)`（`tokens.css:280`） | 浅色与 DS 窗口值相同；深色 DS 28% |
| `--elevation-5` 上下文菜单 | `0 12px 32px rgb(0 0 0/.22)`（`tokens.css:190`） | `inset 高光, 0 18px 46px rgb(0 0 0/.7)`（`tokens.css:281`） | DS 浮层 `0 8px 24px` 黑 18%（`DESIGN_SYSTEM.md:138`） |
| `--elevation-card-hover` | 两层：`.08` + `0 8px 24px .05`（`tokens.css:191`） | 同 elevation-1（`tokens.css:282`） | |
| `--shadow` 兼容别名 | = elevation-4（`tokens.css:192`、`tokens.css:283`） | | |

### 2.9 动效时长与缓动

| token | 值 | 文档规定值（若不同） |
| --- | --- | --- |
| （缺）instant | — | MS `duration.instant` 0ms（`MOTION_SYSTEM.md:21`） |
| `--dur-feedback` | 100ms（`tokens.css:169`） | MS 100（`MOTION_SYSTEM.md:22`） |
| `--dur-quick`（别名 `--quick`） | 160ms（`tokens.css:170`、`tokens.css:176`） | MS 160（`MOTION_SYSTEM.md:23`） |
| `--dur-standard`（别名 `--standard`） | 220ms（`tokens.css:171`、`tokens.css:177`） | MS 220（`MOTION_SYSTEM.md:24`） |
| （缺）spatial | — | MS 300ms（`MOTION_SYSTEM.md:25`） |
| `--dur-slow` | 320ms（`tokens.css:172`），注释称"目前未使用"（`tokens.css:166`） | MS 无 slow，有 long 380 上限（`MOTION_SYSTEM.md:26`）；最小化 / 恢复 320ms（`MOTION_SYSTEM.md:59-60`） |
| `--ease-standard`（别名 `--ease`） | cubic-bezier(0.2, 0, 0, 1)（`tokens.css:173`、`tokens.css:178`） | MS 一致（`MOTION_SYSTEM.md:27`） |
| `--ease-spring` | cubic-bezier(0.3, 0, 0.4, 1)，注释"Dock 弹跳"（`tokens.css:174`） | MS 弹簧用语义名 `motion.spring.gentle`、参数待校准（`MOTION_SYSTEM.md:31-32`） |
| （缺）exit | — | MS cubic-bezier(0.4, 0, 1, 1)（`MOTION_SYSTEM.md:28`） |
| （缺）linear | — | MS linear（`MOTION_SYSTEM.md:29`） |

### 2.10 壳层 `--shell-*` 尺寸与 z 层序

z 层序 = 谁盖在谁上面的叠放顺序，数字大的在上。

| token | 值 | 文档规定值（若不同） |
| --- | --- | --- |
| `--shell-icon` | 20px（`tokens.css:212`） | |
| `--shell-icon-lg` | 32px（`tokens.css:213`） | |
| `--shell-dock-icon` | 48px（`tokens.css:214`） | DL Dock 图标 48（`DESIGN_LANGUAGE_1.0.md:240`）；DL 桌面图标 64（`DESIGN_LANGUAGE_1.0.md:238`） |
| `--shell-launchpad-tile` | 96px（`tokens.css:215`） | |
| `--shell-titlebar` | 36px（顶栏与窗口标题条同高，`tokens.css:216`） | DL 顶栏 28（`DESIGN_LANGUAGE_1.0.md:237`），窗口标题栏 36（`DESIGN_LANGUAGE_1.0.md:150`） |
| `--shell-control-tile` | 40px（`tokens.css:217`） | |
| `--shell-z-wallpaper` | 0（`tokens.css:218`） | |
| `--shell-z-desktop` | 10（`tokens.css:219`） | |
| `--shell-z-window` | 20（`tokens.css:220`） | 实际 Vue 窗口写 `zIndex: 10 + win.z`（`WindowLayer.vue:29`） |
| `--shell-z-overlay` | 30（`tokens.css:221`） | |
| `--shell-z-launchpad` | 40（`tokens.css:222`） | |
| `--shell-z-control-center` | 50（`tokens.css:223`） | |
| `--shell-z-dock` | 60（`tokens.css:224`） | |
| `--shell-z-quicklook` | 70（`tokens.css:225`） | |
| （缺）菜单 / 模态 / 锁屏 | — | DS 逻辑层：桌面、普通窗口、活动窗口、临时菜单、模态、系统锁屏（`DESIGN_SYSTEM.md:196`）；DL 锁屏在所有层之上（`DESIGN_LANGUAGE_1.0.md:242`） |

现场发现：`--shell-*` 目前只被 `src-vue/pages/Welcome.vue:100-109` 用到（`--shell-control-tile`、`--shell-icon`）；8 个 `--shell-z-*` 没有任何消费方，`styles.css` 里的 z-index 全是字面值（见第 5 节）。

### 2.11 玻璃三档 full / reduced / solid

| 档位 | 改什么 | 关键值 |
| --- | --- | --- |
| full（基线） | 不加规则，各面自带完整玻璃（`tokens.css:294-295`） | 见 2.4 |
| reduced（减少透明度的"选择性玻璃"） | 小面积 chrome 保留薄玻璃；窗口 / AI 面板 / 搜索面板转实色（`tokens.css:336-352`、`tokens.css:364`）；注释明确禁止把 reduced 解释为"半径变小=性能优化"（`tokens.css:334`） | 浅色 alpha：surface .9 / content 1 / bar .22 / pill .8（`tokens.css:366-369`）；深色：surface .72 / content 1 / bar .22 / pill .94（`tokens.css:372-379`） |
| solid（全实色） | 唯一允许改 RGB 通道的档；所有子元素 `backdrop-filter: none !important`（`tokens.css:297-299`、`tokens.css:324-327`） | 浅色 surface #F5F5F7、content #FFF、bar #E9E9EC（`tokens.css:302-309`）；深色 surface #0C0C0C、content #0E0E0E、bar / pill #000000（`tokens.css:313-322`） |

### 2.12 减少动效

| 项 | 值 |
| --- | --- |
| 产品内开关 `.reduced` | 四档时长全归 0ms，`animation: none`、`transition-duration: 0ms`（`tokens.css:388-399`） |
| 系统级 `prefers-reduced-motion` | 与 `.reduced` 逐条对应，含兜底清零（`tokens.css:402-420`） |
| 硬要求 | 功能不能依赖动画结束（`tokens.css:386-387`）；MS 同要求（`MOTION_SYSTEM.md:145-146`） |
| 文档规定值（若不同） | MS 允许"即时切换或不超过 100ms 淡变"（`MOTION_SYSTEM.md:145`），代码选择全部 0ms |

---

## 3. 组件清单

### 3.1 React 基础组件（primitives，`src/design-system/primitives.tsx`）

| 组件 | 定义位置 | 主要参数 / 状态 | 被谁引用（不含 gallery 与本文件内部） |
| --- | --- | --- | --- |
| Button | `primitives.tsx:42` | variant primary/secondary/ghost/danger，size sm/md，status idle/loading/success/error（`primitives.tsx:56-57`、`primitives.tsx:27`）；高度 md 30px、sm 24px（`primitives.css:53-60`） | `page-states.tsx:24`、`src/device/DevicePane.tsx`、`src/governance/{CanvasApp,FilesApp,GovernanceApp,ProjectsApp,ResourcePicker}.tsx`、`src/mcp/McpCenter.tsx`、`src/resource/ResourceLibraryApp.tsx`、`src/settings/ModelSettings.tsx` |
| IconButton | `primitives.tsx:97` | variant ghost/secondary/primary/danger，size sm/md（`primitives.tsx:110-111`） | 仅内部（SearchField 清除键 `primitives.tsx:274`、Toast 关闭 `primitives.tsx:558`）与 gallery |
| TextField | `primitives.tsx:151` | label、hint、error、status、readOnly、prefix / suffix、labelHidden；成功态显示 ✓（`primitives.tsx:209-213`） | `src/mcp/McpCenter.tsx` |
| SearchField | `primitives.tsx:236` | 内建清除键（用 IconButton）、kbd 快捷键提示、Esc 只清空不吞事件 | `src/resource/ResourceLibraryApp.tsx` |
| Tooltip | `primitives.tsx:292` | hover + 键盘 focus 都显示，aria-describedby 关联 | 仅 gallery |
| Badge | `primitives.tsx:346` | tone neutral/success/warning/danger，size sm/md；success / warning 实际是灰底（`primitives.css:373-380`），sm 用 `--fs-eyebrow`（`primitives.css:365`） | `src/device/DevicePane.tsx`、`src/mcp/McpCenter.tsx` |
| ScrollArea | `primitives.tsx:368` | 可聚焦滚动区域，role=region | 仅 gallery |
| Surface | `primitives.tsx:393` | material glass/solid/none，level 0–5，radius，large（参与 reduced 白名单） | 仅 gallery |
| Toast（ToastProvider / ToastViewport / useToast） | `primitives.tsx:450-520` | kind info/success/warning/error/progress；默认 4000ms 自动关闭，progress 与 duration=null 常驻（`primitives.tsx:497-498`） | 仅 gallery |

**PageState（`page-states.tsx`）**：7 种状态 empty / loading / error / unauthorized / offline / unavailable / partial-result（`page-states.tsx:26-33`），每种有 role、播报级别、默认动作和 `requiresCause`（是否必须有真实失败原因才能用，`page-states.tsx:36-53`）。引用方：`src/authorization/ProtectedResourceFixture.tsx`、`src/device/DevicePane.tsx`、`src/mcp/McpCenter.tsx`、gallery。

### 3.2 桌面壳部件（高层概览）

- React（`src/desktop/components.tsx`）：TopBar（`:92`）、DockTooltip（`:158`）、OrbIcon（`:261`）、DockItem（`:317`）、Dock（`:379`）、FolderIcon（`:469`）、TitleBar（`:505`）、Window（`:552`）、WebViewport（`:740`）、AddressBar（`:763`）、AssistantPill（`:792`）、AIPanel（`:820`）、ContextMenu（`:1121`，带子菜单）。Dialog 在 `src/desktop/Dialog.tsx:46`。这些属于"桌面壳"，**不在** primitives 里。
- Vue（`src-vue/shell/`）：Wallpaper、Desktop、Dock、Launchpad、WindowLayer、ControlCenter、Overlays、QuickLook（与上游 8 模块同名，`FRONTEND-ARCHITECTURE-MAPPING.md:21`），另有 TopBar、Orb、FolderIcon。壳层 `.vue` 均无 `<style>` 块，外观全部来自 `styles.css` 的既有类（如 `Dock.vue:27`、`FolderIcon.vue:4`）。

### 3.3 Vue 设计系统组件（`src-vue/design-system/Ds*.vue`）

Vue 组件**不自带样式**：都复用 `src-vue/main.ts:6-9` 引入的 `tokens.css`、`primitives.css`、`page-states.css`、`styles.css`，class 名与 React 版一一对应。

| 组件 | 对齐的 React 来源 | 被谁引用 |
| --- | --- | --- |
| DsButton | Button（`DsButton.vue:5`） | `src-vue/apps/{FilesApp,GovernanceApp,McpCenter,McpCenterDialogs,ProjectsApp,ResourceLibraryApp,ResourcePicker}.vue`、`src-vue/settings/{DevicePane,ModelSettings}.vue`、`DsPageState.vue:3` |
| DsBadge | Badge（`DsBadge.vue:3`） | `src-vue/apps/McpCenter.vue`、`src-vue/settings/DevicePane.vue` |
| DsTextField | TextField（`DsTextField.vue:5`） | `src-vue/apps/McpCenterDialogs.vue` |
| DsSearchField | SearchField（`DsSearchField.vue:3`） | `src-vue/apps/ResourceLibraryApp.vue` |
| DsPageState | PageState（`DsPageState.vue:6`） | `src-vue/apps/McpCenter.vue`、`src-vue/settings/DevicePane.vue` |
| DsDialog | 桌面壳 `src/desktop/Dialog.tsx`（`DsDialog.vue:6`） | `src-vue/apps/McpCenterDialogs.vue`、`src-vue/apps/ResourceLibraryApp.vue`、`src-vue/settings/AppearancePane.vue` |
| DsContextMenu | 桌面壳 ContextMenu（`DsContextMenu.vue:5`） | `src-vue/settings/AppearancePane.vue` |

引用清单由 `grep -rlE "import DsX\b|<DsX\b" src-vue` 与 `grep -rn 'design-system/primitives"' src` 现场得出。

### 3.4 React ↔ Vue 对照与缺口

| React | Vue | 缺口 |
| --- | --- | --- |
| Button | DsButton | 无 |
| IconButton | **缺** | DsSearchField 里手写了一个 `.ds-iconbtn` 按钮代替（`DsSearchField.vue:47-58`） |
| TextField | DsTextField | 缺 prefix / suffix（React `primitives.tsx:161-162`、`primitives.tsx:196`、`primitives.tsx:214`）；缺成功态 ✓（React `primitives.tsx:209-213`，Vue 只有 loading `DsTextField.vue:71`） |
| SearchField | DsSearchField | 清除键非组件复用（见上） |
| Tooltip | **缺** | — |
| Badge | DsBadge | 无 |
| ScrollArea | **缺** | — |
| Surface | **缺** | — |
| Toast | **缺** | — |
| PageState | DsPageState | 缺 `requiresCause`；role / live 用 if 判断写死（`DsPageState.vue:57-58`），不是 React 那张规格表（`page-states.tsx:36-53`） |
| （桌面壳）Dialog | DsDialog | React 属桌面壳，不在 primitives；Vue 放进了 design-system 目录 |
| （桌面壳）ContextMenu | DsContextMenu | 同上；Vue 版去掉了子菜单（`DsContextMenu.vue:6`） |

---

## 4. 冲突与待拍板清单

"已一致"表示现场核对后已不存在冲突。本次取证 28 条既知冲突**全部仍存在**，另新增 29–32 四条现场发现。

| 编号 | 对象 | 文档说 | 代码现状 | 建议以谁为准 | 需用户拍板 |
| --- | --- | --- | --- | --- | --- |
| 1 | 字阶 | DS：主标题 26、区域标题 17（`DESIGN_SYSTEM.md:159-160`）；DL：28 / 20 / 15，并废弃 heading、eyebrow（`DESIGN_LANGUAGE_1.0.md:113-121`） | 27 / 21 / 14 / 10（`tokens.css:47-54`） | DL 1.0（确认后） | 是（DL D2） |
| 2 | 行高与大字距 | DS / DL 用 px 行高（`DESIGN_SYSTEM.md:159-165`、`DESIGN_LANGUAGE_1.0.md:113-119`）；DS 桌面大字 -0.06em（`DESIGN_SYSTEM.md:167`） | 行高是比例 1.25 / 1.5 / 1.7（`tokens.css:61-63`）；无 -0.06em token（`tokens.css:65-67`） | 文档改写为比例，或 token 补 px 档；-0.06em 若仍需则补 token | 否 |
| 3 | 浅色顶栏 / Dock 填充 | 白 58—72%（`DESIGN_SYSTEM.md:50`、`DESIGN_SYSTEM.md:129`） | 0（`tokens.css:109-110`，注释"与深色口径一致"） | 代码（已是用户口径"透明度 0"的延伸），文档同步 | 是（确认浅色也要 0） |
| 4 | 占位文字色 | #86868B / #6E6E73（`DESIGN_SYSTEM.md:65`） | #58585D / #A0A0A5（`tokens.css:83`、`tokens.css:237`），注释为对比度修正（实测 4.03:1 不达标，`tokens.css:78-82`） | 代码 | 否 |
| 5 | 禁用色 | #A1A1A6 / #6E6E73（`DESIGN_SYSTEM.md:66`） | 不用颜色，opacity 0.45（`tokens.css:198-201`、`primitives.css:116-117`） | 代码，文档改写 | 否 |
| 6 | border.subtle | #D2D2D7 @ 60% / 白 14%（`DESIGN_SYSTEM.md:69`） | `--line` 黑 12% / 白 16%（`tokens.css:107`、`tokens.css:253`） | 代码（需按 DS 3:1 要求实测确认，`DESIGN_SYSTEM.md:110`） | 否 |
| 7 | 浅色 sunken | #E8E8ED（`DESIGN_SYSTEM.md:49`） | 黑 4%（`tokens.css:86`、`tokens.css:106`） | 代码 | 否 |
| 8 | 成功 / 警告色 | 有 #0F7B34/#30D158、#8A4B00/#FFD60A（`DESIGN_SYSTEM.md:76-77`）；DL Badge 允许三种语义色（`DESIGN_LANGUAGE_1.0.md:286`） | tokens 只有 `--failed`（`tokens.css:93`、`tokens.css:248`）；Badge success / warning 实为灰底（`primitives.css:373-380`） | 先定是否真要绿 / 琥珀，再补 token | 是 |
| 9 | 圆角档 | 8/12/16/14/20（`DESIGN_SYSTEM.md:179`），DL 补 14、20（`DESIGN_LANGUAGE_1.0.md:132`） | 4/6/8/12/16/16/999，缺 14、20，多出 4、6（`tokens.css:146-152`） | 补 14、20；4、6 保留但写进文档 | 否 |
| 10 | 间距 48 | 有 48（`DESIGN_SYSTEM.md:177`、`DESIGN_LANGUAGE_1.0.md:130`） | 无（`tokens.css:157-163`） | 补 `--space-12: 48px` | 否 |
| 11 | 阴影数值 | 窗口 12/40/16%，深色 28%；浮层 8/24/18%（`DESIGN_SYSTEM.md:137-138`） | 静置窗口 6/20/.08（`tokens.css:187`）；菜单 12/32/.22（`tokens.css:190`）；深色普遍 18/46/.7（`tokens.css:278-281`） | 代码（深色注释说明了必须重阴影，`tokens.css:273`），文档同步 | 否 |
| 12 | 动效时长档 | instant 0 / spatial 300 / long 380（`MOTION_SYSTEM.md:21`、`MOTION_SYSTEM.md:25-26`） | 只有 feedback / quick / standard / slow 320（`tokens.css:169-172`） | 补 spatial 300；slow 320 写进 MS 或改名 | 否 |
| 13 | dur-slow 是否使用 | MS 最小化 / 恢复 320ms（`MOTION_SYSTEM.md:59-60`） | 注释"目前未使用"（`tokens.css:166`），但 `styles.css:236`、`styles.css:240`、`styles.css:2705`、`styles.css:2733` 都在用 | 修正注释 | 否 |
| 14 | exit / linear 缓动 | 有（`MOTION_SYSTEM.md:28-29`） | 无；`styles.css:236` 等处直接写 cubic-bezier 字面值 | 补 token | 否 |
| 15 | 弹簧 | 语义名 `motion.spring.gentle`、参数待校准（`MOTION_SYSTEM.md:31-32`）；Dock 悬停跟随"不加弹簧"（`MOTION_SYSTEM.md:66`） | 固定贝塞尔，注释"Dock 弹跳"（`tokens.css:174`） | MS；token 改名或改注释 | 否 |
| 16 | 顶栏高 | DL 28（`DESIGN_LANGUAGE_1.0.md:237`） | 36，且与窗口标题条同高（`tokens.css:216`） | 若采纳 DL，需拆成顶栏、标题条两个 token | 是 |
| 17 | 层序 | 菜单、模态、锁屏层（`DESIGN_SYSTEM.md:196`、`DESIGN_LANGUAGE_1.0.md:242`） | `--shell-z-*` 无这三层（`tokens.css:218-225`） | 补 token | 否 |
| 18 | 减少透明度时顶栏色 | 深色回落 #111111（`DESIGN_SYSTEM.md:59`） | solid 档深色 bar #000000（`tokens.css:317-320`，D1-04B 实测修正） | 代码，DS 未同步 | 否 |
| 19 | DS 内部矛盾 | `DESIGN_SYSTEM.md:72-75` 写深色层级 #262629/#2D2D30/#333336/#3A3A3E、标题栏叠白 5%；与 `DESIGN_SYSTEM.md:46-55` 的 #171717 按 alpha 分层、标题栏透明矛盾。第 3 节表格被引用块（`:54-62`）和段落（`:72-75`）截断，`:63-70`、`:76-78` 的行已脱离表头。另 `:140` 说减少透明度"保留边框"，与禁描边口径不一 | 代码按 #171717 alpha（`tokens.css:239-257`） | 删除 `:72-75`，修复表格 | 否 |
| 20 | PLAN §4 细边框 | "背景模糊、细边框、柔和阴影"（`PLAN.md:40`） | DS 禁发丝线框（`DESIGN_SYSTEM.md:104-109`） | DS；PLAN 措辞改掉 | 否 |
| 21 | 验收编号 | PLAN 写 DS-A01 至 DS-A08（`PLAN.md:803`） | DS 实有 A09（`DESIGN_SYSTEM.md:274`） | 改 PLAN | 否 |
| 22 | 版本标签 | tokens "v1"（`tokens.css:2`）、primitives "v1"（`primitives.tsx:2`）、DS 0.2（`DESIGN_SYSTEM.md:3`）、MS 0.1（`MOTION_SYSTEM.md:3`）、DL 1.0 草案（`DESIGN_LANGUAGE_1.0.md:3`） | 无统一版本对应表 | 拍板 DL 后统一编号 | 否 |
| 23 | 控件高 | DS 表单主控件 36（`DESIGN_SYSTEM.md:186`）；DL 32（`DESIGN_LANGUAGE_1.0.md:133`） | Button md 实为 30、sm 24（`primitives.css:55`、`primitives.css:59`），且是字面 px | DL 1.0（确认后）并进 token | 是（DL 列为 C6，`DESIGN_LANGUAGE_1.0.md:308`） |
| 24 | 窗口最小尺寸 | DS 560×400（`DESIGN_SYSTEM.md:191`）；DL 720×480（`DESIGN_LANGUAGE_1.0.md:137`） | 未进 token | DL 1.0（确认后） | 是 |
| 25 | 应用图标 | DS 保留 macOS 原生彩色（`DESIGN_SYSTEM.md:181-184`） | DL 改自有灰阶图标（`DESIGN_LANGUAGE_1.0.md:18`、`DESIGN_LANGUAGE_1.0.md:244-252`） | DL（涉及版权） | 是（DL D1） |
| 26 | 映射文档示例 | 示例写 `var(--radius-3)`（`FRONTEND-ARCHITECTURE-MAPPING.md:40`） | tokens 无 `--radius-3`（`tokens.css:146-153`） | 改文档为 `--radius-lg` 等 | 否 |
| 27 | 玻璃饱和度 | "玻璃层不得带色相"（`DESIGN_SYSTEM.md:133`） | 所有 full 档滤镜 `saturate(1.8)`（`tokens.css:132-136`），会放大背后内容的颜色 | 需实测是否违背；或在 DS 写明"saturate 只放大背景，不算玻璃自带色相" | 是 |
| 28 | 装饰球亮度 | 装饰球 ≤2.2%（`DESIGN_SYSTEM.md:120`） | 无 token，`styles.css:39` 写字面值 0.022 | 补 token | 否 |
| 29（新） | 玻璃降级口径 | PLAN："低性能设备可以降低模糊强度"（`PLAN.md:50`） | tokens 明确禁止把 reduced 定义为"半径变小=性能优化"，杠杆是面积（`tokens.css:330-334`） | 代码（有实测），PLAN 改措辞 | 否 |
| 30（新） | 壳层 token 未被消费 | tokens 注释：组件层只写 `var(--shell-*)`（`tokens.css:209-210`）；映射文档同规则（`FRONTEND-ARCHITECTURE-MAPPING.md:54`） | 只有 `Welcome.vue:100-109` 用到；`--shell-z-*` 无人用，`styles.css` z-index 32 处全为字面值；窗口层 `zIndex: 10 + win.z`（`WindowLayer.vue:29`）与 `--shell-z-window: 20` 不一致 | 以 token 为准，逐步接线 | 否 |
| 31（新） | 鼠标点击出焦点环 | DL D3：鼠标点击不出环（`DESIGN_LANGUAGE_1.0.md:20`、`DESIGN_LANGUAGE_1.0.md:142`） | 输入框用 `:focus-within` 画环，鼠标点也出（`primitives.css:198-201`、`primitives.css:290`） | DL 1.0（确认后） | 是（DL D3） |
| 32（新） | 已被 DL 废弃的字号仍在用 | DL 废弃 `--fs-heading`、`--fs-eyebrow`（`DESIGN_LANGUAGE_1.0.md:121`） | `primitives.css:271`、`primitives.css:365`、`page-states.css:22`、`styles.css:2088` 等、`Welcome.vue:53`、`Welcome.vue:114` 仍引用 | 拍板后迁移 | 随 D2 |

### 4.1 DL 1.0 待拍板 D1–D6（`DESIGN_LANGUAGE_1.0.md:14-23`）

| 编号 | 决定 | DL 建议 |
| --- | --- | --- |
| D1 | 应用图标换自有体系 | 换成"中性灰阶圆角方块底板 + 线性图形"，理由是 Apple 原生图标不能随产品发布（`:18`） |
| D2 | 字阶统一 7 级并收小 | 正文 14、页面标题 20、区域标题 15（`:19`） |
| D3 | 鼠标点击不出焦点环 | 只在 `:focus-visible`（键盘导航）显示 2px 中性环（`:20`） |
| D4 | 全局 AI 只有一个入口形态 | "助理浮层" + "对话"应用共用一套会话数据，不做第三种 AI 面板（`:21`） |
| D5 | 桌面小组件纳入首版 | 只做日期、天气、进行中任务 3 个（`:22`） |
| D6 | 界面状态文字只用中文 | 英文原值只放 `data-*` 属性给测试用（`:23`） |

---

## 5. 规范落地卫生

### 5.1 `src/styles.css` 硬编码统计（共 3978 行）

在项目根运行，`F=src/styles.css`：

| 类别 | 硬编码数 | 走 token 数 | 命令 |
| --- | --- | --- | --- |
| 十六进制颜色 | 62 处（55 行） | — | `grep -oE '#[0-9a-fA-F]{3,8}\b' $F \| wc -l`；`grep -cE '#[0-9a-fA-F]{3,8}\b' $F` |
| 字面 rgb()/rgba() | 101 处 | 70 处 `rgb(var(...))` | `grep -oE 'rgba?\([0-9 ,./]+' $F \| wc -l`；`grep -oE 'rgba?\(var\(' $F \| wc -l` |
| font-size 写 px | 71 行 | 91 行 | `grep -cE 'font-size:\s*[0-9.]+px' $F`；`grep -cE 'font-size:\s*var\(' $F` |
| border-radius 含 px | 26 行 | 79 行 | `grep -cE 'border-radius:[^;]*[0-9.]+px' $F`；`grep -cE 'border-radius:\s*var\(' $F` |
| z-index 字面值 | 32 行（取值 0–500，最大 `styles.css:2625` 的 500） | 0 行 | `grep -cE 'z-index:\s*-?[0-9]+' $F`；`grep -cE 'z-index:\s*var\(' $F` |
| box-shadow 含 px | 14 行 | 10 行（整条只写一个 `var(--x)`） | `grep -cE 'box-shadow:[^;]*[0-9]+px' $F`；`grep -cE 'box-shadow:\s*var\(--[a-z0-9-]+\)\s*;' $F` |

说明：按行统计，跨多行书写的 box-shadow 可能漏计；十六进制计数可能含注释里的色值。

### 5.2 设计系统层与 Vue 层

- 设计系统层基本干净：`primitives.tsx` 注释声明不写颜色 / 圆角 / 时长字面值（`primitives.tsx:8-9`），颜色全部走 `rgb(var(...))`。例外是尺寸类 px：Button 高 30 / 24（`primitives.css:55`、`primitives.css:59`）、IconButton 30 / 20（`primitives.css:130-135`）、Toast 宽 320（`primitives.css:480`）等。
- Vue 层基本干净：`src-vue/design-system/` 与 `src-vue/shell/` 无 `<style>` 块，无十六进制色与字面 z-index。例外：① `WindowLayer.vue:29` 的 `zIndex: 10 + win.z`，注释说明这是与既有实现对齐的 DOM 契约（`WindowLayer.vue:19`）；② 几何位置用内联 px（`Desktop.vue:82`、`Desktop.vue:96`、`Orb.vue:224`）；③ lucide 图标 `:size="数字"` 共 13 处。

### 5.3 自动化探针各测什么

`npm run test:design-system` 入口 `experiments/d2-01/run-all.mjs:17-23` 串行跑 5 个探针：

| 探针 | 测什么 | 测试对象 |
| --- | --- | --- |
| 01-token-contract | 静态解析 CSS 文本，检查 T1–T3 合成规则等不变量（不开浏览器） | 源文件 `tokens.css`、`primitives.css`、`styles.css`（`01-token-contract.mjs:13-17`） |
| 02-theme-glass-matrix | {浅,深}×{full,reduced,solid} 六格：主题通道、玻璃语义、正交性、WCAG AA 对比度 | `dist/design-system.html` |
| 03-component-states | 按钮族、输入族的 hover / active / focus-visible / disabled 等运行时状态 | 同上 |
| 04-keyboard-a11y | Tab 可达、Tooltip 键盘可见、ARIA 关联有效、Esc 可退、通知自动消失时长 | 同上 |
| 05-motion-matrix | reduced 只改时长不改终值、`.reduced` 与系统设置两条路径一致、功能不依赖动画结束 | 同上 |

运行时探针 02–05 都打开 `dist/design-system.html`（`experiments/d2-01/lib/ds.mjs:149`），即 React 版 gallery 构建产物。

`experiments/d1-04/theme-matrix.mjs` 是永久回归基线（`run-all.mjs:9-11`），需单独运行：在六格矩阵下打开 React 主应用 `dist/index.html`，对桌面、窗口、内容区、标题栏、顶栏、Dock、菜单、搜索、AI 九个面，同时比对 computed 颜色与截图像素（`theme-matrix.mjs:1-11`、`theme-matrix.mjs:25`）。

**结论：除 01 读源码 CSS 外，所有运行时探针只测 React 产物，不覆盖 Vue 入口 `vue.html` 与 `Ds*.vue` 组件。** Vue 侧的交互态也未做截图比对（`FRONTEND-ARCHITECTURE-MAPPING.md:120`）。

---

## 6. 建议后续顺序（仅建议）

1. **用户拍板**：DL 1.0 的 D1–D6，以及第 4 节标"需用户拍板"的冲突取舍（3、8、16、23、24、25、27、31）。
2. **统一 tokens.css 与文档**：按拍板结果改 tokens.css，同步修 DESIGN_SYSTEM.md（含删除 `:72-75`、修复第 3 节表格）、MOTION_SYSTEM.md、PLAN.md §4 与 §42、映射文档示例。
3. **补齐 Vue 缺失组件并加同等探针**：IconButton、Tooltip、ScrollArea、Surface、Toast；DsTextField 补 prefix / suffix 与成功态；DsPageState 补 requiresCause；让 02–05 探针也能对 Vue 产物运行。
4. **逐步清理 styles.css 硬编码**：先接 `--shell-z-*` 层序，再处理颜色、字号、圆角、阴影。
