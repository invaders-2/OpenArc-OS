/**
 * D2-02 · Window domain model。
 *
 * 纯函数，无 Electron / DOM / React 依赖 —— 因此可被 node --test 直接覆盖，
 * 也可被主进程与渲染进程同时引用。
 *
 * 设计约束（来自 docs/decisions/D2-02-window-system.md）：
 *
 *   1. **不要把 React component state 直接当 Window domain state。**
 *      Window 是领域对象，React 只是它的一个渲染投影。
 *      本模块不认识 React，React 侧只通过 electron/window-manager.cjs 的 reduce 改它。
 *
 *   2. **只有一个状态权威。** `order` 是 z-order 的唯一真值；
 *      `window.z` 是它的缓存，由 reindex() 写回，任何算子在返回前都会调用它。
 *      这样"顺序"与"层级"不可能互相漂移。
 *      **层级只由 order / z 表达，绝不由 `windows` 数组顺序表达**——
 *      数组顺序是稳定的创建序，它就是渲染层的 DOM 节点顺序，
 *      跟着层级走会让置顶变成"移动节点"，进而吃掉红绿灯按钮的 click
 *      （见 reindex() 的说明与 window-stress 07 步）。
 *
 *   3. **domain model 必须支持 `appId → windowIds[]`。**
 *      §32 明确要求：不得把"一个 App = 一个 Window"写死。
 *      同一 App 可以开多个 Window（files 的两个不同目录、browser 的两个页面）。
 *      因此 appId 与 windowId 是两个独立的键。
 *
 *   4. **不保存临时状态。** toPersisted() 只写"跨会话仍然成立"的字段：
 *      appId / kind / bounds / state / restore / meta。
 *      **不写** focused、z-order、opening / closing / modal 等瞬时状态。
 *
 * 坐标口径：bounds 用 { x, y, w, h }，与 electron/geometry.cjs 的 WindowRect
 * 以及既有 localStorage["oa-wins"] 完全一致 —— 迁移不做坐标换算。
 */
"use strict";

// 复用几何纯函数，**不重新发明另一套 clamp**（ADR §24）。
// 依赖方向是单向的：geometry 不认识 window domain，因此不存在循环引用。
const geometry = require("./geometry.cjs");

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 窗口最小尺寸。§25：每个窗口都必须有 minimum width/height，取 token 而非散落硬编码。
 * 取值沿用既有拖拽路径里的 560 / 400（src/main.tsx 的 resize 分支），
 * **不为了 token 化改变既有行为**。
 */
const MIN_WINDOW_W = 560;
const MIN_WINDOW_H = 400;

/** 桌面工作区：顶栏之下、Dock 之上。与 src/main.tsx 既有口径一致。 */
const AREA_TOP = 44;
const AREA_BOTTOM = 114;

/**
 * 窗口标题栏高度。原生视图的视口 = 窗口矩形挖掉标题栏。
 * 与 src/styles.css 的 `.window-title { height: 44px }` 必须一致 ——
 * 不一致会让原生视图与 DOM 视口锚点错位，表现为"网页整体偏移一截"。
 */
const TITLE_BAR_H = 44;

/** WindowKind：决定该窗口是否有原生 WebContentsView。 */
const KIND = { APP: "app", BROWSER: "browser" };

/** WindowState。 */
const WSTATE = { NORMAL: "normal", MINIMIZED: "minimized", MAXIMIZED: "maximized" };

/** 窗口 id 前缀：folder 窗口长期存在，其余为单例 app 窗口。 */
const FOLDER_PREFIX = "folder:";

/** 有原生视图的 App（会话分区按 appId 绑定，见 ADR §16）。 */
const NATIVE_APPS = new Set(["browser"]);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

/** 由一个 AppId 推出 kind。未登记的 App 一律视作普通 DOM 窗口。 */
function kindOf(appId) {
  return NATIVE_APPS.has(appId) ? KIND.BROWSER : KIND.APP;
}

/** 该 kind 是否需要原生视图。 */
function isNativeKind(kind) {
  return kind === KIND.BROWSER;
}

/**
 * 归一化一个 bounds：补默认值、clamp 到最小值、四舍五入到整数像素。
 * 非有限值一律退回 fallback，避免 NaN 悄悄渗进持久化。
 */
