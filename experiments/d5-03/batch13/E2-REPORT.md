# D5-03 第十三批 · 审批**推送**隔离门禁（E2 报告）

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`，基线 `48a867c`）
- 唯一改动文件：`tests/d4-03-approval-push-isolation.test.mjs`
- 未改动任何产品代码；未 commit / push / merge / rebase。

## 1. 旧断言为何失效（如实披露）

`tests/d4-03-approval-push-isolation.test.mjs` 的 `SNAPSHOT_FIELDS` 并不是测试自己发明的期望，
它是**产品自己的封闭白名单**的副本：`electron/side-effect-runtime.cjs:190` 的 `allowed` 集合 +
`:200-202` 的 `snap` 构造，是审批投影唯一的数据来源。D5-01 Closure-2 为**受控浏览器导航审批**
把 `targetRef`（被批准的目标标签身份）与 `url`（**用户正在批准的那个地址**）纳入**用户必须看到**
的信息（`electron/side-effect-runtime.cjs:198-202` 的注释写明"批准的就是这个地址：它是用户要看的，
不是 secret；正文仍然永不出现在这里"；UI 侧确实渲染：`src/approval/ApprovalPrompt.tsx:186`
`data-approval-target`、`:190` `data-approval-url`）。

旧测试的期望集合没跟上这次契约扩展 —— 这属于**断言过时**，不是泄露。依据有三条：

1. 集合仍然是封闭的：投影逐字段从 `allowed` 取，`for (const key of Object.keys(snap)) if (!allowed.has(key)) delete snap[key]`（`electron/side-effect-runtime.cjs:209`）+ 敏感键名过滤 `:210`；Harness 无法注入任意字段。
2. 新增字段是被批准对象的**用户可见信息**，不是凭据/正文/路径：见 §1 表格的依据列。
3. 判据没有被降低：`SNAPSHOT_FIELDS` 仍是精确集合比较（`assert.deepEqual(Object.keys(...).sort(), SNAPSHOT_FIELDS)`），**没有**改成 `assert.ok(keys.length > 0)` / 子集断言 / 通配；并且本轮为两个新字段补了**值级**断言（N1 必须为 `null`、N2 必须精确等于被提案的地址/目标）。

## 2. 旧句 → 新句 → 契约依据（逐条）

| # | 旧句 | 新句 | 契约依据 |
|---|---|---|---|
| 1 | `SNAPSHOT_FIELDS` 不含 `targetRef` / `url`（13 项） | `SNAPSHOT_FIELDS` 加入 `targetRef`、`url`（15 项） | `electron/side-effect-runtime.cjs:190`（allowed 集合）、`:200`（`targetRef` = `pre.targetRef` slice 300）、`:202`（`url` = `pre.url` slice 2000）；`src/approval/ApprovalPrompt.tsx:186`、`:190` |
| 2 | P2 仅断言 `Object.keys(event.request).sort()` 深等于白名单 | 抽出 `assertExactSnapshotKeys()`，同样做深等于白名单，改由 P2 / N1 / N2 / N4 共 6 处调用 | 同一封闭白名单；把"精确集合"从 1 处扩到 6 处，判据只增不减 |
| 3 | 无 | N1：`resource.trash` 推送的 `request.targetRef === null` 且 `request.url === null`；推送文本不含 `浏览器标签`、不含 `http(s)://`；**非空转**断言 `planned.call.preconditionsSafe` 必须存在，且 `request.resourceRef` 等于它、为**非空 string**；`preconditionsSafe` 键集合 = `["expectedVersion","registryStatus","resourceRef"]` | `electron/tool-adapters.cjs` 的 `trashPlan`（`preconditions: { resourceRef, expectedVersion, registryStatus }`，无 `targetRef`/`url`）→ 投影必然为 `null`（`electron/side-effect-runtime.cjs:200-202` 的三元判断） |
| 4 | 无 | N2：`browser.navigate` 推送 1 条，`request.url === 被提案的地址`（精确相等）、`request.targetRef === "browser#t1"`、`targetDisplayName === "浏览器标签 browser#t1"`、推送 = `getApprovalRequest` = `listPending` 三项 `deepEqual`、长地址与带 query/path 的地址原样未截断、页面正文不出现 | `electron/tool-adapters.cjs:191-198`（`plan` 产出 `preconditions: { targetRef: viewId, targetType: "browser-tab", url }`）；`electron/side-effect-runtime.cjs:180-202`；`src/approval/ApprovalPrompt.tsx:186`、`:190`；`experiments/d5-01/browser-control-e2e.mjs` S2.1/S2.2/S2.7 |
| 5 | 无 | N3：把 P1/P4/P6 的 0 投影语义扩展到 `browser.navigate`（B 会话 0 推送 + `listPending` 空 + `getApprovalRequest` 返回 `SIDE_EFFECT_CALL_NOT_FOUND`；未登录 0 推送 + call 仍 `AWAITING_APPROVAL` + `approvalSnapshot({context:{}})` / `{context:{sessionRef:null}}` / `{context:{sessionRef:B}}` 均 `null`） | `electron/side-effect-runtime.cjs:174-179`（声明 context 必须有真实 session 且等于 task 的 `session_ref`）、`electron/identity-bootstrap.cjs:295-299`（推送按当前 authenticated session 重新投影） |
| 6 | 无 | N4：两个场景推送文本不含绝对路径（`/Users/`、`/private/`、`/var/folders`）、不含 store root、不含 `slease_` / `tappr_`；两场景各做一次精确键集合比较；含 `user:pass@host` 的地址在**提案阶段**被拒（`ok === false`、`error === "TOOL_ARGUMENT_INVALID"`）且 0 推送 / 0 新 call / 凭据不进投影 | `electron/tool-registry.cjs:180`（`browser.navigate` inputSchema `pattern: "^https?://[^\\s@]+$"`，工具门排除 `@`）；`electron/tool-registry.cjs:46`、`:44`（schema 校验）；`electron/side-effect-runtime.cjs:209-210`（白名单 + 敏感键名过滤）；`tests/side-effect-c4-gates.test.mjs:488`（内部 authority id 判据同款写法） |

