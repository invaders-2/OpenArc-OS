"use strict";

/**
 * D3-03 · Device 域（纯函数，无 IO，无 DB）。
 *
 * 这一层只回答规格 §2 的五个问题：
 *   这台设备是谁 / 属于哪个 Organization / 是否仍被授权 /
 *   当前 TLS 连接是否真的是这台已注册设备 / 用户是否有权让这台设备参与当前操作。
 *
 * 两条**冻结**约束（§3 §24）：
 *   UserId ≠ DeviceId —— 四个身份域（User / App / Resource / Device）互相独立；
 *   TLS Certificate Validity ≠ Device Authorization —— 密码学通过之后，Registry 还要再判一次。
 *
 * 之所以把状态、动作、reasonCode 集中在这里，是因为 §6 明确禁止把
 * OFFLINE / REVOKED / DISABLED / CERT_EXPIRED 混成一个 "Unavailable"：
 * 它们的**恢复路径完全不同**（等网络 / 重新 Pair / 管理员 Enable / 轮换凭据），
 * 混在一起会让 UI 和调用方都无法正确决策。
 */

const crypto = require("node:crypto");

/** ID 前缀与 D3-01 / D3-02 保持同一套生成方式（randomBytes(24).base64url）。 */
const ID_PREFIX = Object.freeze({
  DEVICE: "dev_",
  PAIRING: "pair_",
  CREDENTIAL: "dcr_",
  ACCESS: "dax_",
});

const newId = (prefix) => prefix + crypto.randomBytes(24).toString("base64url");

const newDeviceId = () => newId(ID_PREFIX.DEVICE);
const newPairingId = () => newId(ID_PREFIX.PAIRING);
const newCredentialId = () => newId(ID_PREFIX.CREDENTIAL);
const newAccessId = () => newId(ID_PREFIX.ACCESS);

const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{16,}$/;
const ORGANIZATION_ID_PATTERN = /^org_[A-Za-z0-9_-]{4,}$/;
const USER_ID_PATTERN = /^usr_[A-Za-z0-9_-]{4,}$/;

/**
 * 设备状态。REVOKED 是**终态**（§27：撤销后需要重新 Pair / 新凭据，不提供"原地复活"）。
 * 与"连接状态"是两根轴，见 CONNECTIVITY。
 */
const DEVICE_STATUS = Object.freeze({
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  DISABLED: "DISABLED",
  REVOKED: "REVOKED",
});

/** 允许的状态迁移。REVOKED 无出边。 */
const TRANSITIONS = Object.freeze({
  PENDING: Object.freeze([DEVICE_STATUS.ACTIVE, DEVICE_STATUS.REVOKED]),
  ACTIVE: Object.freeze([DEVICE_STATUS.DISABLED, DEVICE_STATUS.REVOKED]),
  DISABLED: Object.freeze([DEVICE_STATUS.ACTIVE, DEVICE_STATUS.REVOKED]),
  REVOKED: Object.freeze([]),
});

/**
 * 连接状态。§6 / §36：离线**只是连不上**，不自动升级为任何授权结论。
 * 这里刻意与 DEVICE_STATUS 分开存两根列，避免"用 status 表达一切"的塌缩。
 */
const CONNECTIVITY = Object.freeze({
  ONLINE: "ONLINE",
  OFFLINE: "OFFLINE",
  UNKNOWN: "UNKNOWN",
});

/** 凭据状态。ROTATED = 被新版本取代（失效但非安全事件）；REVOKED = 安全撤销。 */
const CREDENTIAL_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  ROTATED: "ROTATED",
  REVOKED: "REVOKED",
});

/** Pairing 凭据状态（§56：必须落库，不能只活在渲染进程内存里）。 */
const PAIRING_STATUS = Object.freeze({
  ISSUED: "ISSUED",
  CONSUMED: "CONSUMED",
  EXPIRED: "EXPIRED",
  REVOKED: "REVOKED",
});

/** §12 最小 Device Action Namespace。执行权限判断一律走动作，不看 role === ADMIN。 */
const DEVICE_ACTION = Object.freeze({
  VIEW: "device.view",
  USE: "device.use",
  MANAGE: "device.manage",
  DISABLE: "device.disable",
  REVOKE: "device.revoke",
  PAIR: "device.pair",
});

const DEVICE_ACTIONS = Object.freeze(Object.values(DEVICE_ACTION));

