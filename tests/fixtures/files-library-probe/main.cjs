"use strict";
/**
 * Z2 · 访达窗口「加入资源库 / 导出」真机探针宿主（真实 Electron + 产品页面 / preload / 服务）。
 *
 * 为什么需要自定义宿主：产品 electron/main.cjs 的 dialog 是系统原生对话框，无法离线驱动；
 * 这里用 stub dialog（只返回探针临时目录）装一份同形状的受控命令面：
 *   · identity / resource 走 electron/identity-bootstrap.cjs 的真实实现（含 resolveFile 注入）；
 *   · files:* 走 electron/file-service.cjs 的真实实现（路径不出主进程）；
 *   · 页面来源 = OA_DEV_SERVER（Vite 预览，本轮不执行任何构建）或 dist/index.html。
 *
 * 覆盖：未选中禁用 / 选中可用 / 加入资源库成功 / 导出资源成功 / 导出到电脑成功 /
 *       失败（源文件缺失） / 取消 / 进行中 busy / 浅深截图 / 连续录屏 /
 *       0 console error / 0 非本地请求 / 只发白名单命令 / 隔离 userData。
 */
const { app, BrowserWindow, ipcMain, safeStorage, nativeImage, protocol, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Readable } = require("node:stream");

const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { createFileService } = require(path.join(ROOT, "electron/file-service.cjs"));
const { RENDERER_COMMANDS } = require(path.join(ROOT, "electron/resource-bootstrap.cjs"));

const DEV = process.env.OA_DEV_SERVER || null;
const DEV_BASE = DEV ? DEV.replace(/[/]+$/, "") + "/" : null;
const uiURL = DEV ? new URL(DEV).href : pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const ART = path.join(ROOT, "artifacts", "files-library");
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";

/* userData 必须在 app ready 之前改到临时目录：绝不能让探针写到真实 profile。 */
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "oa-files-library-probe-"));
app.setPath("userData", USER_DATA);

/* openarc-file 必须在 ready 之前登记 privileged（与 electron/main.cjs:144-148 同形），
   否则桌面默认壁纸的原生视频会被 CORS 拦掉 —— 那是宿主环境问题，不是产品问题。 */
protocol.registerSchemesAsPrivileged([
  { scheme: "openarc-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);
const NATIVE_RESOURCES = { "siri-blob": "/System/Library/PrivateFrameworks/SiriUI.framework/Versions/A/Resources/Siri Blob.mov" };
const NATIVE_TYPES = { ".mov": "video/quicktime", ".mp4": "video/mp4", ".m4v": "video/x-m4v" };

const report = {
  checks: [],
  errors: [],
  versions: {},
  observed: {},
  screenshots: [],
  video: null,
  videoFrames: 0,
  console: { total: 0, errors: [] },
  network: { total: 0, nonLocal: [] },
  commands: { resource: [], files: [] },
  isolated: { userData: USER_DATA },
};
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail).slice(0, 600) });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
  return !!ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
let files = null;
let identity = null;
let resource = null;

/* ── stub dialog：只指向探针临时目录，不弹系统窗口 ─────────────────────── */
const seedPath = path.join(USER_DATA, "seed-good.txt");
const seedBrokenPath = path.join(USER_DATA, "seed-broken.txt");
const exportDir = path.join(USER_DATA, "export-dest");
const saveTarget = path.join(USER_DATA, "exported-resource.txt");
fs.mkdirSync(exportDir, { recursive: true });
const dialogState = { openCancel: false };
const stubDialog = {
  showOpenDialog: async () => (dialogState.openCancel ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [exportDir] }),
  showSaveDialog: async () => ({ canceled: false, filePath: saveTarget }),
};

/* ── DOM 驱动原语 ─────────────────────────────────────────────────────── */
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const gate = () => js("var d=document.querySelector('.desktop'); return d ? d.getAttribute('data-identity-gate') : 'no-root'");
const click = (sel) => js("var el=document.querySelector(" + JSON.stringify(sel) + "); if(!el) return 'missing'; if(el.disabled) return 'disabled'; el.click(); return 'ok';");
const setInput = (sel, value) =>
  js(
    "var el=document.querySelector(" + JSON.stringify(sel) + "); if(!el) return 'missing';" +
      "var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el," + JSON.stringify(value) + ");" +
      "el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';",
  );
