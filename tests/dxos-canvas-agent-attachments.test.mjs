/**
 * B5c · Agent 附件（源 server/canvasAgentAttachments.ts）+ 本仓"挂载到画布"语义。
 * 被测：electron/canvas-dxos-agent-attachments.cjs + canvas-dxos-store.cjs（真实产品代码）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { CanvasDxosStore } = require("../electron/canvas-dxos-store.cjs");
const attachments = require("../electron/canvas-dxos-agent-attachments.cjs");
const { CanvasStore } = require("../electron/canvas-store.cjs");
const { CanvasService } = require("../electron/canvas-service.cjs");

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function fixture() {
  const fx = await createResourceFixture();
  const store = new CanvasDxosStore({ identity: fx.identity, clock: fx.clock });
  const canvasStore = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const canvasService = new CanvasService({ identity: fx.identity, store: canvasStore, resourceStore: fx.resourceStore, resourceService: fx.resourceService, authService: fx.authService, clock: fx.clock });
  const service = new attachments.CanvasAgentAttachmentService({
    identity: fx.identity, store, canvasService, resourceService: fx.resourceService,
    clock: fx.clock, tempDir: () => path.join(fx.storeRoot, "tmp"),
  });
  const ctx = (key, extra = {}) => ({ sessionRef: fx.sessions[key], appId: "canvas", source: "ui", ...extra });
  const canvas = canvasService.createCanvas({ context: ctx("admin"), title: "附件画布" });
  assert.equal(canvas.ok, true, JSON.stringify(canvas));
  return { fx, store, canvasService, service, ctx, canvasId: canvas.canvas.canvasId };
}

test("文本抽取：UTF-8 / UTF-16 BOM / CSV / 代码；超长截断在 40k（源 :5 / :23-34 / :74-78）", () => {
  assert.equal(attachments.decodeText(Buffer.from("hello")), "hello");
  assert.equal(attachments.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文", "utf16le")])), "中文");
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("AB", "utf16le").swap16()]);
  assert.equal(attachments.decodeText(be), "AB");
  assert.equal(attachments.decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x")])), "x");
  const text = attachments.extractAttachment({ buffer: Buffer.from("a,b\n1,2\n"), name: "数据.csv", mime: "text/csv" });
  assert.equal(text.content, "a,b\n1,2");
  assert.equal(text.error, undefined);
  const code = attachments.extractAttachment({ buffer: Buffer.from("const a = 1"), name: "x.ts" });
  assert.equal(code.content, "const a = 1");
  const long = attachments.extractAttachment({ buffer: Buffer.from("字".repeat(50000)), name: "long.txt", mime: "text/plain" });
  assert.equal(long.content.length, attachments.MAX_ATTACHMENT_TEXT_CHARS);
  assert.equal(long.truncated, true);
  const nul = attachments.extractAttachment({ buffer: Buffer.from("a\u0000b"), name: "n.txt", mime: "text/plain" });
  assert.equal(nul.content, "ab");
});

test("不支持的格式给出结构化错误，不做假解析（源 :91-93；docx/xlsx 依赖不在本仓）", () => {
  const pdf = attachments.extractAttachment({ buffer: Buffer.from("%PDF-1.7"), name: "a.pdf", mime: "application/pdf" });
  assert.equal(pdf.content, "");
  assert.match(pdf.error, /PDF/);
  const docx = attachments.extractAttachment({ buffer: Buffer.from("PK\u0003\u0004"), name: "a.docx" });
  assert.match(docx.error, /文件解析失败/);
  const xlsx = attachments.extractAttachment({ buffer: Buffer.from("PK\u0003\u0004"), name: "a.xlsx" });
  assert.match(xlsx.error, /文件解析失败/);
  const bin = attachments.extractAttachment({ buffer: Buffer.from([0, 1, 2, 3]), name: "a.bin", mime: "application/octet-stream" });
  assert.match(bin.error, /二进制/);
});

test("整体预算：文件数上限 12、总字符预算 80k、单文件 20MB 拒绝（源 index.ts:3797-3819）", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ name: "f" + i + ".txt", mime: "text/plain", buffer: Buffer.from("x") }));
  const capped = attachments.extractAttachments(many);
  assert.equal(capped.ok, true);
  assert.equal(capped.attachments.length, attachments.MAX_ATTACHMENT_FILES);
  const big = Array.from({ length: 4 }, (_, i) => ({ name: i + ".txt", mime: "text/plain", buffer: Buffer.from("字".repeat(30000)) }));
  const budgeted = attachments.extractAttachments(big);
  assert.equal(budgeted.ok, true);
  const total = budgeted.attachments.reduce((sum, item) => sum + item.content.length, 0);
  assert.ok(total <= attachments.MAX_TOTAL_CHARS, "总字符预算不得超限，实测 " + total);
  assert.equal(budgeted.attachments[0].content.length, 30000);
  assert.ok(budgeted.attachments.some((item) => item.truncated));
  const oversize = attachments.extractAttachments([{ name: "huge.bin", mime: "application/octet-stream", buffer: Buffer.alloc(attachments.MAX_ATTACHMENT_BYTES + 1) }]);
  assert.equal(oversize.ok, false);
  assert.equal(oversize.error, "LIMIT_EXCEEDED");
  assert.equal(attachments.extractAttachments([]).ok, false);
});

test("挂载：字节进资源域 + 节点落到画布 + 附件行可列举；卸载删节点且可重复调用", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("admin");
    const pngBuffer = Buffer.from(PNG_BASE64, "base64");
    const mounted = await f.service.mount({
      context: ctx, canvasId: f.canvasId, runId: "run_1",
      files: [
        { name: "说明.md", mime: "text/markdown", buffer: Buffer.from("# 标题\n正文") },
        { name: "图.png", mime: "image/png", buffer: pngBuffer },
      ],
    });
    assert.equal(mounted.ok, true, JSON.stringify(mounted));
    assert.equal(mounted.attachments.length, 2);
    assert.equal(mounted.revision, 3, "两次 node.add → revision 1→3");
    for (const item of mounted.attachments) assert.match(item.ref, /^openarc-asset:res_/);
    const byName = new Map(mounted.attachments.map((item) => [item.name, item]));
    assert.equal(byName.get("说明.md").mime, "text/markdown");
    assert.equal(byName.get("说明.md").mounted, true);
    assert.equal(byName.get("说明.md").runId, "run_1");
    // 画布上真的有节点，文本节点带上正文
    const view = f.canvasService.getCanvas({ context: ctx, canvasId: f.canvasId });
    const textNode = view.canvas.doc.nodes.find((node) => node.id === byName.get("说明.md").nodeId);
    assert.equal(textNode.type, "prompt");
    assert.match(textNode.text, /标题/);
    assert.deepEqual(textNode.refs, [byName.get("说明.md").ref]);
    assert.equal(view.canvas.doc.nodes.find((node) => node.id === byName.get("图.png").nodeId).type, "image");
    // 列举
    const listed = f.service.list({ context: ctx, canvasId: f.canvasId });
    assert.equal(listed.ok, true);
    assert.equal(listed.attachments.length, 2);
    // 卸载
    const unmounted = f.service.unmount({ context: ctx, canvasId: f.canvasId, attachmentId: byName.get("说明.md").attachmentId });
    assert.equal(unmounted.ok, true, JSON.stringify(unmounted));
    assert.equal(unmounted.removedNode, true);
    assert.equal(unmounted.attachment.mounted, false);
    const after = f.service.list({ context: ctx, canvasId: f.canvasId });
    assert.equal(after.attachments.length, 1);
    const withRemoved = f.service.list({ context: ctx, canvasId: f.canvasId, includeRemoved: true });
    assert.equal(withRemoved.attachments.length, 2);
    assert.equal(f.canvasService.getCanvas({ context: ctx, canvasId: f.canvasId }).canvas.doc.nodes.some((node) => node.id === textNode.id), false, "卸载必须把节点从画布移除");
    const again = f.service.unmount({ context: ctx, canvasId: f.canvasId, attachmentId: byName.get("说明.md").attachmentId });
    assert.equal(again.ok, true);
    assert.equal(again.alreadyRemoved, true);
    // 资源本身保留（只卸载画布挂载，不删资源域内容）
    const resourceId = byName.get("说明.md").ref.replace("openarc-asset:", "");
    assert.ok(f.fx.resourceStore.resourceRowById(resourceId), "卸载不删除资源域内容");
  } finally { f.fx.close(); }
});

test("隔离与拒绝：无权限用户不能挂载 / 卸载；未知附件返回 NOT_FOUND", async () => {
  const f = await fixture();
  try {
    const denied = await f.service.mount({ context: f.ctx("alice"), canvasId: f.canvasId, files: [{ name: "a.txt", mime: "text/plain", buffer: Buffer.from("x") }] });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "NOT_FOUND_OR_FORBIDDEN");
    assert.equal(f.service.list({ context: f.ctx("bob"), canvasId: f.canvasId }).ok, false);
    const missing = f.service.unmount({ context: f.ctx("admin"), canvasId: f.canvasId, attachmentId: "caa_nope" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, "NOT_FOUND");
    const empty = await f.service.mount({ context: f.ctx("admin"), canvasId: f.canvasId, files: [] });
    assert.equal(empty.ok, false);
    assert.equal(empty.error, "INVALID_INPUT");
  } finally { f.fx.close(); }
});

test("挂载回滚：第二个附件应用失败 → 第一个也不落库、画布无残留节点，detail 带序号与原因", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("admin");
    const before = f.canvasService.getCanvas({ context: ctx, canvasId: f.canvasId }).canvas;
    const originalApply = f.canvasService.applyCommand.bind(f.canvasService);
    let calls = 0;
    f.canvasService.applyCommand = (args) => {
      calls += 1;
      if (calls === 2) return { ok: false, error: "REVISION_CONFLICT", detail: { injected: true } };
      return originalApply(args);
    };
    const mounted = await f.service.mount({
      context: ctx, canvasId: f.canvasId,
      files: [
        { name: "一.txt", mime: "text/plain", buffer: Buffer.from("first") },
        { name: "二.txt", mime: "text/plain", buffer: Buffer.from("second") },
      ],
    });
    assert.equal(mounted.ok, false, JSON.stringify(mounted));
    assert.equal(mounted.error, "REVISION_CONFLICT");
    assert.equal(mounted.detail.stage, "apply");
    assert.equal(mounted.detail.attachmentIndex, 2, "detail 必须指出第几个附件失败");
    assert.equal(mounted.detail.attachmentName, "二.txt");
    assert.deepEqual(mounted.detail.reason, { injected: true });
    assert.equal(calls, 2);
    // 附件行与画布节点都必须回滚干净。
    assert.equal(f.store.attachmentsOfCanvas(f.canvasId).length, 0, "第一个附件也不得落库");
    const after = f.canvasService.getCanvas({ context: ctx, canvasId: f.canvasId }).canvas;
    assert.equal(after.doc.nodes.length, 0, "画布不得残留节点");
    assert.equal(after.revision, before.revision, "回滚后 revision 不前进");
  } finally { f.fx.close(); }
});

test("挂载失败 detail：第二个附件依赖缺失 → stage=import + 序号 + dependency，且不落任何行/节点", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("admin");
    const originalImport = f.fx.resourceService.importManaged.bind(f.fx.resourceService);
    let calls = 0;
    f.fx.resourceService.importManaged = async (args) => {
      calls += 1;
      if (calls === 2) return { ok: false, error: "RESOURCE_UNAVAILABLE", detail: { dependency: "resourceService" } };
      return originalImport(args);
    };
    const mounted = await f.service.mount({
      context: ctx, canvasId: f.canvasId,
      files: [
        { name: "一.txt", mime: "text/plain", buffer: Buffer.from("first") },
        { name: "二.txt", mime: "text/plain", buffer: Buffer.from("second") },
      ],
    });
    assert.equal(mounted.ok, false, JSON.stringify(mounted));
    assert.equal(mounted.error, "RESOURCE_UNAVAILABLE");
    assert.equal(mounted.detail.stage, "import");
    assert.equal(mounted.detail.attachmentIndex, 2);
    assert.equal(mounted.detail.attachmentName, "二.txt");
    assert.equal(mounted.detail.dependency, "resourceService");
    assert.equal(f.store.attachmentsOfCanvas(f.canvasId).length, 0);
    assert.equal(f.canvasService.getCanvas({ context: ctx, canvasId: f.canvasId }).canvas.doc.nodes.length, 0);
  } finally { f.fx.close(); }
});

/** task-36：构造最小 stored ZIP（无需第三方依赖），供 DOCX/XLSX 零依赖解析测试。 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30 + nameBuf.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    data.copy(local, 30 + nameBuf.length);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

test("task-36：docx/xlsx 零依赖 ZIP+XML 最小解析（正文/共享字符串/单元格）", () => {
  const docx = makeZip({ "word/document.xml": '<w:document><w:body><w:p><w:r><w:t>Hello 世界</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>' });
  const docxRead = attachments.extractAttachment({ buffer: docx, name: "a.docx", mime: "application/octet-stream" });
  assert.equal(docxRead.error, undefined, docxRead.error);
  assert.match(docxRead.content, /Hello 世界/);
  assert.match(docxRead.content, /第二段/);
  const xlsx = makeZip({
    "xl/sharedStrings.xml": '<sst><si><t>姓名</t></si><si><t>张三</t></si></sst>',
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>',
  });
  const xlsxRead = attachments.extractAttachment({ buffer: xlsx, name: "a.xlsx", mime: "application/octet-stream" });
  assert.equal(xlsxRead.error, undefined, xlsxRead.error);
  assert.equal(xlsxRead.content, "姓名\t张三");
});

