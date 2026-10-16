/**
 * W2 · DX OS legacy 协议表（protocols.ts）移植契约测试。
 * 只读源：DXSRC/protocols.ts（runtime-0.5.5-0b51356e）。
 * 被测：electron/protocol-engine/legacy-protocols.cjs（纯数据+纯函数）。
 * 运行：node --test tests/dxos-protocol-legacy.test.mjs
 *
 * 计数核对（服务端实际顶层 key）：
 *   模型协议：awk 'NR>=281 && NR<=2570' protocols.ts 顶层 key = 29
 *   供应商协议：源 :2589-2982 顶层 key 实测为 20（含 'cli:dreamina-canvas'，:2659-2667）。
 *   任务书写 19 是漏计；本测试按源码实际值断言，不伪造。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const legacy = require("../electron/protocol-engine/legacy-protocols.cjs");
const domain = require("../electron/provider-protocol-domain.cjs");

/** 源 protocols.ts:281-2568 的 29 个模型协议 key（源码顺序）。 */
const MODEL_IDS = [
  "ollama", "openai", "anthropic", "gemini", "gemini-generations", "gpt-best-images", "apimart", "apimart-gemini",
  "apimart-claude", "apimart-media", "agtoken-video", "zkki-model", "midjourney", "v2-unified", "xai", "grok",
  "grok2api", "kling", "pixverse", "pika", "vidu", "wanxiang", "minimax", "suno", "agnes", "modelscope",
  "volcengine", "volcengine-speech", "runninghub",
];

/** 源 protocols.ts:2589-2982 的 20 个供应商协议 key（源码顺序，含 cli:dreamina-canvas）。 */
const PROVIDER_IDS = [
  "ollama", "cli:pippit", "cli:dreamina-canvas", "cli:jimeng", "cli:codex", "cli:gemini", "openai", "openai-relay",
  "aliyun-bailian", "apimart", "agtoken", "zkki", "xai", "grok2api", "agnes", "modelscope", "volcengine",
  "volcengine-speech", "minimax", "runninghub",
];

test("PROTOCOLS 顶层 key 恰为 29 个（逐个列出断言）", () => {
  const keys = Object.keys(legacy.PROTOCOLS);
  assert.equal(keys.length, 29);
  assert.deepEqual(keys, MODEL_IDS);
  for (const id of MODEL_IDS) assert.ok(legacy.PROTOCOLS[id] && legacy.PROTOCOLS[id].id === id, id);
});

test("PROVIDER_PROTOCOLS 顶层 key 实测 20 个（任务书 19 漏计 cli:dreamina-canvas）", () => {
  const keys = Object.keys(legacy.PROVIDER_PROTOCOLS);
  assert.equal(keys.length, 20, "源 protocols.ts:2589-2982 实测 20 个；任务书写的 19 与源不符");
  assert.deepEqual(keys, PROVIDER_IDS);
  assert.ok(keys.includes("cli:dreamina-canvas"), "源 :2659 的顶层 key 必须存在");
  for (const id of PROVIDER_IDS) assert.ok(legacy.PROVIDER_PROTOCOLS[id] && legacy.PROVIDER_PROTOCOLS[id].id === id, id);
});

test("每个模型协议至少有 id/label/auth/models；kind 为源里可选字段", () => {
  for (const [key, def] of Object.entries(legacy.PROTOCOLS)) {
    assert.equal(typeof def.id, "string", key + ".id");
    assert.equal(def.id, key, key + ".id 必须等于顶层 key");
    assert.equal(typeof def.label, "string", key + ".label");
    assert.ok(def.label.length > 0, key + ".label 非空");
    assert.ok(def.auth && typeof def.auth.type === "string", key + ".auth");
    assert.ok(def.models && typeof def.models.endpoint === "string" && typeof def.models.kind === "string", key + ".models");
    assert.equal(typeof def.capabilities, "object", key + ".capabilities");
  }
  // 源 ProtocolDef.kind 是可选字段；anthropic/gemini/apimart 在源里确实未声明 kind，非移植遗漏。
  const missingKind = Object.values(legacy.PROTOCOLS).filter((p) => !p.kind).map((p) => p.id).sort();
  assert.deepEqual(missingKind, ["anthropic", "apimart", "gemini"]);
  const allowed = new Set(["provider-protocol-package", "model-protocol-package"]);
  for (const def of Object.values(legacy.PROTOCOLS)) {
    if (def.kind) assert.ok(allowed.has(def.kind), def.id + ".kind=" + def.kind);
  }
});

