/**
 * P2 · 渲染层协作的宿主通道（canvas:command 的 canvas/collab/*）后端契约。
 * 被测：electron/canvas-dxos-commands.cjs（真实 hub + 下行事件队列）装配两个 peer。
 * 只验证后端可观测语义：join/presence、patch 信封广播与不回发、cursor、断线拒绝、重连后按序补发、节点级 last-writer。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const commands = require("../electron/canvas-dxos-commands.cjs");
const { CanvasDxosStore } = require("../electron/canvas-dxos-store.cjs");
const { CanvasStore } = require("../electron/canvas-store.cjs");
const { CanvasService } = require("../electron/canvas-service.cjs");

const ADD_NODE = {
  type: "add-node",
  node: { id: "n1", kind: "note", x: 10, y: 20, w: 220, h: 168, text: "便签" },
};
const MOVE_NODE = (x) => ({ type: "update-node", id: "n1", patch: { x } });

async function fixture() {
  const fx = await createResourceFixture();
  const store = new CanvasDxosStore({ identity: fx.identity, clock: fx.clock });
  const canvasStore = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const canvasService = new CanvasService({
    identity: fx.identity, store: canvasStore, resourceStore: fx.resourceStore,
    resourceService: fx.resourceService, authService: fx.authService, clock: fx.clock,
  });
  const tempDir = () => path.join(fx.storeRoot, "tmp");
  const extension = commands.createCanvasDxosExtension({
    identity: fx.identity, store, canvasService, resourceService: fx.resourceService, tempDir, clock: fx.clock,
  });
  const ctx = (key) => ({ sessionRef: fx.sessions[key], appId: "canvas", source: "ui" });
  const canvas = canvasService.createCanvas({ context: ctx("admin"), title: "协作传输画布" });
  assert.equal(canvas.ok, true, JSON.stringify(canvas));
  return { fx, extension, ctx, canvasId: canvas.canvas.canvasId };
}

function peerHarness(f) {
  const send = (command, payload) => f.extension.dispatch({ command, payload, context: f.ctx("admin") });
  return {
    send,
    join: (clientId) => send("canvas/collab/join", { canvasId: f.canvasId, clientId }),
    leave: (clientId) => send("canvas/collab/leave", { canvasId: f.canvasId, clientId }),
    presence: () => send("canvas/collab/presence", { canvasId: f.canvasId }),
    drain: (clientId) => {
      const res = send("canvas/collab/events", { canvasId: f.canvasId, clientId });
      return res.ok ? res.events : [];
    },
    patch: (clientId, revision, op, base = revision) => send("canvas/collab/patch", {
      canvasId: f.canvasId, clientId, baseRevision: base, currentRevision: revision,
      patch: { patches: [{ source: "react-canvas", op }] },
    }),
    cursor: (clientId, x, y) => send("canvas/collab/cursor", { canvasId: f.canvasId, clientId, x, y }),
  };
}

test("两个 peer 加入：presence 接口互相可见（presence 不进 events 队列，靠轮询）", async () => {
  const f = await fixture();
  try {
    const h = peerHarness(f);
    const a = h.join("peer-a");
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.presence.users.length, 1);
    const b = h.join("peer-b");
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(b.presence.users.length, 2);
    assert.deepEqual(h.presence().presence.users.map((user) => user.clientId).sort(), ["peer-a", "peer-b"]);
    assert.equal(h.drain("peer-a").filter((event) => event.type === "presence").length, 0, "presence 不走下行事件队列");
    assert.equal(h.leave("peer-b").ok, true);
    assert.deepEqual(h.presence().presence.users.map((user) => user.clientId), ["peer-a"], "离开后 presence 只剩一人");
  } finally { f.fx.close(); }
});

test("补丁信封：广播给别人、不回发发起人，op 原样（不改 op 语义）", async () => {
  const f = await fixture();
  try {
    const h = peerHarness(f);
    h.join("peer-a");
    h.join("peer-b");
    h.drain("peer-a");
    h.drain("peer-b");
    const res = h.patch("peer-a", 1, ADD_NODE);
    assert.equal(res.ok, true, JSON.stringify(res));
    const received = h.drain("peer-b").filter((event) => event.type === "patch");
    assert.equal(received.length, 1);
    assert.equal(received[0].sourceClientId, "peer-a");
    assert.equal(received[0].patches[0].source, "react-canvas");
    assert.deepEqual(received[0].patches[0].op, ADD_NODE);
    assert.equal(h.drain("peer-a").filter((event) => event.type === "patch").length, 0, "不得回发发起人");
  } finally { f.fx.close(); }
});

test("光标：只发给别人，presence 保持两人", async () => {
  const f = await fixture();
  try {
    const h = peerHarness(f);
    h.join("peer-a");
    h.join("peer-b");
    h.drain("peer-a");
    h.drain("peer-b");
    assert.equal(h.cursor("peer-a", 12.5, -3).ok, true);
    const received = h.drain("peer-b").filter((event) => event.type === "cursor");
    assert.equal(received.length, 1);
    assert.equal(received[0].x, 12.5);
    assert.equal(received[0].y, -3);
    assert.equal(h.drain("peer-a").filter((event) => event.type === "cursor").length, 0, "不回发发起人");
    assert.equal(h.presence().presence.users.length, 2);
  } finally { f.fx.close(); }
});

test("版本守卫：base ≠ current 时明确拒绝且不广播（渲染层用相等计数满足守卫）", async () => {
  const f = await fixture();
  try {
    const h = peerHarness(f);
    h.join("peer-a");
    h.join("peer-b");
    h.drain("peer-b");
    const stale = h.patch("peer-a", 5, MOVE_NODE(1), 4);
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "REVISION_CONFLICT");
    assert.equal(h.drain("peer-b").filter((event) => event.type === "patch").length, 0, "冲突时不得广播");
    const fresh = h.patch("peer-a", 5, MOVE_NODE(2));
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.equal(h.drain("peer-b").filter((event) => event.type === "patch").length, 1);
  } finally { f.fx.close(); }
});

test("断线重连：离开后 patch 被后端拒绝（渲染层据此入队），重新加入后按序补发", async () => {
  const f = await fixture();
  try {
    const h = peerHarness(f);
    h.join("peer-a");
    h.join("peer-b");
    h.drain("peer-a");
    h.drain("peer-b");
    h.leave("peer-a");
    const offline = h.patch("peer-a", 1, MOVE_NODE(1));
    assert.equal(offline.ok, false);
    assert.equal(offline.error, "NOT_FOUND", "不在房间的 peer 不能广播");
    assert.equal(h.drain("peer-b").filter((event) => event.type === "patch").length, 0);
    assert.equal(h.join("peer-a").ok, true);
    h.drain("peer-a");
    h.drain("peer-b");
    assert.equal(h.patch("peer-a", 2, MOVE_NODE(2)).ok, true);
    assert.equal(h.patch("peer-a", 3, MOVE_NODE(3)).ok, true);
    const patches = h.drain("peer-b").filter((event) => event.type === "patch");
    assert.equal(patches.length, 2);
    assert.deepEqual(patches.map((event) => event.patches[0].op.patch.x), [2, 3], "补发顺序必须保持");
    assert.deepEqual(h.presence().presence.users.map((user) => user.clientId).sort(), ["peer-a", "peer-b"]);
  } finally { f.fx.close(); }
});

test("同一节点并发：两条节点级 update 按到达顺序投递，无整份文档覆盖", async () => {
  const f = await fixture();
  try {
    const h = peerHarness(f);
    h.join("peer-a");
    h.join("peer-b");
    h.drain("peer-a");
    h.drain("peer-b");
    const first = h.patch("peer-a", 1, MOVE_NODE(10));
    const second = h.patch("peer-b", 1, MOVE_NODE(20));
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(second.ok, true, JSON.stringify(second));
    const atA = h.drain("peer-a").filter((event) => event.type === "patch");
    const atB = h.drain("peer-b").filter((event) => event.type === "patch");
    assert.equal(atA.length, 1, "A 只收到 B 的补丁");
    assert.equal(atB.length, 1, "B 只收到 A 的补丁");
    const ops = [...atB, ...atA].map((event) => event.patches[0].op);
    assert.equal(ops.some((op) => op.type === "replace"), false, "实时通道不允许整份文档覆盖");
    for (const op of ops) assert.equal(op.type, "update-node");
  } finally { f.fx.close(); }
});
