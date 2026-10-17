/**
 * 窗口标签组（task-21 后端窗口域的前端投影 / 命令规划）。
 *
 * 为什么单独一层：Vue 壳层（src-vue/stores/shell.ts）与 React 入口（src/desktop/useDesktop.ts + main.tsx）
 * 共用同一份 electron/window-manager.cjs reduce，标签组的 UI 规则也必须只有一份：
 *   · 投影：哪些窗口被标签组隐藏、标签条成员、同应用窗口数、能否合并；
 *   · 命令规划：手动/自动合并、拖拽合并或拆出、关闭标签/标签组、新窗口；
 *   · 自动合并偏好（localStorage 同一键，两入口一致）。
 * 后端仍是唯一权威：本文件只生成 window/tab-group-* 命令，不直接改窗口状态；
 * 两个入口把这些命令交给各自的 reduce（与主进程 windows:sync 批处理同一套 reducer）。
 */
import domain from "../../electron/window-domain.cjs";
import type { WindowCommand, WindowStateModel } from "../../electron/window-domain.cjs";

export const TAB_AUTO_MERGE_KEY = "oa-tab-auto-merge";

/** 允许「新建窗口」的应用：单窗口应用不开这个口子，避免出现两份互不相干的写入口。 */
export const MULTI_WINDOW_APPS = [
  "files",
  "notes",
  "music",
  "calendar",
  "weather",
  "photos",
  "projects",
  "skills",
  "market",
  "automation",
  "chat",
  "protocols",
  "integrations",
] as const;

export function isMultiWindowApp(appId: string): boolean {
  return (MULTI_WINDOW_APPS as readonly string[]).includes(appId);
}

export function readAutoMerge(): boolean {
  try {
    return localStorage.getItem(TAB_AUTO_MERGE_KEY) !== "false";
  } catch {
    return true;
  }
}
export function writeAutoMerge(next: boolean): void {
  try {
    localStorage.setItem(TAB_AUTO_MERGE_KEY, next ? "true" : "false");
  } catch {
    /* 存储不可用：本次会话内仍生效（调用方持有 ref） */
  }
}

export type TabMember = { id: string; title: string; appId: string; active: boolean };
export type TabGroupView = {
  groupId: string;
  activeWindowId: string;
  appId: string;
  members: TabMember[];
};
export type WindowTabInfo = {
  /** 被同组其它标签遮挡（不是最小化）：只 display:none，不卸载组件。 */
  hidden: boolean;
  group: TabGroupView | null;
  sameAppCount: number;
  /** 同应用 ≥2 窗口且没有多个冲突标签组时可手动合并。 */
  canMerge: boolean;
  canOpenNew: boolean;
};

type Win = {
  id: string;
  appId: string;
  tabGroupId?: string | null;
  bounds: { x: number; y: number; w: number; h: number };
  meta?: { title?: string };
};

function byId(state: WindowStateModel, id: string): Win | null {
  return (domain.byId(state, id) as Win | null) || null;
}
function titleOf(w: Win): string {
  return (w.meta && typeof w.meta.title === "string" && w.meta.title) || w.id;
}

/** 该窗口是否被标签组隐藏（组内非 active 成员）。 */
export function isHiddenByTabGroup(state: WindowStateModel, windowId: string): boolean {
  const w = byId(state, windowId);
  if (!w || !w.tabGroupId) return false;
  const group = state.tabGroups && state.tabGroups[w.tabGroupId];
  return !!group && group.activeWindowId !== w.id;
}

export function tabGroupOfWindowId(state: WindowStateModel, windowId: string): string | null {
  const w = byId(state, windowId);
  return w && w.tabGroupId ? w.tabGroupId : null;
}

export function tabGroupView(state: WindowStateModel, groupId: string): TabGroupView | null {
  const group = state.tabGroups && state.tabGroups[groupId];
  if (!group) return null;
  const members = domain.windowsOfTabGroup(state, groupId)
    .map((id) => byId(state, id))
    .filter((w): w is Win => !!w)
    .map((w) => ({ id: w.id, title: titleOf(w), appId: w.appId, active: group.activeWindowId === w.id }));
  if (members.length < 2) return null;
  return { groupId, activeWindowId: group.activeWindowId, appId: group.appId, members };
}

