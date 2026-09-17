/**
 * D4-08 · 失败验证 UI 的 Electron 真实探针（真实 Electron + 真实产品 Renderer/preload）。
 *
 * 正式链路：probe host 内以 test-only 方式注册尺寸探针 tool test.sized 与对应 adapter
 * → 产品 TaskHarnessOrchestrator（official dsh facade）+ 产品 ControlledToolProxy
 * → official dsh 经 ACP 提出 tool call → ToolFacadeBridge → ControlledToolProxy.executeReadOnly
 * → registry.validateOutput / adapter.verify 真实报告验证失败
 * → 产品 TaskService.recordVerificationFailure 落 1 条 FAIL verification
 * → orchestrator 以**后端记录**为准（A33 闸门）→ Task/Step BLOCKED、0 Artifact
 * → 真实 Renderer 经产品 registerTaskIpc 的 task/get 展示 data-ai-verification。
 *
 * 确定性 provider（tests/fixtures/d4-04-provider.mjs mode=sized）只替代最后一跳 provider network；
 * 不替代 Model Proxy / Harness Adapter / ACP / official dsh / ControlledToolProxy。
 *
 * 绝不直写 DB、绝不手工调 blockStep/终态方法、绝不伪造 PASS。
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
const { HarnessAdapter } = require(path.join(ROOT, "electron/harness-adapter.cjs"));
const { TaskHarnessOrchestrator } = require(path.join(ROOT, "electron/task-harness-orchestrator.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";
const OUTSIDER = "d4-08-outsider@openarc.test";
const PW2 = "d4-08-outsider-password-1";
const PROVIDER_URL = process.env.OPENARC_D4_PROVIDER_URL || "";
const NODE_BIN = process.env.OPENARC_D4_NODE_BIN || process.execPath;
// 确定性 provider 的 plan 控制端点（只替代最后一跳 provider network）。
const CONTROL_URL = PROVIDER_URL.replace(/\/v1\/?$/, "") + "/__plan";
const EXPECTED_SIZE = 10;
const ACTUAL_SIZE = 7;
const FINAL = "OPENARC_D4_08_OK";
const CREDENTIAL_SECRET = "d4-08-verification-credential";

const report = {
  checks: [], errors: [], versions: {}, stats: {}, secrets: {},
  chain: {
    mode: "official-dsh-facade+product-orchestrator+controlled-tool-proxy",
    officialDshFacade: true,
    toolId: "test.sized",
    toolCallIssuer: "deterministic provider (tests/fixtures/d4-04-provider.mjs mode=sized) via official dsh",
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
async function loginAs(identifier, password) {
  await setInput('[data-d3-id="login-identifier"]', identifier);
  await setInput('[data-d3-id="login-password"]', password);
  await sleep(80);
  await click('[data-d3-id="login-submit"]');
  return waitGate("ready", 30000);
}
async function openPanel() {
  if (await waitSel(".assistant-pill", 30000)) await click(".assistant-pill");
  return waitSel(".ai-panel", 20000);
}
const adminUser = () => identity.store.allUsers().find((u) => u.role === "ADMIN");
const aiCtx = () => ({ sessionRef: identity.service.current, appId: "ai", source: "probe" });
const taskStatus = (id) => { const t = identity.taskStore.taskById(id); return t ? t.status : null; };
const stepStatus = (id) => { const s = identity.taskStore.stepById(id); return s ? s.status : null; };

/** test-only 尺寸探针：tool contract + adapter 只在 probe host 内注册，绝不进入生产 profile。 */
function installSizedProbe() {
  identity.toolRegistry.register({
    toolId: "test.sized",
    version: 1,
    displayName: "Test Sized Output (D4-08 verification UI probe)",
    description: "测试专用：产出声明 size，由 adapter.verify 校验期望尺寸；绝不在生产 profile 注册。",
    inputSchema: { type: "object", additionalProperties: false, properties: { expectedSize: { type: "integer", minimum: 0 }, label: { type: "string", minLength: 1, maxLength: 100 } }, required: ["expectedSize"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, size: { type: "integer" } }, required: ["size"] },
    riskClass: "READ_ONLY",
    executionProvider: "testSized",
    enabled: true,
    expectedSideEffects: ["no side effect"],
    requiredPermissions: [],
    resourceActions: [],
  });
  const state = { calls: 0, lastResult: null, actualSize: ACTUAL_SIZE };
  identity.adapters.providers.testSized = {
    toolIds: ["test.sized"],
    async prepare() { return { plan: { provider: "testSized" } }; },
    async execute({ args }) {
      state.calls += 1;
      state.lastResult = { label: String(args.label || "artifact"), size: state.actualSize };
      // 关键：execute 报告成功；尺寸由 verify 独立核对。
      return { ok: true, result: state.lastResult };
    },
    async verify({ args, result }) {
      const ok = !!(result && Number(result.size) === Number(args.expectedSize));
      return { ok, applied: ok, detail: { expectedSize: Number(args.expectedSize), actualSize: result && result.size } };
    },
  };
  return state;
}

