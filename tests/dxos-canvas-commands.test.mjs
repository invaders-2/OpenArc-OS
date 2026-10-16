import { fileURLToPath } from "node:url";
/**
 * B5c · 命令面（扩展既有 canvas:command，不新建画布域、不新增顶层 preload 键）。
 * 被测：electron/canvas-dxos-commands.cjs 与五个域模块的真实装配（全离线）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const commands = require("../electron/canvas-dxos-commands.cjs");
const canvasBootstrap = require("../electron/canvas-bootstrap.cjs");
const { CanvasDxosStore } = require("../electron/canvas-dxos-store.cjs");
const { CanvasAssetLibraryService } = require("../electron/canvas-dxos-asset-library.cjs");
const { CanvasAgentAttachmentService } = require("../electron/canvas-dxos-agent-attachments.cjs");
const { CanvasStore } = require("../electron/canvas-store.cjs");
const { CanvasService } = require("../electron/canvas-service.cjs");

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_DATA_URL = "data:image/png;base64," + PNG_BASE64;
const ALLOWED_RISKS = new Set(["read", "write", "delete", "external"]);

async function fixture() {
  const fx = await createResourceFixture();
  const store = new CanvasDxosStore({ identity: fx.identity, clock: fx.clock });
  const canvasStore = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const canvasService = new CanvasService({ identity: fx.identity, store: canvasStore, resourceStore: fx.resourceStore, resourceService: fx.resourceService, authService: fx.authService, clock: fx.clock });
  const tempDir = () => path.join(fx.storeRoot, "tmp");
  const assetLibrary = new CanvasAssetLibraryService({ identity: fx.identity, store, resourceService: fx.resourceService, resourceStore: fx.resourceStore, canvasService, clock: fx.clock, tempDir });
  const attachmentService = new CanvasAgentAttachmentService({ identity: fx.identity, store, canvasService, resourceService: fx.resourceService, clock: fx.clock, tempDir });
  const extension = commands.createCanvasDxosExtension({ identity: fx.identity, store, canvasService, resourceService: fx.resourceService, assetLibrary, attachments: attachmentService, tempDir, clock: fx.clock });
  const ctx = (key, extra = {}) => ({ sessionRef: fx.sessions[key], appId: "canvas", source: "ui", ...extra });
  const canvas = canvasService.createCanvas({ context: ctx("admin"), title: "命令画布" });
  assert.equal(canvas.ok, true, JSON.stringify(canvas));
  const identityView = { current: fx.sessions.admin };
  return { fx, store, canvasService, assetLibrary, attachmentService, extension, ctx, identityView, canvasId: canvas.canvas.canvasId };
}

test("命令登记：每条都有中文 summary / risk / credential；与既有白名单合并无重复", () => {
  const list = commands.describeCommands();
  assert.ok(list.length >= 20);
  const seen = new Set();
  for (const entry of list) {
    assert.match(entry.command, /^canvas\/[A-Za-z]+\/[A-Za-z]+$/);
    assert.ok(!seen.has(entry.command), "命令重复：" + entry.command);
    seen.add(entry.command);
    assert.ok(ALLOWED_RISKS.has(entry.risk), "非法 risk：" + entry.command + " → " + entry.risk);
    assert.equal(entry.credential, "none", "画布命令不得持有凭据：" + entry.command);
    assert.ok(typeof entry.summary === "string" && /[\u4e00-\u9fa5]/.test(entry.summary), "summary 必须中文：" + entry.command);
  }
  for (const entry of commands.DXOS_CANVAS_COMMANDS) assert.ok(entry.summary.length >= 6, "summary 过短：" + entry.command);
  const merged = commands.extendRendererCommands(canvasBootstrap.RENDERER_COMMANDS);
  assert.equal(new Set(merged).size, merged.length, "合并后不得重复");
  for (const base of canvasBootstrap.RENDERER_COMMANDS) assert.ok(merged.includes(base), "既有命令不能丢：" + base);
  for (const entry of list) assert.ok(merged.includes(entry.command), "新增命令必须进白名单：" + entry.command);
});

test("命令表与 REGISTRY / handlers 完全一致：无未登记 handler、无登记未实现（B5f 死 handler 收口）", async () => {
  const f = await fixture();
  try {
    const registryNames = commands.DXOS_CANVAS_COMMANDS.map((entry) => entry.command);
    const handlerNames = Object.keys(f.extension.handlers);
    assert.deepEqual([...handlerNames].sort(), [...registryNames].sort(), "handlers 与命令表必须一一对应（无死 handler / 无登记未实现）");
    for (const entry of commands.DXOS_CANVAS_COMMANDS) {
      assert.equal(commands.REGISTRY.has(entry.command), true, "REGISTRY 缺少 " + entry.command);
      assert.equal(typeof f.extension.handlers[entry.command], "function", "登记未实现：" + entry.command);
    }
    // B5f 新增登记的两条都真实可分发。
    assert.ok(registryNames.includes("canvas/collab/sweep"), "canvas/collab/sweep 必须登记进命令表");
    assert.ok(registryNames.includes("canvas/assetLibrary/update"), "canvas/assetLibrary/update 必须登记进命令表");
    const swept = f.extension.dispatch({ command: "canvas/collab/sweep", payload: {}, context: f.ctx("admin") });
    assert.equal(swept.ok, true, JSON.stringify(swept));
    const ensured = f.extension.dispatch({ command: "canvas/assetLibrary/ensure", payload: {}, context: f.ctx("admin") });
    assert.equal(ensured.ok, true, JSON.stringify(ensured));
    const updated = f.extension.dispatch({ command: "canvas/assetLibrary/update", payload: { libraryId: ensured.library.id, name: "命令改名", baseVersion: ensured.library.version }, context: f.ctx("admin") });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.library.name, "命令改名");
    assert.equal(updated.library.version, ensured.library.version + 1);
  } finally { f.fx.close(); }
});

test("未登记命令一律拒绝（不新建通道、不放行任意命令）", async () => {
  const f = await fixture();
  try {
    const denied = f.extension.dispatch({ command: "canvas/evil/do", payload: {}, context: f.ctx("admin") });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "CANVAS_COMMAND_NOT_ALLOWED");
    const none = f.extension.dispatch({ command: "canvas/get", payload: { canvasId: f.canvasId }, context: f.ctx("admin") });
    assert.equal(none.ok, false, "扩展只处理自己登记的命令，既有命令仍走 canvas-bootstrap");
    assert.equal(none.error, "CANVAS_COMMAND_NOT_ALLOWED");
  } finally { f.fx.close(); }
});

test("combineCanvasCommandHandlers：trusted 边界 + 先扩展后回落既有处理器", async () => {
  const f = await fixture();
  try {
    const baseCalls = [];
    const base = async (event, raw) => { baseCalls.push(raw.command); return { ok: true, fromBase: true }; };
    const handler = commands.combineCanvasCommandHandlers({ base, extension: f.extension, identity: f.identityView, isTrusted: (event) => event && event.trusted === true });
    await assert.rejects(() => handler({ trusted: false }, { command: "canvas/capabilities/list" }), /Forbidden/);
    const handled = await handler({ trusted: true }, { command: "canvas/capabilities/list", payload: {} });
    assert.equal(handled.ok, true);
    assert.ok(handled.projection.capabilities.length > 5);
    assert.deepEqual(baseCalls, [], "扩展命令不应落到 base");
    const fallback = await handler({ trusted: true }, { command: "canvas/get", payload: { canvasId: f.canvasId } });
    assert.deepEqual(fallback, { ok: true, fromBase: true });
    assert.deepEqual(baseCalls, ["canvas/get"]);
    const bad = await handler({ trusted: true }, null);
    assert.equal(bad.error, "INVALID_INPUT");
  } finally { f.fx.close(); }
});

test("registerCanvasDxosIpc：只注册一个 canvas:command，且能路由到扩展", async () => {
  const f = await fixture();
  try {
    const ipcMain = { handlers: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); }, removeHandler(channel) { this.handlers.delete(channel); } };
    commands.registerCanvasDxosIpc({ ipcMain, extension: f.extension, identity: f.identityView, isTrusted: () => true });
    assert.equal(ipcMain.handlers.size, 1);
    assert.ok(ipcMain.handlers.has("canvas:command"));
    const result = await ipcMain.handlers.get("canvas:command")({ trusted: true }, { command: "canvas/assetLibrary/list", payload: {} });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(Array.isArray(result.libraries));
    // 二次注册不会抛（先 removeHandler 再 handle）
    commands.registerCanvasDxosIpc({ ipcMain, extension: f.extension, identity: f.identityView, isTrusted: () => true });
    assert.equal(ipcMain.handlers.size, 1);
  } finally { f.fx.close(); }
});

test("素材库命令面：ensure → import → get → reference → attach（同一 ResourceRef 口径）", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("admin");
    const ensured = f.extension.dispatch({ command: "canvas/assetLibrary/ensure", payload: {}, context: ctx });
    assert.equal(ensured.ok, true, JSON.stringify(ensured));
    const libraryId = ensured.library.id;
    const imported = await f.extension.dispatch({ command: "canvas/assetLibrary/import", payload: { libraryId, name: "cmd.png", mime: "image/png", dataUrl: PNG_DATA_URL }, context: ctx });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    const ref = f.extension.dispatch({ command: "canvas/assetLibrary/reference", payload: { libraryId, itemId: imported.item.id }, context: ctx });
    assert.equal(ref.ok, true);
    assert.equal(ref.ref, imported.item.resourceRef);
    const attached = f.extension.dispatch({ command: "canvas/assetLibrary/attach", payload: { libraryId, itemId: imported.item.id, canvasId: f.canvasId, x: 1, y: 2 }, context: ctx });
    assert.equal(attached.ok, true, JSON.stringify(attached));
    const listed = f.extension.dispatch({ command: "canvas/assetLibrary/items", payload: { libraryId, kind: "asset" }, context: ctx });
    assert.equal(listed.items.length, 1);
  } finally { f.fx.close(); }
});

test("协作命令面：join / presence / cursor / events（下行走 canvas:command 拉取，不新增 preload 键）", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("admin");
    const joined = f.extension.dispatch({ command: "canvas/collab/join", payload: { canvasId: f.canvasId, clientId: "c1", username: "本人" }, context: ctx });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    assert.equal(joined.peer.userId, f.fx.users.admin);
    assert.equal(joined.peer.canEdit, true);
    const second = f.extension.dispatch({ command: "canvas/collab/join", payload: { canvasId: f.canvasId, clientId: "c2" }, context: ctx });
    assert.equal(second.ok, true);
    const presence = f.extension.dispatch({ command: "canvas/collab/presence", payload: { canvasId: f.canvasId }, context: ctx });
    assert.equal(presence.presence.users.length, 2);
    const cursor = f.extension.dispatch({ command: "canvas/collab/cursor", payload: { canvasId: f.canvasId, clientId: "c1", x: 5, y: 6 }, context: ctx });
    assert.equal(cursor.ok, true);
    assert.deepEqual(cursor.message.to, ["c2"]);
    const drained = f.extension.dispatch({ command: "canvas/collab/events", payload: { canvasId: f.canvasId, clientId: "c2" }, context: ctx });
    assert.equal(drained.events.length, 1);
    assert.equal(drained.events[0].type, "cursor");
    assert.equal(f.extension.dispatch({ command: "canvas/collab/events", payload: { canvasId: f.canvasId, clientId: "c2" }, context: ctx }).events.length, 0, "事件拉取后清空");
    // 未授权画布不能让陌生人进房
    const deniedJoin = f.extension.dispatch({ command: "canvas/collab/join", payload: { canvasId: "cv_nope", clientId: "c9" }, context: ctx });
    assert.equal(deniedJoin.ok, false);
    const left = f.extension.dispatch({ command: "canvas/collab/leave", payload: { canvasId: f.canvasId, clientId: "c1" }, context: ctx });
    assert.equal(left.ok, true);
    assert.equal(left.presence.users.length, 1);
  } finally { f.fx.close(); }
});

test(".dxcanvas 命令面：export → import 往返，失败不留半成品", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("admin");
    const ensured = f.extension.dispatch({ command: "canvas/assetLibrary/ensure", payload: {}, context: ctx });
    const libraryId = ensured.library.id;
    const imported = await f.extension.dispatch({ command: "canvas/assetLibrary/import", payload: { libraryId, name: "pkg.png", mime: "image/png", dataUrl: PNG_DATA_URL }, context: ctx });
    const attached = f.extension.dispatch({ command: "canvas/assetLibrary/attach", payload: { libraryId, itemId: imported.item.id, canvasId: f.canvasId, x: 0, y: 0 }, context: ctx });
    assert.equal(attached.ok, true, JSON.stringify(attached));
    const exported = f.extension.dispatch({ command: "canvas/package/export", payload: { canvasId: f.canvasId }, context: ctx });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.equal(exported.format, "dx-canvas-package/v1");
    assert.equal(exported.sha256.length, 64);
    const before = f.canvasService.listCanvases({ context: ctx }).items.length;
    const importedCanvas = await f.extension.dispatch({ command: "canvas/package/import", payload: { base64: exported.base64 }, context: ctx });
    assert.equal(importedCanvas.ok, true, JSON.stringify(importedCanvas));
    assert.equal(importedCanvas.importedAssets, 1);
    assert.equal(f.canvasService.listCanvases({ context: ctx }).items.length, before + 1);
    const got = f.canvasService.getCanvas({ context: ctx, canvasId: importedCanvas.canvasId });
    assert.equal(got.canvas.doc.nodes.length, 1);
    const node = got.canvas.doc.nodes[0];
    const newRef = node.refs ? node.refs[0] : node.url;
    assert.match(newRef, /^openarc-asset:res_/);
    assert.notEqual(newRef, imported.item.resourceRef, "导入必须换成新的 ResourceRef");
    assert.equal(f.canvasService.readAsset({ context: ctx, ref: newRef.replace("openarc-asset:", "") }).ok, true, "导入后的素材必须可读");
    // 坏包：明确失败且不留下新画布
    const failed = await f.extension.dispatch({ command: "canvas/package/import", payload: { base64: Buffer.from("not-a-zip").toString("base64") }, context: ctx });
    assert.equal(failed.ok, false);
    assert.equal(f.canvasService.listCanvases({ context: ctx }).items.length, before + 1, "失败导入不得留下半成品画布");
  } finally { f.fx.close(); }
});

test("Agent 附件命令面：extract（不落盘）/ mount / list / unmount", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("admin");
    const base64 = Buffer.from("# 产物\n内容").toString("base64");
    const extracted = f.extension.dispatch({ command: "canvas/agentAttachments/extract", payload: { files: [{ name: "out.md", mime: "text/markdown", base64 }] }, context: ctx });
    assert.equal(extracted.ok, true, JSON.stringify(extracted));
    assert.match(extracted.attachments[0].content, /产物/);
    assert.equal(f.store.attachmentsOfCanvas(f.canvasId).length, 0, "extract 不得落库");
    const mounted = await f.extension.dispatch({ command: "canvas/agentAttachments/mount", payload: { canvasId: f.canvasId, runId: "run_x", files: [{ name: "out.md", mime: "text/markdown", base64 }] }, context: ctx });
    assert.equal(mounted.ok, true, JSON.stringify(mounted));
    assert.equal(mounted.attachments.length, 1);
    const listed = f.extension.dispatch({ command: "canvas/agentAttachments/list", payload: { canvasId: f.canvasId }, context: ctx });
    assert.equal(listed.attachments.length, 1);
    assert.equal(listed.attachments[0].runId, "run_x");
    const unmounted = f.extension.dispatch({ command: "canvas/agentAttachments/unmount", payload: { canvasId: f.canvasId, attachmentId: listed.attachments[0].attachmentId }, context: ctx });
    assert.equal(unmounted.ok, true, JSON.stringify(unmounted));
    assert.equal(f.extension.dispatch({ command: "canvas/agentAttachments/list", payload: { canvasId: f.canvasId }, context: ctx }).attachments.length, 0);
  } finally { f.fx.close(); }
});

test("检查项：模块不引用云与商业化符号（dxosProtocol / apiQuota / cloudEntitlement / publicMedia / api.dx-os.com）", () => {
  const fs = require("node:fs");
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "electron");
  const names = fs.readdirSync(dir).filter((name) => name.startsWith("canvas-dxos-"));
  assert.ok(names.length >= 7, "应有七个以上画布域模块，实测 " + names.length);
  const banned = ["dxosProtocol", "apiQuota", "cloudEntitlement", "publicMedia", "api.dx-os.com", "canvasCloudSync", "dx-canvas-cloud", "cloudSync"];
  for (const name of names) {
    // 只扫代码，不扫注释：注释里出现的 OUT 说明是任务书要求的"逐条注明"，不是引用。
    const code = fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("*") && !trimmed.startsWith("/*") && !trimmed.startsWith("//");
    }).join("\n");
    for (const symbol of banned) assert.equal(code.includes(symbol), false, name + " 不得引用云/商业化符号 " + symbol);
  }
});
