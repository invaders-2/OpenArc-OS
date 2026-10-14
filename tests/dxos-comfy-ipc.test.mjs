/**
 * B7e1 · ComfyUI IPC 集成测试（全离线：假 ipcMain / 假 webContents，无 Electron、无网络）。
 *
 * 覆盖任务书 item 3 / 4：
 *   · trusted(sender) fail closed：缺 isTrusted / 伪造 sender 一律拒绝（且先于 bundle 判空）；
 *   · 命令白名单：未登记命令在 bootstrap 层被拒，未知命令无副作用；
 *   · 身份边界：payload.userId / role / appId 被忽略，sessionRef 只来自主进程注入；
 *   · comfy:event P1 信封（六字段 + sequence 单调）；
 *   · 未装配 → COMFY_NOT_READY；dispose 后可重复注册；
 *   · preload 顶层键 comfy（追加在末尾，不重排既有键）；main.cjs 装配；src/types 契约；
 *   · 返回值脱敏（绝对路径不出主进程）。
 *
 * 只读源：electron/comfy-bootstrap.cjs、comfy-service.cjs、comfy-domain.cjs、preload.cjs、main.cjs。
 */
import { test, after } from "node:test";
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

const comfyDomain = require("../electron/comfy-domain.cjs");
const { createComfyBundle } = require("../electron/comfy-service.cjs");
const { registerComfyIpc, disposeComfyIpc, wireComfyEvents, COMFY_NOT_READY } = require("../electron/comfy-bootstrap.cjs");

const tmpDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
after(() => { while (tmpDirs.length) { try { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* 忽略 */ } } });

/** 假 ipcMain：只需要 handle / removeHandler，与 electron/comfy-bootstrap.cjs 的用法一致。 */
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

function makeSpyBundle() {
  const seen = [];
  return {
    seen,
    isComfyCommand: (command) => command === "comfy/health",
    execute: async (command, payload, context) => {
      seen.push({ command, payload, context });
      return { ok: true, value: { echo: command, contextSessionRef: context.sessionRef, payloadUserId: payload.userId } };
    },
  };
}

function openBundle() {
  const dir = tempDir("dxos-comfy-ipc-");
  const bundle = createComfyBundle({ userDataDir: dir, env: {}, runner: { start: () => { throw new Error("must not start"); }, cancelAll: () => 0 } });
  return { dir, bundle };
}

// ── ① trusted fail closed ────────────────────────────────────────────────
test("comfy trusted：缺 isTrusted / 伪造 sender 一律 Forbidden，且先于 bundle 判空", async () => {
  const ipcMain = makeIpcMain();
  registerComfyIpc({ ipcMain, bundle: makeSpyBundle(), identity: { current: "s1" } });
  await assert.rejects(() => ipcMain.invoke("comfy:command", trustedEvent(), { command: "comfy/health" }), /Forbidden/);

  disposeComfyIpc({ ipcMain });
  registerComfyIpc({ ipcMain, bundle: null, isTrusted: trustedGate, identity: { current: "s1" } });
  await assert.rejects(() => ipcMain.invoke("comfy:command", fakeEvent(), { command: "comfy/health" }), /Forbidden/);
  const notReady = await ipcMain.invoke("comfy:command", trustedEvent(), { command: "comfy/health" });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, COMFY_NOT_READY);
});

