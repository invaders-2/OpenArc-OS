/**
 * D5-02 · 无限画布服务（身份 / 权限 / 版本检查 / 命令层 / 资源可用性）。
 *
 * 三条不变量：
 *   1. **只有一份命令处理层**（canvas-domain）：手工路径（保存 + 页面内命令）与 AI 路径
 *      （受控工具 canvas.edit）都调用同一个 applyCommand + 同一份版本检查 + 同一份权限规则。
 *   2. **只有一个模型入口**：画布不持有任何密钥/地址；模型调用一律走 Model Service（见 canvas-bootstrap）。
 *   3. **没有第二套画布**：board 身份与资源引用沿用 D3-04D 的 canvas_boards / canvas_resource_nodes。
 */
"use strict";

const domain = require("./canvas-domain.cjs");
const authz = require("./authorization-domain.cjs");

const { REASON } = domain;
const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });

const CANVAS_ID = () => "cv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
const CMD_ID = () => "cc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

class CanvasService {
  constructor({ identity, store, resourceStore = null, authService = null, clock = null, logger = null } = {}) {
    if (!identity || !store) throw new Error("CanvasService 需要 identity 与 store");
    this.identity = identity;
    this.store = store;
    this.resourceStore = resourceStore;
    this.authService = authService;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger;
  }

  // ---------------------------------------------------------------- 内部

