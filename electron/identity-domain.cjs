/**
 * D3-01 · Identity domain model。
 *
 * 与 window-domain.cjs 同一套约束：**纯函数、无 Electron / 无 DOM / 无 I/O**，
 * 因此能被 `node --test` 直接覆盖，也能被主进程与渲染进程同时引用。
 *
 * 三条不可动摇的边界：
 *
 *   1. **User Identity ≠ Device Identity**（D1-05 / D1-06 冻结）。
 *      本模块有 InstallationId / UserId / SessionId / TeamId，**没有 deviceId** ——
 *      设备注册与 TLS 设备身份属于 D3-03，本轮不许提前建。
 *
 *   2. **Renderer 不是认证权威**。渲染进程只能拿到 `identitySnapshot()` 的投影：
 *      userId / displayName / role / status / sessionRef / locked。
 *      拿不到 password、verifier、salt、raw token、全量 session store。
 *
 *   3. **错误用 code，不用字符串**。UI 禁止按异常文本猜状态（§26）。
 */
"use strict";

const crypto = require("node:crypto");

// ---------------------------------------------------------------------------
// ID 域
// ---------------------------------------------------------------------------

/**
 * 四个 ID 域各自独立、各自带前缀。
 *
 * 为什么要前缀：日志与审计里出现 `ses_01H...` 时一眼能看出它属于哪个域，
 * 不会出现"把一个 userId 当 sessionId 查"这类跨域误用还能静默返回结果的情形。
 */
const ID_PREFIX = Object.freeze({
  INSTALLATION: "inst_",
  TEAM: "team_",
  USER: "usr_",
  SESSION: "ses_",
  SESSION_REF: "sref_",
});

/** 24 字节 → 32 个 base32-ish 字符。不用 uuid，避免暴露时间序。 */
function newId(kind) {
  const prefix = ID_PREFIX[kind] || "";
  return prefix + crypto.randomBytes(24).toString("base64url");
}

const isIdOf = (kind, value) => typeof value === "string" && value.startsWith(ID_PREFIX[kind]);

/**
 * sessionRef 与 session token 是**两个不同的东西**，且互相不可推导：
 *
 *   token  —— 32 字节随机，只存在于 OS 受保护存储与主进程内存；
 *             数据库里只有它的 SHA-256（token_hash），用于重启时反查 session。
 *   ref    —— 另一次独立随机的不透明句柄，**渲染进程唯一持有的东西**。
 *             它本身没有任何密码学意义，只在主进程的内存映射里指向一个 session。
 *
 * 这样做的好处：即使 ref 泄漏（比如被同机其它进程从渲染进程内存里读走），
 * 攻击者拿到的也只是一个"这一进程实例里的代号"，换一个进程、换一次启动就失效；
 * 而真正能跨重启恢复身份的 token 从未进入渲染进程。
 */
function newSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

const hashToken = (token) => crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
const hashRef = (ref) => crypto.createHash("sha256").update(String(ref), "utf8").digest("hex").slice(0, 16);

// ---------------------------------------------------------------------------
// 状态枚举
// ---------------------------------------------------------------------------

/** 初始化状态机（§4）。**只有三个状态**，且 `INITIALIZING` 绝不落盘。 */
const INIT = Object.freeze({
  UNINITIALIZED: "UNINITIALIZED",
  INITIALIZING: "INITIALIZING",
  READY: "READY",
});

const USER_STATUS = Object.freeze({ ACTIVE: "ACTIVE", DISABLED: "DISABLED" });
const USER_ROLE = Object.freeze({ ADMIN: "ADMIN", MEMBER: "MEMBER" });

/** 撤销原因。进审计，不进对外错误码（对外统一是 SESSION_REVOKED）。 */
const REVOKE_REASON = Object.freeze({
  LOGOUT: "LOGOUT",
  PASSWORD_CHANGED: "PASSWORD_CHANGED",
  USER_DISABLED: "USER_DISABLED",
  RESET: "RESET",
  ADMIN: "ADMIN",
});

// ---------------------------------------------------------------------------
// 命令层（§25）
// ---------------------------------------------------------------------------