test("每个供应商协议都有 runtimeProtocol 与 auth，且 kind 为 provider-protocol", () => {
  for (const [key, def] of Object.entries(legacy.PROVIDER_PROTOCOLS)) {
    assert.equal(def.id, key, key + ".id");
    assert.equal(typeof def.runtimeProtocol, "string", key + ".runtimeProtocol");
    assert.ok(def.runtimeProtocol.length > 0, key + ".runtimeProtocol 非空");
    assert.ok(def.auth && typeof def.auth.type === "string", key + ".auth");
    assert.equal(def.kind, "provider-protocol", key + ".kind");
  }
});

test("normalizeProtocolId：命中模型表/别名/供应商表返回 key，否则 fallback", () => {
  assert.equal(legacy.normalizeProtocolId("openai"), "openai");
  assert.equal(legacy.normalizeProtocolId("  OPENAI "), "openai");
  assert.equal(legacy.normalizeProtocolId("openai-chat"), "openai-chat"); // 别名表也算命中
  assert.equal(legacy.normalizeProtocolId("cli:jimeng"), "cli:jimeng"); // 供应商表
  assert.equal(legacy.normalizeProtocolId("gemini-http"), "openai"); // gemini-http 只是 v2 供应商协议，getProtocolV2('model') 不命中 → fallback
  assert.equal(legacy.normalizeProtocolId("openai-images"), "openai-images"); // 源 :3391 getProtocolV2('model') 命中 v2 内置
  assert.equal(legacy.normalizeProtocolId("openai-http"), "openai"); // 源只查 getProtocolV2('model')，供应商 id 不命中 → fallback
  assert.equal(legacy.normalizeProtocolId("nope", "zzz"), "zzz");
  assert.equal(legacy.normalizeProtocolId("", "zzz"), "zzz");
});

test("normalizeProviderProtocolId：运行时 ID 归一到平台 ID", () => {
  assert.equal(legacy.normalizeProviderProtocolId("agtoken"), "agtoken");
  assert.equal(legacy.normalizeProviderProtocolId("agtoken-video"), "agtoken");
  assert.equal(legacy.normalizeProviderProtocolId("zkki-model"), "zkki");
  assert.equal(legacy.normalizeProviderProtocolId("openai"), "openai");
  assert.equal(legacy.normalizeProviderProtocolId("openai-http"), "openai-http"); // 源 :3400 getProtocolV2('provider') 命中 v2 内置
  assert.equal(legacy.normalizeProviderProtocolId("nope"), "openai");
  assert.equal(legacy.normalizeProviderProtocolId("nope", "x"), "x");
});

test("normalizeProtocol：别名/站点协议 → 运行时协议", () => {
  assert.equal(legacy.normalizeProtocol("gemini-http"), "gemini");
  assert.equal(legacy.normalizeProtocol("openai-chat"), "openai");
  assert.equal(legacy.normalizeProtocol("openai-image"), "openai");
  assert.equal(legacy.normalizeProtocol("anthropic"), "anthropic");
  assert.equal(legacy.normalizeProtocol("ollama"), "ollama"); // 源无 runtimeProtocol → 自身
  assert.equal(legacy.normalizeProtocol("cli:jimeng"), "cli:jimeng");
  assert.equal(legacy.normalizeProtocol("nope", "fallback"), "fallback");
});

test("modelProtocolAlias：大小写/空白不敏感，未命中返回 null", () => {
  assert.equal(legacy.modelProtocolAlias("openai-chat").runtimeProtocol, "openai");
  assert.equal(legacy.modelProtocolAlias("  GEMINI-IMAGE ").runtimeProtocol, "gemini");
  assert.equal(legacy.modelProtocolAlias("anthropic-chat").runtimeProtocol, "anthropic");
  assert.equal(legacy.modelProtocolAlias("gpt-image"), null);
  assert.equal(legacy.modelProtocolAlias(""), null);
});

