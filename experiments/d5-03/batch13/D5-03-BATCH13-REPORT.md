# D5-03 第十三批 · 执行方报告（执行边界按提供者收口 + 两条 D4 门禁转绿）

- **被测 commit：`312dc60`**（`fix(d5-03): 第十三批 执行边界按提供者收口并修 in-process 白名单绕过`）
- **父 commit：`48a867c`**（`docs(d5-03): 第十二批结果与证据定稿…`），`git log --oneline -2` 实测单提交
- 工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`）
- 取证时 HEAD 实测：`git rev-parse HEAD` = `312dc606fee9d9c147a9d863fba7fe504961ab26`（与要求一致，先确认后开工）
- 取证目录：`experiments/d5-03/batch13/verify/`（原始 stdout+stderr 全部留存；汇总见 `COUNTS.md`）

## 0. 范围边界（如实，且已核对）

- **未** push / merge / rebase / amend / commit（全程只做取证与文档写入）。
- **未**触碰主工作树 `/Users/wepingli/Desktop/OpenArc OS`（其 17 项未提交改动原样）；未触碰 DSH Desktop 共享运行时；未触碰 `~/.dsh`。
- **未**进入 OAuth、D5-04、创建组织入口。
- 除「负向自证」环节**临时**改 `electron/side-effect-runtime.cjs` 外，未改任何产品代码；两次临时改动均**逐字还原**（sha256 与 `git show 312dc60:…` 内置版本一致，`git diff --exit-code` = 0，见 §3.3）。
- 收尾状态（写完全部取证产物、三份 tracked 交付物、并按独立验收更正之后的**最终态**）：
  - `git diff --numstat PROGRESS.md docs/D5-03-GATE-EVIDENCE.json` = **`55  0`** 与 **`502  0`** → **两处删除列均为 0**（纯插入 / 纯追加）。`git diff --stat` = `PROGRESS.md | 55 +`、`docs/D5-03-GATE-EVIDENCE.json | 502 +`，`2 files changed, 557 insertions(+), 0 deletions(-)`。
  - **`git diff --stat -- electron/ src/ tests/` 为空**（产品与测试代码 0 改动）；`git status --porcelain` 其余条目全是 `??`（未跟踪的 batch13 取证产物/报告，以及**独立验收岗**的 `verify/BATCH13-VERIFY-REPORT.md` 与 `verify/V-*.txt` —— 本岗**未改写**它们，其文件属主是独立验收岗）。
  - **JSON 纯插入复核（更正后重跑）**：`python3 -c "import json;json.load(open('docs/D5-03-GATE-EVIDENCE.json'))"` → 成功；自 `"batch12"` 起至 EOF 与 `git show 312dc60:docs/D5-03-GATE-EVIDENCE.json` 对应区段**逐字节相同**（两侧 `len` 均 `321582`、sha256 均 `e9dac4dca98dda0d1ab2b18ef3e1926ae65a7fa080f055f7373729f223c10767`）→ 更正只在 batch13 段内部进行，**旧段一字未动**。
  - 首版插入的 numstat（`51/0`、`474/0`）与首次区间 sha256 证明见 `verify/60-json-pure-insertion-proof.txt`；该文件**保留首版记录（未删改）**，并在文件末尾**追加**了一段「追加 · 更正后复核（定稿态）」（含 `55 0` / `502 0`、两侧区间 sha256、`json.load` 成功与「474→502 是更正本身在 batch13 段内新增、旧段逐字节未动」的结论），最终 **45 行**。更正只在 batch13 段内增改，故区间 sha256 未变、纯插入结论不变。
  - 负向自证还原时点（尚**未**写三份 tracked 交付物）`git diff --exit-code`（全树）= **exit 0**，见 `verify/54-negative-restore-proof.txt`。

## 0.0 改动面（`git show --stat 312dc60`）

```
 electron/side-effect-domain.cjs                    |   4 +
 electron/side-effect-runtime.cjs                   |  16 +-
 experiments/d5-03/batch13/red/inprocess-bypass.mjs | 134 +++++++++++
 tests/d4-03-approval-push-isolation.test.mjs       | 256 ++++++++++++++++++++-
 tests/side-effect-c4-gates.test.mjs                |  79 ++++++++-
 5 files changed, 482 insertions(+), 7 deletions(-)