**没有一条既有断言被削弱**：P1、P3、P4、P5、P6、P7、P8 语句**逐字未改**；P2 只改了字段集合这一处
（第 1、2 行），其余断言（推送条数、推送 = 读取、`listPending` 可发现、不含 store root / 绝对路径）
原样保留。

## 3. 新增用例清单（N1–N4）

- **N1（反例 · 资源回收审批不携带浏览器目标）**：`deepEqual` 精确键集合；`targetRef`/`url` 必须为
  `null`；推送文本无 `浏览器标签`、无 `http(s)://`；**非空转**断言：先 `assert.ok(planned.call && planned.call.preconditionsSafe)`，
  再 `assert.equal(event.request.resourceRef, planned.call.preconditionsSafe.resourceRef)` 并断言它是
  **非空 string**；底层 `preconditionsSafe` 键集合精确等于
  `["expectedVersion","registryStatus","resourceRef"]`（证明是"计划里本来就没有"，不是"投影层删掉"）。
- **N2（正例 · 浏览器导航：推送 / 读取 / 列表三处同一个待批准地址）**：假控制器 + `BrowserControlAuthority`
  + 真实 `SideEffectRuntime.proposeWrite`（真实工具门 + 真实 plan + 真实落库），只取"提案 → 审批快照/推送"
  一段；断言 1 条推送、`url` 精确相等、`targetRef` = 目标 viewId、`targetDisplayName` 为稳定标签身份、
  三处 `deepEqual`、长地址（实测 1533 字符，见 §4.2）与带 query/path/fragment 的地址原样、正文标记
  `OPENARC-PAGE-BODY-MARKER-D4-03` 不出现在推送/读取里、审批阶段 0 真实导航。
- **N3（反例 · 非所属会话 / 未登录窗口仍为 0 投影，覆盖浏览器场景）**：见 §2 第 5 行。
- **N4（反例 · 路径 / 凭据 / 其它未准许字段一律不得进入推送）**：见 §2 第 6 行。

## 4. 真实计数与命令

```
$ node --test tests/d4-03-approval-push-isolation.test.mjs
# tests 12
# pass 12
# fail 0
```

- 命令：`node --test tests/d4-03-approval-push-isolation.test.mjs`（未跑整个 `npm test`）
- 绿色证据：`experiments/d5-03/batch13/evidence/10-push-gate-green.txt`（退出码 0，审查后收紧 N1 已重跑覆盖）
- 修复前证据（上级所存，未删）：`experiments/d5-03/batch13/evidence/pre-push-gate.txt`（`tests 8 / pass 7 / fail 1`）

### 4.1 可为红的自我检查（本轮实做）

