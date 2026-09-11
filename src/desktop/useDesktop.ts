/**
 * D2-02 · 桌面状态钩子。
 *
 * **它是渲染进程里唯一持有窗口状态的地方。**
 * 组件不持有窗口 state，只读 `state` 并 `dispatch(command)` ——
 * 因此不存在"AI 绕过命令层直接改 state"的捷径：
 * 渲染进程中根本没有第二处可以改窗口的地方（ADR §21）。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import domain from "../../electron/window-domain.cjs";
import manager from "../../electron/window-manager.cjs";
import type { WindowCommand, WindowStateModel } from "../../electron/window-domain.cjs";
import type { NativeIntent } from "../../electron/window-manager.cjs";

/** 持久化键：沿用既有 oa-wins，但**只能经 Window Manager 读写**。 */
const KEY = "oa-wins";

type NativeResult = {
  windowId: string;
  strategy: "live" | "clip+snapshot" | "snapshot" | "hidden" | "closed";
  bounds?: { x: number; y: number; width: number; height: number };
  snapshotRects?: { x: number; y: number; width: number; height: number }[];
  snapshots?: { rect: { x: number; y: number; width: number; height: number }; dataUrl: string | null }[];
};

export type SnapshotLayer = { windowId: string; rect: { x: number; y: number; width: number; height: number }; dataUrl: string };

/** 系统级覆盖层：它们打开时原生视图整块让位（ADR §19 第 4 条）。 */
export type OverlayState = { dialog: boolean; search: boolean; menu: boolean; ai: boolean };

function restore(): WindowStateModel {
  let parsed: unknown = null;
  try {
    const raw = localStorage.getItem(KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  // 首次启动 / 数据不可信 → 给一份默认工作区，而不是空桌面
  if (!domain.isPersistable(parsed)) {
    return manager.applyAll(domain.createState(), [
      { type: "window/open", appId: "home", bounds: { x: 90, y: 94, w: 830, h: 570 } },
    ]);
  }
  return manager.deserialize(parsed, [workArea(host())]);
}

const host = () => ({ width: innerWidth, height: innerHeight });
const workArea = (h: { width: number; height: number }) => manager.areaOf(h);

export function useDesktop() {
  const [state, dispatch] = useReducer(
    (s: WindowStateModel, c: WindowCommand) => manager.reduce(s, c),
    undefined,
    restore,
  );
  const [hostSize, setHostSize] = useState(host);
  const [native, setNative] = useState<NativeResult[]>([]);
  const [overlays, setOverlays] = useState<OverlayState>({ dialog: false, search: false, menu: false, ai: false });

  // ---------------------------------------------------------------------------
  // 持久化：唯一出口是 manager.serialize
  // ---------------------------------------------------------------------------
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    try {
      localStorage.setItem(KEY, manager.serialize(state));
    } catch {
      /* 存储写满时不该让桌面崩掉 */
    }
  }, [state]);

  // ---------------------------------------------------------------------------
  // host 尺寸变化 → 记录；显示器变化 → reflow（A05）
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const onResize = () => setHostSize(host());
    window.addEventListener("resize", onResize);
    const off = window.openarc?.onDisplay(() =>
      dispatch({ type: "system/reflow", areas: [workArea(host())], host: host() }),
    );
    return () => {
      window.removeEventListener("resize", onResize);
      off?.();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 原生状态只读回灌：url / loading / title / 被拦截的弹窗
  // ---------------------------------------------------------------------------
  const [browserEvents, setBrowserEvents] = useState<{ windowId: string; message: string } | null>(null);
  useEffect(
    () =>
      window.openarc?.onNativeState((e) => {
        if (e.type === "native-state")
          dispatch({ type: "system/native-state", windowId: e.windowId, url: e.url, title: e.title });
        else if (e.type === "popup-blocked") setBrowserEvents({ windowId: e.windowId, message: "弹出窗口已阻止，请在地址栏打开链接。" });
        else if (e.type === "navigate-blocked") setBrowserEvents({ windowId: e.windowId, message: "仅允许 HTTP / HTTPS 网页。" });
        else if (e.type === "load-failed") setBrowserEvents({ windowId: e.windowId, message: `网页加载失败：${e.message}` });
      }),
    [],
  );

  // ---------------------------------------------------------------------------
  // 原生意图下发：几何来自**domain**，不再来自 getBoundingClientRect()
  //
  // 这是"唯一状态权威"的关键一环：DOM 量出来的矩形与域里的 bounds 如果同时
  // 存在，就是两份真相。现在只有域一份，DOM 只是它的渲染投影。
  // ---------------------------------------------------------------------------
  const intents: NativeIntent[] = useMemo(() => manager.nativeIntents(state, hostSize), [state, hostSize]);
  const overlayOpen = overlays.dialog || overlays.search || overlays.ai;

  // 意图的稳定指纹：只有它变化才触发 IPC，避免每帧同步
  const fingerprint = useMemo(
    () =>
      JSON.stringify(
        intents.map((i) => [i.windowId, i.url, i.present, i.focused, i.viewport.x, i.viewport.y, i.viewport.width, i.viewport.height, i.occluders.map((o) => [o.id, o.x, o.y, o.width, o.height])]),
      ) + `|${overlayOpen ? 1 : 0}`,
    [intents, overlayOpen],
  );
  const lastFingerprint = useRef("");
  useEffect(() => {
    if (!window.openarc) return;
    if (lastFingerprint.current === fingerprint) return;
    lastFingerprint.current = fingerprint;
    let stale = false;
    void window.openarc
      .sync({ intents, overlayOpen, interactive: true, host: hostSize })
      .then((res) => {
        if (!stale && res?.results) setNative(res.results as NativeResult[]);
      })
      .catch(() => {
        /* 主进程不可用时桌面仍应可操作 */
      });
    return () => {
      stale = true;
    };
  }, [fingerprint, intents, overlayOpen, hostSize]);

  /** 快照层：原生视图被收缩/隐藏后，由它把网页画面补回 DOM。 */
  const snapshotLayers: SnapshotLayer[] = useMemo(() => {
    const out: SnapshotLayer[] = [];
    for (const r of native) {
      if (r.strategy !== "clip+snapshot" && r.strategy !== "snapshot") continue;
      for (const s of r.snapshots || []) if (s.dataUrl) out.push({ windowId: r.windowId, rect: s.rect, dataUrl: s.dataUrl });
    }
    return out;
  }, [native]);

  /** 该窗口的原生视图是否此刻可见（供占位文案保持一致，避免界面撒谎）。 */
  const nativeVisibleOf = useCallback(
    (windowId: string) => {
      const r = native.find((n) => n.windowId === windowId);
      return !!r && (r.strategy === "live" || r.strategy === "clip+snapshot");
    },
    [native],
  );

  return {
    state,
    dispatch,
    hostSize,
    intents,
    overlays,
    setOverlays,
    snapshotLayers,
    nativeVisibleOf,
    browserEvents,
    clearBrowserEvent: () => setBrowserEvents(null),
  };
}
