# D4-03C2 · Controlled Reversible Write（第一条真实 production REVERSIBLE_WRITE）

- **状态**：**D4-03C2 = PASS candidate**、**D4-03C2 Closure = PASS candidate**（execution ownership mandatory + real duplicate claim contention + eligibility→claim TOCTOU，待 ChatGPT 审计）；**D4-03C overall = PARTIAL**；**D4-03C3 = NOT STARTED**（禁止自动进入）
- **Closure 详情**：见 `docs/D4-03C2-CLOSURE-RESULT.md`
- **分支**：feature/d4-03-tool-proxy
- **机器**：macOS arm64 Apple M3 Pro / Node v22.22.3
- **Schema**：保持 **v13**（现有字段已足够，未机械升版本）

## 唯一目标

建立第一条真实、受控、可验证、可逆的最小生产写入闭环：

```
Proposal → Decision → SideEffectPlan → Trusted User Approval → SideEffectLease
→ Execution Eligibility → Claim Execution → REAL REVERSIBLE DOMAIN WRITE
→ Verification → Lease Release → SideEffectCall SUCCEEDED
```

Domain mutation = exactly 1。不是 mock write / fixture-only mutation / 直接 SQL / adapter 自己改数据库。

## 第一条 production WRITE

| 项 | 值 |
|---|---|
| toolId / version | `resource.trash` / 1 |
| riskClass | REVERSIBLE_WRITE |
| effectClass | REVERSIBLE_WRITE |
| executionProvider | ResourceService |
| resourceActions | `resource.delete` |
| requiredPermissions | `tool.resource.trash` |
| verificationStrategy | READ_AFTER_WRITE |
| idempotencySupport | true |
| executionPolicy | **CONTROLLED_REVERSIBLE_WRITE** |
| inputSchema | 仅 `resourceRef`（additionalProperties=false） |

Harness 输入 `expectedVersion / approvalId / leaseId / callId / idempotencyKey / effectClass / expectedEffects / planHash / holderId` 一律被 schema 拒绝（TOOL_ARGUMENT_INVALID）或忽略。

## 真实 Domain 路径

```
SideEffectAuthority → allowlisted Tool Adapter (providers.ResourceService)
→ ResourceService.delete({ context, resourceRef, expectedVersion })
→ Resource Store / Authorization Domain
```

- SideEffectAuthority / adapter 都不直接 SQL，不直接改 resource_registry。
- Domain execution context（user / session / app / resourceRef）来自 SideEffectCall 绑定的真实 Task，不重新信任 Harness payload。
- `ResourceService` 仍是 Resource mutation 唯一业务 Domain。

## SideEffectPlan（只读）

`adapter.plan()` 只读真实 Resource Domain state，生成 targets / preconditions（resourceRef、expectedVersion、registryStatus）/ expectedEffects（trash=true）；mutation = 0；不存绝对路径 / raw content / credential / capability / session token。

## Approval / Lease / Eligibility

Approval 仅来自 trusted OpenArc user action，精确绑定 planHash/tool/version/argsHash/effectClass/expectedEffects，有限期。Lease 每 call 至多一个 ACTIVE，绑定 holderId + runtime instance id。两者独立，都必须实时 reauthorization。只有 ELIGIBLE 才可能 claim。

## Execution claim（exactly once）

`executeSideEffect` 先同步完成全部 gate，再在一个 `BEGIN IMMEDIATE` 事务内原子 claim `LEASED → RUNNING`。只有唯一 claim 成功的 executor 才能 dispatch Domain mutation；duplicate executor / duplicate execute call = 0 Domain invocation。`RUNNING` 是正式取得 execution ownership 的 dispatch boundary。

## 业务乐观并发（Lease ≠ business lock）

`ResourceService.delete({ expectedVersion })` 在**真实 mutation transaction 内**重新读取并校验：resource 存在、current version == expectedVersion、当前 active / not trashed。不匹配 → `VERSION_CONFLICT` → SideEffect Authority 映射为 `SIDE_EFFECT_PRECONDITION_CHANGED`，0 mutation / 0 retry。不存在 read → check → later write 的 TOCTOU。

## Verification（Execution != Verified Effect）

dispatch 后调用真实 Domain verifier（重新读取 Resource Domain，`trashed == true`，并校验 registry status）：

