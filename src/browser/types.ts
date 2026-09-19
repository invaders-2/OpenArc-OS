/**
 * D5-01 · 浏览器窗口的运行期数据（**不持久化**）。
 *
 * 持久化的只有标签本身（在 Window domain 的 meta 里）。
 * loading / 错误 / 前进后退可用性 / 下载 / 提示都是"此刻的事实"，
 * 因此活在渲染进程的内存投影里，绝不复用、绝不写进 localStorage。
 */

/** 每个标签的运行期状态。key = `windowId#tabId`（与原生 viewId 同一口径）。 */
export type TabRuntime = {
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: { code: number; message: string; url: string } | null;
};

export type TabRuntimeMap = Record<string, TabRuntime>;

export type DownloadState = "progressing" | "completed" | "cancelled" | "interrupted";

/** 下载记录（主进程 safe 投影；按用户隔离，见 electron/browser-downloads.cjs）。 */
export type DownloadRecord = {
  downloadId: string;
  filename: string;
  state: DownloadState;
  received: number;
  total: number;
  source: string;
  savePath: string;
  startedAt: number;
  endedAt: number | null;
};

/**
 * 浏览器提示。它们全部来自**原生层的事实**：
 * 弹窗被阻止 / 外部协议 / 权限被拒 / 证书错误 / 导航被拒 / 渲染进程崩溃。
 * 没有一条是"为了好看"造出来的。
 */
export type BrowserNotice = {
  id: string;
  kind: "popup" | "external" | "permission" | "blocked" | "certificate" | "gone";
  windowId: string;
  tabId: string | null;
  url: string;
  scheme?: string;
  permission?: string;
  origin?: string;
  message: string;
};

export const tabKey = (windowId: string, tabId: string): string => windowId + "#" + tabId;

export const EMPTY_TAB_RUNTIME: TabRuntime = { loading: false, canGoBack: false, canGoForward: false, error: null };

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const DOWNLOAD_STATE_TEXT: Record<DownloadState, string> = {
  progressing: "下载中",
  completed: "已完成",
  cancelled: "已取消",
  interrupted: "失败",
};
