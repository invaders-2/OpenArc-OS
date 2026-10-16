/**
 * 智能画布流式 LLM · 纯逻辑 + 画布服务出口单测。
 *
 * 被测（都是产品真实代码）：
 *   · src/canvas/canvasLlmStream.ts —— 事件→页面 SSE 帧、开流时机、没有正文时怎么如实收口；
 *   · electron/canvas-service.cjs 的 modelChatStream —— 与 modelCall 同一套前置 + ModelService.chatStream +
 *     既有 model:event 下行 + 取消经 canvas/runStop 中止在途请求。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";
import { CanvasStore } from "../electron/canvas-store.cjs";
import { CanvasService } from "../electron/canvas-service.cjs";
import {
  closeStreamWithoutContent,
  isStreamContentEvent,
  pageFrameFor,
  sseChunk,
  streamCloseErrorFrame,
  streamErrorMessage,
} from "../src/canvas/canvasLlmStream.ts";

const flush = () => new Promise((r) => setTimeout(r, 0));

/* ────────────────────────── 1. 纯逻辑：事件 → SSE 帧 / 开流 / 收口 ────────────────────────── */

test("L1 · SSE 帧格式与页面读法一致（data: <json>\\n\\n）", () => {
  assert.equal(sseChunk({ type: "delta", delta: "你好" }), 'data: {"type":"delta","delta":"你好"}\n\n');
  assert.ok(sseChunk({ type: "done", text: "x" }).endsWith("\n\n"));
  const parsed = JSON.parse(sseChunk({ type: "error", detail: "失败" }).slice(5).trim());
  assert.deepEqual(parsed, { type: "error", detail: "失败" });
});

test("L2 · 正文事件按顺序映射成 delta；start/usage/complete 不回帧", () => {
  const evs = [
    { type: "response.start" },
    { type: "text.delta", text: "A" },
    { type: "text.delta", text: "B" },
    { type: "usage", usage: { total_tokens: 3 } },
    { type: "text.delta", text: "C" },
    { type: "response.complete" },
  ];
  const frames = evs.map(pageFrameFor).filter(Boolean);
  assert.deepEqual(frames.map((f) => f.delta), ["A", "B", "C"], "顺序必须与上游一致");
  assert.equal(pageFrameFor({ type: "response.start" }), null);
  assert.equal(pageFrameFor({ type: "usage" }), null);
  assert.equal(pageFrameFor({ type: "response.complete" }), null);
  assert.equal(pageFrameFor(null), null);
  assert.equal(isStreamContentEvent({ type: "text.delta", text: "A" }), true);
  assert.equal(isStreamContentEvent({ type: "text.delta", text: "" }), false, "空 delta 不开流");
  assert.equal(isStreamContentEvent({ type: "response.start" }), false);
});

test("L3 · 错误传播：response.error → 页面 error 帧（可读文案）", () => {
  const evs = [{ type: "text.delta", text: "前半" }, { type: "response.error", error: "PARTIAL_RESPONSE" }];
  const frames = evs.map(pageFrameFor).filter(Boolean);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], { type: "delta", delta: "前半" });
  assert.equal(frames[1].type, "error");
  assert.match(frames[1].detail, /中途中断/);
  assert.match(streamErrorMessage("MODEL_TIMEOUT"), /超时/);
  assert.equal(streamErrorMessage("SOMETHING_WEIRD"), "SOMETHING_WEIRD", "未知码原样透出，不假装成功");
  assert.deepEqual(streamCloseErrorFrame("CANCELLED"), { type: "error", detail: "生成已停止" });
});

test("L4 · 一帧正文都没出过时的收口：非流式→409 降级；明确失败→502/504", () => {
  assert.deepEqual(closeStreamWithoutContent({ ok: true }), { status: 409, error: "STREAM_UNSUPPORTED", unsupported: true });
  assert.deepEqual(closeStreamWithoutContent({ ok: false, error: "MODEL_TIMEOUT" }), { status: 504, error: "MODEL_TIMEOUT", unsupported: false });
  assert.deepEqual(closeStreamWithoutContent({ ok: false, error: "CREDENTIAL_MISSING" }), { status: 502, error: "CREDENTIAL_MISSING", unsupported: false });
  assert.equal(closeStreamWithoutContent({ ok: false }).status, 502);
});

/* ────────────────────────── 2. 画布服务：modelChatStream ────────────────────────── */

