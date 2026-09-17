# D4-05 Closure-2 · 失败验证的解决关联修正（按操作对象 + 验证要求，而非裸 tool_id）

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`；分支：`feature/d4-03-tool-proxy`
- Base HEAD（本轮起点，干净）：`a2e2bf7cedad7b5abc02f8bbdb3add746aa89295`
- **代码与测试被测 commit**：`77b6e857f3d5a9781ea2c218e89069b1802aaab4`（仅 source + tests，4 files / +471 −11）
- **报告与证据提交**：本文件 + `docs/D4-05-RESULT.md`、`docs/D4-ACCEPTANCE-RESULT.md`、`PROGRESS.md`、`docs/D4-04/05/06-GATE-EVIDENCE.json`
- 范围：只修正上一轮 Closure `70eb0b1` 的“按 `tool_id` 最近一次验证结论判定解决”漏洞；不实施 memory 装配、不进入 D5/D6、不新增自动重试、不放宽权限/预算/UNKNOWN_EFFECT。
- **结论：漏洞已复现并修复；S1（A33）仍以正式 official dsh facade 链证据为准 = PASS**；`D4-05 = PARTIAL`、`D4 = PARTIAL` 不变（S4 记忆上下文缺口不变）；D4-06 通过范围不扩大。

## 1. 漏洞复现（正式链，未修复前）

正式 official dsh facade + 确定性 provider + 产品 orchestrator，test-only `test.sized`（`execute` 报告成功，`adapter.verify` 独立核对尺寸），同一工具、同一步：

| 调用 | 参数（canonical） | execution | arguments_hash |
| --- | --- | --- | --- |
| 1 | `{expectedSize:10,label:"A"}` | FAILED / verification_status=FAIL / TOOL_VERIFICATION_FAILED | `c5f4b68b…` |
| 2 | `{expectedSize:10,label:"B"}` | SUCCEEDED / verification_status=PASS | `36b5a953…` |

未修复前：`getUnresolvedRequiredVerificationFailures` 返回 `unresolved:[]`（对象 B 的无关 PASS 把对象 A 的 FAIL 误清除），orchestrator 提交 **Task SUCCEEDED + 1 Artifact**，同时对象 A 的 FAIL 仍未解决。根因：解决判定只按裸 `tool_id` 取“最近一次验证结论”。

## 2. 修复后的关联依据

关联键从 `tool_id` 改为 **`(tool_id, canonical arguments)`**，证据来自既有记录，不发明新契约：

- `tool_executions.proposal_id → task_tool_proposals.arguments_hash`（`fingerprint()` 的 canonical hash；**同一操作对象 + 同一验证要求**才同 hash）。
- 只处理 `verification_status ∈ {FAIL, PASS}` 的 execution；普通工具调用错误（`verification_status` 为空）不参与，保持既有语义。
- **顺序敏感**：同一键内 FAIL → 记 `lastFail` 并清空 `resolvedBy`；其后 PASS → 记 `resolvedBy`（`FAIL→PASS→FAIL` 最终仍未解决）。
- **无法可靠关联时保守**：`arguments_hash` 缺失/为空（旧数据）→ 以 `execution_id` 生成唯一键，任何其它 execution 的 PASS 都不可能匹配，保持未解决，不猜测、不凭“最近一次 PASS”自动清除。
- **可追溯**：返回 `{unresolved:[…], resolved:[{toolId,argsHash,failedExecutionId,resolvedByExecutionId,method}]}`；原始 FAIL `task_verifications` 与 FAIL execution **绝不删除/改写**。
- 稳定次序：`executionsOfTask` 仅加 `ORDER BY started_at, rowid`（同毫秒并列时以插入顺序为准；判定顺序敏感）。

**修复后**：对象 A 的 FAIL 仅能被“同 `tool_id` + 同 canonical arguments”的真实 PASS 解决；无关对象、无关验证要求、无关 Step 的 PASS 均不解除。

## 3. `verification_status=FAIL` ↔ 必需产物要求（支持范围）

- `verification_status=FAIL` 只由产品 `ControlledToolProxy.executeReadOnly` 在**工具 `execute` 报告成功之后**、`registry.validateOutput`（`OUTPUT_SCHEMA`）或 `adapter.verify`（`ADAPTER_VERIFY`）判失败时写入；DENY / 执行抛错 / 超时 / BLOCKED / NOT_EXECUTED **不会**写入。
- 因此本判定的语义是：**后端认为“该工具已产出的结果不满足其输出契约/验证要求”**——这正是 A33 的“工具报告成功但产物不符”。
- **支持范围（如实限定）**：产品当前**没有**区分“必需产物工具”与“探索性工具”的独立契约字段；本闸门对所有“报告成功但输出验证失败”的 READ_ONLY 调用按未解决处理，**并不**把探索性的 DENY/执行错误升级为完成条件（那些不参与判定）。若将来需要更细的必需/探索区分，应新增后端契约字段，超出本轮范围。
- 关联粒度是 (`tool_id`, canonical arguments)；产品不持久化 sub-check 身份，故“同一 tool + 完全相同 arguments”的后续真实 PASS 视为对该操作的完整复验。**验证要求不同（参数不同）的 PASS 不解除**。

## 4. 修改文件（被测 commit 77b6e85）

- `electron/task-service.cjs`：`getUnresolvedRequiredVerificationFailures` 关联键与顺序判定（唯一判定逻辑）。
- `electron/tool-store.cjs`：`executionsOfTask` 的 `ORDER BY started_at, rowid`（稳定次序）。
- `tests/d4-05-s1-facade-association.test.mjs`（新，6 项正式链关联测试）。
- `tests/d4-05-smoke.mjs`：新文件纳入 `NODE_FILES`。
- orchestrator 未改（只消费 `unresolved`）；未新增自动重试 / 恢复入口。

## 5. 检查结果（均在 `77b6e85`；干净工作区，首条 smoke / UI 探针 `workspaceState=""`）

| 命令 | 结果 | exit |
| --- | --- | --- |
| `node --test tests/d4-05-s1-facade-association.test.mjs` | **6 / 6 PASS**（正式 official dsh） | 0 |
| `node --test tests/d4-05-s1-facade-a33.test.mjs tests/d4-05-s1-output-size.test.mjs tests/d4-07-verification-persistence.test.mjs` | 19 / 19 PASS（含关联 6） | 0 |
| `npm run test:d4-03b-dsh` | 26 / 26 PASS | 0 |
| `npm run test:d4-05` | **139 / 139 functional**；S1/S2/S3=PASS、S4=PARTIAL；`workspaceState=""` | 0 |
| `npm run test:d4-08-verification-ui` | **22 / 22 PASS**（official dsh facade 正式链） | 0 |
| `npm run test:d4-04` | 94 / 94 PASS | 0 |
| `npm run test:d4-06` | 119 / 119 PASS | 0 |
| `npm run test:d4-06-resume` | 21 / 21 PASS | 0 |
| `npm test` | **969 / 969 PASS**（958 基线 + Closure-1 5 + 本轮关联 6） | 0 |

console / unhandled / secret hit = 0。

## 6. 验收对应（本轮要求）

| 要求 | 证据 |
| --- | --- |
| 无关对象 PASS 不掩盖 FAIL | 关联测试 1：A FAIL → B PASS → **BLOCKED / 0 Artifact**；`unresolved` 仍含 A，`resolved` 空 |
| 无关验证要求 PASS 不掩盖 FAIL | 关联测试 2：`expectedSize:10` FAIL → `expectedSize:7` PASS → **BLOCKED**（hash 不同） |
| 无关 Step 的 PASS 不掩盖 FAIL | 关联测试 3：step1 A FAIL（真实产品 proxy 产生）→ step2 无关 B 真实 official dsh PASS → **step2 也 BLOCKED**（旧逻辑会 SUCCEEDED） |
| 有效纠错 + 复验可正常成功 | 关联测试 4：同对象同要求 FAIL → 真实 PASS → SUCCEEDED；`resolved.failedExecutionId→resolvedByExecutionId` 可追溯，旧 FAIL 仍在 |
| DB 重开后一致性 | 关联测试 6：未解决仍 BLOCKED 且含 A；已解决 `resolved` 关系仍可查，原 FAIL Verification 仍在 |
| 普通工具错误不改语义 | 关联测试 5：`execute ok:false`（无验证结论）不参与判定 → Task 仍 SUCCEEDED |
| 拒绝假成功 / Electron 失败展示无回归 | `test:d4-08-verification-ui` 22/22（officialDshFacade=true、BLOCKED、0 Artifact、1 FAIL Verification、刷新一致、非 owner 不可读）；`test:d4-05` S1 全 PASS |
| 跨 run 纠错入口 | 产品**没有**可达的跨 run/跨 step 纠错入口（首个未解决 FAIL 即 BLOCK task）；未新增恢复能力。关联测试 3 的 step1 FAIL 因此用产品 proxy 直接产生并在注释/本报告中如实注明 |

**旧逻辑区分性**：临时将方法还原为裸 `tool_id` 逻辑后，关联测试 1/2/3/4/6 失败（B/size-7 的 PASS 会误清除 A/size-10 的 FAIL），仅测试 5 通过；随后还原，无临时改动入库。

## 7. 剩余限制

1. **S4 = PARTIAL 不变**（无 memory→任务上下文装配入口）→ `D4-05 = PARTIAL`、`D4 = PARTIAL` 维持；本轮不实施 memory 装配。
2. 产品未区分“必需/探索”工具契约；本闸门按第 §3 的限定范围解释 `verification_status=FAIL`。
3. 跨 run / 跨 step 的显式纠错入口不存在；本修复不移除该限制，也未新增恢复能力。
4. 重开测试沿用夹具同一可控时钟（注入时钟 session 相对真实 wall clock 过期属既有夹具事项，非本修复范围）。
5. 真实 `electron/main.cjs` 全流程 / 真实外部 provider / 真实凭据 / Windows / OS 级网络沙箱 = 继承 NOT VERIFIED，不扩大。
6. 未新增付费服务、未接真实外部 provider、未改默认 d3-02 工作区、未 push、未合并 main。
