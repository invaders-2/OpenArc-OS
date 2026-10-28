/**
 * task-16 · 画布：素材库 sync-sources / 邀请码 / 插件数据与受控网络。
 *
 * 真实依赖：resource-fixtures 的 ResourceService + 真实 CanvasService/CanvasStore/CanvasDxosStore
 * + 真实 dxos-fs 虚拟树；插件宿主用真实文件落盘与假 developerStore/developerService（离线）。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createDxosFs } = require("../electron/dxos-fs.cjs");
const { CanvasDxosStore } = require("../electron/canvas-dxos-store.cjs");
const { CanvasStore } = require("../electron/canvas-store.cjs");
const { CanvasService } = require("../electron/canvas-service.cjs");
const { CanvasAssetLibraryService } = require("../electron/canvas-dxos-asset-library.cjs");
const { CanvasAgentAttachmentService } = require("../electron/canvas-dxos-agent-attachments.cjs");
const commands = require("../electron/canvas-dxos-commands.cjs");
const { createCanvasPluginHost } = require("../electron/canvas-dxos-plugins.cjs");

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const PNG_DATA_URL = "data:image/png;base64," + PNG_BASE64;
const tmpDirs = [];
const openFixtures = [];

afterEach(() => {
  while (openFixtures.length) { try { openFixtures.pop().close(); } catch { /* 已关 */ } }
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function fixture() {
  const fx = await createResourceFixture();
  openFixtures.push(fx);
  const dir = tempDir("oa-canvas-task16-");
  const fsStore = createDxosFs({ dataDir: path.join(dir, "fs") });
  const store = new CanvasDxosStore({ identity: fx.identity, clock: fx.clock });
  const canvasStore = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const canvasService = new CanvasService({
    identity: fx.identity, store: canvasStore, resourceStore: fx.resourceStore, resourceService: fx.resourceService,
    authService: fx.authService, authStore: fx.store, clock: fx.clock,
  });
  const tempDirFn = () => path.join(dir, "tmp");
  const assetLibrary = new CanvasAssetLibraryService({
    identity: fx.identity, store, resourceService: fx.resourceService, resourceStore: fx.resourceStore,
    canvasService, fsStore, authorization: fx.authService, clock: fx.clock, tempDir: tempDirFn,
  });
  const attachmentService = new CanvasAgentAttachmentService({ identity: fx.identity, store, canvasService, resourceService: fx.resourceService, clock: fx.clock, tempDir: tempDirFn });
  const extension = commands.createCanvasDxosExtension({ identity: fx.identity, store, canvasService, resourceService: fx.resourceService, assetLibrary, attachments: attachmentService, tempDir: tempDirFn, clock: fx.clock });
  const ctx = (key, extra = {}) => ({ sessionRef: fx.sessions[key], appId: "canvas", source: "ui", ...extra });
  const canvas = canvasService.createCanvas({ context: ctx("admin"), title: "邀请画布" });
  assert.equal(canvas.ok, true, JSON.stringify(canvas));
  return { fx, dir, fsStore, store, canvasService, assetLibrary, attachmentService, extension, ctx, canvasId: canvas.canvas.canvasId };
}

function dispatch(extension, command, payload, context) {
  return extension.dispatch({ command, payload, context });
}

function sharedFile(f, relativeName = "共享素材.png") {
  const root = f.fsStore.ensurePublicRoot();
  const node = f.fsStore.createNode({ name: relativeName, type: "file", parentId: root.id, mime: "image/png", size: PNG_BYTES.length });
  f.fsStore.saveBlob(node.id, PNG_BYTES);
  return { root, node };
}

// ── ① 素材库 sync-sources ─────────────────────────────────────────────────
test("syncSources：从 DX 文件节点复制进资产库（sourceKey 去重），第二次同步不新增条目", async () => {
  const f = await fixture();
  const library = f.assetLibrary.ensureDefaultLibrary({ context: f.ctx("admin") }).library;
  const { node } = sharedFile(f);

  const first = await dispatch(f.extension, "canvas/assetLibrary/syncSources", { libraryId: library.id, items: [{ nodeId: node.id, name: "共享素材" }] }, f.ctx("admin"));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.imported, 1);
  const items = f.assetLibrary.getLibrary({ context: f.ctx("admin"), libraryId: library.id }).items;
  const synced = items.find((item) => item.sourceKey === "asset-source:" + node.id);
  assert.ok(synced, "条目必须带稳定 sourceKey");
  assert.match(String(synced.resourceRef), /^openarc-asset:res_/);
  assert.equal(synced.title, "共享素材");

  const second = await dispatch(f.extension, "canvas/assetLibrary/syncSources", { libraryId: library.id, items: [{ nodeId: node.id }] }, f.ctx("admin"));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.imported, 0, "同一来源不得重复建条目");
  assert.equal(f.assetLibrary.getLibrary({ context: f.ctx("admin"), libraryId: library.id }).items.length, items.length);
});

