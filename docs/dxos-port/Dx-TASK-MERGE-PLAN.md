# Dx-TASK-MERGE-PLAN · dx_* 与 tasks 表级合并方案与影响面

> 阶段：M1（只产出方案，不改产品代码）
> 工作树：/Users/wepingli/.openarc-worktrees/dxos-port-r1（分支 dxos-port/r1）
> 基线 commit：74c26faf1ad34439ccd3773baf142cde0bb29ef9
> 本阶段未修改任何产品代码；仅新增本文件。本阶段开始时工作树已有未提交改动（U1 统一读模型 UI）：
>   M src/projects/TaskConsole.tsx、M src/projects/taskConsoleLogic.ts、?? src/projects/coreTaskConsole.ts
> 期间另有兄弟 Agent 在同一工作树并发改动（experiments/dxos-ui-tasks/*、src/styles.css、tests/dxos-task-console.test.mjs）
> —— 这些都不是本次产出，本次只写入了本文件。
> 约束：DX OS 只读、不联网、不新增依赖、不改 CSP/tokens.css、不 commit/push、不跑 npm run build / npm test。
> 所有 SQL 实验都在 /tmp 的临时库副本上完成，未写进产品代码。

---

## 0. 结论摘要（给决策者的 6 句话）

1. **物理上能合**：我在临时 v26 真库上把三张表合并成 tasks / task_steps / task_events，core+DX 数据、9 张外键子表、索引全部保留，`PRAGMA foreign_key_check` 为空，可提交、可回滚（实验输出见 §7.3）。
2. **但有一个致命单点**：`PRAGMA foreign_keys=ON` 时 `DROP TABLE tasks` 会按 `ON DELETE CASCADE` **静默删掉 9 张子表的全部行**（实测子表从 1 行变 0 行，见 §7.2 EXP1）。因此迁移必须在 **事务之外** 关掉 FK，这要求改 `identity-store.cjs` 的迁移执行器（`#migrate`，identity-store.cjs:1780-1795），不是纯 DDL 改动。
3. **合并会削弱数据库层的约束**：现有 core `tasks.status` 的 7 态 CHECK（identity-store.cjs:856）是硬约束；DX `dx_tasks.status` 无 CHECK。合并后若只放"18 值联合 CHECK"，任何人都能往 core 行写 DX 小写状态。**推荐用"按 record_source 分源 CHECK"**（§7.4 实测：core+queued 被拒、dx+RUNNING 被拒），这样两套状态机在库层都保住。
4. **回归面很大**：`SCHEMA_VERSION===26` 的冻结断言有 **37 处、分布在 12 个测试文件**（§1.3）；`task-unified-view.cjs` 依赖"两套表都存在 + 同名 id 报歧义"的语义（dxos-task-unified.test.mjs:164-193）；`dxos-agent-schema.cjs` 是"机械抽取、与脚本逐字一致"的生成文件（dxos-agent-schema.test.mjs:50-54）。合并意味着这些守卫全部要改。
5. **我的专业判断**：不建议直接做全量物理合并；建议 **替代方案 A（保留双表 + 只读统一视图 + 单一写入口 + 兼容 read model）** 作为默认路径（§5.2）。A 能达到"单一读入口、单一写入口"的产品目标，但不动 9 张子表、不动 SCHEMA_VERSION 语义、不动已冻结的 12 个测试文件。
6. 若上级坚持全量合并，本文件 §2/§3/§4 给出了**可直接执行**的 DDL、迁移步骤与分阶段代码改动清单，并按阶段标注验收条件与回滚点。

---

## 1. 现状盘点（全部带证据）

### 1.1 两套表的完整 DDL

#### 1.1.1 既有 core 三表（真值在 identity-store.cjs，v9 建立）

来源：`electron/identity-store.cjs:850-914`（`SCHEMA_V9_SQL`）。

- `tasks`：identity-store.cjs:851-869，17 列，PK `task_id`；
  - status CHECK 7 态：identity-store.cjs:856 `CHECK (status IN ('PENDING','RUNNING','WAITING','SUCCEEDED','FAILED','CANCELLED','BLOCKED'))`；
  - 索引：:870 `idx_tasks_user_status(user_id,status)`、:871 `idx_tasks_app(app_id)`。
- `task_steps`：:873-886，11 列，PK `step_id`，FK `task_id REFERENCES tasks(task_id) ON DELETE CASCADE`（:875），`UNIQUE(task_id,sequence)`（:885），status CHECK 6 态（:878）；索引 :887。
- `task_events`：:904-913，6 列，PK `event_id`，FK `task_id REFERENCES tasks(task_id) ON DELETE CASCADE`（:906），`UNIQUE(task_id,sequence)`（:911）；索引 :913。
- 同名依赖表（v10-v16，全部 FK 指向 `tasks(task_id)`）：`task_model_calls`（:889）、`task_harness_runs`（:924）、`task_artifacts`（:940）、`task_verifications`（:952，v15 重建 :1117）、`task_tool_proposals`（:972）、`side_effect_calls`（:1036）、`task_budgets`（:1145）。

实测外键图（v26 真库 `PRAGMA foreign_key_list`，见 §7.1）——共 **9 张表** FK 指向 `tasks(task_id)`：

~~~
side_effect_calls.task_id -> tasks.task_id ON DELETE CASCADE
task_artifacts.task_id -> tasks.task_id ON DELETE CASCADE
task_budgets.task_id -> tasks.task_id ON DELETE CASCADE
task_events.task_id -> tasks.task_id ON DELETE CASCADE
task_harness_runs.task_id -> tasks.task_id ON DELETE CASCADE
task_model_calls.task_id -> tasks.task_id ON DELETE CASCADE
task_steps.task_id -> tasks.task_id ON DELETE CASCADE
task_tool_proposals.task_id -> tasks.task_id ON DELETE CASCADE
task_verifications.task_id -> tasks.task_id ON DELETE CASCADE
~~~

#### 1.1.2 DX 三表（真值在 dxos-agent-schema.cjs，v23 建立）

来源：`electron/dxos-agent-schema.cjs:65-79`（`DXOS_AGENT_DDL`，机械抽取自 DX OS 0.5.1 `server/ccsDb.ts`）。

- `dx_tasks`：dxos-agent-schema.cjs:66，**39 列**，PK `id`，**0 表级约束、0 外键**，status 无 CHECK。
- `dx_task_steps`：:67，**15 列**，PK `id`，`operation_id UNIQUE`、`UNIQUE(task_id, ordinal)`，0 外键。
- `dx_task_events`：:68，**7 列**，PK `id INTEGER PRIMARY KEY AUTOINCREMENT`，0 外键。
- DX 索引 9 条：:69-77（dx_idx_tasks_queue / project / events_task / steps_task / creator / events_task_sequence(UNIQUE) / tasks_legacy_source(UNIQUE 部分) / tasks_parent / tasks_root_status）。
- 同域但有身份映射作用的表：`dx_task_approval_bridge`（`electron/dx-task-approval-schema.cjs:22-35`，v26 建立；幂等键 `(dx_task_id, dx_step_id)`，`core_task_id/core_step_id/core_run_id` 各自 UNIQUE）。**它不是要合并的表，是"DX id ↔ core id"的身份桥，合并后仍需保留。**
- 上述全部列/约束/索引已用临时 v26 真库 `PRAGMA table_info/index_list/foreign_key_list` 复核，见 §7.1。

### 1.2 全部读写点

#### 1.2.1 DX 侧（`dx_tasks / dx_task_steps / dx_task_events`）

grep 计数（`electron/*.cjs`，词边界匹配，见 §7.5）：
`\bdx_tasks\b` 88 处 / 10 文件；`\bdx_task_steps\b` 38 处 / 7 文件；`\bdx_task_events\b` 25 处 / 5 文件。

真正带 SQL 的读写点集中在 `electron/agent-task-store.cjs`（80 行 SQL，逐行映射到函数，命令见 §7.6）。按"函数 → 操作 → 表"归纳：

| 文件:行 | 函数 | 操作 | 表 |
|---|---|---|---|
| agent-task-store.cjs:341 | createTask | SELECT | dx_tasks |
| agent-task-store.cjs:354 | createTask | INSERT | dx_tasks |
| agent-task-store.cjs:401 | createTask | INSERT | dx_task_steps |
| agent-task-store.cjs:495 | importLegacyTask | SELECT | dx_tasks |
| agent-task-store.cjs:510 | importLegacyTask | INSERT | dx_tasks |
| agent-task-store.cjs:550-551 | appendTaskEvent | INSERT..SELECT | dx_task_events |
| agent-task-store.cjs:570 | getTask | SELECT | dx_tasks |
| agent-task-store.cjs:578-579 | hydrateTask | SELECT | dx_task_steps / dx_task_events |
| agent-task-store.cjs:599 | listTaskEvents | SELECT | dx_task_events |
| agent-task-store.cjs:607-610 | listTasks | SELECT..JOIN | dx_tasks |
| agent-task-store.cjs:660 | updateTaskStatus | UPDATE | dx_tasks |
| agent-task-store.cjs:673-681 | consumeBudget | SELECT / UPDATE..RETURNING | dx_tasks |
| agent-task-store.cjs:690-696 | appendDynamicStep | SELECT / INSERT | dx_task_steps |
| agent-task-store.cjs:720 | persistAgentTurn | SELECT(EXISTS) | dx_tasks |
| agent-task-store.cjs:754 | advanceAgentTurn | SELECT(EXISTS) | dx_tasks |
| agent-task-store.cjs:778 | completeAgentTurn | SELECT(EXISTS) | dx_tasks |
| agent-task-store.cjs:805 | sealStaleReactSteps | UPDATE | dx_task_steps |
| agent-task-store.cjs:833 | waitForUser | UPDATE | dx_tasks |
| agent-task-store.cjs:852 | waitForChildren | UPDATE | dx_tasks |
| agent-task-store.cjs:874-880 | failTaskFenced | UPDATE | dx_tasks |
| agent-task-store.cjs:908 | pauseTaskFenced | UPDATE | dx_tasks |
| agent-task-store.cjs:924/945/959 | answerTask / continueTask | SELECT / UPDATE | dx_tasks |
| agent-task-store.cjs:972-978 | refreshTaskInstruction | SELECT / UPDATE | dx_tasks |
| agent-task-store.cjs:1020/1043 | taskStats / findResumableTasks | SELECT | dx_tasks |
| agent-task-store.cjs:1056 | requeueRunningStep | UPDATE | dx_task_steps |
| agent-task-store.cjs:1063/1079 | pauseTask / cancelTask | SELECT | dx_tasks |
| agent-task-store.cjs:1095-1105 | deleteTask | SELECT / DELETE | dx_task_events / dx_task_steps / dx_tasks |
| agent-task-store.cjs:1113-1121 | resumeTask | SELECT / UPDATE | dx_tasks / dx_task_steps |
| agent-task-store.cjs:1137 | canWorkerRunTask | SELECT..JOIN | dx_tasks |
| agent-task-store.cjs:1184-1197 | recoverExpiredTasks | SELECT / UPDATE | dx_tasks / dx_task_steps |
| agent-task-store.cjs:1218-1242 | claimNextTask | SELECT / UPDATE | dx_tasks |
| agent-task-store.cjs:1270 | heartbeatTask | UPDATE | dx_tasks |
| agent-task-store.cjs:1286-1298 | taskIsRunning / enterVerification | SELECT / UPDATE | dx_tasks |
| agent-task-store.cjs:1313/1334 | completeVerifiedTask / failVerification | UPDATE | dx_tasks |
| agent-task-store.cjs:1349-1363 | nextQueuedStep / startStep | SELECT / UPDATE | dx_task_steps / dx_tasks |
| agent-task-store.cjs:1370-1380 | requeueStep / requeueReactStepForResume | UPDATE | dx_task_steps / dx_tasks |
| agent-task-store.cjs:1391-1418 | completeStep / failStep | SELECT / UPDATE | dx_task_steps / dx_tasks |
| agent-task-store.cjs:1447-1473 | beginOperation / finishOperation | SELECT / INSERT | dx_task_steps / dx_tasks |
| agent-task-store.cjs:1605 | postTaskMessage | SELECT | dx_tasks |

其它 DX 读/写点（非 agent-task-store）：

| 文件:行 | 操作 | 表 |
|---|---|---|
| agent-runtime-manager.cjs:69 | SELECT expected_output_schema | dx_tasks |
| agent-runtime-manager.cjs:86 | SELECT attempt_no | dx_tasks |
| agent-runtime-workspace.cjs:215 | SELECT depends_on_json | dx_tasks |
| agent-runtime-workspace.cjs:322 | SELECT id,input_json,output_json | dx_task_steps |
| dx-task-approval-bridge.cjs:162 | SELECT id | dx_task_steps |
| task-unified-view.cjs:340-348 | SELECT（只读投影） | dx_tasks / dx_task_steps / dx_task_events |
| main.cjs:847-856（注释与装配） | 读 dx 任务只有经桥 | dx_tasks（间接） |

#### 1.2.2 core 侧（`tasks / task_steps / task_events`）

真正持有 SQL 字面量的只有三处：

| 文件:行 | 操作 | 表 |
|---|---|---|
| task-store.cjs:12 | INSERT | tasks |
| task-store.cjs:13-16 | SELECT ×4 | tasks |
| task-store.cjs:17 | INSERT | task_steps |
| task-store.cjs:18-20 | SELECT ×3 | task_steps |
| task-store.cjs:24 | INSERT | task_events |
| task-store.cjs:25-27 | SELECT ×3 | task_events |
| task-store.cjs:71 | UPDATE（动态表名/列白名单） | tasks / task_steps / task_model_calls / task_harness_runs |
| agent-runtime-workspace.cjs:328 | UPDATE | task_steps（**列名与主键都写错**，见 §5.1 R10） |
| dx-task-approval-bridge.cjs:190-199 | 经 TaskStore 间接 INSERT tasks/task_steps/task_harness_runs/task_events | 四张 core 表 |
| task-unified-view.cjs:351-367 | SELECT（只读投影） | tasks / task_steps / task_events |

调用这些 SQL 的模块（经 TaskStore 读写 core 任务）：
`controlled-tool-proxy.cjs`（:130/:142/:299-347）、`side-effect-authority.cjs`（:262-268/:342-1027 多处）、`side-effect-runtime.cjs`（:186-459）、`tool-facade-bridge.cjs`（:100/:270）、`task-service.cjs`（:108-115 持有 store）、`task-bootstrap.cjs`（:39-70 装配）、`task-harness-orchestrator.cjs`（经 taskService）、`mcp-agent-tools.cjs`（:545-554 经 runtime.taskStore 读 steps/runs）、`identity-bootstrap.cjs`（:242 返回 taskStore）。

#### 1.2.3 src/ 渲染层

- `src/` 内 **0 处 SQL 关键词**（grep `\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b` 命中 0）。
- 渲染层走 IPC：DX 走 `window.openarc.agent` 的 `agent/task/*`（agent-service.cjs:513-624）；core 走 `window.openarc.task.command`（preload.cjs:151-158）→ IPC `task:command`（task-bootstrap.cjs:106-233）。
- 统一读模型入口 `agent/task/unified-list`（agent-service.cjs:616-624 → task-unified-view.cjs:431），UI 在 `src/projects/TaskConsole.tsx:357` 调用（`UNIFIED_READ_MODEL_COMMAND`，taskConsoleLogic.ts:1014）。
- 当前工作树**未提交**的 U1 UI 改动把 core 任务也显到同一列表：TaskConsole.tsx（+37 行）、taskConsoleLogic.ts（+531 行）、新文件 src/projects/coreTaskConsole.ts。合并会直接冲掉这一层的"两套通道分开"前提。

### 1.3 依赖这些表的测试文件与用例数

按文件统计（`node --test` 里 `^\\s*(test|it)\\(` 计数，命令见 §7.7）：

| 测试文件 | 用例数 | 与任务表的关系 | 是否绑定 7 态 CHECK / 列集合 / 版本 |
|---|---|---|---|
| tests/dxos-agent-schema.test.mjs | 7 | DX 三表列集/索引/外键基线 | **是**：:137-149 deepEqual 精确列集；:56-68 列数 39/15/7；:126-135 断言 0 外键 |
| tests/dxos-agent-migration.test.mjs | 7 | v23 迁移与回滚 | **是**：:45-46/:53 冻结 26；:61 dx_tasks 不含 task_id；:150-165 失败回滚断言 dx_ 表不存在 |
| tests/dxos-agent-task-store.test.mjs | 16 | DX 状态机持久层 | 状态取值（11 态）+ 列名 |
| tests/dxos-agent-runtime.test.mjs | 30 | DX run/步骤 | 读 dx_task_steps/dx_tasks |
| tests/dxos-agent-kernel.test.mjs | 24 | DX kernel | 读 dx_tasks |
| tests/dxos-agent-ipc.test.mjs | 9 | agent/task IPC | 读 dx_tasks |
| tests/dxos-task-unified.test.mjs | 7 | 统一读模型边界 | **是**：:30 固定 6 张表；:164-193 同名 id 报歧义；:232-240 往 dx_tasks 写 'mystery' |
| tests/dxos-task-unified-ipc.test.mjs | 3 | unified-list IPC | 是（投影形状） |
| tests/dxos-task-console.test.mjs | 42 | 任务控制台 UI 逻辑 | 间接（DX 命令域） |
| tests/dxos-mcp-dx-task-approval-bridge.test.mjs | 5 | DX→core 身份桥 | 读 dx_tasks/dx_task_steps |
| tests/task-store.test.mjs | 5 | core TaskStore | **是**：:162 冻结 26；:166 检查 tasks/task_steps/task_events 表存在 |
| tests/task-domain.test.mjs | 15 | core 7 态纯领域 | **是**：TASK_STATUS_ALL/TRANSITIONS |
| tests/migration.test.mjs | 10 | 迁移总链 | **是**：:43 冻结 26；:248/:277/:287 精确 26；:293 高版本拒开 27 |
| tests/dxos-foundation.test.mjs | 23 | DX 地基 | **是**：:86/:87/:119/:154/:156 冻结 26 |
| tests/dxos-media.test.mjs | 14 | DX 媒体迁移 | **是**：:130/:139/:146 冻结 26；:153 高版本 27 |
| tests/dxos-agent-react-driver.test.mjs | 9 | DX react | 间接 |
| tests/task-harness-security.test.mjs | 3 | core harness 安全 | 读 task_events |
| tests/tool-dsh-e2e.test.mjs | 3 | core facade e2e | 读 tasks |
| tests/d4-main-e2e.mjs | 0（脚本） | 端到端脚本 | 读两套表 |

**冻结 SCHEMA_VERSION=26 的断言共 37 处、12 个文件**（命令与完整清单见 §7.9）：side-effect-migration、dxos-agent-migration(6)、task-orchestration-migration、task-store、authorization-app-grant-scope(3)、tool-execution-migration、tool-migration、device-migration、dxos-media(3)、identity-session-expiry(2)、migration(4)、d5-03-reset-device-identity(4)、identity-store、dxos-foundation(5)。另有 3 处 "user_version=27 必须拒开"（dxos-agent-migration.test.mjs:138、migration.test.mjs:293、dxos-media.test.mjs:153）。

### 1.4 两套状态机的完整取值、语义与双向映射

#### core 7 态（task-domain.cjs:9-17；DDL CHECK 同集合 identity-store.cjs:856）

`PENDING / RUNNING / WAITING / SUCCEEDED / FAILED / CANCELLED / BLOCKED`。
显式迁移表 task-domain.cjs:214-223（未列出的边一律禁止）：

~~~
PENDING -> RUNNING | CANCELLED | BLOCKED
RUNNING -> WAITING | SUCCEEDED | FAILED | CANCELLED | BLOCKED
WAITING -> RUNNING | CANCELLED | BLOCKED
BLOCKED -> RUNNING | CANCELLED
SUCCEEDED -> RUNNING   （仅产品级 AppendStep）
FAILED -> （终态）
CANCELLED -> （终态）
~~~
终态集合 task-domain.cjs:19；step 6 态与迁移表 :21-28/:224-231。

#### DX 11 态（agent-task-store.cjs:55-67，源自 taskStore.ts:6）

`queued / planning / running / verifying / completed / waiting_user / waiting_children / paused / interrupted / failed / cancelled`。
DX **没有显式迁移表**，靠 SQL 的 `WHERE status=...` 守卫实现许可（例如 :720 `status='running'`、:1229 `status='queued' OR (status='interrupted' AND resume_safe=1)`、:1313 完成、:1334 失败、:1184 回收 `IN ('planning','running','verifying')`）。

#### 双向映射（task-unified-view.cjs:68-102，已冻结并被测试覆盖）

| DX 11 态 | core 7 态（统一词汇） | core → DX 规范代表 | core → DX 全部来源 |
|---|---|---|---|
| queued | PENDING | queued | [queued] |
| planning | RUNNING | running | [planning, running, verifying] |
| running | RUNNING | running | 同上 |
| verifying | RUNNING | running | 同上 |
| completed | SUCCEEDED | completed | [completed] |
| waiting_user | WAITING | waiting_user | [waiting_user, waiting_children] |
| waiting_children | WAITING | waiting_user | 同上 |
| paused | BLOCKED | paused | [paused, interrupted] |
| interrupted | BLOCKED | paused | 同上 |
| failed | FAILED | failed | [failed] |
| cancelled | CANCELLED | cancelled | [cancelled] |

**无法一一对应的情形（必须在合并方案里显式取舍）：**

1. **大小写与语义都不同名**：core 用大写 7 值，DX 用小写 11 值。合并成单列后，同一个"status"列同时承载两套词汇，**数据库无法再仅凭值判断这条行属于哪套状态机**——除非加判别列（本方案加 `record_source`）。
2. **多对一**：DX 的 planning/running/verifying 都归 RUNNING；waiting_user/waiting_children 都归 WAITING；paused/interrupted 都归 BLOCKED。**反向不可逆**：只知道统一态 RUNNING 无法恢复出 planning/verifying。合并后"统一态"只能是展示层推导，不能回写。
3. **同名不同义**：`current_step_id` 在 core 指 `task_steps.step_id`，在 DX 指 `dx_task_steps.id`；`created_at/updated_at/started_at/completed_at` 语义一致，可直接共用；`goal`（core）与 `instruction`（DX）语义相近但**不能合并**（DX 用 instruction 驱动执行，core 用 goal 对外展示）。
4. **同名 id 命名空间独立**：core `task_id` 与 DX `id` 可重名。统一读模型当前把重名判为 `UNIFIED_VIEW_AMBIGUOUS_SOURCE`（task-unified-view.cjs:478-484）；合并后要么丢一行、要么改 id。实测重名会导致 `UNIQUE constraint failed`（§7.9）。

---## 2. 合并目标 schema

### 2.1 命名与身份决策（先说为什么）

- **物理表必须叫 `tasks` / `task_steps` / `task_events`**：9 张子表的外键按名字指向 `tasks(task_id)`，SQLite 的外键父表**必须是真表、不能是视图**。改名等于重建 9 张子表，代价与风险更大。
- **规范主键 = `task_id` / `step_id` / `event_id`**（core 名），保留 core 侧 SQL 不动；DX 的 `id` 通过**可写视图 `dx_tasks` / `dx_task_steps` 的别名**提供（`SELECT task_id AS id ...`），DX 侧 SQL 也基本不动。
- **新增 `record_source TEXT NOT NULL DEFAULT 'core' CHECK (record_source IN ('core','dx'))`**：合并后唯一能区分来源的物理依据，也是兼容视图的过滤条件与统一读模型的单一来源。
- **DX 的 `id INTEGER AUTOINCREMENT`（事件表）必须物理保留**：AUTOINCREMENT 只能是 INTEGER PRIMARY KEY，不能做别名。故 `task_events` 用 `id` 作主键、core 的 `event_id` 降为 `UNIQUE` 普通列。

### 2.2 合并后完整 DDL（可直接执行）

~~~sql
-- ===== 合并后 tasks：50 列（core 17 + dx 39 - 共享 6 + 判别列 1 - 身份别名 id 复用 task_id）=====
CREATE TABLE tasks (
  -- core 侧 17 列
  task_id                 TEXT PRIMARY KEY,
  user_id                 TEXT,            -- 原 NOT NULL：DX 行无此列，合并后放宽
  session_ref             TEXT,
  app_id                  TEXT,            -- 原 NOT NULL：DX 行无此列，合并后放宽
  status                  TEXT NOT NULL,
  goal                    TEXT,            -- 原 NOT NULL：DX 行无此列，合并后放宽
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  started_at              INTEGER,
  completed_at            INTEGER,
  model_config_id         TEXT,
  model_config_version    INTEGER,
  current_step_id         TEXT,            -- core=task_steps.step_id / DX=dx_task_steps.id，合并后同一命名空间
  revision                INTEGER NOT NULL DEFAULT 1,
  cancel_requested        INTEGER NOT NULL DEFAULT 0,
  budget_snapshot         TEXT,
  permission_snapshot_ref TEXT,
  -- dx 侧 33 列（去重后；id 由视图别名提供，不物理存在）
  project_id              TEXT,
  thread_id               TEXT,
  title                   TEXT,
  instruction             TEXT,
  worker_id               TEXT,
  lease_until             INTEGER,
  heartbeat_at            INTEGER,
  result                  TEXT,
  error_code              TEXT,
  error_message           TEXT,
  resume_safe             INTEGER NOT NULL DEFAULT 1,
  created_by              TEXT,
  legacy_source_id        TEXT,
  mode                    TEXT NOT NULL DEFAULT 'actions',
  model_calls             INTEGER NOT NULL DEFAULT 0,
  tool_calls              INTEGER NOT NULL DEFAULT 0,
  waiting_question        TEXT,
  execution_profile       TEXT NOT NULL DEFAULT 'expert',
  preferred_provider_id   TEXT,
  preferred_llm_model     TEXT,
  preferred_image_provider_id TEXT,
  preferred_image_model   TEXT,
  parent_task_id          TEXT,
  root_task_id            TEXT,
  agent_profile_id        TEXT,
  delegated_by_run_id     TEXT,
  depends_on_json         TEXT NOT NULL DEFAULT '[]',
  expected_output_schema  TEXT,
  permission_grant_json   TEXT NOT NULL DEFAULT '[]',
  delegation_depth        INTEGER NOT NULL DEFAULT 0,
  lease_token             TEXT,
  attempt_no              INTEGER NOT NULL DEFAULT 0,
  -- 合并新增：来源判别
  record_source           TEXT NOT NULL DEFAULT 'core' CHECK (record_source IN ('core','dx')),
  -- 分源状态 CHECK：两套状态机在库层各自保住（比"18 值联合 CHECK"更强）
  CHECK (
    (record_source = 'core' AND status IN ('PENDING','RUNNING','WAITING','SUCCEEDED','FAILED','CANCELLED','BLOCKED'))
    OR
    (record_source = 'dx'   AND status IN ('queued','planning','running','verifying','completed',
                                           'waiting_user','waiting_children','paused','interrupted','failed','cancelled'))
  )
);

CREATE INDEX idx_tasks_user_status ON tasks(user_id, status);          -- core 原名
CREATE INDEX idx_tasks_app        ON tasks(app_id);                    -- core 原名
CREATE INDEX dx_idx_tasks_queue   ON tasks(status, lease_until, created_at);
CREATE INDEX dx_idx_tasks_project ON tasks(project_id, created_at);
CREATE INDEX dx_idx_tasks_creator ON tasks(created_by, created_at);
CREATE UNIQUE INDEX dx_idx_tasks_legacy_source ON tasks(created_by, legacy_source_id) WHERE legacy_source_id IS NOT NULL;
CREATE INDEX dx_idx_tasks_parent  ON tasks(parent_task_id, created_at);
CREATE INDEX dx_idx_tasks_root_status ON tasks(root_task_id, status, created_at);
CREATE INDEX idx_tasks_record_source ON tasks(record_source, created_at);

-- ===== 合并后 task_steps：22 列（core 11 + dx 15 - 共享 4 + 判别列 1 → step_id 复用 id）=====
CREATE TABLE task_steps (
  step_id         TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  sequence        INTEGER,                 -- core 原 NOT NULL，DX 行空，放宽
  ordinal         INTEGER,                 -- dx 原 NOT NULL，core 行空，放宽
  kind            TEXT,
  tool_name       TEXT,
  title           TEXT,
  status          TEXT NOT NULL,
  input           TEXT,
  input_json      TEXT,
  output_ref      TEXT,
  output_json     TEXT,
  operation_id    TEXT UNIQUE,
  attempt         INTEGER NOT NULL DEFAULT 1,
  max_attempts    INTEGER NOT NULL DEFAULT 1,
  plan_version    INTEGER NOT NULL DEFAULT 1,
  expected_output TEXT,
  result_summary  TEXT,
  created_at      INTEGER,
  started_at      INTEGER,
  completed_at    INTEGER,
  record_source   TEXT NOT NULL DEFAULT 'core' CHECK (record_source IN ('core','dx')),
  UNIQUE (task_id, sequence),
  UNIQUE (task_id, ordinal),
  CHECK (
    (record_source = 'core' AND status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED','BLOCKED'))
    OR
    (record_source = 'dx'   AND status IN ('queued','running','completed','failed'))
  )
);
CREATE INDEX idx_task_steps_task_seq     ON task_steps(task_id, sequence);   -- core 原名
CREATE INDEX idx_task_steps_task_ordinal ON task_steps(task_id, ordinal);    -- 原 dx_idx_steps_task

-- ===== 合并后 task_events：11 列（core 6 + dx 7 - 共享 3 + 判别列 1）=====
CREATE TABLE task_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,  -- DX 身份保留（AUTOINCREMENT 只能做主键）
  event_id     TEXT UNIQUE,                        -- core 身份降为 UNIQUE 普通列
  task_id      TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  sequence     INTEGER NOT NULL,
  event_type   TEXT,                               -- core 词汇
  type         TEXT,                               -- dx 词汇
  message      TEXT,                               -- dx
  safe_payload TEXT,                               -- core
  data_json    TEXT,                               -- dx
  created_at   INTEGER NOT NULL,
  record_source TEXT NOT NULL DEFAULT 'core' CHECK (record_source IN ('core','dx')),
  UNIQUE (task_id, sequence)
);
CREATE INDEX idx_task_events_task_seq ON task_events(task_id, sequence);  -- core 原名
CREATE INDEX idx_task_events_task_id  ON task_events(task_id, id);        -- 原 dx_idx_events_task
~~~

> 注：`dx_idx_events_task_sequence`（UNIQUE(task_id,sequence)）与 `UNIQUE(task_id,sequence)` 等价，合并为一个即可；`dx_task_steps.operation_id UNIQUE` 保留（core 行 operation_id 为 NULL，SQLite 的 UNIQUE 允许多个 NULL）。

### 2.3 列映射与保留/废弃决策

| 类别 | 列 | 决策 |
|---|---|---|
| 直接共用（同名同义） | status、created_at、updated_at、started_at、completed_at | 物理合并为单列 |
| 同名但需统一命名空间 | current_step_id | 物理合并；合并后 step 表也合并，id 命名空间随之统一 |
| core 身份 | task_id / step_id / event_id | 规范主键（事件表 event_id 降 UNIQUE） |
| dx 身份 | id | **别名（视图）**，不物理存（事件表例外：id 保留为真主键） |
| core 专有 | user_id、app_id、goal、session_ref、model_config_id/version、revision、cancel_requested、budget_snapshot、permission_snapshot_ref | 保留为物理列；user_id/app_id/goal 由 NOT NULL **放宽**为可空 |
| dx 专有 | project_id、thread_id、title、instruction、worker_id、lease_*、heartbeat_at、result、error_*、resume_safe、created_by、legacy_source_id、mode、model_calls、tool_calls、waiting_question、execution_profile、preferred_*、parent_task_id、root_task_id、agent_profile_id、delegated_by_run_id、depends_on_json、expected_output_schema、permission_grant_json、delegation_depth、lease_token、attempt_no | 保留为物理列；project_id/thread_id/title/instruction 由 NOT NULL **放宽**为可空 |
| step 双词汇 | kind vs tool_name、input vs input_json、output_ref vs output_json、attempt/max_attempts vs plan_version、sequence vs ordinal | **双列并存**，各侧写各侧；统一投影在视图里 COALESCE |
| event 双词汇 | event_type vs type、safe_payload vs data_json | **双列并存** |
| 新增 | record_source | 合并新增；所有兼容视图/统一投影都靠它 |
| 废弃 | 无物理列被删除 | 本方案不删任何源列（除身份别名 id） |
| 不参与合并 | dx_task_approval_bridge | 原样保留 |

### 2.4 兼容视图（让两套旧 SQL 在阶段 1 零改动可用）

~~~sql
CREATE VIEW dx_tasks AS
SELECT task_id AS id, project_id, thread_id, title, instruction, status, worker_id, lease_until,
       heartbeat_at, current_step_id, result, error_code, error_message, resume_safe, created_at,
       updated_at, started_at, completed_at, created_by, legacy_source_id, mode, model_calls,
       tool_calls, waiting_question, execution_profile, preferred_provider_id, preferred_llm_model,
       preferred_image_provider_id, preferred_image_model, parent_task_id, root_task_id,
       agent_profile_id, delegated_by_run_id, depends_on_json, expected_output_schema,
       permission_grant_json, delegation_depth, lease_token, attempt_no
FROM tasks WHERE record_source = 'dx';

CREATE VIEW dx_task_steps AS
SELECT step_id AS id, task_id, ordinal, title, tool_name, input_json, status, output_json,
       operation_id, started_at, completed_at, created_at, plan_version, expected_output, result_summary
FROM task_steps WHERE record_source = 'dx';

CREATE VIEW dx_task_events AS
SELECT id, task_id, type, message, data_json, created_at, sequence
FROM task_events WHERE record_source = 'dx';
~~~

每个视图配 INSTEAD OF INSERT / UPDATE / DELETE 触发器（完整触发器 SQL 见 §7.3 的可运行脚本）。**两个实测硬约束**：

1. **视图没有列默认值**：`INSERT INTO dx_tasks(...)` 若省略 `resume_safe/mode/model_calls/tool_calls/execution_profile/depends_on_json/permission_grant_json/delegation_depth/attempt_no`，在触发器里 `NEW.col` 是 NULL，会覆盖底表 DEFAULT 并触发 NOT NULL 失败（实测报 `NOT NULL constraint failed: tasks.resume_safe`）。触发器必须写 `COALESCE(NEW.col, 默认值)`（§7.3 已带）。
2. **`UPDATE ... RETURNING` 在视图上通过 INSTEAD OF 触发器仍能正确返回**（实测 §7.10：命中返回 `{"n":6}`、不命中返回 undefined），因此 `consumeBudget` 的 `RETURNING`（agent-task-store.cjs:681）在阶段 1 不受影响。

### 2.5 状态 CHECK 的最终取值集合

- `tasks.status`：**18 个合法值**——core 7（大写）+ DX 11（小写），但**按 record_source 分源约束**；交叉取值（core+小写、dx+大写）被拒。实测见 §7.4。
- `task_steps.status`：**10 个合法值**——core 6 + DX 4（queued/running/completed/failed），同样分源。
- `task_events`：无状态列。
- 若上级要求"单条联合 CHECK、不区分来源"，把上面两处 CHECK 换成纯 `status IN (...)` 即可；代价是失去"core 行不得出现 DX 状态"的库层保护（详见 §5.2 的取舍）。

---

## 3. 迁移步骤（SQLite 不能 ALTER CHECK，必须重建表）

### 3.1 前置条件（缺一不可）

1. **迁移执行器支持"事务外关 FK + 事务内自检"**。当前 `#migrate`（identity-store.cjs:1780-1795）先 `transactSync`（BEGIN IMMEDIATE）再执行迁移体；而 `PRAGMA foreign_keys` 在事务内是 **no-op**（实测 EXP2：值仍为 1），`defer_foreign_keys` 也挡不住 CASCADE（EXP3）。必须在 `transactSync` **之前** `PRAGMA foreign_keys = OFF`，提交后 `PRAGMA foreign_keys = ON`。
2. **事务内 `PRAGMA foreign_key_check` 必须为空才允许 COMMIT**（实测在 FK=OFF 的事务内可正常执行，返回 `[]`）。有违规则抛错 → 整级回滚。
3. **升级前自动备份**：`VACUUM INTO '<userData>/identity.db.pre-v27.<ts>.bak'`。实测 `DatabaseSync.backup` 在 Node 22.22.3 不存在，`VACUUM INTO` 可用，但**必须在事务外**（事务内报 `cannot VACUUM from within a transaction`，见 §7.11）。备份应在 `open()` 里、`#migrate()` 之前执行。
4. **同名冲突预检**：`SELECT t.task_id FROM tasks t JOIN dx_tasks d ON d.id=t.task_id`。非空则**拒绝升级并报出冲突清单**（不自动改 id）。实测见 §7.12。
5. **幂等守卫**：若 `sqlite_master` 中 `dx_tasks` 的 type 已是 `view`，v27 直接返回（重放保护）。

### 3.2 逐步骤可执行迁移（v27）

~~~sql
-- 步骤 0：由执行器在事务外完成
PRAGMA foreign_keys = OFF;
VACUUM INTO '<备份路径>';          -- 升级前自动备份
BEGIN IMMEDIATE;

-- 步骤 1：冲突预检（非空即 throw）
--   SELECT t.task_id FROM tasks t JOIN dx_tasks d ON d.id=t.task_id;
-- 步骤 2：幂等守卫（已是 view 即 return）
--   SELECT type FROM sqlite_master WHERE name='dx_tasks';

-- 步骤 3：重建 tasks（见 §2.2 DDL 的 CREATE TABLE tasks_v27）
CREATE TABLE tasks_v27 ( ... );                       -- 见 §2.2
INSERT INTO tasks_v27 ( ...core 列..., record_source)
  SELECT ...core 列..., 'core' FROM tasks;            -- core 行原样搬
INSERT INTO tasks_v27 ( ...dx 列..., record_source)
  SELECT id, project_id, ... , 'dx' FROM dx_tasks;    -- dx 行 id→task_id
DROP TABLE tasks;                                     -- FK=OFF，子表行不会被 CASCADE
ALTER TABLE tasks_v27 RENAME TO tasks;                -- 子表 FK 仍指向 tasks（实测 §7.2 EXP4）
-- 步骤 4：重建 tasks 索引（见 §2.2）

-- 步骤 5：重建 task_steps
CREATE TABLE task_steps_v27 ( ... );                  -- 见 §2.2
INSERT INTO task_steps_v27 (...) SELECT step_id,...,'core' FROM task_steps;
INSERT INTO task_steps_v27 (...) SELECT id,...,'dx' FROM dx_task_steps;
DROP TABLE task_steps;
ALTER TABLE task_steps_v27 RENAME TO task_steps;
CREATE INDEX idx_task_steps_task_seq / task_ordinal;

-- 步骤 6：重建 task_events（先搬 dx 显式 id，再搬 core 让 AUTOINCREMENT 续号）
CREATE TABLE task_events_v27 ( ... );
INSERT INTO task_events_v27 (id, ..., record_source) SELECT id,...,'dx' FROM dx_task_events;
INSERT INTO task_events_v27 (event_id, ..., record_source) SELECT event_id,...,'core' FROM task_events;
DROP TABLE task_events;
ALTER TABLE task_events_v27 RENAME TO task_events;
CREATE INDEX idx_task_events_task_seq / task_id;

-- 步骤 7：落掉三张旧 dx_ 表，建同名可写视图 + INSTEAD OF 触发器（见 §2.4/§7.3）
DROP TABLE dx_tasks; DROP TABLE dx_task_steps; DROP TABLE dx_task_events;
CREATE VIEW dx_tasks AS ...; CREATE TRIGGER dx_tasks_ins/upd/del ...;
CREATE VIEW dx_task_steps AS ...; CREATE TRIGGER ...;
CREATE VIEW dx_task_events AS ...; CREATE TRIGGER ...;

-- 步骤 8：提交前自检
--   PRAGMA foreign_key_check;  必须为 []
COMMIT;
PRAGMA foreign_keys = ON;      -- 执行器在 COMMIT 后恢复
~~~

顺序要点：
- **必须先重建父表 `tasks`，再重建子表 `task_steps/task_events`**，否则子表重建期间 FK 指向的还是旧父表名（虽然 FK=OFF 不报错，但语义混乱）。
- **绝对不要 `ALTER TABLE tasks RENAME TO tasks_old`**：实测 EXP5，无论 `legacy_alter_table` 开关，SQLite 3.51 都会把子表 FK 的引用改写成 `tasks_old`，之后必须再改回来。官方"新建-搬运-DROP-改名"配方（EXP4）已验证不会改写子表 FK。

### 3.3 事务边界、sqlite_sequence 与 rowid

- **事务边界**：备份、`PRAGMA foreign_keys` 在 BEGIN 之前；DDL+搬运+自检+COMMIT 在同一个事务内（SQLite 的 DDL 在事务内可回滚）。失败 → ROLLBACK → 恢复 FK → 库回到 v26 原状。
- **rowid/rowid 别名**：`tasks`/`task_steps` 用 TEXT 主键，rowid 只是内部行号，重建后不保证一致；**没有任何外键或本次三张表的查询按 rowid 寻址**。全仓 `rowid` 只出现在 tool-store.cjs:15/:25 与 task-service.cjs:1388，都作用于 `task_tool_proposals` / `tool_executions`（本次不重建），可安全重建。
- **sqlite_sequence**：`task_events_v27` 是 `AUTOINCREMENT`。**搬运时必须先插 DX 行（带显式 id）再插 core 行**（否则 core 先占 id 1..N 会与 DX 的显式 id 撞车；实验中第一次就报 `UNIQUE constraint failed: task_events_v27.id`）。带显式 id 插入 AUTOINCREMENT 表会把 `sqlite_sequence` 抬到该最大值——实测搬运后 `sqlite_sequence.seq=3`（DX 最大 id=2），随后新事件 id=4（§7.3）。

### 3.4 SCHEMA_VERSION 递增、幂等与可重放

- `identity-store.cjs:92` `SCHEMA_VERSION` 26 → **27**。
- `identity-store.cjs:1581-1622` `MIGRATIONS` 追加 `{ version: 27, run: applyTaskTableMergeLayer, foreignKeysOff: true, backupBefore: true }`（后两个字段是 §3.1 的执行器能力）。
- 幂等：迁移体第一步查 `sqlite_master` 中 `dx_tasks` 的类型；`view` 即 return。这样把 `user_version` 人为降回 26 再开也能安全重放（与现有 "重放不丢行" 测试同一套路，dxos-agent-migration.test.mjs:107-133）。
- 可重放：所有 `CREATE` 用 `IF NOT EXISTS` 不适用于"重建"，因此幂等只能靠上述守卫；守卫本身要覆盖半成品（若上次在 COMMIT 前失败，事务已整体回滚，不会留半成品）。

### 3.5 升级前自动备份 / 失败自动回滚

- 备份：`open()` 中先算 `PRAGMA user_version < SCHEMA_VERSION`，若是则 `VACUUM INTO <dir>/identity.db.pre-v<new>.<ISO ts>.bak`；备份文件名写进审计（`IdentityStore.audit`，identity-store.cjs:1881）。
- 失败回滚：迁移体抛错 → `transactSync` 的 catch 执行 ROLLBACK（identity-store.cjs:1809-1816）→ 恢复 `PRAGMA foreign_keys = ON` → 重新抛错，`open()` 失败。此时库仍是 v26，备份文件仍在，可人工回退。
- 极端情况（进程在 COMMIT 后、恢复 FK 前被杀）：`foreign_keys` 是连接级 pragma，下次 `openDatabase` 会重新置 ON（identity-store.cjs:1719），无残留。

### 3.6 旧库（v26）与新库（v27）双向兼容策略

- **v27 → v26 读**：不兼容。v27 里 `dx_tasks` 是视图，v23 的迁移 DDL（`CREATE TABLE IF NOT EXISTS dx_tasks`）遇到同名视图会**报错**（`there is already a view named dx_tasks`）。因此 `SCHEMA_TOO_NEW` 检查（identity-store.cjs:1782）必须拦住：旧程序打开 v27 库直接拒开。这是**单向升级**，过渡期不能回退二进制。
- **v26 → v27 读**：v27 代码读到 v26 库时，`dx_tasks` 是真表，v27 迁移会把它搬进合并表并改成视图；`task-unified-view.cjs` 只读投影在阶段 1 需要同时接受 `type IN ('table','view')`（见 §4 阶段 1）。
- **是否需要兼容视图/双写**：需要。阶段 1 的 **同名可写视图** 就是过渡期兼容层；**不需要双写**（合并表是唯一物理真值，视图是它的投影）。
- **降级路径**：只能"恢复 v26 备份文件 + 回退二进制"。计划里必须把这条写进发布说明。

---
## 4. 代码改动清单（按文件:函数:行 → 改什么）

### 阶段 1 · 兼容层（建合并表 + 可写视图；两套旧 SQL 零改动可用）

| 文件:函数:行 | 改动 |
|---|---|
| 新增 electron/dx-task-merge-schema.cjs | 合并三表 DDL + 视图 + 触发器 + 索引的**唯一真值**；导出 `applyTaskTableMergeLayer(db)` |
| identity-store.cjs:92 `SCHEMA_VERSION` | 26 → 27 |
| identity-store.cjs:1600-1622 `MIGRATIONS` | 追加 `{version:27, run:applyTaskTableMergeLayer, foreignKeysOff:true, backupBefore:true}` |
| identity-store.cjs:1780-1795 `#migrate()` | 支持 `foreignKeysOff`（BEGIN 前 OFF、COMMIT 后 ON）与 `backupBefore`（`VACUUM INTO`）；迁移体内新增 `PRAGMA foreign_key_check` 自检 |
| identity-store.cjs:1753-1759 `open()` | 在 `#migrate()` 前做备份（仅当 user_version < SCHEMA_VERSION） |
| task-unified-view.cjs:166-179 `requireTables` | 接受 `type IN ('table','view')`（阶段 1 允许 `dx_tasks` 是视图）；**不放宽**缺表就报错的语义 |
| 12 个测试文件的 37 处 `26` | 机械改成 `27`（精确等值断言不变，非放宽）；3 处 `user_version=27` 改 `28` |
| tests/dxos-agent-migration.test.mjs:49-66 / :107-133 / :150-172 | "dx_ 表存在" 改为 "dx_ 入口存在（表或视图）"；回滚断言在 v22 建库时仍成立（v22 无合并表） |
| tests/dxos-task-unified.test.mjs:30 / :164-193 / :232-240 | 见 §5.1 R3/R4，需按新语义重写（不能删断言） |

**阶段 1 验收条件**
- 新建 v27 空库：`tasks/task_steps/task_events` 三表；`dx_tasks/dx_task_steps/dx_task_events` 三视图；`PRAGMA foreign_key_check` 为空。
- v26 真库升 v27：core+DX 行数守恒、9 张子表行数不变、`user_version=27`、备份文件存在且可单独打开。
- 用 `agent-task-store.cjs` 的 createTask / appendDynamicStep / appendTaskEvent / consumeBudget / completeStep / deleteTask 全链路跑通（此时走视图）。
- `node --test` 跑 §1.3 中受影响的测试文件全绿（版本字面量更新后）。

**阶段 1 回滚点**：v26 备份文件 + 二进制回退。迁移失败自动回滚，无需人工。

### 阶段 2 · 切换读写（DX SQL 改走合并表规范列；统一读模型改为单源）

| 文件:函数:行 | 改动 |
|---|---|
| agent-task-store.cjs:341-1605（80 处 SQL） | `dx_tasks`→`tasks` 且 `id`→`task_id`、补 `AND record_source='dx'`；`dx_task_steps`→`task_steps`；`dx_task_events`→`task_events` |
| agent-task-store.cjs:666-684 `consumeBudget` | 保留 `RETURNING`；确认合并表直连行为与 v26 一致 |
| task-unified-view.cjs:332-367/431-486 | 改为**单源投影**：`SELECT ... FROM tasks`，source 由 `record_source` 得出；删除 `UNIFIED_VIEW_ERR_AMBIGUOUS` 分支 |
| agent-runtime-workspace.cjs:328 | 修 `UPDATE task_steps SET output_json=?,output_ref=? WHERE step_id=? AND record_source='dx'`（当前写错列与主键，见 R10） |
| agent-service.cjs:616-624 `agent/task/unified-list` | 保持命令名与返回形状；`counts` 改为按 `record_source` 统计 |
| src/projects/taskConsoleLogic.ts（U1 未提交改动） | 统一列表 source 由 `record_source` 决定；core/DX 通道判定不变 |
| src/projects/TaskConsole.tsx:357 | 无接口变化（仍调 unified-list） |

**阶段 2 验收条件**
- core 7 态与 DX 11 态的所有状态迁移用例全绿（task-domain.test.mjs + dxos-agent-task-store.test.mjs）。
- 同名 id 在 v27 库中只会有一条（无歧义）；`getUnifiedTask({id})` 返回该条而不是报 AMBIGUOUS。
- agent-runtime-workspace 的提交 Journal 路径可真正写回步骤产物（有针对性测试）。
- 并发/重启用例（d4-main-e2e、dxos-agent-runtime）全绿。

**阶段 2 回滚点**：把 agent-task-store / task-unified-view 的改动整体还原（视图仍在，旧 SQL 仍可用）；数据无需回滚。

### 阶段 3 · 清理旧表与兼容层

| 文件:函数:行 | 改动 |
|---|---|
| 删除 v27 的 `dx_tasks/dx_task_steps/dx_task_events` 视图与全部 INSTEAD OF 触发器（新迁移 v28，或直接改 v27 的发布形态） | 清理 |
| dxos-agent-schema.cjs:65-79 | 从"生成的三表 DDL"改为"合并后的列映射说明"或标注 deprecated（**需同步改 scripts/extract-dxos-agent-schema.mjs 与 dxos-agent-schema.test.mjs:50-54 的逐字一致断言**） |
| task-unified-view.cjs | 若不再需要统一投影则整体退役；或保留为纯展示映射（无 SQL 合并） |
| dx_task_approval_bridge | **不清理**（仍是审批身份桥） |

**阶段 3 验收条件**：全仓 grep 无 `dx_tasks`/`dx_task_steps`/`dx_task_events` 的 SQL 字面量（除历史迁移与文档）；所有表相关测试全绿；`node --test tests/*.test.mjs` 全绿。
**阶段 3 回滚点**：阶段 3 之前打一次 full DB 备份；视图与触发器的删除可逆（重新创建）。

---

## 5. 风险、不建议做的部分，与替代方案

### 5.1 高风险点（按严重度）

- **R1（致命）DROP TABLE 的 CASCADE 静默删数据**。实测 §7.2 EXP1/EXP2/EXP3：FK=ON 时 `DROP TABLE tasks` 会连带清空 9 张子表；且事务内 `PRAGMA foreign_keys=OFF` 是 no-op。任何"在现有 `transactSync` 里直接 DROP 父表"的实现都会在真实用户库上**永久删掉全部任务步骤/事件/审批/预算/产物记录**。缓解：执行器必须在事务外关 FK；不满足这一条就**不要做**。
- **R2（高）SCHEMA_VERSION 26 是冻结基线**。37 处精确断言分布在 12 个文件（§1.3）。把 26 改 27 本身不算"放宽断言"，但它是**跨 12 个文件、必须同步**的机械改动，漏一处就红。且 `SchemaTooNewError` 会拒开旧程序，生产环境**不可回退二进制**。
- **R3（高）统一读模型的歧义语义消失**。dxos-task-unified.test.mjs:164-193 断言同名 id 必须报 `UNIFIED_VIEW_AMBIGUOUS_SOURCE`；合并后不可能再有同名 id，该分支成为死代码。必须重写该用例（不能删断言了事）。
- **R4（高）"脏状态"用例不可构造**。dxos-task-unified.test.mjs:232-240 往 `dx_tasks` 写 `status='mystery'`。合并后表上有 CHECK，任何非法状态（连 'mystery'）都写不进去，这个防御性用例在 v27 库上**物理上无法复现**。要么接受该用例退役，要么放弃 CHECK（=削弱 core 7 态硬约束）。这是"能不能同时保住两套语义"的直接反例。
- **R5（中）6 处 NOT NULL 放宽**：core 的 `user_id/app_id/goal`、DX 的 `project_id/thread_id/title/instruction`。合并后库层不再保证任一来源的必填字段；core `tasks` 的非空约束是既有边界（task-store.cjs:12 的 INSERT 依赖它）。
- **R6（中）同名 id 冲突需人工决策**。实测 §7.12：`dup_1` 在两套表同时存在时强行合并报 `UNIQUE constraint failed`。必须预检并 fail closed；自动改 id 会让 `dx_task_approval_bridge`、`deliverables.task_id`、`agent_runs.task_id` 等**按值引用**的外围数据失联。
- **R7（中）视图丢默认值**。实测 `NOT NULL constraint failed: tasks.resume_safe`；触发器必须逐个 `COALESCE(NEW.col, default)`。40+ 列的 INSERT 触发器极易漏一个默认值，而漏了只有在特定写入路径才炸。
- **R8（中）生成文件"单一真值"被破坏**。dxos-agent-schema.cjs 顶部声明"机械生成、勿手改"，dxos-agent-schema.test.mjs:50-54 断言它与抽取脚本**逐字一致**。合并后 DX 三表不再是生成文件的内容，这条守卫要么删除（放宽），要么重写脚本语义。
- **R9（中）9 张子表 FK 的隐性依赖**。重建父表期间它们短暂悬空；任何在迁移中途 panic 又没走事务回滚的路径都会留下悬空 FK。缓解：单事务 + 提交前 `foreign_key_check`。
- **R10（中）已存在的跨表写错列 bug 不会被合并修好**。agent-runtime-workspace.cjs:322 从 `dx_task_steps` 读，:328 却写 core `task_steps SET output_json=? WHERE id=?`（core 表既无 output_json 也无 id），异常被 :329 的 `catch {}` 吞掉，**提交产物从未真正写回步骤**。合并后没有 `id` 物理列，这条 SQL 仍会报 `no such column: id`，bug 依旧。必须单独修。
- **R11（中）与未提交的 U1 UI 改动正面冲突**。工作树里 TaskConsole.tsx/taskConsoleLogic.ts/coreTaskConsole.ts 正把 core 任务叠到统一列表上，前提是"两套命令域分开"。合并会改变 source 判定与 unified-list 的语义，需要与 U1 作者同步。
- **R12（低）迁移夹具会反复重放**。多个测试用 `buildDb(file, upTo)` 逐级执行 MIGRATIONS 再升级（dxos-agent-migration.test.mjs:32-43）。v27 必须能在只跑到 v22/v21 的库上正确重建，且不能假设 dx_ 表存在（v22 时不存在）。守卫要写成"表或视图存在才处理；不存在跳过"。

### 5.2 替代方案 A（我的推荐）：保留双表 + 只读统一视图 + 单一写入口

**做法**
1. 保留 `tasks/task_steps/task_events` 与 `dx_tasks/dx_task_steps/dx_task_events` 物理表，不动 9 张子表、不动 core 的 7 态 CHECK、不动 DX 的 11 态。
2. 新增 v27（或幂等 `ensure`）只创建**只读** `CREATE VIEW v_task_unified / v_task_step_unified / v_task_event_unified AS SELECT ... 'core' AS source ... UNION ALL SELECT ... 'dx' AS source ...`，把 `task-unified-view.cjs` 里的两段 SQL 提升为 SQL 视图（返回形状不变，仍是只读）。
3. 新增 `electron/task-authority.cjs` 作为**唯一写入口**：按 source 分发到对应表；禁止其它模块直写两张表（用现成的源码级守卫测试的模式）。
4. 修复 R10 的写错列 bug。

**代价对比**

| 维度 | 全量合并（§2/§3） | 替代方案 A |
|---|---|---|
| 数据迁移量 | 三表全量搬运 + DROP + 改名 | 0 行搬运，仅 CREATE VIEW |
| FK 风险 | 需要事务外关 FK，最危险 | 无 FK 改动 |
| 状态 CHECK | 必须扩成 18/10 值（分源可保住） | 原样不动 |
| SCHEMA_VERSION | 必须 27，37 处断言同步 | 建视图可放 v27（仅视图，无搬运）或独立 ensure；同步量更小、风险低 |
| 12 个测试文件 | 全部要改 | 仅 unified 相关 2 个文件要改 |
| 生成文件守卫 | 必须改脚本/删守卫 | 不动 |
| R3/R4 语义冲突 | 两个用例无法保留 | 全部保留，零冲突 |
| "单一读入口" | 达成 | 达成（SQL 视图） |
| "单一写入口" | 达成 | 达成（task-authority） |
| 长期表数量 | 3 张 | 6 张 + 3 视图 |

**判断**：合并的唯一净收益是"物理少 3 张表"；代价是改动一个已经冻结的 schema 版本、一个生成式 schema 守卫、一个被 12 个文件冻结的版本号，并主动丢掉两个（同名歧义、脏状态）防御性断言。以当前代码成熟度与测试密度看，**替代方案 A 的收益/风险比明显更好**。若产品坚持"库层只能有一张任务表"，再按 §2/§3 执行，但必须先落 §3.1 的四项前置。

### 5.3 我明确不建议做的

- **不建议在现有 `transactSync` 事务内 DROP `tasks`**（R1，会删数据）。
- **不建议在迁移里自动重命名冲突 id**（R6，外围按值引用会失联）。
- **不建议为了"合并"而删掉 core 7 态 CHECK 或 DX 状态投影映射测试**（等于放弃两套语义的守卫）。
- **不建议把 `dx_task_approval_bridge` 一起合掉**——它是身份桥，不是任务状态机。
- **不建议在未提交的 U1 UI 改动落地前做合并**（R11）。

---

## 6. 验证计划

### 6.1 新增测试（v27 合并路径）

1. `tests/dx-task-merge-migration.test.mjs`
   - 空库直接到 v27：三表存在、三视图存在、`foreign_key_check` 空。
   - v26 真库（含两套数据 + 9 张子表各一行）升 v27：逐表行数守恒、`record_source` 正确、`sqlite_sequence` = max(dx event id)。
   - 注入 `onMigration(27)` 抛错：`user_version` 停 26、`dx_tasks` 仍是表、`tasks` 仍 17 列、子表行数不变。
   - 重放：`PRAGMA user_version=26` 后再 open，数据不重复不丢失。
   - 备份：升级后备份文件存在且 `SELECT COUNT(*) FROM tasks` 与升级前一致。
2. `tests/dx-task-merge-views.test.mjs`
   - 通过 `dx_tasks` 视图 INSERT/UPDATE/DELETE 全链路（覆盖所有 DEFAULT 列，验证 COALESCE 默认值）。
   - `UPDATE dx_tasks ... RETURNING`（consumeBudget 路径）在命中/不命中两种情况下返回值正确。
   - `INSERT INTO dx_task_events ... SELECT`（appendTaskEvent 路径）成功且 id 递增。
3. `tests/dx-task-merge-status-check.test.mjs`
   - core+大写合法、core+小写被拒、dx+小写合法、dx+大写被拒、未知值被拒。
4. `tests/dx-task-merge-collision.test.mjs`
   - 构造同名 id，断言迁移 fail closed 并输出冲突清单，库保持 v26。

### 6.2 修改的既有测试

- 12 个文件的 37 处 `26 → 27`、3 处 `27 → 28`（精确等值，非放宽）。
- `tests/dxos-task-unified.test.mjs`：按 v27 单源语义重写"同名 id"与"脏状态"两个用例（**不能删断言**；改名、改期望为"单条返回 / 非法状态被 DB 拒"）。
- `tests/dxos-agent-migration.test.mjs`：`hasTable(dx_tasks)` → "入口存在（table 或 view）"；v22/v21 回滚断言保持。
- `tests/dxos-agent-schema.test.mjs`：若阶段 3 改生成文件，逐字一致断言需同步更新（阶段 1 不动）。

### 6.3 如何证明"合并后两套语义都保住"

- **core 7 态**：`task-domain.test.mjs` 全绿 + `tasks` 上 `record_source='core'` 的 status 只能取 7 个大写值（§6.1-3）。
- **DX 11 态**：`dxos-agent-task-store.test.mjs` 全绿 + `record_source='dx'` 只能取 11 个小写值；`dxos-agent-runtime/kernel/react-driver` 的领取/续跑/预算/回滚用例全绿。
- **统一映射**：`task-unified-view.cjs` 的 11×7 双向映射自检（assertStatusMapComplete）保持全绿；统一投影的 status/statusRaw/语义不变。
- **导出/导入**：v27 库用现有 `identity-bootstrap` 打开后，`platform-service` 的 migrations diagnostics（tests/dxos-platform.test.mjs:401）能报 current=27；把备份文件当独立库打开并跑同一组只读查询，结果一致。
- **跨版本升级**：`buildDb(upTo=22/21)` → open → 27 的重放用例（新增）。
- **并发**：复用 `tests/side-effect-real-contention.test.mjs` / `dxos-agent-kernel` 的并发夹具；重点验证 `claimNextTask`（agent-task-store.cjs:1218-1242）与 `consumeBudget` 在合并表上的原子性不变。
- **失败回滚**：`onMigration` 注入点（identity-store.cjs:1790）在 v27 抛错，断言整级回滚 + 备份可用。

---

## 7. 实验证据（真实命令与真实输出）

所有实验都在 /tmp 下的临时库副本上完成；未写入产品代码，未联网，未新增依赖。
环境：node v22.22.3，SQLite 3.51.3（`node:sqlite`）。

### 7.1 v26 真库结构实测

命令（脚本 /tmp/dxmerge-probe/dump-schema.cjs，用 IdentityStore 建 v26 临时库后 PRAGMA）：
~~~bash
node /tmp/dxmerge-probe/dump-schema.cjs 2>/dev/null
~~~
关键输出：
~~~
user_version=26
tables=131
tasks: task_id:TEXT(pk1), user_id:TEXT!, session_ref:TEXT, app_id:TEXT!, status:TEXT!, goal:TEXT!, ... （17 列）
task_steps: step_id..., task_id:TEXT!..., status:TEXT!, UNIQUE(task_id,sequence), FK tasks.task_id ON DELETE CASCADE
task_events: event_id:TEXT(pk1), task_id..., sequence:INTEGER!, event_type:TEXT!, created_at:INTEGER!, safe_payload:TEXT
dx_tasks: 39 列, 无外键, 无 CHECK
dx_task_steps: 15 列, operation_id UNIQUE, UNIQUE(task_id,ordinal)
dx_task_events: id INTEGER PRIMARY KEY AUTOINCREMENT, 7 列
dx_task_approval_bridge: PK(dx_task_id,dx_step_id), core_task_id/core_step_id/core_run_id 各 UNIQUE
~~~

外键图：
~~~bash
node /tmp/dxmerge-probe/fk-graph.cjs 2>/dev/null
~~~
~~~
--- FK referencing tasks(task_id) [9] ---
side_effect_calls / task_artifacts / task_budgets / task_events / task_harness_runs /
task_model_calls / task_steps / task_tool_proposals / task_verifications
--- tables referencing dx_tasks(id) via FK ---
(none - dx tables have no FKs by design)
~~~

### 7.2 FK 语义实验

命令：`node /tmp/dxmerge-probe/fk-rebuild-experiment.cjs 2>/dev/null`
~~~
EXP1 FK=ON, DROP parent -> child rows = 0 (FK cascade 会删子行)
EXP2 inner pragma value = 1
EXP2 child rows = 0
EXP3 child rows = 0
EXP4 child rows=1 parent rows=1
EXP4 child FK -> [{"table":"parent","from":"pid","to":"id"}]
EXP4 foreign_key_check violations = []
EXP5 legacy=ON child.sql = CREATE TABLE child(pid TEXT REFERENCES "parent_old"(id))
EXP5 legacy=OFF child.sql = CREATE TABLE child(pid TEXT REFERENCES "parent_old"(id))
~~~
结论：FK=ON 时 DROP 父表会 cascade 删子行；事务内关 FK 无效；官方"新建→搬运→DROP→改名"配方在 FK 事务外关闭时有效，且不会改写子表 FK；RENAME 父表会改写子表引用（不该先 RENAME 旧表）。

### 7.3 完整合并迁移实验（v26 → v27，含可写视图）

命令：`node /tmp/dxmerge-probe/merge-migration-v2.cjs 2>&1`
~~~
PREFLIGHT 同名冲突数 = 0
IN-TX foreign_key_check 违规 = []
MIGRATE COMMIT ok
--- 迁移后校验 ---
tasks 行数 core=1 dx=1
task_steps core=1 dx=2
task_events core=1 dx=2
core task 保留 = {"task_id":"core_t1","user_id":"u1","status":"RUNNING","goal":"core 目标","revision":1,"cancel_requested":0}
dx task 经视图读 = {"id":"dx_t1","title":"DX 标题","status":"running","mode":"actions"}
dx task 经合并表读 = {"task_id":"dx_t1","title":"DX 标题","status":"running","mode":"actions","record_source":"dx"}
9 个 FK 子表行数 = {"task_model_calls":1,"task_harness_runs":1,"task_artifacts":1,"task_verifications":1,"task_tool_proposals":1,"task_budgets":1,"side_effect_calls":1}
FK(task_steps) = ["tasks.task_id->task_id"]
sqlite_sequence = [{"name":"task_events","seq":3}]
dx_task_events 视图行 = 2
视图写 dx_t2 = {"task_id":"dx_t2","status":"running","resume_safe":1,"mode":"actions","attempt_no":0,"delegation_depth":0}
视图写 dx_s3 = {"step_id":"dx_s3","status":"queued","plan_version":1,"attempt":1}
视图写新事件 id = 4
PREFLIGHT 同名冲突数 = 0
MIGRATE ROLLBACK: INJECTED_FAILURE_AFTER_DDL
--- 回滚注入校验 ---
回滚后 user_version 仍=26? 26
回滚后 dx_tasks 类型 = table，行数=1
回滚后 tasks 列数 = 17
~~~
（第一次运行时事件搬运顺序写反，报 `UNIQUE constraint failed: task_events_v27.id` 并整级回滚——这正好验证了事务回滚有效，也因此确定了"先 dx 显式 id、后 core"的正确顺序。）

### 7.4 分源状态 CHECK 实验

命令：`node /tmp/dxmerge-probe/status-check-experiment.cjs 2>/dev/null`
~~~
core+RUNNING   => OK
core+queued    => REJECT: CHECK constraint failed: ...
dx+running     => OK
dx+waiting_children => OK
dx+RUNNING     => REJECT: CHECK constraint failed: ...
默认 source 行 + SUCCEEDED => OK
默认 source 行 = {"task_id":"f","status":"SUCCEEDED","record_source":"core"}
~~~

### 7.5 DX 表 grep 计数

命令：`grep -rn "\bdx_tasks\b" electron/*.cjs | wc -l`（实测用等价 ripgrep 词边界）
~~~
dx_tasks       = 88  (task-unified-view 5, dxos-agent-schema 17, agent-runtime-workspace 1,
                          identity-store 1, agent-runtime-manager 3, dx-task-approval-schema 1,
                          main 1, dx-task-approval-bridge 2, agent-domain 1, agent-task-store 56)
dx_task_steps  = 38  (agent-task-store 21, dxos-agent-schema 7, task-unified-view 4,
                          dx-task-approval-bridge 3, agent-runtime-workspace 1,
                          dx-task-approval-schema 1, identity-store 1)
dx_task_events = 25  (task-unified-view 9, dxos-agent-schema 9, agent-task-store 6, identity-store 1)
~~~

### 7.6 DX SQL 逐行 → 函数映射

命令：`node /tmp/dxmerge-probe/dx-writepoints.cjs`
输出 80 行（行号 + 函数 + SQL 片段），已归纳进 §1.2.1，故此处略。

### 7.7 测试用例计数

命令：`node --test <files>` 前的源码计数（`^\s*(test|it)\(`）
~~~
tests/dxos-agent-schema.test.mjs             tests=7
tests/dxos-agent-migration.test.mjs          tests=7
tests/dxos-agent-task-store.test.mjs         tests=16
tests/dxos-agent-runtime.test.mjs            tests=30
tests/dxos-agent-kernel.test.mjs             tests=24
tests/dxos-agent-ipc.test.mjs                tests=9
tests/dxos-task-unified.test.mjs             tests=7
tests/dxos-task-unified-ipc.test.mjs         tests=3
tests/dxos-task-console.test.mjs             tests=42
tests/dxos-mcp-dx-task-approval-bridge.test.mjs tests=5
tests/task-store.test.mjs                    tests=5
tests/task-domain.test.mjs                   tests=15
tests/migration.test.mjs                     tests=10
tests/dxos-foundation.test.mjs               tests=23
tests/dxos-media.test.mjs                    tests=14
tests/dxos-agent-react-driver.test.mjs       tests=9
tests/task-harness-security.test.mjs         tests=3
tests/tool-dsh-e2e.test.mjs                  tests=3
tests/d4-main-e2e.mjs                        0（脚本）
~~~

### 7.8 任务相关测试现状基线（v26，全绿）

命令：
~~~bash
node --test --test-concurrency=1 tests/dxos-agent-schema.test.mjs tests/dxos-agent-migration.test.mjs \
  tests/dxos-task-unified.test.mjs tests/dxos-task-unified-ipc.test.mjs \
  tests/task-domain.test.mjs tests/dxos-mcp-dx-task-approval-bridge.test.mjs
~~~
~~~
# tests 44
# pass 44
# fail 0
~~~
~~~bash
node --test --test-concurrency=1 tests/task-store.test.mjs tests/dxos-agent-task-store.test.mjs \
  tests/migration.test.mjs tests/dxos-foundation.test.mjs
~~~
~~~
# tests 54
# pass 54
# fail 0
~~~

### 7.9 SCHEMA_VERSION=26 冻结断言清单

命令：`grep -rn "SCHEMA_VERSION, 26\|schemaVersion, 26" tests/`
~~~
共 37 处，分布于：side-effect-migration(1) dxos-agent-migration(6) task-orchestration-migration(1)
task-store(1) authorization-app-grant-scope(3) tool-execution-migration(1) tool-migration(1)
device-migration(1) dxos-media(3) identity-session-expiry(2) migration(4) d5-03-reset-device-identity(4)
identity-store(1) dxos-foundation(5)
另有 3 处 user_version = 27（高版本拒开）：dxos-agent-migration:138 / migration:293 / dxos-media:153
~~~

### 7.10 视图 UPDATE ... RETURNING 语义

命令：`node /tmp/dxmerge-probe/view-returning-experiment.cjs 2>/dev/null`
~~~
V4b RETURNING matched = {"n":6}
V4c RETURNING no-match = undefined
V4 final t.n = 6
V4d table RETURNING = {"n":7}
~~~
结论：`consumeBudget`（agent-task-store.cjs:681）经视图仍能正确判"是否命中"，阶段 1 不受影响。

### 7.11 备份机制实验

命令：`node /tmp/dxmerge-probe/backup-experiment.cjs 2>/dev/null`
~~~
DatabaseSync.backup 类型 = undefined
VACUUM INTO 成功, 备份存在=true
事务内 VACUUM INTO 失败: cannot VACUUM from within a transaction
备份内容 = [{"x":1}]
~~~

### 7.12 同名 id 冲突实验

命令：`node /tmp/dxmerge-probe/collision-experiment.cjs 2>/dev/null`
~~~
冲突预检 SQL: SELECT t.task_id FROM tasks t JOIN dx_tasks d ON d.id = t.task_id
结果 = [{"task_id":"dup_1"}]
强行合并结果：UNIQUE constraint failed: t2.task_id（errcode=1555）
~~~

### 7.13 视图兼容层边界实验

命令：`node /tmp/dxmerge-probe/view-compat-experiment.cjs 2>/dev/null`
~~~
V1 view insert -> tasks rows=[{"task_id":"t1","id":"t1","status":"queued","record_source":"dx"}]
V5 INSERT..SELECT into view ok
V8 sqlite_master type = view
V9 requireTables(type=table) sees dx_tasks? false
~~~
结论：视图可写；但 `task-unified-view.cjs:169` 用 `type='table'` 判存在，迁移后必须放宽为 `type IN ('table','view')`。

---

## 8. 未完成 / 未验证项

1. **未在 Electron 主进程真实启动路径上验证**（只跑了 node 层探针与 `node --test`；未跑 `npm run build`，未起 Electron）。
2. **未验证 WAL 模式下的备份一致性**：实验用默认 journal；产品库是 `journal_mode=WAL`（identity-store.cjs:1720），`VACUUM INTO` 在 WAL 下的一致性未实测（理论上安全，但未取证）。
3. **未验证大规模数据性能**：迁移在三五行上验证；真实库若数十万行事件，重建耗时/临时磁盘未测。
4. **未验证并发写入下的迁移**：迁移在 `open()` 单连接内完成，未测"另一进程同时写"（产品是单进程主库，风险低但未证）。
5. **阶段 2/3 的代码改动只给了清单与验收条件，未落地**（本阶段按要求只产出方案）。
6. **未改动任何测试**：37 处版本字面量、unified 的两个语义冲突用例仍是 v26 形态；§6.2 列出的改动未执行。
7. **DX OS 源（ccsDb.ts）未复核**：`DXOS_SRC` 指向 /Users/wepingli/Downloads 下的 DX OS 0.5.1，本机该路径未确认存在；dxos-agent-schema.test.mjs:50-54 / :155-171 两个用例在源缺失时会 skip，因此"生成文件与源逐字一致"这条守卫本次**未实际执行**（测试报告里计入 pass 的 skip 项）。若后续要动生成文件，必须先确认源可用。
8. **替代方案 A 未做原型**：只做了成本对比，未在临时库上跑 `v_task_unified` 视图。
