/**
 * B5a · 媒体域 IPC 集成测试（全离线：假 ipcMain / 假 webContents，无 Electron、无网络）。
 *
 * 覆盖：
 *   ① trusted(sender) fail closed：缺 isTrusted / 伪造 sender 一律拒绝（且先于 bundle 判空）
 *   ② 未白名单命令被拒且无副作用
 *   ③ 命令体 command / type 两种写法
 *   ④ media:event 信封（P1 六字段）与 sequence 单调
 *   ⑤ 返回值无绝对路径
 *   ⑥ bundle 未装配 → MEDIA_NOT_READY；dispose 后可重复注册
 *   ⑦ payload.userId 被忽略：actor 只从主进程注入的 sessionRef 推导
 *
 * 只读源：electron/media-bootstrap.cjs、media-service.cjs、media-domain.cjs、dxos-foundation-events.cjs。
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { IdentityStore } = require("../electron/identity-store.cjs");
const mediaStore = require("../electron/media-store.cjs");
const mediaDomain = require("../electron/media-domain.cjs");
const { createMediaBundle } = require("../electron/media-service.cjs");
const { registerMediaIpc, disposeMediaIpc, MEDIA_NOT_READY } = require("../electron/media-bootstrap.cjs");

const tmpDirs = [];
const openStores = [];
afterEach(() => {
  mediaStore.resetMediaStoreForTests();
  while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } }
});
after(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** 假 ipcMain：只需要 handle / removeHandler，与 electron/media-bootstrap.cjs:37 的用法一致。 */
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
      return context && context.sessionRef
        ? { ok: true, user: { id: "u-media" } }
        : { ok: false, error: "no-session" };
    },
  };
}

function openBundle() {
  const dir = tempDir("dxos-media-ipc-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(store);
  const bundle = createMediaBundle({ userDataDir: dir, identityStore: store, authorization: makeAuth() });
  return { dir, bundle, identity: { current: "sess-ipc" } };
}

// ── ① trusted fail closed ────────────────────────────────────────────────
test("trusted：缺 isTrusted / 伪造 sender 一律 Forbidden，且先于 bundle 判空", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  // 不注入 isTrusted
  registerMediaIpc({ ipcMain, bundle: fx.bundle, identity: fx.identity });
  await assert.rejects(() => ipcMain.invoke("media:command", trustedEvent(), { command: "media/render/list" }), /Forbidden/);
  // 缺 bundle 时也必须先过 trusted：伪造 sender → Forbidden，而不是 MEDIA_NOT_READY
  disposeMediaIpc({ ipcMain });
  registerMediaIpc({ ipcMain, bundle: null, isTrusted: trustedGate, identity: fx.identity });
  await assert.rejects(() => ipcMain.invoke("media:command", fakeEvent(), { command: "media/render/list" }), /Forbidden/);
  const notReady = await ipcMain.invoke("media:command", trustedEvent(), { command: "media/render/list" });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, MEDIA_NOT_READY);
});

// ── ② / ③ 白名单与命令体 ─────────────────────────────────────────────────
test("白名单：未登记命令被拒、无需对象载荷、command / type 两种写法", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerMediaIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: fx.identity });

  const bad = await ipcMain.invoke("media:command", trustedEvent(), { command: "media/nope" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "MEDIA_COMMAND_NOT_ALLOWED");

  const notObject = await ipcMain.invoke("media:command", trustedEvent(), "not-an-object");
  assert.equal(notObject.ok, false);
  assert.equal(notObject.error, "MEDIA_INVALID_INPUT");

  const byCommand = await ipcMain.invoke("media:command", trustedEvent(), { command: "media/render/list", payload: { limit: 10 } });
  assert.equal(byCommand.ok, true, JSON.stringify(byCommand));
  assert.deepEqual(byCommand.value.jobs, []);

  const byType = await ipcMain.invoke("media:command", trustedEvent(), { type: "media/render/list", payload: {} });
  assert.equal(byType.ok, true);
  assert.deepEqual(byType.value.jobs, []);

  // 非法 payload 形态仍在白名单内，回结构化输入错误
  const missing = await ipcMain.invoke("media:command", trustedEvent(), { command: "media/render/get", payload: {} });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "MEDIA_INVALID_INPUT");
});