test("suggestModelProtocol：按源分支逐条断言（远程 bindings 分支未移植）", () => {
  assert.equal(legacy.suggestModelProtocol("fhl-http", "xxx-image"), "");
  assert.equal(legacy.suggestModelProtocol("apimart", ""), "");
  // agtoken / agtoken-video
  assert.equal(legacy.suggestModelProtocol("agtoken", "gpt-4o"), "openai-chat");
  assert.equal(legacy.suggestModelProtocol("agtoken-video", "claude-3-5-sonnet"), "openai-chat");
  assert.equal(legacy.suggestModelProtocol("agtoken", "gpt-image-1"), "openai-image");
  assert.equal(legacy.suggestModelProtocol("agtoken", "nano-banana"), "openai-image");
  assert.equal(legacy.suggestModelProtocol("agtoken", "my-video-model"), "agtoken-video"); // 两则都不中 → 兜底
  // zkki / zkki-model
  assert.equal(legacy.suggestModelProtocol("zkki", "deepseek-v3"), "openai-chat");
  assert.equal(legacy.suggestModelProtocol("zkki-model", "some-random"), "zkki-model");
  // apimart
  assert.equal(legacy.suggestModelProtocol("apimart", "gpt-4o-mini-tts"), "apimart");
  assert.equal(legacy.suggestModelProtocol("apimart", "midjourney-v6"), "midjourney");
  assert.equal(legacy.suggestModelProtocol("apimart", "niji 6"), "midjourney");
  assert.equal(legacy.suggestModelProtocol("apimart", "claude-3-opus"), "apimart");
  assert.equal(legacy.suggestModelProtocol("apimart", "imagen-3"), "apimart");
  assert.equal(legacy.suggestModelProtocol("apimart", "veo-3"), "apimart");
  assert.equal(legacy.suggestModelProtocol("apimart", "unknown-xyz"), "");
});

test("providerProtocolCandidates：只用内置站点规则", () => {
  assert.deepEqual(legacy.providerProtocolCandidates("https://api.apimart.ai/v1/chat/completions"), ["apimart", "openai"]);
  assert.deepEqual(legacy.providerProtocolCandidates("https://apib.ai/v1"), ["openai"]);
  assert.deepEqual(
    legacy.providerProtocolCandidates("https://dashscope.aliyuncs.com/compatible-mode/v1", "xai"),
    ["aliyun-bailian", "xai", "openai"],
  );
  assert.deepEqual(legacy.providerProtocolCandidates("https://example.com", "openai"), ["openai"]);
  assert.deepEqual(legacy.providerProtocolCandidates("not a url", "openai"), ["openai"]);
});

test("joinUrl：重复 /v1 前缀去重、绝对端点直通、agtoken origin 归一", () => {
  assert.equal(legacy.joinUrl("https://x.example/v1", "/v1/chat/completions"), "https://x.example/v1/chat/completions");
  assert.equal(legacy.joinUrl("https://x.example", "chat/completions"), "https://x.example/chat/completions");
  assert.equal(legacy.joinUrl("https://x.example/api/v3", "/api/v3/models"), "https://x.example/api/v3/models");
  assert.equal(legacy.joinUrl("https://x.example", "https://other.example/z"), "https://other.example/z");
  assert.equal(legacy.joinUrl("https://api.agtoken.vip/docs/v1/", "/v1/models"), "https://api.agtoken.vip/v1/models");
  assert.throws(() => legacy.joinUrl("", "/v1"), /缺少 base_url/);
});

test("buildAuthHeaders：bearer / api_key_header / google_api_key / none", () => {
  assert.deepEqual(legacy.buildAuthHeaders(legacy.PROTOCOLS.openai, "sk-1"), { Authorization: "Bearer sk-1" });
  assert.deepEqual(legacy.buildAuthHeaders(legacy.PROTOCOLS.anthropic, "sk-2"), { "x-api-key": "sk-2" });
  assert.deepEqual(legacy.buildAuthHeaders(legacy.PROTOCOLS.gemini, "sk-3"), { "x-goog-api-key": "sk-3" });
  assert.deepEqual(legacy.buildAuthHeaders(legacy.PROTOCOLS.openai, ""), {});
  assert.deepEqual(legacy.buildAuthHeaders(legacy.PROVIDER_PROTOCOLS.ollama, "sk"), {});
});

test("unwrapProviderPayload：仅在声明 unwrapData 且非 choices/candidates 时取 data", () => {
  assert.deepEqual(legacy.unwrapProviderPayload({ unwrapData: true }, { code: 0, data: { ok: 1 } }), { ok: 1 });
  assert.deepEqual(legacy.unwrapProviderPayload({ unwrapData: true }, { data: {}, choices: [1] }), { data: {}, choices: [1] });
  assert.deepEqual(legacy.unwrapProviderPayload({}, { data: { a: 1 } }), { data: { a: 1 } });
});

