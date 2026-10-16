/**
 * D5-02 Full-App · 上游 NOVAI 完整应用 vendor 脚本（唯一入口，可重复执行）。
 *
 * 用法：node experiments/d5-02/vendor-novai-app.mjs
 *   源：OA_NOVAI_SRC（默认 /tmp/novai-canvas-src），必须是 SOURCE_COMMIT 的干净检出。
 *   目标：public/novai-canvas/static/**（"只保留无限画布"的页面白名单 + 依赖闭包）
 *   + 四个 openarc-*.js 适配脚本。**产品入口 = static/canvas-list.html**（宿主 IFRAME_BASE 指向它）；
 *   bundle 根 index.html 不再生成（E4 边界测试已改到该产品页，见文件末尾第 5 步）。
 *
 * 为什么**不改写 /static/ 路径**：自定义协议是 standard:true，根绝对 /static/x 会自然解析为
 * openarc-canvas://bundle/static/x。改写 14 个页面 + 动态注入 + 动态 import 的风险远大于原样服务。
 *
 * 对上游文件的改动（全部可审计、可重复生成；补丁幂等、目标缺失即报错、可反复重跑）：
 *   1) 每个页面 head 注入 CSP meta + openarc-bridge.js（最先执行）；
 *   2) （已移除）原 bundle 根 index.html（上游 static/index.html 副本 + openarc-shell.js 中继）不再生成：
 *      E4 边界测试改用真实产品页 static/canvas-list.html，该外壳零引用 ⇒ 连旧残留一起清掉；
 *      openarc-shell.js 随之零加载（全仓无注入点），本轮裁决删除，这里一并清掉旧副本；
 *   3) static/js/canvas.js 末尾（IIFE 内）依次追加：三方合并模块（experiments/d5-02/vendor/canvas-merge.js）
 *      + AI 新增标记模块（experiments/d5-02/vendor/canvas-ai-marks.js）——两个都是纯函数、Node 单测测
 *      同一份文本 —— + OpenArc 适配层（experiments/d5-02/vendor/canvas-internals.js），
 *      static/canvas.html 在其后注入 openarc-adapter.js 与 openarc-canvas-guard.js（**只 canvas.html**：
 *      编辑器是唯一有供应商/模型下拉的页面）；
 *   4) static/canvas-list.html 的三个"新建"入口改成直接进编辑器（见下面 LIST_PATCHES，幂等且缺目标即报错）；
 *   5) static/js/canvas.js 的 saveCanvas() 三处补丁（见下面 CANVAS_JS_PATCHES）：
 *      · 记录"这次真正发出去的文档"（= 服务端接受后页面的共同祖先）；
 *      · 保存成功时把这一版交给注入层（下一次冲突做三方合并的 base）；
 *      · **409 分支交给注入层做三方合并**，不再"换基线后重发同一份旧文档"（那会静默覆盖对方改动）。
 *   6) static/js/canvas.js 的 apiImageSize() 改为「长边 + 该档像素上限」等比对称求解（见 CANVAS_JS_PATCHES
 *      第 5 条）：修上游 custom/source 只压一侧造成的非方形 / 超上限尺寸（1:1@1k 旧值 1536x1248）；
 *      具名比例沿用 SIZE_MAP 预设，只在预设自身超上限时收窄（square@4k 的 4096x4096 → 2880x2880）。
 *   7) （第 11 处改动）static/canvas-list.html 的**入口改向**：新建 / 继续上次 / 卡片点击 / 回收站恢复后进入，
 *      全部改向 static/smart-canvas.html（同一 id / project）；经典 canvas.html 已无入口可达但暂不删除；
 *   8) （第 12 处改动）static/js/smart-canvas.js 的 IIFE 末尾内联**最小封堵**
 *      （experiments/d5-02/vendor/smart-canvas-guard.js）：供应商/模型只来自宿主 /api/config 投影、
 *      未接通能力（视频 / ComfyUI）如实禁用并标注、只读画布不可编辑；不是经典守卫的移植。
 *      （V0.01 授权补齐）只读闸从"只包 pushUndo"扩到**逐条编辑路径**：事件闸（捕获阶段拦
 *      指针/拖放/剪贴板/输入/键盘编辑键）+ 173 个改文档的闭包函数闸 + fetch 写请求页面侧拒绝，
 *      并把页面提前 window.* 导出的那些重新指到包装实现；证据面新增 snapshot()/wrapped()/writeBlocked()。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_COMMIT = "1e20abe5145470b32f58206f692292703540107a";
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
/** 本地源码开关：设置 OA_NOVAI_SRC 即按「本地目录」取证并 vendor（不再要求 HEAD 等于 SOURCE_COMMIT）。 */
const LOCAL_SRC = process.env.OA_NOVAI_SRC || "";
const SRC = LOCAL_SRC || "/tmp/novai-canvas-src";
/** 干跑：只分析不落盘（不写 public/novai-canvas/**，不写 vendor-manifest.json）。 */
const DRY_RUN = process.argv.includes("--dry-run") || process.env.OA_VENDOR_DRY_RUN === "1";
const OUT = path.join(ROOT, "public", "novai-canvas");
/** 已 vendor 的 bundle static/：干跑时只读它做差异对照；写入一律去 OUT_STATIC。 */
const REAL_STATIC = path.join(OUT, "static");
let SRC_STATIC = path.join(SRC, "static");
let OUT_STATIC = REAL_STATIC;
const PATCH = path.join(here, "vendor", "canvas-internals.js");
/** 保存冲突的三方合并（纯函数）：内联进 canvas.js 的同一个 IIFE，Node 单测 require 同一份文本。*/
const MERGE = path.join(here, "vendor", "canvas-merge.js");
/** AI 新增节点的来源标记 / 入场去重（纯函数）：同样内联进 canvas.js，Node 单测 require 同一份文本。*/
const AI_MARKS = path.join(here, "vendor", "canvas-ai-marks.js");
/** D5-02 供应商/模型单一真源守卫：只注入编辑器页，在 canvas.js / openarc-adapter.js 之后执行。*/
const GUARD = path.join(OUT, "openarc-canvas-guard.js");
/** 应用内模态输入：Electron 不支持 window.prompt，列表页与智能画布的重命名都改用它。*/
const MODAL = path.join(OUT, "openarc-rename-modal.js");
/** 智能画布最小封堵（第 12 处改动）：**不移植经典守卫**，只封掉"页面自己造模型/平台"与
 *  未接通能力的假可用 + 只读闸；内联进 static/js/smart-canvas.js 的 IIFE 末尾（同域，够得到内部兜底）。*/
const SMART_GUARD = path.join(here, "vendor", "smart-canvas-guard.js");

const CSP = [
  "default-src 'none'",
  "script-src openarc-canvas: 'unsafe-inline'",
  "style-src openarc-canvas: 'unsafe-inline'",
  "img-src openarc-canvas: data: blob:",
  "media-src openarc-canvas: data: blob:",
  "font-src openarc-canvas:",
  "connect-src openarc-canvas:",
  "frame-src openarc-canvas:",
  "child-src openarc-canvas:",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const HEAD_INJECT = [
  '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">',
  '<script src="/openarc-bridge.js"></script>',
].join("\n    ");

function sha256(text) { return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16); }

