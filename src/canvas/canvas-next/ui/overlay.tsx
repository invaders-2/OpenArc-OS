/**
 * 弹层 / 对话框：全局只有一个弹层和一个对话框（与预览一致）。
 * openPop(anchor, render, dir, align) —— anchor 是元素或屏幕坐标；render 拿到 close。
 */
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Icon } from "./Icon";
import { placePopover, type PopRect } from "./placement";

type PopAnchor = Element | { x: number; y: number; width?: number; height?: number };
type PopOpts = { /** 底部再让出多少像素（避开底部工具栏） */ bottomInset?: number; /** anchor 是区域时，真正被点的按钮（隐藏它的提示、再点它是切换） */ trigger?: Element | null };
type PopState = { key: number; anchor: PopAnchor; opts?: PopOpts; render: (close: () => void) => ReactNode; dir: "down" | "up" | "right"; align: "left" | "right"; cls?: string; closing?: boolean } | null;
type ModalState = { key: number; render: (close: () => void) => ReactNode; cls?: string; closing?: boolean } | null;

let pop: PopState = null, modalSt: ModalState = null, seq = 0;
const ls = new Set<() => void>();
const emit = () => ls.forEach((l) => l());
const sub = (l: () => void) => { ls.add(l); return () => { ls.delete(l); }; };

/**
 * anchor 可以是元素、屏幕点，或一块区域 {x,y,width,height}：
 * 用区域时，弹层贴着区域外侧弹出（例如生成面板整块的上方、输入框整块的上方），不会盖住区域本身。
 */
export function openPop(anchor: PopAnchor, render: (close: () => void) => ReactNode, dir: "down" | "up" | "right" = "down", align: "left" | "right" = "left", cls?: string, opts?: PopOpts) {
  ({ anchor, dir, align, opts } = autoPlace(anchor, dir, align, opts));
  markAnchor(null); pop = { key: ++seq, anchor, render, dir, align, cls, opts }; markAnchor(opts?.trigger || anchor); emit();
}
/** 弹层打开期间，锚点按钮自己的悬停提示（data-tip）不再显示，免得压在弹层边上 */
let marked: Element | null = null;
function markAnchor(a: PopAnchor | null) {
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
        : { x: st.anchor.x, y: st.anchor.y, width: st.anchor.width || 0, height: st.anchor.height || 0 };
      const placed = placePopover({ anchor, popup: pr, viewport: { width: innerWidth, height: innerHeight - (st.opts?.bottomInset || 0) }, dir: st.dir, align: st.align, margin: 8, gap: 8 });
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
    const onDown = (e: PointerEvent) => { const t = e.target as Node; if (ref.current?.contains(t)) return; if (st.anchor instanceof Element && st.anchor.contains(t)) return; if (st.opts?.trigger?.contains(t)) return; closePop(); };
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

/**
 * 统一的弹出位置（按触发按钮所在的区域自动决定，调用方不用各自处理）：
 *  · 生成面板 #gp、助手输入框 #aiBox 里的按钮：弹层出现在整块区域的上方（不盖住正在写的提示词），
 *    生成面板里按钮在左半边就和按钮左对齐、右半边就右对齐；助手输入框里对齐输入框的左 / 右边缘；
 *    这一侧放不下时换另一侧对齐，上方放不下时翻到区域下方或限高滚动。
 *  · 左侧竖排工具栏 #lb：贴着工具栏右边缘弹出，并让开底部缩放栏。
 * 弹层里再点出的子菜单不受影响。
 */
function autoPlace(anchor: PopAnchor, dir: "down" | "up" | "right", align: "left" | "right", opts?: PopOpts) {
  if (!(anchor instanceof Element) || anchor.closest("#pop")) return { anchor, dir, align, opts };
  const region = anchor.closest("#gp") || anchor.closest("#aiBox");
  if (region) {
    const t = anchor.getBoundingClientRect(); const r = region.getBoundingClientRect();
    const whole = anchor === region;
    const right = !whole && t.left + t.width / 2 > r.left + r.width / 2;
    // 助手输入框：弹层对齐输入框的左 / 右边缘（始终留在助手面板里）；生成面板：对齐被点的按钮
    const box = whole || region.id === "aiBox";
    return { anchor: box ? { x: r.left, y: r.top, width: r.width, height: r.height } : { x: t.left, y: r.top, width: t.width, height: r.height }, dir: "up" as const, align: right ? "right" as const : "left" as const, opts: { ...opts, trigger: anchor } };
  }
  const bar = anchor.closest("#lb");
  if (bar) {
    const b = bar.getBoundingClientRect(); const t = anchor.getBoundingClientRect(); const zb = bar.closest(".cn-root")?.querySelector("#zb");
    return { anchor: { x: b.left, y: t.top, width: b.width, height: t.height }, dir: "right" as const, align: "left" as const, opts: { ...opts, trigger: anchor, bottomInset: zb ? Math.max(0, innerHeight - zb.getBoundingClientRect().top) : 0 } };
  }
  return { anchor, dir, align, opts };
}

/** 区域锚点：横向取触发按钮，纵向取整块区域（弹层贴着区域外侧，不盖住区域） */
export function regionAnchor(trigger: Element, region: Element | null | undefined, alignTo: "trigger" | "region" = "trigger") {
  const t = trigger.getBoundingClientRect(); const r = (region || trigger).getBoundingClientRect();
  return alignTo === "region" ? { x: r.left, y: r.top, width: r.width, height: r.height } : { x: t.left, y: r.top, width: t.width, height: r.height };
}
/** 左侧竖排工具栏的弹层：贴着工具栏右边缘弹出，并让开底部缩放栏 */
export function sideBarPop(trigger: Element, render: (close: () => void) => ReactNode, cls?: string) {
  const root = trigger.closest(".cn-root"); const bar = trigger.closest("#lb") || trigger; const zb = root?.querySelector("#zb");
  const b = bar.getBoundingClientRect(); const t = trigger.getBoundingClientRect();
  const inset = zb ? Math.max(0, innerHeight - zb.getBoundingClientRect().top + 8 - 8) : 0;
  openPop({ x: b.left, y: t.top, width: b.width, height: t.height }, render, "right", "left", cls, { bottomInset: inset, trigger });
}
