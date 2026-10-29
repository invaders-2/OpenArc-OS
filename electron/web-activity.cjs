"use strict";
/**
 * 全局 AI 联网过程的展示记录（参照 Codex / ChatGPT：显示搜了什么、拿到哪些结果、读了哪些网页）。
 *
 * 只从 web.search / web.fetch 的参数和结果里摘出界面要用的几项，全部限长限量：
 *   · search：搜索词 + 最多 8 条结果（标题、地址、一小段摘要）
 *   · fetch：地址、最终地址、网页标题
 * 不存网页正文。只收 http(s) 地址。
 */

const MAX_RESULTS = 8;
const WEB_TOOLS = new Set(["web.search", "web.fetch", "web_search", "web_fetch"]);

const clip = (v, n) => { const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

function httpUrl(v) {
  const s = String(v == null ? "" : v).trim();
  if (!/^https?:\/\//i.test(s) || s.length > 400) return "";
  try { const u = new URL(s); return u.username || u.password ? "" : u.href; } catch { return ""; }
}

/**
 * 工具旁听回调 → 展示记录；不是联网工具返回 null。
 * phase: "start"（正在搜索 / 正在读取）或 "done"（带结果；失败时 ok=false）。
 */
function webActivityOf(update) {
  if (!update || typeof update !== "object") return null;
  const toolId = String(update.toolId || "");
  if (!WEB_TOOLS.has(toolId)) return null;
  const kind = /search/.test(toolId) ? "search" : "fetch";
  const args = update.args && typeof update.args === "object" ? update.args : {};
  const phase = update.phase === "done" ? "done" : "start";
  const rec = { kind, phase, callId: clip(update.callId, 80) };
  if (kind === "search") {
    rec.query = clip(args.query, 200);
    if (!rec.query) return null;
  } else {
    rec.url = httpUrl(args.url);
    if (!rec.url) return null;
  }
  if (phase === "start") return rec;
  rec.ok = update.ok === true;
  if (!rec.ok) { rec.error = clip(update.error, 60); return rec; }
  const r = update.result && typeof update.result === "object" ? update.result : {};
  if (kind === "search") {
    const list = Array.isArray(r.results) ? r.results : [];
    rec.results = [];
    for (const it of list) {
      if (rec.results.length >= MAX_RESULTS) break;
      const url = httpUrl(it && it.url);
      if (!url) continue;
      rec.results.push({ title: clip(it.title, 120) || url, url, snippet: clip(it.snippet, 160) });
    }
  } else {
    rec.finalUrl = httpUrl(r.finalUrl) || rec.url;
    rec.title = clip(r.title, 120);
  }
  return rec;
}

module.exports = { webActivityOf, WEB_TOOLS };
