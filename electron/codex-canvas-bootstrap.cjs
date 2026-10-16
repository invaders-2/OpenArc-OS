/**
 * DX OS 0.6.1 · codex-canvas 引导层（源：server/index.ts:1193-1264 + server/codexCanvas.ts:126-142）。
 *
 * 职责与边界：
 *   · 本文件是**唯一**把中继落到进程内的地方。源在 index.ts:1247-1251 把白名单路由 fetch 回
 *     本机 HTTP；本仓改成 routeDispatcher 直接调用既有 canvasService / canvas-domain 命令，
 *     不新建画布、不新增模型入口、不自起 HTTP。
 *   · 暴露独立域 codexCanvas:command（不动 main.cjs / preload.cjs；接线参数见文末注释），
 *     trusted(event) 与 canvas:command 同一条边界：缺失 isTrusted 一律 Forbidden。
 *   · 云能力（image-models / generation/*）在本仓 OUT：返回结构化 CLOUD_DISABLED（501），
 *     绝不用本地假数据冒充模型目录或生成结果。
 */
"use strict";

const { randomBytes } = require("node:crypto");
const relayModule = require("./codex-canvas-relay.cjs");
const installerModule = require("./codex-canvas-installer.cjs");

const CHANNEL = "codexCanvas:command";
const EVENT_CHANNEL = "codexCanvas:event";
const DOMAIN = "codex-canvas";

// 与源 index.ts:1219-1224 白名单一一对应；generation/* 与 image-models 在列但本仓结构化拒绝。
const COMMANDS = Object.freeze([
  "codexCanvas/status",
  "codexCanvas/pair",
  "codexCanvas/revoke",
  "codexCanvas/relay",
  "codexCanvas/setup",
  "codexCanvas/install",
  "codexCanvas/commands",
]);
const CLOUD_ROUTES = Object.freeze([
  "GET /image-models",
  "POST /generation/preview",
  "POST /generation/execute",
  "POST /generation/query",
]);
const IMAGE_ROUTE_PREFIX = "/generation/images";

const asStr = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : v == null ? null : String(v).slice(0, max));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function statusFor(result) {
  if (!result || result.ok) return 200;
  switch (String(result.error)) {
    case "NOT_FOUND": return 404;
    case "NOT_FOUND_OR_FORBIDDEN": return 403;
    case "READ_ONLY": return 403;
    case "REVISION_CONFLICT": return 409;
    case "UNSUPPORTED_COMMAND":
    case "LIMIT_EXCEEDED":
    case "INVALID_INPUT": return 422;
    default: return 400;
  }
}

/** 把 canvasService 的 view 投影成源 codexCanvasSnapshot 同形的只读快照（codexCanvas.ts:126-142）。 */
function projectSnapshot(view) {
  const doc = view && view.doc && typeof view.doc === "object" ? view.doc : { nodes: [], connections: [] };
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const connections = Array.isArray(doc.connections) ? doc.connections : [];
  return {
    id: view.canvasId,
    title: view.title,
    version: view.revision,
    access: view.access,
    availableTools: ["find_nodes", "get_nodes", "rename_node", "edit_node", "change_connection", "create_cards"],
    unavailableActions: ["run_workflow", "group_nodes", "delete_nodes", "list_image_models", "preview_generation", "execute_generation", "query_generation"],
    cards: nodes.map((node) => ({
      id: node.id,
      kind: node.type || "media",
      title: node.title || node.name || "",
      x: node.x, y: node.y, w: node.w, h: node.h,
      prompt: node.prompt,
      engine: node.provider || node.engine,
      model: node.model,
      run: node.runStatus || "IDLE",
      mediaName: node.name || null,
    })),
    connections: connections.map(({ id, from, to, kind }) => ({ id, from, to, kind })),
  };
}

/**
 * 进程内路由分发：源的 fetch(127.0.0.1) 替代品（index.ts:1247-1252）。
 * @returns {Promise<{status:number, body:unknown}>}
 */
