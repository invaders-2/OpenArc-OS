/**
 * P2 · 模型与协议域契约测试（node:http stub，无外网、无真实密钥）。
 * 覆盖：OpenAI 兼容请求体与响应解析、图像协议请求体与产物落盘、
 * SSRF 防护（127.0.0.1 / 169.254.169.254）、协议 validate/compile 合法与非法、
 * 声明式引擎端到端、manifest 与本地协议包扫描。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const domain = require("../electron/provider-protocol-domain.cjs");
const { createProviderProtocolBundle } = require("../electron/provider-protocol-service.cjs");
const { memoryCredentialBackend } = require("../electron/credential-store.cjs");
const artifact = require("../electron/protocol-engine/artifactDownload.cjs");
const validator = require("../electron/protocol-engine/validator.cjs");
const compiler = require("../electron/protocol-engine/compiler.cjs");
const workflow = require("../electron/protocol-engine/workflow.cjs");
const builtins = require("../electron/protocol-engine/builtins.cjs");
const repository = require("../electron/protocol-engine/repository.cjs");
const { createModelManifestService } = require("../electron/model-manifest-service.cjs");
const mediaExecutor = require("../electron/protocol-engine/legacy-executor-media.cjs");

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      port: server.address().port,
      baseUrl: "http://127.0.0.1:" + server.address().port,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function bundleFor(baseUrl) {
  const dir = tempDir("dxos-p2-");
  const bundle = createProviderProtocolBundle({ userDataDir: dir, backend: memoryCredentialBackend() });
  const provider = bundle.store.create({ name: "Stub", baseUrl, protocol: "openai", models: [{ model: "test-model", caps: ["llm", "image"] }] });
  bundle.store.setKeys(provider.id, { apiKey: "FAKE_P2_TEST_KEY" });
  return { dir, bundle, provider };
}

test("协议表覆盖 DX OS legacy 29 模型 + 20 供应商，且 v2 内置标注移植状态", () => {
  assert.equal(domain.LEGACY_MODEL_PROTOCOLS.length, 29);
  // 源 protocols.ts:2589-2982 顶层实测 20 个；旧值 19 漏计了 protocols.ts:2659 的 'cli:dreamina-canvas'。
  assert.equal(domain.LEGACY_PROVIDER_PROTOCOLS.length, 20);
  const table = domain.protocolTable();
  assert.ok(table.some((item) => item.id === "openai-images" && item.engine === "v2" && item.ported === true));
  assert.ok(table.some((item) => item.id === "anthropic" && item.engine === "legacy"));
  // 移植状态如实标注：midjourney 已有 v2 内置定义（builtins.ts:1696），ported=true
  assert.ok(domain.protocolTable("model").some((item) => item.id === "midjourney" && item.ported === true));
  // 模型协议里不应再残留任何 ported:false 的条目
  assert.equal(domain.protocolTable("model").some((item) => item.ported === false), false);
});

test("执行可用性：5 个可见 legacy 分支标注 execution=unavailable，被遮蔽的 agnes 由 shadowedLegacy 单独如实暴露", async () => {
  // 协议表/items 里可见的 legacy 不可用 id（执行分支仍返回 LEGACY_DEPENDENCY_UNAVAILABLE）。
  const UNAVAILABLE_IDS = ["cli:jimeng", "cli:codex", "cli:gemini", "runninghub", "modelscope"];
  // agnes 的 legacy 分支与 v2 同名定义冲突，按既有去重规则被遮蔽，不再作为重复行出现。
  const table = domain.protocolTable();

  for (const item of table.filter((entry) => entry.engine === "v2")) {
    assert.equal(item.execution, "declarative", "v2 " + item.kind + ":" + item.id);
    assert.equal("unavailableReason" in item, false, "v2 " + item.kind + ":" + item.id);
  }
  for (const item of table.filter((entry) => entry.engine === "legacy" && !UNAVAILABLE_IDS.includes(entry.id))) {
    assert.equal(item.execution, "available", "legacy " + item.kind + ":" + item.id);
    assert.equal("unavailableReason" in item, false, "legacy " + item.kind + ":" + item.id);
  }
  // 可见 legacy 条目中 execution=unavailable 的 id 集合恰好是这 5 个，各带非空 reason。
  const markedUnavailable = [...new Set(table.filter((entry) => entry.engine === "legacy" && entry.execution === "unavailable").map((entry) => entry.id))].sort();
  assert.deepEqual(markedUnavailable, [...UNAVAILABLE_IDS].sort());
  for (const id of UNAVAILABLE_IDS) {
    const legacyEntries = table.filter((entry) => entry.id === id && entry.engine === "legacy");
    assert.ok(legacyEntries.length > 0, id + " 必须有 legacy 条目");
    for (const item of legacyEntries) {
      assert.equal(item.execution, "unavailable", item.kind + ":" + id);
      assert.ok(String(item.unavailableReason || "").length > 0, item.kind + ":" + id + " 必须写明批次理由");
    }
  }
  // 被遮蔽的 agnes 不再进入 protocolTable()，且表内不存在重复 kind:id。
  assert.equal(table.some((entry) => entry.id === "agnes" && entry.engine === "legacy"), false, "agnes 的 legacy 分支应被去重遮蔽");
  const tableKeys = table.map((entry) => entry.kind + ":" + entry.id);
  assert.equal(tableKeys.length, new Set(tableKeys).size, "protocolTable() 不得出现重复 kind:id");

  // 被遮蔽的 legacy 不可用分支清单：恰好 agnes 一条，execution=unavailable 且 reason 非空。
  const shadowed = domain.shadowedLegacyProtocols();
  assert.deepEqual(shadowed.map((item) => item.id), ["agnes"]);
  assert.equal(shadowed[0].kind, "model");
  assert.equal(shadowed[0].execution, "unavailable");
  assert.ok(String(shadowed[0].unavailableReason || "").length > 0);

  // 执行期核对：5 个可见不可用 id 与被遮蔽的 agnes 都返回结构化 LEGACY_DEPENDENCY_UNAVAILABLE。
  const imageInputs = [{ buf: Buffer.from("x"), mime: "image/png", name: "x.png" }];
  for (const id of [...UNAVAILABLE_IDS, "agnes"]) {
    const provider = { protocol: id, base_url: "https://example.invalid", api_key: "FAKE_D4_TEST_KEY" };
    const result = await mediaExecutor.editImages(provider, "m", { prompt: "x" }, imageInputs, 1000);
    assert.equal(result.ok, false, id);
    assert.equal(result.error, "LEGACY_DEPENDENCY_UNAVAILABLE", id);
    assert.ok(String(result.detail || "").length > 0, id);
  }

  // 服务出口 listProtocols：既有字段与 items 形状不变，仅追加 shadowedLegacy。
  const { bundle } = bundleFor("http://127.0.0.1:1");
  const listed = bundle.service.listProtocols();
  assert.equal(listed.ok, true);
  for (const id of UNAVAILABLE_IDS) {
    const legacyEntry = listed.items.find((item) => item.id === id && item.engine === "legacy");
    assert.ok(legacyEntry, "listProtocols 缺少 legacy " + id);
    assert.equal(legacyEntry.ported, true, id);
    assert.equal(legacyEntry.execution, "unavailable", id);
    assert.ok(String(legacyEntry.unavailableReason || "").length > 0, id);
  }
  assert.ok(listed.items.filter((item) => item.engine === "v2").every((item) => item.execution === "declarative"));
  assert.equal(listed.items.some((item) => item.id === "agnes" && item.engine === "legacy"), false, "items 不得含被遮蔽的 agnes legacy 行");
  const listedUnavailable = [...new Set(listed.items.filter((item) => item.engine === "legacy" && item.execution === "unavailable").map((item) => item.id))].sort();
  assert.deepEqual(listedUnavailable, [...UNAVAILABLE_IDS].sort());
  const itemKeys = listed.items.map((item) => item.kind + ":" + item.id);
  assert.equal(itemKeys.length, new Set(itemKeys).size, "listProtocols().items 不得出现重复 kind:id");

  // shadowedLegacy 附加字段：恰好 agnes 一条，execution=unavailable 且 reason 非空。
  assert.equal(Array.isArray(listed.shadowedLegacy), true, "listProtocols 必须暴露 shadowedLegacy");
  assert.equal(listed.shadowedLegacy.length, 1);
  assert.equal(listed.shadowedLegacy[0].id, "agnes");
  assert.equal(listed.shadowedLegacy[0].kind, "model");
  assert.equal(listed.shadowedLegacy[0].execution, "unavailable");
  assert.ok(String(listed.shadowedLegacy[0].unavailableReason || "").length > 0);
});

test("OpenAI 兼容 chat 请求体构造：path/headers/body", () => {
  const built = domain.buildChatRequest({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], params: { temperature: 0.3, ignored: 1 }, stream: false });
  assert.equal(built.method, "POST");
  assert.equal(built.url, "https://api.example.com/v1/chat/completions");
  assert.equal(built.headers.authorization, "Bearer sk-test");
  assert.deepEqual(built.body, { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], stream: false, temperature: 0.3 });
});

test("图像协议请求体构造：images/generations", () => {
  const built = domain.buildImageRequest({ baseUrl: "https://api.example.com", apiKey: "sk-test", model: "gpt-image-1", prompt: "a cat", size: "1024x1024", count: 2 });
  assert.equal(built.url, "https://api.example.com/v1/images/generations");
  assert.deepEqual(built.body, { model: "gpt-image-1", prompt: "a cat", n: 2, size: "1024x1024" });
});

test("OpenAI 兼容调用：服务发出真实请求体并解析文本与 usage", async () => {
  let seen = null;
  const stub = await startStub((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "hello from stub" } }], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } }));
    });
  });
  const { bundle, provider } = bundleFor(stub.baseUrl);
  try {
    const result = await bundle.service.call({ providerId: provider.id, model: "test-model", messages: [{ role: "user", content: "hi" }], params: { max_tokens: 16 } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.text, "hello from stub");
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 5, totalTokens: 12 });
    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.auth, "Bearer FAKE_P2_TEST_KEY");
    assert.deepEqual(seen.body, { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: false, max_tokens: 16 });
  } finally { await stub.close(); }
});

test("OpenAI 兼容流式：SSE 增量与 usage", async () => {
  const stub = await startStub((req, res) => {
    req.resume();
    res.setHeader("content-type", "text/event-stream");
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    res.write('data: {"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const { bundle, provider } = bundleFor(stub.baseUrl);
  const events = [];
  try {
    const result = await bundle.service.call({ providerId: provider.id, model: "test-model", messages: [], stream: true, onEvent: (e) => events.push(e) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.text, "Hello");
    assert.equal(result.usage.totalTokens, 3);
    assert.deepEqual(events.filter((e) => e.type === "text.delta").map((e) => e.text), ["Hel", "lo"]);
    assert.ok(events.some((e) => e.type === "response.complete"));
  } finally { await stub.close(); }
});

test("图像协议：产物落盘到 <userData>/dxos/media", async () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  let seen = null;
  const stub = await startStub((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }));
    });
  });
  const { dir, bundle, provider } = bundleFor(stub.baseUrl);
  try {
    const result = await bundle.service.generateImage({ providerId: provider.id, model: "test-model", prompt: "a cat", size: "512x512" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(seen, { model: "test-model", prompt: "a cat", n: 1, size: "512x512" });
    assert.equal(result.images.length, 1);
    assert.ok(result.images[0].mediaPath.startsWith(path.join(dir, "dxos", "media")));
    assert.deepEqual(fs.readFileSync(result.images[0].mediaPath), pngBytes);
  } finally { await stub.close(); }
});

test("SSRF 防护：拒绝 localhost / 私网 / 链路本地 / 云元数据", () => {
  for (const url of [
    "http://127.0.0.1/artifact.png",
    "http://localhost/artifact.png",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/artifact.png",
    "http://10.0.0.1/artifact.png",
    "http://192.168.1.10/artifact.png",
    "http://172.16.0.1/artifact.png",
    "http://metadata.google.internal/computeMetadata/v1/",
    "file:///etc/passwd",
    "http://2130706433/artifact.png",
  ]) {
    assert.throws(() => artifact.validateProtocolArtifactUrl(url), /SSRF|HTTP\(S\)|URL/, url);
  }
  assert.equal(artifact.validateProtocolArtifactUrl("https://cdn.example.com/a.png").hostname, "cdn.example.com");
  assert.equal(artifact.isBlockedArtifactAddress("169.254.169.254"), true);
  assert.equal(artifact.isBlockedArtifactAddress("100.100.100.200"), true);
  assert.equal(artifact.isBlockedArtifactAddress("93.184.216.34"), false);
});

test("协议 validate：合法内置通过，非法定义返回具体 issues", () => {
  const provider = builtins.getBuiltinProtocolV2("provider", "openai-http");
  assert.equal(validator.isProviderProtocolV2(validator.validateProtocolV2(provider)), true);

  const badSchema = { ...provider, schemaVersion: "dx-protocol/v1" };
  assert.throws(() => validator.validateProtocolV2(badSchema), (error) => error.name === "ProtocolValidationError" && error.issues.some((i) => i.includes("schemaVersion")));

  const badHeader = { ...provider, headers: { ...provider.headers, Host: "evil.example.com" } };
  assert.throws(() => validator.validateProtocolV2(badHeader), (error) => error.issues.some((i) => i.includes("Host")));

  const badTemplate = JSON.parse(JSON.stringify(provider));
  badTemplate.models.headersTemplate = { "X-Test": "{{secret.field}}" };
  assert.throws(() => validator.validateProtocolV2(badTemplate), (error) => error.issues.some((i) => i.includes("未授权模板变量")));
});

test("协议 compile：合法计划含 submit 步骤；未声明的 intent 明确失败", () => {
  const provider = builtins.getBuiltinProtocolV2("provider", "openai-http");
  const model = builtins.getBuiltinProtocolV2("model", "openai-images");
  const plan = compiler.compileProtocolPlan({
    providerProtocol: provider, modelProtocol: model, baseUrl: "http://127.0.0.1:1", credential: "k",
    task: { requestId: "req-1", model: "gpt-4o-mini", intent: "llm.chat", prompt: "hi", params: {}, inputs: { images: [], videos: [], audios: [], files: [] } },
  });
  assert.equal(plan.format, "dx-protocol-plan/v1");
  const submit = plan.steps.find((step) => step.id === "submit");
  assert.equal(submit.request.method, "POST");
  assert.ok(submit.request.url.endsWith("/v1/chat/completions"));
  assert.equal(submit.request.body.model, "gpt-4o-mini");
  assert.equal(submit.request.body.messages[0].content, "hi");

  assert.throws(() => compiler.compileProtocolPlan({
    providerProtocol: provider, modelProtocol: model, baseUrl: "http://127.0.0.1:1",
    task: { requestId: "req-2", model: "gpt-4o-mini", intent: "image.unknown", prompt: "hi", params: {}, inputs: { images: [], videos: [], audios: [], files: [] } },
  }), /没有匹配/);
});

test("声明式引擎端到端：compile → execute 得到标准化文本输出", async () => {
  const stub = await startStub((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "engine-ok" } }], usage: { total_tokens: 4 } }));
  });
  const { bundle, provider } = bundleFor(stub.baseUrl);
  try {
    const result = await bundle.service.executeProtocol({ providerId: provider.id, protocolId: "openai-images", model: "gpt-4o-mini", intent: "llm.chat", prompt: "hello" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.outputs.length, 1);
    assert.equal(result.outputs[0].kind, "text");
    assert.equal(Buffer.from(result.outputs[0].data).toString("utf8"), "engine-ok");
  } finally { await stub.close(); }
});

test("manifest + 本地协议包扫描（替代远程更新）", () => {
  const manifestService = createModelManifestService({ repository });
  const manifest = manifestService.getManifest({ protocolId: "openai-images", model: "gpt-image-1", intent: "image.generate" });
  assert.equal(manifest.ok, true);
  assert.equal(manifest.operation.path, "/v1/images/generations");
  assert.deepEqual(manifest.parameterSchema.fields.map((field) => field.key), ["size", "quality"]);
  assert.equal(manifestService.getManifest({ protocolId: "does-not-exist", model: "x", intent: "llm.chat" }).ok, false);

  const dir = tempDir("dxos-pkg-");
  fs.writeFileSync(path.join(dir, "custom.json"), JSON.stringify({
    schemaVersion: "dx-protocol/v2", kind: "provider", id: "dxos-test-pkg", label: "DXOS Test Package",
    executor: { type: "declarative", engine: ">=1.0.0" }, auth: { type: "none" },
    headers: { Accept: "application/json" }, models: { method: "GET", path: "/v1/models", response: { data: "$.data" } },
  }));
  const scan = manifestService.scanProtocolUpdates({ directories: [dir] });
  assert.equal(scan.ok, true);
  assert.equal(scan.source, "local");
  assert.ok(scan.packages.some((entry) => entry.id === "dxos-test-pkg" && entry.valid === true));

  repository.configureProtocolRepository({ packageDirs: [dir] });
  assert.equal(repository.getProtocolV2("provider", "dxos-test-pkg").protocol.label, "DXOS Test Package");
  repository.configureProtocolRepository({ packageDirs: [] });
});

test("统一出口命令表：风险与凭据要求明确，且不含 secret/raw/token/proxy 字样", () => {
  assert.equal(domain.commandRisk("protocol/list"), "read");
  assert.equal(domain.commandRequiresCredential("provider/call"), true);
  assert.equal(domain.commandRequiresCredential("manifest/get"), false);
  assert.equal(Object.keys(domain.PROTOCOL_COMMANDS).some((name) => /secret|raw|token|proxy/i.test(name)), false);
  assert.ok(workflow.describeProtocolError(new Error("boom")));
});