async function waitFn(expr, timeout) {
  const t0 = Date.now();
  const limit = timeout || 15000;
  for (;;) {
    try {
      if (await js("return (" + expr + ")")) return true;
    } catch {
      /* 页面导航中 */
    }
    if (Date.now() - t0 > limit) return false;
    await sleep(120);
  }
}
const waitSel = (sel, timeout) => waitFn("!!document.querySelector(" + JSON.stringify(sel) + ")", timeout);
async function waitStatus(kind, timeout) {
  return waitFn("(function(){var el=document.querySelector('[data-files-library-status]');return !!el && el.getAttribute('data-files-library-status')===" + JSON.stringify(kind) + ";})()", timeout);
}
const entryState = () =>
  js(
    "var b=document.querySelector('[data-files-library-entry]'); if(!b) return null;" +
      "return {disabled:b.disabled, label:b.getAttribute('aria-label')||'', title:b.title||'', state:b.getAttribute('data-files-library-state')||'', busy:b.getAttribute('data-files-library-busy')||''};",
  );
const statusState = () =>
  js(
    "var el=document.querySelector('[data-files-library-status]'); if(!el) return null;" +
      "return {kind:el.getAttribute('data-files-library-status')||'', code:el.getAttribute('data-files-library-code')||'', text:(el.textContent||'').trim()};",
  );
const menuItems = () =>
  js(
    "return Array.from(document.querySelectorAll('.context-menu [data-menu-id]')).map(function(el){return {id:el.getAttribute('data-menu-id'),label:(el.textContent||'').trim(),disabled:!!el.disabled};});",
  );
async function openLibraryMenu() {
  await click("[data-files-library-entry]");
  await waitSel('[data-menu-id="lib-add-managed"]', 4000);
  return menuItems();
}
/* 必须限定在访达的 .file-cell 上：桌面图标也带 data-entry-id，全局选择器会点错（实测）。 */
const selectCell = (id) => js("var el=document.querySelector('.file-cell[data-entry-id=" + JSON.stringify(id) + "]'); if(!el) return 'missing'; el.click(); return 'ok';");
/* ── 截图 / 录屏 ──────────────────────────────────────────────────────── */
async function shot(name) {
  /* 菜单/状态的进入动画是 160ms：先等它稳定，再抓帧，否则截到的是未合成的旧帧。 */
  await sleep(260);
  const img = await win.capturePage();
  const size = img.getSize();
  const file = path.join(ART, name + ".png");
  fs.writeFileSync(file, img.toPNG());
  report.screenshots.push({ file: path.relative(ROOT, file), width: size.width, height: size.height });
  return file;
}
let recording = false;
let frameNo = 0;
const MAX_FRAMES = 240;
const FRAME_DIR = path.join(USER_DATA, "frames");
/** 连续录屏：CDP Page.startScreencast（每次真实绘制出一帧），结束后 ffmpeg 封装成 webm。 */
function startRecording() {
  fs.mkdirSync(FRAME_DIR, { recursive: true });
  recording = true;
  try {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.3");
    win.webContents.debugger.on("message", (event, method, params) => {
      if (method !== "Page.screencastFrame") return;
      if (frameNo < MAX_FRAMES) {
        try {
          fs.writeFileSync(path.join(FRAME_DIR, "f" + String(frameNo).padStart(5, "0") + ".jpg"), Buffer.from(params.data, "base64"));
          frameNo += 1;
        } catch {
          /* 丢一帧不影响结论 */
        }
      }
      try {
        win.webContents.debugger.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId });
      } catch {
        /* ignore */
      }
    });
    win.webContents.debugger.sendCommand("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
  } catch {
    recording = false;
  }
}
async function stopRecording() {
  recording = false;
  try {
    if (win && !win.isDestroyed() && win.webContents.debugger.isAttached()) {
      await win.webContents.debugger.sendCommand("Page.stopScreencast");
      win.webContents.debugger.detach();
    }
  } catch {
    /* ignore */
  }
  await sleep(200);
}
function muxRecording() {
  if (frameNo < 2) return null;
  const target = path.join(ART, "files-library-flow.webm");
  try {
    execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-framerate", "10", "-i", path.join(FRAME_DIR, "f%05d.jpg"), "-c:v", "libvpx-vp9", "-b:v", "1M", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p", target], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    return null;
  }
  return fs.existsSync(target) ? target : null;
}

