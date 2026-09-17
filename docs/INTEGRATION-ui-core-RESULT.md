# OpenArc OS · UI 线并入核心线集成结果（integration/ui-core）

> 执行岗：集成工程师。本文件记录可复核的真实命令与真实输出；未跑到的项标注 **NOT VERIFIED**。
> 生成时间：2026-09-17（本机）。

## 0. 结论速览

| 项 | 结果 |
| --- | --- |
| 集成分支 | `integration/ui-core` |
| 两次合并完成时的 tip | `64c58e83ec2721b073a7eb741c945945d721c434`（本文件与探针修订提交在其之上） |
| 基线 | `feature/d4-03-tool-proxy` @ `ac9af8e`（D4-05 A36） |
| worktree | `/Users/wepingli/Desktop/OpenArc OS-integration` |
| 合并提交 | `1777f1c`（profile）、`64c58e8`（window-chrome） |
| `npm test` | **986 / 986 pass，0 fail，exit 0** |
| `npm run build` | **exit 0**（tsc --noEmit + vite build，1633 modules） |
| `npm ci` | **exit 0**（105 packages，lock 与 package.json 一致） |
| 关键 Electron 探针 | 见 §5（d4-04 94/94、d4-06 119/119、d4-05-memory-ui 15/15 等） |
| 主工作区「向导步骤化」未提交改动 | **未被集成分支覆盖**（见 §6） |

## 1. 仓库事实复核（不盲信任务描述）

- git 2.49.0；两条 UI 线共同分叉点确认为 `865e789`（D3-01）。
- `feature/d3-01b-profile` tip `d9645bd`（含 `fix/apple-lockscreen`，已核实其为祖先）。
- `fix/ui-window-chrome` tip `50a3feb`（本地领先 origin 31；时间 2026-09-17 16:46，确实最晚）。
- 两条 UI 线在 `865e789` 之后还有一段共同历史（共同祖先 `ed4fd13`），因此先合 profile、再合 window-chrome 时，第二次冲突显著变小。
- 与任务描述的出入：
  1. 主工作区 `/Users/wepingli/Desktop/OpenArc OS` 实际检出 `feature/d3-02-object-authorization`（9119f85），**未提交改动保持原样未动**。
  2. 执行期间，核心线 worktree `/Users/wepingli/Desktop/OpenArc OS-d4-01` 的 HEAD 从 `ac9af8e` 前进到 `698117f`（D4-05 trust layering，未触碰 resource-library 代码）。本集成严格基于任务指定的 `ac9af8e`；我没有对任何既有 worktree 做 checkout/reset/commit。

## 2. 每一步的真实命令

1. 建 worktree（目标目录此前不存在）：
   ```
   git worktree add "/Users/wepingli/Desktop/OpenArc OS-integration" -b integration/ui-core feature/d4-03-tool-proxy
   ```
2. 合并 UI 线之一：
   ```
   git merge --no-ff feature/d3-01b-profile -m "merge: integrate feature/d3-01b-profile into integration/ui-core"
   ```
3. 合并 UI 线之二：
   ```
   git merge --no-ff fix/ui-window-chrome -m "merge: integrate fix/ui-window-chrome into integration/ui-core"
   ```
4. 依赖：
   ```
   npm ci        # 第一次合并后：成功
   npm install   # 解决 lock 冲突后补齐 @vitejs/plugin-react
   npm ci        # 复核：成功（105 packages）
   ```
5. 验证：`npm test`、`npm run build`、各 `npm run test:*` 探针（§5）。
6. 提交本文件。

## 3. 冲突文件清单与解决方式

### 3.1 第一次合并 feature/d3-01b-profile（9 个冲突）

