/**
 * D3-02 UI 探针（真实 Electron + 产品真实页面 / preload / 授权装配）。
 *
 * 验证 §59：D2-01 的 Unauthorized Page State 第一次接真实授权 ——
 *   · Viewer 读到受保护资源，但编辑按钮不可用（read-only）
 *   · 无权限用户看到 Unauthorized，且不显示任何 Resource name
 *   · 决策来自主进程 authorization/capabilities，渲染进程不判断 role
 *
 * 与 tests/identity-ui.mjs 同一手法：主进程自持窗口 + executeJavaScript。
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const domain = require(path.join(ROOT, "electron/authorization-domain.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const ADMIN = "admin@openarc.test";
const ADMIN_PW = "admin-password-1";
const VIEWER = "viewer@openarc.test";
const VIEWER_PW = "viewer-password-1";
const NOBODY = "nobody@openarc.test";
const NOBODY_PW = "nobody-password-1";
const PROTECTED_ID = "res_ui_protected_0001";
const PROTECTED_REF = "resource://" + PROTECTED_ID;

const report = { checks: [], errors: [], versions: {} };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail) });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win;
let userData = null;

const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const text = (sel) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.textContent || ''");
const attr = (sel, name) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.getAttribute(" + JSON.stringify(name) + ") || null");

async function waitGate(want, timeout = 30000) {
  const t0 = Date.now();
  let last = "?";
  while (Date.now() - t0 < timeout) {
    try {
      last = await gate();
      if (last === want) return last;
    } catch {
      /* 导航中 */
    }
    await sleep(120);
  }
  return "TIMEOUT(last=" + last + ")";
}

async function waitSel(sel, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await js("return !!document.querySelector(" + JSON.stringify(sel) + ")")) return true;
    await sleep(80);
  }
  return false;
}

const setInput = (sel, value) =>
  js(
    "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
      "if (!el) return 'missing';" +
      "const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;" +
      "setter.call(el, " + JSON.stringify(value) + ");" +
      "el.dispatchEvent(new Event('input', { bubbles: true }));" +
      "return 'ok';",
  );

const click = (sel) =>
  js(
    "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
      "if (!el) return 'missing';" +
      "if (el.disabled) return 'disabled';" +
      "el.click(); return 'ok';",
  );

async function loginUI(identifier, password) {
  await setInput('[data-d3-id="login-identifier"]', identifier);
  await setInput('[data-d3-id="login-password"]', password);
  await sleep(80);
  await click('[data-d3-id="login-submit"]');
}

const injectProtected = (ref) =>
  js(
    "window.dispatchEvent(new CustomEvent('openarc:protected-resource', { detail: { resourceRef: " +
      JSON.stringify(ref) +
      " } })); return 'ok';",
  );

