/**
 * Vue 设置应用迁移探针（真实 Electron + 产品真实页面 / preload / 身份装配）。
 *
 * 与 experiments/vue-wiring/main.cjs 同一手法：主进程自持窗口 + executeJavaScript，
 * 页面是 dist/vue.html，preload 与 identity-bootstrap 都是产品那一条线。
 *
 * 覆盖：
 *   · 打开系统设置 → 默认停在「外观与交互」（data-settings-active="appearance"）
 *   · 三个 pane 导航：appearance / model / devices 切换后 data-settings-active 同步
 *   · appearance 控件顺序（硬要求）与 .material-select 探针钩子
 *   · model pane 的既有 data-d4-01-* 契约（tabs / panes / provider-* / model-* / defaults-*）
 *   · device pane 的既有 data-device-* 契约
 *   · 全程没有 console error / 渲染进程崩溃
 *   · 三个 pane 各抓一张截图到 artifacts/vue-settings/
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/vue.html")).href;
const OUT = path.join(ROOT, "artifacts", "vue-settings");
const IDENT = "vue-settings@openarc.local";
const PW = "vue-settings-password-1";
const NAME = "Vue Settings";

/** 系统设置窗口锚点：产品常驻所有窗口 DOM，.split / .split-side 这类全局查询会跨窗口串味。 */
const SETTINGS_WIN = '.window[aria-label="系统设置窗口"]';

const report = { checks: [], errors: [], consoleErrors: [], shots: [], versions: {} };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok: !!ok, detail: String(detail) });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win;
let userData = null;

const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const has = (sel) => js(`return !!document.querySelector(${JSON.stringify(sel)})`);
const text = (sel) => js(`return (document.querySelector(${JSON.stringify(sel)})?.textContent || '').trim()`);
const attr = (sel, name) => js(`return document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(name)}) || null`);
const count = (sel) => js(`return document.querySelectorAll(${JSON.stringify(sel)}).length`);

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
  return "TIMEOUT(last=" + last + ")";
}
async function waitFor(sel, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await has(sel)) return true;
    await sleep(60);
  }
  return false;
}
async function waitAttr(sel, name, value, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await attr(sel, name)) === value) return true;
    await sleep(60);
  }
  return false;
}
async function waitEnabled(sel, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const disabled = await js(`return !!document.querySelector(${JSON.stringify(sel)})?.disabled`);
    if (disabled === false) return true;
    await sleep(80);
  }
  return false;
}
const setInput = (sel, value) =>
  js(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  `);
const click = (sel) =>
  js(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    if (el.disabled) return 'disabled';
    el.click();
    return 'ok';
  `);

async function shoot(name) {
  await sleep(500);
  const image = await win.webContents.capturePage();
  const file = path.join(OUT, name);
  fs.writeFileSync(file, image.toPNG());
  report.shots.push(file);
  out("SHOT " + file + " " + image.getSize().width + "x" + image.getSize().height);
}