| 文件 | 冲突本质 | 解决方式（关键取舍） |
| --- | --- | --- |
| `electron/identity-store.cjs` | core 的 v1..v16 迁移框架 vs profile 的 v1→v2 加 `avatar_ref` | **以核心线迁移框架为准**，`SCHEMA_VERSION` 16→**17**；新增 `{version:17, run(db)}` 条件迁移（查 PRAGMA 缺列才 ALTER，空库/老库/跨版本都幂等）。`SCHEMA_SQL` 里 avatar_ref 已由自动合并并入 |
| `electron/main.cjs` | core 新增 runtime boot / task / resource 协议；UI 线新增应用菜单 / `NATIVE_RESOURCES` / `openarc-file` / file-service | **并集**：保留 core 的 `createOpenArcRuntime` 唯一 boot；同时保留 UI 线 `installApplicationMenu`、`NATIVE_RESOURCES`、`openarc-file` 协议与全部 `files:*` handler；导入行取并集（Menu/net/shell + boot 相关 require） |
| `electron/preload.cjs` | core 的 identity/authorization/device/resource/governance/model/task/sideEffect 桥 vs UI 线 files 桥 | **并集**：14 个顶层桥键全部保留，`trusted(event)` 校验不放松 |
| `experiments/d2-02/native/probes/02-security-surface.cjs` | 两侧各自冻结不同暴露面 | **按合并后真实暴露面重定冻结清单**：14 桥键 / 21 个 IPC handle 通道 / `files:startDrag`；`IPC_SCAN_FILES` 补上 `task-bootstrap`、`side-effect-bootstrap`（原先漏扫） |
| `index.html` | CSP 分别只要 `openarc-resource:` / `openarc-file:` | **并集**：img/media 同时允许两个自定义协议 |
| `package.json` | scripts 两边各自追加 | **并集**：保留 core 全部 59 个 `test:*` + UI 线 `oa:status`/`oa:app`/`showcase` |
| `src/desktop/components.tsx` | AIPanel：core 是 D4-04 真实 Task Runtime；UI 线是语音 Orb + 麦克风 | **手工合成**：保留 core 的 goal/task/run/cancel/resume/recovery/verification 全逻辑，叠加 UI 线 `useMicSignal` 电平（命令式推 transform）+ `OrbIcon adapter`；去掉 UI 线「草稿 composer/note」（已被真实任务 composer 取代） |
| `src/main.tsx` | 6 处：导入、window 类型声明、apps 列表、文件面板、设置/技能、浮层 | 见 §3.3 逐条 |
| `src/styles.css` | 末尾追加区块相互顶到同一位置 | **并集**：core 的资源库/治理/模型/审批样式 + UI 线锁屏/文件夹/资料样式 |

### 3.2 第二次合并 fix/ui-window-chrome（5 个冲突）

| 文件 | 冲突本质 | 解决方式（关键取舍） |
| --- | --- | --- |
| `electron/identity-bootstrap.cjs` | core 的扩展签名 vs window-chrome 的 `bootError` | **并集**：签名 = core 全部域服务参数 + `bootError=null`；`if (send && service)` 保留 UI 线守卫；core 的 authorization/device/resource/governance/model/sideEffect 注册全部保留 |
| `electron/identity-store.cjs` | `SchemaTooNewError` vs 普通 Error；导出块 | **采用 UI 线 `SchemaTooNewError`**（带 `code=SCHEMA_TOO_NEW`，供启动失败文案区分），并把类加入导出 |
| `electron/main.cjs` | core 的 async runtime boot vs UI 线「启动失败不白屏」兜底 | **并集**：保留 `describeStartupFailure`/`recoverFromStartupFailure` + `.catch(recoverFromStartupFailure)`；把 core 的 `createOpenArcRuntime` 包进 try/catch，失败时置 `identityBootFailure` 并继续装配窗口；`registerIdentityIpc` 用 `identity?.…` + `bootError`；依赖 identity 的 `registerTaskIpc` 与 `openarc-resource` handler 加 `if (identity)` 守卫 |
| `package-lock.json` | 两侧 lock 差异巨大 | 先取集成分支侧 lock，再 `npm install` 按并集后的 package.json 补齐 `@vitejs/plugin-react`；最终 `npm ci` 通过 |
| `src/styles.css` | 头像/资料样式 vs 自绘光标套装 | **并集**；并修复并集接缝处缺失的一个 `}`（两段末条规则原本共用公共收尾） |

### 3.3 src/main.tsx 六处冲突的取舍

