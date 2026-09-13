import { useEffect, useRef } from "react";

/**
 * Apple Dock 鱼眼放大 —— 复刻 macOS，而不是"原地放大"。
 *
 * 三个关键（第 2 条才是 macOS 与常见网页仿制的分水岭）：
 *  1. 高度倍率 = raised-cosine 窗 `0.5·cos(a·t) + 0.5` 在图标自身跨度上的**积分平均**：
 *     a = 8/9、t 以图标高度为单位、支撑半径 ±3/a ≈ ±3.375h。
 *  2. 整排横向**撑开**：按"缩放后"的累计宽度重排，并把指针所在的基座标锚回原位 ——
 *     悬停的图标始终停在光标下，左右邻居被推开。
 *  3. 底板（.dock::before）跟着撑开：**只写 transform**（translateX + scaleX），
 *     不做 width/left 布局。后者会每帧触发主线程 layout，并让 backdrop-filter 重新
 *     栅格化 —— 在 Electron 的原生 vibrancy 上就是肉眼可见的掉帧。
 *
 * 每帧只写合成器属性（translate / --s / --bg-tx / --bg-k），主线程不做布局；
 * 离开时交回 CSS 过渡（.settling）。
 */
export function useDockMagnify(reduced: boolean) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const dock = ref.current;
    if (!dock) return;
    const slots = Array.from(dock.querySelectorAll<HTMLElement>(".dock-item, .dock-divider"));
    const n = slots.length;
    if (!n) return;

    const A = 8 / 9;
    const SUPPORT = 3 / A; // 窗的支撑半径（单位：图标高度）
    const SMAX = 1.6; // 峰值高度倍率
    const PAD = 10; // 底板横向内边距，须与 .dock 的 padding 对齐
    const F = (t: number) => Math.sin(A * t) / (2 * A) + t / 2; // ∫ 窗 dt

    const baseCenter = new Array<number>(n).fill(0);
    const baseWidth = new Array<number>(n).fill(0);
    const spanH = new Array<number>(n).fill(1);
    const scale = new Array<number>(n).fill(1);
    const gCenter = new Array<number>(n).fill(0); // 每帧复用，避免 GC 抖动
    let gap = 5;
    let iconH = 47;
    let baseRowLeft = 0;
    let dockLeft = 0;
    let dockW = 0;
    let dirty = false; // 是否写过内联样式（决定测量前要不要强制 reflow）

    const clearInline = () => {
      for (const el of slots) {
        el.style.removeProperty("translate");
        el.style.removeProperty("--s");
      }
      dock.style.removeProperty("--bg-tx");
      dock.style.removeProperty("--bg-k");
      dirty = false;
    };

    const measure = () => {
      if (dirty) {
        clearInline();
        void dock.offsetWidth; // 只在真的写过样式时才强制 reflow
      }
      const dr = dock.getBoundingClientRect();
      dockLeft = dr.left;
      dockW = dr.width;
      gap = parseFloat(getComputedStyle(dock).columnGap) || 0;
      const first = slots[0].getBoundingClientRect();
      const iconEl = slots[0].querySelector<HTMLElement>(".dock-icon");
      iconH = iconEl ? iconEl.offsetWidth : first.width;
      baseRowLeft = first.left;
      for (let i = 0; i < n; i++) {
        const r = slots[i].getBoundingClientRect();
        baseWidth[i] = r.width;
        baseCenter[i] = r.left + r.width / 2;
        spanH[i] = (slots[i].classList.contains("dock-item") ? iconH : r.width) / iconH;
      }
    };

    if (reduced) {
      clearInline();
      return;
    }

    let raf = 0;
    let settleTimer = 0;
    let pointerX = 0;

    const paint = () => {
      raf = 0;
      const x = pointerX;

      // 1) 高度倍率 = 窗在该槽跨度上的平均
      for (let i = 0; i < n; i++) {
        const rawL = (baseCenter[i] - x - (spanH[i] * iconH) / 2) / iconH;
        const rawR = rawL + spanH[i];
        const l = Math.max(-SUPPORT, Math.min(SUPPORT, rawL));
        const r = Math.max(-SUPPORT, Math.min(SUPPORT, rawR));
        const k = Math.max(0, Math.min(1, F(r) - F(l)));
        scale[i] = 1 + (SMAX - 1) * k;
      }

      // 2) 缩放后的累计宽度，以及指针所在基座标缩放后落在哪
      const p = x - baseRowLeft;
      let g = 0;
      let gp = 0;
      let gpDone = false;
      for (let i = 0; i < n; i++) {
        const sw = baseWidth[i] * scale[i];
        const pitch = sw + (i < n - 1 ? gap : 0);
        gCenter[i] = g + sw / 2;
        const bs = baseCenter[i] - baseWidth[i] / 2 - baseRowLeft;
        const be = bs + baseWidth[i];
        if (!gpDone) {
          if (p <= bs) gpDone = true;
          else if (p < be) {
            gp += (p - bs) * scale[i];
            gpDone = true;
          } else gp += pitch;
        }
        g += pitch;
      }

      // 3) 写回：撑开用 translate，缩放用 --s，底板用 transform（合成器属性）
      for (let i = 0; i < n; i++) {
        slots[i].style.translate = (x + gCenter[i] - gp - baseCenter[i]).toFixed(2) + "px";
        slots[i].style.setProperty("--s", scale[i].toFixed(4));
      }
      const k = (g + 2 * PAD) / dockW; // 底板宽度倍率
      const tx = x - gp - PAD - dockLeft - (dockW * (1 - k)) / 2; // 左缘对齐
      dock.style.setProperty("--bg-k", k.toFixed(4));
      dock.style.setProperty("--bg-tx", tx.toFixed(2) + "px");
      dirty = true;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };

    const enter = () => {
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = 0;
      }
      dock.classList.remove("settling");
      measure();
      dock.classList.add("magnifying");
    };
    const move = (e: PointerEvent) => {
      if (!dock.classList.contains("magnifying")) enter();
      pointerX = e.clientX;
      schedule();
    };
    const leave = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      // 撤 .magnifying / 加 .settling、并清掉内联值，必须在同一个 tick：
      // 浏览器据此从**当前**撑开量过渡回静止，而不是先跳回去。
      dock.classList.remove("magnifying");
      dock.classList.add("settling");
      clearInline();
      settleTimer = window.setTimeout(() => {
        settleTimer = 0;
        dock.classList.remove("settling");
        clearInline();
      }, 280);
    };

    measure();
    dock.addEventListener("pointerenter", enter);
    dock.addEventListener("pointermove", move);
    dock.addEventListener("pointerleave", leave);
    window.addEventListener("resize", measure);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (settleTimer) clearTimeout(settleTimer);
      dock.removeEventListener("pointerenter", enter);
      dock.removeEventListener("pointermove", move);
      dock.removeEventListener("pointerleave", leave);
      window.removeEventListener("resize", measure);
      dock.classList.remove("magnifying", "settling");
      clearInline();
    };
  }, [reduced]);

  return ref;
}
