/**
 * React 画布截图探针（真实 Electron，隔离 profile）。
 *
 * 为什么不是 Playwright：本机 Playwright 与 Electron 内置 Chromium 的 CDP 握手超时，
 * 沿用 tests/identity-ui.mjs 已验证的做法——主进程自持窗口 + webContents.executeJavaScript 驱动。
 *
 * 装配复用 electron/identity-bootstrap.cjs + electron/preload.cjs + dist/index.html，
 * 与产品主进程同一条接线；身份数据只落在本探针自己的临时 profile 里，
 * 账号是测试现场新建的，不读取任何用户凭据。
 *
 * 本机沙箱起不来时由外层脚本传 ELECTRON_EXTRA_ARGS。
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const SHOT = path.join(ROOT, "artifacts/tapnow-parity/react-canvas/50-desktop-canvas.png");
const IDENT = "react-canvas-shot@openarc.local";
const PW = "react-canvas-shot-password-1";
const NAME = "Canvas Shot";

const report = { checks: [], errors: [], versions: {}, diagnostics: {} };
const out = function (line) { process.stdout.write(line + "\n"); };
const check = function (name, ok, detail) {
  report.checks.push({ name: name, ok: !!ok, detail: String(detail === undefined ? "" : detail) });
  out((ok ? "PASS " : "FAIL ") + name + (detail ? " :: " + detail : ""));
};
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

let win;
let profileDir = null;

const js = function (code) { return win.webContents.executeJavaScript("(async () => { " + code + " })()"); };
const gate = function () { return js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'"); };
const has = function (sel) { return js("return !!document.querySelector(" + JSON.stringify(sel) + ")"); };
const text = function (sel) { return js("return (document.querySelector(" + JSON.stringify(sel) + ")?.textContent || '').trim()"); };

async function waitGate(want, timeout) {
  timeout = timeout || 30000;
  const wantList = Array.isArray(want) ? want : [want];
  const t0 = Date.now();
  let last = "?";
  while (Date.now() - t0 < timeout) {
    try {
      last = await gate();
      if (wantList.includes(last)) return last;
    } catch (e) {
      /* 导航中 */
    }
    await sleep(120);
  }
  return "TIMEOUT(last=" + last + ")";
}

async function waitEnabled(sel, timeout) {
  timeout = timeout || 8000;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const disabled = await js("return !!document.querySelector(" + JSON.stringify(sel) + ")?.disabled");
    if (disabled === false) return true;
    await sleep(80);
  }
  return false;
}

async function waitFor(sel, timeout) {
  timeout = timeout || 8000;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await has(sel)) return true;
    await sleep(60);
  }
  return false;
}

const setInput = function (sel, value) {
  return js(
    "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
    "if (!el) return 'missing';" +
    "const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;" +
    "setter.call(el, " + JSON.stringify(value) + ");" +
    "el.dispatchEvent(new Event('input', { bubbles: true }));" +
    "return 'ok';"
  );
};

const click = function (sel) {
  return js(
    "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
    "if (!el) return 'missing';" +
    "if (el.disabled) return 'disabled';" +
    "el.click();" +
    "return 'ok';"
  );
};

