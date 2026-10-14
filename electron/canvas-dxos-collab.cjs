/**
 * B5c · 画布协作（源 server/canvasCollab.ts，81 行；本机 / 局域网部分）。
 *
 * 源是"一个进程内 rooms: Map<canvasId, Set<Peer>> + WebSocketServer"：
 *   · join 鉴权（getAuth + getCanvasVersion） ← 源 :45-49
 *   · 进房即广播 presence ← 源 :53-55
 *   · message 只认 cursor，坐标必须有限数 ← 源 :56-73
 *   · 离开广播 presence，空房删除 ← 源 :74-78
 *   · patch 广播带上 sourceClientId，且不回给发起人 ← 源 :36-38
 * 这里把"房间 / 会话语义"落成本地内存 hub（与源同构，无表），传输层由调用方注入：
 *   · 本机：直接调用 hub 方法（Electron IPC / 渲染层事件）；
 *   · 局域网：createLanCollabServer 惰性 require("ws") 挂 upgrade（与源同形）。
 *
 * **OUT（一律不引入，逐条注明）**：
 *   · 源 server/canvasCloudSync.ts 与 dx-canvas-cloud 协议（云端同步、远端 diff/apply）——不 import、不转发；
 *   · 源 index.ts:2969-3009 的 /api/canvas/cloud*、canvasCloudSync 路由——不存在于本模块；
 *   · dxosProtocol 云 AI / apiQuota / cloudEntitlement / publicMedia / api.dx-os.com ——本模块零引用。
 *
 * 冲突：源把冲突交给 shared/canvasCollaboration.ts 的 card patch 三方合并（源 :36-38 只做转发）。
 * 本文件把该语义落到 OpenArc 节点上（diff/apply/reconcile），并让 hub 在 baseRevision 落后时
 * 明确返回 REVISION_CONFLICT（不静默广播过期补丁）。
 */
"use strict";

const UNSAFE_PATH_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const LIMITS = Object.freeze({ MAX_PEERS_PER_ROOM: 32, MAX_ROOMS: 128, MAX_PATCH_OPERATIONS: 500, MAX_PATH_DEPTH: 12, MAX_CURSOR_PER_SECOND: 60 });

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });

// ---------------------------------------------------------------------------
// 节点补丁三方合并（源 shared/canvasCollaboration.ts:77-167 的等价实现）
// ---------------------------------------------------------------------------

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const safePath = (pathValue) => Array.isArray(pathValue) && pathValue.length > 0 && pathValue.length <= LIMITS.MAX_PATH_DEPTH
  && pathValue.every((key) => typeof key === "string" && key.length > 0 && key.length <= 160 && !UNSAFE_PATH_KEYS.has(key));

function sameValue(left, right) {
  if (left === right) return true;
  if (typeof left === "string" && typeof right === "string") return false;
  if (typeof left === "number" && typeof right === "number") return !Number.isFinite(left) && !Number.isFinite(right);
  if (left && right && typeof left === "object" && typeof right === "object") {
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) return false;
      for (let i = 0; i < left.length; i += 1) if (!sameValue(left[i] === undefined ? null : left[i], right[i] === undefined ? null : right[i])) return false;
      return true;
    }
    const a = Object.keys(left).filter((k) => left[k] !== undefined);
    const b = Object.keys(right).filter((k) => right[k] !== undefined);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i] || !sameValue(left[a[i]], right[a[i]])) return false;
    return true;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function valueAt(root, pathValue) {
  let value = root;
  for (const key of pathValue) {
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
function hasAt(root, pathValue) {
  let value = root;
  for (const key of pathValue) {
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, key)) return false;
    value = value[key];
  }
  return true;
}

/** 源 :77-96：两个节点版本的差异（id 永不进 path）。 */
function diffCanvasNode(base, current) {
  const set = [];
  const unset = [];
  const visit = (before, after, pathValue) => {
    if (sameValue(before, after)) return;
    if (isRecord(before) && isRecord(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!pathValue.length && key === "id") continue;
        if (!Object.prototype.hasOwnProperty.call(after, key)) unset.push([...pathValue, key]);
        else if (!Object.prototype.hasOwnProperty.call(before, key)) set.push({ path: [...pathValue, key], value: clone(after[key]) });
        else visit(before[key], after[key], [...pathValue, key]);
      }
      return;
    }
    set.push({ path: pathValue, value: clone(after) });
  };
  visit(base, current, []);
  return set.length || unset.length ? { id: String(current.id || base.id || ""), set, unset } : null;
}

