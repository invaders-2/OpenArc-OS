/**
 * D4-05 S4 / A36 · 记忆隔离的真实 Electron UI 探针（真实 Electron + 真实产品 Renderer/preload/IPC）。
 *
 * 正式链路：真实 product boot（createOpenArcRuntime → createIdentityService → createTaskBundle
 * 自动装配 MemoryContext）→ 真实 Renderer 登录 / 切账号 → 真实 UI task/run（registerTaskIpc）
 * → 产品 TaskHarnessOrchestrator → official dsh facade → HarnessAdapter/HarnessModelAdapter
 * → ModelProxy → 确定性本地 provider（final 模式，无 tool call）。
 *
 * 记忆装配只发生在唯一出站口，正文只进 provider 请求体（本进程内存），绝不落盘 / 进 UI / 进日志。
 * 断言全部基于真实 provider 请求体（经 /__bodies 在内存中读取）与产品 API 的后端状态。
 *
 * 绝不直写 DB、绝不手工设置终态、绝不替换 prompt、绝不伪造 PASS。
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { registerTaskIpc } = require(path.join(ROOT, "electron/task-bootstrap.cjs"));
const { createDefaultExecutorLauncher } = require(path.join(ROOT, "electron/executor-launcher.cjs"));
const { createOpenArcRuntime } = require(path.join(ROOT, "electron/runtime-boot.cjs"));
// Closure-4：信任分层结构（固定规则 system + 低信任 reference user），断言与产品实现同源。
const { OPENARC_RULES_TEXT, RULES_NAME, REFERENCE_NAME } = require(path.join(ROOT, "electron/harness-model-adapter.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";
const ALICE = "d4-05-alice@openarc.test";
const ALICE_PW = "d4-05-alice-password-1";
const DANA = "d4-05-dana@openarc.test";
const DANA_PW = "d4-05-dana-password-1";
const PROVIDER_URL = process.env.OPENARC_D4_PROVIDER_URL || "";
const PROVIDER_BASE = PROVIDER_URL.replace(/\/v1\/?$/, "");
const SECRET = String(process.env.OPENARC_D4_05_SECRET || "SECRET_INJECT_MEM_UI_FALLBACK");
const SECRET_PREFIX = "SECRET_INJECT_MEM_UI_";
const GOAL = "project alpha";
const FINAL = "OPENARC_D4_05_MEMORY_UI_OK";

const report = {
  checks: [], errors: [], versions: {}, stats: {}, secrets: {},
  chain: {
    mode: "official-dsh-facade+product-orchestrator+memory-context",
    officialDshFacade: true,
    memoryInjectionPoint: "HarnessModelAdapter (unique outbound boundary)",
    provider: "deterministic local HTTP (tests/fixtures/d4-04-provider.mjs mode=final)",
    reason: null,
  },
};
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail, expected) => {
  const actual = String(detail === undefined ? "" : detail);
  report.checks.push({ name, ok: !!ok, detail: actual, expected: expected === undefined ? null : String(expected), actual });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win; let userData = null; let identity = null; let runtimeBoot = null;
const mainErrors = []; const consoleErrors = [];
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const text = (sel) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.textContent || ''");
const attr = (sel, a) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.getAttribute(" + JSON.stringify(a) + ") || ''");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const isDisabled = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? !!el.disabled : true;");
const click = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const setInput = (sel, value) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing';" +
  "const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;" +
  "const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(el, " + JSON.stringify(value) + ");" +
  "el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await Promise.resolve(fn())) return true; await sleep(80); } return false; }
async function waitSel(sel, timeout = 20000) { return waitFor(() => has(sel), timeout); }
async function waitGate(want, timeout = 30000) { const t0 = Date.now(); let last = "?"; while (Date.now() - t0 < timeout) { try { last = await js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'"); if (last === want) return last; } catch { /* navigating */ } await sleep(120); } return "TIMEOUT(last=" + last + ")"; }
const adminUser = () => identity.store.allUsers().find((u) => u.role === "ADMIN");
const taskStatus = (id) => { const t = identity.taskStore.taskById(id); return t ? t.status : null; };
const libCtx = () => ({ sessionRef: identity.service.current, appId: "resource-library", source: "probe" });
const adminCtx = (ref) => ({ sessionRef: ref, appId: "settings", source: "probe" });

