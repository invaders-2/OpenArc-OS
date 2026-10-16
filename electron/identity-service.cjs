/**
 * D3-01 · Identity Service —— **身份状态的唯一权威**（§25）。
 *
 * 与 Window Manager 同一条原则：
 *
 *   渲染进程**没有**可改的身份状态。它只能 `dispatch(command)`，
 *   拿回一份 `identitySnapshot` 投影。未来的 AI 走同一条命令层，
 *   不存在"UI 直接改 loggedIn"的旁路 —— 因为那个变量根本不存在。
 *
 * 三条硬边界：
 *   1. **token 不出服务层。** 所有返回给渲染进程的结果都被 `sanitize()` 过一遍，
 *      token / token_hash / verifier 一律不出门。
 *   2. **session 不是 localStorage 里的布尔值。** 每次校验都回到持久层，
 *      由 authVersion / status / 有效期共同决定。
 *   3. **失败要有补偿。** 写 OS 受保护存储失败 → 立刻撤销刚建的 session，
 *      决不允许出现"库里有 session、但没人能恢复它"或反之（§27）。
 */
"use strict";

const domain = require("./identity-domain.cjs");
const { IdentityStore } = require("./identity-store.cjs");
const passwords = require("./password.cjs");

const { ERROR, EVENT } = domain;

/**
 * 单次 setTimeout 的上限（2^31-1 ms ≈ 24.8 天）。
 * 比它更远的 horizon 必须**分块重排**：setTimeout 溢出会立刻触发，那就成了忙循环。
 * 产品默认（12h / 2h）远小于它，这一条是为"注入超长有效期"准备的。
 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** 渲染进程可以带走的字段。其余一律在服务层截住。 */
function sanitizeSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    ref: session.ref,
    createdAt: session.created_at,
    lastSeenAt: session.last_seen_at,
    expiresAt: session.expires_at,
    locked: session.locked_at != null,
  };
}

class IdentityService {
  /**
   * @param opts.store      IdentityStore（已 open）
   * @param opts.secrets    SessionSecretStore
   * @param opts.logger     IdentityLogger
   * @param opts.allowAdmin 是否放行 admin / 测试夹具命令（默认 false）
   */
  constructor({ store, secrets, logger, allowAdmin = false, timers = null } = {}) {
    if (!store) throw new Error("IdentityService 需要 store");
    this.store = store;
    this.secrets = secrets || null;
    this.logger = logger || null;
    this.allowAdmin = !!allowAdmin;
    /** B4：本地账号管理服务（identity-bootstrap.cjs 注入；未注入时本地账号命令结构化报缺）。 */
    this.localAccount = null;
    this.listeners = new Set();
    /** 当前进程持有的会话引用。渲染进程每次启动都会重新向服务要一次。 */
    this.current = null;
    /**
     * 定时器接缝。产品走全局 setTimeout/clearTimeout；
     * 测试可注入计数 / 可控实现来断言"在途定时器 ≤ 1"并精确触发到期。
     */
    this.timers = {
      setTimeout: typeof timers?.setTimeout === "function" ? timers.setTimeout : setTimeout,
      clearTimeout: typeof timers?.clearTimeout === "function" ? timers.clearTimeout : clearTimeout,
    };
    this.#expiryTimer = null;
    this.#expiryGen = 0;
  }

  /** 在途的到期定时器句柄；同一时刻最多一个。 */
  #expiryTimer;
  /** 代次：每次重排自增，让已经出队的旧回调失效（旧到期不得动新会话）。 */
  #expiryGen;

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * B4 接线：挂载本地账号服务（local-account-service.cjs）。
   * 晚绑定是因为装配顺序：IdentityService 先于 AuthorizationService 建成，
   * 而 LocalAccountService 需要 authorization / authStore。
   */
  attachLocalAccount(localAccount) {
    this.localAccount = localAccount && typeof localAccount.listAuthUsers === "function" ? localAccount : null;
    return !!this.localAccount;
  }

