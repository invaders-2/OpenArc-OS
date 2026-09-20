# D5-01 Closure-2 · 受控浏览器能力产品闭环（唯一口径 · 2026-09-20）

**基线 `0094e17866a2937d61eebc88b382e42694148d98` → 代码/测试提交 `ad02474`**；分支 `feature/d4-03-tool-proxy`；未 push、未合并 main、未触碰其它工作区（含另一个正在运行的 `OpenArc OS.app` 实例）。

本轮把上一轮只到服务层的受控浏览器能力（`6c86502`）接成**真实产品链**，并逐项回答"哪些是真做到了、哪些做不到、哪些没验证"。

---

## 1. 模型可见面裁决（§2）

**结论：保留 `FORBIDDEN_HARNESS_TOOLS` 全部条目，不新增任何前缀通配、不删项；把两个受控工具加入 READ/WRITE allowlist。**

- `FORBIDDEN_HARNESS_TOOLS` 的匹配方式是**精确字符串**（`advertised.includes(bad)`），它限制的是 **Harness 内置工具**（`shell` / 内置 `browser` / `run_code` / CDP 旁路 …）。
  受控工具广播出去的名字是 `browser_read_page` / `browser_navigate`（点号→下划线），与裸 `browser` **不是同一个字符串**，因此不存在"误拦"。
- 正反对照（`tests/d5-01-browser-control-surface.test.mjs`）：正例 = 两个受控工具必须在册且 `browser.navigate` 走 `SIDE_EFFECT_PROPOSAL`；反例 = `browser` / `cdp` / `web` / `run_code` / `shell` / `eval` / `script` 一律不得出现在广播面。
- `tests/tool-registry.test.mjs` 里"browser 一律禁止"的前缀断言改成**精确口径**：非受控的 `browser.*` id 仍拒绝，且任何注册项都不得命中 Harness 旁路名（与 `dsh-tool-profile` 同源）。
- 新增独立 Tool 权限 `tool.browser.read` / `tool.browser.navigate`（**读取权限绝不隐含导航权限**），`tests/governance-tool-grant.test.mjs` 的 `availableActions` 断言取自常量，自动覆盖新动作。

## 2. 产品接线（§3）

| 环节 | 实现 | 证据 |
| --- | --- | --- |
| 用户选择/授权/查看/撤销目标 | 浏览器 chrome（标签栏右侧）新增 `[data-ai-control-toggle]`：off/on 状态、`data-ai-control-count`、已授权标签在标签栏标 `data-ai-control-authorized`；主进程列表经 `browser/controlList` 回读 | E2E U3–U6、S4.2、U7 |
| IPC / preload 最小面 | **复用既有 `browser:command` 通道**新增 `browser/controlList` / `controlSelect` / `controlRelease`；**不新增桥键、不新增 IPC 通道**（D2 冻结清单 14 键 / 10 通道不变） | D2 探针 `sec.bridgeKeysMatchFrozenList` / `sec.ipcChannelsMatchFrozenList` 16/16 PASS |
| `executionProvider=BrowserControl` 执行适配器 | `electron/tool-adapters.cjs` 新增 BrowserControl provider（plan/execute/verify），与 Resource/Search **同一条装配**（`task-bootstrap` → `createToolAdapters`） | `tests/d5-01-browser-control-chain.test.mjs` 5/5 |
| 导航走 propose→approve→lease→claim→execute | `browser.navigate` = REVERSIBLE_WRITE + `CONTROLLED_REVERSIBLE_WRITE` + `READ_AFTER_WRITE`；目标与地址随 plan 持久化（`preconditions.targetRef/url`），execute 只用持久化 plan | E2E S2.0–S2.7（真实审批面板 → 真实导航 → 真实验证） |
| 读取走工具授权 + 预算 + 审计 | READ 经 `ControlledToolProxy.propose → executeReadOnly`（reauthorize + 预算 + 审计），正文有界 4000 字符、标 `untrusted:true` | E2E S1.0–S1.6；`tests/d5-01-browser-control.test.mjs` 9/9 |
| Task / Step / Call / result / error 收敛 | 复用既有 Task Runtime：READ = 1 execution（SUCCEEDED/FAILED），WRITE = 1 SideEffectCall + 1 lease + 1 approval，Task/Step 终态由既有收敛逻辑决定 | E2E S1.2 / S2.5 / S3.1 / S3.4 / S4.1 / S6.1–S6.3 |
| 审批绑定"这个目标 + 这个地址" | 审批投影新增 `targetRef` / `url`（仅安全字段）；用户看得见被批准的目标标签与被批准的地址 | E2E S2.1 / S2.2；`approvalSnapshot` 只放行固定白名单字段 |

## 3. 诚实的执行边界（§4）

