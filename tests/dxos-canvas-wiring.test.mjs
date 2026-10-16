/**
 * B5d · 画布域接线（既有 canvas:command 扩展 + 迁移号 + 能力来源）。
 * 被测：electron/canvas-bootstrap.cjs / electron/agent-service.cjs（产品真实代码与真实装配）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const canvasBootstrap = require("../electron/canvas-bootstrap.cjs");
const commands = require("../electron/canvas-dxos-commands.cjs");
const agentService = require("../electron/agent-service.cjs");
const catalog = require("../electron/agent-tool-catalog.cjs");
const { CanvasDxosStore } = require("../electron/canvas-dxos-store.cjs");
const { CanvasAssetLibraryService } = require("../electron/canvas-dxos-asset-library.cjs");
const { CanvasAgentAttachmentService } = require("../electron/canvas-dxos-agent-attachments.cjs");
const { CanvasStore } = require("../electron/canvas-store.cjs");
const { CanvasService } = require("../electron/canvas-service.cjs");

/** 与 dxos-canvas-commands.test.mjs 同形的真实装配（同一条 identity 连接 + 同一个 canvasService）。 */
async function fixture() {
  const fx = await createResourceFixture();
  const store = new CanvasDxosStore({ identity: fx.identity, clock: fx.clock });
  const canvasStore = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const canvasService = new CanvasService({ identity: fx.identity, store: canvasStore, resourceStore: fx.resourceStore, resourceService: fx.resourceService, authService: fx.authService, clock: fx.clock });
  const tempDir = () => path.join(fx.storeRoot, "tmp");
  const assetLibrary = new CanvasAssetLibraryService({ identity: fx.identity, store, resourceService: fx.resourceService, resourceStore: fx.resourceStore, canvasService, clock: fx.clock, tempDir });
  const attachmentService = new CanvasAgentAttachmentService({ identity: fx.identity, store, canvasService, resourceService: fx.resourceService, clock: fx.clock, tempDir });
  const extension = commands.createCanvasDxosExtension({ identity: fx.identity, store, canvasService, resourceService: fx.resourceService, assetLibrary, attachments: attachmentService, tempDir, clock: fx.clock });
  return { fx, canvasService, extension, identityView: { current: fx.sessions.admin } };
}

function fakeIpc() {
  return {
    handlers: new Map(),
    handle(channel, fn) { this.handlers.set(channel, fn); },
    removeHandler(channel) { this.handlers.delete(channel); },
  };
}

test("(a)(c) registerCanvasIpc：扩展命令真实分发、只在 canvas:command 注册一个 handler、未命中回落既有错误码", async () => {
  const f = await fixture();
  try {
    const ipcMain = fakeIpc();
    canvasBootstrap.registerCanvasIpc({ ipcMain, service: f.canvasService, identity: f.identityView, isTrusted: (event) => event && event.trusted === true, extension: f.extension });
    assert.equal(ipcMain.handlers.size, 1, "只允许一个 canvas:command handler");
    assert.ok(ipcMain.handlers.has("canvas:command"));
    const handler = ipcMain.handlers.get("canvas:command");

    // 扩展命令（素材库）经同一条 canvas:command 真实分发
    const listed = await handler({ trusted: true }, { command: "canvas/assetLibrary/list", payload: {} });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.ok(Array.isArray(listed.libraries));

    // 既有命令不受影响，仍走原 switch
    const created = await handler({ trusted: true }, { command: "canvas/create", payload: { title: "接线画布" } });
    assert.equal(created.ok, true, JSON.stringify(created));

    // 未登记命令回落既有错误码
    const denied = await handler({ trusted: true }, { command: "canvas/evil/do", payload: {} });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "CANVAS_COMMAND_NOT_ALLOWED");

    // 位置参数形状的 extension.dispatch(command, payload, ctx) 同样兼容
    const ipcAlt = fakeIpc();
    const positional = [];
    const altExtension = { dispatch: (command, payload, context) => { positional.push([command, context && context.appId]); return { ok: true, fromPositional: command }; } };
    canvasBootstrap.registerCanvasIpc({ ipcMain: ipcAlt, service: f.canvasService, identity: f.identityView, isTrusted: () => true, extension: altExtension });
    const alt = await ipcAlt.handlers.get("canvas:command")({ trusted: true }, { command: "canvas/capabilities/list", payload: {} });
    assert.deepEqual(alt, { ok: true, fromPositional: "canvas/capabilities/list" });
    assert.deepEqual(positional, [["canvas/capabilities/list", "canvas"]]);

    // 二次注册仍是同一个 handler（removeHandler → handle，不叠加通道）
    canvasBootstrap.registerCanvasIpc({ ipcMain, service: f.canvasService, identity: f.identityView, isTrusted: () => true, extension: f.extension });
    assert.equal(ipcMain.handlers.size, 1);
  } finally { f.fx.close(); }
});