  #emit(event, payload = {}) {
    const record = { event, at: this.store.clock(), ...payload };
    this.logger?.log({ event: `emit:${event}`, result: "OK", detail: { hasSession: !!payload.snapshot } });
    for (const fn of this.listeners) {
      try {
        fn(record);
      } catch {
        /* 单个监听者出错不该打断身份流转 */
      }
    }
  }

  #log(record) {
    this.logger?.log(record);
  }

  // -------------------------------------------------------------------------
  // 到期调度（§9 / §32）
  //
  // **单一定时器**：每次会话状态变化后，从持久层权威行算 dueAt = min(expires_at,
  // idle_expires_at) 重排一次。禁止 setInterval、禁止渲染层轮询、禁止固定高频轮询；
  // 超过 MAX_TIMEOUT_MS 的 horizon 分块重排。
  // -------------------------------------------------------------------------

  /** 取消在途定时器，并让已经出队的旧回调失效。 */
  #clearExpiryTimer() {
    this.#expiryGen += 1;
    if (this.#expiryTimer == null) return;
    try {
      this.timers.clearTimeout(this.#expiryTimer);
    } catch {
      /* 定时器已消失 */
    }
    this.#expiryTimer = null;
  }

  /**
   * 按**持久层权威行**重排到期。没有会话 / 会话已终结 → 不留任何安排。
   * 绝不凭内存里的时间戳排程：合法活动刚延长过空闲期限时，只有库里的行算数。
   */
  #scheduleExpiry() {
    this.#clearExpiryTimer();
    if (!this.store || !this.store.db) return;
    const ref = this.current;
    if (!ref) return;
    let row = null;
    try {
      row = this.store.sessionByRef(ref);
    } catch {
      return;
    }
    if (!row || row.revoked_at != null) return;
    const now = this.store.clock();
    const expiry = domain.sessionExpiry(row, now);
    const dueAt = Number.isFinite(expiry?.dueAt)
      ? expiry.dueAt
      : Math.min(Number(row.expires_at), Number(row.idle_expires_at));
    if (!Number.isFinite(dueAt)) return;
    const delay = Math.max(0, Math.min(dueAt - now, MAX_TIMEOUT_MS));
    const gen = this.#expiryGen;
    const handle = this.timers.setTimeout(() => this.#onExpiryDue(gen, ref), delay);
    if (handle && typeof handle.unref === "function") handle.unref();
    this.#expiryTimer = handle;
  }

  /**
   * 定时器到点。**一切以权威行为准**：
   *   · 已被重排（旧安排）       → 什么都不做
   *   · 已不是排程时那一代会话   → 什么都不做（旧到期不得关掉随后登录的新会话）
   *   · 已被其它路径终结         → store 会回 ended，什么都不做
   *   · 合法活动延长过空闲期限   → store 回 not-expired，只重排
   *   · 真的过期                 → 落终态 + 新事件
   */
  #onExpiryDue(gen, ref) {
    if (gen !== this.#expiryGen) return;
    this.#expiryTimer = null;
    if (this.current !== ref) return;
    this.#triggerExpiry(ref);
  }

  #triggerExpiry(ref) {
    this.#expireSession(ref).catch((e) => {
      this.#log({ event: "session-expired", result: "ERROR", error_code: ERROR.INTERNAL_ERROR, detail: String((e && e.message) || e) });
    });
  }

  /** 终结 + 广播。幂等由 store.expireSession 保证：重复触发只有第一次 changed。 */
  async #expireSession(ref) {
    const res = await this.store.expireSession(ref);
    if (!res.changed) {
      if (res.reason === "not-expired") this.#scheduleExpiry();
      return res;
    }
    // 落终态期间用户可能已经重新登录（新会话）：旧到期不得关掉新会话的连接，也不清它的 token。
    if (this.current !== null && this.current !== ref) return res;
    this.current = null;
    this.#clearExpiryTimer();
    try {
      await this.secrets?.clear();
    } catch {
      /* token 清理失败不改变"会话已到期"这个事实 */
    }
    this.#emit(EVENT.SESSION_EXPIRED, { reason: res.reason, sessionId: res.sessionId || null, sessionRef: ref });
    return res;
  }

  /**
   * 每条命令之后收敛一次到期状态。
   * 懒判定（validate / status / 各受保护命令）观察到的到期与定时器走**同一条**
   * 终结路径，因此不可能出现"定时器说过期、命令层还认它有效"或反之。
   */
  #reconcileExpiry() {
    if (!this.store || !this.store.db) return;
    const ref = this.current;
    if (!ref) {
      this.#clearExpiryTimer();
      return;
    }
    let row = null;
    try {
      row = this.store.sessionByRef(ref);
    } catch {
      return;
    }
    if (!row) {
      this.#clearExpiryTimer();
      return;
    }
    if (row.revoked_at == null && domain.sessionExpiry(row, this.store.clock())) {
      this.#clearExpiryTimer();
      this.#triggerExpiry(ref);
      return;
    }
    this.#scheduleExpiry();
  }

  get snapshot() {
    if (!this.current) return domain.emptySnapshot({ initialized: this.store.status().initialized });
    const ref = this.current;
    const res = this.store.validateSession(ref, { sensitive: false });
    if (!res.ok) {
      this.current = null;
      // 懒判定看到的到期同样要落权威终态并广播（与定时器同一条路径、同一份判据）。
      if (res.error === ERROR.SESSION_EXPIRED) this.#triggerExpiry(ref);
      return domain.emptySnapshot({ initialized: this.store.status().initialized });
    }
    return domain.identitySnapshot({
      user: res.user,
      session: res.session,
      initialized: true,
    });
  }

  // -------------------------------------------------------------------------
  // 命令层（§25 / §26）
  // -------------------------------------------------------------------------

  async dispatch(command = {}) {
    const type = String(command.type || "");
    const started = this.store.clock();
    if (!domain.ALL_COMMANDS.includes(type)) {
      this.#log({ event: type || "(empty)", result: "DENY", error_code: ERROR.INVALID_INPUT });
      return domain.fail(ERROR.INVALID_INPUT, "unknown-command");
    }
    if (domain.ADMIN_COMMANDS.includes(type) && !this.allowAdmin) {
      this.#log({ event: type, result: "DENY", error_code: ERROR.INVALID_INPUT });
      return domain.fail(ERROR.INVALID_INPUT, "admin-command-disabled");
    }

    // B4：本地账号管理命令（命令表见 identity-domain.cjs LOCAL_ACCOUNT_COMMANDS）。
    // 与既有命令共用同一个 identity:command 通道、同一套 durationMs / 到期收敛。
    if (domain.isLocalAccountCommand(type)) {
      const localResult = await this.#dispatchLocalAccount(command);
      localResult.durationMs = this.store.clock() - started;
      this.#reconcileExpiry();
      return localResult;
    }

    let result;
    switch (type) {
      case "identity/status":
        result = this.#status();
        break;
      case "identity/initialize":
        result = await this.#initialize(command);
        break;
      case "identity/login":
        result = await this.#login(command);
        break;
      case "identity/restore":
        result = await this.#restore();
        break;
      case "identity/logout":
        result = await this.#logout(command);
        break;
      case "identity/lock":
        result = await this.#lock(command);
        break;
      case "identity/unlock":
        result = await this.#unlock(command);
        break;
      case "identity/change-password":
        result = await this.#changePassword(command);
        break;
      case "identity/update-profile":
        result = await this.#updateProfile(command);
        break;
      case "identity/validate":
        result = this.#validate(command);
        break;
      case "identity/disable-user":
        result = await this.#setUserStatus(command, domain.USER_STATUS.DISABLED);
        break;
      case "identity/enable-user":
        result = await this.#setUserStatus(command, domain.USER_STATUS.ACTIVE);
        break;
      case "identity/reset-installation":
        result = await this.#reset(command);
        break;
      default:
        result = domain.fail(ERROR.INVALID_INPUT, "unhandled");
    }
    result.durationMs = this.store.clock() - started;
    // 会话状态可能刚变（login / restore / touch / unlock / 改密 / 登出 …）：
    // 按持久层权威行重排那个唯一定时器，并把懒判定看到的到期收敛成同一条终结路径。
    this.#reconcileExpiry();
    return result;
  }

  /**
   * B4 · 本地账号命令分发（命令名单见 identity-domain.cjs LOCAL_ACCOUNT_COMMANDS）。
   *
   * 认证闸门统一放在这里：所有本地账号命令都要求一个可解析的登录会话，
   * 超级管理员 / 部门管理员的具体判定沿用 local-account-service.cjs 既有实现，
   * 不在身份服务里复制第二套权限。返回值为 local-account-service 的公开投影，
   * 不含口令 / 哈希 / 密钥 / 绝对路径（写入的审计事件名沿用 B4e 源语义）。
   */
  async #dispatchLocalAccount(command) {
    if (!this.localAccount) return domain.fail(ERROR.INTERNAL_ERROR, "local-account-not-ready");
    // 上下文 App 固定为内置 resource-library：它承载治理动作的授权主体，
    // 与命令里的 appId（那是"被配置的目标 APP"）是两回事，不能混用。
    const context = {
      sessionRef: command.sessionRef || this.current || null,
      appId: "resource-library",
      source: "ui",
    };
    const authorization = this.localAccount.authorization;
    const actor = authorization && typeof authorization.resolveActor === "function" ? authorization.resolveActor({ context }) : null;
    if (!actor || actor.ok !== true) return domain.fail(ERROR.SESSION_REVOKED, "local-account-unauthenticated");
    const account = this.localAccount;
    switch (command.type) {
      case "identity/departments-list": return account.listAuthDepartments({ context });
      case "identity/department-create": return account.createAuthDepartment({ context, name: command.name, description: command.description });
      case "identity/department-update": return account.updateAuthDepartment({ context, departmentId: command.departmentId, name: command.name, description: command.description, status: command.status });
      case "identity/department-delete": return account.deleteAuthDepartment({ context, departmentId: command.departmentId });
      case "identity/users-list": return account.listAuthUsers({ context });
      case "identity/user-create": return await account.createAuthUser({ context, identifier: command.identifier, password: command.password, displayName: command.displayName, departmentId: command.departmentId, role: command.role });
      case "identity/user-update": return await account.updateAuthUser({ context, userId: command.userId, username: command.username, departmentId: command.departmentId, role: command.role, status: command.status });
      case "identity/user-delete": return account.deleteAuthUser({ context, userId: command.userId });
      case "identity/user-reset-password": return await account.resetAuthPassword({ context, userId: command.userId, password: command.password });
      case "identity/app-access-rule-save": return account.saveAppAccessRule({ context, appId: command.appId, rule: command.rule });
      case "identity/app-permission-policy-save": return account.saveAppPermissionPolicy({ context, permissionCode: command.permissionCode, policy: command.policy, appId: command.appId });
      case "identity/app-permission-snapshot": return account.appPermissionSnapshot({ userId: command.userId });
      case "identity/app-access-summary": return account.appAccessSummary(command.userId);
      case "identity/local-account-info": return account.localAccountInfo({ context });
      case "identity/audit-list": return account.listAuditEvents({ context, event: command.event, since: command.since, until: command.until, limit: command.limit, offset: command.offset });
      default: return domain.fail(ERROR.INVALID_INPUT, "unhandled-local-account");
    }
  }

  // --- 各命令 ---------------------------------------------------------------

  #status() {
    const st = this.store.status();
    const secret = this.secrets?.describe() || null;
    return domain.ok({
      type: "identity/status",
      initialized: st.initialized,
      initStatus: st.status,
      installationId: st.installationId,
      userCount: st.userCount,
      installation: domain.installationSnapshot({ installation: this.store.installation(), userCount: st.userCount }),
      secretBackend: secret,
      snapshot: this.snapshot,
    });
  }

  async #initialize({ identifier, password, displayName, avatarRef }) {
    let nextAvatarRef;
    if (avatarRef !== undefined) {
      const check = domain.validateAvatarRef(avatarRef);
      if (!check.ok) {
        this.store.audit("initialize", { result: "DENY", errorCode: check.error });
        return { ...check, type: "identity/initialize" };
      }
      nextAvatarRef = check.avatarRef;
    }
    const res = await this.store.initialize({ identifier, password, displayName, avatarRef: nextAvatarRef });
    if (!res.ok) return { ...res, type: "identity/initialize" };
    // 初始化**不自动登录**：初始化与登录是两条独立命令，
    // 自动登录会把"初始口令是否正确"这件最重要的事跳过。
    this.#emit(EVENT.INITIALIZED, { installationId: res.installationId, userId: res.userId });
    return domain.ok({
      type: "identity/initialize",
      installationId: res.installationId,
      userId: res.userId,
      identifier: res.identifier,
      requiresLogin: true,
    });
  }

  /**
   * 登录成功后的三段式落位：token → OS 受保护存储；ref → 当前进程；快照 → 渲染进程。
   *
   * **写受保护存储失败要补偿**：此时库里已经有 session 行了，
   * 不撤销它就会留下一条"重启后没人能恢复、但 validate 仍然通过"的幽灵会话。
   */
  async #adoptSession({ user, session, token }) {
    if (this.secrets) {
      try {
        await this.secrets.save({ sessionId: session.id, token });
      } catch (e) {
        this.store.logout(session.ref);
        this.#log({ event: "adopt-session", result: "ERROR", error_code: ERROR.INTERNAL_ERROR });
        return domain.fail(ERROR.INTERNAL_ERROR, "secret-store-write-failed");
      }
    }
    this.current = session.ref;
    return domain.ok({
      user,
      session,
      snapshot: domain.identitySnapshot({ user, session, initialized: true }),
    });
  }

  async #login({ identifier, password }) {
    const st = this.store.status();
    if (!st.initialized) return domain.fail(ERROR.NOT_INITIALIZED);
    const res = await this.store.login({ identifier, password });
    if (!res.ok) return { ...res, type: "identity/login" };
    const adopted = await this.#adoptSession(res);
    if (!adopted.ok) return { ...adopted, type: "identity/login" };
    this.#emit(EVENT.SESSION_CHANGED, { snapshot: adopted.snapshot, reason: "login" });
    return domain.ok({
      type: "identity/login",
      snapshot: adopted.snapshot,
      session: sanitizeSession(res.session),
    });
  }

  /**
   * 启动恢复（§39）。渲染进程启动时**只能**走这条路拿回身份。
   *
   * 关键：渲染进程在拿到结果之前**不得**渲染桌面内容 ——
   * 否则就是"先显示桌面、几百毫秒后闪回登录"的敏感内容闪现。
   */
  async #restore() {
    const st = this.store.status();
    if (!st.initialized) return domain.fail(ERROR.NOT_INITIALIZED);
    const secret = this.secrets ? await this.secrets.read() : null;
    if (!secret?.token) {
      this.current = null;
      return domain.fail(ERROR.SESSION_REVOKED, "no-stored-session");
    }
    const res = this.store.restoreByToken(secret.token);
    if (!res.ok) {
      await this.secrets?.clear();
      this.current = null;
      return { ...res, type: "identity/restore" };
    }
    this.current = res.session.ref;
    const snapshot = domain.identitySnapshot({ user: res.user, session: res.session, initialized: true });
    this.#emit(EVENT.SESSION_CHANGED, { snapshot, reason: "restore" });
    return domain.ok({ type: "identity/restore", snapshot, session: sanitizeSession(res.session) });
  }

  async #logout({ sessionRef }) {
    const ref = sessionRef || this.current;
    if (!ref) return domain.fail(ERROR.SESSION_REVOKED);
    const res = this.store.logout(ref);
    if (!res.ok) return { ...res, type: "identity/logout" };
    // 顺序重要：先撤销（库），再清受保护存储。
    // 反过来会在两者之间留下"token 没了但 session 还活着"的窗口。
    await this.secrets?.clear();
    if (this.current === ref) this.current = null;
    this.#emit(EVENT.LOGGED_OUT, { reason: "logout" });
    return domain.ok({ type: "identity/logout", revoked: true });
  }

  async #lock({ sessionRef }) {
    const ref = sessionRef || this.current;
    if (!ref) return domain.fail(ERROR.SESSION_REVOKED);
    const res = this.store.lock(ref);
    if (!res.ok) return { ...res, type: "identity/lock" };
    this.#emit(EVENT.LOCKED, { reason: "user" });
    return domain.ok({
      type: "identity/lock",
      locked: true,
      snapshot: this.snapshot,
    });
  }

  async #unlock({ sessionRef, password }) {
    const ref = sessionRef || this.current;
    if (!ref) return domain.fail(ERROR.SESSION_REVOKED);
    const res = await this.store.unlock(ref, password);
    if (!res.ok) return { ...res, type: "identity/unlock" };
    // 解锁会轮换 ref 与 token，两者都要跟着换
    if (this.secrets) {
      try {
        await this.secrets.save({ sessionId: res.session.id, token: res.token });
      } catch {
        await this.secrets.clear();
        this.current = null;
        return domain.fail(ERROR.INTERNAL_ERROR, "secret-store-write-failed");
      }
    }
    this.current = res.session.ref;
    const snapshot = domain.identitySnapshot({ user: res.user, session: res.session, initialized: true });
    this.#emit(EVENT.UNLOCKED, { snapshot });
    return domain.ok({
      type: "identity/unlock",
      snapshot,
      session: sanitizeSession(res.session),
    });
  }

  async #changePassword({ sessionRef, currentPassword, newPassword }) {
    const ref = sessionRef || this.current;
    if (!ref) return domain.fail(ERROR.SESSION_REVOKED);
    const res = await this.store.changePassword(ref, currentPassword, newPassword);
    if (!res.ok) return { ...res, type: "identity/change-password" };
    // 全量撤销：受保护存储里的 token 随即作废，本进程也回到未登录
    await this.secrets?.clear();
    this.current = null;
    this.#emit(EVENT.LOGGED_OUT, { reason: "password-changed" });
    return domain.ok({
      type: "identity/change-password",
      revokedAllSessions: true,
      requiresLogin: true,
    });
  }

  /**
   * 资料更新（displayName / avatarRef）。
   *
   * **只接受活跃 session**：资料不是凭据变更，不撤销 session、不要求重新登录，
   * 所以目标用户只能由已认证的 session 定位。**没有 identifier 查找路径** ——
   * 一旦去掉口令再认证，那条路径就等于"任何人无需认证即可改资料"。
   * 拿不到 session 一律 SESSION_REVOKED，不静默、不降级。
   */
  async #updateProfile({ sessionRef, displayName, avatarRef }) {
    const ref = sessionRef || this.current;
    if (!ref) {
      this.store.audit("update-profile", { result: "DENY", errorCode: ERROR.SESSION_REVOKED });
      return domain.fail(ERROR.SESSION_REVOKED);
    }
    const res = this.store.validateSession(ref, { sensitive: false });
    if (!res.ok) {
      this.store.audit("update-profile", { sessionRef: ref, result: "DENY", errorCode: res.error });
      return { ...res, type: "identity/update-profile" };
    }
    const { user, session } = res;

    let nextDisplayName;
    if (displayName !== undefined && displayName !== null) {
      const check = domain.validateDisplayName(displayName);
      if (!check.ok) {
        this.store.audit("update-profile", { userId: user.id, sessionRef: session.ref, result: "DENY", errorCode: check.error });
        return { ...check, type: "identity/update-profile" };
      }
      nextDisplayName = check.displayName;
    }
    let nextAvatarRef;
    if (avatarRef !== undefined) {
      const check = domain.validateAvatarRef(avatarRef);
      if (!check.ok) {
        this.store.audit("update-profile", { userId: user.id, sessionRef: session.ref, result: "DENY", errorCode: check.error });
        return { ...check, type: "identity/update-profile" };
      }
      nextAvatarRef = check.avatarRef;
    }

    const updated = this.store.updateProfile({ userId: user.id, displayName: nextDisplayName, avatarRef: nextAvatarRef });
    if (!updated.ok) return { ...updated, type: "identity/update-profile" };

    // 重新从 store 读，保证下发的快照是落库后的值，而不是内存里的旧行。
    const freshUser = this.store.userById(user.id);
    const snapshot = domain.identitySnapshot({
      user: freshUser,
      session: this.store.sessionByRef(session.ref),
      initialized: true,
    });
    this.#emit(EVENT.PROFILE_UPDATED, { userId: freshUser.id, snapshot });
    return domain.ok({ type: "identity/update-profile", snapshot });
  }

  #validate({ sessionRef, sensitive = true }) {
    const ref = sessionRef || this.current;
    if (!ref) return domain.fail(ERROR.SESSION_REVOKED);
    const res = this.store.validateSession(ref, { sensitive });
    if (!res.ok) return { ...res, type: "identity/validate" };
    return domain.ok({
      type: "identity/validate",
      valid: true,
      locked: res.locked,
      userId: res.user.id,
    });
  }

  async #setUserStatus({ userId }, status) {
    const res = this.store.setUserStatus(userId, status);
    if (!res.ok) return { ...res, type: "identity/setUserStatus" };
    // 禁用后本机 token 必须一起失效，否则"重启绕过禁用"
    if (status === domain.USER_STATUS.DISABLED) {
      await this.secrets?.clear();
      if (this.current) {
        const cur = this.store.sessionByRef(this.current);
        if (cur && cur.user_id === userId) this.current = null;
      }
      this.#emit(EVENT.LOGGED_OUT, { reason: "user-disabled" });
    }
    return domain.ok({
      type: "identity/setUserStatus",
      userId: res.user.id,
      status: res.user.status,
    });
  }

  async #reset({ confirm }) {
    await this.secrets?.clear();
    this.current = null;
    const res = this.store.resetInstallation({ confirm });
    if (!res.ok) return { ...res, type: "identity/reset-installation" };
    this.#emit(EVENT.LOGGED_OUT, { reason: "reset" });
    return domain.ok({ type: "identity/reset-installation", status: res.status });
  }
}

module.exports = { IdentityService, sanitizeSession };
