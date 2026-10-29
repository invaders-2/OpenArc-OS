"use strict";
/**
 * 全局 AI 对话：预览侧栏 + 附件上传的主进程一侧。
 *
 * 预览走自有协议 openarc-preview://<区>/<口令>/<…>：
 *   · r —— 远程 http(s) 文件（经 web-access 同一套 SSRF 防护取回，放在内存里）；
 *   · w —— AI 工作文件夹里的文件（只读，路径必须仍在工作文件夹内）；
 *   · h —— 对话里代码块生成的 HTML（只在内存里）。
 * 口令每次启动随机生成，只经可信 IPC 发给对话界面；没有口令的请求一律 404，
 * 所以浏览器标签里的网页、预览里的网页都拿不到这些内容。
 *
 * 安全边界（响应头 CSP）：
 *   · 远程网页：不执行脚本（script-src 'none'），只放行图片 / 样式 / 字体；
 *   · 生成的 HTML 与工作文件夹里的 HTML：可以跑内联脚本，但不能联网（connect / img / font 都只认 data:），
 *     iframe 再加 sandbox（不给 same-origin），既读不到本应用，也带不出对话内容。
 *
 * 附件：对话界面把用户选的文件原样交过来，写进工作文件夹 uploads/<日期>/，AI 用 workspace_read 读。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveInside } = require("./agent-workspace.cjs");
const { htmlTitle, htmlToText, decodeBody } = require("./web-access.cjs");

const SCHEME = "openarc-preview";
const MAX_REMOTE_BYTES = 80 * 1024 * 1024;
const MAX_CACHE_BYTES = 240 * 1024 * 1024;
const MAX_TEXT_CHARS = 400000;
const MAX_HTML_DOCS = 40;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const EXT_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac",
  pdf: "application/pdf", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", html: "text/html", htm: "text/html", txt: "text/plain", log: "text/plain", xml: "application/xml",
};
const CODE_EXT = new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "cc", "cs", "php", "sh", "bash", "zsh", "ps1", "sql", "css", "scss", "less", "yaml", "yml", "toml", "ini", "lua", "r", "dart", "scala", "diff", "patch", "dockerfile", "xml"]);

const CSP_REMOTE = "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https: http:; font-src https: http: data:; media-src https: http: data:; script-src 'none'; frame-src 'none'; form-action 'none'; base-uri https: http:";
const CSP_LOCAL = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'";

const extOf = (name) => String(name || "").split(/[?#]/)[0].split("/").pop().split(".").slice(1).pop()?.toLowerCase() || "";

/** 文件种类：决定预览侧栏怎么画。 */
function kindOf(name, mime = "") {
  const m = String(mime || "").toLowerCase().split(";")[0].trim();
  const ext = extOf(name);
  if (m.startsWith("image/") || /^(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/.test(ext)) return "image";
  if (m.startsWith("video/") || /^(mp4|m4v|webm|mov|ogv)$/.test(ext)) return "video";
  if (m.startsWith("audio/") || /^(mp3|wav|m4a|ogg|flac|aac)$/.test(ext)) return "audio";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m === "text/markdown" || ext === "md" || ext === "markdown") return "markdown";
  if (m === "text/csv" || m === "text/tab-separated-values" || ext === "csv" || ext === "tsv") return "csv";
  if (m === "text/html" || m === "application/xhtml+xml" || ext === "html" || ext === "htm") return "html";
  if (m === "application/json" || ext === "json") return "code";
  if (CODE_EXT.has(ext)) return "code";
  if (m.startsWith("text/") || /^(txt|log)$/.test(ext) || /(xml|javascript|yaml|toml)/.test(m)) return "text";
  return "file";
}
const isTextKind = (k) => k === "markdown" || k === "csv" || k === "code" || k === "text" || k === "html";
const mimeOf = (name, fallback = "application/octet-stream") => EXT_MIME[extOf(name)] || fallback;

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

