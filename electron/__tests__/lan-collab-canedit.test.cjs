"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { createLanCollabService } = require("../lan-collab-service.cjs");

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function openClient(service) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + service.status().port + "/api/canvas/collab?token=" + encodeURIComponent(service.__token));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
function nextMessage(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout:" + type)), 4000);
    const onMessage = (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (type && msg.type !== type) return;
      clearTimeout(timer); ws.off("message", onMessage); resolve(msg);
    };
    ws.on("message", onMessage);
  });
}

test("LAN pairing canEdit=true allows collab.patch", async () => {
  const service = createLanCollabService({ host: "127.0.0.1", authorization: { resolveActor: () => ({ ok: true, user: { id: "u1", team_id: "t1" } }) } });
  await service.start({}, { sessionRef: "s1" });
  try {
    const paired = service.pairingCreate({ canvasId: "c1", canEdit: true }, { sessionRef: "s1" });
    assert.equal(paired.ok, true);
    assert.equal(paired.canEdit, true);
    assert.equal(paired.readOnly, false);
    const token = service.pair({ code: paired.code });
    assert.equal(token.ok, true);
    assert.equal(token.canEdit, true);
    service.__token = token.token;
    const ws = await openClient(service);
    ws.send(JSON.stringify({ type: "collab.join", canvasId: "c1", username: "guest" }));
    const joined = await nextMessage(ws, "collab.join.result");
    assert.equal(joined.readOnly, false);
    assert.equal(joined.canEdit, true);
    ws.send(JSON.stringify({ type: "collab.patch", canvasId: "c1", baseRevision: 1, currentRevision: 1, patch: { type: "update-node", id: "n1", patch: { x: 10 } } }));
    const patched = await nextMessage(ws, "collab.patch.result");
    assert.equal(patched.ok, true);
    ws.close();
  } finally { await service.dispose(); }
});

test("LAN pairing canEdit=false rejects collab.patch with READ_ONLY", async () => {
  const service = createLanCollabService({ host: "127.0.0.1", authorization: { resolveActor: () => ({ ok: true, user: { id: "u2", team_id: "t1" } }) } });
  await service.start({}, { sessionRef: "s2" });
  try {
    const paired = service.pairingCreate({ canvasId: "c2", canEdit: false }, { sessionRef: "s2" });
    assert.equal(paired.readOnly, true);
    const token = service.pair({ code: paired.code });
    assert.equal(token.canEdit, false);
    service.__token = token.token;
    const ws = await openClient(service);
    ws.send(JSON.stringify({ type: "collab.join", canvasId: "c2" }));
    const joined = await nextMessage(ws, "collab.join.result");
    assert.equal(joined.readOnly, true);
    ws.send(JSON.stringify({ type: "collab.patch", canvasId: "c2", baseRevision: 1, currentRevision: 1, patch: {} }));
    const rejected = await nextMessage(ws, "error");
    assert.equal(rejected.error, "READ_ONLY");
    ws.close();
  } finally { await service.dispose(); }
});

test("LAN pairing code expires", async () => {
  let now = 1000;
  const service = createLanCollabService({ host: "127.0.0.1", clock: () => now, pairingTtlMs: 1000, authorization: { resolveActor: () => ({ ok: true, user: { id: "u3", team_id: "t1" } }) } });
  await service.start({}, { sessionRef: "s3" });
  try {
    const paired = service.pairingCreate({ canvasId: "c3" }, { sessionRef: "s3" });
    now += 2000;
    const result = service.pair({ code: paired.code });
    assert.equal(result.ok, false);
    assert.equal(result.error, "NOT_FOUND");
  } finally { await service.dispose(); }
});

const http = require("node:http");
function httpPair(service, code) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ code });
    const req = http.request({ host: "127.0.0.1", port: service.status().port, path: "/api/canvas/collab/pair", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      let data = ""; res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => { let parsed = null; try { parsed = JSON.parse(data); } catch { /* ignore */ } resolve({ status: res.statusCode, body: parsed }); });
    });
    req.on("error", (error) => resolve({ status: 0, error: String(error && error.message || error) }));
    req.end(body);
  });
}