app.whenReady().then(async () => {
  process.on("uncaughtException", (e) => mainErrors.push(String((e && e.message) || e)));
  process.on("unhandledRejection", (e) => mainErrors.push(String((e && e.message) || e)));
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch, provider: PROVIDER_URL ? "local-http" : "missing", nodeBin: NODE_BIN === process.execPath ? "electron-execPath" : "external-node" };
    out("VERSIONS " + JSON.stringify(report.versions));
    out("CHAIN " + JSON.stringify(report.chain));

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-08-verification-"));
    const runtimeBoot = await createOpenArcRuntime({
      userDataDir: userData, safeStorage, allowAdmin: true,
      executorLauncher: createDefaultExecutorLauncher(),
    });
    identity = runtimeBoot.identity;
    out("DIAG runtime-booted");
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

    out("DIAG window-created");
    await win.loadURL(uiURL);
    out("DIAG url-loaded");
    await sleep(600);
    check("R0.1 · 真实 UI 登录进入桌面", (await loginAs(ADMIN, PW)) === "ready", "");
    out("DIAG logged-in");

    // 真实 provider edge + model config（official dsh 经 Model Proxy 消费 chat capability）。
    const setupCtx = { sessionRef: identity.service.current, appId: "settings", source: "probe" };
    const prov = identity.modelService.createProvider({ context: setupCtx, displayName: "D4-08 Verification Provider", baseUrl: PROVIDER_URL, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: CREDENTIAL_SECRET });
    if (!prov.ok) throw new Error("createProvider failed: " + JSON.stringify(prov));
    const model = identity.modelService.createModel({ context: setupCtx, providerId: prov.provider.providerId, remoteModelId: "d4-08-local", displayName: "D4-08 Local", capabilities: ["chat"], scope: "ORGANIZATION" });
    if (!model.ok) throw new Error("createModel failed: " + JSON.stringify(model));
    const def = identity.modelService.setDefault({ context: setupCtx, capability: "chat", configId: model.model.configId, scope: "ORGANIZATION" });
    if (!def.ok) throw new Error("setDefault failed: " + JSON.stringify(def));
    out("DIAG model-ready");
    check("R0.2 · 真实产品 boot + model proxy listening", runtimeBoot.snapshot().modelProxyListening === true, JSON.stringify(runtimeBoot.snapshot()), "model proxy listening");

    // ------------------------------------------------------------- 真实产品执行链跑出 FAIL verification
    // 先确定性设置 provider plan：调一次 test_sized（actual 7 != expected 10）后收尾 final。
    const planRes = await fetch(CONTROL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "sized", finalText: FINAL }) });
    if (!planRes.ok) throw new Error("provider /__plan failed: " + planRes.status);
    const sized = installSizedProbe();
    const probeOrch = new TaskHarnessOrchestrator({
      taskService: identity.taskService,
      adapterFactory: () => new HarnessAdapter({ modelProxy: identity.modelProxy }),
      toolProxy: identity.toolProxy,
      toolFacade: { enabled: true, toolIds: ["test.sized"], writeToolIds: [], maxCalls: 4, ttlMs: 120000 },
    });
    const ctx = aiCtx();
    const t = identity.taskService.createTask({ context: ctx, goal: "D4-08 verification failure probe (deterministic)" });
    const started = identity.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const s1 = identity.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    const ss = identity.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: s1.task.revision });
    const run = await probeOrch.runStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss.task.revision, verify: { type: "EXACT_TEXT", expected: FINAL } });

    out("DIAG run-step-done");
    const taskId = t.task.taskId;
    const stepId = s1.step.stepId;
    const execs = identity.toolStore.executionsOfTask(taskId);
    const rawVers = identity.taskStore.verificationsOfTask(taskId);
    const artifacts = identity.taskStore.artifactsOfTask(taskId);
    const events = identity.taskStore.eventsOfTask(taskId).map((e) => e.event_type);
    report.stats = {
      taskId, stepId,
      taskStatus: taskStatus(taskId), stepStatus: stepStatus(stepId),
      artifacts: artifacts.length, verifications: rawVers.length, executions: execs.length,
      executionStatus: execs[0] ? execs[0].status : null,
      executionVerificationStatus: execs[0] ? execs[0].verification_status : null,
      chain: report.chain.mode,
    };

    check("A1.1 · adapter.execute 恰好 1 次且报告成功（尺寸由 verify 独立核对）", sized.calls === 1 && sized.lastResult && sized.lastResult.size === ACTUAL_SIZE,
      JSON.stringify({ calls: sized.calls, result: sized.lastResult }), "1 call + result.size=7");
    check("A1.2 · 真实执行链归因验证失败（非执行失败）", run.ok === false && run.error === "TOOL_VERIFICATION_FAILED",
      JSON.stringify({ ok: run.ok, error: run.error }), "ok=false + TOOL_VERIFICATION_FAILED");
    check("A1.3 · Task/Step 正确停止为 BLOCKED", taskStatus(taskId) === "BLOCKED" && stepStatus(stepId) === "BLOCKED",
      JSON.stringify({ task: taskStatus(taskId), step: stepStatus(stepId) }), "BLOCKED + BLOCKED");
    check("A1.4 · 0 Artifact", artifacts.length === 0, JSON.stringify({ artifacts: artifacts.length }), "0");
    check("A2.1 · execution FAILED / verification_status=FAIL / TOOL_VERIFICATION_FAILED",
      execs.length === 1 && execs[0].status === "FAILED" && execs[0].verification_status === "FAIL" && execs[0].error_code === "TOOL_VERIFICATION_FAILED",
      JSON.stringify({ n: execs.length, status: execs[0] && execs[0].status, ver: execs[0] && execs[0].verification_status, err: execs[0] && execs[0].error_code }), "1 FAILED + FAIL + TOOL_VERIFICATION_FAILED");

    const v = rawVers[0] || null;
    const vd = v ? JSON.parse(v.safe_details) : null;
    check("A2.2 · 恰好 1 条 FAIL Verification（artifact_id=null；type/step/run/execution 关联）",
      rawVers.length === 1 && v.status === "FAIL" && v.type === "ADAPTER_VERIFY" && v.artifact_id === null && v.task_id === taskId && v.step_id === stepId && !!v.run_id && v.execution_id === execs[0].execution_id,
      JSON.stringify({ n: rawVers.length, status: v && v.status, type: v && v.type, artifactId: v && v.artifact_id, stepId: v && v.step_id, runId: !!(v && v.run_id), execMatch: v && v.execution_id === execs[0].execution_id }),
      "1 FAIL + ADAPTER_VERIFY + artifact_id=null + 关联 step/run/execution");
    check("A2.3 · 失败证据如实：expected.expectedSize / actual.size / evidence.executionId",
      !!vd && vd.method === "ADAPTER_VERIFY" && vd.expected && vd.expected.expectedSize === EXPECTED_SIZE && vd.expected.actualSize === ACTUAL_SIZE && vd.actual && vd.actual.size === ACTUAL_SIZE && vd.evidence && vd.evidence.executionId === execs[0].execution_id,
      JSON.stringify(vd), "method=ADAPTER_VERIFY + expectedSize=10 + actualSize=7 + evidence.executionId");
    check("A2.4 · 事件链：tool.verification.failed 且无 execution_succeeded / artifact.created",
      events.includes("tool.verification.failed") && !events.includes("tool.execution_succeeded") && !events.includes("artifact.created"),
      JSON.stringify(events.filter((e) => /tool\.|artifact/.test(e))), "tool.verification.failed only");
    check("A2.5 · 后端 task/get safe verifications 如实（status/method/expected/actual/executionId）", (() => {
      const safe = identity.taskService.getVerifications({ context: ctx, taskId });
      const sv = safe.ok ? safe.items[0] : null;
      report.stats.safeVerification = sv ? { status: sv.status, method: sv.method, expected: sv.expected, actual: sv.actual, executionId: sv.executionId } : null;
      return safe.ok === true && safe.items.length === 1 && sv.status === "FAIL" && sv.method === "ADAPTER_VERIFY" && sv.expected && sv.expected.expectedSize === EXPECTED_SIZE && sv.actual && sv.actual.size === ACTUAL_SIZE && sv.executionId === execs[0].execution_id;
    })(), JSON.stringify(report.stats.safeVerification), "FAIL + ADAPTER_VERIFY + sizes + executionId");

    // ------------------------------------------------------------- 真实 Renderer：失败验证可见
    out("DIAG opening-panel-1");
    await openPanel();
    out("DIAG panel-1-open");
    const panelTask = await waitFor(async () => (await attr(".ai-panel", "data-ai-task-id")) === taskId, 30000);
    const verShown = await waitFor(() => has("[data-ai-verification]"), 20000);
    await sleep(200);
    const panelStatus = await attr(".ai-panel", "data-ai-status");
    const failBanner = await text("[data-ai-verification-fail]");
    const beforeDetail = await text("[data-ai-verification-detail]");
    const beforeEvidence = await text("[data-ai-verification-evidence]");
    const beforeResult = await text("[data-ai-result]");
    const panelText = await text(".ai-panel");
    const noSuccess = !/Succeeded|SUCCEEDED|成功/.test(panelText);
    report.stats.uiBeforeReload = { panelTask, panelStatus, verShown, failBanner, beforeDetail: beforeDetail.slice(0, 200), beforeEvidence: beforeEvidence.slice(0, 120), beforeResultLen: beforeResult.length, noSuccess };
    check("U1.1 · Renderer 显示 BLOCKED 且 data-ai-verification 可见", panelTask && panelStatus === "BLOCKED" && verShown,
      JSON.stringify({ panelTask, panelStatus, verShown }), "panel=task + BLOCKED + visible");
    check("U1.2 · 失败横幅 + 检查方法 + 安全预期/实际（expectedSize=10 / actualSize=7）",
      failBanner.includes("验证失败") && beforeDetail.includes("ADAPTER_VERIFY") && beforeDetail.includes("expectedSize") && beforeDetail.includes(String(EXPECTED_SIZE)) && beforeDetail.includes("size") && beforeDetail.includes(String(ACTUAL_SIZE)),
      JSON.stringify({ failBanner, detail: beforeDetail.slice(0, 200) }), "验证失败 + ADAPTER_VERIFY + expectedSize=10/actualSize=7");
    check("U1.3 · 证据引用 = executionId + 页面绝不显示 Succeeded/成功 + 0 Artifact 结果",
      beforeEvidence.includes(execs[0].execution_id) && noSuccess && beforeResult.trim() === "",
      JSON.stringify({ evidence: beforeEvidence.slice(0, 120), noSuccess, resultLen: beforeResult.length }), "evidence=execId + no success + empty result");

    // ------------------------------------------------------------- Reload 后从 task/get 恢复
    out("DIAG reloading");
    await win.webContents.reload();
    await sleep(1200);
    let gate = await waitGate("ready", 30000);
    if (gate !== "ready") gate = await loginAs(ADMIN, PW);
    out("DIAG reload-ready");
    await openPanel();
    out("DIAG panel-2-open");
    const restored = await waitFor(async () => (await has("[data-ai-verification]")) && (await attr(".ai-panel", "data-ai-task-id")) === taskId, 30000);
    await sleep(200);
    const afterDetail = await text("[data-ai-verification-detail]");
    const afterEvidence = await text("[data-ai-verification-evidence]");
    const afterStatus = await attr(".ai-panel", "data-ai-status");
    report.stats.uiAfterReload = { restored, afterStatus, afterDetail: afterDetail.slice(0, 200) };
    check("U2.1 · Reload 后仍从后端 task/get 恢复失败证据（不依赖 Renderer 内存）", restored && afterStatus === "BLOCKED",
      JSON.stringify({ restored, afterStatus }), "visible + BLOCKED");
    check("U2.2 · Reload 前后失败证据内容一致（detail/evidence）", afterDetail === beforeDetail && afterEvidence === beforeEvidence,
      JSON.stringify({ sameDetail: afterDetail === beforeDetail, sameEvidence: afterEvidence === beforeEvidence }), "detail/evidence identical");

    // ------------------------------------------------------------- 跨用户不可读（真实第二 session）
    out("DIAG isolation-start");
    const admin = adminUser();
    const created = await identity.store.createUser({ identifier: OUTSIDER, password: PW2, displayName: "D4-08 Outsider", teamId: admin.team_id });
    if (!created || !created.ok) throw new Error("createUser outsider failed: " + JSON.stringify(created));
    const otherLogin = await identity.store.login({ identifier: OUTSIDER, password: PW2 });
    if (!otherLogin || !otherLogin.ok) throw new Error("login outsider failed: " + JSON.stringify(otherLogin));
    const otherCtx = { sessionRef: otherLogin.session.ref, appId: "ai", source: "probe" };
    const deniedVers = identity.taskService.getVerifications({ context: otherCtx, taskId });
    const deniedTask = identity.taskService.getTask({ context: otherCtx, taskId });
    const deniedArtifacts = identity.taskService.getArtifacts({ context: otherCtx, taskId });
    const deniedList = identity.taskService.listTasks({ context: otherCtx });
    report.stats.isolation = { deniedVers: deniedVers.error, deniedTask: deniedTask.error, deniedArtifacts: deniedArtifacts.error, otherTaskCount: deniedList.ok ? deniedList.items.length : null };
    check("S1.1 · 另一真实 session 读 verification/task/artifacts 一律 TASK_FORBIDDEN",
      deniedVers.ok === false && deniedVers.error === "TASK_FORBIDDEN" && deniedTask.ok === false && deniedTask.error === "TASK_FORBIDDEN" && deniedArtifacts.ok === false && deniedArtifacts.error === "TASK_FORBIDDEN",
      JSON.stringify(report.stats.isolation), "TASK_FORBIDDEN x3");
    check("S1.2 · 非 owner 的任务列表不含该记录", deniedList.ok === true && deniedList.items.every((it) => it.taskId !== taskId),
      JSON.stringify({ otherTaskCount: deniedList.items && deniedList.items.length }), "[] 中不含 owner task");

    // ------------------------------------------------------------- 真实 UI 第二用户：看不到失败详情
    await click('[data-d3-id="topbar-logout"]');
    const logoutGate = await waitGate("unauthenticated", 20000);
    const outsiderReady = await loginAs(OUTSIDER, PW2);
    await openPanel();
    await sleep(1500);
    const outsiderPanelTask = await attr(".ai-panel", "data-ai-task-id");
    const outsiderVer = await has("[data-ai-verification]");
    const outsiderPanelText = await text(".ai-panel");
    report.stats.uiIsolation = { logoutGate, outsiderReady, outsiderPanelTask, outsiderVer, showsFailureText: outsiderPanelText.includes("验证失败") };
    check("S2.1 · UI 以另一用户登录后看不到该记录的失败详情", logoutGate === "unauthenticated" && outsiderReady === "ready" && outsiderPanelTask !== taskId && outsiderVer === false && !outsiderPanelText.includes("验证失败"),
      JSON.stringify(report.stats.uiIsolation), "different/empty task + no data-ai-verification");

    out("DIAG ui-isolation-done");
    // ------------------------------------------------------------- Secret scan（DB + UI）
    let dump = "";
    try {
      const conn = identity.store.connection || identity.store.db;
      for (const row of conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) { try { for (const rr of conn.prepare("SELECT * FROM " + row.name).all()) dump += JSON.stringify(rr) + "\n"; } catch { /* ignore */ } }
    } catch { /* ignore */ }
    const bodyDom = await js("return document.body.innerHTML");
    const dbHits = ["mpx_", "tpx_", CREDENTIAL_SECRET, userData].filter((s) => s && dump.includes(s));
    const domHits = ["mpx_", "tpx_", CREDENTIAL_SECRET, userData, "/Users/", "/private/", "/var/folders/"].filter((s) => s && bodyDom.includes(s));
    report.secrets = { dbHits, domHits, consoleErrors: consoleErrors.length, mainErrors: mainErrors.length };
    check("I1 · DB / UI 0 capability / credential / 私有路径泄漏", dbHits.length === 0 && domHits.length === 0, JSON.stringify({ dbHits, domHits }), "[]");
    check("I2 · Renderer console error = 0", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "), "0");
    check("I3 · main uncaught / unhandled = 0", mainErrors.length === 0, mainErrors.slice(0, 3).join(" | "), "0");
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
