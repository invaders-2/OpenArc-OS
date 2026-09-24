/**
 * D5-02 Full-App · 上游 NOVAI 完整应用 vendor 脚本（唯一入口，可重复执行）。
 *
 * 用法：node experiments/d5-02/vendor-novai-app.mjs
 *   源：OA_NOVAI_SRC（默认 /tmp/novai-canvas-src），必须是 SOURCE_COMMIT 的干净检出。
 *   目标：public/novai-canvas/static/**（整棵 static/ 原样）+ public/novai-canvas/index.html（上游外壳副本，
 *   只留给宿主级边界测试；**产品入口是 static/canvas-list.html**，宿主 IFRAME_BASE 指向它）。
 *
 * 为什么**不改写 /static/ 路径**：自定义协议是 standard:true，根绝对 /static/x 会自然解析为
 * openarc-canvas://bundle/static/x。改写 14 个页面 + 动态注入 + 动态 import 的风险远大于原样服务。
 *
 * 对上游文件的改动只有四处（全部可审计、可重复生成）：
 *   1) 每个页面 head 注入 CSP meta + openarc-bridge.js（最先执行）；
 *   2) static/index.html 的副本（bundle 根 index.html）额外注入 openarc-shell.js（子页 → 外壳 → 宿主的中继）；
 *   3) static/js/canvas.js 末尾（IIFE 内）追加 OpenArc 适配层（experiments/d5-02/vendor/canvas-internals.js），
 *      static/canvas.html 在其后注入 openarc-adapter.js 与 openarc-canvas-guard.js（**只 canvas.html**：
 *      编辑器是唯一有供应商/模型下拉的页面）；
 *   4) static/canvas-list.html 的三个"新建"入口改成直接进编辑器（见下面 LIST_PATCHES，幂等且缺目标即报错）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SOURCE_COMMIT = "6ce1a64680b669b31c2ac3b32418b54decd404f2";
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const SRC = process.env.OA_NOVAI_SRC || "/tmp/novai-canvas-src";
const SRC_STATIC = path.join(SRC, "static");
const OUT = path.join(ROOT, "public", "novai-canvas");
const OUT_STATIC = path.join(OUT, "static");
const PATCH = path.join(here, "vendor", "canvas-internals.js");
/** D5-02 供应商/模型单一真源守卫：只注入编辑器页，在 canvas.js / openarc-adapter.js 之后执行。*/
const GUARD = path.join(OUT, "openarc-canvas-guard.js");

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

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

function injectAfterHead(html, snippet) {
  const m = html.match(/<head[^>]*>/i);
  if (!m) throw new Error("no <head>");
  const at = m.index + m[0].length;
  return html.slice(0, at) + "\n    " + snippet + html.slice(at);
}

