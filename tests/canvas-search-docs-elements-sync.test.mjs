// 搜索范围（整张画布 / 分组）、文档上传、元素同步到资产库「AI 角色」（TapNow 对齐）
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "node_modules/.cache/oa-canvas-sde-" + process.pid + ".mjs");
const ENTRY = path.join(ROOT, "node_modules/.cache/oa-canvas-sde-entry-" + process.pid + ".ts");
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
globalThis.window ??= globalThis;
globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const src = (f) => JSON.stringify(path.join(ROOT, "src/canvas/canvas-next", f));
fs.writeFileSync(ENTRY, [
  `export * from ${src("search.ts")};`,
  `export * from ${src("elements.ts")};`,
  `export { documentText, isDocument } from ${src("actions.ts")};`,
  `export { CanvasStore } from ${src("store.ts")};`,
  `export { newNode } from ${src("model.ts")};`,
].join("\n"));
await esbuild.build({ entryPoints: [ENTRY], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent" });
const M = await import(pathToFileURL(OUT).href);
after(() => { fs.rmSync(OUT, { force: true }); fs.rmSync(ENTRY, { force: true }); });
beforeEach(() => { mem.clear(); M.resetElementCache(); M.setElementCommand(null); });

const node = (id, kind, extra = {}) => ({ ...M.newNode(kind, 0, 0, { id, title: id, prompt: extra.prompt || "" }), ...extra });

test("搜索：整张画布 / 分组（含嵌套）范围，分组类型，关键词匹配提示词", () => {
  const doc = { nodes: [
    node("海报", "image", { prompt: "樱花" }), node("视频", "video"), node("文案", "text"),
    { id: "g1", kind: "group", x: 0, y: 0, w: 1, h: 1, text: "春季", children: ["海报", "g2"] },
    { id: "g2", kind: "group", x: 0, y: 0, w: 1, h: 1, children: ["视频"] },
  ], edges: [], comments: [] };
  assert.deepEqual(M.searchNodes(doc, { q: "", kind: "all", scope: "world" }).map((n) => n.id), ["海报", "视频", "文案"], "全部不含分组本身");
  assert.deepEqual(M.searchNodes(doc, { q: "", kind: "all", scope: "g1" }).map((n) => n.id), ["海报", "视频"], "嵌套分组的成员也算");
  assert.deepEqual(M.searchNodes(doc, { q: "樱花", kind: "all", scope: "world" }).map((n) => n.id), ["海报"]);
  assert.deepEqual(M.searchNodes(doc, { q: "春季", kind: "group", scope: "world" }).map((n) => n.id), ["g1"]);
  assert.deepEqual(M.searchNodes(doc, { q: "", kind: "video", scope: "g2" }).map((n) => n.id), ["视频"]);
  assert.equal(M.groupName(doc.nodes[3]), "春季"); assert.equal(M.groupName(doc.nodes[4]), "分组");
});

test("文档上传：识别文档类型，纯文本直接读，docx 没有桌面端时如实说明", async () => {
  assert.ok(M.isDocument({ name: "说明.md", type: "" })); assert.ok(M.isDocument({ name: "a.docx", type: "" }));
  assert.ok(!M.isDocument({ name: "a.png", type: "image/png" }));
  const store = new M.CanvasStore({ kind: "mock", available: () => true }, "c1");
  const r = await M.documentText(store, new File(["# 标题\n\n正文\0"], "说明.md", { type: "text/markdown" }));
  assert.deepEqual(r, { text: "# 标题\n\n正文", truncated: false });
  const long = await M.documentText(store, new File(["字".repeat(70000)], "长.txt", { type: "text/plain" }));
  assert.equal(long.text.length, 60000); assert.equal(long.truncated, true);
  const docx = await M.documentText(store, new File([new Uint8Array([80, 75, 3, 4])], "合同.docx", { type: "" }));
  assert.match(docx.error, /桌面版/);
  const viaBridge = await M.documentText(new M.CanvasStore({ kind: "bridge", available: () => true, extractDocument: async (d, n) => ({ ok: true, text: "抽出的正文 " + n, truncated: false }) }, "c1"), new File([new Uint8Array([80, 75, 3, 4])], "合同.docx", { type: "" }));
  assert.equal(viaBridge.text, "抽出的正文 合同.docx");
});

test("文档上传：主进程 media/extractDocument 抽文本，二进制 / PDF 给出原因", () => {
  const { parseDataUrl } = require(path.join(ROOT, "electron/media-clip.cjs"));
  const { extractAttachment } = require(path.join(ROOT, "electron/canvas-dxos-agent-attachments.cjs"));
  const d = parseDataUrl("data:text/plain;base64," + Buffer.from("你好，画布").toString("base64"));
  assert.equal(extractAttachment({ buffer: d.buf, name: "a.txt", mime: d.mime }).content, "你好，画布");
  assert.match(extractAttachment({ buffer: Buffer.from("%PDF-1.4"), name: "a.pdf", mime: "application/pdf" }).error, /PDF/);
  const boot = fs.readFileSync(path.join(ROOT, "electron/canvas-bootstrap.cjs"), "utf8");
  assert.ok(boot.includes('"media/extractDocument"'), "命令在渲染层白名单里");
});

test("元素同步：资产库 AI 角色拉下来成元素，本机新建推上去并记住条目 id，删除同步删除", async () => {
  const calls = []; const chars = [{ id: "c1", name: "小白", description: "白猫", prompt: "", referenceUrls: ["openarc-asset:a"], updatedAt: 5 }];
  M.setElementCommand(async (r) => {
    calls.push(r.type);
    if (r.type === "canvas/assetLibrary/ensure") return { ok: true, library: { id: "L" } };
    if (r.type === "canvas/assetLibrary/characterList") return { ok: true, characters: chars };
    if (r.type === "canvas/assetLibrary/characterCreate") { assert.equal(r.prompt, "element-kind:product"); assert.deepEqual(r.referenceUrls, ["openarc-asset:p"], "data URL 不上传"); return { ok: true, character: { id: "c2" } }; }
    if (r.type === "canvas/assetLibrary/characterDelete") { assert.equal(r.id, "c2"); return { ok: true }; }
    return { ok: false };
  });
  assert.equal(await M.syncElements(), true);
  assert.deepEqual(M.listElements().map((e) => [e.name, e.kind, e.remoteId]), [["小白", "character", "c1"]]);
  const e = M.saveElement({ name: "耳机", kind: "product", desc: "", refs: ["openarc-asset:p", "data:image/png;base64,AA"] });
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  assert.equal(M.listElements().find((x) => x.id === e.id).remoteId, "c2");
  M.deleteElement(e.id); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  assert.ok(calls.includes("canvas/assetLibrary/characterDelete"));
  assert.equal(calls.filter((c) => c === "canvas/assetLibrary/ensure").length, 1, "资产库 id 只取一次");
});

test("元素同步：没有桌面端时只存本机，不报错", async () => {
  assert.equal(await M.syncElements(), false);
  M.saveElement({ name: "本机", kind: "scene", desc: "", refs: ["data:x"] });
  assert.equal(M.listElements()[0].remoteId, undefined);
});
