/**
 * 应用互传域移植回归测试（全离线：假 ipcMain / 假授权 / 假端口 / 内存 node:sqlite，不启动 Electron、不联网）。
 *
 * 覆盖任务书验收条目：
 *   ① targets 表形状与映射标注（本仓无 dev-photocraft → image-studio，sourceAppId 如实备注）
 *   ② requestId 幂等（同请求返回同结果且只落一行；不同 fingerprint 拒绝）
 *   ③ 请求不含字节（bytes/data/url/Buffer 一律 BYTES_NOT_ALLOWED，且不触发任何字节读取）
 *   ④ source 不可读拒绝（FORBIDDEN，不建副本）
 *   ⑤ 目标不支持拒绝（dev-photocraft 不可用；canvas 缺 projectId、image-studio 带 projectId 拒绝）
 *   ⑥ inspect 形状与 revision/mime/size 拒绝
 *   ⑦ 未注入依赖结构化不可用（整组 / 单端口 / 无库 / sharp 缺失）
 *   附加：三个 target 落点、失败回收、appExchange-images 字节通道、trusted fail-closed、
 *         未装配 NOT_READY、未认证、identity.connection + clock 注入。
 *
 * 只读源：server/appExchange.ts、server/appExchangeRoutes.ts、shared/appExchange.ts。
 * 行号引用见 electron/app-exchange-{domain,service,bootstrap}.cjs 顶部注释。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const schema = require("../electron/dxos-foundation-schema.cjs");
const domain = require("../electron/app-exchange-domain.cjs");
const { createAppExchangeBundle, createExchangeStore, decodeImageBytes, APP_EXCHANGE_EVENT_CHANNEL, HOST_APP_ID } = require("../electron/app-exchange-service.cjs");
const { registerAppExchangeIpc, disposeAppExchangeIpc, APP_EXCHANGE_CHANNEL, APP_EXCHANGE_NOT_READY } = require("../electron/app-exchange-bootstrap.cjs");

const {
  APP_EXCHANGE_ERR_INVALID_INPUT,
  APP_EXCHANGE_ERR_NOT_FOUND,
  APP_EXCHANGE_ERR_CONFLICT,
  APP_EXCHANGE_ERR_FORBIDDEN,
  APP_EXCHANGE_ERR_TARGET_UNSUPPORTED,
  APP_EXCHANGE_ERR_BYTES_NOT_ALLOWED,
  APP_EXCHANGE_ERR_STALE_REVISION,
  APP_EXCHANGE_ERR_TOO_LARGE,
  APP_EXCHANGE_ERR_IMAGE_INVALID,
  APP_EXCHANGE_ERR_IMAGE_ENGINE_UNAVAILABLE,
  APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE,
  APP_EXCHANGE_ERR_COMMAND_NOT_ALLOWED,
  APP_EXCHANGE_ERR_UNAUTHENTICATED,
} = domain;

const SRC_SHA = "a".repeat(64);
const SRC_BYTES = Buffer.alloc(16, 1);

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const openDbs = [];
afterEach(() => {
  while (openDbs.length) {
    const db = openDbs.pop();
    try { db.close(); } catch { /* 已关闭 */ }
  }
});

function newDb() {
  const db = new DatabaseSync(":memory:");
  openDbs.push(db);
  for (const statement of schema.dxosDdl()) db.exec(statement);
  return db;
}

function fakeAuth(user = { id: "u1", role: "ADMIN", team_id: "org1" }) {
  return { resolveActor: () => ({ ok: true, user, organizationId: "org1" }) };
}

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { if (handlers.has(channel)) throw new Error("重复注册 handler：" + channel); handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    invoke(channel, event, raw) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error("没有 handler：" + channel);
      return fn(event, raw);
    },
  };
}

const TRUSTED_EVENT = { sender: "shell", senderFrame: { url: "file:///app/dist/index.html" } };

/**
 * 造一个完整夹具。
 *   options.ports        —— 覆盖默认端口（null 表示整组不注入）
 *   options.noDb         —— true 表示不注入数据库
 *   options.user         —— 认证身份
 *   options.authorization—— null 表示不装配授权服务
 */
