# D1-06 Technical Gate Decision

> **Task Status: PARTIAL**
> 分支：`feature/d1-06-tech-gate`
> 集成基线：`db1b0dd`（在 `c3b8901` 之上，`c3b8901` = D1-05 尖端）
> 日期：2026-09-11

本轮**不开发新功能**。目标是汇总 D1-01 ～ D1-05 的真实证据，形成 OpenArc OS 第一份正式技术 Gate Decision。

**禁止事项（本轮全程未做）**：把 PARTIAL / BLOCKED 改写成 PASS；为了让 D2 / D3 能开工而降低判定标准；
在本轮实现 OS sandbox、内存上限、网络沙箱、Control Service、Device Agent。

**为什么 D1-06 自身是 PARTIAL**：见第 19 节。D1-03 仍 `BLOCKED`、D1-05 OS sandbox 与内存/网络三处 `BLOCKED`
仍在、Windows 核心项仍 `NOT VERIFIED`。这三条只要有一条成立，就不得把"整个 D1 全面技术验证"描述为 COMPLETE。
**允许 D2 有条件开工与 D1-06 保持 PARTIAL 不矛盾** —— 二者回答的是不同问题：前者是"能不能开始写"，后者是"技术验证是否完成"。

---

## 0. 判定词汇（四轮沿用，不新造）

| 词 | 含义 |
| --- | --- |
| `PASS` | 有真实执行证据，且覆盖了该面的主要风险 |
| `PARTIAL` | 一部分有真实证据，另一部分缺失或只覆盖了弱化场景 |
| `BLOCKED` | 前提不具备，**连验证都无法进行**（如无设备、内核拒绝） |
| `NOT VERIFIED` | 没测过。**绝不因为"API 名字相同""理论上应该可以"而升级为 PASS** |
| `FAIL` | 实测与预期相反，且属于缺陷 |

---

## 1. 集成分支与 ancestry 审计

### 1.1 真实结构（**不是线性推进**）

```
823242a main
 └─ 8a0a1e5 ─ 34e6461 (D1-01)
      └─ b88b244 ─ 0187538 ─ b39eb93 (D1-02)          ← 三分叉点
           ├─ 9f797fd ─ 00ff6ed (D1-03 Adobe)
           ├─ 210118c ─ 9374968 ─ 0734a58 ─ 2ca57c3 ─ 65f4c4f ─ 34dfff9
           │   ─ 0a2f5d0 ─ 1bbfeac ─ b2fcd17 ─ c15ee2d ─ bdcbba5 ─ d1dfd00 (D1-04)
           └─ fec68f4 ─ 7beaf7b ─ c3b8901 (D1-05)

feature/ui-light-bar-zero (d0ccd69)  从 8a0a1e5 分叉，不在任何 D1 主线祖先里
```

### 1.2 `merge-base` 实测

| 对 | merge-base | 结论 |
| --- | --- | --- |
| D1-03 × D1-05 | `b39eb93` | 同源分叉 |
| D1-04 × D1-05 | `b39eb93` | 同源分叉 |
| D1-04 × D1-02 | `b39eb93` | **D1-04 含 D1-02** |
| D1-04 × D1-01 | `34e6461` | D1-04 含 D1-01 |
| ui-light-bar-zero × D1-01 | `8a0a1e5` | 老点分叉，已过时 |

**结论：D1-03 / D1-04 / D1-05 三支都从 `b39eb93` 分叉，彼此互不包含。**
因此"直接 merge all 再处理冲突"会把三份互相冲突的 `PROGRESS.md` 拼成一份自相矛盾的状态文档 —— 本轮明确不这样做（见第 2 节）。

---

## 2. Accepted Evidence Integration

集成线只纳入：已接受的 bug fix、已接受的安全修复、测试 / probe、ADR、PROGRESS、已拍板的设计系统修改。

### 2.1 逐 commit 判定

