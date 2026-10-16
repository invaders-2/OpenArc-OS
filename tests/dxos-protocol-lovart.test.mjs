/**
 * Lovart 官方 OpenAPI（adapterType=lovart，provider.protocol=lovart）离线验收。
 *
 * 全程本地 mock（experiments/dxos-lovart-protocol/lovart-mock.mjs）扮演 lgw.lovart.ai，
 * **真校验** AK/SK HMAC-SHA256 签名（缺头 / 访问键不符 / 方法·路径不符 / HMAC 不符 /
 * 时间戳超窗 → 401），并提供 catalog、project/save、chat、chat/status、chat/result 与产物下载。
 *
 * 覆盖：
 *   · 签名算法与官方 _sign 同式（HMAC(secret, "METHOD\npath\nts")）+ 5 个签名头 + Idempotency-Key
 *   · 凭据 JSON（{"accessKey","secretKey"}）解析与缺字段校验；错误 detail 绝不回显明文
 *   · catalog 解析与能力映射（IMAGE→image-generation / VIDEO→video-generation / 3D→空，如实标注）
 *   · send → watch → result 流程；轮询上限与 AbortSignal 取消
 *   · 错误映射 401/403/429/5xx/业务码/超时；密钥不泄露
 *   · provider-protocol-service 的 provider/call 与 image/generate（产物白名单落盘）
 *   · ModelService 的 provider/models、model/test、image/generate 按 adapterType 分发
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { startLovartMock } from "../experiments/dxos-lovart-protocol/lovart-mock.mjs";

const require = createRequire(import.meta.url);
const lovart = require("../electron/provider-adapter-lovart.cjs");
const adapter = require("../electron/provider-adapter.cjs");
const { mapProtocol } = require("../electron/model-provider-bridge.cjs");
const { ProviderProtocolService } = require("../electron/provider-protocol-service.cjs");
const { createModelFixture } = require("./model-fixtures.mjs");

const MOCK = { accessKey: "ak_mock_access", secretKey: "sk_mock_secret" };
const servers = [];
after(async () => { for (const server of servers) { try { await server.close(); } catch { /* ignore */ } } });

async function openMock(options = {}) {
  const mock = await startLovartMock({ accessKey: MOCK.accessKey, secretKey: MOCK.secretKey, ...options });
  servers.push(mock);
  return mock;
}
const credential = (mock) => lovart.serializeCredential({ accessKey: mock.credentials.accessKey, secretKey: mock.credentials.secretKey });

/* ① 签名算法 */
test("① 签名 = HMAC_SHA256(secret, METHOD\\npath\\nts)，5 个签名头齐备，POST 带 Idempotency-Key", () => {
  const ts = "1700000000";
  const expected = crypto.createHmac("sha256", "sk_secret").update("GET\n/v1/openapi/tools/catalog\n" + ts, "utf8").digest("hex");
  const signed = lovart.signRequest({ secretKey: "sk_secret", method: "get", path: "/v1/openapi/tools/catalog", timestamp: ts });
  assert.equal(signed.signature, expected, "签名必须与官方 _sign 逐字同式");
  assert.equal(signed.method, "GET");

  const cred = { ok: true, accessKey: "ak_1", secretKey: "sk_secret" };
  const headers = lovart.authHeaders({ credential: cred, method: "GET", path: "/v1/openapi/tools/catalog", timestamp: ts });
  assert.equal(headers["X-Access-Key"], "ak_1");
  assert.equal(headers["X-Timestamp"], ts);
  assert.equal(headers["X-Signature"], expected);
  assert.equal(headers["X-Signed-Method"], "GET");
  assert.equal(headers["X-Signed-Path"], "/v1/openapi/tools/catalog");
  assert.equal(headers["Content-Type"], "application/json");

  const post = lovart.buildRequest({ baseUrl: "https://lgw.lovart.ai", credential: cred, method: "POST", path: "/v1/openapi/chat", body: { prompt: "x" } });
  assert.equal(post.url, "https://lgw.lovart.ai/v1/openapi/chat");
  assert.ok(/^[a-f0-9]{32}$/.test(post.headers["Idempotency-Key"] || ""), "POST 必须带 uuid-hex Idempotency-Key");

  // 签名只覆盖 path（不含 query）；base 已带前缀不重复叠加。
  const withQuery = lovart.buildRequest({ baseUrl: "https://lgw.lovart.ai", credential: cred, method: "GET", path: "/v1/openapi/chat/status", query: { thread_id: "t1" } });
  assert.equal(withQuery.headers["X-Signed-Path"], "/v1/openapi/chat/status");
  assert.ok(withQuery.url.endsWith("?thread_id=t1"));
  assert.equal(lovart.resolveUrl("https://lgw.lovart.ai/v1/openapi", "/v1/openapi/chat"), "https://lgw.lovart.ai/v1/openapi/chat");
});

