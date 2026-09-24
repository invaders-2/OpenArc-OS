/**
 * D5-02 · 无限画布：命令层 / 版本检查 / 权限规则 / 账号隔离 / 资源引用（A08 / A28 / A38）。
 *
 * 这些用例跑的是**产品真实代码**（electron/canvas-domain.cjs + canvas-store.cjs + canvas-service.cjs），
 * 不是影子实现：画布页面的命令适配器与 AI 工具调用的是同一份领域逻辑。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createResourceFixture } from "./resource-fixtures.mjs";
import { CanvasStore } from "../electron/canvas-store.cjs";
import { CanvasService } from "../electron/canvas-service.cjs";

const require = (await import("node:module")).createRequire(import.meta.url);
const domain = require("../electron/canvas-domain.cjs");

async function fixture() {
  const fx = await createResourceFixture();
  const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const service = new CanvasService({ identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService, clock: fx.clock });
  const ctx = (key, extra = {}) => ({ sessionRef: fx.sessions[key], appId: "canvas", source: "ui", ...extra });
  const created = service.createCanvas({ context: ctx("admin"), title: "画布 A", icon: "🧩" });
  assert.equal(created.ok, true, JSON.stringify(created));
  return { fx, store, service, ctx, canvasId: created.canvas.canvasId };
}

test("D5-02 · 新建画布：空文档 + revision 1 + owner 可编辑", async () => {
  const f = await fixture();
  try {
    const got = f.service.getCanvas({ context: f.ctx("admin"), canvasId: f.canvasId });
    assert.equal(got.ok, true);
    assert.equal(got.canvas.revision, 1);
    assert.deepEqual(got.canvas.doc.nodes, []);
    assert.equal(got.canvas.access.canEdit, true);
    assert.ok(["OWNER_POLICY", "SUPER_ADMIN"].includes(got.canvas.access.source), got.canvas.access.source);
  } finally { f.fx.close(); }
});

test("D5-02 · 手工保存走版本检查：基准过期返回冲突并带回当前文档（不覆盖）", async () => {
  const f = await fixture();
  try {
    const doc1 = { nodes: [{ id: "n1", type: "prompt", x: 10, y: 20, text: "用户内容" }], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
    const saved = f.service.saveCanvas({ context: f.ctx("admin"), canvasId: f.canvasId, baseRevision: 1, doc: doc1 });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.canvas.revision, 2);
    // 用同一个（已过期的）基准再存一次 → 冲突，且返回当前文档
    const stale = f.service.saveCanvas({ context: f.ctx("admin"), canvasId: f.canvasId, baseRevision: 1, doc: { nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] } });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "REVISION_CONFLICT");
    assert.equal(stale.detail.canvas.revision, 2);
    assert.equal(stale.detail.canvas.doc.nodes.length, 1);
    assert.equal(stale.detail.canvas.doc.nodes[0].text, "用户内容");
  } finally { f.fx.close(); }
});

test("D5-02 · 命令层：add/move/connect/edit/delete/undo 都是同一条 reducer", async () => {
  const f = await fixture();
  try {
    const c = f.ctx("admin");
    const add1 = f.service.applyCommand({ context: c, canvasId: f.canvasId, baseRevision: 1, command: { type: "node.add", node: { id: "n1", type: "prompt", x: 0, y: 0, text: "a" } } });
    assert.equal(add1.ok, true, JSON.stringify(add1));
    const add2 = f.service.applyCommand({ context: c, canvasId: f.canvasId, baseRevision: add1.canvas.revision, command: { type: "node.add", node: { id: "n2", type: "image", x: 200, y: 0 } } });
    assert.equal(add2.ok, true);
    const link = f.service.applyCommand({ context: c, canvasId: f.canvasId, baseRevision: add2.canvas.revision, command: { type: "edge.connect", from: "n1", to: "n2" } });
    assert.equal(link.ok, true, JSON.stringify(link));
    assert.equal(link.canvas.doc.connections.length, 1);
    const moved = f.service.applyCommand({ context: c, canvasId: f.canvasId, baseRevision: link.canvas.revision, command: { type: "node.move", id: "n2", x: 320, y: 40 } });
    assert.equal(moved.ok, true);
    assert.deepEqual([moved.canvas.doc.nodes.find((n) => n.id === "n2").x, moved.canvas.doc.nodes.find((n) => n.id === "n2").y], [320, 40]);
    const edited = f.service.applyCommand({ context: c, canvasId: f.canvasId, baseRevision: moved.canvas.revision, command: { type: "node.edit", id: "n2", patch: { url: "openarc-asset:res_x" } } });
    assert.equal(edited.ok, true);
    const del = f.service.applyCommand({ context: c, canvasId: f.canvasId, baseRevision: edited.canvas.revision, command: { type: "node.delete", id: "n2" } });
    assert.equal(del.ok, true);
    assert.equal(del.canvas.doc.nodes.length, 1);
    assert.equal(del.canvas.doc.connections.length, 0, "删节点必须同时清掉连线");
    // 非法命令：未知类型 / patch 里改 id 或 type / 自连边
    for (const bad of [
      { type: "node.explode", id: "n1" },
      { type: "node.edit", id: "n1", patch: { id: "n9" } },
      { type: "node.edit", id: "n1", patch: { type: "video" } },
      { type: "edge.connect", from: "n1", to: "n1" },
      { type: "node.delete", id: "nope" },
    ]) {
      const res = f.service.applyCommand({ context: c, canvasId: f.canvasId, baseRevision: del.canvas.revision, command: bad });
      assert.equal(res.ok, false, "非法命令必须被拒：" + JSON.stringify(bad));
    }
    // 撤销记录：上一条已应用命令可以撤销回旧文档
    const before = f.service.getCanvas({ context: c, canvasId: f.canvasId }).canvas;
    const undone = f.service.undoLastCommand({ context: c, canvasId: f.canvasId, baseRevision: before.revision });
    assert.equal(undone.ok, true, JSON.stringify(undone));
    assert.equal(undone.canvas.doc.nodes.length, 2, "撤销回删节点之前");
    const log = f.service.commandLog({ context: c, canvasId: f.canvasId });
    assert.equal(log.ok, true);
    assert.ok(log.items.length >= 1);
  } finally { f.fx.close(); }
});

test("D5-02 · A38：AI 用过期基准改同一节点 → 冲突，用户内容保留", async () => {
  const f = await fixture();
  try {
    const c = f.ctx("admin");
    const a = f.service.applyCommand({ context: c, canvasId: f.canvasId, baseRevision: 1, command: { type: "node.add", node: { id: "n1", type: "prompt", x: 0, y: 0, text: "原始" } } });
    assert.equal(a.ok, true);
    const baseForAgent = a.canvas.revision;
    // 用户先手工改了同一个节点
    const b = f.service.applyCommand({ context: c, canvasId: f.canvasId, baseRevision: baseForAgent, command: { type: "node.edit", id: "n1", patch: { text: "用户的手工修改" } } });
    assert.equal(b.ok, true);
    // AI 基于旧基准提交
    const agent = f.service.applyCommand({ context: c, canvasId: f.canvasId, baseRevision: baseForAgent, command: { type: "node.edit", id: "n1", patch: { text: "AI 的修改" } }, actorKind: "AGENT" });
    assert.equal(agent.ok, false);
    assert.equal(agent.error, "REVISION_CONFLICT");
    const now = f.service.getCanvas({ context: c, canvasId: f.canvasId }).canvas;
    assert.equal(now.doc.nodes[0].text, "用户的手工修改", "冲突时绝不覆盖用户内容");
    // AI 用当前基准重试 → 成功
    const retry = f.service.applyCommand({ context: c, canvasId: f.canvasId, baseRevision: now.revision, command: { type: "node.edit", id: "n1", patch: { text: "AI 的修改" } }, actorKind: "AGENT" });
    assert.equal(retry.ok, true, JSON.stringify(retry));
  } finally { f.fx.close(); }
});

test("D5-02 · A28：只读成员的手工保存与 AI 命令都被同一条权限规则拒绝", async () => {
  const f = await fixture();
  try {
    const owner = f.ctx("admin");
    const alice = f.ctx("alice");
    const shared = f.service.shareCanvas({ context: owner, canvasId: f.canvasId, userId: f.fx.users.alice, role: "VIEWER" });
    assert.equal(shared.ok, true, JSON.stringify(shared));
    const seen = f.service.getCanvas({ context: alice, canvasId: f.canvasId });
    assert.equal(seen.ok, true, "被共享的只读成员可以打开");
    assert.equal(seen.canvas.access.canEdit, false);
    assert.equal(seen.canvas.access.source, "SHARE_VIEWER");
    // 手工路径（保存）
    const manual = f.service.saveCanvas({ context: alice, canvasId: f.canvasId, baseRevision: 1, doc: { nodes: [{ id: "x", type: "prompt", x: 0, y: 0 }], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] } });
    assert.equal(manual.ok, false);
    assert.equal(manual.error, "READ_ONLY");
    // AI 路径（命令）
    const ai = f.service.applyCommand({ context: alice, canvasId: f.canvasId, baseRevision: 1, command: { type: "node.add", node: { id: "y", type: "prompt", x: 0, y: 0 } }, actorKind: "AGENT" });
    assert.equal(ai.ok, false);
    assert.equal(ai.error, "READ_ONLY");
    // 撤销路径同样被拒（不是"只挡两个入口"）
    const undo = f.service.undoLastCommand({ context: alice, canvasId: f.canvasId });
    assert.equal(undo.ok, false);
    assert.equal(undo.error, "READ_ONLY");
    const after = f.service.getCanvas({ context: owner, canvasId: f.canvasId });
    assert.equal(after.canvas.doc.nodes.length, 0, "只读成员没有改到任何东西");
  } finally { f.fx.close(); }
});

test("D5-02 · 账号隔离：未共享的账号既看不到也打不开别人的画布", async () => {
  const f = await fixture();
  try {
    const dana = f.ctx("dana");
    const got = f.service.getCanvas({ context: dana, canvasId: f.canvasId });
    assert.equal(got.ok, false);
    assert.ok(["NOT_FOUND", "NOT_FOUND_OR_FORBIDDEN"].includes(got.error), got.error);
    const list = f.service.listCanvases({ context: dana });
    assert.equal(list.ok, true);
    assert.equal(list.items.some((c) => c.canvasId === f.canvasId), false);
    // 只读成员列表里能看到（access.canEdit=false）
    f.service.shareCanvas({ context: f.ctx("admin"), canvasId: f.canvasId, userId: f.fx.users.dana, role: "VIEWER" });
    const list2 = f.service.listCanvases({ context: dana });
    const item = list2.items.find((c) => c.canvasId === f.canvasId);
    assert.ok(item);
    assert.equal(item.access.canEdit, false);
    // 另一个组织的人一律看不到
    const bob = f.service.getCanvas({ context: f.ctx("bob"), canvasId: f.canvasId });
    assert.equal(bob.ok, false);
  } finally { f.fx.close(); }
});

test("D5-02 · A08：资源引用用稳定 ref —— 重命名仍可用，删除后明确不可用", async () => {
  const f = await fixture();
  try {
    const c = f.ctx("admin");
    // 资源由资源库应用创建（画布应用只有 READ 基线）；画布只持有稳定 ref。
    const r = await f.fx.resourceService.createResource({ context: f.ctx("admin", { appId: "resource-library" }), resourceType: "text", name: "参考文件", content: "素材内容" });
    assert.equal(r.ok, true, JSON.stringify(r));
    const ref = r.resource.resourceId;
    const url = "openarc-asset:" + ref;
    const add = f.service.applyCommand({ context: c, canvasId: f.canvasId, baseRevision: 1, command: { type: "node.add", node: { id: "n1", type: "image", x: 0, y: 0, url } } });
    assert.equal(add.ok, true);
    const s1 = f.service.assetStates({ context: c, refs: [ref] });
    assert.equal(s1.exists[ref].state, "AVAILABLE");
    // 重命名：ref 不变 → 画布引用仍然可用
    // 重命名在资源库里做（画布应用没有 edit 权限；重命名不该影响画布引用）
    const renamed = f.fx.resourceService.updateMetadata({ context: f.ctx("admin", { appId: "resource-library" }), resourceRef: ref, name: "改名后的文件" });
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    const s2 = f.service.assetStates({ context: c, refs: [ref] });
    assert.equal(s2.exists[ref].state, "AVAILABLE");
    assert.equal(s2.exists[ref].name, "改名后的文件");
    // 删除（进回收站）→ 明确不可用（不是"悄悄变空"）
    f.fx.resourceService.delete({ context: f.ctx("admin", { appId: "resource-library" }), resourceRef: ref });
    const s3 = f.service.assetStates({ context: c, refs: [ref] });
    assert.equal(s3.exists[ref].state, "UNAVAILABLE");
    // 画布文档里的 url 仍然是稳定 ref（不是路径、不是副本）
    const doc = f.service.getCanvas({ context: c, canvasId: f.canvasId }).canvas.doc;
    assert.equal(doc.nodes[0].url, url);
  } finally { f.fx.close(); }
});

test("D5-02 · F3b：关窗重开后宿主按当前用户逐资源解析 openarc-asset:（本人可用 / 他人仍拒 / 删除后不复活）", async () => {
  const f = await fixture();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d5-02-imports-"));
  try {
    // 与产品装配一致：画布服务拿到的是同一个 resourceService 实例（identity-bootstrap.cjs:78-84）。
    const service = new CanvasService({
      identity: f.fx.identity, store: f.store, resourceStore: f.fx.resourceStore,
      authService: f.fx.authService, resourceService: f.fx.resourceService, clock: f.fx.clock,
    });
    service.attachRuntime({ tempDir });
    const c = f.ctx("admin");
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=";
    // 1) 与画布页面同一条导入路径（内部以 resource-library 身份、PERSONAL scope 入库）
    const imported = await service.importAsset({ context: c, canvasId: f.canvasId, name: "d502-asset.png", dataUrl: "data:image/png;base64," + PNG });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    const ref = String(imported.ref).replace("openarc-asset:", "");
    assert.ok(ref.length > 0, "导入必须返回稳定 ResourceRef");
    // 2) 文档里只存稳定 ref（不存 data URL / 路径）
    const add = service.applyCommand({ context: c, canvasId: f.canvasId, baseRevision: 1, command: { type: "node.add", node: { id: "n_img", type: "image", x: 0, y: 0, url: imported.ref } } });
    assert.equal(add.ok, true, JSON.stringify(add));
    assert.equal(service.getCanvas({ context: c, canvasId: f.canvasId }).canvas.doc.nodes[0].url, imported.ref);
    // 3) 重开画布时宿主做的就是这件事：ref → data URL（逐资源授权 + 受控读取）
    const read = service.readAsset({ context: c, ref });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.ok(String(read.dataUrl).startsWith("data:image/png;base64,"), String(read.dataUrl).slice(0, 30));
    // 4) 同组织、非本人的 PERSONAL 资源仍然被拒（修 F3b 不放宽授权）
    const danaCtx = { sessionRef: f.fx.sessions.dana, appId: "canvas", source: "ui" };
    const cross = service.readAsset({ context: danaCtx, ref });
    assert.equal(cross.ok, false);
    assert.equal(cross.error, "ASSET_FORBIDDEN");
    assert.equal(service.assetStates({ context: danaCtx, refs: [ref] }).exists[ref].state, "UNAUTHORIZED");
    // 5) 删除后重开：明确不可用，旧内容不复活
    f.fx.resourceService.delete({ context: f.fx.ctx("admin"), resourceRef: ref });
    assert.equal(service.readAsset({ context: c, ref }).ok, false);
    assert.notEqual(service.assetStates({ context: c, refs: [ref] }).exists[ref].state, "AVAILABLE");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    f.fx.close();
  }
});

test("D5-02 · 领域层：AI 命令白名单不含 undo/redo（撤销走账本，不走 AI）", async () => {
  assert.deepEqual([...domain.AGENT_COMMANDS].sort(), ["edge.connect", "edge.disconnect", "node.add", "node.copy", "node.delete", "node.edit", "node.group", "node.move"]);
  const norm = domain.normalizeCommand({ type: "node.patch", id: "x" });
  assert.equal(norm.ok, false);
  assert.equal(norm.reason, "UNSUPPORTED_COMMAND");
});
