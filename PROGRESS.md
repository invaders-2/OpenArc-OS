# OpenArc OS 进度

更新日期：2026-09-11

最新确认：产品为运行在 Windows/macOS 上的完整独立桌面系统。UI 全局采用 Apple 半透明磨砂玻璃质感，组件与交互动效遵循 https://ui.spectrumhq.in/ 参考方向，覆盖登录、桌面、应用、文件、AI、Skill 和设置。详细要求已写入 PRODUCT.md。

修订原则：后续计划必须写到任务级，每项明确任务 ID、前置、责任管理岗、交付证据及通过条件，避免仅罗列模块。修订记录见 CHANGELOG.md。

---

# D1 当前状态（唯一口径 · D1-06 起生效）

> **本节是 D1-01 ～ D1-06 当前状态的唯一权威口径。**
> 下方「历史记录」各节保留原始过程与失败证据（不删除），但**若与本表冲突，以本表为准**。
> 本表同时消除了此前"某段说 REDUCED 未实现、另一段说已实现""某段说 Harness 尚未安装、另一段说已实测"
> 这类历史状态冲突。完整 Gate 判定见 `docs/decisions/D1-06-technical-gate.md`。

## 1. 阶段任务状态总表

| 任务 | Task Status | 技术决策 | 关键证据（真实执行） | 主要缺口 |
| --- | --- | --- | --- | --- |
| **D1-01** 桌面与原生视图 | **PARTIAL** | 桌面壳架构已落地；D2-02 架构 ADR 待出 | macOS 主进程 **26/26**；`tests/geometry.test.mjs` 5/5；A12 穿透已修 | Windows 6 项；UI E2E 根因未确认；运行时沙箱强制；真实多显示器拔插 |
| **D1-02** Harness | **PARTIAL** | **ACCEPT WITH CONDITIONS**（走 **ACP** 接入面，唯一有 `session/cancel`） | 真实安装（521 包/47s）+ ACP 探针 **10/10**（含挂自建假 MCP 并枚举工具） | 真工具链路未端到端；**ACP 无鉴权**；**凭据无法与 agent 隔离**；Windows/Linux |
| **D1-03** Adobe 双应用 | **BLOCKED** | 无 —— **不授权任何接入实现** | 稳定版无 MCP（二进制 `strings` 计数 0 + 端口零监听，双重否定）；**Beta 未安装**（四项独立证据） | Illustrator 全部运行时项；Photoshop UXP 桥接未实测 |
| **D1-04** 组件与性能 | **PARTIAL** | 设计**内部方向 CLOSED**；选择性玻璃定义冻结 | MS-A02 / MS-A03 / A29；六格主题矩阵 PASS；过滤面积 **−86.6% ~ −99.0%**；63/63 切换压力 PASS | **Electron 内性能**；**Windows 视觉/性能** |
| **D1-05** 服务与隔离 | **PARTIAL** | **20 条决策已冻结** | 9 探针 **FAIL 0 / PASS 6 / PARTIAL 3**；TLS 12 场景；攻击矩阵 12 条；**三条硬红线未触发** | **OS sandbox / 内存 / 网络三处 BLOCKED**；Windows 全项；file boundary 仍有绕过路径 |
| **D1-06** 技术关卡 | **PARTIAL** | **RECOMMENDATION: CONDITIONAL GO** | 26 面 Master Gate Matrix；13 条 blocker 绑定最晚阶段；19 行 Phase Admission Matrix；集成树 `npm test` **7/7** + `npm run build` 通过 | 见第 2 节；Windows / Adobe / OS sandbox 三处 |

### D1 整体判定

> **D1 整体 = PARTIAL。不得描述为 COMPLETE。**

只要下列任一条成立即不得写 COMPLETE，而**三条当前全部成立**：

1. D1-03 仍 `BLOCKED`；
2. D1-05 的 OS sandbox blocker 仍在（含内存 / 网络两项连带 blocker）；
3. Windows 核心项仍 `NOT VERIFIED`。

**"D1-06 = PARTIAL" 与 "D2 可以 CONDITIONAL GO" 不矛盾** —— 前者是技术验证完成度，后者是阶段准入。