function makeHarness(options = {}) {
  const db = options.noDb ? null : (options.db || newDb());
  const nodes = new Map();
  const blobs = new Map();
  const state = { created: [], changed: [], canOpenCalls: [], readBlobCalls: 0, imageMetadata: { width: 4, height: 4, format: "png", pages: 1 } };
  let seq = 0;

  const seed = (node, bytes) => {
    nodes.set(node.id, node);
    if (bytes) blobs.set(node.id, Buffer.from(bytes));
    return node;
  };
  // 源素材：u1 可读；private 属于 u2。
  seed({ id: "src-1", type: "file", name: "主图.png", ownerId: "u1", mime: "image/png", size: SRC_BYTES.length, blobSha256: SRC_SHA, updated_ts: 10 }, SRC_BYTES);
  seed({ id: "src-private", type: "file", name: "别人的.png", ownerId: "u2", mime: "image/png", size: SRC_BYTES.length, blobSha256: "b".repeat(64), updated_ts: 11 }, Buffer.alloc(16, 2));

  const defaultPorts = {
    getNode: (id) => nodes.get(id) || null,
    isInTrash: (id) => { const node = nodes.get(id); return !!(node && node.trashed); },
    readBlob: (id) => { state.readBlobCalls += 1; const value = blobs.get(id); return value ? Buffer.from(value) : null; },
    saveBlob: (id, bytes) => { blobs.set(id, Buffer.from(bytes)); },
    createNode: (input) => {
      seq += 1;
      const node = { id: "node-" + seq, type: input.type || "file", name: input.name, parentId: input.parentId == null ? null : input.parentId, ownerId: input.ownerId, mime: input.mime, size: input.size, updated_ts: 100 + seq, blobSha256: null };
      nodes.set(node.id, node);
      state.created.push(node.id);
      return node;
    },
    ensureCanvasRoot: (ownerId) => ({ id: "root-" + ownerId }),
    ensureFolder: (name, parentId) => "folder:" + name + ":" + parentId,
    purgeNode: (id) => { nodes.delete(id); blobs.delete(id); },
    canRead: (viewer, node) => viewer.id === node.ownerId,
    canOpen: (viewer, appId) => { state.canOpenCalls.push(appId); return appId !== "forbidden-app"; },
    canViewCanvasMedia: () => false,
    canViewPhotoCraftFile: () => false,
    listCanvases: () => [{ id: "c1", title: "画布一", access: "write" }, { id: "c2", title: "只读画布", access: "read" }],
    getCanvas: () => ({ id: "c1", ownerId: "u1", viewport: { x: 0, y: 0, scale: 1 }, cards: [{ x: 0, y: 0, w: 100, h: 100 }] }),
    canEditCanvas: () => true,
    canvasFolder: () => "canvas-folder",
    createCanvasCard: (x, y, spec) => ({ id: "card-1", x, y, w: spec.w, h: spec.h, title: spec.title, inputs: spec.inputs, params: spec.params }),
    findNearestCanvasPlacement: ({ desired }) => ({ x: desired.x, y: desired.y }),
    syncCanvas: () => ({ version: 7 }),
    createPhotoCraftProject: (viewer, input) => ({ project: { id: "pcp-1", title: input.name }, source: { id: "pcp-source-1" } }),
    changed: (canvasId, patch) => { state.changed.push({ canvasId, patch }); },
    sharpLoader: () => (bytes, sharpOptions) => ({ metadata: async () => ({ ...state.imageMetadata }) }),
  };
  const ports = options.ports === null ? null : { ...defaultPorts, ...(options.ports || {}) };
  const authorization = options.authorization === null ? null : (options.authorization || fakeAuth(options.user));

  const bundle = createAppExchangeBundle({ db, authorization, ports, clock: options.clock });
  const ipcMain = fakeIpcMain();
  registerAppExchangeIpc(ipcMain, {
    bundle,
    identity: { current: "session-1" },
    isTrusted: (event) => !!event && event.sender === "shell",
  });
  const call = (command, payload) => ipcMain.invoke(APP_EXCHANGE_CHANNEL, TRUSTED_EVENT, { command, payload });
  const exchangeCount = () => db.prepare("SELECT COUNT(*) AS c FROM app_exchanges").get().c;

  return { db, nodes, blobs, state, ports, bundle, ipcMain, call, exchangeCount };
}

const request = (overrides = {}) => ({
  requestId: "req-1",
  target: { appId: "image-studio", action: "image.receive" },
  asset: { nodeId: "src-1" },
  ...overrides,
});

// ---------------------------------------------------------------------------
// ① targets 表形状与映射标注
// ---------------------------------------------------------------------------

test("domain：DX 原始 target 表逐字保留，导出表可逐条机械核对", () => {
  assert.equal(domain.DX_APP_EXCHANGE_TARGETS.length, 3);
  assert.deepEqual(
    domain.DX_APP_EXCHANGE_TARGETS.map((t) => [t.appId, t.action, t.creates]),
    [["dev-photocraft", "image.edit", "document"], ["dev-photocraft", "image.receive", "layer"], ["canvas", "image.import", "node"]],
  );
  assert.equal(domain.APP_EXCHANGE_TARGETS.length, 3);
  for (let index = 0; index < 3; index += 1) {
    const dx = domain.DX_APP_EXCHANGE_TARGETS[index];
    const mapped = domain.APP_EXCHANGE_TARGETS[index];
    assert.equal(mapped.action, dx.action);
    assert.equal(mapped.creates, dx.creates);
    assert.deepEqual(mapped.accepts, dx.accepts);
    assert.equal(mapped.sourceAppId, dx.appId, "必须保留 DX 原始 appId 作为只读备注");
    assert.equal(domain.findExchangeTarget(mapped.appId, mapped.action), mapped);
  }
});