1. **导入**：并集（core 的 ResourceLibrary/Governance/… + UI 线的 BootRetry/Avatar/AvatarPicker/errorText）。
2. **`window.openarc` 类型声明**：core 的 authorization/device/resource/governance/model/sideEffect + UI 线 files，全部保留。
3. **apps 列表**：`{id:"files", name:"访达"}`（UI 文案）+ core 新增 `{id:"resource-library", name:"资源库"}`。
4. **文件面板**：**UI 线完整 Finder（侧栏/工具栏/框选/拖拽/右键）胜出**；core 侧是「本版不显示模拟文件」占位符（因 core 没有 file-service）。core 的 home 应用网格在公共区已由 profile 的 home 渲染保留。
5. **设置 / 技能**：**保留 core 的 `SettingsContent` 分栏**（device-ui / model-* 探针强依赖 `[data-settings-pane]`、`.material-select`、`[data-settings-active]`、`[data-d4-01]`），并把 UI 线的外观/壁纸/锁屏壁纸/个人资料控件通过新增的 `appearanceExtra` prop 注入其「外观与交互」pane；技能中心保留 UI 线独立分栏（core 原为通用占位符）。取舍：core 的「深色外观」复选框让位给 UI 线更完整的「跟随系统/浅色/深色」分段，材质 `.material-select` 保留。
6. **浮层**：core 的 `<ApprovalPrompt>` 与 UI 线的 简介卡/文件夹菜单/桌面菜单/壁纸调整 Dialog **并集**。

## 4. 代码/契约层面的关键决定

- **identity schema 升到 v17**：`avatar_ref` 是 UI 线新增字段。空库由 `SCHEMA_SQL` 直接建齐；已存在的 v1..v16 老库在 v17 条件补列。相应更新了 8 个断言旧版本号的测试文件（`identity-store.test.mjs` 及 7 个 `*-migration.test.mjs` / `task-store.test.mjs`）——这是版本常量真实变化后的对齐，不是「改测试凑绿」；迁移步骤本身（v2..v16）一个没删。
- **安全边界面扩大但显式登记**：合并后 preload 暴露 14 个顶层桥键、21 个 `ipcMain.handle` 通道 + `files:startDrag`。安全探针的冻结清单已按真实面更新，`sec.*` 全部通过（§5）。
- **启动失败语义**：`SchemaTooNewError` → `code=SCHEMA_TOO_NEW` → 主进程给出人话原因 → 渲染层走既有 BootRetry，不白屏；失败时只降级依赖 identity 的能力，只读文件与窗口能力照常。

## 5. 测试与探针真实结果

### 5.1 单测与构建

```
npm test        → # tests 986  # pass 986  # fail 0   exit 0
npm run build   → tsc --noEmit 通过；vite build 1633 modules，exit 0
npm ci          → added 105 packages，exit 0
```

### 5.2 Electron UI 探针（真实 Electron，`ELECTRON_EXTRA_ARGS="--no-sandbox --disable-gpu-sandbox --in-process-gpu"`）

| 脚本 | 真实结果 |
| --- | --- |
| `test:identity-ui` | 23/24（**U8「顶栏显示当前身份」失败**）。已对照：在 `/private/tmp/oa-profile` 用 profile 自己的 dist 跑同样 23/24、同样 U8 失败 —— **既有探针缺陷，非集成回归**（选择器 textContent 含前导空格 `" UI Probe"`） |
| `test:authorization-ui` | 14/14 PASS |
| `test:resource-library-ui` | **24/24 PASS**（首次批跑时 B8 偶发失败；单独复跑两次均 24/24 PASS） |
| `test:d4-04` | **94/94**，`GATE.testedCommit=64c58e8`，`checksSummary={total:94,pass:94,fail:0}`，`rendererConsoleErrors=0`，`mainUnhandledErrors=0`，真实 executor spawned/ready/exited |
| `test:d4-06` | **119/119**，`GATE.testedCommit=64c58e8`，`electronExit=0`，`budgetExit=0` |
| `test:d4-05-memory-ui` | **15/15 PASS**（记忆上下文隔离，对应 core tip 的 A36） |
| `test:device-ui` | 32/32 PASS |
| `test:model-settings-ui` | 16/16 PASS |
| `test:d2-02` | 组内跑完 2/5 后中止：security-surface **17/17 PASS**；dialog-a11y **25 PASS / 8 FAIL**；motion-parity / window-stress / two-browser **未跑**（前序 FAIL 即中止） |

> 说明：第一次把 d2-02 安全探针改完后仍 FAIL，原因是函数内还残留 UI 线局部的 `const REGISTERED_EXPANSIONS=["files","identity"]` 遮蔽了模块级并集登记表；已删除该局部声明，重跑 17/17 通过。