/** 管理类动作（Super Admin 专属，见 §13；部门管理员默认不得拥有，见 §14）。 */
const SUPER_ADMIN_ONLY_ACTIONS = Object.freeze([
  DEVICE_ACTION.MANAGE,
  DEVICE_ACTION.DISABLE,
  DEVICE_ACTION.REVOKE,
  DEVICE_ACTION.PAIR,
]);

/** 动作 → 所需授权面。Pairing / 管理只能在组织级；use/view 可下放到部门。 */
const ACTION_SCOPE = Object.freeze({
  [DEVICE_ACTION.PAIR]: "ORGANIZATION",
  [DEVICE_ACTION.MANAGE]: "ORGANIZATION",
  [DEVICE_ACTION.DISABLE]: "ORGANIZATION",
  [DEVICE_ACTION.REVOKE]: "ORGANIZATION",
  [DEVICE_ACTION.VIEW]: "DEPARTMENT",
  [DEVICE_ACTION.USE]: "DEPARTMENT",
});

/** 访问控制的 principal 类型（§11：Organization / Department / Explicit User）。 */
const ACCESS_PRINCIPAL = Object.freeze({
  ORGANIZATION: "ORGANIZATION",
  DEPARTMENT: "DEPARTMENT",
  USER: "USER",
});

const DECISION = Object.freeze({ ALLOW: "ALLOW", DENY: "DENY" });

/**
 * reasonCode。**每一个都对应一条不同的恢复路径**，这是 §6 的机器表达：
 *   DEVICE_OFFLINE        → 等它上线，什么都别改
 *   DEVICE_DISABLED       → 管理员 Enable 即可恢复
 *   DEVICE_REVOKED        → 必须重新 Pair 换新凭据
 *   CERT_EXPIRED          → 走轮换流程
 *   CREDENTIAL_STALE      → 存在更新的 credentialVersion，旧凭据不再受信
 */
