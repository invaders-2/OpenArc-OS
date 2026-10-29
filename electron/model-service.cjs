/**
 * D4-01 · Model Service。Provider/Model/Credential/Default/Resolution/调用。
 * 授权复用 D3 Identity + App Principal + App Grant（resource_type='model'）。无第二套 ACL。
 */
"use strict";
const crypto = require("node:crypto");
const domain = require("./model-domain.cjs");
const imageParams = require("./image-params.cjs");
const adapter = require("./provider-adapter.cjs");
// 单向镜像桥的固定错误码（装配在 model-bootstrap.cjs，未装配时镜像整体跳过）。
const { MIRROR_ERROR } = require("./model-provider-bridge.cjs");

/**
 * 模型/协议出网代理的系统级设置键。
 * 持久化落在 identity.db 既有的 system_preferences 表（dxos-foundation-schema.cjs 的 v22 DDL：
 * preference_key / preference_value / updated_by / updated_at）—— 本仓唯一既有"系统设置"存储，
 * 不新造 JSON 文件 / 不新造一套风格；与 authStore 同一条 SQLite 连接。
 */
const EGRESS_PROXY_PREF_KEY = "model.egress.proxy";

/**
 * 删除模型后镜像失败的回滚：按原字段把那一行原样插回。
 * 不用 store.insertConfig —— 它会重新分配 config_id（既有默认模型立刻悬空），
 * 且把 status/version/verified_capabilities 归一到 enabled/1/[]。
 */
const RESTORE_CONFIG_SQL = "INSERT INTO model_configs (config_id, provider_id, organization_id, owner_user_id, scope, display_name, remote_model_id, capabilities, verified_capabilities, status, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)";

/** 通用服务商没有「透明区域即编辑区」的约定说明，替它补一句 */
function editPrompt(mode, prompt) {
  const p = String(prompt || "");
  if (mode === "redraw") return "只重绘图中透明（被挖空）的区域，其余部分保持不变。重绘内容：" + p;
  if (mode === "erase") return "把图中透明（被挖空）的区域按周围环境自然补全，不要生成新物体，其余部分保持不变。" + (p ? "补充：" + p : "");
  if (mode === "outpaint") return "把图片四周透明的区域自然延展补全，和原有画面无缝衔接，原画面内容不变。" + (p ? "补充：" + p : "");
  return p;
}


/* ── 画布图片面板的「风格 / 摄影机 / 联网」 ──
 * 图像面自己的白名单（image-params.cjs）之外的三项；来源可以是 params 或 hints（hints 优先）。
 * 归一之后才进入适配器：
 *   · 对话式（SIZE_VIA_PROMPT，如 Lovart）：写进提示词的【画面要求】段，没有就不写；
 *   · 按字段的适配器（如 APIMart）：只有适配器 uiSpec 明确声明支持时才带字段，否则不发（不做假字段）。
 */
const STYLE_TEXT_MAX = 40;
const CAMERA_TEXT_MAX = 40;
const CAMERA_KEYS = Object.freeze(["body", "lens", "focal", "aperture"]);

function pickVisualCamera(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const key of CAMERA_KEYS) {
    const raw = value[key];
    if (raw == null || raw === "") continue;
    const text = String(raw).trim().slice(0, CAMERA_TEXT_MAX);
    if (text) out[key] = text;
  }
  return Object.keys(out).length ? out : null;
}

/** params/hints → { style?, camera?, webSearch? }（只保留真实提供的项）。 */
function pickVisualOptions(...sources) {
  const out = {};
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    if (typeof source.style === "string") {
      const style = source.style.trim().slice(0, STYLE_TEXT_MAX);
      if (style) out.style = style;
    }
    const camera = pickVisualCamera(source.camera);
    if (camera) out.camera = camera;
    if (source.webSearch === true) out.webSearch = true;
  }
  return out;
}

/** 摄影机 → 提示词片段（缺哪个就不写哪个，不编造参数）。 */
function cameraRequirement(camera) {
  if (!camera) return null;
  const parts = [];
  if (camera.body) parts.push("机身 " + camera.body);
  if (camera.lens) parts.push("镜头 " + camera.lens);
  if (camera.focal) parts.push("焦段 " + (/mm$/i.test(String(camera.focal)) ? String(camera.focal) : String(camera.focal) + "mm"));
  if (camera.aperture) parts.push("光圈 " + camera.aperture);
  return parts.length ? parts.join("，") : null;
}

/**
 * 把风格 / 摄影机 / 联网要求并进提示词：尺寸标题（【画面要求】）已存在就接在同一段里，
 * 没有就新起一段。没有可写的要求 → 原样返回（不凭空加）。
 */
function withVisualRequirements(prompt, visual) {
  const base = String(prompt == null ? "" : prompt);
  const clauses = [];
  if (visual && visual.style) clauses.push("风格：" + visual.style);
  const camera = cameraRequirement(visual && visual.camera);
  if (camera) clauses.push("摄影机：" + camera);
  if (visual && visual.webSearch === true) clauses.push("联网搜索参考资料后再画");
  if (!clauses.length) return base;
  const text = clauses.join("；");
  const marker = "【画面要求】";
  const index = base.lastIndexOf(marker);
  if (index >= 0) {
    const head = base.slice(0, index + marker.length);
    const tail = base.slice(index + marker.length).trimEnd();
    if (tail.endsWith("。")) return head + tail.slice(0, -1) + "；" + text + "。";
    return head + (tail ? tail + "；" : "") + text + "。";
  }
  return base + (base.trim() ? "\n\n" : "") + marker + text + "。";
}

/** 适配器 uiSpec 是否明确声明某项能力（unsupported 的规格不算支持）。 */
function specAllows(spec, flag) {
  return !!(spec && typeof spec === "object" && !spec.unsupported && spec[flag] === true);
}

class ModelService {
  constructor({ identity, authService, authStore, modelStore, credentialStore, fetchImpl = fetch, logger = null, timeoutMs = 30000 } = {}) {
    this.identity = identity; this.authService = authService; this.authStore = authStore;
    this.store = modelStore; this.credentials = credentialStore; this.fetchImpl = fetchImpl;
    this.logger = logger; this.timeoutMs = timeoutMs;
    // model-bootstrap.cjs 装配后注入；纯 ModelService 测试保持 null（行为与旧版一致）。
    this.providerBridge = null;
  }
  #now() { return this.store.clock(); }
  #actor(context) { return this.authService.resolveActor({ context }); }

