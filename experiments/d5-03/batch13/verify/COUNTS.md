# D5-03 第十三批 · 取证计数汇总（COUNTS.md）

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`）
- **被测 commit = `312dc60`**（`git rev-parse HEAD` 实测 `312dc606fee9d9c147a9d863fba7fe504961ab26`，与要求一致）；父提交 `48a867c`
- 取证期间**未 push / 未 merge / 未 rebase / 未 amend / 未 commit**；未触碰主工作树 `/Users/wepingli/Desktop/OpenArc OS`、DSH Desktop 共享运行时、`~/.dsh`
- 所有原始 stdout+stderr 见本目录同名 `.txt`（每份都以 `# --- begin raw stdout+stderr ---` / `# --- end raw output ---` 包裹，并记录命令、cwd、node 版本、git HEAD、时间、`# EXIT CODE:`）

## 0. 本目录文件索引

| 文件 | 内容 |
| --- | --- |
| `10-gate-c4-nodirectbypass.txt` | 目标门禁 ① `side-effect-c4-gates`（`No Direct Domain Bypass`） |
| `11-gate-approval-push.txt` | 目标门禁 ② `d4-03-approval-push-isolation` |
| `20-d5-01-regression.txt` | D5-01 node 级回归 6 个文件（第 2 次；第 1 次被 SIGKILL，见 §4） |
| `21-d5-02-regression.txt` | D5-02 node 级回归 7 个文件 |
| `22-side-effect-d4-03-regression.txt` | `side-effect-*.test.mjs` + `d4-03-*.test.mjs` 全量 |
| `23-d5-01-doc-merged-set.txt` | `docs/D5-01-RESULT.md:79` 文档口径合并集 + 59→60 归因附注 |
| `30-electron-d5-01-control.txt` | 真机 D5-01 受控浏览器链（第 1 次，中止于 `:255`） |
| `31-electron-d5-02-canvas.txt` | 真机 D5-02 画布链 |
| `32-d5-01-control-at-parent-48a867c.txt` | **基线对照**：父提交 `48a867c` 的临时 worktree 跑同一门禁 |
| `33-d5-01-control-rerun-at-312dc60.txt` | 真机 D5-01 第 2 次（换端口 9792、清空 stderr 日志）+ 三次运行对照表 |
| `40-npm-test-full.txt` | 完整 `npm test` |
| `50-negative-whitelist-widened.txt` | 负向自证 A · 静态门禁变红 |
| `51-negative-whitelist-widened-behavior.txt` | 负向自证 A · 行为级真实 mutation 变红 |
| `52-negative-projection-field-added.txt` | 负向自证 B · 审批投影多加敏感字段变红 |
| `53-positive-paths-still-pass.txt` | 步骤 C · 还原后重跑门禁 + 三条正常路径 |
| `54-negative-restore-proof.txt` | 负向自证 A/B 的逐字还原证明（sha256 + `git diff --exit-code`） |

## 1. 主计数表（命令 / 真实 tests / pass / fail / exit code）

| # | 命令 | tests | pass | fail | skipped | exit | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `node --test tests/side-effect-c4-gates.test.mjs` | **19** | **19** | **0** | 0 | **0** | 达标（期望 19/19、fail 0） |
| 2 | `node --test tests/d4-03-approval-push-isolation.test.mjs` | **12** | **12** | **0** | 0 | **0** | 达标（期望 12/12、fail 0） |
| 3 | D5-01 回归 6 文件（`d5-01-browser-control` / `-control-chain` / `-control-surface` / `-inprocess-boundary` / `-policy` / `-tabs`） | **37** | **37** | **0** | 0 | **0** | 全绿 |
| 4 | D5-02 回归 7 文件（`d5-02-canvas-{ai-marks,edit-proposal,merge,service,tool}` + `d5-02-model-list-authorization` + `resource-canvas-integration`） | **48** | **48** | **0** | 0 | **0** | 全绿 |
| 5 | `node --test tests/side-effect-*.test.mjs tests/d4-03-*.test.mjs` | **278** | **278** | **0** | 0 | **0** | 全绿 |
| 6 | 文档口径 D5-01 合并集（`window-domain` + `window-manager` + `occlusion` + `d5-01-browser-tabs` + `d5-01-browser-policy`） | **60** | **60** | **0** | 0 | **0** | 全绿（文档写的 59/59 已过期，见 §3） |
| 7 | `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-control`（真机，第 1 次） | — | 2 条 PASS | 1 条 FAIL | — | **2** | **未取得**（既有失败，见 §4） |
| 8 | `env -u ELECTRON_RUN_AS_NODE node experiments/d5-02/canvas-e2e.mjs`（真机） | **52** | **52** | **0** | — | **0** | 达标（基线 52/52） |
| 9 | 基线对照：`48a867c` worktree 跑 `test:d5-01-control`（端口 9791） | — | 8 条 PASS | 3 条 FAIL | — | **2** | S0a 逐字相同失败 → 既有 |
| 10 | `test:d5-01-control` 第 2 次复核（HEAD，端口 9792） | — | 8 条 PASS | 3 条 FAIL | — | **2** | 与 48a867c 序列一致 |
| 11 | `env -u ELECTRON_RUN_AS_NODE npm test`（完整 219 文件） | **1412** | **1412** | **0** | 0 | **0** | **全绿**（第十二批 1408/1406/2 → 本批 1412/1412/0） |