| Commit | 内容 | 判定 | 理由 |
| --- | --- | --- | --- |
| `34786a2` `1cd0780` `92a4522` | D1-01 审计 / 几何共享 / A12 穿透修复 + 布局持久化 | **ACCEPT** | 已在基线内；A12 为真实缺陷修复 |
| `8a0a1e5` | PROGRESS 同步 D1-01 | ACCEPT | 已在基线内 |
| `34e6461` | D1-01 ADR 修正三处推断强度 | **ACCEPT** | 属于"降低虚报"，正是 Gate 要的行为 |
| `b88b244` | D1-02 ACP 探针 + 假 MCP server | **ACCEPT** | 纯探针，无产品实现 |
| `0187538` | D1-02 ADR + PROGRESS | ACCEPT | |
| `b39eb93` | D1-02 状态口径修正 | **ACCEPT** | 区分任务状态与技术决策 |
| `9f797fd` | D1-03 Adobe 双应用评估（ADR） | **EVIDENCE ONLY** | 纯 ADR，无产品代码 |
| `00ff6ed` | D1-03A 复核 Illustrator Beta 未安装 | **EVIDENCE ONLY** | 补证 BLOCKED，不改结论 |
| `210118c` | 浅色顶栏 / Dock / 标题栏透明度归零 + opaque 兜底色修正 | **ACCEPT** | 已拍板的设计系统修改 |
| `9374968` | 桌面右键菜单 Esc 关闭 | ACCEPT | 真实缺陷修复（遮罩点击陷阱） |
| `0734a58` | D1-04 组件 / 动效 / 玻璃 / 对比度探针（13 个） | ACCEPT | 纯探针 |
| `2ca57c3` | D1-04 ADR + PROGRESS | ACCEPT | |
| `65f4c4f` | 三档材质进产品代码 + 主题色改为消费点合成 | **ACCEPT** | 已拍板；修复 `:root` 合成位置错误（真实 bug） |
| `34dfff9` | 主题矩阵防回归 + 材质档位 / 切换 / 闪烁探针（6 个） | ACCEPT | 纯探针 |
| `0a2f5d0` | D1-04B ADR（主题合成修复 + REDUCED 落地） | ACCEPT | |
| `1bbfeac` | 产品档位性能基准（3 个） | ACCEPT | 纯探针 |
| `b2fcd17` | D1-04B 官方材质性能记录 | ACCEPT | |
| `c15ee2d` | **REDUCED 改为选择性玻璃（减少过滤面积）** | **ACCEPT WITH CHANGE** | 已拍板的设计系统修改；**按 D1-04C 最终定义纳入，不采用 D1-04 早期的注入式 REDUCED 口径** |
| `bdcbba5` | 过滤面积度量 + hover 探针 + 载荷改用大面积开关 | ACCEPT | 纯探针 |
| `d1dfd00` | D1-04C ADR（选择性玻璃定义与验收） | ACCEPT | |
| `fec68f4` `7beaf7b` `c3b8901` | D1-05 探针框架 / 凭据与执行隔离 / ADR | **ACCEPT** | 已在基线内 |
| `d0ccd69`（`feature/ui-light-bar-zero`） | 浅色顶栏归零 + `tests/visual-light-bar.mjs` | **DO NOT INTEGRATE — SUPERSEDED** | 其 `styles.css` 改动已被 D1-04 内部 `210118c` 重做并扩展；其测试已被 `experiments/d1-04/light-bar-check.mjs` 取代。纳入会造成同一改动的双份实现 |

### 2.2 明确排除的内容

| 类别 | 本轮是否需要排除 | 实际核查结果 |
| --- | --- | --- |
| Adobe 假接入 | 是 | **不存在**。`main` 的 `src/main.tsx` 原有 6 处硬编码 Adobe 占位数据，**已在 D1-01 分支被移除**；集成树中 `src/` 对 Adobe 零引用（`grep -ri adobe src/` → 0） |
| Harness 产品化实现 | 是 | **不存在**。D1-02 只有 `experiments/harness/{acp-probe,fake-mcp-server}.mjs` |
| 未验证 Sandbox | 是 | **不存在**。无任何 sandbox 实现代码进入产品路径 |
| 自动 Glass 降级 | 是 | **不存在**。FULL→REDUCED→SOLID 自动触发链被冻结到 D1-06 之后，产品内只有手动选档 |
| 完整 Control Service | 是 | **不存在** |
| 完整 Device Agent | 是 | **不存在** |
| 完整用户系统 / 数据库 schema / 多人团队 / 插件中心 | 是 | **不存在** |

### 2.3 集成后的验证

| 检查 | 结果 |
| --- | --- |
| `npm test` | **7 / 7 PASS** |
| `npm run build`（`tsc --noEmit && vite build`） | **通过**，1580 modules |
| 产物 hash 交叉验证 | `dist/assets/index-D0-ocfyo.css` + `index-HUct8jRc.js`，**与 D1-04 树一致** → src 侧集成无回归 |
| ADR 齐备 | `docs/decisions/` 下 D1-01 ~ D1-05 五份 ADR **在同一棵树内** |

---

## 3. Master Gate Matrix

**Earliest blocking phase** 读作"**最晚必须在此阶段前解决**"，不是"已经阻塞了它"。

