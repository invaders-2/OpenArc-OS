/**
 * task-8 A · 局域网协作服务：opt-in、0.0.0.0 随机端口、一次性配对码/令牌、WS 只读能力与鉴权。
 * 传输层是 Node 内置 http + 最小 RFC6455 实现；测试用裸 socket 做真实握手/帧。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const { createLanCollabService, normalizePairingCode } = require("../electron/lan-collab-service.cjs");
const { createLocalProxyService } = require("../electron/local-proxy-service.cjs");
const domain = require("../electron/local-proxy-domain.cjs");

const services = [];
afterEach(async () => {
  while (services.length) {
    const service = services.pop();
    try { await service.dispose(); } catch { /* 已关闭 */ }
  }
});

function fakeCanvasService() {
  return {
    listCanvases: ({ context }) => ({ ok: true, canvases: [{ canvasId: "cv_1", title: "画布一" }, { canvasId: "cv_2", title: "画布二" }] }),
    getCanvas: ({ context, canvasId }) => canvasId === "cv_1"
      ? { ok: true, canvas: { canvasId: "cv_1", title: "画布一", doc: { nodes: [{ id: "n1", type: "note" }] }, access: { source: "owner" } } }
      : { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" },
    libraryList: ({ context, limit }) => ({ ok: true, items: [
      { ref: "openarc-asset:res_1", resourceId: "res_1", name: "封面", mimeType: "image/png", width: 10, height: 10, thumbnailDataUrl: "data:image/png;base64,AAAA" },
    ] }),
  };
}

function makeService(options = {}) {
  const state = { now: 1_700_000_000_000 };
  const service = createLanCollabService({
    canvasService: fakeCanvasService(),
    authorization: { resolveActor: ({ context }) => context && context.sessionRef ? { ok: true, user: { id: "u-lan", team_id: "org-1" }, isSuper: false } : { ok: false, error: "no-session" } },
    clock: () => state.now,
    ...options,
  });
  services.push(service);
  return { service, state, context: { sessionRef: "sess-lan", appId: "ai" } };
}

// ── 裸 WebSocket 客户端（真实握手 + 帧） ───────────────────────────────────
function maskedFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, body]);
}

function parseServerFrames(buffer) {
  const frames = [];
  let rest = buffer;
  for (;;) {
    if (rest.length < 2) break;
    const opcode = rest[0] & 0x0f;
    let length = rest[1] & 0x7f;
    let offset = 2;
    if (length === 126) { if (rest.length < 4) break; length = rest.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (rest.length < 10) break; length = Number(rest.readBigUInt64BE(2)); offset = 10; }
    if (rest.length < offset + length) break;
    frames.push({ opcode, payload: rest.subarray(offset, offset + length) });
    rest = rest.subarray(offset + length);
  }
  return { frames, rest };
}

function connect(port, token) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write("GET /api/canvas/collab" + (token ? "?token=" + encodeURIComponent(token) : "") + " HTTP/1.1\r\n" +
        "Host: 127.0.0.1:" + port + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n");
    });
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    const queue = [];
    const waiters = [];
    const client = {
      socket, status: null, messages: [],
      send(value) { socket.write(maskedFrame(typeof value === "string" ? value : JSON.stringify(value))); },
      next(timeoutMs = 3000) {
        if (queue.length) return Promise.resolve(queue.shift());
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error("timeout waiting ws message")), timeoutMs);
          waiters.push((message) => { clearTimeout(timer); res(message); });
        });
      },
      close() { try { socket.destroy(); } catch { /* ignore */ } },
    };
    const settle = () => {
      if (!handshaken) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString("utf8");
        client.status = Number((head.split("\r\n")[0] || "").split(" ")[1] || 0);
        buffer = buffer.subarray(end + 4);
        handshaken = true;
        resolve(client);
      }
      const parsed = parseServerFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.opcode !== 1) continue;
        let message;
        try { message = JSON.parse(frame.payload.toString("utf8")); } catch { continue; }
        client.messages.push(message);
        if (waiters.length) waiters.shift()(message);
        else queue.push(message);
      }
    };
    socket.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); try { settle(); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
}

async function startedService(options = {}) {
  const f = makeService(options);
  const started = await f.service.execute("desktop/lan/start", {}, f.context);
  assert.equal(started.ok, true, JSON.stringify(started));
  const status = await f.service.execute("desktop/lan/status", {}, f.context);
  return { ...f, port: status.value.value ? status.value.value.port : status.value.port, status: status.value };
}

