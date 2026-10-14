/**
 * P1 · DX OS 地基回归测试。
 *
 * 覆盖计划 §8 对 P1 的硬要求：迁移幂等（空库 / 已 v21 老库 / 高版本拒开）、
 * 掩码、路径解析、错误规约、配额原语，以及"跳过同名表 + 外键改写"这一地基决定的机器证明。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const schema = require("../electron/dxos-foundation-schema.cjs");
const { IdentityStore, SCHEMA_VERSION, SCHEMA_SQL, MIGRATIONS, SchemaTooNewError } = require("../electron/identity-store.cjs");
const mask = require("../electron/dxos-foundation-mask.cjs");
const paths = require("../electron/dxos-foundation-paths.cjs");
const errors = require("../electron/dxos-foundation-errors.cjs");
const events = require("../electron/dxos-foundation-events.cjs");
const runner = require("../electron/dxos-foundation-runner.cjs");
const { createQuotaLedger, QUOTA_STATUS } = require("../electron/dxos-foundation-quota.cjs");

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-dxos-foundation-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => String(row.name));
}
function columnNames(db, table) {
  return db.prepare("PRAGMA table_info(" + table + ")").all().map((row) => String(row.name));
}

// ---------------------------------------------------------------------------
// schema 抽取
// ---------------------------------------------------------------------------

test("schema：抽取 57 张 DX 表，跳过与 OpenArc 重名的 5 张", () => {
  assert.equal(schema.DXOS_TABLES.length, 57);
  assert.deepEqual([...schema.DXOS_SKIPPED_TABLES].sort(), ["project_members", "projects", "task_events", "task_steps", "tasks"]);
  assert.equal(schema.DXOS_CREATED_TABLES.length, 52);
  for (const skipped of schema.DXOS_SKIPPED_TABLES) assert.ok(!schema.DXOS_CREATED_TABLES.includes(skipped), skipped + " 不应出现在待建清单");
  for (const expected of ["schema_migrations", "agent_runs", "canvases", "ai_protocol_tasks", "legacy_ai_tasks", "api_quota_usage"]) {
    assert.ok(schema.DXOS_TABLES.includes(expected), "缺少 DX 表 " + expected);
  }
});

test("schema：dxosDdl() 全部幂等语句，重复执行两次不报错且折叠列存在", () => {
  const ddl = schema.dxosDdl();
  assert.equal(ddl.length, 107);
  for (const statement of ddl) assert.match(statement, /^(CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS)/);
  const db = new DatabaseSync(":memory:");
  try {
    for (const statement of ddl) db.exec(statement);
    for (const statement of ddl) db.exec(statement);
    const names = tableNames(db);
    assert.equal(names.length, 52);
    for (const table of schema.DXOS_CREATED_TABLES) assert.ok(names.includes(table), "缺少表 " + table);
    for (const skipped of schema.DXOS_SKIPPED_TABLES) assert.ok(!names.includes(skipped), skipped + " 不应被建出来");
    // ALTER 折叠的证据：这些列来自后续迁移，必须出现在最终建表语句里
    assert.ok(columnNames(db, "agent_runs").includes("root_run_id"));
    assert.ok(columnNames(db, "canvases").includes("thumbnail"));
    assert.ok(columnNames(db, "agent_usage_events").includes("reasoning_tokens"));
    assert.ok(columnNames(db, "user_preferences").includes("dark_wallpaper_id"));
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

test("迁移：空库直接建到 v22，DX 表存在", () => {
  const dir = tempDir();
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  try {
    assert.equal(SCHEMA_VERSION, 25);
    assert.equal(store.schemaVersion, 25);
    const names = tableNames(store.connection);
    assert.ok(names.includes("agent_runs"));
    assert.ok(names.includes("api_quota_rules"));
    assert.ok(names.includes("schema_migrations"));
    assert.ok(names.includes("tasks"), "OpenArc tasks 仍存在");
  } finally {
    store.close();
  }
});

/** 造一个真正的 v21 库：跑完 v1..v21，再写一个标记行。 */
function buildV21Db(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    if (migration.version > 21) continue;
    if (typeof migration.run === "function") migration.run(db);
    else db.exec(migration.sql);
  }
  db.exec("PRAGMA user_version = 21");
  db.prepare("INSERT INTO teams (id,name,root,created_at) VALUES (?,?,?,?)").run("team_dxos_v21_marker", "Marker", 0, 1234);
  return db;
}

