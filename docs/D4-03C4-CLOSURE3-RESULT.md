# D4-03C4 Closure-3 · 结果记录（Durable Exit Proof Authority Seal）

Base HEAD：\`517a757ddb30b9e40ee0d2210a6c8ca7ea04d127\`
入口：\`npm run test:d4-03c4-closure3\`

## Task Status

\`D4-03C4 Closure-3 = PASS candidate\`；\`D4-03C4 = PASS candidate\`；\`D4-03C overall = PASS candidate\`；\`D4-03D = NOT STARTED\`。
本轮只关闭一个 blocker：**persisted EXITED runtime JSON 不得自身成为 trusted process-death authority**。

## Persisted EXIT Authority Removal

永久规则：

    Persisted data saying "SUPERVISOR_OBSERVED_EXIT" != Supervisor actually observing exit now

普通 durable JSON 字段（\`status / reason / exitCode / signal / endedAt\`）本身没有资格让
\`quiesced=true\`。代码里**彻底删除 reason 白名单 authority**（\`TRUSTED_EXIT_REASONS\` 不再存在）；
cold restart 对任何 persisted \`status=EXITED\`（含 \`SUPERVISOR_OBSERVED_EXIT\` /
\`EXECUTOR_SPAWN_FAILED\`）一律 \`UNVERIFIED_PERSISTED_EXIT → 不 observeExit → quiesced=false\`。

## Real Supervisor Exit Proof

同一个仍然活着的 production \`RuntimeSupervisor\` \`spawnExecutor\` 一个真实 child：
存活时 \`quiesced=false\`；真实 \`child.on("exit")\` → 自动 \`observeExit\`（测试不调用）→
\`quiesced=true\` / proof \`SUPERVISOR_OBSERVED_EXIT\`。这是当前实现**唯一** trusted death proof。
同一份 persisted record 在新 supervisor 的 cold restart 里不再恢复（\`UNVERIFIED_PERSISTED_EXIT\`）。

## Forged SUPERVISOR_OBSERVED_EXIT Gate

手工写 \`{instanceId, status:"EXITED", reason:"SUPERVISOR_OBSERVED_EXIT", exitCode:0}\`（无真实 exit observation）：
\`observeExit count = 0\`、\`quiesced=false\`、reason \`LIVENESS_UNKNOWN\`、proof \`PROBE_UNCERTAIN\` /
\`probeReason=UNVERIFIED_PERSISTED_EXIT\`，内存视图 fail-closed 成 \`ACTIVE\`。

## Forged EXECUTOR_SPAWN_FAILED Gate

手工写 \`reason:"EXECUTOR_SPAWN_FAILED"\` 同样：\`quiesced=false\`、\`observeExit=0\`。
字符串命中任何"看起来 trusted"的名字都不得获得 authority。

## Cold Restart Fail-closed Semantics

\`rehydrate()\`：

    invalid instanceId    → ignore；不 probe / 不 persist / 不 observeExit / 不 quiesce
    EXITED（任何 reason） → register ACTIVE + UNVERIFIED_PERSISTED_EXIT；no observeExit；
                            unknown++ / unverifiedExit++
    ACTIVE                → reachability probe（ALIVE / UNKNOWN）

\`dead\` 在 rehydrate 里恒为 0；persisted record 不被改写。

## Authenticated Durable Proof Gap

真正的 cross-restart **authenticated / integrity-protected** durable lifecycle proof
= **DEFERRED / NOT VERIFIED**。本阶段不实现，也不允许用 reason 白名单 / magic field /
\`trusted=true\` / \`source=supervisor\` / checksum without secret / filename convention 冒充。
该缺口不是 safety blocker：当前行为 fail closed 到 \`UNKNOWN_EFFECT\`。

## ENOENT Regression

ENOENT → \`UNKNOWN\`（不是 death proof），未回退。

## Live-Unlink Regression

真实 child 存活时 unlink 它的 pathname → \`UNKNOWN\` / \`observeExit=0\` / \`quiesced=false\`，未回退。

## socketPath / instanceId Regression

persisted record 不含 \`socketPath\` / 绝对路径 / runtimeDir / dbPath / storeRoot；
\`instanceId\` 冻结为 \`^exe_[A-Za-z0-9_-]{1,64}$\`；malformed / traversal / separator / NUL / oversized 一律忽略。

## NOT_APPLIED Behavior

- \`UNKNOWN + NOT_APPLIED\` → \`resolved=false\`，Call 保持 \`UNKNOWN_EFFECT\` + Task/Step \`BLOCKED\`；
- 同一仍活着的 supervisor 真实观测 exit（\`quiesced=true\`）+ \`NOT_APPLIED\` → \`FAILED(FAIL)\`；
- persisted EXITED + \`NOT_APPLIED\` → 保持 \`UNKNOWN_EFFECT\`（绝不 FAILED）。

## APPLIED Behavior

\`UNKNOWN_EFFECT + APPLIED → SUCCEEDED(PASS)\`，不依赖 quiescence；未改变。

## AUTO_RETRY

所有路径 \`AUTO_RETRY = 0\`：0 retry / 0 second SideEffectCall / 0 lease reacquire / 0 Domain replay。

## C4

\`npm run test:d4-03c4\` = **35 / 35 PASS** + Approval UI **22 / 22** + build PASS。

## C4 Closure

\`npm run test:d4-03c4-closure\` = **15 / 15 PASS**。

## C4 Closure-2

\`npm run test:d4-03c4-closure2\` = **12 / 12 PASS**（live-unlink / socketPath removal /
instance validation / path traversal 全部保留，只把错误的 "persisted EXITED reason = authority" 假设收紧）。

## C4 Closure-3

\`npm run test:d4-03c4-closure3\` = **9 / 9 PASS**（artifact
\`artifacts/d4-03c4-closure3/d4-03c4-closure3-gate.json\`：\`persistedExitHasNoAuthority=true\`、
\`onlyLiveSupervisorObservationMayQuiesce=true\`、\`reasonStringIsNotProof=true\`、
\`pathnameHasNoDeathAuthority=true\`、\`persistedRecordHasNoSocketPath=true\`、\`schemaBumped=false\`）。

## C3 regressions

\`test:d4-03c3\` = **56/56**；\`test:d4-03c3-closure\` = **63/63**（APPLIED / NOT_APPLIED /
INDETERMINATE / late effect / AUTO_RETRY=0 保持）。

## C2 regressions

\`test:d4-03c2\` = 29/29；closure = 38/38；closure2 = 45/45；closure3 = 51/51。

## C1 regressions

\`test:d4-03c1\` = **48/48**；\`test:d4-03c1-closure\` = **52/52**。

## D4-03B/A

\`test:d4-03b\` = **59/59**；\`test:d4-03a\` = **32/32**。

## D4-02

\`test:d4-02a\` = 22/22；\`test:d4-02b\` = 16/16；\`test:d4-02c\` = 22/22。

## D4-01

\`test:d4-01\` = **59/59**。

## npm test

**871 / 871 PASS**（0 failed；较上阶段 +9 = 新增 Closure-3 用例）。

## build

\`npm run build\` = **PASS**。

## security

\`npm run test:security\` = **FAIL 0 / PARTIAL 2 / PASS 6**（无新增 FAIL / PARTIAL）。

## Files Changed

\`git diff --name-only 517a757ddb30b9e40ee0d2210a6c8ca7ea04d127...HEAD\`：

    PROGRESS.md
    docs/D4-03C4-CLOSURE2-RESULT.md
    docs/D4-03C4-CLOSURE3-RESULT.md
    docs/decisions/D4-03C-side-effect-authority.md
    electron/runtime-supervisor.cjs
    experiments/d4-03c4-closure/run-all.mjs
    experiments/d4-03c4-closure2/run-all.mjs
    experiments/d4-03c4-closure3/run-all.mjs
    package.json
    tests/side-effect-c4-closure.test.mjs
    tests/side-effect-c4-closure2.test.mjs
    tests/side-effect-c4-closure3.test.mjs
    tests/side-effect-c4-runtime.test.mjs

## Commits

见本阶段提交记录（3 个 commit，normal fast-forward）。

## local HEAD == origin HEAD

见 Result 报告正文。

## working tree clean

见 Result 报告正文；\`MERGED_TO_MAIN=NO\`。

## Remaining Gaps

\`authenticated durable cross-restart process-death proof = DEFERRED / NOT VERIFIED\`（非 safety blocker，
当前 fail closed 到 UNKNOWN_EFFECT）；\`OS-level network sandbox = NOT VERIFIED\`；
\`external workspace read audit = NOT VERIFIED\`；\`independent malformed ACP injection = NOT VERIFIED\`；
\`Windows = NOT VERIFIED\`；\`External Provider = NOT VERIFIED\`；\`Explicit Resume = DEFERRED\`；
\`broader Domain verifiers = NOT VERIFIED\`。其余项不因本轮关闭。
