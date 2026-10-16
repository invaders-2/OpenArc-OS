/**
 * Vue「项目」+「组织治理」迁移验收探针（真实 Electron）。
 *
 * 与 experiments/vue-mcp/main.cjs 同一手法：主进程自持窗口 + executeJavaScript，
 * 页面是 dist/vue.html，preload 是 electron/preload.cjs，资源 / 治理装配走
 * electron/identity-bootstrap.cjs 的真实 createIdentityService（project / picker / governance）。
 *
 * 覆盖：
 *   · dock 打开 projects → data-d3-04d 契约全集逐条断言；真实 createProject +
 *     ResourcePicker 真实交集查询 + addProjectResource（authorized=true）
 *   · dock 打开 organization → 契约全集逐条断言；切 tab、用户启停、App 启停、
 *     工具权限授予/撤销、资源权限来源、审计，全部真实命令
 *   · 全程无 console error / 无崩溃
 *
 * 需要先 npm run build。本机沙箱起不来时传：
 *   ELECTRON_EXTRA_ARGS="--no-sandbox --disable-gpu-sandbox --in-process-gpu"
 */
const { app, BrowserWindow, ipcMain, safeStorage, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/vue.html")).href;
const OUT = path.join(ROOT, "artifacts", "vue-governance");
const ADMIN = "vue-gov-admin@openarc.local";
const PW = "vue-gov-password-1";
const SEED_USER = "vueuser@openarc.local";

/** 任务要求的契约全集：grep -oE 'data-(d3-04d|gov-tool)-[a-z-]*=' src/governance/{ProjectsApp,GovernanceApp,ResourcePicker}.tsx | sort -u */
const CONTRACT = [
  "data-d3-04d-project",
  "data-d3-04d-project-active",
  "data-d3-04d-project-resource",
  "data-d3-04d-project-resource-authorized",
  "data-d3-04d-access-source",
  "data-d3-04d-app-disable",
  "data-d3-04d-app-enable",
  "data-d3-04d-app",
  "data-d3-04d-dept",
  "data-d3-04d-pane",
  "data-d3-04d-tab",
  "data-d3-04d-user-disable",
  "data-d3-04d-user-enable",
  "data-d3-04d-user",
  "data-gov-tool-access",
  "data-gov-tool-action",
  "data-gov-tool-grant-id",
  "data-gov-tool-grant",
  "data-gov-tool-revoke",
  "data-gov-tool-toggle",
  "data-d3-04d-picker-app",
  "data-d3-04d-picker-item",
];

/** 源码里全部 data-d3-04d-* / data-gov-tool-* 属性（含无值属性）。 */
const ALL_ATTRS = [
  "data-d3-04d",
  "data-d3-04d-project-name",
  "data-d3-04d-project-new",
  "data-d3-04d-projects",
  "data-d3-04d-project",
  "data-d3-04d-project-active",
  "data-d3-04d-project-add",
  "data-d3-04d-project-resources",
  "data-d3-04d-project-resource",
  "data-d3-04d-project-resource-authorized",
  "data-d3-04d-tab",
  "data-d3-04d-error",
  "data-d3-04d-user-identifier",
  "data-d3-04d-user-display",
  "data-d3-04d-user-password",
  "data-d3-04d-user-role",
  "data-d3-04d-create-user",
  "data-d3-04d-users",
  "data-d3-04d-user",
  "data-d3-04d-user-disable",
  "data-d3-04d-user-enable",
  "data-d3-04d-pane",
  "data-d3-04d-dept-name",
  "data-d3-04d-dept-desc",
  "data-d3-04d-create-dept",
  "data-d3-04d-departments",
  "data-d3-04d-dept",
  "data-d3-04d-apps",
  "data-d3-04d-app",
  "data-d3-04d-app-disable",
  "data-d3-04d-app-enable",
  "data-gov-tool-toggle",
  "data-gov-tool-access",
  "data-gov-tool-actions",
  "data-gov-tool-action",
  "data-gov-tool-grant",
  "data-gov-tool-grants",
  "data-gov-tool-grant-id",
  "data-gov-tool-revoke",
  "data-d3-04d-access-ref",
  "data-d3-04d-access-load",
  "data-d3-04d-access",
  "data-d3-04d-access-owner",
  "data-d3-04d-access-sources",
  "data-d3-04d-access-source",
  "data-d3-04d-audit",
  "data-d3-04d-audit-item",
  "data-d3-04d-picker",
  "data-d3-04d-picker-app",
  "data-d3-04d-picker-query",
  "data-d3-04d-picker-search",
  "data-d3-04d-picker-items",
  "data-d3-04d-picker-item",
  "data-d3-04d-picker-cancel",
  "data-d3-04d-picker-choose",
];

/** 只在失败态渲染、本探针不主动制造失败的契约（源码存在，见报告）。 */
const CONDITIONAL = ["data-d3-04d-project-error", "data-d3-04d-picker-error"];

const report = { checks: [], errors: [], consoleErrors: [], shots: [], versions: {}, missingContract: [], conditionalContract: [] };
const SEEN = new Set();
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail: String(detail == null ? "" : detail) });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
let userData = null;
let identity = null;

