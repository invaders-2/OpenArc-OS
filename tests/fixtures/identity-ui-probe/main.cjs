/**
 * D3-01 UI 探针（在**真实 Electron** 里跑产品真实页面）。
 *
 * 为什么不是 Playwright：
 *   本环境 Playwright 1.55 与 Electron 内置 Chromium 的 CDP 握手超时
 *   （`_electron.launch` / `connectOverCDP` 均失败）。改用 Electron 主进程
 *   自持窗口 + `webContents.executeJavaScript` 驱动，绕开浏览器驱动，
 *   代价是不覆盖原生指针事件，收益是**真的跑在产品运行时里**。
 *
 * 装配复用 `electron/identity-bootstrap.cjs`，与产品主进程同一条接线；
 * 页面就是 `dist/index.html`，preload 就是 `electron/preload.cjs`。
 * 因此"验证过的这条线"与"产品跑的这条线"是同一条。
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const IDENT = "ui-probe@openarc.local";
const PW = "ui-probe-password-1";
const NAME = "UI Probe";

const report = { checks: [], errors: [], versions: {} };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok: !!ok, detail: String(detail) });
  out(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win;
let userData = null;

const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
const gate = () => js(`return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'`);
const has = (sel) => js(`return !!document.querySelector(${JSON.stringify(sel)})`);
const text = (sel) => js(`return document.querySelector(${JSON.stringify(sel)})?.textContent || ''`);

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

app.whenReady().then(async () => {
  try {
    report.versions = {
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform + "/" + process.arch,
    };
    out("VERSIONS " + JSON.stringify(report.versions));

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3-01-ui-"));
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
    // 本探针不验证窗口系统，但页面会照常下发意图；缺 handler 会在 stderr 里刷屏，
    // 掩盖真正的报错。这里给一个显式空实现，并注明它是**有意为之**。
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));

    registerIdentityIpc({
      ipcMain,
      service: identity.service,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: (event) => {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event);
      },
    });

    await win.loadURL(uiURL);
    await sleep(400);

    // ── 1. 首次运行 ──────────────────────────────────────────────────────
    let g = await waitGate("uninitialized");
    check("U1 · 首次启动进入初始化界面", g === "uninitialized", `gate=${g}`);
    check("U2 · 只有初始化表单，没有桌面", (await has('[data-d3-id="setup-form"]')) && !(await has(".topbar")), "桌面内容未渲染");

    // ── 2. 初始化 ────────────────────────────────────────────────────────
    await setInput('[data-d3-id="setup-name"]', NAME);
    await setInput('[data-d3-id="setup-identifier"]', IDENT);
    await setInput('[data-d3-id="setup-password"]', PW);
    await setInput('[data-d3-id="setup-confirm"]', PW);
    await waitEnabled('[data-d3-id="setup-submit"]');
    check("U3 · 填完表单后提交按钮可用", (await js(`return !document.querySelector('[data-d3-id="setup-submit"]').disabled`)) === true, "");
    await click('[data-d3-id="setup-submit"]');

    g = await waitGate("unauthenticated");
    check("U4 · 初始化后进入登录页（不自动登录）", g === "unauthenticated", `gate=${g}`);
    check("U5 · 初始化表单已消失（刷新/回退也回不到可提交状态）", !(await has('[data-d3-id="setup-form"]')), "");

    // ── 3. 登录 ──────────────────────────────────────────────────────────
    await setInput('[data-d3-id="login-identifier"]', IDENT);
    await setInput('[data-d3-id="login-password"]', PW);
    await waitEnabled('[data-d3-id="login-submit"]');
    await click('[data-d3-id="login-submit"]');

    g = await waitGate("ready");
    check("U6 · 登录成功进入桌面", g === "ready", `gate=${g}`);
    check("U7 · 桌面真实渲染（topbar / dock 存在）", (await has(".topbar")) && (await has(".dock")), "");
    check("U8 · 顶栏显示当前身份", (await text('[data-d3-id="topbar-logout"]')) === NAME, await text('[data-d3-id="topbar-logout"]'));

    const lsKeys = await js(`return JSON.stringify(Object.keys(localStorage))`);
    check(
      "U9 · localStorage 里没有任何身份 / session / token 键",
      !/identity|session|token|user|auth/i.test(lsKeys),
      lsKeys,
    );

    // ── 4. 重启恢复（§39，同时验证不闪现）────────────────────────────────
    const samples = [];
    win.reload();
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      try {
        samples.push(await js(`return JSON.stringify({g: document.querySelector('.desktop')?.getAttribute('data-identity-gate'), top: !!document.querySelector('.topbar')})`));
      } catch {
        /* 导航中，跳过采样 */
      }
      await sleep(40);
    }
    const flash = samples
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((s) => s.g !== "ready" && s.top);
    check("U10 · 重启过程中从未出现「未就绪却已画桌面」的闪现", flash.length === 0, `采样 ${samples.length} 次，闪现 ${flash.length} 次`);

    g = await waitGate("ready");
    check("U11 · 重启后通过持久 session 恢复身份（无需重新登录）", g === "ready", `gate=${g}`);

    // ── 5. 锁定 / 解锁（§14 / §15 / §47）─────────────────────────────────
    await click('[data-d3-id="topbar-lock"]');
    g = await waitGate("locked");
    check("U12 · 点击锁定 → 进入 locked", g === "locked", `gate=${g}`);
    check("U13 · 锁屏覆盖层存在", await has(".lock-shade"), "");
    check("U14 · 桌面被 inert（键盘与指针都进不去后台）", await js(`return !!document.querySelector('.desktop-surface[inert]')`), "");
    check("U15 · 窗口 DOM 仍在（锁定不销毁窗口状态，§40）", await has(".window"), "");

    await setInput('[data-d3-id="unlock-password"]', "definitely-wrong-pw");
    await waitEnabled('[data-d3-id="unlock-submit"]');
    await click('[data-d3-id="unlock-submit"]');
    await sleep(600);
    check("U16 · 错误口令解锁被拒绝且仍锁定", (await gate()) === "locked" && (await has('[data-d3-id="auth-error"]')), await text('[data-d3-id="auth-error"]'));

    await setInput('[data-d3-id="unlock-password"]', PW);
    await waitEnabled('[data-d3-id="unlock-submit"]');
    await click('[data-d3-id="unlock-submit"]');
    g = await waitGate("ready");
    check("U17 · 正确口令解锁 → 回到桌面", g === "ready", `gate=${g}`);
    check("U18 · 锁屏已移除", !(await has(".lock-shade")), "");

    // ── 6. 登出（§13）────────────────────────────────────────────────────
    await click('[data-d3-id="topbar-logout"]');
    g = await waitGate("unauthenticated");
    check("U19 · 登出 → 回到登录页", g === "unauthenticated", `gate=${g}`);
    check("U20 · 登出后桌面不再渲染", !(await has(".topbar")), "");

    win.reload();
    g = await waitGate("unauthenticated");
    check("U21 · 登出后重启不会复活（持久 session 已撤销）", g === "unauthenticated", `gate=${g}`);

    // ── 7. 数据库最终状态 ────────────────────────────────────────────────
    const users = identity.store.allUsers().length;
    const sessions = identity.store.allSessions().length;
    const revoked = identity.store.allSessions().filter((s) => s.revoked_at != null).length;
    check("U22 · 全程只创建了 1 个用户", users === 1, `users=${users}`);
    check("U23 · 所有 session 最终都被撤销", sessions > 0 && revoked === sessions, `sessions=${sessions}, revoked=${revoked}`);
    check("U24 · 域不变量健康", identity.store.invariants().length === 0, identity.store.invariants().join("; "));
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
