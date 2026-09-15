# D4-03C2 Closure-2 · Runtime Instance Authority + Exact Lease Binding（macOS）

- **状态**：**D4-03C2 Closure-2 = PASS candidate**（待 ChatGPT 审计）；**D4-03C2 = PASS candidate**；**D4-03C overall = PARTIAL**；**D4-03C3 = NOT STARTED**（禁止自动进入）
- **分支**：feature/d4-03-tool-proxy
- **Schema**：保持 **v13**
- **机器**：macOS arm64 Apple M3 Pro / Node v22.22.3

## 关闭的两个 blocker

### A. Runtime instance 是 OpenArc 自身事实（caller 不能自报）

- `ACTIVE Lease ownership = callId + exact leaseId + holderId + runtime instance (SideEffectAuthority.instanceId)`。
- production `executeSideEffect({ callId, leaseId, holderId })` **不再接受** `holderInstanceId`；即使调用方传入也被**完全忽略**。判断一律为 `lease.holderInstanceId === this.instanceId`，不存在 `if (holderInstanceId) { check }` 的 optional authority。
- `acquireLease` 同样把 lease 绑定到 `this.instanceId`；只有明确的 test-only seam `_testInstanceId` 可覆盖，不进入 production API。
- 跨进程 Runtime B 即使知道 `instA` 字符串并自报 `holderInstanceId="instA"`，也一律 DENY / 0 Domain invocation。

### B. exact leaseId 必须在同一个原子 claim transaction 内重新验证

- `evaluateExecutionEligibility` 的 lease snapshot 带 `lease_id + call_id + holder_id + holder_instance_id + expires_at`，校验 exact leaseId + holder + runtime instance。
- claim 的 `#verifyAuthoritySnapshot` 接收 `expectedLeaseId` 与 `runtimeInstanceId = this.instanceId`，在**同一个 BEGIN IMMEDIATE 事务内**重新验证：`leaseId + callId + holderId + holderInstanceId + ACTIVE + 未过期`。
- **lease replacement race**：同一 holderId / 同一 runtime 下，`lease_A` revoke + `lease_B` acquire 后，携带 `lease_A` 的旧 invocation 一律 `SIDE_EFFECT_LEASE_NOT_HELD`；只有携带 `lease_B` 并重新通过完整 gate 的全新 invocation 才可执行。
- **claim-time approval binding 不得比 Eligibility 更弱**：planHash / argumentsHash / toolId / toolVersion / effectClass / decision / expiry / revoke 全部精确匹配。

## 语义修正（§9）

原 Closure 的「两个 child 共享 holderInstanceId=instA」跨进程用例被判定为**无效证据**（两个 OS 进程本质是两个 runtime instance，不得共享一个 runtime identity），已移除。正确的 exactly-once 证据改为：

- **same-runtime duplicate delivery**：同一个 `SideEffectAuthority` / 同一个 `this.instanceId` 的两次重复 invocation 快速竞争 `LEASED → RUNNING` → 1 claim winner / 1 `SIDE_EFFECT_EXECUTION_CLAIM_LOST` / 1 Domain invocation / 1 mutation。
- **cross-runtime non-owner**：Runtime B 永不进入 claim（0 Domain invocation）。

## Mandatory 测试覆盖

| 项 | 结果 |
|---|---|
| execute API 不能自报 holderInstanceId（传入被忽略，authority 用 runtime 自身 identity） | PASS |
| Runtime B 不能伪装 Runtime A（in-process + cross-process，知道 instA 也 DENY） | PASS |
| missing leaseId / wrong leaseId → 0 mutation | PASS |
| lease replacement race：旧 lease_A invocation DENY | PASS |
| fresh lease_B invocation 重新通过完整 gate 后执行 | PASS |
| same-runtime duplicate delivery：1 claim / 1 Domain invocation / 1 mutation | PASS |
| cross-runtime non-owner：不到 claim / 0 mutation | PASS |
| claim-time approval exact binding（篡改 toolId → PLAN_STALE） | PASS |

## 保持不变的 C2 主体

resource.trash real REVERSIBLE_WRITE、ResourceService.delete real Domain mutation、SideEffectPlan、Trusted User Approval、Lease persistence、business expectedVersion concurrency、real verification、SUCCEEDED → lease RELEASED、UNKNOWN_EFFECT → lease REVOKED + Task/Step BLOCKED、AUTO_RETRY = 0、unsupported write class BLOCKED、Harness spoof BLOCKED、C1 crash/restart semantics、Closure 的 Task cancel / permission revoke / run change / approval revoke / lease revoke eligibility→claim race 全部保留。

## WRITE exposure boundary

仍只有 `resource.trash` 可真实执行；`test.write` = `WRITE_EXECUTION_DISABLED`；IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED / Shell / MCP / Browser / Device Agent / Canvas / App Center / Adobe = 0。

## 门禁结果

| Gate | 结果 |
|---|---|
| `npm run test:d4-03c2` | **29 / 29 PASS** |
| `npm run test:d4-03c2-closure` | **38 / 38 PASS** |
| `npm run test:d4-03c2-closure2` | **45 / 45 PASS** |
| `npm run test:d4-03c1` / `test:d4-03c1-closure` | 46 / 46；50 / 50 PASS |
| `npm run test:d4-03b` / `test:d4-03a` | 59 / 59；32 / 32 PASS |
| `npm run test:d4-02a / b / c` | 22 / 16 / 22 PASS |
| `npm run test:d4-01` | 59 / 59 PASS |
| `npm test` | **768 / 768 PASS** |
| `npm run build` | PASS |
| `npm run test:security` | FAIL 0 / PARTIAL 2 / PASS 6（无新增 FAIL / PARTIAL） |

## Secret Scan

SideEffectCall / ToolApproval / SideEffectLease / TaskEvent / Authorization Audit / Tool DB / Resource DB / C2 产物：Provider Secret 0、`mpx_` 0、`tpx_` 0、raw Authorization 0、credential 0、受保护绝对路径 0、store root 0。

## Remaining Gaps（继续挂账）

OS-level network sandbox = NOT VERIFIED；external workspace read audit = NOT VERIFIED；independent malformed ACP injection = NOT VERIFIED；Windows = NOT VERIFIED；External Provider = NOT VERIFIED；Explicit Resume = DEFERRED；Final Approval UI = NOT IMPLEMENTED；official dsh WRITE waiting/approval E2E = NOT VERIFIED；broader real Domain verifiers = NOT VERIFIED。

## 最终口径

```
D4-03C2 Closure-2 = PASS candidate
D4-03C overall = PARTIAL
D4-03C3 = NOT STARTED
```
