import * as geometry from "./geometry.ts";

export type AppId = string;
export type WindowId = string;
export type WindowKind = "app" | "browser";
export type WindowStateName = "normal" | "minimized" | "maximized";
export type Bounds = { x: number; y: number; w: number; h: number };
export type BrowserTab = { tabId: string; url: string; title: string };
export type WindowMeta = {
  title: string;
  icon: string;
  url?: string;
  tabs?: BrowserTab[];
  activeTabId?: string;
  tabSeq?: number;
};
export type TabGroup = { id: string; appId: AppId; activeWindowId: WindowId; createdAt: number };
export type TabRestore = { bounds: Bounds; state: WindowStateName; restore: Bounds | null };
export type Window = {
  id: WindowId;
  appId: AppId;
  kind: WindowKind;
  bounds: Bounds;
  state: WindowStateName;
  restore: Bounds | null;
  minSize: { w: number; h: number };
  meta: WindowMeta;
  visible: boolean;
  displayId: number | string | null;
  tabGroupId: string | null;
  tabRestore: TabRestore | null;
  z: number;
};
export type WindowStateModel = {
  windows: Window[];
  order: WindowId[];
  focused: WindowId | null;
  seq: number;
  tabGroups: Record<string, TabGroup>;
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
  | { type: "system/native-state"; windowId: WindowId; url?: string; title?: string; loading?: boolean; tabId?: string }
  | { type: "browser/tab-open"; id: WindowId; tabId: string; url?: string }
  | { type: "browser/tab-close"; id: WindowId; tabId: string }
  | { type: "browser/tab-activate"; id: WindowId; tabId: string }
  | { type: "browser/tab-state"; windowId: WindowId; tabId?: string; url?: string; title?: string }
  | { type: "window/tab-group-merge"; ids?: WindowId[]; windowId?: WindowId; targetWindowId?: WindowId; groupId?: string; activeId?: WindowId }
  | { type: "window/tab-group-auto"; appId: AppId }
  | { type: "window/tab-group-split"; id?: WindowId; groupId?: string }
  | { type: "window/tab-group-activate"; id?: WindowId; windowId?: WindowId; groupId?: string; focus?: boolean }
  | { type: "window/tab-group-close"; id?: WindowId; groupId?: string };

export const MIN_WINDOW_W = 560;
export const MIN_WINDOW_H = 400;
export const AREA_TOP = 38;
export const AREA_BOTTOM = 114;
export const TITLE_BAR_H = 44;
export const BROWSER_CHROME_H = 90;
export const KIND = { APP: "app", BROWSER: "browser" } as const;
export const WSTATE = { NORMAL: "normal", MINIMIZED: "minimized", MAXIMIZED: "maximized" } as const;
export const FOLDER_PREFIX = "folder:";
export const TAB_LIMIT = 12;
export const NATIVE_APPS = new Set(["browser"]);

export const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));
const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function kindOf(appId: AppId): WindowKind {
  return NATIVE_APPS.has(appId) ? KIND.BROWSER : KIND.APP;
}
export function isNativeKind(kind: WindowKind): boolean {
  return kind === KIND.BROWSER;
}

export function normalizeBounds(input: Partial<Bounds> | null | undefined, fallback: Bounds = { x: 120, y: 100, w: 830, h: 570 }): Bounds {
  const source = input && typeof input === "object" ? input : {};
  const pick = (key: keyof Bounds): number => isNum(source[key]) ? Math.round(source[key]) : fallback[key];
  return {
    x: Math.max(0, pick("x")),
    y: Math.max(AREA_TOP, pick("y")),
    w: Math.max(MIN_WINDOW_W, pick("w")),
    h: Math.max(MIN_WINDOW_H, pick("h")),
  };
}

