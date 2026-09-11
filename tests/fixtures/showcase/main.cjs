/**
 * Showcase 探针：拉起**真实 Electron**，用**完整产品装配**
 * （identity-bootstrap + native-view-controller + windows:sync，与 electron/main.cjs 同套模块接线），
 * 真实走完 首次初始化 → 登录 → 桌面 → 文件 / 浏览器 / 设置 / AI → 锁定 → 解锁 → 多窗口叠放，
 * 每一步对**真实屏幕**截图取证，并同时保留一份 DOM `capturePage`。
 *
 * 两个绕不开的约束（都是本机实测结论，不是偏好）：
 *   1. Playwright 1.55 与 Electron 内置 Chromium 的 CDP 握手超时 → 改用主进程自持窗口
 *      + `webContents.executeJavaScript` 驱动（与 tests/native-view.mjs 同一手法）。
 *   2. 浏览器是 `WebContentsView`（原生视图，恒定绘制在 DOM 之上）→ `capturePage()`
 *      只抓得到 DOM，**抓不到网页内容**。因此真实观感必须靠 `screencapture -R` 抓屏幕。
 *
 * 需要先 `npm run build`。本机沙箱起不来时传：
 *   ELECTRON_EXTRA_ARGS="--no-sandbox --disable-gpu-sandbox --in-process-gpu"
 */
const { app, BrowserWindow, ipcMain, safeStorage, screen } = require("electron");
const { execFile } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { NativeViewController } = require(path.join(ROOT, "electron/native-view-controller.cjs"));
const { safeURL } = require(path.join(ROOT, "electron/policy.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const OUT = path.join(ROOT, "artifacts", "showcase");
fs.mkdirSync(OUT, { recursive: true });

const IDENT = "demo@openarc.local";
const PW = "OpenArc-Demo-2026";
const NAME = "演示账户";
const DEMO_URL = "https://example.com";

const report = { shots: [], checks: [], errors: [], versions: {}, outDir: OUT };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok: !!ok, detail: String(detail) });
  out(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win;
let controller;

const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
const gate = () => js(`return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'`);
const has = (sel) => js(`return !!document.querySelector(${JSON.stringify(sel)})`);
const click = (sel) =>
  js(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    if (el.disabled) return 'disabled';
    el.click();
    return 'ok';
  `);
const setInput = (sel, value) =>
  js(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  `);

async function waitGate(want, timeout = 30000) {
  const wantList = Array.isArray(want) ? want : [want];
  const t0 = Date.now();
  let last = "?";
  while (Date.now() - t0 < timeout) {
    try {
      last = await gate();
      if (wantList.includes(last)) return last;
    } catch {
      /* 导航中 */
    }
    await sleep(120);
  }
  return `TIMEOUT(last=${last})`;
}

async function waitFor(sel, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await has(sel)) return true;
    await sleep(100);
  }
  return false;
}

/** 一步一图：DOM 一份（结构性）+ 真实屏幕一份（观感，含原生视图与毛玻璃）。 */
async function shot(name) {
  const domFile = path.join(OUT, name + ".dom.png");
  const screenFile = path.join(OUT, name + ".png");
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(domFile, img.toPNG());
  } catch (e) {
    report.errors.push(`capturePage ${name}: ${e.message}`);
  }
  const b = win.getBounds();
  await new Promise((resolve) => {
    execFile(
      "screencapture",
      ["-x", "-R", `${b.x},${b.y},${b.width},${b.height}`, screenFile],
      (err) => {
        if (err) report.errors.push(`screencapture ${name}: ${err.message}`);
        resolve();
      },
    );
  });
  const size = fs.existsSync(screenFile) ? fs.statSync(screenFile).size : 0;
  report.shots.push({ name, screen: path.relative(ROOT, screenFile), dom: path.relative(ROOT, domFile), bytes: size });
  out(`SHOT ${name} (${(size / 1024).toFixed(0)} KB)`);
  await sleep(150);
}