// ── ② 白名单 / 载荷 ───────────────────────────────────────────────────────
test("comfy 白名单：非对象载荷与未登记命令在 bootstrap 层被拒，command / type 两种写法都认", async () => {
  const ipcMain = makeIpcMain();
  const bundle = makeSpyBundle();
  registerComfyIpc({ ipcMain, bundle, isTrusted: trustedGate, identity: { current: "s1" } });

  const notObject = await ipcMain.invoke("comfy:command", trustedEvent(), "nope");
  assert.equal(notObject.error, "COMFY_INVALID_INPUT");

  const denied = await ipcMain.invoke("comfy:command", trustedEvent(), { command: "comfy/nope" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "COMFY_COMMAND_NOT_ALLOWED");
  assert.deepEqual(bundle.seen, [], "未登记命令不得进入 bundle.execute");

  const viaType = await ipcMain.invoke("comfy:command", trustedEvent(), { type: "comfy/health", payload: {} });
  assert.equal(viaType.ok, true);
  assert.equal(bundle.seen.length, 1);
  assert.equal(bundle.seen[0].command, "comfy/health");
});

// ── ③ 身份边界 ────────────────────────────────────────────────────────────
test("身份边界：sessionRef / appId 来自主进程，payload.userId / role / appId 被忽略；未认证即拒绝", async () => {
  const ipcMain = makeIpcMain();
  const bundle = makeSpyBundle();
  registerComfyIpc({ ipcMain, bundle, isTrusted: trustedGate, identity: { current: "sess-real" } });
  const res = await ipcMain.invoke("comfy:command", trustedEvent(), { command: "comfy/health", payload: { userId: "attacker", role: "SUPER_ADMIN", appId: "evil" } });
  assert.equal(res.ok, true);
  assert.equal(bundle.seen[0].context.sessionRef, "sess-real");
  assert.equal(bundle.seen[0].context.appId, "ai");
  assert.equal(res.value.contextSessionRef, "sess-real", "身份只认主进程注入的 sessionRef");
  assert.equal(res.value.payloadUserId, "attacker", "payload 原样透传，但不参与身份判定");

  disposeComfyIpc({ ipcMain });
  const fx = openBundle();
  registerComfyIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: { current: null } });
  const unauth = await ipcMain.invoke("comfy:command", trustedEvent(), { command: "comfy/health", payload: { userId: "attacker" } });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.error, "COMFY_UNAUTHENTICATED");
});

// ── ④ comfy:event 信封 ───────────────────────────────────────────────────
test("comfy:event：P1 六字段与 sequence 单调，wireComfyEvents 注入 sink", async () => {
  const ipcMain = makeIpcMain();
  const fx = openBundle();
  const events = [];
  registerComfyIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: { current: "s1" }, send: (event) => events.push(event) });
  await ipcMain.invoke("comfy:command", trustedEvent(), { command: "comfy/health", payload: {} });
  assert.equal(events.length, 2, "每次命令 begin + completed 各一条");
  let last = 0;
  for (const event of events) {
    assert.equal(event.channel, "comfy:event");
    assert.equal(event.domain, "comfy");
    assert.equal(event.kind, "progress");
    assert.equal(typeof event.at, "number");
    assert.ok(event.sequence > last, "sequence 必须单调递增");
    last = event.sequence;
    assert.equal(typeof event.payload, "object");
  }
  assert.deepEqual(events.map((event) => event.payload.phase), ["begin", "completed"]);
  assert.equal(wireComfyEvents({ bundle: fx.bundle, send: () => {} }), true);
  assert.equal(wireComfyEvents({ bundle: null, send: () => {} }), false);
});

// ── ⑤ 脱敏 ───────────────────────────────────────────────────────────────
test("返回值：IPC 出口不含绝对路径", async () => {
  const ipcMain = makeIpcMain();
  const fx = openBundle();
  fx.bundle.store.saveConfig({ rootDir: fx.dir });
  registerComfyIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: { current: "s1" }, send: () => {} });
  const res = await ipcMain.invoke("comfy:command", trustedEvent(), { command: "comfy/dependencies/probe", payload: {} });
  assert.equal(res.ok, true);
  assert.equal(JSON.stringify(res).includes(fx.dir), false, "绝对路径必须脱敏成 <path>");
  assert.equal(JSON.stringify(res).includes(os.tmpdir()), false);
});

