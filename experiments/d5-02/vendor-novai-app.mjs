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
 * 对上游文件的改动（全部可审计、可重复生成；补丁幂等、目标缺失即报错、可反复重跑）：
 *   1) 每个页面 head 注入 CSP meta + openarc-bridge.js（最先执行）；
 *   2) static/index.html 的副本（bundle 根 index.html）额外注入 openarc-shell.js（子页 → 外壳 → 宿主的中继）；
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
/** 保存冲突的三方合并（纯函数）：内联进 canvas.js 的同一个 IIFE，Node 单测 require 同一份文本。*/
const MERGE = path.join(here, "vendor", "canvas-merge.js");
/** AI 新增节点的来源标记 / 入场去重（纯函数）：同样内联进 canvas.js，Node 单测 require 同一份文本。*/
const AI_MARKS = path.join(here, "vendor", "canvas-ai-marks.js");
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
  if (!fs.existsSync(MERGE)) throw new Error("缺少三方合并模板：" + MERGE);
  if (!fs.existsSync(AI_MARKS)) throw new Error("缺少 AI 标记模板：" + AI_MARKS);
  if (!fs.existsSync(GUARD)) throw new Error("缺少画布守卫脚本：" + GUARD);
  const patchBlock = fs.readFileSync(PATCH, "utf8").trimEnd();
  const mergeBlock = fs.readFileSync(MERGE, "utf8").trimEnd();
  const aiMarksBlock = fs.readFileSync(AI_MARKS, "utf8").trimEnd();

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
  ];
  for (const p of CANVAS_JS_PATCHES) {
    if (canvasJs.includes(p.to)) continue;                                  // 已经打过：幂等
    if (!canvasJs.includes(p.from)) throw new Error("canvas.js 补丁目标缺失（上游结构变了）：" + p.name);
    canvasJs = canvasJs.replace(p.from, p.to);
  }

  const tail = "\n})();";
  const cut = canvasJs.lastIndexOf(tail);
  if (cut < 0) throw new Error("canvas.js 结构不符合预期（找不到收尾 IIFE）");
  // 顺序：两个纯函数模块在前（适配层在冲突处理里用 __openarcCanvasMerge，在标记/淡入里用 __openarcCanvasAiMarks）。
  fs.writeFileSync(canvasJsPath, canvasJs.slice(0, cut) + "\n" + mergeBlock + "\n" + aiMarksBlock + "\n" + patchBlock + canvasJs.slice(cut));

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