| # | Area | D1 task | Status | Verified（真实证据） | Missing | Risk | Earliest blocking phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Desktop | D1-01 | **PASS（macOS）** | 创建/显示/最小化/还原/最大化/取消最大化/setBounds/焦点互斥，主进程实测 | Windows 窗口行为 | 中 | MUST FIX BEFORE **D6** |
| 2 | WebContentsView | D1-01 | **PASS（macOS）** | 真实实例（非 iframe）、bounds、隐藏/显示、reload、独立 CDP target | Windows 侧；DOM 覆盖层方案未定 | 中 | MUST FIX BEFORE **D2-02** |
| 3 | Window recovery | D1-01 | **PASS** | `oa-wins` 持久化 + 启动 clamping + display-added/removed/metrics-changed 回拉 | Windows、真实多显示器拔插 | 中 | MUST FIX BEFORE **D6** |
| 4 | Windows desktop | D1-01 | **NOT VERIFIED** | 无 | mica、窗口行为、多显示器、打包、sandbox runtime、UI E2E | **高** | MUST FIX BEFORE **D6 / RELEASE** |
| 5 | Harness | D1-02 | **PARTIAL** | 真实安装（521 包）+ ACP 探针 **10/10**：握手、会话生命周期、真连自建 MCP 并枚举工具、cancel、close | 端到端工具链路、Windows / Linux 运行 | 中 | MUST FIX BEFORE **D4-02** |
| 6 | Tool interception | D1-02 / D4 | **NOT VERIFIED** | 无（`tools/call` 实际拦截未测） | 真工具链路 + 门控 | **高** | MUST FIX BEFORE **D4-03 / D4-04** |
| 7 | Harness credential boundary | D1-02 | **PARTIAL** | 官方自承凭据无法与 agent 隔离；**ACP 无鉴权**（`authMethods: []`） | 真实隔离方案 | **高** | MUST FIX BEFORE **D4-01** |
| 8 | Adobe Illustrator | D1-03 | **BLOCKED** | 稳定版无 MCP（二进制 `strings` 计数 = 0 + 端口零监听，双重否定证据）；D1-03A 四项独立证据确认 **Beta 未安装** | 全部运行时项 | 中 | MUST FIX BEFORE **D5-05** |
| 9 | Adobe Photoshop | D1-03 | **NOT VERIFIED** | UXP 存在（`Required/UXP`、`dvauxphost.framework`）；官方 Desktop MCP **NOT FOUND IN OFFICIAL SOURCES** | UXP + 本机桥接实测 | 中 | MUST FIX BEFORE **D5-04** |
| 10 | Design system | D1-04 | **PASS（方向）** | token 架构修复、六格主题矩阵 PASS、对比度 / 层级 / hover 实测；MS-A02 / MS-A03 / A29 有证据 | Windows 视觉一致性 | 低 | 不阻塞 D2-01；**D6** |
| 11 | Glass | D1-04C | **PASS（方向冻结）** | 三档真实产品实现；选择性玻璃过滤面积 −86.6% ~ −99.0%（K=0/24/72/144）；过滤面数 150→6；63/63 切换压力 PASS | Electron 内性能、Windows | 中 | MUST FIX BEFORE **D6** |
| 12 | Electron performance | D1-04C | **NOT VERIFIED** | 无（数字只在 Chromium 侧取得；产品是 Electron） | Electron 内基线 | 中 | MUST FIX BEFORE **D6** |
| 13 | Windows visual / performance | D1-04 | **NOT VERIFIED** | 无 | 全部 | 中 | MUST FIX BEFORE **D6 / RELEASE** |
| 14 | Local IPC | D1-05 | **PARTIAL** | UDS + 0o700/0o600 ACL + per-install secret + `timingSafeEqual` 实测；**`127.0.0.1` 不构成认证已证伪** | **Windows Named Pipe ACL**；**跨 uid 强制执行** | 中 | MUST FIX BEFORE **D3-02（Windows）**、**D6** |
| 15 | LAN TLS | D1-05 | **PASS（技术路线）** | 12 场景全测（含真过期证书、错 CA、主机名不匹配、轮换、重连）；**无 TLS 失败降级明文路径** | 真机双设备拓扑、证书分发/轮换运维 | 中 | MUST FIX BEFORE **D3-03** |
| 16 | Device identity | D1-05 | **PARTIAL** | 四域分离（`userId`/`deviceId`/`sessionId`/`teamId`）；mTLS 可作设备身份 | **device registry / revocation state / team membership / authorization state 全部未实现** | **高** | MUST FIX BEFORE **D3-03** |
| 17 | Credential storage | D1-05 | **PARTIAL** | macOS 进程内 Security.framework 实测可用；`credentialRef` 边界；`/usr/bin/security` 路线 **否决**（密钥进 argv + 曾改写全局钥匙串） | **Windows DPAPI / Credential Manager** | **高** | MUST FIX BEFORE **D3-04（Windows 侧）** |
| 18 | Environment isolation | D1-05 | **PASS（方向冻结）** | 默认 spawn 泄漏 **4/4**、`{...process.env}` 泄漏 **4/4**、显式允许列表泄漏 **0**；Worker 共享 `process.env` | 落地到 D4 各执行单元 | **高** | MUST FIX BEFORE **D4-03 / D4-04** |
| 19 | File boundary | D1-05 | **PARTIAL** | 加固实现对 **13 类**静态载荷全 DENY（穿越/点段/前缀混淆/绝对路径/NUL/软链含改名与嵌套） | **hard link** 与 **TOCTOU 中间段替换** 可绕过；无 OS 级约束 | **高** | MUST FIX BEFORE **任何不可信代码执行** |
| 20 | Plugin isolation | D1-05 | **BLOCKED** | 已实测：Worker Thread 无内存边界（`SharedArrayBuffer` 共享）、普通子进程 fs/网络无约束 | OS sandbox | **高** | MUST FIX BEFORE **D5-03 / D5-08** |
| 21 | Network isolation | D1-05 | **BLOCKED** | 三档模型已冻结（`none`/`selected-hosts`/`unrestricted`） | OS 级强制 | 中 | MUST FIX BEFORE **D5-08** |
| 22 | Memory limit | D1-05 | **BLOCKED** | 实测 **V8 `resourceLimits` 不约束堆外内存**（16MB 堆上限下分配出 256MB Buffer，探针被 OOM 杀）；macOS `RLIMIT_AS/DATA/RSS` 全不可设 | OS 级方案 | **高** | MUST FIX BEFORE **任何不可信代码执行** |
| 23 | Process execution | D1-05 | **PASS（macOS）** | `shell:false` + `spawn(exe,args)`；7 类注入载荷全部无效（且跑了正例排除假阴性）；工具注册表 **12/12** | Windows | 低 | MUST FIX BEFORE **D6** |
| 24 | Cancellation | D1-05 | **PASS（macOS）** | 单层 kill 会留孤儿（已证）；`kill(-pgid)` parent→child→grandchild 无孤儿 | Windows | 低 | MUST FIX BEFORE **D6** |
| 25 | Logging | D1-05 | **PASS** | 字段白名单（多塞字段直接拒写）+ 7 形态脱敏（含 base64 与私有路径）+ 落盘扫描；产物零明文命中 | — | 低 | 不阻塞 |
| 26 | Side-effect uncertainty | D1-05 | **PASS（契约冻结）** | `UNKNOWN_EFFECT` 闭环，**无允许盲目重放的路径** | D4 实现 | 中 | MUST FIX BEFORE **D4-01** |

