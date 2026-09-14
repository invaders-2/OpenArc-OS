/**
 * D4-01 · Model Service。Provider/Model/Credential/Default/Resolution/调用。
 * 授权复用 D3 Identity + App Principal + App Grant（resource_type='model'）。无第二套 ACL。
 */
"use strict";
const crypto = require("node:crypto");
const domain = require("./model-domain.cjs");
const adapter = require("./provider-adapter.cjs");

class ModelService {
  constructor({ identity, authService, authStore, modelStore, credentialStore, fetchImpl = fetch, logger = null, timeoutMs = 30000 } = {}) {
    this.identity = identity; this.authService = authService; this.authStore = authStore;
    this.store = modelStore; this.credentials = credentialStore; this.fetchImpl = fetchImpl;
    this.logger = logger; this.timeoutMs = timeoutMs;
  }
  #now() { return this.store.clock(); }
  #actor(context) { return this.authService.resolveActor({ context }); }

  #authorize({ context, action, config = null, provider = null, requireApp = true }) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    const appId = context && context.appId ? String(context.appId) : null;
    if (!appId) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    const app = this.authStore.appById(appId);
    if (!app || String(app.status).toLowerCase() !== "enabled") return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    if (requireApp) {
      const grants = this.authStore.appGrantsForApp(appId).filter((g) => g.resource_type === "model");
      const canApp = grants.some((g) => domain.modelGrantActions(g).includes(action));
      if (!canApp) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    }
    if (action === domain.MODEL_ACTIONS.MANAGE && config && config.scope === "ORGANIZATION" && !actor.isSuper) {
      return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    }
    if (config && config.scope === "PERSONAL" && config.owner_user_id && config.owner_user_id !== actor.user.id) {
      return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    }
    if (provider && provider.scope === "PERSONAL" && provider.owner_user_id && provider.owner_user_id !== actor.user.id) {
      return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    }
    return { ok: true, actor, app };
  }

  /** App 的 Model 权限：复用同一张 App Grant 表，只换 action namespace（不是第二套 ACL）。 */
  grantAppModelAccess({ context, appId, actions = [] } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    if (!actor.isSuper) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    const app = this.authStore.appById(appId);
    if (!app) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const acts = (actions || []).map(String).filter((a) => domain.MODEL_ACTIONS_ALL.includes(a));
    if (!acts.length) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const result = this.authStore.transactSync(() => this.authStore.upsertAppGrant({ appId, resourceType: "model", actions: acts, grantedBy: actor.user.id, organizationId: actor.organizationId }));
    this.authStore.auditAuthorization({ actorUserId: actor.user.id, targetUserId: null, appId, departmentId: null, resourceRef: null, action: "model.grantAppAccess", decision: "ALLOW", reasonCode: "ALLOW", permissionSource: "SUPER_ADMIN", oldPermissions: [], newPermissions: acts });
    return { ok: true, created: result.created, grant: { appId, actions: acts, resourceType: "model" } };
  }
  revokeAppModelAccess({ context, grantId } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    if (!actor.isSuper) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    return { ok: true, ...this.authStore.transactSync(() => this.authStore.revokeAppGrant(grantId)) };
  }

  // ---- Provider ----
  createProvider({ context, displayName, baseUrl, adapterType = "openai-compatible", endpointScope, allowLan = false, scope = "PERSONAL", credentialSecret = null }) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    // App 必须持有 model.manage（不是只校验 User）；否则 Provider mutation DENY。
    const appAuth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider: null });
    if (!appAuth.ok) return appAuth;
    if (scope === "ORGANIZATION" && !actor.isSuper) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    const ep = domain.validateEndpoint(baseUrl, { allowLan: allowLan || endpointScope === domain.ENDPOINT_SCOPE.LAN_EXPLICIT });
    if (!ep.ok) return ep;
    let credentialRef = null;
    if (credentialSecret) {
      const c = this.credentials.createSync({ ownerUserId: actor.user.id, organizationId: actor.organizationId, scope, providerOrigin: ep.origin, providerConfigId: null, secret: credentialSecret });
      if (!c.ok) return c;
      credentialRef = c.credentialRef;
    }
    const provider = this.store.transactSync(() => this.store.insertProvider({ organizationId: actor.organizationId, ownerUserId: actor.user.id, scope, displayName, adapterType, baseUrl: ep.url, endpointScope: ep.scope, credentialRef }));
    return { ok: true, provider: this.#safeProvider(provider) };
  }
  listProviders({ context }) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED, items: [] };
    return { ok: true, items: this.store.providersOfOrg(actor.organizationId).filter((p) => p.scope === "ORGANIZATION" || p.owner_user_id === actor.user.id).map((p) => this.#safeProvider(p)) };
  }
  updateProvider({ context, providerId, displayName, baseUrl, endpointScope, status, allowLan = false, credentialSecret }) {
    const provider = this.store.providerById(providerId);
    if (!provider) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider });
    if (!auth.ok) return auth;
    let ep = null;
    if (baseUrl || endpointScope) {
      ep = domain.validateEndpoint(baseUrl || provider.base_url, { allowLan: allowLan || endpointScope === domain.ENDPOINT_SCOPE.LAN_EXPLICIT });
      if (!ep.ok) return ep;
    }
    if (credentialSecret) {
      // Endpoint change 必须显式 rebind：旧 credential 不得自动发往新 origin
      const cred = this.credentials.createSync({ ownerUserId: auth.actor.user.id, organizationId: auth.actor.organizationId, scope: provider.scope, providerOrigin: (ep ? ep.origin : provider.base_url), providerConfigId: providerId, secret: credentialSecret });
      if (!cred.ok) return cred;
      this.store.transactSync(() => this.store.setProviderCredential(providerId, cred.credentialRef));
    }
    const updated = this.store.transactSync(() => this.store.updateProvider(providerId, { displayName, adapterType: provider.adapter_type, baseUrl: ep ? ep.url : null, endpointScope: ep ? ep.scope : null, status, credentialRef: undefined }));
    return { ok: true, provider: this.#safeProvider(updated) };
  }
  deleteProvider({ context, providerId }) {
    const provider = this.store.providerById(providerId);
    if (!provider) return { ok: true, changed: false };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider });
    if (!auth.ok) return auth;
    return { ok: true, ...this.store.transactSync(() => this.store.deleteProvider(providerId)) };
  }

  // ---- Model ----
  createModel({ context, providerId, remoteModelId, displayName = "", capabilities = [], scope = "PERSONAL" }) {
    const provider = this.store.providerById(providerId);
    if (!provider) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider });
    if (!auth.ok) return auth;
    const caps = domain.validateCapabilities(capabilities);
    const config = this.store.transactSync(() => this.store.insertConfig({ providerId, organizationId: auth.actor.organizationId, ownerUserId: auth.actor.user.id, scope, displayName, remoteModelId, capabilities: caps }));
    return { ok: true, model: this.#safeConfig(config) };
  }
  listModels({ context }) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED, items: [] };
    return { ok: true, items: this.store.configsOfOrg(actor.organizationId).filter((c) => c.scope === "ORGANIZATION" || c.owner_user_id === actor.user.id).map((c) => this.#safeConfig(c)) };
  }
  updateModel({ context, configId, displayName, capabilities } = {}) {
    const config = this.store.configById(configId);
    if (!config) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, config });
    if (!auth.ok) return auth;
    const caps = capabilities == null ? null : domain.validateCapabilities(capabilities);
    return { ok: true, model: this.#safeConfig(this.store.transactSync(() => this.store.updateConfig(configId, { displayName, capabilities: caps }))) };
  }

  setModelStatus({ context, configId, status }) {
    const config = this.store.configById(configId);
    if (!config) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, config });
    if (!auth.ok) return auth;
    return { ok: true, model: this.#safeConfig(this.store.transactSync(() => this.store.updateConfig(configId, { status }))) };
  }
  setVerifiedCapabilities({ context, configId, verifiedCapabilities }) {
    const config = this.store.configById(configId);
    if (!config) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.TEST, config });
    if (!auth.ok) return auth;
    const vc = domain.validateCapabilities(verifiedCapabilities);
    return { ok: true, model: this.#safeConfig(this.store.transactSync(() => this.store.updateConfig(configId, { verifiedCapabilities: vc }))) };
  }

  // ---- Defaults / resolution ----
  setDefault({ context, capability, configId, scope = "PERSONAL" }) {
    const config = this.store.configById(configId);
    if (!config) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    if (scope === "ORGANIZATION" && !actor.isSuper) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    if (scope === "PERSONAL" && config.scope === "ORGANIZATION") { /* allow */ }
    if (scope === "PERSONAL") this.store.transactSync(() => this.store.setDefault({ organizationId: actor.organizationId, ownerUserId: actor.user.id, capability, configId }));
    else this.store.transactSync(() => this.store.setDefault({ organizationId: actor.organizationId, ownerUserId: "", capability, configId }));
    return { ok: true, capability, configId, scope };
  }

  /** Resolution: Personal explicit → Authorized Organization default → UNAVAILABLE。 */
  resolveModel({ context, capability = "chat", configId = null } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    let config = null; let source = null;
    if (configId) {
      config = this.store.configById(configId);
      if (!config) return { ok: false, error: domain.ERROR_CODE.MODEL_CONFIG_UNAVAILABLE };
      source = "EXPLICIT";
    } else {
      const personal = this.store.defaultOf({ organizationId: actor.organizationId, ownerUserId: actor.user.id, capability });
      if (personal) { config = this.store.configById(personal.config_id); source = "PERSONAL_DEFAULT"; }
      if (!config) {
        const org = this.store.defaultOf({ organizationId: actor.organizationId, ownerUserId: "", capability });
        if (org) { config = this.store.configById(org.config_id); source = "ORGANIZATION_DEFAULT"; }
      }
    }
    if (!config) return { ok: false, error: domain.ERROR_CODE.MODEL_CONFIG_UNAVAILABLE };
    if (config.status !== "enabled") return { ok: false, error: domain.ERROR_CODE.MODEL_CONFIG_UNAVAILABLE };
    const caps = JSON.parse(config.capabilities || "[]");
    if (!caps.includes(capability)) return { ok: false, error: domain.ERROR_CODE.CAPABILITY_UNAVAILABLE };
    const provider = this.store.providerById(config.provider_id);
    if (!provider || provider.status !== "enabled") return { ok: false, error: domain.ERROR_CODE.MODEL_CONFIG_UNAVAILABLE };
    // 显式 Personal config 失败不得偷偷 fallback 到 Team
    if (source === "EXPLICIT" || source === "PERSONAL_DEFAULT") {
      const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.USE, config, provider });
      if (!auth.ok) return auth;
    } else {
      const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.USE, config, provider });
      if (!auth.ok) return auth;
    }
    return { ok: true, snapshot: { userId: actor.user.id, modelConfigId: config.config_id, modelConfigVersion: config.version, providerId: provider.provider_id, modelId: config.remote_model_id, capabilities: caps, verifiedCapabilities: JSON.parse(config.verified_capabilities || "[]"), baseUrl: provider.base_url, endpointScope: provider.endpoint_scope, adapterType: provider.adapter_type, credentialRef: provider.credential_ref, source, scope: config.scope } };
  }

  // ---- Credentials (write-only) ----
  createCredentialSync(input) { return this.credentials.createSync(input); }
  replaceCredential(input) { return this.credentials.replaceSync(input); }
  deleteCredential(input) { return this.credentials.deleteSync(input); }
  credentialStatus({ context, credentialRef }) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    const meta = this.store.credentialByRef(credentialRef);
    if (!meta || meta.owner_user_id !== actor.user.id) return { ok: true, configured: false };
    return { ok: true, configured: meta.status === "CONFIGURED" && this.credentials.available(), status: meta.status };
  }

  // ---- Calls ----
  async chat({ context, configId = null, messages = [], stream = false, tools = null, params = {}, signal = null, requestId = null, capability = "chat" } = {}) {
    const resolved = this.resolveModel({ context, capability, configId });
    if (!resolved.ok) return resolved;
    const snapshot = resolved.snapshot;
    const cred = this.credentials.resolveInternalSync({ credentialRef: snapshot.credentialRef });
    if (!cred.ok) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_MISSING };
    if (cred.providerOrigin !== new URL(snapshot.baseUrl).origin) return { ok: false, error: domain.ERROR_CODE.ENDPOINT_BLOCKED };
    const start = this.#now(); const rid = requestId || "mreq_" + crypto.randomBytes(8).toString("base64url");
    const cleanParams = domain.sanitizeParams(params);
    try {
      const { res } = await adapter.chat({ baseUrl: snapshot.baseUrl, apiKey: cred.secret, model: snapshot.modelId, messages, tools, params: cleanParams, stream: false, signal, timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl });
      if (!res.ok) {
        const code = domain.normalizeError({ status: res.status });
        await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "DENY", errorCode: code });
        return { ok: false, error: code };
      }
      const body = await res.json();
      const choice = body.choices && body.choices[0] ? body.choices[0] : {};
      const toolCalls = (choice.message && choice.message.tool_calls) || null;
      await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ALLOW", usage: adapter.mapUsage(body.usage) });
      return { ok: true, requestId: rid, text: (choice.message && choice.message.content) || "", toolCalls, usage: adapter.mapUsage(body.usage), snapshot: this.#safeSnapshot(snapshot) };
    } catch (err) {
      let kind;
      if (signal && signal.aborted) kind = "cancelled";
      else if (String(err && err.name) === "AbortError" || String((err && err.message) || "").includes("timeout")) kind = "timeout";
      else kind = "network";
      const code = domain.normalizeError({ kind });
      await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ERROR", errorCode: code });
      return { ok: false, error: code };
    }
  }


  /** Provider-neutral streaming（统一事件模型）；usage/错误归一化与 chat 一致。 */
  async chatStream({ context, configId = null, messages = [], tools = null, params = {}, signal = null, requestId = null, capability = "chat", onEvent = () => {} } = {}) {
    const resolved = this.resolveModel({ context, capability, configId });
    if (!resolved.ok) return resolved;
    const snapshot = resolved.snapshot;
    const cred = this.credentials.resolveInternalSync({ credentialRef: snapshot.credentialRef });
    if (!cred.ok) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_MISSING };
    if (cred.providerOrigin !== new URL(snapshot.baseUrl).origin) return { ok: false, error: domain.ERROR_CODE.ENDPOINT_BLOCKED };
    const start = this.#now(); const rid = requestId || "mreq_" + crypto.randomBytes(8).toString("base64url");
    try {
      const out = await adapter.chatStream({ baseUrl: snapshot.baseUrl, apiKey: cred.secret, model: snapshot.modelId, messages, tools, params: domain.sanitizeParams(params), signal, timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl, onEvent });
      await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ALLOW", usage: out.usage });
      return { ok: true, requestId: rid, text: out.text, toolCalls: out.toolCalls, usage: out.usage, snapshot: this.#safeSnapshot(snapshot) };
    } catch (err) {
      let kind;
      if (signal && signal.aborted) kind = "cancelled";
      else if (String(err && err.name) === "PartialError") kind = "partial";
      else if (String(err && err.name) === "TimeoutError" || String(err && err.name) === "AbortError") kind = "timeout";
      else if (String(err && err.name) === "ProviderHttpError") { const code = domain.normalizeError({ status: err.status }); await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "DENY", errorCode: code }); return { ok: false, error: code }; }
      else kind = "network";
      const code = domain.normalizeError({ kind });
      await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ERROR", errorCode: code });
      return { ok: false, error: code };
    }
  }


  // ---- Settings UI 管理入口（Renderer 只经 model:command 白名单） ----
  getDefaults({ context } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const caps = ["chat", "tool-calling", "image-generation", "video-generation", "embedding", "vision-input"];
    const personal = {}; const organization = {};
    for (const c of caps) {
      const p = this.store.defaultOf({ organizationId: actor.organizationId, ownerUserId: actor.user.id, capability: c });
      if (p) personal[c] = p.config_id;
      const o = this.store.defaultOf({ organizationId: actor.organizationId, ownerUserId: "", capability: c });
      if (o) organization[c] = o.config_id;
    }
    return { ok: true, personal, organization, canManageOrganization: actor.isSuper };
  }
  setProviderStatus({ context, providerId, status } = {}) { return this.updateProvider({ context, providerId, status }); }
  credentialStatusForProvider({ context, providerId } = {}) {
    const provider = this.store.providerById(providerId);
    if (!provider) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const meta = provider.credential_ref ? this.store.credentialByRef(provider.credential_ref) : null;
    return { ok: true, configured: !!(meta && meta.status === "CONFIGURED" && this.credentials.available()), status: meta ? meta.status : "MISSING", storeAvailable: this.credentials.available(), credentialVersion: meta ? meta.credential_version : null };
  }
  setProviderCredential({ context, providerId, secret } = {}) {
    const provider = this.store.providerById(providerId);
    if (!provider) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider });
    if (!auth.ok) return auth;
    const cred = this.credentials.createSync({ ownerUserId: auth.actor.user.id, organizationId: auth.actor.organizationId, scope: provider.scope, providerOrigin: provider.base_url, providerConfigId: providerId, secret });
    if (!cred.ok) return cred;
    this.store.transactSync(() => this.store.setProviderCredential(providerId, cred.credentialRef));
    this.authStore.auditAuthorization({ actorUserId: auth.actor.user.id, targetUserId: null, appId: context.appId, departmentId: null, resourceRef: null, action: "model.credentialCreated", decision: "ALLOW", reasonCode: "ALLOW", permissionSource: "SUPER_ADMIN", oldPermissions: [], newPermissions: [] });
    return { ok: true, credentialVersion: cred.credentialVersion, configured: true };
  }
  replaceProviderCredential({ context, providerId, secret } = {}) {
    const provider = this.store.providerById(providerId);
    if (!provider) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider });
    if (!auth.ok) return auth;
    if (!provider.credential_ref) return this.setProviderCredential({ context, providerId, secret });
    const rep = this.credentials.replaceSync({ credentialRef: provider.credential_ref, secret });
    if (!rep.ok) return rep;
    this.authStore.auditAuthorization({ actorUserId: auth.actor.user.id, targetUserId: null, appId: context.appId, departmentId: null, resourceRef: null, action: "model.credentialReplaced", decision: "ALLOW", reasonCode: "ALLOW", permissionSource: "SUPER_ADMIN", oldPermissions: [], newPermissions: [] });
    return { ok: true, credentialVersion: rep.credentialVersion, configured: true };
  }
  deleteProviderCredential({ context, providerId } = {}) {
    const provider = this.store.providerById(providerId);
    if (!provider) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider });
    if (!auth.ok) return auth;
    if (!provider.credential_ref) return { ok: true, changed: false, configured: false };
    this.credentials.deleteSync({ credentialRef: provider.credential_ref });
    this.authStore.auditAuthorization({ actorUserId: auth.actor.user.id, targetUserId: null, appId: context.appId, departmentId: null, resourceRef: null, action: "model.credentialDeleted", decision: "ALLOW", reasonCode: "ALLOW", permissionSource: "SUPER_ADMIN", oldPermissions: [], newPermissions: [] });
    return { ok: true, changed: true, configured: false };
  }
  recentCalls(limit = 50) { return this.store.recentCalls(limit); }

  async testConnection({ context, configId }) {
    const resolved = this.resolveModel({ context, configId, capability: "chat" });
    if (!resolved.ok) return resolved;
    const r = await this.chat({ context, configId, messages: [{ role: "user", content: "ping" }], capability: "chat" });
    if (r.ok) {
      this.setVerifiedCapabilities({ context, configId, verifiedCapabilities: ["chat"] });
      return { ok: true, reachable: true, credentialAccepted: true, inference: true };
    }
    return { ok: false, error: r.error, reachable: r.error !== domain.ERROR_CODE.PROVIDER_UNAVAILABLE, credentialAccepted: r.error !== domain.ERROR_CODE.AUTH_FAILED, inference: false };
  }

  async #record({ requestId, context, snapshot, startedAt, status, errorCode = null, usage = null }) {
    try {
      this.store.transactSync(() => this.store.insertCall({ requestId, userId: context && context.userId ? context.userId : null, appId: context && context.appId ? context.appId : null, providerId: snapshot.providerId, modelId: snapshot.modelId, configVersion: snapshot.modelConfigVersion, startedAt, durationMs: this.#now() - startedAt, status, errorCode, inputTokens: usage ? usage.inputTokens : null, outputTokens: usage ? usage.outputTokens : null, totalTokens: usage ? usage.totalTokens : null }));
    } catch { /* usage 记录失败不得影响调用 */ }
  }

  #safeProvider(p) { if (!p) return null; return { providerId: p.provider_id, displayName: p.display_name, adapterType: p.adapter_type, baseUrl: p.base_url, endpointScope: p.endpoint_scope, scope: p.scope, status: p.status, credentialConfigured: !!p.credential_ref, version: p.version }; }
  #safeConfig(c) { if (!c) return null; return { configId: c.config_id, providerId: c.provider_id, displayName: c.display_name, remoteModelId: c.remote_model_id, capabilities: JSON.parse(c.capabilities || "[]"), verifiedCapabilities: JSON.parse(c.verified_capabilities || "[]"), scope: c.scope, status: c.status, version: c.version }; }
  #safeSnapshot(s) { return { modelConfigId: s.modelConfigId, modelConfigVersion: s.modelConfigVersion, providerId: s.providerId, modelId: s.modelId, capabilities: s.capabilities, source: s.source }; }
}

module.exports = { ModelService };
