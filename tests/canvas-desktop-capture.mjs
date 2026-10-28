import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { executeCanvasDesktopInput } = require("../electron/canvas-desktop-input.cjs");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "oa-capture-")));
const out = path.resolve("artifacts/canvas-tapnow-compare-20261027/electron-capture.png");
console.log("capture-test:loaded");
setTimeout(() => { console.error("capture-test:global-timeout"); app.exit(2); }, 25_000).unref();
app.whenReady().then(async () => {
  console.log("capture-test:ready");
  const sources = await executeCanvasDesktopInput("canvas/capture/sources", {}, null);
  console.log("capture-test:sources", JSON.stringify(sources));
  if (!sources.ok || !sources.sources?.length) throw new Error("没有可用采集源");
  const shot = await executeCanvasDesktopInput("canvas/capture/screenshot", { sourceId: sources.sources[0].id }, null);
  if (!shot.ok) throw new Error(shot.error || "截图失败");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.dataUrl.split(",")[1], "base64"));
  console.log(JSON.stringify({ ok: true, sources: sources.sources.length, output: out, bytes: fs.statSync(out).size }));
  app.exit(0);
}).catch((error) => {
  console.error(error?.stack || error);
  app.exit(1);
});
