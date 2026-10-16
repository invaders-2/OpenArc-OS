#!/usr/bin/env node
/** 策略边界截图探针：UI 直接填公网 http 地址 → 结构化 ENDPOINT_BLOCKED（不发起任何网关调用）。 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-relay-image");
const SHOTS = path.join(ART, "shots");
const SHOT = { width: 1440, height: 900, dsf: 2 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, t, s = 250) => { const e = Date.now() + t; for (;;) { try { if (await fn()) return true; } catch { /* retry */ } if (Date.now() >= e) return false; await sleep(s); } };
function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); }); }
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const require = createRequire(path.join(ROOT, "package.json"));
  const chromium = require("@playwright/test").chromium;
  const electronPath = require("electron");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-relay-policy-"));
  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
  let child = null, browser = null, page = null;
  const out = { at: new Date().toISOString() };
  try {
    child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    await waitFor(async () => { try { return (await fetch("http://127.0.0.1:" + port + "/json/version")).ok; } catch { return false; } }, 90000, 300);
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    const ctx = browser.contexts()[0];
    await waitFor(() => !!ctx.pages().find((p) => p.url().includes("vue.html")), 45000, 300);
    page = ctx.pages().find((p) => p.url().includes("vue.html"));
    const ses = await page.context().newCDPSession(page);
    await ses.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.dsf, mobile: false });
    await waitFor(async () => !!(await page.evaluate(() => window.openarc)), 45000, 300);
    await page.evaluate(async () => { await window.openarc.identity.command({ type: "identity/initialize", identifier: "relay-policy@openarc.test", password: "RelayPolicy-1", displayName: "策略边界探针" }); });
    await page.evaluate(async () => { await window.openarc.identity.command({ type: "identity/login", identifier: "relay-policy@openarc.test", password: "RelayPolicy-1" }); });
    await waitFor(async () => (await page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") : null; })) === "ready", 30000, 200);
    await page.evaluate(() => { const d = document.querySelector(".dock"); if (d) d.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true })); });
    await page.evaluate(() => { const el = document.querySelector('.dock-item[data-dock-id="settings"]'); if (el) el.click(); });
    await waitFor(async () => !!(await page.$('[data-settings-pane="model"]')), 20000, 300);
    await page.evaluate(() => { const el = document.querySelector('[data-settings-pane="model"]'); if (el) el.click(); });
    await waitFor(async () => !!(await page.$('[data-d4-01="settings"]')), 20000, 300);
    await page.evaluate(() => { const el = document.querySelector("[data-d4-01-provider-add]"); if (el) el.click(); });
    await waitFor(async () => !!(await page.$("[data-d4-01-provider-form]")), 8000, 200);
    out.insecureCheckbox = await page.evaluate(() => { const el = document.querySelector("[data-d4-01-provider-insecure-http]"); return el ? { present: true, label: (el.closest("label") || el.parentElement || {}).innerText || null, checked: !!el.checked } : { present: false }; });
    await page.evaluate(() => {
      const setVal = (sel, v) => { const el = document.querySelector(sel); if (!el) return; const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, "value").set; setter.call(el, v); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); };
      setVal("[data-d4-01-provider-name]", "Policy Boundary Probe");
      setVal("[data-d4-01-provider-url]", "http://43.130.6.197:8080");
    });
    await sleep(200);
    await page.evaluate(() => { const el = document.querySelector("[data-d4-01-provider-create]"); if (el) el.click(); });
    await waitFor(async () => !!(await page.$("[data-d4-01-error]")), 12000, 250);
    out.policy = await page.evaluate(() => { const el = document.querySelector("[data-d4-01-error]"); if (!el) return null; el.scrollIntoView({ block: "center" }); return { code: el.getAttribute("data-d4-01-error-code"), text: el.textContent.trim() }; });
    await sleep(400);
    out.shots = [];
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => { const b = document.querySelector('button[aria-label="控制中心"]'); if (b) b.click(); }, theme);
      await sleep(400);
      await page.evaluate((t) => { const cc = document.querySelector(".control-center"); if (!cc) return; const g = cc.querySelector('[aria-label="外观"]'); if (!g) return; const btns = Array.prototype.slice.call(g.querySelectorAll("button")); for (const b of btns) if (String(b.textContent).trim() === t) { b.click(); return; } }, theme === "dark" ? "深色" : "浅色");
      await sleep(500);
      await page.evaluate(() => { const sh = document.querySelector(".cc-shade"); if (sh) sh.click(); });
      await sleep(300);
      await page.evaluate(() => { const el = document.querySelector("[data-d4-01-error]"); if (el) el.scrollIntoView({ block: "center" }); });
      await sleep(200);
      const file = path.join(SHOTS, "03-settings-policy-blocked-" + theme + ".png");
      const s2 = await page.context().newCDPSession(page);
      const r = await s2.send("Page.captureScreenshot", { format: "png" });
      try { await s2.detach(); } catch { /* ignore */ }
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      const b = fs.readFileSync(file);
      out.shots.push({ file: path.relative(ROOT, file), theme, width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length });
    }
  } catch (err) { out.fatal = String((err && err.stack) || err); console.error("FATAL " + out.fatal); }
  finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (child) child.kill("SIGTERM"); } catch { /* ignore */ }
    await waitFor(() => !child || child.exitCode !== null || child.signalCode !== null, 8000, 200);
    if (child && child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.writeFileSync(path.join(ART, "policy-shot.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  return out.policy && out.policy.code === "ENDPOINT_BLOCKED" ? 0 : 1;
}
main().then((c) => process.exit(c)).catch((e) => { console.error("UNCAUGHT " + (e && e.stack)); process.exit(2); });
