/**
 * B5c · 素材库（源 server/canvasAssetLibrary.ts）。
 * 被测：electron/canvas-dxos-asset-library.cjs + canvas-dxos-store.cjs（真实产品代码），
 * 素材字节落既有 resource_* 表（resource-fixtures 提供真实 ResourceStore/ResourceService）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { CanvasDxosStore } = require("../electron/canvas-dxos-store.cjs");
const { CanvasAssetLibraryService, CANVAS_SYSTEM_PROMPT_TEMPLATES } = require("../electron/canvas-dxos-asset-library.cjs");
const { CanvasStore } = require("../electron/canvas-store.cjs");
const { CanvasService } = require("../electron/canvas-service.cjs");

/** 1×1 PNG。 */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_DATA_URL = "data:image/png;base64," + PNG_BASE64;
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

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

test("默认素材库：自动播种两条系统提示词，重复调用不重复插入（源 :51-75）", async () => {
  const f = await fixture();
  try {
    const first = f.service.ensureDefaultLibrary({ context: f.ctx("admin") });
    assert.equal(first.ok, true, JSON.stringify(first));
    const roles = first.items.filter((item) => item.promptRole).map((item) => item.promptRole).sort();
    assert.deepEqual(roles, CANVAS_SYSTEM_PROMPT_TEMPLATES.map((t) => t.role).sort());
    const again = f.service.ensureDefaultLibrary({ context: f.ctx("admin") });
    assert.equal(again.library.id, first.library.id);
    assert.equal(again.items.length, first.items.length, "播种必须幂等");
    const foreign = f.service.ensureDefaultLibrary({ context: f.ctx("bob") });
    assert.notEqual(foreign.library.id, first.library.id, "另一个组织的人拿到的是自己的库");
  } finally { f.fx.close(); }
});

test("导入素材：字节进 resource_* 表，条目只存 ResourceRef（不建第二套素材系统）", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("admin");
    const lib = f.service.ensureDefaultLibrary({ context: ctx }).library;
    const imported = await f.service.importAssetItem({ context: ctx, libraryId: lib.id, name: "素材.png", mime: "image/png", dataUrl: PNG_DATA_URL, title: "像素图", group: "封面" });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    assert.match(imported.item.resourceRef, /^openarc-asset:res_/);
    assert.equal(imported.item.mediaKind, "image");
    assert.equal(imported.item.media.bytes, PNG_BYTES.length);
    assert.equal(imported.dedupe.resource, false, "第一次导入不是去重命中");
    assert.equal(imported.referenceCount, 1);
    // 字节确实在资源域的 library_resources 里（不是画布自建表）
    const resourceId = imported.item.media.resourceId;
    const row = f.fx.resourceStore.resourceRowById(resourceId);
    assert.ok(row, "资源域必须有这一行");
    assert.equal(row.size, PNG_BYTES.length);
    assert.equal(row.mime_type, "image/png");
    // 数据可通过既有读取通道取回
    const data = f.fx.resourceService.readDataUrl({ context: f.ctx("admin", { appId: "resource-library" }), resourceRef: resourceId });
    assert.equal(data.ok, true, JSON.stringify(data));
    assert.match(data.dataUrl, /^data:image\/png;base64,/);
  } finally { f.fx.close(); }
});

test("去重与引用计数：同字节重复导入复用同一 ResourceRef；跨库引用计数累加", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("admin");
    const lib = f.service.ensureDefaultLibrary({ context: ctx }).library;
    const first = await f.service.importAssetItem({ context: ctx, libraryId: lib.id, name: "a.png", mime: "image/png", dataUrl: PNG_DATA_URL, sourceKey: "src-1" });
    assert.equal(first.ok, true, JSON.stringify(first));
    const again = await f.service.importAssetItem({ context: ctx, libraryId: lib.id, name: "a-copy.png", mime: "image/png", dataUrl: PNG_DATA_URL, sourceKey: "src-2" });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.item.resourceRef, first.item.resourceRef, "同一份字节复用同一 ResourceRef");
    assert.equal(again.dedupe.resource, true);
    assert.equal(again.item.id, first.item.id, "同库同素材不建重复条目");
    assert.equal(again.referenceCount, 1);
    // 第二个库导入同一份字节：资源复用，条目是新的 → 引用计数 2
    const lib2 = f.service.createLibrary({ context: ctx, name: "第二个库" }).library;
    const inLib2 = await f.service.importAssetItem({ context: ctx, libraryId: lib2.id, name: "a.png", mime: "image/png", dataUrl: PNG_DATA_URL });
    assert.equal(inLib2.ok, true, JSON.stringify(inLib2));
    assert.equal(inLib2.item.resourceRef, first.item.resourceRef);
    assert.notEqual(inLib2.item.id, first.item.id, "不同库是不同条目");
    assert.equal(inLib2.referenceCount, 2, "引用计数按共用该资源的条目数");
    const contentId = f.fx.resourceStore.resourceRowById(first.item.media.resourceId).content_object_id;
    const shared = f.fx.identity.connection.prepare("SELECT COUNT(*) AS c FROM library_resources WHERE content_object_id = ?").get(contentId);
    assert.equal(Number(shared.c), 1, "内容对象只应有一条 library 资源（去重生效）");
  } finally { f.fx.close(); }
});