const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const text = (sel) => js("var el=document.querySelector(" + JSON.stringify(sel) + "); return el ? el.textContent.trim() : ''");
const attr = (sel, name) => js("var el=document.querySelector(" + JSON.stringify(sel) + "); return el ? el.getAttribute(" + JSON.stringify(name) + ") : null");
const classNameOf = (sel) => js("var el=document.querySelector(" + JSON.stringify(sel) + "); return el ? el.className : null");
const count = (sel) => js("return document.querySelectorAll(" + JSON.stringify(sel) + ").length");

const setValue = (sel, value) => js(
  "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
  "if (!el) return 'missing';" +
  "const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;" +
  "const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;" +
  "setter.call(el, " + JSON.stringify(value) + ");" +
  "el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));" +
  "return 'ok';"
);
const click = (sel) => js(
  "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
  "if (!el) return 'missing';" +
  "if (el.disabled) return 'disabled';" +
  "el.click(); return 'ok';"
);
const maximize = (sel) => js(
  "const root = document.querySelector(" + JSON.stringify(sel) + ");" +
  "if (!root) return 'missing';" +
  "const w = root.closest('.window');" +
  "if (!w) return 'no-window';" +
  "const btn = w.querySelector('.traffic .maximize');" +
  "if (!btn) return 'no-btn';" +
  "btn.click(); return 'ok';"
);

async function scanContracts() {
  const raw = await js(
    "return JSON.stringify(Array.from(document.querySelectorAll('*')).reduce(function(acc, el){" +
    "for (var i = 0; i < el.attributes.length; i++){ var n = el.attributes[i].name; if (n.indexOf('data-d3-04d') === 0 || n.indexOf('data-gov-tool') === 0) acc[n] = 1; }" +
    "return acc; }, {}));"
  );
  const names = JSON.parse(raw);
  for (const n of Object.keys(names)) SEEN.add(n);
  return names;
}

async function waitGate(want, timeout) {
  const t0 = Date.now();
  const limit = timeout || 30000;
  let last = "?";
  while (Date.now() - t0 < limit) {
    try {
      last = await js("return document.querySelector('.desktop') ? document.querySelector('.desktop').getAttribute('data-identity-gate') : 'no-root'");
      if (last === want) return last;
    } catch (e) { /* 导航中 */ }
    await sleep(120);
  }
  return "TIMEOUT(last=" + last + ")";
}
async function waitFor(sel, timeout) {
  const t0 = Date.now();
  const limit = timeout || 12000;
  while (Date.now() - t0 < limit) {
    if (await has(sel)) return true;
    await sleep(60);
  }
  return false;
}
async function waitFn(expr, timeout) {
  const t0 = Date.now();
  const limit = timeout || 12000;
  while (Date.now() - t0 < limit) {
    if (await js("return (" + expr + ")")) return true;
    await sleep(80);
  }
  return false;
}
async function poll(fn, timeout) {
  const t0 = Date.now();
  const limit = timeout || 10000;
  while (Date.now() - t0 < limit) {
    try { if (fn()) return true; } catch (e) { /* ignore */ }
    await sleep(100);
  }
  return false;
}