## 2. D1-06 Gate 关键面（非 PASS 项全列；全部 26 行见 ADR 第 3 节）

统计：**PASS 11 / PARTIAL 6 / BLOCKED 4 / NOT VERIFIED 5 / FAIL 0**。

| Area | Status | 缺口 | 最晚解决阶段 |
| --- | --- | --- | --- |
| Windows desktop | NOT VERIFIED | mica / 窗口行为 / 多显示器 / 打包 / sandbox runtime / UI E2E | **D6 / RELEASE** |
| Harness | PARTIAL | 端到端工具链路；Windows/Linux | **D4-02** |
| Tool interception | NOT VERIFIED | `tools/call` 实际拦截全未测 | **D4-03 / D4-04** |
| Harness credential boundary | PARTIAL | 真实隔离方案（官方自承无法隔离） | **D4-01** |
| Adobe Illustrator | BLOCKED | Beta 未安装，无重做前提 | **D5-05** |
| Adobe Photoshop | NOT VERIFIED | UXP + 本机桥接未实测 | **D5-04** |
| Electron performance | NOT VERIFIED | 数字只在 Chromium 侧取得 | **D6** |
| Windows visual / performance | NOT VERIFIED | 全部 | **D6 / RELEASE** |
| Local IPC | PARTIAL | **Windows Named Pipe ACL**；跨 uid 强制执行 | **D3-02（Win）** / **D6** |
| Device identity | PARTIAL | device registry / revocation / team membership / authorization **全未实现** | **D3-03** |
| Credential storage | PARTIAL | **Windows DPAPI / Credential Manager** | **D3-04（Win）** / **D6** |
| File boundary | PARTIAL | **hard link** 与 **TOCTOU 中间段替换** 可绕过 | **任何不可信代码执行** |
| Plugin isolation | BLOCKED | OS sandbox | **D5-03 / D5-08** |
| Network isolation | BLOCKED | OS 级强制 | **D5-08** |
| Memory limit | BLOCKED | OS 级方案（V8 `resourceLimits` 不覆盖堆外） | **任何不可信代码执行** |
| Adobe 全模块关口 | BLOCKED | 两应用均无运行证据 | **D5-09** |

## 3. 当前放行结论（详见 ADR 第 18 / 21 节）

| 任务 | 决策 |
| --- | --- |
| D2-01 设计规范 | **CONDITIONAL GO** |
| D2-02 窗口系统 | **CONDITIONAL GO**（仅 macOS；须同时出架构 ADR） |
| D2-03 搜索与通知 | **BLOCK**（前置 D3-02 不存在） |
| D2-04 页面状态 | **CONDITIONAL GO**（无权态留待 D3-02） |
| D3-01 初始化与身份 | **CONDITIONAL GO** |
| D3-02 对象授权 | **CONDITIONAL GO** |
| D3-03 设备与 TLS | **CONDITIONAL GO**（须自建 registry + revocation） |
| D3-04 文件与项目 | **CONDITIONAL GO** |
| D3-05 身份关卡 | **BLOCK** |
| D4-01 模型服务 | **CONDITIONAL GO（受限）** |
| D4-02 任务与适配 | **CONDITIONAL GO** |
| D4-03 工具门与租约 | **BLOCK** |
| D4-04 纵向冒烟 | **BLOCK** |
| D5-03 MCP 中心 | **CONDITIONAL GO（受限）** |
| D5-04 PS 完整接入 | **BLOCK** |
| D5-05 Illustrator 接入 | **BLOCK** |
| D5-08 插件生命周期 | **BLOCK** |

**冻结禁令**：不可信 Plugin / Skill 执行默认关闭（`UNTRUSTED CODE EXECUTION = DISABLED BY DEFAULT`）；
应用层路径检查只作 defense-in-depth，不作为插件权限最终强制点；自动 `FULL→REDUCED→SOLID` 保持冻结；
`network:none` 在无 OS 级强制证据前不得宣称已实现。

---

# 历史记录（过程与失败证据，保留不删）

> 以下各节按当时实际状态书写，**不作为当前口径**。当前状态以 `# D1 当前状态` 一节为准。

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

