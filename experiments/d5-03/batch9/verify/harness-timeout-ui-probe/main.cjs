/**
 * D5-03 第九批 · 独立验收 · 第二段：任务界面（[data-ai-error]）真机视觉/动效探针宿主。
 *
 * 与 tests/fixtures/d4-08-verification-ui/main.cjs 同构：真实 Electron + **真实产品 Renderer**
 * （dist/index.html）+ **真实产品 preload** + **真实产品 registerIdentityIpc / registerTaskIpc**
 * + 真实 TaskService/TaskStore/ModelProxy。真实登录、真实设置面板切主题/减少动态效果，
 * 全部经真实 UI 操作。
 *
 * 唯一替换（可写面内、且任务书明确允许）：
 *   · Harness **子进程**换成既有夹具探针 tests/fixtures/harness-acp/{start,turn}-hang-agent.mjs
 *     （可控阻塞，用来真实触发产品的启动/执行预算）；
 *   · 预算用**构造参数**注入更小值（产品默认 30000/180000 一字未改）。
 * 其它一律是产品代码：ACP 协议、HarnessAdapter、classifyHarnessError、TaskHarnessOrchestrator、
 * TaskService 终态、task:event 推送、components.tsx 渲染。
 *
 * 场景由**界面里真实输入的任务目标**决定（驱动脚本在 [data-ai-goal] 里输入标记）：
 *   [PROBE:START] → start-hang 探针 + startTimeoutMs=700（turnTimeoutMs=60000）
 *   [PROBE:TURN]  → turn-hang 探针  + turnTimeoutMs=700（startTimeoutMs=20000）
 */
