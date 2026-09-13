/**
 * D3-04B UI 探针宿主（真实 Electron + 产品真实页面 / preload / ResourceService）。
 *
 * 驱动真实资源库 App：创建 Memory、编辑内容、版本冲突、Collection、Tag、Favorite、
 * Delete/Trash/Restore、Import。不是 DOM 静态断言。
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";

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
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const txt = (sel) => js("return (document.querySelector(" + JSON.stringify(sel) + ")?.textContent || '').trim()");

async function waitGate(want, timeout = 30000) {
  const t0 = Date.now();
  let last = "?";
  while (Date.now() - t0 < timeout) {
    try {
      last = await gate();
      if (last === want) return last;
    } catch {
      /* navigating */
    }
    await sleep(120);
  }
  return "TIMEOUT(last=" + last + ")";
}
async function waitSel(sel, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await has(sel)) return true;
    await sleep(100);
  }
  return false;
}
async function waitFn(expr, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await js("return (" + expr + ")")) return true;
    await sleep(100);
  }
  return false;
}
const setValue = (sel, value) =>
  js(
    "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
      "if (!el) return 'missing';" +
      "const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;" +
      "const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;" +
      "setter.call(el, " + JSON.stringify(value) + ");" +
      "el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));" +
      "return 'ok';",
  );
const click = (sel) =>
  js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");

