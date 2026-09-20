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
  constructor({ identity, store, resourceStore = null, authService = null, resourceService = null, clock = null, logger = null } = {}) {
    if (!identity || !store) throw new Error("CanvasService 需要 identity 与 store");
    this.identity = identity;
    this.store = store;
    this.resourceStore = resourceStore;
    this.resourceService = resourceService;
    this.authService = authService;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger;
    /** 生成运行 → AbortController（停止时中止在途 HTTP；迟到结果一律丢弃）。*/
    this.abortOf = new Map();
    /** 生成运行需要的任务/模型层（装配顺序原因，晚绑定）。*/
    this.taskService = null;
    this.modelService = null;
    this.tempDir = null;
  }

  /** D5-02 Closure：任务层与模型层装配完成后晚绑定（同一实例，不建第二套）。*/
  attachRuntime({ taskService = null, modelService = null, tempDir = null } = {}) {
    this.taskService = taskService || this.taskService;
    this.modelService = modelService || this.modelService;
    this.tempDir = tempDir || this.tempDir;
    return this;
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

  /** 只读元数据：宿主状态栏与画布页 2.5s 的版本轮询（`/api/canvases/{id}/meta`）用，**不含文档正文**。*/
  metaCanvas({ context, canvasId } = {}) {
    const r = this.#load(context, canvasId);
    if (!r.ok) return r;
    const board = r.board;
    const doc = this.#docOf(board);
    return ok({
      meta: {
        canvasId: board.id, id: board.id,
        title: board.name, icon: board.icon, kind: board.kind,
        revision: Number(board.revision || 1),
        updated_at: Number(board.updated_at || 0), updatedAt: Number(board.updated_at || 0),
        created_at: Number(board.created_at || 0),
        trashed: !!board.deleted_at,
        node_count: (doc.nodes || []).length, connection_count: (doc.connections || []).length,
        access: { canEdit: domain.canEdit(r.access), canView: domain.canView(r.access), source: r.access.source },
      },
    });
  }

  /** 首页"最近画布"：与列表**同一份可见性规则**，只取前 N 条。*/
  recentCanvases({ context, limit = 12 } = {}) {
    const res = this.listCanvases({ context });
    if (!res.ok) return res;
    return ok({ canvases: res.items.slice(0, Math.max(1, Math.min(50, Number(limit) || 12))) });
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


  // ---------------------------------------------------------------- 生成运行（任务 = 预算 / 停止 / 审计归属）

  /**
   * 一次画布生成 = **一个 Task**（appId=canvas）：
   *   · 授权归属：任务属于当前用户；每次模型调用前由 TaskService 重新解析/授权模型绑定；
   *   · 预算归属：任务级 MODEL_CALLS 账本（getTaskBudget / recordBudgetConsumption），与任务层同一份；
   *   · 停止归属：task.requestCancel/cancelTask → cancel_requested，后续调用一律 TASK_CANCELLED；
   *   · 版本归属：run 固定 baseRevision，迟到的结果只在画布未被改动时才允许落回。
   */
  startRun({ context, canvasId, nodeId = null, kind = "chat" } = {}) {
    const r = this.#load(context, canvasId, { needEdit: true });
    if (!r.ok) return r;
    if (!this.taskService || !this.modelService) return fail("RUN_UNAVAILABLE");
    const k = kind === "image" ? "image" : "chat";
    const capability = k === "image" ? "image-generation" : "chat";
    const resolved = this.modelService.resolveModel({ context: { ...context, appId: "canvas" }, capability });
    if (!resolved.ok) return fail(resolved.error);
    // 任务**不绑定**模型配置：每次调用都由 ModelService 按 run 的能力重新解析并授权
    // （比冻结绑定更严：撤权/停用/改能力都会在下一次调用时立即生效）。
    const created = this.taskService.createTask({
      context: { ...context, appId: "canvas" },
      goal: "canvas.generate:" + k + ":" + String(nodeId || "-").slice(0, 60),
      modelConfigId: null,
    });
    if (!created.ok) return created;
    const taskId = created.task.taskId;
    const started = this.taskService.startTask({ context: { ...context, appId: "canvas" }, taskId, expectedRevision: created.task.revision });
    if (!started.ok) { this.taskService.failTask({ context: { ...context, appId: "canvas" }, taskId, errorCode: "RUN_START_FAILED" }); return started; }
    const run = this.store.insertRun({
      runId: "run_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      canvasId, nodeId, kind: k, actorUserId: r.user.id, taskId,
      baseRevision: Number(r.board.revision || 1),
    });
    return ok({ runId: run.run_id, taskId, kind: k, baseRevision: run.base_revision, budget: this.runBudget({ context, runId: run.run_id }) });
  }

  /** 预算/停止快照（只读；给画布与门禁用）。*/
  runBudget({ context, runId } = {}) {
    const run = this.store.runById(runId);
    if (!run) return { ok: false, error: "RUN_NOT_FOUND" };
    if (!this.taskService || !run.task_id) return { ok: false, error: "RUN_UNAVAILABLE" };
    const ctx = { ...context, appId: "canvas" };
    const task = this.taskService.getTask({ context: ctx, taskId: run.task_id });
    const budget = this.taskService.getTaskBudget({ context: ctx, taskId: run.task_id });
    return {
      ok: true, runId: run.run_id, taskId: run.task_id, status: run.status,
      cancelRequested: !!(task.ok && task.task.cancelRequested),
      remaining: budget.ok ? budget.remaining : null,
      authorized: budget.ok ? budget.authorized : null,
      consumed: budget.ok ? budget.consumed : null,
    };
  }

  /** 用户停止：任务级取消 + run 终结；**在途请求由调用方 abort**，迟到结果不再被接受。*/
  stopRun({ context, canvasId, runId, reason = "USER_STOP" } = {}) {
    const run = this.store.runById(runId);
    if (!run || run.canvas_id !== String(canvasId)) return fail("RUN_NOT_FOUND");
    const r = this.#load(context, canvasId, { needEdit: true });
    if (!r.ok) return r;
    if (run.actor_user_id !== r.user.id && !domain.canEdit(r.access)) return fail(REASON.READ_ONLY, r.access.source);
    const ctx = { ...context, appId: "canvas" };
    let cancelled = null;
    if (this.taskService && run.task_id) {
      const task = this.taskService.getTask({ context: ctx, taskId: run.task_id });
      if (task.ok) {
        this.taskService.requestCancel({ context: ctx, taskId: run.task_id, expectedRevision: task.task.revision });
        const fresh = this.taskService.getTask({ context: ctx, taskId: run.task_id });
        cancelled = this.taskService.cancelTask({ context: ctx, taskId: run.task_id, expectedRevision: fresh.ok ? fresh.task.revision : task.task.revision });
      }
    }
    const finished = this.store.finishRun({ runId: run.run_id, status: "STOPPED", stopReason: String(reason).slice(0, 60) });
    if (this.abortOf) { const ac = this.abortOf.get(run.run_id); if (ac) { try { ac.abort(); } catch { /* ignore */ } this.abortOf.delete(run.run_id); } }
    return ok({ run: this.#runView(finished), cancel: cancelled && cancelled.ok ? { ok: true, status: cancelled.task.status, cancelRequested: cancelled.task.cancelRequested } : null });
  }

  #runView(run) {
    if (!run) return null;
    return { runId: run.run_id, canvasId: run.canvas_id, nodeId: run.node_id, kind: run.kind, taskId: run.task_id, status: run.status, stopReason: run.stop_reason, baseRevision: Number(run.base_revision || 1), startedAt: run.started_at, finishedAt: run.finished_at };
  }

  runState({ context, canvasId, runId } = {}) {
    const run = this.store.runById(runId);
    if (!run || run.canvas_id !== String(canvasId)) return fail("RUN_NOT_FOUND");
    const r = this.#load(context, canvasId);
    if (!r.ok) return r;
    return ok({ run: this.#runView(run), budget: this.runBudget({ context, runId }) });
  }

  listRuns({ context, canvasId, limit = 20 } = {}) {
    const r = this.#load(context, canvasId);
    if (!r.ok) return r;
    return ok({ items: this.store.runsOfCanvas(canvasId, limit).map((x) => this.#runView(x)) });
  }

  /**
   * 运行中的模型调用（文本 / 图片）：**唯一入口**。
   * 依次：权限（同一规则）→ run 归属与存活 → 任务停止态 → 预算 → TaskService 记账 → ModelService → 记账收口。
   * 任一前置不通过就**不发出任何请求**（provider 侧看不到调用）。
   */
  async modelCall({ context, canvasId, runId, kind = "chat", messages = null, prompt = "", size = null, count = 1, configId = null, signal = null } = {}) {
    const run = this.store.runById(runId);
    if (!run || run.canvas_id !== String(canvasId)) return fail("RUN_NOT_FOUND");
    const r = this.#load(context, canvasId, { needEdit: true });
    if (!r.ok) return r;
    if (run.status !== "RUNNING") return fail("RUN_STOPPED", { status: run.status });
    if (!this.taskService || !this.modelService) return fail("RUN_UNAVAILABLE");
    const ctx = { ...context, appId: "canvas" };
    const task = this.taskService.getTask({ context: ctx, taskId: run.task_id });
    if (!task.ok) return task;
    if (task.task.cancelRequested) { this.store.finishRun({ runId: run.run_id, status: "STOPPED", stopReason: "TASK_CANCELLED" }); return fail("TASK_CANCELLED"); }
    // 预算：任务级 MODEL_CALLS 账本（与任务层同一份），耗尽 → 明确拒绝，不发请求。
    const budget = this.taskService.getTaskBudget({ context: ctx, taskId: run.task_id });
    if (budget.ok && budget.remaining && Number(budget.remaining.MODEL_CALLS) <= 0) {
      this.store.finishRun({ runId: run.run_id, status: "BUDGET_EXHAUSTED", stopReason: "MODEL_CALLS" });
      return fail("BUDGET_EXHAUSTED", { remaining: budget.remaining, authorized: budget.authorized, consumed: budget.consumed });
    }
    const binding = this.taskService.checkModelConfig({ context: ctx, taskId: run.task_id });
    if (!binding.ok) return binding;
    const call = this.taskService.startModelCall({ context: ctx, taskId: run.task_id, expectedRevision: task.task.revision });
    if (!call.ok) return call;
    const ac = new AbortController();
    if (this.abortOf) this.abortOf.set(run.run_id, ac);
    const onAbort = () => { try { ac.abort(); } catch { /* ignore */ } };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = kind === "image"
        ? await this.modelService.generateImage({ context: ctx, configId: configId || null, prompt: String(prompt || ""), size, count: Math.max(1, Math.min(4, Number(count) || 1)), signal: ac.signal, capability: "image-generation" })
        : await this.modelService.chat({ context: ctx, configId: configId || null, messages: Array.isArray(messages) ? messages : [], signal: ac.signal, capability: "chat" });
      const fresh = this.taskService.getTask({ context: ctx, taskId: run.task_id });
      const rev = fresh.ok ? fresh.task.revision : task.task.revision;
      if (res && res.ok) {
        this.taskService.completeModelCall({ context: ctx, taskId: run.task_id, callId: call.call.callId, usage: res.usage || null, requestId: res.requestId || null, expectedRevision: rev });
        this.taskService.recordBudgetConsumption({ context: ctx, taskId: run.task_id, consumption: { MODEL_CALLS: 1 } });
      } else {
        this.taskService.failModelCall({ context: ctx, taskId: run.task_id, callId: call.call.callId, providerErrorCode: (res && res.error) || "MODEL_ERROR", expectedRevision: rev });
      }
      // 迟到 / 停止后的结果一律不返回给画布（诚实：不把已停止的任务改成成功）。
      const after = this.store.runById(run.run_id);
      if (!after || after.status !== "RUNNING") return fail("RUN_STOPPED", { status: after ? after.status : "STOPPED" });
      if (!res || !res.ok) return res && res.ok === false ? res : fail("MODEL_ERROR");
      // 画布在生成期间被改动过（版本前进）→ 结果不落回，用户内容优先。
      const board = this.store.boardById(canvasId);
      if (board && Number(board.revision) !== Number(run.base_revision)) {
        this.store.finishRun({ runId: run.run_id, status: "SUPERSEDED", stopReason: "CANVAS_CHANGED" });
        return fail("CANVAS_CHANGED", { baseRevision: Number(run.base_revision), revision: Number(board.revision) });
      }
      return res;
    } catch (err) {
      const fresh = this.taskService.getTask({ context: ctx, taskId: run.task_id });
      this.taskService.failModelCall({ context: ctx, taskId: run.task_id, callId: call.call.callId, providerErrorCode: String((err && err.message) || "MODEL_ERROR").slice(0, 60), expectedRevision: fresh.ok ? fresh.task.revision : task.task.revision });
      return fail("MODEL_ERROR");
    } finally {
      if (this.abortOf) this.abortOf.delete(run.run_id);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  /** 正常收口：任务完成（结果已由画布落盘）。*/
  finishRun({ context, canvasId, runId, status = "DONE" } = {}) {
    const run = this.store.runById(runId);
    if (!run || run.canvas_id !== String(canvasId)) return fail("RUN_NOT_FOUND");
    const r = this.#load(context, canvasId, { needEdit: true });
    if (!r.ok) return r;
    const ctx = { ...context, appId: "canvas" };
    if (this.taskService && run.task_id && ["DONE", "FAILED"].includes(String(status))) {
      const task = this.taskService.getTask({ context: ctx, taskId: run.task_id });
      if (task.ok && task.task.status === "RUNNING") {
        if (status === "DONE") this.taskService.completeTask({ context: ctx, taskId: run.task_id, expectedRevision: task.task.revision });
        else this.taskService.failTask({ context: ctx, taskId: run.task_id, errorCode: "CANVAS_NODE_FAILED", expectedRevision: task.task.revision });
      }
    }
    return ok({ run: this.#runView(this.store.finishRun({ runId: run.run_id, status: String(status), stopReason: null })) });
  }

  // ---------------------------------------------------------------- 资源库图片（统一存储口径）

  /** 本地导入图片：写进**现有资源库**（managed store），画布只拿稳定 ResourceRef。*/
  async importAsset({ context, canvasId, name = "canvas-image", dataUrl = "" } = {}) {
    const r = this.#load(context, canvasId, { needEdit: true });
    if (!r.ok) return r;
    if (!this.resourceService || typeof this.resourceService.importManaged !== "function") return fail("RESOURCE_UNAVAILABLE");
    const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
    if (!m) return fail(REASON.INVALID_INPUT);
    const bytes = Buffer.from(m[2], "base64");
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) return fail(REASON.LIMIT_EXCEEDED);
    // 注入的 tempDir 既可能是字符串路径，也可能是返回路径的函数（identity-bootstrap 传字符串）。
    const dir = typeof this.tempDir === "function" ? this.tempDir() : (this.tempDir || null);
    if (!dir) return fail("RESOURCE_UNAVAILABLE");
    const safe = String(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "canvas-image";
    const file = require("node:path").join(dir, "canvas-import-" + Date.now().toString(36) + "-" + safe);
    require("node:fs").writeFileSync(file, bytes);
    try {
      const imported = await this.resourceService.importManaged({ context: { ...context, appId: "resource-library" }, sourcePath: file, name: safe, resourceType: m[1].startsWith("video") ? "video" : "image", scope: "PERSONAL" });
      if (!imported || !imported.ok) return imported && imported.error ? imported : fail("IMPORT_FAILED");
      const ref = imported.resource && (imported.resource.resourceId || imported.resource.resourceRef);
      return ok({ ref: ref ? "openarc-asset:" + String(ref).replace(/^openarc-resource:/, "") : null, resource: imported.resource || null });
    } finally {
      try { require("node:fs").rmSync(file, { force: true }); } catch { /* ignore */ }
    }
  }

  /** 解析引用（受控加载路径）：只有当前用户有读权限、且未被回收时才会返回内容。*/
  readAsset({ context, ref } = {}) {
    const r = this.#actor(context);
    if (!r.ok) return r;
    const id = authz.parseResourceRef(String(ref || ""));
    if (!id) return fail(REASON.INVALID_INPUT);
    const row = this.resourceStore ? this.resourceStore.resourceRowById(id) : null;
    if (!row || row.trash_state === "TRASHED" || row.registry_status !== "active") return fail("ASSET_UNAVAILABLE");
    // 授权：应用授权 OR **资源属于当前用户本人**（与画布 OWNER_POLICY 同一口径）。
    // 之前只查 canvas 应用对资源的 grant，导致"自己刚导入的图，重开画布就变成不可用"。
    if (this.authService) {
      const auth = this.authService.authorize({ context, action: authz.ACTION.READ, resource: id });
      const ownerOk = row.owner_user_id != null && String(row.owner_user_id) === String(r.user.id);
      if ((!auth || auth.decision !== "ALLOW") && !ownerOk) return fail("ASSET_FORBIDDEN");
    }
    if (typeof this.resourceService.readDataUrl !== "function") return fail("ASSET_UNAVAILABLE");
    const data = this.resourceService.readDataUrl({ context, resourceRef: id });
    if (!data || !data.ok) return fail("ASSET_UNAVAILABLE");
    return ok({ ref: "openarc-asset:" + id, dataUrl: data.dataUrl, name: row.name, version: Number(row.version || 1) });
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
        const ownerOk = row.owner_user_id != null && String(row.owner_user_id) === String(actor.user.id);
        if ((!auth || auth.decision !== "ALLOW") && !ownerOk) { exists[ref] = { state: "UNAUTHORIZED" }; continue; }
      }
      exists[ref] = { state: "AVAILABLE", name: row.name, version: Number(row.version || 1) };
    }
    return ok({ exists });
  }
}

module.exports = { CanvasService };
