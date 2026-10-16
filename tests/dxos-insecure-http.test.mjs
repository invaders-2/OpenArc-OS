/**
 * 显式明文 HTTP（默认关闭）回归。
 *
 * 安全底线：远程 http 默认仍被 ENDPOINT_BLOCKED / remote-requires-https 拦住；
 * 放行只能来自用户在添加/编辑服务商时的显式勾选（allowInsecureHttp），
 * 命中返回独立 scope REMOTE_HTTP_EXPLICIT，并把 allow_insecure_http=1 持久化在该服务商记录上，
 * 同时写一条授权审计（沿用 authorization_audit）。
 *
 * 覆盖：
 *   ① validateEndpoint 纯函数口径（默认拒 / 显式放行 / 私网不受影响 / https 不受影响）；
 *   ② provider/create 未勾选被拦；显式勾选可建，DB 字段与 safeProvider scope 正确；
 *   ③ 镜像把 allow_insecure_http 带进 providers.json；取消勾选/改回 https 会清零；
 *   ④ 授权审计留痕（action / reason_code / resource_ref）；
 *   ⑤ provider-protocol-service 出口按标记放行（image/generate 真发 http），未标记站点仍 ENDPOINT_BLOCKED。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createModelFixture } from "./model-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createProviderProtocolBundle } = require("../electron/provider-protocol-service.cjs");
const { createModelProviderBridge } = require("../electron/model-provider-bridge.cjs");
const { memoryCredentialBackend } = require("../electron/credential-store.cjs");
const domain = require("../electron/model-domain.cjs");

const HTTP_REMOTE = "http://43.130.6.197:8080";
const SECRET = "sk-insecure-http-test-0000000000000001";

async function setup() {
  const f = await createModelFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-insecure-http-"));
  const bundle = createProviderProtocolBundle({ userDataDir: dir, backend: memoryCredentialBackend() });
  f.modelService.providerProtocol = bundle;
  const bridge = createModelProviderBridge({ modelStore: f.modelStore, credentialStore: f.credentialStore, providerProtocol: bundle, userDataDir: dir, clock: f.clock });
  f.modelService.providerBridge = bridge;
  bundle.service.setProviderIdResolver((providerId) => bridge.resolveProviderProtocolId(providerId));
  f.store.upsertApp({ appId: "settings", name: "系统设置", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
  f.modelService.grantAppModelAccess({ context: f.adminCtx(), appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });
  const ctx = () => ({ ...f.adminCtx(), appId: "settings" });
  return {
    f, bundle, bridge, ctx, dir,
    ppFile: path.join(dir, "dxos", "providers.json"),
    cleanup() { try { f.close(); } catch { /* ignore */ } fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const insecureAudits = (f) => f.identity.connection
  .prepare("SELECT actor_user_id, app_id, resource_ref, action, decision, reason_code, permission_source FROM authorization_audit WHERE action = ? ORDER BY id")
  .all("model.insecureHttpAuthorized");

/* ══ ① validateEndpoint 纯函数 ══ */

test("① 默认仍拒远程 http；显式 allowInsecureHttp 才返回独立 scope REMOTE_HTTP_EXPLICIT", () => {
  const denied = domain.validateEndpoint(HTTP_REMOTE);
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "ENDPOINT_BLOCKED");
  assert.equal(denied.reason, "remote-requires-https");
  assert.equal(denied.insecureHttpRequired, true, "http 站点要如实标出需要一个显式放行");

  const allowed = domain.validateEndpoint(HTTP_REMOTE, { allowInsecureHttp: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.scope, "REMOTE_HTTP_EXPLICIT", "不得复用 REMOTE_HTTPS");
  assert.notEqual(allowed.scope, domain.ENDPOINT_SCOPE.REMOTE_HTTPS);
  assert.equal(allowed.origin, "http://43.130.6.197:8080");
  assert.equal(allowed.insecureHttp, true);

  // https 不受影响，仍是 REMOTE_HTTPS
  const https = domain.validateEndpoint("https://api.deepseek.com", { allowInsecureHttp: true });
  assert.equal(https.ok, true);
  assert.equal(https.scope, "REMOTE_HTTPS");

  // 私网 http 仍走 allowLan 口径：allowInsecureHttp 单独不足以放行
  const lan = domain.validateEndpoint("http://10.0.0.9:8080", { allowInsecureHttp: true });
  assert.equal(lan.ok, false);
  assert.equal(lan.reason, "lan-requires-explicit");

  // 明文放行只对 http 生效，危险协议仍拒
  const fileUrl = domain.validateEndpoint("file:///etc/passwd", { allowInsecureHttp: true });
  assert.equal(fileUrl.ok, false);
  assert.equal(fileUrl.reason.startsWith("protocol:"), true);
});