app.whenReady().then(async () => {
  try {
    report.versions = {
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform + "/" + process.arch,
    };
    out("VERSIONS " + JSON.stringify(report.versions));
    fs.mkdirSync(OUT, { recursive: true });

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-vue-settings-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true });

    win = new BrowserWindow({
      width: 1280,
      height: 860,
      show: false,
      webPreferences: {
        preload: path.join(ROOT, "electron/preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    // 浏览器控制台的错误是本次验收的硬指标之一：逐条收集。
    win.webContents.on("console-message", (...args) => {
      try {
        const first = args[0];
        let level;
        let message;
        if (first && typeof first === "object" && "level" in first) {
          level = first.level;
          message = first.message;
        } else {
          level = args[1];
          message = args[2];
        }
        if (level === "error" || level === 3 || level === "3") report.consoleErrors.push(String(message));
      } catch {
        /* 事件形状变化不影响主流程 */
      }
    });
    win.webContents.on("render-process-gone", (_e, details) => {
      report.errors.push("render-process-gone: " + JSON.stringify(details));
    });
    win.webContents.on("did-fail-load", (_e, code, desc) => {
      report.errors.push("did-fail-load: " + code + " " + desc);
    });

    // 与产品同一条接线；文件 IPC 走最小真实实现（空 wallpapers 目录），不伪造条目。
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    ipcMain.handle("files:list", async () => ({ ok: true, entries: [] }));
    ipcMain.handle("files:import", async () => ({ ok: true, added: [] }));
    ipcMain.handle("files:remove", async () => ({ ok: true }));

    registerIdentityIpc({
      ipcMain,
      service: identity.service,
      authorization: identity.authorization,
      device: identity.deviceService,
      model: identity.modelService,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: (event) => {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event);
      },
    });

    await win.loadURL(uiURL);
    await sleep(400);

    // ── 初始化 + 登录（与 vue-wiring 探针同一路径）────────────────────────
    let g = await waitGate("uninitialized");
    check("S0 · 首次启动进入初始化界面", g === "uninitialized", "gate=" + g);
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

    await waitGate("unauthenticated");
    await setInput('[data-d3-id="login-identifier"]', IDENT);
    await setInput('[data-d3-id="login-password"]', PW);
    await waitEnabled('[data-d3-id="login-submit"]');
    await click('[data-d3-id="login-submit"]');
    g = await waitGate("ready");
    check("S0b · 登录进入桌面", g === "ready", "gate=" + g);

    // ── 1. 打开系统设置：默认停在「外观与交互」────────────────────────────
    await click('[aria-label="打开系统设置"]');
    const settingsOpen = await waitFor(".settings-content");
    check("V1 · Dock「系统设置」打开真实设置页（.settings-content 存在）", settingsOpen, "settingsOpen=" + settingsOpen);
    check(
      "V2 · 外壳结构 .split / .split-side / .split-section / 三个 .split-nav[data-settings-pane]",
      (await has(SETTINGS_WIN + " .split")) && (await has(SETTINGS_WIN + " .split-side")) && (await has(SETTINGS_WIN + " .split-section")) && (await count(SETTINGS_WIN + " .split-nav[data-settings-pane]")) === 3,
      "nav=" + (await count(SETTINGS_WIN + " .split-nav[data-settings-pane]")),
    );
    check(
      "V3 · 默认停在 appearance（data-settings-active=appearance）",
      (await attr("[data-settings-active]", "data-settings-active")) === "appearance" &&
        (await text(".settings-pane h1")) === "外观与交互" &&
        (await text(".settings-pane .subtitle")).includes("整个工作空间"),
      "active=" + (await attr("[data-settings-active]", "data-settings-active")) + " h1=" + (await text(".settings-pane h1")),
    );
    check("V4 · .material-select 探针钩子在设置打开时就在 DOM 里", await has(".material-select"), "");

    // appearance 控件顺序（硬要求）
    const rowLabelsRaw = await js(
      "return JSON.stringify([...document.querySelectorAll('.settings-pane .setting-row')].map((r) => (r.querySelector(':scope > span')?.textContent || '').trim()))",
    );
    const rowLabels = JSON.parse(rowLabelsRaw);
    const EXPECT = ["外观", "减少动态效果", "材质", "程序坞图标大小", "桌面图标大小", "使用自绘光标", "光标大小", "壁纸", "锁屏壁纸"];
    check(
      "V5 · appearance 控件顺序与 React 一致（外观→动效→材质→坞→桌面图标→光标→壁纸→锁屏壁纸）",
      EXPECT.every((label, i) => (rowLabels[i] || "").startsWith(label)),
      rowLabelsRaw.slice(0, 260),
    );
    const headings = JSON.parse(await js("return JSON.stringify([...document.querySelectorAll('.settings-pane h3')].map((h) => h.textContent))"));
    check("V6 · 锁屏壁纸 / 个人资料 小标题与顺序一致", headings[0] === "锁屏壁纸" && headings[1] === "个人资料", JSON.stringify(headings));
    check(
      "V7 · 个人资料块完整（头像 + 预设头像 + 显示名 + 保存）",
      (await has('[data-d3-id="settings-avatar"]')) &&
        (await has('[data-d3-id="settings-avatar-arc"]')) &&
        (await has('[data-d3-id="settings-name"]')) &&
        (await has('[data-d3-id="settings-save"]')),
      "",
    );
    await shoot("appearance.png");

    // ── 2. 切到「模型 / AI」：既有 data-d4-01-* 契约 ────────────────────────
    await click('[data-settings-pane="model"]');
    const modelActive = await waitAttr("[data-settings-active]", "data-settings-active", "model");
    check("V8 · 点 [data-settings-pane=model] 后 data-settings-active=model", modelActive, "active=" + (await attr("[data-settings-active]", "data-settings-active")));
    check(
      "V9 · model pane 是 D4-01 真实实现（10-16 按原型改成单页两栏：[data-d4-01=settings]，不再有分区标签）",
      (await has('[data-d4-01="settings"]')) && (await count("[data-d4-01-tab]")) === 0,
      "tabs=" + (await count("[data-d4-01-tab]")),
    );
    check(
      "V10 · 服务商栏默认渲染（[data-d4-01-pane=providers] + 空态 + 添加服务商表单）",
      (await has('[data-d4-01-pane="providers"]')) &&
        (await has("[data-d4-01-providers]")) &&
        (await has("[data-d4-01-provider-add]")) &&
        (await has("[data-d4-01-providers-empty]")) &&
        (await has("[data-d4-01-provider-name]")) &&
        (await has("[data-d4-01-provider-url]")) &&
        (await has("[data-d4-01-provider-secret]")) &&
        (await has("[data-d4-01-provider-create]")),
      "",
    );
    check(
      "V11 · 模型表单只在选中服务商后出现（无服务商时不渲染 [data-d4-01-model-form]）",
      !(await has("[data-d4-01-model-form]")),
      "",
    );
    const defaultsPane = await waitFor('[data-d4-01-pane="defaults"]');
    check(
      "V12 · 同页渲染默认模型（Personal / Organization 两组）",
      defaultsPane &&
        (await has("[data-d4-01-defaults-personal]")) &&
        (await has("[data-d4-01-defaults-organization]")) &&
        (await has("[data-d4-01-default-personal-chat]")) &&
        (await has("[data-d4-01-default-org-chat]")),
      "",
    );
    await shoot("model.png");

    // ── 3. 切到「设备」：既有 data-device-* 契约 ───────────────────────────
    await click('[data-settings-pane="devices"]');
    const devicesActive = await waitAttr("[data-settings-active]", "data-settings-active", "devices");
    const devicePane = await waitFor('[data-device-pane="devices"]');
    check("V13 · 点 [data-settings-pane=devices] 后 data-settings-active=devices 且设备 pane 渲染", devicesActive && devicePane, "active=" + (await attr("[data-settings-active]", "data-settings-active")));
    const deviceRole = await attr('[data-device-pane="devices"]', "data-device-role");
    check(
      "V14 · 设备 pane 带 data-device-available / data-device-role，挂载即拉列表与配对",
      (await attr('[data-device-pane="devices"]', "data-device-available")) === "true" &&
        (await has("[data-device-list]")) &&
        (await has("[data-device-pairings]")) &&
        (deviceRole === "ADMIN" ? await has('[data-device-action="pair"]') : await has("[data-device-role-note]")),
      "role=" + deviceRole,
    );
    await shoot("devices.png");

    // ── 4. 切回外观（状态不丢）────────────────────────────────────────────
    await click('[data-settings-pane="appearance"]');
    const back = await waitAttr("[data-settings-active]", "data-settings-active", "appearance");
    check("V15 · 切回 appearance 正常（导航可往返）", back && (await has(".material-select")), "");

    // ── 5. 无 console error / 无崩溃 ───────────────────────────────────────
    await sleep(400);
    check("V16 · 全程没有 console error", report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(" | "));
    check("V17 · 渲染进程没有崩溃 / 加载失败", report.errors.length === 0, report.errors.slice(0, 3).join(" | "));
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e.message).slice(0, 200));
  } finally {
    try {
      win?.destroy();
    } catch {
      /* ignore */
    }
    if (userData) {
      try {
        fs.rmSync(userData, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
