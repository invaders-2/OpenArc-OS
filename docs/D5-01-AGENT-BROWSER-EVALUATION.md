# D5-01 · agent-browser 兼容性验证（OpenArc 内置浏览器）· 2026-09-20

> 结论先行：**有条件采用**（见 §8）。本轮**没有替换、删除或停用任何既有实现**；
> agent-browser 只在一个**独立测试设施**里运行；是否正式引入/替换需另行决策。
> 兼容性验证通过与否以"真实内置标签页"为准：本轮真实标签页 24 项检查 **23 PASS / 1 FAIL**，
> 唯一失败项是 agent-browser 自己的导航命令不返回（动作实际生效，见 A5/A5b）。

---

## 1. 现场核对（专用工作树）

| 项 | 值 |
| --- | --- |
| 工作树 | `/Users/wepingli/Desktop/OpenArc OS-d4-01`（专用 D4/D5 工作树，本机路径不入库） |
| 分支 | `feature/d4-03-tool-proxy` |
| 任务开始时 HEAD | `3c64a3cbd4c082385c3bbad8fed57b6cda3ac57c`（干净） |
| 本轮产品代码提交 | `2411f109894950b6dc7921113a9a4b185d2a7262`（内置浏览器真实标签页；见 §3.1） |
| 未提交改动（本轮结束时） | 只有测试设施：`experiments/d5-01/site.mjs`、`experiments/d5-01-agent-browser/` |
| 并发工作 | 未触碰默认工作区（`/Users/wepingli/Desktop/OpenArc OS`，d3-02 分支）与 `OpenArc OS-integration`；未 push、未合并 main |
| 远端 | 未 push（`git log origin/feature/d4-03-tool-proxy..HEAD` 仍包含本轮全部提交，与既有一致） |

**任务开始时的事实**：HEAD `3c64a3c` 上的内置浏览器**只有"一个窗口一个原生视图"**，没有标签页模型。
真实标签页是本轮作为**必要前置**补上的产品能力（§3.1），先提交（`2411f10`）、再在干净导出树验证、
最后单独提交本报告与证据（`docs/D5-01-AGENT-BROWSER-EVIDENCE.json`）。

---

## 2. 被测对象与固定版本

| 项 | 值 |
| --- | --- |
| 候选项目 | `https://github.com/vercel-labs/agent-browser` |
| **固定版本** | **0.38.1**（本轮实测版本；未追随浮动 latest） |
| 许可证 | **Apache-2.0**（npm 元数据 + 仓库 LICENSE） |
| 运行时依赖 | **无**（npm 包 `dependencies` 为空，随包分发原生 Rust CLI；本机 Node 22.22.3 下可运行，包内声明 engines 为 Node ≥24） |
| 安装方式 | `npm i agent-browser@0.38.1` 到**临时独立目录**，不写入产品 `package.json`、不进入产品启动路径 |
| 自身 Chrome | **未安装、未使用**（未执行 `agent-browser install`）：本轮只把它当作"连到既有浏览器"的客户端 |
| 连接方式 | 真实 `electron .` + `--remote-debugging-port=<port>`（**仅本机 127.0.0.1、仅本次运行**）→ `agent-browser --cdp <port>`，再用 `--pin-tab` + CDP targetId 把会话钉在指定标签 |

连接与目标选择的两条实测事实（对正式接入很关键）：

1. **必须"先 list、再绑定、后加 pin"**：无绑定直接 `--pin-tab` 会让 CLI 调 `Target.createTarget`，
   而 **Electron 的 CDP 不支持该端点**，直接报 `CDP error (Target.createTarget): Not supported`。
2. **`--pin-tab` 是"标签固定"，不是权限隔离**：控制连接能看到并且能另行绑定到 OpenArc 界面页
   （`file://…/dist/index.html`），见 B1/B2。

---

## 3. 现有自研浏览器与 Agent 控制能力盘点（本轮重点）

### 3.1 自研浏览器（产品内，提交 `2411f10`）

