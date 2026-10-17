/** task-63 · 资源详情下载/媒体元数据/来源分组 + video-generation 默认模型。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";
import { createModelFixture } from "./model-fixtures.mjs";

const require = createRequire(import.meta.url);
const { RENDERER_COMMANDS, registerResourceIpc } = require("../electron/resource-bootstrap.cjs");
const modelDomain = require("../electron/model-domain.cjs");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const roots = [];
function tempDir(prefix) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(dir); return dir; }
test.after(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });

function box(type, body) { const size = 8 + body.length; const out = Buffer.alloc(size); out.writeUInt32BE(size, 0); out.write(type, 4, 4, "latin1"); body.copy(out, 8); return out; }
function syntheticMp4({ width = 640, height = 360, durationMs = 5000 } = {}) {
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt8(0, 0); mvhd.writeUInt32BE(0, 4); mvhd.writeUInt32BE(0, 8);
  mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(durationMs, 16);
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt8(0, 0);
  tkhd.writeUInt32BE(width * 65536, 76); tkhd.writeUInt32BE(height * 65536, 80);
  const trak = box("trak", box("tkhd", tkhd));
  return Buffer.concat([box("ftyp", Buffer.from("isom")), box("moov", Buffer.concat([box("mvhd", mvhd), trak]))]);
}

test("model defaults：video-generation 可 set / resolve，且是合法 model capability", async () => {
  assert.ok(modelDomain.CAPABILITIES.includes("video-generation"));
  const f = await createModelFixture();
  try {
    const admin = f.adminCtx();
    f.store.upsertApp({ appId: "settings", name: "设置", publisher: "builtin", status: "enabled", builtIn: 1 });
    f.modelService.grantAppModelAccess({ context: { ...admin, appId: "settings" }, appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });
    const ctx = { ...admin, appId: "settings" };
    const provider = f.modelService.createProvider({ context: ctx, displayName: "local-video", baseUrl: "http://127.0.0.1:1/v1", allowLan: true });
    assert.equal(provider.ok, true, JSON.stringify(provider));
    const model = f.modelService.createModel({ context: ctx, providerId: provider.provider.providerId, remoteModelId: "video-1", displayName: "Video", capabilities: ["video-generation"] });
    assert.equal(model.ok, true, JSON.stringify(model));
    const set = f.modelService.setDefault({ context: ctx, capability: "video-generation", configId: model.model.configId, scope: "PERSONAL" });
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.equal(set.capability, "video-generation");
    const resolved = f.modelService.resolveModel({ context: ctx, capability: "video-generation" });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    assert.equal(resolved.snapshot.modelId, "video-1");
    assert.deepEqual(resolved.snapshot.capabilities, ["video-generation"]);
  } finally { f.close(); }
});

test("resource/get：图片尺寸为真值；无法解析/非媒体为 unknown，绝不造假", async () => {
  const f = await createResourceFixture();
  try {
    const pngPath = path.join(tempDir("oa-task63-img-"), "pixel.png");
    fs.writeFileSync(pngPath, PNG);
    const imported = await f.resourceService.importManaged({ context: f.adminCtx(), sourcePath: pngPath, name: "pixel.png", mimeType: "image/png" });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    const detail = f.resourceService.get({ context: f.adminCtx(), resourceRef: imported.resource.resourceId });
    assert.equal(detail.ok, true, JSON.stringify(detail));
    assert.equal(detail.media.kind, "image");
    assert.equal(detail.media.width, 1);
    assert.equal(detail.media.height, 1);
    assert.equal(detail.media.status, "known");
    assert.equal(detail.sourceInfo.origin, "import");
    assert.ok(detail.sourceInfo.storage && detail.sourceInfo.storage.kind === "managed");
    assert.equal(JSON.stringify(detail).includes(f.storeRoot), false, "详情不得泄漏绝对路径");

    const textRef = await f.resourceService.importText({ context: f.adminCtx(), text: "hello", name: "a.txt" });
    const textDetail = f.resourceService.get({ context: f.adminCtx(), resourceRef: textRef.resource.resourceId });
    assert.equal(textDetail.media.kind, "unknown");
    assert.equal(textDetail.media.width, null);
    assert.equal(textDetail.media.height, null);
    assert.equal(textDetail.media.durationMs, null);
    assert.equal(textDetail.media.status, "unknown");
  } finally { f.close(); }
});

test("resource/get：视频时长/尺寸可从 MP4 真值读取；损坏文件 unknown", async () => {
  const f = await createResourceFixture();
  try {
    const good = path.join(tempDir("oa-task63-video-"), "clip.mp4");
    fs.writeFileSync(good, syntheticMp4({ width: 640, height: 360, durationMs: 5000 }));
    const imported = await f.resourceService.importManaged({ context: f.adminCtx(), sourcePath: good, name: "clip.mp4", mimeType: "video/mp4" });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    const detail = f.resourceService.get({ context: f.adminCtx(), resourceRef: imported.resource.resourceId });
    assert.equal(detail.media.kind, "video");
    assert.equal(detail.media.durationMs, 5000);
    assert.equal(detail.media.width, 640);
    assert.equal(detail.media.height, 360);
    assert.equal(detail.media.status, "known");

    const bad = path.join(tempDir("oa-task63-bad-"), "bad.mp4");
    fs.writeFileSync(bad, Buffer.from("not a video"));
    const broken = await f.resourceService.importManaged({ context: f.adminCtx(), sourcePath: bad, name: "bad.mp4", mimeType: "video/mp4" });
    const brokenDetail = f.resourceService.get({ context: f.adminCtx(), resourceRef: broken.resource.resourceId });
    assert.equal(brokenDetail.media.status, "unknown");
    assert.equal(brokenDetail.media.durationMs, null);
  } finally { f.close(); }
});

test("resource/get：来源/集合/项目/画布节点可用于分组定位", async () => {
  const f = await createResourceFixture();
  try {
    const collection = f.resourceService.createCollection({ context: f.adminCtx(), name: "参考图" });
    assert.equal(collection.ok, true, JSON.stringify(collection));
    const imagePath = path.join(tempDir("oa-task63-group-"), "pixel.png");
    fs.writeFileSync(imagePath, PNG);
    const imported = await f.resourceService.importManaged({ context: f.adminCtx(), sourcePath: imagePath, name: "pixel.png", mimeType: "image/png", collectionId: collection.collection.collectionId });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    const ref = imported.resource.resourceId;

    const board = f.canvasService.createBoard({ context: f.adminCtx(), name: "主画布" });
    assert.equal(board.ok, true, JSON.stringify(board));
    const node = f.canvasService.addResourceNode({ context: f.adminCtx(), boardId: board.board.id, resourceRef: ref, x: 12, y: 34 });
    assert.equal(node.ok, true, JSON.stringify(node));
    const project = f.projectService.createProject({ context: f.adminCtx(), name: "项目 A" });
    assert.equal(project.ok, true, JSON.stringify(project));
    const link = f.projectService.addResource({ context: f.adminCtx(), projectId: project.project.id, resourceRef: ref });
    assert.equal(link.ok, true, JSON.stringify(link));

    const detail = f.resourceService.get({ context: f.adminCtx(), resourceRef: ref });
    assert.equal(detail.collection.collectionId, collection.collection.collectionId);
    assert.equal(detail.collection.name, "参考图");
    assert.deepEqual(detail.projects.map((p) => p.projectId), [project.project.id]);
    assert.equal(detail.canvasNodes.length, 1);
    assert.equal(detail.canvasNodes[0].boardName, "主画布");
    assert.equal(detail.canvasNodes[0].nodeId, node.node.id);
    assert.equal(detail.canvasNodes[0].x, 12);
    assert.equal(detail.canvasNodes[0].y, 34);
    assert.equal(detail.sourceInfo.origin, "import");
  } finally { f.close(); }
});

test("resource/download：返回安全 base64/dataUrl 且有界；超限结构化拒绝", async () => {
  assert.ok(RENDERER_COMMANDS.includes("resource/download"));
  const f = await createResourceFixture();
  try {
    const imagePath = path.join(tempDir("oa-task63-dl-"), "pixel.png");
    fs.writeFileSync(imagePath, PNG);
    const imported = await f.resourceService.importManaged({ context: f.adminCtx(), sourcePath: imagePath, name: "pixel.png", mimeType: "image/png" });
    const ref = imported.resource.resourceId;
    const out = await f.resourceService.exportBytes({ context: f.adminCtx(), resourceRef: ref });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.mimeType, "image/png");
    assert.equal(out.size, PNG.length);
    assert.equal(out.dataUrl, "data:image/png;base64," + PNG.toString("base64"));
    assert.equal(JSON.stringify(out).includes(f.storeRoot), false);
    const tooLarge = await f.resourceService.exportBytes({ context: f.adminCtx(), resourceRef: ref, maxBytes: 1 });
    assert.equal(tooLarge.ok, false);
    assert.equal(tooLarge.error, "RESOURCE_TOO_LARGE");
    const ipc = { handlers: new Map(), handle(ch, fn) { this.handlers.set(ch, fn); }, removeHandler(ch) { this.handlers.delete(ch); } };
    registerResourceIpc({ ipcMain: ipc, service: f.resourceService, identity: { current: f.sessions.admin }, isTrusted: () => true });
    const viaCommand = await ipc.handlers.get("resource:command")({}, { type: "resource/download", resourceRef: ref });
    assert.equal(viaCommand.ok, true, JSON.stringify(viaCommand));
    assert.equal(viaCommand.dataUrl, "data:image/png;base64," + PNG.toString("base64"));
    const foreign = f.ctx("bob");
    const denied = await f.resourceService.exportBytes({ context: foreign, resourceRef: ref });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "NOT_FOUND_OR_FORBIDDEN");
  } finally { f.close(); }
});
