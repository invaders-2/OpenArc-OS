/**
 * UI-5 · 模型与协议控制台契约单测（纯逻辑，不启动浏览器、不依赖 DOM 渲染库）。
 *
 * 测的是 src/settings/modelProtocolLogic.ts 这一份**界面真正在用**的规则：
 *   · 命令白名单是 electron/model-bootstrap.cjs#MODEL_COMMANDS 的子集（逐条，不多不少）
 *   · protocol/list 的投影、kind 过滤、搜索、行状态、真实字段（缺字段标"未返回"）
 *   · protocol/get 的"声明情况"（操作 / 工作流 / 模型 profile / uiSchemas / capabilities）
 *   · manifest/get 的子集投影：parameterSchema / limits 真实展示，assets 与 modelProfiles
 *     如实标注"未返回"（后端这两个字段确实不在回包里，禁止补造）
 *   · 流式状态机：排队→开始→增量→用量→结束 / 错误 / 停止；P1 信封 sequence 单调与缺口
 *   · 无可用 provider 时的结构化说明（不造假数据）
 *   · 界面源码边界（不 fetch、不写 localStorage、不直连端口、不改既有 d401 区块、不新增 token）
 *
 * 真实数据来源：测试直接 require 主进程的 protocol-engine repository / manifest service
 * 与 ProviderProtocolService（store 用桩），拿到**与 IPC 完全相同**的 listProtocols /
 * getProtocol / getManifest 输出，再喂给界面投影函数。离线、不联网。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  MODEL_CONSOLE_COMMANDS,
  MODEL_ENTRIES,
  MODEL_ENTRY_INPUT_LABEL,
  MODEL_ENTRY_KEYS,
  MODEL_ENTRY_MISSING_CREDENTIAL_TEXT,
  MODEL_ENTRY_REQUIRED_INPUTS,
  MODEL_ENTRY_RISK_LABEL,
  MODEL_ENTRY_RISK_TEXT,
  MODEL_IDENTITY_PAYLOAD_KEYS,
  MODEL_PROTOCOL_COMMANDS,
  MODEL_SETTINGS_EXISTING_COMMANDS,
  MODEL_PROTOCOL_ERROR_TEXT,
  PROTOCOL_KIND_ALL,
  STREAM_FLUSH_INTERVAL_MS,
  STREAM_PHASES,
  beginStream,
  buildProtocolPayload,
  createStreamBuffer,
  describeManifest,
  describeProtocolDetail,
  filterProtocols,
  isAllowedModelCommand,
  isModelEvent,
  missingFieldsText,
  modelEntryAvailability,
  modelEntryConfirmText,
  modelEntryConfirmTitle,
  modelEntryMeta,
  modelEntryMissingInputs,
  modelEntryNeedsConfirm,
  modelEntryRiskText,
  modelProtocolErrorState,
  modelProtocolErrorText,
  normalizeProtocolResult,
  payloadHasIdentityField,
  protocolCapabilitiesText,
  protocolFacts,
  protocolKindLabel,
  protocolKindOptions,
  protocolKey,
  protocolListState,
  protocolRowStatus,
  reduceModelStreamEvent,
  requestStreamStop,
  settleStream,
  streamAvailability,
  streamGapText,
  streamInitialState,
  streamPhaseFeedback,
  streamSequenceText,
} from "../src/settings/modelProtocolLogic.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");

const modelBootstrap = require(path.join(ROOT, "electron", "model-bootstrap.cjs"));
const repository = require(path.join(ROOT, "electron", "protocol-engine", "repository.cjs"));
const { ProviderProtocolService } = require(path.join(ROOT, "electron", "provider-protocol-service.cjs"));
const manifestService = require(path.join(ROOT, "electron", "model-manifest-service.cjs")).createModelManifestService({ repository });
const customProtocolStore = require(path.join(ROOT, "electron", "protocol-engine", "legacy-custom-protocol-store.cjs"));

/** 与 IPC 同一份实现：协议表 / 协议详情 / manifest 都走主进程服务本体，store 用桩。 */
const service = new ProviderProtocolService({ store: { get: () => null } });
service.manifest = manifestService;

/* ══════════════════════════════════════════════════════════════════════════
   1 命令白名单
   ══════════════════════════════════════════════════════════════════════════ */
test("UI-5 命令逐条落在 electron/model-bootstrap.cjs 的 MODEL_COMMANDS 内", () => {
  const backend = modelBootstrap.MODEL_COMMANDS;
  assert.equal(MODEL_PROTOCOL_COMMANDS.length, 8, "UI-5 区块共 8 条命令（4 只读/流式 + 4 动作入口）");
  for (const c of MODEL_PROTOCOL_COMMANDS) {
    assert.ok(backend.includes(c), c + " 必须是后端白名单命令");
  }
  assert.deepEqual(
    [...MODEL_PROTOCOL_COMMANDS],
    [
      "protocol/list", "protocol/get", "manifest/get", "provider/callStream",
      "protocol/validate", "protocol/save", "image/generate", "protocol/execute",
    ],
    "命令集合与顺序必须与文档一致",
  );
});

test("整页白名单是后端命令表的子集，且不重复", () => {
  const backend = modelBootstrap.MODEL_COMMANDS;
  const set = new Set(MODEL_CONSOLE_COMMANDS);
  assert.equal(set.size, MODEL_CONSOLE_COMMANDS.length, "白名单不得重复");
  for (const c of MODEL_CONSOLE_COMMANDS) assert.ok(backend.includes(c), c + " 越界");
  /* 既有区块已在用的命令必须全部保留，否则会误判既有页面越权。 */
  for (const c of MODEL_SETTINGS_EXISTING_COMMANDS) assert.ok(MODEL_CONSOLE_COMMANDS.includes(c), c + " 既有命令缺失");
});

test("isAllowedModelCommand 拒绝未登记命令与非法类型", () => {
  assert.equal(isAllowedModelCommand("protocol/list"), true);
  assert.equal(isAllowedModelCommand("provider/callStream"), true);
  assert.equal(isAllowedModelCommand("protocol/delete"), false);
  assert.equal(isAllowedModelCommand("provider/call"), false);
  assert.equal(isAllowedModelCommand(""), false);
  assert.equal(isAllowedModelCommand(undefined), false);
  assert.equal(isAllowedModelCommand(123), false);
  assert.equal(isAllowedModelCommand("__proto__"), false);
});

