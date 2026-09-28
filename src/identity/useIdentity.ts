/**
 * D3-01 · 渲染进程的身份钩子。
 *
 * **它不是身份状态。** 与 useDesktop 同一原则：
 * 这里只有"主进程权威的投影 + 命令派发"两件事，
 * 没有任何一处 `loggedIn` 布尔量活在 React 里 —— 那个变量一旦存在，
 * 就会变成第二份真相，而且一定是错的那一侧。
 *
 * 三条硬约束：
 *   1. **不得持久化任何凭据。** localStorage 里一个身份字段都不写（§11）。
 *      重启恢复只走 `identity/restore`，由主进程从 OS 受保护存储取 token。
 *   2. **所有组件消费同一份快照。** 禁止任何组件自己去读 localStorage 里的 user（§24）。
 *   3. **错误只认 code。** UI 分支一律 `switch (result.error)`，不解析文本（§26）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText, identityEventConvergence } from "./types";
import type { IdentityPhase, IdentitySnapshot, InstallationStatus } from "./types";

type Result = {
  ok?: boolean;
  error?: string;
  detail?: string;
  snapshot?: IdentitySnapshot;
  installation?: InstallationStatus;
  initialized?: boolean;
  initStatus?: string;
  userCount?: number;
  [k: string]: unknown;
};

const EMPTY: IdentitySnapshot = {
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
  initialized: false,
};

/**
 * 启动询问失败 → 一句人话。
 * `BOOT_FAILED` 的原因由主进程给出（schema 过新 / 钥匙串被拒 …），必须原样展示；
 * 其余错误码仍走集中文案，避免把内部枚举或异常文本直接糊给用户。
 */
function bootFailureText(result: Result): string {
  if (result.error === "BOOT_FAILED")
    return result.detail ? String(result.detail) : "身份服务启动失败，本机身份暂时无法使用。";
  return errorText(result.error, result.detail) || "身份服务启动失败，本机身份暂时无法使用。";
}

