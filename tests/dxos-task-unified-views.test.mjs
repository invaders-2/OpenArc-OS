/**
 * P1 · 统一只读视图回归（全离线；不联网、不新增依赖）。
 *
 * 覆盖任务书第 1 条：
 *   (a) 三条只读视图存在、只读（拒绝写）、缺视图时结构化报错；
 *   (b) 视图把两套任务表 UNION 成统一行集，读模型**基于视图查询**且对外形状不变；
 *   (c) 旁路扫描：生产代码里直接写六张任务表的文件只有两个 store（task-store / agent-task-store）。
 *
 * 数据来源：真 IdentityStore（临时 :memory:）+ 真 agent-task-store + 真 TaskStore。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createTaskFixture } from "./task-fixtures.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.join(HERE, "..", "electron");
const VIEW_MODULE = path.join(ELECTRON_DIR, "task-unified-view.cjs");

const view = require("../electron/task-unified-view.cjs");
const schema = require("../electron/task-unified-schema.cjs");
const agentTaskStore = require("../electron/agent-task-store.cjs");

const USER = "u_views";
const TABLES = ["dx_tasks", "dx_task_steps", "dx_task_events", "tasks", "task_steps", "task_events"];
const fixtures = [];
after(() => { for (const f of fixtures) { try { f.identity.close(); } catch { /* 已关闭 */ } } });

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
function snapshot(db) {
  const out = {};
  for (const table of TABLES) {
    const rows = db.prepare("SELECT * FROM " + table + " ORDER BY 1").all();
    out[table] = { count: rows.length, hash: sha256(JSON.stringify(rows)) };
  }
  return out;
}

/** 只有物理表、没有视图的库（IdentityStore 迁移链建表，但视图靠幂等 ensure）。 */
async function setupBare() {
  const f = await createTaskFixture({ dbPath: ":memory:" });
  fixtures.push(f);
  agentTaskStore.resetAgentTaskStoreForTests();
  return { ...f, db: f.identity.connection };
}

/** 有数据、并且已 ensure 视图的库。 */
async function setupWithData() {
  const f = await setupBare();
  agentTaskStore.configureAgentTaskStore({ db: f.db, clock: f.clock, idFactory: () => crypto.randomUUID() });
  const project = agentTaskStore.createProject({ name: "视图项目", rootNodeId: "root_views", createdBy: USER });
  const dxTask = agentTaskStore.createTask({
    projectId: project.id,
    instruction: "新建「view.txt」",
    createdBy: USER,
    title: "DX 视图任务",
    executionProfile: "thinking",
    actions: [{ tool: "file.create", path: "view.txt" }],
  });
  const sharedId = dxTask.id;
  f.taskStore.insertTask({ taskId: sharedId, userId: USER, appId: "ai", status: "RUNNING", goal: "core 视图任务", createdAt: 1000, updatedAt: 2000 });
  f.taskStore.insertStep({ taskId: sharedId, kind: "model", status: "SUCCEEDED", sequence: 1 });
  f.taskStore.appendEvent({ taskId: sharedId, eventType: "task.started", safePayload: { message: "core 视图已启动" }, at: 1500 });
  return { ...f, sharedId, projectId: project.id };
}

// ---------------------------------------------------------------------------
// (a) 视图存在 / 只读 / 缺视图结构化报错
// ---------------------------------------------------------------------------

