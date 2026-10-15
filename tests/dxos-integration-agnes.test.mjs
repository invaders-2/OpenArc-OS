/**
 * B7e3 · Agnes 可选插件测试（全离线：本地 127.0.0.1 stub + 内存凭据后端；绝不访问外网）。
 *
 * 覆盖任务书验收点：
 *   ① 纯函数：端点归一 / 图片结果解析 / 尺寸与帧数 / 视频 URL 收集；
 *   ② 本地 stub：图片生成、图像编辑（data URL 参考图）、v2.0 像素体、2.5 轮询；
 *   ③ 未注入 fetch / 未配置 Key → 结构化 { ok:false, error:"INTEGRATION_UNAVAILABLE", detail }；
 *   ④ 凭据走 credential-store（内存后端），只回掩码、不落明文；
 *   ⑤ B2 legacy 执行器端口 generateAgnesImages / editAgnesImages / generateAgnesVideos 真的走新实现；
 *   ⑥ createPluginBundle 装配后 integration 命令可用（status / credentials / generate-images）；
 *   ⑦ 模型目录端口：未注入 / 未启用 / 缺凭据 → 准确 detail；启用 + 凭据 → 真实目录（openai 解析）。
 *
 * 只读源：server/agnes.ts:1-196 + server/agnesEndpoint.ts:1-14。
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPluginRegistry, optionalPlugins } = require("../electron/plugin-registry.cjs");
const { createPluginBundle } = require("../electron/plugin-service.cjs");
const { createAgnesIntegration, normalizeAgnesApiBaseUrl, endpoint, imageResults, agnesDimensions, agnesFrameCount, videoUrls } = require("../electron/plugin-agnes.cjs");
const { memoryCredentialBackend } = require("../electron/credential-store.cjs");
const { clearLegacyExecutorPorts } = require("../electron/legacy-executor-ports.cjs");
const images = require("../electron/protocol-engine/legacy-executor-images.cjs");
const media = require("../electron/protocol-engine/legacy-executor-media.cjs");
const chat = require("../electron/protocol-engine/legacy-executor-chat.cjs");

const tmpDirs = [];
const servers = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); clearLegacyExecutorPorts(); });
after(() => { for (const server of servers) { try { server.close(); } catch { /* 忽略 */ } } });

function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-agnes-")); tmpDirs.push(dir); return dir; }

function startStub(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      const url = new URL(req.url, "http://127.0.0.1");
      requests.push({ url, method: req.method, headers: req.headers, body, raw });
      const hit = await handler(url, { method: req.method, body, raw, headers: req.headers });
      if (!hit) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
      res.writeHead(hit.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(hit.body));
    });
    server.listen(0, "127.0.0.1", () => { servers.push(server); resolve({ server, base: "http://127.0.0.1:" + server.address().port, requests }); });
  });
}

// ── ① 纯函数 ──────────────────────────────────────────────────────────────
test("纯函数：端点归一 / 图片结果 / 尺寸帧数 / 视频 URL", () => {
  assert.equal(normalizeAgnesApiBaseUrl("https://platform.agnes-ai.com/x"), "https://apihub.agnes-ai.com");
  assert.equal(normalizeAgnesApiBaseUrl("https://agnes-ai.cn"), "https://api.agnes-ai.cn");
  assert.equal(normalizeAgnesApiBaseUrl("https://example.com/v1"), "https://example.com/v1");
  assert.equal(endpoint("https://platform.agnes-ai.com", "/v1/images/generations"), "https://apihub.agnes-ai.com/v1/images/generations");
  assert.equal(endpoint("https://apihub.agnes-ai.com/v1", "/v1/videos"), "https://apihub.agnes-ai.com/v1/videos");
  assert.equal(endpoint("https://apihub.agnes-ai.com/v1", "/agnesapi"), "https://apihub.agnes-ai.com/agnesapi");

  assert.deepEqual(imageResults({ data: [{ url: "https://x/a.png" }, { b64_json: "AA" }, "https://x/b.png"] }), [
    { type: "url", value: "https://x/a.png" }, { type: "b64", value: "AA" }, { type: "url", value: "https://x/b.png" },
  ]);
  assert.deepEqual(imageResults({ images: [{ image_url: "https://x/c.png" }] }), [{ type: "url", value: "https://x/c.png" }]);
  assert.deepEqual(agnesDimensions("16:9", "720p"), { width: 1152, height: 648 });
  assert.deepEqual(agnesDimensions("9:16", "480p"), { width: 408, height: 720 });
  assert.deepEqual(agnesFrameCount(5, 24), { num_frames: 121, frame_rate: 24 });
  assert.deepEqual(videoUrls({ output: { videos: ["https://x/v.mp4"] } }), ["https://x/v.mp4"]);
  assert.deepEqual(videoUrls({ output: "https://x/v.webm?a=1" }), ["https://x/v.webm?a=1"]);
});

