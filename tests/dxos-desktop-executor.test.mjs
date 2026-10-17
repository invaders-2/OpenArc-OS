/**
 * B7j+ · 桌面执行端回归（electron/desktop-executor.cjs + main.cjs 接线）。
 *
 * 覆盖 task-3 验收：
 *   · openApp / musicPlay / musicControl 成功路径（受控系统 API + 应用白名单）；
 *   · 拒绝路径（未知应用 / 非法参数 / shell 执行失败）；
 *   · 不可用路径（未注入 shell / 音乐控制器）；
 *   · main.cjs 把 desktop 适配器注入 automation-service（不再 desktop:null）；
 *   · automation 真实分发链能到达 desktop.musicPlay / openApp（真实 automation-service）。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const automationStore = require("../electron/automation-store.cjs");
const { createAutomationBundle } = require("../electron/automation-service.cjs");
const desktop = require("../electron/desktop-executor.cjs");

const ROOT = process.cwd();
const BASE = Date.UTC(2023, 10, 13, 0, 0, 0);
const USER = "u-desktop";
const tmpDirs = [];
const openStores = [];

afterEach(() => {
  automationStore.resetAutomationStoreForTests();
  while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } }
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

const APPS = [
  { id: "music", name: "音乐", aliases: ["music", "播放器"], path: "/System/Applications/Music.app" },
  { id: "finder", name: "访达", aliases: ["finder", "files"], path: "/System/Library/CoreServices/Finder.app" },
];

function makeShell(result = "") {
  const calls = [];
  return {
    calls,
    openPath: async (target) => { calls.push(target); return typeof result === "function" ? result(target) : result; },
  };
}

function makeMusicController() {
  const calls = [];
  return {
    calls,
    play: async (args) => { calls.push(["play", args]); return "正在播放：周杰伦 - 晴天"; },
    control: async (args) => { calls.push(["control", args]); return "已暂停音乐"; },
  };
}

function caught(fn) {
  try { fn(); } catch (error) { return error; }
  throw new Error("expected function to throw");
}

async function rejected(promise) {
  try { await promise; } catch (error) { return error; }
  throw new Error("expected promise to reject");
}

// ── 成功路径 ───────────────────────────────────────────────────────────────
test("openApp：id / 名称 / alias 命中白名单，走 shell.openPath 绝对路径", async () => {
  const shell = makeShell();
  const executor = desktop.createDesktopExecutor({ shell, apps: APPS });
  assert.equal(await executor.openApp({ app: "music" }), "已打开「音乐」");
  assert.equal(await executor.openApp({ app: "  音乐  " }), "已打开「音乐」");
  assert.equal(await executor.openApp({ app: "FINDER" }), "已打开「访达」");
  assert.deepEqual(shell.calls, [
    "/System/Applications/Music.app",
    "/System/Applications/Music.app",
    "/System/Library/CoreServices/Finder.app",
  ]);
});

test("musicPlay / musicControl：校验后的参数交给注入控制器，返回控制器文本", async () => {
  const music = makeMusicController();
  const executor = desktop.createDesktopExecutor({ shell: makeShell(), apps: APPS, musicController: music });
  assert.equal(await executor.musicPlay({ query: "周杰伦", shuffle: true }), "正在播放：周杰伦 - 晴天");
  assert.equal(await executor.musicPlay({}), "正在播放：周杰伦 - 晴天");
  assert.equal(await executor.musicControl({ action: "PAUSE" }), "已暂停音乐");
  assert.deepEqual(music.calls, [
    ["play", { query: "周杰伦", shuffle: true }],
    ["play", { query: "", shuffle: false }],
    ["control", { action: "pause" }],
  ]);
});

// ── 拒绝路径 ───────────────────────────────────────────────────────────────
test("openApp 拒绝：未知应用 / 空参数 / 非字符串 / 控制字符 / 超长", async () => {
  const executor = desktop.createDesktopExecutor({ shell: makeShell(), apps: APPS });
  for (const [args, code, pattern] of [
    [{ app: "terminal" }, desktop.DESKTOP_ERR_APP_NOT_ALLOWED, /不在桌面白名单/],
    [{ app: "music; rm -rf /" }, desktop.DESKTOP_ERR_APP_NOT_ALLOWED, /不在桌面白名单/],
    [{}, desktop.DESKTOP_ERR_INVALID_INPUT, /app/],
    [{ app: 42 }, desktop.DESKTOP_ERR_INVALID_INPUT, /必须是字符串/],
    [{ app: "   " }, desktop.DESKTOP_ERR_INVALID_INPUT, /不能为空/],
    [{ app: "music\u0000" }, desktop.DESKTOP_ERR_INVALID_INPUT, /控制字符/],
    [{ app: "a".repeat(121) }, desktop.DESKTOP_ERR_INVALID_INPUT, /长度/],
  ]) {
    const error = await rejected(executor.openApp(args));
    assert.equal(error.code, code, JSON.stringify(args));
    assert.match(error.message, pattern);
  }
});

test("musicPlay / musicControl 拒绝：非法动作 / query 类型 / shuffle 类型 / 控制字符", async () => {
  const executor = desktop.createDesktopExecutor({ shell: makeShell(), apps: APPS, musicController: makeMusicController() });
  for (const [fn, args, pattern] of [
    ["musicControl", { action: "shuffle" }, /不支持的音乐控制动作/],
    ["musicControl", { action: "" }, /action/],
    ["musicControl", {}, /action/],
    ["musicPlay", { query: 123 }, /query/],
    ["musicPlay", { query: "a".repeat(201) }, /长度/],
    ["musicPlay", { query: "bad\u0000query" }, /控制字符/],
    ["musicPlay", { shuffle: "yes" }, /shuffle/],
  ]) {
    const error = await rejected(executor[fn](args));
    assert.equal(error.code, desktop.DESKTOP_ERR_INVALID_INPUT, fn + " " + JSON.stringify(args));
    assert.match(error.message, pattern);
  }
});

test("执行失败结构化：shell.openPath 返回错误串 / 抛异常 / 控制器抛异常", async () => {
  const failShell = desktop.createDesktopExecutor({ shell: { openPath: async () => "not found" }, apps: APPS });
  const shellError = await rejected(failShell.openApp({ app: "music" }));
  assert.equal(shellError.code, desktop.DESKTOP_ERR_EXECUTION_FAILED);
  assert.match(shellError.message, /打开「音乐」失败：not found/);

  const throwingShell = desktop.createDesktopExecutor({ shell: { openPath: async () => { throw new Error("boom"); } }, apps: APPS });
  const thrown = await rejected(throwingShell.openApp({ app: "music" }));
  assert.equal(thrown.code, desktop.DESKTOP_ERR_EXECUTION_FAILED);

  const brokenMusic = desktop.createDesktopExecutor({
    shell: makeShell(), apps: APPS,
    musicController: { play: async () => { throw Object.assign(new Error("music denied"), { code: "-1743" }); }, control: async () => "ok" },
  });
  const musicError = await rejected(brokenMusic.musicPlay({ query: "x" }));
  assert.equal(musicError.code, desktop.DESKTOP_ERR_EXECUTION_FAILED);
  assert.match(musicError.message, /music denied/);
});

// ── 不可用路径 ─────────────────────────────────────────────────────────────
test("不可用：没有 shell / 没有音乐控制器时结构化 DESKTOP_UNAVAILABLE（不伪造成功）", async () => {
  const noShell = desktop.createDesktopExecutor({ apps: APPS });
  const shellError = await rejected(noShell.openApp({ app: "music" }));
  assert.equal(shellError.code, desktop.DESKTOP_ERR_UNAVAILABLE);
  assert.equal(shellError.detail.dependency, "shell.openPath");

  const noMusic = desktop.createDesktopExecutor({ shell: makeShell(), apps: APPS });
  for (const fn of ["musicPlay", "musicControl"]) {
    const error = await rejected(noMusic[fn](fn === "musicPlay" ? { query: "x" } : { action: "pause" }));
    assert.equal(error.code, desktop.DESKTOP_ERR_UNAVAILABLE, fn);
    assert.equal(error.detail.dependency, "musicController");
  }
});

test("白名单构造校验：重复键 / 相对路径 / 非对象一律拒绝（不做不确定的目标解析）", () => {
  for (const [apps, pattern] of [
    [[{ id: "a", path: "/tmp/a" }, { id: "b", name: "a", path: "/tmp/b" }], /白名单键重复/],
    [[{ id: "a", path: "relative/a" }], /绝对路径/],
    [[{ id: "a" }], /绝对路径/],
    [[{ path: "/tmp/a" }], /缺少 id/],
    [[null], /必须是对象/],
  ]) {
    const error = caught(() => desktop.createDesktopExecutor({ shell: makeShell(), apps }));
    assert.equal(error.code, desktop.DESKTOP_ERR_INVALID_INPUT);
    assert.match(error.message, pattern);
  }
});

// ── 固定 AppleScript 控制器（不拼 shell） ──────────────────────────────────
test("createSystemMusicController：非 darwin 返回 null；darwin 固定脚本 + argv 调用 osascript", async () => {
  assert.equal(desktop.createSystemMusicController({ platform: "linux" }), null);

  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const mode = args[args.length - 1];
    nextTick(() => {
      if (mode === "no-match") callback(null, "no-match\n", "");
      else if (mode === "pause") callback(null, "ok:pause\n", "");
      else callback(null, "playing:晴天 - 周杰伦\n", "");
    });
  };
  function nextTick(fn) { queueMicrotask(fn); }

  const controller = desktop.createSystemMusicController({ platform: "darwin", execFile });
  assert.equal(await controller.play({ query: "周杰伦" }), "正在播放：晴天 - 周杰伦");
  assert.match(await controller.play({ query: "周杰伦", shuffle: true }), /随机播放需在音乐应用中开启/, "shuffle 不能被静默吞掉");
  assert.equal(await controller.control({ action: "pause" }), "已暂停音乐");
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.file, "/usr/bin/osascript");
    assert.equal(call.args[0], "-e");
    assert.match(call.args[1], /on run argv/);
    assert.equal(call.options.timeout, 8000);
    assert.equal(call.options.shell, undefined, "不得经 shell 解释器");
  }
  assert.equal(calls[0].args[2], "周杰伦", "query 必须经 argv 传入，不拼进脚本文本");
  assert.ok(!calls[0].args[1].includes("周杰伦"), "脚本文本不得包含用户输入");

  // no-match → 结构化 NOT_FOUND，不是成功。
  const missing = desktop.createSystemMusicController({ platform: "darwin", execFile });
  const notFound = await rejected(missing.play({ query: "no-match" }));
  assert.equal(notFound.code, desktop.DESKTOP_ERR_NOT_FOUND);

  // osascript 失败（如未授权自动化）→ EXECUTION_FAILED，保留 causeCode。
  const deniedExec = (file, args, options, callback) => { queueMicrotask(() => callback(Object.assign(new Error("denied"), { code: 1 }), "", "execution error: Not authorized (-1743)")); };
  const denied = desktop.createSystemMusicController({ platform: "darwin", execFile: deniedExec });
  const deniedError = await rejected(denied.control({ action: "next" }));
  assert.equal(deniedError.code, desktop.DESKTOP_ERR_EXECUTION_FAILED);
  assert.match(deniedError.message, /-1743/);
});

// ── main.cjs 接线契约 ──────────────────────────────────────────────────────
test("main.cjs 接线：desktop 适配器注入 automation-service，替换 desktop:null", () => {
  const main = fs.readFileSync(path.join(ROOT, "electron", "main.cjs"), "utf8");
  assert.ok(main.includes('require("./desktop-executor.cjs")'), "main.cjs 必须装配 desktop-executor");
  assert.ok(main.includes("function createAutomationDesktopAdapter()"), "必须由受控系统 API 构造 desktop 适配器");
  assert.ok(main.includes("desktop: automationDesktop,"), "automation 装配必须注入真实 desktop 适配器");
  assert.equal(main.includes("desktop: null,"), false, "不允许再以 desktop:null 装配自动化域");
  assert.ok(main.includes("desktop: automationDesktopNote,"), "装配失败原因必须进 automation/health");
  // 白名单只收真实存在的系统应用路径，且音乐控制器只在 macOS 构造。
  assert.match(main, /process\.platform === "darwin"/);
  assert.ok(main.includes("fs.existsSync(app.path)"), "白名单必须过滤不存在的应用路径");
});

// ── automation 真实分发链 ──────────────────────────────────────────────────
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function makeAuth() {
  return { resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: USER } } : { ok: false, error: "no-session" }) };
}
function openAutomation(desktopAdapter) {
  const dir = tempDir("dxos-desktop-automation-");
  const idStore = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(idStore);
  return createAutomationBundle({ identityStore: idStore, authorization: makeAuth(), clock: () => BASE, sleeper: async () => {}, desktop: desktopAdapter });
}
const invoke = (bundle, command, payload) => bundle.execute(command, payload, { sessionRef: "sess-desktop", requestId: "req-desktop" });

test("automation 分发：music_play 到达 desktop.musicPlay 成功；open_app 未知应用结构化失败", async () => {
  const music = makeMusicController();
  const executor = desktop.createDesktopExecutor({ shell: makeShell(), apps: APPS, musicController: music });
  const bundle = openAutomation(executor);

  const play = automationStore.createAutomation(USER, {
    instruction: "播放周杰伦",
    schedule: { type: "once", at: BASE + 1000 },
    action: { type: "music_play", args: { query: "周杰伦", shuffle: true } },
  });
  const played = await invoke(bundle, "automation/runNow", { automationId: play.id, await: true });
  assert.equal(played.ok, true, JSON.stringify(played));
  assert.equal(played.value.result.status, "success");
  assert.equal(played.value.result.result, "正在播放：周杰伦 - 晴天");
  assert.deepEqual(music.calls, [["play", { query: "周杰伦", shuffle: true }]]);

  const opened = automationStore.createAutomation(USER, {
    instruction: "打开应用",
    schedule: { type: "once", at: BASE + 1000 },
    action: { type: "open_app", args: { app: "terminal" } },
  });
  const refused = await invoke(bundle, "automation/runNow", { automationId: opened.id, await: true });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /不在桌面白名单/);
  const run = automationStore.listRuns(USER, {}).find((row) => row.automationId === opened.id);
  assert.equal(run.status, "failed", "拒绝路径不得写 success");
});
