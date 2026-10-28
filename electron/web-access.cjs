"use strict";
/**
 * 全局 AI 联网：只读的网页搜索（web.search）与网页抓取（web.fetch）。
 *
 * 设计要点：
 *   · 只发 GET，不带 Cookie / 凭据，不执行脚本 —— 纯读取。
 *   · 出网走注入的 fetch（生产里是模型出网代理 modelService.fetchImpl，晚绑定），
 *     用户配了代理就走代理，没配就直连。
 *   · SSRF 防护：只允许无凭据的 http(s)；拒绝 localhost / 回环 / 私网 / 链路本地 /
 *     CGNAT / 云元数据地址；直连时先做 DNS 解析并校验每个解析结果；
 *     重定向手动跟随（上限 MAX_REDIRECTS），每一跳都重新校验。
 *   · 大小 / 时间 / 字数都有上限；返回的正文一律标注 untrusted（参考资料，绝不是指令）。
 *   · 搜索不需要 API Key：先试 Bing 网页版，失败再试 DuckDuckGo 网页版。
 */
const { lookup: dnsLookup } = require("node:dns/promises");
const { isIP } = require("node:net");
const { isBlockedArtifactAddress, isBlockedArtifactHost } = require("./protocol-engine/artifactDownload.cjs");

const WEB_ERROR = Object.freeze({
  INVALID_URL: "WEB_INVALID_URL",
  BLOCKED_HOST: "WEB_BLOCKED_HOST",
  DNS_FAILED: "WEB_DNS_FAILED",
  TOO_MANY_REDIRECTS: "WEB_TOO_MANY_REDIRECTS",
  HTTP_ERROR: "WEB_HTTP_ERROR",
  UNSUPPORTED_CONTENT: "WEB_UNSUPPORTED_CONTENT",
  TOO_LARGE: "WEB_TOO_LARGE",
  TIMEOUT: "WEB_TIMEOUT",
  NETWORK: "WEB_NETWORK_ERROR",
  NO_RESULTS: "WEB_NO_RESULTS",
  UNAVAILABLE: "WEB_UNAVAILABLE",
  CANCELLED: "WEB_CANCELLED",
});

const MAX_REDIRECTS = 4;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_SEARCH_TIMEOUT_MS = 8000;
const DEFAULT_MAX_CHARS = 12000;
const MAX_CHARS_CAP = 30000;
const MAX_SEARCH_RESULTS = 10;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";
const TEXT_TYPES = /^(text\/(html|plain|xml|markdown|csv)|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))/i;

class WebAccessError extends Error {
  constructor(code, detail = null) { super(code); this.code = code; this.detail = detail; }
}

// ---------- HTML → 文本 ----------

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™", times: "×", divide: "÷", deg: "°", yen: "¥", euro: "€", pound: "£", cent: "¢", sect: "§", para: "¶" };

function decodeEntities(text) {
  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

function collapse(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(html) { return collapse(decodeEntities(String(html || "").replace(/<[^>]*>/g, " "))); }

function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (m) return stripTags(m[1]).slice(0, 300);
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i.exec(html);
  return og ? stripTags(og[1]).slice(0, 300) : "";
}

/** 只取正文：去掉脚本 / 样式 / 导航等噪声；有足够长的 <article>/<main> 就只用它。 */
function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|template|iframe|object|canvas|head)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const focus = (tag) => {
    const re = new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag + "\\s*>", "gi");
    let best = "";
    for (let m = re.exec(s); m; m = re.exec(s)) if (m[1].length > best.length) best = m[1];
    return best;
  };
  const main = focus("article") || focus("main");
  if (main && stripTags(main).length > 400) s = main;
  else s = s.replace(/<(nav|footer|aside|form)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<(br|hr)\b[^>]*>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n• ");
  s = s.replace(/<\/(p|div|section|article|main|header|ul|ol|table|tr|h[1-6]|blockquote|pre|dd|dt|figure|figcaption)\s*>/gi, "\n");
  s = s.replace(/<(h[1-6])\b[^>]*>/gi, "\n\n");
  s = s.replace(/<\/t[dh]\s*>/gi, " \t");
  s = s.replace(/<[^>]*>/g, " ");
  return collapse(decodeEntities(s));
}

// ---------- 字符集 ----------

