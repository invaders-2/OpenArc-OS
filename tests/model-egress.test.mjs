/**
 * 模型/协议出网代理 · 单测（不联网；全部本机假代理 + 本机 TLS 目标）。
 *
 * 覆盖：
 *   E1-E8  CONNECT 隧道（CONNECT host:443 真的发出、隧道内请求/响应、流式、取消、407、502、不可达、超时、http 绝对 URI）
 *   E9    关闭代理 = 逐字走 baseFetch（同一参数 / 同一返回对象），不碰 globalThis.fetch
 *   E10   只影响模型出口（在线更新路径仍走原 fetch 直连）
 *   C1-C2 代理地址校验（http(s)://host:port；无路径/查询/凭据）
 *   D1-D4 model/proxy/get|set：授权、持久化（system_preferences）、审计、无重启即时生效
 *   S1-S2 main.cjs 接线只注入模型域；MODEL_COMMANDS 登记
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startFakeProxy, startTlsTarget, tlsFixtures, closedPort, sleep } from "./model-egress-fixtures.mjs";
import { createModelFixture } from "./model-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const { createEgressFetch, EGRESS_ERROR } = require(path.join(ROOT, "electron", "net-egress.cjs"));
const domain = require(path.join(ROOT, "electron", "model-domain.cjs"));
const modelBootstrap = require(path.join(ROOT, "electron", "model-bootstrap.cjs"));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const neverDirect = () => { throw new Error("baseFetch must not be called while proxy is enabled"); };
const expectCode = (code) => (error) => {
  assert.ok(error, "expected rejection");
  assert.equal(error.errorCode, code, "errorCode: " + error.errorCode + " message=" + error.message);
  return true;
};

/* ══════════════════════ E · 传输 ══════════════════════ */

test("E1 · CONNECT 隧道：真的发 CONNECT host:443；隧道内方法/头/体与响应状态/头/体都对", async () => {
  const target = await startTlsTarget();
  const proxy = await startFakeProxy({ upstreamPort: target.port });
  const { ca } = tlsFixtures();
  const fetchImpl = createEgressFetch({ getConfig: () => ({ enabled: true, url: proxy.url }), baseFetch: neverDirect, tlsOptions: { ca } });
  try {
    const res = await fetchImpl("https://localhost/echo/path?q=1", {
      method: "POST",
      headers: { "content-type": "application/json", "x-probe": "egress" },
      body: JSON.stringify({ hello: "world" }),
    });
    assert.equal(proxy.state.connects.length, 1, "必须恰好一次 CONNECT");
    assert.equal(proxy.state.connects[0], "localhost:443", "CONNECT 目标必须是 host:443");
    assert.equal(res.status, 201);
    assert.equal(res.ok, true);
    assert.equal(res.headers.get("x-echo"), "yes");
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = await res.json();
    assert.equal(body.method, "POST");
    assert.equal(body.url, "/echo/path?q=1");
    assert.equal(body.headers["x-probe"], "egress");
    assert.equal(body.headers.host, "localhost");
    assert.equal(body.body, JSON.stringify({ hello: "world" }));
    assert.equal(typeof res.body.getReader, "function", "body 必须是真流（getReader）");
  } finally { await proxy.close(); await target.close(); }
});

test("E2 · 隧道响应体是真流：getReader 可读；text() 也可用", async () => {
  const target = await startTlsTarget();
  const proxy = await startFakeProxy({ upstreamPort: target.port });
  const { ca } = tlsFixtures();
  const fetchImpl = createEgressFetch({ getConfig: () => ({ enabled: true, url: proxy.url }), baseFetch: neverDirect, tlsOptions: { ca } });
  try {
    const res = await fetchImpl("https://localhost/stream");
    assert.equal(typeof res.arrayBuffer, "function");
    const reader = res.body.getReader();
    const { value, done } = await reader.read();
    assert.equal(done, false);
    const parsed = JSON.parse(Buffer.from(value).toString("utf8"));
    assert.equal(parsed.url, "/stream");
    reader.releaseLock();
    res.body.cancel().catch(() => {});
  } finally { await proxy.close(); await target.close(); }
});

