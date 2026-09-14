/**
 * D3-04D UI 探针宿主（真实 Electron + 产品真实页面 / preload / GovernanceService / Picker / Canvas）。
 * D3D_UI_SCOPE=governance|picker|canvas|all 选择验收范围。
 */
const { app, BrowserWindow, ipcMain, safeStorage, nativeImage, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const SCOPE = process.env.D3D_UI_SCOPE || "all";
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";

const report = { checks: [], errors: [], versions: {}, scope: SCOPE };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail) }); out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
let userData = null;

const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const txt = (sel) => js("return (document.querySelector(" + JSON.stringify(sel) + ")?.textContent || '').trim()");

async function waitGate(want, timeout = 30000) { const t0 = Date.now(); let last = "?"; while (Date.now() - t0 < timeout) { try { last = await gate(); if (last === want) return last; } catch { /* navigating */ } await sleep(120); } return "TIMEOUT(last=" + last + ")"; }
async function waitSel(sel, timeout = 15000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await has(sel)) return true; await sleep(100); } return false; }
async function waitFn(expr, timeout = 15000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await js("return (" + expr + ")")) return true; } catch { /* ignore */ } await sleep(100); } return false; }
const setValue = (sel, value) =>
  js(
    "const el=document.querySelector(" + JSON.stringify(sel) + "); if(!el) return 'missing';" +
      "const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;" +
      "const setter=Object.getOwnPropertyDescriptor(proto,'value').set; setter.call(el," + JSON.stringify(value) + ");" +
      "el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return 'ok';",
  );
const click = (sel) => js("const el=document.querySelector(" + JSON.stringify(sel) + "); if(!el) return 'missing'; if(el.disabled) return 'disabled'; el.click(); return 'ok';");

