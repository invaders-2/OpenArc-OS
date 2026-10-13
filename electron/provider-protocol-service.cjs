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

const MEDIA_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "audio/mpeg": "mp3" };

class ProviderProtocolService {
  constructor({ store, userDataDir = null, fetchImpl = fetch, clock = () => Date.now(), logger = null, timeoutMs = 30000 } = {}) {
    if (!store) throw new Error("ProviderProtocolService 需要 store");
    this.store = store;
    this.userDataDir = userDataDir ? String(userDataDir) : null;
    this.mediaDir = this.userDataDir ? path.join(this.userDataDir, "dxos", "media") : null;
    this.fetchImpl = typeof fetchImpl === "function" ? fetchImpl : fetch;
    this.clock = clock;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  // ---------- 协议表 / 校验 / 保存 ----------

  listProtocols({ kind = null, ported = null } = {}) {
    const table = domain.protocolTable(kind || undefined);
    const v2 = repository.listProtocolsV2(kind || undefined).map((entry) => ({
      id: entry.id, kind: entry.kind, label: entry.protocol.label, engine: "v2",
      source: entry.source, activeVersion: entry.activeVersion, activeHash: entry.activeHash,
      capabilities: entry.protocol.kind === "model" ? entry.protocol.capabilities : [],
      ported: true,
    }));
    const v2Keys = new Set(v2.map((item) => item.kind + ":" + item.id));
    const legacy = table.filter((item) => item.engine === "legacy" && !v2Keys.has(item.kind + ":" + item.id));
    const items = [...v2, ...legacy.map((item) => ({ id: item.id, kind: item.kind, label: item.id, engine: item.engine, source: item.source, ported: item.ported, capabilities: [] }))];
    const filtered = ported === null ? items : items.filter((item) => item.ported === ported);
    return { ok: true, items: filtered.sort((left, right) => left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind)) };
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
      const parsed = await this.#readSse(response, onEvent, signal);
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

function createProviderProtocolBundle({ userDataDir = null, store = null, fetchImpl = fetch, clock = () => Date.now(), logger = null, safeStorage = null, backend = null, timeoutMs = 30000 } = {}) {
  const providerProtocolStore = store || createProviderProtocolStore({ userDataDir, safeStorage, backend, clock: () => Math.floor(clock() / 1000) || undefined });
  if (userDataDir) {
    repository.configureProtocolRepository({
      storeFile: path.join(String(userDataDir), "dxos", "custom-protocols-v2.json"),
      packageDirs: [path.join(String(userDataDir), "dxos", "protocol-packages")],
    });
    flags.configureProtocolFlagsFile(path.join(String(userDataDir), "dxos", "protocol-execution-flags.json"));
  }
  const service = new ProviderProtocolService({ store: providerProtocolStore, userDataDir, fetchImpl, clock, logger, timeoutMs });
  const manifest = createModelManifestService({ repository });
  service.manifest = manifest;
  return { store: providerProtocolStore, service, manifest };
}

module.exports = { ProviderProtocolService, createProviderProtocolBundle };
