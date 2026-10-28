"use strict";
/**
 * D4-01 ↔ P2 · 单向镜像桥。
 *
 * 背景（缺陷 2）：「模型与服务商」写 ModelStore（identity.db），而技能 / 短剧 /
 * provider/call / image-generate / protocol 读 provider-protocol-store
 * （<userData>/dxos/providers.json + safeStorage）。两套存储互不相通，实测 providers.json
 * 自始至终不存在，于是技能报 SKILL_DEPENDENCY_UNAVAILABLE、短剧报「请先配置语言模型」，
 * 而对话 / 全局 AI / 画布（走 ModelStore）已经真实生效。
 *
 * 本桥只做**单向**镜像：ModelStore 是唯一写入源，providers.json 是只读消费面。
 * 触发点见 model-service.cjs 的 provider/create|update|setStatus|delete 与
 * credential/set|replace|delete；model/create|update|setStatus 也重新镜像该服务商的模型清单
 * （providers.json 的能力挂在 model.caps 上，不同步就选不中站点）。
 *
 * 映射：ModelStore 的 prv_* ↔ providers.json 的 id 必须**显式持久化**
 * （<userData>/dxos/model-provider-map.json），绝不按显示名 / slug 猜测；服务商改名沿用原 id。
 *
 * 密钥纪律：providers.json 里 api_key 永远空串；真值写进既有 safeStorage backend
 * （provider-protocol-store.cjs persist() 的落盘断言；credential-store.cjs:11 的同一后端）。
 *
 * 一致性：providers.json 与映射文件都用「临时文件 + rename」原子写；任一步失败即回滚
 * 已写入的 providers.json / 映射 / 密钥，返回结构化 PROVIDER_MIRROR_FAILED，绝不只写一半。
 */
const fs = require("node:fs");
const path = require("node:path");
const modelDomain = require("./model-domain.cjs");
const { slugify, uniqueId } = require("./provider-protocol-store.cjs");

const MIRROR_ERROR = "PROVIDER_MIRROR_FAILED";

/** D4-01 capability → providers.json model.caps（provider-adapter-bridge.cjs:27 的枚举 + 技能的 llm.chat.vision）。 */
const CAPABILITY_CAPS = Object.freeze({
  "chat": "llm",
  "tool-calling": "llm",
  "vision-input": "llm.chat.vision",
  "image-generation": "image",
  "video-generation": "video",
  "audio-generation": "audio",
  "embedding": "embedding",
  "3d-generation": "3d",
});