const REASON = Object.freeze({
  DEVICE_NOT_FOUND: "DEVICE_NOT_FOUND",
  DEVICE_PENDING: "DEVICE_PENDING",
  DEVICE_ACTIVE: "DEVICE_ACTIVE",
  DEVICE_DISABLED: "DEVICE_DISABLED",
  DEVICE_REVOKED: "DEVICE_REVOKED",
  DEVICE_OFFLINE: "DEVICE_OFFLINE",
  DEVICE_STATUS_UNKNOWN: "DEVICE_STATUS_UNKNOWN",
  CROSS_ORGANIZATION_DEVICE: "CROSS_ORGANIZATION_DEVICE",
  DEVICE_DEPARTMENT_DENIED: "DEVICE_DEPARTMENT_DENIED",
  DEVICE_ACTION_NOT_GRANTED: "DEVICE_ACTION_NOT_GRANTED",
  DEVICE_CREDENTIAL_UNKNOWN: "DEVICE_CREDENTIAL_UNKNOWN",
  DEVICE_CREDENTIAL_EXPIRED: "DEVICE_CREDENTIAL_EXPIRED",
  DEVICE_CREDENTIAL_REVOKED: "DEVICE_CREDENTIAL_REVOKED",
  DEVICE_CREDENTIAL_STALE: "DEVICE_CREDENTIAL_STALE",
  DEVICE_CREDENTIAL_MISMATCH: "DEVICE_CREDENTIAL_MISMATCH",
  DEVICE_IDENTITY_MISMATCH: "DEVICE_IDENTITY_MISMATCH",
  SERVICE_IDENTITY_MISMATCH: "SERVICE_IDENTITY_MISMATCH",
  TLS_REQUIRED: "TLS_REQUIRED",
  PAIRING_TOKEN_UNKNOWN: "PAIRING_TOKEN_UNKNOWN",
  PAIRING_TOKEN_ALREADY_USED: "PAIRING_TOKEN_ALREADY_USED",
  PAIRING_TOKEN_EXPIRED: "PAIRING_TOKEN_EXPIRED",
  PAIRING_TOKEN_REVOKED: "PAIRING_TOKEN_REVOKED",
  PAIRING_TOKEN_ORGANIZATION_MISMATCH: "PAIRING_TOKEN_ORGANIZATION_MISMATCH",
  INVALID_DEVICE_ID: "INVALID_DEVICE_ID",
  INVALID_ORGANIZATION: "INVALID_ORGANIZATION",
  INVALID_STATUS_TRANSITION: "INVALID_STATUS_TRANSITION",
  ROTATION_VERSION_NOT_MONOTONIC: "ROTATION_VERSION_NOT_MONOTONIC",
  NOT_FOUND_OR_FORBIDDEN: "NOT_FOUND_OR_FORBIDDEN",
  /** 组合入口专用：资源侧不过（§40 §72 的交集语义）。 */
  RESOURCE_NOT_AUTHORIZED: "RESOURCE_NOT_AUTHORIZED",
  SESSION_NOT_AUTHORIZED: "SESSION_NOT_AUTHORIZED",
  NOT_SUPER_ADMIN: "NOT_SUPER_ADMIN",
  INVALID_INPUT: "INVALID_INPUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

/**
 * 对外**可枚举**的 reason：跨组织 / 越权一律收敛为 NOT_FOUND_OR_FORBIDDEN，
 * 否则调用方可以用 deviceId 探测"这台设备是否存在"（延续 D3-02 anti-enumeration 口径）。
 */
const OPAQUE_REASONS = Object.freeze([REASON.NOT_FOUND_OR_FORBIDDEN]);
const HIDDEN_REASONS = Object.freeze([
  REASON.DEVICE_NOT_FOUND,
  REASON.CROSS_ORGANIZATION_DEVICE,
  REASON.DEVICE_DEPARTMENT_DENIED,
  REASON.DEVICE_ACTION_NOT_GRANTED,
]);

const AUDIT_EVENT = Object.freeze({
  PAIRING_CREATED: "PAIRING_CREATED",
  PAIRING_USED: "PAIRING_USED",
  PAIRING_REJECTED: "PAIRING_REJECTED",
  DEVICE_REGISTERED: "DEVICE_REGISTERED",
  DEVICE_DISABLED: "DEVICE_DISABLED",
  DEVICE_ENABLED: "DEVICE_ENABLED",
  DEVICE_REVOKED: "DEVICE_REVOKED",
  DEVICE_RENAMED: "DEVICE_RENAMED",
  CERT_ROTATED: "CERT_ROTATED",
  TLS_AUTH_FAILED: "TLS_AUTH_FAILED",
  DEVICE_AUTH_DENIED: "DEVICE_AUTH_DENIED",
  DEVICE_AUTH_ALLOWED: "DEVICE_AUTH_ALLOWED",
  DEVICE_SEEN: "DEVICE_SEEN",
  DEVICE_ONLINE: "DEVICE_ONLINE",
  DEVICE_OFFLINE: "DEVICE_OFFLINE",
});

/**
 * 审计里**永远不允许出现**的字段（§46 §47 §48）。
 * 用一张显式黑名单，而不是"写的时候小心一点"。
 */
const AUDIT_FORBIDDEN_KEYS = Object.freeze([
  "privateKey",
  "private_key",
  "secret",
  "pairingSecret",
  "pairing_secret",
  "token",
  "sessionToken",
  "key",
  "keyMaterial",
  "pem",
  "certificatePem",
]);

const newPairingSecret = () => crypto.randomBytes(32).toString("base64url");

/**
 * Pairing secret **只存 hash**（§47：用假 secret 扫文件/日志必须 0 命中）。
 * 用 sha256 而不是 KDF：secret 是 256bit 真随机，不需要抗弱口令。
 */
const pairingSecretHash = (secret) => crypto.createHash("sha256").update(String(secret)).digest("hex");

const DEVICE_HEALTH_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_OFFLINE_AFTER_MS = 90 * 1000;

/** §19 边界口径与 D3-01 session 一致：now >= expiresAt 即失效。 */
const isExpired = (expiresAt, now) => expiresAt != null && now >= expiresAt;

/** §4：hostname / IP / MAC / machine name / cert serial 只能当 metadata，不能当身份。 */
const FORBIDDEN_IDENTITY_KEYS = Object.freeze(["hostname", "ip", "mac", "machineName", "serialNumber"]);

function sanitizeMetadata(input = {}) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (FORBIDDEN_IDENTITY_KEYS.includes(k)) continue;
    if (v == null) continue;
    out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  return out;
}

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/** 状态机唯一入口：非法迁移一律拒绝，不静默改状态。 */
function assertTransition(from, to) {
  if (from === to) return { ok: true, reason: null };
  if (!canTransition(from, to)) return { ok: false, reason: REASON.INVALID_STATUS_TRANSITION };
  return { ok: true, reason: null };
}

/**
 * 凭据是否仍然可用（§24 的第一层）。**只看密码学与版本**，
 * 设备状态是否允许由 deviceAuthorizable 决定 —— 两层都必须过。
 */
function credentialUsable(credential, { now, deviceCredentialVersion } = {}) {
  if (!credential) return { ok: false, reason: REASON.DEVICE_CREDENTIAL_UNKNOWN };
  if (credential.status === CREDENTIAL_STATUS.REVOKED)
    return { ok: false, reason: REASON.DEVICE_CREDENTIAL_REVOKED };
  if (credential.status === CREDENTIAL_STATUS.ROTATED)
    return { ok: false, reason: REASON.DEVICE_CREDENTIAL_STALE };
  if (credential.not_before != null && now < credential.not_before)
    return { ok: false, reason: REASON.DEVICE_CREDENTIAL_MISMATCH };
  if (credential.not_after != null && now >= credential.not_after)
    return { ok: false, reason: REASON.DEVICE_CREDENTIAL_EXPIRED };
  if (deviceCredentialVersion != null && credential.credential_version !== deviceCredentialVersion)
    return { ok: false, reason: REASON.DEVICE_CREDENTIAL_STALE };
  return { ok: true, reason: null };
}

/** §24 的第二层：Registry 状态是否允许这次执行。 */
function deviceAuthorizable(device) {
  if (!device) return { ok: false, reason: REASON.DEVICE_NOT_FOUND };
  switch (device.status) {
    case DEVICE_STATUS.ACTIVE:
      return { ok: true, reason: null };
    case DEVICE_STATUS.PENDING:
      return { ok: false, reason: REASON.DEVICE_PENDING };
    case DEVICE_STATUS.DISABLED:
      return { ok: false, reason: REASON.DEVICE_DISABLED };
    case DEVICE_STATUS.REVOKED:
      return { ok: false, reason: REASON.DEVICE_REVOKED };
    default:
      return { ok: false, reason: REASON.DEVICE_STATUS_UNKNOWN };
  }
}

/** 对外收敛：隐藏原因替换为 NOT_FOUND_OR_FORBIDDEN。 */
function publicReason(reason) {
  return HIDDEN_REASONS.includes(reason) ? REASON.NOT_FOUND_OR_FORBIDDEN : reason;
}

/** §35 heartbeat 只能表示 online/health，绝不能作为授权续期或状态变更的依据。 */
function heartbeatMayChangeStatus() {
  return false;
}

/** §33/§34：payload 里的 deviceId 必须与 TLS 身份解析出的 deviceId 完全一致。 */
function assertHeartbeatIdentity({ tlsDeviceId, claimedDeviceId, tlsCredentialFingerprint, credential }) {
  if (!tlsDeviceId) return { ok: false, reason: REASON.DEVICE_IDENTITY_MISMATCH };
  if (claimedDeviceId != null && claimedDeviceId !== tlsDeviceId)
    return { ok: false, reason: REASON.DEVICE_IDENTITY_MISMATCH };
  if (credential && tlsCredentialFingerprint && credential.fingerprint !== tlsCredentialFingerprint)
    return { ok: false, reason: REASON.DEVICE_CREDENTIAL_MISMATCH };
  return { ok: true, reason: null };
}

function parsePairedAt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 审计记录写入前统一过一遍：剔除禁止字段 + 裁剪长度。 */
function sanitizeAuditDetail(detail = {}) {
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (AUDIT_FORBIDDEN_KEYS.includes(k)) continue;
    if (v == null) continue;
    out[k] = typeof v === "string" ? v.slice(0, 300) : v;
  }
  return out;
}