/* ── 来源解析 / 取证 / 干跑报告（DXOS-CANVAS-REVENDOR-NEXT）──────────────────────────────
   本包只加「本地源 + 干跑」，不改任何一处既有补丁的目标与结果；不传 OA_NOVAI_SRC 时按固定 pin
   校验并落盘，输出与之前逐字一致（唯一新增字段见 vendor-manifest.json 的 sourceProvenance）。 */

/** 干跑锚点报告：每条脚本化改动一条记录（hit / idempotent / MISS），干跑不因 MISS 中断。*/
const ANCHOR_LOG = [];
function anchor(name, status, detail) { ANCHOR_LOG.push({ name, status, detail: detail || "" }); }

function fmtBytes(n) {
  const units = ["B", "KB", "MB", "GB"];
  let v = Number(n) || 0, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? String(v) : v.toFixed(1)) + units[i];
}

/** 定位上游 static/：OA_NOVAI_SRC 可能是工程根，也可能是「工程在子目录里」的父目录
 *  （本机实测：/Users/…/NOVAI-Infinite-Canvas-main/NOVAI-v16/static）。唯一命中才算数。*/
function resolveStaticRoot() {
  const direct = path.join(SRC, "static");
  if (fs.existsSync(direct)) return { srcRoot: SRC, staticDir: direct };
  if (!LOCAL_SRC) throw new Error("源 static/ 不存在：" + direct);
  const hits = [];
  for (const e of fs.readdirSync(SRC, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const sub = path.join(SRC, e.name, "static");
    if (fs.existsSync(path.join(sub, "canvas-list.html"))) hits.push({ srcRoot: path.join(SRC, e.name), staticDir: sub });
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error("OA_NOVAI_SRC 下有多个候选 static/：" + hits.map((h) => h.staticDir).join("、"));
  throw new Error("源 static/ 不存在：" + direct + "（子目录里也没有 canvas-list.html）");
}

/** 有 .git 就记 HEAD + git status --porcelain（是否脏）；不是 git 检出返回 null。*/
function readGitProvenance(root) {
  try {
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const topLevel = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const porcelain = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
    const changed = porcelain.split("\n").map((l) => l.replace(/\s+$/, "")).filter(Boolean);
    return {
      head, topLevel, dirty: changed.length > 0,
      changedFileCount: changed.length,
      changedFiles: changed.slice(0, 400),
      changedFilesTruncated: changed.length > 400,
    };
  } catch { return null; }
}

/** 「将被 vendor 的文件」清单的内容指纹：路径 + 内容 sha256 稳定拼装（与遍历顺序无关）。*/
function contentFingerprint(staticDir, files) {
  const h = crypto.createHash("sha256");
  let bytes = 0;
  for (const rel of [...files].sort()) {
    const buf = fs.readFileSync(path.join(staticDir, rel));
    bytes += buf.length;
    h.update(rel + "\0" + crypto.createHash("sha256").update(buf).digest("hex") + "\n");
  }
  return { algorithm: "sha256", scope: "kept-files", files: files.length, bytes, value: h.digest("hex") };
}

/** 幂等补丁：已打过 → idempotent；命中 → hit；缺失 → 干跑记 MISS 并继续，真实运行照旧报错退出。*/
function applyPatches(text, patches, label) {
  for (let i = 0; i < patches.length; i += 1) {
    const raw = patches[i];
    const isObj = !Array.isArray(raw);
    const from = isObj ? raw.from : raw[0];
    const to = isObj ? raw.to : raw[1];
    const name = isObj ? raw.name : label + " 补丁 #" + (i + 1) + "：" + String(from).trim().split("\n")[0].slice(0, 64);
    if (text.includes(to)) { anchor(name, "idempotent", "已应用（重跑幂等）"); continue; }
    if (!text.includes(from)) {
      anchor(name, "MISS", String(from).trim().split("\n")[0].slice(0, 90));
      if (DRY_RUN) continue;
      throw new Error(label + "补丁目标缺失（上游结构变了）：" + name);
    }
    anchor(name, "hit", "");
    text = text.replace(from, to);
  }
  return text;
}

/** 结构锚点（IIFE 收尾 / 脚本标签 / <head>）：干跑记 MISS 不中断，真实运行报错退出。*/
function requireAnchor(ok, name, detail) {
  anchor(name, ok ? "hit" : "MISS", ok ? "" : (detail || ""));
  if (!ok && !DRY_RUN) throw new Error("结构锚点缺失（上游结构变了）：" + name + (detail ? " — " + detail : ""));
  return ok;
}

/** 干跑：把「脚本会产出的 static/」与「当前 bundle 的 static/」逐文件对照。*/
function diffStatic(plannedDir, currentDir) {
  const norm = (p) => p.split(path.sep).join("/");
  const planned = new Set(walk(plannedDir).map(norm));
  const current = fs.existsSync(currentDir) ? new Set(walk(currentDir).map(norm)) : new Set();
  const added = [...planned].filter((p) => !current.has(p)).sort();
  const removed = [...current].filter((p) => !planned.has(p)).sort();
  const changed = [];
  const same = [];
  for (const p of [...planned].filter((p) => current.has(p)).sort()) {
    if (fs.readFileSync(path.join(plannedDir, p)).equals(fs.readFileSync(path.join(currentDir, p)))) same.push(p);
    else changed.push(p);
  }
  return { added, removed, changed, same };
}

/* ── SOURCE.md 的来源块 ──────────────────────────────────────────────────────────── */
const PROV_TEMPLATE = path.join(ROOT, "experiments", "dxos-canvas-revendor-next", "SOURCE.md.template");
const PROV_GENERATED = path.join(ROOT, "experiments", "dxos-canvas-revendor-next", "SOURCE.provenance.md");
const INPLACE_BEGIN = "<!-- OA-SOURCE-PROVENANCE:BEGIN -->";
const INPLACE_END = "<!-- OA-SOURCE-PROVENANCE:END -->";
const PROV_FALLBACK = [
  INPLACE_BEGIN,
  "## 来源（自动生成 · vendor 脚本写入）",
  "",
  "| 项 | 值 |",
  "| --- | --- |",
  "| 来源类型 | {{SOURCE_TYPE}} |",
  "| 来源标识 | `{{SOURCE_IDENTITY}}` |",
  "| 抓取时间 | {{CAPTURED_AT}} |",
  "| 源目录 | `{{SRC_ROOT}}` |",
  "| static/ | `{{STATIC_DIR}}` |",
  "| 固定 pin | `{{PINNED_COMMIT}}` |",
  "| 与 pin 一致 | {{MATCHES_PIN}} |",
  "| 工作区 | {{GIT_STATE}} |",
  "| 内容指纹 | `sha256:{{CONTENT_FINGERPRINT}}`（{{FILE_COUNT}} files / {{BYTES}} B） |",
  INPLACE_END,
].join("\n");

function renderProvenanceMarkdown(p) {
  let tpl = PROV_FALLBACK;
  try { if (fs.existsSync(PROV_TEMPLATE)) tpl = fs.readFileSync(PROV_TEMPLATE, "utf8").trimEnd(); } catch { /* 用内置模板 */ }
  const values = {
    SOURCE_TYPE: p.type === "git" ? "git 检出" : "内容指纹（非 git）",
    SOURCE_IDENTITY: p.identity,
    CAPTURED_AT: p.capturedAt,
    SRC_ROOT: p.srcRoot,
    STATIC_DIR: p.staticDir,
    PINNED_COMMIT: p.pinnedCommit,
    MATCHES_PIN: p.matchesPin === true ? "是" : (p.matchesPin === false ? "**否**（本地源码已前进/被改）" : "不适用"),
    GIT_STATE: p.git ? (p.git.dirty ? "脏（" + p.git.changedFileCount + " 个改动文件）" : "干净") : "不适用（非 git）",
    CONTENT_FINGERPRINT: p.contentFingerprint.value,
    FILE_COUNT: String(p.contentFingerprint.files),
    BYTES: String(p.contentFingerprint.bytes),
  };
  return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in values ? values[k] : m));
}

