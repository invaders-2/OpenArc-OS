/**
 * D4-05 · S2 结果未知「人工确认入口」的 Electron 真实 UI 探针。
 *
 * 复用 production boot + product Renderer/preload + 真实 TaskService/SideEffectRuntime。
 * 结果未知的构造与 D4-06 Closure live-unlinked 同源：真实存活 executor acquireLease + claim
 * RUNNING（Domain mutation 被 stdin gate 挂起），OpenArc 无法证明 origin runtime 已死 →
 * recoverOnStartup 落 UNKNOWN_EFFECT / Task·Step BLOCKED（不直改 DB、不手工 insert 终态）。
 *
 * UI 只经 window.openarc.task；断言 recovery 区块、人工确认、且无 Success/Retry/Resume 入口。
 */
const { app, BrowserWindow, ipcMain, safeStorage, utilityProcess } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { registerTaskIpc } = require(path.join(ROOT, "electron/task-bootstrap.cjs"));
const { createDefaultExecutorLauncher } = require(path.join(ROOT, "electron/executor-launcher.cjs"));
const { createOpenArcRuntime } = require(path.join(ROOT, "electron/runtime-boot.cjs"));
const { RuntimeSupervisor } = require(path.join(ROOT, "electron/runtime-supervisor.cjs"));
const GATED_EXECUTOR = path.join(ROOT, "tests", "fixtures", "harness-acp", "supervised-executor.mjs");

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";
const PROVIDER_URL = process.env.OPENARC_D4_PROVIDER_URL || "";