test("targets：三个 target 的 appId 映射与标注如实，绝不暴露 dev-photocraft 为可用 target", async () => {
  const h = makeHarness();
  const res = await h.call("appExchange/targets", {});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.version, 1);
  assert.deepEqual(res.value.targets.map((t) => t.appId), ["image-studio", "image-studio", "canvas"]);
  assert.equal(res.value.targets.some((t) => t.appId === "dev-photocraft"), false);

  const edit = res.value.targets.find((t) => t.action === "image.edit");
  assert.equal(edit.title, "图像工坊");
  assert.equal(edit.sourceAppId, "dev-photocraft");
  assert.equal(edit.sourceTitle, "PhotoCraft");
  assert.equal(edit.mapping, "equivalent");
  assert.match(edit.mappingNote, /dev-photocraft/);
  assert.match(edit.mappingNote, /image-studio/);
  assert.deepEqual(edit.accepts, ["image/png", "image/jpeg", "image/webp"]);
  assert.equal(edit.creates, "document");

  const receive = res.value.targets.find((t) => t.action === "image.receive");
  assert.equal(receive.sourceAppId, "dev-photocraft");
  assert.equal(receive.creates, "layer");

  const canvas = res.value.targets.find((t) => t.appId === "canvas");
  assert.equal(canvas.sourceAppId, "canvas");
  assert.equal(canvas.mapping, "identity");
  assert.equal(canvas.creates, "node");

  // 画布清单只回可写（access !== 'read'）。
  assert.deepEqual(res.value.canvases, [{ id: "c1", title: "画布一" }]);
});

test("targets：canOpen 过滤生效；canvas 被拒时不查画布清单", async () => {
  const onlyStudio = makeHarness({ ports: { canOpen: (viewer, appId) => appId === "image-studio" } });
  const studioRes = await onlyStudio.call("appExchange/targets", {});
  assert.deepEqual(studioRes.value.targets.map((t) => t.appId), ["image-studio", "image-studio"]);
  assert.deepEqual(studioRes.value.canvases, []);

  const none = makeHarness({ ports: { canOpen: () => false } });
  const noneRes = await none.call("appExchange/targets", {});
  assert.deepEqual(noneRes.value.targets, []);
  assert.deepEqual(noneRes.value.canvases, []);
});

// ---------------------------------------------------------------------------
// ② requestId 幂等
// ---------------------------------------------------------------------------

test("exchange：同 requestId + 同 fingerprint 返回既有结果，只落一行、不重复建副本", async () => {
  const h = makeHarness();
  const first = await h.call("appExchange/exchange", request());
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.status, "completed");
  assert.deepEqual(first.value.target, { appId: "image-studio", projectId: "", assetNodeId: "node-1" });
  assert.deepEqual(first.value.source, { nodeId: "src-1", revision: SRC_SHA }); // 源 appExchange.ts:131 source 带上 revision
  assert.equal(first.value.asset.name, "主图.png");
  assert.equal(first.value.asset.mime, "image/png");
  assert.equal(first.value.asset.size, SRC_BYTES.length);
  assert.equal(first.value.asset.sha256, createHash("sha256").update(SRC_BYTES).digest("hex"));
  assert.equal(typeof first.value.createdAt, "number");
  assert.equal(h.exchangeCount(), 1);

  const second = await h.call("appExchange/exchange", request());
  assert.deepEqual(second.value, first.value, "同请求必须返回既有结果");
  assert.equal(h.exchangeCount(), 1, "幂等不得新增行");
  assert.equal(h.state.created.length, 1, "幂等不得重复建副本");

  const got = await h.call("appExchange/get", { id: first.value.id });
  assert.deepEqual(got.value, first.value);
});

test("exchange：同 requestId 不同 fingerprint 拒绝（CONFLICT），不改写既有结果", async () => {
  const h = makeHarness();
  const first = await h.call("appExchange/exchange", request({ requestId: "req-2" }));
  assert.equal(first.ok, true);
  const conflicting = await h.call("appExchange/exchange", request({ requestId: "req-2", target: { appId: "canvas", action: "image.import", projectId: "c1" } }));
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.error, APP_EXCHANGE_ERR_CONFLICT);
  assert.equal(h.exchangeCount(), 1);
  assert.equal((await h.call("appExchange/get", { id: first.value.id })).value.id, first.value.id);
});

test("exchange：并发同请求共享同一次执行（inFlight 单飞）", async () => {
  const h = makeHarness();
  const [a, b] = await Promise.all([h.call("appExchange/exchange", request({ requestId: "req-race" })), h.call("appExchange/exchange", request({ requestId: "req-race" }))]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.value.id, b.value.id);
  assert.equal(h.exchangeCount(), 1);
  assert.equal(h.state.created.length, 1);
});

// ---------------------------------------------------------------------------
// ③ 请求不含字节
// ---------------------------------------------------------------------------