test("syncSources：画布节点复制复用同一 ResourceRef；非 owner / 无文件权限被拒", async () => {
  const f = await fixture();
  const library = f.assetLibrary.ensureDefaultLibrary({ context: f.ctx("admin") }).library;
  const imported = await f.assetLibrary.importAssetItem({ context: f.ctx("admin"), libraryId: library.id, name: "画布素材.png", mime: "image/png", dataUrl: PNG_DATA_URL });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  const attached = f.assetLibrary.attachItemToCanvas({ context: f.ctx("admin"), libraryId: library.id, itemId: imported.item.id, canvasId: f.canvasId, x: 10, y: 10 });
  assert.equal(attached.ok, true, JSON.stringify(attached));

  const secondLibrary = f.assetLibrary.createLibrary({ context: f.ctx("admin"), name: "同步目标" }).library;
  const synced = await dispatch(f.extension, "canvas/assetLibrary/syncSources", { libraryId: secondLibrary.id, items: [{ nodeId: attached.nodeId }] }, f.ctx("admin"));
  assert.equal(synced.ok, true, JSON.stringify(synced));
  assert.equal(synced.imported, 1);
  const item = f.assetLibrary.getLibrary({ context: f.ctx("admin"), libraryId: secondLibrary.id }).items.find((entry) => entry.sourceKey === "asset-source:" + attached.nodeId);
  assert.equal(item.resourceRef, imported.item.resourceRef, "画布节点同步复用同一 ResourceRef");

  // 非 owner：把库设为组织可见，dana 只读 → sync 必须 FORBIDDEN。
  const updated = f.assetLibrary.updateLibrary({ context: f.ctx("admin"), libraryId: secondLibrary.id, visibility: "ORGANIZATION", baseVersion: secondLibrary.version });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  const readOnly = await dispatch(f.extension, "canvas/assetLibrary/syncSources", { libraryId: secondLibrary.id, items: [{ nodeId: attached.nodeId }] }, f.ctx("dana"));
  assert.equal(readOnly.ok, false);
  assert.equal(readOnly.error, "READ_ONLY");

  // 无文件权限：alice 的私有文件，admin 同步必须被拒（不给"管理员默认全可见"的假权限）。
  const systemRoot = f.fsStore.ensureSystemRoot();
  const alicePrivate = f.fsStore.createNode({ name: "alice 私有.png", type: "file", parentId: systemRoot.id, ownerId: f.fx.users.alice, mime: "image/png", size: PNG_BYTES.length });
  f.fsStore.saveBlob(alicePrivate.id, PNG_BYTES);
  const denied = await dispatch(f.extension, "canvas/assetLibrary/syncSources", { libraryId: library.id, items: [{ nodeId: alicePrivate.id }] }, f.ctx("admin"));
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "FORBIDDEN");
});

// ── ② 邀请码 ──────────────────────────────────────────────────────────────
test("邀请码：创建只存 sha256 / 末 4 位提示；兑换后按既有 share 三档获得画布权限", async () => {
  const f = await fixture();
  const created = await dispatch(f.extension, "canvas/invites/create", { canvasId: f.canvasId, permission: "edit" }, f.ctx("admin"));
  assert.equal(created.ok, true, JSON.stringify(created));
  const code = created.code;
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const normalized = code.replace(/-/g, "");
  const row = f.fx.identity.connection.prepare("SELECT * FROM canvas_invites WHERE canvas_id = ?").get(f.canvasId);
  assert.equal(row.code_hash, createHash("sha256").update(normalized).digest("hex"));
  assert.equal(row.code_hash.length, 64);
  assert.equal(row.code_hint, normalized.slice(-4));
  assert.equal(JSON.stringify(row).includes(normalized), false, "数据库行不得包含邀请码明文");
  assert.equal(created.invite.joinCount, 0);

  const redeemed = await dispatch(f.extension, "canvas/invites/redeem", { code: code.toLowerCase() }, f.ctx("alice"));
  assert.equal(redeemed.ok, true, JSON.stringify(redeemed));
  assert.equal(redeemed.permission, "edit");
  const aliceView = f.canvasService.getCanvas({ context: f.ctx("alice"), canvasId: f.canvasId });
  assert.equal(aliceView.ok, true, JSON.stringify(aliceView));
  assert.equal(aliceView.canvas.access.canEdit, true, "edit 邀请应拿到 EDITOR 能力");

  const summary = await dispatch(f.extension, "canvas/invites/get", { canvasId: f.canvasId }, f.ctx("admin"));
  assert.equal(summary.ok, true, JSON.stringify(summary));
  assert.equal(summary.invite.joinCount, 1);

  const revoked = await dispatch(f.extension, "canvas/invites/revoke", { canvasId: f.canvasId }, f.ctx("admin"));
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  const afterRevoke = await dispatch(f.extension, "canvas/invites/redeem", { code }, f.ctx("dana"));
  assert.equal(afterRevoke.ok, false);
  assert.equal(afterRevoke.error, "NOT_FOUND");
});

