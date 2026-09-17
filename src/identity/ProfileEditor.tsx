/**
 * D3-01 · 资料编辑面板（登录页 / 锁屏共用）。
 *
 * 为什么不做成桌面 Dialog：登录与锁屏本身就是整个门禁的覆盖层，
 * 再叠一层全局 Dialog 会把"门禁层序"与"桌面浮层"搅在一起。
 * 这里只做 .lock-stage 内部的一张自有覆盖层，层序与锁屏一致。
 *
 * 面板是受控草稿：名字 / 头像 / 账号都先留在本地，保存时只交"确实改动过"的字段 ——
 * 主进程按 undefined 区分"不改"，一旦传了就一定会被写成新值。
 */
import { useEffect, useRef, useState } from "react";
import { errorText } from "./types";
import { AVATAR_PRESET_IDS, Avatar, PRESET_NODES } from "./Avatar";

type ProfileDraft = { password: string; displayName?: string; avatarRef?: string; identifier?: string };

type ProfileEditorProps = {
  mode: "lock" | "login";
  identifier: string;
  displayName: string | null;
  avatarRef: string | null;
  busy: boolean;
  error: { code: string; detail?: string } | null;
  onSubmit: (input: ProfileDraft) => Promise<unknown>;
  onClose: () => void;
};

const AVATAR_SIZE = 256;
const JPEG_QUALITY = 0.85;
/** 与主进程 identity-domain.cjs 的 MAX_AVATAR_REF_LENGTH 同一个上限。 */
const MAX_AVATAR_REF_LENGTH = 400000;

/**
 * 把本机图片居中裁成正方形，导出一个 JPEG data URL。
 * 只做"缩放 + 居中裁切 + 压缩"，不改像素内容；任何一步失败都抛出去，
 * 由调用方翻成人话 —— 这里不给用户看英文异常。
 */
function fileToAvatarDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        if (!img.naturalWidth || !img.naturalHeight) throw new Error("empty-image");
        const canvas = document.createElement("canvas");
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no-2d-context");
        // 长边铺满 256，短边留白由居中偏移吃掉 —— 超出画布的部分自然被裁掉。
        const scale = Math.max(AVATAR_SIZE / img.naturalWidth, AVATAR_SIZE / img.naturalHeight);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        ctx.drawImage(img, (AVATAR_SIZE - w) / 2, (AVATAR_SIZE - h) / 2, w, h);
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode-failed"));
    };
    img.src = url;
  });
}

export function ProfileEditor({ mode, identifier, displayName, avatarRef, busy, error, onSubmit, onClose }: ProfileEditorProps) {
  // lock 预填当前显示名；login 没有 session，按约定留空，只有用户主动填写才提交。
  const [name, setName] = useState(mode === "lock" ? displayName ?? "" : "");
  const [avatar, setAvatar] = useState<string | null>(avatarRef);
  const [account, setAccount] = useState(identifier);
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const card = useRef<HTMLFormElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    passwordInput.current?.focus();
  }, []);

  // 显示名不允许为空（主进程 validateDisplayName 会拒），所以"清空"不算改动。
  const nameChanged = name.trim().length > 0 && name.trim() !== (displayName ?? "");
  const avatarChanged = avatar !== null && avatar !== (avatarRef ?? null);
  const accountChanged = mode === "login" && account.trim() !== identifier.trim();
  /**
   * login 模式没有 session，账号是定位目标用户的唯一线索：没有账号就无法保存。
   * 把它放进禁用条件，避免明知必败还打一次主进程。
   */
  const canSubmit =
    !busy &&
    password.length > 0 &&
    (mode === "lock" || account.trim().length > 0) &&
    (nameChanged || avatarChanged || accountChanged);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLocalError(null);
    const input: ProfileDraft = { password };
    if (nameChanged) input.displayName = name.trim();
    if (avatarChanged && avatar) input.avatarRef = avatar;
    if (accountChanged) input.identifier = account.trim();
    await onSubmit(input);
  };

  const pickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // 清掉 value：同一个文件连选两次也要再触发一次 change
    e.target.value = "";
    if (!file) return;
    setLocalError(null);
    if (!file.type.startsWith("image/")) {
      setLocalError("请选择图片文件（PNG / JPEG / WebP）。");
      return;
    }
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      if (dataUrl.length > MAX_AVATAR_REF_LENGTH) {
        setLocalError("图片处理后仍然过大，换一张更小的试试。");
        return;
      }
      setAvatar(dataUrl);
    } catch {
      // 解码 / canvas 取不到 2D 上下文都在这里兜住，界面不崩
      setLocalError("这张图片读取失败，换一张试试。");
    }
  };

  /** 与锁屏同一套首尾循环：Tab / Shift+Tab 只在面板内打转，Esc 关闭。 */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = Array.from(card.current?.querySelectorAll<HTMLElement>("button, input") || []).filter(
      (el) => !el.hasAttribute("disabled") && el.getAttribute("type") !== "file",
    );
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
  };

  // 本地错误优先：它是用户刚刚这一步的反馈；否则沿用身份域返回的错误码。
  const shown = localError ? { code: "", detail: localError } : error;

  return (
    <div className="profile-sheet" data-d3-id="profile-sheet" onKeyDown={onKeyDown}>
      <form className="profile-card" ref={card} role="dialog" aria-modal="true" aria-label="修改资料" onSubmit={submit}>
        <strong className="profile-title">修改资料</strong>
        <div className="profile-avatar">
          <Avatar avatarRef={avatar} name={name || displayName} />
        </div>
        <div className="profile-presets" role="group" aria-label="预设头像">
          {AVATAR_PRESET_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className="profile-preset"
              aria-pressed={avatar === "preset:" + id}
              aria-label={"预设头像 " + id}
              onClick={() => {
                setLocalError(null);
                setAvatar("preset:" + id);
              }}
            >
              <svg className="avatar-preset" viewBox="0 0 24 24" aria-hidden="true">
                {PRESET_NODES[id]}
              </svg>
            </button>
          ))}
        </div>
        <button type="button" className="profile-upload" onClick={() => fileInput.current?.click()}>
          从本机选择图片…
        </button>
        <input ref={fileInput} type="file" accept="image/*" hidden onChange={pickFile} data-d3-id="profile-file" />
        {mode === "lock" ? (
          <div className="profile-account">
            <span className="muted">账号</span>
            <span>{identifier}</span>
          </div>
        ) : (
          <label className="field">
            账号
            <input
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="账号"
              autoComplete="username"
              data-d3-id="profile-identifier"
            />
          </label>
        )}
        <label className="field">
          用户名
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={mode === "lock" ? "显示名" : "新的用户名（不改可不填）"}
            autoComplete="off"
            data-d3-id="profile-name"
          />
        </label>
        <label className="field">
          密码
          <input
            ref={passwordInput}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="输入密码以确认修改"
            autoComplete="current-password"
            data-d3-id="profile-password"
          />
        </label>
        <p className="profile-hint">修改资料需要验证密码</p>
        {shown ? (
          <p className="auth-error" role="alert" data-d3-id="profile-error">
            {errorText(shown.code, shown.detail)}
          </p>
        ) : null}
        <div className="profile-actions">
          <button type="button" className="ghost" disabled={busy} onClick={onClose} data-d3-id="profile-cancel">
            取消
          </button>
          <button type="submit" className="primary" disabled={!canSubmit} data-d3-id="profile-save">
            {busy ? "正在保存…" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}