test("只传引用：请求体出现字节/URL 一律 BYTES_NOT_ALLOWED，且不读任何字节、不落库", async () => {
  const h = makeHarness();
  const withBytes = await h.call("appExchange/exchange", { ...request({ requestId: "r1" }), bytes: Buffer.from([1, 2, 3]) });
  assert.equal(withBytes.ok, false);
  assert.equal(withBytes.error, APP_EXCHANGE_ERR_BYTES_NOT_ALLOWED);
  assert.equal(withBytes.detail.field, "bytes");

  const withData = await h.call("appExchange/exchange", request({ requestId: "r2", asset: { nodeId: "src-1", data: Buffer.alloc(4).toString("base64") } }));
  assert.equal(withData.error, APP_EXCHANGE_ERR_BYTES_NOT_ALLOWED);

  const withUrl = await h.call("appExchange/exchange", request({ requestId: "r3", asset: { nodeId: "src-1", url: "https://example.com/a.png" } }));
  assert.equal(withUrl.error, APP_EXCHANGE_ERR_BYTES_NOT_ALLOWED, "协议注释明确 never image bytes/URLs");

  const bufferNode = await h.call("appExchange/exchange", request({ requestId: "r4", asset: { nodeId: Buffer.from("src-1") } }));
  assert.equal(bufferNode.error, APP_EXCHANGE_ERR_BYTES_NOT_ALLOWED, "二进制值出现在允许字段名上也要拒绝");

  const inspectBytes = await h.call("appExchange/inspect", { asset: { nodeId: "src-1", bytes: Buffer.alloc(4) } });
  assert.equal(inspectBytes.error, APP_EXCHANGE_ERR_BYTES_NOT_ALLOWED);

  assert.equal(h.state.readBlobCalls, 0, "字节请求不得触发任何字节读取");
  assert.equal(h.exchangeCount(), 0);
});

test("结果 shape：ExchangeResult 字段名与可空性一字不改，且不含字节", async () => {
  const h = makeHarness();
  const res = await h.call("appExchange/exchange", request({ requestId: "r-shape" }));
  assert.deepEqual(Object.keys(res.value).sort(), ["asset", "createdAt", "id", "source", "status", "target"].sort());
  assert.deepEqual(Object.keys(res.value.asset).sort(), ["mime", "name", "sha256", "size"].sort());
  assert.deepEqual(Object.keys(res.value.target).sort(), ["appId", "assetNodeId", "projectId"].sort());
  assert.equal(res.value.status, "completed");
  assert.equal("bytes" in res.value.asset, false);
  assert.equal("content" in res.value.asset, false);
  assert.equal("url" in res.value.asset, false);
});

// ---------------------------------------------------------------------------
// ④ source 不可读拒绝
// ---------------------------------------------------------------------------

test("权限：source 不可读即 FORBIDDEN，不建副本、不落库（目标门禁先于读权限，与源路由顺序一致）", async () => {
  const h = makeHarness();
  const res = await h.call("appExchange/exchange", request({ requestId: "req-forbidden", asset: { nodeId: "src-private" } }));
  assert.equal(res.ok, false);
  assert.equal(res.error, APP_EXCHANGE_ERR_FORBIDDEN);
  assert.equal(h.state.created.length, 0);
  assert.equal(h.state.readBlobCalls, 0);
  assert.equal(h.exchangeCount(), 0);
  assert.equal(h.state.canOpenCalls.includes("image-studio"), true, "目标应用门禁在源路由已检查");

  const inspect = await h.call("appExchange/inspect", { asset: { nodeId: "src-private" } });
  assert.equal(inspect.error, APP_EXCHANGE_ERR_FORBIDDEN);
});

