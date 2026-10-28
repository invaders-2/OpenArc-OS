/**
 * B7a · 开发者平台 IPC 集成测试（全离线：假 ipcMain / 假 webContents，无 Electron、无网络）。
 *
 * 覆盖：
 *   ① trusted(sender) fail closed：缺 isTrusted / 伪造 sender 一律拒绝（且先于 bundle 判空）
 *   ② 未装配 bundle → DEVELOPER_NOT_READY；dispose 后可重复注册
 *   ③ 白名单：未登记命令被拒；command / type 两种写法；非对象载荷稳定 INVALID_INPUT
 *   ④ 身份边界：payload.userId / role / appId 被忽略；identity.current 为空即未认证
 *   ⑤ 返回值脱敏：安装 / 查询结果不含绝对路径；凭据绑定只回元数据
 *   ⑥ preload 顶层键 developer（第 23 键，index 22）：只暴露 command；其后允许后续批次继续追加
 *   ⑦ src/types 契约声明 developer 桥与命令
 *
 * 只读源：electron/developer-{domain,service,bootstrap}.cjs、preload.cjs。
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const { IdentityStore } = require("../electron/identity-store.cjs");
const { writeZip } = require("../electron/canvas-dxos-zip.cjs");
const developerDomain = require("../electron/developer-domain.cjs");
const { createDeveloperBundle } = require("../electron/developer-service.cjs");
const { registerDeveloperIpc, disposeDeveloperIpc, DEVELOPER_NOT_READY } = require("../electron/developer-bootstrap.cjs");

const tmpDirs = [];
const openStores = [];
afterEach(() => { while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } } });
after(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

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

function makeAuth() {
  return { resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: "u-developer" } } : { ok: false, error: "no-session" }) };
}

function demoPackage() {
  return writeZip([
    { name: "dx-app.json", data: Buffer.from(JSON.stringify({ format: "dx-app/v2", id: "demo", name: "Demo App", description: "a demo developer application", version: "1.0.0", build: 1, network: { domains: ["api.example.com"] } })) },
    { name: "index.html", data: Buffer.from("<html><body>demo</body></html>") },
  ]);
}

function openBundle(overrides = {}) {
  const dir = tempDir("dxos-developer-ipc-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(store);
  const bundle = createDeveloperBundle(Object.assign({
    userDataDir: dir,
    identityStore: store,
    authorization: makeAuth(),
    clock: () => 1_700_000_000_000,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => "application/json" }, arrayBuffer: async () => Buffer.from("{}") }),
  }, overrides));
  return { dir, store, bundle, identity: { current: "sess-ipc" } };
}

// ── ① trusted fail closed ────────────────────────────────────────────────
test("trusted：缺 isTrusted / 伪造 sender 一律 Forbidden，且先于 bundle 判空", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerDeveloperIpc({ ipcMain, bundle: fx.bundle, identity: fx.identity });
  await assert.rejects(() => ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/health" }), /Forbidden/);

  disposeDeveloperIpc({ ipcMain });
  registerDeveloperIpc({ ipcMain, bundle: null, isTrusted: trustedGate, identity: fx.identity });
  await assert.rejects(() => ipcMain.invoke("developer:command", fakeEvent(), { command: "developer/health" }), /Forbidden/);
  const notReady = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/health" });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, DEVELOPER_NOT_READY);
});

// ── ② / ③ 白名单与命令体 ─────────────────────────────────────────────────
test("白名单：未登记命令被拒、非对象载荷 INVALID_INPUT、command / type 两种写法", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerDeveloperIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: fx.identity });

  const bad = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/nope" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, developerDomain.DEVELOPER_ERR_COMMAND_NOT_ALLOWED);

  const notObject = await ipcMain.invoke("developer:command", trustedEvent(), "not-an-object");
  assert.equal(notObject.ok, false);
  assert.equal(notObject.error, developerDomain.DEVELOPER_ERR_INVALID_INPUT);

  const byCommand = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/health", payload: {} });
  assert.equal(byCommand.ok, true, JSON.stringify(byCommand));
  // B7h：这里 registerDeveloperIpc 没传 domainExtensions，实际只可达 16 条基座命令；
  // 静态白名单 70 条仍可在 declaredCommands 对照（不再用白名单长度冒充可达数）。
  assert.equal(byCommand.value.commands, 16);
  assert.equal(byCommand.value.declaredCommands, 70);
  assert.equal(byCommand.value.degraded, true);
  assert.deepEqual(byCommand.value.extensions, { lab: "missing", collab: "missing", migrations: "missing", realtime: "missing" });

  const byType = await ipcMain.invoke("developer:command", trustedEvent(), { type: "developer/health", payload: {} });
  assert.equal(byType.ok, true);
});

// ── ④ 身份边界 ───────────────────────────────────────────────────────────
test("身份边界：payload.userId 被忽略，actor 只从主进程 sessionRef 推导；空会话未认证", async () => {
  const dir = tempDir("dxos-developer-ipc-auth-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(store);
  const seen = [];
  const auth = {
    resolveActor({ context }) {
      seen.push(context && context.sessionRef);
      return context && context.sessionRef ? { ok: true, user: { id: "u-real" } } : { ok: false, error: "no-session" };
    },
  };
  const bundle = createDeveloperBundle({ userDataDir: dir, identityStore: store, authorization: auth, clock: () => 1_700_000_000_000 });
  const ipcMain = makeIpcMain();
  registerDeveloperIpc({ ipcMain, bundle, isTrusted: trustedGate, identity: { current: "sess-real" } });
  const res = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/health", payload: { userId: "attacker", role: "SUPER_ADMIN", appId: "evil" } });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, ["sess-real"], "sessionRef 必须来自主进程注入，而不是 payload");

  disposeDeveloperIpc({ ipcMain });
  registerDeveloperIpc({ ipcMain, bundle, isTrusted: trustedGate, identity: { current: null } });
  const unauth = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/health", payload: {} });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.error, developerDomain.DEVELOPER_ERR_UNAUTHENTICATED);
});

// ── ⑤ dispose 后可重复注册 ───────────────────────────────────────────────
test("bootstrap：dispose 移除 handler，可重复注册", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerDeveloperIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: fx.identity });
  assert.equal(ipcMain.handlers.has("developer:command"), true);
  disposeDeveloperIpc({ ipcMain });
  assert.equal(ipcMain.handlers.has("developer:command"), false);
  await assert.rejects(() => ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/health" }), /NO_HANDLER/);
  registerDeveloperIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: fx.identity });
  assert.equal(ipcMain.handlers.has("developer:command"), true);
});

// ── ⑥ 装载经 IPC + 返回值脱敏 ───────────────────────────────────────────
test("经 IPC 装载：返回值含版本与启用状态，且绝不含绝对路径 / 密钥", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerDeveloperIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: fx.identity });
  const installed = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/install", payload: { package: demoPackage().toString("base64"), sourceName: "demo.zip" } });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.value.appId, "dev-demo");
  assert.equal(installed.value.enabled, true);
  assert.equal(JSON.stringify(installed).includes(fx.dir), false, "安装结果不得带绝对路径");

  const got = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/get", payload: { appId: "dev-demo" } });
  assert.equal(got.ok, true);
  assert.equal(got.value.manifest.version, "1.0.0");
  assert.equal(JSON.stringify(got).includes(fx.dir), false, "查询结果不得带绝对路径");

  const bound = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/credential/bind", payload: { appId: "dev-demo", bindingId: "acme", providerId: "dxprov.acme", authType: "api-key-header", headerName: "X-Api-Key" } });
  assert.equal(bound.ok, true);
  assert.equal(JSON.stringify(bound).includes("secret"), false);
  assert.equal(bound.value.headerName, "x-api-key");
});

// ── ⑦ preload 暴露面 ─────────────────────────────────────────────────────
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
    module: { exports: {} },
    exports: {},
    console,
    process,
    Buffer,
    __dirname: path.dirname(preloadPath),
    __filename: preloadPath,
  };
  vm.runInNewContext(source, sandbox, { filename: preloadPath });
  return exposed;
}

test("preload：developer 紧跟 platform，仅暴露 command", () => {
  const exposed = loadPreloadSurface();
  assert.ok(exposed && exposed.name === "openarc");
  const api = exposed.api;
  const topKeys = Object.keys(api);
  assert.ok(topKeys.includes("developer"), "缺少顶层键 developer");
  assert.equal(topKeys.indexOf("developer"), topKeys.indexOf("platform") + 1, "developer 必须紧跟 platform");
  assert.deepEqual(Object.keys(api.developer), ["command"]);
  assert.equal(typeof api.developer.command, "function");
  assert.equal(typeof api.developer, "object");
  assert.equal(Object.prototype.hasOwnProperty.call(api.developer, "invoke"), false);
});

test("src/types：声明 developer 桥形状与命令白名单", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "types", "openarc-ipc.d.ts"), "utf8");
  assert.ok(source.includes("OpenArcDeveloperBridge"));
  assert.ok(source.includes("developer?: OpenArcDeveloperBridge"));
  assert.ok(source.includes('"developer/install"'));
  assert.ok(source.includes('"developer/rollback"'));
  assert.ok(source.includes('"developer/network/request"'));
});
