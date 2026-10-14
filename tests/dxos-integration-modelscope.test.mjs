/**
 * B7e2 · ModelScope 可选插件测试（全离线：本地 127.0.0.1 stub + 内存凭据后端；绝不访问外网）。
 *
 * 覆盖任务书验收点：
 *   ① 插件默认关闭 + 开关持久化 + 依赖缺失文案；
 *   ② 请求构造（images/generations body / Authorization）与响应解析（同步返回 + tasks 轮询）；
 *   ③ 未注入 fetch / 未配置令牌 → 结构化 { ok:false, error:"INTEGRATION_UNAVAILABLE", detail }；
 *   ④ 凭据走 credential-store（内存后端），只回掩码；
 *   ⑤ B2 legacy 执行器端口：未注入 → LEGACY_DEPENDENCY_UNAVAILABLE；注入后真的走到实现；
 *   ⑥ createPluginBundle 装配后启用 modelscope，legacy 图像编辑真的走新实现。
 *
 * 只读源：server/modelscope.ts:1-153；electron/plugin-modelscope.cjs；electron/legacy-executor-ports.cjs。
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createModelScopeIntegration, collectImages, normalizeModelScopeLoras, loraPayload } = require("../electron/plugin-modelscope.cjs");
const { createPluginBundle } = require("../electron/plugin-service.cjs");
const { memoryCredentialBackend } = require("../electron/credential-store.cjs");
const { setLegacyExecutorPorts, clearLegacyExecutorPorts } = require("../electron/legacy-executor-ports.cjs");
const images = require("../electron/protocol-engine/legacy-executor-images.cjs");
const media = require("../electron/protocol-engine/legacy-executor-media.cjs");

const tmpDirs = [];
const servers = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); clearLegacyExecutorPorts(); });
after(() => { for (const server of servers) { try { server.close(); } catch { /* 忽略 */ } } });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-modelscope-")); tmpDirs.push(dir); return dir; }

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
      requests.push({ url, method: req.method, headers: req.headers, body });
      const hit = await handler(url, { method: req.method, body, headers: req.headers });
      if (!hit) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
      res.writeHead(hit.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(hit.body));
    });
    server.listen(0, "127.0.0.1", () => { servers.push(server); resolve({ server, base: "http://127.0.0.1:" + server.address().port, requests }); });
  });
}

// ── ① 纯函数 ──────────────────────────────────────────────────────────────
test("纯函数：collectImages / normalizeModelScopeLoras / loraPayload", () => {
  assert.deepEqual(collectImages({ output_images: ["https://x/a.png"] }), [{ type: "url", value: "https://x/a.png" }]);
  assert.deepEqual(collectImages({ images: ["data:image/png;base64,QUJD"] }), [{ type: "b64", value: "QUJD" }]);
  assert.deepEqual(collectImages({ data: [{ b64_json: "QUJD" }, { url: "https://x/b.png" }] }), [{ type: "url", value: "QUJD" }, { type: "url", value: "https://x/b.png" }]);

  const loras = normalizeModelScopeLoras([
    { id: "a/film", target_model: "M", strength: 5, name: "  Film  " },
    { id: "a/film", target_model: "M" },
    { id: "", target_model: "M" },
  ]);
  assert.equal(loras.length, 1);
  assert.equal(loras[0].strength, 2, "strength 夹到 [0,2]");
  assert.equal(loras[0].name, "Film");

  assert.deepEqual(loraPayload({ loras: { a: 0.5, "": 1, b: 9 } }), { a: 0.5, b: 2 });
  assert.deepEqual(loraPayload({ modelscope_lora: "a/film", modelscope_lora_strength: 0.8 }), { "a/film": 0.8 });
  assert.equal(loraPayload({}), undefined);
});

