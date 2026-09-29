#!/usr/bin/env node
"use strict";
/* Batch8: secret scan over the batch's changed/new artifacts. Prints MASKED matches only. */
const fs = require("node:fs");
const path = require("node:path");
const REPO = path.resolve(__dirname, "..", "..", "..");

const PATTERNS = [
  ["sk- token",            /sk-[A-Za-z0-9_\-]{16,}/g],
  ["Bearer header",        /Bearer\s+[A-Za-z0-9._\-]{12,}/g],
  ["api_key assignment",   /api[_-]?key\s*["']?\s*[:=]\s*["'][^"']{12,}["']/gi],
  ["ANTHROPIC_API_KEY=",   /ANTHROPIC_API_KEY\s*=\s*\S{8,}/g],
  ["OPENAI_API_KEY=",      /OPENAI_API_KEY\s*=\s*\S{8,}/g],
  ["DEEPSEEK_API_KEY=",    /DEEPSEEK_API_KEY\s*=\s*\S{8,}/g],
  ["x-api-key header",     /x-api-key["']?\s*[:=]\s*["'][^"']{12,}["']/gi],
  ["private key block",    /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["AWS secret",           /aws_secret_access_key\s*[:=]\s*["'][^"']{16,}["']/gi],
  ["gateway key (sk-...)", /["'](sk|pk)-[A-Za-z0-9]{20,}["']/g],
];
const MASK = (s) => s.slice(0, 6) + "…<redacted " + s.length + " chars>";

function walk(p, acc) {
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const e of fs.readdirSync(p)) walk(path.join(p, e), acc); }
  else acc.push(p);
  return acc;
}

const TARGETS = [
  path.join(REPO, "experiments", "d5-03"),
  path.join(REPO, "tests", "d5-03-dsh-runtime-pin.test.mjs"),
  path.join(REPO, "package.json"),
  path.join(REPO, "package-lock.json"),
];

/* the scanner's own source + its own output contain the PATTERNS literals; exclude them so the
   verdict reflects real artifacts, not regex self-matches */
const EXCLUDE = new Set([
  path.join(REPO, "experiments", "d5-03", "batch8", "scan-secrets.cjs"),
  path.join(REPO, "experiments", "d5-03", "batch8", "16-secret-scan.txt"),
]);
const files = [];
for (const t of TARGETS) { if (fs.existsSync(t)) walk(t, files); }
for (let i = files.length - 1; i >= 0; i--) if (EXCLUDE.has(files[i])) files.splice(i, 1);
console.log("targets scanned:");
for (const t of TARGETS) console.log("  " + path.relative(REPO, t) + "  exists=" + fs.existsSync(t));
console.log("files scanned: " + files.length);
console.log("");

let total = 0;
for (const f of files) {
  let txt;
  try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
  for (const [name, re] of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(txt)) !== null) {
      total++;
      const before = txt.slice(0, m.index);
      const line = before.split("\n").length;
      console.log("HIT  " + path.relative(REPO, f) + ":" + line + "  [" + name + "]  " + MASK(m[0]));
      if (m[0].length === 0) break;
    }
  }
}
console.log("");
console.log("TOTAL raw secret-pattern hits: " + total);
console.log(total === 0 ? "VERDICT: CLEAN" : "VERDICT: REVIEW REQUIRED (see masked hits above)");
console.log("");

console.log("--- credential-named files anywhere in repo (excl. node_modules) ---");
const found = [];
(function findCred(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findCred(p);
    else if (/credential|secret|\.env/i.test(e.name)) found.push(path.relative(REPO, p));
  }
})(REPO);
console.log(found.length ? found.map((f) => "  " + f).join("\n") : "  (none)");
