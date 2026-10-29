/**
 * 多维表格批量生成：列用途 / 按行组请求 / 分镜连贯（首帧图回填、镜头串联）。
 *
 *   ① 列名自动识别用途；时长 / 比例单元格解析
 *   ② batchRows：只有提示词列拼进提示词；图片列给出首帧 / 尾帧 / 参考图；镜头名、时长、比例单独取出
 *   ③ planRow：首帧 + 尾帧 → 首尾帧；模型不支持时降级并说明；时长取最接近值；比例覆盖
 *   ④ 输入列：共用多图不再全部当首帧；「两张一组」= 每行首帧 + 尾帧
 *   ⑤ runTableBatch：每行请求的方式 / 时长 / 输入角色正确，结果节点带行参数和镜头名
 *   ⑥ 分镜出片：首帧图批量结果填回表格首帧列，分镜视频按行读到首帧
 *   ⑦ 镜头串联：上一行视频的最后一帧作为下一行首帧，逐行顺序生成
 *   ⑧ 分镜表出表自动追加首帧 / 尾帧列；重新出表保留已放的图；画布图片拖进单元格
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, "node_modules/.cache"); fs.mkdirSync(CACHE, { recursive: true });
const ENTRY = path.join(CACHE, "oa-table-batch-entry-" + process.pid + ".ts");
const OUT = path.join(CACHE, "oa-table-batch-" + process.pid + ".mjs");
const src = (p) => JSON.stringify(path.join(ROOT, "src/canvas/canvas-next", p));
fs.writeFileSync(ENTRY, `export * from ${src("table.ts")};\nexport { CanvasStore } from ${src("store.ts")};\nexport { runNode, buildRequest } from ${src("engine.ts")};\nexport { storyboardPipeline } from ${src("tableFlow.ts")};\nexport { newNode, withGen, genOf, outOf } from ${src("model.ts")};\n`);
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
await esbuild.build({ entryPoints: [ENTRY], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent" });
const T = await import(pathToFileURL(OUT).href);
after(() => { fs.rmSync(OUT, { force: true }); fs.rmSync(ENTRY, { force: true }); });

const VIDEO = { id: "v-seedance", name: "Seedance", vendor: "", tags: [], kind: "video", secs: 1, modes: ["文生视频", "首帧", "首尾帧", "参考生视频"], ratios: ["16:9", "9:16", "1:1"], res: ["720p", "1080p"], durs: [5, 10, 15], maxRefs: 9, times: [1], specSource: "spec" };
const VIDEO_NO_TAIL = { ...VIDEO, id: "v-basic", name: "Basic", modes: ["文生视频", "首帧"] };
const IMAGE = { id: "i-1", name: "Img", vendor: "", tags: [], kind: "image", secs: 1, ratios: ["16:9", "9:16", "1:1", "3:4"], sizes: ["2K"], maxRefs: 2, i2i: true, batch: [1], specSource: "spec" };
const TEXT = { id: "t-1", name: "LLM", vendor: "", tags: [], kind: "text", secs: 1, specSource: "spec" };

function makeStore(models = [VIDEO, IMAGE, TEXT], textReply = "") {
  const reqs = []; let assets = 0;
  const backend = {
    kind: "mock", available: () => true,
    loadDoc: async () => ({ doc: { nodes: [], edges: [], comments: [] }, version: 1, source: "mock" }),
    listModels: async () => models, onModelsChanged: () => () => {},
    saveDoc: async (_i, _d, v) => ({ ok: true, version: (v || 1) + 1 }),
    importAsset: async (_c, _d, name) => `openarc-asset:a${++assets}-${name}`,
    resolveAsset: async (r) => r,
    generate: async (req) => { reqs.push(req); return { outputs: req.kind === "text" ? [{ text: textReply }] : [{ url: `openarc-asset:out-${req.nodeId}`, w: 16, h: 9 }] }; },
  };
  const store = new T.CanvasStore(backend, "c1");
  store.set({ models, loaded: true });
  return { store, reqs };
}
const table = (columns, rows, extra = {}) => T.withTable({ id: "tb", kind: "table", x: 0, y: 0, w: 600, h: 300, text: "表" }, { kind: "table", version: 1, title: "分镜表", columns, rows, ...extra });
function gen(store, kind, id, params = {}) { const n = T.newNode(kind, 800, 0, { id, title: kind === "video" ? "视频" : "图片" }, store.state.models.find((m) => m.kind === kind)); return T.withGen(n, { params: { ...T.genOf(n).params, ...params } }); }
const edge = (from, to) => ({ id: "e-" + from + "-" + to, from, to });

test("① 列名自动识别用途；时长 / 比例解析", () => {
  const cases = { 首帧: "first", "首帧图": "first", 开头画面: "first", 尾帧: "last", "结尾画面": "last", 参考图: "ref", 时长: "dur", "时长（秒）": "dur", 比例: "ratio", 画幅: "ratio", 镜头: "label", 镜号: "label", 画面: "prompt", 运镜: "prompt", "台词 / 字幕": "prompt", "首帧画面描述": "prompt", 备注: "skip", 提示词: "prompt" };
  for (const [name, want] of Object.entries(cases)) assert.equal(T.guessRole(name), want, name);
  assert.equal(T.parseDur("5s"), 5); assert.equal(T.parseDur("约 4.5 秒"), 4.5); assert.equal(T.parseDur("—"), null);
  assert.equal(T.parseRatio("9：16"), "9:16"); assert.equal(T.parseRatio("竖屏"), "9:16"); assert.equal(T.parseRatio("16x9"), "16:9"); assert.equal(T.parseRatio("随意"), null);
  const t = T.withRole(T.tableOf(table(["画面", "备注"], [["a", "b"]])), 1, "prompt");
  assert.deepEqual(T.rolesOf(t).map((r) => [r.role, r.auto]), [["prompt", true], ["prompt", false]]);
});

test("② batchRows：只拼提示词列，图片列、镜头名、时长、比例单独取出", () => {
  const { store } = makeStore();
  const tb = table(["镜头", "画面", "运镜", "时长", "比例", "首帧", "尾帧", "备注"], [["镜头1", "海边日出", "缓慢推进", "7秒", "竖屏", "openarc-asset:f1", "openarc-asset:l1", "别忘了"], ["镜头2", "城市夜景", "", "", "", "", "", ""]]);
  store.mutate((d) => ({ ...d, nodes: [tb, gen(store, "video", "gv")], edges: [edge("tb", "gv")] }));
  const rows = T.batchRows(store.state.doc, "gv");
  assert.equal(rows[0].text, "画面：海边日出\n运镜：缓慢推进");
  assert.equal(rows[0].label, "镜头1"); assert.equal(rows[0].dur, 7); assert.equal(rows[0].ratio, "9:16");
  assert.deepEqual(rows[0].media.map((m) => [m.as, m.url]), [["first", "openarc-asset:f1"], ["last", "openarc-asset:l1"]]);
  assert.equal(rows[1].text, "画面：城市夜景"); assert.equal(rows[1].media.length, 0);
  // 图片列里写的是文字（不是图）：仍然拼进提示词，不丢
  const tb2 = table(["首帧画面"], [["一只猫"]]);
  store.mutate((d) => ({ ...d, nodes: [tb2, gen(store, "video", "gv")], edges: [edge("tb", "gv")] }));
  assert.equal(T.batchRows(store.state.doc, "gv")[0].text, "首帧画面：一只猫");
});

test("③ planRow：首尾帧、降级说明、时长取最接近值、比例覆盖", () => {
  const row = { row: 1, text: "x", tableId: "tb", dur: 7, ratio: "9:16", media: [{ nodeId: "c1", kind: "image", title: "首帧", src: "f", url: "f", as: "first" }, { nodeId: "c2", kind: "image", title: "尾帧", src: "l", url: "l", as: "last" }] };
  const base = { model: "v", mode: "文生视频", ratio: "16:9", res: "720p", dur: 5, sound: false, times: 1 };
  const p = T.planRow("video", base, VIDEO, row);
  assert.equal(p.params.mode, "首尾帧"); assert.equal(p.params.dur, 5); assert.equal(p.params.ratio, "9:16");
  assert.deepEqual(p.inputs.map((i) => [i.role, i.url]), [["first_frame", "f"], ["last_frame", "l"]]);
  assert.ok(p.warnings.some((w) => w.includes("7s") && w.includes("5s")));
  assert.equal(p.ownImages, true);
  const q = T.planRow("video", base, VIDEO_NO_TAIL, row);
  assert.equal(q.params.mode, "首帧"); assert.deepEqual(q.inputs.map((i) => i.role), ["first_frame"]);
  assert.ok(q.warnings.some((w) => w.includes("不支持首尾帧")));
  // 图片节点：这一行的图都当参考图，按上限截断
  const r = T.planRow("image", { model: "i", ratio: "1:1", size: "2K", count: 1 }, IMAGE, { ...row, media: [...row.media, { nodeId: "c3", kind: "image", title: "参考", src: "r", url: "r", as: "ref" }] });
  assert.deepEqual(r.inputs.map((i) => i.role), ["reference", "reference"]); assert.ok(r.warnings[0].includes("上限 2"));
  assert.equal(r.params.ratio, "9:16");
});

test("④ 输入列：共用多图按节点方式分配（不再全部当首帧）；两张一组 = 首帧 + 尾帧", () => {
  const { store } = makeStore();
  const imgs = ["i1", "i2", "i3", "i4"].map((id, k) => T.withGen(T.newNode("image", -400, k * 300, { id, title: "图" + (k + 1) }), { hist: [{ url: "openarc-asset:" + id }] }));
  const tb = table(["画面"], [["一"], ["二"]], { inputMode: "shared" });
  const gv = gen(store, "video", "gv", { mode: "首帧" });
  store.mutate((d) => ({ ...d, nodes: [...imgs.slice(0, 2), tb, gv], edges: [edge("i1", "tb"), edge("i2", "tb"), edge("tb", "gv")] }));
  let req = T.buildRequest(store, store.node("gv"), T.batchRows(store.state.doc, "gv")[0]);
  assert.deepEqual(req.inputs.filter((i) => i.kind === "image").map((i) => i.role), ["first_frame"], "首帧模式只用第一张");
  assert.equal(req.videoMode.name, "首帧");
  store.updateNode("gv", (n) => T.withGen(n, { params: { ...T.genOf(n).params, mode: "文生视频" } }));
  req = T.buildRequest(store, store.node("gv"), T.batchRows(store.state.doc, "gv")[0]);
  assert.deepEqual(req.inputs.filter((i) => i.kind === "image").map((i) => i.role), ["first_frame", "last_frame"], "两张共用图 → 首尾帧");
  assert.equal(req.videoMode.name, "首尾帧");
  // 两张一组
  store.mutate((d) => ({ ...d, nodes: [...imgs, T.withTable(tb, { ...T.tableOf(tb), inputMode: "pair" }), gv], edges: [...imgs.map((n) => edge(n.id, "tb")), edge("tb", "gv")] }));
  const rows = T.batchRows(store.state.doc, "gv");
  const pick = (r) => T.buildRequest(store, store.node("gv"), r).inputs.filter((i) => i.kind === "image").map((i) => i.role + ":" + i.url);
  assert.deepEqual(pick(rows[0]), ["first_frame:openarc-asset:i1", "last_frame:openarc-asset:i2"]);
  assert.deepEqual(pick(rows[1]), ["first_frame:openarc-asset:i3", "last_frame:openarc-asset:i4"]);
});

test("⑤ runTableBatch：每行的方式 / 时长 / 角色，结果节点带行参数和镜头名", async () => {
  const { store, reqs } = makeStore();
  const tb = table(["镜头", "画面", "时长", "首帧", "尾帧"], [["开场", "日出", "10", "openarc-asset:f1", "openarc-asset:l1"], ["收尾", "日落", "4", "openarc-asset:f2", ""], ["空镜", "云", "", "", ""]]);
  store.mutate((d) => ({ ...d, nodes: [tb, gen(store, "video", "gv")], edges: [edge("tb", "gv")] }));
  assert.equal(await T.runNode(store, "gv"), true);
  const byRow = (r) => reqs.find((q) => store.node(q.nodeId)?.data?.tableRow === r);
  assert.equal(reqs.length, 3);
  assert.equal(byRow(1).videoMode.name, "首尾帧"); assert.equal(byRow(1).params.dur, 10);
  assert.deepEqual(byRow(1).inputs.map((i) => i.role), ["first_frame", "last_frame"]);
  assert.equal(byRow(2).videoMode.name, "首帧"); assert.equal(byRow(2).params.dur, 5);
  assert.equal(byRow(3).videoMode.name, "文生视频"); assert.equal(byRow(3).inputs.length, 0);
  assert.equal(byRow(1).resolvedPrompt, "画面：日出");
  const kids = store.state.doc.nodes.filter((n) => n.data?.batchOf === "gv").sort((a, b) => a.data.tableRow - b.data.tableRow);
  assert.deepEqual(kids.map((n) => T.genOf(n).title), ["视频 · 开场", "视频 · 收尾", "视频 · 空镜"]);
  assert.equal(T.genOf(kids[0]).params.dur, 10); assert.equal(T.genOf(kids[0]).params.mode, "首尾帧");
});

test("⑥ 分镜出片：首帧图结果填回首帧列，分镜视频按行读到首帧", async () => {
  const { store, reqs } = makeStore();
  const tb = table(["镜头", "画面", "运镜", "时长", "台词 / 字幕"], [["1", "海边", "推", "5", ""], ["2", "山顶", "摇", "10", ""]]);
  store.mutate((d) => ({ ...d, nodes: [tb] }));
  const made = T.storyboardPipeline(store, "tb");
  const t = T.tableOf(store.node("tb"));
  assert.deepEqual(t.columns.slice(-2), ["首帧", "尾帧"]);
  assert.deepEqual(T.batchOf(made.image).settings.fill, { table: "tb", col: 5 });
  assert.equal(await T.runNode(store, made.image.id), true);
  const imgReqs = reqs.filter((q) => q.kind === "image");
  assert.equal(imgReqs.length, 2); assert.ok(imgReqs.every((q) => !q.inputs.some((i) => i.kind === "image")), "回填列不当输入");
  const filled = T.tableOf(store.node("tb")).rows.map((r) => r[5]);
  assert.ok(filled.every((u) => u.startsWith("openarc-asset:out-")), "两行首帧都填好了");
  assert.equal(await T.runNode(store, made.video.id), true);
  const vids = reqs.filter((q) => q.kind === "video");
  assert.deepEqual(vids.map((q) => q.inputs.find((i) => i.role === "first_frame")?.url).sort(), filled.slice().sort());
  assert.ok(vids.every((q) => q.videoMode.name === "首帧"));
  // 重跑首帧图：列已经填过，仍回填同一列（记住了回填目标），不会把旧图当参考
  reqs.length = 0;
  store.updateNode(made.image.id, (n) => T.withBatch(n, { journal: null }));
  await T.runNode(store, made.image.id);
  assert.ok(reqs.every((q) => !q.inputs.some((i) => i.kind === "image")));
});

test("⑦ 镜头串联：上一行的最后一帧作为下一行首帧，逐行顺序生成", async () => {
  const { store, reqs } = makeStore();
  const grabbed = [];
  store.grabFrame = async (id, at) => { grabbed.push([id, at]); return "data:image/jpeg;base64,AAAA"; };
  const tb = table(["画面", "首帧"], [["一", "openarc-asset:f1"], ["二", ""], ["三", ""]]);
  const gv = T.withBatch(gen(store, "video", "gv"), { settings: { chain: true, concurrency: 3 } });
  store.mutate((d) => ({ ...d, nodes: [tb, gv], edges: [edge("tb", "gv")] }));
  assert.equal(await T.runNode(store, "gv"), true);
  const rowOf = (q) => store.node(q.nodeId).data.tableRow;
  assert.deepEqual(reqs.map(rowOf), [1, 2, 3], "按顺序");
  assert.equal(reqs[0].inputs[0].url, "openarc-asset:f1");
  assert.equal(grabbed.length, 2); assert.ok(grabbed.every(([, at]) => at === "last"));
  assert.ok(reqs[1].inputs.some((i) => i.role === "first_frame" && i.url.startsWith("openarc-asset:") && i.url.includes("尾帧")));
  assert.equal(reqs[1].videoMode.name, "首帧");
});

test("⑧ 分镜表出表追加首帧 / 尾帧列；重新出表保留已放的图；画布图片拖进单元格", async () => {
  const reply = JSON.stringify({ kind: "table", version: 1, columns: ["镜头", "画面", "运镜", "时长", "台词 / 字幕"], rows: [["1", "a", "推", "5", ""], ["2", "b", "拉", "5", ""]] });
  const { store } = makeStore([VIDEO, IMAGE, TEXT], reply);
  const tx = T.withGen(T.newNode("text", 0, 0, { id: "tx", prompt: "两个镜头" }, TEXT), { params: { model: "t-1", search: false, output: "storyboard" } });
  store.mutate((d) => ({ ...d, nodes: [tx] }));
  assert.equal(await T.runNode(store, "tx"), true);
  const tn = store.state.doc.nodes.find((n) => n.kind === "table");
  assert.deepEqual(T.tableOf(tn).columns, ["镜头", "画面", "运镜", "时长", "台词 / 字幕", "首帧", "尾帧"]);
  const img = T.withGen(T.newNode("image", 0, 600, { id: "im" }), { hist: [{ url: "openarc-asset:cat" }] });
  store.mutate((d) => ({ ...d, nodes: [...d.nodes, img] }));
  assert.equal(T.dropImageOnCell(store, `${tn.id}:1:5`, "im", false), true);
  assert.equal(T.tableOf(store.node(tn.id)).rows[1][5], "openarc-asset:cat");
  await T.runNode(store, "tx");
  assert.equal(T.tableOf(store.node(tn.id)).rows[1][5], "openarc-asset:cat", "重新出表后图还在");
});
