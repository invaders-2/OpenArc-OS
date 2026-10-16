/**
 * B7b · 开发者实验室（源 server/developerLab.ts:1-258 + developerLabExamples.ts:1-36
 *        + developerDocs.ts:1-186 + developerIcon.ts:1-56）。
 *
 * 本文件承担四件事，全部离线、无云：
 *   1. 图标资源投影（developerIcon.ts 逐函数移植）：只产出内联 SVG / gradient / PNG data URL，
 *      不新增任何资产文件；normalizeDeveloperIcon 的 fallback SVG 仍与源一字不差。
 *   2. 文档资源投影（developerDocs.ts）：保留清单校验（dx-developer-docs-manifest/v1、
 *      slug / sha256 / byteSize）与本地缓存读取；**移除远端刷新**（源 :9 的 api.dx-os.com 属 OUT），
 *      refreshDeveloperDocs 一律结构化回 DEVELOPER_DOCS_REMOTE_DISABLED，绝不发请求。
 *   3. 示例工程：gomokuDeveloperLabFiles() 由源 developerLabExamples.ts 的四个文件逐字生成
 *      （生成时用脚本从源抽取模板字符串，见 GOMOKU_FILES 的占位替换）。
 *   4. 草稿 CRUD（developerLab.ts 的 create/get/list/setOwner/delete/read/write/setIcon/zip/preview）。
 *
 * OUT（一律不引入）：api.dx-os.com、云端市场 / 发布 / 审核 / 灰度、appUpdates 远端更新、
 * 开发者 OAuth(PKCE)、云端实时房间 —— 本文件零引用；preview 只回原始字节 + MIME，
 * 不注入 developerRuntime 的 system bridge（该桥属 B7a 运行时，不在 B7b 范围）。
 */
"use strict";

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeZip } = require("./canvas-dxos-zip.cjs");

/** 命令面并入唯一 developer:command（不新建域）；下行事件沿用 developer:event。 */
const CHANNEL = "developer:command";
const EVENT_CHANNEL = "developer:event";

// 源 developerLab.ts:11-15 的三个上限与扩展名白名单。
const MAX_FILES = 80;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".html", ".css", ".js", ".mjs", ".json", ".txt", ".md", ".svg"]);
const LAB_DIR_NAME = "developer-lab";

// 源 shared/appLifecycle.ts:28-32 的 SemVer 判定（本仓无共享实现，按源正则内联）。
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function isValidSemver(value) {
  return typeof value === "string" && SEMVER_RE.test(value.trim());
}

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });
const asStr = (value, max = 200) => (typeof value === "string" ? value.slice(0, max) : value == null ? null : String(value).slice(0, max));

// ===========================================================================
// 一 · 图标投影（源 developerIcon.ts:1-56）
// ===========================================================================

// 源 :11 的 fallback SVG 与调色板，逐字保留（图标不得新增资产，只能按源投影）。
const DEVELOPER_ICON_FALLBACK_SVG =
  '<svg viewBox="0 0 64 64"><path d="M18 14h28a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4Zm6 16h16v-6H24v6Zm0 12h10v-6H24v6Z"/></svg>';
const DEVELOPER_ICON_PALETTES = Object.freeze([
  ["#0a84ff", "#5856d6"], ["#ff375f", "#ff9f0a"], ["#30d158", "#00a7a0"],
  ["#bf5af2", "#5e5ce6"], ["#ff9f0a", "#ff453a"], ["#64d2ff", "#0a84ff"],
]);

// 源 :14 escapeXml
function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char] || char));
}

// 源 :15-19 safeGradient
function safeGradient(value) {
  const gradient = String(value || "").trim();
  if (gradient === "transparent") return gradient;
  return /^(?:linear|radial)-gradient\([^;{}]{8,150}\)$/i.test(gradient) ? gradient : "linear-gradient(145deg,#0a84ff,#5856d6)";
}

