/**
 * B7b · 本机 / 局域网实时房间（源 server/developerRealtime.ts:1-218）。
 *
 * ## 只做本机 / 局域网，云端房间 OUT
 *   源的 setupDeveloperRealtime 把 ws 挂在 HTTP server 的 /api/developer-realtime upgrade 上；
 *   本移植保留"房间 → peers → 序号 → 广播"的全部本机语义，**不引入任何云端房间 / 中继**，
 *   传输层是**必须显式注入**的对象（本机 IPC / 渲染层事件 / 局域网 ws 适配器）：
 *     · 未注入 transport：hub.transportStatus() / connect() 一律结构化
 *       DEVELOPER_REALTIME_TRANSPORT_UNAVAILABLE —— **绝不假连接**；
 *     · createLanRealtimeServer 惰性 require("ws")（不写 package.json），
 *       缺 ws 或缺显式 authorize 都在构造期结构化拒绝，不先起服务再补鉴权。
 *
 * ## 比源多出来的三件（B7b 任务书要求）
 *   1. 序号：每次成功变更（join / leave / send / setState / owner 转移）都推进 room.seq，
 *      事件与广播都带 seq；
 *   2. 冲突：setState 必须带 baseSeq，落后即返回 SEQ_CONFLICT（带 currentSeq），不改权威状态；
 *   3. 断线重连：leave 后保留短期 detached 记录与事件日志，reconnect 可拿回 lastSeq 之后的事件；
 *      同一 clientId 换用户重连一律拒绝（与源 :177-178 同口径）。
 *
 * OUT：云端房间 / api.dx-os.com / appUpdates 远端更新 —— 本文件零网络（除注入的本机传输）。
 */
"use strict";

const CHANNEL = "developer:command";
const EVENT_CHANNEL = "developer:event";

// 源 :30-32 的常量
const MAX_MESSAGE_BYTES = 64 * 1024;
const IDLE_ROOM_TTL_MS = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15 * 1000;
const MAX_ROOMS = 128;
const MAX_PEERS_PER_ROOM = 32;
const MAX_RATE_PER_SECOND = 30;
const MAX_EVENT_LOG = 500;

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });
const asStr = (value, max = 200) => (value == null ? "" : String(value).slice(0, max));

/** 与 canvas-dxos-collab.cjs:50-63 同一套 fail-closed 判定（未注入 → 拒绝，不默认放行）。 */
function evaluateAuthorization(authorize, request) {
  if (typeof authorize !== "function") return { allowed: false, error: "FORBIDDEN", detail: "authorize-not-configured" };
  let result;
  try { result = authorize(request); }
  catch { return { allowed: false, error: "FORBIDDEN", detail: "authorize-error" }; }
  if (result && typeof result === "object" && result.ok === false) {
    return { allowed: false, error: result.error || "FORBIDDEN", detail: result.detail === undefined ? "authorize-denied" : result.detail };
  }
  if (result === true || (result && typeof result === "object" && result.ok === true)) return { allowed: true, error: null, detail: null };
  return { allowed: false, error: "FORBIDDEN", detail: "authorize-denied" };
}

class DeveloperRealtimeHub {
  constructor({ authorize = null, transport = null, onEvent = null, clock = () => Date.now(), maxRooms = MAX_ROOMS, maxPeersPerRoom = MAX_PEERS_PER_ROOM, idleRoomTtlMs = IDLE_ROOM_TTL_MS } = {}) {
    this.authorize = typeof authorize === "function" ? authorize : null;
    this.transport = transport && typeof transport.send === "function" ? transport : null;
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.maxRooms = Math.max(1, Number(maxRooms) || MAX_ROOMS);
    this.maxPeersPerRoom = Math.max(1, Number(maxPeersPerRoom) || MAX_PEERS_PER_ROOM);
    this.idleRoomTtlMs = Math.max(0, Number(idleRoomTtlMs) || 0);
    /** @type {Map<string, object>} roomId → room */
    this.rooms = new Map();
    /** @type {Map<string, object[]>} "roomId\u0000clientId" → 未取走的广播 */
    this.deliveries = new Map();
  }

