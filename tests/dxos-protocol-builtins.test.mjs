/**
 * W1 · dx-protocol/v2 内置协议完整性测试（不联网、不启动 DX OS、不写用户目录）。
 * 覆盖 19 个模型协议 + 15 个供应商协议：
 *   1. validator.validateProtocolV2 全部通过；
 *   2. 每个 workflow 的 submit/poll/download/result 与 modelProfiles 的 workflow/uiSchemas 引用有效；
 *   3. 用内置 openai-http 绑定 + compiler.compileProtocolPlan 编译每个模型协议的每个 workflow。
 * 构造方式参照 tests/dxos-protocol.test.mjs（createRequire + 内置协议表）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const validator = require("../electron/protocol-engine/validator.cjs");
const compiler = require("../electron/protocol-engine/compiler.cjs");
const bindings = require("../electron/protocol-engine/bindings.cjs");
const builtins = require("../electron/protocol-engine/builtins.cjs");

const MODEL_PROTOCOLS = builtins.BUILTIN_MODEL_PROTOCOLS_V2;
const PROVIDER_PROTOCOLS = builtins.BUILTIN_PROVIDER_PROTOCOLS_V2;

/** 源数组顺序（builtins.ts:2399-2715）：openai-images 之后按 xai/minimax 紧跟 gemini 的原顺序。 */
const EXPECTED_MODEL_ORDER = [
  "openai-images",
  "openai-chat-media",
  "comfly-openai",
  "gemini-generations",
  "gpt-best-images",
  "fhl-images",
  "gemini",
  "gemini-general",
  "xai",
  "minimax",
  "agtoken-videos",
  "zkki-images",
  "apimart-images",
  "midjourney",
  "apib-images",
  "modelscope-images",
  "volcengine",
  "volcengine-speech",
  "agnes",
];

/** 最小非空 inputs：编译时所有 {{inputs.*}} 模板都能解析到实体。 */
const MINIMAL_INPUTS = {
  images: [{ dataUrl: "data:image/png;base64,AAAA", mime: "image/png", url: "https://example.com/a.png" }],
  videos: [{ dataUrl: "data:video/mp4;base64,AAAA", mime: "video/mp4", url: "https://example.com/v.mp4" }],
  audios: [{ dataUrl: "data:audio/mpeg;base64,AAAA", mime: "audio/mpeg", url: "https://example.com/a.mp3" }],
  files: [],
};

function openAiHttpProviderProtocol() {
  const entry = bindings.boundProviderProtocolV2({ protocol: "openai", base_url: "https://api.example.com" });
  assert.ok(entry && entry.protocol, "内置 openai-http 绑定必须可解析");
  assert.equal(entry.protocol.id, "openai-http");
  return entry.protocol;
}

/** 为一个 workflow 选一组能命中它的 (profile, intent)；没有 profile 引用时回退到 workflow id 作为 intent。 */
function taskSelector(protocol, workflowId) {
  for (const [profileId, profile] of Object.entries(protocol.modelProfiles || {})) {
    for (const [intent, mapped] of Object.entries(profile.workflows || {})) {
      if (mapped === workflowId) return { model: profileId, intent };
    }
  }
  const firstProfile = Object.keys(protocol.modelProfiles || {})[0];
  return { model: firstProfile || "test-model", intent: workflowId };
}

/** gemini / gemini-general 的 llm.tools 会走 geminiToolDefinitions，必须给数组；其余 protocol 用空 params。 */
function paramsFor(protocol, intent) {
  return (protocol.id === "gemini" || protocol.id === "gemini-general") && intent === "llm.tools" ? { tools: [] } : {};
}

test("内置 v2 协议表：19 个模型 + 15 个供应商，模型协议顺序与源一致且全部 ported:true", () => {
  assert.equal(MODEL_PROTOCOLS.length, 19);
  assert.equal(PROVIDER_PROTOCOLS.length, 15);
  assert.deepEqual(MODEL_PROTOCOLS.map((protocol) => protocol.id), EXPECTED_MODEL_ORDER);

  const modelMeta = builtins.BUILTIN_PROTOCOL_METADATA_V2.filter((entry) => entry.kind === "model");
  assert.equal(modelMeta.length, 19);
  assert.deepEqual(
    modelMeta.filter((entry) => entry.ported !== true).map((entry) => entry.id),
    [],
    "不得存在 ported:false 的模型协议",
  );
  for (const id of EXPECTED_MODEL_ORDER) {
    assert.equal(builtins.getBuiltinProtocolV2("model", id).id, id);
  }
});

test("模型协议导出顺序与源码 builtins.ts:2399-2715 一致，metadata 顺序同步", () => {
  // 源 builtins.ts:2399-2715 的数组逐字顺序：
  //   [openAiImagesProtocol, openAiChatMediaProtocol, comflyOpenAiProtocol, geminiGenerationsProtocol,
  //    gptBestImagesProtocol, fhlImagesProtocol, geminiProtocol, geminiGeneralProtocol, xaiProtocol, minimaxProtocol,
  //    agtokenVideosProtocol, zkkiImagesProtocol, apimartImagesProtocol, midjourneyProtocol,
  //    apibImagesProtocol, modelScopeImagesProtocol, volcengineProtocol, volcengineSpeechProtocol, agnes]
  // 其中 xai / minimax 紧跟 gemini 之后，agtoken-videos 在 zkki-images 之前。
  const SOURCE_ORDER = [
    "openai-images",
    "openai-chat-media",
    "comfly-openai",
    "gemini-generations",
    "gpt-best-images",
    "fhl-images",
    "gemini",
    "gemini-general",
    "xai",
    "minimax",
    "agtoken-videos",
    "zkki-images",
    "apimart-images",
    "midjourney",
    "apib-images",
    "modelscope-images",
    "volcengine",
    "volcengine-speech",
    "agnes",
  ];
  assert.deepEqual(builtins.BUILTIN_MODEL_PROTOCOLS_V2.map((protocol) => protocol.id), SOURCE_ORDER);
  assert.deepEqual(
    builtins.BUILTIN_PROTOCOL_METADATA_V2.filter((entry) => entry.kind === "model").map((entry) => entry.id),
    SOURCE_ORDER,
  );
});

