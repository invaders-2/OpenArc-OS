import { reactive } from "vue";
import { tabKey, type BrowserNotice, type DownloadRecord, type TabRuntimeMap } from "../../src/browser/types";
import { useShellStore } from "../stores/shell";

/**
 * 浏览器运行期事实（10-15 从 src/desktop/useDesktop.ts:173-325 原样搬到 Vue）：
 * 标签加载状态 / 错误 / 提示 / 下载 / 原生视图结算结果 / 视口让位高度。
 * 都是**内存投影**，不持久化；权威仍在主进程与窗口域。
 */
export type NativeResult = {
  windowId: string;
  mode: "live" | "clip+snapshot" | "snapshot" | "hidden" | "closed";
  bounds?: { x: number; y: number; width: number; height: number };
  snapshots?: { rect: { x: number; y: number; width: number; height: number }; dataUrl: string | null }[];
};

export const browserRuntime = reactive({
  runtime: {} as TabRuntimeMap,
  downloads: [] as DownloadRecord[],
  notices: [] as BrowserNotice[],
  native: [] as NativeResult[],
  reserves: {} as Record<string, number>,
  /** 下载面板打开：原生视图必须整块让位（DOM 盖不住 WebContentsView） */
  panelOpen: false,
});

let noticeSeq = 0;
function pushNotice(notice: Omit<BrowserNotice, "id">) {
  noticeSeq += 1;
  const list = browserRuntime.notices;
  if (
    notice.kind === "permission" &&
    list.some((n) => n.kind === "permission" && n.origin === notice.origin && n.permission === notice.permission)
  )
    return;
  browserRuntime.notices = [...list.slice(-7), { ...notice, id: `n${noticeSeq}` } as BrowserNotice];
}

export async function refreshDownloads() {
  const bridge = window.openarc?.browser;
  if (!bridge) return;
  const res = await bridge({ type: "browser/downloads", action: "list" });
  if (Array.isArray(res?.items)) browserRuntime.downloads = res.items as DownloadRecord[];
}

/** 受控浏览器命令（下载 / 标签授权 / 用户确认后的外部打开），返回值原样给调用方。 */
export async function browserCommand(command: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bridge = window.openarc?.browser;
  if (!bridge) return {};
  const res = (await bridge(command)) as { items?: unknown };
  if (Array.isArray(res?.items)) browserRuntime.downloads = res.items as DownloadRecord[];
  return (res as Record<string, unknown>) || {};
}

export function dismissNotice(id: string) {
  browserRuntime.notices = browserRuntime.notices.filter((n) => n.id !== id);
}
export function reportViewportReserve(windowId: string, reserve: number) {
  if (browserRuntime.reserves[windowId] === reserve) return;
  browserRuntime.reserves = { ...browserRuntime.reserves, [windowId]: reserve };
}
export function nativeVisibleOf(windowId: string) {
  const r = browserRuntime.native.find((n) => n.windowId === windowId);
  return !!r && (r.mode === "live" || r.mode === "clip+snapshot");
}
export function snapshotsOf(windowId: string) {
  const r = browserRuntime.native.find((n) => n.windowId === windowId);
  if (!r || (r.mode !== "clip+snapshot" && r.mode !== "snapshot")) return [];
  return (r.snapshots || []).filter((s) => !!s.dataUrl) as { rect: NativeResult["bounds"] & {}; dataUrl: string }[];
}

/** 原生状态只读回灌（与 useDesktop.ts 同一套事件分派）。返回卸载函数。 */
export function installBrowserRuntime(): () => void {
  const shell = useShellStore();
  const off = window.openarc?.onNativeState?.((e: any) => {
    const type = String(e?.type || "");
    const windowId = String(e?.windowId || "");
    const tabId = e?.tabId == null ? null : String(e.tabId);
    if (type === "native-state") {
      shell.dispatch({ type: "system/native-state", windowId, tabId: tabId ?? undefined, url: e.url, title: e.title } as any);
      if (tabId) {
        const loadError = e.loadError as { code: number; message: string; url: string } | null | undefined;
        browserRuntime.runtime = {
          ...browserRuntime.runtime,
          [tabKey(windowId, tabId)]: {
            loading: !!e.loading,
            canGoBack: !!e.canGoBack,
            canGoForward: !!e.canGoForward,
            attached: e.attached !== false,
            error: loadError
              ? { code: Number(loadError.code) || 0, message: String(loadError.message || "网页加载失败"), url: String(loadError.url || "") }
              : null,
          },
        };
      }
      return;
    }
    if (type === "load-failed") {
      if (e.url) shell.dispatch({ type: "system/native-state", windowId, tabId: tabId ?? undefined, url: String(e.url) } as any);
      return;
    }
    if (type === "popup-blocked")
      return pushNotice({ kind: "popup", windowId, tabId, url: String(e.url || ""), message: "网页尝试打开新窗口，已阻止。" } as any);
    if (type === "external-protocol")
      return pushNotice({
        kind: "external",
        windowId,
        tabId,
        url: String(e.url || ""),
        scheme: String(e.scheme || ""),
        message: `网页请求用系统处理 ${String(e.scheme || "")}: 链接。`,
      } as any);
    if (type === "navigate-blocked")
      return pushNotice({ kind: "blocked", windowId, tabId, url: String(e.url || ""), message: "仅允许 HTTP / HTTPS 网页。" } as any);
    if (type === "permission-denied")
      return pushNotice({
        kind: "permission",
        windowId,
        tabId: null,
        url: String(e.origin || ""),
        origin: String(e.origin || ""),
        permission: String(e.permission || ""),
        message: `已拒绝 ${String(e.origin || "该网站")} 的 ${String(e.permission || "权限")} 申请。`,
      } as any);
    if (type === "certificate-error")
      return pushNotice({ kind: "certificate", windowId, tabId, url: String(e.url || ""), message: `证书校验失败（${String(e.error || "")}），未加载该网页。` } as any);
    if (type === "render-gone")
      return pushNotice({ kind: "gone", windowId, tabId, url: "", message: `网页进程已退出（${String(e.reason || "")}）。` } as any);
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
      } as DownloadRecord;
      const list = [...browserRuntime.downloads];
      const i = list.findIndex((d) => d.downloadId === record.downloadId);
      if (i < 0) list.unshift(record);
      else list[i] = { ...list[i], ...record };
      browserRuntime.downloads = list;
      if (record.state !== "progressing") void refreshDownloads();
      return;
    }
    if (type === "session-changed") {
      browserRuntime.native = [];
      browserRuntime.runtime = {};
      browserRuntime.downloads = [];
      browserRuntime.notices = [];
    }
  });
  void refreshDownloads();
  return () => off?.();
}