async function loginAs(identifier, password) {
  await setInput('[data-d3-id="login-identifier"]', identifier);
  await setInput('[data-d3-id="login-password"]', password);
  await sleep(80);
  await click('[data-d3-id="login-submit"]');
  return waitGate("ready", 30000);
}
async function logout() {
  await click('[data-d3-id="topbar-logout"]');
  return waitGate("unauthenticated", 20000);
}
async function openPanel() {
  // assistant-pill 是 toggle：已打开时再点会关闭面板。仅当面板不存在时才点开。
  if (await has(".ai-panel")) return true;
  if (await waitSel(".assistant-pill", 30000)) await click(".assistant-pill");
  return waitSel(".ai-panel", 20000);
}

async function setPlan(mode) {
  const res = await fetch(PROVIDER_BASE + "/__plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, finalText: FINAL }) });
  if (!res.ok) throw new Error("provider /__plan failed: " + res.status);
}
/** 请求体只在 provider 进程内存；此处经本机控制端点读回本进程内存，绝不落盘。 */
async function readBodies() {
  const res = await fetch(PROVIDER_BASE + "/__bodies");
  if (!res.ok) throw new Error("provider /__bodies failed: " + res.status);
  const json = await res.json();
  return Array.isArray(json.bodies) ? json.bodies : [];
}
function messagesOf(body) { return body && Array.isArray(body.messages) ? body.messages : []; }
function messageContentText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
  return "";
}
function bodyText(body) { return messagesOf(body).map(messageContentText).join("\n"); }
function messageByName(body, name) { return messagesOf(body).find((m) => m && m.name === name) || null; }
/** 一次请求中记忆正文是否只落在低信任 reference 消息内（高信任 system/developer 绝不含 secret/标题）。 */
function referenceIsLowTrust(body, memName) {
  const ref = messageByName(body, REFERENCE_NAME);
  if (!ref || ref.role !== "user") return false;
  for (const m of messagesOf(body)) {
    if (!m || (m.role !== "system" && m.role !== "developer") || m === ref) continue;
    const text = messageContentText(m);
    if (text.includes(SECRET) || text.includes(memName)) return false;
  }
  return true;
}

async function runGoalViaUI(goal) {
  await openPanel();
  const previousTaskId = await attr(".ai-panel", "data-ai-task-id");
  await setInput("[data-ai-goal]", goal);
  if (!(await waitFor(async () => !(await isDisabled("[data-ai-run]")), 60000))) throw new Error("run button never re-enabled");
  const r = await click("[data-ai-run]");
  if (r !== "ok") throw new Error("run click failed: " + r);
  const started = await waitFor(async () => { const id = await attr(".ai-panel", "data-ai-task-id"); return typeof id === "string" && id.length > 0 && id !== previousTaskId; }, 30000);
  const taskId = await attr(".ai-panel", "data-ai-task-id");
  if (!started || !taskId) throw new Error("task did not start via UI");
  const terminal = await waitFor(() => { const s = taskStatus(taskId); return !!s && ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(s); }, 120000);
  return { taskId, status: taskStatus(taskId), terminal };
}