// ── ② 本地 stub ───────────────────────────────────────────────────────────
test("本地 stub：图片生成 / 图像编辑 / v2.0 像素体 / 2.5 轮询（离线）", async () => {
  // 同一个 stub 区分请求体，覆盖图片 / 视频两条链路。
  const vs = await startStub((url, req) => {
    if (url.pathname === "/v1/images/generations") return { body: { data: [{ url: "https://cdn.example/a.png" }] } };
    if (url.pathname === "/v1/videos") {
      if (req.body.model === "agnes-video-v2.0") return { body: { data: [{ video_url: "https://cdn.example/v.mp4" }] } };
      return { body: { video_id: "vid-1", status: "RUNNING" } };
    }
    if (url.pathname === "/agnesapi") return { body: { data: { status: "SUCCESS", video_url: "https://cdn.example/poll.mp4" } } };
    return null;
  });
  const integration = createAgnesIntegration({});
  const provider = { base_url: vs.base, api_key: "agnes-secret" };

  const generated = await integration.generateAgnesImages(provider, "agnes-image-2.1-flash", { prompt: "猫", size: "512x512" }, 4000, { fetch });
  assert.equal(generated.images[0].value, "https://cdn.example/a.png");
  const body = vs.requests.find((entry) => entry.url.pathname === "/v1/images/generations").body;
  assert.equal(body.model, "agnes-image-2.1-flash");
  assert.equal(body.extra_body.response_format, "url");
  assert.equal(vs.requests.find((entry) => entry.url.pathname === "/v1/images/generations").headers.authorization, "Bearer agnes-secret");

  const edited = await integration.editAgnesImages(provider, "agnes-image-2.0-flash", { prompt: "改" }, [{ buf: Buffer.from("x"), mime: "image/png", name: "x.png" }], 4000, { fetch });
  assert.equal(edited.images.length, 1);
  const editBody = vs.requests.filter((entry) => entry.url.pathname === "/v1/images/generations").at(-1).body;
  assert.match(editBody.extra_body.image[0], /^data:image\/png;base64,/);

  const v20 = await integration.generateAgnesVideos(provider, "agnes-video-v2.0", { prompt: "风景", aspect_ratio: "16:9", resolution: "720p", duration: 5 }, 4000, { fetch });
  assert.equal(v20.videos[0].value, "https://cdn.example/v.mp4");
  const v20Body = vs.requests.find((entry) => entry.url.pathname === "/v1/videos").body;
  assert.equal(v20Body.width, 1152);
  assert.equal(v20Body.height, 648);
  assert.equal(v20Body.num_frames, 121);

  let slept = 0;
  const v25 = await integration.generateAgnesVideos(provider, "agnes-video-2.5", { prompt: "跳舞", duration: 6, aspect_ratio: "9:16", resolution: "1080p" }, 60000, { fetch }, { now: () => 0, sleep: async (ms) => { slept += ms; } });
  assert.equal(v25.videos[0].value, "https://cdn.example/poll.mp4");
  assert.equal(slept, 5000);
  const v25Body = vs.requests.filter((entry) => entry.url.pathname === "/v1/videos").at(-1).body;
  assert.equal(v25Body.mode, "text");
  assert.equal(v25Body.size, "1080P");
  assert.equal(v25Body.seconds, "6");

  // 2.5 Flash 参考视频必须结构化报错
  const flashRef = await integration.generateAgnesVideos(provider, "agnes-video-2.5-flash", { prompt: "x", videos: [{ publicUrl: "https://cdn.example/r.mp4" }] }, 4000, { fetch });
  assert.equal(flashRef.ok, false);
  assert.match(flashRef.detail, /不支持参考视频/);
});

// ── ③ 未配置 → 结构化不可用 ───────────────────────────────────────────────
test("未配置：未注入 fetch / 未配置 Key → INTEGRATION_UNAVAILABLE", async () => {
  const noFetch = createAgnesIntegration({ credentials: memoryCredentialBackend() });
  const blocked = await noFetch.generateAgnesImages({ base_url: "https://example.invalid" }, "m", { prompt: "x" }, 1000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "INTEGRATION_UNAVAILABLE");
  assert.match(blocked.detail, /fetch/);

  const withFetch = createAgnesIntegration({ fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }), credentials: memoryCredentialBackend() });
  const noKey = await withFetch.generateAgnesImages({ base_url: "https://example.invalid" }, "m", { prompt: "x" }, 1000);
  assert.equal(noKey.error, "INTEGRATION_UNAVAILABLE");
  assert.match(noKey.detail, /API Key/);

  const noInput = await withFetch.editAgnesImages({ base_url: "https://example.invalid", api_key: "k" }, "m", { prompt: "x" }, [], 1000);
  assert.equal(noInput.error, "INTEGRATION_INVALID_INPUT");
});