function main() {
  if (!fs.existsSync(SRC_STATIC)) throw new Error("源 static/ 不存在：" + SRC_STATIC);
  let head = "";
  try { head = execFileSync("git", ["-C", SRC, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* 非 git 检出 */ }
  if (head && head !== SOURCE_COMMIT) throw new Error("源 commit 不符：" + head + " != " + SOURCE_COMMIT);
  if (!fs.existsSync(PATCH)) throw new Error("缺少适配层模板：" + PATCH);
  if (!fs.existsSync(GUARD)) throw new Error("缺少画布守卫脚本：" + GUARD);
  const patchBlock = fs.readFileSync(PATCH, "utf8").trimEnd();

  // 1) 原样拷贝整棵 static/
  fs.rmSync(OUT_STATIC, { recursive: true, force: true });
  fs.mkdirSync(OUT_STATIC, { recursive: true });
  const files = walk(SRC_STATIC);
  for (const rel of files) {
    const dst = path.join(OUT_STATIC, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(SRC_STATIC, rel), dst);
  }

  // 2) canvas.js：IIFE 末尾追加适配层（必须插在最后的 })(); 之前）
  const canvasJsPath = path.join(OUT_STATIC, "js", "canvas.js");
  const canvasJs = fs.readFileSync(canvasJsPath, "utf8");
  const tail = "\n})();";
  const cut = canvasJs.lastIndexOf(tail);
  if (cut < 0) throw new Error("canvas.js 结构不符合预期（找不到收尾 IIFE）");
  fs.writeFileSync(canvasJsPath, canvasJs.slice(0, cut) + "\n" + patchBlock + canvasJs.slice(cut));

  // 3) canvas-list.html（现在的产品入口）：三个"新建"入口**直接进编辑器**，不再弹上游那个
  //    "选画布" picker（它会变成挡在编辑器前面的一层选择遮挡层）。目标找不到就报错，不静默跳过。
  const listPath = path.join(OUT_STATIC, "canvas-list.html");
  let listHtml = fs.readFileSync(listPath, "utf8");
  const LIST_PATCHES = [
    ["document.getElementById('btnStartCreate').addEventListener('click', openCanvasPicker);",
     "document.getElementById('btnStartCreate').addEventListener('click', () => createCanvasFromPicker('classic'));"],
    ["document.getElementById('btnNewProject').addEventListener('click', openCanvasPicker);",
     "document.getElementById('btnNewProject').addEventListener('click', () => createCanvasFromPicker('classic'));"],
    ["                } else {\n                    openCanvasPicker();\n                }",
     "                } else {\n                    createCanvasFromPicker('classic');\n                }"],
  ];
  for (const [from, to] of LIST_PATCHES) {
    if (listHtml.includes(to)) continue;                                  // 已经打过：幂等
    if (!listHtml.includes(from)) throw new Error("canvas-list.html 补丁目标缺失（上游结构变了）：" + from.slice(0, 70));
    listHtml = listHtml.replace(from, to);
  }
  fs.writeFileSync(listPath, listHtml);

  // 4) 逐页注入 CSP + 桥；canvas.html 再注入适配层
  const injected = [];
  for (const rel of files.filter((f) => f.endsWith(".html"))) {
    const p = path.join(OUT_STATIC, rel);
    let html = fs.readFileSync(p, "utf8");
    html = injectAfterHead(html, HEAD_INJECT);
    if (rel === "canvas.html") {
      const tag = /<script defer src="\/static\/js\/canvas\.js[^"]*"><\/script>/;
      if (!tag.test(html)) throw new Error("canvas.html 找不到 canvas.js 脚本标签");
      html = html.replace(tag, (m) => m + '\n    <script defer src="/openarc-adapter.js"></script>\n    <script defer src="/openarc-canvas-guard.js"></script>');
    }
    fs.writeFileSync(p, html);
    injected.push(rel);
  }

  // 5) 上游外壳副本：static/index.html 放在 bundle 根（根绝对 /static/ 仍解析到同一份资源）
  let shell = fs.readFileSync(path.join(OUT_STATIC, "index.html"), "utf8");
  const bridgeTag = '<script src="/openarc-bridge.js"></script>';
  if (!shell.includes(bridgeTag)) throw new Error("入口页缺少宿主桥注入");
  shell = shell.replace(bridgeTag, bridgeTag + '\n    <script src="/openarc-shell.js"></script>');
  fs.writeFileSync(path.join(OUT, "index.html"), shell);

  const manifest = {
    sourceCommit: SOURCE_COMMIT,
    source: SRC,
    files: files.length,
    pages: injected.length,
    entry: "index.html",
    entryShellHash: sha256(shell),
    canvasJsHash: sha256(fs.readFileSync(canvasJsPath, "utf8")),
    canvasHtmlHash: sha256(fs.readFileSync(path.join(OUT_STATIC, "canvas.html"), "utf8")),
    guardHash: sha256(fs.readFileSync(GUARD, "utf8")),
    listHtmlHash: sha256(fs.readFileSync(listPath, "utf8")),
    csp: CSP,
  };
  fs.writeFileSync(path.join(here, "vendor", "vendor-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log("vendored " + files.length + " files / " + injected.length + " pages → public/novai-canvas");
  console.log(JSON.stringify(manifest, null, 2));
}

main();