  // ---- 传输 ----
  transportStatus() {
    if (!this.transport) return fail("DEVELOPER_REALTIME_TRANSPORT_UNAVAILABLE", "transport-not-configured");
    return ok({ configured: true, kind: asStr(this.transport.kind, 40) || "injected" });
  }

  /** 注入传输（未注入时结构化拒绝，不制造假连接）。 */
  connect({ transport = null } = {}) {
    if (!transport || typeof transport.send !== "function") return fail("DEVELOPER_REALTIME_TRANSPORT_UNAVAILABLE", "transport-not-configured");
    this.transport = transport;
    return ok({ connected: true, kind: asStr(transport.kind, 40) || "injected" });
  }

  setEventSink(handler) { this.onEvent = typeof handler === "function" ? handler : null; return ok({ wired: Boolean(this.onEvent) }); }

  // ---- 房间 ----
  #room(roomId) { return this.rooms.get(String(roomId || "")) || null; }

  publicRoom(room) {
    return {
      id: room.id, appId: room.appId, name: room.name, ownerId: room.ownerId, discoverable: room.discoverable,
      maxMembers: room.maxMembers, members: room.peers.size, seq: room.seq, createdAt: room.createdAt, updatedAt: room.updatedAt,
    };
  }

  members(roomId) {
    const room = this.#room(roomId);
    if (!room) return [];
    return [...room.peers.values()].map((peer) => ({ clientId: peer.clientId, userId: peer.userId, username: peer.username }));
  }

  // 源 :78-89 createDeveloperRealtimeRoom
  createRoom({ appId, ownerId, name, discoverable, maxMembers, state, allowedUserIds } = {}) {
    const app = asStr(appId, 120); const owner = asStr(ownerId, 120);
    if (!app || !owner) return fail("INVALID_INPUT");
    if (this.rooms.size >= this.maxRooms) return fail("LIMIT_EXCEEDED", "rooms");
    const bytes = Buffer.byteLength(JSON.stringify(state === undefined ? null : state), "utf8");
    if (bytes > MAX_MESSAGE_BYTES) return fail("LIMIT_EXCEEDED", "state-too-large");
    const now = Number(this.clock());
    const room = {
      id: require("node:crypto").randomUUID(), appId: app, ownerId: owner,
      name: asStr(name, 60).trim() || "协作房间",
      discoverable: discoverable === true,
      maxMembers: Math.max(2, Math.min(32, Math.round(Number(maxMembers) || 8))),
      state: state === undefined ? null : state,
      allowedUserIds: Array.isArray(allowedUserIds) && allowedUserIds.length ? new Set([owner, ...allowedUserIds.map(String)]) : null,
      createdAt: now, updatedAt: now, seq: 0, eventLog: [], peers: new Map(), detached: new Map(),
    };
    this.rooms.set(room.id, room);
    return ok({ room: this.publicRoom(room) });
  }

  // 源 :136-138 listDeveloperRealtimeRooms
  listRooms({ appId, userId } = {}) {
    const app = asStr(appId, 120); const user = asStr(userId, 120);
    return [...this.rooms.values()]
      .filter((room) => room.appId === app && (room.discoverable || room.ownerId === user || [...room.peers.values()].some((peer) => peer.userId === user)))
      .map((room) => this.publicRoom(room));
  }

  // 源 :140-144 developerRealtimeRoom
  room({ appId, roomId } = {}) {
    const room = this.#room(roomId);
    if (!room || room.appId !== asStr(appId, 120)) return fail("NOT_FOUND");
    return ok({ room: { ...this.publicRoom(room), state: room.state, memberList: this.members(room.id) } });
  }

  // 源 :34-38 developerRealtimeStats
  stats() {
    let peers = 0; let detached = 0;
    for (const room of this.rooms.values()) { peers += room.peers.size; detached += room.detached.size; }
    return { rooms: this.rooms.size, peers, detached };
  }

