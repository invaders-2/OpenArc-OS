import MarkdownIt from "markdown-it";
// @ts-expect-error 没有类型声明（CommonJS 插件）
import texmath from "markdown-it-texmath";
import katex from "katex";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";

/**
 * 对话消息的 Markdown 渲染：GFM（表格、删除线、任务列表、自动链接）、代码高亮、KaTeX 公式。
 *
 * 安全：
 *   · 模型输出里的原始 HTML 一律当文本（html: false），最后再过一遍 DOMPurify。
 *   · 外部图片不自动加载（防止借图片地址把对话内容带出去），只显示「外部图片」占位，点了才去取。
 *   · 链接、代码块、图片上的动作用 data-md-act 标记，由宿主组件统一接管点击。
 */
const LOCAL_IMG = /^(data:image\/|blob:|openarc-resource:|openarc-file:|openarc-canvas:)/i;

const md: MarkdownIt = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
md.use(texmath, { engine: katex, delimiters: ["dollars", "brackets"], katexOptions: { throwOnError: false, output: "html" } });

const esc = (s: string) => md.utils.escapeHtml(s);

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const lang = String(token.info || "").trim().split(/\s+/)[0].toLowerCase();
  const code = token.content.replace(/\n$/, "");
  let body = "";
  if (lang && hljs.getLanguage(lang)) {
    try { body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { body = esc(code); }
  } else body = esc(code);
  const previewable = /^(html|htm|svg|markdown|md|csv|json)$/.test(lang) || code.split("\n").length > 12;
  return (
    '<div class="md-code" data-md-lang="' + esc(lang || "text") + '">' +
    '<div class="md-code-head"><span class="md-code-lang">' + esc(lang || "text") + "</span>" +
    (previewable ? '<button type="button" class="md-code-btn" data-md-act="code-preview">预览</button>' : "") +
    '<button type="button" class="md-code-btn" data-md-act="code-copy">复制</button></div>' +
    '<pre><code class="hljs">' + body + "</code></pre></div>"
  );
};

md.renderer.rules.table_open = () => '<div class="md-table"><table>';
md.renderer.rules.table_close = () => "</table></div>";

md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  const src = String(token.attrGet("src") || "");
  const alt = token.children ? token.children.map((c) => c.content).join("") : token.content;
  if (LOCAL_IMG.test(src)) return '<img class="md-img" src="' + esc(src) + '" alt="' + esc(alt) + '" data-md-act="image" data-md-src="' + esc(src) + '" loading="lazy">';
  if (/^https?:\/\//i.test(src)) return '<button type="button" class="md-img-remote" data-md-act="image" data-md-src="' + esc(src) + '" title="' + esc(src) + '">外部图片' + (alt ? " · " + esc(alt) : "") + "（点击查看）</button>";
  return esc(alt);
};

const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = String(tokens[idx].attrGet("href") || "").trim();
  // 没有协议的相对路径 = AI 工作文件夹里的文件：显示成文件链接，点开在预览侧栏里看。
  if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("#") && !href.startsWith("//") && !href.startsWith("/")) {
    let rel = href;
    try { rel = decodeURIComponent(href); } catch { /* 保留原样 */ }
    tokens[idx].attrSet("href", "#");
    tokens[idx].attrSet("data-md-act", "ws");
    tokens[idx].attrSet("data-md-src", rel);
    tokens[idx].attrSet("class", "md-ws");
    return defaultLinkOpen(tokens, idx, options, env, self);
  }
  tokens[idx].attrSet("data-md-act", "link");
  tokens[idx].attrSet("rel", "noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/** 任务列表：行首的 [ ] / [x] 换成只读勾选标记。 */
function taskLists(html: string) {
  return html.replace(/<li>(\s*<p>)?\s*\[( |x|X)\]\s+/g, (_m, p, mark) =>
    '<li class="md-task">' + (p || "") + '<span class="md-check" data-done="' + (mark.trim() ? "1" : "0") + '" aria-hidden="true"></span>');
}

let purifyHooked = false;
function purify(html: string) {
  if (!purifyHooked) {
    // 只留 http(s) / mailto 链接；其余（javascript: 等）连同 href 一起去掉。
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        const href = node.getAttribute("href") || "";
        if (!/^(https?:|mailto:)/i.test(href)) node.removeAttribute("href");
      }
      if (node.tagName === "IMG") {
        const src = node.getAttribute("src") || "";
        if (!LOCAL_IMG.test(src)) node.removeAttribute("src");
      }
    });
    purifyHooked = true;
  }
  return DOMPurify.sanitize(html, { ADD_ATTR: ["data-md-act", "data-md-src", "data-md-lang", "data-done", "aria-hidden"], FORBID_TAGS: ["style", "form", "input", "iframe", "script"] });
}

const cache = new Map<string, string>();
/** 渲染 Markdown（带一个小缓存：流式输出时前面已完成的消息不重复解析）。 */
export function renderMarkdown(src: string): string {
  const text = String(src || "");
  const hit = cache.get(text);
  if (hit != null) return hit;
  let out = "";
  try { out = purify(taskLists(md.render(text))); } catch { out = "<p>" + esc(text) + "</p>"; }
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  cache.set(text, out);
  return out;
}

/** 代码高亮（预览侧栏的代码视图也用这一套）。 */
export function highlightCode(code: string, lang = ""): string {
  const l = String(lang || "").toLowerCase();
  try {
    if (l && hljs.getLanguage(l)) return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
    return hljs.highlightAuto(code).value;
  } catch { return esc(code); }
}

/** 按文件名 / 地址猜语言（代码预览用）。 */
export function langOf(name: string): string {
  const ext = String(name || "").split("?")[0].split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", vue: "xml",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp",
    cs: "csharp", php: "php", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", sql: "sql", html: "xml", htm: "xml", xml: "xml",
    svg: "xml", css: "css", scss: "scss", less: "less", json: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", md: "markdown",
    lua: "lua", r: "r", dart: "dart", scala: "scala", diff: "diff", patch: "diff", dockerfile: "dockerfile",
  };
  return map[ext] || "";
}
