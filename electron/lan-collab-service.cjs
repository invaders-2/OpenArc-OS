"use strict";
/**
 * task-8 A · 局域网协作服务（opt-in；0.0.0.0 + 随机端口；一次性配对码 / 令牌）。
 *
 * 命令（desktop:command 白名单在 local-proxy-domain.cjs）：
 *   desktop/lan/status          只读状态（是否监听 / 端口 / 配对码是否有效 / 客户端数）
 *   desktop/lan/start           显式开启（opt-in）；默认关闭，关闭时零监听
 *   desktop/lan/stop            关闭监听并清空令牌 / 配对码 / 房间
 *   desktop/lan/pairing/create  生成一次性配对码（10 分钟有效，只返回一次）
 *   desktop/lan/pair            用配对码换令牌（令牌只返回一次；绑定发起者与可选 canvasId）
 *
 * 协议：ws://<host>:<port>/api/canvas/collab?token=<token>
 *   未带令牌 / 令牌无效 / 过期 / 与 canvasId 不匹配一律在 upgrade 阶段拒绝（401），不建连接。
 *   连接后只读能力：
 *     canvas.list / canvas.get / resource.list
 *   协作能力：
 *     collab.join / collab.leave / collab.cursor（只读成员，不带编辑权）
 *     collab.patch 明确拒绝（READ_ONLY）；令牌不授予编辑权。
 *
 * 传输层不引入依赖：Node 内置 http 升级 + RFC6455 最小帧实现（text/close/ping/pong，1MiB 上限）。
 * 监听随机端口（listen(0)），绑定 0.0.0.0；所有状态返回不含令牌 / 配对码明文。
 */
const http = require("node:http");
const crypto = require("node:crypto");

const { CanvasCollabHub } = require("./canvas-dxos-collab.cjs");
const localProxyDomain = require("./local-proxy-domain.cjs");

const LAN_COMMANDS = Object.freeze([
  "desktop/lan/status",
  "desktop/lan/start",
  "desktop/lan/stop",
  "desktop/lan/pairing/create",
  "desktop/lan/pair",
]);
const WS_PATH = "/api/canvas/collab";
const PAIRING_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_CLIENTS = 32;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

const asStr = (value, max = 200) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });

function normalizePairingCode(value) {
  return asStr(value, 40).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function makePairingCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let raw = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i += 1) raw += alphabet[bytes[i] % alphabet.length];
  return raw.slice(0, 4) + "-" + raw.slice(4);
}