  // ---- 广播 / 事件队列 ----
  #push(roomId, clientId, payload) {
    if (clientId) {
      const key = String(roomId) + "\u0000" + String(clientId);
      const queue = this.deliveries.get(key) || [];
      queue.push(payload);
      if (queue.length > MAX_EVENT_LOG) queue.splice(0, queue.length - MAX_EVENT_LOG);
      this.deliveries.set(key, queue);
    }
    if (this.onEvent) { try { this.onEvent({ roomId: String(roomId), clientId: clientId || null, ...payload }); } catch { /* 事件订阅失败不影响房间状态 */ } }
    if (this.transport && clientId) { try { this.transport.send({ roomId: String(roomId), clientId: String(clientId), payload }); } catch { /* 传输失败不影响房间状态 */ } }
  }

  #emit(room, payload, { except = null, targets = null } = {}) {
    const recipients = Array.isArray(targets) ? targets : [...room.peers.keys()].filter((clientId) => clientId !== except);
    for (const clientId of recipients) this.#push(room.id, clientId, payload);
    return recipients;
  }

  #log(room, event) {
    room.eventLog.push(event);
    if (room.eventLog.length > MAX_EVENT_LOG) room.eventLog.splice(0, room.eventLog.length - MAX_EVENT_LOG);
  }

  drain(roomId, clientId) {
    const key = String(roomId || "") + "\u0000" + String(clientId || "");
    const queue = this.deliveries.get(key) || [];
    this.deliveries.set(key, []);
    return queue;
  }

  // ---- 准入 ----
  #authorizePeer(request) { return evaluateAuthorization(this.authorize, request); }

  #admit(room, userId, clientId) {
    if (room.allowedUserIds && !room.allowedUserIds.has(userId)) return fail("FORBIDDEN", "room-access-denied");
    const existing = room.peers.get(clientId);
    if (existing && existing.userId !== userId) return fail("FORBIDDEN", "client-id-taken");
    if (!existing && room.peers.size >= room.maxMembers) return fail("LIMIT_EXCEEDED", "peers");
    if (room.maxMembers && room.peers.size >= room.maxMembers && !existing) return fail("LIMIT_EXCEEDED", "peers");
    return null;
  }

  // 源 :177-184 join：鉴权 → 容量 → joined + members 广播
  join({ appId, roomId, clientId, userId, username = "" } = {}) {
    const room = this.#room(roomId);
    const client = asStr(clientId, 120); const user = asStr(userId, 120);
    if (!room || room.appId !== asStr(appId, 120)) return fail("NOT_FOUND");
    if (!client || !user) return fail("INVALID_INPUT");
    const auth = this.#authorizePeer({ roomId: room.id, appId: room.appId, clientId: client, userId: user, action: "join" });
    if (!auth.allowed) return fail(auth.error, auth.detail);
    const denied = this.#admit(room, user, client);
    if (denied) return denied;
    room.detached.delete(client);
    const now = Number(this.clock());
    const peer = { clientId: client, userId: user, username: asStr(username, 80), joinedAt: now, lastSeenAt: now, lastSeq: room.seq, rate: [] };
    room.peers.set(client, peer);
    room.seq += 1;
    const joined = { type: "joined", roomId: room.id, seq: room.seq, room: this.publicRoom(room), state: room.state, members: this.members(room.id) };
    this.#log(room, joined);
    this.#emit(room, joined, { targets: [client] });
    const membersEvent = { type: "members", roomId: room.id, seq: room.seq, ownerId: room.ownerId, members: this.members(room.id) };
    this.#log(room, membersEvent);
    this.#emit(room, membersEvent);
    return ok({ peer: { clientId: peer.clientId, userId: peer.userId, username: peer.username }, seq: room.seq, room: this.publicRoom(room) });
  }

  /**
   * 断线重连：同一 clientId + 同一用户才能续上；返回 lastSeq 之后的事件（源 :177-178 的等价，
   * 但补上"事件日志回放"这一源没有的语义）。
   */
  reconnect({ appId, roomId, clientId, userId, lastSeq = 0, username = "" } = {}) {
    const room = this.#room(roomId);
    const client = asStr(clientId, 120); const user = asStr(userId, 120);
    if (!room || room.appId !== asStr(appId, 120)) return fail("NOT_FOUND");
    if (!client || !user) return fail("INVALID_INPUT");
    const auth = this.#authorizePeer({ roomId: room.id, appId: room.appId, clientId: client, userId: user, action: "reconnect" });
    if (!auth.allowed) return fail(auth.error, auth.detail);
    const detached = room.detached.get(client);
    const existing = room.peers.get(client);
    if (existing && existing.userId !== user) return fail("FORBIDDEN", "client-id-taken");
    if (!existing && !detached) return fail("NOT_FOUND", "no-session-to-resume");
    if (!existing && detached && detached.userId !== user) return fail("FORBIDDEN", "client-id-taken");
    const denied = this.#admit(room, user, client);
    if (denied && !existing) return denied;
    const now = Number(this.clock());
    const peer = existing || { clientId: client, userId: user, username: asStr(username, 80) || (detached ? detached.username : ""), joinedAt: now, lastSeenAt: now, lastSeq: 0, rate: [] };
    peer.lastSeenAt = now;
    peer.lastSeq = room.seq;
    room.peers.set(client, peer);
    room.detached.delete(client);
    const from = Number.isFinite(Number(lastSeq)) ? Number(lastSeq) : 0;
    const missed = room.eventLog.filter((event) => Number(event.seq) > from);
    const resumed = { type: "resumed", roomId: room.id, seq: room.seq, members: this.members(room.id), missed };
    this.#emit(room, resumed, { targets: [client] });
    return ok({ resumed: true, seq: room.seq, missed, members: this.members(room.id) });
  }

  // 源 :209-215 leave：移除会话、转移房主、广播 members；这里保留 detached 供重连。
  leave({ roomId, clientId } = {}) {
    const room = this.#room(roomId);
    const client = asStr(clientId, 120);
    if (!room || !client) return ok({ removed: false });
    const peer = room.peers.get(client);
    if (!peer) return ok({ removed: false, seq: room.seq });
    room.peers.delete(client);
    const now = Number(this.clock());
    room.detached.set(client, { userId: peer.userId, username: peer.username, lastSeenAt: now, lastSeq: room.seq });
    room.seq += 1;
    let ownerChanged = false;
    if (room.ownerId === peer.userId && ![...room.peers.values()].some((item) => item.userId === peer.userId)) {
      const successor = room.peers.values().next().value;
      if (successor) {
        room.ownerId = successor.userId;
        ownerChanged = true;
        this.#emit(room, { type: "owner", roomId: room.id, seq: room.seq, ownerId: room.ownerId, clientId: successor.clientId });
      }
    }
    const membersEvent = { type: "members", roomId: room.id, seq: room.seq, ownerId: room.ownerId, members: this.members(room.id) };
    this.#log(room, membersEvent);
    this.#emit(room, membersEvent);
    return ok({ removed: true, seq: room.seq, ownerChanged, members: this.members(room.id), detached: true });
  }

  // 源 :187-208 message 路由：send 只发给别人；setState 只有房主可写。
  send({ roomId, clientId, data } = {}) {
    const room = this.#room(roomId);
    const client = asStr(clientId, 120);
    const peer = room && room.peers.get(client);
    if (!peer) return fail("NOT_FOUND");
    const size = Buffer.byteLength(JSON.stringify(data === undefined ? null : data), "utf8");
    if (size > MAX_MESSAGE_BYTES) return fail("LIMIT_EXCEEDED", "message-too-large");
    const now = Number(this.clock());
    peer.rate = peer.rate.filter((stamp) => stamp > now - 1000);
    if (peer.rate.length >= MAX_RATE_PER_SECOND) return fail("RATE_LIMITED", "message-rate");
    peer.rate.push(now);
    peer.lastSeenAt = now;
    room.seq += 1;
    const event = { type: "message", roomId: room.id, seq: room.seq, clientId: peer.clientId, userId: peer.userId, username: peer.username, data: data === undefined ? null : data, to: [...room.peers.keys()].filter((id) => id !== peer.clientId) };
    this.#log(room, event);
    const recipients = this.#emit(room, event, { except: peer.clientId });
    return ok({ seq: room.seq, recipients });
  }

  // 序号冲突：baseSeq 与当前不一致即拒绝，不写权威状态。
  setState({ roomId, clientId, baseSeq, state } = {}) {
    const room = this.#room(roomId);
    const client = asStr(clientId, 120);
    const peer = room && room.peers.get(client);
    if (!peer) return fail("NOT_FOUND");
    if (room.ownerId !== peer.userId) return fail("FORBIDDEN", "owner-only");
    const size = Buffer.byteLength(JSON.stringify(state === undefined ? null : state), "utf8");
    if (size > MAX_MESSAGE_BYTES) return fail("LIMIT_EXCEEDED", "state-too-large");
    const base = Number(baseSeq);
    if (!Number.isFinite(base) || base !== room.seq) {
      return fail("SEQ_CONFLICT", { baseSeq: Number.isFinite(base) ? base : null, currentSeq: room.seq, currentState: room.state });
    }
    room.seq += 1;
    room.state = state === undefined ? null : state;
    room.updatedAt = Number(this.clock());
    const event = { type: "state", roomId: room.id, seq: room.seq, state: room.state, source: "server", clientId: peer.clientId };
    this.#log(room, event);
    this.#emit(room, event);
    return ok({ seq: room.seq, state: room.state });
  }

  // 源 :127-134 closeDeveloperRealtimeRoomSystem / :146-154 closeDeveloperRealtimeRoom
  closeRoom({ appId, roomId, userId = null } = {}) {
    const room = this.#room(roomId);
    if (!room || room.appId !== asStr(appId, 120)) return fail("NOT_FOUND");
    if (userId !== null && room.ownerId !== asStr(userId, 120)) return fail("FORBIDDEN", "owner-only");
    room.seq += 1;
    this.#emit(room, { type: "closed", roomId: room.id, seq: room.seq });
    if (this.transport && typeof this.transport.close === "function") {
      for (const clientId of [...room.peers.keys()]) { try { this.transport.close({ roomId: room.id, clientId, code: 1000, reason: "room closed" }); } catch { /* 传输失败不影响关房 */ } }
    }
    this.rooms.delete(room.id);
    for (const key of [...this.deliveries.keys()]) if (key.startsWith(room.id + "\u0000")) this.deliveries.delete(key);
    return ok({ closed: true, roomId: room.id });
  }

  // 源 :68-76 cleanupDeveloperRealtimeRooms：清空闲房间 + 过期 detached 记录
  cleanup(now = Number(this.clock())) {
    let rooms = 0; const detached = [];
    for (const [roomId, room] of [...this.rooms.entries()]) {
      for (const [clientId, record] of [...room.detached.entries()]) {
        if (this.idleRoomTtlMs && now - Number(record.lastSeenAt) > this.idleRoomTtlMs) { room.detached.delete(clientId); detached.push({ roomId, clientId }); }
      }
      if (!room.peers.size && !room.detached.size && this.idleRoomTtlMs && now - Number(room.updatedAt) > this.idleRoomTtlMs) { this.rooms.delete(roomId); rooms += 1; }
    }
    return ok({ rooms, detached });
  }
}