test("邀请码：非法格式 / 跨组织兑换 / 非管理员创建全部结构化拒绝", async () => {
  const f = await fixture();
  const malformed = await dispatch(f.extension, "canvas/invites/redeem", { code: "abc" }, f.ctx("alice"));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error, "INVALID_INPUT");

  const created = await dispatch(f.extension, "canvas/invites/create", { canvasId: f.canvasId, permission: "read" }, f.ctx("admin"));
  assert.equal(created.ok, true, JSON.stringify(created));
  const crossOrg = await dispatch(f.extension, "canvas/invites/redeem", { code: created.code }, f.ctx("bob"));
  assert.equal(crossOrg.ok, false);
  assert.equal(crossOrg.error, "FORBIDDEN");

  const sharedWithDana = f.canvasService.shareCanvas({ context: f.ctx("admin"), canvasId: f.canvasId, userId: f.fx.users.dana, role: "VIEWER" });
  assert.equal(sharedWithDana.ok, true, JSON.stringify(sharedWithDana));
  const byMember = await dispatch(f.extension, "canvas/invites/create", { canvasId: f.canvasId, permission: "read" }, f.ctx("dana"));
  assert.equal(byMember.ok, false);
  assert.equal(byMember.error, "READ_ONLY");

  const badPermission = await dispatch(f.extension, "canvas/invites/create", { canvasId: f.canvasId, permission: "owner" }, f.ctx("admin"));
  assert.equal(badPermission.ok, false);
  assert.equal(badPermission.error, "INVALID_INPUT");
});

// ── ③ 画布插件数据 / 受控网络 ─────────────────────────────────────────────
function pluginFixture() {
  const root = tempDir("oa-canvas-plugin-");
  const dataRoot = path.join(root, "dxos");
  const packagePath = path.join("developer-apps", "packages", "demo", "rel-1", "source");
  const sourceDir = path.join(dataRoot, packagePath);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "nodes.json"), JSON.stringify({ nodes: [
    { type: "demo.node", title: "样例", host: { storage: { enabled: true, maxBytes: 2048 } } },
  ] }), "utf8");
  const state = { installed: true, canvas: true, storage: true };
  const developerStore = {
    getInstalled: () => (state.installed ? { appId: "demo" } : null),
    currentRelease: () => ({ packagePath }),
    readRelease: () => ({ manifest: {
      id: "demo",
      ...(state.canvas ? { canvas: { nodeManifests: [state.storage ? "nodes.json" : "missing.json"] } } : {}),
      network: { domains: ["api.example.com"], methods: ["GET"], maxResponseBytes: 4096 },
    } }),
  };
  const calls = [];
  const developerService = {
    execute: async (command, payload, ctx) => {
      calls.push({ command, payload, ctx });
      if (payload.url && payload.url.includes("blocked")) return { ok: false, error: "DEVELOPER_NETWORK_BLOCKED", detail: "域名未在白名单" };
      return { ok: true, value: { status: 200, ok: true, url: payload.url, body: { ok: true } } };
    },
  };
  return { root, dataRoot, state, developerStore, developerService, calls };
}