// ── ⑥ dispose ─────────────────────────────────────────────────────────────
test("bootstrap：dispose 移除 handler，可重复注册", async () => {
  const ipcMain = makeIpcMain();
  registerComfyIpc({ ipcMain, bundle: makeSpyBundle(), isTrusted: trustedGate, identity: { current: "s1" } });
  assert.equal(ipcMain.handlers.has("comfy:command"), true);
  disposeComfyIpc({ ipcMain });
  assert.equal(ipcMain.handlers.has("comfy:command"), false);
  await assert.rejects(() => ipcMain.invoke("comfy:command", trustedEvent(), { command: "comfy/health" }), /NO_HANDLER/);
  registerComfyIpc({ ipcMain, bundle: makeSpyBundle(), isTrusted: trustedGate, identity: { current: "s1" } });
  assert.equal(ipcMain.handlers.has("comfy:command"), true);
  assert.equal(comfyDomain.listComfyCommands().length, 24);
});

// ── ⑦ preload 暴露面 ──────────────────────────────────────────────────────
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

test("preload：comfy 固定在第 26 个顶层键（index 25），只有 command / onEvent，其后允许追加", () => {
  const exposed = loadPreloadSurface();
  assert.ok(exposed && exposed.name === "openarc");
  const api = exposed.api;
  const topKeys = Object.keys(api);
  assert.equal(topKeys.indexOf("comfy"), 25, "comfy 必须是第 26 个顶层键（index 25）");
  assert.equal(topKeys.indexOf("platform"), 21, "platform 仍是第 22 个顶层键");
  assert.ok(topKeys.indexOf("integration") > topKeys.indexOf("platform"));
  assert.ok(topKeys.indexOf("market") > topKeys.indexOf("integration"));
  assert.ok(topKeys.indexOf("comfy") > topKeys.indexOf("market"));
  assert.deepEqual(Object.keys(api.comfy), ["command", "onEvent"]);
  assert.equal(typeof api.comfy.command, "function");
  assert.equal(typeof api.comfy.onEvent, "function");
  assert.equal(Object.prototype.hasOwnProperty.call(api.comfy, "invoke"), false);
  assert.ok(api.comfy.command({ command: "comfy/health" }) instanceof Promise);
});

// ── ⑧ main 装配与类型契约 ─────────────────────────────────────────────────
test("main.cjs：装配 createComfyBundle 与 registerComfyIpc，且过 trusted", () => {
  const main = fs.readFileSync(path.join(ROOT, "electron", "main.cjs"), "utf8");
  assert.ok(main.includes('require("./comfy-service.cjs")'));
  assert.ok(main.includes('require("./comfy-bootstrap.cjs")'));
  assert.ok(main.includes("createComfyBundle({"));
  assert.ok(main.includes("registerComfyIpc({"));
  assert.ok(main.includes("isTrusted: trusted"), "comfy:command 必须挂宿主 trusted");
  const code = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal(/api\.dx-os\.com/.test(code), false, "main.cjs 不得接入云端 ComfyUI / 云市场地址（注释里的 OUT 说明不算）");
});

test("comfy-bootstrap.cjs：真实注册 comfy:command，无云地址", () => {
  const source = fs.readFileSync(path.join(ROOT, "electron", "comfy-bootstrap.cjs"), "utf8");
  assert.ok(source.includes('ipcMain.handle("comfy:command"'));
  assert.ok(source.includes("isTrusted(event)"));
  assert.ok(!source.includes("api.dx-os.com"));
});

test("src/types：声明 comfy 命令 / 请求 / 依赖形状与桥键", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "types", "openarc-ipc.d.ts"), "utf8");
  assert.ok(source.includes("OpenArcComfyCommandRequest"));
  assert.ok(source.includes("OpenArcComfyDependency"));
  assert.ok(source.includes("OpenArcComfyBridge"));
  assert.ok(source.includes("comfy?: OpenArcComfyBridge"));
  assert.ok(source.includes('"comfy/run/start"'));
  assert.ok(source.includes('"comfy/instances/start"'));
  assert.ok(source.includes('"comfy/workflows/import"'));
  assert.ok(source.includes('"comfy/dependencies/probe"'));
});