/** 源 :98-123：把补丁应用到节点（拒绝 id 与不安全路径）。 */
function applyCanvasNodePatch(source, patch) {
  const result = clone(source);
  const parentAt = (pathValue, create) => {
    let parent = result;
    for (const key of pathValue.slice(0, -1)) {
      if (!isRecord(parent[key])) {
        if (!create) return null;
        parent[key] = {};
      }
      parent = parent[key];
    }
    return parent;
  };
  for (const operation of (patch.set || []).slice(0, LIMITS.MAX_PATCH_OPERATIONS)) {
    if (!safePath(operation.path) || operation.path[0] === "id") continue;
    const parent = parentAt(operation.path, true);
    if (parent) parent[operation.path[operation.path.length - 1]] = clone(operation.value);
  }
  for (const pathValue of (patch.unset || []).slice(0, LIMITS.MAX_PATCH_OPERATIONS)) {
    if (!safePath(pathValue) || pathValue[0] === "id") continue;
    const parent = parentAt(pathValue, false);
    if (parent) delete parent[pathValue[pathValue.length - 1]];
  }
  result.id = source.id;
  return result;
}

/** 源 :125-138：只应用"本地相对 base 没动过"的那部分补丁 —— 本地改动不被远端覆盖。 */
function applyCanvasNodePatchPreservingLocal(local, base, patch) {
  const filtered = {
    id: patch.id,
    set: (patch.set || []).filter((operation) => sameValue(valueAt(local, operation.path), valueAt(base, operation.path))
      && hasAt(local, operation.path) === hasAt(base, operation.path)),
    unset: (patch.unset || []).filter((pathValue) => sameValue(valueAt(local, pathValue), valueAt(base, pathValue))
      && hasAt(local, pathValue) === hasAt(base, pathValue)),
  };
  return applyCanvasNodePatch(local, filtered);
}

/** 源 :140-167：保存回包后把"服务端版本 + 本地未提交差异"合成最终节点集合。 */
function reconcileCanvasNodesAfterSave(savedNodes, submittedNodes, liveNodes) {
  const saved = new Map((savedNodes || []).map((node) => [String(node.id), node]));
  const submitted = new Map((submittedNodes || []).map((node) => [String(node.id), node]));
  const live = new Map((liveNodes || []).map((node) => [String(node.id), node]));
  const result = [];
  for (const id of new Set([...saved.keys(), ...submitted.keys(), ...live.keys()])) {
    const serverNode = saved.get(id);
    const sentNode = submitted.get(id);
    const liveNode = live.get(id);
    if (!sentNode) {
      if (liveNode) result.push(clone(liveNode));
      else if (serverNode) result.push(clone(serverNode));
      continue;
    }
    if (!liveNode) continue;
    if (!serverNode) {
      if (!sameValue(liveNode, sentNode)) result.push(clone(liveNode));
      continue;
    }
    const pending = diffCanvasNode(sentNode, liveNode);
    result.push(pending ? applyCanvasNodePatch(serverNode, pending) : clone(serverNode));
  }
  return result;
}

// ---------------------------------------------------------------------------
// 房间 hub（源 :15-38 的本地语义）
// ---------------------------------------------------------------------------

const peerKey = (canvasId, clientId) => String(canvasId) + "\u0000" + String(clientId);

class CanvasCollabHub {
  /**
   * @param authorize ({ canvasId, userId, clientId }) => boolean | {ok:boolean,error?:string}
   *        源 :49 的 getCanvasVersion 鉴权替换为注入；默认放行（由调用方保证）。
   * @param onBroadcast (delivery) => void  可选：把广播交给真实传输（本机 IPC / 局域网 ws）。
   */
  constructor({ authorize = null, onBroadcast = null, clock = null, maxPeersPerRoom = LIMITS.MAX_PEERS_PER_ROOM, idleTimeoutMs = 0 } = {}) {
    this.authorize = typeof authorize === "function" ? authorize : () => true;
    this.onBroadcast = typeof onBroadcast === "function" ? onBroadcast : null;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.maxPeersPerRoom = Math.max(1, Number(maxPeersPerRoom) || LIMITS.MAX_PEERS_PER_ROOM);
    this.idleTimeoutMs = Math.max(0, Number(idleTimeoutMs) || 0);
    /** @type {Map<string, Map<string, object>>} canvasId → (clientId → peer) */
    this.rooms = new Map();
    this.cursorBudget = new Map();
  }

