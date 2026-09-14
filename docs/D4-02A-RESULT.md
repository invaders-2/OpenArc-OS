# D4-02A Result

Task Status: **D4-02A Task Domain / Persistent Authority = PASS**（macOS）；**D4-02 overall = PARTIAL**（D4-02B ACP Harness Adapter = NOT STARTED）；**D4-03 Controlled Tool Proxy = BLOCK**。本轮只建立 OpenArc Task Runtime 的权威数据模型，**未接 Harness / ACP / Tool / MCP**。

## 1. Base
branch `feature/d4-02-task-harness`，从 `feature/d4-01-model-service` @ `5afece6` 创建；未 merge main。起点 working tree clean，HEAD == origin/feature/d4-01-model-service == `5afece6`。

## 2. Task Schema
Schema 升到 **v9**，新增 4 张表 + 索引：
- `tasks(task_id PK, user_id, session_ref, app_id, status CHECK, goal, created_at, updated_at, started_at, completed_at, model_config_id, model_config_version, current_step_id, revision, cancel_requested, budget_snapshot, permission_snapshot_ref)`；索引 `(user_id,status)`、`(app_id)`。
- `task_steps(step_id PK, task_id FK→tasks CASCADE, sequence, kind, status CHECK, input, output_ref, started_at, completed_at, attempt, max_attempts, UNIQUE(task_id,sequence))`。
- `task_model_calls(call_id PK, task_id FK, step_id, model_config_id, model_config_version, request_id, status CHECK, started_at, completed_at, usage, provider_error_code)`。
- `task_events(event_id PK, task_id FK, sequence, event_type, created_at, safe_payload, UNIQUE(task_id,sequence))`。
**禁止** `task_acl` / `task_role` / `task_permissions`（无第二套权限系统，复用 D3）。**禁止** raw provider key / proxy bearer / Authorization header 入库；prompt/response 不默认落库（只存 safe structured state）。

## 3. Task State Machine
显式 transition table：`PENDING → RUNNING|CANCELLED|BLOCKED`；`RUNNING → WAITING|SUCCEEDED|FAILED|CANCELLED|BLOCKED`；`WAITING → RUNNING|CANCELLED|BLOCKED`；`BLOCKED → RUNNING|CANCELLED`；`SUCCEEDED/FAILED/CANCELLED` 终态不可变。`SUCCEEDED→RUNNING`、`FAILED→SUCCEEDED`、`CANCELLED→RUNNING` 全部 DENY（真实测试）。

## 4. Step State Machine
`PENDING → RUNNING|CANCELLED|BLOCKED`；`RUNNING → SUCCEEDED|FAILED|CANCELLED|BLOCKED`；`BLOCKED → RUNNING|CANCELLED`。`attempt=1`、`maxAttempts=1`。

## 5. Model Snapshot
`createTask` 冻结 `modelConfigId + modelConfigVersion`（若提供 modelService 则由真实 resolve 得到当前 version）。`startModelCall` 时重新 authorize + 重新检查 model/provider status。真实测试：snapshot=v1 → config 升 v2 → `startModelCall` 返回 **MODEL_CONFIG_CHANGED**（`expected=1 / current=2`），**不静默升级**、不留下 call、不 bump revision。

## 6. Revision / Concurrency
每次 mutation `revision++`；所有 mutation 必须带 `expectedRevision`。真实测试：两个并发/replay mutation 只有一个成功，另一个返回 **TASK_REVISION_CONFLICT** 且无副作用；缺 `expectedRevision` → `INVALID_INPUT`（无 silent last-write-wins）。step / model call mutation 同样 bump task revision。

## 7. Task Events
append-only event stream；每个 task 的 `sequence` 严格递增（1,2,3…），DB 层有 `UNIQUE(task_id, sequence)` 兜底。真实测试断言 state 与 event 一一对应、非法 transition 不产生 event、事件序列连续。event payload 走敏感 key 打码 + 长度截断。

## 8. Authorization
所有 command 的 actor 由 **D3 `AuthorizationService.resolveActor`** 从可信 `context.sessionRef` 解析；App 必须 enabled；忽略 payload 自报 `userId/role/appId`。不可信 session / 缺 session / disabled App 一律 `TASK_FORBIDDEN`（真实测试）。

## 9. User Isolation
User A 创建 Task；User B 对 `getTask / startTask / cancelTask / getEvents / listTasks` 全部 **DENY**（`TASK_FORBIDDEN` / list 不含 A 的 Task）。

## 10. App Isolation
同一 User 用 App B（canvas）访问 App A（ai）创建的 Task：get/start/list 全部 DENY；App B 的 list 不含该 Task。

## 11. Cancel Persistence
`cancelTask` 写持久 `cancelRequested=1` + `CANCELLED`，并落 `task.cancel_requested` + `task.cancelled` 两个 event；重复 cancel 幂等（`changed:false`，不再 bump revision）。跨进程重启后 `CANCELLED / cancelRequested / revision / events` 全部恢复（真实 file DB 重启测试）。

## 12. Retry Policy
**AUTO_RETRY = 0**；`attempt=1`、`maxAttempts=1` 冻结。model failure 只落一条 `FAILED` call，**不得自动创建第二条**（真实测试断言 call 数不变）；timeout / disconnect 同样不自动重试。

## 13. Tool Boundary
`TOOL_EXECUTION = FORBIDDEN`；D4-02A 无 side effect execution、无 tool 调用、无 MCP。production tool execution = 0。