| 能力 | 实现位置 | 状态/证据 |
| --- | --- | --- |
| 真实网页视图（非 iframe） | `electron/native-view-controller.cjs`（`WebContentsView`，按 App+用户分区） | 真实 `electron .` 门禁 P0/P1 PASS |
| **真实标签页（每标签一个原生视图）** | 同上（`viewId = windowId#tabId`，非活动标签保持存活但隐藏） | 门禁 T1–T6 PASS；`tests/d5-01-browser-tabs.test.mjs` 9/9 |
| 标签模型/命令（开/关/切/状态） | `electron/window-domain.cjs`、`window-manager.cjs`（`browser/tab-*`） | 同上；`tests/d5-01-browser-policy.test.mjs` 5/5 |
| 地址栏/前进后退/刷新/加载与错误重试 | `src/browser/BrowserApp.tsx` + `browser:navigate`/`browser:action` IPC | 门禁 N1–N8、S1–S3 PASS |
| 下载（入口/进度/完成/失败/真实落盘） | `electron/browser-downloads.cjs` | 门禁 D1–D5 PASS（文件字节比对一致） |
| 弹窗/外链/外部协议/证书错误/文件上传/权限 | `native-view-controller.cjs`（会话级策略） | 门禁 P1–P10 PASS |
| 会话/用户隔离（A04） | 分区 `openarc-app-browser-u-<userId>`；按用户持久化 `oa-wins:<userId>` | 门禁 A04-1…A04-10 PASS |
| 网页与系统桥隔离（A13） | 视图无 preload；页面内 `openarc/require/process/module/ipcRenderer` 全 undefined | 门禁 A13-1…A13-3 PASS |
| 原生视图与窗口配合（A12） | `electron/occlusion.cjs` + 控制器四态 + 菜单/面板整块让位 | 门禁 A12-1…A12-8 PASS（6/8 为状态与输入证据，像素级层级见 §7 限制） |
| 干净版本门禁 | `npm run test:d5-01`（真实 electron .，58 项） | 干净导出树 `2411f10`：**57/58**，唯一失败 R2（重启后活动标签 URL 落后一次导航，已登记） |

### 3.2 现有 Agent 控制能力：**没有浏览器控制工具**

- **Tool Registry 当前只有 6 个工具**：`resource.read.metadata / resource.search / resource.trash /
  test.echo / test.noverify / test.write` —— **没有任何 `browser.*` 工具**。
- AI/任务侧对浏览器的唯一入口是渲染层 IPC（`browser:navigate` / `browser:action`），
  它服务于**人操作 UI**，不是 Agent 工具面；网页视图没有 preload，远程页面拿不到任何桥。
- 现有的受控执行链是 **Tool Registry → Controlled Tool Proxy → SideEffect Authority（审批/租约/停止/审计）**；
  浏览器动作**尚未**接入这条链。
- 因此：**"Agent 控制浏览器"在 OpenArc 内目前是空白**，PLAN §8 的要求（"AI 控制浏览器须通过明确工具与授权，
  记录目标标签和执行结果"）尚未落地。

### 3.3 agent-browser 补充了什么、与现有代码哪里重复

**它补充的（自研没有、也不打算自己造的）**：

1. **面向 Agent 的定位语义**：accessibility snapshot + `@eN` ref（比裸 CSS 选择器更适合模型）。
2. **稳定的标签句柄**：CDP `targetId` 跨 daemon 重启稳定；`t N` 计数器句柄 + label。
3. **严格绑定语义 `--pin-tab`**：被钉标签关闭后一律 `tab_gone` 明确失败，**不会静默转到别的标签**（G1/G2 实测）。
4. **会话/守护进程模型**：每个 session 独立 cookies/storage/历史；CLI 与 MCP/Skill 两种形态共用同一实现。
5. **动作级 JSON 结果**（含生命周期元数据），便于审计与断言。

**它与现有实现重复/交叉的地方（必须由 OpenArc 保持权威）**：