function createCanvasRouteDispatcher({ canvasService, contextForGrant, appId = "canvas" } = {}) {
  if (!canvasService || typeof canvasService.getCanvas !== "function") throw new Error("createCanvasRouteDispatcher 需要 canvasService.getCanvas");
  const contextOf = typeof contextForGrant === "function" ? contextForGrant : (grant) => ({ sessionRef: grant.sessionId, appId, source: "bridge" });
  const load = (grant) => canvasService.getCanvas({ context: contextOf(grant), canvasId: grant.canvasId });
  const command = (grant, payload) => canvasService.applyCommand({ context: contextOf(grant), canvasId: grant.canvasId, baseRevision: num(payload.baseRevision), command: payload.command, actorKind: "AGENT" });
  const cloudOut = (path) => ({
    status: 501,
    body: { ok: false, error: "CLOUD_DISABLED", detail: "OpenArc 不实现云能力（云 AI / 云端市场 / 配额）：" + path + " 在本仓不可用" },
  });

  async function dispatch({ method, path, body, grant } = {}) {
    if (CLOUD_ROUTES.includes(method + " " + path) || (method === "GET" && path.startsWith(IMAGE_ROUTE_PREFIX))) return cloudOut(method + " " + path);
    if (method === "GET" && path === "/snapshot") {
      const view = load(grant);
      if (!view.ok) return { status: statusFor(view), body: view };
      return { status: 200, body: { ok: true, canvas: projectSnapshot(view.canvas) } };
    }
    if (method === "POST" && path === "/nodes/find") {
      const view = load(grant);
      if (!view.ok) return { status: statusFor(view), body: view };
      const query = String((body && body.query) || "").toLowerCase();
      const kind = asStr(body && body.kind, 40);
      const limit = Math.max(1, Math.min(200, Number((body && body.limit) || 50) || 50));
      const nodes = (view.canvas.doc.nodes || []).filter((node) => {
        if (kind && String(node.type) !== kind) return false;
        if (!query) return true;
        return [node.id, node.title, node.name, node.text, node.prompt].some((value) => String(value || "").toLowerCase().includes(query));
      }).slice(0, limit);
      return { status: 200, body: { ok: true, nodes, total: nodes.length } };
    }
    if (method === "POST" && path === "/nodes/get") {
      const view = load(grant);
      if (!view.ok) return { status: statusFor(view), body: view };
      const ids = Array.isArray(body && body.nodeIds) ? body.nodeIds.map(String) : [];
      const wanted = new Set(ids);
      const nodes = (view.canvas.doc.nodes || []).filter((node) => wanted.has(String(node.id)));
      return { status: 200, body: { ok: true, nodes, missing: ids.filter((id) => !nodes.some((node) => String(node.id) === id)) } };
    }
    if (method === "POST" && path === "/nodes/rename") {
      const nodeId = asStr(body && (body.nodeId || body.id), 120);
      const title = asStr(body && (body.title || body.name), 200);
      const result = command(grant, { baseRevision: body && body.baseRevision, command: { type: "node.edit", id: nodeId, patch: { title } } });
      return { status: statusFor(result), body: result };
    }
    if (method === "POST" && path === "/nodes/edit") {
      // 源 index.ts:1294 在编辑前 loadCodexCanvasCloudProvider（云 AI）；本仓云能力 OUT，只做纯画布编辑。
      const nodeId = asStr(body && (body.nodeId || body.id), 120);
      const patch = body && body.patch && typeof body.patch === "object" ? body.patch : {};
      const result = command(grant, { baseRevision: body && body.baseRevision, command: { type: "node.edit", id: nodeId, patch } });
      return { status: statusFor(result), body: result };
    }
    if (method === "POST" && path === "/connections/change") {
      const spec = body && typeof body === "object" ? body : {};
      const cmd = spec.disconnect
        ? { type: "edge.disconnect", id: asStr(spec.id, 120), from: asStr(spec.from, 120), to: asStr(spec.to, 120) }
        : { type: "edge.connect", id: asStr(spec.id, 120), from: asStr(spec.from, 120), to: asStr(spec.to, 120) };
      const result = command(grant, { baseRevision: spec.baseRevision, command: cmd });
      return { status: statusFor(result), body: result };
    }
    if (method === "POST" && path === "/cards") {
      const cards = Array.isArray(body && body.cards) ? body.cards.slice(0, 100) : [];
      const view = load(grant);
      if (!view.ok) return { status: statusFor(view), body: view };
      const used = new Set((view.canvas.doc.nodes || []).map((node) => String(node.id)));
      let last = null;
      for (const card of cards) {
        const id = asStr(card && card.id, 120) || "card_" + randomBytes(6).toString("hex");
        if (used.has(id)) return { status: 409, body: { ok: false, error: "INVALID_INPUT", detail: "节点 id 已存在：" + id } };
        used.add(id);
        const node = {
          id,
          type: asStr(card && card.kind, 40) || "image",
          x: num(card && card.x) || 0,
          y: num(card && card.y) || 0,
          title: asStr(card && card.title, 200) || undefined,
          prompt: asStr(card && card.prompt, 4000) || undefined,
        };
        const result = command(grant, { baseRevision: card && card.baseRevision, command: { type: "node.add", node } });
        if (!result.ok) return { status: statusFor(result), body: result };
        last = result;
      }
      return { status: 200, body: { ok: true, cards: cards.map((card, index) => ({ id: asStr(card && card.id, 120) || null, index })), canvas: last ? last.canvas : view.canvas } };
    }
    return { status: 404, body: { ok: false, error: "NOT_FOUND", detail: "未登记的中继路由" } };
  }

  return { dispatch, projectSnapshot };
}

