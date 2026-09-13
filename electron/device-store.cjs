"use strict";

/**
 * D3-03 · Device Registry 持久化层。
 *
 * 与 D3-02 的 AuthorizationStore 同构：复用 IdentityStore 的**同一条连接与事务队列**，
 * 于是"消费 pairing token + 建 device + 建 credential + 写审计"可以在一个事务里原子完成（§57）。
 *
 * 三条写在这里的机器保证：
 *   ① consumePairing 用 `UPDATE ... WHERE id = ? AND status = 'ISSUED'` + changes 判定，
 *      两个并发请求里**恰好一个**能拿到 changes=1（§17 pairing race）。
 *   ② 审计写入前统一过 sanitizeAuditDetail，禁止字段（私钥 / pairing secret / token）物理上写不进去（§46 §47）。
 *   ③ 所有状态变更都带 WHERE status = <旧状态>，避免"读-改-写"窗口里被并发改状态（§25 §26）。
 */

const domain = require("./device-domain.cjs");
const { DEVICE_STATUS, CONNECTIVITY, CREDENTIAL_STATUS, PAIRING_STATUS } = domain;

const SQL = {
  insertDevice:
    "INSERT INTO devices (id, organization_id, display_name, platform, architecture, status, registered_at, registered_by, last_seen_at, certificate_identity, credential_version, agent_version, metadata_version, department_id, connectivity, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  deviceById: "SELECT * FROM devices WHERE id = ?",
  devicesOfOrg: "SELECT * FROM devices WHERE organization_id = ? ORDER BY created_at, id",
  allDevices: "SELECT * FROM devices ORDER BY created_at, id",
  deviceByCert: "SELECT * FROM devices WHERE certificate_identity = ?",
  setDeviceStatus: "UPDATE devices SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
  forceDeviceStatus: "UPDATE devices SET status = ?, updated_at = ? WHERE id = ?",
  renameDevice: "UPDATE devices SET display_name = ?, updated_at = ? WHERE id = ?",
  /** registered_at 只在**首次激活**时落一次（COALESCE 保住原值，rename/离线不刷新它）。 */
  markRegistered: "UPDATE devices SET registered_at = COALESCE(registered_at, ?), updated_at = ? WHERE id = ?",
  setDeviceCertificate:
    "UPDATE devices SET certificate_identity = ?, credential_version = ?, agent_version = ?, metadata_version = ?, updated_at = ? WHERE id = ?",
  touchDevice: "UPDATE devices SET last_seen_at = ?, connectivity = ?, agent_version = ?, updated_at = ? WHERE id = ?",
  setConnectivity: "UPDATE devices SET connectivity = ?, updated_at = ? WHERE id = ?",

  insertPairing:
    "INSERT INTO device_pairing_credentials (id, organization_id, secret_hash, status, issued_by, issued_at, expires_at, consumed_at, consumed_by_device_id, department_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  pairingById: "SELECT * FROM device_pairing_credentials WHERE id = ?",
  pairingByHash: "SELECT * FROM device_pairing_credentials WHERE secret_hash = ?",
  pairingsOfOrg: "SELECT * FROM device_pairing_credentials WHERE organization_id = ? ORDER BY issued_at DESC",
  allPairings: "SELECT * FROM device_pairing_credentials ORDER BY issued_at DESC",
  /** 单次消费的**唯一**实现点：只有 ISSUED 能被改成 CONSUMED。 */
  consumePairing:
    "UPDATE device_pairing_credentials SET status = 'CONSUMED', consumed_at = ?, consumed_by_device_id = ? WHERE id = ? AND status = 'ISSUED'",
  expirePairing: "UPDATE device_pairing_credentials SET status = 'EXPIRED' WHERE id = ? AND status = 'ISSUED'",
  revokePairing: "UPDATE device_pairing_credentials SET status = 'REVOKED' WHERE id = ? AND status = 'ISSUED'",

  insertCredential:
    "INSERT INTO device_credentials (id, device_id, organization_id, credential_version, subject, fingerprint, status, not_before, not_after, issued_at, rotated_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)",
  credentialById: "SELECT * FROM device_credentials WHERE id = ?",
  credentialByFingerprint: "SELECT * FROM device_credentials WHERE fingerprint = ?",
  activeCredentialOfDevice: "SELECT * FROM device_credentials WHERE device_id = ? AND status = 'ACTIVE' ORDER BY credential_version DESC LIMIT 1",
  credentialsOfDevice: "SELECT * FROM device_credentials WHERE device_id = ? ORDER BY credential_version DESC",
  rotateCredential: "UPDATE device_credentials SET status = 'ROTATED', rotated_at = ? WHERE id = ? AND status = 'ACTIVE'",
  revokeCredential: "UPDATE device_credentials SET status = 'REVOKED', rotated_at = ? WHERE id = ? AND status = 'ACTIVE'",
  revokeAllCredentials: "UPDATE device_credentials SET status = 'REVOKED', rotated_at = ? WHERE device_id = ? AND status = 'ACTIVE'",

  upsertAccess:
    "INSERT INTO device_access (id, device_id, organization_id, principal_type, principal_id, actions, granted_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(device_id, principal_type, principal_id) DO UPDATE SET actions = excluded.actions, granted_by = excluded.granted_by, expires_at = excluded.expires_at",
  accessOfDevice: "SELECT * FROM device_access WHERE device_id = ? ORDER BY created_at, id",
  accessByKey: "SELECT * FROM device_access WHERE device_id = ? AND principal_type = ? AND principal_id = ?",
  accessAll: "SELECT * FROM device_access ORDER BY created_at, id",
  deleteAccess: "DELETE FROM device_access WHERE id = ?",

  insertAudit:
    "INSERT INTO device_audit (at, actor_user_id, device_id, organization_id, event, reason_code, request_id, detail) VALUES (?,?,?,?,?,?,?,?)",
  auditOfDevice: "SELECT * FROM device_audit WHERE device_id = ? ORDER BY id",
  auditAll: "SELECT * FROM device_audit ORDER BY id",
};