| 交叉点 | agent-browser 的做法 | OpenArc 现有做法 | 处置建议 |
| --- | --- | --- | --- |
| 标签选择与生命周期 | 按 CDP target 绑定/切换 | Window domain 持有 `meta.tabs` + 每标签一个 `WebContentsView` | **不要让它成为第二份标签状态**；targetId 只作为"绑定句柄"，标签增删仍由 Window Manager 决定 |
| 会话/profile | 自带 daemon/profile（若用它的 Chrome） | 分区 `openarc-app-browser-u-<userId>`，按用户隔离 | **禁止引入它的 profile/Chrome**；只 attach 到我们的视图 |
| 导航 | `open`/`goto`（实测在本组合挂起） | 产品地址栏 + `browser:navigate`（真实可用） | 导航**继续由 OpenArc 负责**，Agent 只做页内操作 |
| 权限/审批/停止/审计 | 无（CDP 直连，绕过 D4） | Tool Registry + 审批 + 租赁 + 停止 + 审计 | **正式接入必须经 OpenArc 代理**，否则记为阻塞（§6） |
| 脚本执行 | `eval` 任意 JS | 无（且禁止暴露给模型） | `eval` 只用于测试；**不得进入模型工具面** |

**一句话**：它补充的是"页内操作 + Agent 友好的定位/句柄语义"；它**替换不了**我们的浏览器栈，
它重复的三块（标签选择、会话状态、导航）必须继续以 OpenArc 为唯一权威。

---

## 4. 逐项检查（预期 / 实际 / 证据）

全部检查由 `node experiments/d5-01-agent-browser/eval.mjs` 在**真实 `electron .`**上执行，
使用独立测试账号、临时浏览器数据目录、本地受控站点（`experiments/d5-01/site.mjs`）。
完整 CLI 调用记录见 `artifacts/d5-01-agent-browser/agent-browser-eval.json`（工作树本地）
与脱敏摘要 `docs/D5-01-AGENT-BROWSER-EVIDENCE.json`。

### 4.1 前置：真实内置标签页

| # | 检查 | 预期 | 实际 | 证据 |
| --- | --- | --- | --- | --- |
| P0 | 内置浏览器具备真实标签页 | 存在 `WebContentsView` 标签 | **通过** | CDP target 清单含 `http://127.0.0.1:5391/form` |
| P1 | 两个标签各自独立 target | 两个 target | **通过** | `/form` + `/page2` |

### 4.2 连接与目标选择

| # | 检查 | 预期 | 实际 | 证据 |
| --- | --- | --- | --- | --- |
| C1 | `--cdp` 连接并列出标签 | exit 0 + JSON | **通过** | `tab list --json` 返回 tabs/targetId |
| C2 | 可见范围如实记录 | 界面页与网页都在清单 | **通过** | 清单含 `file://…/dist/index.html` 与 `/form`（→ B1/B2） |
| C3 | 钉到指定网页标签 | exit 0 | **通过** | `tab <targetId>` 绑定 + `--pin-tab` 生效 |
| C4 | **操作落在指定网页标签，而不是管理界面** | 网页 `/form`、无外壳 DOM | **通过** | `eval` 返回 `{href:/form, shell:false, form:true}` |

### 4.3 读 / 点 / 输入 / 滚动 / 导航

| # | 检查 | 预期 | 实际 | 证据 |
| --- | --- | --- | --- | --- |
| A1 | 读页面 | title=FORM | **通过** | `get title` |
| A2 | 输入并读回 | `openarc-agent` | **通过** | `fill #name` + `get value` |
| A3 | 点击 + 可核查结果 | `echo:openarc-agent` | **通过** | 页面自身把输入回显到 `#echo` |
| A4 | 滚动 | scrollY > 0 | **通过** | `scroll down 600` + `eval scrollY` |
| A5 | **导航命令返回** | exit 0 | **失败（阻塞项）** | `open <url> --json` 在 30s 超时（exit -1、无输出） |
| A5b | 导航动作是否真的生效 | URL 变为目标 | **通过** | 挂起后 `get url` 证实 URL 已是 `/page2` |

