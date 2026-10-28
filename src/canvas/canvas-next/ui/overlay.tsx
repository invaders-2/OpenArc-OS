/**
 * 弹层 / 对话框：全局只有一个弹层和一个对话框（与预览一致）。
 * openPop(anchor, render, dir, align) —— anchor 是元素或屏幕坐标；render 拿到 close。
 */
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Icon } from "./Icon";
import { placePopover, type PopRect } from "./placement";

type PopState = { key: number; anchor: Element | { x: number; y: number }; render: (close: () => void) => ReactNode; dir: "down" | "up" | "right"; align: "left" | "right"; cls?: string; closing?: boolean } | null;
type ModalState = { key: number; render: (close: () => void) => ReactNode; cls?: string; closing?: boolean } | null;

let pop: PopState = null, modalSt: ModalState = null, seq = 0;
const ls = new Set<() => void>();
const emit = () => ls.forEach((l) => l());
const sub = (l: () => void) => { ls.add(l); return () => { ls.delete(l); }; };

export function openPop(anchor: Element | { x: number; y: number }, render: (close: () => void) => ReactNode, dir: "down" | "up" | "right" = "down", align: "left" | "right" = "left", cls?: string) {
  markAnchor(null); pop = { key: ++seq, anchor, render, dir, align, cls }; markAnchor(anchor); emit();
}
/** 弹层打开期间，锚点按钮自己的悬停提示（data-tip）不再显示，免得压在弹层边上 */
let marked: Element | null = null;
function markAnchor(a: Element | { x: number; y: number } | null) {
  if (marked) { marked.removeAttribute("data-pop-anchor"); marked = null; }
  if (a instanceof Element) { a.setAttribute("data-pop-anchor", ""); marked = a; }
}
export function closePop() {
  if (!pop || pop.closing) return; const k = pop.key; pop = { ...pop, closing: true }; markAnchor(null); emit();
  setTimeout(() => { if (pop && pop.key === k) { pop = null; emit(); } }, 130);
}
export const popOpen = () => !!pop && !pop.closing;
export function openModal(render: (close: () => void) => ReactNode, cls?: string) { modalSt = { key: ++seq, render, cls }; emit(); }
export function closeModal() {
  if (!modalSt || modalSt.closing) return; const k = modalSt.key; modalSt = { ...modalSt, closing: true }; emit();
  setTimeout(() => { if (modalSt && modalSt.key === k) { modalSt = null; emit(); } }, 170);
}
export const modalOpen = () => !!modalSt && !modalSt.closing;

export function OverlayHost() {
  const p = useSyncExternalStore(sub, () => pop);
  const m = useSyncExternalStore(sub, () => modalSt);
  return <>{p ? <Popover key={p.key} st={p} /> : null}{m ? <ModalView key={m.key} st={m} /> : null}</>;
}

function Popover({ st }: { st: NonNullable<PopState> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; origin: string; menu: boolean; maxWidth: number; maxHeight: number; scroll: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => {
      // 量内容的自然尺寸（被限高时 scrollHeight 仍是完整高度），避免限高 ↔ 放开来回抖
      const b = el.getBoundingClientRect(); const pr = { x: b.left, y: b.top, width: Math.max(b.width, el.scrollWidth), height: Math.max(b.height, el.scrollHeight) };
      const anchor: PopRect = st.anchor instanceof Element
        ? (() => { const r = st.anchor.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()
        : { x: st.anchor.x, y: st.anchor.y, width: 0, height: 0 };
      const placed = placePopover({ anchor, popup: pr, viewport: { width: innerWidth, height: innerHeight }, dir: st.dir, align: st.align, margin: 8, gap: 8 });
      setPos((prev) => prev && prev.x === placed.x && prev.y === placed.y && prev.maxHeight === placed.maxHeight && prev.maxWidth === placed.maxWidth && prev.scroll === (placed.scrollX || placed.scrollY) ? prev : { x: placed.x, y: placed.y, origin: placed.origin, menu: placed.menu, maxWidth: placed.maxWidth, maxHeight: placed.maxHeight, scroll: placed.scrollX || placed.scrollY });
    };
    measure();
    // 内容异步变化（画布列表、模型列表加载完）时重新定位，不能沿用第一次量到的高度把后来的内容裁掉
    const ro = new ResizeObserver(() => measure()); ro.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [st]);
  // 弹层外按下关闭（按在锚点上交给锚点自己的 onClick 切换）
  useLayoutEffect(() => {
    if (st.closing) return;
    const onDown = (e: PointerEvent) => { const t = e.target as Node; if (ref.current?.contains(t)) return; if (st.anchor instanceof Element && st.anchor.contains(t)) return; closePop(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); closePop(); } };
    document.addEventListener("pointerdown", onDown, true); document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey, true); };
  }, [st]);
  return (
    <div id="pop" ref={ref} className={(st.closing ? "closing" : "") + (pos?.menu ? " menu" : "") + (st.cls ? " " + st.cls : "")}
      style={{
        left: pos?.x ?? -9999, top: pos?.y ?? -9999, transformOrigin: pos?.origin, visibility: pos ? undefined : "hidden",
        // 只在放不下时才限制尺寸并滚动；放得下就不写死高度
        maxWidth: pos?.scroll ? pos.maxWidth : undefined, maxHeight: pos?.scroll ? pos.maxHeight : undefined, overflow: pos?.scroll ? "auto" : undefined,
      }}
      onPointerDown={(e) => e.stopPropagation()}>
      {st.render(closePop)}
    </div>
  );
}

function ModalView({ st }: { st: NonNullable<ModalState> }) {
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !pop) { e.stopPropagation(); closeModal(); } };
    document.addEventListener("keydown", onKey, true); return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div className={"modal-bg" + (st.closing ? " closing" : "")} id="modal" onPointerDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
      <div className={"modal " + (st.cls || "")} role="dialog">{st.render(closeModal)}</div>
    </div>
  );
}

export function ModalHead({ title, icon, extra }: { title: ReactNode; icon?: Parameters<typeof Icon>[0]["name"]; extra?: ReactNode }) {
  return <div className="mhd">{icon ? <Icon name={icon} size="s" /> : null}{title}<span className="sp" />{extra}<button className="ib" onClick={closeModal} aria-label="关闭"><Icon name="x" /></button></div>;
}
