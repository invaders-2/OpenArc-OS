"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CanvasService } = require("../canvas-service.cjs");
function service(run, modelCall) {
  const store = { runById: (id) => id === run.run_id ? run : null, finishRun: () => ({ ...run, status: "DONE" }) };
  const svc = new CanvasService({ identity: { current: "u1" }, store, authStore: { appById: () => null, policyProvisionByKey: () => null, upsertApp: () => {}, upsertAppGrant: () => {} } });
  svc.modelCall = modelCall;
  return svc;
}
const run = { run_id: "r1", canvas_id: "c1", status: "RUNNING", started_at: 1, task_id: "t1" };
test("startAsyncModelCall returns immediately then DONE", async () => {
  const svc = service(run, async () => ({ ok: true, images: [{ dataUrl: "data:x" }] }));
  const started = svc.startAsyncModelCall({ context: {}, canvasId: "c1", runId: "r1", prompt: "x" });
  assert.equal(started.ok, true);
  assert.equal(svc.asyncRuns.get("r1").status, "RUNNING");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(svc.asyncRuns.get("r1").status, "DONE");
  assert.equal(svc.asyncRuns.get("r1").result.images.length, 1);
});
test("STOPPED is not overwritten by late result", async () => {
  let resolve;
  const svc = service(run, () => new Promise((done) => { resolve = done; }));
  svc.startAsyncModelCall({ context: {}, canvasId: "c1", runId: "r1" });
  svc.asyncRuns.set("r1", { ...(svc.asyncRuns.get("r1") || {}), status: "STOPPED", error: "RUN_STOPPED" });
  resolve({ ok: true, images: [] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(svc.asyncRuns.get("r1").status, "STOPPED");
});

test("FAILED stores real error and cross-canvas rejected", async () => {
  const svc = service(run, async () => ({ ok: false, error: "REAL_ERROR" }));
  assert.equal(svc.startAsyncModelCall({ context: {}, canvasId: "c2", runId: "r1" }).error, "RUN_NOT_FOUND");
  svc.startAsyncModelCall({ context: {}, canvasId: "c1", runId: "r1" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(svc.asyncRuns.get("r1").status, "FAILED");
  assert.equal(svc.asyncRuns.get("r1").error, "REAL_ERROR");
});
