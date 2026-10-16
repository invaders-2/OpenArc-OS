/**
 * 单一读模型边界断言（全离线；不联网、不新增依赖）。
 *
 * 覆盖任务书第 2 条四类断言：
 *   (a) 只读：调用前后两套表的行数与哈希不变；
 *   (b) 两边同名 id 不互相污染（显式 source 各查各的；省略 source 必须报歧义，不猜）；
 *   (c) 状态映射 11 态 × 7 态全覆盖且双向可解释；
 *   (d) 不存在"写穿"路径：源码级断言 + 子进程 require 缓存断言。
 *
 * 数据来源：真 IdentityStore（临时 :memory:）+ 真 agent-task-store（DX 写入方）
 *          + 真 TaskStore（core 写入方）—— 读模型读取的是真实写入方落下的行。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createTaskFixture } from "./task-fixtures.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(HERE, "..", "electron", "task-unified-view.cjs");
const view = require("../electron/task-unified-view.cjs");
const agentTaskStore = require("../electron/agent-task-store.cjs");

const USER = "u_unified";
const TABLES = ["dx_tasks", "dx_task_steps", "dx_task_events", "tasks", "task_steps", "task_events"];
const fixtures = [];
after(() => { for (const f of fixtures) { try { f.identity.close(); } catch { /* 已关闭 */ } } });

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

/** 六张表的行数 + 内容哈希（只读 SELECT）。 */
function snapshot(db) {
  const out = {};
  for (const table of TABLES) {
    const rows = db.prepare("SELECT * FROM " + table + " ORDER BY 1").all();
    out[table] = { count: rows.length, hash: sha256(JSON.stringify(rows)) };
  }
  return out;
}

/** 真库装配：IdentityStore 建表 + DX/core 两个真实写入方；再各落一条同名任务。 */
async function setup() {
  const f = await createTaskFixture({ dbPath: ":memory:" });
  fixtures.push(f);
  const db = f.identity.connection;
  agentTaskStore.resetAgentTaskStoreForTests();
  agentTaskStore.configureAgentTaskStore({ db, clock: f.clock, idFactory: () => crypto.randomUUID() });
  const project = agentTaskStore.createProject({ name: "统一读模型项目", rootNodeId: "root_unified", createdBy: USER });
  // DX 写入方：thinking + 显式 1 个文件动作 → 1 个 dx_task_step + 1 条 task.created 事件。
  const dxTask = agentTaskStore.createTask({
    projectId: project.id,
    instruction: "新建「dx-report.txt」",
    createdBy: USER,
    title: "DX 任务：单一读模型",
    executionProfile: "thinking",
    actions: [{ tool: "file.create", path: "dx-report.txt" }],
  });
  const sharedId = dxTask.id;
  // core 写入方：同一个 id，2 个 step + 1 条带 message 的事件。
  const coreTask = f.taskStore.insertTask({ taskId: sharedId, userId: USER, appId: "ai", status: "RUNNING", goal: "core 任务：DSH/ACP 链路", createdAt: 1000, updatedAt: 2000 });
  f.taskStore.insertStep({ taskId: sharedId, kind: "model", status: "SUCCEEDED", sequence: 1 });
  f.taskStore.insertStep({ taskId: sharedId, kind: "model", status: "PENDING", sequence: 2 });
  f.taskStore.appendEvent({ taskId: sharedId, eventType: "task.started", safePayload: { message: "core 已启动" }, at: 1500 });
  return { ...f, db, project, dxTask, coreTask, sharedId };
}

// ---------------------------------------------------------------------------
// (c) 状态映射 11 × 7 全覆盖且双向可解释
// ---------------------------------------------------------------------------