### 1.1 真机 D5-02 画布明细

`31-electron-d5-02-canvas.txt` 末行：

```
结论：PASS — {"pass":52,"fail":0,"total":52,"notVerified":0}
```

基线 52 PASS / 0 FAIL → **完全一致**。

### 1.2 真机 D5-01 受控浏览器链：三次运行的到达位置

| 顺序 | commit | 文件 | 最后到达的 check | 中止点 | exit |
| --- | --- | --- | --- | --- | --- |
| 1 | `312dc60`（HEAD） | `30-…` | `setup · S0a` | `browser-control-e2e.mjs:255`（`Target page … closed`） | 2 |
| 2 | `48a867c`（父提交） | `32-…` | `ui · U6` | `:297`（`TypeError: … reading 'status'`） | 2 |
| 3 | `312dc60`（HEAD） | `33-…` | `ui · U6` | `:297`（`TypeError: … reading 'status'`） | 2 |

- 三次**共有**：`S0a` 均 FAIL，失败串逐字相同 `实际 {"pid":"","cid":"","defaultOk":false}`；均 `EXIT CODE: 2`；均**未**产出 `artifacts/d5-01/d5-01-browser-control-e2e.json`；均**未**进入任何浏览器读取 / 导航 / 审批副作用场景。
- 差异：`312dc60` 的两次运行**互相之间**中止点就不同（`:255` vs `:297`）→ 中止点**非确定性**；第 3 次与第 2 次（父提交）的 check 序列与中止点**逐条一致**。
- 第 1 次运行 stderr 出现两条 `DevTools listening`（端口 9790）——该日志为**追加写**且运行前已存在（已备份 `/tmp/oa-b13-stderr-before-step33.txt`），其中一条是历史残留；第 3 次运行前后清空日志，全过程只有 **1** 条 → 不存在重复实例。

## 2. 负向自证（故意放宽，新门禁必须变红）

| 组 | 放宽方式 | 命令 | tests | pass | fail | exit | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A（静态） | `IN_PROCESS_EXECUTION_PROVIDERS` 临时加入 `"ResourceService"` | `node --test tests/side-effect-c4-gates.test.mjs` | 19 | 16 | **3** | **1** | **变红**，含 `not ok 18 - No Direct Domain Bypass` |
| A（行为） | 同上 | `node experiments/d5-03/batch13/red/inprocess-bypass.mjs` | — | — | — | 0 | `verdict: RED_BYPASS_PROVEN`，真实 mutation |
| B | `approvalSnapshot` 的 `allowed` 集合 + `snap` 临时加入 `ownerUserIdProbe` | `node --test tests/d4-03-approval-push-isolation.test.mjs` | 12 | 8 | **4** | **1** | **变红**，失败者恰为 P2 / N1 / N2 / N4 |

### 2.1 A 组静态红的 3 条失败断言（原文）

```
not ok 9 - Concurrent Approve click → 单一 authoritative approval transition；1 lease / 1 execution
not ok 12 - Task Cancel Race：executor eligibility 窗口内 cancel → 0 Domain invocation
not ok 18 - No Direct Domain Bypass：resource.trash 的唯一 Domain 调用点在 allowlisted adapter + controlled execution 内
```

（第 18 条是**目标判据**；第 9、12 条因白名单放宽改变了 lease / Domain 调用计数而连带走红，属同一次放宽的连带效应。）

### 2.2 A 组行为红的真实 mutation 数字（`51-…` 原文）