test("插件数据：set/get/list/delete 真实落盘；key / 容量 / 安装状态全部受控", async () => {
  const f = await fixture();
  const p = pluginFixture();
  const host = createCanvasPluginHost({ developerStore: p.developerStore, developerService: p.developerService, dataRoot: p.dataRoot, clock: () => Date.now() });
  f.extension.configurePlugins({ pluginHost: host });

  const set = await dispatch(f.extension, "canvas/plugins/data", { pluginId: "demo", action: "set", key: "settings", value: { theme: "dark", n: 3 } }, f.ctx("admin"));
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.saved, true);
  assert.ok(set.bytes > 0);
  assert.equal(JSON.stringify(set).includes(p.root), false, "响应不得含绝对路径");

  const got = await dispatch(f.extension, "canvas/plugins/data", { pluginId: "demo", action: "get", key: "settings" }, f.ctx("admin"));
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.deepEqual(got.value, { theme: "dark", n: 3 });
  assert.equal(got.exists, true);

  const listed = await dispatch(f.extension, "canvas/plugins/data", { pluginId: "demo", action: "list" }, f.ctx("admin"));
  assert.deepEqual(listed.keys, ["settings"]);

  const removed = await dispatch(f.extension, "canvas/plugins/data", { pluginId: "demo", action: "delete", key: "settings" }, f.ctx("admin"));
  assert.equal(removed.deleted, true);
  const missing = await dispatch(f.extension, "canvas/plugins/data", { pluginId: "demo", action: "get", key: "settings" }, f.ctx("admin"));
  assert.equal(missing.exists, false);
  assert.equal(missing.value, null);

  const badKey = await dispatch(f.extension, "canvas/plugins/data", { pluginId: "demo", action: "set", key: "../escape", value: 1 }, f.ctx("admin"));
  assert.equal(badKey.ok, false);
  assert.equal(badKey.error, "INVALID_INPUT");
  const tooBig = await dispatch(f.extension, "canvas/plugins/data", { pluginId: "demo", action: "set", key: "big", value: "x".repeat(4096) }, f.ctx("admin"));
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.error, "LIMIT_EXCEEDED");

  p.state.installed = false;
  const notInstalled = await dispatch(f.extension, "canvas/plugins/data", { pluginId: "demo", action: "list" }, f.ctx("admin"));
  assert.equal(notInstalled.ok, false);
  assert.equal(notInstalled.error, "FORBIDDEN");
  p.state.installed = true;
  p.state.canvas = false;
  const notCanvas = await dispatch(f.extension, "canvas/plugins/data", { pluginId: "demo", action: "list" }, f.ctx("admin"));
  assert.equal(notCanvas.ok, false);
  assert.equal(notCanvas.error, "FORBIDDEN");
  p.state.canvas = true;
  p.state.storage = false;
  const noStorage = await dispatch(f.extension, "canvas/plugins/data", { pluginId: "demo", action: "list" }, f.ctx("admin"));
  assert.equal(noStorage.ok, false);
  assert.equal(noStorage.error, "FORBIDDEN", "Manifest 未声明 host.storage 时不得落盘");
});

test("main.cjs 装配契约：fs 晚绑定、插件宿主晚绑定、platform 注入同一份 fsStore", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "electron", "runtime-composition.cjs"), "utf8");
  assert.ok(main.includes("canvasAssetLibrary.configureFs(dxosFsAdapter ? dxosFsAdapter.store : null)"), "素材库必须晚绑定 DX 虚拟文件树");
  assert.ok(main.includes('require("./canvas-dxos-plugins.cjs")'), "main.cjs 必须装配画布插件宿主");
  assert.ok(main.includes("createCanvasPluginHost({"), "插件宿主必须由真实 developerStore/developerService 构造");
  assert.ok(main.includes("configurePlugins({ pluginHost: canvasPluginHost })"), "插件宿主必须晚绑定到 canvas 扩展");
  const platformCall = main.slice(main.indexOf("platformBundle = createPlatformBundle({"), main.indexOf("registerPlatformIpc({"));
  assert.ok(platformCall.includes("fsStore: dxosFsAdapter ? dxosFsAdapter.store : null"), "platform 共享盘桥必须复用同一份 DX 虚拟文件树");
});

test("插件网络：委托既有 developer/network/request；未绑定宿主 / 策略拒绝结构化返回", async () => {
  const f = await fixture();
  const before = await dispatch(f.extension, "canvas/plugins/network", { pluginId: "demo", request: { url: "https://api.example.com/x" } }, f.ctx("admin"));
  assert.equal(before.ok, false);
  assert.equal(before.error, "DEPENDENCY_UNAVAILABLE");

  const p = pluginFixture();
  const host = createCanvasPluginHost({ developerStore: p.developerStore, developerService: p.developerService, dataRoot: p.dataRoot });
  f.extension.configurePlugins({ pluginHost: host });
  const ok = await dispatch(f.extension, "canvas/plugins/network", { pluginId: "demo", request: { url: "https://api.example.com/x", method: "GET" } }, f.ctx("admin"));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.response.status, 200);
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].command, "developer/network/request");
  assert.equal(p.calls[0].payload.appId, "demo");
  assert.equal(p.calls[0].ctx.sessionRef, f.fx.sessions.admin);

  const blocked = await dispatch(f.extension, "canvas/plugins/network", { pluginId: "demo", request: { url: "https://blocked.example.com/x" } }, f.ctx("admin"));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "DEVELOPER_NETWORK_BLOCKED");
});