```

产品代码只有两个文件、净 +15/−5：

- `electron/side-effect-domain.cjs` +4：新增错误常量 `IN_PROCESS_NOT_PERMITTED: "SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED"`（`:120`，含"为什么"注释）。
- `electron/side-effect-runtime.cjs` +11/−5：
  - `executeInProcess` 方法体自身新增 execution placement 守卫（`:277-284`，位于 `:286` preflight 与 `:294` `acquireLease` **之前**）；
  - 文件头「永久边界」表述改为「默认路径 + 唯一白名单例外，且**不是**等价路径」（`:12-21`）。
- **`src/**` 零改动**（`git diff --stat 48a867c 312dc60 -- src/` 为空）；`SCHEMA_VERSION`、预算、审批 TTL 均未动。

### 0.1 红证据（修前）

**① 门禁 `side-effect-c4-gates`（父提交代码，E1 留存于 `../evidence/pre-c4-gates.txt`）**

```
# tests 19
# pass 18
# fail 1
not ok 18 - No Direct Domain Bypass：resource.trash 的唯一 Domain 调用点在 allowlisted adapter + controlled execution 内
```

即：唯一失败断言是 `assert.ok(!/authority\.executeSideEffect\(/.test(runtime), "主进程绝不 in-process 执行 write")`。

**② 真实产品缺陷：`executeInProcess` 白名单绕过（未修改代码，探针 `../red/inprocess-bypass.mjs`）**

原始输出 `../red/00-red-inprocess-bypass.txt`，结构化 `../red/00-red-summary.json`：

| 字段 | 调用前 | 调用后 | 说明 |
| --- | --- | --- | --- |
| `res.ok` / `res.error` | — | `true` / `null` | 没有任何拒绝 |
| `res.inProcess` | — | `true` | — |
| `call.status` | `APPROVED` | `SUCCEEDED` | 真实执行成功 |
| `library_resources.trash_state` | `ACTIVE` | **`TRASHED`** | **真实 mutation** |
| `library_resources.deleted_at` | `null` | **`1700000000000`** | **真实 mutation** |
| `resource_registry.status` | `active` | **`deleted`** | **真实 mutation** |
| `sideEffectPrecondition().trashed` | `false` | `true` | — |
| 主进程 `resourceService.delete` 调用数 | `0` | **`1`** | 在 main 进程真执行了 Domain write |
| lease 行数 | `0` | **`1`** | 绕过白名单却仍建租约 |
| `authorization_audit` 行数（`side_effect.%`） | `6` | **`12`** | — |
| placement 审计 | — | `IN_PROCESS` / `PROCESS_LOCAL_DOMAIN` | **自认**在进程内执行 |

`verdict: RED_BYPASS_PROVEN`。

**③ 门禁 `d4-03-approval-push-isolation`（父提交代码，上级留存 `../evidence/pre-push-gate.txt`）**

```
# tests 8
# pass 7
# fail 1
```
失败者 = `P2 · 当前会话 = A（owner）：推送投递，载荷 = 白名单投影且与 getApprovalRequest 一致`。

### 0.2 绿证据（被测 commit `312dc60`）

| 判据 | 要求 | 实测 |
| --- | --- | --- |
| 门禁 ① `side-effect-c4-gates` | 19/19、fail 0 | **19 tests / 19 pass / 0 fail / exit 0**（`10-gate-c4-nodirectbypass.txt`） |
| 门禁 ② `d4-03-approval-push-isolation` | 12/12、fail 0 | **12 tests / 12 pass / 0 fail / exit 0**（`11-gate-approval-push.txt`） |
| 绕过探针（同一探针） | `ok===false` / 0 mutation / lease 总数 0 | `ok=false`、`error=SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED`、`inProcess=false`、Domain 前后完全一致、`deleteCalls 0`、`leaseCount 0`、`call` 仍 `APPROVED`、恰好 1 条 `DENY / IN_PROCESS_NOT_PERMITTED` 审计、`verdict: GREEN_GUARD_HELD`（`../red/01-green-*`） |
| 完整 `npm test` | 无失败 | **1412 tests / 1412 pass / 0 fail / exit 0**（`40-npm-test-full.txt`，120.2s） |
| 真机 D5-02 画布 | 基线 52/52 | **52 PASS / 0 FAIL / notVerified 0 / exit 0**（`31-electron-d5-02-canvas.txt`） |
| 真机 D5-01 受控浏览器链 | 基线 46 PASS / 0 FAIL / 2 NV | **未取得**：三次运行均 `EXIT CODE: 2`，在 `S0a`（provider/model 安装段）失败；父提交 `48a867c` 上**逐字相同**失败 → 既有失败（§6.1） |

**关键计数变化**：第十二批 `npm test` = 1408 tests / **1406 pass / 2 fail**（exit 1）；本批 = **1412 / 1412 / 0**（exit 0）。`+4` 条用例来自本批给推送门禁新增 N1–N4（8 → 12）；`−2` 条失败正是第十二批登记的两条既有确定性失败，本批已修并转绿。

## 1. 明确区分「旧断言已过时」vs「产品确有缺陷」

本批两条门禁各自的裁定**不同**，必须分开说：

| 门禁 | 失败断言 | 裁定 | 依据 |
| --- | --- | --- | --- |
| `side-effect-c4-gates` · `No Direct Domain Bypass` | `assert.ok(!/authority\.executeSideEffect\(/.test(runtime), "主进程绝不 in-process 执行 write")` | **旧断言确实已过时**，但它**同时掩盖了一个真实产品缺陷** | 过时：D5-01 Closure-2 / D5-02 已把 BrowserControl / CanvasControl 定为**显式进程局部 in-process execution class**（`electron/side-effect-runtime.cjs:38-49` 注释 + `:274` 方法），"主进程绝不执行任何 write"这个**绝对论断**与产品自相矛盾。缺陷：旧断言只是**文本存在性**判据（`!regex.test(src)`），它连"in-process 白名单有几个成员"都管不到 —— 所以 `executeInProcess` 这个**公开方法自身没有 placement 守卫**这件事被它完全漏掉；实测直接调用即可在 main 进程真实执行 `ResourceService.delete`（§0.1 ②）。**裁定：旧句删除成立，但必须补上产品侧 fail-closed 守卫 + 行为级判据。** |
| `d4-03-approval-push-isolation` · `P2` | `SNAPSHOT_FIELDS` 不含 `targetRef` / `url` | **纯属断言过时，产品无缺陷** | `SNAPSHOT_FIELDS` 不是测试自创的期望，而是产品**封闭白名单**的副本：`electron/side-effect-runtime.cjs:194` 的 `allowed` 集合 + `:196-209` 的 `snap` 构造是审批投影唯一数据源。D5-01 Closure-2 为受控浏览器导航审批把 `targetRef`（目标标签身份）与 `url`（**用户正在批准的那个地址**）纳入**用户必须看到**的信息（`:204`/`:206` 的三元 + 注释；UI 侧 `src/approval/ApprovalPrompt.tsx:186` `data-approval-target`、`:190` `data-approval-url` 确实渲染）。测试的期望集合没跟上这次契约扩展。**裁定：断言过时，按现行契约更新；判据不降低（仍是封闭精确集合）。** |

### 1.1 判据没有被降低（反而更严）—— 三条可复现证据

1. **提供者集合仍是封闭精确集合**：门禁 (c) 精确解析 `Object.freeze(new Set([...]))` 字面量并断言成员**恰好等于** `["BrowserControl","CanvasControl"]`、只允许 1 处声明、只允许 2 处只读 `.has(`、禁止 `.add/.delete/.clear`、禁止 `Object.assign/defineProperty`、成员只允许字符串字面量。旧的「不出现 `authority.executeSideEffect(`」是纯文本判据，管不到成员数。
2. **新增行为级拒绝证明**（不只读源码）：真造一条 `resource.trash`（`executionProvider=ResourceService`）call，直接调 `executeInProcess` → `ok===false`、`error==="SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED"`、`inProcess===false`、Domain 0 mutation、**lease 总数 0**（守卫在 `acquireLease` **之前** return，所以不是只断 `ACTIVE`）、call **仍 `APPROVED`**（不把误路由变成 DoS）、恰好 1 条 `DENY` 审计、且**同一 call 随后经受监督路径仍能成功执行**。
3. **字段集合仍是封闭精确集合**：`SNAPSHOT_FIELDS` 仍是 `assert.deepEqual(Object.keys(...).sort(), SNAPSHOT_FIELDS)` 的**精确键集合比较**（15 项），**没有**改成 `length > 0` / 子集 / 通配；并把该精确比较从 1 处（P2）**扩到 7 处**（P2 + N1 + N2×3 + N4×2）。

## 2. 既有断言的每处改动：旧句 → 新句 → 契约依据

### 2.1 E1 面：`tests/side-effect-c4-gates.test.mjs`（`No Direct Domain Bypass`，用例起于 `:445`）

| # | 位置 | 旧句 | 新句 | 契约依据（文件:行） |
| --- | --- | --- | --- | --- |
| 1 | 旧 `:471` 注释 | `// 生产 runtime 只经受监督 executor 执行，绝不在主进程 in-process 执行 write。` | **删除**，改 `// (a) 默认路径：只有受监督 executor 允许做 out-of-process mutation。`（新 `:473`） | `electron/side-effect-runtime.cjs:12-21`（头注释已写明"默认路径 + 唯一白名单例外"） |
| 2 | 旧 `:474` 断言 | `assert.ok(!/authority\.executeSideEffect\(/.test(runtime), "主进程绝不 in-process 执行 write")` | **删除**（由下面 (a)(b)(c)(d) 共同替代） | 同上 + `:274`（in-process class 是已验收契约） |
| 3 | `:474` 保留项 | `assert.ok(/supervisor\.spawnExecutor\(/.test(runtime), "production write 必须经 supervisor.spawnExecutor")` | **保留，原文不动** | `electron/side-effect-runtime.cjs:337` |
| 4 | **新增 (c)** `:476-484` | 无 | 静态解析：`IN_PROCESS_EXECUTION_PROVIDERS = Object.freeze(new Set([...]))` 字面量；成员**恰好** `["BrowserControl","CanvasControl"]`；全文只有 1 处赋值、只有 2 处只读 `.has(`；无 `.add/.delete/.clear`；无 `Object.assign/defineProperty`；成员只允许字符串字面量 | `electron/side-effect-runtime.cjs:49`（唯一声明）、`:281`（守卫）、`:322`（分流） |
| 5 | **新增 (d)** `:486-495` | 无 | 源码级：`executeInProcess` 方法体内 `preflightAuthorization` → `acquireLease` → `executeSideEffect` 的**顺序**成立，且含 `action: "side_effect.execution_placement", decision: "IN_PROCESS"` | `electron/side-effect-runtime.cjs:286`、`:294`、`:300`、`:293` |
| 6 | **新增 (b)（核心）** `:511-537` | 无 | 行为：直接调 `executeInProcess({callId})` 对 `resource.trash`（provider=`ResourceService`）→ `ok===false`、`error==="SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED"`、`inProcess===false`、Domain 0 mutation、**lease 总数 0**、call 仍 `APPROVED`、恰好 1 条 `DENY`/`IN_PROCESS_NOT_PERMITTED` 审计；随后同一 call 经 `executeApproved` **仍成功** | `electron/side-effect-runtime.cjs:277-284`（守卫在 `:286` preflight 与 `:294` `acquireLease` **之前**）、`electron/side-effect-domain.cjs:120` |
| 7 | **新增 (a)** `:539-550` | 无 | 行为：`resource.trash` 走 propose → APPROVE → `executeApproved` 后 `res.ok===true`、真实 `trashed===true`、lease **恰好 1**、`verificationStatus==="PASS"`、主进程 `resourceService.delete` 调用数不变 | `electron/side-effect-runtime.cjs:318-337`（受监督路径）+ SideEffectAuthority 的 `PASS` 判定 |
| 8 | `:19` 新增 require | 无 | `const { SIDE_EFFECT_ERROR } = require("../electron/side-effect-domain.cjs");` | `electron/side-effect-domain.cjs:120` |

**未改动的既有断言（判据一条未降）**：`forbidden` 9 个文件扫描（`resourceService.delete` / `ResourceService.` 均不得出现）、`tool-adapters.cjs` 中 `resourceService.delete(` 恰好 1 处、`side-effect-authority.cjs` 必须经 `adapter.execute(`、`controlled-tool-proxy.cjs` 必须 `riskClass !== "READ_ONLY"` 且经 `adapter.execute(` —— 全部逐字保留。

### 2.2 E2 面：`tests/d4-03-approval-push-isolation.test.mjs`

| # | 位置 | 旧句 | 新句 | 契约依据（文件:行） |
| --- | --- | --- | --- | --- |
| 1 | `SNAPSHOT_FIELDS`（`:37`，13 项） | 不含 `targetRef`、`url` | **加入 `targetRef`、`url`（15 项）** | `electron/side-effect-runtime.cjs:194`（`allowed` 集合）、`:204`（`targetRef` = `pre.targetRef` slice 300）、`:206`（`url` = `pre.url` slice 2000）；`src/approval/ApprovalPrompt.tsx:186`、`:190` |
| 2 | P2 内联断言（旧） | `assert.deepEqual(Object.keys(event.request).sort(), SNAPSHOT_FIELDS, "推送不得新增/泄露字段")`（1 处） | 抽出 `assertExactSnapshotKeys()`（`:50`），**同样做精确键集合 deepEqual**，改由 **P2 + N1 + N2×3 + N4×2 共 7 处**调用（`:202`、`:316`、`:343`、`:353`、`:373`、`:424`、`:436`） | 同一封闭白名单；把"精确集合"从 1 处扩到 7 处，**判据只增不减** |
| 3 | 新增 **N1**（`:308`） | 无 | `resource.trash` 推送：精确键集合；`request.targetRef === null` 且 `request.url === null`；推送文本不含 `浏览器标签`、不含 `http(s)://`；**非空转**断言 `planned.call.preconditionsSafe` 必须存在，`request.resourceRef` 等于它且为**非空 string**；`preconditionsSafe` 键集合精确等于 `["expectedVersion","registryStatus","resourceRef"]` | `electron/tool-adapters.cjs` 的 `trashPlan`（`preconditions: { resourceRef, expectedVersion, registryStatus }`，无 `targetRef`/`url`）→ 投影必然为 `null`（`electron/side-effect-runtime.cjs:204-206` 的三元） |
| 4 | 新增 **N2**（`:331`） | 无 | `browser.navigate` 推送 1 条；`request.url === 被提案的地址`（精确相等）；`request.targetRef === "browser#t1"`；`targetDisplayName === "浏览器标签 browser#t1"`；推送 = `getApprovalRequest` = `listPending` 三处 `deepEqual`；长地址与带 query/path/fragment 的地址原样未截断；页面正文标记不出现；审批阶段 0 真实导航 | `electron/tool-adapters.cjs:191-198`（`preconditions: { targetRef: viewId, targetType: "browser-tab", url }`）；`electron/side-effect-runtime.cjs:194-209`；`src/approval/ApprovalPrompt.tsx:186`、`:190` |
| 5 | 新增 **N3**（`:384`） | 无 | 把 P1/P4/P6 的 0 投影语义扩展到 `browser.navigate`：B 会话 0 推送 + `listPending` 空 + `getApprovalRequest` 返回 `SIDE_EFFECT_CALL_NOT_FOUND`；未登录 0 推送 + call 仍 `AWAITING_APPROVAL` + `approvalSnapshot({context:{}})` / `{context:{sessionRef:null}}` / `{context:{sessionRef:B}}` 均 `null` | `electron/side-effect-runtime.cjs:174-179`（声明 context 必须有真实 session 且等于 task 的 `session_ref`）、`electron/identity-bootstrap.cjs:295-299`（推送按当前 authenticated session 重新投影） |
| 6 | 新增 **N4**（`:415`） | 无 | 两场景推送文本不含绝对路径（`/Users/`、`/private/`、`/var/folders`）、不含 store root、不含 `slease_` / `tappr_`；两场景各做一次精确键集合比较（`:424`、`:436`）；含 `user:pass@host` 的地址在**提案阶段**即被拒（`ok===false`、`error==="TOOL_ARGUMENT_INVALID"`、`decisionStatus==="INVALID"`）且 0 推送 / 0 新 call / 凭据不进投影 | `electron/tool-registry.cjs:180`（`browser.navigate` inputSchema `pattern: "^https?://[^\\s@]+$"`，工具门排除 `@`）；`electron/tool-registry.cjs:44`、`:46`（schema 校验）；`electron/side-effect-runtime.cjs:209-210`（白名单 + 敏感键名过滤） |
| 7 | 新增 require / 常量（`:14`、`:30-35`、`:47-48`） | 无 | `BrowserControlAuthority`；`NAVIGATE = "browser.navigate"`；`INTERNAL_ID_RE = /slease_|tappr_/i`；`SITE`/`VIEW`/`PAGE2`/`PAGE_TEXT` | 与 `tests/side-effect-c4-gates.test.mjs:488` 同款"内部 authority id 不得外泄"判据写法 |
| 8 | 新增夹具（`:39-47`、`:119-152`、`:81-89`） | 无 | 顶部注释说明旧断言为何失效；`assertExactSnapshotKeys()`；`fakeBrowserController()`；`setupBrowser()`（真实 `BrowserControlAuthority` + 真实 `SideEffectRuntime.proposeWrite`，只取"提案 → 审批快照/推送"一段） | D5-01 Closure-2 浏览器场景；真实导航执行/验证由 D5-01 回归覆盖，避免重复装配 |

**没有一条既有断言被削弱**：P1、P3、P4、P5、P6、P7、P8 语句**逐字未改**；P2 只改了字段集合这一处（第 1、2 行），其余断言（推送条数、推送 = 读取、`listPending` 可发现、不含 store root / 绝对路径）原样保留。

### 2.3 产品侧（非断言）改动

| 文件:行 | 改动 | 契约依据 |
| --- | --- | --- |
| `electron/side-effect-runtime.cjs:12-21` | 头注释「真实 mutation **只**发生在受监督 executor、主进程**绝不**直接执行 write」→「默认路径是受监督 executor；唯一例外是 Domain 权威只在 main 的 provider（BrowserControl / CanvasControl）走显式白名单 in-process class；**它不是等价路径**（放弃 child 寿命证据），preflight/approval/lease/claim/exactly-once/verify/audit 仍由**同一个** authority 裁决；白名单是静态字面量，绝不从 arguments/plan 解析」 | 只披露真实边界，不写"等价" |
| `electron/side-effect-runtime.cjs:277-284` | `executeInProcess` 方法自身新增 fail-closed 守卫：`registry.get` 拿不到 contract、或 `contract.executionProvider` 不在 `IN_PROCESS_EXECUTION_PROVIDERS` → 写 1 条 `execution_placement / DENY / IN_PROCESS_NOT_PERMITTED` 审计并返回 `{ok:false, inProcess:false, error: SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED, call}`；**不写 call 状态** | 公开方法不能只靠 `executeApproved` 分流；误路由不得把合法 call 打成 `BLOCKED`（DoS） |
| `electron/side-effect-domain.cjs:120` | 新增 `IN_PROCESS_NOT_PERMITTED: "SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED"` | 本批新增契约 |

## 3. 负向自证（故意放宽 → 新门禁必须变红）

每次都是：`git diff --exit-code` 确认干净 → 改 → 跑 → 存原始输出 → **逐字还原** → 再 `git diff --exit-code` 确认。

### 3.1 A 组 · 把 `ResourceService` 放进 in-process 白名单

改动：`electron/side-effect-runtime.cjs:49` 由 `new Set(["BrowserControl","CanvasControl"])` 临时改为 `new Set(["BrowserControl","CanvasControl","ResourceService"])`。

**（i）静态门禁变红** —— `50-negative-whitelist-widened.txt`：

```
# tests 19
# pass 16
# fail 3
# EXIT CODE: 1
not ok 9  - Concurrent Approve click → 单一 authoritative approval transition；1 lease / 1 execution
not ok 12 - Task Cancel Race：executor eligibility 窗口内 cancel → 0 Domain invocation
not ok 18 - No Direct Domain Bypass：resource.trash 的唯一 Domain 调用点在 allowlisted adapter + controlled execution 内
```

第 18 条即目标判据（`in-process 白名单必须恰好等于 BrowserControl + CanvasControl` 的 `deepEqual` 失败）；第 9、12 条是同一次放宽改变 lease / Domain 调用计数带来的**连带**走红。

**（ii）行为级真实 mutation 复现** —— `51-negative-whitelist-widened-behavior.txt`：

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
| placement 审计 | — | `IN_PROCESS` / `PROCESS_LOCAL_DOMAIN` |

`verdict: RED_BYPASS_PROVEN`，`guardHeld: false`。→ 证明门禁 (b) 的**行为判据本身**会随白名单放宽而失效，而不只是静态正则先红。

### 3.2 B 组 · 给审批投影多加一个敏感字段

改动：`electron/side-effect-runtime.cjs` 的 `approvalSnapshot` 临时在 `allowed` 集合（`:194`）加入 `"ownerUserIdProbe"`，并在 `snap` 里加 `ownerUserIdProbe: "probe-user"`。

`52-negative-projection-field-added.txt`：

```
# tests 12
# pass 8
# fail 4
# EXIT CODE: 1
not ok 2  - P2 · 当前会话 = A（owner）：推送投递，载荷 = 白名单投影且与 getApprovalRequest 一致
not ok 9  - N1 · 反例 · 资源回收审批不携带任何浏览器目标
not ok 10 - N2 · 正例 · 浏览器导航：推送 / 读取 / 列表三处同一个待批准地址
not ok 12 - N4 · 反例 · 路径 / 凭据 / 其它未准许字段一律不得进入推送
```

失败者恰为 P2 / N1 / N2 / N4（四处精确键集合比较）→ 与要求一致。

### 3.3 三组负向自证的还原证明（`54-negative-restore-proof.txt`）

| 项 | 值 |
| --- | --- |
| 还原方式 | `cp /tmp/oa-b13-runtime.orig.cjs electron/side-effect-runtime.cjs`（A、B 各一次） |
| `shasum -a 256 electron/side-effect-runtime.cjs` | `8e7d269d4c768e55a4fec98743e7e082644d134cd1d58f0088c561da11fd5777` |
| 备份文件 sha256 | **同一值** |
| `git show 312dc60:electron/side-effect-runtime.cjs \| shasum -a 256` | **同一值**（与提交内置版本逐字节相同） |
| `git diff --exit-code -- electron/ tests/` | **exit 0** |
| `git diff --exit-code`（全树） | **exit 0** |
| `git status --porcelain` | 只有 `??` 未跟踪项，**无产品文件改动** |

### 3.4 步骤 C · 还原后正常路径仍通过（`53-positive-paths-still-pass.txt`）

| 路径 | 命令 | tests | pass | fail | exit |
| --- | --- | --- | --- | --- | --- |
| 门禁 ① 重跑 | `node --test tests/side-effect-c4-gates.test.mjs` | 19 | 19 | 0 | 0 |
| 门禁 ② 重跑 | `node --test tests/d4-03-approval-push-isolation.test.mjs` | 12 | 12 | 0 | 0 |
| 画布编辑 | `node --test tests/d5-02-canvas-tool.test.mjs` | 4 | 4 | 0 | 0 |
| 浏览器导航（in-process 成功） | `node --test tests/d5-01-browser-control-chain.test.mjs` | 5 | 5 | 0 | 0 |
| 合法 in-process 调用方 | `node --test tests/d5-01-browser-inprocess-boundary.test.mjs` | 6 | 6 | 0 | 0 |
| 探针（守卫仍拦 `ResourceService`） | `node experiments/d5-03/batch13/red/inprocess-bypass.mjs` | — | — | — | 0，`verdict: GREEN_GUARD_HELD` |

> **覆盖归属更正（据独立验收 F-1，2026-09-30）**：上表"画布编辑"一行的 `tests/d5-02-canvas-tool.test.mjs` **只直测 CanvasControl adapter 层**（`adapterFor(...).plan/execute/verify`），**从不经 `SideEffectRuntime.executeInProcess`**；"合法 in-process 调用方"一行的 `tests/d5-01-browser-inprocess-boundary.test.mjs` **只覆盖 BrowserControl**。把 `CanvasControl` 从白名单删掉后，这两个文件实测**毫无变化**（仍 4/4、6/6 全绿）→ 它们**都不是** CanvasControl in-process 白名单的覆盖点。**CanvasControl in-process 的真实行为覆盖 = `tests/d5-02-canvas-edit-proposal.test.mjs`**（经 `executeApproved` 真走 in-process；破坏后实测 `4/3/1` 红，`EXECUTOR_FAILED`），该文件在本批 D5-02 回归（`21-…`）中为绿。上表两行只说明"还原后这些命令仍通过"，**不代表**它们覆盖了 CanvasControl 的 in-process 路径。

「正常资源回收（受监督 executor 真实 trash 成功）」由门禁 ① 内的 (a) 行为断言承担（`executeApproved` → `ok===true`、`trashed===true`、恰好 1 lease、`verificationStatus==="PASS"`），本轮 19/19 通过。

## 4. 门禁计数表（本批两条目标门禁 + 回归 + 真机 + `npm test`）

| # | 门禁 / 命令 | tests | pass | fail | skipped | exit | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `node --test tests/side-effect-c4-gates.test.mjs` | 19 | **19** | **0** | 0 | **0** | 达标（19/19） |
| 2 | `node --test tests/d4-03-approval-push-isolation.test.mjs` | 12 | **12** | **0** | 0 | **0** | 达标（12/12） |
| 3 | D5-01 回归 6 文件（`20-…`） | 37 | **37** | **0** | 0 | **0** | 全绿 |
| 4 | D5-02 回归 7 文件（`21-…`） | 48 | **48** | **0** | 0 | **0** | 全绿 |
| 5 | `tests/side-effect-*.test.mjs` + `tests/d4-03-*.test.mjs`（`22-…`） | 278 | **278** | **0** | 0 | **0** | 全绿 |
| 6 | 文档口径 D5-01 合并集（`23-…`，`docs/D5-01-RESULT.md:79`） | **60** | **60** | **0** | 0 | **0** | 全绿（文档写的 59/59 已过期，见 §4.2） |
| 7 | 真机 D5-01 `test:d5-01-control`（`30-…`，第 1 次） | — | 2 条 PASS | 1 条 FAIL | — | **2** | **未取得**（既有失败，§6.1） |
| 8 | 真机 D5-02 `node experiments/d5-02/canvas-e2e.mjs`（`31-…`） | 52 | **52** | **0** | — | **0** | 达标（基线 52/52） |
| 9 | 基线对照 `48a867c` worktree 跑 `test:d5-01-control`（`32-…`，端口 9791） | — | 8 条 PASS | 3 条 FAIL | — | **2** | `S0a` 逐字相同失败 → **既有** |
| 10 | `test:d5-01-control` 复核（`33-…`，HEAD、端口 9792） | — | 8 条 PASS | 3 条 FAIL | — | **2** | 与 `48a867c` 序列逐条一致 |
| 11 | `env -u ELECTRON_RUN_AS_NODE npm test`（`40-…`，219 文件） | **1412** | **1412** | **0** | 0 | **0** | **全绿** |
| 12 | 负向自证 A（静态，`50-…`） | 19 | 16 | **3** | 0 | **1** | 按要求变红 |
| 13 | 负向自证 B（`52-…`） | 12 | 8 | **4** | 0 | **1** | 按要求变红 |

### 4.1 `npm test` 失败归因

**本批 `npm test` 无任何失败**（1412/1412/0，exit 0），故没有需要逐条判定的失败项。与第十二批对照：tests 1408 → **1412**（+4 = 新增 N1–N4）；fail 2 → **0**（第十二批登记的两条既有确定性失败已修并转绿）；无 skipped / todo / cancelled / flake。

### 4.2 D5-01 文档口径 59/59 → 实测 60/60（归因：文档计数过期，非产品回归）

- `docs/D5-01-RESULT.md` 最后一次提交是 `f93e835`；在该提交上逐文件统计 `test(` 声明数 = `window-domain 11 + window-manager 16 + occlusion 18 + d5-01-browser-tabs 9 + d5-01-browser-policy 5` = **59**。
- `f9564b7`（"fix(d5-01): 提示条被原生视图盖住…"）把 `tests/window-manager.test.mjs` 由 **16 条增为 17 条** → 合计 **60**；`f9564b7..312dc60` 之间该文件只有断言口径更新（+10/−4），用例数不变。
- 独立复算（把 `f9564b7` 的 5 个文件放进 `/tmp/oa-b013-base` 隔离宿主，`electron`/`node_modules` 软链到本工作树）→ `# tests 60`（该次 57 pass / 3 fail 是"旧测试配新产品的窗口口径"造成的预期错配，与本批无关）。
- `git show --stat 312dc60` **不含**这 5 个文件。
- **结论：当前 60/60 PASS、fail 0，比文档口径多 1 条且全过，非产品回归。**

## 5. 已知脆弱点 / 维护约束（E1 登记的计数型断言）

以下断言是**计数型 / 文本定位型**维护约束。它们变红时，**先判断是"产品合法演进"还是"判据被突破"**，不要一律当成门禁坏了：

| 断言 | 当前值 / 定位依赖 | 变红的正当原因与处置 |
| --- | --- | --- |
| `(runtime.match(/IN_PROCESS_EXECUTION_PROVIDERS\s*=/g) \|\| []).length === 1` | 唯一静态声明在 `electron/side-effect-runtime.cjs:49` | 只允许一处声明本身即契约；若出现第二处赋值点，说明白名单被运行时改写，门禁**必须**红，**不得**放宽 |
| `(runtime.match(/IN_PROCESS_EXECUTION_PROVIDERS\.has\(/g) \|\| []).length === 2` | 守卫 `:281` + 分流 `:322`，当前恰好 2 | 合法新增第三处只读 `.has(`（例如再增设一条执行路径的 placement 判定）也会红；此时应**同步把计数改为 3、在报告中登记新增调用点**，属门禁维护，不是产品缺陷 |
| `(d)` 用 `runtime.indexOf("async executeInProcess(")` 与相邻注释 `/** 受监督 executor runtime 执行一条已 APPROVED 的 call */` 定位方法体 | 方法在 `:274`；结束标记注释随后 | 改写该注释文本会让方法体切不出/切错，`assert.ok(inProcessBody.length > 0)` 先红；改注释时需同步更新门禁定位串，属**源码定位脆弱** |
| `assert.match(whitelistDecl[1], /^\s*"[^"]+"(\s*,\s*"[^"]+"\s*)*$/)` | 成员只能写成字符串字面量 | 若白名单改从常量数组/配置读入（即便取值不变）也会红 —— 这正是"不从 arguments / plan 动态解析"的判据，**必须**保持字面量 |

以上四项均为**故意收紧**：把"白名单封闭 + in-process 路径完整"从文本存在性提升为可数、可定位的约束。任何放宽都需显式改门禁并在报告留痕。

另（**覆盖归属更正**，据独立验收 F-1）：`CanvasControl` in-process 白名单的**行为覆盖点**是 `tests/d5-02-canvas-edit-proposal.test.mjs`（经 `executeApproved` 走 in-process），**不是** `tests/d5-02-canvas-tool.test.mjs`（只覆盖 adapter 层），也**不是** `tests/d5-01-browser-inprocess-boundary.test.mjs`（只覆盖 BrowserControl）。见 §3.4 与 §6.2 第 7 条。

## 6. 未验证项与剩余缺口（如实）

### 6.1 真机 D5-01 受控浏览器链：**本批未取得**（既有失败，不在本批范围）

命令 `env -u ELECTRON_RUN_AS_NODE npm run test:d5-01-control`（含 `npm run build`）。三次运行：

| 顺序 | commit | 文件 | 最后到达的 check | 中止点 | exit |
| --- | --- | --- | --- | --- | --- |
| 1 | `312dc60`（HEAD） | `30-…` | `setup · S0a` | `experiments/d5-01/browser-control-e2e.mjs:255`（`Target page, context or browser has been closed`） | 2 |
| 2 | `48a867c`（父提交，临时 worktree） | `32-…` | `ui · U6` | `:297`（`TypeError: Cannot read properties of undefined (reading 'status')`） | 2 |
| 3 | `312dc60`（HEAD，端口 9792） | `33-…` | `ui · U6` | `:297`（同上） | 2 |

- **三次共有**：`S0a · 真实 UI 创建确定性 provider/model 并设为默认 chat` 均 **FAIL**，失败串**逐字相同**：`实际 {"pid":"","cid":"","defaultOk":false}`；均 `EXIT CODE: 2`；均**未**产出 `artifacts/d5-01/d5-01-browser-control-e2e.json`；均**未**进入任何浏览器读取 / 导航 / 审批副作用场景。
- **差异**：`312dc60` 的两次运行**互相之间**中止点就不同（`:255` vs `:297`）→ 中止点**非确定性**；第 3 次与第 2 次（父提交）的 check 序列与中止点**逐条一致**。
- 第 1 次运行 stderr 出现两条 `DevTools listening`（端口 9790）——该日志为**追加写**且运行前已存在（已备份 `/tmp/oa-b13-stderr-before-step33.txt`），其中一条是历史残留；第 3 次运行前后清空日志，全过程只有 **1** 条 → 无重复实例。
- **裁定**：`S0a` 失败在父提交 `48a867c` 上同样发生且失败串**逐字相同** → **与本批 `312dc60` 无因果**，属既有失败。**其回归时点未定位**：本批**未在 `f9564b7` 上复跑真机**，只能确认 `f9564b7` 是 `312dc60` 的祖先（`git merge-base --is-ancestor f9564b7 312dc60` 成立）、且 D5-01 验收期记录为 46 PASS —— 所以"S0a 起于 `f9564b7` 之后"只有**时间上的可能**，**没有因果证据**，**不作为已定位结论**。本批产品改动只有 `side-effect-runtime.cjs`（`executeInProcess` 守卫）+ `side-effect-domain.cjs`（一个错误常量），位于 provider/model 安装段**之后**的任何浏览器/副作用执行路径上，不在这条 UI 路径上。
- **线索（非已定位根因）**：dock 选择器 `data-app-id` 在 merge `7d707ab` 被删除（`f9564b7` 仍在 `src/main.tsx:361`），而 `experiments/d5-01/browser-control-e2e.mjs`、`experiments/d5-01/visibility-e2e.mjs:139`、`experiments/d5-01/browser-inprocess-boundary-e2e.mjs:198` 仍在使用它。这条**只是线索**，本批**没有**独立验证它在 `f9564b7` 就是首个失败点。
- **后果（不美化）**：**本批未取得浏览器导航的真机 UI 证据**（"界面显示同一个待批准地址"这条）。本批该点的可核查依据只有：**(a)** `src/approval/ApprovalPrompt.tsx:186` `data-approval-target` / `:190` `data-approval-url` 渲染的正是门禁 ② 现在逐字钉住的投影字段（`targetRef` / `url`）；**(b)** `src/**` 本批零改动（`git diff --stat 48a867c 312dc60 -- src/` 为空），且三次 `npm run build` 产物主包哈希**完全相同**（`dist/assets/main-qXEiIhXD.js 373.56 kB`），说明被驱动的渲染层与父提交同源；**(c)** D5-01 验收期已通过的 S2.1/S2.2 记录（`docs/D5-01-CLOSURE4-RESULT.md`）。**不得**写成"真机复验通过"。
- **登记**：`test:d5-01-control` **当前不可达其浏览器场景**（安装段 `S0a` 在父提交 `48a867c` 与本批上同样失败且失败串逐字相同）；其**失效 / 回归时点未定位**（未在 `f9564b7` 上复跑真机；仅能确认 `f9564b7` 是 `312dc60` 的祖先，及 D5-01 验收期记录为 46 PASS）。修它需要动 `src/settings/ModelSettings.tsx` 或 e2e 驱动，属 **D5-01 门禁修复**，**不在本批范围**（需另开批次并走设计对齐）。检索 `docs/`、`PROGRESS.md`、`experiments/` 未发现此前登记过该失效。
- **"跑在 `48a867c` 上"的证据等级（独立验收 F-2）**：`verify/32-…` 里该事实的**显式依据**是本批撰写的前置注释行（**不是** raw 捕获）；**运行期原始旁证**是同一文件中止栈里的真实路径 `at main (file:///private/tmp/oa-b013-base/experiments/d5-01/browser-control-e2e.mjs:297:106)`，而 `30-…` / `33-…` 的栈为 `file:///Users/wepingli/Desktop/OpenArc%20OS-integration/…`。独立验收据此裁定**该证据可信**；后续真机类证据的前置事实（如 `rev-parse`）应直接放进 raw 捕获块。

### 6.2 其余未覆盖

1. **`url` 的 2000 截断上界未覆盖**：N2 用的长地址只有 **1533** 字符（低于工具门 `maxLength: 2000`），证明的是"未被更小上界截断"，**不是**"2000 处不截断"。真正覆盖需 ① 2000 字符整（工具门放行、投影逐字原样）；② 2001 字符（工具门拒绝、0 call）——均**未**产出证据。
2. **`targetRef` 的 300 字符上界无断言**（`electron/side-effect-runtime.cjs:204`）；`sanitizePreconditions` 对超界走 fail-closed 丢弃（`electron/side-effect-authority.cjs:124-125`）的边界红/绿证据未产出。
3. **`canvas.edit` 未进审批推送门禁**：它走同一处投影代码（`resourceRef` 为画布 ref、`targetRef`/`url` 为 `null`），但**未被本门禁直接覆盖**。
4. **推送目标窗口身份未验**：用例证明当前会话不一致时 0 推送，但没有证明 `sendSideEffect` 的投递对象与 `getApprovalRequest` 是**同一个窗口**；`isTrusted` 在用例里固定 `true`。
5. **`registry.get` 返回 `null` 的新行为无专门用例**：`executeInProcess` 现在对"contract 解析不到"的 call 一律拒绝（fail closed）。正常流程下 call 由 `proposeWrite` 经 Registry 解析后建立，contract 不会缺失；若运行期工具被摘除，旧代码会继续在进程内执行、新代码拒绝 —— 这是**有意的 fail-closed 收紧**，未写专门用例。
6. **in-process class 的固有差异仍在**：仍**没有**独立 executor 进程的寿命证据（child exit / socket lifetime），已在 `electron/side-effect-runtime.cjs:12-21` 头注释如实披露，**并未**写成"等价"。
7. **CanvasControl in-process 行为覆盖归属（已按独立验收更正，发现 F-1）**：`tests/d5-02-canvas-tool.test.mjs` **只覆盖 CanvasControl adapter 层**，`tests/d5-01-browser-inprocess-boundary.test.mjs` **只覆盖 BrowserControl** —— 二者都**不覆盖** `CanvasControl` 的 in-process 路径（删掉 `CanvasControl` 后实测**无变化**）。真实行为覆盖 = **`tests/d5-02-canvas-edit-proposal.test.mjs`**（经 `executeApproved` 走 in-process；破坏后 `4/3/1` 红，`EXECUTOR_FAILED`），本批该文件在 D5-02 回归（`21-…`）中为绿。C4 门禁内未重搭浏览器 / 画布 fixture（避免与 D5-01/D5-02 重复装配）。
8. **N4 的"未准许字段"只做了键集合 + 具体敏感标记**：没有对全部 `SAFE_SNAPSHOT_SECRET_RE` 键名做穷举注入式验证。
9. **D5-03 整体仍 PARTIAL**。

### 6.3 环境登记（如实，非产品缺陷）

| # | 事项 | 处置 | 影响 |
| --- | --- | --- | --- |
| E-1 | `node_modules/electron/dist/` 缺 `Electron.app`（只剩 LICENSE / LICENSES.chromium.html / version，20M）→ 任何 `require("electron")` 触发 `node_modules/electron/index.js` 的自动下载器 `install.js`；到 GitHub CDN 实测约 **12 KB/s**（30s 采样 393216B），110MB 需 ~2.5h → `tests/d5-01-browser-policy.test.mjs` 表现为**挂住**；`npm test` 里同类文件会因此失败 | 从本机 `~/Library/Caches/electron/eb6378133b7d1c087d37a87eca1d3e04f404c9384955d1af8703278bdde7a7b4/electron-v44.3.0-darwin-arm64.zip` 用 `ditto -x -k` 解到 `dist/`。该 zip sha256 = `49b91ef265c603c8888500f807484b63816069c30f87ba2b403e7c87f0f45035`，与 `node_modules/electron/checksums.json` 中 `electron-v44.3.0-darwin-arm64.zip` 的期望值**逐字节相符**；`unzip -t` 无错。另清掉 2 个永远跑不完的残留 `install.js` 下载进程 | `node_modules/` 被 `.gitignore:1` 忽略，`git status` 不受影响；修复后 `require("electron")` 返回真实路径、`dist/version` = 44.3.0、`dist` 307M |
| E-2 | 本会话 shell 继承 `ELECTRON_RUN_AS_NODE=1`（来自 DSH 运行时，非仓库配置）→ `electron .` 退化成纯 Node（同一二进制实测：带变量报 `v24.20.0`，`env -u` 后报 `v44.3.0`） | 真机 Electron 链一律 `env -u ELECTRON_RUN_AS_NODE` 运行。这**不是**放宽：`experiments/d5-01/browser-control-e2e.mjs:104` 与 `experiments/d5-02/canvas-e2e.mjs:87` 都是 `env: { ...process.env }` **不剥离**，基线是在**没有**该变量的普通 shell 里跑的（本批实测 `test:d5-01-control` 基线 46 PASS 依赖真实 GUI，故基线时该变量必然不在） | **未**改任何产品代码或 `experiments/` 脚本去防御该变量（超出本批范围） |
| E-3 | 取证期间本工作树存在**并发活动**（上级的诊断探针 `node --test tests/d5-01-browser-policy.test.mjs`，DSH 父进程发起），导致本批 `20-d5-01-regression.txt` 第 1 次运行被 **SIGKILL（exit 137）** 打断、证据作废 | 与上级确认真机测试冻结后**重跑**（第 2 次 37/37 通过），两个文件都在留痕（第 1 次输出保留在 `20-…` 内并注明"被 SIGKILL 打断"） | 第 1 次不作证据；第 2 次为有效证据 |

### 6.4 独立对抗性验收（第三方独立复现）

本批另有一名**独立对抗性验收岗**（与执行方 E1/E2/本取证岗无关联、全新上下文）对被测 commit `312dc60` 做了独立复现，报告在 **`experiments/d5-03/batch13/verify/BATCH13-VERIFY-REPORT.md`**（其原始输出 `verify/V-*.txt`）。其结论与本报告一致：**未发现本报告任何不成立或夸大的声明**。

**它独立复现的计数**（不采信本报告的 txt）：

| 项 | 独立实测 | 原始文件 |
| --- | --- | --- |
| 门禁 ① `side-effect-c4-gates` | **19/19、fail 0、exit 0** | `V-10-c4-gates.txt` |
| 门禁 ② `d4-03-approval-push-isolation` | **12/12、fail 0、exit 0** | `V-11-push-gate.txt` |
| `d5-01-browser-inprocess-boundary` | 6/6 | `V-20-…` |
| `d5-02-canvas-tool` | 4/4 | `V-21-…` |
| `npm test` | **1412 / 1412 / 0、exit 0**（121321ms） | `V-40-npm-test.txt` |
| 修前红（在**父提交 `48a867c`** 的真实代码上） | c4-gates **18/19/1**（失败者 `No Direct Domain Bypass`）、push-gate **7/8/1**（失败者 `P2`） | `V-F1-…`、`V-F2-…` |

它还**独立重建**了红 / 绿：用 git 对象取父提交的两个产品文件覆盖工作树，跑本批 commit 内固定的探针，得到与本报告逐项一致的红（`ok=true` / `TRASHED` / `deleteCalls 0→1` / `lease 0→1` / 审计 `6→12` / `RED_BYPASS_PROVEN`）与绿（`ok=false` / `SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED` / `0` mutation / `lease 0` / 审计 `6→7` / `GREEN_GUARD_HELD`）。

**它的负向自证用了三组与本批完全不同的破坏方式，全部按预期变红**：

| 组 | 手法 | 实测 |
| --- | --- | --- |
| V-A | **整段删掉** `executeInProcess` 守卫（8 行） | 19/18/**1**，失败者 `No Direct Domain Bypass` |
| V-B | 判据一字不改，**只把守卫移到 `acquireLease` 之后** | 19/18/**1**，恰好红在 `tests/side-effect-c4-gates.test.mjs:524` 的 `lease 1 !== 0` → **证明门禁 (b) 的位置断言不是空断言** |
| V-C | 给投影加**不同类型**字段 `actorUserId`（不匹配 `SAFE_SNAPSHOT_SECRET_RE`） | 12 中 8 pass / **4 fail**，失败者 `P2 / N1 / N2 / N4` |

**它对"真机 D5-01 与本批无因果"的独立裁定 = 成立**（三次 `S0a` 失败串逐字相同；父提交与 `312dc60` 第 2 次的 check 序列与中止点逐条一致；本批不含 `src/**` 且三次构建主包哈希相同）。同时它明确**不同意**把"S0a 起于 `f9564b7` 之后的设置界面漂移"当作**已定位**结论 —— 本报告与 `docs/D5-03-GATE-EVIDENCE.json` 已据此**降级为"未取得证据"**（见 §6.1）。

**它登记的三条 Low 发现（本报告如实并入，未隐去）**：

- **F-1 · 覆盖归属更正（发现，非产品缺陷）**：它用"删掉 `CanvasControl`"做**正对照**，实测 `d5-02-canvas-tool`(4/4) 与 `d5-01-browser-inprocess-boundary`(6/6) **毫无变化** → 据此发现本报告此前把 CanvasControl in-process 的行为覆盖归到了这两个文件上（**归属写错**）；真实覆盖点是 `tests/d5-02-canvas-edit-proposal.test.mjs`（破坏后 4/3/1 红）。已在本报告 §3.4、§5、§6.2 第 7 条与 JSON 的 `notVerified` / `leftovers` 更正。**这不影响白名单是"活代码"的结论 —— 恰恰证明它是活的，且现在有了正确的覆盖点。**
- **F-2 · 证据等级**：`verify/32-…` 证明"跑在 `48a867c` 上"的**显式**依据是撰写的前置注释行，**运行期原始旁证**是中止栈里的真实路径 `file:///private/tmp/oa-b013-base/…`（而 `30-…` / `33-…` 是 `file:///Users/wepingli/Desktop/OpenArc%20OS-integration/…`）。它裁定该证据**可信**，仅建议真机类证据的前置事实（如 `rev-parse`）今后直接放进 raw 捕获块。已登记进 `leftovers`。
- **F-3 · 探针判据口径**：`red/inprocess-bypass.mjs:110` 的 `guardHeld` 用 `activeLeaseCount`（只数 ACTIVE），而门禁 `tests/side-effect-c4-gates.test.mjs:524` 用 `leasesOfCall().length`（全部 lease）→ **探针口径略宽于门禁**。处置：**探针是探索性工具、门禁判据更严，不改探针**（红/绿结论不受影响；探针同时输出 `after.leaseCount = 0`）。已登记进 `leftovers`。

**它未复跑的重回归项**（D5-01 37/37、D5-02 48/48、side-effect + D4-03 278/278、文档口径 60/60、真机 D5-02 画布 52/52）由 `npm test` 1412/1412 与两项抽查间接覆盖 —— 这一点已在其报告 §9「仍未验证」中如实列出。

## 7. 判定

- **本批「两条 D4 门禁收口 + 真实执行边界复核」= PASS（限定范围）**：
  - 门禁 ① `side-effect-c4-gates` **19/19 PASS、fail 0、exit 0**（旧：18/19、1 fail）；真实产品缺陷（`executeInProcess` 白名单绕过，实测 `ResourceService.delete` 在 main 进程真实落地）已**红→绿**修复。
  - 门禁 ② `d4-03-approval-push-isolation` **12/12 PASS、fail 0、exit 0**（旧：7/8、1 fail）；断言按现行封闭契约更新，**判据未降低**（精确键集合比较由 1 处扩到 7 处、字段集合仍是 15 项封闭集合、并补值级正反例）。
  - **负向自证三组全部按要求变红**（A 静态 16/3、A 行为 `RED_BYPASS_PROVEN` 真实 mutation、B 8/4 且失败者恰为 P2/N1/N2/N4），且两次临时改动均**逐字还原**（sha256 与提交内置版本一致、`git diff --exit-code` = 0）。
  - **完整 `npm test` = 1412 tests / 1412 pass / 0 fail / exit 0**（第十二批 1408/1406/2 → 本批 1412/1412/0），第十二批登记的两条既有确定性失败已清零。
  - 回归全绿：D5-01 37/37、D5-02 48/48、side-effect + D4-03 278/278、文档口径 D5-01 合并集 60/60。
  - **真机 D5-02 画布 52 PASS / 0 FAIL / exit 0**（与基线一致）。
  - **真机 D5-01 受控浏览器链本批未取得**（`S0a` 既有失败，父提交上逐字相同）→ 已在 §6.1 登记为**未取得项 + 剩余缺口**，**未**当作产品回归，**未**用真机画布替代。
- **D5-03 整体 = PARTIAL**（理由：真实执行边界已按提供者收口并取得真机画布证据，但真机受控浏览器产品链门禁因设置界面漂移（**其回归时点未定位**）而不可达，浏览器导航的**真机 UI** 证据在本批缺位；`url` 2000 / `targetRef` 300 上界、`canvas.edit` 推送、推送目标窗口身份、in-process child 寿命证据等缺口仍在）。