**统计**：PASS 11 / PARTIAL 6 / BLOCKED 4 / NOT VERIFIED 5 / FAIL 0。

---

## 4. Blocker → 最晚解决阶段

**不允许只写 TODO。每条都必须绑定"最晚解决阶段"。**

| Blocker | 最晚解决阶段 | 为什么不更早 | 为什么不更晚 |
| --- | --- | --- | --- |
| **Windows UI 实机**（mica / 窗口行为 / 多显示器 / sandbox runtime / UI E2E） | **MUST FIX BEFORE D6** | 不必阻塞 macOS 上的 D2 工程实现 | 必须阻塞跨平台 COMPLETE 与发布 |
| **Photoshop 接入** | **MUST FIX BEFORE D5-04** | 不阻塞 D2 / D3 | `D5-04` 的通过条件是"真实保存并复查结果" |
| **Illustrator 接入** | **MUST FIX BEFORE D5-05** | 同上 | Beta 未安装，无重做前提 |
| **Adobe 全模块关口** | **MUST FIX BEFORE D5-09** | — | `D5-09` 明确要求两应用**分别**通过，不以冒烟替代 |
| **Plugin OS sandbox** | **MUST FIX BEFORE D5-03 / D5-08** | 不阻塞纯 UI 的 D2 | 必须阻塞任何"不可信 Plugin / Skill 真实代码执行" |
| **Harness 真工具链路** | **MUST FIX BEFORE D4-03 / D4-04** | 不阻塞 D4-01 / D4-02 | `D4-03` 就是工具门与租约，`D4-04` 是真实工具纵向冒烟 |
| **Harness 凭据边界** | **MUST FIX BEFORE D4-01** | — | `D4-01` 通过条件含"隔离、撤权" |
| **Device registry / revocation** | **MUST FIX BEFORE D3-03** | — | `D3-03` 通过条件是"未注册设备不能领任务" |
| **Windows credential（DPAPI）** | **MUST FIX BEFORE D6** | 不阻塞 macOS D3-01 | 阻塞跨平台凭据承诺 |
| **Windows Named Pipe ACL** | **MUST FIX BEFORE D6** | 同上 | 同上 |
| **Memory limit（OS 级）** | **MUST FIX BEFORE 任何不可信代码执行** | 不阻塞 D2 | 阻塞插件 / Skill 执行承诺 |
| **Network isolation（OS 级）** | **MUST FIX BEFORE D5-08** | 同上 | `D5-08` 通过条件是"越界访问被实际阻止" |
| **Electron 内性能** | **MUST FIX BEFORE D6** | 不阻塞 D2 实现 | 阻塞性能承诺的代表性 |
| **Windows 视觉 / 性能** | **MUST FIX BEFORE D6 / RELEASE** | 同上 | 同上 |

---

## 5. 口径修正：应用层安全控制 ≠ OS 级不可信代码隔离

**这是本轮最重要的一条修正。** D1-05 的部分措辞容易被读成"既然不是 OS Sandbox，就都不算安全边界" —— 那是错的。

### 5.1 已经是**有效安全控制**的（不许因为"不是沙箱"就贬低）

| 控制 | 成立理由（有实测证据） |
| --- | --- |
| **authentication** | 错 token / 无 token 一律 DENY（UDS 与 TCP 两侧都测） |
| **TLS** | 12 场景全测；错误/过期/错 CA/主机名不匹配全部 DENY；**无明文降级** |
| **credential references** | Renderer 只拿 `credentialRef`；明文不进 Renderer / localStorage / 日志 / 产物 |
| **`shell=false`** | 7 类注入载荷全部无效，标记文件均未创建（并跑了正例排除假阴性） |
| **argument schema** | 工具注册表决定可执行文件与参数形状，12/12 越权 DENY |
| **logging redaction** | 字段白名单 + 7 形态脱敏 + 落盘扫描，多塞字段直接拒写 |
| **process-group cancellation** | `kill(-pgid)` 无孤儿（单层 kill 留孤儿已同时证伪） |
| **`UNKNOWN_EFFECT`** | 无允许盲目重放的路径 |