test("映射：DX 11 态 ↔ core 7 态全覆盖，且每个 core 有规范代表与全部来源集合", () => {
  assert.equal(view.unifiedViewSelfCheck(), true);
  assert.equal(view.DX_TASK_STATUSES.length, 11);
  assert.equal(view.CORE_TASK_STATUSES.length, 7);
  // DX → core：11 个都映射到合法 core，且都恰有一个目标。
  for (const dx of view.DX_TASK_STATUSES) {
    const core = view.mapDxStatusToCore(dx);
    assert.ok(view.CORE_TASK_STATUSES.includes(core), dx + " 未映射到合法 core：" + String(core));
  }
  // core → DX：7 个都有规范代表，且代表真的映射回该 core。
  for (const core of view.CORE_TASK_STATUSES) {
    const dx = view.mapCoreStatusToDx(core);
    assert.ok(view.DX_TASK_STATUSES.includes(dx), core + " 缺规范代表");
    assert.equal(view.mapDxStatusToCore(dx), core, core + " 的代表不一致");
  }
  // 反向集合之并 == 11 态（无多、无漏）。
  const union = [];
  for (const core of view.CORE_TASK_STATUSES) union.push(...view.CORE_TO_DX_STATUSES[core]);
  assert.deepEqual(union.slice().sort(), view.DX_TASK_STATUSES.slice().sort());
  // 显式映射表逐行给出 11 行。
  const table = view.statusMappingTable();
  assert.equal(table.length, 11);
  for (const row of table) assert.ok(row.core && row.semantics, row.dx + " 缺 core/语义");
  // 语义解释双向可读。
  const queued = view.explainStatusMapping("dx", "queued");
  assert.equal(queued.unifiedStatus, "PENDING");
  assert.deepEqual(queued.dxStatuses, ["queued"]);
  assert.equal(queued.canonicalDxStatus, "queued");
  const blocked = view.explainStatusMapping("dx", "interrupted");
  assert.equal(blocked.unifiedStatus, "BLOCKED");
  assert.deepEqual(blocked.dxStatuses, ["paused", "interrupted"]);
  // core 侧状态原样进入统一词汇。
  assert.equal(view.explainStatusMapping("core", "WAITING").unifiedStatus, "WAITING");
  // 未知状态：不猜，complete=false。
  assert.equal(view.explainStatusMapping("dx", "mystery").unifiedStatus, null);
  assert.equal(view.explainStatusMapping("dx", "mystery").complete, false);
  assert.equal(view.explainStatusMapping("core", "mystery").unifiedStatus, null);
});

// ---------------------------------------------------------------------------
// 投影：两套来源归一到统一字段
// ---------------------------------------------------------------------------

test("投影：dx 用 title / core 用 goal；状态、时间戳、步骤数、最近事件各自正确", async () => {
  const s = await setup();
  const listed = view.listUnifiedTasks({ db: s.db, userId: USER });
  assert.equal(listed.readModel, true);
  assert.equal(listed.boundary, view.UNIFIED_VIEW_BOUNDARY);
  assert.deepEqual(listed.sources, ["dx", "core"]);
  assert.equal(listed.items.length, 2);
  for (const item of listed.items) assert.equal(item.readOnly, true);

  const dx = listed.items.find((item) => item.source === "dx");
  assert.equal(dx.id, s.sharedId);
  assert.equal(dx.key, "dx:" + s.sharedId);
  assert.equal(dx.title, "DX 任务：单一读模型");
  assert.equal(dx.status, "PENDING");
  assert.equal(dx.statusRaw, "queued");
  assert.equal(dx.statusMapping.unifiedStatus, "PENDING");
  assert.equal(dx.stepCount, 1);
  assert.equal(dx.eventCount, 1);
  assert.equal(dx.lastEvent.type, "task.created");
  assert.equal(typeof dx.createdAt, "number");

  const core = listed.items.find((item) => item.source === "core");
  assert.equal(core.id, s.sharedId);
  assert.equal(core.key, "core:" + s.sharedId);
  assert.equal(core.title, "core 任务：DSH/ACP 链路");
  assert.equal(core.status, "RUNNING");
  assert.equal(core.statusRaw, "RUNNING");
  assert.equal(core.stepCount, 2);
  assert.equal(core.eventCount, 1);
  assert.equal(core.lastEvent.type, "task.started");
  assert.equal(core.lastEvent.message, "core 已启动");

  // source 过滤：只查一套来源。
  const onlyDx = view.listUnifiedTasks({ db: s.db, userId: USER, source: "dx" });
  assert.deepEqual(onlyDx.items.map((item) => item.source), ["dx"]);
  const onlyCore = view.listUnifiedTasks({ db: s.db, userId: USER, source: "core" });
  assert.deepEqual(onlyCore.items.map((item) => item.source), ["core"]);
  // 其他用户看不到这两条。
  assert.equal(view.listUnifiedTasks({ db: s.db, userId: "someone_else" }).items.length, 0);
});

// ---------------------------------------------------------------------------
// U2 · 每侧真实计数 + 截断标记：共享 limit 把一侧挤掉时，绝不把截断当成空
// ---------------------------------------------------------------------------

test("计数：无截断时 counts（真实总数）== listed（实际列出），truncated=false", async () => {
  const s = await setup();
  const listed = view.listUnifiedTasks({ db: s.db, userId: USER });
  assert.deepEqual(listed.counts, { dx: 1, core: 1, total: 2 });
  assert.deepEqual(listed.listed, { dx: 1, core: 1, total: 2 });
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.truncatedSides, []);
  // 只请求一侧时，计数只反映被请求的那一侧（另一侧为 0，不是"截断"）。
  const onlyCore = view.listUnifiedTasks({ db: s.db, userId: USER, source: "core" });
  assert.deepEqual(onlyCore.counts, { dx: 0, core: 1, total: 1 });
  assert.deepEqual(onlyCore.listed, { dx: 0, core: 1, total: 1 });
  assert.equal(onlyCore.truncated, false);
});