// 源 :20-25 sanitizeDeveloperSvg
function sanitizeDeveloperSvg(value) {
  const svg = String(value || "").trim().slice(0, 16_000);
  if (!/^<svg\b/i.test(svg) || !/<\/svg>$/i.test(svg)) throw new Error("SVG 图标必须包含完整的 <svg> 根元素");
  if (/<(?:script|foreignObject|iframe|object|embed|image)\b/i.test(svg) || /\son[a-z]+\s*=/i.test(svg) || /(?:href|src)\s*=\s*["'](?:https?:|data:|javascript:)/i.test(svg)) throw new Error("SVG 图标包含不安全内容");
  return svg;
}

// 源 :26-30 pngDataUrl
function pngDataUrl(buffer) {
  if (!buffer.length || buffer.length > 512 * 1024) throw new Error("PNG 图标不能超过 512 KB");
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("文件不是有效的 PNG 图标");
  return "data:image/png;base64," + buffer.toString("base64");
}

// 源 :31-49 normalizeDeveloperIcon
function normalizeDeveloperIcon(value, fallback = true) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback ? { gradient: "linear-gradient(145deg,#0a84ff,#5856d6)", svg: DEVELOPER_ICON_FALLBACK_SVG } : undefined;
  const icon = value;
  const gradient = safeGradient(icon.gradient);
  const presentation = {
    imageScale: Math.max(0.5, Math.min(1.8, Number(icon.imageScale) || 1)),
    imageOffsetX: Math.max(-50, Math.min(50, Number(icon.imageOffsetX) || 0)),
    imageOffsetY: Math.max(-50, Math.min(50, Number(icon.imageOffsetY) || 0)),
    imageBackground: icon.imageBackground === true,
  };
  const image = String(icon.image || "").trim();
  if (image) {
    if (!/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(image) || image.length > 720_000) throw new Error("PNG 图标数据无效或超过限制");
    pngDataUrl(Buffer.from(image.slice(image.indexOf(",") + 1), "base64"));
    return { gradient, image, ...presentation };
  }
  if (icon.svg) return { gradient, svg: sanitizeDeveloperSvg(icon.svg), ...presentation };
  return fallback ? { gradient, svg: DEVELOPER_ICON_FALLBACK_SVG } : undefined;
}

// 源 :50-56 autoDeveloperIcon
function autoDeveloperIcon(name, id) {
  let hash = 0;
  for (const char of String(id) + ":" + String(name)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const pair = DEVELOPER_ICON_PALETTES[hash % DEVELOPER_ICON_PALETTES.length];
  const glyph = escapeXml((String(name).trim().match(/[\p{L}\p{N}]/u) || ["A"])[0].toUpperCase());
  return {
    gradient: "linear-gradient(145deg," + pair[0] + "," + pair[1] + ")",
    svg: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M18 10h28a8 8 0 0 1 8 8v28a8 8 0 0 1-8 8H18a8 8 0 0 1-8-8V18a8 8 0 0 1 8-8Z" fill="none" stroke="currentColor" stroke-width="2" opacity=".28"/><text x="32" y="40" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="25" font-weight="750" fill="currentColor">' + glyph + "</text></svg>",
  };
}

// ===========================================================================
// 二 · 文档资源投影（源 developerDocs.ts，离线部分）
// ===========================================================================

const DEVELOPER_DOCS_MANIFEST_FORMAT = "dx-developer-docs-manifest/v1";
const DEVELOPER_DOCS_MAX_DOCUMENTS = 500;
const DEVELOPER_DOCS_MAX_MARKDOWN_BYTES = 512 * 1024;
const DEVELOPER_DOCS_SLUG_PATTERN = /^(?:app|canvas-plugin|shared)\/[a-z0-9][a-z0-9-]{1,79}$/;
const DEVELOPER_DOCS_SHA_PATTERN = /^[a-f0-9]{64}$/;
const DEVELOPER_DOCS_LOCALE_PATTERN = /^[a-z]{2}(?:-[A-Z]{2})?$/;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// 源 :77-101 validateManifest（远端 URL / etag 获取全部去掉，只保留结构校验）
function validateDeveloperDocumentManifest(input) {
  const value = input || {};
  if (value.format !== DEVELOPER_DOCS_MANIFEST_FORMAT || !Array.isArray(value.documents) ||
      value.documents.length > DEVELOPER_DOCS_MAX_DOCUMENTS || typeof value.etag !== "string" || !DEVELOPER_DOCS_SHA_PATTERN.test(value.etag)) {
    throw new Error("开发文档目录格式无效");
  }
  const seen = new Set();
  const documents = value.documents.map((entry) => {
    if (!entry || !DEVELOPER_DOCS_SLUG_PATTERN.test(entry.slug) || !DEVELOPER_DOCS_SHA_PATTERN.test(entry.sha256) ||
        !["app", "canvas_plugin", "shared"].includes(entry.category) ||
        !DEVELOPER_DOCS_LOCALE_PATTERN.test(entry.locale) || seen.has(entry.locale + ":" + entry.slug)) {
      throw new Error("开发文档目录包含无效条目");
    }
    seen.add(entry.locale + ":" + entry.slug);
    const byteSize = Number(entry.byteSize);
    if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > DEVELOPER_DOCS_MAX_MARKDOWN_BYTES) {
      throw new Error("开发文档正文大小无效");
    }
    return { ...entry, byteSize, protocolVersions: Array.isArray(entry.protocolVersions) ? entry.protocolVersions.map(String).slice(0, 30) : [] };
  });
  return {
    format: value.format, locale: String(value.locale || "zh-CN"), etag: value.etag,
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : null, documents,
  };
}

// 源 :69-75 documentPath（同样的越界拒绝）
function developerDocumentPath(dir, slug, locale) {
  if (!DEVELOPER_DOCS_SLUG_PATTERN.test(slug) || !DEVELOPER_DOCS_LOCALE_PATTERN.test(locale)) throw new Error("开发文档路径无效");
  const target = path.resolve(dir, locale, slug + ".md");
  const localeRoot = path.resolve(dir, locale);
  if (!target.startsWith(localeRoot + path.sep)) throw new Error("开发文档缓存路径越界");
  return target;
}

function readJson(file, fsImpl) {
  try { return JSON.parse(fsImpl.readFileSync(file, "utf8")); } catch { return null; }
}

// 源 :103-108 validCachedDocument
function validCachedDeveloperDocument(dir, entry, fsImpl) {
  try {
    const bytes = fsImpl.readFileSync(developerDocumentPath(dir, entry.slug, entry.locale));
    return bytes.byteLength === entry.byteSize && sha256(bytes) === entry.sha256;
  } catch { return false; }
}

// 源 :128-136 cachedDeveloperDocs（无远端；返回 manifest 或 null）
function cachedDeveloperDocs({ dir, locale = "zh-CN", fsImpl = nodeFs } = {}) {
  const manifest = readJson(path.join(dir, "manifest.json"), fsImpl);
  if (!manifest || manifest.locale !== locale) return null;
  try {
    const valid = validateDeveloperDocumentManifest(manifest);
    if (!valid.documents.every((entry) => validCachedDeveloperDocument(dir, entry, fsImpl))) return null;
    return valid;
  } catch { return null; }
}

/** 源 :9 的远端刷新属 OUT（api.dx-os.com）。这里永远结构化拒绝，绝不发请求。 */
function refreshDeveloperDocs() {
  return fail("DEVELOPER_DOCS_REMOTE_DISABLED", "network-out");
}

// 源 :169-179 developerDocument（只读本地缓存）
function developerDocument({ dir, slug, locale = "zh-CN", fsImpl = nodeFs } = {}) {
  const manifest = cachedDeveloperDocs({ dir, locale, fsImpl });
  if (!manifest) throw new Error("尚无可用的离线开发文档");
  const entry = manifest.documents.find((item) => item.slug === slug && item.locale === locale);
  if (!entry) throw new Error("开发文档不存在");
  const markdown = fsImpl.readFileSync(developerDocumentPath(dir, entry.slug, entry.locale), "utf8");
  return { source: "cache", updated: false, warning: "", document: { ...entry, markdown } };
}

// 源 :181-186 developerDocsCacheStatus
function developerDocsCacheStatus({ dir, locale = "zh-CN", fsImpl = nodeFs } = {}) {
  const manifest = cachedDeveloperDocs({ dir, locale, fsImpl });
  const metadata = readJson(path.join(dir, "metadata.json"), fsImpl);
  return {
    available: Boolean(manifest), manifest,
    refreshedAt: metadata && metadata.refreshedAt ? metadata.refreshedAt : null,
    cacheDirectory: dir,
  };
}

// ===========================================================================
// 三 · 示例工程（源 developerLabExamples.ts:1-36，逐字）
// ===========================================================================

/**
 * 源 gomokuDeveloperLabFiles 的四个文件。生成方式：从只读源 developerLabExamples.ts
 * 抽取三段模板字符串 + manifest，用 JSON.stringify 落成数据；此处只做只读投影，不再修改。
 */
const GOMOKU_FILES = [
  {
    "path": "dx-app.json",
    "content": "{\n  \"format\": \"dx-app/v2\",\n  \"id\": \"dx-gomoku\",\n  \"version\": \"1.0.0\",\n  \"build\": 10000,\n  \"releaseChannel\": \"dev\",\n  \"minSystemVersion\": \"0.1.0\",\n  \"dataVersion\": 1,\n  \"name\": \"五子棋\",\n  \"subtitle\": \"双人对弈\",\n  \"description\": \"适配 DX OS 主题与语言、支持保存对局的五子棋游戏。\",\n  \"entry\": \"index.html\",\n  \"category\": \"games\",\n  \"defaultSize\": {\n    \"width\": 760,\n    \"height\": 680\n  },\n  \"permissions\": [\n    \"app.dx-gomoku.project.read\",\n    \"app.dx-gomoku.project.write\"\n  ]\n}"
  },
  {
    "path": "index.html",
    "content": "<!doctype html>\n<html lang=\"zh-CN\">\n<head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>五子棋</title><link rel=\"stylesheet\" href=\"assets/app.css\"></head>\n<body><main class=\"game\"><header><div><span class=\"eyebrow\">DX GOMOKU</span><h1 data-i18n=\"title\">五子棋</h1><p data-i18n=\"subtitle\">双人对弈 · 五子连珠获胜</p></div><div id=\"turn\" class=\"turn\"></div></header><section class=\"stage\"><canvas id=\"board\" width=\"720\" height=\"720\" aria-label=\"五子棋棋盘\"></canvas></section><footer><div id=\"status\" class=\"status\"></div><div class=\"actions\"><button id=\"undo\" data-i18n=\"undo\">悔棋</button><button id=\"reset\" class=\"primary\" data-i18n=\"reset\">重新开始</button></div></footer></main><script src=\"assets/app.js\"></script></body>\n</html>"
  },
  {
    "path": "assets/app.css",
    "content": ":root{color-scheme:light;--bg:#f5f5f7;--panel:rgba(255,255,255,.82);--ink:#172033;--muted:#7a8494;--line:rgba(31,42,58,.12);--accent:#0a84ff;--board:#dcae66;--grid:#62441f}html[data-theme=\"dark\"]{color-scheme:dark;--bg:#15181d;--panel:rgba(35,39,47,.88);--ink:#eef2f8;--muted:#969fac;--line:rgba(255,255,255,.12);--board:#a87439;--grid:#3e2814}*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--ink);font-family:Inter,\"PingFang SC\",system-ui,sans-serif}body{padding:24px}.game{width:min(680px,100%);margin:auto;padding:22px;border:1px solid var(--line);border-radius:22px;background:var(--panel);box-shadow:0 26px 60px -42px rgba(12,24,40,.6);backdrop-filter:saturate(140%) blur(22px)}header,footer{display:flex;align-items:center;justify-content:space-between;gap:18px}.eyebrow{color:var(--accent);font-size:10px;font-weight:800;letter-spacing:1px}h1{margin:5px 0 2px;font-size:26px;letter-spacing:-.5px}p{margin:0;color:var(--muted);font-size:12px}.turn{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--line);border-radius:999px;font-size:12px;font-weight:700}.turn i{width:14px;height:14px;border-radius:50%;box-shadow:0 2px 5px rgba(0,0,0,.3)}.stage{margin:20px 0;padding:12px;border-radius:18px;background:var(--board);box-shadow:inset 0 1px 0 rgba(255,255,255,.26)}canvas{display:block;width:100%;height:auto;cursor:pointer;touch-action:manipulation}.status{color:var(--muted);font-size:11px}.actions{display:flex;gap:8px}button{min-height:34px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);font:inherit;font-size:11px;font-weight:650;cursor:pointer}button:hover{filter:brightness(1.05)}button.primary{border:0;background:var(--accent);color:white}@media(max-width:520px){body{padding:10px}.game{padding:14px;border-radius:16px}header{align-items:flex-start}.turn{padding:6px 8px}footer{align-items:flex-start;flex-direction:column}.actions{width:100%}.actions button{flex:1}}"
  },
  {
    "path": "assets/app.js",
    "content": "(function(){\nclass GomokuEngine{constructor(size=15){this.size=size;this.reset()}reset(){this.board=Array.from({length:this.size},()=>Array(this.size).fill(0));this.history=[];this.turn=1;this.winner=0}place(row,col){if(this.winner||row<0||col<0||row>=this.size||col>=this.size||this.board[row][col])return false;this.board[row][col]=this.turn;this.history.push([row,col,this.turn]);if(this.hasFive(row,col,this.turn))this.winner=this.turn;else this.turn=this.turn===1?2:1;return true}hasFive(row,col,color){return [[1,0],[0,1],[1,1],[1,-1]].some(([dr,dc])=>{let n=1;for(const sign of [-1,1]){let r=row+dr*sign,c=col+dc*sign;while(r>=0&&c>=0&&r<this.size&&c<this.size&&this.board[r][c]===color){n++;r+=dr*sign;c+=dc*sign}}return n>=5})}undo(){if(!this.history.length)return false;const [r,c,color]=this.history.pop();this.board[r][c]=0;this.turn=color;this.winner=0;return true}serialize(){return{size:this.size,board:this.board,history:this.history,turn:this.turn,winner:this.winner}}load(data){if(!data||data.size!==this.size||!Array.isArray(data.board))return false;this.board=data.board;this.history=Array.isArray(data.history)?data.history:[];this.turn=data.turn===2?2:1;this.winner=data.winner===1||data.winner===2?data.winner:0;return true}}\nwindow.GomokuEngine=GomokuEngine;\nconst canvas=document.getElementById('board'),ctx=canvas.getContext('2d'),turnEl=document.getElementById('turn'),statusEl=document.getElementById('status'),engine=new GomokuEngine(15);let locale='zh-CN',seq=0;const pending=new Map();\nconst words={'zh-CN':{title:'五子棋',subtitle:'双人对弈 · 五子连珠获胜',undo:'悔棋',reset:'重新开始',black:'黑方',white:'白方',turn:'落子',win:'获胜',moves:'手'},'en-US':{title:'Gomoku',subtitle:'Two players · Connect five to win',undo:'Undo',reset:'New Game',black:'Black',white:'White',turn:'to move',win:'wins',moves:'moves'}};\nfunction t(key){return words[locale.startsWith('zh')?'zh-CN':'en-US'][key]||key}function request(action,payload={}){return new Promise((resolve,reject)=>{const id='gomoku-'+(++seq);pending.set(id,{resolve,reject});parent.postMessage({dxos:'v1',type:'request',id,action,...payload},'*');setTimeout(()=>{if(pending.has(id)){pending.delete(id);reject(new Error('bridge timeout'))}},4000)})}\nfunction applyContext(c){if(!c)return;document.documentElement.dataset.theme=c.appearance||'light';document.documentElement.lang=c.interfaceLocale||c.locale||'zh-CN';document.documentElement.dir=c.direction||'ltr';locale=document.documentElement.lang;document.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=t(el.dataset.i18n));render()}\naddEventListener('message',e=>{const m=e.data;if(!m||m.dxos!=='v1')return;if(m.type==='system.context')applyContext(m.context);else if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.ok?p.resolve(m.result):p.reject(new Error(m.error||'bridge error'))}});\nfunction drawStone(x,y,color,last){const cell=canvas.width/(engine.size+1),g=ctx.createRadialGradient(x-cell*.16,y-cell*.2,cell*.08,x,y,cell*.43);if(color===1){g.addColorStop(0,'#666');g.addColorStop(.35,'#222');g.addColorStop(1,'#050505')}else{g.addColorStop(0,'#fff');g.addColorStop(.55,'#f3f3f3');g.addColorStop(1,'#b9b9b9')}ctx.beginPath();ctx.arc(x,y,cell*.39,0,Math.PI*2);ctx.fillStyle=g;ctx.shadowColor='rgba(0,0,0,.28)';ctx.shadowBlur=6;ctx.shadowOffsetY=2;ctx.fill();ctx.shadowColor='transparent';if(last){ctx.beginPath();ctx.arc(x,y,cell*.09,0,Math.PI*2);ctx.fillStyle=color===1?'#ff5a52':'#e33';ctx.fill()}}\nfunction render(){const size=canvas.width,cell=size/(engine.size+1);ctx.clearRect(0,0,size,size);ctx.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--grid').trim()||'#62441f';ctx.lineWidth=1.35;for(let i=1;i<=engine.size;i++){ctx.beginPath();ctx.moveTo(cell,i*cell);ctx.lineTo(engine.size*cell,i*cell);ctx.stroke();ctx.beginPath();ctx.moveTo(i*cell,cell);ctx.lineTo(i*cell,engine.size*cell);ctx.stroke()}for(const r of [4,8,12])for(const c of [4,8,12]){ctx.beginPath();ctx.arc(c*cell,r*cell,3.5,0,Math.PI*2);ctx.fillStyle=ctx.strokeStyle;ctx.fill()}const last=engine.history[engine.history.length-1];engine.board.forEach((row,r)=>row.forEach((v,c)=>{if(v)drawStone((c+1)*cell,(r+1)*cell,v,!!last&&last[0]===r&&last[1]===c)}));const side=engine.winner||engine.turn,name=side===1?t('black'):t('white');turnEl.innerHTML='<i style=\"background:'+(side===1?'#111':'#fff')+'\"></i>'+name+' · '+(engine.winner?t('win'):t('turn'));statusEl.textContent=engine.history.length+' '+t('moves')}\nasync function persist(){try{await request('project.write',{path:'games/current.json',content:JSON.stringify(engine.serialize())})}catch(e){console.warn('对局暂存失败',e.message)}}async function restore(){try{const r=await request('project.read',{path:'games/current.json'});if(r&&r.content)engine.load(JSON.parse(r.content))}catch(_){}render()}\ncanvas.addEventListener('click',e=>{const rect=canvas.getBoundingClientRect(),scale=canvas.width/rect.width,cell=canvas.width/(engine.size+1),col=Math.round((e.clientX-rect.left)*scale/cell)-1,row=Math.round((e.clientY-rect.top)*scale/cell)-1;if(engine.place(row,col)){render();void persist()}});document.getElementById('undo').onclick=()=>{if(engine.undo()){render();void persist()}};document.getElementById('reset').onclick=()=>{engine.reset();render();void persist()};\nrender();void restore();request('system.getContext').then(applyContext).catch(()=>{});\n})();"
  }
];

function gomokuDeveloperLabFiles() {
  return GOMOKU_FILES.map((file) => ({ path: file.path, content: file.content }));
}

const DEVELOPER_LAB_TEMPLATES = Object.freeze([
  Object.freeze({
    id: "dx-gomoku", name: "五子棋", subtitle: "双人对弈",
    description: "适配 DX OS 主题与语言、支持保存对局的五子棋游戏。",
    category: "games", entry: "index.html", build: "gomoku",
  }),
]);

function buildDeveloperLabTemplate(templateId) {
  if (String(templateId || "") !== "dx-gomoku") throw new Error("开发模板不存在");
  return gomokuDeveloperLabFiles();
}

function listDeveloperLabTemplates() {
  return DEVELOPER_LAB_TEMPLATES.map((template) => ({ ...template, fileCount: buildDeveloperLabTemplate(template.id).length }));
}

// ===========================================================================
// 四 · 草稿（源 developerLab.ts:34-250）
// ===========================================================================

// 源 :34-40 safePath
function safePath(value) {
  const rel = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = rel.split("/");
  if (!rel || rel.startsWith("/") || /^[a-z]:/i.test(rel) || parts.some((part) => !part || part === "." || part === "..")) throw new Error("不安全文件路径：" + value);
  if (!ALLOWED_EXTENSIONS.has(path.extname(rel).toLowerCase())) throw new Error("开发者实验室不支持该文件类型：" + rel);
  return rel;
}

// 源 :53-86 analyze（逐行对齐）
function analyzeDeveloperLabFiles(files, manifest) {
  const combined = files.map((file) => file.content).join("\n");
  const appId = String(manifest.id || "");
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [];
  const usesRealtime = combined.includes("realtime.room.");
  const usesCollab = combined.includes("collab.project.");
  const themeListener = combined.includes("system.context") && /dataset\.theme|setAttribute\(['"]data-theme|classList\.(?:add|toggle)\(['"]theme-dark/.test(combined);
  const themeStyles = /\[data-theme=["']?dark|\.theme-dark|prefers-color-scheme\s*:\s*dark/.test(combined);
  const localizedText = combined.includes("interfaceLocale") && combined.includes("zh-CN") && combined.includes("en-US");
  const unsafePathFound = /(?:[A-Za-z]:\\|file:\/\/|\.\.\/)/.test(combined);
  const hiddenProjectPath = /\b\w*(?:dir|path)\w*\s*=\s*["']\.[^./]/i.test(combined);
  const unsafeParentAccess = /window\.parent\.(?!postMessage\b)[A-Za-z_$]/.test(combined);
  const manifestProblems = [
    manifest.format !== "dx-app/v2" ? "format 必须是 dx-app/v2" : "",
    !isValidSemver(manifest.version) ? "version 必须是 SemVer，例如 1.0.0" : "",
    !Number.isSafeInteger(Number(manifest.build)) || Number(manifest.build) < 1 ? "build 必须是大于 0 的整数" : "",
    !isValidSemver(manifest.minSystemVersion) ? "minSystemVersion 必须是 SemVer" : "",
    String(manifest.name || "").trim().length < 2 ? "应用名称至少 2 个字符" : "",
    String(manifest.description || "").trim().length < 8 ? "description 至少 8 个字符" : "",
    usesRealtime && !permissions.includes("app." + appId + ".realtime.room") ? "使用 realtime.room.* 必须声明 app." + appId + ".realtime.room" : "",
    usesCollab && !permissions.includes("app." + appId + ".collab.project") ? "使用 collab.project.* 必须声明 app." + appId + ".collab.project" : "",
  ].filter(Boolean);
  return [
    { id: "manifest", label: "应用清单", status: manifestProblems.length ? "fail" : "pass", detail: manifestProblems.length ? manifestProblems.join("；") : "dx-app/v2 清单有效" },
    { id: "entry", label: "入口文件", status: files.some((file) => file.path === String(manifest.entry || "index.html")) ? "pass" : "fail", detail: "入口：" + String(manifest.entry || "index.html") },
    { id: "theme", label: "主题同步", status: themeListener && themeStyles ? "pass" : "warn", detail: themeListener && themeStyles ? "源码会应用 DX OS light/dark 上下文" : "建议监听 system.context、设置 data-theme，并提供深色主题 CSS；运行时兼容桥会提供基础适配" },
    { id: "context", label: "主动上下文", status: combined.includes("system.getContext") ? "pass" : "warn", detail: combined.includes("system.getContext") ? "支持主动读取系统上下文" : "建议通过 system.getContext 获取初始设置；运行时兼容桥会主动请求" },
    { id: "language", label: "语言同步", status: localizedText ? "pass" : "warn", detail: localizedText ? "包含 zh-CN/en-US 文案并消费 interfaceLocale" : "建议使用 interfaceLocale 切换至少 zh-CN/en-US 两套可见文案" },
    { id: "storage", label: "项目存储", status: /localStorage|indexedDB/.test(combined) && !/project\.(write|read|list)/.test(combined) ? "warn" : "pass", detail: /localStorage|indexedDB/.test(combined) && !/project\.(write|read|list)/.test(combined) ? "检测到浏览器存储；不能用作项目主数据源" : "未发现项目主数据依赖浏览器存储" },
    { id: "sandbox", label: "沙箱兼容", status: unsafeParentAccess ? "fail" : "pass", detail: unsafeParentAccess ? "不能读取 window.parent 的属性；跨域沙箱只允许 parent.postMessage" : "未发现跨域父窗口属性访问" },
    { id: "paths", label: "路径安全", status: unsafePathFound || hiddenProjectPath ? "fail" : "pass", detail: unsafePathFound ? "发现绝对路径或越界路径" : hiddenProjectPath ? "项目存储路径不能以点号开头；请使用普通 APP 子目录" : "未发现本机绝对路径、越界引用或隐藏项目目录" },
  ];
}

const MIME = Object.freeze({ ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".txt": "text/plain", ".md": "text/markdown" });

/** 默认数据目录：与 B6 的 <userData>/dxos 同构，但由装配处注入 rootDir（测试用临时目录）。 */
function defaultDeveloperLabRoot() {
  return path.join(os.tmpdir(), "openarc-developer-lab");
}

class DeveloperLab {
  constructor({ rootDir = null, clock = () => Date.now(), idFactory = () => crypto.randomUUID(), zipBuilder = writeZip, fsImpl = nodeFs } = {}) {
    this.rootDir = rootDir || defaultDeveloperLabRoot();
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.idFactory = typeof idFactory === "function" ? idFactory : () => crypto.randomUUID();
    this.zipBuilder = typeof zipBuilder === "function" ? zipBuilder : writeZip;
    this.fs = fsImpl || nodeFs;
  }

  // 源 :42-45 draftRoot
  #draftRoot(id) {
    if (!/^[a-f0-9-]{36}$/.test(String(id))) throw new Error("开发草稿 ID 无效");
    return path.join(this.rootDir, LAB_DIR_NAME, String(id));
  }

  // 源 :47-51 readDraftFiles
  #readDraftFiles(id) {
    const root = this.#draftRoot(id);
    const meta = JSON.parse(this.fs.readFileSync(path.join(root, "draft.json"), "utf8"));
    return (meta.paths || []).map((item) => ({ path: item, content: this.fs.readFileSync(path.join(root, "files", ...item.split("/")), "utf8") }));
  }

  // 源 :88-132 createDeveloperLabDraft
  createDeveloperLabDraft(input = {}) {
    const sourceFiles = Array.isArray(input.files) ? input.files : [];
    if (!sourceFiles.length || sourceFiles.length > MAX_FILES) throw new Error("文件数量必须为 1–" + MAX_FILES);
    const unique = new Map();
    let total = 0;
    for (const item of sourceFiles) {
      const rel = safePath(item && item.path);
      if (unique.has(rel)) throw new Error("存在重复文件路径：" + rel);
      const content = String((item && item.content) != null ? item.content : "");
      total += Buffer.byteLength(content, "utf8");
      if (total > MAX_TOTAL_BYTES) throw new Error("开发草稿不能超过 8 MB");
      unique.set(rel, { path: rel, content });
    }
    const files = [...unique.values()];
    const manifestFile = files.find((file) => file.path === "dx-app.json");
    if (!manifestFile) throw new Error("AI 结果缺少 dx-app.json");
    let manifest;
    try { manifest = JSON.parse(manifestFile.content); } catch { throw new Error("dx-app.json 不是有效 JSON"); }
    const appId = String(manifest.id || "").trim();
    const name = String(manifest.name || "").trim();
    if (!/^[a-z][a-z0-9-]{2,42}$/.test(appId)) throw new Error("dx-app.json.id 必须使用英文小写、数字和短横线");
    if (!name) throw new Error("dx-app.json.name 不能为空");
    const entry = String(manifest.entry || "index.html");
    if (!files.some((file) => file.path === entry)) throw new Error("缺少入口文件：" + entry);
    const id = this.idFactory();
    const root = this.#draftRoot(id);
    for (const file of files) {
      const target = path.resolve(root, "files", ...file.path.split("/"));
      const base = path.join(root, "files");
      if (!target.startsWith(base + path.sep)) throw new Error("文件路径越界");
      this.fs.mkdirSync(path.dirname(target), { recursive: true });
      this.fs.writeFileSync(target, file.content, "utf8");
    }
    const checks = analyzeDeveloperLabFiles(files, manifest);
    const icon = normalizeDeveloperIcon(manifest.icon, false);
    const previewToken = this.idFactory();
    const draft = {
      id, ownerId: String(input.ownerId || ""), previewToken,
      name: name.slice(0, 80), appId, summary: String(input.summary || "").slice(0, 500),
      files: files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, "utf8") })), checks,
      createdAt: this.clock(), previewUrl: "/api/market/developer-lab/" + id + "/preview/" + previewToken + "/" + entry,
      downloadUrl: "/api/market/developer-lab/" + id + "/download", icon,
    };
    this.fs.mkdirSync(root, { recursive: true });
    this.fs.writeFileSync(path.join(root, "draft.json"), JSON.stringify({ ...draft, paths: files.map((file) => file.path) }, null, 2), "utf8");
    return draft;
  }

  // 源 :134-149 getDeveloperLabDraft
  getDeveloperLabDraft(id) {
    const root = this.#draftRoot(id);
    const metaPath = path.join(root, "draft.json");
    const data = JSON.parse(this.fs.readFileSync(metaPath, "utf8"));
    try {
      const files = this.#readDraftFiles(id);
      const manifest = JSON.parse((files.find((file) => file.path === "dx-app.json") || {}).content || "{}");
      const entry = String(manifest.entry || "index.html");
      data.previewToken = data.previewToken || this.idFactory();
      data.previewUrl = "/api/market/developer-lab/" + id + "/preview/" + data.previewToken + "/" + entry;
      data.checks = analyzeDeveloperLabFiles(files, manifest);
      data.icon = normalizeDeveloperIcon(manifest.icon, false);
      this.fs.writeFileSync(metaPath, JSON.stringify({ ...data, paths: data.paths || files.map((file) => file.path) }, null, 2), "utf8");
    } catch { /* 读取接口仍返回原始草稿，具体文件错误由编辑/安装流程报告（源 :147） */ }
    return data;
  }

  // 源 :151-158 listDeveloperLabDrafts
  listDeveloperLabDrafts() {
    const root = path.join(this.rootDir, LAB_DIR_NAME);
    if (!this.fs.existsSync(root)) return [];
    const drafts = [];
    for (const id of this.fs.readdirSync(root)) {
      try { drafts.push(this.getDeveloperLabDraft(id)); } catch { /* 忽略不完整草稿 */ }
    }
    return drafts.sort((a, b) => b.createdAt - a.createdAt);
  }

  // 源 :160-168 setDeveloperLabDraftOwner
  setDeveloperLabDraftOwner(id, ownerId) {
    const root = this.#draftRoot(id);
    const metaPath = path.join(root, "draft.json");
    const data = JSON.parse(this.fs.readFileSync(metaPath, "utf8"));
    if (data.ownerId && data.ownerId !== ownerId) throw new Error("开发项目属于其他账户");
    data.ownerId = ownerId;
    this.fs.writeFileSync(metaPath, JSON.stringify(data, null, 2), "utf8");
    return this.getDeveloperLabDraft(id);
  }

  // 源 :170-175 deleteDeveloperLabDraft
  deleteDeveloperLabDraft(id) {
    const root = this.#draftRoot(id);
    if (!this.fs.existsSync(root)) return false;
    this.fs.rmSync(root, { recursive: true, force: true });
    return true;
  }

  // 源 :177-182 readDeveloperLabFile
  readDeveloperLabFile(id, rawPath) {
    const rel = safePath(rawPath);
    const file = this.#readDraftFiles(id).find((item) => item.path === rel);
    if (!file) throw new Error("开发文件不存在");
    return file;
  }

  // 源 :184-215 writeDeveloperLabFile
  writeDeveloperLabFile(id, rawPath, rawContent) {
    const rel = safePath(rawPath);
    const files = this.#readDraftFiles(id);
    const target = files.find((item) => item.path === rel);
    if (!target) throw new Error("开发文件不存在");
    target.content = String(rawContent != null ? rawContent : "");
    const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
    if (total > MAX_TOTAL_BYTES) throw new Error("开发草稿不能超过 8 MB");
    const manifestFile = files.find((file) => file.path === "dx-app.json");
    if (!manifestFile) throw new Error("开发草稿缺少 dx-app.json");
    let manifest;
    try { manifest = JSON.parse(manifestFile.content); } catch { throw new Error("dx-app.json 不是有效 JSON"); }
    const appId = String(manifest.id || "").trim();
    const name = String(manifest.name || "").trim();
    if (!/^[a-z][a-z0-9-]{2,42}$/.test(appId)) throw new Error("dx-app.json.id 必须使用英文小写、数字和短横线");
    if (!name) throw new Error("dx-app.json.name 不能为空");
    const entry = String(manifest.entry || "index.html");
    if (!files.some((file) => file.path === entry)) throw new Error("缺少入口文件：" + entry);
    const root = this.#draftRoot(id);
    const draft = this.getDeveloperLabDraft(id);
    this.fs.writeFileSync(path.join(root, "files", ...rel.split("/")), target.content, "utf8");
    const updated = {
      ...draft, name: name.slice(0, 80), appId,
      icon: normalizeDeveloperIcon(manifest.icon, false),
      files: files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, "utf8") })),
      checks: analyzeDeveloperLabFiles(files, manifest),
      previewUrl: "/api/market/developer-lab/" + id + "/preview/" + draft.previewToken + "/" + entry,
    };
    this.fs.writeFileSync(path.join(root, "draft.json"), JSON.stringify({ ...updated, paths: files.map((file) => file.path) }, null, 2), "utf8");
    return updated;
  }

  // 源 :217-222 setDeveloperLabIcon
  setDeveloperLabIcon(id, value) {
    const manifestFile = this.readDeveloperLabFile(id, "dx-app.json");
    const manifest = JSON.parse(manifestFile.content);
    manifest.icon = value ? normalizeDeveloperIcon(value) : autoDeveloperIcon(String(manifest.name || ""), String(manifest.id || id));
    return this.writeDeveloperLabFile(id, "dx-app.json", JSON.stringify(manifest, null, 2));
  }

  // 源 :224-228 developerLabZip（复用 B5c 的零依赖 writeZip，不新增依赖）
  developerLabZip(id) {
    const draft = this.getDeveloperLabDraft(id);
    const files = this.#readDraftFiles(id);
    return { draft, buffer: this.zipBuilder(files.map((file) => ({ name: file.path, data: Buffer.from(file.content, "utf8") }))) };
  }

  // 源 :232-244 developerLabPreview（只回原始字节 + MIME；system bridge 属 B7a 运行时）
  developerLabPreview(id, rawPath) {
    const rel = safePath(rawPath || "index.html");
    const root = path.join(this.#draftRoot(id), "files");
    const target = path.resolve(root, ...rel.split("/"));
    if (!target.startsWith(root + path.sep) || !this.fs.existsSync(target)) throw new Error("预览文件不存在");
    return { data: this.fs.readFileSync(target), mime: MIME[path.extname(rel).toLowerCase()] || "application/octet-stream" };
  }

  // 源 :246-250 verifyDeveloperLabPreviewToken
  verifyDeveloperLabPreviewToken(id, token) {
    const draft = this.getDeveloperLabDraft(id);
    if (!draft.previewToken || token !== draft.previewToken) throw new Error("开发预览凭证无效");
    return draft;
  }

  createDeveloperLabDraftFromTemplate({ templateId, ownerId, summary = "" } = {}) {
    return this.createDeveloperLabDraft({ files: buildDeveloperLabTemplate(templateId), summary, ownerId });
  }
}

