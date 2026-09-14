/**
 * D4-01 Closure E · Performance Baseline。
 *
 * 只建立第一版基线，不实现 Task/Token/Cost Budget、不限流、不调度。
 * 覆盖：Model Resolution（Personal + Organization，真实授权）100 次 ×3 run、
 * Model Proxy 10 并发 ×3 run、direct vs proxy overhead、Streaming TTFB、
 * Memory Smoke、Open Handle Smoke。
 *
 * 本机数字只用于解释当前实现，不构成产品 SLA。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createModelFixture } from "./model-fixtures.mjs";
import { startFakeProvider } from "./model-fake-provider.mjs";

const require = createRequire(import.meta.url);
const { ModelProxy } = require("../electron/model-proxy.cjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ART = path.join(ROOT, "artifacts", "d4-01");
const SECRET = "FAKE_PROVIDER_SECRET_PERF_D401_" + crypto.randomBytes(6).toString("hex");
const ITER = 100;
const PARALLEL = 10;
const RUNS = 3;

const report = {
  title: "D4-01 Closure E · Model performance baseline",
  at: new Date().toISOString(),
  machine: {
    os: process.platform + " " + os.release(),
    arch: process.arch,
    cpu: (os.cpus()[0] && os.cpus()[0].model) || "unknown",
    cores: os.cpus().length,
    totalMemBytes: os.totalmem(),
    node: process.version,
    electron: null,
  },
  runs: [],
  streaming: null,
  memory: null,
  handles: null,
  checks: [],
};
try { report.machine.electron = require("electron/package.json").version; } catch { /* ignore */ }
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail).slice(0, 300) }); return !!ok; };

const percentile = (sorted, p) => (sorted.length ? sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1))] : null);
const stats = (samples) => { const s = [...samples].sort((a, b) => a - b); const sum = s.reduce((a, b) => a + b, 0); return { n: s.length, min: +s[0].toFixed(3), p50: +percentile(s, 0.5).toFixed(3), p95: +percentile(s, 0.95).toFixed(3), max: +s[s.length - 1].toFixed(3), mean: +(sum / s.length).toFixed(3) }; };

const providers = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-01-e-perf-"));
const f = await createModelFixture({ dbPath: path.join(tmp, "identity.db"), storeRoot: path.join(tmp, "library"), timeoutMs: 5000 });
const admin = f.adminCtx();
f.store.upsertApp({ appId: "ai", name: "ai", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
f.modelService.grantAppModelAccess({ context: admin, appId: "ai", actions: ["model.view", "model.use", "model.manage", "model.test"] });
const ai = { sessionRef: admin.sessionRef, appId: "ai" };
const dana = { sessionRef: f.sessions.dana, appId: "ai" };
const proxy = new ModelProxy({ modelService: f.modelService, clock: f.clock });

let personalConfig = null;
let orgConfig = null;
let personalProvider = null;
let streamConfig = null;
let streamProvider = null;

function makeProvider(behavior, name, scope) {
  return startFakeProvider({ behavior, secretEcho: null }).then((fp) => {
    providers.push(fp);
    const p = f.modelService.createProvider({ context: ai, displayName: name, baseUrl: fp.baseUrl, scope, credentialSecret: SECRET });
    assert.equal(p.ok, true, JSON.stringify(p));
    const m = f.modelService.createModel({ context: ai, providerId: p.provider.providerId, remoteModelId: "fake-1", capabilities: ["chat", "tool-calling"], scope });
    assert.equal(m.ok, true, JSON.stringify(m));
    return { fp, providerId: p.provider.providerId, configId: m.model.configId };
  });
}

after(async () => {
  try { await proxy.stop(); } catch { /* ignore */ }
  for (const p of providers) { try { await p.close(); } catch { /* ignore */ } }
  try { f.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  report.handles = {
    proxyServer: proxy.server === null ? null : "still-open",
    proxyBaseUrl: proxy.baseUrl,
    capabilitiesRetained: proxy.capabilities.size,
    fakeProvidersClosed: providers.length,
    tmpRemoved: !fs.existsSync(tmp),
  };
  const failed = report.checks.filter((c) => !c.ok);
  report.summary = { total: report.checks.length, pass: report.checks.length - failed.length, fail: failed.length };
  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, "performance.json"), JSON.stringify(report, null, 2));
  console.log("\n" + report.summary.pass + "/" + report.summary.total + " D4-01 Closure E performance checks passed");
  if (failed.length) console.log("FAILED: " + failed.map((x) => x.name + " (" + x.detail + ")").join(" | "));
});

test("PERF1 · 真实授权 fixture（Personal + Organization default）", async () => {
  const pers = await makeProvider("success", "PerfPersonal", "PERSONAL");
  personalConfig = pers.configId; personalProvider = pers.fp;
  const org = await makeProvider("success", "PerfOrg", "ORGANIZATION");
  orgConfig = org.configId;
  const stream = await makeProvider("stream", "PerfStream", "PERSONAL");
  streamConfig = stream.configId; streamProvider = stream.fp;
  const setP = f.modelService.setDefault({ context: ai, capability: "chat", configId: personalConfig, scope: "PERSONAL" });
  assert.equal(setP.ok, true, JSON.stringify(setP));
  const setO = f.modelService.setDefault({ context: ai, capability: "chat", configId: orgConfig, scope: "ORGANIZATION" });
  assert.equal(setO.ok, true, JSON.stringify(setO));
  const p = f.modelService.resolveModel({ context: ai, capability: "chat" });
  const o = f.modelService.resolveModel({ context: dana, capability: "chat" });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.snapshot.source, "PERSONAL_DEFAULT", JSON.stringify(p));
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.snapshot.source, "ORGANIZATION_DEFAULT", JSON.stringify(o));
  check("PERF1 · Personal/Organization resolution 走真实授权", true, "personal=" + p.snapshot.source + " org=" + o.snapshot.source);
});

