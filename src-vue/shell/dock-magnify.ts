// 程序坞鱼眼放大的 Vue 版：算法与 src/desktop/useDockMagnify.ts **逐行同源**
// （从 React hook 的 effect 体搬出，只把 ref/useEffect 换成"装上 → 返回卸载函数"）。
// 两边任何一处改算法，另一处必须同步。

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
 *
 * **跟随是 1:1 的，中间不插弹簧。** 原生 Dock 不做阻尼平滑：指针在哪，放大就在哪，
 * 中途插一条弹簧会变成"整排追着指针跑"（那是 React Bits 的观感，不是原生的）。
 * 唯一有动画的是**离开**那一下 —— 交回 CSS 过渡从当前撑开量弹回。
 *
 * ref 由 Dock 自己持有并同时交给 useDockArrange；suspended 在"整理"期间为真
 * （那时槽位由拖动手势接管）；signature 变化表示成员/顺序变了，缓存的测量作废。
 */
export function installDockMagnify(dock: HTMLElement, suspended = false): () => void {
  const slots = Array.from(dock.querySelectorAll<HTMLElement>(".dock-item, .dock-divider"));
  const iconEls = slots.map((el) => el.querySelector<HTMLElement>(".dock-icon"));
  const n = slots.length;
  if (!n) return () => {};

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

  /** 底板两层：玻璃**只改裁切**（尺寸静止，背景不会被拉变形），阴影跟着撑开。 */
  const glass = dock.querySelector<HTMLElement>(".dock-glass");
  const shadow = dock.querySelector<HTMLElement>(".dock-shadow");
  /** 必须与 .dock-glass 的 --dock-slack 一致。实测全程所需 ≤61px，留到 90。 */
  const SLACK = 90;
  /** 指针当前覆盖的槽位（夹在 0..n-1）。提示气泡只给它写 --s，见 paint 里的说明。 */
  let hoverIdx = -1;

  /**
   * 把所有逐帧内联值清掉，回到 CSS 的静止态。
   *
   * **一个自定义属性都不写**：自定义属性会沿继承树失效（写在 .dock 上等于让整排
   * 重新算一遍样式，实测 UpdateLayoutTree 0.52 ms/帧）；能直接写内联就写内联。
   */
  const clearInline = () => {
    for (let i = 0; i < n; i++) {
      slots[i].style.removeProperty("translate");
      slots[i].style.removeProperty("--s");
      iconEls[i]?.style.removeProperty("transform");
    }
    hoverIdx = -1;
    glass?.style.removeProperty("clip-path");
    shadow?.style.removeProperty("transform");
    shadow?.style.removeProperty("border-radius");
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

  if (suspended) {
    clearInline();
    return () => {};
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
    let hovered = -1;
    for (let i = 0; i < n; i++) {
      const sw = baseWidth[i] * scale[i];
      const pitch = sw + (i < n - 1 ? gap : 0);
      gCenter[i] = g + sw / 2;
      const bs = baseCenter[i] - baseWidth[i] / 2 - baseRowLeft;
      const be = bs + baseWidth[i];
      if (!gpDone) {
        if (p <= bs) {
          gpDone = true;
          hovered = i;
        } else if (p < be) {
          gp += (p - bs) * scale[i];
          gpDone = true;
          hovered = i;
        } else gp += pitch;
      }
      g += pitch;
    }
    if (hovered < 0) hovered = p <= 0 ? 0 : n - 1;

    // 3) 写回：撑开用 translate、缩放直接写内联 transform —— 两者都是合成器属性，
    //    而且都是"写在用它的那个元素上"，不会连累整棵子树重算样式。
    for (let i = 0; i < n; i++) {
      slots[i].style.translate = (x + gCenter[i] - gp - baseCenter[i]).toFixed(2) + "px";
      const icon = iconEls[i];
      if (icon) icon.style.transform = scale[i] === 1 ? "" : `scale(${scale[i].toFixed(4)})`;
    }
    /**
     * 只有**指针下那一个**图标的提示需要跟着抬高。
     *
     * 提示的 --s 是给气泡定位用的；如果每个槽位每帧都写 --s，7 个带 backdrop-filter
     * 的气泡会一起被失效并重新栅格化 —— 实测那是整轮扫描里最大的一笔开销
     * （关掉提示：raster -43%、BeginMainFrame -22%）。其余槽位的 --s 保持默认 1 即可，
     * 它们的气泡本来就不可见。
     */
    if (hovered !== hoverIdx) {
      if (hoverIdx >= 0) slots[hoverIdx].style.removeProperty("--s");
      hoverIdx = hovered;
    }
    if (hoverIdx >= 0) slots[hoverIdx].style.setProperty("--s", scale[hoverIdx].toFixed(4));
    const k = (g + 2 * PAD) / dockW; // 底板宽度倍率
    const tx = x - gp - PAD - dockLeft - (dockW * (1 - k)) / 2; // 左缘对齐
    const pillLeft = x - gp - PAD;
    const pillRight = pillLeft + g + 2 * PAD;
    if (shadow) {
      shadow.style.transform = `translateX(${tx.toFixed(2)}px) scaleX(${k.toFixed(4)})`;
      shadow.style.borderRadius = `${(20 / k).toFixed(2)}px / 20px`;
    }
    if (glass) {
      // 相对那块静止玻璃的左缘裁；SLACK 不够时宁可切平也不让它溢出
      const boxLeft = dockLeft - SLACK;
      const boxRight = dockLeft + dockW + SLACK;
      const l = Math.max(0, Math.min(boxRight - boxLeft, pillLeft - boxLeft));
      const r = Math.max(0, Math.min(boxRight - boxLeft, boxRight - pillRight));
      glass.style.clipPath = `inset(0 ${r.toFixed(1)}px 0 ${l.toFixed(1)}px round 20px)`;
    }
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
}