// ===========================================================================
// 五 · 命令面（并入唯一 developer:command；下行沿用 developer:event）
// ===========================================================================

const DEVELOPER_LAB_COMMANDS = Object.freeze([
  { command: "developer/lab/templates", risk: "read", credential: "none", summary: "列举开发者实验室示例工程模板（逐字移植自 developerLabExamples）" },
  { command: "developer/lab/example", risk: "read", credential: "none", summary: "生成示例工程文件（内存投影，不落盘）" },
  { command: "developer/lab/create", risk: "write", credential: "none", summary: "创建开发草稿（校验清单、入口、路径与扩展名）" },
  { command: "developer/lab/createFromTemplate", risk: "write", credential: "none", summary: "由示例模板创建开发草稿" },
  { command: "developer/lab/get", risk: "read", credential: "none", summary: "读取开发草稿（含重新分析出的检查项与图标投影）" },
  { command: "developer/lab/list", risk: "read", credential: "none", summary: "列举本机开发草稿（按创建时间倒序）" },
  { command: "developer/lab/setOwner", risk: "write", credential: "none", summary: "绑定开发草稿归属账户（属于其他账户时拒绝）" },
  { command: "developer/lab/delete", risk: "delete", credential: "none", summary: "删除开发草稿目录" },
  { command: "developer/lab/readFile", risk: "read", credential: "none", summary: "读取草稿内单个文件" },
  { command: "developer/lab/writeFile", risk: "write", credential: "none", summary: "写入草稿内单个文件并重算检查项" },
  { command: "developer/lab/setIcon", risk: "write", credential: "none", summary: "设置 / 自动生成草稿图标（内联投影，不新增资产）" },
  { command: "developer/lab/zip", risk: "read", credential: "none", summary: "把草稿打成 ZIP 字节（内联返回）" },
  { command: "developer/lab/preview", risk: "read", credential: "none", summary: "读取预览文件原始字节与 MIME（不注入运行时桥）" },
  { command: "developer/lab/verifyPreviewToken", risk: "read", credential: "none", summary: "校验开发预览凭证" },
  { command: "developer/lab/icon/normalize", risk: "read", credential: "none", summary: "规范化图标描述（SVG 安全过滤 / PNG data URL 校验）" },
  { command: "developer/lab/icon/auto", risk: "read", credential: "none", summary: "按名称与 ID 生成确定性图标投影" },
  { command: "developer/docs/catalog", risk: "read", credential: "none", summary: "读取离线开发文档目录（含完整性校验）" },
  { command: "developer/docs/get", risk: "read", credential: "none", summary: "读取离线开发文档正文（Markdown）" },
  { command: "developer/docs/status", risk: "read", credential: "none", summary: "报告离线文档缓存状态" },
  { command: "developer/docs/refresh", risk: "write", credential: "none", summary: "远端文档刷新已停用（api.dx-os.com 属 OUT，结构化拒绝）" },
]);

