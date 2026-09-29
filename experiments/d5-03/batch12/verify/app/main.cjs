/**
 * D5-03 第十一批 · 真实 Electron 退出探针宿主。
 *
 * 与 runtime-boot.cjs 同一条设计理由：**关闭应用的收尾顺序只允许存在一份** ——
 * 本宿主不自己写收尾，而是 import 产品模块 `electron/app-shutdown.cjs` 的
 * disposeAppResources()（真实 electron/main.cjs 的 will-quit 用的就是同一个函数），
 * 因此这里测到的顺序 / 有界性 / 状态语义就是产品退出时的那一份。
 *
 * 真实面：真实 Electron 进程 + 真实 dist 渲染层 + 真实产品 preload + 真实
 * registerIdentityIpc / registerTaskIpc + 真实 createOpenArcRuntime（身份 / ModelProxy /
 * TaskService / MCP 全是产品装配）+ 真实 HarnessAdapter + 真实 TaskHarnessOrchestrator
 * + 真实 disposeAppResources。
 *
 * 唯一替换（受控假体，任务书允许）：
 *   · harness 子进程换成 tests/fixtures/harness-acp/* 探针（可控阻塞 / 正常完成）；
 *   · 模型 Provider 指向本机 fake provider（tests/model-fake-provider.mjs）；
 *   · MCP 服务是本机自建 echo-server（127.0.0.1）。
 *
 * 场景由环境变量选定：OA_B11_SCENARIO = start | turn | mcp | repeat | success | cancel |
 *   state（state = 只读打印既有任务的恢复状态，用于重启后核对）。
 */
