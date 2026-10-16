/**
 * W3 · DX OS server/protocolInference.ts 移植契约测试。
 *
 * 源：DXSRC/server/protocolInference.ts:1-257
 * 覆盖（源分支 → 断言）：
 *   · defaultModelProtocol 每个 if                源 :32-52
 *   · PLATFORM_PROTOCOLS 命中/未命中               源 :54-61
 *   · platformProtocolFromBaseUrl 每个 URL 分支    源 :63-82
 *   · inferByModelName 每种 InferredModelType 关键词分支  源 :100-177
 *   · inferByModelName 供应商协议后置约束          源 :179-226
 *   · inferByModelName 未命中分支 confidence/reasons 结构  源 :175-177
 *   · inferProviderProtocols 结构/customProtocols/归一化   源 :231-257
 *   · hasProtocol 走 legacy 协议表                 源 :28-30
 *   · manifest 输出追加 inferred，既有字段逐字不变
 *
 * 依赖：electron/protocol-engine/legacy-protocols.cjs（并行任务冻结接口）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const inference = require("../electron/protocol-engine/protocol-inference.cjs");
const { createModelManifestService } = require("../electron/model-manifest-service.cjs");
const repository = require("../electron/protocol-engine/repository.cjs");

const { defaultModelProtocol, normalizePlatformProtocol, platformProtocolFromBaseUrl, inferByModelName, inferProviderProtocols, hasProtocol } = inference;

test("defaultModelProtocol：每个 if 分支逐条照搬（源 :32-52）", () => {
  const cases = [
    ["openai-relay", "llm", "openai-relay"],       // :33
    ["aliyun-bailian", "image", "aliyun-bailian"], // :34
    ["fhl-http", "image", "fhl-images"],           // :35
    ["fhl-http", "llm", "openai-chat"],            // :35
    ["agtoken-video", "llm", "openai-chat"],       // :37
    ["agtoken-video", "image", "openai-image"],    // :38
    ["agtoken-video", "video", "agtoken-video"],   // :39
    ["agtoken", "audio", "agtoken-video"],         // :36/:39
    ["zkki-model", "llm", "openai-chat"],          // :41
    ["zkki-model", "image", "zkki-model"],         // :41
    ["zkki", "video", "zkki-model"],               // :41
    ["xai", "audio", "xai"],                       // :42
    ["grok2api", "llm", "grok2api"],               // :43
    ["modelscope", "image", "modelscope"],         // :44
    ["volcengine", "video", "volcengine"],         // :45
    ["volcengine-speech", "llm", "volcengine-speech"], // :46
    ["agnes", "other", "agnes"],                   // :47
    ["v2-unified", "image", "v2-unified"],         // :48
    ["v2-unified", "video", "v2-unified"],         // :48
    ["v2-unified", "llm", "openai-chat"],          // :48 不满足 image/video
    ["openai", "image", "openai-image"],           // :49
    ["openai", "audio", "openai-audio"],           // :50
    ["openai", "llm", "openai-chat"],              // :51
    ["openai", "other", "openai-chat"],            // :51
  ];
  for (const [providerProtocol, type, expected] of cases) {
    assert.equal(defaultModelProtocol(providerProtocol, type), expected, providerProtocol + "/" + type);
  }
});

test("PLATFORM_PROTOCOLS 命中/未命中 + normalizePlatformProtocol（源 :54-61）", () => {
  assert.equal(inference.PLATFORM_PROTOCOLS.size, 14);
  for (const id of ["openai", "openai-relay", "aliyun-bailian", "fhl-http", "xai", "apimart", "agtoken", "zkki", "grok2api", "agnes", "modelscope", "volcengine", "volcengine-speech", "runninghub"]) {
    assert.ok(inference.PLATFORM_PROTOCOLS.has(id), "应命中 " + id);
  }
  assert.equal(inference.PLATFORM_PROTOCOLS.has("nonsense"), false);

  // raw 直接命中（源 :58）
  assert.equal(normalizePlatformProtocol("openai"), "openai");
  assert.equal(normalizePlatformProtocol("volcengine-speech"), "volcengine-speech");
  // raw 未命中 → normalizeProtocol 归一后命中（源 :59-60）
  assert.equal(normalizePlatformProtocol("openai-http"), "openai");
  // 两级都未命中 → 回退 openai（源 :60）
  assert.equal(normalizePlatformProtocol("totally-unknown"), "openai");
  assert.equal(normalizePlatformProtocol("gemini"), "openai");
  assert.equal(normalizePlatformProtocol(""), "openai");
});

test("platformProtocolFromBaseUrl：每个 URL 分支（源 :63-82）", () => {
  const cases = [
    ["", "openai-relay", "openai-relay", 99, "已选择 OpenAI 中转平台协议"],                       // :65
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "openai", "aliyun-bailian", 99, "Base URL 命中阿里云百炼 OpenAI 兼容端点"], // :66
    ["https://fhl.mom/v1", "openai", "fhl-http", 99, "Base URL 命中 FHL 图片平台"],               // :67
    ["", "xai", "xai", 99, "已选择 Grok 官方协议"],                                               // :68
    ["", "grok2api", "grok2api", 98, "已选择 Grok2API 网关协议"],                                 // :69
    ["https://agtoken.vip/api", "openai", "agtoken", 98, "Base URL 命中 AGToken 视频平台"],       // :70
    ["https://api.zkki.net/v1", "openai", "zkki", 98, "Base URL 命中 ZKKI 平台"],                 // :71
    ["https://api-inference.modelscope.cn/v1", "openai", "modelscope", 96, "Base URL 命中 ModelScope 推理平台"], // :72
    ["https://openspeech.bytedance.com/api", "openai", "volcengine-speech", 99, "Base URL 命中豆包语音服务"], // :73
    ["https://ark.cn-beijing.volces.com/api/v3", "openai", "volcengine", 98, "Base URL 命中火山方舟平台"], // :74
    ["https://apihub.agnes-ai.com/v1", "openai", "agnes", 96, "Base URL 命中 Agnes AI 平台"],     // :75
    ["https://api.apimart.ai/v1", "openai", "apimart", 92, "Base URL 命中已知异步聚合平台"],       // :76
    ["https://api.openai.com/v1", "openai", "openai", 65, "Base URL 命中 OpenAI v1 形状"],        // :77
    ["https://generativelanguage.googleapis.com/v1beta", "openai", "openai", 45, "Base URL 命中厂商特征，厂商差异按模型协议处理"], // :78-80
    ["https://example.com/anything", "openai", "openai", 35, "未命中明显站点形态，沿用当前站点协议"], // :81
  ];
  for (const [baseUrl, fallback, protocol, confidence, reason] of cases) {
    const got = platformProtocolFromBaseUrl(baseUrl, fallback);
    assert.deepEqual(got, { protocol, confidence, reason }, baseUrl + " / " + fallback);
  }
});

test("inferByModelName：每种 InferredModelType 关键词分支（源 :100-177）", () => {
  const cases = [
    // audio 专属平台
    { model: "doubao-seed-tts-2.0", pp: "volcengine-speech", type: "audio", caps: ["audio"], protocol: "volcengine-speech", confidence: 100, reason: "模型名命中豆包语音合成或声音复刻 2.0" },
    { model: "seed-audio-1.0", pp: "volcengine-speech", type: "audio", caps: ["audio"], protocol: "volcengine-speech", confidence: 100, reason: "模型名命中豆包音频生成 1.0" },
    // volcengine 图片/视频
    { model: "doubao-seedream-5.0", pp: "volcengine", type: "image", caps: ["image"], protocol: "volcengine", confidence: 98, reason: "模型名命中火山 Seedream 图片模型" },
    { model: "doubao-seedance-2.0", pp: "volcengine", type: "video", caps: ["video"], protocol: "volcengine", confidence: 98, reason: "模型名命中火山 Seedance 视频模型" },
    // xai / grok2api
    { model: "grok-imagine-image", pp: "xai", type: "image", caps: ["image"], protocol: "xai", confidence: 99, reason: "模型名命中 Grok 官方图片模型" },
    { model: "grok-imagine-video", pp: "xai", type: "video", caps: ["video"], protocol: "xai", confidence: 99, reason: "模型名命中 Grok 官方视频模型" },
    { model: "grok-4", pp: "xai", type: "llm", caps: ["llm"], protocol: "xai", confidence: 98, reason: "模型名命中 Grok 官方文本模型" },
    { model: "grok-imagine-image", pp: "grok2api", type: "image", caps: ["image"], protocol: "grok2api", confidence: 96, reason: "模型名命中 Grok2API 图片模型" },
    { model: "grok-imagine-video", pp: "grok2api", type: "video", caps: ["video"], protocol: "grok2api", confidence: 96, reason: "模型名命中 Grok2API 视频模型" },
    { model: "grok-voice", pp: "grok2api", type: "audio", caps: ["audio"], protocol: "grok2api", confidence: 96, reason: "模型名命中 Grok2API 语音模型" },
    { model: "grok-4", pp: "grok2api", type: "llm", caps: ["llm"], protocol: "grok2api", confidence: 92, reason: "模型名命中 Grok2API 对话模型" },
    // apimart 特例
    { model: "gpt-4o-mini-tts", pp: "apimart", type: "audio", caps: ["audio"], protocol: "apimart", confidence: 100, reason: "模型名精确命中 APIMart 官方 TTS 模型" },
    { model: "gpt-4o-mini-audio-preview", pp: "apimart", type: "llm", caps: ["llm"], protocol: "apimart", confidence: 100, reason: "APIMart Audio Preview 是对话预览模型，不是 audio/speech TTS 模型" },
    { model: "internal-tts-model", pp: "apimart", type: "other", caps: ["other"], protocol: "apimart", confidence: 98, reason: "APIMart 官方 TTS 当前未声明支持该模型" },
    // other：embedding
    { model: "text-embedding-3-small", pp: "openai", type: "other", caps: ["embedding"], protocol: "openai-embedding", confidence: 90, reason: "模型名命中 embedding" },
    // audio：stt / tts / music
    { model: "whisper-1", pp: "openai", type: "audio", caps: ["audio"], protocol: "openai-audio", confidence: 88, reason: "模型名命中语音转写" },
    { model: "tts-1", pp: "openai", type: "audio", caps: ["audio"], protocol: "openai-audio", confidence: 85, reason: "模型名命中语音合成" },
    { model: "suno-v3", pp: "openai", type: "audio", caps: ["audio"], protocol: "suno", confidence: 88, reason: "模型名命中音乐生成" },
    // video：kling/pixverse/pika/vidu
    { model: "kling-v1", pp: "openai", type: "video", caps: ["video"], protocol: "kling", confidence: 90, reason: "模型名命中 Kling/可灵" },
    { model: "pixverse-v3", pp: "openai", type: "video", caps: ["video"], protocol: "pixverse", confidence: 90, reason: "模型名命中 PixVerse" },
    { model: "pika-1", pp: "openai", type: "video", caps: ["video"], protocol: "pika", confidence: 90, reason: "模型名命中 Pika" },
    { model: "vidu-v1", pp: "openai", type: "video", caps: ["video"], protocol: "vidu", confidence: 90, reason: "模型名命中 Vidu" },
    // minimax 三种分支
    { model: "minimax-image-01", pp: "openai", type: "image", caps: ["image"], protocol: "openai-image", confidence: 90, reason: "模型名命中 MiniMax 图片模型" },
    { model: "image-minimax-01", pp: "openai", type: "image", caps: ["image"], protocol: "openai-image", confidence: 90, reason: "模型名命中 MiniMax 图片模型" },
    { model: "minimax-m2", pp: "openai", type: "llm", caps: ["llm"], protocol: "minimax", confidence: 96, reason: "模型名命中 MiniMax M2/M3 文本模型" },
    { model: "minimax-abab6", pp: "openai", type: "video", caps: ["video"], protocol: "minimax", confidence: 86, reason: "模型名命中 MiniMax/海螺" },
    // wan
    { model: "wanx-v1", pp: "openai", type: "video", caps: ["video"], protocol: "wanxiang", confidence: 84, reason: "模型名命中通义万相/Wan" },
    { model: "qwen-image", pp: "openai", type: "image", caps: ["image"], protocol: "wanxiang", confidence: 84, reason: "模型名命中通义万相/Wan" },
    // 通用视频
    { model: "sora-2", pp: "openai", type: "video", caps: ["video"], protocol: "v2-unified", confidence: 76, reason: "模型名命中视频生成" },
    // 图像（含 Gemini 三分支）
    { model: "flux-1.1", pp: "openai", type: "image", caps: ["image"], protocol: "openai-image", confidence: 82, reason: "模型名命中图像生成" },
    { model: "gemini-2.5-flash-image", pp: "openai", baseUrl: "", type: "image", caps: ["image"], protocol: "gemini-image", confidence: 82, reason: "模型名命中图像生成" },
    { model: "gemini-2.5-flash-image", pp: "openai", baseUrl: "https://ai.comfly.org", type: "image", caps: ["image"], protocol: "gemini-generations", confidence: 82, reason: "模型名命中图像生成" },
    { model: "gemini-2.5-flash-image", pp: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta", type: "image", caps: ["image"], protocol: "gemini-image", confidence: 82, reason: "模型名命中图像生成" },
    { model: "imagen-3.0", pp: "openai", type: "image", caps: ["image"], protocol: "openai-image", confidence: 82, reason: "模型名命中图像生成" },
    // llm
    { model: "claude-sonnet-4", pp: "openai", type: "llm", caps: ["llm"], protocol: "anthropic-chat", confidence: 85, reason: "模型名命中 Claude" },
    { model: "gemini-2.5-pro", pp: "openai", type: "llm", caps: ["llm"], protocol: "gemini-chat", confidence: 80, reason: "模型名命中 Gemini" },
    { model: "deepseek-chat", pp: "openai", type: "llm", caps: ["llm"], protocol: "openai-chat", confidence: 72, reason: "模型名命中 LLM" },
  ];
  for (const c of cases) {
    const got = inferByModelName(c.model, c.pp, c.baseUrl || "");
    const label = c.model + " @ " + c.pp + (c.baseUrl ? " (" + c.baseUrl + ")" : "");
    assert.equal(got.type, c.type, label + " type");
    assert.deepEqual(got.caps, c.caps, label + " caps");
    assert.equal(got.protocol, c.protocol, label + " protocol");
    assert.equal(got.confidence, c.confidence, label + " confidence");
    assert.ok(got.reasons.includes(c.reason), label + " reasons 应包含 " + c.reason + "，实际 " + JSON.stringify(got.reasons));
  }
});

test("inferByModelName：供应商协议后置约束（源 :179-226）", () => {
  const cases = [
    { model: "gpt-image-1", pp: "fhl-http", type: "image", caps: ["image"], protocol: "fhl-images", confidence: 82, reason: "FHL 图片模型统一绑定独立的 Agent 图片协议" },
    { model: "totally-unknown", pp: "openai-relay", type: "llm", caps: ["llm"], protocol: "openai-relay", confidence: 96, reason: "OpenAI 中转平台统一使用 Images Generations JSON 媒体协议" },
    { model: "claude-3", pp: "aliyun-bailian", type: "llm", caps: ["llm"], protocol: "aliyun-bailian", confidence: 85, reason: "阿里云百炼模型统一使用业务空间 OpenAI 兼容协议" },
    { model: "flux-1", pp: "modelscope", type: "image", caps: ["image"], protocol: "modelscope", confidence: 82, reason: "ModelScope 模型统一使用原生异步图片/兼容对话协议" },
    { model: "deepseek-v3", pp: "volcengine", type: "llm", caps: ["llm"], protocol: "volcengine", confidence: 72, reason: "火山方舟模型统一使用兼容对话、Seedream 图片或 Seedance 视频协议" },
    { model: "anything", pp: "volcengine-speech", type: "audio", caps: ["audio"], protocol: "volcengine-speech", confidence: 45, reason: "豆包语音模型统一使用 X-Api-Key 官方语音协议" },
    { model: "flux-1", pp: "agnes", type: "image", caps: ["image"], protocol: "agnes", confidence: 82, reason: "Agnes 模型统一使用原生图片/视频和兼容对话协议" },
    { model: "deepseek", pp: "agtoken", type: "llm", caps: ["llm"], protocol: "openai-chat", confidence: 96, reason: "AGToken 只绑定模型协议，不覆盖模型家族判断出的类别" },
    { model: "flux-1", pp: "agtoken-video", type: "image", caps: ["image"], protocol: "openai-image", confidence: 96, reason: "AGToken 只绑定模型协议，不覆盖模型家族判断出的类别" },
    { model: "omni-1", pp: "zkki", type: "video", caps: ["video"], protocol: "zkki-model", confidence: 96, reason: "ZKKI 只绑定模型协议，不覆盖模型家族判断出的类别" },
    { model: "flux-1", pp: "zkki", type: "image", caps: ["image"], protocol: "zkki-model", confidence: 96, reason: "ZKKI 只绑定模型协议，不覆盖模型家族判断出的类别" },
  ];
  for (const c of cases) {
    const got = inferByModelName(c.model, c.pp, "");
    const label = c.model + " @ " + c.pp;
    assert.equal(got.type, c.type, label + " type");
    assert.deepEqual(got.caps, c.caps, label + " caps");
    assert.equal(got.protocol, c.protocol, label + " protocol");
    assert.equal(got.confidence, c.confidence, label + " confidence");
    assert.ok(got.reasons.includes(c.reason), label + " reasons");
  }
});

test("inferByModelName：未命中分支 confidence/reasons 结构（源 :175-177）", () => {
  const unknown = inferByModelName("totally-unknown-xyz", "openai", "");
  assert.deepEqual(unknown, {
    model: "totally-unknown-xyz", type: "llm", caps: ["llm"], protocol: "openai-chat", confidence: 45,
    reasons: ["未命中模型名规则，按默认 LLM 处理"],
  });

  // ZKKI 视频后置判定会移除“未命中”占位理由（源 :213-217）
  const zkkiOmni = inferByModelName("omni-1", "zkki", "");
  assert.deepEqual(zkkiOmni.reasons, ["ZKKI 只绑定模型协议，不覆盖模型家族判断出的类别"]);
  assert.equal(zkkiOmni.type, "video");
  assert.deepEqual(zkkiOmni.caps, ["video"]);
  assert.equal(zkkiOmni.protocol, "zkki-model");
  assert.equal(zkkiOmni.confidence, 96);

  // 模型对象形状（源 :6-13）
  assert.deepEqual(Object.keys(unknown).sort(), ["caps", "confidence", "model", "protocol", "reasons", "type"]);
});

test("inferProviderProtocols：结构/置信度/customProtocols/归一化（源 :231-257）", () => {
  const a = inferProviderProtocols({ baseUrl: "https://api.anthropic.com", protocol: "openai", models: ["claude-sonnet-4", "gpt-4o"] });
  assert.equal(a.providerProtocol, "openai");
  assert.equal(a.providerProtocolSuggestion, "openai");
  assert.equal(a.confidence, 45);
  assert.deepEqual(a.reasons, ["Base URL 命中厂商特征，厂商差异按模型协议处理"]);
  assert.deepEqual(a.models.map((m) => m.model), ["claude-sonnet-4", "gpt-4o"]);
  assert.deepEqual(a.customProtocols, ["anthropic-chat", "openai-chat"]);

  // 模型协议 === providerProtocol → 归一化为 ''（源 :245-248）
  const b = inferProviderProtocols({ baseUrl: "https://api.x.ai/v1", protocol: "xai", models: ["grok-4"] });
  assert.equal(b.providerProtocol, "xai");
  assert.equal(b.confidence, 99);
  assert.equal(b.models[0].protocol, "");
  assert.equal(b.models[0].type, "llm");
  assert.deepEqual(b.customProtocols, []);

  // asyncScore → confidence：video/audio 平均分（源 :240-242,252）
  const c = inferProviderProtocols({ baseUrl: "https://apihub.agnes-ai.com/v1", protocol: "openai", models: ["sora-2", "whisper-1", "gpt-4o"] });
  assert.equal(c.providerProtocol, "agnes");
  assert.equal(c.confidence, 96); // max(平台 96, round((76+88)/3)=55)
  assert.equal(c.models[0].type, "video");
  assert.deepEqual(c.models[1].caps, ["audio"]);
  assert.deepEqual(c.customProtocols, []);

  // canonicalAgentProviderProtocol：FHL Base URL 强制 fhl-http（源 :236）
  const d = inferProviderProtocols({ baseUrl: "https://fhl.mom", protocol: "openai", models: ["gpt-image-1"] });
  assert.equal(d.providerProtocol, "fhl-http");
  assert.equal(d.confidence, 99);
  assert.equal(d.models[0].protocol, "fhl-images");
  assert.deepEqual(d.customProtocols, ["fhl-images"]);

  // 去重 + trim + 过滤空（源 :238）
  const e = inferProviderProtocols({ baseUrl: "", protocol: "openai", models: [" gpt-4o ", "gpt-4o", "", "  "] });
  assert.equal(e.models.length, 1);
  assert.equal(e.confidence, 35);
  assert.deepEqual(e.reasons, ["未命中明显站点形态，沿用当前站点协议"]);

  // 空输入（源 :238,252）
  const f = inferProviderProtocols({ baseUrl: "https://example.com", protocol: "openai", models: [] });
  assert.deepEqual(f.models, []);
  assert.deepEqual(f.customProtocols, []);
  assert.equal(f.confidence, 35);
});

test("hasProtocol：经 normalizeProtocolId 判定 legacy 表 + v2 模型仓库（源 :28-30、protocols.ts:3389-3392）", () => {
  assert.equal(hasProtocol("openai"), true);
  assert.equal(hasProtocol("openai-chat"), true);
  assert.equal(hasProtocol("openai-embedding"), true);
  // 源 protocols.ts:3391 normalizeProtocolId 第四项 getProtocolV2('model', key)：v2 内置模型协议同样命中
  assert.equal(hasProtocol("openai-images"), true);
  assert.equal(hasProtocol("fhl-images"), true);
  assert.equal(hasProtocol("does-not-exist"), false);
});

test("manifest：inferred 字段并入且既有字段逐字不变", () => {
  const service = createModelManifestService({ repository });
  const base = service.getManifest({ protocolId: "openai-images", model: "gpt-image-1", intent: "image.generate" });
  assert.equal(base.ok, true);
  assert.equal(base.operation.path, "/v1/images/generations");
  // 既有字段集合不变，仅额外追加 inferred（缺省用 protocolId 作供应商协议输入）
  const { inferred: baseInferred, ...baseFields } = base;
  assert.deepEqual(Object.keys(baseFields).sort(), ["format", "intent", "manifest", "model", "ok", "operation", "parameterSchema", "protocolHash", "protocolId", "protocolVersion"]);
  assert.deepEqual(base.parameterSchema.fields.map((field) => field.key), ["size", "quality"]);
  assert.equal(baseInferred.providerProtocol, "openai");
  assert.equal(baseInferred.models[0].protocol, "openai-image");
  assert.deepEqual(baseInferred.customProtocols, ["openai-image"]);

  const enhanced = service.getManifest({
    protocolId: "openai-images", model: "gpt-image-1", intent: "image.generate",
    baseUrl: "https://fhl.mom", providerProtocol: "fhl-http",
  });
  assert.equal(enhanced.ok, true);
  const { inferred, ...rest } = enhanced;
  assert.deepEqual(rest, baseFields); // 既有字段逐字不变，推断输入只影响 inferred
  assert.equal(inferred.providerProtocol, "fhl-http");
  assert.deepEqual(inferred.reasons, ["Base URL 命中 FHL 图片平台"]);
  assert.equal(inferred.models[0].protocol, "fhl-images");
  assert.deepEqual(inferred.customProtocols, ["fhl-images"]);

  // models 显式列表优先于单个 model
  const multi = service.getManifest({
    protocolId: "openai-images", model: "gpt-image-1", intent: "image.generate",
    providerProtocol: "openai", models: ["gpt-image-1", "sora-2"],
  });
  assert.equal(multi.inferred.models.length, 2);
  assert.deepEqual(multi.inferred.models.map((m) => m.model), ["gpt-image-1", "sora-2"]);

  // 失败分支不带 inferred（既有行为不变）
  const missing = service.getManifest({ protocolId: "does-not-exist", model: "x", intent: "llm.chat" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "PROTOCOL_NOT_FOUND");
  assert.equal(Object.prototype.hasOwnProperty.call(missing, "inferred"), false);
});
