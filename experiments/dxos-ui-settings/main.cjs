/**
 * 设置 › 模型与服务商：协议设置 / CLI / 服务商 logo 真机截图 + DeepSeek 真实连接取证。
 * 隔离 userData；加载产品真实入口 dist/vue.html；走真实 IPC 装配（identity / model / cli）。
 * 密钥只从 ~/.dsh/.credentials.yaml 读入内存，绝不打印、绝不落盘、绝不写入任何产出文件。
 */
const { app, BrowserWindow, ipcMain, safeStorage, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../..");
const OUT = path.join(ROOT, "artifacts", "dxos-ui-settings");
fs.mkdirSync(OUT, { recursive: true });

const DEEPSEEK_BASE = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-chat";

// 隔离 userData：必须在 app ready 之前，连 localStorage / session 一起隔离。
const ISO = fs.mkdtempSync(path.join(os.tmpdir(), "oa-dxos-settings-"));
app.setPath("userData", ISO);
app.commandLine.appendSwitch("force-device-scale-factor", "2");

const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const uiURL = pathToFileURL(path.join(ROOT, "dist/vue.html")).href;

const IDENT = "dxos-settings@openarc.local";
const PW = "dxos-settings-password-1";
const NAME = "DXOS Settings";
const SETTINGS_WIN = '.window[aria-label="系统设置窗口"]';
const SETTINGS_BODY = SETTINGS_WIN + " .settings-pane.settings-body";

function readDeepseekKey() {
  const file = path.join(os.homedir(), ".dsh", ".credentials.yaml");
  const txt = fs.readFileSync(file, "utf8");
  const m = txt.match(/DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)["']?/);
  if (!m || !m[1]) throw new Error("credentials.yaml 里没有 DEEPSEEK_API_KEY");
  return m[1];
}

const report = {
  checks: [], errors: [], consoleErrors: [], pageErrors: [], shots: [],
  versions: {}, deepseek: { credentialSetPath: null, provider: null, credential: null, remoteModels: null, modelCreate: null, modelList: null, modelTest: null, modelStoreCall: null, protocolStore: null, chat: null, stream: null, uiState: null, rowLogo: null },
  cli: { list: null, tools: null }, protocol: { counts: null, logos: null }, logos: { providers: null, protocols: null },
};
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail) => {
  report.checks.push({ name: name, ok: !!ok, detail: String(detail == null ? "" : detail) });
  out((ok ? "PASS " : "FAIL ") + name + (detail ? " :: " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WATCHDOG = Number(process.env.DXOS_WATCHDOG_MS || 240000);
function cleanupIso() { try { fs.rmSync(ISO, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
process.on("exit", cleanupIso);
setTimeout(() => { try { out("RESULT " + JSON.stringify(report)); } catch (e) { /* ignore */ } cleanupIso(); app.exit(0); }, WATCHDOG);

let win;
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const attr = (sel, name) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.getAttribute(" + JSON.stringify(name) + ") || null");
const count = (sel) => js("return document.querySelectorAll(" + JSON.stringify(sel) + ").length");
const text = (sel) => js("return (document.querySelector(" + JSON.stringify(sel) + ")?.textContent || '').trim()");
const attrs = (sel, name) => js("return [...document.querySelectorAll(" + JSON.stringify(sel) + ")].map(function (e) { return e.getAttribute(" + JSON.stringify(name) + "); })");

async function waitGate(want, timeout) {
  const list = Array.isArray(want) ? want : [want];
  const t0 = Date.now(); let last = "?";
  while (Date.now() - t0 < (timeout || 30000)) {
    try { last = await gate(); if (list.indexOf(last) >= 0) return last; } catch (e) { /* navigating */ }
    await sleep(120);
  }
  return "TIMEOUT(last=" + last + ")";
}
async function waitFor(sel, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 12000)) { if (await has(sel)) return true; await sleep(70); }
  return false;
}
async function waitAttr(sel, name, value, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 12000)) { if ((await attr(sel, name)) === value) return true; await sleep(70); }
  return false;
}
async function waitEnabled(sel, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 8000)) {
    const d = await js("return !!document.querySelector(" + JSON.stringify(sel) + ")?.disabled");
    if (d === false) return true;
    await sleep(80);
  }
  return false;
}
const setInput = (sel, value) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const click = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const scrollTo = (sel, block) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return false; el.scrollIntoView({ block: " + JSON.stringify(block || "start") + " }); return true;");
const setBodyScroll = (top) => js("const el = document.querySelector(" + JSON.stringify(SETTINGS_BODY) + "); if (!el) return false; el.scrollTop = " + Number(top) + "; return true;");

async function mcmd(command, payload) {
  const script = "const r = await window.openarc.model.command(" + JSON.stringify({ command: command, payload: payload || {} }) + "); return JSON.stringify(r === undefined ? null : r);";
  const raw = await js(script);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, error: "PROBE_PARSE" }; }
}
async function cliCmd(command, payload) {
  const script = "const r = await window.openarc.cli.command(" + JSON.stringify({ command: command, payload: payload || {} }) + "); return JSON.stringify(r === undefined ? null : r);";
  const raw = await js(script);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, error: "PROBE_PARSE" }; }
}
async function installErrorHooks() {
  await js("window.__dxosProbeErrors = []; window.addEventListener('error', function (e) { window.__dxosProbeErrors.push('error: ' + (e.message || String(e.error))); }); window.addEventListener('unhandledrejection', function (e) { window.__dxosProbeErrors.push('unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason)); }); return true;");
}
async function setDark(dark) {
  nativeTheme.themeSource = dark ? "dark" : "light";
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const isDark = await js("return document.querySelector('.desktop')?.classList.contains('dark') === true");
    if (isDark === dark) return true;
    await sleep(80);
  }
  return false;
}
async function shoot(name, theme) {
  await sleep(500);
  const image = await win.webContents.capturePage();
  const size = image.getSize();
  fs.writeFileSync(path.join(OUT, name), image.toPNG());
  report.shots.push({ file: name, width: size.width, height: size.height, theme: theme });
  out("SHOT " + name + " " + size.width + "x" + size.height + " (" + theme + ")");
  return size;
}
async function shootBoth(baseName) {
  const sizes = [];
  for (const theme of ["light", "dark"]) {
    await setDark(theme === "dark");
    sizes.push(await shoot(baseName + "-" + theme + ".png", theme));
  }
  await setDark(false);
  return sizes;
}

