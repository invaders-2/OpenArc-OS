# D4-03C4 Closure · 结果记录（Cold-restart Runtime Quiescence Probe must fail closed）

> **已被 D4-03C4 Closure-2 收紧（supersedes）**：本文记录 Closure-1 阶段的 tri-state 规则（\`ALIVE / DEFINITELY_GONE / UNKNOWN\`）。Closure-2 证明 **ENOENT / pathname absence 也不是 executor death proof**（Unix socket pathname existence != process lifetime），因此 \`DEFINITELY_GONE\` / \`DEFINITELY_GONE_ERRNOS\` / \`ENDPOINT_ABSENT\` 已彻底删除。文中所有 "ENOENT → DEFINITELY_GONE → observeExit" 陈述均为**历史记录**，已被取代；当前永久规则见 \`docs/D4-03C4-CLOSURE2-RESULT.md\` 与 ADR "Unix socket pathname 语义（D4-03C4 Closure-2 · 永久）"。

Base HEAD：\`55e0cacb9862857eb57d4e77f9d848b06cab1d81\`
入口：\`npm run test:d4-03c4-closure\`

## Task Status

\`\`\`
D4-03C4 Closure = PASS candidate
D4-03C4 = PASS candidate
D4-03C overall = PASS candidate
D4-03D = NOT STARTED
\`\`\`

## Previous Blocker

\`electron/runtime-supervisor.cjs\` 的 \`probeUnixSocket\` 返回单一 boolean：

\`\`\`js
socket.on("connect", () => done(true));
socket.on("timeout", () => done(false));   // ← timeout 被当成死亡
socket.on("error", () => done(false));     // ← 任意 errno 被当成死亡
\`\`\`

而 \`rehydrate()\` 把所有 \`false\` 解释为 "executor definitely dead" → \`observeExit()\` → \`quiesced=true\`。
**probe uncertainty != death proof。**

## Tri-state Probe Contract

\`\`\`
ALIVE           connect() 成功                      → runtime ACTIVE；绝不 quiesced
DEFINITELY_GONE 明确证明 endpoint 无 live listener   → 唯一允许 observeExit / trusted quiescence
UNKNOWN         probe 不确定                        → 不 observeExit；quiesced=false
\`\`\`

| OS 结果 | 分类 |
|---|---|
| \`connect()\` 成功 | ALIVE |
| \`ENOENT\` | DEFINITELY_GONE |
| timeout | UNKNOWN |
| \`EACCES\` / \`EMFILE\` / \`ENFILE\` / \`ENOBUFS\` / \`ENOMEM\` | UNKNOWN |
| \`ECONNREFUSED\` | UNKNOWN（刻意 fail closed） |
| 任意其它 errno / 无 code | UNKNOWN |
| probe 自身抛异常 / 旧 boolean 返回值 | UNKNOWN |

\`DEFINITELY_GONE_ERRNOS\` 白名单当前只含 \`ENOENT\`；匹配必须显式，默认分支必须是 UNKNOWN。

## ALIVE Evidence

真实 \`net.createServer().listen(path)\` → probe 返回 \`{state:"ALIVE"}\`；
supervisor \`isQuiesced\` = false / \`RUNTIME_STILL_ACTIVE\`；\`observeExit\` 调用数 = 0。

## DEFINITELY_GONE Evidence

endpoint 文件不存在（ENOENT）→ \`{state:"DEFINITELY_GONE"}\` → supervisor 恰好一次 \`observeExit\` →
\`isQuiesced().quiesced = true\`（proof \`SUPERVISOR_OBSERVED_EXIT\`）；persisted record → \`EXITED\`。

真实 SIGKILL 一个持有 lifetime socket 的进程后，socket 文件仍在 → probe = \`UNKNOWN\`（不是 DEFINITELY_GONE）。

## UNKNOWN Timeout Evidence

\`probeUnixSocket(path, {timeoutMs:20, connectImpl:()=>timeoutSocket()})\` → \`{state:"UNKNOWN", reason:"PROBE_TIMEOUT"}\`；
supervisor 级真实 timeout → \`observeExit=0\`、\`quiesced=false\`、\`reason="LIVENESS_UNKNOWN"\`、\`stats.unknown=1 / dead=0\`。

## UNKNOWN Error Evidence

注入 \`EACCES / EMFILE / ENFILE / ENOBUFS / ENOMEM / ECONNREFUSED / CUSTOM_TRANSIENT_ERROR / 无 code\` →
一律 \`UNKNOWN\`；\`observeExit=0\`；\`quiesced=false\`；不写 \`OS_EXECUTOR_ENDPOINT_ABSENT\`；persisted record 保持 \`ACTIVE\`。

## observeExit Authority

\`RuntimeSupervisor\` 仍是**唯一**调用 \`registerRuntime / observeExit\` 的 production 代码；
Static Gate 解析源码断言：probe 函数体内不含 \`observeExit\` / \`registerRuntime\`；
\`timeout\` handler 必须解析 \`LIVENESS.UNKNOWN\`；\`error\` handler 必须显式白名单匹配；
\`rehydrate()\` 的 UNKNOWN 分支不含 \`observeExit\`、不写 \`EXITED\`。接口未扩大（\`observeExit / registerRuntime\` 仍不导出）。

## Cold Restart UNKNOWN_EFFECT

真实盘上：executor 真实 acquire lease + claim 到 RUNNING → 拥有它的 supervisor 进程"已不在"（测试不调用 observeExit）
→ SIGKILL 后 stale socket 文件仍在 → cold restart → production \`recoverOnStartup()\` →
probe \`UNKNOWN\` → \`recoverySafe.quiesced=false\` / \`reason="LIVENESS_UNKNOWN"\` / proof \`PROBE_UNCERTAIN\` →
Call 保持 \`UNKNOWN_EFFECT\`；Task/Step \`BLOCKED\`；0 retry / 0 second SideEffectCall / 0 lease reacquire / 0 Domain mutation。

## NOT_APPLIED + UNKNOWN

\`verifyUnknownEffect\` → \`outcome=NOT_APPLIED\`、\`quiesced=false\` → \`resolved=false\` → **绝不 FAILED**，Call 保持 \`UNKNOWN_EFFECT\`。

## NOT_APPLIED + Quiesced

只有 probe \`DEFINITELY_GONE\`（ENOENT）→ \`quiesced=true\` → \`NOT_APPLIED\` → \`FAILED(FAIL)\` + Task/Step \`BLOCKED\`，0 retry / 0 Domain replay。

## APPLIED Regression

\`APPLIED\` 不依赖 quiescence：probe \`UNKNOWN\` 下 verifier 可靠看到 desired effect → \`UNKNOWN_EFFECT → SUCCEEDED(PASS)\`。

## INDETERMINATE Regression

\`INDETERMINATE\` → 继续保持 \`UNKNOWN_EFFECT\`；C3 语义未修改。

## AUTO_RETRY

\`AUTO_RETRY = 0\`：probe UNKNOWN / DEFINITELY_GONE / ALIVE 三种情况下都不产生 retry、不 reacquire lease、不新建 SideEffectCall、不 replay Domain。

## Late Effect Safety

\`probe UNKNOWN → early verifier NOT_APPLIED → Call 保持 UNKNOWN_EFFECT\`；随后 late effect 真实出现 →
\`APPLIED → SUCCEEDED\`。不存在 \`FAILED → late mutation\` 这种 false-negative terminal transition。

## Security Surface

\`RuntimeLifecycleAuthority / observeExit / registerRuntime\` 仍不暴露给 Renderer / IPC / ACP / Harness / Tool Facade / Model / tool args。
新增的 \`probeImpl\` 只在 \`RuntimeSupervisor\` 构造器（test-only seam），不做 IPC / Renderer / Harness 暴露，也不落盘；
production 默认仍是真实 OS probe。

## Secret Scan

\`runtime_liveness_unknown\` safe 事件只含 instanceId + 归一化 reason；断言日志不含 runtimeDir / 绝对路径 / secret。
executor 的 persisted record 只含 safe identifier。

## C4 Closure Gate

\`npm run test:d4-03c4-closure\` = **15 / 15 PASS**（artifact \`artifacts/d4-03c4-closure/d4-03c4-closure-gate.json\`）。

## Schema

保持 \`SCHEMA_VERSION = 14\`；tri-state probe 不需要 DB migration。

## 顺带加固（与本 blocker 直接相关）

executor runtime 若无法 bind 自己的 lifetime endpoint，**绝不执行 write**：
\`endpoint_bind_failed\` + \`process.exit(3)\`。否则 quiescence 归属无法成立。

## 边界

WRITE surface 仍只有 \`resource.trash\`；Approval UI / Trusted Approval Gateway / official dsh WRITE chain /
SideEffectCall / Lease / Idempotency / Tool Registry / ResourceService.delete 均未重写。
