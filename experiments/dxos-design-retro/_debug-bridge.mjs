#!/usr/bin/env node
/** 一次性调试：marketUpdate 桥是否可被渲染层替换（ctxBridge 冻结与否）。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as H from "./lib/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const require = createRequire(path.join(ROOT, "package.json"));
const chromium = require("@playwright/test").chromium;
const electronPath = require("electron");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-retro-dbg-"));
const { child, browser, port } = await H.launchElectron({ ROOT, electronPath, chromium, userDataDir });
let page = null;
await H.waitFor(async () => {
  const pages = browser.contexts().flatMap((c) => c.pages());
  for (const p of pages) {
    if (!p.url().includes("vue.html")) continue;
    if (await p.evaluate(() => !!document.querySelector(".desktop")).catch(() => false)) { page = p; return true; }
  }
  return false;
}, 60000, 300);
console.log("port", port, "page", page && page.url());
console.log("gate", await H.ensureSession(page));

const r = await page.evaluate(() => {
  const out = {};
  const api = window.openarc && window.openarc.marketUpdate;
  out.hasApi = !!api;
  out.descriptor = api ? JSON.stringify(Object.getOwnPropertyDescriptor(api, "command") || null) : null;
  out.frozen = api ? Object.isFrozen(api) : null;
  out.sealed = api ? Object.isSealed(api) : null;
  out.extensible = api ? Object.isExtensible(api) : null;
  try {
    const before = api.command;
    api.command = async () => ({ ok: true, value: { patched: true } });
    out.assignedOk = api.command !== before;
  } catch (e) { out.assignError = String(e && e.message); }
  return out;
});
console.log("MUTATE " + JSON.stringify(r));

// 直接调用看看
const call = await page.evaluate(async () => {
  try { return JSON.stringify(await window.openarc.marketUpdate.command({ command: "market/update/status", payload: {} })); }
  catch (e) { return "THREW: " + String(e && e.message); }
});
console.log("CALL " + call);

// 试 Object.defineProperty
const r2 = await page.evaluate(() => {
  const out = {};
  const api = window.openarc.marketUpdate;
  try {
    Object.defineProperty(api, "command", { value: async () => ({ ok: true, value: { viaDefine: true } }), configurable: true, writable: true });
    out.defineOk = true;
  } catch (e) { out.defineError = String(e && e.message); }
  return out;
});
console.log("DEFINE " + JSON.stringify(r2));
const call2 = await page.evaluate(async () => {
  try { return JSON.stringify(await window.openarc.marketUpdate.command({ command: "market/update/status", payload: {} })); }
  catch (e) { return "THREW: " + String(e && e.message); }
});
console.log("CALL2 " + call2);

try { await browser.close(); } catch {}
await H.awaitExit(child, 8000);
try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