test("引用：返回稳定 ResourceRef 与引用计数；挂载到画布走既有 node.add", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("admin");
    const lib = f.service.ensureDefaultLibrary({ context: ctx }).library;
    const imported = await f.service.importAssetItem({ context: ctx, libraryId: lib.id, name: "a.png", mime: "image/png", dataUrl: PNG_DATA_URL });
    const ref = f.service.referenceItem({ context: ctx, libraryId: lib.id, itemId: imported.item.id });
    assert.equal(ref.ok, true, JSON.stringify(ref));
    assert.equal(ref.ref, imported.item.resourceRef);
    assert.equal(ref.referenceCount, 1);
    const created = f.canvasService.createCanvas({ context: ctx, title: "协作画布" });
    assert.equal(created.ok, true);
    const attached = f.service.attachItemToCanvas({ context: ctx, libraryId: lib.id, itemId: imported.item.id, canvasId: created.canvas.canvasId, x: 40, y: 60 });
    assert.equal(attached.ok, true, JSON.stringify(attached));
    assert.ok(attached.nodeId);
    const got = f.canvasService.getCanvas({ context: ctx, canvasId: created.canvas.canvasId });
    const node = got.canvas.doc.nodes.find((candidate) => candidate.id === attached.nodeId);
    assert.equal(node.type, "image");
    assert.deepEqual(node.refs, [imported.item.resourceRef]);
    assert.equal(node.x, 40);
    assert.equal(got.canvas.revision, created.canvas.revision + 1, "挂载必须让画布版本前进");
  } finally { f.fx.close(); }
});

test("条目：prompt 版本历史、系统提示词不可删、普通条目可删", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("admin");
    const lib = f.service.ensureDefaultLibrary({ context: ctx }).library;
    const created = await f.service.upsertItem({ context: ctx, libraryId: lib.id, item: { kind: "prompt", title: "我的提示词", prompt: "第一版", sourceKey: "p-1", tags: ["人像", "人像", "光影"] } });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.deepEqual(created.item.tags, ["人像", "光影"], "标签去重");
    const updated = await f.service.upsertItem({ context: ctx, libraryId: lib.id, item: { kind: "prompt", id: created.item.id, title: "我的提示词", prompt: "第二版", sourceKey: "p-1" } });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.item.prompt, "第二版");
    assert.equal(updated.item.versions.length, 1, "内容变化要保留版本历史（源 :221-228）");
    assert.equal(updated.item.versions[0].prompt, "第一版");
    // 系统提示词不可删
    const system = f.service.getLibrary({ context: ctx, libraryId: lib.id }).items.find((item) => item.promptRole);
    const refused = f.service.deleteItem({ context: ctx, libraryId: lib.id, itemId: system.id });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "INVALID_INPUT");
    assert.equal(refused.detail, "system-prompt-protected");
    // 普通条目可删
    const removed = f.service.deleteItem({ context: ctx, libraryId: lib.id, itemId: created.item.id });
    assert.equal(removed.ok, true);
    assert.equal(f.service.listItems({ context: ctx, libraryId: lib.id }).items.some((item) => item.id === created.item.id), false);
    // 列举与筛选
    const assets = f.service.listItems({ context: ctx, libraryId: lib.id, kind: "prompt", query: "系统" });
    assert.ok(assets.items.length >= 1);
    assert.ok(assets.items.every((item) => item.kind === "prompt"));
  } finally { f.fx.close(); }
});

test("隔离与输入防护：外组织成员不可见；非法 dataUrl / 超限被拒", async () => {
  const f = await fixture();
  try {
    const adminCtx = f.ctx("admin");
    const lib = f.service.ensureDefaultLibrary({ context: adminCtx }).library;
    const denied = f.service.getLibrary({ context: f.ctx("bob"), libraryId: lib.id });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "NOT_FOUND_OR_FORBIDDEN");
    const badInput = await f.service.importAssetItem({ context: adminCtx, libraryId: lib.id, name: "x", dataUrl: "not-a-data-url" });
    assert.equal(badInput.ok, false);
    assert.equal(badInput.error, "INVALID_INPUT");
    const empty = await f.service.importAssetItem({ context: adminCtx, libraryId: lib.id, name: "x", base64: "" });
    assert.equal(empty.ok, false);
    const big = Buffer.alloc(9 * 1024 * 1024, 1).toString("base64");
    const tooBig = await f.service.importAssetItem({ context: adminCtx, libraryId: lib.id, name: "big.bin", base64: big });
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.error, "LIMIT_EXCEEDED");
    const noSession = f.service.ensureDefaultLibrary({ context: { sessionRef: "nope", appId: "canvas" } });
    assert.equal(noSession.ok, false);
  } finally { f.fx.close(); }
});

