/**
 * D2-02 · Window Manager。
 *
 * **这是窗口状态的唯一权威。**
 *
 * 它只暴露一个改变状态的入口：`reduce(state, command)`。
 * 渲染进程用 useReducer 持有它，未来 AI 用同一份 `reduce` 派发命令 ——
 * **不存在"AI 直接改 React state"的捷径**，因为 React 里根本没有可改的窗口 state。
 *
 * 冻结的 9 条 Window Command（§20）：
 *   window/open  window/close  window/focus  window/move  window/resize
 *   window/minimize  window/restore  window/maximize  window/unmaximize
 *
 * 另有三条**系统级**状态变更，它们不是 Window Command，
 * 不响应用户意图、不参与命令层契约，只把外部事实写进域：
 *   system/hydrate       从持久化数据恢复
 *   system/reflow        显示器变化后重新收拢（A05）
 *   system/native-state  原生视图回报 url / loading / title
 *
 * 为什么 redux 风格而不是一个可变的 WindowManager 类：
 *   纯 reduce 让"同一状态 + 同一命令 = 同一结果"成为可断言的属性，
 *   并且让 UI 与 AI 共用一条路径这件事在类型上就无法绕过。
 */
"use strict";

const domain = require("./window-domain.cjs");
const geometry = require("./geometry.cjs");

const { WSTATE, AREA_TOP, AREA_BOTTOM, MIN_WINDOW_W, MIN_WINDOW_H } = domain;

/** 由 host 尺寸推出可见工作区。全项目只在这里算一次。 */
function areaOf(host) {
  const width = Math.max(MIN_WINDOW_W, Math.round(host?.width || 0));
  const height = Math.max(MIN_WINDOW_H, Math.round((host?.height || 0) - AREA_TOP - AREA_BOTTOM));
  return { x: 0, y: AREA_TOP, width, height };
}

/** 最大化时的落位（与原实现的 12 / 52 / -24 / -158 保持一致的观感）。 */
function maximizedBounds(host) {
  const width = Math.max(MIN_WINDOW_W, Math.round((host?.width || 0) - 24));
  const height = Math.max(MIN_WINDOW_H, Math.round((host?.height || 0) - 158));
  return { x: 12, y: 52, w: width, h: height };
}

const clone = (state) => ({
  ...state,
  windows: state.windows.map((w) => ({ ...w })),
  order: [...state.order],
});

/** 取 order 末尾、未最小化的窗口（"最上层的可用窗口"）。 */
function topmostVisible(state, exceptId) {
  for (let i = state.order.length - 1; i >= 0; i -= 1) {
    const id = state.order[i];
    if (id === exceptId) continue;
    const w = domain.byId(state, id);
    if (w && w.state !== WSTATE.MINIMIZED) return id;
  }
  return null;
}

/** 把窗口移到 order 末尾（置顶）。已是最上层时不动，避免无意义的状态抖动。 */
function raise(state, id) {
  if (state.order[state.order.length - 1] === id) return state;
  return { ...state, order: [...state.order.filter((x) => x !== id), id] };
}

/**
 * 置顶 + 聚焦（+ 取消最小化）。
 *
 * FOCUS 与 RESTORE 共用它，因此两者对"已是最上层、已聚焦、未最小化"的处理必然一致。
 * 已经是该状态时**返回原状态对象** —— 这是 reduce 的
 * "无变化 → 同一引用"性质在命令层的落点（reindex 的提前返回在这里够不着，
 * 因为调用方已经先构造了新对象）。
 */
function topAndFocus(state, id) {
  const w = domain.byId(state, id);
  if (!w) return state;
  const alreadyTop = state.order[state.order.length - 1] === id;
  if (alreadyTop && state.focused === id && w.state !== WSTATE.MINIMIZED) return state;
  const next = {
    ...state,
    windows: state.windows.map((x) =>
      x.id === id && x.state === WSTATE.MINIMIZED ? { ...x, state: WSTATE.NORMAL } : x,
    ),
  };
  next.focused = id;
  return domain.reindex(raise(next, id));
}

// ---------------------------------------------------------------------------
// 9 条 Window Command 的实现
// ---------------------------------------------------------------------------

/**
 * OPEN。**幂等**：同 id 已存在时不新建，而是聚焦它。
 * 这条对应既有的 `if (wins.some(w => w.id === id)) { focus(id); return; }` 行为，
 * 但把它变成域规则，避免每个调用点各写一遍。
 */
