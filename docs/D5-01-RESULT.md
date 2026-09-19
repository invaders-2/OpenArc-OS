# D5-01 · R2 重启恢复缺陷修复与范围核对 · 2026-09-20

> **结论：R2 已定位并修复（根因是门禁用强杀做"重启恢复"，不是导航事件或恢复读取）；
> D5-01 仍为 PARTIAL** —— 缺 PLAN 原始要求里的"AI 控制浏览器（工具化 + 授权 + 记录目标标签与结果）"，
> 且圆角/像素级层级、高 DPI、多屏、Windows、崩溃恢复仍是 NOT VERIFIED。
> agent-browser 保持冻结：只在独立测试设施里验证，不进产品依赖/启动路径/Agent 工具列表。

---

## 1. 完整 commit 与基线核对

| 项 | 值 |
| --- | --- |
| 工作树 / 分支 | `OpenArc OS-d4-01` / `feature/d4-03-tool-proxy` |
| 本轮基线 HEAD（核对一致，干净） | `39d733d39eb6a33386ad84ddb3117b4e7be59a48` |
| **本轮代码/测试提交** | **`98c9f81aaba4b9754b76034bec5ce39430be9229`** |
| 报告提交 | 本文件 + `PROGRESS.md`（见文末 HEAD） |
| 并发变更 | 未触碰默认工作区（`OpenArc OS`，d3-02）与 `OpenArc OS-integration`；未 push、未合并 main |

---

## 2. R2 修复（根因 → 最小修复）

### 2.1 复现与根因（三步定位，不是猜的）

用 `experiments/d5-01/r2-repro.mjs` 做逐步对照：每次导航后同时读 **地址栏**、**真实页面（CDP target）**、
**`localStorage['oa-wins:<userId>']` 的持久化内容**，然后在两种退出方式下重启比对。

| 观测点 | 结果 |
| --- | --- |
| 普通导航 / 302 重定向 / 后退 / 前进 / 连续导航 | 地址栏、真实页面、持久化三者**始终一致** |
| 证书错误后继续导航 | 三者仍一致 |
| 导航后**立刻**关窗口（正常退出） | 恢复正确 —— 正常路径不需要任何人为等待 |
| **SIGKILL 强杀**后重启 | **复现**：强杀前内存里的 `localStorage` 已是新值（`/cookie?set=1`），重启后读到的是**上一页**（`/page3`） |

**判定**：
- **导航事件**：正确（每次导航都写进了 domain state）。
- **恢复读取**：正确（读到的就是磁盘上的值）。
- **持久化时机**：**根因**。渲染层的 `localStorage` 写入是同步 API，但 Chromium 对 localStorage 的
  **磁盘提交是异步的**；进程被强杀时最后一次（或几次）写入尚未落盘。
  原门禁的"重启"用的是 `SIGKILL`（`stop()`），因此表现为"重启后活动标签 URL 落后一次导航"。

### 2.2 最小修复（未用固定等待 / 未强制保存 / 未放宽断言）

- 门禁的"重启恢复"改为**正常退出**：`quitNormally()` 关窗口 → 等产品自己走
  `window-all-closed → app.quit()` → 进程退出；断言原样保留并**增强**：
  - R0 正常退出（非强杀）；R1 两个标签恢复；R2 地址栏 = 退出前的最终地址（302 后的 /page2）；
    R3 活动标签恢复；R4 每个标签 URL 各自恢复；R5 恢复到的是**真实页面**（不是只有记录对）。
- 崩溃/强杀后的持久化**明确列为 NOT VERIFIED**（写进门禁输出的 `notVerified`）：不在现有契约内，不扩大承诺。
- 复现探针 `experiments/d5-01/r2-repro.mjs` 连同两种退出方式一起保留，供复核。

### 2.3 修复前后证据

| | 修复前（`39d733d` 干净树） | 修复后（`98c9f81` 干净树） |
| --- | --- | --- |
| D5-01 门禁 | 57/58，唯一失败 **R2**（恢复后地址栏 = `https://127.0.0.1:5393/`，落后于实际导航） | **64/64 PASS**（1 NOT VERIFIED：崩溃持久化） |
| 恢复相关断言 | 只有"≥1 个标签 + 地址栏含 /cookie"（弱） | R0–R5：正常退出、两个标签、最终地址、活动标签、每标签 URL、真实页面 |