  #room(canvasId, create = false) {
    const key = String(canvasId || "");
    let room = this.rooms.get(key);
    if (!room && create) {
      if (this.rooms.size >= LIMITS.MAX_ROOMS) return null;
      room = new Map();
      this.rooms.set(key, room);
    }
    return room || null;
  }

  #deliver(delivery) {
    if (this.onBroadcast) { try { this.onBroadcast(delivery); } catch { /* 传输失败不影响房间状态 */ } }
    return delivery;
  }

  presence(canvasId) {
    const room = this.#room(canvasId);
    const users = room ? [...room.values()].map((peer) => ({ clientId: peer.clientId, userId: peer.userId, username: peer.username, canEdit: peer.canEdit })) : [];
    return { type: "presence", canvasId: String(canvasId || ""), users };
  }

  /** 源 :50-55：鉴权 → 进房 → 广播 presence。 */
  join({ canvasId, clientId, userId, username = "", canEdit = false } = {}) {
    const key = String(canvasId || "");
    const client = String(clientId || "");
    const user = String(userId || "");
    if (!key || !client || !user) return fail("INVALID_INPUT");
    const auth = this.authorize({ canvasId: key, clientId: client, userId: user });
    if (auth && typeof auth === "object" && auth.ok === false) return fail(auth.error || "FORBIDDEN");
    if (auth === false) return fail("FORBIDDEN");
    const room = this.#room(key, true);
    if (!room) return fail("LIMIT_EXCEEDED", "rooms");
    // 同一 clientId 重连：替换旧会话（源用 Set<Peer> + ws close 清理，这里同步处理重复 clientId）。
    if (!room.has(client) && room.size >= this.maxPeersPerRoom) return fail("LIMIT_EXCEEDED", "peers");
    const peer = { clientId: client, userId: user, username: String(username).slice(0, 80), canEdit: !!canEdit, joinedAt: Number(this.clock()), lastSeenAt: Number(this.clock()) };
    room.set(client, peer);
    this.#deliver(this.presence(key));
    return ok({ peer: { ...peer }, presence: this.presence(key) });
  }

  /** 源 :74-78：离开后广播，空房删除。 */
  leave({ canvasId, clientId } = {}) {
    const key = String(canvasId || "");
    const client = String(clientId || "");
    const room = this.#room(key);
    if (!room) return ok({ presence: this.presence(key), removed: false });
    const removed = room.delete(client);
    if (!room.size) this.rooms.delete(key);
    const presence = this.presence(key);
    if (removed) this.#deliver(presence);
    return ok({ presence, removed });
  }

  heartbeat({ canvasId, clientId } = {}) {
    const peer = this.#room(canvasId) && this.#room(canvasId).get(String(clientId || ""));
    if (!peer) return fail("NOT_FOUND");
    peer.lastSeenAt = Number(this.clock());
    return ok({ peer: { ...peer } });
  }

  /** 清理超时会话（本机没有 ws 的 close 事件时使用）。 */
  sweepIdle(now = Number(this.clock())) {
    if (!this.idleTimeoutMs) return ok({ removed: [] });
    const removed = [];
    for (const [canvasId, room] of [...this.rooms.entries()]) {
      for (const [clientId, peer] of [...room.entries()]) {
        if (now - Number(peer.lastSeenAt) <= this.idleTimeoutMs) continue;
        room.delete(clientId);
        removed.push({ canvasId, clientId });
      }
      if (!room.size) this.rooms.delete(canvasId);
      if (room.size) this.#deliver(this.presence(canvasId));
    }
    return ok({ removed });
  }

  /** 本机 cursor（源 :56-73）：坐标必须有限数；回给除发起人以外的所有人。 */
  cursor({ canvasId, clientId, x, y, nodeId = null } = {}) {
    const key = String(canvasId || "");
    const client = String(clientId || "");
    const room = this.#room(key);
    const peer = room && room.get(client);
    if (!peer) return fail("NOT_FOUND");
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return fail("INVALID_INPUT", "cursor");
    const bucket = Math.floor(Number(this.clock()) / 1000);
    const budgetKey = key + "\u0000" + client + "\u0000" + bucket;
    const used = Number(this.cursorBudget.get(budgetKey) || 0);
    if (used >= LIMITS.MAX_CURSOR_PER_SECOND) return fail("LIMIT_EXCEEDED", "cursor-rate");
    this.cursorBudget.set(budgetKey, used + 1);
    peer.lastSeenAt = Number(this.clock());
    return ok({
      message: this.#deliver({
        type: "cursor", canvasId: key, clientId: client, userId: peer.userId, username: peer.username,
        x: nx, y: ny, ...(typeof nodeId === "string" && nodeId ? { cardId: nodeId, nodeId } : {}),
        to: [...room.keys()].filter((id) => id !== client),
      }),
    });
  }

  /**
   * patch 广播（源 :36-38）：只回给其他人；baseRevision 落后即冲突，不广播过期补丁。
   * 冲突的三方合并由调用方用 applyCanvasNodePatchPreservingLocal / reconcileCanvasNodesAfterSave。
   */
  submitPatch({ canvasId, clientId, baseRevision, currentRevision, payload = {} } = {}) {
    const key = String(canvasId || "");
    const client = String(clientId || "");
    const room = this.#room(key);
    const peer = room && room.get(client);
    if (!peer) return fail("NOT_FOUND");
    const base = Number(baseRevision);
    const current = Number(currentRevision);
    if (!Number.isFinite(base) || !Number.isFinite(current)) return fail("INVALID_INPUT", "revision");
    if (base !== current) return fail("REVISION_CONFLICT", { baseRevision: base, currentRevision: current });
    peer.lastSeenAt = Number(this.clock());
    return ok({
      message: this.#deliver({
        type: "patch", canvasId: key, sourceClientId: client, revision: current, ...payload,
        to: [...room.keys()].filter((id) => id !== client),
      }),
    });
  }

  /** 源 :56-73 的 message 路由；返回 null 表示忽略（畸形消息）。 */
  handleMessage({ canvasId, clientId, raw } = {}) {
    let message;
    try { message = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
    if (!message || typeof message !== "object") return null;
    if (message.type !== "cursor") return null;
    const result = this.cursor({ canvasId, clientId, x: message.x, y: message.y, nodeId: message.cardId });
    return result.ok ? result.message : null;
  }

  liveRooms() {
    return [...this.rooms.entries()].map(([canvasId, room]) => ({ canvasId, clientIds: [...room.keys()] }));
  }

  close() {
    this.rooms.clear();
    this.cursorBudget.clear();
  }
}

