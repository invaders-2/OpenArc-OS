# OpenArc OS 进度

更新日期：2026-09-10

最新确认：产品为运行在 Windows/macOS 上的完整独立桌面系统。UI 全局采用 Apple 半透明磨砂玻璃质感，组件与交互动效遵循 https://ui.spectrumhq.in/ 参考方向，覆盖登录、桌面、应用、文件、AI、Skill 和设置。详细要求已写入 PRODUCT.md。

已完成：明确 Windows/macOS 独立 AI 桌面工作台的产品方向，并将 Skill 市场与自定义 Skill 纳入首版范围。PRODUCT.md 已记录应用、MCP、Skill 的关系、局域网用户权限、设备执行边界，以及真实连接和演示的区分。

当前状态：桌面壳已可运行（D1 桌面外壳与玻璃设计系统已落地并通过构建），D1-01「桌面与原生视图」技术验证已执行，结论为 PARTIAL——macOS 侧主进程与原生视图 26/26 项实测通过，Windows 侧与 Playwright 驱动的 UI 侧验收未验证/被阻断。没有已连接的 Adobe 应用。Illustrator 官方 MCP 文档已作为依据；Photoshop 社区方案与魔搭具体条目仍需实际验证。

最新需求：API 在设置中统一配置，支持用户自定义并在所有接入应用中生效。内核 AI 指后端助手运行框架；DeepSeek Harness 为优先验证候选，尚未安装。已纠正将内核理解为单一模型的偏差，并写入 PRODUCT.md。

本轮完成：按“上一版仍不够详细”的反馈扩展 PLAN.md，加入页面状态、账号生命周期、任务级分工与前置、权限矩阵、接口提案、38 个场景验收、双平台包装、性能目标、恢复演练、风险责任及需求追溯。进一步加入整体架构、单机与局域网拓扑、唯一调度权威、AI 验证与纠错闭环、三张架构图及两条端到端实例。（历史记录：该轮确实只写文档。）

修订原则：后续计划必须写到任务级，每项明确任务 ID、前置、责任管理岗、交付证据及通过条件，避免仅罗列模块。修订记录见 CHANGELOG.md。

---

## D1 阶段状态（2026-09-10）

### 已落地代码（非文档）

- 桌面外壳：单 `BrowserWindow` + DOM 内窗口（打开/关闭/最小化/最大化/还原/拖拽/缩放），macOS `vibrancy: under-window`、Windows 11 `backgroundMaterial: mica`。
- 设计系统：中性灰阶单色体系，深色底 `#171717` 三档透明度（50/60/72），桌面纯黑 `#000000`，顶栏/Dock/标题栏填充透明度 0（仅保留 `backdrop-filter`）。
- 原生浏览器视图：`WebContentsView` 真实实例（非 iframe），隔离 partition `openarc-browser-d1`。
- 安全基线：`contextIsolation: true`、`nodeIntegration: false`、`sandbox`、`will-navigate` + `setWindowOpenHandler` + `setPermissionRequestHandler` + `will-attach-webview`、preload 仅经 `contextBridge` 暴露最小面。
- 新增 `electron/geometry.cjs` + `geometry.d.cts`：主进程与渲染进程共用的纯几何函数（窗口越界收敛、可见性判定、遮挡判定）。

### D1-01 验收结果：PARTIAL（不是 COMPLETE）

