/**
 * B7e2 · RunningHub 可选插件测试（全离线：本地 127.0.0.1 stub + 内存凭据后端；绝不访问外网）。
 *
 * 覆盖任务书验收点：
 *   ① 插件默认关闭 + 开关持久化 + 依赖缺失文案（registry 级）；
 *   ② 请求构造（schema → aspectRatio / width / height）与响应解析（runningHubOutputUrls / modelTaskState）；
 *   ③ 未注入 fetch 或未配置 API Key → 结构化 { ok:false, error:"INTEGRATION_UNAVAILABLE", detail }；
 *   ④ 凭据走 credential-store（内存后端），只回掩码、不落明文；
 *   ⑤ B2 legacy 执行器端口：未注入 → LEGACY_DEPENDENCY_UNAVAILABLE；注入假端口 → 真的走到注入实现；
 *   ⑥ createPluginBundle 装配后启用 runninghub，legacy 图片执行器真的走新实现（不是仍返回依赖缺失）；
 *   ⑦ B7e3 后续：RunningHub 对话 / 图片理解 legacy 端口（callRunningHubChat / describeRunningHubImage）。
 *
 * 只读源：server/runninghub.ts:1-700；electron/plugin-runninghub.cjs；electron/legacy-executor-ports.cjs。
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
const { createPluginBundle, INTEGRATION_COMMANDS } = require("../electron/plugin-service.cjs");
const { createRunningHubIntegration, runningHubOutputUrls, modelTaskState, endpointForModel, fieldsFromWorkflow } = require("../electron/plugin-runninghub.cjs");
const { memoryCredentialBackend } = require("../electron/credential-store.cjs");
const { setLegacyExecutorPorts, clearLegacyExecutorPorts, listLegacyExecutorPorts } = require("../electron/legacy-executor-ports.cjs");
const images = require("../electron/protocol-engine/legacy-executor-images.cjs");
const media = require("../electron/protocol-engine/legacy-executor-media.cjs");
const chat = require("../electron/protocol-engine/legacy-executor-chat.cjs");

const tmpDirs = [];
const servers = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); clearLegacyExecutorPorts(); });
after(() => { for (const server of servers) { try { server.close(); } catch { /* 忽略 */ } } });

function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-runninghub-")); tmpDirs.push(dir); return dir; }

// 本地 stub：只监听 127.0.0.1 随机端口；记录每次请求（URL / method / headers / JSON body）。
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

// ── ① 注册 / 默认关闭 / 持久化 / 依赖缺失文案 ─────────────────────────────
test("注册：optionalPlugins 含 runninghub/modelscope/agnes，默认全关且启用后跨实例保持", async () => {
  // B7e3 起 Agnes 也并入 optionalPlugins（新增可选插件），三者的登记契约在此钉住。
  assert.deepEqual(optionalPlugins().map((plugin) => plugin.id).sort(), ["agnes", "modelscope", "runninghub"]);
  const dir = tempDir();
  const registry = createPluginRegistry({ userDataDir: dir, plugins: optionalPlugins(), capabilities: { fetch: async () => ({}), safeStorage: true } });
  const runninghub = registry.get("runninghub");
  assert.equal(runninghub.enabled, false, "默认必须关闭");
  assert.deepEqual(runninghub.capabilities, ["fetch", "safeStorage"]);
  const enabled = await registry.enable("runninghub");
  assert.equal(enabled.ok, true, JSON.stringify(enabled));

  const second = createPluginRegistry({ userDataDir: dir, plugins: optionalPlugins(), capabilities: { fetch: async () => ({}), safeStorage: true } });
  assert.equal(second.isEnabled("runninghub"), true, "重启（新实例）后开关必须保持");
  assert.equal(second.isEnabled("modelscope"), false);
});