**dialog-a11y 定性**：在 `/private/tmp/oa-profile` 用 profile 自己的 dist 跑得 **26 PASS / 7 FAIL**，失败项与本集成**相同**（菜单键盘焦点 5 项、文件夹菜单 4 项、`siri-blob` CORS），属 **UI 线既有 a11y 缺口**，非本集成引入。集成分支多 1 项 `dialog.backgroundIsInert`：根因正是同一个「ContextMenu 打开时不聚焦首项」——键盘 End/Enter 因此没落到删除项，删除确认未按其预期路径打开，背景 inert 断言随之失败；而 `inert` 接线本身在四个分支逐字相同（`main.tsx` 第 2859 行 `inert={overlays.dialog || locked || undefined}`）。

**NOT VERIFIED**：`test:d2-02` 的 `motion-parity` / `window-stress` / `two-browser` 因前序 FAIL 中止未跑；全部可视化 Gate 默认跳过；「运行时沙箱强制执行」因本机必须 `--no-sandbox` 兜底而无法验证。

## 6. 主工作区未提交改动是否已覆盖

- 主工作区 `/Users/wepingli/Desktop/OpenArc OS` 的未提交改动**从未被读取以外地触碰**：未 add / commit / stash / clean / checkout。
- 其含「初始化向导步骤化」关键字 `setup-step-pane` / `SETUP_STEPS`：集成分支**只包含 `LockClock`，不含 `SETUP_STEPS` / `setup-step-pane`**（已用 grep 双向核对）。即 **主工作区这部分未提交改动未被集成分支覆盖**，后续若要保留，需要由该工作区另行提交后再并一次。
- 附注：本会话期间，该主工作区的未提交集合出现过变化（会话开始时的 `git status` 未列 `tests/fixtures/identity-ui-probe/main.cjs`，会话结束时它已带「引导式三步」用例改动；文件 mtime 为 17:22，早于本会话）。这些变动不是本集成工程师所为（我在该工作区只做过读取类命令），也未被我 stage/commit/stash/clean。

## 7. 剩余问题与建议

1. **U8 探针断言缺陷（既有）**：`tests/fixtures/identity-ui-probe/main.cjs` 用 `textContent === "UI Probe"`，但按钮 `<LogOut/> {name}` 会产生前导空格。建议改成 `.trim()`。这会在 profile 线也失败，与本集成无关。
2. **resource-library-ui B8 偶发**：机器负载/时序敏感（等 body 出现 `v2`）。建议探针加稳定等待或提高超时；本次复跑两次均通过。
3. **设置页外观控件形态**：core 的「深色外观」复选框已被 UI 线三分段取代（功能等价且更强）；如产品上仍要复选框，应在 UI 线显式决定，不要两边都留。
4. **主工作区向导步骤化**：见 §6，需要单独收口。
5. **d2-02 其余探针**：本机沙箱限制下未复验，建议在有 GUI/沙箱权限的机器上补跑。
6. 本次未 `git push`、未动 main、未动任何既有 worktree/分支。

## 8. 收尾轮（2026-09-17）：核心线最新 + 向导步骤化 + 探针 U8/B8

> 本轮起点 tip `09e4745`；所有命令在 worktree `/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`）执行。

### 8.1 合并核心线最新 feature/d4-03-tool-proxy @ 698117f

- 合并方式：`git merge --no-ff feature/d4-03-tool-proxy`，合并提交 **`20fa433`**（`merge: integrate feature/d4-03-tool-proxy (D4-05 memory trust layering) into integration/ui-core`）。
- 自动合并 9 个文件；唯一冲突 `docs/D4-04-GATE-EVIDENCE.json`。
- 冲突性质：该文件是 `npm run test:d4-04` 的**测试证据产物**。两侧分别是同一套 **94 条 check** 在 `ac9af8e`（核心线）与 `64c58e8`（集成分支）两次真实运行的落盘记录；差异**只有**非确定性的运行期标识：executor `instanceId`（3 处）、C3 的 ResourceRef、H1 的 taskId、G1 的 actor、`at` 时间戳、`artifactSha256`、`testedCommit`。`checksSummary={total:94,pass:94,fail:0}`、check 名称与 `ok`、`rendererConsoleErrors=0`、`mainUnhandledErrors=0` 逐条一致。
- 处理：**保留核心线整份版本**（`testedCommit=ac9af8e`）。理由：两条记录都是真实的，但把两次运行的实例 ID / ref / 时间戳混成一份会造出一条并不存在的运行；按任务口径保留核心线版本。**没有编造任何条目的名称或通过结果。**
- 合并后核心线修复确实在位：`git diff feature/d4-03-tool-proxy HEAD -- electron/harness-model-adapter.cjs tests/d4-05-s4-memory-context.test.mjs` 输出为空（逐字节保留核心线实现）；`node --test tests/d4-05-s4-memory-context.test.mjs` **15/15 pass**；`npm run test:d4-05-memory-ui` **15/15 PASS**。记忆正文仍以 json 转义的独立 user 消息 `name:openarc.reference_data` 出站，固定安全规则走 system `name:openarc.rules`，没有回退成 system role。