/**
 * 独立域装配。
 * @param identity  IdentityService（只读 current / validateSession）
 * @param canvasService 既有 CanvasService（与 canvas-bootstrap 同一实例）
 */
function createCodexCanvasDomain({ identity = null, canvasService = null, clock = null, logger = null, appId = "canvas", deps = {} } = {}) {
  const emitSink = { fn: null };
  const emit = (kind, payload) => {
    if (!emitSink.fn) return;
    const event = { channel: EVENT_CHANNEL, domain: DOMAIN, kind, at: Date.now(), payload };
    try { emitSink.fn(event); } catch { /* 事件失败不改变业务结果 */ }
  };
  const contextForGrant = (grant) => ({ sessionRef: grant.sessionId, appId, source: "bridge" });

  const sessionActive = (grant) => {
    if (!identity || typeof identity.validateSession !== "function") return true;
    const view = identity.validateSession(grant.sessionId, { sensitive: false });
    return !!(view && view.ok);
  };
  const canEdit = (grant) => {
    if (!canvasService || typeof canvasService.getCanvas !== "function") return false;
    const view = canvasService.getCanvas({ context: contextForGrant(grant), canvasId: grant.canvasId });
    return !!(view && view.ok && view.canvas && view.canvas.access && view.canvas.access.canEdit);
  };

  const routeDispatcher = canvasService ? createCanvasRouteDispatcher({ canvasService, contextForGrant, appId }) : null;
  const relay = canvasService
    ? relayModule.createCodexCanvasRelay({
      dispatch: routeDispatcher.dispatch,
      clock,
      logger,
      authorizePair: (grant) => sessionActive(grant) && canEdit(grant),
      authorizeToken: (grant) => sessionActive(grant) && canEdit(grant),
      exchange: ({ grant }) => {
        const view = canvasService.getCanvas({ context: contextForGrant(grant), canvasId: grant.canvasId });
        return {
          token: randomBytes(32).toString("base64url"),
          username: grant.user.username || grant.user.id || null,
          canvas: view.ok ? { id: view.canvas.canvasId, title: view.canvas.title, version: view.canvas.revision } : { id: grant.canvasId, title: null, version: null },
          expiresAt: grant.expiresAt,
        };
      },
    })
    : null;

  function pair({ context, canvasId } = {}) {
    if (!identity || typeof identity.validateSession !== "function") return { ok: false, error: "IDENTITY_UNAVAILABLE" };
    const view = identity.validateSession(context && context.sessionRef, { sensitive: false });
    if (!view || !view.ok) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    if (!canvasService) return { ok: false, error: "CANVAS_UNAVAILABLE" };
    try {
      const created = relay.pair({ user: view.user, sessionId: context.sessionRef, canvasId: asStr(canvasId, 120) });
      emit("paired", { canvasId: created.canvasId, username: created.username, expiresAt: created.expiresAt });
      return { ok: true, ...created };
    } catch (error) {
      return { ok: false, error: (error && error.code) || "PAIR_FAILED", message: String((error && error.message) || error) };
    }
  }

  function revoke({ context, canvasId } = {}) {
    if (!identity || typeof identity.validateSession !== "function") return { ok: false, error: "IDENTITY_UNAVAILABLE" };
    const view = identity.validateSession(context && context.sessionRef, { sensitive: false });
    if (!view || !view.ok) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    if (!relay) return { ok: false, error: "CANVAS_UNAVAILABLE" };
    relay.revoke({ userId: view.user.id, canvasId: asStr(canvasId, 120) });
    emit("revoked", { canvasId: asStr(canvasId, 120) });
    return { ok: true };
  }

  async function execute(rawCommand, payload = {}, context = {}) {
    switch (rawCommand) {
      case "codexCanvas/status": {
        const status = installerModule.codexCanvasInstallStatus({ deps });
        return { ok: true, ...status };
      }
      case "codexCanvas/commands":
        return { ok: true, commands: [...COMMANDS], routes: [...relayModule.RELAY_ROUTES] };
      case "codexCanvas/pair":
        return pair({ context, canvasId: payload.canvasId });
      case "codexCanvas/revoke":
        return revoke({ context, canvasId: payload.canvasId });
      case "codexCanvas/relay":
        if (!relay) return { ok: false, error: "CANVAS_UNAVAILABLE" };
        return relay.relay(payload.envelope || payload);
      case "codexCanvas/setup":
        return installerModule.codexCanvasMcpSetup({ port: num(payload.port), deps });
      case "codexCanvas/install": {
        const result = await installerModule.installCodexCanvasMcp({ port: num(payload.port), deps });
        if (result.ok) emit("installed", { bridge: result.bridge });
        return result;
      }
      default:
        return { ok: false, error: "CODEX_CANVAS_COMMAND_NOT_ALLOWED", detail: asStr(rawCommand, 80) };
    }
  }

  return {
    channel: CHANNEL,
    eventChannel: EVENT_CHANNEL,
    commands: [...COMMANDS],
    execute,
    pair,
    revoke,
    relay: relay ? relay.relay : null,
    inspect: relay ? relay.inspect : () => ({ pending: 0, grants: 0, channels: 0 }),
    dispatch: routeDispatcher ? routeDispatcher.dispatch : null,
    onEvent(fn) { emitSink.fn = typeof fn === "function" ? fn : null; return () => { emitSink.fn = null; }; },
  };
}