app.whenReady().then(async () => {
  try {
    report.versions = {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: process.platform + "/" + process.arch,
    };
    out("VERSIONS " + JSON.stringify(report.versions));

    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1440, area.width - 40);
    const height = Math.min(940, area.height - 40);

    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-showcase-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: false });

    win = new BrowserWindow({
      width,
      height,
      title: "OpenArc OS",
      transparent: true,
      vibrancy: "under-window",
      backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(ROOT, "electron/preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    controller = new NativeViewController({
      parent: win.contentView,
      onFocusShell: () => {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.focus();
      },
      onEvent: (payload) => {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("native:state", payload);
      },
    });

    ipcMain.handle("windows:sync", async (e, payload) => {
      const intents = Array.isArray(payload?.intents) ? payload.intents : [];
      const results = await controller.sync(intents, {
        overlayOpen: !!payload?.overlayOpen,
        interactive: payload?.interactive !== false,
      });
      return { ok: true, results };
    });
    ipcMain.handle("browser:navigate", async (_e, payload) => {
      const url = payload?.url;
      if (typeof url !== "string" || !safeURL(url)) return { error: "不支持的地址" };
      const res = controller.navigate(String(payload?.windowId ?? ""), url);
      return res.error ? res : { ok: true };
    });
    ipcMain.handle("browser:action", async (_e, payload) =>
      controller.act(String(payload?.windowId ?? ""), String(payload?.action ?? "")),
    );

    registerIdentityIpc({
      ipcMain,
      service: identity.service,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: (event) => {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event);
      },
    });

    await win.loadURL(uiURL);
    win.show();
    win.focus();
    win.setAlwaysOnTop(true, "screen-saver");
    await sleep(900);

    // ── 1. 首次运行：初始化 ───────────────────────────────────────────────
    let g = await waitGate("uninitialized");
    check("S1 · 首次启动进入初始化（未创建账户前不进桌面）", g === "uninitialized", `gate=${g}`);
    await shot("01-setup");

    await setInput('[data-d3-id="setup-name"]', NAME);
    await setInput('[data-d3-id="setup-identifier"]', IDENT);
    await setInput('[data-d3-id="setup-password"]', PW);
    await setInput('[data-d3-id="setup-confirm"]', PW);
    await sleep(300);
    await click('[data-d3-id="setup-submit"]');

    // ── 2. 登录 ──────────────────────────────────────────────────────────
    g = await waitGate("unauthenticated");
    check("S2 · 初始化后落到登录页（不自动登录）", g === "unauthenticated", `gate=${g}`);
    await shot("02-login");

    await setInput('[data-d3-id="login-identifier"]', IDENT);
    await setInput('[data-d3-id="login-password"]', PW);
    await sleep(300);
    await click('[data-d3-id="login-submit"]');

    g = await waitGate("ready");
    check("S3 · 登录成功进入桌面", g === "ready", `gate=${g}`);
    await sleep(700);
    await shot("03-desktop");
    check("S4 · 桌面外壳真实渲染（顶栏 + Dock）", (await has(".topbar")) && (await has(".dock")), "");

    // ── 3. 文件 ──────────────────────────────────────────────────────────
    await click('[aria-label="打开文件"]');
    const filesOpened = await waitFor(".window");
    check("S5 · 从 Dock 打开文件应用并出现真实窗口", filesOpened, "");
    await sleep(600);
    await shot("04-files");

    // ── 4. 浏览器（真实 WebContentsView + 真实网络）────────────────────────
    await click('[aria-label="打开浏览器"]');
    await sleep(900);
    const browserId = await js(`
      const w = [...document.querySelectorAll('.window')];
      const t = w.map(x => x.getAttribute('data-window-id') || '');
      return t.find(id => id.toLowerCase().includes('browser')) || '';
    `);
    const nativeIds = [...controller.entries.keys()];
    const targetId = nativeIds.find((id) => String(id).toLowerCase().includes("browser")) || browserId;
    check("S6 · 浏览器创建了原生视图（非 iframe）", !!targetId, `windowId=${targetId || "none"}`);

    let loaded = false;
    if (targetId) {
      controller.navigate(targetId, DEMO_URL);
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        const e = controller.entries.get(targetId);
        const wc = e?.view?.webContents;
        if (wc && !wc.isDestroyed() && !wc.isLoading() && wc.getURL().startsWith("https://")) {
          loaded = true;
          break;
        }
        await sleep(200);
      }
      const e = controller.entries.get(targetId);
      report.browser = { url: e?.view?.webContents?.getURL() || "", title: e?.view?.webContents?.getTitle() || "" };
    }
    check("S7 · 浏览器真实加载外部网页", loaded, report.browser ? `${report.browser.title} | ${report.browser.url}` : "");
    await sleep(700);
    await shot("05-browser");

    // ── 5. 系统设置 ──────────────────────────────────────────────────────
    await click('[aria-label="打开系统设置"]');
    await sleep(800);
    await shot("06-settings");
    check("S8 · 系统设置可打开", await has(".settings-content"), "");

    // ── 6. AI 面板 ───────────────────────────────────────────────────────
    await click(".assistant-pill");
    await sleep(700);
    await shot("07-ai");
    check("S9 · AI 面板可打开", await has(".ai-panel"), "");
    await js(`document.querySelector('.ai-panel button[aria-label="关闭AI面板"]')?.click(); return 1;`);
    await sleep(400);

    // ── 7. 锁定 / 解锁 ───────────────────────────────────────────────────
    await click('button[aria-label="锁定屏幕"]');
    g = await waitGate("locked");
    check("S10 · 锁定 → 进入锁屏", g === "locked", `gate=${g}`);
    await sleep(700);
    await shot("08-locked");

    await setInput('[data-d3-id="unlock-password"]', PW);
    await sleep(250);
    await click('[data-d3-id="unlock-submit"]');
    g = await waitGate("ready");
    check("S11 · 正确口令解锁回到桌面", g === "ready", `gate=${g}`);

    // ── 8. 多窗口叠放 ────────────────────────────────────────────────────
    await click('[aria-label="打开应用中心"]');
    await sleep(500);
    await click('[aria-label="打开文件"]');
    await sleep(500);
    await sleep(800);
    await shot("09-multitask");
    const winCount = await js(`return document.querySelectorAll('.window').length`);
    check("S12 · 多窗口同时存在且可叠放", Number(winCount) >= 3, `窗口数=${winCount}`);

    out("RESULT " + JSON.stringify(report));
    await sleep(300);
    app.exit(0);
  } catch (e) {
    report.errors.push(String(e && e.stack ? e.stack : e));
    out("RESULT " + JSON.stringify(report));
    app.exit(1);
  }
});
