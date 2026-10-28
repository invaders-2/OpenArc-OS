import * as domain from "./window-domain.ts";
import * as geometry from "./geometry.ts";
import type { Area, Host, Window, WindowCommand, WindowStateModel } from "./window-domain.ts";

export type NativeViewIntent = { viewId: string; tabId: string; url: string; active: boolean };
export type NativeIntent = {
  windowId: string;
  appId: string;
  url: string;
  views?: NativeViewIntent[];
  present: boolean;
  focused: boolean;
  viewport: { x: number; y: number; width: number; height: number };
  occluders: { id: string; x: number; y: number; width: number; height: number }[];
};

const { WSTATE, AREA_TOP, AREA_BOTTOM, MIN_WINDOW_W, MIN_WINDOW_H } = domain;

export function areaOf(host: Host | undefined): Area {
  const width = Math.max(MIN_WINDOW_W, Math.round(host?.width || 0));
  const height = Math.max(MIN_WINDOW_H, Math.round((host?.height || 0) - AREA_TOP - AREA_BOTTOM));
  return { x: 0, y: AREA_TOP, width, height };
}

export function maximizedBounds(host: Host | undefined): { x: number; y: number; w: number; h: number } {
  const width = Math.max(MIN_WINDOW_W, Math.round(host?.width || 0));
  const height = Math.max(MIN_WINDOW_H, Math.round((host?.height || 0) - AREA_TOP));
  return { x: 0, y: AREA_TOP, w: width, h: height };
}

export const clone = (state: WindowStateModel): WindowStateModel => ({
  ...state,
  windows: state.windows.map((window) => ({ ...window })),
  order: [...state.order],
});

export function topmostVisible(state: WindowStateModel, exceptId: string | null): string | null {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const id = state.order[index];
    if (id === exceptId) continue;
    const window = domain.byId(state, id);
    if (window && window.state !== WSTATE.MINIMIZED) return id;
  }
  return null;
}

export function raise(state: WindowStateModel, id: string): WindowStateModel {
  if (state.order[state.order.length - 1] === id) return state;
  return { ...state, order: [...state.order.filter((item) => item !== id), id] };
}

const sameApp = (windows: Window[]): boolean => new Set(windows.map((window) => window.appId)).size === 1;
const uniqueIds = (values: unknown[]): string[] => [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "")).filter(Boolean))];

function nextGroupId(state: WindowStateModel): { id: string; seq: number } {
  let seq = Number(state.seq) || 0;
  for (;;) {
    seq += 1;
    const id = "tg:" + seq;
    if (!state.tabGroups || !state.tabGroups[id]) return { id, seq };
  }
}

function restoreSnapshot(window: Window): domain.TabRestore {
  return window.tabRestore && typeof window.tabRestore === "object"
    ? { bounds: domain.normalizeBounds(window.tabRestore.bounds, window.bounds), state: window.tabRestore.state || WSTATE.NORMAL, restore: window.tabRestore.restore || null }
    : { bounds: { ...window.bounds }, state: WSTATE.NORMAL, restore: null };
}

function withGroupMembers(state: WindowStateModel, groupId: string, mapMember: (window: Window) => Window): WindowStateModel {
  return { ...state, windows: state.windows.map((window) => window.tabGroupId === groupId ? mapMember(window) : window) };
}

function setGroupGeometry(state: WindowStateModel, groupId: string, bounds: domain.Bounds): WindowStateModel {
  return withGroupMembers(state, groupId, (window) => ({ ...window, bounds: { ...bounds } }));
}

function reconcileGroupAfterRemoval(state: WindowStateModel, groupId: string, removedId: string): WindowStateModel {
  const group = state.tabGroups && state.tabGroups[groupId];
  if (!group) return state;
  const members = domain.windowsOfTabGroup(state, groupId);
  const nextGroups = { ...state.tabGroups };
  if (members.length >= 2) {
    nextGroups[groupId] = { ...group, activeWindowId: group.activeWindowId === removedId ? members[members.length - 1] : group.activeWindowId };
    return { ...state, tabGroups: nextGroups };
  }
  delete nextGroups[groupId];
  let next = { ...state, tabGroups: nextGroups };
  for (const id of members) {
    const member = domain.byId(next, id);
    if (!member) continue;
    const snapshot = restoreSnapshot(member);
    next = {
      ...next,
      windows: next.windows.map((window) => window.id === id ? { ...window, tabGroupId: null, tabRestore: null, bounds: snapshot.bounds, state: snapshot.state, restore: snapshot.restore } : window),
    };
  }
  return next;
}