async function login() {
  let g = await waitGate(["uninitialized", "unauthenticated", "ready"], 30000);
  if (g === "ready") return g;
  if (g === "unauthenticated") {
    await setInput('[data-d3-id="login-identifier"]', IDENT);
    await setInput('[data-d3-id="login-password"]', PW);
    await waitEnabled('[data-d3-id="login-submit"]');
    await click('[data-d3-id="login-submit"]');
    return waitGate("ready", 30000);
  }
  await setInput('[data-d3-id="setup-name"]', NAME);
  await waitEnabled('[data-d3-id="setup-next"]'); await click('[data-d3-id="setup-next"]');
  await waitFor('[data-d3-id="setup-identifier"]');
  await setInput('[data-d3-id="setup-identifier"]', IDENT);
  await waitEnabled('[data-d3-id="setup-next"]'); await click('[data-d3-id="setup-next"]');
  await waitFor('[data-d3-id="setup-password"]');
  await setInput('[data-d3-id="setup-password"]', PW);
  await setInput('[data-d3-id="setup-confirm"]', PW);
  await waitEnabled('[data-d3-id="setup-submit"]'); await click('[data-d3-id="setup-submit"]');
  await waitGate("unauthenticated", 20000);
  await setInput('[data-d3-id="login-identifier"]', IDENT);
  await setInput('[data-d3-id="login-password"]', PW);
  await waitEnabled('[data-d3-id="login-submit"]'); await click('[data-d3-id="login-submit"]');
  return waitGate("ready", 30000);
}

async function openModelSettings() {
  if (!(await has(".settings-content"))) {
    await click('[aria-label="打开系统设置"]');
    if (!(await waitFor(".settings-content", 12000))) return false;
  }
  await click('[data-settings-pane="model"]');
  return waitAttr("[data-settings-active]", "data-settings-active", "model", 12000);
}