// ---------------------------------------------------------------------------
// 局域网传输（本机 / LAN；惰性 require("ws")，不写入 package.json）
// ---------------------------------------------------------------------------

/**
 * 源 :40-81 的 setupCanvasCollaboration：upgrade → /api/canvas/collab（这里做成可配置 path）。
 * 返回 { wss, close }；**注意**：本函数会 require("ws")，仅在真的启用局域网协作时调用。
 */
function createLanCollabServer({ hub, httpServer = null, path: collabPath = "/api/canvas/collab", host = "127.0.0.1", port = 0, authorize = null } = {}) {
  if (!hub) throw new Error("createLanCollabServer 需要 hub");
  // 惰性依赖：硬约束要求 ws 只能按需 require，不得写进 package.json。
  const { WebSocketServer, WebSocket } = require("ws");
  /** @type {Map<string, import("ws").WebSocket>} peerKey → socket */
  const sockets = new Map();
  const wss = new WebSocketServer({ noServer: true });
  const server = httpServer || require("node:http").createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const onUpgrade = (request, socket, head) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== collabPath) return;
    const canvasId = url.searchParams.get("canvasId") || "";
    const clientId = url.searchParams.get("clientId") || "";
    const userId = url.searchParams.get("userId") || "local";
    if (!canvasId || !clientId) return socket.destroy();
    if (typeof authorize === "function" && authorize({ canvasId, clientId, userId }) === false) return socket.destroy();
    wss.handleUpgrade(request, socket, head, (socketPeer) => {
      const joined = hub.join({ canvasId, clientId, userId, canEdit: true });
      if (!joined.ok) return socketPeer.close();
      sockets.set(peerKey(canvasId, clientId), socketPeer);
      socketPeer.on("message", (raw) => { hub.handleMessage({ canvasId, clientId, raw: String(raw) }); });
      socketPeer.on("close", () => { sockets.delete(peerKey(canvasId, clientId)); hub.leave({ canvasId, clientId }); });
    });
  };
  server.on("upgrade", onUpgrade);
  // 源 :21-38 的 broadcast：只发给目标客户端，且不回发起人（由 hub 计算的 to 决定）。
  hub.onBroadcast = (delivery) => {
    const recipients = Array.isArray(delivery.to) ? delivery.to : [...((hub.rooms.get(String(delivery.canvasId)) || new Map()).keys())];
    const payload = JSON.stringify({ ...delivery, to: undefined });
    for (const clientId of recipients) {
      const socketPeer = sockets.get(peerKey(delivery.canvasId, clientId));
      if (socketPeer && socketPeer.readyState === WebSocket.OPEN) socketPeer.send(payload);
    }
  };
  if (!httpServer) server.listen(port, host);
  return {
    wss, server,
    close() {
      try { hub.onBroadcast = null; } catch { /* ignore */ }
      try { wss.close(); } catch { /* ignore */ }
      if (!httpServer) { try { server.close(); } catch { /* ignore */ } }
    },
  };
}

module.exports = {
  CanvasCollabHub, LIMITS, safePath, diffCanvasNode, applyCanvasNodePatch,
  applyCanvasNodePatchPreservingLocal, reconcileCanvasNodesAfterSave,
  createLanCollabServer, peerKey,
};
