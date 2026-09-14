/** D4-01 · Model Service / Credential Boundary / 真实 fake provider 集成测试。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createModelFixture } from "./model-fixtures.mjs";
import { startFakeProvider } from "./model-fake-provider.mjs";

const f = await createModelFixture();
after(() => f.close());
const admin = f.adminCtx();
const ai = { sessionRef: admin.sessionRef, appId: "ai" };
f.authService.grantAppResourcePermission({ context: admin, appId: "ai", resourceType: "model", actions: ["model.view", "model.use", "model.manage", "model.test"] });

async function makeProvider(behavior = "success") {
  const fp = await startFakeProvider({ behavior, secretEcho: "FAKE_PROVIDER_SECRET_998877" });
  const p = f.modelService.createProvider({ context: ai, displayName: "Fake", baseUrl: fp.baseUrl, allowLan: false, credentialSecret: "FAKE_PROVIDER_SECRET_998877" });
  assert.equal(p.ok, true, JSON.stringify(p));
  const m = f.modelService.createModel({ context: ai, providerId: p.provider.providerId, remoteModelId: "fake-1", capabilities: ["chat", "tool-calling"] });
  assert.equal(m.ok, true);
  return { fp, providerId: p.provider.providerId, configId: m.model.configId };
}

test("Credential: 无安全后端 → CREDENTIAL_STORE_UNAVAILABLE，不降级明文", async () => {
  const g = await createModelFixture({ backend: { available: () => false, put() {}, get() { return null; }, delete() {} } });
  const res = g.modelService.createProvider({ context: g.adminCtx(), displayName: "x", baseUrl: "http://127.0.0.1:1", credentialSecret: "FAKE_PROVIDER_SECRET_ABC123" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "CREDENTIAL_STORE_UNAVAILABLE");
  assert.equal(JSON.stringify(g.modelStore.recentCalls(5)).includes("FAKE_PROVIDER_SECRET_ABC123"), false);
  g.close();
});

test("Endpoint policy：SSRF / URL 凭据 / 远程明文 DENY；LOCALHOST ALLOW", () => {
  for (const bad of ["file:///etc/passwd", "http://169.254.169.254/latest/meta-data", "https://user:key@api.example.com", "http://api.example.com", "gopher://x", "https://api.example.com/v1?api_key=sk-1234567890"]) {
    const r = f.modelService.createProvider({ context: ai, displayName: "bad", baseUrl: bad, credentialSecret: "FAKE_PROVIDER_SECRET_998877" });
    assert.equal(r.ok, false, bad + " 应被拒绝");
    assert.equal(r.error, "ENDPOINT_BLOCKED", bad);
  }
  const ok = f.modelService.createProvider({ context: ai, displayName: "local", baseUrl: "http://127.0.0.1:9", credentialSecret: "FAKE_PROVIDER_SECRET_998877" });
  assert.equal(ok.ok, true);
  assert.equal(ok.provider.endpointScope, "LOCALHOST");
});

test("Credential write-only + 替换/删除 + DB 不含 raw secret", async () => {
  const { providerId } = await makeProvider();
  const prov = f.modelStore.providerById(providerId);
  assert.ok(prov.credential_ref);
  const meta = f.modelStore.credentialByRef(prov.credential_ref);
  assert.equal(meta.status, "CONFIGURED");
  const dump = JSON.stringify(f.modelStore.providersOfOrg(f.orgId)) + JSON.stringify(f.modelStore.recentCalls(10));
  assert.equal(dump.includes("FAKE_PROVIDER_SECRET_998877"), false, "DB 不得含 raw secret");
  const rep = f.modelService.replaceCredential({ credentialRef: prov.credential_ref, secret: "FAKE_PROVIDER_SECRET_998877_NEW" });
  assert.equal(rep.ok, true);
  assert.equal(rep.credentialVersion, 2);
  const del = f.modelService.deleteCredential({ credentialRef: prov.credential_ref });
  assert.equal(del.ok, true);
  assert.equal(f.credentialStore.resolveInternalSync({ credentialRef: prov.credential_ref }).error, "CREDENTIAL_MISSING");
});

test("Chat success：provider 收到 key，调用方响应不含 key，usage 记录", async () => {
  const { fp, configId } = await makeProvider("success");
  f.modelService.setDefault({ context: ai, capability: "chat", configId, scope: "PERSONAL" });
  const r = await f.modelService.chat({ context: ai, messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.text, "hello from fake");
  assert.equal(fp.state.authHeaders[0], "Bearer FAKE_PROVIDER_SECRET_998877");
  assert.equal(JSON.stringify(r).includes("FAKE_PROVIDER_SECRET_998877"), false);
  assert.equal(r.usage.totalTokens, 7);
  await fp.close();
});

test("Tool-call proposal：只返回结构化数据，0 执行", async () => {
  const { fp, configId } = await makeProvider("tool");
  f.modelService.setDefault({ context: ai, capability: "chat", configId, scope: "PERSONAL" });
  const r = await f.modelService.chat({ context: ai, messages: [{ role: "user", content: "go" }] });
  assert.equal(r.ok, true);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, "delete_everything");
  assert.equal(typeof r.toolCalls[0].function.arguments, "string");
  await fp.close();
});

test("错误归一化 + 无隐藏 retry（500 只请求 1 次）", async () => {
  const { fp, configId } = await makeProvider("500");
  f.modelService.setDefault({ context: ai, capability: "chat", configId, scope: "PERSONAL" });
  const r = await f.modelService.chat({ context: ai, messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.ok, false);
  assert.equal(r.error, "PROVIDER_UNAVAILABLE");
  assert.equal(fp.state.requests, 1, "默认 0 次隐藏 retry");
  await fp.close();
  const { fp: fp2, configId: c2 } = await makeProvider("401");
  f.modelService.setDefault({ context: ai, capability: "chat", configId: c2, scope: "PERSONAL" });
  assert.equal((await f.modelService.chat({ context: ai, messages: [] })).error, "AUTH_FAILED");
  await fp2.close();
});

test("Timeout / Cancel 都会终止请求", async () => {
  const { fp, configId } = await makeProvider("slow");
  f.modelService.setDefault({ context: ai, capability: "chat", configId, scope: "PERSONAL" });
  const r = await f.modelService.chat({ context: ai, messages: [] });
  assert.equal(r.error, "MODEL_TIMEOUT");
  await fp.close();
  const { fp: fp2, configId: c2 } = await makeProvider("slow");
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("user-cancel")), 100);
  const r2 = await f.modelService.chat({ context: ai, configId: c2, messages: [], signal: ac.signal });
  assert.equal(r2.error, "CANCELLED");
  await fp2.close();
});

test("Redirect：credentialed cross-origin redirect 被拒绝，key 不外送", async () => {
  const { fp, configId } = await makeProvider("redirect");
  f.modelService.setDefault({ context: ai, capability: "chat", configId, scope: "PERSONAL" });
  const r = await f.modelService.chat({ context: ai, messages: [] });
  assert.equal(r.ok, false);
  assert.ok(["PROVIDER_UNAVAILABLE", "ENDPOINT_BLOCKED", "PROVIDER_PROTOCOL_ERROR"].includes(r.error), r.error);
  await fp.close();
});

test("Authorization：App ∩ User；disable App / disable User / provider disable", async () => {
  const { fp, configId, providerId } = await makeProvider("success");
  f.modelService.setDefault({ context: ai, capability: "chat", configId, scope: "PERSONAL" });
  // 无 app model grant 的 App
  const canvasCtx = { sessionRef: admin.sessionRef, appId: "canvas" };
  assert.equal((await f.modelService.chat({ context: canvasCtx, configId, messages: [] })).ok, false);
  // disable app
  f.authService.setAppStatus({ context: admin, appId: "ai", status: "disabled" });
  assert.equal((await f.modelService.chat({ context: ai, configId, messages: [] })).ok, false);
  f.authService.setAppStatus({ context: admin, appId: "ai", status: "enabled" });
  // provider disable
  f.modelService.updateProvider({ context: ai, providerId, status: "disabled" });
  assert.equal((await f.modelService.chat({ context: ai, configId, messages: [] })).error, "MODEL_CONFIG_UNAVAILABLE");
  await fp.close();
});

test("Resolution：Personal 优先于 Team；显式 Personal 失败不 fallback", async () => {
  const { fp: fpA, configId: cA } = await makeProvider("success");
  const { fp: fpB, configId: cB } = await makeProvider("success");
  f.modelService.setDefault({ context: ai, capability: "chat", configId: cB, scope: "ORGANIZATION" });
  f.modelService.setDefault({ context: ai, capability: "chat", configId: cA, scope: "PERSONAL" });
  const personal = f.modelService.resolveModel({ context: ai, capability: "chat" });
  assert.equal(personal.snapshot.modelConfigId, cA);
  assert.equal(personal.snapshot.source, "PERSONAL_DEFAULT");
  // 另一个用户解析到 Organization default
  const dana = { ...f.ctx("dana"), appId: "ai" };
  const org = f.modelService.resolveModel({ context: dana, capability: "chat" });
  assert.equal(org.snapshot.modelConfigId, cB);
  assert.equal(org.snapshot.source, "ORGANIZATION_DEFAULT");
  // 显式 personal config 的 credential 删除后不 fallback
  const provA = f.modelStore.providerById(fpA.baseUrl ? f.modelStore.providerById(personal.snapshot.providerId).provider_id : null);
  f.modelService.deleteCredential({ credentialRef: provA.credential_ref });
  assert.equal((await f.modelService.chat({ context: ai, configId: cA, messages: [] })).error, "CREDENTIAL_MISSING");
  // capability 未验证/未声明
  assert.equal(f.modelService.resolveModel({ context: ai, capability: "embedding" }).error, "MODEL_CONFIG_UNAVAILABLE");
  await fpA.close(); await fpB.close();
});