function writeSourceProvenance(p) {
  const md = renderProvenanceMarkdown(p);
  try {
    fs.mkdirSync(path.dirname(PROV_GENERATED), { recursive: true });
    fs.writeFileSync(PROV_GENERATED, md + "\n");
    console.log("[vendor] 来源块写入 " + path.relative(ROOT, PROV_GENERATED));
  } catch (e) { console.warn("[vendor] 写 SOURCE.provenance.md 失败：" + e.message); }
  const sourceMd = path.join(OUT, "SOURCE.md");
  try {
    if (!fs.existsSync(sourceMd)) return;
    const cur = fs.readFileSync(sourceMd, "utf8");
    if (cur.includes(INPLACE_BEGIN) && cur.includes(INPLACE_END)) {
      const next = cur.replace(new RegExp(INPLACE_BEGIN + "[\\s\\S]*?" + INPLACE_END), md.replace(/\$/g, "$$$$"));
      if (next !== cur) { fs.writeFileSync(sourceMd, next); console.log("[vendor] SOURCE.md 来源块就地更新"); }
    } else if (process.env.OA_SOURCE_PROVENANCE_APPEND === "1") {
      fs.writeFileSync(sourceMd, md + "\n\n" + cur);
      console.log("[vendor] SOURCE.md 已前置来源块（OA_SOURCE_PROVENANCE_APPEND=1）");
    } else {
      console.warn("[vendor] SOURCE.md 无 " + INPLACE_BEGIN + " 标记：未就地写入（生成件见 experiments/dxos-canvas-revendor-next/SOURCE.provenance.md）");
    }
  } catch (e) { console.warn("[vendor] 写 SOURCE.md 来源块失败：" + e.message); }
}

function printDryRunReport(ctx) {
  const { provenance, sourceFiles, files, keepSet, injected, sourceStatic } = ctx;
  const sizeOf = (rel) => fs.statSync(path.join(sourceStatic, rel)).size;
  const dropped = sourceFiles.filter((f) => !keepSet.has(f)).sort();
  const keptBytes = files.reduce((s, f) => s + sizeOf(f), 0);
  const dropBytes = dropped.reduce((s, f) => s + sizeOf(f), 0);
  const d = diffStatic(OUT_STATIC, REAL_STATIC);
  const miss = ANCHOR_LOG.filter((a) => a.status === "MISS");
  console.log("");
  console.log("=== vendor dry-run（只分析，不落盘）===");
  console.log("来源类型  : " + provenance.type + (provenance.git ? "（git 检出）" : "（非 git：内容指纹）"));
  console.log("来源标识  : " + provenance.identity);
  console.log("抓取时间  : " + provenance.capturedAt);
  console.log("源目录    : " + provenance.srcRoot);
  console.log("static/   : " + provenance.staticDir);
  if (provenance.git) console.log("工作区    : " + (provenance.git.dirty ? "脏（" + provenance.git.changedFileCount + " 个改动文件）" : "干净") + "；pin=" + provenance.pinnedCommit + "；matchesPin=" + provenance.matchesPin);
  console.log("内容指纹  : sha256:" + provenance.contentFingerprint.value + "  files=" + provenance.contentFingerprint.files + " bytes=" + provenance.contentFingerprint.bytes);
  console.log("");
  console.log("[保留] " + files.length + " files / " + keptBytes + " B（" + fmtBytes(keptBytes) + "）");
  for (const f of files) console.log("  + " + f + "  (" + sizeOf(f) + " B)");
  console.log("[排除] " + dropped.length + " files / " + dropBytes + " B（" + fmtBytes(dropBytes) + "）");
  for (const f of dropped) console.log("  - " + f + "  (" + sizeOf(f) + " B)");
  console.log("");
  console.log("[与当前 public/novai-canvas/static 的差异] 新增 " + d.added.length + " / 删除 " + d.removed.length + " / 内容变化 " + d.changed.length + " / 相同 " + d.same.length);
  d.added.forEach((p) => console.log("  + " + p));
  d.removed.forEach((p) => console.log("  - " + p));
  d.changed.forEach((p) => console.log("  ~ " + p + "  （源 sha256 与当前 bundle 不同：上游改动，或当前 bundle 被旁路手改/由旧补丁生成）"));
  console.log("");
  console.log("[锚点命中] 共 " + ANCHOR_LOG.length + " 条，MISS " + miss.length + " 条；注入页面 " + injected.length + " 个");
  for (const a of ANCHOR_LOG) console.log("  [" + a.status + "] " + a.name + (a.detail ? "  ← " + a.detail : ""));
  console.log("");
  console.log("DRY_RUN_JSON " + JSON.stringify({
    dryRun: true,
    provenance,
    kept: { files: files.length, bytes: keptBytes },
    dropped: { files: dropped.length, bytes: dropBytes },
    diff: { added: d.added, removed: d.removed, changed: d.changed, sameCount: d.same.length },
    anchors: ANCHOR_LOG,
    pages: injected,
  }));
}



function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