test("截断：共享 limit 把 core 行整段挤出 items 时，counts.core>0 且如标记 core 被截断", async () => {
  const f = await createTaskFixture({ dbPath: ":memory:" });
  fixtures.push(f);
  const db = f.identity.connection;
  agentTaskStore.resetAgentTaskStoreForTests();
  agentTaskStore.configureAgentTaskStore({ db, clock: f.clock, idFactory: () => crypto.randomUUID() });
  const project = agentTaskStore.createProject({ name: "截断项目", rootNodeId: "root_trunc", createdBy: USER });
  // 两条 DX（clock 固定在大时间戳）+ 一条更老的 core 任务（created_at=1）。
  const dx1 = agentTaskStore.createTask({ projectId: project.id, instruction: "dx 一", createdBy: USER, title: "DX-1", actions: [] });
  const dx2 = agentTaskStore.createTask({ projectId: project.id, instruction: "dx 二", createdBy: USER, title: "DX-2", actions: [] });
  const coreId = "core_older_1";
  f.taskStore.insertTask({ taskId: coreId, userId: USER, appId: "ai", status: "PENDING", goal: "core 老任务", createdAt: 1, updatedAt: 2 });

  // limit=2：两侧各取 2 行再合并排序，较新的两条 DX 占满 items，core 被共享 limit 挤出。
  const truncated = view.listUnifiedTasks({ db, userId: USER, limit: 2 });
  assert.deepEqual(truncated.counts, { dx: 2, core: 1, total: 3 }, "counts 必须是每侧真实总数，不是取回行数");
  assert.deepEqual(truncated.listed, { dx: 2, core: 0, total: 2 });
  assert.equal(truncated.truncated, true);
  assert.deepEqual(truncated.truncatedSides, ["core"]);
  assert.deepEqual(truncated.items.map((item) => item.source), ["dx", "dx"]);
  assert.equal(truncated.items.some((item) => item.source === "core"), false);
  // 截断只影响列表投影：被挤掉的那条仍能按 source 单条读到（读模型不当它不存在）。
  assert.equal(view.getUnifiedTask({ db, id: coreId, source: "core" }).title, "core 老任务");

  // limit=1：两侧都被截断（dx 真实 2 > 列出 1；core 真实 1 > 列出 0）。
  const one = view.listUnifiedTasks({ db, userId: USER, limit: 1 });
  assert.deepEqual(one.counts, { dx: 2, core: 1, total: 3 });
  assert.deepEqual(one.listed, { dx: 1, core: 0, total: 1 });
  assert.deepEqual(one.truncatedSides, ["dx", "core"]);

  // 截断读数不改变只读事实：两条 DX 与那条 core 都还在（行数未动）。
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dx_tasks WHERE created_by=?").get(USER).n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE user_id=?").get(USER).n, 1);
  assert.ok(dx1.id && dx2.id);
});

// ---------------------------------------------------------------------------
// (b) 两边同名 id 不互相污染
// ---------------------------------------------------------------------------

test("同名 id：显式 source 各查各的，省略 source 报歧义而不是猜一边", async () => {
  const s = await setup();
  // 省略 source：两套都存在 → UNIFIED_VIEW_AMBIGUOUS_SOURCE，绝不优先取一边。
  assert.throws(
    () => view.getUnifiedTask({ db: s.db, id: s.sharedId }),
    (error) => {
      assert.equal(error.code, view.UNIFIED_VIEW_ERR_AMBIGUOUS);
      assert.deepEqual(error.detail.candidates.sort(), ["core", "dx"]);
      return true;
    },
  );
  // 显式 source：各查各的，标题 / 状态 / 步骤数都不串。
  const dx = view.getUnifiedTask({ db: s.db, id: s.sharedId, source: "dx" });
  assert.equal(dx.source, "dx");
  assert.equal(dx.title, "DX 任务：单一读模型");
  assert.equal(dx.stepCount, 1);
  const core = view.getUnifiedTask({ db: s.db, id: s.sharedId, source: "core" });
  assert.equal(core.source, "core");
  assert.equal(core.title, "core 任务：DSH/ACP 链路");
  assert.equal(core.stepCount, 2);
  assert.notEqual(dx.title, core.title);
  // 各自的步骤表互不混用：dx 侧只有 1 个 dx_task_step，core 侧只有 2 个 task_step。
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM dx_task_steps WHERE task_id=?").get(s.sharedId).n, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM task_steps WHERE task_id=?").get(s.sharedId).n, 2);
  // 不存在的 id / 非法 source / 非法 limit 都结构化报错。
  assert.throws(() => view.getUnifiedTask({ db: s.db, id: "nope", source: "dx" }), (e) => e.code === view.UNIFIED_VIEW_ERR_NOT_FOUND);
  assert.throws(() => view.getUnifiedTask({ db: s.db, id: s.sharedId, source: "other" }), (e) => e.code === view.UNIFIED_VIEW_ERR_INVALID_INPUT);
  assert.throws(() => view.listUnifiedTasks({ db: s.db, limit: 0 }), (e) => e.code === view.UNIFIED_VIEW_ERR_INVALID_INPUT);
  assert.throws(() => view.listUnifiedTasks({ db: s.db, limit: 99999 }), (e) => e.code === view.UNIFIED_VIEW_ERR_INVALID_INPUT);
});

