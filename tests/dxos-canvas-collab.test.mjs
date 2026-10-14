/**
 * B5c · 画布协作（本机 / 局域网语义；云同步 OUT）。
 * 被测：electron/canvas-dxos-collab.cjs（产品真实代码，全离线，不启动 WebSocket）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const collab = require("../electron/canvas-dxos-collab.cjs");

function hub(options = {}) {
  const delivered = [];
  const instance = new collab.CanvasCollabHub({
    authorize: options.authorize,
    onBroadcast: (delivery) => delivered.push(delivery),
    clock: options.clock,
    maxPeersPerRoom: options.maxPeersPerRoom,
    idleTimeoutMs: options.idleTimeoutMs,
  });
  return { hub: instance, delivered };
}

test("加入 / 在线 / 离开：presence 广播，空房删除", () => {
  const { hub: h, delivered } = hub();
  const a = h.join({ canvasId: "cv1", clientId: "c1", userId: "u1", username: "阿一" });
  assert.equal(a.ok, true);
  assert.equal(a.peer.userId, "u1");
  assert.equal(a.presence.users.length, 1);
  const b = h.join({ canvasId: "cv1", clientId: "c2", userId: "u2", username: "阿二", canEdit: true });
  assert.equal(b.ok, true);
  assert.equal(h.presence("cv1").users.length, 2);
  assert.ok(delivered.every((d) => d.type === "presence"));
  const left = h.leave({ canvasId: "cv1", clientId: "c1" });
  assert.equal(left.removed, true);
  assert.equal(left.presence.users.length, 1);
  assert.equal(h.liveRooms().length, 1);
  h.leave({ canvasId: "cv1", clientId: "c2" });
  assert.equal(h.liveRooms().length, 0, "空房必须删除");
});

test("同一个 clientId 重连是替换而不是堆人", () => {
  const { hub: h } = hub();
  h.join({ canvasId: "cv1", clientId: "c1", userId: "u1" });
  const again = h.join({ canvasId: "cv1", clientId: "c1", userId: "u1" });
  assert.equal(again.ok, true);
  assert.equal(h.presence("cv1").users.length, 1);
});

test("鉴权失败 / 参数缺失一律拒绝（源 canvasCollab.ts:48 的等价）", () => {
  const { hub: h } = hub({ authorize: ({ userId }) => userId !== "ghost" });
  assert.equal(h.join({ canvasId: "cv1", clientId: "c1", userId: "ghost" }).error, "FORBIDDEN");
  assert.equal(h.join({ canvasId: "", clientId: "c1", userId: "u1" }).error, "INVALID_INPUT");
  assert.equal(h.join({ canvasId: "cv1", clientId: "", userId: "u1" }).error, "INVALID_INPUT");
  assert.equal(h.presence("cv1").users.length, 0);
});

test("房间 / 成员上限：超限明确拒绝，不静默挤掉别人", () => {
  const { hub: h } = hub({ maxPeersPerRoom: 2 });
  h.join({ canvasId: "cv1", clientId: "c1", userId: "u1" });
  h.join({ canvasId: "cv1", clientId: "c2", userId: "u2" });
  const third = h.join({ canvasId: "cv1", clientId: "c3", userId: "u3" });
  assert.equal(third.ok, false);
  assert.equal(third.error, "LIMIT_EXCEEDED");
  assert.equal(h.presence("cv1").users.length, 2);
});

test("光标：有限坐标、只发给别人、限速（源 canvasCollab.ts:56-73）", () => {
  const { hub: h, delivered } = hub();
  h.join({ canvasId: "cv1", clientId: "c1", userId: "u1", username: "u1" });
  h.join({ canvasId: "cv1", clientId: "c2", userId: "u2", username: "u2" });
  assert.equal(h.cursor({ canvasId: "cv1", clientId: "c1", x: Number.NaN, y: 1 }).ok, false);
  assert.equal(h.cursor({ canvasId: "cv1", clientId: "c1", x: 1, y: "nope" }).ok, false);
  assert.equal(h.cursor({ canvasId: "cv1", clientId: "ghost", x: 1, y: 1 }).ok, false);
  const cursor = h.cursor({ canvasId: "cv1", clientId: "c1", x: 12.5, y: -3, nodeId: "n9" });
  assert.equal(cursor.ok, true);
  assert.deepEqual(cursor.message.to, ["c2"], "不能回给发起人");
  assert.equal(cursor.message.cardId, "n9");
  assert.equal(cursor.message.x, 12.5);
  let sent = 1;
  for (let i = 0; i < 200; i += 1) if (h.cursor({ canvasId: "cv1", clientId: "c1", x: i, y: i }).ok) sent += 1;
  assert.ok(sent <= collab.LIMITS.MAX_CURSOR_PER_SECOND, "光标必须限速，实测 " + sent);
});

test("补丁广播与冲突：基准版本落后时拒绝广播过期补丁", () => {
  const { hub: h, delivered } = hub();
  h.join({ canvasId: "cv1", clientId: "c1", userId: "u1" });
  h.join({ canvasId: "cv1", clientId: "c2", userId: "u2" });
  const stale = h.submitPatch({ canvasId: "cv1", clientId: "c1", baseRevision: 3, currentRevision: 4, payload: { upserts: [{ id: "n1" }] } });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "REVISION_CONFLICT");
  assert.equal(stale.detail.currentRevision, 4);
  assert.equal(delivered.filter((d) => d.type === "patch").length, 0, "冲突不得广播");
  const fresh = h.submitPatch({ canvasId: "cv1", clientId: "c1", baseRevision: 4, currentRevision: 4, payload: { upserts: [{ id: "n1" }] } });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.message.sourceClientId, "c1");
  assert.deepEqual(fresh.message.to, ["c2"]);
  assert.equal(fresh.message.revision, 4);
});

test("消息路由：畸形 JSON / 非 cursor 一律忽略，cursor 正常转发", () => {
  const { hub: h } = hub();
  h.join({ canvasId: "cv1", clientId: "c1", userId: "u1" });
  h.join({ canvasId: "cv1", clientId: "c2", userId: "u2" });
  assert.equal(h.handleMessage({ canvasId: "cv1", clientId: "c1", raw: "{oops" }), null);
  assert.equal(h.handleMessage({ canvasId: "cv1", clientId: "c1", raw: JSON.stringify({ type: "unknown" }) }), null);
  assert.equal(h.handleMessage({ canvasId: "cv1", clientId: "c1", raw: JSON.stringify({ type: "cursor", x: "bad", y: 1 }) }), null);
  const routed = h.handleMessage({ canvasId: "cv1", clientId: "c1", raw: JSON.stringify({ type: "cursor", x: 1, y: 2, cardId: "n1" }) });
  assert.equal(routed.type, "cursor");
  assert.equal(routed.cardId, "n1");
});

test("空闲清扫：超过 idleTimeoutMs 的会话被移除并广播 presence", () => {
  let now = 1000;
  const { hub: h, delivered } = hub({ clock: () => now, idleTimeoutMs: 5000 });
  h.join({ canvasId: "cv1", clientId: "c1", userId: "u1" });
  h.join({ canvasId: "cv1", clientId: "c2", userId: "u2" });
  now = 6500;
  h.heartbeat({ canvasId: "cv1", clientId: "c1" });
  now = 8000;
  const swept = h.sweepIdle(now);
  assert.equal(swept.removed.length, 1);
  assert.equal(swept.removed[0].clientId, "c2");
  assert.equal(h.presence("cv1").users.length, 1);
  assert.ok(delivered.some((d) => d.type === "presence" && d.users.length === 1));
});

test("节点补丁：diff / apply 拒绝 id 与不安全路径（源 shared/canvasCollaboration.ts:77-123）", () => {
  const base = { id: "n1", type: "image", x: 0, y: 0, url: "openarc-asset:a" };
  const current = { id: "n1", type: "image", x: 10, y: 0, url: "openarc-asset:b", name: "改名" };
  const patch = collab.diffCanvasNode(base, current);
  assert.ok(patch.set.some((operation) => operation.path.join(".") === "x"));
  assert.equal(patch.set.some((operation) => operation.path[0] === "id"), false);
  const applied = collab.applyCanvasNodePatch(base, patch);
  assert.equal(applied.x, 10);
  assert.equal(applied.name, "改名");
  assert.equal(applied.id, "n1");
  const hostile = collab.applyCanvasNodePatch(base, { id: "n1", set: [{ path: ["id"], value: "hacked" }, { path: ["__proto__", "polluted"], value: 1 }, { path: ["x"], value: 7 }], unset: [["type"]] });
  assert.equal(hostile.id, "n1");
  assert.equal(hostile.x, 7);
  // 源 :115/:118 只保护 id（普通字段可以被 unset），这里如实照做
  assert.equal(hostile.type, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(hostile, "__proto__"), false);
  assert.equal(collab.diffCanvasNode(base, { ...base }), null);
});

test("三方合并：本地未提交改动不被远端补丁覆盖（源 :125-138）", () => {
  const base = { id: "n1", x: 0, y: 0, text: "原始" };
  const local = { id: "n1", x: 5, y: 0, text: "本地改" };
  const remotePatch = { id: "n1", set: [{ path: ["x"], value: 99 }, { path: ["text"], value: "远端改" }], unset: [] };
  const merged = collab.applyCanvasNodePatchPreservingLocal(local, base, remotePatch);
  assert.equal(merged.x, 5, "本地已经改过的 x 必须保留");
  assert.equal(merged.text, "本地改", "本地改过的 text 必须保留");
  const other = collab.applyCanvasNodePatchPreservingLocal({ id: "n1", x: 0, y: 0, text: "原始" }, base, remotePatch);
  assert.equal(other.x, 99, "本地没动过 x → 接受远端");
});

test("保存回包对账：保留本地未提交差异，不静默丢内容（源 :140-167）", () => {
  const sent = { id: "n1", x: 1 };
  const server = { id: "n1", x: 2 };
  const live = { id: "n1", x: 3 };
  const result = collab.reconcileCanvasNodesAfterSave([server], [sent], [live]);
  assert.equal(result.length, 1);
  assert.equal(result[0].x, 3, "本地后来改动要叠在服务端版本上");
  const both = collab.reconcileCanvasNodesAfterSave([{ id: "a" }], [{ id: "a" }], [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(both.map((n) => n.id).sort(), ["a", "b"], "双方新增都要保留");
});