/** 文件名里去掉路径与控制字符，保留中文；空了就叫「附件」。 */
function safeName(name) {
  const base = String(name || "").split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, "").replace(/^\.+/, "").trim()
    // 文件名里的空白和括号会打断 Markdown 链接（AI 回答里要用相对路径引用附件），统一换成 _
    .replace(/[\s()\[\]]+/g, "_").slice(0, 120);
  return base || "附件";
}

function injectBase(html, baseUrl) {
  const tag = '<base href="' + String(baseUrl).replace(/"/g, "&quot;") + '"><meta name="referrer" content="no-referrer">';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  return tag + html;
}

function createChatPreview({ getWorkspaceDir = null, getWebAccess = null, clock = null, logger = null } = {}) {
  const now = typeof clock === "function" ? clock : () => Date.now();
  const token = crypto.randomBytes(18).toString("base64url");
  const remote = new Map(); // id → { buffer, mime, html, finalUrl, at }
  const htmlDocs = new Map(); // id → html
  let cacheBytes = 0;
  const log = (event, extra) => { try { logger && logger.log && logger.log({ scope: "chat-preview", event, ...(extra || {}) }); } catch { /* ignore */ } };
  const wsDir = () => {
    const d = typeof getWorkspaceDir === "function" ? getWorkspaceDir() : null;
    if (!d) return null;
    try { fs.mkdirSync(d, { recursive: true }); } catch { return null; }
    return d;
  };
  const url = (area, rest) => SCHEME + "://" + area + "/" + token + "/" + rest;

  function remember(entry) {
    const id = crypto.randomBytes(9).toString("base64url");
    remote.set(id, entry);
    cacheBytes += entry.buffer.length;
    while (cacheBytes > MAX_CACHE_BYTES && remote.size > 1) {
      const [oldId, old] = remote.entries().next().value;
      remote.delete(oldId); cacheBytes -= old.buffer.length;
    }
    return id;
  }

  /** 预览一个 http(s) 地址：取回、判断种类、返回协议地址（文本类顺带正文）。 */
  async function openRemote({ url: target } = {}) {
    const web = typeof getWebAccess === "function" ? getWebAccess() : null;
    if (!web || typeof web.fetchRaw !== "function") return { ok: false, error: "PREVIEW_UNAVAILABLE" };
    const got = await web.fetchRaw({ url: target, maxBytes: MAX_REMOTE_BYTES });
    if (!got.ok) return { ok: false, error: got.error, detail: got.detail || null };
    const mime = String(got.contentType || "").split(";")[0].trim() || mimeOf(got.finalUrl);
    let kind = kindOf(got.finalUrl, mime);
    if (kind === "file" && !looksBinary(got.buffer)) kind = "text";
    const name = decodeURIComponent((new URL(got.finalUrl).pathname.split("/").pop() || new URL(got.finalUrl).hostname)).slice(0, 120);
    const out = { ok: true, kind, mime, name, finalUrl: got.finalUrl, size: got.buffer.length, truncated: !!got.truncated };
    if (kind === "html") {
      const text = decodeBody(got.buffer, got.contentType);
      out.kind = "web";
      out.title = htmlTitle(text) || name;
      out.text = htmlToText(text).slice(0, 60000);
      const id = remember({ buffer: Buffer.from(injectBase(text, got.finalUrl), "utf8"), mime: "text/html; charset=utf-8", csp: CSP_REMOTE, at: now() });
      out.previewUrl = url("r", id);
      return out;
    }
    if (isTextKind(kind)) out.text = decodeBody(got.buffer, got.contentType).slice(0, MAX_TEXT_CHARS);
    out.previewUrl = url("r", remember({ buffer: got.buffer, mime: mime || "application/octet-stream", csp: null, at: now() }));
    return out;
  }

  /**
   * 网站图标（联网结果里的来源列表用）：经同一套出网检查取回，只认常见位图，转成 data: 地址给界面。
   * 先取 /favicon.ico，不行再看首页里的 <link rel="icon">。按域名缓存（失败也缓存，避免反复请求）。
   */
  const icons = new Map(); // host → Promise<string>
  function iconMime(buf) {
    if (!buf || buf.length < 8) return "";
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf[0] === 0x00 && buf[1] === 0x00 && (buf[2] === 0x01 || buf[2] === 0x02) && buf[3] === 0x00) return "image/x-icon";
    if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
    if (buf.slice(0, 3).toString("latin1") === "GIF") return "image/gif";
    if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
    return "";
  }
  async function favicon({ host } = {}) {
    const h = String(host || "").trim().toLowerCase();
    if (!/^[a-z0-9.-]{1,253}$/.test(h) || !h.includes(".")) return { ok: false, error: "INVALID_HOST" };
    const web = typeof getWebAccess === "function" ? getWebAccess() : null;
    if (!web || typeof web.fetchRaw !== "function") return { ok: false, error: "PREVIEW_UNAVAILABLE" };
    if (!icons.has(h)) {
      if (icons.size > 400) icons.delete(icons.keys().next().value);
      icons.set(h, (async () => {
        const grab = async (u) => {
          const got = await web.fetchRaw({ url: u, maxBytes: 128 * 1024, timeout: 6000 });
          if (!got.ok || got.truncated) return "";
          const mime = iconMime(got.buffer);
          return mime ? "data:" + mime + ";base64," + got.buffer.toString("base64") : "";
        };
        let data = await grab("https://" + h + "/favicon.ico").catch(() => "");
        if (data) return data;
        const page = await web.fetchRaw({ url: "https://" + h + "/", maxBytes: 256 * 1024, timeout: 6000 }).catch(() => null);
        if (!page || !page.ok) return "";
        const html = page.buffer.toString("latin1");
        const m = /<link\b[^>]*rel=["'][^"']*\bicon\b[^"']*["'][^>]*>/i.exec(html);
        const href = m && /href=["']([^"']+)["']/i.exec(m[0]);
        if (!href) return "";
        let abs = "";
        try { abs = new URL(href[1].replace(/&amp;/g, "&"), page.finalUrl).href; } catch { return ""; }
        if (!/^https?:/i.test(abs)) return "";
        data = await grab(abs).catch(() => "");
        return data;
      })());
    }
    const data = await icons.get(h);
    return data ? { ok: true, dataUrl: data } : { ok: false, error: "NO_ICON" };
  }

  /**
   * 网页卡片预览（联网来源的缩略图 / 网站名）：取网页头部，找 og:image / twitter:image 和 og:site_name，
   * 再取那张图，缩成小图转成 data: 地址。全部经同一套出网检查；按地址缓存（失败也缓存）。
   */
  const cards = new Map(); // url → Promise<result>
  function metaOf(html, name) {
    const re = new RegExp("<meta\\b[^>]*(?:property|name)=[\"']" + name.replace(/[:.]/g, "\\$&") + "[\"'][^>]*>", "i");
    const tag = re.exec(html);
    if (!tag) return "";
    const c = /content=["']([^"']*)["']/i.exec(tag[0]);
    return c ? decodeEntitiesLite(c[1]).trim() : "";
  }
  function decodeEntitiesLite(v) { return String(v || "").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
  function shrink(buffer) {
    try {
      const { nativeImage } = require("electron");
      if (!nativeImage) return null;
      const img = nativeImage.createFromBuffer(buffer);
      if (img.isEmpty()) return null;
      const { width } = img.getSize();
      const small = width > 480 ? img.resize({ width: 480, quality: "good" }) : img;
      return "data:image/jpeg;base64," + small.toJPEG(78).toString("base64");
    } catch { return null; }
  }
  async function linkPreview({ url: target } = {}) {
    let u;
    try { u = new URL(String(target || "")); } catch { return { ok: false, error: "INVALID_URL" }; }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return { ok: false, error: "INVALID_URL" };
    const web = typeof getWebAccess === "function" ? getWebAccess() : null;
    if (!web || typeof web.fetchRaw !== "function") return { ok: false, error: "PREVIEW_UNAVAILABLE" };
    const key = u.href;
    if (!cards.has(key)) {
      if (cards.size > 300) cards.delete(cards.keys().next().value);
      cards.set(key, (async () => {
        const page = await web.fetchRaw({ url: key, maxBytes: 512 * 1024, timeout: 8000 }).catch(() => null);
        if (!page || !page.ok) return { ok: false, error: (page && page.error) || "FETCH_FAILED" };
        const html = decodeBody(page.buffer, page.contentType);
        if (!/<html|<head|<meta/i.test(html.slice(0, 4096))) return { ok: false, error: "NOT_HTML" };
        const title = (metaOf(html, "og:title") || htmlTitle(html) || "").slice(0, 200);
        const siteName = metaOf(html, "og:site_name").slice(0, 80);
        const description = (metaOf(html, "og:description") || metaOf(html, "description")).slice(0, 300);
        let imageUrl = metaOf(html, "og:image") || metaOf(html, "og:image:url") || metaOf(html, "twitter:image") || metaOf(html, "twitter:image:src");
        let image = null;
        if (imageUrl) {
          try { imageUrl = new URL(imageUrl, page.finalUrl).href; } catch { imageUrl = ""; }
          if (/^https?:/i.test(imageUrl)) {
            const got = await web.fetchRaw({ url: imageUrl, maxBytes: 3 * 1024 * 1024, timeout: 8000 }).catch(() => null);
            if (got && got.ok && !got.truncated) {
              const mime = iconMime(got.buffer);
              if (mime) image = shrink(got.buffer) || (got.buffer.length <= 400 * 1024 ? "data:" + mime + ";base64," + got.buffer.toString("base64") : null);
            }
          }
        }
        return { ok: true, url: key, finalUrl: page.finalUrl, title, siteName, description, image };
      })());
    }
    return await cards.get(key);
  }

  /** 预览工作文件夹里的文件（附件 / AI 写出的文件）。 */
  function openWorkspace({ path: rel } = {}) {
    const dir = wsDir();
    if (!dir) return { ok: false, error: "WORKSPACE_UNAVAILABLE" };
    let resolved;
    try { resolved = resolveInside(dir, rel); } catch (e) { return { ok: false, error: e.code || "WORKSPACE_PATH_INVALID" }; }
    let stat;
    try { stat = fs.statSync(resolved.abs); } catch { return { ok: false, error: "WORKSPACE_NOT_FOUND" }; }
    if (!stat.isFile()) return { ok: false, error: "WORKSPACE_NOT_FOUND" };
    const name = path.basename(resolved.abs);
    const mime = mimeOf(name);
    let kind = kindOf(name, mime);
    const out = { ok: true, kind, mime, name, path: resolved.rel, size: stat.size };
    if (kind === "file" || isTextKind(kind)) {
      const fd = fs.openSync(resolved.abs, "r");
      let buf;
      try { buf = Buffer.alloc(Math.min(stat.size, 4 * 1024 * 1024)); fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
      if (kind === "file" && !looksBinary(buf)) kind = out.kind = "text";
      if (isTextKind(kind)) { out.text = buf.toString("utf8").slice(0, MAX_TEXT_CHARS); out.truncated = stat.size > buf.length; }
    }
    out.previewUrl = url("w", resolved.rel.split("/").map(encodeURIComponent).join("/"));
    return out;
  }

  /** 代码块里的 HTML / SVG：放进内存，返回可在沙箱 iframe 里打开的地址。 */
  function putHtml({ html } = {}) {
    const text = String(html || "");
    if (!text.trim()) return { ok: false, error: "INVALID_INPUT" };
    if (text.length > 2 * 1024 * 1024) return { ok: false, error: "PREVIEW_TOO_LARGE" };
    const id = crypto.randomBytes(9).toString("base64url");
    htmlDocs.set(id, text);
    while (htmlDocs.size > MAX_HTML_DOCS) htmlDocs.delete(htmlDocs.keys().next().value);
    return { ok: true, previewUrl: url("h", id) };
  }

  /** 附件：写进工作文件夹 uploads/<日期>/，重名自动加序号。 */
  function upload({ name, data } = {}) {
    const dir = wsDir();
    if (!dir) return { ok: false, error: "WORKSPACE_UNAVAILABLE" };
    let buf;
    if (data instanceof Uint8Array) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
    else return { ok: false, error: "INVALID_INPUT" };
    if (buf.length > MAX_UPLOAD_BYTES) return { ok: false, error: "UPLOAD_TOO_LARGE" };
    const d = new Date(now());
    const day = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    const folder = path.join(dir, "uploads", day);
    fs.mkdirSync(folder, { recursive: true });
    const clean = safeName(name);
    const dot = clean.lastIndexOf(".");
    const stem = dot > 0 ? clean.slice(0, dot) : clean;
    const ext = dot > 0 ? clean.slice(dot) : "";
    let finalName = clean;
    for (let i = 2; fs.existsSync(path.join(folder, finalName)) && i < 1000; i += 1) finalName = stem + "-" + i + ext;
    const abs = path.join(folder, finalName);
    // 写之前再确认一遍还在工作文件夹里（防符号链接跳出）。
    try { resolveInside(dir, path.relative(dir, abs).split(path.sep).join("/"), { forWrite: true }); } catch (e) { return { ok: false, error: e.code || "WORKSPACE_PATH_INVALID" }; }
    fs.writeFileSync(abs, buf, { flag: "wx" });
    const rel = ["uploads", day, finalName].join("/");
    const mime = mimeOf(finalName);
    log("upload", { bytes: buf.length });
    return { ok: true, file: { path: rel, name: finalName, size: buf.length, mime, kind: kindOf(finalName, mime) } };
  }

  /** @ 补全用：列出工作文件夹里的文件（最近修改的在前）。 */
  function listFiles({ query = "", limit = 60 } = {}) {
    const dir = wsDir();
    if (!dir) return { ok: false, error: "WORKSPACE_UNAVAILABLE" };
    const q = String(query || "").trim().toLowerCase();
    const out = [];
    let seen = 0;
    const walk = (folder, relFolder, depth) => {
      if (depth > 5 || seen > 4000) return;
      let items = [];
      try { items = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
      for (const ent of items) {
        seen += 1;
        if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
        const rel = relFolder ? relFolder + "/" + ent.name : ent.name;
        const full = path.join(folder, ent.name);
        if (ent.isDirectory()) walk(full, rel, depth + 1);
        else if (ent.isFile() && (!q || rel.toLowerCase().includes(q))) {
          let st = null; try { st = fs.statSync(full); } catch { /* ignore */ }
          out.push({ path: rel, name: ent.name, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0, kind: kindOf(ent.name) });
        }
      }
    };
    walk(dir, "", 1);
    out.sort((a, b) => b.mtime - a.mtime);
    return { ok: true, items: out.slice(0, Math.max(1, Math.min(200, Number(limit) || 60))) };
  }

  function absOf(rel) {
    const dir = wsDir();
    if (!dir) return null;
    try { const r = resolveInside(dir, rel); return fs.existsSync(r.abs) ? r.abs : null; } catch { return null; }
  }

  /** openarc-preview:// 请求处理（protocol.handle）。 */
  async function handle(request) {
    let u;
    try { u = new URL(request.url); } catch { return new Response("bad request", { status: 400 }); }
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] !== token) return new Response("not found", { status: 404 });
    const headers = { "x-content-type-options": "nosniff", "cache-control": "no-store", "referrer-policy": "no-referrer" };
    if (u.hostname === "r") {
      const hit = remote.get(parts[1] || "");
      if (!hit) return new Response("expired", { status: 404 });
      if (hit.csp) headers["content-security-policy"] = hit.csp;
      else if (/^text\/html|svg/.test(hit.mime)) headers["content-security-policy"] = CSP_LOCAL;
      headers["content-type"] = hit.mime;
      return new Response(hit.buffer, { status: 200, headers });
    }
    if (u.hostname === "h") {
      const html = htmlDocs.get(parts[1] || "");
      if (html == null) return new Response("expired", { status: 404 });
      headers["content-type"] = "text/html; charset=utf-8";
      headers["content-security-policy"] = CSP_LOCAL;
      return new Response(html, { status: 200, headers });
    }
    if (u.hostname === "w") {
      const rel = parts.slice(1).map((p) => { try { return decodeURIComponent(p); } catch { return p; } }).join("/");
      const abs = absOf(rel);
      if (!abs) return new Response("not found", { status: 404 });
      const mime = mimeOf(abs);
      headers["content-type"] = /^text\/|json|xml/.test(mime) ? mime + "; charset=utf-8" : mime;
      if (/html|svg/.test(mime)) headers["content-security-policy"] = CSP_LOCAL;
      const size = fs.statSync(abs).size;
      // 视频拖动进度需要 Range。
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
      if (range && size > 0) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0));
        const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
        if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": "bytes */" + size } });
        const len = end - start + 1;
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(abs, "r");
        try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
        return new Response(buf, { status: 206, headers: { ...headers, "accept-ranges": "bytes", "content-range": "bytes " + start + "-" + end + "/" + size, "content-length": String(len) } });
      }
      return new Response(fs.readFileSync(abs), { status: 200, headers: { ...headers, "accept-ranges": "bytes" } });
    }
    return new Response("not found", { status: 404 });
  }

  return { token, scheme: SCHEME, openRemote, favicon, linkPreview, openWorkspace, putHtml, upload, listFiles, absOf, handle };
}

