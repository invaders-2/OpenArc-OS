/**
 * 模型规格驱动（后端）：适配器 uiSpec → canvas/models 的 specSource / uiSpec 投影。
 *
 * 覆盖（tasks/model-spec 后端一半）：
 *   ① Lovart 适配器按模型族出 uiSpec，字段与 APIMart 一致且能力布尔显式（search/style/camera/audio/batch）；
 *   ② APIMart 适配器对已知模型给 spec、对未收录模型给最小 guess 规格；
 *   ③ 通用 OpenAI 兼容适配器 uiSpec 返回 null（= 没有规格，只能 guess）；
 *   ④ listModelsForUse：已知模型 specSource='spec' 且 uiSpec 原样透传；未知模型 specSource='guess'；
 *      两者都不泄漏 baseUrl / 凭据。
 *
 * 用真实 ModelService + 适配器（不复制实现）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createModelFixture } from "./model-fixtures.mjs";

const require = createRequire(import.meta.url);
const lovart = require("../electron/provider-adapter-lovart.cjs");
const apimart = require("../electron/provider-adapter-apimart.cjs");
const generic = require("../electron/provider-adapter.cjs");

const BOOLEAN_FLAGS = ["search", "style", "camera", "audio"];
const LOVART_IMAGE = "generate_image_seedream_v5_pro";
const LOVART_VIDEO = "generate_video_seedance_v2_5";
const LOVART_UNKNOWN = "generate_image_totally_new_family";
const APIMART_IMAGE = "gpt-image-2.5";
const APIMART_VIDEO = "seedance-2.5";
const APIMART_UNKNOWN = "brand-new-chat-model";
const GENERIC_CHAT = "gpt-4o";

function assertSpecShape(spec, kind, source) {
  assert.equal(spec.kind, kind);
  assert.equal(spec.capabilitiesSource, source);
  assert.ok(Array.isArray(spec.batch) && spec.batch.length > 0, "batch 必须显式给出（数组）");
  for (const flag of BOOLEAN_FLAGS) assert.equal(typeof spec[flag], "boolean", "能力布尔必须显式：" + flag);
  for (const [key, value] of Object.entries(spec)) {
    if (key === "unsupported" || key === "reason") continue;
    assert.notEqual(value, undefined, "字段不能是 undefined：" + key);
  }
}

test("① Lovart uiSpec：已知族给完整规格，能力布尔显式", () => {
  const image = lovart.uiSpec(LOVART_IMAGE);
  assertSpecShape(image, "image", "spec");
  assert.ok(image.ratios.length > 0 && image.sizes.length > 0, "图片规格要有比例与档位");
  assert.equal(image.sizes.includes("1.5K"), true, "Seedream 5 Pro 支持 1.5K");
  assert.equal(image.batch.length, 1, "Lovart 一次对话一个结果");
  assert.equal(image.maxRefs, 8, "适配器附件上限");
  assert.equal(image.i2i, true);
  // task-27 起：风格 / 摄影机真的会写进 Lovart 提示词 → 图片族标 true；联网仍 false；图片没有音频。
  assert.equal(image.style, true, "风格会进提示词");
  assert.equal(image.camera, true, "摄影机会进提示词");
  assert.equal(image.search, false, "图片链路没有联网能力，不能冒充");
  assert.equal(image.audio, false);

  const video = lovart.uiSpec(LOVART_VIDEO);
  assertSpecShape(video, "video", "spec");
  assert.ok(video.ratios.length > 0 && video.res.length > 0 && video.durs.length > 0 && video.modes.length > 0);
  assert.deepEqual(video.times, [1]);
  assert.equal(video.audio, true, "Seedance 2.5 本身带音轨");
  for (const flag of ["search", "style", "camera"]) assert.equal(video[flag], false);

  // 不带音轨的族如实 false，不靠名字猜
  assert.equal(lovart.uiSpec("generate_video_hailuo_v2_3").audio, false);
  assert.equal(lovart.uiSpec("generate_video_veo3_1_fast").durs.length > 0, true);
  assert.deepEqual(lovart.uiSpec("generate_video_veo3_1_fast").durs, [8], "VEO 3.1 固定 8 秒");

  // 只认得出类别、认不出族：最小 guess 规格（显式 false），完全认不出返回 null
  const guess = lovart.uiSpec(LOVART_UNKNOWN);
  assertSpecShape(guess, "image", "guess");
  assert.equal(lovart.uiSpec("some-unknown-chat-model"), null);
});

test("② APIMart uiSpec：已知模型 spec + 显式能力布尔；未收录模型最小 guess", () => {
  const image = apimart.uiSpec(APIMART_IMAGE);
  assertSpecShape(image, "image", "spec");
  assert.ok(image.ratios.length > 0 && image.sizes.length > 0);
  assert.deepEqual(image.batch, [1, 2, 3, 4], "按模型单次上限给批量选项");
  assert.equal(image.maxRefs, 16);
  assert.equal(image.i2i, true);
  for (const flag of BOOLEAN_FLAGS) assert.equal(image[flag], false, "APIMart 图片出口没有联网 / 风格 / 摄影机 / 音频：" + flag);

  const video = apimart.uiSpec(APIMART_VIDEO);
  assertSpecShape(video, "video", "spec");
  assert.equal(video.audio, true, "Seedance 2.5 支持 generate_audio");
  assert.deepEqual(video.batch, [1]);
  assert.deepEqual(video.times, [1]);

  const excluded = apimart.uiSpec("MiniMax-H3-Context-IR");
  assertSpecShape(excluded, "video", "spec");
  assert.equal(excluded.unsupported, true, "排除族要如实标不能用");

  const guess = apimart.uiSpec(APIMART_UNKNOWN);
  assertSpecShape(guess, "text", "guess");
  assert.equal(guess.search, false);

  // 联网白名单里的模型：text 规格照样标 guess（这是按名单猜的，不是模型族规格）
  const searchModel = apimart.uiSpec("gpt-5.2-pro");
  assert.equal(searchModel.search, true, "文档点名的联网模型");
  assert.equal(searchModel.capabilitiesSource, "guess");
});

test("③ 通用 OpenAI 兼容适配器：uiSpec 返回 null（没有规格可参考）", () => {
  assert.equal(generic.uiSpec(GENERIC_CHAT), null);
  assert.equal(typeof generic.guessCapabilities, "function", "命名的能力推断仍保留，作为最后兜底");
});

test("④ listModelsForUse：specSource + uiSpec 投影（已知 spec / 未知 guess / 不泄漏地址与凭据）", async () => {
  const f = await createModelFixture();
  try {
    const admin = f.adminCtx();
    assert.equal(f.store.upsertApp({ appId: "canvas", name: "无限画布", publisher: "builtin", status: "enabled", builtIn: 1 }).ok !== false, true);
    const grant = f.modelService.grantAppModelAccess({ context: { ...admin, appId: "canvas" }, appId: "canvas", actions: ["model.view", "model.use", "model.manage", "model.test"] });
    assert.equal(grant.ok, true, JSON.stringify(grant));

    const host = { ...admin, appId: "canvas" };
    const providers = {};
    for (const [key, displayName, baseUrl, adapterType, secret] of [
      ["lovart", "Lovart", "https://lgw.lovart.ai", "lovart", JSON.stringify({ accessKey: "ak_spec_test", secretKey: "sk_spec_test" })],
      ["apimart", "APIMart", "https://api.apimart.ai/v1", "apimart", "FAKE_SPEC_TEST_KEY"],
      ["generic", "OpenAI Compatible", "https://api.deepseek.com", "openai-compatible", "FAKE_SPEC_GENERIC"],
    ]) {
      const created = f.modelService.createProvider({ context: host, displayName, baseUrl, adapterType, scope: "ORGANIZATION", credentialSecret: secret });
      assert.equal(created.ok, true, key + " provider: " + JSON.stringify(created));
      providers[key] = created.provider.providerId;
    }

    const createdModels = [];
    for (const [providerKey, remoteModelId, displayName, capabilities] of [
      ["lovart", LOVART_IMAGE, "Seedream 5 Pro (Lovart)", ["image-generation"]],
      ["lovart", LOVART_VIDEO, "Seedance 2.5 (Lovart)", ["video-generation"]],
      ["lovart", LOVART_UNKNOWN, "Mystery Family (Lovart)", ["image-generation"]],
      ["apimart", APIMART_IMAGE, "GPT Image 2.5 (APIMart)", ["image-generation"]],
      ["apimart", APIMART_VIDEO, "Seedance 2.5 (APIMart)", ["video-generation"]],
      ["apimart", APIMART_UNKNOWN, "New Chat (APIMart)", ["chat"]],
      ["generic", GENERIC_CHAT, "GPT-4o (generic)", ["chat"]],
    ]) {
      const created = f.modelService.createModel({ context: host, providerId: providers[providerKey], remoteModelId, displayName, capabilities, scope: "ORGANIZATION" });
      assert.equal(created.ok, true, remoteModelId + " model: " + JSON.stringify(created));
      createdModels.push(created.model.configId);
    }

    const list = f.modelService.listModelsForUse({ context: { ...admin, appId: "canvas" } });
    assert.equal(list.ok, true, JSON.stringify(list));
    const byRemote = new Map(list.models.map((m) => [m.remoteModelId, m]));
    for (const configId of createdModels) assert.ok(list.models.some((m) => m.configId === configId), "列表缺少模型 " + configId);

    const expectSpec = (remoteModelId, kind) => {
      const item = byRemote.get(remoteModelId);
      assert.ok(item, "缺少模型 " + remoteModelId);
      assert.equal(item.specSource, "spec", remoteModelId + " 应为 spec");
      assert.ok(item.uiSpec && typeof item.uiSpec === "object", remoteModelId + " 必须带 uiSpec");
      assertSpecShape(item.uiSpec, kind, "spec");
      return item;
    };
    const expectGuess = (remoteModelId) => {
      const item = byRemote.get(remoteModelId);
      assert.ok(item, "缺少模型 " + remoteModelId);
      assert.equal(item.specSource, "guess", remoteModelId + " 应为 guess");
      if (item.uiSpec) {
        assert.equal(item.uiSpec.capabilitiesSource, "guess", remoteModelId + " 的 uiSpec 不能冒充 spec");
        assert.equal(typeof item.uiSpec.kind, "string");
        for (const flag of BOOLEAN_FLAGS) assert.equal(typeof item.uiSpec[flag], "boolean");
      }
      return item;
    };

    expectSpec(LOVART_IMAGE, "image");
    expectSpec(LOVART_VIDEO, "video");
    expectSpec(APIMART_IMAGE, "image");
    expectSpec(APIMART_VIDEO, "video");
    expectGuess(LOVART_UNKNOWN);
    expectGuess(APIMART_UNKNOWN);
    const genericItem = expectGuess(GENERIC_CHAT);
    assert.equal("uiSpec" in genericItem, false, "没有规格的适配器不投影 uiSpec");

    const dump = JSON.stringify(list);
    for (const leak of ["lgw.lovart.ai", "api.apimart.ai", "api.deepseek.com", "ak_spec_test", "sk_spec_test", "FAKE_SPEC_TEST_KEY", "FAKE_SPEC_GENERIC", "baseUrl", "credentialRef"]) {
      assert.equal(dump.includes(leak), false, "列表泄漏了 " + leak);
    }
  } finally {
    f.close();
  }
});
