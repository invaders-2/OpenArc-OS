/**
 * D5-02 · 无限画布持久层（文档层）。
 *
 * **不建第二套画布**：board 身份（canvas_boards）与资源引用（canvas_resource_nodes）
 * 沿用 D3-04D；这里只读写挂在同一个 board 上的可编辑文档、共享角色与命令账本。
 * 复用 IdentityStore 的同一条连接与事务队列（与 resource-store 同一纪律）。
 */
"use strict";

const { applyCanvasSharingRolesLayer } = require("./identity-store.cjs");

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
  // 共享/可见性/所有权转移**不碰 updated_at / revision**：宿主用 updated_at 精确映射保存基线，
  // 改这里会让下一次页面保存拿到旧基线（见 DESIGN §6.2）。
  setVisibility: "UPDATE canvas_boards SET visibility = ? WHERE id = ?",
  updateOwner: "UPDATE canvas_boards SET owner_user_id = ? WHERE id = ?",
  insertShare: "INSERT INTO canvas_shares (canvas_id, user_id, role, granted_by, at, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(canvas_id, user_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, at = excluded.at",
  shareOf: "SELECT * FROM canvas_shares WHERE canvas_id = ? AND user_id = ?",
  sharesOf: "SELECT * FROM canvas_shares WHERE canvas_id = ? ORDER BY at, user_id",
  deleteShare: "DELETE FROM canvas_shares WHERE canvas_id = ? AND user_id = ?",
  deleteSharesOfCanvas: "DELETE FROM canvas_shares WHERE canvas_id = ?",
  deleteCommandsOfCanvas: "DELETE FROM canvas_commands WHERE canvas_id = ?",
  deleteRunFactsOfCanvas: "DELETE FROM canvas_run_facts WHERE canvas_id = ?",
  deleteRunsOfCanvas: "DELETE FROM canvas_runs WHERE canvas_id = ?",
  usersOfTeam: "SELECT id, team_id, identifier, display_name, role, status FROM users WHERE team_id = ? ORDER BY display_name, id",
  insertCommand:
    "INSERT INTO canvas_commands (id, canvas_id, actor_user_id, actor_kind, command, base_revision, result_revision, outcome, before_doc, at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  recentCommands: "SELECT * FROM canvas_commands WHERE canvas_id = ? ORDER BY at DESC, id DESC LIMIT ?",
  commandById: "SELECT * FROM canvas_commands WHERE id = ?",
  insertRun:
    "INSERT INTO canvas_runs (run_id, canvas_id, node_id, kind, actor_user_id, task_id, base_revision, status, stop_reason, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  runById: "SELECT * FROM canvas_runs WHERE run_id = ?",
  runsOfCanvas: "SELECT * FROM canvas_runs WHERE canvas_id = ? ORDER BY started_at DESC, run_id DESC LIMIT ?",
  finishRun: "UPDATE canvas_runs SET status = ?, stop_reason = ?, finished_at = ? WHERE run_id = ?",
  activeRunsOfCanvas: "SELECT * FROM canvas_runs WHERE canvas_id = ? AND status = 'RUNNING' ORDER BY started_at DESC",
  insertRunTarget:
    "INSERT INTO canvas_run_facts (run_id, canvas_id, node_id, base_revision, target_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET canvas_id = excluded.canvas_id, node_id = excluded.node_id, base_revision = excluded.base_revision, target_json = excluded.target_json, updated_at = excluded.updated_at",
  // 结果写回是**一次性**的：同一 run 重放不覆盖第一次保留的结果（幂等，不重复写图）。
  insertRunResult:
    "INSERT INTO canvas_run_facts (run_id, canvas_id, node_id, result_json, result_status, stop_reason, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET result_json = excluded.result_json, result_status = excluded.result_status, stop_reason = excluded.stop_reason, updated_at = excluded.updated_at WHERE result_json IS NULL",
  runFactById: "SELECT * FROM canvas_run_facts WHERE run_id = ?",
  // task-25 A20：DX 协议任务三元组写入（表由 dxos-foundation-schema 建好）。
  insertProtocolTask:
    "INSERT INTO ai_protocol_tasks (id, surface, owner_id, canvas_id, provider_site_id, model_id, base_url, status, mode, executor_type, executor_adapter, request_json, plan_json, plan_hash, provider_protocol_id, provider_protocol_version, provider_protocol_hash, model_protocol_id, model_protocol_version, model_protocol_hash, profile_id, intent, remote_task_id, result_json, error_message, workflow_state_json, next_poll_at, poll_attempt, created_at, updated_at, started_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  updateProtocolTask:
    "UPDATE ai_protocol_tasks SET status = ?, result_json = ?, error_message = ?, workflow_state_json = ?, updated_at = ?, completed_at = ? WHERE id = ?",
  insertProtocolTaskEvent: "INSERT INTO ai_protocol_task_events (task_id, sequence, type, data_json, created_at) VALUES (?,?,?,?,?)",
  nextProtocolTaskEventSequence: "SELECT COALESCE(MAX(sequence), 0) + 1 AS seq FROM ai_protocol_task_events WHERE task_id = ?",
  protocolTaskById: "SELECT * FROM ai_protocol_tasks WHERE id = ?",
  protocolTasksByCanvas: "SELECT * FROM ai_protocol_tasks WHERE canvas_id = ? ORDER BY created_at DESC, id LIMIT ?",
  // ---- 邀请码（canvas_invites 只存 sha256(code)，明文只在创建响应里出现一次）----
  revokeInvitesOfCanvas: "UPDATE canvas_invites SET revoked_at = ? WHERE canvas_id = ? AND revoked_at IS NULL",
  insertInvite: "INSERT INTO canvas_invites (id, canvas_id, code_hash, code_hint, permission, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
  inviteByCodeHash: "SELECT i.*, c.deleted_at AS canvas_deleted_at FROM canvas_invites i JOIN canvas_boards c ON c.id = i.canvas_id WHERE i.code_hash = ? AND i.revoked_at IS NULL",
  inviteById: "SELECT * FROM canvas_invites WHERE id = ?",
  latestInviteOfCanvas:
    "SELECT i.id, i.code_hint, i.permission, i.created_at, COUNT(m.user_id) AS join_count FROM canvas_invites i " +
    "LEFT JOIN canvas_invite_members m ON m.invite_id = i.id " +
    "WHERE i.canvas_id = ? AND i.revoked_at IS NULL GROUP BY i.id ORDER BY i.created_at DESC LIMIT 1",
  joinInvite: "INSERT OR REPLACE INTO canvas_invite_members (invite_id, user_id, joined_at) VALUES (?,?,?)",
  deleteInviteMembersOfCanvas: "DELETE FROM canvas_invite_members WHERE invite_id IN (SELECT id FROM canvas_invites WHERE canvas_id = ?)",
  deleteInvitesOfCanvas: "DELETE FROM canvas_invites WHERE canvas_id = ?",
};

