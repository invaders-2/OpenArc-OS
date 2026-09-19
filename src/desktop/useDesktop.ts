/**
 * D2-02 / D5-01 · 桌面状态钩子。
 *
 * **它是渲染进程里唯一持有窗口状态的地方。**
 * 组件不持有窗口 state，只读 `state` 并 `dispatch(command)` ——
 * 因此不存在"AI 绕过命令层直接改 state"的捷径（ADR §21）。
 *
 * D5-01 增量：
 *   · 持久化按**用户**分键（`oa-wins:<userId>`）：切账号后看不到上一个用户的窗口与标签（A04）。
 *   · 浏览器运行期数据（loading / 错误 / 下载 / 提示）只活在内存里，绝不跨会话复用。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import domain from "../../electron/window-domain.cjs";
import manager from "../../electron/window-manager.cjs";
import type { WindowCommand, WindowStateModel } from "../../electron/window-domain.cjs";
import type { NativeIntent } from "../../electron/window-manager.cjs";
import { tabKey, type BrowserNotice, type DownloadRecord, type TabRuntimeMap } from "../browser/types";

/** 持久化键：沿用既有 oa-wins 前缀，但**按用户分键**，且只能经 Window Manager 读写。 */
const KEY = "oa-wins";
const storageKeyFor = (sessionKey: string | null) => (sessionKey ? `${KEY}:${sessionKey}` : KEY);

type NativeResult = {
  windowId: string;
  mode: "live" | "clip+snapshot" | "snapshot" | "hidden" | "closed";
  bounds?: { x: number; y: number; width: number; height: number };
  snapshotRects?: { x: number; y: number; width: number; height: number }[];
  snapshots?: { rect: { x: number; y: number; width: number; height: number }; dataUrl: string | null }[];
};

export type SnapshotLayer = { windowId: string; rect: { x: number; y: number; width: number; height: number }; dataUrl: string };

/**
 * 系统级覆盖层：它们打开时原生视图整块让位（ADR §19 第 4 条）。
 *
 * `menu`（桌面右键菜单）与 `panel`（浏览器下载面板）也走这条：
 * **原生视图永远绘制在 DOM 之上**，任何必须"盖在网页上并可交互"的 DOM 面板
 * 都只能靠主进程把视图收起 —— 靠 z-index 是做不到的（D1-01 实测）。
 */
export type OverlayState = { dialog: boolean; search: boolean; menu: boolean; ai: boolean; panel: boolean };

const host = () => ({ width: innerWidth, height: innerHeight });
const workArea = (h: { width: number; height: number }) => manager.areaOf(h);