export function normalizeBrowserMeta(meta: any = {}): { tabs: BrowserTab[]; activeTabId: string; tabSeq: number } {
  const raw = Array.isArray(meta.tabs) ? meta.tabs : [];
  const tabs: BrowserTab[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (tabs.length >= TAB_LIMIT) break;
    if (!item || typeof item !== "object") continue;
    const tabId = typeof item.tabId === "string" && item.tabId ? item.tabId : "";
    if (!tabId || seen.has(tabId)) continue;
    seen.add(tabId);
    tabs.push({ tabId, url: typeof item.url === "string" ? item.url : "", title: typeof item.title === "string" ? item.title : "" });
  }
  if (!tabs.length && typeof meta.url === "string" && meta.url) tabs.push({ tabId: "t1", url: meta.url, title: "" });
  if (!tabs.length) tabs.push({ tabId: "t1", url: "", title: "" });
  const seq = Number(meta.tabSeq);
  const tabSeq = Number.isFinite(seq) && seq >= tabs.length ? Math.floor(seq) : tabs.length;
  const activeTabId = tabs.some((tab) => tab.tabId === meta.activeTabId) ? meta.activeTabId : tabs[tabs.length - 1].tabId;
  return { tabs, activeTabId, tabSeq };
}

export const tabsOf = (window: Window | null | undefined): BrowserTab[] => window && Array.isArray(window.meta?.tabs) ? window.meta.tabs : [];
export const activeTabIdOf = (window: Window | null | undefined): string | null => window?.meta?.activeTabId ? String(window.meta.activeTabId) : tabsOf(window)[0]?.tabId || null;
export const activeTabOf = (window: Window | null | undefined): BrowserTab | null => tabsOf(window).find((tab) => tab.tabId === activeTabIdOf(window)) || null;

export function createWindow(spec: any, index = 0): Window {
  const appId = String(spec.appId);
  const kind = spec.kind || kindOf(appId);
  const state = spec.state === WSTATE.MINIMIZED || spec.state === WSTATE.MAXIMIZED ? spec.state : WSTATE.NORMAL;
  return {
    id: String(spec.id),
    appId,
    kind,
    bounds: normalizeBounds(spec.bounds, { x: 120 + index * 22, y: 100 + index * 18, w: 830, h: 570 }),
    state,
    restore: state === WSTATE.MAXIMIZED ? normalizeBounds(spec.restore || spec.bounds) : null,
    minSize: {
      w: isNum(spec.minSize?.w) ? Math.max(1, Math.round(spec.minSize.w)) : MIN_WINDOW_W,
      h: isNum(spec.minSize?.h) ? Math.max(1, Math.round(spec.minSize.h)) : MIN_WINDOW_H,
    },
    meta: (() => {
      const meta: WindowMeta = {
        title: String(spec.meta?.title || spec.id),
        icon: String(spec.meta?.icon || "apps"),
        ...(spec.meta?.url ? { url: String(spec.meta.url) } : {}),
      };
      if (kind === KIND.BROWSER) Object.assign(meta, normalizeBrowserMeta(spec.meta));
      return meta;
    })(),
    visible: state !== WSTATE.MINIMIZED,
    displayId: spec.displayId ?? null,
    tabGroupId: typeof spec.tabGroupId === "string" && spec.tabGroupId ? spec.tabGroupId : null,
    tabRestore: spec.tabRestore && typeof spec.tabRestore === "object" ? spec.tabRestore : null,
    z: index,
  };
}

export function createState(): WindowStateModel {
  return { windows: [], order: [], focused: null, seq: 0, tabGroups: {} };
}