test("comfy-domain：失败码稳定，缺依赖 / 关闭 / 工作流非法各有专码", () => {
  assert.equal(comfyDomain.COMFY_ERR_DEPENDENCY_UNAVAILABLE, "COMFY_DEPENDENCY_UNAVAILABLE");
  assert.equal(comfyDomain.COMFY_ERR_INTEGRATION_UNAVAILABLE, "INTEGRATION_UNAVAILABLE");
  assert.equal(comfyDomain.COMFY_ERR_WORKFLOW_INVALID, "COMFY_WORKFLOW_INVALID");
  const unavailable = comfyDomain.comfyDependencyUnavailable("comfy.python", "缺 Python", { missing: ["comfy.python"], install: "装 Python" });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, "COMFY_DEPENDENCY_UNAVAILABLE");
  assert.deepEqual(unavailable.detail.missing, ["comfy.python"]);
  assert.equal(unavailable.detail.install, "装 Python");
  const disabled = comfyDomain.comfyDisabled();
  assert.equal(disabled.error, "INTEGRATION_UNAVAILABLE");
  assert.match(String(disabled.detail), /默认关闭/);
});

test("桥接命令：install 落到 main.py 旁 custom_nodes，archive 回可解压 ZIP（路径脱敏）", async () => {
  const dir = tempDir("dxos-comfy-bridge-cmd-");
  const root = path.join(dir, "comfy");
  fs.mkdirSync(root, { recursive: true });
  const mainPath = path.join(root, "main.py");
  fs.writeFileSync(mainPath, "# comfyui main\n");
  const bundle = createComfyBundle({ userDataDir: dir, env: {}, runner: { start: () => { throw new Error("must not start"); }, cancelAll: () => 0 } });
  bundle.store.saveConfig({ rootDir: root, mainPath });
  const install = await bundle.execute("comfy/bridge/install", {}, { sessionRef: "sess-comfy" });
  assert.equal(install.ok, true, JSON.stringify(install));
  assert.equal(fs.existsSync(path.join(root, "custom_nodes", "dx_os_bridge", "__init__.py")), true);
  assert.equal(install.value.path, "<path>", "绝对路径必须脱敏");
  const archive = await bundle.execute("comfy/bridge/archive", {}, { sessionRef: "sess-comfy" });
  assert.equal(archive.ok, true);
  assert.equal(archive.value.fileName, "dx-os-comfy-bridge.zip");
  assert.equal(Buffer.from(archive.value.base64, "base64").slice(0, 2).toString(), "PK");
  assert.equal(JSON.stringify(archive).includes(dir), false);
});

test("comfy-bridge.cjs：桥接扩展随包可安装且可打包（只读源逐字内嵌）", () => {
  const bridge = require("../electron/comfy-bridge.cjs");
  assert.match(bridge.COMFY_BRIDGE_INIT_PY, /WEB_DIRECTORY/);
  assert.match(bridge.COMFY_BRIDGE_JS, /app\.registerExtension/);
  const dir = tempDir("dxos-comfy-bridge-");
  const installed = bridge.installComfyBridgeForMainPath(path.join(dir, "ComfyUI", "main.py"));
  assert.equal(fs.existsSync(path.join(installed.path, "__init__.py")), true);
  assert.equal(fs.existsSync(path.join(installed.path, "web", "dx-os-bridge.js")), true);
  assert.equal(installed.changed, true);
  assert.equal(bridge.installComfyBridgeForMainPath(path.join(dir, "ComfyUI", "main.py")).changed, false, "内容未变不重复写盘");
  const zip = bridge.comfyBridgeArchive();
  assert.equal(Buffer.isBuffer(zip), true);
  assert.equal(zip.slice(0, 2).toString(), "PK");
});
