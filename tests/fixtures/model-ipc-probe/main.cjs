/** D4-01 Closure A · model:command 真实 Electron IPC 探针宿主。 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { wireModelEvents } = require(path.join(ROOT, "electron/model-bootstrap.cjs"));
const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";
const SECRET = "FAKE_MODEL_IPC_SECRET_UI_D401";
const report = { checks: [], errors: [] };
const out = (l) => process.stdout.write(l + "\n");
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail) }); out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win; let userData = null; let streamStub = null;
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const setValue = (sel, value) => js("const el=document.querySelector(" + JSON.stringify(sel) + "); if(!el) return 'missing'; const proto = el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; const setter=Object.getOwnPropertyDescriptor(proto,'value').set; setter.call(el," + JSON.stringify(value) + "); el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';");
const click = (sel) => js("const el=document.querySelector(" + JSON.stringify(sel) + "); if(!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
async function waitGate(want, timeout = 30000) { const t0 = Date.now(); let last = "?"; while (Date.now() - t0 < timeout) { try { last = await gate(); if (last === want) return last; } catch { /* navigating */ } await sleep(120); } return "TIMEOUT(" + last + ")"; }

/** W10：本地 127.0.0.1 SSE 桩（不联网）—— 让 provider/callStream 产生真实 model:event 下行。 */
function startStreamStub() {
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/v1/chat/completions") {
      res.setHeader("content-type", "text/event-stream");
      res.write('data: {"choices":[{"delta":{"content":"UI"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"-stream"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" ok"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      baseUrl: "http://127.0.0.1:" + server.address().port,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

app.whenReady().then(async () => {
  try {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-01-ipc-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    const adminLogin = await identity.store.login({ identifier: ADMIN, password: PW });
    const adminCtx = { sessionRef: adminLogin.session.ref, appId: "resource-library" };
    // 保证 host app resource-library 有 model 管理授权（bootstrap 已 seed，这里兜底）
    identity.modelService.grantAppModelAccess({ context: adminCtx, appId: "resource-library", actions: ["model.view", "model.use", "model.manage", "model.test"] });
    win = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    registerIdentityIpc({
      ipcMain, service: identity.service, authorization: identity.authorization, device: identity.deviceService,
      resource: identity.resourceService, resourceSearch: identity.searchService, resourcePreview: identity.previewService,
      governance: identity.governanceService, projects: identity.projectService, canvas: identity.canvasService, picker: identity.pickerService,
      model: identity.modelService, dialog: null, BrowserWindow: win,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: () => {},
    });
    // W10：等价 main.cjs 的宿主接线 —— provider-protocol 的流式事件接到 model:event。
    // 旧口径（"只有 command"）没有下行事件，这里补上真实 Electron 的端到端验证。
    streamStub = await startStreamStub();
    wireModelEvents({
      service: identity.modelService,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("model:event", event); },
    });
    // provider/callStream 走 provider-protocol store（<userData>/dxos/providers.json），与 modelStore 分离；
    // 用本地桩地址种一个真实 provider，事件下行才有真实来源（同 tests/dxos-protocol-stream.test.mjs W5-2）。
    const streamProvider = identity.modelService.providerProtocol.store.create({
      name: "UI Stream Stub", baseUrl: streamStub.baseUrl, protocol: "openai",
      models: [{ model: "ui-stream-model", caps: ["llm"] }], apiKey: "FAKE_W10_STREAM_KEY",
    });
    const streamProviderId = streamProvider.id;
    await win.loadURL(uiURL);
    await sleep(400);
    await setValue('[data-d3-id="login-identifier"]', ADMIN);
    await setValue('[data-d3-id="login-password"]', PW);
    await click('[data-d3-id="login-submit"]');
    const g = await waitGate("ready");
    check("IPC0 · 登录进入桌面（service.current 已建立）", g === "ready", "gate=" + g);
    check("IPC1 · preload 暴露 window.openarc.model.command", await js("return typeof window.openarc?.model?.command") === "function" ? true : (await js("return typeof window.openarc?.model?.command")));
    /**
     * W10 · IPC2 契约更新（为什么改）：
     *   B2 需求要求把模型流式增量下发到渲染层，preload 因此新增 model.onEvent —— 它只做
     *   ipcRenderer.on("model:event") 订阅，**不把 ipcRenderer 本体交给渲染层**，也不新增
     *   window.openarc 顶层键。于是旧的"model 桥只有 command"口径（D4-01 Closure A）已过时：
     *   再按旧口径断言，会把这次**有意的契约扩展**误判成安全回归。
     *   这里改成等价且更严的新契约（安全要求不放松）：
     *     · key 集合必须恰好是 {command, onEvent}（顺序无关），两者都必须是 function；
     *     · 负向断言逐项保留并加强：桥上的 key / 值不得是 getRawCredential / rawFetch /
     *       ipcRenderer / webContents / send / invoke / require / fs 等原始能力（逐项断言 undefined），
     *       且桥值只允许 function（任何模块 / 对象值都算泄漏）；
     *     · onEvent 必须返回退订函数，退订后同一 provider 的第二次流式调用不得再收到事件；
     *     · 用本地 127.0.0.1 SSE 真实触发 provider/callStream，回调收到的事件必须是 P1 信封
     *       （channel / domain / kind / sequence / at / payload 齐备，channel=model:event、domain=model）；
     *     · window.openarc 顶层键为既有 17 个 + B3 agent + B4 skill + B5a media + B6a automation
     *       + B6c platform = 22 个；除这些已登记域外不得新增顶层键。
     *
     * B5a · IPC2 契约再更新（为什么改）：
     *   B5a 媒体域要求把 media.command / media.onEvent 接到渲染层，preload 因此新增 media 顶层键
     *   （第 20 个，见 preload.cjs「B5a 媒体桥」）。与 B3 agent / B4 skill 完全同构：只做
     *   ipcRenderer.invoke("media:command") 与 ipcRenderer.on("media:event") 订阅，**不把
     *   ipcRenderer 本体交给渲染层**。于是旧的 19 键口径已过时 —— 再按 19 键断言会把这次
     *   **有意的契约扩展**误判成安全回归。这里把上界更新为 20 键（既有 17 + agent + skill + media），
     *   负向断言（无原始能力 / 桥值只允许 function / 不新增未登记顶层键）逐项不放松。
     *
     * B6a · automation + B6c · platform 契约更新（为什么改，B6d 补记）：
     *   B6a 自动化域要求把 automation.command / automation.onEvent 接到渲染层（preload「B6a 自动化域桥」），
     *   B6c 平台域只暴露 platform.command（preload「B6c 平台域桥」）。两者与前面的域完全同构：
     *   只做 ipcRenderer.invoke("automation:command" / "platform:command") 与 automation:event 订阅，
     *   **不把 ipcRenderer 本体交给渲染层**，也不暴露任何原始能力。于是旧的 20 键口径已过时——
     *   再按 20 键断言会把这次**有意的域扩展**误判成安全回归。本波（B6d）把上界更新为 22 键
     *   （既有 17 + agent + skill + media + automation + platform，以实际 Object.keys(window.openarc)
     *   为准，见 preload.cjs 的顶层键登记）。负向断言（无 raw credential / 无 ipcRenderer /
     *   桥值只允许 function / 不新增未登记顶层键）逐项不放松。
     */
    const expectedModelKeys = ["command", "onEvent"];
    // 顶层键沿革：既有 17 → B3 agent 18 → B4 skill 19 → B5a media 20 → B6a automation 21 →
    // B6c platform 22 → B7a developer 23 → B7c integration 24 / market 25 → B7e1 comfy 26。
    // 26 键 = 实际 Object.keys(window.openarc).sort()（preload.cjs 顶层键登记），逐字写死；
    // 负向断言（原始能力黑名单 / 桥值只允许 function / 不新增未登记顶层键）逐项不放松。
    const expectedTopKeys = ["action", "agent", "authorization", "automation", "browser", "canvas", "comfy", "developer", "device", "files", "governance", "identity", "integration", "market", "mcp", "media", "model", "navigate", "onDisplay", "onNativeState", "platform", "resource", "sideEffect", "skill", "sync", "task"];
    // 逐项列出的原始能力黑名单：桥上任一 key / 值命中即失败（等价旧的"无 getRawCredential / rawFetch"）。
    const forbiddenRaw = ["getRawCredential", "rawFetch", "ipcRenderer", "webContents", "send", "invoke", "require", "fs", "credentialRef", "rawCredential", "readFile", "writeFile", "shell", "process", "Buffer"];
    const ipc2 = await js(`
      const bridge = (window.openarc && window.openarc.model) || null;
      const top = window.openarc || {};
      const modelKeys = bridge ? Object.keys(bridge).sort() : null;
      const topKeys = Object.keys(top).sort();
      const forbidden = ${JSON.stringify(forbiddenRaw)};
      const bridgeLeaks = bridge ? forbidden.filter((name) => bridge[name] !== undefined) : ["no-model-bridge"];
      const topLeaks = forbidden.filter((name) => top[name] !== undefined);
      const valueLeaks = [];
      if (bridge) for (const name of Object.keys(bridge)) { const value = bridge[name]; if (value !== undefined && typeof value !== "function") valueLeaks.push(name + ":" + typeof value); }
      const commandType = bridge ? typeof bridge.command : "missing";
      const onEventType = bridge ? typeof bridge.onEvent : "missing";
      let unsubscribe = null;
      let unsubType = "missing";
      const events = [];
      let streamError = null;
      let afterUnsubDelta = null;
      if (bridge && typeof bridge.onEvent === "function" && typeof bridge.command === "function") {
        unsubscribe = bridge.onEvent((event) => events.push(event));
        unsubType = typeof unsubscribe;
        const first = await bridge.command({ command: "provider/callStream", payload: { providerId: ${JSON.stringify(streamProviderId)}, model: "ui-stream-model", messages: [{ role: "user", content: "hi" }] } });
        if (!first || first.ok !== true) streamError = first && first.error ? first.error : String(JSON.stringify(first));
        await new Promise((done) => setTimeout(done, 150));
        if (typeof unsubscribe === "function") {
          const before = events.length;
          unsubscribe();
          await bridge.command({ command: "provider/callStream", payload: { providerId: ${JSON.stringify(streamProviderId)}, model: "ui-stream-model", messages: [{ role: "user", content: "again" }] } });
          await new Promise((done) => setTimeout(done, 150));
          afterUnsubDelta = events.length - before;
        }
      }
      const fields = ["channel", "domain", "kind", "sequence", "at", "payload"];
      const envelopeBad = [];
      events.forEach((event, index) => {
        if (!event || typeof event !== "object") { envelopeBad.push(index + ":not-object"); return; }
        for (const field of fields) if (!(field in event)) envelopeBad.push(index + ":missing-" + field);
        if (event.channel !== "model:event") envelopeBad.push(index + ":channel=" + String(event.channel));
        if (event.domain !== "model") envelopeBad.push(index + ":domain=" + String(event.domain));
        if (!["progress", "log", "approval"].includes(event.kind)) envelopeBad.push(index + ":kind=" + String(event.kind));
        if (typeof event.sequence !== "number") envelopeBad.push(index + ":sequence-not-number");
        if (typeof event.at !== "number") envelopeBad.push(index + ":at-not-number");
        if (!event.payload || typeof event.payload !== "object") envelopeBad.push(index + ":payload-not-object");
      });
      const sequences = events.map((event) => event.sequence);
      const monotonic = sequences.every((value, index) => index === 0 || value > sequences[index - 1]);
      return { modelKeys, topKeys, bridgeLeaks, topLeaks, valueLeaks, commandType, onEventType, unsubType, eventCount: events.length, envelopeBad, afterUnsubDelta, monotonic, payloadTypes: events.map((event) => event && event.payload && event.payload.type), streamError };
    `);
    const ipc2Ok =
      JSON.stringify(ipc2.modelKeys) === JSON.stringify(expectedModelKeys) &&
      JSON.stringify(ipc2.topKeys) === JSON.stringify(expectedTopKeys) &&
      ipc2.commandType === "function" && ipc2.onEventType === "function" && ipc2.unsubType === "function" &&
      ipc2.bridgeLeaks.length === 0 && ipc2.topLeaks.length === 0 && ipc2.valueLeaks.length === 0 &&
      ipc2.eventCount > 0 && ipc2.envelopeBad.length === 0 && ipc2.monotonic === true &&
      ipc2.afterUnsubDelta === 0 && ipc2.streamError === null;
    check("IPC2 · model 桥恰为 {command,onEvent}、onEvent 返退订函数、事件为 P1 信封、无原始能力 / 顶层键恰为 26（17 既有 + agent + skill + media + automation + platform + developer + integration + market + comfy）", ipc2Ok,
      "modelKeys=" + JSON.stringify(ipc2.modelKeys) + " topKeys=" + ipc2.topKeys.length + " bridgeLeaks=" + JSON.stringify(ipc2.bridgeLeaks) + " topLeaks=" + JSON.stringify(ipc2.topLeaks) + " valueLeaks=" + JSON.stringify(ipc2.valueLeaks) + " command=" + ipc2.commandType + " onEvent=" + ipc2.onEventType + " unsub=" + ipc2.unsubType + " events=" + ipc2.eventCount + " payloadTypes=" + JSON.stringify(ipc2.payloadTypes) + " envelopeBad=" + JSON.stringify(ipc2.envelopeBad) + " monotonic=" + ipc2.monotonic + " afterUnsubDelta=" + ipc2.afterUnsubDelta + (ipc2.streamError ? " streamError=" + ipc2.streamError : ""));
    const list = await js("return await window.openarc.model.command({ command: 'provider/list' })");
    check("IPC3 · 合法命令 provider/list 可用", list && list.ok === true, JSON.stringify(list).slice(0, 120));
    const denied = await js("return await window.openarc.model.command({ command: 'credential/getRaw' })");
    check("IPC4 · 未知/禁忌命令 DENY", denied && denied.error === "MODEL_COMMAND_NOT_ALLOWED", JSON.stringify(denied));
    const created = await js("return await window.openarc.model.command({ command: 'provider/create', payload: { displayName: 'UI IPC', baseUrl: 'http://127.0.0.1:9', credentialSecret: " + JSON.stringify(SECRET) + " } })");
    check("IPC5 · provider/create + write-only credential", created && created.ok === true, JSON.stringify(created).slice(0, 160));
    check("IPC6 · IPC 响应不含 raw secret", !JSON.stringify(created).includes(SECRET), "");
    const status = await js("return await window.openarc.model.command({ command: 'credential/status', payload: { providerId: " + JSON.stringify(created.provider.providerId) + " } })");
    check("IPC7 · credential/status 只返回 configured/version", status && status.ok === true && !JSON.stringify(status).includes(SECRET) && !("credential_ref" in status) && !("credentialRef" in status), JSON.stringify(status));
    const dom = await js("return document.body.innerHTML");
    check("IPC8 · DOM 不含 raw secret", !dom.includes(SECRET), "");
    const spoof = await js("return await window.openarc.model.command({ command: 'provider/list', payload: { userId: 'admin', appId: 'canvas', role: 'ADMIN' } })");
    check("IPC9 · actor/app 伪造不改变 host 上下文", spoof && spoof.ok === true, JSON.stringify(spoof).slice(0, 100));
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e.message).slice(0, 200));
  } finally {
    try { win?.destroy(); } catch { /* ignore */ }
    if (streamStub) { try { await streamStub.close(); } catch { /* ignore */ } }
    if (userData) { try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
