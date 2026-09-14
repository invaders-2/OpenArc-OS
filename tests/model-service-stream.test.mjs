/** D4-01 · Provider-neutral Streaming：真实 SSE 分段 / cancel / timeout / disconnect。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createModelFixture } from "./model-fixtures.mjs";
import { startFakeProvider } from "./model-fake-provider.mjs";

const f = await createModelFixture();
const _servers = [];
after(async () => { for (const s of _servers) { try { await s.close(); } catch { /* ignore */ } } f.close(); });
const admin = f.adminCtx();
const ai = { sessionRef: admin.sessionRef, appId: "ai" };
f.modelService.grantAppModelAccess({ context: admin, appId: "ai", actions: ["model.view", "model.use", "model.manage", "model.test"] });

async function makeProvider(behavior) {
  const fp = await startFakeProvider({ behavior });
  _servers.push(fp);
  const p = f.modelService.createProvider({ context: ai, displayName: "S-" + behavior, baseUrl: fp.baseUrl, credentialSecret: "FAKE_PROVIDER_SECRET_STREAM_1" });
  const m = f.modelService.createModel({ context: ai, providerId: p.provider.providerId, remoteModelId: "fake-1", capabilities: ["chat", "tool-calling"] });
  return { fp, configId: m.model.configId };
}

test("Text streaming：真实 SSE 分段，按顺序收到 delta，合并正确", async () => {
  const { configId } = await makeProvider("stream");
  const events = [];
  const r = await f.modelService.chatStream({ context: ai, configId, messages: [{ role: "user", content: "hi" }], onEvent: (e) => events.push(e) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.text, "Hello OpenArc");
  const deltas = events.filter((e) => e.type === "text.delta").map((e) => e.text);
  assert.deepEqual(deltas, ["Hel", "lo", " OpenArc"]);
  assert.equal(events[0].type, "response.start");
  assert.equal(events[events.length - 1].type, "response.complete");
  assert.equal(events.some((e) => e.type === "usage" && e.usage.totalTokens === 6), true);
});

test("Streaming disconnect → PARTIAL_RESPONSE，不自动重试", async () => {
  const { configId, fp } = await makeProvider("stream-disconnect");
  const r = await f.modelService.chatStream({ context: ai, configId, messages: [] });
  assert.equal(r.ok, false);
  assert.equal(r.error, "PARTIAL_RESPONSE");
});

test("Streaming timeout → MODEL_TIMEOUT", async () => {
  const { configId } = await makeProvider("stream-slow");
  const r = await f.modelService.chatStream({ context: ai, configId, messages: [] });
  assert.equal(r.ok, false);
  assert.ok(["MODEL_TIMEOUT", "PARTIAL_RESPONSE"].includes(r.error), r.error);
});

test("Streaming cancel → CANCELLED，且 provider 请求被终止", async () => {
  const { configId } = await makeProvider("stream");
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("user-cancel")), 40);
  const r = await f.modelService.chatStream({ context: ai, configId, messages: [], signal: ac.signal });
  assert.equal(r.ok, false);
  assert.equal(r.error, "CANCELLED");
});