test("视图：三条视图名与 schema 真值逐字对齐，且形状可查", async () => {
  const s = await setupBare();
  assert.deepEqual(view.REQUIRED_VIEWS.slice(), ["v_task_unified", "v_task_step_unified", "v_task_event_unified"]);
  assert.deepEqual(schema.TASK_UNIFIED_VIEW_NAMES.slice(), view.REQUIRED_VIEWS.slice());
  // 未 ensure：视图不存在，读模型必须结构化报"缺视图"，不能返回假空列表。
  assert.throws(
    () => view.listUnifiedTasks({ db: s.db, userId: USER }),
    (error) => {
      assert.equal(error.code, view.UNIFIED_VIEW_ERR_DEPENDENCY_UNAVAILABLE);
      assert.equal(error.detail.dependency, "schema");
      assert.deepEqual(error.detail.missingViews, view.REQUIRED_VIEWS.slice());
      return true;
    },
  );
  assert.equal(schema.ensureTaskUnifiedViews(s.db), true);
  for (const name of schema.TASK_UNIFIED_VIEW_NAMES) {
    const row = s.db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(name);
    assert.equal(row && row.type, "view", name + " 必须是视图");
  }
  // 幂等：重复 ensure 不报错。
  assert.equal(schema.ensureTaskUnifiedViews(s.db), true);
  // ensure 后空库可查（0 行，不是错误）。
  assert.equal(view.listUnifiedTasks({ db: s.db, userId: USER }).items.length, 0);
});

test("视图只读：三条视图都拒绝写（不含 INSTEAD OF 触发器）", async () => {
  const s = await setupBare();
  schema.ensureTaskUnifiedViews(s.db);
  for (const name of schema.TASK_UNIFIED_VIEW_NAMES) {
    assert.throws(() => s.db.prepare("UPDATE " + name + " SET status='x'").run(), /is a view/, name + " 不应可更新");
    assert.throws(() => s.db.prepare("DELETE FROM " + name).run(), /is a view/, name + " 不应可删除");
    assert.throws(() => s.db.prepare("INSERT INTO " + name + "(source) VALUES('dx')").run(), /is a view/, name + " 不应可插入");
  }
});

// ---------------------------------------------------------------------------
// (b) 视图形状与读模型投影一致
// ---------------------------------------------------------------------------

test("视图行集：两套来源归一到 source/id/title/status/计数/最近事件/owner_id", async () => {
  const s = await setupWithData();
  const rows = s.db.prepare("SELECT * FROM v_task_unified WHERE id = ? ORDER BY source").all(s.sharedId);
  assert.deepEqual(rows.map((row) => row.source), ["core", "dx"]);
  const core = rows.find((row) => row.source === "core");
  const dx = rows.find((row) => row.source === "dx");
  assert.equal(core.title, "core 视图任务");
  assert.equal(core.status, "RUNNING");
  assert.equal(core.step_count, 1);
  assert.equal(core.event_count, 1);
  assert.equal(core.last_event_type, "task.started");
  assert.equal(core.last_event_message, "core 视图已启动");
  assert.equal(core.owner_id, USER);
  assert.equal(dx.title, "DX 视图任务");
  assert.equal(dx.status, "queued");
  assert.equal(dx.step_count, 1);
  assert.equal(dx.event_count, 1);
  assert.equal(dx.last_event_type, "task.created");
  assert.equal(dx.owner_id, USER);

  // 步骤视图：core 走 output_ref，dx 走 output_json，两套列语义各自保留。
  const steps = s.db.prepare("SELECT * FROM v_task_step_unified WHERE task_id = ? ORDER BY source, ordinal").all(s.sharedId);
  assert.deepEqual(steps.map((step) => step.source), ["core", "dx"]);
  const coreStep = steps.find((step) => step.source === "core");
  const dxStep = steps.find((step) => step.source === "dx");
  assert.equal(coreStep.output_json, null);
  assert.equal(dxStep.output_ref, null);
  assert.equal(dxStep.ordinal, 1);
  assert.ok(dxStep.operation_id);

  // 事件视图：core 的 message 从 safe_payload 提取。
  const events = s.db.prepare("SELECT * FROM v_task_event_unified WHERE task_id = ? ORDER BY source").all(s.sharedId);
  assert.deepEqual(events.map((event) => event.source), ["core", "dx"]);
  assert.equal(events.find((event) => event.source === "core").message, "core 视图已启动");
  assert.equal(events.find((event) => event.source === "dx").type, "task.created");
});

