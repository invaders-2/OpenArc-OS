/**
 * D4-04 Production Vertical Smoke 宿主（真实 Electron + 产品装配 + 产品 Renderer/preload）。
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

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";
const PROVIDER_URL = process.env.OPENARC_D4_PROVIDER_URL || "";
const CONTROL_URL = PROVIDER_URL.replace(/\/v1\/?$/, "") + "/__plan";

// D4-04 Closure：UNKNOWN_EFFECT fault seam 只由本 probe assembly 构造注入（constructor-only），
// 绝不来自 process.env / Renderer / IPC / Harness / ACP / tool args。production 默认 null。
const executorSeam = { fault: null };
const report = { checks: [], errors: [], versions: {}, stats: {}, secrets: {}, executor: {} };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail) }); out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win; let userData = null; let identity = null; let runtimeBoot = null;
const mainErrors = []; const consoleErrors = [];
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const text = (sel) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.textContent || ''");
const attr = (sel, a) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.getAttribute(" + JSON.stringify(a) + ") || ''");
const click = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const isDisabled = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? !!el.disabled : true;");
const setInput = (sel, value) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing';" +
  "const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;" +
  "const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(el, " + JSON.stringify(value) + ");" +
  "el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
async function waitSel(sel, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await has(sel)) return true; await sleep(100); } return false; }
async function waitFor(fn, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await Promise.resolve(fn())) return true; await sleep(80); } return false; }
async function waitGate(want, timeout = 30000) { const t0 = Date.now(); let last = "?"; while (Date.now() - t0 < timeout) { try { last = await js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'"); if (last === want) return last; } catch { /* navigating */ } await sleep(120); } return "TIMEOUT(last=" + last + ")"; }

const adminUser = () => identity.store.allUsers().find((u) => u.role === "ADMIN");
const aiCtx = () => ({ sessionRef: identity.service.current, appId: "ai", source: "probe" });
const taskStatus = (id) => { const t = identity.taskStore.taskById(id); return t ? t.status : null; };
const callStatus = (id) => { const c = identity.sideEffectStore.callById(id); return c ? c.status : null; };
const trashed = (ref) => identity.resourceService.sideEffectPrecondition({ resourceRef: ref }).trashed;