function mapCapabilities(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const mapped = CAPABILITY_CAPS[String(raw)];
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/** D4-01 adapter_type → provider-protocol 协议 id；openai-compatible 是 OpenAI 兼容族。 */
function mapProtocol(adapterType) {
  const id = String(adapterType || "").trim().toLowerCase();
  if (!id || id === "openai-compatible" || id === "openai") return "openai";
  return id;
}

class ModelProviderBridge {
  constructor({ modelStore, credentialStore = null, providerProtocol = null, userDataDir = null, clock = null, logger = null } = {}) {
    if (!modelStore) throw new Error("ModelProviderBridge 需要 modelStore");
    this.modelStore = modelStore;
    this.credentials = credentialStore;
    this.providerProtocol = providerProtocol;
    this.ppStore = providerProtocol && providerProtocol.store ? providerProtocol.store : null;
    this.logger = logger;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.mapFile = userDataDir ? path.join(String(userDataDir), "dxos", "model-provider-map.json") : null;
    this.mapping = this.#readMapping();
  }

  /** 未装配 provider-protocol-store（纯 ModelService 测试）时镜像整体跳过，不改变既有行为。 */
  available() { return !!(this.ppStore && typeof this.ppStore.upsertById === "function" && typeof this.ppStore.snapshotProviders === "function"); }

  /** ModelStore prv_* → providers.json id；未映射返回 null（provider-protocol-service 保留原 id）。 */
  resolveProviderProtocolId(providerId) {
    const mapped = this.mapping[String(providerId)];
    return mapped || null;
  }

  /** provider-protocol 后端是否可写密钥（无后端时只镜像元数据，不写 api_key）。 */
  #secretWritable() { return !!(this.ppStore && typeof this.ppStore.secretAvailable === "function" && this.ppStore.secretAvailable()); }

  #readMapping() {
    if (!this.mapFile) return {};
    for (const candidate of [this.mapFile, this.mapFile + ".bak"]) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
        const providers = parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object" ? parsed.providers : null;
        if (providers) {
          const out = {};
          for (const [key, value] of Object.entries(providers)) if (key && typeof value === "string" && value) out[String(key)] = value;
          return out;
        }
      } catch { /* 主文件损坏时读备份 */ }
    }
    return {};
  }

  #writeMapping(mapping) {
    if (!this.mapFile) return;
    fs.mkdirSync(path.dirname(this.mapFile), { recursive: true });
    const serialized = JSON.stringify({ version: 1, providers: mapping || {} }, null, 2) + "\n";
    try { if (fs.existsSync(this.mapFile)) fs.copyFileSync(this.mapFile, this.mapFile + ".bak"); } catch { /* 备份失败不阻塞写入 */ }
    const temporary = this.mapFile + "." + process.pid + ".tmp";
    fs.writeFileSync(temporary, serialized, "utf8");
    fs.renameSync(temporary, this.mapFile);
  }

  #detail(error) {
    return modelDomain.redactSecrets(String((error && error.message) || error || "mirror-failed").slice(0, 300), []);
  }

  #failure(error) { return { ok: false, error: MIRROR_ERROR, detail: this.#detail(error) }; }

  /** 已持久映射优先；没有映射才用显示名分配一个稳定 id，并立刻由调用方写入映射文件。 */
  #ppIdFor(provider) {
    const mapped = this.mapping[provider.provider_id];
    if (mapped) return mapped;
    const taken = this.ppStore.load().map((item) => ({ id: item.id }));
    return uniqueId(slugify(provider.display_name || "provider"), taken);
  }

  #configsOf(provider) {
    try { return this.modelStore.configsOfOrg(provider.organization_id).filter((config) => config && config.provider_id === provider.provider_id); }
    catch { return []; }
  }

  /** providers.json 的模型清单 = 该服务商已启用 model config 的能力投影。 */
  #modelsOf(provider) {
    const out = [];
    for (const config of this.#configsOf(provider)) {
      if (String(config.status) !== "enabled") continue;
      const caps = mapCapabilities(JSON.parse(config.capabilities || "[]"));
      if (!caps.length) continue;
      out.push({ model: String(config.remote_model_id), ...(config.display_name ? { name: String(config.display_name) } : {}), caps, protocol: "" });
    }
    return out;
  }

  /** 镜像所需密钥：只在进程内从 credential-store（safeStorage）解出，用完即弃、绝不回传。 */
  #secretOf(provider) {
    if (!provider.credential_ref) return { ok: true, secret: null };
    if (!this.credentials || typeof this.credentials.resolveInternalSync !== "function") return this.#failure(new Error("credential-store-missing"));
    try {
      const resolved = this.credentials.resolveInternalSync({ credentialRef: provider.credential_ref });
      if (!resolved || resolved.ok !== true) return this.#failure(new Error("credential-unresolvable"));
      return { ok: true, secret: String(resolved.secret) };
    } catch (error) { return this.#failure(error); }
  }

  /** 回滚需要知道镜像前两端密钥（api_key + wallet_api_key），providers.json 里两者都永远空串。 */
  #readKeys(ppId) {
    if (!this.#secretWritable()) return { apiKey: "", walletKey: "" };
    try {
      const item = this.ppStore.get(ppId);
      return item
        ? { apiKey: item.api_key ? String(item.api_key) : "", walletKey: item.wallet_api_key ? String(item.wallet_api_key) : "" }
        : { apiKey: "", walletKey: "" };
    } catch { return { apiKey: "", walletKey: "" }; }
  }

  #restoreKeys(ppId, keys) {
    const backend = this.ppStore && this.ppStore.backend ? this.ppStore.backend : null;
    if (!backend) return;
    const snapshot = keys && typeof keys === "object" ? keys : { apiKey: "", walletKey: "" };
    try {
      for (const [kind, value] of [["api_key", snapshot.apiKey], ["wallet_api_key", snapshot.walletKey]]) {
        const credentialKey = this.ppStore.credentialKey(ppId, kind);
        if (value) backend.put(credentialKey, value);
        else backend.delete(credentialKey);
      }
    } catch { /* 回滚密钥失败不掩盖原始镜像错误 */ }
  }

  /**
   * 把该 ModelStore 服务商（含模型清单与密钥）同步到 providers.json。
   * 返回 { ok:true, providerProtocolId } 或 { ok:false, error:'PROVIDER_MIRROR_FAILED', detail }。
   */
  syncProvider(providerId) {
    if (!this.available()) return { ok: true, skipped: true };
    const provider = this.modelStore.providerById(providerId);
    if (!provider) return { ok: true, skipped: true };
    const origin = modelDomain.originOf(provider.base_url);
    if (!origin) return this.#failure(new Error("invalid-base-url"));
    const ppId = this.#ppIdFor(provider);
    const secret = this.#secretOf(provider);
    if (!secret.ok) return secret;
    const descriptor = {
      name: provider.display_name || ppId,
      baseUrl: provider.base_url,
      protocol: mapProtocol(provider.adapter_type),
      models: this.#modelsOf(provider),
      enabled: String(provider.status) === "enabled",
      // SQLite 里是 INTEGER 0/1，不能与 true 严格比较；truthy 才算显式放行。
      allowInsecureHttp: !!provider.allow_insecure_http,
    };
    const beforeProviders = this.ppStore.snapshotProviders();
    const beforeMapping = { ...this.mapping };
    const beforeKeys = this.#readKeys(ppId);
    try {
      this.ppStore.upsertById(ppId, descriptor);
      if (secret.secret != null && this.#secretWritable()) this.ppStore.setKeys(ppId, { apiKey: secret.secret });
      this.mapping = { ...this.mapping, [String(providerId)]: ppId };
      this.#writeMapping(this.mapping);
      return { ok: true, providerProtocolId: ppId };
    } catch (error) {
      try { this.ppStore.replaceProviders(beforeProviders); } catch { /* 缓存回滚失败也要把映射写回 */ }
      this.#restoreKeys(ppId, beforeKeys);
      this.mapping = beforeMapping;
      try { this.#writeMapping(beforeMapping); } catch { /* 映射回滚失败不掩盖原始错误 */ }
      return this.#failure(error);
    }
  }

  /** 删除同步：providers.json 条目 / 密钥 / 映射一起删，失败整体回滚。 */
  removeProvider(providerId) {
    if (!this.available()) return { ok: true, skipped: true };
    const key = String(providerId);
    const ppId = this.mapping[key];
    if (!ppId) return { ok: true, changed: false };
    const beforeProviders = this.ppStore.snapshotProviders();
    const beforeMapping = { ...this.mapping };
    const beforeKeys = this.#readKeys(ppId);
    try {
      this.ppStore.remove(ppId);
      const next = { ...this.mapping };
      delete next[key];
      this.mapping = next;
      this.#writeMapping(next);
      return { ok: true, changed: true, providerProtocolId: ppId };
    } catch (error) {
      try { this.ppStore.replaceProviders(beforeProviders); } catch { /* 继续尽力恢复密钥与映射 */ }
      this.#restoreKeys(ppId, beforeKeys);
      this.mapping = beforeMapping;
      try { this.#writeMapping(beforeMapping); } catch { /* 映射回滚失败不掩盖原始错误 */ }
      return this.#failure(error);
    }
  }

  /** credential/delete 同步：清掉 providers.json 后端的密钥（保留条目），站点随即变为"未鉴权"。 */
  clearCredential(providerId) {
    if (!this.available()) return { ok: true, skipped: true };
    const ppId = this.mapping[String(providerId)];
    if (!ppId || !this.ppStore.get(ppId)) return { ok: true, changed: false };
    const beforeKeys = this.#readKeys(ppId);
    try {
      this.ppStore.setKeys(ppId, { clearApiKey: true });
      return { ok: true, changed: true, providerProtocolId: ppId };
    } catch (error) {
      this.#restoreKeys(ppId, beforeKeys);
      return this.#failure(error);
    }
  }
}

function createModelProviderBridge(options = {}) {
  return new ModelProviderBridge(options);
}

module.exports = { ModelProviderBridge, createModelProviderBridge, mapCapabilities, mapProtocol, MIRROR_ERROR, CAPABILITY_CAPS };