function readPersisted(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** 默认工作区（首次启动 / 数据不可信 / 新用户）：一份可用的空桌面，而不是空屏。 */
function defaultPersisted(): unknown {
  const seeded = manager.applyAll(domain.createState(), [
    { type: "window/open", appId: "home", bounds: { x: 90, y: 94, w: 830, h: 570 } },
  ]);
  return JSON.parse(manager.serialize(seeded));
}

function restore(sessionKey: string | null): WindowStateModel {
  const parsed = readPersisted(storageKeyFor(sessionKey));
  // 首次启动 / 数据不可信 → 给一份默认工作区，而不是空桌面
  if (!domain.isPersistable(parsed)) return manager.deserialize(defaultPersisted(), [workArea(host())]);
  return manager.deserialize(parsed, [workArea(host())]);
}

/**
 * @param opts.locked     屏幕是否已锁定（锁定时所有原生网页视图整块让位）。
 * @param opts.sessionKey **主进程推导的会话键**（当前 userId 的投影）。它决定持久化分键与
 *                        原生会话分区；渲染进程只消费它，不产生它。
 */
export function useDesktop(opts: { locked?: boolean; sessionKey?: string | null } = {}) {
  const locked = !!opts.locked;
  const sessionKey = opts.sessionKey ?? null;
  const [state, dispatch] = useReducer(
    (s: WindowStateModel, c: WindowCommand) => manager.reduce(s, c),
    undefined,
    () => restore(sessionKey),
  );
  const [hostSize, setHostSize] = useState(host);
  const [native, setNative] = useState<NativeResult[]>([]);
  const [overlays, setOverlays] = useState<OverlayState>({ dialog: false, search: false, menu: false, ai: false, panel: false });

  // ---------------------------------------------------------------------------
  // 会话切换（A04）：换用户 → 换持久化键 → 用**新用户的**数据 hydrate；
  // 上一个用户的窗口、标签、下载与提示全部不复用。
  // ---------------------------------------------------------------------------
  const storageKey = storageKeyFor(sessionKey);
  const keyRef = useRef(storageKey);
  useEffect(() => {
    if (keyRef.current === storageKey) return;
    keyRef.current = storageKey;
    const parsed = readPersisted(storageKey);
    dispatch({
      type: "system/hydrate",
      persisted: domain.isPersistable(parsed) ? parsed : defaultPersisted(),
      areas: [workArea(host())],
    });
    setNative([]);
    setBrowserRuntime({});
    setDownloads([]);
    setNotices([]);
  }, [storageKey]);

  // ---------------------------------------------------------------------------
  // 持久化：唯一出口是 manager.serialize，写进**当前用户**的键
  // ---------------------------------------------------------------------------
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    try {
      localStorage.setItem(storageKey, manager.serialize(state));
    } catch {
      /* 存储写满时不该让桌面崩掉 */
    }
  }, [state, storageKey]);

  // ---------------------------------------------------------------------------
  // host 尺寸变化 → 记录；显示器变化 → reflow（A05）
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const reflow = () => {
      const size = host();
      setHostSize(size);
      dispatch({ type: "system/reflow", areas: [workArea(size)], host: size });
    };
    window.addEventListener("resize", reflow);
    const off = window.openarc?.onDisplay(() => {
      const size = host();
      setHostSize(size);
      dispatch({ type: "system/reflow", areas: [workArea(size)], host: size });
    });
    return () => {
      window.removeEventListener("resize", reflow);
      off?.();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 浏览器运行期事实（内存投影，不持久化）
  // ---------------------------------------------------------------------------
  const [browserRuntime, setBrowserRuntime] = useState<TabRuntimeMap>({});
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [notices, setNotices] = useState<BrowserNotice[]>([]);
  const noticeSeq = useRef(0);
  const pushNotice = useCallback((notice: Omit<BrowserNotice, "id">) => {
    noticeSeq.current += 1;
    const id = `n${noticeSeq.current}`;
    setNotices((list) => {
      // 权限被拒会按每次请求重复上报：同 (kind, origin, permission) 只留一条。
      if (notice.kind === "permission" && list.some((n) => n.kind === "permission" && n.origin === notice.origin && n.permission === notice.permission))
        return list;
      return [...list.slice(-7), { ...notice, id }];
    });
  }, []);

  /** 向主进程要一次**本用户**的下载记录（含落盘路径）。 */
  const refreshDownloads = useCallback(async () => {
    const bridge = window.openarc?.browser;
    if (!bridge) return;
    const res = await bridge({ type: "browser/downloads", action: "list" });
    if (Array.isArray(res?.items)) setDownloads(res.items as DownloadRecord[]);
  }, []);

  /** 受控浏览器命令（下载 / 用户确认后的外部打开）。返回值原样给调用方。 */
  const browserCommand = useCallback(async (command: Record<string, unknown>) => {
    const bridge = window.openarc?.browser;
    if (!bridge) return {};
    const res = (await bridge(command)) as { items?: unknown; error?: string; ok?: boolean };
    if (Array.isArray(res?.items)) setDownloads(res.items as DownloadRecord[]);
    return res || {};
  }, []);

  useEffect(() => {
    const off = window.openarc?.onNativeState((e) => {
      const type = String(e?.type || "");
      const windowId = String(e?.windowId || "");
      const tabId = e?.tabId == null ? null : String(e.tabId);
      if (type === "native-state") {
        dispatch({ type: "system/native-state", windowId, tabId: tabId ?? undefined, url: e.url, title: e.title });
        if (tabId)
          setBrowserRuntime((m) => {
            const key = tabKey(windowId, tabId);
            const loadError = e.loadError as { code: number; message: string; url: string } | null | undefined;
            return {
              ...m,
              [key]: {
                loading: !!e.loading,
                canGoBack: !!e.canGoBack,
                canGoForward: !!e.canGoForward,
                attached: e.attached !== false,
                // 加载失败由主进程持有并随每个 native-state 下发：
                // 错误页同样会 did-finish-load，渲染层自行推断一定会把横幅清错。
                error: loadError ? { code: Number(loadError.code) || 0, message: String(loadError.message || "网页加载失败"), url: String(loadError.url || "") } : null,
              },
            };
          });
        return;
      }
      if (type === "load-failed") {
        // 把"尝试过的地址"写回 domain：地址栏显示它，"重试"也重试它（而不是旧页面）。
        if (e.url) dispatch({ type: "system/native-state", windowId, tabId: tabId ?? undefined, url: String(e.url) });
        // 错误本体由随后的 native-state(loadError) 写入，这里不重复维护第二份。
        return;
      }
      if (type === "popup-blocked") {
        pushNotice({ kind: "popup", windowId, tabId, url: String(e.url || ""), message: "网页尝试打开新窗口，已阻止。" });
        return;
      }
      if (type === "external-protocol") {
        pushNotice({
          kind: "external",
          windowId,
          tabId,
          url: String(e.url || ""),
          scheme: String(e.scheme || ""),
          message: `网页请求用系统处理 ${String(e.scheme || "")}: 链接。`,
        });
        return;
      }
      if (type === "navigate-blocked") {
        pushNotice({ kind: "blocked", windowId, tabId, url: String(e.url || ""), message: "仅允许 HTTP / HTTPS 网页。" });
        return;
      }
      if (type === "permission-denied") {
        pushNotice({
          kind: "permission",
          windowId,
          tabId: null,
          url: String(e.origin || ""),
          origin: String(e.origin || ""),
          permission: String(e.permission || ""),
          message: `已拒绝 ${String(e.origin || "该网站")} 的 ${String(e.permission || "权限")} 申请。`,
        });
        return;
      }
      if (type === "certificate-error") {
        pushNotice({ kind: "certificate", windowId, tabId, url: String(e.url || ""), message: `证书校验失败（${String(e.error || "")}），未加载该网页。` });
        return;
      }
      if (type === "render-gone") {
        pushNotice({ kind: "gone", windowId, tabId, url: "", message: `网页进程已退出（${String(e.reason || "")}）。` });
        return;
      }
      if (type === "download-state") {
        const record = {
          downloadId: String(e.downloadId || ""),
          filename: String(e.filename || ""),
          state: String(e.state || "progressing") as DownloadRecord["state"],
          received: Number(e.received) || 0,
          total: Number(e.total) || 0,
          source: "",
          savePath: "",
          startedAt: Date.now(),
          endedAt: null,
        };
        setDownloads((list) => {
          const i = list.findIndex((d) => d.downloadId === record.downloadId);
          if (i < 0) return [record, ...list];
          const next = [...list];
          next[i] = { ...next[i], ...record };
          return next;
        });
        // 结束状态需要落盘路径，向主进程取一次完整记录。
        if (record.state !== "progressing") void refreshDownloads();
        return;
      }
      if (type === "session-changed") {
        // 主进程已经释放上一个用户的视图；这里清掉渲染层的运行期投影。
        setNative([]);
        setBrowserRuntime({});
        setDownloads([]);
        setNotices([]);
      }
    });
    void refreshDownloads();
    return () => off?.();
  }, [pushNotice, refreshDownloads]);

  // ---------------------------------------------------------------------------
  // 原生意图下发（几何来自 **domain**，不再来自 getBoundingClientRect()）
  // ---------------------------------------------------------------------------
  const intents: NativeIntent[] = useMemo(() => manager.nativeIntents(state, hostSize), [state, hostSize]);
  const overlayOpen = overlays.dialog || overlays.search || overlays.ai || overlays.menu || overlays.panel || locked;

  const fingerprint = useMemo(
    () =>
      JSON.stringify(
        intents.map((i) => [
          i.windowId,
          i.url,
          i.present,
          i.focused,
          i.viewport.x,
          i.viewport.y,
          i.viewport.width,
          i.viewport.height,
          i.occluders.map((o) => [o.id, o.x, o.y, o.width, o.height]),
          (i.views || []).map((v) => [v.viewId, v.url, v.active]),
        ]),
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
      if (r.mode !== "clip+snapshot" && r.mode !== "snapshot") continue;
      for (const s of r.snapshots || []) if (s.dataUrl) out.push({ windowId: r.windowId, rect: s.rect, dataUrl: s.dataUrl });
    }
    return out;
  }, [native]);

  /** 该窗口的原生视图是否此刻可见（供占位文案保持一致，避免界面撒谎）。 */
  const nativeVisibleOf = useCallback(
    (windowId: string) => {
      const r = native.find((n) => n.windowId === windowId);
      return !!r && (r.mode === "live" || r.mode === "clip+snapshot");
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
    browserRuntime,
    downloads,
    notices,
    dismissNotice: (id: string) => setNotices((list) => list.filter((n) => n.id !== id)),
    browserCommand,
    refreshDownloads,
  };
}