// ---------------------------------------------------------------------------
// 局域网传输（惰性 require("ws") 或注入；云端房间 OUT）
// ---------------------------------------------------------------------------

/**
 * 源 :156-218 setupDeveloperRealtime 的本机 / LAN 投影。
 * 返回 { ok:true, server, wss, close } 或结构化 { ok:false } —— 构造期就拒绝非法配置。
 * wsFactory 可注入（测试用假实现），不注入时惰性 require("ws")。
 */
function createLanRealtimeServer({ hub, authorize = null, httpServer = null, path: realtimePath = "/api/developer-realtime", host = "127.0.0.1", port = 0, wsFactory = null } = {}) {
  if (!hub || typeof hub.join !== "function") return fail("DEVELOPER_REALTIME_UNAVAILABLE", "hub-required");
  if (typeof authorize !== "function") return fail("FORBIDDEN", "authorize-not-configured");
  let ws;
  try { ws = wsFactory || require("ws"); }
  catch { return fail("DEVELOPER_REALTIME_TRANSPORT_UNAVAILABLE", "ws-not-installed"); }
  if (!ws || typeof ws.WebSocketServer !== "function") return fail("DEVELOPER_REALTIME_TRANSPORT_UNAVAILABLE", "ws-not-installed");
  const sockets = new Map();
  const key = (roomId, clientId) => String(roomId) + "\u0000" + String(clientId);
  const wss = new ws.WebSocketServer({ noServer: true });
  const server = httpServer || require("node:http").createServer((_req, res) => { res.statusCode = 404; res.end(); });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== realtimePath) return;
    const appId = url.searchParams.get("appId") || "";
    const roomId = url.searchParams.get("roomId") || "";
    const clientId = url.searchParams.get("clientId") || "";
    const userId = url.searchParams.get("userId") || "";
    const verdict = evaluateAuthorization(authorize, { appId, roomId, clientId, userId, action: "lan-upgrade" });
    if (!verdict.allowed) return socket.destroy();
    wss.handleUpgrade(request, socket, head, (wsPeer) => {
      // 先登记 socket 再进房：hub.join 会经传输把 joined 回发给这个 clientId，
      // 否则回包会因为没有目标 socket 而丢失。
      sockets.set(key(roomId, clientId), wsPeer);
      const joined = hub.join({ appId, roomId, clientId, userId });
      if (!joined.ok) { sockets.delete(key(roomId, clientId)); return wsPeer.close(); }
      wsPeer.on("message", (raw) => {
        let message;
        try { message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)); } catch { return; }
        if (!message || typeof message !== "object") return;
        if (message.type === "setState") hub.setState({ roomId, clientId, baseSeq: message.baseSeq, state: message.state });
        else hub.send({ roomId, clientId, data: message.data === undefined ? message : message.data });
      });
      wsPeer.on("close", () => { sockets.delete(key(roomId, clientId)); hub.leave({ roomId, clientId }); });
    });
  });
  hub.connect({ transport: {
    kind: "lan",
    send({ roomId, clientId, payload }) {
      const wsPeer = sockets.get(key(roomId, clientId));
      if (wsPeer && wsPeer.readyState === (ws.WebSocket ? ws.WebSocket.OPEN : 1)) wsPeer.send(JSON.stringify(payload));
    },
    close({ roomId, clientId }) {
      const wsPeer = sockets.get(key(roomId, clientId));
      if (wsPeer) wsPeer.close();
    },
  } });
  if (!httpServer) server.listen(port, host);
  return {
    ok: true, server, wss,
    close() {
      try { hub.transport = null; } catch { /* ignore */ }
      try { wss.close(); } catch { /* ignore */ }
      if (!httpServer) { try { server.close(); } catch { /* ignore */ } }
    },
  };
}