function activateGroupWindow(state: WindowStateModel, id: string, { focus = true } = {}): WindowStateModel {
  const window = domain.byId(state, id);
  if (!window) return state;
  const group = domain.tabGroupOfWindow(state, id);
  if (!group) return state;
  const bounds = { ...window.bounds };
  let next = {
    ...state,
    tabGroups: { ...state.tabGroups, [group.id]: { ...group, activeWindowId: id } },
    windows: state.windows.map((item) => item.tabGroupId === group.id ? {
      ...item,
      bounds: { ...bounds },
      state: item.id === id && item.state === WSTATE.MINIMIZED ? WSTATE.NORMAL : item.state,
      restore: item.id === id && item.state === WSTATE.MINIMIZED ? null : item.restore,
    } : item),
  };
  if (focus) {
    next = { ...next, focused: id };
    return domain.reindex(raise(next, id));
  }
  return domain.reindex(next);
}

function tabGroupMerge(state: WindowStateModel, cmd: any): WindowStateModel {
  const requestedIds = uniqueIds([...(Array.isArray(cmd.ids) ? cmd.ids : []), cmd.windowId, cmd.targetWindowId]);
  const requestedWindows = requestedIds.map((id) => domain.byId(state, id)).filter((window): window is Window => !!window);
  const explicitGroupId = cmd.groupId ? String(cmd.groupId) : null;
  const targetGroup = explicitGroupId ? state.tabGroups && state.tabGroups[explicitGroupId] : null;
  let ids = requestedIds;
  let windows = requestedWindows;
  if (targetGroup) {
    ids = uniqueIds([...domain.windowsOfTabGroup(state, targetGroup.id), ...requestedIds]);
    windows = ids.map((id) => domain.byId(state, id)).filter((window): window is Window => !!window);
  }
  if (windows.length < 2 || !sameApp(windows)) return state;
  const groupedIds = windows.filter((window) => window.tabGroupId);
  if (targetGroup) {
    if (targetGroup.appId !== windows[0].appId) return state;
    if (groupedIds.some((window) => window.tabGroupId !== targetGroup.id)) return state;
  } else if (groupedIds.length) return state;
  let groupId: string;
  let seq = Number(state.seq) || 0;
  if (targetGroup) groupId = targetGroup.id;
  else { const created = nextGroupId(state); groupId = created.id; seq = created.seq; }
  const requestedActive = cmd.activeId ? String(cmd.activeId) : null;
  const active = windows.find((window) => window.id === requestedActive) || windows.find((window) => window.id === state.focused) || windows[windows.length - 1];
  const bounds = { ...active.bounds };
  const next = {
    ...state,
    seq,
    tabGroups: {
      ...state.tabGroups,
      [groupId]: { id: groupId, appId: windows[0].appId, activeWindowId: active.id, createdAt: targetGroup ? targetGroup.createdAt : seq },
    },
    windows: state.windows.map((window) => {
      if (!ids.includes(window.id)) return window;
      const tabRestore = window.tabRestore || { bounds: { ...window.bounds }, state: window.state, restore: window.restore ? { ...window.restore } : null };
      return { ...window, tabGroupId: groupId, tabRestore, bounds: { ...bounds }, state: WSTATE.NORMAL, restore: null };
    }),
  };
  next.focused = active.id;
  return domain.reindex(raise(next, active.id));
}

