import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

/** 按住多久进入"整理"（对齐 iOS 主屏长按的手感）。 */
const HOLD_MS = 420;
/** 长按判定期间允许的手抖范围：超过就交回给普通点击 / 拖拽，不进入整理。 */
const MOVE_TOLERANCE = 6;
/** 松手后拖动项归位的时长（这段时间仍留在整理态，好看清它落到哪一格）。 */
const SETTLE_MS = 180;
/** 兄弟项让位的时长，与 .dock.arranging .dock-item 的 transition 保持一致。 */
const SHIFT_MS = 200;

type Options = {
  /** 当前顺序（只有 app 参与排序，分隔线与全局 AI 是固定槽位）。 */
  ids: readonly string[];
  onReorder: (next: string[]) => void;
  onActivate: (id: string) => void;
};

/**
 * Dock 的"长按 → 拖动排序"。
 *
 * 三条约束：
 *  1. **长按**是进入整理的唯一入口。按住期间一旦位移超过容差，就把这次手势让回点击 ——
 *     否则用户想拖窗口却从 Dock 上起手时，会被误判成整理。
 *  2. 顺序的**唯一真值仍在 App**（它负责 localStorage）：拖动过程中实时回调 onReorder，
 *     本 hook 只做手势与视觉，不缓存一份自己的顺序。
 *  3. 兄弟项换位用 FLIP（先反向位移一帧，再过渡回 0）补间 ——
 *     React 换 DOM 顺序是一帧内完成的，不补间就是硬跳。
 */
export function useDockArrange(dockRef: RefObject<HTMLElement | null>, { ids, onReorder, onActivate }: Options) {
  const [arranging, setArranging] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  /** 事件回调是普通回调，拿不到最新 props，因此实时值都放这里。 */
  const live = useRef({ arranging: false, dragId: null as string | null, ids: [] as readonly string[], suppress: false });
  const gesture = useRef<{ pointer: { x: number; y: number }; y0: number; id: string } | null>(null);
  const positions = useRef<Map<string, number>>(new Map());
  live.current.ids = ids;

  const items = useCallback(
    () => Array.from(dockRef.current?.querySelectorAll<HTMLElement>(".dock-item[data-dock-id]") ?? []),
    [dockRef],
  );

  /** 拖动项贴在指针下：以它**当前所在槽位**为基准，换槽后不会整体偏移。 */
  const stick = useCallback(() => {
    const g = gesture.current;
    const dock = dockRef.current;
    if (!g || !dock) return;
    const el = items().find((v) => v.dataset.dockId === g.id);
    if (!el) return;
    const localX = g.pointer.x - dock.getBoundingClientRect().left;
    el.style.transition = "none";
    el.style.transform = `translate(${(localX - (el.offsetLeft + el.offsetWidth / 2)).toFixed(1)}px, ${(g.pointer.y - g.y0).toFixed(1)}px) scale(1.14)`;
  }, [dockRef, items]);

  /** 指针落在第几格 / 顺序是否要变。 */
  const place = useCallback(() => {
    const g = gesture.current;
    const dock = dockRef.current;
    const list = items();
    if (!g || !dock || !list.length) return;
    const first = list[0];
    const pitch = list.length > 1 ? list[1].offsetLeft - first.offsetLeft : 0;
    const center0 = first.offsetLeft + first.offsetWidth / 2;
    const localX = g.pointer.x - dock.getBoundingClientRect().left;
    const slot = pitch > 0 ? Math.max(0, Math.min(list.length - 1, Math.round((localX - center0) / pitch))) : 0;
    const current = live.current.ids;
    const others = current.filter((v) => v !== g.id);
    const next = others.slice();
    next.splice(Math.max(0, Math.min(others.length, slot)), 0, g.id);
    if (next.join("\u0000") !== current.join("\u0000")) onReorder(next);
    stick();
  }, [dockRef, items, onReorder, stick]);

  useLayoutEffect(() => {
    if (!arranging) {
      positions.current = new Map();
      gesture.current = null;
      for (const el of items()) {
        el.style.removeProperty("transform");
        el.style.removeProperty("transition");
      }
      return;
    }
    const list = items();
    const next = new Map<string, number>();
    for (const el of list) next.set(el.dataset.dockId!, el.offsetLeft);
    const prev = positions.current;
    if (prev.size) {
      let moved = false;
      for (const el of list) {
        const key = el.dataset.dockId!;
        const before = prev.get(key);
        const after = next.get(key);
        if (key === live.current.dragId || before === undefined || after === undefined || before === after) continue;
        el.style.transition = "none";
        el.style.transform = `translateX(${before - after}px)`;
        moved = true;
      }
      if (moved) {
        void dockRef.current?.offsetWidth; // 一次 reflow，把反向位移定成过渡起点
        for (const el of list) {
          if (!el.style.transform) continue;
          el.style.transition = `transform ${SHIFT_MS}ms var(--ease-spring)`;
          el.style.transform = "";
        }
      }
      stick(); // 拖动项在新槽位上重新贴回指针
    }
    positions.current = next;
  }, [arranging, ids, items, dockRef, stick]);

  const press = useCallback(
    (id: string, e: ReactPointerEvent) => {
      if (e.button !== 0 || live.current.arranging) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const origin = [...live.current.ids];
      let promoted = false;
      let done = false;
      let timer = 0;

      const cleanup = () => {
        window.clearTimeout(timer);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("keydown", onKey);
      };

      function onMove(ev: PointerEvent) {
        if (done) return;
        if (!promoted) {
          if (Math.abs(ev.clientX - startX) > MOVE_TOLERANCE || Math.abs(ev.clientY - startY) > MOVE_TOLERANCE) {
            done = true;
            cleanup();
          }
          return;
        }
        gesture.current = { pointer: { x: ev.clientX, y: ev.clientY }, y0: startY, id };
        place();
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") finish(true);
      }
      function onUp() {
        finish(false);
      }
      function finish(revert: boolean) {
        if (done) return;
        done = true;
        cleanup();
        if (!promoted) return; // 只是普通点击：点击事件照常触发
        if (revert) onReorder(origin);
        const el = items().find((v) => v.dataset.dockId === id);
        if (el) {
          el.style.transition = `transform ${SETTLE_MS}ms var(--ease-spring)`;
          el.style.transform = "translate(0px, 0px) scale(1)";
        }
        window.setTimeout(() => {
          live.current.arranging = false;
          live.current.dragId = null;
          gesture.current = null;
          setArranging(false);
          setDragId(null);
          // 丢掉长按后的那一次 click（它在 pointerup 之后立刻派发）
          window.setTimeout(() => {
            live.current.suppress = false;
          }, 0);
        }, SETTLE_MS);
      }

      timer = window.setTimeout(() => {
        if (done) return;
        promoted = true;
        live.current.arranging = true;
        live.current.dragId = id;
        live.current.suppress = true;
        gesture.current = { pointer: { x: startX, y: startY }, y0: startY, id };
        setArranging(true);
        setDragId(id);
        place();
      }, HOLD_MS);

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("keydown", onKey);
    },
    [items, onReorder, place],
  );

  /** 普通点击启动 App；被长按手势吃掉的那一次不启动。 */
  const activate = useCallback(
    (id: string) => {
      if (live.current.suppress) return;
      onActivate(id);
    },
    [onActivate],
  );

  return { arranging, dragId, press, activate };
}
