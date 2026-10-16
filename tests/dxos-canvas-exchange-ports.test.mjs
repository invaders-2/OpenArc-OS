/**
 * canvas × photos / app-exchange 端口适配层回归测试（全离线：真实 CanvasService / ResourceService /
 * CanvasAssetLibraryService / dxos-fs，临时 userData + :memory: SQLite，不启动 Electron、不联网）。
 *
 * 覆盖任务书验收条目：
 *   ① createCanvasCard 真的在画布文档里加一个 image 节点，url 是 openarc-asset 引用；字节不进文档
 *   ② 节点数超限（canvas-domain.LIMITS.NODES=2000）被拒且文档不变
 *   ③ 无编辑权限（只读共享成员）被拒
 *   ④ findNearestCanvasPlacement 不与既有节点重叠
 *   ⑤ importImage→canvas 返回 cardId；importImage→library 返回 itemId / 结构化不可用
 *   ⑥ app-exchange canvas target 端到端：字节已在资源域时 fs 节点可同步解析为 openarc-asset 并落卡片
 *   ⑦ fs-only 字节（资源域没有）→ 结构化 APP_EXCHANGE_DEPENDENCY_UNAVAILABLE（不假实现）
 *   附加：canRead 共享区可见性、canViewCanvasMedia、syncCanvas upsert 不重复加节点。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createCanvasExchangePorts, findNearestCanvasPlacement, ASSET_REF_RE } = require("../electron/canvas-exchange-ports.cjs");
const { CanvasStore } = require("../electron/canvas-store.cjs");
const { CanvasService } = require("../electron/canvas-service.cjs");
const { CanvasDxosStore } = require("../electron/canvas-dxos-store.cjs");
const { CanvasAssetLibraryService } = require("../electron/canvas-dxos-asset-library.cjs");
const { createDxosFs } = require("../electron/dxos-fs.cjs");
const { createAppExchangeBundle } = require("../electron/app-exchange-service.cjs");
const { DatabaseSync } = require("node:sqlite");
const schema = require("../electron/dxos-foundation-schema.cjs");
const photosDomain = require("../electron/photos-domain.cjs");
const appExchangeDomain = require("../electron/app-exchange-domain.cjs");

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

const tmpDirs = [];
after(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

const canvasCtx = (fx, key) => ({ sessionRef: fx.sessions[key], appId: "canvas", source: "ui" });
const viewer = (fx, key) => ({ id: fx.users[key], role: key === "admin" ? "ADMIN" : "member", team_id: key === "bob" ? fx.foreignOrgId : fx.orgId });
const viewDoc = (f, canvasId) => f.canvasService.getCanvas({ context: canvasCtx(f.fx, "admin"), canvasId });

async function fixture() {
  const fx = await createResourceFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-exchange-"));
  tmpDirs.push(root);
  const canvasStore = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const canvasService = new CanvasService({ identity: fx.identity, store: canvasStore, resourceStore: fx.resourceStore, resourceService: fx.resourceService, authService: fx.authService, clock: fx.clock });
  canvasService.attachRuntime({ tempDir: () => path.join(root, "canvas-imports") });
  fs.mkdirSync(path.join(root, "canvas-imports"), { recursive: true });
  const dxosStore = new CanvasDxosStore({ identity: fx.identity, clock: fx.clock });
  const assetLibrary = new CanvasAssetLibraryService({ identity: fx.identity, store: dxosStore, resourceService: fx.resourceService, resourceStore: fx.resourceStore, canvasService, clock: fx.clock, tempDir: () => path.join(root, "asset-library") });
  const fsStore = createDxosFs({ userDataDir: root });
  const adapters = {};
  for (const key of ["admin", "alice", "bob"]) {
    adapters[key] = createCanvasExchangePorts({
      canvasService, assetLibrary, resourceService: fx.resourceService, resourceStore: fx.resourceStore,
      canvasDxosStore: dxosStore, fsStore, sessionRef: () => fx.sessions[key],
    });
  }
  const createCanvas = (key, title = "画布") => canvasService.createCanvas({ context: canvasCtx(fx, key), title });
  return { fx, root, canvasStore, canvasService, dxosStore, assetLibrary, fsStore, adapters, createCanvas };
}

// ---------------------------------------------------------------------------
// ④ 纯几何
// ---------------------------------------------------------------------------

test("findNearestCanvasPlacement：无占用回 desired；有占用回不重叠落点", () => {
  assert.deepEqual(findNearestCanvasPlacement({ desired: { x: 10, y: 20 }, size: { w: 100, h: 50 }, occupied: [] }), { x: 10, y: 20 });
  const desired = { x: 480, y: 300 };
  const size = { w: 300, h: 200 };
  const occupied = [{ x: 480, y: 300, w: 300, h: 200 }];
  const placed = findNearestCanvasPlacement({ desired, size, occupied });
  assert.notDeepEqual(placed, desired);
  const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.equal(intersects({ ...placed, ...size }, occupied[0]), false, "落点不得与既有节点重叠");
  assert.equal(Number.isInteger(placed.x) && Number.isInteger(placed.y), true);
});

// ---------------------------------------------------------------------------
// ① createCanvasCard 落节点 + 只存引用
// ---------------------------------------------------------------------------

test("createCanvasCard：真的加一个 image 节点，url 是 openarc-asset，字节/URL 不进文档", async () => {
  const f = await fixture();
  try {
    const created = f.createCanvas("admin");
    const canvasId = created.canvas.canvasId;
    const adapter = f.adapters.admin;
    const canvas = adapter.ports.getCanvas(canvasId, viewer(f.fx, "admin"));
    assert.equal(canvas.id, canvasId);
    assert.equal(canvas.access.canEdit, true);
    assert.deepEqual(canvas.cards, []);

    const card = adapter.ports.createCanvasCard(0, 0, {
      title: "导入图", w: 300, h: 200,
      url: "openarc-asset:res_demo",
      inputs: [{ nodeId: "fs-1", name: "a.png", url: "/api/fs/raw/fs-1", kind: "image", role: "input", w: 4, h: 4 }],
      params: { mode: "i2i", protocolParams: { mediaManualSize: true, mediaFrameLocked: true } },
    });
    assert.match(card.id, /^card_/);
    assert.equal(card.url, "openarc-asset:res_demo");
    assert.equal(ASSET_REF_RE.test(card.url), true);

    const view = viewDoc(f, canvasId);
    const node = view.canvas.doc.nodes.find((item) => item.id === card.id);
    assert.ok(node, "画布文档必须有这张卡片");
    assert.equal(node.type, "image");
    assert.equal(node.url, "openarc-asset:res_demo");
    assert.deepEqual(node.refs, ["openarc-asset:res_demo"]);
    assert.equal(node.inputs[0].url, "openarc-asset:res_demo", "inputs 的媒体地址也必须重写成资源引用");

    const serialized = JSON.stringify(view.canvas.doc);
    assert.equal(serialized.includes(PNG_BASE64), false);
    assert.equal(/data:image/i.test(serialized), false);
    assert.equal(serialized.includes("/api/fs/raw/"), false, "非 openarc-asset 的媒体地址不得进文档");
  } finally {
    f.fx.close();
  }
});

// ---------------------------------------------------------------------------
// ② 节点数超限
// ---------------------------------------------------------------------------

test("节点数超限被拒：2000 节点上限命中即结构化拒绝，文档不变", async () => {
  const f = await fixture();
  try {
    const created = f.createCanvas("admin");
    const canvasId = created.canvas.canvasId;
    const nodes = Array.from({ length: 2000 }, (_, index) => ({ id: "n" + index, type: "prompt", x: index % 50, y: Math.floor(index / 50) }));
    const saved = f.canvasService.saveCanvas({ context: canvasCtx(f.fx, "admin"), canvasId, baseRevision: 1, doc: { nodes, connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] } });
    assert.equal(saved.ok, true, JSON.stringify(saved));

    f.adapters.admin.ports.getCanvas(canvasId, viewer(f.fx, "admin"));
    assert.throws(
      () => f.adapters.admin.ports.createCanvasCard(0, 0, { canvasId, url: "openarc-asset:res_x" }),
      (error) => error.code === "DXOS_ERR_QUOTA_EXCEEDED" && error.detail.reason === "LIMIT_EXCEEDED",
    );
    assert.equal(viewDoc(f, canvasId).canvas.doc.nodes.length, 2000, "被拒后文档不得变化");
  } finally {
    f.fx.close();
  }
});

// ---------------------------------------------------------------------------
// ③ 无编辑权限
// ---------------------------------------------------------------------------

test("无编辑权限被拒：只读共享成员 createCanvasCard / syncCanvas 都拒绝", async () => {
  const f = await fixture();
  try {
    const created = f.createCanvas("admin");
    const canvasId = created.canvas.canvasId;
    const shared = f.canvasService.shareCanvas({ context: canvasCtx(f.fx, "admin"), canvasId, userId: f.fx.users.alice, role: "VIEWER" });
    assert.equal(shared.ok, true, JSON.stringify(shared));

    const canvas = f.adapters.alice.ports.getCanvas(canvasId, viewer(f.fx, "alice"));
    assert.equal(canvas.access.canEdit, false);
    assert.equal(canvas.access.canView, true);
    assert.equal(f.adapters.alice.ports.canEditCanvas(canvasId, viewer(f.fx, "alice")), false);
    assert.equal(f.adapters.admin.ports.canEditCanvas(canvasId, viewer(f.fx, "admin")), true);

    assert.throws(
      () => f.adapters.alice.ports.createCanvasCard(0, 0, { canvasId, url: "openarc-asset:res_x" }),
      (error) => error.code === appExchangeDomain.APP_EXCHANGE_ERR_FORBIDDEN,
    );
    assert.throws(
      () => f.adapters.alice.ports.syncCanvas(canvasId, viewer(f.fx, "alice"), { upserts: [{ id: "c1", x: 1, y: 1 }] }),
      (error) => error.code === appExchangeDomain.APP_EXCHANGE_ERR_FORBIDDEN,
    );
    assert.equal(viewDoc(f, canvasId).canvas.doc.nodes.length, 0);
  } finally {
    f.fx.close();
  }
});

// ---------------------------------------------------------------------------
// syncCanvas upsert
// ---------------------------------------------------------------------------

test("syncCanvas：已有卡片走 node.edit 更新位置，不重复加节点", async () => {
  const f = await fixture();
  try {
    const created = f.createCanvas("admin");
    const canvasId = created.canvas.canvasId;
    const adapter = f.adapters.admin;
    adapter.ports.getCanvas(canvasId, viewer(f.fx, "admin"));
    const card = adapter.ports.createCanvasCard(0, 0, { canvasId, w: 100, h: 50, url: "openarc-asset:res_a" });
    const placed = adapter.ports.findNearestCanvasPlacement({ desired: { x: 480, y: 300 }, size: { w: 100, h: 50 }, occupied: [{ x: 480, y: 300, w: 100, h: 50 }] });
    Object.assign(card, placed);
    const saved = adapter.ports.syncCanvas(canvasId, viewer(f.fx, "admin"), { upserts: [card] });
    assert.ok(saved.version >= 2, JSON.stringify(saved));
    assert.equal(saved.version, saved.revision);

    const doc = viewDoc(f, canvasId).canvas.doc;
    assert.equal(doc.nodes.length, 1, "upsert 不得重复加节点");
    assert.deepEqual([doc.nodes[0].x, doc.nodes[0].y], [placed.x, placed.y]);
  } finally {
    f.fx.close();
  }
});

// ---------------------------------------------------------------------------
// ⑦ fs-only 字节 → 结构化依赖不可用（不假实现）
// ---------------------------------------------------------------------------

test("createCanvasCard：fs-only 字节无法同步解析为资源引用 → 结构化依赖不可用（指明缺什么）", async () => {
  const f = await fixture();
  try {
    const created = f.createCanvas("admin");
    const canvasId = created.canvas.canvasId;
    f.adapters.admin.ports.getCanvas(canvasId, viewer(f.fx, "admin"));
    const node = f.fsStore.createNode({ name: "raw.png", type: "file", parentId: null, mime: "image/png", size: 4, ownerId: f.fx.users.admin });
    f.fsStore.saveBlob(node.id, Buffer.from("nnnn"));
    assert.throws(
      () => f.adapters.admin.ports.createCanvasCard(0, 0, { canvasId, inputs: [{ nodeId: node.id, url: "/api/fs/raw/" + node.id, name: "raw.png", kind: "image" }] }),
      (error) => error.code === appExchangeDomain.APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE
        && error.detail.dependency === "createCanvasCard"
        && error.detail.missing === "fs-node-to-ResourceRef",
    );
    assert.equal(viewDoc(f, canvasId).canvas.doc.nodes.length, 0, "解析失败不得留半个产物");
  } finally {
    f.fx.close();
  }
});

// ---------------------------------------------------------------------------
// ⑤ photos importer
// ---------------------------------------------------------------------------

test("importer→canvas：字节落资源域，画布加 image 节点并回 cardId（文档只有引用）", async () => {
  const f = await fixture();
  try {
    const created = f.createCanvas("admin");
    const canvasId = created.canvas.canvasId;
    const result = await f.adapters.admin.importer({
      userId: f.fx.users.admin, user: viewer(f.fx, "admin"), destination: "canvas", targetId: canvasId,
      name: "照片.png", mime: "image/png", data: PNG_BYTES, sourceId: "local:s1:a.png", prompt: "一张图",
    });
    assert.ok(result.cardId, JSON.stringify(result));

    const view = viewDoc(f, canvasId);
    const node = view.canvas.doc.nodes.find((item) => item.id === result.cardId);
    assert.ok(node, "画布必须有导入的节点");
    assert.equal(node.type, "image");
    assert.match(node.url, /^openarc-asset:res_/);
    assert.deepEqual(node.refs, [node.url]);

    const serialized = JSON.stringify(view.canvas.doc);
    assert.equal(serialized.includes(PNG_BASE64), false);
    assert.equal(/data:image/i.test(serialized), false);

    const resourceId = node.url.slice("openarc-asset:".length);
    const roundTrip = f.fx.resourceService.readDataUrl({ context: { sessionRef: f.fx.sessions.admin, appId: "resource-library" }, resourceRef: resourceId });
    assert.equal(roundTrip.ok, true, JSON.stringify(roundTrip));
    assert.equal(roundTrip.dataUrl, "data:image/png;base64," + PNG_BASE64, "资源域确有这份字节");
  } finally {
    f.fx.close();
  }
});

test("importer→library：复用素材库 checksum 去重回 itemId；未装素材库即结构化不可用", async () => {
  const f = await fixture();
  try {
    const library = f.assetLibrary.ensureDefaultLibrary({ context: canvasCtx(f.fx, "admin") }).library;
    const first = await f.adapters.admin.importer({ userId: f.fx.users.admin, user: viewer(f.fx, "admin"), destination: "library", targetId: library.id, name: "素材.png", mime: "image/png", data: PNG_BYTES });
    assert.match(first.itemId, /^cai_/);
    const second = await f.adapters.admin.importer({ userId: f.fx.users.admin, user: viewer(f.fx, "admin"), destination: "library", targetId: library.id, name: "素材副本.png", mime: "image/png", data: PNG_BYTES });
    assert.equal(second.itemId, first.itemId, "同字节同库必须复用同一条目");

    const bare = createCanvasExchangePorts({ canvasService: f.canvasService, sessionRef: () => f.fx.sessions.admin });
    await assert.rejects(
      () => bare.importer({ userId: f.fx.users.admin, user: viewer(f.fx, "admin"), destination: "library", targetId: library.id, name: "x.png", mime: "image/png", data: PNG_BYTES }),
      (error) => error.code === photosDomain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE && error.detail.dependency === "assetLibrary",
    );
    await assert.rejects(
      () => bare.importer({ userId: f.fx.users.admin, user: viewer(f.fx, "admin"), destination: "cloud", targetId: library.id, name: "x.png", mime: "image/png", data: PNG_BYTES }),
      (error) => error.code === photosDomain.PHOTOS_ERR_INVALID_INPUT,
    );
  } finally {
    f.fx.close();
  }
});

// ---------------------------------------------------------------------------
// canRead / canViewCanvasMedia
// ---------------------------------------------------------------------------

test("canRead：owner 可读，他人私有不可读，公共区/部门区按既有共享区语义判定", async () => {
  const f = await fixture();
  try {
    const admin = f.fx.users.admin;
    const mine = f.fsStore.createNode({ name: "a.png", type: "file", parentId: null, mime: "image/png", size: 1, ownerId: admin });
    assert.equal(f.adapters.admin.ports.canRead(viewer(f.fx, "admin"), f.fsStore.getNode(mine.id)), true);
    assert.equal(f.adapters.alice.ports.canRead(viewer(f.fx, "alice"), f.fsStore.getNode(mine.id)), false);

    const publicRoot = f.fsStore.ensurePublicRoot();
    const inPublic = f.fsStore.createNode({ name: "p.png", type: "file", parentId: publicRoot.id, mime: "image/png", size: 1, ownerId: admin });
    assert.equal(f.adapters.alice.ports.canRead(viewer(f.fx, "alice"), f.fsStore.getNode(inPublic.id)), true);

    const deptRoot = f.fsStore.ensureDepartmentRoot("dept-x", "设计");
    const inDept = f.fsStore.createNode({ name: "d.png", type: "file", parentId: deptRoot.id, mime: "image/png", size: 1, ownerId: admin });
    assert.equal(f.adapters.alice.ports.canRead({ id: f.fx.users.alice, team_id: "dept-x" }, f.fsStore.getNode(inDept.id)), true);
    assert.equal(f.adapters.alice.ports.canRead({ id: f.fx.users.alice, team_id: "other" }, f.fsStore.getNode(inDept.id)), false);
  } finally {
    f.fx.close();
  }
});

test("canViewCanvasMedia：按既有画布访问判定，只读成员可见，跨组织不可见", async () => {
  const f = await fixture();
  try {
    const created = f.createCanvas("admin");
    const canvasId = created.canvas.canvasId;
    f.canvasService.shareCanvas({ context: canvasCtx(f.fx, "admin"), canvasId, userId: f.fx.users.alice, role: "VIEWER" });
    assert.equal(f.adapters.admin.ports.canViewCanvasMedia("n1", viewer(f.fx, "admin"), canvasId), true);
    assert.equal(f.adapters.alice.ports.canViewCanvasMedia("n1", viewer(f.fx, "alice"), canvasId), true);
    assert.equal(f.adapters.bob.ports.canViewCanvasMedia("n1", viewer(f.fx, "bob"), canvasId), false);
  } finally {
    f.fx.close();
  }
});

// ---------------------------------------------------------------------------
// ⑥ app-exchange canvas target 端到端（字节已在资源域 → 可同步解析）
// ---------------------------------------------------------------------------

function newDb() {
  const db = new DatabaseSync(":memory:");
  for (const statement of schema.dxosDdl()) db.exec(statement);
  return db;
}

function fakeSharpLoader(metadata = { width: 4, height: 4, format: "png", pages: 1 }) {
  return () => () => ({ metadata: async () => ({ ...metadata }) });
}

test("app-exchange canvas target：资源域已有字节时端到端落卡片（cardId + openarc-asset url，无字节）", async () => {
  const f = await fixture();
  const db = newDb();
  try {
    const created = f.createCanvas("admin");
    const canvasId = created.canvas.canvasId;

    const sourcePath = path.join(f.root, "src.png");
    fs.writeFileSync(sourcePath, PNG_BYTES);
    const imported = await f.fx.resourceService.importManaged({ context: { sessionRef: f.fx.sessions.admin, appId: "resource-library" }, sourcePath, name: "src.png", resourceType: "image", mimeType: "image/png", scope: "PERSONAL" });
    assert.equal(imported.ok, true, JSON.stringify(imported));

    const root = f.fsStore.ensureCanvasRoot(f.fx.users.admin);
    const sourceNode = f.fsStore.createNode({ name: "src.png", type: "file", parentId: root.id, mime: "image/png", size: PNG_BYTES.length, ownerId: f.fx.users.admin });
    f.fsStore.saveBlob(sourceNode.id, PNG_BYTES);

    const state = { changed: [] };
    const bundle = createAppExchangeBundle({
      db,
      authorization: { resolveActor: () => ({ ok: true, user: viewer(f.fx, "admin"), organizationId: f.fx.orgId }) },
      ports: {
        ...f.adapters.admin.ports,
        getNode: (id) => f.fsStore.getNode(id),
        isInTrash: (id) => f.fsStore.isInTrash(id),
        readBlob: (id) => f.fsStore.readBlob(id),
        saveBlob: (id, bytes) => f.fsStore.saveBlob(id, bytes),
        createNode: (input) => f.fsStore.createNode(input),
        purgeNode: (id) => f.fsStore.purgeNode(id),
        ensureCanvasRoot: (ownerId) => f.fsStore.ensureCanvasRoot(ownerId),
        ensureFolder: (name, parentId, ownerId) => f.fsStore.ensureFolder(name, parentId, ownerId),
        canOpen: () => true,
        listCanvases: () => [{ id: canvasId, title: "画布", access: "write" }],
        createPhotoCraftProject: null,
        canViewPhotoCraftFile: null,
        changed: (id, patch) => state.changed.push({ id, patch }),
        sharpLoader: fakeSharpLoader(),
      },
    });
    const res = await bundle.execute("appExchange/exchange", {
      requestId: "req-canvas-1",
      target: { appId: "canvas", action: "image.import", projectId: canvasId },
      asset: { nodeId: sourceNode.id },
    }, { sessionRef: f.fx.sessions.admin, appId: "app-exchange" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.value.status, "completed");
    assert.equal(res.value.target.appId, "canvas");
    assert.equal(res.value.target.projectId, canvasId);
    assert.ok(res.value.target.cardId, "canvas target 必须回 cardId");

    const view = viewDoc(f, canvasId);
    const node = view.canvas.doc.nodes.find((item) => item.id === res.value.target.cardId);
    assert.ok(node, "画布文档必须有互传落下的卡片");
    assert.equal(node.type, "image");
    assert.match(node.url, /^openarc-asset:res_/);
    assert.equal(ASSET_REF_RE.test(node.url), true);
    const serialized = JSON.stringify(view.canvas.doc);
    assert.equal(serialized.includes(PNG_BASE64), false);
    assert.equal(/data:image/i.test(serialized), false);
    assert.equal(state.changed.length, 1);
    assert.equal(state.changed[0].id, canvasId);
  } finally {
    try { db.close(); } catch { /* ignore */ }
    f.fx.close();
  }
});