test("parseBody：openai/anthropic/gemini 三种载荷", () => {
  assert.deepEqual(
    legacy.parseBody("openai_chat", { choices: [{ message: { content: "hi" } }], usage: { total_tokens: 3 } }),
    { text: "hi", usage: { total_tokens: 3 } },
  );
  assert.deepEqual(
    legacy.parseBody("openai_chat", { choices: [{ text: "legacy" }] }).text,
    "legacy",
  );
  assert.deepEqual(
    legacy.parseBody("anthropic_text", { content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }], usage: { input_tokens: 1 } }),
    { text: "ab", usage: { input_tokens: 1 } },
  );
  assert.deepEqual(
    legacy.parseBody("gemini_text", { candidates: [{ content: { parts: [{ text: "x" }, { text: "y" }] } }], usageMetadata: { totalTokenCount: 2 } }),
    { text: "x\ny", usage: { totalTokenCount: 2 } },
  );
});

test("parseModels / parseModelCatalog：envelope、字符串数组、gemini、扩展元数据", () => {
  assert.deepEqual(legacy.parseModels("openai", { data: [{ id: "a" }, { id: "b" }] }), ["a", "b"]);
  assert.deepEqual(legacy.parseModels("openai", { data: ["m1", "m2"] }), ["m1", "m2"]);
  assert.deepEqual(legacy.parseModels("gemini", { models: [{ name: "models/gemini-pro", displayName: "Gemini Pro" }] }), ["gemini-pro"]);
  assert.deepEqual(legacy.parseModels("anthropic", { models: [{ name: "claude-x" }] }), ["claude-x"]);

  const catalog = legacy.parseModelCatalog("openai", { data: [
    { id: "img-1", media_type: "image", operations: ["image.generate"], pricing: { unit: "x" } },
    { id: "chat-1", capabilities: { "llm.chat": {} } },
  ] });
  assert.deepEqual(catalog[0], {
    model: "img-1",
    type: "image",
    metadata: { media_type: "image", operations: ["image.generate"], pricing: { unit: "x" } },
  });
  assert.equal(catalog[1].type, "llm");
  assert.deepEqual(legacy.parseModelCatalog("openai", { data: { data: [{ id: "z" }] } }).map((i) => i.model), ["z"]);
  assert.equal(legacy.catalogMediaType({ operations: ["video.text_to_video"] }), "video");
  assert.equal(legacy.catalogMediaType({ operations: ["audio.tts"] }), "audio");
  assert.equal(legacy.catalogOperations({ operations: { a: 1, b: 2 } }).join(","), "a,b");
  assert.equal(legacy.catalogCapabilities({ capabilities: [{ id: "image.generate" }, "llm.chat"] }).join(","), "image.generate,llm.chat");
  assert.equal(legacy.catalogMediaType({}), undefined);
});

