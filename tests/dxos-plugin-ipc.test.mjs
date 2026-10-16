/**
 * B7c · 集成域 / 本地市场 IPC 集成测试（全离线：假 ipcMain / 假 webContents，无 Electron、无网络）。
 *
 * 覆盖任务书验收点：
 *   ① trusted(sender) fail closed：缺 isTrusted / 伪造 sender 一律拒绝（且先于 bundle 判空）；
 *   ② 命令白名单：未登记命令在 bootstrap 层被拒，未知命令无副作用；
 *   ③ 身份边界：payload.userId / role / appId 被忽略，sessionRef 只来自主进程注入；
 *   ④ 未装配 → INTEGRATION_NOT_READY / MARKET_NOT_READY；dispose 后可重复注册；
 *   ⑤ preload 顶层键 integration 与 market：各只暴露 command，且无原始能力；
 *   ⑥ main.cjs 装配与 src/types 契约（源码级结构断言）。
 *
 * 只读源：electron/plugin-bootstrap.cjs、plugin-service.cjs、market-service.cjs、preload.cjs、main.cjs。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const { registerIntegrationIpc, disposeIntegrationIpc, registerMarketIpc, disposeMarketIpc, INTEGRATION_NOT_READY, MARKET_NOT_READY } = require("../electron/plugin-bootstrap.cjs");

function makeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    async invoke(channel, event, payload) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error("NO_HANDLER " + channel);
      return fn(event, payload);
    },
  };
}

const TRUSTED_SENDER = { id: "trusted-web-contents" };
const TRUSTED_URL = "file:///Application/OpenArc%20OS/index.html";
const trustedEvent = () => ({ sender: TRUSTED_SENDER, senderFrame: { url: TRUSTED_URL } });
const fakeEvent = () => ({ sender: { id: "evil" }, senderFrame: { url: "https://evil.example/" } });
const trustedGate = (event) => !!event && event.sender === TRUSTED_SENDER && !!event.senderFrame && event.senderFrame.url === TRUSTED_URL;

/** 记录 bootstrap 注入的 context；只白名单 integration/health。 */
function makeSpyBundle(channel) {
  const seen = [];
  return {
    seen,
    isIntegrationCommand: (command) => command === "integration/health",
    execute: async (command, payload, context) => { seen.push({ command, payload, context }); return { ok: true, value: { echo: command, contextSessionRef: context.sessionRef, payloadUserId: payload.userId } }; },
    // market 形态
    marketCommand: channel === "market:command",
  };
}

// ── ① trusted fail closed ────────────────────────────────────────────────
test("integration trusted：缺 isTrusted / 伪造 sender 一律 Forbidden，且先于 bundle 判空", async () => {
  const ipcMain = makeIpcMain();
  registerIntegrationIpc({ ipcMain, bundle: makeSpyBundle(), identity: { current: "s1" } });
  await assert.rejects(() => ipcMain.invoke("integration:command", trustedEvent(), { command: "integration/health" }), /Forbidden/);

  disposeIntegrationIpc({ ipcMain });
  registerIntegrationIpc({ ipcMain, bundle: null, isTrusted: trustedGate, identity: { current: "s1" } });
  await assert.rejects(() => ipcMain.invoke("integration:command", fakeEvent(), { command: "integration/health" }), /Forbidden/);
  const notReady = await ipcMain.invoke("integration:command", trustedEvent(), { command: "integration/health" });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, INTEGRATION_NOT_READY);
});

test("market trusted：缺 isTrusted / 伪造 sender 一律 Forbidden，且先于 bundle 判空", async () => {
  const ipcMain = makeIpcMain();
  registerMarketIpc({ ipcMain, bundle: makeSpyBundle("market:command"), identity: { current: "s1" } });
  await assert.rejects(() => ipcMain.invoke("market:command", trustedEvent(), { command: "market/health" }), /Forbidden/);

  disposeMarketIpc({ ipcMain });
  registerMarketIpc({ ipcMain, bundle: null, isTrusted: trustedGate, identity: { current: "s1" } });
  await assert.rejects(() => ipcMain.invoke("market:command", fakeEvent(), { command: "market/health" }), /Forbidden/);
  const notReady = await ipcMain.invoke("market:command", trustedEvent(), { command: "market/health" });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, MARKET_NOT_READY);
});

