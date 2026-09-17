/**
 * D3-01 · 头像选择器（首次初始化 / 系统设置共用）。
 *
 * 受控组件：它只把用户选中的 avatarRef 交回调用方，自己不持有"当前头像"，
 * 因此"选了什么"和"保存了什么"永远是两份不同的状态，不会互相覆盖。
 *
 * 两条来源：6 个内置预设，或从本机选一张图（居中裁 256×256、导 JPEG data URL）。
 * 读图 / 解码 / canvas 取不到 2D 上下文都在这里翻成人话错误，界面不崩。
 */
import { useRef, useState } from "react";
import { AVATAR_PRESET_IDS, Avatar } from "./Avatar";

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

export function AvatarPicker({
  avatarRef,
  onChange,
  disabled,
  idPrefix = "avatar",
}: {
  avatarRef: string | null;
  onChange: (avatarRef: string) => void;
  disabled?: boolean;
  /** data-d3-id 前缀：预设按钮是 prefix-<id>，上传 input 是 prefix-file。 */
  idPrefix?: string;
}) {
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

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
      onChange(dataUrl);
    } catch {
      // 解码 / canvas 取不到 2D 上下文都在这里兜住，界面不崩
      setLocalError("这张图片读取失败，换一张试试。");
    }
  };

  return (
    <>
      <div className="profile-presets" role="group" aria-label="预设头像">
        {AVATAR_PRESET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className="profile-preset"
            aria-pressed={avatarRef === "preset:" + id}
            aria-label={"预设头像 " + id}
            disabled={disabled}
            onClick={() => {
              setLocalError(null);
              onChange("preset:" + id);
            }}
            data-d3-id={idPrefix + "-" + id}
          >
            <Avatar avatarRef={"preset:" + id} name={null} />
          </button>
        ))}
      </div>
      <button
        type="button"
        className="profile-upload"
        disabled={disabled}
        onClick={() => fileInput.current?.click()}
      >
        从本机选择图片…
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={pickFile}
        data-d3-id={idPrefix + "-file"}
      />
      {localError ? (
        <p className="auth-error" role="alert">
          {localError}
        </p>
      ) : null}
    </>
  );
}
