/**
 * 9 条服务商预设的离线验收（纯逻辑 + 对着真实后端逐条做「能用性」断言）。
 *
 * 覆盖：
 *   · 预设表形状：id/name/baseUrl/adapterType/docsUrl/credentialMode/models/notes 齐全且不重不漏；
 *   · 模型 id 与能力口径来自调研（dotted），没有官方清单的只有 Lovart 与 APIMart（modelsSource:"catalog"）；
 *   · 预设 → 表单填充的纯逻辑（名称 / 地址 / adapterType / 凭据形态）；
 *   · 双密钥（Lovart）组合 / 解析 / 校验；
 *   · payload 必带 adapterType（create 与 update），且逐条通过 validateEndpoint + ModelService.createProvider；
 *   · 协议落地：presetProtocolId 与镜像桥 mapProtocol 逐条一致，且 adapterType 解析出的协议
 *     必须真的在 electron/protocol-engine 的协议表里；没落地的必须被标成 pending（不是死预设）。
 *
 * 不联网、不起浏览器：后端校验用内存 fixture。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  PROVIDER_PRESETS,
  PRESET_MODEL_CAPABILITIES,
  combineDualCredential,
  dualCredentialFieldError,
  mapPresetCapabilitiesToModelCapabilities,
  parseDualCredential,
  presetById,
  presetDraftPatch,
  presetModelCapabilities,
  presetProtocolId,
  presetProtocolStatus,
  providerPresetProtocolId,
} from "../src-vue/settings/providerPresets.ts";
import {
  DEFAULT_ADAPTER_TYPE,
  blankProviderDraft,
  buildProviderCreatePayload,
  buildProviderSubmitPayload,
  buildProviderUpdatePayload,
  normalizeAdapterType,
} from "../src-vue/settings/providerFormLogic.ts";
import { MODEL_CAPABILITIES } from "../src-vue/settings/modelCategories.ts";
import { createModelFixture } from "./model-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");

const builtins = require(path.join(ROOT, "electron", "protocol-engine", "builtins.cjs"));
const legacy = require(path.join(ROOT, "electron", "protocol-engine", "legacy-protocols.cjs"));
const domain = require(path.join(ROOT, "electron", "model-domain.cjs"));
const { mapProtocol } = require(path.join(ROOT, "electron", "model-provider-bridge.cjs"));
const openaiAdapter = require(path.join(ROOT, "electron", "provider-adapter.cjs"));
const lovartAdapter = require(path.join(ROOT, "electron", "provider-adapter-lovart.cjs"));

/** 协议宇宙 = legacy 供应商协议 + legacy 模型协议 + v2 内置供应商/模型协议 + 模型协议别名。 */
const PROTOCOL_UNIVERSE = [
  ...builtins.BUILTIN_PROVIDER_PROTOCOLS_V2.map((p) => p.id),
  ...builtins.BUILTIN_MODEL_PROTOCOLS_V2.map((p) => p.id),
  ...Object.keys(legacy.PROVIDER_PROTOCOLS),
  ...Object.keys(legacy.PROTOCOLS),
  ...Object.keys(legacy.MODEL_PROTOCOL_ALIASES),
];
const PROTOCOL_ID_SET = new Set(PROTOCOL_UNIVERSE);