function tabGroupAuto(state: WindowStateModel, cmd: any): WindowStateModel {
  const appId = String(cmd.appId || "");
  if (!appId) return state;
  const ids = domain.windowsOfApp(state, appId);
  if (ids.length < 2) return state;
  const groups = Object.values(state.tabGroups || {}).filter((group) => group.appId === appId);
  if (groups.length > 1) return state;
  if (groups.length === 1) {
    const ungrouped = ids.filter((id) => !domain.byId(state, id)?.tabGroupId);
    if (!ungrouped.length) return state;
    return tabGroupMerge(state, { groupId: groups[0].id, ids: [...domain.windowsOfTabGroup(state, groups[0].id), ...ungrouped], activeId: groups[0].activeWindowId });
  }
  return tabGroupMerge(state, { ids });
}

function tabGroupActivate(state: WindowStateModel, cmd: any): WindowStateModel {
  const group = cmd.groupId ? state.tabGroups && state.tabGroups[cmd.groupId] : null;
  const id = String(cmd.id || cmd.windowId || (group && group.activeWindowId) || "");
  if (!id || !domain.byId(state, id)) return state;
  return activateGroupWindow(state, id, { focus: cmd.focus !== false });
}

function tabGroupSplit(state: WindowStateModel, cmd: any): WindowStateModel {
  const id = cmd.id != null ? String(cmd.id) : "";
  const groupId = cmd.groupId != null ? String(cmd.groupId) : (id ? domain.tabGroupOfWindow(state, id)?.id || "" : "");
  const group = groupId ? state.tabGroups && state.tabGroups[groupId] : null;
  if (!group) return state;
  const members = domain.windowsOfTabGroup(state, groupId);
  const splitWhole = !id || members.length <= 2;
  let next = { ...state, tabGroups: { ...state.tabGroups } };
  const targets = splitWhole ? members : [id];
  if (!splitWhole && !members.includes(id)) return state;
  for (const memberId of targets) {
    const member = domain.byId(next, memberId);
    if (!member) continue;
    const snapshot = restoreSnapshot(member);
    next = {
      ...next,
      windows: next.windows.map((window) => window.id === memberId ? { ...window, tabGroupId: null, tabRestore: null, bounds: snapshot.bounds, state: snapshot.state, restore: snapshot.restore } : window),
    };
  }
  if (splitWhole) delete next.tabGroups[groupId];
  else {
    const remaining = members.filter((memberId) => memberId !== id);
    next.tabGroups[groupId] = { ...group, activeWindowId: group.activeWindowId === id ? remaining[0] : group.activeWindowId };
    if (next.focused === id) next.focused = remaining[0] || null;
  }
  return domain.reindex(next);
}

function tabGroupClose(state: WindowStateModel, cmd: any): WindowStateModel {
  const groupId = cmd.groupId != null ? String(cmd.groupId) : domain.tabGroupOfWindow(state, String(cmd.id || ""))?.id;
  if (!groupId || !state.tabGroups || !state.tabGroups[groupId]) return state;
  const members = domain.windowsOfTabGroup(state, groupId);
  let next = state;
  for (const id of members) next = close(next, { id });
  return next;
}

function topAndFocus(state: WindowStateModel, id: string): WindowStateModel {
  const window = domain.byId(state, id);
  if (!window) return state;
  const group = domain.tabGroupOfWindow(state, id);
  const alreadyTop = state.order[state.order.length - 1] === id;
  if (alreadyTop && state.focused === id && window.state !== WSTATE.MINIMIZED && (!group || group.activeWindowId === id)) return state;
  let next = {
    ...state,
    windows: state.windows.map((item) => item.id === id && item.state === WSTATE.MINIMIZED ? { ...item, state: WSTATE.NORMAL } : item),
  };
  if (group) {
    next = {
      ...next,
      tabGroups: { ...state.tabGroups, [group.id]: { ...group, activeWindowId: id } },
      windows: next.windows.map((item) => item.tabGroupId === group.id ? { ...item, bounds: { ...window.bounds } } : item),
    };
  }
  next.focused = id;
  return domain.reindex(raise(next, id));
}