### 4.4 刷新 / 导航后的旧 ref

| # | 检查 | 预期 | 实际 | 证据 |
| --- | --- | --- | --- | --- |
| R1 | 刷新后旧 ref 不误点，重新快照后可用 | 重新识别页面 | **通过** | 产品刷新 → 旧 ref 点击未造成错误状态；重新 `snapshot` 后 ref 点击成功 |

### 4.5 双标签 + 用户切换焦点

| # | 检查 | 预期 | 实际 | 证据 |
| --- | --- | --- | --- | --- |
| T1 | 用户切换活动标签后，Agent 仍操作被钉住的标签 | 路径与 before 相同 | **通过** | 用户在 OpenArc UI 切到 t2 后，Agent 读到的仍是被钉标签的路径 |
| T2 | 用户的标签状态未被 Agent 改写 | 界面活动标签仍是 t2 | **通过** | `data-tab-active` 未被 Agent 改动 |

### 4.6 指定标签关闭 / 登出后的旧控制对象

| # | 检查 | 预期 | 实际 | 证据 |
| --- | --- | --- | --- | --- |
| G1 | 被钉标签关闭后命令明确失败 | exit≠0 + `tab_gone` | **通过** | 关闭 t1 后命令返回 `tab_gone` |
| G2 | 不自动转向其它标签 | 只剩 t2 | **通过** | target 清单只剩 `/page2` |
| L1 | 登出后旧控制会话不能再操作 | exit≠0 | **通过** | 登出释放全部视图，命令失败 |
| L2 | 旧会话没有悄悄接管界面页 | 无网页标签残留 | **通过** | target 清单无 `/form`、`/page2` |

### 4.7 边界（如实记录，不作为"安全"的证明）

| # | 检查 | 预期 | 实际 | 证据 |
| --- | --- | --- | --- | --- |
| B1 | 控制连接能看到界面页 target | 能看到（如实记录） | **通过（记录缺陷）** | 清单含 `file://…/dist/index.html` |
| B2 | **标签固定 ≠ 权限隔离** | 可另行绑到界面页 | **通过（记录缺陷）** | 第二个 session 绑到界面页后能读到其 DOM |
| B3 | 调试端口只在本机监听 | 127.0.0.1 | **通过** | `lsof` 显示 127.0.0.1 监听 |
| B4 | 产品退出后调试端口关闭 | 无监听 | **通过** | 退出后 `lsof` 为空 |
| B5 | 常规产品启动不永久开放调试端口 | 产品入口无该开关 | **通过** | `grep remote-debugging electron/main.cjs package.json` 为空 |

**未验证**（不得写成通过）：只覆盖本地受控站点（不代表任意网站兼容）；未做真实模型自主规划（本轮要求）；
Windows 未验证；`open` 挂起的**根因**未定位（只记录行为与对照）。

---

## 5. 本轮没有替换/删除/停用任何既有实现

- 产品侧唯一的改动是**新增**标签页能力（`2411f10`）：`native-view-controller.cjs` 由"单视图"扩展为
  "每标签一视图"，**旧调用路径全部保留**（无 `views` 意图时仍按 `windowId#t1` 走单视图；
  `destroy(windowId)`、`partitionFor(appId)` 的旧签名与旧分区名逐字兼容）。
- agent-browser **没有**进入产品依赖、没有进入启动路径、没有产生任何产品代码分支；
  它只被 `experiments/d5-01-agent-browser/eval.mjs` 以子进程方式调用。

---

## 6. 正式接入还需要哪些权限与生命周期控制（阻塞项清单）

1. **工具面**：新增 `browser.*` 工具（read/click/fill/scroll/snapshot…），全部经
   **Tool Registry → Controlled Tool Proxy → SideEffect Authority**；写类动作走审批，读类动作至少留审计。
   —— 现状：agent-browser 的动作**完全绕过** D4 工具门/审批/停止（**阻塞项**）。
