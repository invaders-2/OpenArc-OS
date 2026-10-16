import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as H from "../dxos-ui-photos/lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(ROOT, "package.json"));
const chromium = require("@playwright/test").chromium;
const electronPath = require("electron");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-bridge-diag-"));
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
const launched = await H.launchElectron({ ROOT, electronPath, chromium, userDataDir, env });
const page = launched.browser.contexts()[0].pages()[0];
await H.waitFor(async () => await page.evaluate(() => document.readyState === "complete" && !!window.openarc), 40000, 300);
const out = await page.evaluate(() => {
  const result = {};
  const d = Object.getOwnPropertyDescriptor(window, "openarc");
  result.windowOpenarcDescriptor = d ? { writable: d.writable, configurable: d.configurable, enumerable: d.enumerable, hasGet: !!d.get } : null;
  const mu = window.openarc.marketUpdate;
  const d2 = Object.getOwnPropertyDescriptor(window.openarc, "marketUpdate");
  result.marketUpdateDescriptor = d2 ? { writable: d2.writable, configurable: d2.configurable, enumerable: d2.enumerable } : null;
  const d3 = Object.getOwnPropertyDescriptor(mu, "command");
  result.commandDescriptor = d3 ? { writable: d3.writable, configurable: d3.configurable, enumerable: d3.enumerable } : null;
  try { window.openarc.marketUpdate.command = function () { return "patched"; }; result.assignNested = window.openarc.marketUpdate.command() === "patched"; }
  catch (e) { result.assignNested = "threw: " + e.message; }
  try {
    const proto = Object.create(window.openarc);
    proto.marketUpdate = { command: function () { return "shadow"; } };
    Object.defineProperty(window, "openarc", { value: proto, writable: true, configurable: true });
    result.redefineWindowOpenarc = true;
    result.shadowWorks = window.openarc.marketUpdate.command() === "shadow";
    result.inheritsSync = typeof window.openarc.sync === "function";
    result.otherKeysVisible = Object.keys(window.openarc).length;
  } catch (e) { result.redefineWindowOpenarc = "threw: " + e.message; }
  return result;
});
console.log(JSON.stringify(out, null, 2));
try { await launched.browser.close(); } catch (e) {}
await H.awaitExit(launched.child, 15000);
process.exit(0);