test("HTTP pair exchanges code once and returns token fields", async () => {
  const service = createLanCollabService({ host: "127.0.0.1", authorization: { resolveActor: () => ({ ok: true, user: { id: "u4", team_id: "t1" } }) } });
  await service.start({}, { sessionRef: "s4" });
  try {
    const pairing = service.pairingCreate({ canvasId: "c4", canEdit: true }, { sessionRef: "s4" });
    const first = await httpPair(service, pairing.code);
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.ok(first.body.token);
    assert.equal(first.body.canvasId, "c4");
    assert.equal(first.body.canEdit, true);
    assert.equal(first.body.wsPath, "/api/canvas/collab");
    const second = await httpPair(service, pairing.code);
    assert.equal(second.status, 404);
    assert.equal(second.body.ok, false);
  } finally { await service.dispose(); }
});

test("HTTP pair rejects bad JSON/rate limits failures", async () => {
  const service = createLanCollabService({ host: "127.0.0.1", authorization: { resolveActor: () => ({ ok: true, user: { id: "u5", team_id: "t1" } }) } });
  await service.start({}, { sessionRef: "s5" });
  try {
    const pairing = service.pairingCreate({ canvasId: "c5" }, { sessionRef: "s5" });
    for (let i = 0; i < 5; i += 1) {
      const res = await httpPair(service, "AAAA-AAAA");
      assert.equal(res.status, 403);
    }
    const limited = await httpPair(service, pairing.code);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "RATE_LIMITED");
  } finally { await service.dispose(); }
});

test("revoke token closes WS and rejects token reuse; readonly HTTP token rejects patch", async () => {
  const service = createLanCollabService({ host: "127.0.0.1", authorization: { resolveActor: () => ({ ok: true, user: { id: "u6", team_id: "t1" } }) } });
  await service.start({}, { sessionRef: "s6" });
  try {
    const pairing = service.pairingCreate({ canvasId: "c6", canEdit: true }, { sessionRef: "s6" });
    const paired = await httpPair(service, pairing.code);
    service.__token = paired.body.token;
    const ws = await openClient(service);
    ws.send(JSON.stringify({ type: "collab.join", canvasId: "c6", username: "device-a" }));
    await nextMessage(ws, "collab.join.result");
    const devices = await service.execute("desktop/lan/devices", {}, { sessionRef: "s6" });
    assert.equal(devices.ok, true);
    assert.equal(devices.value.devices.length, 1);
    assert.equal(devices.value.devices[0].canEdit, true);
    const closed = new Promise((resolve) => ws.once("close", resolve));
    const revoked = await service.execute("desktop/lan/revoke", { tokenId: paired.body.tokenId }, { sessionRef: "s6" });
    assert.equal(revoked.ok, true);
    assert.equal(revoked.value.revoked, 1);
    await closed;
    const reuse = new WebSocket("ws://127.0.0.1:" + service.status().port + "/api/canvas/collab?token=" + encodeURIComponent(paired.body.token));
    const rejected = await new Promise((resolve) => { reuse.once("open", () => resolve(false)); reuse.once("error", () => resolve(true)); });
    assert.equal(rejected, true);
    try { reuse.close(); } catch { /* ignore */ }

    const readonlyPairing = service.pairingCreate({ canvasId: "c6", canEdit: false }, { sessionRef: "s6" });
    const readonly = await httpPair(service, readonlyPairing.code);
    service.__token = readonly.body.token;
    const roWs = await openClient(service);
    roWs.send(JSON.stringify({ type: "collab.join", canvasId: "c6" }));
    await nextMessage(roWs, "collab.join.result");
    roWs.send(JSON.stringify({ type: "collab.patch", canvasId: "c6", baseRevision: 1, currentRevision: 1, patch: {} }));
    const err = await nextMessage(roWs, "error");
    assert.equal(err.error, "READ_ONLY");
    roWs.close();
  } finally { await service.dispose(); }
});