test("载荷按键白名单构造：身份字段与未登记键一律丢弃", () => {
  const payload = buildProtocolPayload("manifest/get", {
    protocolId: "openai-images",
    model: "gpt-image",
    intent: "image.generate",
    userId: "u_1",
    role: "ADMIN",
    sessionRef: "s_1",
    appId: "settings",
    secret: "sk-should-not-pass",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(Object.keys(payload).sort(), ["intent", "model", "protocolId"]);
  assert.equal(payloadHasIdentityField(payload), false, "过滤后不应再含身份字段");
  assert.equal(payloadHasIdentityField({ userId: "u_1" }), true);
  assert.equal(payloadHasIdentityField({ nope: 1 }), false);
  assert.deepEqual(MODEL_IDENTITY_PAYLOAD_KEYS, ["userId", "role", "sessionRef", "appId"]);
  const streamPayload = buildProtocolPayload("provider/callStream", {
    providerId: "p",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    requestId: "r",
    secret: "x",
  });
  assert.deepEqual(Object.keys(streamPayload).sort(), ["messages", "model", "providerId", "requestId"]);
  assert.equal(streamPayload.messages[0].content, "hi");
  assert.deepEqual(buildProtocolPayload("unknown/command", { a: 1 }), {}, "未登记命令没有任何允许键");

  /* UI-5b 动作入口：按键白名单构造，secret / 身份字段一律丢。 */
  const validate = buildProtocolPayload("protocol/validate", { protocol: { id: "x" }, secret: "sk", userId: "u" });
  assert.deepEqual(Object.keys(validate), ["protocol"]);
  const save = buildProtocolPayload("protocol/save", { kind: "model", protocol: { id: "x" }, secret: "sk" });
  assert.deepEqual(Object.keys(save).sort(), ["kind", "protocol"]);
  const image = buildProtocolPayload("image/generate", { providerId: "p", model: "m", prompt: "画一只猫", count: 2, secret: "sk", appId: "settings" });
  assert.deepEqual(Object.keys(image).sort(), ["count", "model", "prompt", "providerId"]);
  const exec = buildProtocolPayload("protocol/execute", { providerId: "p", model: "m", prompt: "跑", intent: "image.generate", inputs: {}, secret: "sk" });
  assert.deepEqual(Object.keys(exec).sort(), ["inputs", "intent", "model", "prompt", "providerId"]);
});

/* ══════════════════════════════════════════════════════════════════════════
   2 protocol/list 的真实投影
   ══════════════════════════════════════════════════════════════════════════ */

/* 主进程真实输出（与 IPC 逐字相同的形状）。 */
const REAL_LIST = service.listProtocols();
const LIST_NORM = normalizeProtocolResult(REAL_LIST);

/* 73 不是"协议表永远只有 73 条"：自建 legacy 协议（legacy-custom-protocol-store.cjs）与 v2 本地协议包
   装载后会作为**新增项**追加进 protocol/list。原断言要保证的是"内置协议表 = 39 model + 34 provider"
   （provider 34 = 源 20 + v2 内置 15 去重 2 + 本仓新增官方 lovart）这条基线；
   现在用等价方式保证：先钉住"本进程未配置任何自建仓库"的前提，再断言这条基线本身。 */
const BUILTIN_LIST_ITEMS = 73;

test("真实 protocol/list 回包可投影：内置基线 73 条、两类 kind、v2/legacy 两种 engine", () => {
  assert.equal(REAL_LIST.ok, true);
  assert.equal(LIST_NORM.incomplete, false);
  assert.deepEqual(customProtocolStore.customProtocolStoreStatus().providerIds, [], "内置基线前提：未装载自建 provider 协议");
  assert.deepEqual(customProtocolStore.customProtocolStoreStatus().modelIds, [], "内置基线前提：未装载自建 model 协议");
  assert.equal(LIST_NORM.items.length, BUILTIN_LIST_ITEMS, "内置基线 73 条（39 model + 34 provider）；自建条目只追加");
  assert.deepEqual(protocolKindOptions(LIST_NORM.items), ["all", "model", "provider"]);
  const engines = new Set(LIST_NORM.items.map((i) => i.engine));
  assert.deepEqual([...engines].sort(), ["legacy", "v2"]);
  assert.equal(LIST_NORM.items.filter((i) => i.kind === "model").length, 39);
  assert.equal(LIST_NORM.items.filter((i) => i.kind === "provider").length, 34);
  assert.equal(LIST_NORM.shadowedLegacy.length, 1, "agnes 的 legacy 定义被 v2 遮蔽，单独附加");
  assert.equal(LIST_NORM.shadowedLegacy[0].id, "agnes");
  assert.equal(LIST_NORM.shadowedLegacy[0].execution, "conditional", "B7e3 插件端口已实现，agnes 与 runninghub / modelscope 同语义");
  assert.match(LIST_NORM.shadowedLegacy[0].unavailableReason, /agnes 插件/);
});

test("protocol/list 不再有 ported:false（B2 结论），execution 字段如实保留", () => {
  assert.equal(LIST_NORM.items.some((i) => i.ported === false), false, "metadata 已无 ported:false");
  // B7e2 后续：CLI 桥 / 插件端口批次改标 conditional（端口注入后可用，未注入仍结构化拒绝）。
  const conditional = LIST_NORM.items.filter((i) => i.execution === "conditional");
  assert.ok(conditional.length >= 5, "CLI 桥 / 插件端口批次应标 conditional");
  assert.ok(conditional.every((i) => typeof i.unavailableReason === "string" && i.unavailableReason.length > 0), "conditional 必须写明可执行前提");
  assert.equal(LIST_NORM.items.some((i) => i.execution === "unavailable"), false, "agnes 被 v2 遮蔽，可见 legacy 已无 unavailable");
});

test("normalizeProtocolResult 对不完整回包如实标注（不拿空数组冒充没有数据）", () => {
  const incomplete = normalizeProtocolResult({ ok: true, items: [{ id: "a", kind: "model" }, null, "x"] });
  assert.equal(incomplete.items.length, 1);
  assert.equal(incomplete.incomplete, true);
  assert.ok(incomplete.problem.includes("部分"));
  const failed = normalizeProtocolResult({ ok: false, error: "PROTOCOL_NOT_READY" });
  assert.deepEqual(failed, { items: [], shadowedLegacy: [], incomplete: false, problem: null });
  assert.deepEqual(normalizeProtocolResult(null).items, []);
});

test("filterProtocols：kind 过滤 + 搜索 id/label/能力，且不改变原始数组", () => {
  const items = LIST_NORM.items;
  const models = filterProtocols(items, "model", "");
  assert.equal(models.length, 39);
  assert.ok(models.every((i) => i.kind === "model"));
  assert.equal(filterProtocols(items, PROTOCOL_KIND_ALL, "").length, BUILTIN_LIST_ITEMS);
  const openai = filterProtocols(items, "model", "OpenAI Unified");
  assert.ok(openai.some((i) => i.id === "openai-images"), "应按 label 命中");
  const byCap = filterProtocols(items, PROTOCOL_KIND_ALL, "image.generate");
  assert.ok(byCap.some((i) => i.id === "openai-images"));
  assert.equal(filterProtocols(items, "model", "不存在的协议名").length, 0);
  assert.equal(items.length, BUILTIN_LIST_ITEMS, "过滤不得修改入参");
});

test("protocolRowStatus：declarative / available / conditional / unavailable / 无 execution 五种都不造假", () => {
  const decl = protocolRowStatus({ id: "openai-images", kind: "model", execution: "declarative", engine: "v2" });
  assert.equal(decl.tone, "success");
  const avail = protocolRowStatus({ id: "x", kind: "model", execution: "available", engine: "legacy" });
  assert.equal(avail.tone, "neutral");
  const cond = protocolRowStatus({ id: "cli:codex", kind: "provider", execution: "conditional", unavailableReason: "需安装 Codex CLI 并注入 cliCodex 端口" });
  assert.equal(cond.tone, "warning");
  assert.equal(cond.label, "条件可用");
  assert.ok(cond.detail.includes("cliCodex"));
  const bad = protocolRowStatus({ id: "cli:gemini", kind: "provider", execution: "unavailable", unavailableReason: "CLI 桥批次" });
  assert.equal(bad.tone, "warning");
  assert.ok(bad.detail.includes("CLI 桥批次"));
  const unknown = protocolRowStatus({ id: "y", kind: "model" });
  assert.equal(unknown.tone, "neutral");
  assert.ok(unknown.detail.includes("不推断"), "没有 execution 时必须说明界面不推断可执行性");
});

test("protocolFacts / protocolCapabilitiesText：缺字段显示未返回", () => {
  const full = protocolFacts({ id: "openai-images", kind: "model", label: "OpenAI Unified", engine: "v2", source: "system", activeVersion: 1, ported: true, execution: "declarative" });
  assert.equal(full.find((f) => f.label === "activeVersion").value, "1");
  assert.equal(full.find((f) => f.label === "ported").value, "true");
  const partial = protocolFacts({ id: "bare", kind: "model" });
  assert.equal(partial.find((f) => f.label === "label").value, "未返回");
  assert.equal(partial.find((f) => f.label === "source").value, "未返回");
  assert.equal(partial.find((f) => f.label === "ported").value, "未返回");
  assert.equal(protocolCapabilitiesText({ id: "a", kind: "model" }), "未返回");
  assert.equal(protocolCapabilitiesText({ id: "a", kind: "model", capabilities: ["llm.chat"] }), "llm.chat");
  assert.equal(protocolKindLabel("model"), "模型协议");
  assert.equal(protocolKindLabel("weird"), "weird");
  assert.equal(protocolKey({ kind: "model", id: "x" }), "model:x");
});

/* ══════════════════════════════════════════════════════════════════════════
   3 protocol/get 详情（声明情况）
   ══════════════════════════════════════════════════════════════════════════ */
const REAL_DETAIL = service.getProtocol({ kind: "model", id: "openai-images" });
const REAL_DETAIL_VIEW = describeProtocolDetail(REAL_DETAIL);

test("真实 protocol/get 详情：操作 / 工作流 / 模型 profile / uiSchemas 都按真实数量报", () => {
  assert.equal(REAL_DETAIL.ok, true);
  assert.equal(REAL_DETAIL_VIEW.found, true);
  assert.equal(REAL_DETAIL_VIEW.protocolId, "openai-images");
  const groups = Object.fromEntries(REAL_DETAIL_VIEW.groups.map((g) => [g.key, g]));
  assert.equal(groups.operations.count, 14);
  assert.equal(groups.workflows.count, 11);
  assert.equal(groups.modelProfiles.count, 11);
  assert.ok(groups.capabilities.count >= 12);
  assert.equal(groups.operations.declared, true);
  const op = REAL_DETAIL_VIEW.operations.find((o) => o.id === "image-generate");
  assert.equal(op.method, "POST");
  assert.equal(op.path, "/v1/images/generations");
  assert.equal(op.requestMode, "json");
  const wf = REAL_DETAIL_VIEW.workflows.find((w) => w.id === "generate");
  assert.equal(wf.submit, "image-generate");
  const profile = REAL_DETAIL_VIEW.profiles.find((p) => p.id === "gpt-image");
  assert.equal(profile.label, "GPT Image");
  assert.equal(profile.declaredAssets, true, "profile.assets 真实存在");
  assert.equal(profile.declaredLimits, true);
  assert.ok(profile.uiSchemas.includes("openai-image"));
});

test("describeProtocolDetail：缺失的族 declared:false（不编造数量）", () => {
  const view = describeProtocolDetail({ ok: true, version: 3, hash: "h", protocol: { id: "x", kind: "model", label: "X", capabilities: ["llm.chat"] } });
  assert.equal(view.found, true);
  assert.equal(view.version, "3");
  const groups = Object.fromEntries(view.groups.map((g) => [g.key, g]));
  assert.equal(groups.operations.declared, false);
  assert.equal(groups.operations.count, 0);
  assert.equal(groups.workflows.declared, false);
  assert.equal(groups.modelProfiles.declared, false);
  assert.equal(groups.capabilities.declared, true);
  assert.deepEqual(view.operations, []);
  assert.deepEqual(view.profiles, []);
});

test("describeProtocolDetail：legacy / 失败回包不伪装成有内容", () => {
  const notFound = describeProtocolDetail({ ok: false, error: "PROTOCOL_NOT_FOUND" });
  assert.equal(notFound.found, false);
  assert.equal(notFound.label, "未返回");
  assert.equal(describeProtocolDetail(null).found, false);
});

/* ══════════════════════════════════════════════════════════════════════════
   4 manifest/get 的子集投影
   ══════════════════════════════════════════════════════════════════════════ */
const REAL_MANIFEST = manifestService.getManifest({ protocolId: "openai-images", model: "gpt-image", intent: "image.generate" });
const REAL_MANIFEST_VIEW = describeManifest(REAL_MANIFEST);

test("真实 manifest/get：profile / 参数 schema / limits / operation 都来自回包", () => {
  assert.equal(REAL_MANIFEST.ok, true);
  assert.equal(REAL_MANIFEST_VIEW.format, "dx-model-manifest/v1");
  assert.equal(REAL_MANIFEST_VIEW.protocolId, "openai-images");
  assert.equal(REAL_MANIFEST_VIEW.model, "gpt-image");
  assert.equal(REAL_MANIFEST_VIEW.intent, "image.generate");
  assert.equal(REAL_MANIFEST_VIEW.profile.declared, true);
  assert.equal(REAL_MANIFEST_VIEW.profile.profileId, "gpt-image");
  assert.equal(REAL_MANIFEST_VIEW.profile.profileLabel, "GPT Image");
  assert.deepEqual(REAL_MANIFEST_VIEW.profile.capabilities, ["image.generate", "image.edit"]);
  assert.ok(REAL_MANIFEST_VIEW.profile.defaultOperations.some((d) => d.capability === "image.generate" && d.operationId === "image-generate"));
  const keys = REAL_MANIFEST_VIEW.parameterSchema.fields.map((f) => f.key);
  assert.deepEqual(keys, ["size", "quality"]);
  const quality = REAL_MANIFEST_VIEW.parameterSchema.fields.find((f) => f.key === "quality");
  assert.ok(quality.options.includes("high") && quality.options.includes("xhigh"));
  assert.equal(REAL_MANIFEST_VIEW.limits.declared, true);
  assert.equal(REAL_MANIFEST_VIEW.limits.value.references.images.max, 16);
  assert.equal(REAL_MANIFEST_VIEW.operation.declared, true);
  assert.equal(REAL_MANIFEST_VIEW.operation.id, "image-generate");
  assert.equal(REAL_MANIFEST_VIEW.operation.method, "POST");
  assert.equal(REAL_MANIFEST_VIEW.inferred.declared, true);
});

test("manifest/get 不含 assets / modelProfiles：界面必须标未返回，不得补造", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(REAL_MANIFEST, "assets"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(REAL_MANIFEST, "modelProfiles"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(REAL_MANIFEST.manifest, "assets"), false);
  assert.equal(REAL_MANIFEST_VIEW.assets.declared, false);
  assert.equal(REAL_MANIFEST_VIEW.modelProfiles.declared, false);
  assert.ok(REAL_MANIFEST_VIEW.assets.note.includes("不含 assets"));
  assert.ok(REAL_MANIFEST_VIEW.modelProfiles.note.includes("顶层没有 modelProfiles"));
  assert.ok(REAL_MANIFEST_VIEW.missing.includes("assets"));
  assert.ok(REAL_MANIFEST_VIEW.missing.includes("modelProfiles"));
  const text = missingFieldsText(REAL_MANIFEST_VIEW);
  assert.ok(text.startsWith("本次回包未返回："));
  assert.ok(text.includes("assets") && text.includes("modelProfiles"));
});

test("real manifest/get 有参数校验错误时也如实带出 parameterError 语义（回包失败则 declared:false）", () => {
  const bad = describeManifest({ ok: false, error: "PROTOCOL_NOT_FOUND" });
  assert.equal(bad.ok, false);
  assert.equal(bad.profile.declared, false);
  assert.equal(bad.parameterSchema.declared, false);
  assert.equal(bad.limits.declared, false);
  assert.equal(bad.assets.declared, false);
  assert.equal(bad.modelProfiles.declared, false);
  assert.equal(bad.inferred.declared, false);
  assert.equal(bad.missing.length, 7);
  assert.equal(missingFieldsText(bad).includes("inferred"), true);
});

test("describeManifest：LLM intent 的字段与 limits 也按真实返回呈现", () => {
  const llm = describeManifest(manifestService.getManifest({ protocolId: "openai-images", model: "gpt-5", intent: "llm.chat" }));
  assert.equal(llm.profile.profileId, "gpt-5");
  assert.ok(llm.parameterSchema.fields.length >= 3);
  assert.equal(llm.parameterSchema.fields.some((f) => f.key === "temperature"), true);
  /* limits 为空对象：界面按"未返回"处理（空对象不是一条限制）。 */
  assert.equal(llm.limits.declared, false);
  assert.ok(llm.missing.includes("manifest.limits"));
});

/* ══════════════════════════════════════════════════════════════════════════
   5 流式状态机
   ══════════════════════════════════════════════════════════════════════════ */
const envelope = (sequence, kind, payload, extra = {}) => ({
  channel: "model:event",
  domain: "model",
  kind,
  sequence,
  at: 1700000000000 + sequence,
  payload,
  ...extra,
});

test("streamPhaseFeedback 覆盖全部 9 个相位，活动态只出现在真实执行相位", () => {
  assert.deepEqual([...STREAM_PHASES], ["idle", "queued", "starting", "streaming", "usage", "completed", "error", "stopping", "cancelled"]);
  const actives = STREAM_PHASES.filter((p) => streamPhaseFeedback(p).active).sort();
  assert.deepEqual(actives, ["starting", "stopping", "streaming", "usage"]);
  for (const phase of STREAM_PHASES) {
    const fb = streamPhaseFeedback(phase);
    assert.ok(fb.label.length > 0 && fb.glyph.length > 0 && fb.detail.length > 0, phase + " 必须有图标 + 文字 + 说明");
  }
  assert.equal(streamPhaseFeedback("stopping").tone, "warning");
  assert.equal(streamPhaseFeedback("completed").tone, "success");
  assert.ok(streamPhaseFeedback("completed").detail.includes("不等于验证通过"));
  assert.ok(streamPhaseFeedback("stopping").detail.includes("没有中断命令"));
});

test("isModelEvent 只认 model 域信封", () => {
  assert.equal(isModelEvent(envelope(1, "progress", { type: "response.start" })), true);
  assert.equal(isModelEvent({ channel: "model:event", kind: "progress" }), true);
  assert.equal(isModelEvent({ channel: "task:event", domain: "task", kind: "progress" }), false);
  assert.equal(isModelEvent({ domain: "model" }), false);
  assert.equal(isModelEvent(null), false);
});

test("流式状态机：排队 → 开始 → 增量 → 用量 → 结束，文本累计且 sequence 单调", () => {
  let state = beginStream("prov_1", "gpt-image", "ui5_1", 1000);
  assert.equal(state.phase, "queued");
  state = reduceModelStreamEvent(state, envelope(1, "progress", { type: "response.start" }), 1001);
  assert.equal(state.phase, "starting");
  state = reduceModelStreamEvent(state, envelope(2, "progress", { type: "text.delta", text: "你好" }), 1002);
  state = reduceModelStreamEvent(state, envelope(3, "progress", { type: "text.delta", text: "，世界" }), 1003);
  assert.equal(state.phase, "streaming");
  assert.equal(state.text, "你好，世界");
  assert.equal(state.deltas, 2);
  state = reduceModelStreamEvent(state, envelope(4, "progress", { type: "usage", usage: { prompt_tokens: 3, completion_tokens: 4 } }), 1004);
  assert.equal(state.phase, "usage");
  assert.equal(state.usage.completion_tokens, 4);
  state = reduceModelStreamEvent(state, envelope(5, "progress", { type: "response.complete" }), 1005);
  assert.equal(state.phase, "completed");
  assert.equal(state.lastSequence, 5);
  assert.deepEqual(state.gaps, []);
  assert.deepEqual(state.events.map((e) => e.sequence), [1, 2, 3, 4, 5]);
});

test("流式状态机：sequence 缺口显式记录，重复 / 旧事件不倒退也不重复追加", () => {
  let state = beginStream("p", "m", "r", 0);
  state = reduceModelStreamEvent(state, envelope(1, "progress", { type: "response.start" }), 1);
  state = reduceModelStreamEvent(state, envelope(4, "progress", { type: "text.delta", text: "A" }), 2);
  assert.deepEqual(state.gaps, [{ from: 2, to: 3 }]);
  assert.ok(streamGapText(state).includes("2 个缺口"));
  assert.ok(streamGapText(state).includes("2–3"));
  const before = state;
  const stale = reduceModelStreamEvent(state, envelope(2, "progress", { type: "text.delta", text: "OLD" }), 3);
  assert.equal(stale.text, "A", "旧事件不得追加文本");
  assert.equal(stale.phase, "streaming", "旧事件不得倒退相位");
  assert.equal(stale.duplicates, 1);
  const dup = reduceModelStreamEvent(stale, envelope(4, "progress", { type: "text.delta", text: "A" }), 4);
  assert.equal(dup.text, "A");
  assert.equal(dup.duplicates, 2);
  assert.equal(dup.events.length, before.events.length);
});

test("流式状态机：错误事件 → error，CANCELLED → cancelled；未知 type 只记行不改状态", () => {
  let state = beginStream("p", "m", "r", 0);
  state = reduceModelStreamEvent(state, envelope(1, "progress", { type: "response.start" }), 1);
  state = reduceModelStreamEvent(state, envelope(2, "progress", { type: "something.new", value: 1 }), 2);
  assert.equal(state.phase, "starting", "未登记 type 不得猜语义");
  assert.equal(state.events.length, 2);
  const partial = reduceModelStreamEvent(state, envelope(3, "log", { level: "error", message: "provider stream error: PARTIAL_RESPONSE", data: { type: "response.error", partial: "半句" } }), 3);
  assert.equal(partial.phase, "error");
  assert.equal(partial.errorCode, "PARTIAL_RESPONSE");
  assert.ok(partial.errorDetail.includes("半句"));
  const cancelled = reduceModelStreamEvent(state, envelope(4, "log", { level: "error", message: "provider stream error: CANCELLED", data: { type: "response.error", partial: null } }), 4);
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.errorCode, "CANCELLED");
});

test("停止请求：stopping 不假装已取消；结束收敛到 cancelled 并注明已完成动作保留", () => {
  let state = beginStream("p", "m", "r", 0);
  state = reduceModelStreamEvent(state, envelope(1, "progress", { type: "response.start" }), 1);
  state = reduceModelStreamEvent(state, envelope(2, "progress", { type: "text.delta", text: "已收到" }), 2);
  state = requestStreamStop(state, 3);
  assert.equal(state.phase, "stopping");
  /* 停止之后到达的增量：界面不再追写，但计入 mutedAfterStop。 */
  state = reduceModelStreamEvent(state, envelope(3, "progress", { type: "text.delta", text: "，不应出现" }), 4);
  assert.equal(state.text, "已收到");
  assert.equal(state.mutedAfterStop, 1);
  state = reduceModelStreamEvent(state, envelope(4, "progress", { type: "response.complete" }), 5);
  assert.equal(state.phase, "stopping", "停止请求后不得被 complete 改回已完成");
  const settled = settleStream(state, { ok: true }, 6);
  assert.equal(settled.phase, "cancelled");
  assert.equal(streamPhaseFeedback(settled.phase).detail.includes("已完成动作保留"), true);
  /* 空转状态下的停止请求是 no-op。 */
  const idle = streamInitialState();
  assert.equal(requestStreamStop(idle, 1), idle);
});

test("settleStream：失败标 error，成功标结束（不标成功/验证通过）", () => {
  let state = beginStream("p", "m", "r", 0);
  state = reduceModelStreamEvent(state, envelope(1, "progress", { type: "response.start" }), 1);
  const failed = settleStream(state, { ok: false, error: "CREDENTIAL_MISSING" }, 2);
  assert.equal(failed.phase, "error");
  assert.equal(failed.errorCode, "CREDENTIAL_MISSING");
  const ok = settleStream(state, { ok: true }, 3);
  assert.equal(ok.phase, "completed");
  assert.equal(ok.resultCode, "OK");
  assert.equal(streamPhaseFeedback("completed").label, "结束");
});

test("事件行从 P1 信封取 sequence；缺失时如实标未返回", () => {
  let state = beginStream("p", "m", "r", 0);
  state = reduceModelStreamEvent(state, { channel: "model:event", domain: "model", kind: "progress", payload: { type: "response.start" } }, 1);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].sequence, null);
  assert.equal(streamSequenceText(state.events[0]), "未返回");
  assert.equal(streamGapText(state), "");
});