test("PERF2 · Resolution benchmark：100 次 ×3 run（真实授权，不含 Provider 网络）", () => {
  assert.ok(personalConfig && orgConfig);
  for (let run = 1; run <= RUNS; run += 1) {
    const personal = []; const organization = [];
    for (let i = 0; i < ITER; i += 1) {
      let t0 = performance.now();
      const p = f.modelService.resolveModel({ context: ai, capability: "chat" });
      personal.push(performance.now() - t0);
      assert.equal(p.ok, true, JSON.stringify(p));
      t0 = performance.now();
      const o = f.modelService.resolveModel({ context: dana, capability: "chat" });
      organization.push(performance.now() - t0);
      assert.equal(o.ok, true, JSON.stringify(o));
    }
    const row = { run, personal: stats(personal), organization: stats(organization) };
    report.runs.push(row);
    check("PERF2." + run + " · resolution run " + run, true, "personal p50=" + row.personal.p50 + "ms p95=" + row.personal.p95 + "ms org p50=" + row.organization.p50 + "ms");
  }
});

test("PERF3 · Proxy 10 并发 ×3 run + direct 对照 + overhead", async () => {
  await proxy.start();
  // 预热：避免第一次 HTTP/fetch 冷启动污染 run 1（否则会得到负 overhead 的假象）
  await Promise.all(Array.from({ length: 10 }, () => f.modelService.chat({ context: ai, configId: personalConfig, messages: [{ role: "user", content: "warm" }] })));
  const warm = proxy.issueCapability({ context: ai, configId: personalConfig, allowedCapabilities: ["chat"], maxCalls: 10, ttlMs: 60000 });
  assert.equal(warm.ok, true, JSON.stringify(warm));
  await Promise.all(Array.from({ length: 10 }, () => fetch(proxy.baseUrl + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + warm.capability.token }, body: JSON.stringify({ messages: [] }) })));
  for (let run = 1; run <= RUNS; run += 1) {
    // direct baseline
    let before = personalProvider.state.requests;
    const directSamples = [];
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      const t0 = performance.now();
      const r = await f.modelService.chat({ context: ai, configId: personalConfig, messages: [{ role: "user", content: "d" }] });
      directSamples.push(performance.now() - t0);
      assert.equal(r.ok, true, JSON.stringify(r));
    }));
    const directRequests = personalProvider.state.requests - before;

    // proxy
    const cap = proxy.issueCapability({ context: ai, configId: personalConfig, allowedCapabilities: ["chat"], maxCalls: PARALLEL, ttlMs: 60000 });
    assert.equal(cap.ok, true, JSON.stringify(cap));
    before = personalProvider.state.requests;
    const proxySamples = [];
    const results = await Promise.all(Array.from({ length: PARALLEL }, async (_, i) => {
      const t0 = performance.now();
      const res = await fetch(proxy.baseUrl + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + cap.capability.token }, body: JSON.stringify({ messages: [{ role: "user", content: "p" + i }] }) });
      const json = await res.json();
      proxySamples.push(performance.now() - t0);
      return { status: res.status, ok: json.ok, text: json.text };
    }));
    const proxyRequests = personalProvider.state.requests - before;
    // 第 11 次必须 EXHAUSTED，且不触达 Provider（无隐藏 retry）
    const extra = await fetch(proxy.baseUrl + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + cap.capability.token }, body: JSON.stringify({ messages: [] }) });
    const extraJson = await extra.json();
    const requestsAfterExtra = personalProvider.state.requests - before;

    const success = results.filter((r) => r.status === 200 && r.ok === true && r.text === "hello from fake").length;
    const d = stats(directSamples); const pr = stats(proxySamples);
    const row = { run, direct: d, proxy: pr, proxyOverheadMs: +(pr.p50 - d.p50).toFixed(3), success, error: PARALLEL - success, directRequests, proxyRequests, exhaustedStatus: extra.status, requestsAfterExtra };
    report.runs[run - 1].proxy = row;
    check("PERF3." + run + " · proxy 10 并发全部成功且无隐藏 retry", success === PARALLEL && directRequests === PARALLEL && proxyRequests === PARALLEL && extra.status === 429 && extraJson.error === "PROXY_UNAUTHORIZED" && requestsAfterExtra === PARALLEL, JSON.stringify({ success, directRequests, proxyRequests, extra: extra.status }));
  }
});