test("迁移：v21 老库升到 v22，既有数据保留、既有表结构不被覆盖", () => {
  const dir = tempDir();
  const file = path.join(dir, "identity.db");
  const raw = buildV21Db(file);
  raw.close();
  const store = new IdentityStore({ path: file }).open();
  try {
    assert.equal(store.schemaVersion, 25);
    assert.equal(store.connection.prepare("SELECT name FROM teams WHERE id=?").get("team_dxos_v21_marker").name, "Marker");
    assert.ok(columnNames(store.connection, "agent_runs").includes("id"));
    // tasks / projects 是"跳过不建"的表：不得被 DX 列污染
    assert.ok(columnNames(store.connection, "tasks").includes("task_id"));
    assert.ok(!columnNames(store.connection, "tasks").includes("execution_profile"));
    assert.ok(!columnNames(store.connection, "projects").includes("root_node_id"));
  } finally {
    store.close();
  }
});

test("迁移：库版本高于程序版本时拒开（行为不变）", () => {
  const dir = tempDir();
  const file = path.join(dir, "identity.db");
  fs.writeFileSync(file, "");
  const raw = new DatabaseSync(file);
  raw.exec(SCHEMA_SQL);
  raw.exec("PRAGMA user_version = 99");
  raw.close();
  assert.throws(() => new IdentityStore({ path: file }).open(), (err) => {
    assert.ok(err instanceof SchemaTooNewError);
    assert.equal(err.code, "SCHEMA_TOO_NEW");
    return true;
  });
});

test("迁移：把 user_version 降回 21 再重放 v22 是幂等的", () => {
  const dir = tempDir();
  const file = path.join(dir, "identity.db");
  const first = new IdentityStore({ path: file }).open();
  first.connection.exec("PRAGMA user_version = 21");
  first.close();
  const second = new IdentityStore({ path: file }).open();
  try {
    assert.equal(second.schemaVersion, 25);
    for (const statement of schema.dxosDdl()) second.connection.exec(statement);
    assert.equal(second.schemaVersion, 25);
  } finally {
    second.close();
  }
});