function normalizeBounds(b, fallback = { x: 120, y: 100, w: 830, h: 570 }) {
  const src = b && typeof b === "object" ? b : {};
  const pick = (k) => (isNum(src[k]) ? Math.round(src[k]) : fallback[k]);
  return {
    x: Math.max(0, pick("x")),
    y: Math.max(AREA_TOP, pick("y")),
    w: Math.max(MIN_WINDOW_W, pick("w")),
    h: Math.max(MIN_WINDOW_H, pick("h")),
  };
}

/**
 * 生成一个 Window 领域对象。
 *
 * @param spec { id, appId, kind?, bounds?, state?, restore?, minSize?, meta? }
 */
function createWindow(spec, index = 0) {
  const appId = String(spec.appId);
  const kind = spec.kind || kindOf(appId);
  const state = spec.state === WSTATE.MINIMIZED || spec.state === WSTATE.MAXIMIZED
    ? spec.state
    : WSTATE.NORMAL;
  return {
    id: String(spec.id),
    appId,
    kind,
    bounds: normalizeBounds(spec.bounds, { x: 120 + index * 22, y: 100 + index * 18, w: 830, h: 570 }),
    state,
    // restore 只在 MAXIMIZED 时有意义；其余情况显式置 null，
    // 避免"上次最大化的旧值"在多次最大化/还原之间串味。
    restore: state === WSTATE.MAXIMIZED ? normalizeBounds(spec.restore || spec.bounds) : null,
    minSize: {
      w: isNum(spec.minSize?.w) ? Math.max(1, Math.round(spec.minSize.w)) : MIN_WINDOW_W,
      h: isNum(spec.minSize?.h) ? Math.max(1, Math.round(spec.minSize.h)) : MIN_WINDOW_H,
    },
    meta: {
      title: String(spec.meta?.title || spec.id),
      icon: String(spec.meta?.icon || "apps"),
      // 只有原生窗口有 url；它是快照失效键的一部分（见 electron/occlusion.cjs snapshotKey）
      ...(spec.meta?.url ? { url: String(spec.meta.url) } : {}),
    },
    visible: state !== WSTATE.MINIMIZED,
    // 多显示器归属。本轮单屏，null = 主屏；字段先落位，D2-03 之后才有非 null 值。
    displayId: spec.displayId ?? null,
    z: index,
  };
}

/** 初始（空）状态。 */
function createState() {
  return { windows: [], order: [], focused: null, seq: 0 };
}

/**
 * 把 `order` 的一致性重新铸一遍，并把 z 缓存写回每个 window。
 *
 * 四件事：
 *   1. 剔除 order 里已不存在的 id、补上 windows 里漏掉的 id（保持稳定顺序）
 *   2. 写回 window.z（= order 下标）与 window.visible
 *   3. 修正 focused —— 不允许指向不存在或已最小化的窗口
 *   4. **windows 数组本身保持既有顺序（创建序）不变** —— 理由见下
 *
 * **任何域算子在返回前都必须经过它**，这是"不可能漂移"的机制保证。
 *
 * --- 为什么 windows 数组不跟着 order 排序 ---
 *
 * 这里曾经返回 `order.map(...)`，即让 windows 数组跟着层级走。那样"数组位置"与
 * "z" 变成同一件事的两种写法，看着更整齐，但它把**层级泄漏成了数组顺序**——
 * 而数组顺序在 React 里就是 DOM 顺序：每次聚焦/置顶，渲染层都会**移动**
 * 那个 `<section class="window">` 节点。
 *
 * 实测后果（experiments/d2-02/window-stress 07 步）：
 *   点一个**后台窗口**的红绿灯按钮时，`pointerdown` 先触发聚焦 → 重排被提交 →
 *   节点在 mousedown 与 mouseup 之间被移动，浏览器随即放弃合成 click ——
 *   事件序列里根本没有 click。用户看到的是"点关闭/最小化/最大化没反应，
 *   得点第二次"（第二次窗口已在前台，不再重排，于是按钮生效）。
 *
 * 层级只由 `order` / `z` 表达，DOM 顺序保持稳定：置顶只改 z-index，不改节点身份。
 */