**上述八条都是真实的安全控制，应当在 D2–D5 直接复用。**

### 5.2 不能被当作最终安全边界的

对**不可信 Plugin / Skill**、**任意文件访问**、**任意网络访问**、**内存与进程资源隔离**：
应用层 JS 路径检查 / Worker Thread / 普通 Child Process **都不能作为最终安全边界**。

| 手段 | 为什么不够 | 证据 |
| --- | --- | --- |
| JS path check（含加固版） | hard link（同 inode 不同路径）与 TOCTOU 中间段替换可绕过 | D1-05 §10 / §11 |
| 调用方持有 Node `fs` 时的任何路径检查 | 可直接 `readFile` 越过全部检查 | D1-05 §10 |
| Worker Thread | 共享地址空间与 `process.env`，`SharedArrayBuffer` 可共享 | D1-05 §12 |
| 普通 Child Process | fs / 网络无约束 | D1-05 §12 |
| V8 `resourceLimits` | 只约束 V8 堆，堆外内存不受限 | D1-05 §17 |

**准确表述**：应用层控制负责**正确性、防呆、审计与最小暴露**；OS 级约束负责**抵御恶意代码**。
两者都必要，但**不可互相替代**。D1-05 ADR 已追加 §30 口径修正addendum 与本表对齐。

---

## 6. Plugin / Skill 默认策略（冻结）

> **UNTRUSTED CODE EXECUTION = DISABLED BY DEFAULT**

在 OS sandbox 真正通过之前，OpenArc **不得**运行来源不可信的 Plugin / Skill 代码。

**允许继续开发的**（不依赖 OS sandbox）：
manifest · permission declaration · package validation · signature / integrity · UI · install metadata。

**禁止宣称**："不可信插件已安全隔离运行"。
**禁止**把 D5-08「越界访问被实际阻止」写成 PASS，除非 OS 级约束已取得实测证据。

---

## 7. File Boundary 决策（冻结）

`path.relative` + `realpath` + `O_NOFOLLOW` **只能作为 defense-in-depth**。

原因：**hard link** 与 **TOCTOU intermediate replacement** 可绕过（已实测）。

> **Application path validation = INPUT VALIDATION / DEFENSE IN DEPTH**
> **≠ SECURITY SANDBOX**

后续**不得**把它写成插件权限的最终强制点。真正的强制点只能在 OS 层。

---

## 8. Credential 决策（冻结）

**macOS 路线**：`Security.framework`（进程内）→ `credentialRef` → 受控 service lookup。

**禁止**：`/usr/bin/security` + secret argv。

**新增硬约束（针对未来所有安全 Probe）**：
- 未来安全 Probe **不得再修改用户真实 login keychain 结构**；
- 只能使用 **isolated test item** + **temporary service / account name** + **fake secret**；
- **不得** rename real login keychain、**不得** change user default keychain、**不得** change global search list；
- 除非存在**独立的、一次性的 OS 测试环境**。

D1-05 的真实事故（`login.keychain-db` 被改名为 `login_renamed_1.keychain-db`，已完全复原）作为**历史证据保留**，见 D1-05 ADR §7.1 / §27.4。

---

## 9. Local IPC 决策

**当前候选基线**：UDS + directory/file ACL + per-install secret + constant-time comparison。

**状态不要过度写成跨平台完成**：

| 平台 | 状态 |
| --- | --- |
| macOS | UDS 路径、ACL（`0o700`/`0o600`）、token 校验、`timingSafeEqual` —— **VERIFIED**；跨 uid 强制执行 —— **NOT VERIFIED** |
| Windows | Named Pipe ACL —— **NOT VERIFIED** |

---

## 10. LAN / Device 决策

mTLS 技术方向**可采用**。但必须明确：

> **certificate validity ≠ device authorization**

证书只回答"这是否是持有某私钥的实体"。它**不**回答"这个设备是否仍被允许为这个团队工作"。

**需要额外实现**：`device registry` · `revocation state` · `team membership` · `authorization state`。

**Node TLS 不负责业务撤销**（无 CRL / OCSP，已实测：被撤销设备的证书链与有效期依然有效）。
**D3-03 必须实现并测试这一层。**

---

## 11. Harness Gate

D1-02 的核心缺口仍未闭合：

```
真实 tools/call → approval → OpenArc permission → execution → result → Harness
```

**未端到端通过。**

- Harness **可以继续作为候选 adapter**（ACP 面已 10/10 验证，是唯一有 `session/cancel` 的面）。
- **禁止进入 REAL TOOL EXECUTION**，直到 Gate 2 Probe 通过。
- 另有两个高危项必须带进 D3 / D4：**ACP 无鉴权**（`authMethods: []`）、**凭据无法与 agent 隔离**（官方自承）。

---

## 12. Adobe Gate

| 应用 | D1-03 状态 | 后果 |
| --- | --- | --- |
| Illustrator | **BLOCKED**（Beta 未安装；稳定版无 MCP 实现） | `D5-05` **BLOCKED** |
| Photoshop | **NOT VERIFIED**（UXP 存在，无运行时证据；官方 Desktop MCP 未找到） | `D5-04` **BLOCKED** |