在 `electron/side-effect-runtime.cjs` 的 `allowed` 集合与 `snap` 里**临时**加入一个白名单外字段
`ownerUserIdProbe`，同一命令结果：`# tests 12 / # pass 8 / # fail 4`，失败者正是
**P2、N1、N2、N4**（四处精确键集合比较）。随后已按字节还原该产品文件
（`shasum` = `0082e4a42888601b025f25db2b5e8a08741d8626`，与改动前备份一致）。结论：上级的负向自证
（在审批投影里故意多加一个敏感字段）会让本轮新增的精确键比较**必然变红**。

### 4.2 审查后收紧 N1（空转结构已消除）与实测数字

审查指出 N1 里的 `planned.call ? planned.call.preconditionsSafe.resourceRef : null` 在
`planned.call === undefined` 时会退化成 `null === null` **静默空转**。已改为：

```js
assert.ok(planned.call && planned.call.preconditionsSafe, "proposeWrite 必须返回带 preconditionsSafe 的 call 行");
assert.equal(event.request.resourceRef, planned.call.preconditionsSafe.resourceRef);
assert.equal(typeof event.request.resourceRef, "string");
assert.ok(event.request.resourceRef.length > 0, "资源回收的 target 必须是真实 resourceRef 字符串，不能是空串");
```

收紧后重跑仍是 `tests 12 / pass 12 / fail 0`（说明这三条断言**真的执行了**，不是被跳过）。

**先跑独立探针实测（不依赖断言本身）**，`proposeWrite({ toolId: "resource.trash" })` 的真实返回：

| 观测项 | 实测值 |
|---|---|
| `Object.keys(planned)` | `["ok","duplicate","call","approvalRequestId"]` |
| `typeof planned.call` | `"object"`（**不是** `undefined`） |
| `planned.call.preconditionsSafe` | `{"resourceRef":"resource://res_AjoAzphJSEKX5VBysbg_JVYzGUwEzYF_","expectedVersion":1,"registryStatus":"active"}` |
| `event.request.resourceRef` 的值 | `"resource://res_AjoAzphJSEKX5VBysbg_JVYzGUwEzYF_"`（= 夹具 `created.resource.resourceRef`） |
| `typeof` / 长度 | `"string"` / **47** |
| 落库行 `callById(approvalRequestId).preconditionsSafe` | 与 `planned.call.preconditionsSafe` **逐字相同**（键集合 `["expectedVersion","registryStatus","resourceRef"]`） |

结论：**旧写法没有一直在空转**（`planned.call` 确实存在、`resourceRef` 是 47 字符的真实字符串），
但该结构确实可能空转，已按上述非空转形式收紧。

**N4 凭据拒绝的真实返回**（`https://u:p@example.com/x`，工具门 `pattern: "^https?://[^\\s@]+$"` + `@` 排除）：

```
{"ok":false,"error":"TOOL_ARGUMENT_INVALID","decisionStatus":"INVALID"}
```

硬编码的 `bad.error === "TOOL_ARGUMENT_INVALID"` 成立；同一探针实测 `callsOfTask(run.taskId)` 在拒绝前
后均为 **1 → 1**（计数未增），与 N4 的 `callsBefore`/`callsAfter` 断言一致。

**N2 长地址实测**：`URL_LONG` 长度 = **1533**（`url` 的工具门 `maxLength` = 2000，
`electron/tool-registry.cjs:180`），落库字节与提案**逐字相同**（`storedUrlLength` = 1533）。
因此 1533 **低于** 2000 上界 —— 这条**没有**覆盖 2000 截断边界，见 §5 缺口第一条。

## 5. 未覆盖项与剩余缺口

- **`url` 的 2000 截断边界未覆盖（如实）**：N2 用的长地址只有 **1533** 字符（低于工具门 `maxLength: 2000`），
  所以它证明的是"未被 300 之类的更小上界截断"，**不是**"2000 处不截断"。要覆盖真正的上界需要：
  ① 2000 字符整（工具门放行、投影必须逐字原样）；② 2001 字符（工具门 `MAX_LENGTH` 拒绝、0 call）。
  两者本轮都**未**产出证据。
- **只覆盖到审批快照/推送**：`browser.navigate` 的真实导航执行、lease/claim、`READ_AFTER_WRITE`
  验证、`UNKNOWN_EFFECT` 收敛不在本用例范围（由 `tests/d5-01-browser-control-chain.test.mjs` 与回归覆盖）。
