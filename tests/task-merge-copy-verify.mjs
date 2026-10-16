/**
 * P2 · 任务表合并迁移的**副本验证**（手工运行，不属于 node --test 套件）。
 *
 * 用法：
 *   node tests/task-merge-copy-verify.mjs [真实 v28 库路径]
 * 默认源库取 artifacts/dxos-b5 下的真库（打开即升到 v28）；全程只读源库，所有写入都在 /tmp 副本。
 *
 * 输出三段：成功路径 / 失败注入与备份恢复 / 反例护栏，再补一次万行级计时。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { seedBulkCore, seedStandard, snapshotV28, TASKS_CHILD_TABLES } from "./task-merge-fixtures.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { IdentityStore } = require("../electron/identity-store.cjs");
const merge = require("../electron/task-merge-migration.cjs");

const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_SRC = path.join(REPO, "artifacts/dxos-b5/run-2026-10-14T10-11-49-364Z/userdata/identity.db");
const SOURCE = process.argv[2] || DEFAULT_SRC;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "task-merge-verify-"));

const count = (db, table) => db.prepare("SELECT COUNT(*) AS c FROM " + table).get().c;
const openRaw = (file, readOnly = true) => new DatabaseSync(file, readOnly ? { readOnly: true } : {});
function copyOf(base, name) {
  const target = path.join(TMP, name);
  fs.copyFileSync(base, target);
  return target;
}

function line(tag, value) {
  console.log(value === undefined ? tag : tag + " " + value);
}

console.log("=== P2 副本验证 · 真实 v28 库副本 ===");
if (!fs.existsSync(SOURCE)) throw new Error("源库不存在：" + SOURCE);

// 1) 只读源库 → 干净副本（先拷进 /tmp，再 VACUUM INTO，源库目录零写入）
const real = path.join(TMP, "real-v28.db");
{
  const staged = path.join(TMP, "staged-source.db");
  fs.copyFileSync(SOURCE, staged);
  const ro = openRaw(staged);
  line("[源库]", SOURCE);
  line("[源库] user_version=" + ro.prepare("PRAGMA user_version").get().user_version +
    " journal_mode=" + ro.prepare("PRAGMA journal_mode").get().journal_mode +
    " integrity_check=" + ro.prepare("PRAGMA integrity_check").get().integrity_check);
  ro.exec("VACUUM INTO '" + real.replace(/'/g, "''") + "'");
  ro.close();
  fs.rmSync(staged, { force: true });
}

// 2) 在副本上播种 core + dx + 9 张外键子表
{
  const store = new IdentityStore({ path: real }).open();
  seedStandard(store.connection);
  store.close();
}
line("[副本]", real + " 已播种 core/dx 双侧数据与 9 张子表");

// ---- 成功路径 ----
console.log("\n--- [1] 成功路径 ---");
{
  const copy = copyOf(real, "success.db");
  const pre = snapshotV28(copy);
  const store = new IdentityStore({ path: copy, backupDir: path.join(TMP, "backup-success") }).open();
  const result = store.applyExplicitMigration(merge.taskMergeMigration);
  const db = store.connection;
  line("[成功] apply =", JSON.stringify(result));
  line("[成功] user_version =", store.schemaVersion);
  line("[成功] 列数 tasks/task_steps/task_events =",
    [db.prepare("PRAGMA table_info(tasks)").all().length, db.prepare("PRAGMA table_info(task_steps)").all().length, db.prepare("PRAGMA table_info(task_events)").all().length].join("/"));
  line("[成功] 行数 tasks/task_steps/task_events =",
    [count(db, "tasks"), count(db, "task_steps"), count(db, "task_events")].join("/"));
  line("[成功] 行数 core tasks=" + db.prepare("SELECT COUNT(*) c FROM tasks WHERE record_source='core'").get().c +
    " dx tasks=" + db.prepare("SELECT COUNT(*) c FROM tasks WHERE record_source='dx'").get().c +
    " core steps=" + db.prepare("SELECT COUNT(*) c FROM task_steps WHERE record_source='core'").get().c +
    " dx steps=" + db.prepare("SELECT COUNT(*) c FROM task_steps WHERE record_source='dx'").get().c +
    " core events=" + db.prepare("SELECT COUNT(*) c FROM task_events WHERE record_source='core'").get().c +
    " dx events=" + db.prepare("SELECT COUNT(*) c FROM task_events WHERE record_source='dx'").get().c);
  line("[成功] foreign_key_check =", JSON.stringify(db.prepare("PRAGMA foreign_key_check").all()));
  line("[成功] foreign_keys pragma =", JSON.stringify(db.prepare("PRAGMA foreign_keys").get()));
  line("[成功] 两套状态可读 =", JSON.stringify(db.prepare("SELECT task_id,status,record_source FROM tasks ORDER BY record_source").all().map((r) => ({ ...r }))));
  line("[成功] dx 只读视图 =", JSON.stringify(db.prepare("SELECT id,title,status FROM dx_tasks").all().map((r) => ({ ...r }))));
  line("[成功] 9 张子表行数 =", JSON.stringify(Object.fromEntries(TASKS_CHILD_TABLES.map((t) => [t, count(db, t)]))));
  line("[成功] 迁移前 9 张子表行数 =", JSON.stringify(Object.fromEntries(TASKS_CHILD_TABLES.map((t) => [t, pre.counts[t]]))));
  line("[成功] sqlite_sequence =", JSON.stringify(db.prepare("SELECT name,seq FROM sqlite_sequence WHERE name='task_events'").all().map((r) => ({ ...r }))));
  line("[成功] DX→core 身份桥仍在 =", JSON.stringify(db.prepare("SELECT dx_task_id,core_task_id FROM dx_task_approval_bridge").all().map((r) => ({ ...r }))));
  line("[成功] 备份 =", JSON.stringify(store.migrationBackups));
  // 重放
  db.exec("PRAGMA user_version = 28");
  line("[成功] 降回 28 重放 =", JSON.stringify(store.applyExplicitMigration(merge.taskMergeMigration)) +
    " 行数 tasks=" + count(db, "tasks") + " events=" + count(db, "task_events"));
  store.close();
}

// ---- 失败注入 + 备份恢复 ----
console.log("\n--- [2] 失败注入与备份恢复 ---");
{
  const copy = copyOf(real, "rollback.db");
  const pre = snapshotV28(copy);
  const store = new IdentityStore({
    path: copy,
    backupDir: path.join(TMP, "backup-rollback"),
    hooks: { onMigration: (version, db) => { if (version === 29) throw new Error("INJECTED_FAILURE_AFTER_DDL"); } },
  }).open();
  let threw = null;
  try {
    store.applyExplicitMigration(merge.taskMergeMigration);
  } catch (e) {
    threw = e.message;
  }
  const db = store.connection;
  line("[失败] 抛出 =", threw);
  line("[失败] user_version =", db.prepare("PRAGMA user_version").get().user_version);
  line("[失败] dx_tasks 类型 =", db.prepare("SELECT type FROM sqlite_master WHERE name='dx_tasks'").get().type);
  line("[失败] tasks 列数 =", db.prepare("PRAGMA table_info(tasks)").all().length);
  line("[失败] foreign_keys =", JSON.stringify(db.prepare("PRAGMA foreign_keys").get()));
  line("[失败] 9 张子表行数 =", JSON.stringify(Object.fromEntries(TASKS_CHILD_TABLES.map((t) => [t, count(db, t)]))));
  const backupPath = store.migrationBackups[0].path;
  line("[失败] 备份文件 =", backupPath);
  line("[失败] 备份 user_version =", openRaw(backupPath).prepare("PRAGMA user_version").get().user_version);
  line("[失败] 备份快照与迁移前一致 =", JSON.stringify(snapshotV28(backupPath)) === JSON.stringify(pre));
  store.close();

  // 真的用备份恢复
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(copy + suffix, { force: true });
  fs.copyFileSync(backupPath, copy);
  line("[恢复] 恢复后快照与迁移前一致 =", JSON.stringify(snapshotV28(copy)) === JSON.stringify(pre));
  const restored = new IdentityStore({ path: copy, backupDir: path.join(TMP, "backup-rollback") }).open();
  line("[恢复] 恢复后 user_version =", restored.schemaVersion,
    " tasks=" + count(restored.connection, "tasks"), " dx_tasks=" + count(restored.connection, "dx_tasks"));
  line("[恢复] 恢复后可再次迁移 =", JSON.stringify(restored.applyExplicitMigration(merge.taskMergeMigration)));
  restored.close();
}

// ---- 反例护栏 ----
console.log("\n--- [3] 反例护栏 ---");
{
  const copy = copyOf(real, "counterexample.db");
  const db = openRaw(copy, false);
  db.exec("PRAGMA foreign_keys = ON");
  line("[反例A] 迁移前 9 张子表 =", JSON.stringify(Object.fromEntries(TASKS_CHILD_TABLES.map((t) => [t, count(db, t)]))));
  db.exec("BEGIN IMMEDIATE");
  db.exec("PRAGMA foreign_keys = OFF");
  line("[反例B] 事务内 PRAGMA foreign_keys =", JSON.stringify(db.prepare("PRAGMA foreign_keys").get()));
  db.exec("ROLLBACK");
  db.exec("PRAGMA foreign_keys = OFF");
  line("[反例C] BEGIN 之前 PRAGMA foreign_keys =", JSON.stringify(db.prepare("PRAGMA foreign_keys").get()));
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("DROP TABLE tasks");
  line("[反例D] FK=ON DROP TABLE tasks 后 9 张子表 =", JSON.stringify(Object.fromEntries(TASKS_CHILD_TABLES.map((t) => [t, count(db, t)]))));
  db.close();
}

// ---- 万行级计时（在真实库副本上） ----
console.log("\n--- [4] 万行级计时（真实库副本） ---");
{
  const N = 10000;
  const copy = copyOf(real, "bulk.db");
  const builder = new IdentityStore({ path: copy }).open();
  seedBulkCore(builder.connection, N);
  const pre = {
    tasks: count(builder.connection, "tasks"),
    task_steps: count(builder.connection, "task_steps"),
    task_events: count(builder.connection, "task_events"),
  };
  builder.close();
  const startedAt = Date.now();
  const store = new IdentityStore({ path: copy, backupDir: path.join(TMP, "backup-bulk") }).open();
  const result = store.applyExplicitMigration(merge.taskMergeMigration);
  const elapsedMs = Date.now() - startedAt;
  const db = store.connection;
  line("[万行] 迁移前 core 侧行数 =", JSON.stringify(pre));
  line("[万行] apply =", JSON.stringify(result), " user_version =", store.schemaVersion);
  line("[万行] 迁移后 tasks/task_steps/task_events =",
    count(db, "tasks") + "/" + count(db, "task_steps") + "/" + count(db, "task_events"));
  line("[万行] foreign_key_check =", JSON.stringify(db.prepare("PRAGMA foreign_key_check").all()));
  line("[万行] 含 VACUUM INTO 备份耗时 =", elapsedMs + " ms");
  store.close();
}

console.log("\nTMP = " + TMP);