function open(state, cmd) {
  const appId = String(cmd.appId ?? cmd.id ?? "");
  if (!appId) return state;
  const id = String(cmd.id ?? appId);
  const existing = domain.byId(state, id);
  if (existing) return focus(state, { id });

  const index = state.windows.length;
  const w = domain.createWindow(
    {
      id,
      appId,
      kind: cmd.kind,
      bounds: cmd.bounds,
      minSize: cmd.minSize,
      meta: cmd.meta,
      displayId: cmd.displayId,
    },
    index,
  );
  const next = {
    ...state,
    seq: state.seq + 1,
    windows: [...state.windows, w],
    order: [...state.order, id],
  };
  next.focused = id;
  return domain.reindex(next);
}

/** CLOSE。被关闭者若是聚焦窗口，焦点落到最上层剩余可见窗口（可能为 null）。 */
function close(state, cmd) {
  const id = String(cmd.id ?? "");
  if (!domain.byId(state, id)) return state;
  const next = {
    ...state,
    windows: state.windows.filter((w) => w.id !== id),
    order: state.order.filter((x) => x !== id),
  };
  if (state.focused === id) next.focused = topmostVisible(next, null);
  return domain.reindex(next);
}

/**
 * FOCUS。置顶 + 取消最小化（与原 `focus()` 行为一致）。
 * 最小化窗口中"聚焦即恢复"是桌面的既成习惯，因此 FOCUS 允许这一副作用；
 * 需要显式恢复语义时用 RESTORE。
 */
function focus(state, cmd) {
  return topAndFocus(state, String(cmd.id ?? ""));
}

/** MOVE。绝对坐标；clamp 保底让标题栏始终可抓。 */
function move(state, cmd) {
  const id = String(cmd.id ?? "");
  const w = domain.byId(state, id);
  if (!w || w.state === WSTATE.MAXIMIZED) return state;
  const host = cmd.host || {};
  const x = Math.max(0, Math.min(Math.round(host.width || 0) - w.bounds.w, Math.round(cmd.x)));
  const y = Math.max(AREA_TOP, Math.min(Math.round(host.height || 0) - 140, Math.round(cmd.y)));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return state;
  if (x === w.bounds.x && y === w.bounds.y) return state;
  return domain.reindex({
    ...state,
    windows: state.windows.map((item) => (item.id === id ? { ...item, bounds: { ...item.bounds, x, y } } : item)),
  });
}

/** RESIZE。clamp 到 [minSize, host]，并保证不越出工作区。 */
function resize(state, cmd) {
  const id = String(cmd.id ?? "");
  const w = domain.byId(state, id);
  if (!w || w.state === WSTATE.MAXIMIZED) return state;
  const host = cmd.host || {};
  const maxW = Math.max(w.minSize.w, Math.round((host.width || 0) - w.bounds.x));
  const maxH = Math.max(w.minSize.h, Math.round((host.height || 0) - 100 - w.bounds.y));
  const nw = Math.max(w.minSize.w, Math.min(maxW, Math.round(cmd.w)));
  const nh = Math.max(w.minSize.h, Math.min(maxH, Math.round(cmd.h)));
  if (!Number.isFinite(nw) || !Number.isFinite(nh)) return state;
  if (nw === w.bounds.w && nh === w.bounds.h) return state;
  return domain.reindex({
    ...state,
    windows: state.windows.map((item) => (item.id === id ? { ...item, bounds: { ...item.bounds, w: nw, h: nh } } : item)),
  });
}

/** MINIMIZE。焦点交还最上层剩余可见窗口。 */
function minimize(state, cmd) {
  const id = String(cmd.id ?? "");
  const w = domain.byId(state, id);
  if (!w || w.state === WSTATE.MINIMIZED) return state;
  const next = {
    ...state,
    windows: state.windows.map((item) => (item.id === id ? { ...item, state: WSTATE.MINIMIZED } : item)),
  };
  if (state.focused === id) next.focused = topmostVisible(next, id);
  return domain.reindex(next);
}

/** RESTORE = 取消最小化并置顶。与 FOCUS 共用 topAndFocus，因此二者语义必然一致。 */
function restore(state, cmd) {
  return topAndFocus(state, String(cmd.id ?? ""));
}

/**
 * MAXIMIZE。保存 restore 快照。
 * 幂等：已最大化时不动，否则连续双击会不断覆盖 restore 快照、把"还原"的目标吃掉。
 */
function maximize(state, cmd) {
  const id = String(cmd.id ?? "");
  const w = domain.byId(state, id);
  if (!w || w.state === WSTATE.MAXIMIZED) return state;
  const next = {
    ...state,
    windows: state.windows.map((item) =>
      item.id === id
        ? {
            ...item,
            state: WSTATE.MAXIMIZED,
            restore: { ...item.bounds },
            bounds: maximizedBounds(cmd.host),
          }
        : item,
    ),
  };
  next.focused = id;
  return domain.reindex(raise(next, id));
}

