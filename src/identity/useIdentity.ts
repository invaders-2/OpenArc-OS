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

export function useIdentity() {
  const bridge = typeof window !== "undefined" ? window.openarc?.identity : undefined;
  const [phase, setPhase] = useState<IdentityPhase>(bridge ? "checking" : "unavailable");
  const [snapshot, setSnapshot] = useState<IdentitySnapshot>(EMPTY);
  const [installation, setInstallation] = useState<InstallationStatus | null>(null);
  const [error, setError] = useState<{ code: string; detail?: string } | null>(null);
  const [busy, setBusy] = useState(false);
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
    (async () => {
      const st = await send({ type: "identity/status" });
      if (cancelled) return;
      if (st.ok && st.initialized === false) {
        setInstallation(st.installation as InstallationStatus);
        setPhase("uninitialized");
        return;
      }
      if (st.ok) setInstallation(st.installation as InstallationStatus);
      const restore = await send({ type: "identity/restore" });
      if (cancelled) return;
      if (restore.ok && restore.snapshot) {
        setSnapshot(restore.snapshot);
        setPhase(restore.snapshot.locked ? "locked" : "ready");
      } else {
        setSnapshot(EMPTY);
        setPhase("unauthenticated");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, send]);

  /** 主进程推来的身份事件（§24）：登出 / 锁定 / 解锁 / 会话变更。 */
  useEffect(() => {
    if (!bridge?.onEvent) return;
    return bridge.onEvent((event: { event: string; snapshot?: IdentitySnapshot | unknown }) => {
      if (!alive.current) return;
      const snap = event.snapshot as IdentitySnapshot | undefined;
      if (snap) setSnapshot(snap);
      switch (event.event) {
        case "identity/locked":
          setPhase("locked");
          break;
        case "identity/logged-out":
          setSnapshot(EMPTY);
          setPhase("unauthenticated");
          break;
        case "identity/unlocked":
        case "identity/session-changed":
          setPhase(snap?.locked ? "locked" : "ready");
          break;
        default:
          break;
      }
    });
  }, [bridge]);

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
      available: !!bridge,
      initialize: (input: { identifier: string; password: string; displayName: string }) =>
        run({ type: "identity/initialize", ...input }, "unauthenticated"),
      login: (input: { identifier: string; password: string }) => run({ type: "identity/login", ...input }, "unauthenticated"),
      logout: () => run({ type: "identity/logout" }, "unauthenticated"),
      lock: () => run({ type: "identity/lock" }, "locked"),
      unlock: (password: string) => run({ type: "identity/unlock", password }, "ready"),
      changePassword: (currentPassword: string, newPassword: string) =>
        run({ type: "identity/change-password", currentPassword, newPassword }, "unauthenticated"),
    }),
    [phase, snapshot, installation, error, busy, bridge, run],
  );

  return api;
}

export type IdentityApi = ReturnType<typeof useIdentity>;
