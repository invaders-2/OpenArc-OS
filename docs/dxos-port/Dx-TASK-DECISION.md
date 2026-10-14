# Dx-TASK-DECISION · 任务域「双表并存 vs 表级合并」决策文档

> 状态：**待用户裁决**。本文件只陈述事实、取舍与验收要求，**不替用户决定是否做方案 B**。
> 范围：任务域 Task 表的读模型与表结构；不涉及 CSP / tokens.css / 既有界面 / 依赖。
> 本轮已交付：方案 A 的「单一读模型 + 明确边界」实现（见 §5），未做任何表级合并。

---

## 1. 背景与问题

OpenArc 任务域现在**同时存在两套表**，各自服务不同链路：

| | DX 源（新表） | core 源（既有表） |
|---|---|---|
| 表 | dx_tasks / dx_task_steps / dx_task_events | tasks / task_steps / task_events |
| 状态数 | **11 态** | **7 态** |
| 状态集合 | queued, planning, running, verifying, completed, waiting_user, waiting_children, paused, interrupted, failed, cancelled | PENDING, RUNNING, WAITING, SUCCEEDED, FAILED, CANCELLED, BLOCKED |
| 状态定义处 | electron/agent-task-store.cjs:54-67 | electron/task-domain.cjs:9-18、electron/identity-store.cjs:851（CHECK） |
| 建表处 | electron/dxos-agent-schema.cjs:65-79（机械抽取自 DX ccsDb.ts） | electron/identity-store.cjs:846-908（v9） |
| 写入方 | electron/agent-task-store.cjs | electron/task-store.cjs |
| 服务链路 | Agent 任务域状态机 | DSH / ACP Task Runtime（Task Authority） |
| 主键列 | id | task_id（子表 task_id / step_id / event_id） |
| 状态约束 | 无 CHECK | tasks.status 有 CHECK 七态；task_steps.status 有 CHECK 六态 |

问题：**没有统一读入口**。使用方（UI / 报表 / 运维命令）必须自己判断该读哪张表、两边的状态字符串该怎么理解；同一条业务可读错表或读错状态语义。DX 侧 planning / verifying / waiting_children / paused / interrupted 在 core 侧根本没有同名字面，直接比较状态必然出错。

已确认的相关事实（P0 取证，docs/dxos-port/Dx-P0-TABLE-CONFLICT.md）：
- tasks / task_steps / task_events 是与 DX 的**同名异列**冲突表，P0 的处理原则是「迁移只新增表、不动既有表结构」，DX 侧因此改名 dx_*。
- DX 抽取时**去掉了外键**（dxos-agent-schema.cjs:11、:30-31 注释写明：主键列名不同，保留 REFERENCES 会在删除任务时炸，且会拖住 OpenArc 侧的 DROP/重建）。
- 两套 id 命名空间独立：dx_tasks.id 与 tasks.task_id 都可以是同一个字符串（本轮测试已用同 id 场景固化）。

---

## 2. 方案 A：保持双表 + 统一读模型（本轮已实现）

### 做法
新增**只读**模块 electron/task-unified-view.cjs，把两套任务归一成同一投影：
- 统一字段：id / source("dx"|"core") / key / title / status / statusRaw / statusMapping / createdAt / updatedAt / startedAt / completedAt / stepCount / eventCount / lastEvent / readOnly。
- core 没有 title，统一投影取 goal；DX 用 title。
- 状态显式映射：DX_TO_CORE_STATUS（11→7）、CORE_TO_DX_STATUS（7 个规范代表）、CORE_TO_DX_STATUSES（7→全部来源集合）。
- 边界写死在模块与返回值：「这是读模型：不写任何表、不改变任何一方状态机。」（UNIFIED_VIEW_BOUNDARY）。
- 接入一条只读命令 agent/task/unified-list（risk=read，credential=false）。

状态映射表（显式，11 行）：

