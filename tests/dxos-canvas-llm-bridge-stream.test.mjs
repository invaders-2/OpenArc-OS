/**
 * 智能画布流式端点 · 桥（public/novai-canvas/openarc-bridge.js）纯逻辑单测。
 *
 * 用 vm 把**产品真实桥文件**装进一个最小 DOM 替身里，断言：
 *   · 端点白名单：\`POST /api/canvas-llm/stream\` 是**显式登记项**，未登记端点仍旧 501、出网仍被拒；
 *   · 流式分块：宿主 stream-open/stream-chunk/stream-end → 页面 Response.body 的 SSE 帧（顺序/结束/错误）；
 *   · 取消传播：页面 abort → 桥向宿主发 abort 消息（宿主据此中止主进程在途请求）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BRIDGE_SOURCE = fs.readFileSync(path.join(ROOT, "public/novai-canvas/openarc-bridge.js"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 0));

class FakeStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k) { return this.map.has(String(k)) ? this.map.get(String(k)) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(String(k)); }
  clear() { this.map.clear(); }
}

class FakeCustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }

/** 把真实桥文件装进最小 DOM 替身；返回驱动它所需的一切。*/
function loadBridge() {
  const posted = [];
  const listeners = {};
  class FakeXHR {}
  class FakeWebSocket {}
  const win = {
    top: null, self: null, window: null,
    parent: { postMessage: (msg) => { posted.push(msg); } },
    location: { href: "openarc-canvas://bundle/static/smart-canvas.html", origin: "openarc-canvas://bundle", hash: "" },
    localStorage: new FakeStorage(),
    sessionStorage: new FakeStorage(),
    XMLHttpRequest: FakeXHR,
    WebSocket: FakeWebSocket,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: () => true,
    fetch: async () => new Response("", { status: 200 }),
  };
  win.top = win; win.self = win; win.window = win;
  const doc = { documentElement: { setAttribute: () => {} }, addEventListener: () => {}, removeEventListener: () => {} };
  const sandbox = {
    window: win, document: doc, console,
    Response, ReadableStream, TextEncoder, TextDecoder, URL, DOMException, CustomEvent: FakeCustomEvent,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    FormData: undefined, FileReader: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(BRIDGE_SOURCE, sandbox, { filename: "openarc-bridge.js" });
  const fire = (data) => { for (const fn of listeners.message || []) fn({ data, source: null }); };
  fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "hello", token: "tok1", readOnly: false, canEdit: true, canvasId: "cv1", accountKey: "k1", reducedMotion: false });
  const lastCall = (method) => [...posted].reverse().find((m) => m.kind === "call" && m.method === method) || null;
  return { win, posted, fire, lastCall };
}

const json = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return t; } };

/* ───────────────── 1. 端点白名单：登记 / 未登记 / 出网 / 更新 ───────────────── */

test("B1 · POST /api/canvas-llm/stream 是显式登记项（走 model.chatStream，带 stream:true）", async () => {
  const b = loadBridge();
  const p = b.win.fetch("/api/canvas-llm/stream", { method: "POST", body: JSON.stringify({ model: "m", message: "hi" }) });
  await tick();
  const call = b.lastCall("model.chatStream");
  assert.ok(call, "必须登记为 model.chatStream");
  assert.equal(call.stream, true);
  assert.equal(call.params.body.model, "m");
  assert.equal(call.token, "tok1");
  // 页面取消/上游没有正文时的收口：先按 409 回，页面据此退回普通接口（诚实降级，不伪造分块）
  b.fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "stream-open", id: call.id, ok: false, status: 409, error: { error: "STREAM_UNSUPPORTED", message: "不支持流式" } });
  const res = await p;
  assert.equal(res.status, 409);
  assert.equal((await json(res)).error, "STREAM_UNSUPPORTED");
});

test("B2 · 非流式 LLM 端点仍走 model.chat（升级前的链路没有被动过）", async () => {
  const b = loadBridge();
  const p = b.win.fetch("/api/canvas-llm", { method: "POST", body: JSON.stringify({ model: "m" }) });
  await tick();
  const call = b.lastCall("model.chat");
  assert.ok(call);
  assert.equal(call.stream, undefined);
  b.fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "result", id: call.id, ok: true, value: { text: "普通结果" } });
  const res = await p;
  assert.equal(res.status, 200);
  assert.equal((await json(res)).text, "普通结果");
});