/** 任务下发的 9 条口径（id / baseUrl / adapterType / 凭据形态）：表必须逐条一致。 */
const EXPECTED = [
  { id: "modelscope", baseUrl: "https://api-inference.modelscope.cn/v1", adapterType: "modelscope", credentialMode: "single" },
  { id: "agnes", baseUrl: "https://apihub.agnes-ai.com/v1", adapterType: "agnes", credentialMode: "single" },
  { id: "lovart", baseUrl: "https://lgw.lovart.ai", adapterType: "lovart", credentialMode: "dual" },
  { id: "volcengine", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", adapterType: "volcengine", credentialMode: "single" },
  { id: "deepseek", baseUrl: "https://api.deepseek.com", adapterType: "openai-compatible", credentialMode: "single" },
  { id: "openai", baseUrl: "https://api.openai.com/v1", adapterType: "openai-compatible", credentialMode: "single" },
  { id: "gemini", baseUrl: "https://generativelanguage.googleapis.com", adapterType: "gemini", credentialMode: "single" },
  { id: "anthropic", baseUrl: "https://api.anthropic.com", adapterType: "anthropic", credentialMode: "single" },
  { id: "apimart", baseUrl: "https://api.apimart.ai/v1", adapterType: "apimart", credentialMode: "single" },
];

function draftForPreset(preset) {
  return { ...blankProviderDraft(), ...presetDraftPatch(preset) };
}

/* ══ 1 预设表形状 ══ */

test("① 9 条预设：id 不重不漏，字段齐全，baseUrl / docsUrl 都是合法 https", () => {
  assert.equal(PROVIDER_PRESETS.length, 9, "必须正好 9 条预设");
  assert.deepEqual(
    PROVIDER_PRESETS.map((p) => p.id),
    EXPECTED.map((e) => e.id),
    "顺序与 id 必须与任务口径一致（ModelScope·Agnes·Lovart·火山引擎·DeepSeek·GPT·Gemini·Claude·APIMart）",
  );
  assert.equal(new Set(PROVIDER_PRESETS.map((p) => p.id)).size, 9, "id 不得重复");
  for (const preset of PROVIDER_PRESETS) {
    assert.ok(preset.name.trim().length > 0, preset.id + " 要有名称");
    assert.ok(preset.adapterType.trim().length > 0, preset.id + " 要有 adapterType");
    assert.ok(preset.notes.trim().length > 0, preset.id + " 要有 notes");
    for (const [key, value] of [["baseUrl", preset.baseUrl], ["docsUrl", preset.docsUrl]]) {
      assert.ok(String(value).startsWith("https://"), preset.id + " 的 " + key + " 必须是 https：" + value);
      assert.doesNotThrow(() => new URL(value), preset.id + " 的 " + key + " 不是合法 URL");
    }
    assert.ok(["single", "dual"].includes(preset.credentialMode), preset.id + " credentialMode 只能是 single / dual");
    assert.ok(["official", "catalog"].includes(preset.modelsSource), preset.id + " modelsSource 只能是 official / catalog");
  }
});

test("② baseUrl / adapterType / credentialMode 逐条与任务口径一致", () => {
  for (const expected of EXPECTED) {
    const preset = presetById(expected.id);
    assert.ok(preset, "缺少预设 " + expected.id);
    assert.equal(preset.baseUrl, expected.baseUrl, expected.id + " baseUrl");
    assert.equal(preset.adapterType, expected.adapterType, expected.id + " adapterType");
    assert.equal(preset.credentialMode, expected.credentialMode, expected.id + " credentialMode");
  }
  // Claude 必须走官方 anthropic 协议，不是 OpenAI 兼容绕路。
  assert.equal(presetById("anthropic").adapterType, "anthropic", "Claude 用官方 Messages 协议");
  // 唯一双密钥预设是 Lovart。
  assert.deepEqual(PROVIDER_PRESETS.filter((p) => p.credentialMode === "dual").map((p) => p.id), ["lovart"]);
  assert.equal(presetById("lovart").docsUrl.includes("lovart.notion.site"), true, "Lovart docsUrl 指向官方指南");

  // APIMart：catalog 拉模型 + 官方文档 + 镜像域名写进说明；协议必须真的在协议表里（legacy apimart 或内置 apimart-http）。
  const apimart = presetById("apimart");
  assert.equal(apimart.modelsSource, "catalog", "APIMart 有数百个模型，靠 catalog 拉取，不手抄清单");
  assert.deepEqual([...apimart.models], [], "APIMart 预设不得编造模型清单");
  assert.equal(apimart.docsUrl, "https://docs.apimart.ai/cn");
  assert.match(apimart.notes, /apib\.ai/, "APIMart notes 要写明 apib.ai 是同一家的镜像域名");
  assert.match(apimart.notes, /自动识别/, "APIMart notes 要写明适配器按主机名自动识别");
  assert.match(apimart.notes, /异步任务/, "APIMart notes 要写明图片 / 视频 / 音频是异步任务");
  assert.match(apimart.notes, /过期/, "APIMart notes 要提醒生成链接会过期");
  assert.match(apimart.notes, /出网代理/, "APIMart notes 要写明没有外网代理时先配置模型出网代理");
  assert.equal(presetProtocolId(apimart.adapterType), "apimart", "APIMart 协议 id 就是 apimart（不走 OpenAI 兼容）");
  // 协议落地两条都要查：legacy 供应商协议 apimart，与 v2 内置 apimart-http。
  assert.equal(legacy.PROVIDER_PROTOCOLS.apimart && legacy.PROVIDER_PROTOCOLS.apimart.id, "apimart", "legacy 协议表必须有 apimart");
  assert.equal(legacy.PROVIDER_PROTOCOLS.apimart.models.endpoint, "/v1/models", "legacy apimart 模型清单端点");
  const apimartHttp = builtins.BUILTIN_PROVIDER_PROTOCOLS_V2.find((p) => p.id === "apimart-http");
  assert.ok(apimartHttp, "v2 内置协议表必须有 apimart-http");
  assert.equal(apimartHttp.kind, "provider");
  assert.equal(apimartHttp.models.path, "/v1/models", "apimart-http 默认模型清单端点");
  assert.equal(apimartHttp.auth.type, "bearer", "apimart-http 鉴权是 Bearer");
  assert.match(apimartHttp.summary, /docs\.apimart\.ai/, "apimart-http 的 summary 要带官方文档地址");
  assert.ok(PROTOCOL_ID_SET.has("apimart"), "协议宇宙里必须有 apimart");
});

/* ══ 2 模型清单与能力口径 ══ */

test("③ 模型 id / 能力取自调研：能力值都是 dotted 官方口径，official 必须有清单，catalog 不得编模型", () => {
  assert.deepEqual([...PRESET_MODEL_CAPABILITIES], ["llm.chat", "llm.chat.vision", "image.generate", "image.edit", "video.generate", "audio.tts"]);
  for (const preset of PROVIDER_PRESETS) {
    assert.equal(new Set(preset.models.map((m) => m.id)).size, preset.models.length, preset.id + " 模型 id 不得重复");
    for (const model of preset.models) {
      assert.ok(model.id.trim().length > 0, preset.id + " 模型 id 不能为空");
      for (const cap of model.capabilities) {
        assert.ok(PRESET_MODEL_CAPABILITIES.includes(cap), preset.id + " / " + model.id + " 能力 " + cap + " 不在调研口径里");
      }
    }
    if (preset.modelsSource === "official") {
      assert.ok(preset.models.length > 0, preset.id + " 标记 official 就必须有官方模型清单");
    } else {
      assert.equal(preset.models.length, 0, preset.id + " 标记 catalog 就不能编造模型清单");
      assert.match(preset.notes, /catalog/, preset.id + " catalog 预设要在 notes 里写明来源");
    }
  }
  assert.deepEqual(PROVIDER_PRESETS.filter((p) => p.modelsSource === "catalog").map((p) => p.id), ["lovart", "apimart"]);
  // 调研的能力 → 模型域能力枚举，只允许落到真实存在的枚举；音频与 3D 使用原生枚举。
  assert.deepEqual([...domain.CAPABILITIES], [...MODEL_CAPABILITIES]);
  const ALLOWED = new Set(domain.CAPABILITIES);
  for (const preset of PROVIDER_PRESETS) {
    for (const cap of presetModelCapabilities(preset)) assert.ok(ALLOWED.has(cap), preset.id + " 映射出的能力 " + cap + " 不是模型域枚举");
    for (const model of preset.models) {
      for (const cap of mapPresetCapabilitiesToModelCapabilities(model.capabilities)) assert.ok(ALLOWED.has(cap), preset.id + " 单模型映射越界：" + cap);
    }
  }
  assert.deepEqual(mapPresetCapabilitiesToModelCapabilities(["audio.tts"]), ["audio-generation"]);
  assert.deepEqual(mapPresetCapabilitiesToModelCapabilities(["llm.chat.vision", "image.edit"]), ["chat", "vision-input", "image-generation"]);
});

/* ══ 3 预设 → 表单填充 ══ */

test("④ 预设 → 表单填充纯逻辑：名称 / 地址 / adapterType / 凭据形态；不建 provider、不写密钥", () => {
  const deepseek = presetById("deepseek");
  assert.deepEqual(presetDraftPatch(deepseek), {
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    adapterType: "openai-compatible",
    credentialMode: "single",
  });
  const lovart = presetById("lovart");
  assert.deepEqual(presetDraftPatch(lovart), {
    displayName: "Lovart",
    baseUrl: "https://lgw.lovart.ai",
    adapterType: "lovart",
    credentialMode: "dual",
  });
  for (const preset of PROVIDER_PRESETS) {
    const draft = draftForPreset(preset);
    assert.equal(draft.displayName, preset.name);
    assert.equal(draft.baseUrl, preset.baseUrl);
    assert.equal(draft.adapterType, preset.adapterType);
    assert.equal(draft.credentialMode, preset.credentialMode);
    const payload = buildProviderCreatePayload(draft);
    assert.equal(payload.displayName, preset.name);
    assert.equal(payload.baseUrl, preset.baseUrl);
    assert.equal(payload.adapterType, preset.adapterType, preset.id + " 预设必须写进 payload.adapterType");
  }
});

/* ══ 4 双密钥 ══ */

test("⑤ 双密钥组合 / 解析 / 校验：JSON 形态锁定，单密钥预设不受影响", () => {
  const combined = combineDualCredential({ accessKey: "ak_123", secretKey: "sk_456" });
  assert.equal(combined, '{"accessKey":"ak_123","secretKey":"sk_456"}', "双密钥 JSON 形态必须锁定");
  assert.deepEqual(parseDualCredential(combined), { accessKey: "ak_123", secretKey: "sk_456" });
  assert.equal(combineDualCredential({ accessKey: "", secretKey: "" }), "", "两把都空 = 不写凭据");
  assert.equal(combineDualCredential({ accessKey: " ak ", secretKey: " sk " }), '{"accessKey":"ak","secretKey":"sk"}');
  assert.equal(parseDualCredential(""), null);
  assert.equal(parseDualCredential("sk-single-secret"), null, "单密钥不是 JSON，不能被当成双密钥");
  assert.deepEqual(parseDualCredential('{"accessKey":"ak"}'), { accessKey: "ak", secretKey: "" }, "只填一把也能解析（是否完整由 dualCredentialFieldError 判）");
  assert.equal(parseDualCredential('{"accessKey":""}'), null, "两把都空 = 非法");
  assert.equal(dualCredentialFieldError({ accessKey: "ak", secretKey: "sk" }), null);
  assert.equal(dualCredentialFieldError({ accessKey: "", secretKey: "" }), null, "都不填 = 不更换凭据");
  assert.match(dualCredentialFieldError({ accessKey: "ak", secretKey: "" }), /一起填写/);
  assert.match(dualCredentialFieldError({ accessKey: "", secretKey: "sk" }), /一起填写/);
});

test("⑤b 双密钥 JSON 与 Lovart 原生适配器契约一致（跨包，只消费不改协议）", () => {
  assert.equal(lovartAdapter.ADAPTER_TYPE, "lovart");
  assert.equal(openaiAdapter.adapterFor("lovart"), lovartAdapter, "adapterFor('lovart') 必须选中 Lovart 实现");
  const secret = combineDualCredential({ accessKey: "ak_1", secretKey: "sk_1" });
  const parsed = lovartAdapter.parseCredential(secret);
  assert.equal(parsed.ok, true, "Lovart 适配器必须能解析界面组合出的凭据：" + JSON.stringify(parsed));
  assert.equal(parsed.accessKey, "ak_1");
  assert.equal(parsed.secretKey, "sk_1");
  assert.deepEqual(parseDualCredential(lovartAdapter.serializeCredential({ accessKey: "ak_2", secretKey: "sk_2" })), { accessKey: "ak_2", secretKey: "sk_2" });
  assert.equal(lovartAdapter.parseCredential("sk-single").ok, false, "单密钥不是合法 Lovart 凭据");
});

test("⑤c 提交装配：create 的凭据随 payload 一次落库（双密钥组合值不能被丢）", () => {
  const secret = combineDualCredential({ accessKey: "ak_1", secretKey: "sk_1" });
  const dualCreate = buildProviderSubmitPayload("create", draftForPreset(presetById("lovart")), secret);
  assert.equal(dualCreate.payload.credentialSecret, secret, "双密钥组合值必须随 provider/create payload 落库");
  assert.equal(dualCreate.payload.adapterType, "lovart");
  assert.equal(dualCreate.credentialSecret, secret);
  const singleCreate = buildProviderSubmitPayload("create", draftForPreset(presetById("deepseek")), "sk-single");
  assert.equal(singleCreate.payload.credentialSecret, "sk-single");
  assert.equal(singleCreate.payload.adapterType, "openai-compatible");
  const noSecret = buildProviderSubmitPayload("create", draftForPreset(presetById("deepseek")), "");
  assert.equal(Object.prototype.hasOwnProperty.call(noSecret.payload, "credentialSecret"), false, "没填密钥就不带 credentialSecret");
  const edit = buildProviderSubmitPayload("edit", { ...draftForPreset(presetById("deepseek")), providerId: "prv_1" }, "sk-single");
  assert.equal(Object.prototype.hasOwnProperty.call(edit.payload, "credentialSecret"), false, "edit 的凭据走 credential/replace，不进 update payload");
  assert.equal(edit.credentialSecret, "sk-single");
});

/* ══ 5 payload 必带 adapterType ══ */

test("⑥ payload 必带 adapterType：create 恒发，update 显式给了才改（缺省沿用原值）", () => {
  const create = buildProviderCreatePayload({ ...blankProviderDraft(), displayName: "x", baseUrl: "https://api.anthropic.com", adapterType: "anthropic" });
  assert.equal(create.adapterType, "anthropic", "create 必须发送 adapterType，否则预设协议不生效");
  assert.equal(Object.prototype.hasOwnProperty.call(create, "adapterType"), true);
  const blank = buildProviderCreatePayload({ ...blankProviderDraft(), displayName: "x", baseUrl: "https://api.deepseek.com" });
  assert.equal(blank.adapterType, DEFAULT_ADAPTER_TYPE);
  assert.equal(normalizeAdapterType(""), DEFAULT_ADAPTER_TYPE);
  assert.equal(normalizeAdapterType("  anthropic "), "anthropic");

  const update = buildProviderUpdatePayload({ ...blankProviderDraft(), providerId: "prv_1", displayName: "x", baseUrl: "https://api.anthropic.com", adapterType: "anthropic" });
  assert.equal(update.adapterType, "anthropic", "update 也要透传 adapterType");
  const noAdapter = buildProviderUpdatePayload({ providerId: "prv_1", displayName: "x", baseUrl: "https://api.anthropic.com", scope: "PERSONAL", allowInsecureHttp: false });
  assert.equal(Object.prototype.hasOwnProperty.call(noAdapter, "adapterType"), false, "没给 adapterType 时必须省略，后端沿用原值（不误改协议）");
});

/* ══ 6 逐条「预设真的能用」 ══ */

test("⑦ 逐条：presetProtocolId 与镜像桥 mapProtocol 一致，且协议真的在协议表里（没落地的必须标 pending）", () => {
  const pending = [];
  for (const preset of PROVIDER_PRESETS) {
    const id = providerPresetProtocolId(preset);
    assert.equal(id, presetProtocolId(preset.adapterType));
    assert.equal(id, mapProtocol(preset.adapterType), preset.id + " 与镜像桥 mapProtocol 不一致");
    const known = PROTOCOL_ID_SET.has(id);
    assert.equal(
      presetProtocolStatus(preset, PROTOCOL_UNIVERSE),
      known ? "available" : "pending",
      preset.id + " 的协议可用性判定与协议表不符",
    );
    if (!known) pending.push(preset.id);
  }
  // 未落地的只允许是「协议由另一包实现」的 Lovart；一旦它落地，这里自动变空。
  // 任何别的预设掉出协议表 = 死预设，这条会红。
  const lovartLanded = PROTOCOL_ID_SET.has("lovart");
  assert.deepEqual(pending, lovartLanded ? [] : ["lovart"], "除 Lovart 外不得有未落地协议的预设；当前 pending=" + JSON.stringify(pending));
  assert.equal(presetProtocolStatus(null, PROTOCOL_UNIVERSE), "unknown");
  assert.equal(presetProtocolStatus(presetById("anthropic"), null), "unknown", "拿不到协议表时如实标 unknown，不假装已注册");
});

test("⑧ 逐条：用预设字段能通过后端校验（validateEndpoint + ModelService.createProvider）", async () => {
  const fixture = await createModelFixture({ timeoutMs: 1500 });
  try {
    const admin = fixture.adminCtx();
    const context = { sessionRef: admin.sessionRef, appId: "ai" };
    fixture.modelService.grantAppModelAccess({ context: admin, appId: "ai", actions: ["model.view", "model.use", "model.manage", "model.test"] });
    for (const preset of PROVIDER_PRESETS) {
      const payload = buildProviderCreatePayload(draftForPreset(preset));
      const endpoint = domain.validateEndpoint(payload.baseUrl, { allowInsecureHttp: payload.allowInsecureHttp });
      assert.equal(endpoint.ok, true, preset.id + " baseUrl 被 validateEndpoint 拒绝：" + JSON.stringify(endpoint));
      const created = fixture.modelService.createProvider({ context, ...payload });
      assert.equal(created.ok, true, preset.id + " provider/create 失败：" + JSON.stringify(created));
      assert.equal(created.provider.adapterType, preset.adapterType, preset.id + " 落库 adapterType 不符");
      assert.equal(created.provider.baseUrl.startsWith(new URL(preset.baseUrl).origin), true, preset.id + " 落库 baseUrl 不符");
      assert.equal(created.provider.credentialConfigured, false, preset.id + " 预设不得自动写密钥");
      // payload 形状必须是后端接受的字段集（多出界面字段会被后端忽略，但不能带 identity 字段）。
      for (const key of Object.keys(payload)) {
        assert.ok(["displayName", "baseUrl", "adapterType", "endpointScope", "scope", "allowInsecureHttp", "credentialSecret"].includes(key), preset.id + " payload 出现未登记字段：" + key);
      }
    }
  } finally {
    fixture.close();
  }
});

/* ══ 7 界面接线（防漂移） ══ */

test("⑨ 界面接线：预设区 / 双密钥输入 / adapterType 展示 / 编辑态当前协议，都只在既有组件里", () => {
  const form = stripComments(read("src-vue/settings/ProviderForm.vue"));
  const settings = stripComments(read("src-vue/settings/ModelSettings.vue"));
  const presets = stripComments(read("src-vue/settings/providerPresets.ts"));

  assert.ok(form.includes("PROVIDER_PRESETS") && form.includes("applyPreset"), "表单必须从预设表渲染并支持点选");
  for (const sel of [
    "data-d4-01-presets",
    "data-d4-01-preset=",
    "data-d4-01-preset-selected",
    "data-d4-01-preset-adapter",
    "data-d4-01-preset-mode",
    "data-d4-01-preset-status",
    "data-d4-01-preset-pending",
    "data-d4-01-preset-pending-notice",
    "data-d4-01-preset-docs",
    "data-d4-01-preset-models",
    "data-d4-01-preset-models-catalog",
    "data-d4-01-preset-current-adapter",
    "data-d4-01-provider-adapter",
    "data-d4-01-provider-secret-access",
    "data-d4-01-provider-secret-key",
    "data-d4-01-provider-secret-error",
    "data-d4-01-provider-secret",
  ]) {
    assert.ok(form.includes(sel), "ProviderForm 缺少选择器 " + sel);
  }
  assert.ok(form.includes("combineDualCredential") && form.includes("dualCredentialFieldError"), "双密钥必须走纯逻辑模块");
  assert.ok(form.includes("buildProviderSubmitPayload"), "create/edit 的 payload 装配走纯逻辑（双密钥组合值随 create payload 落库）");
  assert.equal(form.includes("fetch("), false, "ProviderForm 不得调用 fetch");
  assert.equal(/localStorage|sessionStorage/.test(form), false, "ProviderForm 不得写存储");
  assert.equal(/provider\/create|provider\/update/.test(form), false, "表单只组装 payload，发命令归上层");

  assert.ok(settings.includes('import ProviderForm from "./ProviderForm.vue"'), "仍复用同一个 ProviderForm");
  assert.ok(settings.includes(":known-protocols=\"knownProtocols\""), "共享 ProviderForm 要拿到协议表");
  assert.equal((settings.match(/:known-protocols=/g) || []).length, 1, "task-56：添加与编辑共用同一个弹窗表单实例");
  assert.ok(settings.includes("openProviderCreate") && settings.includes("openProviderEdit(current.providerId)"), "添加与编辑都有各自入口");
  assert.ok(settings.includes('providerDialogMode = ref<"create" | "edit">("create")'), "弹窗模式必须显式区分 create/edit");
  assert.ok(settings.includes(':mode="providerDialogMode"'), "共享表单的 mode 由弹窗模式驱动");
  assert.ok(settings.includes(":initial=\"providerDialogMode === 'edit' && current ?"), "编辑模式必须预填当前服务商");
  assert.ok(settings.includes('<DsDialog class="mp2-form-dialog" :open="providerDialogOpen"'), "添加/编辑必须在同一个 DsDialog 内");
  assert.ok(settings.includes('cmd("protocol/list")'), "协议可用性来自运行期 protocol/list");
  assert.ok(settings.includes("adapterType: current.adapterType"), "编辑态把当前协议传给表单（不被预设误改）");
  assert.ok(presets.includes("mapProtocol") === false, "预设模块不复制镜像桥实现，只对齐口径");

  // 载入后不自动应用预设：只有 applyPreset（点击）才写 adapterType。
  assert.equal(/onMounted[\s\S]{0,200}applyPreset/.test(form), false, "挂载时不得自动套预设");
});