## 14. Restart Persistence
真实 SQLite 文件库：create → start → createStep → startStep → 关闭进程 → 重开。task 状态 / step / revision / events 序列 / model snapshot / currentStepId 全部恢复。cancel 场景同样跨重启恢复。

## 15. Recovery Semantics
重启前 `RUNNING` 的 Task + `RUNNING` 的 Step：启动 recovery 一律转 `BLOCKED` + `RECOVERY_REQUIRED`，并落 `task.recovery_blocked`（RUNNING step 另落 `step.recovery_blocked`）。**0 自动 replay / 0 retry**（call 数不变）；recovery 幂等；`BLOCKED` 下 `startModelCall` → `TASK_INVALID_STATE`，只有显式 resume（`BLOCKED→RUNNING`）才能继续。task RUNNING 但 step 已 SUCCEEDED 时只 block task，不动已完成 step。ADR 冻结 `UNKNOWN EFFECT → VERIFY / BLOCK`。

## 16. Migration
`SCHEMA_VERSION = 9`，只加 Task Runtime 表。迁移套件 **18 / 18 PASS**：`v1→current`、`v2→current`、`v3→current`、`v4→current`、`v5→current`、`v8→current` 与 v9 级失败整级回滚（`user_version` 保持 8、task 表不残留）。既有 migration 测试的"手工降级"表清单已同步加入 v9 表。

## 17. Performance
Smoke baseline（**MEASURED ON TEST MACHINE · NOT PRODUCT SLA**，macOS arm64 / Node v22.22.3）：create 100 tasks ≈ **27.1ms**；append 1000 events（单事务）≈ **18.5ms**；load 1 task ≈ **0.113ms**；list 100 user tasks ≈ **0.367ms**。只作 smoke，不是 SLA。

## 18. D4-01 Regression
`npm run test:d4-01` **59 / 59 PASS**；`npm test` **544 / 544 PASS**（D4-01 522 + D4-02A 22）；`npm run build` **PASS**；迁移 18/18。D4-02A 未破坏 D4-01。

## 19. Security
`npm run test:security`（D1-05）：**FAIL 0 / PARTIAL 2 / PASS 6**（与既有基线一致）；security-surface（D2-02 A13）**15 / 15 PASS**。Task DB 不含 raw secret / Authorization（真实断言）；未新增任何 secret 通道。

## 20. Tests
新增：`tests/task-fixtures.mjs`、`tests/task-domain.test.mjs`（15）、`tests/task-store.test.mjs`（5，含 restart / cancel 持久 / model snapshot / perf smoke / v8→v9 migration+rollback）、`tests/task-recovery.test.mjs`（2）；新增标准入口 `experiments/d4-02a/run-all.mjs` + `npm run test:d4-02a`（**22 / 22 PASS**）。更新 `tests/migration.test.mjs`、`tests/device-migration.test.mjs`、`tests/resource-migration.test.mjs`、`tests/resource-library-migration.test.mjs`、`tests/resource-index-migration.test.mjs` 到 v9。

## 21. Files Changed
产品：`electron/identity-store.cjs`（schema v9）、`electron/task-domain.cjs`、`electron/task-store.cjs`、`electron/task-service.cjs`、`electron/task-bootstrap.cjs`、`electron/identity-bootstrap.cjs`（接线）。
测试/入口：`tests/task-*.mjs`、5 个 migration 测试、`experiments/d4-02a/run-all.mjs`、`package.json`。
文档：`docs/decisions/D4-02-task-authority.md`、`docs/D4-02A-RESULT.md`、`PROGRESS.md`。

## 22. Commits
（本轮）`D4-02: add persistent task authority`、`test(D4-02): verify task state recovery and isolation`、`docs(D4-02): record task authority contract`。

## 23. Evidence
| 入口 | 结果 |
| --- | --- |
| npm run test:d4-02a | **22 / 22 PASS** |
| test:d4-01 | **59 / 59 PASS** |
| npm test | **544 / 544 PASS** |
| migration（含 v8→v9 + rollback） | **18 / 18 PASS** |
| npm run build | PASS |
| test:security（D1-05） | FAIL 0 / PARTIAL 2 / PASS 6 |
| security-surface（D2-02 A13） | 15 / 15 PASS |
| perf smoke | create100 ≈27.1ms / append1000 ≈18.5ms / load ≈0.113ms / list100 ≈0.367ms |
| Task persistent authority / state machine / revision concurrency / events / user+app isolation / restart recovery / cancel persistence / model snapshot / config change rejection | **PASS** |
| AUTO_RETRY | **0** |
| production tool execution | **0** |

## 24. Remaining Gaps
D4-02B ACP Harness Adapter（NOT STARTED）：Harness 只经 Model Proxy、只拿 scoped capability + safe snapshot；不拥有 persistent queue/state/retry/tool/lease/permission authority。D4-02A 未接 Renderer UI / IPC（本阶段规则明确不做）。Windows 仍未验证（继承 D4-01 cross-platform PARTIAL）。

## 25. D4-02B Admission
**D4-02B ACP Harness Adapter = 下一阶段 CONDITIONAL GO**（D4-02A 已建立持久权威）。冻结条件：ACP ONLY；`HARNESS_RAW_PROVIDER_KEY = FORBIDDEN`；Harness 只与 OpenArc Model Proxy 通信；只接收 Proxy endpoint + scoped capability + safe model snapshot；不拥有 persistent task queue / persistent task state / step authority / retry authority / tool execution authority / lease authority / permission authority。**D4-03 Controlled Tool Proxy = BLOCK**，直到 D4-02 自身 PASS。本阶段到此停止，未进入 ACP / Harness / Tool / MCP / D4-03。