export function useIdentity() {
  const bridge = typeof window !== "undefined" ? window.openarc?.identity : undefined;
  const [phase, setPhase] = useState<IdentityPhase>(bridge ? "checking" : "unavailable");
  const [snapshot, setSnapshot] = useState<IdentitySnapshot>(EMPTY);
  const [installation, setInstallation] = useState<InstallationStatus | null>(null);
  const [error, setError] = useState<{ code: string; detail?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * 启动询问超时兜底：主进程若因为系统钥匙串授权而长时间不返回，
   * 渲染层**不能**永远停在 BootSurface 上（用户看到的就是"整个软件空白"）。
   * 超时后给一个可重试的界面。
   */
  const [bootError, setBootError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const send = useCallback(
    async (command: Record<string, unknown>): Promise<Result> => {
      if (!bridge) return { ok: false, error: "INVALID_INPUT", detail: "no-identity-bridge" };
      const res = (await bridge.command(command)) as Result;
      return res || { ok: false, error: "INTERNAL_ERROR" };
    },
    [bridge],
  );

  /** 把命令结果折进本地投影。**唯一的**写入口。 */
  const absorb = useCallback((res: Result, fallback: IdentityPhase) => {
    if (res.snapshot) setSnapshot(res.snapshot);
    if (res.installation) setInstallation(res.installation);
    if (res.ok === false) {
      setError({ code: String(res.error || "INTERNAL_ERROR"), detail: res.detail ? String(res.detail) : undefined });
      /**
       * **失败时只允许"降级或不动"，绝不允许升级。**
       *
       * 这条规则是 UI 探针抓出来的真实缺陷：早先失败时一律落到调用方给的
       * fallback，而 unlock 的 fallback 是 "ready" —— 于是"解锁输错口令"会
       * 把界面送回桌面，**等于口令错误也能解锁**。
       * 现在只有明确指向另一个门禁状态的错误码才允许迁移：
       *   NOT_INITIALIZED      → 未初始化
       *   LOCKED               → 锁屏
       *   SESSION_* / DISABLED → 登录页
       * 其余（口令错误、限流、输入不合法、内部错误）**保持当前状态**。
       */
      if (res.error === "NOT_INITIALIZED") setPhase("uninitialized");
      else if (res.error === "LOCKED") setPhase("locked");
      else if (["SESSION_EXPIRED", "SESSION_REVOKED", "USER_DISABLED"].includes(String(res.error))) setPhase("unauthenticated");
      return res;
    }
    setError(null);
    if (res.snapshot?.sessionRef) setPhase(res.snapshot.locked ? "locked" : "ready");
    else setPhase(fallback);
    return res;
  }, []);

  /**
   * 启动询问（§39）。
   *
   * 顺序是 `status` → `restore`：先确认这台机器有没有初始化，
   * 再尝试用 OS 受保护存储里的 token 恢复。**在这两步返回之前 phase 恒为
   * "checking"**，渲染层因此不可能先画出桌面再闪回登录。
   */
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    setBootError(null);
    const timer = window.setTimeout(() => {
      if (!cancelled) setBootError("本机身份确认超时：系统钥匙串可能在等待你的授权。授权后点「重试」。");
    }, 10000);
    (async () => {
      try {
        const st = await send({ type: "identity/status" });
        if (cancelled) return;
        // 身份服务没起来（schema 过新 / 钥匙串被拒 …）：**不能**继续往下落到登录页，
        // 更不能停在 BootSurface。走已有的 bootError → BootRetry。
        if (!st.ok) {
          setBootError(bootFailureText(st));
          return;
        }
        if (st.initialized === false) {
          setInstallation(st.installation as InstallationStatus);
          setPhase("uninitialized");
          return;
        }
        setInstallation(st.installation as InstallationStatus);
        const restore = await send({ type: "identity/restore" });
        if (cancelled) return;
        if (restore.ok && restore.snapshot) {
          setSnapshot(restore.snapshot);
          setPhase(restore.snapshot.locked ? "locked" : "ready");
        } else {
          setSnapshot(EMPTY);
          setPhase("unauthenticated");
        }
      } catch {
        // 主进程没响应 / 握手被拒：同样不能白屏。原超时兜底会因 finally 清掉计时器而失效。
        if (!cancelled) setBootError("身份服务没有响应，启动没有完成。可以点「重试」再试一次。");
      } finally {
        window.clearTimeout(timer);
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bridge, send, attempt]);

  /**
   * 主进程推来的身份事件（§24）：登出 / 锁定 / 解锁 / 会话变更 / 自然到期。
   *
   * 判定本身是纯函数（identityEventConvergence）；这里只做"写状态"。
   * 收敛不另起一套：自然到期与登出走同一条路 —— 清投影、回登录页，
   * 并按身份域真实的 SESSION_EXPIRED 走 absorb 的失败收敛（登录页给的就是那句规范文案；
   * 事件 payload 的 reason 属运维口径，不进用户文案）。
   */
  useEffect(() => {
    if (!bridge?.onEvent) return;
    return bridge.onEvent((event: { event: string; reason?: string; snapshot?: IdentitySnapshot | unknown }) => {
      if (!alive.current) return;
      const snap = event.snapshot as IdentitySnapshot | undefined;
      if (snap) setSnapshot(snap);
      const intent = identityEventConvergence({ event: event.event, snapshot: snap });
      if (intent.clearSnapshot) setSnapshot(EMPTY);
      if (intent.errorCode) {
        // 不带 detail：事件的 reason 是运维口径（连接日志 detail = expired:idle），进 absorb 会被 errorText 括注给用户
        absorb({ ok: false, error: intent.errorCode }, "unauthenticated");
        return;
      }
      if (intent.phase) setPhase(intent.phase);
    });
  }, [bridge, absorb]);

  const run = useCallback(
    async (command: Record<string, unknown>, fallback: IdentityPhase) => {
      setBusy(true);
      try {
        const res = await send(command);
        if (alive.current) absorb(res, fallback);
        return res;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [absorb, send],
  );

  const api = useMemo(
    () => ({
      phase,
      snapshot,
      installation,
      error,
      busy,
      bootError,
      available: !!bridge,
      /** 超时后重来一次启动询问（不再停在空白启动态）。 */
      retry: () => {
        setBootError(null);
        setPhase("checking");
        setAttempt((n) => n + 1);
      },
      initialize: (input: { identifier: string; password: string; displayName: string; avatarRef?: string }) =>
        run({ type: "identity/initialize", ...input }, "unauthenticated"),
      login: (input: { identifier: string; password: string }) => run({ type: "identity/login", ...input }, "unauthenticated"),
      logout: () => run({ type: "identity/logout" }, "unauthenticated"),
      lock: () => run({ type: "identity/lock" }, "locked"),
      unlock: (password: string) => run({ type: "identity/unlock", password }, "ready"),
      changePassword: (currentPassword: string, newPassword: string) =>
        run({ type: "identity/change-password", currentPassword, newPassword }, "unauthenticated"),
      /**
       * 改资料（显示名 / 头像）。**免密码，但必须有活跃 session**：
       * 服务层不再接受 identifier，也不再要求口令，所以这条命令只能从
       * 已登录（或锁定但 session 仍有效）的状态发起，不会把锁屏推回桌面。
       */
      updateProfile: (input: { displayName?: string; avatarRef?: string }) =>
        run({ type: "identity/update-profile", ...input }, phase === "locked" ? "locked" : "ready"),
    }),
    [phase, snapshot, installation, error, busy, bootError, bridge, run],
  );

  return api;
}

export type IdentityApi = ReturnType<typeof useIdentity>;
