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
// Electron 的 userData 默认在 ~/Library/Application Support/Electron，localStorage（oa-dock 等）
// 会跨探针运行残留；残留值可把"组织治理"从程序坞里删掉，D1 之后就打不开治理 App。
// 先把它指向本进程专属临时目录，保证程序坞 = 产品默认（DOCK_DEFAULT）。
const electronUserData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3-04d-electron-"));
app.setPath("userData", electronUserData);
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
    await identity.resourceService.createResource({ context: adminCtx, resourceType: "text", name: "UI 资源", content: "ui resource token" });
    await identity.searchService.search({ context: adminCtx, query: "ui resource", limit: 5 });

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
      await click('[data-dock-id="organization"]');
      check("G1 · 打开组织治理 App", await waitSel('[data-org-shell]'), "");
      check("G2 · Users 面板列出刚创建用户", await waitFn("Array.from(document.querySelectorAll('[data-org-user]')).some(function(e){return e.textContent.indexOf('UI 用户')>=0;})"), await txt('[data-org-user]'));
      await setValue('[data-org-field="user-identifier"]', "ui2@openarc.test");
      await setValue('[data-org-field="user-display"]', "UI2");
      await setValue('[data-org-field="user-password"]', "ui2-password-1");
      await click('[data-org-action="create-user"]');
      check("G3 · UI 创建子用户成功", await waitFn("Array.from(document.querySelectorAll('[data-org-user]')).some(function(e){return e.textContent.indexOf('UI2')>=0;})"), "");
      // 禁用刚创建的用户（主进程验证）
      const u2 = identity.store.userByIdentifier("ui2@openarc.test");
      await click('[data-org-user-toggle="' + u2.id + '"]');
      check("G4 · UI 禁用用户后主进程状态为 DISABLED", await (async () => { for (let i = 0; i < 40; i += 1) { if (identity.store.userById(u2.id).status === "DISABLED") return true; await sleep(100); } return false; })(), identity.store.userById(u2.id).status);
      // 部门与成员同属 org 分区，默认即展示，无需切换 Tab
      check("G5 · Departments 面板显示部门与计数", await waitFn("Array.from(document.querySelectorAll('[data-org-dept]')).some(function(e){return e.textContent.indexOf('UI 部门')>=0;})"), await txt('[data-org-dept]'));
      await click('[data-org-nav="app"]');
      check("G6 · Apps 面板列出内置 App", await waitFn("document.querySelectorAll('[data-org-app]').length>=5"), await js("return document.querySelectorAll('[data-org-app]').length"));
      // D4-03 的 App TOOL-scope 工具权限控件（data-gov-tool-*）与 Resource Access 来源视图（data-d3-04d-access-*）
      // 已从当前组织治理 App 移除（只剩 org / app / audit 三分区，且无对应钩子）。现行覆盖：
      //   · TOOL-scope 授予 / 撤销（仅剩产品命令白名单 governance/grantAppToolAccess 等，UI 已无入口）
      //     → tests/governance-tool-grant.test.mjs（IPC 路由 + 授权语义逐条）
      //   · 现行 APP 访问"权限策略"入口（权限代码 → 决策 → 保存）→ 本文件下方 G7
      //   · 资源访问来源 OWNER_POLICY → tests/governance-resource-access.test.mjs
      // 因此删除这两段已无产品对应的陈旧断言。
      // 现行 APP 访问入口：权限策略（权限代码 → 决策）→ identity/app-permission-policy-save。
      // 断言"某权限码的真实策略被写入、并在重新拉取快照后按权限码读回"，替代已删除的 TOOL-scope 控件断言。
      const POLICY_CODE = "app.ai.tool.permission-probe";
      await setValue('[data-org-field="policy-code"]', POLICY_CODE);
      await setValue('[data-org-field="policy-decision"]', "allow");
      await click('[data-org-action="save-policy"]');
      check("G7 · APP 访问保存权限策略并按权限码读回", await waitFn("document.querySelector('[data-org-policy=\"" + POLICY_CODE + "\"]')!==null"), await txt('[data-org-policy-list]'));
      await click('[data-org-nav="audit"]');
      check("G8 · Audit 面板有真实治理记录", await waitFn("document.querySelectorAll('[data-org-audit-item]').length>=1"), await js("return document.querySelectorAll('[data-org-audit-item]').length"));
    }

    if (SCOPE === "picker" || SCOPE === "all") {
      // 系统 Resource Picker 的现行入口是"项目 → 项目与资源 → 引用资源"（ProjectsApp 渲染 ResourcePicker）；
      // 旧 governance/CanvasApp（data-d3-04d="canvas"）已无渲染入口。这里改走现行产品入口。
      await click('[data-dock-id="projects"]');
      await js("const nav=Array.from(document.querySelectorAll('.split-nav')).find(function(b){return b.textContent.indexOf('项目与资源')>=0;}); if(nav) nav.click();");
      check("P0 · 项目与资源子视图打开", await waitSel('[data-d3-04d="projects"]'), "");
      await setValue('[data-d3-04d-project-name]', "UI 项目");
      await click('[data-d3-04d-project-new]');
      check("P0b · 新建项目并选中", await waitFn("document.querySelector('[data-d3-04d-project-active]')!==null"), "");
      await click('[data-d3-04d-project-add]');
      check("P1 · 打开系统 Resource Picker", await waitSel('[data-d3-04d-picker]'), "");
      await setValue('[data-d3-04d-picker-query]', "ui resource");
      await click('[data-d3-04d-picker-search]');
      check("P2 · Picker 只显示授权交集（含 UI 资源）", await waitFn("Array.from(document.querySelectorAll('[data-d3-04d-picker-item]')).some(function(e){return e.textContent.indexOf('UI 资源')>=0;})"), await txt('[data-d3-04d-picker-items]'));
      const rid = await js("const el=Array.from(document.querySelectorAll('[data-d3-04d-picker-item]')).find(function(e){return e.textContent.indexOf('UI 资源')>=0;}); return el ? el.getAttribute('data-d3-04d-picker-item') : null");
      await click('[data-d3-04d-picker-item="' + rid + '"]');
      await click('[data-d3-04d-picker-choose]');
      check("P3 · 引用后项目列出该 ResourceRef", await waitFn("document.querySelector('[data-d3-04d-project-resource]')!==null"), await txt('[data-d3-04d-project-resources]'));
    }

    if (SCOPE === "canvas" || SCOPE === "all") {
      // 画布现行实现是 CanvasHost（data-canvas-host）；governance/CanvasApp 的"节点保存 ResourceRef"
      // 能力已由 D5-02 画布体系取代（覆盖见 experiments/d5-02/canvas-e2e.mjs）。这里只守住
      // "打开的是现行画布、且不残留已废弃的治理画布"。
      await click('[data-dock-id="canvas"]');
      check("C1 · 打开现行 Canvas（CanvasHost）", await waitSel('[data-canvas-host]'), "");
      check("C2 · 不残留已废弃的治理画布", !(await has('[data-d3-04d="canvas"]')), "");
    }

    if (SCOPE === "all") {
      // 访达（appId="files"）按既定设计渲染"桌面文件夹"视图；旧的 FilesApp（data-d3-04d="files"）已废弃、
      // 无渲染入口。这里断言真实视图出现，且废弃组件的文件钩子一个都不在。
      await click('[data-dock-id="files"]');
      const folderView = await waitFn("(function(){var b=document.querySelector('.folder-body[data-drop-folder=\"desktop\"]');if(!b)return false;var root=b.closest('.split');if(!root)return false;var t=root.querySelector('.pane-title');return !!t && t.textContent.trim()==='桌面';})()");
      const noFilesApp = !(await has('[data-d3-04d="files"]')) && !(await has('[data-d3-04d-files-import]')) && !(await has('[data-d3-04d-files-export]'));
      check("F1 · 访达打开桌面文件夹视图且无 FilesApp 入口", folderView && noFilesApp, "folderView=" + folderView + " noFilesApp=" + noFilesApp);
    }

    check("Z1 · DOM 不泄漏本地路径", !(await js("return document.body.innerHTML")).includes(userData), "");
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e.message).slice(0, 200));
  } finally {
    try { win?.destroy(); } catch { /* ignore */ }
    if (userData) { try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ } }
    try { fs.rmSync(electronUserData, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
