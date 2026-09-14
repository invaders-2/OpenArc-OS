/** D4-01 · Model Proxy：capability 认证 / 每次重新授权 / maxCalls / 过期 / stale。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createModelFixture } from "./model-fixtures.mjs";
import { startFakeProvider } from "./model-fake-provider.mjs";
const require = createRequire(import.meta.url);
const { ModelProxy } = require("../electron/model-proxy.cjs");

const f = await createModelFixture();
const proxy = new ModelProxy({ modelService: f.modelService, clock: f.clock });
const _servers = [];
after(async () => { await proxy.stop(); for (const s of _servers) { try { await s.close(); } catch { /* ignore */ } } f.close(); });
const admin = f.adminCtx();
const ai = { sessionRef: admin.sessionRef, appId: "ai" };
f.modelService.grantAppModelAccess({ context: admin, appId: "ai", actions: ["model.view", "model.use", "model.manage", "model.test"] });
await proxy.start();

async function makeChatProvider(scope = "PERSONAL") {
  const fp = await startFakeProvider({ behavior: "success", secretEcho: "FAKE_PROVIDER_SECRET_PROXY_7788" });
  _servers.push(fp);
  const p = f.modelService.createProvider({ context: ai, displayName: "ProxyFake-" + scope, baseUrl: fp.baseUrl, scope, credentialSecret: "FAKE_PROVIDER_SECRET_PROXY_7788" });
  assert.equal(p.ok, true, JSON.stringify(p));
  const m = f.modelService.createModel({ context: ai, providerId: p.provider.providerId, remoteModelId: "fake-1", capabilities: ["chat", "tool-calling"], scope });
  assert.equal(m.ok, true, JSON.stringify(m));
  return { fp, providerId: p.provider.providerId, configId: m.model.configId };
}
const call = (token, body = {}) =>
  fetch(proxy.baseUrl + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }) });

test("Proxy: 无 token / 无效 token → 401", async () => {
  assert.equal((await call(null)).status, 401);
  assert.equal((await call("mpx_bogus")).status, 401);
});

test("Proxy: 有效 capability → 200；Provider 收到 key；响应不含 key", async () => {
  const { fp, configId } = await makeChatProvider();
  const cap = proxy.issueCapability({ context: ai, configId, maxCalls: 5 });
  assert.equal(cap.ok, true);
  const res = await call(cap.capability.token);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.text, "hello from fake");
  assert.equal(fp.state.authHeaders[0], "Bearer " + "FAKE_PROVIDER_SECRET_PROXY_7788");
  assert.equal(JSON.stringify(json).includes("FAKE_PROVIDER_SECRET_PROXY_7788"), false);
  const cap2 = proxy.issueCapability({ context: ai, configId, maxCalls: 5 });
  assert.equal(JSON.stringify(cap2).includes("FAKE_PROVIDER_SECRET_PROXY_7788"), false);
});

test("Proxy: maxCalls=1 原子消费，第二次 EXHAUSTED", async () => {
  const { configId } = await makeChatProvider();
  const cap = proxy.issueCapability({ context: ai, configId, maxCalls: 1 });
  assert.equal((await call(cap.capability.token)).status, 200);
  const second = await call(cap.capability.token);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).detail, "CAPABILITY_EXHAUSTED");
});

test("Proxy: 过期（可注入 clock）→ 401", async () => {
  const { configId } = await makeChatProvider();
  const cap = proxy.issueCapability({ context: ai, configId, maxCalls: 5, ttlMs: 1000 });
  assert.equal((await call(cap.capability.token)).status, 200);
  f.advance(1001);
  assert.equal((await call(cap.capability.token)).status, 401);
});

test("Proxy: per-call reauthorization —— disable User / App / Model / revoke access / config version", async () => {
  const { configId, providerId } = await makeChatProvider("ORGANIZATION");
  const u = await f.governanceService.createUser({ context: admin, identifier: "proxyu@openarc.test", password: "proxyu-password-1", displayName: "PU" });
  const login = await f.identity.login({ identifier: "proxyu@openarc.test", password: "proxyu-password-1" });
  const puCtx = { sessionRef: login.session.ref, appId: "ai" };
  const cap = proxy.issueCapability({ context: puCtx, configId, maxCalls: 20 });
  assert.equal(cap.ok, true, JSON.stringify(cap));
  assert.equal((await call(cap.capability.token)).status, 200);
  f.governanceService.setUserStatus({ context: admin, userId: u.userId, status: "DISABLED" });
  assert.equal((await call(cap.capability.token)).status, 403);
  f.governanceService.setUserStatus({ context: admin, userId: u.userId, status: "ACTIVE" });
  // 旧 session 失效 → 重新登录并新 capability
  const login2 = await f.identity.login({ identifier: "proxyu@openarc.test", password: "proxyu-password-1" });
  const puCtx2 = { sessionRef: login2.session.ref, appId: "ai" };
  const cap2 = proxy.issueCapability({ context: puCtx2, configId, maxCalls: 20 });
  f.authService.setAppStatus({ context: admin, appId: "ai", status: "disabled" });
  assert.equal((await call(cap2.capability.token)).status, 403);
  f.authService.setAppStatus({ context: admin, appId: "ai", status: "enabled" });
  // config version 变化（disable → enable 使 version++）
  const cap3 = proxy.issueCapability({ context: puCtx2, configId, maxCalls: 20 });
  f.modelService.setModelStatus({ context: ai, configId, status: "disabled" });
  assert.equal((await call(cap3.capability.token)).status, 403);
  f.modelService.setModelStatus({ context: ai, configId, status: "enabled" });
  // revoke App model access
  const cap4 = proxy.issueCapability({ context: puCtx2, configId, maxCalls: 20 });
  const grant = f.store.appGrantsForApp("ai").find((g) => g.resource_type === "model");
  f.modelService.revokeAppModelAccess({ context: admin, grantId: grant.id });
  assert.equal((await call(cap4.capability.token)).status, 403);
  f.modelService.grantAppModelAccess({ context: admin, appId: "ai", actions: ["model.view", "model.use", "model.manage", "model.test"] });
});

test("Proxy: revokeCapability 立即 401", async () => {
  const { configId } = await makeChatProvider();
  const cap = proxy.issueCapability({ context: ai, configId, maxCalls: 5 });
  proxy.revokeCapability(cap.capability.token);
  assert.equal((await call(cap.capability.token)).status, 401);
});