/* ══ ② 创建：未勾选被拦 / 勾选可建 ══ */

test("② provider/create 未勾选仍被 ENDPOINT_BLOCKED 拦住，不落库、不写审计", async () => {
  const env = await setup();
  try {
    const res = env.f.modelService.createProvider({ context: env.ctx(), displayName: "未勾选", baseUrl: HTTP_REMOTE, credentialSecret: SECRET });
    assert.equal(res.ok, false);
    assert.equal(res.error, "ENDPOINT_BLOCKED");
    assert.equal(res.reason, "remote-requires-https");
    assert.equal(env.f.modelStore.providersOfOrg(env.f.orgId).length, 0, "被拦时不得落库");
    assert.equal(env.bundle.store.load().length, 0, "被拦时不得镜像");
    assert.equal(insecureAudits(env.f).length, 0, "被拦时不得写放行审计");
  } finally { env.cleanup(); }
});

test("② 显式勾选后可建：独立 scope + allow_insecure_http 持久化 + provider/list 如实投影", async () => {
  const env = await setup();
  try {
    const res = env.f.modelService.createProvider({ context: env.ctx(), displayName: "Sub2API 网关", baseUrl: HTTP_REMOTE, allowInsecureHttp: true, credentialSecret: SECRET });
    assert.equal(res.ok, true, JSON.stringify(res));
    const pid = res.provider.providerId;
    assert.equal(res.provider.allowInsecureHttp, true);
    assert.equal(res.provider.endpointScope, "REMOTE_HTTP_EXPLICIT", "对外 scope 不得伪装成 REMOTE_HTTPS");

    const row = env.f.modelStore.providerById(pid);
    assert.equal(Number(row.allow_insecure_http), 1, "「不安全」事实必须持久化在服务商记录上");
    assert.equal(row.endpoint_scope, "REMOTE_HTTPS", "DB endpoint_scope 受既有 CHECK 约束，明文由独立列承载");

    const list = env.f.modelService.listProviders({ context: env.ctx() });
    const item = list.items.find((p) => p.providerId === pid);
    assert.equal(item.allowInsecureHttp, true);
    assert.equal(item.endpointScope, "REMOTE_HTTP_EXPLICIT");
  } finally { env.cleanup(); }
});

/* ══ ③ 镜像 ══ */

test("③ 单向镜像把 allow_insecure_http 带进 providers.json，未勾选站点不出现该字段", async () => {
  const env = await setup();
  try {
    const plain = env.f.modelService.createProvider({ context: env.ctx(), displayName: "HTTPS 站点", baseUrl: "https://api.deepseek.com" });
    assert.equal(plain.ok, true, JSON.stringify(plain));
    const insecure = env.f.modelService.createProvider({ context: env.ctx(), displayName: "Sub2API", baseUrl: HTTP_REMOTE, allowInsecureHttp: true });
    assert.equal(insecure.ok, true, JSON.stringify(insecure));

    const ppId = env.bridge.resolveProviderProtocolId(insecure.provider.providerId);
    assert.ok(ppId, "镜像必须有显式映射");
    const mirrored = env.bundle.store.load().find((p) => p.id === ppId);
    assert.equal(mirrored.allow_insecure_http, true, "标记必须随镜像进 providers.json");

    const raw = JSON.parse(fs.readFileSync(env.ppFile, "utf8"));
    assert.equal(raw.find((p) => p.id === ppId).allow_insecure_http, true);
    const plainId = env.bridge.resolveProviderProtocolId(plain.provider.providerId);
    assert.equal("allow_insecure_http" in raw.find((p) => p.id === plainId), false, "未勾选站点不得凭空多出字段");

    // 改回 https：显式清零，providers.json 同步删除
    const back = env.f.modelService.updateProvider({ context: env.ctx(), providerId: insecure.provider.providerId, baseUrl: "https://api.deepseek.com" });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal(Number(env.f.modelStore.providerById(insecure.provider.providerId).allow_insecure_http), 0);
    assert.equal(env.bundle.store.get(ppId).allow_insecure_http, undefined);
    assert.equal(back.provider.endpointScope, "REMOTE_HTTPS");
    assert.equal(back.provider.allowInsecureHttp, false);
  } finally { env.cleanup(); }
});

