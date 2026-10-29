import { reactive } from "vue";

/**
 * 全局 AI 联网过程的界面数据（参照 Codex / ChatGPT）：
 *   · 搜索：搜索词 + 结果（标题 / 地址 / 摘要）
 *   · 读取网页：地址 + 标题
 * 来源：后端事件 harness.web_activity（落库）和运行中的 task/progress kind "web"（实时）。
 */
export type WebResult = { title: string; url: string; snippet?: string };
export type WebAct = {
  key: string;
  kind: "search" | "fetch";
  /** start = 正在进行；done = 有结果（ok=false 时是失败） */
  phase: "start" | "done";
  ok: boolean;
  query?: string;
  url?: string;
  title?: string;
  results: WebResult[];
  error?: string;
};
export type Source = { url: string; title: string; host: string; snippet?: string; cited: boolean; read: boolean };

const httpUrl = (v: unknown) => { const s = String(v ?? "").trim(); return /^https?:\/\//i.test(s) ? s : ""; };

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; }
}

/** 一条事件 / 进度 → 界面记录（不认识的形状返回 null）。 */
export function toWebAct(p: any, key: string): WebAct | null {
  if (!p || typeof p !== "object") return null;
  const kind = p.kind === "search" ? "search" : p.kind === "fetch" ? "fetch" : null;
  if (!kind) return null;
  const phase = p.phase === "start" ? "start" : "done";
  const results: WebResult[] = Array.isArray(p.results)
    ? p.results.map((r: any) => ({ title: String(r?.title || ""), url: httpUrl(r?.url), snippet: String(r?.snippet || "") })).filter((r: WebResult) => r.url)
    : [];
  const act: WebAct = { key, kind, phase, ok: phase === "done" ? p.ok !== false : true, results };
  if (kind === "search") { act.query = String(p.query || ""); if (!act.query) return null; }
  else { act.url = httpUrl(p.finalUrl) || httpUrl(p.url); act.title = String(p.title || ""); if (!act.url) return null; }
  if (p.error) act.error = String(p.error);
  return act;
}

/** 运行中的联网进度：同一个 callId 先是 start，再被 done 替换。 */
export function mergeLiveWeb(list: WebAct[], p: any): WebAct[] {
  const callId = String(p?.callId || "");
  const act = toWebAct(p, "live:" + (callId || list.length));
  if (!act) return list;
  const i = callId ? list.findIndex((x) => x.key === act.key) : -1;
  if (i >= 0) { const next = list.slice(); next[i] = act; return next; }
  return [...list, act].slice(-24);
}

/** 回答里的 http(s) 链接（Markdown 链接和裸地址）。 */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  const s = String(text || "");
  for (const m of s.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) out.push(m[1]);
  for (const m of s.matchAll(/https?:\/\/[^\s)）>\]"'<]+/g)) out.push(m[0].replace(/[.,;:!?。，；：！？」』]+$/, ""));
  return [...new Set(out)];
}

const norm = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "").replace(/^http:/i, "https:").replace(/\/\/www\./i, "//");

/**
 * 来源列表（回答下方「N 个来源」）：先列回答里引用到的，再列读过的网页；
 * 两者都没有时退回搜索结果的前几条。标题优先用搜索结果 / 网页标题。
 */
export function sourcesOf(acts: WebAct[], answer: string): Source[] {
  const titles = new Map<string, { title: string; snippet?: string }>();
  for (const a of acts) {
    for (const r of a.results) if (!titles.has(norm(r.url))) titles.set(norm(r.url), { title: r.title, snippet: r.snippet });
    if (a.kind === "fetch" && a.url && a.title) titles.set(norm(a.url), { ...(titles.get(norm(a.url)) || {}), title: a.title });
  }
  const read = new Set(acts.filter((a) => a.kind === "fetch" && a.ok && a.phase === "done" && a.url).map((a) => norm(a.url!)));
  const out = new Map<string, Source>();
  const add = (url: string, cited: boolean) => {
    const k = norm(url); const host = hostOf(url); if (!host) return;
    const prev = out.get(k);
    if (prev) { prev.cited = prev.cited || cited; return; }
    const t = titles.get(k);
    out.set(k, { url, title: t?.title || host, host, snippet: t?.snippet, cited, read: read.has(k) });
  };
  if (acts.length) for (const u of linksIn(answer)) add(u, true);
  for (const a of acts) if (a.kind === "fetch" && a.ok && a.phase === "done" && a.url) add(a.url, false);
  if (!out.size) for (const a of acts) for (const r of a.results.slice(0, 4)) add(r.url, false);
  return [...out.values()].slice(0, 20);
}