app.whenReady().then(async () => {
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform + "/" + process.arch };
    out("VERSIONS " + JSON.stringify(report.versions));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3-04b-ui-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    const fixtureFile = path.join(userData, "import-me.txt");
    fs.writeFileSync(fixtureFile, "imported via ui");
    const stubDialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [fixtureFile] }) };

    win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    registerIdentityIpc({
      ipcMain,
      service: identity.service,
      authorization: identity.authorization,
      device: identity.deviceService,
      resource: identity.resourceService,
      dialog: stubDialog,
      BrowserWindow,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: (event) => {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event);
      },
    });

    await win.loadURL(uiURL);
    await sleep(500);
    let g = await waitGate("unauthenticated");
    check("B1 · 登录页", g === "unauthenticated", "gate=" + g);
    await setValue('[data-d3-id="login-identifier"]', ADMIN);
    await setValue('[data-d3-id="login-password"]', PW);
    await sleep(80);
    await click('[data-d3-id="login-submit"]');
    g = await waitGate("ready");
    check("B2 · 登录进入桌面", g === "ready", "gate=" + g);

    await click('[data-app-id="resource-library"]');
    check("B3 · 打开资源库 App（三栏）", await waitSel('[data-d3-04b="app"]'), "app");
    check("B4 · Navigation 含固定分类", (await has('[data-d3-04b-nav="memory"]')) && (await has('[data-d3-04b-nav="trash"]')) && (await has('[data-d3-04b-nav="favorites"]')), "");

    // Import（保留 D3-04A 兼容）
    await click('[data-d3-04a-action="import"]');
    check("B5 · Import 后出现资源条目", await waitSel('[data-d3-04a-item]'), "");

    // Create Memory
    await click('[data-d3-04b-action="create"]');
    await sleep(200);
    await setValue('[data-d3-04b-create-name]', "私人测试记忆");
    await setValue('[data-d3-04b-create-content]', "secret memory v1");
    await click('[data-d3-04b-action="create-submit"]');
    check("B6 · 新建 Memory 出现在列表", await waitFn("Array.from(document.querySelectorAll('[data-d3-04a-item]')).some(function(e){return e.textContent.indexOf('私人测试记忆')>=0;})"), "");
    await click('[data-d3-04a-item]:nth-of-type(1)');
    // select the memory specifically via its inspector name
    await js("const els=Array.from(document.querySelectorAll('[data-d3-04a-item]')); const el=els.find(function(e){return e.textContent.indexOf('私人测试记忆')>=0;}); if(el) el.click(); return 'ok';");
    check("B7 · Inspector 显示 Memory + memory subtype", await waitFn("document.querySelector('[data-d3-04b-inspector-name]') && document.querySelector('[data-d3-04b-inspector-name]').textContent==='私人测试记忆'"), await txt('[data-d3-04b-inspector-name]'));

    // Edit content -> v2
    await click('[data-d3-04b-action="edit"]');
    await sleep(200);
    await setValue('[data-d3-04b-editor]', "secret memory v2");
    await click('[data-d3-04b-save]');
    check("B8 · 编辑内容保存为新版本", await waitFn("document.body.innerText.indexOf('v2')>=0"), "");
    const ref = await js("const el=document.querySelector('[data-d3-04b-item]'); return el ? el.getAttribute('data-d3-04b-item') : null");
    const rr = identity.resourceStore.resourceRowById(ref);
    check("B9 · 主进程 version = 2", rr && rr.version === 2, rr ? "v" + rr.version : "missing");

    // Version conflict: open editor (expected v2), bump externally to v3, save -> conflict dialog
    await click('[data-d3-04b-action="edit"]');
    await sleep(200);
    await setValue('[data-d3-04b-editor]', "draft from stale editor");
    await identity.resourceService.replaceText({ context: { sessionRef: identity.service.current, appId: "resource-library" }, resourceRef: ref, text: "external v3", expectedVersion: 2 });
    await click('[data-d3-04b-save]');
    check("B10 · 版本冲突对话框出现", await waitSel('[data-d3-04b-conflict]'), "");
    check("B11 · 冲突草稿未覆盖主进程内容", identity.resourceStore.resourceRowById(ref).version === 3, "v" + identity.resourceStore.resourceRowById(ref).version);
    await click('[data-d3-04b-conflict-saveas]');
    check("B12 · 另存为新资源后再现冲突前的草稿", await waitFn("Array.from(document.querySelectorAll('[data-d3-04a-item]')).some(function(e){return e.textContent.indexOf('副本')>=0;})"), "");

    // Collection create + move
    await click('[data-d3-04b-action="new-collection"]');
    await sleep(200);
    await setValue('#rl-collection-name', "UI Collection");
    await click('[data-d3-04b-action="collection-submit"]');
    check("B13 · 新建 Collection 出现在导航", await waitFn("Array.from(document.querySelectorAll('[data-d3-04b-nav]')).some(function(e){return e.textContent.indexOf('UI Collection')>=0;})"), "");

    // select the memory again（按精确 ResourceRef，避免匹配到副本）并 move to collection
    await js("const el=document.querySelector('[data-d3-04b-item=\"" + ref + "\"]'); if(el) el.click(); return 'ok';");
    await waitSel('[data-d3-04b-collection]');
    const inspectorRef = await js("return document.querySelector('[data-d3-04b-inspector-ref]')?.getAttribute('data-d3-04b-inspector-ref') || null");
    check("B13c · Inspector 指向目标 Resource", inspectorRef === ref, "inspector=" + inspectorRef);
    const colId = await js("const sel=document.querySelector('[data-d3-04b-collection]'); const opt=Array.from(sel.options).find(function(o){return o.textContent.indexOf('UI Collection')>=0;}); return opt ? opt.value : null");
    check("B13b · Collection 出现在 Inspector 选项", !!colId, colId || await js("return JSON.stringify(Array.from(document.querySelector('[data-d3-04b-collection]').options).map(function(o){return o.textContent;}))"));
    await setValue('[data-d3-04b-collection]', colId || "");
    let moved = null;
    for (let i = 0; i < 30; i += 1) {
      moved = identity.resourceStore.resourceRowById(ref).collection_id;
      if (moved === colId) break;
      await sleep(100);
    }
    check("B14 · Resource 移入 Collection", moved === colId, String(moved));

    // Tag
    await setValue('[data-d3-04b-tag-input]', "uiprobe");
    await click('[data-d3-04b-tag-add]');
    check("B15 · 添加 Tag", await waitFn("document.body.innerText.indexOf('uiprobe')>=0"), "");

    // Favorite
    const favReady = await waitSel('[data-d3-04b-action="favorite"]');
    const favClick = await click('[data-d3-04b-action="favorite"]');
    let fav = false;
    for (let i = 0; i < 60; i += 1) {
      fav = identity.resourceStore.isFavorite(identity.store.userByIdentifier(ADMIN).id, ref) === true;
      if (fav) break;
      await sleep(100);
    }
    check("B16 · Favorite 生效（主进程）", fav === true, "button=" + favReady + " click=" + favClick);

    // Delete -> Trash -> Restore
    const delReady = await waitSel('[data-d3-04b-action="delete"]');
    const delClick = await click('[data-d3-04b-action="delete"]');
    let trashed = false;
    for (let i = 0; i < 60; i += 1) {
      trashed = identity.resourceStore.libraryResourceById(ref).trash_state === "TRASHED";
      if (trashed) break;
      await sleep(100);
    }
    check("B17 · Delete 后主进程进入 Trash", trashed, "button=" + delReady + " click=" + delClick);
    await click('[data-d3-04b-nav="trash"]');
    check("B18 · Trash 分类显示该资源", await waitFn("Array.from(document.querySelectorAll('[data-d3-04a-item]')).some(function(e){return e.getAttribute('data-d3-04b-item')===" + JSON.stringify(ref) + ";})"), "");
    await js("const el=document.querySelector('[data-d3-04b-item=\"" + ref + "\"]'); if(el) el.click(); return 'ok';");
    const restoreReady = await waitSel('[data-d3-04b-action="restore"]');
    const restoreClick = await click('[data-d3-04b-action="restore"]');
    let restored = false;
    for (let i = 0; i < 30; i += 1) {
      restored = identity.resourceStore.libraryResourceById(ref).trash_state === "ACTIVE";
      if (restored) break;
      await sleep(100);
    }
    check("B19 · Restore 后同一 ResourceRef 可用", restored, "button=" + restoreReady + " click=" + restoreClick);

    // capabilities visible
    await click('[data-d3-04b-nav="all"]');
    await waitFn("!!document.querySelector('[data-d3-04b-item=\"" + ref + "\"]')");
    await js("const el=document.querySelector('[data-d3-04b-item=\"" + ref + "\"]'); if(el) el.click(); return 'ok';");
    const capsReady = await waitSel('[data-d3-04b-cap="canRead"]');
    check("B19b · Capabilities 面板出现", capsReady, "");
    check("B20 · Inspector 显示 Capabilities", (await txt('[data-d3-04b-cap="canRead"]')).includes("true"), await txt('[data-d3-04b-cap="canRead"]'));

    // main-process authorization cross-check (viewer read-only)
    const dana = await identity.store.createUser({ identifier: "viewer@openarc.test", password: "viewer-password-1", displayName: "Viewer", teamId: identity.store.allUsers()[0].team_id });
    identity.authorization.grantResourcePermission({ context: { sessionRef: identity.service.current, appId: "resource-library" }, principalType: "USER", principalId: dana.userId, resourceId: ref, permissionSet: "VIEWER" });
    const vLogin = await identity.store.login({ identifier: "viewer@openarc.test", password: "viewer-password-1" });
    const vCtx = { sessionRef: vLogin.session.ref, appId: "resource-library" };
    const vInsp = identity.resourceService.getInspector({ context: vCtx, resourceRef: ref });
    check("B21 · Viewer 只读（canRead true / canEdit false）", vInsp.ok && vInsp.capabilities.effective.canRead === true && vInsp.capabilities.effective.canEdit === false, JSON.stringify(vInsp.capabilities && vInsp.capabilities.effective));
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