function open(state: WindowStateModel, cmd: any): WindowStateModel {
  const appId = String(cmd.appId ?? cmd.id ?? "");
  if (!appId) return state;
  const id = String(cmd.id ?? appId);
  const existing = domain.byId(state, id);
  if (existing) return focus(state, { id });
  const index = state.windows.length;
  const window = domain.createWindow({ id, appId, kind: cmd.kind, bounds: cmd.bounds, minSize: cmd.minSize, meta: cmd.meta, displayId: cmd.displayId }, index);
  const next = { ...state, seq: state.seq + 1, windows: [...state.windows, window], order: [...state.order, id] };
  next.focused = id;
  const opened = domain.reindex(next);
  if (cmd.tabGroupId && opened.tabGroups && opened.tabGroups[cmd.tabGroupId] && opened.tabGroups[cmd.tabGroupId].appId === appId) {
    return tabGroupMerge(opened, { groupId: cmd.tabGroupId, ids: [...domain.windowsOfTabGroup(opened, cmd.tabGroupId), id], activeId: id });
  }
  return opened;
}

function close(state: WindowStateModel, cmd: any): WindowStateModel {
  const id = String(cmd.id ?? "");
  const target = domain.byId(state, id);
  if (!target) return state;
  const groupId = target.tabGroupId;
  const groupMembersBefore = groupId ? domain.windowsOfTabGroup(state, groupId) : [];
  const closingGroupActive = !!groupId && !!state.tabGroups[groupId] && state.tabGroups[groupId].activeWindowId === id;
  let next = { ...state, windows: state.windows.filter((window) => window.id !== id), order: state.order.filter((item) => item !== id) };
  if (groupId) next = reconcileGroupAfterRemoval(next, groupId, id);
  if (state.focused === id) {
    const group = groupId ? next.tabGroups && next.tabGroups[groupId] : null;
    if (group) next.focused = group.activeWindowId;
    else if (closingGroupActive) {
      const survivor = groupMembersBefore.find((memberId) => memberId !== id && domain.byId(next, memberId));
      if (survivor) next = raise(next, survivor);
      next.focused = survivor || topmostVisible(next, null);
    } else next.focused = topmostVisible(next, null);
  }
  return domain.reindex(next);
}

function focus(state: WindowStateModel, cmd: any): WindowStateModel {
  return topAndFocus(state, String(cmd.id ?? ""));
}

function move(state: WindowStateModel, cmd: any): WindowStateModel {
  const id = String(cmd.id ?? "");
  const window = domain.byId(state, id);
  if (!window || window.state === WSTATE.MAXIMIZED) return state;
  const host = cmd.host || {};
  const x = Math.max(0, Math.min(Math.round(host.width || 0) - window.bounds.w, Math.round(cmd.x)));
  const y = Math.max(AREA_TOP, Math.min(Math.round(host.height || 0) - 140, Math.round(cmd.y)));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return state;
  if (x === window.bounds.x && y === window.bounds.y) return state;
  const targetBounds = { ...window.bounds, x, y };
  const next = window.tabGroupId ? setGroupGeometry(state, window.tabGroupId, targetBounds) : {
    ...state,
    windows: state.windows.map((item) => item.id === id ? { ...item, bounds: targetBounds } : item),
  };
  return domain.reindex(next);
}

function resize(state: WindowStateModel, cmd: any): WindowStateModel {
  const id = String(cmd.id ?? "");
  const window = domain.byId(state, id);
  if (!window || window.state === WSTATE.MAXIMIZED) return state;
  const host = cmd.host || {};
  const maxW = Math.max(window.minSize.w, Math.round((host.width || 0) - window.bounds.x));
  const maxH = Math.max(window.minSize.h, Math.round((host.height || 0) - 100 - window.bounds.y));
  const nw = Math.max(window.minSize.w, Math.min(maxW, Math.round(cmd.w)));
  const nh = Math.max(window.minSize.h, Math.min(maxH, Math.round(cmd.h)));
  if (!Number.isFinite(nw) || !Number.isFinite(nh)) return state;
  if (nw === window.bounds.w && nh === window.bounds.h) return state;
  const targetBounds = { ...window.bounds, w: nw, h: nh };
  const next = window.tabGroupId ? setGroupGeometry(state, window.tabGroupId, targetBounds) : {
    ...state,
    windows: state.windows.map((item) => item.id === id ? { ...item, bounds: targetBounds } : item),
  };
  return domain.reindex(next);
}