const report = { checks: [], errors: [], versions: {}, stats: {}, secrets: {} };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail, expected) => {
  const actual = String(detail === undefined ? "" : detail);
  report.checks.push({ name, ok: !!ok, detail: actual, expected: expected === undefined ? null : String(expected), actual });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win; let identity = null; let userData = null; let box = null;
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

app.whenReady().then(async () => {
  process.on("uncaughtException", (e) => mainErrors.push(String((e && e.message) || e)));
  process.on("unhandledRejection", (e) => mainErrors.push(String((e && e.message) || e)));
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch, provider: PROVIDER_URL ? "local-http" : "missing" };
    out("VERSIONS " + JSON.stringify(report.versions));

    // /tmp 短路径：gated executor 的 lifetime unix socket 必须 < 104 bytes。
    userData = fs.mkdtempSync("/tmp/oa5rec-");
    const runtimeBoot = await createOpenArcRuntime({ userDataDir: userData, safeStorage, allowAdmin: true, executorLauncher: createDefaultExecutorLauncher() });
    identity = runtimeBoot.identity;
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    for (const appId of ["ai", "resource-library", "settings"]) if (!identity.authStore.appById(appId)) identity.authStore.upsertApp({ appId, name: appId, publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
    identity.authStore.upsertAppGrant({ appId: "ai", resourceType: "model", actions: ["model.view", "model.use", "model.test"], grantedBy: "system:model-baseline", organizationId: adminUser().team_id });

    win = new BrowserWindow({ width: 1360, height: 900, show: false, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    win.webContents.on("console-message", (...args) => {
      const d = args[1]; const level = d && typeof d === "object" ? d.level : args[1]; const message = d && typeof d === "object" ? d.message : args[2];
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
    check("S2-UI-0 · 真实 UI 登录进入桌面", (await waitGate("ready")) === "ready", "");

    // provider/model + tool 授权（step0 真实 orchestrator 需要）。
    const setupCtx = { sessionRef: identity.service.current, appId: "settings", source: "probe" };
    const prov = identity.modelService.createProvider({ context: setupCtx, displayName: "D4-05 Recovery Provider", baseUrl: PROVIDER_URL, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "d4-05-recovery-credential" });
    if (!prov.ok) throw new Error("createProvider failed: " + JSON.stringify(prov));
    const model = identity.modelService.createModel({ context: setupCtx, providerId: prov.provider.providerId, remoteModelId: "d4-05-local", displayName: "D4-05 Local", capabilities: ["chat"], scope: "ORGANIZATION" });
    if (!model.ok) throw new Error("createModel failed: " + JSON.stringify(model));
    identity.modelService.setDefault({ context: setupCtx, capability: "chat", configId: model.model.configId, scope: "ORGANIZATION" });
    identity.authorization.grantAppToolPermission({ context: aiCtx(), appId: "ai", actions: ["tool.resource.trash"] });

    const ctx = aiCtx();
    const created = await identity.resourceService.createResource({ context: { sessionRef: identity.service.current, appId: "resource-library", source: "probe" }, resourceType: "text", name: "D4-05 Recovery Target", content: "d4-05-recovery-body" });
    if (!created.ok) throw new Error("createResource failed: " + JSON.stringify(created));
    identity.authorization.grantAppResourcePermission({ context: aiCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] });
    identity.authorization.grantResourcePermission({ context: aiCtx(), principalType: "USER", principalId: adminUser().id, resourceId: created.resource.resourceId, actions: ["resource.delete", "resource.useByAgent"] });

    const t = identity.taskService.createTask({ context: ctx, goal: "D4-05 recovery probe" });
    const started = identity.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const s0 = identity.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    const s1 = identity.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: s0.task.revision });
    const ss0 = identity.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: s1.task.revision });

    // step0：真实 orchestrator（provider mode=final，0 tool call）→ Artifact 锚点。
    const controlUrl = PROVIDER_URL.replace(/\/v1\/?$/, "") + "/__plan";
    await fetch(controlUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "final" }) }).catch(() => null);
    const r0 = await identity.orchestrator.runStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: ss0.task.revision, stepInput: null, verify: { type: "SCHEMA_VALID" } });
    check("S2-UI-1 · step0 Artifact 锚点就绪", r0.ok === true && identity.taskStore.artifactsOfTask(t.task.taskId).length === 1, JSON.stringify({ ok: r0.ok, artifacts: identity.taskStore.artifactsOfTask(t.task.taskId).length }));

    // step1：真实存活 executor claim RUNNING → OpenArc 无法证明 quiescence → recoverOnStartup → UNKNOWN_EFFECT
    const fresh = identity.taskStore.taskById(t.task.taskId);
    const ss1 = identity.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: fresh.revision });
    const run = identity.taskService.startHarnessRun({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision });
    identity.taskService.markHarnessRunRunning({ context: ctx, taskId: t.task.taskId, runId: run.run.runId, expectedRevision: run.task.revision });
    const planned = await identity.sideEffectRuntime.proposeWrite({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, runId: run.run.runId, toolId: "resource.trash", arguments: { resourceRef: created.resource.resourceRef } });
    if (!planned.ok) throw new Error("proposeWrite failed: " + JSON.stringify(planned));
    const callId = planned.approvalRequestId;
    identity.sideEffectRuntime.decideApproval({ context: { sessionRef: identity.service.current, source: "user" }, approvalRequestId: callId, decision: "APPROVE" });

    const runtimeDir = path.join(userData, "runtime", "side-effects");
    const dbPath = path.join(userData, "identity.db");
    const storeRoot = path.join(userData, "library");
    const instanceId = "exe_" + Math.random().toString(36).slice(2, 8);
    const boxArgs = JSON.stringify({ runtimeDir, dbPath, storeRoot, instanceId, callId, holderId: "exec_1", timeoutMs: 180000, holdAfterMutation: true, now: identity.store.clock ? identity.store.clock() : Date.now() });
    box = utilityProcess.fork(GATED_EXECUTOR, [boxArgs], { stdio: "pipe", serviceName: "d4-05-gated-executor" });
    let boxOut = ""; let boxErr = "";
    if (box.stdout) box.stdout.on("data", (d) => { boxOut += String(d); });
    if (box.stderr) box.stderr.on("data", (d) => { boxErr += String(d); });
    await waitFor(() => RuntimeSupervisor.parseExecutorMessage(boxOut, "ready"), 30000);
    const claimed = await waitFor(() => identity.sideEffectStore.callById(callId).status === "RUNNING", 30000);
    check("S2-UI-2 · 真实存活 executor claim RUNNING（quiescence 不可证）", claimed && box !== null, JSON.stringify({ claimed, err: boxErr.slice(0, 120) }));

    identity.sideEffectRuntime.recoverOnStartup();
    const unknownCall = identity.sideEffectStore.callById(callId);
    check("S2-UI-3 · recoverOnStartup → Call 持久化 UNKNOWN_EFFECT / Task BLOCKED", unknownCall.status === "UNKNOWN_EFFECT" && identity.taskStore.taskById(t.task.taskId).status === "BLOCKED", JSON.stringify({ call: unknownCall.status, task: identity.taskStore.taskById(t.task.taskId).status }));

    // 刷新 Renderer：从 backend task/get 恢复 recovery 投影。
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
    await waitFor(() => attr(".ai-panel", "data-ai-task-id") === t.task.taskId, 30000);
    const recoveryShown = await waitFor(() => has("[data-ai-recovery]"), 30000);
    const stateText = await text("[data-ai-recovery-state]");
    const artifactsText = await text("[data-ai-recovery-artifacts]");
    const reasonText = await text("[data-ai-recovery-reason]");
    check("S2-UI-4 · UI recovery 区块可见并显示实际状态/核查结论/关联产物", recoveryShown && stateText.includes("UNKNOWN_EFFECT") && (stateText.includes("尚无结论") || /APPLIED|NOT_APPLIED|INDETERMINATE/.test(stateText)) && artifactsText.includes("art_"), JSON.stringify({ recoveryShown, stateText: stateText.slice(0, 120), artifactsText: artifactsText.slice(0, 120), reasonText: reasonText.slice(0, 80) }));
    const panelStatus = await attr(".ai-panel", "data-ai-status");
    const retryButton = await js("return Array.from(document.querySelectorAll('button')).some((b) => /重试|retry/i.test(b.textContent || ''))");
    check("S2-UI-5 · 不显示成功 / 重试 / 续接入口", panelStatus === "BLOCKED" && (await has("[data-ai-resume]")) === false && retryButton === false, JSON.stringify({ panelStatus, resume: await has("[data-ai-resume]"), retryButton }));

    const ackVisible = await has("[data-ai-acknowledge]");
    const clicks = ackVisible ? await click("[data-ai-acknowledge]") : "missing";
    const acked = await waitFor(() => has("[data-ai-acknowledged]"), 20000);
    const ackedText = await text("[data-ai-acknowledged]");
    check("S2-UI-6 · 点击人工确认 → UI 显示已人工确认", ackVisible && clicks === "ok" && acked && ackedText.includes("已人工确认"), JSON.stringify({ ackVisible, clicks, acked, ackedText: ackedText.slice(0, 40) }));

    const ackEventCount = identity.taskStore.eventsOfTask(t.task.taskId).filter((e) => e.event_type === "tool.side_effect.unknown_effect.acknowledged").length;
    const afterCall = identity.sideEffectStore.callById(callId);
    const elig = identity.taskService.getResumeEligibility({ context: ctx, taskId: t.task.taskId });
    check("S2-UI-7 · ack 后 event=1 / call 仍 UNKNOWN_EFFECT / Task 仍 BLOCKED / 仍不可续接 / 0 第二 call", ackEventCount === 1 && afterCall.status === "UNKNOWN_EFFECT" && identity.taskStore.taskById(t.task.taskId).status === "BLOCKED" && elig.resumable === false && elig.reason === "RESUME_UNKNOWN_EFFECT_PRESENT" && identity.sideEffectStore.callsOfTask(t.task.taskId).length === 1, JSON.stringify({ ackEventCount, call: afterCall.status, task: identity.taskStore.taskById(t.task.taskId).status, reason: elig.reason, calls: identity.sideEffectStore.callsOfTask(t.task.taskId).length }));

    // Secret scan（DB + UI）。
    let dump = "";
    try {
      const conn = identity.store.connection || identity.store.db;
      for (const row of conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) { try { for (const r of conn.prepare("SELECT * FROM " + row.name).all()) dump += JSON.stringify(r) + "\n"; } catch { /* ignore */ } }
    } catch { /* ignore */ }
    const bodyDom = await js("return document.body.innerHTML");
    const secretHits = ["mpx_", "tpx_", "d4-05-recovery-credential", userData].filter((s) => s && (dump.includes(s) || bodyDom.includes(s)));
    check("I1 · DB / UI 0 capability / credential / 绝对路径泄漏", secretHits.length === 0, JSON.stringify(secretHits), "[]");
    check("I2 · Renderer console error = 0", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "), "0");
    check("I3 · main uncaught / unhandled = 0", mainErrors.length === 0, mainErrors.slice(0, 3).join(" | "), "0");
    report.secrets = { secretHits: secretHits.length, consoleErrors: consoleErrors.length, mainErrors: mainErrors.length };
    report.stats = { taskId: t.task.taskId, callId, callStatus: afterCall.status, taskStatus: identity.taskStore.taskById(t.task.taskId).status, ackEventCount, recoveryApplicable: true };
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String((e && e.message) || e).slice(0, 200));
  } finally {
    try { if (box) box.kill(); } catch { /* ignore */ }
    try { win?.destroy(); } catch { /* ignore */ }
    try { identity?.store?.close(); } catch { /* ignore */ }
    if (userData) { try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
