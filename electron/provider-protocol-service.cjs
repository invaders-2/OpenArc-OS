"use strict";
/**
 * P2 · 统一调用出口。
 *
 * 提供：
 *   · OpenAI 兼容 chat/completions（非流式 + 流式、usage 采集、错误规约）
 *   · OpenAI 兼容 images/generations（图像协议族之一），产物落盘 <userData>/dxos/media/
 *   · 声明式协议引擎执行（compileProtocolPlan + executeProtocolPlan）
 *   · 协议表 / 校验 / 保存
 *
 * 参照实现：
 *   · DXSRC/protocol-engine/compiler.ts:410-482 声明式计划
 *   · DXSRC/protocol-engine/workflow.ts:545-698 执行与轮询
 *   · DXSRC/provider-adapter（OpenAI 响应映射）在 OpenArc 侧对应 provider-adapter.cjs
 * 凭据只在主进程内解出，绝不进入返回值。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const domain = require("./provider-protocol-domain.cjs");
const modelDomain = require("./model-domain.cjs");
const adapter = require("./provider-adapter.cjs");
const repository = require("./protocol-engine/repository.cjs");
const flags = require("./protocol-engine/flags.cjs");
const compiler = require("./protocol-engine/compiler.cjs");
const workflow = require("./protocol-engine/workflow.cjs");
const validator = require("./protocol-engine/validator.cjs");
const bindings = require("./protocol-engine/bindings.cjs");
const { createProviderProtocolStore } = require("./provider-protocol-store.cjs");
const { createModelManifestService } = require("./model-manifest-service.cjs");
// W5 · B2 遗留①：流式下行事件沿用 P1 地基信封（dxos-foundation-events.cjs:56-92）。
const { createEventChannel } = require("./dxos-foundation-events.cjs");

const MEDIA_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/aac": "aac", "audio/flac": "flac", "audio/L16": "pcm" };
/** W6b · legacy 出口动作白名单，与 provider-protocol-domain.cjs 的 legacy/* 命令一一对应。 */
const LEGACY_OUTLET_ACTIONS = new Set(["chat", "chatStream", "chatTools", "images", "editImages", "videos", "audio", "catalog", "describeImage", "midjourney"]);

/**
 * W6c · 渲染层只能投递 dataUrl / base64 文本，而 legacy 执行器（EditImageInput /
 * GenVideoReference，protocols.ts:4233 / :4181）期望 { buf: Buffer, mime, name }。
 * 这里在主进程内完成解码；无法解读的载荷返回结构化 INVALID_INPUT，不把异常抛给调用方。
 */
function decodeLegacyBase64(value) {
  const compact = String(value == null ? "" : value).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const body = compact.replace(/=+$/, "");
  if (!body || !/^[A-Za-z0-9+/]+$/.test(body) || compact.length % 4 === 1) return null;
  const buf = Buffer.from(compact, "base64");
  return buf.length ? buf : null;
}

function parseLegacyDataUrl(value) {
  const match = String(value).match(/^data:([^;,]*)?(;[^,]*)?,([\s\S]*)$/i);
  if (!match) return null;
  const params = String(match[2] || "").toLowerCase();
  if (!params.split(";").includes("base64")) return null;
  return { mime: String(match[1] || "").trim(), payload: match[3] };
}

class ProviderProtocolService {
  constructor({ store, userDataDir = null, fetchImpl = fetch, clock = () => Date.now(), logger = null, timeoutMs = 30000, emit = null, eventDomain = "model" } = {}) {
    if (!store) throw new Error("ProviderProtocolService 需要 store");
    this.store = store;
    this.userDataDir = userDataDir ? String(userDataDir) : null;
    this.mediaDir = this.userDataDir ? path.join(this.userDataDir, "dxos", "media") : null;
    this.fetchImpl = typeof fetchImpl === "function" ? fetchImpl : fetch;
    this.clock = clock;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    // W5：流式 onEvent → 下行事件的发送口由宿主注入（生产 = main.cjs 的 model:event）。
    // 未注入时只保留调用方自己的 onEvent，事件通道不推进序号，业务路径不受影响。
    this.emit = typeof emit === "function" ? emit : null;
    this.eventChannel = createEventChannel({ domain: eventDomain, clock: () => this.clock() });
  }

  /** 窗口在 identity bootstrap 之后才存在；宿主可后置注入下行发送口。 */
  setEventSink(emit) {
    this.emit = typeof emit === "function" ? emit : null;
    return !!this.emit;
  }