1. **执行前重新校验**：目标仍在授权表、视图仍存活、分区 sessionKey 仍是本人、URL 仍是真实 http(s) —— 每次操作都跑，绝不"选一次用到底"。
2. **失效即拒绝、绝不回落**：未授权 viewId / UI 撤权 / 关标签 / 登出 / 切账号后旧目标立即失效，**绝不**改绑到当前活动标签或管理界面（E2E S4.1–S4.4）。
3. **导航的"发生"以真实文档地址为准**：`WebContentsView` 的 `entry.url` 是"意图地址"（请求一发出就被乐观写入），因此新增 `liveUrl()` / `waitForCommit()`，只认 `webContents.getURL()` 且已停止加载：
   - 落地到批准地址 → `redirected:false`；
   - 服务器 302 落地到别的地址 → `redirected:true`（**如实标记，绝不假装"就是去了批准的那个地址"**）；
   - 等不到落地 → `BROWSER_CONTROL_NAVIGATE_UNCONFIRMED` + `dispatched:true` → 调用方按**结果不可知**处理（`ambiguous`），**绝不猜成功、也绝不写"已回滚"**。
4. **URL / 协议 / 跳转策略两层**：工具门 schema 就把 url 收窄为 `^https?://[^\s@]+$`（拒绝 `file:` / `javascript:` / 含凭据 / 非 http(s)），执行前再过一次产品 `safeURL`。两层都拒绝，绝不只靠一层（E2E S5：三个非法 URL → 提案 `INVALID/TOOL_ARGUMENT_INVALID`、0 SideEffectCall、0 导航）。
5. **正文是不可信参考数据**：`untrusted:true`、单次上限 4000 字符、不进审计、不进日志；绝不读 Cookie/令牌/密码。**"4000 字符上限" ≠ 已去敏** —— 它是原始页面文本，只是有界且被标注为不可信。
6. **进程局部 Domain 的显式例外（本轮唯一的架构级声明）**：
   - 受控浏览器导航的 Domain 是 **main 进程内的原生 `WebContentsView`**，out-of-process supervised executor 结构上无法执行它（child 里既没有、也不该有原生视图权威）。
   - 因此 `SideEffectRuntime` 新增**显式 in-process execution class**（`IN_PROCESS_EXECUTION_PROVIDERS = ["BrowserControl"]`，静态白名单）：**lease / claim / exactly-once / verify 全部仍由同一个 `SideEffectAuthority` 裁决**，但**没有**独立 executor 进程的寿命证据（没有 child exit / socket lifetime）。
   - 这条差异**不隐藏**：每次 in-process 派发都落审计 `side_effect.execution_placement = IN_PROCESS/PROCESS_LOCAL_DOMAIN`。
   - **它不等价于其它 WRITE 的 out-of-process 路径**，这一条限制写进本报告而不是写在注释里。

## 4. 真实产品链 E2E（§5）

`node experiments/d5-01/browser-control-e2e.mjs`（= `npm run test:d5-01-control`，含 `npm run build`）：**真实 `electron .` + 真实 preload + 真实 UI（Dock 打开浏览器 / 地址栏 / AI 面板 / Trusted Approval UI / 治理授权 UI）+ official dsh（ACP v1）+ 真实 Tool Registry / Proxy / SideEffectAuthority + 真实本地受控站点 + 真实 WebContentsView**；只替代"最后一跳 provider 网络"。

六个场景（每个都有真实执行证据，不是等价物）：

| 场景 | 结果 | 关键证据 |
| --- | --- | --- |
| S1 读取闭环 + 不可信正文（含恶意页面注入） | PASS 7/7 | 真实读取 1 次 SUCCEEDED/PASS；正文以 `untrusted` 回到模型；**审计表里没有正文**；注入文本**没进** system/developer 高信任消息；0 自动工具调用、地址不变 |
| S2 导航获批闭环 | PASS 8/8 | 审批面板显示目标+地址 → 批准 → SideEffectCall SUCCEEDED + READ_AFTER_WRITE PASS + 恰好 1 lease；**真实视图**到达 PAGE2-MARKER；执行地址 = 被批准地址（plan 持久化） |
| S3 导航被拒 | PASS 5/5 | 用户 DENY → call BLOCKED、0 lease、0 execution、真实地址不变、UI 无"已回滚"式幻觉文案 |
| S4 目标失效 | PASS 5/5 | 未授权 viewId → FAILED `BROWSER_CONTROL_NOT_SELECTED`；UI 撤权后同一 viewId 立即失效；关标签后主进程授权目标被摘掉（1→0）；重新授权新标签得到**新的**稳定身份 |
| S5 URL 与协议策略 | PASS 4/4 | `file:` / `javascript:` / `https://u:p@…` 三个非法 URL 全部在**工具门**被判 `INVALID/TOOL_ARGUMENT_INVALID`，0 SideEffectCall、0 导航 |
| S6 停止与预算 | PASS 5/5 | 审批等待中取消 → 任务终止 + 该 call 收敛 `BLOCKED/TASK_CANCELLED`、0 lease、地址不变；12 次读取计划被工具预算截停（成功读取 ≤ 上限 8、任务不假装成功）；UI 如实显示停止原因 |

- 产物：`artifacts/d5-01/d5-01-browser-control-e2e.json`（逐项 expected/actual）、`…-operation-record.jsonl`（连续操作记录）。
- 仍**未验证**（如实登记，不冒充）：崩溃/强杀后的控制目标恢复（不在本轮契约内，重启即清空授权）；像素级层级真值（本机屏幕被另一个正在运行的 OpenArc 实例占用，无法独占前台截图）。

