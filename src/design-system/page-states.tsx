/**
 * OpenArc Design System v1 — Page State Spec
 *
 * D2-01 **只建立规范与组件契约，不实现完整业务页面**。
 *
 * 七种状态：Empty / Loading / Error / Unauthorized / Offline / Unavailable /
 *          Partial Result
 *
 * ⚠ Unauthorized 的**真实权限判定依赖 D3-02**。本轮冻结的只有视觉与组件契约
 *   （什么时候显示、显示什么、给谁看），**不接任何权限逻辑**，也不得声称
 *   权限已经接通。在 D3-02 完成前，Unauthorized 只能由显式传入的 kind 触发，
 *   不允许由任何"当前用户是谁"的判断自动推出。
 *
 * 状态选取规则（页面实现时按此判定，不允许自己发明第八种）：
 *   Empty         已成功拿到结果，但结果集为空
 *   Loading       仍在等待**首屏**数据；局部刷新不要用它，用局部骨架
 *   Error         请求失败且**可重试**（给重试按钮）
 *   Unauthorized  身份或对象权限不足（D3-02 后才能真实判定）
 *   Offline       网络不可达；**与 Error 的区别是可自动恢复**，所以不给重试按钮，给"重新连接"
 *   Unavailable   功能在当前环境不可用（平台不支持 / 能力未就绪 / 被策略关闭）
 *   PartialResult 部分成功：有数据可用，但**有明确的缺失项**要告知
 */
import React from "react";
import { Button } from "./primitives";

export type PageStateKind =
  | "empty"
  | "loading"
  | "error"
  | "unauthorized"
  | "offline"
  | "unavailable"
  | "partial-result";

/** 每种状态的**默认语义**：由谁触发、有没有可执行动作、屏幕阅读器怎么播报。 */
export const PAGE_STATE_SPEC: Record<
  PageStateKind,
  {
    role: "status" | "alert";
    live: "polite" | "assertive";
    action: "none" | "retry" | "reconnect" | "signin" | "dismiss";
    /** 是否允许在没有真实失败原因时使用（防止拿 Error 当万用兜底） */
    requiresCause: boolean;
  }
> = {
  empty: { role: "status", live: "polite", action: "none", requiresCause: false },
  loading: { role: "status", live: "polite", action: "none", requiresCause: false },
  error: { role: "alert", live: "assertive", action: "retry", requiresCause: true },
  unauthorized: { role: "alert", live: "assertive", action: "signin", requiresCause: true },
  offline: { role: "status", live: "polite", action: "reconnect", requiresCause: false },
  unavailable: { role: "status", live: "polite", action: "none", requiresCause: false },
  "partial-result": { role: "status", live: "polite", action: "retry", requiresCause: true },
};

export function PageState({
  kind,
  title,
  description,
  /** 缺失项清单（partial-result 必填；也是它存在的理由） */
  missing,
  onAction,
  actionLabel,
  /** 覆盖默认动作文案；语义由 PAGE_STATE_SPEC[kind].action 决定 */
  className,
}: {
  kind: PageStateKind;
  title: string;
  description?: string;
  missing?: string[];
  onAction?: () => void;
  actionLabel?: string;
  className?: string;
}) {
  const spec = PAGE_STATE_SPEC[kind];
  const defaultLabel: Record<typeof spec.action, string | undefined> = {
    none: undefined,
    retry: "重试",
    reconnect: "重新连接",
    signin: "去登录",
    dismiss: "知道了",
  };
  const showAction = spec.action !== "none" && Boolean(onAction);
  return (
    <div
      className={["ds-page-state", `ds-page-state--${kind}`, className]
        .filter(Boolean)
        .join(" ")}
      role={spec.role}
      aria-live={spec.live}
      data-ds-comp="page-state"
      data-ds-kind={kind}
    >
      <span className="ds-page-state__glyph" aria-hidden="true">
        {GLYPH[kind]}
      </span>
      <p className="ds-page-state__title">{title}</p>
      {description ? <p className="ds-page-state__desc">{description}</p> : null}
      {kind === "loading" ? (
        <span className="ds-spinner" aria-hidden="true" />
      ) : null}
      {missing?.length ? (
        <ul className="ds-page-state__missing">
          {missing.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
      {showAction ? (
        <Button variant="secondary" onClick={onAction}>
          {actionLabel ?? defaultLabel[spec.action]}
        </Button>
      ) : null}
    </div>
  );
}

const GLYPH: Record<PageStateKind, string> = {
  empty: "◌",
  loading: "◌",
  error: "!",
  unauthorized: "⌾",
  offline: "⊘",
  unavailable: "—",
  "partial-result": "◐",
};