const DEVELOPER_LAB_REGISTRY = new Map(DEVELOPER_LAB_COMMANDS.map((entry) => [entry.command, entry]));

function createDeveloperLabExtension({ lab = null, docsDir = null, fsImpl = nodeFs } = {}) {
  const requireLab = () => {
    if (!lab || typeof lab.createDeveloperLabDraft !== "function") return fail("DEVELOPER_LAB_UNAVAILABLE", "lab-not-configured");
    return null;
  };
  const handlers = {
    "developer/lab/templates": () => ok({ templates: listDeveloperLabTemplates() }),
    "developer/lab/example": (payload) => ok({ files: buildDeveloperLabTemplate(asStr(payload.templateId, 80)) }),
    "developer/lab/create": (payload) => {
      const missing = requireLab(); if (missing) return missing;
      return ok({ draft: lab.createDeveloperLabDraft({ files: Array.isArray(payload.files) ? payload.files : [], summary: asStr(payload.summary, 500), ownerId: asStr(payload.ownerId, 120) }) });
    },
    "developer/lab/createFromTemplate": (payload) => {
      const missing = requireLab(); if (missing) return missing;
      return ok({ draft: lab.createDeveloperLabDraftFromTemplate({ templateId: asStr(payload.templateId, 80), ownerId: asStr(payload.ownerId, 120), summary: asStr(payload.summary, 500) }) });
    },
    "developer/lab/get": (payload) => {
      const missing = requireLab(); if (missing) return missing;
      return ok({ draft: lab.getDeveloperLabDraft(asStr(payload.id, 80)) });
    },
    "developer/lab/list": () => {
      const missing = requireLab(); if (missing) return missing;
      return ok({ drafts: lab.listDeveloperLabDrafts() });
    },
    "developer/lab/setOwner": (payload) => {
      const missing = requireLab(); if (missing) return missing;
      return ok({ draft: lab.setDeveloperLabDraftOwner(asStr(payload.id, 80), asStr(payload.ownerId, 120)) });
    },
    "developer/lab/delete": (payload) => {
      const missing = requireLab(); if (missing) return missing;
      return ok({ deleted: lab.deleteDeveloperLabDraft(asStr(payload.id, 80)) });
    },
    "developer/lab/readFile": (payload) => {
      const missing = requireLab(); if (missing) return missing;
      return ok({ file: lab.readDeveloperLabFile(asStr(payload.id, 80), asStr(payload.path, 500)) });
    },
    "developer/lab/writeFile": (payload) => {
      const missing = requireLab(); if (missing) return missing;
      return ok({ draft: lab.writeDeveloperLabFile(asStr(payload.id, 80), asStr(payload.path, 500), payload.content) });
    },
    "developer/lab/setIcon": (payload) => {
      const missing = requireLab(); if (missing) return missing;
      return ok({ draft: lab.setDeveloperLabIcon(asStr(payload.id, 80), payload.icon) });
    },
    "developer/lab/zip": (payload) => {
      const missing = requireLab(); if (missing) return missing;
      const result = lab.developerLabZip(asStr(payload.id, 80));
      return ok({ draft: result.draft, byteLength: result.buffer.byteLength, sha256: sha256(result.buffer), base64: result.buffer.toString("base64") });
    },
    "developer/lab/preview": (payload) => {
      const missing = requireLab(); if (missing) return missing;
      const result = lab.developerLabPreview(asStr(payload.id, 80), asStr(payload.path, 500));
      return ok({ mime: result.mime, byteLength: result.data.byteLength, base64: result.data.toString("base64") });
    },
    "developer/lab/verifyPreviewToken": (payload) => {
      const missing = requireLab(); if (missing) return missing;
      return ok({ draft: lab.verifyDeveloperLabPreviewToken(asStr(payload.id, 80), asStr(payload.token, 120)) });
    },
    "developer/lab/icon/normalize": (payload) => ok({ icon: normalizeDeveloperIcon(payload.icon, payload.fallback !== false) }),
    "developer/lab/icon/auto": (payload) => ok({ icon: autoDeveloperIcon(asStr(payload.name, 120) || "", asStr(payload.id, 120) || "") }),
    "developer/docs/catalog": (payload) => {
      if (!docsDir) return fail("DEVELOPER_DOCS_UNAVAILABLE", "docs-dir-not-configured");
      const manifest = cachedDeveloperDocs({ dir: docsDir, locale: asStr(payload.locale, 20) || "zh-CN", fsImpl });
      if (!manifest) return fail("DEVELOPER_DOCS_UNAVAILABLE", "cache-missing-or-invalid");
      return ok({ manifest });
    },
    "developer/docs/get": (payload) => {
      if (!docsDir) return fail("DEVELOPER_DOCS_UNAVAILABLE", "docs-dir-not-configured");
      return ok({ document: developerDocument({ dir: docsDir, slug: asStr(payload.slug, 200), locale: asStr(payload.locale, 20) || "zh-CN", fsImpl }).document });
    },
    "developer/docs/status": (payload) => {
      if (!docsDir) return fail("DEVELOPER_DOCS_UNAVAILABLE", "docs-dir-not-configured");
      return ok({ status: developerDocsCacheStatus({ dir: docsDir, locale: asStr(payload.locale, 20) || "zh-CN", fsImpl }) });
    },
    "developer/docs/refresh": () => refreshDeveloperDocs(),
  };
  const dispatch = ({ command, payload } = {}) => {
    const entry = DEVELOPER_LAB_REGISTRY.get(String(command || ""));
    if (!entry) return fail("DEVELOPER_COMMAND_NOT_ALLOWED", String(command || ""));
    const handler = handlers[entry.command];
    if (typeof handler !== "function") return fail("NOT_IMPLEMENTED", entry.command);
    const safePayload = payload && typeof payload === "object" ? payload : {};
    try { return handler(safePayload, {}); } catch (error) { return fail(String((error && error.message) || error)); }
  };

  return {
    channel: CHANNEL, eventChannel: EVENT_CHANNEL,
    registry: DEVELOPER_LAB_COMMANDS.map((entry) => ({ ...entry })),
    commandNames: DEVELOPER_LAB_COMMANDS.map((entry) => entry.command),
    dispatch, handlers,
  };
}