test("PERF4 · Streaming TTFB / 总时长 / delta 数 / 正确性", async () => {
  const events = [];
  let ttfb = null;
  const t0 = performance.now();
  const out = await f.modelService.chatStream({ context: ai, configId: streamConfig, messages: [{ role: "user", content: "stream" }], onEvent: (e) => { if (e.type === "text.delta" && ttfb === null) ttfb = performance.now() - t0; events.push(e.type); } });
  const total = performance.now() - t0;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.text, "Hello OpenArc", out.text);
  const deltas = events.filter((e) => e === "text.delta").length;
  const hasStart = events[0] === "response.start";
  const hasComplete = events.includes("response.complete");
  assert.equal(hasStart, true, JSON.stringify(events));
  assert.equal(hasComplete, true, JSON.stringify(events));
  assert.equal(deltas, 3, JSON.stringify(events));
  assert.equal(out.usage.totalTokens, 6, JSON.stringify(out.usage));
  report.streaming = { ttfbMs: +ttfb.toFixed(3), totalMs: +total.toFixed(3), deltaCount: deltas, order: events, text: out.text, usage: out.usage, complete: hasComplete };
  check("PERF4 · streaming 顺序/complete/usage 正确", hasStart && hasComplete && deltas === 3 && out.usage.totalTokens === 6, "ttfb=" + report.streaming.ttfbMs + "ms total=" + report.streaming.totalMs + "ms");
});

test("PERF5 · Memory smoke（RSS before/after，不判定泄露）", async () => {
  const before = process.memoryUsage().rss;
  const loops = 30;
  for (let i = 0; i < loops; i += 1) {
    f.modelService.resolveModel({ context: ai, capability: "chat" });
    await f.modelService.chat({ context: ai, configId: personalConfig, messages: [{ role: "user", content: "m" }] });
  }
  const after = process.memoryUsage().rss;
  report.memory = { rssBefore: before, rssAfter: after, deltaBytes: after - before, loops, note: "单次 smoke：只记录 RSS 变化，不作为 memory leak certification" };
  check("PERF5 · memory smoke 完成（RSS 记录）", true, "delta=" + ((after - before) / 1024 / 1024).toFixed(2) + "MB over " + loops + " loops");
});

test("PERF6 · Open handle smoke：proxy / providers / tmp 全部释放", async () => {
  await proxy.stop();
  for (const p of providers) await p.close();
  assert.equal(proxy.server, null);
  assert.equal(proxy.baseUrl, null);
  assert.equal(proxy.capabilities.size, 0);
  check("PERF6 · stop 后无 proxy server / capability / socket 残留", proxy.server === null && proxy.baseUrl === null && proxy.capabilities.size === 0, "");
});