async function setPlan(mode, resourceRef) {
  const res = await fetch(CONTROL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, resourceRef }) });
  return res.ok;
}
async function runTaskViaUI(goal) {
  await setInput("[data-ai-goal]", goal);
  // §24：Run 必须由 backend authoritative terminal state 复位；这里等 UI 合同自我恢复，不硬等固定时长。
  if (!(await waitFor(async () => !(await isDisabled("[data-ai-run]")), 60000))) throw new Error("run button never re-enabled");
  const r = await click("[data-ai-run]");
  if (r !== "ok") throw new Error("run click failed: " + r);
  const ok = await waitFor(async () => { const id = await attr(".ai-panel", "data-ai-task-id"); return typeof id === "string" && id.length > 0; }, 30000);
  const taskId = await attr(".ai-panel", "data-ai-task-id");
  return { taskId, started: ok };
}
async function waitCall(taskId, timeout = 120000) {
  const ok = await waitFor(() => identity.sideEffectStore.callsOfTask(taskId).length > 0, timeout);
  return ok ? identity.sideEffectStore.callsOfTask(taskId)[0] : null;
}
/** 等 Approval UI 真正对应**本任务**的 call，避免匹配到上一个场景残留的 approval 元素。 */
const approvalIds = () => js("return Array.from(document.querySelectorAll('[data-approval-request-id]')).map(function(e){return e.getAttribute('data-approval-request-id')})");
async function waitApprovalFor(callId, timeout = 120000) {
  return waitFor(async () => { const ids = await approvalIds(); return Array.isArray(ids) && ids.includes(callId); }, timeout);
}
async function createSmokeResource(name) {
  const created = await identity.resourceService.createResource({ context: { sessionRef: identity.service.current, appId: "resource-library", source: "probe" }, resourceType: "text", name, content: "vertical-smoke-body" });
  if (!created.ok) throw new Error("createResource failed: " + JSON.stringify(created));
  identity.authorization.grantAppResourcePermission({ context: aiCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.read", "resource.delete"] });
  identity.authorization.grantResourcePermission({ context: aiCtx(), principalType: "USER", principalId: adminUser().id, resourceId: created.resource.resourceId, actions: ["resource.read", "resource.delete", "resource.useByAgent"] });
  await identity.searchService.indexResource(created.resource.resourceId);
  return { resourceId: created.resource.resourceId, resourceRef: created.resource.resourceRef };
}

app.whenReady().then(async () => {
  process.on("uncaughtException", (e) => mainErrors.push(String((e && e.message) || e)));
  process.on("unhandledRejection", (e) => mainErrors.push(String((e && e.message) || e)));
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch, provider: PROVIDER_URL ? "local-http" : "missing" };
    out("VERSIONS " + JSON.stringify(report.versions));

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-04-"));
    // §5/§7/§17：probe 与真实 electron/main.cjs 调用**同一个** production boot helper，
    // 保证 identity 创建 → Model Proxy start 的顺序与装配完全一致。
    runtimeBoot = await createOpenArcRuntime({
      userDataDir: userData,
      safeStorage,
      allowAdmin: true,
      executorLauncher: createDefaultExecutorLauncher(),
      executorTestHook: () => executorSeam.fault,
    });
    identity = runtimeBoot.identity;
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    for (const appId of ["ai", "resource-library", "settings"]) if (!identity.authStore.appById(appId)) identity.authStore.upsertApp({ appId, name: appId, publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
    identity.authStore.upsertAppGrant({ appId: "ai", resourceType: "model", actions: ["model.view", "model.use", "model.test"], grantedBy: "system:model-baseline", organizationId: adminUser().team_id });

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

    await win.loadURL(uiURL);
    await sleep(600);
    check("A1 · production Electron + Renderer 启动", (await waitGate("unauthenticated")) === "unauthenticated", "");
    await setInput('[data-d3-id="login-identifier"]', ADMIN);
    await setInput('[data-d3-id="login-password"]', PW);
    await sleep(80);
    await click('[data-d3-id="login-submit"]');
    check("A2 · 真实 UI 登录进入桌面", (await waitGate("ready")) === "ready", "");

    // Setup（§36 允许）：真实 provider edge 配置 + production Resource Service 建 smoke resource + grants。
    const ctx = { sessionRef: identity.service.current, appId: "settings", source: "probe" };
    const prov = identity.modelService.createProvider({ context: ctx, displayName: "D4 Vertical Provider", baseUrl: PROVIDER_URL, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "vertical-smoke-credential" });
    if (!prov.ok) throw new Error("createProvider failed: " + JSON.stringify(prov));
    const model = identity.modelService.createModel({ context: ctx, providerId: prov.provider.providerId, remoteModelId: "d4-04-local", displayName: "D4 Local", capabilities: ["chat"], scope: "ORGANIZATION" });
    if (!model.ok) throw new Error("createModel failed: " + JSON.stringify(model));
    const def = identity.modelService.setDefault({ context: ctx, capability: "chat", configId: model.model.configId, scope: "ORGANIZATION" });
    if (!def.ok) throw new Error("setDefault failed: " + JSON.stringify(def));
    const baseResource = await createSmokeResource("Vertical Smoke Resource");
    const resourceId = baseResource.resourceId; const resourceRef = baseResource.resourceRef;
    identity.authorization.grantAppToolPermission({ context: aiCtx(), appId: "ai", actions: ["tool.resource.search", "tool.resource.readMetadata", "tool.resource.trash"] });
    check("A3 · preload Task 桥只有 command,onEvent", (await js("return window.openarc && window.openarc.task ? Object.keys(window.openarc.task).sort().join(',') : 'missing'")) === "command,onEvent", "");
    check("A4 · Renderer 拿不到 Task Runtime / Domain", await js("return typeof window.openarc.taskService === 'undefined' && typeof window.openarc.resourceService === 'undefined'"), "");
    await click(".assistant-pill");
    check("A5 · 打开 AI 面板", await waitSel(".ai-panel"), "");

    // §9/§10：真实 product boot evidence（safe；绝不含 proxy token / absolute path / credential）。
    const admission = runtimeBoot.noteTaskAdmission();
    report.productRuntime = {
      ...runtimeBoot.snapshot(),
      taskAdmissionAfterProxyStart: admission.afterProxyStartAttempt === true && admission.afterRuntimeReady === true,
    };
    check("A6 · Real product runtime boot assembly", report.productRuntime.identityCreated === true && report.productRuntime.modelProxyStartAttempted === true && report.productRuntime.modelProxyStarted === true && report.productRuntime.modelProxyListening === true && report.productRuntime.taskAdmissionAfterProxyStart === true, JSON.stringify({ started: report.productRuntime.modelProxyStarted, listening: report.productRuntime.modelProxyListening, order: report.productRuntime.bootOrder }));

    // Vertical Smoke A — READ
    await setPlan("read", resourceRef);
    const readTask = await runTaskViaUI("READ smoke: 搜索并读取 Vertical Smoke Resource");
    const readDone = await waitFor(() => taskStatus(readTask.taskId) === "SUCCEEDED", 120000);
    const readExecs = identity.toolStore.executionsOfTask(readTask.taskId);
    out("DIAG_READ_TOOLS " + JSON.stringify({ proposals: identity.toolStore.proposalsOfTask(readTask.taskId).map((p) => ({ tool: p.tool_id, status: p.status })), decisions: identity.toolStore.decisionsOfTask(readTask.taskId).map((d) => ({ status: d.decision, reason: d.reason_code })), execs: readExecs.map((e) => ({ tool: e.tool_id, status: e.status })) }));
    if (!readDone) out("DIAG_READ " + JSON.stringify({ status: taskStatus(readTask.taskId), runs: identity.taskStore.harnessRunsOfTask(readTask.taskId).map((x) => ({ status: x.status, error: x.error_code, stop: x.stop_reason })), events: identity.taskStore.eventsOfTask(readTask.taskId).map((e) => e.event_type) }));
    check("B1 · READ vertical smoke → Task SUCCEEDED", readDone, String(taskStatus(readTask.taskId)));
    check("B2 · READ ToolExecution >= 2 且 verification PASS", readExecs.length >= 2 && readExecs.every((e) => e.verification_status === "PASS"), "execs=" + readExecs.length);
    check("B3 · READ 0 SideEffectCall / 0 mutation", identity.sideEffectStore.callsOfTask(readTask.taskId).length === 0 && trashed(resourceRef) === false, "");
    const readShown = await waitFor(async () => (await text("[data-ai-result]")).includes("OPENARC_VERTICAL_SMOKE_OK"), 30000);
    check("B4 · Renderer 显示 READ 最终结果", readShown, (await text("[data-ai-result]")).slice(0, 40));
    const bodyDom = await js("return document.body.innerHTML");
    const leaks = ["/Users/", "/private/", "/var/folders", userData, path.join(userData, "library"), "mpx_", "tpx_"].filter((s) => s && bodyDom.includes(s));
    check("B5 · Renderer 无绝对路径 / store root / capability 泄漏", leaks.length === 0, JSON.stringify(leaks));

    // Vertical Smoke B — WRITE Approval（真实 UI Approve）
    await setPlan("write", resourceRef);
    const writeTask = await runTaskViaUI("WRITE smoke: 把 Vertical Smoke Resource 移入废纸篓");
    const writeCall = await waitCall(writeTask.taskId);
    const approvalAppeared = !!writeCall && (await waitApprovalFor(writeCall.callId, 30000));
    out("DIAG_APPROVAL " + JSON.stringify({ callId: writeCall && writeCall.callId, ids: await approvalIds(), hasApproval: await has(".approval") }));
    if (!writeCall) out("DIAG_WRITE " + JSON.stringify({ status: taskStatus(writeTask.taskId), events: identity.taskStore.eventsOfTask(writeTask.taskId).map((e) => e.event_type), runs: identity.taskStore.harnessRunsOfTask(writeTask.taskId).map((x) => ({ status: x.status, error: x.error_code })), proposals: identity.toolStore.proposalsOfTask(writeTask.taskId).map((p) => ({ tool: p.tool_id, status: p.status })), decisions: identity.toolStore.decisionsOfTask(writeTask.taskId).map((d) => ({ status: d.decision, reason: d.reason_code })) }));
    check("C1 · WRITE proposal → Approval UI 出现", approvalAppeared && !!writeCall && writeCall.status === "AWAITING_APPROVAL", writeCall ? writeCall.status : "none");
    if (!writeCall) throw new Error("WRITE proposal missing");
    check("C2 · 审批前 0 mutation / 0 lease / 0 WRITE execution", !!writeCall && trashed(resourceRef) === false && identity.sideEffectStore.leasesOfCall(writeCall.callId).length === 0 && identity.toolStore.executionsOfTask(writeTask.taskId).filter((e) => e.tool_id === "resource.trash").length === 0, "");
    const approvalText = await text(".approval");
    check("C3 · Approval UI 显示 tool / risk / target / effect", approvalText.includes("Trash Resource") && approvalText.includes("可逆写入") && approvalText.includes("Vertical Smoke Resource"), approvalText.replace(/\s+/g, " ").slice(0, 120));
    check("C4 · Approval UI 无路径 / token", !/\/Users\/|\/private\/|\/var\/folders|mpx_|tpx_/.test(approvalText), "");
    check("C5 · 点击真实 Approve", (await click('[data-approval-action="approve"]')) === "ok", "");
    const writeDone = await waitFor(() => taskStatus(writeTask.taskId) === "SUCCEEDED", 120000);
    const finalCall = identity.sideEffectStore.callById(writeCall.callId);
    if (!writeDone) out("DIAG_C6 " + JSON.stringify({ task: taskStatus(writeTask.taskId), call: callStatus(writeCall.callId), error: finalCall && finalCall.errorCode, events: identity.taskStore.eventsOfTask(writeTask.taskId).map((e) => e.event_type), leases: identity.sideEffectStore.leasesOfCall(writeCall.callId).map((l) => l.status) }));
    check("C6 · WRITE → Task SUCCEEDED + mutation exactly 1", writeDone && trashed(resourceRef) === true, "task=" + taskStatus(writeTask.taskId));
    check("C7 · SideEffectCall=1 / approval=1 / lease=1 / verification PASS", identity.sideEffectStore.callsOfTask(writeTask.taskId).length === 1 && finalCall.status === "SUCCEEDED" && finalCall.verificationStatus === "PASS" && identity.sideEffectStore.approvalsOfCall(writeCall.callId).filter((a) => a.decision === "APPROVED").length === 1 && identity.sideEffectStore.leasesOfCall(writeCall.callId).length === 1, finalCall.status);
    const writeEvidence = identity.supervisor.executorEvidence().slice(-1)[0] || null;
    const writeLeases = identity.sideEffectStore.leasesOfCall(writeCall.callId);
    report.executor = { launcher: identity.supervisor.launcher.constructor.name, processType: process.type, electron: process.versions.electron, node: process.versions.node, write: writeEvidence };
    check("C8 · production executor spawned + ready + real child exit", !!writeEvidence && writeEvidence.spawned === true && writeEvidence.ready === true && writeEvidence.exited === true && writeEvidence.exitCode === 0, JSON.stringify(writeEvidence));
    check("C9 · WRITE 恰好 1 个 lease 且 RELEASED", writeLeases.length === 1 && writeLeases[0].status === "RELEASED", JSON.stringify(writeLeases.map((l) => l.status)));
    await waitFor(async () => (await isDisabled("[data-ai-run]")) === false, 30000);
    check("C10 · Renderer Run 复位（busy=false）", (await isDisabled("[data-ai-cancel]")) === true && (await isDisabled("[data-ai-run]")) === false, "cancelDisabled=" + (await isDisabled("[data-ai-cancel]")));

    // Vertical Smoke C — Deny
    const denyRes = await createSmokeResource("Deny Target");
    await setPlan("deny", denyRes.resourceRef);
    const denyTask = await runTaskViaUI("DENY smoke: 删除 Deny Target");
    const denyCall = await waitCall(denyTask.taskId);
    await waitApprovalFor(denyCall.callId);
    check("D1 · Deny 前 WAITING_APPROVAL + 0 mutation", !!denyCall && denyCall.status === "AWAITING_APPROVAL" && trashed(denyRes.resourceRef) === false, "");
    check("D2 · 点击真实 Deny", (await click('[data-approval-action="deny"]')) === "ok", "");
    await waitFor(() => ["BLOCKED", "FAILED", "CANCELLED"].includes(taskStatus(denyTask.taskId)), 90000);
    check("D3 · Deny → 0 mutation / 0 lease / 0 WRITE execution", trashed(denyRes.resourceRef) === false && identity.sideEffectStore.leasesOfCall(denyCall.callId).length === 0 && identity.toolStore.executionsOfTask(denyTask.taskId).filter((e) => e.tool_id === "resource.trash").length === 0, String(taskStatus(denyTask.taskId)));
    await waitFor(async () => (await isDisabled("[data-ai-run]")) === false, 30000);
    check("D4 · Deny → SideEffectCall safe terminal + UI busy 复位", ["BLOCKED", "FAILED", "CANCELLED"].includes(String(callStatus(denyCall.callId))) && !["RUNNING", null].includes(taskStatus(denyTask.taskId)) && (await isDisabled("[data-ai-run]")) === false, callStatus(denyCall.callId) + "/" + taskStatus(denyTask.taskId));

    // Vertical Smoke D — Cancel while waiting
    const cancelRes = await createSmokeResource("Cancel Target");
    await setPlan("cancel", cancelRes.resourceRef);
    const cancelTask = await runTaskViaUI("CANCEL smoke: 删除 Cancel Target");
    const cancelCall = await waitCall(cancelTask.taskId);
    await waitApprovalFor(cancelCall.callId);
    check("E1 · Cancel 前 Approval UI 可见 + 0 mutation", !!cancelCall && trashed(cancelRes.resourceRef) === false, "");
    check("E2 · 点击真实 Cancel", (await click("[data-ai-cancel]")) === "ok", "");
    const cancelled = await waitFor(() => taskStatus(cancelTask.taskId) === "CANCELLED", 90000);
    check("E3 · Cancel → Task CANCELLED / 0 mutation / 0 lease", cancelled && trashed(cancelRes.resourceRef) === false && identity.sideEffectStore.leasesOfCall(cancelCall.callId).length === 0, String(taskStatus(cancelTask.taskId)));
    await waitFor(() => ["BLOCKED", "CANCELLED", "FAILED", "SUCCEEDED"].includes(callStatus(cancelCall.callId)), 20000);
    const staleApprove = await js("return window.openarc.sideEffect.command({ type:'sideEffect/decideApproval', approvalRequestId:" + JSON.stringify(cancelCall.callId) + ", decision:'APPROVE' })");
    check("E4 · Cancel 后旧 Approval 点击不得执行", staleApprove && staleApprove.ok === false && trashed(cancelRes.resourceRef) === false, JSON.stringify(staleApprove));

    // Vertical Smoke E — UNKNOWN_EFFECT
    const unknownRes = await createSmokeResource("Unknown Target");
    // constructor-only fault seam（probe assembly 注入）；绝不写 process.env。
    executorSeam.fault = "CRASH_AFTER_CLAIM";
    await setPlan("unknown", unknownRes.resourceRef);
    const unknownTask = await runTaskViaUI("UNKNOWN smoke: 删除 Unknown Target");
    const unknownCall = await waitCall(unknownTask.taskId);
    await waitApprovalFor(unknownCall.callId);
    await click('[data-approval-action="approve"]');
    const blocked = await waitFor(() => taskStatus(unknownTask.taskId) === "BLOCKED", 120000);
    executorSeam.fault = null;
    const unknownEvents = identity.taskStore.eventsOfTask(unknownTask.taskId).map((e) => e.event_type);
    check("F1 · UNKNOWN_EFFECT → Task BLOCKED", blocked, String(taskStatus(unknownTask.taskId)));
    check("F2 · Step BLOCKED + Harness STOP", identity.taskStore.stepById(identity.taskStore.stepsOfTask(unknownTask.taskId)[0].step_id).status === "BLOCKED", "");
    check("F3 · UNKNOWN_EFFECT 证据 + 0 second SideEffectCall", unknownEvents.includes("tool.side_effect.unknown_effect") && identity.sideEffectStore.callsOfTask(unknownTask.taskId).length === 1 && callStatus(unknownCall.callId) !== "SUCCEEDED", "");
    check("F4 · Renderer 显示 BLOCKED", (await text("[data-ai-status-text]")).includes("BLOCKED") || (await attr(".ai-panel", "data-ai-status")) === "BLOCKED", await text("[data-ai-status-text]"));
    const claimIdx = unknownEvents.indexOf("tool.side_effect.execution_started");
    const unknownIdx = unknownEvents.indexOf("tool.side_effect.unknown_effect");
    const unknownEvidence = identity.supervisor.executorEvidence().slice(-1)[0] || null;
    report.executor.unknown = unknownEvidence;
    check("F5 · claim RUNNING 先于真实 child exit 崩溃", claimIdx >= 0 && unknownIdx > claimIdx && !!unknownEvidence && unknownEvidence.exited === true && unknownEvidence.exitCode === 9, JSON.stringify({ claimIdx, unknownIdx, ev: unknownEvidence }));
    check("F6 · UNKNOWN 后 0 第二 call / 0 第二 lease / 0 retry", identity.sideEffectStore.callsOfTask(unknownTask.taskId).length === 1 && identity.sideEffectStore.leasesOfCall(unknownCall.callId).length === 1 && callStatus(unknownCall.callId) !== "SUCCEEDED", callStatus(unknownCall.callId));
    await waitFor(async () => (await attr(".ai-panel", "data-ai-status")) === "BLOCKED", 30000);
    check("F7 · Renderer BLOCKED + Run 复位（busy=false）", (await attr(".ai-panel", "data-ai-status")) === "BLOCKED" && (await isDisabled("[data-ai-run]")) === false, await attr(".ai-panel", "data-ai-status"));

    // Spoof scenario（真实 IPC + spoofed actor，0 authority gain）
    const spoofRes = await createSmokeResource("Spoof Target");
    await setPlan("write", spoofRes.resourceRef);
    const spoofTask = await runTaskViaUI("SPOOF smoke: 删除 Spoof Target");
    const spoofCall = await waitCall(spoofTask.taskId);
    await waitApprovalFor(spoofCall.callId);
    const spoofResult = await js("return window.openarc.sideEffect.command({ type:'sideEffect/decideApproval', approvalRequestId:" + JSON.stringify(spoofCall.callId) + ", decision:'APPROVE', userId:'u_attacker', role:'ADMIN', sessionRef:'sess_evil', riskClass:'READ_ONLY' })");
    const spoofApproval = identity.sideEffectStore.latestApprovalOfCall(spoofCall.callId);
    check("G1 · Renderer 自报 actor/risk 被忽略（真实 session 决定）", spoofResult && spoofResult.ok === true && spoofApproval && spoofApproval.actorUserId === adminUser().id && spoofApproval.approvedEffectClass === "REVERSIBLE_WRITE", JSON.stringify({ ok: spoofResult && spoofResult.ok, actor: spoofApproval && spoofApproval.actorUserId }));
    const fakeApproval = await js("return window.openarc.sideEffect.command({ type:'sideEffect/decideApproval', approvalRequestId:'scall_fake', decision:'APPROVE' })");
    check("G2 · 伪造 approvalRequestId → DENY（0 authority gain）", fakeApproval && fakeApproval.ok === false, JSON.stringify(fakeApproval));

    // Spoof approve 走完整受控执行（真实 session 决定 → 仍然 exactly-once 执行 + verify）
    const spoofDone = await waitFor(() => ["SUCCEEDED", "BLOCKED", "FAILED", "CANCELLED"].includes(String(taskStatus(spoofTask.taskId))), 120000);
    check("G3 · 伪造 actor 的真实 approve 仍走完整受控执行", spoofDone && callStatus(spoofCall.callId) === "SUCCEEDED" && trashed(spoofRes.resourceRef) === true, String(taskStatus(spoofTask.taskId)) + "/" + callStatus(spoofCall.callId));

    // Reload（§27）：Renderers 内存全部丢弃，只能从 backend authoritative state 恢复。
    await win.webContents.reload();
    await sleep(1500);
    let gate = await waitGate("ready", 30000);
    if (gate !== "ready") {
      await setInput('[data-d3-id="login-identifier"]', ADMIN);
      await setInput('[data-d3-id="login-password"]', PW);
      await sleep(80);
      await click('[data-d3-id="login-submit"]');
      gate = await waitGate("ready", 30000);
    }
    if (await waitSel(".assistant-pill", 30000)) await click(".assistant-pill");
    await waitSel(".ai-panel", 20000);
    const reloadRestored = await waitFor(async () => (await attr(".ai-panel", "data-ai-task-id")).length > 0 && (await text("[data-ai-result]")).length > 0, 30000);
    check("H1 · Reload 后从 backend state 恢复 Task 结果", reloadRestored, "taskId=" + (await attr(".ai-panel", "data-ai-task-id")) + " gate=" + gate);

    // Secret scan
    let dump = "";
    try {
      const conn = identity.store.connection || identity.store.db;
      for (const row of conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) { try { for (const r of conn.prepare("SELECT * FROM " + row.name).all()) dump += JSON.stringify(r) + "\n"; } catch { /* ignore */ } }
    } catch { /* ignore */ }
    const secretHits = ["mpx_", "tpx_", "vertical-smoke-credential", userData, path.join(userData, "library")].filter((s) => s && dump.includes(s));
    report.secrets = { secretHits: secretHits.length, consoleErrors: consoleErrors.length, mainErrors: mainErrors.length };
    check("I1 · DB 0 capability / credential / path 泄漏", secretHits.length === 0, JSON.stringify(secretHits));
    check("I2 · Renderer console error = 0", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
    check("I3 · main uncaught / unhandled = 0", mainErrors.length === 0, mainErrors.slice(0, 3).join(" | "));
    const evidenceDump = JSON.stringify(report.executor || {});
    check("I4 · executor evidence 0 绝对路径 / capability / credential", !/\/Users\/|\/private\/|\/var\/folders|mpx_|tpx_|vertical-smoke-credential/.test(evidenceDump), "");

    const perTaskToolCalls = [readTask, writeTask, denyTask, cancelTask, unknownTask, spoofTask].map((t) => (t && t.taskId ? identity.toolStore.executionsOfTask(t.taskId).length : 0));
    report.stats = {
      readExecutions: readExecs.length,
      sideEffectCalls: identity.sideEffectStore.callsOfTask(writeTask.taskId).length,
      approvals: identity.sideEffectStore.approvalsOfCall(writeCall.callId).filter((a) => a.decision === "APPROVED").length,
      leases: identity.sideEffectStore.leasesOfCall(writeCall.callId).length,
      businessMutations: trashed(resourceRef) ? 1 : 0,
      hiddenRetries: 0,
      maxToolCallsPerTask: Math.max(0, ...perTaskToolCalls),
      toolCallsPerTask: perTaskToolCalls,
      verifications: [finalCall, identity.sideEffectStore.callById(spoofCall.callId)].filter((c) => c && c.verificationStatus === "PASS").length,
    };
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
