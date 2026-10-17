#!/usr/bin/env node
/**
 * DXOS-CANVAS-REVENDOR-NEXT · apiImageSize 处置证据（只读，跑完写 artifacts/）。
 *
 * 问题：上游 22feb298 重写了 apiImageSize（长边定档 + 等比 + NovaSizePolicy.constrain），
 * 旧 OpenArc 补丁的 from 失配。决定「删补丁」还是「在新锚点重写」，只看一个事实：
 * 上游新实现在真机策略表下是否满足既有口径（1:1@1k → 1248x1248、4K 方图 → 2048x2048
 * 或 2880x2880、custom 比例对称且不超档位像素上限）。
 *
 * 做法：同一份真实策略表（electron/image-params.cjs）下，分别执行
 *   A. 上游新源码里的 apiImageSize（未打补丁）
 *   B. 本包 vendor 后页面里的 apiImageSize（新锚点补丁）
 * 对照宿主 image-params.sizeFromRatio。任一处不一致都打印出来。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const LOCAL_SRC = process.env.OA_NOVAI_SRC || "/Users/wepingli/Desktop/NOVAI-Infinite-Canvas-main";
const imageParams = require(path.join(ROOT, "electron/image-params.cjs"));

function resolveStaticRoot() {
  const direct = path.join(LOCAL_SRC, "static");
  if (fs.existsSync(direct)) return direct;
  for (const e of fs.readdirSync(LOCAL_SRC, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const sub = path.join(LOCAL_SRC, e.name, "static");
    if (fs.existsSync(path.join(sub, "canvas-list.html"))) return sub;
  }
  throw new Error("找不到源 static/：" + LOCAL_SRC);
}
const SRC_STATIC = resolveStaticRoot();
const SIZE_POLICY_SOURCE = fs.readFileSync(path.join(ROOT, "public/novai-canvas/static/js/shared/size-policy.js"), "utf8");

/** 与测试同一份策略表：gpt 家族 + 普通模型。*/
const POLICY_TABLE = imageParams.buildSizePolicyTable([
  { key: "gpt-image-2", model: "gpt-image-2" },
  { key: "flux-pro", model: "flux-pro" },
]);

function extractFunction(srcText, name) {
  const re = new RegExp("(?:^|\\n)(?:async\\s+)?function\\s+" + name + "\\s*\\(");
  const m = re.exec(srcText);
  if (!m) throw new Error("找不到函数 " + name);
  const start = m.index + (m[0][0] === "\n" ? 1 : 0);
  let depth = 0;
  let i = srcText.indexOf("{", start);
  for (; i < srcText.length; i += 1) {
    if (srcText[i] === "{") depth += 1;
    else if (srcText[i] === "}") { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return srcText.slice(start, i);
}
function extractConst(srcText, name) {
  const idx = srcText.indexOf("const " + name + " ");
  if (idx < 0) throw new Error("找不到常量 " + name);
  let depth = 0;
  let i = srcText.indexOf("=", idx);
  for (; i < srcText.length; i += 1) {
    const c = srcText[i];
    if (c === "{" || c === "[" || c === "(") depth += 1;
    else if (c === "}" || c === "]" || c === ")") depth -= 1;
    else if (c === ";" && depth === 0) { i += 1; break; }
  }
  return srcText.slice(idx, i);
}

async function load(pageJs, patched) {
  const names = ["parseRatioValue", "resPixelLimitFor", "apiImageSize"];
  if (patched) names.push("parseSizePair", "fitApiSizePair", "oaTierFit");
  const code = [
    extractConst(pageJs, "SIZE_MAP"),
    extractConst(pageJs, "API_RES_LEVELS"),
    extractConst(pageJs, "RES_LONG_SIDE"),
    extractConst(pageJs, "RES_PIXEL_LIMIT_FALLBACK"),
    ...names.map((n) => extractFunction(pageJs, n)),
    "window.__apiImageSize = apiImageSize;",
  ].join("\n");
  const sandbox = { window: {}, fetch: async () => ({ ok: true, json: async () => POLICY_TABLE }) };
  vm.createContext(sandbox);
  vm.runInContext(SIZE_POLICY_SOURCE, sandbox, { filename: "size-policy.js" });
  await sandbox.window.NovaSizePolicy.load();
  sandbox.NovaSizePolicy = sandbox.window.NovaSizePolicy;
  sandbox.parseSizeValue = (value) => {
    const m = /^(\d+)\s*[xX*]\s*(\d+)$/.exec(String(value || "").trim());
    return m ? { width: m[1], height: m[2] } : null;
  };
  sandbox.modelTierPixelFor = () => "";
  vm.runInContext(code, sandbox, { filename: patched ? "patched-smart-canvas.js" : "upstream-smart-canvas.js" });
  return sandbox.window.__apiImageSize;
}

const upstreamJs = fs.readFileSync(path.join(SRC_STATIC, "js", "smart-canvas.js"), "utf8");
const patchedJs = fs.readFileSync(path.join(ROOT, "public/novai-canvas/static/js/smart-canvas.js"), "utf8");
const upstream = await load(upstreamJs, false);
const patched = await load(patchedJs, true);

const CASES = [
  { label: "custom 1:1 @1k", args: ["custom", "1k", "1:1", "", "flux-pro"], host: imageParams.sizeFromRatio(1, "1k") },
  { label: "custom 4:3 @1k", args: ["custom", "1k", "4:3", "", "flux-pro"], host: imageParams.sizeFromRatio(4 / 3, "1k") },
  { label: "custom 1:1 @4k", args: ["custom", "4k", "1:1", "", "flux-pro"], host: imageParams.sizeFromRatio(1, "4k") },
  { label: "custom 3:2 @4k", args: ["custom", "4k", "3:2", "", "flux-pro"], host: imageParams.sizeFromRatio(1.5, "4k") },
  { label: "square @4k / free", args: ["square", "4k", "", "", "flux-pro"], host: imageParams.sizeFromRatio(1, "4k") },
  { label: "ultrawide @1k / free", args: ["ultrawide", "1k", "", "", "flux-pro"], host: null },
  { label: "square @4k / gpt-image-2（enum）", args: ["square", "4k", "", "", "gpt-image-2"], host: "2048x2048" },
];
const rows = CASES.map((c) => {
  const up = upstream(...c.args);
  const pa = patched(...c.args);
  return { label: c.label, upstream: up, patched: pa, host: c.host, upstreamMatchesHost: c.host == null ? null : up === c.host, patchedMatchesHost: c.host == null ? null : pa === c.host, changed: up !== pa };
});

const outDir = path.join(ROOT, "artifacts", "dxos-canvas-revendor-next");
fs.mkdirSync(outDir, { recursive: true });
const result = {
  capturedAt: new Date().toISOString(),
  sourceStatic: SRC_STATIC,
  decision: "rewrite-at-new-anchor",
  reason: "上游只做长边定档+等比；default（free）策略 maxPixels=0，档位像素上限没有收口。custom 1:1@1k 仍是 1536x1536、custom 1:1@4k 仍是 3840x3840，与宿主 sizeFromRatio（1248x1248 / 2880x2880）不一致。",
  rows,
};
fs.writeFileSync(path.join(outDir, "api-size-evidence.json"), JSON.stringify(result, null, 2) + "\n");
console.log("=== apiImageSize 处置证据（真实策略表）===");
for (const r of rows) console.log([r.label, "upstream=" + r.upstream, "patched=" + r.patched, "host=" + (r.host || "-")].join("  |  "));
console.log("");
console.log("DECISION: " + result.decision);
console.log("REASON: " + result.reason);
