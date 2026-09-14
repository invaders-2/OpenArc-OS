/**
 * D3-04D · 系统级 OpenArc Resource Picker。
 *
 * 只展示：User Accessible ∩ App Accessible ∩ Requested Resource Type ∩ Requested Action。
 * 只返回 ResourceRef（+ 安全 metadata），绝不返回绝对路径 / internal object key。
 * 搜索复用 D3-04C Authorized Search Provider；Preview 复用 D3-04C Secure Preview。
 */
"use strict";

const crypto = require("node:crypto");
const authz = require("./authorization-domain.cjs");

const PICKER_TOKEN_TTL_MS = 60 * 1000;

class ResourcePickerService {
  constructor({ identity, authService, searchService, resourceStore, logger = null, clock = null } = {}) {
    if (!identity) throw new Error("ResourcePickerService 需要 IdentityStore");
    if (!authService) throw new Error("ResourcePickerService 需要 AuthorizationService");
    if (!searchService) throw new Error("ResourcePickerService 需要 SearchService");
    this.identity = identity;
    this.authService = authService;
    this.searchService = searchService;
    this.resourceStore = resourceStore;
    this.logger = logger;
    this.clock = typeof clock === "function" ? clock : identity.clock;
    this.tokens = new Map();
  }

  #appContext(context, appId) {
    return { ...(context || {}), appId: String(appId || (context && context.appId) || "resource-library") };
  }

  #actionsOf(requestedActions) {
    const list = Array.isArray(requestedActions) && requestedActions.length ? requestedActions : [authz.ACTION.READ];
    return list.filter((a) => authz.RESOURCE_ACTIONS.includes(String(a))).map(String);
  }

  /** Picker 查询：服务端交集过滤，分页。 */
  async query({ context, appId, resourceTypes = null, requestedActions = null, collectionId = null, departmentId = null, query = "", limit = 40, offset = 0 } = {}) {
    const actor = this.authService.resolveActor({ context });
    if (!actor.ok) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN", items: [] };
    const app = this.#appContext(context, appId);
    const actions = this.#actionsOf(requestedActions);
    const filter = {};
    if (collectionId) filter.collectionId = collectionId;
    if (departmentId) filter.departmentId = departmentId;
    if (resourceTypes && resourceTypes.length === 1) filter.resourceType = resourceTypes[0];
    const res = await this.searchService.search({ context: app, query: query || "", filter, limit: Math.min(200, Math.max(1, Number(limit) || 40)), offset: Math.max(0, Number(offset) || 0) });
    if (!res.ok) return { ok: false, error: res.error || "SEARCH_UNAVAILABLE", items: [], total: 0 };
    let items = res.items;
    if (resourceTypes && resourceTypes.length) {
      const allowed = new Set(resourceTypes.map(String));
      items = items.filter((it) => allowed.has(String(it.resourceType)));
    }
    // requestedActions 必须对 App ∩ User 全部成立（除隐式的 search 外）。
    if (actions.length) {
      const ids = items.map((it) => it.resourceId);
      const checked = [];
      for (const it of items) {
        let allowedAll = true;
        for (const action of actions) {
          const one = this.authService.authorizeMany({ context: app, action, resources: [it.resourceId] });
          const decision = one && one.ok && one.results && one.results[0] ? one.results[0].decision : "DENY";
          if (decision !== "ALLOW") { allowedAll = false; break; }
        }
        if (allowedAll) checked.push(it);
      }
      void ids;
      items = checked;
    }
    return { ok: true, items, total: items.length, hasMore: !!res.hasMore, scanned: res.scanned, limit: res.limit, offset: res.offset };
  }

  /** Picker 选择：返回 ResourceRef + 动作确认；可选短时 selection token。 */
  choose({ context, appId, resourceRef, requestedActions = null } = {}) {
    const actor = this.authService.resolveActor({ context });
    if (!actor.ok) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const resourceId = authz.parseResourceRef(resourceRef);
    if (!resourceId) return { ok: false, error: "INVALID_INPUT" };
    const app = this.#appContext(context, appId);
    const actions = this.#actionsOf(requestedActions);
    const granted = [];
    for (const action of actions) {
      const one = this.authService.authorizeMany({ context: app, action, resources: [resourceId] });
      const decision = one && one.ok && one.results && one.results[0] ? one.results[0].decision : "DENY";
      if (decision !== "ALLOW") return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN", action };
      granted.push(action);
    }
    const token = "pick_" + crypto.randomBytes(16).toString("base64url");
    const expiresAt = this.clock() + PICKER_TOKEN_TTL_MS;
    this.tokens.set(token, { token, userId: actor.user.id, appId: app.appId, resourceId, actions: granted, expiresAt });
    return { ok: true, resourceRef: authz.toResourceRef(resourceId), resourceId, actions: granted, selectionToken: token, expiresAt };
  }

  /**
   * 使用 selection token 前**重新授权**：token 不是绕过授权，只是绑定用户/App/资源的短期句柄。
   * Grant 撤销 / App disable / 用户停用 / 部门迁移后，这里会立即 DENY。
   */
  validateSelection({ context, selectionToken, action = authz.ACTION.READ } = {}) {
    const rec = this.tokens.get(String(selectionToken || ""));
    if (!rec) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    if (this.clock() >= rec.expiresAt) { this.tokens.delete(rec.token); return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" }; }
    const actor = this.authService.resolveActor({ context });
    if (!actor.ok || actor.user.id !== rec.userId) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const app = this.#appContext(context, rec.appId);
    const one = this.authService.authorizeMany({ context: app, action, resources: [rec.resourceId] });
    const decision = one && one.ok && one.results && one.results[0] ? one.results[0].decision : "DENY";
    if (decision !== "ALLOW") return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    return { ok: true, resourceId: rec.resourceId, resourceRef: authz.toResourceRef(rec.resourceId), appId: rec.appId };
  }

  revokeSelection(selectionToken) { return { ok: true, changed: this.tokens.delete(String(selectionToken || "")) }; }
}

module.exports = { ResourcePickerService, PICKER_TOKEN_TTL_MS };