module.exports = {
  ID_PREFIX,
  DEVICE_ID_PATTERN,
  ORGANIZATION_ID_PATTERN,
  USER_ID_PATTERN,
  newDeviceId,
  newPairingId,
  newCredentialId,
  newAccessId,
  newPairingSecret,
  pairingSecretHash,
  DEVICE_STATUS,
  TRANSITIONS,
  CONNECTIVITY,
  CREDENTIAL_STATUS,
  PAIRING_STATUS,
  DEVICE_ACTION,
  DEVICE_ACTIONS,
  SUPER_ADMIN_ONLY_ACTIONS,
  ACTION_SCOPE,
  ACCESS_PRINCIPAL,
  DECISION,
  REASON,
  OPAQUE_REASONS,
  HIDDEN_REASONS,
  AUDIT_EVENT,
  AUDIT_FORBIDDEN_KEYS,
  FORBIDDEN_IDENTITY_KEYS,
  DEVICE_HEALTH_MAX_AGE_MS,
  DEFAULT_OFFLINE_AFTER_MS,
  isExpired,
  sanitizeMetadata,
  canTransition,
  assertTransition,
  credentialUsable,
  deviceAuthorizable,
  publicReason,
  heartbeatMayChangeStatus,
  assertHeartbeatIdentity,
  parsePairedAt,
  sanitizeAuditDetail,
};