app.whenReady().then(async () => {
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform + "/" + process.arch };
    out("VERSIONS " + JSON.stringify(report.versions));

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3-02-ui-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true });

    // ── 在真实持久层里播种受保护资源（admin = Super Admin）──────────────
    await identity.store.initialize({ identifier: ADMIN, password: ADMIN_PW, displayName: "Admin" });
    const adminLogin = await identity.store.login({ identifier: ADMIN, password: ADMIN_PW });
    const adminCtx = { sessionRef: adminLogin.session.ref, appId: "resource-library", source: "ui" };
    const svc = identity.authorization;
    const viewer = await identity.store.createUser({ identifier: VIEWER, password: VIEWER_PW, displayName: "Viewer" });
    const nobody = await identity.store.createUser({ identifier: NOBODY, password: NOBODY_PW, displayName: "Nobody" });
    const dept = svc.createDepartment({ context: adminCtx, name: "UI Design" });
    svc.addDepartmentMember({ context: adminCtx, departmentId: dept.department.id, userId: viewer.userId, membershipRole: "member" });
    svc.registerResource({ context: adminCtx, resourceId: PROTECTED_ID, resourceType: "document", scope: "DEPARTMENT", departmentId: dept.department.id, name: "Protected Design Doc" });
    svc.grantResourcePermission({ context: adminCtx, principalType: "DEPARTMENT", principalId: dept.department.id, resourceId: PROTECTED_ID, permissionSet: "VIEWER" });
    svc.grantAppResourcePermission({ context: adminCtx, appId: "resource-library", actions: domain.RESOURCE_ACTIONS });

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
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    registerIdentityIpc({
      ipcMain,
      service: identity.service,
      authorization: identity.authorization,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: (event) => {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event);
      },
    });

    await win.loadURL(uiURL);
    await sleep(500);

    let g = await waitGate("unauthenticated");
    check("A1 · 已初始化 → 登录页", g === "unauthenticated", "gate=" + g);
    check("A2 · 授权桥存在且只有 command 一个方法", await js("return typeof window.openarc.authorization?.command === 'function' && Object.keys(window.openarc.authorization).join() === 'command'"), "bridge");

    // ── Viewer：可读、只读 ──────────────────────────────────────────────
    await loginUI(VIEWER, VIEWER_PW);
    g = await waitGate("ready");
    check("A3 · Viewer 登录进入桌面", g === "ready", "gate=" + g);
    await injectProtected(PROTECTED_REF);
    const ready = await waitSel('[data-d3-02-protected="ready"]');
    check("A4 · Viewer 可见受保护资源", ready, "panel=ready");
    check("A5 · Viewer 只读：can-edit=false", (await attr('[data-d3-02-protected]', "data-d3-02-can-edit")) === "false", "can-edit=" + (await attr('[data-d3-02-protected]', "data-d3-02-can-edit")));
    check("A6 · 显示安全 metadata（name）", (await text('[data-d3-02-name]')) === "Protected Design Doc", await text('[data-d3-02-name]'));

    // ── 无权限用户：Unauthorized，且不泄漏 name ─────────────────────────
    await click('[data-d3-id="topbar-logout"]');
    g = await waitGate("unauthenticated");
    check("A7 · Viewer 登出回登录页", g === "unauthenticated", "gate=" + g);
    await loginUI(NOBODY, NOBODY_PW);
    g = await waitGate("ready");
    check("A8 · Nobody 登录进入桌面", g === "ready", "gate=" + g);
    await injectProtected(PROTECTED_REF);
    const unauth = await waitSel('[data-d3-02-protected="unauthorized"]');
    check("A9 · 无权限 → Unauthorized Page State", unauth, "panel=unauthorized");
    check("A10 · Unauthorized 不显示任何 Resource name", !(await js("return !!document.querySelector('[data-d3-02-name]')")), "no name node");
    check("A11 · 对外错误收敛为 NOT_FOUND_OR_FORBIDDEN", (await attr('[data-d3-02-protected]', "data-d3-02-error")) === "NOT_FOUND_OR_FORBIDDEN", await attr('[data-d3-02-protected]', "data-d3-02-error"));
    check("A12 · 使用了 D2-01 Unauthorized 组件契约", await js("return !!document.querySelector('.ds-page-state--unauthorized')"), "ds-page-state--unauthorized");

    // ── 主进程交叉核对（UI 的显示必须与 authorize() 一致）────────────────
    const vLogin = await identity.store.login({ identifier: VIEWER, password: VIEWER_PW });
    const nLogin = await identity.store.login({ identifier: NOBODY, password: NOBODY_PW });
    const authzViewer = svc.authorize({ context: { sessionRef: vLogin.session.ref, appId: "resource-library" }, action: "resource.read", resource: PROTECTED_ID });
    const authzNobody = svc.authorize({ context: { sessionRef: nLogin.session.ref, appId: "resource-library" }, action: "resource.read", resource: PROTECTED_ID });
    check("A13 · 服务端 authorize 与 UI 显示一致", authzViewer.decision === "ALLOW" && authzNobody.decision === "DENY", "viewer=" + authzViewer.decision + ", nobody=" + authzNobody.decision);

    // ── 未授权用户不能通过 bridge 猜 ref ────────────────────────────────
    const guessed = await js("return await window.openarc.authorization.command({ type: 'authorization/resource', resourceRef: 'resource://res_guessed_000001' })");
    check("A14 · bridge 猜 resourceRef → NOT_FOUND_OR_FORBIDDEN", guessed && guessed.ok === false && guessed.error === "NOT_FOUND_OR_FORBIDDEN", JSON.stringify(guessed).slice(0, 100));
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
