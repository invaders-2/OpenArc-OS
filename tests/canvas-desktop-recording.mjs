import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { executeCanvasDesktopInput } = require("../electron/canvas-desktop-input.cjs");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "oa-recording-")));
const out = path.resolve("artifacts/canvas-tapnow-compare-20261027/electron-recording.webm");
setTimeout(() => { console.error("recording-test:timeout"); app.exit(2); }, 30_000).unref();
app.whenReady().then(async () => {
  const sources = await executeCanvasDesktopInput("canvas/capture/sources", {}, null);
  if (!sources.ok || !sources.sources?.length) throw new Error("没有采集源");
  const win = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { sandbox: true } });
  await win.loadURL("http://127.0.0.1:5173/artifacts/canvas-tapnow-compare-20261027/openarc-preview.html");
  const selected = await executeCanvasDesktopInput("canvas/capture/selectRecording", { sourceId: sources.sources[0].id }, win.webContents);
  if (!selected.ok) throw new Error(selected.error || "选择录屏源失败");
  const bytes = await win.webContents.executeJavaScript(`(async()=>{
    const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
    const chunks=[];const rec=new MediaRecorder(stream,{mimeType:'video/webm'});
    rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    const done=new Promise(resolve=>rec.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());resolve(new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer()))});
    rec.start(250);setTimeout(()=>rec.stop(),1200);return done;
  })()`);
  if (!bytes?.length) throw new Error("录屏为空");
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, Buffer.from(bytes));
  await executeCanvasDesktopInput("canvas/capture/stopRecording", {}, win.webContents);
  console.log(JSON.stringify({ ok: true, output: out, bytes: bytes.length })); app.exit(0);
}).catch((error) => { console.error(error?.stack || error); app.exit(1); });