test("(a) 未装配 extension：白名单内的扩展命令也不放行（不伪造成功）", async () => {
  const f = await fixture();
  try {
    const ipcMain = fakeIpc();
    canvasBootstrap.registerCanvasIpc({ ipcMain, service: f.canvasService, identity: f.identityView, isTrusted: () => true });
    const result = await ipcMain.handlers.get("canvas:command")({ trusted: true }, { command: "canvas/assetLibrary/list", payload: {} });
    assert.equal(result.ok, false);
    assert.equal(result.error, "CANVAS_COMMAND_NOT_ALLOWED");
  } finally { f.fx.close(); }
});

test("(b) registerCanvasIpc：trusted 边界拒绝伪造 sender", async () => {
  const f = await fixture();
  try {
    const ipcMain = fakeIpc();
    canvasBootstrap.registerCanvasIpc({ ipcMain, service: f.canvasService, identity: f.identityView, isTrusted: (event) => event && event.trusted === true, extension: f.extension });
    const handler = ipcMain.handlers.get("canvas:command");
    await assert.rejects(() => handler({ trusted: false }, { command: "canvas/assetLibrary/list", payload: {} }), /Forbidden/);
    await assert.rejects(() => handler(null, { command: "canvas/assetLibrary/list", payload: {} }), /Forbidden/);
  } finally { f.fx.close(); }
});

test("(e) agent-service：catalogSources.canvas 接线后出现能力描述符；未接线 available:false", async () => {
  const f = await fixture();
  try {
    catalog.resetToolCatalogForTests();
    // 未接线：catalog 保持 app_canvas_registry 的 unavailable 占位。
    agentService.createAgentBundle({ toolCatalog: catalog });
    let snap = catalog.toolCatalogSnapshot({});
    const before = snap.descriptors.filter((d) => d.sourceId === "canvas-kernel");
    assert.equal(before.length, 1);
    assert.equal(before[0].name, "app_canvas_registry");
    assert.equal(before[0].status, "unavailable");
    assert.equal(before[0].executable, false);

    // 接线：同一扩展实例把画布内核能力投影进 catalog。
    agentService.createAgentBundle({ toolCatalog: catalog, canvasExtension: f.extension });
    snap = catalog.toolCatalogSnapshot({});
    const after = snap.descriptors.filter((d) => d.sourceId === "canvas-kernel");
    assert.ok(after.length > 5, "接线后必须有真实画布能力描述符，实测 " + after.length);
    assert.equal(after.some((d) => d.name === "app_canvas_registry"), false, "接线后不得再有 unavailable 占位");
    const read = after.find((d) => d.name === "canvas_read");
    assert.ok(read, "canvas_read 必须在列");
    assert.equal(read.status, "ready");
    assert.equal(read.executable, true);
    assert.equal(read.handler.type, "client");
    assert.equal(read.handler.command, "canvas/read");
    assert.equal(read.domain, "app.canvas");

    // 来源构造器：未装配返回 null（不注册来源键），装配后是同步 {list} 契约。
    assert.equal(agentService.buildCanvasCatalogSource(null), null);
    const source = agentService.buildCanvasCatalogSource(f.extension);
    assert.equal(typeof source.list, "function");
    assert.equal(source.list().length, after.length);
  } finally { f.fx.close(); }
});
