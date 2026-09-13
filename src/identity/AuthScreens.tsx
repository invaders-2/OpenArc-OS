/**
 * D3-01 · 身份界面：首次初始化 / 登录 / 锁屏 / 启动态。
 *
 * 三条纪律：
 *   1. **按钮不切页面。** 每个动作都派发真实领域命令，界面只是结果的投影（§36）。
 *      命令返回 `{ ok: false, error }` 时显示错误码对应的人话，不本地伪造成功。
 *   2. **错误只认 code。** 一律 `errorText(result.error)`，不解析异常文本（§26）。
 *   3. **锁屏是最上层。** 它由 main.tsx 渲染在桌面之上，并把桌面整块 `inert`；
 *      原生网页视图的让位由 `useDesktop({ locked })` 的 overlayOpen 完成（§15 / §40）。
 */
import { useEffect, useRef, useState } from "react";
import { errorText } from "./types";
import type { IdentitySnapshot } from "./types";

type AuthError = { code: string; detail?: string } | null;

function AuthErrorLine({ error }: { error: AuthError }) {
  if (!error) return null;
  return (
    <p className="auth-error" role="alert" data-d3-id="auth-error">
      {errorText(error.code, error.detail)}
    </p>
  );
}

/** 共用的外框：全屏居中、与桌面同一套玻璃语言。 */
function AuthShell({ eyebrow, title, subtitle, children }: { eyebrow: string; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="auth-screen" data-d3-id="auth-screen">
      <div className="auth-card" role="main">
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p className="subtitle">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

// ===========================================================================
// 启动态（§39：恢复结果出来之前不允许出现任何桌面内容）
// ===========================================================================

export function BootSurface() {
  return (
    <div className="auth-screen" data-d3-id="boot-surface" aria-busy="true">
      <div className="auth-boot">
        <span className="brand-logo brand-logo-lg" role="img" aria-label="OpenArc OS" />
        <span className="muted">正在确认本机身份…</span>
      </div>
    </div>
  );
}

/**
 * 启动超时兜底：**绝不让界面空白**。
 * 主进程若卡在系统钥匙串授权上，这里给一句人话 + 一个重试入口。
 */
export function BootRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="auth-screen" data-d3-id="boot-retry">
      <div className="auth-boot">
        <span className="brand-logo brand-logo-lg" role="img" aria-label="OpenArc OS" />
        <span className="muted">{message}</span>
        <button className="control-button" onClick={onRetry}>
          重试
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// First-run Initialization（§6 / §38）
// ===========================================================================

type SetupProps = {
  busy: boolean;
  error: AuthError;
  defaultIdentifier?: string;
  onSubmit: (input: { identifier: string; password: string; displayName: string }) => Promise<unknown>;
};

export function SetupScreen({ busy, error, defaultIdentifier = "", onSubmit }: SetupProps) {
  const [identifier, setIdentifier] = useState(defaultIdentifier);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, []);

  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocal(null);
    if (password !== confirm) {
      setLocal("INVALID_INPUT");
      return;
    }
    await onSubmit({ identifier, password, displayName });
  };

  return (
    <AuthShell
      eyebrow="FIRST RUN"
      title="初始化这台机器"
      subtitle="创建本机的第一个管理员。初始化只能成功一次。"
    >
      <form onSubmit={submit} data-d3-id="setup-form">
        <label className="field">
          管理员显示名
          <input
            ref={first}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="例如：Weping"
            autoComplete="off"
            data-d3-id="setup-name"
          />
        </label>
        <label className="field">
          登录标识符
          <input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="name@openarc.local"
            autoComplete="username"
            data-d3-id="setup-identifier"
          />
        </label>
        <label className="field">
          口令
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 8 位"
            autoComplete="new-password"
            data-d3-id="setup-password"
          />
        </label>
        <label className="field">
          确认口令
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="再输入一次"
            autoComplete="new-password"
            data-d3-id="setup-confirm"
          />
        </label>
        <AuthErrorLine error={local ? { code: local, detail: "password-mismatch" } : error} />
        <div className="auth-actions">
          <button className="primary" type="submit" disabled={busy || !identifier || !displayName || !password} data-d3-id="setup-submit">
            {busy ? "正在初始化…" : "创建管理员"}
          </button>
        </div>
        <p className="footnote">
          口令使用 scrypt 派生后存储，明文不落盘、不进入界面状态。初始化成功后需再用该口令登录一次。
        </p>
      </form>
    </AuthShell>
  );
}

