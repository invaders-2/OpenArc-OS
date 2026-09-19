# D5-01 Closure · 最小受控 AI 浏览器能力与验收补齐 · 2026-09-20

> **结论：D5-01 仍为 PARTIAL。** 本轮落地了最小受控能力的**内核与契约**（目标授权、归属校验、
> 稳定绑定、有界读取、受控导航契约、D2 安全面精确更新），但**尚未接入产品链路**：
> 用户选择入口、执行适配器、审批接线与产品链 E2E 都不在本轮证据里（§3 逐条列出）。
> 未把"服务层通过"冒充成"AI 控制闭环通过"。

## 1. 基线与不变量

| 项 | 值 |
| --- | --- |
| 基线（核对一致，干净） | `f93e8351279fcfec26bf0e1ef7fdca0a53a87a56` |
| 本轮代码/测试提交 | **`6c865023093855fee61f4db4ebb8a521764fc729`** |
| 报告提交 | 本文件 + `PROGRESS.md` + `docs/D5-01-CLOSURE-EVIDENCE.json` |
| 并发 | 未触碰默认 / integration 工作区；未 push、未合并 main |
| 原则 | 复用现有浏览器与工具门契约；agent-browser 保持独立实验状态（不进依赖 / 启动路径 / 工具列表） |

## 2. 本轮实现（最小受控能力）

### 2.1 已落地（代码 + 服务层测试）

| 能力 | 实现 | 证据 |
| --- | --- | --- |
| 目标标签由**用户在渲染层显式选择** | `browser-control-authority.cjs select()`：要求 `context.source==="user"`、账号匹配当前会话、标签存在且存活、**分区归属 = 本人**、URL 必须是 http(s) | `tests/d5-01-browser-control.test.mjs`（选择/归属/无效标签） |
| **稳定标签身份** | 目标键 = `windowId#tabId`（与原生 viewId 同口径），独立于"当前活动标签" | 同上：切标签不影响目标（绑定不随焦点漂移） |
| **每次执行前重新检查** | `readPage/navigate` 都先跑 `#verifyTarget`（目标在册、视图存活、归属本人、URL 合规） | 同上：关闭/撤销/切账号后立即拒绝 |
| 关闭/替换/撤销/登出/切账号 → 旧操作拒绝，**不回落** | `onTabClosed()` 摘除目标；`setSession()` 清空全部目标；`release()` 用户撤销；拒绝时**不触碰其它标签** | 同上：断言 `controller.navigate` 零调用 |
| 读取页面信息 + **有界正文** | `native-view-controller.readText()` 只读 `document.body.innerText`；authority 截断到 4000 字符、标记 `untrusted: true` | 同上：截断/不可信/不含 Cookie 类内容 |
| **不提取 Cookie / 令牌 / 密码**，正文不进审计与日志 | 读取路径只走 innerText；审计只记 action/decision/viewId/URL | 同上：审计里不含正文 |
| 导航复用产品导航与安全策略 | `navigate()` 走 `safeURL` + `NativeViewController.navigate(windowId,url,tabId)` | 同上：`file://`/`javascript:` 一律拒绝且零动作 |
| URL 去敏 | `safeUrlForAudit()`：去凭据、查询串、片段 | 同上 |
| **工具契约注册** | `browser.read.page`（READ_ONLY，无审批）；`browser.navigate`（REVERSIBLE_WRITE + `requiresApproval` + `CONTROLLED_REVERSIBLE_WRITE` + `READ_AFTER_WRITE`）—— **导航没有标成只读** | 同上：契约断言；`npm run test:d4-03d` 52/52 仍绿 |

### 2.2 **未接线**（本轮不冒充完成，逐条列出）

1. **用户选择目标的正式产品入口**（IPC / preload / 浏览器窗口 UI 按钮）**未实现** ——
   目前只能由服务层（与测试）调用 `select()`。
2. **执行适配器未接线**：契约 `executionProvider: "BrowserControl"` 尚无 `tool-adapters` 实现，
   工具门能授权但还不能真正执行这两个工具。
3. **导航尚未接到 SideEffectAuthority 的 propose → approve → lease → execute 链**：
   契约已声明副作用语义（不得绕过），但执行端接线未完成。
4. **产品链 E2E（真实 `electron .` + 确定性 provider + 产品 UI 的 AI 控制闭环）本轮未运行** ——
   因此"用户选择标签 A → Agent 读取并导航 A → 切到 B 仍只操作 A → 未授权/关闭/撤权/切账号拒绝 →
   停止与预算耗尽后不再动作 → 恶意页面不能越权"这一整组证据**尚不存在**（只有服务层证据）。
5. **模型可见面未接线**：`dsh-tool-profile.cjs` 的 `FORBIDDEN_HARNESS_TOOLS` 明确包含 `"browser"`，
   把浏览器工具暴露给 Harness/模型属**需裁决的契约变化**，本轮未擅自修改。
6. 预算/停止的产品级接线同样依赖 1–4（本轮未验证）。
7. 可见性（连续截图/录屏 + 真人鼠标路径）**未取得**：本机屏幕上另有正在运行的 OpenArc 实例，
   不做"拍别人窗口冒充通过"；保持 NOT VERIFIED。