function pairCode(service, context, payload = {}) {
  return service.execute("desktop/lan/pairing/create", payload, context);
}
function pairToken(service, code) {
  return service.execute("desktop/lan/pair", { code }, {});
}

// ── ① 开关 / 端口 / 状态 ──────────────────────────────────────────────────
test("① 默认关闭零监听；start 后监听 0.0.0.0 随机端口；stop 关闭并清空", async () => {
  const f = makeService();
  const off = await f.service.execute("desktop/lan/status", {}, f.context);
  assert.equal(off.ok, true);
  assert.equal(off.value.enabled, false);
  assert.equal(off.value.listening, false);

  const started = await f.service.execute("desktop/lan/start", {}, f.context);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.value.status.enabled, true);
  assert.equal(started.value.binding, "0.0.0.0");
  assert.ok(started.value.port > 0);
  const address = f.service.getServer().address();
  assert.equal(address.address, "0.0.0.0");
  assert.equal(address.port, started.value.port);

  const again = await f.service.execute("desktop/lan/start", {}, f.context);
  assert.equal(again.value.alreadyRunning, true);

  const stopped = await f.service.execute("desktop/lan/stop", {}, f.context);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.value.status.enabled, false);
  assert.equal(stopped.value.status.port, null);
});

test("① 未认证 start / pairing 拒绝；未 start 时生成配对码 NOT_READY", async () => {
  const f = makeService();
  const noAuth = await f.service.execute("desktop/lan/start", {}, {});
  assert.equal(noAuth.ok, false);
  assert.equal(noAuth.error, "FORBIDDEN");

  const notReady = await pairCode(f.service, f.context);
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, "NOT_READY");
});