const J = (v) => JSON.stringify(v == null ? [] : v);
const P = (v) => {
  try {
    return v ? JSON.parse(v) : [];
  } catch {
    return [];
  }
};

class DeviceStore {
  constructor({ identity, clock } = {}) {
    if (!identity) throw new Error("DeviceStore 需要 IdentityStore");
    this.identity = identity;
    this.db = identity.connection;
    this.clock = typeof clock === "function" ? clock : identity.clock;
  }

  transact(fn) {
    return this.identity.transact(fn);
  }

  transactSync(fn) {
    return this.identity.transactSync(fn);
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  insertDevice({
    organizationId,
    displayName,
    platform = "unknown",
    architecture = "unknown",
    status = DEVICE_STATUS.PENDING,
    registeredBy = null,
    departmentId = null,
    certificateIdentity = null,
    credentialVersion = 0,
    agentVersion = null,
    metadataVersion = 1,
    deviceId = null,
    at = null,
  } = {}) {
    const id = deviceId || domain.newDeviceId();
    const now = at == null ? this.clock() : at;
    this.db
      .prepare(SQL.insertDevice)
      .run(
        id,
        String(organizationId),
        String(displayName || "Unnamed Device").slice(0, 120),
        String(platform || "unknown"),
        String(architecture || "unknown"),
        status,
        status === DEVICE_STATUS.PENDING ? null : now,
        registeredBy,
        null,
        certificateIdentity,
        Number(credentialVersion) || 0,
        agentVersion,
        Number(metadataVersion) || 1,
        departmentId,
        CONNECTIVITY.UNKNOWN,
        now,
        now,
      );
    return this.deviceById(id);
  }

  deviceById(id) {
    return this.db.prepare(SQL.deviceById).get(String(id || "")) || null;
  }

  devicesOfOrg(organizationId) {
    return this.db.prepare(SQL.devicesOfOrg).all(String(organizationId || ""));
  }

  allDevices() {
    return this.db.prepare(SQL.allDevices).all();
  }

  deviceByCertificateIdentity(identity) {
    if (!identity) return null;
    return this.db.prepare(SQL.deviceByCert).get(String(identity)) || null;
  }

  /** 返回是否真的改了状态（并发下 changes=0 说明别人先动了）。 */
  setDeviceStatus(id, next, { expect = null, at = null } = {}) {
    const now = at == null ? this.clock() : at;
    if (expect) {
      const info = this.db.prepare(SQL.setDeviceStatus).run(next, now, String(id), expect);
      return { changed: info.changes === 1, at: now };
    }
    const info = this.db.prepare(SQL.forceDeviceStatus).run(next, now, String(id));
    return { changed: info.changes >= 1, at: now };
  }

  /** 首次激活时记录注册时刻；重复调用不会覆盖。 */
  markRegistered(id, { at = null } = {}) {
    const now = at == null ? this.clock() : at;
    this.db.prepare(SQL.markRegistered).run(now, now, String(id));
  }

  /** §44 rename 只改 display_name：deviceId / 权限 / 证书身份都不动。 */
  renameDevice(id, displayName, { at = null } = {}) {
    const now = at == null ? this.clock() : at;
    const info = this.db.prepare(SQL.renameDevice).run(String(displayName).slice(0, 120), now, String(id));
    return { changed: info.changes === 1 };
  }

  setDeviceCertificate(id, { certificateIdentity, credentialVersion, agentVersion = null, metadataVersion = 1, at = null } = {}) {
    const now = at == null ? this.clock() : at;
    this.db
      .prepare(SQL.setDeviceCertificate)
      .run(certificateIdentity, Number(credentialVersion) || 0, agentVersion, Number(metadataVersion) || 1, now, String(id));
  }

  touchDevice(id, { at = null, connectivity = CONNECTIVITY.ONLINE, agentVersion = null } = {}) {
    const now = at == null ? this.clock() : at;
    this.db.prepare(SQL.touchDevice).run(now, connectivity, agentVersion, now, String(id));
  }

  setConnectivity(id, connectivity, { at = null } = {}) {
    const now = at == null ? this.clock() : at;
    this.db.prepare(SQL.setConnectivity).run(connectivity, now, String(id));
  }

  // -------------------------------------------------------------------------
  // Pairing credentials
  // -------------------------------------------------------------------------

  insertPairing({
    organizationId,
    secretHash,
    issuedBy,
    issuedAt = null,
    expiresAt,
    departmentId = null,
    status = PAIRING_STATUS.ISSUED,
    pairingId = null,
  } = {}) {
    const id = pairingId || domain.newPairingId();
    const now = issuedAt == null ? this.clock() : issuedAt;
    this.db
      .prepare(SQL.insertPairing)
      .run(id, String(organizationId), String(secretHash), status, String(issuedBy), now, Number(expiresAt), null, null, departmentId, now);
    return this.pairingById(id);
  }

  pairingById(id) {
    return this.db.prepare(SQL.pairingById).get(String(id || "")) || null;
  }

  pairingBySecretHash(hash) {
    return this.db.prepare(SQL.pairingByHash).get(String(hash || "")) || null;
  }

  pairingsOfOrg(organizationId) {
    return this.db.prepare(SQL.pairingsOfOrg).all(String(organizationId || ""));
  }

  allPairings() {
    return this.db.prepare(SQL.allPairings).all();
  }

  /**
   * §17 §18 的核心：**单次消费**。
   * 只有 status 仍是 ISSUED 才能被改成 CONSUMED —— 两个并发请求里 changes=1 的只有一个。
   */
  consumePairing(id, { deviceId = null, at = null } = {}) {
    const now = at == null ? this.clock() : at;
    const info = this.db.prepare(SQL.consumePairing).run(now, deviceId, String(id));
    return { consumed: info.changes === 1, at: now };
  }

  expirePairing(id) {
    return this.db.prepare(SQL.expirePairing).run(String(id)).changes === 1;
  }

  revokePairing(id) {
    return this.db.prepare(SQL.revokePairing).run(String(id)).changes === 1;
  }

  // -------------------------------------------------------------------------
  // Device credentials
  // -------------------------------------------------------------------------

  insertCredential({
    deviceId,
    organizationId,
    credentialVersion,
    subject,
    fingerprint,
    notBefore,
    notAfter,
    status = CREDENTIAL_STATUS.ACTIVE,
    issuedAt = null,
    credentialId = null,
  } = {}) {
    const id = credentialId || domain.newCredentialId();
    const now = issuedAt == null ? this.clock() : issuedAt;
    this.db
      .prepare(SQL.insertCredential)
      .run(id, String(deviceId), String(organizationId), Number(credentialVersion), String(subject), String(fingerprint), status, Number(notBefore), Number(notAfter), now);
    return this.credentialById(id);
  }

  credentialById(id) {
    return this.db.prepare(SQL.credentialById).get(String(id || "")) || null;
  }

  credentialByFingerprint(fingerprint) {
    return this.db.prepare(SQL.credentialByFingerprint).get(String(fingerprint || "")) || null;
  }

  activeCredentialOfDevice(deviceId) {
    return this.db.prepare(SQL.activeCredentialOfDevice).get(String(deviceId || "")) || null;
  }

  credentialsOfDevice(deviceId) {
    return this.db.prepare(SQL.credentialsOfDevice).all(String(deviceId || ""));
  }

  rotateCredential(id, { at = null } = {}) {
    const now = at == null ? this.clock() : at;
    return this.db.prepare(SQL.rotateCredential).run(now, String(id)).changes === 1;
  }

  revokeCredential(id, { at = null } = {}) {
    const now = at == null ? this.clock() : at;
    return this.db.prepare(SQL.revokeCredential).run(now, String(id)).changes === 1;
  }

  revokeAllCredentials(deviceId, { at = null } = {}) {
    const now = at == null ? this.clock() : at;
    return this.db.prepare(SQL.revokeAllCredentials).run(now, String(deviceId)).changes;
  }

  // -------------------------------------------------------------------------
  // Device access（Organization / Department / Explicit User，§11）
  // -------------------------------------------------------------------------

  upsertDeviceAccess({ deviceId, organizationId, principalType, principalId = "", actions = [], grantedBy = null, expiresAt = null, accessId = null } = {}) {
    const id = accessId || domain.newAccessId();
    this.db
      .prepare(SQL.upsertAccess)
      .run(id, String(deviceId), String(organizationId), principalType, String(principalId || ""), J(actions), grantedBy, this.clock(), expiresAt);
    return this.accessByKey(deviceId, principalType, principalId);
  }

  accessByKey(deviceId, principalType, principalId = "") {
    return this.db.prepare(SQL.accessByKey).get(String(deviceId), principalType, String(principalId || "")) || null;
  }

  accessOfDevice(deviceId) {
    return this.db.prepare(SQL.accessOfDevice).all(String(deviceId || "")).map((r) => ({ ...r, actions: P(r.actions) }));
  }

  allDeviceAccess() {
    return this.db.prepare(SQL.accessAll).all().map((r) => ({ ...r, actions: P(r.actions) }));
  }

  deleteDeviceAccess(id) {
    return this.db.prepare(SQL.deleteAccess).run(String(id)).changes === 1;
  }

  // -------------------------------------------------------------------------
  // Audit（§46）
  // -------------------------------------------------------------------------

  appendAudit({ at = null, actorUserId = null, deviceId = null, organizationId = null, event, reasonCode = null, requestId = null, detail = {} } = {}) {
    const now = at == null ? this.clock() : at;
    const safe = domain.sanitizeAuditDetail(detail);
    this.db.prepare(SQL.insertAudit).run(now, actorUserId, deviceId, organizationId, String(event), reasonCode, requestId, JSON.stringify(safe));
    return { at: now, event, reasonCode };
  }

  auditOfDevice(deviceId) {
    return this.db.prepare(SQL.auditOfDevice).all(String(deviceId || "")).map((r) => ({ ...r, detail: safeParse(r.detail) }));
  }

  allAudit() {
    return this.db.prepare(SQL.auditAll).all().map((r) => ({ ...r, detail: safeParse(r.detail) }));
  }
}

function safeParse(v) {
  try {
    return v ? JSON.parse(v) : {};
  } catch {
    return {};
  }
}

module.exports = { DeviceStore, SQL, DEVICE_SQL: SQL };
