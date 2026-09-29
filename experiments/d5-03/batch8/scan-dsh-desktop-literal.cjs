#!/usr/bin/env node
"use strict";
/* Batch8 1.3d: classify every char as comment | string | bare-code, then locate the literal
   "DSH Desktop" per LINE with its context. Comments are excluded from the verdict; bare-code
   and string-literal hits are both reported so the reader can judge. */
const fs = require("node:fs");
const path = require("node:path");
const BT = String.fromCharCode(96);
const NEEDLE = "DSH Desktop";

/* returns { lines: string[], kind: Uint8Array } kind: 0=bare code, 1=string, 2=comment */
function classify(file) {
  const src = fs.readFileSync(file, "utf8");
  const kind = new Uint8Array(src.length);
  let i = 0, state = "code";
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { kind[i] = 2; kind[i + 1] = 2; state = "line"; i += 2; continue; }
      if (c === "/" && n === "*") { kind[i] = 2; kind[i + 1] = 2; state = "block"; i += 2; continue; }
      if (c === "'" || c === '"' || c === BT) { kind[i] = 1; state = c === "'" ? "sq" : c === '"' ? "dq" : "tpl"; i++; continue; }
      kind[i] = 0; i++; continue;
    }
    if (state === "line") { kind[i] = 2; if (c === "\n") state = "code"; i++; continue; }
    if (state === "block") { kind[i] = 2; if (c === "*" && n === "/") { kind[i + 1] = 2; state = "code"; i += 2; continue; } i++; continue; }
    /* inside string */
    kind[i] = 1;
    if (c === "\\") { if (i + 1 < src.length) kind[i + 1] = 1; i += 2; continue; }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === BT)) state = "code";
    i++; continue;
  }
  return { src, kind, lines: src.split("\n") };
}

const SKIP = new Set(["node_modules", ".git", "dist", "artifacts", "build", ".vite"]);
function walk(dir, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}

const REPO = path.resolve(__dirname, "..", "..", "..");
const SCAN_EXT = /[.](cjs|mjs|js|ts|tsx|jsx|json|html)$/;
const files = walk(REPO, []).filter((f) => SCAN_EXT.test(f));
console.log("scanned files: " + files.length + "  (node_modules/.git/dist/artifacts/build excluded)");
console.log("");

const hits = [];
for (const f of files) {
  const { kind, lines } = classify(f);
  let offset = 0;
  for (let ln = 0; ln < lines.length; ln++) {
    const text = lines[ln];
    let from = 0;
    for (;;) {
      const at = text.indexOf(NEEDLE, from);
      if (at < 0) break;
      const abs = offset + at;
      const ctx = kind[abs] === 2 ? "comment" : kind[abs] === 1 ? "string-literal" : "BARE-CODE";
      hits.push({ file: path.relative(REPO, f), line: ln + 1, ctx, text: text.trim() });
      from = at + 1;
    }
    offset += text.length + 1;
  }
}

const byCtx = (c) => hits.filter((h) => h.ctx === c);
for (const ctx of ["comment", "string-literal", "BARE-CODE"]) {
  console.log("--- " + ctx + " (" + byCtx(ctx).length + ") ---");
  for (const h of byCtx(ctx)) console.log("  " + h.file + ":" + h.line + "  " + h.text);
  console.log("");
}

const productCode = hits.filter((h) => h.ctx !== "comment" && (h.file.startsWith("electron/") || h.file.startsWith("src/") || h.file.startsWith("../../")));
console.log("VERDICT_1_3d: non-comment hits inside PRODUCT code (electron/, src/): " + productCode.length);
console.log("  -> " + (productCode.length === 0 ? "PASS" : "FAIL " + JSON.stringify(productCode)));
console.log("");
console.log("non-comment hit files (all, incl. this batch's own evidence + contract test):");
console.log("  " + JSON.stringify([...new Set(hits.filter((h) => h.ctx !== "comment").map((h) => h.file))], null, 2));
