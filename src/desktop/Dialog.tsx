/**
 * D2-02 · Dialog 原语（§16 / §17）。
 *
 * 这是 D2-01 登记为 NOT VERIFIED 的那一项的正式落地：
 *   「对话框焦点陷阱 + 焦点返回」当时拒绝临时造一个组件充数，
 *   D2-02 给出真实现，并由探针实测验收。
 *
 * 五件事，缺一不可：
 *   1. **焦点陷阱** —— Tab / Shift+Tab 在对话框内循环，永不外逃
 *   2. **inert 背景** —— 由调用方给背景容器加 inert，语义层就挡住了，
 *      而不是靠"Tab 循环"这一层技巧独自承担
 *   3. **Esc 关闭** —— 且是捕获阶段处理，避免被背景的全局 Esc 抢走
 *   4. **关闭按钮** —— 可见、可聚焦、有 aria-label
 *   5. **焦点返回** —— 关闭后焦点回到打开它的那个元素，
 *      否则键盘用户按 Esc 之后会掉到 body，等于"迷失位置"
 *
 * 与原生视图的关系（§17 硬验收）：对话框打开时原生视图**整块让位**
 * （overlayOpen → plan() 出 hidden），并显式把焦点交还外壳。
 * 这两件事分别在 useDesktop 与 native-view-controller 里，本组件不掺和 ——
 * 它只管 DOM 侧的语义，这正是"职责边界"该有的样子。
 */
import React, { useCallback, useEffect, useRef } from "react";
import { X } from "lucide-react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

type DialogProps = {
  open: boolean;
  title: string;
  /** 无标题时必须给 aria-label，否则屏幕阅读器读不出这个对话框是什么。 */
  ariaLabel?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /**
   * 关闭后焦点回到哪里。缺省用"打开对话框时正持有焦点的元素"。
   *
   * 为什么需要显式传入：产品里对话框往往由**右键菜单项**触发，
   * 而菜单在对话框打开的同一次提交里就被卸载了 —— 缺省目标是一个已脱离文档的节点，
   * `focus()` 会静默失效，焦点掉到 body。此时必须由调用方给出真正的来源元素。
   */
  returnFocusTo?: HTMLElement | null;
};

export function Dialog({ open, title, ariaLabel, onClose, children, footer, returnFocusTo }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const focusables = useCallback(
    () => Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) || []),
    [],
  );

  useEffect(() => {
    if (!open) return;
    // 记住是谁打开的 —— 关闭时必须还给它
    returnTo.current = returnFocusTo ?? (document.activeElement as HTMLElement);
    focusables()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = focusables();
      if (!nodes.length) {
        // 没有任何可聚焦元素时不能让 Tab 逃到背景去
        e.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const at = document.activeElement as HTMLElement | null;
      if (!at || !nodes.includes(at)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && at === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // 捕获阶段：背景可能也有 Esc 监听，必须抢在它前面
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const back = returnTo.current;
      if (back && document.contains(back)) back.focus();
    };
  }, [open, onClose, focusables, returnFocusTo]);

  if (!open) return null;

  return (
    <div className="dialog-shade" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel || title}
        ref={ref}
      >
        <div className="dialog-heading">
          <strong>{title}</strong>
          <button aria-label={`关闭${title}`} onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
