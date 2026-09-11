/** D3-01 · 渲染进程可见的身份类型。**与 electron/identity-domain.cjs 的快照一一对应。 */

export type IdentityPhase =
  /** 正在向主进程询问"我是谁"。**此阶段不得渲染任何桌面内容**（§39 禁止闪现）。 */
  | "checking"
  /** 没有主进程（浏览器 / 视觉回归环境）。门禁不参与，桌面照常渲染。 */
  | "unavailable"
  /** 尚未初始化 → 只能进 Setup。 */
  | "uninitialized"
  /** 已初始化但没有有效 session → 登录。 */
  | "unauthenticated"
  /** 有 session 但已锁定 → 桌面被锁屏完全覆盖。 */
  | "locked"
  /** 已登录。 */
  | "ready";

export type IdentitySnapshot = {
  userId: string | null;
  displayName: string | null;
  identifier: string | null;
  role: "ADMIN" | "MEMBER" | null;
  status: "ACTIVE" | "DISABLED" | null;
  teamId: string | null;
  avatarRef: string | null;
  sessionRef: string | null;
  sessionId: string | null;
  createdAt: number | null;
  lastSeenAt: number | null;
  expiresAt: number | null;
  locked: boolean;
  installationId: string | null;
  initialized: boolean;
  initStatus?: string;
};

export type InstallationStatus = {
  installationId: string | null;
  status: "UNINITIALIZED" | "INITIALIZING" | "READY";
  initialized: boolean;
  userCount: number;
};

/** 与 electron/identity-domain.cjs 的 ERROR 一致。UI **只**按 code 分支。 */
export type IdentityErrorCode =
  | "NOT_INITIALIZED"
  | "ALREADY_INITIALIZED"
  | "INVALID_CREDENTIALS"
  | "SESSION_EXPIRED"
  | "SESSION_REVOKED"
  | "USER_DISABLED"
  | "LOCKED"
  | "INVALID_INPUT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

/** 错误码 → 人话。集中一处，避免每个界面各写一版措辞。 */
export const IDENTITY_ERROR_TEXT: Record<IdentityErrorCode, string> = {
  NOT_INITIALIZED: "本机尚未完成初始化。",
  ALREADY_INITIALIZED: "本机已经初始化过了，不能重复创建管理员。",
  INVALID_CREDENTIALS: "标识符或口令不正确。",
  SESSION_EXPIRED: "登录状态已过期，请重新登录。",
  SESSION_REVOKED: "登录状态已失效，请重新登录。",
  USER_DISABLED: "该账号已被停用，请联系管理员。",
  LOCKED: "屏幕已锁定，需要重新验证。",
  INVALID_INPUT: "输入不合法。",
  RATE_LIMITED: "尝试过于频繁，请稍后再试。",
  INTERNAL_ERROR: "身份服务内部错误。",
};

export const errorText = (code: string | undefined, detail?: string) => {
  if (!code) return detail ? String(detail) : "";
  const base = IDENTITY_ERROR_TEXT[code as IdentityErrorCode] || String(code);
  // detail 只在其本身不是 code 时才补，避免把内部枚举直接糊给用户
  return detail && detail !== code ? `${base}（${detail}）` : base;
};