// ── ② 请求构造 + 轮询响应解析（本地 stub，真实 HTTP，离线） ────────────────
test("本地 stub：提交构造 + tasks 轮询解析（离线）", async () => {
  const stub = await startStub((url) => {
    if (url.pathname === "/images/generations") return { body: { task_id: "ms-1" } };
    if (url.pathname === "/tasks/ms-1") return { body: { task_status: "SUCCEED", output_images: ["https://cdn.example/ms.png"] } };
    return null;
  });
  const integration = createModelScopeIntegration({ fetch, credentials: memoryCredentialBackend(), pollIntervalMs: 5 });
  const provider = { base_url: stub.base, api_key: "ms-token" };
  const res = await integration.generateModelScopeImages(provider, "Qwen/Qwen-Image-2512", { prompt: "一只猫", size: "1024x1024", n: 2 }, 5000, { fetch });
  assert.equal(res.images.length, 1, JSON.stringify(res));
  assert.equal(res.images[0].value, "https://cdn.example/ms.png");
  const submit = stub.requests.find((entry) => entry.method === "POST");
  assert.equal(submit.url.pathname, "/images/generations");
  assert.equal(submit.body.model, "Qwen/Qwen-Image-2512");
  assert.equal(submit.body.prompt, "一只猫");
  assert.equal(submit.body.size, "1024x1024");
  assert.equal(submit.body.n, 2);
  assert.equal(submit.headers.authorization, "Bearer ms-token");
  assert.equal(submit.headers["x-modelscope-async-mode"], "true");
  const poll = stub.requests.find((entry) => entry.method === "GET");
  assert.equal(poll.url.pathname, "/tasks/ms-1");
  assert.equal(poll.headers["x-modelscope-task-type"], "image_generation");
});

test("本地 stub：提交即返回图片 → 不轮询；图像编辑带 data URL 参考图", async () => {
  const stub = await startStub((url) => {
    if (url.pathname === "/images/generations") return { body: { output_images: ["https://cdn.example/direct.png"] } };
    return null;
  });
  const integration = createModelScopeIntegration({ fetch, credentials: memoryCredentialBackend(), pollIntervalMs: 5 });
  const provider = { base_url: stub.base, api_key: "ms-token" };
  const direct = await integration.generateModelScopeImages(provider, "m", { prompt: "x" }, 5000, { fetch });
  assert.equal(direct.images[0].value, "https://cdn.example/direct.png");
  assert.equal(stub.requests.filter((entry) => entry.method === "GET").length, 0, "同步返回不得再轮询");

  const edit = await integration.editModelScopeImages(provider, "Qwen/Qwen-Image-Edit-2511", { prompt: "改成夜景" }, [{ buf: Buffer.from("abc"), mime: "image/png", name: "a.png" }], 5000, { fetch });
  assert.equal(edit.images[0].value, "https://cdn.example/direct.png");
  const editSubmit = stub.requests.filter((entry) => entry.method === "POST").at(-1);
  assert.match(editSubmit.body.image_url[0], /^data:image\/png;base64,/);
});

test("远端失败与超时：任务 FAILED → INTEGRATION_REQUEST_FAILED 结构化失败，不假成功", async () => {
  const stub = await startStub((url) => {
    if (url.pathname === "/images/generations") return { body: { task_id: "ms-bad" } };
    if (url.pathname === "/tasks/ms-bad") return { body: { task_status: "FAILED", message: "boom" } };
    return null;
  });
  const integration = createModelScopeIntegration({ fetch, credentials: memoryCredentialBackend(), pollIntervalMs: 1 });
  const res = await integration.generateModelScopeImages({ base_url: stub.base, api_key: "k" }, "m", { prompt: "x" }, 500, { fetch });
  assert.equal(res.ok, false);
  assert.equal(res.error, "INTEGRATION_REQUEST_FAILED");
  assert.match(res.detail, /失败/);
});

// ── ③ 未配置 → 结构化不可用 ───────────────────────────────────────────────
test("未配置：未注入 fetch / 未配置令牌 → INTEGRATION_UNAVAILABLE", async () => {
  const noFetch = createModelScopeIntegration({ credentials: memoryCredentialBackend() });
  const blocked = await noFetch.generateModelScopeImages({ base_url: "https://example.invalid" }, "m", { prompt: "x" }, 1000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "INTEGRATION_UNAVAILABLE");
  assert.match(blocked.detail, /fetch/);

  const withFetch = createModelScopeIntegration({ fetch, credentials: memoryCredentialBackend() });
  const noToken = await withFetch.generateModelScopeImages({ base_url: "https://example.invalid" }, "m", { prompt: "x" }, 1000);
  assert.equal(noToken.error, "INTEGRATION_UNAVAILABLE");
  assert.match(noToken.detail, /令牌/);
});

