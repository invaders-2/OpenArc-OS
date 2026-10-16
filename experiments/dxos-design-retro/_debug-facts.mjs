#!/usr/bin/env node
/** 定点复核：协议设置详情 .pset-facts 的文字是否与相邻列重叠（高分辨率 clip 截图）。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as H from "./lib/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const OUT = path.join(ROOT, "artifacts", "dxos-design-retro", "probe-detail");
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(path.join(ROOT, "package.json"));
const chromium = require("@playwright/test").chromium;
const electronPath = require("electron");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-retro-detail-"));
const { child, browser, port } = await H.launchElectron({ ROOT, electronPath, chromium, userDataDir });
let page = null;
await H.waitFor(async () => {
  for (const p of browser.contexts().flatMap((c) => c.pages())) {
    if (!p.url().includes("vue.html")) continue;
    if (await p.evaluate(() => !!document.querySelector(".desktop")).catch(() => false)) { page = p; return true; }
  }
  return false;
}, 60000, 300);
await H.ensureSession(page);
const cdp = await browser.contexts()[0].newCDPSession(page);
await H.setViewport(cdp, { width: 1440, height: 900, dsf: 4 });
await H.openSettingsPane(page, "model");
await H.waitForSel(page, "[data-protocol-settings] .pset-facts", 15000);
await H.sleep(1200);

const facts = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("[data-protocol-settings-detail] .pset-facts .pset-fact")) {
    const r = el.getBoundingClientRect();
    const lab = el.querySelector(".set-lab");
    const val = el.querySelector(".set-val");
    const lr = lab ? lab.getBoundingClientRect() : null;
    const vr = val ? val.getBoundingClientRect() : null;
    const cs = getComputedStyle(el);
    out.push({
      text: (el.textContent || "").trim().slice(0, 40),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      labText: lab ? (lab.textContent || "").trim() : null,
      labRect: lr ? [Math.round(lr.x), Math.round(lr.y), Math.round(lr.width), Math.round(lr.height)] : null,
      valText: val ? (val.textContent || "").trim().slice(0, 40) : null,
      valRect: vr ? [Math.round(vr.x), Math.round(vr.y), Math.round(vr.width), Math.round(vr.height)] : null,
      display: cs.display, gridTemplateColumns: cs.gridTemplateColumns, gap: cs.gap, fontFamily: cs.fontFamily, fontSize: cs.fontSize,
      overlap: lr && vr ? Math.max(0, Math.min(lr.right, vr.right) - Math.max(lr.left, vr.left)) : null,
    });
  }
  return out;
});
fs.writeFileSync(path.join(OUT, "pset-facts.json"), JSON.stringify(facts, null, 2));
for (const f of facts) console.log(JSON.stringify(f));
const box = await page.evaluate(() => {
  const el = document.querySelector("[data-protocol-settings-detail] .pset-facts");
  const r = el.getBoundingClientRect();
  return { x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 };
});
const img = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 } });
fs.writeFileSync(path.join(OUT, "pset-facts-clip.png"), Buffer.from(img.data, "base64"));
console.log("CLIP", JSON.stringify(box));
console.log("FONTS", await page.evaluate(() => document.fonts ? document.fonts.status : "n/a"));

try { await browser.close(); } catch {}
await H.awaitExit(child, 8000);
try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
