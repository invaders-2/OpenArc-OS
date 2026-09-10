export type Rect = { x: number; y: number; width: number; height: number };
export type Area = Rect;
export type WindowRect = { x: number; y: number; w: number; h: number };

export const MIN_W: number;
export const MIN_H: number;
export function clamp(value: number, min: number, max: number): number;
export function rectOf(w: WindowRect | Rect): Rect;
export function intersects(a: Rect | null, b: Rect | null): boolean;
export function inside(rect: Rect, area: Area): boolean;
export function areaFor(win: WindowRect, areas: Area[]): Area | null;
// 只改 x/y/w/h，其余字段（id、min、max、restore）原样保留
export function clampWindow<T extends WindowRect>(
  win: T,
  areas: Area[],
  options?: { minWidth?: number; minHeight?: number },
): T;
export function clampAll<T extends WindowRect>(
  wins: T[],
  areas: Area[],
  options?: { minWidth?: number; minHeight?: number },
): T[];
export function isVisible(win: WindowRect, areas: Area[]): boolean;
export function occluded(target: Rect | null, above: Rect[]): boolean;

declare const geometry: {
  MIN_W: typeof MIN_W;
  MIN_H: typeof MIN_H;
  clamp: typeof clamp;
  rectOf: typeof rectOf;
  intersects: typeof intersects;
  inside: typeof inside;
  areaFor: typeof areaFor;
  clampWindow: typeof clampWindow;
  clampAll: typeof clampAll;
  isVisible: typeof isVisible;
  occluded: typeof occluded;
};
export default geometry;