/* ② 凭据形态与缺字段校验 + 不泄露 */
test("② 凭据 JSON 解析与缺字段校验；detail 绝不回显明文", () => {
  const ok = lovart.parseCredential('{"accessKey":"ak_live","secretKey":"sk_live"}');
  assert.equal(ok.ok, true);
  assert.equal(ok.accessKey, "ak_live");
  assert.equal(ok.secretKey, "sk_live");

  const cases = [
    ["", "lovart-credential-missing"],
    ["not-json", "lovart-credential-not-json"],
    ['["a"]', "lovart-credential-not-object"],
    ['{"secretKey":"sk_only"}', "lovart-credential-missing-accessKey"],
    ['{"accessKey":"ak_only"}', "lovart-credential-missing-secretKey"],
  ];
  for (const [raw, detail] of cases) {
    const parsed = lovart.parseCredential(raw);
    assert.equal(parsed.ok, false, JSON.stringify(raw));
    assert.equal(parsed.detail, detail, JSON.stringify(raw));
    assert.equal(JSON.stringify(parsed).includes("ak_only"), false);
    assert.equal(JSON.stringify(parsed).includes("sk_only"), false);
  }
  assert.deepEqual(lovart.serializeCredential({ accessKey: "ak_x", secretKey: "sk_y" }), '{"accessKey":"ak_x","secretKey":"sk_y"}');
});

