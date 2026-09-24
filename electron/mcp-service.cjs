/**
 * D5-03 第一批 · MCP Service（连接管理 + 能力发现）。
 *
 * 授权复用 D3-02：app_resource_grants（resource_type='mcp'）+ 连接自身的 visibility/owner。
 * 判定口径：
 *   · App 必须 enabled 且持有对应 mcp.* 动作（mcp.view / mcp.use / mcp.manage / mcp.test）；
 *   · PERSONAL 连接只有 owner 可见/可用；ORGANIZATION 连接组织内成员可见，
 *     但**管理**（建/改/删/启停）需要 Super Admin —— 与模型 Provider 的 ORGANIZATION 口径一致；
 *   · 工具描述（能力数据）要求 mcp.use：只有 mcp.view 时列表照常给状态，但 tools 为空且 toolsHidden=true。
 * 连接（本地/远程）都真实握手：initialize → notifications/initialized → tools/list（分页有界），
 * 把**实际协商结果**写进记录；失败回稳定错误码，绝不假装成功。
 * 本批**不开放工具调用**：invokeTool 一律 MCP_TOOL_INVOCATION_NOT_ENABLED。
 */
"use strict";

const domain = require("./mcp-domain.cjs");
const { McpClient } = require("./mcp-client.cjs");
const { createDefaultExecutorLauncher } = require("./executor-launcher.cjs");