export function windowTabInfo(state: WindowStateModel, windowId: string): WindowTabInfo {
  const w = byId(state, windowId);
  if (!w) return { hidden: false, group: null, sameAppCount: 0, canMerge: false, canOpenNew: false };
  const sameApp = state.windows.filter((item) => item.appId === w.appId);
  const groupsForApp = Object.values(state.tabGroups || {}).filter((group) => group.appId === w.appId);
  return {
    hidden: isHiddenByTabGroup(state, windowId),
    group: w.tabGroupId ? tabGroupView(state, w.tabGroupId) : null,
    sameAppCount: sameApp.length,
    canMerge: sameApp.length >= 2 && groupsForApp.length <= 1,
    canOpenNew: isMultiWindowApp(w.appId),
  };
}

/** 「新建窗口」按钮是否应该出现：应用在多窗口白名单里。 */
export function canOpenNewWindow(state: WindowStateModel, windowId: string, allowed = isMultiWindowApp): boolean {
  const w = byId(state, windowId);
  return !!w && allowed(w.appId);
}

function nextInstanceId(state: WindowStateModel, appId: string): string {
  let index = 2;
  for (;;) {
    const id = appId + "#" + index;
    if (!byId(state, id)) return id;
    index += 1;
  }
}

function offsetBounds(state: WindowStateModel, appId: string): { x: number; y: number; w: number; h: number } | null {
  const sameApp = domain.windowsOfApp(state, appId).map((id) => byId(state, id)).filter((w): w is Win => !!w);
  const active = sameApp[sameApp.length - 1];
  if (!active) return null;
  return { x: active.bounds.x + 24, y: active.bounds.y + 24, w: active.bounds.w, h: active.bounds.h };
}

/** 同应用自动/手动合并：交给后端 auto（无组则建组，有一个组则把未分组窗口并进去）。 */
export function autoMergeCommands(state: WindowStateModel, appId: string): WindowCommand[] {
  const sameApp = domain.windowsOfApp(state, appId);
  if (sameApp.length < 2) return [];
  const groups = Object.values(state.tabGroups || {}).filter((group) => group.appId === appId);
  if (groups.length > 1) return [];
  return [{ type: "window/tab-group-auto", appId } as WindowCommand];
}

export type NewWindowPlan = { commands: WindowCommand[]; id: string; title: string };

/**
 * 新建同应用窗口；readAutoMerge 为真且已有同应用窗口时，紧跟一条自动合并命令。
 * 标题用「基础名 N」保证标签可区分；id 用 appId#N（不等于 appId，不会与单例窗口冲突）。
 */
export function newWindowPlan(
  state: WindowStateModel,
  appId: string,
  baseTitle: string,
  options: { id?: string; title?: string; autoMerge?: boolean } = {},
): NewWindowPlan {
  const id = options.id || nextInstanceId(state, appId);
  const sameCount = domain.windowsOfApp(state, appId).length;
  const title = options.title || baseTitle + (sameCount > 0 ? " " + (sameCount + 1) : "");
  const bounds = offsetBounds(state, appId) || undefined;
  const commands: WindowCommand[] = [
    {
      type: "window/open",
      appId,
      id,
      ...(bounds ? { bounds } : {}),
      meta: { title, icon: "apps" },
    } as WindowCommand,
  ];
  const shouldAuto = options.autoMerge === undefined ? readAutoMerge() : options.autoMerge;
  if (shouldAuto && sameCount >= 1) {
    /* 命令按顺序应用：open 之后 state 才有第二个窗口，所以这里直接追加 auto 类型，
       不能用 autoMergeCommands(state, ...)（它读的是 open 之前的状态）。 */
    commands.push({ type: "window/tab-group-auto", appId } as WindowCommand);
  }
  return { commands, id, title };
}