## 5. 安全面启动同步修复（§6）

- **根因（实测，不是猜测）**：D2-02 的 `security-surface` 探针在**共享的 Electron 默认 userData** 里加载真实产品 `main.cjs`，而该目录下的 `identity.db` 是 `schema_version=17`，本工作区代码支持到 16 —— 产品**正确地**拒绝打开，探针却只表现为"外壳窗口 8 秒内没出现"，把**仪器隔离缺陷**伪装成产品缺陷（`probe.error: 等待超时：外壳窗口`）。
- **修法（两步，都不是"等更久"）**：
  1. 产品侧新增**唯一就绪信号** `markProductReady()`（外壳窗口已创建 + 全部 IPC 已注册 + 外壳页已开始加载）→ `globalThis.__OPENARC_PRODUCT_READY__` + `app.emit("openarc:product-ready")`；探针改为等这个信号（拿不到就明确报"产品未报告就绪"，不再报"超时"）。
  2. 探针宿主（`experiments/d2-02/native/main.cjs`）在 app ready 之前 `app.setPath("userData", mkdtemp)`，与 D4 main E2E / D5-01 E2E 同口径地**隔离数据目录**。
- **修复前后**：修复前 `6/6 checks + probe.error`（退出码 1）；修复后 **16/16 PASS、退出码 0**，就绪信号 `waitedMs=70`（`alreadyReady=false`），**运行时那半段检查（桥接面 / 无 Node 全局 / 不可信视图 / 策略拒绝）第一次真正跑起来**。

## 6. 干净版本验证（导出树 `git archive ad02474` + 软链 node_modules）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `node --test tests/d5-01-browser-control.test.mjs tests/d5-01-browser-control-chain.test.mjs tests/d5-01-browser-control-surface.test.mjs tests/tool-registry.test.mjs tests/tool-execution-security.test.mjs tests/governance-tool-grant.test.mjs` | **38/38 PASS** | 0 |
| `node experiments/d2-02/security-surface.mjs` | **16/16 PASS** | 0 |
| `npm run test:d5-01`（真实 `electron .` 浏览器门禁） | **64/64 PASS**（1 NOT VERIFIED：崩溃持久化） | 0 |
| `node experiments/d5-01/browser-control-e2e.mjs`（本轮新增真实产品链） | **46/46 PASS**（2 NOT VERIFIED） | 0 |
| `npm run test:d4-03d`（D4 全工具门禁回归） | **52 通过 / 0 断言失败**，但**运行不稳定**：1 个文件级超时（见下） | 1 |

**如实登记的既有不稳定（不掩盖、也不冒充通过）**：本轮 4 次运行 `npm run test:d4-03d` 中，有 3 次出现**同一个症状**——official dsh 的 ACP tool-loop 用例在**某个文件**上被 `--test-timeout=180000` 判为文件级超时，而该文件内**所有真正跑到的断言都是 ok、`# fail 0`**；三次分别是 `tests/tool-dsh-security.test.mjs`、`tests/tool-d4-03d-e2e.test.mjs`、`tests/tool-dsh-e2e.test.mjs`（互不相同）。单独运行这些文件各自通过（`tool-dsh-security` 14/14 用时 4.9s；`tool-d4-03d-e2e` 5/5；`tool-dsh-e2e` 3/3），干净导出树上的同一条命令同样复现（52/53、0 断言失败、exit 1）。**同一条命令在基线 `0094e17` 的干净导出树上同样复现**：`43 tests / 42 pass / 0 fail / 1 文件级超时（`tests/tool-d4-03d-authority.test.mjs`，一个**纯单测**文件）/ exit 1` —— 即这个不稳定**不是本轮改动引入的**（本轮改动前就存在，且与 ACP 无关的文件也会命中）。因此：**本轮不把 `test:d4-03d` 记作 PASS**，登记为"断言全绿 + 运行不稳定（文件级 180s 超时，随时机命中不同文件）"，属既有仪器/运行环境问题，需单独查清后才能封板。

## 7. 结论

- 上一轮列出的"未接线"①–⑥ 中，①②③④⑤ 已在本轮落地并有真实产品链证据；⑥（可见性：真人鼠标路径 + 连续截图/录屏）**仍未取得**（本机屏幕被另一个正在运行的 OpenArc 实例占用，不冒充像素证据）。
- **D5-01 维持 PARTIAL**：PLAN §8 的"AI 控制浏览器（明确工具与授权、记录目标标签与执行结果）"已经**有真实产品链闭环**，但下列原始必需项/边界仍未闭合：崩溃恢复、高 DPI、多屏、Windows、任意网站兼容、像素级层级真值、以及 in-process 执行类与 out-of-process 执行类**不等价**这一限制（按既有 D4 契约它不属于"已验证等价"）。
- 不因本轮升级 D4 结论；agent-browser 仍冻结为独立实验（不进产品依赖 / 启动路径 / Agent 工具列表）；本轮停止，不进入 D5-02。