test("权限：canRead 失败但 canvasId 授权通过时允许（源 appExchange.ts:42-44 的三选一）", async () => {
  const h = makeHarness({ ports: { canViewCanvasMedia: (nodeId, viewer, canvasId) => canvasId === "c9" } });
  const res = await h.call("appExchange/inspect", { asset: { nodeId: "src-private", canvasId: "c9" } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.asset.nodeId, "src-private");
});

test("权限：目标应用不可打开即 FORBIDDEN（canOpen 用映射后的 image-studio）", async () => {
  const h = makeHarness({ ports: { canOpen: () => false } });
  const res = await h.call("appExchange/exchange", request({ requestId: "req-denied" }));
  assert.equal(res.ok, false);
  assert.equal(res.error, APP_EXCHANGE_ERR_FORBIDDEN);
  assert.equal(h.exchangeCount(), 0);
});

// ---------------------------------------------------------------------------
// ⑤ 目标不支持拒绝
// ---------------------------------------------------------------------------

test("target：不支持的 appId/action 拒绝；canvas 缺 projectId、image-studio 带 projectId 拒绝", async () => {
  const h = makeHarness();
  const legacy = await h.call("appExchange/exchange", request({ requestId: "r1", target: { appId: "dev-photocraft", action: "image.edit" } }));
  assert.equal(legacy.error, APP_EXCHANGE_ERR_TARGET_UNSUPPORTED, "本仓无 dev-photocraft，不得接受");
  const badAction = await h.call("appExchange/exchange", request({ requestId: "r2", target: { appId: "image-studio", action: "image.export" } }));
  assert.equal(badAction.error, APP_EXCHANGE_ERR_TARGET_UNSUPPORTED);
  const canvasNoProject = await h.call("appExchange/exchange", request({ requestId: "r3", target: { appId: "canvas", action: "image.import" } }));
  assert.equal(canvasNoProject.error, APP_EXCHANGE_ERR_INVALID_INPUT);
  const studioWithProject = await h.call("appExchange/exchange", request({ requestId: "r4", target: { appId: "image-studio", action: "image.edit", projectId: "p1" } }));
  assert.equal(studioWithProject.error, APP_EXCHANGE_ERR_INVALID_INPUT);
  assert.equal(h.exchangeCount(), 0);
});

// ---------------------------------------------------------------------------
// ⑥ inspect
// ---------------------------------------------------------------------------

test("inspect：只读返回形状；revision 不符 STALE；mime/size 不符拒绝；不存在 NOT_FOUND", async () => {
  const h = makeHarness();
  const ok = await h.call("appExchange/inspect", { asset: { nodeId: "src-1" } });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.value.asset, { nodeId: "src-1", name: "主图.png", size: SRC_BYTES.length, mime: "image/png", revision: SRC_SHA });
  assert.equal(h.state.readBlobCalls, 0, "inspect 只读元数据，不读字节");

  const stale = await h.call("appExchange/inspect", { asset: { nodeId: "src-1", revision: "deadbeef" } });
  assert.equal(stale.error, APP_EXCHANGE_ERR_STALE_REVISION);

  const missing = await h.call("appExchange/inspect", { asset: { nodeId: "nope" } });
  assert.equal(missing.error, APP_EXCHANGE_ERR_NOT_FOUND);

  h.nodes.set("src-gif", { id: "src-gif", type: "file", name: "a.gif", ownerId: "u1", mime: "image/gif", size: 8, updated_ts: 1 });
  assert.equal((await h.call("appExchange/inspect", { asset: { nodeId: "src-gif" } })).error, APP_EXCHANGE_ERR_INVALID_INPUT);

  h.nodes.set("src-big", { id: "src-big", type: "file", name: "big.png", ownerId: "u1", mime: "image/png", size: domain.MAX_IMAGE_BYTES + 1, updated_ts: 1 });
  assert.equal((await h.call("appExchange/inspect", { asset: { nodeId: "src-big" } })).error, APP_EXCHANGE_ERR_TOO_LARGE);

  h.nodes.set("src-folder", { id: "src-folder", type: "folder", name: "目录", ownerId: "u1" });
  assert.equal((await h.call("appExchange/inspect", { asset: { nodeId: "src-folder" } })).error, APP_EXCHANGE_ERR_NOT_FOUND);
});

test("get：不存在的记录 NOT_FOUND；只回本人记录", async () => {
  const h = makeHarness();
  assert.equal((await h.call("appExchange/get", { id: "missing" })).error, APP_EXCHANGE_ERR_NOT_FOUND);
  const created = await h.call("appExchange/exchange", request({ requestId: "r-owner" }));
  const other = makeHarness({ db: h.db, user: { id: "u2", role: "ADMIN" }, ports: { canRead: (viewer, node) => false } });
  const foreign = await other.call("appExchange/get", { id: created.value.id });
  assert.equal(foreign.error, APP_EXCHANGE_ERR_NOT_FOUND, "他人不得读到别人的发送记录");
});

// ---------------------------------------------------------------------------
// ⑦ 未注入依赖结构化不可用
// ---------------------------------------------------------------------------

test("未注入依赖：整组端口缺失 → DEPENDENCY_UNAVAILABLE，不假成功", async () => {
  const h = makeHarness({ ports: null });
  const targets = await h.call("appExchange/targets", {});
  assert.equal(targets.ok, false);
  assert.equal(targets.error, APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE);
  assert.deepEqual(targets.detail, { dependency: "canOpen" });

  const exchange = await h.call("appExchange/exchange", request({ requestId: "r1" }));
  assert.equal(exchange.error, APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE);

  const images = await h.call("appExchange-images", { name: "a.png", mime: "image/png", bytes: Buffer.alloc(4) });
  assert.equal(images.error, APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE);
});

test("未注入依赖：缺单个端口（readBlob）也结构化不可用，并指明依赖名", async () => {
  const h = makeHarness({ ports: { readBlob: null } });
  const res = await h.call("appExchange/exchange", request({ requestId: "r-missing-read" }));
  assert.equal(res.ok, false);
  assert.equal(res.error, APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE);
  assert.deepEqual(res.detail, { dependency: "readBlob" });
  assert.equal(h.exchangeCount(), 0, "依赖缺失不得落库");
});

test("未注入依赖：无数据库 / 未装配授权服务均结构化失败", async () => {
  const noDb = makeHarness({ noDb: true });
  const get = await noDb.call("appExchange/get", { id: "x" });
  assert.equal(get.error, APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE);
  const exchange = await noDb.call("appExchange/exchange", request({ requestId: "r-db" }));
  assert.equal(exchange.error, APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE);

  const noAuth = makeHarness({ authorization: null });
  const denied = await noAuth.call("appExchange/targets", {});
  assert.equal(denied.error, APP_EXCHANGE_ERR_UNAUTHENTICATED);
});

// ---------------------------------------------------------------------------
// 图片校验 / sharp 惰性
// ---------------------------------------------------------------------------