function charsetOf(contentType, head) {
  const fromHeader = /charset=["']?([\w.:-]+)/i.exec(String(contentType || ""));
  if (fromHeader) return fromHeader[1].toLowerCase();
  const sniff = head.toString("latin1");
  const meta = /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(sniff);
  if (meta) return meta[1].toLowerCase();
  const xml = /<\?xml[^>]+encoding=["']([\w.:-]+)["']/i.exec(sniff);
  return xml ? xml[1].toLowerCase() : "utf-8";
}

function decodeBody(buffer, contentType) {
  let charset = charsetOf(contentType, buffer.subarray(0, 4096));
  if (charset === "gb2312" || charset === "gbk") charset = "gb18030";
  try { return new TextDecoder(charset).decode(buffer); } catch { return new TextDecoder("utf-8").decode(buffer); }
}

// ---------- 搜索结果解析 ----------

function bingTarget(href) {
  const raw = decodeEntities(href);
  try {
    const u = new URL(raw, "https://www.bing.com");
    if (/(^|\.)bing\.com$/i.test(u.hostname) && u.pathname.startsWith("/ck/")) {
      const enc = u.searchParams.get("u");
      if (enc && enc.startsWith("a1")) {
        const decoded = Buffer.from(enc.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
      return null;
    }
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}

function parseBing(html) {
  const out = [];
  const blocks = String(html || "").split(/<li[^>]+class="[^"]*\bb_algo\b[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const url = bingTarget(a[1]);
    if (!url) continue;
    const snip = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block) || /<div[^>]+class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    out.push({ title: stripTags(a[2]).slice(0, 200), url, snippet: snip ? stripTags(snip[1]).replace(/^\S*\s*·\s*/, "").slice(0, 400) : "" });
  }
  return out;
}

function ddgTarget(href) {
  const raw = decodeEntities(href);
  try {
    const u = new URL(raw, "https://duckduckgo.com");
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname) && u.pathname.startsWith("/l/")) {
      const target = u.searchParams.get("uddg");
      return target && /^https?:\/\//i.test(target) ? target : null;
    }
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname)) return null;
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}

function parseDuckDuckGo(html) {
  const out = [];
  const re = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*\bresult__a\b|$)/gi;
  for (let m = re.exec(String(html || "")); m; m = re.exec(String(html || ""))) {
    const url = ddgTarget(m[1]);
    if (!url) continue;
    const snip = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/i.exec(m[3]);
    out.push({ title: stripTags(m[2]).slice(0, 200), url, snippet: snip ? stripTags(snip[1]).slice(0, 400) : "" });
  }
  return out;
}