| 面 | 结论 | 证据 |
| --- | --- | --- |
| 桌面窗口（macOS） | PASS | 主进程实测：创建/显示/最小化/还原/最大化/取消最大化/setBounds/焦点互斥 |
| 原生 WebContentsView | PASS | 主进程实测：构造名、bounds、隐藏/显示、reload、独立 CDP target |
| 安全隔离（A13） | PASS | 实测渲染进程内 `window.openarc` 仅含白名单键，无 `require`/`process`/`ipcRenderer` |
| A05 多窗口/多屏还原可见 | PASS（单屏几何层） | `tests/geometry.test.mjs` 5/5；`clampAll` 在显示变化时收敛 |
| A12 菜单/UI 不穿透 | PASS（修复后） | 桌面右键菜单原先未进入原生视图可见性判定，已修 |
| Windows 平台 | NOT VERIFIED | 本机无 Windows 主机，mica/打包/窗口行为均未实测 |
| UI 侧端到端 | UNRESOLVED / NOT VERIFIED | Playwright Electron driver 与 Electron 44 / Chromium 152 / 本项目组合启动超时，**根因未确认**，版本兼容性仅为候选原因之一 |
| 运行时沙箱强制执行 | NOT VERIFIED | 本机 Chromium sandbox 初始化失败，需 `--no-sandbox --in-process-gpu` 才能起进程 |
| 物理多显示器插拔 | NOT VERIFIED | 本机单显示器 |
| `npm ci` / `npm install` / 官方源二进制 | AGENT EXECUTION ENVIRONMENT BLOCK | **不是已证实的 PROJECT FAILURE**，必须在普通终端或 CI clean clone 复验后才能定性 |
| D2-02 窗口/视图架构 | ARCHITECTURE DECISION REQUIRED | 只确认"原生视图在 renderer DOM 合成层之外，DOM z-index 无法覆盖"，方案未定、不提前锁定 |

完整证据与判定见 `docs/decisions/D1-01-desktop-native-view.md`。

### 本轮审计发现并修复的真实缺陷

1. **A12 穿透缺陷**：桌面右键菜单打开时原生浏览器视图未隐藏，网页会盖在菜单之上（原生视图永远绘制在 DOM 之上）。已把菜单状态并入可见性判定。
2. **窗口几何从未持久化**：`localStorage` 只存了主题/动效/不透明度/文件夹，没有窗口矩形，"还原"无内容可还原。新增 `oa-wins` + 启动时 clamping。
3. **显示器变化无处理**：新增 `display-added/removed/metrics-changed` 监听 + 越界窗口回拉 + 向渲染进程广播。
4. 窗口边界收敛逻辑原先散落在 `src/main.tsx`，已统一到 `electron/geometry.cjs` 并可被单测覆盖。
5. 浏览器占位文案与实际可见性不一致（隐藏时仍显示"已就绪"），已按真实状态输出。

### D1-01 未完成清单（保留，D1-06 前复查）

Windows Mica 实机、Windows 窗口行为、Windows 多显示器、macOS vibrancy 视觉、真实多显示器拔插、
高 DPI、圆角/遮挡、renderer sandbox 运行时、下载、permission、external protocol、`window.open` runtime、
UI E2E、GPU 性能 —— 共 14 项，均未取得证据。清单清空前 D1-01 状态恒为 **PARTIAL**，不得改判 PASS / COMPLETE。

### 下一步

1. 在 Windows 主机上执行 D1-01 未验证项，补齐双平台证据。
2. 定位 UI 侧启动超时的根因（最小复现 + 上游 issue），而非假定是版本不兼容。
3. 在支持 Chromium sandbox 的机器上验证运行时沙箱强制执行。
4. 在普通终端 / CI clean clone 中复验 `npm ci` / `npm install`，确认不是项目缺陷。
5. 出 D2-02 窗口与视图架构 ADR（候选方案均未锁定）。

说明：D1-01 PARTIAL 不阻止 D1-02 开始。真正禁止的是在 D1-01 ～ D1-05 未达关卡要求时宣布 D1-06 PASS。

### D1-02 Harness 技术验证（2026-09-11，结论 ACCEPT WITH CONDITIONS）

分支 `feature/d1-02-harness`。目标是回答"OpenArc 能不能控制 DeepSeek Harness"，不是"能不能聊天"。