test("向后兼容：builtins 继续导出 openAiImagesProtocol/openAiMultipartImageFields/bearerProvider/imagePoll", () => {
  assert.equal(builtins.openAiImagesProtocol.id, "openai-images");
  assert.equal(typeof builtins.openAiMultipartImageFields, "function");
  assert.equal(typeof builtins.bearerProvider, "function");
  assert.equal(builtins.imagePoll.operation, "image-query");
  assert.equal(builtins.bearerProvider("probe-http", "Probe").schemaVersion, "dx-protocol/v2");
});

test("validator.validateProtocolV2 通过全部 19 个模型协议与 15 个供应商协议", () => {
  for (const protocol of [...PROVIDER_PROTOCOLS, ...MODEL_PROTOCOLS]) {
    const normalized = validator.validateProtocolV2(protocol);
    assert.equal(normalized.id, protocol.id);
    assert.equal(normalized.kind, protocol.kind);
  }
});

test("每个模型 workflow 的 submit/poll/download/result 引用有效，modelProfiles 的 workflow/uiSchemas 存在", () => {
  for (const protocol of MODEL_PROTOCOLS) {
    for (const [workflowId, workflow] of Object.entries(protocol.workflows)) {
      const label = protocol.id + "." + workflowId;
      assert.ok(protocol.operations[workflow.submit], label + " submit 操作必须存在");
      if (workflow.poll) assert.ok(protocol.operations[workflow.poll.operation], label + " poll 操作必须存在");
      if (workflow.download) assert.ok(protocol.operations[workflow.download], label + " download 操作必须存在");
      assert.ok(workflow.result && workflow.result.kind && workflow.result.source, label + " result 引用必须存在");
      for (const upload of workflow.uploads || []) {
        const operation = protocol.operations[upload.operation];
        assert.ok(operation, label + " upload 操作必须存在");
        assert.ok(Object.prototype.hasOwnProperty.call(operation.response || {}, upload.result.source), label + " upload result.source 必须由 operation.response 声明");
      }
    }
    for (const [profileId, profile] of Object.entries(protocol.modelProfiles || {})) {
      const label = protocol.id + "." + profileId;
      assert.ok(profile.capabilities.length > 0, label + " capabilities 不能为空");
      for (const [intent, workflowId] of Object.entries(profile.workflows || {})) {
        assert.ok(protocol.workflows[workflowId], label + " 引用了不存在的 workflow「" + workflowId + "」");
        assert.ok(profile.capabilities.includes(intent), label + " 的 intent「" + intent + "」必须声明在 capabilities");
      }
      for (const schemaId of profile.uiSchemas || []) {
        assert.ok(Object.prototype.hasOwnProperty.call(protocol.uiSchemas || {}, schemaId), label + " 引用了不存在的 uiSchema「" + schemaId + "」");
      }
    }
  }
});

test("每个模型协议的每个 workflow 都能用内置 openai-http 绑定编译成功", () => {
  const providerProtocol = openAiHttpProviderProtocol();
  let compiled = 0;
  for (const protocol of MODEL_PROTOCOLS) {
    for (const workflowId of Object.keys(protocol.workflows)) {
      const { model, intent } = taskSelector(protocol, workflowId);
      const plan = compiler.compileProtocolPlan({
        providerProtocol,
        modelProtocol: protocol,
        baseUrl: "https://api.example.com",
        credential: "FAKE_W1_TEST_KEY",
        task: {
          requestId: "req-" + protocol.id + "-" + workflowId,
          model,
          intent,
          prompt: "ping",
          params: paramsFor(protocol, intent),
          inputs: MINIMAL_INPUTS,
        },
      });
      assert.equal(plan.format, "dx-protocol-plan/v1", protocol.id + "." + workflowId);
      assert.equal(plan.protocol.model, protocol.id);
      assert.equal(plan.workflow, workflowId, protocol.id + "." + workflowId + " 应解析到目标 workflow");
      const submit = plan.steps.find((step) => step.id === "submit");
      assert.ok(submit, protocol.id + "." + workflowId + " 必须有 submit 步骤");
      assert.ok(plan.steps.some((step) => step.id === "submit" && step.operation === protocol.workflows[workflowId].submit));
      if (protocol.workflows[workflowId].poll) assert.ok(plan.steps.some((step) => step.id === "poll"));
      if (protocol.workflows[workflowId].download) assert.ok(plan.steps.some((step) => step.id === "download"));
      compiled += 1;
    }
  }
  assert.ok(compiled >= 100, "应覆盖 100+ 个 workflow，实际 " + compiled);
});