### D1-02 Harness 技术验证（2026-09-11，Task Status = PARTIAL / Technology Decision = ACCEPT WITH CONDITIONS）

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

### D1-03 Adobe 双应用评估（2026-09-11，结论 BLOCKED）

分支 `feature/d1-03-adobe`，基线 `b39eb93`。完整判定见 `docs/decisions/D1-03-adobe.md`。

- **Illustrator：BLOCKED** —— 官方 MCP 仅存在于 Beta；稳定版 30.0.0 无 MCP 实现
  （主二进制 `strings` 检索 + 端口监听双重否定证据）。D1-03A 复核进一步确认 **Beta 本身未安装**
  （app 包 / 进程 / 偏好目录 / 端口四项皆无；近 3 小时无新安装）。需真实安装 Beta 后重做。
- **Photoshop：NOT VERIFIED** —— 官方 Desktop MCP **NOT FOUND IN OFFICIAL SOURCES**；
  Photoshop API v2 是云端能力、不等于本机控制；候选路线为 UXP + OpenArc 本机桥接，无运行时证据。
- **不允许**出现 "Illustrator PASS + Photoshop NOT VERIFIED → D1-03 PASS" 这类结论；总状态取 **BLOCKED**。

### D1-04 组件、视觉系统与性能技术验证（2026-09-11，结论 PARTIAL）

分支 `feature/d1-04-design-performance`，基线 `b39eb93`。完整判定见 `docs/decisions/D1-04-design-performance.md`。

- **动效可采用：达成。** MS-A02 / MS-A03 / A29 / 可打断性 / 对比度全部有实测证据，并修掉一个真实缺陷。
- **测量条件与目标冻结：方法冻结达成，代表性未达成** —— 数字只在 Chromium 取得，产品是 Electron，Windows 未测。
- **D1-04B 缺口（REDUCED 性能收益不成立）已由 D1-04C 关闭**：REDUCED 改为**选择性玻璃**
  （减少过滤面积，而非调小模糊半径）。过滤面数 K=144 由 150 → **6**；过滤面积降幅 **−86.6% ~ −99.0%**；
  63/63 切换压力 PASS；六格主题矩阵 PASS；并修掉一条实色面板 hover 回归。
- **D1-04B 主题合成修复**：根因是"原料 + 合成结果都留在 `:root`"，`.dark` 覆盖通道时合成值已定型 →
  深色窗口内容拿到浅色合成色 `(250,250,250)`。已改为**消费点合成**（`:root` 只放原料）。
- **关闭的是"内部方向缺口"，不是"性能已代表 Electron"** → 整体 **PARTIAL**，剩余缺口 2 条：
  ①Electron 内性能未验；②Windows 未验。
- **性能口径冻结**：`Performance lever = filtered area / filtered surface count`；
  `Blur radius = secondary visual parameter`（允许 7–13px，但不得作为性能主张依据）。
- **自动 `FULL→REDUCED→SOLID` 降级链冻结到 D1-06 之后**，产品内只有手动选档。

### D1-05 服务 / TLS / 存储 / 沙箱 / 执行隔离技术验证（2026-09-11，结论 PARTIAL）

分支 `feature/d1-05-service-isolation`，基线 `b39eb93`（含 D1-01 安全修复与 D1-02 状态修正，不含 D1-03 / D1-04 内容）。
目标是回答"服务边界、设备接入、凭据存储、文件边界、代码执行**有没有一条能落地并被验证的安全路线**"，
不是把后端建起来。完整判定与 20 条决策见 `docs/decisions/D1-05-service-isolation.md`（另见其 §30 口径修正 addendum）。

**9 个探针实测（`experiments/d1-05/`，`npm run test:security`）：FAIL 0 / PASS 6 / PARTIAL 3**

