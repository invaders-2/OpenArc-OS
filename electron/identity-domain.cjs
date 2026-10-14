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
  /**
   * 自然到期（绝对 / 空闲）落终态用的原因。**它不是"被撤销"**：
   * 库里留一条"这条会话是被到期收掉的"的权威事实（幂等，重复触发只终结一次），
   * 但 evaluateSession 对外仍然回 SESSION_EXPIRED —— 判据与懒判定同一份。
   */
  EXPIRED: "EXPIRED",
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
  "identity/update-profile",
]);

/** 管理员 / 测试夹具命令。**不在产品 UI 里暴露**（§18 / §20）。 */
const ADMIN_COMMANDS = Object.freeze([
  "identity/disable-user",
  "identity/enable-user",
  "identity/reset-installation",
]);

/**
 * B4 · 本地账号管理命令（部门 / 用户 / APP 访问 / 计数）。
 *
 * 写法与 skill-domain.cjs:44-74 / agent-domain.cjs:53+ 一致：命令表本身即白名单，
 * 每条带 risk（read | use | manage | destructive）与 credential（是否把口令等凭据带进执行路径）。
 * 命令不接受 Renderer 自报的 userId / role：身份由 sessionRef 反查（identity-service.cjs 分发层），
 * 具体超级管理员 / 部门管理员判定沿用 local-account-service.cjs 既有实现。
 */
const LOCAL_ACCOUNT_COMMANDS = Object.freeze({
  "identity/departments-list": { risk: "read", credential: false, summary: "列出当前组织的部门" },
  "identity/department-create": { risk: "manage", credential: false, summary: "创建部门（超级管理员）" },
  "identity/department-update": { risk: "manage", credential: false, summary: "改名 / 启停部门（超级管理员）" },
  "identity/department-delete": { risk: "destructive", credential: false, summary: "删除部门（超级管理员）" },
  "identity/users-list": { risk: "read", credential: false, summary: "列出本地账号用户" },
  "identity/user-create": { risk: "manage", credential: true, summary: "创建本地账号（携带初始口令）" },
  "identity/user-update": { risk: "manage", credential: false, summary: "修改用户名 / 部门 / 角色 / 状态" },
  "identity/user-delete": { risk: "destructive", credential: false, summary: "删除本地账号（保留审计行）" },
  "identity/user-reset-password": { risk: "manage", credential: true, summary: "重置用户口令并撤销其全部会话" },
  "identity/app-access-rule-save": { risk: "manage", credential: false, summary: "保存 APP 打开规则（all/admins/departments/superadmins）" },
  "identity/app-permission-policy-save": { risk: "manage", credential: false, summary: "保存 APP 权限策略（决策 / 用户 / 部门 / 角色）" },
  "identity/app-permission-snapshot": { risk: "read", credential: false, summary: "读取用户维度的 APP 访问与权限快照" },
  "identity/app-access-summary": { risk: "read", credential: false, summary: "汇总某用户可打开的 APP" },
  "identity/local-account-info": { risk: "read", credential: false, summary: "本地账号安装级计数（用户 / 部门）" },
  // B7f：审计区块的真实数据源（只读；字段投影去敏，分页 + 事件名 / 时间过滤）。
  "identity/audit-list": { risk: "read", credential: false, summary: "读取审计行（audit_log / authorization_audit 去敏投影）" },
});

const LOCAL_ACCOUNT_COMMAND_NAMES = Object.freeze(Object.keys(LOCAL_ACCOUNT_COMMANDS));

const ALL_COMMANDS = Object.freeze([...IDENTITY_COMMANDS, ...ADMIN_COMMANDS, ...LOCAL_ACCOUNT_COMMAND_NAMES]);

/** 未知命令一律返回 null / false，绝不猜风险或凭据属性（与 skill-domain.cjs:79-96 同形）。 */
function isLocalAccountCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(LOCAL_ACCOUNT_COMMANDS, command);
}

function localAccountCommandEntry(command) {
  return isLocalAccountCommand(command) ? LOCAL_ACCOUNT_COMMANDS[command] : null;
}

function localAccountCommandRisk(command) {
  const entry = localAccountCommandEntry(command);
  return entry ? entry.risk : null;
}

function localAccountCommandRequiresCredential(command) {
  const entry = localAccountCommandEntry(command);
  return !!(entry && entry.credential);
}

/** 稳定顺序的命令清单（对象字面量声明顺序），供身份命令层与测试消费。 */
function listLocalAccountCommands() {
  return Object.keys(LOCAL_ACCOUNT_COMMANDS).map((command) => ({
    command,
    risk: LOCAL_ACCOUNT_COMMANDS[command].risk,
    credential: LOCAL_ACCOUNT_COMMANDS[command].credential,
    summary: LOCAL_ACCOUNT_COMMANDS[command].summary,
  }));
}

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

/**
 * 头像预设白名单。**服务端才是权威**：渲染层传来的 preset id 必须在这里命中，
 * 否则一个拼错的 id 会变成库里一个永远渲染不出来的头像引用。
 */
const AVATAR_PRESETS = Object.freeze(["arc", "orbit", "wave", "grid", "sun", "moon"]);

/**
 * avatarRef 长度上限（字符数）。
 *
 * 上传头像允许 data:image/...;base64, 直接存引用，但**只存引用不存二进制**：
 * 400k 字符约等于 300KB 图像，是降采样后的小图量级；再大就说明渲染层没有按
 * 约定压缩。校验放服务端，避免把任意大字符串塞进身份库。
 */
