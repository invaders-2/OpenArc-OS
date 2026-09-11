/** D2-02 · Window domain model 的类型声明（渲染进程用；运行时由 .cjs 提供）。 */

export type AppId = string;
export type WindowId = string;
export type WindowKind = "app" | "browser";
export type WindowStateName = "normal" | "minimized" | "maximized";

/** 与 electron/geometry.cjs 的 WindowRect 同构，因此迁移不做坐标换算。 */
export type Bounds = { x: number; y: number; w: number; h: number };

export type WindowMeta = { title: string; icon: string; url?: string };

export type Window = {
  id: WindowId;
  appId: AppId;
  kind: WindowKind;
  bounds: Bounds;
  state: WindowStateName;
  /** 仅在 MAXIMIZED 时非 null；其余情况显式 null。 */
  restore: Bounds | null;
  minSize: { w: number; h: number };
  meta: WindowMeta;
  /** 派生自 state（!== minimized）。 */
  visible: boolean;
  /** 多显示器归属；本轮单屏恒为 null。 */
  displayId: number | string | null;
  /** z-order 缓存，真值是 state.order 下标，由 reindex 写回。 */
  z: number;
};

export type WindowStateModel = {
  windows: Window[];
  /** 自底向上；末尾为最上层。z-order 的唯一真值。 */
  order: WindowId[];
  focused: WindowId | null;
  seq: number;
};

export type Host = { width: number; height: number };
export type Area = { x: number; y: number; width: number; height: number };

export type WindowCommand =
  | { type: "window/open"; id?: WindowId; appId: AppId; kind?: WindowKind; bounds?: Partial<Bounds>; minSize?: { w: number; h: number }; meta?: Partial<WindowMeta>; displayId?: number | string | null }
  | { type: "window/close"; id: WindowId }
  | { type: "window/focus"; id: WindowId }
  | { type: "window/move"; id: WindowId; x: number; y: number; host?: Host }
  | { type: "window/resize"; id: WindowId; w: number; h: number; host?: Host }
  | { type: "window/minimize"; id: WindowId }
  | { type: "window/restore"; id: WindowId }
  | { type: "window/maximize"; id: WindowId; host?: Host }
  | { type: "window/unmaximize"; id: WindowId }
  | { type: "system/hydrate"; persisted: unknown; areas?: Area[] }
  | { type: "system/reflow"; areas: Area[]; host?: Host }
  | { type: "system/native-state"; windowId: WindowId; url?: string; title?: string; loading?: boolean };

export const MIN_WINDOW_W: number;
export const MIN_WINDOW_H: number;
export const AREA_TOP: number;
export const AREA_BOTTOM: number;
export const TITLE_BAR_H: number;
export const KIND: { APP: "app"; BROWSER: "browser" };
export const WSTATE: { NORMAL: "normal"; MINIMIZED: "minimized"; MAXIMIZED: "maximized" };
export const FOLDER_PREFIX: string;
export const NATIVE_APPS: Set<string>;

export function kindOf(appId: AppId): WindowKind;
export function isNativeKind(kind: WindowKind): boolean;
export function normalizeBounds(b: Partial<Bounds> | null | undefined, fallback?: Bounds): Bounds;
export function createWindow(spec: Record<string, unknown>, index?: number): Window;
export function createState(): WindowStateModel;
export function reindex(state: WindowStateModel): WindowStateModel;
export function byId(state: WindowStateModel, id: WindowId): Window | null;
export function windowsOfApp(state: WindowStateModel, appId: AppId): WindowId[];
export function visibleWindows(state: WindowStateModel): WindowId[];
export function focusedWindow(state: WindowStateModel): Window | null;
export function actionableId(state: WindowStateModel): WindowId | null;
export function isFocused(state: WindowStateModel, id: WindowId): boolean;
export function zOf(state: WindowStateModel, id: WindowId): number;
export function aboveWindows(
  state: WindowStateModel,
  id: WindowId,
): { id: WindowId; x: number; y: number; width: number; height: number }[];
export function invariants(state: WindowStateModel): string[];
export function toPersisted(state: WindowStateModel): { v: number; windows: unknown[] };
export function fromPersisted(raw: unknown, clampAreas?: Area[]): WindowStateModel;
export function isPersistable(raw: unknown): boolean;
export function clamp(v: number, lo: number, hi: number): number;

declare const domain: {
  MIN_WINDOW_W: typeof MIN_WINDOW_W;
  MIN_WINDOW_H: typeof MIN_WINDOW_H;
  AREA_TOP: typeof AREA_TOP;
  AREA_BOTTOM: typeof AREA_BOTTOM;
  TITLE_BAR_H: typeof TITLE_BAR_H;
  KIND: typeof KIND;
  WSTATE: typeof WSTATE;
  FOLDER_PREFIX: typeof FOLDER_PREFIX;
  NATIVE_APPS: typeof NATIVE_APPS;
  kindOf: typeof kindOf;
  isNativeKind: typeof isNativeKind;
  normalizeBounds: typeof normalizeBounds;
  createWindow: typeof createWindow;
  createState: typeof createState;
  reindex: typeof reindex;
  byId: typeof byId;
  windowsOfApp: typeof windowsOfApp;
  visibleWindows: typeof visibleWindows;
  focusedWindow: typeof focusedWindow;
  actionableId: typeof actionableId;
  isFocused: typeof isFocused;
  zOf: typeof zOf;
  aboveWindows: typeof aboveWindows;
  invariants: typeof invariants;
  toPersisted: typeof toPersisted;
  fromPersisted: typeof fromPersisted;
  isPersistable: typeof isPersistable;
  clamp: typeof clamp;
};
export default domain;