/* ③ catalog 解析与能力映射 */
test("③ catalog 解析与能力映射：IMAGE/VIDEO→生成能力，3D→空且如实标注", () => {
  const data = { tools: [
    { name: "generate_image_midjourney", display_name: "Midjourney Image", category: "IMAGE", is_premium: true },
    { name: "generate_video_kling", display_name: "Kling Video", category: "VIDEO", is_premium: false },
    { name: "generate_3d_mesh", display_name: "3D Mesh", category: "3D", is_premium: false },
    { name: "unknown_tool", display_name: "Unknown", category: "WEIRD" },
    { name: "", display_name: "no-id" },
  ] };
  const items = lovart.mapCatalog(data);
  assert.deepEqual(items.map((item) => item.id), ["generate_image_midjourney", "generate_video_kling", "generate_3d_mesh", "unknown_tool"]);
  assert.deepEqual(items[0].suggestedCapabilities, ["image-generation"]);
  assert.equal(items[0].premium, true);
  assert.deepEqual(items[1].suggestedCapabilities, ["video-generation"]);
  assert.deepEqual(items[2].suggestedCapabilities, [], "3D 在本仓没有能力口径，如实为空");
  assert.equal(items[2].unsupportedCapability, "3d");
  assert.deepEqual(items[3].suggestedCapabilities, []);
  assert.deepEqual(lovart.CATEGORY_CAPABILITIES.IMAGE, ["image-generation"]);
  assert.equal(lovart.capabilitiesForCategory("VIDEO").join(","), "video-generation");
  assert.deepEqual(lovart.capabilitiesForCategory("nope"), []);
  // 兼容 grouped 形状（categories[].tools）
  const grouped = lovart.mapCatalog({ categories: [{ name: "IMAGE", tools: [{ name: "a" }] }, { name: "VIDEO", tools: [{ name: "b" }] }] });
  assert.deepEqual(grouped.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(grouped[0].suggestedCapabilities, ["image-generation"]);
});

test("③b provider/models：mock 校验签名后返回 catalog 清单，能力建议来自分类", async () => {
  const mock = await openMock();
  const result = await lovart.listModels({ baseUrl: mock.baseUrl, apiKey: credential(mock) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.items.map((item) => item.id), ["generate_image_midjourney", "generate_image_flux", "generate_video_kling", "generate_3d_mesh"]);
  const catalog = mock.state.requests.find((r) => r.path === "/v1/openapi/tools/catalog");
  assert.equal(catalog.method, "GET");
  assert.equal(catalog.signedMethod, "GET");
  assert.equal(catalog.signedPath, "/v1/openapi/tools/catalog");
  assert.equal(catalog.signatureValid, true, "mock 侧必须校验签名通过");
});

/* ④ send → watch → result */
test("④ send → watch → result：project/save → chat → status → result，签名全通过", async () => {
  const mock = await openMock();
  const out = await lovart.generateComplete({
    baseUrl: mock.baseUrl, apiKey: credential(mock), kind: "image", model: "generate_image_flux",
    prompt: "一只猫", pollIntervalMs: 5, settleMs: 0, timeoutMs: 5000,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.threadId, "thread_mock_1");
  assert.equal(out.projectId, "proj_mock_1");
  assert.equal(out.status, "done");
  assert.equal(out.artifacts.length, 1);
  assert.match(out.artifacts[0].url, /\/artifacts\/mock-1\.png$/);
  assert.equal(out.artifacts[0].type, "image");
  assert.match(out.text, /已按你的提示生成图像/);

  const paths = mock.state.requests.map((r) => r.method + " " + r.path);
  assert.ok(paths.includes("POST /v1/openapi/project/save"), paths.join(", "));
  assert.ok(paths.includes("POST /v1/openapi/chat"), paths.join(", "));
  assert.ok(paths.includes("GET /v1/openapi/chat/status"), paths.join(", "));
  assert.ok(paths.includes("GET /v1/openapi/chat/result"), paths.join(", "));
  const send = mock.state.requests.find((r) => r.path === "/v1/openapi/chat");
  assert.deepEqual(send.body.tool_config, { prefer_tool_categories: { IMAGE: ["generate_image_flux"] } });
  assert.equal(send.idempotencyKey, true, "POST 必须带 Idempotency-Key");
  assert.equal(mock.state.authRejects, 0);
  for (const request of mock.state.requests) {
    if (request.path.startsWith("/v1/openapi")) assert.equal(request.signatureValid, true, request.path);
  }
});

test("④b 纯对话：不发 tool_config，返回 items[].text", async () => {
  const mock = await openMock();
  const out = await lovart.chatComplete({ baseUrl: mock.baseUrl, apiKey: credential(mock), messages: [{ role: "user", content: "你好" }], pollIntervalMs: 5, settleMs: 0, timeoutMs: 5000 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.match(out.text, /已按你的提示生成图像/);
  const send = mock.state.requests.find((r) => r.path === "/v1/openapi/chat");
  assert.equal(send.body.tool_config, undefined);
  assert.equal(send.body.prompt, "你好");
});

/* ⑤ 轮询上限 */
test("⑤ 轮询上限：status 一直 running → MODEL_TIMEOUT 且轮询次数封顶", async () => {
  const mock = await openMock();
  mock.state.mode = "never-done";
  const out = await lovart.generateComplete({ baseUrl: mock.baseUrl, apiKey: credential(mock), kind: "image", prompt: "x", pollIntervalMs: 5, maxPolls: 3, settleMs: 0, timeoutMs: 5000 });
  assert.equal(out.ok, false);
  assert.equal(out.error, "MODEL_TIMEOUT");
  assert.equal(out.detail, "lovart-poll-limit-reached");
  const polls = mock.state.requests.filter((r) => r.path === "/v1/openapi/chat/status").length;
  assert.equal(polls, 3, "必须恰好到 maxPolls 就停");
});

/* ⑥ 取消 */
test("⑥ 取消：AbortSignal 中断轮询 → CANCELLED，不留悬挂定时器", async () => {
  const mock = await openMock();
  mock.state.mode = "never-done";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("user-cancel")), 60);
  const out = await lovart.generateComplete({ baseUrl: mock.baseUrl, apiKey: credential(mock), kind: "image", prompt: "x", signal: controller.signal, pollIntervalMs: 1000, settleMs: 0, timeoutMs: 60000 });
  clearTimeout(timer);
  assert.equal(out.ok, false);
  assert.equal(out.error, "CANCELLED");
  // 取消发生在等待轮询间隔时 → 不应再发出新的 status 请求
  const polls = mock.state.requests.filter((r) => r.path === "/v1/openapi/chat/status").length;
  assert.ok(polls <= 1, "取消后不得继续轮询，实际 " + polls);
});

/* ⑦ 错误映射 */
test("⑦ 错误映射：401/403→AUTH_FAILED、429→RATE_LIMITED、5xx→PROVIDER_UNAVAILABLE、业务码→PROTOCOL_ERROR、超时→MODEL_TIMEOUT", async () => {
  for (const [mode, expected] of [["401", "AUTH_FAILED"], ["403", "AUTH_FAILED"], ["429", "RATE_LIMITED"], ["500", "PROVIDER_UNAVAILABLE"], ["503", "PROVIDER_UNAVAILABLE"]]) {
    const mock = await openMock();
    mock.state.mode = mode;
    const result = await lovart.listModels({ baseUrl: mock.baseUrl, apiKey: credential(mock) });
    assert.equal(result.ok, false, mode);
    assert.equal(result.error, expected, mode);
    await mock.close();
  }
  const business = await openMock();
  business.state.mode = "business-error";
  const businessResult = await lovart.listModels({ baseUrl: business.baseUrl, apiKey: credential(business) });
  assert.equal(businessResult.ok, false);
  assert.equal(businessResult.error, "PROVIDER_PROTOCOL_ERROR");
  assert.match(businessResult.detail, /mock business error/);

  const slow = await openMock();
  slow.state.delayMs = 800;
  const timedOut = await lovart.listModels({ baseUrl: slow.baseUrl, apiKey: credential(slow), timeoutMs: 120 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error, "MODEL_TIMEOUT");
  assert.equal(lovart.errorCodeFor({ status: 401 }), "AUTH_FAILED");
  assert.equal(lovart.errorCodeFor({ status: 429 }), "RATE_LIMITED");
  assert.equal(lovart.errorCodeFor({ kind: "timeout" }), "MODEL_TIMEOUT");
});

/* ⑧ 密钥不泄露 */
test("⑧ 密钥不泄露：签名错误的 401 与凭据错误 detail 都不含明文", async () => {
  const mock = await openMock();
  const wrong = lovart.serializeCredential({ accessKey: MOCK.accessKey, secretKey: "sk_wrong_secret_value" });
  const result = await lovart.listModels({ baseUrl: mock.baseUrl, apiKey: wrong });
  assert.equal(result.ok, false);
  assert.equal(result.error, "AUTH_FAILED");
  const dump = JSON.stringify(result);
  assert.equal(dump.includes("sk_wrong_secret_value"), false, "错误里不得出现 secretKey");
  assert.equal(dump.includes(MOCK.accessKey), false, "错误里不得出现 accessKey");
  assert.ok(mock.state.authRejects >= 1, "错误签名必须被 mock 拒绝");

  const accessKeyMismatch = await lovart.listModels({ baseUrl: mock.baseUrl, apiKey: lovart.serializeCredential({ accessKey: "ak_other", secretKey: MOCK.secretKey }) });
  assert.equal(accessKeyMismatch.error, "AUTH_FAILED");
  assert.equal(JSON.stringify(accessKeyMismatch).includes(MOCK.secretKey), false);
});

/* ⑨ provider-protocol-service 出口 */
function stubService(mock, { models } = {}) {
  const provider = () => ({
    id: "p_lovart", name: "Lovart Mock", base_url: mock.baseUrl, protocol: "lovart", api_key: credential(mock), enabled: true,
    models: models === undefined ? [{ model: "generate_image_flux", caps: ["image"] }, { model: "generate_video_kling", caps: ["video"] }] : models,
  });
  const store = { get: (id) => (String(id) === "p_lovart" ? provider() : null), listInternal: () => [provider()] };
  return new ProviderProtocolService({ store, userDataDir: null, clock: () => Date.now() });
}

test("⑨ provider/call：走 send→watch→result 的 agent 线路，返回 items[].text", async () => {
  const mock = await openMock();
  const service = stubService(mock);
  const result = await service.call({ providerId: "p_lovart", model: null, messages: [{ role: "user", content: "画一只猫" }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.text, /已按你的提示生成图像/);
  assert.equal(result.snapshot.protocol, "lovart");
  const send = mock.state.requests.find((r) => r.path === "/v1/openapi/chat");
  assert.equal(send.body.prompt, "画一只猫");
});

test("⑨b image/generate：产物按白名单落盘 dxos/media，文件真实存在", async () => {
  const mock = await openMock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-lovart-unit-"));
  try {
    const provider = () => ({ id: "p_lovart", name: "Lovart Mock", base_url: mock.baseUrl, protocol: "lovart", api_key: credential(mock), enabled: true, models: [{ model: "generate_image_flux", caps: ["image"] }] });
    const store = { get: (id) => (String(id) === "p_lovart" ? provider() : null), listInternal: () => [provider()] };
    const service = new ProviderProtocolService({ store, userDataDir: dir, clock: () => Date.now() });
    const result = await service.generateImage({ providerId: "p_lovart", model: "generate_image_flux", prompt: "一只猫" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.images.length, 1);
    assert.ok(result.images[0].fileName, JSON.stringify(result.images[0]));
    assert.equal(result.images[0].type, "image");
    const file = path.join(dir, "dxos", "media", result.images[0].fileName);
    assert.ok(fs.existsSync(file), "产物必须落盘到 dxos/media");
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "必须是真实 PNG");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("⑨c 产物主机白名单：非白名单 CDN 主机 → saved:false + 明确 reason（不静默）", async () => {
  const mock = await openMock();
  mock.state.artifactUrl = "https://cdn.not-observed.example/img.png";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-lovart-unit-"));
  try {
    const provider = () => ({ id: "p_lovart", name: "Lovart Mock", base_url: mock.baseUrl, protocol: "lovart", api_key: credential(mock), enabled: true, models: [{ model: "generate_image_flux", caps: ["image"] }] });
    const store = { get: (id) => (String(id) === "p_lovart" ? provider() : null), listInternal: () => [provider()] };
    const service = new ProviderProtocolService({ store, userDataDir: dir, clock: () => Date.now() });
    const result = await service.generateImage({ providerId: "p_lovart", model: "generate_image_flux", prompt: "一只猫" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.images[0].saved, false);
    assert.equal(result.images[0].reason, "artifact-host-not-allowlisted");
    assert.equal(lovart.isAllowedArtifactUrl("https://cdn.not-observed.example/x.png", "https://lgw.lovart.ai"), false);
    assert.equal(lovart.isAllowedArtifactUrl("https://lgw.lovart.ai/x.png", "https://lgw.lovart.ai"), true);
    assert.equal(lovart.isAllowedArtifactUrl("https://lgw.lovart.ai:8443/x.png", "https://lgw.lovart.ai"), true, "白名单按主机名判定");
    assert.equal(lovart.isAllowedArtifactUrl("https://lgw.lovart.ai.evil.example/x.png", "https://lgw.lovart.ai"), false, "后缀欺骗主机必须拒绝");
    assert.equal(lovart.isAllowedArtifactUrl("http://cdn.lovart.ai/x.png", "https://lgw.lovart.ai"), false, "远程明文 http 必须拒绝");
    // a.lovart.ai：真实联网观察到（2026-10-17），必须放行；仍不是"所有 lovart.ai 子域都放行"。
    assert.equal(lovart.isAllowedArtifactUrl("https://a.lovart.ai/artifacts/agent/x.png", "https://lgw.lovart.ai"), true, "已观察到的产物 CDN 主机必须放行");
    assert.equal(lovart.isAllowedArtifactUrl("https://a.lovart.ai:8443/artifacts/agent/x.png", "https://lgw.lovart.ai"), true, "白名单按主机名判定（端口无关）");
    assert.equal(lovart.isAllowedArtifactUrl("https://a.lovart.ai.evil.example/x.png", "https://lgw.lovart.ai"), false, "a.lovart.ai 也必须防后缀欺骗");
    assert.equal(lovart.isAllowedArtifactUrl("http://a.lovart.ai/x.png", "https://lgw.lovart.ai"), false, "a.lovart.ai 远程明文 http 仍拒绝");
    assert.equal(lovart.isAllowedArtifactUrl("https://b.lovart.ai/x.png", "https://lgw.lovart.ai"), false, "同父域的未观察主机仍拒绝");
    assert.equal(lovart.isAllowedArtifactUrl("https://artifacts.lovart.ai/x.png", "https://lgw.lovart.ai"), false, "未观察主机保持拒绝");
    assert.deepEqual([...lovart.ARTIFACT_HOST_ALLOWLIST], ["lgw.lovart.ai", "a.lovart.ai"]);
    assert.deepEqual([...lovart.OBSERVED_HOSTS], ["lgw.lovart.ai", "a.lovart.ai"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ⑩ ModelService 分发 */
test("⑩ ModelService：provider/models 来自 catalog、model/test 走凭据探测、image/generate 走 lovart 适配器", async () => {
  const mock = await openMock();
  const fixture = await createModelFixture({ timeoutMs: 8000 });
  try {
    const admin = fixture.adminCtx();
    const context = { sessionRef: admin.sessionRef, appId: "ai" };
    fixture.modelService.grantAppModelAccess({ context: admin, appId: "ai", actions: ["model.view", "model.use", "model.manage", "model.test"] });
    const created = fixture.modelService.createProvider({ context, displayName: "Lovart Mock", baseUrl: mock.baseUrl, adapterType: "lovart", credentialSecret: credential(mock) });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.provider.adapterType, "lovart");

    const remote = await fixture.modelService.listRemoteModels({ context, providerId: created.provider.providerId });
    assert.equal(remote.ok, true, JSON.stringify(remote));
    assert.deepEqual(remote.items.map((m) => m.id), ["generate_image_midjourney", "generate_image_flux", "generate_video_kling", "generate_3d_mesh"]);
    const image = remote.items.find((m) => m.id === "generate_image_flux");
    assert.deepEqual(image.suggestedCapabilities, ["image-generation"]);
    const threeD = remote.items.find((m) => m.id === "generate_3d_mesh");
    assert.deepEqual(threeD.suggestedCapabilities, [], "3D 不得被硬塞成 chat");
    assert.equal(threeD.unsupportedCapability, "3d");
    assert.equal(remote.items[0].category, "IMAGE");

    const model = fixture.modelService.createModel({ context, providerId: created.provider.providerId, remoteModelId: "generate_image_flux", capabilities: ["image-generation"] });
    assert.equal(model.ok, true, JSON.stringify(model));
    const configId = model.model.configId;

    const tested = await fixture.modelService.testConnection({ context, configId });
    assert.equal(tested.ok, true, JSON.stringify(tested));
    assert.equal(tested.reachable, true);
    assert.equal(tested.credentialAccepted, true);
    assert.equal(tested.inference, false, "catalog 探测不能冒充 inference:true");
    assert.equal(tested.probe, "catalog");

    const generated = await fixture.modelService.generateImage({ context, configId, prompt: "一只猫" });
    assert.equal(generated.ok, true, JSON.stringify(generated));
    assert.equal(generated.images.length, 1);
    assert.match(generated.images[0].url, /\/artifacts\/mock-1\.png$/);

    // 凭据被拒 → AUTH_FAILED，不静默回落
    mock.state.mode = "401";
    const denied = await fixture.modelService.listRemoteModels({ context, providerId: created.provider.providerId });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "AUTH_FAILED");
    mock.state.mode = "success";
  } finally {
    fixture.close();
  }
});

test("⑩b adapterType=lovart 分发与 mapProtocol 透传；未登记类型仍回落 OpenAI 兼容", () => {
  assert.equal(adapter.adapterFor("lovart").ADAPTER_TYPE, "lovart");
  assert.equal(adapter.lovartFor("lovart").ADAPTER_TYPE, "lovart");
  assert.equal(adapter.lovartFor("openai"), null);
  assert.equal(adapter.chatProtocolFor("lovart"), null, "lovart 不是单次请求协议，不得走 chatProtocolFor");
  assert.equal(mapProtocol("lovart"), "lovart");
  assert.equal(mapProtocol("openai-compatible"), "openai");
});

test("⑩c HTTPS only：远程 http 被传输守门拒绝；回环 http 放行", () => {
  assert.throws(() => lovart.buildRequest({ baseUrl: "http://lgw.lovart.ai", credential: { ok: true, accessKey: "ak", secretKey: "sk" }, method: "GET", path: "/v1/openapi/tools/catalog" }), /lovart-requires-https/);
  assert.ok(lovart.buildRequest({ baseUrl: "http://127.0.0.1:1234", credential: { ok: true, accessKey: "ak", secretKey: "sk" }, method: "GET", path: "/v1/openapi/tools/catalog" }).url.startsWith("http://127.0.0.1:1234"));
  assert.equal(lovart.DEFAULT_BASE_URL, "https://lgw.lovart.ai");
  assert.equal(lovart.ENDPOINTS.catalog, "/v1/openapi/tools/catalog");
});

/* ═══════════ 真实联网复验回填：离线夹具，全程不联网 ═══════════ */

const LIVE_DIR = new URL("../artifacts/lovart-live/", import.meta.url);
const readLive = (name) => JSON.parse(fs.readFileSync(new URL(name, LIVE_DIR), "utf8"));

/** 极简 fetch 替身：只实现适配器用到的 ok / status / text / headers.get / arrayBuffer。 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    // match 以 "/" 开头时按 pathname 精确匹配（签名只覆盖 path，URL 可能带 baseUrl）。
    const route = routes.find((r) => (r.match.startsWith("/") ? new URL(String(url)).pathname === r.match : String(url).startsWith(r.match)));
    if (!route) throw new Error("fake-fetch: no route for " + url);
    const status = route.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => (route.headers && route.headers[String(name).toLowerCase()]) || null },
      text: async () => (typeof route.body === "string" ? route.body : JSON.stringify(route.body == null ? null : route.body)),
      arrayBuffer: async () => (route.bytes ? Uint8Array.from(route.bytes).buffer : new ArrayBuffer(0)),
    };
  };
  impl.calls = calls;
  return impl;
}

test("⑪ 真站字段复验：chat/result 的 items[].artifacts[].content 被解析（真实落盘样例）", () => {
  const envelope = readLive("chat-result.json");
  assert.equal(envelope.code, 0, "信封 {code,message,data}：code 必须是 0");
  assert.equal(envelope.message, "success");
  const data = envelope.data;
  assert.equal(data.status, "done", "chat/result 的 status 取值");
  assert.equal(data.items[0].type, "assistant");
  assert.equal(typeof data.items[0].text, "string");
  assert.equal(data.items[1].type, "generator");
  assert.equal(data.items[1].name, "artifacts");

  const artifacts = lovart.extractArtifacts(data, "image");
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].url, data.items[1].artifacts[0].content, "必须读 content 字段，而不是 url");
  assert.equal(new URL(artifacts[0].url).hostname, "a.lovart.ai");
  assert.equal(artifacts[0].type, "image");
  assert.equal(lovart.isAllowedArtifactUrl(artifacts[0].url, "https://lgw.lovart.ai"), true);
  assert.match(lovart.extractAssistantText(data), /红苹果/);
});

test("⑫ 真站 catalog 样例：53 个工具（IMAGE 34 / VIDEO 19），能力映射正确", () => {
  const envelope = readLive("tools-catalog.json");
  assert.equal(envelope.code, 0);
  const tools = envelope.data.tools;
  assert.equal(tools.length, 53);
  const byCategory = tools.reduce((acc, tool) => { acc[tool.category] = (acc[tool.category] || 0) + 1; return acc; }, {});
  assert.deepEqual(byCategory, { IMAGE: 34, VIDEO: 19 }, "真站当前 catalog 只有 IMAGE/VIDEO（源码里的 3D 未出现）");
  const items = lovart.mapCatalog(envelope.data);
  assert.equal(items.length, 53);
  assert.equal(items.filter((i) => i.category === "IMAGE").length, 34);
  assert.equal(items.filter((i) => i.category === "VIDEO").length, 19);
  assert.ok(items.every((i) => i.suggestedCapabilities.length === 1));
  assert.deepEqual(items[0].suggestedCapabilities, ["image-generation"]);
  const seedance = items.find((i) => i.id === "generate_video_seedance_v2_5");
  assert.equal(seedance.displayName, "Seedance 2.5");
  assert.equal(seedance.premium, true);
  assert.deepEqual(seedance.suggestedCapabilities, ["video-generation"]);
});

test("⑬ 真站 mode/query 样例：unlimited:false + 7 项 unlimited_list", () => {
  const envelope = readLive("mode-query.json");
  assert.equal(envelope.code, 0);
  assert.equal(envelope.data.unlimited, false);
  assert.equal(envelope.data.unlimited_enable, true);
  assert.equal(envelope.data.unlimited_list.length, 7);
});

test("⑭ 真站错误信封：401 {code,error} 与 400 {status,error,context} 都被归一，且不回显密钥", async () => {
  const cred = lovart.serializeCredential({ accessKey: "ak_real_shape", secretKey: "sk_real_shape" });
  const unauthorized = await lovart.listModels({
    baseUrl: "https://lgw.lovart.ai", apiKey: cred,
    fetchImpl: fakeFetch([{ match: "https://lgw.lovart.ai/v1/openapi/tools/catalog", status: 401, body: { code: 1005, error: "Invalid access key" } }]),
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.error, "AUTH_FAILED");
  assert.equal(unauthorized.detail, "Invalid access key");
  assert.equal(JSON.stringify(unauthorized).includes("sk_real_shape"), false);

  const invalid = await lovart.listModels({
    baseUrl: "https://lgw.lovart.ai", apiKey: cred,
    fetchImpl: fakeFetch([{ match: "https://lgw.lovart.ai/v1/openapi/tools/catalog", status: 400, body: { status: "INVALID_ARGUMENT", error: "invalid argument: validation failed", context: { "header:X-Access-Key": ["missing value"] } } }]),
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, "PROVIDER_PROTOCOL_ERROR");
  assert.match(invalid.detail, /validation failed/);
});

test("⑮ 凭据探测走签名 POST /mode/query（catalog 是公开路由，不能验凭据）", async () => {
  const cred = lovart.serializeCredential({ accessKey: "ak_x", secretKey: "sk_y" });

  const okFetch = fakeFetch([{ match: "/v1/openapi/mode/query", status: 200, body: { code: 0, message: "success", data: { unlimited: false, unlimited_enable: true, unlimited_list: [] } } }]);
  const ok = await lovart.probeCredential({ baseUrl: "https://lgw.lovart.ai", apiKey: cred, fetchImpl: okFetch });
  assert.equal(ok.ok, true);
  assert.equal(ok.credentialAccepted, true);
  assert.equal(ok.probe, "mode/query");
  assert.equal(okFetch.calls[0].method, "POST");
  assert.ok(okFetch.calls[0].url.endsWith("/v1/openapi/mode/query"));

  const bad = await lovart.probeCredential({
    baseUrl: "https://lgw.lovart.ai", apiKey: cred,
    fetchImpl: fakeFetch([{ match: "/v1/openapi/mode/query", status: 401, body: { code: 1005, error: "Invalid access key" } }]),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "AUTH_FAILED");
  assert.equal(bad.credentialAccepted, false);
  assert.equal(bad.probe, "mode/query");

  const fallbackFetch = fakeFetch([
    { match: "/v1/openapi/mode/query", status: 404, body: { code: 40400, message: "not found", data: null } },
    { match: "/v1/openapi/tools/catalog", status: 200, body: { code: 0, message: "success", data: { tools: [{ name: "generate_image_x", display_name: "X", category: "IMAGE" }] } } },
  ]);
  const fallback = await lovart.probeCredential({ baseUrl: "https://lgw.lovart.ai", apiKey: cred, fetchImpl: fallbackFetch });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.probe, "catalog");
  assert.equal(fallback.modelCount, 1);
});

test("⑯ 产物下载：a.lovart.ai 放行并真下载；未观察主机不发出任何请求", async () => {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const okFetch = fakeFetch([{ match: "https://a.lovart.ai/", status: 200, bytes: png, headers: { "content-type": "image/png" } }]);
  const downloaded = await lovart.downloadArtifact({ url: "https://a.lovart.ai/artifacts/agent/x.png", providerBaseUrl: "https://lgw.lovart.ai", fetchImpl: okFetch });
  assert.equal(downloaded.ok, true, JSON.stringify(downloaded));
  assert.equal(downloaded.mime, "image/png");
  assert.equal(downloaded.data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(okFetch.calls.length, 1);

  const blockedFetch = fakeFetch([]);
  const blocked = await lovart.downloadArtifact({ url: "https://cdn.not-observed.example/x.png", providerBaseUrl: "https://lgw.lovart.ai", fetchImpl: blockedFetch });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "ARTIFACT_HOST_BLOCKED");
  assert.equal(blockedFetch.calls.length, 0, "被拒主机不得发出任何请求");
});