test("依赖缺失文案：credential 探测 missing → health.degraded 且 detail 带安装提示（required=false 仍可启用）", async () => {
  const dir = tempDir();
  const registry = createPluginRegistry({
    userDataDir: dir,
    plugins: optionalPlugins(),
    capabilities: { fetch: async () => ({}), safeStorage: true },
    probes: { credential: () => ({ ok: false, status: "missing", detail: "未配置 RunningHub API Key" }) },
  });
  const enabled = await registry.enable("runninghub");
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  assert.equal(enabled.value.status, "degraded");
  const report = await registry.health("runninghub");
  assert.equal(report.status, "degraded");
  assert.ok(report.missingOptional.includes("runninghub.credential"));
  assert.match(report.detail, /安全存储/);
  const networkDep = report.dependencies.find((dep) => dep.id === "runninghub.network");
  assert.equal(networkDep.status, "unknown", "默认不联网探测");
});

// ── ② 纯函数：响应解析 / 端点别名 / 工作流字段 ─────────────────────────────
test("响应解析：runningHubOutputUrls / modelTaskState / endpointForModel / fieldsFromWorkflow", () => {
  const raw = { code: 0, data: { taskId: "rh-1", results: [{ url: "https://cdn.example/a.png" }, { url: "https://cdn.example/b.webp" }] } };
  assert.deepEqual(runningHubOutputUrls(raw), ["https://cdn.example/a.png", "https://cdn.example/b.webp"]);
  assert.deepEqual(runningHubOutputUrls({ data: { images: ["data:image/png;base64,AAAA"] } }), ["data:image/png;base64,AAAA"]);
  assert.deepEqual(runningHubOutputUrls({ data: { url: "https://cdn.example/v.mp4" } }, "video"), ["https://cdn.example/v.mp4"]);
  assert.deepEqual(runningHubOutputUrls({ data: { url: "data:image/png;base64,AAAA" } }, "video"), [], "video 不收集 data:image");
  assert.deepEqual(runningHubOutputUrls({ data: { results: [{ url: "https://cdn.example/x.mp4" }] } }, "image"), ["https://cdn.example/x.mp4"], "带 URL 键的媒体地址按源实现收集，不按扩展名排除");

  const success = modelTaskState({ code: 0, data: { taskId: "t", results: [{ url: "https://x/y.png" }] } }, "image");
  assert.equal(success.status, "SUCCESS");
  assert.equal(success.taskId, "t");
  const running = modelTaskState({ code: 804, data: { taskId: "t2" } }, "image");
  assert.equal(running.status, "RUNNING");
  const failed = modelTaskState({ code: 805, msg: "bad" }, "image");
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.failReason, "bad");

  assert.equal(endpointForModel("gpt-image-2.0/edit-channel-low-price"), "rhart-image-g-2/image-to-image");
  assert.equal(endpointForModel("demo/text-to-image"), "demo/text-to-image");

  const fields = fieldsFromWorkflow({ "3": { class_type: "KSampler", _meta: { title: "采样" }, inputs: { seed: 12, prompt: "hi" } } });
  assert.equal(fields.length, 2);
  assert.equal(fields.find((field) => field.fieldName === "seed").fieldType, "INT");
  assert.equal(fields.find((field) => field.fieldName === "prompt").group, "采样");
});