async function shoot(name) {
  await sleep(450);
  const image = await win.webContents.capturePage();
  const file = path.join(OUT, name);
  fs.writeFileSync(file, image.toPNG());
  report.shots.push(file);
  out("SHOT " + file + " " + image.getSize().width + "x" + image.getSize().height);
}

app.whenReady().then(async () => {
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform + "/" + process.arch };
    out("VERSIONS " + JSON.stringify(report.versions));
    fs.mkdirSync(OUT, { recursive: true });

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-vue-governance-"));
    identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    const adminLogin = await identity.store.login({ identifier: ADMIN, password: PW });
    const adminCtx = { sessionRef: adminLogin.session.ref, appId: "resource-library" };

    const dept = identity.authorization.createDepartment({ context: adminCtx, name: "Vue 部门" });
    if (dept.ok) identity.authorization.addDepartmentMember({ context: adminCtx, departmentId: dept.department.id, userId: identity.store.userByIdentifier(ADMIN).id, membershipRole: "member" });
    await identity.governanceService.createUser({ context: adminCtx, identifier: SEED_USER, password: "vueuser-password-1", displayName: "Vue 用户" });
    const created = await identity.resourceService.createResource({ context: adminCtx, resourceType: "text", name: "Vue 资源", content: "vue governance token" });
    await identity.searchService.search({ context: adminCtx, query: "vue", limit: 5 });
    const uiResourceRef = created && created.ok ? created.resource.resourceRef : null;

    win = new BrowserWindow({
      width: 1400,
      height: 900,
      show: false,
      webPreferences: {
        preload: path.join(ROOT, "electron/preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    win.webContents.on("console-message", function () {
      try {
        const args = Array.prototype.slice.call(arguments);
        const first = args[0];
        let level;
        let message;
        if (first && typeof first === "object" && "level" in first) { level = first.level; message = first.message; }
        else { level = args[1]; message = args[2]; }
        if (level === "error" || level === 3 || level === "3") report.consoleErrors.push(String(message));
      } catch (e) { /* 事件形状变化不影响主流程 */ }
    });
    win.webContents.on("render-process-gone", function (_e, details) { report.errors.push("render-process-gone: " + JSON.stringify(details)); });
    win.webContents.on("did-fail-load", function (_e, code, desc) { report.errors.push("did-fail-load: " + code + " " + desc); });

    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));

    registerIdentityIpc({
      ipcMain,
      service: identity.service,
      authorization: identity.authorization,
      device: identity.deviceService,
      resource: identity.resourceService,
      resourceSearch: identity.searchService,
      resourcePreview: identity.previewService,
      governance: identity.governanceService,
      projects: identity.projectService,
      canvas: identity.canvasService,
      picker: identity.pickerService,
      dialog: null,
      shell,
      BrowserWindow,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame && e.senderFrame.url === uiURL,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event); },
    });

    await win.loadURL(uiURL);
    await sleep(400);

    let g = await waitGate("unauthenticated");
    check("R0 · 进入登录页", g === "unauthenticated", "gate=" + g);
    await setValue('[data-d3-id="login-identifier"]', ADMIN);
    await setValue('[data-d3-id="login-password"]', PW);
    await waitFor('[data-d3-id="login-submit"]');
    await click('[data-d3-id="login-submit"]');
    g = await waitGate("ready");
    check("R0b · 登录进入桌面", g === "ready", "gate=" + g);

    // ══ 1. 项目 ══════════════════════════════════════════════════════════
    await click('[data-dock-id="projects"]');
    const projOpen = await waitFor('[data-d3-04d="projects"]');
    check("P1 · dock「项目」打开真实 ProjectsApp（data-d3-04d=projects）", projOpen, "");
    check("P2 · 根节点 class=projects", (await classNameOf('[data-d3-04d="projects"]')) === "projects", "class=" + (await classNameOf('[data-d3-04d="projects"]')));
    await waitFor('[data-d3-04d-projects]');
    await scanContracts();

    await setValue('[data-d3-04d-project-name]', "Vue 项目");
    await click('[data-d3-04d-project-new]');
    const active = await waitFor('[data-d3-04d-project-active]');
    check("P3 · 真实 resource/createProject 后进入项目态（data-d3-04d-project-active）", active, "active=" + (await attr('[data-d3-04d-project-active]', "data-d3-04d-project-active")));
    check("P4 · 项目行 data-d3-04d-project 且 aria-pressed=true", (await text('[data-d3-04d-project]')) === "Vue 项目" && (await attr('[data-d3-04d-project]', "aria-pressed")) === "true", "name=" + (await text('[data-d3-04d-project]')) + " pressed=" + (await attr('[data-d3-04d-project]', "aria-pressed")));
    await scanContracts();

    await click('[data-d3-04d-project-add]');
    const pickerOpen = await waitFor('[data-d3-04d-picker]');
    check("P5 · 「引用资源」调起系统 ResourcePicker（data-d3-04d-picker）", pickerOpen, "");
    check("P6 · Picker 绑定 pickerAppId=resource-library", (await attr('[data-d3-04d-picker]', "data-d3-04d-picker-app")) === "resource-library", "app=" + (await attr('[data-d3-04d-picker]', "data-d3-04d-picker-app")));
    await setValue('[data-d3-04d-picker-query]', "vue");
    await click('[data-d3-04d-picker-search]');
    const picked = await waitFn("Array.from(document.querySelectorAll('[data-d3-04d-picker-item]')).some(function(e){return e.textContent.indexOf('Vue 资源')>=0;})", 12000);
    check("P7 · Picker 真实交集查询命中「Vue 资源」（data-d3-04d-picker-item）", picked, "items=" + (await count('[data-d3-04d-picker-item]')) + " list=" + (await text('[data-d3-04d-picker-items]')));
    await scanContracts();
    const rid = await js("var el=Array.from(document.querySelectorAll('[data-d3-04d-picker-item]')).find(function(e){return e.textContent.indexOf('Vue 资源')>=0;}); return el ? el.getAttribute('data-d3-04d-picker-item') : null;");
    if (rid) { await click('[data-d3-04d-picker-item="' + rid + '"]'); await click('[data-d3-04d-picker-choose]'); }
    const linked = await waitFor('[data-d3-04d-project-resource]', 12000);
    check("P8 · 真实 resource/addProjectResource 后项目资源行出现（authorized=true）", linked && (await attr('[data-d3-04d-project-resource]', "data-d3-04d-project-resource-authorized")) === "true" && (await text('[data-d3-04d-project-resource]')).indexOf("Vue 资源") >= 0, "row=" + (await text('[data-d3-04d-project-resource]')));
    await scanContracts();

    await maximize('[data-d3-04d="projects"]');
    await sleep(300);
    await shoot("projects.png");

    // ══ 2. 组织治理 ══════════════════════════════════════════════════════
    await click('[data-dock-id="organization"]');
    const govOpen = await waitFor('[data-d3-04d="app"]');
    check("G1 · dock「组织治理」打开真实 GovernanceApp（data-d3-04d=app）", govOpen, "");
    check("G2 · 根节点 class=gov", (await classNameOf('[data-d3-04d="app"]')) === "gov", "class=" + (await classNameOf('[data-d3-04d="app"]')));
    await waitFor('[data-d3-04d-user]');
    check("G3 · 用户 tab 默认打开且列出真实用户", (await count('[data-d3-04d-user]')) >= 2, "users=" + (await count('[data-d3-04d-user]')));
    check("G4 · tab aria-selected 与 pane 契约", (await attr('[data-d3-04d-tab="users"]', "aria-selected")) === "true" && (await has('[data-d3-04d-pane="users"]')), "users-tab=" + (await attr('[data-d3-04d-tab="users"]', "aria-selected")));
    await scanContracts();

    await click('[data-d3-04d-create-user]');
    const errShown = await waitFor('[data-d3-04d-error]', 8000);
    check("G5 · 空表单创建用户走真实命令并显示 data-d3-04d-error", errShown, "error=" + (await text('[data-d3-04d-error]')));
    await scanContracts();

    await setValue('[data-d3-04d-user-identifier]', "vuetwo@openarc.local");
    await setValue('[data-d3-04d-user-display]', "Vue2");
    await setValue('[data-d3-04d-user-password]', "vuetwo-password-1");
    await setValue('[data-d3-04d-user-role]', "MEMBER");
    await click('[data-d3-04d-create-user]');
    check("G6 · UI 创建用户成功（列表出现 Vue2）", await waitFn("Array.from(document.querySelectorAll('[data-d3-04d-user]')).some(function(e){return e.textContent.indexOf('Vue2')>=0;})", 12000), "");
    await scanContracts();

    const seedUser = identity.store.userByIdentifier(SEED_USER);
    await click('[data-d3-04d-user-disable="' + seedUser.id + '"]');
    const disabled = await poll(() => identity.store.userById(seedUser.id).status === "DISABLED", 10000);
    check("G7 · UI 禁用用户经真实 governance/setUserStatus 生效", disabled, "status=" + identity.store.userById(seedUser.id).status);
    const enableShown = await waitFor('[data-d3-04d-user-enable="' + seedUser.id + '"]');
    check("G8 · 禁用后出现 data-d3-04d-user-enable", enableShown, "");
    await scanContracts();
    await click('[data-d3-04d-user-enable="' + seedUser.id + '"]');
    check("G9 · UI 重新启用后主进程状态回 ACTIVE", await poll(() => identity.store.userById(seedUser.id).status === "ACTIVE", 10000), "status=" + identity.store.userById(seedUser.id).status);

    await maximize('[data-d3-04d="app"]');
    await sleep(300);
    await shoot("governance-users.png");

    await click('[data-d3-04d-tab="departments"]');
    const deptShown = await waitFor('[data-d3-04d-dept]');
    check("G10 · 部门面板列出真实部门（data-d3-04d-dept）", deptShown && (await text('[data-d3-04d-dept]')).indexOf("Vue 部门") >= 0, "dept=" + (await text('[data-d3-04d-dept]')));
    check("G11 · 部门 pane 与表单契约", (await has('[data-d3-04d-pane="departments"]')) && (await has('[data-d3-04d-dept-name]')) && (await has('[data-d3-04d-dept-desc]')) && (await has('[data-d3-04d-create-dept]')), "");
    await scanContracts();

    await click('[data-d3-04d-tab="apps"]');
    await waitFor('[data-d3-04d-app]');
    check("G12 · 应用面板列出内置 App", (await count('[data-d3-04d-app]')) >= 5, "apps=" + (await count('[data-d3-04d-app]')));
    await scanContracts();
    check("G13 · 启用态显示 data-d3-04d-app-disable", await has('[data-d3-04d-app-disable="ai"]'), "");
    await click('[data-d3-04d-app-disable="ai"]');
    const appDisabled = await waitFor('[data-d3-04d-app-enable="ai"]', 10000);
    check("G14 · UI 禁用 App 后出现 data-d3-04d-app-enable（真实 setAppStatus）", appDisabled, "");
    await scanContracts();
    await shoot("governance-apps.png");
    await click('[data-d3-04d-app-enable="ai"]');
    await waitFor('[data-d3-04d-app-disable="ai"]', 10000);
    check("G15 · UI 重新启用 App 后回到 data-d3-04d-app-disable", await has('[data-d3-04d-app-disable="ai"]'), "");

    await click('[data-gov-tool-toggle="ai"]');
    const toolOpen = await waitFor('[data-gov-tool-access="ai"]');
    check("G16 · 展开工具权限区块（data-gov-tool-access）", toolOpen && (await has('[data-gov-tool-action]')), "actions=" + (await count('[data-gov-tool-action]')));
    check("G17 · 工具动作默认未授予（无勾选、无 grant）", (await count('[data-gov-tool-access="ai"] input[type=checkbox]:checked')) === 0 && (await count('[data-gov-tool-grant-id]')) === 0, "");
    await scanContracts();
    const firstAction = await js("var el=document.querySelector('[data-gov-tool-action]'); return el ? el.getAttribute('data-gov-tool-action') : null;");
    if (firstAction) await click('[data-gov-tool-action="' + firstAction + '"] input[type=checkbox]');
    await click('[data-gov-tool-grant="ai"]');
    const grantShown = await waitFor('[data-gov-tool-grant-id]', 10000);
    check("G18 · UI 显式勾选后授予成功（data-gov-tool-grant-id）", grantShown, "action=" + firstAction + " error=" + (await text('[data-d3-04d-error]')));
    check("G19 · 主进程存在 TOOL scope grant", await poll(() => identity.authStore.allAppGrants().some((r) => r.app_id === "ai" && String(r.scope) === "TOOL"), 10000), "");
    await scanContracts();
    await shoot("governance-tool-access.png");
    await click('[data-gov-tool-revoke]');
    check("G20 · UI 撤销后 TOOL grant 消失", await poll(() => identity.authStore.allAppGrants().filter((r) => r.app_id === "ai").every((r) => String(r.scope) !== "TOOL"), 10000), "");

    await click('[data-d3-04d-tab="access"]');
    await setValue('[data-d3-04d-access-ref]', uiResourceRef);
    await click('[data-d3-04d-access-load]');
    const accessShown = await waitFor('[data-d3-04d-access]', 10000);
    check("G21 · 资源权限来源面板显示真实结果（data-d3-04d-access-source）", accessShown && (await has('[data-d3-04d-access-source]')) && (await has('[data-d3-04d-access-owner]')), "source=" + (await text('[data-d3-04d-access-sources]')));
    await scanContracts();

    await click('[data-d3-04d-tab="audit"]');
    const auditShown = await waitFor('[data-d3-04d-audit-item]', 10000);
    check("G22 · 审计面板有真实治理记录（data-d3-04d-audit-item）", auditShown, "rows=" + (await count('[data-d3-04d-audit-item]')));
    await scanContracts();

    // ── 契约全集逐条断言 ─────────────────────────────────────────────────
    for (const name of CONTRACT) {
      const exists = SEEN.has(name);
      if (!exists) report.missingContract.push(name);
      check("C · 契约 " + name, exists, exists ? "" : "缺失");
    }
    for (const name of ALL_ATTRS) {
      if (CONTRACT.includes(name) || CONDITIONAL.includes(name)) continue;
      const exists = SEEN.has(name);
      check("A · 属性 " + name, exists, exists ? "" : "缺失（源码存在）");
    }
    report.conditionalContract = CONDITIONAL.filter((n) => !SEEN.has(n));

    await sleep(400);
    check("X1 · 全程没有 console error", report.consoleErrors.length === 0, report.consoleErrors.slice(0, 4).join(" | "));
    check("X2 · 渲染进程没有崩溃 / 加载失败", report.errors.length === 0, report.errors.slice(0, 4).join(" | "));
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String((e && e.message) || e).slice(0, 200));
  } finally {
    try { if (win) win.destroy(); } catch (e) { /* ignore */ }
    if (userData) { try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