- **只覆盖两个 provider**：`resource.trash`（Resource 目标）与 `browser.navigate`（浏览器目标）。
  `canvas.edit`（D5-02，同一 `allowed` 白名单，投影里 `resourceRef` 为画布 ref、`targetRef`/`url` 为 `null`）
  本轮未加专门断言 —— 它走同一处投影代码，但**未被本门禁直接覆盖**。
- **值级边界未覆盖**：`targetRef` 的 300 字符上界（`electron/side-effect-runtime.cjs:200`）没有断言；
  `sanitizePreconditions` 对超界走 fail-closed 丢弃（`electron/side-effect-authority.cjs:124-125`），
  这条边界的红/绿证据未在本文件产出。
- **推送通道仍是"按 snapshot 再过滤"**：本用例证明当前会话不一致时 0 推送，但没有证明"推送目标窗口"的
  身份（`sendSideEffect` 的投递对象）与 `getApprovalRequest` 是同一个窗口；`isTrusted` 在用例里是固定 `true`。
- **N4 的"未准许字段"只做了键集合 + 具体敏感标记**：没有对全部 `SAFE_SNAPSHOT_SECRET_RE`
  键名做穷举注入式验证。

## 6. 结束状态

- 第一轮提交：`SNAPSHOT_FIELDS` 更新 + N1–N4（`tests 12 / pass 12 / fail 0`）。
- 第二轮（上级审查后收紧）：N1 去掉可空转的三元表达式，改为非空转断言并补实测数字；
  重跑仍 `tests 12 / pass 12 / fail 0`，证据文件已覆盖写回。
- 本轮只改 `tests/d4-03-approval-push-isolation.test.mjs` 与 `experiments/d5-03/batch13/E2-REPORT.md`。

### 6.1 我的改动

```
$ git diff --stat -- tests/d4-03-approval-push-isolation.test.mjs
 tests/d4-03-approval-push-isolation.test.mjs | 256 ++++++++++++++++++++++++++-
```

### 6.2 `git status --porcelain`（全树，含 E1 的改动）

```
 M electron/side-effect-domain.cjs
 M electron/side-effect-runtime.cjs
 M tests/d4-03-approval-push-isolation.test.mjs
 M tests/side-effect-c4-gates.test.mjs
?? experiments/d5-03/batch13/
```

### 6.3 `git diff --stat`（全树）

```
 electron/side-effect-domain.cjs              |   4 +
 electron/side-effect-runtime.cjs             |  16 +-
 tests/d4-03-approval-push-isolation.test.mjs | 256 ++++++++++++++++++++++++++-
 tests/side-effect-c4-gates.test.mjs          |  79 ++++++++-
 4 files changed, 348 insertions(+), 7 deletions(-)
```

### 6.4 与并发执行岗（E1）改动的关系（已由上级澄清）

**我开工时该工作树是干净的**（`git status --porcelain` 仅 `?? experiments/d5-03/batch13/`，HEAD `48a867c`，
`git log -1` 仍是 `48a867c`）。工作过程中出现的三处非我改动，上级已澄清是**并行派的另一个执行岗（E1）**
所为、**不会撤回**，不是负向自证，也无需我处理：

- `electron/side-effect-domain.cjs`：新增 `SIDE_EFFECT_ERROR.IN_PROCESS_NOT_PERMITTED`。
- `electron/side-effect-runtime.cjs`：`executeInProcess` 增加 execution placement 守卫
  （非 `IN_PROCESS_EXECUTION_PROVIDERS` 的 provider fail closed，不写 call 状态）+ 顶部注释更新。
- `tests/side-effect-c4-gates.test.mjs`：+79 行（我从未打开过该文件）。

我**没有**触碰这三个文件；为做 §4.1 的负向自证我曾临时改过 `side-effect-runtime.cjs`，但已按字节还原
（`shasum` = `0082e4a42888601b025f25db2b5e8a08741d8626`，与备份一致），当前 `side-effect-runtime.cjs`
的 diff 与我无关。E1 的改动**不碰** `approvalSnapshot` 的 `allowed` 集合与 `:200-202` 的投影构造，
因此对本门禁结论无影响；上级已按「先提交被测代码再取证」流程安排独立取证岗在该 commit 上复跑。
唯一残留约束：只要后续有改动触及投影白名单，`10-push-gate-green.txt` 需复跑刷新。