function minimize(state: WindowStateModel, cmd: any): WindowStateModel {
  const id = String(cmd.id ?? "");
  const window = domain.byId(state, id);
  if (!window || window.state === WSTATE.MINIMIZED) return state;
  const next = {
    ...state,
    windows: state.windows.map((item) => item.id === id || (window.tabGroupId && item.tabGroupId === window.tabGroupId) ? { ...item, state: WSTATE.MINIMIZED } : item),
  };
  if (state.focused === id) next.focused = topmostVisible(next, id);
  return domain.reindex(next);
}

function restore(state: WindowStateModel, cmd: any): WindowStateModel {
  return topAndFocus(state, String(cmd.id ?? ""));
}

function maximize(state: WindowStateModel, cmd: any): WindowStateModel {
  const id = String(cmd.id ?? "");
  const window = domain.byId(state, id);
  if (!window || window.state === WSTATE.MAXIMIZED) return state;
  const maxRect = maximizedBounds(cmd.host);
  const next = {
    ...state,
    windows: state.windows.map((item) => item.id === id || (window.tabGroupId && item.tabGroupId === window.tabGroupId) ? {
      ...item,
      state: WSTATE.MAXIMIZED,
      restore: { ...item.bounds },
      bounds: { ...maxRect },
    } : item),
  };
  next.focused = id;
  return domain.reindex(raise(next, id));
}

function unmaximize(state: WindowStateModel, cmd: any): WindowStateModel {
  const id = String(cmd.id ?? "");
  const window = domain.byId(state, id);
  if (!window || window.state !== WSTATE.MAXIMIZED) return state;
  const target = window.restore ? domain.normalizeBounds(window.restore, window.bounds) : window.bounds;
  const next = {
    ...state,
    windows: state.windows.map((item) => item.id === id || (window.tabGroupId && item.tabGroupId === window.tabGroupId) ? { ...item, state: WSTATE.NORMAL, bounds: { ...target }, restore: null } : item),
  };
  next.focused = id;
  return domain.reindex(raise(next, id));
}

function hydrate(_state: WindowStateModel, cmd: any): WindowStateModel {
  return domain.fromPersisted(cmd?.persisted, cmd?.areas);
}