test("B3 · 未登记端点仍旧 501 OPENARC_UNSUPPORTED（含升级新增的 /api/agent/*）", async () => {
  const b = loadBridge();
  for (const url of ["/api/agent/plan", "/api/agent/run", "/api/suggestions", "/api/midjourney/submit"]) {
    const res = await b.win.fetch(url, { method: "POST", body: "{}" });
    assert.equal(res.status, 501, url);
    assert.equal((await json(res)).error, "OPENARC_UNSUPPORTED", url);
  }
  assert.equal(b.lastCall("model.chat"), null, "未登记端点绝不能落到任何模型出口");
});

test("B4 · 出网仍被拒（OPENARC_EGRESS_BLOCKED）、更新仍禁用", async () => {
  const b = loadBridge();
  const egress = await b.win.fetch("https://example.com/steal");
  assert.equal(egress.status, 501);
  assert.equal((await json(egress)).error, "OPENARC_EGRESS_BLOCKED");
  const update = await b.win.fetch("/api/check-update");
  assert.equal(update.status, 501);
  assert.equal((await json(update)).error, "OPENARC_UPDATE_DISABLED");
});

/* ───────────────── 2. 流式分块：顺序 / 结束 / 错误 ───────────────── */

async function readAll(reader) {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
  return text;
}

test("B5 · stream-open/chunk/end → Response.body 的 SSE 帧按序到达并正确结束", async () => {
  const b = loadBridge();
  const p = b.win.fetch("/api/canvas-llm/stream", { method: "POST", body: JSON.stringify({ model: "m" }) });
  await tick();
  const call = b.lastCall("model.chatStream");
  b.fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "stream-open", id: call.id, ok: true, status: 200 });
  const res = await p;
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const reader = res.body.getReader();
  const collecting = readAll(reader);
  await tick();
  b.fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "stream-chunk", id: call.id, data: "data: {\"type\":\"delta\",\"delta\":\"流\"}\n\n" });
  b.fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "stream-chunk", id: call.id, data: "data: {\"type\":\"delta\",\"delta\":\"式\"}\n\n" });
  b.fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "stream-chunk", id: call.id, data: "data: {\"type\":\"done\",\"text\":\"流式\"}\n\n" });
  b.fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "stream-end", id: call.id });
  const text = await collecting;
  const frames = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim()));
  assert.deepEqual(frames, [
    { type: "delta", delta: "流" },
    { type: "delta", delta: "式" },
    { type: "done", text: "流式" },
  ], "顺序必须与宿主下发一致");
});

test("B6 · 开流后的错误帧按原样透传（页面据此抛错，不静默成功）", async () => {
  const b = loadBridge();
  const p = b.win.fetch("/api/canvas-llm/stream", { method: "POST", body: "{}" });
  await tick();
  const call = b.lastCall("model.chatStream");
  b.fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "stream-open", id: call.id, ok: true, status: 200 });
  const res = await p;
  const collecting = readAll(res.body.getReader());
  await tick();
  b.fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "stream-chunk", id: call.id, data: "data: {\"type\":\"delta\",\"delta\":\"半\"}\n\n" });
  b.fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "stream-error", id: call.id, data: "data: {\"type\":\"error\",\"detail\":\"模型连接中途中断\"}\n\n" });
  const text = await collecting;
  assert.match(text, /"delta"/);
  assert.match(text, /\"type\":\"error\"/);
  assert.match(text, /模型连接中途中断/);
});

/* ───────────────── 3. 取消传播 ───────────────── */

test("B7 · 页面 abort → 桥向宿主发 abort 消息，且读流以 AbortError 收尾", async () => {
  const b = loadBridge();
  const ac = new AbortController();
  const p = b.win.fetch("/api/canvas-llm/stream", { method: "POST", body: "{}", signal: ac.signal });
  await tick();
  const call = b.lastCall("model.chatStream");
  b.fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "stream-open", id: call.id, ok: true, status: 200 });
  const res = await p;
  const reader = res.body.getReader();
  ac.abort();
  await assert.rejects(() => reader.read(), (e) => String(e && e.name) === "AbortError");
  const abort = [...b.posted].reverse().find((m) => m.kind === "abort");
  assert.ok(abort, "必须把取消传到宿主");
  assert.equal(abort.id, call.id);
  assert.equal(abort.method, "model.chatStream");
  assert.equal(abort.token, "tok1", "abort 也必须带本次实例 token（否则宿主忽略）");
});
