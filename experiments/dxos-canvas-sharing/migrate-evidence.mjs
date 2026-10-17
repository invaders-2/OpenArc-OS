/**
 * 迁移真机取证：在隔离的临时 userData 目录建 v28 库 → 灌入旧版 canvas_shares 数据 →
 * 由 CanvasStore 触发显式迁移 → 打印字段/CHECK/FK/索引/行数 → 再跑一次验证可重复执行。
 *
 * 运行：node experiments/dxos-canvas-sharing/migrate-evidence.mjs
 * 不碰真实 ~/Library/Application Support/openarc-os/identity.db。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore, SCHEMA_VERSION } = require("../../electron/identity-store.cjs");
const { CanvasStore } = require("../../electron/canvas-store.cjs");

const OLD_SHARES_SQL = `
CREATE TABLE canvas_shares (
  canvas_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('VIEWER','CONTRIBUTOR','EDITOR')),
  granted_by TEXT,
  at         INTEGER NOT NULL,
  PRIMARY KEY (canvas_id, user_id)
);`;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-sharing-userdata-"));
const dbPath = path.join(userDataDir, "identity.db");
const out = (label, value) => console.log(label + ": " + JSON.stringify(value));

function snapshot(label) {
  const identity = new IdentityStore({ path: dbPath }).open();
  try {
    const connection = identity.connection;
    const columns = connection.prepare("PRAGMA table_info(canvas_shares)").all().map((c) => ({ name: c.name, notnull: c.notnull, dflt: c.dflt_value }));
    const ddl = connection.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='canvas_shares'").get().sql;
    const fks = connection.prepare("PRAGMA foreign_key_list(canvas_shares)").all().map((f) => ({ table: f.table, from: f.from, to: f.to, on_delete: f.on_delete }));
    const indexes = connection.prepare("PRAGMA index_list(canvas_shares)").all().map((i) => i.name);
    const boardIndex = connection.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_canvas_boards_org_visibility'").get();
    const rows = connection.prepare("SELECT canvas_id, user_id, role, granted_by, at FROM canvas_shares ORDER BY user_id").all();
    out(label + ".schemaVersion", identity.schemaVersion);
    out(label + ".canvasSharesColumns", columns);
    out(label + ".canvasSharesDDL", ddl);
    out(label + ".foreignKeys", fks);
    out(label + ".indexes", indexes);
    out(label + ".orgVisibilityIndex", !!boardIndex);
    out(label + ".rows", rows);
    return { identity, connection, rows };
  } catch (err) {
    identity.close();
    throw err;
  }
}

try {
  // 1) 建 v28 库并倒回旧共享表形态（真实老库：无 created_at / 无 FK / CHECK 不含 MANAGER）
  const seed = new IdentityStore({ path: dbPath }).open();
  try {
    if (seed.schemaVersion !== 28) throw new Error("预期 v28，实际 " + seed.schemaVersion);
    seed.connection.prepare("INSERT INTO canvas_boards (id, organization_id, owner_user_id, name, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run("cv_evidence", "team_local", "usr_owner", "迁移取证画布", 100, 100);
    seed.connection.exec("DROP TABLE canvas_shares");
    seed.connection.exec(OLD_SHARES_SQL);
    seed.connection.exec("CREATE INDEX idx_canvas_shares_user ON canvas_shares(user_id)");
    const insert = seed.connection.prepare("INSERT INTO canvas_shares (canvas_id, user_id, role, granted_by, at) VALUES (?,?,?,?,?)");
    insert.run("cv_evidence", "usr_viewer", "VIEWER", "usr_owner", 111);
    insert.run("cv_evidence", "usr_editor", "EDITOR", "usr_owner", 222);
    insert.run("cv_evidence", "usr_legacy", "CONTRIBUTOR", "usr_owner", 333);
  } finally { seed.close(); }
  out("before.schemaVersion", SCHEMA_VERSION);
  out("before.rows", (() => {
    const identity = new IdentityStore({ path: dbPath }).open();
    try {
      return identity.connection.prepare("SELECT user_id, role, at FROM canvas_shares ORDER BY user_id").all();
    } finally { identity.close(); }
  })());

  // 2) 第一次：CanvasStore 构造 → 事务内迁移
  let run = snapshot("run1.beforeCanvasStore");
  try {
    new CanvasStore({ identity: run.identity });
    const columns = run.connection.prepare("PRAGMA table_info(canvas_shares)").all().map((c) => c.name);
    const ddl = run.connection.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='canvas_shares'").get().sql;
    out("run1.after.columns", columns);
    out("run1.after.checksManager", ddl.includes("'MANAGER'"));
    out("run1.after.rows", run.connection.prepare("SELECT user_id, role, at, created_at FROM canvas_shares ORDER BY user_id").all());
    run.connection.prepare("INSERT INTO canvas_shares (canvas_id, user_id, role, granted_by, at, created_at) VALUES (?,?,?,?,?,?)")
      .run("cv_evidence", "usr_manager", "MANAGER", "usr_owner", 444, 444);
    out("run1.after.managerInsert", run.connection.prepare("SELECT user_id, role FROM canvas_shares WHERE user_id='usr_manager'").get());
  } finally { run.identity.close(); }

  // 3) 第二次：再构造一次 → 空跑，行与时间戳不变
  run = snapshot("run2.beforeCanvasStore");
  try {
    new CanvasStore({ identity: run.identity });
    out("run2.after.rows", run.connection.prepare("SELECT user_id, role, at, created_at FROM canvas_shares ORDER BY user_id").all());
    run.connection.prepare("DELETE FROM canvas_boards WHERE id = ?").run("cv_evidence");
    out("run2.after.deleteBoardCascadesShares", run.connection.prepare("SELECT COUNT(*) AS c FROM canvas_shares").get().c);
    out("run2.after.foreignKeyCheck", run.connection.prepare("PRAGMA foreign_key_check").all());
  } finally { run.identity.close(); }
} finally {
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
console.log("userDataDir(cleaned): " + userDataDir);