/** UNMAXIMIZE。回到 restore 快照；快照缺失时退化为"保持当前尺寸、只改状态"。 */
function unmaximize(state, cmd) {
  const id = String(cmd.id ?? "");
  const w = domain.byId(state, id);
  if (!w || w.state !== WSTATE.MAXIMIZED) return state;
  const target = w.restore ? domain.normalizeBounds(w.restore, w.bounds) : w.bounds;
  const next = {
    ...state,
    windows: state.windows.map((item) =>
      item.id === id ? { ...item, state: WSTATE.NORMAL, bounds: target, restore: null } : item,
    ),
  };
  next.focused = id;
  return domain.reindex(raise(next, id));
}

// ---------------------------------------------------------------------------
// 系统级状态变更（不是 Window Command）
// ---------------------------------------------------------------------------

/** 从持久化恢复。恢复后不预设焦点：不把上一次的层级带到这一次。 */
function hydrate(state, cmd) {
  return domain.fromPersisted(cmd?.persisted, cmd?.areas);
}

/**
 * A05：显示器增删 / 分辨率变化 / **宿主窗口尺寸变化**后把所有窗口拉回可见工作区。
 *
 * **复用 `geometry.clampAll`，不重新发明另一套 clamp。**
 * 最大化的窗口不吃 clamp 结果，而是重新按新 host 计算最大化矩形；
 * 它的 restore 快照也要一起 clamp，否则"还原"会把窗口送回已拔掉的屏幕。
 *
 * 宿主尺寸变化也算这条路径：外壳被拖小时工作区变小，不 clamp 就会出现
 * "窗口跑到可见区域之外、既抓不到也关不掉"。同一条不变量，同一个实现。
 */
function reflow(state, cmd) {
  const areas = (cmd?.areas || []).filter(Boolean);
  if (!areas.length) return state;
  const flattened = state.windows.map((w) => ({ ...w, ...w.bounds }));
  const clamped = geometry.clampAll(flattened, areas);
  const maxRect = maximizedBounds(cmd.host);
  const next = state.windows.map((w, i) => {
    const b = clamped[i];
    const bounds = w.state === WSTATE.MAXIMIZED ? maxRect : { x: b.x, y: b.y, w: b.w, h: b.h };
    const restore = w.restore
      ? (() => {
          const r = geometry.clampAll([{ ...w.restore, ...w.restore }], areas)[0];
          return { x: r.x, y: r.y, w: r.w, h: r.h };
        })()
      : null;
    return { ...w, bounds: domain.normalizeBounds(bounds, w.bounds), restore };
  });
  // 无变化时返回原状态：尺寸变化事件会持续触发 reflow，
  // 每次都产生新对象会让持久化与重渲染跟着空转（这是 reduce 的全局性质）。
  const same = next.every((w, i) => {
    const old = state.windows[i];
    return (
      w.bounds.x === old.bounds.x &&
      w.bounds.y === old.bounds.y &&
      w.bounds.w === old.bounds.w &&
      w.bounds.h === old.bounds.h &&
      JSON.stringify(w.restore) === JSON.stringify(old.restore)
    );
  });
  if (same) return state;
  return domain.reindex({ ...state, windows: next });
}

// ---------------------------------------------------------------------------
// D5-01 · 浏览器标签命令
//
// 它们**不是** Window Command：窗口的 9 条命令与层级/焦点语义冻结不变（ADR §25）。
// 标签是"窗口内部的 App 状态"，写进的仍是同一个唯一权威（不新增第二份标签状态）。
// ---------------------------------------------------------------------------

/** 取浏览器窗口；非浏览器窗口 / 不存在一律 null（命令 no-op）。 */
function browserWindow(state, cmd) {
  const id = String(cmd?.id ?? cmd?.windowId ?? "");
  const w = domain.byId(state, id);
  return w && w.kind === domain.KIND.BROWSER ? w : null;
}

/**
 * 写回 meta，并把**活动标签**的 url 同步成 meta.url。
 * meta.url 是快照失效键与 nativeIntents 的输入；不同步就会出现
 * "标签切了但快照键还是旧的"这类静默错误，因此同步只在这一个地方做。
 */
function withMeta(state, w, meta) {
  const active = meta.tabs.find((t) => t.tabId === meta.activeTabId) || null;
  const next = { ...meta, url: active ? active.url : "" };
  return domain.reindex({ ...state, windows: state.windows.map((x) => (x.id === w.id ? { ...x, meta: next } : x)) });
}