test("图片校验：格式不符 / 动态图 / 超大像素拒绝；失败不落库也不留副本", async () => {
  const h = makeHarness();
  h.state.imageMetadata = { width: 4, height: 4, format: "jpeg", pages: 1 };
  const mismatch = await h.call("appExchange/exchange", request({ requestId: "r-format" }));
  assert.equal(mismatch.error, APP_EXCHANGE_ERR_IMAGE_INVALID);

  h.state.imageMetadata = { width: 4, height: 4, format: "png", pages: 3 };
  assert.equal((await h.call("appExchange/exchange", request({ requestId: "r-anim" }))).error, APP_EXCHANGE_ERR_IMAGE_INVALID);

  h.state.imageMetadata = { width: 9000, height: 9000, format: "png", pages: 1 };
  assert.equal((await h.call("appExchange/exchange", request({ requestId: "r-pixels" }))).error, APP_EXCHANGE_ERR_IMAGE_INVALID);

  assert.equal(h.exchangeCount(), 0);
  assert.equal(h.state.created.length, 0);
});

test("sharp 惰性：加载失败给 IMAGE_ENGINE_UNAVAILABLE（结构化，不假成功）", async () => {
  const h = makeHarness({ ports: { sharpLoader: () => { const error = new Error("Cannot find module 'sharp'"); error.code = "MODULE_NOT_FOUND"; throw error; } } });
  const res = await h.call("appExchange/exchange", request({ requestId: "r-sharp" }));
  assert.equal(res.ok, false);
  assert.equal(res.error, APP_EXCHANGE_ERR_IMAGE_ENGINE_UNAVAILABLE);
  assert.equal(h.exchangeCount(), 0);
});

// ---------------------------------------------------------------------------
// 三个 target 的实际落点 + 失败回收
// ---------------------------------------------------------------------------

test("落点：image.receive 复制到「应用互联」；image.edit 建图像工坊项目；canvas 落卡片并通知 changed", async () => {
  const h = makeHarness();
  const receive = await h.call("appExchange/exchange", request({ requestId: "r-recv" }));
  assert.equal(receive.ok, true, JSON.stringify(receive));
  const copied = h.nodes.get(receive.value.target.assetNodeId);
  assert.equal(copied.parentId, "folder:应用互联:root-u1");
  assert.equal(copied.ownerId, "u1");
  assert.equal(h.blobs.get(copied.id).equals(SRC_BYTES), true);

  const edit = await h.call("appExchange/exchange", request({ requestId: "r-edit", target: { appId: "image-studio", action: "image.edit" } }));
  assert.equal(edit.ok, true, JSON.stringify(edit));
  assert.deepEqual(edit.value.target, { appId: "image-studio", projectId: "pcp-1" });

  const canvas = await h.call("appExchange/exchange", request({ requestId: "r-canvas", target: { appId: "canvas", action: "image.import", projectId: "c1" } }));
  assert.equal(canvas.ok, true, JSON.stringify(canvas));
  assert.deepEqual(canvas.value.target, { appId: "canvas", projectId: "c1", cardId: "card-1" });
  const canvasChange = h.state.changed.find((entry) => entry.canvasId === "c1");
  assert.ok(canvasChange, "canvas 导入必须通知 changed(canvasId, patch)");
  assert.equal(canvasChange.patch.version, 7);
  assert.equal(canvasChange.patch.upserts[0].id, "card-1");
  const canvasCopied = [...h.nodes.values()].find((node) => node.parentId === "canvas-folder");
  assert.ok(canvasCopied, "canvas target 必须建一个落在画布目录的素材节点");
  assert.deepEqual(canvasChange.patch.upserts[0].inputs[0], { nodeId: canvasCopied.id, name: "主图.png", url: "/api/fs/raw/" + canvasCopied.id, kind: "image", role: "input", w: 4, h: 4 });
});

test("失败回收：目标操作抛错时 purge 已建副本且不落库", async () => {
  const h = makeHarness({ ports: { syncCanvas: () => { throw new Error("画布保存失败"); } } });
  const res = await h.call("appExchange/exchange", request({ requestId: "r-clean", target: { appId: "canvas", action: "image.import", projectId: "c1" } }));
  assert.equal(res.ok, false);
  assert.equal(h.state.created.length, 1);
  assert.equal(h.nodes.has(h.state.created[0]), false, "失败必须回收副本");
  assert.equal(h.blobs.has(h.state.created[0]), false);
  assert.equal(h.exchangeCount(), 0);
});

// ---------------------------------------------------------------------------
// appExchange-images（唯一字节通道）
// ---------------------------------------------------------------------------