test("asset 分支：kind=asset + relation* 逐字、sourceNodeId 复制、coverDataUrl 进资源域（源 :144-244）", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("admin");
    const lib = f.service.ensureDefaultLibrary({ context: ctx }).library;
    // 源素材：文本资源 + 一个引用它的画布节点（供 sourceNodeId 复制）。
    const source = await f.service.importAssetItem({ context: ctx, libraryId: lib.id, name: "note.txt", mime: "text/plain", base64: Buffer.from("hello").toString("base64"), title: "源文本" });
    assert.equal(source.ok, true, JSON.stringify(source));
    const created = f.canvasService.createCanvas({ context: ctx, title: "素材源画布" });
    const added = f.canvasService.applyCommand({
      context: ctx, canvasId: created.canvas.canvasId, baseRevision: created.canvas.revision,
      command: { type: "node.add", node: { type: "file", x: 0, y: 0, name: "note.txt", refs: [source.item.resourceRef] } },
    });
    assert.equal(added.ok, true, JSON.stringify(added));
    const sourceNodeId = added.result.node.id;

    const asset = await f.service.upsertItem({ context: ctx, libraryId: lib.id, item: {
      kind: "asset", title: "关联素材", group: "分组甲", sourceNodeId,
      relationId: "rel-1", relationName: "关联到主素材", relationRole: "primary", relationPrimary: true,
      relationPrompt: "把主体替换成参考图", coverDataUrl: PNG_DATA_URL,
    } });
    assert.equal(asset.ok, true, JSON.stringify(asset));
    assert.equal(asset.item.kind, "asset");
    assert.equal(asset.item.group, "分组甲");
    assert.equal(asset.item.relationId, "rel-1");
    assert.equal(asset.item.relationName, "关联到主素材");
    assert.equal(asset.item.relationRole, "primary");
    assert.equal(asset.item.relationPrimary, true);
    assert.equal(asset.item.relationPrompt, "把主体替换成参考图");
    assert.equal(asset.item.resourceRef, source.item.resourceRef, "sourceNodeId 复制 = 复用内容寻址的同一 ResourceRef");
    assert.match(asset.item.coverRef, /^openarc-asset:res_/);
    // 关系字段必须真正落库（重新读取不丢）。
    const reread = f.service.listItems({ context: ctx, libraryId: lib.id, kind: "asset" }).items.find((item) => item.id === asset.item.id);
    assert.equal(reread.relationId, "rel-1");
    assert.equal(reread.relationName, "关联到主素材");
    assert.equal(reread.relationRole, "primary");
    assert.equal(reread.relationPrimary, true);
    assert.equal(reread.relationPrompt, "把主体替换成参考图");
    // relationId 显式清空 → 其余关联字段整体消失（源 :182-187 语义）。
    const cleared = await f.service.upsertItem({ context: ctx, libraryId: lib.id, item: { kind: "asset", id: asset.item.id, title: "关联素材", relationId: "" } });
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.equal(cleared.item.relationId, undefined);
    assert.equal(cleared.item.relationName, undefined);
    assert.equal(cleared.item.relationPrimary, undefined);
    // canUseSource 显式拒绝 → FORBIDDEN（源 :208）。
    const denied = await f.service.upsertItem({ context: ctx, libraryId: lib.id, item: { kind: "asset", title: "越权", sourceNodeId, canUseSource: () => false } });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "FORBIDDEN");
    // 非法封面 → 结构化拒绝，不产生半成品条目（源 :215）。
    const badCover = await f.service.upsertItem({ context: ctx, libraryId: lib.id, item: { kind: "asset", title: "坏封面", coverDataUrl: "not-a-data-url" } });
    assert.equal(badCover.ok, false);
    assert.equal(badCover.error, "INVALID_INPUT");
    assert.equal(f.service.listItems({ context: ctx, libraryId: lib.id, kind: "asset" }).items.some((item) => item.title === "坏封面"), false);
  } finally { f.fx.close(); }
});

test("库级更新：改名 / 可见性 version+1，基准版本落后即冲突（touchLibrary 接线）", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("admin");
    const lib = f.service.ensureDefaultLibrary({ context: ctx }).library;
    const renamed = f.service.updateLibrary({ context: ctx, libraryId: lib.id, name: "改后的库名", visibility: "ORGANIZATION", baseVersion: lib.version });
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    assert.equal(renamed.library.name, "改后的库名");
    assert.equal(renamed.library.visibility, "ORGANIZATION");
    assert.equal(renamed.library.version, lib.version + 1, "version+1");
    const stale = f.service.updateLibrary({ context: ctx, libraryId: lib.id, name: "过期写", baseVersion: lib.version });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "REVISION_CONFLICT");
    assert.equal(f.service.getLibrary({ context: ctx, libraryId: lib.id }).library.name, "改后的库名", "冲突不得写入");
    const foreign = f.service.updateLibrary({ context: f.ctx("bob"), libraryId: lib.id, name: "越权" });
    assert.equal(foreign.ok, false);
  } finally { f.fx.close(); }
});
