"use strict";
/**
 * P2 · <userData>/dxos/providers.json 读写。
 *
 * 结构保持 DX OS 原样（DXSRC/store.ts:34-54 Provider / :24-32 ModelEntry，
 * 文件本身是 Provider[] 数组，DXSRC/store.ts:161-166 用 JSON.parse 读数组）。
 * 差异只有一处、且是硬约束要求：api_key / wallet_api_key 的**真值**不落 JSON，
 * 统一写空串，真密钥走 electron/credential-store.cjs 的 safeStorage backend
 * （credential-store.cjs:11-22 safeStorageCredentialBackend）。
 * 对外投影与 DX OS 完全一致：has_key / key_mask / has_wallet_key / wallet_key_mask
 * （DXSRC/store.ts:287-303）。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const domain = require("./provider-protocol-domain.cjs");
const { safeStorageCredentialBackend } = require("./credential-store.cjs");

const now = () => Math.floor(Date.now() / 1000);

function normalizeModels(models) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(models) ? models : []) {
    const item = typeof raw === "string" ? { model: raw } : (raw && typeof raw === "object" ? raw : null);
    if (!item) continue;
    const name = String(item.model || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const caps = Array.isArray(item.caps) ? item.caps.map((c) => String(c).trim()).filter(Boolean) : [];
    out.push({
      model: name,
      ...(String(item.name || item.label || "").trim() ? { name: String(item.name || item.label).trim() } : {}),
      caps: caps.length ? caps : ["llm"],
      protocol: String(item.protocol || "").trim().toLowerCase(),
      ...(item.cap_sort && typeof item.cap_sort === "object" ? { cap_sort: item.cap_sort } : {}),
      ...(item.pricing && typeof item.pricing === "object" && !Array.isArray(item.pricing) ? { pricing: item.pricing } : {}),
    });
  }
  return out;
}

/** 读入时把 DX 形状补齐；api_key 永远来自 backend，不信任 JSON 里的值。 */
function normalizeProvider(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    id: String(value.id || "").trim(),
    name: String(value.name || "").trim(),
    base_url: String(value.base_url || "").trim(),
    protocol: String(value.protocol || "openai").trim().toLowerCase(),
    ...(value.source ? { source: String(value.source) } : {}),
    ...(value.cli_tool ? { cli_tool: String(value.cli_tool) } : {}),
    custom_protocols: Array.isArray(value.custom_protocols) ? value.custom_protocols.map(String).slice(0, 30) : [],
    // 只有显式为 true 才落字段：既有站点（未勾选）的 providers.json 形状逐字不变。
    ...(value.allow_insecure_http === true ? { allow_insecure_http: true } : {}),
    models: normalizeModels(value.models),
    enabled: value.enabled !== false,
    sort: Number.isFinite(Number(value.sort)) ? Number(value.sort) : 0,
    created_ts: Number(value.created_ts) || now(),
    updated_ts: Number(value.updated_ts) || now(),
  };
}

function slugify(text) {
  const s = String(text || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "api-" + now();
}

function uniqueId(base, list) {
  const taken = new Set(list.map((item) => item.id));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(base + "-" + index)) index += 1;
  return base + "-" + index;
}

class ProviderProtocolStore {
  constructor({ file = null, backend = null, clock = now } = {}) {
    this.file = file ? String(file) : null;
    this.backend = backend || null;
    this.clock = typeof clock === "function" ? clock : now;
    this.cache = null;
  }

  credentialKey(id, kind = "api_key") { return "dxprov:" + String(id) + ":" + kind; }

  secretAvailable() { return !!this.backend && this.backend.available() === true; }

