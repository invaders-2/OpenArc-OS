// Agent 思考强度与问答卡、元素（@引用）、跨项目生成历史（TapNow 对齐）
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "node_modules/.cache/oa-canvas-aeh-" + process.pid + ".mjs");
const ENTRY = path.join(ROOT, "node_modules/.cache/oa-canvas-aeh-entry-" + process.pid + ".ts");

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k),
  key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; }, clear: () => mem.clear(),
};
globalThis.window ??= globalThis;
globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const src = (f) => JSON.stringify(path.join(ROOT, "src/canvas/canvas-next", f));
fs.writeFileSync(ENTRY, [
  `export * from ${src("agent/qa.ts")};`,
  `export * from ${src("elements.ts")};`,
  `export * from ${src("history.ts")};`,
  `export { buildRequest } from ${src("engine.ts")};`,
  `export { CanvasStore } from ${src("store.ts")};`,
  `export { newNode, specFor } from ${src("model.ts")};`,
].join("\n"));
await esbuild.build({ entryPoints: [ENTRY], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent" });
const M = await import(pathToFileURL(OUT).href);
after(() => { fs.rmSync(OUT, { force: true }); fs.rmSync(ENTRY, { force: true }); });
beforeEach(() => { mem.clear(); M.resetElementCache(); });

const models = [
  M.specFor({ configId: "img", label: "Banana Pro", kind: "image", ui: { kind: "image", ratios: ["1:1"], sizes: ["2K"], batch: [1], secs: 12, i2i: true, maxRefs: 2 } }),
];
function makeStore(nodes = [], id = "c1") {
  const backend = { kind: "mock", available: () => true, loadDoc: async () => ({ doc: { nodes, edges: [], comments: [] }, version: 1 }), listModels: async () => models, saveDoc: async () => ({ ok: true, version: 2 }) };
  const store = new M.CanvasStore(backend, id, "当前画布");
  store.set({ doc: { nodes, edges: [], comments: [] }, models, loaded: true });
  return store;
}

test("问答卡：解析 openarc-questions 代码块，最多 4 问，单选 / 多选，回答拼成消息", () => {
  const text = "先确认一下：\n```openarc-questions\n" + JSON.stringify([
    { question: "用在哪里？", options: ["小红书", "电商", "小红书"] }, { question: "主色调？", options: ["暖", "冷"], multi: true },
    { question: "风格？" }, { question: "几张？", options: ["1", "3"] }, { question: "第五个" },
  ]) + "\n```";
  const r = M.parseQuestions(text);
  assert.equal(r.rest, "先确认一下：");
  assert.equal(r.questions.length, 4);
  assert.deepEqual(r.questions[0].options, ["小红书", "电商"], "选项去重");
  assert.equal(r.questions[1].multi, true);
  assert.equal(M.parseQuestions("```openarc-questions\nnot json\n```"), null);
  assert.equal(M.parseQuestions("普通回答"), null);

  let card = M.newCard("做个海报", r.questions);
  card = M.togglePick(card, 0, "小红书"); card = M.togglePick(card, 0, "电商");
  assert.deepEqual(card.picks[0], ["电商"], "单选会替换");
  card = M.togglePick(card, 1, "暖"); card = M.togglePick(card, 1, "冷");
  assert.deepEqual(card.picks[1], ["暖", "冷"], "多选累加");
  card = { ...card, other: card.other.map((x, i) => (i === 2 ? "国潮" : x)) };
  assert.equal(M.answeredCount(card), 3);
  const t = M.answerText(card);
  assert.match(t, /1\. 用在哪里？ → 电商/); assert.match(t, /2\. 主色调？ → 暖、冷/); assert.match(t, /3\. 风格？ → 国潮/); assert.match(t, /4\. 几张？ → 你来决定/);
  assert.match(t, /请按这些继续：做个海报$/);
});

test("问答卡：本地规则只在标准 / 深度、无上下文、需求模糊时提问", () => {
  assert.equal(M.clarifyQuestions("做个海报", 0, "standard").length, 4);
  assert.equal(M.clarifyQuestions("做个短片", 0, "heavy")[0].q, "视频多长？");
  assert.equal(M.clarifyQuestions("做个海报", 0, "off"), null);
  assert.equal(M.clarifyQuestions("做个海报", 0, "light"), null);
  assert.equal(M.clarifyQuestions("做个海报", 1, "standard"), null, "选了节点就不问");
  assert.equal(M.clarifyQuestions("做 3 张海报，比例 3:4", 0, "standard"), null, "已经说清楚的不问");
  assert.equal(M.clarifyQuestions("整理一下画布", 0, "standard"), null);
});

test("思考强度：任务上下文只接受 4 个枚举，运行时提示词带上强度与问答协议", () => {
  const { normalizeCanvasTaskContext } = require(path.join(ROOT, "electron/task-bootstrap.cjs"));
  const { buildPrompt } = require(path.join(ROOT, "electron/task-harness-orchestrator.cjs"));
  const base = { schemaVersion: 1, canvasId: "c1", selectedNodeIds: [], resourceRefs: [], completionConditions: ["完成"] };
  assert.equal(normalizeCanvasTaskContext(base).context.thinking, undefined);
  assert.equal(normalizeCanvasTaskContext({ ...base, thinking: "heavy" }).context.thinking, "heavy");
  assert.deepEqual(normalizeCanvasTaskContext({ ...base, thinking: "max" }), { ok: false, error: "INVALID_INPUT" });
  const heavy = buildPrompt({ goal: "做海报", stepInput: normalizeCanvasTaskContext({ ...base, thinking: "heavy" }).context });
  assert.match(heavy, /Thinking level: heavy/); assert.match(heavy, /openarc-questions/);
  const off = buildPrompt({ goal: "做海报", stepInput: normalizeCanvasTaskContext({ ...base, thinking: "off" }).context });
  assert.match(off, /Thinking level: off/); assert.doesNotMatch(off, /openarc-questions/);
  assert.doesNotMatch(buildPrompt({ goal: "x", stepInput: { thinking: "heavy" } }), /Thinking level/, "只认画布任务上下文");
});

test("元素：名字校验、@引用展开描述、长名字优先、参考图按模型名额加入", () => {
  assert.match(M.nameError("小 白"), /空格/);
  const cat = M.saveElement({ name: "小白", kind: "character", desc: "白色短毛", refs: ["openarc-asset:a", "openarc-asset:b", "openarc-asset:c"] });
  M.saveElement({ name: "小白猫", kind: "character", desc: "", refs: ["openarc-asset:d"] });
  assert.match(M.nameError("小白"), /已经有/);
  assert.equal(M.nameError("小白", undefined, cat.id), "", "改自己的名字不算重名");
  assert.deepEqual(M.mentionedElements("@小白猫 和 @小白").map((e) => e.name), ["小白猫", "小白"]);
  assert.equal(M.applyElements("@小白 在海边"), "「小白」（白色短毛） 在海边");
  assert.equal(M.applyElements("@小白猫 跳"), "「小白猫」 跳");

  const store = makeStore();
  const n = M.newNode("image", 0, 0, { id: "n", prompt: "@小白 和 @小白猫 在海边" }, models[0]);
  store.set({ doc: { nodes: [n], edges: [], comments: [] } });
  const req = M.buildRequest(store, store.node("n"));
  assert.equal(req.resolvedPrompt, "「小白」（白色短毛） 和 「小白猫」 在海边");
  assert.deepEqual(req.inputs.map((i) => [i.title, i.role, i.url]), [["小白猫", "reference", "openarc-asset:d"], ["小白", "reference", "openarc-asset:a"]], "maxRefs=2：每个元素先给一张");
  assert.equal(M.refRoom("audio", models[0], {}, []), 0);
  M.deleteElement(cat.id);
  assert.deepEqual(M.listElements().map((e) => e.name), ["小白猫"]);
});

test("生成历史：合并所有画布、按类型 / 关键词筛选、只有成功且有结果的可放到画布", () => {
  localStorage.setItem("canvas-next:runs:other", JSON.stringify([
    { id: "r1", node: "x", title: "春季主图", type: "image", model: "M", status: "done", secs: 3, time: "09:00", at: 1000, canvasName: "春季新品", out: { url: "openarc-asset:x", w: 800, h: 400 }, prompt: "樱花" },
    { id: "r2", node: "y", title: "失败的视频", type: "video", model: "V", status: "error", secs: 0, time: "09:01", at: 2000, canvasName: "春季新品" },
  ]));
  localStorage.setItem("canvas-next:runs:broken", "{not json");
  const store = makeStore();
  store.logRun({ node: "n", title: "猫", type: "image", model: "Banana Pro", status: "done", secs: 2, out: { url: "data:image/png;base64," + "A".repeat(5000) }, prompt: "白猫" });
  const saved = JSON.parse(localStorage.getItem("canvas-next:runs:c1"));
  assert.equal(saved[0].canvasName, "当前画布"); assert.equal(saved[0].out.url, undefined, "大的 data URL 不落本机");
  assert.equal(M.historyItems(store, "canvas").length, 1);
  const all = M.historyItems(store, "all");
  assert.deepEqual(all.map((r) => r.title), ["猫", "失败的视频", "春季主图"], "按时间倒序");
  assert.equal(all.find((r) => r.id === "r1").canvasName, "春季新品");
  assert.deepEqual(M.filterHistory(all, { type: "image", q: "", status: "all" }).map((r) => r.id).length, 2);
  assert.deepEqual(M.filterHistory(all, { type: "all", q: "樱花", status: "all" }).map((r) => r.id), ["r1"]);
  assert.deepEqual(M.filterHistory(all, { type: "all", q: "春季新品", status: "done" }).map((r) => r.id), ["r1"]);
  assert.equal(M.usable(all.find((r) => r.id === "r2")), false);
  const node = M.histNode(store, all.find((r) => r.id === "r1"), 10, 20);
  assert.equal(node.kind, "image"); assert.equal(node.w, 280); assert.equal(node.h, 140);
  assert.equal(node.data.gen.hist[0].url, "openarc-asset:x"); assert.equal(node.data.gen.prompt, "樱花");
});

test("放到画布时整体避开已有节点", () => {
  const a = { id: "a", x: 0, y: 0, w: 300, h: 300 };
  const moved = M.clearOf([a], [{ id: "n1", x: 100, y: 100, w: 200, h: 200 }, { id: "n2", x: 400, y: 100, w: 200, h: 200 }]);
  assert.equal(moved[0].x, 340); assert.equal(moved[1].x, 640, "相对位置不变");
  assert.equal(M.clearOf([a], [{ id: "n", x: 1000, y: 0, w: 100, h: 100 }])[0].x, 1000);
});
