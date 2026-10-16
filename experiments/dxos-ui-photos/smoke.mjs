import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writePng } from "./lib/pngwrite.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function waitFor(fn, timeoutMs, stepMs) {
  const step = stepMs || 200;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await fn()) return true; } catch (e) {}
    if (Date.now() >= deadline) return false;
    await sleep(step);
  }
}

const require = createRequire(path.join(ROOT, "package.json"));
const chromium = require("@playwright/test").chromium;
const electronPath = require("electron");

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-photos-smoke-"));
const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-photos-src-"));
for (let i = 0; i < 6; i += 1) {
  writePng(path.join(srcDir, "img-" + i + ".png"), 64, 48, (x, y) => [ (x * 4 + i * 40) % 256, (y * 5 + i * 20) % 256, (i * 30 + 60) % 256 ]);
}
fs.mkdirSync(path.join(srcDir, "sub"));
writePng(path.join(srcDir, "sub", "deep-1.png"), 40, 40, () => [200, 80, 40]);

const port = await freePort();
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.OA_UI = process.env.OA_UI || "react";
const child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
let err = "";
child.stderr.on("data", (d) => { err += String(d); });
console.log("userData:", userDataDir, "port:", port);
try {
  const ready = await waitFor(async () => { try { const r = await fetch("http://127.0.0.1:" + port + "/json/version"); return r.ok; } catch (e) { return false; } }, 60000, 300);
  console.log("cdp ready:", ready, ready ? "" : err.slice(-400));
  if (!ready) process.exit(2);
  const browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
  const ctx = browser.contexts()[0];
  console.log("pages:", ctx.pages().map((p) => p.url()));
  const page = ctx.pages().find((p) => p.url().indexOf("index.html") >= 0);
  if (!page) { console.log("no UI page"); process.exit(3); }
  const apiReady = await waitFor(async () => (await page.evaluate(() => !!window.openarc && document.readyState === "complete")), 45000, 300);
  console.log("openarc ready:", apiReady);
  const keys = await page.evaluate(() => Object.keys(window.openarc));
  console.log("bridge keys:", keys.length, JSON.stringify(keys));
  console.log("photos domains present:", ["photos","photocraft","appExchange"].map((k) => k + "=" + keys.includes(k)).join(", "));

  const init = await page.evaluate(async () => { try { return await window.openarc.identity.command({ type: "identity/initialize", identifier: "photos-probe@openarc.test", password: "Photos-probe-1", displayName: "照片探针" }); } catch (e) { return { threw: String(e) }; } });
  const login = await page.evaluate(async () => { try { return await window.openarc.identity.command({ type: "identity/login", identifier: "photos-probe@openarc.test", password: "Photos-probe-1" }); } catch (e) { return { threw: String(e) }; } });
  console.log("init.ok:", init && init.ok, "login.ok:", login && login.ok);
  await waitFor(async () => (await page.evaluate(() => (document.querySelector(".desktop") || {}).getAttribute ? document.querySelector(".desktop").getAttribute("data-identity-gate") : null)) === "ready", 20000, 200);

  const add = await page.evaluate(async (dir) => { try { return await window.openarc.photos.command({ command: "photos/sources/add", payload: { path: dir } }); } catch (e) { return { threw: String(e) }; } }, srcDir);
  console.log("sources/add:", JSON.stringify(add).slice(0, 400));

  const sl = await page.evaluate(async () => { try { return await window.openarc.photos.command({ command: "photos/sources/list", payload: { offset: 0, limit: 50 } }); } catch (e) { return { threw: String(e) }; } });
  console.log("sources/list keys:", sl && sl.value ? Object.keys(sl.value) : sl);
  console.log("sources/list sources:", sl && sl.value ? sl.value.sources.length : null, "folders:", sl && sl.value ? sl.value.folders.length : null, "items:", sl && sl.value ? sl.value.items.length : null, "total:", sl && sl.value ? sl.value.total : null);
  console.log("item sample:", sl && sl.value && sl.value.items[0] ? JSON.stringify(sl.value.items[0]) : null);
  if (sl && sl.value && sl.value.items[0]) {
    const thumb = await page.evaluate(async (id) => { try { return await window.openarc.photos.command({ command: "photos/sourceThumbnail", payload: { id, size: 256 } }); } catch (e) { return { threw: String(e) }; } }, sl.value.items[0].id);
    console.log("thumbnail:", JSON.stringify(thumb).slice(0, 200));
    const file = await page.evaluate(async (id) => { try { return await window.openarc.photos.command({ command: "photos/sourceFile", payload: { id } }); } catch (e) { return { threw: String(e) }; } }, sl.value.items[0].id);
    console.log("sourceFile:", JSON.stringify(file).slice(0, 200));
  }

  const health = await page.evaluate(async () => { try { return await window.openarc.photos.command({ command: "photos/health", payload: {} }); } catch (e) { return { threw: String(e) }; } });
  console.log("health:", JSON.stringify(health).slice(0, 600));

  const pngB64 = fs.readFileSync(path.join(srcDir, "img-0.png")).toString("base64");
  const pc = await page.evaluate(async (b64) => { try { return await window.openarc.photocraft.command({ command: "photocraft/projects/create", payload: { name: "探针项目", mime: "image/png", contentBase64: b64 } }); } catch (e) { return { threw: String(e) }; } }, pngB64);
  console.log("photocraft create:", JSON.stringify(pc).slice(0, 700));
  const pl = await page.evaluate(async () => { try { return await window.openarc.photocraft.command({ command: "photocraft/projects/list", payload: {} }); } catch (e) { return { threw: String(e) }; } });
  console.log("photocraft list:", JSON.stringify(pl).slice(0, 500));

  const ex = await page.evaluate(async () => { try { return await window.openarc.appExchange.command({ command: "appExchange/targets", payload: {} }); } catch (e) { return { threw: String(e) }; } });
  console.log("appExchange targets:", JSON.stringify(ex).slice(0, 600));

  // dock + window label
  const dock = await page.evaluate(() => Array.from(document.querySelectorAll(".dock-item[data-dock-id]")).map((e) => e.getAttribute("data-dock-id")));
  console.log("dock ids:", JSON.stringify(dock));
  await page.evaluate(() => { const el = document.querySelector('.dock-item[data-dock-id="photos"]'); if (el) el.click(); });
  await sleep(1500);
  const wins = await page.evaluate(() => Array.from(document.querySelectorAll("section.window")).map((w) => ({ label: w.getAttribute("aria-label"), photos: !!w.querySelector('[data-photos-app="1"]') })));
  console.log("windows:", JSON.stringify(wins));

  // screencast probe
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.enable");
  let frames = 0;
  cdp.on("Page.screencastFrame", async (f) => { frames += 1; try { await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch (e) {} });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 720, maxHeight: 450 });
  await sleep(1200);
  await cdp.send("Page.stopScreencast");
  console.log("screencast frames in 1.2s:", frames);

  try { await page.evaluate(() => window.close()); } catch (e) {}
  await waitFor(() => child.exitCode != null, 15000, 200);
  try { await browser.close(); } catch (e) {}
} catch (e) {
  console.log("SMOKE ERROR:", e && e.stack || e);
} finally {
  try { if (child.exitCode == null) child.kill("SIGKILL"); } catch (e) {}
  await sleep(500);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
  console.log("cleaned");
}