| 观测项 | 调用前 | 调用后 |
| --- | --- | --- |
| `res.ok` / `res.error` | — | `true` / `null` |
| `res.inProcess` | — | `true` |
| `call.status` | `APPROVED` | `SUCCEEDED` |
| `libraryTrashState` | `ACTIVE` | **`TRASHED`** |
| `libraryDeletedAt` | `null` | **`1700000000000`** |
| `registryStatus` | `active` | **`deleted`** |
| `deleteCalls` | `0` | **`1`** |
| `leaseCount` | `0` | **`1`** |
| `auditCount` | `6` | **`12`** |
| placement 审计 | — | `IN_PROCESS / PROCESS_LOCAL_DOMAIN` |

### 2.3 还原证明（`54-…`）

- 备份：`/tmp/oa-b13-runtime.orig.cjs`
- `shasum -a 256 electron/side-effect-runtime.cjs` = `8e7d269d4c768e55a4fec98743e7e082644d134cd1d58f0088c561da11fd5777`
- 备份同 sha256 = `8e7d269d4c768e55a4fec98743e7e082644d134cd1d58f0088c561da11fd5777`
- `git show 312dc60:electron/side-effect-runtime.cjs | shasum -a 256` = **同一值**（与提交内置版本逐字节相同）
- `git diff --exit-code -- electron/ tests/` → **exit 0**；`git diff --exit-code`（全树）→ **exit 0**（该时点三份 tracked 交付物尚未写入）
- `git status --porcelain` → 只有 `??`（未跟踪的 batch13 取证产物），**无产品文件改动**
- 写完全部交付物后的最终状态：`git diff --stat` = `PROGRESS.md | 51 +`、`docs/D5-03-GATE-EVIDENCE.json | 474 +`（`2 files changed, 525 insertions(+), 0 deletions(-)`，两处均为**纯插入**）；`git diff --stat -- electron/ src/ tests/` **为空** → 产品与测试代码 0 改动；`git diff --exit-code` 此时因这两个交付物而非 0（预期）

### 2.4 步骤 C · 还原后正常路径仍通过（`53-…`）

| 路径 | 命令 | tests | pass | fail | exit |
| --- | --- | --- | --- | --- | --- |
| 门禁 ① 重跑 | `node --test tests/side-effect-c4-gates.test.mjs` | 19 | 19 | 0 | 0 |
| 门禁 ② 重跑 | `node --test tests/d4-03-approval-push-isolation.test.mjs` | 12 | 12 | 0 | 0 |
| 画布编辑 | `node --test tests/d5-02-canvas-tool.test.mjs` | 4 | 4 | 0 | 0 |
| 浏览器导航（in-process 成功） | `node --test tests/d5-01-browser-control-chain.test.mjs` | 5 | 5 | 0 | 0 |
| 合法 in-process 调用方 | `node --test tests/d5-01-browser-inprocess-boundary.test.mjs` | 6 | 6 | 0 | 0 |
| 探针（守卫仍拦 ResourceService） | `node experiments/d5-03/batch13/red/inprocess-bypass.mjs` | — | — | — | 0，`verdict: GREEN_GUARD_HELD` |

「正常资源回收（受监督 executor 真实 trash 成功）」由门禁 ① 内的 (a) 行为断言承担（`executeApproved` → `ok===true`、`trashed===true`、恰好 1 lease、`verificationStatus==="PASS"`），本轮 19/19 通过。

## 3. `npm test` 失败归因

**本批 `npm test` = 1412 tests / 1412 pass / 0 fail / exit 0 —— 无任何失败**，因此无「本批导致 / 既有失败 / 环境故障」需逐条判定。

与第十二批对照：

| 项 | 第十二批（`10075b2`） | 本批（`312dc60`） | 差 |
| --- | --- | --- | --- |
| tests | 1408 | **1412** | **+4** |
| pass | 1406 | **1412** | +6 |
| fail | 2 | **0** | **−2** |
| exit | 1 | **0** | — |

- **+4 条用例** = 本批给 `tests/d4-03-approval-push-isolation.test.mjs` 新增 N1–N4（8 → 12 条）。`tests/side-effect-c4-gates.test.mjs` 未新增用例（仍 19 条，只重写断言）。
- **−2 条失败** = 第十二批登记的两条既有确定性失败（`d4-03-approval-push-isolation` P2、`side-effect-c4-gates` No Direct Domain Bypass）**本批已修并转绿**。
- 无 skipped / todo / cancelled；无 flake 记录。

### 3.1 D5-01 文档口径 59/59 → 实测 60/60（归因：文档计数过期，非产品回归）

