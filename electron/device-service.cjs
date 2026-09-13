"use strict";

/**
 * D3-03 · Device Service —— **Device 授权与配对唯一权威**。
 *
 * 它只补 D3-02 授权链缺的那一节（§8）：
 *   Session Valid → User Authorized → App Authorized → Resource Authorized
 *   → **Device Authorized** → Action Authorized
 *
 * 三条冻结语义，代码里各有唯一落点：
 *   ① §24 两层判定：TLS 证书有效 `authenticateConnection` 只决定"连接是谁"，
 *      是否允许执行由 `authorizeDevice` 按 Registry 状态决定。**两层都必须过**。
 *   ② §17/§18 单次消费：`consumePairing` 全程在一个事务里，token 的消费用
 *      `WHERE status='ISSUED'` 的 changes 判定 —— 并发两个请求只有一个拿到 1。
 *   ③ §26 撤销立即生效：Revoke/Disable 既**关闭**已建立连接，又让**下一条受保护消息**失败。
 */

const domain = require("./device-domain.cjs");
const {
  DEVICE_STATUS,
  CONNECTIVITY,
  CREDENTIAL_STATUS,
  PAIRING_STATUS,
  DEVICE_ACTION,
  SUPER_ADMIN_ONLY_ACTIONS,
  ACCESS_PRINCIPAL,
  DECISION,
  REASON,
  AUDIT_EVENT,
} = domain;

const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_PAIRING_TTL_MS = 60 * 60 * 1000;

/** 管理动作 → 是否需要 SUPER_ADMIN。§14：Department Admin 默认**不得** revoke / 跨组织转移。 */
const ACTION_AUTHORITY = Object.freeze({
  [DEVICE_ACTION.PAIR]: "SUPER_ADMIN",
  [DEVICE_ACTION.MANAGE]: "SUPER_ADMIN",
  [DEVICE_ACTION.DISABLE]: "SUPER_ADMIN",
  [DEVICE_ACTION.REVOKE]: "SUPER_ADMIN",
  [DEVICE_ACTION.VIEW]: "SCOPE",
  [DEVICE_ACTION.USE]: "SCOPE",
});

class DeviceService {
  /**
   * @param opts.identity     已 open 的 IdentityStore（session 闸门 + 用户真值）
   * @param opts.deviceStore  DeviceStore（与 identity 共享同一连接/事务队列）
   * @param opts.authService  可选：D3-02 AuthorizationService（解析会话与部门）
   * @param opts.clock        注入时钟（§37：可测试时钟，不靠 wall clock）
   * @param opts.serviceIdentity 本轮 Control Service 的身份指纹（§60）；未配置则拒绝配对
   */
  constructor({ identity, deviceStore, authService = null, logger = null, clock = null, serviceIdentity = null, organizationId = null } = {}) {
    if (!identity) throw new Error("DeviceService 需要 IdentityStore");
    if (!deviceStore) throw new Error("DeviceService 需要 DeviceStore");
    this.identity = identity;
    this.store = deviceStore;
    this.authService = authService;
    this.logger = logger;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.serviceIdentity = serviceIdentity;
    this.organizationId = organizationId;
    /** deviceId → Set<connection>，用于 §26 "撤销后关闭长连接"。 */
    this.connections = new Map();
  }

