/**
 * OpenArc Design System v1 — P0 Primitives
 *
 * 设计原则（三条，别绕开）：
 *  1. **状态必须显式**。每个交互组件都覆盖 default / hover / active /
 *     focus-visible / disabled；输入类另有 empty / filled / error / readonly；
 *     异步类另有 idle / loading / success / error。只设计默认态视为未完成。
 *  2. **样式只来自 token**。本文件不写任何颜色 / 圆角 / 时长的字面值，
 *     全部走 CSS 类 → `primitives.css` → `tokens.css`。
 *  3. **可访问性与视觉同等重要**。focus-visible 可见、Esc 可退、键盘可达、
 *     ARIA 正确、屏幕阅读器能播报。这些是契约，不是加分项。
 *
 * 组件契约（API 稳定性）与状态对照表见
 * `docs/decisions/D2-01-design-system.md`。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

export type Status = "idle" | "loading" | "success" | "error";
export type Tone = "neutral" | "success" | "warning" | "danger";

const cx = (...v: Array<string | false | null | undefined>) =>
  v.filter(Boolean).join(" ");

/* ══════════════════════════════════════════════════════════════════════════
   Button
   ──────────────────────────────────────────────────────────────────────────
   variant: primary | secondary | ghost | danger
   size:    sm | md
   status:  idle | loading | success | error
   契约：loading 时 `aria-busy`，且**不触发 onClick**；disabled 时 `disabled`
   与 `aria-disabled` 同时成立（防"看起来禁用但仍可点"）。
   ══════════════════════════════════════════════════════════════════════════ */