/**
 * 冻结的领域命令。与 Window Command 同一原则：
 * UI 与未来的 AI 走**同一条**命令层，不存在"UI 直接改身份状态"的旁路。
 *
 * `identity/disable-user` 与 `identity/enable-user` 是 **admin / 测试夹具**命令，
 * 本轮不建完整 admin UI（§18），但它们必须存在——否则"禁用用户"这条
 * 安全语义无法被验证，D4 也就没有 USER_DISABLED 可消费（§19）。
 */
const IDENTITY_COMMANDS = Object.freeze([
  "identity/status",
  "identity/initialize",
  "identity/login",
  "identity/restore",
  "identity/logout",
  "identity/lock",
  "identity/unlock",
  "identity/change-password",
  "identity/validate",
]);

/** 管理员 / 测试夹具命令。**不在产品 UI 里暴露**（§18 / §20）。 */
const ADMIN_COMMANDS = Object.freeze([
  "identity/disable-user",
  "identity/enable-user",
  "identity/reset-installation",
]);

const ALL_COMMANDS = Object.freeze([...IDENTITY_COMMANDS, ...ADMIN_COMMANDS]);

// ---------------------------------------------------------------------------
// 错误模型（§26）
// ---------------------------------------------------------------------------

/**
 * 对外错误码。**UI 只能按 code 分支**，禁止解析消息文本。
 *
 * INVALID_CREDENTIALS 统一代表"标识符不存在"或"口令错误"（§12）——
 * 内部日志可以分类，但对不可信入口只给一个码。
 */