| DX 11 态 | core 7 态 | 语义 |
|---|---|---|
| queued | PENDING | 已入队，尚未开始执行 |
| planning / running / verifying | RUNNING | 正在执行（DX 的规划 / 执行 / 校验都归入） |
| waiting_user / waiting_children | WAITING | 等待外部输入（用户回答或子任务） |
| completed | SUCCEEDED | 已成功完成（终态） |
| failed | FAILED | 已失败（终态） |
| cancelled | CANCELLED | 已取消（终态） |
| paused / interrupted | BLOCKED | 已停止但可续接（暂停 / 中断） |

### 优点
1. **零 schema 变更、零数据迁移**：不动任何一张既有表，DX 只读、core 只读。
2. **零状态机改动**：两套写入方与状态机一字未改，DX 11 态 / core 7 态都原样保留在 statusRaw。
3. **风险面最小、可回退**：删掉新增模块与命令即回到现状；没有不可逆的迁移。
4. **使用方立刻有唯一读入口**，且映射表可被审计（「同一条任务为什么显示这个状态」有据可查）。
5. 不满足的语义（脏状态）**显式暴露**：status=null + statusMapping.complete=false，不猜。

### 代价 / 风险
1. **两套表继续并存**：写路径仍是两条，长期存在「哪边是权威」的认知成本；读模型只解决「读得对」，不解决「写得顺」。
2. **多对一语义近似**：planning/running/verifying 在统一投影里都显示 RUNNING，需要细分时必须回看 statusRaw（投影已保留）。
3. 读模型是**投影**，不是约束：未来任一方改状态集合时，映射表必须同步更新并有测试兜底（本轮已把 11×7 全覆盖写成断言）。
4. 跨表的**聚合/排序/分页**只能在读模型内做（本轮已做稳定排序与 limit），无法享受单表的索引与约束。

---

## 3. 方案 B：表级合并（**本轮不做**，供用户裁决）

即把 core 7 态 tasks/task_steps/task_events 与 DX 11 态合并成**一套表、一个状态机**（或 DX 写回 core 表）。

### 3.1 为什么不是「改一下 CHECK 就行」

SQLite **不支持通过 ALTER TABLE 修改或删除 CHECK 约束**。core tasks.status 的 CHECK 在 electron/identity-store.cjs:851，只允许 7 态；要让 11 态落进同一列，唯一正路是 **12 步表重建**：建新表 → 拷数据 → 建索引/子表引用 → 删旧表 → 改名 → 校验。用 PRAGMA writable_schema 改写 sqlite_master 属于未定义行为，不作为方案。

### 3.2 具体代价（逐条，可核对）