const SEARCH_PROVIDERS = Object.freeze([
  { id: "bing", url: (q) => "https://www.bing.com/search?q=" + encodeURIComponent(q) + "&count=20&form=QBLH", parse: parseBing },
  { id: "duckduckgo", url: (q) => "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), parse: parseDuckDuckGo },
]);

// ---------- 服务 ----------

function validateUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch { throw new WebAccessError(WEB_ERROR.INVALID_URL); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebAccessError(WEB_ERROR.INVALID_URL, "protocol");
  if (url.username || url.password) throw new WebAccessError(WEB_ERROR.INVALID_URL, "credentials");
  if (isBlockedArtifactHost(url.hostname)) throw new WebAccessError(WEB_ERROR.BLOCKED_HOST, url.hostname);
  url.hash = "";
  return url;
}

/** 审计里只记 origin + 路径（不记查询串，避免把 token 之类写进日志）。 */
function auditUrl(raw) {
  try { const u = new URL(String(raw)); return (u.origin + u.pathname).slice(0, 300); } catch { return ""; }
}

/**
 * @param {object} opts
 * @param {() => Function|null} opts.getFetch 晚绑定的出网 fetch（生产：modelService.fetchImpl）
 * @param {() => boolean} [opts.isProxied] 当前是否经代理出网（经代理时 DNS 由代理解析，本地只校验主机名）
 * @param {Function} [opts.lookup] DNS 解析（测试可注入）
 */
function createWebAccess({ getFetch = null, isProxied = null, lookup = dnsLookup, timeoutMs = DEFAULT_TIMEOUT_MS, searchTimeoutMs = DEFAULT_SEARCH_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, providers = SEARCH_PROVIDERS, logger = null, clock = null } = {}) {
  const now = () => (clock && typeof clock.now === "function" ? clock.now() : Date.now());
  const fetchFn = () => {
    const f = typeof getFetch === "function" ? getFetch() : null;
    if (typeof f === "function") return f;
    return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
  };
  const log = (event, extra) => { try { if (logger && typeof logger.log === "function") logger.log({ scope: "web-access", event, ...(extra || {}), at: now() }); } catch { /* 日志失败不影响业务 */ } };

  async function checkResolved(url) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) return;
    // 经代理出网时由代理解析域名；本地解析失败（常见于本地 DNS 不通才配代理）就放行，
    // 但只要本地解析出私网地址，照样拒绝。
    const proxied = typeof isProxied === "function" && !!isProxied();
    let addresses;
    try { addresses = await lookup(host, { all: true, verbatim: true }); } catch { if (proxied) return; throw new WebAccessError(WEB_ERROR.DNS_FAILED, host); }
    if (!Array.isArray(addresses) || !addresses.length) { if (proxied) return; throw new WebAccessError(WEB_ERROR.DNS_FAILED, host); }
    for (const entry of addresses) if (isBlockedArtifactAddress(entry && entry.address)) throw new WebAccessError(WEB_ERROR.BLOCKED_HOST, host);
  }

  async function readCapped(response, cap) {
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > cap) throw new WebAccessError(WEB_ERROR.TOO_LARGE, String(declared));
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > cap) {
          // 超限：只保留上限内的部分（网页正文截断比整页报错更有用）。
          chunks.push(Buffer.from(value.subarray(0, value.byteLength - (bytes - cap))));
          try { await reader.cancel(); } catch { /* ignore */ }
          return { buffer: Buffer.concat(chunks), truncated: true };
        }
        chunks.push(Buffer.from(value));
      }
      return { buffer: Buffer.concat(chunks), truncated: false };
    }
    const all = Buffer.from(await response.arrayBuffer());
    return all.length > cap ? { buffer: all.subarray(0, cap), truncated: true } : { buffer: all, truncated: false };
  }

  /** GET + 手动跟随重定向（每一跳都重新做 SSRF 校验）。 */
  async function get(rawUrl, { signal = null, timeout = timeoutMs, accept = "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", lang = "zh-CN,zh;q=0.9,en;q=0.8" } = {}) {
    const f = fetchFn();
    if (!f) throw new WebAccessError(WEB_ERROR.UNAVAILABLE, "no-fetch");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new WebAccessError(WEB_ERROR.TIMEOUT)), Math.max(500, Number(timeout) || DEFAULT_TIMEOUT_MS));
    const onOuter = () => controller.abort(new WebAccessError(WEB_ERROR.CANCELLED));
    if (signal) { if (signal.aborted) onOuter(); else signal.addEventListener("abort", onOuter, { once: true }); }
    try {
      let url = validateUrl(rawUrl);
      for (let hop = 0; ; hop += 1) {
        await checkResolved(url);
        let response;
        try {
          response = await f(url.href, { method: "GET", redirect: "manual", credentials: "omit", signal: controller.signal, headers: { "user-agent": USER_AGENT, accept, "accept-language": lang } });
        } catch (err) {
          if (controller.signal.aborted) {
            const reason = controller.signal.reason;
            throw reason instanceof WebAccessError ? reason : new WebAccessError(WEB_ERROR.TIMEOUT);
          }
          throw new WebAccessError(WEB_ERROR.NETWORK, String((err && (err.code || err.message)) || "fetch-failed").slice(0, 120));
        }
        const status = Number(response.status) || 0;
        if (status >= 300 && status < 400) {
          const location = response.headers.get("location");
          try { await response.body?.cancel?.(); } catch { /* ignore */ }
          if (!location) throw new WebAccessError(WEB_ERROR.HTTP_ERROR, String(status));
          if (hop >= MAX_REDIRECTS) throw new WebAccessError(WEB_ERROR.TOO_MANY_REDIRECTS);
          url = validateUrl(new URL(location, url).href);
          continue;
        }
        return { response, url, status };
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onOuter);
    }
  }

  async function fetchPage({ url, maxChars = DEFAULT_MAX_CHARS, signal = null } = {}) {
    const started = now();
    const limit = Math.max(500, Math.min(MAX_CHARS_CAP, Number(maxChars) || DEFAULT_MAX_CHARS));
    try {
      const { response, url: finalUrl, status } = await get(url, { signal });
      if (status < 200 || status >= 300) {
        try { await response.body?.cancel?.(); } catch { /* ignore */ }
        throw new WebAccessError(WEB_ERROR.HTTP_ERROR, String(status));
      }
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (contentType && !TEXT_TYPES.test(contentType)) {
        try { await response.body?.cancel?.(); } catch { /* ignore */ }
        throw new WebAccessError(WEB_ERROR.UNSUPPORTED_CONTENT, contentType.split(";")[0].slice(0, 80));
      }
      const { buffer, truncated: cut } = await readCapped(response, maxBytes);
      const body = decodeBody(buffer, contentType);
      const looksHtml = /<(html|body)\b/i.test(body.slice(0, 20000));
      const isHtml = /html/.test(contentType) || (!contentType && looksHtml);
      const isXml = !isHtml && /xml/.test(contentType);
      const title = isHtml ? htmlTitle(body) : "";
      const full = isHtml ? htmlToText(body) : isXml ? stripTags(body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")) : collapse(body);
      const text = full.length > limit ? full.slice(0, limit) : full;
      log("fetch", { ok: true, url: auditUrl(finalUrl.href), status, chars: text.length, ms: now() - started });
      return { ok: true, result: { url: String(url).slice(0, 2000), finalUrl: finalUrl.href.slice(0, 2000), status, contentType: contentType.split(";")[0].slice(0, 80), title, text, truncated: cut || full.length > limit, untrusted: true } };
    } catch (err) {
      const code = err instanceof WebAccessError ? err.code : WEB_ERROR.NETWORK;
      log("fetch", { ok: false, url: auditUrl(url), error: code, ms: now() - started });
      return { ok: false, error: code, detail: err instanceof WebAccessError ? err.detail : null };
    }
  }

  async function search({ query, limit = 6, signal = null } = {}) {
    const q = String(query || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!q) return { ok: false, error: WEB_ERROR.INVALID_URL, detail: "empty-query" };
    const n = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(Number(limit) || 6)));
    const started = now();
    const errors = [];
    for (const provider of providers) {
      try {
        const { response, status } = await get(provider.url(q), { signal, timeout: searchTimeoutMs });
        if (status < 200 || status >= 300) { try { await response.body?.cancel?.(); } catch { /* ignore */ } throw new WebAccessError(WEB_ERROR.HTTP_ERROR, String(status)); }
        const { buffer } = await readCapped(response, maxBytes);
        const html = decodeBody(buffer, response.headers.get("content-type"));
        const seen = new Set();
        const results = [];
        for (const item of provider.parse(html)) {
          if (seen.has(item.url)) continue;
          seen.add(item.url);
          results.push(item);
          if (results.length >= n) break;
        }
        if (!results.length) throw new WebAccessError(WEB_ERROR.NO_RESULTS);
        log("search", { ok: true, provider: provider.id, results: results.length, ms: now() - started });
        return { ok: true, result: { query: q, provider: provider.id, results, untrusted: true } };
      } catch (err) {
        if (signal && signal.aborted) return { ok: false, error: WEB_ERROR.CANCELLED };
        errors.push(provider.id + ":" + (err instanceof WebAccessError ? err.code : WEB_ERROR.NETWORK));
      }
    }
    log("search", { ok: false, errors, ms: now() - started });
    const allEmpty = errors.length && errors.every((e) => e.endsWith(WEB_ERROR.NO_RESULTS));
    return { ok: false, error: allEmpty ? WEB_ERROR.NO_RESULTS : WEB_ERROR.UNAVAILABLE, detail: errors.join(",").slice(0, 200) };
  }

  return { search, fetch: fetchPage };
}

/** 把搜索结果整理成给模型看的参考资料块（画布联网开关用）。 */
function formatSearchContext(result, { maxChars = 4000 } = {}) {
  if (!result || !Array.isArray(result.results) || !result.results.length) return "";
  const lines = result.results.map((r, i) => "[" + (i + 1) + "] " + r.title + "\n" + r.url + (r.snippet ? "\n" + r.snippet : ""));
  const text = lines.join("\n\n");
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}

module.exports = {
  createWebAccess, formatSearchContext, htmlToText, htmlTitle, decodeEntities, decodeBody,
  parseBing, parseDuckDuckGo, validateUrl, WebAccessError, WEB_ERROR, SEARCH_PROVIDERS,
  MAX_SEARCH_RESULTS, MAX_CHARS_CAP,
};