// ── ② 一次性配对码 / 令牌 ─────────────────────────────────────────────────
test("② 配对码一次性、过期即失效；令牌只返回一次且不回显配对码", async () => {
  const f = await startedService();
  const created = await pairCode(f.service, f.context, { canvasId: "cv_1" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.match(created.value.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(created.value.canvasId, "cv_1");
  assert.equal(JSON.stringify(created.value).includes("token"), false);

  const wrong = await pairToken(f.service, "AAAA-BBBB");
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, "FORBIDDEN");

  const paired = await pairToken(f.service, created.value.code.toLowerCase());
  assert.equal(paired.ok, true, JSON.stringify(paired));
  assert.ok(paired.value.token.length > 30);
  assert.equal(paired.value.canvasId, "cv_1");
  assert.equal(paired.value.readOnly, true);
  assert.equal(JSON.stringify(paired.value).includes(created.value.code), false);

  const reuse = await pairToken(f.service, created.value.code);
  assert.equal(reuse.ok, false);
  assert.equal(reuse.error, "NOT_FOUND");

  const created2 = await pairCode(f.service, f.context);
  f.state.now += 10 * 60 * 1000 + 1;
  const expired = await pairToken(f.service, created2.value.code);
  assert.equal(expired.ok, false);
  assert.equal(expired.error, "NOT_FOUND");
});

// ── ③ WS 鉴权 ─────────────────────────────────────────────────────────────
test("③ WS：无令牌 / 错令牌 / 过期令牌在 upgrade 阶段 401，不建连接", async () => {
  const f = await startedService();
  const none = await connect(f.port, "");
  assert.equal(none.status, 401);
  none.close();
  const bad = await connect(f.port, "not-a-token");
  assert.equal(bad.status, 401);
  bad.close();

  const created = await pairCode(f.service, f.context);
  const paired = await pairToken(f.service, created.value.code);
  assert.equal(paired.ok, true);
  f.state.now += 24 * 60 * 60 * 1000 + 1;
  const expired = await connect(f.port, paired.value.token);
  assert.equal(expired.status, 401);
  expired.close();
});

test("③ WS：只读画布 / 资源列表；patch 拒绝；ping/pong；token 绑定单画布", async () => {
  const f = await startedService();
  const created = await pairCode(f.service, f.context);
  const paired = await pairToken(f.service, created.value.code);
  const client = await connect(f.port, paired.value.token);
  try {
    assert.equal(client.status, 101);
    client.send({ type: "canvas.list" });
    const list = await client.next();
    assert.equal(list.type, "canvas.list.result");
    assert.equal(list.ok, true);
    assert.equal(list.canvases.length, 2);
    assert.equal(list.readOnly, true);

    client.send({ type: "canvas.get", canvasId: "cv_1" });
    const got = await client.next();
    assert.equal(got.ok, true);
    assert.equal(got.readOnly, true);
    assert.equal(got.canvas.doc.nodes[0].id, "n1");

    client.send({ type: "resource.list", limit: 5 });
    const resources = await client.next();
    assert.equal(resources.ok, true);
    assert.deepEqual(resources.items[0], { ref: "openarc-asset:res_1", resourceId: "res_1", name: "封面", mimeType: "image/png", width: 10, height: 10 });
    assert.equal(JSON.stringify(resources).includes("thumbnailDataUrl"), false);

    client.send({ type: "collab.patch", canvasId: "cv_1", patches: [] });
    const denied = await client.next();
    assert.equal(denied.error, "READ_ONLY");

    client.send({ type: "ping" });
    const pong = await client.next();
    assert.equal(pong.type, "pong");
  } finally { client.close(); }

  // 绑定 cv_1 的令牌不能读 cv_2 / 列表只回 cv_1
  const bound = await pairCode(f.service, f.context, { canvasId: "cv_1" });
  const boundToken = await pairToken(f.service, bound.value.code);
  const boundClient = await connect(f.port, boundToken.value.token);
  try {
    boundClient.send({ type: "canvas.list" });
    const onlyOne = await boundClient.next();
    assert.deepEqual(onlyOne.canvases.map((canvas) => canvas.canvasId), ["cv_1"]);
    boundClient.send({ type: "canvas.get", canvasId: "cv_2" });
    const forbidden = await boundClient.next();
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.error, "FORBIDDEN");
  } finally { boundClient.close(); }
});

test("③ WS 协作：join / presence / cursor 广播；令牌无编辑权", async () => {
  const f = await startedService();
  const code = await pairCode(f.service, f.context, { canvasId: "cv_1" });
  const token = (await pairToken(f.service, code.value.code)).value.token;
  const a = await connect(f.port, token);
  const b = await connect(f.port, token);
  try {
    a.send({ type: "collab.join", canvasId: "cv_1", username: "A" });
    const joinA = await a.next();
    assert.equal(joinA.ok, true);
    assert.equal(joinA.presence.users.length, 1);

    b.send({ type: "collab.join", canvasId: "cv_1", username: "B" });
    const joinB = await b.next();
    assert.equal(joinB.ok, true);
    const presenceForA = await a.next();
    assert.equal(presenceForA.type, "presence");
    assert.equal(presenceForA.users.length, 2);

    b.send({ type: "collab.cursor", canvasId: "cv_1", x: 12, y: 34 });
    const cursor = await a.next();
    assert.equal(cursor.type, "cursor");
    assert.equal(cursor.x, 12);
    assert.equal(cursor.y, 34);
    assert.equal(typeof cursor.clientId, "string");
    assert.ok(cursor.clientId.startsWith("lan:"));
    assert.equal(Object.prototype.hasOwnProperty.call(cursor, "to"), false, "广播不得把内部 to 列表发给客户端");
  } finally { a.close(); b.close(); }
});

test("④ desktop:command 委托：命令白名单 / trusted 由既有 bootstrap 负责，未装配结构化失败", async () => {
  const fake = {
    execute: async (command) => ({ ok: true, value: { command, enabled: false } }),
  };
  const service = createLocalProxyService({ userDataDir: "/tmp/unused-oa-lan", lanService: fake });
  const result = await service.execute("desktop/lan/status", {}, { sessionRef: "s1" });
  assert.equal(result.ok, true);
  assert.equal(result.value.command, "desktop/lan/status");
  const unbound = createLocalProxyService({ userDataDir: "/tmp/unused-oa-lan" });
  const unavailable = await unbound.execute("desktop/lan/start", {}, { sessionRef: "s1" });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, "LOCAL_PROXY_DEPENDENCY_UNAVAILABLE");
  for (const command of ["desktop/lan/status", "desktop/lan/start", "desktop/lan/stop", "desktop/lan/pairing/create", "desktop/lan/pair"]) {
    assert.equal(domain.isLocalProxyCommand(command), true, command);
  }
});

test("⑤ main.cjs 装配契约：opt-in LAN 服务注入 canvas service / authorization", () => {
  const main = fs.readFileSync(path.join(ROOT, "electron", "main.cjs"), "utf8");
  assert.ok(main.includes('require("./lan-collab-service.cjs")'));
  assert.ok(main.includes("createLanCollabService({"));
  assert.ok(main.includes("canvasService: identity.canvasDocService"));
  assert.ok(main.includes("assetLibrary: identity.canvasAssetLibrary"));
  assert.ok(main.includes("authorization: identity.authorization"));
  assert.ok(main.includes("lanService,"));
  assert.ok(main.includes("before-quit"));
});
