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

/**
 * 最大化时的落位：**铺满整个宿主，只让开软件顶栏**。
 * 旧实现留了 12 / 52 / -24 / -158 的边距，用户口径是"全窗口展示，除了软件顶部的栏"，
 * 因此这里不再留边距（Dock 会被盖住，与 macOS 全屏一致，还原即恢复）。
 * 上沿直接用 `AREA_TOP`（= 顶栏高度）—— 与 normalizeBounds 的夹取口径同源，避免两套数。
 */
function maximizedBounds(host) {
  const width = Math.max(MIN_WINDOW_W, Math.round(host?.width || 0));
  const height = Math.max(MIN_WINDOW_H, Math.round((host?.height || 0) - AREA_TOP));
  return { x: 0, y: AREA_TOP, w: width, h: height };
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

/**
 * 原生视图回报的 url / loading / title 写回域。
 * 只有 meta 变，不触碰 bounds / order / focused —— 因此不可能影响层级与焦点。
 */
function nativeState(state, cmd) {
  const id = String(cmd?.windowId ?? "");
  const w = domain.byId(state, id);
  if (!w) return state;
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

/** 系统级变更。明确与命令层分开，避免"命令"这个概念被稀释。 */
const SYSTEM_MUTATIONS = Object.freeze(["system/hydrate", "system/reflow", "system/native-state"]);

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

/** 该窗口此刻是否应有原生视图可见（供 native-view-controller 消费的意图）。 */
function nativeIntents(state, host) {
  return state.windows
    .filter((w) => domain.isNativeKind(w.kind))
    .map((w) => ({
      windowId: w.id,
      appId: w.appId,
      url: w.meta.url || "",
      present: w.state !== WSTATE.MINIMIZED,
      focused: state.focused === w.id,
      viewport: {
        x: w.bounds.x,
        y: w.bounds.y + domain.TITLE_BAR_H,
        width: w.bounds.w,
        height: Math.max(0, w.bounds.h - domain.TITLE_BAR_H),
      },
      occluders: domain.aboveWindows(state, w.id),
    }));
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
  SYSTEM_MUTATIONS,
  REDUCERS,
};
