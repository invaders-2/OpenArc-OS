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
| UI 侧端到端（Playwright） | BLOCKED | Playwright 1.55 与 Chromium 152 不兼容，`_electron` 与 `connectOverCDP` 均超时 |
| 运行时沙箱强制执行 | NOT VERIFIED | 本机 Chromium sandbox 初始化失败，需 `--no-sandbox --in-process-gpu` 才能起进程 |
| 物理多显示器插拔 | NOT VERIFIED | 本机单显示器 |

完整证据与判定见 `docs/decisions/D1-01-desktop-native-view.md`。

### 本轮审计发现并修复的真实缺陷

1. **A12 穿透缺陷**：桌面右键菜单打开时原生浏览器视图未隐藏，网页会盖在菜单之上（原生视图永远绘制在 DOM 之上）。已把菜单状态并入可见性判定。
2. **窗口几何从未持久化**：`localStorage` 只存了主题/动效/不透明度/文件夹，没有窗口矩形，"还原"无内容可还原。新增 `oa-wins` + 启动时 clamping。
3. **显示器变化无处理**：新增 `display-added/removed/metrics-changed` 监听 + 越界窗口回拉 + 向渲染进程广播。
4. 窗口边界收敛逻辑原先散落在 `src/main.tsx`，已统一到 `electron/geometry.cjs` 并可被单测覆盖。
5. 浏览器占位文案与实际可见性不一致（隐藏时仍显示"已就绪"），已按真实状态输出。

### 下一步（需先解除阻塞，不自动进入 D1-02）

1. 在 Windows 主机上执行 D1-01 未验证项，补齐双平台证据。
2. 解决 Playwright 与 Chromium 152 的兼容问题（升级 Playwright 或改用 CDP 直连方案），恢复 UI 侧 A12/A13/A05 自动化。
3. 在支持 Chromium sandbox 的机器上验证运行时沙箱强制执行。
4. 上述完成后再判定 D1-01 是否达到 COMPLETE。

### 待验证（沿用）

首个交付平台、局域网服务部署方式、Adobe 版本兼容性、具体 MCP 安装与授权要求，以及 Spectrum 动效组件与最终桌面技术方案的适配。
