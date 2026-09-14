/** D4-02B · Lifecycle / Concurrency / Capability cross-use probe。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHarnessFixture } from "./fixtures/harness-acp/fixture.mjs";

const require = createRequire(import.meta.url);
const { ModelProxy } = require("../electron/model-proxy.cjs");

const fx = await createHarnessFixture({ behavior: "success" });
const extraProxies = [];
after(async () => { for (const p of extraProxies) { try { await p.stop(); } catch { /* ignore */ } } await fx.close(); });

test("D4-02B-L1 · 5-run lifecycle：全部自然结束，0 orphan / 0 listener 累积", async () => {
  for (let i = 0; i < 5; i += 1) {
    const adapter = fx.makeAdapter();
    try {
      const start = await adapter.start({ context: fx.ctx, modelConfigId: fx.modelConfigId, maxCalls: 4, ttlMs: 120000 });
      const r = await adapter.prompt("run " + i, { timeoutMs: 90000 });
      assert.equal(r.ok, true, "run " + i);
      assert.equal(adapter.sessionId, start.sessionId);
      const d = await adapter.dispose();
      assert.equal(d.exited, true, "run " + i + " child 必须退出");
      assert.equal(adapter.bridge, null);
    } finally { try { await adapter.dispose(); } catch { /* ignore */ } }
  }
  assert.equal(fx.fp.state.requests, 5, "5 次 run = 5 次 Provider 请求（0 retry）");
});

test("D4-02B-L2 · 2 并发 Harness：独立 DSH_HOME / capability / session，不串", async () => {
  const a = fx.makeAdapter();
  const b = fx.makeAdapter();
  try {
    const [sa, sb] = await Promise.all([
      a.start({ context: fx.ctx, modelConfigId: fx.modelConfigId, maxCalls: 4, ttlMs: 120000 }),
      b.start({ context: fx.ctx, modelConfigId: fx.modelConfigId, maxCalls: 4, ttlMs: 120000 }),
    ]);
    assert.notEqual(sa.dshHome, sb.dshHome);
    assert.notEqual(sa.sessionId, sb.sessionId);
    assert.notEqual(sa.capabilityId, sb.capabilityId);
    const [ra, rb] = await Promise.all([
      a.prompt("concurrent A", { timeoutMs: 90000 }),
      b.prompt("concurrent B", { timeoutMs: 90000 }),
    ]);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, true);
    assert.equal(ra.text, rb.text);
    assert.equal(a.events.some((e) => e.raw === "agent_message_chunk"), true);
    assert.equal(b.events.some((e) => e.raw === "agent_message_chunk"), true);
  } finally {
    await a.dispose();
    await b.dispose();
  }
});

test("D4-02B-L3 · capability cross-use / exhausted：token 绑定进程内 capability，跨 proxy DENY", async () => {
  const proxyA = new ModelProxy({ modelService: fx.f.modelService, clock: fx.f.clock, ttlMs: 60000 });
  const proxyB = new ModelProxy({ modelService: fx.f.modelService, clock: fx.f.clock, ttlMs: 60000 });
  extraProxies.push(proxyA, proxyB);
  await proxyA.start();
  await proxyB.start();
  const capA = proxyA.issueCapability({ context: fx.ctx, configId: fx.modelConfigId, allowedCapabilities: ["chat"], maxCalls: 1, ttlMs: 60000 });
  assert.equal(capA.ok, true);
  const body = JSON.stringify({ messages: [{ role: "user", content: "x" }] });
  const cross = await fetch(proxyB.baseUrl + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + capA.capability.token }, body });
  assert.equal(cross.status, 401, "A 的 capability 在 B 的 proxy 上必须 DENY");
  const first = await fetch(proxyA.baseUrl + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + capA.capability.token }, body });
  assert.equal(first.status, 200);
  const second = await fetch(proxyA.baseUrl + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + capA.capability.token }, body });
  assert.equal(second.status, 429, "maxCalls=1 第二次必须 EXHAUSTED");
});