/* ── 主流程 ───────────────────────────────────────────────────────────── */
app.whenReady().then(async () => {
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform + "/" + process.arch };
    out("VERSIONS " + JSON.stringify(report.versions));
    fs.mkdirSync(ART, { recursive: true });
    fs.writeFileSync(seedPath, "seed-content-for-library\n");
    fs.writeFileSync(seedBrokenPath, "broken-content\n");

    identity = createIdentityService({ userDataDir: USER_DATA, safeStorage, allowAdmin: true, nativeImage });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    resource = identity.resourceService;

    files = createFileService({ userDataDir: USER_DATA });
    const seeded = files.importPaths("desktop", [seedPath, seedBrokenPath]);
    const goodEntry = seeded.added[0];
    const brokenEntry = seeded.added[1];

    /* 进行中观察：给 importManaged 加 600ms 延迟（其余仍是真实实现）。 */
    const realImport = resource.importManaged.bind(resource);
    let slowImports = true;
    resource.importManaged = async (args) => {
      if (slowImports) await sleep(600);
      return realImport(args);
    };

    win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: true,
      webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    win.webContents.on("console-message", (...args) => {
      let level = args[1];
      let message = args[2];
      if (args[0] && typeof args[0] === "object" && "message" in args[0]) {
        level = args[0].level;
        message = args[0].message;
      }
      const isError = level === 3 || level === "error";
      report.console.total += 1;
      if (isError) report.console.errors.push(String(message).slice(0, 300));
    });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
      const url = details.url || "";
      report.network.total += 1;
      const local = /^(file:|data:|blob:|about:|devtools:|openarc-file:|openarc-resource:|openarc-canvas:|http:\/\/127\.0\.0\.1|http:\/\/localhost|http:\/\/\[::1\]|ws:\/\/127\.0\.0\.1|ws:\/\/localhost)/i.test(url);
      if (!local) report.network.nonLocal.push(url);
      callback({});
    });

    const isTrusted = (e) => {
      if (e.sender !== win.webContents) return false;
      const url = String((e.senderFrame && e.senderFrame.url) || "");
      return url === uiURL || (DEV_BASE ? url.indexOf(DEV_BASE) === 0 : false);
    };
    /* resource:command 用探针自己的 ipcMain 包装一层，记账"只发白名单命令"。 */
    const loggingIpcMain = {
      handle(channel, fn) {
        if (channel === "resource:command") {
          ipcMain.handle(channel, async (e, command) => {
            report.commands.resource.push(String((command && command.type) || ""));
            return fn(e, command);
          });
          return;
        }
        ipcMain.handle(channel, fn);
      },
    };
    /* files:* 由探针自己注册（同形状的受控面；真实实现见 electron/main.cjs:1200-1400）。 */
    const fileChannels = {
      "files:list": (e, folderId) => files.list(String(folderId || "")),
      "files:import": (e, payload) => files.importPaths(String((payload && payload.folderId) || ""), Array.isArray(payload && payload.paths) ? payload.paths : []),
      "files:rename": (e, payload) => files.rename(String(payload.folderId || ""), String(payload.id || ""), String(payload.name || "")),
      "files:remove": (e, payload) => files.remove(String(payload.folderId || ""), String(payload.id || "")),
      "files:trash": (e, payload) => files.trash(String(payload.folderId || ""), String(payload.id || ""), payload.groupId),
      "files:trashList": () => files.listTrash(),
      "files:trashRestore": (e, payload) => files.restore(String(payload.id || "")),
      "files:trashPurge": (e, payload) => files.purge(String(payload.id || "")),
      "files:trashEmpty": () => files.empty(),
      "files:read": (e, payload) => files.read(String(payload.folderId || ""), String(payload.id || "")),
      "files:thumb": () => ({ ok: false, error: "NO_THUMBNAIL" }),
      "files:info": () => ({ ok: false, error: "NO_INFO" }),
      "files:copy": (e, payload) => files.copy(String(payload.folderId || ""), payload.ids, String(payload.toFolderId || "")),
      "files:move": (e, payload) => files.move(String(payload.folderId || ""), payload.ids, String(payload.toFolderId || "")),
      "files:export": async (e, payload) => {
        const folderId = String((payload && payload.folderId) || "");
        const ids = Array.isArray(payload && payload.ids) ? payload.ids.map(String) : [];
        const picks = ids.map((id) => files.resolve(folderId, id)).filter(Boolean);
        if (!picks.length) return { ok: false, error: "NOT_FOUND" };
        const res = await stubDialog.showOpenDialog();
        if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, error: "CANCELED" };
        fs.mkdirSync(res.filePaths[0], { recursive: true });
        let count = 0;
        for (const hit of picks) {
          try {
            fs.copyFileSync(hit.path, path.join(res.filePaths[0], path.basename(hit.path)));
            count += 1;
          } catch {
            /* 单个失败不影响整批 */
          }
        }
        return { ok: true, count, dest: res.filePaths[0] };
      },
    };
    for (const [channel, fn] of Object.entries(fileChannels)) {
      ipcMain.handle(channel, async (e, payload) => {
        report.commands.files.push(channel);
        if (!isTrusted(e)) throw Error("Forbidden");
        return fn(e, payload);
      });
    }
    ipcMain.on("files:startDrag", () => {});
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    ipcMain.handle("browser:command", async () => ({ ok: true }));

    /* 同形只读协议：native 白名单 + media 走 file-service.resolve（路径不出主进程）。 */
    protocol.handle("openarc-file", async (request) => {
      try {
        const url = new URL(request.url);
        if (url.hostname === "native") {
          const abs = NATIVE_RESOURCES[url.pathname.replace(/^\/+/, "")];
          if (!abs || !fs.existsSync(abs)) return new Response("Not Found", { status: 404 });
          const size = fs.statSync(abs).size;
          const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
          const start = range && range[1] ? Number(range[1]) : 0;
          const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start > end) return new Response("Range Not Satisfiable", { status: 416 });
          const headers = {
            "Content-Type": NATIVE_TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream",
            "Accept-Ranges": "bytes",
            "Content-Length": String(end - start + 1),
            "Access-Control-Allow-Origin": "*",
          };
          if (range) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
          return new Response(Readable.toWeb(fs.createReadStream(abs, { start, end })), { status: range ? 206 : 200, headers });
        }
        const parts = url.pathname.split("/").filter(Boolean);
        const hit = files.resolve(decodeURIComponent(parts[0] || ""), decodeURIComponent(parts[1] || ""));
        if (!hit) return new Response("Not Found", { status: 404 });
        return await net.fetch(pathToFileURL(hit.path).toString());
      } catch {
        return new Response("Error", { status: 500 });
      }
    });

    registerIdentityIpc({
      ipcMain: loggingIpcMain,
      service: identity.service,
      resource,
      dialog: stubDialog,
      BrowserWindow,
      shell: { showItemInFolder: () => {} },
      resolveFile: (folderId, id) => {
        const hit = files.resolve(String(folderId || ""), String(id || ""));
        return hit ? { path: hit.path, name: hit.entry ? hit.entry.name : "" } : null;
      },
      isTrusted,
      send: () => {},
    });

    out("STAGE load " + uiURL);
    await win.loadURL(uiURL);
    out("STAGE loaded");
    const pageOk = await waitFn("document.readyState==='complete' && !!window.openarc && Object.keys(window.openarc).length>0", 60000);
    check("P0 · 真实页面加载完成且有 openarc 桥", pageOk, "readyState=" + (await js("return document.readyState").catch(() => "?")));
    await sleep(500);

    async function ensureReady() {
      let g = await gate();
      if (g !== "ready" && g !== "locking" && g !== "locked") {
        await setInput('[data-d3-id="login-identifier"]', ADMIN);
        await setInput('[data-d3-id="login-password"]', PW);
        await sleep(80);
        await click('[data-d3-id="login-submit"]');
      }
      const ok = await waitFn("(function(){var d=document.querySelector('.desktop');return !!d && d.getAttribute('data-identity-gate')==='ready';})()", 30000);
      return await gate();
    }
    const g1 = await ensureReady();
    check("P1 · 登录进入桌面 ready", g1 === "ready", "gate=" + g1);

    /* S14 先做深色截图：reload 期间不录屏（debugger 挂载 + reload 会让 compositor 报 UnknownVizError）。 */
    await js("localStorage.setItem('oa-theme','dark'); return 'ok'");
    await win.webContents.reload();
    await waitFn("document.readyState==='complete' && !!window.openarc", 60000);
    await sleep(500);
    const g2 = await ensureReady();
    await click('[data-dock-id="files"]');
    await waitFn("!!document.querySelector('.folder-body[data-drop-folder=desktop]')", 15000);
    await waitFn("!!document.querySelector('.file-cell[data-entry-id=" + JSON.stringify(goodEntry.id) + "]')", 15000);
    await selectCell(goodEntry.id);
    await sleep(250);
    await openLibraryMenu();
    const darkShot = await shot("files-library-menu-dark");
    const darkApplied = await js("var d=document.querySelector('.desktop'); return !!d && d.classList.contains('dark')");
    check("S14 · 深色主题下截图（真实主题键生效）", !!darkApplied && g2 === "ready", "dark=" + darkApplied + " gate=" + g2);
    await click('[data-files-library-entry]');

    /* 回到浅色，再录浅色主流程。 */
    await js("localStorage.setItem('oa-theme','light'); return 'ok'");
    await win.webContents.reload();
    await waitFn("document.readyState==='complete' && !!window.openarc", 60000);
    await sleep(500);
    await ensureReady();

    /* 连续录屏从这里开始：覆盖"打开访达 → 选中 → 加入资源库 → 导出 → 失败/取消"。 */
    startRecording();

    /* 打开访达（dock id=files） */
    await click('[data-dock-id="files"]');
    const folderOk = await waitFn("!!document.querySelector('.folder-body[data-drop-folder=desktop]')", 15000);
    const paneTitle = await js("var t=document.querySelector('.pane-toolbar .pane-title'); return t ? t.textContent : ''");
    check("P2 · 访达窗口打开桌面文件夹视图", folderOk && paneTitle === "桌面", "title=" + paneTitle);

    const cellOk = await waitFn("!!document.querySelector('.file-cell[data-entry-id=" + JSON.stringify(goodEntry.id) + "]')", 15000);
    check("P3 · 种子文件出现在访达（真实 file-service 条目）", cellOk, "id=" + goodEntry.id);

    /* 记录基线 console / network（此前的启动期也计入最终断言）。 */

    /* S1 · 未选中：入口禁用 + 明确原因 */
    const s1 = await entryState();
    check(
      "S1 · 未选中：资源库入口禁用且给出原因",
      !!s1 && s1.disabled === true && s1.state === "disabled" && s1.title.indexOf("先选择") >= 0,
      JSON.stringify(s1),
    );

    /* S2 · 选中文件：入口可用 */
    const picked = await selectCell(goodEntry.id);
    await sleep(200);
    const s2 = await entryState();
    check("S2 · 选中文件：资源库入口可用", picked !== "missing" && !!s2 && s2.disabled === false && s2.state === "enabled", "picked=" + picked + " " + JSON.stringify(s2));

    /* S3 · 菜单含 5 个入口，未入资源库时「导出资源」禁用且有原因 */
    const items = await openLibraryMenu();
    const ids = items.map((it) => it.id).sort();
    check(
      "S3 · 菜单含 5 个资源库入口",
      ["lib-add-linked", "lib-add-managed", "lib-export-computer", "lib-export-resource", "lib-reveal-source"].every((x) => ids.indexOf(x) >= 0),
      JSON.stringify(ids),
    );
    const exportRes = items.find((it) => it.id === "lib-export-resource");
    const revealSrc = items.find((it) => it.id === "lib-reveal-source");
    check(
      "S4 · 未入资源库时「导出资源 / 显示源文件」禁用且原因可见",
      !!exportRes && exportRes.disabled === true && exportRes.label.indexOf("尚未加入资源库") >= 0 && !!revealSrc && revealSrc.disabled === true && revealSrc.label.indexOf("链接") >= 0,
      JSON.stringify({ exportRes, revealSrc }),
    );
    await shot("files-library-menu-light");

    /* S5 · 进行中：aria-busy + 入口 disabled + 状态 busy（真实延迟导入） */
    await click('[data-menu-id="lib-add-managed"]');
    await sleep(120);
    const busyEntry = await entryState();
    const busyStatus = await statusState();
    check(
      "S5 · 进行中：入口 disabled + aria-busy + 可见 busy 状态",
      !!busyEntry && busyEntry.disabled === true && busyEntry.busy === "true" && !!busyStatus && busyStatus.kind === "busy",
      JSON.stringify({ busyEntry, busyStatus }),
    );
    await shot("files-library-busy-light");

    /* S6 · 加入资源库（Managed）成功 */
    const okStatus = await waitStatus("ok", 20000);
    const addStatus = await statusState();
    const listAfter = resource.list({ context: { sessionRef: identity.service.current, appId: "resource-library" } });
    const managedRow = (listAfter.items || []).find((r) => r.name === goodEntry.name);
    check(
      "S6 · 加入资源库成功：状态可见 + 文案说清落点 + 主进程真实入库",
      okStatus && !!addStatus && addStatus.text.indexOf("资源库") >= 0 && !!managedRow && managedRow.storageMode === "MANAGED",
      JSON.stringify({ status: addStatus, count: listAfter.count, managed: managedRow && managedRow.storageMode }),
    );
    slowImports = false;

    /* S7 · 加入后「导出资源」可用 */
    const items2 = await openLibraryMenu();
    const exportRes2 = items2.find((it) => it.id === "lib-export-resource");
    check("S7 · 加入资源库后「导出资源」变为可用", !!exportRes2 && exportRes2.disabled === false, JSON.stringify(exportRes2));
    await click('[data-menu-id="lib-export-resource"]');
    const expOk = await waitStatus("ok", 15000);
    const expStatus = await statusState();
    const exportedText = fs.existsSync(saveTarget) ? fs.readFileSync(saveTarget, "utf8") : null;
    check(
      "S8 · 导出资源为普通文件成功：落盘内容与源一致 + 状态可见",
      expOk && !!expStatus && exportedText === "seed-content-for-library\n",
      JSON.stringify({ status: expStatus, bytes: exportedText ? exportedText.length : null }),
    );

    /* S9 · 导出到电脑成功（走既有 files.exportTo） */
    const items3 = await openLibraryMenu();
    const exportPc = items3.find((it) => it.id === "lib-export-computer");
    check("S9 · 「导出到电脑」在有文件选中时可用", !!exportPc && exportPc.disabled === false, JSON.stringify(exportPc));
    await click('[data-menu-id="lib-export-computer"]');
    const pcOk = await waitStatus("ok", 15000);
    const pcStatus = await statusState();
    const exportedFiles = fs.existsSync(exportDir) ? fs.readdirSync(exportDir) : [];
    check(
      "S10 · 导出到电脑成功：真实落盘 + 反馈含落点",
      pcOk && !!pcStatus && exportedFiles.length >= 1 && pcStatus.text.indexOf(exportDir) >= 0,
      JSON.stringify({ status: pcStatus, files: exportedFiles }),
    );
    await shot("files-library-success-light");

    /* S11 · 失败：源文件物理缺失 → 结构化错误码 + 人话，且不泄漏路径 */
    fs.unlinkSync(files.resolve("desktop", brokenEntry.id).path);
    await selectCell(brokenEntry.id);
    await sleep(200);
    await openLibraryMenu();
    await click('[data-menu-id="lib-add-managed"]');
    const errOk = await waitStatus("error", 20000);
    const errStatus = await statusState();
    const bodyHtml = await js("return document.body.innerHTML");
    check(
      "S11 · 失败：状态 error + 结构化错误码 + 人话文案",
      errOk && !!errStatus && errStatus.code.length > 0 && errStatus.text.length > 0 && errStatus.text.indexOf(errStatus.code) < 0,
      JSON.stringify(errStatus),
    );
    check(
      "S12 · DOM 不泄漏探针源文件 / userData 路径",
      bodyHtml.indexOf(USER_DATA) < 0 && bodyHtml.indexOf(seedPath) < 0 && bodyHtml.indexOf(saveTarget) < 0,
      "pathHidden",
    );

    /* S13 · 取消：导出到电脑对话框取消 → CANCELLED */
    await selectCell(goodEntry.id);
    await sleep(200);
    dialogState.openCancel = true;
    await openLibraryMenu();
    await click('[data-menu-id="lib-export-computer"]');
    const cancelOk = await waitStatus("error", 15000);
    const cancelStatus = await statusState();
    check("S13 · 取消：状态 error + code=CANCELED + 明确「没有产生变更」", cancelOk && !!cancelStatus && cancelStatus.code === "CANCELED" && cancelStatus.text.indexOf("没有产生变更") >= 0, JSON.stringify(cancelStatus));
    dialogState.openCancel = false;

    const lightShot = report.screenshots.length;
    const totalShots = report.screenshots.length;

    /* S16 · 只发白名单命令 */
    const resourceCmds = report.commands.resource.filter((t) => t.length > 0);
    const badResource = resourceCmds.filter((t) => RENDERER_COMMANDS.indexOf(t) < 0);
    const filesWhitelist = ["files:list", "files:import", "files:rename", "files:remove", "files:trash", "files:trashList", "files:trashRestore", "files:trashPurge", "files:trashEmpty", "files:read", "files:thumb", "files:info", "files:copy", "files:move", "files:export"];
    const badFiles = report.commands.files.filter((t) => filesWhitelist.indexOf(t) < 0);
    check(
      "S15 · 只发白名单命令（resource 白名单 + files 受控面）",
      badResource.length === 0 && badFiles.length === 0 && resourceCmds.indexOf("resource/importFromFiles") >= 0 && report.commands.files.indexOf("files:export") >= 0,
      JSON.stringify({ resource: Array.from(new Set(resourceCmds)), badResource, files: Array.from(new Set(report.commands.files)), badFiles }),
    );

    report.observed = {
      windowUrl: uiURL,
      renderer: DEV ? "OA_DEV_SERVER" : "dist/index.html",
      lightScreenshots: lightShot,
      totalScreenshots: totalShots,
      darkShot: path.relative(ROOT, darkShot),
      goodEntry,
      brokenEntry,
      managedResourceRef: managedRow ? managedRow.resourceRef : null,
    };
  } catch (err) {
    report.errors.push(String((err && err.stack) || err));
    check("探针整体未抛异常", false, String((err && err.message) || err).slice(0, 200));
  } finally {
    try {
      await stopRecording();
      const video = muxRecording();
      report.video = video ? path.relative(ROOT, video) : null;
      report.videoFrames = frameNo;
      check("R1 · 连续录屏产出（真实窗口逐帧）", !!report.video && frameNo >= 4, "frames=" + frameNo + " video=" + report.video);
    } catch (err) {
      report.errors.push("录屏/封装失败：" + String((err && err.message) || err));
    }
    check("R2 · 0 console error", report.console.errors.length === 0, JSON.stringify(report.console.errors.slice(0, 5)) + " total=" + report.console.total);
    check("R3 · 0 非本地请求", report.network.nonLocal.length === 0, JSON.stringify(report.network.nonLocal.slice(0, 5)) + " total=" + report.network.total);
    check("R4 · 隔离 userData 内部真实建库", fs.existsSync(path.join(USER_DATA, "identity.db")), USER_DATA);
    report.isolated.identityDb = fs.existsSync(path.join(USER_DATA, "identity.db"));
    try {
      win?.destroy();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(USER_DATA, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