// ── ④ media:event 信封 ───────────────────────────────────────────────────
test("media:event：P1 六字段与 sequence 单调，channel 固定 media:event", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  const events = [];
  registerMediaIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: fx.identity, send: (event) => events.push(event) });

  await ipcMain.invoke("media:command", trustedEvent(), { command: "media/render/list", payload: {} });
  await ipcMain.invoke("media:command", trustedEvent(), { command: "media/render/recover", payload: {} });

  assert.equal(events.length, 4, "每个命令 begin + completed 各一条");
  let last = 0;
  for (const event of events) {
    assert.equal(event.channel, "media:event");
    assert.equal(event.domain, "media");
    assert.equal(event.kind, "progress");
    assert.equal(typeof event.at, "number");
    assert.ok(event.sequence > last, "sequence 必须单调递增");
    last = event.sequence;
    assert.equal(typeof event.payload, "object");
  }
  assert.deepEqual(events.map((event) => event.payload.phase), ["begin", "completed", "begin", "completed"]);
});

// ── ⑤ 无绝对路径 ─────────────────────────────────────────────────────────
test("返回值：IPC 出口不含任何绝对路径 / 凭据", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerMediaIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: fx.identity, send: () => {} });
  const res = await ipcMain.invoke("media:command", trustedEvent(), { command: "media/render/list", payload: {} });
  assert.equal(res.ok, true);
  assert.equal(JSON.stringify(res).includes(fx.dir), false);
  assert.equal(JSON.stringify(res).includes(os.tmpdir()), false);
});

// ── ⑦ payload.userId 被忽略 ──────────────────────────────────────────────
test("身份边界：payload.userId 被忽略，actor 只从主进程 sessionRef 推导", async () => {
  const dir = tempDir("dxos-media-ipc-auth-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(store);
  const seen = [];
  const auth = {
    resolveActor({ context }) {
      seen.push(context && context.sessionRef);
      return context && context.sessionRef ? { ok: true, user: { id: "u-real" } } : { ok: false, error: "no-session" };
    },
  };
  const bundle = createMediaBundle({ userDataDir: dir, identityStore: store, authorization: auth });
  const ipcMain = makeIpcMain();
  registerMediaIpc({ ipcMain, bundle, isTrusted: trustedGate, identity: { current: "sess-real" } });
  const res = await ipcMain.invoke("media:command", trustedEvent(), { command: "media/render/list", payload: { userId: "attacker", role: "ADMIN", appId: "evil" } });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, ["sess-real"], "sessionRef 必须来自主进程注入，而不是 payload");

  // identity.current 为空 → 未认证（fail closed）
  disposeMediaIpc({ ipcMain });
  registerMediaIpc({ ipcMain, bundle, isTrusted: trustedGate, identity: { current: null } });
  const unauth = await ipcMain.invoke("media:command", trustedEvent(), { command: "media/render/list", payload: {} });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.error, "MEDIA_UNAUTHENTICATED");
});

// ── ⑥ dispose 后可重复注册 ───────────────────────────────────────────────
test("bootstrap：dispose 移除 handler，可重复注册", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerMediaIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: fx.identity });
  assert.equal(ipcMain.handlers.has("media:command"), true);
  disposeMediaIpc({ ipcMain });
  assert.equal(ipcMain.handlers.has("media:command"), false);
  await assert.rejects(() => ipcMain.invoke("media:command", trustedEvent(), { command: "media/render/list" }), /NO_HANDLER/);
  // 重复注册不抛
  registerMediaIpc({ ipcMain, bundle: fx.bundle, isTrusted: trustedGate, identity: fx.identity });
  assert.equal(ipcMain.handlers.has("media:command"), true);
  assert.equal(mediaDomain.listMediaCommands().length, 16);
});