const ERROR = Object.freeze({
  NOT_INITIALIZED: "NOT_INITIALIZED",
  ALREADY_INITIALIZED: "ALREADY_INITIALIZED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  SESSION_REVOKED: "SESSION_REVOKED",
  USER_DISABLED: "USER_DISABLED",
  LOCKED: "LOCKED",
  INVALID_INPUT: "INVALID_INPUT",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

/**
 * 需要重新验证才能继续（而不是彻底没救）的码。
 * §47：locked session 的受保护命令返回 LOCKED，UI 据此弹锁屏而不是踢回登录。
 */
const REAUTH_CODES = Object.freeze([ERROR.LOCKED]);
/** 必须回到登录页的码。session 已不可恢复。 */
const TERMINAL_CODES = Object.freeze([
  ERROR.SESSION_EXPIRED,
  ERROR.SESSION_REVOKED,
  ERROR.USER_DISABLED,
  ERROR.NOT_INITIALIZED,
]);

const ok = (value) => ({ ok: true, ...value });
const fail = (code, detail) => ({ ok: false, error: code, ...(detail ? { detail } : {}) });

// ---------------------------------------------------------------------------
// 输入归一化
// ---------------------------------------------------------------------------

/**
 * 标识符归一化：trim + 小写。
 *
 * 唯一性约束打在**归一化后**的值上（users.identifier UNIQUE）。
 * 否则 `Admin@x.com` 与 `admin@x.com` 会是两个账号——
 * 这是"唯一 user identity"（§30）最容易破的一个口子。
 */
function normalizeIdentifier(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

const MAX_IDENTIFIER_LENGTH = 254;
const MAX_DISPLAY_NAME_LENGTH = 80;

function validateIdentifier(raw) {
  const id = normalizeIdentifier(raw);
  if (!id) return fail(ERROR.INVALID_INPUT, "identifier-empty");
  if (id.length > MAX_IDENTIFIER_LENGTH) return fail(ERROR.INVALID_INPUT, "identifier-too-long");
  // 控制字符与空白会让"看起来一样"的两个标识符并存，直接拒。
  if (/[\s\x00-\x1f\x7f]/.test(id)) return fail(ERROR.INVALID_INPUT, "identifier-control-char");
  return ok({ identifier: id });
}

function validateDisplayName(raw) {
  const name = String(raw ?? "").trim();
  if (!name) return fail(ERROR.INVALID_INPUT, "display-name-empty");
  if (name.length > MAX_DISPLAY_NAME_LENGTH) return fail(ERROR.INVALID_INPUT, "display-name-too-long");
  return ok({ displayName: name });
}

// ---------------------------------------------------------------------------
// Identity Snapshot（§23）
// ---------------------------------------------------------------------------

/**
 * 渲染进程能收到的身份投影。**白名单**，不是黑名单——
 * 新增字段必须显式写在这里，漏掉一个字段只是"UI 少看到点东西"，
 * 而用黑名单漏掉一个字段就是"把 salt 发出去了"。
 *
 * 明确不含：passwordHash / salt / password params / token / token_hash /
 * 全量 session 列表 / 任何 credentialRef 明文。
 */
function identitySnapshot({ user, session, initialized } = {}) {
  if (!user || !session) return null;
  return {
    userId: user.id,
    displayName: user.display_name,
    identifier: user.identifier,
    role: user.role,
    status: user.status,
    teamId: user.team_id,
    // avatarRef 是 D3 之后的事，字段先落位，恒为 null
    avatarRef: null,
    sessionRef: session.ref,
    sessionId: session.id,
    createdAt: session.created_at,
    lastSeenAt: session.last_seen_at,
    expiresAt: session.expires_at,
    locked: !!session.locked_at,
    installationId: session.installation_id ?? null,
    initialized: initialized !== false,
  };
}

/** 未登录 / 已登出时的空快照。UI 一律按这个形状渲染，不靠 null 猜。 */
function emptySnapshot({ initialized, status } = {}) {
  return {
    userId: null,
    displayName: null,
    identifier: null,
    role: null,
    status: null,
    teamId: null,
    avatarRef: null,
    sessionRef: null,
    sessionId: null,
    createdAt: null,
    lastSeenAt: null,
    expiresAt: null,
    locked: false,
    installationId: null,
    initialized: !!initialized,
    initStatus: status || INIT.UNINITIALIZED,
  };
}

/** 安装级状态（不含任何用户数据），未初始化时也能安全下发给渲染进程。 */
function installationSnapshot({ installation, userCount } = {}) {
  return {
    installationId: installation?.id ?? null,
    status: installation?.status ?? INIT.UNINITIALIZED,
    initialized: installation?.status === INIT.READY,
    userCount: userCount ?? 0,
  };
}

/**
 * 快照安全静态断言。
 *
 * 这是 §23 的"建立静态 Probe"在代码里的落点：任何一次快照下发前都可以用它自检。
 * 判据不看字段名"像不像"，而是**逐个 key 比对禁止前缀**。
 */
const FORBIDDEN_SNAPSHOT_KEYS = Object.freeze([
  "password",
  "password_hash",
  "password_salt",
  "password_params",
  "password_algo",
  "salt",
  "token",
  "token_hash",
  "secret",
  "credential",
  "apikey",
  "api_key",
]);

function snapshotViolations(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const bad = [];
  for (const key of Object.keys(snapshot)) {
    const flat = key.toLowerCase().replace(/[^a-z]/g, "");
    for (const forbidden of FORBIDDEN_SNAPSHOT_KEYS) {
      if (flat === forbidden.replace(/[^a-z]/g, "")) bad.push(key);
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------
// 身份事件（§24）
// ---------------------------------------------------------------------------

/**
 * 最小事件集。**Window / TopBar / LockScreen 消费同一份身份状态**，
 * 禁止任何组件自己去读 localStorage 里的 user（§24 最后一条）。
 */
const EVENT = Object.freeze({
  SESSION_CHANGED: "identity/session-changed",
  LOCKED: "identity/locked",
  UNLOCKED: "identity/unlocked",
  LOGGED_OUT: "identity/logged-out",
  INITIALIZED: "identity/initialized",
});

// ---------------------------------------------------------------------------
// Session 判定（纯函数，供 store 与测试共用同一套口径）
// ---------------------------------------------------------------------------

/**
 * session 此刻是否可用。
 *
 * 判定顺序是**冻结的**，因为它决定了错误码：
 *   revoked → 被撤销（登出/改密/禁用/重置）
 *   expired → 超时（绝对上限或空闲上限）
 *   用户禁用 → USER_DISABLED（§19：给 D4 消费）
 *   authVersion 不匹配 → SESSION_REVOKED
 *
 * **用户状态排在 authVersion 之前**：改密与禁用同时发生时，
 * 报告"账号已禁用"比报告"session 已失效"更能指导下一步动作。
 */
function evaluateSession(session, user, now) {
  if (!session) return fail(ERROR.SESSION_REVOKED, "session-missing");
  if (!user) return fail(ERROR.SESSION_REVOKED, "user-missing");
  if (session.revoked_at != null) return fail(ERROR.SESSION_REVOKED, "session-revoked");
  if (now >= session.expires_at) return fail(ERROR.SESSION_EXPIRED, "absolute-expiry");
  if (now >= session.idle_expires_at) return fail(ERROR.SESSION_EXPIRED, "idle-expiry");
  if (user.status === USER_STATUS.DISABLED) return fail(ERROR.USER_DISABLED, "user-disabled");
  if (session.auth_version !== user.auth_version) return fail(ERROR.SESSION_REVOKED, "auth-version-mismatch");
  return ok({ session, user });
}

/**
 * 受保护命令的守卫（§47）。
 *
 * locked session **仍然有效**（身份仍可识别），但受保护命令必须 DENY。
 * 这不是"把 locked 当 revoked"，两者后果完全不同：
 *   LOCKED   → 弹锁屏，验证口令后原地恢复
 *   REVOKED  → 回登录页，重新登录
 */
function guardProtected(session, user, now, { sensitive } = {}) {
  const base = evaluateSession(session, user, now);
  if (!base.ok) return base;
  if (sensitive !== false && session.locked_at != null) return fail(ERROR.LOCKED, "session-locked");
  return base;
}

// ---------------------------------------------------------------------------
// 限流（§33）
// ---------------------------------------------------------------------------

/**
 * 防暴力策略。**明确否决"失败 5 次永久锁账号"** ——
 * 那不是安全设计，是把"让某个用户永远登不进去"的能力免费送给任何人（DoS）。
 *
 * 本策略：
 *   · 按 (标识符哈希, source) 两个维度分别计数，任一维度超限即冷却
 *   · 冷却**指数退避**，有上限，且**按成功登录清零**
 *   · 冷却随时间自动衰减，不需要管理员介入
 *   · 永不永久封锁
 */
const RATE_LIMIT = Object.freeze({
  MAX_FAILURES: 8,
  BASE_COOLDOWN_MS: 1_000,
  MAX_COOLDOWN_MS: 60_000,
  /** 距上次失败超过这个时长就重新计数 —— 偶尔手滑不该累积成封锁。 */
  FAILURE_WINDOW_MS: 10 * 60_000,
});

/** failures → 冷却时长。指数退避 + 上限。 */
function cooldownFor(failures) {
  if (failures < RATE_LIMIT.MAX_FAILURES) return 0;
  const exp = Math.min(6, failures - RATE_LIMIT.MAX_FAILURES);
  return Math.min(RATE_LIMIT.MAX_COOLDOWN_MS, RATE_LIMIT.BASE_COOLDOWN_MS * 2 ** exp);
}

/** 限流键的标识部分：只存哈希，日志与库里都不出现明文标识符。 */
const rateKey = (identifier, source) =>
  crypto.createHash("sha256").update(`${normalizeIdentifier(identifier)}|${String(source ?? "local")}`).digest("hex").slice(0, 32);

module.exports = {
  ID_PREFIX,
  INIT,
  USER_STATUS,
  USER_ROLE,
  REVOKE_REASON,
  IDENTITY_COMMANDS,
  ADMIN_COMMANDS,
  ALL_COMMANDS,
  ERROR,
  REAUTH_CODES,
  TERMINAL_CODES,
  EVENT,
  RATE_LIMIT,
  FORBIDDEN_SNAPSHOT_KEYS,
  newId,
  isIdOf,
  newSessionToken,
  hashToken,
  hashRef,
  ok,
  fail,
  normalizeIdentifier,
  validateIdentifier,
  validateDisplayName,
  identitySnapshot,
  emptySnapshot,
  installationSnapshot,
  snapshotViolations,
  evaluateSession,
  guardProtected,
  cooldownFor,
  rateKey,
};