**D2 / D3 不被 Adobe 阻塞。**
**但 `D5-04` / `D5-05` / `D5-09` 必须保持 BLOCKED**，直到各自取得真实运行证据。
`D5-09` 明确要求两个 Adobe 应用**分别**通过，**不以冒烟替代**。

---

## 13. Windows Gate（合并清单）

**Windows 全部不能靠 macOS 推断 PASS。**

| 来源 | 缺口 |
| --- | --- |
| D1-01 | Mica · window behavior · multi-monitor · sandbox runtime · UI E2E |
| D1-02 | Harness Windows runtime |
| D1-03 | Adobe Windows |
| D1-04 | Glass / material / performance（Windows 视觉与性能） |
| D1-05 | DPAPI · Credential Manager · Named Pipe ACL · process isolation · network isolation · memory limit · process cancellation |

**合计 16 项，全部 `NOT VERIFIED`。** 必须在真机逐项实测后才能进入 D6。

---

## 14. macOS Sandbox blocker

**本轮不死磕 `sandbox_apply`**（seatbelt 任何含 `deny` 规则的 profile 均返回
`sandbox_apply: Operation not permitted`，本机无法建立 OS 级约束）。本轮**只做技术决策**。

**候选解决路径**（状态：**ARCHITECTURE DECISION REQUIRED**，D1-06 不需要实现）：

| 候选 | 说明 | 需要验证的前提 |
| --- | --- | --- |
| **A. OS-supported signed sandbox / helper** | 走签名 helper + 系统 sandbox 能力，而不是在普通进程里 patch profile | 签名 / 授权链是否能在目标机器落地 |
| **B. Dedicated restricted helper / service** | 独立的低权限 helper 进程，以自己的身份与权限边界运行执行单元 | 权限降级是否可验证、IPC 是否比现状更窄 |
| **C. VM / container-like isolation** | 在适用的场景用强隔离边界 | 成本、启动延迟、与桌面交互的可行性 |
| **D. trusted-plugin-only policy until isolation exists** | 在隔离成立前只跑可信插件（= 第 6 节的冻结策略） | 无 —— 这是**当前必须采用的兜底** |
| **E. 其它有证据支持的方案** | 由后续探针决定 | — |

**当前默认采用 D**（与第 6 节一致）；A / B / C 需要在 D5-03 之前给出架构决策。

---

## 15. Memory limit blocker（冻结）

> **V8 `resourceLimits` ≠ total process memory limit**

不能作为 Plugin sandbox 的内存边界。证据：16 MB 堆上限下实测分配出 256 MB Buffer，且**探针自身被 OOM 杀掉**。

未来方案**必须**基于：OS-level process / resource control，**或**独立受控运行环境。

| 平台 | 状态 |
| --- | --- |
| macOS | **BLOCKED / NOT SOLVED**（`RLIMIT_AS` / `DATA` / `RSS` 全部不可设） |
| Windows | **NOT VERIFIED** |

---

## 16. Network sandbox blocker

冻结 `network` 三档：`none` / `selected-hosts` / `unrestricted`。

**但这目前只是 capability model。** 如果 OS-level enforcement 未取得证据：

> **`network:none` 不能宣称已安全实现。**

未来可考虑 restricted runtime / OS sandbox / mandatory local proxy。
**D1-06 不提前选没有证据的方案。** 禁止用 JS `fetch` patch 冒充安全边界。

---

## 17. Side-effect policy（正式冻结）

> **`UNKNOWN_EFFECT` 为跨 D4 / D5 的核心状态。**

任何"**可能已经产生副作用、但结果回报丢失**"的情况：

**禁止** `FAILED → automatic retry`。

必须 **verify**，再决定三选一：

```
COMPLETED       已生效
RETRY_ALLOWED   确认未生效
MANUAL_REVIEW   无法判定 → 转人工
```

该契约在 D1-05 已闭环（无允许盲目重放的路径），D4 必须实现而不是重新设计。

---

## 18. Phase Admission Matrix

判定：`GO` / `CONDITIONAL GO` / `BLOCK`。
`GO` 的前提是**其全部前置已 PASS**；有任何前置为 PARTIAL / BLOCKED 时，最高只能给 `CONDITIONAL GO`。