// ---------------------------------------------------------------------------
// ⑦→修复：fs-only 字节经 async resolveCanvasRef 端到端可用
// ---------------------------------------------------------------------------

test("resolveCanvasRef：fs-only 字节导入资源域回 openarc-asset 引用；再次解析复用同一资源", async () => {
  const f = await fixture();
  try {
    const created = f.createCanvas("admin");
    const canvasId = created.canvas.canvasId;
    const adapter = f.adapters.admin;
    adapter.ports.getCanvas(canvasId, viewer(f.fx, "admin"));
    const node = f.fsStore.createNode({ name: "raw.png", type: "file", parentId: null, mime: "image/png", size: PNG_BYTES.length, ownerId: f.fx.users.admin });
    f.fsStore.saveBlob(node.id, PNG_BYTES);

    const ref = await adapter.ports.resolveCanvasRef({ nodeId: node.id, name: "raw.png", mime: "image/png", canvasId });
    assert.match(ref, /^openarc-asset:res_/);
    assert.equal(ASSET_REF_RE.test(ref), true);
    const roundTrip = f.fx.resourceService.readDataUrl({ context: { sessionRef: f.fx.sessions.admin, appId: "resource-library" }, resourceRef: ref.slice("openarc-asset:".length) });
    assert.equal(roundTrip.ok, true, JSON.stringify(roundTrip));
    assert.equal(roundTrip.dataUrl, "data:image/png;base64," + PNG_BASE64, "资源域确有这份字节");

    const again = await adapter.ports.resolveCanvasRef({ nodeId: node.id, name: "raw.png", mime: "image/png", canvasId });
    assert.equal(again, ref, "同 owner 同 checksum 必须复用既有资源，不新增 resource_registry 行");
  } finally {
    f.fx.close();
  }
});

