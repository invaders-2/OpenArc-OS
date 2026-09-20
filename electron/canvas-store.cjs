/**
 * D5-02 · 无限画布持久层（文档层）。
 *
 * **不建第二套画布**：board 身份（canvas_boards）与资源引用（canvas_resource_nodes）
 * 沿用 D3-04D；这里只读写挂在同一个 board 上的可编辑文档、共享角色与命令账本。
 * 复用 IdentityStore 的同一条连接与事务队列（与 resource-store 同一纪律）。
 */
"use strict";

const SQL = {
  insertBoard:
    "INSERT INTO canvas_boards (id, organization_id, owner_user_id, name, created_at, updated_at, icon, kind, doc, revision, visibility) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  boardById: "SELECT * FROM canvas_boards WHERE id = ?",
  boardsOwned: "SELECT * FROM canvas_boards WHERE owner_user_id = ? ORDER BY updated_at DESC, id",
  boardsShared:
    "SELECT b.*, s.role AS share_role FROM canvas_boards b JOIN canvas_shares s ON s.canvas_id = b.id WHERE s.user_id = ? ORDER BY b.updated_at DESC, b.id",
  boardsOrg:
    "SELECT * FROM canvas_boards WHERE organization_id = ? AND visibility = 'ORGANIZATION' ORDER BY updated_at DESC, id",
  updateDoc:
    "UPDATE canvas_boards SET name = ?, icon = ?, doc = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
  updateMeta: "UPDATE canvas_boards SET name = ?, icon = ?, updated_at = ? WHERE id = ?",
  softDelete: "UPDATE canvas_boards SET deleted_at = ?, deleted_by = ? WHERE id = ?",
  restore: "UPDATE canvas_boards SET deleted_at = NULL, deleted_by = NULL WHERE id = ?",
  purge: "DELETE FROM canvas_boards WHERE id = ?",
  setVisibility: "UPDATE canvas_boards SET visibility = ?, updated_at = ? WHERE id = ?",
  insertShare: "INSERT INTO canvas_shares (canvas_id, user_id, role, granted_by, at) VALUES (?,?,?,?,?) ON CONFLICT(canvas_id, user_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, at = excluded.at",
  shareOf: "SELECT * FROM canvas_shares WHERE canvas_id = ? AND user_id = ?",
  sharesOf: "SELECT * FROM canvas_shares WHERE canvas_id = ? ORDER BY at, user_id",
  deleteShare: "DELETE FROM canvas_shares WHERE canvas_id = ? AND user_id = ?",
  insertCommand:
    "INSERT INTO canvas_commands (id, canvas_id, actor_user_id, actor_kind, command, base_revision, result_revision, outcome, before_doc, at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  recentCommands: "SELECT * FROM canvas_commands WHERE canvas_id = ? ORDER BY at DESC, id DESC LIMIT ?",
  commandById: "SELECT * FROM canvas_commands WHERE id = ?",
};

class CanvasStore {
  constructor({ identity, clock } = {}) {
    if (!identity) throw new Error("CanvasStore 需要 IdentityStore");
    this.identity = identity;
    this.db = identity.connection;
    this.clock = typeof clock === "function" ? clock : identity.clock;
  }

  transact(fn) { return this.identity.transact(fn); }
  transactSync(fn) { return this.identity.transactSync(fn); }
  now() { return Number(this.clock()); }

  insertBoard({ canvasId, organizationId, ownerUserId, name, icon = "🧩", kind = "classic", doc, visibility = "PRIVATE" }) {
    const now = this.now();
    this.db.prepare(SQL.insertBoard).run(
      String(canvasId), String(organizationId), String(ownerUserId), String(name),
      now, now, String(icon), String(kind), JSON.stringify(doc), 1, String(visibility),
    );
    return this.boardById(canvasId);
  }

  boardById(canvasId) { return this.db.prepare(SQL.boardById).get(String(canvasId || "")) || null; }
  boardsOwned(userId) { return this.db.prepare(SQL.boardsOwned).all(String(userId)); }
  boardsShared(userId) { return this.db.prepare(SQL.boardsShared).all(String(userId)); }
  boardsOrg(organizationId) { return this.db.prepare(SQL.boardsOrg).all(String(organizationId)); }

  /** 版本检查写：只有 baseRevision 与库里一致才写入（返回 null 表示冲突）。 */
  updateDoc({ canvasId, name, icon, doc, baseRevision }) {
    const now = this.now();
    const res = this.db.prepare(SQL.updateDoc).run(String(name), String(icon), JSON.stringify(doc), now, String(canvasId), Number(baseRevision));
    if (!res || Number(res.changes) === 0) return null;
    return this.boardById(canvasId);
  }

  updateMeta({ canvasId, name, icon }) {
    this.db.prepare(SQL.updateMeta).run(String(name), String(icon), this.now(), String(canvasId));
    return this.boardById(canvasId);
  }

  softDelete({ canvasId, by }) { this.db.prepare(SQL.softDelete).run(this.now(), by == null ? null : String(by), String(canvasId)); return this.boardById(canvasId); }
  restore({ canvasId }) { this.db.prepare(SQL.restore).run(String(canvasId)); return this.boardById(canvasId); }
  purge({ canvasId }) { this.db.prepare(SQL.purge).run(String(canvasId)); return true; }
  setVisibility({ canvasId, visibility }) { this.db.prepare(SQL.setVisibility).run(String(visibility), this.now(), String(canvasId)); return this.boardById(canvasId); }

  upsertShare({ canvasId, userId, role, grantedBy }) {
    this.db.prepare(SQL.insertShare).run(String(canvasId), String(userId), String(role), grantedBy == null ? null : String(grantedBy), this.now());
    return this.shareOf({ canvasId, userId });
  }
  shareOf({ canvasId, userId }) { return this.db.prepare(SQL.shareOf).get(String(canvasId), String(userId)) || null; }
  sharesOf(canvasId) { return this.db.prepare(SQL.sharesOf).all(String(canvasId)); }
  deleteShare({ canvasId, userId }) { this.db.prepare(SQL.deleteShare).run(String(canvasId), String(userId)); return true; }

  insertCommand({ id, canvasId, actorUserId, actorKind, command, baseRevision = null, resultRevision = null, outcome, beforeDoc = null }) {
    this.db.prepare(SQL.insertCommand).run(
      String(id), String(canvasId), String(actorUserId), String(actorKind), JSON.stringify(command),
      baseRevision == null ? null : Number(baseRevision), resultRevision == null ? null : Number(resultRevision),
      String(outcome), beforeDoc == null ? null : JSON.stringify(beforeDoc), this.now(),
    );
    return this.commandById(id);
  }
  commandById(id) { return this.db.prepare(SQL.commandById).get(String(id)) || null; }
  recentCommands(canvasId, limit = 20) { return this.db.prepare(SQL.recentCommands).all(String(canvasId), Number(limit) || 20); }
}

module.exports = { CanvasStore };
