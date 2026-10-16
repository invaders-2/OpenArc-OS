/**
 * 窄窗布局实测（诊断脚本，不产出交付报告）：在 820 / 1180 视图下打开图库与图像工坊，
 * 打印 .split-side / .split-main / .photos-* 各层的包围盒，以及「子元素右缘超出父容器
 * 或超出视口」的叶子元素，用来解释截图里看到的压叠/裁切。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as H from "./lib/harness.mjs";
import { writePng } from "./lib/pngwrite.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const require = createRequire(path.join(ROOT, "package.json"));
const chromium = require("@playwright/test").chromium;
const electronPath = require("electron");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-photos-measure-"));
const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-photos-measure-src-"));
for (let i = 0; i < 6; i += 1) writePng(path.join(srcDir, "img-0" + i + ".png"), 96, 72, (x, y) => [x * 4, y * 5, (i * 37) % 256]);
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.OA_UI = "react";
let launched = null;
try {
  launched = await H.launchElectron({ ROOT, electronPath, chromium, userDataDir, env });
  const context = launched.browser.contexts()[0];
  await H.waitFor(() => !!context.pages().find((p) => /index\.html/.test(p.url())), 30000, 300);
  const page = context.pages().find((p) => /index\.html/.test(p.url()));
  await H.waitFor(async () => (await page.evaluate(() => document.readyState)) === "complete", 30000, 300);
  await page.evaluate(async () => { try { await window.openarc.identity.command({ type: "identity/initialize", identifier: "measure@openarc.test", password: "Measure-pass-1", displayName: "窄窗实测" }); } catch (e) {} });
  await page.evaluate(async () => { try { await window.openarc.identity.command({ type: "identity/login", identifier: "measure@openarc.test", password: "Measure-pass-1" }); } catch (e) {} });
  await H.waitFor(async () => (await page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") : null; })) === "ready", 20000, 200);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.enable");
  await H.clickSelector(page, '.dock-item[data-dock-id="photos"]');
  await H.waitFor(() => page.$(H.APP_SEL), 15000, 200);
  const winLabel = await page.evaluate((sel) => { const a = document.querySelector(sel); const w = a && a.closest("section.window"); return w ? w.getAttribute("aria-label") : null; }, H.APP_SEL);
  const winSel = H.windowSelector(winLabel);
  await page.evaluate(async (dir) => { try { await window.openarc.photos.command({ command: "photos/sources/add", payload: { path: dir } }); } catch (e) {} }, srcDir);
  await page.evaluate(async () => { try { await window.openarc.photocraft.command({ command: "photocraft/projects/create", payload: { name: "窄窗项目" } }); } catch (e) {} });
  const report = [];
  for (const size of [{ id: "1180", width: 1180, height: 900, dsf: 2 }, { id: "820", width: 820, height: 720, dsf: 2 }]) {
    await H.setViewport(page, cdp, size, winSel, 38);
    for (const view of ["library", "studio"]) {
      await H.clickText(page, H.APP_SEL, view === "studio" ? "图像工坊" : "图库", ".split-nav");
      await H.sleep(400);
      if (view === "studio") { await page.evaluate((sel) => { const p = document.querySelector(sel + " .photos-project"); if (p) p.click(); }, H.APP_SEL); await H.sleep(400); }
      const data = await page.evaluate((arg) => {
        const app = document.querySelector(arg.app);
        const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), Math.round(r.right)]; };
        const names = [".split-side", ".split-main", ".photos-view", ".photos-lib", ".photos-studio"];
        const layers = {};
        for (const n of names) layers[n] = rectOf(app.closest(".split") ? app.closest(".split").querySelector(n) : null);
        const root = app.querySelector(".photos-lib") || app.querySelector(".photos-studio");
        const rootName = app.querySelector(".photos-lib") ? ".photos-lib" : ".photos-studio";
        const gridCols = root ? getComputedStyle(root).gridTemplateColumns : null;
        const overflowY = root ? getComputedStyle(root).overflowY : null;
        const paneOverflow = root ? Array.prototype.slice.call(root.children).map((el) => { const cs = getComputedStyle(el); return { cls: String(el.className).slice(0, 40), overflowY: cs.overflowY, overflowX: cs.overflowX, maxHeight: cs.maxHeight, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, cutY: el.scrollHeight - el.clientHeight }; }) : [];
        const panes = root ? Array.prototype.slice.call(root.children).map((el, i) => ({ i: i, cls: String(el.className), rect: rectOf(el) })) : [];
        /* 内容越出自身 pane：叶子元素右缘 > 所属 pane 右缘 + 1.5 */
        const overflows = [];
        if (root) {
          for (let i = 0; i < root.children.length; i += 1) {
            const pane = root.children[i];
            const pr = pane.getBoundingClientRect();
            const leaves = pane.querySelectorAll("*");
            for (const el of leaves) {
              if (el.children.length) continue;
              const r = el.getBoundingClientRect();
              if (r.width <= 0) continue;
              let scrollable = false;
              let p = el.parentElement;
              while (p && p !== pane.parentElement) {
                const cs = getComputedStyle(p);
                if (cs.overflowY === "auto" || cs.overflowY === "scroll" || cs.overflowX === "auto" || cs.overflowX === "scroll") { scrollable = true; break; }
                p = p.parentElement;
              }
              if (r.right > pr.right + 1.5 || r.left < pr.left - 1.5 || r.bottom > pr.bottom + 1.5 || r.top < pr.top - 1.5) {
                overflows.push({ pane: i, scrollableInsidePane: scrollable, tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 40), text: (el.textContent || "").trim().slice(0, 24), right: Math.round(r.right), paneRight: Math.round(pr.right), left: Math.round(r.left), paneLeft: Math.round(pr.left), bottom: Math.round(r.bottom), paneBottom: Math.round(pr.bottom), top: Math.round(r.top), paneTop: Math.round(pr.top) });
                if (overflows.length >= 40) break;
              }
            }
          }
        }
        return { viewport: [innerWidth, innerHeight], layers: layers, rootName: rootName, gridCols: gridCols, overflowY: overflowY, panes: panes, paneOverflow: paneOverflow, overflows: overflows };
      }, { app: H.APP_SEL });
      report.push({ size: size.id, view: view, data: data });
    }
  }
  console.log(JSON.stringify(report, null, 1));
  try { await page.evaluate(() => window.close()); } catch (e) {}
  await H.awaitExit(launched.child, 15000);
} catch (e) {
  console.log("MEASURE ERROR", e && e.stack || e);
} finally {
  try { if (launched && launched.browser) await launched.browser.close(); } catch (e) {}
  try { if (launched && launched.child && launched.child.exitCode == null) launched.child.kill("SIGKILL"); } catch (e) {}
  await H.sleep(500);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
  process.exit(0);
}
