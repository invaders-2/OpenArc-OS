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
  INVALID_CREDENTIALS: "账号或密码不正确。",
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

/**
 * 主进程推来的身份事件 → 渲染层收敛（纯函数）。
 *
 * 判定集中在这里、而不是散在订阅回调里，有两个理由：
 *   · 收敛用的错误码必须是身份域真实的码（自然到期 = SESSION_EXPIRED），
 *     与命令失败时 absorb 的失败收敛同一张表，不允许在渲染层另造一个"过期"状态；
 *   · 渲染层没有 hook 级测试基建（真机路径是 tests/identity-ui.mjs 的 Electron 探针），
 *     做成"事件进 → 状态出"的纯函数才能被 node --test 直接覆盖，
 *     也保证测的就是 useIdentity 用的那一份判定。
 *
 * 口径与旧行为逐条对齐：
 *   · LOCKED                → 锁屏（不动投影）
 *   · LOGGED_OUT            → 清投影 + 登录页，不写错误（正常登出不是错误）
 *   · SESSION_EXPIRED（自然到期）→ 与登出同一条收敛，额外按 SESSION_EXPIRED 写一次错误，
 *     让登录页给出的解释和"下一条命令失败"完全一致
 *   · UNLOCKED / SESSION_CHANGED → 按快照的 locked 定 locked / ready
 *   · 其余事件一律不动（未知事件不改变门禁状态）
 */
export type IdentityEventConvergence = {
  /** 要迁移到的门禁状态；null = 保持当前状态。 */
  phase: IdentityPhase | null;
  /** true = 这条会话已经没了，本地投影必须清空，不能留一个"看似已登录"的壳。 */
  clearSnapshot: boolean;
  /** 非 null = 按这个身份域错误码走 absorb 的失败收敛。 */
  errorCode: IdentityErrorCode | null;
};

export function identityEventConvergence(event: { event?: string; snapshot?: { locked?: boolean } | null }): IdentityEventConvergence {
  switch (event?.event) {
    case "identity/locked":
      return { phase: "locked", clearSnapshot: false, errorCode: null };
    case "identity/logged-out":
      return { phase: "unauthenticated", clearSnapshot: true, errorCode: null };
    case "identity/session-expired":
      return { phase: "unauthenticated", clearSnapshot: true, errorCode: "SESSION_EXPIRED" };
    case "identity/unlocked":
    case "identity/session-changed":
      return { phase: event.snapshot?.locked ? "locked" : "ready", clearSnapshot: false, errorCode: null };
    default:
      return { phase: null, clearSnapshot: false, errorCode: null };
  }
}