## 3. D2 安全面清单（四个既有失败 → 逐项核对 + 精确更新）

| 检查 | 修复前 | 本轮处理 | 现在 |
| --- | --- | --- | --- |
| `sec.bridgeKeysMatchFrozenList` | FAIL：冻结清单停在 D2（11 个），实际 14 个 | 逐项核对**实际暴露面与守卫**后精确更新冻结清单（+browser、+sideEffect、+task） | **PASS** |
| `sec.bridgeExpandedOnlyByModel` | FAIL：断言写死"只允许 +model"，D4 起必然失败 | **替换**为否决用例 `sec.bridgeExpansionIsApproved`：相对 D2 基线只允许**已批准增量**且**不得移除**任何成员 | **PASS** |
| `sec.ipcChannelsMatchFrozenList` | FAIL：实际 10 条通道，清单 9 条 | 精确补 `browser:command`（该通道有 `trusted(e)` 守卫） | **PASS** |
| `sec.everyChannelTrustsSender` | FAIL（同一清单过期导致） | 清单修正后，10 条通道**全部**过 `trusted()` 校验 | **PASS** |

- 未把"当前所有接口"直接塞进允许列表：新增项在清单里逐条登记，并保留 `bridgeExposesNoRawIpv`、
  `everyChannelTrustsSender` 两个否决用例；**没有删除任何断言**。
- 残余（**非本四项**）：探针在真实主进程启动后等"外壳窗口"8s，D4 引入 runtime boot 后冷启动常超时
  （`probe.error: 等待超时：外壳窗口`）。本轮基线 `f93e835` 与更早的 `39d733d` 上**同样**失败，
  属既有仪器时序问题，未用"跳过"掩盖，如实登记。

## 4. D5-01 原始要求 → 证据映射

| 分组 | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| **自研浏览器** | 真实视图（非 iframe）/ 导航 / 标签 / 加载态 / 下载落盘 / 弹窗·外部协议·证书·上传·权限 / 用户隔离 / A12·A13 | ✅ | 上一轮与 R2 轮：`test:d5-01` 64/64（干净树 `6c86502` 复跑）；`docs/D5-01-RESULT.md` |
| | 会话保存与恢复（正常退出） | ✅ | R0–R5；崩溃/强杀 = NOT VERIFIED |
| **本轮 AI 控制支持范围** | 目标选择 + 归属/授权校验 + 稳定绑定 + 每次重查 + 生命周期拒绝 | ✅（服务层） | `tests/d5-01-browser-control.test.mjs` |
| | 有界读取 + 不可信标记 + 不碰凭据 + 审计去敏 | ✅（服务层） | 同上 |
| | 导航契约（副作用、需审批、不标只读） | ✅（契约） | 工具契约断言；`test:d4-03d` 52/52 |
| | **产品链闭环（工具门→审批→自研浏览器→结果与审计）** | ❌ **未接线** | §2.2 第 1–4 项 |
| | 预算/停止的产品级拒绝 | ❌ 未验证 | 依赖产品链接线 |
| | 恶意页面越权（取其他标签/管理能力） | ⚠️ 未验证（服务层已保证不回落；产品链未测） | 待 E2E |
| **可见性与安全面** | D2 安全面四项 | ✅ 已精确更新并 6/6 PASS | `experiments/d2-02/native/probes/02-security-surface.cjs` |
| | 真人鼠标路径 + 连续截图/录屏 | ❌ NOT VERIFIED | 本机另有实例占用屏幕，无法隔离取证 |
| **未验证项（不扩大承诺）** | 崩溃恢复、高 DPI、多屏、Windows、任意网站兼容、像素级层级真值 | ❌ NOT VERIFIED | `docs/D5-01-RESULT.md` §5 |

## 5. 干净版本实际检查（`git archive 6c86502`）

| 检查 | 结果 |
| --- | --- |
| 新增/受影响 node 套件（control/tabs/policy/tool-d4-03d×2/c4-gates/write-e2e/redaction） | **85/85 PASS** |
| `npm run test:d4-03d`（工具门禁） | **52/52 PASS**（`mixedTask: SUCCEEDED`） |
| `node experiments/d2-02/security-surface.mjs` | **6/6 checks PASS**（exit 1 仅因既有"外壳窗口"8s 超时） |
| `npm run test:d5-01`（真实 `electron .` 浏览器门禁） | **64/64 PASS**（1 NOT VERIFIED：崩溃持久化） |

## 6. 结论与停止

- **D5-01 = PARTIAL**：具体缺项 = §2.2 的 1–4（用户选择入口 / 执行适配器 / 审批接线 / 产品链 E2E 与预算·停止·恶意页面证据）
  + 可见性（真人鼠标路径与连续取证）+ 既有的崩溃恢复 / 高 DPI / 多屏 / Windows / 任意网站兼容。
- **只有原始必需项都有证据才判 PASS** —— 本轮不满足，故保持 PARTIAL。
- **不因本轮升级 D4 整体结论**（D4 仍 PARTIAL，既有 NOT VERIFIED 项不变）。
- agent-browser 保持独立实验状态；本轮未引入任何第三方依赖。
- **本轮完成后停止，不进入 D5-02。**
