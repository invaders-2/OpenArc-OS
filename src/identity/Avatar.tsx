/**
 * D3-01 · 头像。
 *
 * 只负责"画"：把 avatarRef 的三种形态变成节点。**不校验合法性** ——
 * 校验的权威在主进程 electron/identity-domain.cjs，界面照单渲染即可。
 *
 * 外层容器（`className` 落点）只负责填满调用方并居中，**不设背景、不设固定尺寸**：
 * 64px 的大头像与 44px 的预设小圆共用同一个组件，尺寸与圆由调用方的 class 决定。
 */
import type { ReactNode } from "react";

/**
 * **必须与 electron/identity-domain.cjs 的 AVATAR_PRESETS 一致。**
 * 两处一旦漂移，界面能选中的预设会被主进程判成 INVALID_INPUT。
 */
export const AVATAR_PRESET_IDS = ["arc", "orbit", "wave", "grid", "sun", "moon"] as const;

export type AvatarPresetId = (typeof AVATAR_PRESET_IDS)[number];

const PRESET_ID_SET = new Set<string>(AVATAR_PRESET_IDS);

/**
 * 每个 id 一个 24×24 视口内的几何图形，全部用 currentColor：
 * 头像永远落在单色体系里，不引入任何颜色，也不随预设换色。
 */
export const PRESET_NODES: Record<AvatarPresetId, ReactNode> = {
  arc: (
    <path d="M4.5 16.5a7.5 7.5 0 0 1 15 0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
  ),
  orbit: (
    <>
      <circle cx="12" cy="12" r="3.1" fill="currentColor" />
      <ellipse
        cx="12"
        cy="12"
        rx="9"
        ry="4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        transform="rotate(-28 12 12)"
      />
    </>
  ),
  wave: (
    <path
      d="M3 13.5c2.4 0 2.4-4.5 4.8-4.5s2.4 4.5 4.8 4.5 2.4-4.5 4.8-4.5 2.4 4.5 4.8 4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  grid: (
    <>
      <rect x="4.4" y="4.4" width="6.4" height="6.4" rx="1.6" fill="currentColor" />
      <rect x="13.2" y="4.4" width="6.4" height="6.4" rx="1.6" fill="currentColor" opacity="0.55" />
      <rect x="4.4" y="13.2" width="6.4" height="6.4" rx="1.6" fill="currentColor" opacity="0.55" />
      <rect x="13.2" y="13.2" width="6.4" height="6.4" rx="1.6" fill="currentColor" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4.2" fill="currentColor" />
      <circle
        cx="12"
        cy="12"
        r="8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeDasharray="1.5 4.7"
      />
    </>
  ),
  moon: (
    <path d="M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8Z" fill="currentColor" />
  ),
};

/**
 * 头像。三种形态的判定顺序与主进程一致：
 *   data:…  → 位图；preset:<白名单 id> → 内联单色图形；其余（含 null / 未知 preset）→ 显示名首字母。
 */
export function Avatar({
  avatarRef,
  name,
  className,
}: {
  avatarRef: string | null;
  name: string | null;
  className?: string;
}) {
  const wrap = "avatar" + (className ? " " + className : "");

  if (avatarRef && avatarRef.startsWith("data:")) {
    return (
      <span className={wrap}>
        <img className="avatar-img" src={avatarRef} alt="" draggable={false} />
      </span>
    );
  }

  const preset = avatarRef && avatarRef.startsWith("preset:") ? avatarRef.slice("preset:".length) : "";
  if (PRESET_ID_SET.has(preset)) {
    return (
      <span className={wrap}>
        <svg className="avatar-preset" viewBox="0 0 24 24" aria-hidden="true">
          {PRESET_NODES[preset as AvatarPresetId]}
        </svg>
      </span>
    );
  }

  // 没有可用头像时给首字母；连名字都没有才退到 "?"，绝不画一个空白圆。
  const initial = (name ?? "").trim().slice(0, 1).toUpperCase() || "?";
  return <span className={wrap}>{initial}</span>;
}