export function Button({
  variant = "secondary",
  size = "md",
  status = "idle",
  disabled,
  full,
  iconStart,
  iconEnd,
  type = "button",
  className,
  children,
  onClick,
  ...rest
}: {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  status?: Status;
  full?: boolean;
  iconStart?: React.ReactNode;
  iconEnd?: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const busy = status === "loading";
  const off = disabled || busy;
  return (
    <button
      {...rest}
      type={type}
      className={cx(
        "ds-btn",
        `ds-btn--${variant}`,
        `ds-btn--${size}`,
        full && "ds-btn--full",
        className,
      )}
      data-ds-comp="button"
      data-ds-variant={variant}
      data-ds-status={status}
      disabled={off}
      aria-disabled={off || undefined}
      aria-busy={busy || undefined}
      onClick={off ? undefined : onClick}
    >
      {busy ? <span className="ds-spinner" aria-hidden="true" /> : iconStart}
      <span className="ds-btn__label">{children}</span>
      {iconEnd}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   IconButton
   ──────────────────────────────────────────────────────────────────────────
   纯图标按钮**必须**给 `label`（写进 aria-label；没有可见文本时这是唯一可读名）。
   `pressed` 存在时渲染为 toggle（aria-pressed）。
   ══════════════════════════════════════════════════════════════════════════ */
export function IconButton({
  label,
  variant = "ghost",
  size = "md",
  pressed,
  status = "idle",
  disabled,
  className,
  children,
  onClick,
  ...rest
}: {
  label: string;
  variant?: "ghost" | "secondary" | "primary" | "danger";
  size?: "sm" | "md";
  pressed?: boolean;
  status?: Status;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label">) {
  const busy = status === "loading";
  const off = disabled || busy;
  return (
    <button
      {...rest}
      type="button"
      className={cx(
        "ds-iconbtn",
        `ds-iconbtn--${variant}`,
        `ds-iconbtn--${size}`,
        pressed && "is-pressed",
        className,
      )}
      data-ds-comp="icon-button"
      data-ds-variant={variant}
      data-ds-status={status}
      aria-label={label}
      aria-pressed={typeof pressed === "boolean" ? pressed : undefined}
      aria-busy={busy || undefined}
      disabled={off}
      aria-disabled={off || undefined}
      onClick={off ? undefined : onClick}
    >
      {busy ? <span className="ds-spinner" aria-hidden="true" /> : children}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   TextField  （D1-04 遗留的 PARTIAL，本轮正式组件化）
   ──────────────────────────────────────────────────────────────────────────
   状态覆盖：empty / filled / error / readonly / disabled ×
            idle / loading / success / error
   可访问性：label 恒有（无可见标签时用 sr-only）；hint 与 error 都进
            aria-describedby；错误用 role=alert 播报；error 与 readonly 互斥。
   ══════════════════════════════════════════════════════════════════════════ */
export function TextField({
  label,
  hint,
  error,
  status = "idle",
  readOnly,
  disabled,
  required,
  id,
  className,
  prefix,
  suffix,
  /** 不渲染可见标签，但仍为屏幕阅读器保留（工具栏内联输入用） */
  labelHidden,
  ...rest
}: {
  label: string;
  hint?: string;
  error?: string;
  status?: Status;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  labelHidden?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "prefix">) {
  const auto = useId();
  const inputId = id ?? `ds-tf-${auto}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errId = error ? `${inputId}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  const invalid = Boolean(error) || status === "error";
  return (
    <div
      className={cx("ds-field", className)}
      data-ds-comp="text-field"
      data-ds-status={invalid ? "error" : status}
      data-ds-readonly={readOnly ? "true" : undefined}
    >
      <label
        className={cx("ds-field__label", labelHidden && "ds-field__label--sr")}
        htmlFor={inputId}
      >
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <div className="ds-field__box">
        {prefix ? <span className="ds-field__affix">{prefix}</span> : null}
        <input
          {...rest}
          id={inputId}
          className="ds-field__input"
          readOnly={readOnly}
          disabled={disabled}
          required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          aria-busy={status === "loading" || undefined}
        />
        {status === "loading" ? <span className="ds-spinner" aria-hidden="true" /> : null}
        {status === "success" && !invalid ? (
          <span className="ds-field__flag ds-field__flag--ok" aria-hidden="true">
            ✓
          </span>
        ) : null}
        {suffix ? <span className="ds-field__affix">{suffix}</span> : null}
      </div>
      {hint ? (
        <p className="ds-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="ds-field__error" id={errId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   SearchField
   ──────────────────────────────────────────────────────────────────────────
   TextField 的语义特化：`type="search"`、内建清除键、可选快捷键提示。
   Esc 只清除内容并**不**吞掉事件（外层面板仍能用 Esc 关闭自己）。
   ══════════════════════════════════════════════════════════════════════════ */
export function SearchField({
  value,
  onValueChange,
  onClear,
  placeholder = "搜索",
  kbd,
  label = "搜索",
  ...rest
}: {
  value: string;
  onValueChange: (v: string) => void;
  onClear?: () => void;
  kbd?: string;
  /** 屏幕阅读器用的名称（视觉上不渲染 label，与产品搜索框一致） */
  label?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <div className="ds-search" data-ds-comp="search-field">
      <span className="ds-search__icon" aria-hidden="true">
        ⌕
      </span>
      <input
        {...rest}
        type="search"
        className="ds-search__input"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onValueChange("");
            onClear?.();
          }
        }}
      />
      {value ? (
        <IconButton label="清除搜索" size="sm" onClick={() => { onValueChange(""); onClear?.(); }}>
          ×
        </IconButton>
      ) : kbd ? (
        <kbd className="ds-kbd">{kbd}</kbd>
      ) : null}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Tooltip  （D1-04 遗留的 PARTIAL，本轮正式组件化）
   ──────────────────────────────────────────────────────────────────────────
   三件事必须同时成立，缺一不算完成：
     ① hover 显示 ② **键盘 focus 显示**（纯 hover 的 tooltip 对键盘用户不存在）
     ③ `aria-describedby` 真的指到它（否则屏幕阅读器读不到）
   鼠标移开后**立刻**隐藏；键盘 blur 也立刻隐藏（不做延迟，避免"幽灵提示"）。
   ══════════════════════════════════════════════════════════════════════════ */
export function Tooltip({
  content,
  placement = "top",
  children,
  id,
  disabled,
}: {
  content: React.ReactNode;
  placement?: "top" | "bottom" | "left" | "right";
  children: React.ReactElement;
  id?: string;
  disabled?: boolean;
}) {
  const auto = useId();
  const tipId = id ?? `ds-tip-${auto}`;
  const [open, setOpen] = useState(false);
  const show = () => {
    if (!disabled) setOpen(true);
  };
  const hide = () => setOpen(false);
  const child = React.Children.only(children) as React.ReactElement<{
    "aria-describedby"?: string;
  }>;
  return (
    <span
      className="ds-tip-wrap"
      data-ds-comp="tooltip"
      data-ds-open={open ? "true" : "false"}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {React.cloneElement(child, { "aria-describedby": open ? tipId : undefined })}
      <span
        id={tipId}
        role="tooltip"
        className={cx("ds-tip", `ds-tip--${placement}`)}
        aria-hidden={open ? undefined : true}
      >
        {content}
      </span>
    </span>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Badge / ScrollArea / Surface
   ──────────────────────────────────────────────────────────────────────────
   三者都是**非交互**容器语义，但边界必须清楚：
     Badge      状态标签。tone 只允许系统语义色，**不许引入品牌彩色**。
     ScrollArea 统一滚动条外观与键盘可达（可聚焦，方向键可滚）。
     Surface    材质容器。material 决定用玻璃还是实色，level 决定 elevation。
   ══════════════════════════════════════════════════════════════════════════ */
export function Badge({
  tone = "neutral",
  size = "md",
  children,
  className,
}: {
  tone?: Tone;
  size?: "sm" | "md";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx("ds-badge", `ds-badge--${tone}`, `ds-badge--${size}`, className)}
      data-ds-comp="badge"
      data-ds-tone={tone}
    >
      {children}
    </span>
  );
}

export function ScrollArea({
  children,
  maxHeight,
  label = "可滚动区域",
  className,
}: {
  children: React.ReactNode;
  maxHeight?: number | string;
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cx("ds-scroll", className)}
      data-ds-comp="scroll-area"
      style={maxHeight ? { maxHeight } : undefined}
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {children}
    </div>
  );
}

export function Surface({
  material = "glass",
  level = 2,
  radius = "lg",
  padded,
  large,
  as: Tag = "div",
  className,
  children,
  ...rest
}: {
  material?: "glass" | "solid" | "none";
  level?: 0 | 1 | 2 | 3 | 4 | 5;
  radius?: "sm" | "md" | "lg" | "xl" | "window";
  padded?: boolean;
  /** 显式声明"大面积表面"，使本面参与 REDUCED 档的减面积白名单。
   *  只有窗口 / 面板级表面才该打开；小卡片打开会在 REDUCED 下变实色。 */
  large?: boolean;
  as?: keyof React.JSX.IntrinsicElements;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    // @ts-expect-error 动态标签在类型上无法收窄，运行时只接受已知标签
    <Tag
      {...rest}
      className={cx(
        "ds-surface",
        `ds-surface--${material}`,
        `ds-surface--elev-${level}`,
        `ds-surface--r-${radius}`,
        padded && "ds-surface--padded",
        large && "ds-surface--large",
        className,
      )}
      data-ds-comp="surface"
      data-ds-material={material}
      data-ds-level={level}
      data-ds-large={large ? "1" : "0"}
    >
      {children}
    </Tag>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Toast / Notification Primitive
   ──────────────────────────────────────────────────────────────────────────
   D1-04 里 Toast = MISSING。本轮只建立**设计系统层能力**，
   不做完整 Notification Center（不持久化、不做历史、不做分组）。

   kind:   info | success | warning | error | progress
   行为：  duration=ms → 自动关闭（timeout）
           duration=null → persistent，只能手动关
           dismiss 文案可覆盖；Esc 关闭**焦点所在的那一条**
   可访问性：容器 role=region + aria-label；单条 info/success → role=status（polite），
           warning/error → role=alert（assertive）；
           **progress 不自动关闭**（进度条自动消失会让用户错过结果）。
   ══════════════════════════════════════════════════════════════════════════ */
export type ToastKind = "info" | "success" | "warning" | "error" | "progress";
export type ToastItem = {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
  /** ms；null = persistent。progress 恒为 persistent。 */
  duration?: number | null;
  dismissLabel?: string;
};

type ToastCtx = {
  toast: (t: Omit<ToastItem, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
  items: ToastItem[];
};

const ToastContext = createContext<ToastCtx | null>(null);

export function useToast(): ToastCtx {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast 必须在 <ToastProvider> 内使用");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      window.clearTimeout(t);
      timers.current.delete(id);
    }
    setItems((cur) => cur.filter((i) => i.id !== id));
  }, []);

  const toast = useCallback<ToastCtx["toast"]>(
    (t) => {
      seq.current += 1;
      const id = t.id ?? `toast-${seq.current}`;
      /* 注意这里不能用 `t.duration ?? 4000`：
         显式传 duration: null 的语义是**常驻**，而 `??` 把 null 当作"未提供"，
         于是常驻通知会被静默套上 4000ms 自动关闭 —— 探针在"4.6s 后仍在"那条抓到。
         必须把"未提供"与"显式 null"分开判断。 */
      const duration =
        t.kind === "progress" || t.duration === null ? null : (t.duration ?? 4000);
      setItems((cur) => [...cur, { ...t, id, duration }]);
      if (duration != null) {
        const h = window.setTimeout(() => dismiss(id), duration);
        timers.current.set(id, h);
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => () => timers.current.forEach((h) => window.clearTimeout(h)), []);

  const value = useMemo(() => ({ toast, dismiss, items }), [toast, dismiss, items]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport />
    </ToastContext.Provider>
  );
}

export function ToastViewport() {
  const { items, dismiss } = useToast();
  return (
    <div
      className="ds-toast-viewport"
      role="region"
      aria-label="通知"
      data-ds-comp="toast-viewport"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className={cx("ds-toast", `ds-toast--${t.kind}`)}
          role={t.kind === "warning" || t.kind === "error" ? "alert" : "status"}
          aria-live={t.kind === "warning" || t.kind === "error" ? "assertive" : "polite"}
          data-ds-comp="toast"
          data-ds-kind={t.kind}
          data-ds-persistent={t.duration == null ? "true" : "false"}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              dismiss(t.id);
            }
          }}
        >
          <span className="ds-toast__glyph" aria-hidden="true">
            {t.kind === "success" ? "✓" : t.kind === "error" ? "!" : t.kind === "warning" ? "!" : "i"}
          </span>
          <div className="ds-toast__body">
            <p className="ds-toast__title">{t.title}</p>
            {t.description ? <p className="ds-toast__desc">{t.description}</p> : null}
            {t.kind === "progress" ? (
              <div className="ds-toast__bar" role="progressbar" aria-label={t.title}>
                <span />
              </div>
            ) : null}
          </div>
          <IconButton
            label={t.dismissLabel ?? `关闭通知：${t.title}`}
            size="sm"
            onClick={() => dismiss(t.id)}
          >
            ×
          </IconButton>
        </div>
      ))}
    </div>
  );
}