### 8.2 初始化向导步骤化移植

- 落地位置：`src/identity/AuthScreens.tsx`（`SETUP_STEPS`、`step/direction/stepBody` 状态、3 段 pane + 被动步骤条 + 上一步/下一步）、`src/styles.css`（`.setup-steps / .setup-step / .setup-step-connector / .setup-step-dot / .setup-step-body / .setup-step-title / .setup-step-desc / setup-slide-forward|back`）。
- **适配集成分支已有身份契约（快照基于旧基线 feature/d3-02，不能整体覆盖）**：
  - 第 1 步 = 显示名 **+ 头像选择（AvatarPicker）**，`onSubmit(..., avatarRef)` 保持；
  - 登录页/锁屏的 **LockWallpaper / useLockTone / LockStageWallpaper**（壁纸、明暗跟随）保持；
  - **BootSurface / BootRetry / brand-mark / Apple 锁屏布局 / LockClock** 全部保持；
  - `src/identity/types.ts` **未改**：集成分支的 `INVALID_CREDENTIALS` 文案已是「账号或密码不正确。」，与快照一致；
  - 结论：锁屏/登录/壁纸/资料（UI 线 + 核心线）与步骤化向导**两种能力共存**，没有二选一，也没有回退任何核心线身份契约。
- 必须同步的 UI 探针（全仓只有这两处用 DOM 走初始化表单；其余 UI 探针都直接 `identity.store.initialize`）：
  - `tests/fixtures/identity-ui-probe/main.cjs`：按「下一步」驱动三步，并新增 U2b（第一步只呈现显示名）/U3b（步骤指示器不可点）两条向导断言；
  - `tests/fixtures/showcase/main.cjs`：同样分步驱动。
- 视觉取证：`docs/snapshots/2026-09-17-setup-wizard-step1.png / step2.png / step3.png`（真实 Electron `capturePage`，1280×860；分别是「先起个名字 + 头像」「设置登录账号」「设置管理员密码」）。

### 8.3 两个已知探针问题

**U8（identity-ui · 顶栏身份）—— 探针缺陷，已修。**
- 复现：`npm run test:identity-ui` → **23/24**，明细 `FAIL U8 · 顶栏显示当前身份 ( UI Probe)`（前导空格）。
- 根因：产品顶栏按钮是 `<LogOut/> {displayName}`，`textContent` 天然带一个前导空格 `" UI Probe"`；探针 `text()` 直接拿 `textContent` 与 `NAME` 全等比较。产品渲染本身正确。
- 修复：探针 `text()` 改为 `.trim()`。修复后 `npm run test:identity-ui` = **26/26**（原 24 条 + 向导移植新增 U2b/U3b 两条）。

**B8（resource-library-ui · 偶发）—— 探针时序/竞态，已加稳定等待。**
- 复现（原始三条 flag，15 连跑）：13×`24/24`、1×`FAIL B9 v1`、1×探针无 RESULT（B2 之后挂起）。B8 本身未失败，但同一段流程不稳。
- 根因（两处 probe 时序，已确认不是产品缺陷）：
  1. B8 条件是 `document.body.innerText` 含 `v2`；编辑用的 `<textarea>` 当前 `value` 也计入 body.innerText，所以「输入框刚填好 v2」就已为真，**早于保存真正落库**；紧随其后的 B9 直接读主进程版本，偶发读到 `v1`。
  2. 登录前固定 `sleep(80)` 再点击；负载下按钮可能仍是 `disabled`，`click()` 静默跳过 → B2 超时并级联到整轮无 RESULT。
- 修复（只加稳定等待 / 收紧到真实完成信号，不改产品、不放宽断言）：
  - 打开编辑器：两处 `sleep(200)` → `waitSel([data-d3-04b-editor])`；
  - B8 改为等「编辑器关闭（编辑器节点消失）且 DOM 出现 v2」= 保存真正完成；
  - 登录：`sleep(80)` → `waitEnabled([data-d3-id=login-submit])`（与 identity-ui 探针同一套等待语义）。