test("buildChatRequest：openai/anthropic/gemini 与不支持协议", () => {
  const openai = legacy.buildChatRequest(
    { base_url: "https://api.example.com/v1", api_key: "sk-test", protocol: "openai" },
    "gpt-4o-mini",
    { messages: [{ role: "user", content: "hi" }] },
    { temperature: 0.3, max_tokens: 16 },
  );
  assert.equal(openai.url, "https://api.example.com/v1/chat/completions");
  assert.equal(openai.method, "POST");
  assert.equal(openai.parse, "openai_chat");
  assert.equal(openai.headers.Authorization, "Bearer sk-test");
  assert.equal(openai.headers["Content-Type"], "application/json");
  assert.deepEqual(openai.body, {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    temperature: 0.3,
    max_tokens: 16,
  });

  const anthropic = legacy.buildChatRequest(
    { base_url: "https://api.anthropic.com", api_key: "sk-a", protocol: "anthropic" },
    "claude-3",
    { messages: [{ role: "user", content: "hi" }], system: "sys" },
  );
  assert.equal(anthropic.url, "https://api.anthropic.com/v1/messages");
  assert.equal(anthropic.headers["x-api-key"], "sk-a");
  assert.deepEqual(anthropic.body, {
    model: "claude-3",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    system: "sys",
  });

  const gemini = legacy.buildChatRequest(
    { base_url: "https://generativelanguage.googleapis.com", api_key: "k", protocol: "gemini" },
    "gemini-2.0-flash",
    { prompt: "hi" },
  );
  assert.equal(gemini.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent");
  assert.equal(gemini.parse, "gemini_text");
  assert.deepEqual(gemini.body, { contents: [{ parts: [{ text: "hi" }] }] });

  // cli:* 平台协议没有对应模型运行时协议 → 必须明确报错，不假装可用
  assert.throws(
    () => legacy.buildChatRequest({ base_url: "https://x", api_key: "k", protocol: "cli:jimeng" }, "m", {}),
    /不支持对话调用/,
  );
  assert.throws(
    () => legacy.buildChatRequest({ base_url: "https://x/v1", api_key: "k", protocol: "openai" }, "m", {}, {}, "image"),
    /不支持能力 image/,
  );
});

test("list* 与 protocolIds：来源为真实表，runnable/内置标记派生", () => {
  assert.equal(legacy.protocolIds().length, 20);
  assert.deepEqual(legacy.protocolIds(), PROVIDER_IDS);
  assert.equal(legacy.listProtocols().length, 20);
  assert.equal(legacy.listProviderProtocols().length, 20);
  // 29 - 4 个内部协议（ollama/apimart-gemini/apimart-claude/apimart-media）= 25
  assert.equal(legacy.listModelProtocols().length, 25);
  assert.equal(legacy.listProtocolDetails().length, 25);
  const openaiProvider = legacy.listProviderProtocols().find((p) => p.id === "openai");
  assert.equal(openaiProvider.runnable, true);
  const detail = legacy.listProviderProtocolDetails().find((p) => p.id === "openai");
  assert.equal(detail.builtin, true);
  assert.equal(detail.origin, "builtin");
  assert.equal(legacy.listModelProtocolDetails().find((p) => p.id === "openai").scope, "model");
});

test("providerRequiresApiKey：ollama/cli:* 免密，其余需要", () => {
  assert.equal(legacy.providerRequiresApiKey("ollama"), false);
  assert.equal(legacy.providerRequiresApiKey("cli:jimeng"), false);
  assert.equal(legacy.providerRequiresApiKey("cli:dreamina-canvas"), false);
  assert.equal(legacy.providerRequiresApiKey("openai"), true);
  assert.equal(legacy.providerRequiresApiKey("agtoken-video"), true);
  assert.equal(legacy.providerRequiresApiKey("ollama-http"), false); // v2 内置 auth.type='none'
});

test("assertRunnableProtocol：未知协议抛错，midjourney 放行（源 :3415-3420）", () => {
  assert.throws(
    () => legacy.assertRunnableProtocol("does-not-exist", "图像生成"),
    /图像生成 协议「does-not-exist」还在待适配，暂时不能直接调用。/,
  );
  assert.doesNotThrow(() => legacy.assertRunnableProtocol("midjourney", "图像生成"));
});

test("provider-protocol-domain：legacy 两行由 legacy-protocols 真实 key 派生且 ported=true", () => {
  assert.deepEqual(domain.LEGACY_MODEL_PROTOCOLS, Object.keys(legacy.PROTOCOLS));
  assert.deepEqual(domain.LEGACY_PROVIDER_PROTOCOLS, Object.keys(legacy.PROVIDER_PROTOCOLS));
  assert.equal(domain.LEGACY_MODEL_PROTOCOLS.length, 29);
  assert.equal(domain.LEGACY_PROVIDER_PROTOCOLS.length, 20, "源实测 20；任务书 19 漏计 cli:dreamina-canvas");
  const table = domain.protocolTable();
  // kling / cli:dreamina-canvas 未被 v2 内置表遮蔽（protocolTable 里 v2 在前，同名 v2 优先——既有行为）。
  const kling = table.find((e) => e.kind === "model" && e.id === "kling");
  assert.ok(kling, "kling 必须在表里");
  assert.equal(kling.engine, "legacy");
  assert.equal(kling.ported, true);
  assert.equal(kling.source, "protocols.ts:281-2568");
  assert.ok(table.some((e) => e.kind === "provider" && e.id === "cli:dreamina-canvas" && e.engine === "legacy" && e.ported === true && e.source === "protocols.ts:2589-2982"));
  assert.ok(domain.LEGACY_NO_KEY_PROTOCOLS.includes("cli:dreamina-canvas"));
  assert.equal(domain.providerRequiresApiKey("ollama"), false);
  assert.equal(domain.providerRequiresApiKey("cli:jimeng"), false);
  assert.equal(domain.providerRequiresApiKey("openai"), true);
  assert.equal(domain.providerRequiresApiKey("agtoken-video"), true);
});

test("normalizeApimartVideoAspectRatio：显式值优先，尺寸按最近比例", () => {
  assert.equal(legacy.normalizeApimartVideoAspectRatio("ADAPTIVE", "1:1"), "adaptive");
  assert.equal(legacy.normalizeApimartVideoAspectRatio(null, "9:16"), "9:16");
  assert.equal(legacy.normalizeApimartVideoAspectRatio(null, "1024x1792"), "9:16");
  assert.equal(legacy.normalizeApimartVideoAspectRatio(null, "1792x1024"), "16:9");
  assert.equal(legacy.normalizeApimartVideoAspectRatio(null, "garbage"), "16:9");
});