// ── ④ 凭据 ────────────────────────────────────────────────────────────────
test("凭据：saveCredential 走 credential-store，只回掩码；safeStorage 不可用即拒绝", () => {
  const credentials = memoryCredentialBackend();
  const integration = createAgnesIntegration({ credentials });
  const saved = integration.saveCredential({ apiKey: "AGNES-SECRET-123456" });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.value.apiKeySet, true);
  assert.equal(saved.value.apiKeyMask.includes("AGNES-SECRET-123456"), false);
  assert.match(saved.value.apiKeyMask, /••••/);
  assert.equal(credentials.get("agnes.apiKey"), "AGNES-SECRET-123456", "明文只进安全后端");
  assert.equal(integration.resolveApiKey({}), "AGNES-SECRET-123456");

  const deleted = integration.deleteCredential();
  assert.equal(deleted.value.apiKeySet, false);
  assert.equal(credentials.get("agnes.apiKey"), null);

  const noStore = createAgnesIntegration({ fetch });
  const refused = noStore.saveCredential({ apiKey: "x-1234" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "INTEGRATION_UNAVAILABLE");
  assert.match(refused.detail, /safeStorage/);
});

test("注册：optionalPlugins 含 agnes，默认关闭；凭据探测 missing → degraded", async () => {
  assert.ok(optionalPlugins().some((plugin) => plugin.id === "agnes"));
  const registry = createPluginRegistry({
    userDataDir: tempDir(),
    plugins: optionalPlugins(),
    capabilities: { fetch: async () => ({}), safeStorage: true },
    probes: { credential: (dep, pluginId) => pluginId === "agnes" ? createAgnesIntegration({ credentials: memoryCredentialBackend() }).credentialProbe() : { ok: null, status: "unknown", detail: "" } },
  });
  assert.equal(registry.get("agnes").enabled, false, "默认必须关闭");
  const probe = createAgnesIntegration({}).credentialProbe();
  assert.equal(probe.ok, null, "safeStorage 不可用时探测不了而非缺失");
  const enabled = await registry.enable("agnes");
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  const report = await registry.health("agnes");
  assert.equal(report.missingOptional.includes("agnes.credential"), true);
  assert.equal(report.dependencies.find((dep) => dep.id === "agnes.network").status, "unknown", "默认不联网探测");
});