test("流式文本按渲染批次（buffer），不逐 token 写 DOM", () => {
  assert.equal(STREAM_FLUSH_INTERVAL_MS, 120);
  const buffer = createStreamBuffer();
  buffer.push("你");
  buffer.push("好");
  assert.equal(buffer.size(), 2, "两批还没合并输出");
  assert.equal(buffer.drain(), "你好");
  assert.equal(buffer.size(), 0);
  assert.equal(buffer.drain(), "");
  buffer.push("");
  assert.equal(buffer.size(), 0);
});

test("事件行上限 200 条（不无限增长）", () => {
  let state = beginStream("p", "m", "r", 0);
  for (let i = 1; i <= 260; i += 1) {
    state = reduceModelStreamEvent(state, envelope(i, "progress", { type: "text.delta", text: "x" }), i);
  }
  assert.equal(state.events.length, 200);
  assert.equal(state.events[0].sequence, 61, "保留最近 200 条");
  assert.equal(state.text.length, 260);
});

/* ══════════════════════════════════════════════════════════════════════════
   6 无可用 provider 的结构化说明
   ══════════════════════════════════════════════════════════════════════════ */
test("streamAvailability 五条分支都给出结构化缺失清单，不造假数据", () => {
  const ready = streamAvailability({ hasBridge: true, providerCount: 1, modelCount: 1, enabledProvider: "p1", credentialConfigured: true });
  assert.equal(ready.available, true);
  assert.equal(ready.kind, "ready");
  assert.deepEqual(ready.missing, []);
  const noBridge = streamAvailability({ hasBridge: false, providerCount: 0, modelCount: 0, enabledProvider: null, credentialConfigured: null });
  assert.equal(noBridge.kind, "no-bridge");
  assert.equal(noBridge.available, false);
  const noProvider = streamAvailability({ hasBridge: true, providerCount: 0, modelCount: 0, enabledProvider: null, credentialConfigured: null });
  assert.equal(noProvider.kind, "no-provider");
  assert.ok(noProvider.missing.length >= 1 && noProvider.description.includes("provider/list 返回空"));
  const disabled = streamAvailability({ hasBridge: true, providerCount: 2, modelCount: 1, enabledProvider: null, credentialConfigured: null });
  assert.equal(disabled.kind, "no-provider");
  assert.ok(disabled.description.includes("disabled"));
  const noCred = streamAvailability({ hasBridge: true, providerCount: 1, modelCount: 1, enabledProvider: "p1", credentialConfigured: false });
  assert.equal(noCred.kind, "no-credential");
  assert.ok(noCred.description.includes("不会假装调用成功"));
  const noModel = streamAvailability({ hasBridge: true, providerCount: 1, modelCount: 0, enabledProvider: "p1", credentialConfigured: true });
  assert.equal(noModel.kind, "no-model");
  for (const view of [ready, noBridge, noProvider, disabled, noCred, noModel]) {
    assert.ok(view.title.length > 0 && view.description.length > 0, "每种不可用都要有标题与说明");
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   7 错误码 / 四态
   ══════════════════════════════════════════════════════════════════════════ */
test("错误码 → 文案 / PageState 覆盖后端协议域与 DXOS 地基码", () => {
  for (const code of ["PROTOCOL_NOT_READY", "PROTOCOL_NOT_FOUND", "PROTOCOL_INVALID", "MODEL_COMMAND_NOT_ALLOWED", "CREDENTIAL_MISSING", "ENDPOINT_BLOCKED", "NO_BRIDGE", "DXOS_ERR_DEPENDENCY_MISSING"]) {
    assert.ok(MODEL_PROTOCOL_ERROR_TEXT[code], code + " 必须有登记文案");
  }
  assert.equal(modelProtocolErrorState("PROTOCOL_NOT_READY"), "unavailable");
  assert.equal(modelProtocolErrorState("NO_BRIDGE"), "unavailable");
  assert.equal(modelProtocolErrorState("CREDENTIAL_MISSING"), "unavailable");
  assert.equal(modelProtocolErrorState("DXOS_ERR_FORBIDDEN"), "unauthorized");
  assert.equal(modelProtocolErrorState("PROTOCOL_NOT_FOUND"), "error");
  assert.equal(modelProtocolErrorState("SOMETHING_UNKNOWN"), "error");
  assert.equal(modelProtocolErrorText("PROTOCOL_NOT_FOUND").includes("legacy"), true);
  assert.equal(modelProtocolErrorText("SOMETHING_UNKNOWN"), "模型与协议操作失败");
});

test("protocolListState 四态优先级：依赖缺失 > 错误 > 首屏加载 > 空 > 就绪", () => {
  assert.equal(protocolListState({ loading: false, errorCode: null, count: 3, dependencyUnavailable: true }), "unavailable");
  assert.equal(protocolListState({ loading: false, errorCode: "PROTOCOL_NOT_FOUND", count: 0, dependencyUnavailable: false }), "error");
  assert.equal(protocolListState({ loading: true, errorCode: null, count: 0, dependencyUnavailable: false }), "loading");
  assert.equal(protocolListState({ loading: false, errorCode: null, count: 0, dependencyUnavailable: false }), "empty");
  assert.equal(protocolListState({ loading: false, errorCode: null, count: 5, dependencyUnavailable: false }), "ready");
  /* 有缓存数据时局部刷新，不整页盖住。 */
  assert.equal(protocolListState({ loading: true, errorCode: "X", count: 5, dependencyUnavailable: false }), "ready");
});

/* ══════════════════════════════════════════════════════════════════════════
   8 界面源码边界
   ══════════════════════════════════════════════════════════════════════════ */
test("界面源码不联网、不写 localStorage、不直连本机端口、不读凭据", () => {
  for (const rel of ["src/settings/ModelSettings.tsx", "src/settings/modelProtocolLogic.ts"]) {
    const code = stripComments(read(rel));
    assert.equal(/\bfetch\s*\(/.test(code), false, rel + " 不得调用 fetch");
    assert.equal(/XMLHttpRequest|WebSocket|EventSource/.test(code), false, rel + " 不得使用网络对象");
    assert.equal(/localStorage|sessionStorage/.test(code), false, rel + " 不得写 localStorage/sessionStorage");
    assert.equal(/https?:\/\/|127\.0\.0\.1|localhost/.test(code), false, rel + " 不得直连本机端口或外网地址");
    assert.equal(/document\.cookie/.test(code), false, rel + " 不得读 cookie");
  }
});

test("界面只经 window.openarc.model 取数据，新增区块只发白名单命令", () => {
  const code = read("src/settings/ModelSettings.tsx");
  assert.ok(code.includes("openarc"), "必须通过 window.openarc");
  assert.ok(/openarc\?\.\s*model|openarc.*model/.test(code), "必须走 model 域");
  assert.equal(/openarc\s*\.\s*(agent|skill|mcp|identity|task)\b/.test(code), false, "不得越域取数据");
  /* 命令名登记在纯逻辑层（MODEL_ENTRIES），界面只按 meta.command 发；未登记的仍被白名单拒绝。 */
  const logicCode = read("src/settings/modelProtocolLogic.ts");
  for (const c of MODEL_PROTOCOL_COMMANDS) assert.ok(logicCode.includes('"' + c + '"'), "白名单/登记表必须包含 " + c);
  assert.ok(code.includes("MODEL_ENTRIES") && code.includes("meta.command"), "界面必须只按登记表发命令");
  assert.equal(/protocol\/delete/.test(code), false, "不得发送未登记命令 protocol/delete");
  assert.equal(isAllowedModelCommand("protocol/delete"), false);
  assert.equal(isAllowedModelCommand("protocol/save"), true);
  assert.equal(isAllowedModelCommand("image/generate"), true);
});

test("既有三个 pane 的 DOM、类名与交互未被改动", () => {
  const code = read("src/settings/ModelSettings.tsx");
  for (const marker of [
    'data-d4-01="settings"',
    'className="d401-tabs"',
    'data-d4-01-tab={t}',
    'data-d4-01-pane="providers"',
    'data-d4-01-pane="models"',
    'data-d4-01-pane="defaults"',
    'data-d4-01-provider-create',
    'data-d4-01-model-create',
    'data-d4-01-default-personal-chat',
    'data-d4-01-org-hint',
  ]) {
    assert.ok(code.includes(marker), "既有标记必须保留：" + marker);
  }
  /* 三个 tab 的取值集合未变。 */
  assert.ok(code.includes('(["providers", "models", "defaults"] as Tab[]).map'));
  /* 新增区块不得复用 / 改写既有 d401 类。 */
  const ui5 = code.slice(code.indexOf('data-model-proto="console"'));
  assert.equal(/d401-/.test(ui5), false, "UI-5 区块不得使用既有 .d401-* 类");
  assert.ok(code.includes("model-proto") && code.includes("model-stream"), "UI-5 必须用 .model-proto-* / .model-stream-*");
  assert.ok(ui5.includes("model-proto__row") && ui5.includes("renderStreamBlock"), "UI-5 区块必须渲染协议行与流式区块");
});

test("page-states.css 被引入（PageState 的视觉由设计系统提供，不另造状态样式）", () => {
  const code = read("src/settings/ModelSettings.tsx");
  assert.ok(code.includes('from "../design-system/page-states"'), "必须复用 PageState");
  assert.ok(code.includes('import "../design-system/page-states.css"'), "必须引入 page-states.css");
  assert.ok(code.includes("SearchField") && code.includes("TextField") && code.includes("ScrollArea") && code.includes("Badge"), "必须复用 primitives");
});

test("UI-5 的 CSS 只追加 .model-proto-* / .model-stream-*，不新增 token 定义", () => {
  const css = read("src/styles.css");
  const marker = css.indexOf("UI-5 · 模型与协议");
  assert.ok(marker > 0, "styles.css 必须包含 UI-5 区块");
  const start = css.lastIndexOf("/*", marker);
  const rest = css.slice(start);
  /* 只取 UI-5 这一段：到下一个顶级区块横幅为止（后续批次追加的规则不算进来，
     否则别的批次改动会让这条 UI-5 边界断言假失败）。 */
  const nextBanner = rest.indexOf("\n/* ══", 10);
  const block = (nextBanner > 0 ? rest.slice(0, nextBanner) : rest).replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.equal(/--[a-z0-9-]+\s*:/.test(block), false, "UI-5 区块不得新增 / 改写 token");
  const rules = block.match(/(^|\n)\s*([^\n{}@]+)\{/g) || [];
  let checked = 0;
  for (const raw of rules) {
    const sel = raw.replace(/\{$/, "").trim();
    if (!sel || sel === "from" || sel === "to" || /%$/.test(sel)) continue;
    if (sel.startsWith("@")) continue;
    checked += 1;
    for (const part of sel.split(",")) {
      const s = part.trim();
      assert.ok(s.startsWith(".model-proto") || s.startsWith(".model-stream"), "越界选择器：" + s);
    }
  }
  assert.ok(checked >= 40, "至少应解析出 40 条 .model-* 规则，实际 " + checked);
});

test("tokens.css 零改动：不出现 .model- 选择器，也不出现 UI-5 标记", () => {
  const tokens = read("src/design-system/tokens.css");
  assert.equal(tokens.indexOf(".model-proto"), -1);
  assert.equal(tokens.indexOf(".model-stream"), -1);
  assert.equal(tokens.indexOf("UI-5"), -1);
});

test("main.tsx 不改动：settings 分支仍经 SettingsContent 渲染既有 ModelSettings", () => {
  const code = read("src/main.tsx");
  assert.ok(code.includes('from "./settings/SettingsContent"'), "main.tsx 必须仍引入 SettingsContent");
  assert.ok(code.includes('w?.appId === "settings"'), "settings 分支必须保留");
  assert.equal(code.includes("modelProtocolLogic"), false, "main.tsx 不得引入 UI-5 逻辑层");
});


/* ══════════════════════════════════════════════════════════════════════════
   9 动作入口（UI-5b）—— 可用性 / 凭据提示 / 必填 / 风险
   ══════════════════════════════════════════════════════════════════════════ */
test("四个动作入口逐条落在后端命令表，命令与界面入口同源", () => {
  const backend = modelBootstrap.MODEL_COMMANDS;
  assert.deepEqual([...MODEL_ENTRY_KEYS], ["protocol-validate", "protocol-save", "image-generate", "protocol-execute"]);
  assert.equal(MODEL_ENTRIES.length, 4);
  for (const meta of MODEL_ENTRIES) {
    assert.ok(backend.includes(meta.command), meta.command + " 必须是后端白名单命令");
    assert.ok(MODEL_PROTOCOL_COMMANDS.includes(meta.command), meta.command + " 必须在 UI-5 命令表内");
    assert.equal(isAllowedModelCommand(meta.command), true, meta.command + " 必须被界面白名单承认");
    assert.equal(modelEntryMeta(meta.key), meta);
    assert.ok(meta.inputs.length > 0, meta.key + " 必须声明输入");
  }
  assert.equal(modelEntryMeta("nope"), null);
  assert.equal(modelEntryRiskText("nope"), "");
  assert.deepEqual(Object.keys(MODEL_ENTRY_RISK_LABEL).sort(), ["read", "use", "write"]);
  for (const key of MODEL_ENTRY_KEYS) assert.ok(MODEL_ENTRY_RISK_TEXT[key].length > 0, key + " 必须有风险说明");
});

test("入口可用性：桥缺失 / 无供应商 / 缺凭据 / 缺协议 / 就绪", () => {
  const base = { hasBridge: true, enabledProvider: "prov_local", credentialConfigured: true, hasProtocol: false };
  assert.equal(modelEntryAvailability("protocol-save", base).kind, "no-input");
  const noBridge = modelEntryAvailability("protocol-save", { ...base, hasBridge: false });
  assert.equal(noBridge.kind, "no-bridge");
  const noProvider = modelEntryAvailability("image-generate", { ...base, enabledProvider: null });
  assert.equal(noProvider.kind, "no-provider");
  assert.ok(noProvider.description.includes("没有可用的供应商"), noProvider.description);

  /* 缺凭据：结构化提示，只说缺凭据，不回显密钥。 */
  const noCred = modelEntryAvailability("image-generate", { ...base, credentialConfigured: false });
  assert.equal(noCred.kind, "no-credential");
  assert.equal(noCred.title, "图像生成不可用：缺凭据");
  assert.equal(noCred.description, MODEL_ENTRY_MISSING_CREDENTIAL_TEXT);
  assert.ok(noCred.description.includes("没有执行"));
  assert.equal(noCred.description.includes("sk-"), false, "不得出现任何密钥字样");
  assert.deepEqual(noCred.missing, ["credential/status.configured=true"]);
  assert.equal(modelEntryAvailability("protocol-execute", { ...base, credentialConfigured: false }).kind, "no-credential");

  /* 协议入口不依赖凭据；缺协议才是它的前置条件。 */
  assert.equal(modelEntryAvailability("protocol-validate", { ...base, hasProtocol: true }).available, true);
  assert.equal(modelEntryAvailability("protocol-validate", { ...base, credentialConfigured: false, hasProtocol: true }).available, true);
  assert.equal(modelEntryAvailability("image-generate", base).available, true);
  assert.equal(modelEntryAvailability("nope", base).kind, "no-input");
});

test("入口必填输入在前端就被拦下（不发空命令）", () => {
  assert.deepEqual(MODEL_ENTRY_REQUIRED_INPUTS["protocol-save"], ["kind", "protocol"]);
  assert.deepEqual(modelEntryMissingInputs("protocol-validate", {}), ["protocol"]);
  assert.deepEqual(modelEntryMissingInputs("protocol-save", { kind: "model" }), ["protocol"]);
  assert.deepEqual(modelEntryMissingInputs("image-generate", { providerId: "p", model: "m" }), ["prompt"]);
  assert.deepEqual(modelEntryMissingInputs("protocol-execute", { providerId: "p", model: "m", prompt: "跑" }), []);
  assert.deepEqual(modelEntryMissingInputs("nope", {}), []);
  assert.equal(typeof MODEL_ENTRY_INPUT_LABEL.protocol, "string");
});

test("界面源码包含四个动作入口，且需要凭据的入口只提示不回显密钥", () => {
  const code = stripComments(read("src/settings/ModelSettings.tsx"));
  for (const marker of ["MODEL_ENTRIES", "data-model-entry", "data-model-entry-action", "meta.command"]) {
    assert.ok(code.indexOf(marker) >= 0, "界面必须渲染 " + marker);
  }
  assert.equal(/d401-/.test(code.slice(code.indexOf('data-model-proto="console"'))), false, "UI-5 区块不得使用既有 .d401-* 类");
  /* 只看动作入口那一段：既有 Providers 区块写入凭据（只写不读）不属于本断言范围。 */
  const entries = code.slice(code.indexOf('data-model-proto="entries"'));
  assert.equal(/credentialSecret|api_key|apiKey/.test(entries), false, "动作入口不得读 / 回显密钥");
});

/* ══════════════════════════════════════════════════════════════════════════
   写类入口二次确认（UI-5c）：protocol/save 确认前不发命令；取消则命令数 0
   ══════════════════════════════════════════════════════════════════════════ */
test("只有写类入口需要二次确认（protocol/save），只读与真实调用入口保持原语义", () => {
  assert.equal(modelEntryNeedsConfirm("protocol-save"), true);
  for (const key of ["protocol-validate", "image-generate", "protocol-execute"]) {
    assert.equal(modelEntryNeedsConfirm(key), false, key + " 不是写类入口");
  }
  assert.equal(modelEntryNeedsConfirm("nope"), false);
  assert.ok(modelEntryConfirmTitle("protocol-save").indexOf("保存") >= 0);
});

test("协议保存确认摘要点名要写入的协议与 kind，并说明取消不发送", () => {
  const text = modelEntryConfirmText("protocol-save", { kind: "model", protocol: { id: "probe", kind: "model" } });
  assert.ok(text.indexOf("probe") >= 0, text);
  assert.ok(text.indexOf("本地协议库") >= 0 && text.indexOf("取消") >= 0, text);
  const noId = modelEntryConfirmText("protocol-save", { kind: "model", protocol: {} });
  assert.ok(noId.indexOf("未给出 id") >= 0, noId);
});

test("界面源码对写类入口走 Dialog 二次确认，其余入口保持直接发送", () => {
  const code = stripComments(read("src/settings/ModelSettings.tsx"));
  assert.ok(code.indexOf("Dialog") >= 0, "必须复用既有 Dialog");
  assert.ok(code.indexOf("modelEntryNeedsConfirm") >= 0, "按风险判定是否确认");
  assert.ok(code.indexOf("data-model-entry-confirm-submit") >= 0, "必须有确认按钮");
  assert.ok(code.indexOf("data-model-entry-confirm-cancel") >= 0, "必须有取消按钮");
  assert.equal(
    /onClick=\{\(\) => void submitEntry\(meta\.key\)\}/.test(code),
    false,
    "入口按钮不得直接发送命令",
  );
});