  // ---------- 协议表 / 校验 / 保存 ----------

  listProtocols({ kind = null, ported = null } = {}) {
    const table = domain.protocolTable(kind || undefined);
    const v2 = repository.listProtocolsV2(kind || undefined).map((entry) => ({
      id: entry.id, kind: entry.kind, label: entry.protocol.label, engine: "v2",
      source: entry.source, activeVersion: entry.activeVersion, activeHash: entry.activeHash,
      capabilities: entry.protocol.kind === "model" ? entry.protocol.capabilities : [],
      ported: true,
      execution: "declarative",
    }));
    const v2Keys = new Set(v2.map((item) => item.kind + ":" + item.id));
    const legacy = table.filter((item) => item.engine === "legacy" && !v2Keys.has(item.kind + ":" + item.id));
    const items = [...v2, ...legacy.map((item) => ({
      id: item.id, kind: item.kind, label: item.id, engine: item.engine, source: item.source, ported: item.ported,
      capabilities: [],
      execution: item.execution,
      ...(item.unavailableReason ? { unavailableReason: item.unavailableReason } : {}),
    }))];
    const filtered = ported === null ? items : items.filter((item) => item.ported === ported);
    // 既有字段与 items 形状不变；被 v2 同名定义遮蔽的 legacy 不可用分支单独附加，避免 items 出现重复 kind:id。
    const shadowedLegacy = domain.shadowedLegacyProtocols(kind || undefined).filter((item) => v2Keys.has(item.kind + ":" + item.id));
    return {
      ok: true,
      items: filtered.sort((left, right) => left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind)),
      shadowedLegacy,
    };
  }

  getProtocol({ kind, id, version = null } = {}) {
    try {
      const entry = repository.getProtocolV2(kind, id, version == null ? undefined : Number(version));
      if (!entry) return { ok: false, error: "PROTOCOL_NOT_FOUND" };
      return { ok: true, version: entry.version, hash: entry.hash, protocol: entry.protocol };
    } catch (error) { return { ok: false, error: "INVALID_INPUT", detail: String(error.message || error).slice(0, 300) }; }
  }

  validateProtocol({ protocol } = {}) {
    try { return { ok: true, protocol: validator.validateProtocolV2(protocol) }; }
    catch (error) { return { ok: false, error: "PROTOCOL_INVALID", issues: Array.isArray(error.issues) ? error.issues : [String(error.message || error)] }; }
  }

  saveProtocol({ kind, protocol } = {}) {
    try { return { ok: true, entry: repository.saveProtocolV2(kind, protocol) }; }
    catch (error) { return { ok: false, error: "PROTOCOL_SAVE_REJECTED", detail: String(error.message || error).slice(0, 300) }; }
  }

  // ---------- 统一调用出口 ----------

  #resolveProvider({ providerId, allowLan = false } = {}) {
    const provider = this.store.get(providerId);
    if (!provider) return { ok: false, error: "PROVIDER_NOT_FOUND" };
    const endpoint = modelDomain.validateEndpoint(provider.base_url, { allowLan: !!allowLan });
    if (!endpoint.ok) return { ok: false, error: endpoint.error, detail: endpoint.reason };
    if (!domain.providerRequiresApiKey(provider.protocol) && !provider.api_key) {
      return { ok: true, provider: { ...provider, api_key: "" }, endpoint };
    }
    if (!provider.api_key) return { ok: false, error: modelDomain.ERROR_CODE.CREDENTIAL_MISSING };
    return { ok: true, provider, endpoint };
  }

  #providerOriginMatches(provider, endpoint) {
    try { return new URL(provider.base_url).origin === endpoint.origin; } catch { return false; }
  }

  /**
   * OpenAI 兼容 chat/completions。
   * stream=false 时返回 { text, toolCalls, usage }；stream=true 时通过 onEvent 下发
   * text.delta / usage / response.start / response.complete（IPC 侧聚合后返回最终文本）。
   */
  async call({ providerId, model, messages = [], tools = null, params = {}, stream = false, requestId = null, signal = null, allowLan = false, onEvent = () => {} } = {}) {
    const resolved = this.#resolveProvider({ providerId, allowLan });
    if (!resolved.ok) return resolved;
    const { provider, endpoint } = resolved;
    if (!this.#providerOriginMatches(provider, endpoint)) return { ok: false, error: modelDomain.ERROR_CODE.ENDPOINT_BLOCKED };
    const rid = requestId || "preq_" + crypto.randomBytes(8).toString("base64url");
    const built = domain.buildChatRequest({ baseUrl: provider.base_url, apiKey: provider.api_key, model, messages, tools, params, stream: !!stream });
    const startedAt = this.clock();
    try {
      const response = await this.#fetch(built, signal);
      if (!response.ok) {
        const code = domain.normalizeProtocolError({ status: response.status });
        return { ok: false, error: code, requestId: rid, status: response.status };
      }
      if (!stream) {
        const body = await response.json().catch(() => null);
        if (!body) return { ok: false, error: modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, requestId: rid };
        const parsed = domain.parseChatResponse(body);
        this.#record({ requestId: rid, providerId: provider.id, model, status: "ALLOW", startedAt, usage: parsed.usage });
        return { ok: true, requestId: rid, text: parsed.text, toolCalls: parsed.toolCalls, usage: parsed.usage, snapshot: this.#safeSnapshot(provider, model) };
      }
      const parsed = await this.#readSse(response, this.#streamSink(onEvent), signal);
      this.#record({ requestId: rid, providerId: provider.id, model, status: "ALLOW", startedAt, usage: parsed.usage });
      return { ok: true, requestId: rid, text: parsed.text, toolCalls: parsed.toolCalls, usage: parsed.usage, snapshot: this.#safeSnapshot(provider, model) };
    } catch (error) {
      return { ok: false, error: this.#errorFromException(error, signal), requestId: rid };
    }
  }

  /** 图像协议族：OpenAI 兼容 images/generations，产物落盘 <userData>/dxos/media/。 */
  async generateImage({ providerId, model, prompt = "", size = null, count = 1, params = {}, requestId = null, signal = null, allowLan = false } = {}) {
    const resolved = this.#resolveProvider({ providerId, allowLan });
    if (!resolved.ok) return resolved;
    const { provider, endpoint } = resolved;
    if (!this.#providerOriginMatches(provider, endpoint)) return { ok: false, error: modelDomain.ERROR_CODE.ENDPOINT_BLOCKED };
    const rid = requestId || "ireq_" + crypto.randomBytes(8).toString("base64url");
    const built = domain.buildImageRequest({ baseUrl: provider.base_url, apiKey: provider.api_key, model, prompt, size, count, params });
    const startedAt = this.clock();
    try {
      const response = await this.#fetch(built, signal);
      if (!response.ok) return { ok: false, error: domain.normalizeProtocolError({ status: response.status }), requestId: rid, status: response.status };
      const body = await response.json().catch(() => null);
      const items = domain.parseImageResponse(body);
      if (!items.length) return { ok: false, error: modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, requestId: rid };
      const images = [];
      for (const item of items) {
        if (item.b64) {
          const saved = this.#saveArtifact(Buffer.from(item.b64, "base64"), item.mime || "image/png");
          images.push(saved || { mime: item.mime || "image/png", dataUrl: "data:" + (item.mime || "image/png") + ";base64," + item.b64 });
        } else if (item.url) {
          const saved = await this.#saveRemoteArtifact(item.url, signal);
          images.push(saved || { url: item.url, saved: false });
        }
      }
      this.#record({ requestId: rid, providerId: provider.id, model, status: "ALLOW", startedAt, usage: null });
      return { ok: true, requestId: rid, images, snapshot: this.#safeSnapshot(provider, model) };
    } catch (error) {
      return { ok: false, error: this.#errorFromException(error, signal), requestId: rid };
    }
  }

  /** 声明式协议引擎执行：compile → execute（含轮询）。 */
  async executeProtocol({ providerId, protocolId, model, intent, prompt = "", params = {}, inputs = {}, requestId = null, signal = null, allowLan = false, onEvent = () => {} } = {}) {
    const resolved = this.#resolveProvider({ providerId, allowLan });
    if (!resolved.ok) return resolved;
    const { provider, endpoint } = resolved;
    const providerProtocol = bindings.boundProviderProtocolV2({ id: provider.id, base_url: provider.base_url, protocol: provider.protocol });
    const modelProtocol = bindings.boundModelProtocolV2(protocolId || provider.protocol, provider, model, intent);
    if (!providerProtocol || !modelProtocol) return { ok: false, error: "PROTOCOL_NOT_FOUND" };
    const rid = requestId || "xreq_" + crypto.randomBytes(8).toString("base64url");
    try {
      const plan = compiler.compileProtocolPlan({
        providerProtocol: providerProtocol.protocol,
        modelProtocol: modelProtocol.protocol,
        baseUrl: provider.base_url,
        credential: provider.api_key,
        task: {
          requestId: rid, model, intent, prompt, params,
          inputs: { images: [], videos: [], audios: [], files: [], ...(inputs || {}) },
        },
      });
      const result = await workflow.executeProtocolPlan({ plan, signal, onEvent });
      return { ok: true, requestId: rid, taskId: result.taskId, outputs: result.outputs, captures: result.captures, snapshot: this.#safeSnapshot(provider, model) };
    } catch (error) {
      return { ok: false, error: "PROTOCOL_EXECUTION_FAILED", detail: String(error.message || error).slice(0, 400), requestId: rid };
    }
  }

  /**
   * W6b · legacy 协议族统一出口。
   * 按 action 分发到 legacy-executor.cjs 的 chat / images / media 实现；产物按既有的
   * #saveArtifact / #saveRemoteArtifact 落盘 <userData>/dxos/media/。
   * legacy 执行器期望的 provider 形状 = 源 ResolvedProvider（protocols.ts:3583-3589）：
   * { id?, base_url, api_key, wallet_api_key?, protocol }。
   * 返回值只含产物文件名/字节数或源 URL，绝不含 api_key / credentialRef / 绝对路径。
   */
  async legacyExecute({ providerId, action, model = null, messages = [], system = null, prompt = null, tools = null, params = {}, input = null, inputs = [], intent = null, dataUrl = null, timeoutMs = null, requestId = null, signal = null, allowLan = false, onEvent = () => {} } = {}) {
    const act = String(action || "").trim();
    if (!LEGACY_OUTLET_ACTIONS.has(act)) return { ok: false, error: modelDomain.ERROR_CODE.INVALID_INPUT, detail: "unknown-legacy-action" };
    const resolved = this.#resolveProvider({ providerId, allowLan });
    if (!resolved.ok) return resolved;
    const { provider, endpoint } = resolved;
    if (!this.#providerOriginMatches(provider, endpoint)) return { ok: false, error: modelDomain.ERROR_CODE.ENDPOINT_BLOCKED };
    const legacyProvider = {
      id: provider.id,
      base_url: provider.base_url,
      api_key: provider.api_key,
      wallet_api_key: provider.wallet_api_key || "",
      protocol: provider.protocol,
    };
    const rid = requestId || "lreq_" + crypto.randomBytes(8).toString("base64url");
    const snapshot = this.#safeSnapshot(provider, model);
    const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : null;
    const callParams = params && typeof params === "object" ? params : {};
    try {
      const legacyExecutor = require("./protocol-engine/legacy-executor.cjs");
      switch (act) {
        case "chat": {
          const result = await legacyExecutor.callChat(legacyProvider, model, this.#legacyChatInput({ messages, system, prompt }), callParams, timeout || 90000, signal);
          if (this.#legacyUnavailable(result)) return { ...result, requestId: rid };
          return { ok: true, requestId: rid, text: String(result.text || ""), usage: result.usage ?? null, snapshot };
        }
        case "chatStream": {
          const sink = this.#streamSink(onEvent);
          sink({ type: "response.start" });
          let text = "";
          const result = await legacyExecutor.streamChat(
            legacyProvider, model, this.#legacyChatInput({ messages, system, prompt }), callParams,
            (delta) => { const value = String(delta == null ? "" : delta); text += value; sink({ type: "text.delta", text: value }); },
            timeout || 120000,
          );
          if (this.#legacyUnavailable(result)) return { ...result, requestId: rid };
          const usage = (result && result.usage) || null;
          if (usage) sink({ type: "usage", usage });
          sink({ type: "response.complete" });
          return { ok: true, requestId: rid, text, usage, snapshot };
        }
        case "chatTools": {
          const sink = this.#streamSink(onEvent);
          const result = await legacyExecutor.chatWithTools(
            legacyProvider, model, Array.isArray(messages) ? messages : [],
            system == null ? "" : String(system), tools,
            timeout || 300000, (delta) => sink({ type: "text.delta", text: String(delta == null ? "" : delta) }), signal,
          );
          if (this.#legacyUnavailable(result)) return { ...result, requestId: rid };
          return { ok: true, requestId: rid, text: String(result.content || ""), toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : [], usage: result.usage ?? null, snapshot };
        }
        case "images": {
          const result = await legacyExecutor.generateImages(legacyProvider, model, this.#legacyPromptParams(callParams, prompt), timeout || 300000);
          if (this.#legacyUnavailable(result)) return { ...result, requestId: rid };
          return { ok: true, requestId: rid, images: await this.#saveLegacyItems(result.images, "image", signal), snapshot };
        }
        case "editImages": {
          const decoded = this.#legacyReferences(Array.isArray(inputs) && inputs.length ? inputs : (input ? [input] : []));
          if (!decoded.ok) return { ...decoded, requestId: rid };
          const result = await legacyExecutor.editImages(legacyProvider, model, this.#legacyPromptParams(callParams, prompt), decoded.values, timeout || 300000);
          if (this.#legacyUnavailable(result)) return { ...result, requestId: rid };
          return { ok: true, requestId: rid, images: await this.#saveLegacyItems(result.images, "image", signal), snapshot };
        }
        case "videos": {
          const decoded = input ? this.#legacyReference(input) : { ok: true, value: undefined };
          if (!decoded.ok) return { ...decoded, requestId: rid };
          const result = await legacyExecutor.generateVideos(legacyProvider, model, this.#legacyPromptParams(callParams, prompt), decoded.value, timeout || 600000);
          if (this.#legacyUnavailable(result)) return { ...result, requestId: rid };
          return { ok: true, requestId: rid, videos: await this.#saveLegacyItems(result.videos, "url", signal), snapshot };
        }
        case "audio": {
          const mode = String(intent || callParams.intent || "speech").trim().toLowerCase();
          if (mode === "transcribe" || mode === "translate") {
            const ref = input || (Array.isArray(inputs) ? inputs[0] : null);
            const decoded = ref ? this.#legacyReference(ref) : { ok: true, value: null };
            if (!decoded.ok) return { ...decoded, requestId: rid };
            const result = await legacyExecutor.transcribeAudio(legacyProvider, model, decoded.value, callParams, timeout || 300000);
            if (this.#legacyUnavailable(result)) return { ...result, requestId: rid };
            return { ok: true, requestId: rid, text: String(result.text || ""), snapshot };
          }
          if (mode === "music") {
            const result = await legacyExecutor.generateMusic(legacyProvider, model, this.#legacyPromptParams(callParams, prompt), timeout || 900000);
            if (this.#legacyUnavailable(result)) return { ...result, requestId: rid };
            return { ok: true, requestId: rid, audios: await this.#saveLegacyItems(result.audios, "url", signal), snapshot };
          }
          const result = await legacyExecutor.generateSpeech(legacyProvider, model, this.#legacySpeechParams(callParams, prompt), timeout || 300000);
          if (this.#legacyUnavailable(result)) return { ...result, requestId: rid };
          const saved = result && result.data ? this.#saveArtifact(Buffer.from(result.data), result.mime || "audio/mpeg") : null;
          return { ok: true, requestId: rid, audios: saved ? [this.#projectArtifact(saved)] : [], snapshot };
        }
        case "catalog": {
          const catalog = await legacyExecutor.fetchModelCatalog(legacyProvider, timeout || 20000);
          if (this.#legacyUnavailable(catalog)) return { ...catalog, requestId: rid };
          return { ok: true, requestId: rid, models: Array.isArray(catalog) ? catalog : [], snapshot };
        }
        case "describeImage": {
          const outputTokens = Math.max(256, Math.min(16384, Number(callParams.outputTokens) || 2048));
          const text = await legacyExecutor.describeImage(legacyProvider, model, dataUrl, prompt == null ? "" : String(prompt), timeout || 120000, outputTokens, signal);
          if (this.#legacyUnavailable(text)) return { ...text, requestId: rid };
          return { ok: true, requestId: rid, text: String(text || ""), snapshot };
        }
        case "midjourney": {
          const decoded = this.#legacyReferences(inputs);
          if (!decoded.ok) return { ...decoded, requestId: rid };
          return await this.#legacyMidjourney({ legacyExecutor, legacyProvider, model, callParams, prompt, inputs: decoded.values, intent, timeout, rid, snapshot, signal });
        }
        default: return { ok: false, error: modelDomain.ERROR_CODE.INVALID_INPUT, detail: "unknown-legacy-action" };
      }
    } catch (error) {
      return { ok: false, error: this.#legacyErrorCode(error, signal), detail: this.#safeDetail(error, provider.api_key), requestId: rid };
    }
  }

  async #legacyMidjourney({ legacyExecutor, legacyProvider, model, callParams, prompt, inputs, intent, timeout, rid, snapshot, signal }) {
    const op = String(intent || callParams.op || "submit").trim().toLowerCase();
    const promptParams = this.#legacyPromptParams(callParams, prompt);
    let result;
    if (op === "generate") result = await legacyExecutor.generateMidjourneyImages(legacyProvider, model, promptParams, timeout || 600000, Array.isArray(inputs) ? inputs : []);
    else if (op === "status") result = await legacyExecutor.getMidjourneyTask(legacyProvider, String(callParams.task_id || ""), timeout || 300000);
    else if (op === "action") result = await legacyExecutor.submitMidjourneyAction(legacyProvider, promptParams, timeout || 300000);
    else if (op === "modal") result = await legacyExecutor.submitMidjourneyModal(legacyProvider, promptParams, timeout || 300000);
    else result = await legacyExecutor.submitMidjourney(legacyProvider, model, promptParams, timeout || 300000);
    if (this.#legacyUnavailable(result)) return { ...result, requestId: rid };
    const images = op === "generate" || op === "status" ? await this.#saveLegacyItems(result.images, "image", signal) : [];
    return {
      ok: true, requestId: rid, op,
      taskId: result.taskId == null ? null : String(result.taskId),
      ...(result.status ? { status: String(result.status) } : {}),
      ...(result.message ? { message: String(result.message) } : {}),
      ...(images.length ? { images } : {}),
      snapshot,
    };
  }

  #legacyChatInput({ messages, system, prompt }) {
    const input = {};
    if (system != null && String(system).length) input.system = String(system);
    if (Array.isArray(messages) && messages.length) input.messages = messages;
    if (prompt != null) input.prompt = String(prompt);
    return input;
  }

  #legacyPromptParams(params, prompt) {
    const merged = { ...(params && typeof params === "object" ? params : {}) };
    if (merged.prompt == null && prompt != null) merged.prompt = String(prompt);
    return merged;
  }

  #legacySpeechParams(params, prompt) {
    const merged = this.#legacyPromptParams(params, prompt);
    if (merged.input == null && prompt != null) merged.input = String(prompt);
    return merged;
  }

  /**
   * W6c · 单个参考素材：渲染层 { dataUrl | base64, mime, name } → legacy 执行器
   * 期望的 { buf: Buffer, mime, name }（EditImageInput / GenVideoReference）。
   * 进程内直接传 Buffer 时原样保留；没有二进制载荷时保持原对象（publicUrl 等既有引用形态）。
   */
  #legacyReference(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, error: modelDomain.ERROR_CODE.INVALID_INPUT, detail: "invalid-legacy-reference" };
    }
    if (input.buf != null) {
      const buf = Buffer.isBuffer(input.buf) ? input.buf : input.buf instanceof Uint8Array ? Buffer.from(input.buf) : null;
      if (!buf) return { ok: false, error: modelDomain.ERROR_CODE.INVALID_INPUT, detail: "invalid-legacy-reference-buffer" };
      return { ok: true, value: { ...input, buf } };
    }
    const hasDataUrl = input.dataUrl != null;
    const hasBase64 = input.base64 != null;
    if (!hasDataUrl && !hasBase64) return { ok: true, value: input };
    let payload;
    let dataMime = "";
    if (hasBase64) {
      if (typeof input.base64 !== "string") return { ok: false, error: modelDomain.ERROR_CODE.INVALID_INPUT, detail: "invalid-legacy-reference-base64" };
      payload = input.base64;
    } else {
      if (typeof input.dataUrl !== "string") return { ok: false, error: modelDomain.ERROR_CODE.INVALID_INPUT, detail: "invalid-legacy-reference-data-url" };
      const parsed = parseLegacyDataUrl(input.dataUrl);
      if (!parsed) return { ok: false, error: modelDomain.ERROR_CODE.INVALID_INPUT, detail: "invalid-legacy-reference-data-url" };
      payload = parsed.payload;
      dataMime = parsed.mime;
    }
    const buf = decodeLegacyBase64(payload);
    if (!buf) return { ok: false, error: modelDomain.ERROR_CODE.INVALID_INPUT, detail: "invalid-legacy-reference-base64" };
    const mime = String(input.mime || dataMime || "application/octet-stream");
    const name = input.name == null || input.name === "" ? "reference." + (MEDIA_EXT[mime.split(";")[0]] || "bin") : String(input.name);
    const value = { ...input, buf, mime, name };
    delete value.dataUrl;
    delete value.base64;
    return { ok: true, value };
  }

  #legacyReferences(list) {
    const values = [];
    for (const item of Array.isArray(list) ? list : []) {
      const decoded = this.#legacyReference(item);
      if (!decoded.ok) return decoded;
      values.push(decoded.value);
    }
    return { ok: true, values };
  }

  #legacyUnavailable(result) {
    return !!(result && typeof result === "object" && result.ok === false);
  }

  #projectArtifact(saved) {
    if (!saved) return null;
    return { fileName: path.basename(saved.mediaPath), mime: saved.mime, bytes: saved.bytes };
  }

  /** legacy GenImage { type:'b64'|'url', value } / 媒体 { type:'url', value } → 落盘投影。 */
  async #saveLegacyItems(items, kind, signal) {
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
      const value = item && item.value != null ? item.value : item && item.url;
      if (value == null || value === "") continue;
      if (kind === "image" && item.type === "b64") {
        const mime = "image/png";
        const saved = this.#saveArtifact(Buffer.from(String(value), "base64"), mime);
        if (saved) out.push(this.#projectArtifact(saved));
        else out.push({ dataUrl: "data:" + mime + ";base64," + String(value) });
        continue;
      }
      const saved = await this.#saveRemoteArtifact(String(value), signal);
      out.push(saved ? this.#projectArtifact(saved) : { url: String(value), saved: false });
    }
    return out;
  }

  #safeDetail(error, secret) {
    const raw = String((error && error.message) || error || "").slice(0, 400);
    return modelDomain.redactSecrets(raw, [secret]);
  }

  #legacyErrorCode(error, signal) {
    if (signal && signal.aborted) return modelDomain.ERROR_CODE.CANCELLED;
    const name = String((error && error.name) || "");
    const message = String((error && error.message) || "");
    if (name === "TimeoutError") return modelDomain.ERROR_CODE.MODEL_TIMEOUT;
    if (/超时|timeout/i.test(message)) return modelDomain.ERROR_CODE.MODEL_TIMEOUT;
    if (/HTTP 401|HTTP 403/.test(message)) return modelDomain.ERROR_CODE.AUTH_FAILED;
    if (/HTTP 429/.test(message)) return modelDomain.ERROR_CODE.RATE_LIMITED;
    if (/HTTP 404/.test(message)) return modelDomain.ERROR_CODE.MODEL_NOT_FOUND;
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|ENETUNREACH|network/i.test(message)) return modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE;
    return modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR;
  }

  // ---------- 内部 ----------

  async #fetch(request, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), Math.max(this.timeoutMs, 60000));
    const onAbort = () => controller.abort(signal && signal.reason);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.fetchImpl(request.url, {
        method: request.method, headers: request.headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal, redirect: request.redirect || "error",
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  async #readSse(response, onEvent, signal) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCalls = [];
    let usage = null;
    onEvent({ type: "response.start" });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let obj; try { obj = JSON.parse(data); } catch { continue; }
          if (obj.usage) { usage = adapter.mapUsage(obj.usage); onEvent({ type: "usage", usage }); }
          const choice = obj.choices && obj.choices[0];
          if (choice && choice.delta) {
            if (choice.delta.content) { text += choice.delta.content; onEvent({ type: "text.delta", text: choice.delta.content }); }
            if (choice.delta.tool_calls) {
              for (const delta of choice.delta.tool_calls) {
                const idx = Number(delta.index || 0);
                const current = toolCalls[idx] || (toolCalls[idx] = { id: delta.id || null, type: "function", function: { name: "", arguments: "" } });
                if (delta.id) current.id = delta.id;
                if (delta.function && delta.function.name) current.function.name += delta.function.name;
                if (delta.function && delta.function.arguments) current.function.arguments += delta.function.arguments;
              }
              onEvent({ type: "tool_call.delta" });
            }
          }
        }
      }
    } catch (error) {
      if (signal && signal.aborted) { onEvent({ type: "response.error", error: "CANCELLED", partial: text }); throw Object.assign(new Error("cancelled"), { name: "AbortError" }); }
      onEvent({ type: "response.error", error: "PARTIAL_RESPONSE", partial: text });
      throw Object.assign(new Error("partial"), { name: "PartialError" });
    }
    onEvent({ type: "response.complete" });
    return { text, toolCalls: toolCalls.filter(Boolean), usage };
  }

  /**
   * W5：把内部流式 onEvent 统一封装成 <domain>:event 信封后下发。
   * 调用方自己的 onEvent 仍逐字收到原始事件（既有测试 / 探针依赖它），
   * 任何一个回调抛错都不得改变流式结果。
   */
  #streamSink(onEvent) {
    const legacy = typeof onEvent === "function" ? onEvent : null;
    return (raw) => {
      if (legacy) { try { legacy(raw); } catch { /* 调用方回调失败不影响流 */ } }
      if (!this.emit) return;
      try { this.emit(this.#toDownstreamEvent(raw)); } catch { /* 下发失败不影响流 */ }
    };
  }

  /** 流式事件 → P1 信封：普通事件 progress，错误事件 log（kind 只允许 progress|log|approval）。 */
  #toDownstreamEvent(raw) {
    const type = raw && raw.type != null ? String(raw.type) : "unknown";
    if (type === "response.error") {
      return this.eventChannel.log("error", "provider stream error: " + String((raw && raw.error) || type), {
        type,
        partial: raw && raw.partial != null ? String(raw.partial).slice(0, 4000) : null,
      });
    }
    const payload = { type };
    if (type === "text.delta") payload.text = String((raw && raw.text) == null ? "" : raw.text);
    else if (type === "usage") payload.usage = (raw && raw.usage) || null;
    return this.eventChannel.progress(payload);
  }

  #saveArtifact(buffer, mime) {
    if (!this.mediaDir) return null;
    const ext = MEDIA_EXT[String(mime).split(";")[0]] || "bin";
    fs.mkdirSync(this.mediaDir, { recursive: true });
    const name = "img_" + this.clock() + "_" + crypto.randomBytes(6).toString("hex") + "." + ext;
    const file = path.join(this.mediaDir, name);
    fs.writeFileSync(file, buffer, { mode: 0o600 });
    return { mediaPath: file, mime: String(mime).split(";")[0], bytes: buffer.length };
  }

  async #saveRemoteArtifact(url, signal) {
    if (!this.mediaDir) return null;
    try {
      const { downloadProtocolArtifact } = require("./protocol-engine/artifactDownload.cjs");
      const downloaded = await downloadProtocolArtifact(url, { maxBytes: 64 * 1024 * 1024, timeoutMs: 120000 });
      const saved = this.#saveArtifact(Buffer.from(downloaded.data), downloaded.mime || "application/octet-stream");
      return saved ? { ...saved, sourceUrl: downloaded.sourceUrl } : null;
    } catch (error) {
      if (signal && signal.aborted) throw error;
      return null;
    }
  }

  #safeSnapshot(provider, model) {
    return { providerId: provider.id, providerName: provider.name, protocol: provider.protocol, model };
  }

  #record(entry) {
    try { if (this.logger && typeof this.logger.log === "function") this.logger.log({ scope: "provider-protocol", ...entry, at: this.clock() }); } catch { /* 审计失败不影响调用 */ }
  }

  #errorFromException(error, signal) {
    if (signal && signal.aborted) return modelDomain.ERROR_CODE.CANCELLED;
    const name = String((error && error.name) || "");
    const message = String((error && error.message) || "");
    if (name === "AbortError" && message.includes("timeout")) return modelDomain.ERROR_CODE.MODEL_TIMEOUT;
    if (name === "TimeoutError") return modelDomain.ERROR_CODE.MODEL_TIMEOUT;
    if (name === "PartialError") return modelDomain.ERROR_CODE.PARTIAL_RESPONSE;
    return modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE;
  }
}

function createProviderProtocolBundle({ userDataDir = null, store = null, fetchImpl = fetch, clock = () => Date.now(), logger = null, safeStorage = null, backend = null, timeoutMs = 30000, emit = null, eventDomain = "model" } = {}) {
  const providerProtocolStore = store || createProviderProtocolStore({ userDataDir, safeStorage, backend, clock: () => Math.floor(clock() / 1000) || undefined });
  if (userDataDir) {
    repository.configureProtocolRepository({
      storeFile: path.join(String(userDataDir), "dxos", "custom-protocols-v2.json"),
      packageDirs: [path.join(String(userDataDir), "dxos", "protocol-packages")],
    });
    flags.configureProtocolFlagsFile(path.join(String(userDataDir), "dxos", "protocol-execution-flags.json"));
  }
  const service = new ProviderProtocolService({ store: providerProtocolStore, userDataDir, fetchImpl, clock, logger, timeoutMs, emit, eventDomain });
  const manifest = createModelManifestService({ repository });
  service.manifest = manifest;
  return { store: providerProtocolStore, service, manifest };
}

module.exports = { ProviderProtocolService, createProviderProtocolBundle };
