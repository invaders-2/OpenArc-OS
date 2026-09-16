# D4-03D Closure · 结果记录（Tool-call Identity Seal）

Base HEAD：`c97f925864efa958a414e051728e9203777d6d5e`
入口：`npm run test:d4-03d-closure`
Artifact：`artifacts/d4-03d-closure/d4-03d-closure-gate.json`

## Task Status

`D4-03D Closure = PASS candidate`；`D4-03D = PASS candidate`；`D4-03 overall = PASS candidate`；`D4-04 = NOT STARTED`。
只关闭两个同源 blocker，未扩大 Tool / WRITE surface。

## 两个 blocker

1. Tool Facade 当前允许 **missing callId** 继续执行。
2. `runId + callId` dedupe **没有绑定 toolId + arguments identity**。

## Tool Call Identity（永久）

    Tool Call Identity = runId + callId + toolId + canonical arguments fingerprint

canonical serialization 复用 `electron/tool-domain.cjs` 的 `fingerprint/kanon`（递归 key sort），
**不依赖 JSON.stringify 的对象 key insertion order**。

## Mandatory callId Contract

`POST /tool-call` 必须带 non-empty bounded `callId`：

    typeof callId === "string" && trim().length >= 1 && length <= 256 && 无 NUL / C0 / C1 控制字符

missing / invalid → **`400 TOOL_CALL_ID_REQUIRED`**，且发生在 `cap.calls++` / ToolProposal /
ToolExecution / SideEffectCall / Approval / Lease / Domain call **之前**。

## Plugin Missing-callId Gate

`electron/dsh-openarc-read-tools/index.js`：`exec.callId` 缺失 / 非 string / 空白时**本地抛 safe error**，
绝不把 `callId:null` 发给 Bridge → **0 Tool Facade request**。
Bridge 的 callId validation 是最终 Authority Gate（plugin fail closed + Bridge fail closed 双层）。

## Tool-call Request Fingerprint

首次合法 `runId + callId` 建立 immutable binding：

    { requestFingerprint: fingerprint({ toolId, arguments }), toolId, pending, outcome }

只保存 safe identity，不保存 raw arguments / token / session / 绝对路径 / credential。

## Immutable Binding

`callsById: callId → binding`（run/facade 内存级 delivery dedupe，不新增 DB table）。
binding 建立后不可被同 callId 的其它请求覆盖。

## Exact Duplicate

same `callId + toolId + arguments fingerprint`：

- 在途 → await 同一 pending；
- 已完成 → 返回同一 safe outcome；
- `0 second execution` / `0 extra budget`。

READ / WRITE 都验证；WRITE duplicate 返回同一 `approvalRequestId`、1 个 SideEffectCall。

## Terminal WRITE Replay

WRITE 已 `SUCCEEDED`（approval → execution → verification PASS）后，同 callId/tool/args 重送：
返回原 binding（同一 `approvalRequestId`），`0 second SideEffectCall` / `0 second approval` /
`0 second lease` / `0 second mutation` / `0 extra budget`。

## READ→WRITE Collision

`callId=collision_1` 先 `resource.search` 成功，再 `resource.trash`：
**`409 TOOL_CALL_ID_CONFLICT`**；0 SideEffectCall / 0 approval / 0 lease / 0 mutation；
**绝不把 READ result 当成 WRITE success 返回 Harness**。

## WRITE→READ Collision

`callId=collision_2` 先 `resource.trash`（SIDE_EFFECT_APPROVAL_REQUIRED），再 `resource.search`：
**`409 TOOL_CALL_ID_CONFLICT`**；绝不返回 `SIDE_EFFECT_APPROVAL_REQUIRED` 冒充 READ result；
原 SideEffectCall binding 不被覆盖。

## WRITE→WRITE Payload Collision

`callId=collision_3` 先 trash resourceA，再 trash resourceB（resources 不同：
toolId 相同但 canonical arguments fingerprint 不同）→ **`409 TOOL_CALL_ID_CONFLICT`**；
只允许 1 个 SideEffectCall 且只绑定 resourceA；resourceB 0 mutation。

## Concurrent Collision