- 复跑：修复后 **20/20 全 `24/24`**（`--no-sandbox --disable-gpu`）+ **3/3 全 `24/24`**（任务建议的三条 flag）。B9 不再出现。
- 环境备注：原始三条 flag 下还遇到 Electron 渲染器/GPU 挂起（stderr `ContextResult::kTransientFailure`）导致无 RESULT；`--disable-gpu` 能消掉这类挂起，但会让 `device-ui` 的配对倒计时因渲染器卡顿假性超时（A11 `5:00 -> 0:00`、A12 `EXPIRED`）。**`device-ui` 用任务建议的三条 flag 得 32/32。**

### 8.4 真实测试计数（本轮实测）

| 命令 | flag | 结果 |
| --- | --- | --- |
| `npm run build` | — | **exit 0**（tsc --noEmit + vite build，1633 modules） |
| `npm test` | — | **990 条；连跑 3 轮：989 / 988 / 987 pass（1 / 2 / 3 fail），失败全部是 dsh/harness 负载超时，非本次回归（见下方说明）** |
| `npm run test:identity-ui` | 三条 flag | **26/26 PASS** |
| `npm run test:resource-library-ui` | `--no-sandbox --disable-gpu` | **24/24 PASS** |
| `npm run test:resource-library-ui` 连跑 | 两条 flag | **20/20 次全 24/24** |
| `npm run test:resource-library-ui` 连跑 | 三条 flag | **3/3 次全 24/24** |
| `npm run test:authorization-ui` | `--no-sandbox --disable-gpu` | **14/14 PASS** |
| `npm run test:model-settings-ui` | `--no-sandbox --disable-gpu` | **16/16 PASS** |
| `npm run test:device-ui` | 三条 flag | **32/32 PASS** |
| `npm run test:d4-05-memory-ui` | `--no-sandbox --disable-gpu` | **15/15 PASS** |
| `node --test tests/d4-05-s4-memory-context.test.mjs` | — | **15/15 pass** |
| `node --test tests/side-effect-c4-dsh-write.test.mjs` | — | **5/5 pass ×2** |

`npm test` 说明（如实记录，未达全绿）：本机当前负载极高（`uptime` load average 15–21；常驻 Chrome/agent-browser ~100%、Adobe ~80%，机器同时还在跑多个 DSH/agent 进程）。完整套件 `990` 条，默认并发连跑 3 轮分别是 **989/990**（仅 `side-effect-c4-dsh-write` E2E 超时）、**988/990**（`d4-05-s1-facade-a33` / `d4-05-s1-facade-association`）、**987/990**（`tool-d4-03d-e2e` / `tool-dsh-e2e` / `tool-dsh-facade`）；失败项每轮都不同，且都是 `HARNESS_TURN_TIMEOUT` 或官方 dsh 工具注册超时，`duration_ms` 高达 ~90 万（单条约 15 分钟），说明机器被其它进程占满、官方 dsh 子进程跑不完一个 turn —— **不是断言被改坏，也不是本次改动引入**（这些文件都不在本次改动范围）。旁证：`side-effect-c4-dsh-write` 单文件 **5/5 连过两次**；`d4-05-s1-facade-a33` / `d4-05-s1-facade-association` / `d4-05-s3-budget-ledger` 在 `--test-concurrency=1` 串行跑到第 78 条时全绿。**结论：本轮未能拿到 `npm test` 全绿，这一步标注 NOT VERIFIED（环境阻塞，负载正常的机器应可复现全绿）。**

### 8.5 未完成 / 建议

1. `docs/D4-04-GATE-EVIDENCE.json` 未在新 tip 重新生成（按任务口径保留核心线版本）。如需与新 tip 对齐，在本机跑一次 `npm run test:d4-04` 覆盖即可。
2. `npm test` 默认并发在本机高负载下会偶发 `HARNESS_TURN_TIMEOUT`。建议 CI 上限制 `node --test` 并发（或抬高 harness turn 超时），不要在负载机上调参。
3. d2-02 其余探针未跑（与本次改动无关）。
4. 本轮未 `git push`、未动 main、未动任何既有 worktree/分支；主工作区 `/Users/wepingli/Desktop/OpenArc OS` 的未提交改动只在只读快照 `/tmp/oa-main-snapshot` 使用，未被触碰。