const { app, BrowserWindow, ipcMain, safeStorage, protocol, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");

// 与产品 electron/main.cjs:55-82 同一注册（必须在 app ready 之前）：
// 少了它，AI 面板里的原生 Siri Blob 媒体会 ERR_UNKNOWN_URL_SCHEME，兜底成静态球 —— 截图就不是产品实际渲染。
// 本机 mac 上素材确实存在（/System/Library/.../Siri Blob.mov），所以探针必须把它接上。
if (!app.isReady()) {
  protocol.registerSchemesAsPrivileged([
    { scheme: "openarc-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}
const NATIVE_RESOURCES = { "siri-blob": "/System/Library/PrivateFrameworks/SiriUI.framework/Versions/A/Resources/Siri Blob.mov" };
const NATIVE_TYPES = { ".mov": "video/quicktime", ".mp4": "video/mp4", ".m4v": "video/x-m4v" };

const ROOT = path.resolve(__dirname, "../../../../..");
const { registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { registerTaskIpc } = require(path.join(ROOT, "electron/task-bootstrap.cjs"));
const { createDefaultExecutorLauncher } = require(path.join(ROOT, "electron/executor-launcher.cjs"));
const { createOpenArcRuntime } = require(path.join(ROOT, "electron/runtime-boot.cjs"));
const { HarnessAdapter } = require(path.join(ROOT, "electron/harness-adapter.cjs"));
const { TaskHarnessOrchestrator } = require(path.join(ROOT, "electron/task-harness-orchestrator.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const AGENT_DIR = path.join(ROOT, "tests/fixtures/harness-acp");
const NODE_BIN = process.env.OPENARC_PROBE_NODE_BIN || process.execPath;
const ADMIN = "admin@batch9-ui.test";
const PW = "batch9-ui-admin-1";
const CREDENTIAL_SECRET = "batch9-ui-probe-credential";
const BUDGET_MS = 700;
const WIDTH = 1360;
const HEIGHT = 900;

const out = (line) => process.stdout.write(line + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null; let identity = null; let fp = null;
const mainErrors = []; const consoleErrors = [];
const goalOf = (taskId) => { try { const t = identity.taskStore.taskById(String(taskId || "")); return t ? String(t.goal || "") : ""; } catch { return ""; } };
const modeOf = (taskId) => (goalOf(taskId).includes("[PROBE:START]") ? "start" : "turn");

/** 两个真实产品 orchestrator，只有注入预算不同；按界面里输入的目标选择哪一个接手。 */
let orchStart = null; let orchTurn = null;
function pick(args) {
  return modeOf(args && args.taskId) === "start" ? orchStart : orchTurn;
}
const orchestrator = {
  runTask: (a) => pick(a).runTask(a),
  cancel: (a) => pick(a).cancel(a),
  resumeBudgetExhausted: (a) => pick(a).resumeBudgetExhausted(a),
  appendStepCommand: (a) => pick(a).appendStepCommand(a),
  dispose: async () => { await Promise.allSettled([orchStart && orchStart.dispose(), orchTurn && orchTurn.dispose()]); },
};

/** 真实 HarnessAdapter + 真实子进程，只有被 spawn 的可执行体是夹具探针。 */
function adapterFactory({ taskId }) {
  const mode = modeOf(taskId);
  const agent = mode === "start" ? "start-hang-agent.mjs" : "turn-hang-agent.mjs";
  return new HarnessAdapter({ modelProxy: identity.modelProxy, dshBin: NODE_BIN, dshArgs: [path.join(AGENT_DIR, agent)] });
}

/** 后端事实（UI 之外的第二份可观察量），每次 task/result 推送时落一行。 */
function backendFacts(taskId) {
  const facts = { taskId, mode: modeOf(taskId) };
  const ctx = { sessionRef: identity.service.current, appId: "ai", source: "probe" };
  const svc = identity.taskService;
  try {
    const t = svc.getTask({ context: ctx, taskId }); facts.taskStatus = t.ok ? t.task.status : null;
    const runs = svc.getHarnessRuns({ context: ctx, taskId });
    facts.runs = runs.ok ? runs.items.map((r) => ({ status: r.status, errorCode: r.errorCode || null, stopReason: r.stopReason || null })) : { error: runs.error };
    const calls = svc.getCalls({ context: ctx, taskId });
    facts.calls = calls.ok ? calls.items.map((c) => ({ status: c.status, providerErrorCode: c.providerErrorCode || null })) : { error: calls.error };
    const arts = svc.getArtifacts({ context: ctx, taskId }); facts.artifacts = arts.ok ? arts.items.length : { error: arts.error };
    const got = svc.getTask({ context: ctx, taskId });
    facts.status = got.ok ? got.task.status : null;
    const elig = svc.getResumeEligibility({ context: ctx, taskId });
    facts.resumable = !!(elig.ok && elig.resumable);
    facts.stopReason = elig.ok ? (elig.stopReason || null) : null;
  } catch (e) { facts.factsError = String(e && e.message); }
  try { facts.capabilities = [...identity.modelProxy.capabilities.values()].map((c) => c.state); } catch { /* ignore */ }
  return facts;
}

async function installModelConfig() {
  const setupCtx = { sessionRef: identity.service.current, appId: "settings", source: "probe" };
  const prov = identity.modelService.createProvider({ context: setupCtx, displayName: "Batch9 UI Probe Provider", baseUrl: fp.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: CREDENTIAL_SECRET });
  if (!prov.ok) throw new Error("createProvider: " + JSON.stringify(prov));
  const model = identity.modelService.createModel({ context: setupCtx, providerId: prov.provider.providerId, remoteModelId: "batch9-local", displayName: "Batch9 Local", capabilities: ["chat"], scope: "ORGANIZATION" });
  if (!model.ok) throw new Error("createModel: " + JSON.stringify(model));
  const def = identity.modelService.setDefault({ context: setupCtx, capability: "chat", configId: model.model.configId, scope: "ORGANIZATION" });
  if (!def.ok) throw new Error("setDefault: " + JSON.stringify(def));
  return { providerId: prov.provider.providerId, modelConfigId: model.model.configId, providerRequests: fp.state.requests };
}

app.whenReady().then(async () => {
  process.on("uncaughtException", (e) => mainErrors.push(String((e && e.message) || e)));
  process.on("unhandledRejection", (e) => mainErrors.push(String((e && e.message) || e)));
  try {
    out("PROBE_VERSIONS " + JSON.stringify({ electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch, nodeBin: NODE_BIN, uiURL, window: WIDTH + "x" + HEIGHT }));
    const { startFakeProvider } = await import(pathToFileURL(path.join(ROOT, "tests/model-fake-provider.mjs")).href);
    fp = await startFakeProvider({ behavior: "exact" });

    identity = (await createOpenArcRuntime({
      userDataDir: app.getPath("userData"), safeStorage, allowAdmin: true,
      executorLauncher: createDefaultExecutorLauncher(),
    })).identity;
    out("PROBE_DIAG runtime-booted");

    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Batch9 UI Admin" });
    for (const appId of ["ai", "resource-library", "settings"]) if (!identity.authStore.appById(appId)) identity.authStore.upsertApp({ appId, name: appId, publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
    const admin = identity.store.allUsers().find((u) => u.role === "ADMIN");
    identity.authStore.upsertAppGrant({ appId: "ai", resourceType: "model", actions: ["model.view", "model.use", "model.test"], grantedBy: "system:model-baseline", organizationId: admin.team_id });

    orchStart = new TaskHarnessOrchestrator({ taskService: identity.taskService, adapterFactory, toolProxy: identity.toolProxy, sideEffectRuntime: identity.sideEffectRuntime, startTimeoutMs: BUDGET_MS, turnTimeoutMs: 60000 });
    orchTurn = new TaskHarnessOrchestrator({ taskService: identity.taskService, adapterFactory, toolProxy: identity.toolProxy, sideEffectRuntime: identity.sideEffectRuntime, startTimeoutMs: 20000, turnTimeoutMs: BUDGET_MS });
    out("PROBE_DIAG orchestrators-ready " + JSON.stringify({ startTimeoutMs: BUDGET_MS, turnTimeoutMs: BUDGET_MS }));

    win = new BrowserWindow({ width: WIDTH, height: HEIGHT, show: true, title: "OpenArc OS (batch9 UI probe)", webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    win.webContents.on("console-message", (...args) => {
      const d = args[1];
      const level = d && typeof d === "object" ? d.level : args[1];
      const message = d && typeof d === "object" ? d.message : args[2];
      if (level === "error" || level === 2 || level === 3) consoleErrors.push(String(message).slice(0, 200));
    });
    const trusted = (e) => e.sender === win.webContents && e.senderFrame && e.senderFrame.url === uiURL;
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    // 探针宿主只装配被测面（身份 + 任务）；桌面文件列表与浏览器下载控制不在被测面内，
    // 用空实现替掉，避免渲染层出现与验收无关的 handler 缺失告警（与 d4-08 探针同一做法）。
    ipcMain.handle("files:list", async () => []);
    ipcMain.handle("browser:command", async () => ({ ok: true, items: [] }));
    // 与产品 electron/main.cjs:485-516 的 native 分支同一逻辑（只接本机原生素材白名单）。
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
        const body = Readable.toWeb(fs.createReadStream(abs, { start, end }));
        return new Response(body, { status: range ? 206 : 200, headers });
      } catch { return new Response("Error", { status: 500 }); }
    });
    registerIdentityIpc({
      ipcMain, service: identity.service, authorization: identity.authorization, device: identity.deviceService,
      resource: identity.resourceService, resourceSearch: identity.searchService, resourcePreview: identity.previewService,
      governance: identity.governanceService, projects: identity.projectService, canvas: identity.canvasService, picker: identity.pickerService,
      model: identity.modelService, sideEffect: identity.sideEffectGateway, BrowserWindow, isTrusted: trusted,
      send: (event) => { if (win && !win.isDestroyed()) win.webContents.send("identity:event", event); },
      sendSideEffect: (event) => { if (win && !win.isDestroyed()) win.webContents.send("sideeffect:event", event); },
    });
    registerTaskIpc({
      ipcMain, taskService: identity.taskService, orchestrator, identity: identity.service, isTrusted: trusted,
      send: (event) => {
        if (win && !win.isDestroyed()) win.webContents.send("task:event", event);
        if (event && event.type === "task/result") {
          out("PROBE_TASK_EVENT " + JSON.stringify({ event, facts: backendFacts(event.taskId) }));
          out("PROBE_HEALTH " + JSON.stringify({ mainErrors: mainErrors.slice(0, 8), rendererConsoleErrors: consoleErrors.slice(0, 8) }));
        }
      },
    });
    out("PROBE_DIAG ipc-registered");

    await win.loadURL(uiURL);
    out("PROBE_READY");
    // 真实 UI 登录后（identity.service.current 出现）再建立 provider/model 配置。
    const deadline = Date.now() + 120000;
    let modelOut = null;
    while (Date.now() < deadline && !modelOut) {
      if (identity.service.current) { try { modelOut = await installModelConfig(); } catch (e) { out("PROBE_MODEL_ERROR " + String(e && e.message)); } }
      if (!modelOut) await sleep(250);
    }
    if (!modelOut) throw new Error("UI 登录超时，模型配置未建立");
    out("PROBE_MODEL_READY " + JSON.stringify(modelOut));
  } catch (e) {
    out("PROBE_FATAL " + String((e && e.stack) || e));
  }
});

app.on("window-all-closed", () => { /* probe 由驱动脚本 kill */ });
process.on("exit", () => { try { out("PROBE_EXIT mainErrors=" + JSON.stringify(mainErrors) + " consoleErrors=" + JSON.stringify(consoleErrors.slice(0, 8))); } catch { /* ignore */ } });
