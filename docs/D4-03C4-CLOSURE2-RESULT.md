# D4-03C4 Closure-2 · 结果记录（Cold-Restart Death Proof）

> **已被 D4-03C4 Closure-3 收紧（supersedes）**：本文把"persisted trusted EXITED proof"当成 cold restart 的 death authority。Closure-3 证明 **persisted runtime lifecycle record 不是 process-death authority**（"SUPERVISOR_OBSERVED_EXIT" 字符串 != 真实观测），因此 \`TRUSTED_EXIT_REASONS\` 白名单 authority 已彻底删除。文中 "persisted trusted EXITED → quiesced=true" 陈述均为**历史记录**，已被取代；当前永久规则见 \`docs/D4-03C4-CLOSURE3-RESULT.md\` 与 ADR "Persisted Exit Proof Authority（D4-03C4 Closure-3 · 永久）"。pathname 语义（Closure-2）仍然有效。

Base HEAD：\`291d51c7db2e1a7c1e7cbea297f22dc8dc2e0085\`
入口：\`npm run test:d4-03c4-closure2\`

## Task Status

\`D4-03C4 Closure-2 = PASS candidate\`；\`D4-03C4 = PASS candidate\`；\`D4-03C overall = PASS candidate\`；\`D4-03D = NOT STARTED\`。
本轮只关闭两个互相关联的 quiescence authority blocker，未扩大 WRITE surface。

## 两个 blocker

1. **ENOENT / pathname absence 不能作为 executor process death proof。**
2. **persisted executor record 不得保存 / 提供 trusted \`socketPath\` 给 liveness authority。**

## Unix Socket Unlink Semantics（永久）

    Unix socket pathname existence != process lifetime
    pathname has been unlinked != bound/open socket process is dead

filesystem unix-socket probe 只回答 **reachability（ALIVE / UNKNOWN）**，没有 \`PROCESS_DEAD\` 结论。
永久写入 ADR：\`docs/decisions/D4-03C-side-effect-authority.md\` 的
"Unix socket pathname 语义（D4-03C4 Closure-2 · 永久）"。

## ENOENT Authority Removal

彻底删除 \`DEFINITELY_GONE\` / \`DEFINITELY_GONE_ERRNOS\` / \`ENDPOINT_ABSENT\` /
\`OS_EXECUTOR_ENDPOINT_ABSENT\`。\`LIVENESS\` 收敛为 \`{ ALIVE, UNKNOWN }\`。

| OS 结果 | D4-03C4 Closure 旧规则 | Closure-2 现行规则 |
|---|---|---|
| connect 成功 | ALIVE | ALIVE |
| ENOENT | DEFINITELY_GONE → observeExit | **UNKNOWN（不是 death proof）** |
| stale endpoint | UNKNOWN | UNKNOWN |
| ECONNREFUSED | UNKNOWN | UNKNOWN |
| timeout | UNKNOWN | UNKNOWN |
| 任意其它 errno | UNKNOWN | UNKNOWN |
| probe 异常 / 旧 boolean / 旧 DEFINITELY_GONE 形态 | UNKNOWN | UNKNOWN |

## Cold Restart Death Proof

当前阶段允许 \`quiesced=true\` 的可信来源：

1. 同一 supervisor lifetime 内真实的 \`child.on("exit")\` → reason \`SUPERVISOR_OBSERVED_EXIT\`；
2. 上一次 production supervisor 真实观测后持久化的 trusted \`EXITED\`
   （reason 白名单 \`TRUSTED_EXIT_REASONS = { SUPERVISOR_OBSERVED_EXIT, EXECUTOR_SPAWN_FAILED }\`）。

非 trusted reason 的 \`EXITED\` record 与 \`ACTIVE\` 一样 fail closed；
cold restart 绝不从 socket pathname 的存在性重新创造 death proof。

## Live-Unlink Gate

真实 child A \`bind\` socket 并保持存活 → 先确认 probe \`ALIVE\` → **A 仍存活时 \`fs.unlinkSync(socketPath)\`**
→ 新 RuntimeSupervisor：

- probe = \`UNKNOWN\`（绝不 \`DEFINITELY_GONE\`）；
- \`observeExit = 0\`；
- \`quiesced = false\`，reason \`LIVENESS_UNKNOWN\`，proof \`PROBE_UNCERTAIN\`；
- persisted record 保持 \`ACTIVE\`；
- A 的 \`exitCode === null\`（unlink 不影响存活）。

## Live-Unlink Late Mutation E2E

真实盘上：Executor A \`claim RUNNING\` → A 存活时 unlink 它的 lifetime pathname → 新 runtime 打开同一 DB：

- recovery supervisor 绝不声明 A 已死（\`quiesced=false\` / \`LIVENESS_UNKNOWN\` / \`PROBE_UNCERTAIN\`）；
- early verifier \`NOT_APPLIED\` → \`resolved=false\`，Call 保持 \`UNKNOWN_EFFECT\`，Task/Step \`BLOCKED\`；
- 放行 A 的真实 late mutation：\`mutationDone.deleteCalls = 1\`，recovery runtime \`domainDeletes = 0\`；
- 再 verify → \`APPLIED → SUCCEEDED(PASS)\`；
- \`0 second SideEffectCall\` / \`0 lease reacquire\` / \`0 ACTIVE lease\` / \`0 Domain replay\`；
- **never FAILED before late mutation**。

## Same-supervisor Exit Proof

真实 \`supervisor.spawnExecutor\` 一个只持有 lifetime endpoint 的 child：存活时 \`quiesced=false\`；
SIGKILL 后由 production \`child.on("exit")\` 自动 \`observeExit\`（测试不调用）→ \`quiesced=true\`，
proof \`SUPERVISOR_OBSERVED_EXIT\`；persisted record \`status=EXITED\`，无 \`socketPath\`、无任何路径；
cold restart 恢复该 trusted observation（\`stats.dead = 1\`）。

## Persisted EXITED Proof

\`status=EXITED\` + trusted reason → cold restart \`quiesced=true\`（proof \`SUPERVISOR_OBSERVED_EXIT\`）。
对照 E2E：真实退出 + persisted trusted EXITED → \`quiesced=true\` → \`NOT_APPLIED → FAILED(FAIL)\` + Task/Step \`BLOCKED\`，
\`0 retry / 0 second call / 0 Domain replay\`。

## ACTIVE Cold Restart Behavior

persisted \`ACTIVE\` record + pathname 缺失（ENOENT）→ **仍然 \`UNKNOWN\`**，\`observeExit=0\`、
\`quiesced=false\`、\`stats.unknown=1 / dead=0\`，persisted record 保持 \`ACTIVE\`。
\`ACTIVE\` record 绝不因 pathname probe 变成 \`EXITED\`。

## Persisted Runtime Record Contract

record 只含 safe binding：\`instanceId / status / startedAt / endedAt / exitCode / signal / reason / callId / holderId\`。
真实 production \`registerExecutor\` 产生的 JSON 恰为这 9 个 key；**无 \`socketPath\`**，且整个 JSON 不含任何 \`/\`。

## socketPath Removal

\`registerExecutor\` 不再写 \`socketPath\`；\`#sanitize\` 读取旧 record 时丢弃 \`socketPath\` 及未知字段；
\`#observeExit\` 沿用 sanitized record，因此回写盘上的仍是 safe binding。

## instanceId Validation

\`INSTANCE_ID_RE = /^exe_[A-Za-z0-9_-]{1,64}$/\`（production \`newId("exe")\` 形态）。
拒绝 \`../\`、\`/\`、\`\\\`、NUL、absolute path、path separator、oversized、空值。
\`registerExecutor("../../escape")\` → \`{ ok:false, error:"INVALID_INSTANCE_ID" }\` 且不写任何 record。

## Legacy socketPath Spoof

record 的 \`socketPath\` 指向真实 live socket、但派生 endpoint 不存在 → 必须 \`UNKNOWN\`；
record 的 \`socketPath\` 指向不存在路径、但派生 endpoint 是 live socket → 必须 \`ALIVE\`。
证明 probe path 只由 validated \`instanceId\` 派生。

## Path Traversal Gate

手工放入 \`{ instanceId: "../../<outside>/exe_evil", socketPath: <outside live socket> }\`：

- \`observeExit = 0\`、\`registerRuntime = 0\`；
- \`stats.invalid = 1\`、\`alive = 0\`、\`unknown = 0\`、\`dead = 0\`；
- \`quiesced = false\`；
- executorDir 内只有该 malformed 文件；executorDir 之外没有新增任何文件。

## Absolute Path Scan

production 写出的 persisted executor JSON 中 \`socketPath = 0\`、绝对路径 = 0、\`runtimeDir\` = 0、
\`dbPath\` = 0、\`storeRoot\` = 0（由 record contract 测试与 E2E 逐字节断言）。
E2E 里由测试手工放置的 legacy \`socketPath\` 只用于 spoof gate，且证明被完全忽略。

## NOT_APPLIED + Unproven Quiescence

\`NOT_APPLIED + quiesced=false\` → \`resolved=false\`，Call 保持 \`UNKNOWN_EFFECT\`（绝不 \`FAILED\`）。

## APPLIED Regression

\`UNKNOWN_EFFECT + APPLIED → SUCCEEDED(PASS)\`，不依赖 quiescence；AUTO_RETRY=0。

## AUTO_RETRY

所有路径（ALIVE / ENOENT / stale / timeout / 任意 errno / trusted EXITED）下 \`AUTO_RETRY = 0\`：
不 retry / 不 reacquire lease / 不新建 SideEffectCall / 不 replay Domain。

## C4 Gate / C4 Closure Gate / C4 Closure-2 Gate

| 入口 | 结果 |
|---|---|
| \`test:d4-03c4\` | **35 / 35 PASS** + Approval UI **22 / 22** + build PASS |
| \`test:d4-03c4-closure\` | **15 / 15 PASS** |
| \`test:d4-03c4-closure2\` | **12 / 12 PASS** |

Closure-1 的 timeout / UNKNOWN / late-effect 断言全部保留；仅把"ENOENT = DEFINITELY_GONE = death"
那一条改成"ENOENT = UNKNOWN"，并把"trusted death"来源换成 persisted trusted EXITED / 真实 child exit。

## C3 Regression

\`test:d4-03c3\` = **56/56**；\`test:d4-03c3-closure\` = **63/63**（APPLIED / NOT_APPLIED / INDETERMINATE /
late mutation / AUTO_RETRY=0 全保持）。

## C2 Regression

\`test:d4-03c2\` = 29/29；closure = 38/38；closure2 = 45/45；closure3 = 51/51。

## C1 Regression

\`test:d4-03c1\` = **48/48**；\`test:d4-03c1-closure\` = **52/52**。

## D4-03B/A

\`test:d4-03b\` = **59/59**；\`test:d4-03a\` = **32/32**。

## D4-02

\`test:d4-02a\` = 22/22；\`test:d4-02b\` = 16/16；\`test:d4-02c\` = 22/22。

## D4-01

\`test:d4-01\` = **59/59**。

## npm test

**862 / 862 PASS**（0 failed；较上阶段 +12 = 新增 Closure-2 用例）。

## build

\`npm run build\` = **PASS**（tsc --noEmit + vite build）。

## security

\`npm run test:security\` = **FAIL 0 / PARTIAL 2 / PASS 6**（无新增 FAIL，无新增 PARTIAL）。

## Files Changed

\`git diff --name-only 291d51c7db2e1a7c1e7cbea297f22dc8dc2e0085...HEAD\`：

    PROGRESS.md
    docs/D4-03C4-CLOSURE-RESULT.md
    docs/D4-03C4-CLOSURE2-RESULT.md
    docs/decisions/D4-03C-side-effect-authority.md
    electron/runtime-supervisor.cjs
    electron/side-effect-executor.cjs
    electron/task-bootstrap.cjs
    experiments/d4-03c4-closure/run-all.mjs
    experiments/d4-03c4-closure2/run-all.mjs
    package.json
    tests/fixtures/harness-acp/lifetime-holder.mjs
    tests/fixtures/harness-acp/supervised-executor.mjs
    tests/side-effect-c4-closure.test.mjs
    tests/side-effect-c4-closure2.test.mjs
    tests/side-effect-c4-runtime.test.mjs

## Commits

见本阶段提交记录（3 个 commit，normal fast-forward）。

## local HEAD == origin HEAD

见 Result 报告正文。

## working tree clean

见 Result 报告正文；\`MERGED_TO_MAIN=NO\`。

## Remaining Gaps

\`OS-level network sandbox = NOT VERIFIED\`；\`external workspace read audit = NOT VERIFIED\`；
\`independent malformed ACP injection = NOT VERIFIED\`；\`Windows = NOT VERIFIED\`；
\`External Provider = NOT VERIFIED\`；\`Explicit Resume = DEFERRED\`；\`broader Domain verifiers = NOT VERIFIED\`。
本轮关闭：\`cold-restart process-death proof\`（pathname absence / ENOENT != process death；
persisted runtime record 不得携带 socketPath；probe path 由 validated instanceId 重派生）。
其余项不因本轮关闭。

## 有意接受的后果

\`ECONNREFUSED\` / stale / 被 unlink 的 pathname 都无法证明 executor 已死 → 这类 \`UNKNOWN_EFFECT\`
保持 \`UNKNOWN_EFFECT\` + Task/Step \`BLOCKED\`，不会自动收敛为 \`FAILED\`；只有 \`APPLIED\`
（authoritative read-only Domain verifier 可靠观察到 desired effect）可自动收敛为 \`SUCCEEDED\`。
这是"宁可长期 UNKNOWN_EFFECT，也不牺牲 correctness"的有意取舍。
