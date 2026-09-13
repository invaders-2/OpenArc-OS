/**
 * D3-04C 预览 UI 探针宿主（真实 Electron + openarc-resource 协议）。
 * 验证：text / image+thumbnail / pdf / audio / video 预览、capability 交付、无本地路径泄漏、Trash 拒绝。
 */
const { app, BrowserWindow, ipcMain, safeStorage, protocol, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";

// 与 electron/main.cjs 完全一致的 privileges（必须在 app ready 前注册）。
protocol.registerSchemesAsPrivileged([
  { scheme: "openarc-resource", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false } },
]);

const report = { checks: [], errors: [], versions: {} };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail) }); out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
let userData = null;

const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const txt = (sel) => js("return (document.querySelector(" + JSON.stringify(sel) + ")?.textContent || '').trim()");

async function waitGate(want, timeout = 30000) {
  const t0 = Date.now();
  let last = "?";
  while (Date.now() - t0 < timeout) { try { last = await gate(); if (last === want) return last; } catch { /* navigating */ } await sleep(120); }
  return "TIMEOUT(last=" + last + ")";
}
async function waitSel(sel, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await has(sel)) return true; await sleep(100); } return false; }
async function waitFn(expr, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await js("return (" + expr + ")")) return true; } catch { /* ignore */ } await sleep(100); } return false; }
const setValue = (sel, value) =>
  js(
    "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
      "if (!el) return 'missing';" +
      "const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;" +
      "const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;" +
      "setter.call(el, " + JSON.stringify(value) + ");" +
      "el.dispatchEvent(new Event('input', { bubbles: true }));" +
      "return 'ok';",
  );
const click = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");

const selectItem = async (id) => {
  const sel = '[data-d3-04a-item="' + id + '"]';
  await js("const el=document.querySelector(" + JSON.stringify(sel) + "); if(el) el.click(); return el ? 'ok' : 'missing';");
  await waitFn("document.querySelector('[data-d3-04b-inspector-ref]') && document.querySelector('[data-d3-04b-inspector-ref]').getAttribute('data-d3-04b-inspector-ref')===" + JSON.stringify(id));
};

function makeWav(seconds, rate) {
  const samples = rate * seconds;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * 32767), 44 + i * 2);
  return buf;
}