function registerCodexCanvasIpc({ ipcMain, domain, isTrusted = null, identity = null, send = null, appId = "canvas" } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerCodexCanvasIpc 需要 ipcMain.handle");
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler(CHANNEL); } catch { /* 尚未注册 */ } }
  if (domain && typeof domain.onEvent === "function" && typeof send === "function") {
    domain.onEvent((event) => { try { send(event); } catch { /* 事件推送失败不改变业务结果 */ } });
  }
  ipcMain.handle(CHANNEL, async (event, raw) => {
    // 与 canvas:command 同一条边界：宿主未注入 isTrusted 即拒绝，绝不默认放行。
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!domain || typeof domain.execute !== "function") return { ok: false, error: "CODEX_CANVAS_NOT_READY" };
    if (!raw || typeof raw !== "object") return { ok: false, error: "INVALID_INPUT" };
    const command = typeof raw.command === "string" ? asStr(raw.command, 100) : asStr(raw.type, 100);
    if (!COMMANDS.includes(command)) return { ok: false, error: "CODEX_CANVAS_COMMAND_NOT_ALLOWED", detail: command || null };
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    const context = { sessionRef: identity && typeof identity === "object" ? identity.current || null : null, appId, source: "ui", requestId: asStr(payload.requestId, 80) };
    try { return await domain.execute(command, payload, context); } catch (error) { return { ok: false, error: "INTERNAL_ERROR", detail: String((error && error.message) || error) }; }
  });
  return { channel: CHANNEL, eventChannel: EVENT_CHANNEL, dispose: () => disposeCodexCanvasIpc({ ipcMain }) };
}

function disposeCodexCanvasIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler(CHANNEL); } catch { /* 忽略 */ } }
}

module.exports = {
  CHANNEL,
  EVENT_CHANNEL,
  DOMAIN,
  COMMANDS,
  CLOUD_ROUTES,
  projectSnapshot,
  createCanvasRouteDispatcher,
  createCodexCanvasDomain,
  registerCodexCanvasIpc,
  disposeCodexCanvasIpc,
};
