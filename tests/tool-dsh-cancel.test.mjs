/** D4-03B Final Closure · cancel / crash / timeout（Tool Facade + official dsh）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { ToolFacadeBridge } = require("../electron/tool-facade-bridge.cjs");
const { buildToolManifest } = require("../electron/tool-registry.cjs");
const { ControlledToolProxy } = require("../electron/controlled-tool-proxy.cjs");
const { HarnessAdapter, HARNESS_ERROR } = require("../electron/harness-adapter.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(bridge, token, body) {
  const res = await fetch(bridge.baseUrl + "/tool-call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function customBridge(adapter, { execTimeoutMs = 15000, toolIds = ["resource.read.metadata"] } = {}) {
  const fx = await createToolHarnessFixture({ withAdapters: true });
  const created = await fx.createResource("OPENARC_DSH_VISIBLE_RESOURCE");
  fx.grantTool("ai", ["tool.resource.readMetadata"]);
  const proxy = new ControlledToolProxy({ registry: fx.toolRegistry, toolStore: fx.toolStore, authService: fx.f.authService, taskStore: fx.taskStore, adapters: { adapterFor: () => adapter }, clock: fx.f.clock });
  const bridge = new ToolFacadeBridge({ toolProxy: proxy, manifest: buildToolManifest(fx.toolRegistry, { toolIds }), clock: fx.f.clock, execTimeoutMs });
  await bridge.start();
  const run = fx.dshRunSetup();
  const cap = bridge.issueCapability({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, allowedTools: toolIds, maxCalls: 2 });
  assert.equal(cap.ok, true, JSON.stringify(cap));
  const close = async () => { try { await bridge.stop(); } catch { /* ignore */ } await fx.close(); };
  return { fx, bridge, proxy, run, cap, resourceRef: created.resource.resourceRef, close };
}

test("Cancel 竞争：Tool 执行中 cancelTask → BLOCKED / TASK_CANCELLED，不返回数据", async () => {
  const META = { resourceRef: "resource://res_x", name: "x", resourceType: "text", mimeType: "text/plain", version: 1, updatedAt: 1 };
  const adapter = { async prepare() { return {}; }, async execute({ signal }) { return new Promise((resolve) => { const t = setTimeout(() => resolve({ ok: true, result: { ...META } }), 700); signal?.addEventListener("abort", () => { clearTimeout(t); resolve({ ok: false, error: "ABORT" }); }); }); }, async verify() { return { ok: true }; } };
  const c = await customBridge(adapter);
  try {
    const p = call(c.bridge, c.cap.capability.token, { toolId: "resource.read.metadata", arguments: { resourceRef: c.resourceRef }, callId: "cancel_1" });
    await sleep(120);
    const cancel = c.fx.taskService.cancelTask({ context: c.run.context, taskId: c.run.taskId, expectedRevision: c.run.revision });
    assert.equal(cancel.ok, true, JSON.stringify(cancel));
    const r = await p;
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, "TASK_CANCELLED");
    const rows = c.fx.toolStore.executionsOfTask(c.run.taskId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "BLOCKED");
    assert.equal(rows[0].error_code, "TASK_CANCELLED");
  } finally { await c.close(); }
});

test("Task CANCELLED 后再尝试 Tool → DENY + 0 Domain call", async () => {
  const META = { resourceRef: "resource://res_x", name: "x", resourceType: "text", mimeType: "text/plain", version: 1, updatedAt: 1 };
  const adapter = { async prepare() { return {}; }, async execute() { return { ok: true, result: { ...META } }; }, async verify() { return { ok: true }; } };
  const c = await customBridge(adapter);
  try {
    const cancel = c.fx.taskService.cancelTask({ context: c.run.context, taskId: c.run.taskId, expectedRevision: c.run.revision });
    assert.equal(cancel.ok, true, JSON.stringify(cancel));
    let executes = 0;
    const orig = adapter.execute; adapter.execute = (...a) => { executes += 1; return orig(...a); };
    const r = await call(c.bridge, c.cap.capability.token, { toolId: "resource.read.metadata", arguments: { resourceRef: c.resourceRef }, callId: "cancel_2" });
    assert.equal(r.json.ok, false);
    assert.ok(["TASK_CANCELLED", "TOOL_PROPOSAL_STALE", "TOOL_FORBIDDEN"].includes(r.json.error), r.json.error);
    assert.equal(executes, 0);
    assert.equal(c.fx.toolStore.executionsOfTask(c.run.taskId).length, 0);
  } finally { await c.close(); }
});

test("Tool timeout：bounded timeout → TOOL_TIMEOUT + 0 retry", async () => {
  const adapter = { async prepare() { return {}; }, async execute() { return new Promise(() => { /* never */ }); }, async verify() { return { ok: true }; } };
  const c = await customBridge(adapter, { execTimeoutMs: 80 });
  try {
    const r = await call(c.bridge, c.cap.capability.token, { toolId: "resource.read.metadata", arguments: { resourceRef: c.resourceRef }, callId: "timeout_1" });
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, "TOOL_TIMEOUT");
    const rows = c.fx.toolStore.executionsOfTask(c.run.taskId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "FAILED");
    assert.equal(rows[0].error_code, "TOOL_TIMEOUT");
  } finally { await c.close(); }
});

test("Harness crash：tool chain 中 kill dsh → Task BLOCKED + capability revoked + 0 respawn", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", delayMs: 1500 });
  const created = await fx.createResource("OPENARC_DSH_VISIBLE_RESOURCE");
  await fx.f.searchService.indexResource(created.resource.resourceId);
  fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]);
  let adapter = null; const bridges = [];
  const factory = () => { adapter = new HarnessAdapter({ modelProxy: fx.proxy }); return adapter; };
  const bridgeFactory = (o) => { const b = new ToolFacadeBridge(o); bridges.push(b); return b; };
  // 注入 bridgeFactory：直接构造 orchestrator。
  const { TaskHarnessOrchestrator } = require("../electron/task-harness-orchestrator.cjs");
  const orch = new TaskHarnessOrchestrator({ taskService: fx.taskService, adapterFactory: factory, toolProxy: fx.toolProxy, clock: fx.f.clock, toolFacade: { enabled: true, toolIds: ["resource.read.metadata", "resource.search"], maxCalls: 4, ttlMs: 120000, bridgeFactory } });
  const ctx = fx.ctx();
  const t = fx.createTask();
  try {
    const p = orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !(adapter && adapter.events.some((e) => e.type === "tool.proposed"))) await sleep(50);
    assert.ok(adapter && adapter.events.some((e) => e.type === "tool.proposed"), "expected dsh to emit a tool proposal before crash");
    adapter.child.kill("SIGKILL");
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.task.status, "BLOCKED");
    assert.equal(adapter.processExited, true);
    assert.equal(fx.taskStore.harnessRunsOfTask(t.task.taskId).length, 1, "0 respawn / 0 replay");
    assert.equal(bridges.length, 1);
    assert.equal(bridges[0].server, null);
    assert.equal(bridges[0].baseUrl, null);
    assert.equal(bridges[0].capabilities.size, 0, "capability 必须 revoked");
  } finally { await orch.dispose(); await fx.close(); }
});