/**
 * 把多个开发者域切片（lab / collab / migrations / realtime）合到唯一 developer:command。
 * 与 canvas-dxos-commands.cjs:314-329 的 combineCanvasCommandHandlers 同一形态：
 * 先查合并后的注册表，命中即交给对应切片；未命中回落 base（B7a 的开发者域），再没有就结构化拒绝。
 */
function combineDeveloperCommandHandlers({ base = null, extensions = [], identity = null, isTrusted = null, hostAppId = "developer" } = {}) {
  const owners = new Map();
  for (const extension of extensions) {
    for (const entry of extension.registry || []) {
      if (!owners.has(entry.command)) owners.set(entry.command, { entry, extension });
    }
  }
  const handler = async (event, raw) => {
    if (typeof isTrusted === "function" && !isTrusted(event)) throw Error("Forbidden");
    if (!raw || typeof raw !== "object") return fail("INVALID_INPUT");
    const command = typeof raw.command === "string" ? raw.command : typeof raw.type === "string" ? raw.type : "";
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    const owned = owners.get(command);
    if (owned) {
      const context = { sessionRef: identity ? identity.current : null, appId: hostAppId, source: "ui", requestId: asStr(payload.requestId, 80) };
      try { return owned.extension.dispatch({ command, payload, context }); }
      catch { return fail("INTERNAL_ERROR"); }
    }
    if (typeof base === "function") return base(event, raw);
    return fail("DEVELOPER_COMMAND_NOT_ALLOWED", command);
  };
  handler.registry = [...owners.values()].map(({ entry }) => ({ ...entry }));
  handler.channel = CHANNEL;
  handler.eventChannel = EVENT_CHANNEL;
  return handler;
}