const { app, BrowserWindow, ipcMain, safeStorage, protocol, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");

if (!app.isReady()) {
  protocol.registerSchemesAsPrivileged([
    { scheme: "openarc-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}
const NATIVE_RESOURCES = { "siri-blob": "/System/Library/PrivateFrameworks/SiriUI.framework/Versions/A/Resources/Siri Blob.mov" };
const NATIVE_TYPES = { ".mov": "video/quicktime", ".mp4": "video/mp4", ".m4v": "video/x-m4v" };

const HERE = __dirname;
const ROOT = path.resolve(HERE, "../../../../..");
const { registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { registerTaskIpc } = require(path.join(ROOT, "electron/task-bootstrap.cjs"));
const { createDefaultExecutorLauncher } = require(path.join(ROOT, "electron/executor-launcher.cjs"));
const { createOpenArcRuntime } = require(path.join(ROOT, "electron/runtime-boot.cjs"));
const { HarnessAdapter } = require(path.join(ROOT, "electron/harness-adapter.cjs"));
const { TaskHarnessOrchestrator } = require(path.join(ROOT, "electron/task-harness-orchestrator.cjs"));
const { disposeAppResources } = require(path.join(ROOT, "electron/app-shutdown.cjs"));

const SCENARIO = String(process.env.OA_B11_SCENARIO || "start");
const OUT_DIR = String(process.env.OA_B11_OUT || path.join(HERE, "out"));
const AGENT_DIR = path.join(ROOT, "tests/fixtures/harness-acp");
const NODE_BIN = process.env.OPENARC_PROBE_NODE_BIN || process.execPath;
const ADMIN = "admin@batch11-exit.test";
const PW = "batch11-exit-admin-1";
const CREDENTIAL_SECRET = "batch11-probe-credential";
const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;

const out = (line) => process.stdout.write(line + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
globalThis.__oaProviderSeen = 0;
const writeJson = (name, value) => fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(value, null, 2));

let win = null; let identity = null; let fp = null; let runtime = null; let orch = null;
let started = false;
const mainErrors = [];
const issuedTokens = new Set();
const events = [];
let shutdownResult = null;
let preQuit = null;

const ctxOf = () => ({ sessionRef: identity.service.current, appId: "ai", source: "probe" });
const taskRow = (taskId) => { try { return identity.taskStore.taskById(taskId) || null; } catch { return null; } };
const runsOf = (taskId) => { try { return identity.taskStore.harnessRunsOfTask(taskId) || []; } catch { return []; } };
const callsOf = (taskId) => { try { return identity.taskStore.callsOfTask(taskId) || []; } catch { return []; } };

function facts(taskId) {
  const t = taskRow(taskId);
  return {
    taskId,
    taskStatus: t ? t.status : null,
    taskRevision: t ? t.revision : null,
    cancelRequested: t ? !!t.cancel_requested : null,
    stopReason: t ? t.stop_reason : null,
    runs: runsOf(taskId).map((r) => ({ status: r.status, errorCode: r.error_code || null, stopReason: r.stop_reason || null })),
    calls: callsOf(taskId).map((c) => ({ status: c.status, providerErrorCode: c.provider_error_code || null })),
    artifacts: (() => { try { return (identity.taskStore.artifactsOfTask(taskId) || []).length; } catch { return null; } })(),
    capabilities: [...identity.modelProxy.capabilities.values()].map((c) => c.state),
    activeTokens: [...issuedTokens],
  };
}

function adapterFactory({ taskId }) {
  const goal = (taskRow(taskId) || {}).goal || "";
  const agent = goal.includes("[PROBE:ECHO]") ? "echo-agent.mjs"
    : goal.includes("[PROBE:TURN]") ? "turn-hang-agent.mjs"
      : "session-new-hold-agent.mjs";
  return new HarnessAdapter({ modelProxy: identity.modelProxy, dshBin: NODE_BIN, dshArgs: [path.join(AGENT_DIR, agent)] });
}

/** 受控假 Provider 起在**独立进程**里：不占 Electron 的事件循环，退出行为不被它拖住。 */
function startProviderProcess(behavior) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, "fake-provider-host.mjs"), behavior], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let buffer = ""; let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    const timer = setTimeout(() => reject(new Error("fake provider 未在 8s 内就绪：" + stderr)), 8000);
    child.stdout.on("data", (d) => {
      buffer += String(d);
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      try { const info = JSON.parse(buffer.slice(0, nl)); clearTimeout(timer); resolve({ ...info, child }); }
      catch (e) { clearTimeout(timer); reject(e); }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { if (!fp) return; out("PROBE_PROVIDER_EXIT " + JSON.stringify({ code, at: Date.now() })); });
  });
}

async function installModelConfig() {
  const setupCtx = { sessionRef: identity.service.current, appId: "settings", source: "probe" };
  const prov = identity.modelService.createProvider({ context: setupCtx, displayName: "Batch11 Probe Provider", baseUrl: fp.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: CREDENTIAL_SECRET });
  if (!prov.ok) throw new Error("createProvider: " + JSON.stringify(prov));
  const model = identity.modelService.createModel({ context: setupCtx, providerId: prov.provider.providerId, remoteModelId: "batch11-local", displayName: "Batch11 Local", capabilities: ["chat"], scope: "ORGANIZATION" });
  if (!model.ok) throw new Error("createModel: " + JSON.stringify(model));
  const def = identity.modelService.setDefault({ context: setupCtx, capability: "chat", configId: model.model.configId, scope: "ORGANIZATION" });
  if (!def.ok) throw new Error("setDefault: " + JSON.stringify(def));
  const info = { providerId: prov.provider.providerId, modelConfigId: model.model.configId, providerBaseUrl: fp.baseUrl, providerPid: fp.child ? fp.child.pid : null };
  // 探针进程内假 Provider：把端口 / pid 写给驱动，退出后由驱动核对是否已释放 / 已退出。
  writeJson("probe-info.json", { ...info, pid: process.pid, userData: app.getPath("userData"), at: new Date().toISOString() });
  return info;
}

/** 造一个 MCP 连接并连上（真实 mcpService + 本机 echo-server）。 */
async function connectMcp() {
  const url = process.env.OA_B11_MCP_URL;
  if (!url) throw new Error("缺少 OA_B11_MCP_URL");
  const mcpCtx = { sessionRef: identity.service.current, appId: "mcp-center", source: "probe" };
  const created = await identity.mcpService.createConnection({ context: mcpCtx, name: "Batch11 Exit MCP", transport: "http", location: "REMOTE_SERVICE", endpoint: { url }, authMode: "NONE", visibility: "PERSONAL" });
  if (!created.ok) throw new Error("mcp/create: " + JSON.stringify(created));
  const connectionId = created.connection.connectionId;
  const enabled = await identity.mcpService.setEnabled({ context: mcpCtx, connectionId, enabled: true });
  if (!enabled.ok) throw new Error("mcp/setEnabled: " + JSON.stringify(enabled));
  const connected = await identity.mcpService.connect({ context: mcpCtx, connectionId });
  if (!connected.ok) throw new Error("mcp/connect: " + JSON.stringify(connected));
  return connectionId;
}

function mcpFacts() {
  try {
    return {
      live: identity.mcpService.live ? identity.mcpService.live.size : null,
      opening: identity.mcpService.opening ? identity.mcpService.opening.size : null,
      connections: (() => {
        try {
          const orgId = identity.service.current ? identity.service.current.organizationId : null;
          const rows = orgId ? identity.mcpStore.connectionsOfOrg(orgId) : [];
          return rows.map((c) => ({ id: c.connection_id, status: c.status, enabled: !!c.enabled, lastErrorCode: c.last_error_code || null }));
        } catch { return []; }
      })(),
    };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

/** 等待可观察阶段：harness run 已建 / prompt 已发起 / MCP 流已活。 */
async function waitPhase(taskId, { wantRun = false, wantRequest = false, limitMs = 40000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const runs = runsOf(taskId);
    const okRun = !wantRun || runs.some((r) => r.status === "STARTING" || r.status === "RUNNING");
    const okReq = !wantRequest || callsOf(taskId).length >= 1;
    if (okRun && okReq) return { ok: true, waitedMs: Date.now() - t0, runs: runs.map((r) => r.status), calls: callsOf(taskId).length };
    if (Date.now() - t0 > limitMs) return { ok: false, waitedMs: Date.now() - t0, runs: runs.map((r) => r.status), calls: callsOf(taskId).length };
    await sleep(20);
  }
}

function snapshotPreQuit(taskIds, extra = {}) {
  return {
    scenario: SCENARIO,
    at: new Date().toISOString(),
    pid: process.pid,
    electron: process.versions.electron,
    tasks: taskIds.map((id) => facts(id)),
    mcp: mcpFacts(),
    providerProcessPid: fp && fp.child ? fp.child.pid : null,
    modelCallEnvelopes: taskIds.map((id) => ({ taskId: id, calls: callsOf(id).map((c) => ({ status: c.status, providerErrorCode: c.provider_error_code || null })) })),
    providerRequestsObservedInProcess: events.filter((e) => e.type === "provider-request").length,
    mainErrors: mainErrors.slice(0, 12),
    ...extra,
  };
}

async function runScenario() {
  const taskIds = [];
  const extra = {};
  const handlers = globalThis.__oaHandlers || new Map();

  if (SCENARIO === "state") {
    // 只读：重启后核对既有 recoverRunning() 的结果（不建任务、不建 orchestrator、不起 harness）。
    const taskId = process.env.OA_B11_TASK_ID || "";
    out("PROBE_STATE " + JSON.stringify({ taskId, facts: facts(taskId) }));
    writeJson("state-run.json", { scenario: SCENARIO, at: new Date().toISOString(), taskId, facts: facts(taskId) });
    setTimeout(() => app.quit(), 100);
    return;
  }

  const info = await installModelConfig();
  out("PROBE_DIAG model-config " + JSON.stringify(info));

  if (SCENARIO === "bootonly") {
    // 诊断对照：只 boot（真实 runtime + 窗口 + IPC），不建任务、不起 harness。
    await sleep(500);
    preQuit = snapshotPreQuit(taskIds, { note: "boot only diagnostic" });
    writeJson("pre-quit.json", preQuit);
    triggerQuit();
    return;
  }

  if (SCENARIO === "mcp") {
    extra.mcpConnectionId = await connectMcp();
    // 等 MCP 的 GET 流真的活着（服务端可观察），再进入任务阶段：否则「同时活跃」不成立。
    if (process.env.OA_B11_MCP_URL) {
      const st0 = await (async () => { try { return await (await fetch(process.env.OA_B11_MCP_URL.replace(/\/mcp$/, "") + "/__state")).json(); } catch { return null; } })();
      out("PROBE_DIAG mcp-stream-open " + JSON.stringify(st0 ? st0.getSse : null));
    }
    extra.mcpFactsBefore = mcpFacts();
  }

  const goal = SCENARIO === "success" ? "Return exactly: OPENARC_TASK_OK [PROBE:ECHO]"
    : SCENARIO === "turn" || SCENARIO === "repeat" || SCENARIO === "mcp" || SCENARIO === "cancel" || SCENARIO === "ipc-cancel" ? "Hold the turn [PROBE:TURN]"
      : "Hold the session [PROBE:START]";
  const created = identity.taskService.createTask({ context: ctxOf(), goal, modelConfigId: info.modelConfigId });
  if (!created.ok) throw new Error("createTask: " + JSON.stringify(created));
  const taskId = created.task.taskId;
  taskIds.push(taskId);
  out("PROBE_TASK " + JSON.stringify({ taskId, goal, scenario: SCENARIO }));

  if (process.env.OA_B11_NOHARNESS === "1") {
    preQuit = snapshotPreQuit(taskIds, { note: "no-harness diagnostic" });
    writeJson("pre-quit.json", preQuit);
    triggerQuit();
    return;
  }
  orch = new TaskHarnessOrchestrator({
    taskService: identity.taskService,
    adapterFactory,
    toolProxy: identity.toolProxy,
    sideEffectRuntime: identity.sideEffectRuntime,
    startTimeoutMs: 30000,
    turnTimeoutMs: 180000,
  });
  // 产品路径：task/run 经真实 IPC handler（与界面同一入口）。
  globalThis.__oaTaskCommand = handlers.get ? handlers.get("task:command") : handlers.command;
  const running = orch.runTask({
    context: ctxOf(), taskId, expectedRevision: created.task.revision,
    verify: { type: SCENARIO === "success" ? "EXACT_TEXT" : "SCHEMA_VALID", expected: SCENARIO === "success" ? "OPENARC_TASK_OK" : undefined },
  });
  running.then((r) => {
    events.push({ type: "run-result", at: Date.now(), result: { ok: r.ok, error: r.error || null, cancelled: !!r.cancelled } });
  }, (e) => events.push({ type: "run-threw", at: Date.now(), error: String((e && e.message) || e) }));

  if (SCENARIO === "success") {
    const r = await running;
    out("PROBE_RUN_RESULT " + JSON.stringify({ ok: r.ok, error: r.error || null, taskStatus: taskRow(taskId).status }));
    preQuit = snapshotPreQuit(taskIds, { note: "normal success control" });
    writeJson("pre-quit.json", preQuit);
    triggerQuit();
    return;
  }

  const phase = await waitPhase(taskId, { wantRun: true, wantRequest: SCENARIO === "turn" || SCENARIO === "repeat" || SCENARIO === "mcp" || SCENARIO === "cancel" });
  out("PROBE_PHASE " + JSON.stringify(phase));
  if (!phase.ok) throw new Error("阶段未到达：" + JSON.stringify(phase));
  await sleep(150);

  if (SCENARIO === "ipc-cancel") {
    const cancelT0 = Date.now();
    // D5-03 第十二批：真实 Electron + 真实产品 IPC 入口（task:command 的 task/cancel）。
    const phaseReq = await waitPhase(taskId, { wantRun: true, wantRequest: true, limitMs: 30000 });
    out("PROBE_PHASE " + JSON.stringify(phaseReq));
    if (!phaseReq.ok) throw new Error("阶段未到达：" + JSON.stringify(phaseReq));
    out("PROBE_PHASE2 " + JSON.stringify({ calls: callsOf(taskId).length, runs: runsOf(taskId).map((r) => r.status), caps: [...identity.modelProxy.capabilities.values()].map((c) => ({ state: c.state, max: c.maxCalls, remaining: c.remaining })) }));
    // 走**真实渲染层**：preload 桥 → IPC → 产品 task:command 的 task/cancel（不直连 orchestrator）。
    const cancelRes = await win.webContents.executeJavaScript("window.openarc.task.command({ command: 'task/cancel', taskId: " + JSON.stringify(taskId) + " })");
    out("PROBE_IPC_CANCEL " + JSON.stringify({ ok: cancelRes && cancelRes.ok, error: (cancelRes && cancelRes.error) || null, via: "preload->ipc" }));
    const converged = await Promise.race([
      running.then((r) => ({ done: "resolved", ok: r.ok, error: r.error || null, cancelled: !!r.cancelled, callsFinalized: r.callsFinalized || null })),
      sleep(25000).then(() => ({ done: "timeout" })),
    ]);
    out("PROBE_RUN_CONVERGED " + JSON.stringify(Object.assign({ elapsedMs: Date.now() - cancelT0 }, converged)));
    preQuit = snapshotPreQuit(taskIds, { note: "ipc cancel convergence" });
    writeJson("pre-quit.json", preQuit);
    triggerQuit();
    return;
  }

  if (SCENARIO === "ipc-state") {
    const taskId2 = process.env.OA_B11_TASK_ID || "";
    const f = facts(taskId2);
    out("PROBE_IPC_STATE " + JSON.stringify(f));
    writeJson("ipc-state.json", { at: new Date().toISOString(), taskId: taskId2, facts: f });
    setTimeout(() => app.quit(), 100);
    return;
  }

  if (SCENARIO === "cancel") {
    // 对照组：用户主动取消（不是退出），终态必须是 CANCELLED。
    const t = taskRow(taskId);
    const cancelled = await orch.cancel({ context: ctxOf(), taskId, expectedRevision: t.revision });
    out("PROBE_CANCEL " + JSON.stringify({ ok: cancelled.ok, error: cancelled.error || null }));
    // 取消后 run 必须有界收敛；超时只如实记录，绝不无限等（否则整个退出场景挂住，缺陷被掩盖）。
    const settled = await Promise.race([running.then(() => "resolved"), sleep(20000).then(() => "timeout")]);
    out("PROBE_CANCEL_CONVERGED " + JSON.stringify({ settled, taskStatus: (taskRow(taskId) || {}).status, runs: runsOf(taskId).map((r) => r.status) }));
    extra.cancelConverged = settled;
    preQuit = snapshotPreQuit(taskIds, { note: "explicit user cancel control" });
    writeJson("pre-quit.json", preQuit);
    // 取消已完成 → 这里的退出只做资源收尾，run 结果已定。
    out("PROBE_PREQUIT_STATE " + JSON.stringify({
      registrySize: orch.registry.size,
      tasks: taskIds.map((id) => ({ status: (taskRow(id) || {}).status, cancelRequested: !!(taskRow(id) || {}).cancel_requested, runs: runsOf(id).map((r) => r.status) })),
      mcp: mcpFacts(),
    }));
    triggerQuit();
    return;
  }

  const tokens = [...identity.modelProxy.capabilities.keys()];
  for (const tk of tokens) issuedTokens.add(tk);
  extra.capabilityTokens = tokens;

  if (SCENARIO === "repeat") {
    // 重复 quit：连续两次请求退出（第二次在第一次收尾进行中到达）。
    preQuit = snapshotPreQuit(taskIds, extra);
    writeJson("pre-quit.json", preQuit);
    quitRequestedAt = Date.now();
    out("PROBE_QUIT_BEGIN " + JSON.stringify({ pid: process.pid, at: quitRequestedAt, repeat: 2 }));
    setTimeout(() => { try { app.quit(); } catch { /* ignore */ } }, 30);
    setTimeout(() => { try { app.quit(); } catch { /* ignore */ } }, 60);
    return;
  }

  preQuit = snapshotPreQuit(taskIds, extra);
  writeJson("pre-quit.json", preQuit);
  triggerQuit();
}

function triggerQuit() {
  out("PROBE_QUIT_BEGIN " + JSON.stringify({ pid: process.pid, at: Date.now() }));
  quitRequestedAt = Date.now();
  setTimeout(() => { try { app.quit(); } catch { /* ignore */ } }, 20);
}

let quitRequestedAt = null;

app.on("quit", () => {
  try {
    writeJson("post-dispose.json", {
      scenario: SCENARIO,
      at: new Date().toISOString(),
      pid: process.pid,
      quitRequestedAt,
      quitElapsedMs: quitRequestedAt ? Date.now() - quitRequestedAt : null,
      shutdown: shutdownResult,
      events,
      mainErrors: mainErrors.slice(0, 12),
    });
  } catch { /* 退出路径不因写文件失败而卡住 */ }
});

// 与真实 electron/main.cjs 的 will-quit 同一段：先 preventDefault，收尾完成后再 quit。
app.on("before-quit", () => out("PROBE_LIFECYCLE before-quit at=" + Date.now()));
let quitting = false;
app.on("will-quit", (event) => {
  out("PROBE_LIFECYCLE will-quit quitting=" + quitting + " at=" + Date.now());
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  disposeAppResources({ identity, log: (line) => out("PROBE_LOG " + line) }).then((res) => {
    shutdownResult = res;
    try { out("PROBE_SHUTDOWN " + JSON.stringify(res)); } catch { /* ignore */ }
    writeJson("post-dispose.json", {
      scenario: SCENARIO, at: new Date().toISOString(), pid: process.pid,
      quitRequestedAt, quitElapsedMs: quitRequestedAt ? Date.now() - quitRequestedAt : null,
      shutdown: shutdownResult, events, mainErrors: mainErrors.slice(0, 12),
    });
    // 探针自有的假 Provider 子进程不是产品资源：退出前显式带走，绝不让它变成孤儿。
    if (fp && fp.child && !fp.child.killed) { try { fp.child.kill("SIGTERM"); } catch { /* ignore */ } }
    // 与真实 electron/main.cjs 同步：收尾完成后的 app.quit() 必须放到**宏任务**里
    // （微任务里调用时 Electron 44 不再推进退出序列 —— 最小复现已验证）。
    setImmediate(() => {
      try { out("PROBE_QUIT_AGAIN at=" + Date.now()); app.quit(); } catch (e) { out("PROBE_QUIT_ERROR " + String(e && e.message)); }
      // 保险丝：产品若在收尾后仍不退出，这里记一笔再失败退出（绝不静默挂住，也不掩盖真实缺陷）。
      setTimeout(() => { out("PROBE_QUIT_STILL_HERE at=" + Date.now()); try { app.exit(5); } catch { /* ignore */ } }, 5000);
    });
  });
});

app.whenReady().then(async () => {
  process.on("uncaughtException", (e) => mainErrors.push("uncaught: " + String((e && e.message) || e)));
  process.on("unhandledRejection", (e) => mainErrors.push("unhandled: " + String((e && e.message) || e)));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    out("PROBE_VERSIONS " + JSON.stringify({ electron: process.versions.electron, node: process.versions.node, scenario: SCENARIO, userData: app.getPath("userData") }));
    if (SCENARIO !== "state" && process.env.OA_B11_NOPROVIDER !== "1") {
      fp = await startProviderProcess(SCENARIO === "turn" || SCENARIO === "repeat" || SCENARIO === "mcp" || SCENARIO === "cancel" ? "slow" : "exact");
      out("PROBE_DIAG fake-provider " + JSON.stringify({ baseUrl: fp.baseUrl, pid: fp.child.pid }));
    }

    runtime = await createOpenArcRuntime({
      userDataDir: app.getPath("userData"), safeStorage,
      allowAdmin: process.env.OPENARC_IDENTITY_ADMIN === "1",
      executorLauncher: createDefaultExecutorLauncher(),
    });
    identity = runtime.identity;
    out("PROBE_DIAG runtime-booted " + JSON.stringify(runtime.snapshot()));

    if (SCENARIO !== "state") {
      await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Batch11 Exit Admin" });
      for (const appId of ["ai", "resource-library", "settings", "mcp-center"]) if (!identity.authStore.appById(appId)) identity.authStore.upsertApp({ appId, name: appId, publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
      const admin = identity.store.allUsers().find((u) => u.role === "ADMIN");
      identity.authStore.upsertAppGrant({ appId: "ai", resourceType: "model", actions: ["model.view", "model.use", "model.test"], grantedBy: "system:model-baseline", organizationId: admin.team_id });
      // MCP 复用 app_resource_grants（resource_type='mcp'）：与 tests/mcp-fixtures.mjs 同一套动作。
      identity.authStore.upsertAppGrant({ appId: "mcp-center", resourceType: "mcp", actions: ["mcp.view", "mcp.use", "mcp.manage", "mcp.test"], grantedBy: "probe", organizationId: admin.team_id });
      await identity.service.dispatch({ type: "identity/login", identifier: ADMIN, password: PW });
      identity.authStore.upsertAppGrant({ appId: "ai", resourceType: "model", actions: ["model.view", "model.use", "model.test"], grantedBy: "system:model-baseline", organizationId: admin.team_id });

      win = new BrowserWindow({ width: 1200, height: 800, show: false, title: "OpenArc OS (batch11 exit probe)", webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
      const trusted = (e) => !!e && e.sender === win.webContents && !!e.senderFrame && e.senderFrame.url === uiURL;
      ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
      ipcMain.handle("browser:navigate", async () => ({ ok: true }));
      ipcMain.handle("browser:action", async () => ({ ok: true }));
      ipcMain.handle("files:list", async () => []);
      ipcMain.handle("browser:command", async () => ({ ok: true, items: [] }));
      protocol.handle("openarc-file", async (request) => {
        try {
          const url = new URL(request.url);
          if (url.hostname !== "native") return new Response("Not Found", { status: 404 });
          const abs = NATIVE_RESOURCES[url.pathname.replace(/^\/+/, "")];
          if (!abs || !fs.existsSync(abs)) return new Response("Not Found", { status: 404 });
          const size = fs.statSync(abs).size;
          const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
          const start = range && range[1] ? Number(range[1]) : 0;
          const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start > end) return new Response("Range Not Satisfiable", { status: 416 });
          const headers = { "Content-Type": NATIVE_TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream", "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1), "Access-Control-Allow-Origin": "*" };
          if (range) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
          return new Response(Readable.toWeb(fs.createReadStream(abs, { start, end })), { status: range ? 206 : 200, headers });
        } catch { return new Response("Error", { status: 500 }); }
      });
      if (process.env.OA_B11_NOIPC !== "1") registerIdentityIpc({
        ipcMain, service: identity.service, authorization: identity.authorization, device: identity.deviceService,
        resource: identity.resourceService, resourceSearch: identity.searchService, resourcePreview: identity.previewService,
        governance: identity.governanceService, projects: identity.projectService, canvas: identity.canvasService, picker: identity.pickerService,
        model: identity.modelService, sideEffect: identity.sideEffectGateway, BrowserWindow, isTrusted: trusted,
        send: () => {}, sendSideEffect: () => {},
      });
      const handlersRef = new Map();
      globalThis.__oaHandlers = handlersRef;
      registerTaskIpc({
        // 既真实注册到 Electron，又把 handler 收一份：取消场景走**真实 preload → IPC** 路径。
        ipcMain: { handle: (ch, fn) => { handlersRef.set(ch, fn); return ipcMain.handle(ch, fn); }, removeHandler: (ch) => { handlersRef.delete(ch); return ipcMain.removeHandler(ch); } },
        taskService: identity.taskService,
        orchestrator: {
          runTask: (a) => orch.runTask(a),
          cancel: (a) => orch.cancel(a),
          resumeBudgetExhausted: (a) => orch.resumeBudgetExhausted(a),
          appendStepCommand: (a) => orch.appendStepCommand(a),
          dispose: () => orch.dispose(),
        },
        identity: identity.service, isTrusted: trusted, send: () => {},
      });
      await win.loadURL(uiURL);
      out("PROBE_DIAG renderer-loaded " + JSON.stringify({ url: win.webContents.getURL() }));
    }

    started = true;
    out("PROBE_READY " + JSON.stringify({ scenario: SCENARIO, mcpUrl: process.env.OA_B11_MCP_URL || null }));
    await runScenario();
  } catch (e) {
    out("PROBE_ERROR " + JSON.stringify({ scenario: SCENARIO, error: String((e && e.stack) || e).slice(0, 2000) }));
    writeJson("probe-error.json", { scenario: SCENARIO, error: String((e && e.stack) || e) });
    app.exit(3);
  }
});

// 探针宿主若在 60s 内没走完场景，自己失败退出，绝不无限挂住（4 = 场景未完成）。
setTimeout(() => {
  if (!started) return;
  if (quitRequestedAt) return;
  out("PROBE_STUCK " + JSON.stringify({ scenario: SCENARIO, at: Date.now() }));
  app.exit(4);
}, 60000);
