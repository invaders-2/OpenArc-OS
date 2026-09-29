# D5-03 第十三批 · E1 报告：收口 C4 门禁 `No Direct Domain Bypass`

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`，基线 `48a867c`）
- 本轮改动文件（E1 独占）：`electron/side-effect-domain.cjs`、`electron/side-effect-runtime.cjs`、`tests/side-effect-c4-gates.test.mjs`、`experiments/d5-03/batch13/red/**`
- 未 push / 未 merge / 未 commit。

---

## 0. 结论一句话

门禁 `No Direct Domain Bypass` 原先唯一失败的断言（`主进程绝不 in-process 执行 write`）**确实是过时表述**，但它掩盖了一个**真实产品缺陷**：公开方法 `executeInProcess` 自身没有 execution placement 守卫。已先留红证明绕过成立，再在产品侧补 fail-closed 守卫，重写门禁为「按提供者分层 + 行为级拒绝证明」，19/19 全过，且门禁仍可为红（已自证）。

---

## 1. 旧句 → 新句 → 契约依据

| # | 位置 | 旧 | 新 | 契约依据 |
|---|---|---|---|---|
| 1 | `tests/side-effect-c4-gates.test.mjs` 旧 :474 | `assert.ok(!/authority\.executeSideEffect\(/.test(runtime), "主进程绝不 in-process 执行 write")` | **删除**；由新增 (a) 受监督行为断言 + (b) 行为级拒绝断言 + (d) 源码级裁决顺序断言共同替代 | `electron/side-effect-runtime.cjs:49`（静态白名单）、`:274-284`（新增守卫）；D5-01 Closure-2 / D5-02 已验收的显式 in-process execution class |
| 2 | 同文件旧 :471 注释 | `// 生产 runtime 只经受监督 executor 执行，绝不在主进程 in-process 执行 write。` | `// (a) 默认路径：只有受监督 executor 允许做 out-of-process mutation。` | 同上：不再作绝对论断，改为「默认路径」表述 |
| 3 | 同文件 :474（保留、未降低） | `assert.ok(/supervisor\.spawnExecutor\(/.test(runtime), "production write 必须经 supervisor.spawnExecutor")` | **保留，原文不动** | `electron/side-effect-runtime.cjs:337` |
| 4 | 同文件（新增 (a)） | 无 | 行为：`resource.trash` 走 propose→APPROVE→`executeApproved` 后 `res.ok===true`、真实 `trashed===true`、lease 恰好 1、`verificationStatus==="PASS"`、主进程 `resourceService.delete` 调用数不变 | `electron/side-effect-runtime.cjs:318-337`（受监督路径）；SideEffectAuthority `PASS` 判定 |
| 5 | 同文件（新增 (b)，核心） | 无 | 行为：直接调 `executeInProcess({callId})` 对 `resource.trash`（provider=`ResourceService`）→ `ok===false`、`error==="SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED"`、`inProcess===false`、Domain 0 mutation、**lease 总数为 0**（不是只断 ACTIVE：守卫在 `acquireLease` 之前 return）、call 仍 `APPROVED`、恰好 1 条 `side_effect.execution_placement`/`DENY`、随后同一 call 经 `executeApproved` 仍成功 | `electron/side-effect-runtime.cjs:277-284`（守卫在 `:286` preflight 与 `:294` acquireLease **之前**）；`electron/side-effect-domain.cjs:120` |
| 6 | 同文件（新增 (c)） | 无 | 静态解析：`IN_PROCESS_EXECUTION_PROVIDERS = Object.freeze(new Set([...]))` 字面量；成员恰好 `["BrowserControl","CanvasControl"]`；全文只有 1 处赋值、只有 2 处只读 `.has(`；无 `.add/.delete/.clear`、无 `Object.assign/defineProperty`；成员只允许字符串字面量 | `electron/side-effect-runtime.cjs:49` |
| 7 | 同文件（新增 (d)） | 无 | 源码级：`executeInProcess` 方法体内 `preflightAuthorization` → `acquireLease` → `executeSideEffect` 的**顺序**成立，且含 `side_effect.execution_placement`/`IN_PROCESS` 审计 | `electron/side-effect-runtime.cjs:286`、`:294`、`:300`、`:293` |
| 8 | `electron/side-effect-runtime.cjs:12-17` 头注释 | 「真实 mutation 只发生在 RuntimeSupervisor 拥有并监督的 executor runtime 里，主进程绝不直接执行 write」 | 「受监督 executor 是**默认**路径；唯一例外是 Domain 权威只存在于 main 进程内的 provider（BrowserControl / CanvasControl）走显式白名单 in-process class；**明确声明不是等价路径**（放弃 child 寿命证据），preflight/approval/lease/claim/exactly-once/verify/audit 仍由同一 authority 裁决；白名单为静态字面量，不从 arguments/plan 解析」 | D5-01 Closure-2（`WebContentsView` 只在 main）、D5-02（CanvasService + 同一 SQLite 连接在 main，禁止第二写者） |
| 9 | `electron/side-effect-domain.cjs` | 无此错误码 | 新增 `IN_PROCESS_NOT_PERMITTED: "SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED"`（execution placement 守卫，含「为什么」注释） | 本批新增契约 |

**未改动的既有断言（判据一条未降）**：`forbidden` 9 个文件扫描（`resourceService.delete` / `ResourceService.` 均不得出现）、`tool-adapters.cjs` 中 `resourceService.delete(` 恰好 1 处、`side-effect-authority.cjs` 必须经 `adapter.execute(`、`controlled-tool-proxy.cjs` 必须 `riskClass !== "READ_ONLY"` 且经 `adapter.execute(` —— 全部逐字保留。

---

## 2. 旧断言为何失效（明确披露，且判据没有被降低）

**失效原因**：不是产品放松了判据，而是「主进程绝不执行**任何** write」这个**绝对论断**被 D5-01 Closure-2 / D5-02 的**显式 in-process execution class** 取代：

- 受控浏览器的 Domain 是 main 进程里的原生 `WebContentsView`（`electron/side-effect-runtime.cjs:33-45` 注释、`:259-273`）——child 里结构上不存在，也不该再造一份视图权威；
- 画布命令层的权威实例（`CanvasService` + 同一个 SQLite 连接）也在 main 进程，D5-02 明确禁止建第二套画布/第二个写者。

因此该 in-process class 是**已验收契约**，旧断言的绝对措辞已与产品自相矛盾。

**但判据没有被降低，反而更严**：

1. 提供者集合仍是**封闭**的：白名单是静态字面量 `Object.freeze(new Set(["BrowserControl","CanvasControl"]))`，门禁精确解析并断言**恰好两个成员**、单一声明、无运行时扩充/改写、成员不得从参数读入 —— 旧的「不出现 `authority.executeSideEffect(`」只是**文本存在性**判据，连"白名单有几个成员"都管不到；
2. **新增行为级拒绝证明**：不只看源码，而是真造一条 `resource.trash` call，直接调 `executeInProcess`，断言被拒 + 0 mutation + **lease 总数 0**（守卫在 `acquireLease` 之前 return）+ call 未被 BLOCKED + 1 条 DENY 审计 + **该 call 随后仍能经受监督路径成功执行**（防止把误路由变成 DoS）；
3. **新增行为级正路径证明**：`resource.trash` 经受监督路径必须真的把资源移入 Trash、恰好 1 lease、`verification PASS`；
4. **新增 in-process 路径完整性断言**：preflight → lease → execute 的**顺序**与 `IN_PROCESS` placement 审计。

结论：判据从「主进程不写」这一**不可验证的绝对命题**，换成「按 executionProvider 分层 + 行为级拒绝 + 封闭白名单」——**没有改成"不做限制"**。

---

## 3. 红证据（来自未修改代码）

前置确认：`experiments/d5-03/batch13/red/00-pre-diff-confirm.txt`（`git diff --stat -- electron/` 与 `-- tests/` 均为空，HEAD `48a867c`，仅 `?? experiments/d5-03/batch13/`）。

探针：`experiments/d5-03/batch13/red/inprocess-bypass.mjs`（直接调公开方法 `executeInProcess`，不经 `executeApproved`）。

原始输出：`00-red-inprocess-bypass.txt`；结构化：`00-red-summary.json`。

| 字段 | 调用前 | 调用后 | 说明 |
|---|---|---|---|
| `res.ok` | — | `true` | 绕过成立 |
| `res.error` | — | `null` | 无任何拒绝 |
| `res.inProcess` | — | `true` | — |
| `call.status` | `APPROVED` | `SUCCEEDED` | 真实执行成功 |
| `library_resources.trash_state`（真实 Domain 落地） | `ACTIVE` | `TRASHED` | **真实 mutation** |
| `library_resources.deleted_at` | `null` | `1700000000000` | **真实 mutation** |
| `resource_registry.status` | `active` | `deleted` | **真实 mutation** |
| `sideEffectPrecondition().trashed` | `false` | `true` | — |
| 主进程 `resourceService.delete` 调用数 | `0` | `1` | 在 main 进程真执行了 Domain write |
| lease 行数 | `0` | `1` | 绕过了白名单却仍建租约 |
| `authorization_audit` 行数（`side_effect.%`） | `6` | `12` | — |
| placement 审计 | — | `IN_PROCESS` / `PROCESS_LOCAL_DOMAIN` | 自认在进程内执行 |

`verdict: RED_BYPASS_PROVEN`（`ok === true` 且资源真实 mutation）。

---

## 4. 绿证据（修改后，同一探针）

原始输出：`01-green-inprocess-bypass.txt`；结构化：`01-green-summary.json`。

| 判据 | 要求 | 实测 |
|---|---|---|
| `res.ok` | `false` | `false` |
| `res.error` | `SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED` | `SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED` |
| `res.inProcess` | `false` | `false` |
| Domain mutation | 0（前后完全一致） | `ACTIVE`/`null`/`active` → `ACTIVE`/`null`/`active`，`trashed` `false`→`false` |
| `resourceService.delete` 调用数 | 0 | `0` |
| lease 行数 | 0 | `0`（门禁断的是**总数**） |
| ACTIVE lease | 0 | `0` |
| `call.status` | 仍 `APPROVED`（不是 `BLOCKED`） | `APPROVED` |
| `side_effect.execution_placement` 审计 | 恰好 1 条 | 恰好 1 条：`DENY` / `IN_PROCESS_NOT_PERMITTED` |
| 审计总行数 | +1 | `6` → `7` |

`verdict: GREEN_GUARD_HELD`。

### 4.1 为什么该时点「恰好 1 条 placement 审计」是可以断言的

`side_effect.execution_placement` 在整个产品里**只有两处写入点**，都在 `executeInProcess` 内（`grep -rn "execution_placement" electron/` 全仓仅两条）：

- `electron/side-effect-runtime.cjs:282` → `DENY` / `IN_PROCESS_NOT_PERMITTED`（本次命中）
- `electron/side-effect-runtime.cjs:293` → `IN_PROCESS` / `PROCESS_LOCAL_DOMAIN`

各阶段**都不写**这条审计：

| 阶段 | 实际写入的审计 action | 是否含 placement |
|---|---|---|
| 提案 `proposeWrite`（runtime `:103,:125,:126`） | `side_effect.proposed` / `side_effect.plan_ready` / `side_effect.waiting_approval` | 否 |
| 授权 `authority.planSideEffect` | `side_effect.planned` | 否 |
| 批准 `decideApproval` → `authority` | `side_effect.approval_requested` / `side_effect.approved` | 否 |
| 受监督执行 `executeApproved` → `spawnExecutor` | `side_effect.lease_acquired` / `side_effect.execution_started` / … | 否（`supervisor.spawnExecutor` 路径从不经过 `:293`） |

断言取数时点 = 守卫拒绝之后、`executeApproved` 之前，因此 placement 行**只可能**是本次守卫写的 1 条 `DENY`；实测 `placement.length === 1`、`decision === "DENY"`、`reason_code === "IN_PROCESS_NOT_PERMITTED"`。

---

## 5. 每条命令 + 真实计数

| 命令 | tests | pass | fail |
|---|---|---|---|
| `node --test tests/side-effect-c4-gates.test.mjs`（**改动前基线**） | 19 | 18 | **1**（旧断言） |
| `node --test tests/side-effect-c4-gates.test.mjs`（**改动后**，`03-green-c4-gates.txt`） | 19 | **19** | **0** |
| `node --test tests/side-effect-c4-gates.test.mjs`（**上级审查收紧 lease 总数为 0 后重跑**，覆盖写回 `03-green-c4-gates.txt`） | 19 | **19** | **0** |
| `node experiments/d5-03/batch13/red/inprocess-bypass.mjs <summary>`（红，未修改代码） | — | — | — （见 §3） |
| `node experiments/d5-03/batch13/red/inprocess-bypass.mjs <summary>`（绿，修改后） | — | — | — （见 §4） |
| `node --test tests/d5-01-browser-inprocess-boundary.test.mjs`（B1–B6 合法调用方） | 6 | 6 | 0 |
| `node --test tests/d5-01-browser-control-chain.test.mjs` | 5 | 5 | 0 |
| `node --test tests/d5-01-browser-control-surface.test.mjs` | 2 | 2 | 0 |
| `node --test tests/d5-02-canvas-tool.test.mjs`（追加：CanvasControl 合法 in-process 路径） | 4 | 4 | 0 |
| `node --test tests/side-effect-*.test.mjs tests/d4-03-*.test.mjs`（追加：全量回归） | 278 | 278 | 0 |

以上 6 组输出均在 `02-legit-inprocess-regression.txt`（合法路径）、`03-green-c4-gates.txt`（门禁）。

### 5.1 门禁仍可为红（负向自证，已自查）

1. `04-negative-selfproof-whitelist-widened.txt`：临时把 `"ResourceService"` 加进白名单 → 门禁 `not ok`，失败断言 `in-process 白名单必须恰好等于 BrowserControl + CanvasControl`，`# pass 0 / # fail 1`。
2. `05-negative-selfproof-behavior.txt`：同样放宽白名单后跑同一探针 → `res.ok: true`、`trash_state: TRASHED`、`deleteCalls: 1`、`verdict: RED_BYPASS_PROVEN` —— 证明门禁 (b) 的**行为判据本身**会因白名单放宽而失效，而不只是静态正则先红。

两次负向自证后均已从备份逐字还原，`md5 -q electron/side-effect-runtime.cjs` 回到 `c89ea371f39b9ed642aefa5c06520117`（与生成 `03-green-c4-gates.txt` 的内容一致）。

### 5.2 已知脆弱点（维护约束登记，**有意的封闭集合约束，不是误报**）

以下断言是**计数型/文本定位型**维护约束。它们变红时，**先判断是「产品合法演进」还是「判据被突破」**，不要一律当成门禁坏了：

| 断言 | 当前值 / 定位依赖 | 变红的正当原因与处置 |
|---|---|---|
| `(runtime.match(/IN_PROCESS_EXECUTION_PROVIDERS\s*=/g) \|\| []).length === 1` | 唯一静态声明在 `electron/side-effect-runtime.cjs:49` | 只允许一处声明本身是契约；若出现第二处赋值点，说明白名单被运行时改写，门禁**必须**红，**不得**放宽 |
| `(runtime.match(/IN_PROCESS_EXECUTION_PROVIDERS\.has\(/g) \|\| []).length === 2` | 守卫 `:281` + 分流 `:322`，当前恰好 2 | 合法新增第三处只读 `.has(`（例如再增设一条执行路径的 placement 判定）也会红；此时应**同步把计数改为 3、在报告中登记新增调用点**，属门禁维护，不是产品缺陷 |
| `(d)` 用 `runtime.indexOf("async executeInProcess(")` 与相邻注释 `/** 受监督 executor runtime 执行一条已 APPROVED 的 call */` 定位方法体 | 方法在 `:274`，结束标记注释在 `:317` | 改写该注释文本会让方法体切不出/切错，`assert.ok(inProcessBody.length > 0)` 先红；改注释时需同步更新门禁定位串，属**源码定位脆弱** |
| `assert.match(whitelistDecl[1], /^\s*"[^"]+"(\s*,\s*"[^"]+"\s*)*$/)` | 成员只能写成字符串字面量 | 若白名单改从常量数组/配置读入（即便取值不变）也会红 —— 这正是「不从 arguments/plan 动态解析」的判据，**必须**保持字面量 |

以上四项均为**故意收紧**：把「白名单封闭 + in-process 路径完整」从文本存在性提升为可数、可定位的约束。任何放宽都需显式改门禁并在报告留痕。

---

## 6. 剩余缺口与未验证项

1. **(d) 为源码级补充**：`preflight → lease → execute → placement 审计` 的顺序与存在性由源码断言保证；其**行为**证据由 D5-01 `tests/d5-01-browser-inprocess-boundary.test.mjs` B1–B6（本轮 6/6 通过）承担 —— 那是 in-process class 唯一的合法调用方。未在 C4 门禁里重搭浏览器 fixture（避免与 D5-01 重复装配 100+ 行 fakeController）。
2. **CanvasControl 的行为面未全扫**：本轮只跑了 `tests/d5-02-canvas-tool.test.mjs`（4/4）；D5-02 其余画布用例不在本批范围，未执行。
3. **未跑全仓测试**：仅跑 side-effect / D4-03 全量（278/278）与上述定向用例；全仓测试套件未执行。
4. **`registry.get` 返回 null 时的新行为**：`executeInProcess` 现在对「contract 解析不到」的 call 一律拒绝（fail closed）。正常流程下 call 由 `proposeWrite` 经 Registry 解析后建立，contract 不会缺失；若运行期工具被摘除，旧代码会继续在进程内执行、新代码拒绝 —— 这是有意的 fail-closed 收紧，未在本批写专门用例。
5. **in-process class 的固有差异仍在**：仍没有独立 executor 进程的寿命证据（child exit / socket lifetime），已在 `electron/side-effect-runtime.cjs:12-21` 头注释如实披露，并未写成「等价」。
6. **并发写入者**：本轮进行期间，同工作树有 **E2 兄弟岗位**在改 `tests/d4-03-approval-push-isolation.test.mjs`（`git diff` 显示 +256 行）并生成 `experiments/d5-03/batch13/E2-REPORT.md`。该文件不属于 E1 独占范围，E1 未读改该文件；其内容出现在 `git status` 中属并发产物。
7. **上级审查已并入的两处**：(i) (b) 的 lease 判据由「0 ACTIVE」收紧为「**lease 总数 0**」（守卫在 `acquireLease` 之前 return，故总数也必须为 0）；(ii) 计数型/文本定位型断言已在 §5.2 登记为有意维护约束。

---

## 7. 收口时的仓库状态

```
$ git status --porcelain
 M electron/side-effect-domain.cjs
 M electron/side-effect-runtime.cjs
 M tests/d4-03-approval-push-isolation.test.mjs   ← E2 兄弟岗位的并发改动，非 E1
 M tests/side-effect-c4-gates.test.mjs
?? experiments/d5-03/batch13/

$ git diff --stat
 electron/side-effect-domain.cjs              |   4 +
 electron/side-effect-runtime.cjs             |  16 +-
 tests/d4-03-approval-push-isolation.test.mjs | 256 ++++++++++++++++++++++++++-
 tests/side-effect-c4-gates.test.mjs          |  79 ++++++++-
 4 files changed, 348 insertions(+), 7 deletions(-)
```

E1 自身净改动：`electron/side-effect-domain.cjs` +4、`electron/side-effect-runtime.cjs` +16/-5、`tests/side-effect-c4-gates.test.mjs` +79/-2（含 1 行新增 require）。未 push、未 merge、未 commit。