test("迁移：v22 之后 OpenArc 删 task 不再报外键失配；跨域引用列不带 FK", () => {
  const dir = tempDir();
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  const db = store.connection;
  try {
    // DX 子表引用列上不得有指向 tasks(id) 的外键：否则 OpenArc 删 task 会抛
    // "foreign key mismatch"（列名不同），或 DROP/重建 tasks 时被拖住。
    const runFks = db.prepare("PRAGMA foreign_key_list(agent_runs)").all();
    assert.ok(!runFks.some((fk) => fk.table === "tasks"), "agent_runs 不应再有指向 tasks 的外键");
    db.exec("INSERT INTO tasks (task_id,user_id,app_id,status,goal,created_at,updated_at) VALUES ('task_fk_1','u','app','PENDING','g',1,1)");
    assert.doesNotThrow(() => db.exec("INSERT INTO agent_runs (id,correlation_id,task_id,entry_point,status,goal,created_at,updated_at) VALUES ('run_ok','c','task_fk_1','e','created','g',1,1)"));
    assert.doesNotThrow(() => db.exec("DELETE FROM tasks WHERE task_id='task_fk_1'"));
    // OpenArc 侧用 DROP TABLE 模拟降级时，DX 子表不得因外键检查阻塞
    assert.doesNotThrow(() => db.exec("DROP TABLE task_steps"));
    assert.doesNotThrow(() => db.exec("DROP TABLE tasks"));
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 掩码
// ---------------------------------------------------------------------------

test("掩码：maskSecret 保留末 4 位，短密钥全掩", () => {
  assert.equal(mask.maskSecret("abcdefgh"), "****efgh");
  assert.equal(mask.maskSecret("abcd"), "****");
  assert.equal(mask.maskSecret(""), "");
  assert.equal(mask.maskSecret(null), null);
  assert.equal(mask.maskSecret(undefined), null);
});

test("掩码：maskProviderView 深拷贝、不改入参、只掩敏感字段", () => {
  const provider = { id: "p1", baseUrl: "https://api.example.com", apiKey: "secret-key-123456", headers: { Authorization: "Bearer abcdefghij", "X-Trace": "keep" }, models: [{ model: "m1", key: "rawkey123" }] };
  const snapshot = JSON.stringify(provider);
  const view = mask.maskProviderView(provider);
  assert.equal(JSON.stringify(provider), snapshot, "入参不得被修改");
  assert.notEqual(view, provider);
  assert.equal(view.id, "p1");
  assert.equal(view.baseUrl, "https://api.example.com");
  assert.equal(view.apiKey, "****3456");
  assert.equal(view.headers.Authorization, "****ghij");
  assert.equal(view.headers["X-Trace"], "keep");
  assert.equal(view.models[0].key, "****y123");
});

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

test("路径：解析 §6.1 的文件与目录", () => {
  const resolved = paths.resolveDxosPaths("/tmp/oa-userdata");
  assert.equal(resolved.root, "/tmp/oa-userdata/dxos");
  assert.equal(resolved.file["providers.json"], "/tmp/oa-userdata/dxos/providers.json");
  assert.equal(resolved.file["mcp.system.json"], "/tmp/oa-userdata/dxos/mcp.system.json");
  assert.equal(resolved.directory["skill-packs"], "/tmp/oa-userdata/dxos/skill-packs");
  assert.deepEqual([...resolved.directories], ["skills", "skill-packs", "ai-tasks", "media", "logs", "diagnostics"]);
});

test("路径：ensureDxosLayout 只建目录，不创建任何配置文件", () => {
  const dir = tempDir();
  const resolved = paths.ensureDxosLayout(dir);
  for (const name of resolved.directories) assert.ok(fs.statSync(resolved.directory[name]).isDirectory(), name + " 应是目录");
  for (const name of resolved.files) assert.ok(!fs.existsSync(resolved.file[name]), name + " 不应被创建");
});

test("路径：userDataDir 非法时抛 DXOS_ERR_INVALID_INPUT", () => {
  assert.throws(() => paths.resolveDxosPaths(""), (err) => err.code === errors.DXOS_ERR_INVALID_INPUT);
  assert.throws(() => paths.ensureDxosLayout(null), (err) => err.code === errors.DXOS_ERR_INVALID_INPUT);
});

// ---------------------------------------------------------------------------
// 错误规约
// ---------------------------------------------------------------------------

test("错误规约：绝对路径与密钥不出现在渲染层结果里", () => {
  const raw = Object.assign(new Error("open /Users/wepingli/Private/skill.json failed apiKey=sk-abcdef123456"), { code: "ENOENT" });
  const normalized = errors.normalizeError(raw);
  assert.equal(normalized.ok, false);
  assert.equal(normalized.error, errors.DXOS_ERR_INTERNAL);
  assert.ok(!normalized.message.includes("/Users"), normalized.message);
  assert.ok(!normalized.message.includes("sk-abcdef"), normalized.message);
  assert.equal(normalized.detail.causeCode, "ENOENT");
  assert.equal(raw.stack !== undefined, true);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "stack"), false, "堆栈不得过桥");
});

test("toIpcResult：成功按字段名掩码，失败折叠成统一错误", async () => {
  const ok = await errors.toIpcResult(() => ({ apiKey: "abcd1234", note: "ok", path: "/Users/x/y" }));
  assert.deepEqual(ok, { ok: true, value: { apiKey: "****1234", note: "ok", path: "<path>" } });
  const failed = await errors.toIpcResult(() => {
    throw errors.createDxosError(errors.DXOS_ERR_INVALID_INPUT, "参数无效", { field: "amount" });
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, errors.DXOS_ERR_INVALID_INPUT);
  assert.deepEqual(failed.detail, { field: "amount" });
});

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

test("事件：三类事件共享单调序号与时间戳，channel 固定为 <domain>:event", () => {
  let now = 1000;
  const channel = events.createEventChannel({ domain: "skill", clock: () => now++ });
  const progress = channel.progress({ phase: "load" });
  const log = channel.log("warn", "slow");
  const approval = channel.approval({ approvalRequestId: "a1" });
  assert.equal(progress.channel, "skill:event");
  assert.deepEqual([progress.sequence, log.sequence, approval.sequence], [1, 2, 3]);
  assert.deepEqual([progress.at, log.at, approval.at], [1000, 1001, 1002]);
  assert.deepEqual([progress.kind, log.kind, approval.kind], ["progress", "log", "approval"]);
  assert.equal(log.payload.level, "warn");
  assert.equal(log.payload.message, "slow");
  assert.equal(channel.sequence, 3);
  assert.throws(() => channel.emit("nope", {}), (err) => err.code === errors.DXOS_ERR_INVALID_INPUT);
});

test("事件：sendTo 对已销毁 / 无效 webContents 返回 false 且不抛", () => {
  const sent = [];
  const alive = { send: (channel, event) => sent.push({ channel, event }), isDestroyed: () => false };
  const dead = { send: () => { throw new Error("should not send"); }, isDestroyed: () => true };
  const channel = events.createEventChannel({ domain: "media", clock: () => 1 });
  const event = channel.progress({ percent: 50 });
  assert.equal(channel.sendTo(alive, event), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "media:event");
  assert.equal(channel.sendTo(dead, event), false);
  assert.equal(events.sendTo(null, "media:event", event), false);
});

// ---------------------------------------------------------------------------
// 受监督 runner
// ---------------------------------------------------------------------------

function writeScript(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

test("runner：采集 stdout/stderr 与退出码", async () => {
  const dir = tempDir();
  const entry = writeScript(dir, "ok.cjs", 'process.stdout.write("out"); process.stderr.write("err");');
  const supervised = runner.createSupervisedRunner();
  const result = await supervised.run({ entry, timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.truncated.stdout, false);
  assert.ok(result.pid === null || typeof result.pid === "number");
});

test("runner：非零退出码 -> DXOS_ERR_CHILD_FAILED", async () => {
  const dir = tempDir();
  const entry = writeScript(dir, "fail.cjs", 'process.stderr.write("boom"); process.exit(3);');
  const result = await runner.createSupervisedRunner().run({ entry, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
  assert.equal(result.error.error, errors.DXOS_ERR_CHILD_FAILED);
});

test("runner：超时 -> 终止进程并回 DXOS_ERR_TIMEOUT", async () => {
  const dir = tempDir();
  const entry = writeScript(dir, "sleep.cjs", "setTimeout(() => {}, 60000);");
  const result = await runner.createSupervisedRunner().run({ entry, timeoutMs: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.error.error, errors.DXOS_ERR_TIMEOUT);
});

test("runner：取消 -> DXOS_ERR_CANCELLED", async () => {
  const dir = tempDir();
  const entry = writeScript(dir, "sleep2.cjs", "setTimeout(() => {}, 60000);");
  const supervised = runner.createSupervisedRunner();
  const handle = supervised.start({ entry, timeoutMs: 60000 });
  setTimeout(() => handle.cancel("TEST"), 50);
  const result = await handle.result;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.error.error, errors.DXOS_ERR_CANCELLED);
  assert.equal(result.error.detail.reason, "TEST");
});

test("runner：输出超过上限时按 UTF-8 截断并标记 truncated", async () => {
  const dir = tempDir();
  const entry = writeScript(dir, "big.cjs", 'process.stdout.write("x".repeat(1000));');
  const result = await runner.createSupervisedRunner().run({ entry, timeoutMs: 5000, maxStdoutBytes: 10 });
  assert.equal(result.stdout, "xxxxxxxxxx");
  assert.equal(result.truncated.stdout, true);
  assert.equal(runner.truncateUtf8("中文ab", 7), "中文a");
  assert.equal(runner.truncateUtf8("中文", 2), "");
});

// ---------------------------------------------------------------------------
// 配额
// ---------------------------------------------------------------------------

function quotaDb(withTables) {
  const db = new DatabaseSync(":memory:");
  if (withTables) for (const statement of schema.dxosDdl()) db.exec(statement);
  return db;
}

test("配额：reserve/settle 状态流转与用量统计", () => {
  const db = quotaDb(true);
  try {
    const ledger = createQuotaLedger({ db, clock: () => 5000, idFactory: () => "usage_auto" });
    ledger.saveRule("dept1", "", 100);
    const reserved = ledger.reserve({ id: "u1", ownerId: "user1", departmentId: "dept1", providerId: "prov1", modelId: "m1", amountMicros: 60 });
    assert.equal(reserved.status, QUOTA_STATUS.RESERVED);
    assert.equal(ledger.usageFor({ departmentId: "dept1" }), 60);
    assert.throws(() => ledger.reserve({ id: "u2", ownerId: "user1", departmentId: "dept1", providerId: "prov1", modelId: "m1", amountMicros: 50 }), (err) => err.code === errors.DXOS_ERR_QUOTA_EXCEEDED);
    assert.equal(ledger.settle("u1", "completed").status, QUOTA_STATUS.SPENT);
    assert.equal(ledger.usageFor({ departmentId: "dept1", providerId: "prov1" }), 60);
    const second = ledger.reserve({ id: "u3", ownerId: "user1", departmentId: "dept1", providerId: "prov1", modelId: "m1", amountMicros: 30 });
    assert.equal(second.status, QUOTA_STATUS.RESERVED);
    assert.equal(ledger.settle("u3", "failed").status, QUOTA_STATUS.RELEASED);
    assert.equal(ledger.usageFor({ departmentId: "dept1" }), 60, "released 不再计入");
    assert.equal(ledger.remainingMicros({ departmentId: "dept1" }), 40);
    assert.equal(ledger.remainingMicros({ departmentId: "unknown" }), null);
    assert.throws(() => ledger.reserve({ id: "u1", ownerId: "user1", departmentId: "dept1", providerId: "prov1", modelId: "m1", amountMicros: 1 }), (err) => err.code === errors.DXOS_ERR_CONFLICT);
  } finally {
    db.close();
  }
});

test("配额：缺表时抛 DXOS_ERR_QUOTA_LEDGER_MISSING，不静默放行", () => {
  const db = quotaDb(false);
  try {
    const ledger = createQuotaLedger({ db });
    assert.throws(() => ledger.reserve({ id: "u1", ownerId: "user1", departmentId: "dept1", providerId: "prov1", modelId: "m1", amountMicros: 1 }), (err) => {
      assert.equal(err.code, errors.DXOS_ERR_QUOTA_LEDGER_MISSING);
      assert.deepEqual(err.detail.tables, ["api_quota_rules", "api_quota_usage", "api_model_access"]);
      return true;
    });
  } finally {
    db.close();
  }
});