/**
 * ── 「只保留无限画布」裁剪策略（页面白名单 + 依赖驱动的闭包） ──────────────────────────────
 *
 * 入口白名单 = 上游原版列表首页 + 编辑器 + 智能画布编辑器。
 *   · static/canvas-list.html 是产品入口（宿主 IFRAME_BASE 指向它）；
 *   · static/canvas.html 是无限画布编辑器；
 *   · static/smart-canvas.html 是"智能画布"编辑器 —— 列表按 canvas.kind === 'smart' 直接路由到它
 *     （canvas-list.html:1260/1361/1379），canvas.js:2147 也会跳它，所以它是画布功能的一部分，不是旁支。
 * 从白名单页面出发解析 /static/... 引用（script/link/img、CSS url()、JS 里的写死路径 / fetch / import()），
 * 传递闭包 = 保留集；闭包外的页面与资源一律不拷贝。换上游 commit 后重跑，结果自动是裁剪后的。
 * 注意闭包可能**合法地**带进白名单之外的页面：上游 1e20abe51 起 smart-canvas.js 用 iframe 打开
 * /static/tools/lossless-edit/index.html（无损改图），该页因此进入保留集（第 4 个 HTML 页面），
 * 它的 PSD 导出依赖走 EXTRA_KEEP。这不是"白名单破了"，是依赖真的存在。
 *
 * 白名单外必须显式保留的（有页面/标签之外的引用方，脚本判不出来）：
 */
// 路径都相对 static/ 根（与 walk/computeKeepSet 的返回值同一坐标系）。
export const PAGE_WHITELIST = ["canvas-list.html", "canvas.html", "smart-canvas.html"];
export const EXTRA_KEEP = [
  // 无限画布的提示词模板数据：不在页面标签里，属于画布功能本身
  "system-prompts/infinite-canvas-prompt-templates.md",
  // 被 OpenArc 产品代码直接引用（src-vue/settings/providerLogos.ts:71）：不是画布页面，但删了设置页会缺图
  "images/RunningHub-B.png",
  "images/RunningHub-W.png",
  // 上游 vendor 目录的来源清单（无运行时引用），保留以便审计这份裁剪
  "vendor/MANIFEST.md",
  // 「智能画布 → 无损改图」工具页的 PSD 导出依赖（上游 1e20abe51 新增）。它是**运行时相对路径**
  // 加载：tools/lossless-edit/index.html 里 loadScript('vendor/ag-psd.js')，页面标签、CSS url()、
  // /static/ 字面量都看不见它 —— 正则判不出来，只有显式保留，否则"点导出 PSD 才 404"。
  "tools/lossless-edit/vendor/ag-psd.js",
];