/** Electron 侧注册：只注册一个 developer:command（不新建域）。 */
function registerDeveloperIpc({ ipcMain, extensions = [], base = null, identity = null, isTrusted = null, channel = CHANNEL } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerDeveloperIpc 需要 ipcMain");
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler(channel); } catch { /* 尚未注册 */ } }
  ipcMain.handle(channel, combineDeveloperCommandHandlers({ base, extensions, identity, isTrusted }));
}

/** 下行：把切片的事件回调接到 developer:event（沿用唯一事件通道，不新建域）。 */
function wireDeveloperEvents({ extensions = [], send = null } = {}) {
  if (typeof send !== "function") throw new Error("wireDeveloperEvents 需要 send 回调");
  const wired = [];
  for (const extension of extensions) {
    if (typeof extension.onEvent !== "function") continue;
    extension.onEvent((delivery) => send({ channel: EVENT_CHANNEL, ...delivery }));
    wired.push(extension.channel || CHANNEL);
  }
  return wired;
}

/**
 * 一体化装配：一次构造 B7b 的四个切片，供 developer:command 的唯一装配点使用。
 * 需要的依赖按需传入（缺谁就少一个切片），返回的 commandNames 可直接并入
 * electron/developer-domain.cjs 的白名单；combine() 得到唯一 developer:command 处理器。
 */