// ===========================================================================
// Login（§12）
// ===========================================================================

type LoginProps = {
  busy: boolean;
  error: AuthError;
  defaultIdentifier?: string;
  onSubmit: (input: { identifier: string; password: string }) => Promise<unknown>;
};

export function LoginScreen({ busy, error, defaultIdentifier = "", onSubmit }: LoginProps) {
  const [identifier, setIdentifier] = useState(defaultIdentifier);
  const [password, setPassword] = useState("");
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, []);

  return (
    <AuthShell eyebrow="SIGN IN" title="登录 OpenArc" subtitle="使用初始化时创建的管理员凭据。">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await onSubmit({ identifier, password });
        }}
        data-d3-id="login-form"
      >
        <label className="field">
          登录标识符
          <input
            ref={first}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            autoComplete="username"
            data-d3-id="login-identifier"
          />
        </label>
        <label className="field">
          口令
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            data-d3-id="login-password"
          />
        </label>
        <AuthErrorLine error={error} />
        <div className="auth-actions">
          <button className="primary" type="submit" disabled={busy || !identifier || !password} data-d3-id="login-submit">
            {busy ? "正在验证…" : "登录"}
          </button>
        </div>
        <p className="footnote">标识符不存在与口令错误返回同一个错误，不透露账号是否存在。</p>
      </form>
    </AuthShell>
  );
}

// ===========================================================================
// Lock Screen（§15 / §16）
// ===========================================================================

type LockProps = {
  snapshot: IdentitySnapshot;
  busy: boolean;
  error: AuthError;
  onUnlock: (password: string) => Promise<unknown>;
  onLogout: () => Promise<unknown>;
};

/**
 * 锁屏。
 *
 * 它是**覆盖层**，不是页面：桌面 DOM 仍在（窗口状态得以保留，§40），
 * 但被 `inert` 挡住，且原生视图已通过 overlayOpen 隐藏。
 * 焦点陷阱与搜索面板用同一套"首尾循环"实现，不引入第三个焦点方案。
 */
export function LockScreen({ snapshot, busy, error, onUnlock, onLogout }: LockProps) {
  const [password, setPassword] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  return (
    <div className="lock-shade" data-d3-id="lock-shade">
      <div className="lock-panel" ref={panel} role="dialog" aria-modal="true" aria-label="屏幕已锁定">
        <div className="lock-avatar" aria-hidden="true">
          {(snapshot.displayName || "?").slice(0, 1).toUpperCase()}
        </div>
        <strong className="lock-name">{snapshot.displayName || "本地用户"}</strong>
        <span className="muted">{snapshot.identifier}</span>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const value = password;
            setPassword("");
            await onUnlock(value);
          }}
          data-d3-id="unlock-form"
        >
          <label className="field">
            口令
            <input
              ref={input}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="输入口令以解锁"
              data-d3-id="unlock-password"
              onKeyDown={(e) => {
                if (e.key !== "Tab") return;
                const items = Array.from(panel.current?.querySelectorAll<HTMLElement>("button,input") || []);
                if (!items.length) return;
                const firstEl = items[0];
                const lastEl = items[items.length - 1];
                if (e.shiftKey && document.activeElement === firstEl) {
                  e.preventDefault();
                  lastEl.focus();
                } else if (!e.shiftKey && document.activeElement === lastEl) {
                  e.preventDefault();
                  firstEl.focus();
                }
              }}
            />
          </label>
          <AuthErrorLine error={error} />
          <div className="auth-actions">
            <button className="primary" type="submit" disabled={busy || !password} data-d3-id="unlock-submit">
              {busy ? "正在验证…" : "解锁"}
            </button>
            <button className="ghost" type="button" disabled={busy} onClick={() => void onLogout()} data-d3-id="lock-logout">
              退出登录
            </button>
          </div>
        </form>
        <p className="footnote">
          锁定不等于退出登录：会话仍然有效，但受保护的操作会被拒绝，必须重新验证口令。
        </p>
      </div>
    </div>
  );
}