/** 对话预览 / 附件 IPC（只给可信窗口）。 */
/**
 * 语音输入：录音交给「系统设置 › 模型与服务商」里的语音转写模型（音频能力 + 名字像转写模型，
 * 如 whisper-1 / gpt-4o-transcribe / SenseVoice），经 provider-protocol 的 legacy 出口调 /audio/transcriptions。
 * 没配转写模型时如实返回 VOICE_NO_MODEL，界面据此提示，不假装能用。
 */
const MAX_VOICE_BYTES = 25 * 1024 * 1024;
const STT_NAME = /whisper|transcri|speech-to-text|stt|asr|sensevoice|paraformer/i;
function createVoiceTranscriber({ getStore, getService }) {
  const pick = () => {
    let list = [];
    try { const store = typeof getStore === "function" ? getStore() : null; list = (store && typeof store.listPublic === "function" && store.listPublic()) || []; } catch { list = []; }
    for (const p of list) {
      if (!p || p.enabled === false || !p.base_url) continue;
      const m = (Array.isArray(p.models) ? p.models : []).find((e) => e && (e.caps || []).includes("audio") && STT_NAME.test(String(e.model || "") + " " + String(e.name || "")));
      if (m) return { providerId: String(p.id), providerName: String(p.name || p.id), model: String(m.model) };
    }
    return null;
  };
  return {
    status() {
      const t = pick();
      return t ? { ok: true, available: true, model: t.model, provider: t.providerName } : { ok: true, available: false, reason: "VOICE_NO_MODEL" };
    },
    async transcribe({ data, mime }) {
      const t = pick();
      const service = typeof getService === "function" ? getService() : null;
      if (!t || !service || typeof service.legacyExecute !== "function") return { ok: false, error: "VOICE_NO_MODEL" };
      const bytes = data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
      if (!bytes || !bytes.length) return { ok: false, error: "VOICE_EMPTY" };
      if (bytes.length > MAX_VOICE_BYTES) return { ok: false, error: "VOICE_TOO_LONG" };
      const type = String(mime || "").split(";")[0].trim().toLowerCase();
      const clean = /^audio\/[a-z0-9.+-]+$/.test(type) ? type : "audio/webm";
      const ext = clean === "audio/ogg" ? "ogg" : clean === "audio/mp4" ? "m4a" : clean === "audio/wav" ? "wav" : clean === "audio/mpeg" ? "mp3" : "webm";
      try {
        const r = await service.legacyExecute({ providerId: t.providerId, action: "audio", model: t.model, intent: "transcribe", input: { buf: bytes, mime: clean, name: "voice." + ext }, params: { response_format: "json" }, timeoutMs: 120000 });
        if (!r || r.ok !== true) return { ok: false, error: "VOICE_FAILED", detail: String((r && (r.detail || r.error)) || "").slice(0, 160) || null };
        return { ok: true, text: String(r.text || "").trim() };
      } catch (err) {
        return { ok: false, error: "VOICE_FAILED", detail: String((err && err.message) || "").slice(0, 160) || null };
      }
    },
  };
}