/** 从一个文本文件里抽出它引用的 bundle 内路径（相对 static/ 根的 posix 路径）。 */
export function extractStaticRefs(text, rel) {
  const refs = new Set();
  for (const m of text.matchAll(/\/static\/[A-Za-z0-9_@./-]+/g)) {
    const p = m[0].slice("/static/".length).replace(/[?#].*$/, "").replace(/["'`)\].,;:]+$/, "");
    if (p) refs.add("static/" + p);
  }
  if (/\.html$/i.test(rel)) {
    for (const m of text.matchAll(/<(?:script|link|img|source|video|audio)[^>]*(?:src|href)="([^"]+)"/gi)) {
      const v = m[1].trim();
      if (!v || v.startsWith("/") || v.startsWith("#") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) continue;
      refs.add(path.posix.normalize(path.posix.join(path.posix.dirname(rel), v.replace(/[?#].*$/, ""))));
    }
    for (const m of text.matchAll(/url\((['"]?)([^)'"]+)\1\)/gi)) {
      const v = m[2].trim();
      if (!v || v.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) continue;
      refs.add(path.posix.normalize(path.posix.join(path.posix.dirname(rel), v.replace(/[?#].*$/, ""))));
    }
  }
  return [...refs];
}

/**
 * 从 root（上游 static/ 或已 vendor 的 bundle static/）算出保留集。
 * 返回 { all, keep, edges }；edges 记录"谁引用了谁"，写进 PRUNE.md 时可直接引用。
 */
export function computeKeepSet(root) {
  const all = walk(root).map((p) => p.split(path.sep).join("/"));
  const allSet = new Set(all);
  const keep = new Set();
  const queue = [];
  const edges = [];
  for (const p of PAGE_WHITELIST) {
    if (!allSet.has(p)) throw new Error("白名单页面在源里不存在：" + p);
    if (!keep.has(p)) { keep.add(p); queue.push(p); }
  }
  while (queue.length) {
    const rel = queue.shift();
    if (!/\.(html|js|css|json|md|mjs)$/i.test(rel)) continue;
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    for (const raw of extractStaticRefs(text, rel)) {
      const ref = raw.startsWith("static/") ? raw.slice("static/".length) : raw;
      if (!allSet.has(ref) || keep.has(ref)) continue;
      keep.add(ref);
      edges.push({ from: rel, to: ref });
      queue.push(ref);
    }
  }
  for (const extra of EXTRA_KEEP) {
    if (!allSet.has(extra)) throw new Error("必须保留的资源在源里不存在：" + extra);
    if (!keep.has(extra)) { keep.add(extra); edges.push({ from: "(policy)", to: extra }); }
  }
  return { all, keep, edges };
}

function injectAfterHead(html, snippet) {
  const m = html.match(/<head[^>]*>/i);
  if (!m) throw new Error("no <head>");
  const at = m.index + m[0].length;
  return html.slice(0, at) + "\n    " + snippet + html.slice(at);
}

function runVendor(resolved) {
  const git = readGitProvenance(resolved.srcRoot);
  // 不传 OA_NOVAI_SRC 时行为与之前逐字一致：只接受 SOURCE_COMMIT 的检出（非 git 的 tarball 照旧不校验）。
  if (!LOCAL_SRC && git && git.head !== SOURCE_COMMIT) throw new Error("源 commit 不符：" + git.head + " != " + SOURCE_COMMIT);
  if (!fs.existsSync(PATCH)) throw new Error("缺少适配层模板：" + PATCH);
  if (!fs.existsSync(MERGE)) throw new Error("缺少三方合并模板：" + MERGE);
  if (!fs.existsSync(AI_MARKS)) throw new Error("缺少 AI 标记模板：" + AI_MARKS);
  if (!fs.existsSync(GUARD)) throw new Error("缺少画布守卫脚本：" + GUARD);
  if (!fs.existsSync(MODAL)) throw new Error("缺少应用内模态脚本：" + MODAL);
  if (!fs.existsSync(SMART_GUARD)) throw new Error("缺少智能画布最小封堵模板：" + SMART_GUARD);
  const patchBlock = fs.readFileSync(PATCH, "utf8").trimEnd();
  const mergeBlock = fs.readFileSync(MERGE, "utf8").trimEnd();
  const aiMarksBlock = fs.readFileSync(AI_MARKS, "utf8").trimEnd();
  const smartGuardBlock = fs.readFileSync(SMART_GUARD, "utf8").trimEnd();

  // 1) 「只保留无限画布」：白名单页面 + 依赖闭包，只拷贝保留集（不是整棵 static/）
  const { all: sourceFiles, keep: keepSet, edges: keepEdges } = computeKeepSet(SRC_STATIC);
  const files = [...keepSet].sort();
  const fingerprint = contentFingerprint(SRC_STATIC, files);
  const provenance = {
    type: git ? "git" : "content",
    identity: git ? git.head : fingerprint.value,
    capturedAt: new Date().toISOString(),
    mode: LOCAL_SRC ? "local-source" : "pinned-github",
    requestedSrc: LOCAL_SRC || SRC,
    srcRoot: resolved.srcRoot,
    staticDir: SRC_STATIC,
    pinnedCommit: SOURCE_COMMIT,
    matchesPin: git ? git.head === SOURCE_COMMIT : null,
    git,
    contentFingerprint: fingerprint,
  };
  fs.rmSync(OUT_STATIC, { recursive: true, force: true });
  fs.mkdirSync(OUT_STATIC, { recursive: true });
  for (const rel of files) {
    const dst = path.join(OUT_STATIC, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(SRC_STATIC, rel), dst);
  }

  // 2) canvas.js：IIFE 末尾追加适配层（必须插在最后的 })(); 之前）
  const canvasJsPath = path.join(OUT_STATIC, "js", "canvas.js");
  let canvasJs = fs.readFileSync(canvasJsPath, "utf8");

  // 2b) canvas.js 上游补丁（幂等；目标缺失即报错，不静默跳过）——D1：
  //     saveCanvas() 真的跑起来之后必须清掉 saveTimer。上游只在 beforeunload 里清它，于是
  //     "定时器已经触发过一次"的句柄会一直留着；applyRemoteCanvasData() 的判空条件里含 saveTimer，
  //     恒真 ⇒ 宿主 / AI 对画布的改动永远只是延后 1s 重试，进不到**已经打开的编辑器**页面上
  //     （实测：同一页做过一次本地编辑/保存后，宿主新增的节点 20s 都不呈现）。
  const CANVAS_JS_PATCHES = [
    {
      name: "saveCanvas 清掉已触发的 saveTimer（D1）",
      from: "async function saveCanvas(){\n    if(!canvas || applyingRemoteCanvas) return;\n    if(savingCanvasNow){\n        saveCanvasAgain = true;\n        return;\n    }\n",
      to: "async function saveCanvas(){\n    if(!canvas || applyingRemoteCanvas) return;\n    if(savingCanvasNow){\n        saveCanvasAgain = true;\n        return;\n    }\n    // OpenArc：本次保存真的会发生；定时器已经触发过，句柄不清掉就会被 applyRemoteCanvasData()\n    // 当成「本地有未保存编辑」，远端（宿主 / AI / 其它页面）的改动永远只是延后重试。\n    if(saveTimer){ clearTimeout(saveTimer); saveTimer = null; }\n",
    },
    {
      name: "saveCanvas 记录本次真正发出去的文档（三方合并的 base 来源之一）",
      from: "    try {\n        const res = await fetch(`/api/canvases/${canvas.id}`, {",
      to: "    try {\n        // OpenArc：这份快照就是这次请求真正发出去的文档；服务端一旦接受，它就是页面新的共同祖先\n        // （三方合并的 base）。必须深拷贝 —— 页面之后是**原地改节点对象**的。\n        const oaSentDoc = JSON.parse(JSON.stringify({ title:canvas.title, icon:canvas.icon || '🧩', nodes:serializableCanvasNodes(), connections, viewport, logs:canvas.logs || [] }));\n        const res = await fetch(`/api/canvases/${canvas.id}`, {",
    },
    {
      name: "saveCanvas 保存成功时把已同步的那一版交给注入层",
      from: "        lastCanvasUpdatedAt = canvas.updated_at;\n        localCanvasDirty = Boolean(saveCanvasAgain);",
      to: "        lastCanvasUpdatedAt = canvas.updated_at;\n        localCanvasDirty = Boolean(saveCanvasAgain);\n        // OpenArc：服务端接受了 oaSentDoc ⇒ 它成为新的共同祖先。注意不是「现在的页面文档」：\n        // 保存期间可能又发生了本地编辑，那一部分还没同步。\n        if(window.__openarcCanvasSynced) window.__openarcCanvasSynced(oaSentDoc);",
    },
    {
      name: "saveCanvas 的 409 分支：三方合并（双方内容都保留），不再换基线重发旧文档",
      from: "        if(res.status === 409){\n            const data = await res.json().catch(() => ({}));\n            const remote = data.detail?.canvas || data.canvas;\n            if(localCanvasDirty || saveCanvasAgain){\n                lastCanvasUpdatedAt = Number(data.detail?.updated_at || data.updated_at || remote?.updated_at || lastCanvasUpdatedAt || 0);\n                saveCanvasAgain = true;\n                setStatus('Saving...');\n                return;\n            }\n            if(remote) applyRemoteCanvasData(remote);\n            setStatus('Synced');\n            return;\n        }",
      to: "        if(res.status === 409){\n            const data = await res.json().catch(() => ({}));\n            const remote = data.detail?.canvas || data.canvas;\n            const remoteAt = Number(data.detail?.updated_at || data.updated_at || remote?.updated_at || 0);\n            // OpenArc：与别处（宿主 / AI / 其它窗口）的改动做**三方合并** —— 两边内容都保留，只重发一次\n            // 合并结果。绝不「换上新基线后把这份基于旧 revision 的旧文档再发一遍」：那正是「用户在 500ms\n            // 待保存窗口里的编辑覆盖掉对方改动」的缺陷（第八 / 十 / 十一批实测）。\n            if(window.__openarcCanvasConflict){\n                const decision = await window.__openarcCanvasConflict(remote, remoteAt);\n                if(decision === 'retry'){ saveCanvasAgain = true; localCanvasDirty = true; setStatus('Saving...'); return; }\n                return;\n            }\n            if(localCanvasDirty || saveCanvasAgain){\n                lastCanvasUpdatedAt = remoteAt || lastCanvasUpdatedAt || 0;\n                saveCanvasAgain = true;\n                setStatus('Saving...');\n                return;\n            }\n            if(remote) applyRemoteCanvasData(remote);\n            setStatus('Synced');\n            return;\n        }",
    },
    {
      name: "apiImageSize 按比例对称求解并受档位像素上限约束（换上游 commit 重跑必须自动带上）",
      from: "function apiImageSize(ratioValue, resolutionValue, customRatioValue = '', customSizeValue = '', model = ''){\n    if(resolutionValue === 'auto') return 'auto';\n    const resolvedModel = resolveImageModel(model);\n    if(resolutionValue === 'custom'){\n        const custom = String(customSizeValue || '').trim();\n        return custom ? NovaSizePolicy.constrain(custom, resolvedModel) : custom;\n    }\n    const resolutionKey = resolutionValue || '1k';\n    if(ratioValue === 'custom' || ratioValue === 'source'){\n        const parsed = parseRatioValue(customRatioValue);\n        const longSide = RES_LONG_SIDE[resolutionKey] || 1024;\n        if(parsed){\n            const pixelLimit = resPixelLimitFor(resolvedModel)[resolutionKey] || (longSide * longSide);\n            const rawWidth = parsed >= 1 ? longSide : Math.min(longSide * parsed, Math.sqrt(pixelLimit * parsed));\n            const rawHeight = parsed >= 1 ? Math.min(longSide / parsed, Math.sqrt(pixelLimit / parsed)) : longSide;\n            const width = Math.floor(rawWidth / 16) * 16;\n            const height = Math.floor(rawHeight / 16) * 16;\n            return NovaSizePolicy.constrain(`${Math.max(64, width)}x${Math.max(64, height)}`, resolvedModel);\n        }\n    }\n    const ratioKey = ratioValue && SIZE_MAP[ratioValue] ? ratioValue : 'square';\n    const preset = SIZE_MAP[ratioKey]?.[resolutionKey] || SIZE_MAP.square[resolutionKey] || SIZE_MAP.square['1k'];\n    return NovaSizePolicy.constrain(preset, resolvedModel);\n}",
      to: "// OpenArc：任意比例 / 自定义比例都按「长边 + 该档像素上限」等比对称求解，与宿主 image-params.sizeFromRatio 同一口径。\n// 上游旧算法在 custom/source 分支只压一侧：1:1@1k 会算成 1536x1248（非方形）、4:3@1k 算成 1536x1072、\n// 1:1@4k 算成 3840x2880（超过该档像素上限）。具名比例沿用 SIZE_MAP 预设，只在预设自身超上限时等比收窄\n// （square@4k 的原生 4096x4096 收成 2880x2880），其余档位逐格不变。\nfunction fitApiSizePair(width, height, resolutionKey, model){\n    const longSide = RES_LONG_SIDE[resolutionKey] || 1024;\n    const pixelLimit = resPixelLimitFor(model)[resolutionKey] || (longSide * longSide);\n    let scale = 1;\n    if(longSide > 0) scale = Math.min(scale, longSide / Math.max(width, height));\n    if(pixelLimit > 0) scale = Math.min(scale, Math.sqrt(pixelLimit / (width * height)));\n    const w = Math.floor((width * scale) / 16) * 16;\n    const h = Math.floor((height * scale) / 16) * 16;\n    return `${Math.max(64, w)}x${Math.max(64, h)}`;\n}\nfunction apiImageSize(ratioValue, resolutionValue, customRatioValue = '', customSizeValue = '', model = ''){\n    if(resolutionValue === 'auto') return 'auto';\n    const resolvedModel = resolveImageModel(model);\n    if(resolutionValue === 'custom'){\n        const custom = String(customSizeValue || '').trim();\n        return custom ? NovaSizePolicy.constrain(custom, resolvedModel) : custom;\n    }\n    const resolutionKey = resolutionValue || '1k';\n    const longSide = RES_LONG_SIDE[resolutionKey] || 1024;\n    if(ratioValue === 'custom' || ratioValue === 'source'){\n        const parsed = parseRatioValue(customRatioValue);\n        if(parsed){\n            const width = parsed >= 1 ? longSide : longSide * parsed;\n            const height = parsed >= 1 ? longSide / parsed : longSide;\n            return NovaSizePolicy.constrain(fitApiSizePair(width, height, resolutionKey, resolvedModel), resolvedModel);\n        }\n    }\n    const ratioKey = ratioValue && SIZE_MAP[ratioValue] ? ratioValue : 'square';\n    const preset = SIZE_MAP[ratioKey]?.[resolutionKey] || SIZE_MAP.square[resolutionKey] || SIZE_MAP.square['1k'];\n    const presetPair = parseSizePair(preset);\n    if(!presetPair) return NovaSizePolicy.constrain(preset, resolvedModel);\n    return NovaSizePolicy.constrain(fitApiSizePair(presetPair.width, presetPair.height, resolutionKey, resolvedModel), resolvedModel);\n}",
    },
  ];
  canvasJs = applyPatches(canvasJs, CANVAS_JS_PATCHES, "canvas.js");

  const tail = "\n})();";
  const cut = canvasJs.lastIndexOf(tail);
  if (requireAnchor(cut >= 0, "变更2 · canvas.js IIFE 末尾注入 internals/merge/ai-marks", "找不到收尾 })();")) {
    // 顺序：两个纯函数模块在前（适配层在冲突处理里用 __openarcCanvasMerge，在标记/淡入里用 __openarcCanvasAiMarks）。
    fs.writeFileSync(canvasJsPath, canvasJs.slice(0, cut) + "\n" + mergeBlock + "\n" + aiMarksBlock + "\n" + patchBlock + canvasJs.slice(cut));
  }

  // 2c) smart-canvas.js 上游补丁（幂等；目标缺失即报错）：Electron 的 Chromium 不支持 window.prompt，
  //     智能画布的「提示词模板分组 新建/重命名」原本调用 window.prompt 会直接卡死在这里。
  //     改成应用内模态 window.__openarcPrompt（openarc-rename-modal.js，注入在同页 <head>）。
  const smartJsPath = path.join(OUT_STATIC, "js", "smart-canvas.js");
  let smartJs = fs.readFileSync(smartJsPath, "utf8");
  const SMART_CANVAS_JS_PATCHES = [
    {
      name: "智能画布 · 新建提示词模板分组：prompt() → 应用内模态",
      from: "    const name = window.prompt(tr('smart.tplNewGroupPrompt'), tr('smart.tplNewGroupDefault'));\n    if(!String(name || '').trim()) return;",
      to: "    /* OpenArc：Electron 不支持 window.prompt；改用应用内模态（openarc-rename-modal.js）。\n       空值 / 取消都不提交；模态负责 Esc、遮罩取消与结构化错误。 */\n    const name = await window.__openarcPrompt({\n        title: tr('smart.tplNewGroupPrompt'),\n        value: tr('smart.tplNewGroupDefault'),\n        maxLength: 24,\n        confirmText: tr('common.confirm'),\n        cancelText: tr('common.cancel')\n    });\n    if(!String(name || '').trim()) return;",
    },
    {
      name: "智能画布 · 重命名提示词模板分组：prompt() → 应用内模态",
      from: "    const name = window.prompt(tr('smart.tplGroupNamePrompt'), group.name || '');\n    if(!String(name || '').trim()) return;",
      to: "    /* OpenArc：同上，重命名走应用内模态；空值 / 取消都不提交。 */\n    const name = await window.__openarcPrompt({\n        title: tr('smart.tplGroupNamePrompt'),\n        value: group.name || '',\n        maxLength: 24,\n        confirmText: tr('common.confirm'),\n        cancelText: tr('common.cancel')\n    });\n    if(!String(name || '').trim()) return;",
    },
  ];
  smartJs = applyPatches(smartJs, SMART_CANVAS_JS_PATCHES, "smart-canvas.js");
  // 2d) 智能画布最小封堵（第 12 处改动）：内联在同一个 IIFE 的收尾之前。
  //     必须同域 —— 页面侧兜底（DEFAULT_VIDEO_MODELS / modelscopeImageModels / resolveChatModel
  //     的 gpt-4o-mini / initChatModel 的 gpt-4o-mini）都在闭包里，外部脚本够不到。
  //     V0.01 授权补齐：只读闸覆盖全部编辑路径（事件闸 + 173 个函数闸 + fetch 写闸），
  //     真机逐条用例见 experiments/dxos-canvas-scope/readonly-gate-probe.mjs。
  const smartTail = "\n})();";
  const smartCut = smartJs.lastIndexOf(smartTail);
  if (requireAnchor(smartCut >= 0, "变更12 · smart-canvas.js IIFE 末尾注入 smart-canvas-guard.js（最小封堵）", "找不到收尾 })();")) {
    smartJs = smartJs.slice(0, smartCut) + "\n" + smartGuardBlock + smartJs.slice(smartCut);
    fs.writeFileSync(smartJsPath, smartJs);
  }

  // 3) canvas-list.html（现在的产品入口）：三个"新建"入口**直接进编辑器**，不再弹上游那个
  //    "选画布" picker（它会变成挡在编辑器前面的一层选择遮挡层）。目标找不到就报错，不静默跳过。
  //    （第十五批）右下角回收站 FAB 显隐 —— 用户裁定：回收站为空 ⇒ 隐藏，有已删除画布 ⇒ 显示。
  //    事实只有一个：updateTrashBadge() 里的 v4DeletedCanvases.length —— 上游每次回收站变化都经过它
  //    （初始 loadTrash / 删除后 loadTrash / 恢复 / 彻底删除 / 清空 / 拦到 trash 响应），不新造第二套事实。
  //    .trash-fab 自带 display:flex 会盖过 [hidden] 的 UA 规则，所以补一条显式规则：真隐藏
  //    （不占布局、不进 tab 顺序、不接收点击），不是 CSS 遮挡。
  const listPath = path.join(OUT_STATIC, "canvas-list.html");
  let listHtml = fs.readFileSync(listPath, "utf8");
  const LIST_PATCHES = [
    // OpenArc（第 11 处改动）· 入口改向：经典编辑器已从入口下线，列表页所有打开编辑器的入口
    // 一律打开 smart-canvas.html（同一 id / project）：新建 / 继续上次 / 卡片点击 / 回收站恢复后进入都算。
    ["document.getElementById('btnStartCreate').addEventListener('click', openCanvasPicker);",
     "document.getElementById('btnStartCreate').addEventListener('click', () => createCanvasFromPicker('smart'));"],
    ["document.getElementById('btnNewProject').addEventListener('click', openCanvasPicker);",
     "document.getElementById('btnNewProject').addEventListener('click', () => createCanvasFromPicker('smart'));"],
    ["                } else {\n                    openCanvasPicker();\n                }",
     "                } else {\n                    createCanvasFromPicker('smart');\n                }"],
    // 卡片点击 / 继续上次 / 新建：全部改向智能画布（参数名不变，smart-canvas.js 读的就是 id / project）。
    ["            function openCanvas(c) {\n                const enc = encodeURIComponent(c.id);\n                const project = encodeURIComponent(c.project || 'default');\n                window.location.href = (c.kind === 'smart')\n                    ? `/static/smart-canvas.html?id=${enc}&project=${project}&t=1786289367`\n                    : `/static/canvas.html?id=${enc}&project=${project}&t=1786289367`;\n            }",
     "            function openCanvas(c) {\n                const enc = encodeURIComponent(c.id);\n                const project = encodeURIComponent(c.project || 'default');\n                // OpenArc：经典编辑器已从入口下线；所有画布一律进智能画布。\n                window.location.href = `/static/smart-canvas.html?id=${enc}&project=${project}&t=1786289367`;\n            }"],
    ["                closeCanvasPicker();\n                const isSmart = kind === 'smart';\n                const baseName = isSmart ? '智能画布' : '画布';",
     "                closeCanvasPicker();\n                // OpenArc：经典编辑器已从入口下线；不论调用方传什么，新建一律是智能画布。\n                const isSmart = true;\n                const baseName = '智能画布';"],
    ["                        window.location.href = (nc.kind === 'smart')\n                            ? `/static/smart-canvas.html?id=${enc}&project=${project}&t=1786289367`\n                            : `/static/canvas.html?id=${enc}&project=${project}&t=1786289367`;",
     "                        window.location.href = `/static/smart-canvas.html?id=${enc}&project=${project}&t=1786289367`;"],
    ["                    const project = encodeURIComponent(latest.project || 'default');\n                    window.location.href = (latest.kind === 'smart')\n                        ? `/static/smart-canvas.html?id=${enc}&project=${project}&t=1786289367`\n                        : `/static/canvas.html?id=${enc}&project=${project}&t=1786289367`;",
     "                    const project = encodeURIComponent(latest.project || 'default');\n                    // OpenArc：经典编辑器已从入口下线；继续上次一律进智能画布。\n                    window.location.href = `/static/smart-canvas.html?id=${enc}&project=${project}&t=1786289367`;"],
    ["            document.getElementById('pickerNormal').addEventListener('click', () => createCanvasFromPicker('classic'));",
     "            document.getElementById('pickerNormal').addEventListener('click', () => createCanvasFromPicker('smart'));"],
    // 重命名：Electron 的 Chromium 不支持 window.prompt（调用即 "prompt() is not supported"），
    // 卡片菜单的「重命名」原本走到这里就是死路。改成应用内模态（openarc-rename-modal.js，<head> 注入）。
    // 提交由模态负责：失败以「HTTP 状态 + 原因」在模态内结构化呈现，不再 alert + 静默 refreshAll。
    ["                    const newName = prompt('重命名画布', c.title);\n                    if (newName && newName.trim() !== '' && newName.trim() !== c.title) {\n                        renameCanvasAPI(c.id, newName.trim());\n                    }",
     "                    window.__openarcPrompt({\n                        title: '重命名画布', value: c.title, maxLength: 60,\n                        confirmText: '重命名', cancelText: '取消',\n                        onSubmit: function (name) { return renameCanvasAPI(c.id, name); }\n                    });"],
    // 空 ⇒ 隐藏：页面还没有回收站数据时按"空"呈现（与角标 style="display:none" 同一约定），
    // 之后由 loadTrash() 的响应决定是否显示。
    ['<button class="trash-fab" id="trashFab" title="回收站" aria-label="回收站">',
     '<button class="trash-fab" id="trashFab" title="回收站" aria-label="回收站" hidden>'],
    ["        .trash-fab svg { width: 20px; height: 20px; }",
     "        .trash-fab svg { width: 20px; height: 20px; }\n        .trash-fab[hidden] { display: none; }"],
    ["            const trashBadgeV4 = document.getElementById('trashBadgeV4');",
     "            const trashBadgeV4 = document.getElementById('trashBadgeV4');\n            const trashFab = document.getElementById('trashFab');"],
    ["            function updateTrashBadge() {\n                const count = v4DeletedCanvases.length;\n                trashBadgeV4.textContent = count;\n                trashBadgeV4.style.display = count > 0 ? '' : 'none';\n            }",
     "            function updateTrashBadge() {\n                const count = v4DeletedCanvases.length;\n                trashBadgeV4.textContent = count;\n                trashBadgeV4.style.display = count > 0 ? '' : 'none';\n                trashFab.hidden = count === 0;\n            }"],
    ["            async function renameCanvasAPI(cid, name) {\n                try {\n                    const res = await fetch(`/api/canvases/${encodeURIComponent(cid)}/meta`, {\n                        method: 'POST',\n                        headers: { 'Content-Type': 'application/json' },\n                        body: JSON.stringify({ title: name })\n                    });\n                    if (!res.ok) throw new Error('rename failed');\n                    const c = v4Canvases.find(x => x.id === cid);\n                    if (c) c.title = name;\n                    renderV4Cards();\n                } catch(e) { console.error(e); alert('重命名失败'); refreshAll(); }\n            }",
     "            async function renameCanvasAPI(cid, name) {\n                // OpenArc：失败必须把结构化原因交回调用方（模态内联提示），不再 alert + 静默 refreshAll。\n                const res = await fetch(`/api/canvases/${encodeURIComponent(cid)}/meta`, {\n                    method: 'POST',\n                    headers: { 'Content-Type': 'application/json' },\n                    body: JSON.stringify({ title: name })\n                });\n                if (!res.ok) {\n                    const detail = await res.json().catch(function () { return {}; });\n                    const err = new Error((detail && (detail.detail || detail.error)) || ('HTTP ' + res.status));\n                    err.status = res.status;\n                    throw err;\n                }\n                const c = v4Canvases.find(x => x.id === cid);\n                if (c) c.title = name;\n                renderV4Cards();\n            }"],
  ];
  listHtml = applyPatches(listHtml, LIST_PATCHES, "canvas-list.html");
  fs.writeFileSync(listPath, listHtml);

  // 4) 逐页注入 CSP + 桥；canvas.html 再注入适配层
  const injected = [];
  for (const rel of files.filter((f) => f.endsWith(".html"))) {
    const p = path.join(OUT_STATIC, rel);
    let html = fs.readFileSync(p, "utf8");
    let headOk = true;
    try { html = injectAfterHead(html, HEAD_INJECT); } catch { headOk = false; }
    requireAnchor(headOk, "变更1 · " + rel + " <head> 注入 CSP meta + openarc-bridge.js", "找不到 <head>");
    if (rel === "canvas.html") {
      const tag = /<script defer src="\/static\/js\/canvas\.js[^"]*"><\/script>/;
      if (requireAnchor(tag.test(html), "变更3 · canvas.html 注入 openarc-adapter.js + openarc-canvas-guard.js", "找不到 canvas.js 脚本标签")) {
        html = html.replace(tag, (m) => m + '\n    <script defer src="/openarc-adapter.js"></script>\n    <script defer src="/openarc-canvas-guard.js"></script>');
      }
    }
    // OpenArc 应用内模态输入：把上游的 window.prompt（Electron 不支持）换成页面内的输入模态。
    // 只注入两个产品页（列表 + 智能画布）：上游在这两页各有 prompt（重命名画布 / 模板分组新建与重命名）。
    // 插在桥之后：CSP meta + openarc-bridge.js 仍然是页面最先执行的两个东西。
    if (rel === "canvas-list.html" || rel === "smart-canvas.html") {
      const bridgeTag = '<script src="/openarc-bridge.js"></script>';
      if (requireAnchor(html.includes(bridgeTag), "变更11 · " + rel + " 注入 openarc-rename-modal.js", "找不到 openarc-bridge.js 注入点")) {
        html = html.replace(bridgeTag, bridgeTag + '\n    <script src="/openarc-rename-modal.js"></script>');
      }
    }
    fs.writeFileSync(p, html);
    injected.push(rel);
  }

  // 5) 非产品外壳（bundle 根 index.html = 上游 static/index.html 副本 + openarc-shell.js）**不再生成**：
  //    E4 边界测试已改到保留的产品页 static/canvas-list.html 造伪造帧，该外壳因此零引用。
  //    这里连旧残留一起清掉 —— 换上游 commit 重跑 vendor 也不会再把它拷回来。
  //    openarc-shell.js 原先只被这个外壳注入，外壳删掉后全仓零加载；本轮裁决删除该文件，
  //    vendor 也不再生成/保留它（清掉任何旧副本，防止"放回来"）。
  if (!DRY_RUN) {
    fs.rmSync(path.join(OUT, "index.html"), { force: true });
    fs.rmSync(path.join(OUT, "openarc-shell.js"), { force: true });
  }

  if (DRY_RUN) {
    printDryRunReport({ provenance, sourceFiles, files, keepSet, injected, sourceStatic: SRC_STATIC });
    return;
  }
  writeSourceProvenance(provenance);

  const manifest = {
    sourceCommit: git ? git.head : (LOCAL_SRC ? null : SOURCE_COMMIT),
    source: resolved.srcRoot,
    sourceProvenance: provenance,
    files: files.length,
    sourceFiles: sourceFiles.length,
    prunedFiles: sourceFiles.length - files.length,
    pages: injected.length,
    pageWhitelist: PAGE_WHITELIST,
    extraKeep: EXTRA_KEEP,
    keepEdges,
    entry: "static/canvas-list.html",
    canvasJsHash: sha256(fs.readFileSync(canvasJsPath, "utf8")),
    canvasHtmlHash: sha256(fs.readFileSync(path.join(OUT_STATIC, "canvas.html"), "utf8")),
    guardHash: sha256(fs.readFileSync(GUARD, "utf8")),
    modalHash: sha256(fs.readFileSync(MODAL, "utf8")),
    smartGuardHash: sha256(fs.readFileSync(SMART_GUARD, "utf8")),
    listHtmlHash: sha256(fs.readFileSync(listPath, "utf8")),
    csp: CSP,
  };
  fs.writeFileSync(path.join(here, "vendor", "vendor-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log("vendored " + files.length + "/" + sourceFiles.length + " files（裁剪掉 " + (sourceFiles.length - files.length) + "）/ " + injected.length + " pages → public/novai-canvas");
  // 固定 pin 路径保持原有的两行输出；本地源额外打印一行来源标识（方便记录抓取样本身份）。
  if (LOCAL_SRC) console.log("source provenance: " + JSON.stringify({ type: provenance.type, identity: provenance.identity, capturedAt: provenance.capturedAt, dirty: provenance.git ? provenance.git.dirty : null, matchesPin: provenance.matchesPin, contentFingerprint: provenance.contentFingerprint.value }));
  console.log(JSON.stringify(manifest, null, 2));
}

/** 干跑/落盘共用入口：解析源；干跑把写入重定向到临时目录，跑完删掉，仓库零变化。*/
function main() {
  const resolved = resolveStaticRoot();
  SRC_STATIC = resolved.staticDir;
  let dryRoot = null;
  if (DRY_RUN) {
    dryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oa-vendor-dry-"));
    OUT_STATIC = path.join(dryRoot, "static");
  }
  try {
    runVendor(resolved);
  } finally {
    if (dryRoot) fs.rmSync(dryRoot, { recursive: true, force: true });
  }
}

// 允许 experiments/dxos-canvas-prune 复用同一套白名单/闭包逻辑（import 时不执行 vendor）
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
