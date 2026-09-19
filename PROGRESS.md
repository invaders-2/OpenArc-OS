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