test("E3 · AbortSignal 取消会中断隧道请求（AbortError / CANCELLED）", async () => {
  const target = await startTlsTarget({ delayMs: 2000 });
  const proxy = await startFakeProxy({ upstreamPort: target.port });
  const { ca } = tlsFixtures();
  const fetchImpl = createEgressFetch({ getConfig: () => ({ enabled: true, url: proxy.url }), baseFetch: neverDirect, tlsOptions: { ca } });
  const controller = new AbortController();
  try {
    const pending = fetchImpl("https://localhost/slow", { signal: controller.signal });
    const rejection = assert.rejects(pending, (error) => (error && error.name === "AbortError" && error.errorCode === EGRESS_ERROR.CANCELLED) || (assert.fail("unexpected: " + error)));
    await sleep(250);
    controller.abort();
    await rejection;
  } finally { await proxy.close(); await target.close(); }
});

test("E4 · 代理 407 → PROXY_AUTH_REQUIRED（如实告知：当前不支持带认证的代理）", async () => {
  const proxy = await startFakeProxy({ mode: "auth" });
  const fetchImpl = createEgressFetch({ getConfig: () => ({ enabled: true, url: proxy.url }), baseFetch: neverDirect });
  try {
    await assert.rejects(fetchImpl("https://lgw.lovart.ai/v1/x"), expectCode(EGRESS_ERROR.PROXY_AUTH_REQUIRED));
    assert.equal(proxy.state.authRejects, 1);
  } finally { await proxy.close(); }
});

test("E5 · 代理 CONNECT 非 200 → PROXY_TUNNEL_FAILED", async () => {
  const proxy = await startFakeProxy({ mode: "fail" });
  const fetchImpl = createEgressFetch({ getConfig: () => ({ enabled: true, url: proxy.url }), baseFetch: neverDirect });
  try {
    await assert.rejects(fetchImpl("https://lgw.lovart.ai/v1/x"), expectCode(EGRESS_ERROR.PROXY_TUNNEL_FAILED));
  } finally { await proxy.close(); }
});

test("E6 · 代理不可达 → PROXY_UNREACHABLE", async () => {
  const port = await closedPort();
  const fetchImpl = createEgressFetch({ getConfig: () => ({ enabled: true, url: "http://127.0.0.1:" + port }), baseFetch: neverDirect, connectTimeoutMs: 2000 });
  await assert.rejects(fetchImpl("https://lgw.lovart.ai/v1/x"), expectCode(EGRESS_ERROR.PROXY_UNREACHABLE));
});

test("E7 · 代理不响应 → PROXY_TIMEOUT（连接阶段超时）", async () => {
  const proxy = await startFakeProxy({ mode: "hang" });
  const fetchImpl = createEgressFetch({ getConfig: () => ({ enabled: true, url: proxy.url }), baseFetch: neverDirect, connectTimeoutMs: 250 });
  try {
    await assert.rejects(fetchImpl("https://lgw.lovart.ai/v1/x"), expectCode(EGRESS_ERROR.PROXY_TIMEOUT));
  } finally { await proxy.close(); }
});

test("E8 · http 目标（回环）经代理走 absolute-form", async () => {
  const proxy = await startFakeProxy({});
  const fetchImpl = createEgressFetch({ getConfig: () => ({ enabled: true, url: proxy.url }), baseFetch: neverDirect });
  try {
    const res = await fetchImpl("http://127.0.0.1:9/local/path?x=1", { method: "PUT", headers: { "content-type": "text/plain" }, body: "abc" });
    assert.equal(proxy.state.requests.length, 1);
    assert.equal(proxy.state.requests[0].url, "http://127.0.0.1:9/local/path?x=1", "代理侧必须看到绝对 URI");
    assert.equal(proxy.state.requests[0].method, "PUT");
    assert.equal(proxy.state.requests[0].body, "abc");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.via, "proxy-absolute-form");
  } finally { await proxy.close(); }
});

/* ══════════════════════ E · 关闭 / 只影响模型出口 ══════════════════════ */