/** 联网过程一句话摘要（Codex：「已搜索网页」；ChatGPT：「已搜索 N 个网站」）。 */
export function webSummary(acts: WebAct[]): string {
  const searches = acts.filter((a) => a.kind === "search").length;
  const reads = acts.filter((a) => a.kind === "fetch" && a.ok).length;
  const sites = new Set<string>();
  for (const a of acts) { for (const r of a.results) sites.add(hostOf(r.url)); if (a.kind === "fetch" && a.url) sites.add(hostOf(a.url)); }
  sites.delete("");
  const parts: string[] = [];
  if (searches) parts.push("搜索了 " + searches + " 次");
  if (reads) parts.push("读了 " + reads + " 个网页");
  return (parts.join("，") || "联网") + (sites.size ? " · " + sites.size + " 个网站" : "");
}

/* ---------- 网站图标：经主进程取回（同一套出网检查），按域名缓存；取不到就用首字母 ---------- */
const icons = reactive<Record<string, string>>({});
const asked = new Set<string>();
export function iconOf(host: string): string {
  const h = String(host || "").toLowerCase();
  if (!h) return "";
  if (h in icons) return icons[h];
  if (!asked.has(h)) {
    asked.add(h);
    const bridge = (window as any).openarc?.chat;
    if (bridge?.command) {
      void bridge.command({ command: "favicon/get", host: h }).then((r: any) => { icons[h] = r?.ok && typeof r.dataUrl === "string" && r.dataUrl.startsWith("data:image/") ? r.dataUrl : ""; }).catch(() => { icons[h] = ""; });
    } else icons[h] = "";
  }
  return icons[h] || "";
}
/** 首字母图标的底色：按域名算一个稳定的色相。 */
export function hueOf(host: string): number {
  let n = 0; for (const c of String(host || "")) n = (n * 31 + c.charCodeAt(0)) % 360;
  return n;
}

/**
 * 回答正文里的引用小标签（ChatGPT 式）：链接文字本身就是地址 / 域名 / 序号 / 「来源」时，
 * 换成「图标 + 域名」的小标签；正常文字链接不动。
 */
export function citeLinks(html: string): string {
  return html.replace(/<a ([^>]*?)href="(https?:\/\/[^"]+)"([^>]*)>([\s\S]*?)<\/a>/g, (whole, pre, href, post, inner) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    const host = hostOf(href.replace(/&amp;/g, "&"));
    if (!host) return whole;
    const looksCite = /^\[?\d{1,2}\]?$/.test(text) || /^(来源|出处|source|link|链接)\s*\d*$/i.test(text) || /^https?:\/\//i.test(text) || text.replace(/^www\./i, "").toLowerCase() === host;
    if (!looksCite) return whole;
    const icon = iconOf(host);
    const ic = icon ? '<img class="md-cite-ic" src="' + icon + '" alt="">' : '<span class="md-cite-ic md-cite-letter" style="--h:' + hueOf(host) + '">' + host[0].toUpperCase() + "</span>";
    return "<a " + pre + 'href="' + href + '"' + post + ' class="md-cite" title="' + href + '（按住 ⌘ / Ctrl 点击在浏览器打开）">' + ic + "<span>" + host + "</span></a>";
  });
}

/* ---------- 网页卡片预览（缩略图 / 网站名）：经主进程取 og:image，按地址缓存 ---------- */
export type LinkCard = { image: string; siteName: string; title: string; description: string };
const linkCards = reactive<Record<string, LinkCard | null>>({});
const linkAsked = new Set<string>();
export function cardOf(url: string): LinkCard | null {
  const u = String(url || "");
  if (!/^https?:\/\//i.test(u)) return null;
  if (u in linkCards) return linkCards[u];
  if (!linkAsked.has(u)) {
    linkAsked.add(u);
    const bridge = (window as any).openarc?.chat;
    if (bridge?.command) {
      void bridge.command({ command: "link/preview", url: u }).then((r: any) => {
        linkCards[u] = r?.ok ? { image: typeof r.image === "string" && r.image.startsWith("data:image/") ? r.image : "", siteName: String(r.siteName || ""), title: String(r.title || ""), description: String(r.description || "") } : null;
      }).catch(() => { linkCards[u] = null; });
    } else linkCards[u] = null;
  }
  return linkCards[u] ?? null;
}