// ── ③ 请求构造 + 响应解析（本地 stub，真实 HTTP，离线） ────────────────────
test("本地 stub：schema 驱动请求构造 + 提交 + 响应解析（离线）", async () => {
  const stub = await startStub((url) => {
    if (url.pathname === "/openapi/v2/demo/text-to-image") {
      return { body: { code: 0, data: { taskId: "rh-1", results: [{ url: "https://cdn.example/out.png" }] } } };
    }
    return null;
  });
  const integration = createRunningHubIntegration({
    fetch,
    endpoints: { registry: stub.base + "/registry.json", llm: stub.base + "/v1" },
    modelDefinitions: {
      "demo-aspect": { endpoint: "demo/text-to-image", params: [{ fieldKey: "aspectRatio", type: "STRING", options: ["1:1", "16:9"], defaultValue: "1:1", label: "aspectRatio" }] },
      "demo-size": { endpoint: "demo/text-to-image", params: [] },
    },
    clock: () => 1_700_000_000_000,
  });
  const provider = { base_url: stub.base, api_key: "sk-test" };

  const res = await integration.generateRunningHubImages(provider, "demo-aspect", { prompt: "一只猫", size: "1920x1080" }, 5000, { fetch });
  assert.equal(res.images.length, 1, JSON.stringify(res));
  assert.equal(res.images[0].value, "https://cdn.example/out.png");
  const submit = stub.requests.find((entry) => entry.method === "POST");
  assert.equal(submit.url.pathname, "/openapi/v2/demo/text-to-image");
  assert.equal(submit.body.prompt, "一只猫");
  assert.equal(submit.body.aspectRatio, "16:9", "schema 命中 aspectRatio 字段");
  assert.equal(submit.headers.authorization, "Bearer sk-test");

  // 无 schema 时退化为 width/height 数字对
  const res2 = await integration.generateRunningHubImages(provider, "demo-size", { prompt: "风景", size: "1024x768" }, 5000, { fetch });
  assert.equal(res2.images.length, 1);
  const submit2 = stub.requests.filter((entry) => entry.method === "POST").at(-1);
  assert.equal(submit2.body.width, 1024);
  assert.equal(submit2.body.height, 768);
});

// ── ④ 未配置 → 结构化不可用 ───────────────────────────────────────────────
test("未配置：未注入 fetch / 未配置 API Key → INTEGRATION_UNAVAILABLE", async () => {
  const noFetch = createRunningHubIntegration({ credentials: memoryCredentialBackend() });
  const blocked = await noFetch.generateRunningHubImages({ base_url: "https://example.invalid" }, "m", { prompt: "x" }, 1000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "INTEGRATION_UNAVAILABLE");
  assert.match(blocked.detail, /fetch/);

  const withFetch = createRunningHubIntegration({ fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }), credentials: memoryCredentialBackend() });
  const noKey = await withFetch.generateRunningHubImages({ base_url: "https://example.invalid" }, "m", { prompt: "x" }, 1000);
  assert.equal(noKey.error, "INTEGRATION_UNAVAILABLE");
  assert.match(noKey.detail, /API Key/);
});

// ── ⑤ 凭据：credential-store、掩码、不落明文 ──────────────────────────────
test("凭据：saveCredential 走 credential-store，只回掩码；safeStorage 不可用即拒绝", () => {
  const credentials = memoryCredentialBackend();
  const integration = createRunningHubIntegration({ fetch, credentials });
  const saved = integration.saveCredential({ apiKey: "RH-SECRET-123456", walletApiKey: "WALLET-987654" });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.value.apiKeySet, true);
  assert.equal(saved.value.apiKeyMask.includes("RH-SECRET-123456"), false);
  assert.match(saved.value.apiKeyMask, /••••/);
  assert.equal(credentials.get("runninghub.apiKey"), "RH-SECRET-123456", "明文只进安全后端");
  assert.equal(integration.resolveKey({}, false), "RH-SECRET-123456");

  const deleted = integration.deleteCredential();
  assert.equal(deleted.value.apiKeySet, false);
  assert.equal(credentials.get("runninghub.apiKey"), null);

  const noStore = createRunningHubIntegration({ fetch });
  const refused = noStore.saveCredential({ apiKey: "x-1234" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "INTEGRATION_UNAVAILABLE");
  assert.match(refused.detail, /safeStorage/);
});