test("E9 · 关闭代理：逐字走 baseFetch（同一 input/init 引用与同一返回对象），不碰 globalThis.fetch", async () => {
  const marker = { ok: true, status: 200, headers: new Headers({ "x-direct": "1" }), text: async () => "direct" };
  let seen = null;
  const baseFetch = (input, init) => { seen = { input, init }; return marker; };
  const fetchImpl = createEgressFetch({ getConfig: () => ({ enabled: false, url: "http://127.0.0.1:1" }), baseFetch });
  const globalBefore = globalThis.fetch;
  const input = "https://api.example.com/v1/x";
  const init = { method: "POST", body: "{}" };
  const out = await fetchImpl(input, init);
  assert.equal(out, marker, "必须原样返回 baseFetch 的结果");
  assert.equal(seen.input, input);
  assert.equal(seen.init, init);
  assert.equal(globalThis.fetch, globalBefore, "不得改写 globalThis.fetch");
  assert.deepEqual(fetchImpl.describe(), { enabled: false, url: null });
});

test("E10 · 只影响模型出口：模型请求经代理（失败也不回落直连），在线更新走原 fetch 直连", async () => {
  const proxy = await startFakeProxy({ mode: "fail" });
  const directCalls = [];
  const baseFetch = async (input) => { directCalls.push(String(input)); return new Response("direct-ok", { status: 200 }); };
  const modelFetch = createEgressFetch({ getConfig: () => ({ enabled: true, url: proxy.url }), baseFetch });
  try {
    await assert.rejects(modelFetch("https://lgw.lovart.ai/v1/x"), expectCode(EGRESS_ERROR.PROXY_TUNNEL_FAILED));
    assert.deepEqual(directCalls, [], "模型出口失败绝不静默回落直连");
    const marketRes = await baseFetch("https://github.com/releases/x");
    assert.equal(await marketRes.text(), "direct-ok");
    assert.deepEqual(directCalls, ["https://github.com/releases/x"]);
  } finally { await proxy.close(); }
});

test("E11 · 配置坏 / 缺 baseFetch 时结构化失败，绝不静默直连", async () => {
  const bad = createEgressFetch({ getConfig: () => ({ enabled: true, url: "socks5://127.0.0.1:1" }), baseFetch: neverDirect });
  await assert.rejects(bad("https://x.example.com/"), expectCode(EGRESS_ERROR.PROXY_CONFIG_INVALID));
  const throwing = createEgressFetch({ getConfig: () => { throw new Error("db-down"); }, baseFetch: neverDirect });
  await assert.rejects(throwing("https://x.example.com/"), expectCode(EGRESS_ERROR.PROXY_CONFIG_INVALID));
});

test("E12 · recentError 保留最近一次代理侧结构化错误（命令结果据此附带原始出网码）", async () => {
  const proxy = await startFakeProxy({ mode: "auth" });
  const fetchImpl = createEgressFetch({ getConfig: () => ({ enabled: true, url: proxy.url }), baseFetch: neverDirect });
  try {
    assert.equal(fetchImpl.recentError(), null);
    await assert.rejects(fetchImpl("https://lgw.lovart.ai/v1/x"), expectCode(EGRESS_ERROR.PROXY_AUTH_REQUIRED));
    const recent = fetchImpl.recentError();
    assert.equal(recent.code, EGRESS_ERROR.PROXY_AUTH_REQUIRED);
    await sleep(5);
    assert.equal(fetchImpl.recentError(1), null, "超出窗口应视为过期");
  } finally { await proxy.close(); }
});

/* ══════════════════════ C · 校验 ══════════════════════ */

test("C1 · validateProxyUrl：只接受 http(s)://host:port，拒绝凭据/路径/查询/缺端口", () => {
  assert.equal(domain.validateProxyUrl("http://127.0.0.1:7897").ok, true);
  assert.equal(domain.validateProxyUrl("http://127.0.0.1:7897/").ok, true);
  assert.equal(domain.validateProxyUrl("https://proxy.example.com:8443").ok, true);
  assert.equal(domain.validateProxyUrl("http://127.0.0.1:7897/").url, "http://127.0.0.1:7897");
  for (const bad of [
    "", "   ", "127.0.0.1:7897", "socks5://127.0.0.1:1080", "ftp://127.0.0.1:21",
    "http://user:pass@127.0.0.1:7897", "http://127.0.0.1:7897/path", "http://127.0.0.1:7897?x=1",
    "http://127.0.0.1:7897#frag", "http://127.0.0.1", "file:///etc/passwd", "not a url",
  ]) {
    const r = domain.validateProxyUrl(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.error, "INVALID_INPUT", JSON.stringify(bad));
    assert.ok(r.reason, JSON.stringify(bad) + " 必须带结构化 reason");
  }
});