/** 新标签。tabId 由调用方提供（保持 reduce 纯函数；域只负责校验唯一性与上限）。 */
function tabOpen(state, cmd) {
  const w = browserWindow(state, cmd);
  if (!w) return state;
  const tabs = domain.tabsOf(w);
  // 上限：到达上限**不改状态**，由 UI 依据 tabs.length 明示原因（不是静默失败）。
  if (tabs.length >= domain.TAB_LIMIT) return state;
  const tabId = String(cmd.tabId || "");
  if (!tabId || tabs.some((t) => t.tabId === tabId)) return state;
  const url = typeof cmd.url === "string" ? cmd.url : "";
  const tabSeq = Math.max(Number(w.meta.tabSeq) || 0, tabs.length) + 1;
  return withMeta(state, w, { ...w.meta, tabs: [...tabs, { tabId, url, title: "" }], activeTabId: tabId, tabSeq });
}

/** 关闭标签。最后一个标签不在这里关：浏览器语义是关窗口，由 UI 派发 window/close。 */
function tabClose(state, cmd) {
  const w = browserWindow(state, cmd);
  if (!w) return state;
  const tabs = domain.tabsOf(w);
  if (tabs.length <= 1) return state;
  const tabId = String(cmd.tabId || "");
  const index = tabs.findIndex((t) => t.tabId === tabId);
  if (index < 0) return state;
  const next = tabs.filter((t) => t.tabId !== tabId);
  const activeTabId =
    w.meta.activeTabId === tabId ? next[Math.min(index, next.length - 1)].tabId : w.meta.activeTabId;
  return withMeta(state, w, { ...w.meta, tabs: next, activeTabId });
}

/** 切换标签。 */
function tabActivate(state, cmd) {
  const w = browserWindow(state, cmd);
  if (!w) return state;
  const tabId = String(cmd.tabId || "");
  if (!domain.tabsOf(w).some((t) => t.tabId === tabId) || w.meta.activeTabId === tabId) return state;
  return withMeta(state, w, { ...w.meta, activeTabId: tabId });
}

/**
 * 原生视图回报的标签状态（url / title）。
 * 只有 meta 变，不触碰 bounds / order / focused —— 因此不可能影响层级与焦点。
 */
function tabState(state, cmd) {
  const w = browserWindow(state, { id: cmd?.windowId ?? cmd?.id });
  if (!w) return state;
  const tabs = domain.tabsOf(w);
  const tabId = String(cmd?.tabId || domain.activeTabIdOf(w));
  const index = tabs.findIndex((t) => t.tabId === tabId);
  if (index < 0) return state;
  const current = tabs[index];
  // 空字符串不作为"新地址"：失败/中止的导航会让 getURL() 返回 ""，
  // 若把它写进 domain，地址栏与持久化里的地址就被清空了（实测抓到过）。
  const url = typeof cmd?.url === "string" && cmd.url ? cmd.url : current.url;
  const title = typeof cmd?.title === "string" && cmd.title ? cmd.title : current.title;
  const titleChanged = tabId === w.meta.activeTabId && !!title && title !== w.meta.title;
  // 无变化 → 同一引用（原生状态会随每次导航/标题事件重复回报，空转会产生无意义的重渲染与持久化）
  if (url === current.url && title === current.title && !titleChanged) return state;
  const nextTabs =
    url === current.url && title === current.title
      ? tabs
      : tabs.map((t) => (t.tabId === tabId ? { ...t, url, title } : t));
  const meta = { ...w.meta, tabs: nextTabs };
  // 窗口标题跟随**活动标签**（浏览器语义）。
  if (titleChanged) meta.title = title;
  return withMeta(state, w, meta);
}

/**
 * 原生视图回报的 url / loading / title 写回域。
 * 只有 meta 变，不触碰 bounds / order / focused —— 因此不可能影响层级与焦点。
 *
 * D5-01：浏览器窗口的 url/title 属于**标签**，统一走 tabState 的同一实现，
 * 否则 meta.url 会与活动标签漂移（旧调用点不带 tabId 时默认落到活动标签）。
 */
