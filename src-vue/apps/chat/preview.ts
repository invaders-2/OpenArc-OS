import { nextTick, reactive } from "vue";
import { langOf } from "./markdown";
import { useShellStore } from "../../stores/shell";

/**
 * 对话预览侧栏的状态（只在内存里）：打开过的条目像标签一样排在侧栏顶上。
 * 远程地址与工作文件夹文件都经主进程 chat 桥取回（electron/chat-preview.cjs），
 * 这里只拿到 openarc-preview:// 地址和文本正文。
 */
export type PreviewKind = "web" | "image" | "video" | "audio" | "pdf" | "markdown" | "csv" | "code" | "text" | "html" | "file";
export type PreviewItem = {
  id: string;
  kind: PreviewKind | "loading" | "error";
  title: string;
  /** 原始来源：http(s) 地址 / 工作文件夹相对路径 / 代码块 */
  source: { type: "url"; url: string } | { type: "workspace"; path: string } | { type: "inline" };
  previewUrl?: string;
  text?: string;
  lang?: string;
  mime?: string;
  size?: number;
  truncated?: boolean;
  error?: string;
};

const bridge = () => (window as any).openarc?.chat as { command: (c: Record<string, unknown>) => Promise<any> } | undefined;

export const preview = reactive({
  open: false,
  items: [] as PreviewItem[],
  activeId: "",
});

let seq = 0;
const newId = () => "pv" + (++seq) + "_" + Date.now().toString(36);
const MAX_ITEMS = 8;

function push(item: PreviewItem) {
  // 同一来源已经开着就切过去（刷新一遍内容）
  const key = sourceKey(item);
  const existing = key ? preview.items.find((x) => sourceKey(x) === key) : null;
  if (existing) {
    Object.assign(existing, { ...item, id: existing.id });
    preview.activeId = existing.id;
  } else {
    preview.items = [...preview.items, item].slice(-MAX_ITEMS);
    preview.activeId = item.id;
  }
  preview.open = true;
  return preview.activeId;
}
function sourceKey(item: PreviewItem) {
  if (item.source.type === "url") return "u:" + item.source.url;
  if (item.source.type === "workspace") return "w:" + item.source.path;
  return "";
}
function patch(id: string, next: Partial<PreviewItem>) {
  const it = preview.items.find((x) => x.id === id);
  if (it) Object.assign(it, next);
}

const ERR: Record<string, string> = {
  WEB_BLOCKED_HOST: "这个地址指向本机或内网，出于安全不预览。", WEB_INVALID_URL: "地址无效（只支持 http / https）。",
  WEB_DNS_FAILED: "域名解析失败。", WEB_TIMEOUT: "打开超时。", WEB_HTTP_ERROR: "网站返回了错误", WEB_NETWORK_ERROR: "网络错误，打不开这个地址。",
  WEB_TOO_MANY_REDIRECTS: "重定向次数太多。", WEB_UNAVAILABLE: "联网能力暂时不可用。", WORKSPACE_NOT_FOUND: "工作文件夹里没有这个文件。",
  WORKSPACE_PATH_OUTSIDE: "路径不在工作文件夹里。", WORKSPACE_PATH_INVALID: "路径无效。", PREVIEW_UNAVAILABLE: "预览只在 OpenArc 桌面应用里可用。",
};
export const previewError = (code?: string, detail?: string | null) => (code ? (ERR[code] || "打不开（" + code + "）") + (detail && code === "WEB_HTTP_ERROR" ? "（" + detail + "）" : "") : "打不开");

/** 预览一个 http(s) 地址：网页、图片、视频、PDF、文本都走这里。 */
export async function openUrl(url: string, title = "") {
  const id = push({ id: newId(), kind: "loading", title: title || shortUrl(url), source: { type: "url", url } });
  const b = bridge();
  if (!b) { patch(id, { kind: "error", error: previewError("PREVIEW_UNAVAILABLE") }); return; }
  const r = await b.command({ command: "preview/remote", url }).catch(() => null);
  if (!r?.ok) { patch(id, { kind: "error", error: previewError(r?.error, r?.detail) }); return; }
  patch(id, {
    kind: r.kind, title: r.title || title || r.name || shortUrl(url), previewUrl: r.previewUrl, text: r.text, mime: r.mime, size: r.size,
    truncated: !!r.truncated, lang: r.kind === "code" ? langOf(r.finalUrl || url) || (String(r.mime).includes("json") ? "json" : "") : undefined,
  });
}