  readFile() {
    if (!this.file || !fs.existsSync(this.file)) return [];
    for (const candidate of [this.file, this.file + ".bak"]) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (Array.isArray(parsed)) return parsed;
      } catch { /* 主文件损坏时读备份 */ }
    }
    return [];
  }

  load() {
    if (this.cache) return this.cache;
    this.cache = this.readFile().map(normalizeProvider).filter((provider) => provider.id);
    return this.cache;
  }

  persist() {
    const list = this.load();
    const stored = list.map((provider) => ({
      ...provider,
      api_key: "",
      wallet_api_key: "",
    }));
    // 明文防线：无论调用方给过什么，落盘前再断言一次。
    const serialized = JSON.stringify(stored, null, 2);
    if (/"api_key"\s*:\s*"(?!")/.test(serialized) || /"wallet_api_key"\s*:\s*"(?!")/.test(serialized)) {
      throw new Error("providers.json 拒绝写入非空 api_key");
    }
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + ".bak");
    } catch { /* 备份失败不阻塞写入 */ }
    const temporary = this.file + "." + process.pid + ".tmp";
    fs.writeFileSync(temporary, serialized + "\n", "utf8");
    fs.renameSync(temporary, this.file);
  }

  /** 内部视图：api_key/wallet_api_key 从 safeStorage backend 解出，只在本进程内使用。 */
  get(id) {
    const provider = this.load().find((item) => item.id === String(id));
    if (!provider) return null;
    return {
      ...provider,
      api_key: this.secretAvailable() ? (this.backend.get(this.credentialKey(provider.id, "api_key")) || "") : "",
      wallet_api_key: this.secretAvailable() ? (this.backend.get(this.credentialKey(provider.id, "wallet_api_key")) || "") : "",
    };
  }

  listPublic() {
    return this.listInternal().map((provider) => {
      const { api_key, wallet_api_key, ...rest } = provider;
      return {
        ...rest,
        has_key: !!api_key,
        key_mask: domain.maskSecret(api_key),
        has_wallet_key: !!wallet_api_key,
        wallet_key_mask: domain.maskSecret(wallet_api_key || ""),
      };
    });
  }

  /** 渲染层可见视图：**绝不回传 base_url 之外的凭据**；base_url 供设置页编辑。 */
  listInternal() {
    return this.load().map((provider) => this.get(provider.id));
  }

  create({ name, baseUrl, protocol = "openai", models = [], source, cliTool, enabled = true, apiKey = "", walletApiKey = "" } = {}) {
    const list = this.load();
    const id = uniqueId(slugify(name), list);
    const timestamp = this.clock();
    const provider = normalizeProvider({
      id, name: name || id, base_url: baseUrl, protocol,
      ...(source ? { source } : {}), ...(cliTool ? { cli_tool: cliTool } : {}),
      models, enabled, sort: list.length + 1, created_ts: timestamp, updated_ts: timestamp,
    });
    list.push(provider);
    this.persist();
    if (apiKey) this.setKeys(id, { apiKey });
    if (walletApiKey) this.setKeys(id, { walletApiKey });
    return this.get(id);
  }

  update(id, { name, baseUrl, protocol, models, enabled, customProtocols } = {}) {
    const provider = this.load().find((item) => item.id === String(id));
    if (!provider) return null;
    if (name != null) provider.name = String(name);
    if (baseUrl != null) provider.base_url = String(baseUrl);
    if (protocol != null) provider.protocol = String(protocol).trim().toLowerCase();
    if (models != null) provider.models = normalizeModels(models);
    if (enabled != null) provider.enabled = !!enabled;
    if (customProtocols != null) provider.custom_protocols = customProtocols.map(String).slice(0, 30);
    provider.updated_ts = this.clock();
    this.persist();
    return this.get(id);
  }

  setEnabled(id, enabled) { return this.update(id, { enabled }); }

  setKeys(id, { apiKey, walletApiKey, clearApiKey = false, clearWalletApiKey = false } = {}) {
    const provider = this.load().find((item) => item.id === String(id));
    if (!provider) return null;
    if (clearApiKey) this.backend && this.backend.delete(this.credentialKey(id, "api_key"));
    else if (apiKey !== undefined) {
      if (!this.secretAvailable()) throw new Error("credential-backend-unavailable");
      this.backend.put(this.credentialKey(id, "api_key"), String(apiKey));
    }
    if (clearWalletApiKey) this.backend && this.backend.delete(this.credentialKey(id, "wallet_api_key"));
    else if (walletApiKey !== undefined) {
      if (!this.secretAvailable()) throw new Error("credential-backend-unavailable");
      this.backend.put(this.credentialKey(id, "wallet_api_key"), String(walletApiKey));
    }
    provider.updated_ts = this.clock();
    this.persist();
    return this.get(id);
  }

  /** 兼容 DXSRC/store.ts:580-594 setProviderKeys 的键位语义（只改本函数，不动原模块）。 */
  setProviderKeys(id, values) { return this.setKeys(id, values); }

  /* ── 单向镜像事务原语（ModelStore → providers.json，model-provider-bridge.cjs 专用）──
   * 镜像必须"全成或全回滚"：先快照整表，失败时 replaceProviders 回滚。
   * 只暴露给桥接模块；普通 UI 路径仍走 create/update/setKeys/remove。 */

  snapshotProviders() { return JSON.parse(JSON.stringify(this.load())); }

  replaceProviders(list) {
    this.cache = (Array.isArray(list) ? list : []).map(normalizeProvider).filter((provider) => provider.id);
    this.persist();
  }

  /**
   * 按**显式 id** upsert（不 slugify、不按名字猜），保留既有 created_ts / sort；
   * id 由桥接模块的持久映射决定（ModelStore prv_* ↔ providers.json id）。
   * api_key / wallet_api_key 依旧不落 JSON（persist 里的二次断言）。
   */
  upsertById(id, { name, baseUrl, protocol, models, enabled, source, cliTool, allowInsecureHttp } = {}) {
    const key = String(id || "").trim();
    if (!key) throw new Error("upsertById 需要显式 id");
    const list = this.load();
    const existing = list.find((item) => item.id === key);
    if (existing) {
      if (name != null) existing.name = String(name);
      if (baseUrl != null) existing.base_url = String(baseUrl);
      if (protocol != null) existing.protocol = String(protocol).trim().toLowerCase();
      if (models != null) existing.models = normalizeModels(models);
      if (enabled != null) existing.enabled = !!enabled;
      if (source != null) existing.source = String(source);
      if (cliTool != null) existing.cli_tool = String(cliTool);
      // 显式同步「明文放行」：置位/清零都必须落到 providers.json，否则技能/短剧出口仍按旧标记放行。
      if (allowInsecureHttp != null) {
        if (allowInsecureHttp === true) existing.allow_insecure_http = true;
        else delete existing.allow_insecure_http;
      }
      existing.updated_ts = this.clock();
    } else {
      const timestamp = this.clock();
      list.push(normalizeProvider({
        id: key, name: name || key, base_url: baseUrl, protocol: protocol || "openai",
        ...(source ? { source } : {}), ...(cliTool ? { cli_tool: cliTool } : {}),
        ...(allowInsecureHttp === true ? { allow_insecure_http: true } : {}),
        models, enabled: enabled !== false, sort: list.length + 1, created_ts: timestamp, updated_ts: timestamp,
      }));
    }
    this.persist();
    return this.get(key);
  }

  remove(id) {
    const list = this.load();
    const index = list.findIndex((item) => item.id === String(id));
    if (index < 0) return false;
    list.splice(index, 1);
    if (this.backend) {
      this.backend.delete(this.credentialKey(id, "api_key"));
      this.backend.delete(this.credentialKey(id, "wallet_api_key"));
    }
    this.persist();
    return true;
  }

  reorder(ids) {
    const order = new Map((Array.isArray(ids) ? ids : []).map((id, index) => [String(id), index + 1]));
    for (const provider of this.load()) {
      const next = order.get(provider.id);
      if (next) provider.sort = next;
    }
    this.persist();
    return this.listPublic();
  }

  resetCache() { this.cache = null; }
}

function createProviderProtocolStore({ userDataDir = null, safeStorage = null, backend = null, clock = now } = {}) {
  const file = userDataDir ? path.join(String(userDataDir), "dxos", "providers.json") : null;
  const resolvedBackend = backend || (safeStorage ? safeStorageCredentialBackend({ safeStorage, dir: path.join(String(userDataDir), "dxos") }) : null);
  return new ProviderProtocolStore({ file, backend: resolvedBackend, clock });
}

module.exports = { ProviderProtocolStore, createProviderProtocolStore, normalizeProvider, normalizeModels, slugify, uniqueId };