- 候选：DeepSeek Harness（`dsh`）`0.1.5-rc.1`，MIT，developer preview。
- 一手证据：npm 元数据 + 随包 README + 真实安装（521 包 / 47s）+ 真实 ACP 探针。
- 探针 `experiments/harness/acp-probe.mjs` **10/10 通过**：ACP 握手、会话生命周期、
  挂自建假 MCP 工具（取证日志证实 Harness 真连上并枚举了工具）、cancel no-op、close。
- 关键结论：**应走 ACP 接入面**（唯一有 `session/cancel`），SDK JSON-RPC 没有取消方法。
- 八道门控：Gate 3/4/5/8 成立，Gate 1/2/6/7 为 PARTIAL 且有明确化解路径。
- 两个高危：**ACP 无鉴权**（`authMethods: []`）；**凭据无法与 agent 隔离**（官方自承）。
- 未验：端到端工具链路（无可用模型 Key）、Windows/Linux、`tools/call` 实际拦截。
- 完整判定见 `docs/decisions/D1-02-harness.md`。**不因本轮授权任何产品实现。**

### D1-04 组件、视觉系统与性能技术验证（2026-09-11，结论 PARTIAL）

分支 `feature/d1-04-design-performance`。完整 ADR：`docs/decisions/D1-04-design-performance.md`。

**状态：PARTIAL。** 剩余两条硬缺口：性能数字只在 Chromium 取得
（Electron 内 NOT VERIFIED）、Windows 平台未验证。
原第三条"REDUCED 档位只定义未实现"已由 **D1-04B** 关闭。

已达成：

- 组件基线 **ESTABLISHED**：20 Primitives + 11 Desktop 矩阵；现有 16 个组件逐个定级
  （IMPLEMENTED 14 / PLACEHOLDER 1 / MISSING 1）；P0 共 17 项，14 已实现、2 PARTIAL。
- 动效**可采用**：MS-A02（10× 快速开关无残留）、MS-A03 可打断性、A29（token 归零、
  动画移除、功能仍可用）全部实测通过。
- 对比度：浅色最低 4.86:1、深色最低 6.77:1，均过 WCAG AA。
- 性能方法冻结：负载单位为 420×300 玻璃面板，三档材质 × 四档负载。**关键修正——
  p50 与平均 fps 会被 120Hz vsync 截平，必须看 p95 与 >33ms 长帧数。**
  实测 FULL 在 24 层时 p95=16.3ms（压 60fps 线），72 层起出长帧；
  REDUCED 在 24 层 p95=9.2ms、144 层 0 长帧；SOLID 与层数无关。

**Spectrum UI 判定：REFERENCE ONLY，不引入任何源码。**
三条独立理由：① Spectrum 每个组件都依赖 Tailwind CSS + Motion，OpenArc 是无 Tailwind 的
纯 CSS token 体系，引入等于换样式范式（被禁止的大重构）；② 目录内混入第三方 MIT 源码
（Dynamic Island、Toast Stack 页面自述来自 beUI / beui.dev MIT），仓库级是 Apache-2.0 但
逐文件来源未审计；③ 其定位是 animation-ready SaaS 落地页，与桌面系统的克制动效方向相反。
仅允许把三条**写法**（switch 交互定义、motion values 只动 transform/opacity、toast 状态
morph 的 API 形状）写进规范，不抄源码。

**`feature/ui-light-bar-zero` 判定：ADAPT**（方向采纳，两处按实测修正后落地，分支不整体合并）。

- 修正一：`.opaque` 浅色 `--bar` 原值 `#f5f5f7` 不成立——实测顶栏处真实桌面 `#efeff1`、
  Dock 处 `#e4e4e8`，原值比桌面上限 244 还亮；改为中点 `#e9e9ec`，顶栏带差由约 9 级降到 2.0 级。
- 修正二：其新增的 `tests/visual-light-bar.mjs` 不进 `tests/`（该目录是 `node --test` 纯逻辑
  测试目录，脚本依赖 Playwright + 硬编码本地 chromium 路径），同类验证统一放 `experiments/d1-04/`。
