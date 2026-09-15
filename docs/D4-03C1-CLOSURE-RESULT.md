# D4-03C1 Closure Result

Task Status: **D4-03C1 Closure = PASS candidate**（Crash/Restart recovery 强制 fail closed + 真实 Lease Contention 验证）；**D4-03C1 = PASS candidate（待 ChatGPT 审计）**；**D4-03C overall = PARTIAL**；**D4-03C2 = NOT STARTED**。本轮 production WRITE execution = 0、business mutation = 0。

## 1. Base HEAD / Final HEAD

- 本轮开始前真实审计：local HEAD == origin == a54b876，working tree clean。
- 审计发现 remote feature/d4-03-tool-proxy 已被 force-update 为 994ad76（parent 809e8fa），丢掉了 C1 三个 commit，并新增 PLAN_SYNC.md；用户描述的 a2e9224 本地/远端均不存在。
- 处理（禁止 reset 他人提交）：git rebase origin/feature/d4-03-tool-proxy，将 C1 三个 commit 重放到 994ad76 之上，保留 PLAN_SYNC.md。重放后 HEAD = cef1462。
- 本轮 Closure BASE_HEAD = cef1462。Final HEAD 见 §16/§17。

## 2. Crash Recovery Fix

旧实现不够 fail-safe：recoverOnStartup({ instanceId, blockTask = false }) 把 Task/Step blocking 变成 caller 可选开关，默认关闭，production 可以不 block。

新 contract（fail closed）：
- 删除 blockTask 参数；不存在 production 安全 bypass。
- 发现 RUNNING SideEffectCall 时无条件：① 先把 call 置 UNKNOWN_EFFECT（绝不回退 LEASED/APPROVED/FAILED）；② 通过 Task Authority TaskService.recoverRunning() 将 Step/Task → BLOCKED（RECOVERY_REQUIRED）+ TaskEvent；③ 非本进程 ACTIVE lease → EXPIRED。
- 若 TaskService 不可用 / Task/Step 缺失 / 无法安全 block：记录安全事件（side_effect.recovery_blocked + tool.execution_blocked）、保持 UNKNOWN_EFFECT、ok:false + errors[]，禁止 replay/retry。
- 未新建第二套 Task state machine；复用既有 recoverRunning() / appendEvent / TaskStore 事务。

## 3. Real Persisted Restart

tests/side-effect-real-restart.test.mjs（disk-backed SQLite）：
- Runtime A：创建 Task/RUNNING Step/run、Approval APPROVED、Lease ACTIVE(instA)、SideEffectCall RUNNING；记录 baseline。
- 真正 fx.close() 关闭 Runtime A 全部 DB handle（keepData 保留 disk 文件）；Runtime B 用新 instanceId=instB 重新打开同一 DB、新 TaskService/SideEffectAuthority。
- recoverOnStartup({instanceId:instB}) 后：ok:true、errors:[]、unknownEffectCalls=1；call = UNKNOWN_EFFECT（≠FAILED，verificationStatus 非 PASS）；旧 lease 恰好 1 条 EXPIRED；Step = BLOCKED、Task = BLOCKED；事件 tool.side_effect.unknown_effect + task.recovery_blocked；SideEffectCall/ToolProposal count 不增加、ToolExecution = 0；旧 holder 非 ELIGIBLE；executeSideEffect = WRITE_EXECUTION_DISABLED；verifyUnknownEffect = VERIFICATION_NOT_AVAILABLE 且保持 UNKNOWN_EFFECT。
- Crash-before-RUNNING：APPROVED/LEASED 不进入 UNKNOWN_EFFECT，旧 lease EXPIRED，新 holder 可重新 acquire，0 execution。
- Recovery fail closed：TaskService 不可用（test-only seam，生产始终注入）→ ok:false + TASK_SERVICE_UNAVAILABLE，call 保持 UNKNOWN_EFFECT、0 execution。

## 4. Real Lease Contention

tests/side-effect-real-contention.test.mjs + tests/fixtures/harness-acp/lease-contender.mjs：
- 两个独立 child process executor，各自独立 SQLite connection / IdentityStore，访问同一 disk-backed DB、同一 callId、同一 APPROVED SideEffectCall，holderId/holderInstanceId 不同。
- barrier：两个 executor 先 READY，父进程同一 tick 写 GO 后同时 acquireLease（顺序打开连接仅为避开 WAL PRAGMA 争抢，acquire 仍并发）。
- PASS：success = 1、SIDE_EFFECT_LEASE_CONFLICT = 1、reopen 后 ACTIVE lease = 1、call = LEASED。
- 结果不含裸 SQLITE_BUSY / SQLITE_LOCKED；Authority 将 contention 收敛为 SIDE_EFFECT_LEASE_CONFLICT（fail closed）。
- check+insert 仍在同一 BEGIN IMMEDIATE 原子事务内，未改成 read→await→insert。