/** z-order 的唯一真值是 order；windows 数组始终保持创建序，避免聚焦时移动 DOM 节点。 */
export function reindex(state: WindowStateModel): WindowStateModel {
  const byId = new Map(state.windows.map((window) => [window.id, window]));
  const seen = new Set<string>();
  const order: WindowId[] = [];
  for (const id of state.order) {
    if (byId.has(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  for (const window of state.windows) {
    if (!seen.has(window.id)) {
      seen.add(window.id);
      order.push(window.id);
    }
  }
  const zOf = new Map(order.map((id, index) => [id, index]));
  const tabGroups = state.tabGroups && typeof state.tabGroups === "object" ? state.tabGroups : {};
  const windows = state.windows.map((window) => {
    const z = zOf.get(window.id) as number;
    const group = window.tabGroupId ? tabGroups[window.tabGroupId] : null;
    const visible = window.state !== WSTATE.MINIMIZED && (!window.tabGroupId || !group || group.activeWindowId === window.id);
    return window.z === z && window.visible === visible ? window : { ...window, z, visible };
  });
  const focusedWindow = state.focused ? byId.get(state.focused) : null;
  const focusedGroup = focusedWindow && focusedWindow.tabGroupId ? tabGroups[focusedWindow.tabGroupId] : null;
  const focusedVisible = !!focusedWindow && focusedWindow.state !== WSTATE.MINIMIZED && (!focusedWindow.tabGroupId || !focusedGroup || focusedGroup.activeWindowId === focusedWindow.id);
  const focused = focusedVisible ? state.focused : null;
  if (focused === state.focused && order.length === state.order.length && order.every((id, index) => id === state.order[index]) && windows.every((window, index) => window === state.windows[index])) return state;
  return { ...state, windows, order, focused };
}

export const byId = (state: WindowStateModel, id: WindowId): Window | null => state.windows.find((window) => window.id === id) || null;
export const windowsOfApp = (state: WindowStateModel, appId: AppId): WindowId[] => state.order.filter((id) => byId(state, id)?.appId === appId);
export const tabGroupOfWindow = (state: WindowStateModel, id: WindowId): TabGroup | null => {
  const window = byId(state, id);
  if (!window || !window.tabGroupId) return null;
  const group = state.tabGroups && state.tabGroups[window.tabGroupId];
  return group && group.id === window.tabGroupId ? group : null;
};
export const windowsOfTabGroup = (state: WindowStateModel, groupId: string): WindowId[] => state.order.filter((id) => byId(state, id)?.tabGroupId === groupId);
export const activeTabGroupWindow = (state: WindowStateModel, groupId: string): Window | null => {
  const group = state.tabGroups && state.tabGroups[groupId];
  return group && group.activeWindowId ? byId(state, group.activeWindowId) : null;
};
export const visibleWindows = (state: WindowStateModel): WindowId[] => state.order.filter((id) => {
  const window = byId(state, id);
  return !!window && window.state !== WSTATE.MINIMIZED && window.visible !== false;
});
export const focusedWindow = (state: WindowStateModel): Window | null => state.focused ? byId(state, state.focused) : null;
export const actionableId = (state: WindowStateModel): WindowId | null => {
  const window = focusedWindow(state);
  return window && window.state !== WSTATE.MINIMIZED ? window.id : null;
};
export const isFocused = (state: WindowStateModel, id: WindowId): boolean => state.focused === id;
export const zOf = (state: WindowStateModel, id: WindowId): number => {
  const index = state.order.indexOf(id);
  return index < 0 ? -1 : index;
};
export function aboveWindows(state: WindowStateModel, id: WindowId): { id: WindowId; x: number; y: number; width: number; height: number }[] {
  const index = zOf(state, id);
  if (index < 0) return [];
  return state.order.slice(index + 1).map((windowId) => byId(state, windowId)).filter((window): window is Window => !!window && window.state !== WSTATE.MINIMIZED)
    .map((window) => ({ id: window.id, x: window.bounds.x, y: window.bounds.y, width: window.bounds.w, height: window.bounds.h }));
}

export function invariants(state: WindowStateModel): string[] {
  const bad: string[] = [];
  const ids = new Set(state.windows.map((window) => window.id));
  if (state.order.length !== ids.size) bad.push("order 与 windows 数量不一致");
  if (new Set(state.order).size !== state.order.length) bad.push("order 有重复 id");
  for (const id of state.order) if (!ids.has(id)) bad.push(`order 含不存在的 id ${id}`);
  for (const window of state.windows) {
    const index = state.order.indexOf(window.id);
    if (index < 0) bad.push(`window ${window.id} 不在 order 中`);
    else if (window.z !== index) bad.push(`window ${window.id} 的 z=${window.z} 与 order 下标 ${index} 不一致`);
    const group = window.tabGroupId ? state.tabGroups && state.tabGroups[window.tabGroupId] : null;
    const expectVisible = window.state !== WSTATE.MINIMIZED && (!window.tabGroupId || !group || group.activeWindowId === window.id);
    if (window.visible !== expectVisible) bad.push(`window ${window.id} 的 visible 与 state/标签组不一致`);
    if (window.tabGroupId && !group) bad.push(`window ${window.id} 引用了不存在的标签组 ${window.tabGroupId}`);
    if (window.bounds.w < window.minSize.w || window.bounds.h < window.minSize.h) bad.push(`window ${window.id} 小于最小尺寸`);
    if (window.kind === KIND.BROWSER) {
      const tabs = tabsOf(window);
      const tabIds = new Set(tabs.map((tab) => tab.tabId));
      if (!tabs.length) bad.push(`浏览器窗口 ${window.id} 没有标签`);
      if (tabs.length > TAB_LIMIT) bad.push(`浏览器窗口 ${window.id} 标签数超过上限`);
      if (tabIds.size !== tabs.length) bad.push(`浏览器窗口 ${window.id} 标签 id 重复`);
      if (!tabIds.has(String(window.meta.activeTabId))) bad.push(`浏览器窗口 ${window.id} 的 activeTabId 不在标签集合内`);
      if (!Number.isFinite(window.meta.tabSeq) || Number(window.meta.tabSeq) < tabs.length) bad.push(`浏览器窗口 ${window.id} 的 tabSeq 无效`);
      const active = activeTabOf(window);
      if ((window.meta.url || "") !== (active ? active.url : "")) bad.push(`浏览器窗口 ${window.id} 的 meta.url 与活动标签不一致`);
    }
    if (window.state === WSTATE.MAXIMIZED && !window.restore) bad.push(`window ${window.id} 最大化但没有 restore`);
  }
  const groups = state.tabGroups && typeof state.tabGroups === "object" ? state.tabGroups : {};
  for (const [groupId, group] of Object.entries(groups)) {
    if (!group || typeof group !== "object") { bad.push("标签组 " + groupId + " 不是对象"); continue; }
    if (group.id !== groupId) bad.push("标签组 " + groupId + " 的 id 不一致");
    const members = windowsOfTabGroup(state, groupId);
    if (members.length < 2) bad.push("标签组 " + groupId + " 成员少于 2");
    const appIds = new Set(members.map((id) => byId(state, id)?.appId));
    if (appIds.size > 1) bad.push("标签组 " + groupId + " 混入不同 App");
    if (group.appId && !appIds.has(group.appId)) bad.push("标签组 " + groupId + " 的 appId 与成员不一致");
    if (!group.activeWindowId || !members.includes(group.activeWindowId)) bad.push("标签组 " + groupId + " 的 activeWindowId 不在成员内");
    if (!Number.isInteger(group.createdAt)) bad.push("标签组 " + groupId + " 缺少 createdAt");
  }
  for (const groupId of Object.keys(groups)) if (windowsOfTabGroup(state, groupId).length === 0) bad.push("标签组 " + groupId + " 没有成员");
  if (state.focused) {
    const focused = byId(state, state.focused);
    if (!focused) bad.push("focused 指向不存在的窗口");
    else if (focused.state === WSTATE.MINIMIZED) bad.push("focused 指向已最小化的窗口");
    else if (!focused.visible) bad.push("focused 指向标签组非 active 窗口");
  }
  return bad;
}

export function toPersisted(state: WindowStateModel): { v: number; windows: unknown[]; tabGroups: Record<string, TabGroup> } {
  return {
    v: 2,
    windows: state.windows.map((window) => ({
      id: window.id,
      appId: window.appId,
      kind: window.kind,
      bounds: { ...window.bounds },
      state: window.state,
      restore: window.restore ? { ...window.restore } : null,
      minSize: { ...window.minSize },
      meta: { ...window.meta },
      displayId: window.displayId,
      tabGroupId: window.tabGroupId || null,
      tabRestore: window.tabRestore ? { ...window.tabRestore, bounds: window.tabRestore.bounds ? { ...window.tabRestore.bounds } : null } : null,
    })),
    tabGroups: Object.fromEntries(Object.entries(state.tabGroups || {}).map(([id, group]) => [id, { ...group }])),
  };
}

export function fromPersisted(raw: any, clampAreas?: Area[]): WindowStateModel {
  const state = createState();
  const list = Array.isArray(raw?.windows) ? raw.windows : [];
  const seen = new Set<string>();
  const restored: Window[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = item.id;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    restored.push(createWindow({
      id,
      appId: typeof item.appId === "string" && item.appId ? item.appId : id,
      kind: item.kind,
      bounds: item.bounds,
      state: item.state,
      restore: item.restore,
      minSize: item.minSize,
      meta: item.meta,
      displayId: item.displayId,
      tabGroupId: item.tabGroupId,
      tabRestore: item.tabRestore,
    }, restored.length));
  }
  const rawGroups = raw && typeof raw.tabGroups === "object" && !Array.isArray(raw.tabGroups) ? raw.tabGroups : {};
  const groups: Record<string, TabGroup> = {};
  for (const [groupId, rawGroup] of Object.entries(rawGroups)) {
    if (!rawGroup || typeof rawGroup !== "object") continue;
    const members = restored.filter((window) => window.tabGroupId === groupId);
    if (members.length < 2) continue;
    const appIds = new Set(members.map((window) => window.appId));
    if (appIds.size > 1) continue;
    const active = members.find((window) => window.id === (rawGroup as TabGroup).activeWindowId) || members[0];
    groups[groupId] = { id: groupId, appId: members[0].appId, activeWindowId: active.id, createdAt: Number.isInteger((rawGroup as TabGroup).createdAt) ? (rawGroup as TabGroup).createdAt : 0 };
  }
  for (const window of restored) {
    if (!window.tabGroupId) continue;
    if (!groups[window.tabGroupId]) {
      window.tabGroupId = null;
      window.tabRestore = null;
    } else {
      const group = groups[window.tabGroupId];
      const active = restored.find((item) => item.id === group.activeWindowId);
      if (active) window.bounds = { ...active.bounds };
    }
  }
  if (clampAreas && clampAreas.length && restored.length) {
    const flat = geometry.clampAll(restored.map((window) => ({ ...window, ...window.bounds })), clampAreas);
    const flatRestore = geometry.clampAll(restored.map((window) => ({ ...(window.restore || window.bounds), ...(window.restore || window.bounds) })), clampAreas);
    restored.forEach((window, index) => {
      const rect = flat[index];
      const restore = flatRestore[index];
      window.bounds = normalizeBounds({ x: rect.x, y: rect.y, w: rect.w, h: rect.h }, window.bounds);
      if (window.restore) window.restore = normalizeBounds({ x: restore.x, y: restore.y, w: restore.w, h: restore.h }, window.restore);
    });
  }
  for (const group of Object.values(groups)) {
    const active = restored.find((window) => window.id === group.activeWindowId);
    if (!active) continue;
    for (const window of restored) if (window.tabGroupId === group.id) window.bounds = { ...active.bounds };
  }
  for (const window of restored) if (window.tabRestore && window.tabRestore.bounds) window.tabRestore = { ...window.tabRestore, bounds: normalizeBounds(window.tabRestore.bounds, window.bounds) };
  state.windows = restored;
  state.order = restored.map((window) => window.id);
  state.tabGroups = groups;
  state.focused = null;
  return reindex(state);
}

export function isPersistable(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && Array.isArray((raw as { windows?: unknown }).windows);
}