// ── ⑥ legacy 端口：未注入结构化拒绝 / 注入后真的调用 ─────────────────────
test("端口：未注入 → LEGACY_DEPENDENCY_UNAVAILABLE；注入假端口 → legacy 图片执行器真的调用注入实现", async () => {
  clearLegacyExecutorPorts();
  assert.deepEqual(listLegacyExecutorPorts(), []);
  const provider = { base_url: "https://example.invalid", api_key: "k", protocol: "runninghub" };
  const blocked = await images.generateImages(provider, "m", { prompt: "x" }, 1000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(blocked.detail, /runninghub/);

  const seen = [];
  const applied = setLegacyExecutorPorts({
    generateRunningHubImages: async (...args) => { seen.push(args); return { images: [{ type: "url", value: "https://cdn.example/from-port.png" }], raw: { via: "port" } }; },
  });
  assert.deepEqual(applied.rejected, []);
  const result = await images.generateImages(provider, "m", { prompt: "x" }, 1000);
  assert.equal(result.images[0].value, "https://cdn.example/from-port.png");
  assert.equal(result.raw.via, "port");
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0].protocol, "runninghub", "端口收到真实 provider");
  assert.equal(seen[0][1], "m");
});

test("端口：视频与图像编辑分支同样按名注入（未注入保持 B2 行为）", async () => {
  clearLegacyExecutorPorts();
  const provider = { base_url: "https://example.invalid", api_key: "k", protocol: "runninghub" };
  const videosBlocked = await media.generateVideos(provider, "m", { prompt: "x" }, undefined, 1000);
  assert.equal(videosBlocked.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(videosBlocked.detail, /runninghub/);
  const editProvider = { ...provider, protocol: "modelscope" };
  const editBlocked = await media.editImages(editProvider, "m", { prompt: "x" }, [{ buf: Buffer.from("x"), mime: "image/png", name: "x.png" }], 1000);
  assert.equal(editBlocked.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(editBlocked.detail, /modelscope/);

  setLegacyExecutorPorts({
    generateRunningHubVideos: async () => ({ videos: [{ type: "url", value: "https://cdn.example/v.mp4" }], raw: {} }),
    editRunningHubImages: async () => ({ images: [{ type: "url", value: "https://cdn.example/edit.png" }], raw: {} }),
  });
  const videos = await media.generateVideos(provider, "m", { prompt: "x" }, undefined, 1000);
  assert.equal(videos.videos[0].value, "https://cdn.example/v.mp4");
  const edit = await media.editImages(provider, "m", { prompt: "x" }, [{ buf: Buffer.from("x"), mime: "image/png", name: "x.png" }], 1000);
  assert.equal(edit.images[0].value, "https://cdn.example/edit.png");
});

// ── ⑥b B7e3 后续：对话 / 图片理解 legacy 端口（callRunningHubChat / describeRunningHubImage） ──
test("端口：对话 / 图片理解未注入 → 结构化拒绝；注入假端口 → 执行器真的调用且形状回到源协议约定", async () => {
  clearLegacyExecutorPorts();
  const provider = { base_url: "https://example.invalid", api_key: "k", protocol: "runninghub" };
  const blockedChat = await chat.callChat(provider, "m", { prompt: "x" });
  assert.equal(blockedChat.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(blockedChat.detail, /runninghub/);
  const blockedStream = await chat.streamChat(provider, "m", { prompt: "x" }, {}, () => {});
  assert.equal(blockedStream.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  const blockedDescribe = await chat.describeImage(provider, "m", "data:image/png;base64,AA", "描述");
  assert.equal(blockedDescribe.error, "LEGACY_DEPENDENCY_UNAVAILABLE");

  const seen = [];
  const applied = setLegacyExecutorPorts({
    callRunningHubChat: async (...args) => { seen.push(["chat", ...args]); return { text: "port-chat", latencyMs: 7, raw: { via: "port" } }; },
    describeRunningHubImage: async (...args) => { seen.push(["describe", ...args]); return "port-desc"; },
  });
  assert.deepEqual(applied.rejected, []);
  const called = await chat.callChat(provider, "m", { prompt: "hi" }, { temperature: 0.2 }, 1000);
  assert.equal(called.text, "port-chat");
  assert.equal(called.latencyMs, 7);
  assert.equal(called.raw.via, "port");
  assert.equal(seen[0][0], "chat");
  assert.equal(seen[0][1].protocol, "runninghub", "端口收到真实 provider");
  assert.equal(seen[0][2], "m");

  const deltas = [];
  const streamed = await chat.streamChat(provider, "m", { prompt: "hi" }, {}, (t) => deltas.push(t), 1000);
  assert.deepEqual(deltas, ["port-chat"]);
  assert.equal(streamed.usage, undefined);
  assert.equal(seen[1][0], "chat", "streamChat 复用 callRunningHubChat 端口");
  assert.equal(await chat.describeImage(provider, "m", "data:image/png;base64,AA", "描述", 1000), "port-desc");
  assert.equal(seen[2][0], "describe");
  assert.equal(seen[2][1].protocol, "runninghub");
});

test("装配：启用 runninghub 后 legacy 对话 / 图片理解走插件实现（本地 stub）", async () => {
  clearLegacyExecutorPorts();
  const stub = await startStub((url) => {
    if (url.pathname === "/chat/completions") return { body: { choices: [{ message: { content: "来自插件" } }], usage: { total_tokens: 2 } } };
    return null;
  });
  const bundle = createPluginBundle({
    userDataDir: tempDir(),
    fetch,
    credentials: memoryCredentialBackend(),
    runninghubEndpoints: { baseUrl: stub.base, llm: stub.base, registry: stub.base + "/registry.json" },
  });
  assert.ok(bundle.legacyPorts.applied.includes("callRunningHubChat"), "装配必须注入对话端口");
  assert.ok(bundle.legacyPorts.applied.includes("describeRunningHubImage"), "装配必须注入图片理解端口");
  const provider = { base_url: stub.base, api_key: "sk-chat", protocol: "runninghub" };

  // 端口已注册但插件未启用：结构化拒绝，执行器如实透传，不是假成功。
  const disabled = await chat.callChat(provider, "m", { prompt: "x" });
  assert.equal(disabled.error, "INTEGRATION_UNAVAILABLE");
  assert.match(disabled.detail, /默认关闭/);

  assert.equal((await bundle.registry.enable("runninghub")).ok, true);
  const called = await chat.callChat(provider, "m", { prompt: "你好" });
  assert.equal(called.text, "来自插件");
  assert.equal(called.usage.total_tokens, 2);
  const body = stub.requests.at(-1).body;
  assert.equal(body.model, "m");
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: "user", content: "你好" }]);

  const described = await chat.describeImage(provider, "qwen/qwen3-vl", "data:image/png;base64,AA", "描述这张图");
  assert.equal(described, "来自插件");
  const descBody = stub.requests.at(-1).body;
  assert.equal(descBody.messages[0].content[0].text, "描述这张图");
  assert.equal(descBody.messages[0].content[1].image_url.url, "data:image/png;base64,AA");
});

// ── ⑦ 装配后启用 → legacy 执行器真的走 RunningHub 新实现 ───────────────────
test("装配：createPluginBundle 注册端口；启用 runninghub 后 legacy 图片执行器走新实现（本地 stub）", async () => {
  clearLegacyExecutorPorts();
  const stub = await startStub((url) => {
    if (url.pathname === "/openapi/v2/demo/text-to-image") {
      return { body: { code: 0, data: { taskId: "rh-2", results: [{ url: "https://cdn.example/bundle.png" }] } } };
    }
    return null;
  });
  const dir = tempDir();
  const bundle = createPluginBundle({
    userDataDir: dir,
    fetch,
    credentials: memoryCredentialBackend(),
    runninghubEndpoints: { registry: stub.base + "/registry.json", llm: stub.base + "/v1" },
    runningHubModelDefinitions: { demo: { endpoint: "demo/text-to-image", params: [] } },
  });
  assert.equal(bundle.registry.get("runninghub").enabled, false, "默认关闭");
  assert.deepEqual(bundle.legacyPorts.applied.sort(), ["callRunningHubChat", "describeRunningHubImage", "editAgnesImages", "editModelScopeImages", "editRunningHubImages", "generateAgnesImages", "generateAgnesVideos", "generateModelScopeImages", "generateRunningHubImages", "generateRunningHubVideos"]);

  // 未启用：端口存在但结构化拒绝（默认关语义在端口层也成立）
  const before = await images.generateImages({ base_url: stub.base, api_key: "sk", protocol: "runninghub" }, "demo", { prompt: "x" }, 5000);
  assert.equal(before.ok, false);
  assert.equal(before.error, "INTEGRATION_UNAVAILABLE");
  assert.match(before.detail, /默认关闭/);

  const enabled = await bundle.registry.enable("runninghub");
  assert.equal(enabled.ok, true, JSON.stringify(enabled));

  const result = await images.generateImages({ base_url: stub.base, api_key: "sk", protocol: "runninghub" }, "demo", { prompt: "一只猫" }, 5000, { fetch });
  assert.equal(result.ok, undefined, "成功走源协议形状，不是 ok:false");
  assert.equal(result.images[0].value, "https://cdn.example/bundle.png");
  const submit = stub.requests.find((entry) => entry.method === "POST");
  assert.equal(submit.body.prompt, "一只猫");
});

// ── ⑧ B7e3：LLM / 视觉问答（源 callRunningHubChat / describeRunningHubImage） ──
test("LLM / 视觉：callRunningHubChat 与 describeRunningHubImage（本地 stub）", async () => {
  const stub = await startStub((url) => {
    if (url.pathname === "/chat/completions") return { body: { choices: [{ message: { content: "你好" } }], usage: { total_tokens: 3 } } };
    return null;
  });
  const integration = createRunningHubIntegration({ fetch, endpoints: { registry: stub.base + "/registry.json", llm: stub.base } });
  const provider = { base_url: stub.base, api_key: "sk-llm" };

  const chat = await integration.callRunningHubChat(provider, "qwen/qwen-plus", { prompt: "你好" }, { temperature: 0.2 }, 5000, { fetch });
  assert.equal(chat.ok, true, JSON.stringify(chat));
  assert.equal(chat.value.text, "你好");
  assert.equal(chat.value.usage.total_tokens, 3);
  const chatBody = stub.requests.at(-1).body;
  assert.equal(chatBody.model, "qwen/qwen-plus");
  assert.equal(chatBody.stream, false);
  assert.equal(chatBody.temperature, 0.2);
  assert.deepEqual(chatBody.messages, [{ role: "user", content: "你好" }]);

  const described = await integration.describeRunningHubImage(provider, "qwen/qwen3-vl", ["data:image/png;base64,AA"], "这是什么", 5000, { fetch });
  assert.equal(described.ok, true);
  assert.equal(described.value.text, "你好");
  const descBody = stub.requests.at(-1).body;
  assert.equal(descBody.messages[0].content[0].text, "这是什么");
  assert.equal(descBody.messages[0].content[1].image_url.url, "data:image/png;base64,AA");

  const noFetch = createRunningHubIntegration({ credentials: memoryCredentialBackend() });
  const blocked = await noFetch.callRunningHubChat(provider, "m", { prompt: "x" }, {}, 1000);
  assert.equal(blocked.error, "INTEGRATION_UNAVAILABLE");
  assert.match(blocked.detail, /fetch/);
});

// ── ⑨ B7e3：AI 应用 / 工作流入口命令（白名单 ↔ 实现一一对应） ─────────────
test("命令：chat / describe-image / inspect / submit / task-query / upload 全部登记且可用", async () => {
  const commands = [
    "integration/runninghub/chat",
    "integration/runninghub/describe-image",
    "integration/runninghub/inspect",
    "integration/runninghub/submit",
    "integration/runninghub/task/query",
    "integration/runninghub/upload",
  ];
  for (const command of commands) assert.ok(INTEGRATION_COMMANDS.includes(command), "白名单缺少 " + command);

  const stub = await startStub((url) => {
    if (url.pathname === "/chat/completions") return { body: { choices: [{ message: { content: "hi" } }] } };
    if (url.pathname === "/api/webapp/apiCallDemo") return { body: { code: 0, data: { webappId: "app-1", fields: [] } } };
    if (url.pathname === "/api/openapi/getJsonApiFormat") return { body: { code: 0, data: { prompt: { "3": { class_type: "KSampler", inputs: { seed: 1 } } } } } };
    if (url.pathname === "/task/openapi/ai-app/run") return { body: { code: 0, data: { taskId: "task-9" } } };
    if (url.pathname === "/task/openapi/outputs") return { body: { code: 0, data: { url: "https://cdn.example/out.png" } } };
    if (url.pathname === "/task/openapi/upload") return { body: { code: 0, data: { fileName: "asset.png" } } };
    return null;
  });
  const bundle = createPluginBundle({
    userDataDir: tempDir(),
    fetch,
    credentials: memoryCredentialBackend(),
    runninghubEndpoints: { baseUrl: stub.base, llm: stub.base, registry: stub.base + "/registry.json" },
  });
  const provider = { base_url: stub.base, api_key: "sk-cmd" };

  const disabled = await bundle.execute("integration/runninghub/chat", { provider, model: "m", input: { prompt: "x" } }, { sessionRef: "s" });
  assert.equal(disabled.error, "INTEGRATION_UNAVAILABLE");
  assert.equal((await bundle.execute("integration/plugins/enable", { id: "runninghub" }, { sessionRef: "s" })).ok, true);

  const chat = await bundle.execute("integration/runninghub/chat", { provider, model: "m", input: { prompt: "你好" }, params: { temperature: 0 } }, { sessionRef: "s" });
  assert.equal(chat.ok, true, JSON.stringify(chat));
  assert.equal(chat.value.text, "hi");

  const described = await bundle.execute("integration/runninghub/describe-image", { provider, model: "m", image: "data:image/png;base64,AA", prompt: "描述" }, { sessionRef: "s" });
  assert.equal(described.ok, true);
  assert.equal(described.value.text, "hi");

  const app = await bundle.execute("integration/runninghub/inspect", { provider, kind: "app", id: "app-1" }, { sessionRef: "s" });
  assert.equal(app.ok, true);
  assert.equal(app.value.webappId, "app-1");

  const workflow = await bundle.execute("integration/runninghub/inspect", { provider, kind: "workflow", id: "wf-1" }, { sessionRef: "s" });
  assert.equal(workflow.ok, true);
  assert.equal(workflow.value.fields.length, 1);

  const submitted = await bundle.execute("integration/runninghub/submit", { provider, kind: "app", id: "app-1", fields: [{ nodeId: "3", fieldName: "seed", fieldValue: "1", enabled: true }] }, { sessionRef: "s" });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(submitted.value.taskId, "task-9");

  const queried = await bundle.execute("integration/runninghub/task/query", { provider, id: "task-9" }, { sessionRef: "s" });
  assert.equal(queried.ok, true);
  assert.equal(queried.value.status, "SUCCESS");
  assert.deepEqual(queried.value.urls, ["https://cdn.example/out.png"]);

  const uploaded = await bundle.execute("integration/runninghub/upload", { provider, fileName: "a.png", mime: "image/png", bufferBase64: Buffer.from("x").toString("base64") }, { sessionRef: "s" });
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.value.fileName, "asset.png");

  const missingBuffer = await bundle.execute("integration/runninghub/upload", { provider }, { sessionRef: "s" });
  assert.equal(missingBuffer.error, "INTEGRATION_INVALID_INPUT");
});

