# D4-03C3 · Ambiguous Result / Idempotency / Crash Recovery（macOS）

- **状态**：**D4-03C3 = PASS candidate**（待 ChatGPT 审计）；**D4-03C = PARTIAL**；**D4-03C4 = NOT STARTED**（禁止自动进入）
- **分支**：feature/d4-03-tool-proxy
- **Schema**：**v14**（新增 non-authoritative `recovery_safe`，含 migration + 整级回滚测试）
- **机器**：macOS arm64 Apple M3 Pro / Node v22.22.3

## 核心承诺

```
RUNNING → ambiguous / crash / timeout → UNKNOWN_EFFECT → read-only verification
        → APPLIED / NOT_APPLIED / INDETERMINATE
UNKNOWN_EFFECT → VERIFY → BLOCK     （绝不 UNKNOWN_EFFECT → RETRY）
AUTO_RETRY = 0
```

## UNKNOWN_EFFECT Verification Contract

`verifyUnknownEffect()` 升级为真实 production path（**删除 test-only `unknownEffectVerifier`**）：

```
SideEffectCall
→ exact historical Tool Contract（toolId + toolVersion + effectClass，非 latest version）
→ allowlisted adapter（executionProvider 静态 allowlist）
→ read-only Domain verifier（mutation = 0）
```

- 只读：绝不 `execute / retry / restore / delete / repair / create lease / create approval`。
- 不受当前 session / app / tool disabled 影响：disabled tool 仍可 recovery-verify（execution authority 与 recovery verification authority 分离）。
- exact historical version 不存在 → `SIDE_EFFECT_VERIFICATION_NOT_AVAILABLE`，保持 UNKNOWN_EFFECT。

## Verification Outcome Model（三态）

| outcome | 含义 | 收敛 |
|---|---|---|
| **APPLIED** | 有足够证据证明目标 effect 已存在 | `UNKNOWN_EFFECT → SUCCEEDED`，verificationStatus = PASS |
| **NOT_APPLIED** | 证明 effect 没发生，**且** execution 已确定不可能晚到 | `→ FAILED`，verificationStatus = FAIL（仅 quiesced = true 时） |
| **INDETERMINATE** | 无法可靠判断 | 保持 `UNKNOWN_EFFECT` |

## resource.trash Recovery Verifier

按历史 `preconditions`（resourceRef / expectedVersion）只读重读真实 Resource Domain：

- `trashed = true` 且 `registryStatus = deleted` → **APPLIED**；
- `trashed = true` 但 registry status 矛盾 → **INDETERMINATE**；
- `trashed = false` 且 `registryStatus = active` 且 `version == expectedVersion` → **NOT_APPLIED**；
- resource missing / version changed / state 异常 / read failed → **INDETERMINATE**。

## Execution Quiescence Authority

- **live timeout / ambiguous**：`recovery_safe.quiesced = false`（底层 async operation 可能 late-arrive）→ 即使 verifier 看到 NOT_APPLIED 也保持 UNKNOWN_EFFECT。
- **cold restart**（旧 runtime 已死 + 新 runtime 启动 + 旧 lease 已失效）：`recovery_safe.quiesced = true`。仅此情况允许 NOT_APPLIED → FAILED。
- quiescence 只能来自 OpenArc trusted evidence，不能由 Harness / caller / tool args / model / Renderer 提供。

## Late Applied Result / Crash Matrix（真实 disk-backed + child process）

| 场景 | 结果 |
|---|---|
| live timeout → mutation 晚到 | UNKNOWN_EFFECT(quiesced=false) → 早期 NOT_APPLIED 不收敛 → APPLIED → SUCCEEDED，delete = 1 |
| 早期 NOT_APPLIED while operation live | 保持 UNKNOWN_EFFECT（不提前 FAILED） |
| crash before dispatch | restart → UNKNOWN_EFFECT → NOT_APPLIED + quiesced → FAILED，0 mutation |
| crash after real mutation | restart → UNKNOWN_EFFECT → APPLIED → SUCCEEDED，delete total = 1（**C3 关键 E2E**） |
| crash after verification before persist | APPLIED → SUCCEEDED，无第二次 mutation |
| crash after SUCCEEDED before lease release | Call 保持 SUCCEEDED，旧 lease EXPIRED，不重试 |
| INDETERMINATE（并发 Domain 改动） | 保持 UNKNOWN_EFFECT |
| concurrent verification | 单一 authoritative terminal transition，另一方 duplicate |

## Idempotency / Authority

- 同一 SideEffectCall 跨 restart：`callId` / `idempotencyKey` 不变；不创建第二个 call / approval / lease / execution。
- UNKNOWN_EFFECT 不能 `acquireLease` / `executeSideEffect`（0 mutation）。
- recovery 收敛后 Task / Step **保持 BLOCKED**（Explicit Resume = DEFERRED，禁止自动 resume / restart / rerun）。
- `SideEffectCall` 仍是唯一 authoritative execution state；`recovery_safe` 明确 non-authoritative。

## WRITE Boundary / AUTO_RETRY

仍只有 `resource.trash` 可真实执行；`test.write` = `WRITE_EXECUTION_DISABLED`；IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED / Shell / MCP / Browser / Device Agent / Canvas / App Center / Adobe = 0。`AUTO_RETRY = 0`（不因 CLAIM_LOST / LEASE_CONFLICT / UNKNOWN_EFFECT / verifier 当前 NOT_APPLIED 而 retry）。

## 门禁结果

| Gate | 结果 |
|---|---|
| `npm run test:d4-03c3` | **56 / 56 PASS** |
| `npm run test:d4-03c2` / closure / closure2 / closure3 | 29 / 38 / 45 / 51 PASS |
| `npm run test:d4-03c1` / closure | 48 / 52 PASS |
| `npm run test:d4-03b` / `test:d4-03a` | 59 / 32 PASS |
| `npm run test:d4-02a / b / c` | 22 / 16 / 22 PASS |
| `npm run test:d4-01` | 59 / 59 PASS |
| `npm test` | **793 / 793 PASS** |
| `npm run build` | PASS |
| `npm run test:security` | FAIL 0 / PARTIAL 2 / PASS 6（无新增 FAIL / PARTIAL） |

## Schema / Migration

v14：`ALTER TABLE side_effect_calls ADD COLUMN recovery_safe TEXT`。测试覆盖 v12→current、v13→v14、以及 v12/v14 migration failure 整级回滚（user_version 停在上一个版本、结构不残留）。

## Secret Scan

SideEffectCall / ToolApproval / SideEffectLease / TaskEvent / Authorization Audit / Tool DB / Resource DB / verification evidence / recovery evidence / C3 artifacts：Provider Secret 0、`mpx_` 0、`tpx_` 0、raw Authorization 0、credential 0、受保护绝对路径 0、store root 0。

## Remaining Gaps（继续挂账）

OS-level network sandbox = NOT VERIFIED；external workspace read audit = NOT VERIFIED；independent malformed ACP injection = NOT VERIFIED；Windows = NOT VERIFIED；External Provider = NOT VERIFIED；Explicit Resume = DEFERRED；Final Approval UI = NOT IMPLEMENTED；official dsh WRITE waiting/approval E2E = NOT VERIFIED；broader Domain verifiers = NOT VERIFIED。

## 最终口径

```
D4-03C3 = PASS candidate
D4-03C overall = PARTIAL
D4-03C4 = NOT STARTED
```
