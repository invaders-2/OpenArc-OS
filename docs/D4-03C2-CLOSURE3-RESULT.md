# D4-03C2 Closure-3 · Runtime Identity Final Seal（macOS）

- **状态**：**D4-03C2 Closure-3 = PASS candidate**（待 ChatGPT 审计）；**D4-03C2 = PASS candidate**；**D4-03C overall = PARTIAL**；**D4-03C3 = NOT STARTED**（禁止自动进入）
- **分支**：feature/d4-03-tool-proxy
- **Schema**：保持 **v13**
- **机器**：macOS arm64 Apple M3 Pro / Node v22.22.3

## 永久规则

```
Runtime Identity = SideEffectAuthority.instanceId
```

production caller 不得 declare / override / spoof / choose runtime identity，覆盖：Lease acquire、Execution eligibility、Execution claim、Startup recovery、Lease recovery。

## 关闭的两个 escape hatch

### A. `acquireLease` 不再有 runtime override

- 删除 `_testInstanceId` 参数；lease 永远 `holderInstanceId = this.instanceId`。
- 需要"另一个 runtime instance 拥有 lease"的测试，必须按 §5 创建 `new SideEffectAuthority({ instanceId })`，不新增 `instanceIdOverride / runtimeIdOverride` 之类 production 参数。
- **duplicate 语义修正**：`holderId === holderId **AND** holderInstanceId === this.instanceId` 才是 duplicate；**同 holderId 不同 runtime instance → `SIDE_EFFECT_LEASE_CONFLICT`**（不再返回 `duplicate:true`）。

### B. `recoverOnStartup` 不再接受 caller `instanceId`

- 签名等价 `recoverOnStartup()`；内部 `instanceId = this.instanceId`，不接受 caller override。
- 每个 ACTIVE lease：`holderInstanceId === this.instanceId` 才保留；其它 instance 一律 `EXPIRED`。真实 process restart 必然是新 runtime → 旧 lease 必 EXPIRED。

同时收紧：Authority `evaluateExecutionEligibility({ callId, leaseId, holderId })` 不再让 caller 决定 `holderInstanceId`，runtime identity 由 Authority 注入（`this.instanceId`）；底层纯函数 `side-effect-domain.evaluateExecutionEligibility(snapshot)` 仍接收 `holder_instance_id`（纯 snapshot evaluator）。

## Mandatory 测试覆盖

| 项 | 结果 |
|---|---|
| production `acquireLease` 无 runtime override（caller `instanceId` 被忽略） | PASS |
| same holder + same runtime acquire → duplicate，无第二个 ACTIVE lease | PASS |
| same holder + different runtime acquire → `LEASE_CONFLICT`，Lease A 不变，0 execution | PASS |
| production `recoverOnStartup` 无 runtime override（caller `instanceId` 被忽略） | PASS |
| Runtime B restart → 旧 instA ACTIVE lease EXPIRED | PASS |
| caller 知道 `instA` 字符串 → 仍无法保留/继承旧 lease（disk-backed） | PASS |
| Authority eligibility runtime identity = `this.instanceId`（自报 holderInstanceId 无效） | PASS |
| execute exact lease authority regression | PASS |
| lease replacement regression | PASS |
| same-runtime duplicate execution regression | PASS |
| `AUTO_RETRY = 0` / WRITE 面无扩展 | PASS |

## 保持不变的 C2 主体

resource.trash real REVERSIBLE_WRITE、ResourceService.delete real Domain mutation、SideEffectPlan、Trusted User Approval、Lease persistence、business expectedVersion concurrency、real verification、SUCCEEDED → lease RELEASED、UNKNOWN_EFFECT → lease REVOKED + Task/Step BLOCKED、AUTO_RETRY = 0、unsupported write class BLOCKED、Harness spoof BLOCKED、C1 crash/restart semantics、Closure/Closure-2 全部 race 与 claim 用例。

## WRITE exposure boundary

仍只有 `resource.trash` 可真实执行；`test.write` = `WRITE_EXECUTION_DISABLED`；IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED / Shell / MCP / Browser / Device Agent / Canvas / App Center / Adobe = 0。本轮禁止 `retry after CLAIM_LOST / LEASE_CONFLICT / UNKNOWN_EFFECT`。

## 门禁结果

| Gate | 结果 |
|---|---|
| `npm run test:d4-03c2` | **29 / 29 PASS** |
| `npm run test:d4-03c2-closure` | **38 / 38 PASS** |
| `npm run test:d4-03c2-closure2` | **45 / 45 PASS** |
| `npm run test:d4-03c2-closure3` | **51 / 51 PASS** |
| `npm run test:d4-03c1` / `test:d4-03c1-closure` | 46 / 46；50 / 50 PASS |
| `npm run test:d4-03b` / `test:d4-03a` | 59 / 59；32 / 32 PASS |
| `npm run test:d4-02a / b / c` | 22 / 16 / 22 PASS |
| `npm run test:d4-01` | 59 / 59 PASS |
| `npm test` | **774 / 774 PASS** |
| `npm run build` | PASS |
| `npm run test:security` | FAIL 0 / PARTIAL 2 / PASS 6（无新增 FAIL / PARTIAL） |

## Secret Scan

SideEffectCall / ToolApproval / SideEffectLease / TaskEvent / Authorization Audit / Tool DB / Resource DB / C2 产物：Provider Secret 0、`mpx_` 0、`tpx_` 0、raw Authorization 0、credential 0、受保护绝对路径 0、store root 0。

## Remaining Gaps（继续挂账）

OS-level network sandbox = NOT VERIFIED；external workspace read audit = NOT VERIFIED；independent malformed ACP injection = NOT VERIFIED；Windows = NOT VERIFIED；External Provider = NOT VERIFIED；Explicit Resume = DEFERRED；Final Approval UI = NOT IMPLEMENTED；official dsh WRITE waiting/approval E2E = NOT VERIFIED；broader real Domain verifiers = NOT VERIFIED。

## 最终口径

```
D4-03C2 Closure-3 = PASS candidate
D4-03C overall = PARTIAL
D4-03C3 = NOT STARTED
```