async function fixture() {
  const fx = await createResourceFixture();
  const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const service = new CanvasService({ identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService, clock: fx.clock });
  const context = { sessionRef: fx.sessions.admin, appId: "canvas", source: "ui" };
  const created = service.createCanvas({ context, title: "流式画布", icon: "🧩" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const rev = Number(store.boardById(created.canvas.canvasId).revision);
  const add = service.applyCommand({ context, canvasId: created.canvas.canvasId, baseRevision: rev, command: { type: "node.add", node: { id: "n_llm", type: "llm", x: 0, y: 0 } } });
  assert.equal(add.ok, true, JSON.stringify(add));
  return { fx, store, service, context, canvasId: created.canvas.canvasId };
}

function fakeRuntime(streamImpl) {
  const calls = [];
  const completed = [];
  const emitted = [];
  const taskService = {
    createTask: () => ({ ok: true, task: { taskId: "task_1", revision: 1 } }),
    startTask: () => ({ ok: true }),
    failTask: () => ({ ok: true }),
    completeTask: () => ({ ok: true }),
    requestCancel: () => ({ ok: true }),
    cancelTask: () => ({ ok: true, task: { status: "CANCELLED" } }),
    getTask: () => ({ ok: true, task: { revision: 1, cancelRequested: false, status: "RUNNING" } }),
    getTaskBudget: () => ({ ok: true, remaining: { MODEL_CALLS: 10 }, authorized: {}, consumed: {} }),
    checkModelConfig: () => ({ ok: true }),
    startModelCall: () => ({ ok: true, call: { callId: "call_1" } }),
    completeModelCall: (input) => { completed.push(input); return { ok: true }; },
    failModelCall: () => ({ ok: true }),
    recordBudgetConsumption: () => ({ ok: true }),
  };
  const modelService = {
    resolveModel: () => ({ ok: true, model: { configId: "proc_1" } }),
    providerProtocol: {
      service: {
        emit: (event) => { emitted.push(event); },
        eventChannel: { progress: (payload) => ({ channel: "model:event", domain: "model", kind: "progress", sequence: emitted.length + 1, at: 1, payload }) },
      },
    },
    chatStream: streamImpl || (async (input) => {
      calls.push(input);
      input.onEvent({ type: "response.start" });
      input.onEvent({ type: "text.delta", text: "流式" });
      input.onEvent({ type: "text.delta", text: "文本" });
      input.onEvent({ type: "usage", usage: { total_tokens: 3 } });
      input.onEvent({ type: "response.complete" });
      return { ok: true, requestId: input.requestId, text: "流式文本", usage: { total_tokens: 3 } };
    }),
  };
  return { taskService, modelService, calls, completed, emitted };
}

function startChatRun(f) {
  const runtime = fakeRuntime(f.streamImpl);
  f.service.attachRuntime({ taskService: runtime.taskService, modelService: runtime.modelService });
  const started = f.service.startRun({ context: f.context, canvasId: f.canvasId, nodeId: "n_llm", kind: "chat" });
  assert.equal(started.ok, true, JSON.stringify(started));
  return { runtime, run: started };
}

test("S1 · modelChatStream 走 ModelService.chatStream，增量经既有 model:event 出站", async () => {
  const f = await fixture();
  f.streamImpl = null;
  const { runtime, run } = startChatRun(f);
  const res = await f.service.modelChatStream({ context: f.context, canvasId: f.canvasId, runId: run.runId, messages: [{ role: "user", content: "hi" }], configId: "cfg_1", requestId: "r1" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.text, "流式文本");
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].configId, "cfg_1");
  assert.equal(runtime.calls[0].requestId, "r1");
  assert.ok(runtime.calls[0].signal && typeof runtime.calls[0].signal.aborted === "boolean");
  const payloads = runtime.emitted.map((e) => e.payload);
  assert.ok(payloads.length >= 4, "response.start + 2 delta + usage + complete 都应出站");
  for (const p of payloads) { assert.equal(p.type, "canvas.stream"); assert.equal(p.requestId, "r1"); }
  assert.deepEqual(payloads.filter((p) => p.event.type === "text.delta").map((p) => p.event.text), ["流式", "文本"]);
  assert.equal(payloads[0].event.type, "response.start");
  assert.equal(payloads[payloads.length - 1].event.type, "response.complete");
  assert.equal(runtime.completed.length, 1, "完成一次 ModelCall 记账");
});

test("S2 · 前置同 modelCall：run 不存在 / 预算耗尽 / 没有流式出口 都明确拒绝且不发请求", async () => {
  const f = await fixture();
  f.streamImpl = null;
  const { runtime, run } = startChatRun(f);
  const bad = await f.service.modelChatStream({ context: f.context, canvasId: f.canvasId, runId: "run_missing", messages: [] });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "RUN_NOT_FOUND");
  runtime.taskService.getTaskBudget = () => ({ ok: true, remaining: { MODEL_CALLS: 0 }, authorized: {}, consumed: {} });
  const budget = await f.service.modelChatStream({ context: f.context, canvasId: f.canvasId, runId: run.runId, messages: [] });
  assert.equal(budget.ok, false);
  assert.equal(budget.error, "BUDGET_EXHAUSTED");
  assert.equal(runtime.calls.length, 0, "预算耗尽必须 0 次 provider 请求");
  // 没有流式出口：装配层晚绑定缺 chatStream 时明确 STREAM_UNAVAILABLE（不假装成功）
  const f2 = await fixture();
  const rt2 = fakeRuntime(null);
  delete rt2.modelService.chatStream;
  f2.service.attachRuntime({ taskService: rt2.taskService, modelService: rt2.modelService });
  const started2 = f2.service.startRun({ context: f2.context, canvasId: f2.canvasId, nodeId: "n_llm", kind: "chat" });
  const noStream = await f2.service.modelChatStream({ context: f2.context, canvasId: f2.canvasId, runId: started2.runId, messages: [] });
  assert.equal(noStream.ok, false);
  assert.equal(noStream.error, "STREAM_UNAVAILABLE");
});

test("S3 · 取消传播：stopRun → 在途 signal.aborted，且不再把结果回给画布", async () => {
  const f = await fixture();
  let captured = null;
  f.streamImpl = (input) => { captured = input; return new Promise((resolve) => { input.signal.addEventListener("abort", () => resolve({ ok: false, error: "CANCELLED", requestId: input.requestId }), { once: true }); }); };
  const { run } = startChatRun(f);
  const inflight = f.service.modelChatStream({ context: f.context, canvasId: f.canvasId, runId: run.runId, messages: [{ role: "user", content: "hi" }], requestId: "r2" });
  await flush();
  assert.ok(captured, "流式调用已发出");
  const stopped = f.service.stopRun({ context: f.context, canvasId: f.canvasId, runId: run.runId, reason: "USER_STOP" });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(captured.signal.aborted, true, "stopRun 必须中止在途 HTTP（不留悬挂请求）");
  const res = await inflight;
  assert.equal(res.ok, false);
  assert.ok(["RUN_STOPPED", "CANCELLED", "TASK_CANCELLED"].includes(res.error), String(res.error));
});