// ── ② 白名单 / 载荷 ───────────────────────────────────────────────────────
test("integration 白名单：非对象载荷与未登记命令在 bootstrap 层被拒", async () => {
  const ipcMain = makeIpcMain();
  const bundle = makeSpyBundle();
  registerIntegrationIpc({ ipcMain, bundle, isTrusted: trustedGate, identity: { current: "s1" } });

  const notObject = await ipcMain.invoke("integration:command", trustedEvent(), "nope");
  assert.equal(notObject.error, "INTEGRATION_INVALID_INPUT");

  const denied = await ipcMain.invoke("integration:command", trustedEvent(), { command: "integration/nope" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "INTEGRATION_COMMAND_NOT_ALLOWED");
  assert.deepEqual(bundle.seen, [], "未登记命令不得进入 bundle.execute");

  const viaType = await ipcMain.invoke("integration:command", trustedEvent(), { type: "integration/health", payload: {} });
  assert.equal(viaType.ok, true);
  assert.equal(bundle.seen.length, 1);
  assert.equal(bundle.seen[0].command, "integration/health");
});

// ── ③ 身份边界 ────────────────────────────────────────────────────────────
test("身份边界：sessionRef / appId 来自主进程，payload.userId / role / appId 被忽略；未认证即拒绝", async () => {
  const ipcMain = makeIpcMain();
  const bundle = makeSpyBundle();
  registerIntegrationIpc({ ipcMain, bundle, isTrusted: trustedGate, identity: { current: "sess-real" } });
  const res = await ipcMain.invoke("integration:command", trustedEvent(), { command: "integration/health", payload: { userId: "attacker", role: "SUPER_ADMIN", appId: "evil" } });
  assert.equal(res.ok, true);
  assert.equal(bundle.seen[0].context.sessionRef, "sess-real");
  assert.equal(bundle.seen[0].context.appId, "ai");
  assert.equal(res.value.contextSessionRef, "sess-real", "身份只认主进程注入的 sessionRef");
  assert.equal(res.value.payloadUserId, "attacker", "payload 原样透传，但不参与身份判定");

  disposeIntegrationIpc({ ipcMain });
  const realBundle = require("../electron/plugin-service.cjs").createPluginBundle({ userDataDir: fs.mkdtempSync(path.join(require("node:os").tmpdir(), "dxos-ipc-")), safeStorage: null });
  registerIntegrationIpc({ ipcMain, bundle: realBundle, isTrusted: trustedGate, identity: { current: null } });
  const unauth = await ipcMain.invoke("integration:command", trustedEvent(), { command: "integration/health", payload: { userId: "attacker" } });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.error, "INTEGRATION_UNAUTHENTICATED");
});

// ── ④ dispose ─────────────────────────────────────────────────────────────
test("bootstrap：dispose 移除两条 handler，可重复注册", async () => {
  const ipcMain = makeIpcMain();
  registerIntegrationIpc({ ipcMain, bundle: makeSpyBundle(), isTrusted: trustedGate, identity: { current: "s1" } });
  registerMarketIpc({ ipcMain, bundle: makeSpyBundle("market:command"), isTrusted: trustedGate, identity: { current: "s1" } });
  assert.equal(ipcMain.handlers.has("integration:command"), true);
  assert.equal(ipcMain.handlers.has("market:command"), true);
  disposeIntegrationIpc({ ipcMain });
  disposeMarketIpc({ ipcMain });
  assert.equal(ipcMain.handlers.has("integration:command"), false);
  assert.equal(ipcMain.handlers.has("market:command"), false);
  await assert.rejects(() => ipcMain.invoke("integration:command", trustedEvent(), { command: "integration/health" }), /NO_HANDLER/);
  registerIntegrationIpc({ ipcMain, bundle: makeSpyBundle(), isTrusted: trustedGate, identity: { current: "s1" } });
  assert.equal(ipcMain.handlers.has("integration:command"), true);
});

// ── ⑤ preload 暴露面 ──────────────────────────────────────────────────────
function loadPreloadSurface() {
  const preloadPath = path.join(ROOT, "electron", "preload.cjs");
  const source = fs.readFileSync(preloadPath, "utf8");
  let exposed = null;
  const electronStub = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed = { name, api }; } },
    ipcRenderer: { invoke: async () => ({}), on: () => {}, removeListener: () => {} },
    webUtils: { getPathForFile: () => null },
  };
  const sandbox = {
    require: (id) => { if (id === "electron") return electronStub; throw new Error("unexpected require: " + id); },
    module: { exports: {} }, exports: {}, console, process, Buffer,
    __dirname: path.dirname(preloadPath), __filename: preloadPath,
  };
  vm.runInNewContext(source, sandbox, { filename: preloadPath });
  return exposed;
}