app.whenReady().then(async function () {
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform + "/" + process.arch };
    out("VERSIONS " + JSON.stringify(report.versions));

    // 隔离 profile：身份库 + Chromium 自身的 userData/sessionData 全指向临时目录，
    // 绝不落到 ~/Library/Application Support 下的真实用户数据。
    profileDir = fs.mkdtempSync(path.join(ROOT, ".tmp-react-canvas-shot-"));
    app.setPath("userData", path.join(profileDir, "chromium"));
    app.setPath("sessionData", path.join(profileDir, "chromium"));
    const identity = createIdentityService({ userDataDir: path.join(profileDir, "identity"), safeStorage: safeStorage, allowAdmin: true });

    win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: true,
      backgroundColor: "#0f1012",
      webPreferences: {
        preload: path.join(ROOT, "electron/preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    // 探针不验证窗口系统：页面照常下发窗口意图，缺 handler 的拒绝会在 stderr 刷屏掩盖真错。
    ipcMain.handle("windows:sync", async function () { return { ok: true, results: [] }; });
    ipcMain.handle("browser:navigate", async function () { return { ok: true }; });
    ipcMain.handle("browser:action", async function () { return { ok: true }; });

    // 画布 bridge 命令（canvas:command 等）由产品 main.cjs 注册；本探针不启动完整主进程，
    // 所以按 preload 暴露的通道名注册**测试专用最小实现**，让 picker 能走
    // 「canvas/create → 工作区」这条产品路径。仅存在于探针进程，不改产品代码。
    const preloadSrc = fs.readFileSync(path.join(ROOT, "electron/preload.cjs"), "utf8");
    const canvasChannels = Array.from(new Set((preloadSrc.match(/"canvas:[a-zA-Z]+"/g) || []).map(function (s) { return s.slice(1, -1); })));
    out("CANVAS_CHANNELS " + JSON.stringify(canvasChannels));
    canvasChannels.forEach(function (channel) {
      ipcMain.handle(channel, async function (_event, payload) {
        const type = payload && payload.type;
        if (type === "canvas/list") return { ok: true, items: [] };
        if (type === "canvas/create") {
          return { ok: true, canvas: { canvasId: "shot-canvas", title: (payload && payload.title) || "截图画布" } };
        }
        return { ok: true };
      });
    });

    registerIdentityIpc({
      ipcMain: ipcMain,
      service: identity.service,
      isTrusted: function (e) { return e.sender === win.webContents && e.senderFrame?.url === uiURL; },
      send: function (event) {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event);
      },
    });

    const consoleErrors = [];
    win.webContents.on("console-message", function (_e, level, message) {
      if (level >= 2) consoleErrors.push(String(message).slice(0, 300));
    });

    await win.loadURL(uiURL);
    await sleep(400);

    // ── 首次初始化 → 登录（与 tests/identity-ui.mjs 同一路径）──────────────
    let g = await waitGate("uninitialized");
    check("首次启动进入初始化界面", g === "uninitialized", "gate=" + g);
    await setInput('[data-d3-id="setup-name"]', NAME);
    await waitEnabled('[data-d3-id="setup-next"]');
    await click('[data-d3-id="setup-next"]');
    await waitFor('[data-d3-id="setup-identifier"]');
    await setInput('[data-d3-id="setup-identifier"]', IDENT);
    await waitEnabled('[data-d3-id="setup-next"]');
    await click('[data-d3-id="setup-next"]');
    await waitFor('[data-d3-id="setup-password"]');
    await setInput('[data-d3-id="setup-password"]', PW);
    await setInput('[data-d3-id="setup-confirm"]', PW);
    await waitEnabled('[data-d3-id="setup-submit"]');
    await click('[data-d3-id="setup-submit"]');
    g = await waitGate("unauthenticated");
    check("初始化完成进入登录页", g === "unauthenticated", "gate=" + g);

    await setInput('[data-d3-id="login-identifier"]', IDENT);
    await setInput('[data-d3-id="login-password"]', PW);
    await waitEnabled('[data-d3-id="login-submit"]');
    await click('[data-d3-id="login-submit"]');
    g = await waitGate("ready");
    check("登录成功进入桌面", g === "ready", "gate=" + g);

    // ── 打开 canvas 窗口（DOM 窗口层；src/main.tsx 对 appId=canvas 挂 ReactCanvasApp）──
    const opened = await js(
      "const el = document.querySelector('[aria-label=\"打开AI Studio\"]') || document.querySelector('[aria-label=\"打开无限画布\"]');" +
      "if (!el) return 'missing';" +
      "el.click();" +
      "return 'clicked';"
    );
    check("点击 Dock 打开 AI Studio 窗口", opened === "clicked", opened);

    const canvasRoot = '[data-testid="canvas-picker"], [data-testid="tool-add"]';
    const rendered = await waitFor(canvasRoot, 20000);
    check("canvas 窗口渲染 ReactCanvasApp（picker / 工作区）", rendered, canvasRoot);

    // 新画布窗口先落在「画布选择器」：新建一本才进工作区（左工具栏 / 画布 / 右助手）。
    const created = await js(
      "const el = document.querySelector('[data-testid=\"canvas-create\"]');" +
      "if (!el) return 'missing';" +
      "el.click();" +
      "return 'clicked';"
    );
    check("新建画布进入工作区", created === "clicked", created);
    const workspaceReady = await waitFor('[data-testid="tool-add"]', 15000);
    check("React 画布工作区渲染（左工具栏 tool-add）", workspaceReady, "tool-add");
    await sleep(800);

    const diag = await js(
      "const root = document.querySelector('[data-testid=\"react-canvas-app\"]');" +
      "const ids = Array.from(document.querySelectorAll('[data-testid]')).map(function (n) { return n.getAttribute('data-testid'); }).slice(0, 80);" +
      "const body = (document.body.innerText || '').replace(/[ \\t\\r\\n]+/g, ' ').slice(0, 600);" +
      "return JSON.stringify({ hasRoot: !!root, hasIframe: !!document.querySelector('[data-canvas-frame], iframe.canvas-host-frame'), testids: ids, body: body });"
    );
    report.diagnostics = JSON.parse(diag);
    check("画布不是旧 iframe 宿主", report.diagnostics.hasIframe === false, "iframe=" + report.diagnostics.hasIframe);
    check("左工具栏按钮存在（tool-add）", report.diagnostics.testids.indexOf("tool-add") >= 0, JSON.stringify(report.diagnostics.testids).slice(0, 400));
    const rightAssistant = /助手|Agent|assistant/i.test(report.diagnostics.body);
    check("右侧助手面板可见（正文含助手文案）", rightAssistant, report.diagnostics.body.slice(0, 200));

    // 补一张小地图截图：先在画布上加两个图片节点，再展开小地图
    await click('[data-testid="tool-add"]');
    await sleep(250);
    await click('[data-testid="add-image"]');
    await sleep(500);
    await click('[data-testid="tool-add"]');
    await sleep(250);
    await click('[data-testid="add-image"]');
    await sleep(500);
    await click('[data-testid="minimap-toggle"]');
    await sleep(600);
    const miniReady = await waitFor('[data-testid="minimap"]', 5000);
    check("小地图浮层在桌面窗口展开", miniReady, "minimap");
    const miniImage = await win.webContents.capturePage();
    const miniPng = miniImage.toPNG();
    const MINISHOT = path.join(ROOT, "artifacts/tapnow-parity/react-canvas/84-desktop-minimap.png");
    fs.mkdirSync(path.dirname(MINISHOT), { recursive: true });
    fs.writeFileSync(MINISHOT, miniPng);
    check("桌面小地图截图已写出（84-desktop-minimap.png）", miniPng.length > 20000, String(miniPng.length));

    // 新控件条：收起小地图，打开隐藏连线 + 网格吸附两个 toggle 后截图
    await click('[data-testid="minimap-toggle"]');
    await sleep(250);
    await click('[data-testid="toggle-edges"]');
    await sleep(200);
    await click('[data-testid="toggle-grid"]');
    await sleep(400);
    const controlsImage = await win.webContents.capturePage();
    const controlsPng = controlsImage.toPNG();
    const CONTROLSSHOT = path.join(ROOT, "artifacts/tapnow-parity/react-canvas/51-desktop-controls.png");
    fs.mkdirSync(path.dirname(CONTROLSSHOT), { recursive: true });
    fs.writeFileSync(CONTROLSSHOT, controlsPng);
    check("桌面新控件条截图已写出（51-desktop-controls.png）", controlsPng.length > 20000, String(controlsPng.length));

    // 打开添加节点菜单，截 52
    await click('[data-testid="tool-add"]');
    await sleep(500);
    const addMenuReady = await waitFor('[data-testid="add-menu"]', 5000);
    check("桌面添加节点菜单展开", addMenuReady, "add-menu");
    const addMenuImage = await win.webContents.capturePage();
    const addMenuPng = addMenuImage.toPNG();
    const ADDMENUSHOT = path.join(ROOT, "artifacts/tapnow-parity/react-canvas/52-desktop-add-menu.png");
    fs.mkdirSync(path.dirname(ADDMENUSHOT), { recursive: true });
    fs.writeFileSync(ADDMENUSHOT, addMenuPng);
    check("桌面添加菜单截图已写出（52-desktop-add-menu.png）", addMenuPng.length > 20000, String(addMenuPng.length));

    // 关闭菜单后截整窗新视觉
    await click('[data-testid="tool-add"]');
    await sleep(400);
    const lookImage = await win.webContents.capturePage();
    const lookPng = lookImage.toPNG();
    const LOOKSHOT = path.join(ROOT, "artifacts/tapnow-parity/react-canvas/53-desktop-look.png");
    fs.writeFileSync(LOOKSHOT, lookPng);
    check("桌面新视觉截图已写出（53-desktop-look.png）", lookPng.length > 20000, String(lookPng.length));

    await js(
      "const el = document.querySelector('[data-kind=\"image\"]');" +
        "if (!el) return 'missing';" +
        "const r = el.getBoundingClientRect();" +
        "const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 11, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };" +
        "el.dispatchEvent(new PointerEvent('pointerdown', opts));" +
        "el.dispatchEvent(new PointerEvent('pointerup', opts));" +
        "return 'ok';"
    );
    await sleep(700);
    const selImage = await win.webContents.capturePage();
    const selPng = selImage.toPNG();
    const SELSHOT = path.join(ROOT, "artifacts/tapnow-parity/react-canvas/54-desktop-selected.png");
    fs.writeFileSync(SELSHOT, selPng);
    check("桌面选中节点截图已写出（54-desktop-selected.png）", selPng.length > 20000, String(selPng.length));

    await click('[data-testid="tool-search"]');
    await sleep(500);
    const searchImage = await win.webContents.capturePage();
    const searchPng = searchImage.toPNG();
    const SEARCHSHOT = path.join(ROOT, "artifacts/tapnow-parity/react-canvas/55-desktop-search.png");
    fs.writeFileSync(SEARCHSHOT, searchPng);
     check("桌面搜索面板截图已写出（55-desktop-search.png）", searchPng.length > 20000, String(searchPng.length));

    await js(
      "const original = window.openarc && window.openarc.canvas;" +
        "window.__probeAssetOriginal = original;" +
        "window.openarc = window.openarc || {};" +
        "window.openarc.canvas = { command: async (request) => {" +
        "  if (request.type === 'canvas/assetLibrary/list') return { ok: true, libraries: [{ id: 'probe-lib', name: '探针素材库', visibility: 'PRIVATE', access: 'owner', itemCount: 2 }] };" +
        "  if (request.type === 'canvas/assetLibrary/ensure') return { ok: true, library: { id: 'probe-lib', name: '探针素材库' } };" +
        "  if (request.type === 'canvas/assetLibrary/get') return { ok: true, library: { id: 'probe-lib', name: '探针素材库' }, items: [{ id: 'p1', title: '探针图片', kind: 'asset', mediaKind: 'image' }, { id: 't1', kind: 'prompt', title: '角色模板', prompt: '生成角色三视图', promptRole: 'image', sourceKey: 'system:image', createdBy: 'system' }, { id: 't2', kind: 'prompt', title: '我的模板', prompt: '我的提示词', promptRole: 'image', sourceKey: 'custom:1', createdBy: 'u1' }] };" +
        "  if (request.type === 'canvas/shares') return { ok: true, canvasId: 'shot-canvas', visibility: 'PRIVATE', owner: { userId: 'u0', displayName: 'Owner', username: 'owner', status: 'ACTIVE' }, shares: [{ userId: 'u1', displayName: 'Alice', role: 'EDITOR', status: 'ACTIVE' }], shareCount: 1, canManage: true, access: { canManage: true, source: 'OWNER_POLICY' } };" +
        "  if (request.type === 'canvas/list') return { ok: true, items: [{ id: 'shot-canvas', title: 'Canvas Shot', updatedAt: 1700000002000 }, { id: 'canvas-b', title: '其他画布', updatedAt: 1700000001000 }] };" +
        "  if (request.type === 'canvas/get') return { ok: true, canvas: { revision: 1, doc: { nodes: [], connections: [] } } };" +
        "  return { ok: false, error: 'PROBE_UNHANDLED' };" +
        "} };"
    );
    await click('[data-testid="tool-assets"]');
    await sleep(600);
    const assetsImage = await win.webContents.capturePage();
    const assetsPng = assetsImage.toPNG();
    const ASSETSHOT = path.join(ROOT, "artifacts/tapnow-parity/react-canvas/56-desktop-assets.png");
    fs.writeFileSync(ASSETSHOT, assetsPng);
    check("桌面素材库截图已写出（56-desktop-assets.png，探针 stub 数据）", assetsPng.length > 20000, String(assetsPng.length));

    await click('[data-testid="tool-comments"]');
    await sleep(400);
    await js(
      "const viewport = document.querySelector('[data-testid=\"canvas-viewport\"]');" +
        "if (!viewport) return 'missing';" +
        "const r = viewport.getBoundingClientRect();" +
        "const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 21, clientX: r.x + r.width - 240, clientY: r.y + r.height - 180 };" +
        "viewport.dispatchEvent(new PointerEvent('pointerdown', opts));" +
        "viewport.dispatchEvent(new PointerEvent('pointerup', opts));" +
        "return 'ok';"
    );
    await sleep(500);
    const commentImage = await win.webContents.capturePage();
    const commentPng = commentImage.toPNG();
    const COMMENTSHOT = path.join(ROOT, "artifacts/tapnow-parity/react-canvas/57-desktop-comments.png");
    fs.writeFileSync(COMMENTSHOT, commentPng);
    check("桌面评论模式截图已写出（57-desktop-comments.png）", commentPng.length > 20000, String(commentPng.length));
    await click('[data-testid="tool-history"]');
    await sleep(600);
    const historyImage = await win.webContents.capturePage();
    const historyPng = historyImage.toPNG();
    const HISTORYSHOT = path.join(ROOT, "artifacts/tapnow-parity/react-canvas/58-desktop-history.png");
    fs.writeFileSync(HISTORYSHOT, historyPng);
    check("桌面历史面板截图已写出（58-desktop-history.png，探针 stub 数据）", historyPng.length > 20000, String(historyPng.length));

    await click('[data-testid="share-open"]');
    await sleep(700);
    const shareImage = await win.webContents.capturePage();
    const sharePng = shareImage.toPNG();
    const SHARESHOT = path.join(ROOT, "artifacts/tapnow-parity/react-canvas/59-desktop-share.png");
    fs.writeFileSync(SHARESHOT, sharePng);
    check("桌面共享面板截图已写出（59-desktop-share.png，探针 stub 数据）", sharePng.length > 20000, String(sharePng.length));

    await click('[data-testid="canvas-title-button"]');
    await sleep(500);
    const switchImage = await win.webContents.capturePage();
    const switchPng = switchImage.toPNG();
    const SWITCHSHOT = path.join(ROOT, "artifacts/tapnow-parity/react-canvas/60-desktop-switch.png");
    fs.writeFileSync(SWITCHSHOT, switchPng);
    check("桌面画布切换截图已写出（60-desktop-switch.png，探针 stub 数据）", switchPng.length > 20000, String(switchPng.length));

    await click('[data-testid="tool-templates"]');
    await sleep(700);
    const tplImage = await win.webContents.capturePage();
    const tplPng = tplImage.toPNG();
    const TPLSHOT = path.join(ROOT, "artifacts/tapnow-parity/react-canvas/61-desktop-templates.png");
    fs.writeFileSync(TPLSHOT, tplPng);
    check("桌面模板面板截图已写出（61-desktop-templates.png，探针 stub 数据）", tplPng.length > 20000, String(tplPng.length));

    await js("if (window.__probeAssetOriginal && window.openarc) window.openarc.canvas = window.__probeAssetOriginal;");

    await sleep(1200);
    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, png);
    report.screenshot = { path: path.relative(ROOT, SHOT), bytes: png.length, size: image.getSize() };
    check("截图已写出", png.length > 20000, JSON.stringify(report.screenshot));
    if (consoleErrors.length) report.diagnostics.consoleErrors = consoleErrors.slice(-20);
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e && e.message).slice(0, 300));
  } finally {
    try {
      if (win) win.destroy();
    } catch (e) {
      /* ignore */
    }
    if (profileDir) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch (e) {
        /* ignore */
      }
    }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});

app.on("window-all-closed", function () { app.quit(); });