### 2.4 顺带修掉的两个"假通过"缺陷（本轮取证发现，均让实际用户路径不可用）

1. **原生视图从未挂载**：`native-view-controller.cjs` 只调了 `removeChildView`，**没有 `addChildView`** ——
   webContents 照常加载（CDP / eval / 下载 / `capturePage` 全正常），但屏幕上永远没有网页。
   修复：创建时 `parent.addChildView(view)`；并通过 `native-state.attached` 把这个事实回报给界面
   （门禁断言 `data-attached=1`），避免"状态说可见、画面里没有"再次静默通过。
2. **原生视图盖住浏览器 chrome**：视口原来从窗口正文顶部开始（`y = bounds.y + TITLE_BAR_H`），
   会把标签栏与地址栏一起盖住 —— **合成点击能过、真人点击不能**。
   修复：新增 domain 常量 `BROWSER_CHROME_H = 90`（标签栏 37 + 地址栏 53，CSS 同步固定），
   视口从它下面开始；门禁断言 chrome 与网页视口不重叠。

> 说明：以上两项都不是"顺手重构"，而是"实际用户路径"验收（要求核查"实际页面"）暴露出的真实缺陷。

---

## 3. 实际检查（干净导出树 `git archive 98c9f81`）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| D5-01 门禁（真实 `electron .`） | `npm run test:d5-01` | **64/64 PASS**，exit 0（1 NOT VERIFIED：崩溃持久化） |
| 受影响单测 | `node --test tests/window-domain.test.mjs tests/window-manager.test.mjs tests/occlusion.test.mjs tests/d5-01-browser-tabs.test.mjs tests/d5-01-browser-policy.test.mjs` | **59/59 PASS** |
| D1-01 原生视图主进程验收 | `npm run test:native` | **26/26 PASS** |
| D2-02 窗口系统探针 | `npm run test:d2-02` | **FAIL（预先存在，与本轮无关）**：`security-surface` 的 preload/IPC **冻结清单**停留在 D2-02 时代（10 个成员 / 9 条通道），而 D3/D4 已把 `model`/`sideEffect`/`task` 加上桥、上一轮 `2411f10` 又加了 `browser`/`browser:command` —— 在**本轮基线 `39d733d` 上同一探针就已经是同样的 4 项 FAIL**（`/tmp/oa-prev39-security.log`，与干净树 `98c9f81` 的 `d202.log` 失败项逐字相同）。本轮**不改**该冻结清单（属另一轮范围，且改它等于放宽一条安全面冻结断言） |

**本轮验收覆盖的真实用户路径**（全部经真实产品 UI + 干净树门禁）：
普通导航、302 页面重定向、前进/后退、刷新、连续导航后正常退出、多标签（数值与活动标签）恢复、
不同账号各自恢复（A04-1…A04-10：A 的 Cookie/存储/标签/下载记录不被 B 看到，切回 A 仍在）。

---

## 4. 上一轮 `2411f10` 新增范围核对（对照 PLAN D5-01 原始要求）