function nativeState(state, cmd) {
  const id = String(cmd?.windowId ?? "");
  const w = domain.byId(state, id);
  if (!w) return state;
  if (w.kind === domain.KIND.BROWSER) {
    return tabState(state, { windowId: id, tabId: cmd?.tabId ?? domain.activeTabIdOf(w), url: cmd?.url, title: cmd?.title });
  }
  const meta = { ...w.meta };
  if (typeof cmd.title === "string" && cmd.title) meta.title = cmd.title;
  if (typeof cmd.url === "string") meta.url = cmd.url;
  const same = meta.title === w.meta.title && meta.url === w.meta.url;
  if (same) return state;
  return domain.reindex({
    ...state,
    windows: state.windows.map((item) => (item.id === id ? { ...item, meta } : item)),
  });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const REDUCERS = {
  // D5-01：浏览器标签（App 内部状态，与窗口命令分开）
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
  "system/hydrate": hydrate,
  "system/reflow": reflow,
  "system/native-state": nativeState,
};

/** 冻结的 9 条 Window Command —— 供命令层契约测试与未来的 AI 工具绑定使用。 */
const WINDOW_COMMANDS = Object.freeze([
  "window/open",
  "window/close",
  "window/focus",
  "window/move",
  "window/resize",
  "window/minimize",
  "window/restore",
  "window/maximize",
  "window/unmaximize",
]);

/**
 * D5-01：浏览器标签命令。与冻结的 9 条 Window Command 分开登记 ——
 * 它们不改窗口的位置/层级/焦点，只改窗口内部的 App 状态；AI 与手动共用同一条路径。
 */
const BROWSER_COMMANDS = Object.freeze([
  "browser/tab-open",
  "browser/tab-close",
  "browser/tab-activate",
  "browser/tab-state",
]);

/** 系统级变更。明确与命令层分开，避免"命令"这个概念被稀释。 */
const SYSTEM_MUTATIONS = Object.freeze(["system/hydrate", "system/reflow", "system/native-state", "browser/tab-state"]);

/**
 * 唯一的状态变更入口。
 * 未知命令**原样返回原状态**（不是抛异常）：命令层要能承接未来的 AI 生成内容，
 * 不能因为一个拼错的 type 把整个 UI 打死。
 */
function reduce(state, command) {
  const fn = REDUCERS[command?.type];
  if (!fn) return state;
  const next = fn(state, command);
  return next === state ? state : next;
}

/** 依次施加多条命令（用于测试与恢复路径）。 */
const applyAll = (state, commands) => commands.reduce((s, c) => reduce(s, c), state);

/** 序列化 / 反序列化（持久化只有这一条出口）。 */
const serialize = (state) => JSON.stringify(domain.toPersisted(state));
const deserialize = (raw, areas) => hydrate(domain.createState(), { persisted: raw, areas });

/**
 * 该窗口此刻是否应有原生视图可见（供 native-view-controller 消费的意图）。
 *
 * `reserves[windowId]` = 该窗口 chrome 之下、网页之上的 **DOM 条带高度**
 * （提示条 / 错误条 / 状态行）。原生视图是挂在窗口之上的子视图，DOM 在它下面 ——
 * 所以这条 strip 必须从原生视图矩形里**让出去**，否则提示会被网页整个盖住
 * （D5-01 Closure-4 像素实测：提示条 34pt 全部落在网页矩形内，网页绿占比 24/25）。
 */
function nativeIntents(state, host, reserves = {}) {
  return state.windows
    .filter((w) => domain.isNativeKind(w.kind))
    .map((w) => {
      const chrome = w.kind === domain.KIND.BROWSER ? domain.BROWSER_CHROME_H : 0;
      const reserve = w.kind === domain.KIND.BROWSER ? Math.max(0, Math.round(Number((reserves || {})[w.id]) || 0)) : 0;
      const inset = domain.TITLE_BAR_H + chrome + reserve;
      return {
        windowId: w.id,
        appId: w.appId,
        url: w.meta.url || "",
        // D5-01：一个浏览器窗口 = 每个标签一个原生视图；只有 active 的那个参与遮挡结算，
        // 其余由控制器 setVisible(false) 保持存活（页面状态不丢，切回即恢复）。
        views: domain.tabsOf(w).map((t) => ({
          viewId: w.id + "#" + t.tabId,
          tabId: t.tabId,
          url: t.url,
          active: t.tabId === w.meta.activeTabId,
        })),
        present: w.state !== WSTATE.MINIMIZED,
        focused: state.focused === w.id,
        viewport: {
          x: w.bounds.x,
          y: w.bounds.y + inset,
          width: w.bounds.w,
          height: Math.max(0, w.bounds.h - inset),
        },
        occluders: domain.aboveWindows(state, w.id),
      };
    });
}

module.exports = {
  areaOf,
  maximizedBounds,
  topmostVisible,
  raise,
  clone,
  reduce,
  applyAll,
  serialize,
  deserialize,
  nativeIntents,
  WINDOW_COMMANDS,
  BROWSER_COMMANDS,
  SYSTEM_MUTATIONS,
  REDUCERS,
};