| 探针 | 判定 | 计数 |
| --- | --- | --- |
| 01 本机 IPC（UDS / localhost TCP / token） | PASS | 12 PASS / 1 NOT VERIFIED |
| 02 TLS（12 场景 + mTLS 设备身份） | PASS | 15 PASS |
| 03 凭据存储与 `credentialRef` 边界 | PASS | 30 PASS / 2 NOT VERIFIED |
| 04 环境继承 | PASS | 9 PASS |
| 05 路径 / 软链 / TOCTOU | PASS | 8 PASS |
| 06 沙箱与执行模型 | PARTIAL | 9 PASS / 2 BLOCKED / 1 PARTIAL |
| 07 进程执行 / 资源限制 / 取消 | PARTIAL | 13 PASS / 2 PARTIAL / 1 BLOCKED |
| 08 日志脱敏与错误边界 | PASS | 10 PASS |
| 09 攻击矩阵（12 条） | PARTIAL | 12 PASS / 5 PARTIAL / 1 BLOCKED |

**三条硬红线均未触发**：无 TLS→明文降级；`shell:false` 下 7 类注入载荷全部无效；无任何允许盲目重放未知副作用的路径。

**实测推翻的默认假设**
- **"同机进程互相信任"被证伪**：同 uid 进程可直接连上 `127.0.0.1:<port>`，可用 `sysctl(KERN_PROCARGS2)` 读走另一进程完整 argv/env（无需 root），可 `fs.readFile()` 绕过一切 JS 路径检查。
- **`127.0.0.1` 不构成认证**；UDS 多一层目录 ACL 但同样不是认证。
- **应用层路径检查不是安全边界**：加固实现挡住 13 类静态载荷，仍被**硬链接**与 **TOCTOU 中间段替换**绕过。
- **Worker Thread 不是安全边界**（共享 `process.env` 与 `SharedArrayBuffer`）；**Child Process 单独也不是沙箱**。
- **V8 `resourceLimits` 不约束堆外内存**：16 MB 堆上限下实测分配出 256 MB Buffer，探针自身被 OOM 杀掉（exit 137）。
- **`RLIMIT_FSIZE` 表现为"静默截断到上限"**（实测恰好 65536 字节），不产生 SIGXFSZ → 服务端上报必须记录 `actualFileSize` 而非只看退出码。

**三个 BLOCKED（本机能力天花板，不写 PASS）**
1. **OS 级进程沙箱**：macOS seatbelt 只能应用 `allow default` 非限制性 profile；任何含 `deny` 规则的 profile 返回 `sandbox_apply: Operation not permitted`。
2. **内存资源上限**：`RLIMIT_AS` / `DATA` / `RSS` 在 macOS 上均不可设。
3. **网络边界**：无法建立真实 OS 网络沙箱；禁止用 JS `fetch` patch 冒充 → 本轮只冻结三档模型（`none` / `selected-hosts` / `unrestricted`）。

**其他未验证**：跨 uid UDS 强制执行 NOT VERIFIED；**Windows 全项 NOT VERIFIED**（无 Windows 主机，不因 Node API 相同就判定隔离有效）。

**一次真实机器状态事故（已完全恢复并记录）**：`/usr/bin/security` 路线在测试中改写了全局钥匙串配置并把 `login.keychain-db` 改名为 `login_renamed_1.keychain-db`。已 `mv` 复原、重置 `default-keychain` / `login-keychain`、恢复 `list-keychains` 原有条目、删除测试钥匙串，并复核无探针残留。该路线因此被**明确否决**，凭据改走进程内 Security.framework。该路线已在 D1-06 追加为**对所有未来安全 Probe 的硬约束**（只能用 isolated test item / 临时 service 名 / 假密钥）。

**结论：PARTIAL，不是 COMPLETE。** 依据指令原文——"如果核心安全边界只有 JS 逻辑、没有 OS 级约束，不能写 COMPLETE"：
路径/文件边界目前有可实测的绕过路径，OS 沙箱在本机无法建立。**不因本轮授权任何产品实现。**
（该轮末尾写的"不得进入 D1-06"是当时的前置要求；**D1-06 已由 Boss 正式授权执行**，门禁已解除，但 D1-05 结论未升级。）

### 待验证（沿用）

首个交付平台、局域网服务部署方式、Adobe 版本兼容性、具体 MCP 安装与授权要求，以及 Spectrum 动效组件与最终桌面技术方案的适配。