// ── ⑤ legacy 端口 ─────────────────────────────────────────────────────────
test("端口：未注入 → LEGACY_DEPENDENCY_UNAVAILABLE；装配后启用 agnes → 真实实现（本地 stub）", async () => {
  clearLegacyExecutorPorts();
  const blocked = await images.generateImages({ base_url: "https://example.invalid", api_key: "k", protocol: "agnes" }, "m", { prompt: "x" }, 1000);
  assert.equal(blocked.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(blocked.detail, /agnes/);
  const blockedVideo = await media.generateVideos({ base_url: "https://example.invalid", api_key: "k", protocol: "agnes" }, "m", { prompt: "x" }, undefined, 1000);
  assert.equal(blockedVideo.error, "LEGACY_DEPENDENCY_UNAVAILABLE");

  const stub = await startStub((url) => {
    if (url.pathname === "/v1/images/generations") return { body: { data: [{ url: "https://cdn.example/bundle.png" }] } };
    return null;
  });
  const bundle = createPluginBundle({ userDataDir: tempDir(), fetch, credentials: memoryCredentialBackend() });
  assert.deepEqual(bundle.legacyPorts.applied.sort(), [
    "callRunningHubChat", "describeRunningHubImage",
    "editAgnesImages", "editModelScopeImages", "editRunningHubImages",
    "fetchAgnesModelCatalog", "fetchRunningHubModelCatalog",
    "generateAgnesImages", "generateAgnesVideos", "generateModelScopeImages", "generateRunningHubImages", "generateRunningHubVideos",
  ]);
  const before = await images.generateImages({ base_url: stub.base, api_key: "k", protocol: "agnes" }, "m", { prompt: "x" }, 4000);
  assert.equal(before.ok, false);
  assert.equal(before.error, "INTEGRATION_UNAVAILABLE");
  assert.match(before.detail, /默认关闭/);

  assert.equal((await bundle.registry.enable("agnes")).ok, true);
  const result = await images.generateImages({ base_url: stub.base, api_key: "k", protocol: "agnes" }, "agnes-image-2.1-flash", { prompt: "一只猫" }, 4000, { fetch });
  assert.equal(result.ok, undefined, "成功走源协议形状");
  assert.equal(result.images[0].value, "https://cdn.example/bundle.png");
  const submit = stub.requests.find((entry) => entry.method === "POST");
  assert.equal(submit.body.prompt, "一只猫");
});

test("模型目录：未注入 / 未启用 / 缺凭据 → 准确 detail；启用 + 凭据 → 真实目录（本地 stub）", async () => {
  clearLegacyExecutorPorts();
  // 未注入端口：执行器回 LEGACY_DEPENDENCY_UNAVAILABLE，detail 指明「端口未注入」，不得再写「未移植」
  const noPort = await chat.fetchModelCatalog({ base_url: "https://example.invalid", api_key: "k", protocol: "agnes" });
  assert.equal(noPort.ok, false);
  assert.equal(noPort.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(noPort.detail, /端口未注入/);
  assert.doesNotMatch(noPort.detail, /未移植/);

  const stub = await startStub((url) => {
    if (url.pathname === "/v1/models") {
      return { body: { object: "list", data: [{ id: "agnes-chat-2.1" }, { id: "agnes-image-2.1-flash", name: "Agnes Image" }] } };
    }
    return null;
  });
  const bundle = createPluginBundle({ userDataDir: tempDir(), fetch, credentials: memoryCredentialBackend() });

  // 端口已注入但插件默认关闭 → detail 说清「插件未启用」，且不发网络请求
  const disabled = await chat.fetchModelCatalog({ base_url: stub.base, api_key: "k", protocol: "agnes" });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error, "INTEGRATION_UNAVAILABLE");
  assert.match(disabled.detail, /默认关闭/);
  assert.equal(stub.requests.length, 0, "未启用时不得发起网络请求");

  // 启用但未配置凭据 → detail 说清「缺凭据」
  assert.equal((await bundle.registry.enable("agnes")).ok, true);
  const noKey = await chat.fetchModelCatalog({ base_url: stub.base, protocol: "agnes" });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.error, "INTEGRATION_UNAVAILABLE");
  assert.match(noKey.detail, /API Key/);

  // 启用 + 凭据就绪 → 经注入 transport 拉取，并按 openai kind 解析成真实目录
  const seen = [];
  chat.setProtocolTransport({ fetch: async (url, options) => { seen.push(String(url)); return fetch(url, options); } });
  try {
    const saved = await bundle.execute("integration/agnes/credentials/save", { apiKey: "AGNES-CATALOG-999999" }, { sessionRef: "s" });
    assert.equal(saved.ok, true);
    const catalog = await chat.fetchModelCatalog({ base_url: stub.base, protocol: "agnes" });
    assert.deepEqual(catalog, [
      { model: "agnes-chat-2.1" },
      { model: "agnes-image-2.1-flash", name: "Agnes Image" },
    ]);
    assert.deepEqual(seen, [stub.base + "/v1/models"], "目录必须经注入的 transport 拉取");
    const request = stub.requests.find((entry) => entry.url.pathname === "/v1/models");
    assert.equal(request.headers.authorization, "Bearer AGNES-CATALOG-999999", "目录请求使用安全存储里的 Key");
  } finally {
    chat.setProtocolTransport(null);
  }
});

// ── ⑥ integration 命令 ────────────────────────────────────────────────────
test("命令：createPluginBundle 启用 agnes 后 status / credentials / generate-images 可用", async () => {
  const stub = await startStub((url) => {
    if (url.pathname === "/v1/images/generations") return { body: { data: [{ url: "https://cdn.example/cmd.png" }] } };
    return null;
  });
  const bundle = createPluginBundle({ userDataDir: tempDir(), fetch, credentials: memoryCredentialBackend() });
  const disabled = await bundle.execute("integration/agnes/generate-images", { provider: { base_url: stub.base, api_key: "k" }, model: "m", params: { prompt: "x" } }, { sessionRef: "s" });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error, "INTEGRATION_UNAVAILABLE");

  assert.equal((await bundle.execute("integration/plugins/enable", { id: "agnes" }, { sessionRef: "s" })).ok, true);
  const status = await bundle.execute("integration/agnes/status", {}, { sessionRef: "s" });
  assert.equal(status.ok, true);
  assert.deepEqual(status.value.videoModels, ["agnes-video-2.5", "agnes-video-2.5-flash", "agnes-video-v2.0"]);

  const saved = await bundle.execute("integration/agnes/credentials/save", { apiKey: "AGNES-CMD-999999" }, { sessionRef: "s" });
  assert.equal(saved.ok, true);
  assert.match(saved.value.apiKeyMask, /••••/);

  const generated = await bundle.execute("integration/agnes/generate-images", { provider: { base_url: stub.base }, model: "agnes-image-2.1-flash", params: { prompt: "猫" } }, { sessionRef: "s" });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  assert.equal(generated.value.images[0].value, "https://cdn.example/cmd.png");
  assert.equal(stub.requests[0].headers.authorization, "Bearer AGNES-CMD-999999", "命令路径使用安全存储里的 Key");
});