function reflow(state: WindowStateModel, cmd: any): WindowStateModel {
  const areas = (cmd?.areas || []).filter(Boolean);
  if (!areas.length) return state;
  const flattened = state.windows.map((window) => ({ ...window, ...window.bounds }));
  const clamped = geometry.clampAll(flattened, areas);
  const maxRect = maximizedBounds(cmd.host);
  const next = state.windows.map((window, index) => {
    const bounds = clamped[index];
    const nextBounds = window.state === WSTATE.MAXIMIZED ? maxRect : { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
    const restore = window.restore ? (() => {
      const rect = geometry.clampAll([{ ...window.restore, ...window.restore }], areas)[0];
      return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    })() : null;
    const tabRestore = window.tabRestore && window.tabRestore.bounds ? { ...window.tabRestore, bounds: domain.normalizeBounds(window.tabRestore.bounds, window.bounds) } : window.tabRestore;
    return { ...window, bounds: domain.normalizeBounds(nextBounds, window.bounds), restore, tabRestore };
  });
  for (const [groupId, group] of Object.entries(state.tabGroups || {})) {
    const active = next.find((window) => window.id === group.activeWindowId);
    if (!active) continue;
    for (const window of next) if (window.tabGroupId === groupId) window.bounds = { ...active.bounds };
  }
  const same = next.every((window, index) => {
    const old = state.windows[index];
    return window.bounds.x === old.bounds.x && window.bounds.y === old.bounds.y && window.bounds.w === old.bounds.w && window.bounds.h === old.bounds.h
      && JSON.stringify(window.restore) === JSON.stringify(old.restore) && JSON.stringify(window.tabRestore) === JSON.stringify(old.tabRestore);
  });
  if (same) return state;
  return domain.reindex({ ...state, windows: next });
}

function browserWindow(state: WindowStateModel, cmd: any): Window | null {
  const id = String(cmd?.id ?? cmd?.windowId ?? "");
  const window = domain.byId(state, id);
  return window && window.kind === domain.KIND.BROWSER ? window : null;
}

function withMeta(state: WindowStateModel, window: Window, meta: domain.WindowMeta): WindowStateModel {
  const active = meta.tabs?.find((tab) => tab.tabId === meta.activeTabId) || null;
  const next = { ...meta, url: active ? active.url : "" };
  return domain.reindex({ ...state, windows: state.windows.map((item) => item.id === window.id ? { ...item, meta: next } : item) });
}

function tabOpen(state: WindowStateModel, cmd: any): WindowStateModel {
  const window = browserWindow(state, cmd);
  if (!window) return state;
  const tabs = domain.tabsOf(window);
  if (tabs.length >= domain.TAB_LIMIT) return state;
  const tabId = String(cmd.tabId || "");
  if (!tabId || tabs.some((tab) => tab.tabId === tabId)) return state;
  const url = typeof cmd.url === "string" ? cmd.url : "";
  const tabSeq = Math.max(Number(window.meta.tabSeq) || 0, tabs.length) + 1;
  return withMeta(state, window, { ...window.meta, tabs: [...tabs, { tabId, url, title: "" }], activeTabId: tabId, tabSeq });
}

function tabClose(state: WindowStateModel, cmd: any): WindowStateModel {
  const window = browserWindow(state, cmd);
  if (!window) return state;
  const tabs = domain.tabsOf(window);
  if (tabs.length <= 1) return state;
  const tabId = String(cmd.tabId || "");
  const index = tabs.findIndex((tab) => tab.tabId === tabId);
  if (index < 0) return state;
  const next = tabs.filter((tab) => tab.tabId !== tabId);
  const activeTabId = window.meta.activeTabId === tabId ? next[Math.min(index, next.length - 1)].tabId : window.meta.activeTabId;
  return withMeta(state, window, { ...window.meta, tabs: next, activeTabId });
}

function tabActivate(state: WindowStateModel, cmd: any): WindowStateModel {
  const window = browserWindow(state, cmd);
  if (!window) return state;
  const tabId = String(cmd.tabId || "");
  if (!domain.tabsOf(window).some((tab) => tab.tabId === tabId) || window.meta.activeTabId === tabId) return state;
  return withMeta(state, window, { ...window.meta, activeTabId: tabId });
}

function tabState(state: WindowStateModel, cmd: any): WindowStateModel {
  const window = browserWindow(state, { id: cmd?.windowId ?? cmd?.id });
  if (!window) return state;
  const tabs = domain.tabsOf(window);
  const tabId = String(cmd?.tabId || domain.activeTabIdOf(window));
  const index = tabs.findIndex((tab) => tab.tabId === tabId);
  if (index < 0) return state;
  const current = tabs[index];
  const url = typeof cmd?.url === "string" && cmd.url ? cmd.url : current.url;
  const title = typeof cmd?.title === "string" && cmd.title ? cmd.title : current.title;
  const titleChanged = tabId === window.meta.activeTabId && !!title && title !== window.meta.title;
  if (url === current.url && title === current.title && !titleChanged) return state;
  const nextTabs = url === current.url && title === current.title ? tabs : tabs.map((tab) => tab.tabId === tabId ? { ...tab, url, title } : tab);
  const meta = { ...window.meta, tabs: nextTabs };
  if (titleChanged) meta.title = title;
  return withMeta(state, window, meta);
}

function nativeState(state: WindowStateModel, cmd: any): WindowStateModel {
  const id = String(cmd?.windowId ?? "");
  const window = domain.byId(state, id);
  if (!window) return state;
  if (window.kind === domain.KIND.BROWSER) return tabState(state, { windowId: id, tabId: cmd?.tabId ?? domain.activeTabIdOf(window), url: cmd?.url, title: cmd?.title });
  const meta = { ...window.meta };
  if (typeof cmd.title === "string" && cmd.title) meta.title = cmd.title;
  if (typeof cmd.url === "string") meta.url = cmd.url;
  const same = meta.title === window.meta.title && meta.url === window.meta.url;
  if (same) return state;
  return domain.reindex({ ...state, windows: state.windows.map((item) => item.id === id ? { ...item, meta } : item) });
}

export const REDUCERS: Record<string, (state: WindowStateModel, command: any) => WindowStateModel> = {
  "browser/tab-open": tabOpen,
  "browser/tab-close": tabClose,
  "browser/tab-activate": tabActivate,
  "browser/tab-state": tabState,
  "window/open": open,
  "window/close": close,
  "window/focus": focus,
  "window/move": move,
  "window/resize": resize,
  "window/minimize": minimize,
  "window/restore": restore,
  "window/maximize": maximize,
  "window/unmaximize": unmaximize,
  "window/tab-group-merge": tabGroupMerge,
  "window/tab-group-auto": tabGroupAuto,
  "window/tab-group-split": tabGroupSplit,
  "window/tab-group-activate": tabGroupActivate,
  "window/tab-group-close": tabGroupClose,
  "system/hydrate": hydrate,
  "system/reflow": reflow,
  "system/native-state": nativeState,
};

export const WINDOW_COMMANDS = Object.freeze([
  "window/open", "window/close", "window/focus", "window/move", "window/resize",
  "window/minimize", "window/restore", "window/maximize", "window/unmaximize",
]);
export const TAB_GROUP_COMMANDS = Object.freeze([
  "window/tab-group-merge", "window/tab-group-auto", "window/tab-group-split", "window/tab-group-activate", "window/tab-group-close",
]);
export const BROWSER_COMMANDS = Object.freeze(["browser/tab-open", "browser/tab-close", "browser/tab-activate", "browser/tab-state"]);
export const SYSTEM_MUTATIONS = Object.freeze(["system/hydrate", "system/reflow", "system/native-state", "browser/tab-state"]);

export function reduce(state: WindowStateModel, command: WindowCommand): WindowStateModel {
  const fn = REDUCERS[command?.type];
  if (!fn) return state;
  const next = fn(state, command);
  return next === state ? state : next;
}

export const applyAll = (state: WindowStateModel, commands: WindowCommand[]): WindowStateModel => commands.reduce((current, command) => reduce(current, command), state);
export const serialize = (state: WindowStateModel): string => JSON.stringify(domain.toPersisted(state));
export const deserialize = (raw: unknown, areas?: Area[]): WindowStateModel => hydrate(domain.createState(), { persisted: raw, areas });

export function nativeIntents(state: WindowStateModel, _host?: Host, reserves: Record<string, number> = {}): NativeIntent[] {
  return state.windows
    .filter((window) => domain.isNativeKind(window.kind))
    .filter((window) => !window.tabGroupId || (domain.tabGroupOfWindow(state, window.id) || {}).activeWindowId === window.id)
    .map((window) => {
      const chrome = window.kind === domain.KIND.BROWSER ? domain.BROWSER_CHROME_H : 0;
      const reserve = window.kind === domain.KIND.BROWSER ? Math.max(0, Math.round(Number((reserves || {})[window.id]) || 0)) : 0;
      const inset = domain.TITLE_BAR_H + chrome + reserve;
      return {
        windowId: window.id,
        appId: window.appId,
        url: window.meta.url || "",
        views: domain.tabsOf(window).map((tab) => ({
          viewId: window.id + "#" + tab.tabId,
          tabId: tab.tabId,
          url: tab.url,
          active: tab.tabId === window.meta.activeTabId,
        })),
        present: window.state !== WSTATE.MINIMIZED,
        focused: state.focused === window.id,
        viewport: {
          x: window.bounds.x,
          y: window.bounds.y + inset,
          width: window.bounds.w,
          height: Math.max(0, window.bounds.h - inset),
        },
        occluders: domain.aboveWindows(state, window.id),
      };
    });
}
