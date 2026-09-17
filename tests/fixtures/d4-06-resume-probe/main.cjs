/**
 * D4-06 Closure · 预算停止后显式续接的 Electron 真实 UI 探针。
 *
 * 复用 production boot + product Renderer/preload + 真实 TaskHarnessOrchestrator；
 * 只有"最后一跳 provider"被 deterministic local provider 替代。UI 只经 window.openarc.task。
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
const sha256 = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

const executorSeam = { fault: null };
const report = { checks: [], errors: [], versions: {}, stats: {}, secrets: {} };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail, expected) => {
  const actual = String(detail === undefined ? "" : detail);
  report.checks.push({ name, ok: !!ok, detail: actual, expected: expected === undefined ? null : String(expected), actual });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win; let userData = null; let identity = null;
const mainErrors = []; const consoleErrors = [];
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const text = (sel) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.textContent || ''");
const attr = (sel, a) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.getAttribute(" + JSON.stringify(a) + ") || ''");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const click = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const setInput = (sel, value) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing';" +
  "const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;" +
  "const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(el, " + JSON.stringify(value) + ");" +
  "el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await Promise.resolve(fn())) return true; await sleep(80); } return false; }
async function waitSel(sel, timeout = 20000) { return waitFor(() => has(sel), timeout); }
async function waitGate(want, timeout = 30000) { const t0 = Date.now(); let last = "?"; while (Date.now() - t0 < timeout) { try { last = await js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'"); if (last === want) return last; } catch { /* navigating */ } await sleep(120); } return "TIMEOUT(last=" + last + ")"; }

const adminUser = () => identity.store.allUsers().find((u) => u.role === "ADMIN");
const aiCtx = () => ({ sessionRef: identity.service.current, appId: "ai", source: "probe" });
const taskStatus = (id) => { const t = identity.taskStore.taskById(id); return t ? t.status : null; };
const trashed = (ref) => identity.resourceService.sideEffectPrecondition({ resourceRef: ref }).trashed;