const MAX_AVATAR_REF_LENGTH = 400_000;

/** 只接受渲染层约定过的三种格式；jpeg / png / webp 之外一律拒。 */
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * 校验头像引用。三态：
 *   · null / undefined / ""  → ok({ avatarRef: null })，语义是清除头像
 *   · preset:<id>            → id 必须来自 AVATAR_PRESETS
 *   · data:image/...;base64, → 格式与长度校验（不解码 payload，服务端不处理像素）
 * 其余一律 INVALID_INPUT，并带具体原因供 UI 与审计区分。
 */
function validateAvatarRef(raw) {
  if (raw === null || raw === undefined) return ok({ avatarRef: null });
  const ref = String(raw);
  if (ref === "") return ok({ avatarRef: null });
  if (ref.length > MAX_AVATAR_REF_LENGTH) return fail(ERROR.INVALID_INPUT, "avatar-ref-too-long");
  if (ref.startsWith("preset:")) {
    const id = ref.slice("preset:".length);
    if (AVATAR_PRESETS.includes(id)) return ok({ avatarRef: ref });
    return fail(ERROR.INVALID_INPUT, "avatar-preset-unknown");
  }
  if (ref.startsWith("data:")) {
    if (!AVATAR_DATA_URL_RE.test(ref)) return fail(ERROR.INVALID_INPUT, "avatar-data-url-invalid");
    return ok({ avatarRef: ref });
  }
  return fail(ERROR.INVALID_INPUT, "avatar-ref-invalid");
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
    // avatarRef 来自 users.avatar_ref；从未设置过才是 null（不再是恒为 null）。
    avatarRef: user.avatar_ref ?? null,
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
  /**
   * 会话自然到期（空闲 / 绝对上限到点）。
   * payload：{ reason: "idle" | "absolute"（当前真正起约束作用的那个）, sessionId, sessionRef }
   */
  SESSION_EXPIRED: "identity/session-expired",
  INITIALIZED: "identity/initialized",
  PROFILE_UPDATED: "identity/profile-updated",
});

// ---------------------------------------------------------------------------
// Session 判定（纯函数，供 store 与测试共用同一套口径）
// ---------------------------------------------------------------------------

/** 到期归因：哪一条上限真的起约束作用。 */
const EXPIRY_REASON = Object.freeze({ IDLE: "idle", ABSOLUTE: "absolute" });

/** 到期 detail 文案。懒判定原有的两个取值不许改（探针与日志按它分类）。 */
const EXPIRY_DETAIL = Object.freeze({ idle: "idle-expiry", absolute: "absolute-expiry" });

/**
 * 到期判据。**定时器与懒判定共用这一份**，不允许各算各的 ——
 * 否则就会出现"定时器说过期了、命令层还认它有效"或反之。
 *
 * 返回 null = 此刻没过期；否则给出归因与 dueAt（到期定时器就排在这里）。
 * 两条上限同时到点时归因绝对上限：与 evaluateSession 原有的判定顺序一致。
 */
function sessionExpiry(session, now) {
  if (!session) return null;
  const absolute = session.expires_at;
  const idle = session.idle_expires_at;
  const absoluteDue = Number.isFinite(absolute) && now >= absolute;
  const idleDue = Number.isFinite(idle) && now >= idle;
  if (!absoluteDue && !idleDue) return null;
  const reason = absoluteDue && (!idleDue || absolute <= idle) ? EXPIRY_REASON.ABSOLUTE : EXPIRY_REASON.IDLE;
  const dueAt = Math.min(Number.isFinite(absolute) ? absolute : Infinity, Number.isFinite(idle) ? idle : Infinity);
  return { reason, dueAt, detail: EXPIRY_DETAIL[reason] };
}

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
 *
 * 到期终结（REVOKE_REASON.EXPIRED）是这条顺序的唯一例外：那条落库只是把
 * "它到期了"写成权威事实，对外仍必须是 SESSION_EXPIRED —— 与定时器同一判据。
 */
function evaluateSession(session, user, now) {
  if (!session) return fail(ERROR.SESSION_REVOKED, "session-missing");
  if (!user) return fail(ERROR.SESSION_REVOKED, "user-missing");
  if (session.revoked_at != null && session.revoked_reason !== REVOKE_REASON.EXPIRED) {
    return fail(ERROR.SESSION_REVOKED, "session-revoked");
  }
  const expiry = sessionExpiry(session, now);
  if (expiry) return fail(ERROR.SESSION_EXPIRED, expiry.detail);
  // 到期终态但时钟未到点（时钟回拨）：仍是终态，绝不复活。
  if (session.revoked_at != null) return fail(ERROR.SESSION_REVOKED, "session-revoked");
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
  LOCAL_ACCOUNT_COMMANDS,
  LOCAL_ACCOUNT_COMMAND_NAMES,
  ALL_COMMANDS,
  isLocalAccountCommand,
  localAccountCommandEntry,
  localAccountCommandRisk,
  localAccountCommandRequiresCredential,
  listLocalAccountCommands,
  ERROR,
  REAUTH_CODES,
  TERMINAL_CODES,
  EVENT,
  EXPIRY_REASON,
  EXPIRY_DETAIL,
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
  AVATAR_PRESETS,
  MAX_AVATAR_REF_LENGTH,
  validateAvatarRef,
  identitySnapshot,
  emptySnapshot,
  installationSnapshot,
  snapshotViolations,
  sessionExpiry,
  evaluateSession,
  guardProtected,
  cooldownFor,
  rateKey,
};