## 5. WRITE Boundary

- executeSideEffect() = WRITE_EXECUTION_DISABLED，mutationCount = 0。
- tool_executions = 0；side_effect_calls 最多 LEASED/UNKNOWN_EFFECT，未执行。
- 0 real REVERSIBLE_WRITE / 0 IRREVERSIBLE / 0 EXTERNAL / 0 PRIVILEGED / 0 MCP / 0 Shell / 0 filesystem mutation / 0 Browser / 0 Canvas / 0 App Center。

## 6. Harness Spoof Regression

test:d4-03c1 的 spoof 用例继续 PASS：approved / approvalId / leaseId / callId / idempotencyKey / effectClass / expectedEffects → TOOL_ARGUMENT_INVALID，0 SideEffectCall / 0 lease / 0 approval / 0 execution。

## 7. Secret Scan

side_effect_calls / tool_approvals / side_effect_leases / TaskEvent / authorization_audit / tool DB / restart 与 contention 产物扫描：Provider Secret 0、mpx_ 0、tpx_ 0、raw Authorization 0、credential 0、绝对路径 0、store root 0。

## 8. Migration

Schema 保持 v13，本轮无 schema 变化，未升版本、未改旧 migration。test:d4-03c1（含 v12→v13 迁移 + 回滚）PASS。

## 9. D4-03C1 Gate

- npm run test:d4-03c1 = 46 / 46 PASS（原 Gate 未删除、未削弱）。
- npm run test:d4-03c1-closure = 50 / 50 PASS（新增 real contention + real persisted restart + recovery fail-closed）。

## 10. D4-03B / A Regression

- npm run test:d4-03b = 59 / 59 PASS。
- npm run test:d4-03a = 32 / 32 PASS。

## 11. D4-02 / D4-01 Regression

- test:d4-02a = 22/22；test:d4-02b = 16/16；test:d4-02c = 22/22。
- test:d4-01 = 59/59。

## 12. npm test

npm test = 723 / 723 PASS（0 failed）。

## 13. build

npm run build = PASS。

## 14. security

npm run test:security = FAIL 0 / PARTIAL 2 / PASS 6（无新增 FAIL、无新增 PARTIAL）。

## 15. Files Changed

git diff --name-only cef1462...HEAD 真实输出：

    PROGRESS.md
    docs/D4-03C1-CLOSURE-RESULT.md
    docs/decisions/D4-03C-side-effect-authority.md
    electron/side-effect-authority.cjs
    experiments/d4-03c1-closure/run-all.mjs
    package.json
    tests/fixtures/harness-acp/lease-contender.mjs
    tests/fixtures/harness-acp/task-harness-fixture.mjs
    tests/model-fixtures.mjs
    tests/resource-fixtures.mjs
    tests/side-effect-real-contention.test.mjs
    tests/side-effect-real-restart.test.mjs

## 16. Commits

    63100fb fix(D4-03): make side-effect crash recovery fail closed
    e7e8a53 test(D4-03): verify real lease contention and persisted restart
    <docs commit> docs(D4-03): close C1 recovery evidence gap

## 17. local HEAD == origin HEAD / working tree clean

push 后：local HEAD == origin/feature/d4-03-tool-proxy，git status clean，未 merge main。

## 18. Remaining Gaps

OS-level network sandbox、external workspace read audit、independent malformed ACP injection、Windows、External Provider 全部 NOT VERIFIED；Explicit Resume = DEFERRED；Final Approval UI = NOT IMPLEMENTED；official dsh test.write → APPROVAL_REQUIRED → Task WAITING 的 official-dsh 变体 = NOT VERIFIED；real Domain verifier = NOT VERIFIED。均不因本轮 Closure 关闭。

## 19. Final Stage Claim

    D4-03C1 Closure = PASS candidate
    D4-03C overall = PARTIAL
    D4-03C2 = NOT STARTED

本轮到此停止，未进入 D4-03C2 / real WRITE / MCP / Shell / Browser / Canvas / App Center。
