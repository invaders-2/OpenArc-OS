/**
 * task-25 · 画布语义补齐（A07/A10/A11/A13?/A17/A18/A20）逐项验收。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { CanvasDxosStore } = require("../electron/canvas-dxos-store.cjs");
const { CanvasAssetLibraryService } = require("../electron/canvas-dxos-asset-library.cjs");
const { CanvasStore } = require("../electron/canvas-store.cjs");
const { CanvasService } = require("../electron/canvas-service.cjs");
const capabilities = require("../electron/canvas-dxos-capabilities.cjs");
const attachments = require("../electron/canvas-dxos-agent-attachments.cjs");

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_DATA_URL = "data:image/png;base64," + PNG_BASE64;

async function fixture() {
  const fx = await createResourceFixture();
  const store = new CanvasDxosStore({ identity: fx.identity, clock: fx.clock });
  const canvasStore = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const canvasService = new CanvasService({ identity: fx.identity, store: canvasStore, resourceStore: fx.resourceStore, resourceService: fx.resourceService, authService: fx.authService, clock: fx.clock });
  const service = new CanvasAssetLibraryService({
    identity: fx.identity, store, resourceService: fx.resourceService, resourceStore: fx.resourceStore,
    canvasService, clock: fx.clock, tempDir: () => path.join(fx.storeRoot, "tmp"),
  });
  const ctx = (key, extra = {}) => ({ sessionRef: fx.sessions[key], appId: "canvas", source: "ui", ...extra });
  return { fx, store, canvasStore, canvasService, service, ctx };
}

test("A07 · workflow 内媒体递归复制并重写为库内 ResourceRef", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("admin");
    const lib = f.service.ensureDefaultLibrary({ context: ctx }).library;
    const workflow = {
      version: 1,
      cards: [{ id: "c1", inputs: [{ url: PNG_DATA_URL }], params: { prompt: "x" }, result: { url: PNG_DATA_URL }, history: [[PNG_DATA_URL]] }],
    };
    const saved = await f.service.upsertItem({ context: ctx, libraryId: lib.id, item: { kind: "workflow", title: "工作流", workflow } });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const wf = saved.item.workflow;
    const ref = wf.cards[0].inputs[0].url;
    assert.match(ref, /^openarc-asset:res_/);
    assert.equal(wf.cards[0].result.url, ref, "同一份字节复用同一 ResourceRef");
    assert.equal(wf.cards[0].history[0][0], ref);
    const resourceId = ref.slice("openarc-asset:".length);
    assert.ok(f.fx.resourceStore.resourceRowById(resourceId), "媒体必须进资源域");
    const read = f.fx.resourceService.readDataUrl({ context: f.ctx("admin", { appId: "resource-library" }), resourceRef: resourceId });
    assert.equal(read.ok, true);

    const forbidden = await f.service.upsertItem({ context: ctx, libraryId: lib.id, item: { kind: "workflow", title: "坏工作流", workflow: { cards: [{ inputs: [{ url: "openarc-asset:res_missing" }] }] } } });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.error, "FORBIDDEN", "无权限媒体整单拒绝");

    const prompt = await f.service.upsertItem({ context: ctx, libraryId: lib.id, item: { kind: "prompt", title: "普通", prompt: "hello" } });
    assert.equal(prompt.ok, true);
    assert.equal(prompt.item.workflow, undefined, "非 workflow 不受影响");
  } finally { f.fx.close(); }
});

test("A10 · visibility public/restricted + publicAccess + 逐成员 read/edit", async () => {
  const f = await fixture();
  try {
    const admin = f.ctx("admin");
    const alice = f.ctx("alice");
    const bob = f.ctx("bob");
    const restricted = f.service.createLibrary({ context: admin, name: "受限库", visibility: "restricted", publicAccess: "read" }).library;
    assert.equal(restricted.visibility, "RESTRICTED");
    assert.equal(restricted.publicAccess, "READ");
    assert.equal(f.service.getLibrary({ context: alice, libraryId: restricted.id }).error, "NOT_FOUND_OR_FORBIDDEN");
    assert.equal(f.service.updateLibrary({ context: alice, libraryId: restricted.id, name: "x", baseVersion: restricted.version }).error, "NOT_FOUND_OR_FORBIDDEN");

    const readMember = f.service.setMember({ context: admin, libraryId: restricted.id, userId: f.fx.users.alice, role: "read" });
    assert.equal(readMember.ok, true, JSON.stringify(readMember));
    const aliceGet = f.service.getLibrary({ context: alice, libraryId: restricted.id });
    assert.equal(aliceGet.ok, true, JSON.stringify(aliceGet));
    assert.equal(aliceGet.library.access, "read");
    assert.equal(f.service.updateLibrary({ context: alice, libraryId: restricted.id, name: "x", baseVersion: restricted.version }).error, "READ_ONLY");
    const editMember = f.service.setMember({ context: admin, libraryId: restricted.id, userId: f.fx.users.alice, role: "edit" });
    assert.equal(editMember.ok, true);
    const aliceEdited = f.service.updateLibrary({ context: alice, libraryId: restricted.id, name: "受限库-改", baseVersion: restricted.version });
    assert.equal(aliceEdited.ok, true, JSON.stringify(aliceEdited));
    assert.equal(aliceEdited.library.name, "受限库-改");
    assert.equal(f.service.updateLibrary({ context: alice, libraryId: restricted.id, visibility: "public", baseVersion: aliceEdited.library.version }).error, "FORBIDDEN", "edit 成员不能自行放开共享范围");
    assert.equal(f.service.listMembers({ context: alice, libraryId: restricted.id }).error, "NOT_FOUND_OR_FORBIDDEN", "成员不能看成员表");

    const publicLib = f.service.createLibrary({ context: admin, name: "公共库", visibility: "public", publicAccess: "edit" }).library;
    const bobGet = f.service.getLibrary({ context: bob, libraryId: publicLib.id });
    assert.equal(bobGet.ok, true, JSON.stringify(bobGet));
    assert.equal(bobGet.library.access, "edit");
    assert.equal(f.service.updateLibrary({ context: bob, libraryId: publicLib.id, name: "bob改", baseVersion: publicLib.version }).ok, true);

    const removed = f.service.removeMember({ context: admin, libraryId: restricted.id, userId: f.fx.users.alice });
    assert.equal(removed.ok, true);
    assert.equal(f.service.getLibrary({ context: alice, libraryId: restricted.id }).error, "NOT_FOUND_OR_FORBIDDEN");
    const listed = f.service.listLibraries({ context: alice });
    assert.equal(listed.ok, true);
    assert.equal(listed.libraries.some((entry) => entry.id === restricted.id), false);
  } finally { f.fx.close(); }
});

test("A11 · 画布文档引用即读：共享画布后 B 可读；移除引用立即不可读", async () => {
  const f = await fixture();
  try {
    const admin = f.ctx("admin");
    const alice = f.ctx("alice");
    const lib = f.service.ensureDefaultLibrary({ context: admin }).library;
    const imported = await f.service.importAssetItem({ context: admin, libraryId: lib.id, name: "a.png", mime: "image/png", dataUrl: PNG_DATA_URL, title: "图" });
    assert.equal(imported.ok, true);
    const ref = imported.item.resourceRef;
    const resourceId = ref.slice("openarc-asset:".length);
    const created = f.canvasService.createCanvas({ context: admin, title: "共享画布" });
    assert.equal(created.ok, true);
    const add = f.canvasService.applyCommand({
      context: admin, canvasId: created.canvas.canvasId, baseRevision: created.canvas.revision,
      command: { type: "node.add", node: { type: "image", x: 0, y: 0, name: "图", refs: [ref] } }, actorKind: "USER",
    });
    assert.equal(add.ok, true, JSON.stringify(add));
    const before = f.canvasService.readAsset({ context: alice, ref });
    assert.equal(before.error, "ASSET_FORBIDDEN");
    const shared = f.canvasService.shareCanvas({ context: admin, canvasId: created.canvas.canvasId, userId: f.fx.users.alice, role: "VIEWER" });
    assert.equal(shared.ok, true, JSON.stringify(shared));
    const after = f.canvasService.readAsset({ context: alice, ref });
    assert.equal(after.ok, true, JSON.stringify(after));
    assert.match(after.dataUrl, /^data:image\/png;base64,/);
    assert.equal(f.canvasService.readAsset({ context: alice, ref: "openarc-asset:res_adjacent" }).ok, false, "相邻资源不因画布引用而放行");
    const nodeId = add.result.node.id;
    const removed = f.canvasService.applyCommand({
      context: admin, canvasId: created.canvas.canvasId, baseRevision: add.canvas.revision,
      command: { type: "node.delete", ids: [nodeId] }, actorKind: "USER",
    });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(f.canvasService.readAsset({ context: alice, ref }).error, "ASSET_FORBIDDEN");
  } finally { f.fx.close(); }
});

test("A17 · DX 14 个 canvas_* 工具映射清单：mapped/partial/unsupported 有据可查", () => {
  const built = capabilities.buildCanvasKernelCapabilities({});
  assert.equal(capabilities.STATIC_TOOLS.length, 18);
  assert.equal(capabilities.DX_CANVAS_TOOL_ALIASES.length, 14);
  assert.equal(built.dxToolCoverage.length, 14);
  const statuses = built.dxToolCoverage.map((entry) => entry.status);
  assert.equal(statuses.filter((s) => s === "mapped").length, 7);
  assert.equal(statuses.filter((s) => s === "partial").length, 3);
  assert.equal(statuses.filter((s) => s === "unsupported").length, 4);
  for (const entry of built.dxToolCoverage) {
    if (entry.status === "unsupported") continue;
    for (const tool of entry.openarcTools) {
      assert.equal(tool.available, true, entry.dxName + " → " + tool.name + " 必须存在于真实能力清单");
      const capability = built.capabilities.find((item) => item.name === tool.name.replace(/\./g, "_"));
      assert.ok(capability && capability.handler && capability.risk, "每个映射工具必须有可执行命令与 risk");
    }
  }
});

test("A18 · docx/xlsx 解析器注入：有依赖抽取正文；无依赖保持结构化拒绝", () => {
  const docx = attachments.extractAttachment({ name: "a.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("fake") });
  assert.match(docx.error, /文件解析失败|解析依赖/);
  attachments.configureAttachmentParsers({ docx: () => "DOCX 正文", xlsx: (buf) => ({ text: "XLSX " + buf.length }) });
  try {
    const parsed = attachments.extractAttachment({ name: "a.docx", mime: "application/octet-stream", buffer: Buffer.from("fake") });
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.content, "DOCX 正文");
    const xlsx = attachments.extractAttachment({ name: "a.xlsx", mime: "application/octet-stream", buffer: Buffer.from("123") });
    assert.equal(xlsx.content, "XLSX 3");
    const pdf = attachments.extractAttachment({ name: "a.pdf", mime: "application/pdf", buffer: Buffer.from("pdf") });
    assert.match(pdf.error, /PDF/);
  } finally { attachments.configureAttachmentParsers({}); }
});

test("A20 · ai_protocol_tasks 三元组写入/事件/状态可查询；modelCall 走同一写入路径", async () => {
  const f = await fixture();
  try {
    const task = f.canvasStore.insertProtocolTask({
      id: "apt_test", ownerId: f.fx.users.admin, canvasId: "cv_test", status: "RUNNING", mode: "image", intent: "image-generation",
      requestJson: JSON.stringify({ prompt: "x" }), planJson: JSON.stringify({ steps: 1 }), planHash: "abc",
    });
    assert.equal(task.status, "RUNNING");
    assert.equal(task.provider_protocol_id, "canvas-host");
    assert.equal(task.provider_protocol_version, 1);
    assert.ok(task.provider_protocol_hash);
    assert.equal(task.model_protocol_id, "canvas-model");
    assert.equal(task.profile_id, "canvas-default");
    assert.equal(task.intent, "image-generation");
    const first = f.canvasStore.appendProtocolTaskEvent({ taskId: "apt_test", type: "started" });
    const second = f.canvasStore.appendProtocolTaskEvent({ taskId: "apt_test", type: "completed", data: { ok: true } });
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    const done = f.canvasStore.updateProtocolTask({ id: "apt_test", status: "SUCCEEDED", resultJson: { ok: true } });
    assert.equal(done.status, "SUCCEEDED");
    assert.equal(JSON.parse(done.result_json).ok, true);
    assert.ok(done.completed_at);
    assert.equal(f.canvasStore.protocolTaskById("apt_test").status, "SUCCEEDED");
    assert.equal(f.canvasStore.protocolTasksByCanvas("cv_test").length, 1);
    const source = fs.readFileSync(path.join(process.cwd(), "electron", "canvas-service.cjs"), "utf8");
    assert.ok(source.includes("insertProtocolTask({"));
    assert.ok(source.includes("appendProtocolTaskEvent({ taskId: protocolTaskId"));
    assert.ok(source.includes('status: "FAILED"'));
    assert.ok(source.includes("protocolTasksByCanvas"));
  } finally { f.fx.close(); }
});