// ── ④ 凭据 ────────────────────────────────────────────────────────────────
test("凭据：saveCredential 走 credential-store，只回掩码；safeStorage 不可用即拒绝", () => {
  const credentials = memoryCredentialBackend();
  const integration = createModelScopeIntegration({ fetch, credentials });
  const saved = integration.saveCredential({ accessToken: "MS-SECRET-ABCDEF" });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.accessTokenSet, true);
  assert.equal(saved.value.accessTokenMask.includes("MS-SECRET-ABCDEF"), false);
  assert.match(saved.value.accessTokenMask, /••••/);
  assert.equal(credentials.get("modelscope.accessToken"), "MS-SECRET-ABCDEF");
  assert.equal(integration.resolveApiKey({}), "MS-SECRET-ABCDEF");
  assert.equal(integration.resolveApiKey({ api_key: "direct" }), "direct", "provider.api_key 优先");

  const noStore = createModelScopeIntegration({ fetch });
  const refused = noStore.saveCredential({ accessToken: "xxxx" });
  assert.equal(refused.error, "INTEGRATION_UNAVAILABLE");
  assert.match(refused.detail, /safeStorage/);
});

// ── ⑤ legacy 端口 ─────────────────────────────────────────────────────────
test("端口：未注入 → LEGACY_DEPENDENCY_UNAVAILABLE；注入假端口 → 图片生成/图像编辑真的调用注入实现", async () => {
  clearLegacyExecutorPorts();
  const provider = { base_url: "https://example.invalid", api_key: "k", protocol: "modelscope" };
  const imageBlocked = await images.generateImages(provider, "m", { prompt: "x" }, 1000);
  assert.equal(imageBlocked.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(imageBlocked.detail, /modelscope/);
  const editBlocked = await media.editImages(provider, "m", { prompt: "x" }, [{ buf: Buffer.from("x"), mime: "image/png", name: "x.png" }], 1000);
  assert.equal(editBlocked.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(editBlocked.detail, /modelscope/);

  const seen = [];
  setLegacyExecutorPorts({
    generateModelScopeImages: async (...args) => { seen.push(["generate", args]); return { images: [{ type: "url", value: "https://cdn.example/gen.png" }], raw: {} }; },
    editModelScopeImages: async (...args) => { seen.push(["edit", args]); return { images: [{ type: "url", value: "https://cdn.example/edit.png" }], raw: {} }; },
  });
  const gen = await images.generateImages(provider, "m", { prompt: "x" }, 1000);
  assert.equal(gen.images[0].value, "https://cdn.example/gen.png");
  assert.equal(seen[0][1][0].protocol, "modelscope");
  const edit = await media.editImages(provider, "m", { prompt: "x" }, [{ buf: Buffer.from("x"), mime: "image/png", name: "x.png" }], 1000);
  assert.equal(edit.images[0].value, "https://cdn.example/edit.png");
  assert.equal(seen[1][1][3][0].name, "x.png", "edit 端口收到参考图");
});

// ── ⑥ 装配后启用 → legacy 执行器真的走 ModelScope 新实现 ───────────────────
test("装配：createPluginBundle 注册端口；启用 modelscope 后 legacy 图像编辑走新实现（本地 stub）", async () => {
  clearLegacyExecutorPorts();
  const stub = await startStub((url) => {
    if (url.pathname === "/images/generations") return { body: { output_images: ["https://cdn.example/bundle-ms.png"] } };
    return null;
  });
  const bundle = createPluginBundle({ userDataDir: tempDir(), fetch, credentials: memoryCredentialBackend() });
  assert.equal(bundle.registry.get("modelscope").enabled, false);
  const before = await media.editImages({ base_url: stub.base, api_key: "k", protocol: "modelscope" }, "m", { prompt: "x" }, [{ buf: Buffer.from("x"), mime: "image/png", name: "x.png" }], 5000, { fetch });
  assert.equal(before.error, "INTEGRATION_UNAVAILABLE");
  assert.match(before.detail, /默认关闭/);

  assert.equal((await bundle.registry.enable("modelscope")).ok, true);
  const result = await media.editImages({ base_url: stub.base, api_key: "k", protocol: "modelscope" }, "m", { prompt: "改成夜景" }, [{ buf: Buffer.from("x"), mime: "image/png", name: "x.png" }], 5000, { fetch });
  assert.equal(result.ok, undefined, "成功走源协议形状");
  assert.equal(result.images[0].value, "https://cdn.example/bundle-ms.png");
  const submit = stub.requests.find((entry) => entry.method === "POST");
  assert.equal(submit.body.prompt, "改成夜景");
});
