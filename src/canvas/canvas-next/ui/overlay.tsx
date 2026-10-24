/**
 * 弹层 / 对话框：全局只有一个弹层和一个对话框（与预览一致）。
 * openPop(anchor, render, dir, align) —— anchor 是元素或屏幕坐标；render 拿到 close。
 */
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { clamp } from "../model";
import { Icon } from "./Icon";

type PopState = { key: number; anchor: Element | { x: number; y: number }; render: (close: () => void) => ReactNode; dir: "down" | "up" | "right"; align: "left" | "right"; cls?: string; closing?: boolean } | null;
type ModalState = { key: number; render: (close: () => void) => ReactNode; cls?: string; closing?: boolean } | null;

let pop: PopState = null, modalSt: ModalState = null, seq = 0;
const ls = new Set<() => void>();
const emit = () => ls.forEach((l) => l());
const sub = (l: () => void) => { ls.add(l); return () => { ls.delete(l); }; };

export function openPop(anchor: Element | { x: number; y: number }, render: (close: () => void) => ReactNode, dir: "down" | "up" | "right" = "down", align: "left" | "right" = "left", cls?: string) {
  pop = { key: ++seq, anchor, render, dir, align, cls }; emit();
}
export function closePop() {
  if (!pop || pop.closing) return; const k = pop.key; pop = { ...pop, closing: true }; emit();
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
  const [pos, setPos] = useState<{ x: number; y: number; origin: string; menu: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current!; const pr = el.getBoundingClientRect(); let x: number, y: number; let origin = "0 0", menu = false;
    if (st.anchor instanceof Element) {
      const r = st.anchor.getBoundingClientRect();
      if (st.dir === "right") { x = r.right + 10; y = r.top; }
      else if (st.dir === "up") { x = st.align === "right" ? r.right - pr.width : r.left; y = r.top - pr.height - 8; }
      else { x = st.align === "right" ? r.right - pr.width : r.left; y = r.bottom + 8; if (y + pr.height > innerHeight - 8) y = r.top - pr.height - 8; }
      x = clamp(x, 8, innerWidth - pr.width - 8); y = clamp(y, 8, innerHeight - pr.height - 8);
      origin = `${clamp(r.left + r.width / 2 - x, 0, pr.width)}px ${r.top > y ? pr.height : 0}px`; menu = st.dir === "down" && y > r.top;
    } else { x = clamp(st.anchor.x, 8, innerWidth - pr.width - 8); y = clamp(st.anchor.y, 8, innerHeight - pr.height - 8); }
    setPos({ x, y, origin, menu });
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
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, transformOrigin: pos?.origin, visibility: pos ? undefined : "hidden" }} onPointerDown={(e) => e.stopPropagation()}>
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