/**
 * React 访达的文件夹窗口：id 仍是 folder:<id>（内容分发靠这个前缀），
 * appId 统一记为 files（否则后端同应用合并规则会把它们当成不同应用）。
 */
export function folderWindowPlan(
  state: WindowStateModel,
  folderId: string,
  title: string,
  folderPrefix: string,
  options: { autoMerge?: boolean } = {},
): NewWindowPlan {
  const id = folderPrefix + folderId;
  const existing = byId(state, id);
  if (existing) {
    return { commands: [{ type: "window/focus", id } as WindowCommand], id, title };
  }
  const bounds = offsetBounds(state, "files") || undefined;
  const commands: WindowCommand[] = [
    {
      type: "window/open",
      appId: "files",
      id,
      ...(bounds ? { bounds } : {}),
      meta: { title, icon: "folder" },
    } as WindowCommand,
  ];
  const sameCount = domain.windowsOfApp(state, "files").length;
  const shouldAuto = options.autoMerge === undefined ? readAutoMerge() : options.autoMerge;
  if (shouldAuto && sameCount >= 1) commands.push({ type: "window/tab-group-auto", appId: "files" } as WindowCommand);
  return { commands, id, title };
}

/**
 * 把一个标签拖到另一个窗口上：返回需要按顺序派发的命令；不能合并时返回 null。
 * 规则：
 *   · 同一窗口 / 不同应用 → 不合并；
 *   · 源已在组里 → 先把自己从原组拆出，再加入目标（后端不允许跨组隐式并组）；
 *   · 目标是组 → merge 到目标组；目标未分组 → 新组 = 目标 + 源。
 */
export function mergeTabCommands(state: WindowStateModel, sourceId: string, targetId: string): WindowCommand[] | null {
  if (!sourceId || !targetId || sourceId === targetId) return null;
  const source = byId(state, sourceId);
  const target = byId(state, targetId);
  if (!source || !target || source.appId !== target.appId) return null;
  const sourceGroup = source.tabGroupId ? state.tabGroups && state.tabGroups[source.tabGroupId] : null;
  const targetGroup = target.tabGroupId ? state.tabGroups && state.tabGroups[target.tabGroupId] : null;
  if (sourceGroup && targetGroup && sourceGroup.id === targetGroup.id) return null;
  const commands: WindowCommand[] = [];
  if (sourceGroup) {
    commands.push({ type: "window/tab-group-split", id: sourceId, groupId: sourceGroup.id } as WindowCommand);
  }
  if (targetGroup) {
    commands.push({ type: "window/tab-group-merge", groupId: targetGroup.id, ids: [sourceId], activeId: sourceId } as WindowCommand);
  } else {
    commands.push({ type: "window/tab-group-merge", ids: [targetId, sourceId], activeId: sourceId } as WindowCommand);
  }
  return commands;
}

/** 把标签拖到桌面空白处 = 从组里拆出（组只剩 2 个时后端会整组拆开并恢复几何）。 */
export function splitTabOnDropCommands(state: WindowStateModel, sourceId: string): WindowCommand[] | null {
  const source = byId(state, sourceId);
  if (!source || !source.tabGroupId) return null;
  return [{ type: "window/tab-group-split", id: sourceId, groupId: source.tabGroupId } as WindowCommand];
}

export function activateTabCommand(groupId: string, windowId: string): WindowCommand {
  return { type: "window/tab-group-activate", groupId, id: windowId } as WindowCommand;
}
export function closeTabCommand(windowId: string): WindowCommand {
  return { type: "window/close", id: windowId } as WindowCommand;
}
export function closeGroupCommand(groupId: string): WindowCommand {
  return { type: "window/tab-group-close", groupId } as WindowCommand;
}

/** 指针落点处的窗口 id（拖拽合并/拆出的 DOM 判定，两个入口共用）。 */
export function windowIdAtPoint(clientX: number, clientY: number): string | null {
  if (typeof document === "undefined") return null;
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  const host = el && el.closest("[data-window-id]");
  return host ? host.getAttribute("data-window-id") : null;
}