- `docs/D5-01-RESULT.md` 最后一次提交是 `f93e835`；在该提交上逐文件统计 `test(` 声明数 = `window-domain 11 + window-manager 16 + occlusion 18 + d5-01-browser-tabs 9 + d5-01-browser-policy 5` = **59**。
- `f9564b7`（"fix(d5-01): 提示条被原生视图盖住…"）把 `tests/window-manager.test.mjs` 由 16 条增为 17 条 → 合计 **60**。`f9564b7..312dc60` 之间该文件只有断言口径更新（+10/−4），用例数不变。
- 独立复算：把 `f9564b7` 的这 5 个文件放进 `/tmp/oa-b013-base`（临时宿主，`electron`/`node_modules` 软链到本工作树）运行 → `# tests 60`（该次 57 pass / 3 fail 是"旧测试配新产品的窗口口径"造成的预期错配，与本批无关）。
- 本批 `312dc60` 的改动面**不含**这 5 个文件（`git show --stat 312dc60` 无它们）。
- **结论：当前 60/60 PASS、fail 0，比文档口径多 1 条且全过，非产品回归。**

## 4. 环境登记（如实，非产品缺陷）

| # | 事项 | 处置 | 影响 |
| --- | --- | --- | --- |
| E-1 | `node_modules/electron/dist/` 缺 `Electron.app`（只剩 LICENSE/version，20M）→ 任何 `require("electron")` 触发 `node_modules/electron/index.js` 的自动下载器 `install.js`；到 GitHub CDN 实测约 **12 KB/s**，110MB 需 ~2.5h → `tests/d5-01-browser-policy.test.mjs` 表现为"挂住" | 从本机 `~/Library/Caches/electron/eb6378133b7d1c087d37a87eca1d3e04f404c9384955d1af8703278bdde7a7b4/electron-v44.3.0-darwin-arm64.zip` 用 `ditto -x -k` 解到 `dist/`。该 zip sha256 = `49b91ef265c603c8888500f807484b63816069c30f87ba2b403e7c87f0f45035`，与 `node_modules/electron/checksums.json` 中 `electron-v44.3.0-darwin-arm64.zip` 的期望值**逐字节相符**；`unzip -t` 无错 | `node_modules/` 被 `.gitignore` 忽略（`.gitignore:1`），`git status` 不受影响；修复后 `require("electron")` 返回真实路径、`dist/version` = 44.3.0 |
| E-2 | 本会话 shell 继承 `ELECTRON_RUN_AS_NODE=1`（来自 DSH 运行时，非仓库配置）→ `electron .` 退化成纯 Node（实测同一二进制：带变量报 `v24.20.0`，剥离后报 `v44.3.0`） | 真机 Electron 链一律用 `env -u ELECTRON_RUN_AS_NODE` 运行。这不是放宽：`experiments/d5-01/browser-control-e2e.mjs:104` 与 `experiments/d5-02/canvas-e2e.mjs:87` 都是 `env: { ...process.env }` **不剥离**，基线是在没有该变量的普通 shell 里跑的 | 未改任何产品代码或 `experiments/` 脚本 |

## 5. 未取得 / 未验证（如实）

1. **真机 D5-01 受控浏览器链未取得**（`test:d5-01-control` 三次均 `EXIT CODE: 2`）：在 **provider/model 安装段** `S0a` 即失败，父提交 `48a867c` 上**逐字相同**失败 → **既有失败**（D5-01 验收基线 `f9564b7` 之后的设置界面漂移），**不在本批范围**。后果：本批**没有**浏览器导航的真机 UI 证据（界面显示同一个待批准地址这条）。
2. `url` 的 2000 截断上界未覆盖（N2 用的长地址 1533 字符 < 2000 工具门 `maxLength`）。
3. `targetRef` 的 300 字符上界无断言。
4. `canvas.edit` 未进审批推送门禁的专门断言（走同一处投影代码但未被本门禁直接覆盖）。
5. 推送目标窗口身份未验（`sendSideEffect` 的投递对象与 `getApprovalRequest` 是否同一窗口；用例里 `isTrusted` 恒 `true`）。
6. `registry.get` 返回 `null` 时 `executeInProcess` 的新 fail-closed 行为无专门用例。
7. in-process class 仍无独立 child 寿命证据（child exit / socket lifetime），已在 `electron/side-effect-runtime.cjs:12-21` 头注释如实披露，未写成"等价"。
8. D5-03 整体仍 **PARTIAL**。