test("appExchange-images：字节上传落节点；命名清洗与默认名；mime/字节/权限按码拒绝", async () => {
  const h = makeHarness();
  const bytes = Buffer.from("fake-png-bytes");
  const upload = await h.call("appExchange-images", { name: "导出/合成:图.png", mime: "image/png", bytes });
  assert.equal(upload.ok, true, JSON.stringify(upload));
  const node = h.nodes.get(upload.value.asset.nodeId);
  assert.equal(node.name, "导出_合成_图.png");
  assert.equal(node.mime, "image/png");
  assert.equal(node.parentId, "folder:应用互联:root-u1");
  assert.equal(h.blobs.get(node.id).equals(bytes), true);
  assert.equal(h.state.canOpenCalls.at(-1), "image-studio", "门禁用映射后的 image-studio，而不是 dev-photocraft");

  const noName = await h.call("appExchange-images", { mime: "image/jpeg", data: Buffer.alloc(4, 9).toString("base64"), encoding: "base64" });
  assert.equal(noName.ok, true, JSON.stringify(noName));
  assert.equal(h.nodes.get(noName.value.asset.nodeId).name, domain.APP_EXCHANGE_DEFAULT_IMAGE_NAME);

  const uint8 = await h.call("appExchange-images", { name: "u.png", mime: "image/webp", bytes: new Uint8Array([1, 2, 3]) });
  assert.equal(uint8.ok, true);

  assert.equal((await h.call("appExchange-images", { name: "a.gif", mime: "image/gif", bytes })).error, APP_EXCHANGE_ERR_INVALID_INPUT);
  assert.equal((await h.call("appExchange-images", { name: "a.png", mime: "image/png" })).error, APP_EXCHANGE_ERR_INVALID_INPUT);
  assert.equal((await h.call("appExchange-images", { name: "a.png", mime: "image/png", bytes: Buffer.alloc(0) })).error, APP_EXCHANGE_ERR_INVALID_INPUT);

  const denied = makeHarness({ ports: { canOpen: (viewer, appId) => appId !== "image-studio" } });
  assert.equal((await denied.call("appExchange-images", { name: "a.png", mime: "image/png", bytes })).error, APP_EXCHANGE_ERR_FORBIDDEN);
});

// ---------------------------------------------------------------------------
// bootstrap 边界
// ---------------------------------------------------------------------------

test("bootstrap：trusted fail-closed、未装配 NOT_READY、未登记命令拒绝、重复注册与 dispose", async () => {
  const h = makeHarness();
  const noTrust = fakeIpcMain();
  registerAppExchangeIpc(noTrust, { bundle: h.bundle });
  await assert.rejects(() => noTrust.invoke(APP_EXCHANGE_CHANNEL, TRUSTED_EVENT, { command: "appExchange/targets" }), /Forbidden/);

  const strict = fakeIpcMain();
  registerAppExchangeIpc(strict, { bundle: h.bundle, isTrusted: () => false });
  await assert.rejects(() => strict.invoke(APP_EXCHANGE_CHANNEL, TRUSTED_EVENT, { command: "appExchange/targets" }), /Forbidden/);

  const notReady = fakeIpcMain();
  const registered = registerAppExchangeIpc(notReady, { bundle: null, isTrusted: () => true });
  assert.equal(registered.channel, APP_EXCHANGE_CHANNEL);
  assert.deepEqual(await notReady.invoke(APP_EXCHANGE_CHANNEL, TRUSTED_EVENT, { command: "appExchange/targets" }), { ok: false, error: APP_EXCHANGE_NOT_READY, message: "应用互传域尚未装配" });

  assert.equal((await h.call("appExchange/nope", {})).error, APP_EXCHANGE_ERR_COMMAND_NOT_ALLOWED);
  assert.equal((await h.ipcMain.invoke(APP_EXCHANGE_CHANNEL, TRUSTED_EVENT, null)).error, APP_EXCHANGE_ERR_INVALID_INPUT);

  registerAppExchangeIpc(h.ipcMain, { bundle: h.bundle, isTrusted: (event) => !!event && event.sender === "shell" });
  const health = await h.call("appExchange/targets", {});
  assert.equal(health.ok, true);
  disposeAppExchangeIpc(h.ipcMain);
  assert.throws(() => h.ipcMain.invoke(APP_EXCHANGE_CHANNEL, TRUSTED_EVENT, { command: "appExchange/targets" }), /没有 handler/);
});

test("命令表：五条冻结命令齐全，risk 取值受约束", () => {
  const commands = domain.listAppExchangeCommands();
  assert.deepEqual(commands.map((entry) => entry.command).sort(), ["appExchange-images", "appExchange/exchange", "appExchange/get", "appExchange/inspect", "appExchange/targets"].sort());
  for (const entry of commands) assert.ok(["read", "manage", "destructive"].includes(entry.risk));
  assert.equal(HOST_APP_ID, "app-exchange");
  assert.equal(APP_EXCHANGE_EVENT_CHANNEL, "appExchange:event");
});