2. **目标白名单**：控制会话只能绑定"OpenArc 自己创建的浏览器分区视图"（`openarc-app-browser-u-<userId>`），
   **禁止**绑定 `file://` 界面页、其它 App 的原生视图或任何非本用户视图（实测 B2 可绕过 → **阻塞项**）。
3. **身份绑定与撤权**：控制令牌绑定 `userId + windowId + tabId`；登出/切账号/撤销控制资格立即失效
   （实测登出已满足，但需要由工具层**显式**持有，而不是依赖标签被杀）。
4. **停止语义**：agent-browser **没有** pause/stop；OpenArc 必须实现"停止 = 撤销控制令牌 + 关闭控制通道"，
   并保证停止后不再有新动作、已发出的动作如实记录（本轮 A5 的"命令挂起但动作生效"正说明**必须由我们兜底**）。
5. **生命周期**：控制会话 TTL/并发上限/空闲回收；调试端口按需开启、用完即关（实测 B3/B4/B5 已满足）。
6. **禁止能力**：不把 `eval` / 任意脚本执行 / 无限制浏览器命令暴露给模型（本轮 `eval` 只用于验证）。
7. **模型接入**：后续模型的 API/密钥一律走 OpenArc 既有设置与模型服务，**不新增独立密钥设置**。

---

## 7. 限制（如实）

1. 只验证了**本地受控站点**（确定性页面），不能外推为"任意网站兼容"；复杂登录、企业认证、媒体播放未验证。
2. 本轮不做模型自主规划，全部是确定性操作。
3. 单机单屏、macOS；Windows 未验证。
4. 浏览器 chrome 与原生视图的**像素级层级**（标签栏/地址栏是否被网页覆盖）尚未取得 OS 级仪器证据，
   在 D5-01 浏览器门禁里记为 NOT VERIFIED（与 agent-browser 结论无关）。
5. D5-01 浏览器门禁在干净导出树上为 **57/58**，失败项 R2（重启后活动标签 URL 落后一次导航）已登记。

---

## 8. 结论与建议

### 结论：**有条件采用**（不建议现在直接引入产品；正式替换需另行决策）

**判定依据**

- ✅ 真实内置标签页上的 24 项检查 23 PASS：连接、目标选择（不误操作管理界面）、读/点/输入/滚动、
  双标签下的目标稳定、标签关闭/登出后的旧控制对象失效、权限与端口边界，均有实测证据。
- ❌ 1 项失败且属**集成阻塞**：导航命令 `open`/`goto` 在 Electron CDP + `--pin-tab` 组合下不返回
  （动作生效但命令挂起）；另外 `--pin-tab` 不构成权限隔离、它完全没有停止/审批语义。
- 因此**不能**判定为"可采用"，也不能判定为"不适合"——它证明了自己能驱动我们的真实标签页，
  但**必须**由 OpenArc 包一层权限/审批/停止/审计才谈得上接入。

**建议的采用形态（若决定引入）**

- agent-browser 只作为**页内操作执行器**，绑定 OpenArc 提供的"目标标签"（targetId 由我们下发、我们校验）；
- **导航、标签增删、会话/分区、权限、审批、停止、审计**全部留在 OpenArc；
- 不引入它的 Chrome/profile/daemon 作为产品浏览器栈；不把它作为旁路；
- 先补 §6 的 1/2/4 三项阻塞项，再谈接入试点。

**是否可以不引入**

可以。若对 Agent 的要求只到"页内读取/点击/输入/滚动"，OpenArc 完全可以基于我们**已经持有**的
`WebContentsView`（同一 CDP 端点）自研一个同子集的工具层；代价是要自己补 accessibility 定位与
标签句柄语义。**agent-browser 的价值主要在"Agent 友好的定位 + 严格的标签绑定语义"，不在浏览器本身**——
它替代不了我们的浏览器栈，也不应该被当成第二套浏览器。

**不进入下一阶段**：本轮到此为止，不进入 D5-02，不扩大 D4 既有验收结论。