// ===========================================================================
// 命令面切片（并入 developer:command）
// ===========================================================================

const DEVELOPER_REALTIME_COMMANDS = Object.freeze([
  { command: "developer/realtime/create", risk: "write", credential: "none", summary: "创建本机 / 局域网实时房间" },
  { command: "developer/realtime/list", risk: "read", credential: "none", summary: "列举当前用户可见的实时房间" },
  { command: "developer/realtime/get", risk: "read", credential: "none", summary: "读取房间公开信息、权威状态与成员" },
  { command: "developer/realtime/join", risk: "write", credential: "none", summary: "加入房间（鉴权失败 / 满员 / 越权一律结构化拒绝）" },
  { command: "developer/realtime/reconnect", risk: "write", credential: "none", summary: "同一 clientId 断线重连并回放 lastSeq 之后的事件" },
  { command: "developer/realtime/leave", risk: "write", credential: "none", summary: "离开房间并广播成员变更" },
  { command: "developer/realtime/send", risk: "write", credential: "none", summary: "广播消息（带序号，只发给其他成员，限速）" },
  { command: "developer/realtime/setState", risk: "write", credential: "none", summary: "房主按 baseSeq 写入权威状态；序号不符返回 SEQ_CONFLICT" },
  { command: "developer/realtime/members", risk: "read", credential: "none", summary: "读取房间当前成员" },
  { command: "developer/realtime/close", risk: "delete", credential: "none", summary: "关闭房间（仅房主）" },
  { command: "developer/realtime/stats", risk: "read", credential: "none", summary: "本进程实时房间统计" },
  { command: "developer/realtime/cleanup", risk: "write", credential: "none", summary: "清理空闲房间与过期重连记录" },
  { command: "developer/realtime/events", risk: "read", credential: "none", summary: "取走本会话未消费的下行事件（developer:event 数据源）" },
  { command: "developer/realtime/transportStatus", risk: "read", credential: "none", summary: "报告传输是否已注入（未注入即结构化不可用）" },
  { command: "developer/realtime/lanServer", risk: "write", credential: "none", summary: "启动局域网实时入口（缺显式 authorize / 缺 ws 一律结构化拒绝）" },
]);