  #now() {
    return this.clock();
  }

  #audit({ actorUserId = null, deviceId = null, organizationId = null, event, reasonCode = null, requestId = null, detail = {} }) {
    return this.store.appendAudit({ at: this.#now(), actorUserId, deviceId, organizationId, event, reasonCode, requestId, detail });
  }

  #deny(reason, extra = {}) {
    return { ok: false, error: reason, decision: DECISION.DENY, reason: domain.publicReason(reason), ...extra };
  }

  // ---------------------------------------------------------------------------
  // 会话 / 治理闸门
  // ---------------------------------------------------------------------------

  /**
   * 复用 D3-01 的会话真值，**不**在设备层另造一套身份来源（§30/§35）。
   * userId / organizationId / role 一律由 sessionRef 反查，渲染进程说了不算。
   * 部门归属从 D3-02 的 membership 读，同样不接受调用方自报。
   */
  #sessionGate(context = {}) {
    const sessionRef = context?.sessionRef ? String(context.sessionRef) : null;
    if (!sessionRef) return { ok: false, error: "SESSION_REVOKED" };
    const res = this.identity.validateSession(sessionRef, { sensitive: true });
    if (!res.ok) return { ok: false, error: res.error };
    const user = res.user;
    const claimed = context?.userId ? String(context.userId) : null;
    if (claimed && claimed !== user.id) return { ok: false, error: "SESSION_USER_MISMATCH" };
    let departmentIds = [];
    try {
      const memberships = this.authService?.store?.membershipsOfUser?.(user.id) || [];
      departmentIds = memberships.filter((m) => m.status === "ACTIVE").map((m) => m.department_id);
    } catch {
      departmentIds = [];
    }
    return { ok: true, actor: { userId: user.id, role: user.role, organizationId: user.team_id, departmentIds, session: res.session } };
  }

  #requireSuperAdmin(actor, action) {
    if (!action) return { ok: true };
    const need = ACTION_AUTHORITY[action];
    if (need === "SUPER_ADMIN" && actor.role !== "ADMIN") {
      return { ok: false, error: REASON.NOT_SUPER_ADMIN };
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Pairing（§15 §16 §17 §18 §19 §56 §57）
  // ---------------------------------------------------------------------------

  /**
   * 生成**短时、单次、随机、可审计、绑组织**的 Pairing Credential。
   * 返回的 secret 是**唯一一次**明文出现的位置：库里只存 sha256（§47）。
   */
  createPairing({ context, ttlMs = DEFAULT_PAIRING_TTL_MS, departmentId = null, requestId = null } = {}) {
    const gate = this.#sessionGate(context);
    if (!gate.ok) return gate;
    const authority = this.#requireSuperAdmin(gate.actor, DEVICE_ACTION.PAIR);
    if (!authority.ok) {
      this.#audit({ actorUserId: gate.actor.userId, event: AUDIT_EVENT.PAIRING_REJECTED, reasonCode: authority.error, requestId });
      return this.#deny(authority.error);
    }
    const ttl = Math.max(1000, Math.min(Number(ttlMs) || DEFAULT_PAIRING_TTL_MS, MAX_PAIRING_TTL_MS));
    const now = this.#now();
    const secret = domain.newPairingSecret();
    const organizationId = context.organizationId || this.organizationId || gate.actor.organizationId || "org_default000000000000";
    const pairing = this.store.transactSync(() => {
      const row = this.store.insertPairing({
        organizationId,
        secretHash: domain.pairingSecretHash(secret),
        issuedBy: gate.actor.userId,
        issuedAt: now,
        expiresAt: now + ttl,
        departmentId,
      });
      this.#audit({
        actorUserId: gate.actor.userId,
        organizationId,
        event: AUDIT_EVENT.PAIRING_CREATED,
        requestId,
        detail: { pairingId: row.id, expiresAt: row.expires_at, departmentId },
      });
      return row;
    });
    return {
      ok: true,
      pairing: { id: pairing.id, organizationId, expiresAt: pairing.expires_at, status: pairing.status, departmentId },
      /** 明文只在这里出现一次；调用方负责展示/编码（QR），不得落库。 */
      secret,
      serviceIdentity: this.serviceIdentity,
    };
  }

  /**
   * New Device Pairing：**原子**完成"验身份 → 消费 token → 注册设备 → 发凭据 → 激活"。
   * 任何一步抛错，事务整体回滚 —— 不会出现"token 已消费但设备没建"（§57）。
   */
  consumePairing({ secret, deviceIdentity = {}, serviceIdentitySeen = null, requestId = null, at = null } = {}) {
    const now = at == null ? this.#now() : at;
    if (!secret || typeof secret !== "string") return this.#deny(REASON.INVALID_INPUT);

    // §60/§61：配对前必须能确认"这是我要加入的 Control Service"，不做 TOFU 静默信任。
    if (this.serviceIdentity) {
      if (!serviceIdentitySeen || serviceIdentitySeen !== this.serviceIdentity) {
        this.#audit({ event: AUDIT_EVENT.PAIRING_REJECTED, reasonCode: REASON.SERVICE_IDENTITY_MISMATCH, requestId });
        return this.#deny(REASON.SERVICE_IDENTITY_MISMATCH);
      }
    }

    const secretHash = domain.pairingSecretHash(secret);
    let denied = null;
    let result = null;
    try {
      result = this.store.transactSync(() => {
      const pairing = this.store.pairingBySecretHash(secretHash);
      if (!pairing) {
        denied = REASON.PAIRING_TOKEN_UNKNOWN;
        return null;
      }
      if (pairing.status === PAIRING_STATUS.CONSUMED) {
        denied = REASON.PAIRING_TOKEN_ALREADY_USED;
        return null;
      }
      if (pairing.status === PAIRING_STATUS.REVOKED) {
        denied = REASON.PAIRING_TOKEN_REVOKED;
        return null;
      }
      if (pairing.status === PAIRING_STATUS.EXPIRED || domain.isExpired(pairing.expires_at, now)) {
        // §19 边界：now >= expiresAt 即失效，与 D3-01 session 口径一致。
        this.store.expirePairing(pairing.id);
        denied = REASON.PAIRING_TOKEN_EXPIRED;
        return null;
      }
      if (deviceIdentity.organizationId && deviceIdentity.organizationId !== pairing.organization_id) {
        denied = REASON.PAIRING_TOKEN_ORGANIZATION_MISMATCH;
        return null;
      }

      const device = this.store.insertDevice({
        organizationId: pairing.organization_id,
        displayName: deviceIdentity.displayName || "新设备",
        platform: deviceIdentity.platform || "unknown",
        architecture: deviceIdentity.architecture || "unknown",
        status: DEVICE_STATUS.PENDING,
        registeredBy: pairing.issued_by,
        departmentId: pairing.department_id,
        at: now,
      });

      const consumed = this.store.consumePairing(pairing.id, { deviceId: device.id, at: now });
      if (!consumed.consumed) {
        // 并发里输掉的那一个：整体回滚，绝不留下第二台设备（§17）。
        denied = REASON.PAIRING_TOKEN_ALREADY_USED;
        throw Object.assign(new Error("PAIRING_RACE_LOST"), { raceLost: true });
      }

      const credentialVersion = 1;
      const credential = this.store.insertCredential({
        deviceId: device.id,
        organizationId: pairing.organization_id,
        credentialVersion,
        subject: deviceIdentity.subject || device.id,
        fingerprint: deviceIdentity.fingerprint || "",
        notBefore: deviceIdentity.notBefore == null ? now : deviceIdentity.notBefore,
        notAfter: deviceIdentity.notAfter == null ? now + 90 * 24 * 3600 * 1000 : deviceIdentity.notAfter,
        issuedAt: now,
      });
      this.store.setDeviceCertificate(device.id, {
        certificateIdentity: deviceIdentity.fingerprint || deviceIdentity.subject || device.id,
        credentialVersion,
        agentVersion: deviceIdentity.agentVersion || null,
        metadataVersion: 1,
        at: now,
      });
      this.store.setDeviceStatus(device.id, DEVICE_STATUS.ACTIVE, { expect: DEVICE_STATUS.PENDING, at: now });
      this.store.markRegistered(device.id, { at: now });

      this.#audit({
        actorUserId: pairing.issued_by,
        deviceId: device.id,
        organizationId: pairing.organization_id,
        event: AUDIT_EVENT.PAIRING_USED,
        requestId,
        detail: { pairingId: pairing.id, credentialVersion },
      });
      this.#audit({
        actorUserId: pairing.issued_by,
        deviceId: device.id,
        organizationId: pairing.organization_id,
        event: AUDIT_EVENT.DEVICE_REGISTERED,
        requestId,
        detail: { platform: device.platform, architecture: device.architecture, credentialVersion },
      });
      return { device: this.store.deviceById(device.id), credential };
      });
    } catch (e) {
      // 并发里输掉的一方：事务已回滚，按"token 已被使用"对外回报（§17）。
      if (!(e && e.raceLost)) throw e;
      result = null;
    }

    if (!result) {
      const reason = denied || REASON.PAIRING_TOKEN_UNKNOWN;
      this.#audit({ event: AUDIT_EVENT.PAIRING_REJECTED, reasonCode: reason, requestId });
      return this.#deny(reason);
    }
    return {
      ok: true,
      decision: DECISION.ALLOW,
      device: this.#publicDevice(result.device),
      credential: {
        id: result.credential.id,
        credentialVersion: result.credential.credential_version,
        fingerprint: result.credential.fingerprint,
        notAfter: result.credential.not_after,
      },
    };
  }

  revokePairing({ context, pairingId, requestId = null } = {}) {
    const gate = this.#sessionGate(context);
    if (!gate.ok) return gate;
    const authority = this.#requireSuperAdmin(gate.actor, DEVICE_ACTION.PAIR);
    if (!authority.ok) return this.#deny(authority.error);
    const ok = this.store.transactSync(() => {
      const changed = this.store.revokePairing(pairingId);
      if (changed) this.#audit({ actorUserId: gate.actor.userId, event: AUDIT_EVENT.PAIRING_REJECTED, reasonCode: REASON.PAIRING_TOKEN_REVOKED, requestId, detail: { pairingId } });
      return changed;
    });
    return ok ? { ok: true } : this.#deny(REASON.INVALID_INPUT);
  }

  listPairings({ context } = {}) {
    const gate = this.#sessionGate(context);
    if (!gate.ok) return gate;
    const organizationId = context.organizationId || this.organizationId || gate.actor.organizationId;
    const items = this.store.pairingsOfOrg(organizationId).map((p) => ({
      id: p.id,
      status: p.status,
      issuedAt: p.issued_at,
      expiresAt: p.expires_at,
      consumedAt: p.consumed_at,
      issuedBy: p.issued_by,
    }));
    return { ok: true, items };
  }

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------

  /** §48 Renderer 只能拿到这些字段 —— 私钥 / 凭据原文 / pairing secret 永远不在这里。 */
  #publicDevice(device) {
    if (!device) return null;
    return {
      deviceId: device.id,
      displayName: device.display_name,
      platform: device.platform,
      architecture: device.architecture,
      status: device.status,
      connectivity: device.connectivity,
      organizationId: device.organization_id,
      departmentId: device.department_id,
      credentialVersion: device.credential_version,
      agentVersion: device.agent_version,
      registeredAt: device.registered_at,
      lastSeenAt: device.last_seen_at,
      certificateIdentity: device.certificate_identity,
    };
  }

  listDevices({ context } = {}) {
    const gate = this.#sessionGate(context);
    if (!gate.ok) return gate;
    const organizationId = context.organizationId || this.organizationId || gate.actor.organizationId;
    const items = this.store.devicesOfOrg(organizationId).map((d) => this.#publicDevice(d));
    return { ok: true, items };
  }

  getDevice({ context, deviceId } = {}) {
    const gate = this.#sessionGate(context);
    if (!gate.ok) return gate;
    const device = this.store.deviceById(deviceId);
    const organizationId = context.organizationId || this.organizationId || gate.actor.organizationId;
    if (!device || device.organization_id !== organizationId) return this.#deny(REASON.DEVICE_NOT_FOUND);
    return { ok: true, device: this.#publicDevice(device) };
  }

  #management(op, { context, deviceId, requestId = null, event, nextStatus, auditDetail = {} } = {}) {
    const gate = this.#sessionGate(context);
    if (!gate.ok) return gate;
    const authority = this.#requireSuperAdmin(gate.actor, op);
    if (!authority.ok) {
      this.#audit({ actorUserId: gate.actor.userId, deviceId, event: AUDIT_EVENT.DEVICE_AUTH_DENIED, reasonCode: authority.error, requestId });
      return this.#deny(authority.error);
    }
    return this.store.transactSync(() => {
      const device = this.store.deviceById(deviceId);
      if (!device) return this.#deny(REASON.DEVICE_NOT_FOUND);
      // §27：撤销是终态 —— "再启用"不是"非法迁移"，而是明确的 DEVICE_REVOKED（需要重新 Pair）。
      if (device.status === DEVICE_STATUS.REVOKED && nextStatus === DEVICE_STATUS.ACTIVE) {
        return this.#deny(REASON.DEVICE_REVOKED);
      }
      const transition = domain.assertTransition(device.status, nextStatus);
      if (!transition.ok) return this.#deny(transition.reason);
      const applied = this.store.setDeviceStatus(device.id, nextStatus, { expect: device.status, at: this.#now() });
      if (!applied.changed) return this.#deny(REASON.INVALID_STATUS_TRANSITION);
      if (nextStatus === DEVICE_STATUS.ACTIVE) this.store.markRegistered(device.id, { at: this.#now() });
      if (nextStatus === DEVICE_STATUS.REVOKED || nextStatus === DEVICE_STATUS.DISABLED) {
        // §25 §26 §27：撤销/禁用立即切断凭据与长连接，且不等证书过期。
        this.store.revokeAllCredentials(device.id, { at: this.#now() });
        this.closeConnections(device.id, nextStatus === DEVICE_STATUS.REVOKED ? "DEVICE_REVOKED" : "DEVICE_DISABLED");
        this.store.setConnectivity(device.id, CONNECTIVITY.OFFLINE, { at: this.#now() });
      }
      this.#audit({
        actorUserId: gate.actor.userId,
        deviceId: device.id,
        organizationId: device.organization_id,
        event,
        requestId,
        detail: { from: device.status, to: nextStatus, ...auditDetail },
      });
      return { ok: true, device: this.#publicDevice(this.store.deviceById(device.id)) };
    });
  }

  disableDevice({ context, deviceId, requestId = null, reason = null } = {}) {
    return this.#management(DEVICE_ACTION.DISABLE, { context, deviceId, requestId, event: AUDIT_EVENT.DEVICE_DISABLED, nextStatus: DEVICE_STATUS.DISABLED, auditDetail: { reason } });
  }

  enableDevice({ context, deviceId, requestId = null } = {}) {
    return this.#management(DEVICE_ACTION.DISABLE, { context, deviceId, requestId, event: AUDIT_EVENT.DEVICE_ENABLED, nextStatus: DEVICE_STATUS.ACTIVE });
  }

  revokeDevice({ context, deviceId, requestId = null, reason = null } = {}) {
    return this.#management(DEVICE_ACTION.REVOKE, { context, deviceId, requestId, event: AUDIT_EVENT.DEVICE_REVOKED, nextStatus: DEVICE_STATUS.REVOKED, auditDetail: { reason } });
  }

  /** §44 rename 只动 displayName；deviceId / 权限 / 证书身份全部不变。 */
  renameDevice({ context, deviceId, displayName, requestId = null } = {}) {
    const gate = this.#sessionGate(context);
    if (!gate.ok) return gate;
    const authority = this.#requireSuperAdmin(gate.actor, DEVICE_ACTION.MANAGE);
    if (!authority.ok) return this.#deny(authority.error);
    if (!displayName || typeof displayName !== "string") return this.#deny(REASON.INVALID_INPUT);
    const device = this.store.deviceById(deviceId);
    if (!device) return this.#deny(REASON.DEVICE_NOT_FOUND);
    return this.store.transactSync(() => {
      this.store.renameDevice(device.id, displayName, { at: this.#now() });
      this.#audit({ actorUserId: gate.actor.userId, deviceId: device.id, organizationId: device.organization_id, event: AUDIT_EVENT.DEVICE_RENAMED, requestId, detail: { displayName } });
      return { ok: true, device: this.#publicDevice(this.store.deviceById(device.id)) };
    });
  }

  grantDeviceAccess({ context, deviceId, principalType, principalId = "", actions = [], expiresAt = null, requestId = null } = {}) {
    const gate = this.#sessionGate(context);
    if (!gate.ok) return gate;
    const authority = this.#requireSuperAdmin(gate.actor, DEVICE_ACTION.MANAGE);
    if (!authority.ok) return this.#deny(authority.error);
    if (!Object.values(ACCESS_PRINCIPAL).includes(principalType)) return this.#deny(REASON.INVALID_INPUT);
    const device = this.store.deviceById(deviceId);
    if (!device) return this.#deny(REASON.DEVICE_NOT_FOUND);
    const clean = actions.filter((a) => [DEVICE_ACTION.VIEW, DEVICE_ACTION.USE].includes(a));
    if (!clean.length) return this.#deny(REASON.INVALID_INPUT);
    return this.store.transactSync(() => {
      const row = this.store.upsertDeviceAccess({ deviceId: device.id, organizationId: device.organization_id, principalType, principalId, actions: clean, grantedBy: gate.actor.userId, expiresAt });
      this.#audit({ actorUserId: gate.actor.userId, deviceId: device.id, organizationId: device.organization_id, event: "DEVICE_ACCESS_GRANTED", requestId, detail: { principalType, principalId, actions: clean } });
      return { ok: true, access: { id: row.id, principalType, principalId, actions: clean } };
    });
  }

  // ---------------------------------------------------------------------------
  // 凭据轮换（§28 §29 §64）
  // ---------------------------------------------------------------------------

  /**
   * 轮换：旧凭据转 ROTATED（立即失效），新版本置 ACTIVE 并写回 devices.credential_version。
   * 版本号必须**严格递增** —— 否则旧凭据可能因为 version 相同而继续被接受（§29）。
   */
  rotateDeviceCredential({ context, deviceId, newIdentity = {}, requestId = null } = {}) {
    const gate = this.#sessionGate(context);
    if (!gate.ok) return gate;
    const authority = this.#requireSuperAdmin(gate.actor, DEVICE_ACTION.MANAGE);
    if (!authority.ok) return this.#deny(authority.error);
    const now = this.#now();
    return this.store.transactSync(() => {
      const device = this.store.deviceById(deviceId);
      if (!device) return this.#deny(REASON.DEVICE_NOT_FOUND);
      if (device.status === DEVICE_STATUS.REVOKED) return this.#deny(REASON.DEVICE_REVOKED);
      const current = this.store.activeCredentialOfDevice(device.id);
      const nextVersion = Number(device.credential_version || (current ? current.credential_version : 0)) + 1;
      if (current && nextVersion <= current.credential_version) return this.#deny(REASON.ROTATION_VERSION_NOT_MONOTONIC);
      if (current) this.store.rotateCredential(current.id, { at: now });
      const credential = this.store.insertCredential({
        deviceId: device.id,
        organizationId: device.organization_id,
        credentialVersion: nextVersion,
        subject: newIdentity.subject || device.id,
        fingerprint: newIdentity.fingerprint || "",
        notBefore: newIdentity.notBefore == null ? now : newIdentity.notBefore,
        notAfter: newIdentity.notAfter == null ? now + 90 * 24 * 3600 * 1000 : newIdentity.notAfter,
        issuedAt: now,
      });
      this.store.setDeviceCertificate(device.id, {
        certificateIdentity: newIdentity.fingerprint || newIdentity.subject || device.id,
        credentialVersion: nextVersion,
        agentVersion: device.agent_version,
        metadataVersion: (device.metadata_version || 1) + 1,
        at: now,
      });
      this.closeConnections(device.id, "CERT_ROTATED");
      this.#audit({
        actorUserId: gate.actor.userId,
        deviceId: device.id,
        organizationId: device.organization_id,
        event: AUDIT_EVENT.CERT_ROTATED,
        requestId,
        detail: { fromVersion: current ? current.credential_version : 0, toVersion: nextVersion },
      });
      return { ok: true, credentialVersion: nextVersion, credentialId: credential.id };
    });
  }

  // ---------------------------------------------------------------------------
  // 运行期：连接身份 / 心跳 / Device Gate（§24 §33 §34 §35 §26）
  // ---------------------------------------------------------------------------

  /**
   * 第一层：TLS 握手后"这个连接是谁"。
   * 只看指纹与凭据可用性；**不做**授权结论（那是 authorizeDevice 的事）。
   */
  authenticateConnection({ fingerprint, requestId = null, at = null } = {}) {
    const now = at == null ? this.#now() : at;
    if (!fingerprint) {
      this.#audit({ event: AUDIT_EVENT.TLS_AUTH_FAILED, reasonCode: REASON.DEVICE_CREDENTIAL_UNKNOWN, requestId });
      return this.#deny(REASON.DEVICE_CREDENTIAL_UNKNOWN);
    }
    const credential = this.store.credentialByFingerprint(fingerprint);
    if (!credential) {
      this.#audit({ event: AUDIT_EVENT.TLS_AUTH_FAILED, reasonCode: REASON.DEVICE_CREDENTIAL_UNKNOWN, requestId });
      return this.#deny(REASON.DEVICE_CREDENTIAL_UNKNOWN);
    }
    const device = this.store.deviceById(credential.device_id);
    const usable = domain.credentialUsable(credential, { now, deviceCredentialVersion: device ? device.credential_version : null });
    if (!usable.ok) {
      this.#audit({ deviceId: credential.device_id, event: AUDIT_EVENT.TLS_AUTH_FAILED, reasonCode: usable.reason, requestId });
      return this.#deny(usable.reason);
    }
    return { ok: true, decision: DECISION.ALLOW, device, deviceId: device.id, credential };
  }

  /** 记录已建立的设备长连接，供撤销/轮换时主动关闭（§26）。 */
  registerConnection({ deviceId, close = () => {}, meta = {} } = {}) {
    const set = this.connections.get(deviceId) || new Set();
    const conn = { deviceId, close, meta, closed: false };
    set.add(conn);
    this.connections.set(deviceId, set);
    return conn;
  }

  unregisterConnection(conn) {
    if (!conn) return;
    const set = this.connections.get(conn.deviceId);
    if (set) {
      set.delete(conn);
      if (!set.size) this.connections.delete(conn.deviceId);
    }
  }

  /** 主动关闭某设备的所有长连接。返回关闭条数，供探针断言。 */
  closeConnections(deviceId, reason = "DEVICE_STATE_CHANGED") {
    const set = this.connections.get(deviceId);
    if (!set) return 0;
    let closed = 0;
    for (const conn of [...set]) {
      try {
        conn.close(reason);
      } catch {
        /* 关闭失败不影响状态已变更这一事实：下一条受保护消息仍会被拒 */
      }
      conn.closed = true;
      set.delete(conn);
      closed++;
    }
    if (!set.size) this.connections.delete(deviceId);
    return closed;
  }

  /**
   * §33/§34：心跳只接受**与当前 TLS 设备身份一致**的 deviceId。
   * Device A 的凭据宣称 deviceId = B → 直接 DENY。
   */
  heartbeat({ connection, payload = {}, requestId = null, at = null } = {}) {
    const now = at == null ? this.#now() : at;
    if (!connection || !connection.credential) return this.#deny(REASON.DEVICE_CREDENTIAL_UNKNOWN);
    const tlsDeviceId = connection.device.id;
    /**
     * **每次心跳都重读 Registry**（§26 §35）。
     * 连接对象里那份 device/credential 是握手那一刻的快照；撤销/禁用/轮换发生在之后，
     * 若在这里用快照判定，被撤销的连接就能靠"继续心跳"无限续命 —— 这正是规格禁止的。
     */
    const freshDevice = this.store.deviceById(tlsDeviceId);
    const storedCredential = this.store.credentialByFingerprint(connection.credential.fingerprint);
    if (!freshDevice || !storedCredential || storedCredential.device_id !== tlsDeviceId) {
      this.#audit({ deviceId: tlsDeviceId, event: AUDIT_EVENT.DEVICE_AUTH_DENIED, reasonCode: REASON.DEVICE_CREDENTIAL_MISMATCH, requestId });
      return this.#deny(REASON.DEVICE_CREDENTIAL_MISMATCH);
    }
    const identityCheck = domain.assertHeartbeatIdentity({
      tlsDeviceId,
      claimedDeviceId: payload.deviceId,
      tlsCredentialFingerprint: connection.credential.fingerprint,
      credential: storedCredential,
    });
    if (!identityCheck.ok) {
      this.#audit({ deviceId: tlsDeviceId, event: AUDIT_EVENT.DEVICE_AUTH_DENIED, reasonCode: identityCheck.reason, requestId, detail: { claimedDeviceId: payload.deviceId || null } });
      return this.#deny(identityCheck.reason);
    }
    // §35 heartbeat 不能把 REVOKED/DISABLED 拉回授权：状态判定照旧走 authorizeDevice。
    const gate = this.authorizeDevice({ device: freshDevice, action: DEVICE_ACTION.USE, actor: { userId: freshDevice.registered_by || null, role: "ADMIN", organizationId: freshDevice.organization_id }, at: now, credential: storedCredential });
    if (!gate.ok) {
      this.#audit({ deviceId: tlsDeviceId, event: AUDIT_EVENT.DEVICE_AUTH_DENIED, reasonCode: gate.error, requestId });
      return this.#deny(gate.error);
    }
    this.store.touchDevice(tlsDeviceId, { at: now, connectivity: CONNECTIVITY.ONLINE, agentVersion: payload.agentVersion || null });
    this.#audit({ deviceId: tlsDeviceId, organizationId: freshDevice.organization_id, event: AUDIT_EVENT.DEVICE_SEEN, requestId, detail: { agentVersion: payload.agentVersion || null } });
    return { ok: true, decision: DECISION.ALLOW, deviceId: tlsDeviceId, at: now };
  }

  /** §36：超过阈值只是 OFFLINE，不自动 REVOKE。 */
  markOffline(deviceId, { at = null, thresholdMs = domain.DEFAULT_OFFLINE_AFTER_MS } = {}) {
    const now = at == null ? this.#now() : at;
    const device = this.store.deviceById(deviceId);
    if (!device) return { ok: false, error: REASON.DEVICE_NOT_FOUND };
    if (device.connectivity === CONNECTIVITY.OFFLINE) return { ok: true, changed: false, status: device.status };
    if (device.last_seen_at != null && now - device.last_seen_at < thresholdMs) return { ok: true, changed: false, status: device.status };
    this.store.setConnectivity(deviceId, CONNECTIVITY.OFFLINE, { at: now });
    this.#audit({ deviceId, organizationId: device.organization_id, event: AUDIT_EVENT.DEVICE_OFFLINE, detail: { lastSeenAt: device.last_seen_at } });
    return { ok: true, changed: true, status: device.status, connectivity: CONNECTIVITY.OFFLINE };
  }

  /**
   * §8 的 Device Gate：在 D3-02 授权链之后再加的一层。
   * 判定顺序刻意固定为"组织 → 状态 → 访问授权"，每条都对应**不同的恢复路径**。
   */
  authorizeDevice({ device = null, action = DEVICE_ACTION.USE, actor = null, at = null, credential = null } = {}) {
    const now = at == null ? this.#now() : at;
    if (!action || !domain.DEVICE_ACTIONS.includes(action)) return { ok: false, error: REASON.INVALID_INPUT, decision: DECISION.DENY };
    const state = domain.deviceAuthorizable(device);
    if (!state.ok) return { ok: false, error: state.reason, decision: DECISION.DENY, reason: domain.publicReason(state.reason) };

    if (actor && actor.organizationId && device.organization_id !== actor.organizationId) {
      return { ok: false, error: REASON.CROSS_ORGANIZATION_DEVICE, decision: DECISION.DENY, reason: domain.publicReason(REASON.CROSS_ORGANIZATION_DEVICE) };
    }

    if (credential) {
      const usable = domain.credentialUsable(credential, { now, deviceCredentialVersion: device.credential_version });
      if (!usable.ok) return { ok: false, error: usable.reason, decision: DECISION.DENY };
    }

    if (actor && actor.role === "ADMIN") return { ok: true, decision: DECISION.ALLOW, source: "SUPER_ADMIN" };

    const granted = this.#accessAllows({ device, actor, action, now });
    if (!granted.ok) return { ok: false, error: granted.reason, decision: DECISION.DENY, reason: domain.publicReason(granted.reason) };
    return { ok: true, decision: DECISION.ALLOW, source: granted.source };
  }

  #accessAllows({ device, actor, action, now }) {
    if (!actor || !actor.userId) return { ok: false, reason: REASON.DEVICE_ACTION_NOT_GRANTED };
    const rows = this.store.accessOfDevice(device.id);
    const active = rows.filter((r) => r.expires_at == null || now < r.expires_at);
    const hasAction = (r) => Array.isArray(r.actions) && r.actions.includes(action);
    const user = active.find((r) => r.principal_type === ACCESS_PRINCIPAL.USER && r.principal_id === actor.userId && hasAction(r));
    if (user) return { ok: true, source: "USER_GRANT" };
    const deptIds = Array.isArray(actor.departmentIds) ? actor.departmentIds : [];
    const dept = active.find(
      (r) => r.principal_type === ACCESS_PRINCIPAL.DEPARTMENT && (r.principal_id === device.department_id || deptIds.includes(r.principal_id)) && hasAction(r),
    );
    if (dept) return { ok: true, source: "DEPARTMENT_GRANT" };
    const org = active.find((r) => r.principal_type === ACCESS_PRINCIPAL.ORGANIZATION && hasAction(r));
    if (org) return { ok: true, source: "ORGANIZATION_GRANT" };
    return { ok: false, reason: REASON.DEVICE_ACTION_NOT_GRANTED };
  }

  /** 便捷入口：按 deviceId 判定（供 UI / 探针 / 后续 D4 Tool Gate 复用）。 */
  authorizeDeviceById({ context, deviceId, action = DEVICE_ACTION.USE, credential = null } = {}) {
    const gate = this.#sessionGate(context);
    if (!gate.ok) return gate;
    const device = this.store.deviceById(deviceId);
    if (!device) return this.#deny(REASON.DEVICE_NOT_FOUND);
    const actor = { userId: gate.actor.userId, role: gate.actor.role, organizationId: context.organizationId || this.organizationId || gate.actor.organizationId, departmentIds: gate.actor.departmentIds };
    const verdict = this.authorizeDevice({ device, action, actor, credential });
    if (!verdict.ok) {
      this.#audit({ actorUserId: actor.userId, deviceId, organizationId: device.organization_id, event: AUDIT_EVENT.DEVICE_AUTH_DENIED, reasonCode: verdict.error, detail: { action } });
      return { ...verdict, device: this.#publicDevice(device) };
    }
    this.#audit({ actorUserId: actor.userId, deviceId, organizationId: device.organization_id, event: AUDIT_EVENT.DEVICE_AUTH_ALLOWED, detail: { action, source: verdict.source } });
    return { ...verdict, device: this.#publicDevice(device) };
  }

  // ---------------------------------------------------------------------------
  // 组合入口：资源 × 设备的**交集**（§8 §40 §72 §73）
  // ---------------------------------------------------------------------------

  /**
   * 最终执行授权链里属于 D3-03 的那一段：
   *   Session → Resource（复用 D3-02 authorize） → **Device** → Action
   *
   * 刻意只做**组合**，不重写 D3-02 的 ACL：
   * 用户有资源权限 ≠ 可以要求任意设备读取；能用某台设备 ≠ 能读任意资源。
   * 两者是**交集**，任一侧不过就 DENY，并明确告诉调用方是哪一侧拒的。
   */
  authorizeExecution({ context = {}, resourceRef = null, resourceAction = "resource.read", deviceId, action = DEVICE_ACTION.USE, agent = null, at = null } = {}) {
    const gate = this.#sessionGate(context);
    if (!gate.ok) {
      return { ok: false, decision: DECISION.DENY, side: "SESSION", error: gate.error, reason: gate.error };
    }
    const actor = {
      userId: gate.actor.userId,
      role: gate.actor.role,
      organizationId: context.organizationId || this.organizationId || gate.actor.organizationId,
      departmentIds: gate.actor.departmentIds,
    };
    const device = this.store.deviceById(deviceId);
    if (!device) {
      return { ok: false, decision: DECISION.DENY, side: "DEVICE", error: REASON.DEVICE_NOT_FOUND, reason: domain.publicReason(REASON.DEVICE_NOT_FOUND) };
    }

    // ① 资源侧：交给 D3-02 唯一权威，不在这里判 role / 拼 ACL。
    let resourceVerdict = null;
    if (resourceRef && this.authService) {
      const authorized = this.authService.authorize({ context: { ...context, agent: agent || context.agent }, action: resourceAction, resource: resourceRef });
      resourceVerdict = { decision: authorized.decision, reasonCode: authorized.reasonCode || null, allowSources: authorized.allowSources || [] };
      if (authorized.decision !== "ALLOW") {
        this.#audit({ actorUserId: actor.userId, deviceId, organizationId: device.organization_id, event: AUDIT_EVENT.DEVICE_AUTH_DENIED, reasonCode: REASON.RESOURCE_NOT_AUTHORIZED, detail: { action, resourceRef: String(resourceRef), resourceReason: authorized.reasonCode || null } });
        return { ok: false, decision: DECISION.DENY, side: "RESOURCE", error: REASON.RESOURCE_NOT_AUTHORIZED, reason: REASON.RESOURCE_NOT_AUTHORIZED, resourceReasonCode: authorized.reasonCode || null, resource: resourceVerdict, device: this.#publicDevice(device) };
      }
    }

    // ② 设备侧：D3-03 的 Device Gate（组织 → 状态 → 访问授权 → 动作）。
    const deviceVerdict = this.authorizeDevice({ device, action, actor, at });
    if (!deviceVerdict.ok) {
      this.#audit({ actorUserId: actor.userId, deviceId, organizationId: device.organization_id, event: AUDIT_EVENT.DEVICE_AUTH_DENIED, reasonCode: deviceVerdict.error, detail: { action, resourceRef: resourceRef ? String(resourceRef) : null, agent: agent || null } });
      return { ok: false, decision: DECISION.DENY, side: "DEVICE", error: deviceVerdict.error, reason: deviceVerdict.reason || domain.publicReason(deviceVerdict.error), resource: resourceVerdict, device: this.#publicDevice(device) };
    }

    this.#audit({ actorUserId: actor.userId, deviceId, organizationId: device.organization_id, event: AUDIT_EVENT.DEVICE_AUTH_ALLOWED, detail: { action, source: deviceVerdict.source, resourceRef: resourceRef ? String(resourceRef) : null, agent: agent || null } });
    return { ok: true, decision: DECISION.ALLOW, side: "BOTH", source: deviceVerdict.source, resource: resourceVerdict, device: this.#publicDevice(device) };
  }

  // ---------------------------------------------------------------------------
  // Audit（§46）
  // ---------------------------------------------------------------------------

  deviceAudit({ context, deviceId = null } = {}) {
    const gate = this.#sessionGate(context);
    if (!gate.ok) return gate;
    const authority = this.#requireSuperAdmin(gate.actor, DEVICE_ACTION.MANAGE);
    if (!authority.ok) return this.#deny(authority.error);
    const items = deviceId ? this.store.auditOfDevice(deviceId) : this.store.allAudit();
    return { ok: true, items };
  }

  // ---------------------------------------------------------------------------
  // Resource Location Contract（§38 §39）—— D3-03 只定义，不实现 Resource Store
  // ---------------------------------------------------------------------------

  /**
   * 把"资源在哪里"与"这台设备现在可不可用"放在同一个契约里交给 D3-04。
   * 这里**不读也不写资源表**：只按 deviceId 给出 availability。
   */
  resolveResourceLocation({ context, deviceId, at = null } = {}) {
    const gate = this.#sessionGate(context);
    if (!gate.ok) return gate;
    const now = at == null ? this.#now() : at;
    const device = this.store.deviceById(deviceId);
    if (!device) return this.#deny(REASON.DEVICE_NOT_FOUND);
    const state = domain.deviceAuthorizable(device);
    return {
      ok: true,
      location: {
        deviceId: device.id,
        availability: state.ok ? (device.connectivity === CONNECTIVITY.ONLINE ? "ONLINE" : device.connectivity) : device.status,
        status: device.status,
        connectivity: device.connectivity,
        checkedAt: now,
      },
    };
  }
}

module.exports = { DeviceService, ACTION_AUTHORITY, DEFAULT_PAIRING_TTL_MS, MAX_PAIRING_TTL_MS };
