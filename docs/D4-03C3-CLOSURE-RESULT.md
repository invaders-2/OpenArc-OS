# D4-03C3 Closure · Trusted Quiescence Authority（macOS）

- **状态**：**D4-03C3 Closure = PASS candidate**（待 ChatGPT 审计）；**D4-03C = PARTIAL**；**D4-03C4 = NOT STARTED**（禁止自动进入）
- **分支**：feature/d4-03-tool-proxy
- **Schema**：保持 **v14**（`recovery_safe` JSON 已足够承载 origin attribution + proof，无需升版本）
- **机器**：macOS arm64 Apple M3 Pro / Node v22.22.3

## 永久规则

```
different runtime instance != proof that the previous runtime is dead
NOT_APPLIED → FAILED  只有 trusted quiescence proof 成立时才允许
```

## 关闭的两个 blocker

### A. different runtime instance 不再是 dead proof

旧实现用 `oldLease.holderInstanceId !== this.instanceId` 推导 quiesced。现在改为 trusted **RuntimeLifecycleAuthority**：

- 只回答 `"Can an operation owned by <instanceId> still produce a late effect?"`；
- 只有**真实观测到进程退出**（supervisor `waitpid` / child `exit`）后写 `status = EXITED`，`isQuiesced()` 才返回 true；
- 未注册 / 仍 ACTIVE / self runtime 一律 `quiesced = false`（fail closed）。

**Forbidden quiescence sources**（一律无权声明）：Harness / ACP / Model / Tool args / Renderer / IPC / ordinary caller / `holderId` / different instanceId 单独 / 旧 lease EXPIRED|REVOKED|RELEASED 单独 / time elapsed。
**Forbidden production bypass**：`recoverOnStartup({quiesced:true})` / `verifyUnknownEffect({executionQuiesced:true})` / `markRuntimeDead(id)` —— 不存在。

### B. 已持久化 UNKNOWN_EFFECT(quiesced=false) 可在真实 restart 后安全升级

- live timeout / ambiguous 持久化 safe runtime attribution：`originRuntimeInstanceId + originLeaseId + source(live_timeout|live_ambiguous) + recordedAt`。
- `recoverOnStartup()` 现在同时 reconcile 已持久化的 `UNKNOWN_EFFECT(quiesced=false)`：
  - trusted proof 成立 → 只升级 non-authoritative `recovery_safe.quiesced = true`（`source = cold_restart_confirmed`），**Call 状态仍保持 UNKNOWN_EFFECT**；
  - proof 不成立 → 保持 `quiesced = false` + `quiescenceReason`（`RUNTIME_STILL_ACTIVE` / `UNKNOWN_RUNTIME` / `SELF_RUNTIME_ACTIVE` / `NO_LIVENESS_AUTHORITY`）。
- quiescence 升级**不推断 effect**：APPLIED / NOT_APPLIED / INDETERMINATE 仍只由 read-only Domain verifier 决定。

## Mandatory 测试覆盖

| 场景 | 结果 |
|---|---|
| two live runtimes：A 存活时 B 不能声明 quiesced | `quiesced=false`，reason `RUNTIME_STILL_ACTIVE` |
| live A + B recovery early NOT_APPLIED | 保持 UNKNOWN_EFFECT，绝不提前 FAILED |
| A late mutation 后 B 收敛 | APPLIED → SUCCEEDED，Domain invocation = 1 |
| RUNNING cold crash-before-dispatch | trusted quiescence → NOT_APPLIED → FAILED，0 mutation |
| timeout → 真实进程死亡（未 mutation） | quiescence 升级 → NOT_APPLIED → FAILED |
| timeout → late applied → 进程死亡 → restart | quiescence 升级 → APPLIED → SUCCEEDED，delete = 1 |
| UNKNOWN_EFFECT without proven death（self runtime） | 保持 UNKNOWN_EFFECT |
| lease EXPIRED / REVOKED 单独 | 不等于 quiescence |
| RuntimeId mismatch / unknown runtime 单独 | 不等于 quiescence |
| APPLIED 不依赖 quiescence | 可靠 APPLIED → SUCCEEDED |
| AUTO_RETRY | 0（含 NOT_APPLIED / restart / death proof 之后） |
| Task / Step | recovery 后保持 BLOCKED（Explicit Resume = DEFERRED） |

## 安全边界 / 事件

- Harness spoof `quiesced / executionQuiesced / runtimeDead / runtimeExited / originRuntimeInstanceId / quiescenceProof / recoverySource` → `TOOL_ARGUMENT_INVALID`。
- 新增 safe 事件：`tool.side_effect.quiescence_checked / quiescence_confirmed / quiescence_unproven / unknown_effect_quiescence_upgraded` 及对应 authorization audit。
- `RuntimeLifecycleAuthority` 只保存 safe identifier（instanceId / status / exitCode / timestamps）；绝不存 PID secret / absolute path / token / credential / raw payload；它**不是**第二套 side-effect state machine。

## 门禁结果

| Gate | 结果 |
|---|---|
| `npm run test:d4-03c3-closure` | **63 / 63 PASS** |
| `npm run test:d4-03c3` | **56 / 56 PASS** |
| `npm run test:d4-03c2` / closure / closure2 / closure3 | 29 / 38 / 45 / 51 PASS |
| `npm run test:d4-03c1` / closure | 48 / 52 PASS |
| `npm run test:d4-03b` / `test:d4-03a` | 59 / 32 PASS |
| `npm run test:d4-02a / b / c` | 22 / 16 / 22 PASS |
| `npm run test:d4-01` | 59 / 59 PASS |
| `npm test` | **800 / 800 PASS** |
| `npm run build` | PASS |
| `npm run test:security` | FAIL 0 / PARTIAL 2 / PASS 6（无新增 FAIL / PARTIAL） |

## Remaining Gaps（继续挂账）

OS-level network sandbox = NOT VERIFIED；external workspace read audit = NOT VERIFIED；independent malformed ACP injection = NOT VERIFIED；Windows = NOT VERIFIED；External Provider = NOT VERIFIED；Explicit Resume = DEFERRED；Final Approval UI = NOT IMPLEMENTED；official dsh WRITE waiting/approval E2E = NOT VERIFIED；broader Domain verifiers = NOT VERIFIED。

## 最终口径

```
D4-03C3 Closure = PASS candidate
D4-03C overall = PARTIAL
D4-03C4 = NOT STARTED
```
