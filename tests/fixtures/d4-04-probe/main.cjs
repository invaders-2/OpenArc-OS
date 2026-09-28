/**
 * D4-04 Production Vertical Smoke 宿主（真实 Electron + 产品装配 + 产品 Renderer/preload）。
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
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
const check = (name, ok, detail, expected) => {
  const actual = String(detail === undefined ? "" : detail);
  report.checks.push({ name, ok: !!ok, detail: actual, expected: expected === undefined ? null : String(expected), actual });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

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
/** 同一条任务里对两个不同 resource 连续两次 trash（R2 用）。 */
async function setPlanRefs(mode, resourceRefs) {
  const res = await fetch(CONTROL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, resourceRefs }) });
  return res.ok;
}
async function runTaskViaUI(goal) {
  // Reload / 连续场景后 panel 可能仍显示上一个 task；必须等一个**新的** taskId。
  const previousTaskId = await attr(".ai-panel", "data-ai-task-id");
  await setInput("[data-ai-goal]", goal);
  // §24：Run 必须由 backend authoritative terminal state 复位；这里等 UI 合同自我恢复，不硬等固定时长。
  if (!(await waitFor(async () => !(await isDisabled("[data-ai-run]")), 60000))) throw new Error("run button never re-enabled");
  const r = await click("[data-ai-run]");
  if (r !== "ok") throw new Error("run click failed: " + r);
  const ok = await waitFor(async () => { const id = await attr(".ai-panel", "data-ai-task-id"); return typeof id === "string" && id.length > 0 && id !== previousTaskId; }, 30000);
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
    const toolGrant = identity.authorization.grantAppToolPermission({ context: aiCtx(), appId: "ai", actions: ["tool.resource.search", "tool.resource.readMetadata", "tool.resource.trash"] });
    let toolGrantId = toolGrant && toolGrant.ok && toolGrant.grant ? toolGrant.grant.grantId : null;
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
    const f4Shown = await waitFor(async () => (await text("[data-ai-status-text]")).includes("BLOCKED") || (await attr(".ai-panel", "data-ai-status")) === "BLOCKED", 30000);
    check("F4 · Renderer 显示 BLOCKED", f4Shown, await text("[data-ai-status-text]"));
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

    // Vertical Smoke R1 — 待批准时撤权，再尝试使用旧批准（真实 UI + 产品 governance API）
    const r1Res = await createSmokeResource("Revoke Pending Target");
    await setPlan("write", r1Res.resourceRef);
    const r1Task = await runTaskViaUI("REVOKE-PENDING smoke: 把 Revoke Pending Target 移入废纸篓");
    const r1Call = await waitCall(r1Task.taskId);
    const r1ApprovalShown = !!r1Call && (await waitApprovalFor(r1Call.callId, 30000));
    check("R1.1 · 撤权前 proposal 到 AWAITING_APPROVAL 且 Approval UI 可见", r1ApprovalShown && r1Call.status === "AWAITING_APPROVAL", (r1Call ? r1Call.status : "none") + "/ui=" + r1ApprovalShown, "AWAITING_APPROVAL + UI 可见");
    if (!r1Call) throw new Error("R1 proposal missing");
    const r1ExecBefore = identity.supervisor.executorEvidence().length;
    const r1Revoke = identity.authorization.revokeAppResourcePermission({ context: aiCtx(), grantId: toolGrantId });
    const r1ResourceGrantKept = identity.authStore.allAppGrants().some((g) => g.app_id === "ai" && g.resource_id === r1Res.resourceId && String(g.actions || "").includes("resource.delete"));
    check("R1.2 · 产品 governance API 撤销 app tool 权限（changed=true）", r1Revoke && r1Revoke.ok === true && r1Revoke.changed === true, JSON.stringify(r1Revoke), "ok=true, changed=true");
    check("R1.3 · 撤权只针对 tool 权限：resource grant 仍在", r1ResourceGrantKept === true, String(r1ResourceGrantKept), "true");
    const r1ApproveClick = await click('[data-approval-action="approve"]');
    check("R1.4 · 使用旧批准（真实 UI Approve）", r1ApproveClick === "ok", r1ApproveClick, "ok");
    const r1CallTerminal = await waitFor(() => ["BLOCKED", "FAILED", "CANCELLED"].includes(String(callStatus(r1Call.callId))), 120000);
    const r1Final = identity.sideEffectStore.callById(r1Call.callId);
    const r1TaskTerminal = await waitFor(() => ["BLOCKED", "FAILED", "CANCELLED"].includes(String(taskStatus(r1Task.taskId))), 120000);
    const r1Leases = identity.sideEffectStore.leasesOfCall(r1Call.callId).length;
    const r1ExecAfter = identity.supervisor.executorEvidence().length;
    const r1Calls = identity.sideEffectStore.callsOfTask(r1Task.taskId).length;
    check("R1.5 · 撤权后旧批准不得执行：call 终态 BLOCKED", r1CallTerminal && r1Final.status === "BLOCKED", String(r1Final.status), "BLOCKED");
    check("R1.6 · call error_code = SIDE_EFFECT_AUTHORIZATION_REVOKED", r1Final.errorCode === "SIDE_EFFECT_AUTHORIZATION_REVOKED", String(r1Final.errorCode), "SIDE_EFFECT_AUTHORIZATION_REVOKED");
    check("R1.7 · 0 mutation（resource 未 trashed）", trashed(r1Res.resourceRef) === false, String(trashed(r1Res.resourceRef)), "false");
    check("R1.8 · 0 lease", r1Leases === 0, String(r1Leases), "0");
    check("R1.9 · 0 新 executor（preflight 在 spawn 之前 fail closed）", r1ExecAfter === r1ExecBefore, r1ExecBefore + "→" + r1ExecAfter, "数量不变");
    check("R1.10 · Task 非 SUCCEEDED 且终态 + AUTO_RETRY=0（1 条 call）", r1TaskTerminal && taskStatus(r1Task.taskId) !== "SUCCEEDED" && r1Calls === 1, taskStatus(r1Task.taskId) + "/calls=" + r1Calls, "终态非 SUCCEEDED + calls=1");
    await waitFor(async () => (await isDisabled("[data-ai-run]")) === false, 30000);
    const r1Regrant = identity.authorization.grantAppToolPermission({ context: aiCtx(), appId: "ai", actions: ["tool.resource.search", "tool.resource.readMetadata", "tool.resource.trash"] });
    if (r1Regrant && r1Regrant.ok && r1Regrant.grant) toolGrantId = r1Regrant.grant.grantId;
    check("R1.11 · 场景结束后重新授予 tool 权限（恢复后续场景前置）", !!(r1Regrant && r1Regrant.ok && r1Regrant.grant && r1Regrant.grant.grantId), JSON.stringify({ ok: r1Regrant && r1Regrant.ok }), "ok=true");

    // Vertical Smoke R2 — 任务进行中撤权，已有副作用保留（不宣称撤权回滚）
    const r2A = await createSmokeResource("Revoke Mid A");
    const r2B = await createSmokeResource("Revoke Mid B");
    await setPlanRefs("revoke2", [r2A.resourceRef, r2B.resourceRef]);
    const r2Task = await runTaskViaUI("REVOKE-MID smoke: 依次把 Revoke Mid A / Revoke Mid B 移入废纸篓");
    const r2CallFor = (ref) => identity.sideEffectStore.callsOfTask(r2Task.taskId).find((c) => c.preconditionsSafe && c.preconditionsSafe.resourceRef === ref) || null;
    const r2ASeen = await waitFor(() => !!r2CallFor(r2A.resourceRef), 120000);
    const r2CallA = r2ASeen ? r2CallFor(r2A.resourceRef) : null;
    const r2AApprovalShown = !!r2CallA && (await waitApprovalFor(r2CallA.callId, 60000));
    check("R2.1 · refA 的 trash 到 AWAITING_APPROVAL（真实 UI）", r2ASeen && !!r2CallA && r2CallA.status === "AWAITING_APPROVAL" && r2AApprovalShown, (r2CallA ? r2CallA.status : "none") + "/ui=" + r2AApprovalShown, "AWAITING_APPROVAL + UI 可见");
    if (!r2CallA) throw new Error("R2 refA proposal missing");
    const r2AApproveClick = await click('[data-approval-action="approve"]');
    check("R2.2 · 批准并执行 refA 的真实 WRITE", r2AApproveClick === "ok", r2AApproveClick, "ok");
    const r2ADone = await waitFor(() => callStatus(r2CallA.callId) === "SUCCEEDED" && trashed(r2A.resourceRef) === true, 120000);
    check("R2.3 · refA SUCCEEDED 且 trashed（撤权前已有真实副作用）", r2ADone, callStatus(r2CallA.callId) + "/trashedA=" + trashed(r2A.resourceRef), "SUCCEEDED + trashedA=true");
    const r2BSeen = await waitFor(() => { const c = r2CallFor(r2B.resourceRef); return !!c && c.status === "AWAITING_APPROVAL"; }, 120000);
    const r2CallB = r2BSeen ? r2CallFor(r2B.resourceRef) : null;
    const r2BApprovalShown = !!r2CallB && (await waitApprovalFor(r2CallB.callId, 60000));
    check("R2.4 · refB 的 trash 到 AWAITING_APPROVAL（撤权同步点）", r2BSeen && !!r2CallB && r2CallB.status === "AWAITING_APPROVAL" && r2BApprovalShown, (r2CallB ? r2CallB.status : "none") + "/ui=" + r2BApprovalShown, "AWAITING_APPROVAL + UI 可见");
    if (!r2CallB) throw new Error("R2 refB proposal missing");
    const r2ExecBefore = identity.supervisor.executorEvidence().length;
    const r2Revoke = identity.authorization.revokeAppResourcePermission({ context: aiCtx(), grantId: toolGrantId });
    check("R2.5 · 任务进行中经产品 governance API 撤权（changed=true）", r2Revoke && r2Revoke.ok === true && r2Revoke.changed === true, JSON.stringify(r2Revoke), "ok=true, changed=true");
    check("R2.6 · 已发生副作用保留：refA trashed=true（不宣称撤权回滚）", trashed(r2A.resourceRef) === true, String(trashed(r2A.resourceRef)), "true");
    const r2ApproveClick = await click('[data-approval-action="approve"]');
    check("R2.7 · 使用旧批准（真实 UI Approve refB）", r2ApproveClick === "ok", r2ApproveClick, "ok");
    const r2CallTerminal = await waitFor(() => ["BLOCKED", "FAILED", "CANCELLED"].includes(String(callStatus(r2CallB.callId))), 120000);
    const r2FinalB = identity.sideEffectStore.callById(r2CallB.callId);
    const r2TaskTerminal = await waitFor(() => ["BLOCKED", "FAILED", "CANCELLED"].includes(String(taskStatus(r2Task.taskId))), 120000);
    const r2CallsAfter = identity.sideEffectStore.callsOfTask(r2Task.taskId).length;
    const r2LeasesB = identity.sideEffectStore.leasesOfCall(r2CallB.callId).length;
    const r2ExecAfter = identity.supervisor.executorEvidence().length;
    const r2Runs = identity.taskStore.harnessRunsOfTask(r2Task.taskId);
    const r2LastRun = r2Runs.length ? r2Runs[r2Runs.length - 1] : null;
    const r2Step = identity.taskStore.stepsOfTask(r2Task.taskId)[0] || null;
    check("R2.8 · refB 未 trashed（撤权后 fail closed，0 mutation）", trashed(r2B.resourceRef) === false, String(trashed(r2B.resourceRef)), "false");
    check("R2.9 · 第二个 call 终态 BLOCKED + 0 lease + 0 新 executor", r2CallTerminal && r2FinalB.status === "BLOCKED" && r2LeasesB === 0 && r2ExecAfter === r2ExecBefore, r2FinalB.status + "/leases=" + r2LeasesB + "/exec=" + r2ExecBefore + "→" + r2ExecAfter, "BLOCKED + 0 lease + 0 新 executor");
    check("R2.10 · 无自动重试：任务只有 2 条 call（refA/refB 各 1）", r2CallsAfter === 2, String(r2CallsAfter), "2");
    check("R2.11 · Task/Step BLOCKED + Harness run 停止（不是 RUNNING）", r2TaskTerminal && taskStatus(r2Task.taskId) === "BLOCKED" && !!r2Step && r2Step.status === "BLOCKED" && (!r2LastRun || r2LastRun.status !== "RUNNING"), taskStatus(r2Task.taskId) + "/step=" + (r2Step ? r2Step.status : "none") + "/run=" + (r2LastRun ? r2LastRun.status : "none"), "BLOCKED/BLOCKED/非 RUNNING");
    await waitFor(async () => (await isDisabled("[data-ai-run]")) === false, 30000);
    check("R2.12 · UI 最终 BLOCKED 且 Run 复位（busy=false）", (await attr(".ai-panel", "data-ai-status")) === "BLOCKED" && (await isDisabled("[data-ai-run]")) === false, await attr(".ai-panel", "data-ai-status"), "BLOCKED + run enabled");

    // D4-06 · 执行异常：受控 WRITE 在 execution 前 Domain version 已变化 → 真实受控执行失败。
    const regrantD406 = identity.authorization.grantAppToolPermission({ context: aiCtx(), appId: "ai", actions: ["tool.resource.search", "tool.resource.readMetadata", "tool.resource.trash"] });
    if (regrantD406 && regrantD406.ok && regrantD406.grant) toolGrantId = regrantD406.grant.grantId;
    const conflictRes = await createSmokeResource("Exec Fail Target");
    await setPlan("conflict", conflictRes.resourceRef);
    const conflictTask = await runTaskViaUI("EXEC-FAIL smoke: 把 Exec Fail Target 移入废纸篓");
    const conflictCall = await waitCall(conflictTask.taskId);
    const conflictApprovalShown = !!conflictCall && (await waitApprovalFor(conflictCall.callId, 60000));
    const bumpCtx = { sessionRef: identity.service.current, appId: "resource-library", source: "probe" };
    const conflictBump = await identity.resourceService.replaceText({ context: bumpCtx, resourceRef: conflictRes.resourceRef, text: "exec-fail-version-bump" });
    check("X1 · 执行异常前置：proposal 到 AWAITING_APPROVAL 且 execute 前 Domain version 已变化", conflictApprovalShown && !!conflictCall && conflictCall.status === "AWAITING_APPROVAL" && !!conflictBump && conflictBump.ok === true, JSON.stringify({ call: conflictCall ? conflictCall.status : "none", bumpOk: conflictBump && conflictBump.ok, bumpErr: conflictBump && conflictBump.error }), "AWAITING_APPROVAL + version bumped");
    if (!conflictCall) throw new Error("EXEC-FAIL proposal missing");
    const conflictExecBefore = identity.supervisor.executorEvidence().length;
    check("X2 · 点击真实 Approve（进入受控执行）", (await click('[data-approval-action="approve"]')) === "ok", "", "ok");
    const conflictBlocked = await waitFor(() => taskStatus(conflictTask.taskId) === "BLOCKED", 120000);
    const conflictFinal = identity.sideEffectStore.callById(conflictCall.callId);
    const conflictStep = identity.taskStore.stepsOfTask(conflictTask.taskId)[0] || null;
    const conflictRun = identity.taskStore.harnessRunsOfTask(conflictTask.taskId).slice(-1)[0] || null;
    const conflictArtifacts = identity.taskStore.artifactsOfTask(conflictTask.taskId).length;
    const conflictVerifs = identity.taskStore.verificationsOfTask(conflictTask.taskId).length;
    const conflictExecAfter = identity.supervisor.executorEvidence().length;
    const conflictEvidence = identity.supervisor.executorEvidence().slice(-1)[0] || null;
    report.executor.conflict = conflictEvidence;
    check("X3 · 执行异常 → Task/Step BLOCKED，Run 停止（不是 RUNNING）", conflictBlocked && taskStatus(conflictTask.taskId) === "BLOCKED" && !!conflictStep && conflictStep.status === "BLOCKED" && (!conflictRun || conflictRun.status !== "RUNNING"), JSON.stringify({ task: taskStatus(conflictTask.taskId), step: conflictStep ? conflictStep.status : "none", run: conflictRun ? conflictRun.status : "none" }), "Task/Step BLOCKED + Run 非 RUNNING");
    check("X4 · 执行异常 → 0 Artifact / 0 Verification（不适用：该路径无 artifact 提交）", conflictArtifacts === 0 && conflictVerifs === 0, JSON.stringify({ artifacts: conflictArtifacts, verifications: conflictVerifs }), "0 / 0");
    check("X5 · 执行异常 → 受控执行确实发生且失败：0 mutation / call 非 SUCCEEDED / 恰好 1 次执行（无重试）/ 0 active lease", trashed(conflictRes.resourceRef) === false && !!conflictFinal && conflictFinal.status !== "SUCCEEDED" && conflictExecAfter === conflictExecBefore + 1 && identity.sideEffectStore.leasesOfCall(conflictCall.callId).filter((l) => l.status === "ACTIVE").length === 0, JSON.stringify({ trashed: trashed(conflictRes.resourceRef), call: conflictFinal ? conflictFinal.status : "none", errorCode: conflictFinal ? conflictFinal.errorCode : null, exec: conflictExecBefore + "→" + conflictExecAfter, leaseActive: identity.sideEffectStore.leasesOfCall(conflictCall.callId).filter((l) => l.status === "ACTIVE").length }), "0 mutation + call 非 SUCCEEDED + 恰好 1 次受控执行 + 0 active lease");
    check("X6 · 执行异常 → 无自动重试（恰好 1 条 call）", identity.sideEffectStore.callsOfTask(conflictTask.taskId).length === 1, String(identity.sideEffectStore.callsOfTask(conflictTask.taskId).length), "1");
    await waitFor(async () => (await isDisabled("[data-ai-run]")) === false, 30000);
    check("X7 · 执行异常 → Renderer BLOCKED 且 Run 复位（busy=false）", (await attr(".ai-panel", "data-ai-status")) === "BLOCKED" && (await isDisabled("[data-ai-run]")) === false, await attr(".ai-panel", "data-ai-status"), "BLOCKED + run enabled");

    // D4-06 · 预算到限停止（真实产品调度链）：受控 READ 超过 Model Proxy / Tool Facade bounded 预算。
    await setPlan("budget");
    const budgetTask = await runTaskViaUI("BUDGET smoke: 连续读取直至预算到限");
    const budgetBlocked = await waitFor(() => taskStatus(budgetTask.taskId) === "BLOCKED", 180000);
    const budgetStep = identity.taskStore.stepsOfTask(budgetTask.taskId)[0] || null;
    const budgetRun = identity.taskStore.harnessRunsOfTask(budgetTask.taskId).slice(-1)[0] || null;
    const budgetArtifacts = identity.taskStore.artifactsOfTask(budgetTask.taskId).length;
    const budgetVerifs = identity.taskStore.verificationsOfTask(budgetTask.taskId).length;
    const budgetExecs = identity.toolStore.executionsOfTask(budgetTask.taskId);
    const budgetCalls = identity.taskStore.callsOfTask(budgetTask.taskId);
    const budgetSxc = identity.sideEffectStore.callsOfTask(budgetTask.taskId);
    check("Y1 · 预算到限 → Task/Step BLOCKED + Run 停止（不是 RUNNING）", budgetBlocked && taskStatus(budgetTask.taskId) === "BLOCKED" && !!budgetStep && budgetStep.status === "BLOCKED" && (!budgetRun || budgetRun.status !== "RUNNING"), JSON.stringify({ task: taskStatus(budgetTask.taskId), step: budgetStep ? budgetStep.status : "none", run: budgetRun ? budgetRun.status : "none" }), "BLOCKED/BLOCKED/非 RUNNING");
    check("Y2 · 预算到限 → 0 Artifact / 0 Verification（不适用：该路径无 artifact 提交）", budgetArtifacts === 0 && budgetVerifs === 0, JSON.stringify({ artifacts: budgetArtifacts, verifications: budgetVerifs }), "0 / 0");
    check("Y3 · 预算到限 → 只发生 bounded 受控 READ（>0 且 <=8），无 WRITE execution", budgetExecs.length > 0 && budgetExecs.length <= 8 && budgetExecs.every((e) => e.tool_id === "resource.search" && e.task_id === budgetTask.taskId), JSON.stringify({ execs: budgetExecs.length, tools: [...new Set(budgetExecs.map((e) => e.tool_id))], modelCalls: budgetCalls.length }), "1..8 次 resource.search（provider 请求 14 次被预算截断）");
    check("Y4 · 预算到限 → 0 SideEffectCall / 0 mutation / 无自动重试", budgetSxc.length === 0 && budgetExecs.filter((e) => e.tool_id === "resource.trash").length === 0, JSON.stringify({ sideEffectCalls: budgetSxc.length }), "0 SideEffectCall");
    await waitFor(async () => (await isDisabled("[data-ai-run]")) === false, 30000);
    check("Y5 · 预算到限 → Renderer BLOCKED 且 Run 复位（busy=false）", (await attr(".ai-panel", "data-ai-status")) === "BLOCKED" && (await isDisabled("[data-ai-run]")) === false, await attr(".ai-panel", "data-ai-status"), "BLOCKED + run enabled");

    // ---------------------------------------------------------------- D4-06 关联链审计（对本次运行所有 task 逐项 check）
    const d406conn = identity.store.connection || identity.store.db;
    const rawRows = (sql) => d406conn.prepare(sql).all();
    const allAuditTasks = identity.taskStore.allTasks();
    const auditTaskIds = new Set(allAuditTasks.map((t) => t.task_id));
    const stepRows = rawRows("SELECT step_id, task_id FROM task_steps");
    const stepOwner = new Map(stepRows.map((s) => [s.step_id, s.task_id]));
    const runRows = rawRows("SELECT run_id, task_id, step_id FROM task_harness_runs");
    const runOwner = new Map(runRows.map((r) => [r.run_id, r.task_id]));
    const callRows = rawRows("SELECT call_id, task_id, step_id FROM task_model_calls");
    const execRows = rawRows("SELECT execution_id, task_id, step_id, run_id FROM tool_executions");
    const sxcRows = rawRows("SELECT call_id, task_id, step_id, run_id FROM side_effect_calls");
    const artRows = rawRows("SELECT artifact_id, task_id, step_id, run_id, checksum, safe_content FROM task_artifacts");
    const verRows = rawRows("SELECT verification_id, artifact_id, task_id FROM task_verifications");
    const artifactOwner = new Map(artRows.map((a) => [a.artifact_id, a.task_id]));
    const stepOrphans = stepRows.filter((s) => !auditTaskIds.has(s.task_id)).map((s) => s.step_id);
    const callViolations = callRows.filter((c) => !auditTaskIds.has(c.task_id) || (c.step_id && stepOwner.get(c.step_id) !== c.task_id)).map((c) => c.call_id);
    const execViolations = execRows.filter((e) => !auditTaskIds.has(e.task_id) || (e.step_id && stepOwner.get(e.step_id) !== e.task_id) || (e.run_id && runOwner.get(e.run_id) !== e.task_id)).map((e) => e.execution_id);
    const runViolations = runRows.filter((r) => !auditTaskIds.has(r.task_id) || (r.step_id && stepOwner.get(r.step_id) !== r.task_id)).map((r) => r.run_id);
    const sxcViolations = sxcRows.filter((c) => !auditTaskIds.has(c.task_id) || (c.step_id && stepOwner.get(c.step_id) !== c.task_id) || (c.run_id && runOwner.get(c.run_id) !== c.task_id)).map((c) => c.call_id);
    const artViolations = artRows.filter((a) => !auditTaskIds.has(a.task_id) || (a.step_id && stepOwner.get(a.step_id) !== a.task_id) || (a.run_id && runOwner.get(a.run_id) !== a.task_id)).map((a) => a.artifact_id);
    const verViolations = verRows.filter((v) => !auditTaskIds.has(v.task_id) || artifactOwner.get(v.artifact_id) !== v.task_id).map((v) => v.verification_id);
    check("L1 · 每个 step 归属存在的 task（无孤立 step）", stepOrphans.length === 0, JSON.stringify(stepOrphans), "[]");
    check("L2 · 每个 model call 的 task/step 归属正确（无跨任务串联）", callViolations.length === 0, JSON.stringify(callViolations), "[]");
    check("L3 · 每个 tool execution 的 task/step/run 同属一个 task", execViolations.length === 0, JSON.stringify(execViolations), "[]");
    check("L4 · 每个 side-effect call 的 task/step/run 同属一个 task", sxcViolations.length === 0, JSON.stringify(sxcViolations), "[]");
    check("L5 · 每个 harness run 的 task/step 归属正确（无孤立 run）", runViolations.length === 0, JSON.stringify(runViolations), "[]");
    check("L6 · 每个 artifact 的 task/step/run 同属一个 task", artViolations.length === 0, JSON.stringify(artViolations), "[]");
    check("L7 · 每个 verification 与 artifact 同属一个 task", verViolations.length === 0, JSON.stringify(verViolations), "[]");

    const scenarioTasks = [
      { kind: "READ_SUCCESS", id: readTask && readTask.taskId },
      { kind: "WRITE_APPROVE_SUCCESS", id: writeTask && writeTask.taskId },
      { kind: "DENY", id: denyTask && denyTask.taskId },
      { kind: "CANCEL", id: cancelTask && cancelTask.taskId },
      { kind: "UNKNOWN", id: unknownTask && unknownTask.taskId },
      { kind: "SPOOF_APPROVE_SUCCESS", id: spoofTask && spoofTask.taskId },
      { kind: "REVOKE_PENDING", id: r1Task && r1Task.taskId },
      { kind: "REVOKE_MID", id: r2Task && r2Task.taskId },
      { kind: "EXECUTION_EXCEPTION", id: conflictTask && conflictTask.taskId },
      { kind: "BUDGET_STOP", id: budgetTask && budgetTask.taskId },
    ];
    const enumerated = new Set(scenarioTasks.map((s) => s.id).filter(Boolean));
    const unenumerated = allAuditTasks.map((t) => t.task_id).filter((id) => !enumerated.has(id));
    check("L8 · 本次运行所有 task 均被场景枚举（无遗漏 task）", unenumerated.length === 0, JSON.stringify({ total: allAuditTasks.length, unenumerated }), "0 unenumerated");

    const commitKinds = new Set(["READ_SUCCESS", "WRITE_APPROVE_SUCCESS", "SPOOF_APPROVE_SUCCESS"]);
    const commitViolations2 = [];
    for (const s of scenarioTasks.filter((x) => commitKinds.has(x.kind) && x.id)) {
      const taskRow = identity.taskStore.taskById(s.id);
      const steps = identity.taskStore.stepsOfTask(s.id);
      const arts = identity.taskStore.artifactsOfTask(s.id);
      const vers = identity.taskStore.verificationsOfTask(s.id);
      if (!taskRow || taskRow.status !== "SUCCEEDED") commitViolations2.push(s.kind + ":task_status=" + (taskRow ? taskRow.status : "missing"));
      for (const st of steps.filter((x) => x.status === "SUCCEEDED")) {
        const a = arts.find((x) => x.step_id === st.step_id);
        if (!a) { commitViolations2.push(s.kind + ":success_step_without_artifact:" + st.step_id); continue; }
        if (a.checksum !== sha256(a.safe_content)) commitViolations2.push(s.kind + ":checksum_mismatch:" + a.artifact_id);
        if (!vers.find((v) => v.artifact_id === a.artifact_id)) commitViolations2.push(s.kind + ":artifact_without_verification:" + a.artifact_id);
      }
    }
    check("L9 · 成功 step 必有 Artifact 且 checksum==sha256(content)；每个 Artifact 必有同 task Verification；成功任务收敛 SUCCEEDED", commitViolations2.length === 0, JSON.stringify(commitViolations2), "[]");

    const noCommitKinds = new Set(["DENY", "CANCEL", "UNKNOWN", "REVOKE_PENDING", "REVOKE_MID", "EXECUTION_EXCEPTION", "BUDGET_STOP"]);
    const noCommitDetails = [];
    const noCommitBad = [];
    for (const s of scenarioTasks.filter((x) => noCommitKinds.has(x.kind) && x.id)) {
      const taskRow = identity.taskStore.taskById(s.id);
      const arts = identity.taskStore.artifactsOfTask(s.id).length;
      const vers = identity.taskStore.verificationsOfTask(s.id).length;
      const status = taskRow ? taskRow.status : "missing";
      const ok = arts === 0 && vers === 0 && status !== "SUCCEEDED";
      const detail = s.kind + " 不适用（该路径无 artifact 提交）: status=" + status + " artifacts=" + arts + " verifications=" + vers;
      noCommitDetails.push(detail);
      if (!ok) noCommitBad.push(s.kind);
    }
    check("L10 · 拒绝/取消/撤权/UNKNOWN/执行异常/预算停止路径如实 0 Artifact / 0 Verification（明细标注不适用原因）", noCommitBad.length === 0, JSON.stringify(noCommitDetails), "all artifacts=0 verifications=0 且非 SUCCEEDED");

    const dupCallTasks = [];
    for (const t of allAuditTasks) {
      const ids = identity.sideEffectStore.callsOfTask(t.task_id).map((c) => c.callId);
      if (new Set(ids).size !== ids.length) dupCallTasks.push(t.task_id);
    }
    check("L11 · 同一 task 内 SideEffectCall callId 唯一（无重复副作用）", dupCallTasks.length === 0, JSON.stringify(dupCallTasks), "[]");

    const writeCalls = identity.sideEffectStore.callsOfTask(writeTask.taskId);
    const spoofCalls = identity.sideEffectStore.callsOfTask(spoofTask.taskId);
    check("L12 · 成功 WRITE 恰好 1 次 mutation（各 1 条 SUCCEEDED call + 目标 trashed）", writeCalls.length === 1 && writeCalls[0].status === "SUCCEEDED" && spoofCalls.length === 1 && spoofCalls[0].status === "SUCCEEDED" && trashed(resourceRef) === true && trashed(spoofRes.resourceRef) === true, JSON.stringify({ writeCalls: writeCalls.map((c) => c.status), spoofCalls: spoofCalls.map((c) => c.status), baseTrashed: trashed(resourceRef), spoofTrashed: trashed(spoofRes.resourceRef) }), "各 1 SUCCEEDED + 均已 trashed");

    const r2Calls = identity.sideEffectStore.callsOfTask(r2Task.taskId);
    check("L13 · R2 撤权中任务恰好 2 条 call（A SUCCEEDED / B BLOCKED）", r2Calls.length === 2 && r2Calls.some((c) => c.status === "SUCCEEDED") && r2Calls.some((c) => c.status === "BLOCKED"), JSON.stringify(r2Calls.map((c) => c.status)), "2 条：1 SUCCEEDED + 1 BLOCKED");

    const runningTasks = allAuditTasks.filter((t) => t.status === "RUNNING" || t.status === "PENDING").map((t) => t.task_id + "=" + t.status);
    check("L14 · 所有 task 收敛终态（无 RUNNING / PENDING）", runningTasks.length === 0, JSON.stringify(runningTasks), "[]");
    check("L15 · 预算停止 task：bounded 受控 READ execution 保留且归属正确，0 Artifact", budgetExecs.length > 0 && budgetExecs.length <= 8 && budgetExecs.every((e) => e.task_id === budgetTask.taskId && e.step_id === budgetStep.step_id) && budgetArtifacts === 0, JSON.stringify({ execs: budgetExecs.length, artifacts: budgetArtifacts }), "1..8 exec + 0 artifact");
    report.linkage = { taskCount: allAuditTasks.length, scenarioKinds: scenarioTasks.map((s) => s.kind), noCommit: noCommitDetails };

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