test("preload：新增 integration / market 两个顶层键，各只暴露 command，platform 仍在第 22 键", () => {
  const exposed = loadPreloadSurface();
  assert.ok(exposed && exposed.name === "openarc");
  const api = exposed.api;
  const topKeys = Object.keys(api);
  assert.equal(topKeys.indexOf("platform"), 21, "platform 仍是第 22 个顶层键");
  // B7f：固定 index、允许其后继续追加（不再断言"最后一个顶层键"）。
  assert.equal(topKeys.indexOf("integration"), 23, "integration 固定在第 24 个顶层键（index 23）");
  assert.equal(topKeys.indexOf("market"), 24, "market 固定在第 25 个顶层键（index 24）");
  // B7i：ComfyUI 已从移植范围移除 —— comfy 顶层键不存在，market 之后不再有键。
  assert.equal(Object.prototype.hasOwnProperty.call(api, "comfy"), false, "comfy 顶层键必须不存在（B7i 移除）");
  // 合并 ui-core 后 market 之后追加了 10-15 的 4 个本地能力键（video / image / system / weather）。
  assert.deepEqual(topKeys.slice(25), ["video", "image", "system", "weather"], "market 之后只允许 10-15 的 4 个本地能力键");
  for (const key of ["integration", "market"]) {
    assert.deepEqual(Object.keys(api[key]), ["command"], key + " 只允许 command");
    assert.equal(typeof api[key].command, "function");
    assert.equal(Object.prototype.hasOwnProperty.call(api[key], "invoke"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(api[key], "onEvent"), false);
  }
  assert.ok(api.integration.command({ command: "integration/health" }) instanceof Promise);
  assert.ok(api.market.command({ command: "market/health" }) instanceof Promise);
});

// ── ⑥ main 装配与类型契约 ─────────────────────────────────────────────────
test("main.cjs：装配 createPluginBundle / createMarketBundle 与两条 register*，且均过 trusted", () => {
  const main = fs.readFileSync(path.join(ROOT, "electron", "main.cjs"), "utf8");
  assert.ok(main.includes('require("./plugin-service.cjs")'));
  assert.ok(main.includes('require("./market-service.cjs")'));
  assert.ok(main.includes("createPluginBundle({"));
  assert.ok(main.includes("createMarketBundle({"));
  assert.ok(main.includes("registerIntegrationIpc({"));
  assert.ok(main.includes("registerMarketIpc({"));
  assert.ok(main.includes("isTrusted: trusted"), "两条通道都必须挂宿主 trusted");
  const code = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal(/api\.dx-os\.com/.test(code), false, "main.cjs 不得接入云市场地址（注释里的 OUT 说明不算）");
});

test("plugin-bootstrap.cjs：真实注册 integration:command 与 market:command", () => {
  const source = fs.readFileSync(path.join(ROOT, "electron", "plugin-bootstrap.cjs"), "utf8");
  assert.ok(source.includes('ipcMain.handle("integration:command"'));
  assert.ok(source.includes('ipcMain.handle("market:command"'));
  assert.ok(source.includes("isTrusted(event)"));
  assert.ok(!source.includes("api.dx-os.com"));
});

test("src/types：声明 integration / market 的命令与结果形状", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "types", "openarc-ipc.d.ts"), "utf8");
  assert.ok(source.includes("OpenArcIntegrationCommandRequest"));
  assert.ok(source.includes("OpenArcIntegrationPluginHealth"));
  assert.ok(source.includes("integration?: OpenArcIntegrationBridge"));
  assert.ok(source.includes('"integration/plugins/enable"'));
  assert.ok(source.includes('"integration/weather/query"'));
  assert.ok(source.includes("OpenArcMarketCommandRequest"));
  assert.ok(source.includes("market?: OpenArcMarketBridge"));
  assert.ok(source.includes('"market/apps/list"'));
  assert.ok(source.includes('"market/skillpacks/list"'));
});