function registerChatIpc({ ipcMain, preview, isTrusted, shell = null, prefs = null, getUserId = null, voice = null }) {
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("chat:command"); } catch { /* not registered */ } }
  ipcMain.handle("chat:command", async (e, raw) => {
    if (isTrusted && !isTrusted(e)) throw Error("Forbidden");
    const cmd = raw && typeof raw === "object" ? raw : {};
    const name = String(cmd.command || "");
    // 对话列表整理（重命名 / 置顶 / 从列表删除）：身份由主进程给，渲染层自报的 userId 不认。
    if (name === "prefs/get" || name === "prefs/update") {
      const userId = typeof getUserId === "function" ? getUserId() : null;
      if (!prefs) return { ok: false, error: "PREFS_UNAVAILABLE" };
      return name === "prefs/get" ? prefs.get({ userId }) : prefs.update({ userId, taskId: cmd.taskId, action: cmd.action, title: cmd.title });
    }
    if (name === "voice/status") return voice ? voice.status() : { ok: true, available: false, reason: "VOICE_NO_MODEL" };
    if (name === "voice/transcribe") return voice ? voice.transcribe({ data: cmd.data, mime: cmd.mime }) : { ok: false, error: "VOICE_NO_MODEL" };
    if (!preview) return { ok: false, error: "PREVIEW_UNAVAILABLE" };
    try {
      switch (name) {
        case "preview/remote": return await preview.openRemote({ url: String(cmd.url || "") });
        case "link/preview": return typeof preview.linkPreview === "function" ? await preview.linkPreview({ url: String(cmd.url || "") }) : { ok: false, error: "PREVIEW_UNAVAILABLE" };
        case "favicon/get": return typeof preview.favicon === "function" ? await preview.favicon({ host: String(cmd.host || "") }) : { ok: false, error: "NO_ICON" };
        case "preview/workspace": return preview.openWorkspace({ path: String(cmd.path || "") });
        case "preview/html": return preview.putHtml({ html: String(cmd.html || "") });
        case "upload/add": return preview.upload({ name: String(cmd.name || ""), data: cmd.data });
        case "workspace/files": return preview.listFiles({ query: String(cmd.query || ""), limit: cmd.limit });
        case "workspace/open": {
          // 用户点「用系统打开」：只认工作文件夹里的文件。
          const abs = preview.absOf(String(cmd.path || ""));
          if (!abs || !shell || typeof shell.openPath !== "function") return { ok: false, error: "WORKSPACE_NOT_FOUND" };
          const err = await shell.openPath(abs);
          return err ? { ok: false, error: "OPEN_FAILED", detail: String(err).slice(0, 160) } : { ok: true };
        }
        default: return { ok: false, error: "CHAT_COMMAND_NOT_ALLOWED" };
      }
    } catch (err) {
      return { ok: false, error: "INTERNAL_ERROR", detail: String((err && err.code) || "").slice(0, 80) || null };
    }
  });
}

module.exports = { createChatPreview, createVoiceTranscriber, registerChatIpc, kindOf, safeName, PREVIEW_SCHEME: SCHEME, CSP_REMOTE, CSP_LOCAL };