| Phase/Task | Decision | Conditions |
| --- | --- | --- |
| **D2-01** 设计规范 | **CONDITIONAL GO** | 前置 D1-04 = PARTIAL、内部方向 CLOSED。全部条件：① 不宣布 Windows 视觉 / 性能完成；② 不实现自动 `FULL→REDUCED→SOLID`；③ Electron / Windows 性能继续待验；④ Spectrum 继续 **REFERENCE ONLY**；⑤ Theme / Glass / Motion 保持**正交** |
| **D2-02** 窗口系统 | **CONDITIONAL GO（仅 macOS 范围）** | 前置 D1-01 = PARTIAL。① 允许在 macOS 范围继续工程实现；② **必须同时产出 D2-02 架构 ADR**；③ 该 ADR 必须解决：WebContentsView / DOM windows / native layer occlusion / clipping / window ownership；④ 不得把 D1-01 PARTIAL 写成 PASS；⑤ Windows 项必须在 D6 前补齐 |
| **D2-03** 搜索与通知 | **BLOCK** | 前置含 **D3-02 对象授权**，尚未存在。依赖权限过滤，无法提前实现验收 |
| **D2-04** 页面状态 | **CONDITIONAL GO** | 前置 D2-01。四类状态（空/加载/错误/无权）中"**无权**"依赖 D3-02 → 本轮只允许做前三类，无权态留待 D3-02 后验收 |
| **D3-01** 初始化与身份 | **CONDITIONAL GO** | 前置 D1-05 = PARTIAL。允许做：账号 / identity contract、`credentialRef`、session model、permission model、**macOS 凭据实现**。禁止：宣称 Windows 凭据可用；宣称设备接入完成 |
| **D3-02** 对象授权 | **CONDITIONAL GO** | 前置 D3-01。策略与检查点可设计与实现；**必须**明确它保护的是"逻辑对象授权"，不是文件系统沙箱（见第 7 节） |
| **D3-03** 设备与 TLS | **CONDITIONAL GO** | 前置 D3-02。mTLS 技术路线已 PASS；**必须**实现 `device registry` / `revocation` / `team membership` / `authorization`（Node TLS 不负责）；Windows 侧为 `NOT VERIFIED` |
| **D3-04** 文件与项目 | **CONDITIONAL GO** | 前置 D3-02。存储 / 版本 / 回收站可做；**必须**去掉"用路径检查保证安全"的表述，路径检查只作 defense-in-depth |
| **D3-05** 身份关卡 | **BLOCK** | 前置 D3-01 至 04；D3-01/02/03/04 未完成，且设备 revocation 未实现。通过条件"通过后才能启用多人真实工具"不满足 |
| **D4-01** 模型服务 | **CONDITIONAL GO（受限）** | 前置 D3-05（已 BLOCK）+ D1-02（PARTIAL）。允许做：统一配置、用量、继承与隔离**设计**。**禁止**真工具执行；**必须**先解决 Harness 凭据边界与 ACP 无鉴权 |
| **D4-02** 任务与适配 | **CONDITIONAL GO** | 前置 D4-01。任务状态机与 Harness 适配可做；`UNKNOWN_EFFECT` 必须按第 17 节实现；工具面保持关闭 |
| **D4-03** 工具门与租约 | **BLOCK** | 前置 D4-02 + **D3-03**（设备层未完成）。且 Harness 真工具链路（`tools/call → approval → permission → execution → result`）未通过 → `D4-03` 的前提不成立 |
| **D4-04** 纵向冒烟 | **BLOCK** | 前置 D4-03（BLOCK）。且 Adobe 双应用均无运行证据，无可用真实工具 |
| **D5-03** MCP 中心 | **CONDITIONAL GO（受限）** | 前置 D4-05。连接管理 / 授权 / 发现 / 重连 / 启停的**设计与管理面**可做；**禁止**据此宣称不可信 Plugin 已隔离运行（见第 6 节） |
| **D5-04** PS 完整接入 | **BLOCK** | 前置 D5-03 + D1-03（Photoshop = NOT VERIFIED）。通过条件"在目标版本真实保存并复查结果"无前提 |
| **D5-05** Illustrator 接入 | **BLOCK** | 前置 D5-03 + D1-03（Illustrator = BLOCKED，Beta 未安装） |
| **D5-08** 插件生命周期 | **BLOCK** | 前置 D1-05 + D4-05。通过条件"**越界访问被实际阻止**"在 OS sandbox 缺位时无法成立 |

**D2 不被整体放行**：D2-01 / D2-02 / D2-04 有条件可做，**D2-03 被 BLOCK**。
**D3 不被整体放行**：D3-01/02/03/04 有条件可做，**D3-05 被 BLOCK**。
**D4 不被整体放行**：D4-01/02 受限可做，**D4-03 / D4-04 被 BLOCK**。
**D5 相关项**：D5-03 受限，**D5-04 / D5-05 / D5-08 被 BLOCK**。

---

## 19. D1-06 自身状态与 COMPLETE 禁令

D1-06 允许取 PASS / PARTIAL / BLOCKED / FAIL。本轮实际取值 **PARTIAL**。

**只要下列任一条成立，就不得把"整个 D1 全面技术验证"描述为 COMPLETE：**

1. D1-03 仍 `BLOCKED`；
2. D1-05 的 OS sandbox blocker 仍在（含内存 / 网络两项连带 blocker）；
3. Windows 核心项仍 `NOT VERIFIED`。

三条**当前全部成立**，因此：

- **D1 整体 = PARTIAL，不得写 COMPLETE。**
- 这与"D2 可以 CONDITIONAL GO"**不矛盾** —— 前者是技术验证完成度，后者是阶段准入。
- 也不得用"D2 已开工"反过来给 D1 贴 PASS。

D1-06 自身的通过条件（PLAN §31）："关键阻塞逐项处理，不虚报通过"。
本轮**逐项处理** = 26 行 Master Gate Matrix + 13 条 blocker 绑定最晚阶段 + 19 行准入矩阵；
**未虚报** = FAIL 0 但 BLOCKED 4 / NOT VERIFIED 5 照实保留。

