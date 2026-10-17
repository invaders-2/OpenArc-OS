/**
 * B6c · 平台域 IPC 集成测试（全离线：假 ipcMain / 假 webContents，无 Electron、无网络）。
 *
 * 覆盖：
 *   ① trusted(sender) fail closed：缺 isTrusted / 伪造 sender 一律拒绝（且先于 bundle 判空）
 *   ② 未白名单命令被拒且无副作用
 *   ③ 命令体 command / type 两种写法
 *   ④ 身份边界：payload.userId / role 被忽略；identity.current 为空即未认证
 *   ⑤ bundle 未装配 → PLATFORM_NOT_READY；dispose 后可重复注册
 *   ⑥ preload 顶层键 platform（第 22 键）：只暴露 command，且是最后一个顶层键
 *   ⑦ src/types 契约声明 platform 桥
 *
 * 只读源：electron/platform-bootstrap.cjs、platform-service.cjs、platform-domain.cjs、preload.cjs。
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

const { createPlatformBundle } = require("../electron/platform-service.cjs");
const { registerPlatformIpc, disposePlatformIpc, PLATFORM_NOT_READY } = require("../electron/platform-bootstrap.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
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
  return {
    resolveActor({ context }) {
      return context && context.sessionRef ? { ok: true, user: { id: "u-platform" } } : { ok: false, error: "no-session" };
    },
  };
}

function openBundle(overrides = {}) {
  const dir = tempDir("dxos-platform-ipc-");
  const bundle = createPlatformBundle(Object.assign({
    userDataDir: dir,
    authorization: makeAuth(),
    appVersion: "9.9.9-test",
    clock: () => 1_700_000_000_000,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  }, overrides));
  return { dir, bundle, identity: { current: "sess-ipc" } };
}

// ── ① trusted fail closed ────────────────────────────────────────────────
test("trusted：缺 isTrusted / 伪造 sender 一律 Forbidden，且先于 bundle 判空", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerPlatformIpc({ ipcMain, bundle: fx.bundle, identity: fx.identity });
  await assert.rejects(() => ipcMain.invoke("platform:command", trustedEvent(), { command: "platform/health" }), /Forbidden/);

  disposePlatformIpc({ ipcMain });
  registerPlatformIpc({ ipcMain, bundle: null, isTrusted: trustedGate, identity: fx.identity });
  await assert.rejects(() => ipcMain.invoke("platform:command", fakeEvent(), { command: "platform/health" }), /Forbidden/);
  const notReady = await ipcMain.invoke("platform:command", trustedEvent(), { command: "platform/health" });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, PLATFORM_NOT_READY);
});

// ── ② / ③ 白名单与命令体 ─────────────────────────────────────────────────
test("白名单：未登记命令被拒、无需对象载荷、command / type 两种写法", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerPlatformIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: fx.identity });

  const bad = await ipcMain.invoke("platform:command", trustedEvent(), { command: "platform/nope" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "PLATFORM_COMMAND_NOT_ALLOWED");

  const notObject = await ipcMain.invoke("platform:command", trustedEvent(), "not-an-object");
  assert.equal(notObject.ok, false);
  assert.equal(notObject.error, "PLATFORM_INVALID_INPUT");

  const byCommand = await ipcMain.invoke("platform:command", trustedEvent(), { command: "platform/health", payload: {} });
  assert.equal(byCommand.ok, true, JSON.stringify(byCommand));
  assert.equal(byCommand.value.ok, true);
  assert.equal(byCommand.value.commands, 17);

  const byType = await ipcMain.invoke("platform:command", trustedEvent(), { type: "platform/health", payload: {} });
  assert.equal(byType.ok, true);
});

// ── ④ 身份边界 ───────────────────────────────────────────────────────────
test("身份边界：payload.userId 被忽略，actor 只从主进程 sessionRef 推导", async () => {
  const dir = tempDir("dxos-platform-ipc-auth-");
  const seen = [];
  const auth = {
    resolveActor({ context }) {
      seen.push(context && context.sessionRef);
      return context && context.sessionRef ? { ok: true, user: { id: "u-real" } } : { ok: false, error: "no-session" };
    },
  };
  const bundle = createPlatformBundle({ userDataDir: dir, authorization: auth, clock: () => 1_700_000_000_000, lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
  const ipcMain = makeIpcMain();
  registerPlatformIpc({ ipcMain, bundle, isTrusted: trustedGate, identity: { current: "sess-real" } });
  const res = await ipcMain.invoke("platform:command", trustedEvent(), { command: "platform/health", payload: { userId: "attacker", role: "SUPER_ADMIN", appId: "evil" } });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, ["sess-real"], "sessionRef 必须来自主进程注入，而不是 payload");

  disposePlatformIpc({ ipcMain });
  registerPlatformIpc({ ipcMain, bundle, isTrusted: trustedGate, identity: { current: null } });
  const unauth = await ipcMain.invoke("platform:command", trustedEvent(), { command: "platform/health", payload: {} });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.error, "PLATFORM_UNAUTHENTICATED");
});

// ── ⑤ dispose 后可重复注册 ───────────────────────────────────────────────
test("bootstrap：dispose 移除 handler，可重复注册", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerPlatformIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: fx.identity });
  assert.equal(ipcMain.handlers.has("platform:command"), true);
  disposePlatformIpc({ ipcMain });
  assert.equal(ipcMain.handlers.has("platform:command"), false);
  await assert.rejects(() => ipcMain.invoke("platform:command", trustedEvent(), { command: "platform/health" }), /NO_HANDLER/);
  registerPlatformIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: fx.identity });
  assert.equal(ipcMain.handlers.has("platform:command"), true);
});

// ── 网络判定经 IPC ───────────────────────────────────────────────────────
test("网络判定经 IPC：白名单命中 / 拒绝（假 DNS，离线）", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerPlatformIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: fx.identity });
  const hit = await ipcMain.invoke("platform:command", trustedEvent(), { command: "platform/network/evaluate", payload: { url: "https://api.example.com/v1", domains: ["api.example.com"] } });
  assert.equal(hit.ok, true);
  assert.equal(hit.value.allowed, true);
  const denied = await ipcMain.invoke("platform:command", trustedEvent(), { command: "platform/network/evaluate", payload: { url: "https://evil.example/v1", domains: ["api.example.com"] } });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "PLATFORM_FORBIDDEN");
});

// ── ⑥ preload 暴露面 ─────────────────────────────────────────────────────
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

test("preload：platform 是第 22 个顶层键，仅暴露 command，且无原始能力", () => {
  const exposed = loadPreloadSurface();
  assert.ok(exposed && exposed.name === "openarc");
  const api = exposed.api;
  const topKeys = Object.keys(api);
  assert.ok(topKeys.includes("platform"), "缺少顶层键 platform");
  // B7c 起在 platform 之后追加后续批次键（integration / market / …），故只固定 platform 的位置（第 22 键，index 21）。
  assert.ok(topKeys.length >= 22, "platform 至少是第 22 个顶层键（第 21 是 B6a automation）");
  assert.equal(topKeys.indexOf("platform"), 21);
  assert.deepEqual(Object.keys(api.platform), ["command"]);
  assert.equal(typeof api.platform.command, "function");
  // 负向断言：桥值只允许 function（以及既有 files 对象等复合桥），不允许原始 ipcRenderer
  assert.equal(typeof api.platform, "object");
  assert.equal(Object.prototype.hasOwnProperty.call(api.platform, "invoke"), false);
  void api;
});

test("src/types：声明 platform 桥形状（OpenArcPlatformBridge / platform?）", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "types", "openarc-ipc.d.ts"), "utf8");
  assert.ok(source.includes("OpenArcPlatformBridge"));
  assert.ok(source.includes("platform?: OpenArcPlatformBridge"));
  assert.ok(source.includes('"platform/network/evaluate"'));
});