/* ══ ④ 审计 ══ */

test("④ 显式放行写授权审计：providerId + 「使用明文 HTTP」事实，且不泄漏密钥", async () => {
  const env = await setup();
  try {
    const res = env.f.modelService.createProvider({ context: env.ctx(), displayName: "Sub2API", baseUrl: HTTP_REMOTE, allowInsecureHttp: true, credentialSecret: SECRET });
    assert.equal(res.ok, true, JSON.stringify(res));
    const rows = insecureAudits(env.f);
    assert.equal(rows.length, 1, "放行必须留一条可审计记录");
    assert.equal(rows[0].resource_ref, res.provider.providerId);
    assert.equal(rows[0].reason_code, "INSECURE_HTTP_EXPLICIT");
    assert.equal(rows[0].decision, "ALLOW");
    assert.equal(rows[0].app_id, "settings");
    assert.equal(rows[0].permission_source, "EXPLICIT_USER_OPT_IN");
    const dump = JSON.stringify(rows);
    assert.equal(dump.includes(SECRET), false, "审计不得含密钥明文");

    // 未勾选创建不产生放行审计
    const another = env.f.modelService.createProvider({ context: env.ctx(), displayName: "HTTPS", baseUrl: "https://api.deepseek.com" });
    assert.equal(another.ok, true);
    assert.equal(insecureAudits(env.f).length, 1);
  } finally { env.cleanup(); }
});

/* ══ ⑤ 出口（技能 / 短剧 / 协议 / 图像同一 provider-protocol-service）══ */

test("⑤ 显式标记的站点按标记放行（image/generate 真发 http）；未标记的 http 站点仍 ENDPOINT_BLOCKED", async () => {
  const env = await setup();
  try {
    const res = env.f.modelService.createProvider({ context: env.ctx(), displayName: "Sub2API", baseUrl: HTTP_REMOTE, allowInsecureHttp: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    const pid = res.provider.providerId;
    env.f.modelService.createModel({ context: env.ctx(), providerId: pid, remoteModelId: "gemini-3.1-flash-image", capabilities: ["image-generation"] });
    assert.equal(env.f.modelService.setProviderCredential({ context: env.ctx(), providerId: pid, secret: SECRET }).ok, true);

    const seen = [];
    env.bundle.service.fetchImpl = async (url, init) => {
      seen.push({ url: String(url), auth: init && init.headers ? init.headers.authorization : null });
      return new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const image = await env.bundle.service.generateImage({ providerId: pid, model: "gemini-3.1-flash-image", prompt: "一只猫" });
    assert.equal(image.ok, true, JSON.stringify(image));
    assert.equal(seen[0].url, HTTP_REMOTE + "/v1/images/generations");
    assert.equal(seen[0].auth, "Bearer " + SECRET);

    // 反过来：providers.json 里一条 http 但没标记的站点，同一个出口必须继续拒绝
    env.bundle.store.upsertById("pp_plain_http", {
      name: "PlainHTTP", baseUrl: HTTP_REMOTE + "/", protocol: "openai",
      models: [{ model: "plain-image", caps: ["image"] }], enabled: true,
    });
    env.bundle.store.setKeys("pp_plain_http", { apiKey: SECRET });
    const blocked = await env.bundle.service.generateImage({ providerId: "pp_plain_http", model: "plain-image", prompt: "一只猫" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, "ENDPOINT_BLOCKED");
    assert.equal(blocked.detail, "remote-requires-https");
    assert.equal(seen.length, 1, "被拦的站点不得发出任何请求");

    // 取消勾选（同一 http 地址）会被结构化拦下，且不静默保留放行
    const uncheck = env.f.modelService.updateProvider({ context: env.ctx(), providerId: pid, allowInsecureHttp: false });
    assert.equal(uncheck.ok, false);
    assert.equal(uncheck.error, "ENDPOINT_BLOCKED");
    assert.equal(Number(env.f.modelStore.providerById(pid).allow_insecure_http), 1, "被拦的编辑不得改写已持久化的放行事实");
  } finally { env.cleanup(); }
});