1. **必须重建 tasks 表以改 CHECK 约束**（见 §3.1）。core task_steps.status 也有 CHECK 六态（identity-store.cjs:873），一并要重建。
2. **列集不对等**：core tasks 17 列（identity-store.cjs:846-864）；DX dx_tasks 39 列（dxos-agent-schema.cjs:66，其中 21 列是源里 ALTER TABLE ADD COLUMN 追加的）。合并后要么取「可空超集」，要么给缺失列定义默认值 —— 这是一个需要单独设计的 schema 决策，不是机械拼列。
3. **影响 D5 侧约 1500+ 条不变量测试**（任务书口径）。
   本机离线实测（grep -lE "TaskStore|task-store|task_events|task_steps|task-domain|taskService" tests/*.test.mjs）：
   - 引用 core 任务表 / task-store / task-domain 的测试文件 **72 个**；
   - 其中顶层 test() **615 个**、assert.* **6074 条**。
   两套口径不同（「不变量」与顶层 test 不同），保守结论是「**数百个测试、数千条断言级**的回归面」；任何列名 / 状态集合 / 主键名变更都会波及这一片。
4. **迁移需要数据回填**：
   - DX 的 planning / verifying / waiting_children / paused / interrupted 在 core 7 态 CHECK 里**没有对应值**；反向 core 的 7 态也没有 DX 的细分。回填必须先决定「升 CHECK 到 11 态超集」还是「降级到 7 态」。
   - 降级会**丢失可续接语义**（paused/interrupted 与 WAITING/BLOCKED 不可互换），且不可逆；升级则要同时扩两处 CHECK。
   - 主键列名不同（id vs task_id）与**两套 id 命名空间可能同名**，回填前要定义去重规则并留存来源列（否则无法回滚）。
5. **回滚方案是硬要求**：合并后要把行拆回两张表，必须持久化「来源」（如 source 列）与原始主键，否则回滚只能靠备份；迁移脚本必须提供幂等回滚与失败点续跑。
6. **外键连锁**：core 有 9+ 张子表 REFERENCES tasks(task_id) ON DELETE CASCADE（identity-store.cjs:870,886,901,921,937,950,969,1035,1115,1141）；DX 侧子表无外键。合并要统一引用，重建期间必须处理 PRAGMA foreign_keys 与子表引用重定向。
7. **写入方与读取方都要改**：agent-task-store.cjs（DX 写）、task-store.cjs（core 写）、agent-kernel-supervisor.cjs、agent-react-driver.cjs、agent-kernel-inspection.cjs、task-harness-orchestrator.cjs 等；改动面远超读模型。
8. **这是一次不可逆的数据结构决策**，与既有「迁移只新增表、不动既有表结构」的项目惯例（P0 原则）相反。

### 3.3 方案 B 的潜在收益
- 单表即可完成跨来源聚合/排序/分页，索引与 CHECK 约束由数据库保证；
- 长期只有一个权威任务状态机，消除「该读哪张表」的认知成本；
- 未来不再需要维护状态映射表。

---

## 4. 当前选择与理由（**方案 A**）

本轮选择 **A（保持双表 + 统一读模型）**，理由按优先级：

1. **低风险统一**是本轮任务的明确边界（任务域「单一读模型 + 明确边界 + 决策文档」，「不做表级合并」）。
2. 方案 B 的核心代价（重建表改 CHECK + 数据回填 + 回滚 + 1500+ 条测试回归面）**远超本轮授权**，且属于不可逆数据结构变更；按项目规则，这属于需要用户裁决的决策边界。
3. 方案 A 已经解决「使用方读错表 / 读错状态」的现实问题，并给出了可审计的显式映射与边界断言；B 的收益（写路径统一）不是当前阻塞项。
4. A 不阻断 B：读模型把两套语义的差异**显式化**了（映射表 + statusRaw），这正是将来做 B 时设计迁移/回填规则的直接输入。

**本轮不替用户决定 B。**

---

## 5. 本轮已交付（方案 A 落地证据）

| 产物 | 位置 | 说明 |
|---|---|---|
| 只读统一读模型 | electron/task-unified-view.cjs | 只 SELECT；零 require；不写任何表 |
| 命令登记 | electron/agent-domain.cjs（task 段） | agent/task/unified-list，risk=read，credential=false |
| 命令分发 | electron/agent-service.cjs:613-621 | 注入真 db；读模型错误 → Agent 域错误码映射 |
| 边界测试 | tests/dxos-task-unified.test.mjs | (a) 只读行数/哈希不变；(b) 同名 id 不串；(c) 11×7 双向全覆盖；(d) 源码级无写穿 |
| IPC 测试 | tests/dxos-task-unified-ipc.test.mjs | 走真 registerAgentIpc 全链路；只读哈希不变；结构化错误 |
| 既有 IPC 测试更新 | tests/dxos-agent-ipc.test.mjs | 白名单 27 → 28，health.commands 同步 |

验收命令（离线，本机实测全绿）：

~~~
node --test tests/dxos-task-unified*.test.mjs tests/dxos-agent-ipc.test.mjs tests/task-store.test.mjs tests/task-domain.test.mjs
~~~

读模型边界（写死在代码与返回值）：**这是读模型：不写任何表、不改变任何一方状态机。**

---

## 6. 若要选 B，需要哪些前置与验收

> 以下只列出「做 B 之前必须先具备什么、做完怎么验收」，不代表本轮或后续默认要做 B。

### 6.1 前置（缺一不可）
1. **用户明确批准**把「迁移只新增表、不动既有表结构」的 P0 原则对任务域开例外。
2. **状态集合裁决**：合并后状态机采用 11 态超集、7 态子集，还是重新设计；planning/verifying/waiting_children/paused/interrupted 的去留与语义必须逐条定稿。
3. **列集对齐设计**：core 17 列与 DX 39 列的合并表 DDL（含可空性、默认值、废弃列处理），并评审是否新增 source 列以保留回滚能力。
4. **迁移脚本**：建新表/拷数据/重建索引与子表引用/切换的完整脚本，且**幂等 + 可断点续跑**；必须附**回滚脚本**（把合并行拆回两张表）。
5. **id 冲突规则**：同名 id 的去重/改名规则，迁移前做一次全库冲突扫描并出清单。
6. **外键策略**：重建期间 PRAGMA foreign_keys 的处理与 9+ 张子表的引用重定向方案。
7. **回滚演练**：在真实规模的数据副本上跑「迁移 → 业务读写 → 回滚」，记录耗时与失败点。
8. **改动清单评审**：所有写入方/读取方（agent-task-store / task-store / supervisor / react-driver / inspection / orchestrator / UI 读取点）逐文件列改动与测试影响。

### 6.2 验收
1. **数据一致性**：迁移前后行数与内容可对账（含状态映射前后语义可解释），DX 侧 11 态与 core 侧 7 态无丢失、无伪造。
2. **状态机**：合并后状态迁移表有显式定义，非法迁移被拒绝；CHECK 约束覆盖全部合法状态。
3. **回滚**：回滚后两套表行数/内容与迁移前一致（哈希对账），且可再次正向迁移。
4. **测试**：本轮 tests/dxos-task-unified*.test.mjs 改为针对合并后单表仍成立（或明确标注废弃），并跑通 D5 侧全部受影响回归（§3.2 第 3 条的 72 文件 / 615 test() 面）。
5. **只读/写路径**：所有既有 read 路径结果与迁移前语义等价；新增/改动的写路径有事务与并发测试。
6. **性能**：核心查询（队列领取、按 project 列表、事件增量）在真实规模下不劣化，且索引覆盖。
7. **审计**：迁移过程留痕（每次数据变更的计数与校验和），失败可定位。

---

## 7. 未验证 / 待核对

- 任务书「约 1500+ 条不变量测试」为**给定口径**；本文件 §3.2 第 3 条是**另一种口径的本机实测**（72 文件 / 615 test() / 6074 assert），两者不可直接等同，结论取「数百测试、数千断言量级」。
- DX 侧 ccsDb.ts 原文中 tasks 表的完整约束（是否有 TRIGGER / 视图 / 更多索引）本轮未逐条核对；dxos-agent-schema.cjs 只抽取了 CREATE TABLE / ALTER ADD COLUMN / 索引。
- 方案 B 的迁移耗时、库体积增长、索引重建成本未实测（无真实规模数据副本）。
- 本轮未改动任何构建产物 / 界面；agent/task/unified-list 目前只有 IPC 与测试接入，尚未被任何 UI 消费（属于后续可选接入点）。
- **已知交叉影响（不属本轮范围）**：后端 agent 命令白名单因本条只读命令从 27 条变为 28 条，而界面侧镜像 src/projects/taskConsoleLogic.ts 仍是 27 条，`tests/dxos-task-console.test.mjs` 的「界面白名单 == 后端白名单」断言因此失败（1 条）。按硬约束「不改既有界面」，本轮未改该 UI 文件。若后续授权，最小修复 = 在该文件 AGENT_COMMANDS 数组 task/stats 之后补一行 agent/task/unified-list，并把该测试的 27 改为 28；TASK_CONSOLE_COMMANDS（界面真正会发出的命令集）不含该命令，且 TaskConsole.tsx:198 仍按 TASK_CONSOLE_COMMANDS 拦截，故界面可见行为不变。