app.whenReady().then(async () => {
  process.on("uncaughtException", (e) => mainErrors.push(String((e && e.message) || e)));
  process.on("unhandledRejection", (e) => mainErrors.push(String((e && e.message) || e)));
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch, provider: PROVIDER_URL ? "local-http" : "missing" };
    out("VERSIONS " + JSON.stringify(report.versions));
    out("CHAIN " + JSON.stringify(report.chain));

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-05-memory-ui-"));
    // §5/§7：与真实 electron/main.cjs 同一个 production boot helper。
    runtimeBoot = await createOpenArcRuntime({
      userDataDir: userData, safeStorage, allowAdmin: true,
      executorLauncher: createDefaultExecutorLauncher(),
    });
    identity = runtimeBoot.identity;
    out("DIAG runtime-booted");
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    for (const appId of ["ai", "resource-library", "settings"]) if (!identity.authStore.appById(appId)) identity.authStore.upsertApp({ appId, name: appId, publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
    identity.authStore.upsertAppGrant({ appId: "ai", resourceType: "model", actions: ["model.view", "model.use", "model.test"], grantedBy: "system:model-baseline", organizationId: adminUser().team_id });

    // 真实产品 boot 会自动装配受控记忆（runtime 提供 searchService/resourceService）。
    const mc = identity.orchestrator && identity.orchestrator.memoryContext;
    const memWired = !!(mc && typeof mc.assemble === "function" && mc.searchService && mc.resourceService);
    out("DIAG memory-wired=" + memWired);

    // admin 产品 API 会话（store-level，与 D4-08 的 outsider 同样式），用于 setup + 显式 memory grant。
    const adminLogin = await identity.store.login({ identifier: ADMIN, password: PW });
    if (!adminLogin || !adminLogin.ok) throw new Error("admin store login failed: " + JSON.stringify(adminLogin && adminLogin.error));
    const adminRef = adminLogin.session.ref;
    const aliceCreated = await identity.store.createUser({ identifier: ALICE, password: ALICE_PW, displayName: "D4-05 Alice", teamId: adminUser().team_id });
    if (!aliceCreated || !aliceCreated.ok) throw new Error("create alice failed: " + JSON.stringify(aliceCreated && aliceCreated.error));
    const danaCreated = await identity.store.createUser({ identifier: DANA, password: DANA_PW, displayName: "D4-05 Dana", teamId: adminUser().team_id });
    if (!danaCreated || !danaCreated.ok) throw new Error("create dana failed: " + JSON.stringify(danaCreated && danaCreated.error));

    win = new BrowserWindow({ width: 1360, height: 900, show: false, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    win.webContents.on("console-message", (...args) => {
      const d = args[1];
      const level = d && typeof d === "object" ? d.level : args[1];
      const message = d && typeof d === "object" ? d.message : args[2];
      if (level === "error" || level === 2 || level === 3) consoleErrors.push(String(message).slice(0, 200));
    });
    const trusted = (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL;
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    registerIdentityIpc({
      ipcMain, service: identity.service, authorization: identity.authorization, device: identity.deviceService,
      resource: identity.resourceService, resourceSearch: identity.searchService, resourcePreview: identity.previewService,
      governance: identity.governanceService, projects: identity.projectService, canvas: identity.canvasService, picker: identity.pickerService,
      model: identity.modelService, sideEffect: identity.sideEffectGateway, BrowserWindow, isTrusted: trusted,
      send: (event) => { if (win && !win.isDestroyed()) win.webContents.send("identity:event", event); },
      sendSideEffect: (event) => { if (win && !win.isDestroyed()) win.webContents.send("sideeffect:event", event); },
    });
    registerTaskIpc({ ipcMain, taskService: identity.taskService, orchestrator: identity.orchestrator, identity: identity.service, isTrusted: trusted, send: (event) => { if (win && !win.isDestroyed()) win.webContents.send("task:event", event); } });

    out("DIAG window-created");
    await win.loadURL(uiURL);
    out("DIAG url-loaded");
    await sleep(600);

    // ---------------------------------------------------------------- 真实 UI 登录 alice
    check("R0.1 · 真实 UI 登录 alice → 桌面 ready", (await loginAs(ALICE, ALICE_PW)) === "ready", "", "ready");
    const aliceRef = identity.service.current;
    out("DIAG alice-logged-in");

    const snap = runtimeBoot.snapshot();
    check("R0.2 · 真实产品 boot + model proxy listening", snap.modelProxyStarted === true && snap.modelProxyListening === true, JSON.stringify({ started: snap.modelProxyStarted, listening: snap.modelProxyListening }), "started + listening");
    check("R0.3 · production orchestrator 自动装配 MemoryContext（searchService/resourceService 可用）", memWired, JSON.stringify({ wired: memWired }), "MemoryContext assembled");

    // 真实 provider edge + model config（official dsh 经 Model Proxy 消费 chat capability），setup 用 admin session。
    const setupCtx = adminCtx(adminRef);
    const prov = identity.modelService.createProvider({ context: setupCtx, displayName: "D4-05 Memory UI Provider", baseUrl: PROVIDER_URL, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "d4-05-memory-ui-credential" });
    if (!prov.ok) throw new Error("createProvider failed: " + JSON.stringify(prov));
    const model = identity.modelService.createModel({ context: setupCtx, providerId: prov.provider.providerId, remoteModelId: "d4-05-memory-ui", displayName: "D4-05 Memory UI", capabilities: ["chat"], scope: "ORGANIZATION" });
    if (!model.ok) throw new Error("createModel failed: " + JSON.stringify(model));
    const def = identity.modelService.setDefault({ context: setupCtx, capability: "chat", configId: model.model.configId, scope: "ORGANIZATION" });
    if (!def.ok) throw new Error("setDefault failed: " + JSON.stringify(def));
    out("DIAG model-ready");

    // ---------------------------------------------------------------- 建 memory（产品 API）+ §25 显式 grant
    const memName = "Project Alpha Notes";
    const memContent = SECRET + " project alpha roadmap; reference data only";
    const created = await identity.resourceService.createResource({ context: libCtx(), resourceType: "memory", name: memName, content: memContent, memorySubtype: "project-memory", scope: "PERSONAL" });
    if (!created.ok) throw new Error("createResource(memory) failed: " + JSON.stringify(created.error));
    const memoryRef = created.resource.resourceRef;
    await identity.searchService.indexResource(created.resource.resourceId);
    const grant = identity.authorization.grantAppResourcePermission({ context: setupCtx, appId: "ai", resourceType: "memory", actions: ["resource.search", "resource.read"] });
    check("S1.1 · 产品 API 建 personal memory（名称命中 project alpha）+ ai 显式 memory grant（§25）", created.ok === true && created.resource.resourceType === "memory" && !!(grant && grant.ok && grant.grant), JSON.stringify({ created: created.ok, type: created.resource.resourceType, grant: !!(grant && grant.ok), secretInGoal: GOAL.includes(SECRET) }), "memory created + explicit memory grant");

    // ---------------------------------------------------------------- 断言前置：确认检索真的命中（否则 S1.2 无意义）
    const preSearch = await identity.searchService.search({ context: { sessionRef: aliceRef, appId: "ai", source: "probe" }, query: GOAL, filter: { resourceType: "memory" }, agent: true, limit: 5 });
    report.stats.searchHit = !!(preSearch && preSearch.ok && preSearch.items.some((i) => i.resourceRef === memoryRef));
    check("S1.2 · 授权检索命中该 memory（implicit AND 的全部 goal 词都能在文档中找到）", report.stats.searchHit === true, JSON.stringify({ ok: !!(preSearch && preSearch.ok), hits: preSearch && preSearch.ok ? preSearch.items.length : null }), "检索命中该 memory");

    // ---------------------------------------------------------------- 授权记忆生效：真实 UI task/run
    await setPlan("final");
    const run1 = await runGoalViaUI(GOAL);
    const bodies1 = await readBodies();
    const all1 = bodies1.map(bodyText).join("\n");
    const refs1 = bodies1.map((b) => messageByName(b, REFERENCE_NAME)).filter(Boolean);
    const refPayloadOk = refs1.some((r) => {
      try {
        const payload = JSON.parse(r.content);
        return payload && payload.trust === "untrusted" && Array.isArray(payload.items) && payload.items.some((i) => String(i.text).includes(SECRET) && String(i.resourceRef).startsWith("resource://"));
      } catch { return false; }
    });
    // 放置：rules(system) 紧跟 reference(user)，且 rules 之前只允许前导 system 消息。
    const placementOk = bodies1.some((b) => {
      const msgs = messagesOf(b);
      const refIdx = msgs.findIndex((m) => m && m.name === REFERENCE_NAME);
      const rulesIdx = msgs.findIndex((m) => m && m.name === RULES_NAME);
      if (refIdx < 0 || rulesIdx < 0 || refIdx !== rulesIdx + 1) return false;
      const rules = msgs[rulesIdx];
      return rules.role === "system" && rules.content === OPENARC_RULES_TEXT && msgs.slice(0, rulesIdx).every((m) => m.role === "system");
    });
    const highTrustClean1 = bodies1.length > 0 && bodies1.every((b) => referenceIsLowTrust(b, memName));
    report.stats.run1 = { taskId: run1.taskId, status: run1.status, bodies: bodies1.length, reference: refs1.length, hasSecret: all1.includes(SECRET) };
    check("S1.3 · 授权记忆生效：真实 UI task SUCCEEDED，provider 请求体含 openarc.reference_data 参考消息 + 唯一 secret", run1.terminal === true && run1.status === "SUCCEEDED" && bodies1.length > 0 && refs1.length > 0 && refPayloadOk && all1.includes(SECRET), JSON.stringify({ status: run1.status, bodies: bodies1.length, reference: refs1.length, secret: all1.includes(SECRET) }), "SUCCEEDED + reference_data(user) + secret");
    check("S1.4 · 信任分层：reference 紧跟 rules、role=user；rules 为固定 system 常量；任何 system/developer 消息不含 secret/memory 标题", placementOk && highTrustClean1 && GOAL.includes(SECRET) === false, JSON.stringify({ placement: placementOk, highTrustClean: highTrustClean1, goalHasSecret: GOAL.includes(SECRET) }), "rules(system) + reference(user) + 高信任角色无 secret");

    // ---------------------------------------------------------------- 删除（产品 API trash + permanentDelete）
    const del = identity.resourceService.delete({ context: libCtx(), resourceRef: memoryRef });
    const perm = identity.resourceService.permanentDelete({ context: libCtx(), resourceRef: memoryRef });
    check("S2.1 · 产品 API 删除 memory（trash + permanentDelete）成功且不可再读", del.ok === true && del.changed === true && perm.ok === true && perm.changed === true, JSON.stringify({ trash: del.ok === true && del.changed === true, permanent: perm.ok === true && perm.changed === true }), "trash+permanentDelete ok");

    // ---------------------------------------------------------------- 删除后隔离：同一 goal 再经真实 UI 跑
    await setPlan("final");
    const run2 = await runGoalViaUI(GOAL);
    const bodies2 = await readBodies();
    const all2 = bodies2.map(bodyText).join("\n");
    const struct2 = bodies2.filter((b) => messageByName(b, REFERENCE_NAME) || messageByName(b, RULES_NAME));
    report.stats.run2 = { taskId: run2.taskId, status: run2.status, bodies: bodies2.length, injected: struct2.length, secret: all2.includes(SECRET) };
    check("S2.2 · 删除后同一 goal 真实 UI 任务：provider 请求体不再含 memory 注入结构（rules/reference）与 secret", run2.terminal === true && bodies2.length > 0 && struct2.length === 0 && !all2.includes(SECRET), JSON.stringify({ status: run2.status, bodies: bodies2.length, injected: struct2.length, secret: all2.includes(SECRET) }), "absent");

    // ---------------------------------------------------------------- 切账号 dana
    const logoutGate = await logout();
    const danaReady = await loginAs(DANA, DANA_PW);
    await setPlan("final");
    const run3 = await runGoalViaUI(GOAL);
    const bodies3 = await readBodies();
    const all3 = bodies3.map(bodyText).join("\n");
    const struct3 = bodies3.filter((b) => messageByName(b, REFERENCE_NAME) || messageByName(b, RULES_NAME));
    report.stats.run3 = { taskId: run3.taskId, status: run3.status, bodies: bodies3.length, injected: struct3.length, secret: all3.includes(SECRET) };
    check("S3.1 · 真实 UI 切账号 dana：同一 goal 请求体不含 alice 的 secret / memory 注入结构", logoutGate === "unauthenticated" && danaReady === "ready" && run3.terminal === true && bodies3.length > 0 && struct3.length === 0 && !all3.includes(SECRET), JSON.stringify({ logout: logoutGate, login: danaReady, status: run3.status, injected: struct3.length, secret: all3.includes(SECRET) }), "absent");

    // dana 的 session 读 alice 的 task → TASK_FORBIDDEN
    const danaRef = identity.service.current;
    const danaCtx = { sessionRef: danaRef, appId: "ai", source: "probe" };
    const denied = identity.taskService.getTask({ context: danaCtx, taskId: run1.taskId });
    const deniedSteps = identity.taskService.getSteps({ context: danaCtx, taskId: run1.taskId });
    report.stats.crossUser = { getTask: denied.error, getSteps: deniedSteps.error };
    check("S3.2 · dana 的真实 session 读 alice 的 task → TASK_FORBIDDEN", denied.ok === false && denied.error === "TASK_FORBIDDEN" && deniedSteps.ok === false && deniedSteps.error === "TASK_FORBIDDEN", JSON.stringify(report.stats.crossUser), "TASK_FORBIDDEN");

    out("DIAG flow-done");

    // ---------------------------------------------------------------- 留存 / 泄漏检查
    // 强制一次授权检索触发索引 reconcile（删除的 resource 从 search doc 清理），再 dump。
    await identity.searchService.search({ context: danaCtx, query: GOAL, filter: { resourceType: "memory" }, agent: true, limit: 5 });
    let dump = "";
    try {
      const conn = identity.store.connection || identity.store.db;
      for (const row of conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) { try { for (const rr of conn.prepare("SELECT * FROM " + row.name).all()) dump += JSON.stringify(rr) + "\n"; } catch { /* ignore */ } }
    } catch { /* ignore */ }
    const bodyDom = await js("return document.body.innerHTML");
    const secretTerms = [SECRET, SECRET_PREFIX];
    const dbHits = secretTerms.filter((s) => s && dump.includes(s));
    const domHits = secretTerms.filter((s) => s && bodyDom.includes(s));
    const pathTerms = ["mpx_", "tpx_", "d4-05-memory-ui-credential", userData];
    const dbPathHits = pathTerms.filter((s) => s && dump.includes(s));
    const domPathHits = pathTerms.filter((s) => s && bodyDom.includes(s));
    report.secrets = { dbHits: dbHits.length, domHits: domHits.length, dbPathHits: dbPathHits.length, domPathHits: domPathHits.length, consoleErrors: consoleErrors.length, mainErrors: mainErrors.length, secretHits: dbHits.length + domHits.length };
    check("I1 · DB / Renderer DOM 0 memory 正文 secret 留存 / 泄漏（删除后无残留）", dbHits.length === 0 && domHits.length === 0, JSON.stringify({ db: dbHits.length, dom: domHits.length }), "0 / 0");
    check("I2 · DB / Renderer DOM 0 capability / credential / 私有路径泄漏", dbPathHits.length === 0 && domPathHits.length === 0, JSON.stringify({ db: dbPathHits.length, dom: domPathHits.length }), "0 / 0");
    check("I3 · Renderer console error = 0", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "), "0");
    check("I4 · main uncaught / unhandled = 0", mainErrors.length === 0, mainErrors.slice(0, 3).join(" | "), "0");
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String((e && e.message) || e).slice(0, 200));
  } finally {
    try { win?.destroy(); } catch { /* ignore */ }
    try { identity?.store?.close(); } catch { /* ignore */ }
    if (userData) { try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