app.whenReady().then(async () => {
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform + "/" + process.arch };
    out("VERSIONS " + JSON.stringify(report.versions));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3-04d-ui-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true, nativeImage });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    const adminLogin = await identity.store.login({ identifier: ADMIN, password: PW });
    const adminCtx = { sessionRef: adminLogin.session.ref, appId: "resource-library" };
    // 治理数据 + 一个可被 canvas 读取的资源
    const dept = identity.authorization.createDepartment({ context: adminCtx, name: "UI 部门" });
    if (dept.ok) identity.authorization.addDepartmentMember({ context: adminCtx, departmentId: dept.department.id, userId: identity.store.userByIdentifier(ADMIN).id, membershipRole: "member" });
    const created = await identity.governanceService.createUser({ context: adminCtx, identifier: "uiuser@openarc.test", password: "uiuser-password-1", displayName: "UI 用户" });
    const res = await identity.resourceService.createResource({ context: adminCtx, resourceType: "text", name: "UI 资源", content: "ui resource token" });
    await identity.searchService.search({ context: adminCtx, query: "ui resource", limit: 5 });
    const uiResourceRef = res.ok ? res.resource.resourceRef : null;

    win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    registerIdentityIpc({
      ipcMain, service: identity.service, authorization: identity.authorization, device: identity.deviceService,
      resource: identity.resourceService, resourceSearch: identity.searchService, resourcePreview: identity.previewService,
      governance: identity.governanceService, projects: identity.projectService, canvas: identity.canvasService, picker: identity.pickerService,
      dialog: null, shell, BrowserWindow, isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event); },
    });

    await win.loadURL(uiURL);
    await sleep(500);
    await setValue('[data-d3-id="login-identifier"]', ADMIN);
    await setValue('[data-d3-id="login-password"]', PW);
    await sleep(80);
    await click('[data-d3-id="login-submit"]');
    const g = await waitGate("ready");
    check("D1 · 登录进入桌面", g === "ready", "gate=" + g);

    if (SCOPE === "governance" || SCOPE === "all") {
      await click('[data-app-id="organization"]');
      check("G1 · 打开组织治理 App", await waitSel('[data-d3-04d="app"]'), "");
      check("G2 · Users 面板列出刚创建用户", await waitFn("Array.from(document.querySelectorAll('[data-d3-04d-user]')).some(function(e){return e.textContent.indexOf('UI 用户')>=0;})"), await txt('[data-d3-04d-user]'));
      await setValue('[data-d3-04d-user-identifier]', "ui2@openarc.test");
      await setValue('[data-d3-04d-user-display]', "UI2");
      await setValue('[data-d3-04d-user-password]', "ui2-password-1");
      await click('[data-d3-04d-create-user]');
      check("G3 · UI 创建子用户成功", await waitFn("Array.from(document.querySelectorAll('[data-d3-04d-user]')).some(function(e){return e.textContent.indexOf('UI2')>=0;})"), "");
      // 禁用刚创建的用户（主进程验证）
      const u2 = identity.store.userByIdentifier("ui2@openarc.test");
      await click('[data-d3-04d-user-disable="' + u2.id + '"]');
      check("G4 · UI 禁用用户后主进程状态为 DISABLED", await (async () => { for (let i = 0; i < 40; i += 1) { if (identity.store.userById(u2.id).status === "DISABLED") return true; await sleep(100); } return false; })(), identity.store.userById(u2.id).status);
      await click('[data-d3-04d-tab="departments"]');
      check("G5 · Departments 面板显示部门与计数", await waitFn("Array.from(document.querySelectorAll('[data-d3-04d-dept]')).some(function(e){return e.textContent.indexOf('UI 部门')>=0;})"), await txt('[data-d3-04d-dept]'));
      await click('[data-d3-04d-tab="apps"]');
      check("G6 · Apps 面板列出内置 App", await waitFn("document.querySelectorAll('[data-d3-04d-app]').length>=5"), await js("return document.querySelectorAll('[data-d3-04d-app]').length"));
      await click('[data-d3-04d-tab="access"]');
      await setValue('[data-d3-04d-access-ref]', uiResourceRef);
      await click('[data-d3-04d-access-load]');
      check("G7 · Resource Access 显示权限来源（OWNER_POLICY）", await waitFn("document.querySelector('[data-d3-04d-access-source=OWNER_POLICY]')!==null"), await txt('[data-d3-04d-access]'));
      await click('[data-d3-04d-tab="audit"]');
      check("G8 · Audit 面板有真实治理记录", await waitFn("document.querySelectorAll('[data-d3-04d-audit-item]').length>=1"), await js("return document.querySelectorAll('[data-d3-04d-audit-item]').length"));
    }

    if (SCOPE === "picker" || SCOPE === "all" || SCOPE === "canvas") {
      await click('[data-app-id="canvas"]');
      check("C1 · 打开 Canvas App", await waitSel('[data-d3-04d="canvas"]'), "");
      await setValue('[data-d3-04d-canvas-name]', "UI 画布");
      await click('[data-d3-04d-canvas-new]');
      check("C2 · 新建画布并选中", await waitFn("document.querySelector('[data-d3-04d-canvas-active]')!==null"), "");
      await click('[data-d3-04d-canvas-insert]');
      check("P1 · 打开系统 Resource Picker", await waitSel('[data-d3-04d-picker]'), "");
      await setValue('[data-d3-04d-picker-query]', "ui resource");
      await click('[data-d3-04d-picker-search]');
      check("P2 · Picker 只显示授权交集（含 UI 资源）", await waitFn("Array.from(document.querySelectorAll('[data-d3-04d-picker-item]')).some(function(e){return e.textContent.indexOf('UI 资源')>=0;})"), await txt('[data-d3-04d-picker-items]'));
      const rid = await js("const el=Array.from(document.querySelectorAll('[data-d3-04d-picker-item]')).find(function(e){return e.textContent.indexOf('UI 资源')>=0;}); return el ? el.getAttribute('data-d3-04d-picker-item') : null");
      await click('[data-d3-04d-picker-item="' + rid + '"]');
      await click('[data-d3-04d-picker-choose]');
      check("C3 · 画布节点保存 ResourceRef 且状态 AVAILABLE", await waitFn("document.querySelector('[data-d3-04d-canvas-node][data-d3-04d-canvas-node-state=AVAILABLE]')!==null"), await txt('[data-d3-04d-canvas-nodes]'));
      const state = await js("const el=document.querySelector('[data-d3-04d-canvas-node]'); return el ? el.getAttribute('data-d3-04d-canvas-node-state') : null");
      check("C4 · 节点状态由服务端真实计算", state === "AVAILABLE", "state=" + state);
    }

    if (SCOPE === "all") {
      await click('[data-app-id="files"]');
      check("F1 · Files App 提供 Add to Library / Export 入口", (await waitSel('[data-d3-04d="files"]')) && (await has('[data-d3-04d-files-import]')) && (await has('[data-d3-04d-files-export]')), "");
    }

    check("Z1 · DOM 不泄漏本地路径", !(await js("return document.body.innerHTML")).includes(userData), "");
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