async function setPlan(mode, resourceRef) {
  const res = await fetch(CONTROL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, resourceRef }) });
  return res.ok;
}
async function createProbeResource(name) {
  const created = await identity.resourceService.createResource({ context: { sessionRef: identity.service.current, appId: "resource-library", source: "probe" }, resourceType: "text", name, content: "d4-06-resume-body" });
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

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-06-resume-"));
    const runtimeBoot = await createOpenArcRuntime({
      userDataDir: userData, safeStorage, allowAdmin: true,
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
    await setInput('[data-d3-id="login-identifier"]', ADMIN);
    await setInput('[data-d3-id="login-password"]', PW);
    await sleep(80);
    await click('[data-d3-id="login-submit"]');
    check("R0.1 · 真实 UI 登录进入桌面", (await waitGate("ready")) === "ready", "");

    // 真实 provider edge + model config + 资源/授权（setup 允许）。
    const setupCtx = { sessionRef: identity.service.current, appId: "settings", source: "probe" };
    const prov = identity.modelService.createProvider({ context: setupCtx, displayName: "D4-06 Resume Provider", baseUrl: PROVIDER_URL, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "d4-06-resume-credential" });
    if (!prov.ok) throw new Error("createProvider failed: " + JSON.stringify(prov));
    const model = identity.modelService.createModel({ context: setupCtx, providerId: prov.provider.providerId, remoteModelId: "d4-06-local", displayName: "D4-06 Local", capabilities: ["chat"], scope: "ORGANIZATION" });
    if (!model.ok) throw new Error("createModel failed: " + JSON.stringify(model));
    const def = identity.modelService.setDefault({ context: setupCtx, capability: "chat", configId: model.model.configId, scope: "ORGANIZATION" });
    if (!def.ok) throw new Error("setDefault failed: " + JSON.stringify(def));

    const grant = identity.authorization.grantAppToolPermission({ context: aiCtx(), appId: "ai", actions: ["tool.resource.search", "tool.resource.readMetadata", "tool.resource.trash"] });
    check("R0.2 · 真实产品 boot + tool 授权就绪", runtimeBoot.snapshot().modelProxyListening === true && !!(grant && grant.ok), JSON.stringify({ listening: runtimeBoot.modelProxyListening }), "model proxy listening + tool grant ok");

    // ---------------------------------------------------------------- 场景 A/F：多步任务 → 预算停止 → UI 续接成功
    const r1 = await createProbeResource("D4-06 Resume Target");
    const ctx = aiCtx();
    const t = identity.taskService.createTask({ context: ctx, goal: "D4-06 resume probe: write then continue" });
    const started = identity.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const s1 = identity.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    const s2 = identity.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: s1.task.revision });
    const ss1 = identity.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: s2.task.revision });

    // step1：真实 WRITE + 真实 approval → 已成功副作用 + Artifact。
    await setPlan("write", r1.resourceRef);
    const p1 = identity.orchestrator.runStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision, stepInput: null, verify: { type: "SCHEMA_VALID" } });
    const callSeen = await waitFor(() => identity.sideEffectStore.callsOfTask(t.task.taskId).length === 1, 120000);
    const sxc = callSeen ? identity.sideEffectStore.callsOfTask(t.task.taskId)[0] : null;
    if (!sxc) throw new Error("step1 SideEffectCall missing");
    identity.sideEffectRuntime.decideApproval({ context: { sessionRef: identity.service.current, source: "user" }, approvalRequestId: sxc.callId, decision: "APPROVE" });
    const done1 = await p1;
    const step1Artifact = identity.taskStore.artifactsOfTask(t.task.taskId).find((a) => a.step_id === s1.step.stepId);
    check("R1.1 · step1 真实 WRITE 成功且产生 Artifact", done1.ok === true && !!step1Artifact && trashed(r1.resourceRef) === true, JSON.stringify({ ok: done1.ok, artifact: !!step1Artifact, trashed: trashed(r1.resourceRef) }), "ok + artifact + trashed");

    // step2：真实预算停止（14 个受控 READ 计划）。
    const fresh = identity.taskStore.taskById(t.task.taskId);
    identity.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s2.step.stepId, expectedRevision: fresh.revision });
    await setPlan("budget");
    const r2 = await identity.orchestrator.runStep({ context: ctx, taskId: t.task.taskId, stepId: s2.step.stepId, expectedRevision: identity.taskStore.taskById(t.task.taskId).revision, stepInput: null, verify: { type: "SCHEMA_VALID" } });
    const run2 = identity.taskStore.harnessRunsOfTask(t.task.taskId).slice(-1)[0];
    check("R1.2 · step2 bounded 预算停止 → BUDGET_EXHAUSTED", r2.ok === false && r2.error === "BUDGET_EXHAUSTED" && run2.error_code === "BUDGET_EXHAUSTED", JSON.stringify({ err: r2.error, run: run2.error_code }), "BUDGET_EXHAUSTED");
    check("R1.3 · Task/Step BLOCKED + 旧 Artifact 保留", taskStatus(t.task.taskId) === "BLOCKED" && identity.taskStore.artifactsOfTask(t.task.taskId).filter((a) => a.step_id === s1.step.stepId).length === 1, taskStatus(t.task.taskId), "BLOCKED + step1 artifact");

    const elig0 = identity.taskService.getResumeEligibility({ context: ctx, taskId: t.task.taskId });
    const ledger0 = identity.taskService.getBudgetLedger({ context: ctx, taskId: t.task.taskId }).ledger;
    check("R2.1 · 后端判定可续接 + 账本", elig0.resumable === true && elig0.reason === null && ledger0.resumeCount === 0, JSON.stringify({ resumable: elig0.resumable, kind: elig0.kind, resumeCount: ledger0.resumeCount }), "resumable=true + resumeCount=0");

    // 刷新恢复：Renderers 丢弃后从 backend task/get 恢复续接入口。
    await win.webContents.reload();
    await sleep(1200);
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
    const resumeShown = await waitFor(() => has("[data-ai-resume]"), 30000);
    const panelTaskId = await attr(".ai-panel", "data-ai-task-id");
    const stopText = await text("[data-ai-stop-reason]");
    const budgetText = await text("[data-ai-resume-budget]");
    const resultText = await text("[data-ai-result]");
    check("R2.2 · 刷新后从 task/get 恢复续接入口", resumeShown && panelTaskId === t.task.taskId && (await attr(".ai-panel", "data-ai-status")) === "BLOCKED", JSON.stringify({ resumeShown, panelTaskId, status: await attr(".ai-panel", "data-ai-status") }), "resume visible + BLOCKED");
    check("R2.3 · UI 显示停止原因 / 本次追加预算 / 已完成结果", stopText.includes("BUDGET_EXHAUSTED") && budgetText.includes("MODEL_CALLS") && resultText.length > 0, JSON.stringify({ stopText: stopText.slice(0, 60), budgetText: budgetText.slice(0, 80), resultLen: resultText.length }), "BUDGET_EXHAUSTED + MODEL_CALLS +Δ + prior result");

    // 点击真实 UI 续接按钮；provider 切到 final（0 tool call → 直接收尾，证明不重放）。
    await setPlan("final");
    const clicks = await click("[data-ai-resume]");
    check("R3.1 · 点击真实续接按钮", clicks === "ok", clicks, "ok");
    const resumedOk = await waitFor(() => taskStatus(t.task.taskId) === "SUCCEEDED", 120000);
    const steps = identity.taskStore.stepsOfTask(t.task.taskId);
    const resumed = steps[steps.length - 1];
    const grantEvents = identity.taskStore.eventsOfTask(t.task.taskId).filter((e) => e.event_type === "task.budget.granted");
    check("R3.2 · 续接成功 → Task SUCCEEDED + 新 step", resumedOk && steps.length === 3 && resumed.status === "SUCCEEDED" && resumed.kind === "reasoning", JSON.stringify({ task: taskStatus(t.task.taskId), steps: steps.map((s) => s.status) }), "SUCCEEDED + 3 steps");
    const continuation = resumed.input ? JSON.parse(resumed.input) : null;
    check("R3.3 · 新 step 携带 continuation(prior artifact) 且不含旧 tool 请求", !!continuation && continuation.continuation === true && continuation.priorArtifacts.some((a) => a.artifactId === step1Artifact.artifact_id) && !("proposeSequence" in continuation), JSON.stringify({ kind: continuation && continuation.budgetKind, prior: continuation && continuation.priorArtifacts.length }), "continuation + prior artifact");
    check("R4.1 · 已成功副作用恰好一次 / 不重放", identity.sideEffectStore.callsOfTask(t.task.taskId).length === 1 && identity.sideEffectStore.callById(sxc.callId).status === "SUCCEEDED" && trashed(r1.resourceRef) === true, JSON.stringify({ calls: identity.sideEffectStore.callsOfTask(t.task.taskId).length, call: identity.sideEffectStore.callById(sxc.callId).status }), "1 SUCCEEDED call + trashed");
    check("R4.2 · 只追加一次预算 + 账本保留历史", grantEvents.length === 1 && (() => { const l = identity.taskService.getBudgetLedger({ context: ctx, taskId: t.task.taskId }).ledger; return l.resumeCount === 1 && l.additions[0].kind === "MODEL_CALLS" && !!l.additions[0].consumedAtGrant; })(), JSON.stringify({ grants: grantEvents.length }), "1 grant + consumedAtGrant");
    check("R4.3 · Task/Step/Artifact/Verification 关联链一致", (() => {
      const arts = identity.taskStore.artifactsOfTask(t.task.taskId);
      const vers = identity.taskStore.verificationsOfTask(t.task.taskId);
      return arts.length === 2 && vers.length === 2 && vers.every((v) => arts.some((a) => a.artifact_id === v.artifact_id)) && arts.every((a) => a.checksum === sha256(a.safe_content));
    })(), JSON.stringify({ arts: identity.taskStore.artifactsOfTask(t.task.taskId).length }), "2 artifacts + 2 verifications + checksum");

    // ---------------------------------------------------------------- 场景 E：真实 UNKNOWN_EFFECT → 不可续接、UI 无入口
    const e1 = await createProbeResource("D4-06 Unknown Target");
    const te = identity.taskService.createTask({ context: ctx, goal: "D4-06 unknown effect probe" });
    const ste = identity.taskService.startTask({ context: ctx, taskId: te.task.taskId, expectedRevision: te.task.revision });
    const se = identity.taskService.createStep({ context: ctx, taskId: te.task.taskId, kind: "reasoning", input: null, expectedRevision: ste.task.revision });
    identity.taskService.startStep({ context: ctx, taskId: te.task.taskId, stepId: se.step.stepId, expectedRevision: se.task.revision });
    executorSeam.fault = "CRASH_AFTER_CLAIM";
    await setPlan("write", e1.resourceRef);
    const pe = identity.orchestrator.runStep({ context: ctx, taskId: te.task.taskId, stepId: se.step.stepId, expectedRevision: identity.taskStore.taskById(te.task.taskId).revision, stepInput: null, verify: { type: "SCHEMA_VALID" } });
    const eCallSeen = await waitFor(() => identity.sideEffectStore.callsOfTask(te.task.taskId).length === 1, 120000);
    const eCall = eCallSeen ? identity.sideEffectStore.callsOfTask(te.task.taskId)[0] : null;
    if (!eCall) throw new Error("unknown-effect SideEffectCall missing");
    identity.sideEffectRuntime.decideApproval({ context: { sessionRef: identity.service.current, source: "user" }, approvalRequestId: eCall.callId, decision: "APPROVE" });
    await pe;
    executorSeam.fault = null;
    const unknownCall = identity.sideEffectStore.callById(eCall.callId);
    const eligE = identity.taskService.getResumeEligibility({ context: ctx, taskId: te.task.taskId });
    const unknownRun = identity.taskStore.harnessRunsOfTask(te.task.taskId).slice(-1)[0];
    report.stats.unknown = { call: unknownCall.status, callError: unknownCall.errorCode, runError: unknownRun && unknownRun.error_code, reason: eligE.reason };
    check("R5.1 · 非预算停止（真实 UNKNOWN/crash 恢复）→ Task BLOCKED 且后端显式拒绝续接", taskStatus(te.task.taskId) === "BLOCKED" && unknownCall.status !== "SUCCEEDED" && eligE.resumable === false && typeof eligE.reason === "string" && eligE.reason.startsWith("RESUME_"), JSON.stringify({ task: taskStatus(te.task.taskId), call: unknownCall.status, callError: unknownCall.errorCode, runError: unknownRun && unknownRun.error_code, reason: eligE.reason }), "BLOCKED + RESUME_* 显式原因");

    await win.webContents.reload();
    await sleep(1200);
    if ((await waitGate("ready", 30000)) !== "ready") {
      await setInput('[data-d3-id="login-identifier"]', ADMIN);
      await setInput('[data-d3-id="login-password"]', PW);
      await sleep(80);
      await click('[data-d3-id="login-submit"]');
      await waitGate("ready", 30000);
    }
    if (await waitSel(".assistant-pill", 30000)) await click(".assistant-pill");
    await waitSel(".ai-panel", 20000);
    const ePanel = await waitFor(() => attr(".ai-panel", "data-ai-task-id") === te.task.taskId, 30000);
    await sleep(1500);
    const ePanelTask = await attr(".ai-panel", "data-ai-task-id");
    const ePanelStatus = await attr(".ai-panel", "data-ai-status");
    const ePanelElig = identity.taskService.getResumeEligibility({ context: ctx, taskId: ePanelTask });
    check("R5.2 · 非 resumable 时 UI 不显示续接入口", (await has("[data-ai-resume]")) === false && ePanelStatus === "BLOCKED" && ePanelElig.resumable === false, JSON.stringify({ panel: ePanelTask, expected: te.task.taskId, match: ePanelTask === te.task.taskId, status: ePanelStatus, reason: ePanelElig.reason, resume: await has("[data-ai-resume]") }), "no resume entry + BLOCKED");

    // Secret scan（DB + UI）。
    let dump = "";
    try {
      const conn = identity.store.connection || identity.store.db;
      for (const row of conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) { try { for (const r of conn.prepare("SELECT * FROM " + row.name).all()) dump += JSON.stringify(r) + "\n"; } catch { /* ignore */ } }
    } catch { /* ignore */ }
    const bodyDom = await js("return document.body.innerHTML");
    const secretHits = ["mpx_", "tpx_", "d4-06-resume-credential", userData].filter((s) => s && (dump.includes(s) || bodyDom.includes(s)));
    check("I1 · DB / UI 0 capability / credential / 绝对路径泄漏", secretHits.length === 0, JSON.stringify(secretHits), "[]");
    check("I2 · Renderer console error = 0", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "), "0");
    check("I3 · main uncaught / unhandled = 0", mainErrors.length === 0, mainErrors.slice(0, 3).join(" | "), "0");
    report.secrets = { secretHits: secretHits.length, consoleErrors: consoleErrors.length, mainErrors: mainErrors.length };

    report.stats = {
      taskId: t.task.taskId,
      unknownTaskId: te.task.taskId,
      budgetStops: identity.taskStore.eventsOfTask(t.task.taskId).filter((e) => e.event_type === "task.budget_exhausted").length,
      grants: identity.taskStore.eventsOfTask(t.task.taskId).filter((e) => e.event_type === "task.budget.granted").length,
      artifacts: identity.taskStore.artifactsOfTask(t.task.taskId).length,
      sideEffectCalls: identity.sideEffectStore.callsOfTask(t.task.taskId).length,
      executorEvidence: identity.supervisor.executorEvidence().length,
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