test("C2 · normalizeProxyConfig：enabled 必须布尔；关闭时忽略 url", () => {
  assert.deepEqual(domain.normalizeProxyConfig({ enabled: false, url: "garbage" }), { ok: true, enabled: false, url: null });
  assert.deepEqual(domain.normalizeProxyConfig({ enabled: true, url: "http://127.0.0.1:7897/" }), { ok: true, enabled: true, url: "http://127.0.0.1:7897" });
  assert.equal(domain.normalizeProxyConfig({ enabled: true, url: "http://user:pass@h:1" }).error, "INVALID_INPUT");
  assert.equal(domain.normalizeProxyConfig({ enabled: "true", url: "http://h:1" }).error, "INVALID_INPUT");
  assert.equal(domain.normalizeProxyConfig({ enabled: 1, url: "http://h:1" }).error, "INVALID_INPUT");
});

/* ══════════════════════ D · 命令：校验 / 持久化 / 审计 / 无重启 ══════════════════════ */

const f = await createModelFixture();
after(() => f.close());
const admin = f.adminCtx();
const settingsCtx = { ...admin, appId: "settings" };
f.store.upsertApp({ appId: "settings", name: "系统设置", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
f.modelService.grantAppModelAccess({ context: settingsCtx, appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });

const audits = [];
const originalAudit = f.store.auditAuthorization.bind(f.store);
f.store.auditAuthorization = (row) => { audits.push(row); return originalAudit(row); };

const ipc = { handlers: new Map(), handle(ch, fn) { this.handlers.set(ch, fn); }, removeHandler(ch) { this.handlers.delete(ch); } };
modelBootstrap.registerModelIpc({ ipcMain: ipc, service: f.modelService, identity: { current: admin.sessionRef }, isTrusted: () => true });
const invoke = (command, payload) => ipc.handlers.get("model:command")({}, payload === undefined ? { command } : { command, payload });

test("D1 · 默认关闭；set 落到 system_preferences；get 回读；出口无需重启即时生效", async () => {
  const get0 = await invoke("model/proxy/get");
  assert.equal(get0.ok, true);
  assert.equal(get0.enabled, false);
  assert.equal(get0.url, null);

  const set = await invoke("model/proxy/set", { enabled: true, url: "http://127.0.0.1:7897" });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.enabled, true);
  assert.equal(set.url, "http://127.0.0.1:7897");
  assert.equal(set.changed, true);

  const row = f.identity.connection.prepare("SELECT * FROM system_preferences WHERE preference_key = ?").get("model.egress.proxy");
  assert.ok(row, "必须写进已有的 system_preferences 表");
  assert.deepEqual(JSON.parse(row.preference_value), { enabled: true, url: "http://127.0.0.1:7897" });
  assert.equal(row.updated_by, f.users.admin);

  const get1 = await invoke("model/proxy/get");
  assert.deepEqual({ enabled: get1.enabled, url: get1.url }, { enabled: true, url: "http://127.0.0.1:7897" });

  // 出口 fetchImpl 现读同一份配置 → 无需重启
  const outlet = createEgressFetch({ getConfig: () => f.modelService.readEgressProxy(), baseFetch: () => new Response("x") });
  assert.deepEqual(outlet.describe(), { enabled: true, url: "http://127.0.0.1:7897" });
  await invoke("model/proxy/set", { enabled: false });
  assert.deepEqual(outlet.describe(), { enabled: false, url: null });
});

test("D2 · set 校验：关闭忽略 url；开启时非法地址给结构化 INVALID_INPUT + reason", async () => {
  const off = await invoke("model/proxy/set", { enabled: false, url: "http://127.0.0.1:7897" });
  assert.equal(off.ok, true);
  assert.equal(off.url, null);
  for (const [payload, reason] of [
    [{ enabled: true, url: "socks5://127.0.0.1:1080" }, "proxy-protocol-unsupported"],
    [{ enabled: true, url: "http://user:pass@127.0.0.1:7897" }, "proxy-credentials-unsupported"],
    [{ enabled: true, url: "http://127.0.0.1:7897/path" }, "proxy-path-unsupported"],
    [{ enabled: true, url: "http://127.0.0.1:7897?x=1" }, "proxy-path-unsupported"],
    [{ enabled: true, url: "http://127.0.0.1" }, "proxy-port-required"],
    [{ enabled: true, url: "" }, "proxy-url-required"],
    [{ enabled: "yes", url: "http://127.0.0.1:7897" }, "proxy-enabled-invalid"],
  ]) {
    const r = await invoke("model/proxy/set", payload);
    assert.equal(r.ok, false, JSON.stringify(payload));
    assert.equal(r.error, "INVALID_INPUT", JSON.stringify(payload));
    assert.equal(r.reason, reason, JSON.stringify(payload));
  }
  // 非法写入不得落库
  const row = f.identity.connection.prepare("SELECT * FROM system_preferences WHERE preference_key = ?").get("model.egress.proxy");
  assert.deepEqual(JSON.parse(row.preference_value), { enabled: false, url: null });
});

test("D3 · 审计：仅在真实变更时写一条 model.proxyEnabled", async () => {
  audits.length = 0;
  await invoke("model/proxy/set", { enabled: true, url: "http://127.0.0.1:7897" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "model.proxyEnabled");
  assert.equal(audits[0].decision, "ALLOW");
  assert.equal(audits[0].reasonCode, "PROXY_ENABLED");
  assert.equal(audits[0].appId, "settings");
  assert.equal(audits[0].actorUserId, f.users.admin);
  assert.equal(JSON.stringify(audits[0]).includes(":7897"), true, "审计只含地址，不含凭据");

  audits.length = 0;
  await invoke("model/proxy/set", { enabled: true, url: "http://127.0.0.1:7897" });
  assert.equal(audits.length, 0, "同值重复保存不产生审计");

  audits.length = 0;
  await invoke("model/proxy/set", { enabled: true, url: "http://127.0.0.1:7898" });
  assert.equal(audits.length, 1, "地址变更必须审计");
  assert.equal(audits[0].reasonCode, "PROXY_ENABLED");

  audits.length = 0;
  await invoke("model/proxy/set", { enabled: false });
  assert.equal(audits.length, 1, "关闭（变更）也审计");
  assert.equal(audits[0].reasonCode, "PROXY_DISABLED");
});

test("D4 · 权限：无 model.manage 的 App / 会话拿不到写入口", async () => {
  const noGrant = { ...f.ctx("alice"), appId: "canvas" };
  const denied = await f.modelService.setEgressProxy({ context: noGrant, enabled: true, url: "http://127.0.0.1:7897" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "PROXY_UNAUTHORIZED");
});

/* ══════════════════════ S · 接线与白名单 ══════════════════════ */

test("S1 · MODEL_COMMANDS 登记 model/proxy/get|set；未知能力命令仍被拒", () => {
  assert.ok(modelBootstrap.MODEL_COMMANDS.includes("model/proxy/get"));
  assert.ok(modelBootstrap.MODEL_COMMANDS.includes("model/proxy/set"));
  for (const c of ["proxy/createCapability", "proxy/getToken", "credential/getRaw"]) {
    assert.equal(modelBootstrap.MODEL_COMMANDS.includes(c), false, c);
  }
});

test("S2 · main.cjs 只把 egress 注入模型域；在线更新仍用原 fetch；不动 globalThis", () => {
  const main = read("electron/main.cjs");
  assert.ok(main.includes('require("./net-egress.cjs")'));
  assert.ok(main.includes("identity.modelService.fetchImpl = modelEgressFetch"));
  assert.ok(main.includes("providerProtocolService.fetchImpl = modelEgressFetch"));
  assert.equal(/globalThis\.fetch\s*=/.test(main), false, "不得改写 globalThis.fetch");
  assert.ok(main.includes("fetchImpl: typeof fetch === \"function\" ? fetch : null"), "在线更新必须保持原 fetch");
  const netEgress = read("electron/net-egress.cjs");
  assert.equal(/globalThis\.fetch\s*=/.test(netEgress), false);
});
