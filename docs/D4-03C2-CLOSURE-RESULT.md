# D4-03C2 Closure · Execution Ownership / Atomic Claim（macOS）

- **状态**：**D4-03C2 Closure = PASS candidate**（待 ChatGPT 审计）；**D4-03C2 = PASS candidate**；**D4-03C overall = PARTIAL**；**D4-03C3 = NOT STARTED**（禁止自动进入）
- **分支**：feature/d4-03-tool-proxy
- **Schema**：保持 **v13**（未新增字段 / 未升版本）
- **机器**：macOS arm64 Apple M3 Pro / Node v22.22.3

## 关闭的缺口

### A. holderInstanceId 成为真正 execution authority

永久规则：

```
ACTIVE Lease ownership = callId + leaseId + holderId + holderInstanceId
```

- production `executeSideEffect` 必须携带完整 trusted executor identity；缺少任一字段 → `SIDE_EFFECT_LEASE_NOT_HELD`（detail `EXECUTOR_IDENTITY_REQUIRED`）/ `mutationCount = 0`。
- 不存在 `if (holderInstanceId) { check }` 这种 optional authority；`lease.holderInstanceId === holderInstanceId` 是硬条件。
- `evaluateExecutionEligibility` 的 lease snapshot 新增 `holder_instance_id`，并接收 trusted `holderInstanceId`，同时校验 holder_id 与 holder_instance_id。
- Harness 无权提供这些字段（spoof → `TOOL_ARGUMENT_INVALID`）。

### B. 真实 duplicate claim contention

`tests/side-effect-c2-closure.test.mjs` + `tests/fixtures/harness-acp/claim-contender.mjs`：

- 两个独立 **child process**（独立 OS event loop / 独立 SQLite connection / 独立 Authority runtime），代表**同一个合法 executor identity**（同 callId / leaseId / holderId / holderInstanceId / instA）。
- barrier：两者 READY 后同一 tick GO；winner 在 claim 后停留 500ms（test-only `domainDelayMs`）再真正 mutation，使 duplicate invocation 有真实机会在 RUNNING 状态下争 `LEASED → RUNNING`。
- 结果：**claim success = 1**、**claim loser = 1（`SIDE_EFFECT_EXECUTION_CLAIM_LOST`）**、**Domain invocation = 1**、**business mutation = 1**、**SideEffectCall = 1**、final `SUCCEEDED` / `verificationStatus = PASS` / **ACTIVE lease = 0**。
- 其余稳定 fail-closed 路径（lease gate / precondition gate）也绝不第二次 dispatch Domain。
- 另加确定性用例：call 已 RUNNING 时同 identity 再 claim → `EXECUTION_CLAIM_LOST` + 0 mutation。

### C. Eligibility → Claim TOCTOU

- `#verifyAuthoritySnapshot` 在 claim 的 **BEGIN IMMEDIATE 事务内**重新读取并实时 reauthorization：Task RUNNING/未 cancel、Step RUNNING、run 仍 current、session/auth 有效、app enabled、tool permission + resource permission/useByAgent 有效、Approval 有效（decision/planHash/argsHash/expiry/revoke）、Lease ACTIVE + holder/instance 匹配 + 未过期、precondition/version 未变。
- 任一失败 → claim 拒绝 / 0 Domain invocation。`Eligibility snapshot != execution authority forever`。
- 未建第二套权限系统 / Task authority / execution state；SideEffectCall 仍是唯一 side-effect execution authority。
- test-only seam `testHooks.afterEligibilityBeforeClaim`（constructor 注入，默认 null，Renderer/Harness 不可控）稳定制造 `Eligibility 后 → claim 前` 的真实 race。

真实 race gate（每条都先证明 race 前真实 `ELIGIBLE`，hook 真实触发）：

| Race | 结果 |
|---|---|
| Task cancel | claim denied / 0 mutation（TASK_CANCELLED） |
| tool permission revoke | claim denied / 0 mutation（AUTHORIZATION_REVOKED） |
| latest run changes | claim denied / 0 mutation（STALE_RUN） |
| approval revoke | claim denied / 0 mutation（APPROVAL_REVOKED） |
| lease revoke | claim denied / 0 mutation（LEASE_REQUIRED） |

### D. Restart ownership regression

Runtime A（holderId `exec_1` / instance `instA`）→ Runtime B（`instB`）：
- 旧 ACTIVE lease → `EXPIRED`；
- 无论用 `instA` 还是 `instB` 身份，均不能继承旧 execution authority，`0 mutation`；
- Runtime A 仍持有 ACTIVE instA lease 时，`instB` 身份同样 0 mutation。

## 保持不变的 C2 主体

resource.trash production contract、REVERSIBLE_WRITE only、Proposal→Decision→Plan→Approval→Lease→Eligibility、真实 ResourceService.delete、业务 expectedVersion 乐观并发（mutation transaction 内 re-read）、read-after-write verification、SUCCEEDED → lease RELEASED、UNKNOWN_EFFECT → lease REVOKED + Task/Step BLOCKED、unsupported effect class BLOCKED、Harness spoof BLOCKED、C1 recovery semantics 全部保留。

## WRITE exposure boundary

本轮仍只有 `resource.trash` 可真实执行。`test.write` = `WRITE_EXECUTION_DISABLED`；IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED / MCP / Shell / Browser mutation / Canvas mutation / App Center mutation / Adobe control = 0。

## 门禁结果

| Gate | 结果 |
|---|---|
| `npm run test:d4-03c2` | **29 / 29 PASS** |
| `npm run test:d4-03c2-closure` | **39 / 39 PASS** |
| `npm run test:d4-03c1` | 46 / 46 PASS |
| `npm run test:d4-03c1-closure` | 50 / 50 PASS |
| `npm run test:d4-03b` / `test:d4-03a` | 59 / 59；32 / 32 PASS |
| `npm run test:d4-02a / b / c` | 22 / 16 / 22 PASS |
| `npm run test:d4-01` | 59 / 59 PASS |
| `npm test` | **762 / 762 PASS** |
| `npm run build` | PASS |
| `npm run test:security` | FAIL 0 / PARTIAL 2 / PASS 6（无新增 FAIL / PARTIAL） |

## Remaining Gaps（继续挂账，不因本轮关闭）

OS-level network sandbox = NOT VERIFIED；external workspace read audit = NOT VERIFIED；independent malformed ACP injection = NOT VERIFIED；Windows = NOT VERIFIED；External Provider = NOT VERIFIED；Explicit Resume = DEFERRED；Final Approval UI = NOT IMPLEMENTED；official dsh WRITE waiting/approval E2E = NOT VERIFIED；broader real Domain verifiers = NOT VERIFIED。

## 最终口径

```
D4-03C2 Closure = PASS candidate
D4-03C overall = PARTIAL
D4-03C3 = NOT STARTED
```