test("identity 注入：connection 供库、clock 决定 createdAt", async () => {
  const db = newDb();
  const h = makeHarness({ db, clock: null });
  const bundle = createAppExchangeBundle({ identity: { connection: db, clock: () => 1234567890 }, authorization: fakeAuth(), ports: h.ports });
  const res = await bundle.execute("appExchange/exchange", request({ requestId: "r-clock" }), { sessionRef: "s" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.createdAt, 1234567890);
  assert.deepEqual(bundle.dependencies, { identity: true, database: true, portCount: Object.keys(h.ports).length, store: true });
});

// ---------------------------------------------------------------------------
// 纯函数边界
// ---------------------------------------------------------------------------

test("纯函数：identifier / asset 归一 / reference-only / 文件名清洗", () => {
  assert.throws(() => domain.validateExchangeRequest({ requestId: "带 空格", target: { appId: "image-studio", action: "image.edit" }, asset: { nodeId: "src-1" } }), (error) => error.code === APP_EXCHANGE_ERR_INVALID_INPUT);
  assert.throws(() => domain.normalizeExchangeAsset({ nodeId: "n1", bogus: 1 }), (error) => error.code === APP_EXCHANGE_ERR_INVALID_INPUT);
  assert.deepEqual(domain.normalizeExchangeAsset({ nodeId: "n1", canvasId: "c1", photoCraftProjectId: "p1", revision: "r1" }), { nodeId: "n1", canvasId: "c1", photoCraftProjectId: "p1", revision: "r1" });
  assert.equal(domain.normalizeExchangeAsset({ nodeId: "n1" }).revision, undefined);
  assert.deepEqual(domain.sanitizeImageName("a/b\\c:d*e?f\"g<h>i|j.png"), "a_b_c_d_e_f_g_h_i_j.png");
  assert.equal(domain.sanitizeImageName(""), domain.APP_EXCHANGE_DEFAULT_IMAGE_NAME);
  assert.equal(domain.sanitizeImageName("x".repeat(300)).length, domain.APP_EXCHANGE_NAME_MAX);
  assert.equal(domain.fingerprintOf({ a: 1 }), createHash("sha256").update(JSON.stringify({ a: 1 })).digest("hex"));

  const store = createExchangeStore(newDb());
  assert.equal(store.findById("u1", "x"), null);
  assert.deepEqual(decodeImageBytes({ bytes: new Uint8Array([1, 2, 3]) }), Buffer.from([1, 2, 3]));
  assert.equal(decodeImageBytes({ data: Buffer.from("ab").toString("base64"), encoding: "base64" }).toString(), "ab");
  assert.throws(() => decodeImageBytes({ data: "ab" }), (error) => error.code === APP_EXCHANGE_ERR_INVALID_INPUT);
});

// ---------------------------------------------------------------------------
// 附加 · canvas target 的 fs-only 字节先经 async resolveCanvasRef 拿 ResourceRef
// ---------------------------------------------------------------------------

test("canvas target：注入 async resolveCanvasRef 时先 await 拿引用，再把 openarc-asset 交给 createCanvasCard", async () => {
  const seen = { calls: [], specs: [] };
  const h = makeHarness({
    ports: {
      resolveCanvasRef: async (input) => { seen.calls.push(input); return "openarc-asset:res_from_import"; },
      createCanvasCard: (x, y, spec) => { seen.specs.push(spec); return { id: "card-9", x, y, w: spec.w, h: spec.h, title: spec.title, url: spec.url, inputs: spec.inputs, params: spec.params }; },
    },
  });
  const res = await h.call("appExchange/exchange", request({ requestId: "r-resolve", target: { appId: "canvas", action: "image.import", projectId: "c1" } }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.target.cardId, "card-9");
  assert.equal(res.value.target.projectId, "c1");
  assert.equal(seen.calls.length, 1, "canvas 分支必须且只调用一次 resolveCanvasRef");
  assert.match(seen.calls[0].nodeId, /^node-/, "解析对象是本次新建的 fs 副本");
  assert.equal(seen.calls[0].name, "主图.png");
  assert.equal(seen.calls[0].mime, "image/png");
  assert.equal(seen.calls[0].canvasId, "c1");
  assert.equal(seen.specs[0].url, "openarc-asset:res_from_import", "服务必须把解析出的资源引用交给 createCanvasCard");
  assert.equal(seen.specs[0].inputs[0].url, "/api/fs/raw/" + seen.calls[0].nodeId, "既有 fs 副本 inputs 形状保持不变");
  assert.equal(h.exchangeCount(), 1);
});

test("canvas target：resolveCanvasRef 失败即结构化依赖不可用，回收 fs 副本、不落库、不留卡片", async () => {
  const h = makeHarness({
    ports: {
      resolveCanvasRef: async () => { throw domain.createAppExchangeError(APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE, "资源域不可用", { dependency: "resourceService", missing: "fs-node-to-ResourceRef" }); },
    },
  });
  const res = await h.call("appExchange/exchange", request({ requestId: "r-resolve-fail", target: { appId: "canvas", action: "image.import", projectId: "c1" } }));
  assert.equal(res.ok, false);
  assert.equal(res.error, APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE);
  assert.equal(res.detail.missing, "fs-node-to-ResourceRef");
  assert.equal(h.state.created.length, 1);
  assert.equal(h.nodes.has(h.state.created[0]), false, "失败必须回收已建 fs 副本");
  assert.equal(h.blobs.has(h.state.created[0]), false);
  assert.equal(h.exchangeCount(), 0);
  assert.equal(h.state.changed.length, 0, "失败不得通知 changed");
});