function wsAccept(key) {
  return crypto.createHash("sha1").update(String(key) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

function createLanCollabService(options = {}) {
  const host = typeof options.host === "string" && options.host ? options.host : "0.0.0.0";
  const wsPath = typeof options.path === "string" && options.path ? options.path : WS_PATH;
  const canvasService = options.canvasService && typeof options.canvasService.getCanvas === "function" ? options.canvasService : null;
  const assetLibrary = options.assetLibrary && typeof options.assetLibrary.getLibrary === "function" ? options.assetLibrary : null;
  const authorization = options.authorization && typeof options.authorization === "object" ? options.authorization : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;
  const pairingTtlMs = Number.isFinite(Number(options.pairingTtlMs)) && Number(options.pairingTtlMs) > 0 ? Number(options.pairingTtlMs) : PAIRING_TTL_MS;
  const tokenTtlMs = Number.isFinite(Number(options.tokenTtlMs)) && Number(options.tokenTtlMs) > 0 ? Number(options.tokenTtlMs) : TOKEN_TTL_MS;

  let server = null;
  let listening = false;
  let port = null;
  let serviceContext = null;
  let serviceActor = null;
  let disabled = false;
  let lastError = null;
  let pairing = null; // { hash, expiresAt, canvasId, userId, organizationId, context, createdAt }
  const tokens = new Map(); // hash → { tokenId, userId, organizationId, canvasId, expiresAt, context, createdAt }
  const connections = new Map(); // clientId → connection
  const sockets = new Set();

  const hub = new CanvasCollabHub({
    authorize: ({ canvasId, clientId }) => {
      const conn = connections.get(String(clientId || ""));
      if (!conn) return { ok: false, error: "FORBIDDEN", detail: "lan-connection-unknown" };
      if (conn.scope.canvasId && conn.scope.canvasId !== String(canvasId)) return { ok: false, error: "FORBIDDEN", detail: "lan-canvas-scope" };
      return { ok: true };
    },
    clock,
    onBroadcast: (delivery) => broadcast(delivery),
  });

  function resolveActor(context) {
    if (!authorization || typeof authorization.resolveActor !== "function") return { ok: false, message: "授权服务未装配" };
    try {
      const result = authorization.resolveActor({ context });
      if (!result || result.ok !== true || !result.user || result.user.id == null) return { ok: false, message: (result && (result.error || result.reason)) || "会话无效" };
      return result;
    } catch (error) {
      return { ok: false, message: String((error && error.message) || error) };
    }
  }

  function cleanupExpired() {
    const now = clock();
    if (pairing && pairing.expiresAt <= now) pairing = null;
    for (const [hash, token] of tokens) if (token.expiresAt <= now) tokens.delete(hash);
  }

  function status() {
    cleanupExpired();
    return {
      command: "desktop/lan/status",
      enabled: !!server && listening,
      listening,
      binding: listening ? host : null,
      port,
      path: wsPath,
      clients: connections.size,
      tokens: tokens.size,
      pairing: pairing ? { active: true, expiresAt: pairing.expiresAt, canvasId: pairing.canvasId, createdAt: pairing.createdAt } : { active: false, expiresAt: null, canvasId: null, createdAt: null },
      optIn: true,
      readOnly: true,
      lastError,
    };
  }

  async function start(payload = {}, context = {}) {
    if (disabled) return fail("FORBIDDEN", "lan-disabled");
    if (server && listening) return ok({ status: status(), alreadyRunning: true });
    const actor = resolveActor(context);
    if (!actor.ok) return fail("FORBIDDEN", actor.message || "会话无效");
    serviceActor = actor;
    serviceContext = { ...context, appId: "canvas", source: "lan" };
    server = http.createServer((request, response) => {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("not found");
    });
    server.on("upgrade", (request, socket, head) => handleUpgrade(request, socket, head));
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, host);
      });
      const address = server.address();
      port = address && typeof address === "object" ? address.port : null;
      listening = true;
      lastError = null;
      return ok({ status: status(), binding: host, port });
    } catch (error) {
      lastError = asStr((error && error.message) || error, 200);
      try { server.close(); } catch { /* ignore */ }
      server = null;
      listening = false;
      return fail("LAN_INTERNAL", lastError);
    }
  }

  async function stop() {
    if (!server) return ok({ status: status(), alreadyStopped: true });
    for (const socket of sockets) { try { socket.destroy(); } catch { /* ignore */ } }
    sockets.clear();
    connections.clear();
    tokens.clear();
    pairing = null;
    hub.close();
    await new Promise((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); }
      setTimeout(resolve, 500).unref?.();
    });
    server = null;
    listening = false;
    port = null;
    serviceContext = null;
    serviceActor = null;
    return ok({ status: status() });
  }

  function pairingCreate(payload = {}, context = {}) {
    if (!listening) return fail("NOT_READY", "lan-not-started");
    cleanupExpired();
    const actor = resolveActor(context);
    if (!actor.ok) return fail("FORBIDDEN", actor.message || "会话无效");
    const canvasId = payload && payload.canvasId != null ? asStr(payload.canvasId, 120).trim() || null : null;
    const code = makePairingCode();
    const createdAt = Number(clock());
    pairing = {
      hash: sha256(normalizePairingCode(code)), expiresAt: createdAt + pairingTtlMs,
      canvasId, userId: String(actor.user.id), organizationId: actor.user.team_id || null,
      context: { ...context, appId: "canvas", source: "lan" }, createdAt,
    };
    return ok({ code, expiresAt: pairing.expiresAt, canvasId, port, path: wsPath, binding: host, readOnly: true });
  }

  function pair(payload = {}) {
    if (!listening) return fail("NOT_READY", "lan-not-started");
    cleanupExpired();
    const normalized = normalizePairingCode(payload && payload.code);
    if (normalized.length !== 8) return fail("INVALID_INPUT", "配对码格式不正确");
    if (!pairing) return fail("NOT_FOUND", "配对码不存在或已失效");
    if (pairing.expiresAt <= clock()) { pairing = null; return fail("NOT_FOUND", "配对码不存在或已失效"); }
    if (pairing.hash !== sha256(normalized)) return fail("FORBIDDEN", "配对码错误");
    const consumed = pairing;
    pairing = null; // 一次性：换到令牌即作废
    const token = crypto.randomBytes(32).toString("base64url");
    const createdAt = Number(clock());
    const tokenId = "lant_" + crypto.randomBytes(8).toString("hex");
    tokens.set(sha256(token), {
      tokenId, userId: consumed.userId, organizationId: consumed.organizationId,
      canvasId: consumed.canvasId, expiresAt: createdAt + tokenTtlMs,
      context: consumed.context, createdAt,
    });
    return ok({
      token, tokenId, expiresAt: createdAt + tokenTtlMs, canvasId: consumed.canvasId,
      ws: { binding: host, port, path: wsPath, localUrl: "ws://127.0.0.1:" + port + wsPath },
      readOnly: true,
    });
  }

  function resolveToken(value) {
    cleanupExpired();
    const token = asStr(value, 500).trim();
    if (!token) return null;
    const entry = tokens.get(sha256(token));
    if (!entry) return null;
    if (entry.expiresAt <= clock()) { tokens.delete(sha256(token)); return null; }
    return entry;
  }

  function send(conn, value) {
    if (!conn || conn.closed || !conn.socket || conn.socket.destroyed) return false;
    try { conn.socket.write(encodeFrame(JSON.stringify(value))); return true; } catch { return false; }
  }

  function broadcast(delivery) {
    if (!delivery || typeof delivery !== "object") return;
    const canvasId = String(delivery.canvasId || "");
    const targets = Array.isArray(delivery.to)
      ? delivery.to.map((clientId) => connections.get(String(clientId))).filter(Boolean)
      : [...connections.values()].filter((conn) => conn.joined.has(canvasId));
    const message = { ...delivery };
    delete message.to;
    for (const conn of targets) send(conn, message);
  }

  function handleUpgrade(request, socket, head) {
    let url;
    try { url = new URL(request.url || "", "http://127.0.0.1"); } catch { socket.destroy(); return; }
    if (url.pathname !== wsPath) { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    const scope = resolveToken(url.searchParams.get("token"));
    if (!scope) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    const upgrade = String(request.headers.upgrade || "").toLowerCase();
    if (!key || upgrade !== "websocket") { socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    if (connections.size >= MAX_CLIENTS) { socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    const responseHeaders = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Accept: " + wsAccept(key),
      "\r\n",
    ];
    socket.write(responseHeaders.join("\r\n"));
    const clientId = "lan:" + crypto.randomBytes(8).toString("hex");
    const conn = { clientId, socket, scope, buffer: Buffer.alloc(0), joined: new Set(), closed: false };
    connections.set(clientId, conn);
    sockets.add(socket);
    if (head && head.length) onData(conn, head);
    socket.on("data", (chunk) => onData(conn, chunk));
    socket.on("close", () => cleanupConnection(conn));
    socket.on("error", () => cleanupConnection(conn));
  }

  function cleanupConnection(conn) {
    if (conn.closed) return;
    conn.closed = true;
    for (const canvasId of [...conn.joined]) {
      try { hub.leave({ canvasId, clientId: conn.clientId }); } catch { /* ignore */ }
    }
    connections.delete(conn.clientId);
    sockets.delete(conn.socket);
    try { conn.socket.destroy(); } catch { /* ignore */ }
  }

  function onData(conn, chunk) {
    if (conn.closed) return;
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    if (conn.buffer.length > MAX_BUFFER_BYTES) { closeWith(conn, 1009, "too-large"); return; }
    for (;;) {
      const frame = readFrame(conn.buffer);
      if (!frame) break;
      conn.buffer = frame.rest;
      if (frame.opcode === 0x8) { closeWith(conn, 1000, "bye"); return; }
      if (frame.opcode === 0x9) { try { conn.socket.write(encodeFrame(frame.payload, 0xA)); } catch { /* ignore */ } continue; }
      if (frame.opcode === 0xA) continue;
      if (frame.opcode !== 0x1) { closeWith(conn, 1003, "unsupported-opcode"); return; }
      if (!frame.fin) { closeWith(conn, 1003, "fragmented"); return; }
      if (!frame.masked) { closeWith(conn, 1002, "unmasked"); return; }
      if (frame.payload.length > MAX_FRAME_BYTES) { closeWith(conn, 1009, "too-large"); return; }
      handleMessage(conn, frame.payload.toString("utf8"));
    }
  }

  function readFrame(buffer) {
    if (buffer.length < 2) return null;
    const first = buffer[0];
    const second = buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME_BYTES)) return { fin, opcode, masked, payload: Buffer.alloc(0), rest: buffer.subarray(buffer.length) };
      length = Number(big);
      offset = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length < offset + maskLength + length) return null;
    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
    if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    return { fin, opcode, masked, payload, rest: buffer.subarray(offset + maskLength + length) };
  }

  function closeWith(conn, code, reason) {
    if (conn.closed) return;
    try {
      const body = Buffer.alloc(2 + Buffer.byteLength(String(reason || ""), "utf8"));
      body.writeUInt16BE(code, 0);
      body.write(String(reason || ""), 2);
      conn.socket.write(encodeFrame(body, 0x8));
    } catch { /* ignore */ }
    cleanupConnection(conn);
  }

  function checkScope(conn) {
    if (!conn.scope || conn.scope.expiresAt <= clock()) { closeWith(conn, 1008, "token-expired"); return false; }
    return true;
  }

  function handleMessage(conn, text) {
    if (!checkScope(conn)) return;
    let message;
    try { message = JSON.parse(text); } catch { send(conn, { type: "error", error: "INVALID_INPUT", detail: "JSON" }); return; }
    if (!message || typeof message !== "object") { send(conn, { type: "error", error: "INVALID_INPUT" }); return; }
    const type = asStr(message.type, 60);
    try {
      switch (type) {
        case "canvas.list": {
          if (!canvasService || typeof canvasService.listCanvases !== "function") { send(conn, { type: "canvas.list.result", ok: false, error: "CANVAS_UNAVAILABLE" }); return; }
          const result = canvasService.listCanvases({ context: serviceContext });
          const views = result && result.ok ? (result.canvases || []).filter((view) => !conn.scope.canvasId || view.canvasId === conn.scope.canvasId) : [];
          send(conn, { type: "canvas.list.result", ok: !!(result && result.ok), canvases: views, readOnly: true, error: result && !result.ok ? result.error : null });
          return;
        }
        case "canvas.get": {
          if (!canvasService) { send(conn, { type: "canvas.get.result", ok: false, error: "CANVAS_UNAVAILABLE" }); return; }
          const canvasId = asStr(message.canvasId, 120).trim();
          if (!canvasId) { send(conn, { type: "canvas.get.result", ok: false, error: "INVALID_INPUT" }); return; }
          if (conn.scope.canvasId && conn.scope.canvasId !== canvasId) { send(conn, { type: "canvas.get.result", ok: false, error: "FORBIDDEN" }); return; }
          const result = canvasService.getCanvas({ context: serviceContext, canvasId });
          send(conn, { type: "canvas.get.result", ok: !!(result && result.ok), canvas: result && result.ok ? result.canvas : null, readOnly: true, error: result && !result.ok ? result.error : null });
          return;
        }
        case "resource.list": {
          if (!canvasService || typeof canvasService.libraryList !== "function") { send(conn, { type: "resource.list.result", ok: false, error: "RESOURCE_UNAVAILABLE" }); return; }
          const limit = Math.max(1, Math.min(60, Number(message.limit) || 30));
          const result = canvasService.libraryList({ context: serviceContext, limit });
          const items = result && result.ok && Array.isArray(result.items) ? result.items.map((item) => ({
            ref: item.ref, resourceId: item.resourceId, name: item.name, mimeType: item.mimeType,
            width: item.width || null, height: item.height || null,
          })) : [];
          send(conn, { type: "resource.list.result", ok: !!(result && result.ok), items, readOnly: true, error: result && !result.ok ? result.error : null });
          return;
        }
        case "collab.join": {
          const canvasId = asStr(message.canvasId, 120).trim();
          if (!canvasId) { send(conn, { type: "collab.join.result", ok: false, error: "INVALID_INPUT" }); return; }
          if (conn.scope.canvasId && conn.scope.canvasId !== canvasId) { send(conn, { type: "collab.join.result", ok: false, error: "FORBIDDEN" }); return; }
          const result = hub.join({ canvasId, clientId: conn.clientId, userId: conn.scope.userId, username: asStr(message.username, 80), canEdit: false });
          if (result.ok) conn.joined.add(canvasId);
          send(conn, { type: "collab.join.result", ok: result.ok, error: result.ok ? null : result.error, detail: result.ok ? null : result.detail, presence: result.ok ? result.presence : null, readOnly: true });
          return;
        }
        case "collab.leave": {
          const canvasId = asStr(message.canvasId, 120).trim();
          conn.joined.delete(canvasId);
          const result = hub.leave({ canvasId, clientId: conn.clientId });
          send(conn, { type: "collab.leave.result", ok: true, presence: result.presence, removed: result.removed });
          return;
        }
        case "collab.cursor": {
          const canvasId = asStr(message.canvasId, 120).trim();
          if (!conn.joined.has(canvasId)) { send(conn, { type: "error", error: "NOT_FOUND", detail: "not-joined" }); return; }
          const result = hub.cursor({ canvasId, clientId: conn.clientId, x: message.x, y: message.y, nodeId: asStr(message.nodeId, 120) || null });
          if (!result.ok) send(conn, { type: "error", error: result.error, detail: result.detail });
          return;
        }
        case "collab.patch": {
          send(conn, { type: "error", error: "READ_ONLY", detail: "lan tokens do not grant edit permission" });
          return;
        }
        case "ping": {
          send(conn, { type: "pong", at: Number(clock()) });
          return;
        }
        default: send(conn, { type: "error", error: "UNSUPPORTED", detail: type });
      }
    } catch (error) {
      send(conn, { type: "error", error: "INTERNAL", detail: asStr((error && error.message) || error, 200) });
    }
  }

  async function execute(command, payload = {}, context = {}) {
    try {
      if (!LAN_COMMANDS.includes(command)) return localProxyDomain.normalizeLocalProxyError(localProxyDomain.localProxyCommandNotAllowed(command));
      let result;
      switch (command) {
        case "desktop/lan/status": result = status(); break;
        case "desktop/lan/start": result = await start(payload, context); break;
        case "desktop/lan/stop": result = await stop(); break;
        case "desktop/lan/pairing/create": result = pairingCreate(payload, context); break;
        case "desktop/lan/pair": result = pair(payload); break;
        default: return localProxyDomain.normalizeLocalProxyError(localProxyDomain.localProxyCommandNotAllowed(command));
      }
      if (result && result.ok === false) return { ok: false, error: result.error, detail: result.detail };
      if (!result || result.ok !== true) return { ok: true, value: status() };
      const { ok: _ignored, ...value } = result;
      return { ok: true, value };
    } catch (error) {
      if (logger) { try { logger("[OpenArc lan] " + asStr((error && error.message) || error, 200)); } catch { /* ignore */ } }
      return localProxyDomain.normalizeLocalProxyError(error);
    }
  }

  return {
    execute, start, stop, status, pairingCreate, pair, resolveToken,
    commands: LAN_COMMANDS.slice(),
    path: wsPath,
    getServer: () => server,
    dispose: () => stop(),
  };
}

module.exports = { createLanCollabService, LAN_COMMANDS, WS_PATH, PAIRING_TTL_MS, TOKEN_TTL_MS, normalizePairingCode, makePairingCode };
