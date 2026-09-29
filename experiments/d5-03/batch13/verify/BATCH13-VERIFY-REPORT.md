# D5-03 第十三批 · 独立对抗性验收报告

- 验收岗：独立验收（与执行方 E1/E2/E4 无关联）
- 工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`，分支 `integration/ui-core`
- 被测 commit：`312dc606fee9d9c147a9d863fba7fe504961ab26`（`git rev-parse HEAD` 实测一致）
- 父提交：`48a867c75f94d082d68f9509fed35293454fc65e`
- 时间：2026-09-30

---

## 0. 独立判定（先给结论）

| 对象 | 判定 | 依据强度 |
|---|---|---|
| 门禁 ① `side-effect-c4-gates` · No Direct Domain Bypass | **PASS** | 亲手复现绿、亲手在父提交复现红、三组负向自证全部按预期变红 |
| 门禁 ② `d4-03-approval-push-isolation` · P2 字段集合 | **PASS** | 亲手复现 12/12、封闭集合逐项比对一致、负向注入不同类型字段即红 |
| 真实执行边界（`executeInProcess` 守卫） | **PASS** | 守卫位置可被行为判据检出（V-B）；删除守卫即红（V-A） |
| 本批（两条 D4 门禁收口 + 真实执行边界复核） | **PASS（限定范围）** | 与执行方判定一致 |
| D5-03 整体 | **PARTIAL** | 与执行方判定一致（真机 D5-01 受控浏览器链本批未取得） |

**结论：未发现执行方/上级有任何不成立或夸大的声明。** 所有声明值我均独立复现一致；两处我不同意/需更正的地方见 §8。

---

## 1. 第 1 步 · 改动面与卫生

| 检查 | 命令 | 实测 | 判定 |
|---|---|---|---|
| HEAD | `git rev-parse HEAD` | `312dc606fee9d9c147a9d863fba7fe504961ab26` | ✓ 一致 |
| 改动面 | `git show --stat 312dc60` | 5 files / +482 / −7：`side-effect-domain.cjs` +4、`side-effect-runtime.cjs` +11/−5、`red/inprocess-bypass.mjs` +134、`d4-03-approval-push-isolation.test.mjs` +256、`side-effect-c4-gates.test.mjs` +79 | ✓ |
| 不含 `src/**` | `git show --stat 312dc60 -- src/` | 空 | ✓ |
| 不含 `src/**`（补充） | `git diff --stat 48a867c 312dc60 -- src/` | 空 | ✓ |
| 工作树 diff | `git diff --stat` | 仅 `PROGRESS.md` +51、`docs/D5-03-GATE-EVIDENCE.json` +474 | ✓ |
| `git status --porcelain` | — | 仅两个 `M`（`PROGRESS.md`、`docs/D5-03-GATE-EVIDENCE.json`）+ batch13 的 `??`；**无任何产品/测试文件 `M`** | ✓ |
| 主工作树未被触碰 | `cd "/Users/wepingli/Desktop/OpenArc OS" && git status --porcelain \| wc -l` / `\| md5` | `17` / `f53fad2f3a84d843ea45b66e93ded39e` | ✓ 与规定一致 |

### 未 push 的判定方法（三种独立证据）

1. `git branch -vv` → `* integration/ui-core 312dc60 ...`，**无 `[origin/...]`**，即该分支无上游跟踪引用。
2. `git for-each-ref refs/remotes/` → 无 `refs/remotes/origin/integration/ui-core`（该 ref 本地不存在，故 `git log origin/integration/ui-core..HEAD` 报 `fatal: ambiguous argument`，非"已推送"）。
3. **只读远端核对（决定性）**：`GIT_TERMINAL_PROMPT=0 git ls-remote --heads origin` → 远端 26 个 head 中**根本没有 `integration/ui-core`**（`EXIT=0`，非认证失败）。

> 三点一致：本批 commit 仅存在于本地，**未 push**。正常 `git push` 必然更新远端引用，而远端无此分支。

### worktree / 进程卫生

- `git worktree list`：**无本批遗留临时 worktree**。列表中的 `prunable` 项（`/private/tmp/oa-d303`、`oa-lockscreen`、`oa-profile`、`oa-wt`、`oa-build-*`）均为历史批次遗留，非本批。
- 执行方真机对照用的 `/tmp/oa-b013-base` 已清理（`ls -d` 不存在，worktree list 中亦无）。
- `ps aux | grep -E "node --test|electron"` → 无残留进程。

---

## 2. 第 2 步 · 两条目标门禁的亲手复现计数表

| # | 命令 | tests | pass | fail | exit | 声明值 | 一致 |
|---|---|---|---|---|---|---|---|
| V-10 | `node --test tests/side-effect-c4-gates.test.mjs` | 19 | 19 | 0 | 0 | 19/19/0 | ✓ |
| V-11 | `node --test tests/d4-03-approval-push-isolation.test.mjs` | 12 | 12 | 0 | 0 | 12/12/0 | ✓ |
| V-20 | `node --test tests/d5-01-browser-inprocess-boundary.test.mjs` | 6 | 6 | 0 | 0 | 6/6 | ✓ |
| V-21 | `node --test tests/d5-02-canvas-tool.test.mjs` | 4 | 4 | 0 | 0 | 4/4 | ✓ |
| V-40 | `env -u ELECTRON_RUN_AS_NODE npm test` | 1412 | 1412 | 0 | 0 | 1412/1412/0 | ✓ |

原始输出：`verify/V-10-c4-gates.txt`、`V-11-push-gate.txt`、`V-20-*.txt`、`V-21-*.txt`、`V-40-npm-test.txt`（均含 `# EXIT CODE`）。
`V-40` 实测 `duration_ms 121321`（约 2 分），`suites 0 / cancelled 0 / skipped 0 / todo 0`。

### 补充：独立复现"修前红"前提（不是只核对数字）

把两个产品文件 + 两个测试文件临时换回父提交 `48a867c` 版本后实测：

| # | 命令（在 48a867c 代码上） | tests | pass | fail | exit | 失败者 | 执行方声明 | 一致 |
|---|---|---|---|---|---|---|---|---|
| V-F1 | `node --test tests/side-effect-c4-gates.test.mjs` | 19 | 18 | 1 | 1 | `No Direct Domain Bypass` | 旧 18/19、1 fail | ✓ |
| V-F2 | `node --test tests/d4-03-approval-push-isolation.test.mjs` | 8 | 7 | 1 | 1 | `P2` | 旧 7/8、1 fail | ✓ |

→ "两条长期失败的 D4 门禁"这一前提**独立成立**。换回后 4 个文件 `git hash-object` 与 `git rev-parse 312dc60:<path>` 全部相同。

---

## 3. 第 3 步 · 我自己的负向自证（与执行方不同的破坏方式）

> 执行方用的是：(A) 把 `"ResourceService"` 加进白名单；(B) 往投影加 `ownerUserIdProbe`。已核对 `red/04-*`、`red/05-*`，确认属实。**以下四组均与之不同。**

每组流程：`git diff --exit-code` 确认干净 → 改 → 跑 → 存原始输出 → 还原 → `git diff --exit-code` + `git hash-object` 比对。

**基准（未改动的 `electron/side-effect-runtime.cjs`）**
- `git hash-object`（SHA-1）= `2eafc0d574f21707f98d3a251e9fc777a300079a` = `git rev-parse 312dc60:electron/side-effect-runtime.cjs` ✓
- `shasum -a 256` = `8e7d269d4c768e55a4fec98743e7e082644d134cd1d58f0088c561da11fd5777`（= 执行方 `scopeBoundaries` 声明值，**逐字一致**）

### V-A · 把守卫**整段删掉**（放宽白名单之外的另一条路）

- 手法：`sed -i '' '277,284d'` 删除 `executeInProcess` 内新增的 contract/白名单检查（含注释共 8 行），其它不动。
- 实测：`# tests 19 / pass 18 / fail 1`，`EXIT=1`，失败者 **`not ok 18 - No Direct Domain Bypass…`**
- 预期 vs 实测：**完全符合**（必须红，且失败者必须含 `No Direct Domain Bypass`）✓
- 证据：`verify/V-A1-guard-removed.txt`
- 还原：`git checkout --` 后 `git diff --exit-code -- electron/ tests/` = 0；`git hash-object` = `2eafc0d5…` = HEAD ✓

### V-B · 不打乱白名单，只**把守卫移到 `acquireLease` 之后**（判据一字不改）

- 手法：Python 精确摘出守卫块（8 行），从 `preflight` 前移除、原样插入到 `acquireLease` 成功分支之后、`executeSideEffect` 之前 → `git diff` 呈纯位置搬移（−8/+8，无内容改动）。
- 实测：`# tests 19 / pass 18 / fail 1`，`EXIT=1`，失败者 **`No Direct Domain Bypass`**
- **失败的具体断言（关键）**：
  ```
  被拒的 in-process 调用绝不得建立任何 lease（不是只断 ACTIVE）
  1 !== 0
  at tests/side-effect-c4-gates.test.mjs:524:12
  ```
- 预期 vs 实测：**完全符合**。被拒调用先建了 lease → `leasesOfCall(...).length === 0` 不再成立。
- **判定：门禁的 (b) 位置断言是真实的，不是空断言。**(b) 确实能区分"守卫在 lease 之前"与"守卫在 lease 之后"。
- 证据：`verify/V-B1-guard-moved-after-lease.txt`
- 还原：`git diff --exit-code` = 0；`git hash-object` = `2eafc0d5…` = HEAD ✓

### V-C · 给审批投影加一个**不同类型**的敏感字段

- 手法：往 `approvalSnapshot` 的 `allowed` 集合与 `snap` 对象同时加 `actorUserId: "usr_probe"`（与执行方的 `ownerUserIdProbe` **不同名、不同语义**：前者是操作者身份，后者是所有者身份）。已确认 `actorUserId` 不匹配 `SAFE_SNAPSHOT_SECRET_RE`，因此不会被第二道过滤兜掉 —— 唯一能拦住它的就是封闭集合比较。
- 实测：`# tests 12 / pass 8 / fail 4`，`EXIT=1`
- 失败者：**`not ok 2 - P2`、`not ok 9 - N1`、`not ok 10 - N2`、`not ok 12 - N4`**
- 预期 vs 实测：**完全符合**（必须红）✓
- 证据：`verify/V-C1-projection-actorUserId-added.txt`
- 还原：`git diff --exit-code` = 0；`git hash-object` = `2eafc0d5…` = HEAD ✓

### 正对照 · 把 `CanvasControl` 从白名单删掉（切断**合法**路径）

- 手法：`new Set(["BrowserControl","CanvasControl"])` → `new Set(["BrowserControl"])`。
- 实测：

  | 测试 | 破坏前 | 破坏后 | 变化 |
  |---|---|---|---|
  | `tests/d5-02-canvas-tool.test.mjs` | 4/4/0 exit 0 | **4/4/0 exit 0** | **无变化** |
  | `tests/d5-01-browser-inprocess-boundary.test.mjs` | 6/6/0 exit 0 | **6/6/0 exit 0** | **无变化** |
  | `tests/side-effect-c4-gates.test.mjs` | 19/19/0 | 19/18/1 exit 1 | 红（白名单声明断言 `deepEqual([...],"BrowserControl","CanvasControl")` 捕获） |
  | `tests/d5-02-canvas-edit-proposal.test.mjs`（我补测） | （绿） | **4/3/1 exit 1** | **红** |

- `d5-02-canvas-edit-proposal` 的失败串：`受监督执行失败：{"error":"EXECUTOR_FAILED","status":"APPROVED"}` —— 即 canvas.edit 因不再走 in-process 而被打回 out-of-process executor 并失败。
- **如实报告（与任务书预期不符）**：任务书预期"`d5-02-canvas-tool.test.mjs` 或 D5-01 boundary 应出现变化"，**实测这两个文件毫无变化**。原因经我查证：`d5-02-canvas-tool.test.mjs` 只直接测 CanvasControl **adapter**（`createToolAdapters(...).adapterFor(...)` 的 plan/execute/verify），**从不经过 `SideEffectRuntime.executeInProcess`**。
- 但这**不**意味着白名单是死代码：`tests/d5-02-canvas-edit-proposal.test.mjs` 经 `executeApproved` 真走 in-process（该文件 :152），破坏后立即变红。
- **结论：白名单是真的被使用、且我找到了它的真实行为覆盖点（在另一个文件里）。** 证据：`verify/V-D1/D2/D3/D4-*.txt`
- 还原：`git diff --exit-code` = 0；`git hash-object` = `2eafc0d5…` = HEAD ✓

### 负向自证汇总

| 组 | 手法 | 预期 | 实测 | 符合 |
|---|---|---|---|---|
| V-A | 删掉守卫 | 红，含 No Direct Domain Bypass | 18/19，失败者 = No Direct Domain Bypass | ✓ |
| V-B | 守卫移到 lease 之后 | (b) 行为断言红 | 18/19，`lease length 1 !== 0` | ✓ |
| V-C | 加 `actorUserId` | 红 | 8/12，P2/N1/N2/N4 全红 | ✓ |
| 正对照 | 删 `CanvasControl` | 合法路径变化 | `d5-02-canvas-tool`/D5-01 boundary **无变化**；`d5-02-canvas-edit-proposal` 红 | ⚠ 见发现 F-1 |

**四组全部还原成功，`git diff --exit-code -- electron/ tests/` 均为 0，`git hash-object` 均等于 `312dc60` 内置 blob。**

---

## 4. 第 4 步 · 断言是否被偷偷放宽

命令：`git diff 48a867c 312dc60 -- tests/`，`git diff --numstat`，以及针对性的正则扫描。

### 4.1 diff 中的**全部删除行**（共 5 行，`-` 开头非空行）

| # | 文件 | 删除行 | 被什么替代 | 账本条目（`batch13.assertionChanges`，共 20 条） | 判定 |
|---|---|---|---|---|---|
| D1 | `d4-03-approval-push-isolation.test.mjs` | `"targetDisplayName", "resourceRef", "expectedEffects", "expectedVersion", "currentVersion",` | 展开为加上 `targetRef, url` 的 15 项（原 13 项） | **#10** | ✓ 有替代，且是**扩充**非删减 |
| D2 | 同上 | `"expiresAt", "requiresApproval",` | 同上（15 项） | **#10** | ✓ |
| D3 | 同上 | `assert.deepEqual(Object.keys(event.request).sort(), SNAPSHOT_FIELDS, "推送不得新增/泄露字段")` | 抽为 `assertExactSnapshotKeys()`（内部同为 `assert.deepEqual(Object.keys(request).sort(), SNAPSHOT_FIELDS)`），调用点由 1 处 → 7 处（P2 + N1 + N2×3 + N4×2） | **#11** | ✓ 等价且**更强**（覆盖 7 处） |
| D4 | `side-effect-c4-gates.test.mjs` | `// 生产 runtime 只经受监督 executor 执行，绝不在主进程 in-process 执行 write。`（注释） | 新注释 `// (a) 默认路径：只有受监督 executor 允许做 out-of-process mutation。` | **#1** | ✓ |
| D5 | 同上 | `assert.ok(!/authority\.executeSideEffect\(/.test(runtime), "主进程绝不 in-process 执行 write")` | **删除**，由新增 (a)(b)(c)(d) 四组替代 | **#2** | ✓ 有账本条目且明示"**删除**" |

**结论：5 处删除全部有账本条目，且均有等价或更强的替代。未发现"删除无账本"或"降级替代"。**

### 4.2 降低判据痕迹扫描

| 扫描项 | 命令 | 结果 |
|---|---|---|
| `assert.ok(true)` | `git diff … \| grep -E "^\+.*assert\.ok\(\s*true"` | **none** |
| `.skip` / `todo` / `only` | `grep -E "^\+.*(\.skip\|\.todo\|test\.only\|describe\.only)"` | **none** |
| `length > 0` 取代精确比较 | `grep -E "^\+.*\.length\s*>\s*0"` | 2 处，**均为新增的补充断言**，非替代：<br>· :165 `assert.ok(event.request.resourceRef.length > 0, …)` 与同处 `assert.equal(event.request.resourceRef, preconditionsSafe.resourceRef)` + `typeof === "string"` 并存<br>· :335 `assert.ok(inProcessBody.length > 0, "必须能定位 executeInProcess 方法体")` 后面紧跟精确的 `iPreflight/iLease/iExec` 顺序断言 |
| 删除 `test(` 用例 | `grep -E "^-\s*(test\|it)\("` | **none** |
| 用例数变化 | 48a867c vs 312dc60 | c4-gates `19 → 19`（不变）；push `8 → 12`（+4，N1–N4）。**无删除** |
| `includes` 取代 `deepEqual` | `grep -E "^\+.*includes\("` | 8 处，**全部形如 `assert.equal(x.includes(secret), false)`**，是"敏感内容不得出现"的**负向包含**断言，属加强而非放宽 |
| `deepEqual` 被换成 `assert.ok(` | 逐条比对 | **未发现**。反而 `deepEqual` 使用显著增加（N1–N4 新增多处 `deepEqual`，含 `deepEqual(event.request, got.request)`、`deepEqual(item, got.request)`） |
| `try/catch` 吞断言 | `grep -n catch` 两个门禁文件 | 全部为**清理型**（`fx.close()` / `fs.rmSync` / `child.kill`）；唯一 `catch (e)` 在 `setupBrowser` 装配失败路径，**末尾 `throw e` 重新抛出**，不吞断言 |

### 4.3 `SNAPSHOT_FIELDS` 仍是封闭精确集合 + 与产品 `allowed` 逐项比对

**比较形式**：`assert.deepEqual(Object.keys(request).sort(), SNAPSHOT_FIELDS, …)` —— 精确集合相等。已确认**不存在**子集/超集/长度/`includes` 式弱化（`grep` 无 `SNAPSHOT_FIELDS.*(length|includes|subset|every)` 命中）。

**真实成员数 = 15**，逐项比对：

| # | `SNAPSHOT_FIELDS`（测试） | 产品 `allowed`（`side-effect-runtime.cjs:194`） | `snap` 对象键（:195-212） |
|---|---|---|---|
| 1 | `approvalRequestId` | `approvalRequestId` | `approvalRequestId` |
| 2 | `status` | `status` | `status` |
| 3 | `toolId` | `toolId` | `toolId` |
| 4 | `toolDisplayName` | `toolDisplayName` | `toolDisplayName` |
| 5 | `riskClass` | `riskClass` | `riskClass` |
| 6 | `effectClass` | `effectClass` | `effectClass` |
| 7 | `targetDisplayName` | `targetDisplayName` | `targetDisplayName` |
| 8 | `resourceRef` | `resourceRef` | `resourceRef` |
| 9 | `targetRef` | `targetRef` | `targetRef` |
| 10 | `url` | `url` | `url` |
| 11 | `expectedEffects` | `expectedEffects` | `expectedEffects` |
| 12 | `expectedVersion` | `expectedVersion` | `expectedVersion` |
| 13 | `currentVersion` | `currentVersion` | `currentVersion` |
| 14 | `expiresAt` | `expiresAt` | `expiresAt` |
| 15 | `requiresApproval` | `requiresApproval` | `requiresApproval` |

- 三者**都是 15 项**，**零差异**：`only-in-test = []`、`only-in-allowed = []`、`only-in-snap-not-allowed = []`。
- **多一个少一个都没有。关键契约点成立。**

### 4.4 旧断言逐条仍在（grep 贴证）

```
=== forbidden 文件清单（tests/side-effect-c4-gates.test.mjs:448-458，9 个文件）===
electron/tool-facade-bridge.cjs, electron/side-effect-runtime.cjs, electron/side-effect-bootstrap.cjs,
electron/runtime-supervisor.cjs, electron/side-effect-executor.cjs, electron/preload.cjs,
electron/harness-adapter.cjs, electron/dsh-openarc-read-tools/index.js, src/approval/ApprovalPrompt.tsx
:459  for (const rel of forbidden) {
:461    assert.ok(!/resourceService\s*\.\s*delete/.test(text), rel + " 不得直接调用 ResourceService.delete");
:462    assert.ok(!/ResourceService\s*\./.test(text), rel + " 不得持有 ResourceService");
:466  assert.equal((adapter.match(/resourceService\.delete\s*\(/g) || []).length, 1, "只允许一个真实 mutation 调用点");
:469  assert.ok(/adapter\.execute\(/.test(authority), "controlled write 必须经 adapter.execute");
:471  assert.ok(/riskClass !== "READ_ONLY"/.test(proxy) && /adapter\.execute\(/.test(proxy), "READ_ONLY route 必须显式拒绝非 READ_ONLY");
```

产品侧实测：
- `electron/tool-adapters.cjs` 中 `resourceService.delete(` 调用点 **恰好 1 处**（:77）✓
- `electron/controlled-tool-proxy.cjs:286` `if (contract.riskClass !== "READ_ONLY") return denied(...)` ✓；`:324` `adapter.execute(...)` ✓

→ **旧断言一条未删、判据一条未降。** 被删的唯一一条（D5）恰是那一条**因 D5-01 Closure-2 显式 in-process class 而过时**的全量正则禁令；替代它的 (a)(b)(c)(d) 在提供者维度上**更强**（旧式只禁止任何 in-process 调用，新式钉死白名单恰好 2 个成员 + 非白名单提供者行为上被拒 + 受监督路径仍可用）。

---

## 5. 第 5 步 · 红证据来源可信度

### 5.1 `red/inprocess-bypass.mjs` 关键行号

| 核查点 | 行号 | 实测 | 判定 |
|---|---|---|---|
| 是否**直接**调 `executeInProcess`（而非 `executeApproved`） | **:85** `const res = await fx.sideEffectRuntime.executeInProcess({ callId });` | 是，直接调用公开方法 | ✓ |
| 是否真的在外部观测 Domain 改动 | **:42-43** 包装**真实** `fx.f.resourceService.delete` 并 `return realDelete(...a)` 转发 | 是"观测仪表"，**不是**用假实现替换产品方法 | ✓ |
| 如何观测"资源真被改动" | **:48-60** `domainState()` 读**真实产品状态**：`fx.f.resourceService.sideEffectPrecondition`、`fx.f.resourceStore.resourceRowById`（库 `trash_state`）、`fx.f.store.resourceById`（注册表 `status`） | 读真实 product store，**不是**自建计数器 | ✓ |
| 判定 | **:99-101** `domainMutated` 由真实状态差异导出；:108-111 `bypassProven`/`guardHeld` | ✓ |

→ **未发现"走 `executeApproved`"或"以自建变量冒充 Domain 状态"的情况。** `deleteBox.calls` 是对真实调用次数的计数，且域改动另有独立的真实 store 状态作为第二重证据，两者互相印证。

### 5.2 红证据是否在**未修改**的产品代码上取得

`red/00-pre-diff-confirm.txt` 内容：`HEAD: 48a867c75f…`、`git status --porcelain` 仅 `?? experiments/d5-03/batch13/`、`git diff --stat -- electron/` 与 `-- tests/` **均为空**。
→ ✓ 证明红证据是在**未修改**的产品代码上取得。

### 5.3 **我自己的**红/绿独立复现（不采信执行方的 txt）

我不信任执行方的 red 文本，因此：
1. `git show 48a867c:electron/side-effect-runtime.cjs` 与 `…:side-effect-domain.cjs` 覆盖到工作树（`git hash-object` 实测 = 父提交 blob `7f0c0ef047224ebcdc1740b90e23a5c6474fba02`，与 `git rev-parse 48a867c:…` 相同）。
2. 用**已被 commit 固定的探针** `red/inprocess-bypass.mjs` 跑真实的父提交代码。
3. 得到：**`res.ok: true` / `res.call.status: SUCCEEDED` / `deleteCalls 0→1` / `leaseCount 0→1` / `auditCount 6→12` / `libraryTrashState ACTIVE→TRASHED` / `registryStatus active→deleted` / `placementRows [IN_PROCESS/PROCESS_LOCAL_DOMAIN]` / `verdict: RED_BYPASS_PROVEN`**。
4. 还原后跑 312dc60：**`res.ok:false` / `error:SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED` / `inProcess:false` / `call.status APPROVED` / `deleteCalls 0→0` / `lease 0` / `audit 6→7` / `domainMutated:false` / `placementRows [DENY/IN_PROCESS_NOT_PERMITTED]` / `verdict: GREEN_GUARD_HELD`**。

**排除"红证据是修后伪造"的方法**：
- 父提交 blob 的 SHA-1 与 `48a867c` 密码学绑定，我**用 git 对象本身**（而非执行方提供的文件）重建了被测状态；探针也是 commit 内固定版本，非现场改写。
- 我另用一条**独立于执行方**的破坏路径（V-A 只删守卫）在同一份 312dc60 代码上复现了等价的红，说明"红"的成因**唯一地**就是那段守卫，而非其它修后差异。
- 红/绿两次唯一的输入差异就是那两个产品文件 + 修，无其它变量。

### 5.4 数字自洽性交叉核对

| 量 | 红（未修，执行方） | 红（未修，**我复现**） | 绿（已修，执行方） | 绿（已修，**我复现**） |
|---|---|---|---|---|
| `deleteCalls` | 0→1 | 0→1 ✓ | 0→0 | 0→0 ✓ |
| call 终态 | `SUCCEEDED` | `SUCCEEDED` ✓ | `APPROVED` | `APPROVED` ✓ |
| placement 审计 | `IN_PROCESS`（谎报） | `IN_PROCESS` ✓ | 1 条 `DENY` | 1 条 `DENY` ✓ |
| lease 总数 | 1 | 1 ✓ | 0 | 0 ✓ |
| 审计总数 | 6→12 | 6→12 ✓ | 6→7 | 6→7 ✓ |
| 域状态 | TRASHED/deleted | 同 ✓ | 未变 | 未变 ✓ |

→ **红/绿自洽，且与我的独立复现逐项一致。未发现不自洽。**

### 5.5 `red/00-*` 与 `red/01-*` 的 callId 不同

- `00-*`：`scall_ch4a3Joos_iiLQ`；`01-*`：`scall_nSCKpGKQOExdhA`。我的两次复现亦各得到新 callId（`scall_Z1di_o2Bd7SCWQ` / 另一次）。
- **正常**：每次 `proposeWrite` 都新建一条 SideEffectCall，callId 与运行实例绑定；红/绿是两个独立运行（且绿还换了 commit），callId 必然不同。这不是异常。

---

## 6. 第 6 步 · 文档与真机声明

### 6.1 `docs/D5-03-GATE-EVIDENCE.json` 纯插入独立复算

| 核查 | 实测 | 判定 |
|---|---|---|
| `git diff --numstat` | `474  0`（JSON）+ `51  0`（PROGRESS.md） | ✓ **0 删除**，与声明一致 |
| 插入位置 | `git diff -U0` 唯一 hunk = `@@ -1,0 +2,474 @@`，首行即 `+  "batch13": {` | batch13 插在**文件最前**（`{` 之后），故 `batch12 → EOF` 应逐字节不变 |
| 尾部逐字节相同 | `sha256(worktree: batch12→EOF)` = `e9dac4dca98dda0d1ab2b18ef3e1926ae65a7fa080f055f7373729f223c10767`<br>`sha256(312dc60: batch12→EOF)` = `e9dac4dca98dda0d1ab2b18ef3e1926ae65a7fa080f055f7373729f223c10767` | ✓ **完全相同（同一区间长度 321582 字节）** |
| JSON 合法性 | `python3 -c "import json;json.load(...)"` | ✓ 成功；顶层键顺序 `batch13, batch12, …, batch2, rootFieldsNote, phase, …` |

**我的算法 vs 执行方 sha256 `e9dac4dc…0767`**：
- 我的算法 = `sha256(自首次出现 "batch12" 的字节起，至 EOF)`；**结果与执行方声明值逐字相同**（`e9dac4dca98dda0d1ab2b18ef3e1926ae65a7fa080f055f7373729f223c10767`）。
- 这说明**锚点一致**（"自 `batch12` 起至 EOF"），不是"全文哈希"。
- 参考：是否与执行方不同？我的**全文** sha256（含新插入的 batch13）= `abe3a51f06824fa53dc7d2fb2f420800d1e0266896c6b2953c6a6a7a25b4151f`，`312dc60` 全文 = `216472b2a9fa6ab71894408d024b96436b179dfdd8a79841aeabca96bc48d24e` —— 二者**必然不同**（全文已被插入改变）。执行方用的是**区间锚点**而非全文，**结论正确，无需更正。**
- **结论：纯插入成立，尾部零改动。**

### 6.2 `PROGRESS.md`

- `git diff --numstat` = `51 0` ✓ 纯追加
- 唯一 hunk `@@ -2029,0 +2030,51 @@`（在文件末尾）
- `git diff PROGRESS.md | grep -E "^-" | grep -vE "^--- "` → **无任何删除行**（连注释都没删）✓
- 新增内容为 1 个批次标题 + 5 个小节，未见改动/删除既有章节。

### 6.3 真机 D5-01 control 的"既有失败"结论 —— **我的独立裁定：成立（就"与本批无因果"而言）**

**（a）三次 `S0a` 失败串逐字相同** ✓
```
30 (312dc60)      实际 {"pid":"","cid":"","defaultOk":false}
32 (48a867c 父)   实际 {"pid":"","cid":"","defaultOk":false}
33 (312dc60 复跑) 实际 {"pid":"","cid":"","defaultOk":false}
```
字节级一致。

**（b）父提交 与 312dc60 第 2 次（33）逐条一致** ✓ —— 我逐行抽取 check 序列比对，**完全相同**：

| 顺序 | check | 32 (48a867c) | 33 (312dc60 复跑) |
|---|---|---|---|
| 1 | boot M1 | PASS | PASS |
| 2 | boot M2 | PASS | PASS |
| 3 | setup S0a | FAIL | FAIL |
| 4 | setup S0b | FAIL | FAIL |
| 5 | setup S0c | PASS | PASS |
| 6-11 | ui U1–U6 | PASS ×6 | PASS ×6 |
| 12 | S1.0 | FAIL | FAIL |
| — | 最后到达的 check | **S1.0** | **S1.0** |
| — | 中止点 | `browser-control-e2e.mjs:297:106` | `browser-control-e2e.mjs:297:106` |
| — | exit | 2 | 2 |

- 第 1 次（30）最后到达 **S0a**，中止点 `:255`（`page.evaluate: Target page…closed`）—— 与 32/33 不同。故"312dc60 两次运行互相之间中止点即不同"属实 → **崩溃点非确定性**，不是本批引入的确定性差异。
- 三次均 `EXIT CODE: 2`，均未到达任何浏览器读取/导航/审批副作用场景。

**（c）`32-*` 是否确实跑在 48a867c 上** ✓（带一处证据等级说明）
- 文件第 3 行有 `# git -C /tmp/oa-b013-base rev-parse HEAD = 48a867c75f94d082d68f9509fed35293454fc65e`。**但这是执行方撰写的前置注释，不是原始捕获的 stdout**（raw 块内没有 rev-parse 的调用输出）。
- **不过有更强的原始旁证**：32 的中止栈为
  `at main (file:///private/tmp/oa-b013-base/experiments/d5-01/browser-control-e2e.mjs:297:106)`
  而 30/33 为 `file:///Users/wepingli/Desktop/OpenArc%20OS-integration/…`。**栈帧里的真实路径**证明 32 确实从 `/tmp/oa-b013-base` 这个另一工作树加载并执行 e2e 脚本 —— 这是运行期捕获的原始证据，无法事后伪造。
- 另：该 `/tmp/oa-b013-base` 现已清理，无法二次复跑核验。

**（d）我自己独立确认"本批不含 `src/**`"与构建产物主包哈希** ✓
- `git diff --stat 48a867c 312dc60 -- src/` → **空**。
- 三次构建输出主包**文件名与大小完全相同**：`dist/assets/main-qXEiIhXD.js  373.56 kB`（30/32/33 一致）。
- 渲染层哈希相同 + src 零改动 → **渲染层不可能因本批而漂移**。

**裁定**：`S0a` 在父提交 `48a867c` 上即失败，且在 312dc60 上失败串逐字相同、下游 check 序列逐条相同；本批不触碰 `src/**` 且主包哈希不变。**"S0a 与本批（312dc60）无因果"成立**，执行方把它登记为 `notVerified` 而未当作产品回归、也未用真机画布替代 —— 处理方式正确。

**限定说明（我不同意把话说得更满的部分）**：以上只证明"S0a 存在于父提交"。执行方在 `notVerified` 里进一步称其为"**D5-01 验收基线 f9564b7 之后的设置界面漂移**"—— 该**回归时点**的归因**我没有独立验证**（未在 f9564b7 上复跑真机）。`f9564b7` 经确认确是 `312dc60` 的祖先，但这只支持"时间上可能"，不支持"因果上确实始于该提交"。**建议该项保持"未取得证据"的表述，不要写成已定位。**

### 6.4 独立复跑 `npm test`

| 项 | 实测 | 声明 | 一致 |
|---|---|---|---|
| tests | **1412** | 1412 | ✓ |
| pass | **1412** | 1412 | ✓ |
| fail | **0** | 0 | ✓ |
| exit | **0** | 0 | ✓ |
| duration | 121321 ms | — | — |

原始输出：`verify/V-40-npm-test.txt`（含 `# EXIT CODE: 0`）。命令 `env -u ELECTRON_RUN_AS_NODE npm test`（与本会话 shell 注入的 `ELECTRON_RUN_AS_NODE=1` 对照，执行方的剥离做法正确：该变量会让 electron 退化为纯 Node）。

### 6.5 抽查回归

| 测试 | 实测 | 声明 | 一致 |
|---|---|---|---|
| `tests/d5-01-browser-inprocess-boundary.test.mjs` | 6/6/0 exit 0 | 6/6 | ✓ |
| `tests/d5-02-canvas-tool.test.mjs` | 4/4/0 exit 0 | 4/4 | ✓ |

### 6.6 其他声明抽验

| 声明 | 我的实测 | 判定 |
|---|---|---|
| 执行方 `scopeBoundaries` 的 sha256 `8e7d269d…5777` 与 commit 内置版本一致 | `git show 312dc60:electron/side-effect-runtime.cjs \| shasum -a 256` = `8e7d269d4c768e55a4fec98743e7e082644d134cd1d58f0088c561da11fd5777` | ✓ 逐字一致（与我的 SHA-1 `2eafc0d5…` 只是算法不同，不矛盾） |
| `N2` 长地址 1533 字符 | `len("https://example.com/long?p=" + "a"*1500 + "&end=1")` = **1533** | ✓ 精确一致 |
| 工具门 `url` `maxLength: 2000` | `electron/tool-registry.cjs:180` `maxLength: 2000` | ✓ 证实"2000 上界未被覆盖"的缺口登记属实 |
| `f9564b7` 是 312dc60 祖先 | `git merge-base --is-ancestor f9564b7 312dc60` → YES | ✓ |

---

## 7. 发现清单（按严重度排序）

**未发现严重（High）问题。未发现任何"执行方声明不成立或夸大"的情形。** 以下为低severity/流程性发现：

### F-1（Low · 覆盖归属更正，非产品缺陷）
任务书预期"删掉 `CanvasControl` 后 `d5-02-canvas-tool.test.mjs` 或 D5-01 boundary 应出现变化"。**实测二者毫无变化**（均仍 4/4、6/6 全绿）。经查证：`d5-02-canvas-tool.test.mjs` 只直测 adapter 层（`adapterFor(...).plan/execute/verify`），**从不经过 `SideEffectRuntime.executeInProcess`**，因此它**本来就不是** in-process 白名单的覆盖点。白名单的**真实行为覆盖**在 `tests/d5-02-canvas-edit-proposal.test.mjs`（经 `executeApproved` → 走 in-process），我把该文件在破坏后跑出 **4/3/1 红**（`EXECUTOR_FAILED`）。
→ **白名单不是死代码，它有真实行为覆盖；只是覆盖它的是另一个文件。** 建议后续在 `notVerified`/文档中把 CanvasControl in-process 行为覆盖的归属写准（执行方 JSON 未明确声称由 `d5-02-canvas-tool` 覆盖，故不构成其声明错误，但容易被误读）。

### F-2（Low · 证据等级）
`verify/32-d5-01-control-at-parent-48a867c.txt` 中"跑在 48a867c 上"这一事实，其显式依据是执行方**撰写的注释行**（非原始捕获）。但同一文件的中止栈含真实路径 `file:///private/tmp/oa-b013-base/…`，构成**运行期原始旁证**；结合 src 零改动与主包哈希一致，**我判定该证据可信**。仅建议：真机类证据的前置事实（如 rev-parse）应直接放进 raw 捕获块。

### F-3（Low · 探针判据口径）
`red/inprocess-bypass.mjs:110` 的 `guardHeld` 用 `after.activeLeaseCount === 0`（仅 ACTIVE），而门禁 `side-effect-c4-gates.test.mjs:524` 用 `leasesOfCall(...).length === 0`（全部 lease）。探针口径**略宽于**门禁。因探针同时输出了 `after.leaseCount`（实测 0）且门禁覆盖了更严口径，**不影响结论**；仅提示口径不一致。

### F-4（Info · 已由执行方自行登记的残余缺口，我确认为真）
以下 `notVerified` 项经我抽验**属实**，应予保留：`url` 2000 截断上界未覆盖（N2 仅 1533 字符）、`targetRef` 300 上界无断言、`canvas.edit` 未进推送门禁专门断言、推送目标窗口身份未验（`isTrusted` 恒 true）、`registry.get` 返回 null 时 `executeInProcess` 新 fail-closed 行为无专门用例、in-process class 仍无独立 child 寿命证据（已在头注释如实披露、未写"等价"）。

### F-5（Info · 可维护性约束已被门禁钉死）
门禁 (c) 用**正则/计数**把 `IN_PROCESS_EXECUTION_PROVIDERS` 约束为"恰好 1 处声明、恰好 2 处 `.has(`、成员必须是字符串字面量"。这带来了 4 项文本定位型维护约束（执行方已在 `leftovers` 登记）。属**有意**的封闭集合约束，可接受；但它与 (d) 的 `indexOf` 文本定位一样，属于**源码文本级**断言，对**格式重构**敏感（语义不变也可能变红）。建议知悉，非缺陷。

---

## 8. 我不同意执行方判定 / 需更正之处

1. **关于 `CanvasControl` 覆盖归属**：见 F-1。我不同意"删 `CanvasControl` 会有 d5-02-canvas-tool 或 D5-01 boundary 变化"的隐含预期 —— 实测没有；真实覆盖点是 `d5-02-canvas-edit-proposal.test.mjs`。**这不是说白名单是死代码，恰恰相反我证明了它是活的。**
2. **关于 `S0a` 归因的措辞**：我同意"S0a 与本批无因果"，但**不同意**在没有 f9564b7 真机复跑的情况下把"S0a 起于 f9564b7 之后的设置界面漂移"当作已定位结论陈述。该句在 `notVerified` 中应与"未取得证据"保持同一强度。（属**措辞/证据强度**问题，非事实错误。）

除以上两点，**我未发现执行方或上级任何不成立、夸大或掩盖的声明**。对本批最容易被掩盖的两处（删除行、判据放宽），我的逐条审查结论是：**没有任何一处删除缺少账本条目，没有任何一处判据被降低**，`SNAPSHOT_FIELDS` 与产品 `allowed` 仍是**逐项完全一致的封闭精确集合**（15 = 15）。

---

## 9. 最终判定

| 项 | 判定 |
|---|---|
| 门禁 ① `side-effect-c4-gates` · No Direct Domain Bypass 收口 | **PASS**（19/19/0 亲手复现；真实产品缺陷红→绿经我双重独立复现；三组负向自证全部变红且位置断言非空） |
| 门禁 ② `d4-03-approval-push-isolation` · P2 字段集合收口 | **PASS**（12/12/0 亲手复现；封闭精确集合与产品 `allowed` 逐项一致；注入不同类型字段即红） |
| 真实执行边界复核（`executeInProcess` fail-closed 守卫） | **PASS**（删守卫即红；移位置即红；`CanvasControl` 白名单经证明为活代码；不写 call 状态、误路由不构成 DoS 已被行为断言覆盖） |
| **本批总判定** | **PASS（限定范围）** |
| **D5-03 整体** | **PARTIAL**（真机 D5-01 受控浏览器链本批未取得；`S0a` 既有失败，与本批无因果） |
| 卫生 | 未 push / 未 merge / 未 commit；主工作树 17 项 / md5 一致未被触碰；无本批遗留 worktree 与进程；我对产品的全部临时改动**逐字还原**（`git hash-object` 全部等于 `312dc60` blob，`git diff --exit-code` 全为 0） |

### 仍未验证（诚实清单）

1. 真机 D5-01 受控浏览器链的**功能**证据（本批不存在；三次均 `EXIT 2`，停在 S0a）。
2. `S0a` 失败的**回归时点**（是否确由 f9564b7 之后引入）—— 我未在该提交上复跑真机。
3. `url` 2000 / `targetRef` 300 的**边界**行为（N2 仅覆盖 1533）。
4. `canvas.edit` 进入推送投影的专门断言。
5. 推送**目标窗口身份**（`isTrusted` 恒 true，未证明投递对象与 `getApprovalRequest` 是同一窗口）。
6. `registry.get` 返回 null 时 `executeInProcess` 的 fail-closed 行为无专门用例。
7. in-process class 的**独立 child 寿命证据**（结构上不存在，已如实披露）。
8. `SAFE_SNAPSHOT_SECRET_RE` 全部键名的穷举注入式验证。
9. 本批我未复跑的重回归项（D5-01 37/37、D5-02 48/48、side-effect+D4-03 278/278、D5-01 文档合并集 60/60、真机 D5-02 画布 52 PASS）—— 仅由 `npm test` 1412/1412 与两个抽查项间接覆盖。

---

## 附：本次验收产出的原始证据文件

| 文件 | 内容 |
|---|---|
| `verify/V-10-c4-gates.txt` | 门禁 ① 原始输出（19/19/0 exit 0） |
| `verify/V-11-push-gate.txt` | 门禁 ② 原始输出（12/12/0 exit 0） |
| `verify/V-20-d5-01-boundary.txt` / `V-21-d5-02-canvas.txt` | 抽查回归 6/6、4/4 |
| `verify/V-40-npm-test.txt` | 全量 npm test（1412/1412/0 exit 0） |
| `verify/V-A1-guard-removed.txt` | V-A 负向自证（删守卫 → 红，失败者 = No Direct Domain Bypass） |
| `verify/V-B1-guard-moved-after-lease.txt` | V-B 负向自证（守卫移到 lease 后 → 红，`1 !== 0`） |
| `verify/V-C1-projection-actorUserId-added.txt` | V-C 负向自证（加 `actorUserId` → 红，P2/N1/N2/N4） |
| `verify/V-D1/D2/D3/D4-*.txt` | 正对照（删 `CanvasControl`）四组实测 |
| `verify/V-E1-red-repro-console.txt` + `V-E1-red-repro-at-parent.txt` | **我**在真实父提交 48a867c 上复现 RED |
| `verify/V-E2-green-repro-console.txt` + `V-E2-green-repro-at-312dc60.txt` | **我**在 312dc60 上复现 GREEN |
| `verify/V-F1-pre-c4-gates.txt` / `V-F2-pre-push-gate.txt` | **我**复现"修前红"前提（18/19、7/8） |