  /** 单向镜像：ModelStore 服务商变更 → provider-protocol-store（providers.json）。失败给结构化错误，调用方负责回滚。 */
  #syncMirror(providerId) {
    const bridge = this.providerBridge;
    if (!bridge || typeof bridge.syncProvider !== "function") return { ok: true, skipped: true };
    try { return bridge.syncProvider(providerId); }
    catch (error) { return { ok: false, error: MIRROR_ERROR, detail: domain.redactSecrets(String((error && error.message) || error).slice(0, 300)) }; }
  }
  #removeMirror(providerId) {
    const bridge = this.providerBridge;
    if (!bridge || typeof bridge.removeProvider !== "function") return { ok: true, skipped: true };
    try { return bridge.removeProvider(providerId); }
    catch (error) { return { ok: false, error: MIRROR_ERROR, detail: domain.redactSecrets(String((error && error.message) || error).slice(0, 300)) }; }
  }
  #clearMirrorCredential(providerId) {
    const bridge = this.providerBridge;
    if (!bridge || typeof bridge.clearCredential !== "function") return { ok: true, skipped: true };
    try { return bridge.clearCredential(providerId); }
    catch (error) { return { ok: false, error: MIRROR_ERROR, detail: domain.redactSecrets(String((error && error.message) || error).slice(0, 300)) }; }
  }

  /**
   * 明文 HTTP 授权审计：沿用 authStore.auditAuthorization 的既有用法，
   * 把「该服务商显式使用明文 HTTP」这一事实连同 providerId 落进 authorization_audit。
   */
  #auditInsecureHttp({ actor, context, providerId, phase }) {
    try {
      this.authStore.auditAuthorization({
        actorUserId: actor.user.id, targetUserId: null, appId: context && context.appId ? context.appId : null,
        departmentId: null, resourceRef: String(providerId), action: "model.insecureHttpAuthorized",
        decision: "ALLOW", reasonCode: "INSECURE_HTTP_EXPLICIT", permissionSource: "EXPLICIT_USER_OPT_IN",
        oldPermissions: [], newPermissions: [phase],
      });
    } catch { /* 审计失败不影响已完成的显式放行 */ }
  }

  /** 范围变更审计：providerId / 旧值 / 新值 / 操作者，沿用 authStore.auditAuthorization。 */
  #auditScopeChange({ actor, context, providerId, from, to }) {
    try {
      this.authStore.auditAuthorization({
        actorUserId: actor.user.id, targetUserId: null, appId: context && context.appId ? context.appId : null,
        departmentId: null, resourceRef: String(providerId), action: "model.providerScopeChanged",
        decision: "ALLOW", reasonCode: "SCOPE_CHANGED", permissionSource: "SUPER_ADMIN",
        oldPermissions: [from], newPermissions: [to],
      });
    } catch { /* 审计失败不影响已完成的显式范围变更 */ }
  }

  #authorize({ context, action, config = null, provider = null, requireApp = true }) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    const appId = context && context.appId ? String(context.appId) : null;
    if (!appId) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    const app = this.authStore.appById(appId);
    if (!app || String(app.status).toLowerCase() !== "enabled") return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    if (requireApp) {
      const grants = this.authStore.appGrantsForApp(appId, actor.organizationId).filter((g) => g.resource_type === "model");
      const canApp = grants.some((g) => domain.modelGrantActions(g).includes(action));
      if (!canApp) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    }
    // Organization 资源的 manage 需要 Super Admin（provider 与 config 同一判据）
    if (action === domain.MODEL_ACTIONS.MANAGE && !actor.isSuper && ((config && config.scope === "ORGANIZATION") || (provider && provider.scope === "ORGANIZATION"))) {
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
    return { ok: true, ...this.authStore.transactSync(() => this.authStore.revokeAppGrant(grantId, { by: actor.user.id })) };
  }

  // ---- Provider ----
  createProvider({ context, displayName, baseUrl, adapterType = "openai-compatible", endpointScope, allowLan = false, allowInsecureHttp = false, scope = "PERSONAL", credentialSecret = null }) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    // App 必须持有 model.manage（不是只校验 User）；否则 Provider mutation DENY。
    const appAuth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider: null });
    if (!appAuth.ok) return appAuth;
    if (scope === "ORGANIZATION" && !actor.isSuper) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    const ep = domain.validateEndpoint(baseUrl, { allowLan: allowLan || endpointScope === domain.ENDPOINT_SCOPE.LAN_EXPLICIT, allowInsecureHttp });
    if (!ep.ok) return ep;
    const insecureHttp = ep.scope === domain.ENDPOINT_SCOPE.REMOTE_HTTP_EXPLICIT;
    let credentialRef = null;
    if (credentialSecret) {
      const c = this.credentials.createSync({ ownerUserId: actor.user.id, organizationId: actor.organizationId, scope, providerOrigin: ep.origin, providerConfigId: null, secret: credentialSecret });
      if (!c.ok) return c;
      credentialRef = c.credentialRef;
    }
    const provider = this.store.transactSync(() => this.store.insertProvider({ organizationId: actor.organizationId, ownerUserId: actor.user.id, scope, displayName, adapterType, baseUrl: ep.url, endpointScope: domain.persistableEndpointScope(ep.scope), allowInsecureHttp: insecureHttp, credentialRef }));
    const mirror = this.#syncMirror(provider.provider_id);
    if (mirror.ok !== true) {
      // 两库一致：镜像失败即撤销本次创建（含刚建的凭据），绝不只写一半
      this.store.transactSync(() => this.store.deleteProvider(provider.provider_id));
      if (credentialRef) this.credentials.deleteSync({ credentialRef });
      return mirror;
    }
    if (insecureHttp) this.#auditInsecureHttp({ actor, context, providerId: provider.provider_id, phase: "authorized" });
    return { ok: true, provider: this.#safeProvider(this.store.providerById(provider.provider_id)) };
  }
  listProviders({ context }) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED, items: [] };
    return { ok: true, items: this.store.providersOfOrg(actor.organizationId).filter((p) => p.scope === "ORGANIZATION" || p.owner_user_id === actor.user.id).map((p) => this.#safeProvider(p)) };
  }
  updateProvider({ context, providerId, displayName, baseUrl, adapterType, endpointScope, status, allowLan = false, allowInsecureHttp, credentialSecret, scope }) {
    const provider = this.store.providerById(providerId);
    if (!provider) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider });
    if (!auth.ok) return auth;
    let nextScope = null;
    if (scope !== undefined && scope !== null) {
      const requested = String(scope);
      if (requested !== "PERSONAL" && requested !== "ORGANIZATION") return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT, detail: "invalid-scope" };
      if (requested !== provider.scope) {
        // 与创建 ORGANIZATION 同口径：范围变更一律要求 Super Admin，不因"只改一个字段"放宽
        if (!auth.actor.isSuper) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
        nextScope = requested;
      }
    }
    // adapterType 显式给了才改（预设把已有服务商切到 anthropic 走这条）；缺省沿用原值。
    const nextAdapterType = adapterType == null || String(adapterType).trim() === "" ? provider.adapter_type : String(adapterType).trim().slice(0, 60);
    const nextOwner = nextScope === "ORGANIZATION" ? null : auth.actor.user.id;
    const beforeConfigs = nextScope ? this.store.configsOfProvider(providerId).map((c) => ({ configId: c.config_id, scope: c.scope, ownerUserId: c.owner_user_id })) : [];
    let ep = null;
    if (baseUrl || endpointScope || allowInsecureHttp !== undefined) {
      ep = domain.validateEndpoint(baseUrl || provider.base_url, { allowLan: allowLan || endpointScope === domain.ENDPOINT_SCOPE.LAN_EXPLICIT, allowInsecureHttp: allowInsecureHttp === true });
      if (!ep.ok) return ep;
    }
    // 只有「实际需要明文」的端点才置位；改成 https 或取消勾选会显式清零。
    const insecureHttp = ep ? ep.scope === domain.ENDPOINT_SCOPE.REMOTE_HTTP_EXPLICIT : !!provider.allow_insecure_http;
    let createdCredentialRef = null;
    if (credentialSecret) {
      // Endpoint change 必须显式 rebind：旧 credential 不得自动发往新 origin。
      // providerOrigin 一律取 URL origin —— 与所有调用出口的比对口径一致（不再回落整条 base_url）。
      const origin = domain.originOf(ep ? ep.url : provider.base_url);
      if (!origin) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
      const cred = this.credentials.createSync({ ownerUserId: auth.actor.user.id, organizationId: auth.actor.organizationId, scope: nextScope || provider.scope, providerOrigin: origin, providerConfigId: providerId, secret: credentialSecret });
      if (!cred.ok) return cred;
      createdCredentialRef = cred.credentialRef;
      this.store.transactSync(() => this.store.setProviderCredential(providerId, cred.credentialRef));
    }
    this.store.transactSync(() => {
      // 范围与其下模型同一次事务迁移：改到组织 / 改回个人都不会留下半迁移状态
      if (nextScope) {
        this.store.setProviderScope(providerId, { scope: nextScope, ownerUserId: nextOwner });
        this.store.setConfigsScopeByProvider(providerId, { scope: nextScope, ownerUserId: nextOwner });
      }
      this.store.updateProvider(providerId, { displayName, adapterType: nextAdapterType, baseUrl: ep ? ep.url : null, endpointScope: ep ? domain.persistableEndpointScope(ep.scope) : null, allowInsecureHttp: insecureHttp, status, credentialRef: undefined });
    });
    const mirror = this.#syncMirror(providerId);
    if (mirror.ok !== true) {
      // 两库一致：镜像失败即回滚服务商字段与本次新建的凭据
      this.store.transactSync(() => {
        this.store.updateProvider(providerId, { displayName: provider.display_name, adapterType: provider.adapter_type, baseUrl: provider.base_url, endpointScope: provider.endpoint_scope, allowInsecureHttp: !!provider.allow_insecure_http, status: provider.status, credentialRef: provider.credential_ref });
        if (nextScope) {
          this.store.setProviderScope(providerId, { scope: provider.scope, ownerUserId: provider.owner_user_id });
          for (const c of beforeConfigs) this.store.setConfigScope(c.configId, { scope: c.scope, ownerUserId: c.ownerUserId });
        }
      });
      if (createdCredentialRef) this.credentials.deleteSync({ credentialRef: createdCredentialRef });
      return mirror;
    }
    if (insecureHttp && !provider.allow_insecure_http) this.#auditInsecureHttp({ actor: auth.actor, context, providerId, phase: "reauthorized" });
    if (nextScope) this.#auditScopeChange({ actor: auth.actor, context, providerId, from: provider.scope, to: nextScope });
    return { ok: true, provider: this.#safeProvider(this.store.providerById(providerId)) };
  }
  deleteProvider({ context, providerId }) {
    const provider = this.store.providerById(providerId);
    if (!provider) return { ok: true, changed: false };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider });
    if (!auth.ok) return auth;
    const removed = this.store.transactSync(() => this.store.deleteProvider(providerId));
    const mirror = this.#removeMirror(providerId);
    if (mirror.ok !== true) {
      // 两库一致：providers.json 由桥自身回滚；这里按原 provider_id / 字段重建被删服务商
      this.store.transactSync(() => this.store.insertProvider({ providerId: provider.provider_id, organizationId: provider.organization_id, ownerUserId: provider.owner_user_id, scope: provider.scope, displayName: provider.display_name, adapterType: provider.adapter_type, baseUrl: provider.base_url, endpointScope: provider.endpoint_scope, allowInsecureHttp: !!provider.allow_insecure_http, credentialRef: provider.credential_ref }));
      if (String(provider.status) !== "enabled") this.store.transactSync(() => this.store.updateProvider(providerId, { status: provider.status }));
      return mirror;
    }
    return { ok: true, ...removed };
  }

  // ---- Model ----
  createModel({ context, providerId, remoteModelId, displayName = "", capabilities = [], scope = "PERSONAL" }) {
    const provider = this.store.providerById(providerId);
    if (!provider) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider });
    if (!auth.ok) return auth;
    const caps = domain.validateCapabilities(capabilities);
    const config = this.store.transactSync(() => this.store.insertConfig({ providerId, organizationId: auth.actor.organizationId, ownerUserId: auth.actor.user.id, scope, displayName, remoteModelId, capabilities: caps }));
    // providers.json 的能力挂在 model.caps 上：模型变更也要重新镜像该服务商，否则技能/短剧选不中站点
    const mirror = this.#syncMirror(providerId);
    if (mirror.ok !== true) {
      this.store.transactSync(() => this.store.deleteConfig(config.config_id));
      return mirror;
    }
    return { ok: true, model: this.#safeConfig(this.store.configById(config.config_id)) };
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
    this.store.transactSync(() => this.store.updateConfig(configId, { displayName, capabilities: caps }));
    const mirror = this.#syncMirror(config.provider_id);
    if (mirror.ok !== true) {
      this.store.transactSync(() => this.store.updateConfig(configId, { displayName: config.display_name, capabilities: JSON.parse(config.capabilities || "[]") }));
      return mirror;
    }
    return { ok: true, model: this.#safeConfig(this.store.configById(configId)) };
  }

  setModelStatus({ context, configId, status }) {
    const config = this.store.configById(configId);
    if (!config) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, config });
    if (!auth.ok) return auth;
    this.store.transactSync(() => this.store.updateConfig(configId, { status }));
    const mirror = this.#syncMirror(config.provider_id);
    if (mirror.ok !== true) {
      this.store.transactSync(() => this.store.updateConfig(configId, { status: config.status }));
      return mirror;
    }
    return { ok: true, model: this.#safeConfig(this.store.configById(configId)) };
  }
  deleteModel({ context, configId } = {}) {
    const config = this.store.configById(configId);
    if (!config) return { ok: true, changed: false };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, config });
    if (!auth.ok) return auth;
    const removed = this.store.transactSync(() => this.store.deleteConfig(configId));
    // providers.json 的模型清单由同一份 DB 投影，删模型也要重新镜像；失败就原样插回，绝不只删一半
    const mirror = this.#syncMirror(config.provider_id);
    if (mirror.ok !== true) {
      this.store.transactSync(() => this.store.db.prepare(RESTORE_CONFIG_SQL).run(config.config_id, config.provider_id, config.organization_id, config.owner_user_id, config.scope, config.display_name, config.remote_model_id, config.capabilities, config.verified_capabilities, config.status, config.version, config.created_at, config.updated_at));
      return mirror;
    }
    try {
      this.authStore.auditAuthorization({ actorUserId: auth.actor.user.id, targetUserId: null, appId: context && context.appId ? context.appId : null, departmentId: null, resourceRef: config.config_id, action: "model.deleted", decision: "ALLOW", reasonCode: "ALLOW", permissionSource: auth.actor.isSuper ? "SUPER_ADMIN" : "OWNER", oldPermissions: [config.remote_model_id], newPermissions: [] });
    } catch { /* 审计失败不影响已完成的删除 */ }
    return { ok: true, ...removed, configId: config.config_id, providerId: config.provider_id };
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
    // capability 必须校验并规范化：未知值结构化报错，绝不再"返回 ok 但 defaults/get 为空"
    const normalized = domain.normalizeCapability(capability);
    if (!normalized) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT, detail: "unknown-capability", capability: capability == null ? null : String(capability) };
    const config = this.store.configById(configId);
    if (!config) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    if (scope === "ORGANIZATION" && !actor.isSuper) return { ok: false, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    if (scope === "PERSONAL" && config.scope === "ORGANIZATION") { /* allow */ }
    if (scope === "PERSONAL") this.store.transactSync(() => this.store.setDefault({ organizationId: actor.organizationId, ownerUserId: actor.user.id, capability: normalized, configId }));
    else this.store.transactSync(() => this.store.setDefault({ organizationId: actor.organizationId, ownerUserId: "", capability: normalized, configId }));
    return { ok: true, capability: normalized, configId, scope };
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
    return { ok: true, snapshot: { userId: actor.user.id, modelConfigId: config.config_id, modelConfigVersion: config.version, providerId: provider.provider_id, modelId: config.remote_model_id, capabilities: caps, verifiedCapabilities: JSON.parse(config.verified_capabilities || "[]"), baseUrl: provider.base_url, endpointScope: domain.effectiveEndpointScope(provider.endpoint_scope, !!provider.allow_insecure_http), allowInsecureHttp: !!provider.allow_insecure_http, adapterType: provider.adapter_type, credentialRef: provider.credential_ref, source, scope: config.scope } };
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
    // adapterType 决定 wire 协议：anthropic 走官方 Messages，lovart 走 send→watch→result
    // 多段式 agent 线程（适配器提供 chatComplete 高阶入口），其余沿用 OpenAI 兼容实现。
    const impl = adapter.adapterFor(snapshot.adapterType, snapshot.baseUrl);
    if (typeof impl.chatComplete === "function") {
      const out = await impl.chatComplete({ baseUrl: snapshot.baseUrl, apiKey: cred.secret, model: snapshot.modelId, messages, params: cleanParams, signal, timeoutMs: Math.max(this.timeoutMs, 120000), fetchImpl: this.fetchImpl });
      if (!out.ok) {
        await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "DENY", errorCode: out.error });
        return { ok: false, error: out.error, detail: out.detail };
      }
      await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ALLOW", usage: out.usage });
      return { ok: true, requestId: rid, text: out.text || "", reasoning: typeof out.reasoning === "string" ? out.reasoning : "", toolCalls: out.toolCalls || null, usage: out.usage || null, snapshot: this.#safeSnapshot(snapshot) };
    }
    try {
      const { res } = await impl.chat({ baseUrl: snapshot.baseUrl, apiKey: cred.secret, model: snapshot.modelId, messages, tools, params: cleanParams, stream: false, signal, timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl });
      if (!res.ok) {
        const code = domain.normalizeError({ status: res.status });
        await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "DENY", errorCode: code });
        return { ok: false, error: code };
      }
      const body = await res.json();
      const parsed = impl.parseChatResponse(body);
      await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ALLOW", usage: parsed.usage });
      return { ok: true, requestId: rid, text: parsed.text || "", reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "", toolCalls: parsed.toolCalls || null, usage: parsed.usage, snapshot: this.#safeSnapshot(snapshot) };
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


  /** 所选对话模型自己能否联网搜索（服务商原生 web_search）；不能时由调用方先用 web-access 搜一遍。 */
  supportsNativeWebSearch({ context, configId = null, capability = "chat" } = {}) {
    try {
      const resolved = this.resolveModel({ context, capability, configId });
      if (!resolved.ok) return false;
      const impl = adapter.adapterFor(resolved.snapshot.adapterType, resolved.snapshot.baseUrl);
      return typeof impl.supportsWebSearch === "function" && impl.supportsWebSearch(resolved.snapshot.modelId) === true;
    } catch { return false; }
  }

  /** Provider-neutral streaming（统一事件模型）；usage/错误归一化与 chat 一致。 */
  async chatStream({ context, configId = null, messages = [], tools = null, params = {}, signal = null, requestId = null, capability = "chat", onEvent = () => {}, webSearch = false } = {}) {
    const resolved = this.resolveModel({ context, capability, configId });
    if (!resolved.ok) return resolved;
    const snapshot = resolved.snapshot;
    const cred = this.credentials.resolveInternalSync({ credentialRef: snapshot.credentialRef });
    if (!cred.ok) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_MISSING };
    if (cred.providerOrigin !== new URL(snapshot.baseUrl).origin) return { ok: false, error: domain.ERROR_CODE.ENDPOINT_BLOCKED };
    const start = this.#now(); const rid = requestId || "mreq_" + crypto.randomBytes(8).toString("base64url");
    const impl = adapter.adapterFor(snapshot.adapterType, snapshot.baseUrl);
    try {
      const out = await impl.chatStream({ baseUrl: snapshot.baseUrl, apiKey: cred.secret, model: snapshot.modelId, messages, tools, params: domain.sanitizeParams(params), signal, timeoutMs: webSearch ? Math.max(this.timeoutMs, 180000) : this.timeoutMs, fetchImpl: this.fetchImpl, onEvent, ...(webSearch ? { webSearch: true } : {}) });
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


  /**
   * 10-23 · 图片编辑 / 图生图（Lovart 等对话式服务商），凭据走模型配置。
   *   mode = redraw | erase | outpaint：sourceDataUrl 是带透明区域的 PNG（前端已合成），透明处重绘 / 擦除 / 扩展
   *   其它（prompt）：inputs 作为附件，prompt 原样发送（多角度、重打光、增强、抠图、标注改图、参考图生图）
   */
  async editImage({ context, configId = null, mode = "prompt", prompt = "", sourceDataUrl = "", originalDataUrl = "", maskPngDataUrl = "", inputs = [], signal = null, requestId = null, size = null, hints = null } = {}) {
    const resolved = this.resolveModel({ context, capability: "image-generation", configId });
    if (!resolved.ok) return resolved;
    const snapshot = resolved.snapshot;
    const impl = adapter.adapterFor(snapshot.adapterType, snapshot.baseUrl);
    // 按用户选的模型走它自己的接口：Lovart 走对话式附件；OpenAI 兼容走 /images/edits（不支持时退回多模态对话）
    const generic = typeof impl.generateImageWithInputs !== "function";
    if (generic && typeof impl.editImage !== "function") return { ok: false, error: domain.ERROR_CODE.CAPABILITY_UNAVAILABLE, detail: "adapter-no-image-edit" };
    const cred = this.credentials.resolveInternalSync({ credentialRef: snapshot.credentialRef });
    if (!cred.ok) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_MISSING };
    if (cred.providerOrigin !== new URL(snapshot.baseUrl).origin) return { ok: false, error: domain.ERROR_CODE.ENDPOINT_BLOCKED };
    const start = this.#now(); const rid = requestId || "ereq_" + crypto.randomBytes(8).toString("base64url");
    const common = { baseUrl: snapshot.baseUrl, apiKey: cred.secret, model: snapshot.modelId, signal, fetchImpl: this.fetchImpl, timeoutMs: Math.max(this.timeoutMs, 300000) };
    // 编辑也要按用户在面板上选的比例 / 档位：对话式只能写提示词；字段式交给适配器发 size/resolution。
    const promptSized = impl.SIZE_VIA_PROMPT === true;
    const sizedPrompt = promptSized ? imageParams.withSizeRequirement(prompt, { size, ratio: hints && hints.ratio }) : prompt;
    const editHints = {
      ...(hints && hints.ratio && !/自适应|auto/i.test(String(hints.ratio)) ? { ratio: String(hints.ratio) } : {}),
      ...(hints && hints.resolution ? { resolution: String(hints.resolution) } : {}),
    };
    let out;
    if (typeof impl.editImageMode === "function") {
      // APIMart：同一个生成接口带 image_urls；支持 mask_url 的模型直接用挖空图当遮罩。
      // 比例 / 档位走字段，不往提示词里塞（避免同一信息两种形态）。
      out = await impl.editImageMode({ ...common, ...editHints, mode, prompt, promptForHole: editPrompt(mode, prompt), sourceDataUrl, originalDataUrl, maskPngDataUrl, inputs });
    } else if (generic) {
      const r = await impl.editImage({ ...common, prompt: editPrompt(mode, sizedPrompt), inputs: sourceDataUrl ? [sourceDataUrl, ...inputs] : inputs });
      out = r && r.ok ? { ok: true, artifacts: r.images.map((x) => (x.b64 ? { b64: x.b64, mime: x.mime } : { url: x.url })) } : r;
    } else if (["redraw", "erase", "outpaint"].includes(String(mode)) && sourceDataUrl) {
      const refs = await impl.toAttachments({ ...common, inputs });
      if (!refs.ok) return refs;
      // 重绘 / 擦除 / 扩图的提示词由适配器按模式拼；尺寸要求交给它拼在末尾（不同模式的模板不一样）。
      out = await impl.generateImageEdit({ ...common, prompt, mode, size, ratio: (hints && hints.ratio) || null, sourceDataUrl, referenceUrls: refs.attachments });
    } else {
      out = await impl.generateImageWithInputs({ ...common, prompt: sizedPrompt, inputs: sourceDataUrl ? [sourceDataUrl, ...inputs] : inputs });
    }
    if (!out || !out.ok) {
      await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "DENY", errorCode: (out && out.error) || domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR });
      return { ok: false, error: (out && out.error) || domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, detail: out && out.detail };
    }
    const images = (Array.isArray(out.artifacts) ? out.artifacts : []).filter((a) => a && (a.url || a.b64)).map((a) => (a.b64 ? { dataUrl: "data:" + (a.mime || "image/png") + ";base64," + a.b64 } : { url: a.url }));
    if (!images.length) {
      const said = String(out.text || "").trim().slice(0, 300);
      await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ERROR", errorCode: domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR });
      return { ok: false, error: domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, detail: said || "no-image-artifact" };
    }
    await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ALLOW", usage: null });
    return { ok: true, requestId: rid, images, snapshot: this.#safeSnapshot(snapshot) };
  }

  /**
   * 10-23 · video-generation（Lovart 等对话式服务商）：凭据走模型配置（与 generateImage 同一解析链），
   * 不依赖 provider-protocol 那份服务商记录上的 api_key。返回 { ok, videos: [{ url }] }。
   */
  async generateVideo({ context, configId = null, prompt = "", inputs = [], params = {}, signal = null, requestId = null } = {}) {
    const resolved = this.resolveModel({ context, capability: "video-generation", configId });
    if (!resolved.ok) return resolved;
    const snapshot = resolved.snapshot;
    const impl = adapter.adapterFor(snapshot.adapterType, snapshot.baseUrl);
    if (typeof impl.generateVideo !== "function") return { ok: false, error: domain.ERROR_CODE.CAPABILITY_UNAVAILABLE, detail: "adapter-no-video" };
    const cred = this.credentials.resolveInternalSync({ credentialRef: snapshot.credentialRef });
    if (!cred.ok) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_MISSING };
    if (cred.providerOrigin !== new URL(snapshot.baseUrl).origin) return { ok: false, error: domain.ERROR_CODE.ENDPOINT_BLOCKED };
    const start = this.#now(); const rid = requestId || "vreq_" + crypto.randomBytes(8).toString("base64url");
    // 视频轮询上限对齐 NOVAI：30 分钟（适配器内部按 1.6 倍退避、封顶 12s）
    const out = await impl.generateVideo({ baseUrl: snapshot.baseUrl, apiKey: cred.secret, model: snapshot.modelId, prompt, inputs, params, signal, fetchImpl: this.fetchImpl, timeoutMs: Math.max(this.timeoutMs, 1800000) });
    if (!out || !out.ok) {
      await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "DENY", errorCode: (out && out.error) || domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR });
      return { ok: false, error: (out && out.error) || domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, detail: out && out.detail };
    }
    const videos = (Array.isArray(out.artifacts) ? out.artifacts : []).filter((a) => a && a.url).map((a) => ({ url: a.url, ...(a.mime ? { mime: a.mime } : {}) }));
    if (!videos.length) {
      await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ERROR", errorCode: domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR });
      // 服务商没出视频时把它的原话 / 失败原因带回去，前端提示里能看到（例如额度不足、参数不支持、需要确认）
      const said = String(out.text || "").trim().slice(0, 300);
      const why = Array.isArray(out.failures) && out.failures.length ? JSON.stringify(out.failures).slice(0, 300) : "";
      try { console.warn("[canvas] video no artifact", { status: out.status, text: said, failures: why, artifacts: (out.artifacts || []).length }); } catch { /* ignore */ }
      return { ok: false, error: domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, detail: said || why || "no-video-artifact" };
    }
    await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ALLOW", usage: null });
    return { ok: true, requestId: rid, videos, snapshot: this.#safeSnapshot(snapshot) };
  }

  /**
   * 10-23 · audio-generation（配音 / 音乐 / 音效）：适配器有 generateAudio 时直连（APIMart 等），
   * 返回 { ok, audios: [{ url } | { dataUrl }] }；适配器没有时给 adapter-no-audio，调用方回落协议引擎。
   */
  async generateAudio({ context, configId = null, prompt = "", params = {}, signal = null, requestId = null } = {}) {
    const resolved = this.resolveModel({ context, capability: "audio-generation", configId });
    if (!resolved.ok) return resolved;
    const snapshot = resolved.snapshot;
    const impl = adapter.adapterFor(snapshot.adapterType, snapshot.baseUrl);
    if (typeof impl.generateAudio !== "function") return { ok: false, error: domain.ERROR_CODE.CAPABILITY_UNAVAILABLE, detail: "adapter-no-audio" };
    const cred = this.credentials.resolveInternalSync({ credentialRef: snapshot.credentialRef });
    if (!cred.ok) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_MISSING };
    if (cred.providerOrigin !== new URL(snapshot.baseUrl).origin) return { ok: false, error: domain.ERROR_CODE.ENDPOINT_BLOCKED };
    const start = this.#now(); const rid = requestId || "areq_" + crypto.randomBytes(8).toString("base64url");
    const out = await impl.generateAudio({ baseUrl: snapshot.baseUrl, apiKey: cred.secret, model: snapshot.modelId, prompt, params, signal, fetchImpl: this.fetchImpl, timeoutMs: Math.max(this.timeoutMs, 900000) });
    if (!out || !out.ok) {
      await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "DENY", errorCode: (out && out.error) || domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR });
      return { ok: false, error: (out && out.error) || domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, detail: out && out.detail };
    }
    const audios = (Array.isArray(out.artifacts) ? out.artifacts : []).filter((a) => a && (a.url || a.b64)).map((a) => (a.b64 ? { dataUrl: "data:" + (a.mime || "audio/wav") + ";base64," + a.b64 } : { url: a.url }));
    if (!audios.length) {
      await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ERROR", errorCode: domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR });
      return { ok: false, error: domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, detail: "no-audio-artifact" };
    }
    await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ALLOW", usage: null });
    return { ok: true, requestId: rid, audios, snapshot: this.#safeSnapshot(snapshot) };
  }

  /**
   * D5-02 · image-generation（与 chat 同一套解析/授权/审计/错误归一化）。
   * 能力不支持的模型在 resolveModel 就返回 CAPABILITY_UNAVAILABLE —— 绝不改用文本接口顶替。
   * 返回的图片是 data URL（凭据与 provider URL 都不回渲染层）。
   */
  async generateImage({ context, configId = null, prompt = "", size = null, count = 1, params = {}, signal = null, requestId = null, capability = "image-generation", hints = null } = {}) {
    const resolved = this.resolveModel({ context, capability, configId });
    if (!resolved.ok) return resolved;
    const snapshot = resolved.snapshot;
    const cred = this.credentials.resolveInternalSync({ credentialRef: snapshot.credentialRef });
    if (!cred.ok) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_MISSING };
    if (cred.providerOrigin !== new URL(snapshot.baseUrl).origin) return { ok: false, error: domain.ERROR_CODE.ENDPOINT_BLOCKED };
    const start = this.#now(); const rid = requestId || "ireq_" + crypto.randomBytes(8).toString("base64url");
    // 图像面独立白名单（不复用 chat 的 sanitizeParams；size 由入参独立承载，不进 params）
    const baseParams = imageParams.pickImageParams(params);
    // 风格 / 摄影机 / 联网：params 与 hints 都是来源（hints 覆盖 params），归一后再决定怎么下发。
    const visual = pickVisualOptions(params, hints);
    const cleanParams = { ...baseParams, ...visual };
    const impl = adapter.adapterFor(snapshot.adapterType, snapshot.baseUrl);
    if (typeof impl.generateComplete === "function") {
      // 两种服务商形状：
      //   · 按字段族（APIMart）：比例 / 档位走 aspect_ratio / resolution，原样交给它，不再从像素尺寸倒推；
      //   · 对话式（Lovart 等）：请求体只有提示词，没有 size / ratio 字段 —— 尺寸必须写成提示词里的
      //     确定要求，否则上游按自己的默认出图（面板选 3:4 / 2K 也只拿回方图）。
      const promptSized = impl.SIZE_VIA_PROMPT === true;
      const fieldSized = !promptSized && impl.ADAPTER_TYPE === "apimart";
      // 字段式适配器只发「适配器 uiSpec 明确声明支持」的视觉字段；没声明就不发（不造字段、不冒充能力）。
      // 注意 imageParams 白名单本身含 style（OpenAI images 用），字段式适配器要先摘掉，只有 uiSpec 支持才加回。
      const modelSpec = typeof impl.uiSpec === "function" ? impl.uiSpec(snapshot.modelId) : null;
      const fieldBase = { ...baseParams };
      delete fieldBase.style;
      const sized = fieldSized
        ? {
            ...fieldBase,
            ...(hints && hints.ratio && !/自适应|auto/i.test(String(hints.ratio)) ? { aspect_ratio: String(hints.ratio) } : {}),
            ...(hints && hints.resolution ? { resolution: String(hints.resolution) } : {}),
            ...(specAllows(modelSpec, "style") && visual.style ? { style: visual.style } : {}),
            ...(specAllows(modelSpec, "camera") && visual.camera ? { camera: visual.camera } : {}),
            ...(specAllows(modelSpec, "search") && visual.webSearch ? { web_search: true } : {}),
          }
        : cleanParams;
      // 对话式：尺寸 + 风格 / 摄影机 / 联网都写进【画面要求】（没有的项不写）。
      const finalPrompt = promptSized
        ? withVisualRequirements(imageParams.withSizeRequirement(prompt, { size, ratio: hints && hints.ratio }), visual)
        : prompt;
      const out = await impl.generateComplete({ baseUrl: snapshot.baseUrl, apiKey: cred.secret, kind: "image", model: snapshot.modelId, prompt: finalPrompt, size, count, params: sized, signal, timeoutMs: Math.max(this.timeoutMs, 300000), fetchImpl: this.fetchImpl });
      if (!out.ok) {
        await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "DENY", errorCode: out.error });
        return { ok: false, error: out.error, detail: out.detail };
      }
      const artifacts = (Array.isArray(out.artifacts) ? out.artifacts : []).filter((artifact) => artifact && (artifact.url || artifact.b64));
      const images = artifacts.map((artifact) => (artifact.b64 ? { dataUrl: "data:" + (artifact.mime || "image/png") + ";base64," + artifact.b64 } : { url: artifact.url }));
      if (!images.length) {
        await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ERROR", errorCode: domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR });
        return { ok: false, error: domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, detail: "lovart-no-image-artifact" };
      }
      await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ALLOW", usage: null });
      return { ok: true, requestId: rid, images, snapshot: this.#safeSnapshot(snapshot) };
    }
    try {
      const { res } = await adapter.generateImage({ baseUrl: snapshot.baseUrl, apiKey: cred.secret, model: snapshot.modelId, prompt, size, count, params: cleanParams, signal, timeoutMs: Math.max(this.timeoutMs, 60000), fetchImpl: this.fetchImpl });
      if (!res.ok) {
        const code = domain.normalizeError({ status: res.status });
        await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "DENY", errorCode: code });
        return { ok: false, error: code };
      }
      const body = await res.json();
      const items = adapter.mapImages(body);
      if (!items.length) {
        await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ERROR", errorCode: domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR });
        return { ok: false, error: domain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR };
      }
      const images = items.map((it) => (it.b64 ? { dataUrl: "data:" + (it.mime || "image/png") + ";base64," + it.b64 } : { url: it.url }));
      await this.#record({ requestId: rid, context, snapshot, startedAt: start, status: "ALLOW", usage: null });
      return { ok: true, requestId: rid, images, snapshot: this.#safeSnapshot(snapshot) };
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

  /**
   * 适配器规格 → 画布投影（specSource + uiSpec）。
   *
   * · uiSpec 是对象：来源取适配器自报的 capabilitiesSource（缺省视为 spec）；
   * · 没有 uiSpec（通用 OpenAI 兼容站点 / 适配器不做规格）：specSource='guess'，不投影 uiSpec，
   *   前端退回按名字的预设并显示「未验证」；
   * · 适配器抛错：按 guess 处理，绝不让一个坏适配器把整张模型表打掉。
   */
  #projectModelUiSpec(provider, remoteModelId) {
    let ui = null;
    try {
      const impl = adapter.adapterFor(provider.adapter_type, provider.base_url);
      ui = impl && typeof impl.uiSpec === "function" ? impl.uiSpec(remoteModelId) : null;
    } catch { ui = null; }
    if (!ui || typeof ui !== "object" || Array.isArray(ui)) return { specSource: "guess" };
    return { uiSpec: ui, specSource: ui.capabilitiesSource === "guess" ? "guess" : "spec" };
  }

  /**
   * 渲染层可见的模型面（**无 baseUrl / 无凭据 / 无 credentialRef**）。
   *
   * 与 resolveModel **同一口径**做授权过滤：App 必须 enabled 且 app grant 含 `model.use`，
   * PERSONAL 配置还必须属于当前 actor —— 否则撤权/停用后列表仍显示模型，而调用会被拒，
   * 界面就成了"看着能用、点了报错"。过滤掉的模型连 provider 名字都不投影。
   * 每个模型带 providerId / providerName（**只有显示名**），供画布按供应商分组展示。
   */
  listModelsForUse({ context } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const capabilities = ["chat", "tool-calling", "vision-input", "image-generation", "video-generation", "embedding"];
    const defaults = this.getDefaults({ context });
    const items = this.listModels({ context });
    const models = [];
    for (const m of items && items.items ? items.items : []) {
      const config = this.store.configById(m.configId);
      if (!config) continue;
      const provider = this.store.providerById(config.provider_id);
      if (!provider) continue;
      if (String(config.status) !== "enabled" || String(provider.status) !== "enabled") continue;
      if (!this.#authorize({ context, action: domain.MODEL_ACTIONS.USE, config, provider }).ok) continue;
      models.push({
        configId: m.configId, displayName: m.displayName || m.remoteModelId, remoteModelId: m.remoteModelId,
        providerId: provider.provider_id, providerName: provider.display_name || provider.provider_id,
        capabilities: m.capabilities || [], verifiedCapabilities: m.verifiedCapabilities || [], status: m.status, scope: m.scope,
        // 规格来源：适配器给的 uiSpec 是 spec（模型族规格）；没有规格 = guess（画布退回按名字的预设并标「未验证」）。
        // specSource 与 uiSpec 一起投影，前端不用再靠「有没有字段」猜来源。
        ...this.#projectModelUiSpec(provider, m.remoteModelId),
      });
    }
    /**
     * 显式配置的默认模型**为什么用不了**：渲染层要如实告诉用户，而不是悄悄换成清单第一个。
     * 判定顺序与 resolveModel 一致（不存在 → 停用 → 缺能力 → 没授权），reason 就是调用时的拒绝口径。
     * def == null（OpenArc 里压根没配该能力默认）不是故障：那种情况页面回落清单第一个只是展示便利。
     */
    const defaultState = (cap) => {
      const configId = (defaults && defaults.ok ? (defaults.personal[cap] || defaults.organization[cap]) : null) || null;
      if (!configId) return { configId: null, usable: null, reason: null };
      if (models.some((m) => m.configId === configId && (m.capabilities || []).includes(cap))) return { configId, usable: true, reason: null };
      const config = this.store.configById(configId);
      const provider = config ? this.store.providerById(config.provider_id) : null;
      if (!config || !provider) return { configId, usable: false, reason: "MODEL_NOT_FOUND" };
      if (String(config.status) !== "enabled" || String(provider.status) !== "enabled") return { configId, usable: false, reason: "MODEL_DISABLED" };
      const caps = (this.#safeConfig(config) || {}).capabilities || [];
      if (!caps.includes(cap)) return { configId, usable: false, reason: "CAPABILITY_UNAVAILABLE" };
      return { configId, usable: false, reason: "MODEL_UNAUTHORIZED" };
    };
    const defaultsState = {};
    for (const cap of capabilities) defaultsState[cap] = defaultState(cap);
    // task-64：视频传输不再写死 false。按真实装配判断——只有 model 域已挂载
    // providerProtocol.service 且它确实能执行视频时才算接通；否则如实 false。
    const videoTransport = !!(this.providerProtocol
      && this.providerProtocol.service
      && typeof this.providerProtocol.service.legacyExecute === "function");
    return {
      ok: true, models, capabilities, defaultsState,
      defaults: defaults && defaults.ok ? { personal: defaults.personal, organization: defaults.organization } : { personal: {}, organization: {} },
      // 供应商地址/凭据一律不出主进程：画布只看到"能用的模型"和供应商显示名。
      transports: { chat: true, "image-generation": true, "video-generation": videoTransport },
    };
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
    // 只有能 manage 该 provider 的人才能看到 credential / secure backend metadata；
    // 否则只回安全空值，不泄漏"是否已配置 / version / status"。
    const authorized = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider });
    if (!authorized.ok) return { ok: true, configured: false, status: "MISSING", storeAvailable: this.credentials.available(), credentialVersion: null, manageable: false };
    const meta = provider.credential_ref ? this.store.credentialByRef(provider.credential_ref) : null;
    return { ok: true, configured: !!(meta && meta.status === "CONFIGURED" && this.credentials.available()), status: meta ? meta.status : "MISSING", storeAvailable: this.credentials.available(), credentialVersion: meta ? meta.credential_version : null, manageable: true };
  }
  setProviderCredential({ context, providerId, secret } = {}) {
    const provider = this.store.providerById(providerId);
    if (!provider) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider });
    if (!auth.ok) return auth;
    // providerOrigin 一律取 URL origin：provider.base_url 经 validateEndpoint 归一化后带结尾 /，
    // 整条写进去必然与调用出口的 origin 比对不符 → 每次真实调用 ENDPOINT_BLOCKED（缺陷 1）。
    const origin = domain.originOf(provider.base_url);
    if (!origin) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const previousCredentialRef = provider.credential_ref;
    const cred = this.credentials.createSync({ ownerUserId: auth.actor.user.id, organizationId: auth.actor.organizationId, scope: provider.scope, providerOrigin: origin, providerConfigId: providerId, secret });
    if (!cred.ok) return cred;
    this.store.transactSync(() => this.store.setProviderCredential(providerId, cred.credentialRef));
    const mirror = this.#syncMirror(providerId);
    if (mirror.ok !== true) {
      // 两库一致：镜像失败即撤销本次凭据绑定
      this.store.transactSync(() => this.store.setProviderCredential(providerId, previousCredentialRef));
      this.credentials.deleteSync({ credentialRef: cred.credentialRef });
      return mirror;
    }
    this.authStore.auditAuthorization({ actorUserId: auth.actor.user.id, targetUserId: null, appId: context.appId, departmentId: null, resourceRef: null, action: "model.credentialCreated", decision: "ALLOW", reasonCode: "ALLOW", permissionSource: "SUPER_ADMIN", oldPermissions: [], newPermissions: [] });
    return { ok: true, credentialVersion: cred.credentialVersion, configured: true };
  }
  replaceProviderCredential({ context, providerId, secret } = {}) {
    const provider = this.store.providerById(providerId);
    if (!provider) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider });
    if (!auth.ok) return auth;
    if (!provider.credential_ref) return this.setProviderCredential({ context, providerId, secret });
    const expectedOrigin = domain.originOf(provider.base_url);
    if (!expectedOrigin) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const meta = this.store.credentialByRef(provider.credential_ref);
    if (!meta || String(meta.provider_origin) !== expectedOrigin) {
      /**
       * 自愈：replaceSync 只翻 version/status，改不动 provider_origin，坏值会一直是坏值。
       * 这里直接重建凭据（providerOrigin = 当前 origin）并删掉旧凭据，避免"保存密钥后必被
       * ENDPOINT_BLOCKED"。选自愈而不是只回错：旧值没有任何调用方能用，回错不解决用户问题。
       */
      const rebuilt = this.setProviderCredential({ context, providerId, secret });
      if (rebuilt.ok === true) this.credentials.deleteSync({ credentialRef: provider.credential_ref });
      return rebuilt;
    }
    let previousSecret = null;
    try { const prev = this.credentials.resolveInternalSync({ credentialRef: provider.credential_ref }); if (prev && prev.ok) previousSecret = prev.secret; } catch { /* 旧密钥解不出就只回滚元数据 */ }
    const rep = this.credentials.replaceSync({ credentialRef: provider.credential_ref, secret });
    if (!rep.ok) return rep;
    const mirror = this.#syncMirror(providerId);
    if (mirror.ok !== true) {
      if (previousSecret != null) { try { this.credentials.replaceSync({ credentialRef: provider.credential_ref, secret: previousSecret }); } catch { /* 尽力回滚密钥 */ } }
      return mirror;
    }
    this.authStore.auditAuthorization({ actorUserId: auth.actor.user.id, targetUserId: null, appId: context.appId, departmentId: null, resourceRef: null, action: "model.credentialReplaced", decision: "ALLOW", reasonCode: "ALLOW", permissionSource: "SUPER_ADMIN", oldPermissions: [], newPermissions: [] });
    return { ok: true, credentialVersion: rep.credentialVersion, configured: true };
  }
  deleteProviderCredential({ context, providerId } = {}) {
    const provider = this.store.providerById(providerId);
    if (!provider) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider });
    if (!auth.ok) return auth;
    if (!provider.credential_ref) return { ok: true, changed: false, configured: false };
    // 先清 providers.json 后端的密钥；失败即整体不动（两库一致）
    const mirror = this.#clearMirrorCredential(providerId);
    if (mirror.ok !== true) return mirror;
    this.credentials.deleteSync({ credentialRef: provider.credential_ref });
    this.authStore.auditAuthorization({ actorUserId: auth.actor.user.id, targetUserId: null, appId: context.appId, departmentId: null, resourceRef: null, action: "model.credentialDeleted", decision: "ALLOW", reasonCode: "ALLOW", permissionSource: "SUPER_ADMIN", oldPermissions: [], newPermissions: [] });
    return { ok: true, changed: true, configured: false };
  }
  recentCalls(limit = 50) { return this.store.recentCalls(limit); }

  /**
   * 读取「模型出网代理」设置（**内部只读**；出口 fetchImpl 每次请求调用它，因此改配置无需重启）。
   * 只认合法形状；缺失 / 坏 JSON / 表不存在一律回落"关闭"，绝不抛给调用方。
   */
  readEgressProxy() {
    try {
      const row = this.store.db.prepare("SELECT preference_value FROM system_preferences WHERE preference_key = ?").get(EGRESS_PROXY_PREF_KEY);
      if (!row || typeof row.preference_value !== "string") return { enabled: false, url: null };
      const parsed = JSON.parse(row.preference_value);
      const normalized = domain.normalizeProxyConfig(parsed && typeof parsed === "object" ? parsed : {});
      return normalized.ok === true ? { enabled: normalized.enabled === true, url: normalized.url || null } : { enabled: false, url: null };
    } catch { return { enabled: false, url: null }; }
  }

  /** 出口 fetch 若带最近代理侧错误，把原始出网码附在命令结果里（只回码，不回 detail / 凭据）。 */
  #proxyError() {
    try { return typeof this.fetchImpl.recentError === "function" ? this.fetchImpl.recentError(120000) : null; } catch { return null; }
  }

  /** 渲染层只读投影（需要 model.view）：绝不回传任何凭据（代理地址本身不含凭据）。 */
  getEgressProxy({ context } = {}) {
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.VIEW });
    if (!auth.ok) return auth;
    const current = this.readEgressProxy();
    return { ok: true, enabled: current.enabled, url: current.url };
  }

  /**
   * 写入「模型出网代理」设置（需要 model.manage）。
   * 校验不通过 → 结构化 INVALID_INPUT（带 reason）；落到 system_preferences；有实际变更才写授权审计
   * （action = model.proxyEnabled，沿用 authStore.auditAuthorization 既有用法）。
   */
  setEgressProxy({ context, enabled, url } = {}) {
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE });
    if (!auth.ok) return auth;
    const normalized = domain.normalizeProxyConfig({ enabled, url });
    if (normalized.ok !== true) return { ok: false, error: normalized.error, reason: normalized.reason || null };
    const previous = this.readEgressProxy();
    const record = { enabled: normalized.enabled === true, url: normalized.url || null };
    const changed = previous.enabled !== record.enabled || String(previous.url || "") !== String(record.url || "");
    try {
      this.store.transactSync(() => this.store.db.prepare(
        "INSERT INTO system_preferences (preference_key, preference_value, updated_by, updated_at) VALUES (?,?,?,?) " +
        "ON CONFLICT(preference_key) DO UPDATE SET preference_value = excluded.preference_value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      ).run(EGRESS_PROXY_PREF_KEY, JSON.stringify(record), auth.actor.user.id, this.#now()));
    } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
    if (changed) {
      try {
        this.authStore.auditAuthorization({
          actorUserId: auth.actor.user.id, targetUserId: null, appId: context && context.appId ? context.appId : null,
          departmentId: null, resourceRef: EGRESS_PROXY_PREF_KEY, action: "model.proxyEnabled",
          decision: "ALLOW", reasonCode: record.enabled ? "PROXY_ENABLED" : "PROXY_DISABLED", permissionSource: "SUPER_ADMIN",
          oldPermissions: [JSON.stringify(previous)], newPermissions: [JSON.stringify(record)],
        });
      } catch { /* 审计失败不影响已完成的设置 */ }
    }
    return { ok: true, enabled: record.enabled, url: record.url, changed };
  }

  /**
   * 10-16 · 拉取服务商的模型清单（设置 › 模型与服务商「拉取模型」）。
   * 需要对该服务商的管理权限；凭据只在主进程内使用，且只发往创建凭据时登记的同源地址。
   */
  async listRemoteModels({ context, providerId }) {
    const provider = this.store.providerById(providerId);
    if (!provider) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.MANAGE, provider });
    if (!auth.ok) return auth;
    if (!provider.credential_ref) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_MISSING };
    const cred = this.credentials.resolveInternalSync({ credentialRef: provider.credential_ref });
    if (!cred.ok) return cred;
    if (cred.providerOrigin !== new URL(provider.base_url).origin) return { ok: false, error: domain.ERROR_CODE.ENDPOINT_BLOCKED };
    // 按 provider.adapter_type 选适配器：anthropic 走 GET /v1/models（x-api-key + anthropic-version）。
    const r = await adapter.adapterFor(provider.adapter_type, provider.base_url).listModels({ baseUrl: provider.base_url, apiKey: cred.secret, fetchImpl: this.fetchImpl, timeoutMs: Math.min(this.timeoutMs, 20000) });
    if (!r.ok) {
      const code = r.kind ? domain.normalizeError({ kind: r.kind === "timeout" ? "timeout" : "", network: r.kind === "network" }) : domain.normalizeError({ status: r.status });
      const proxyError = this.#proxyError();
      return { ok: false, error: code, ...(proxyError ? { proxyError: proxyError.code } : {}) };
    }
    const existing = new Set(this.store.configsOfOrg(provider.organization_id).filter((c) => c.provider_id === providerId).map((c) => c.remote_model_id));
    return {
      ok: true,
      items: r.items.map((m) => ({
        id: m.id,
        ownedBy: m.ownedBy || null,
        // 适配器给了能力建议就以它为准（lovart 按 catalog 的 IMAGE/VIDEO/3D 分类）；
        // 没给才回落到按模型名粗判，避免把 3D 工具误判成 chat。
        suggestedCapabilities: Object.prototype.hasOwnProperty.call(m, "suggestedCapabilities") && Array.isArray(m.suggestedCapabilities)
          ? m.suggestedCapabilities
          : adapter.guessCapabilities(m.id),
        ...(m.displayName ? { displayName: String(m.displayName).slice(0, 200) } : {}),
        ...(m.category ? { category: String(m.category).slice(0, 24) } : {}),
        ...(m.premium === true ? { premium: true } : {}),
        ...(m.unsupportedCapability ? { unsupportedCapability: String(m.unsupportedCapability).slice(0, 24) } : {}),
        registered: existing.has(m.id),
      })),
    };
  }

  async testConnection({ context, configId }) {
    // 有的协议没有可探的对话面但提供了凭据探测入口（lovart：签名 POST /mode/query 验 AK/SK；
    // 真站 GET /tools/catalog 是公开路由，验不了凭据）。这种情况按适配器自己的探测口径回答，
    // 不伪装成 inference:true，也不假装成对话可达。
    const probeConfig = this.store.configById(configId);
    const probeProvider = probeConfig ? this.store.providerById(probeConfig.provider_id) : null;
    const probeImpl = probeProvider ? adapter.adapterFor(probeProvider.adapter_type, probeProvider.base_url) : null;
    if (probeProvider && probeImpl && typeof probeImpl.probeCredential === "function") {
      const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.TEST, config: probeConfig, provider: probeProvider });
      if (!auth.ok) return auth;
      if (!probeProvider.credential_ref) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_MISSING };
      const probeCred = this.credentials.resolveInternalSync({ credentialRef: probeProvider.credential_ref });
      if (!probeCred.ok) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_MISSING };
      if (probeCred.providerOrigin !== new URL(probeProvider.base_url).origin) return { ok: false, error: domain.ERROR_CODE.ENDPOINT_BLOCKED };
      const probe = await probeImpl.probeCredential({ baseUrl: probeProvider.base_url, apiKey: probeCred.secret, fetchImpl: this.fetchImpl, timeoutMs: Math.min(this.timeoutMs, 20000) });
      if (probe.ok) return { ok: true, reachable: true, credentialAccepted: true, inference: false, probe: probe.probe || "catalog" };
      const proxyError = this.#proxyError();
      return { ok: false, error: probe.error, reachable: probe.reachable !== false, credentialAccepted: probe.credentialAccepted !== false, inference: false, probe: probe.probe || "catalog", ...(proxyError ? { proxyError: proxyError.code } : {}) };
    }
    // task-52：不再硬编码 chat。chat 模型做真实对话探针；图像/视频/音频模型只做
    // endpoint+credential 探针（listModels），返回 inference:false，绝不把"没有 chat 能力"误报成接入失败。
    const configCaps = probeConfig && Array.isArray(JSON.parse(probeConfig.capabilities || "[]")) ? JSON.parse(probeConfig.capabilities || "[]") : [];
    const capability = configCaps.includes("chat") ? "chat" : null;
    if (capability) {
      const resolved = this.resolveModel({ context, configId, capability: "chat" });
      if (!resolved.ok) return resolved;
      const r = await this.chat({ context, configId, messages: [{ role: "user", content: "ping" }], capability: "chat" });
      if (r.ok) {
        this.setVerifiedCapabilities({ context, configId, verifiedCapabilities: ["chat"] });
        return { ok: true, reachable: true, credentialAccepted: true, inference: true };
      }
      return { ok: false, error: r.error, reachable: r.error !== domain.ERROR_CODE.PROVIDER_UNAVAILABLE, credentialAccepted: r.error !== domain.ERROR_CODE.AUTH_FAILED, inference: false };
    }
    // 非 chat 模型：只验证服务商地址/密钥可用性；能力推断仍需真实生成调用，这里不冒充。
    if (!probeProvider || !probeConfig) return { ok: false, error: domain.ERROR_CODE.MODEL_CONFIG_UNAVAILABLE };
    const auth = this.#authorize({ context, action: domain.MODEL_ACTIONS.TEST, config: probeConfig, provider: probeProvider });
    if (!auth.ok) return auth;
    if (!probeProvider.credential_ref) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_MISSING };
    const cred = this.credentials.resolveInternalSync({ credentialRef: probeProvider.credential_ref });
    if (!cred.ok) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_MISSING };
    if (cred.providerOrigin !== new URL(probeProvider.base_url).origin) return { ok: false, error: domain.ERROR_CODE.ENDPOINT_BLOCKED };
    const listed = await adapter.adapterFor(probeProvider.adapter_type, probeProvider.base_url).listModels({ baseUrl: probeProvider.base_url, apiKey: cred.secret, fetchImpl: this.fetchImpl, timeoutMs: Math.min(this.timeoutMs, 20000) });
    if (!listed.ok) {
      const code = listed.kind ? domain.normalizeError({ timeout: listed.kind === "timeout", network: listed.kind === "network" }) : domain.normalizeError({ status: listed.status });
      return { ok: false, error: code, reachable: listed.kind !== "network", credentialAccepted: listed.status !== 401 && listed.status !== 403, inference: false, capability: configCaps[0] || null, probe: "models" };
    }
    return { ok: true, reachable: true, credentialAccepted: true, inference: false, capability: configCaps[0] || null, probe: "models" };
  }

  async #record({ requestId, context, snapshot, startedAt, status, errorCode = null, usage = null }) {
    try {
      this.store.transactSync(() => this.store.insertCall({ requestId, userId: context && context.userId ? context.userId : null, appId: context && context.appId ? context.appId : null, providerId: snapshot.providerId, modelId: snapshot.modelId, configVersion: snapshot.modelConfigVersion, startedAt, durationMs: this.#now() - startedAt, status, errorCode, inputTokens: usage ? usage.inputTokens : null, outputTokens: usage ? usage.outputTokens : null, totalTokens: usage ? usage.totalTokens : null }));
    } catch { /* usage 记录失败不得影响调用 */ }
  }

  #safeProvider(p) { if (!p) return null; return { providerId: p.provider_id, displayName: p.display_name, adapterType: p.adapter_type, baseUrl: p.base_url, endpointScope: domain.effectiveEndpointScope(p.endpoint_scope, !!p.allow_insecure_http), allowInsecureHttp: !!p.allow_insecure_http, scope: p.scope, status: p.status, credentialConfigured: !!p.credential_ref, version: p.version }; }
  #safeConfig(c) { if (!c) return null; return { configId: c.config_id, providerId: c.provider_id, displayName: c.display_name, remoteModelId: c.remote_model_id, capabilities: JSON.parse(c.capabilities || "[]"), verifiedCapabilities: JSON.parse(c.verified_capabilities || "[]"), scope: c.scope, status: c.status, version: c.version }; }
  #safeSnapshot(s) { return { modelConfigId: s.modelConfigId, modelConfigVersion: s.modelConfigVersion, providerId: s.providerId, modelId: s.modelId, capabilities: s.capabilities, source: s.source }; }
}

module.exports = { ModelService };