/** 预览 AI 工作文件夹里的文件（附件、AI 写出的文件）。 */
export async function openWorkspace(path: string, title = "") {
  const clean = String(path || "").replace(/^\.?\//, "");
  const id = push({ id: newId(), kind: "loading", title: title || clean.split("/").pop() || clean, source: { type: "workspace", path: clean } });
  const b = bridge();
  if (!b) { patch(id, { kind: "error", error: previewError("PREVIEW_UNAVAILABLE") }); return; }
  const r = await b.command({ command: "preview/workspace", path: clean }).catch(() => null);
  if (!r?.ok) { patch(id, { kind: "error", error: previewError(r?.error) }); return; }
  patch(id, { kind: r.kind, title: r.name || clean, previewUrl: r.previewUrl, text: r.text, mime: r.mime, size: r.size, truncated: !!r.truncated, lang: r.kind === "code" ? langOf(r.name) : undefined });
}

/** 代码块：HTML / SVG 在沙箱里跑，Markdown / CSV 按格式显示，其它按代码高亮。 */
export async function openCode(code: string, lang = "", title = "") {
  const l = String(lang || "").toLowerCase();
  const name = title || (l ? l.toUpperCase() + " 代码" : "代码");
  if (l === "html" || l === "htm" || l === "svg") {
    const html = l === "svg" ? '<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;min-height:100vh">' + code + "</body>" : code;
    const b = bridge();
    const r = b ? await b.command({ command: "preview/html", html }).catch(() => null) : null;
    push({ id: newId(), kind: r?.ok ? "html" : "code", title: name, source: { type: "inline" }, previewUrl: r?.previewUrl, text: code, lang: l === "svg" ? "xml" : "xml" });
    return;
  }
  if (l === "markdown" || l === "md") { push({ id: newId(), kind: "markdown", title: name, source: { type: "inline" }, text: code }); return; }
  if (l === "csv" || l === "tsv") { push({ id: newId(), kind: "csv", title: name, source: { type: "inline" }, text: code, lang: l }); return; }
  push({ id: newId(), kind: "code", title: name, source: { type: "inline" }, text: code, lang: l });
}

/** 本地已有地址的图片 / 视频（data: / openarc-*:）直接预览。 */
export function openLocalMedia(url: string, name: string, kind: "image" | "video") {
  push({ id: newId(), kind, title: name || (kind === "video" ? "视频" : "图片"), source: { type: "url", url }, previewUrl: url });
}

export function closeItem(id: string) {
  const idx = preview.items.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const next = preview.items.filter((x) => x.id !== id);
  preview.items = next;
  if (preview.activeId === id) preview.activeId = next[Math.min(idx, next.length - 1)]?.id || "";
  if (!next.length) preview.open = false;
}
export function closePreview() { preview.open = false; }

export function shortUrl(url: string) {
  try { const u = new URL(url); return (u.hostname + u.pathname).replace(/\/$/, "").slice(0, 60); } catch { return String(url).slice(0, 60); }
}
export function sizeText(n?: number) {
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + " KB";
  return (v / 1024 / 1024).toFixed(1) + " MB";
}

/** 在 OpenArc 浏览器里打开（预览里的网页不跑脚本；要完整网页就交给浏览器）。 */
export async function openInBrowser(url: string) {
  const shell = useShellStore();
  shell.activateApp("browser");
  await nextTick();
  const win = [...shell.windows].reverse().find((w: any) => w.appId === "browser");
  if (!win) return;
  const meta: any = (win as any).meta || {};
  const tabs = Array.isArray(meta.tabs) ? meta.tabs : [];
  // 只有一个空白起始页时直接用它，否则新开一个标签。
  if (tabs.length === 1 && !tabs[0].url) { (window as any).openarc?.navigate?.(win.id, url, tabs[0].tabId); return; }
  const seq = Math.max(Number(meta.tabSeq) || 0, tabs.length) + 1;
  shell.dispatch({ type: "browser/tab-open", id: win.id, tabId: "t" + seq, url } as any);
}