function reindex(state) {
  const byId = new Map(state.windows.map((w) => [w.id, w]));
  const seen = new Set();
  const order = [];
  for (const id of state.order) {
    if (byId.has(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  for (const w of state.windows) {
    if (!seen.has(w.id)) {
      seen.add(w.id);
      order.push(w.id);
    }
  }
  // order 下标 → z。**只在窗口的 z 真的变了时才换对象**，
  // 让"没动过的窗口保持同一引用"这个性质继续成立（下面第 3 条的判据依赖它）。
  const zOf = new Map(order.map((id, i) => [id, i]));
  const windows = state.windows.map((w) => {
    const z = zOf.get(w.id);
    const visible = w.state !== WSTATE.MINIMIZED;
    return w.z === z && w.visible === visible ? w : { ...w, z, visible };
  });
  const focused =
    state.focused && byId.has(state.focused) && byId.get(state.focused).state !== WSTATE.MINIMIZED
      ? state.focused
      : null;

  // 无变化时返回**原对象**。
  //
  // 这不只是省内存：它让"无变化的命令返回同一引用"成为一个全局性质，
  // useReducer 的比较与 React 的重渲染都直接受益，
  // 也让"拖动到同一位置不产生新状态""重复最小化是 no-op"这类断言无需逐条特判。
  if (
    focused === state.focused &&
    order.length === state.order.length &&
    order.every((id, i) => id === state.order[i]) &&
    windows.every((w, i) => w === state.windows[i])
  ) {
    return state;
  }
  return { ...state, windows, order, focused };
}

// ---------------------------------------------------------------------------
// 查询（全部是只读纯函数）
// ---------------------------------------------------------------------------

const byId = (state, id) => state.windows.find((w) => w.id === id) || null;

/** 该 App 当前所有窗口的 id（自底向上）。§32 的 `appId → windowIds[]`。 */
const windowsOfApp = (state, appId) =>
  state.order.filter((id) => byId(state, id)?.appId === appId);

/** 自底向上、未最小化的窗口 id。 */
const visibleWindows = (state) =>
  state.order.filter((id) => byId(state, id)?.state !== WSTATE.MINIMIZED);

/** 当前聚焦窗口对象（无则 null）。 */
function focusedWindow(state) {
  return state.focused ? byId(state, state.focused) : null;
}

/** 聚焦窗口 id，但只在它仍可见时；用于顶栏红绿灯一类操作目标。 */
function actionableId(state) {
  const w = focusedWindow(state);
  return w && w.state !== WSTATE.MINIMIZED ? w.id : null;
}

const isFocused = (state, id) => state.focused === id;

/** z 序号（越大越靠上）。 */
const zOf = (state, id) => {
  const i = state.order.indexOf(id);
  return i < 0 ? -1 : i;
};

/** 落在目标窗口 `id` 之上、且可见的窗口矩形（供遮挡判定）。 */
function aboveWindows(state, id) {
  const i = zOf(state, id);
  if (i < 0) return [];
  return state.order
    .slice(i + 1)
    .map((wid) => byId(state, wid))
    .filter((w) => w && w.state !== WSTATE.MINIMIZED)
    .map((w) => ({ id: w.id, x: w.bounds.x, y: w.bounds.y, width: w.bounds.w, height: w.bounds.h }));
}

/** 域不变量：给测试与断言用。返回违规描述数组，空数组表示健康。 */
function invariants(state) {
  const bad = [];
  const ids = new Set(state.windows.map((w) => w.id));
  if (state.order.length !== ids.size) bad.push("order 与 windows 数量不一致");
  if (new Set(state.order).size !== state.order.length) bad.push("order 有重复 id");
  for (const id of state.order) if (!ids.has(id)) bad.push(`order 含不存在的 id ${id}`);
  for (const w of state.windows) {
    const i = state.order.indexOf(w.id);
    if (i < 0) bad.push(`window ${w.id} 不在 order 中`);
    else if (w.z !== i) bad.push(`window ${w.id} 的 z=${w.z} 与 order 下标 ${i} 不一致`);
    if (w.visible !== (w.state !== WSTATE.MINIMIZED)) bad.push(`window ${w.id} 的 visible 与 state 不一致`);
    if (w.bounds.w < w.minSize.w || w.bounds.h < w.minSize.h)
      bad.push(`window ${w.id} 小于最小尺寸`);
    if (w.state === WSTATE.MAXIMIZED && !w.restore) bad.push(`window ${w.id} 最大化但没有 restore`);
  }
  if (state.focused) {
    const f = byId(state, state.focused);
    if (!f) bad.push("focused 指向不存在的窗口");
    else if (f.state === WSTATE.MINIMIZED) bad.push("focused 指向已最小化的窗口");
  }
  return bad;
}

// ---------------------------------------------------------------------------
// 持久化（§22）
// ---------------------------------------------------------------------------

/**
 * 只序列化跨会话仍然成立的字段。
 *
 * **不写** focused / order / z：它们是会话内状态。
 * 上次退出时谁在最上层、谁被聚焦，不该决定下次启动的层级 ——
 * 否则"窗口自己冒到最前面"会变成偶发的怪异行为。
 *
 * **不写** opening / closing / drag / modal 等瞬时态：它们根本不进 domain model。
 */
function toPersisted(state) {
  return {
    v: 2,
    windows: state.windows.map((w) => ({
      id: w.id,
      appId: w.appId,
      kind: w.kind,
      bounds: { ...w.bounds },
      state: w.state,
      restore: w.restore ? { ...w.restore } : null,
      minSize: { ...w.minSize },
      meta: { ...w.meta },
      displayId: w.displayId,
    })),
  };
}

/**
 * 反向恢复。**任何字段坏掉都不抛异常**，而是降级：
 * 坏窗口被丢弃、坏 bounds 被 clamp、无法识别的 state 退回 normal。
 * 恢复路径抛异常等于"一次崩溃后永久打不开"，不可接受。
 *
 * @param raw        已 JSON.parse 的对象，或 null
 * @param clampAreas 可见工作区列表；传入时用 geometry.clampAll 把窗口与新显示器对齐（A05）
 */
function fromPersisted(raw, clampAreas) {
  const state = createState();
  const list = Array.isArray(raw?.windows) ? raw.windows : [];
  const seen = new Set();
  const restored = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = item.id;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    restored.push(
      createWindow(
        {
          id,
          appId: typeof item.appId === "string" && item.appId ? item.appId : id,
          kind: item.kind,
          bounds: item.bounds,
          state: item.state,
          restore: item.restore,
          minSize: item.minSize,
          meta: item.meta,
          displayId: item.displayId,
        },
        restored.length,
      ),
    );
  }
  if (clampAreas && clampAreas.length && restored.length) {
    // A05：恢复时必须重新收拢到当前可见工作区。
    // 直接复用 geometry.clampAll —— 与主进程的显示器事件处理同一条路径，
    // 因此"启动恢复"与"运行中拔屏"不会得到两种不同的收拢结果。
    const flat = geometry.clampAll(restored.map((w) => ({ ...w, ...w.bounds })), clampAreas);
    const flatRestore = geometry.clampAll(
      restored.map((w) => ({ ...(w.restore || w.bounds), ...(w.restore || w.bounds) })),
      clampAreas,
    );
    restored.forEach((w, i) => {
      const r = flat[i];
      const s = flatRestore[i];
      w.bounds = normalizeBounds({ x: r.x, y: r.y, w: r.w, h: r.h }, w.bounds);
      // restore 快照也要一起收拢，否则"还原"会把窗口送回已拔掉的屏幕
      if (w.restore) w.restore = normalizeBounds({ x: s.x, y: s.y, w: s.w, h: s.h }, w.restore);
    });
  }
  state.windows = restored;
  state.order = restored.map((w) => w.id);
  // 恢复后不假设焦点：让用户或首个命令决定谁在前。
  state.focused = null;
  return reindex(state);
}

/** 判断一份持久化数据是否值得信任（供调用方决定要不要回退默认）。 */
function isPersistable(raw) {
  return !!raw && typeof raw === "object" && Array.isArray(raw.windows);
}

module.exports = {
  MIN_WINDOW_W,
  MIN_WINDOW_H,
  AREA_TOP,
  AREA_BOTTOM,
  TITLE_BAR_H,
  KIND,
  WSTATE,
  FOLDER_PREFIX,
  NATIVE_APPS,
  kindOf,
  isNativeKind,
  normalizeBounds,
  createWindow,
  createState,
  reindex,
  byId,
  windowsOfApp,
  visibleWindows,
  focusedWindow,
  actionableId,
  isFocused,
  zOf,
  aboveWindows,
  invariants,
  toPersisted,
  fromPersisted,
  isPersistable,
  clamp,
};
