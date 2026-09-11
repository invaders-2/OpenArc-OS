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

const { ERROR, EVENT } = domain;

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
  constructor({ store, secrets, logger, allowAdmin = false } = {}) {
    if (!store) throw new Error("IdentityService 需要 store");
    this.store = store;
    this.secrets = secrets || null;
    this.logger = logger || null;
    this.allowAdmin = !!allowAdmin;
    this.listeners = new Set();
    /** 当前进程持有的会话引用。渲染进程每次启动都会重新向服务要一次。 */
    this.current = null;
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
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

  get snapshot() {
    if (!this.current) return domain.emptySnapshot({ initialized: this.store.status().initialized });
    const res = this.store.validateSession(this.current, { sensitive: false });
    if (!res.ok) {
      this.current = null;
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
    return result;
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

  async #initialize({ identifier, password, displayName }) {
    const res = await this.store.initialize({ identifier, password, displayName });
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