app.whenReady().then(async () => {
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform + "/" + process.arch };
    out("VERSIONS " + JSON.stringify(report.versions));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3-04c-preview-ui-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true, nativeImage });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });

    // 真实素材
    const textPath = path.join(userData, "预览正文.txt");
    fs.writeFileSync(textPath, "这是预览正文 plain text");
    const pngPath = path.join(userData, "pic.png");
    fs.writeFileSync(pngPath, nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 180), { width: 64, height: 64 }).toPNG());
    const pdfPath = path.join(userData, "doc.pdf");
    fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF"));
    const wavPath = path.join(userData, "tone.wav");
    fs.writeFileSync(wavPath, makeWav(1, 8000));

    win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    registerIdentityIpc({
      ipcMain, service: identity.service, authorization: identity.authorization, device: identity.deviceService,
      resource: identity.resourceService, resourceSearch: identity.searchService, resourcePreview: identity.previewService,
      dialog: null, BrowserWindow, isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event); },
    });
    protocol.handle("openarc-resource", (request) => identity.previewService.handleProtocolRequest(request));

    await win.loadURL(uiURL);
    await sleep(500);
    let g = await waitGate("unauthenticated");
    check("P1 · 登录页", g === "unauthenticated", "gate=" + g);
    await setValue('[data-d3-id="login-identifier"]', ADMIN);
    await setValue('[data-d3-id="login-password"]', PW);
    await sleep(80);
    await click('[data-d3-id="login-submit"]');
    g = await waitGate("ready");
    check("P2 · 登录进入桌面", g === "ready", "gate=" + g);
    await click('[data-app-id="resource-library"]');
    check("P3 · 打开资源库 App", await waitSel('[data-d3-04b="app"]'), "");

    const ctx = { sessionRef: identity.service.current, appId: "resource-library" };
    const textRes = await identity.resourceService.importManaged({ context: ctx, sourcePath: textPath, name: "预览正文.txt" });
    const imgRes = await identity.resourceService.importManaged({ context: ctx, sourcePath: pngPath, name: "pic.png", mimeType: "image/png" });
    const pdfRes = await identity.resourceService.importManaged({ context: ctx, sourcePath: pdfPath, name: "doc.pdf", mimeType: "application/pdf" });
    const wavRes = await identity.resourceService.importManaged({ context: ctx, sourcePath: wavPath, name: "tone.wav", mimeType: "audio/wav" });

    // 视频：renderer MediaRecorder 录一段真实 WebM
    let videoRes = null;
    try {
      const arr = await js([
        "const canvas = document.createElement('canvas'); canvas.width=48; canvas.height=48;",
        "const c = canvas.getContext('2d');",
        "const stream = canvas.captureStream(15);",
        "const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });",
        "const chunks = []; rec.ondataavailable = function(e){ if(e.data && e.data.size) chunks.push(e.data); };",
        "rec.start();",
        "let n = 0; const iv = setInterval(function(){ c.fillStyle = (n++%2)?'#e11':'#11e'; c.fillRect(0,0,48,48); }, 60);",
        "await new Promise(function(r){ setTimeout(r, 1500); });",
        "clearInterval(iv);",
        "await new Promise(function(r){ rec.onstop = r; rec.stop(); });",
        "const blob = new Blob(chunks, { type: 'video/webm' });",
        "const buf = await blob.arrayBuffer();",
        "return Array.from(new Uint8Array(buf));",
      ].join("\n"));
      if (Array.isArray(arr) && arr.length > 200) {
        const webmPath = path.join(userData, "clip.webm");
        fs.writeFileSync(webmPath, Buffer.from(arr));
        videoRes = await identity.resourceService.importManaged({ context: ctx, sourcePath: webmPath, name: "clip.webm", mimeType: "video/webm" });
      }
    } catch (e) {
      report.errors.push("MediaRecorder: " + String(e.message));
    }
    check("P4 · 导入 text/png/pdf/wav 素材", textRes.ok && imgRes.ok && pdfRes.ok && wavRes.ok, "");
    check("P5 · MediaRecorder 生成可播放 WebM" + (videoRes ? "" : "（不可用）"), !!videoRes, videoRes ? "ok" : "PARTIAL：视频播放/seek 未验证，仅 capability+Range");

    await identity.resourceService.recoverStartup?.();
    // 主进程导入绕过 Renderer；先切到别的分类再回 all，触发 reload（同分类点击不会重新拉取）
    await click('[data-d3-04b-nav="memory"]');
    await sleep(300);
    await click('[data-d3-04b-nav="all"]');
    check("P4b · 列表刷新后包含全部导入素材", await waitFn("document.querySelectorAll('[data-d3-04a-item]').length>=" + (videoRes ? 5 : 4)), await js("return document.querySelectorAll('[data-d3-04a-item]').length"));
    await identity.searchService.indexResource(pdfRes.resource.resourceId);

    // text
    await selectItem(textRes.resource.resourceId);
    check("P6 · text 预览显示正文", await waitFn("document.querySelector('[data-d3-04c-preview]')?.getAttribute('data-d3-04c-preview')==='text' && document.querySelector('[data-d3-04c-preview-text]')"), await txt('[data-d3-04c-preview-text]'));
    check("P7 · text 预览内容正确", (await txt('[data-d3-04c-preview-text]')).indexOf("预览正文") >= 0, await txt('[data-d3-04c-preview-text]'));

    // image + thumbnail（renderer 优先用 thumbnailUrl）
    await selectItem(imgRes.resource.resourceId);
    check("P8 · image 预览渲染 <img> 且真实解码", await waitFn("(function(){var im=document.querySelector('[data-d3-04c-preview-image]');return !!im&&im.complete&&im.naturalWidth>0;})()"), await js("const im=document.querySelector('[data-d3-04c-preview-image]'); return im ? ('nw=' + im.naturalWidth + ' src=' + String(im.src).slice(0,40)) : 'no-img'"));
    const th = await identity.previewService.thumbnail({ context: ctx, resourceRef: imgRes.resource.resourceId });
    check("P9 · 主进程 thumbnail 生成 256px PNG（nativeImage，本地）", th.ok === true && th.width === 256, JSON.stringify({ ok: th.ok, width: th.width, cached: th.cached }));
    if (th.ok && th.url) {
      const resp = await identity.previewService.handleProtocolRequest(new Request(th.url));
      check("P10 · thumbnail capability -> 200 image/png", resp.status === 200 && String(resp.headers.get("content-type") || "").includes("image/png"), "status=" + resp.status + " type=" + resp.headers.get("content-type"));
    } else {
      check("P10 · thumbnail capability -> 200 image/png", false, "no url");
    }
    const imgPv = await identity.previewService.preview({ context: ctx, resourceRef: imgRes.resource.resourceId });
    const r206 = await identity.previewService.handleProtocolRequest(new Request(imgPv.url, { headers: { Range: "bytes=0-31" } }));
    check("P11 · image Range -> 206（安全流式交付）", r206.status === 206, "status=" + r206.status);

    // pdf
    await selectItem(pdfRes.resource.resourceId);
    check("P12 · pdf 预览 iframe 使用 capability URL", await waitFn("(function(){var f=document.querySelector('[data-d3-04c-preview-pdf]');return !!f&&String(f.getAttribute('src')||'').startsWith('openarc-resource://');})()"), await js("return document.querySelector('[data-d3-04c-preview-pdf]')?.getAttribute('src')"));
    const pdfIdx = await identity.searchService.indexStatus({ context: ctx, resourceRef: pdfRes.resource.resourceId });
    check("P13 · pdf 正文不抽取（NO_TEXT / 元数据索引）", pdfIdx.ok && (pdfIdx.indexStatus === "NO_TEXT" || pdfIdx.indexStatus === "READY"), pdfIdx.indexStatus);

    // audio（真实 WAV）
    await selectItem(wavRes.resource.resourceId);
    check("P14 · audio 预览加载真实元数据", await waitFn("(function(){var a=document.querySelector('[data-d3-04c-preview-audio]');return !!a&&a.readyState>=1&&isFinite(a.duration)&&a.duration>0;})()"), await js("const a=document.querySelector('[data-d3-04c-preview-audio]'); return a ? ('rs=' + a.readyState + ' dur=' + a.duration) : 'no-audio'"));

    // video（真实 WebM）
    if (videoRes) {
      await selectItem(videoRes.resource.resourceId);
      const meta = await waitFn("(function(){var v=document.querySelector('[data-d3-04c-preview-video]');return !!v&&v.readyState>=1&&isFinite(v.duration)&&v.duration>0;})()", 25000);
      check("P15 · video 预览加载真实元数据（播放/seek）", meta, await js("const v=document.querySelector('[data-d3-04c-preview-video]'); return v ? ('rs=' + v.readyState + ' dur=' + v.duration) : 'no-video'"));
      if (meta) {
        const seek = await js("const v=document.querySelector('[data-d3-04c-preview-video]'); v.currentTime = Math.min(0.4, v.duration/2); await new Promise(function(r){ setTimeout(r, 400); }); return v.currentTime;");
        check("P16 · video seek 生效（currentTime 前进）", typeof seek === "number" && seek > 0, "currentTime=" + seek);
      } else {
        check("P16 · video seek 生效（currentTime 前进）", false, "metadata 未加载，视频播放/seek 标记 PARTIAL");
      }
    } else {
      check("P15 · video 预览加载真实元数据（播放/seek）", false, "MediaRecorder 不可用 -> PARTIAL");
      check("P16 · video seek 生效（currentTime 前进）", false, "MediaRecorder 不可用 -> PARTIAL");
    }

    // 无本地路径泄漏
    const bodyHtml = await js("return document.body.innerHTML");
    check("P17 · DOM 不含任何本地路径 / checksum 目录", !bodyHtml.includes(userData) && !bodyHtml.includes("objects/sha256"), "");

    // Trash 后预览拒绝：切到回收站分类，选中被删资源，预览必须不可用
    identity.resourceService.delete({ context: ctx, resourceRef: textRes.resource.resourceId });
    await click('[data-d3-04b-nav="trash"]');
    await waitFn("document.querySelectorAll('[data-d3-04a-item]').length>=1");
    await selectItem(textRes.resource.resourceId);
    check("P18 · Trash 后预览显示不可用（默认拒绝）", await waitFn("!!document.querySelector('[data-d3-04c-preview-error]')"), await txt('[data-d3-04c-preview-error]'));
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e.message).slice(0, 200));
  } finally {
    try { win?.destroy(); } catch { /* ignore */ }
    if (userData) { try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
