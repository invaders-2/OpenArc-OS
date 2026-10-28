import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "node_modules/.cache/oa-canvas-lifecycle-" + process.pid + ".mjs");
const OUT_BACKEND = path.join(ROOT, "node_modules/.cache/oa-canvas-backend-" + process.pid + ".mjs");
const storeValues = new Map();
globalThis.localStorage = { getItem: (key) => storeValues.get(key) || null, setItem: (key, value) => storeValues.set(key, String(value)), removeItem: (key) => storeValues.delete(key) };
await Promise.all([
  esbuild.build({ entryPoints: [path.join(ROOT, "src/canvas/canvas-next/store.ts")], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent" }),
  esbuild.build({ entryPoints: [path.join(ROOT, "src/canvas/canvas-next/backend/bridge.ts")], bundle: true, format: "esm", platform: "neutral", outfile: OUT_BACKEND, logLevel: "silent" }),
]);
const { CanvasStore } = await import(pathToFileURL(OUT).href);
after(() => { fs.rmSync(OUT, { force: true }); fs.rmSync(OUT_BACKEND, { force: true }); });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const emptyDoc = { nodes: [], edges: [], comments: [] };

function storeBackend() {
  const modelCallbacks = new Set();
  const saves = [];
  return {
    kind: "bridge", saves, modelCallbacks,
    available: () => true,
    loadDoc: async () => ({ doc: structuredClone(emptyDoc), version: 1, source: "bridge" }),
    listModels: async () => [],
    onModelsChanged(callback) { modelCallbacks.add(callback); return () => modelCallbacks.delete(callback); },
    saveDoc: async (_id, doc, version) => { saves.push({ doc, version }); return { ok: true, version: (version || 1) + 1 }; },
    cancelAgentTask: async () => { throw new Error("dispose 不得取消后台任务"); },
  };
}

test("反复加载/销毁无新增订阅；待保存编辑恰好 flush 一次且 dispose 幂等", async () => {
  const backend = storeBackend();
  for (let i = 0; i < 25; i += 1) {
    const store = new CanvasStore(backend, "canvas-" + i);
    await store.load();
    assert.equal(backend.modelCallbacks.size, 1);
    store.mutate((doc) => ({ ...doc, nodes: [{ id: "pending-" + i, kind: "text", x: 0, y: 0, w: 100, h: 100, data: {} }] }));
    const first = store.dispose();
    const second = store.dispose();
    assert.equal(first, second);
    await Promise.all([first, second]);
    assert.equal(backend.modelCallbacks.size, 0);
    assert.equal(store.listeners.size, 0);
  }
  assert.equal(backend.saves.length, 25);
  assert.ok(backend.saves.every((save) => save.doc.nodes.length === 1 && save.doc.nodes[0].id.startsWith("pending-")));
});

test("在途保存与 dispose 不重复写；迟到加载和模型事件不更新旧 store", async () => {
  const backend = storeBackend();
  const store = new CanvasStore(backend, "canvas-race");
  await store.load();
  store.mutate((doc) => ({ ...doc, nodes: [{ id: "inflight", kind: "text", x: 0, y: 0, w: 100, h: 100, data: {} }] }));
  const saving = store.saveNow();
  await store.dispose();
  await saving;
  assert.equal(backend.saves.length, 1);

  const loading = deferred();
  backend.loadDoc = () => loading.promise;
  const late = new CanvasStore(backend, "canvas-late");
  const pending = late.load();
  await late.dispose();
  loading.resolve({ doc: { ...emptyDoc, nodes: [{ id: "late-node", kind: "text" }] }, version: 2, source: "bridge" });
  await pending;
  assert.equal(late.state.loaded, false);
  assert.equal(late.state.doc.nodes.length, 0);
  const modelsBefore = backend.listModels.length;
  for (const callback of backend.modelCallbacks) callback();
  assert.equal(backend.listModels.length, modelsBefore);
  late.set({ name: "late-write" });
  assert.notEqual(late.state.name, "late-write");
});

test("backend 根 dispose 退订 model/stream/focus/task watcher，后台 Task 不被取消", async () => {
  const listeners = new Map();
  class Target {
    constructor() { this.map = new Map(); }
    addEventListener(type, callback) { if (!this.map.has(type)) this.map.set(type, new Set()); this.map.get(type).add(callback); }
    removeEventListener(type, callback) { this.map.get(type)?.delete(callback); }
    count(type) { return this.map.get(type)?.size || 0; }
  }
  const target = new Target(); target.parent = target;
  const modelListeners = new Set(); const taskListeners = new Set();
  let taskReads = 0; let cancelCalls = 0;
  target.openarc = {
    model: {
      command: async () => ({ ok: true, models: [] }),
      onEvent(callback) { modelListeners.add(callback); return () => modelListeners.delete(callback); },
    },
    task: {
      command: async (request) => { if (request.type === "task/cancel") { cancelCalls += 1; return { ok: true }; } taskReads += 1; return { ok: true, task: { taskId: "task-1", status: "RUNNING" }, steps: [], events: [], calls: [], artifacts: [], verifications: [] }; },
      onEvent(callback) { taskListeners.add(callback); return () => taskListeners.delete(callback); },
    },
  };
  target.document = { visibilityState: "visible" };
  const previousWindow = globalThis.window; const previousDocument = globalThis.document;
  globalThis.window = target; globalThis.document = target.document;
  try {
    const { createBridgeBackend } = await import(pathToFileURL(path.join(ROOT, "node_modules/.cache/oa-canvas-backend-" + process.pid + ".mjs")).href);
    const backend = createBridgeBackend();
    await backend.listModels();
    backend.onModelsChanged(() => {});
    backend.watchAgentTask("task-1", () => {});
    assert.ok(modelListeners.size >= 1);
    assert.equal(taskListeners.size, 1);
    assert.ok(target.count("focus") >= 1);
    assert.ok(target.count("visibilitychange") >= 1);
    backend.dispose(); backend.dispose();
    assert.equal(modelListeners.size, 0);
    assert.equal(taskListeners.size, 0);
    assert.equal(target.count("focus"), 0);
    assert.equal(target.count("visibilitychange"), 0);
    assert.deepEqual(await backend.listModels(), []);
    const before = taskReads;
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.equal(taskReads, before);
    assert.equal(cancelCalls, 0);
  } finally {
    globalThis.window = previousWindow; globalThis.document = previousDocument;
  }
});

test("保存途中又改了文档：保存结束后补存最新文档，不会停在旧版本却显示已保存", async () => {
  const backend = storeBackend();
  const gate = deferred();
  const original = backend.saveDoc;
  let first = true;
  backend.saveDoc = async (...args) => { if (first) { first = false; await gate.promise; } return original(...args); };
  const store = new CanvasStore(backend, "canvas-save-again");
  await store.load();
  const node = (x) => ({ id: "n1", kind: "text", x, y: 0, w: 100, h: 100, data: {} });
  store.mutate((doc) => ({ ...doc, nodes: [node(111)] }));
  const saving = store.saveNow();
  store.mutate((doc) => ({ ...doc, nodes: [node(222)] }));
  await new Promise((resolve) => setTimeout(resolve, 900)); // 防抖在保存途中到点
  gate.resolve();
  await saving; await flush();
  assert.equal(backend.saves.length, 2);
  assert.equal(backend.saves.at(-1).doc.nodes[0].x, 222);
  assert.equal(store.state.saving, "saved");
  await store.dispose();
  assert.equal(backend.saves.length, 2);
});

test("撤销掉正在生成的节点会中止它的生成", async () => {
  const backend = storeBackend();
  const store = new CanvasStore(backend, "canvas-undo-run");
  await store.load();
  store.mutate((doc) => ({ ...doc, nodes: [{ id: "gen", kind: "text", x: 0, y: 0, w: 100, h: 100, data: {} }] }), { history: true });
  const abort = new AbortController();
  store.state = { ...store.state, runtime: { gen: { status: "running", progress: 0, abort, startedAt: Date.now() } } };
  store.undo();
  assert.equal(store.state.doc.nodes.length, 0);
  assert.equal(abort.signal.aborted, true);
  await store.dispose();
});