app.whenReady().then(async () => {
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform + "/" + process.arch };
    out("VERSIONS " + JSON.stringify(report.versions));
    out("ISOLATED_USERDATA " + ISO);

    const identity = createIdentityService({ userDataDir: ISO, safeStorage, allowAdmin: true });
    const KEY = readDeepseekKey();
    out("STEP key loaded (length only) " + KEY.length);

    win = new BrowserWindow({
      width: 1440, height: 900, useContentSize: true, show: false,
      webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    win.webContents.on("console-message", (...args) => {
      try {
        const first = args[0]; let level, message;
        if (first && typeof first === "object" && "level" in first) { level = first.level; message = first.message; }
        else { level = args[1]; message = args[2]; }
        if (level === "error" || level === 3 || level === "3") report.consoleErrors.push(String(message));
      } catch (e) { /* ignore */ }
    });
    win.webContents.on("render-process-gone", (_e, d) => report.errors.push("render-process-gone: " + JSON.stringify(d)));
    win.webContents.on("did-fail-load", (_e, c, d) => report.errors.push("did-fail-load: " + c + " " + d));
    win.webContents.on("preload-error", (_e, p, err) => report.errors.push("preload-error: " + p + " " + String(err)));

    // 设置探针用不到的域：给最小真实现，避免无关 console 噪声（不是假成功：仅对空查询返回空）。
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:command", async () => ({ ok: true, items: [] }));
    ipcMain.handle("files:list", async () => ({ ok: true, entries: [] }));
    ipcMain.handle("files:import", async () => ({ ok: true, added: [] }));
    ipcMain.handle("files:remove", async () => ({ ok: true }));
    ipcMain.handle("files:trashList", async () => ({ ok: true, entries: [] }));
    ipcMain.handle("sideeffect:command", async () => ({ ok: false, error: "NOT_AVAILABLE_IN_SETTINGS_PROBE" }));

    const isTrusted = (e) => e.sender === win.webContents && e.senderFrame && e.senderFrame.url === uiURL;
    registerIdentityIpc({
      ipcMain, service: identity.service, authorization: identity.authorization, device: identity.deviceService, model: identity.modelService, isTrusted,
      send: (event) => { if (win && !win.isDestroyed()) win.webContents.send("identity:event", event); },
    });
    const { createCliBundle } = require(path.join(ROOT, "electron/cli-service.cjs"));
    const { registerCliIpc } = require(path.join(ROOT, "electron/cli-bootstrap.cjs"));
    registerCliIpc(ipcMain, { bundle: createCliBundle({}), identity: identity.service, isTrusted: isTrusted, hostAppId: "cli" });

    nativeTheme.themeSource = "light";
    await win.loadURL(uiURL);
    await sleep(500);
    let g = await login();
    check("boot · 登录进入桌面", g === "ready", "gate=" + g);
    await installErrorHooks();

    /* ── 1. 任务书链路：provider/create → credential/set → provider/models（如实记录） ── */
    const firstCreate = await mcmd("provider/create", { displayName: "DeepSeek", baseUrl: DEEPSEEK_BASE, scope: "PERSONAL" });
    const dsId0 = firstCreate && firstCreate.provider ? firstCreate.provider.providerId : null;
    check("deepseek · provider/create 成功", !!dsId0, JSON.stringify(firstCreate && firstCreate.provider ? { providerId: firstCreate.provider.providerId, baseUrl: firstCreate.provider.baseUrl, adapterType: firstCreate.provider.adapterType, status: firstCreate.provider.status } : firstCreate));
    const credSet0 = dsId0 ? await mcmd("credential/set", { providerId: dsId0, secret: KEY }) : null;
    const credStatus0 = dsId0 ? await mcmd("credential/status", { providerId: dsId0 }) : null;
    const pull0 = dsId0 ? await mcmd("provider/models", { providerId: dsId0 }) : null;
    report.deepseek.credentialSetPath = {
      providerId: dsId0,
      credentialSet: credSet0 ? { ok: credSet0.ok === true, error: credSet0.error || null } : null,
      credentialStatus: credStatus0,
      providerModels: pull0 ? { ok: pull0.ok === true, error: pull0.error || null, ids: pull0.ok ? (pull0.items || []).map((m) => m.id) : null } : null,
    };
    check("deepseek · credential/set 写入成功", credSet0 && credSet0.ok === true, JSON.stringify(credSet0 && credSet0.ok ? { ok: true } : credSet0));
    check("deepseek · credential/status 显示已配置", credStatus0 && credStatus0.configured === true, JSON.stringify(credStatus0));
    check("deepseek · [任务书链路] credential/set 后 provider/models 成功", pull0 && pull0.ok === true, JSON.stringify(report.deepseek.credentialSetPath.providerModels));
    if (dsId0) await mcmd("provider/delete", { providerId: dsId0 });

    /* ── 2. 可用配置：provider/create 带 credentialSecret（与设置页「添加服务商」同一入参） ── */
    const create2 = await mcmd("provider/create", { displayName: "DeepSeek", baseUrl: DEEPSEEK_BASE, credentialSecret: KEY, scope: "PERSONAL" });
    const dsId = create2 && create2.provider ? create2.provider.providerId : null;
    report.deepseek.provider = create2 && create2.provider ? { providerId: create2.provider.providerId, displayName: create2.provider.displayName, baseUrl: create2.provider.baseUrl, adapterType: create2.provider.adapterType, endpointScope: create2.provider.endpointScope, status: create2.provider.status, credentialConfigured: create2.provider.credentialConfigured } : { error: create2 && create2.error };
    check("deepseek · provider/create(credentialSecret) 成功且凭据已配置", !!dsId && create2.provider.credentialConfigured === true, JSON.stringify(report.deepseek.provider));

    const tModels0 = Date.now();
    const remote = await mcmd("provider/models", { providerId: dsId });
    const tModels = Date.now() - tModels0;
    report.deepseek.remoteModels = remote ? { ok: remote.ok === true, error: remote.error || null, latencyMs: tModels, ids: remote.ok ? (remote.items || []).map((m) => m.id) : null, items: remote.ok ? remote.items : null } : null;
    check("deepseek · provider/models 真实 GET /v1/models 成功", remote && remote.ok === true, JSON.stringify(report.deepseek.remoteModels && { ok: remote.ok, error: remote.error, latencyMs: tModels, ids: report.deepseek.remoteModels.ids }));

    const mk = await mcmd("model/create", { providerId: dsId, remoteModelId: DEEPSEEK_MODEL, displayName: "DeepSeek Chat", capabilities: ["chat"], scope: "PERSONAL" });
    report.deepseek.modelCreate = mk ? { ok: mk.ok === true, error: mk.error || null, configId: mk.model && mk.model.configId } : null;
    check("deepseek · model/create 注册 " + DEEPSEEK_MODEL, mk && mk.ok === true, JSON.stringify(report.deepseek.modelCreate));
    const modelList = await mcmd("model/list", {});
    report.deepseek.modelList = modelList && modelList.ok ? { items: (modelList.items || []).filter((m) => m.providerId === dsId) } : { ok: false, error: modelList && modelList.error };
    const cfg = modelList && modelList.ok ? (modelList.items || []).find((m) => m.providerId === dsId && m.remoteModelId === DEEPSEEK_MODEL) : null;

    /* ── 3. 模型域真实 chat（UI「测试连接」走 model/test → ModelService.chat） ── */
    if (cfg) {
      const t0 = Date.now();
      const test = await mcmd("model/test", { configId: cfg.configId });
      const ms = Date.now() - t0;
      report.deepseek.modelTest = { ok: test && test.ok === true, reachable: test && test.reachable, credentialAccepted: test && test.credentialAccepted, inference: test && test.inference, error: test && test.error || null, latencyMs: ms };
      check("deepseek · model/test（真实 chat，模型域）成功", test && test.ok === true, JSON.stringify(report.deepseek.modelTest));
    } else {
      check("deepseek · model/test（真实 chat，模型域）", false, "config 未找到");
    }

    /* ── 4. 任务书要求的 provider/call（模型域 providerId）——如实记录原始错误 ── */
    {
      const t0 = Date.now();
      const callModelStore = await mcmd("provider/call", { providerId: dsId, model: DEEPSEEK_MODEL, messages: [{ role: "user", content: "只回复：ok" }], params: { max_tokens: 16 } });
      report.deepseek.modelStoreCall = { raw: callModelStore, latencyMs: Date.now() - t0 };
      out("MODELSTORE_CALL " + JSON.stringify(callModelStore));
    }

    /* ── 5. 协议域 provider-protocol store（provider/call 真正读的那张表）→ 真实 chat ── */
    const pp = identity.modelService.providerProtocol;
    let ppId = null;
    {
      const prov = pp.store.create({ name: "DeepSeek", baseUrl: DEEPSEEK_BASE, protocol: "openai", models: [{ model: DEEPSEEK_MODEL, caps: ["llm"] }] });
      ppId = prov.id;
      pp.store.setKeys(ppId, { apiKey: KEY });
      report.deepseek.protocolStore = { id: ppId, name: prov.name, baseUrl: prov.base_url, protocol: prov.protocol, models: prov.models.map((m) => m.model), hasKey: pp.store.listPublic().find((p) => p.id === ppId).has_key === true };
      check("deepseek · provider-protocol store 已建站并写入密钥", report.deepseek.protocolStore.hasKey === true, JSON.stringify({ id: ppId, protocol: prov.protocol, models: report.deepseek.protocolStore.models }));
    }
    {
      const t0 = Date.now();
      const chat = await mcmd("provider/call", { providerId: ppId, model: DEEPSEEK_MODEL, messages: [{ role: "user", content: "只回复：ok" }], params: { max_tokens: 16 } });
      const ms = Date.now() - t0;
      report.deepseek.chat = { ok: chat && chat.ok === true, error: chat && chat.error || null, requestId: chat && chat.requestId || null, text: chat && chat.text, usage: chat && chat.usage || null, latencyMs: ms, snapshot: chat && chat.snapshot || null };
      check("deepseek · provider/call 真实 chat 成功", chat && chat.ok === true, JSON.stringify({ ok: chat && chat.ok, error: chat && chat.error, text: chat && chat.text, ms: ms, usage: chat && chat.usage }));
    }
    {
      const t0 = Date.now();
      const stream = await mcmd("provider/callStream", { providerId: ppId, model: DEEPSEEK_MODEL, messages: [{ role: "user", content: "只回复：ok" }], params: { max_tokens: 16 } });
      report.deepseek.stream = { ok: stream && stream.ok === true, error: stream && stream.error || null, text: stream && stream.text, usage: stream && stream.usage || null, latencyMs: Date.now() - t0 };
      check("deepseek · provider/callStream 真实流式 chat 成功", stream && stream.ok === true, JSON.stringify({ ok: stream && stream.ok, error: stream && stream.error, text: stream && stream.text, usage: stream && stream.usage }));
    }

    /* ── 6. logo 对照用的服务商：已知品牌 + 自定义未知品牌 ── */
    const oa = await mcmd("provider/create", { displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", scope: "PERSONAL" });
    const custom = await mcmd("provider/create", { displayName: "我的中转站", baseUrl: "https://example.com/v1", scope: "PERSONAL" });
    out("EXTRA_PROVIDERS " + JSON.stringify([oa && oa.provider && oa.provider.providerId, custom && custom.provider && custom.provider.providerId]));

    /* ── 7. reload 让 UI 反映真实状态，再进设置 ── */
    out("STEP reload…");
    win.webContents.reload();
    await sleep(1500);
    g = await waitGate(["ready", "unauthenticated"], 25000);
    if (g === "unauthenticated") g = await login();
    check("ui · reload 后仍为已登录桌面", g === "ready", "gate=" + g);
    const opened = await openModelSettings();
    check("ui · 打开 设置 › 模型与服务商", opened === true, "opened=" + opened);
    await sleep(900);
    await installErrorHooks();

    /* ── 8. 服务商列表 / 详情 + logo ── */
    await setBodyScroll(0);
    await sleep(300);
    const provIds = await attrs("[data-d4-01-provider]", "data-d4-01-provider");
    const provNames = await js("return [...document.querySelectorAll('[data-d4-01-providers] [data-d4-01-provider]')].map(function (e) { return (e.querySelector('b')?.textContent || '').trim(); })");
    const provKinds = await attrs("[data-d4-01-providers] [data-provider-logo-kind]", "data-provider-logo-kind");
    const provKeys = await attrs("[data-d4-01-providers] [data-provider-logo]", "data-provider-logo");
    const provTones = await attrs("[data-d4-01-providers] .mp2-dot", "data-tone");
    const provModelCounts = await js("return [...document.querySelectorAll('[data-d4-01-providers] [data-d4-01-provider]')].map(function (e) { return (e.querySelector('small')?.textContent || '').trim(); })");
    report.logos.providers = { ids: provIds, names: provNames, kinds: provKinds, keys: provKeys, tones: provTones, modelCounts: provModelCounts };
    check("ui · 服务商列表包含 DeepSeek/OpenAI/自定义", provIds.indexOf(dsId) >= 0 && provIds.length >= 3, JSON.stringify({ ids: provIds, names: provNames }));
    check("ui · 服务商头像同时存在 brand 与 initial 两种", provKinds.indexOf("brand") >= 0 && provKinds.indexOf("initial") >= 0, JSON.stringify({ names: provNames, kinds: provKinds, keys: provKeys }));
    if (dsId) { await click('[data-d4-01-provider="' + dsId + '"]'); await waitFor('[data-d4-01-provider-detail="' + dsId + '"]', 8000); }
    await sleep(300);
    const dsState = await text('[data-d4-01-provider-status]');
    const dsCred = await text('[data-d4-01-cred-status="' + dsId + '"]');
    const dsModels = await count('[data-d4-01-provider-detail="' + dsId + '"] [data-d4-01-model]');
    report.deepseek.uiState = { badge: dsState, credential: dsCred, modelRows: dsModels };
    check("ui · DeepSeek 显示已启用/有密钥/模型已拉取", dsState.length > 0 && dsCred.indexOf("已保存") >= 0 && dsModels >= 1, JSON.stringify(report.deepseek.uiState));
    report.deepseek.rowLogo = { key: await attr('[data-d4-01-provider="' + dsId + '"] [data-provider-logo]', "data-provider-logo"), kind: await attr('[data-d4-01-provider="' + dsId + '"] [data-provider-logo-kind]', "data-provider-logo-kind") };
    out("DEEPSEEK_ROW_LOGO " + JSON.stringify(report.deepseek.rowLogo));
    await shootBoth("providers");

    /* ── 9. 协议设置：kind 过滤 + 列表 + 详情 + 校验 ── */
    await scrollTo("[data-model-settings-protocol]", "start");
    await sleep(400);
    const total = await count("[data-protocol-settings-row]");
    await click('[data-protocol-settings-kind="provider"]');
    await sleep(300);
    const providerRows = await count("[data-protocol-settings-row]");
    const kindLogoKinds = await attrs("[data-protocol-settings-list] [data-protocol-settings-logo-kind]", "data-protocol-settings-logo-kind");
    const kindLogoKeys = await attrs("[data-protocol-settings-list] [data-protocol-settings-logo]", "data-protocol-settings-logo");
    report.protocol.counts = { all: total, providerFilter: providerRows };
    report.protocol.logos = { kinds: kindLogoKinds, keys: kindLogoKeys };
    check("协议设置 · kind 过滤生效（provider 行数 < 全部）", providerRows > 0 && providerRows < total, JSON.stringify(report.protocol.counts));
    check("协议设置 · 协议头像同时有 brand 与 initial", kindLogoKinds.indexOf("brand") >= 0 && kindLogoKinds.indexOf("initial") >= 0, JSON.stringify({ kinds: kindLogoKinds.slice(0, 24), keys: kindLogoKeys.slice(0, 24) }));
    await click('[data-protocol-settings-kind="all"]');
    await sleep(300);
    const rowKeys = await attrs("[data-protocol-settings-row]", "data-protocol-settings-row");
    const v2row = rowKeys.indexOf("provider:openai-http") >= 0 ? "provider:openai-http" : rowKeys[0];
    await click('[data-protocol-settings-row="' + v2row + '"]');
    await waitFor('[data-protocol-settings-detail="' + v2row + '"]', 8000);
    await sleep(400);
    await shootBoth("protocols");

    await scrollTo("[data-protocol-settings-editor]", "start");
    await sleep(300);
    await click("[data-protocol-settings-validate]");
    await waitFor("[data-protocol-settings-validate-result]", 8000);
    await sleep(300);
    const valOk = await attr("[data-protocol-settings-validate-result]", "data-protocol-settings-validate-ok");
    const valText = await text("[data-protocol-settings-validate-result]");
    check("协议设置 · 校验入口可用", valOk === "true", "ok=" + valOk + " text=" + String(valText).slice(0, 80));
    await shootBoth("protocol-validate");

    /* ── 10. CLI：四个工具各一卡（如实安装状态 + 未安装的安装提示） ── */
    await scrollTo("[data-model-settings-cli]", "start");
    await sleep(700);
    const cliListReply = await cliCmd("cli/list");
    report.cli.list = cliListReply;
    const cliIds = await attrs("[data-cli-tool]", "data-cli-tool");
    const cliInstalled = await attrs("[data-cli-tool]", "data-cli-installed");
    const hints = await js("return [...document.querySelectorAll('[data-cli-tool]')].map(function (e) { const h = e.querySelector('[data-cli-install-hint]'); return h ? h.textContent.trim() : null; })");
    const versions = await js("return [...document.querySelectorAll('[data-cli-tool]')].map(function (e) { const v = e.querySelector('[data-cli-version]'); return v ? v.textContent.trim() : null; })");
    report.cli.tools = { ids: cliIds, installed: cliInstalled, hints: hints, versions: versions };
    check("CLI · 四个工具各一卡（codex/gemini/jimeng/pippit）", ["codex", "gemini", "jimeng", "pippit"].every((id) => cliIds.indexOf(id) >= 0), JSON.stringify(cliIds));
    check("CLI · 安装状态如实（不造已安装/未安装）", cliInstalled.length > 0, JSON.stringify(cliInstalled));
    const missIdx = cliInstalled.map((v, i) => (v === "false" ? i : -1)).filter((i) => i >= 0);
    const missHaveHints = missIdx.every((i) => typeof hints[i] === "string" && hints[i].length > 0);
    check("CLI · 未安装的卡片都有安装提示", missHaveHints, JSON.stringify({ installed: cliInstalled, hints: hints }));
    const firstCli = cliIds[0];
    if (firstCli) { await click('[data-cli-expand="' + firstCli + '"]'); await sleep(900); }
    await shootBoth("cli");
    if (firstCli) { await click('[data-cli-expand="' + firstCli + '"]'); await sleep(600); }
    await scrollTo("[data-model-settings-cli]", "start");
    await sleep(300);
    await shootBoth("cli-all");

    /* ── 11. 收尾断言 ── */
    const probeErrors = await js("return JSON.stringify(window.__dxosProbeErrors || [])");
    try { report.pageErrors = JSON.parse(probeErrors); } catch (e) { report.pageErrors = [String(probeErrors)]; }
    report._consoleErrorCount = report.consoleErrors.length;
    report._pageErrorCount = report.pageErrors.length;
    check("收尾 · 0 console error", report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(" | "));
    check("收尾 · 0 pageerror", report.pageErrors.length === 0, report.pageErrors.slice(0, 3).join(" | "));
    check("收尾 · 渲染进程无崩溃 / 无加载失败", report.errors.length === 0, report.errors.slice(0, 3).join(" | "));
    const badShots = report.shots.filter((s) => s.width !== 2880 || s.height !== 1800);
    check("收尾 · 全部截图 2880x1800", badShots.length === 0 && report.shots.length >= 8, badShots.length + " bad / " + report.shots.length + " total");
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e && e.message).slice(0, 240));
  } finally {
    try { win?.destroy(); } catch (e) { /* ignore */ }
    cleanupIso();
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
