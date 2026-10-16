import { DESK_BOUND, clampDeskPos } from "../stores/shell";

/**
 * 桌面栅格：整理与"网格吸附"共用同一套数 —— 与既有产品 `src/main.tsx:296` 逐值一致。
 * 格子尺寸跟着图标大小走（间距 = 图标 × 0.35），首格在最右上角，往下排满一列再往左一列。
 */
export const DESK_LATTICE = { tileW: 38, tileH: 37, gapRatio: 0.35, right: 20, top: 8 };

export function deskLattice(icon: number, hostW = innerWidth, hostH = innerHeight) {
  const tileW = icon + DESK_LATTICE.tileW;
  const tileH = icon + DESK_LATTICE.tileH;
  const gap = Math.round(icon * DESK_LATTICE.gapRatio);
  const dx = tileW + gap;
  const dy = tileH + gap;
  const rows = Math.max(1, Math.floor((hostH - DESK_BOUND.top - DESK_BOUND.bottom) / dy));
  return { x0: hostW - DESK_LATTICE.right - tileW, y0: DESK_BOUND.top + DESK_LATTICE.top, dx, dy, rows, tileW, tileH };
}

export function gridPos(index: number, icon: number, hostW = innerWidth, hostH = innerHeight) {
  const grid = deskLattice(icon, hostW, hostH);
  return clampDeskPos({
    x: grid.x0 - Math.floor(index / grid.rows) * grid.dx,
    y: grid.y0 + (index % grid.rows) * grid.dy,
  });
}