test("读模型基于视图：投影形状不变，同名 id 仍报歧义，只读调用不动六张表", async () => {
  const s = await setupWithData();
  const before = snapshot(s.db);
  const listed = view.listUnifiedTasks({ db: s.db, userId: USER });
  assert.equal(listed.items.length, 2);
  const dx = listed.items.find((item) => item.source === "dx");
  const core = listed.items.find((item) => item.source === "core");
  assert.equal(dx.key, "dx:" + s.sharedId);
  assert.equal(dx.title, "DX 视图任务");
  assert.equal(dx.status, "PENDING");
  assert.equal(dx.statusRaw, "queued");
  assert.equal(dx.stepCount, 1);
  assert.equal(dx.lastEvent.type, "task.created");
  assert.equal(core.key, "core:" + s.sharedId);
  assert.equal(core.title, "core 视图任务");
  assert.equal(core.status, "RUNNING");
  assert.equal(core.stepCount, 1);
  assert.equal(core.lastEvent.message, "core 视图已启动");
  assert.throws(() => view.getUnifiedTask({ db: s.db, id: s.sharedId }), (error) => error.code === view.UNIFIED_VIEW_ERR_AMBIGUOUS);
  assert.equal(view.getUnifiedTask({ db: s.db, id: s.sharedId, source: "dx" }).title, "DX 视图任务");
  assert.equal(view.getUnifiedTask({ db: s.db, id: s.sharedId, source: "core" }).title, "core 视图任务");
  assert.deepEqual(snapshot(s.db), before, "视图读模型调用改变了六张表");
});

// ---------------------------------------------------------------------------
// (c) 旁路扫描：直接写六张任务表的生产文件只有两个 store
// ---------------------------------------------------------------------------

/** 去掉注释，避免注释里的 SQL 关键词造成误报。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 生产代码里直接对六张任务表做行写的文件（字面量 SQL + 动态拼接两种写法）。 */
const DYNAMIC_WRITE_PREFIXES = ['"INSERT INTO " +', '"INSERT OR REPLACE INTO " +', '"UPDATE " +', '"DELETE FROM " +', '"REPLACE INTO " +'];
function directWriteFiles() {
  const literal = new RegExp("\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+(?:" + TABLES.join("|") + ")\\b", "i");
  const files = [];
  for (const name of fs.readdirSync(ELECTRON_DIR)) {
    if (!name.endsWith(".cjs")) continue;
    const source = stripComments(fs.readFileSync(path.join(ELECTRON_DIR, name), "utf8"));
    if (literal.test(source) || DYNAMIC_WRITE_PREFIXES.some((prefix) => source.includes(prefix))) files.push(name);
  }
  return files.sort();
}

test("旁路扫描：直接写任务表的生产文件 == 两个 store（authority 只路由、不自己写）", () => {
  // 白名单就是"两套 store 各自实现自己的状态机"这一事实；其余模块必须经 task-authority。
  const ALLOWED_WRITE_STORES = ["agent-task-store.cjs", "task-store.cjs"];
  assert.deepEqual(directWriteFiles(), ALLOWED_WRITE_STORES, "出现新的旁路写入文件（或 allowlist 失配）");
  // 单一写入口自己不落 SQL 写语句；读模型也不能是写路径。
  const authoritySource = fs.readFileSync(path.join(ELECTRON_DIR, "task-authority.cjs"), "utf8");
  assert.equal(/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/.test(authoritySource), false, "task-authority 不应包含写 SQL（只路由到 store）");
  const viewSource = fs.readFileSync(VIEW_MODULE, "utf8");
  for (const name of schema.TASK_UNIFIED_VIEW_NAMES) assert.ok(viewSource.includes(name), "读模型必须引用视图 " + name);
  // 视图 DDL 只有一份真值：每条视图都有 CREATE VIEW IF NOT EXISTS 定义。
  for (const name of schema.TASK_UNIFIED_VIEW_NAMES) {
    assert.ok(schema.TASK_UNIFIED_VIEW_DDL.some((sql) => sql.includes("VIEW IF NOT EXISTS " + name + " AS")), name + " 缺 DDL");
  }
});