test("app-exchange canvas target：fs-only 字节端到端落卡片（文档只有 openarc-asset 引用，资源域可读回）", async () => {
  const f = await fixture();
  const db = newDb();
  try {
    const created = f.createCanvas("admin");
    const canvasId = created.canvas.canvasId;

    // 只走 dxos 虚拟树（saveBlob），**不**先 importManaged —— 这正是此前缺口的输入。
    const root = f.fsStore.ensureCanvasRoot(f.fx.users.admin);
    const sourceNode = f.fsStore.createNode({ name: "fs-only.png", type: "file", parentId: root.id, mime: "image/png", size: PNG_BYTES.length, ownerId: f.fx.users.admin });
    f.fsStore.saveBlob(sourceNode.id, PNG_BYTES);

    const state = { changed: [] };
    const bundle = createAppExchangeBundle({
      db,
      authorization: { resolveActor: () => ({ ok: true, user: viewer(f.fx, "admin"), organizationId: f.fx.orgId }) },
      ports: {
        ...f.adapters.admin.ports,
        getNode: (id) => f.fsStore.getNode(id),
        isInTrash: (id) => f.fsStore.isInTrash(id),
        readBlob: (id) => f.fsStore.readBlob(id),
        saveBlob: (id, bytes) => f.fsStore.saveBlob(id, bytes),
        createNode: (input) => f.fsStore.createNode(input),
        purgeNode: (id) => f.fsStore.purgeNode(id),
        ensureCanvasRoot: (ownerId) => f.fsStore.ensureCanvasRoot(ownerId),
        ensureFolder: (name, parentId, ownerId) => f.fsStore.ensureFolder(name, parentId, ownerId),
        canOpen: () => true,
        listCanvases: () => [{ id: canvasId, title: "画布", access: "write" }],
        createPhotoCraftProject: null,
        canViewPhotoCraftFile: null,
        changed: (id, patch) => state.changed.push({ id, patch }),
        sharpLoader: fakeSharpLoader(),
      },
    });
    const res = await bundle.execute("appExchange/exchange", {
      requestId: "req-canvas-fs-only",
      target: { appId: "canvas", action: "image.import", projectId: canvasId },
      asset: { nodeId: sourceNode.id },
    }, { sessionRef: f.fx.sessions.admin, appId: "app-exchange" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.value.status, "completed");
    assert.ok(res.value.target.cardId, "canvas target 必须回 cardId");

    const view = viewDoc(f, canvasId);
    const node = view.canvas.doc.nodes.find((item) => item.id === res.value.target.cardId);
    assert.ok(node, "画布文档必须有互传落下的卡片");
    assert.equal(node.type, "image");
    assert.match(node.url, /^openarc-asset:res_/);
    assert.equal(ASSET_REF_RE.test(node.url), true);
    const serialized = JSON.stringify(view.canvas.doc);
    assert.equal(serialized.includes(PNG_BASE64), false);
    assert.equal(/data:image/i.test(serialized), false);
    assert.equal(serialized.includes("/api/fs/raw/"), false, "非 openarc-asset 的媒体地址不得进文档");

    const roundTrip = f.fx.resourceService.readDataUrl({ context: { sessionRef: f.fx.sessions.admin, appId: "resource-library" }, resourceRef: node.url.slice("openarc-asset:".length) });
    assert.equal(roundTrip.ok, true, JSON.stringify(roundTrip));
    assert.equal(roundTrip.dataUrl, "data:image/png;base64," + PNG_BASE64, "资源域确有这份 fs-only 的字节");
    assert.equal(state.changed.length, 1);
    assert.equal(state.changed[0].id, canvasId);
  } finally {
    try { db.close(); } catch { /* ignore */ }
    f.fx.close();
  }
});
