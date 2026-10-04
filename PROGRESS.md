# OpenArc OS 进度

更新日期：2026-09-14

最新确认：产品为运行在 Windows/macOS 上的完整独立桌面系统。UI 全局采用 Apple 半透明磨砂玻璃质感，组件与交互动效遵循 https://ui.spectrumhq.in/ 参考方向，覆盖登录、桌面、应用、文件、AI、Skill 和设置。详细要求已写入 PRODUCT.md。

修订原则：后续计划必须写到任务级，每项明确任务 ID、前置、责任管理岗、交付证据及通过条件，避免仅罗列模块。修订记录见 CHANGELOG.md。

> 近期修复（2026-09-12）：`.app` 用 `frame:false` 去掉 32px 透明原生标题栏；顶栏成为窗口拖动区；
> 应用菜单改为最小产品菜单（开发期保留 `Developer`）。详见 CHANGELOG.md。**此项不改变任何阶段状态判定。**

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
| D2-03 搜索与通知 | **CONDITIONAL GO**（D3-02 授权契约已就绪；尚未执行） |
| D2-04 页面状态 | **CONDITIONAL GO**（无权态留待 D3-02） |
| D3-01 初始化与身份 | **CONDITIONAL GO** |
| D3-02 对象授权 | **CONDITIONAL GO** |
| D3-03 设备与 TLS | **CONDITIONAL GO**（须自建 registry + revocation） |
| D3-04 文件与项目 | **CONDITIONAL GO** |
| D3-05 身份关卡 | **BLOCK** |
| D4-01 模型服务 | **CONDITIONAL GO（受限）** |
| D4-02 任务与适配 | **CONDITIONAL GO** |
| D4-03 工具门与租约 | **CONDITIONAL GO（A PASS）** |
| D4-04 纵向冒烟 | **PASS（限定当前验收范围）** |
| D4-06 关联链与预算停止 | **PASS（含任务层跨 run 累计预算续接；仅解除“预算耗尽→用户显式续接”）** |
| D4-05 执行关卡 | **PASS（限定当前验收范围；S1/S2/S3/S4 全 PASS，Closure-3 闭合 S4）** |
| D5-03 MCP 中心 | **CONDITIONAL GO（受限）** |
| D5-04 PS 完整接入 | **BLOCK** |
| D5-05 Illustrator 接入 | **BLOCK** |
| D5-08 插件生命周期 | **BLOCK** |

**冻结禁令**：不可信 Plugin / Skill 执行默认关闭（`UNTRUSTED CODE EXECUTION = DISABLED BY DEFAULT`）；
应用层路径检查只作 defense-in-depth，不作为插件权限最终强制点；自动 `FULL→REDUCED→SOLID` 保持冻结；
`network:none` 在无 OS 级强制证据前不得宣称已实现。

> **放行已消费**：上表 `D2-01 设计规范 = CONDITIONAL GO` 已于 2026-09-11 执行完毕，
> 实际结论 **PARTIAL**（口径见本文 `# D2-01 当前状态` 与 `docs/decisions/D2-01-design-system.md`）。
> 上表其余各项（D2-02 起）**尚未执行**，保持不变。

## 4. Boss Decision（已确认，不再询问）

详见 `docs/decisions/D1-06-technical-gate.md` §23。仅记录决定，不重跑 D1。

| # | 事项 | 裁定 | 对状态的影响 |
| --- | --- | --- | --- |
| 1 | **Governance** | 批准 `D1-06 = PARTIAL` **同时** `RECOMMENDATION = CONDITIONAL GO`；二者不冲突 | **禁止**用 `CONDITIONAL GO` 把 D1 描述成 COMPLETE |
| 2 | **macOS Sandbox** | 生产目标 = **A（OS-supported signed sandbox/helper）**；技术方向 = **Apple App Sandbox + 独立 signed XPC / restricted helper + capability-based RPC**；**B 是 A 的工程拓扑，不是替代**；方案取得真实攻击测试 PASS 前 **D（trusted-plugin-only）继续生效** | 禁止把普通 `child_process` / Worker Thread / JS path validation 描述成安全 sandbox |
| 3 | **Windows** | **投入真机验证**；真机到位前**不阻塞 D2-01 的 macOS / 通用设计系统开发** | Windows **16 项缺口继续 `NOT VERIFIED`，不得模拟 PASS** |
| 4 | **Illustrator** | **安装 Illustrator Beta**（独立外部动作，D2-01 不等待）；安装后另行恢复 `D1-03A Beta MCP Runtime Verification` | **真实握手与文件操作完成前：Illustrator = BLOCKED，D5-05 = BLOCKED** |

---

# D2-01 当前状态（唯一口径 · D2-01 起生效）

> 完整口径见 `docs/decisions/D2-01-design-system.md`（22 节）。本节只放状态与结论。
> **D2-01 = PARTIAL。不得描述为"设计系统已完成"。**

## 1. 维度状态

| 维度 | 状态 | 关键证据 | 主要缺口 |
| --- | --- | --- | --- |
| Token 架构（T1/T2/T3） | **PASS** | `tokens.css` 单一权威（`:root` 92 / `.dark` 39）；T2/T3 静态断言 | — |
| 颜色 | **PASS** | 15 组语义原料；placeholder 独立一档（7.02 / 5.73 / 7.42 / 7.25:1） | — |
| 排版 | **PASS** | 系统字体栈；品牌字体零泄漏（断言强制） | — |
| 间距 / 圆角 | **PASS（本轮范围）** | 4pt 刻度 + 7 档圆角；组件层零字面圆角 | `styles.css` 迁移欠账（见 §4） |
| 材质 / 玻璃三档 | **PASS** | 12 格矩阵；REDUCED 大面积白名单受控；SOLID 过滤面 = 0 | Electron 侧观感待确认 |
| 动效 | **PASS** | 三条路径实测；两条 reduced 路径逐条对齐 | — |
| P0 基础组件 | **PASS** | 9 个组件 + 五态矩阵 56 条断言 | — |
| 页面状态 | **PASS** | 7 种，role/live 与规范表逐条一致 | Unauthorized 真实权限待 D3-02 |
| 无障碍 | **PARTIAL** | 对比度 / Tab 可达 / 焦点环 / ARIA 关联 / Esc 全部实测 | **对话框焦点陷阱 NOT VERIFIED**；无屏幕阅读器实测 |
| 桌面端组件契约 | **PARTIAL** | 12 个表面以真实类名渲染为可探测样例 | **未组件化**（依赖 D2-02 窗口拓扑） |
| Windows 视觉 | **NOT VERIFIED** | — | 无 Windows 机器，全部未测 |

## 2. 探针矩阵（入口 `npm run test:design-system`）

| 探针 | 断言 | 结论 |
| --- | --- | --- |
| `01-token-contract`（静态契约） | 26 | PASS |
| `02-theme-glass-matrix`（6 格 × primitive + desktop） | 32 | PASS |
| `03-component-states`（五态 / 焦点 / 禁用行为学） | 56 | PASS |
| `04-keyboard-a11y`（键盘 / ARIA / Toast / 页面状态） | 33 | **PARTIAL**（含 1 条 NOT VERIFIED） |
| `05-motion-matrix`（normal / reduced 类 / reduced 系统） | 18 | PASS |
| **合计** | **166 通过 / 0 失败 / 1 NOT VERIFIED** | |

**永久回归基线**：D1-04 `theme-matrix` 保留（入口 `npm run test:theme-baseline`），
本轮 token 整层搬迁后**逐格像素值完全重现** —— 抽层未改变任何行为。

## 3. 本轮探针抓出的真实缺陷（8 项，全部已修 + 受控反证）

1. 小 `Surface`/`Toast` 被误挂进大面积开关 → REDUCED 下失去玻璃；
2. 玻璃档位绑在 `.desktop` 上 → **任何非桌面子树档位完全不生效**；
3. `SearchField` 无 hover 态（与 `TextField` 不一致）；
4. `SearchField` placeholder 未接 token → 泄漏 UA 默认灰，浅色 **3.66:1** / 深色 **4.16:1** 不达 AA；
5. 显式 `duration: null`（常驻通知）被 `??` 静默改成 4000ms 自动关闭；
6. 系统级 Reduce Motion 下 spinner 是**卡住的半圈**（结构性替代只绑了 `.reduced` 类）；
7. 系统级 Reduce Motion 缺 `transition-duration: 0ms !important` 兜底 → 硬编码时长的组件仍会动；
8. 基底色没有 token，`#f5f5f7` / `#000` 在两个文件里各一份。

另修正 3 处**探针自身**缺陷（指纹打在透明元素上 / 程序化 focus 验焦点环 /
系统级路径被 `.reduced` 类遮蔽导致断言空转）。

## 4. 迁移欠账（诚实计数）

`styles.css`（898 行）：22 处圆角声明中 18 处字面值（10 处在刻度上可机械替换，
**8 处不在刻度上需设计判断**）；颜色字面值 75 次 / 48 个不同值；
硬编码 transition 时长 **0 处**。组件层（`src/design-system/`）已零字面值。
目标是**减少** magic number，不要求一次性清零；与桌面组件组件化同批迁移更划算。

## 5. 冻结禁令（D2-01 后继续有效）

不可信 Plugin / Skill 执行默认关闭；应用层路径检查只作 defense-in-depth；
**自动 `FULL→REDUCED→SOLID` 保持冻结**；`network:none` 在无 OS 级强制证据前不得宣称已实现；
`REDUCED = 选择性玻璃（减面积，非减半径）` 不得回退为"调小模糊半径"。

## 6. D2-02 交接

①桌面端 12 个组件真组件化（**禁止**在 D2-02 前自行发明其 props API）；
②对话框焦点陷阱 + 焦点返回（本轮 NOT VERIFIED）；
③窗口/面板遮挡与层级（WebContentsView 恒定绘制在 DOM 之上）；
④窗口进出动画的 `transitionend` 审查（严禁状态推进依赖动画结束）；
⑤设计系统升级为 workspace 包的触发条件 = 出现第二个消费者；
⑥`styles.css` 迁移与桌面组件组件化同批进行。

---

# D3-01 当前状态（唯一口径 · 2026-09-11）

## 1. Task Status

| 口径 | Task Status | 说明 |
|---|---|---|
| **macOS identity core** | **PASS** | 初始化原子性与 A01 竞态、session 生命周期、disable / 改密策略、渲染进程边界、日志脱敏、macOS 凭据后端、UI 真实消费领域层 —— 全部实测成立 |
| **overall** | **PARTIAL** | Windows credential backend（DPAPI）与 Windows UI **NOT VERIFIED**，credential backend 不可从 macOS 外推 |

**不得写双平台 COMPLETE。**

## 2. 关键证据（真实执行）

| 入口 | 结果 |
|---|---|
| `npm test` | **96 / 96**（基线 75 + 新增 21） |
| `npm run build` | PASS |
| `npm run test:d3-01` | **12 探针：PASS 12 / PARTIAL 0 / FAIL 0** |
| `npm run test:identity-ui` | **24 / 24**（真实 Electron 44.3.0，驱动 dist/index.html） |
| `npm run test:d2-02` | **PASS 7 / 7**（含 security-surface 15/15，暴露面已显式登记 5→6） |
| `npm run test:design-system` | PASS 4 / PARTIAL 1 / FAIL 0 |
| `npm run test:theme-baseline` | PASS |
| `npm run test:security` | FAIL 0 / PARTIAL 3 / PASS 6 |

分支 `feature/d3-01-identity-init`，基线 `88d1aa3`，未 merge main。
ADR：`docs/decisions/D3-01-identity-initialization.md`；结果：`docs/D3-01-RESULT.md`。

## 3. 本轮冻结（不可随意改）

1. **LOCK ≠ LOGOUT**：锁定=session 仍有效但受保护命令 DENY；登出=session 撤销。两条命令、两个语义。
2. **改密 = authVersion++ 且撤销全部 session（含当前）**。
3. **禁用不删 session 行**：保住 `USER_DISABLED` 语义，不退化成 `SESSION_REVOKED`（D4 需要该区分）。
4. **口令 KDF = scrypt**（Node 官方），参数 `N=2^15/r=8/p=1`，verifier 自描述可升级；Argon2id 留作第二取值。
5. **session token 走 Electron safeStorage**（macOS Keychain / Windows DPAPI）；降级明文 0600 必须显式留痕，不静默。
6. **渲染进程不持有任何凭据**：localStorage 零身份字段；`identity` 桥只有 `command` / `onEvent` 两个方法。
7. **命令失败时 phase 只允许降级或保持，绝不升级**（UI 探针抓出的真实缺陷：错口令解锁曾能回到桌面）。
8. **持久化 = `node:sqlite`**，schema_version 从第一版就是 1；JSON 文件不得作为最终身份库。

## 4. D3-02 交接

D3-01 只回答「你是谁 / session 是否有效」。D3-02 的对象权限必须挂在**同一套领域命令层**上，
不得在渲染进程里加权限判断，也不得新建第二套入口。详见 ADR 的 `D3-02 Handoff` 一节。

## 5. 主要缺口

Windows 真机（credential backend + UI + DPAPI）、身份库备份/迁移/恢复策略、admin UI、
credential store 产品化（API Key / OAuth Token → credentialRef）。

---

# D3-02 当前状态（唯一口径 · 2026-09-12）

## 1. Task Status

| 口径 | Task Status | 说明 |
|---|---|---|
| **macOS Object Authorization Core** | **PASS** | DEFAULT DENY、Session Gate、Super Admin 治理、Department Membership、Department Admin 边界、No Self Escalation、Delegation Ceiling、稳定 Resource Identity、Resource Scope、Grant/Revoke、App Principal、User∩App 交集、resource.useByAgent、Query Filtering、Anti Enumeration、Stale Capability DENY、Migration Integrity、Unauthorized UI、Manual/AI parity —— 全部实测成立 |
| **overall** | **PARTIAL** | Windows OS enforcement / Named Pipe / DPAPI / Windows App Identity **NOT VERIFIED**；第三方 App Identity Integrity **NOT VERIFIED**（属 D5） |
| **Resource Library Planning** | **PLANNED / NOT IMPLEMENTED**（D3-02 时点；当前状态见 # D3-04A） | 规划已纳入 PRODUCT.md / docs/plans/LOCAL_RESOURCE_LIBRARY.md；D3-02 只实现 Authorization Core |

**不得写 Resource Library PASS。不得写双平台 COMPLETE。**

## 2. 关键证据（真实执行）

| 入口 | 结果 |
|---|---|
| npm test | **193 / 193**（D3-01 基线 96 + D3-02 新增 97） |
| npm run build | PASS |
| npm run test:d3-02 | **6 探针：PASS 6 / PARTIAL 0 / FAIL 0（56 条用例）** |
| npm run test:authorization-ui | **14 / 14**（真实 Electron 44.3.0：Viewer 只读 / 无权限 Unauthorized / bridge 防枚举） |
| npm run test:d3-01 | D3-01 回归（12 探针） |
| npm run test:identity-ui | **24 / 24**（真实 Electron） |
| npm run test:d2-02 | PASS（security-surface 暴露面 6 → 7 已显式登记） |
| npm run test:design-system | 与基线一致 |
| npm run test:theme-baseline | 与基线一致 |
| npm run test:security | 与基线一致（未扩大 Credential / IPC / Renderer 暴露面） |

分支 feature/d3-02-object-authorization，基线 8b46eb4（feature/resource-library-planning），未 merge main。
ADR：docs/decisions/D3-02-object-authorization.md。

## 3. 本轮冻结（不可随意改）

1. **DEFAULT DENY + ADDITIVE ALLOW**；Policy Version = d3-02-v1，暂不引入 Explicit Deny。
2. **Principal = USER / DEPARTMENT / APP**；DEVICE 属 D3-03，本轮不实现。
3. **User ∩ App 铁律**：User ALLOW + App DENY → DENY；User DENY + App ALLOW → DENY；两者同时 ALLOW → ALLOW。
4. **resource.useByAgent 必须独立授予**，不包含在任何常规 Permission Set 中。
5. **source（manual/ui/agent/system）只进 Audit，不参与提权**；Agent 语义只由 agentSessionId / agent 标记触发。
6. **Resource 身份 = resourceId / ResourceRef**，绝不用文件名 / 路径 / 显示名 / 下标。
7. **Memory 默认高敏**：普通第三方 App 默认 DENY，全局 App grant 也不覆盖 memory。
8. **授权无进程内缓存**：Revoke 下一请求立即生效，不需重登 / 重启。
9. **Super Admin ≠ Credential Secret**：治理权限与原始凭据完全分开。
10. **迁移逐级原子**：v1 → v2 任一级失败整级回滚，不留半状态。

## 4. D2-03 准入

D3-02 已交付 authorize / getCapabilities / searchAuthorizedResources / listAuthorizedResources /
resolveResourceRef / notificationReauthorize。D2-03 搜索与通知的授权契约前置已满足 →
**D2-03 = CONDITIONAL GO（尚未执行）**；但 D2-03 仍须复用这些服务端接口，不得在 Renderer 重新过滤。

## 5. 下一步（不自动执行）

D3-03 Device Identity / TLS → D3-04A/B/C/D Resource Library → D3-05 → D4-02 → D4-03 → D5。
**不跳过 D3-02 直接开发资源库。**

## 6. 主要缺口

Windows OS enforcement / Named Pipe / DPAPI / App Identity；第三方 App Integrity（D5）；
Resource Library 内容与 CRUD（D3-04）；Embedding；Department / Super Admin 权限管理 UI（本轮只交付服务层 + 最小 Unauthorized fixture）；
D1-05 OS filesystem sandbox blocker 仍在，D3-02 不关闭。

---

# D3-03 当前状态（唯一口径 · 2026-09-13）

## 1. Task Status

| 口径 | Task Status | 说明 |
|---|---|---|
| **macOS Device Identity Core** | **PASS** | DeviceId、Registry、状态机、Organization 绑定、Pairing（短时/单次/绑组织/验 Service Identity）、Pairing race（恰好一台）、Replay DENY、到期边界、真 mTLS（12 场景）、证书有效 ≠ 设备授权（两层）、Revocation 立即生效、Disable/Enable 区分、Credential Rotation（版本单调）、跨组织拒绝、冒充防护、Heartbeat 身份绑定、Audit（含 secret 0 命中）、v2→v3 迁移（原子回滚）、Renderer 边界（暴露面 5 → 6 已显式登记）—— 全部真实执行 |
| **overall** | **PARTIAL** | Windows（Named Pipe ACL / DPAPI / 证书存储 / 设备运行时）**NOT VERIFIED**；Device Agent 生产凭据存储**未实现**（本轮只有测试原型）；X.509 级吊销（CRL/OCSP）未做 |
| **Resource Library** | **PARTIAL / IMPLEMENTATION IN PROGRESS**（D3-03 时点为 PLANNED；D3-04A 已交付 Store Core） | D3-03 交付 ResourceLocation 契约与"资源×设备交集"证明；D3-04A 交付 Resource Object & Local Store，但完整资源库仍未完成 |

**不得写双平台 COMPLETE。不得写 Resource Library PASS。**

## 2. 关键证据（真实执行）

| 入口 | 结果 |
|---|---|
| npm test | **262 / 262**（D3-02 基线 243 + D3-03 新增 19；含更新到 v3 的 D3-02 迁移测试） |
| npm run build | PASS |
| npm run test:d3-03 | **TLS 矩阵 12 / 12 场景通过，exit 0** |
| node --test tests/device-tls.test.mjs | **12 / 12** |
| node --test tests/device-*.test.mjs | 覆盖 registry / pairing / race / replay / revocation / disable / rotation / cross-org / impersonation / session-auth / audit / migration / resource∩device / agent |
| npm run test:security | **FAIL 0 / PARTIAL 3 / PASS 6**（= D3-01 基线；D1-05 TLS 探针需先跑 gen-test-certs.sh，属环境前置） |
| npm run test:d3-01 / test:d3-02 / test:authorization-ui / test:identity-ui | 见 docs/D3-03-RESULT.md |

分支 feature/d3-03-device-identity，基线 feature/d3-02-object-authorization @ 9119f85，未 merge main。
ADR：docs/decisions/D3-03-device-identity.md；结果：docs/D3-03-RESULT.md。

## 3. 本轮冻结（不可随意改）

1. **UserId ≠ DeviceId**，四个身份域（User / App / Resource / Device）互相独立。
2. **TLS Certificate Validity ≠ Device Authorization**：`authenticateConnection`（第一层）
   与 `authorizeDevice`（第二层）必须**同时**通过。
3. **Pairing Credential 只用于 bootstrap**：单次、短时、绑组织、只存 sha256；注册后换成设备专属身份。
4. **设备属于 Organization，不默认属于某个 User**；ownership 不写死成个人机器模型。
5. **REVOKED 是终态**：重新启用必须重新 Pair / 换新凭据（Disable 才是可恢复的管理动作）。
6. **OFFLINE ≠ REVOKED**：连接状态与授权状态是两根轴，禁止混成一个 "Unavailable"。
7. **撤销/禁用/轮换立即生效**：关闭已建立连接 **且** 下一条受保护消息拒绝；心跳不改变状态。
8. **private key 不得越过 Device Agent / 受信服务边界**：Renderer、localStorage、审计、
   日志、Harness、Prompt 全都不得出现；审计有显式字段黑名单。
9. **不采用 TOFU**：Service Identity 必须可确认，未配置则拒绝配对（fail closed）。
10. **本地 IPC 与 LAN TLS 是不同边界**：`127.0.0.1` 同样要过 mTLS。
11. **UNKNOWN_EFFECT 契约继续有效**：设备断开不等于结果未知可自动重发。

## 4. D3-04 交接

`deviceId` / Device Registry / Device Authorization / `ResourceLocation.deviceId` /
Online-Offline / Revoked-Disabled / 安全 metadata / 跨设备边界。
D3-04 才能表达"这个资源在哪里 / 当前用户能不能让这台机器读取 / 是否必须 transfer"。

## 5. 主要缺口

Windows 全部（Named Pipe / DPAPI / 证书存储 / 设备运行时）、Device Agent 生产凭据存储、
X.509 级吊销（CRL/OCSP）、多级证书链 / IPv6 / wildcard SAN、
Department Admin 的设备管理（DEFERRED TO POLICY EXTENSION）。

---

# D3-04A 当前状态（唯一口径 · 2026-09-14）

## 1. Task Status

| 口径 | Task Status | 说明 |
|---|---|---|
| **macOS Resource Store Core** | **PASS** | Stable ResourceRef、Managed Store、Linked Resource、Content-addressed objects、Dedupe、Import State Machine + Crash Recovery、Large streaming、Version、Version conflict、Trash、Restore、Permanent Delete、GC safety、Integrity、Resource+App authorization、Resource+Device authorization、Restart persistence、Migration、Renderer boundary —— 全部真实执行 |
| **overall** | **PARTIAL** | Windows 路径语义 / 文件锁 / NTFS / userData **NOT VERIFIED**；远程 Device LINKED content transport 未实现 |
| **Resource Library** | **PARTIAL / IMPLEMENTATION IN PROGRESS**（当前状态见 # D3-04C） | D3-04A 完成 Resource Object & Local Store；CRUD/UI 已由 D3-04B 交付；Search/Index/Preview 已由 D3-04C 交付；Integration（D3-04D）仍未完成，**不得写 COMPLETE** |

**不得写 Resource Library COMPLETE。不得写双平台 COMPLETE。**

## 2. 关键证据（真实执行）

| 入口 | 结果 |
|---|---|
| npm test | **307 / 307**（D3-03 基线 248 + D3-04A 新增 59） |
| npm run build | PASS |
| npm run test:d3-04a | **4 探针：PASS 4 / PARTIAL 0 / FAIL 0（34 条用例）** |
| npm run test:resource-ui | **10 / 10 UI checks PASS**（真实 Electron：Import / Link、safe descriptor、绝对路径不泄漏） |
| large streaming | 10MB external 增量约 11MB / 100MB 约 13MB，均远小于文件大小（无整文件 Buffer） |
| npm run test:d3-01 | PASS 12 / FAIL 0 |
| npm run test:d3-02 | PASS 6 / FAIL 0 |
| npm run test:d3-03 | TLS 12/12，exit 0 |
| npm run test:d2-02 | PASS 7/7（security-surface 15/15，暴露面 8 → 9 已登记） |
| npm run test:identity-ui / test:authorization-ui / test:device-ui | 24/24 / 14/14 / PASS（device-ui 2 项 NOT VERIFIED） |
| npm run test:security / test:design-system / test:theme-baseline | FAIL 0 / 与基线一致 / 通过 |

分支 feature/d3-04a-resource-store，基线 feature/d3-03-device-identity @ 7a94757，未 merge main。
ADR：docs/decisions/D3-04A-resource-store.md。

## 3. 本轮冻结（不可随意改）

1. **resource_registry 继续是唯一逻辑身份 / 授权权威**；library_resources 只承载存储语义，1:1 共享 resourceId。
2. **Content Object dedupe ≠ Resource Entry dedupe**：同一内容可以对应多个 Resource（不同 name/Collection/Owner/权限）。
3. **object 路径只由 checksum 生成**（objects/sha256/ab/<hash>）；用户文件名永不参与最终路径。
4. **DB 与 FS 之间没有真正 ACID**：Import 用显式状态机 + 可重放 recovery，不写 "atomic transaction"。
5. **默认 Trash（软删除）**，ResourceRef 保持；restore 同一个 ref。
6. **Version 单调递增**：replace 产生新版本；restoreVersion 产生更高新版本，不倒退。
7. **乐观并发**：expectedVersion 不匹配 -> VERSION_CONFLICT，不静默覆盖。
8. **GC 只在 refs=0 时删 object**；共享内容不得被误删。
9. **Create 对 target container/scope 授权**（authorizeCreate），不是拿不存在的 resourceId 授权。
10. **内置 App 也要真实 app grant**（system:builtin-policy）；全局 grant 不覆盖 memory。
11. **Renderer 无 raw fs**：只有 resource.command；文件选择在主进程 dialog，路径不回渲染进程。
12. **LINKED 与 Device 是交集**：Device Offline/Revoked 时 metadata 可显示，content 不可读。

## 4. D3-04B 准入

**D3-04B = CONDITIONAL GO。** D3-04A 的 ResourceStore / ResourceService / Import State Machine / Version / Trash / GC / authorizeCreate 已就绪。
D3-04B 必须复用这些能力，不得重建第二套 ACL 或身份系统。D3-04C Search/Index/Preview、D3-04D Integration 保持 BLOCK，直到 D3-04B 完成。

## 5. 主要缺口

Windows 全部（路径 / 文件锁 / NTFS / userData）；MANAGED symlink TOCTOU 未消除；LINKED symlink 第一版拒绝；
远程 Device content transport 未实现；完整 Resource Library UI / CRUD / Search / Preview；block-level dedupe；DB 加密-at-rest。

---

# D3-04B 当前状态（唯一口径 · 2026-09-14）

## 1. Task Status

| 口径 | Task Status | 说明 |
|---|---|---|
| **macOS Resource Library CRUD Core** | **PASS** | Resource Library App 三栏、Authorized listing、Import / Link、Create Resource、Memory CRUD、Text/Code/Prompt editing、Version-aware save + VERSION_CONFLICT、Collection CRUD、Tag CRUD、Favorite、Recent、Trash UI、Restore、Permanent Delete、Inspector、Structured filtering、Restart persistence、Authorization、App permission、Personal Memory isolation、v4→v5 Migration、Accessibility —— 全部真实执行 |
| **overall** | **PARTIAL** | Windows Resource Library UI / file picker / drag-drop / clipboard **NOT VERIFIED**；D3-04C Search/Index/Preview 已完成；D3-04D Integration 未完成 |
| **Resource Library** | **PARTIAL / IMPLEMENTATION IN PROGRESS** | Search / Index / Preview 已由 D3-04C 交付；仍缺 D3-04D Department / App / Files / Projects Integration；**不得写 COMPLETE** |

**不得写 Resource Library COMPLETE。不得写双平台 COMPLETE。**

## 2. 关键证据（真实执行）

| 入口 | 结果 |
|---|---|
| npm test | **348 / 348**（D3-04A 基线 307 + D3-04B 新增 41） |
| npm run build | PASS |
| npm run test:d3-04b | **2 探针：PASS 2 / FAIL 0（25 条用例）** |
| npm run test:resource-library-ui | **24 / 24 UI checks PASS**（真实 Electron：open / import / create memory / edit / version conflict / collection / move / tag / favorite / delete / trash / restore / capabilities） |
| npm run test:d3-04a / resource-ui | PASS 4/4 / 10/10 |
| npm run test:d3-01 / d3-02 / d3-03 | 12/12 / 6/6 / TLS 12/12 |
| npm run test:d2-02 | PASS 7/7（含 security-surface 15/15） |
| npm run test:identity-ui / authorization-ui / device-ui | 24/24 / 14/14 / PASS（device-ui 2 NOT VERIFIED 属 D3-03） |
| npm run test:security / design-system / theme-baseline | FAIL 0 / PASS 4 / 与基线一致 |

分支 feature/d3-04b-resource-library，基线 feature/d3-04a-resource-store @ 469f78b，未 merge main。
ADR：docs/decisions/D3-04B-resource-library.md。

## 3. 本轮冻结（不可随意改）

1. **复用 D3-04A 存储层**：不重建 Resource Registry / ACL / App Grant / Device Identity / Resource Store。
2. **Collection = primary organization；Tag = 多对多**：一个 Resource 一个 primary Collection（registry.collection_id），不实现无限多 Collection。
3. **删除 Collection 绝不级联删除 Resource**：Resource → Unfiled。
4. **Tag 规范化**：显示名保留大小写，比较用 normalized（小写），同组织唯一（Shoes == shoes）。
5. **Metadata 修改不产生内容 version**：tag / favorite / collection / description / name 属 Metadata Revision。
6. **Favorite / Recent 是 per-user**，且 Recent 只在真实打开时更新。
7. **Private Memory 默认 PERSONAL + OWNER_POLICY**：加入 Department 不自动共享。
8. **Version-aware save**：expectedVersion 冲突必须 VERSION_CONFLICT，UI 不覆盖；restoreVersion 继续 vN → vN+1。
9. **授权在服务端**：Renderer 的 canEdit 只控制 UX，真实 command 再次 authorize。
10. **Renderer 无 raw fs**：只有受控 Resource Commands，路径不回渲染进程。
11. **治理不依赖目标 App enabled**：禁用某 App 后 Super Admin 仍能重新启用（本轮修复的真实缺陷）。
12. **不做全文搜索**：本轮 Name filter，D3-04C 替换为 FTS / Authorized Search Provider。

## 4. D3-04C 准入

**D3-04C = CONDITIONAL GO。** D3-04B 已交付 authorized listing / structured filter / inspector / FTS 接入点。
D3-04C 必须替换 Name filter 为真正的 FTS / Authorized Search Provider，并复用服务端授权边界；不得在 Renderer 重建索引或过滤。

## 5. D3-04D 准入

**BLOCK**，直到 D3-04C 完成。D3-04D 负责 Department / Super Admin 权限 UI、App Resource Picker、Files / Projects / Canvas 集成、Ownership / Scope 治理编辑。

## 6. 主要缺口

Windows UI / picker / drag-drop / clipboard NOT VERIFIED；Paste 与 Drag&Drop 未实现（DEFERRED，未伪造）；全文搜索 / 缩略图 / 预览 已由 D3-04C 交付；转写 / Embedding 仍不实现（需用户显式允许）；Department / App Picker / Files / Projects / Canvas（D3-04D）；批量操作；Store 加密-at-rest。

---

# D3-04C 当前状态（唯一口径 · 2026-09-15）

## 1. Task Status

| 口径 | Task Status | 说明 |
|---|---|---|
| **macOS Authorized Search / Local Index / Secure Preview** | **PASS** | Authorized Search Provider、本地 FTS5 索引、CJK 中文检索（鞋子 / 详情页 / 生成提示）、结构化 snippet、排序、Index Lifecycle（惰性 reconcile / 作业恢复 / 从权威表重建）、Text Extraction、Preview（text / image / pdf / video / audio）、缩略图、capability + Range 安全交付、v5→v6 迁移、真实 Electron UI 探针 —— 全部真实执行 |
| **overall** | **PARTIAL** | Windows scheme / 媒体解码 / 文件选择器 **NOT VERIFIED**；远程 Embedding / 语义检索 / OCR / 转写 **明确不实现**（未伪造） |
| **Resource Library** | **PARTIAL / IMPLEMENTATION IN PROGRESS** | Search / Index / Preview 已交付；仍缺 D3-04D Department / App / Files / Projects Integration；**不得写 COMPLETE** |

**不得写 Resource Library COMPLETE。不得写双平台 COMPLETE。**

## 2. 关键证据（真实执行）

| 入口 | 结果 |
|---|---|
| npm test | **403 / 403**（D3-04B 基线 348 + D3-04C 新增 55） |
| npm run build | PASS |
| npm run test:d3-04c | **5 探针：PASS 5 / FAIL 0（60 条用例）** |
| npm run test:resource-search-ui | **16 / 16 UI checks PASS**（真实 Electron：中文全文搜索 / snippet / 索引状态） |
| npm run test:resource-preview-ui | **19 / 19 UI checks PASS**（真实 Electron：text / image+thumbnail / pdf / audio / video、Range、无路径泄漏、Trash 拒绝） |
| npm run test:d3-04b | PASS 2/2（未回归） |
| npm run test:d3-04a / d3-04b-ui / resource-ui | PASS（未回归） |

分支 feature/d3-04c-resource-search-preview，基线 feature/d3-04b-resource-library @ b0c2a96，未 merge main。
ADR：docs/decisions/D3-04C-search-index-preview.md。

## 3. 本轮冻结（不可随意改）

1. **LOCAL FIRST**：搜索 / 索引 / 抽取 / 缩略图全部本机完成，不调用远程 Embedding / Vision / OCR / Transcription。
2. **DEFAULT DENY**：FTS 只产候选，每个候选都要经 D3-02 Authorization；未授权资源 0 结果、不计入 total、无任何存在性提示。
3. **索引是派生数据，不是第二数据库**：可随时从 resource_registry / library_resources / resource_versions 重建，不参与授权判定。
4. **授权永远在服务端**：Renderer 只收已授权结果；禁止 load-all → Renderer filter；新增 authorizeMany 做批量候选过滤。
5. **CJK 策略**：受控本地 n-gram（unigram + 相邻 bigram）；FTS5 unicode61 只作分词容器；trigram 不用于 2 字中文。
6. **PDF 只做 metadata-only**：正文抽取记 UNSUPPORTED_TEXT_EXTRACTION，不做 OCR，不伪造正文。
7. **Preview 只经 capability**：openarc-resource:// 短时 capability（60s），每次协议请求重新授权，支持 Range/206。
8. **Trash 不交付内容**：已删除资源 preview 默认拒绝且无 includeTrashed 绕过。
9. **snippet 结构化**：返回 spans 数组，绝不返回 HTML；UI 不使用 dangerouslySetInnerHTML。
10. **Renderer 无 raw fs**：只有受控 Resource Commands，本地路径 / internalKey / checksum 目录不回渲染进程。

## 4. D3-04D 准入

**DONE（macOS PASS）**，见 # D3-04D 当前状态。D3-04D 已交付 Department / Super Admin 权限 UI、App Resource Picker、Files / Projects / Canvas 集成、Ownership / Scope 治理，并复用本轮冻结的 search / index / preview 语义与 capability 交付。

## 5. 主要缺口

Windows scheme / 媒体解码 / picker NOT VERIFIED；PDF OCR / 转写 / 远程 Embedding 明确不实现；video poster 帧 DEFERRED；预览缓存无后台 GC 定时器；>10k 数据集与超长文档基准未覆盖。

---

# D3-04D 当前状态（唯一口径 · 2026-09-15）

## 1. Task Status

| 口径 | Task Status | 说明 |
|---|---|---|
| **macOS Resource Governance & Integration Core** | **PASS** | Super Admin 治理、子用户管理、Department CRUD 与 Department Admin 边界、Resource / Collection / App 权限管理、Agent useByAgent、系统 Resource Picker、Files / Projects / Canvas ResourceRef 集成、Scope / Ownership 治理、Audit、v6→v7 迁移 —— 全部真实执行 |
| **overall** | **PARTIAL** | Windows 治理 UI / Picker / File / Canvas **NOT VERIFIED**；Organization Memory Audit Policy DEFERRED |
| **Resource Library** | **macOS 首版核心 PASS**（D3-04A/B/C/D 全部 PASS） | Windows 未验，跨平台 overall 仍 PARTIAL；**不得写 Resource System COMPLETE** |

## 2. 关键证据（真实执行）

| 入口 | 结果 |
|---|---|
| npm test | 见下方回归（全部通过） |
| npm run build | PASS |
| npm run test:d3-04d | **5 探针 PASS / FAIL 0** |
| npm run test:governance-ui | **10 / 10 UI checks** |
| npm run test:resource-picker-ui | **8 / 8 UI checks** |
| npm run test:canvas-resource-ui | **8 / 8 UI checks** |
| D2-02 security-surface | **15 / 15**（桥接 10 键 / IPC 8 通道显式登记） |
| d3-04a / d3-04b / d3-04c / d3-01 / d3-02 / d3-03 + 既有 UI 探针 | 见最终 Result（未回归） |

分支 feature/d3-04d-resource-governance-integration，基线 feature/d3-04c-resource-search-preview @ eb90223，未 merge main。
ADR：docs/decisions/D3-04D-resource-governance-integration.md。

## 3. 本轮冻结（不可随意改）

1. **不建第二 ACL**：治理 / Picker / Files / Projects / Canvas 全部复用 D3-02 AuthorizationService；新增表只存引用关系。
2. **Super Admin 有治理权、无秘密读取权**：内容读取仍按用户侧策略；Personal Memory 默认不可读。
3. **Picker 只显示交集**：User ∩ App ∩ Type ∩ Action；只返回 ResourceRef；复用 D3-04C Search / Preview。
4. **Picker token 不是授权绕过**：每次 validate 重新 authorize；撤权 / 停用 / disable 立即失效。
5. **Canvas 默认 PIN_VERSION**：不静默跟随资源新版本；显式 Update to latest；Trash/UNAUTHORIZED/DELETED 显示真实状态。
6. **Project 不复制 Resource metadata，也不自动越权**：逐资源重新授权。
7. **Explicit USER / APP grant 在 Scope / Department 变更后保留并重新求值**；旧 Department 继承 grant 立即移除。
8. **治理写操作全部 Audit**：不写 body / memory / password / token / device key。
9. **治理命令受控白名单**：governance:command + resource 桥新命令；无 raw SQL / raw ACL / 凭据读取入口。

## 4. D3-05 准入

**D3-05 Identity & Data Gate = GO（建议）**：D3-04A/B/C/D 在 macOS 全部 PASS，可统一验证 Identity / Authorization / Device / Resource / Department / App / Search / Preview / Governance，然后进入 D4。Windows 仍 NOT VERIFIED。

## 5. 主要缺口

Windows 治理 / Picker / File / Canvas NOT VERIFIED；Organization Memory Audit Policy DEFERRED；完整 Subject×Permission 矩阵可视化未做（Domain 能力已具备）；App / Agent usage history 属 D4；批量操作 UI 未做（服务层已具备）。

---

# D3-05 当前状态（唯一口径 · 2026-09-15）

## 1. Task Status

| 口径 | Task Status | 说明 |
|---|---|---|
| **D3-05 macOS Identity & Data Gate** | **PASS** | Fresh install E2E、Identity/Session/Lock/Disable/Reset、Authorization、Department isolation、App ∩ User、Agent useByAgent、Device gate、Resource lifecycle、Search zero-leak、Preview revoke、Picker revoke、Project/Canvas reauthorization、Personal Memory privacy、Governance、Audit、Migration matrix、Concurrency、Restart/Recovery、Renderer/IPC boundary —— 全部真实通过，新增 Security FAIL = 0 |
| **D3 overall (macOS)** | **PASS** | D3-01 / D3-02 / D3-03 / D3-04A / D3-04B / D3-04C / D3-04D / D3-05 全部 macOS PASS |
| **D3 overall (cross-platform)** | **PARTIAL** | Windows NOT VERIFIED；**不得写双平台 COMPLETE** |

## 2. Gate-blocking fixes（本轮真实缺陷）

1. **Re-enable 不恢复旧 session**（`identity-store.setUserStatus`）：停用后重新启用时 authVersion++ 并撤销全部旧 session，用户必须重新认证（原行为会静默恢复旧 session）。
2. **资源 owner 可撤销 PERSONAL 资源的显式授权**（`authorization-service.revokeResourcePermission`）：原实现只按 department 判断，导致非 Super Admin 的资源 owner 撤不掉自己个人资源上的 grant。

两处均有回归覆盖；`tests/authorization-policy.test.mjs` 的 disable 用例已更新为新的冻结语义。

## 3. 关键证据（真实执行）

| 入口 | 结果 |
|---|---|
| npm test | **463 / 463 PASS** |
| npm run build | PASS |
| D3-05 Gate 测试 | d3-05-gate 6/6 + d3-05-data-gate 7/7 |
| d3-01 / d3-02 / d3-03 | 12/12 / 6/6 / TLS 12/12 |
| d3-04a / d3-04b / d3-04c / d3-04d | 4/4 / 2/2 / 5/5 / 5/5 |
| D2-02 security-surface（直接） | 15 / 15 |
| test:security | FAIL 0 / PARTIAL 2 / PASS 6 |
| 既有 UI 探针 | identity 24 / authorization 14 / device 32（2 NOT VERIFIED 属 D3-03）/ resource 10 / resource-library 24 / resource-search 16 / resource-preview 19 / governance 10 / picker 8 / canvas 8 |

分支 feature/d3-05-identity-data-gate，基线 feature/d3-04d-resource-governance-integration @ b5a9b49，未 merge main。
ADR：docs/decisions/D3-05-identity-data-gate.md；报告：docs/D3-05-RESULT.md。

## 4. Known Flakes / NOT VERIFIED

D2-02A 可视 Gate 的 occlusion/input 在本机环境性 flaky；**按用户明确要求未运行 5 次**（会显示真实窗口打扰桌面），§56 归因记 NOT VERIFIED。可视探针默认 opt-in（`OPENARC_RUN_VISUAL_PROBES=1`）；D2-02 `security-surface.mjs` 直接运行 15/15。

## 5. D4-01 准入

**D4-01 Model Service / Model Proxy / Credential Boundary = CONDITIONAL GO**，受 D1-02 Harness 条件与 D1-05 Security Freeze 约束。D4 不自动获得工具执行权；严格 D4-01→D4-02→D4-03→D4-04→D4-05。Harness raw provider key = FORBIDDEN，走 OpenArc Model Proxy；Agent Resource 只用受控接口 + ResourceRef。

## 6. 主要缺口

Windows；D2-02 5-run 归因；完整 Subject×Permission 矩阵 UI；Browser 网页上传 Picker bridge；Organization Memory Audit Policy；Drag&Drop / Paste；App/Agent usage history；产品化 Backup/Restore（D6）。

---

# D4-01 当前状态（唯一口径 · 2026-09-15）

## 1. Task Status

| 口径 | Task Status | 说明 |
|---|---|---|
| **macOS Model Service Core** | **PASS** | Provider/Endpoint 策略、Credential Boundary（无明文 fallback）、Model Registry、Capabilities、Defaults/Resolution、Authorization（D3 + App Grant model.*）、单次 Chat、tool-call proposal（0 执行）、cancel/timeout、无隐藏 retry、真实 localhost fake provider、schema v8 迁移 |
| **Model Proxy / Scoped Capability / Child Isolation / Streaming** | **PASS** | loopback `127.0.0.1:0` + capability + per-call reauthorize；独立 OS child 探针（env/argv/stdout/stderr 0 hit）；真实 SSE 事件模型 |
| **`model.command` IPC / Settings UI** | **PASS** | 单通道白名单 + 静态 dispatch；write-only credential；`model-ipc-ui` 10/10、`model-settings-ui` 16/16 |
| **真实 macOS secure backend 重启边界（Closure D）** | **PASS** | `model-keychain-restart` **64/64**：4 独立 Electron 进程共享 userData；重启后 credential 可用；replace/delete 跨重启生效；旧 capability DENY / 新 PASS；missing secure item → `CREDENTIAL_MISSING`；无安全后端 → `CREDENTIAL_STORE_UNAVAILABLE` |
| **Full Secret Scan + 性能基线（Closure E）** | **PASS** | `model-secret-scan` 13/13 checks（SQLite/audit/call records/logs/Resource/Search/FTS/Preview/child/源码/生成文件/artifact 全 0 hit）；`model-secret-ui` **20/20**（真实 Electron DOM/preload/加密 blob/userData）；`model-performance` 10/10（resolution/proxy/streaming/RSS/open-handle 基线）；Provider error echo 已脱敏；capability token 不落盘 |
| **最终验收（Closure F）** | **PASS** | `model-isolation` 10/10 + `model-isolation-ui` **26/26**（User B logout/login、Organization 边界、Models a11y smoke）；D3 8 个标准入口、14 个 Electron UI probe、migration 18/18 全 PASS；修复真实越权（非 Super Admin 可改 ORGANIZATION Provider / credential status 泄漏） |
| **D4-01 macOS Core** | **PASS** | A–F 全部真实通过 |
| **D4-01 cross-platform overall** | **PARTIAL** | Windows NOT VERIFIED；External Provider NOT VERIFIED |

## 2. 关键证据（真实执行）

| 入口 | 结果 |
|---|---|
| npm test | **522 / 522 PASS** |
| npm run build | PASS |
| test:d4-01 | **59 / 59 PASS**（含 secret-scan + performance + isolation） |
| D3 标准入口（d3-01..d3-05） | 全 PASS（d3-05 **13 / 13**） |
| Electron UI probes（14 个） | 全 PASS（device 32/32 内含 2 NOT VERIFIED 声明） |
| test:security（D1-05） | FAIL 0 / PARTIAL 2 / PASS 6 |
| security-surface（D2-02 A13） | **15 / 15 PASS** |
| dialog-a11y（D2-02） | **33 / 33 PASS** |
| model-ipc-ui / model-settings-ui / model-keychain-restart | **10/10 · 16/16 · 64/64 PASS** |
| model-secret-ui / model-isolation-ui | **20/20 · 26/26 PASS** |
| model-secret-scan / model-performance | **13/13 checks · 10/10 checks PASS** |
| migration（含 v8） | 18 / 18 PASS |

分支 feature/d4-01-model-service，基线 feature/d3-05-identity-data-gate @ 00c079a，未 merge main。
ADR：docs/decisions/D4-01-model-service.md；报告：docs/D4-01-RESULT.md。

## 3. 本轮冻结

1. `HARNESS_RAW_PROVIDER_KEY = FORBIDDEN`；Provider key 不进 env/argv/ACP/prompt/tool schema/logs/audit/renderer。
2. Credential 只存 credentialRef；raw secret 只进 OS 安全后端；**无 plaintext fallback**。
3. Model 配置权威在 OpenArc；复用 D3 Identity/App Principal/App Grant，无第二套 Model ACL。
4. Endpoint：远程必须 HTTPS、拒绝危险协议/metadata/URL 凭据；redirect 不转发凭据。
5. 默认 0 次隐藏 retry；tool-call 仅数据、0 执行。
6. Provider 原始响应体/错误体不原样回传；错误只归一化为安全错误码（Closure E error echo 攻击 0 raw hit）。
7. Proxy capability 完整 bearer 不落盘（DB/audit/logs/Renderer/Resource/model_call_records/artifact），只活在进程内存或可信 child env。
8. `MANAGE` 对 `ORGANIZATION` 的 provider 与 config 都要求 Super Admin；`credential/status` 只对 manager 返回 secure backend metadata（Closure F 修复）。

## 4. 主要缺口

Windows（Credential Backend / Proxy Runtime / Firewall / Settings UI）NOT VERIFIED；External Provider 真机接入（带入 D4-02 / D4-04，最晚 Vertical Smoke 前关闭）。

## 5. D4-02 准入

**CONDITIONAL GO**：ACP ONLY；`HARNESS_RAW_PROVIDER_KEY = FORBIDDEN`；Harness 只与 OpenArc Model Proxy 通信；只接收 Proxy endpoint + scoped capability + safe model snapshot；不拥有 persistent task queue / persistent task state / side-effect retry / tool authorization / production tool execution。**D4-03 = BLOCK**，直到 D4-02 自身 PASS。

---

# D4-02 当前状态（唯一口径 · 2026-09-15）

## 1. Task Status

| 口径 | Task Status | 说明 |
|---|---|---|
| **D4-02A Task Domain / Persistent Authority** | **PASS** | schema v9：tasks/task_steps/task_model_calls/task_events；显式状态机 + revision 乐观并发 + append-only events（与 state 同一事务）；D3 授权 + owner+app 隔离；model snapshot 冻结 + `MODEL_CONFIG_CHANGED`；cancel 持久化；重启 RUNNING→BLOCKED/`RECOVERY_REQUIRED`；AUTO_RETRY=0；tool execution=0 |
| **D4-02B Official ACP Harness Adapter** | **PASS** | 官方 `@deepseek-ai/dsh@0.1.5-rc.2` + ACP v1 + `@agentclientprotocol/sdk@1.4.0` stdio；Harness → OpenArc Model Adapter → Model Proxy → Provider；隔离 DSH_HOME + env scrub；工具/MCP/直连/retry 全关；permission 一律 reject；`test:d4-02b` **16/16** |
| **D4-02C Task ↔ Harness Orchestration** | **PASS** | 真实垂直链路 Task→Step→Harness→ACP→Model Proxy→Fake Provider→Artifact→Verification→SUCCEEDED；schema v10（task_harness_runs/task_artifacts/task_verifications）；ACP→TaskEvent 显式 mapping；成功必须 Artifact+Verification PASS 且同一事务；cancel 两阶段 + race 唯一解；crash/timeout/restart→BLOCKED/RECOVERY_REQUIRED 0 replay；tool 0 execute；permission reject；MCP=0；capability executionBinding + 立即 revoke；test:d4-02c **22/22** |
| **D4-02 macOS Task / Harness Core** | **PASS** | A/B/C PASS |
| **D4-02 cross-platform overall** | **PARTIAL** | Windows NOT VERIFIED |
| **D4-02 · F-2 产品入口模型配置绑定（2026-09-18 修复，被测 commit `c7302dc`）** | **PASS** | 产品入口 `task/run` 由后端解析并冻结 config id/version（renderer 自报被忽略、不落凭据）；配置改版后 run / 附加步骤 / 显式续接一律显式 `MODEL_CONFIG_CHANGED` 并收敛 BLOCKED（0 capability / 0 call / 0 artifact），默认切换不静默跟随；`issueCapability(expectedModelConfigVersion)` 关闭“读版本→签发 capability”窗口；ModelProxy 每请求 STALE_CAPABILITY 与 `info.modelConfigVersion` 比对保留；旧任务同一事务懒绑定 + `task.model_config_bound` 事件（`reason=LEGACY_UNBOUND_LAZY_BIND`，不伪造历史版本）；新增 `tests/d4-03-model-binding.test.mjs` **12/12** + 真实 main flow6 **13/13**；独立复核 CLOSED。遗留：R-8（懒绑定前默认迟到窗口内归属为 null，需产品裁决） |
| **D4-03 Controlled Tool Proxy** | **BLOCK（C PASS 后 CONDITIONAL GO，不自动开始）** | 直到 D4-02 自身 PASS |

## 2. 关键证据（真实执行）

| 入口 | 结果 |
|---|---|
| test:d4-02a | **22 / 22 PASS** |
| test:d4-02b | **16 / 16 PASS**（dsh 0.1.5-rc.2 / ACP SDK 1.4.0 / protocol 1） |
| test:d4-02c | **22 / 22 PASS**（schema v10；e2e/cancel/recovery/security/migration） |
| test:d4-01 | **59 / 59 PASS** |
| npm test | **582 / 582 PASS** |
| migration（含 v9→v10 + rollback） | PASS |
| npm run build | PASS |
| test:security（D1-05） | FAIL 0 / PARTIAL 2 / PASS 6 |
| security-surface（D2-02 A13） | 15 / 15 PASS |
| perf smoke（本机，非 SLA） | create100 ≈27.1ms / append1000 ≈18.5ms / load ≈0.113ms / list100 ≈0.367ms |

分支 feature/d4-02-task-harness，基线 feature/d4-01-model-service @ 5afece6，未 merge main。
ADR：docs/decisions/D4-02-task-authority.md；报告：docs/D4-02A-RESULT.md。

## 3. 本轮冻结

1. `OpenArc = Task Authority；Harness = Reasoning Runtime`。Harness 永不拥有 persistent queue/state/step/retry/tool/lease/permission authority。
2. Task 状态机固定 7 个状态；终态不可变。
3. 所有 mutation 必须带 `expectedRevision`；冲突返回 `TASK_REVISION_CONFLICT`；禁止 silent last-write-wins。
4. state mutation 与 TaskEvent 同一事务；event sequence 每 task 严格递增。
5. `AUTO_RETRY = 0`；`attempt = 1`；`maxAttempts = 1`。
6. `TOOL_EXECUTION = FORBIDDEN`；D4-02A side effect execution = 0。
7. `UNKNOWN EFFECT → VERIFY / BLOCK`：重启 RUNNING → BLOCKED / `RECOVERY_REQUIRED`，0 replay / 0 retry。
8. 无第二套权限系统：禁止 `task_acl` / `task_role` / `task_permissions`；复用 D3 Identity/Authorization。
9. Harness 只经官方 ACP v1 over stdio 接入；`HARNESS_RAW_PROVIDER_KEY = FORBIDDEN`；Harness 只经 OpenArc Model Proxy（Harness Model Adapter），只接收 endpoint + scoped capability + safe snapshot。
10. 每次 Harness run = disposable 隔离 DSH_HOME（绝不用真实 `~/.dsh`）；显式 env allowlist + secret scrub。
11. 官方 managed profile：工具 / MCP / 直连 Provider / retry / interactive login 全关；permission 一律 reject；production tool execution = 0。
12. Harness session persistence 非权威：OpenArc 恢复只认 Task DB / TaskEvent / revision / `RECOVERY_REQUIRED`。
13. Orchestrator 不是第二 authority：不保存 task/step status、revision、queue、retry、permission state；所有持久 mutation 经 TaskService，绝不直写 SQLite。
14. ACP event 只经显式 mapping 落 safe TaskEvent；Harness event 不能改 Task/Step status；终态只由 Orchestrator 决定。
15. 成功必须有 `Artifact persisted + Verification PASS`，且 Artifact/Verification/Step/Task/Events 同一事务；assistant says done != Task succeeded。
16. Cancel 两阶段：先持久 `cancel_requested=1` → ACP cancel → revoke capability → finalize；race 用 revision 保证唯一解，禁止 `Task CANCELLED + Step SUCCEEDED`。
17. tool proposal = 0 execute → `BLOCKED/TOOL_EXECUTION_NOT_AVAILABLE`；permission 一律 reject → `BLOCKED/PERMISSION_NOT_AVAILABLE`；`mcpServers=[]`。
18. capability 加 executionBinding（task/step/run）+ turn 结束立即 revoke，不等 TTL；A run token 不能用于 B run。

## 4. 主要缺口

D4-02B 遗留继续挂账：OS-level network isolation NOT VERIFIED；external workspace read audit NOT VERIFIED；independent malformed ACP injection NOT VERIFIED；Windows NOT VERIFIED；External Provider NOT VERIFIED。OS sandbox/network 属 D1-05，不因 C PASS 自动关闭。Explicit Resume = DEFERRED（不阻塞核心 PASS）。

## 5. D4-03 准入

**CONDITIONAL GO**（D4-02C PASS 后），但**不自动开始**：在 D4-03 之前 production tool execution = 0、MCP = 0。**D4-03 Controlled Tool Proxy = BLOCK**，直到人工开启。

---

# D4-03 当前状态（唯一口径 · 2026-09-15 · Final Closure）

## 1. Task Status

| 口径 | Task Status | 说明 |
|---|---|---|
| **D4-03A Tool Contract / Registry / Authorization Gate** | **PASS** | Registry 权威（test.echo / test.write / resource.read.metadata，无 shell/mcp）；Tool Proposal + Decision 持久（schema v11）；D3 授权复用（含 useByAgent）；ResourceRef 强制；risk 来自 Registry；READ_ONLY → ALLOWED、WRITE → APPROVAL_REQUIRED；ExecutionPlan dry-run；production tool execution = 0；test:d4-03a **32/32** |
| **D4-03B Controlled Read-only Execution（执行引擎 + official dsh 暴露 + 真实执行 E2E）** | **PASS** | 真实 READ_ONLY 执行：resource.search + resource.read.metadata 经真实 Resource/Search Domain；reauthorize-before-execute；tool_executions（schema v12）；duplicate 0 二次执行；cancel/revoke/delete race PASS；outputSchema + redaction；0 mutation。official dsh 工具暴露 **VERIFIED**（openarc-acp profile + plugin 注册 exactly 2 tool）；**official dsh 真实 tool_call 执行 E2E = PASS**（Tool Facade Bridge → ControlledToolProxy → Domain → dsh Tool Runtime → Task SUCCEEDED）；test:d4-03b **59/59** |
| **D4-03C1 Side-effect Authority / Approval / Lease Contract** | **PASS candidate** | Proposal→Decision→Plan→Approval→Lease→Execution Eligibility 六层合同；schema v13（side_effect_calls / tool_approvals / side_effect_leases）；UNIQUE(call_id)+UNIQUE(idempotency_key)；Approval 只来自 trusted user、精确绑定 planHash/tool/version/argsHash/effectClass；每 call 至多 1 ACTIVE lease；**recoverOnStartup fail closed（删除 blockTask，RUNNING→UNKNOWN_EFFECT + Step/Task BLOCKED + 旧 lease EXPIRED，0 replay/retry）**；**真实 lease contention（2 child executor 同 DB → 1 winner / 1 CONFLICT / 1 ACTIVE）**；真实 persisted restart；WRITE execution = 0；test:d4-03c1 **46/46**、test:d4-03c1-closure **50/50** |
| **D4-03C2 Controlled Reversible Write** | **PASS candidate** | 第一条真实 production REVERSIBLE_WRITE：**resource.trash → ResourceService.delete**；contract 显式 executionPolicy=CONTROLLED_REVERSIBLE_WRITE（其余 write tool 仍 WRITE_EXECUTION_DISABLED）；真实 Domain plan（只读，expectedVersion/expectedEffects 来自 Domain）；Approval+Lease 必须；**原子 claim LEASED→RUNNING 后才 dispatch**（唯一 executor）；Domain invocation exactly 1 / business mutation exactly 1；业务乐观并发（mutation transaction 内 re-read + expectedVersion）→ VERSION_CONFLICT = SIDE_EFFECT_PRECONDITION_CHANGED（0 mutation）；**Execution != Verified Effect**：真实 Domain verifier PASS 才 SUCCEEDED；verifier 不可判 → UNKNOWN_EFFECT + Task/Step BLOCKED（0 retry）；lease SUCCEEDED 后 RELEASED；真实 ResourceService.restore 证明可逆；schema 保持 v13；test:d4-03c2 **29/29** |
| **D4-03C2 Closure Execution Ownership / Atomic Claim** | **PASS candidate** | **runtime instance ownership 强制**：execution ownership = callId + leaseId + holderId + holderInstanceId，缺任一 → LEASE_NOT_HELD / 0 mutation（禁止 optional authority）；**claim 事务内重校验 authority snapshot（eligibility→claim TOCTOU fix）**：Task/Step/Run/session/app/tool permission/resource permission/useByAgent/approval/lease/precondition 全部重新读取，任一变化 fail closed；**真实跨进程 duplicate claim contention**（2 child、同一合法 executor identity、同一 disk-backed DB → 恰好 1 winner / 1 CLAIM_LOST / 1 Domain invocation / 1 RUNNING transition）；真实 persisted restart 下旧 instA ACTIVE lease → EXPIRED，instB / 旧 identity 均不能继承；0 raw SQLITE_BUSY；schema 保持 v13；test:d4-03c2-closure **38/38** |
| **D4-03C2 Closure-2 Runtime Instance Authority / Exact Lease Binding** | **PASS candidate** | **runtime identity 是 OpenArc 自身事实**：production `executeSideEffect({callId, leaseId, holderId})` 不再接受 caller 的 `holderInstanceId`（传入也完全忽略），判断一律 `lease.holderInstanceId === this.instanceId`；`acquireLease` 绑定 `this.instanceId`（仅 `_testInstanceId` test-only seam）；**exact leaseId 是 claim authority**：eligibility 与 claim 事务内都重新校验 `leaseId + holderId + runtime instance + ACTIVE + expiry`；**lease replacement race**（同 holder/同 runtime，lease_A revoke + lease_B acquire → 旧 lease_A invocation DENY，fresh lease_B 才可执行）；**same-runtime duplicate delivery**（同 runtime 两次 invocation → 1 claim / 1 CLAIM_LOST / 1 Domain invocation）；**cross-process impersonation**（Runtime B 知道 instA 也 DENY / 0 mutation）；**claim-time approval exact binding**（planHash/argsHash/toolId/version/effectClass）；schema 保持 v13；test:d4-03c2-closure2 **45/45** |
| **D4-03C2 Closure-3 Runtime Identity Final Seal** | **PASS candidate** | **runtime identity 零 caller override**：删除 `acquireLease._testInstanceId`，lease 永远 `holderInstanceId = this.instanceId`（异 runtime lease 必须 `new SideEffectAuthority({instanceId})` 创建）；`recoverOnStartup()` 不再接受 `instanceId`，只用 `this.instanceId`（自己的 lease 保留、其它 instance 一律 EXPIRED）；**同 holderId 不同 runtime acquire → `SIDE_EFFECT_LEASE_CONFLICT`**（不再误判 duplicate）；Authority `evaluateExecutionEligibility` 注入 `this.instanceId`，caller 只能提供 callId/leaseId/holderId；disk-backed restart impersonation（Runtime B 知道 instA 也无法保留旧 lease）；exact lease claim / lease replacement / same-runtime duplicate execution 无回归；schema 保持 v13；test:d4-03c2-closure3 **51/51** |
| **D4-03 overall** | **PASS candidate（内部独立预审通过，本轮不封板）** | A PASS；B PASS；C1 PASS；C2 PASS；C3 PASS candidate（含 Closure）；C4 PASS candidate；D PASS candidate。**第四轮 D4-03 Closure（`dc53c64` + `b031b36`，test-only 收尾 `68c84c9`）：按 Boss 已批准规则实现批准资格执行期重判（A3）、撤销已批准产品入口（A18）、迟到操作逐字反馈（A20）；干净树 D4-03 十六门禁全绿（C4 UI 37/37）、真实 main E2E 连续 2 次 140/140、`npm test` 1099/1099**。**2026-09-18 独立审查（`docs/D4-03-INDEPENDENT-REVIEW.md`）三轮、统一编号 A1–A23 / B1–B13**：第一轮（`f63e87a`）闭合 A1、B1–B5；第二轮（`c7302dc`）按裁决修 F-2（B6）并闭合 B7/B8/A4/A7/A8；**第三轮（最终被测 commit `1594771`）按裁决闭合 A9/A10（DENY 状态前置：RUNNING/终态零变化、不覆盖执行事实）、A14（R-8：未绑定绝不建 run）、A16（推送/读取会话隔离）、A17（effectiveApproval 过期死代码）、A19（`deny_too_late` 事件登记）、A21（`resolveModel` 抛出收敛）、A23（approve 原子前置，DENY 决定不可复活）**，并修复 main E2E 的 UI 接受判据测试竞态（test-only）。封板仍须由**实现方之外的审查者**裁决（原文指名 ChatGPT），DeepSeek 无权封板；另有产品/UI 裁决待决（REV-03/S2、迟到 DENY 的 UI 反馈、`revokeApproval` 入口）。**第五轮 CG-01（`eccf01b`）：`acquireLease` 事务内状态保护已修（新增门禁 31/31 + 受影响租约/执行/恢复 52/52、51/51、63/63、11/11 全绿）** |
| **D4-03C3 Ambiguous Result / Idempotency / Crash Recovery** | **PASS candidate** | **真实 production UNKNOWN_EFFECT verification path**（不再依赖 test-only verifier）：SideEffectCall → exact historical Tool Contract（toolId+toolVersion+effectClass）→ allowlisted adapter → **read-only** Domain verifier（mutation=0）；三态 **APPLIED / NOT_APPLIED / INDETERMINATE**；**APPLIED** → SUCCEEDED(PASS)，**NOT_APPLIED 且 executionQuiesced=true** → FAILED(FAIL)，其它保持 UNKNOWN_EFFECT；**Late Result Rule**：live timeout quiesced=false，即使 verifier 看到 NOT_APPLIED 也不得提前 FAILED；**cold restart**（旧 runtime 死 + 新 runtime + 旧 lease EXPIRED）才 quiesced=true；真实 crash matrix（claim 前 / mutation 后 / verification 后 / SUCCEEDED 后，disk-backed child process）、late applied result、INDETERMINATE、concurrent verification 单一收敛、historical contract、tool disabled / session revoked 仍可 verification、UNKNOWN_EFFECT 不能 reacquire/execute、Task/Step 恢复后保持 BLOCKED、AUTO_RETRY=0、idempotencyKey 跨 restart 不变；**schema v14**（non-authoritative recovery_safe，新增 migration + 整级回滚）；test:d4-03c3 **56/56** |
| **D4-03C3 Closure Trusted Quiescence Authority** | **PASS candidate** | 永久规则 **different runtime instance != proof previous runtime is dead**；新增 trusted `RuntimeLifecycleAuthority`（supervisor-level 真实进程退出证明），`quiesced=true` 只能来自真实观测到的 runtime 退出；Lease EXPIRED/REVOKED/RELEASED 与 instanceId mismatch 单独**都不构成** quiescence；live UNKNOWN_EFFECT 持久化 `originRuntimeInstanceId/originLeaseId/source`；`recoverOnStartup()` reconcile 已持久化 `UNKNOWN_EFFECT(quiesced=false)`，仅在 trusted proof 成立时升级 `quiesced=true`（Call 仍 UNKNOWN_EFFECT，不推断 effect）；**two-live-runtime gate**（A live 时 B 不得声明 quiesced，早到 NOT_APPLIED 绝不 FAILED，A late mutation 后 APPLIED→SUCCEEDED）；timeout→真实进程死亡→NOT_APPLIED→FAILED；timeout→late applied→restart→APPLIED→SUCCEEDED；APPLIED 不依赖 quiescence；AUTO_RETRY=0；Task/Step 保持 BLOCKED；schema 保持 v14；test:d4-03c3-closure **63/63** |
| **D4-03C4 Side-effect Final Gate（production runtime + trusted approval + official dsh WRITE）** | **PASS candidate** | 唯一 production 装配 `SideEffectRuntime`（ToolRegistry → ControlledToolProxy → SideEffectAuthority → RuntimeSupervisor → SideEffectRuntime，不建第二套 authority）；**真实 mutation 只发生在受监督 executor runtime 子进程**（acquireLease + claim + ResourceService.delete + Domain verify），主进程 0 in-process write；trusted `RuntimeSupervisor` 是唯一 `registerRuntime/observeExit` 调用方（真实 child 'exit' 自动 observation；cross-restart 用 reachability probe + persisted trusted EXITED proof，绝不用内存旧 authority 自我证明）；`observeExit/registerRuntime` 不导出给 Renderer/IPC/ACP/Harness/Facade；**READ_ONLY 与 SIDE_EFFECT_PROPOSAL 两条 route 显式分离**（WRITE 绝不经 READ_ONLY execution；bridge 只回 `SIDE_EFFECT_APPROVAL_REQUIRED`）；**Trusted Approval Gateway**（Renderer 只能发 `{approvalRequestId, decision}`；sessionRef/appId/risk/planHash 全部主进程推导）；**Approval UI = IMPLEMENTED / VERIFIED**（真实 Electron probe 22/22，无绝对路径/store root/secret 泄漏）；**official dsh WRITE E2E**（proposal → AWAITING_APPROVAL → trusted approve → 受监督 exactly-once → verified → dsh 继续 → Task SUCCEEDED）；Deny / timeout / cancel / session·app·permission·useByAgent revoke / precondition race / double approve / duplicate delivery / concurrent executor / approval revoke race / task cancel race 全部 0 mutation；UNKNOWN_EFFECT 绝不把 unverified 结果交给 Harness（Task/Step BLOCKED）；**经 UNKNOWN_EFFECT 的 APPLIED 也不得自动续接 Harness**；restart 不给 pending WRITE 任何自动执行权；No Direct Domain Bypass 静态审计 PASS；schema 保持 v14；AUTO_RETRY=0；test:d4-03c4 **35/35** + UI **22/22**；**D4-03C4 Closure** 修掉 cold-restart liveness probe 的 boolean 误判（见下一行） |
| **D4-03C4 Closure Cold-restart Runtime Quiescence Probe must fail closed** | **PASS candidate** | 唯一 blocker = `probeUnixSocket` 把 timeout / 任意 socket error 都当成"已死"并写 `OS_EXECUTOR_SOCKET_GONE`。已改为**永久 tri-state**：`ALIVE / DEFINITELY_GONE / UNKNOWN`（Probe failure is not death proof）；只有 `DEFINITELY_GONE`（白名单当前仅 `ENOENT`）允许 `RuntimeLifecycleAuthority.observeExit()`；`timeout / EACCES / EMFILE / ENFILE / ENOBUFS / ECONNREFUSED / 任意未知 errno / probe 自身异常 / 旧 boolean 返回值` 一律 `UNKNOWN → fail closed`（不 observeExit、不 quiesced、persisted record 保持 ACTIVE、只记 `runtime_liveness_unknown` safe 事件）；`rehydrate()` 统计改为 `alive / dead / unknown`（UNKNOWN 不得归入 dead）；`RuntimeLifecycleAuthority` 本身未改宽松（UNKNOWN→false / ACTIVE→false / EXITED→true）；`ECONNREFUSED` 刻意不视为 DEFINITELY_GONE；真实盘上 E2E：`cold restart + probe UNKNOWN → quiesced=false → NOT_APPLIED 也绝不 FAILED → Call 保持 UNKNOWN_EFFECT + Task/Step BLOCKED + 0 retry / 0 second call / 0 lease reacquire / 0 Domain mutation`；`probe DEFINITELY_GONE + NOT_APPLIED → FAILED`；`probe ALIVE → UNKNOWN_EFFECT`；late-effect safety：early NOT_APPLIED 绝不 false-negative，随后 APPLIED → SUCCEEDED；producer 侧加固：executor bind lifetime endpoint 失败时绝不执行 write（`endpoint_bind_failed` + exit 3）；schema 保持 v14；test:d4-03c4-closure **15/15**（**已由 Closure-2 收紧**：ENOENT 也不再是 death proof；见下一行） |
| **D4-03C4 Closure-2 Cold-Restart Death Proof** | **PASS candidate** | 两个互相关联的 quiescence authority blocker：① **ENOENT / pathname absence 不能作为 executor process death proof**；② **persisted executor record 不得保存/提供 socketPath 给 liveness authority**。永久规则 **Unix socket pathname existence != process lifetime**（pathname has been unlinked != bound/open socket process is dead）；`LIVENESS` 收敛为 **ALIVE / UNKNOWN** 两态，`DEFINITELY_GONE` / `DEFINITELY_GONE_ERRNOS` / `OS_EXECUTOR_ENDPOINT_ABSENT` 彻底删除；ENOENT / stale / ECONNREFUSED / timeout / 任意 errno / probe 异常一律 `UNKNOWN → fail closed`（不 observeExit、不 quiesced、persisted record 保持 ACTIVE、只记 `runtime_liveness_unknown`）；trusted death proof 只剩两个来源：同一 supervisor lifetime 的真实 `child.on("exit")`（reason `SUPERVISOR_OBSERVED_EXIT`）与上一次 production supervisor 真实观测后持久化的 trusted `EXITED`（reason 白名单 `SUPERVISOR_OBSERVED_EXIT` / `EXECUTOR_SPAWN_FAILED`），非 trusted reason 的 EXITED 一律 fail closed；`rehydrate()` 统计 `alive / dead / unknown / invalid`（UNKNOWN 绝不归入 dead）；**persisted record 只保存 safe binding（无 socketPath）**，probe path 永远由 validated `instanceId`（`^exe_[A-Za-z0-9_-]{1,64}$`）重新派生；malformed / traversal / separator / NUL / absolute / oversized record 一律忽略，绝不 probe / persist / observeExit；legacy socketPath 一律忽略；schema 保持 v14；test:d4-03c4-closure2 **12/12**（Adversarial Live-Unlink、persisted record contract、path traversal、legacy socketPath spoof、trusted vs untrusted EXITED、real same-supervisor child exit、live-unlink + late mutation E2E） |
| **D4-03C4 Closure-3 Durable Exit Proof Authority Seal** | **PASS candidate** | 唯一 blocker = **persisted EXITED runtime JSON 不得自身成为 trusted process-death authority**。永久规则：`Persisted data saying "SUPERVISOR_OBSERVED_EXIT" != Supervisor actually observing exit now`；普通 durable JSON 字段（`status / reason / exitCode / signal / endedAt`）没有资格让 `quiesced=true`。**彻底删除 reason 白名单 authority**（`TRUSTED_EXIT_REASONS` 不再存在）；当前实现唯一 trusted death proof = 同一个仍然活着的 production `RuntimeSupervisor` 真实观测到的 `child.on("exit")`。cold restart 对任何 persisted `status=EXITED`（含 `SUPERVISOR_OBSERVED_EXIT` / `EXECUTOR_SPAWN_FAILED`）一律 `UNVERIFIED_PERSISTED_EXIT → 不 observeExit → quiesced=false`，persisted record 不被改写，内存视图 fail-closed 成 ACTIVE；`rehydrate()` 统计新增 `unverifiedExit`，`dead` 恒为 0。真实的 cross-restart **authenticated durable lifecycle proof = DEFERRED / NOT VERIFIED**（禁止用 reason 白名单 / magic field / trusted=true / checksum without secret / filename convention 冒充）。真实对照 Gate：real same-supervisor child exit → quiesced=true；手工 forged EXITED（两种 reason）→ observeExit=0 / quiesced=false；ENOENT / live-unlink / stale / timeout / 任意 errno 保持 UNKNOWN；same-lifetime real EXIT + NOT_APPLIED → FAILED；UNKNOWN + NOT_APPLIED → 保持 UNKNOWN_EFFECT + BLOCK；UNKNOWN + APPLIED → SUCCEEDED；AUTO_RETRY=0 / 0 second call / 0 lease reacquire / 0 Domain replay；schema 保持 v14；test:d4-03c4-closure3 **9/9** |
| **D4-03D Full Tool Proxy Gate** | **PASS candidate** | 把 D4-03A/B/C 收敛成最终统一、不可绕过的 Tool Proxy：official dsh → ACP v1 → OpenArc Tool Plugin → Tool Facade Bridge（每 run 一个 loopback + 一个 `tpx_`）→ 按 Registry riskClass 决定 route。**Full Route Matrix 冻结**：`READ_ONLY` = Proposal → Decision → Reauthorization → Controlled Execution → Verification；`SIDE_EFFECT_PROPOSAL` = Proposal → Decision → SideEffectPlan → Approval → Lease → Controlled Execution → Verification；unknown / irreversible / external / privileged = BLOCK（无第三条隐藏 route）。**单 Facade / 单 Registry projection**（同 run 一个 bridge / 一个 capability）；READ 绝不创建 SideEffectCall/Approval/Lease，WRITE 绝不经过 `executeReadOnly`。**tpx capability** 绑定 session/app/task/step/run/allowedTools/maxCalls/expiry；body 自报 scope 一律忽略；只活进程内存，**tpx_/mpx_ 0 落库 / 0 落 artifact**；**tpx != mpx**（互打 401）；lifecycle ACTIVE → EXPIRED / EXHAUSTED / REVOKED；cross-run/cross-task/cross-step replay DENY；app mismatch SCOPE_INVALID；session / tool permission / resource permission revoke 后下一次 call DENY + 0 Domain。Registry contract stale → `TOOL_CONTRACT_STALE`（READ/WRITE 都不静默 fallback）。duplicate delivery：同 callId 返回既有结果且**不消耗 maxCalls**；并发 duplicate 只 1 次 effect。malformed body（invalid JSON / oversized / missing / bad toolId / not allowlisted / wrong type / schema / forbidden field）与 argument authority spoof 全部 DENY + 0 Domain。**official dsh 混合 READ+WRITE E2E**：一条 Task 内 search → read.metadata → trash proposal → trusted approve → 受监督 exactly-once verified → Task/Step SUCCEEDED；混合 UNKNOWN_EFFECT → Task/Step BLOCKED（READ 成功也不能覆盖）；mixed cancel → 0 write / 0 lease / capability revoked；bridge disconnect 不返回 stale 结果、不自动 approve；bridge stop 后旧 token 不可用；loopback-only 127.0.0.1。`DEFAULT_MAX_CALLS` 4 → 8（支持混合 turn 的 verified-continuation，仍 bounded，AUTO_RETRY=0）。schema 保持 v14；test:d4-03d **52/52**；artifact `artifacts/d4-03d/full-tool-proxy-gate.json` |
| **D4-03D Closure Tool-call Identity Seal** | **PASS candidate** | 两个同源 blocker：① Tool Facade 允许 missing callId 继续执行；② `runId + callId` dedupe 没有绑定 toolId + arguments identity。永久冻结 **Tool Call Identity = runId + callId + toolId + canonical arguments fingerprint**。**callId mandatory**：`typeof === string && trim().length >= 1 && length <= 256 && 无 NUL / C0 / C1 控制字符`；missing / invalid → `400 TOOL_CALL_ID_REQUIRED`，且发生在 budget++ / ToolProposal / ToolExecution / SideEffectCall / Approval / Lease / Domain call 之前（0 budget / 0 authority）；official dsh plugin 缺失 `exec.callId` 本地 fail closed（0 Tool Facade request），Bridge 是最终 Authority Gate（双层）。顺序冻结：authenticate → TTL/state → parse → validate toolId → validate callId → contract freshness → fingerprint → identity binding → **原子 reserve budget** → execute；绝不 execute first → dedupe later。identity binding = `callId → { requestFingerprint, toolId, pending, outcome }`：exact duplicate（same callId + toolId + arguments fingerprint）→ await 同 pending / 返回同 outcome（0 second execution / 0 extra budget）；callId conflict（same callId 但 toolId 或 canonical args 不同）→ `409 TOOL_CALL_ID_CONFLICT`，0 Domain / 0 SideEffectCall / 0 mutation / 0 approval / 0 lease / 0 extra budget，绝不返回旧 result / 绝不覆盖原 binding。READ→WRITE / WRITE→READ / WRITE A→WRITE B / same-tool-different-args 全部走同一 conflict gate；terminal WRITE replay 返回原 binding、0 second SideEffectCall。maxCalls=1 并发 unique call 恰好一个成功、另一个 `TOOL_CAPABILITY_EXHAUSTED`（check + increment 同步原子）。Harness callId 绝不成为 SideEffectCall authority id（OpenArc `newId("scall")` 生成）。不新增 DB table（`callsById` 仍内存级）；schema 保持 v14；test:d4-03d-closure **62/62**；artifact `artifacts/d4-03d-closure/d4-03d-closure-gate.json` |
### 1.1 D4-03 独立审查与收口（2026-09-18；第一轮 `f63e87a`，第二轮 `c7302dc`，第三轮 `2c5dc29` + `51f90f0` + `42ebe3b` + `1594771`，**第四轮 D4-03 Closure：`dc53c64` + `b031b36`**）

- **依据**：`PLAN.md:498` 验收（授权执行及回报；重复调用与离线结果处理正确）+ 封板条件 `docs/D4-03C4-RESULT.md:14` / `docs/decisions/D4-03C-side-effect-authority.md:511`（DeepSeek 无权封板，由实现方之外的审查者裁决）。
- **审查者独立性**：两名子 Agent 均为派工前未接触实现的独立实例；只读仓库（审查前后 `git status` 一致）、探针仅写 `/tmp`、不以测试全绿代替结论。与实现方同源 → **内部独立预审，不是外部审计**。
- **已确认并修复（同一审查者复核 CLOSED）**：REV-01（`TaskHarnessOrchestrator.runTask()` 第三条启动入口无未决副作用守卫 → UNKNOWN_EFFECT 期间可执行第二条 WRITE 且任务被写成 SUCCEEDED）；F-1 + R-1/R-2/R-3/R-5'（工具参数与失败验证证据的持久化去敏契约被破坏：绝对路径 / 明文 `tpx_` / secret 形态落库；执行入参与落库投影解耦、冷缓存回退 fail closed）。
- **第二轮（`c7302dc`，按裁决修实现 + 逐项澄清）**：**F-2 已修**——真实产品入口 `task/run` 由后端解析并冻结 model config id/version（不信 renderer 自报、不落凭据）；配置改版后 run / 附加步骤 / 显式续接三入口一律显式 `MODEL_CONFIG_CHANGED` 并收敛 BLOCKED（0 capability / 0 call / 0 artifact）；默认切换不静默跟随；`issueCapability(expectedModelConfigVersion)` 关闭“读版本→签发 capability”窗口；旧任务同一事务懒绑定 + `task.model_config_bound` 事件（不伪造历史版本）。**新确认并闭合**：S1（迟到 SUCCEEDED 覆盖权威 UNKNOWN_EFFECT）、S1-b（失败类迟到写回同类覆盖）、A-4（终态 call 遗留 ACTIVE lease：终态与 lease 终结同事务 + recover 归属回收 + deny 回收）、R-1'（裸单段 + POSIX 双斜杠绝对路径落库）、R-7、R-9。**逐项澄清未关闭项**（REV-02 / REV-03+S2 / A-5 / A-6 / S3 / R-8 / R7 / R6-C2C3 / R3 / R4 / R-4' / N-1 / R-6 / [REDACTED] 误拒）见 `docs/D4-03-INDEPENDENT-REVIEW.md` §4（含契约/位置/分类/可达性/后果/防护层/封板影响）。
- **实际检查（干净树，被测 commit `c7302dc`）**：D4-03 十六门禁全绿（A 32/32、B 59/59、C1 48/48+52/52、C2 29/29+38/38+45/45+51/51、C3 56/56+63/63、C4 35/35+UI 22/22+15/15+12/12/9/9、D 52/52+62/62）；D4-01 59/59、D4-02a/b/c 22/16/22；D4-04 94/94、D4-05 173/173、D4-06 119/119、d4-06-resume 21/21、d4-08 13/13、d4-08-verification-ui 22/22；新增测试 `tests/d4-03-model-binding.test.mjs` 12/12、`tests/d4-03-lease-state-integrity.test.mjs` 10/10、`tests/d4-03-run-entry-guard.test.mjs` 7/7、`tests/tool-argument-projection-redaction.test.mjs` 21/21；真实 main **133/133（七条必需流程含 flow6 13/13）exit 0、workspaceState 为空**；`npm test` **1061/1061**；`npm run build` exit 0。
- **第三轮（拒绝操作状态保护 + 旧任务配置绑定收口，最终被测 commit `1594771` = `2c5dc29` + `51f90f0`（test-only）+ `42ebe3b` + `1594771`）**：① **A9/A10 闭合**——`denySideEffect` 判定+变更同一事务、事务内重读 persisted status，仅 `AWAITING_APPROVAL/APPROVED/LEASED` 可拒绝；`RUNNING`/终态一律 `SIDE_EFFECT_APPROVAL_TOO_LATE` + **状态零变化** + safe audit/event，不中止执行、不覆盖 `UNKNOWN_EFFECT`/`SUCCEEDED`，重复 DENY 幂等；真实 Electron UI 探针 **28/28**。② **A23 闭合**（收尾自查）：`approveSideEffect` 的"读状态 + 写 APPROVED"跨两事务可让已被 DENY 的 call **复活**，已合并为同一事务 + 状态前置（修复前副本 12 用例 fail 2 → 修复后 12/12）。③ **R-8 按裁决修实现**：未绑定 + 无可用默认 → **绝不建 run**（三入口 + `task/run` IPC 实测 0 run / 0 capability / 0 模型请求 / 0 工具执行 / 0 artifact，Step/Task BLOCKED；默认迟到后重新解析+绑定并真实成功；历史行绝不回填；反例 8 条命中 0）。④ **A16/A17**：审批推送按当前会话重投影 + `approvalSnapshot` 严格化（他人/未登录 0 推送、读路径 NOT_FOUND）；`effectiveApproval` 过期分支死代码修复（执行判定 parity 逐字不变）。⑤ **A19/A21/A24**：`tool.side_effect.deny_too_late` 登记进冻结清单；`resolveModel` 抛出与返回失败同形收敛（未绑定 + 已绑定两条路径均不留 RUNNING/STARTING 悬挂，已签发 capability 事后 REVOKED）；另登记 **A26**（其余 4 处调用点未转显式错误码，不产生悬挂）。⑥ main E2E F6.4/F6.7/F6.8/F6.10/F6.11 与 F4.43 的"点完 UI 立刻读旧终态"测试竞态以产品桥接受判据修复（test-only，断言只收紧不放宽）。
- **第三轮干净树实际检查（最终被测 commit `1594771`、`workspaceState=""`）**：D4-03 十六门禁全绿（A 32/32、B 59/59、C1 48/48+52/52、C2 29/29+38/38+45/45+51/51、C3 56/56+63/63、C4 35/35+**UI 28/28**+15/15+12/12/9/9、D 52/52+62/62）；d4-02a 22/22、d4-02c 22/22；D4-04 94/94、D4-05 173/173、D4-06 119/119 + resume 21/21 + 失败验证 UI 22/22；新增/受影响 node 套件 **77/77**；真实 main E2E **连续 2 次 133/133（七条必需流程全 PASS）exit 0**；`npm test` **1088/1088**；`npm run build` exit 0。
- **封板判定**：**D4-03 维持 PASS candidate，本轮不封板**。缺 ① 实现方之外的审查者的 PASS/FAIL 裁决；② 低危登记项处置（A2/A5/A6/A11/A12/A13/A15/A22/A25/A26、B10–B13、Closure 新增三项）。三项产品/UI 裁决已由 Boss 批准并在第四轮实现（见下条）。审查输入包已备齐（见 `docs/D4-03-INDEPENDENT-REVIEW.md` §7）。
- **D4-03 Closure（Boss 已批准三项产品规则；产品代码被测 commit `dc53c64` + `b031b36`，最终 test-only 收尾 `68c84c9`）**：① **批准有效期（A3/REV-03/S2）**——approval 有效性 = 内容绑定 + TTL + 显式撤销；**执行前按当前角色/账号状态/既有批准范围重判批准人资格**（不要求批准人拥有执行主体全部权限、不检查批准人 session）；可信批准人身份只取持久化批准行 `actor_user_id`，缺该字段 → `SIDE_EFFECT_APPROVER_UNVERIFIED` 保守拒绝；**执行分界 = claim 事务内 `LEASED→RUNNING` 原子转换**（eligibility 与 claim 事务内同一实现重判）——分界前失权拒绝并收敛（call BLOCKED + error_code + lease 同事务终结 + Step/Task BLOCKED、0 mutation），分界后不追溯；**仅登出/会话过期不撤销批准**。② **撤销已批准入口（A18）**——`sideEffect/revokeApproval`（renderer 只给 `approvalRequestId`；owner/ADMIN 后端核验）；仅 `APPROVED`/`LEASED` 生效并原子收敛（批准 REVOKED + call BLOCKED/`SIDE_EFFECT_APPROVAL_REVOKED` + lease REVOKED + Step/Task BLOCKED）；与 claim 竞争单一赢家；`AWAITING_APPROVAL` → `APPROVAL_REQUIRED`；`RUNNING`/终态 → `SIDE_EFFECT_APPROVAL_TOO_LATE` 零改写；重复幂等；撤销后旧批准不可再用；不新增重新批准/重试/恢复入口。③ **迟到反馈（A20）**——DENY/撤销迟到在既有提示区逐字显示既定文案并按后端权威刷新，不静默关闭、不显示"已取消/未执行"或机器码。④ **探针自查修正**：第十一轮 UI 探针 interleave 曾把同步 `decideApproval` 包成 async 导致假 `CALL_NOT_FOUND`，**第十一轮 A27 证据无效**，改回同步后由本轮 A27+A29 取代（独立复核复刻证实）。**干净树验证（产品代码 `b031b36` + test-only `68c84c9`、`workspaceState=""`）**：D4-03 十六门禁全绿（C4 UI 37/37）、d4-02a/c 22/22、D4-04 94/94、D4-05 173/173、D4-06 119/119 + resume 21/21 + 失败验证 UI 22/22、新增/受影响 node 套件 138/138、真实 main E2E 在 `68c84c9` 连续 2 次 140/140 exit 0、`npm test` 1099/1099。**D4-03 仍为 PASS candidate（不封板）**。
- **D4-03 CG-01（第五轮：租约申请事务状态保护，Base `c1cd9e0`，被测 commit `eccf01b2991253e56c87ed51778541838508a58f`）**：审计静态发现 `acquireLease` 在事务外读 call 判定 `APPROVED/LEASED`，事务内只重读 lease/approval 后**无条件**建 ACTIVE lease 并把 call 写成 `LEASED` —— 另一连接若已把 call 推进到 `RUNNING`/终态，旧读不足以支撑发放租约（**有效 approval ≠ 调用仍可执行**）。最小修复：**事务内重读 persisted status** + 只对 `APPROVED`/`LEASED` 发放 + 批准绑定改用事务内新快照 + **拒绝路径零写入**（过期 lease 的终结推迟到确认发放新租约之后）；既有正常/合法重复/不同执行器竞争/过期重租语义逐字保留。**验证（干净导出树 `git archive eccf01b`，只跑新增检查与受影响租约/执行/恢复回归）**：`test:d4-03-cg01` **31/31**、`test:d4-03c1-closure` **52/52**、`test:d4-03c2-closure3` **51/51**、`test:d4-03c3-closure` **63/63**、`tests/d4-09-append-step.test.mjs` **11/11**，全 exit 0；新测试在修复前副本（`c1cd9e0`）**1 pass / 8 fail**（区分力对照）；交错探针（既有事务边界探针 + 第二条真实 SQLite 连接）修复前 `RUNNING`/`SUCCEEDED`/`UNKNOWN_EFFECT` → `ok:true` + 新 ACTIVE lease + call `LEASED`，修复后一律 `SIDE_EFFECT_CALL_STATE` + call 行逐字不变 + 0 lease。**未实测第二次真实副作用/重复 Domain mutation；十六门禁其余部分、main E2E、`npm test`、build 沿用 `68c84c9` 已验结果，未在本轮 commit 上重跑。D4-03 仍为 PASS candidate（不封板）。**

## 2. 关键证据（真实执行）

| 入口 | 结果 |
|---|---|
| test:d4-03c1 | **46 / 46 PASS**（schema 13） |
| test:d4-03c1-closure | **50 / 50 PASS**（real contention + persisted restart + recovery fail-closed） |
| test:d4-03a | **32 / 32 PASS** |
| test:d4-03b | **59 / 59 PASS**（schema 12；facade + official dsh e2e/security/cancel/lifecycle） |
| test:d4-02c | **22 / 22 PASS** |
| test:d4-02b | **16 / 16 PASS** |
| test:d4-02a | **22 / 22 PASS** |
| test:d4-01 | **59 / 59 PASS** |
| test:d4-03c4 | **35 / 35 PASS**（+ Approval UI probe **22 / 22**） |
| test:d4-03c4-closure | **15 / 15 PASS**（fail-closed probe / rehydrate / disk-backed UNKNOWN + late-effect safety） |
| test:d4-03c4-closure2 | **12 / 12 PASS**（pathname != process lifetime；adversarial live-unlink；persisted record contract / traversal / spoof；same-supervisor trusted exit；live-unlink + late mutation E2E） |
| test:d4-03d-closure | **62 / 62 PASS**（closure 10 + D4-03D 52：mandatory callId / identity fingerprint / conflict / terminal replay / concurrent / maxCalls atomic / plugin fail-closed） |
| test:d4-03d | **52 / 52 PASS**（3 个新 D4-03D 文件 + official dsh facade/e2e/security/cancel/lifecycle + C4 dsh write；mixed READ+WRITE Task SUCCEEDED） |
| test:d4-03c4-closure3 | **9 / 9 PASS**（persisted EXITED 无 death authority；real vs forged 对照；unverifiedExit；same-lifetime FAILED / UNKNOWN_EFFECT / SUCCEEDED E2E） |
| npm test | **902 / 902 PASS** |
| npm run build | PASS |
| test:security | FAIL 0 / PARTIAL 2 / PASS 6 |
| security-surface（A13） | **15 / 15 PASS**（未新增 Renderer IPC） |
| READ_ONLY 真实执行 | search + read，real Domain，EXACT verification PASS；authorized 1 / unauthorized 0 Domain call |
| official dsh 工具暴露 | **VERIFIED**：managed openarc-acp profile 加载 OpenArc plugin，注册 exactly 2 tool（resource_search / resource_read_metadata）|
| official dsh 真实 tool_call 执行 E2E | **PASS**：3 model calls / 2 tool calls / 2 executions / Artifact + Verification PASS + Task SUCCEEDED；official dsh hidden search 0 leak；official dsh useByAgent DENY |
| Tool Facade 安全边界 | session/app/permission revoke / resource delete / cancel / crash / timeout / duplicate / contract stale / 跨域 / maxCalls / expiry 全部 DENY 正确 |
| production side-effect runtime | executor runtime **只由 RuntimeSupervisor 拥有**；主进程 0 in-process write；bridge WRITE route 0 execution row / 0 mutation |
| official dsh WRITE waiting/approval E2E | **VERIFIED**：proposal → AWAITING_APPROVAL（0 mutation/lease/execution）→ trusted approve → 受监督 exactly-once → verified → dsh 继续 → Task SUCCEEDED；3 model requests / 1 write tool call / 1 lease / 0 hidden retry |
| Approval UI | **IMPLEMENTED / VERIFIED**：真实 Electron probe 22/22；显示 Registry/Domain 推导字段；0 绝对路径 / store root / capability 泄漏；批准 / 拒绝都经 IPC 且不注入 actor |
| No Direct Domain Bypass | 静态审计 PASS：resourceService.delete 唯一调用点在 allowlisted adapter + 受控执行路径；Bridge / Runtime / Supervisor / Preload / ACP plugin / Approval UI 均不持有 Domain write |

分支 feature/d4-03-tool-proxy，基线 feature/d4-02-task-harness @ 5d37d64，未 merge main。
ADR：docs/decisions/D4-03-controlled-tool-proxy.md / docs/decisions/D4-03B-readonly-execution.md；报告：docs/D4-03B-CLOSURE-RESULT.md。

## 3. 本轮冻结

1. Harness proposes. OpenArc decides. OpenArc executes. OpenArc verifies.
2. OpenArc Tool Registry 是唯一权威；Harness 不能 register/enable/改 schema/改 risk。
3. ToolProposal != ToolExecution；execute() = forbidden；任何 decision 都 NOT_EXECUTED。
4. proposal 的 task/step/run/user/session/app 只来自 trusted context；忽略 payload 自报。
5. riskClass 来自 Registry（带 side-effect 语义），Harness 自报 risk 无效。
6. 复用 D3 AuthorizationService；Tool 权限 namespace 与 resource.action 同级，不建第二权限系统。
7. Agent proposal 强制 useByAgent；资源型 Tool 只接受 ResourceRef；禁止 credential / absolute path 字段。
8. READ_ONLY 可执行；WRITE/EXTERNAL/PRIVILEGED 必须 APPROVAL_REQUIRED，本阶段仍 0 执行。
9. 未来人工 UI 与 Agent 复用 same domain command / authorization / lock / audit，不为 AI 建后门。
10. execute 前必须 reauthorize（session/user/app/task/step/run/revision/tool/version/resource/useByAgent）；decision 不是长期授权。
11. Tool Adapter 只能静态 allowlist + 既有 Domain（ResourceService/SearchService）；禁止动态 require / raw SQL；inputSchema + outputSchema 双向验证 + redaction。
12. 同一 proposal 0 二次执行；AUTO_RETRY=0；timeout/失败 0 retry。
13. READ_ONLY 执行期间 Task/Step 保持 RUNNING；Tool result 才交回 Harness，Harness 不能伪造。
14. 人工 UI 与 Agent 复用同一 Domain。
15. 真实 mutation 只发生在**受监督 executor runtime 子进程**内；主进程绝不 in-process 执行 write。
16. `RuntimeSupervisor` 是唯一 `registerRuntime/observeExit` 调用方；quiescence 只能来自同一 supervisor lifetime 的真实 child `exit` 或已持久化的 trusted EXITED proof，绝不来自 pathname 存在性 / instanceId 差异 / lease 状态 / 时间流逝。
17. READ_ONLY 与 SIDE_EFFECT_PROPOSAL 是两条不合并权限语义的 route；WRITE 绝不经 READ_ONLY execution。
18. Approval 只来自 trusted OpenArc user action（main process 注入的 authenticated session）；Renderer 只能提交 `{approvalRequestId, decision}`。
19. 只有未经 UNKNOWN_EFFECT 的 direct verified success 才允许回到 Harness；经 UNKNOWN_EFFECT（含 APPLIED）一律 BLOCK，Explicit Resume = DEFERRED。
20. **Probe failure is not death proof.** filesystem unix-socket probe 只回答 `ALIVE / UNKNOWN`（reachability），没有 `PROCESS_DEAD` 结论；timeout / 任意 socket error / probe 异常一律 UNKNOWN → fail closed。
21. **Unix socket pathname existence != process lifetime。** ENOENT / pathname unlink 都不是 executor death proof；`ECONNREFUSED` / stale 同样不是（无法跨平台证明它们不是 timeout / backlog / 权限 / 资源耗尽的别名）；宁可 fail closed，不追求自动 recovery 成功率。
22. `rehydrate()` 的 UNKNOWN 必须单独计数、persisted executor record 保持 `ACTIVE`，绝不改写成 `EXITED`。
23. **Persisted runtime lifecycle record 不是 process-death authority。** trusted death proof 只来自同一个仍然活着的 production supervisor 真实观测到的 `child.on("exit")`；`status / reason / exitCode / signal / endedAt` 与任何 reason 字符串都不构成 proof。
24. persisted executor record 只保存 safe binding，**绝不保存 `socketPath`**；probe path 永远由 validated `instanceId` 重新派生，legacy `socketPath` 一律忽略；malformed / traversal instanceId 一律忽略，绝不 probe / persist / observeExit。
25. cold restart 对任何 persisted `status=EXITED` 一律 `UNVERIFIED_PERSISTED_EXIT → quiesced=false`，绝不 `observeExit`；authenticated durable cross-restart proof = DEFERRED / NOT VERIFIED，在其存在前 fail closed（不是 safety blocker：fail closed 到 UNKNOWN_EFFECT）。
26. **Full Route Matrix 冻结**：只有 `READ_ONLY` 与 `SIDE_EFFECT_PROPOSAL` 两条 route，route 由 Registry riskClass 决定（Harness 不能自报）；unknown / irreversible / external / privileged 一律 BLOCK。
27. **单 Facade / tpx capability 冻结**：同一 run 只有一个 Tool Facade + 一个 `tpx_` capability；scope 绑定 session/app/task/step/run/allowedTools/maxCalls/expiry；只活进程内存，绝不落库 / artifact；`tpx_ != mpx_`。
28. **READ 与 WRITE 路由不合并**：READ 只经 `ControlledToolProxy.executeReadOnly`（绝不创建 SideEffectCall/Approval/Lease）；WRITE 只经 `SideEffectAuthority`（绝不经过 `executeReadOnly`）；duplicate delivery 不消耗 maxCalls。
29. **Tool Call Identity 永久冻结**：`runId + callId + toolId + canonical arguments fingerprint`；canonical serialization 用 `fingerprint/kanon`（key sort），不依赖 JSON.stringify 的 key insertion order。
30. **callId mandatory**：non-empty bounded string（<= 256，无 NUL / C0 / C1）；missing / invalid → `400 TOOL_CALL_ID_REQUIRED` 且 0 budget / 0 authority；official dsh plugin 缺失 `exec.callId` 本地 fail closed（0 Tool Facade request）。
31. **Duplicate / Conflict contract**：exact duplicate = 0 second execution / 0 extra budget；callId conflict（toolId 或 canonical args 不同）= `409 TOOL_CALL_ID_CONFLICT` 且 0 authority、绝不返回旧 result；budget check + reserve 同步原子。

## 4. 主要缺口

OS-level network isolation NOT VERIFIED；external workspace read audit NOT VERIFIED；independent malformed ACP injection NOT VERIFIED；Windows NOT VERIFIED；External Provider NOT VERIFIED；Explicit Resume = DEFERRED；broader Domain verifiers NOT VERIFIED。
**已由 D4-03C4 关闭**：Final Approval UI = IMPLEMENTED / VERIFIED（真实 Electron probe）；official dsh WRITE waiting/approval E2E = VERIFIED。
**已由 D4-03C4 Closure 关闭**：cold-restart runtime quiescence probe 必须 fail closed（probe uncertainty / timeout / 任意 socket error != death proof）。
D4-03D **不关闭**任何既有 remaining gap：OS-level network sandbox / external workspace read audit / independent malformed ACP injection / Windows / External Provider / Explicit Resume / broader Domain verifiers / authenticated durable cross-restart process-death proof 全部继续挂账；Tool Facade 只监听 127.0.0.1 属应用层防线，**不等于** OS-level network sandbox。
**已由 D4-03C4 Closure-3 关闭**：persisted EXITED runtime JSON 不得自身成为 trusted process-death authority（reason 白名单 authority 已删除；只有 live supervisor child exit 能 quiesce）。
**新增挂账（非 safety blocker）**：authenticated durable cross-restart process-death proof = **DEFERRED / NOT VERIFIED**（当前 fail closed 到 UNKNOWN_EFFECT）。
其余项**不因 D4-03C4 / Closure 关闭**。

## 5. D4-03C 准入

D4-03C1 = **PASS**；**D4-03C2 = PASS**；**D4-03C3 = PASS candidate**、**D4-03C3 Closure = PASS candidate**；**D4-03C4 = PASS candidate**、**D4-03C4 Closure = PASS candidate**（cold-restart quiescence probe fail closed）、**D4-03C4 Closure-2 = PASS candidate**（cold-restart death proof；pathname != process lifetime；persisted record 无 socketPath）、**D4-03C4 Closure-3 = PASS candidate**（persisted EXITED 无 death authority；只有 live supervisor child exit 能 quiesce）、**D4-03D = PASS candidate**（Full Tool Proxy Gate；official dsh 混合 READ+WRITE verified；tpx scope / revoke / non-persistence；AUTO_RETRY=0）、**D4-03D Closure = PASS candidate**（Tool-call Identity Seal：mandatory callId + canonical arguments fingerprint binding；conflict fail closed）、**D4-03 overall = PASS candidate**（由 ChatGPT 审计后决定 `D4-03 = PASS`）；**D4-04 = PASS（限定当前验收范围）**（真实 Electron probe vertical smoke：Closure-3 轮 67/67 被测 commit `e989842`；当前共享 probe 在 `83baad6` 干净运行 94/94 = 原 67 + D4-06 新增 27；真实 `main.cjs` 未端到端实测，其余 NOT VERIFIED / DEFERRED 保持原状）。**D4-06 = PASS（限定当前验收范围）**（关联链 L1–L15 与预算到限停止通过；A35 “明确续接入口”由 D4-06 Closure 满足——仅解除“预算耗尽→用户显式续接”，有界 ≤3 次）。**D4-05 = PASS（限定当前验收范围）**（S1 产物不符 A33 / S2 结果未知 / S3 用量到限 A35 / S4 记忆越权 A36 全 PASS；受控记忆装配与逐请求发送前隔离由 D4-05 Closure-3 `9691348`+`ac9af8e` 补齐）；**A33 正式链闸门由 Closure `70eb0b1` 补齐**；**解决关联由 Closure-2 `77b6e85` 修正为 (tool_id, canonical arguments)**；禁止自动进入 D5 / D6。
C2/C4 只开放 resource.trash 一条 REVERSIBLE_WRITE：IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED / Shell / Terminal / filesystem generic mutation / MCP / Browser automation / Device Agent mutation / Canvas mutation / App Center mutation / Adobe control 仍全部 BLOCKED；AUTO_RETRY = 0；Explicit Resume = DEFERRED。Final Approval UI = IMPLEMENTED / VERIFIED。

# D4-04 当前状态（唯一口径 · 2026-09-17）

## 1. Task Status

**D4-04 纵向冒烟 = PASS（限定当前验收范围）**。`PLAN.md` 对 D4-04 的原始验收（一工具真实流程记录；真实产物、停止、**撤权可核查**）在当前验收范围内全部成立。
**D4-06 = PASS（限定当前验收范围）**（见下节 `# D4-06 当前状态`）；**D4-05 执行关卡 = PASS（限定当前验收范围）**（见下节 `# D4-05 当前状态`）；禁止自动进入 D5 / D6。
真实 `electron/main.cjs` 全流程端到端 = **PASS（D4 Main-Entry E2E Closure-6，真实 main 被测 commit `3c9659a`，5/5 必需流程经产品入口 PASS、Gate `120/120`、exit 0）**：真实 `electron .` 启动/boot、真实 UI 首启/登录、Settings provider/model、**产品治理入口工具授权**、AI 任务 + 审批成功 WRITE、**撤权停止**、**明确 WRITE 被拒不再假成功**、**同一任务追加第二步 → 预算停止 → UI 显式续接 → 完成**、刷新一致性 = PASS（见 `docs/D4-PRODUCT-MAIN-E2E-RESULT.md`）。其余 `NOT VERIFIED` / `DEFERRED` 项保持原状。

## 2. 关键证据（真实执行）

| 入口 | 结果 |
|---|---|
| `npm run test:d4-04`（Closure-3 轮 `e989842` 干净运行） | **67 / 67 PASS**；12 gate 全 true（含 `revokePendingApproval` / `revokeMidTask`）；rendererConsoleErrors / mainUnhandledErrors / secretHits = 0 |
| `npm run test:d4-04`（当前共享 probe，`17df98e` 干净运行，D4-06 复用） | **94 / 94 PASS**（原 67 + D4-06 新增 27：执行异常 X1–X7 / 预算到限 Y1–Y5 / 关联链 L1–L15），无回归 |
| `tests/d4-04-executor-unavailable.test.mjs` | **1 / 1 PASS**（产品 `executeApproved` + `UnavailableExecutorLauncher`：0 spawn / 0 lease / 0 mutation / task BLOCKED） |
| `test:d4-04-closure2` | **9 / 9 PASS**（shared boot + launcher fail-closed） |
| 受影响回归 | `test:d4-03c4` 35/35 + UI 22/22、`test:d4-03c4-closure2` 12/12、`test:d4-03c4-closure3` 9/9、`test:d4-03d` 52/52、`test:d4-03d-closure` 62/62 全部 PASS |

- 撤权场景（真实 Electron probe + 真实 UI + 产品 governance API）：R1 待批准时撤权后旧批准不可执行（call BLOCKED / `SIDE_EFFECT_AUTHORIZATION_REVOKED` / 0 mutation / 0 lease / 0 新 executor）；R2 任务进行中撤权（refA 已有副作用保留、refB 被拒绝、Task/Step/Harness run BLOCKED、无自动重试）。
- 证据可追溯：artifact 记录 `testedCommit=e989842` / `workspaceState=""` / `command` / `env` / 逐条脱敏 checks / 原始 artifact SHA-256 `01baf7ef...6e71b`；脱敏证据纳入版本管理 `docs/D4-04-GATE-EVIDENCE.json`。

## 3. 详细记录

`docs/D4-04-CLOSURE3-RESULT.md`（本轮缺口补齐）、`docs/D4-04-CLOSURE2-RESULT.md`（Closure-2）、`docs/D4-04-RESULT.md`（Closure-1）、`docs/D4-04-ACCEPTANCE-RESULT.md`（验收报告）。

## 4. 主要缺口（D4-04 范围内未关闭）

真实 `electron/main.cjs` 全流程端到端 = **PASS（D4 Main-Entry E2E Closure-6 `3c9659a`：启动/boot/真实 UI provider/工具授权/task/审批/撤权/明确拒绝/追加步骤/预算续接/刷新 经产品入口 PASS；Gate `120/120`、PASS、退出码 0）**（Gate 其余仍用 probe host + 共享 production 装配）。其余仓库级缺口不受 D4-04 影响：OS-level network sandbox / external workspace read audit / independent malformed ACP injection / Windows / External Provider = NOT VERIFIED；Explicit Resume = DEFERRED；broader Domain verifiers = NOT VERIFIED；authenticated durable cross-restart process-death proof = DEFERRED / NOT VERIFIED。

# D4-06 当前状态（唯一口径 · 2026-09-17）

## 1. Task Status

**D4-06 关联链完整性与预算到限停止 = PASS（限定当前验收范围）**（由 D4-06 Closure 升级）。
- 关联链（Task→Step→Call→Artifact→Verification）真实产品链路 **L1–L15 全 PASS**；成功 step 必有 Artifact 且 checksum 匹配、必有同 task Verification；拒绝/取消/撤权/UNKNOWN/执行异常/预算停止路径如实 0 Artifact/0 Verification，逐条标注“不适用（该路径无 artifact 提交）”。
- 预算到限停止：三类既有 bounded 预算（Model Proxy `maxCalls=8` / Tool Facade `maxCalls` / `MAX_TOOL_ROUNDS=4`）在真实产品 orchestrator 下停止收敛；Electron UI 一致性 Y1/Y5 PASS；预算 Node 测试 6/6；AUTO_RETRY=0；不手工 `blockStep`；不回滚已发生副作用。
- **A35 “明确续接入口” 已满足（D4-06 Closure）**：Boss 批准仅本范围解除延期；预算耗尽 → 后端判定 → 用户显式续接 → 新 bounded step/run（有界 ≤3 次、保留历史、不重放、不自动重做）；其他恢复场景仍 `EXPLICIT_RESUME_DEFERRED`。
**D4-05 执行关卡 = PASS（限定当前验收范围）**（见下节 `# D4-05 当前状态`）；禁止自动进入 D5 / D6。

## 2. 关键证据（真实执行，D4-06 Closure 被测 commit `7b53458`）

| 入口 | 结果 |
|---|---|
| `npm run test:d4-06` | **119 / 119 PASS**（Electron 94 + 预算/续接/d4-08 Node 25），exit 0，`workspaceState=""` |
| `npm run test:d4-06-resume` | **21 / 21 PASS**（真实 Electron UI：刷新恢复 → 点击续接 → SUCCEEDED + UI==账本==运行时） |
| `npm run test:d4-08-verification-ui` | **22 / 22 PASS**（失败验证 UI：显示/刷新恢复/跨用户） |
| `npm run test:d4-04`（共享 probe） | **94 / 94 PASS**，无回归 |
| 受影响回归 | `test:d4-02c` 22/22、`test:d4-03c4` 35/35 + UI 22/22、`npm test` 958/958 |

- 证据：`docs/D4-06-GATE-EVIDENCE.json`（119 条）、`docs/D4-04-GATE-EVIDENCE.json`（94 条）。详细记录：`docs/D4-06-RESULT.md`、`docs/D4-06-CLOSURE-RESULT.md`、`docs/D4-ACCEPTANCE-RESULT.md`。

## 3. 主要缺口 / 后续

1. **已由 D4-06 Closure 关闭**：A35 “明确续接入口”（仅“预算耗尽 → 用户显式续接”，有界 ≤3 次；其他恢复场景仍 `EXPLICIT_RESUME_DEFERRED`）。
2. facade 契约下“单次受控 tool 失败不直接阻断 Task”的产品语义观察（最小修复建议见 `docs/D4-06-RESULT.md` §7）。**D4-05 Closure `70eb0b1` 已按 A33 明确边界实现**：只对“工具报告成功但后端产物验证失败（`verification_status=FAIL`）”阻断 Step/Task；普通工具调用错误（DENY/执行异常，无验证结论）保持既有语义，不整体失败；未新增自动重试。
3. 无 committed Artifact 的预算停止以 `RESUME_NO_SAFE_CONTINUATION` 拒绝；`RESUME_SIDE_EFFECT_PENDING` / `RESUME_ACTIVE_LEASE` 守卫已实现但未单独 e2e 命中。
4. 真实 `electron/main.cjs` 全流程 = **PASS（D4 Main-Entry E2E Closure-6 `3c9659a`；追加入口 `5577e82`、工具授权入口 `4e8c6c1`、明确拒绝假成功修复 `81ced49`）：追加步骤 → 预算停止 → UI 显式续接经真实产品入口全链 PASS**；executor-unavailable 上层 = **`TaskService` 合同验证**（非完整 orchestrator）。其余 NOT VERIFIED / DEFERRED 保持原状。

# D4-05 当前状态（唯一口径 · 2026-09-17）

## 1. Task Status

**D4-05 执行关卡 = PASS（限定当前验收范围）**（D4-05 Closure-3 升级）。`PLAN.md` §41 四场景 S1/S2/S3/S4 = PASS：
- **S1 产物不符（A33）**：工具报告成功但产物尺寸不符（test-only `test.sized`，生产零改动）→ execution `FAILED` / `TOOL_VERIFICATION_FAILED` / `verification_status=FAIL` / Task·Step BLOCKED / 0 Artifact / **1 条 FAIL Verification（v15：method/expected/actual/证据引用，跨重开可查，不造假产物）** / 无第 2 次 proposal；正对照尺寸相符 → SUCCEEDED + 1 Artifact（归属 + `checksum==sha256(content)`）+ 1 PASS Verification。**D4-05 Closure（`70eb0b1`）起，S1 结论以 official dsh facade 正式链为准**：正式链下同样拒绝假成功（`TaskService.getUnresolvedRequiredVerificationFailures` + orchestrator 提交前闸门），旧 fallback 断言保留不删；有限纠错需同 tool 真实复验 PASS 才成功。**D4-05 Closure-2（`77b6e85`）修正解决关联**：关联键从裸 `tool_id` 改为 `(tool_id, canonical arguments)`，无关对象/无关验证要求/无关 Step 的 PASS 不再误清除对应 FAIL（正式链已复现旧漏洞：对象 A FAIL 被对象 B 的 PASS 误清除 → 假成功）；缺 `arguments_hash` 的旧数据保守保持未解决；`resolved` 关系可追溯。
- **S2 结果未知（§383/384）**：真实受控 WRITE + 真实存活 executor（quiescence 不可证）→ Call `UNKNOWN_EFFECT`、Task/Step BLOCKED、0 第二 call/lease/retry、UI 不显示成功；不自动续接（`RESUME_UNKNOWN_EFFECT_PRESENT`）；**本轮补齐只读 recovery 投影 + 人工确认入口**（`task/recovery`/`task/get.recovery` + `task/acknowledgeUnknownEffect` + `data-ai-recovery`/`data-ai-acknowledge`；确认只追加 safe event，不改 authority、不授权 retry/resume）。
- **S3 用量到限（A35）**：真实 orchestrator bounded 预算停止 + 保留产物 + 用户显式续接（有界 ≤3）；`additions.amount == 新一轮真实 capability`、原消耗保留、`base=实际配置`（本轮修复）；一次续接账本只补一个 kind，但新 run 会重新签发 per-run Model/Tool capability（“跨 run 不重置其他 kind”= **OPEN**，见 `docs/D4-ACCEPTANCE-RESULT.md` §2.4）。
- **S4 记忆越权（A36）= PASS（Closure-3 闭合；Closure-4 修复信任分层）**：**检索链 PASS** + **上下文链 PASS（限定“消息结构 + 授权/执行边界”）**——受控装配入口 `electron/memory-context.cjs`（validateSession → TaskService.getTask → SearchService 授权检索 agent=true → test-only 同步点 → 逐条 getCapabilities(agent)+readText 最后检查；有界、无缓存）在唯一出站口 `harness-model-adapter.cjs` 逐请求注入；**Closure-4 起记忆正文只作为 `name:"openarc.reference_data"` 的 user 低信任参考消息（JSON 转义），固定规则为 `name:"openarc.rules"` 常量 system 消息（零资源文本）；清理只按应用结构标签；结构不安全 → 403**。正负对照（授权注入 / §25 无显式 grant·他人·删除·撤权·跨范围不注入 / 续接重检 / 同步点最后检查 / 结构不可注入 / 合法用户文本不被误删 / 越权 WRITE 仍需审批）与真实 Electron UI 15/15 全通过。**注意：只证明消息结构 + 授权/执行边界，不证明真实模型绝不受提示注入影响。**
**禁止自动进入 D5 / D6。**

## 2. 关键证据（真实执行，D4 收口修复被测 commit `ec7a732`；**D4-05 Closure `70eb0b1` / Closure-2 `77b6e85` / Closure-3 `9691348`+`ac9af8e` / Closure-4 `698117f`**）

| 入口 | 结果 |
|---|---|
| `npm run test:d4-05` | **128 / 128 functional**，`overallStatus=PARTIAL`，S1/S2/S3=PASS、S4=PARTIAL，`workspaceState=""` |
| `node --test tests/d4-06-resume.test.mjs` | 6/6（无回归） |
| `npm run test:d4-08-verification-ui`（Closure `70eb0b1`） | **22 / 22 PASS**（official dsh facade 正式链：BLOCKED/0 Artifact/1 FAIL Verification、刷新一致、非 owner 不可读） |
| `npm run test:d4-04` / `test:d4-06` / `test:d4-06-resume`（Closure `70eb0b1`） | 94/94、119/119、21/21 全部 PASS |
| `npm test`（Closure `70eb0b1`） | **963 / 963 PASS**（958 基线 + 新增 5） |
| `npm run test:d4-05`（Closure-2 `77b6e85`） | **139 / 139 functional**，S1/S2/S3=PASS、S4=PARTIAL，`workspaceState=""` |
| `node --test tests/d4-05-s1-facade-association.test.mjs`（Closure-2 `77b6e85`） | **6 / 6 PASS**（无关对象/无关要求/无关 Step 不误清除；有效纠错 + resolved 关联；DB 重开一致；普通错误语义不变） |
| `npm run test:d4-08-verification-ui` / `test:d4-04` / `test:d4-06` / `test:d4-06-resume`（Closure-2 `77b6e85`） | 22/22、94/94、119/119、21/21 全部 PASS |
| `npm run test:d4-05`（Closure-3 `ac9af8e`） | **165 / 165 functional**，**S1/S2/S3/S4 全 PASS**，`overallStatus=PASS`，`workspaceState=""` |
| `node --test tests/d4-05-s4-memory-context.test.mjs`（Closure-3 `9691348`） | **11 / 11 PASS**（正向注入/§25 负向/删除/撤权/切账号/部门范围/同步点最后检查/恶意正文/续接重检/未接线/残缺 403） |
| `npm run test:d4-05-memory-ui`（Closure-3 `ac9af8e`） | **15 / 15 PASS**（真实 Electron UI：授权生效 → 删除隔离 → 切账号隔离 + 读旧 task TASK_FORBIDDEN） |
| `npm test`（Closure-3 `ac9af8e`） | **980 / 980 PASS** |
| `npm run test:d4-05`（Closure-4 `698117f`） | **169 / 169 functional**，**S1/S2/S3/S4 全 PASS**，`overallStatus=PASS`，`workspaceState=""` |
| `node --test tests/d4-05-s4-memory-context.test.mjs`（Closure-4 `698117f`） | **15 / 15 PASS**（信任分层 / 结构不可注入 / 合法文本不被误删 / 放置幂等 / 越权 WRITE 仍需审批 / 删除·撤权·切账号·续接） |
| `npm run test:d4-05-memory-ui` / `test:d4-08-verification-ui` / `test:d4-04` / `test:d4-03b-dsh`（Closure-4 `698117f`） | 15/15、22/22、94/94、26/26 全部 PASS |
| `npm test`（Closure-4 `698117f`） | **984 / 984 PASS** |
| 说明 | D4-01/02/03/04/06 复用各自阶段证据，未机械重跑全部 |

- 证据：`docs/D4-05-GATE-EVIDENCE.json`（Closure-4：**169 条**，`artifactSha256=a0663ca0…dfa7`；S4 共 32 条 = Node 17 + 真实 Electron UI 15）、`docs/D4-04-GATE-EVIDENCE.json`（94 条）、`docs/D4-ACCEPTANCE-RESULT.md`。详细记录：`docs/D4-05-RESULT.md`、`docs/D4-05-CLOSURE-RESULT.md`、`docs/D4-05-CLOSURE2-RESULT.md`、`docs/D4-05-CLOSURE3-RESULT.md`（system-role 表述已由 Closure-4 更正）、`docs/D4-05-CLOSURE4-RESULT.md`。

## 3. 主要缺口 / 后续

**D4 = PARTIAL**（macOS 核心基本完成，非整体完成）。D4-01 macOS Core、D4-02 macOS Core、**D4-03（PASS，限定范围）**、D4-04、**D4-05**、D4-06 在声明范围内通过；**D4-05 = PASS**（Closure-3 闭合 S4；Closure-4 修复记忆信任分层，S4 结论收窄为“消息结构 + 授权/执行边界”）。**2026-09-19 外部裁决（ChatGPT，实现方之外）：D4-03 = PASS（限定范围：macOS Core 的六层合同 / 工具门 / 租约 / 取回语义；Windows 与 External Provider 等既有未验证项不在其内）**；CG-01（acquireLease 事务状态保护）已修并在干净导出树验证。D4 整体仍 PARTIAL：剩余为既有项（Windows / External Provider、多屏/GPU 等 NOT VERIFIED）。**F-2 与 R-8 已按既有契约/裁决修实现、A9/A10/A23 已闭合（第三轮，被测 commit `42ebe3b`）。真实 `electron/main.cjs` 产品入口已由 Closure-5/Closure-6 补齐并经第三轮干净树连续 2 次复跑：七条必需流程 PASS、Gate `133/133`、退出码 0。**
2. ~~A33 失败路径无独立 `task_verifications` 记录~~ **已修复（schema v15）**：失败写 FAIL Verification（method/expected/actual/证据引用，脱敏有界，不建 Artifact），跨重开可查；见 `docs/D4-ACCEPTANCE-RESULT.md` §2.1。
3. ~~TOOL_CALLS 真实耗尽被 MODEL_CALLS 兜底 / `base.TOOL_CALLS` 名义值 / 续接新 run 顺带恢复其他预算~~ **已修复（D4-06 Closure，schema v16 `task_budgets`）**：`budgetExhausted()` TOOL_CALLS 优先 + 工具预算耗尽即停止；`base` 用实际配置；**任务层跨 run 累计预算**——续接只抬升被批准 kind，其他种类继承剩余；新 run capability 额度=该类 remaining；run 结束一次性扣减；某类 remaining==0 不建 run 直接 `BUDGET_EXHAUSTED`。
4. A37 / A38 不在 PLAN §41 的 D4-05 四场景内，未纳入。
5. 真实 `electron/main.cjs` 全流程 = **PASS（D4 Main-Entry E2E Closure-6 `3c9659a`：5/5 必需流程含追加步骤/预算停止/UI 显式续接，Gate `120/120`、exit 0）**；真实外部 provider / 真实凭据 / Windows / OS 级网络沙箱 = 继承 `NOT VERIFIED`，不扩大。Closure-6 已补：追加步骤产品入口（`5577e82`）；Closure-5 已补：产品工具授权入口（`4e8c6c1`）、明确拒绝假成功修复（`81ced49`）。

# D5-02 Closure · 验收补齐与边界证据（唯一口径 · 2026-09-20）

**基线 `18b7c4c` → 代码/测试提交 `ce5dd21`**；分支 `feature/d4-03-tool-proxy`；未 push、未合并 main、未进入 D5-03；只操作专用工作树。

- **一次生成的任务/预算/停止归属（本轮新定）**：一次画布生成 = **一个 Task**（appId=canvas，`canvas_runs` v18 绑定 run↔task↔画布↔baseRevision）；预算用**任务级 MODEL_CALLS 账本**（`getTaskBudget`/`recordBudgetConsumption`，与任务层同一份）；停止走 `canvas/runStop` → `requestCancel`/`cancelTask` + run 终结 + AbortController；每次调用重新解析并授权模型（任务不绑定 config），迟到结果只在画布 revision 未前进时返回。`model-bootstrap` 删掉了 `canvas/chat|canvas/image`，画布生成**只能**走 `canvas:command` 的 run 链（不留第二条模型路径）。画布成为独立 App Principal（显式 `model.view/model.use`）。
- **干净导出树 `ce5dd21` 单轮**：`npm run build` 0；D5-02 单测 **12/12**（exit 0）；**产品门禁 `canvas-e2e` 24/25，exit 1**（唯一 FAIL = D1 无权限路径未取得证据，断言未删除未放宽）；回归 `test:d5-01` **64/64**（exit 0）。
- **新增实测证据（PASS）**：D2 能力不支持 → provider 0 图片请求；D3 预算耗尽 → provider 请求数=成功调用数；D4 停止 → 在途不可撤回如实、停止后不再发新请求、迟到结果丢弃且不覆盖用户随后编辑的节点；D5 失败收敛 → 每次调用恰好一次请求、无隐藏重试、无凭据；E1 宿主只接受当前实例（伪造 token/其它 iframe/外壳自身都无效）；E2 后端不信任自报身份；E3 `openarc-canvas://` 越界被拒；E4 出网通道（fetch/img/WebSocket/表单/外站脚本）本地接收端 **0 命中**（CSP + 协议 + 宿主校验，fetch 替换只是兼容层）。残余通道如实登记：`location.href` 自我导航无法由 CSP 关闭。
- **统一图片存储口径**：`canvas/importAsset` 把本地导入图片写进**现有资源库**、画布只存 `openarc-asset:<ResourceRef>`，`canvas/readAsset` 逐资源授权解析，老文档 data URL 原样兼容 —— **后端与宿主已接，但未进门禁验证**（保存重开/账号隔离/删除提示仍缺证）。
- **AI 编辑**：仍只有适配器/工具层证据；**真实 Agent 提议 → 审批 → 权威执行 → 画布呈现 → 保存恢复**整条产品链未取得。
- **结论：D5-02 维持 PARTIAL**。未取得证据的既定要求：①D1 无权限路径；②统一图片存储口径的产品验证；③AI 编辑真实产品链。视频/多人实时协作仍按 PLAN 单列为非必需项，不扩开发。
- 证据：`docs/D5-02-CLOSURE-RESULT.md`、`docs/D5-02-CLOSURE-EVIDENCE.json`；`artifacts/d5-02/d5-02-canvas-e2e.json` 与 `.log`（工作树本地）。
# D5-02 · NOVAI 无限画布集成（唯一口径 · 2026-09-20）

**基线 `fe6c9bf`（完整 HEAD 核对一致、工作树干净）→ 代码提交 `d875558` → 门禁补断言提交 `9b47463`**；分支 `feature/d4-03-tool-proxy`；未 push、未合并 main、未进入 D5-03；只操作专用工作树，其他工作区未触碰。

- **源固定**：`github.com/invaders-2/NOVAI-Infinite-Canvas` @ **6ce1a64680b669b31c2ac3b32418b54decd404f2**；**只提取无限画布**（39 文件 ≈4.0MB，见 `public/novai-canvas/SOURCE.md`），上游后端 / 桌面壳 / 智能画布 / 素材库 / ComfyUI / Midjourney / RunningHub 等一律不要。
- **装配**：应用 canvas 窗口 = `CanvasHost`（工具条 + `sandbox="allow-scripts"` iframe）；画布经 `openarc-canvas://` 只读协议加载，**没有** openarc 桥 / Node / IPC / fs / 凭据；所有请求由 `openarc-bridge.js` 经 postMessage 转给宿主 → 受控命令（`canvas:command` / `model:command`）。对上游代码只有两处注入（桥 + canvas.js 末尾适配层），画布本体零重写。
- **模型只有一个来源**：画布无密钥 / 无地址 / 无隐藏供应商；`/api/config` 由宿主用 OpenArc 已配置模型合成（无 provider、无 baseUrl、无凭据）。文本走 `ModelService.chat`；**图片本轮新增 image-generation 传输**（同一条 openai-compatible 协议，能力不支持即 CAPABILITY_UNAVAILABLE，绝不用文本接口顶替）；**视频 = 明确缺项**（501，不新增供应商 / 付费服务）。
- **数据与权限**：画布文档挂在 D3-04D 的 `canvas_boards` 上（v17 迁移：doc/revision/visibility/deleted_at + `canvas_shares` + `canvas_commands`），**不建第二套画布**；命令层 / 版本检查 / 权限规则只有一份（`canvas-domain` + `canvas-service`）。**A08** 引用是稳定 ResourceRef（改名仍可用、删除明确不可用）；**A28** 只读成员的手工 / 保存 / AI / 撤销四路都被同一条规则拒；**A38** AI 用过期基准 → REVISION_CONFLICT 且用户内容保留。AI 编辑是受控工具 `canvas.edit`（审批 + plan 固定 revision + READ_AFTER_WRITE）。
- **干净导出树单轮**：`npm run build` 0；D5-02 单测 **12/12**（exit 0）；**D5-02 真实产品门禁 `canvas-e2e` 16/16 PASS（exit 0）**；回归：`test:d5-01` **64/64**（exit 0）、`test:d5-01-control` **46/46**（exit 0）、`test:d5-01-visibility` **25/25**（exit 0）；受影响单测 **65/65**。
- **结论：D5-02 = PASS（限定范围：macOS 单屏 / 本地确定性 provider / 单进程本地画布）**。缺项如实登记：视频生成、批量命令原子提交、停止 / 预算细粒度断言、视觉输入、多人实时协作、画布本地导入图片以 data URL 存项目文档（有界 8MB/张）。
- 证据：`docs/D5-02-RESULT.md`（集成决策 + 逐项映射 + 缺项）、`docs/D5-02-EVIDENCE.json`（脱敏）；`artifacts/d5-02/d5-02-canvas-e2e.json` 与 `.log`（工作树本地）。
# D5-01 Closure-4 · 提示遮挡判定 + 最小修复 + 仪器收口（唯一口径 · 2026-09-20）

**基线 \`ebc9d21\`（完整 HEAD 核对一致、工作树干净）→ 代码/测试提交 \`f9564b7\`**；分支 \`feature/d4-03-tool-proxy\`；未 push、未合并 main、未进入 D5-02；只操作专用工作树（\`OpenArc OS-d4-01\`）。

- **产品缺陷 NOTICE-OCCLUSION-1（像素实证，不是测量误差）**：原生视图挂在窗口之上，位置 = 外壳顶 + 90pt chrome（domain 意图）；而 \`browser-notices\`/\`browser-error\` 是 chrome **之下**的 flex 条带 → 提示条被网页整条盖住，点击也进不了外壳、直接漏给网页。同一门禁在两棵树上对照：基线 \`ebc9d21\` **8 PASS/8 FAIL（exit 1）**（重叠 33.5pt、按钮中心像素 = 网页绿 56,123,83、提示条内网页绿 15/25、外壳零点击、网页事件 3→12、popup 按钮同样失效）→ 修复后 \`f9564b7\` **16/16 PASS（exit 0）**（重叠 0pt、按钮像素 91,91,93、0/25 网页绿、外壳收到 trusted 点击、该条消失其余不变、网页事件 3→3）。
- **最小修复（让网页让位）**：\`BrowserApp\` 每次渲染量「chrome 之下、网页之上」的 DOM 条带高度并上送 → \`useDesktop\` 存 \`viewportReserves\` → \`window-manager.nativeIntents(state, host, reserves = {})\` 把它从原生视口减掉（默认 \`{}\` → 既有几何逐字不变；非浏览器/未上报窗口 0）；新增单测覆盖让位与脏值。未新增缩放入口、未改执行契约、未新增 IPC 通道、未放宽安全面断言。
- **仪器一次修完**：V4c 改读实际采集字段（旧断言读 \`r1.run\` 恒 FAIL）；V4d 解释性差值移入诊断、断言改为"条带让位且条带内非网页绿"；V11/V12 统一到**实测原生视图矩形**换算（移除 \`.web-viewport\` + 经验 \`dy\` 残留路径），V11 增补落点像素独立证明并避开 16pt 圆角，V12 先定位真实按钮矩形 + \`elementFromPoint\` 旁证 + 前台/活跃 App 核对，以窗口状态/网页布局/像素真值判定；V13 页面缩放更正为"不适用（原始必需项不含）+ 实测补充"；新增 \`experiments/d5-01/screen-geometry.mjs\` 作为唯一换算器（含安全闸与"热身"，每条点击断言以"外壳/网页收到"为准）。
- **干净导出树 \`f9564b7\` 单轮（不拼接）**：\`test:d5-01-visibility\` **25/25 PASS，exit 0**（1 NOT VERIFIED）；\`test:d5-01\` **64/64 PASS，exit 0**；\`test:d5-01-control\` **46/46 PASS，exit 0**；窗口回归单测 **55/55**；\`test:native\` **26/26**；提示门禁 **16/16**。文件身份 sha256 与提交一致。
- **结论：D5-01 = PASS（限定范围：macOS 单屏 / 本地受控站点 / 正常退出）**。原始必需项 1–11 全部满足（AI 控制浏览器见 Closure-2 的 46/46，本轮无回归）；范围外项照旧 NOT VERIFIED：崩溃/强杀恢复、高 DPI/多屏/Windows、任意网站兼容、页面缩放（不适用）。设计内限制如实登记：原生视图 16pt 圆角区域不接收网页点击。
- 证据：\`docs/D5-01-CLOSURE4-RESULT.md\`（前/后对照 + 逐项结论）、\`docs/D5-01-CLOSURE4-EVIDENCE.json\`（脱敏）；\`artifacts/d5-01/\`（工作树本地：4 份门禁 JSON + 对照组 JSON + \`visibility-clean/\`、\`notice-clean/\`、\`notice-prefix/\` 截图）。上一轮的"提示不需要让位"结论已更正；\`notice-coverage-probe.mjs\` 因判据无效已删除。

# D5-01 Closure-3 · 执行边界与最终验收（唯一口径 · 2026-09-20）

**基线 \`2534c31\` → 代码/测试提交 \`2cb3088\`**；分支 \`feature/d4-03-tool-proxy\`；未 push、未合并 main、未触碰其它工作区（另一个运行中的 \`OpenArc OS.app\` 全程未激活/未点击/未关闭）。本轮只收口三件事，不新增浏览器功能。

- **主进程内执行的边界（§二）**：保留 in-process execution class（原生视图搬不进子进程），但补齐全部缺失的证明并**不新增任何绕过** —— lease/claim/exactly-once/verify 仍由同一个 SideEffectAuthority 裁决。新增：**派发三态**（APPLIED / NOT_APPLIED / INDETERMINATE，判据是 \`loadURL()\` 自身 promise + 只把"我们请求的地址被提交过"算我们的提交）、**归因账本**（viewId#seq 活账本 + 按 callId 绑定本次执行）、**plan 完整性**（批准时 expectedEffects 独立副本逐字比对；执行入参 url 与 plan 自洽）。停止/迟到/关标签一律收敛为 UNKNOWN_EFFECT 并走既有只读恢复（recovered=true → 交 BLOCK），**绝不以"当前 URL 相等"当作成功**。单测 \`tests/d5-01-browser-inprocess-boundary.test.mjs\` **6/6**；真实原生视图门禁 \`experiments/d5-01/browser-inprocess-boundary-e2e.mjs\` **32/32 PASS**（claim 前撤权 0 派发 / 派发后停止 / 迟到完成不覆盖 / 关标签 / 归因 / 重复与绑定）。**限制如实声明**：in-process 与 out-of-process **不等价**（无独立 executor 进程寿命证据）；派发证据是内存账本，冷启动后只能判不可知；"能证明未执行"的条件很窄。
- **真实可见性（§三）**：新增 \`experiments/d5-01/visibility-e2e.mjs\` —— \`screencapture -x -o -l <CGWindowID>\`（窗口自身画面）+ \`cliclick\`（CGEvent **真实指针**）+ Quartz 读像素；每次点击前校验"我们仍是最前面的窗口 + 落点在本窗口内容区"，否则宁可不点（绝不碰另一个实例）。工作区运行 **19/20 PASS**：网页真的可见（视口中心像素为页面纯绿、对照列无绿）、真的可交互（页面自己记录到真实点击坐标，标定后命中按钮本体误差 ≤6px）、标签栏真实点击新建/切换生效、地址栏真实点击获得焦点、面板打开网页让位/关闭恢复（像素级）、缩放后重新标定仍命中。**OPEN 发现 VIS-GEOMETRY-1（如实登记、不冒充通过）**：像素测量与点击标定两个独立仪器都显示原生视图在屏幕上比 DOM 预留位置偏高约 83–103pt、高度更大（436 vs 322pt），但标签栏/地址栏真实点击仍生效，未能定位根因 → V4c 保持 FAIL，可见性一项不判完成。干净树上复跑该门禁 7/9 + 1 NOT VERIFIED（那一轮本窗口未在最前，安全闸按设计拒绝发真实点击）。
- **D4-03D 文件级超时（§四）**：**根因确定性复现** —— 测试夹具的 \`server.close(cb)\` 在还有未结束请求的连接时**永不回调**（2.5s 仍未关闭；\`closeAllConnections()\` 后立即关闭），据此做清理会让测试文件进程挂死（0 断言失败、文件级 180s 超时、每次命中不同文件、整轮约 930s）。**最小修复**：统一 \`closeServer()\`（closeIdleConnections + closeAllConnections + 有界兜底）落在 model-fake-provider（共享）/ d4-04-provider / d5-01 site / tool-d4-03d-closure；**不删测试、不跳过文件、不提高超时**。基线 \`0094e17\` 导出树同样复现（43/42、0 fail、1 文件级超时、exit 1）→ 预先存在。修复后连续 2 次 \`npm run test:d4-03d\` = **52/52 PASS / exit 0**。
- **干净导出树 \`2cb3088\` 实际检查**：受影响 node 套件 **33/33**（exit 0）；\`security-surface\` **16/16**（exit 0）；\`test:d4-03d\` **52/52 PASS**（exit 0）；\`browser-inprocess-boundary-e2e\` **32/32**（exit 0）；\`visibility-e2e\` **7/9 + 1 NOT VERIFIED**（exit 1，见上）。
- **结论：D5-01 仍为 PARTIAL**（不升级为限定范围 PASS）：执行边界与 D4-03D 已收口，可见性取得真实屏幕/真实指针证据但存在未定位的几何 OPEN 项；崩溃恢复、高 DPI、多屏、Windows、任意网站兼容、像素级层级真值仍单列 NOT VERIFIED。不进入 D5-02、不 push、不合并 main。
- 证据：\`docs/D5-01-CLOSURE3-RESULT.md\`、\`docs/D5-01-CLOSURE3-EVIDENCE.json\`；\`artifacts/d5-01/d5-01-browser-inprocess-boundary-e2e.json\`、\`artifacts/d5-01/d5-01-visibility-e2e.json\`、\`artifacts/d5-01/visibility/*.png\`（工作树本地）。

# D5-01 Closure-2 · 受控浏览器能力产品闭环（唯一口径 · 2026-09-20）

**基线 `0094e17866a2937d61eebc88b382e42694148d98` → 代码/测试提交 `ad024749fbdc8cffe950cd034cd554134a2eca14`（`ad02474`）**；分支 `feature/d4-03-tool-proxy`；未 push、未合并 main、未触碰其它工作区（含另一个正在运行的 `OpenArc OS.app`，全程未操作）。

- **模型可见面裁决（§2）**：保留 `FORBIDDEN_HARNESS_TOOLS` 全部 15 项（**精确字符串匹配**，不新增前缀通配、不删项）；`READ_TOOL_IDS` 加 `browser.read.page`、`WRITE_TOOL_IDS` 加 `browser.navigate`；广播名是 `browser_read_page`/`browser_navigate`，与裸 `browser` 不是同一个字符串，故不存在误拦。正反对照见 `tests/d5-01-browser-control-surface.test.mjs`；`tool-registry` 的"browser 前缀一律禁止"改成精确口径（非受控 browser id 仍拒）。新增独立 Tool 权限 `tool.browser.read` / `tool.browser.navigate`（读取绝不隐含导航）。
- **产品接线（§3，上一轮列的①②③已落地）**：① 用户选择/授权/查看/撤销 = 浏览器 chrome 的 `[data-ai-control-toggle]`（含状态/计数/标签栏标记），**复用既有 `browser:command` 通道**（不新增桥键、不新增 IPC 通道，D2 冻结清单 14 键 / 10 通道不变）；② `executionProvider=BrowserControl` 执行适配器（`tool-adapters.cjs`，与 Resource/Search 同一条装配）；③ 导航走 propose→approve→lease→claim→execute→READ_AFTER_WRITE：目标与地址随 plan **持久化**（`preconditions.targetRef/url`），执行只用持久化 plan，Harness 批准后无法换目标；审批面板显示被批准的目标身份与地址。读取走既有工具门（授权 + 预算 + 审计）。
- **诚实执行边界（§4）**：每次操作前重跑目标/归属/存活/URL 校验；失效一律拒绝且**不回落**；导航以**真实文档地址**（`webContents.getURL()`）落地才算发生，302 如实标 `redirected`，等不到 → `NAVIGATE_UNCONFIRMED + dispatched=true`（不可知，绝不写"已回滚"）；URL 策略两层（工具门 schema + 执行前 `safeURL`）；正文有界 4000 字符 + `untrusted=true`，不进审计/日志/高信任消息。**新声明**：受控浏览器导航的 Domain 是 main 进程内原生视图，out-of-process executor 结构上无法执行 → 走**显式 in-process execution class**（同一 lease/claim/verify，但**没有**独立进程寿命证据），每次派发落审计 `side_effect.execution_placement = IN_PROCESS`；**与 out-of-process 路径不等价**这一条写进报告而非注释。
- **真实产品链 E2E（§5，④已落地）**：`node experiments/d5-01/browser-control-e2e.mjs`（= `npm run test:d5-01-control`）真实 `electron .` + 真实 preload/UI（Dock/地址栏/AI 面板/审批面板/治理授权）+ official dsh + 真实工具链 + 本地受控站点 + 真实 `WebContentsView`；**46/46 PASS**（2 NOT VERIFIED）。六场景：S1 读取闭环 + 恶意页面注入（正文只作不可信数据、0 自动工具、审计无正文）、S2 导航获批闭环（绑定目标+地址、真实落地、READ_AFTER_WRITE PASS）、S3 导航被拒（0 导航、地址不变、无幻觉文案）、S4 目标失效（未授权/撤权/关标签一律拒绝且不回落）、S5 URL 策略（`file:`/`javascript:`/含凭据在工具门即 `INVALID`、0 SideEffectCall）、S6 停止与预算（审批中取消 → call `BLOCKED/TASK_CANCELLED` + 0 lease；12 次读取被预算截停于 **8** 次、任务非 SUCCEEDED）。
- **D2 安全面启动同步（§6）**：根因实测 = 探针沿用**共享 Electron 默认 userData**（其中 `identity.db` schema 17 > 本代码支持 16），产品**正确地**拒绝打开，探针却只表现为"外壳窗口 8s 未出现"。修法两步：产品新增**唯一就绪信号** `markProductReady()`（窗口+IPC+外壳页开始加载 → `__OPENARC_PRODUCT_READY__` + `app.emit("openarc:product-ready")`），探针改为等该信号；探针宿主在 app ready 前 `app.setPath("userData", mkdtemp)`。**修复前 6/6 + probe.error（exit 1），修复后 16/16 PASS（exit 0，就绪 waitedMs=111）**——运行时那半段（桥接面/无 Node 全局/不可信视图/策略拒绝）第一次真正跑起来。
- **干净导出树 `ad02474` 实际检查**：受影响 node 套件 **38/38**；`security-surface` **16/16**（exit 0）；`npm run test:d5-01`（真实 `electron .`）**64/64**（1 NOT VERIFIED）；`browser-control-e2e` **46/46**（2 NOT VERIFIED）；`npm run test:d4-03d` **断言全绿（52/53、0 fail）但运行不稳定**（1 个文件级 180s 超时、exit 1）——**同一条命令在基线 `0094e17` 导出树上同样复现**（43 tests / 42 pass / 0 fail、命中的是纯单测文件），故**不是本轮引入**，登记为既有仪器/运行环境问题，不冒充通过。
- **结论：D5-01 维持 PARTIAL**（⑥可见性 = 真人鼠标路径 + 连续截图/录屏仍未取得：本机屏幕被另一个正在运行的 OpenArc 实例占用，不冒充像素证据；崩溃恢复/高 DPI/多屏/Windows/任意网站兼容仍 NOT VERIFIED；in-process 执行类与 out-of-process 执行类不等价）。不因本轮升级 D4 结论；agent-browser 保持冻结（不进产品依赖/启动路径/Agent 工具列表）；本轮停止，不进入 D5-02。
- 证据：`docs/D5-01-CLOSURE2-RESULT.md`（逐项结论 + 六场景表 + 诚实边界与限制）、`docs/D5-01-CLOSURE2-EVIDENCE.json`（脱敏：46 条产品链检查 + 16 条安全面检查 + 门禁命令/退出码 + 未验证项）、`artifacts/d5-01/d5-01-browser-control-e2e.json` 与 `…-operation-record.jsonl`、`artifacts/d2-02/security-surface.json`（工作树本地）。

# D5-01 Closure · 最小受控 AI 浏览器能力（唯一口径 · 2026-09-20）

**基线 `f93e835` → 代码/测试提交 `6c865023093855fee61f4db4ebb8a521764fc729`**；分支 `feature/d4-03-tool-proxy`；未 push、未合并 main、未触碰其它工作区。

- **已落地（代码 + 服务层 6/6 测试）**：`electron/browser-control-authority.cjs` —— 用户在渲染层**显式选择**允许 AI 控制的标签，后端校验账号/App/标签归属（分区 sessionKey=userId）；目标绑定稳定身份 `windowId#tabId`；**每次执行前重新检查**；标签关闭/撤销/登出/切账号后**一律拒绝且不回落**；读取只取 `document.body.innerText`（4000 字符上限、标 `untrusted`、不碰 Cookie/令牌、不进审计与日志）；导航复用 `safeURL` + 原生视图控制器；审计 URL 去凭据/查询串/片段。控制器补 `ownerOfView`/`readText`。工具面注册 `browser.read.page`（READ_ONLY）与 `browser.navigate`（REVERSIBLE_WRITE + requiresApproval + CONTROLLED_REVERSIBLE_WRITE，**未标成只读**）。
- **未接线（明确列出，不冒充完成）**：① 用户选择目标的正式产品入口（IPC/preload/UI）；② `executionProvider=BrowserControl` 的执行适配器；③ 导航接入 SideEffectAuthority 的 propose→approve→lease→execute；④ **产品链 E2E（真实 electron . + 确定性 provider + 产品 UI）与预算/停止/恶意页面证据本轮不存在**；⑤ 模型可见面需裁决（`dsh-tool-profile` 的 `FORBIDDEN_HARNESS_TOOLS` 含 `browser`）；⑥ 可见性（真人鼠标路径 + 连续截图/录屏）未取得（本机另有实例占用屏幕，不冒充）。
- **D2 安全面四项已精确更新**：逐项核对实际暴露面与守卫后，冻结清单补 `browser/sideEffect/task` 与 `browser:command`；把写死"只允许 +model"的过期否决用例替换为"相对 D2 基线只允许已批准增量且不得移除"；保留 `bridgeExposesNoRawIpc`、`everyChannelTrustsSender` 两个否决用例。实测 **6/6 PASS**（此前 4 项 FAIL）。残余 `probe.error`（外壳窗口 8s 超时）在基线 `f93e835`/`39d733d` 上同样存在，属 D4 runtime boot 后的既有仪器时序问题。
- **干净导出树 `6c86502` 实际检查**：新增/受影响 node 套件 **85/85**；`test:d4-03d` **52/52**；`security-surface` **6/6 checks**；`test:d5-01`（真实 `electron .`）**64/64**（1 NOT VERIFIED：崩溃持久化）。
- **结论：D5-01 维持 PARTIAL**（原始必需项缺"AI 控制产品链闭环"与本轮可见性证据；崩溃恢复/高 DPI/多屏/Windows/任意网站兼容仍 NOT VERIFIED）。不因本轮升级 D4 结论；agent-browser 保持独立实验状态；本轮停止，不进入 D5-02。

# D5-01 · R2 重启恢复修复与范围核对（唯一口径 · 2026-09-20）

**基线 `39d733d39eb6a33386ad84ddb3117b4e7be59a48` → 代码/测试提交 `98c9f81aaba4b9754b76034bec5ce39430be9229`**；分支 `feature/d4-03-tool-proxy`；未 push、未合并 main、未触碰其它工作区。

- **R2 根因（实测复现，非导航事件/非恢复读取）**：原门禁用 `SIGKILL` 做"重启恢复"，而 Chromium 的 localStorage **磁盘提交是异步的** —— 强杀时内存里已是新值（`/cookie?set=1`）、磁盘上仍是旧值（`/page3`），于是表现为"重启后活动标签 URL 落后一次导航"。正常退出（`window-all-closed → app.quit`）路径本来就正确，含"导航后立刻关窗口"。
- **最小修复**：门禁改用**正常退出**（`quitNormally()`），断言不放宽并增强为 R0–R5（正常退出 / 两标签恢复 / 最终地址 / 活动标签 / 每标签 URL / 真实页面）；崩溃与强杀后的持久化明确列为 **NOT VERIFIED**（未用固定等待、未强制保存）。
- **顺带修掉两个"假通过"缺陷**（本轮取证发现）：① 原生视图**从未 `addChildView`** —— webContents 照常加载（CDP/eval/下载/capturePage 都正常）但屏幕上永远没有网页；现已挂载并通过 `native-state.attached` 回报（门禁断言 `data-attached=1`）。② 原生视图**盖住浏览器 chrome**（标签栏+地址栏）——合成点击能过、真人点不到；新增 domain 常量 `BROWSER_CHROME_H=90`（CSS 同步固定 37+53），门禁断言不重叠。
- **干净导出树 `98c9f81` 实际检查**：D5-01 门禁（真实 `electron .`）**64/64 PASS**（1 NOT VERIFIED）；受影响单测 **59/59**；D1-01 `test:native` **26/26**；D2-02 `test:d2-02` FAIL —— **预先存在**（`security-surface` 的 preload/IPC 冻结清单过期；本轮基线 `39d733d` 上同样 4 项 FAIL，本轮不改该冻结断言）。
- **D5-01 范围核对（对照 PLAN）**：真实视图/导航/标签/加载态/下载落盘/会话恢复/用户隔离/弹窗·外部协议·证书·上传·权限/A12·A13 均有实测证据；**仍未完成**：PLAN §8 "AI 控制浏览器（明确工具与授权、记录目标标签与执行结果）" —— Tool Registry 仍只有 6 个工具、无 `browser.*`；NOT VERIFIED：崩溃恢复、像素级层级真值（本机屏幕被另一个已运行的 OpenArc 实例占用）、高 DPI/多屏/Windows、任意网站兼容。**D5-01 维持 PARTIAL**。
- **旧路径与新入口**：无 `views` 意图时仍走单视图；`destroy(windowId)`/`partitionFor(appId)` 旧签名与旧分区名逐字兼容；两参 `navigate/action` 仍作用于活动标签 —— 新入口是增量，未替换、未重构。
- **agent-browser 冻结**：保留独立验证材料；不进产品依赖、启动路径与 Agent 工具列表；正常启动不开调试端口（门禁 B3/B4/B5 实测）；不开发替代执行器、不扩展第三方选型。
- 详见 `docs/D5-01-RESULT.md`（R2 修复前后对照 + 范围核对 + 缺项清单）。

# D5-01 · agent-browser 兼容性验证（唯一口径 · 2026-09-20）

**产品被测 commit：`2411f109894950b6dc7921113a9a4b185d2a7262`（Base `3c64a3cbd4c082385c3bbad8fed57b6cda3ac57c`）**；分支 `feature/d4-03-tool-proxy`；未 push、未合并 main、未触碰其它工作区。

- **现场核对**：任务开始时 HEAD `3c64a3c` 的内置浏览器**没有真实标签页**（一个窗口一个原生视图）。真实标签页是本轮作为**必要前置**补齐的产品能力。
- **本轮产品代码提交 `2411f10`**（新增，不替换任何既有实现）：每标签一个 `WebContentsView`（`viewId=windowId#tabId`）、`browser/tab-*` 命令与标签模型、下载真实落盘、按 App+用户会话分区、按用户持久化；干净导出树门禁 `npm run test:d5-01` **57/58**（唯一失败 R2：重启后活动标签 URL 落后一次导航，已登记）。
- **agent-browser 固定版本 0.38.1**（npm，Apache-2.0，无运行时依赖；安装在临时独立目录，**不进产品依赖、不进启动路径**；**未使用其自带 Chrome**，仅 `--cdp` 连到真实 `electron .` 的仅本机调试端口 + `--pin-tab` 钉标签）。
- **真实内置标签页 24 项检查：23 PASS / 1 FAIL**。失败项 = `open/goto` 导航命令在 Electron CDP + `--pin-tab` 下**不返回**（动作生效、命令挂起）。
- **通过的要点**：连接并列出标签；钉在指定网页标签且操作不落在管理界面；读标题/输入回读/点击后页面状态可核查/滚动/刷新后重新识别；双标签下用户切换焦点不误投；被钉标签关闭 → `tab_gone` 且不转向其它标签；登出后旧控制会话立即失效；调试端口仅本机、退出即关、常规启动不开放。
- **三个阻塞项（如实登记）**：① 控制连接可另行绑到 OpenArc 界面页 target —— **标签固定 ≠ 权限隔离**；② 动作完全绕过 D4 工具门/审批/停止/审计；③ agent-browser **没有 pause/stop** 语义，停止必须由 OpenArc 实现。
- **结论：有条件采用**（不建议现在直接引入；正式替换/引入需另行决策）。它补充的是"Agent 友好的定位（a11y snapshot/ref）+ 严格标签绑定（tab_gone）语义"；**标签状态、会话/分区、导航、权限、审批、停止、审计必须继续由 OpenArc 持有**。若 Agent 需求只到页内读取/点击/输入，也可以基于既有 `WebContentsView` 自研，不引入。
- 证据：`docs/D5-01-AGENT-BROWSER-EVALUATION.md`（逐项预期/实际/证据 + 权限与生命周期清单）、`docs/D5-01-AGENT-BROWSER-EVIDENCE.json`（脱敏）、`artifacts/d5-01-agent-browser/agent-browser-eval.json`（工作树本地，含全部 CLI 调用记录）。
- **本轮到此为止**：不进入 D5-02，不扩大 D4 既有验收结论。

# D4 阶段总结（唯一口径 · 2026-09-17）

**D4 = PARTIAL**（macOS 核心基本完成，非整体完成）。D4-01 macOS Core、D4-02 macOS Core、**D4-03 = PASS（限定范围，2026-09-19 外部裁决）**、D4-04、**D4-05**、D4-06 在声明范围内通过；**D4-05 = PASS**（Closure-3 闭合 S4；Closure-4 修复记忆信任分层，S4 结论收窄为“消息结构 + 授权/执行边界”）。D4 整体仍 PARTIAL：剩余为既有项（Windows / External Provider、D4-03 审计）。**真实 `electron/main.cjs` 产品入口缺口已由 Closure-5/Closure-6 全部关闭，并经第三轮（被测 commit `42ebe3b`）干净树连续 2 次复跑：七条必需流程 PASS、Gate `133/133`、退出码 0。**
- 收口修复（`ec7a732`）：① 预算实际值/停止原因/追加账本；② 失败 Verification 持久化（schema v15）。
- 阻塞整体 PASS：**仅剩既有未验证项** —— D4-01/D4-02/D4-03 的 Windows / External Provider NOT VERIFIED、多屏与 GPU 性能 NOT VERIFIED、OS 级网络沙箱等。**D4-03 已于 2026-09-19 由实现方之外的审查者（ChatGPT）裁决为 PASS（限定范围）**；内部独立预审 25 项闭合（22 项已确认缺陷 + Closure 三项 A3/A18/A20）+ 第五轮 CG-01（acquireLease 事务状态保护）见 `docs/D4-03-INDEPENDENT-REVIEW.md` 与 `docs/D4-03-CG01-GATE-EVIDENCE.json`**；**F-2、R-8、A9/A10、A23 已修并独立复核 CLOSED**；**REV-03/S2、迟到反馈、`revokeApproval` 入口已按 Boss 已批准规则实现并复核 CLOSED（第四轮）**；仅剩低危登记项处置。真实 `electron/main.cjs` 全流程 = **PASS（D4 Main-Entry E2E Closure-6 `3c9659a`，并于 `f63e87a` 复跑：启动/boot/provider/task/审批/撤权/明确拒绝/追加步骤/预算停止/UI 显式续接/刷新 经产品入口全部 PASS；Gate `120/120`、退出码 0）**——Closure-5 补齐工具授权入口（`4e8c6c1`）与拒绝后假成功修复（`81ced49`），Closure-6 补齐追加步骤与预算续接入口（`5577e82` + `3c9659a`），D4-03 审计补齐 runTask 入口守卫与参数/证据持久化去敏（`f63e87a`）。（D4-05 S4 上下文链已由 Closure-3 闭合，不再阻塞。）
- 下一阶段任务：**D5-01 浏览器**（`PLAN.md:501`；前置 D2（D2-01 设计系统 PARTIAL（边界已声明）+ D2-02 窗口系统 ADR `docs/decisions/D2-02-window-system.md`）、D3-05（macOS PASS）、D1-01（macOS 桌面核心 PASS）；PLAN 依赖表未把 D4 列入 D5-01 前置，D5-02/03/06/08 才以 D4-05（已 PASS）为前置）。**建议在进入 D5 前完成 D4-03 封板裁决与 F-2 裁决**；本轮不开始实施 D5-01。
- **D4-05 Closure-2（`77b6e85`）：失败验证的解决关联修正**——关联键从裸 `tool_id` 改为 `(tool_id, canonical arguments)`；无关对象/无关要求/无关 Step 的 PASS 不误清除对应 FAIL，有效纠错可成功并保留 `resolved` 追溯；缺失关联的旧数据保守保持未解决。新增正式链 6/6、`test:d4-05` 139/139。
- **D4-05 Closure-3（`9691348` + `ac9af8e`）：受控记忆装配与任务上下文隔离（A36）**——受控装配 `memory-context.cjs` + 唯一出站口逐请求注入（reference-data 标记、与系统指令分离）、发送前重新授权/重新读取、删除/撤权/切账号/跨范围隔离、无缓存、正文不落盘；Node 正式链 11/11 + 真实 Electron UI 15/15；`test:d4-05` **165/165（S1–S4 全 PASS，overallStatus=PASS）**；`npm test` 980/980。**S4 与 D4-05 升 PASS**；D4 整体仍 PARTIAL（剩余既有未验证项）。
- **D4-05 Closure-4（`698117f`）：记忆上下文信任分层修复**——删除把记忆正文注入 `role:"system"` 及依赖 “NOT a system instruction”/正文标记的做法；改为 `name:"openarc.reference_data"` 的 user 低信任参考消息（JSON 转义、不伪造 tool_calls）+ `name:"openarc.rules"` 常量 system 规则（零资源文本）；清理只按应用结构标签；结构不安全 → 403。`test:d4-05` **169/169（S1–S4 全 PASS）**；`npm test` 984/984。**S4 结论收窄：只证明消息结构与授权/执行边界，不证明真实模型不受提示注入影响。**
- **D4 Main-Entry E2E Closure-5（`4e8c6c1` + `81ced49` + `396e14c`）：真实 `electron/main.cjs` 产品入口端到端**——真实 `electron .` + 隔离 userData + CDP 真实 Renderer；boot 顺序 `identity_created→model_proxy_start_attempted→model_proxy_started→runtime_ready`、`modelProxyListening=true`；**流程1**（产品治理 UI 授权 → AI 任务 search→trash → 真实 Approve：mutation=1 / SideEffectCall=1 / approval=1 / lease=1 RELEASED / Artifact+Verification 绑定 / SUCCEEDED）PASS；**流程2**（非管理员授权被拒 `NOT_SUPER_ADMIN`；产品入口撤 TOOL grant → 旧批准 → BLOCKED / `SIDE_EFFECT_AUTHORIZATION_REVOKED` / 0 mutation/0 lease/0 新 executor）PASS；**流程3**（无 trash 权限的明确 WRITE + finalText“完成” → Task/Step BLOCKED、0 mutation、`deniedOperations` + `data-ai-denied`，不再假成功）PASS；**流程5**（刷新一致）PASS；**流程4（预算→UI 续接）= NOT_VERIFIED**：真实 UI `task/run` 每次只建 1 step，预算耗尽 0 Artifact，`getResumeEligibility` 要求 `artifactsOfTask>0` → `RESUME_NO_SAFE_CONTINUATION`；不造多步/空产物、不放宽守卫。**Gate `63/64`、`overallStatus=PARTIAL`、退出码 1**，renderer/main 错误 0。**D4 不自动升级。** 详见 `docs/D4-PRODUCT-MAIN-E2E-RESULT.md` 与 `docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`。
- **D4 Main-Entry E2E Closure-6（`5577e82` + `3c9659a`）：同一任务追加下一步目标（AppendStep）产品入口**——`TaskService.appendStep`/`getAppendEligibility`（判定+写入同一 `transactSync`，只新增 1 个 reasoning step；绝不改旧 step/artifact/verification/副作用/lease、绝不重放旧 tool 请求、绝不写 `task_budgets`；拒绝原因显式 `APPEND_*`）、唯一放开 `SUCCEEDED→RUNNING` 边（`startTask` 仍拒绝）、`#resumeAssessment` 覆盖无额度不建空转 run 的 step 级预算停止、`task/appendStep`（拒绝同步返回/运行异步）+`task/get.appendable/appendReason`、AI 面板 `[data-ai-append-*]`/`[data-ai-steps]`。**真实 UI 全链**：第一步真实 WRITE 出产物（mutation=1、Artifact+Verification 绑定）→ 真实 UI 追加第二步（同步接收、同一 taskId、旧行逐字段不变、追加不增加预算：三类 authorized 全等）→ 第二步真实耗尽 `MODEL_CALLS`（Task/Step BLOCKED、第一步产物与副作用不变、0 新 Artifact）→ UI 显示停止原因 + 明确追加额度（与后端 `nextGrant` 逐字一致）→ 点击 `[data-ai-resume]` → 3 steps `SUCCEEDED/BLOCKED/SUCCEEDED`、2 Artifact + 2 Verification、additions=1、`MODEL_CALLS` authorized 8→16。**预算与调用次数**：provider 真实模型请求 9（write 4 + budget 4 + final 1）== `MODEL_CALLS.consumed` 9；`TOOL_CALLS.consumed` 6 == DB tool_executions 5 + sideEffectCalls 1 == provider tool_call 6；第一步副作用恰好一次（跨 step/跨 run 不重放）。**拒绝矩阵（含正对照）**：同一 revision 真并发恰好 1 次接受、重复/过期 revision `TASK_REVISION_CONFLICT`、非 SUCCEEDED 任务 `APPEND_NOT_SUCCEEDED`、AWAITING_APPROVAL `APPEND_IN_FLIGHT`、真实 MEMBER `TASK_FORBIDDEN`、执行前撤权 → Call `BLOCKED/SIDE_EFFECT_AUTHORIZATION_REVOKED` + 0 mutation/0 lease/0 新 executor。**真实回归（干净树复跑发现并修复，`3c9659a`）**：机器码 `APPEND_NOT_SUCCEEDED` 曾被渲染成可见文本而命中 D4-08 UI“验证失败不得显示成功”闸门（21/22）→ 改人话投影后 **22/22**。**Gate `120/120`、`overallStatus=PASS`、退出码 0**，renderer/main 错误 0，证据 `artifactSha256=0461ad44d37af0ca05a0381cbe8a5515b650c138ba5e10e92e3da5a8eb0f7bcd`；同 commit 干净树回归：`d4-09` 11/11、`d4-04` 94/94、`d4-05` 173/173、`d4-06` 119/119+`resume` 21/21、`d4-08` 13/13+`verification-ui` 22/22、权限 17/17、`npm test` 1011/1011。**D4 不自动升级**（Windows/External Provider、D4-03 外部审计等既有项不变）。详见 `docs/D4-PRODUCT-MAIN-E2E-RESULT.md` 与 `docs/D4-PRODUCT-MAIN-E2E-EVIDENCE.json`。
- **D4-03 独立审查四轮（`f63e87a` + `c7302dc` + 第三轮 `2c5dc29`/`42ebe3b`/`1594771` + 第四轮 Closure `dc53c64`/`b031b36`）**：第一轮闭合 REV-01 / F-1 / R-1 / R-2 / R-3 / R-5'；第二轮按裁决**修实现**闭合 F-2（产品任务绑定后端 model config 版本；改版后 run/附加/续接显式 `MODEL_CONFIG_CHANGED`、默认切换不静默跟随、旧任务显式懒绑定），并新确认并闭合 S1 / S1-b（迟到终态绝不覆盖另一 runtime 的权威状态）、A-4（终态与 lease 终结同事务 + 归属回收 + deny 回收）、R-1'（裸单段/双斜杠绝对路径落库）、R-7（签发窗口）、R-9（配置解析失败原因码）；未关闭项已逐项澄清（REV-02/REV-03+S2/A-5/A-6/S3/R-8/R7/R6-C2C3/R3/R4/R-4'/N-1/R-6/[REDACTED] 误拒，见 `docs/D4-03-INDEPENDENT-REVIEW.md` §4）。**D4-03 仍为 PASS candidate（不封板：审查者与实现方同源，须由实现方之外的审查者裁决）**。**第三轮（最终被测 commit `1594771`）**：按裁决闭合 A9/A10（DENY 状态前置：仅 AWAITING_APPROVAL/APPROVED/LEASED 可拒，RUNNING/终态 `SIDE_EFFECT_APPROVAL_TOO_LATE` + 零状态变化、不中止执行、不覆盖 UNKNOWN_EFFECT/SUCCEEDED）、A14/R-8（未绑定绝不建 run：0 run/capability/模型请求/工具执行/artifact，Step/Task BLOCKED，任务可保持未绑定；默认迟到后重新绑定并真实成功）、A16（推送/读取会话隔离）、A17（effectiveApproval 过期死代码）、A19/A21/A23/A24（事件登记 / 抛出收敛 / approve 原子前置 / 已绑定路径悬挂收敛）；main E2E 的 F6.8/F6.11/F4.43 测试竞态以产品桥接受判据修复（test-only，断言只收紧）；干净树 `npm test` 1088/1088、main E2E 连续 2 次 133/133。**。**第四轮 D4-03 Closure（`dc53c64` + `b031b36`）**：按 Boss 已批准规则实现 ① 批准资格执行期重判（可信批准人身份 + 账号状态 + 既有批准范围；登出/会话过期不撤销；旧批准缺 actor 保守拒绝；执行分界 = claim 事务内 `LEASED→RUNNING`）② `sideEffect/revokeApproval` 产品入口（owner/ADMIN；仅 APPROVED/LEASED；原子收敛；迟到 TOO_LATE 零改写；重复幂等；不新增重新批准/重试/恢复）③ 迟到操作逐字反馈（不静默关闭、无机器码/假象）；并如实记录第十一轮 UI 探针 A27 证据因 async interleave 缺陷而无效、由本轮 A27+A29 取代。干净树：D4-03 十六门禁全绿（C4 UI 37/37）、真实 main E2E 连续 2 次 140/140、`npm test` 1099/1099。**D4-03 仍为 PASS candidate（不封板：审查者与实现方同源，须由实现方之外的审查者裁决）**。**第五轮 D4-03 CG-01（`eccf01b`，Base `c1cd9e0`）**：审计静态发现 `acquireLease` 事务内不重读 call 状态 → 迟到申请可把 `RUNNING`/终态改写回 `LEASED` 并发出一张新 ACTIVE lease；已最小修复（事务内重读 persisted status + 只对 `APPROVED`/`LEASED` 发放 + 批准绑定用事务内新快照 + 拒绝路径零写入）。干净导出树只跑新增检查与受影响回归：`test:d4-03-cg01` 31/31、`test:d4-03c1-closure` 52/52、`test:d4-03c2-closure3` 51/51、`test:d4-03c3-closure` 63/63、d4-09 11/11 全 exit 0；修复前副本新测试 8 fail；交错探针修复前 `ok:true`+ACTIVE lease+call `LEASED`、修复后 `SIDE_EFFECT_CALL_STATE`+零改写。**未实测第二次真实副作用；十六门禁其余部分/main E2E/`npm test`/build 未在本轮 commit 重跑。**
- `docs/D4-ACCEPTANCE-RESULT.md` 含受控 memory 装配最小方案（**已由 D4-05 Closure-3 实施**，见 §2.3）与需裁决的续接跨 run 预算 OPEN 项。
- 已验范围（macOS）：模型服务隔离/撤权、任务版本固定与实时权限、工具门/租约/审批/受控写入、纵向冒烟（真实产物/停止/撤权）、关联链与预算停止、结果未知处置均在各自范围内真实通过。

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

---

# D5-02 Full-App · 完整应用集成（2026-09-20 · 基线 `bf82c5c`）

> 口径：本轮把上游 NOVAI **完整应用**（原版 `index.html` = AI Studio 外壳 + 首页 + 侧栏 + 14 个子页）接入 OpenArc，
> 页面扩大后安全不变式不放宽；五项既有缺口逐项收口。详细结果与逐项验收见 `docs/D5-02-FULLAPP-RESULT.md`。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 入口 = 原版应用外壳（首页 + 侧栏 + 子页） | **完成** | `openarc-canvas://bundle/index.html`；vendor 103 文件 / 14 页；A1/A2 |
| 首页 → 无限画布 → 建/存 → 返回首页 → 再打开项目 | **完成** | A3–A7（同一 canvasId + 内容恢复）+ 截图 |
| 统一后端（模型/资源/项目/任务） | **完成** | B1–B6；`/api/app-info`、`/api/queue_status`（= 运行中任务数）、`/api/recent-canvases`、`/api/projects` 全部由宿主回答 |
| 更新/下载上游程序 + 直连 GitHub/Gitee/ModelScope | **禁用** | 501 `OPENARC_UPDATE_DISABLED` + 界面标注 + 出网接收端 0 命中 |
| 缺口 1 任务模型绑定 | **闭合** | F1（停用/跨能力/不存在 → 拒绝 + 0 新增请求） |
| 缺口 2 D1 撤权 | **闭合** | D1（撤销 → PROXY_UNAUTHORIZED + 0 请求 + 恢复）；修复 `getAppAccess` 只投影 `resource.*` 的 namespace 盲区 |
| 缺口 3 图片资源产品链 | **闭合** | F3a/F3b/F3c；并修掉真实缺陷：`importAsset` 把注入的 tempDir 字符串当函数调用 |
| 缺口 4 AI 编辑正式链 | **未闭合（PARTIAL）** | F4：`canvas.edit` 已进入 Harness 广播面、模型真的提议 `canvas_edit`，但 Harness → Tool Facade 的派发没有产生任何 proposal（`side_effect_calls`=0 / `tool_executions`=0，任务 `end_turn`）；对照工具 `resource.trash` 全链 PASS |
| 缺口 5 宿主隔离与导航出网 | **闭合** | E1–E8（含 iframe 自我导航实测被拦 + 被拦后应用仍可用） |
| 停止 / 预算 / 迟到结果保护 | **保持并复验** | D3 / D4（受影响部分已随完整应用重跑） |

## 2. 结论

**D5-02 维持 PARTIAL**：完整应用必需流程已实际运行并通过门禁，但**缺口 4（AI 编辑正式链）**在真实 Electron 里
仍未取得"提议 → 审批 → 执行 → 呈现 → 保存恢复"的完整证据（缺环已定位到 Harness 工具派发这一跳，
下一步见结果文档 §7）。其余四项缺口与安全不变式均已闭合且有实测证据。

## 3. 安全不变式（页面扩大后仍然成立）

无 openarc 桥 / Node / IPC / fs / 凭据；端点白名单外一律 501；`openarc-canvas://` 只读白名单（穿越与非白名单扩展名被拒）；
宿主只接受当前实例（event.source + 每次挂载随机 token，子页 token 由外壳中继附加）；
子页 ↔ 外壳 ↔ 宿主是逐项限定的中继协议；出网（fetch/img/ws/form/script/window.open/自我导航）0 命中，
主进程 `will-navigate`/`will-frame-navigate` 留痕；账号边界 = 真实同源存储按 `oa:<本次挂载钥匙>:` 分桶 + 切账号帧全销毁。

---

# D5-02 范围修正 · 无限画布首页 + 单一模型真源（2026-09-24 · b7ebaa5 → 5b77186）

> **范围来源**：用户 2026-09-24 的范围修正（原文要点）：① 入口 = 用户截图里的「无限画布」首页（开始创作 / 继续上次 / 画布卡片列表），点这些入口直接打开真实编辑器，不再有额外欢迎页或选画布遮挡层；② 去掉 NOVAI 完整应用的左侧导航与其他子页面入口，以及 OpenArc 画布宿主顶部操作条 / 状态行 / 提示横幅；保留首页 ↔ 编辑器返回路径；③ 供应商与模型只有 OpenArc 总 API 设置一个来源（列表 / 默认值 / 可用状态 / 实际调用都来自统一模型服务，遵守个人团队配置、授权、撤权、凭据隔离；不用 NOVAI 配置页、静态清单、独立密钥、直连）；后端没有的能力（视频传输等）未接通就明确显示不可用，不能显示为已连接；④ 不许用 CSS 遮挡冒充完成；首页→画布通信、保存、权限、账号隔离都要正常；⑤ 用真实 Electron 分别验收：首页、新建、继续上次、打开已有画布、返回首页、无模型、模型被停用或撤权、各已支持模型的真实调用；截图对照首页基准；功能 / 视觉 / 动效分别记录。
>
> **本轮为定稿**：功能 / 视觉 / 动效均已取得实测证据（见 §3 / §5）。**（第十一批更正）** 用户首页基准图已落盘本工作区并完成逐项对照：能比的项判「一致」，数据性与条件性差异判「未验收」，**不整体宣布"视觉通过"**；明细见 §5.1「首页视觉基准对照」。**（第十七批定稿）** 最终门禁 = **52 PASS / 0 FAIL / 52、exit 0**（被测 commit `4dfe923`，工作树干净）；保存竞争（关闭条件③）与 MOTION_SYSTEM §6（关闭条件②）均已实现并有实机证据；**F3g / F3h（第十五 / 十六批）都已包含在最终门禁里**；判定与关闭条件见 §7。本节数字全部来自命令或证据文件。

> **（第十五批收口 · 2026-09-24）** 用户裁定首页右下角回收站 FAB「回收站为空时隐藏，有已删除画布时显示」。已按 vendor 幂等补丁实现（不新造第二套事实，与角标同一个 `v4DeletedCanvases.length`）+ 真实 Electron 四态实测 + 在**回收站为空**的条件下重截首页：视觉对照里这一项从「不一致（版本差异 · 待用户裁定）」改为**一致**（同窗口逐像素 mean|diff| 0.62/255、>24 占 0.00%）。**关闭条件①由此关闭 → D5-02 升级 PASS（限定范围）**。细节见 §2 第 14 条 / §3 / §5.1 / §7。**（第十七批定稿）** 最终门禁 = **52 PASS / 0 FAIL / 52、exit 0**（被测 commit `4dfe923`，工作树干净），比上一版新增 **F3g**（FAB 显隐四态）与 **F3h**（卡片菜单真实产品路径，宿主 iframe 补 `allow-modals`）；两条都是纯新增（99 增 / 0 删、102 增 / 0 删），F3g 与全部既有断言一行未改；tracked 证据已按最终 artifact 重生成（52 条 checks，sha256 `33f9de17…`）。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 入口 = 上游原版「无限画布」首页（画布卡片列表） | **已完成** | `src/canvas/CanvasHost.tsx:34`（`IFRAME_BASE = openarc-canvas://bundle/static/canvas-list.html`）；A1 |
| 无完整应用外壳：无 `index.html` / `home.html` 帧、无左侧导航、无其他子页入口 | **已完成** | A1 / A2 |
| 宿主三块 chrome（顶部操作条 / 状态行 / 提示横幅）真删 | **已完成** | `src/canvas/CanvasHost.tsx:8,57,674`；A1 |
| 「开始创作 / 新建画布 / 继续上次（空列表）」直达真实编辑器，无欢迎页、无选画布遮挡层 | **已完成** | `public/novai-canvas/static/canvas-list.html:1038-1039,1381`；A3（`#canvasPickerOverlay` 全程未出现 `.active`）/ A5 |
| 首页 ↔ 编辑器返回路径保留 | **已完成** | A4 / A9 / A10 |
| 供应商 / 模型单一真源（列表 / 默认值 / 可用状态 / 实际调用） | **已完成** | `electron/model-service.cjs:324,349-368`；`electron/model-bootstrap.cjs:114`；`public/novai-canvas/openarc-canvas-guard.js`；B1 / B2 / B4 / N4 / N6 / B6 |
| 需要配置时引导到「OpenArc 总 API 设置」 | **已完成** | N1 / N2 / N5c / N5d（真实点击 → 桥真的送到宿主 → 设置窗口真的打开） |
| 未接通能力（视频 / ComfyUI 等）明确不可用、0 请求 | **已完成** | N3 / B5（`CAPABILITY_UNAVAILABLE` + `available:false` + `transport:null`；假 provider 0 请求） |
| 显式配置的默认模型不可用时不再静默替换（`ec5cbc5`） | **已完成** | `electron/model-service.cjs:349-359`；`src/canvas/CanvasHost.tsx:126-135`；N5c / N5d |
| 打开已有画布后编辑器只读（`b7ebaa5` 修复） | **已完成** | `src/canvas/CanvasHost.tsx:345-355`（`canvas.get` 后补 `pushContext`）；A6 / A10 / F4b |
| 被 CSP `frame-src` 拦下的自我导航不再把帧留在错误页（`ec5cbc5` 修复） | **已完成** | `src/canvas/CanvasHost.tsx:575-599,690`（onLoad 后 3s 说话窗口 → 立即整帧复位，原约 10s 等 8s 看门狗）；E5b |
| 不许用 CSS 遮挡冒充完成 | **已完成** | A3（遮挡层不出现）；N3 / N5c / N5d 用 `disabled` / `aria-disabled` / `data-openarc-*` 能力事实断言 |
| 首页→画布通信与保存 | **已完成** | A7 / A8（命令层 → 自动保存 → OpenArc 存储一致；撤销 / 重做落库） |
| 权限与撤权 | **已完成** | D1 / N5a（撤权 → 明确拒绝 + provider 0 请求；恢复授权 → 回到可用） |
| 账号隔离 | **已完成** | E7 / E8（切账号帧全销毁；同源存储按本次挂载钥匙分桶，A 的键在 B 侧读为 null） |
| 各已支持模型的真实调用（文本 / 图片 / 失败如实） | **已完成** | B2 / B3 / B4 |
| 图片资源产品链（导入 / 重开 / 删除失效） | **已完成**（`9aabefe` 修 F3b） | F3a / F3b / F3c |
| AI 编辑正式链（提议 → 审批 → 执行 → 呈现 → 保存重开） | **已完成**（`527176e` 修 F4） | F4b / F4 |
| 真实 Electron 门禁（最终 · 第十七批定稿） | **已完成** | **52 PASS / 0 FAIL / 52，exit 0**（被测 commit `4dfe923`，工作树干净；比上轮新增 F3e / F3f / **F3g** / **F3h**）；`notVerified: []`；Z1 = clean；artifact `artifacts/d5-02/d5-02-canvas-e2e.json`（sha256 `33f9de17…`，本批 `shasum -a 256` 复核）；见 §3 |
| 保存竞争（关闭条件③）：500ms 待保存窗口内本地编辑撞上宿主 / AI 改动被静默覆盖（`4525ab8` 修复） | **已完成** | 三方合并（base = 最后一次成功同步 / local / remote），同字段冲突 → 本地留原位 + 远端复制 `<id>-remote`；只重发合并结果、最多 2 次，达上限明确停止（不盲重试 409、debounce 一字未动）；F3e + `tests/d5-02-canvas-merge.test.mjs` 12/12；见 §2 第 12 条 |
| MOTION_SYSTEM §6「AI 新增节点 160ms 淡入 + 来源标记」（关闭条件②，`4525ab8` 实现） | **已完成** | 账本 `actorKind=AGENT` + `APPLIED` 口径；160ms `cubic-bezier(.2,0,0,1)` 淡入一次（整层重建不重播）+ 中性「AI」标记；减少动态效果下 animation:none、opacity 立即 1；F3f + `tests/d5-02-canvas-ai-marks.test.mjs` 11/11；见 §2 第 13 条 |
| D1（高）：编辑器本地保存后宿主改动永不呈现（`5b77186` 修复） | **已完成** | `public/novai-canvas/static/js/canvas.js:1642` + vendor 补丁 `experiments/d5-02/vendor-novai-app.mjs:103` + `public/novai-canvas/SOURCE.md:44`；F3d 实测 1820ms 呈现、revision 10 → 10 |
| D2（中）：设置 Defaults 在「显式默认能力不符」时显示 `No default configured` | **已完成** | `src/settings/ModelSettings.tsx:20,105,112`（补 disabled 选项显示已配置值与原因） |
| 视觉（我们新增 / 改动的元素） | **通过** | 12/18；说明行对比 18.16 / 19.05、chip 4.50–4.65；焦点环有效 2px + 2px；`var(--radius-md,8px)`；省略 + `title`；证据 `artifacts/d5-02/visual/`；见 §5 |
| 视觉（上游原版外观，按用户指令保留，不用 OpenArc DS 判定） | **不判定（仅记录适用范围）** | 上游控件字重 600–800；首页 hero 彩色主视觉；深色主题不传导到上游页面（画布页 / 首页仍浅色） |
| 动效（本轮改动 / 新增部分） | **通过** | c1 95ms / 约 190ms；c2 约 190ms + 上游 `fadeUp 0.7s`；c3 160–210ms；c4 0ms；c5 无反馈；证据 `artifacts/d5-02/motion/`；见 §5 |
| 动效 · MS §6「AI 新增节点 160ms 淡入 + 来源标记」（`4525ab8` 实现） | **已实现并验证** | F3f PASS（真机采样）；实现与边界见 §2 第 13 条 / §5 |
| 首页右下角回收站 FAB 显隐（第十五批 · 用户裁定：空 ⇒ 隐藏，非空 ⇒ 显示） | **已完成并验证** | 上游文件走 vendor 幂等补丁 `experiments/d5-02/vendor-novai-app.mjs` 的 `LIST_PATCHES`（4 处：标记 `hidden` / `.trash-fab[hidden]{display:none}` / DOM ref / `updateTrashBadge()` 里 `trashFab.hidden = count === 0`）；门禁 **F3g**（只新增）+ 真实 Electron 四态实测；见 §2 第 14 条 / §3 |
| 与用户截图对照首页基准（第十一批 · 第十四批收口判词 · 第十五批 FAB 收口） | **可比项一致（含右下角回收站 FAB） / 数据与条件项未验收**（不整体通过） | 基准 sha256 `557ce43d…`（2238x1654 = 1119x827 @dpr2）；我们 `artifacts/d5-02/visual-baseline/home-firstscreen-1119x827@2x.png`（同 2238x1654，第十五批在**回收站为空**的条件下重截，右下角与基准一样没有 FAB）；逐项表见 §5.1 |

## 2. 产品缺陷（本轮修掉，含 file:line）

1. **入口是「完整应用外壳」，还多出欢迎页 / 选画布遮挡层**：点「开始创作」只弹 picker，不直接进编辑器。修：入口改为上游原版列表首页 `src/canvas/CanvasHost.tsx:34`；三处入口改成建完直接跳 `canvas.html` —— `public/novai-canvas/static/canvas-list.html:1038-1039`（开始创作 / 新建画布）、`:1381`（继续上次空列表）；旧的 `reopenCurrentCanvasFromHome` 口径作废。
2. **完整应用外壳与宿主三块 chrome 还在**（左侧导航 + 其他子页入口 + 顶部操作条 / 状态行 / 提示横幅）：真删，不是隐藏。修：`src/canvas/CanvasHost.tsx:8`（宿主不画任何 chrome）、`:57`、`:674`（状态与提示的写点保留，渲染删除）；门禁 A1 / A2 断言「不存在外壳帧 / 不存在子页入口 / 不存在这些子页帧」。
3. **页面内部跳转丢掉 fragment 里的账号钥匙 → 桥把账号读成 `anon` → 清掉同账号刚写的数据**。修：`public/novai-canvas/openarc-bridge.js:38`（fragment 无 `oa=` 时回落到同源真实存储 `oa:mount`）、`:255`（两处都读不到就跳过那次清理，交给宿主 hello 的 `applyAccount`）、`:490`（alive 心跳 800ms）。
4. **供应商 / 模型存在第二来源**（NOVAI 配置页、静态清单、独立密钥、直连）。修：`electron/model-service.cjs:324`（`listModelsForUse` 与 `resolveModel` 同一授权口径：App 与 provider 都 enabled + app grant 含 `model.use`；PERSONAL 配置必须属于当前 actor）、`electron/model-bootstrap.cjs:114`（画布走 `canvas/models`）、`src/canvas/CanvasHost.tsx:138-160`（provider 只投影 id / 显示名 / 模型，不投影 baseUrl / protocol / 凭据）、`src/settings/ModelSettings.tsx:160-163,209,217`（总 API 设置补能力勾选与生图默认）；新增页面守卫 `public/novai-canvas/openarc-canvas-guard.js`（只注入编辑器页：`public/novai-canvas/static/canvas.html:537`），锁死三把页面侧模型来源键。门禁 B1 / B5 / N4 / N6。
5. **打开已有画布后编辑器停在只读**（`canvas.get` 成功但没把 `canEdit` 推给页面）。修：`src/canvas/CanvasHost.tsx:345-355`（`canvas.get` 后与 `canvas.create` 同一口径补 `pushContext`）；A6 / A10 / F4b。
6. **`ec5cbc5` 缺陷 A：显式配置的默认模型不可用时静默替换成清单第一个**。修：`electron/model-service.cjs:349-359`（`defaultsState{configId,usable,reason}`，reason 顺序与 `resolveModel` 一致：`MODEL_NOT_FOUND` → `MODEL_DISABLED` → `CAPABILITY_UNAVAILABLE` → `MODEL_UNAUTHORIZED`）；`src/canvas/CanvasHost.tsx:126-135`（服务没给事实时 fail-closed，不回落）；`public/novai-canvas/openarc-canvas-guard.js:107-122,394-395`（明确不可用 + 原因 + 引导，清单仍如实投影）；N5c / N5d。
7. **`ec5cbc5` 缺陷 B：被 CSP `frame-src` 拦下的自我导航把帧留在 Chromium 错误页**（导航没走到主进程，原约 10s 才等到 8s 心跳看门狗）。修：`src/canvas/CanvasHost.tsx:588-599`（iframe `onLoad` 后开 3s 说话窗口：3s 内一条本帧消息都没有 = 换出来的不是应用页 → 立即整帧复位）、`:690`（绑定 `onLoad`）、`:575-584`（8s 看门狗保留作兜底）；E5b。
8. **更早两个缺口的修复**：`9aabefe`（F3b：`electron/resource-service.cjs:534` 的 `readDataUrl` 读对象字节，画布重开能解析自己的图片；门禁改为走程序坞真关闭）、`527176e`（F4：`canvas.edit` 受控写入链四个阻断点 —— `electron/controlled-tool-proxy.cjs` / `electron/side-effect-authority.cjs` / `electron/tool-domain.cjs` / `electron/tool-registry.cjs:211,219,240,242`）。
9. **D1（高，`5b77186` 修复）：编辑器本地保存过一次之后，宿主侧的改动永远不呈现。** 根因：上游 `canvas.js` 的 `scheduleSave` 触发后 `saveTimer` 从不清空（上游只在 `beforeunload` 清），而远端同步入口 `applyRemoteCanvasData()` 的判空条件里含 `saveTimer` ⇒ 恒真，2.5s 远端同步被永久延后。真机 A/B：干净页 2.0s 出现 / 本地保存后 20s 不出现。修：`public/novai-canvas/static/js/canvas.js:1642`（`saveCanvas()` 真正保存前清空 `saveTimer`，幂等、目标缺失即报错）；vendor 补丁 `experiments/d5-02/vendor-novai-app.mjs:103`（`CANVAS_JS_PATCHES`）；登记 `public/novai-canvas/SOURCE.md:44`（第 5 处上游改动）。修复后 **1.83s 呈现**，用户内容与 revision 稳定（F3d）。
10. **D2（中，`5b77186` 修复）：总 API 设置 Defaults 在「显式配置的默认模型能力不符」时显示 `No default configured`**，与画布页「默认不可用」口径冲突。修：`src/settings/ModelSettings.tsx:20`（`defaultUnavailableText`：点名配的是哪个模型、为什么不可用）、`:105` + `:112`（`defaultOpts` 补 disabled 选项显示已配置值与原因）。
11. **D3 + 视觉五项（`5b77186`）**：说明行 / chip / 引导按钮字阶 **11/16 → 12/18**（DS §5 最小档）；说明行改正文中性色，对比 **4.35 → 18.16 / 19.05**；焦点环 `calc(2px / var(--studio-ui-scale,1))` 抵消上游 `.topbar` 的 zoom，有效 **2px + 2px**（像素实测左右环各 4 设备像素 = 2.00 CSS px）；圆角消费 `var(--radius-md,8px)`；说明行单行省略 + `title` 全文不溢出。位置：`public/novai-canvas/openarc-canvas-guard.js:191-200`、`:242`、`:262`。
12. **保存竞争（关闭条件③，`4525ab8` 修复）：页面 500ms 待保存窗口内的本地编辑撞上宿主 / AI 改动时被静默覆盖。** 根因：上游 409 分支的做法是"换上新基线（conflict 回包里的 updated_at / revision）→ 重发同一份旧文档" —— 页面内存里还没发出去的本地编辑在与对方改动比较时被当成过期版本覆盖掉。真机 A/B：修复前宿主改动在页面与存储**双双消失**、同一字段冲突**无副本**。修：改为**三方合并**（base = 最后一次成功同步的文档、local = 页面当前、remote = 冲突回包），按 node / edge id 合并，字段互不重叠各自保留；**同一字段两边都改 → 本地留在原位 + 远端那一版复制为 `<id>-remote`**（带 `oaConflictCopyOf` 标记 + 并排偏移）+ 中性可恢复提示；只重发合并结果、**最多 2 次**，达上限明确呈现"无法自动合并，双方内容都已保留"并停止（**不盲重试 409、debounce 一字未动**）。位置：`public/novai-canvas/static/js/canvas.js:15355`（`__CONFLICT_LIMIT = 2`）、`:15008-15170`（合并主体）、`:15449-15488`（冲突呈现与重发）；vendor 模板 `experiments/d5-02/vendor/canvas-merge.js` + `experiments/d5-02/vendor/canvas-internals.js:64-195`；补丁登记 `public/novai-canvas/SOURCE.md`（第 6、7 处上游改动）。宿主侧两处：`src/canvas/CanvasHost.tsx:381-395`（base 按存储当前事实对齐 —— 把页面声明的"最后一次成功同步的 updated_at"映射成 revision 再做乐观并发检查）、`:408`（冲突回包按 `canvas.get` 同一口径解析资源引用）。真机前后对照：修复后两边都在且重开仍在；回归：自动保存 / saveNow / 撤销重做 / 重开 / 旧 revision PUT→409 不覆盖 / 只读闸 全通过。新增单测 `tests/d5-02-canvas-merge.test.mjs` **12/12**；门禁 F3e。
13. **MOTION_SYSTEM §6（关闭条件②，`4525ab8` 实现）：「AI 新增节点 160ms 淡入 + 来源标记」之前未实现。** 修：以**命令账本**为唯一真源（宿主 `canvas/log` 里 `actorKind=AGENT` + `outcome=APPLIED` 的条目，**不是**"远端同步来的就是 AI"的猜测口径）；命中 id 的节点 → **160ms `cubic-bezier(.2,0,0,1)` 淡入一次**（`render()` 每次整层重建节点层，标记挂在 `renderNode()` 生成元素的那一刻；整层重建不重播 —— 处理了上游同一批内容连渲染两次的情况），并保留**中性「AI」来源标记**（12/18、字重 500、`#737373`、`border-width 0`、`--radius-sm 6px`、`pointer-events:none`、不挡节点按钮、节点尺寸不变）；**减少动态效果下 `animation:none`、`opacity` 立即 1**。实现位置：`public/novai-canvas/static/js/canvas.js`（注入层 `__ai*` 段）、模板 `experiments/d5-02/vendor/canvas-ai-marks.js` + `experiments/d5-02/vendor/canvas-internals.js:207-390`；宿主只读取账本 `src/canvas/CanvasHost.tsx:728-735`（`canvas/log` limit 200 + `canvas/get`，不新增命令面、不动权限口径）。真机实测（门禁 F3f）：opacity 11ms 采样为 0，随后 8 个中间帧单调升到 170ms 0.9986、187ms 到 1（同期另一组采样 161ms ≈0.999 / 177ms = 1），与 160ms 解析曲线拟合整体时移 **2ms**、最大偏差 **0.0068**；三类反证（页面手工新增 / 宿主 USER / 用户新增但被 AI 改过）全部无标记无动画；重开从账本重新推导保留标记；去重（每节点最多 1 个徽标、不重播）。**已知边界（如实登记）**：① 账本只记命令本身，`node.copy` / 不带 id 的 AI 新增对不上号 → 不猜不标记；② marks 只取最近 200 条账本。新增单测 `tests/d5-02-canvas-ai-marks.test.mjs` **11/11**；门禁 F3f。

14. **首页右下角回收站 FAB 没有任何显隐逻辑（第十五批 · 用户裁定后修掉）**：上游 6ce1a64 的 `.trash-fab` 是静态元素，只有角标按删除数显隐 —— 回收站为空时右下角照样挂着一个回收站按钮，与用户基准图（没有它）不一致，是第十一批视觉对照里**唯一待裁定的版本差异**。裁定：**空 ⇒ 隐藏，非空 ⇒ 显示**。修：**不新造第二套事实**，用上游 `updateTrashBadge()` 里已经存在的 `v4DeletedCanvases.length`（上游每次回收站变化都经过它：初始 `loadTrash` / 删除后 `loadTrash` / 恢复 / 彻底删除 / 清空 / 拦到 trash 响应）同时决定角标与 FAB —— ① 按钮标记加 `hidden`（页面还没有回收站数据时按"空"呈现，与角标 `style="display:none"` 同一约定，`loadTrash()` 的响应决定是否显示）；② 补 `.trash-fab[hidden] { display: none; }`（`.trash-fab` 自带 `display:flex`，会盖过 `[hidden]` 的 UA 规则）；③ DOM ref + `trashFab.hidden = count === 0`。**真隐藏**：不占布局（`getBoundingClientRect()` 0x0）、不进 tab 顺序、`elementFromPoint` 命中落空 —— 不是 CSS 遮挡。FAB 与角标永远同源，不会互相矛盾。补丁全部写在 `vendor-novai-app.mjs` 的 `LIST_PATCHES` 里（幂等、目标缺失即报错；连跑两次整棵树 109 个文件逐字节一致），登记在 `public/novai-canvas/SOURCE.md`（第 4 条 + 差异表第 18 条）。**真实 Electron 四态实测**（隔离 userData + CDP + 三步初始化向导；探针 `/tmp/oa-probe/fab-states.mjs`）：① 空 ⇒ `hidden=true` / `display:none` / 不占布局 / 角标 `display:none` / 命中落空；② 真删一本 ⇒ `hidden=false` / `display:flex` / 48x48 在右下角 (1039,747) / 命中落在 FAB 内 / 角标 `1` = 回收站列表长度 1；③ 面板「恢复」⇒ 回到隐藏（列表 0）；④ 同一本再删 ⇒ 显示（角标 1）→「清空回收站」+ 二次确认 ⇒ 回到隐藏（列表 0）。截图 `artifacts/d5-02/visual-baseline/fab-state-1..4*.png`。**发现（既有事实，第十五批只登记）→ 第十六批已修复**：宿主 iframe 当时是 `sandbox="allow-scripts allow-same-origin"`（缺 `allow-modals`）⇒ 页面里的 `confirm()` / `prompt()` / `alert()` 被 Chromium 直接忽略；上游卡片菜单的「删除 / 重命名 / 复制画布」与所有 `alert` 错误提示在宿主里点不动。第十六批把 sandbox 补成 `allow-scripts allow-same-origin allow-modals`（`src/canvas/CanvasHost.tsx:721`，工作树 HEAD `8cbab9b`；只放行 alert / confirm / prompt / print 这类模态对话，**不新增** fs / 网络 / origin / 脚本执行 / 跨源能力；实例 token 校验 / CSP / 只读闸一字未动）。真机前后对照与门禁 F3h 见 §2 第 15 条 / §3 / §6 第 9 条。

15. **第十六批：宿主 sandbox 补 `allow-modals`（卡片菜单真实产品路径修复；门禁只新增 F3h）**。
    - **改动（最小）**：`src/canvas/CanvasHost.tsx:721` 的 iframe sandbox 一行属性加 `allow-modals`；文件头注释（:12-16）与属性上方注释（:718-720）同步写明能力边界。`allow-modals` 只放行 `alert` / `confirm` / `prompt` / `print` 这类模态对话：**不加**文件系统、网络、origin、脚本执行、跨源能力；应用帧仍与外壳（file://）不同源，实例 token 校验 / CSP `connect-src none` / 只读闸全未动。
    - **修复前对照（未改 dist，真机 · 隔离 userData + CDP + 三步向导）**：卡片菜单「删除 / 重命名 / 复制画布」点下去 **0 个对话框事件**；控制台 3 条 `Ignored call to 'prompt()' / 'confirm()'. The document is sandboxed, and the 'allow-modals' keyword is not set.`；回收站 0 条；FAB 保持隐藏（`hidden=true` / `display:none` / 角标 0）。
    - **修复后（同一台架）**：confirm / prompt / alert **真的弹出**并被接受 —— `confirm: 确定要删除画布「…」吗？此操作可在回收站撤销。` ⇒ 卡片消失、`/api/canvases/trash` 长度 1、FAB `hidden=false` + `display:flex` + 角标 `1`；`confirm: 确定要复制画布「…」吗？` ⇒ 列表真的多出「… 副本」（2 本）；服务端 404 时上游 `alert('删除失败')` 真的弹出；跑完用产品入口（FAB → 清空回收站 → 二次确认）清回 0 条 + FAB 隐藏；0 条 `Ignored call to …`。
    - **仍存在的宿主边界（与 sandbox 无关，如实登记）**：Electron 本身不支持 `prompt()`（顶层页实测 `prompt() is not supported.`；sandbox 帧里返回 `null`，对话框事件能捕获但拿不到输入）⇒「重命名」入口只到「prompt 对话框真的弹出（消息 `重命名画布` + 默认值 = 画布名）」为止；要让重命名真正可用，需把上游 `prompt` 换成应用内模态（产品决定，本批未做）。
    - **门禁**：只新增 **F3h**（`experiments/d5-02/canvas-e2e.mjs`，**102 增 / 0 删**，本批 `git show --numstat bf8a6ba` 复核；F3g 与全部既有断言一行未改）。F3g 走产品命令层（`DELETE /api/canvases/:id` + 页面自取回收站）钉 FAB 显隐真源，F3h 走卡片菜单真实入口钉「模态对话真的弹出 + 真删除 + FAB 出现」，两条路径互不替代。独立探针 `experiments/d5-02/card-menu-modals-probe.mjs --phase=pre|post`（证据 `artifacts/d5-02/modals/{pre,post}-evidence.json` + `pre-*.png` / `post-*.png`）；F3h 逐字抽出的单独台架真机跑出 **PASS**（A0×2 + F3h，exit 0）。
    - **回归**：`npm run build` exit 0（tsc --noEmit + vite build）；`node --test tests/d5-02-canvas-*.test.mjs tests/d5-02-model-list-authorization.test.mjs` = 45 pass / 0 fail（6 个文件逐个复跑）；真机 E1（页面拿不到 window.openarc / Node / IPC / fs）、E4（伪造帧调用 0 回包）、E5（本地接收端 0 命中 + img / ws 被拦 + window.open 为 null）同台架复验通过；安全面探针 `experiments/d2-02/native/probes/02-security-surface.cjs` 只断言**外壳窗口**的 webPreferences 与冻结桥接面，不读应用 iframe 的 sandbox 字符串 —— 无需同步。

## 3. 门禁与回归（命令 / 退出码 / 计数 / 证据路径 / sha256）

**产品门禁（真实 Electron · 第十七批定稿）**

- 命令：`OPENARC_TESTED_COMMIT=$(git rev-parse HEAD) node experiments/d5-02/canvas-e2e.mjs`
- 被测 commit：`4dfe9231565331fd14a822d754c76dde83c8aa3b`（HEAD，工作树干净）
- 结果：**52 PASS / 0 FAIL / 52，exit 0**（比上轮新增 F3e / F3f / **F3g** FAB 显隐四态 / **F3h** 卡片菜单真实产品路径）；日志尾行 `结论：PASS — {"pass":52,"fail":0,"total":52,"notVerified":0}`、`GATE_EXIT=0`
- 证据：`artifacts/d5-02/d5-02-canvas-e2e.json`（sha256 **`33f9de1774a204fe855c00d9ab19e3c56dc2f44be5a05fc783abdbe324e8a1a9`**，本批 `shasum -a 256` 复核）；同名 `.log`（尾行 `结论：PASS — {"pass":52,"fail":0,"total":52,"notVerified":0}`）；截图 `artifacts/d5-02/d5-02-app-*.png`（`artifacts/` 被 gitignore，证据留在本工作树）
- `notVerified: []`；Z1 = clean（主进程无未处理错误）
- tracked 证据：`docs/D5-02-SCOPE-CORRECTION-EVIDENCE.json`（**52 条 checks** 逐条脱敏复制 + counts / env / regression / assertionChanges / notVerified；已按最终 artifact 重生成，含 F3g / F3h）
- 本轮新增断言（只增不改）：**F3e** = 保存冲突双向保留（500ms 待保存窗口受控交错：页面本地编辑 + 宿主 IPC 改动两边都在；同一节点同一字段 → 本地原位 + 远端 `<id>-remote` 副本；关窗重开仍在）；**F3f** = MS §6（AI 新增节点带中性来源标记 + 160ms `cubic-bezier(.2,0,0,1)` 淡入 + 减少动态效果 `animation:none` / opacity 立即 1 + 用户新增不误标 + 每节点最多 1 个徽标）
- **第十五批新增断言（只增不改）：F3g** = 回收站 FAB 显隐四态（空 ⇒ `hidden` + `display:none` + 不占布局 + 命中落空 + 角标不显示；真删一本 ⇒ 显示 + 角标计数 = 回收站列表长度 + 仍在右下角 + 命中落在 FAB 内；「恢复」⇒ 隐藏；「清空回收站」⇒ 隐藏）。`git diff --numstat` 对 `experiments/d5-02/canvas-e2e.mjs` = **99 增 / 0 删**（纯新增；0 删 ⇒ 既有断言既没删也没改，含 F3b / F3c / F3d / F3e / F3f / F4 / D1 / E1 / Z1）。F3g 已把该段**逐字抽出来**在真实 Electron + 隔离 userData 台架上跑过：**PASS**（台架 `/tmp/oa-probe/f3g-standalone.mjs`，控制台 0 错误；证据 `/tmp/oa-probe/f3g-standalone.json`）；**完整门禁已在第十七批定稿：52 / 52、exit 0（见 §3）**
- vendor 幂等（第十五批复跑）：`node experiments/d5-02/vendor-novai-app.mjs` 连跑两次 → `public/novai-canvas` 整棵树 **109 个文件逐字节一致**（合集 sha256 `197e3cdf945a1d7e…`）；`vendor/vendor-manifest.json` 的 `listHtmlHash` 两次相同（`aacb2cf8395f7b10`）
- 首页基准重截（第十五批）：按与第十一批相同条件（内容区 1119x827、dpr2、缩放 100%、浅色、宿主默认玻璃、`scrollY=0`、轮播固定第 1 张、5 本画布）在**回收站为空**的条件下重截 `home-firstscreen-*.png` / `home-cards-*.png`（覆盖旧产物），并重跑 `compare.py` / `pixdiff.py` / `sidebyside.py` / `finalize.js` 更新 `manifest.json`（新增 `fabFix` 段）与三张并排图；新增 `side-by-side-fab-region.png`（FAB 窗口 3 倍放大）。整幅像素差与上一批同量级（整幅首屏 mean|diff| 14.21 → 14.20，卡片行 32.67 → 32.62）→ 重截没有引入新差异
- 工作区并发说明（第十五批）：本轮期间同一工作树有**其它批次**同时改动 `electron/` / `src/` / `tests/`（D5-03 MCP 相关，非 D5-02 文件；`git status` 可见，本批未碰它们）。本批只改本节开头列出的 7 个文件；首页重截与两个真实 Electron 台架跑的是本批 20:19–20:20 `npm run build` 产出的 `dist`（含本批 vendor 补丁，不含 20:22 之后其它批次的 `src` 改动）；收尾的 `npm run build`（此时已包含并发改动）仍 **exit 0**
- 检查项分组（**52 条**）：A 系列 12（A0 × 2 + A1–A10）；N 系列 8（N1–N4 / N6 / N5a / N5c / N5d）；B 系列 6（B1–B6）；D 系列 5（D1–D5）；F 系列 **11**（F1 / F3a–F3h / F4b / F4）；E 系列 9（E1–E8 含 E5b）；Z1
- 门禁文件变更（可复核）：`git diff --numstat 5b77186 2a97b95 -- experiments/d5-02/canvas-e2e.mjs` = **145 增 / 0 删**（纯新增）；第十五批 `git show --numstat a32c53d` = **99 增 / 0 删**、第十六批 `git show --numstat bf8a6ba` = **102 增 / 0 删**（都是纯新增）；F1 / F3a / F3b / F3c / F4 / D1 / E1 / Z1 的断言语句在 `9aabefe` → `2a97b95` 各提交间**逐字节哈希相同**

**构建 / 单测**

- `npm run build` → **exit 0**（`tsc --noEmit` + `vite build`）
- 整套 d5-02 单测：`node --test tests/d5-02-canvas-*.test.mjs tests/d5-02-model-list-authorization.test.mjs` → **45 pass / 0 fail**（本批复跑；文件 = `d5-02-canvas-service` / `-tool` / `-edit-proposal` / `-merge` / `-ai-marks` + `model-list-authorization`）。旧的「22/22」是其中 4 个文件的口径，已被本口径取代。
- 本轮新增：`tests/d5-02-canvas-merge.test.mjs` **12/12**、`tests/d5-02-canvas-ai-marks.test.mjs` **11/11**
- `tests/governance-app-model-grant.test.mjs` → **4/4**
- `tests/model-*.test.mjs` 全套 8 个文件 → **59/59**（model-bootstrap / model-isolation / model-performance / model-proxy-child / model-proxy / model-secret-scan / model-service-stream / model-service；文档岗复跑核对，取代旧的「60/60」口径）
- 两条**预存在**失败（与本轮改动无关，**未改断言**）：`tests/side-effect-c4-gates.test.mjs:474` 源扫描断言（「主进程绝不 in-process 执行 write」）与 D5-02 的 in-process 执行类冲突；`tests/d4-03-approval-push-isolation.test.mjs:103` 快照白名单少 D5-01 的 `targetRef` / `url`。两条已在**干净 HEAD 导出树**复现同样失败 → 如实登记为既有缺口，继续单列。

## 4. 断言变更披露

1. **A 系列重写（A1–A10）**：产品形态变更（入口从完整外壳改为无限画布首页），旧 A1 / A2 / A3 / A6 / A7 与 `reopenCurrentCanvasFromHome` 口径作废重写；新增「无外壳 / 无 chrome / 无其他子页入口 / 无遮挡层 / 卡片直达 / 继续上次」。
2. **B1 更严**：`api_providers` 从空数组改为真实投影，数量 = IPC 真值交叉核对、键集合 ⊆ {id,name,enabled,chat_models,image_models,video_models}、泄漏正则加宽（`base_url|protocol|has_key|key_preview|token|localhost|127.0.0.1`）。
3. **B5 更严**：错误码由桥兜底 `OPENARC_UNSUPPORTED` 改为页面守卫的 `CAPABILITY_UNAVAILABLE`（守卫在桥之前截住），并 AND 上 `available:false` / `transport:null` / `detail` 非空。
4. **E8 更严**：A / B 两账号各自用页面 scoped localStorage 写探针键，`own>=1` 有真实来源；新增 `isoA.foreign===0`、own 增量、A 的键在 B 侧读为 null。
5. **N5c / N5d 本轮新增后按契约改写**：N5c 去掉「生图清单必须为空」（与「清单如实投影」相反），改为断言 `data-openarc-default-unavailable` + disabled + 运行按钮 blocked + 原因文案与引导 + 清单仍在 + `select.value` 为空 + 文本区不受影响 + 恢复后标记消失；N5d 三条 0 命中保留，把「下拉仍可选」改成「默认不可用口径」（原因码必须是 `MODEL_DISABLED`）。
6. **F3b / F3c / F4 断言一字未动**（逐字节相同）。
7. **Z1 只把 macOS IMKit 系统消息 `IMKCFRunLoopWakeUpReliable` 加入噪声白名单**（不是放宽判定）。
8. **F3d 只新增**：本地编辑并落库后宿主 `canvas/command` 新增节点 ≤5s 呈现 + 用户内容仍在 + revision 5s 稳定；既有断言一行未动。
9. **F3e 只新增**：500ms 待保存窗口内的受控交错（两边内容都保留 + 同一字段冲突留 `<id>-remote` 副本 + 关窗重开仍在）；既有断言一行未动。
10. **F3f 只新增**：MS §6 标记 + 160ms `cubic-bezier(.2,0,0,1)` 淡入 + 减少动态效果即时呈现 + 用户新增不误标 + 每节点最多 1 个徽标；`2a97b95` 只把取注入层证据的路径改走 `primitives.aiMarks`，**判定条件未动**。
11. **没有为了让测试变绿改任何断言**（本批可复核）：`5b77186` → `2a97b95` 对 `experiments/d5-02/canvas-e2e.mjs` 是 **145 增 / 0 删**（纯新增）；F1 / F3a / F3b / F3c / F4 / D1 / E1 / Z1 的断言语句在 `9aabefe` → `2a97b95` 各提交间**逐字节哈希相同**；两条预存在失败照旧单列、未改断言。
12. **F3g 只新增（第十五批）**：回收站 FAB 显隐四态（空 / 真删一本 / 恢复 / 清空）；对本文件是 **99 增 / 0 删**（纯新增，0 删 ⇒ 既有断言一行未改）。删除与回收站刷新走产品自己的命令层（`DELETE /api/canvases/:id` + 页面自取 `/api/canvases/trash`），原因见 §2 第 14 条的 sandbox 发现；断言只看 FAB 的 DOM 事实（`hidden` / computed `display` / 是否占布局 / 命中测试）与回收站列表长度。
13. **F3h 只新增（第十六批）**：卡片菜单真实产品路径（宿主 iframe sandbox 补 `allow-modals` 后）—— 复制 confirm 弹出并 accept ⇒ 列表真的多出「… 副本」；删除 confirm 弹出并 accept ⇒ 卡片消失 + 真进回收站（长度 +1）+ FAB 出现且角标 = 回收站长度；重命名 prompt 对话框真的弹出（消息 `重命名画布` + 默认值）；服务端失败 ⇒ `alert('删除失败')` 真的弹出；跑完用产品入口清空回收站回到 0 条 + FAB 隐藏。对本文件是 **102 增 / 0 删**（纯新增，0 删 ⇒ F3g 与全部既有断言一行未改；本批 `git show --numstat bf8a6ba` 复核）。断言只到「对话框真的弹出」为止，重命名真正可用仍受 Electron 不支持 `prompt()` 的宿主边界限制（§2 第 15 条 / §6 第 9 条）。

## 5. 功能 / 视觉 / 动效

- **功能**：**通过** —— 真实 Electron 门禁 **52 PASS / 0 FAIL / 52（exit 0，commit `4dfe923`，工作树干净）**，门禁 `notVerified: []`、Z1 = clean；首页 / 新建 / 继续上次 / 打开已有画布 / 返回首页 / 无模型 / 停用撤权 / 各已支持模型真实调用 / 保存冲突（F3e）/ MS §6（F3f）全部有断言与实机证据。证据见 §3。
- **视觉（我们新增 / 改动的元素）**：**通过** —— 中性灰（chip / 说明行 `rgb(115,115,115)`、按钮 `rgb(10,10,10)`，像素 spread ≤3，无蓝 / 彩色）；无发丝线框（我们元素 border 全 0）；字重 400/500；字阶 12/18；说明行对比 18.16 / 19.05、chip 4.50–4.65；焦点环有效 **2px + 2px**（像素实测左右环各 4 设备像素 = 2.00 CSS px）；圆角 `var(--radius-md,8px)`；禁用态 disabled + aria-disabled + 原因文案；说明行单行省略 + `title` 全文不溢出。证据：`artifacts/d5-02/visual/`（25 张截图 + 3 份 manifest + `visual-checks.md` + `computed-styles*.json` + `pixel-samples.json`）。
- **视觉（上游原版外观，按用户指令保留、不用 OpenArc DS 判定）**：只记录适用范围 —— 上游控件字重 600–800；首页 hero 彩色主视觉；深色主题不传导到上游页面（画布页 / 首页仍浅色）。
- **动效（本轮改动 / 新增部分）**：**通过** —— c1 首页→编辑器：点击后 95ms 起画面切换、约 190ms 帧间差归 0（无残影 / 无布局抖动）；c2 返回：约 190ms 换页，之后是上游首页卡片自身 `fadeUp 0.7s`（约 620ms 稳定）；c3 守卫说明行 160ms 淡入（`duration.quick` + `easing.standard`，实测 160–210ms）；c4 减少动态效果下 0ms（animation none / 0s，达标 ≤100ms）；c5 点击被禁用的视频下拉：DOM 指纹不变、无浮层、无状态变化（仅有上游 2.5s 轮询的整体重渲染）。证据：`artifacts/d5-02/motion/`（8 段共 1824 帧 PNG + `motion-summary.md` + `motion-report.json` + `ai-node-report.json`）。
- **动效（MS §6）**：**已实现并验证（`4525ab8`）** —— 「AI 新增节点 160ms 淡入 + 来源标记」：以命令账本 `actorKind=AGENT` + `APPLIED` 为唯一真源（不是"远端同步=AI"的猜测口径），命中节点 160ms `cubic-bezier(.2,0,0,1)` 淡入一次（整层重建不重播）+ 中性「AI」标记（12/18、字重 500、`#737373`、`border-width 0`、`--radius-sm 6px`、`pointer-events:none`、不挡节点按钮、节点尺寸不变）；减少动态效果下 `animation:none`、opacity 立即 1。真机实测（F3f）：11ms 采样 0 → 8 个中间帧 → 187ms 到 1（同期另一组采样 161ms ≈0.999 / 177ms = 1），与解析曲线拟合整体时移 2ms、最大偏差 0.0068；三类反证（页面手工新增 / 宿主 USER / 用户新增被 AI 改过）全部无标记无动画；重开从账本重新推导保留标记。已知边界见 §2 第 13 条。
- **与用户截图对照（首页基准 · 第十一批对照 / 第十四批收口判词）**：**基准已在工作区，对照已做** —— 基准 `artifacts/d5-02/baseline/user-home-baseline.png`（tracked 同内容副本 `docs/snapshots/2026-09-24-user-home-baseline.png`；两处 sha256 相同），sha256 `557ce43d865a1a08cd883daf116eea1ef54793dac7438d916753dddaae80d127`，2238x1654 像素 = **1119x827 逻辑 @dpr2**、浅色；原始来源（Codex 剪贴板临时文件）`/var/folders/49/m7hfshm96vl9xkmkpjrygqqc0000gn/T/codex-clipboard-48126615-7162-4f0d-b262-6ee0d399e5d8.png`（sha256 相同，仍存在），复制留档时间 **2026-09-24 15:43:13**。**结论：可比项一致（结构 / 尺寸 / 字体层级 / 按钮主次 / 网格列数 / 徽标 / 圆点 / 主题 / dpr / 缩放 / 背景，多数量到 0px 差）；未验收（数据）：画布数量 13 vs 5、「所有画布 · N 个」、卡片标题 / 缩略图 / 时间戳；未验收（条件）：(2.0, 9.0)px 整体平移、布局视口宽差 2px、真实窗口可达内容区 1119x758（827 靠视口模拟）；**右下角回收站 FAB：第十五批已按用户裁定实现并重截后判「一致」**（空 ⇒ 隐藏、非空 ⇒ 显示；重截时回收站为空，FAB 窗口 (1039,747)-(1087,795) 与基准逐像素 mean|diff| 0.62/255、max 10、>24 占 0.00%）。不整体宣布"视觉通过"。** 逐项表见 §5.1。

### 5.1 首页视觉基准对照（第十一批 · 2026-09-24）

**取图方式**（真实 Electron + 隔离 userData + CDP + 三步初始化向导 setup-name→next→identifier→next→password/confirm→submit）：目标 = **画布应用窗口的内容区**（宿主 iframe 元素本身，不含宿主窗口标题栏、不含桌面），用 Playwright 元素级截图；首页滚到顶部（scrollY=0）。产物在 `artifacts/d5-02/visual-baseline/`（artifacts/ 被 gitignore）：

| 产物 | 实际条件 |
| --- | --- |
| `home-firstscreen-1119x827@2x.png`（2238x1654） | 内容区 1119x827、dpr2、缩放 100%、浅色、宿主默认玻璃、scrollY=0、轮播固定第 1 张、5 本画布；**与基准同像素尺寸，判定主图** |
| `home-firstscreen-1152x827@2x.png`（2304x1654） | 同上，布局视口宽 1152（按基准版面反推：页面 960 居中 → 左右各 96） |
| `home-firstscreen-1119x758@2x-physical.png`（2238x1516） | **真实窗口夹取上限**（宿主 Electron 窗口固定 1440x940；electron/window-manager.cjs 的 resize 把 h 夹到 host.h-100-y），够不到 827 |
| `home-cards-*.png` | 同条件的 y 430–底 裁切（区块头 + 卡片行 1 + 行 2 被裁） |
| `host-window-context-*.png` | 含宿主窗口条的整窗截图，只作来源留证，不用于对照 |
| `side-by-side-firstscreen-1152.png` / `-1119.png` / `side-by-side-cards-1152.png` | 基准在上、我们在下的并排 |
| `baseline-home.png` / `baseline-home-cards.png` | 基准副本（原图 / 卡片区裁切） |
| `manifest.json` | 每张图的实际 inner/outer 尺寸、dpr、缩放、主题、背景与透明度、滚动位置、画布数量、时间；条件逐项对照；逐项判定；位移证据；像素差 |

尺寸怎么对上的：Electron 不实现 Browser.getWindowForTarget，改不了 OS 窗口尺寸，物理口径最多 1119x758；827 高改用 CDP Emulation.setDeviceMetricsOverride(width=tw, height=th+82, deviceScaleFactor=2) + 页面内画布窗口**最大化**（maximizedBounds = {0, 38, host.w, host.h-38}）达到，dpr 仍为 2；两条口径都留了产物。

| 项目 | 基准 | 我们 | 判定 |
| --- | --- | --- | --- |
| 图幅 / 逻辑尺寸 | 2238x1654 = 1119x827 | 2238x1654 = 1119x827（命中） | 一致 |
| 主题 / dpr / 缩放 | 浅色 #f5f5f7 / 2 / 100%（页面 data-studio-scale="off"） | 同（ui-scaled 未加、body transform none、html zoom 1、visualViewport.scale 1） | 一致 |
| 背景与玻璃透明度 | 页面自身不透明底 #f5f5f7 | 同（宿主 --content-alpha .94 / --surface-alpha .68 / blur(34px) saturate(1.8) 在页面之下，不影响内容区像素） | 一致 |
| 页面内容宽与居中 | 960 居中 | 960 居中（grid-template-columns: 312px 312px 312px、gap 12） | 一致 |
| 标题「无限画布」 | ink 189.5x44.5 | ink 189.5x44.5（48px / 400 / .02em） | 一致 |
| 说明两行 | 2 行、行距 24、ink 高 39 | 同 | 一致 |
| 主按钮「＋ 开始创作」 | 144.5x51 实心黑 | 144.5x51 实心黑 | 一致 |
| 次按钮「继续上次」 | 白底 + 时钟图标 + 深字 | 同（146.6x51） | 一致 |
| hero 轮播块 | 450x298 深色（CSS 452x300，圆角 16） | 450x298 | 一致 |
| hero 图与信息条 | 第 1 张 jpg +「文生图创作 / 输入提示词，快速生成高质量概念图」ink 399x32 + 右侧「图像生成」 | **同一份 jpg**（carousel-image-generation.jpg）、同文字同尺寸（截图前点圆点固定第 1 张，activeSlide=0） | 一致 |
| 轮播圆点 | 3 个（1 个 active 药丸 24x8 + 2 个小圆点） | 3 个（同形态） | 一致（**用户口述"4 个"与图不符**，按图判 3 个） |
| 「所有画布 · N 个」 | 「所有画布 · 13 个」ink 86.5x10 | 「所有画布 · 5 个」ink 81.5x10 | **未验收**（数据不同；字阶 / 位置一致） |
| 「＋ 新建画布」 | 116.5x39.5 | 116.5x39.5 | 一致 |
| 卡片网格列数 / 列宽 / 间距 | 3 列 x 312、gap 12 | 3 列 x 312、gap 12（列距 324 两边相同） | 一致 |
| 卡片预览区结构 / 徽标「智能」 | 高 140、2x2、aspect 16/10 / 40.5x21 | 同 / 同 | 一致 |
| 卡片缩略图 / 标题 / 时间戳**内容** | 用户 13 本真实画布（有缩略图、真实标题与时间） | 隔离 userData 用宿主 canvas/create 播的 5 本「智能画布 HH:MM」（缩略图空占位） | **未验收**（数据不同；字号 / 字重 / 颜色一致） |
| 第二行被裁切构图 | 有 | 有 | 一致 |
| 右下角回收站 FAB（判定窗口 = FAB 自己的 DOM rect (1039,747)-(1087,795)） | **没有**（该窗口最暗 237、非背景 5.16%、darkPct 0） | **没有**（同窗口最暗 244、非背景 0.00%、darkPct 0 —— 回收站为空 ⇒ 真实隐藏；非空态该窗口非背景 90.68%、darkPct 5.16%、最暗 76） | **一致**（第十五批按用户裁定实现"空 ⇒ 隐藏，非空 ⇒ 显示"并重截：同窗口逐像素 mean\|diff\| 0.62/255、max 10、>24 占 0.00%；四态实测见 §2 第 14 条。旧口径区域里那个"最暗 22"是第三列卡片的深色角标、不是 FAB） |
| 整幅绝对位置 | 内容在 (0,0) | 整体右移 2.0px、下移 9.0px | **未验收**（差 2.0 / 9.0px） |
| 布局视口宽（由页面左边缘反推） | `~1156（页面左 98）~` | 1119（页面左 79.5）/ 1152（页面左 96） | **未验收**（差 2px） |
| 真实窗口可达内容区 | —— | 1119x758（宿主 1440x940 + resize 夹取） | **未验收**（高差 69px；827 靠 CDP 视口模拟达到） |

**位移证据（说明"差的只是平移，不是布局"）**：内部相对距离逐项相同 —— 轮播顶→主按钮顶 195.0 / 195.0；轮播顶→「所有画布」顶 377.5 / 377.5；轮播顶→「新建画布」顶 363.0 / 363.0；轮播顶→卡片标题顶 601.5 / 601.5；标题 ink 顶→轮播顶 −55.5 / −55.5；按钮 144.5x51、新建按钮 116.5x39.5、列宽 312、列距 324 全为 0 差。基准图内白字 bbox 与我们的差恰好 (2.0, 9.0)px；位移补偿后 hero 图区域 mean|diff| **6.59/255**（>24 的像素占 2.51%），不补偿 17.63。**结论：布局与基准一致，整幅只差一个 (2.0, 9.0)px 平移**；基准侧更像"内容被上移 9px（滚动或被裁切 9px）+ 视口宽约多 4px"，我们在"滚动到顶 + 960 居中"下无法复现该偏移。

**版本差异的直接证据（第十一批原始记录）**：基准图右下角**没有**回收站 FAB，我们的同一区域**有**；而 .trash-fab 在上游 6ce1a64 的 canvas-list.html 里是无显隐逻辑的静态元素（只有角标按删除数显隐）。→ 基准侧页面版本与我们 vendor 的 commit 不是同一版。**（第十五批收口）** 用户裁定「回收站为空时隐藏右下角按钮，有已删除画布时显示」，已实现并四态实测（§2 第 14 条），随后在**回收站为空**的条件下重截首页：**FAB 窗口改为用 FAB 自己的真实 DOM rect (1039,747)-(1087,795) 判定**（旧口径 (1000,760)-(1119,827) 里混着第三列卡片的深色角标，"我们最暗 22"其实是那个角标，不是 FAB）：基准该窗口非背景 5.16% / 最暗 237 / darkPct 0；我们重截后非背景 0.00% / 最暗 244 / darkPct 0；**逐像素 mean|diff| 0.62/255、max 10、>24 占 0.00%** → **这一项判定从「不一致（版本差异）」改为「一致」**。非空态在同一窗口真出现（状态②：非背景 90.68%、darkPct 5.16%、最暗 76；状态① vs ② mean|diff| 25.39、>64 占 13.32%），恢复 / 清空后回到背景；门禁 F3g + 探针四态证据见 §2 第 14 条与 `artifacts/d5-02/visual-baseline/manifest.json` 的 `fabFix` 段、`side-by-side-fab-region.png`。

**工作区并发说明**：本轮截图期间有其他批次在同一工作树改了 vendor / 源文件（mtime 15:52–15:54，git status 可见）；其中本轮截图依赖的页面 public/novai-canvas/static/canvas-list.html 内容与 HEAD 1dee910 **一致**（git 不报差异），宿主 dist/ 构建时间 14:52 早于这些改动，故截图对应的仍是 HEAD 状态。本批未改任何产品代码。

## 6. 未闭合 / 下一步

1. **视觉对照里剩下的"未验收"项（按"条件无法完全匹配 → 未验收"如实登记，不再是阻塞项；§5.1）**：① **数据项** —— 画布数量 13 vs 5、「所有画布 · N 个」、卡片标题 / 缩略图 / 时间戳内容（隔离 userData 里是宿主 `canvas/create` 播的 5 本，需要真实数据才能比）；② **条件项** —— 整幅 (2.0, 9.0)px 平移、布局视口宽差 2px、真实窗口可达内容区 1119x758（宿主窗口固定 1440x940 + `electron/window-manager.cjs` 的 resize 夹取 maxH=host.h-100-y，827 高靠 CDP 视口模拟达到）；③ **原来的「1 项版本差异待用户裁定」（回收站 FAB）已关闭** —— 用户裁定「回收站为空时隐藏右下角按钮，有已删除画布时显示」，第十五批已实现 + 真实 Electron 四态实测 + 在空回收站条件下重截对照，判定从「不一致（版本差异）」改为**一致**（§2 第 14 条 / §5.1）；**关闭条件①已满足**。
2. **两条预存在失败测试继续单列、不改断言（关闭条件②）**：`tests/side-effect-c4-gates.test.mjs:474`、`tests/d4-03-approval-push-isolation.test.mjs:103`（干净 HEAD 导出树同样复现，与本轮无关）。
3. **既有 NOT VERIFIED 不变（关闭条件③）**：Windows / 多屏 / 高 DPI 等，逐条见 `docs/D5-02-SCOPE-CORRECTION-EVIDENCE.json` 的 `notVerified`。
4. **F3d / F4-presented 依赖页面 2.5s 轮询与窗口前台状态**：窗口被完全遮挡时 Chromium 会节流；F3d 已 `bringToFront` 兜住。
5. **其他 NOVAI 子页文件仍在 bundle 内但无入口不可达**（smart-canvas 亦不可达，未注入适配层 / 守卫）。
6. **视频 / ComfyUI / RunningHub 等保持「明确不可用」**：未接通链路未启用。
7. **MS §6 的已知边界（见 §2 第 13 条）**：账本只记命令本身 —— `node.copy` / 不带 id 的 AI 新增对不上号，不猜不标记；marks 只取最近 200 条账本。
8. **回收站 FAB 的更新时机与角标同源（如实登记，不是缺陷）**：FAB 显隐与角标都由 `updateTrashBadge()` 决定 —— 它随**页面自己**的回收站刷新时机更新（页面加载、删除后 `loadTrash()`、恢复、彻底删除、清空、拦到 trash 响应）。宿主侧绕过页面直接改回收站（当前产品里没有这条用户路径）时，页面要等下一次自己取回收站才跟上，与上游角标的行为完全一致；本轮不额外加轮询。
9. **宿主 sandbox 忽略 `confirm()` / `prompt()` / `alert()` —— 第十六批已修复（见 §2 第 15 条）**：`src/canvas/CanvasHost.tsx:721` 的 iframe sandbox 由 `allow-scripts allow-same-origin` 补为 `allow-scripts allow-same-origin allow-modals`。修复前：卡片菜单「删除 / 重命名 / 复制画布」0 个对话框事件 + 控制台 3 条 `Ignored call to …`；修复后：删除（confirm）真进回收站 + FAB 出现（角标 = 回收站长度）、复制画布（confirm）真出副本、错误路径 `alert('删除失败')` 真的弹出、重命名（prompt）对话框真的弹出。**仍存在的宿主边界（与 sandbox 无关）**：Electron 不支持 `prompt()`（`prompt() is not supported.`，帧里返回 null）⇒ 重命名只到对话框弹出为止，要真可用需把上游 prompt 换成应用内模态（产品决定）。门禁只新增 F3h，既有断言（含 F3g）一行未改。

## 7. 判定

**判定：D5-02 = PASS（限定范围）。**

- 功能 = **通过**（**第十七批定稿：真实 Electron 门禁 52 PASS / 0 FAIL / 52、exit 0、`notVerified: []`、Z1 clean（被测 commit `4dfe923`，工作树干净）**；首页 / 新建 / 继续上次 / 打开已有画布 / 返回首页 / 无模型 / 停用撤权 / 各已支持模型真实调用 / 保存冲突（F3e）/ MS §6（F3f）/ 回收站 FAB 显隐（F3g）/ 卡片菜单真实产品路径（F3h）全部有断言与实机证据。**第十五批只新增 F3g**（99 增 / 0 删，既有断言一行未改，逐字抽段台架 PASS）；**第十六批：宿主 iframe 补 `allow-modals` 修掉「卡片菜单删除 / 复制 / alert 不可用」，门禁只新增 F3h**（102 增 / 0 删，F3g 与全部既有断言一行未改，逐字抽取的单独台架 PASS；重命名仍受 Electron 不支持 `prompt()` 的宿主边界限制）；**两条新断言都已包含在最终 52 项门禁里**）。
- 视觉 = 对照已完成、可比项**一致**（含右下角回收站 FAB：空态同窗口逐像素 mean|diff| 0.62/255、max 10、>24 占 0.00%）；数据项与条件项**未验收**（如实登记，不再是阻塞项）。**不整体宣布"视觉通过"。**
- 动效 = 本轮改动 **通过**，**MS §6 已实现并验证**（160ms `cubic-bezier(.2,0,0,1)` 淡入 + 中性「AI」标记 + 减少动态效果立即呈现；F3f PASS）。**第十五批的 FAB 显隐不引入新动效**：显隐即时生效，上游 FAB 自带的 hover / active 过渡原样沿用，未新增 / 未改任何动效参数。

关闭条件（第十七批定稿）：① **用户对回收站 FAB 的裁定 —— 已满足并关闭**（裁定「回收站为空时隐藏右下角按钮，有已删除画布时显示」；已实现 + 四态实测 + 重截对照判「一致」，见 §2 第 14 条 / §5.1）；② 两条**预存在**失败测试（`tests/side-effect-c4-gates.test.mjs:474`、`tests/d4-03-approval-push-isolation.test.mjs:103`，已在干净 HEAD 导出树复现，与本轮无关）继续单列、不改断言；③ 既有 NOT VERIFIED（Windows / 多屏 / 高 DPI 等）不变；④ 已知边界如实登记不变：AI 标记只覆盖账本里带 id 的新增、marks 只取最近 200 条账本、视觉数据 / 条件项未验收、FAB 与角标同源（随页面自身的回收站刷新时机）；**第十六批已修掉「宿主 sandbox 忽略 `confirm` / `prompt` / `alert`」**（sandbox 补 `allow-modals`，只放行模态对话，§2 第 15 条 / §6 第 9 条），F3g 与既有断言一行未改、只新增 F3h（**102 增 / 0 删**）；**`prompt` 的 Electron 宿主边界保留**（重命名入口只到「prompt 对话框真的弹出」为止，要真可用需把上游 prompt 换成应用内模态，属产品决定）。**最终门禁 = 52 PASS / 0 FAIL / 52、exit 0、`notVerified: []`、Z1 clean（被测 commit `4dfe923`）**；tracked 证据 `docs/D5-02-SCOPE-CORRECTION-EVIDENCE.json` = 52 条 checks。

---

# D5-03 第一批 · MCP 中心（连接管理与能力发现）· 2026-09-24（`d583154`）

> **口径（用户明确定范围）**：**本批 = 连接管理与能力发现**；**不开放 MCP 工具调用、不运行任意第三方本地程序、不连真实第三方、不发用户数据、不把连接成功写成插件隔离已通过**。判定：**D5-03 第一批（连接管理与能力发现）= PASS（限定范围）**；**D5-03 整体 = PARTIAL**（剩余：OAuth、长连接流、真实第三方 / Adobe 服务 D5-04/05、插件隔离 D5-08、部分授权主路径与跨登录撤销缺口 —— 见 §5）。**【第二批已更新】** 该两项缺口已由第二批闭环；本节的 `notVerified: 1`、恢复口径、artifact sha256 均以紧随其后的第二批节为准。完整结果文档 `docs/D5-03-RESULT.md`；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json`（38 条 checks 逐条脱敏复制 + counts / sha256 / boundary / 缺陷修复链 / 回归计数 / notVerified）。
>
> **被测内容 = `d583154`（干净代码树复跑，2026-09-24 21:54）**：门禁命令 `OPENARC_TESTED_COMMIT=$(git rev-parse HEAD) node experiments/d5-03/mcp-center-e2e.mjs`；artifact 的 `openarcCommit=d583154a7b4dbb3b249f288b4ed23c09eb286fc2`、`gitDirtyLines=5` —— **这 5 个未提交文件全部是本批文档**（`PROGRESS.md` + 4 个 `docs/` 文档），**没有任何代码 / 脚本 / 断言未提交改动**（`git diff d583154 <文档提交> --stat` 可核对；不写成"完全干净树"）。artifact 里 8 个 MCP 源码指纹与工作树**逐条相同**（第十七批文档岗按脚本的 `fileSha` 复核）。**（历史，仅备查）** 上一轮 artifact 记录的是 `openarcCommit=4dfe923` + `gitDirtyLines=12`（修复提交前的树）；本轮以干净树复跑的新 artifact 为准。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 真实 Electron 门禁（`OPENARC_TESTED_COMMIT=$(git rev-parse HEAD) node experiments/d5-03/mcp-center-e2e.mjs`，HEAD `d583154` 干净代码树复跑） | **已完成** | **38 PASS / 0 FAIL / 38，exit 0**；`productDefects: []`；`notVerified: 1`（**【第二批已更新】重跑后为 0 条**）；Z1 clean；artifact `artifacts/d5-03/mcp-center-e2e.json`（sha256 `dca23cb7b78df4997852500cebcabc5e2ad4e013795259b23b692ee8fc7aca23**【第二批已更新：该 artifact 已被重跑覆盖，当前 sha256 = `d8f9a23781ff590aaa395b076defcb1f2cb141eef24618424ed102913b86a2e0`】**`，本批 `shasum -a 256` 独立复核；`openarcCommit=d583154`、`gitDirtyLines=5` 全部为本批文档）+ 日志 `artifacts/d5-03/mcp-center-e2e-rerun.log` |
| 后端：连接管理与能力发现 | **已完成** | `electron/mcp-{domain,store,client,service,bootstrap}.cjs`；白名单 10 条命令；20 个稳定错误码；v20 迁移三张表；远程 URL 复用 `model-domain.validateEndpoint`；凭据只存 ref + safeStorage；授权 / 审计走 D3-02 的 `mcp.view/use/manage/test` |
| 本地 stdio 生产路径 | **已完成**（`d583154` 修 D2） | `electron/executor-launcher.cjs:226-251` 新增 `createMcpStdioLauncher`（Electron main = `process.execPath` + `ELECTRON_RUN_AS_NODE=1`；纯 Node 同一 launcher）；C2 协商值与 fixture 参照逐字一致；D1 重连 `toolsHash` 不变；D2 测试日志含 `TOOLS_DISCOVERED` |
| 远程 http（streamable HTTP 单响应） | **已完成** | F0 / F1 / F1a；协商常量与 stdio 同一组；执行位置 = 远程服务 |
| 前端「MCP 中心」窗口 | **已完成** | `src/mcp/McpCenter.tsx`（1594 行）+ `src/styles.css` 61 条 `.mcp-*` 规则；列表 / 详情 / 能力表 / 测试日志；PLAN §22 四态；**0 个工具调用入口** |
| 受控测试服务 | **已完成** | `tests/fixtures/mcp/echo-server.mjs`（stdio + HTTP；可控失败模式 `--auth-token` / 协议 `1999-01-01` / `--no-response`） |
| 空态新建入口（D1 修复） | **已完成** | `src/mcp/McpCenter.tsx:963-974`（空态自渲染 `data-mcp-action=create`，PageState 共享语义未动）；B3 / C1（`placeholderUsed=null`） |
| 失败后刷新列表与详情（D3 修复） | **已完成** | `src/mcp/McpCenter.tsx:445-452`；G3a（鉴权失败当下出现重授权入口）/ G4（如实显示 1999-01-01） |
| 本批不开放工具调用（设计如此） | **已完成** | I1（界面 0 入口、桥只暴露 `command`）；I2（5 个调用命令 × 2 形状 = 10 次全部 `MCP_TOOL_INVOCATION_NOT_ENABLED`，未登记命令 `MCP_COMMAND_NOT_ALLOWED`） |
| 边界自证 | **已完成** | J1a（DB 端点 100% `openarc-test-echo` / 127.0.0.1）；J1b（子进程 = Electron 运行时 + 仓库 fixture `--stdio`）；`boundary={thirdPartyServices:false,userDataSent:false,arbitraryLocalPrograms:false,pluginIsolationClaimed:false}` |
| 视觉 | **截图齐全，不宣布"视觉通过"** | `artifacts/d5-03/visual/` 17 张（浅 9 + 深 8）；实现只用既有组件与 token（61 条 `.mcp-*` 规则 0 条硬编码颜色、27 个既有 token）；未做色值 / 对比度量测 |
| 动效 | **通过（限定范围）** | K1 插入 160ms `mcp-row-in`（12 帧）；K2 删除 160ms `mcp-row-out`（行摘除 195ms）；K3 详情按 `connectionId` 重挂载（loading 态 <8ms 采样，只记录不判定）；K4 减少动态效果 `--dur-quick=0ms` / `animation:none`，删除 4ms；`artifacts/d5-03/motion/` 66 帧 |

## 2. 首轮 → 修复（三个真实产品缺陷，全部有根因与 file:line）

1. **D5-03-D2（最严重）：本地 stdio 生产路径永远握不上手** —— `utilityProcess.fork()` 句柄没有 stdin（Electron 44.3.0 实测 `stdinType=undefined` / `stdinHasWrite=false`），`MCP_UNREACHABLE detail=stdin-unavailable`；单测全过是因为 `tests/mcp-fixtures.mjs` 走 Node child（有 stdin）。根因位置 `electron/executor-launcher.cjs:114-131` + `electron/mcp-client.cjs:157-167`。**修**：新增 `createMcpStdioLauncher`（`electron/executor-launcher.cjs:226-251`），Electron main 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`，**测试与生产共用同一实现**；白名单 entry/args/env 未放宽、`ELECTRON_RUN_AS_NODE` 由 launcher 追加不可覆盖、**D4-04 执行器 launcher 未动**。新增单测 `tests/d5-03-mcp-stdio-launcher.test.mjs`（3 例）。
2. **D5-03-D1（高）：空态没有「新建连接」入口** —— `PageState` 的 `empty` 规范是 `action='none'`，传入的 `onAction` 被静默忽略（`src/mcp/McpCenter.tsx:962-970` + `src/design-system/page-states.tsx:46,82`），真空态建不出首条连接。**修**：空态自渲染 `data-mcp-action="create"`（`src/mcp/McpCenter.tsx:963-974` + `.mcp-empty` 样式），**PageState 共享语义未动**。
3. **D5-03-D3（中）：失败后不刷新列表与详情** —— `runAction` 失败分支直接 return（`src/mcp/McpCenter.tsx:435-455`），鉴权失败当下不出现重授权入口、协议不符显示旧投影。**修**：失败分支也 `loadList({silent:true})` + `loadDetail()`（`:445-452`）。
4. **观察件（非缺陷）**：治理侧 app 授权投影并入 `mcp.*`（`electron/governance-service.cjs:278-287`、`electron/authorization-service.cjs:1174`）—— 只开可见性与整条撤销，**写路径仍不支持部分动作的 mcp grant**（`notVerified:1` 的原因）。**【第二批已更新】** 写路径已支持部分动作的 mcp grant，`notVerified` 已清零（见第二批节）。

## 3. 门禁与回归（命令 / 退出码 / 计数 / 证据 / sha256）

- 命令：`OPENARC_TESTED_COMMIT=$(git rev-parse HEAD) node experiments/d5-03/mcp-center-e2e.mjs`（HEAD `d583154`，干净代码树复跑）；结果：**38 PASS / 0 FAIL / 38，exit 0**；`productDefects: []`；`notVerified: 1`（**【第二批已更新】重跑后为 0 条**）；Z1 = clean；控制台错误样本 `[]`、对话框样本 `[]`
- 证据：`artifacts/d5-03/mcp-center-e2e.json`（sha256 **`dca23cb7b78df4997852500cebcabc5e2ad4e013795259b23b692ee8fc7aca23**【第二批已更新：该 artifact 已被重跑覆盖，当前 sha256 = `d8f9a23781ff590aaa395b076defcb1f2cb141eef24618424ed102913b86a2e0`】**`**，本批 `shasum - a 256` 独立复核；`openarcCommit=d583154`、`gitDirtyLines=5` 全为本批文档）+ 日志 `artifacts/d5-03/mcp-center-e2e-rerun.log`（尾行 `结论：PASS — {"pass":38,"fail":0,"total":38,"notVerified":1}` + `E2E_EXIT=0`；旧 `mcp-center-e2e.log` 留作首轮 / 上一轮历史）；视觉 `artifacts/d5-03/visual/`（17 张）、动效 `artifacts/d5-03/motion/`（66 帧）；`artifacts/` 被 gitignore
- 检查项分组（38 条）：A 3（A × 2 + A0 错误码自检）；B 3（B1–B3）；C 3（C0 / C1 / C2）；D 2；E 2；F 3（F0 / F1 / F1a）；G 6（G1 / G2 / G3a / G3b / G4 / G5）；H 2；I 2；J 2（J1a / J1b）；K 4；L 5；Z1
- 关键实测值：协商 `protocolVersion=2025-06-18` / `serverName=openarc-test-echo` / `serverVersion=1.4.0` / `capabilities={tools:{listChanged:false},logging:{}}` / 工具 `echo_sum`+`describe_self` / `toolsHash=7db033b3636227f94fc2a51859637cbb7b93c7e865a0e12b79d86c9dda7721ce`；挂死服务超时 **8068ms**（干净树复跑实测，上限 15s，G5）；不可达 138ms（G2）；删除 174ms（E2）；`MCP_TIMEOUT` 期间界面显示「发现工具中」（6 帧采样）
- 单测回归（第十七批文档岗复跑核对）：`node --test tests/d5-03-mcp-*.test.mjs` = **34/34**（含新增 stdio launcher 3 例）；`tests/d5-03-mcp-*.test.mjs + tests/d5-02-canvas-*.test.mjs` = **74/74**；`tests/d4-04-*.test.mjs + tests/governance-*.test.mjs` = **52/52**（第十七批文档岗复跑核对；整套 d4-04 + governance 口径，0 失败）；`npm run build` = 本批记录 **exit 0**（文档岗未复跑，避免改写 artifact 的 `distFingerprint`）
- tracked 证据：`docs/D5-03-GATE-EVIDENCE.json`（38 条 checks 逐条脱敏复制 + counts / artifactPath / artifactSha256 / env / mcpSourceFingerprint / fixture / boundary / defectChain / regression / notVerified / scopeBoundaries）

## 4. 功能 / 视觉 / 动效 / 边界

- **功能 = 通过（限定范围）**：本地 stdio 与远程 http 都取得**真实协商值**（逐字等于 fixture 参照）；四个失败类（非白名单 key / 不可达 / 401 / 协议不符）都有稳定错误码 + 人话提示 + 有界时延；停用 / 删除真的收掉连接与子进程；权限整条撤销 → `MCP_UNAUTHORIZED` 且工具描述 0 暴露；**【第二批已更新】** 旧口径「重新登录恢复」在本批被修掉 —— 现在是**跨登录 / 跨重启都不复活、只有正式治理入口重授才恢复**（见第二批节 §1）。
- **视觉 = 截图齐全，不整体宣布"视觉通过"**：浅色 9 张 + 深色 8 张，覆盖两套主题下的空态 / 列表 / 详情 / 能力表 / 测试日志 / 远程详情 / 发现中 / 认证失败 / 无权；实现复用既有 `Button` / `TextField` / `Badge` / `PageState` / `Dialog`，`styles.css` 61 条 `.mcp-*` 规则 **0 条硬编码颜色**、27 个既有 token（中性灰、无新增彩色）；**未做逐像素 / 色值 / 对比度量测**，深色详情页无单独截图 → 如实登记。
- **动效 = 通过（限定范围）**：列表插入 / 删除 160ms（`mcp-row-in` / `mcp-row-out`）、详情按 `connectionId` 重挂载、发现中不造假进度、减少动态效果下 `--dur-quick=0ms` + `animation:none`（删除 4ms vs 常规 195ms）；**loading 态 <8ms 采样间隔，只记录不判定**。
- **边界 = 未越界**：只连自建 fixture（J1a 端点 100% 本地）、只跑白名单 entry 的受控子进程（J1b）、0 个工具调用入口且 10 次调用尝试全被显式拒绝（I1 / I2）、`boundary.pluginIsolationClaimed=false` —— **连接成功 ≠ 插件隔离通过**。

## 5. 缺口与判定

1. 本批**不开放工具调用**（设计如此）；2. **无 OAuth**（只有 NONE / BEARER）；3. 远程只做 streamable HTTP **单响应**（无 GET SSE 长连接 / 断线续传；服务端 → 客户端请求一律 `-32601`）；4. 工具目录上限 **200 个 / 10 页**，超出标记 `truncated`，完整 `inputSchema` 不入库；5. 本地白名单只有测试 fixture（真实 Adobe / PS 属 D5-04/05）；6. `ELECTRON_RUN_AS_NODE` 依赖 Electron fuse（当前无打包 / 关 fuse 配置，关掉则握手有界失败 fail closed）；7. **【第二批已更新：已闭合】** `notVerified` 现为 **0 条** —— `mcp.view`-only 主路径已由第二批 `mcp-policy-e2e` 验收（写路径已支持部分动作的 mcp grant）；8. **【第二批已修复】** 撤销已跨登录 / 跨重启保持（内置 baseline 只在首次使用时播种，`identity-bootstrap.cjs:131-139 → mcp-bootstrap.cjs:41-50` 的旧口径已改）；9. **插件隔离属 D5-08**，本批未验也不声称；10. 门禁脚本 J1b 的 check 标题保留修复前的括号（判定与 PASS 内容已是修复后正常路径）—— 只允许改文档，本轮不改脚本，登记为文档级缺口。

**判定：D5-03 第一批（连接管理与能力发现）= PASS（限定范围）；D5-03 整体 = PARTIAL。**（功能 = 通过；视觉 = 截图齐全 / 只用既有 token 与组件，未做色值与对比度量测，不宣布"视觉通过"；动效 = 通过，loading 态未判定；边界按 §4 自证。剩余 = OAuth、长连接流、真实第三方 / Adobe 服务（D5-04/05）、插件隔离（D5-08）、部分授权主路径与跨登录撤销缺口。）

**【第二批已更新】** 上面这一节的「部分授权主路径（`mcp.view`-only 写路径）」与「撤销跨登录」两项缺口已由第二批闭环；`notVerified` 从 1 条变为 0 条（第一批台架本批重跑 38/38）。第二批的完整口径见下一节。

---

# D5-03 第二批 · MCP 授权收口 · 2026-09-24（`360d94b`）

> **口径（用户明确定范围）**：本批**只做 MCP 授权收口**（撤权持久化 + 部分授权写路径 + 审计归属 + v20→v21 升级归属）；**不开放工具调用、不连真实第三方、不运行任意第三方程序、不发用户数据、不声称插件隔离通过**。
> **判定：D5-03 第二批（MCP 授权收口）= PASS（限定范围）；D5-03 整体 = PARTIAL**（剩余缺口逐条见 §5）。完整结果文档 `docs/D5-03-RESULT.md` 正文 §1–§13；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch2` 段；决策 `docs/decisions/D5-03B-app-policy-persistence.md`。
> **提交链**：`140182f`（D5-03 第一批文档定稿）→ `91bc436`（内置策略提供记录 v21 / 墓碑 / 唯一键含 org + MCP 部分授权写路径）→ **`360d94b`（本批最后一次提交 = 被测提交，2026-09-24 22:58；审计归属目标 App + 迁移按命名空间归属撤销证据 + 按新契约更新旧断言 + 本批两个脚本）**。未 push、未合并 main、未切分支；执行期间唯一未提交改动 = 第一批脚本的 notVerified 文案订正（重跑 artifact `gitDirtyLines=1` 即指它）。
> **【第三批已更新 · 2026-09-28】** 本节其余内容为第二批当时原文（不删改）；其中的根目录 artifact 路径 / sha256 / CDP 端口 / `145/145` 回归口径都只作历史，**当前有效证据以文末「D5-03 第三批」节与本轮 runId 目录为准**（每次运行独立 `artifacts/d5-03/runs/<runId>/`，根目录不再写入可变 JSON）。本节里“另一个并发 DSH 会话”的归因已就地订正（**【第三批订正】**）为**本任务自己并行跑的批次**（见文末第三批 §3）。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 第二批真机台架（`node experiments/d5-03/mcp-policy-e2e.mjs`） | **已完成** | **43 PASS / 0 FAIL / 43、exit 0**；内嵌 firstBatch **38/38**；artifact `artifacts/d5-03/mcp-policy-e2e.json`，sha256 **`d4af5e9cbf6e7b8b6b8643f67d3dd38d040ee35baabb937fbeb338141c71d831`**（本批 `shasum -a 256` 复核两次）。**注意**：该路径于 23:01:50 被另一个并发 DSH 会话重跑覆盖，当前磁盘 sha256 = `0c9ea8e5187f2cc08e3c823381fb67113aff941df7af90f6534b1e61a69119d6`（同为 43/43、firstBatch 38/38、同样 2 条 notVerified）；`notVerified` 2 条（§5）；8 个真实 Electron 实例。**【第三批订正：那次覆盖来自本任务自身并行的批次，不是外部 DSH 会话。】【第三批已更新：当前有效证据 = `artifacts/d5-03/runs/20260928T020348Z-fb87-mcp-policy-e2e/mcp-policy-e2e.json`，sha256 `df7891ef…`，43/43、exit 0、notVerified 仍 2 条】** |
| 第一批回归台架（本批重跑；notVerified 文案订正后） | **已完成** | **38 PASS / 0 FAIL / 38、exit 0**；`productDefects: []`；**`notVerified: []` = 0 条**；Z1 clean；artifact `artifacts/d5-03/mcp-center-e2e.json`，sha256 **`d8f9a23781ff590aaa395b076defcb1f2cb141eef24618424ed102913b86a2e0`**（`shasum - a 256` 复核）；日志 `artifacts/d5-03/mcp-center-e2e.run-batch3-rerun.log`。**【第三批已更新：当前有效证据 = `artifacts/d5-03/runs/20260928T020242Z-fd67-mcp-center-e2e/mcp-center-e2e.json`，sha256 `83d8e6ab…`，38/38、exit 0、notVerified 0】**（尾行 `结论：PASS — {"pass":38,"fail":0,"total":38,"notVerified":0}` + `EXIT=0`） |
| 目标一：撤权持久 | **已完成（真机）** | 撤权即时（第一批 H1 未改）；跨登录不复活（C1/C2 + 新 H2：重登录后 `MCP_UNAUTHORIZED`、库内 mcp 行 0、墓碑 `revoked_at` 非空）；跨重启（D1–D4）；只有正式治理入口重授才恢复（E1–E4；重授后再重启仍有效）；新组织首用仍有既定初始授权（F1/F2） |
| 目标二：MCP 部分授权（`mcp.view` only） | **已完成（真机）** | H1 正式入口把 grant 置为 `[mcp.view]`（覆盖同一行，库 1 行）；H2 `toolsHidden=true` / `tools=[]` / `hash=null`，但连接状态仍可见（READY）；H3 DOM + `mcp/get` + `mcp/testLog` 三面 0 命中（含 64 位 hex 与 `hash=`）；H4 `connect`/`test` → `MCP_UNAUTHORIZED`；H5 再授 `[mcp.view, mcp.use]` 立即可见；H6 再撤销 → 再授 view-only 又不外泄；跨命名空间 9/9 `INVALID_INPUT`；越权全部 `NOT_SUPER_ADMIN` |
| 审计归属（本批修复） | **已完成（真机）** | J2 撤销审计行 `app_id` 全部 = `mcp-center`（修复前 `resource-library`）；J1 `old_permissions`/`new_permissions` 如实；L1 用 `git archive 140182f` 的 v20 代码建库并真实撤销一次，历史行仍是旧口径（旧缺陷现场保留） |
| 升级路径 v20 → v21 | **已完成（真机）** | L2：v21 生效（`user_version=21` + `app_policy_provisions` + 唯一键含 `organization_id`）+ 既有授权行 **4→4 一条不丢**（`noRowLost=true`）+ 主进程无迁移错误；L3：迁移把旧撤销证据归到 `(organization_id,'mcp-center','mcp')` 的墓碑（`revoked_at` 非空、`provisioned_at` 空），登录不再复活 |
| 契约变更披露 | **已披露（逐条）** | 第一批 `H2` 改写（旧断言编码的正是本批要修的旧语义；新 H2 断言「不复活 + 库证据 + 正式重授恢复」，强度更高）；第一批 `L3` 只插驱动步骤（判定未动）；第一批 `R1` 标题文案（判定未动）；其余 37 + 43 条判定**零改动** |
| 边界 | **未越界** | K1：5 个工具调用入口 × 2 形状仍全部 `MCP_TOOL_INVOCATION_NOT_ENABLED`；K2：端点只指向自建 fixture；artifact `boundary.databaseWritesByProbe=false` / `writesOnlyByProduct=true`（**全程只读查库**）；`pluginIsolationClaimed=false` |

## 2. 证据订正（本批必做项）

* `experiments/d5-03/mcp-center-e2e.mjs` 里「『工具描述不暴露』的 mcp.use-only 主路径（toolsHidden=true、mcp.view 仍在）」这条 notVerified 已**移除**（只动这一条文案/列表项：`git diff` = 4 增 1 删，原位补注释注明该路径已由 `experiments/d5-03/mcp-policy-e2e.mjs` 覆盖，见其 artifact 的 view-only 组 H0–H6）；38 条判定的布尔表达式与其它字段**一字未动**。
* 订正后脚本 sha256 = `9055e62d014e57b99b4fe24d3f1ca79ddc0b12dfecfd210c5d7fe4e762009970`（订正前 `e1ce85c5497eebdf4583a924bc25bd2699cbd51b74571fcd7499ac5af28abb02`，即第二批 artifact 的 `relation.regression` 文本里记的值）。
* 重跑后 artifact：**38/38、exit 0、`notVerified: []`（0 条）**，sha256 见 §1；`openarcCommit=360d94b`、`gitDirtyLines=1`。

## 3. 回归

* `node --test tests/d5-03-mcp-*.test.mjs tests/authorization-*.test.mjs tests/governance-*.test.mjs tests/*-migration.test.mjs tests/identity-store.test.mjs` = **145 / 145 pass、exit 0**（本批复跑，日志 `artifacts/d5-03/regression-batch2.log`）；新增 `tests/d5-03-mcp-policy-persistence.test.mjs` **11/11**、`tests/authorization-app-grant-scope.test.mjs` **6/6**。
* `npm run build` = **exit 0**（`tsc --noEmit` + `vite build`；本批执行期间未复跑，避免改写第一批 artifact 的 `distFingerprint`）；`d583154` → `360d94b` 的 `src/` diff **为空**（第二批 R3）。
* **两条预存在失败继续单列、未改断言**：`tests/side-effect-c4-gates.test.mjs:474` / `:444`、`tests/d4-03-approval-push-isolation.test.mjs:94`（已在干净 HEAD 导出树复现）。

## 4. notVerified 与证据完整性缺口（如实登记）

* **整体 notVerified 未清零**：第一批台架 **0 条**；第二批台架 **2 条** —— ①「同一安装内的第二个组织（两组织共库）无法用产品入口构造」（真机「组织」= `teams` 行，只在 `identity/initialize` 建 root 团队、唯一部分索引只允许一行 `root=1`；命令白名单无创建组织入口；`governance/createUser` 把 `teamId` 钉死在 `gate.user.team_id`）；②「跨组织**行为级**互不覆盖」—— 真机只到 **schema 级**（G1）+ node 行为级（11/11、6/6），**真机跨组织 = 未验收**。
* **第一批 artifact 的指纹集不含本批改动的两个文件**：`mcp-center-e2e` 的 `mcpSourceFingerprint` 仍只 pin 8 个文件，不含 `electron/authorization-service.cjs` 与 `electron/identity-store.cjs`；按执行边界脚本指纹逻辑**一字未动**，缺口如实登记（不声称第一批指纹覆盖本批改动文件）。第二批 artifact 的 `fingerprints` 覆盖了这两个文件（7 条，与 HEAD 逐条相同），两个台架合起来才可复核本批受验源码。
* **同一 artifact 路径被重跑覆盖**：`artifacts/d5-03/mcp-center-e2e.json` 每次重跑改写，第一批当时 sha256（`dca23cb7…`）、第二轮（`80d3fc0c…`）只在文档留痕；`artifacts/` 被 gitignore。**当前有效值以 §1 的 `d8f9a237…` 为准。**
* **脚本内仍留第一批的过时文案（不在允许改动范围）**：`observations` 里的 `note("最小修法建议（未动手）…")`（写入路径本批已修，被 H1 的 `partialGrantAttempt={"ok":true,...}` 实测取代）、第一批 `J1b` 判定标题里修复前的括号。
* **`BASELINE_POLICY_PROVIDERS` 手工对齐**（迁移归属表与三处播种点），**无漂移守卫**；**`app_policy_provisions` 无清理策略**（量级很小）。
* **环境事件（一行，非产品结论）**：本轮期间**本任务自己并行跑的另一个 Electron 批次**在同一工作树并发跑同一脚本、抢 CDP 端口，导致一次运行 `Z0 FAIL(exit 2)`，其实例也被按前缀清理误伤（原文曾记为“另一个 DSH 会话”、“被误杀”，第三批已订正归因）；受影响日志保留在 `artifacts/d5-03/*.run-batch3.log` / `.run-final.log`，**最终 artifact 是在端口空出后重跑产生的**（重跑前后 `pgrep -fl "oa-d50"` 均为空；脚本只按自己的前缀 `oa-d503-` 清理，未杀别人的进程）。同一时段还有**第二次**并发：本批复核后（23:01:50）`artifacts/d5-03/mcp-policy-e2e.json` 被另一个会话重跑覆盖（判定一致，43/43；两个 sha256 均如实记录）。**【第三批订正：该次覆盖同样来自本任务自己并行跑的批次，不是外部会话；第三批起改为独立 `runId` 目录 + 只追加索引，不再出现同一路径被覆盖；历史 artifact 里的文字保留不改。】**

## 5. 缺口与判定

**判定：D5-03 第二批（MCP 授权收口）= PASS（限定范围）；D5-03 整体 = PARTIAL。**

剩余缺口逐条：① **OAuth**（只有 NONE / BEARER）；② 远程**长连接流**（GET SSE / 断线续传）【第三批已更新：**已闭环**，见文末第三批节】；③ **真实第三方服务**与 **Adobe / PS 等本地服务**（D5-04 / D5-05）；④ **插件隔离**（D5-08）—— 连接成功 ≠ 插件隔离通过；⑤ **第二组织真机入口 / 跨组织真机行为级**；⑥ **`BASELINE_POLICY_PROVIDERS` 手工对齐无漂移守卫**；⑦ **第一批 artifact 指纹集不含本批改动的两个文件**【第三批已更新：**已闭环** —— 指纹集扩为 14 条】；⑧ **`app_policy_provisions` 无清理策略**。【第四批已更新：⑥⑧ 已闭环 —— 防漂移守卫（行为级 15 对逐项相等 + 反向穷举表外 0 + 源码级 fail-closed + 负向自证 T5/T6）与保留规则 R1–R6（按总经理裁定**不实现删除**、守卫白名单为空）】

**D5-02 的「重命名依赖 Electron 不支持的 `prompt()`」继续单列**（见 D5-02 段 §7 关闭条件），**不并入本批**。

## 6. 下一步

* 本批不再有必须立刻修的产品缺陷（两个台架全绿、单测 145/145）；若要继续收口 D5-03，优先级建议：跨组织真机入口（产品需新增「新建组织」或多租户安装）→ 第一批 artifact 指纹集补 `authorization-service.cjs` / `identity-store.cjs`（下批允许改脚本时）→ OAuth / 长连接流。**【第三批已更新：以上两项建议均已落地 —— 指纹集已扩为 14 条；长连接流（GET SSE / 断线续传）已由第三批闭环。第三批的下一步见文末「D5-03 第三批」节。】**

---

# D5-03 第三批 · Streamable HTTP 流式收口 + 生命周期收尾 · 2026-09-28（`1b78953` / `0aa4027`）

> **口径（用户明确定范围）**：本批**只做 Streamable HTTP 流式收口**（POST / GET SSE、断线续传、重复事件去重、半包与超大事件、有界失败、会话失效不自动重连）**与生命周期收尾**（登出 / 锁屏 / 关应用 / 停用删除 / 撤权即时收流）；**不开放工具调用、不连真实第三方、不运行任意第三方程序、不发用户数据、不声称插件隔离通过**；**本批不新增「创建组织」产品入口**（用户明令）。
> **判定：D5-03 第三批（Streamable HTTP 流式收口）= PASS（限定范围）；D5-03 整体仍 = PARTIAL**（剩余缺口逐条见 §5）。完整结果文档 `docs/D5-03-RESULT.md` 正文 §1–§12；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch3` 段；本批决策 `docs/decisions/D5-03C-streamable-http.md`（第二批决策 `docs/decisions/D5-03B-app-policy-persistence.md` §7 为第三批更新）。
> **当前有效证据以本轮 runId 目录为准**（`artifacts/d5-03/runs/<runId>/`：`20260928T020242Z-fd67-mcp-center-e2e` / `20260928T020320Z-8b11-mcp-stream-e2e` / `20260928T020348Z-fb87-mcp-policy-e2e`）；历史轮次（第一批 `dca23cb7…`、第二批 `d4af5e9c…` / 并发覆盖 `0c9ea8e5…`、第三批首轮 `f32c1226…`）只作历史。
> **提交链**：`c2e96c1`（第二批文档与证据定稿，并为本批 R3 重基线起点）→ `3590f27`（流式收口 + 门禁运行证据隔离）→ **`1b78953`（生命周期收尾接线 = 被测提交）** → `0aa4027`（HEAD：流式真机验收脚本 29 项 + policy 门禁重基线）。未 push、未合并 main、未切分支。三个 artifact 都记 `testedCommit=1b78953`、`gitDirtyLines=2`（那 2 个未提交文件就是随后提交成 `0aa4027` 的两个验收脚本）；产品源码 12 条指纹全部 `ok` / `inTestedCommit=true` / `worktreeMatchesCommit=true`。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 三门禁同轮（center → stream → policy；policy 的 R 段读本轮 center） | **已完成** | center **38/38、exit 0**，runId `20260928T020242Z-fd67-mcp-center-e2e`，sha256 `83d8e6ab49edd63d9d88f64c799f1e8f1c1523e336f605ec782fba915bab66bf`，notVerified 0；stream **29/29、exit 0**，runId `20260928T020320Z-8b11-mcp-stream-e2e`，sha256 `09e6023f61550d72c36d9f39effde3955d84d964e77f2d1488cac25ccc99cb80`，notVerified 0；policy **43/43、exit 0**，runId `20260928T020348Z-fb87-mcp-policy-e2e`，sha256 `df7891ef72abcb02fe057654d1132633f64bbdfae9c83a7393bd342fb9dc2a5b`，notVerified 2（既有）。三次 cleanup 都是 `own-pid-tree-only` / `leftovers: []` / `pkillUsed: false` |
| 流式收口（真机） | **已完成** | 持续 POST SSE：`mcp/connect` **29ms** 完成（上界 8000ms），服务端 `streams=2 notifications=2 closedByClient=2 openStreams=0`；GET SSE `{supported:true,state:open,status:200}` 收通知后仍 READY；GET 405 `{supported:false,status:405}` 连接不判死、随后 `mcp/test` 仍成功；带 ID 续传 `lastEventIdSeen="3"/replayedFrom=3/replays=1`、客户端 `hasLastEventId=true duplicates=0`；无 ID `lastEventIdSeen=null/replays=0`（`opens=2` 证明重连过）；重复事件 `duplicatesSent=2 → duplicates=2/total=2`；半包 `splitWrites=134` 成功；超大 393216B → `MCP_STREAM_EVENT_TOO_LARGE`（11ms、不重发）；无响应 `MCP_TIMEOUT` **8007ms**（79 条通知）；会话失效 `MCP_SESSION_EXPIRED`（15ms）后 2.5s 服务端计数不变（不自动重连/重发） |
| 生命周期收尾（真机） | **已完成** | **登出** → 服务端 `openStreams 1→0`、DB `enabled=1/status=DISABLED/last_error_code=MCP_SESSION_ENDED`、日志 `SESSION_ENDED detail=logout`；重登后详情显示"会话已结束…"、再 connect READY（213ms）。**关应用** → 有活连接 + 在途流时退出，exit 0、80ms，stdout `{"ok":true,"closed":1,"aborted":1,"ended":1,"error":null,"failures":[]}`，两条服务端流归零、无残留。**停用/删除** → 流归零、`MCP_CONNECTION_DISABLED`、stdio 子进程全退、删除后 `MCP_CONNECTION_NOT_FOUND`。**撤权** → 不发任何命令流即被收掉（`openStreams 1→0`）、`list/get/connect/test` 全 `MCP_UNAUTHORIZED`、工具名/描述/参数/hash/DOM 工具表 0 投影；重授 view-only → `toolsHidden=true/tools=[]/hash=null`。单元级 `tests/d5-03-mcp-lifecycle.test.mjs` L1–L5（含锁屏） |
| 生命周期状态策略 | **已定并说明理由** | **不新增第六状态**（会强制 v22 重建表并使 8 个冻结断言失效）；登出/锁屏/关应用 → `DISABLED + MCP_SESSION_ENDED`（`enabled` 不改写、详情页人话 + 日志）；撤权 → `ERROR + MCP_UNAUTHORIZED`；在途握手被收尾中止不再伪装成超时/不可达。新错误码 `MCP_STREAM_INTERRUPTED` / `MCP_STREAM_EVENT_TOO_LARGE` / `MCP_SESSION_EXPIRED` / `MCP_SESSION_ENDED`；**协议版本仍 `2025-06-18`**（记录 / 客户端常量 / 域常量三处一致，未升级） |
| 新证据布局（本批门禁修复） | **已完成** | 每次运行独立 `artifacts/d5-03/runs/<runId>/`（artifact + 日志 + `.sha256` + 截图）；索引只追加 `runs/index.json` / `index.jsonl`；**根目录不再写可变 JSON**（旧 3 个根目录 JSON mtime 2026-09-24，只作历史）；CDP 端口改 `acquirePort` 递增**独占探测**（本批 center 9811 / stream 9841 / policy 9812–9819，均为运行期动态值）；源码指纹集扩为 **14 条**（center / policy；stream 15 条 = 多自己一条），产品源码 12 条全部 ok/true/true |
| 门禁重基线披露 | **已披露（逐条）** | **H2**：只补一次真实 `mcp/connect` 驱动（判定与 `expected` 一字未动；全文件 44 个 `record` 调用点 id 序列与 `c2e96c1` 一致）；**R3**：基线 `d583154`→`c2e96c1` 并改**白名单式**（仅允许 `src/mcp/McpCenter.tsx`、只增不删 numstat 8/0、补丁必须含 `MCP_SESSION_ENDED`、白名单外任何 `src/` 改动 FAIL、git 失败 fail-closed；K 段级联判据原样）；**其余 42 条判定逐字未动** |
| 边界 | **未越界** | 5 个调用入口 × 2 形状全 `MCP_TOOL_INVOCATION_NOT_ENABLED`、未知命令 `MCP_COMMAND_NOT_ALLOWED`；HTTP 下服务端→客户端请求实收 `{id:"srv-1",code:-32601}`；协议 `2025-06-18`；只连自建 fixture（127.0.0.1 动态端口 + stdio 白名单 key）；`boundary={thirdPartyServices:false,userDataSent:false,arbitraryLocalPrograms:false,pluginIsolationClaimed:false}` |
| 回归 | **已完成** | `node --test tests/d5-03-mcp-*.test.mjs tests/authorization-*.test.mjs tests/governance-*.test.mjs tests/identity-store.test.mjs` = **143 / 143、exit 0**（本交付执行岗复跑核对；含新增 lifecycle 5/5、stream 8/8、get-stream 7/7）；`npm run build` exit 0（本批执行期间记录，未在本交付复跑以免改写 `distFingerprint`）；两条**预存在失败**（`tests/side-effect-c4-gates.test.mjs`、`tests/d4-03-approval-push-isolation.test.mjs`）继续单列、未改断言 |

## 2. 三轴判定（分列）

* **功能 = 通过**：三门禁同轮 **38/38 + 29/29 + 43/43** 全绿、`exit 0`；真实 `electron .`、真实产品命令面、自建受控 fixture；边界四项自证。
* **视觉 = 部分通过 / 含未验收**：第三批新增**一行界面说明**（`src/mcp/McpCenter.tsx` 的"会话已结束（登出 / 锁屏 / 应用退出）…"，`data-mcp-note="session-ended"`），**复用既有 `mcp-muted` 次级文字与既有 neutral 状态徽标，无新 token / 组件 / 颜色 / 动效**（`1b78953` 的 `src/` diff = 8 增 0 删，只有该文件，`styles.css` 未动）；实机截图 `artifacts/d5-03/runs/20260928T020320Z-8b11-mcp-stream-e2e/visual/session-ended-note.png` 与 `…/unauthorized.png`。**未验收：浅 / 深主题对照与对比度量测**（原因：只新增一行文案、无颜色/token 变化；已有证据 = 上述截图 + center 本轮深色 L1–L5 仍 PASS）。第一 / 二批已验的其余界面沿用其结论。
* **动效 = 沿用既有通过结论、本批无新增动效需验**：流式 / 生命周期改动都是非视觉行为；既有"插入 / 删除 160ms、减少动态效果 0ms（删除 4ms）、详情重挂载、发现中不造假进度"结论不变（引用 `docs/D5-03-RESULT.md` 附二 §6 + center 台架本轮 K1–K4 实测）。

## 3. notVerified 与缺口（如实登记）

* **notVerified 未清零**：`mcp-policy-e2e` **2 条**（同一安装内第二个组织无产品入口 → 跨组织行为级只到 schema + node 级）；`mcp-center-e2e` 0 条；`mcp-stream-e2e` 0 条。**本批不新增"创建组织"产品入口**（用户明令），因此两位数仍无法在真机构造。【第四批已更新：仍为这 2 条（expiry 六场景与 center / stream 第四批本轮 0 条；第四批同样未新增该入口）】
* **第三批新登记的残留**：**会话空闲过期没有身份事件** —— 会话自然过期不触发 `identity/logged-out|locked`，活连接要等下一次收尾动作才被收掉；期间靠命令层实时判权拒绝。**"空闲过期即时收流"未验收**。【第四批已更新：**已闭环** —— 新事件 `identity/session-expired` → 既有 MCP dispose 真机验收（idle 25/25：偏差 0ms、收流 53ms、`detail=expired:idle`；absolute 5/5：`expired:absolute`；`enabled` 未改写）】
* **视觉两项未验收**（浅 / 深主题对照、对比度量测）。【第四批已更新：**已验收通过** —— 浅/深实机截图 1660×1140 与第一批基准逐像素同尺寸；对比度浅 4.94:1 / 深 6.30:1（12px 普通文本门槛 4.5:1）】
* **policy 脚本收尾留 2 个 `oa-d503b-*` 临时目录**（既有行为，脚本不在本批允许改动范围）。【第四批已更新：**已闭环** —— 归属标记 + 只按本次创建清单清理 + SIGINT/SIGTERM 兜底；历史残留 4 → 0；根因订正：不是「脚本没有清理」，真漏洞是 `launchApp` 自建目录不在清单 + 硬退出跳过收尾块】
* **归因订正（第三批）**：第二节（第二批）曾把一次 `Z0 FAIL(exit 2)` 与 CDP 端口冲突记成"另一个并发 DSH 会话"、"实例被按前缀误杀"；经复核那是**本任务自己并行跑的批次**。第三批的机制性修复 = 独立 runId 目录 + `acquirePort` 独占探测 + 只清理自己的 pid 树 + Electron 批次串行执行。历史 artifact 里当时的文字保留不改，文档结论已就地订正。
* 既有缺口继续单列：OAuth（只有 NONE / BEARER）、真实第三方与 Adobe / PS（D5-04 / D5-05）、插件隔离（D5-08，连接成功 ≠ 插件隔离通过）、`BASELINE_POLICY_PROVIDERS` 手工对齐无漂移守卫、`app_policy_provisions` 无清理策略、D5-02 的"重命名依赖 Electron 不支持的 `prompt()`"。【第四批已更新：`BASELINE_POLICY_PROVIDERS` 防漂移守卫与 `app_policy_provisions` 保留规则 R1–R6 已闭环；后者按总经理裁定**不实现删除**、守卫白名单保持为空】

## 4. 缺口与判定

**判定：D5-03 第三批（Streamable HTTP 流式收口 + 生命周期收尾）= PASS（限定范围）；D5-03 整体仍 = PARTIAL。**

剩余缺口逐条：① **第二个组织的真机入口 / 跨组织真机行为级**（notVerified 2 条）；② **会话空闲过期即时收流**（缺身份事件）；③ **OAuth**；④ **真实第三方服务与 Adobe / PS 等本地服务**（D5-04 / D5-05）；⑤ **插件隔离**（D5-08）；⑥ **`BASELINE_POLICY_PROVIDERS` 无漂移守卫**；⑦ **`app_policy_provisions` 无清理策略**；⑧ **D5-02 `prompt()` 遗留**；⑨ 视觉两项未验收（浅/深主题对照、对比度量测）。【第四批已更新：②⑥⑦⑨ 已由第四批处理（空闲过期即时收流 / 防漂移守卫 / 保留规则 R1–R6 / 视觉两项）；剩余 = ① 跨组织真机入口、③ OAuth、④ 真实第三方与 Adobe、⑤ 插件隔离、⑧ D5-02 `prompt()`、`errorText` 通用括注、`resetInstallation` 孤儿残留、SIGKILL 边界】

## 5. 下一步

* 本批不再有必须立刻修的产品缺陷（三门禁全绿、单测 143/143、build exit 0）；若要继续收口 D5-03，优先级建议：跨组织真机入口（产品需新增「新建组织」或多租户安装，本轮不做）→ 会话空闲过期的身份事件（让活连接在过期当下即被收掉）→ OAuth → 真实第三方 / Adobe（D5-04 / D5-05）。【第四批已更新：本轮建议的「会话空闲过期身份事件」与「策略收口」已落地；第四批的判定、残留与下一步见文末「D5-03 第四批」节】

---

# D5-03 第四批 · 会话自然到期收流 + 策略收口 · 2026-09-28（`7b75ea3`）【第五批已更新：本节为历史原文，结论一条未删；被本批改写的口径就地加【第五批已更新】/【第五批订正】；第五批节见文末】

> **口径（用户明确定范围）**：本批 = **会话自然到期 → MCP 收流**（第三批登记的残留）+ **策略收口**（`BASELINE_POLICY_PROVIDERS` 防漂移守卫 / `app_policy_provisions` 保留规则）+ **临时目录归属**；**不开放工具调用、不连真实第三方、不运行任意第三方程序、不发用户数据、不声称插件隔离通过**；**不新增「创建组织」产品入口**（用户明令）；**不实现任何组织数据删除**（总经理裁定）。
> **判定：D5-03 第四批（会话自然到期收流 + 策略收口）= PASS（限定范围）；D5-03 整体仍 = PARTIAL**（剩余缺口逐条见 §3 / §4）。
> **当前有效证据 = 本轮统一重跑的 9 个 runId**：expiry `20260928T043453Z-140a` / `20260928T043517Z-7ab7` / `20260928T043538Z-4e4c` / `20260928T043554Z-e52c` / `20260928T043611Z-561b` / `20260928T043615Z-3f55`（各后缀 `-mcp-expiry-e2e`）+ 门禁 `20260928T043622Z-b4df-mcp-center-e2e` / `20260928T043657Z-8d65-mcp-stream-e2e` / `20260928T043724Z-25c6-mcp-policy-e2e`；首轮（EXP-01 修复前 6 个）与 1R 单场景复测（1 个）只作历史对照，不作为当前证据。
> 完整结果 `docs/D5-03-RESULT.md` 第四批正文；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch4` 段；决策 `docs/decisions/D5-03D-session-expiry-and-policy-retention.md`；真机报告 `experiments/d5-03/D5-03-BATCH4-EXPIRY-REPORT.md`、机器可读汇总 `experiments/d5-03/d5-03-batch4-expiry-summary.json`。
> **证据口径披露（必读）**：9 次 artifact 记 `testedCommit=8cbf8df2`（它们是提交前在工作树上跑的）；工作树 24 个改动文件的逐文件 sha256 冻结在汇总 JSON 的 `freezeSnapshot`；跑完复核 **22/24 一字未改**（只有两个报告文件因本轮更新而改写）；提交 `7b75ea3` 的文件清单与冻结清单 24/24 相同、其中 22/24 的 blob sha256 与冻结值逐字节相同 —— **被测内容 = `7b75ea3` 的内容**（冻结的 24 文件工作树状态 + 报告/汇总最终文本），不写成「测试提交=7b75ea3」。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 会话自然到期收流（真机） | **已完成** | idle **25/25**（dueAt→revoked 偏差 **0ms**、事件送达 3ms、收流 **53ms**、`detail=expired:idle`、`enabled` 未改写、之后 4.2s 计数零变化）；extend **7/7**（越过原到期点 **3004ms** 仍 READY、旧安排不误关）；absolute **5/5**（`reason=absolute`、收流 48ms）；relogin **7/7**（旧会话到期不关新会话、偏差 71ms）；regress **7/7**（`logout` / `user` / `app-grant-revoked` 三条 detail 一字未改）；override-deny **5/5**（权威行仍 43200000ms / 7200032ms，`DENY OVERRIDE_NOT_ACKNOWLEDGED`） |
| 到期机制 | **已完成** | `identity-domain.sessionExpiry()` 共用判据（dueAt=min(expires_at, idle_expires_at)、reason=idle|absolute）；`identity-service` **单一定时器**（unref、2^31−1 分块、全链路无 `setInterval`、每条命令后按持久层权威行重排、触发时重读行过**四道门**）；`identity-store.expireSession()` 幂等；对外仍 `SESSION_EXPIRED`；**SCHEMA_VERSION 仍 21、仍 5 种连接状态（未新增第六态）** |
| 策略防漂移守卫 | **已完成** | `tests/policy-provider-drift.test.mjs` T1–T6 **6/6**：行为级实测 **15 对 = resource 10 + model 4 + mcp 1** 与表逐项相等、反向穷举表外 **0**；源码级 fail-closed（3 个播种点登记 + 「凡引用 `policyProvisionByKey` 的文件必须登记」锚点）；负向自证 T5/T6（注入漂移后确实 FAIL）。**表没有漂移、未改表** |
| `app_policy_provisions` 保留规则 | **已完成 + 总经理裁定** | `tests/app-policy-provisions-retention.test.mjs` R1–R6 **6/6**（重播种 / 其它组织操作 / 关库重开重放迁移 / 正式重授后逐字段不变、撤权不复活；源码级禁止任何 cleanup 式行删除，白名单为空）。裁定：产品无「组织正式删除」入口 → **本批不实现删除**；`resetInstallation` 孤儿残留（provisions 15 行 + grants 15 行指向已删组织）判定**不可达、不致权限复活**，如实记为**数据残留 / 不变量缺口**，唯一真实风险 = 将来组织 id 复用（恢复备份/导入/人为指定）会**静默抑制新组织首次播种**【**第五批订正**：该「不可达、不致权限复活」判定**仅对 user 侧取数成立**（判定按 `organization_id = user.team_id`，`authorization-domain.cjs:490`）；**对 App 侧不成立** —— `authorization-store.cjs:80` 的 `appGrantsForApp` 只按 `app_id` 过滤、完全不看 `organization_id`，`authorization-domain.cjs:547 evaluateAppAuthorization` 无组织判断；T5/T5b 实测孤儿 grant 仍 **ALLOW（撤销失效）**。**这正是本批把授权表纳入重置同事务清理的原因**；孤儿行已清零、守卫白名单从空数组改为**恰好一条**（安装重置）】【第五批已更新：R5 期望值随修复改为 **0 / 0 / null**】 【**第六批已更新**：取数已改为按 `(app_id, organization_id)`（`authorization-store.cjs:80`）且**组织为空/缺失 fail-closed 返回空集**；判权层 `evaluateAppAuthorization` 逐条跳过异组织 grant（`authorization-domain.cjs:568`）。第五批「只按 `app_id` 过滤、完全不看 `organization_id`」是**第五批当时的事实**，其取证价值不变（本批即据此修复），**不再是当前口径**。见文末第六批节。】 |
| 临时目录归属 | **已完成** | `experiments/d5-03/userdata-ownership.cjs`（`owner.json` + 只按本次创建清单删 + SIGINT/SIGTERM 兜底 + 三条件 orphan 清理、默认 dry-run）；单测 O1–O5 **5/5**；**残留 4 → 0**；索引 30 条逐条重算 **0 处不一致**、每次运行 Z1 `changedExisting=[]`/`removed=[]` |
| 三门禁同轮重跑 | **已完成** | center **38/38**、stream **29/29**、policy **43/43（notVerified 仍 2）**，全部 exit 0、计数不低于首轮；runId / sha256 见结果文档第四批 §2 |
| 缺陷 EXP-01 | **已修 + 统一重跑全量复验** | 登录页旧文案 `登录状态已过期，请重新登录。（idle）` → 新文案 `登录状态已过期，请重新登录。`；只改「事件 reason 被当 detail 传」1 行调用 + 2 行说明注释；`tests/identity-session-expired-ui.test.mjs` 只新增 U5/U6（先红后绿，27/27）；`productDefectsFixed:1 / productDefectsOpen:0` |
| 视觉 | **通过** | 浅/深/减少动态效果三张实机截图 **1660×1140** 与第一批基准**逐像素同尺寸**（DPR 2、窗口 1440×940、默认背景/透明度、真实设置面板切主题）；说明行 12px/400 属**普通文本**（门槛 4.5:1），实测**浅 4.94:1 / 深 6.30:1**；`--muted` #6e6e73 / #98989d、合成背景、实机像素**三方一致**；规范 `DESIGN_SYSTEM.md` :3 / :64 / :154/:164 / :248 |
| 动效 | **通过（本批未新增动效）** | 说明行常规与减少动态效果下 `transitionDuration=0s` / `animationName=none`；减少动态效果下**元素作用域** `--dur-quick=0ms`（`:root` 仍 0.16s）；既有列表入场 `mcp-row-in / 0.16s` 抽样正常 |
| 回归 | **已完成** | node 目标集 **193/193、exit 0**（总经理独立复跑；执行岗同口径复跑一致）；全量 `npm test` 本批记录 **1332/1334**，执行岗定稿复跑 **1334 pass / 2 fail / 1336 total**（两条既有失败与本批无关：`tests/side-effect-c4-gates.test.mjs`、`tests/d4-03-approval-push-isolation.test.mjs`；两个数字并列，差值 2 与 EXP-01 新增 U5/U6 数量一致）；`npm run build` 记录 **exit 0**（本交付未复跑，避免改写 `distFingerprint`） |

## 2. 三轴判定（分列）

* **功能 = 通过**：expiry 六场景 **25/25 + 7/7 + 5/5 + 7/7 + 7/7 + 5/5**、exit 0、defects 0；三门禁 **38/38 + 29/29 + 43/43**、exit 0；真实 `electron .` / 真实产品入口 / 自建受控 fixture；边界四项自证（5 个工具调用入口仍全拒、协议仍 `2025-06-18`、只连 127.0.0.1 fixture、不声称插件隔离）。
* **视觉 = 通过**：见上表（1660×1140 逐像素同尺寸、对比度浅 4.94:1 / 深 6.30:1、门槛归属按普通文本 4.5:1）。
* **动效 = 通过**：本批未新增动效；既有动效结论不变。

## 3. notVerified 与缺口（如实登记）

* **notVerified 仍 2 条**（`mcp-policy-e2e`）：同一安装内第二个组织无产品入口 → 跨组织行为级只到 schema + node 级；**本批不新增「创建组织」入口**（用户明令）。expiry 六场景与 center / stream 本轮 **0 条**。
* **本批新登记的残留**：① `errorText` 仍是通用括注实现 —— 命令失败路径的 detail（如 `idle-expiry`）照旧显示，本批只修「事件 reason 被当 detail 传」这一条根因；② `resetInstallation` 孤儿残留（provisions 15 行 + grants 15 行指向已删组织；数据残留 / 不变量缺口，按裁定不修；风险 = 组织 id 复用时静默抑制新组织首次播种）；③ **SIGKILL 拦不住**（归属清理靠 SIGINT/SIGTERM + 收尾块，`kill -9` 靠 `cleanOrphans` 事后按三条件清理、默认 dry-run）。【第五批已更新：① **`errorText` 已收口** —— 改为「code 那一句 + `SHOWABLE_ERROR_DETAIL` 白名单（4 条全挂 `INVALID_INPUT`、每条带 `why`）」，表外 detail 一律过滤（含 `idle-expiry` / `session-missing` / `not-locked` 等 253 个内部标记），内部诊断（日志 / 审计 / 连接 `detail=expired:idle`）原样保留；② **`resetInstallation` 孤儿残留已闭环** —— 四张授权事实表在**既有的那个 `transactSync`** 内先清、再删身份五表（真机 15/14/1/0 → **0/0/0/0**，审计三表一行不删）；且「不可达」判定按上面**【第五批订正】**只对 user 侧成立；③ SIGKILL 边界仍单列不变】【第五批已更新：新增残留 5 条（`device_pairing_credentials` 未清 / `app_principals.status` 不受重置影响 / `RATE_LIMITED` 对象 detail 未映射人话 / `invariants()` 未加孤儿行检查 / 浅色 `.auth-error` 2.62:1 未闭合），见文末第五批节 §3】
* **本批闭环的旧缺口**：会话空闲过期无即时收流（第三批登记）、`BASELINE_POLICY_PROVIDERS` 无漂移守卫（第二批登记）、`app_policy_provisions` 无保留规则（第二批登记）、policy 门禁临时目录残留（第三批登记）。
* 既有缺口继续单列：OAuth（仅 NONE / BEARER）、真实第三方与 Adobe / PS（D5-04 / D5-05）、插件隔离（D5-08，连接成功 ≠ 插件隔离通过）、D5-02 的「重命名依赖 Electron 不支持的 `prompt()`」。

## 4. 判定与下一步

**判定：D5-03 第四批（会话自然到期收流 + 策略收口）= PASS（限定范围）；D5-03 整体仍 = PARTIAL。**

剩余缺口逐条：① 第二个组织的真机入口 / 跨组织真机行为级（notVerified 2 条）；② OAuth；③ 真实第三方服务与 Adobe / PS（D5-04 / D5-05）；④ 插件隔离（D5-08）；⑤ D5-02 `prompt()` 遗留；⑥ `errorText` 通用括注；⑦ `resetInstallation` 孤儿残留（数据残留 / 不变量缺口）；⑧ SIGKILL 边界。

下一步建议：跨组织真机入口（产品需新增「新建组织」或多租户安装，本批不做）→ OAuth → 真实第三方 / Adobe（D5-04 / D5-05）；`resetInstallation` 孤儿是否清理属产品决定（当前按总经理裁定不修）。【第五批已更新：**孤儿授权行已清**（总经理裁定 ①：守卫只放行安装重置这一条路径、不开放通用清理）；R3 已改**登记表式**基线、跨批不复位（裁定 ②：第六批动到这 4 个文件就会 FAIL，属 fail-closed 设计）；浅色 `.auth-error` 2.62:1 **本批不改**（裁定 ③：涉及设计值 / 视觉，留给产品决策，登记为未闭合缺陷）；第五批下一步与判定见文末第五批节 §4】

---

# D5-03 第五批 · 安装重置同事务清授权 + 登录失败文案收口 · 2026-09-28（`09dccf9` + `7ad424c`）# D5-03 第五批 · 安装重置同事务清授权 + 登录失败文案收口 · 2026-09-28（`09dccf9` + `7ad424c`）【**第六批已更新**：本节为历史原文，结论一条未删；被本批改写的口径就地加【第六批已更新】；第六批节见文末】

> **口径（用户明确定范围）**：本批 = **安装重置的授权数据一致性**（重置同事务清四张授权事实表 + 27 张 `organization_id` 表逐表判据 + 防删除守卫收紧）+ **登录失败文案收口**（`errorText` 只显示 code 那一句 + `SHOWABLE_ERROR_DETAIL` 白名单）+ **R3 门禁重基线**（登记表式）；**不开放工具调用、不连真实第三方、不运行任意第三方程序、不发用户数据、不声称插件隔离通过**；**不新增「创建组织」产品入口**（用户明令）；**不做整库扫删**（用户明令）。
> **判定：D5-03 第五批（安装重置同事务清授权 + 登录失败文案收口）= PASS（限定范围：功能通过、视觉部分通过）；D5-03 整体仍 = PARTIAL**（剩余缺口逐条见 §3 / §4）。
> **当前有效证据 = 第五批 7 个 runId**：重置 `20260928T070842Z-9cd0-mcp-reset-e2e`、policy `20260928T071705Z-db3d-mcp-policy-e2e`、center `20260928T065801Z-c7ba`、stream `20260928T065841Z-cce3`、expiry-idle `20260928T070551Z-f078`、视觉 `20260928T070627Z-27eb-auth-error-visual`、受影响性 `20260928T070745Z-e3b6-batch5-affectedness`（各后缀见完整结果文档第五批 §2.1）；历史对照 3 个（`…d18e` 首轮探针参数缺陷 / `…b56c` R3 未重基线 42/43 / `…5288` M1 修前 24/25）。**仍然有效的第四批证据**（复用理由见完整结果文档第五批 §2.2）：expiry 其余五个场景（extend / absolute / relogin / regress / override-deny）+ 临时目录归属机制 + `policy-provider-drift` 6/6。 【**第六批已更新**：当前有效证据 = 第六批 runId 清单（见文末第六批节）；第五批的 reset / center / stream / policy / 视觉五项已由第六批**同提交新鲜重跑**取代，`27eb` 16/17 保留为修复前失败历史；expiry-idle `f078` 本批未重跑，按结构判断沿用（复用理由见完整结果文档第六批 §2.2）。】
> **证据口径披露（必读）**：产品修复 = 提交 `09dccf9`；门禁脚本/报告 = HEAD `7ad424c`（**只改 `experiments/` 7 个文件，产品代码零改动**）。**10 个 batch5 artifact 全部记 `testedCommit=09dccf9`** —— 重置门禁与视觉门禁是新增未跟踪脚本、**就是在 `09dccf9` 上跑的**；R3 重基线那次 policy 重跑运行时脚本改动尚未提交（该 artifact `gitDirtyLines=7`）。汇总 JSON 冻结于 07:09:52Z、**早于 07:17 的 R3 重跑**，故它记 42/43 且不含 `db3d` —— **当前有效 policy 证据 = `db3d` 43/43**，两个数字并列、不互相顶替。
> 完整结果 `docs/D5-03-RESULT.md` 第五批正文；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch5` 段；本批决策 `docs/decisions/D5-03E-install-reset-authorization-consistency.md`；真机报告 `experiments/d5-03/D5-03-BATCH5-RESET-REPORT.md`（§9 = R3 重基线）、汇总 `experiments/d5-03/d5-03-batch5-summary.json`。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 安装重置同事务清授权状态 | **已完成** | `electron/identity-store.cjs:1574` 的 `RESET_AUTHORIZATION_DELETE_SQL`（四条整表删除的字面量数组）在 `resetInstallation`（:2767）**既有的那个 `transactSync`** 内先执行、再删身份五表；真机四张授权事实表 15 / 14 / 1 / 0 → **0 / 0 / 0 / 0**、身份五表 0/0/0/0；node **T1a / T1b 两个注入点**分别验证整体回滚（排除「两个独立事务」） |
| 审计保留（逐字口径） | **已完成** | `audit_log` **既有行一行不删**（前缀逐行相等）+ 重置自身**恰好新增两条**（`OK_REQUESTED` + `OK`）；两次错误 confirm 各留一条 `DENY`（`INVALID_INPUT`）→ 真机 **2 → 2 → 4 → 6 → 8**；`authorization_audit` / `device_audit` 逐行相等。**不是「行数不变」** |
| 不做整库扫删 | **已完成** | 27 张带 `organization_id` 的表逐表判据（4 清 + 23 不清，每条带可复核取数路径）；机器核对 `ORG_SCOPED_TABLE_COUNT = 27` + `orphanInventory()`（T2 断言表集合变化即 FAIL） |
| 防删除守卫（收紧） | **已完成** | `ALLOWED_ORG_DELETION_PATHS` 空数组 → **恰好一条**（安装重置）：文件 + 命中形态 + 去空白逐字相等的完整语句三者同时成立、取消 `includes` 模糊匹配；fail-closed 四条（源码字面量 / 位于 `RESET_AUTHORIZATION_DELETE_SQL` 内 / `resetInstallation` 真的迭代它 / 在 `transactSync` 里）；新增永久负向自证 **R6b**；外跑留证：`OA_RETENTION_ELECTRON_DIR` 未注入副本 7/7 → 注入白名单外删除后 **exit 1 / 6/7 / R6 FAIL** |
| R5 期望值更新 | **已完成（本批唯一允许改期望值处）** | 旧期望 = 缺陷现状（重置后 `provisions=15` / `grants=15` / 墓碑保留）→ 改为 **`0` / `0` / `null`**；已逐字披露，守卫没有被放宽 |
| 组织 ID 复用闭合 | **已完成（node 受控 T3）** | 真机无「用指定 id 创建组织」入口（本批未新增）→ node 现场重跑 **9/9**：重置前同 id 播种被旧墓碑压制（`seeded:false`）→ 重置清除 → 重初始化后同 id `seeded:true`、授权形状与全新安装逐行同形 |
| 登录失败文案收口 | **已完成** | `src/identity/types.ts:95` `SHOWABLE_ERROR_DETAIL`（4 条全挂 `INVALID_INPUT`、每条带 `why`）+ code 那一句；表外 detail 一律过滤（模板串 / `String(detail)` / 括号括注都不允许）；`AuthScreens.tsx` 只发 `password-mismatch` 标记；内部诊断（日志 / 审计 / 连接 `detail=expired:idle`）原样保留；真机五界面 11 个内部标记 0 命中 + node 对 253 个内部标记全量断言 |
| R3 门禁重基线 | **已完成** | 旧「固定 rev + 单文件白名单」→ **登记表式**（4 条，每条带批次 / 理由 / 必含标记 / 禁含形态；词边界匹配 + 标记必须在 HEAD 存在）；表外 src 改动仍 FAIL、git 取不到 fail-closed；k 段级联判据逐字符未动；**6 例负向自证全过**（还抓出实现自身两个漏洞，如实记录）；policy **42/43 → 43/43** |
| M1 假阳性修正 | **已完成（如实披露）** | 旧 M1 把「工作树 diff 为空」判成 FAIL（本批没改 `McpCenter.tsx`）→ 按等价语义修正（空 diff = 不存在非文案改动行）+ 新增 M1b 负向自证；**9 个实质动效断言 token 在补丁里 0 处被改**；修后 `f078` **26/26**（修前 `5288` 24/25 并列记录） |
| 三轴判定 | **功能 = 通过；视觉 = 部分通过；动效 = 通过** | 见 §2 |
| 回归 | **已完成** | 相关五文件 **55/55、exit 0**（reset 9 + retention 7 + session-expired-ui 11 + session-expiry 12 + identity-store 16，本岗独立复跑）；全量 `npm test` **1347/1349**（交付口径；两条既有失败与本批无关）；`npm run build` exit 0；`SCHEMA_VERSION` **仍 21** |

## 2. 三轴判定（分列）

* **功能 = 通过**：重置门禁 **26/26**、policy **43/43**（notVerified 2）、center **38/38**、stream **29/29**、expiry-idle **26/26**、受影响性分析 **10/10**，**全部 exit 0**；真实 `electron .` / 真实产品命令面 / 自建受控 fixture；探针只读 DB、所有状态由产品命令路径产生。
* **视觉 = 部分通过**：文案逐字正确、五个界面 DOM 对 **11 个内部标记 0 命中**、动效无新增；对比度**首次实机量测** `.auth-error` —— **浅色向导卡 2.62:1 不达 4.5:1（既有缺口，本批未改样式，登记为未闭合缺陷）**，浅色窗口面 5.19、深色向导卡 5.31、深色 + 减少动态效果 5.16 通过（runId `27eb`，16/17，唯一 FAIL 即该对比度）。 【**第六批已更新**：**已修复** —— `.auth-error` 加不透明内容底 `rgb(var(--content-rgb) / 1)`；真机矩阵 **10 格 × 2 面全部 ≥4.5:1**（浅 5.372 / 深 5.261 / 深实色 5.665），runId `20260928T094556Z-c729`（43/43、exit 0）；`27eb` 16/17 与 2.62:1 是**修复前**历史证据，保留不改。】
* **动效 = 通过**：错误行常规 / 减少动态效果下 `animationName:none`、`transitionDuration:0s`，元素作用域 `--dur-quick:0ms`；**本批改动文件不含任何 `.css`**。

## 3. notVerified 与缺口（如实登记）

* **`notVerified`：跨组织真机 2 条继续保留**（policy）；本批新增并逐条列出（完整结果文档第五批 §4）：① 组织 ID 复用真机不可构造 → node T3；② `device_access` 真机 0 → 0 **不构成清理证据**；③ 产品侧 `invariants()` 原生入口缺失 → 等价只读复算；④ `session-missing` / `not-locked` 真机不可达；⑤ 浅色对比度不达标（**判定不通过**）；⑥ 整窗截图与第四批窗口裁剪非逐像素同尺寸。**本批未新增「创建组织」入口**。
* **本批新登记的残留**：① `device_pairing_credentials` **未清**（重置前签发的配对凭据仍可再登记设备；T7 证明不产生授权结论，建议下批或产品裁定）；【**第七批已更新**：**已闭环** —— 这三张设备身份表已随重置同事务清空（真机 `devices` / `device_credentials` / `device_pairing_credentials` **1 / 1 / 2 → 0**）；旧未使用密钥再消费 `PAIRING_TOKEN_UNKNOWN` 且 **0 新设备 / 0 新凭据**；旧指纹 `DEVICE_CREDENTIAL_UNKNOWN`、旧长连接心跳 `DEVICE_CREDENTIAL_MISMATCH`（runId `20260929T023418Z-448b-mcp-device-reset-e2e`，44/44 exit 0）。详见文末「D5-03 第七批」节与 `docs/decisions/D5-03G-install-reset-device-identity.md`。】② `app_principals.status` **不受重置影响**（安装级配置）；③ `RATE_LIMITED` 的 `{retryAfterMs}` 对象 detail **现被过滤但未映射成人话**；④ `invariants()` **未加「孤儿授权行」检查**（理由与代价已登记）；⑤ **浅色 `.auth-error` 2.62:1 未闭合**。【**第六批已更新**：⑤ **已闭环**（不透明内容底，真机 5.372:1）；①–④ 继续有效。】
* **本批闭环的旧缺口**：`resetInstallation` 孤儿授权残留（第四批登记；其「不可达」判定被本批**【第五批订正】**：只对 user 侧成立，App 侧孤儿 grant 能直接复活权限 = 撤销失效路径）；`errorText` 通用括注泄漏内部 detail（第四批登记）；R3 陈旧 src 白名单（第五批过程中暴露并重基线）。
* 既有缺口继续单列（不并入本批）：OAuth（仅 NONE / BEARER）、真实第三方与 Adobe / PS（D5-04 / D5-05）、插件隔离（D5-08）、D5-02 的「重命名依赖 Electron 不支持的 `prompt()`」、SIGKILL 边界。

## 4. 判定与下一步

**判定：D5-03 第五批（安装重置同事务清授权 + 登录失败文案收口）= PASS（限定范围：功能通过、视觉部分通过）；D5-03 整体仍 = PARTIAL。**

剩余缺口逐条：① 跨组织真机入口 / 跨组织真机行为级（`notVerified` 2 条）；② OAuth；③ 真实第三方服务与 Adobe / PS（D5-04 / D5-05）；④ 插件隔离（D5-08）；⑤ D5-02 `prompt()` 遗留；⑥ SIGKILL 边界；⑦ 本批新登记 5 条残留（`device_pairing_credentials` 未清 / `app_principals.status` / `RATE_LIMITED` 对象 detail / `invariants()` 孤儿行检查 / 浅色 `.auth-error` 2.62:1）。 【**第六批已更新**：⑦ 中的「浅色 `.auth-error` 2.62:1」**已闭合**；第六批新登记的残留见文末第六批节 §3。】 【**第七批已更新**：⑦ 中的「`device_pairing_credentials` 未清」**已闭环**（已随重置同事务清空，真机 **1 / 1 / 2 → 0**，旧密钥 `PAIRING_TOKEN_UNKNOWN`、0 新设备 / 0 新凭据）；第七批的判定与残留见文末第七批节。】

**总经理裁定（本批，写进决策文档即生效）**：① 守卫**只放行安装重置这一条路径**、不开放通用清理；② R3 采用**登记表式**基线、**跨批不复位**（第六批若合法动到这 4 个文件就会 FAIL，属 fail-closed 设计，届时按同一形态新增登记项并重跑负向自证）；③ 浅色 `.auth-error` **2.62:1 本批不改**（涉及设计值 / 视觉，留给产品决策），**登记为未闭合缺陷**。 【**第六批已更新**：裁定 ③ 已由第六批执行 —— 修复方式 = **组件级不透明内容底**（不是改色、不是改 token），真机复测 5.372:1 ≥ 4.5:1；规范级解法（token 层材质档）仍未做，取舍已登记进 `docs/decisions/D5-03F-app-grant-org-isolation-and-auth-error-contrast.md`。】

下一步建议：浅色玻璃卡面红字对比度（产品 / 设计决策：提高卡面材质不透明度，或浅色下用更高对比红档，或把该行放到不透明表面上）→ `device_pairing_credentials` 是否随重置清理（产品裁定）【**第七批已更新**：已由第七批处理 —— **随重置同事务清空**，真机 **1 / 1 / 2 → 0**，旧密钥 `PAIRING_TOKEN_UNKNOWN`、0 新设备 / 0 新凭据】→ 跨组织真机入口（产品需新增「新建组织」或多租户安装，本批不做）→ OAuth → 真实第三方 / Adobe（D5-04 / D5-05）。

---

# D5-03 第六批 · App 授权组织隔离（含安全修复）+ 登录错误行不透明内容底 · 2026-09-28（`d1ba058` + `2944e45`）

> **口径（用户明确定范围）**：本批 = **App 授权组织隔离（含安全修复）**（取数按 `(app_id, organization_id)` + 空组织 fail-closed 空集 + 判权层纵深防御 + 三处漏掉的调用点补组织）+ **登录错误行不透明内容底**（`.auth-error` 合成背景与壁纸 / 玻璃档解耦）+ **门禁假阳性修正与 R3 登记表 4 → 5 项**（经总经理逐条授权）；**不开放工具调用、不连真实第三方、不运行任意第三方程序、不发用户数据、不声称插件隔离通过**；**不新增「创建组织」产品入口**（用户明令）；**不做整库扫删**（用户明令）。
> **判定：D5-03 第六批（App 授权组织隔离 + 登录错误行不透明内容底）= PASS（限定范围）；D5-03 整体仍 = PARTIAL**（剩余缺口逐条见 §3 / §4）。
> **当前有效证据 = 第六批 runId 清单**：reset `20260928T091457Z-f559` **26/26**、center `20260928T091508Z-967d` **38/38**、stream `20260928T091545Z-23e3` **29/29**、policy `20260928T095113Z-2780` **43/43**（R3 重基线后）、矩阵 `20260928T094556Z-c729` **43/43**；另 `20260928T084047Z-866c`（门禁假阳性反证 11/11）、`20260928T092753Z-e537`（R3 负向自证 4/4）、`20260928T091621Z-74ec`（重基线前 42/43，仅留档）。**仍然有效的早期证据**（复用理由见完整结果文档第六批 §2.2）：expiry-idle `20260928T070551Z-f078` **26/26**（本批未重跑，结构判断）+ 第四批 expiry 其余五场景（extend / absolute / relogin / regress / override-deny）+ 第五批 R3 前 4 项 / 文案收口 / 第四批临时目录归属。【**第七批已更新**：本行里第六批的 reset `f559`（26/26）与 policy `2780`（43/43）已由第七批**同提交新鲜重跑**取代（`91f9` **28/28**、`2442` **43/43**）；center `967d`（38/38）/ stream `23e3`（29/29）仍为**当前有效证据**（按机械受影响性分析复用）。本行其余内容保留为第六批当时的记录。】
> **证据口径披露（必读）**：产品修复 = 提交 `d1ba058`（**27 个文件**：7 个 `electron/*.cjs` + `src/styles.css` + 2 个 experiments 旧单参调用 + 17 个测试/夹具）；门禁脚本与报告 = HEAD `2944e45`（**只改 `experiments/d5-03/` 9 个文件**，`+1897 / −16`；父提交 = `d1ba058`，`git diff d1ba058 2944e45 --stat` 产品代码零改动）。**全部 artifact 记 `testedCommit=d1ba058`** —— 真机运行时门禁脚本改动**尚未提交**（policy 两次运行记 `gitDirtyLines=6 / 8`），随后才提交成 `2944e45`。**本批没有机器可读汇总 JSON**；索引复核 = `runs/index.json` **64 条** / `index.jsonl` **64 行**、64 个 artifact sha256 **64 一致 / 0 不一致 / 0 缺失**（报告 §8 记 61 条 / 60 行，差异如实登记，报告原文不改）。
> 完整结果 `docs/D5-03-RESULT.md` 第六批正文；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch6` 段；本批决策 `docs/decisions/D5-03F-app-grant-org-isolation-and-auth-error-contrast.md`（含规范例外集中登记）；真机报告 `experiments/d5-03/D5-03-BATCH6-MATRIX-REPORT.md`。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| App 授权取数层组织隔离（含安全修复） | **已完成** | SQL 按 `(app_id, organization_id)`（`authorization-store.cjs:80`）+ **空组织 fail-closed 返回空集**（`:478-481`）；三处漏掉的调用点补组织（通用判权主路径 `authorization-service.cjs:114` 用 `user.team_id`；模型域 `model-service.cjs:27`、MCP 域 `mcp-service.cjs:91` 用 `actor.organizationId`）；**删掉 `!g.organization_id` 这个把空组织当跨组织通配的分支**（全仓 `electron/` + `src/` 0 命中）；治理面既有显式组织过滤原样保留（`governance-service.cjs:294/:312/:337`，行为逐行不变）；`SCHEMA_VERSION` 仍 21 |
| 判权层纵深防御 | **已完成** | `evaluateAppAuthorization` 逐条只认 `organization_id` 等于当前组织的 grant（`authorization-domain.cjs:568`）、组织为空一行都不放行（`:566`）；`evaluatePolicy` 加 `organizationId`（`:586`）并把同一份组织透传给内部调用（`:606`）；两个 `evaluatePolicy` 直接调用点（`authorization-service.cjs:153` / `:998`）与另一个直接 `evaluateAppAuthorization` 调用点（`:336`）全补 |
| 新证据（双组织行为级） | **已完成** | `tests/d5-03-app-grant-org-isolation.test.mjs` **O1–O9，9/9**：同一库 A/B 两真实组织各按产品路径播满 **15 对**；同名 App 在 A 获权/撤权不改变 B；异组织同形行不能复活被撤销权限（资源 / 模型 / MCP 三域）；`organization_id=''` 不构成通配（三域 + 阳性对照）；纯函数全表喂入只认本组织；本组织播种/唯一键/撤权/正式重授不变；治理视图逐行不变。**先红后绿 2×2**：全还原 **7 fail**、只恢复判权层 **5 fail**（模型/MCP 两域不走判权层）、只恢复取数层 **1 fail**（只有「全表喂纯函数」需要判权层） |
| 期望值订正（仅 2 处） | **已完成（逐字披露）** | reset 测试 T5/T5b 旧期望 `ALLOW`（那正是第五批实测到的漏洞）→ 新期望 **DENY + `APP_ACTION_NOT_GRANTED` + `allowSources` 不含 `APP_GRANT`**，并各补**阳性对照**（同形授予落在本组织 → ALLOW；本组织撤销 → DENY）；其余 **16 个**测试/夹具文件只补组织 / 改用全表语义，**未放宽任何产品语义、无兼容后门** |
| 收尾 | **已完成** | `experiments` 两处旧单参调用修正（`d3-04d/02-picker.mjs:24` 取 fixture 组织；`d5-03/mcp-policy-legacy-v20-driver.cjs:31` 明确用全表语义并写明理由）；`electron/identity-store.cjs` 重置注释同步当前事实（**仅注释**，剥块注释后逐字节相同、12 增 7 删全为注释行） |
| `.auth-error` 不透明内容底 | **已完成** | `src/styles.css:2471` 新增 `background: rgb(var(--content-rgb) / 1)` + 既有 `--radius-md` / `--space-2` / `--space-3`；保留错误文字 / `role="alert"` / `--failed` / `:empty` 不渲染 / 12px/400；**未改任何全局状态色或 token**；静态契约 C1–C5 **5/5** |
| 门禁假阳性修正 | **已完成（逐字披露 + 先红后绿）** | CSS 规则体由**行号硬切**改为**按选择器**提取（旧切片在规则体移位后 6 条声明只看得到 1 条 → 恒真假绿）；V7b 的 `!cssChanged` 重基线为「本批新增 `transition`/`animation` 声明数 = 0 + 运行时 V7a 全绿」（旧口径在「本批修复就是改 CSS」下必 FAIL，属 fail-closed 设计问题，**不是产品缺陷**）；变异自证：追加 transition/animation → **旧口径 PASS（假绿）、新口径 FAIL（抓住）**（`866c` 11/11） |
| R3 登记表 4 → 5 项 | **已完成（总经理逐条授权）** | 新增 `src/styles.css`：必含不透明内容底、规则体 **0 条** `transition|animation`、深浅 `--failed-rgb` 原值必须在 `tokens.css` 原样、新增内容行必须全落在 `.auth-error` 规则体内、表外 src 改动仍 FAIL、git 取不到仍 fail-closed；负向自证 **4 副本全符合预期**（`e537` 4/4）；`2780` **43/43**（与 `74ec` 42/43 逐条比对，唯一差异 = R3 FAIL→PASS） |
| 三轴判定 | **功能 = 通过；视觉 = 通过；动效 = 通过（含 1 条口径不符的如实登记）** | 见 §2 |
| 回归 | **已完成** | `npm test` **1363/1365**（两条既有失败与本批无关：`tests/side-effect-c4-gates.test.mjs`、`tests/d4-03-approval-push-isolation.test.mjs`）；`node --test tests/d4-04-closure2-boot.test.mjs` **9/9、exit 0**；两条探针门禁（`governance-ui` 1/5、`model-keychain-restart` 3/15）为**既有失败**（A/B 实测 + 逐字节恢复），登记待单独排期；`npm run build` exit 0（产品提交自证） |

## 2. 三轴判定（分列）

* **功能 = 通过**：四段 MCP 门禁 **26/26 + 38/38 + 29/29 + 43/43**、`exit 0`；`node --test tests/d4-04-closure2-boot.test.mjs` **9/9**；`npm test` **1363/1365**；真实 `electron .` / 真实产品命令面 / 自建受控 fixture；App 授权组织隔离有双组织行为级证据（O1–O9）与先红后绿 2×2；探针只读 DB，授权状态由产品命令路径产生。
* **视觉 = 通过**：矩阵 **10 格 × 2 面全部 ≥4.5:1**，每格底 = **该行自身 token 底** —— 浅 `255,255,255` → **5.372**、深 `23,23,23` → **5.261**、深实色 `14,14,14` → **5.665**；四个基准点对照第五批 `27eb`：**2.620 → 5.372、5.192 → 5.372、5.310 → 5.261、5.159 → 5.261**；登录页两条错误行**首次**量到对比度（各 5.372）。布局 / 焦点 / 动效全绿（行高 36.40 ≥ line-height 20.40；无错误行时整段不在 DOM；出现后 actions 下移 48.4px = 行高 + margin；8 组缩放 × 长文案无溢出；焦点环 2px + offset 2px 与错误行不相交）。**第五批 16/17 与 2.62:1 的失败历史保留**（那是修复前证据）。
* **动效 = 通过（含 1 条口径不符的如实登记）**：两档帧序列 **0 中间帧**、末帧与首现帧矩形一致、`animationName=none` / `transitionDuration=0s`；`.reduced` 档元素作用域 `--dur-quick=0ms`。**如实登记一条口径不符**：任务书说「normal 与 reduced 都 0ms」，实现里 0ms 只在 `.reduced`（`tokens.css:358`），常规档 **160ms**（`:170`）；该行两档都无过渡 / 动画声明、帧序列已证两档都即时出现 —— **按实现记录，不写成通过**（总经理裁定 ③）。

## 3. notVerified 与缺口（如实登记）

* **notVerified 8 条**（以真机报告 §7 为准）：① `--dur-quick` 口径不符（按实现记录）；② 设置面错误行消失后释放量残余 **12.6px** 成因未查明（向导面 48.4 = 48.4 精确成立）；③ 产品 Zoom 无真实入口（CDP 模拟）；④ 缩放长文案是注入的压力测试；⑤ 动效证据是帧序列不是视频；⑥ 跨组织真机 2 条继续保留（policy）；⑦ 两条探针门禁本身不通过；⑧ `light × solid` 的 `--content-rgb` 与 `light × full` 同值、该格无区分度。
* **两步探针门禁既有失败（登记待单独排期）**：`governance-ui` **1/5**（失败点 `userByIdentifier` 返 null → `u2.id` 抛错，改动行之前）、`model-keychain-restart` **3/15**（失败点 `appById("settings")` 为 null → `PROXY_UNAUTHORIZED`，改动行上游）；**一次性授权 A/B 实测**：两个 fixture 临时回退到本批之前（`d4a3516`）→ 结果**完全相同**（同计数、同失败点），随后逐字节恢复（sha256 一致、`git status` 为空）⇒ **既有失败、与本批无关**。
* **本批新登记的残留**：① `experiments/d3-04d/02-picker.mjs:26` 的 `qApp.total===0` 断言本身不敏感（baseline 存在时该查询也是 0；**既有弱化，非本批引入**）；② `.auth-error` 是**组件级局部补**，规范级解法（token 层「浮在可变背景上的文本行」材质档）**未做**（取舍已登记进决策文档）；③ 第六批**未跑受影响性分析工具、也未重跑 expiry 六场景**（expiry 复用是结构判断）；④ 报告 §8 的索引数字（61 条 / 60 行）与复核值（64 / 64）不一致，未入索引的空目录 `cf4e` 与工装迭代轮 `fcfa` 报告未登记（本岗补登）。
* 既有缺口继续单列（不并入本批）：**OAuth**（仅 `NONE` / `BEARER`）、**设备配对凭据重置**（第五批登记残留）【**第七批已更新**：**已闭环** —— 已随重置同事务清空（真机 `devices` / `device_credentials` / `device_pairing_credentials` **1 / 1 / 2 → 0**，见文末第七批节）】、**插件隔离（D5-08）**、**D5-02 重命名受 Electron 不支持 `prompt()` 限制**、**SIGKILL 边界**、第五批登记其余残留（`app_principals.status` / `RATE_LIMITED` 对象 detail / `invariants()` 无孤儿行检查）。**本批未新增「创建组织」入口**。

## 4. 判定与下一步

**判定：D5-03 第六批（App 授权组织隔离 + 登录错误行不透明内容底）= PASS（限定范围）；D5-03 整体仍 = PARTIAL。**

剩余缺口逐条：① 跨组织真机入口 / 跨组织真机行为级（`notVerified` 2 条）；② 两条探针门禁既有失败（`governance-ui` / `model-keychain-restart`）待单独排期；③ OAuth；④ 设备配对凭据是否随重置清理【**第七批已更新**：**已处理** —— 随重置同事务清空，真机 **1 / 1 / 2 → 0**】；⑤ 插件隔离（D5-08）；⑥ D5-02 `prompt()` 遗留；⑦ SIGKILL 边界；⑧ 本批新登记残留（`.auth-error` 规范级解法 / expiry 未重跑 / 索引口径差异）。

**总经理裁定（本批，写进决策文档即生效）**：① **R3 登记表新增 `src/styles.css`（4 → 5 项）**，条件见决策文档 §7.3，含负向自证 4/4；② **`auth-error-visual` 的 V7b 口径重基线**（假阳性修正，**不是产品缺陷**：旧判据在本批「修复本身就是改 CSS」下必 FAIL）；③ **任务书 `--dur-quick` 口径与实现不符 → 按实现记录、不改成通过**。

下一步建议：两条探针门禁单独排期 → 跨组织真机入口（产品需新增「新建组织」或多租户安装，本批不做）→ 设备配对凭据是否随重置清理（产品裁定）→ `.auth-error` 的 token 级材质档（规范级解法）→ OAuth → 真实第三方 / Adobe（D5-04 / D5-05）。

---

# D5-03 第七批 · 安装重置后旧设备身份失效 + 配对组织归属以会话为准 · 2026-09-29（`ed4502d` + `cd06927`）

> **口径（用户明确定范围）**：本批 = **安装重置后旧设备身份失效**（重置删除集合 4 张 → 7 张：新增 `device_credentials` → `device_pairing_credentials` → `devices`，**子表先删**，仍在 `resetInstallation` **既有的那个 `transactSync`** 内；审计三表一行不删）+ **配对 / 设备读取的组织归属唯一来源 = 会话反查的 `users.team_id`**（`#sessionGate` 新增自报组织校验 `SESSION_ORGANIZATION_MISMATCH`）+ **守卫收紧**（白名单 1 → 恰好 4 条 + `WATCHED_TABLES` + 两条 fail-closed）；**不开放工具调用、不连真实第三方、不运行任意第三方程序、不发用户数据、不声称插件隔离通过**；**不新增「创建组织」产品入口**（用户明令）；**不做整库扫删**（用户明令）。
> **判定：D5-03 第七批（安装重置后旧设备身份失效 + 配对组织归属以会话为准）= PASS（限定范围：功能通过；视觉 / 动效本批无界面改动）；D5-03 整体仍 = PARTIAL**（剩余缺口逐条见 §3 / §4）。
> **当前有效证据 = 第七批 runId 清单**：新门禁 `mcp-device-reset-e2e` `20260929T023418Z-448b` **44/44 exit 0**、reset `20260929T023431Z-91f9` **28/28**、policy `20260929T023443Z-2442` **43/43**、`batch7-gates-rerun` `20260929T023535Z-73ed` **4/4**（内含 device-ui 32/32、identity-ui 26/26、相关 node 集合 183/183、`npm test` 1376/1370/6）、受影响性 `20260929T023327Z-2abd` **6/6**、索引完整性 `20260929T024221Z-fd34` **8/8**。**仍然有效的第六批证据**（复用理由见完整结果文档第七批 §2.2）：center `20260928T091508Z-967d` **38/38**（artifact sha256 `6726b742…`，复算未变）+ stream `20260928T091545Z-23e3` **29/29**（`8df59d52…`，复算未变）。
> **证据口径披露（必读）**：产品修复 = 提交 `ed4502d`（5 个文件 = 2 个产品文件 `electron/identity-store.cjs` / `electron/device-service.cjs` + 3 个测试文件，含新增 `tests/d5-03-reset-device-identity.test.mjs`；`+934 / −111`）；门禁脚本与报告 = HEAD `cd06927`（**只改 `experiments/d5-03/` 6 个文件**，`git diff ed4502d cd06927 --stat` 证明产品代码零改动）。**全部 batch7 artifact 记 `testedCommit=ed4502d`** —— 真机运行时新门禁脚本尚未提交（受影响性分析 A2 记工作树只有两个未跟踪脚本 `batch7-affectedness.mjs` / `mcp-device-reset-e2e.mjs`），随后才提交成 `cd06927`；本岗复核：`mcp-device-reset-e2e.mjs` 在 HEAD 的 sha256 `c7f809b6…` 与 `448b` artifact 的 `scriptSha256` 逐字相等。**本批没有机器可读汇总 JSON**；索引复核 = `runs/index.json` **75 条**（11 条 batch7 + 64 条历史），75 个 artifact 逐条复算 sha256 **75 一致 / 0 不一致 / 0 缺失**（本岗独立复算）。
> 完整结果 `docs/D5-03-RESULT.md` 第七批正文；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch7` 段（**纯插入**：旧段逐字节未改）；本批决策 `docs/decisions/D5-03G-install-reset-device-identity.md`；真机报告 `experiments/d5-03/D5-03-BATCH7-DEVICE-RESET-REPORT.md`。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 重置清理 4 张 → 7 张 | **已完成** | `electron/identity-store.cjs` 的 `RESET_AUTHORIZATION_DELETE_SQL` 恰好 7 条字面量（授权四张 + `device_credentials` → `device_pairing_credentials` → `devices`，**子表先删**：`device_credentials.device_id REFERENCES devices(id)`，`PRAGMA foreign_keys = ON` 下顺序反了会直接抛错）；仍在 `resetInstallation` **既有的那个 `transactSync`** 内先执行、再删身份五表；真机设备三表 **1 / 1 / 2 → 0**、授权四表 **15 / 16 / 0 / 1 → 0**（含 `device_access` **1 → 0**）、身份五表 0；node 三个注入点（T4 / T5 / T6）分别证整体回滚 |
| 为什么必须清（判据链） | **已完成** | `credentialByFingerprint`（`device-store.cjs:51`）→ `authenticateConnection`（`device-service.cjs:514`）是「这个连接是谁」的**唯一查找键**，只看指纹与凭据可用性、**不看组织**；随后心跳（`device-service.cjs:601`）用 `role:"ADMIN"` 的合成 actor 走 Device Gate **直接放行** —— 整条路径**不经过 `device_access`**，所以第五批只清授权表不足以让旧设备身份失效。未消费配对密钥同理：`consumePairing` 只按 `secret_hash` 反查、**不校验组织是否仍存在** → 重置后仍能把设备登记进已删组织（第五批 T7 实测的残留） |
| 不清什么 + 理由 | **已完成** | 逐表给出「能否恢复身份 / 权限」的判据与代码位置；`resource_registry.device_id` 等属用户内容（不产生身份 / 权限）**不整库扫删**；`device_audit` / `authorization_audit` / `audit_log` 一行不删（真机 `device_audit` **8 → 8 逐行不变**） |
| 组织归属唯一来源 = 会话 | **已完成** | `#sessionGate`（`device-service.cjs:87`）新增自报组织校验（`:108`）：调用方自报 `context.organizationId` 与会话不一致 → `SESSION_ORGANIZATION_MISMATCH`（与既有 `SESSION_USER_MISMATCH` 同形态，**不静默忽略**）；**6 处**取数 / 判定改用 `gate.actor.organizationId`；删掉 `"org_default000000000000"` 假组织兜底与服务级 `organizationId` 入口（全仓 `electron/` + `src/` **0 命中**）；`consumePairing` 的组织仍来自签发时的 `pairing.organization_id`（自报 `deviceIdentity.organizationId` 不匹配仍拒 `PAIRING_TOKEN_ORGANIZATION_MISMATCH`） |
| 守卫（收紧） | **已完成** | `ALLOWED_ORG_DELETION_PATHS` 1 条 → **恰好 4 条**（含设备三表），匹配强度未放宽（文件 + 命中形态 + 去空白逐字相等）；新增 `WATCHED_TABLES`（**独立于白名单**：删掉一条登记项，仍要求该表被整表删 → fail-closed）+ 两条 fail-closed 断言（登记项必须在重置集合内 / 每张受 watch 表必须仍被整表删）；负向自证 **4 组注入全 FAIL、对照 PASS** |
| 既有断言改写披露 | **已完成（逐字）** | 被测提交自己改写了 `tests/d5-03-reset-authorization-consistency.test.mjs` 的 4 处既有断言（T7「残留配对凭据仍能登记设备」→「`PAIRING_TOKEN_UNKNOWN` + 0 新设备 / 0 新凭据」；文件头「设备三表是配置类、凭据不构成授权」→「这三张是**能恢复设备身份**的事实，随重置同事务清空」；T6「恰好四张授权表」→「七张」；T2「四表 0 行」→「七张全 0 行」），文件头已逐字写明「旧期望 → 新期望」；理由 = 这些断言刻画的正是本批要修的缺陷本身。本岗对 `experiments/d5-03/mcp-reset-e2e.mjs` **只增** C2b / D2b 两条七表断言 + 文案，**原 26 条一字未删**，计数 26 → 28 |
| 三轴判定 | **功能 = 通过；视觉 = 通过（本批无界面改动）；动效 = 通过（本批无界面改动）** | 见 §2 |
| 回归 | **已完成** | 相关 node 集合 **183/183、exit 0**（29 文件，含新增 `tests/d5-03-reset-device-identity.test.mjs` 11 用例）；`device-ui` **32/32**、`identity-ui` **26/26** 均 exit 0；全量 `npm test` **1376 tests / 1370 pass / 6 fail / exit 1**（6 条逐个给因：2 条既有 + 4 条 **dsh 版本漂移环境性失败**，5 个失败文件对本批改动符号命中数**全为 0**）；`SCHEMA_VERSION` **仍 21**（无 schema 变更，只删行不删表）；`npm run build` 未独立复跑（产品提交自证） |

## 2. 三轴判定（分列）

* **功能 = 通过**：新门禁 `mcp-device-reset-e2e` **44/44 exit 0**（notVerified 0 / productDefects 0）；`mcp-reset-e2e` **28/28 exit 0**；`mcp-policy-e2e` **43/43 exit 0**（notVerified 2，既有）；`batch7-gates-rerun` **4/4**；受影响性 **6/6**；索引完整性 **8/8**；真实 `electron .` + 真实产品操作面（配对密钥由真实 UI 设备面板签发，界面加入码与服务返回值 sha256 逐字相等）/ 探针只读 DB（`DatabaseSync readOnly`，`databaseWritesByProbe=false`，写操作只经产品服务）。
* **视觉 = 通过（本批无界面改动）**：本批改动文件只有 `electron/identity-store.cjs` 与 `electron/device-service.cjs`（+ 3 个测试文件），**不含任何 `.tsx` / `.css`** —— 无需新的浅 / 深或动效量测；如实写理由，不宣称做过像素量测。真机 UI（设备面板）只作为功能驱动路径使用（加入码逐字对照、设备行与后端对照）。
* **动效 = 通过（本批无界面改动）**：同上，改动面不含样式与动画，本批无动效可验。

## 3. notVerified 与缺口（如实登记）

* **notVerified 7 条**（以真机报告 §8 为准）：① **真机注入式回滚**（真机没有注入入口，且不改产品代码无法注入）→ 替代证据 = `tests/d5-03-reset-device-identity.test.mjs` 的 **T4**（`DELETE FROM device_credentials` 注入）/ **T5**（`DELETE FROM devices` 注入）/ **T6**（`DELETE FROM installations` 注入）三个注入点，本轮现场重跑 **183/183**；② **视觉 / 动效量测**（本批无界面改动，没有像素变化可量）；③ **`device_access` 的产品 IPC 入口**（真机为服务级直调，路径已披露）—— **第五批那条「`device_access` 真机 0 → 0 不构成清理证据」本轮已闭环**：新门禁在真实主进程对产品自己的 `DeviceService` 直调 `grantDeviceAccess` 造 1 行 → 重置后 **1 → 0**；④ `invariants()` 的**原生可读入口**（`identity:command` 白名单里没有，仍用等价只读复算）；⑤ **组织 ID 复用的真机对照**（产品没有「用指定 id 创建组织」的入口）→ node T3；⑥ **共库双组织的真机行为级**（`mcp-policy-e2e` 既有 notVerified 2 条；本批未新增「创建组织」入口）；⑦ **真实第三方接入 / 插件隔离**（不在本批范围，**不声称通过**）。
* **路径披露（设备侧动作真的没有 IPC 入口）**：`device:command` 白名单 10 条命令里**没有** `consumePairing`（设备侧动作）/ `authenticateConnection` / `heartbeat`（TLS 后连接身份）/ `grantDeviceAccess`（设备 ACL 写入），且 `device:command` 的 context 由主进程自建（`electron/device-bootstrap.cjs:54`）—— 渲染层连自报 `organizationId` 都递不进去。新门禁经**真实主进程调试口**（`--inspect`，只监听 127.0.0.1、端口独占）给 `DeviceService.prototype` 装**只记录、不改变行为**的包装，捕获**产品自己在真实 UI 路径上创建的那个实例**后直调这些方法 —— **不改产品文件、不写 SQL、查库 readOnly、会话 token 不回传（只回传长度 + sha256 前 16 位）**。
* **两条既有探针门禁继续单列**（**第六批**已用一次性授权 A/B 实测证明是既有失败，本批未改 `tests/**`）：`governance-ui` **1/5**、`model-keychain-restart` **3/15**，登记待单独排期。
* **本批新登记的遗留**：① `run-artifacts.cjs` 索引条目**不记录 `logSha256`**（既有工具缺口：条目引用 `artifacts.logSha256`，而该字段写在 artifact 上；本轮用产物 JSON 核对代替，**未改工具**）；② **2 个历史孤儿 run 目录 + 1 次崩溃运行目录**（均无产物 JSON，不影响判定）；③ **环境 dsh 版本漂移**（`0.1.5-rc.2` → `0.2.0-rc.1`）会让「全量绿」长期不可得，建议维护方决定钉版本或改断言（**不由本批擅自改断言**）。【**第八批已更新**：③ **已闭环** —— 运行时已 PIN 到项目内 `0.1.5-rc.2`（`3bbb347`），4 条版本漂移失败在全量失败名单里清零（见第八批节 §1 / §4）】
* **常量名说明**：`RESET_AUTHORIZATION_DELETE_SQL` 现在含设备身份三张表、**名字偏窄但保留未改名**（docs / 守卫 fail-closed 定位串锚在此名上），已在代码注释中显式披露。
* 既有缺口继续单列（不并入本批）：**OAuth**（仅 `NONE` / `BEARER`）、**插件隔离（D5-08）**、**D5-02 重命名受 Electron 不支持 `prompt()` 限制**、**SIGKILL 边界**、第五批登记其余残留（`app_principals.status` / `RATE_LIMITED` 对象 detail / `invariants()` 无孤儿行检查）。**本批未新增「创建组织」入口。**

## 4. 判定与下一步

**判定：D5-03 第七批（安装重置后旧设备身份失效 + 配对组织归属以会话为准）= PASS（限定范围）；D5-03 整体仍 = PARTIAL。**

剩余缺口逐条：① 跨组织真机入口 / 跨组织真机行为级（`notVerified` 2 条，继续保留）；② 两条探针门禁既有失败（`governance-ui` / `model-keychain-restart`）待单独排期；③ OAuth；④ 插件隔离（D5-08）；⑤ D5-02 `prompt()` 遗留；⑥ SIGKILL 边界；⑦ 本批新登记遗留（`logSha256` 工具缺口 / 孤儿目录 / dsh 版本漂移）；⑧ 第五批登记其余残留（`app_principals.status` / `RATE_LIMITED` 对象 detail / `invariants()` 无孤儿行检查）。

**本批闭环的旧缺口**：第五批登记的「`device_pairing_credentials` 未清 = 已登记的残留能力」（本批随重置同事务清空，真机 **1 / 1 / 2 → 0**、旧密钥 `PAIRING_TOKEN_UNKNOWN`、**0 新设备 / 0 新凭据**）；第五批 `device_access` 真机「0 → 0 不构成清理证据」（本批补成真机 **1 → 0**）。

下一步建议：两条探针门禁单独排期 → 跨组织真机入口（产品需新增「新建组织」或多租户安装，本批不做）→ 设备侧动作是否要开一条产品命令通道（产品方向决策）→ OAuth → 真实第三方 / Adobe（D5-04 / D5-05）→ dsh 版本漂移处置（钉版本或改断言，由维护方决定）。【**第八批已更新**：已处置 —— **钉版本**（项目内 `0.1.5-rc.2`，`3bbb347`），4 条版本漂移失败清零（见第八批节）】

# D5-03 第八批 · DSH 运行时 PIN（项目专用可复现运行时 + 解析器只认项目安装）· 2026-09-29（`3bbb347`）

> **口径（用户明确定范围）**：本批 = **项目专用、可复现的 DSH 运行时**（`npm install --save-dev --save-exact @deepseek-ai/dsh@0.1.5-rc.2`；`package.json` 精确版本、无 `^` / `~`；锁文件带 resolved + 完整 integrity）+ **解析器只认项目安装**（默认 = 仓库根；`OPENARC_DSH_RUNTIME` / `OPENARC_DSH_BIN` 覆盖同样校验；缺失 → `DSH_RUNTIME_MISSING`、版本不符 → `DSH_VERSION_MISMATCH`；**绝不回退** DSH Desktop 共享运行时 / 用户 PATH / 未知版本）+ **ACP SDK 保持 1.4.0**（`resolveAcpSdk()` 删除「回退运行时副本」的分支）+ **保留精确版本断言**（未改成「读自报版本与自身比较」）+ 新增契约测试 **7/7**。**本批无界面改动**（视觉 / 动效 = 通过，本批无界面改动）；**不开放工具调用、不连真实第三方、不运行任意第三方程序、不发用户数据、不声称插件隔离通过**；**不新增「创建组织」产品入口**；**不为凑全绿调宽任何超时 / 等待窗口、不改任何断言**（总经理裁定，见本批决策文档 §6）。
> **判定：D5-03 第八批（DSH 运行时 PIN）= PASS（限定范围：PIN 成立、版本漂移 4 条已闭环、1 条负载 flake 与 2 条预存失败如实单列）；D5-03 整体仍 = PARTIAL**（剩余缺口逐条见 §3 / §4）。【第九批已更新：该条负载 flake 在第九批**未再出现**（第九批全量 1387 / 1385 / 2 的失败名单 = 2 条既有确定性失败）；第九批已实施「保留原始错误码」并改造 cancel 等待；见第九批节】
> **当前有效证据 = 第八批证据清单**：`experiments/d5-03/EVIDENCE.md`（交接方证据索引，随被测提交 `3bbb347` 跟踪）+ `experiments/d5-03/batch8/`（独立验收 **37 个文件** = 36 个收录进 `sha256-manifest.txt` 的原始输出 / 报告 / 5 个探针与扫描脚本 + 清单本身）；本批**没有 runId、没有机器可读汇总 JSON**；更早批次（第一至第七批）的 runId / sha256 / 计数只作历史对照（本批为 node-only 运行时 PIN，未重跑 Electron 台架）。
> **证据口径披露（必读）**：被测内容 = 提交 `3bbb347`（单个提交，父提交 `186e2e0`）**17 个文件 `+11279 / −1083`** = 3 个产品 / 依赖文件（`electron/harness-adapter.cjs` `+43/−14`、`package.json` `+1`（第 91 行精确版本）、`package-lock.json` `+9915/−1069`）+ 1 个新增契约测试 `tests/d5-03-dsh-runtime-pin.test.mjs`（198 行）+ 13 个证据文件（全在 `experiments/d5-03/`）。**锁文件两层口径分列**：依赖条目层 177 → 737 条，**added 560 / removed 0 / modified 0**；文本行层的 1069 条「删除」是 npm 重排 —— 逐行多重集比对，旧锁文件 **2697 行中 0 行**在新锁文件里找不到（新增 8846 行）→ **无任何旧行被真正丢弃**。**证据缺口如实披露**：失败当刻未采集宿主负载指标（报告 §八 标注）；复跑那轮整轮 86571ms、子测试仅 3668ms（约 82 s 在 fixture 建立 / 收尾）→ flake 只能定位到「**环境**」，**未证明具体停顿机制**。
> 完整结果 `docs/D5-03-RESULT.md` 第八批正文；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch8` 段（**纯插入**：旧段逐字节 / 逐键未改）；本批决策 `docs/decisions/D5-03H-dsh-runtime-pinning.md`；独立验收报告 `experiments/d5-03/batch8/D5-03-BATCH8-VERIFICATION-REPORT.md`。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 项目专用可复现运行时 | **已完成** | `npm install --save-dev --save-exact @deepseek-ai/dsh@0.1.5-rc.2` → `added 498 packages, and audited 604 packages in 34m`，exit 0；`node_modules/@deepseek-ai/dsh/package.json` version `0.1.5-rc.2`；锁文件 `resolved=https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.2.tgz` + `integrity=sha512-8Xc8hCQH…`；启动路径 `node_modules/.bin/dsh` → realpath `node_modules/@deepseek-ai/dsh/lib/bin.js`（`01-version-provenance.txt` `12eb3537`） |
| ACP SDK 保持 1.4.0 | **已完成** | `npm ls`：`dsh → dsh-acp-app → dsh-acp → @agentclientprotocol/sdk@1.4.0 deduped`（未被挪走 / 降级 / 升级）；`resolveAcpSdk()` 删除「回退运行时副本」的分支，只认项目那份（`01` / `06`） |
| 解析器只认项目安装、缺失 / 不符明确失败 | **已完成** | 默认 = 仓库根；覆盖同校验；`DSH_RUNTIME_MISSING` / `DSH_VERSION_MISMATCH` 可区分；**绝不回退**；`resolveDshBin()` 只在解析出的运行时内找（**realpath 归属校验**）；孤儿 / planted 假 bin 与 PATH 影子一律拒绝 + **阳性对照**（`02` `9bde0c55` / `04` `a00f1496`） |
| 保留精确版本断言 + 源码级锁 | **已完成** | 既有 3 个测试文件的 `0.1.5-rc.2` / `1.4.0` 字面量断言**一行未改**；709 个源文件分层扫描 `comment | string-literal | BARE-CODE` → **BARE-CODE 0**，产品代码非注释命中 **0**（唯一命中在 `electron/harness-adapter.cjs:37` 注释）（`03` `6d3924ec`） |
| 契约测试 7/7 | **已完成** | `tests/d5-03-dsh-runtime-pin.test.mjs` D5-03-A…G：默认解析 / 两类拒绝 / 不回退非空证明 / SDK 1.4.0 / 源码级锁 / `OPENARC_DSH_BIN` 校验（`06` `22817f8a`） |
| 修前 → 修后 | **已完成** | 3 文件 `tests 12 / pass 8 / fail 4` exit 1（I5 / P1 / P2 / official facade）→ 同 3 文件 **12/12 exit 0**（`experiments/d5-03/baseline-before-pin.txt` → `05` `64f3b10f`） |
| 六类真实链路 | **已完成（全绿）** | protocol 4/4、c4-dsh-write 5/5、tool-dsh-facade 3/3（exactly 2 READ_ONLY）、permission 1/1（1 request / reject(cancelled) / 0 执行 / 0 触达 Provider）、cancel 3/3（0 retry + 连接关闭 + exited）、acp-lifecycle 3/3；tool-dsh-lifecycle 首跑 1/2（环境型 flake）→ 复跑 2/2 + 探针 2/2 ×3 |
| 受影响门禁 | **211/211 exit 0** | `test:d4-02b` 16/16、`test:d4-02c` 22/22、`test:d4-03b` 59/59、`test:d4-03d` 52/52、`test:d4-03d-closure` 62/62（`19-affected-gates-summary.txt` `703a91a5`）；**Electron UI 门禁未重跑**（静态证明不 require `harness-adapter.cjs`，不受影响） |
| 全量 `npm test` | **exit 1，如实单列** | `1383 tests / 1380 pass / 3 fail`（duration 144273ms）：2 条预存（`d4-03-approval-push-isolation` P2、`side-effect-c4-gates` No Direct Domain Bypass）+ 1 条**已证环境型 flake**（`task-harness-cancel:84`，`0 !== 1`，单跑 `--test-concurrency=1` **3/3 ×3 全过**）；**原先 4 条版本漂移失败在全量失败名单里已全部消失** |【第九批已更新：该 flake 在第九批**未再出现**（第九批全量 1387 / 1385 / 2 的失败名单里没有它；cancel 三用例全绿），且第九批已把该等待改为「产品可观察阶段 + 上界与产品预算成对」；W49 的「0 次请求」未复现；见第九批节 §3】
| flake 归因（A/B 补做） | **已完成** | `--version` p50 项目 40.9ms vs 共享 46.4ms；ACP boot p50 项目 474.4ms vs 共享 445.2ms（±7%）；失败那次需 >30s（≈ 产品路径 0.73 s/run 的 40–65 倍）→ **量级上版本差异无法解释，判为宿主环境型，与本批 PIN 无关**（`22` `546cce1a` / `23` `a54ddd6b`） |
| 边界 | **未变** | `~/.dsh` mtime `1790647563` 前后一致、11 个顶层条目逐条一致、`.credentials.yaml` 仅元数据一致（atime 停在 9/11 → **未被读取**）；共享运行时 mtime `1789097644`、版本仍 `0.2.0-rc.1`；主工作树 17 条未提交与 HEAD `9119f85` 未动；密钥扫描 **63 文件 0 命中**；argv 含项目 dsh 的进程 **0 个** |
| 三轴判定 | **功能 = 通过；视觉 = 通过（无界面改动）；动效 = 通过（无界面改动）** | 见 §2 |

## 2. 三轴判定（分列）

* **功能 = 通过（限定范围）**：修后同 3 文件 **12/12**、契约 **7/7**、六类真实链路全绿、5 个受影响门禁 **211/211**，全 exit 0；运行时全部为项目内 `0.1.5-rc.2`。
* **视觉 = 通过（本批无界面改动）**：被测提交 17 个文件里只有 1 个 `.cjs` + `package.json` + `package-lock.json` + 1 个测试 + 13 个证据文件，**不含任何 `.tsx` / `.css`** → 无像素变化可量；如实写理由，不宣称做过量测。
* **动效 = 通过（本批无界面改动）**：同上，改动面不含样式与动画。

## 3. notVerified 与缺口（如实登记）

* **notVerified 8 条**（以 batch8 报告 §六为准）：① **Electron UI 门禁实机重跑**（静态证明不 require `harness-adapter.cjs`，不受本批影响，未重跑）；② `experiments/d5-02/agent-canvas-probe.mjs`（引用 harness-adapter 但**非 npm 门禁**）；③ **视觉 / 动效验收**（本批无 UI 改动）；④ `~/.dsh` 各子目录**内部内容**（只记顶层与 stat，不读内容）；⑤ `.credentials.yaml` **内容**（明确禁读）；⑥ W48 其余非 harness 门禁；⑦ **失败当刻的宿主负载指标**（loadavg / `vm_stat` / spindump 未采集 —— 本批证据缺口，报告 §八 标注）；⑧ `npm ci` 实跑（锁文件具备可复现依据，但未实跑）。
* **两条既有探针门禁继续单列**（第六批已 A/B 实证为既有失败，本批未改 `tests/**`）：`governance-ui` **1/5**、`model-keychain-restart` **3/15**，登记待单独排期。
* **本批新登记的遗留**：① **超时预算 / 错误码映射**（`DEFAULT_START_TIMEOUT_MS = 30000`；orchestrator 把 `HARNESS_START_TIMEOUT` 映射成 `HARNESS_TURN_TIMEOUT`）→ **单独批次的产品 / 测试裁决项，本批不实施**（报告 §七 列出「调宽预算 / 保留原始错误码 / 维持现状」三个选项的利弊）；② `tests/task-harness-cancel.test.mjs:84` 的 **20s 等待窗口**同为环境型 flake；③ 两条预存失败仍在（需另案）；④ `/tmp` 下 **22 个更早批次 `oa-d503*` 残留**未清；⑤ 首次 `npm install` 耗时 **34 分钟**（CI 需预留）；⑥ `npm ls --depth=0` 2 个 `extraneous`（`@emnapi/runtime` / `@img/sharp-wasm32`，锁文件里本就 `optional: true`，非漂移）。【第九批已更新：①**已实施**——分类器原样保留 `HARNESS_START_TIMEOUT`（不再冒充 `HARNESS_TURN_TIMEOUT`），`DEFAULT_START_TIMEOUT_MS` 仍 **30000**（预算未动）；界面可见文案由 `· HARNESS_TURN_TIMEOUT` 变为 `· HARNESS_START_TIMEOUT`，经浅 / 深 + 布局 + 对比度实机验收（8.208:1 / 16.62:1 ≥ 4.5:1）。②**已实施**——`tests/task-harness-cancel.test.mjs` 改为等待产品可观察阶段（上界 = 产品预算 30000 + 余量 15000，与产品常量成对），判据一字未放宽；第八批那条环境型 flake 在第九批**未再出现**。③④⑤⑥ 仍按原文单列。详见第九批节】
* 既有缺口继续单列（不并入本批）：**跨组织真机 2 条 notVerified**、**OAuth**（仅 `NONE` / `BEARER`）、**插件隔离（D5-08）**、**D5-02 重命名受 Electron 不支持 `prompt()` 限制**、**SIGKILL 边界**、第五批登记其余残留（`app_principals.status` / `RATE_LIMITED` 对象 detail / `invariants()` 无孤儿行检查）。**本批未新增「创建组织」入口。**

## 4. 判定与下一步

**判定：D5-03 第八批（DSH 运行时 PIN）= PASS（限定范围：PIN 成立、版本漂移 4 条已闭环、1 条负载 flake 与 2 条预存失败如实单列）；D5-03 整体仍 = PARTIAL。**【第九批已更新：该条环境型 flake 在第九批**未再出现**（第九批全量 1387 / 1385 / 2 的失败名单里没有它）；第九批已实施「保留原始错误码」并把 cancel 等待改为产品可观察阶段，见第九批节】

**本批闭环的旧缺口**：第七批登记的「环境 dsh 版本漂移（`0.1.5-rc.2` → 共享运行时 `0.2.0-rc.1`）令全量长期不绿」——运行时已 PIN 到项目内，**4 条漂移失败在全量失败名单里清零**。

剩余缺口逐条：① 超时预算 / 错误码映射（单独批次裁决，本批不改）；② `task-harness-cancel:84` 的 20s 窗口；③ 两条预存失败（`d4-03-approval-push-isolation` P2、`side-effect-c4-gates` No Direct Domain Bypass）另案；④ `/tmp` 22 个更早批次残留；⑤ CI 首次安装时间；⑥ 跨组织真机 2 条 notVerified；⑦ 两条探针门禁既有失败；⑧ OAuth；⑨ 插件隔离（D5-08）；⑩ D5-02 `prompt()` 遗留；⑪ SIGKILL 边界；⑫ 第五批登记其余残留。【第九批已更新：其中①「超时 / 错误码映射」与②「cancel 20s 窗口」已由第九批实施（保留原始错误码 + 取消测试按可观察阶段等待；预算未调宽、判据未放宽）；本批剩余缺口逐条见第九批节 §3 / §4】

下一步建议：超时 / 错误码裁决（单独批次，三选项利弊已备）→ 两条预存失败另案 → 两条探针门禁单独排期 → 跨组织真机入口（产品需新增「新建组织」或多租户安装，本批不做）→ OAuth → 真实第三方 / Adobe（D5-04 / D5-05）。【第九批已更新：第一项「超时 / 错误码裁决」已由第九批完成（采纳「保留原始错误码」+ 取消等待改造）；后续顺位调整为：R1 / R1-e 裁决 → 两条既有确定性失败另案 → 两条探针门禁单独排期 → 跨组织真机入口 → OAuth → 真实第三方 / Adobe（D5-04 / D5-05）】

# D5-03 第九批 · 启动超时不再冒充执行超时 + 取消测试按可观察阶段等待 · 2026-09-29（`f9133f5` + `d2d9281`）

> **口径（用户明确定范围）**：本批 = **错误归属**（`electron/task-domain.cjs` 新增 `ERROR.HARNESS_START_TIMEOUT`；`electron/task-harness-orchestrator.cjs:101` 的分类器**原样保留**启动超时，不再改写成执行超时）+ **取消测试按产品可观察阶段等待**（不再用固定 20s 魔数窗；上界 = 产品启动预算 30000 + 余量 15000，与产品常量成对；判据一字未放宽）+ **只改这两处**（预算 `30000 / 180000` 未动、`SCHEMA_VERSION` 仍 **21**、`src/**` **0 行**改动）。**不开放工具调用、不连真实第三方、不运行任意第三方程序、不发用户数据、不声称插件隔离通过**；**不新增「创建组织」产品入口**；**不为凑全绿调宽任何超时 / 等待窗口、不改任何既有断言**（断言变更清单 = **无**）。
> **判定：D5-03 第九批（启动超时错误归属 + 取消测试按可观察阶段等待）= PASS（限定范围：两项收口成立；2 条既有确定性失败与 R1 / R2 遗留如实单列）；D5-03 整体仍 = PARTIAL**（剩余缺口逐条见 §3 / §4）。
> **当前有效证据 = 第九批 runId + 两种码探针 + 复用门禁证据**：`experiments/d5-03/batch9/verify/`（`batch9-01-codes-probe.json` 两种码探针、真机界面验收 runId `20260929T094444Z-3a33-batch9-harness-timeout-ui`、`batch9-03-affectedness.json` 机械受影响性、`04-gate-d4-02c.txt`、`05-npm-test-full.txt`、`batch9-04-r1-observation.json`、`batch9-05-residue-integrity.json`、`MANIFEST.sha256`）；**复用门禁证据** = 其余 **32 个门禁**，依据是机械判据「**改动分支不可达**」（逐条见验收报告 §3.1；复用产物**不含被测 commit 戳**，如实披露）。
> **证据口径披露（必读）**：被测内容 = 提交 `f9133f5`（单个提交，父提交 `668238e`）**24 个文件 `+18989 / −25`** = **产品 / 测试改动面 7 个文件 `+345 / −25`**（`electron/task-domain.cjs` `+2/−0`、`electron/task-harness-orchestrator.cjs` `+1/−1`、`tests/task-harness-orchestrator.test.mjs` `+137/−1`、`tests/task-harness-cancel.test.mjs` `+156/−23` + **新增 3 个夹具探针** `tests/fixtures/harness-acp/{start-hang-agent,turn-hang-agent,session-new-hang-agent}.mjs`）+ 17 个 `experiments/d5-03/batch9/**` 证据文件；验收证据提交 = `d2d9281`（22 个文件 `+15670 / −0`，全在 `experiments/d5-03/batch9/verify/**`；`artifacts/` 被 `.gitignore:3` 忽略）。
> 完整结果 `docs/D5-03-RESULT.md` 第九批正文；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch9` 段（**纯插入**：旧段逐字节 / 逐键未改）；本批决策 `docs/decisions/D5-03I-harness-timeout-attribution.md`（第八批决策 `D5-03H` 的 §6 裁定 1/3、§7 末尾、§10 遗留 1/2、§12 判定已就地加【第九批已实施】/【第九批已更新】并写明结果，**原文一字未删**）；独立验收报告 `experiments/d5-03/batch9/verify/BATCH9-VERIFY-REPORT.md`；执行方报告 `experiments/d5-03/batch9/D5-03-BATCH9-REPORT.md`。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 启动超时保留原始错误码 | **已完成** | `electron/task-domain.cjs:131-135` 新增 `ERROR.HARNESS_START_TIMEOUT`；`electron/task-harness-orchestrator.cjs:101` 不再改写 → 真实链路两种码 **60 项检查（59 PASS + 1 条按预期红，exit 0）** |
| 完整路径与界面影响（如实） | **已交付** | 逐跳 `file:line` 见执行方报告 §1.1（adapter 抛码 → orchestrator 撤销能力 + dispose + 分类 → `#blockStep` → task-service 三处 BLOCKED + `error_code` + `stop_reason="blocked"` + 四类事件 → task-bootstrap → main → preload → 渲染层；**无独立日志 sink**）；`[data-ai-error]`（`src/desktop/components.tsx:1010`）**原样显示错误码** → 可见文案由 `· HARNESS_TURN_TIMEOUT` 变 `· HARNESS_START_TIMEOUT`；`[data-ai-stop-reason]` 只在 `resumable=true` 渲染 → 启动超时该节点不出现；**未加错误码 → 人话映射、`src/**` 0 行改动** |
| 预算 / schema 未动 | **已完成（约束）** | `DEFAULT_START_TIMEOUT_MS = 30000` / `DEFAULT_TURN_TIMEOUT_MS = 180000` 未改；`SCHEMA_VERSION` 仍 **21**（`electron/identity-store.cjs:68`）；测试只注入更小值 |
| 取消测试按可观察阶段等待 | **已完成** | 旧固定 `deadline = +20000` 魔数窗 → `waitForProviderRequest`（等 provider 请求已发起；期间记录 `child-spawned` / `session-created` / `harness-running`）；上界 = 产品启动预算 30000 + `START_MARGIN_MS(15000)`（**与产品常量成对**）；超限或产品先收敛 → 单调时钟阶段时间线 + 宿主负载 + 产品状态；**判据一字未放宽**（`requests === 1` / `calls === 1` / `CANCELLED` / capability `REVOKED`），未 skip / 未删除 |
| 反向验证 | **已完成** | 副本只改回旧映射 → 启动用例 `[EXPECTED-RED]` 实际 `HARNESS_TURN_TIMEOUT`；执行用例仍绿（外科式）；产品源码 sha256 前后一致 `aa6142e1…`；副本已删 |
| 竞争（取消 vs 超时） | **已完成** | 两例终态一致且唯一 `CANCELLED`、0 孤儿、能力全 `REVOKED` + 旧 token 401、取消后 **fail-closed**（`TASK_REVISION_CONFLICT`） |
| 真机界面验收 | **75/75 · exit 0** | runId `20260929T094444Z-3a33-batch9-harness-timeout-ui`（artifact sha256 `7ed60d0b…`）：浅 / 深 / 深色减少动态 5 场景 20 张截图；无横向溢出、错误行 2 行、按钮矩形相同、余量 108.88px；对比度 **浅 8.208:1 / 深 16.62:1** ≥ 4.5:1（`DESIGN_SYSTEM.md:248`）；该行 `animationName=none` / `transitionDuration=0s` |
| 受影响门禁 | **26/26 · exit 0** | 机械分析（`batch9-03-affectedness.json`）：**只有 `test:d4-02c` 真受影响**（唯一产生启动超时的夹具 `start-hang-agent.mjs` 全仓只被一个门禁执行）；其余 **32 个门禁**「分支不可达」→ 复用证据（依据写清） |
| 全量 `npm test` | **exit 1，如实单列** | **1387 tests / 1385 pass / 2 fail**：两条**既有确定性失败**（`d4-03-approval-push-isolation` P2 多 `targetRef` / `url`；`side-effect-c4-gates` No Direct Domain Bypass）**未修**；**无新失败**；**第八批那条环境型 flake 未再出现**；W49 的「0 次请求」**未复现** |
| 断言变更清单 | **无** | 本批没有任何既有断言需要修改（错的是产品映射）；新增断言 = `task-harness-orchestrator.test.mjs` 两码正反例 + 真实 IPC 入口对渲染层可见载荷的断言、`task-harness-cancel.test.mjs` 等阶段机制（判据未变） |
| 三轴判定 | **功能 = 通过；视觉 = 通过；动效 = 通过** | 见 §2 |

## 2. 三轴判定（分列）

* **功能 = 通过（限定范围）**：两种码 60 项检查（59 PASS + 1 条按预期红）、反向验证成立、竞争两例 fail-closed、能力撤销 + 旧 token 401、有界停止、0 孤儿；真机 UI 两种码均如实显示，后端 facts 与界面一致。
* **视觉 = 通过**：真机 **75/75**；布局两码只差 1 字符（无溢出 / 无换行变化 / 按钮矩形相同 / 余量 **108.88px**）；对比度 **浅 8.208:1 / 深 16.62:1** ≥ 普通文本门槛 **4.5:1**（`DESIGN_SYSTEM.md:248`；背景取众数 `:251`、文字 `text.primary` `:63`）。
* **动效 = 通过**：该行 `animationName=none` / `transitionDuration=0s`（浅 / 深 / 减少动态）；减少动态下元素作用域 `--dur-quick=0ms`（`MOTION_SYSTEM.md:21`）；`dark-turn` 与 `dark-reduced-turn` 状态行 PNG **sha256 完全相同**；本批 `src/**` **0 行改动**。

## 3. notVerified 与缺口（如实登记）

* **notVerified 6 条**（以验收报告 §四为准）：① **R2 竞争后 in-flight model call 的最终归宿**（取消后 1.5s 仍 `STARTED`，未观测更久）；② **R1 场景未做实机截图**（R1 在界面上会长期停在「运行中」）；③ **`providerErrorCode` 语义**（装的是 harness 超时码，**未判定是否为缺陷**）；④ **复用门禁证据不含 commit 戳**（依据是机械不可达；含 `test:d4-02a` 未重跑）；⑤ **未做 <1000px 窗口实测**；⑥ **探针宿主未接入 `openarc-resource` / `openarc-canvas` 协议**（只接 `openarc-file`）。
* **遗留（本批未修）**：【第十批已实施 + 已验证：R1 改为绝对截止时间（initialize 与 session/new 共用一份预算），R1-e 让启动段在 registry 里可被 cancel/dispose 触达；红→绿证据见第十批节】**R1** `electron/harness-adapter.cjs:278` 的 `newSession` **无任何超时**（启动预算只包 `initialize`；受控实验：700ms 预算下 8s 不收敛 = run `STARTING` / task `RUNNING` / 0 请求 / 0 prompt / 子进程存活；对照 `initialize` 阻塞 `+757.0ms` 即收敛）· **R1-e** 该无界段里 `orchestrator.dispose()` / `cancel()` **触达不到 adapter**（`registry.set` 晚于 `adapter.start()` 返回），子进程只在主进程退出后消失 · **R2** 竞争账本残留（call 停 `STARTED`）· **两条既有确定性失败**（未修）· `START_MARGIN_MS = 15000` 与产品预算成对（产品改预算需同步）· **本批新增调试 / 中途 run 目录如实登记**：`…-0dc2`（exit 2，0/0/0）、`…-1244`（exit 2，2/3）、`…-fccc`（exit 2，2/2）、`…-a352`（exit 1，73/74）、`…-2a0e`（exit 0，75/75，已被取代）+ `…-be39` 空目录（未 finalize，不入索引）。
* **继续单列（不并入本批）**：**跨组织真机 2 条 notVerified**、**OAuth**、**两条既有探针门禁失败**（`governance-ui` 1/5、`model-keychain-restart` 3/15）、**插件隔离（D5-08）**、**D5-02 重命名受 Electron 不支持 `prompt()` 限制**、**SIGKILL 边界**；**本批未新增「创建组织」入口**。

## 4. 判定与下一步

**判定：D5-03 第九批（启动超时错误归属 + 取消测试按可观察阶段等待）= PASS（限定范围：两项收口成立；2 条既有确定性失败与 R1 / R2 遗留如实单列）；D5-03 整体仍 = PARTIAL。**

**本批闭环的旧缺口**：第八批登记的「超时 / 错误码映射」与「cancel 20s 等待窗口」——① **已实施**（分类器原样保留 `HARNESS_START_TIMEOUT`，预算未动；界面文案由 `· HARNESS_TURN_TIMEOUT` 变为 `· HARNESS_START_TIMEOUT`，经浅 / 深与对比度实机验收）；② **已实施**（取消测试按产品可观察阶段等待，上界与产品预算成对，判据未放宽）。

剩余缺口逐条：① R1（`newSession` 无上界）+ R1-e（无界段 dispose / cancel 触达不到 adapter）【第十批已实施：两项均已收口并有红→绿证据；见第十批节】；② R2 竞争账本残留【第十批已给**不同根因**证据：取消路径不终结 in-flight model call 信封，仍未修，另案】；③ 两条既有确定性失败（`d4-03-approval-push-isolation` P2、`side-effect-c4-gates` No Direct Domain Bypass）另案；④ `START_MARGIN_MS` 与产品预算同步约束；⑤ 本批调试 run 目录（如实登记，历史产物未被改写）；⑥ 上述 notVerified 6 条；⑦ 跨组织真机 2 条 notVerified；⑧ 两条探针门禁既有失败；⑨ OAuth；⑩ 插件隔离（D5-08）；⑪ D5-02 `prompt()` 遗留；⑫ SIGKILL 边界；⑬ 第五批登记其余残留。

下一步建议：【第十批已裁决并实施：给 `session/new` 同一绝对截止时间 + 启动段可被 cancel/dispose 触达】原建议：R1 / R1-e 裁决（给 `session/new` 同预算上界，或启动各子阶段落 safe 事件）→ 两条既有确定性失败另案 → 两条探针门禁单独排期 → 跨组织真机入口（产品需新增「新建组织」或多租户安装，本批不做）→ OAuth → 真实第三方 / Adobe（D5-04 / D5-05）。










# D5-03 第十批 · 收口 Harness 启动全程的超时与取消（R1 + R1-e）· 2026-09-29（`e626045`）

> **口径（用户明确定范围）**：本批 = 第九批登记的 **R1**（`session/new` 无上界）+ **R1-e**（无界段里 `orchestrator.cancel()` / `dispose()` 触达不到 adapter）；**R2**（取消后 call 停在 `STARTED`）**只做同根因排查并单列，不修**。**不调宽任何超时 / 等待窗口、不跳过测试、不放松任何断言**（断言变更清单 = **无既有断言改动**）；**未做 OAuth、D5-04、未新增「创建组织」入口**；只在 `/Users/wepingli/Desktop/OpenArc OS-integration` 工作，未触碰主工作树改动、DSH Desktop 共享运行时与 `~/.dsh`，未 push。
> **判定：D5-03 第十批（R1 启动全程预算 + R1-e 启动段可取消 / 可 dispose）= PASS（限定范围：两项收口成立，红→绿、共享截止时间、迟到响应、竞争与重复取消、进程与能力回收均有证据；R2 不同根因与两条既有失败如实单列）；D5-03 整体仍 = PARTIAL**（剩余缺口见 §3 / §4）。
> **被测 commit**：`e626045`（父 `05fa678`，单提交，5 个文件 `+601 / −44`；`src/**` **0 行改动**；`SCHEMA_VERSION` 仍 **21**；预算 `30000 / 180000` **未动**）。提交曾按 `test:d4-02c` 门禁暴露的真实回归（启动段内 kill child 退化成 `INTERNAL_ERROR`）修复后 `--amend` 一次，**被测内容 = 最终提交内容**。
> **证据**：`experiments/d5-03/batch10/verify/`（`00-r1-probe-green.json`、`01-gate-d4-02c.txt`、`02-npm-test-full.txt`、`03-new-cases.txt`、`red-run-orchestrator.txt`、`red-run-cancel.txt`、`r2-diagnose.mjs` + `r2-diagnose-result.json`）；执行方报告 `experiments/d5-03/batch10/D5-03-BATCH10-REPORT.md`；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch10` 段（**纯插入**：`git diff --numstat` = `146 / 0`，旧段自 `"batch9"` 起至 EOF **逐字节相同**，已机械校验）。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| R1 · 启动预算覆盖整段异步启动 | **已完成** | `adapter.start` 进入时算一次**绝对截止时间** `deadlineAt = clock() + startTimeoutMs`；`initialize` 与 `session/new` 共用它（`#withDeadline`，剩余预算 = `deadlineAt - now()`，为 0 立刻超时）→ **每段不再各自获得 30 秒**；实测注入时钟走 600/700ms 时 `session/new` 剩余预算 **98ms**（`03-new-cases.txt` 第 20 条用例：`session/new` 剩余预算 98ms） |
| R1 · 无响应时有界收敛 | **已完成** | `session/new` 永不回应 → `HARNESS_START_TIMEOUT` + task/step/run 三处 `BLOCKED` + `error_code`；子进程退出、临时目录删除、两类能力 `REVOKED`、0 孤儿；`0 provider 请求 / 0 prompt / 0 模型调用` |
| R1 · 迟到响应不复活 | **已完成** | 探针延迟 1800ms 回应（预算 700ms）：窗口过后仍是同一条 `BLOCKED`，不新建 run、0 调用、0 请求、0 prompt、无 artifact、无 `harness.run.succeeded`；adapter 侧 `#assertNotInterrupted` 双向拦截 |
| R1 · 启动失败自清理 | **已完成** | `start` 失败一律 `#runTeardown()`（幂等、只跑一次）：撤销 tool + model 能力 → `closeSession` → stdin close → SIGTERM → bounded SIGKILL → `bridge.stop()` → 删临时目录；`sessionId` 保持 `null`；重复 `dispose()` 结果形状不变 |
| R1-e · 启动段可被 cancel 触达 | **已完成** | `adapter.start()` **之前**先 `registry.set(..., starting: true)`；`cancel()` 对 `starting` 登记 `abortStart → revoke 两类能力 → await dispose()` 并立刻注销登记；用户取消在启动段内 → **唯一 `CANCELLED`**（task / step / run 三处），0 孤儿，**旧 token 实际请求 401 `PROXY_UNAUTHORIZED`**，重复取消幂等 |
| R1-e · 启动段可被 dispose 触达 | **已完成** | 应用 `dispose()` 在启动段内：`runTask` 有界收敛且**绝不抛异常**、run 不悬挂 `STARTING`、0 孤儿、能力 `REVOKED`、`unhandledRejection` 计数 **0** |
| 竞争与临界点 | **已完成** | 取消优先（`cancel_requested` 先持久）：`session/new` 700ms 后即将回应时取消 → 取消后 1.5s 窗口终态不翻转、无 `CANCELLED + SUCCEEDED` 矛盾、0 prompt；启动段 catch 与启动后阶段复核都据此走 `#finalizeCancelled`，绝不翻转成 `BLOCKED`；`#finalizeCancelled` 增加 revision 冲突重读，run 绝不留在非终态 |
| 正常启动与执行阶段超时 | **继续通过** | 两条既有用例（`start-hang` / `turn-hang`）与 IPC 入口用例全部通过；`test:d4-02c` **33/33 exit 0** |
| 门禁（受影响） | **6/6 · 全部 exit 0** | `test:d4-02c` 33/33（45.3s）；`tool-dsh-{lifecycle,cancel,facade}` 9/9（32.4s）；`test:d4-03b-dsh` 26/26（51s）；`d4-03-model-binding` 19/19（28s）；`d5-03-{dsh-runtime-pin,mcp-stream,app-grant-org-isolation}` 24/24（11s）；`d4-07-budget-consistency` 3/3（6s） |
| 全量 `npm test` | **exit 1，如实单列** | **1394 tests / 1392 pass / 2 fail**（duration **142327.9ms**）：两条**既有确定性失败**（`d4-03-approval-push-isolation` P2 多 `targetRef` / `url`；`side-effect-c4-gates` No Direct Domain Bypass）**未修**；**无新增失败、无 flake、无 skipped**；新增 7 条用例已计入总数 |
| 断言变更清单 | **无既有断言改动** | 没有任何既有断言被修改 / 放宽 / 跳过；新增 7 条用例 + 1 个探针夹具（`tests/fixtures/harness-acp/session-new-hold-agent.mjs`，延迟由 `argv[2]` 控制，不传 = 永不回应） |
| 反向验证（红） | **已完成** | 工作树回到 `05fa678` 的两个产品文件：第九批探针 `runSettled=false`（700ms 预算 + 8s 观察窗不收敛、run `STARTING`、task `RUNNING`、child 存活）；新增 3 条编排器用例全部 `RED-HANG`（4s 观察窗未收敛）；adapter 自清用例同样未收敛；启动段取消用例**全程挂住**（30s 外层有界杀停，无 TAP 断言产出） |

## 2. 三轴判定（分列）

* **功能 = 通过（限定范围）**：红→绿成立；共享绝对截止时间有决定性判据（剩余预算 98ms，而非重新获得 700ms）；迟到响应不复活；取消 / dispose 在启动段内可触达且终态唯一；旧 token 真实请求 401；0 孤儿、0 未处理 Promise 异常；正常启动与执行阶段超时用例继续通过。
* **视觉 = 本批不适用（如实披露）**：`src/**` **0 行改动**，无新增文案 / 布局 / 组件；界面影响仅为取消启动段后 task / run 显示既有 `CANCELLED` 文案。**未做真机截图**。
* **动效 = 本批不适用（如实披露）**：无任何动效相关改动。

## 3. notVerified 与缺口（如实登记）

* **notVerified 4 条**：① 未做真机截图（本批无界面改动，界面影响沿用既有组件路径）；② 复用门禁证据不含被测 commit 戳（依据是本批只碰 Harness 启动 / 取消路径，其余门禁不可达；如实披露）；③ 未做 `<1000px` 窗口实测（无界面改动）；④ 「迟到响应」只在探针层面验证，未构造真实 dsh 的迟到 `session/new`。
* **本批新登记（不修，单列）**：① **R2 不同根因证据**——取消后 in-flight model call 五个时点（0/200/1000/3000/6000ms）始终 `STARTED`，而 run/task/step 均 `CANCELLED`；缺陷面在「取消路径不终结 model call 信封」（`TaskService.finalizeCancel` / `cancelHarnessRun` 不触碰 `task_model_calls`）→ **另案**；② `orchestrator.dispose()` 在**应用退出路径未被调用**（`electron/main.cjs` 的 `will-quit` 只做 MCP 有界 dispose + `modelProxy.stop()` + `store.close()`）→ 本批未改，待裁决；③ 门禁暴露的真实回归（启动段内 kill child 归因 `INTERNAL_ERROR`）**已在本批内修复**并复跑通过（`task-harness-recovery` 3 连跑 2/2）。
* **继续单列**：两条既有确定性失败（未修）· `START_MARGIN_MS = 15000` 与产品预算成对（产品改预算需同步）· 跨组织真机 2 条 notVerified · 两条探针门禁既有失败（`governance-ui` 1/5、`model-keychain-restart` 3/15）· OAuth · 插件隔离（D5-08）· D5-02 `prompt()` 遗留 · SIGKILL 边界 · 第九批调试 run 目录残留。
* **本批新增临时产物**：`/tmp/oa-b10-sub/*`（独立门禁日志）、`/tmp/oa-b10-red/*`（红运行临时副本，已删除；红运行结论已入库 `experiments/d5-03/batch10/verify/red-run-*.txt`）；仓库内 `experiments/d5-03/batch10/**` 与 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch10` 段为**本批新增 tracked 证据**。

## 4. 判定与下一步

**判定：D5-03 第十批（R1 启动全程预算 + R1-e 启动段可取消 / 可 dispose）= PASS（限定范围：两项收口成立；R2 不同根因与两条既有失败如实单列）；D5-03 整体仍 = PARTIAL。**

**本批闭环的旧缺口**：第九批 §3 遗留的 **R1**（`newSession` 无上界）与 **R1-e**（无界段 dispose / cancel 触达不到 adapter）——已实施并验证（见 §1）。

剩余缺口逐条：① R2（取消后 call 停 `STARTED`，已定性为不同根因）另案；② 应用退出路径未调用 `orchestrator.dispose()`（待裁决）【第十一批已实施：will-quit 改调 app-shutdown.cjs 的唯一收尾顺序，Harness 先收、modelProxy/store 后关；并修掉 quit 微任务挂死；见第十一批节】；③ 两条既有确定性失败（`d4-03-approval-push-isolation` P2、`side-effect-c4-gates` No Direct Domain Bypass）另案；④ 上述 notVerified 4 条；⑤ `START_MARGIN_MS` 与产品预算同步约束；⑥ 跨组织真机 2 条 notVerified；⑦ 两条探针门禁既有失败；⑧ OAuth；⑨ 插件隔离（D5-08）；⑩ D5-02 `prompt()` 遗留；⑪ SIGKILL 边界；⑫ 第五批登记其余残留。

下一步建议：R2 裁决（取消路径终结 model call 信封）→ 【第十一批已完成：应用退出路径是否调用 `orchestrator.dispose()`】原建议：R2 裁决（取消路径终结 model call 信封）→ 应用退出路径是否调用 `orchestrator.dispose()`（一行接线，但属产品行为变更，需裁决）→ 两条既有确定性失败另案 → 两条探针门禁单独排期 → 跨组织真机入口 → OAuth → 真实第三方 / Adobe（D5-04 / D5-05）。

# D5-03 第十一批 · 应用正常退出时收尾 Harness · 2026-09-29（`0eed84c`）

> **口径（用户明确定范围）**：本批 = 第十批登记的「应用退出路径（`electron/main.cjs` 的 `will-quit`）从未调用 `orchestrator.dispose()`」**一项**；**R2**（取消后 model call 停在 `STARTED`）**留给下一批，未混入**。**不调宽任何超时、不跳过测试、不放松断言**；**未做 OAuth、D5-04、未新增「创建组织」入口**；只在 `/Users/wepingli/Desktop/OpenArc OS-integration` 工作，未触碰主工作树 17 项改动、DSH Desktop 共享运行时与 `~/.dsh`，未 push。
> **判定：D5-03 第十一批（应用正常退出时收尾 Harness）= PASS（限定范围：will-quit 确实收尾 Harness，顺序 / 有界 / 不伪造终态 / 重复 quit 全部有真实 Electron 证据；并顺带修掉门禁暴露的 quit 微任务挂死缺陷；R2 与新登记项如实单列）；D5-03 整体仍 = PARTIAL**。
> **被测 commit**：`0eed84c`（父 `7569016`，单提交；改动面 `electron/app-shutdown.cjs` +80/−0（新增）、`electron/main.cjs` +23/−19、`package.json` +1/−0、`tests/app-shutdown.test.mjs` +92/−0（新增）、`tests/fixtures/harness-acp/echo-agent.mjs` +31/−0（新增）、`experiments/d5-03/batch11/verify/**` 验收脚本；`src/**` **0 行改动**、`SCHEMA_VERSION` 仍 **21**、预算 `30000 / 180000` 未动）。
> **证据**：`experiments/d5-03/batch11/verify/`（`01-exit-e2e.txt`、`02-gate-d4-02c.txt`、`03-npm-test-full.txt`、`04-quit-microtask-repro.txt`、`exit-e2e.mjs`、`app/**`、`quit-microtask-repro.mjs`；运行产物 `runs/**` 已 gitignore）；执行方报告 `experiments/d5-03/batch11/D5-03-BATCH11-REPORT.md`；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch11` 段（**纯插入**：`git diff --numstat` = `181 / 0`，旧段自 `"batch10"` 起至 EOF **逐字节相同**，已机械校验）。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 退出时收尾 Harness | **已完成** | `electron/main.cjs` 的 `will-quit` 改调 `app-shutdown.cjs` 的 `disposeAppResources()` → `orchestrator.dispose()`：停下在途启动 / 执行、撤销模型与工具能力、回收 harness 子进程与 bridge、删临时目录；6 场景真实退出中 `harness.timedOut=false`，退出后后代进程 **0** |
| 收尾顺序 | **已完成** | `Promise.all[ MCP 有界 dispose(2s) , Harness 有界 dispose(8s) ] → modelProxy.stop → store.close`；每场景 `proxyStopped=true` 且 `storeClosed=true`（先停 Harness、后关库） |
| 有界退出 | **已完成** | 单项超时（`DISPOSE_TIMEOUT` / `HARNESS_DISPOSE_TIMEOUT`）或抛错只留痕；单测证明「MCP 抛错 / Harness 卡死都不跳过后面的 `proxy.stop` / `store.close`」；6 场景退出时长 **111–564ms** |
| 重复 quit | **已完成** | `quitting` 标志在 `preventDefault()` 之前同步置位；场景 D 连续两次 `app.quit()`：exit 0、终态唯一、0 孤儿 |
| 不伪造终态 | **已完成** | 退出只收资源、**0 处状态写入**：退出前库中 `RUNNING`（A/B/C/D）→ 重启后 `BLOCKED + RECOVERY_REQUIRED`；对照 E 正常成功仍 `SUCCEEDED`、F 用户取消仍 `CANCELLED`（都未被退出改写） |
| 真实 Electron 退出验收 | **86 / 86 PASS · exit 0 · 41s** | 6 场景 ×（退出码 / 时长 / 在途后代进程峰值 / 退出后孤儿 / 库可重开 / 库中状态 / 重启恢复）+ 旧能力请求被拒 + MCP 流关闭 + 全批残留自检 0 |
| 门禁（受影响） | **全部 exit 0** | `test:d5-03-exit` 86/86（41s）；`app-shutdown` 单测 5/5；`test:d4-02c` 33/33（47s，dsh 0.1.5-rc.2 / acp 1.4.0 / schema 21）；MCP 生命周期+流 17/17；boot 顺序 14/14 |
| 全量 `npm test` | **exit 1，如实单列** | **1399 tests / 1397 pass / 2 fail**（duration 139671ms）：两条**既有确定性失败**（`d4-03-approval-push-isolation` P2、`side-effect-c4-gates` No Direct Domain Bypass）**未修**；**无新增失败、无 flake、无 skipped**；1394 → 1399 = 本批新增单测 5 条 |
| 顺带修掉的真实缺陷 | **已完成** | 原实现 `disposeMcpBounded(...).then(() => app.quit())`：**在 `.then()` 微任务里再调 `app.quit()`，Electron 44 不会继续退出序列**（停在 `will-quit`、进程只能被外部杀）→ 最小复现两种模式对照（微任务 8.2s 挂死被 SIGKILL / 宏任务 1.29s exit 0）；修法 = 收尾完成后 `setImmediate` 里 quit + 3s 有界保险丝 `app.exit(0)` |
| 断言变更清单 | **无既有断言改动** | 无既有断言被修改 / 放宽 / 跳过；新增 `tests/app-shutdown.test.mjs` 5 条 + 真实退出驱动 86 条 |

## 2. 三轴判定（分列）

* **功能 = 通过（限定范围）**：6 场景真实 Electron 退出全部 exit 0 且有界；Harness 先收、proxy/store 后关；0 孤儿；旧能力被拒（原 baseUrl `ECONNREFUSED` + 能力账本 `REVOKED`）；MCP 服务端 `openStreams=0`；库 `integrity_check=ok` 且 `-wal` 0 字节；未完成任务重启后 `BLOCKED + RECOVERY_REQUIRED`；正常成功与用户取消两个对照未被改写。
* **视觉 = 本批不适用（如实披露）**：`src/**` 0 行改动，退出过程无界面变化；**未做截图**。
* **动效 = 本批不适用（如实披露）**：无动效改动。

## 3. notVerified 与缺口（如实登记）

* **notVerified 4 条**：① 未做界面截图（无界面改动）；② 退出保险丝 `app.exit(0)` 的触发路径未构造用例（正常收尾耗时可忽略，只在退出序列不推进时生效）；③ 崩溃 / SIGKILL / 断电退出（无 `will-quit` 机会）不在本批；④ 「旧能力请求被拒」用端口释放 + 能力账本共同证明（进程已退出，无法再发真实请求）。
* **本批新登记（不修，单列）**：**用户取消后 `runTask` promise 在有在途模型调用时不收敛**——场景 F 取消后 20s 内 `runTask` 仍未 settle，而 task / run 已是 `CANCELLED`；与 **R2** 同一片区域（取消路径 × 在途 model call）但证据不同（本次是 run promise 不收敛，R2 是 call 停在 `STARTED`）→ **建议与 R2 同批裁决**。
* **继续单列**：R2（未修）· 两条既有确定性失败（未修）· `START_MARGIN_MS` 与产品预算成对 · 跨组织真机 2 条 notVerified · 两条探针门禁既有失败（`governance-ui` 1/5、`model-keychain-restart` 3/15）· OAuth · 插件隔离（D5-08）· D5-02 `prompt()` 遗留 · SIGKILL 边界 · 历史调试 run 目录。
* **本批新增临时产物**：`experiments/d5-03/batch11/verify/runs/**`（隔离安装 / 数据库 / 日志，已 gitignore）；`/tmp/oa-quit*/**`（最小复现用的临时 Electron 应用）。

## 4. 判定与下一步

**判定：D5-03 第十一批（应用正常退出时收尾 Harness）= PASS（限定范围：will-quit 确实收尾 Harness，顺序 / 有界 / 不伪造终态 / 重复 quit 有真实 Electron 证据；并修掉 quit 微任务挂死）；R2 与新登记项如实单列；D5-03 整体仍 = PARTIAL。**

**本批闭环的旧缺口**：第十批登记的「应用退出路径未调用 `orchestrator.dispose()`」——已实施并验证（见 §1）。

剩余缺口逐条：① R2（取消后 call 停 `STARTED`，已定性为不同根因）另案【第十二批已实施：取消路径收敛 STARTED 的 call 为 CANCELLED + completed_at + 安全事件，历史 call 不改写；见第十二批节】；② 新登记：用户取消后 `runTask` promise 不收敛（建议与 R2 同批）【第十二批已实施：取消后只等 750ms 窗口，runTask 637–972ms 收敛；见第十二批节】；③ 两条既有确定性失败（`d4-03-approval-push-isolation` P2、`side-effect-c4-gates` No Direct Domain Bypass）另案；④ 上述 notVerified 4 条；⑤ `START_MARGIN_MS` 与产品预算同步约束；⑥ 跨组织真机 2 条 notVerified；⑦ 两条探针门禁既有失败；⑧ OAuth；⑨ 插件隔离（D5-08）；⑩ D5-02 `prompt()` 遗留；⑪ SIGKILL 边界；⑫ 第五批登记其余残留。

下一步建议：【第十二批已完成：R2 + 「取消后 runTask 不收敛」合并裁决与实施】原建议：R2 + 「取消后 runTask 不收敛」合并裁决（取消路径终结 model call 信封与 run 收敛）→ 两条既有确定性失败另案 → 两条探针门禁单独排期 → 跨组织真机入口 → OAuth → 真实第三方 / Adobe（D5-04 / D5-05）。

# D5-03 第十二批 · 用户取消在途模型调用后的完整收敛 · 2026-09-29（`10075b2`）

> **口径（用户明确定范围）**：本批只含 **R2**（取消后 model call 停在 `STARTED`）与**第十一批登记的 runTask promise 不返回**；**未进入 OAuth、D5-04、创建组织入口**。不调宽超时、不跳过测试、不放松断言。只在 `/Users/wepingli/Desktop/OpenArc OS-integration` 工作，未触碰主工作树 17 项改动、DSH Desktop 共享运行时与 `~/.dsh`，未 push。
> **判定：D5-03 第十二批（用户取消在途模型调用后的完整收敛）= PASS（限定范围：两项均红→绿，账本与事实一致、历史 call 不改写、副作用账本隔离、真实 Electron 取消路径验收通过；未验收项如实单列）；D5-03 整体仍 = PARTIAL**。
> **被测 commit**：`10075b2`（父 `63a8ed5`，单提交；提交时 `--amend` 一次仅并入验收驱动的残留清扫，产品代码未变）。改动面：`electron/harness-adapter.cjs` +40/−11、`electron/task-service.cjs` +36/−0、`electron/task-harness-orchestrator.cjs` +50/−11、`electron/task-domain.cjs` +2/−0、`tests/task-harness-cancel-convergence.test.mjs` +331/−0（新增）、`tests/fixtures/harness-acp/prompt-late-agent.mjs` +33/−0（新增）、`experiments/d5-03/batch12/verify/**` +1035/−0、`.gitignore` +3/−0；`src/**` **0 行改动**、`SCHEMA_VERSION` 仍 **21**、预算 `30000 / 180000` 未动。
> **证据**：`experiments/d5-03/batch12/verify/`（`00-red-matrix.json`、`01-green-matrix.json`、`02-gate-d4-02c.txt`、`03-convergence-suite.txt`、`03-related-gates.txt`、`04-npm-test-full.txt`、`05-electron-cancel.txt`、时序矩阵 / 真实 Electron 验收脚本 + Probe 宿主；`runs/**` 已 gitignore）；执行方报告 `experiments/d5-03/batch12/D5-03-BATCH12-REPORT.md`；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch12` 段（**纯插入**：`git diff --numstat` = `139 / 0`，旧段自 `"batch11"` 起至 EOF **逐字节相同**）。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| R2 · 取消后 call 停在 STARTED | **已完成** | `TaskService.cancelStartedModelCalls()`：与取消同一事务，只把**本任务仍为 STARTED** 的 call 写成 `CANCELLED` + `completed_at` + 安全事件 `model.call.cancelled`；六个取消时序全部 `CANCELLED`（红：六个时序全是 `STARTED`） |
| runTask 不返回 | **已完成** | ACP `session/cancel` 是通知（协议允许 agent 不回）→ prompt 侧在**用户真的取消过**之后只等 750ms 窗口，仍不回来即按真实取消收尾；取消→收敛 **637–972ms**（旧：>20s 不 settle，上限是 180s 执行预算） |
| 账本与事实一致 | **已完成** | 恰好一个 call 终态；`completed_at` 已写；`provider_error_code` **恒为空**（取消绝不写成 Provider 失败）；安全事件 `model.call.cancelled` 恰好一条；已 `SUCCEEDED` / `FAILED` 的历史 call 由 `#callCommand` 的 `status !== "STARTED"` 前置判定守住，**绝不改写**（用例 8 用真实 500 失败对照） |
| 用量证据保留 | **已完成** | 本 turn 观测到 usage 即记账，取消路径原样落库（**不声称 Provider 从未执行 / 从未计费**）；假 Provider 下 usage 恒为 null，该分支由直接单测覆盖 |
| 终态一致 + 重复取消幂等 | **已完成** | 任务 / 步骤 / run / call 四处一致；同刻竞争下绝不 `SUCCEEDED` 与 `CANCELLED` 并存；重复取消终态不翻转、call `completed_at` 不变、取消事件仍只一条 |
| 迟到结果不产生成功产物 | **已完成** | 迟到 turn 结果：0 产物、不新建 call / run、不翻转终态；adapter 侧对已取消 turn 不再影响后续 |
| 副作用账本隔离 | **已完成** | 独立 `side_effect_calls` 仍 `AWAITING_APPROVAL`：状态 / 完成时间 / 错误码 / 审批记录 / 执行记录全不动（用例 9） |
| 真实 Electron 取消路径 | **18 / 18 PASS · exit 0 · 6s · 只启动 2 次** | 取消走**真实渲染层** `window.openarc.task.command` → preload → IPC → 产品 handler；`callsFinalized` 非空、`elapsedMs 2861`；退出前在途子进程峰值 6、退出后 **0 孤儿**；只读重开库四处一致；真实重启后仍 `CANCELLED` |
| 门禁（受影响） | **全部 exit 0** | 收敛套件 9/9（51s）；`test:d4-02c` 33/33（60s）；`tool-dsh-cancel` + `d4-06-resume` + `d4-07-budget-consistency` + `tool-d4-03d-audit` 17/17（43s） |
| 全量 `npm test` | **exit 1，如实单列** | **1408 tests / 1406 pass / 2 fail**（duration 129852ms）：两条**既有确定性失败**（`d4-03-approval-push-isolation` P2、`side-effect-c4-gates` No Direct Domain Bypass）**未修**；**无新增失败、无 flake**；1399 → 1408 = 本批新增 9 条 |
| 断言变更清单 | **无既有断言改动** | 新增 9 条领域用例 + 真实 Electron 取消验收 18 条；新增探针 `prompt-late-agent.mjs` |

## 2. 根因与修法（两条缺一不可）

1. **账本从不在取消路径收尾**：`startModelCall` 建信封后只有成功 / 失败两条终态路径；用户取消走 `#finalizeCancelled` → `cancelHarnessRun` → `finalizeCancel`，三处都不碰 `task_model_calls`。
2. **乐观并发 token 过期**：取消竞态里 revision 连续推进，首次带旧 `expectedRevision` 的账本收尾被 `TASK_REVISION_CONFLICT` **静默拒掉**（实测 `rev0=7` 而当前 `10`）→ 冲突重读一次再收尾。
3. **adapter 等 agent 回话**：`session/cancel` 是通知 → 加 750ms 取消窗口；**没取消过绝不武装该窗口**（开发中真实踩到：未判断时正常慢 turn 被误判成取消，由 `tool-dsh-cancel` 的 kill-dsh 用例暴露并修复）。

## 3. 三轴判定（分列）

* **功能 = 通过（限定范围）**：七个时序（请求前 / 已收到 / 同刻竞争 / 永不回应 / 迟到 / 重复 / 成功对照）全部按判据通过；真实 Electron 取消路径经 preload→IPC 验收；账本四处状态一致并重开库核对；副作用账本隔离。
* **视觉 = 本批不适用（如实披露）**：`src/**` 0 行改动，无新增界面文案；未做截图。
* **动效 = 本批不适用（如实披露）**：无动效改动。

## 4. notVerified 与缺口（如实登记）

* **notVerified 5 条**：① 迟到「Provider 真实回包」未单独构造（用例 5 的迟到结果来自 agent 侧；「provider 已收到请求后取消」由用例 2 与真实 Electron 场景覆盖）；② 真实计费 / 实际 token 数不可观测（假 Provider 不返回 usage）；③ 假 Provider 下 usage 恒为 null，取消保留 usage 的分支只由代码路径与直接单测覆盖；④ 应用退出与取消的交叉未单独构造；⑤ 未做界面截图。
* **本批工具清理（如实登记）**：调试期间多次运行留下过 **24 个 Electron 探针进程**，已全部清除（当前 0 残留）；「按命令行标记清扫」已并入验收驱动，后续批次不再外溢。
* **继续单列**：两条既有确定性失败（未修）· `START_MARGIN_MS` 与产品预算成对 · 跨组织真机 2 条 notVerified · 两条探针门禁既有失败（`governance-ui` 1/5、`model-keychain-restart` 3/15）· OAuth · 插件隔离（D5-08）· D5-02 `prompt()` 遗留 · SIGKILL 边界 · 历史调试 run 目录。

## 5. 判定与下一步

**判定：D5-03 第十二批（用户取消在途模型调用后的完整收敛）= PASS（限定范围：R2 与 runTask 不返回两项均红→绿，账本与事实一致、历史 call 不改写、副作用账本隔离、真实 Electron 取消路径通过；未验收项如实单列）；D5-03 整体仍 = PARTIAL。**

**本批闭环的旧缺口**：第十批登记的 R2（取消后 call 停 `STARTED`）与第十一批新登记的「用户取消后 `runTask` 不收敛」——两项均已实施并验证（见 §1）。

剩余缺口逐条：① 上述 notVerified 5 条；② 两条既有确定性失败（`d4-03-approval-push-isolation` P2、`side-effect-c4-gates` No Direct Domain Bypass）另案；③ `START_MARGIN_MS` 与产品预算同步约束；④ 跨组织真机 2 条 notVerified；⑤ 两条探针门禁既有失败；⑥ OAuth；⑦ 插件隔离（D5-08）；⑧ D5-02 `prompt()` 遗留；⑨ SIGKILL 边界；⑩ 第五批登记其余残留。

下一步建议：两条既有确定性失败另案 → 两条探针门禁单独排期 → 跨组织真机入口 → OAuth → 真实第三方 / Adobe（D5-04 / D5-05）。

# D5-03 第十三批 · 执行边界按提供者收口并修 in-process 白名单绕过 · 2026-09-29（`312dc60`）

> **口径（用户明确定范围）**：本批只含**两条长期失败的 D4 门禁收口**（`side-effect-c4-gates` 的 `No Direct Domain Bypass`、`d4-03-approval-push-isolation` 的 `P2`）与**真实执行边界复核**；**未进入 OAuth、D5-04、创建组织入口**。不调宽超时、不跳过测试、不放松断言。只在 `/Users/wepingli/Desktop/OpenArc OS-integration` 工作，未触碰主工作树 17 项改动、DSH Desktop 共享运行时与 `~/.dsh`，未 push / 未 merge。
> **判定：D5-03 第十三批（两条 D4 门禁收口 + 真实执行边界复核）= PASS（限定范围：两条门禁红→绿且判据提高、负向自证必然变红并逐字还原、完整 `npm test` 全绿、真机画布 52/52；真机 D5-01 受控浏览器链**本批未取得**（`S0a` 既有失败，父提交 `48a867c` 上失败串逐字相同，故与本批无因果；**其回归时点未定位**），已如实登记为未取得项 + 剩余缺口）；D5-03 整体仍 = PARTIAL**。
> **被测 commit**：`312dc60`（`git rev-parse HEAD` 实测 `312dc606fee9d9c147a9d863fba7fe504961ab26`，与要求一致；父 `48a867c`，单提交）。改动面：`electron/side-effect-domain.cjs` +4、`electron/side-effect-runtime.cjs` +11/−5、`tests/d4-03-approval-push-isolation.test.mjs` +256、`tests/side-effect-c4-gates.test.mjs` +79、`experiments/d5-03/batch13/red/inprocess-bypass.mjs` +134；共 5 files / +482 / −7。**`src/**` 0 行改动**、`SCHEMA_VERSION` 与预算未动。
> **证据**：`experiments/d5-03/batch13/verify/`（`COUNTS.md` 汇总 + `10/11` 两门禁、`20/21/22/23` 回归、`30/31/32/33` 真机、`40` 全量、`50/51/52` 负向自证、`53` 正常路径、`54` 还原证明、`60` JSON 纯插入证明，全部含原始 stdout+stderr 与 `# EXIT CODE`）；执行方报告 `experiments/d5-03/batch13/D5-03-BATCH13-REPORT.md`；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch13` 段（**纯插入**：更正后的最终 `git diff --numstat` = `502 / 0`（首版为 `474 / 0`，更正只在 batch13 段内部增改）；自 `"batch12"` 起至 EOF sha256 = `e9dac4dca98dda0d1ab2b18ef3e1926ae65a7fa080f055f7373729f223c10767`，与 `git show 312dc60:docs/D5-03-GATE-EVIDENCE.json` 对应区段逐字节相同；`python3 -c "import json;json.load(...)"` 成功）。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 门禁 ① `side-effect-c4-gates` · `No Direct Domain Bypass` | **已完成（红→绿，判据提高）** | 旧 `18/19、1 fail`（失败句 `主进程绝不 in-process 执行 write`）→ **19/19 PASS、fail 0、exit 0**；旧绝对论断删除，改为 (a) 受监督路径行为正例 + (b) 行为级拒绝证明 + (c) 静态封闭白名单 + (d) 裁决顺序与 placement 审计 |
| 门禁 ② `d4-03-approval-push-isolation` | **已完成（红→绿，判据未降）** | 旧 `7/8、1 fail`（P2）→ **12/12 PASS、fail 0、exit 0**；`SNAPSHOT_FIELDS` 13 → 15 项（加 `targetRef`/`url`），封闭精确键集合比较由 1 处扩到 **7 处**，新增 N1–N4 正反例 |
| 真实产品缺陷 · `executeInProcess` 白名单绕过 | **已定性 + 已修** | 未修改代码时直接调公开方法 `executeInProcess` 对 `resource.trash`（`executionProvider=ResourceService`）：`ok=true`、`trash_state ACTIVE→TRASHED`、`registry active→deleted`、`deleteCalls 0→1`、`lease 0→1`、审计 `6→12`、`SUCCEEDED`、placement 谎报 `IN_PROCESS`；修后 `ok=false` / `0 mutation` / **lease 总数 0** / call 仍 `APPROVED` / 恰好 1 条 `DENY` 审计 |
| 负向自证（故意放宽 → 必须变红） | **三组全部变红并逐字还原** | A 静态 `19 tests / 16 pass / 3 fail / exit 1`（含 `No Direct Domain Bypass`）；A 行为 `verdict: RED_BYPASS_PROVEN` + 真实 mutation；B `12 tests / 8 pass / 4 fail`（失败者恰为 P2/N1/N2/N4）。还原后 sha256 = `8e7d269d…5777` 与提交内置版本一致、`git diff --exit-code` = 0 |
| 回归（node 级） | **全绿** | D5-01 六文件 **37/37**；D5-02 七文件 **48/48**；`side-effect-*` + `d4-03-*` **278/278**；`docs/D5-01-RESULT.md:79` 文档口径合并集 **60/60**（文档写 59/59 已过期，见 §4） |
| 真机 D5-02 画布 | **52 PASS / 0 FAIL / notVerified 0 / exit 0** | `env -u ELECTRON_RUN_AS_NODE node experiments/d5-02/canvas-e2e.mjs`，与基线 52/52 完全一致 |
| 真机 D5-01 受控浏览器链 | **本批未取得（既有失败）** | `test:d5-01-control` 三次运行均 `EXIT CODE: 2`，在 `S0a`（provider/model 安装段）失败 `{"pid":"","cid":"","defaultOk":false}`；**父提交 `48a867c` 的临时 worktree 上逐字相同失败** → 既有失败，与本批无因果。本批**没有**浏览器导航的真机 UI 证据 |
| 全量 `npm test` | **exit 0，全绿** | **1412 tests / 1412 pass / 0 fail / skipped 0**（120.2s）；第十二批 1408/1406/2 → 本批 1412/1412/0（+4 = 新增 N1–N4；−2 = 第十二批登记的两条既有确定性失败本批已修） |
| 断言变更清单 | **逐条登记，无整段删除、无判据降低** | 见 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch13.assertionChanges`（**20 条**：旧句 / 新句 / 契约依据 文件:行）与报告 §2 |

## 2. 根因与修法

1. **断言过时（真）**：`主进程绝不 in-process 执行 write` 是**绝对论断**，已被 D5-01 Closure-2 / D5-02 的**显式进程局部 in-process execution class** 取代（受控浏览器原生 `WebContentsView`、画布 `CanvasService` + 同一 SQLite 连接都只在 main）。
2. **产品确有缺陷（被旧断言掩盖）**：公开方法 `SideEffectRuntime.executeInProcess` **自身没有 execution placement 守卫**，placement 只由 `executeApproved` 分流保证 → 直接调用可在 main 进程真实执行 `ResourceService.delete` 并留下谎报 `IN_PROCESS / PROCESS_LOCAL_DOMAIN` 的审计。修法：方法体内在 `preflightAuthorization` 与 `acquireLease` **之前**按 `contract.executionProvider` 对静态白名单 fail closed，写恰好 1 条 `DENY` 审计、**不写 call 状态**（误路由不得把合法 call 打成 `BLOCKED` 而变成 DoS），新增错误码 `SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED`。
3. **审批投影断言过时（非泄露）**：`SNAPSHOT_FIELDS` 是产品封闭白名单的副本；D5-01 Closure-2 把 `targetRef`（目标标签身份）与 `url`（用户正在批准的那个地址）纳入**用户必须看到**的信息（UI 侧 `src/approval/ApprovalPrompt.tsx:186/:190` 确实渲染）。按现行契约更新，**字段集合仍是封闭精确集合**、比较处数从 1 增到 7。

## 3. 三轴判定（分列）

* **功能 = 通过（限定范围）**：两条目标门禁红→绿；真实执行边界按提供者收口（`ResourceService` 只能经受监督 executor，in-process 白名单是恰好 `BrowserControl + CanvasControl` 的静态封闭集合）；真机画布 52/52；全量 `npm test` 1412/1412/0；回归全绿；负向自证三组必然变红且逐字还原。
* **视觉 = 本批不适用（如实披露）**：`src/**` 0 行改动，无新增界面文案，未做截图。
* **动效 = 本批不适用（如实披露）**：无动效改动。

## 4. notVerified 与缺口（如实登记）

* **真机 D5-01 受控浏览器链未取得（本批最主要缺口）**：`test:d5-01-control` **当前不可达其浏览器场景** —— 安装段 `S0a` 在**父提交 `48a867c` 与本批上同样失败**且失败串逐字相同 → **与本批无因果**；其**失效 / 回归时点未定位**（未在 `f9564b7` 上复跑真机，仅能确认 `f9564b7` 是 `312dc60` 的祖先、且 D5-01 验收期记录为 46 PASS）。线索（**非已定位根因**）：dock 选择器 `data-app-id` 在 merge `7d707ab` 被删除（`f9564b7` 仍在 `src/main.tsx:361`），而 `experiments/d5-01/` 下三个 e2e 仍用它。**本批没有**"界面显示同一个待批准地址"的**真机 UI** 证据；该点可核查依据只有：(a) `src/approval/ApprovalPrompt.tsx:186` / `:190` 渲染的正是门禁 ② 现在逐字钉住的投影字段；(b) `src/**` 本批零改动，且三次 `npm run build` 产物主包哈希完全相同（`dist/assets/main-qXEiIhXD.js 373.56 kB`），被驱动的渲染层与父提交同源；(c) D5-01 验收期已通过的 S2.1/S2.2 记录。**修它需动 `src/settings/ModelSettings.tsx` 或 e2e 驱动，属 D5-01 门禁修复，不在本批范围**（需另开批次并走设计对齐）。检索 `docs/`、`PROGRESS.md`、`experiments/` 未发现此前登记过该失效。
* **其余 notVerified 7 条**（连同上面单列的「真机 D5-01」与「CanvasControl 覆盖归属更正」，`docs/D5-03-GATE-EVIDENCE.json` 的 `batch13.notVerified` 共 **9** 条）：① `url` 的 2000 截断上界未覆盖（N2 长地址仅 1533 字符）；② `targetRef` 的 300 上界无断言；③ `canvas.edit` 未进推送门禁专门断言；④ 推送目标窗口身份未验（`isTrusted` 恒 `true`）；⑤ `registry.get` 返回 `null` 时的新 fail-closed 行为无专门用例；⑥ in-process class 仍无独立 child 寿命证据（头注释已如实披露、未写"等价"）；⑦ N4 未对全部 `SAFE_SNAPSHOT_SECRET_RE` 键名做穷举注入。
* **环境登记（非产品缺陷）**：`node_modules/electron/dist/` 缺 `Electron.app` → 任何 `require("electron")` 触发自动下载器，GitHub CDN 实测约 **12 KB/s**（110MB 需 ~2.5h），使 `tests/d5-01-browser-policy.test.mjs` 表现为"挂住"；已用本机官方缓存 zip（sha256 `49b91ef2…5035`，与 `node_modules/electron/checksums.json` 期望值逐字节相符）经 `ditto -x -k` 修好（`node_modules` 被 `.gitignore` 忽略）。本会话 shell 继承 `ELECTRON_RUN_AS_NODE=1` 会让 `electron` 退化成纯 Node（带变量报 `v24.20.0`、`env -u` 后报 `v44.3.0`），真机链一律用 `env -u ELECTRON_RUN_AS_NODE` 运行 —— 这是**还原基线 shell**，不是放宽；**未**改产品代码或 `experiments/` 脚本去防御它。另：取证期间上级的并发诊断探针导致本批 `20-d5-01-regression.txt` 第 1 次运行被 **SIGKILL（exit 137）** 打断、作废，已冻结并发后重跑（第二次 37/37）。
* **CanvasControl 覆盖归属更正（独立验收 F-1）**：`CanvasControl` in-process 白名单的**行为覆盖点**是 `tests/d5-02-canvas-edit-proposal.test.mjs`（经 `executeApproved` 走 in-process；被破坏后 4/3/1 红、`EXECUTOR_FAILED`），**不是** `tests/d5-02-canvas-tool.test.mjs`（只覆盖 adapter 层），也**不是** `tests/d5-01-browser-inprocess-boundary.test.mjs`（只覆盖 BrowserControl）—— 删掉 `CanvasControl` 后这两个文件实测**无变化**。
* **独立验收 F-2（证据等级）**：`verify/32-…` 证明"跑在 `48a867c` 上"的显式依据是撰写的前置注释行；**运行期原始旁证**是中止栈里的真实路径 `file:///private/tmp/oa-b013-base/…`（`30-…`/`33-…` 则是 `file:///Users/wepingli/Desktop/OpenArc%20OS-integration/…`）。独立验收裁定该证据**可信**，建议后续把真机证据的前置事实直接放进 raw 捕获块。
* **独立验收 F-3（探针口径）**：`red/inprocess-bypass.mjs:110` 的 `guardHeld` 用 `activeLeaseCount`（只数 ACTIVE），门禁 `tests/side-effect-c4-gates.test.mjs:524` 用 `leasesOfCall().length`（全部 lease）→ **探针口径略宽于门禁**；处置：**探针是探索性工具、门禁判据更严，不改探针**（红/绿结论不受影响）。
* **独立对抗性验收已完成**：独立验收岗（与执行方无关联、全新上下文）独立复现全部计数（19/19、12/12、6/6、4/4、1412/1412/0）、用三组**不同**破坏方式完成负向自证（整段删守卫 / 只移动守卫位置 / 加 `actorUserId`，全部变红且逐字还原）、并独立复现父提交 `48a867c` 上的修前红（18/19/1、7/8/1）与红/绿双状态；报告 `experiments/d5-03/batch13/verify/BATCH13-VERIFY-REPORT.md`。**未发现本批执行方任何不成立或夸大的声明**；其"真机 D5-01 与本批无因果"的独立裁定 = 成立。
* **文档计数过期（建议后续同步）**：`docs/D5-01-RESULT.md:79` 的 `59/59` 已过期（现为 **60/60**）—— 该文档末次提交 `f93e835` 时 `tests/window-manager.test.mjs` 为 16 条，`f9564b7` 增为 17 条（该文件在 `f9564b7..312dc60` 之间只有断言口径更新）；把 `f9564b7` 的这 5 个文件放进隔离宿主复算同样是 60 条。本批**未触碰**这 5 个文件 → **非产品回归**。
* **继续单列**：跨组织真机 2 条 notVerified · 两条探针门禁既有失败（`governance-ui` 1/5、`model-keychain-restart` 3/15）· OAuth · 插件隔离（D5-08）· D5-02 `prompt()` 遗留 · SIGKILL 边界 · 第五批登记其余残留。

## 5. 判定与下一步

**判定：D5-03 第十三批（两条 D4 门禁收口 + 真实执行边界复核）= PASS（限定范围：两条门禁红→绿且判据提高、负向自证必然变红并逐字还原、完整 `npm test` 全绿、真机画布 52/52；真机 D5-01 受控浏览器链本批未取得（`S0a` 既有失败，父提交上失败串逐字相同；**其回归时点未定位**），已如实登记为未取得项 + 剩余缺口）；D5-03 整体仍 = PARTIAL。**

**本批闭环的旧缺口**：第十二批登记的「两条既有确定性失败」（`d4-03-approval-push-isolation` P2、`side-effect-c4-gates` No Direct Domain Bypass）——两条均已修复并转绿，且 `side-effect-c4-gates` 旧断言掩盖的**真实 in-process 白名单绕过缺陷**已定性、已修、已负向自证。

剩余缺口逐条：① 真机 D5-01 受控浏览器链门禁不可达（`S0a` 失败；**回归时点未定位**，`data-app-id` 选择器被 merge `7d707ab` 删除是线索而非已定位根因；需另开批次做 D5-01 门禁修复 + 设计对齐）；② 上述 notVerified 8 条（含独立的 CanvasControl 覆盖归属更正项）；③ `docs/D5-01-RESULT.md:79` 的 59/59 计数过期需同步为 60/60；④ E1 登记的 4 项计数型/文本定位型维护约束（白名单恰好 1 处、`.has(` 恰好 2 处、(d) 注释文本定位、成员必须字符串字面量）；⑤ 环境登记两项（electron dist 修复、`ELECTRON_RUN_AS_NODE` 需调用方剥离）；⑥ 跨组织真机 2 条 notVerified；⑦ 两条探针门禁既有失败；⑧ OAuth；⑨ 插件隔离（D5-08）；⑩ D5-02 `prompt()` 遗留；⑪ SIGKILL 边界；⑫ 第五批登记其余残留。

下一步建议：定位并修 `test:d5-01-control` 的 `S0a` 失败（设置界面漂移为线索、回归时点未定位；另开 D5-01 门禁修复批次）→ 补 `url` 2000 / `targetRef` 300 / `canvas.edit` 推送 / 推送目标窗口身份 / `registry.get` null 用例 → 两条探针门禁单独排期 → 跨组织真机入口 → OAuth → 真实第三方 / Adobe（D5-04 / D5-05）。

# D5-03 第十四批 · D5-01 真机门禁安装段修复（陈旧 Dock 选择器 + 入口缺失立即失败）· 2026-09-30（`ac019a5`）

> **口径（用户明确定范围）**：本批只含**一件事** —— 修复 D5-01 真机门禁 `test:d5-01-control` 的安装段 `S0a`/`S0b` 失败，让门禁真正跑到浏览器 S1–S6。**不调宽超时、不跳过场景、不放宽/删除任何安全判据、不把 FAIL 改成 NOT VERIFIED、不预写数据库**。只在 `/Users/wepingli/Desktop/OpenArc OS-integration` 工作，未触碰主工作树 17 项改动、DSH Desktop 共享运行时与 `~/.dsh`，未 push / 未 merge / 未 commit（提交由上级统一做）。**本批只改驱动脚本，产品代码 / 测试代码 / 设计文档零改动。**
> **判定：D5-03 第十四批（D5-01 真机门禁安装段修复）= PASS（限定范围：`test:d5-01-control` 安装段 S0a/S0b/S0c 与浏览器场景 S1–S6 全部真机通过，**46 PASS / 0 FAIL / 2 NOT VERIFIED，EXIT=0**，与 D5-01 验收基线 46/0/2 逐项一致；根因经真机实测判定为**驱动过时**、产品代码零改动；回归 D5-01 单测 37/37、boundary 32/0/1、`npm test` 1412/1412/0 全绿；fail-fast 语义经独立对抗性验收实测成立、逐行审查未发现放宽换绿）。**D5-03 整体仍 = PARTIAL，且不因此批而通过** —— `test:d5-01-visibility` 仍 FAIL（**22 pass / 3 fail / 25 total / 1 NOT VERIFIED**），其 `V9`/`V11`/`V12b` 所测**产品行为在本机仍未被验证**（FAIL 时驱动一次点击都没发）。**
> **被测 commit**：`ac019a5`（`git rev-parse HEAD` 实测 `ac019a598d29284e449aae7a90210fda60d56195`；父 `ae17ae9`，单提交）。改动面：`experiments/d5-01/browser-control-e2e.mjs` 9、`browser-inprocess-boundary-e2e.mjs` 9、`visibility-e2e.mjs` 9、新增只读诊断探针 `s0a-diagnose.mjs` +265；共 **4 files / +286 / −6**。**`src/**`、`electron/**`、`tests/**`、`package.json` 与设计文档零改动。**
> **证据**：`experiments/d5-03/batch14/`（`20` 核心门禁、`30/40/70` 回归、`50/51` visibility 两次、`60/61` 主门禁两次、`diagnose/10-*` 只读诊断，全部含原始 stdout+stderr 与退出码）；执行方汇总报告 `experiments/d5-03/batch14/D5-03-BATCH14-REPORT.md`；执行岗详细报告 `…/D5-03-BATCH14-E1-REPORT.md`；独立对抗性验收 `…/verify/BATCH14-VERIFY-REPORT.md`（**他人产出，本批未改写**）；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch14` 段（**纯插入**：`git diff --numstat` = `336 / 0`；自 `"batch13"` 起至 EOF 与 `git show ac019a5:docs/D5-03-GATE-EVIDENCE.json` 对应区段**逐字节相同**、两侧 sha256 均 `cd9db2206c28e1a7681feb19b2dcc196ef35ab754856db683f3927ff5a679b76`、len 均 `359108`；`python3 -c "import json;json.load(...)"` 成功）。

## 0. 证据溯源口径（取证时工作树 ↔ 被测 commit `ac019a5`）——必读

本批全部真机/回归证据都取自**提交前的工作树**：当时 `git rev-parse HEAD` = `ae17ae9`，因此每个原始输出头部的 `### HEAD: ae17ae9da17a475f267241fae0d56804db2794d2` 即当时真实值、**未事后改写**；被测代码随后由上级提交为 `ac019a5`。

**等价性自证**：`git diff --name-status ae17ae9 ac019a5` **恰好只列 4 个文件**（`M browser-control-e2e.mjs`、`M browser-inprocess-boundary-e2e.mjs`、`A s0a-diagnose.mjs`、`M visibility-e2e.mjs`），与取证时工作树相对 `ae17ae9` 的改动**是同一批**，此后未再改动；逐文件 blob 哈希两侧一致（`3af6d489…8ed` / `8a6186ca…59b` / `7570c4b8…32b` / `f15bd3b3…611`）→ **取证时的工作树内容 = 被测 commit 的对应文件（逐字节）**，证据归属成立。
**受保护路径为空**：`git diff --stat ae17ae9 ac019a5 -- src/ electron/ tests/ package.json DESIGN_SYSTEM.md MOTION_SYSTEM.md PLAN.md` 输出为**空**（本批未改产品、测试与设计文档）。

## 1. 任务状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 真机实测定位（先诊断，未改代码） | **已完成** | 只读诊断探针 `experiments/d5-01/s0a-diagnose.mjs`（与门禁同源启动、隔离 userData、仅默认 CDP 端口不同 9793 / 9790）：Dock 12 项含 `settings`；`[data-dock-id="settings"]` `!!el=true`、`click()` → **`"ok"`**、点击后设置窗口**真实打开**（pane `["appearance","model","devices"]`）；`document.querySelectorAll('[data-app-id]').length` = **0**、旧选择器 `!!el=false`、`click()` → **`"missing"`**；S0a 全部选择器按 tab 实测**缺失集 `[]`**；pageerror **0** / console error **0** |
| 根因判定 | **驱动过时（非产品缺陷）** | `src/` 中 `data-app-id` **0** 处，`src/desktop/components.tsx:334` 渲染 `data-dock-id`（引入 `b6b5aa1`）；失败机理：`click('[data-app-id="settings"]')` 返回 `missing` 但**返回值被丢弃** → 后续 `waitSel(…,20000)` 全部空转超时 → `pid=""/cid=""/defaultOk=false`，直到最后才以 S0a FAIL 暴露、看不出原因。**已知线索被证实，且独立定位到它就是首个失败点。** |
| 最小修复 | **已完成（3 个驱动，+286/−6）** | 三驱动各 2 处选择器替换 + 立即失败守卫 `mustClick`/`mustClickDom`（`r !== "ok"` 即 `throw new Error("入口点击失败：" + label + " " + sel + " → " + r)`）；现有 `main()` 外层 `try/catch` → 抛错即 **EXIT=2** 并指名选择器。未放宽/删除任何判据 |
| 门禁 `test:d5-01-control` | **PASS — 46 PASS / 0 FAIL / 2 NOT VERIFIED，EXIT=0** | `20-control-after-fix.txt`；**S0a** PASS `{"pid":"prv_1LuZ0Zlp7xnB9g","cid":"mcf_VHZI_oISpsuyJQ","defaultOk":true}`、**S0b** PASS `Endpoint:PASS Credential:PASS Model:PASS Inference:PASS Capabilities:NOT VERIFIED`、**S0c** PASS；**S1–S6 真实跑完未提前中止**（S1 7/0、S2 8/0、S3 5/0、S4 4/0、S5 4/0、S6 5/0）；与基线 **46/0/2 逐项一致** |
| S2 审批三处一致 | **成立（实际值逐项对照）** | UI `[data-approval-url]` = 批准记录 `preconditions_safe.url` = 真实视图落地 = **`http://127.0.0.1:5391/page2`**（marker `PAGE2-MARKER-9f3a`）；UI `[data-approval-target]` 含 **`browser#t1`** = `preconditions_safe.targetRef`（`targetType=browser-tab`）= 主进程授权 viewId；S2.5 `{"status":"SUCCEEDED","verification":"PASS","leases":1}` |
| 回归（node 级） | **全绿** | D5-01 六文件 **37/37**；`test:d5-01-boundary` **32/0/32 + 1 NV，EXIT=0**；`npm test` **1412/1412/0，EXIT=0** |
| fail-fast 语义 | **独立对抗实测成立** | 独立验收注入 `[data-dock-id="settings-NOPE"]` → **EXIT=2**、错误指名选择器、**运行段仅 1.10s**（未退化成 20s 超时；阴性比阳性更快正是 fail-fast 签名） |
| `test:d5-01-visibility` | **未通过（如实登记，未改其判定）** | **22 pass / 3 fail / 25 total / 1 NOT VERIFIED**（第 1 次更在 V4 截图处异常中止 EXIT=2）。3 项 FAIL = `V9`/`V11`/`V12b`，全部 `reason="not-frontmost:…"`，前台 layer-0 首位始终是 Google Chrome（pid 83502），驱动**拒绝发送真实点击**（`screen-geometry.mjs:192` 判据 / `:203` 返回），其安全判据在正确工作 |
| `test:d5-01` 主门禁 | **第 1 次 EXIT=2、复跑 64/0/64 PASS** | 第 1 次在 `A04-10` 抛 `Cannot read properties of undefined (reading 'includes')`（`browser-e2e.mjs:487`）。该文件与 `src/` 均与 `ae17ae9` **逐字节相同** → **非本批引入**；但**复现频次未知**（独立验收 4/4 未复现） |

## 2. 真机实测根因与修法

**根因 = 驱动过时。** 产品侧入口、窗口、3 个 pane、全部 D4-01 控件均正常（0 pageerror / 0 console error），
唯一失效点是驱动里的旧选择器 `[data-app-id="settings"]`（产品树中 0 处）；
且原驱动**丢弃 `click` 返回值**，把"入口缺失"退化成 20s 超时后"看不出原因"的 S0a FAIL。

**修法（最小、加严）**：三驱动各把 2 处入口点击换成真实选择器并改用 `mustClick`/`mustClickDom`；
助手在返回值不是 `"ok"` 时**立刻抛错并写明选择器与返回值**。净效果是**加严而非放宽**。

**修前证据（红）**：batch13 三次真机运行均 `S0a` FAIL，失败串**逐字相同** `实际 {"pid":"","cid":"","defaultOk":false}`、均 `EXIT CODE: 2`、**S1–S6 一次都未执行**（非确定性的只是失败之后的下游崩溃点 `:255` vs `:297`，属连锁反应）。

## 3. 三轴判定（分列）

* **功能 = 通过（限定范围）**：`test:d5-01-control` 安装段 S0a/S0b/S0c + 浏览器 S1–S6 真机通过 **46/0/2，EXIT=0**，与基线逐项一致；S2 三处一致；回归 37/37、32/0/1、1412/1412/0 全绿；fail-fast 语义独立实测成立。
* **视觉 = 本批不适用（如实披露）**：`src/**` 0 行改动，无新增界面文案，未做截图，**无新增视觉验收**；沿用 D5-01 既有已验收基准。
* **动效 = 本批不适用（如实披露）**：无动效改动，未录屏。

## 4. notVerified 与缺口（如实登记）

* **`test:d5-01-visibility` 未通过（本批最主要缺口）**：**22 pass / 3 fail / 25 total / 1 NV，EXIT=1**。
  其**已验收基线**是 CLOSURE4 的 **25 PASS / 0 FAIL / 1 NV（exit 0）**（`docs/D5-01-CLOSURE4-RESULT.md:100`、`docs/D5-01-CLOSURE4-EVIDENCE.json` 的 `gates[0]`，commit `f9564b7`）。
  **本批不主张对 visibility 有任何改善**；能确证的只有：安装段 `V0`/`V1`/`V2` 全 PASS，说明同一处入口选择器修复在该脚本上**同样生效**。
  **关键缺口**：FAIL 时驱动**一次点击都没发**，所以 **`V9`（缩放后真实指针命中）/ `V11`（四边近边界命中）/ `V12b`（最大化后还原回原几何）所测的产品行为在本机仍未被验证**；闭环条件 = 一次**独占前台**的窗口期重跑。
  **口径更正（独立验收 F1）**：batch13 **从未运行过 visibility 门禁**，此前"batch13 记录 8 项 FAIL → 本次 3 FAIL"的对照**不成立**（那是 `test:d5-01-control` 在 `48a867c` 上的结果，属跨门禁混用），已删除。
  **归因更正（独立验收 F2）**：第 1 次硬中止**不是** macOS 权限限制 —— 独立验收只读复测全屏 `screencapture` 成功、窗口定向 `screencapture -l 160240` 成功、需辅助访问的 `osascript` 取窗口尺寸成功；当时的 `-1719` 是**一次性 TCC 拒绝**、`could not create image from window` 是**前台/backing-store 争用**。归因是**前台争用**，不是权限缺失。
* **`test:d5-01` A04-10 的成因与频次未查明（F3/F4）**：`browser-e2e.mjs:487` 对可能为 `undefined` 的对象直接调 `.includes`，`waitView` 15s 超时 → `TypeError` **中止整段**，**A04 之后的 restore 段根本没跑** —— 它把一个**可能是真实产品症状**的信号（重新登录 + 导航 `/cookie` 后视图 15s 内未出现）变成脚本 TypeError。**归因"非本批引入"成立**（文件与 `src/` 逐字节相同），但**复现频次未知**（独立 4/4 未复现）。**本批不改它**（另一个门禁的驱动，超出授权范围）。
* **F6（低）已知限制**：安装段**其余**入口点击（`[data-d4-01-provider-create]`、`[data-d4-01-model-create]` 等）**未加即时失败守卫**，"入口缺失立即明确失败"目前**不普适**。**上级裁定不做代码改动**（达标判据已满足、该发现为 Low、且给已独立验证过的代码加东西会作废那次验证）；建议未来用只断言存在性的 `mustExist` 并做 ≥2 次连续复跑防 flake。
* **F5（低）使用注意事项**：`mustClick` 若被漏掉 `await`，失败路径会走 **unhandled rejection**（仍立即非 0 且指名选择器、**不会误报成功**），但绕过驱动的 `catch`/清理，**留下孤儿 electron 占住 CDP 端口**（独立验收已复现 `pid 15771 @9790` 并清理）。新加调用必须 `await`。
* **F7（低）既有判据口径**：`S0b` 是**子串匹配**，产品自报 `Capabilities:NOT VERIFIED` 时门禁仍判绿（**既有、非本批、不构成换绿**）；本批不改。
* **F8（低）措辞遗留**：`s0a-diagnose.mjs` 头注释称"启动方式完全一致"，实际默认 CDP 端口不同（9793 vs 9790）；报告口径已改为"同源、仅默认端口不同"，**脚本注释本身未改**（代码已冻结在 `ac019a5`）。
* **同类陈旧选择器仍在别的门禁探针里**（本批未验证、未修改，仅列清单）：`tests/d4-main-e2e.mjs:284`；`tests/fixtures/model-isolation|model-settings|model-secret-ui-probe`（`settings`）；`tests/fixtures/resource|resource-library|resource-search|resource-preview-ui-probe`（`resource-library`）；`tests/fixtures/governance-ui-probe:82/117/136`。
* **门禁自报的 2 项 NOT VERIFIED 依旧**：崩溃/强杀后浏览器控制目标恢复（契约外）、像素级层级真值（无法独占前台截图，层级由 domain 常量 + DOM/视口几何断言覆盖）。
* **独立对抗性验收已完成**：独立验收岗（全新上下文、与执行方无关联、默认立场怀疑）报告 `experiments/d5-03/batch14/verify/BATCH14-VERIFY-REPORT.md`，独立判定**本批通过**：独立复现全部计数（control **2/2** 均 46/0/2 EXIT=0、单测 37/37、boundary 32/0/1、`npm test` 1412/1412/0、主门禁 **4/4** 均 64/0/1）、**自己解析 `actual` 原值**确认 S2 三处一致、独立重跑诊断 **2 次**且其 `findings.json` 与原件**逐行比对 105 行全同无一行 DIFF**、fail-fast 对抗实测成立（EXIT=2 + 运行段 1.10s）、逐行审查全 diff **未发现任何"靠放宽换绿"**、驱动**逐字还原**。它提出的 3 点不成立/不准确（F1、F2、F3/F4）**已全部接受并在本批文档中更正**。
* **继续单列**：跨组织真机 2 条 notVerified · 两条探针门禁既有失败（`governance-ui`、`model-keychain-restart`）· OAuth · 插件隔离（D5-08）· D5-02 `prompt()` 遗留 · SIGKILL 边界 · 第五批登记其余残留。

## 5. 判定与下一步

**判定：D5-03 第十四批（D5-01 真机门禁安装段修复）= PASS（限定范围：`test:d5-01-control` 安装段 S0a/S0b/S0c 与浏览器场景 S1–S6 全部真机通过，46 PASS / 0 FAIL / 2 NOT VERIFIED，EXIT=0，与基线 46/0/2 逐项一致；根因经真机实测判定为驱动过时、产品代码零改动；回归 37/37、boundary 32/0/1、`npm test` 1412/1412/0 全绿；独立对抗性验收通过且未发现放宽换绿）。D5-03 整体仍 = PARTIAL，且**不因此批而通过**（visibility 仍 22/3/25；V9/V11/V12b 所测产品行为在本机仍未被验证）。**

**本批闭环的旧缺口**：第十三批登记的「真机 D5-01 受控浏览器链**未取得**（`S0a` 既有失败，**回归时点未定位**，`data-app-id` 选择器是线索而非已定位根因）」—— 本批**已真机实测定位并修复**：线索成立（`src/` 中 `data-app-id` 0 处、`[data-dock-id="settings"]` 可用），门禁现已跑到 S1–S6 并全部通过。

**本批不主张的部分**：① 对 `visibility` 无任何改善主张；② 未解决 F3–F8 任何一条（均按裁定登记，不做代码改动）；③ `V9`/`V11`/`V12b` 所测产品行为仍未被验证。

剩余缺口逐条：① visibility 的 `V9`/`V11`/`V12b` 需独占前台重跑闭环或如实判红；② `test:d5-01` A04-10 触发条件与频次未查明（F3/F4）；③ 安装段其余入口点击无即时失败守卫（F6）；④ `tests/d4-main-e2e.mjs` + 8 个 `tests/fixtures/**-probe` 的同类陈旧选择器；⑤ 2 项 NOT VERIFIED 依旧；⑥ `mustClick` 必须 `await` 的注意事项（F5）；⑦ `S0b` 子串判据（F7）；⑧ `s0a-diagnose.mjs` 注释端口口径（F8）；⑨ 上游遗留（跨组织真机 2 条、两条探针门禁既有失败、OAuth、插件隔离 D5-08、D5-02 `prompt()` 遗留、SIGKILL 边界、第五批登记其余残留）。

下一步建议：① 找一次**独占前台**的窗口期重跑 `test:d5-01-visibility`，把 `V9`/`V11`/`V12b` 的产品行为闭环或如实判红；② 单开一批处理 `browser-e2e.mjs:487`（先取 `cookie` 再判空并记 FAIL），让门禁如实暴露被掩盖的信号；③ 单开一批统一核对 `tests/` 下同类陈旧 `data-app-id` 探针；④ 若要推广"入口即时失败"，用 `mustExist` 只断言存在性并做 ≥2 次连续复跑防 flake；⑤ 收紧 `S0b` 判据（把 `Capabilities` 结论也纳入）。

---

# D5-03 第十五批 · D5-01 visibility 未验收项闭环（V9 / V11 / V12b 真机实测）· 2026-10-01（`2d50986`）

> **口径（上级明确定范围）**：本批只含**一件事** —— 在**独占前台**的窗口期内重跑 D5-01 visibility 真机门禁 `test:d5-01-visibility`，把上一批（batch14 · `ac019a5`）登记为**未验收**的 `V9` / `V11` / `V12b` 真机闭环。**不改任何代码 / 判据 / 阈值 / 仪器，不跳过场景，不放宽安全闸，不把 FAIL 改成 NOT VERIFIED，不预写数据库**。只在 `/Users/wepingli/Desktop/OpenArc OS-integration` 工作，未触碰主工作树、DSH Desktop 共享运行时与 `~/.dsh`，未 push / 未 merge / 未 rebase / 未 amend / **未 commit**。**本批无代码改动（路径限定，独立验收 F1 更正）**：`git diff --stat -- src/ electron/ tests/ experiments/d5-01` 为空；`git diff --stat` 本身**非空**，只有 `PROGRESS.md` 与 `docs/D5-03-GATE-EVIDENCE.json` 两处**文档**改动。
> **判定：本批（D5-01 visibility 未验收项闭环）= PASS（限定范围：两轮独立真机运行均 25 PASS / 0 FAIL / 25 total / 1 NOT VERIFIED，EXIT=0，与 CLOSURE4 基线 25/0/1 **汇总一致且 25 条断言名单未变** —— 据此推出逐条判定口径未变，**不是**逐条快照比对，基线逐条快照未冻结；`V9`/`V11`/`V12b` 由未验收改为**已验收**，其中 **V11 8/8 落点全部成功发出真实点击、全部 attempt=1、误差 0px**；安全闸全程零拒绝）。**D5-03 整体 = PARTIAL**（其余批次范围内项目未完成）。**
> **被测代码树**：`2d50986`（`git rev-parse HEAD` 实测 `2d50986be46515678ad61494b09a4701565f8716`；父 `ac019a5`）。`2d50986` 是**文档提交**（`git show --stat 2d50986` 只列 `PROGRESS.md`、`docs/D5-03-GATE-EVIDENCE.json`、`experiments/d5-03/batch14/**`，**不含 `src/`、`electron/`、`tests/`、`package.json`、`experiments/d5-01/**`**）→ 本批被测代码 = `ac019a5` 的产品代码（逐字节相同），**本批不产生新提交**。
> **证据**：`experiments/d5-03/batch15/`（`00` 运行前事实、`10/11` 两轮真机原始 stdout+stderr、`artifacts/run1|run2-visibility-e2e.json`、`artifacts/run1|run2-visibility-frames/` 各 18 张、`verify/01~06` 整理、`verify/captured/payload-001-2955.json` 只读补齐）；执行方汇总报告 `experiments/d5-03/batch15/D5-03-BATCH15-REPORT.md`；执行岗详细报告 `…/D5-03-BATCH15-E1-REPORT.md`；tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch15` 段（**纯插入**：`git diff --numstat` = `628 / 0`，删除列 0；自 `"batch14"` 起至 EOF 与 `git show 2d50986:docs/D5-03-GATE-EVIDENCE.json` 对应区段**逐字节相同**、两侧 `len` 均 `295050`、sha256 均 `44f957e8c67b85f9a4812ae8be908e6bd79daaae7eb18729c2a3a9f8561ca957`；`python3 -c "import json;json.load(...)"` 成功）。

## 0. 运行环境与「无代码改动」自证

| 项 | 值 |
| --- | --- |
| 工作树 / 分支 | `/Users/wepingli/Desktop/OpenArc OS-integration` / `integration/ui-core` |
| HEAD | `2d50986be46515678ad61494b09a4701565f8716` |
| node / electron | `v22.22.3` / `44.3.0` |
| 真机命令 | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-visibility`（= `npm run build && node experiments/d5-01/visibility-e2e.mjs`） |
| 前台（运行前） | run1 = `ChatGPT`(24060) → 运行后 `Claude`(18158)；run2 = `Claude`(18158) → `Claude`(18158) |
| 并发 | 两轮**串行**；运行前进程扫描**无 electron 真机实例、无 `node --test`、无 `npm test`**（只有与本轮屏幕无关的常驻 `coze-bridge-daemon`、MCP 服务与 `agent-browser` 守护进程） |
| 隔离实例 | 每轮门禁自拉全新 Electron（mkdtemp 隔离 userData、隔离 CDP 端口 **9794**；run1 pid 25293 / win 162275，run2 pid 28497 / win 162294） |

**无代码改动自证（路径限定，独立验收 F1 更正）**：`git diff --stat -- src/ electron/ tests/ experiments/d5-01` = **空**；`git diff --stat` 本身**非空**，只有 `PROGRESS.md`（82 +）与 `docs/D5-03-GATE-EVIDENCE.json`（628 +）两处**文档**改动；`git status --porcelain` = `M PROGRESS.md` / `M docs/D5-03-GATE-EVIDENCE.json` / `?? experiments/d5-03/batch15/`（取证阶段尚未写这三份文档时 `git diff --stat` 确实为空）。

## 1. 两轮 counts / EXIT 与逐条对照

| 轮次 | 命令 | counts（pass/fail/total） | notVerified | EXIT | 原始输出 |
| --- | --- | --- | --- | --- | --- |
| run1（**纯运行，无预载**） | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-visibility` | **25 / 0 / 25** | 1 | **0** | `batch15/10-visibility-run1.txt` |
| run2（同一门禁 + 只读证据补齐预载） | 同上 + `NODE_OPTIONS=--import=<无空格符号链接入口>` | **25 / 0 / 25** | 1 | **0** | `batch15/11-visibility-run2.txt` |

* 两轮**逐条 status 完全相同**（25 条同名同状态，差异 0 条）。把隔离实例 pid / window id 归一化后逐字符比对，**唯一 `actual` 数值差异是 `V10` 的四帧 PNG 字节数**（PNG 压缩字节逐次微变；V10 只判"每帧真实落盘且 >5000 字节"，两轮均 PASS）。比对原文：`batch15/verify/06-run1-run2-normalized-diff.txt`（`逐条 status 相同: true`、差异条目数 = 1）。
* 唯一的 1 项 `NOT VERIFIED` 两轮相同：**页面缩放（Cmd +/-）** —— 门禁**固有不计入必需项**的既有登记项（D5-01 原始必需项不含页面缩放，PLAN 里的"缩放"指窗口缩放、已由 V9 覆盖），**不是本批新增未验收项**，本批不放宽、不改写该登记。

## 2. `V9` / `V11` / `V12b` 逐项结论（由「未验收」改为「已验收」）

* **`V9`（缩放后真实指针仍命中）= PASS**：窗口 `1440×940 → 1180×740`；重测 viewRect `{left:308,top:338,w:830,h:321}`；`click.ok=true`、**`attempt=1`**；`last={x:190,y:185,target:"paint-btn"}` = 目标落点，**误差 0px**（判据 ≤8px）；`V9b` 截图 `2360×1480 = 1180×740×2`（比例一致）。
* **`V11`（四边近边界命中）= PASS，8/8 落点全部成功发出真实点击**（数据源 `batch15/verify/captured/payload-001-2955.json`，未截断、8 落点齐全；**该逐落点原始值仅 run2 有** —— run1 无预载、被 `record()` 截到 2400，**落点 7「右下角内」在 run1 无任何原始值**，run1 的 8 落点结论由门禁进程内对 8 项 `edgeOk` 求值 + 该 check PASS 支撑；`page` = 网页内坐标、`screen` = 屏幕 pt，`dx/dy = last − page`）：

| 落点 | page | screen | pixel | pixelGreen | click.ok | reason | last | dx/dy | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 上边中点 | (415, 3) | (723, 341) | `56,123,83` | true | true（attempt=1） | — | (415,3) `HTML` | 0/0 | PASS |
| 下边中点 | (415, 317) | (723, 655) | `56,123,83` | true | true（attempt=1） | — | (415,317) `BODY` | 0/0 | PASS |
| 左边中点 | (3, 161) | (311, 499) | `56,123,83` | true | true（attempt=1） | — | (3,161) `BODY` | 0/0 | PASS |
| 右边中点 | (826, 161) | (1134, 499) | `56,123,83` | true | true（attempt=1） | — | (826,161) `BODY` | 0/0 | PASS |
| 左上角内 | (24, 24) | (332, 362) | `56,123,83` | true | true（attempt=1） | — | (24,24) `title` | 0/0 | PASS |
| 右上角内 | (806, 24) | (1114, 362) | `56,123,83` | true | true（attempt=1） | — | (806,24) `title` | 0/0 | PASS |
| 左下角内 | (24, 297) | (332, 635) | `56,123,83` | true | true（attempt=1） | — | (24,297) `BODY` | 0/0 | PASS |
| 右下角内 | (806, 297) | (1114, 635) | `56,123,83` | true | true（attempt=1） | — | (806,297) `BODY` | 0/0 | PASS |

  —— **8/8 都成功发出了真实点击，全部 `attempt=1`**，无 `not-frontmost`；8 个落点 `pixel` 均**经判据认定为网页绿色**（站点纯色 `#0a7d4f = (10,125,79)`；色彩管理后实测读数 `56,123,83`；判据为绿色启发式，阈值 40/20，余量 67/40；`pixelGreen=true` —— **独立于坐标换算**用屏幕像素证明落点在网页内；措辞更正 3 / F3，判据未放宽），误差全部 0px（判据 ≤6px）。**残余信任边界（更正 4 / F4）**：payload 第 **2400–2955** 字符（落点 6 尾 + 落点 7 全条）除该旁路文件外**无外部绑定**；支撑性交叉核对为「落点 7 与落点 3/6 构成 `830−24=806`、`321−24=297` 的镜像自洽 + 进程内对 8 项求值 + run1（无预载）同样 PASS」。
* **`V12` / `V12b`（最大化 → 恢复）= PASS / PASS**：最大化 `click.ok=true`、`tries=1`、`received=true`，windowRect `830×570 → 1180×702`、pageSize `830×321 → 1180×453`、`viewFollows=true`；恢复后 **`restState` / `backLayout` / `backPage` / `backView` 全 true**，windowRect 回 `830×570`、pageSize 回 `830×321`、`viewRectRestored={308,338,830,321}` —— **窗口矩形 / 网页布局 / 页面尺寸 / 视图矩形四路逐值回位**。
* **上一批对照**：batch14 同一条门禁实测 **22 pass / 3 fail / 25 total / 1 NV，EXIT=1**，3 项 FAIL 全是 `not-frontmost:…`（前台 layer-0 首位始终是 Google Chrome pid 83502 / win 160240），`V9`/`V12b` FAIL 时**一次点击都没发**；`V11` 更只是**部分落点成功**（左/右边中点等 `attempt=1`，其余被拒）、整项判 FAIL。→ 本批 8/8 全成功、三项全 PASS，差异**全部由独占前台消除**，**不是产品缺陷**。

## 3. 安全闸证据（零拒绝）

* `not-frontmost` **0**（run1 / run2 均 0）；`outside-content` **0**。
* 两轮产物 JSON 各 **34 处 `attempt` 字段**（同一行数据在 `checks` 与 `operationRecord` 两处各一份）、**合计 68 处，全部 = 1，无 2、无 3** → 每次点击前的**前台身份判据第一次尝试即满足**，从未走到 `activate` 重试。
* 两轮各自落盘 12 条完整 `{ours, front, activePid}` trace，**12/12 满足 `front[0].id === ours` 且 `front[0].pid === activePid`**；`V11` 的 8 条 trace 完全相同且均 `attempt=1`。

## 4. 与 CLOSURE4 基线（25 / 0 / 1，exit 0）的对照与提交标识澄清

**对照结论（更正 2 / F2，已降级表述）：汇总一致 + 断言名单未变（据此推出逐条判定口径未变）** —— (a) 汇总 counts（25/0/25）、EXIT（0）、NOT VERIFIED（1，同一项页面缩放）与 `docs/D5-01-CLOSURE4-RESULT.md:100` 表 G1 行一致；(b) 25 条 `record()` 断言**名单**在 `f9564b7`（CLOSURE4 被测版）与当前版本之间**逐条同名**（名单 diff 为空）、NV 项同名；(c) 判据/阈值（V9 ≤8px、V11 ≤6px + `pixelGreen`、V12 ≤6px、`status = ok?"PASS":"FAIL"`）**逐字未变**。

**证据强度限制（如实登记，不允许高估）**：CLOSURE4 期的 **25 条逐条状态快照并未冻结** —— `artifacts/` 被 `.gitignore` 忽略且早已被后续运行覆盖，仓库内**不存在**该快照（`docs/D5-01-CLOSURE4-EVIDENCE.json` 的 `gates[0]` 只有 counts / notVerified / exitCode）。故本批**不是**与基线逐条快照的直接比对，而是「汇总一致 + 断言名单未变」的**推论**；真正**同环境实测快照对照**的对象是上一批（batch14）的 22/3/25。

**提交标识澄清（避免看起来像矛盾）**：任务书引用的 CLOSURE4 标识 **`fe6c9bf` 是**文档提交**（`docs(D5-01 Closure-4): …`，2026-09-20 17:14:29 +0800；`git show --stat fe6c9bf` = `PROGRESS.md` + `docs/D5-01-CLOSURE4-EVIDENCE.json`(新增 288) + `docs/D5-01-CLOSURE4-RESULT.md`，不含产品代码）；该文档正文记录的是**代码提交**：基线 `ebc9d21`（修复前）→ 代码/测试提交 `f9564b7`（修复后）。两者都对、指代不同对象，**不是矛盾**。

## 5. 证据截断登记与裁决（本批唯一新发现的工具局限）

* **事实**：`experiments/d5-01/visibility-e2e.mjs:44` 的 `record()` 把 `actual` 切到 **2400 字符**（`actual: String(actual ?? "").slice(0, 2400)`）。`V11` 的 `actual` 未截断时长 **2955 字符**（8 落点），因此**门禁自己的产物 JSON 与 stdout 里**「右下角内」整条缺失、「左下角内」截在 `trace` 中间（两轮均是）。
* **两轮证据强度不对称（更正 4 / F4）**：**未截断的逐落点原始值只有 run2 有**；**run1 的落点 7「右下角内」无任何原始值**（run1 无预载、从未落盘），run1 的 8 落点结论由门禁进程内对 8 项 `edgeOk` 求值 + 该 check PASS 支撑；payload 第 **2400–2955** 字符无外部绑定（残余信任边界，交叉核对成立）。
* **不影响判定（写明）**：`status` 来自调用方传入的 `ok` 参数（`status: ok ? "PASS" : "FAIL"`），`failed` 计数与**退出码**也只由 `ok` 决定；`.slice(0, 2400)` **只影响落盘/打印的证据字符串**，不可能把 FAIL 变 PASS 或反之。
* **只读补齐**：本批新增 `batch15/verify/evidence-preload.mjs`（挂在 **run2** 的 `NODE_OPTIONS=--import`），包装 `JSON.stringify` 后**返回值与原函数完全相同**，只把 >2000 字符的探针 JSON 另存一份（`verify/captured/payload-001-2955.json`）；**不改任何冻结文件、不改判据/阈值/返回值**。独立验收实测**18/18 用例输出逐字节相同**、写入范围仅该 OUT 目录，并用 `captured/` 目录 **birthtime** 独立证明 **run1 期间该目录不存在**。且 **run1 是纯运行（无预载）也 25/0/1 通过** → **结论不依赖该预载**。
* **裁决（上级）**：本批**不改**该 2400 上限。理由：(a) 验收判据已满足；(b) 完整未截断数据已用只读方式留存并独立复算（仅 run2，残余信任边界已登记）；(c) 改动这个已冻结的仪器会**作废本批两轮绿证据**。→ 登记为遗留项；**独立验收 F7 认同本批不改，但不同意长期留作普通遗留项** → **建议尽快另开批次修**（提高上限，或按落点分段截断，使门禁自身产物即可完整回溯）。

## 6. 回归复用说明（本批**未**运行回归）

**本批无代码改动，故不重复运行回归**，引用上一批（batch14）仍有效的结果：`npm test` = **1412 tests / 1412 pass / 0 fail，EXIT=0**（`experiments/d5-03/batch14/70-npm-test-full.txt`）；D5-01 单测合并集 **37/37，EXIT=0**（`…/30-unit-d501-suite.txt`）；D5-01 boundary **32 pass / 0 fail / 1 NOT VERIFIED，EXIT=0**（`…/40-boundary-after-fix.txt`）。**为何仍有效（更正 1 / F1，路径限定）**：本批零代码改动 = `git diff --stat -- src/ electron/ tests/ experiments/d5-01` **为空**（`git diff --stat` 非空，只有 `PROGRESS.md` 与 `docs/D5-03-GATE-EVIDENCE.json` 两处文档改动），被测代码树与 batch14 取证时的 `ac019a5` 产品/测试代码逐字节相同；该复用归属经独立验收 **F5 用 4 个 blob 哈希复核成立**（blob 哈希与 `ac019a5:<path>` 及当前工作树三者一致）。**本批明确不主张**运行过这些命令 —— 是**复用**而非本批实测。

## 7. 独立验收（F1–F7）与遗留项、判定

**独立对抗性验收**：报告 `experiments/d5-03/batch15/verify/BATCH15-VERIFY-REPORT.md`（全新上下文、与执行方无关联、**全程未运行任何真机/前台脚本、未抢前台**；他人产出，本批未改写）。其独立复算确认：两轮 `25/0/25`、逐条 status 差异 0、`attempt` 取值集合 `{1}`、`not-frontmost`/`outside-content` `0/0`、**V11 8/8 且误差 0px**、V9 误差 0px、V12b 逐值回位；阈值**未放宽**（`f9564b7` ↔ 当前整文件 diff 仅 3 hunk / 49 行，全是 `ac019a5` 的向导与 dock 选择器；V9 ≤8 / V11 ≤6+`pixelGreen` / V12 ≤6 / `status = ok?"PASS":"FAIL"` 逐字未变，25 条断言名单 diff 为空）；**未发现伪造或放宽**。逐条处置：**F1** 已更正（路径限定表述）；**F2** 已降级（汇总一致 + 名单未变，并登记证据强度限制）；**F3** 已改措辞（经判据认定为网页绿色：站点纯色 `#0a7d4f`、实测读数 `56,123,83`、阈值 40/20、余量 67/40）；**F4** 已标明仅 run2 有原始值 + run1 落点 7 无原始值 + 残余信任边界；**F5** 预设疑点**已排除**（4 个 blob 哈希与 `ac019a5` 及当前工作树三者一致）；**F6** 为**任务书笔误**（`ebc9d47` 不存在，真实为 `ebc9d21`；执行方用对了）；**F7** 2400 截断仍在，本批不改（避免作废既有绿证据），**建议尽快另开批次修**。

**遗留清单（均为另批范围）**：① `visibility-e2e.mjs:44` 的 2400 字符截断（**F7 建议尽快另批修**）；② 其它 **9 个仍用陈旧 `data-app-id` 的探针** —— `tests/d4-main-e2e.mjs:284`、`tests/fixtures/{model-isolation:59, model-settings:50, model-secret:90, resource:120, resource-library:127, resource-search:84, resource-preview:113}-ui-probe/main.cjs`、`tests/fixtures/governance-ui-probe/main.cjs:82/117/136`；③ `experiments/d5-01/browser-e2e.mjs:487` 的 `waitView("/cookie")` 脆弱点（超时返回 `undefined` 后直接 `.includes` → `TypeError` 中止整段，掩盖可能是真实产品症状的信号）；④ 上游继续单列（跨组织真机 2 条、`governance-ui`/`model-keychain-restart` 两条探针门禁既有失败、OAuth、插件隔离 D5-08、D5-02 `prompt()` 遗留、SIGKILL 边界、第五批登记其余残留）。另：后续复跑仍需一段**独占前台**窗口，否则会重现 `not-frontmost`（判据不得放宽）。

**判定：本批（D5-01 visibility 未验收项闭环）= PASS（限定范围）** —— `test:d5-01-visibility` 两轮独立真机运行均 **25 PASS / 0 FAIL / 25 total / 1 NOT VERIFIED，EXIT=0**，与 CLOSURE4 基线 `25/0/1`（`docs/D5-01-CLOSURE4-RESULT.md:100`）**汇总一致且 25 条断言名单未变**（据此推出逐条判定口径未变；**不是**逐条快照比对 —— 基线逐条快照未冻结）；**`V9` / `V11` / `V12b` 由「未验收」改为「已验收」**（`V11` 8/8 落点、全部 `attempt=1`、误差 0px，落点像素经判据认定为网页绿色）；安全闸全程零拒绝（`not-frontmost` 0、`outside-content` 0，68 处 `attempt` 全为 1）；本批无代码改动（路径限定）、未 commit/push/merge/rebase/amend；回归复用 batch14 结果（本批未重复运行）。**本批不主张**：不改门禁仪器与判据；页面缩放 1 项 NOT VERIFIED 无改变；9 个陈旧 `data-app-id` 探针与 `browser-e2e.mjs:487` 无改善；与基线"逐条快照一致"。**D5-03 整体 = PARTIAL**（其余批次范围内项目未完成，未闭环项照上列遗留清单）。

# D5-03 第十六批 · batch15 证据归档补齐（38 个产物入提交）· 2026-10-04（父 8b8e8ad）

**系列消歧**：注：本节「第十六批」属 **D5-03** 线（父 `8b8e8ad`），与 `PROGRESS.md` 中 **D5-02 画布**线的「第十六批」（宿主 sandbox 补 `allow-modals`，见 `PROGRESS.md:1307` 等）是**不同系列**，勿混。

**时间口径**：**本批归档执行为 2026-10-04；被归档的 38 个产物产生于 2026-10-01 21:14–21:17（batch15 两轮真机运行）**；被测基线仍是 `2d50986`，运行验收结论沿用 batch15。

**本批性质：只归档。** 本批**没有**新的真机运行（**未**运行 `test:d5-01-visibility`，**未**运行 `npm test`，**未**运行任何前台/真机脚本）、**没有**代码改动（`src/` / `electron/` / `tests/` / `experiments/d5-01/**` 一律未动）、**没有**修改任何原始产物（38 个文件未被写入 / 未被覆盖 / 未被重命名 / 未被重新生成，也没有"补造"），**没有**修改任何忽略规则，**没有** `commit` / `push` / `merge` / `rebase` / `--amend`（只暂存，提交由上级统一做）。

**被测基线仍是 `2d50986`**（`docs(d5-01): 第十四批结果与证据定稿（D5-01 真机门禁安装段修复）`）；**运行验收结论沿用 batch15**：两轮独立真机运行均 **25 PASS / 0 FAIL / 25 total / 1 NOT VERIFIED，EXIT=0**（run1 纯运行无预载、run2 同一门禁 + 只读证据补齐预载），**`V9` / `V11` / `V12b` 由「未验收」改为「已验收」**。本批**不主张**运行过上述命令 —— 是**沿用**既有结论，不是本批实测；本批无代码改动，故该结论的代表性不受本批影响。

**38 个文件的来源与为何此前未入提交**：来源 = batch15 两轮真机运行的原生产物（产生时间 **2026-10-01 21:14–21:17**）—— `experiments/d5-03/batch15/artifacts/run1-visibility-e2e.json`、`artifacts/run2-visibility-e2e.json` 两份产物 JSON，加 `artifacts/run1-visibility-frames/` 18 张 PNG、`artifacts/run2-visibility-frames/` 18 张 PNG（两轮帧**文件名完全相同**，共 18 个名字 `01-paint-before.png` … `12-zoom.png`），合计 **38 个文件、约 12 MB**。此前未入提交的原因：仓库根 `.gitignore` **第 3 行规则 `artifacts/`** 是**无路径前缀的目录规则**，会匹配任意层级的 `artifacts/`，故 `experiments/d5-03/batch15/artifacts/**` **整体被忽略**；已用 `git check-ignore -v` 对两份 JSON 与两张代表截图取证，输出均为 `.gitignore:3:artifacts/	<路径>`（证明是忽略规则所致，不是路径写错或从未 `add`）。因此在基线 `8b8e8ad` 中 `experiments/d5-03/batch15/` 下**已跟踪文件只有 15 个**（报告、`10-/11-*.txt`、`00-prerun-facts.txt`、`verify/**`），**`artifacts/` 下已跟踪文件数 = 0**，即 batch15 的核心证据（两轮产物 JSON + 两轮各 18 张截图）在 `8b8e8ad` 里完全不进版本库，导出提交无法回溯原始帧与原始计数。

**本批做了什么（仅此一项写操作 + 新增文本）**：**只对上述 38 个指定文件**执行 `git add -f`，按**原路径**纳入 Git（不重命名、不搬迁、不改内容）；**未修改任何忽略规则**（`.gitignore` 本批前后 sha256 **一致** = `4c0fdfe2d97b05490f628f84cbb450e88deb0f17233a326eeab17caddc614cfc`；本批采用 `-f` 强制纳入，而非放宽 / 删除忽略规则）。**禁止** `git add -A` / `git add .` / 目录级 `git add experiments/d5-03/batch15`；只按显式路径清单 `-f` 暂存这 38 个文件，另加 4 个文本文件（`16-archive-manifest.tsv` / `16-archive-supplement.md` / `16-archive-precheck.txt` / `PROGRESS.md`），合计 **42** 项暂存。**未产生提交**。

**逐字节不变与校验清单**：38 个文件在本批中**未被写入 / 覆盖 / 重命名**；**`experiments/d5-03/batch15/16-archive-manifest.tsv` 是本批唯一的逐字节见证**，格式为表头 `path<TAB>bytes<TAB>sha256` + **38 行数据**（相对仓库根的 POSIX 路径、十进制字节数、小写十六进制 64 位 `sha256`，按路径**字典序**升序，行尾单换行、无 CR）+ 合计行 `# files=38 total_bytes=12733808`（合计行以 `#` 开头，不破坏 TSV 解析）。载体放在 `batch15/` 下而**不放在 `artifacts/` 里**，否则又会被忽略。清单生成后已自检：重新读取清单、**逐行用 `sha256` / `stat` 复算并与清单逐字段比对，结果完全一致**，数据行数 = **38**；另在暂存后用 `git cat-file blob :<path>` 对 38 条**再次复算，bytes 与 sha256 与清单 38/38 一致**（证明 `git add -f` 未改动任何字节）。归档前逐项确认与清单自检的**原始输出**全部保留在 `experiments/d5-03/batch15/16-archive-precheck.txt`（含 `git rev-parse HEAD` / `git status --porcelain` / `git check-ignore -v` / 38 路径逐项存在性与字节数 / "文件计数 = 38" / 两份 JSON 的 `counts` / `len(checks)` / `len(notVerified)` / `.gitignore` sha256 / 清单自检）。两份产物 JSON 归档前复核：均 `counts = {"pass":25,"fail":0,"total":25}`、`len(checks) = 25`、`len(notVerified) = 1`，与 batch15 报告结论一致。另有归档补充说明 `experiments/d5-03/batch15/16-archive-supplement.md`（新增，**不改写**任何既有报告）。

**如何复算清单**：`16-archive-manifest.tsv` 的每一行都可用下述方式独立复算并比对 —— 单文件 `git show <commit>:<path> | shasum -a 256`，或按原路径导出 `git archive <commit> <path> | tar -xO | shasum -a 256`；批量则读清单逐行 `git show` 后比对 `sha256` 列（应零差异），并可用 `git ls-tree -r --name-only <commit> experiments/d5-03/batch15/artifacts/ | wc -l` 应 = **38** 做交叉核对。**提交号尚未产生**，本批**不编造哈希**：**本次归档提交 = 父提交为 `8b8e8ad`、主题为 `docs(d5-01): 第十六批 batch15 证据归档补齐…` 的那一次提交（不以 amend 方式产生）**。

**遗留（不在本批范围）**：`experiments/d5-01/visibility-e2e.mjs:44` 的 **2400 字符截断仍在**（`record()` 里 `actual: String(actual ?? "").slice(0, 2400)`，使门禁自身产物无法完整回溯 `V11` 最后一落点，须依赖只读旁路 `verify/captured/payload-001-2955.json`）—— 本批**不改，另批修**（提高上限或按落点分段截断）；batch15 登记的其余上游遗留（9 个陈旧 `data-app-id` 探针、`browser-e2e.mjs:487` 的 `waitView("/cookie")` 脆弱点等）**一律未动**。**`D5-03` 整体仍 = `PARTIAL`** —— 本批只补齐 batch15 的**证据归档**，未闭环任何新产品 / 测试范围事项，整体判定**不因本批改变**。

- 后续提交更正：归档补充说明中「合计 41 项」的算术笔误已更正为 **42**（38 产物 + 清单 + 补充说明 + 归档前确认输出 + PROGRESS.md），并把独立验收报告 `verify/BATCH16-VERIFY-REPORT.md` 一并入档。
