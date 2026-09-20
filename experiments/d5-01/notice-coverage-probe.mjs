/** 聚焦判定：权限提示出现时，它到底有没有被原生网页盖住（像素 + 真实指针）。 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startSite } from "./site.mjs";
const require = createRequire(import.meta.url);
const electronPath = require("electron");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CDP = 9797;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c, a) => execFileSync(c, a, { encoding: "utf8" });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-notice-"));
const site = await startSite({ port: 5396 });
const child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1" } });
let browser = null, page = null;
try {
  let v = null; const dl = Date.now() + 60000;
  while (!v && Date.now() < dl) { try { v = await (await fetch("http://127.0.0.1:" + CDP + "/json/version")).json(); } catch { await sleep(300); } }
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP);
  const ctx = browser.contexts()[0];
  const end = Date.now() + 40000;
  while (!page && Date.now() < end) { page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!page) await sleep(300); }
  const js = (c) => page.evaluate("(async () => { " + c + " })()");
  const has = (s) => js("return !!document.querySelector(" + JSON.stringify(s) + ")");
  const setInput = (s, val) => js("const el=document.querySelector(" + JSON.stringify(s) + "); if(!el) return 'missing'; const proto = el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el, " + JSON.stringify(val) + "); el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';");
  const click = (s) => js("const el=document.querySelector(" + JSON.stringify(s) + "); if(!el) return 'missing'; el.click(); return 'ok';");
  const waitFor = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await sleep(100); } return false; };
  await waitFor(() => has('[data-d3-id="setup-name"]'), 30000);
  if (await has('[data-d3-id="setup-name"]')) {
    await setInput('[data-d3-id="setup-name"]', "Notice Probe");
    await setInput('[data-d3-id="setup-identifier"]', "admin@notice.test");
    await setInput('[data-d3-id="setup-password"]', "notice-password-1");
    await setInput('[data-d3-id="setup-confirm"]', "notice-password-1");
    await click('[data-d3-id="setup-submit"]');
    await waitFor(() => has('[data-d3-id="login-identifier"]'), 30000);
  }
  await setInput('[data-d3-id="login-identifier"]', "admin@notice.test");
  await setInput('[data-d3-id="login-password"]', "notice-password-1");
  await click('[data-d3-id="login-submit"]');
  await waitFor(async () => (await js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate')||''")) === "ready", 60000);
  await click('[aria-label="打开浏览器"]');
  await waitFor(() => has("[data-browser-window]"), 20000);
  await setInput('[aria-label="网页地址"]', site.base + "/permission");
  await click(".addressbar .primary");
  const gotNotice = await waitFor(() => has(".browser-notices [data-notice-kind]"), 25000);
  const info = JSON.parse(await js("const n=document.querySelector('.browser-notices'); const box=n?n.getBoundingClientRect():null; const item=document.querySelector('.browser-notice'); const ib=item?item.getBoundingClientRect():null; const btn=item?item.querySelector('button'):null; const bb=btn?btn.getBoundingClientRect():null; const w=document.querySelector('[data-browser-window]').getBoundingClientRect(); return JSON.stringify({notice:box?{top:box.top,h:box.height,left:box.left,w:box.width}:null, item:ib?{top:ib.top,h:ib.height}:null, btn:bb?{x:bb.left+bb.width/2,y:bb.top+bb.height/2,w:bb.width,h:bb.height}:null, btnLabel:btn?String(btn.textContent||'').trim():null, shell:{top:w.top,h:w.height,left:w.left,w:w.width}, text:String((n&&n.innerText)||'').slice(0,120)});"));
  const pid = child.pid;
  const q = JSON.parse(sh("python3", ["-c", "import json,sys\nfrom Quartz import CGWindowListCopyWindowInfo, kCGWindowListOptionOnScreenOnly, kCGNullWindowID\npid=int(sys.argv[1]); out=[]\nfor w in CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID):\n    if w.get('kCGWindowOwnerPID')==pid and int(w.get('kCGWindowLayer'))==0:\n        b=w.get('kCGWindowBounds'); out.append({'id':int(w.get('kCGWindowNumber')),'x':b['X'],'y':b['Y'],'w':b['Width'],'h':b['Height']})\nprint(json.dumps(out))", String(pid)]));
  const w0 = q[0];
  const frame = "/tmp/oa-notice-frame.png";
  sh("screencapture", ["-x", "-o", "-l", String(w0.id), frame]);
  const size = sh("python3", ["-c", "import sys\nfrom Quartz import CGImageSourceCreateWithURL, CGImageSourceCreateImageAtIndex, CGImageGetWidth, CGImageGetHeight, CFURLCreateWithFileSystemPath, kCFURLPOSIXPathStyle\nurl=CFURLCreateWithFileSystemPath(None, sys.argv[1], kCFURLPOSIXPathStyle, False)\nimg=CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(url,None),0,None)\nprint('%d,%d'%(CGImageGetWidth(img),CGImageGetHeight(img)))", frame]).trim().split(",").map(Number);
  const scale = size[0] / w0.w;
  const px = (xp, yp) => sh("python3", ["-c", "import sys\nfrom Quartz import CGImageSourceCreateWithURL, CGImageSourceCreateImageAtIndex, CGImageGetDataProvider, CGDataProviderCopyData, CGImageGetBytesPerRow, CGImageGetBitsPerPixel, CFURLCreateWithFileSystemPath, kCFURLPOSIXPathStyle\nurl=CFURLCreateWithFileSystemPath(None, sys.argv[1], kCFURLPOSIXPathStyle, False)\nimg=CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(url,None),0,None)\nbpr=CGImageGetBytesPerRow(img); bpp=CGImageGetBitsPerPixel(img)\nbuf=bytes(CGDataProviderCopyData(CGImageGetDataProvider(img))); x=int(sys.argv[2]); y=int(sys.argv[3]); o=y*bpr+x*(bpp//8)\nprint('%d,%d,%d'%(buf[o],buf[o+1],buf[o+2]))", frame, String(Math.round((xp - w0.x) * scale)), String(Math.round((yp - w0.y) * scale))]).trim();
  // 采样：提示条矩形内的多点（应当是提示条自己的颜色，而不是网页的纯绿）
  const originY = w0.y + Math.round(sh("python3", ["-c", "print(0)"])); // shell 原点=窗口内容顶（下面用 DOM 换算）
  const tb = 32;
  const noticeScreen = { top: w0.y + tb + info.notice.top, left: w0.x + info.notice.left, w: info.notice.w, h: info.notice.h };
  const samples = [];
  for (const fx of [0.15, 0.5, 0.85]) for (const fy of [0.25, 0.6]) samples.push({ fx, fy, rgb: px(noticeScreen.left + noticeScreen.w * fx, noticeScreen.top + noticeScreen.h * fy) });
  const greenLike = samples.filter((s) => { const [r, g, b] = s.rgb.split(",").map(Number); return g - r >= 40 && g - b >= 20; }).length;
  // 真实指针点提示条上的按钮 → 提示是否消失（= 真的点到了提示）
  let clicked = null, dismissed = null;
  if (info.btn) {
    const bx = Math.round(w0.x + info.btn.x), by = Math.round(w0.y + tb + info.btn.y);
    const inside = bx > w0.x + 4 && bx < w0.x + w0.w - 4 && by > w0.y + tb + 2 && by < w0.y + w0.h - 4;
    if (inside) { sh("cliclick", ["m:" + bx + "," + by]); await sleep(150); sh("cliclick", ["c:" + bx + "," + by]); clicked = true; dismissed = await waitFor(async () => !(await has(".browser-notices [data-notice-kind]")), 5000); }
  }
  console.log(JSON.stringify({ ok: true, gotNotice, info, scale, noticeScreen, samples, greenLikeSamples: greenLike, clicked, dismissed, frame }, null, 1));
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { child.kill("SIGKILL"); } catch {}
  try { spawnSync("pkill", ["-f", userData], { stdio: "ignore" }); } catch {}
  try { await site.close(); } catch {}
}
process.exit(0);