| PLAN D5-01 原始要求 | 本轮状态 | 证据 / 缺口 |
| --- | --- | --- |
| 真实浏览器视图（**不用任意网站 iframe**） | ✅ | `WebContentsView`；门禁 N2/N2b（挂载）、P0/P1 |
| 真实网址导航 | ✅ | N2、N9（302 终值）、A5 系列 |
| 标签创建/切换/关闭 | ✅ | T1–T6；`tests/d5-01-browser-tabs.test.mjs` 9/9 |
| 页面加载状态 | ✅ | S1（停止按钮/spinner）；`loading` 事件链 |
| 下载（入口/进度/完成/失败/真实落盘） | ✅ | D1–D5（文件字节比对一致；失败态来自服务端中断） |
| 基本会话保存与恢复 | ✅（正常退出） | R0–R5；崩溃/强杀 = **NOT VERIFIED** |
| 网页与桌面权限隔离（A13） | ✅ | A13-1…A13-3；网页拿不到 `openarc/require/process/ipcRenderer` |
| 弹窗 / 外部协议 / 证书错误 / 文件上传 / 权限申请 | ✅ | P1–P10（外部协议与弹窗均需用户确认；证书 fail closed，无"继续访问"旁路） |
| 会话按用户隔离（团队共享 ≠ 共享登录态） | ✅ | A04-1…A04-10；分区 `openarc-app-browser-u-<userId>` |
| 原生视图与窗口配合（A12：菜单覆盖/拖动遮挡/裁剪/缩放/焦点输入/最小化恢复） | ✅（状态与输入层） / ⚠️ | A12-1…A12-8；**像素级层级**（合成真值）NOT VERIFIED（见 §5） |
| **AI 控制浏览器：明确工具与授权、记录目标标签和执行结果** | ❌ **未完成** | Tool Registry 仍只有 6 个工具，无 `browser.*`；agent-browser 只是**独立验证**（未接入、未进工具列表） |
| 复杂登录 / 企业认证 / 媒体播放 / 特定网站兼容 | ⚠️ 未验证 | 只覆盖本地受控站点 |

**旧调用路径与新入口的关系（保留，不重构）**：`native-view-controller` 在没有 `views` 意图时
仍按 `windowId#t1` 走单视图；`destroy(windowId)`、`partitionFor(appId)` 的旧签名/旧分区名逐字兼容；
`window.openarc.navigate/action` 的两参调用仍然作用于活动标签。新入口（`browser/tab-*`、`browser:command`、
`--pin-tab` 无关的产品 IPC）只是**增量**，没有替换旧路径，也没有为"消除死代码"再动结构。

---

## 5. 限制与 NOT VERIFIED（不扩大承诺）

1. **崩溃 / 强杀后的最近一次导航持久化**：NOT VERIFIED（Chromium localStorage 异步磁盘提交；
   正常退出不受影响）。不承诺崩溃恢复。
2. **像素级层级真值**（网页是否真的盖住 DOM、圆角裁剪的合成结果）：本机屏幕被另一个已运行的
   `OpenArc OS.app` 占用，`screencapture` 取证会拍到别的应用；本轮的层级证据是
   `addChildView` 挂载 + `attached` 事实 + chrome/视口几何（domain 常量 + CSS 固定高度）。
   真机独占屏幕的合成取证保留为 NOT VERIFIED。
3. **窗口缩放/高 DPI/多屏/Windows**：NOT VERIFIED（本机单屏；Windows 无主机）。
4. **D2-02 `security-surface` 冻结清单**：预先存在的过期清单（D3/D4 已扩桥），本轮未改；不构成本轮回归。
5. 只覆盖本地受控站点，不代表任意网站兼容。

---

## 6. agent-browser 冻结（本轮确认）

- **保留**独立验证材料：`docs/D5-01-AGENT-BROWSER-EVALUATION.md`、`docs/D5-01-AGENT-BROWSER-EVIDENCE.json`、
  `experiments/d5-01-agent-browser/eval.mjs`（其固定版本 0.38.1 只在临时目录安装）。
- **不加入**产品依赖（`package.json` 无 `agent-browser`）、不加入启动路径、不加入 Agent 工具列表。
- **正常产品启动不开放调试端口**：门禁 B5 实测 `electron/main.cjs` 与 `package.json` 无
  `remote-debugging`；本轮所有调试端口只由测试命令在启动参数里显式给出，退出即关（B4）。
- **不开发替代执行器、不扩展第三方选型**。

---

## 7. 结论

- **R2：已修复**（根因 = 门禁强杀 + localStorage 异步提交；修复 = 走正常退出并加强断言）。
- **D5-01：PARTIAL**。缺项：AI 控制浏览器的**工具化与授权接入**（PLAN §8 最后一条）；
  NOT VERIFIED：崩溃恢复、像素级层级真值、高 DPI/多屏/Windows、任意网站兼容。
- 本轮不进入 D5-02，不扩大 D4 既有验收结论。