- 深色未被破坏：8 个采样点改前改后像素完全一致，深色对比度 6.77:1 不变。

本轮修复的真实缺陷：**桌面右键菜单无法用 Esc 关闭**（`src/main.tsx`，Escape 分支漏
`setMenu(null)`，`.menu-shade` 继续拦截全部点击形成功能性陷阱）。已修，验证 1→0。

顺带发现（**未改，等确认**）：深色 `.opaque.dark --bar = #111111`，实测顶栏处真实桌面为
`#000000`，SOLID 档下会浮出 17 级亮带；建议改 `#000000`，但会触及已验收的深色观感。

D1-04 之后仍需：在 Electron 内重跑 perf2、Windows 复跑——两项都阻塞 D2-01。

### D1-04B 主题合成修复 + REDUCED 档落地（2026-09-11）

在实现 REDUCED 档的过程中暴露了一个**真实的架构缺陷**并已修复：

- **回归症状**：Dark + FULL 的窗口内容从 baseline `(20,20,20)` 变成 `(250,250,250)`。
- **根因**：颜色被拆成「通道 + alpha」两段原料，但合成结果 `--surface / --content /
  --bar / --pill` 写在了 `:root`。`var()` 在声明它的元素上就完成替换并继承下去，
  所以 `.dark` 再改通道已经不影响上层算完的结果——深色拿到了浅色的合成值。
- **修复**：`:root` 只存原料（`--surface-rgb` / `--content-rgb` / `--bar-rgb` /
  `--pill-rgb` + 各自 alpha + 每表面一条完整滤镜），**17 个消费点全部改为
  `rgb(var(--x-rgb) / var(--x-alpha))` 就地合成**。`:root` 里不再有任何算好的颜色。
- **三维正交**：Theme（`light/dark`）× Glass（`data-glass="full|reduced|solid"`）×
  Motion（`.reduced` 类）互不影响。材质档位**不复用** `.reduced`（它已表示 Reduce Motion）。

REDUCED 档已进入产品代码（不再是实验脚本注入）：

| 档位 | 滤镜 | 底色 alpha 补偿 |
|---|---|---|
| full | `blur(40/44/34/32/24px) saturate(1.8)` | 基线 |
| reduced | `blur(12/13/10/10/7px)`，**整条滤镜重写以真正去掉 saturate** | 浅色 +0.22，深色按各基线分别取值 |
| solid | 无 `backdrop-filter`，全实色 | alpha 1 |

同时按 Boss 确认把深色 SOLID 顶栏 `--bar` 由 `#111111` 改为 `#000000`
（实测深色桌面为纯黑，原值会浮出 17 级亮带）。

**验证结果**：
- 六格主题矩阵（light/dark × full/reduced/solid）**全 PASS**，10 个表面全部跟随 token。
- Dark FULL 逐点回到 D1-04 baseline，窗口内容 `(20,20,20)`；Light FULL / Light SOLID 同样逐点一致。
- 切换正确性：6 次往返，窗口数与矩形全部不变，无残留 class，过渡连拍无闪白/闪黑。
- Reduce Motion 与材质档位实测解耦（`motion=ON + full/reduced/solid` 三档均不改变动效设置）。
- 对比度无退化（浅色 4.86:1 / 深色 6.77:1）、`npm test` 7/7、UI 审计 20/27（与 D1-04 相同）。

新增防回归探针 `experiments/d1-04/theme-matrix.mjs` + `matrix_pixels.py`：
断言主题原料、computed 背景通道不跨主题、深色格窗口内容落在暗部区间。

仍待办（D1-04B 剩余）：**用修复后的产品代码重跑 FULL/REDUCED/SOLID 性能对比**。
修复前产生的视觉数据不作为最终证据。

### 待验证（沿用）

首个交付平台、局域网服务部署方式、Adobe 版本兼容性、具体 MCP 安装与授权要求。
（Spectrum 适配一项已在 D1-04 结案：REFERENCE ONLY，不再列为待验证。）