---

## 20. 保留的历史失败证据（不删除）

以下全部保留，它们是技术决策的重要依据：

| 证据 | 位置 |
| --- | --- |
| D1-01 Playwright / UI E2E blocker（根因未确认） | D1-01 ADR |
| D1-03 Adobe blocker（Beta 未安装四项证据） | D1-03 ADR §Illustrator Beta Runtime Verification |
| D1-04 错误的 REDUCED 性能假设（注入式测量方法失效，v1 方法必须记录） | D1-04 ADR §8.1 / §21.6 |
| D1-04 Theme token bug（`:root` 合成位置错误 → 深色拿到浅色合成色） | D1-04 ADR §20.1 |
| D1-05 path escape（加固后仍被 hard link / TOCTOU 绕过） | D1-05 ADR §10 / §11 |
| D1-05 V8 off-heap bypass（16MB 堆上限下分配出 256MB Buffer） | D1-05 ADR §17 |
| D1-05 Keychain CLI accident（`login.keychain-db` 被改名，已复原） | D1-05 ADR §7.1 / §27.4 |
| D1-05 orphan child proof（单层 kill 留孤儿） | D1-05 ADR §18 |

---

## 21. RECOMMENDATION

> # **CONDITIONAL GO**

**允许继续开发，但只允许在下面的边界内进行；边界外的任何"完成"声明都不被接受。**

### 立即可以开工（有条件）

1. **D2-01 设计规范** —— 条件：不宣布 Windows 视觉 / 性能完成；不实现自动 Glass 降级；
   Electron / Windows 性能继续待验；Spectrum 继续 REFERENCE ONLY；Theme / Glass / Motion 保持正交。
2. **D2-02 窗口系统（仅 macOS）** —— 条件：必须同时产出 D2-02 架构 ADR，
   覆盖 WebContentsView / DOM windows / native layer occlusion / clipping / window ownership。
3. **D2-04 页面状态** —— 条件：只做空 / 加载 / 错误三态，**无权态留待 D3-02**。
4. **D3-01 身份**（含 macOS 凭据实现）、**D3-02 对象授权**、**D3-03 设备与 TLS**（须自建 registry + revocation）、
   **D3-04 文件与项目** —— 条件：不得宣称 Windows 凭据 / 设备接入 / 文件沙箱已完成。
5. **D4-01 / D4-02（受限）** —— 条件：**禁止真工具执行**，先解决 Harness 凭据边界与 ACP 无鉴权。
6. **D5-03（受限）** —— 条件：只做管理面与设计，**不得宣称不可信插件已隔离运行**。

### 明确禁止（在本轮结论被推翻之前）

- 任何"不可信 Plugin / Skill 已安全隔离"的声明（第 6 节）；
- 任何把应用层路径检查作为插件权限最终强制点的设计（第 7 节）；
- 任何 TLS 失败降级明文、注入执行、未知副作用盲目重放（三条硬红线）；
- 任何把 `resourceLimits` 当作进程内存边界的实现（第 15 节）；
- 任何把 `network:none` 当作已实现的强制的声明（第 16 节）；
- 自动 `FULL→REDUCED→SOLID` 触发链；
- 在 `D5-04` / `D5-05` / `D5-09` 上使用冒烟替代真实验收。

### 阻塞、不得开工

`D2-03` · `D3-05` · `D4-03` · `D4-04` · `D5-04` · `D5-05` · `D5-08`

### 解锁条件（缺一不可）

| 目标 | 解锁需要 |
| --- | --- |
| 跨平台 COMPLETE / 发布 | Windows 16 项缺口真机实测通过 |
| 不可信 Plugin / Skill 执行 | OS-level sandbox 方案（第 14 节 A/B/C）落地并实测；内存与网络 OS 级强制同时成立 |
| `D5-04` / `D5-05` | 各自取得真实运行证据（Photoshop UXP 桥接实测；Illustrator 安装 Beta 后重做） |
| `D4-03` / `D4-04` | Harness 真工具链路端到端通过 + D3-03 设备层完成 |

---

## 22. 证据与复现

```bash
# ancestry 审计
git log --graph --oneline --all --decorate
git merge-base feature/d1-03-adobe feature/d1-05-service-isolation   # b39eb93
git merge-base feature/d1-04-design-performance feature/d1-05-service-isolation  # b39eb93
git merge-base feature/d1-04-design-performance feature/d1-02-harness  # b39eb93

# 集成正确性
npm test                # 7/7 PASS
npm run build           # tsc --noEmit && vite build
npm run test:security   # 9 探针；FAIL 0 / PASS 6 / PARTIAL 3

# 各轮证据
docs/decisions/D1-01-desktop-native-view.md
docs/decisions/D1-02-harness.md
docs/decisions/D1-03-adobe.md
docs/decisions/D1-04-design-performance.md
docs/decisions/D1-05-service-isolation.md   # 另见 §30 口径修正 addendum
```

**ADRs in this tree**：D1-01 · D1-02 · D1-03 · D1-04 · D1-05 —— 五份首次共处同一棵树。

> **未取得真实证据的项目一律 `NOT VERIFIED`。安全边界不以"理论上应该安全"通过。**