- verifier PASS → `RUNNING → SUCCEEDED`，`verificationStatus = PASS`，`completedAt`；
- Domain 明确 known no-effect / version conflict → `FAILED`（0 retry），lease RELEASED；
- exception / timeout / verifier unavailable / 无法判断 → `UNKNOWN_EFFECT`（≠FAILED，绝不 retry），lease REVOKED，Step/Task → BLOCKED（RECOVERY_REQUIRED）。

## Lease finalization

- 成功：RUNNING → verifier PASS → SUCCEEDED → lease RELEASED；
- known no-effect：FAILED → lease RELEASED；
- UNKNOWN_EFFECT：lease REVOKED，execution ownership 失效，call 保持 UNKNOWN_EFFECT，不可再次 dispatch。

## Reversibility evidence

真实 `ResourceService.restore()` 证明 trash 效果可恢复。restore proof ≠ AI 获得绕过 SideEffect Authority 的 production restore 权限；本阶段**不**开放 `resource.restore` Tool。

## 门禁覆盖

- **Negative E2E / Cancel-Revoke-Expiry-Stale（全部 0 mutation）**：No approval、Approval expired、Approval revoke、No lease、Wrong holder、Lease expire、Lease revoke、Wrong leaseId、Task cancel、Session revoke、App disable、Tool permission revoke、Resource permission revoke（USER grant, non-admin）、Tool disabled、Tool version change、Stale run、Plan/approval binding changed、Resource version/precondition changed。
- **Duplicate execute**：同一 callId/holder 两次 → 1 mutation；并发两 executor → 1 claimant / 1 mutation。
- **Unsupported effectClass**：IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED → EFFECT_CLASS_BLOCKED（0 call）。
- **Harness spoof**：`resource.trash` 上 spoof 字段 → TOOL_ARGUMENT_INVALID / 0 call / 0 mutation。
- **Crash boundary 不退化**：C2 有真实 execute path 后，RUNNING → restart 仍 UNKNOWN_EFFECT + Task/Step BLOCKED + 0 replay。
- **Secret scan**：side_effect_calls / tool_approvals / side_effect_leases / task_events / authorization_audit / tool DB / resource DB / C2 产物：Provider Secret 0、mpx_ 0、tpx_ 0、raw Authorization 0、credential 0、绝对路径 0、store root 0。

## Schema

保持 **SCHEMA_VERSION = 13**。`started_at / completed_at / verification_status / error_code` 已足够，未新增表 / 未升版本。SideEffectCall 仍是唯一 side-effect execution authority；未建第二套 authoritative execution state。

## 门禁结果

| Gate | 结果 |
|---|---|
| `npm run test:d4-03c2` | **29 / 29 PASS** |
| `npm run test:d4-03c2-closure` | **38 / 38 PASS** |
| `npm run test:d4-03c2-closure2` | **45 / 45 PASS** |
| `npm run test:d4-03c1` | 46 / 46 PASS |
| `npm run test:d4-03c1-closure` | 50 / 50 PASS |
| `npm run test:d4-03b` | 59 / 59 PASS |
| `npm run test:d4-03a` | 32 / 32 PASS |
| `npm run test:d4-02a / b / c` | 22 / 16 / 22 PASS |
| `npm run test:d4-01` | 59 / 59 PASS |
| `npm test` | **774 / 774 PASS** |
| `npm run build` | PASS |
| `npm run test:security` | FAIL 0 / PARTIAL 2 / PASS 6（无新增 FAIL / PARTIAL） |

## 允许范围（不扩大）

C2 只开放 `resource.trash` 一条 REVERSIBLE_WRITE。继续 BLOCKED：IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED / Shell / Terminal / filesystem generic mutation / MCP / Browser automation / Device Agent mutation / Canvas mutation / App Center mutation / Adobe control。

## Remaining Gaps（继续挂账）

OS-level network sandbox = NOT VERIFIED；external workspace read audit = NOT VERIFIED；independent malformed ACP injection = NOT VERIFIED；Windows = NOT VERIFIED；External Provider = NOT VERIFIED；Explicit Resume = DEFERRED；Final Approval UI = NOT IMPLEMENTED；official dsh WRITE waiting/approval E2E = NOT VERIFIED；broader real Domain verifiers = NOT VERIFIED。均不因 C2 PASS 关闭。

## 最终口径

```
D4-03C2 = PASS candidate
D4-03C overall = PARTIAL
D4-03C3 = NOT STARTED
```