const DEVELOPER_REALTIME_REGISTRY = new Map(DEVELOPER_REALTIME_COMMANDS.map((entry) => [entry.command, entry]));

function createDeveloperRealtimeExtension({ hub = null } = {}) {
  const requireHub = () => (hub && typeof hub.join === "function" ? null : fail("DEVELOPER_REALTIME_UNAVAILABLE", "hub-not-configured"));
  const handlers = {
    "developer/realtime/create": (p) => hub.createRoom(p),
    "developer/realtime/list": (p) => ok({ rooms: hub.listRooms(p) }),
    "developer/realtime/get": (p) => hub.room(p),
    "developer/realtime/join": (p) => hub.join(p),
    "developer/realtime/reconnect": (p) => hub.reconnect(p),
    "developer/realtime/leave": (p) => hub.leave(p),
    "developer/realtime/send": (p) => hub.send(p),
    "developer/realtime/setState": (p) => hub.setState(p),
    "developer/realtime/members": (p) => ok({ members: hub.members(p.roomId) }),
    "developer/realtime/close": (p) => hub.closeRoom(p),
    "developer/realtime/stats": () => ok({ stats: hub.stats() }),
    "developer/realtime/cleanup": (p) => hub.cleanup(p.now),
    "developer/realtime/events": (p) => ok({ events: hub.drain(p.roomId, p.clientId) }),
    "developer/realtime/transportStatus": () => hub.transportStatus(),
    "developer/realtime/lanServer": (p) => {
      const result = createLanRealtimeServer({ hub, authorize: p.authorize, httpServer: p.httpServer || null, path: p.path, host: p.host, port: p.port, wsFactory: p.wsFactory || null });
      if (!result.ok) return result;
      return ok({ lan: true, close: typeof result.close === "function" });
    },
  };
  const dispatch = ({ command, payload } = {}) => {
    const entry = DEVELOPER_REALTIME_REGISTRY.get(String(command || ""));
    if (!entry) return fail("DEVELOPER_COMMAND_NOT_ALLOWED", String(command || ""));
    const missing = requireHub(); if (missing) return missing;
    const handler = handlers[entry.command];
    if (typeof handler !== "function") return fail("NOT_IMPLEMENTED", entry.command);
    try { return handler(payload && typeof payload === "object" ? payload : {}, {}); }
    catch (error) { return fail(String((error && error.message) || error)); }
  };
  return {
    channel: CHANNEL, eventChannel: EVENT_CHANNEL,
    registry: DEVELOPER_REALTIME_COMMANDS.map((e) => ({ ...e })),
    commandNames: DEVELOPER_REALTIME_COMMANDS.map((e) => e.command),
    dispatch, handlers,
    onEvent: (handler) => hub.setEventSink(handler),
  };
}

module.exports = {
  CHANNEL, EVENT_CHANNEL, MAX_MESSAGE_BYTES, IDLE_ROOM_TTL_MS, HEARTBEAT_INTERVAL_MS, MAX_ROOMS, MAX_PEERS_PER_ROOM, MAX_RATE_PER_SECOND,
  evaluateAuthorization, DeveloperRealtimeHub, createLanRealtimeServer,
  DEVELOPER_REALTIME_COMMANDS, DEVELOPER_REALTIME_REGISTRY, createDeveloperRealtimeExtension,
};
