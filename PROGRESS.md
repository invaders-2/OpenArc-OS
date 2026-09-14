# OpenArc OS 进度

更新日期：2026-09-14

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
| D2-03 搜索与通知 | **CONDITIONAL GO**（D3-02 授权契约已就绪；尚未执行） |
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
| **D4-02B ACP Harness Adapter** | **NOT STARTED** | 下一阶段 |
| **D4-02 overall** | **PARTIAL** | A PASS；B 未开始 |
| **D4-03 Controlled Tool Proxy** | **BLOCK** | 直到 D4-02 自身 PASS |

## 2. 关键证据（真实执行）

| 入口 | 结果 |
|---|---|
| test:d4-02a | **22 / 22 PASS** |
| test:d4-01 | **59 / 59 PASS** |
| npm test | **544 / 544 PASS** |
| migration（含 v8→v9 + rollback） | **18 / 18 PASS** |
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

## 4. 主要缺口

D4-02B ACP Harness Adapter（NOT STARTED）；Windows NOT VERIFIED（继承 D4-01）。

## 5. D4-02B 准入

**CONDITIONAL GO**：ACP ONLY；`HARNESS_RAW_PROVIDER_KEY = FORBIDDEN`；Harness 只与 OpenArc Model Proxy 通信；只接收 Proxy endpoint + scoped capability + safe model snapshot；不拥有 persistent task queue/state/step/retry/tool/lease/permission authority。**D4-03 = BLOCK**。

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