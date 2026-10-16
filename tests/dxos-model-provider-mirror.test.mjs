/**
 * 缺陷 1/2/3 回归：
 *   · providerOrigin 一律归一化为 URL origin（带尾斜杠 baseUrl 的 credential/set 不再 ENDPOINT_BLOCKED）；
 *   · credential/replace 自愈历史坏 providerOrigin；
 *   · ModelStore（identity.db）→ provider-protocol-store（providers.json）单向镜像：创建/更新/停用/删除/换密钥，
 *     显式持久映射 prv_* ↔ providers.json id，api_key 永远空串、真值只在 safeStorage 后端，镜像失败不半写；
 *   · defaults/set 校验并规范化 capability（llm.chat 等别名映射；未知值结构化报错）；
 *   · image/generate 不具备图像能力时回结构化「无可用能力」，不是 PROVIDER_NOT_FOUND。
 * 全部零外网：模型出口注入 stub fetch 或只断言能力门禁。
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
const { memoryCredentialBackend } = require("../electron/credential-store.cjs");
const { createModelProviderBridge, mapCapabilities, mapProtocol, MIRROR_ERROR } = require("../electron/model-provider-bridge.cjs");
const domain = require("../electron/model-domain.cjs");

const DEEPSEEK_BASE = "https://api.deepseek.com/";
const ORIGIN = "https://api.deepseek.com";
const SECRET = "sk-dxos-mirror-test-0000000000000001";

async function setup() {
  const f = await createModelFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-model-mirror-"));
  const bundle = createProviderProtocolBundle({ userDataDir: dir, backend: memoryCredentialBackend() });
  f.modelService.providerProtocol = bundle;
  const bridge = createModelProviderBridge({ modelStore: f.modelStore, credentialStore: f.credentialStore, providerProtocol: bundle, userDataDir: dir, clock: f.clock });
  f.modelService.providerBridge = bridge;
  // 与 model-bootstrap.cjs 同口径：渲染层回传的是 prv_*，出口经镜像映射解析
  bundle.service.setProviderIdResolver((providerId) => bridge.resolveProviderProtocolId(providerId));
  f.store.upsertApp({ appId: "settings", name: "系统设置", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
  f.modelService.grantAppModelAccess({ context: f.adminCtx(), appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });
  const ctx = () => ({ ...f.adminCtx(), appId: "settings" });
  return {
    f, bundle, bridge, ctx, dir,
    ppFile: path.join(dir, "dxos", "providers.json"),
    mapFile: path.join(dir, "dxos", "model-provider-map.json"),
    cleanup() { try { f.close(); } catch { /* ignore */ } fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function stubModelsFetch(env, seen = []) {
  env.f.modelService.fetchImpl = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ data: [{ id: "deepseek-chat", owned_by: "deepseek" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return seen;
}

test("缺陷1 · 带尾斜杠 baseUrl 的 credential/set 写 origin，provider/models 不再 ENDPOINT_BLOCKED", async () => {
  const env = await setup();
  try {
    const created = env.f.modelService.createProvider({ context: env.ctx(), displayName: "DeepSeek", baseUrl: DEEPSEEK_BASE });
    assert.equal(created.ok, true, JSON.stringify(created));
    const pid = created.provider.providerId;
    assert.equal(created.provider.baseUrl, DEEPSEEK_BASE); // validateEndpoint 保留尾斜杠原文

    const set = env.f.modelService.setProviderCredential({ context: env.ctx(), providerId: pid, secret: SECRET });
    assert.equal(set.ok, true, JSON.stringify(set));
    const meta = env.f.modelStore.credentialByRef(env.f.modelStore.providerById(pid).credential_ref);
    assert.equal(meta.provider_origin, ORIGIN, "providerOrigin 必须是 origin（无尾斜杠）");

    const seen = stubModelsFetch(env);
    const models = await env.f.modelService.listRemoteModels({ context: env.ctx(), providerId: pid });
    assert.notEqual(models.error, "ENDPOINT_BLOCKED");
    assert.equal(models.ok, true, JSON.stringify(models));
    assert.deepEqual(models.items.map((item) => item.id), ["deepseek-chat"]);
    assert.equal(seen[0], ORIGIN + "/models");
  } finally { env.cleanup(); }
});

test("缺陷1 · credential/replace 把历史坏 providerOrigin 自愈重建", async () => {
  const env = await setup();
  try {
    const created = env.f.modelService.createProvider({ context: env.ctx(), displayName: "DeepSeek", baseUrl: DEEPSEEK_BASE });
    const pid = created.provider.providerId;
    assert.equal(env.f.modelService.setProviderCredential({ context: env.ctx(), providerId: pid, secret: SECRET }).ok, true);
    const brokenRef = env.f.modelStore.providerById(pid).credential_ref;
    // 模拟修复前落库的坏值：整条 base_url（带尾斜杠）
    env.f.identity.connection.prepare("UPDATE model_credentials SET provider_origin = ? WHERE credential_ref = ?").run(DEEPSEEK_BASE, brokenRef);

    const rep = env.f.modelService.replaceProviderCredential({ context: env.ctx(), providerId: pid, secret: SECRET + "x" });
    assert.equal(rep.ok, true, JSON.stringify(rep));
    const healedRef = env.f.modelStore.providerById(pid).credential_ref;
    assert.notEqual(healedRef, brokenRef, "自愈应重建凭据而不是把坏 origin 留在原地");
    assert.equal(env.f.modelStore.credentialByRef(healedRef).provider_origin, ORIGIN);
    assert.equal(env.f.modelStore.credentialByRef(brokenRef).status, "DELETED");

    const seen = stubModelsFetch(env);
    const models = await env.f.modelService.listRemoteModels({ context: env.ctx(), providerId: pid });
    assert.equal(models.ok, true, JSON.stringify(models));
    assert.equal(seen.length, 1);
  } finally { env.cleanup(); }
});

test("缺陷2 · 镜像创建/更新/停用/换密钥/删除，显式持久映射且密钥不落 JSON", async () => {
  const env = await setup();
  try {
    const created = env.f.modelService.createProvider({ context: env.ctx(), displayName: "DeepSeek", baseUrl: DEEPSEEK_BASE });
    const pid = created.provider.providerId;
    let stored = env.bundle.store.load();
    assert.equal(stored.length, 1, "provider/create 必须镜像出 providers.json 条目");
    const ppId = stored[0].id;
    assert.notEqual(ppId, pid);
    assert.equal(JSON.parse(fs.readFileSync(env.mapFile, "utf8")).providers[pid], ppId, "映射必须显式持久化");

    // model/create → 能力挂到 providers.json 的 model.caps
    const model = env.f.modelService.createModel({ context: env.ctx(), providerId: pid, remoteModelId: "deepseek-chat", capabilities: ["chat", "tool-calling", "vision-input"] });
    assert.equal(model.ok, true, JSON.stringify(model));
    let entry = env.bundle.store.load().find((p) => p.id === ppId);
    assert.deepEqual(entry.models.map((m) => m.model), ["deepseek-chat"]);
    assert.deepEqual(entry.models[0].caps, ["llm", "llm.chat.vision"]);

    // credential/set → has_key（真值只在后端，JSON 里永远空串）
    assert.equal(env.f.modelService.setProviderCredential({ context: env.ctx(), providerId: pid, secret: SECRET }).ok, true);
    assert.equal(env.bundle.store.listPublic().find((p) => p.id === ppId).has_key, true);
    const raw = fs.readFileSync(env.ppFile, "utf8");
    assert.match(raw, /"api_key"\s*:\s*""/);
    assert.equal(raw.includes(SECRET), false, "providers.json 绝不能出现密钥明文");

    // 改名不改 id（映射不靠名字猜）
    assert.equal(env.f.modelService.updateProvider({ context: env.ctx(), providerId: pid, displayName: "DeepSeek 改名" }).ok, true);
    stored = env.bundle.store.load();
    assert.equal(stored.length, 1);
    assert.equal(stored.find((p) => p.id === ppId).name, "DeepSeek 改名");

    // 停用同步
    assert.equal(env.f.modelService.setProviderStatus({ context: env.ctx(), providerId: pid, status: "disabled" }).ok, true);
    assert.equal(env.bundle.store.load().find((p) => p.id === ppId).enabled, false);

    // 换密钥 → has_key 保持、仍无明文
    const rep = env.f.modelService.replaceProviderCredential({ context: env.ctx(), providerId: pid, secret: SECRET + "rotated" });
    assert.equal(rep.ok, true, JSON.stringify(rep));
    assert.equal(env.bundle.store.listPublic().find((p) => p.id === ppId).has_key, true);
    assert.equal(fs.readFileSync(env.ppFile, "utf8").includes("rotated"), false);

    // 删除同步（providers.json 条目 + 映射 + 后端密钥）
    assert.equal(env.f.modelService.deleteProvider({ context: env.ctx(), providerId: pid }).ok, true);
    assert.equal(env.bundle.store.load().some((p) => p.id === ppId), false);
    assert.equal(JSON.parse(fs.readFileSync(env.mapFile, "utf8")).providers[pid], undefined);
    assert.equal(env.bundle.store.listPublic().length, 0);
  } finally { env.cleanup(); }
});

test("缺陷2 · 镜像失败结构化报错且不半写（创建/更新/删除回滚）", async () => {
  const env = await setup();
  try {
    const originalPersist = env.bundle.store.persist;
    env.bundle.store.persist = () => { throw new Error("disk-full"); };

    const created = env.f.modelService.createProvider({ context: env.ctx(), displayName: "Broken", baseUrl: DEEPSEEK_BASE, credentialSecret: SECRET });
    assert.equal(created.ok, false);
    assert.equal(created.error, MIRROR_ERROR);
    assert.equal(typeof created.detail, "string");
    assert.equal(env.f.modelStore.providersOfOrg(env.f.orgId).filter((p) => p.display_name === "Broken").length, 0, "镜像失败必须回滚 ModelStore 创建");
    assert.equal(env.bundle.store.load().length, 0);
    const mapAfterFailure = fs.existsSync(env.mapFile) ? JSON.parse(fs.readFileSync(env.mapFile, "utf8")).providers : {};
    assert.deepEqual(mapAfterFailure, {}, "镜像失败不得留下任何映射");

    env.bundle.store.persist = originalPersist;
    const good = env.f.modelService.createProvider({ context: env.ctx(), displayName: "Good", baseUrl: DEEPSEEK_BASE });
    assert.equal(good.ok, true, JSON.stringify(good));
    const pid = good.provider.providerId;

    env.bundle.store.persist = () => { throw new Error("disk-full"); };
    const upd = env.f.modelService.updateProvider({ context: env.ctx(), providerId: pid, displayName: "Renamed" });
    assert.equal(upd.ok, false);
    assert.equal(upd.error, MIRROR_ERROR);
    assert.equal(env.f.modelStore.providerById(pid).display_name, "Good", "镜像失败必须回滚服务商字段");
    assert.equal(env.bundle.store.load().find((p) => p.id).name, "Good");

    const del = env.f.modelService.deleteProvider({ context: env.ctx(), providerId: pid });
    assert.equal(del.ok, false);
    assert.equal(del.error, MIRROR_ERROR);
    assert.ok(env.f.modelStore.providerById(pid), "镜像失败必须回滚删除");
    assert.equal(env.bundle.store.load().some((p) => p.name === "Good"), true, "镜像失败必须回滚 providers.json 删除");
  } finally { env.cleanup(); }
});

test("缺陷3 · defaults/set 校验并规范化 capability，未知值结构化报错", async () => {
  const env = await setup();
  try {
    const created = env.f.modelService.createProvider({ context: env.ctx(), displayName: "DeepSeek", baseUrl: DEEPSEEK_BASE });
    const model = env.f.modelService.createModel({ context: env.ctx(), providerId: created.provider.providerId, remoteModelId: "deepseek-chat", capabilities: ["chat", "tool-calling"] });
    const cid = model.model.configId;

    const alias = env.f.modelService.setDefault({ context: env.ctx(), capability: "llm.chat", configId: cid });
    assert.equal(alias.ok, true, JSON.stringify(alias));
    assert.equal(alias.capability, "chat");
    assert.equal(env.f.modelService.getDefaults({ context: env.ctx() }).personal.chat, cid, "别名必须真正落到规范名默认值");

    const unknown = env.f.modelService.setDefault({ context: env.ctx(), capability: "totally.unknown", configId: cid });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, domain.ERROR_CODE.INVALID_INPUT);
    assert.equal(unknown.detail, "unknown-capability");
    assert.equal(env.f.modelService.getDefaults({ context: env.ctx() }).personal["totally.unknown"], undefined);

    // 显式别名表可测
    assert.equal(domain.normalizeCapability("llm.chat"), "chat");
    assert.equal(domain.normalizeCapability("llm.chat.vision"), "vision-input");
    assert.equal(domain.normalizeCapability("image.generate"), "image-generation");
    assert.equal(domain.normalizeCapability("Chat"), "chat");
    assert.equal(domain.normalizeCapability("nope"), null);
    assert.equal(domain.originOf(DEEPSEEK_BASE), ORIGIN);
    assert.equal(domain.originOf("not a url"), null);
  } finally { env.cleanup(); }
});

test("缺陷2 · 镜像后 image/generate 回结构化不可用而不是 PROVIDER_NOT_FOUND", async () => {
  const env = await setup();
  try {
    const created = env.f.modelService.createProvider({ context: env.ctx(), displayName: "DeepSeek", baseUrl: DEEPSEEK_BASE });
    const pid = created.provider.providerId;
    env.f.modelService.createModel({ context: env.ctx(), providerId: pid, remoteModelId: "deepseek-chat", capabilities: ["chat"] });
    assert.equal(env.f.modelService.setProviderCredential({ context: env.ctx(), providerId: pid, secret: SECRET }).ok, true);
    const ppId = env.bundle.store.load()[0].id;

    // 传 providers.json 原生 id 与 ModelStore prv_* 都必须能解析到同一服务商
    const byMirrorId = await env.bundle.service.generateImage({ providerId: ppId, model: "deepseek-chat", prompt: "一只猫" });
    assert.equal(byMirrorId.ok, false);
    assert.equal(byMirrorId.error, "CAPABILITY_UNAVAILABLE");
    const byModelId = await env.bundle.service.generateImage({ providerId: pid, model: "deepseek-chat", prompt: "一只猫" });
    assert.equal(byModelId.ok, false);
    assert.notEqual(byModelId.error, "PROVIDER_NOT_FOUND");
    assert.equal(byModelId.error, "CAPABILITY_UNAVAILABLE");

    const noProvider = await env.bundle.service.generateImage({ prompt: "一只猫" });
    assert.equal(noProvider.ok, false);
    assert.notEqual(noProvider.error, "PROVIDER_NOT_FOUND");

    assert.deepEqual(mapCapabilities(["chat", "tool-calling", "vision-input"]), ["llm", "llm.chat.vision"]);
    assert.equal(mapProtocol("openai-compatible"), "openai");
  } finally { env.cleanup(); }
});

test("缺陷2 · provider/call 用 ModelStore prv_* id 解析到镜像服务商并真实调用", async () => {
  const env = await setup();
  try {
    const created = env.f.modelService.createProvider({ context: env.ctx(), displayName: "DeepSeek", baseUrl: DEEPSEEK_BASE });
    const pid = created.provider.providerId;
    env.f.modelService.createModel({ context: env.ctx(), providerId: pid, remoteModelId: "deepseek-chat", capabilities: ["chat"] });
    assert.equal(env.f.modelService.setProviderCredential({ context: env.ctx(), providerId: pid, secret: SECRET }).ok, true);
    assert.notEqual(pid, env.bundle.store.load()[0].id, "prv_* 不是 providers.json 的原生 id");

    const seen = [];
    env.bundle.service.fetchImpl = async (url, init) => {
      seen.push({ url: String(url), auth: init && init.headers ? init.headers.authorization : null });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const call = await env.bundle.service.call({ providerId: pid, model: "deepseek-chat", messages: [{ role: "user", content: "只回复：ok" }] });
    assert.equal(call.ok, true, JSON.stringify(call));
    assert.equal(call.text, "ok");
    assert.equal(seen[0].url, ORIGIN + "/v1/chat/completions");
    assert.equal(seen[0].auth, "Bearer " + SECRET);
  } finally { env.cleanup(); }
});