// ---------------------------------------------------------------------------
// (a) 只读：调用前后两套表行数与哈希不变
// ---------------------------------------------------------------------------

test("只读：list/get 调用前后，六张表的行数与哈希完全不变", async () => {
  const s = await setup();
  const before = snapshot(s.db);
  view.listUnifiedTasks({ db: s.db, userId: USER });
  view.listUnifiedTasks({ db: s.db, userId: USER, source: "dx" });
  view.listUnifiedTasks({ db: s.db, userId: USER, source: "core" });
  view.getUnifiedTask({ db: s.db, id: s.sharedId, source: "dx" });
  view.getUnifiedTask({ db: s.db, id: s.sharedId, source: "core" });
  try { view.getUnifiedTask({ db: s.db, id: s.sharedId }); } catch { /* 歧义路径也必须无写 */ }
  const afterSnapshot = snapshot(s.db);
  assert.deepEqual(afterSnapshot, before, "读模型调用改变了表内容");
  // 逐表再显式比对一次，失败时能直接看出是哪张表。
  for (const table of TABLES) {
    assert.equal(afterSnapshot[table].count, before[table].count, table + " 行数变化");
    assert.equal(afterSnapshot[table].hash, before[table].hash, table + " 内容哈希变化");
  }
});

test("依赖缺失：db 未注入时抛结构化 UNIFIED_VIEW_DEPENDENCY_UNAVAILABLE（不返回假空列表）", () => {
  assert.throws(
    () => view.listUnifiedTasks({}),
    (error) => {
      assert.equal(error.code, view.UNIFIED_VIEW_ERR_DEPENDENCY_UNAVAILABLE);
      assert.equal(error.detail.dependency, "sqlite");
      return true;
    },
  );
  assert.throws(
    () => view.getUnifiedTask({ db: null, id: "x" }),
    (e) => e.code === view.UNIFIED_VIEW_ERR_DEPENDENCY_UNAVAILABLE,
  );
});

test("脏状态：DX 表里的未知状态不猜测，投影 status=null 且 complete=false", async () => {
  const s = await setup();
  s.db.prepare("UPDATE dx_tasks SET status='mystery' WHERE id=?").run(s.sharedId);
  const item = view.getUnifiedTask({ db: s.db, id: s.sharedId, source: "dx" });
  assert.equal(item.statusRaw, "mystery");
  assert.equal(item.status, null);
  assert.equal(item.statusMapping.complete, false);
  assert.deepEqual(item.statusMapping.dxStatuses, []);
});

// ---------------------------------------------------------------------------
// (d) 无写穿路径：源码级断言 + 子进程 require 缓存断言
// ---------------------------------------------------------------------------

test("写穿：源码不含写 SQL / Statement.run / require，且 require 后不加载任何 store", () => {
  const source = fs.readFileSync(MODULE_PATH, "utf8");
  // 1) 不出现任何写语句关键词（大写 SQL 词；SELECT 是允许的读词）。
  assert.equal(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|TRUNCATE|PRAGMA)\b/.test(source), false, "源码出现写语句关键词");
  // 2) 不调用 Statement.run（node:sqlite 的唯一写执行入口）。
  assert.equal(/\.run\(/.test(source), false, "源码出现 .run(");
  // 3) 本模块零 require —— 根本不引入任何 store（更不可能 require 其写方法）。
  assert.equal(/require\(/.test(source), false, "源码出现 require(");
  // 4) 子进程里只 require 本模块，require 缓存不得含任何 store。
  const probe = "const m=require(" + JSON.stringify(MODULE_PATH) + ");" +
    "const bad=Object.keys(require.cache).filter((k)=>/(task-store|agent-task-store|task-service|agent-service)\.cjs$/.test(k));" +
    "process.stdout.write(JSON.stringify(bad));";
  const proc = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(proc.stdout.trim(), "[]", "require 本模块时连带加载了 store：" + proc.stdout.trim());
});
