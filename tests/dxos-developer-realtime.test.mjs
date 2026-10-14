/**
 * B7b · 本机 / 局域网实时房间（源 developerRealtime.ts:1-218）。
 * 云端房间 OUT；未注入传输一律结构化不可用（不假连接）。全程离线（LAN 用例用假 ws 工厂，不监听端口）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rt = require("../electron/developer-realtime.cjs");
const lab = require("../electron/developer-lab.cjs");

function makeHub(options = {}) {
  const authorize = Object.prototype.hasOwnProperty.call(options, "authorize") ? options.authorize : () => true;
  return new rt.DeveloperRealtimeHub({ authorize, clock: options.clock, transport: options.transport, onEvent: options.onEvent, idleRoomTtlMs: options.idleRoomTtlMs, maxPeersPerRoom: options.maxPeersPerRoom });
}
function createRoom(hub, extra = {}) {
  const created = hub.createRoom({ appId: "demo", ownerId: "u1", name: "房间", ...extra });
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.room;
}

test("房间：创建 / 加入 / 成员 / 离开，空房由 cleanup 回收", () => {
  const hub = makeHub();
  const room = createRoom(hub);
  assert.equal(room.seq, 0);
  const first = hub.join({ appId: "demo", roomId: room.id, clientId: "c1", userId: "u1", username: "阿一" });
  assert.equal(first.ok, true);
  assert.equal(first.seq, 1);
  const second = hub.join({ appId: "demo", roomId: room.id, clientId: "c2", userId: "u2", username: "阿二" });
  assert.equal(second.ok, true);
  assert.equal(hub.members(room.id).length, 2);
  assert.equal(hub.room({ appId: "demo", roomId: room.id }).room.memberList.length, 2);

  const left = hub.leave({ roomId: room.id, clientId: "c1" });
  assert.equal(left.removed, true);
  assert.equal(left.members.length, 1);
  assert.equal(hub.members(room.id)[0].clientId, "c2");

  // 空房（c2 也走）后按空闲 TTL 回收。
  hub.leave({ roomId: room.id, clientId: "c2" });
  const cleaned = hub.cleanup(Number.MAX_SAFE_INTEGER);
  assert.equal(cleaned.rooms, 1);
  assert.equal(hub.room({ appId: "demo", roomId: room.id }).error, "NOT_FOUND");
});

test("鉴权 fail-closed：未注入 / 抛错 / 拒绝都不得进房", () => {
  const noAuth = makeHub({ authorize: null });
  const a = noAuth.join({ appId: "demo", roomId: createRoom(noAuth).id, clientId: "c1", userId: "u1" });
  assert.equal(a.ok, false);
  assert.equal(a.error, "FORBIDDEN");
  assert.equal(a.detail, "authorize-not-configured");

  const throwing = makeHub({ authorize: () => { throw new Error("boom"); } });
  assert.equal(throwing.join({ appId: "demo", roomId: createRoom(throwing).id, clientId: "c1", userId: "u1" }).detail, "authorize-error");

  const denying = makeHub({ authorize: () => false });
  assert.equal(denying.join({ appId: "demo", roomId: createRoom(denying).id, clientId: "c1", userId: "u1" }).detail, "authorize-denied");

  const structured = makeHub({ authorize: () => ({ ok: false, error: "COLLAB_FORBIDDEN", detail: "not-a-member" }) });
  const denied = structured.join({ appId: "demo", roomId: createRoom(structured).id, clientId: "c1", userId: "u1" });
  assert.equal(denied.error, "COLLAB_FORBIDDEN");
  assert.equal(denied.detail, "not-a-member");
});

test("房间白名单与容量：allowedUserIds 外拒绝；满员拒绝不挤人", () => {
  const hub = makeHub();
  const room = createRoom(hub, { allowedUserIds: ["u2"] });
  assert.equal(hub.join({ appId: "demo", roomId: room.id, clientId: "c9", userId: "u9" }).error, "FORBIDDEN");
  assert.equal(hub.join({ appId: "demo", roomId: room.id, clientId: "c2", userId: "u2" }).ok, true);

  const small = makeHub({ maxPeersPerRoom: 2 });
  const r2 = createRoom(small, { maxMembers: 2 });
  small.join({ appId: "demo", roomId: r2.id, clientId: "c1", userId: "u1" });
  small.join({ appId: "demo", roomId: r2.id, clientId: "c2", userId: "u2" });
  const third = small.join({ appId: "demo", roomId: r2.id, clientId: "c3", userId: "u3" });
  assert.equal(third.error, "LIMIT_EXCEEDED");
  assert.equal(small.members(r2.id).length, 2);
});

test("序号与广播：send 带 seq、只发给别人、限速、超大消息拒绝", () => {
  const hub = makeHub();
  const room = createRoom(hub);
  hub.join({ appId: "demo", roomId: room.id, clientId: "c1", userId: "u1" });
  hub.join({ appId: "demo", roomId: room.id, clientId: "c2", userId: "u2" });
  const firstSeq = hub.room({ appId: "demo", roomId: room.id }).room.seq;
  const sent = hub.send({ roomId: room.id, clientId: "c1", data: { text: "hi" } });
  assert.equal(sent.ok, true);
  assert.equal(sent.seq, firstSeq + 1);
  assert.deepEqual(sent.recipients, ["c2"]);
  // c2 取走事件；c1 队列里没有这条消息（不回给发起人）。
  const c2Events = hub.drain(room.id, "c2").filter((event) => event.type === "message");
  assert.equal(c2Events.length, 1);
  assert.equal(c2Events[0].seq, sent.seq);
  assert.equal(c2Events[0].data.text, "hi");
  assert.equal(hub.drain(room.id, "c1").filter((event) => event.type === "message").length, 0);

  const huge = hub.send({ roomId: room.id, clientId: "c1", data: "x".repeat(rt.MAX_MESSAGE_BYTES + 16) });
  assert.equal(huge.error, "LIMIT_EXCEEDED");
  assert.equal(huge.detail, "message-too-large");

  // 限速用独立房间计数，避免前面的消息占用配额。
  const rateHub = makeHub();
  const rateRoom = createRoom(rateHub);
  rateHub.join({ appId: "demo", roomId: rateRoom.id, clientId: "c1", userId: "u1" });
  let allowed = 0;
  for (let i = 0; i < rt.MAX_RATE_PER_SECOND + 10; i += 1) if (rateHub.send({ roomId: rateRoom.id, clientId: "c1", data: i }).ok) allowed += 1;
  assert.equal(allowed, rt.MAX_RATE_PER_SECOND, "超过每秒上限必须限速");
});

test("权威状态：只有房主可写，baseSeq 不符返回 SEQ_CONFLICT 且不改状态", () => {
  const hub = makeHub();
  const room = createRoom(hub, { state: { v: 0 } });
  hub.join({ appId: "demo", roomId: room.id, clientId: "c1", userId: "u1" });
  hub.join({ appId: "demo", roomId: room.id, clientId: "c2", userId: "u2" });
  const currentSeq = hub.room({ appId: "demo", roomId: room.id }).room.seq;

  const notOwner = hub.setState({ roomId: room.id, clientId: "c2", baseSeq: currentSeq, state: { v: 99 } });
  assert.equal(notOwner.error, "FORBIDDEN");
  assert.equal(notOwner.detail, "owner-only");

  const conflict = hub.setState({ roomId: room.id, clientId: "c1", baseSeq: currentSeq - 1, state: { v: 99 } });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "SEQ_CONFLICT");
  assert.equal(conflict.detail.currentSeq, currentSeq);
  assert.deepEqual(conflict.detail.currentState, { v: 0 });

  const ok = hub.setState({ roomId: room.id, clientId: "c1", baseSeq: currentSeq, state: { v: 1 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.seq, currentSeq + 1);
  assert.deepEqual(hub.room({ appId: "demo", roomId: room.id }).room.state, { v: 1 });
});

test("断线重连：同 clientId + 同用户可续上并回放 lastSeq 之后的事件", () => {
  const hub = makeHub();
  const room = createRoom(hub);
  hub.join({ appId: "demo", roomId: room.id, clientId: "c1", userId: "u1" });
  const second = hub.join({ appId: "demo", roomId: room.id, clientId: "c2", userId: "u2" });
  assert.equal(second.ok, true);
  const firstMessage = hub.send({ roomId: room.id, clientId: "c1", data: { n: 1 } });
  const left = hub.leave({ roomId: room.id, clientId: "c2" });
  assert.equal(left.detached, true);
  const secondMessage = hub.send({ roomId: room.id, clientId: "c1", data: { n: 2 } });

  const resumed = hub.reconnect({ appId: "demo", roomId: room.id, clientId: "c2", userId: "u2", lastSeq: firstMessage.seq });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resumed, true);
  const missedSeqs = resumed.missed.map((event) => event.seq);
  assert.ok(missedSeqs.includes(secondMessage.seq), "必须回放断线期间的消息");
  assert.equal(missedSeqs.includes(firstMessage.seq), false, "lastSeq 之前的不能重复回放");
  assert.equal(hub.members(room.id).length, 2);

  // 同一 clientId 换用户重连必须拒绝。
  const hijack = hub.reconnect({ appId: "demo", roomId: room.id, clientId: "c2", userId: "u3", lastSeq: 0 });
  assert.equal(hijack.error, "FORBIDDEN");
  assert.equal(hijack.detail, "client-id-taken");
  // 没有会话可续时明确 NOT_FOUND，不悄悄新建。
  assert.equal(hub.reconnect({ appId: "demo", roomId: room.id, clientId: "ghost", userId: "u9", lastSeq: 0 }).error, "NOT_FOUND");
});

test("房主转移：房主离开后由剩余成员接任并广播", () => {
  const hub = makeHub();
  const room = createRoom(hub);
  hub.join({ appId: "demo", roomId: room.id, clientId: "c1", userId: "u1" });
  hub.join({ appId: "demo", roomId: room.id, clientId: "c2", userId: "u2" });
  const left = hub.leave({ roomId: room.id, clientId: "c1" });
  assert.equal(left.ownerChanged, true);
  assert.equal(hub.room({ appId: "demo", roomId: room.id }).room.ownerId, "u2");
  const events = hub.drain(room.id, "c2");
  assert.ok(events.some((event) => event.type === "owner" && event.ownerId === "u2"));
});

test("传输：未注入时结构化不可用；注入后广播经传输发送，关房走 close", () => {
  const bare = makeHub();
  const status = bare.transportStatus();
  assert.equal(status.ok, false);
  assert.equal(status.error, "DEVELOPER_REALTIME_TRANSPORT_UNAVAILABLE");
  assert.equal(status.detail, "transport-not-configured");
  assert.equal(bare.connect({}).error, "DEVELOPER_REALTIME_TRANSPORT_UNAVAILABLE");

  const sent = [];
  const closed = [];
  const transport = { kind: "fake", send: (delivery) => sent.push(delivery), close: (delivery) => closed.push(delivery) };
  const hub = makeHub({ transport });
  const room = createRoom(hub);
  hub.join({ appId: "demo", roomId: room.id, clientId: "c1", userId: "u1" });
  hub.join({ appId: "demo", roomId: room.id, clientId: "c2", userId: "u2" });
  assert.ok(sent.some((delivery) => delivery.clientId === "c2" && delivery.payload.type === "joined"));
  hub.send({ roomId: room.id, clientId: "c1", data: "hi" });
  assert.ok(sent.some((delivery) => delivery.clientId === "c2" && delivery.payload.type === "message"));
  const closedRoom = hub.closeRoom({ appId: "demo", roomId: room.id, userId: "u1" });
  assert.equal(closedRoom.ok, true);
  assert.equal(closed.length, 2);
});

test("下行事件接入 developer:event（唯一事件通道）", () => {
  const events = [];
  const hub = makeHub();
  const extension = rt.createDeveloperRealtimeExtension({ hub });
  assert.equal(extension.channel, "developer:command");
  assert.equal(extension.eventChannel, "developer:event");
  const wired = lab.wireDeveloperEvents({ extensions: [extension], send: (event) => events.push(event) });
  assert.deepEqual(wired, ["developer:command"]);
  const room = createRoom(hub);
  hub.join({ appId: "demo", roomId: room.id, clientId: "c1", userId: "u1" });
  assert.ok(events.some((event) => event.channel === "developer:event" && event.type === "joined"));
});

test("命令面：developer/realtime/* 通过唯一切片分发，含未注入 hub 的结构化拒绝", () => {
  const hub = makeHub();
  const extension = rt.createDeveloperRealtimeExtension({ hub });
  const created = extension.dispatch({ command: "developer/realtime/create", payload: { appId: "demo", ownerId: "u1" } });
  assert.equal(created.ok, true);
  const joined = extension.dispatch({ command: "developer/realtime/join", payload: { appId: "demo", roomId: created.room.id, clientId: "c1", userId: "u1" } });
  assert.equal(joined.ok, true);
  const stats = extension.dispatch({ command: "developer/realtime/stats", payload: {} });
  assert.equal(stats.stats.rooms, 1);
  assert.equal(extension.dispatch({ command: "developer/realtime/nope", payload: {} }).error, "DEVELOPER_COMMAND_NOT_ALLOWED");
  assert.equal(rt.createDeveloperRealtimeExtension({}).dispatch({ command: "developer/realtime/stats", payload: {} }).error, "DEVELOPER_REALTIME_UNAVAILABLE");
});

// ---------------------------------------------------------------------------
// 局域网入口：不监听端口，用假 httpServer + 假 ws 工厂（离线）
// ---------------------------------------------------------------------------

function fakeWsFactory() {
  const sockets = [];
  class FakeSocket {
    constructor() { this.readyState = 1; this.sent = []; this.handlers = {}; }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; if (this.handlers.close) this.handlers.close(); }
    on(event, handler) { this.handlers[event] = handler; }
  }
  const wss = {
    handleUpgrade(_request, _socket, _head, callback) { const ws = new FakeSocket(); sockets.push(ws); callback(ws); },
    close() {},
  };
  return {
    WebSocketServer: function WebSocketServer() { return wss; },
    WebSocket: { OPEN: 1 },
    sockets,
  };
}

test("局域网入口：缺 authorize / 缺 ws 构造期结构化拒绝（不先起服务）", () => {
  const hub = makeHub();
  const missingAuth = rt.createLanRealtimeServer({ hub, authorize: null });
  assert.equal(missingAuth.ok, false);
  assert.equal(missingAuth.error, "FORBIDDEN");
  assert.equal(missingAuth.detail, "authorize-not-configured");

  const noWs = rt.createLanRealtimeServer({ hub, authorize: () => true, wsFactory: { WebSocketServer: null } });
  assert.equal(noWs.ok, false);
  assert.equal(noWs.error, "DEVELOPER_REALTIME_TRANSPORT_UNAVAILABLE");
  assert.equal(noWs.detail, "ws-not-installed");
});

test("局域网入口：upgrade 鉴权 + 进房 + 消息 + 传输回发（假 ws，不监听端口）", () => {
  const hub = makeHub();
  const upgradeHandlers = [];
  const httpServer = { on: (event, handler) => { if (event === "upgrade") upgradeHandlers.push(handler); }, close() {} };
  const factory = fakeWsFactory();
  const lan = rt.createLanRealtimeServer({ hub, authorize: ({ userId }) => userId === "u1" || userId === "u2", httpServer, wsFactory: factory });
  assert.equal(lan.ok, true);
  assert.equal(upgradeHandlers.length, 1);

  const room = createRoom(hub);
  const destroyed = [];
  const upgrade = (userId, clientId) => {
    const socket = { destroyed: false, destroy() { this.destroyed = true; destroyed.push(clientId); } };
    upgradeHandlers[0]({ url: "/api/developer-realtime?appId=demo&roomId=" + room.id + "&clientId=" + clientId + "&userId=" + userId }, socket, Buffer.alloc(0));
    return socket;
  };
  const denied = upgrade("intruder", "c9");
  assert.equal(denied.destroyed, true, "鉴权失败必须 destroy，不进房");
  assert.equal(hub.members(room.id).length, 0);

  const first = upgrade("u1", "c1");
  const second = upgrade("u2", "c2");
  assert.equal(first.destroyed, false);
  assert.equal(second.destroyed, false);
  assert.equal(hub.members(room.id).length, 2);
  // 第一个 socket 已收到 joined 广播（hub → lan transport → socket）。
  assert.ok(factory.sockets[0].sent.some((text) => JSON.parse(text).type === "joined"));
  // 模拟 c1 发消息：c2 收到 message。
  factory.sockets[0].handlers.message(Buffer.from(JSON.stringify({ type: "send", data: { n: 1 } })));
  assert.ok(factory.sockets[1].sent.some((text) => JSON.parse(text).type === "message"));
  // 关闭 socket 触发 leave。
  factory.sockets[1].close();
  assert.equal(hub.members(room.id).length, 1);
  lan.close();
  assert.equal(hub.transportStatus().error, "DEVELOPER_REALTIME_TRANSPORT_UNAVAILABLE");
});
