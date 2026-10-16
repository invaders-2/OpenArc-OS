/**
 * 探针：在 `img-src openarc-canvas: data: blob:` 的 CSP 下，各种"不可用"占位 src 会不会产生
 * console error / CSP 违规样本。只读实验，用来决定 CanvasHost 对"读不出来的资源引用"该放什么值。
 */
import http from "node:http";
import { chromium } from "playwright";
import { resolveChromium, describeChromiumCandidates } from "../lib/chromium.mjs";

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src openarc-canvas: data: blob:; media-src openarc-canvas: data: blob:;";

const CASES = [
  ["empty", ""],
  ["unknown-scheme-openarc-asset", "openarc-asset:res_0Q1ztl1yugZPiPdOeb3eGIDBixfbANZ6"],
  ["unknown-scheme-openarc-missing", "openarc-missing:res_0Q1ztl1yugZPiPdOeb3eGIDBixfbANZ6"],
  ["data-text", "data:text/plain,missing"],
  ["data-octet", "data:application/octet-stream;base64,AAAA"],
  ["data-vnd", "data:application/vnd.openarc.missing%2Bjson;base64,eyJyZWYiOiJyZXNfMCJ9"],
  ["bundle-404", "openarc-canvas://bundle/static/images/__openarc_missing__/res_0.png"],
];

const html = (src) => `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}"></head>
<body><img id="x" src="${src}"></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const i = Number(u.searchParams.get("i") || 0);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html(CASES[i][1]));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const resolved = resolveChromium();
if (!resolved.path) { console.error("no chromium: " + describeChromiumCandidates(resolved.candidates)); process.exit(1); }
const browser = await chromium.launch({ headless: true, executablePath: resolved.path });
const page = await browser.newPage();
const out = [];
for (let i = 0; i < CASES.length; i += 1) {
  const errors = [];
  const failed = [];
  const onConsole = (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); };
  const onFailed = (rq) => failed.push(String(rq.url()).slice(0, 120) + " :: " + String(rq.failure() && rq.failure().errorText));
  page.on("console", onConsole);
  page.on("requestfailed", onFailed);
  await page.goto("http://127.0.0.1:" + port + "/?i=" + i);
  await page.waitForTimeout(700);
  const state = await page.evaluate(() => { const im = document.getElementById("x"); return { src: im.getAttribute("src"), complete: im.complete, naturalWidth: im.naturalWidth, naturalHeight: im.naturalHeight }; });
  page.off("console", onConsole);
  page.off("requestfailed", onFailed);
  out.push({ case: CASES[i][0], state, consoleErrors: errors, requestFailed: failed });
}
await browser.close();
server.close();
console.log(JSON.stringify(out, null, 2));