- concurrent exact duplicate → 1 pending authority / 1 execution / same result / 1 budget unit；
- concurrent different-payload（same callId / different args 或 different tool）→ 恰好一个 winner，
  另一个 `409 TOOL_CALL_ID_CONFLICT`，total execution <= 1。

## MaxCalls Atomic Gate

`maxCalls = 1` + 并发两个不同 callId → 恰好一个 200、另一个 `429 TOOL_CAPABILITY_EXHAUSTED`；
`cap.calls = 1`。`cap.calls >= cap.maxCalls` 检查与 `cap.calls += 1` 在同一同步块内完成（之间无 await）。

## Budget Contract

    invalid callId  = 0 budget
    callId conflict = 0 extra budget
    exact duplicate = 0 extra budget
    first valid unique call = +1

## Harness callId vs OpenArc SideEffectCall Identity

dsh 自报 `callId="scall_fake_harness_id"` 只作为 Tool Facade external identity；
`SideEffectCall.callId` / idempotencyKey / approval / lease 仍由 OpenArc `newId("scall")` 生成，
断言 `approvalRequestId !== "scall_fake_harness_id"` 且以 `scall_` 开头。

## AUTO_RETRY

`AUTO_RETRY = 0`：0 hidden retry；invalid callId / conflict / duplicate 都不产生额外执行；
`DEFAULT_MAX_CALLS = 8` 保持不变（bounded）。

## D4-03D Closure Gate

`npm run test:d4-03d-closure` = **62 / 62 PASS**
（closure 10 + D4-03D 52）。artifact contract 全部 true、`schemaBumped=false`。

## D4-03D Regression

`npm run test:d4-03d` = **52 / 52 PASS**（未删除、未弱化任何测试；仅给原本省略 callId 的测试补上 callId 以符合新 contract）。

## D4-03C regressions

`test:d4-03c4` = 35/35 + UI 22/22 + build PASS；closure = 15/15；closure2 = 12/12；closure3 = 9/9；
`test:d4-03c3` = 56/56；closure = 63/63；`test:d4-03c2` = 29/38/45/51；`test:d4-03c1` = 48/52。

## D4-03B / A

`test:d4-03b` = 59/59；`test:d4-03a` = 32/32。

## D4-02

`test:d4-02a` = 22/22；`test:d4-02b` = 16/16；`test:d4-02c` = 22/22。

## D4-01

`test:d4-01` = 59/59。

## npm test

**902 / 902 PASS**（0 failed；含新增 Closure 10 条）。

## build

`npm run build` = PASS。

## security

`npm run test:security` = FAIL 0 / PARTIAL 2 / PASS 6。

## 生产改动

- `electron/tool-facade-bridge.cjs`：mandatory callId（`TOOL_CALL_ID_REQUIRED`）+ immutable identity binding
  （toolId + canonical arguments fingerprint）+ `TOOL_CALL_ID_CONFLICT` + 原子 budget reserve；
- `electron/dsh-openarc-read-tools/index.js`：missing `exec.callId` 本地 fail closed（0 facade request）。
- 测试对齐：`tests/side-effect-c4-gates.test.mjs` 与 `tests/tool-d4-03d-authority.test.mjs` 的原本省略
  callId 的请求补上 callId（符合新 contract，不弱化断言）。

## Files Changed

`git diff --name-only c97f925864efa958a414e051728e9203777d6d5e...HEAD`：

    PROGRESS.md
    docs/D4-03D-CLOSURE-RESULT.md
    docs/decisions/D4-03C-side-effect-authority.md
    electron/dsh-openarc-read-tools/index.js
    electron/tool-facade-bridge.cjs
    experiments/d4-03d-closure/run-all.mjs
    package.json
    tests/side-effect-c4-gates.test.mjs
    tests/tool-d4-03d-authority.test.mjs
    tests/tool-d4-03d-closure.test.mjs

## Remaining Gaps

`OS-level network sandbox = NOT VERIFIED`；`external workspace read audit = NOT VERIFIED`；
`independent malformed ACP injection = NOT VERIFIED`；`Windows = NOT VERIFIED`；
`External Provider = NOT VERIFIED`；`Explicit Resume = DEFERRED`；
`broader Domain verifiers = NOT VERIFIED`；
`authenticated durable cross-restart process-death proof = DEFERRED / NOT VERIFIED`。
本 Closure **不关闭**任何一项。