/**
 * 异步生成 run 的写回事实（目标节点快照 + 被保留的结果）。
 *
 * 为什么由 CanvasStore 自己建表而不是 identity-store 的迁移链：它只服务画布 run 的写回，
 * 是画布持久层的一部分；DDL 全部 IF NOT EXISTS，老库打开即可用，不需要新增一级 schema 迁移。
 *   · target_json —— startRun 时目标节点的归一化快照，用于**按节点粒度**判定并发编辑；
 *   · result_json —— 目标节点已不存在时结果仍留在这里（绝不静默丢用户的 60 秒）；
 *   · result_status/stop_reason —— 结构化原因（TARGET_MISSING / NODE_CONFLICT）。
 */
const RUN_FACTS_SQL = `
CREATE TABLE IF NOT EXISTS canvas_run_facts (
  run_id        TEXT PRIMARY KEY,
  canvas_id     TEXT NOT NULL,
  node_id       TEXT,
  base_revision INTEGER,
  target_json   TEXT,
  result_json   TEXT,
  result_status TEXT,
  stop_reason   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
`;

class CanvasStore {
  constructor({ identity, clock } = {}) {
    if (!identity) throw new Error("CanvasStore 需要 IdentityStore");
    this.identity = identity;
    this.db = identity.connection;
    this.clock = typeof clock === "function" ? clock : identity.clock;
    // 幂等建表：老库（没跑过本版本）打开画布即可用，不依赖 identity-store 的新迁移级。
    this.db.exec(RUN_FACTS_SQL);
    // 共享三档（canvas_shares 的 CHECK/created_at/FK）同样在画布域就绪时显式迁移：
    // 独立函数、事务内执行、已是新形态就空跑；失败整级回滚，不留下半张表。
    this.identity.transactSync(() => applyCanvasSharingRolesLayer(this.db));
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
  /** 永久删除：调用方负责在同一事务里先清共享/命令/运行；board 上的 FK 也会级联清 canvas_shares。*/
  purge({ canvasId }) { this.db.prepare(SQL.purge).run(String(canvasId)); return true; }
  setVisibility({ canvasId, visibility }) { this.db.prepare(SQL.setVisibility).run(String(visibility), String(canvasId)); return this.boardById(canvasId); }
  /** 所有权转移：只改 owner，不改 updated_at / revision（与共享/可见性同一纪律）。*/
  updateOwner({ canvasId, ownerUserId }) { this.db.prepare(SQL.updateOwner).run(String(ownerUserId), String(canvasId)); return this.boardById(canvasId); }

  upsertShare({ canvasId, userId, role, grantedBy }) {
    const now = this.now();
    this.db.prepare(SQL.insertShare).run(String(canvasId), String(userId), String(role), grantedBy == null ? null : String(grantedBy), now, now);
    return this.shareOf({ canvasId, userId });
  }
  shareOf({ canvasId, userId }) { return this.db.prepare(SQL.shareOf).get(String(canvasId), String(userId)) || null; }
  sharesOf(canvasId) { return this.db.prepare(SQL.sharesOf).all(String(canvasId)); }
  deleteShare({ canvasId, userId }) { this.db.prepare(SQL.deleteShare).run(String(canvasId), String(userId)); return true; }
  deleteSharesOfCanvas(canvasId) { this.db.prepare(SQL.deleteSharesOfCanvas).run(String(canvasId)); return true; }
  deleteCommandsOfCanvas(canvasId) { this.db.prepare(SQL.deleteCommandsOfCanvas).run(String(canvasId)); return true; }
  deleteRunsOfCanvas(canvasId) {
    this.db.prepare(SQL.deleteRunFactsOfCanvas).run(String(canvasId));
    this.db.prepare(SQL.deleteRunsOfCanvas).run(String(canvasId));
    return true;
  }
  /** 同组织用户（共享候选人用；包含 DISABLED，由服务层过滤并给结构化原因）。*/
  usersOfTeam(teamId) { return this.db.prepare(SQL.usersOfTeam).all(String(teamId || "")); }

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

  insertRun({ runId, canvasId, nodeId = null, kind, actorUserId, taskId = null, baseRevision = 1, status = "RUNNING" }) {
    this.db.prepare(SQL.insertRun).run(String(runId), String(canvasId), nodeId == null ? null : String(nodeId), String(kind), String(actorUserId), taskId == null ? null : String(taskId), Number(baseRevision) || 1, String(status), null, this.now(), null);
    return this.runById(runId);
  }
  runById(runId) { return this.db.prepare(SQL.runById).get(String(runId || "")) || null; }
  runsOfCanvas(canvasId, limit = 20) { return this.db.prepare(SQL.runsOfCanvas).all(String(canvasId), Number(limit) || 20); }
  activeRunsOfCanvas(canvasId) { return this.db.prepare(SQL.activeRunsOfCanvas).all(String(canvasId)); }
  finishRun({ runId, status, stopReason = null }) {
    this.db.prepare(SQL.finishRun).run(String(status), stopReason == null ? null : String(stopReason), this.now(), String(runId));
    return this.runById(runId);
  }

  /** 记录 run 的目标节点快照（startRun 时；node_id 为空则只落 base_revision）。 */
  recordRunTarget({ runId, canvasId, nodeId = null, baseRevision = 1, target = null }) {
    const now = this.now();
    this.db.prepare(SQL.insertRunTarget).run(
      String(runId), String(canvasId), nodeId == null ? null : String(nodeId), Number(baseRevision) || 1,
      target == null ? null : JSON.stringify(target), now, now,
    );
    return this.runFactById(runId);
  }
  runFactById(runId) { return this.db.prepare(SQL.runFactById).get(String(runId || "")) || null; }

  // ---- task-25 A20：协议任务三元组（ai_protocol_tasks） ----
  insertProtocolTask(row) {
    const now = this.now();
    this.db.prepare(SQL.insertProtocolTask).run(
      String(row.id), String(row.surface || "canvas"), row.ownerId == null ? null : String(row.ownerId), String(row.canvasId),
      row.providerSiteId == null ? null : String(row.providerSiteId), row.modelId == null ? null : String(row.modelId), row.baseUrl == null ? null : String(row.baseUrl),
      String(row.status || "RUNNING"), String(row.mode || "generate"), String(row.executorType || "canvas-host"), row.executorAdapter == null ? null : String(row.executorAdapter),
      String(row.requestJson || "{}"), String(row.planJson || "{}"), String(row.planHash || ""),
      String(row.providerProtocolId || "canvas-host"), Number(row.providerProtocolVersion) || 1, String(row.providerProtocolHash || "canvas-host-v1"),
      String(row.modelProtocolId || "canvas-model"), Number(row.modelProtocolVersion) || 1, String(row.modelProtocolHash || "canvas-model-v1"),
      String(row.profileId || "canvas-default"), String(row.intent || row.mode || "generate"), row.remoteTaskId == null ? null : String(row.remoteTaskId),
      row.resultJson == null ? null : String(row.resultJson), row.errorMessage == null ? null : String(row.errorMessage), row.workflowStateJson == null ? null : String(row.workflowStateJson),
      row.nextPollAt == null ? null : Number(row.nextPollAt), Number(row.pollAttempt) || 0, now, now, row.status === "RUNNING" ? now : null, row.completedAt == null ? null : Number(row.completedAt),
    );
    return this.protocolTaskById(row.id);
  }
  updateProtocolTask({ id, status, resultJson = null, errorMessage = null, workflowStateJson = null, completedAt = null }) {
    const now = this.now();
    this.db.prepare(SQL.updateProtocolTask).run(String(status), resultJson == null ? null : JSON.stringify(resultJson), errorMessage == null ? null : String(errorMessage), workflowStateJson == null ? null : JSON.stringify(workflowStateJson), now, completedAt == null ? now : Number(completedAt), String(id));
    return this.protocolTaskById(id);
  }
  appendProtocolTaskEvent({ taskId, type, data = null }) {
    const seq = Number(this.db.prepare(SQL.nextProtocolTaskEventSequence).get(String(taskId)).seq) || 1;
    this.db.prepare(SQL.insertProtocolTaskEvent).run(String(taskId), seq, String(type), JSON.stringify(data == null ? {} : data), this.now());
    return { taskId, sequence: seq, type: String(type) };
  }
  protocolTaskById(id) { return this.db.prepare(SQL.protocolTaskById).get(String(id || "")) || null; }
  protocolTasksByCanvas(canvasId, limit = 50) { return this.db.prepare(SQL.protocolTasksByCanvas).all(String(canvasId), Number(limit) || 50); }
  /** 目标已不存在时把结果留档：写一次为准（幂等）。 */
  recordRunResult({ runId, canvasId, nodeId = null, result = null, status = "RESULT_STORED", stopReason = null }) {
    const now = this.now();
    this.db.prepare(SQL.insertRunResult).run(
      String(runId), String(canvasId), nodeId == null ? null : String(nodeId),
      result == null ? null : JSON.stringify(result), String(status), stopReason == null ? null : String(stopReason), now, now,
    );
    return this.runFactById(runId);
  }
  /** 目标节点快照（按节点粒度判定并发编辑用）。 */
  runTargetOf(runId) {
    const row = this.runFactById(runId);
    if (!row || !row.target_json) return null;
    try { return { target: JSON.parse(row.target_json), nodeId: row.node_id, baseRevision: Number(row.base_revision || 1) }; } catch { return null; }
  }
  // ---------------------------------------------------------------- 邀请码

  /** 撤销该画布所有未撤销邀请（创建新邀请前调用：同一画布同一时刻只有一个有效口令）。 */
  revokeInvitesOfCanvas(canvasId) { return this.db.prepare(SQL.revokeInvitesOfCanvas).run(this.now(), String(canvasId)).changes; }
  insertInvite({ id, canvasId, codeHash, codeHint, permission, createdBy }) {
    this.db.prepare(SQL.insertInvite).run(String(id), String(canvasId), String(codeHash), String(codeHint), String(permission), String(createdBy), this.now());
    return this.inviteById(id);
  }
  inviteByCodeHash(codeHash) { return this.db.prepare(SQL.inviteByCodeHash).get(String(codeHash)) || null; }
  inviteById(id) { return this.db.prepare(SQL.inviteById).get(String(id || "")) || null; }
  latestInviteOfCanvas(canvasId) { return this.db.prepare(SQL.latestInviteOfCanvas).get(String(canvasId)) || null; }
  joinInvite({ inviteId, userId }) { this.db.prepare(SQL.joinInvite).run(String(inviteId), String(userId), this.now()); return true; }
  /** 永久删除画布时清掉邀请与成员（canvas_invites 没有 FK，不清理会留下无法兑换的孤儿行）。 */
  purgeInvitesOfCanvas(canvasId) {
    this.db.prepare(SQL.deleteInviteMembersOfCanvas).run(String(canvasId));
    this.db.prepare(SQL.deleteInvitesOfCanvas).run(String(canvasId));
    return true;
  }

  /** 被保留的结果（结果可用性/内容）。 */
  runResultOf(runId) {
    const row = this.runFactById(runId);
    if (!row || !row.result_json) return null;
    try { return { result: JSON.parse(row.result_json), status: row.result_status, stopReason: row.stop_reason, at: Number(row.updated_at || 0) }; } catch { return null; }
  }
}

module.exports = { CanvasStore };