function createDeveloperDomainExtensions({ lab = null, docsDir = null, collab = null, migrationStore = null, migrationFs = null, realtimeHub = null } = {}) {
  const extensions = [createDeveloperLabExtension({ lab, docsDir })];
  if (collab) extensions.push(require("./developer-collab.cjs").createDeveloperCollabExtension({ collab }));
  if (migrationStore) extensions.push(require("./developer-migrations.cjs").createDeveloperMigrationExtension({ store: migrationStore, fsAdapter: migrationFs }));
  if (realtimeHub) extensions.push(require("./developer-realtime.cjs").createDeveloperRealtimeExtension({ hub: realtimeHub }));
  const commands = extensions.flatMap((extension) => extension.registry.map((entry) => ({ ...entry })));
  return {
    channel: CHANNEL, eventChannel: EVENT_CHANNEL,
    extensions, commands, commandNames: commands.map((entry) => entry.command),
    combine: (options = {}) => combineDeveloperCommandHandlers({ extensions, ...options }),
  };
}

module.exports = {
  CHANNEL, EVENT_CHANNEL,
  MAX_FILES, MAX_TOTAL_BYTES, ALLOWED_EXTENSIONS, isValidSemver,
  DEVELOPER_ICON_FALLBACK_SVG, DEVELOPER_ICON_PALETTES,
  escapeXml, safeGradient, sanitizeDeveloperSvg, pngDataUrl, normalizeDeveloperIcon, autoDeveloperIcon,
  DEVELOPER_DOCS_MANIFEST_FORMAT, validateDeveloperDocumentManifest, developerDocumentPath,
  cachedDeveloperDocs, developerDocument, developerDocsCacheStatus, refreshDeveloperDocs,
  gomokuDeveloperLabFiles, DEVELOPER_LAB_TEMPLATES, listDeveloperLabTemplates, buildDeveloperLabTemplate,
  safePath, analyzeDeveloperLabFiles, DeveloperLab, defaultDeveloperLabRoot,
  DEVELOPER_LAB_COMMANDS, DEVELOPER_LAB_REGISTRY, createDeveloperLabExtension,
  combineDeveloperCommandHandlers, registerDeveloperIpc, wireDeveloperEvents, createDeveloperDomainExtensions,
};