const DEFAULT_RECONNECT_ATTEMPTS = 3;
const DEFAULT_RECONNECT_BACKOFF_MS = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class McpService {
  constructor({ identity, authService, authStore, mcpStore, credentialStore, clientFactory = null, requestTimeoutMs = 8000, maxTools = 200, maxPages = 10, reconnectAttempts = DEFAULT_RECONNECT_ATTEMPTS, reconnectBackoffMs = DEFAULT_RECONNECT_BACKOFF_MS, clock = null, logger = null } = {}) {
    if (!identity) throw new Error("McpService 需要 IdentityStore");
    if (!authService) throw new Error("McpService 需要 AuthorizationService");
    if (!authStore) throw new Error("McpService 需要 AuthorizationStore");
    if (!mcpStore) throw new Error("McpService 需要 McpStore");
    this.identity = identity;
    this.authService = authService;
    this.authStore = authStore;
    this.store = mcpStore;
    this.credentials = credentialStore || null;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxTools = maxTools;
    this.maxPages = maxPages;
    this.reconnectAttempts = Math.max(1, Number(reconnectAttempts) || DEFAULT_RECONNECT_ATTEMPTS);
    this.reconnectBackoffMs = Math.max(0, Number(reconnectBackoffMs) || 0);
    this.clientFactory = typeof clientFactory === "function" ? clientFactory : () => new McpClient({ launcher: createDefaultExecutorLauncher(), requestTimeoutMs, maxTools, maxPages });
    this.live = new Map();
    this.busy = new Set();
  }

  #now() { return this.clock(); }
  #actor(context) { return this.authService.resolveActor({ context }); }

  /** App 动作 + 连接可见性判定。deny 时返回稳定错误码与原因，不回任何连接数据。 */
  #authorize({ context, action, connection = null, requireApp = true, allowNotVisible = false } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: domain.ERROR_CODE.MCP_UNAUTHORIZED, reason: "no-session" };
    const appId = context && context.appId ? String(context.appId) : null;
    if (!appId) return { ok: false, error: domain.ERROR_CODE.MCP_UNAUTHORIZED, reason: "no-app" };
    const app = this.authStore.appById(appId);
    if (!app || String(app.status).toLowerCase() !== "enabled") return { ok: false, error: domain.ERROR_CODE.MCP_UNAUTHORIZED, reason: "app-disabled" };
    if (requireApp) {
      const grants = this.#grantsFor(appId, actor);
      if (!grants.some((g) => domain.mcpGrantActions(g).includes(action))) return { ok: false, error: domain.ERROR_CODE.MCP_UNAUTHORIZED, reason: "app-action-missing" };
    }
    if (connection) {
      const isOrg = connection.visibility === domain.VISIBILITY.ORGANIZATION;
      if (isOrg) {
        if (connection.organization_id !== actor.organizationId) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND, reason: "cross-organization", actor, app };
      } else if (connection.owner_user_id !== actor.user.id) {
        // 别人的个人连接：不暴露"存在"，也不暴露工具描述
        return { ok: false, error: allowNotVisible ? domain.ERROR_CODE.MCP_UNAUTHORIZED : domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND, reason: "not-owner", actor, app };
      }
      if (action === domain.MCP_ACTIONS.MANAGE && isOrg && !actor.isSuper) return { ok: false, error: domain.ERROR_CODE.MCP_UNAUTHORIZED, reason: "org-manage-requires-super-admin", actor, app };
    }
    return { ok: true, actor, app };
  }

  /** App Grant 必须落在当前 actor 的组织上（跨组织的同名 App 授权不算授权）。 */
  #grantsFor(appId, actor) {
    return this.authStore.appGrantsForApp(appId).filter((g) => g.resource_type === "mcp" && (!g.organization_id || g.organization_id === actor.organizationId));
  }

  /**
   * 渲染层投影：工具描述属能力数据，App 必须持有 mcp.use 才投影
   * （只有 mcp.view 时 tools 为空且 toolsHidden=true）。
   */
  #safe(row, auth) {
    const actor = auth && auth.actor ? auth.actor : null;
    const appId = auth && auth.app ? auth.app.app_id : null;
    const toolsVisible = !!actor && !!appId && this.#grantsFor(appId, actor).some((g) => domain.mcpGrantActions(g).includes(domain.MCP_ACTIONS.USE));
    const projected = domain.projectConnection(row, { toolsVisible });
    if (!projected || !actor) return projected;
    const isOrg = row.visibility === domain.VISIBILITY.ORGANIZATION;
    return {
      ...projected,
      access: {
        canView: true,
        canUse: toolsVisible,
        canManage: isOrg ? !!actor.isSuper : row.owner_user_id === actor.user.id,
        isOwner: row.owner_user_id === actor.user.id,
        connectionScope: isOrg ? "organization" : "personal",
      },
    };
  }

  #log(connectionId, level, event, { errorCode = null, detail = null, secrets = [] } = {}) {
    try {
      this.store.transactSync(() => this.store.appendLog({ connectionId, level, event, errorCode, detail: detail == null ? null : domain.redactSecrets(String(detail).slice(0, 500), secrets) }));
    } catch {
      /* 日志失败不影响连接主流程 */
    }
  }

  #audit(actor, { action, decision, reasonCode, connectionId = null }) {
    try {
      this.authStore.auditAuthorization({ actorUserId: actor && actor.user ? actor.user.id : null, targetUserId: null, appId: actor && actor.app ? actor.app.app_id : null, departmentId: null, resourceRef: connectionId, action, decision, reasonCode, permissionSource: actor && actor.isSuper ? "SUPER_ADMIN" : "OWNER" });
    } catch {
      /* 审计失败不阻断（与 model-service 同口径） */
    }
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  listConnections({ context } = {}) {
    const auth = this.#authorize({ context, action: domain.MCP_ACTIONS.VIEW });
    if (!auth.ok) return { ok: false, error: auth.error, reason: auth.reason, items: [] };
    const rows = this.store.connectionsOfOrg(auth.actor.organizationId).filter((row) => row.visibility === domain.VISIBILITY.ORGANIZATION || row.owner_user_id === auth.actor.user.id);
    return { ok: true, items: rows.map((row) => this.#safe(row, auth)).filter(Boolean), total: rows.length };
  }

  getConnection({ context, connectionId } = {}) {
    const row = this.store.connectionById(connectionId);
    if (!row) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND };
    const auth = this.#authorize({ context, action: domain.MCP_ACTIONS.VIEW, connection: row });
    if (!auth.ok) return { ok: false, error: auth.error, reason: auth.reason };
    return { ok: true, connection: this.#safe(row, auth) };
  }

  createConnection({ context, name, transport, location, endpoint, authMode = domain.AUTH_MODE.NONE, credentialSecret = null, visibility = domain.VISIBILITY.PERSONAL } = {}) {
    const auth = this.#authorize({ context, action: domain.MCP_ACTIONS.MANAGE });
    const deny = (reason) => {
      // 拒绝必须留痕（谁、哪个 App、什么原因），否则"无权"与"没试过"在审计上分不开
      this.#audit(auth.actor || null, { action: "mcp.connectionCreated", decision: "DENY", reasonCode: reason });
      return { ok: false, error: domain.ERROR_CODE.MCP_UNAUTHORIZED, reason };
    };
    if (!auth.ok) { this.#audit(auth.actor || null, { action: "mcp.connectionCreated", decision: "DENY", reasonCode: auth.reason || auth.error }); return { ok: false, error: auth.error, reason: auth.reason }; }
    const cleanName = String(name == null ? "" : name).trim().slice(0, 120);
    if (!cleanName) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "name" };
    if (![domain.TRANSPORT.STDIO, domain.TRANSPORT.HTTP].includes(String(transport))) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "transport" };
    if (![domain.LOCATION.LOCAL_DEVICE, domain.LOCATION.REMOTE_SERVICE].includes(String(location))) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "location" };
    const vis = String(visibility);
    if (![domain.VISIBILITY.PERSONAL, domain.VISIBILITY.ORGANIZATION].includes(vis)) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "visibility" };
    if (vis === domain.VISIBILITY.ORGANIZATION && !auth.actor.isSuper) return deny("org-create-requires-super-admin");
    const mode = String(authMode || domain.AUTH_MODE.NONE);
    if (![domain.AUTH_MODE.NONE, domain.AUTH_MODE.BEARER].includes(mode)) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "authMode" };
    const encoded = domain.encodeEndpoint({ location, transport, endpoint, allowLan: false });
    if (!encoded.ok) return encoded;
    if (mode === domain.AUTH_MODE.BEARER && !credentialSecret) return { ok: false, error: domain.ERROR_CODE.MCP_CREDENTIAL_MISSING, detail: "bearer-requires-secret" };
    if (mode === domain.AUTH_MODE.NONE && credentialSecret) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "secret-without-bearer" };
    let credentialRef = null;
    if (mode === domain.AUTH_MODE.BEARER) {
      const created = this.#createCredential({ actor: auth.actor, scope: vis, origin: encoded.origin, connectionId: null, secret: credentialSecret });
      if (!created.ok) return created;
      credentialRef = created.credentialRef;
    }
    const row = this.store.transactSync(() => this.store.insertConnection({ organizationId: auth.actor.organizationId, ownerUserId: auth.actor.user.id, visibility: vis, name: cleanName, transport, location, endpointJson: encoded.json, authMode: mode, credentialRef, enabled: false, status: domain.STATUS.DISABLED }));
    this.#log(row.connection_id, "INFO", "CREATED", { detail: cleanName });
    this.#audit(auth.actor, { action: "mcp.connectionCreated", decision: "ALLOW", reasonCode: "ALLOW", connectionId: row.connection_id });
    return { ok: true, connection: this.#safe(row, auth) };
  }

  updateConnection({ context, connectionId, patch = {} } = {}) {
    const row = this.store.connectionById(connectionId);
    if (!row) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND };
    const auth = this.#authorize({ context, action: domain.MCP_ACTIONS.MANAGE, connection: row });
    if (!auth.ok) { this.#audit(auth.actor || null, { action: "mcp.connectionUpdated", decision: "DENY", reasonCode: auth.reason || auth.error, connectionId }); return { ok: false, error: auth.error, reason: auth.reason }; }
    const next = {};
    if (patch.name !== undefined) {
      const cleanName = String(patch.name == null ? "" : patch.name).trim().slice(0, 120);
      if (!cleanName) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "name" };
      next.name = cleanName;
    }
    if (patch.visibility !== undefined) {
      const vis = String(patch.visibility);
      if (![domain.VISIBILITY.PERSONAL, domain.VISIBILITY.ORGANIZATION].includes(vis)) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "visibility" };
      if (vis === domain.VISIBILITY.ORGANIZATION && !auth.actor.isSuper) return { ok: false, error: domain.ERROR_CODE.MCP_UNAUTHORIZED, reason: "org-manage-requires-super-admin" };
      next.visibility = vis;
    }
    const mode = patch.authMode === undefined ? row.auth_mode : String(patch.authMode);
    if (![domain.AUTH_MODE.NONE, domain.AUTH_MODE.BEARER].includes(mode)) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "authMode" };
    let encoded = null;
    let originChanged = false;
    if (patch.endpoint !== undefined) {
      encoded = domain.encodeEndpoint({ location: row.location, transport: row.transport, endpoint: patch.endpoint, allowLan: false });
      if (!encoded.ok) return encoded;
      originChanged = encoded.origin !== this.#originOf(row);
    }
    const wantsSecret = typeof patch.credentialSecret === "string" && patch.credentialSecret.length > 0;
    if (mode === domain.AUTH_MODE.BEARER && !wantsSecret && !row.credential_ref) return { ok: false, error: domain.ERROR_CODE.MCP_CREDENTIAL_MISSING, detail: "bearer-requires-secret" };
    if (mode === domain.AUTH_MODE.NONE && wantsSecret) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "secret-without-bearer" };
    // endpoint 换了 origin 却没给新 secret：绝不把旧凭据发到新 origin（显式 rebind）。
    if (originChanged && mode === domain.AUTH_MODE.BEARER && !wantsSecret) return { ok: false, error: domain.ERROR_CODE.MCP_CREDENTIAL_MISSING, detail: "credential-rebind-required" };
    let credentialRef;
    if (wantsSecret) {
      const created = this.#createCredential({ actor: auth.actor, scope: next.visibility || row.visibility, origin: encoded ? encoded.origin : this.#originOf(row), connectionId, secret: patch.credentialSecret });
      if (!created.ok) return created;
      credentialRef = created.credentialRef;
    } else if (mode === domain.AUTH_MODE.NONE && row.credential_ref) {
      // 关掉鉴权：旧凭据删除（不留在库里等以后被误用）
      this.#deleteCredential(row.credential_ref);
      credentialRef = null;
    }
    if (patch.enabled !== undefined) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "use-setEnabled" };
    next.authMode = mode;
    if (encoded) next.endpointJson = encoded.json;
    if (credentialRef !== undefined) next.credentialRef = credentialRef;
    const invalidatesLive = !!encoded || mode !== row.auth_mode || credentialRef !== undefined;
    this.#closeLiveDetached(connectionId);
    const updated = this.store.transactSync(() => this.store.updateConnection(connectionId, {
      ...next,
      ...(invalidatesLive ? { status: domain.STATUS.DISABLED, lastErrorCode: null } : {}),
    }));
    this.#log(connectionId, "INFO", "UPDATED", { detail: Object.keys(next).join(",") });
    this.#audit(auth.actor, { action: "mcp.connectionUpdated", decision: "ALLOW", reasonCode: "ALLOW", connectionId });
    return { ok: true, connection: this.#safe(updated, auth) };
  }

  deleteConnection({ context, connectionId } = {}) {
    const row = this.store.connectionById(connectionId);
    if (!row) return { ok: true, changed: false };
    const auth = this.#authorize({ context, action: domain.MCP_ACTIONS.MANAGE, connection: row });
    if (!auth.ok) { this.#audit(auth.actor || null, { action: "mcp.connectionDeleted", decision: "DENY", reasonCode: auth.reason || auth.error, connectionId }); return { ok: false, error: auth.error, reason: auth.reason }; }
    this.#closeLiveDetached(connectionId);
    if (row.credential_ref) this.#deleteCredential(row.credential_ref);
    this.store.transactSync(() => this.store.deleteLogsOfConnection(connectionId));
    const res = this.store.transactSync(() => this.store.deleteConnection(connectionId));
    this.#audit(auth.actor, { action: "mcp.connectionDeleted", decision: "ALLOW", reasonCode: "ALLOW", connectionId });
    return { ok: true, changed: res.changed, closed: true };
  }

  // ---------------------------------------------------------------------------
  // 启停 / 连接 / 重连 / 测试
  // ---------------------------------------------------------------------------

  setEnabled({ context, connectionId, enabled } = {}) {
    const row = this.store.connectionById(connectionId);
    if (!row) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND };
    const auth = this.#authorize({ context, action: domain.MCP_ACTIONS.MANAGE, connection: row });
    if (!auth.ok) return { ok: false, error: auth.error, reason: auth.reason };
    const on = !!enabled;
    if (!on) this.#closeLiveDetached(connectionId);
    const updated = this.store.transactSync(() => this.store.updateConnection(connectionId, on ? { enabled: true } : { enabled: false, status: domain.STATUS.DISABLED, lastErrorCode: null }));
    this.#log(connectionId, "INFO", on ? "ENABLED" : "DISABLED", {});
    this.#audit(auth.actor, { action: on ? "mcp.connectionEnabled" : "mcp.connectionDisabled", decision: "ALLOW", reasonCode: "ALLOW", connectionId });
    return { ok: true, connection: this.#safe(updated, auth) };
  }

  async connect({ context, connectionId } = {}) {
    const row = this.store.connectionById(connectionId);
    if (!row) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND };
    const auth = this.#authorize({ context, action: domain.MCP_ACTIONS.USE, connection: row });
    if (!auth.ok) return { ok: false, error: auth.error, reason: auth.reason };
    if (!row.enabled) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_DISABLED };
    if (this.busy.has(connectionId)) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_BUSY };
    const live = this.live.get(connectionId);
    if (live && row.status === domain.STATUS.READY) return { ok: true, reused: true, connection: this.#safe(this.store.connectionById(connectionId), auth) };
    this.busy.add(connectionId);
    try {
      const result = await this.#handshake(row);
      const fresh = this.store.connectionById(connectionId);
      if (!result.ok) return { ok: false, error: result.error, status: fresh ? fresh.status : null, connection: fresh ? this.#safe(fresh, auth) : null };
      return { ok: true, reused: false, connection: this.#safe(fresh, auth) };
    } finally {
      this.busy.delete(connectionId);
    }
  }

  /** 重连：有界（reconnectAttempts 次）+ 明确退避；鉴权类失败不空转重试。 */
  async reconnect({ context, connectionId } = {}) {
    const row = this.store.connectionById(connectionId);
    if (!row) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND };
    const auth = this.#authorize({ context, action: domain.MCP_ACTIONS.USE, connection: row });
    if (!auth.ok) return { ok: false, error: auth.error, reason: auth.reason };
    if (!row.enabled) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_DISABLED };
    if (this.busy.has(connectionId)) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_BUSY };
    this.busy.add(connectionId);
    let attempts = 0;
    let lastError = domain.ERROR_CODE.MCP_UNREACHABLE;
    try {
      await this.#closeLive(connectionId);
      while (attempts < this.reconnectAttempts) {
        attempts += 1;
        const current = this.store.connectionById(connectionId);
        if (!current) { lastError = domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND; break; }
        const result = await this.#handshake(current, { attempt: attempts });
        if (result.ok) {
          const fresh = this.store.connectionById(connectionId);
          return { ok: true, attempts, connection: this.#safe(fresh, auth) };
        }
        lastError = result.error;
        // 需要重新授权 / 凭据缺失：重试不会改变结果，立即收敛（有界，不空转）
        if (lastError === domain.ERROR_CODE.MCP_AUTH_REQUIRED || lastError === domain.ERROR_CODE.MCP_CREDENTIAL_MISSING || lastError === domain.ERROR_CODE.MCP_CREDENTIAL_STORE_UNAVAILABLE) break;
        if (attempts < this.reconnectAttempts && this.reconnectBackoffMs > 0) await sleep(this.reconnectBackoffMs * attempts);
      }
      const fresh = this.store.connectionById(connectionId);
      this.#log(connectionId, "ERROR", "RECONNECT_EXHAUSTED", { errorCode: lastError, detail: "attempts=" + attempts });
      return { ok: false, error: lastError, attempts, limit: this.reconnectAttempts, status: fresh ? fresh.status : null, connection: fresh ? this.#safe(fresh, auth) : null };
    } finally {
      this.busy.delete(connectionId);
    }
  }

  /** 测试：总是执行一次真实握手（不复用现有连接），把协商结果写入记录并返回。 */
  async test({ context, connectionId } = {}) {
    const row = this.store.connectionById(connectionId);
    if (!row) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND };
    const auth = this.#authorize({ context, action: domain.MCP_ACTIONS.TEST, connection: row });
    if (!auth.ok) return { ok: false, error: auth.error, reason: auth.reason };
    if (!row.enabled) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_DISABLED };
    if (this.busy.has(connectionId)) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_BUSY };
    this.busy.add(connectionId);
    try {
      await this.#closeLive(connectionId);
      const result = await this.#handshake(this.store.connectionById(connectionId), { attempt: 1 });
      const fresh = this.store.connectionById(connectionId);
      if (!result.ok) return { ok: false, error: result.error, reachable: result.reachable !== false, status: fresh ? fresh.status : null, connection: fresh ? this.#safe(fresh, auth) : null };
      return { ok: true, reachable: true, negotiated: result.snapshot, connection: this.#safe(fresh, auth) };
    } finally {
      this.busy.delete(connectionId);
    }
  }

  testLog({ context, connectionId, limit = 20 } = {}) {
    const row = this.store.connectionById(connectionId);
    if (!row) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND, items: [] };
    const auth = this.#authorize({ context, action: domain.MCP_ACTIONS.VIEW, connection: row });
    if (!auth.ok) return { ok: false, error: auth.error, reason: auth.reason, items: [] };
    const items = this.store.logsOfConnection(connectionId, limit).map((r) => ({ at: r.at, level: r.level, event: r.event, errorCode: r.error_code || null, detail: r.detail || null }));
    return { ok: true, items, connectionId };
  }

  /** 第一批不开放工具调用：唯一入口明确拒绝（不是"未实现所以报错"，是显式的产品边界）。 */
  invokeTool() {
    return { ok: false, error: domain.ERROR_CODE.MCP_TOOL_INVOCATION_NOT_ENABLED };
  }

  /** 关闭全部活动连接（宿主退出 / 测试收尾）。 */
  async dispose() {
    const ids = [...this.live.keys()];
    for (const id of ids) await this.#closeLive(id);
    return { ok: true, closed: ids.length };
  }

  // ---------------------------------------------------------------------------
  // 内部：凭据 / 握手 / 生命周期
  // ---------------------------------------------------------------------------

  #originOf(row) {
    const parsed = domain.parseJson(row.endpoint_json, null) || {};
    if (parsed.serverKey) return "mcp-local:" + String(parsed.serverKey);
    try {
      return new URL(String(parsed.url)).origin;
    } catch {
      return "";
    }
  }

  #createCredential({ actor, scope, origin, connectionId, secret }) {
    if (!this.credentials) return { ok: false, error: domain.ERROR_CODE.MCP_CREDENTIAL_STORE_UNAVAILABLE };
    const created = this.credentials.createSync({ ownerUserId: actor.user.id, organizationId: actor.organizationId, scope, providerOrigin: origin, providerConfigId: connectionId || null, secret });
    if (!created.ok) return { ok: false, error: created.error === "CREDENTIAL_STORE_UNAVAILABLE" ? domain.ERROR_CODE.MCP_CREDENTIAL_STORE_UNAVAILABLE : domain.ERROR_CODE.MCP_INVALID_INPUT, detail: created.error };
    return { ok: true, credentialRef: created.credentialRef };
  }

  #deleteCredential(credentialRef) {
    if (!this.credentials || !credentialRef) return;
    try { this.credentials.deleteSync({ credentialRef }); } catch { /* 删除失败不阻断连接删除 */ }
  }

  #transition(row, next, { lastErrorCode = null } = {}) {
    if (!domain.canTransition(row.status, next)) return { ok: false, error: domain.ERROR_CODE.MCP_STATE_INVALID, from: row.status, to: next };
    this.store.transactSync(() => this.store.updateConnection(row.connection_id, { status: next, lastErrorCode }));
    return { ok: true };
  }

  async #closeLive(connectionId) {
    const entry = this.live.get(connectionId);
    if (!entry) return { ok: true, closed: false };
    this.live.delete(connectionId);
    try { await entry.client.close(); } catch { /* 子进程回收失败也要把条目清掉，避免"假装还活着" */ }
    return { ok: true, closed: true };
  }

  /** 同步命令里也要收掉子进程：先摘掉条目（之后的 connect 不会复用），关闭在事件循环里完成。 */
  #closeLiveDetached(connectionId) {
    const entry = this.live.get(connectionId);
    if (!entry) return false;
    this.live.delete(connectionId);
    Promise.resolve(entry.client.close()).catch(() => {});
    return true;
  }

  /**
   * 一次真实握手：resolve endpoint → (BEARER) 取凭据 → connect → initialize → tools/list。
   * 无论成功失败都写记录：成功写协商快照，失败写稳定错误码与真实协议版本（如果有）。
   */
  async #handshake(row, { attempt = 1 } = {}) {
    if (!row) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND };
    const connectionId = row.connection_id;
    this.#log(connectionId, "INFO", "CONNECT_START", { detail: "attempt=" + attempt });
    const starting = this.store.connectionById(connectionId);
    if (!starting.enabled) return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_DISABLED };
    if (starting.status !== domain.STATUS.CONNECTING) {
      const t = this.#transition(starting, domain.STATUS.CONNECTING);
      if (!t.ok) return t;
    }
    const endpointJson = domain.parseJson(starting.endpoint_json, {});
    let endpoint = null;
    let credentialSecret = null;
    if (starting.transport === domain.TRANSPORT.STDIO) {
      const local = domain.validateLocalEndpoint(endpointJson);
      if (!local.ok) return this.#fail(connectionId, local.error, { detail: "serverKey=" + String(endpointJson.serverKey || "") });
      endpoint = local;
    } else {
      const remote = domain.validateRemoteEndpoint(endpointJson.url, { allowLan: false });
      if (!remote.ok) return this.#fail(connectionId, remote.error, { detail: remote.detail });
      endpoint = remote;
    }
    if (starting.auth_mode === domain.AUTH_MODE.BEARER) {
      const resolved = this.credentials ? this.credentials.resolveInternalSync({ credentialRef: starting.credential_ref }) : { ok: false, error: "CREDENTIAL_STORE_UNAVAILABLE" };
      if (!resolved.ok) {
        const code = resolved.error === "CREDENTIAL_STORE_UNAVAILABLE" ? domain.ERROR_CODE.MCP_CREDENTIAL_STORE_UNAVAILABLE : domain.ERROR_CODE.MCP_CREDENTIAL_MISSING;
        return this.#fail(connectionId, code);
      }
      if (resolved.providerOrigin && resolved.providerOrigin !== this.#originOf(starting)) return this.#fail(connectionId, domain.ERROR_CODE.MCP_ENDPOINT_BLOCKED, { detail: "credential-origin-mismatch" });
      credentialSecret = resolved.secret;
    }
    const client = this.clientFactory();
    const opened = await client.connect({ transport: starting.transport, endpoint, credentialSecret, authMode: starting.auth_mode });
    if (!opened.ok) return this.#fail(connectionId, opened.error, { detail: opened.detail, client });
    const init = await client.initialize({});
    if (!init.ok) {
      // 协议版本不符时仍记录服务端真实返回的版本/身份 —— "失败"不等于"没看到"
      if (init.protocolVersion || init.serverInfo) {
        this.store.transactSync(() => this.store.updateConnection(connectionId, { protocolVersion: init.protocolVersion || null, serverName: init.serverInfo ? init.serverInfo.name : null, serverVersion: init.serverInfo ? init.serverInfo.version : null, capabilitiesJson: JSON.stringify(init.capabilities || {}) }));
      }
      return this.#fail(connectionId, init.error, { detail: init.detail, client });
    }
    const discovered = await client.listTools({});
    if (!discovered.ok) {
      this.store.transactSync(() => this.store.updateConnection(connectionId, { protocolVersion: init.protocolVersion, serverName: init.serverInfo.name, serverVersion: init.serverInfo.version, capabilitiesJson: JSON.stringify(init.capabilities || {}) }));
      return this.#fail(connectionId, discovered.error, { detail: "tools-discovery-failed", client });
    }
    const hash = domain.toolsHash(discovered.tools);
    this.store.transactSync(() => this.store.updateConnection(connectionId, {
      protocolVersion: init.protocolVersion,
      serverName: init.serverInfo.name,
      serverVersion: init.serverInfo.version,
      capabilitiesJson: JSON.stringify(init.capabilities || {}),
      toolsJson: JSON.stringify(discovered.tools),
      toolsHash: hash,
      lastConnectedAt: this.#now(),
    }));
    const ready = this.#transition(this.store.connectionById(connectionId), domain.STATUS.READY, { lastErrorCode: null });
    if (!ready.ok) { await client.close(); return ready; }
    this.live.set(connectionId, { client, openedAt: this.#now() });
    this.#log(connectionId, "INFO", "TOOLS_DISCOVERED", { detail: "tools=" + discovered.tools.length + " pages=" + discovered.pages + " truncated=" + discovered.truncated + " hash=" + hash.slice(0, 16) });
    return {
      ok: true,
      snapshot: { protocolVersion: init.protocolVersion, serverName: init.serverInfo.name, serverVersion: init.serverInfo.version, capabilities: init.capabilities, toolCount: discovered.tools.length, tools: discovered.tools.map((t) => t.name), toolsHash: hash, pages: discovered.pages, truncated: discovered.truncated, transport: starting.transport, location: starting.location },
    };
  }

  async #fail(connectionId, code, { detail = null, client = null } = {}) {
    if (client) { try { await client.close(); } catch { /* 失败路径也要回收 */ } }
    const row = this.store.connectionById(connectionId);
    const next = domain.statusForError(code);
    // 失败必须落到终态：即使当前状态不是状态机允许的前驱（例如并发删改），也要如实记录错误码。
    if (row) this.store.transactSync(() => this.store.updateConnection(connectionId, { status: next, lastErrorCode: code }));
    this.live.delete(connectionId);
    this.#log(connectionId, "ERROR", "CONNECT_FAILED", { errorCode: code, detail });
    return { ok: false, error: code, status: next, detail };
  }
}

module.exports = { McpService, DEFAULT_RECONNECT_ATTEMPTS };