  #actor(context) {
    const v = this.identity.validateSession(context && context.sessionRef, { sensitive: false });
    if (!v || !v.ok) return fail("NOT_FOUND_OR_FORBIDDEN");
    return ok({ user: v.user });
  }

  #access(context, board) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const share = board ? this.store.shareOf({ canvasId: board.id, userId: actor.user.id }) : null;
    const access = domain.evaluateCanvasAccess({
      actor: { userId: actor.user.id, organizationId: actor.user.team_id, isSuper: String(actor.user.role) === "ADMIN" },
      entry: board,
      share,
    });
    return ok({ user: actor.user, access, share });
  }

  #load(context, canvasId, { needEdit = false, allowTrashed = false } = {}) {
    const board = canvasId ? this.store.boardById(canvasId) : null;
    if (!board) return fail("NOT_FOUND");
    if (board.deleted_at && !allowTrashed) return fail("NOT_FOUND");
    const a = this.#access(context, board);
    if (!a.ok) return a;
    if (!domain.canView(a.access)) return fail("NOT_FOUND_OR_FORBIDDEN");
    if (needEdit && !domain.canEdit(a.access)) return fail(REASON.READ_ONLY, a.access.source);
    return ok({ board, user: a.user, access: a.access, share: a.share });
  }

  #docOf(board) {
    let raw = null;
    try { raw = JSON.parse(board.doc || "null"); } catch { raw = null; }
    const norm = domain.normalizeDoc(raw || domain.emptyDoc());
    return norm.ok ? norm.doc : domain.emptyDoc();
  }

  #view(board, access, { doc = null } = {}) {
    return {
      canvasId: board.id,
      title: board.name,
      icon: board.icon,
      kind: board.kind,
      doc: doc || this.#docOf(board),
      revision: Number(board.revision || 1),
      updatedAt: Number(board.updated_at || 0),
      createdAt: Number(board.created_at || 0),
      ownerUserId: board.owner_user_id,
      visibility: board.visibility || "PRIVATE",
      trashed: !!board.deleted_at,
      access: { canEdit: domain.canEdit(access), canView: domain.canView(access), source: access.source },
    };
  }

  // ---------------------------------------------------------------- 渲染层命令

  createCanvas({ context, title = "未命名画布", icon = "🧩", kind = "classic", doc = null } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const norm = domain.normalizeDoc(doc || domain.emptyDoc());
    if (!norm.ok) return fail(norm.reason);
    const canvasId = CANVAS_ID();
    const board = this.store.insertBoard({
      canvasId,
      organizationId: actor.user.team_id,
      ownerUserId: actor.user.id,
      name: String(title).slice(0, 200) || "未命名画布",
      icon: String(icon || "🧩").slice(0, 16),
      kind: String(kind || "classic").slice(0, 20),
      doc: norm.doc,
    });
    const a = this.#access(context, board);
    return ok({ canvas: this.#view(board, a.ok ? a.access : { allow: true, actions: [...authz.OWNER_ACTIONS], source: "OWNER_POLICY" }) });
  }

  listCanvases({ context, includeTrashed = false } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const userId = actor.user.id;
    const seen = new Map();
    const push = (board, shareRole) => {
      if (!board || seen.has(board.id)) return;
      const share = shareRole ? { user_id: userId, role: shareRole } : this.store.shareOf({ canvasId: board.id, userId });
      const access = domain.evaluateCanvasAccess({
        actor: { userId, organizationId: actor.user.team_id, isSuper: String(actor.user.role) === "ADMIN" },
        entry: board,
        share,
      });
      if (!domain.canView(access)) return;
      seen.set(board.id, { ...this.#view(board, access), shareRole: share ? share.role : null });
    };
    const owned = this.store.boardsOwned(userId).filter((b) => (includeTrashed ? true : !b.deleted_at));
    owned.forEach((b) => push(b));
    this.store.boardsShared(userId).filter((b) => !b.deleted_at).forEach((b) => push(b, b.share_role));
    this.store.boardsOrg(actor.user.team_id).filter((b) => !b.deleted_at).forEach((b) => push(b));
    const items = [...seen.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    return ok({ items, canvases: items });
  }

  getCanvas({ context, canvasId } = {}) {
    const r = this.#load(context, canvasId);
    if (!r.ok) return r;
    return ok({ canvas: this.#view(r.board, r.access) });
  }

  /** 手工路径保存：整文档 + 基准版本（版本不一致 → 返回当前文档与 revision，由界面合并/提示）。*/
  saveCanvas({ context, canvasId, baseRevision = null, doc = null, title = null, icon = null } = {}) {
    const r = this.#load(context, canvasId, { needEdit: true });
    if (!r.ok) return r;
    // doc == null = 只改标题/图标的元数据更新（仍走同一条版本检查）。
    const norm = doc == null ? { ok: true, doc: this.#docOf(r.board) } : domain.normalizeDoc(doc);
    if (!norm.ok) return fail(norm.reason);
    const base = baseRevision == null ? Number(r.board.revision || 1) : Number(baseRevision);
    const updated = this.store.transactSync(() =>
      this.store.updateDoc({
        canvasId,
        name: title == null ? r.board.name : String(title).slice(0, 200),
        icon: icon == null ? r.board.icon : String(icon).slice(0, 16),
        doc: norm.doc,
        baseRevision: base,
      }),
    );
    if (!updated) {
      const current = this.store.boardById(canvasId);
      return fail(REASON.REVISION_CONFLICT, { canvas: this.#view(current, r.access) });
    }
    return ok({ canvas: this.#view(updated, r.access) });
  }

  trashCanvas({ context, canvasId } = {}) {
    const r = this.#load(context, canvasId, { needEdit: true });
    if (!r.ok) return r;
    if (!r.access.actions.includes(authz.ACTION.DELETE) && r.board.owner_user_id !== r.user.id) return fail(REASON.READ_ONLY, r.access.source);
    return ok({ canvas: this.#view(this.store.softDelete({ canvasId, by: r.user.id }), r.access) });
  }

  restoreCanvas({ context, canvasId } = {}) {
    const r = this.#load(context, canvasId, { needEdit: true, allowTrashed: true });
    if (!r.ok) return r;
    return ok({ canvas: this.#view(this.store.restore({ canvasId }), r.access) });
  }

  purgeCanvas({ context, canvasId } = {}) {
    const board = this.store.boardById(canvasId);
    if (!board) return fail("NOT_FOUND");
    const a = this.#access(context, board);
    if (!a.ok) return a;
    if (board.owner_user_id !== a.user.id && String(a.user.role) !== "ADMIN") return fail(REASON.READ_ONLY, a.access.source);
    this.store.purge({ canvasId });
    return ok({ purged: canvasId });
  }

  /** 共享角色（A28 的只读成员由此产生）。只有owner/管理员能改共享面。*/
  shareCanvas({ context, canvasId, userId = null, role = "VIEWER" } = {}) {
    const board = this.store.boardById(canvasId);
    if (!board) return fail("NOT_FOUND");
    const a = this.#access(context, board);
    if (!a.ok) return a;
    const isOwner = board.owner_user_id === a.user.id || String(a.user.role) === "ADMIN";
    if (!isOwner) return fail(REASON.READ_ONLY, a.access.source);
    const target = String(userId || "").trim();
    if (!target) return ok({ shares: this.store.sharesOf(canvasId) });
    if (target === board.owner_user_id) return fail("INVALID_INPUT", "owner");
    const r = String(role || "VIEWER").toUpperCase();
    if (!["VIEWER", "CONTRIBUTOR", "EDITOR"].includes(r)) return fail("INVALID_INPUT", "role");
    this.store.upsertShare({ canvasId, userId: target, role: r, grantedBy: a.user.id });
    return ok({ shares: this.store.sharesOf(canvasId) });
  }

  setVisibility({ context, canvasId, visibility = "PRIVATE" } = {}) {
    const board = this.store.boardById(canvasId);
    if (!board) return fail("NOT_FOUND");
    const a = this.#access(context, board);
    if (!a.ok) return a;
    if (board.owner_user_id !== a.user.id && String(a.user.role) !== "ADMIN") return fail(REASON.READ_ONLY, a.access.source);
    const v = String(visibility).toUpperCase() === "ORGANIZATION" ? "ORGANIZATION" : "PRIVATE";
    return ok({ canvas: this.#view(this.store.setVisibility({ canvasId, visibility: v }), a.access) });
  }

  listShares({ context, canvasId } = {}) {
    const r = this.#load(context, canvasId);
    if (!r.ok) return r;
    return ok({ shares: this.store.sharesOf(canvasId) });
  }

  // ---------------------------------------------------------------- 共享命令层（手工 + AI 同一入口）

  /**
   * @param actorKind 'USER' | 'AGENT'
   * 规则：权限（同一份 evaluateCanvasAccess）→ 版本检查（baseRevision）→ 领域命令 → 新 revision 落库 + 记账。
   */
  applyCommand({ context, canvasId, baseRevision = null, command = null, actorKind = "USER" } = {}) {
    const r = this.#load(context, canvasId, { needEdit: true });
    if (!r.ok) return r;
    const normCmd = domain.normalizeCommand(command);
    if (!normCmd.ok) return fail(normCmd.reason);
    if (String(actorKind).toUpperCase() === "AGENT" && !domain.AGENT_COMMANDS.includes(normCmd.command.type)) {
      return fail(REASON.UNSUPPORTED_COMMAND, "agent:" + normCmd.command.type);
    }
    const base = baseRevision == null ? Number(r.board.revision || 1) : Number(baseRevision);
    if (base !== Number(r.board.revision || 1)) {
      return fail(REASON.REVISION_CONFLICT, { canvas: this.#view(r.board, r.access), baseRevision: base });
    }
    const doc = this.#docOf(r.board);
    const applied = domain.applyCommand(doc, normCmd.command);
    if (!applied.ok) return fail(applied.reason, { command: normCmd.command });
    const updated = this.store.transactSync(() => {
      const next = this.store.updateDoc({ canvasId, name: r.board.name, icon: r.board.icon, doc: applied.doc, baseRevision: base });
      this.store.insertCommand({
        id: CMD_ID(), canvasId, actorUserId: r.user.id, actorKind: String(actorKind).toUpperCase(),
        command: normCmd.command, baseRevision: base, resultRevision: next ? Number(next.revision) : null,
        outcome: next ? "APPLIED" : "CONFLICT", beforeDoc: applied.ok ? doc : null,
      });
      return next;
    });
    if (!updated) return fail(REASON.REVISION_CONFLICT, { canvas: this.#view(this.store.boardById(canvasId), r.access) });
    return ok({ canvas: this.#view(updated, r.access), command: normCmd.command, result: applied.result, touched: applied.touched });
  }

  /** 命令账本（撤销记录）。*/
  commandLog({ context, canvasId, limit = 20 } = {}) {
    const r = this.#load(context, canvasId);
    if (!r.ok) return r;
    return ok({
      items: this.store.recentCommands(canvasId, limit).map((row) => ({
        id: row.id, actorKind: row.actor_kind, actorUserId: row.actor_user_id, command: JSON.parse(row.command || "{}"),
        baseRevision: row.base_revision, resultRevision: row.result_revision, outcome: row.outcome, at: row.at,
      })),
    });
  }

  /** 撤销上一条**已应用**命令（按账本恢复 before_doc；AI 与手工共用同一条记录）。*/
  undoLastCommand({ context, canvasId, baseRevision = null } = {}) {
    const r = this.#load(context, canvasId, { needEdit: true });
    if (!r.ok) return r;
    const base = baseRevision == null ? Number(r.board.revision || 1) : Number(baseRevision);
    if (base !== Number(r.board.revision || 1)) return fail(REASON.REVISION_CONFLICT, { canvas: this.#view(r.board, r.access) });
    const last = this.store.recentCommands(canvasId, 20).find((row) => row.outcome === "APPLIED" && row.before_doc);
    if (!last) return fail("NOT_FOUND", "no-command");
    const before = JSON.parse(last.before_doc);
    const norm = domain.normalizeDoc(before);
    if (!norm.ok) return fail(norm.reason);
    const updated = this.store.transactSync(() => {
      const next = this.store.updateDoc({ canvasId, name: r.board.name, icon: r.board.icon, doc: norm.doc, baseRevision: base });
      this.store.insertCommand({
        id: CMD_ID(), canvasId, actorUserId: r.user.id, actorKind: "USER",
        command: { type: "undo", ofCommandId: last.id }, baseRevision: base, resultRevision: next ? Number(next.revision) : null,
        outcome: next ? "APPLIED" : "CONFLICT", beforeDoc: this.#docOf(r.board),
      });
      return next;
    });
    if (!updated) return fail(REASON.REVISION_CONFLICT, { canvas: this.#view(this.store.boardById(canvasId), r.access) });
    return ok({ canvas: this.#view(updated, r.access), undone: last.id });
  }

  /** AI 只读摘要：**无凭据、无资源字节、无绝对路径**；正文有界，标注 untrusted。*/
  readCanvas({ context, canvasId, maxNodes = 200 } = {}) {
    const r = this.#load(context, canvasId);
    if (!r.ok) return r;
    const doc = this.#docOf(r.board);
    const limit = Math.max(1, Math.min(500, Number(maxNodes) || 200));
    return ok({
      summary: {
        canvasId: r.board.id,
        title: String(r.board.name || "").slice(0, 120),
        revision: Number(r.board.revision || 1),
        nodeCount: doc.nodes.length,
        edgeCount: doc.connections.length,
        nodes: doc.nodes.slice(0, limit).map((n) => ({
          id: n.id, type: n.type, x: n.x, y: n.y,
          name: typeof n.name === "string" ? n.name.slice(0, 120) : undefined,
          text: typeof n.text === "string" ? n.text.slice(0, 200) : undefined,
          prompt: typeof n.prompt === "string" ? n.prompt.slice(0, 200) : undefined,
          media: typeof n.url === "string" && n.url ? (n.url.startsWith("openarc-asset:") ? n.url : "[media]") : undefined,
        })),
        edges: doc.connections.slice(0, limit).map((c) => ({ id: c.id, from: c.from, to: c.to })),
        untrusted: true,
      },
    });
  }

  // ---------------------------------------------------------------- 资源可用性（A08）

  /** 画布引用的资源是否仍可用：AVAILABLE / UNAVAILABLE(回收站) / DELETED / UNAUTHORIZED。*/
  assetStates({ context, refs = [] } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const exists = {};
    for (const raw of (Array.isArray(refs) ? refs : []).slice(0, 200)) {
      const ref = String(raw || "");
      const id = authz.parseResourceRef(ref);
      if (!id) { exists[ref] = { state: "DELETED" }; continue; }
      const row = this.resourceStore ? this.resourceStore.resourceRowById(id) : null;
      if (!row) { exists[ref] = { state: "DELETED" }; continue; }
      if (row.trash_state === "TRASHED") { exists[ref] = { state: "UNAVAILABLE" }; continue; }
      if (row.registry_status !== "active") { exists[ref] = { state: "DELETED" }; continue; }
      if (this.authService) {
        const auth = this.authService.authorize({ context, action: authz.ACTION.READ, resource: id });
        if (!auth || auth.decision !== "ALLOW") { exists[ref] = { state: "UNAUTHORIZED" }; continue; }
      }
      exists[ref] = { state: "AVAILABLE", name: row.name, version: Number(row.version || 1) };
    }
    return ok({ exists });
  }
}

module.exports = { CanvasService };
