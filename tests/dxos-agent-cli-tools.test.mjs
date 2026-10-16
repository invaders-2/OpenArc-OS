/**
 * CLI-1 · agent-cli-tools.cjs（源 server/cliTools.ts 逐函数移植）契约测试。
 *
 * 全部离线：所有子进程都走注入的假 spawnImpl，任何真实 child_process.spawn
 * 调用都会被计到 guardedSpawnCalls，文件结束时断言必须为 0。
 * 所有 PATH 探测走注入的假 whichImpl，绝不触碰真实 dreamina / 外部 CLI。
 *
 * 覆盖：命令与参数逐条断言、超时、取消、非零退出、输出解析失败、
 *       未安装时的结构化错误（CLI_UNAVAILABLE 且不 spawn）、探测缓存/刷新、
 *       sharp 惰性加载与缺失、登录会话、模型目录、媒体解析与落盘。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── 离线护栏 ─────────────────────────────────────────────────────────
// 模块在加载期捕获 child_process.spawn；这里换成计数 wrapper 后立刻还原。
// 于是模块默认的 spawnImpl 就是这个 wrapper：测试只要漏注入假 spawn 就会计数 > 0。
const childProcess = require("node:child_process");
const realSpawn = childProcess.spawn;
let guardedSpawnCalls = 0;
childProcess.spawn = function guardedSpawn(...args) {
  guardedSpawnCalls += 1;
  return realSpawn.apply(this, args);
};
const agentCli = require("../electron/agent-cli-tools.cjs");
childProcess.spawn = realSpawn;

const tempRoots = [];
after(() => {
  assert.equal(guardedSpawnCalls, 0, "离线护栏：本次运行触发了真实 child_process.spawn " + guardedSpawnCalls + " 次");
  for (const root of tempRoots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
});

// ── 假 spawn ────────────────────────────────────────────────────────
/**
 * 返回 { calls, spawnImpl }。handler(record) 可返回
 *   { stdout, stderr, code, error, neverClose }。
 * 事件在 setImmediate 里发，保证 runProcess 先挂好监听。
 */
function scriptedSpawn(handler) {
  const calls = [];
  const spawnImpl = function spawnImpl(command, args, options) {
    const stdoutListeners = [];
    const stderrListeners = [];
    const closeListeners = [];
    const errorListeners = [];
    const child = {
      pid: 1000 + calls.length,
      exitCode: null,
      killed: false,
      stdout: { on(event, fn) { if (event === "data") stdoutListeners.push(fn); return this; } },
      stderr: { on(event, fn) { if (event === "data") stderrListeners.push(fn); return this; } },
      on(event, fn) {
        if (event === "close") closeListeners.push(fn);
        else if (event === "error") errorListeners.push(fn);
        return this;
      },
      kill() { this.killed = true; return true; },
    };
    const record = { command, args, options, child, stdout: "", stderr: "", code: null };
    calls.push(record);
    setImmediate(() => {
      let result = {};
      try { result = (handler ? handler(record) : {}) || {}; } catch (error) { result = { error }; }
      if (result.neverClose) return;
      if (result.error) { for (const fn of errorListeners) fn(result.error); return; }
      if (result.stdout) { record.stdout = result.stdout; for (const fn of stdoutListeners) fn(Buffer.from(result.stdout)); }
      if (result.stderr) { record.stderr = result.stderr; for (const fn of stderrListeners) fn(Buffer.from(result.stderr)); }
      record.code = result.code == null ? 0 : result.code;
      child.exitCode = record.code;
      for (const fn of closeListeners) fn(record.code);
    });
    return child;
  };
  return { calls, spawnImpl };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 每个用例一套隔离环境：临时 dataDir + 假 spawn + 假 which + 可控 clock。
 * options.exe 传入即视为「已安装」；不传即「未安装」。
 */
function setup(options) {
  const opts = options || {};
  const dataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "oa-cli-test-"));
  tempRoots.push(dataDir);
  const harness = scriptedSpawn(opts.handler);
  let now = opts.now === undefined ? 1000000 : opts.now;
  const clock = {
    now: () => now,
    sleep: async (ms) => { if (opts.advanceSleep) now += Number(ms) || 0; },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const exe = opts.exe === undefined ? "" : opts.exe;
  agentCli.configureAgentCliTools({
    spawnImpl: harness.spawnImpl,
    whichImpl: opts.whichImpl || (() => exe),
    dataDir,
    // 源 CLI_RUNTIME_DIR 在 ROOT 下；测试改指临时目录，避免往仓库里建目录。
    cliRuntimeDir: nodePath.join(dataDir, "cli-runtime", "jimeng"),
    env: opts.env || {},
    clock,
    sharpLoader: opts.sharpLoader,
  });
  return {
    dataDir,
    harness,
    clock,
    setNow: (value) => { now = value; },
    getNow: () => now,
    outputDir: nodePath.join(dataDir, "cli-output"),
    cliHomeDir: nodePath.join(dataDir, "cli-home", "jimeng"),
  };
}

function jsonHandler(payload, code) {
  return () => ({ code: code == null ? 0 : code, stdout: JSON.stringify(payload) });
}

const EXE = "/fake/bin/dreamina";

// ── A. 依赖探测 / 未安装结构化错误 ─────────────────────────────────

test("A1 · 未安装：probe/installed 都是结构化失败，detail 含二进制名与探测方式", () => {
  setup({ exe: "" });
  assert.equal(agentCli.jimengCliInstalled(), false);
  const probe = agentCli.probeJimengCli();
  assert.equal(probe.ok, false);
  assert.equal(probe.installed, false);
  assert.equal(probe.error, "CLI_UNAVAILABLE");
  assert.match(probe.detail, /dreamina/);
  assert.match(probe.detail, /探测方式/);
});

test("A2 · 已安装：探测结果缓存，refreshJimengProbe 可刷新（which 调用次数为证）", () => {
  let whichCalls = 0;
  setup({ exe: EXE, whichImpl: (name) => { whichCalls += 1; return name === "dreamina" ? EXE : ""; } });
  const first = agentCli.probeJimengCli();
  assert.equal(first.ok, true);
  assert.equal(first.exe, EXE);
  assert.ok(whichCalls >= 3, "首次探测要扫 dreamina / .exe / .cmd");
  const afterFirst = whichCalls;
  assert.equal(agentCli.probeJimengCli().exe, EXE);
  assert.equal(whichCalls, afterFirst, "第二次命中缓存，不再扫 PATH");
  const refreshed = agentCli.refreshJimengProbe();
  assert.equal(refreshed.ok, true);
  assert.equal(whichCalls, afterFirst + 3, "刷新后重新探测");
});

test("A3 · 未安装：所有需要 CLI 的公开函数返回 CLI_UNAVAILABLE 且绝不 spawn", async () => {
  const env = setup({ exe: "" });
  const results = await Promise.all([
    agentCli.runJimengCli(["user_credit"]),
    agentCli.jimengStatus(),
    agentCli.jimengCredit(),
    agentCli.jimengLogout(),
    agentCli.jimengHelp(""),
    agentCli.jimengModels(false),
    agentCli.jimengLoginStart(),
    agentCli.listJimengTasks(),
    agentCli.generateJimengImage("p"),
    agentCli.generateJimengVideo("p"),
    agentCli.upscaleJimengImage(EXE),
    agentCli.queryJimengMedia("s1"),
  ]);
  for (const value of results) {
    assert.equal(value.ok, false, JSON.stringify(value));
    assert.equal(value.error, "CLI_UNAVAILABLE");
    assert.equal(typeof value.detail, "string");
    assert.match(value.detail, /dreamina/);
  }
  assert.equal(env.harness.calls.length, 0, "未安装时不得 spawn 任何进程");
});

// ── B. 纯函数：尺寸 / 比例 / 模型 / 参数构造 ────────────────────────

test("B1 · parseSize / ratioFromDimensions / normalizeImageModel / imageModelVersion / imageResolution", () => {
  assert.deepEqual(agentCli.parseSize("2048x1536"), { width: 2048, height: 1536 });
  assert.deepEqual(agentCli.parseSize("bad"), { width: 1024, height: 1024 });
  assert.equal(agentCli.ratioFromDimensions(1920, 1080), "16:9");
  assert.equal(agentCli.ratioFromDimensions(1080, 1920), "9:16");
  assert.equal(agentCli.ratioFromDimensions(0, 0), "1:1");
  assert.equal(agentCli.jimengImageRatioFromDimensions(1024, 1024), "1:1");
  assert.equal(agentCli.normalizeImageModel("jimeng-5.0-pro"), "5.0Pro");
  assert.equal(agentCli.normalizeImageModel("jimeng-4.6"), "4.6");
  assert.equal(agentCli.normalizeImageModel("garbage"), "");
  assert.equal(agentCli.imageModelVersion("jimeng-3.0", "text2image"), "3.0");
  assert.equal(agentCli.imageModelVersion("jimeng-3.0", "image2image"), "", "3.0 不支持图生图");
  assert.equal(agentCli.imageResolution("jimeng-5.0Pro", "1024x1024", "text2image"), "1.5k");
  assert.equal(agentCli.imageResolution("jimeng-4.6", "4096x4096", "text2image"), "4k");
  assert.equal(agentCli.imageResolution("jimeng-3.0", "4096x4096", "text2image"), "2k");
});

test("B2 · buildJimengImageArgs：文生图 / 图生图 / 参考图比例 / poll 夹取 / 非法模型", () => {
  assert.deepEqual(agentCli.buildJimengImageArgs("cat", "jimeng-5.0Pro", "1024x1024"), {
    command: "text2image",
    args: ["text2image", "--prompt=cat", "--ratio=1:1", "--resolution_type=1.5k", "--poll=600", "--model_version=5.0Pro"],
  });
  assert.deepEqual(agentCli.buildJimengImageArgs("cat", "jimeng-4.6", "2048x2048", ["/a.png"]), {
    command: "image2image",
    args: ["image2image", "--images=/a.png", "--prompt=cat", "--ratio=1:1", "--resolution_type=2k", "--poll=600", "--model_version=4.6"],
  });
  assert.deepEqual(agentCli.buildJimengImageArgs("cat", "jimeng-4.6", "2048x2048", ["/a.png"], {}, "21:9").args[3], "--ratio=21:9");
  assert.deepEqual(agentCli.buildJimengImageArgs("cat", "jimeng-4.6", "1024x1024", ["/a.png", "/b.png"]).args[1], "--images=/a.png,/b.png");
  assert.equal(agentCli.buildJimengImageArgs("p", "jimeng-4.6", "1024x1024", [], { pollSeconds: 9999 }).args.includes("--poll=600"), true);
  assert.equal(agentCli.buildJimengImageArgs("p", "jimeng-4.6", "1024x1024", [], { pollSeconds: -5 }).args.includes("--poll=0"), true);
  assert.equal(agentCli.buildJimengImageArgs("p", "unknown-model", "1024x1024").args.some((a) => a.startsWith("--model_version=")), false);
});

test("B3 · buildJimengVideoArgs：text2video / image2video / frames2video 逐参数", () => {
  assert.deepEqual(agentCli.buildJimengVideoArgs("run", "seedance2.0fast"), {
    command: "text2video",
    args: ["text2video", "--prompt=run", "--duration=5", "--ratio=16:9", "--poll=600", "--model_version=seedance2.0fast", "--video_resolution=720p"],
  });
  assert.deepEqual(agentCli.buildJimengVideoArgs("run", "seedance2.0fast", { imagePaths: ["/a.png"] }), {
    command: "image2video",
    args: ["image2video", "--image=/a.png", "--prompt=run", "--duration=5", "--poll=600", "--model_version=seedance2.0fast", "--video_resolution=720p"],
  });
  assert.deepEqual(agentCli.buildJimengVideoArgs("p", "seedance1.5pro", { imagePaths: ["/a.png", "/b.png"], imageRoles: ["first_frame", "last_frame"] }), {
    command: "frames2video",
    args: ["frames2video", "--first=/a.png", "--last=/b.png", "--prompt=p", "--duration=5", "--poll=600", "--model_version=seedance1.5pro", "--video_resolution=720p"],
  });
});

test("B4 · buildJimengVideoArgs：multimodal / multiframe / 纯音频与约束报错", () => {
  const multi = agentCli.buildJimengVideoArgs("p", "seedance2.0fast", { imagePaths: ["/a.png", "/b.png"], aspect_ratio: "9:16" });
  assert.equal(multi.command, "multimodal2video");
  assert.deepEqual(multi.args.filter((a) => a.startsWith("--image=")), ["--image=/a.png", "--image=/b.png"]);
  assert.equal(multi.args.includes("--ratio=9:16"), true);

  const withVideo = agentCli.buildJimengVideoArgs("p", "seedance2.0fast", { videoPaths: ["/v.mp4"], audioPaths: ["/a.mp3"] });
  assert.equal(withVideo.command, "multimodal2video");
  assert.equal(withVideo.args.includes("--video=/v.mp4"), true);
  assert.equal(withVideo.args.includes("--audio=/a.mp3"), true);

  const audioOnly25 = agentCli.buildJimengVideoArgs("p", "seedance2.5", { audioPaths: ["/a.mp3"] });
  assert.equal(audioOnly25.command, "multimodal2video");
  assert.equal(audioOnly25.args.includes("--audio=/a.mp3"), true);

  assert.throws(() => agentCli.buildJimengVideoArgs("p", "seedance2.0fast", { audioPaths: ["/a.mp3"] }), /仅 Seedance 2\.5 支持纯音频参考/);

  const twoFrames = agentCli.buildJimengVideoArgs("p", "seedance1.0fast", { imagePaths: ["/a.png", "/b.png"] });
  assert.equal(twoFrames.command, "multiframe2video");
  assert.deepEqual(twoFrames.args, ["multiframe2video", "--images=/a.png,/b.png", "--poll=600", "--video_resolution=720p", "--prompt=p", "--duration=3"]);

  const manyFrames = agentCli.buildJimengVideoArgs("p1\np2", "seedance1.0fast", { imagePaths: ["/a.png", "/b.png", "/c.png"] });
  assert.equal(manyFrames.command, "multiframe2video");
  assert.deepEqual(manyFrames.args.slice(4), ["--transition-prompt=p1", "--transition-prompt=p2", "--transition-duration=3", "--transition-duration=3"]);

  assert.throws(() => agentCli.videoModelForCommand("seedance1.5pro", "text2video"), /不支持模型/);
  assert.throws(() => agentCli.videoResolution("seedance2.0", "4k"), /只支持 720p/);
  assert.throws(() => agentCli.videoResolution("seedance2.5", "4k"), /不支持 4k/);
  assert.throws(() => agentCli.videoDuration(100, "seedance2.0", "text2video"), /只支持 4-15 秒整数时长/);
  assert.throws(() => agentCli.videoRatio("5:4"), /仅支持/);
  assert.throws(() => agentCli.multiframeResolution("480p"), /只支持 720p 或 1080p/);
});

test("B5 · 视频模型版本识别与时长边界", () => {
  assert.equal(agentCli.videoModelVersion("seedance2.0fast"), "seedance2.0fast");
  assert.equal(agentCli.videoModelVersion("seedance2.0_vip"), "seedance2.0_vip");
  assert.equal(agentCli.videoModelVersion("xseedance2.0"), "", "词边界外不识别");
  assert.equal(agentCli.videoDuration(undefined, "seedance1.0fast", "image2video"), 5);
  assert.equal(agentCli.videoDuration(10, "seedance1.0fast", "image2video"), 10);
  assert.equal(agentCli.videoDuration(30, "seedance2.5", "text2video"), 30);
  assert.equal(agentCli.videoDuration(undefined, "seedance2.0fast", "text2video"), 5);
  assert.equal(agentCli.transitionDuration(undefined, 2), 3);
  assert.deepEqual(agentCli.transitionPrompts("a\nb", 3), ["a", "b", "b"]);
  assert.deepEqual(agentCli.transitionPrompts("", 2), []);
});

test("B6 · 模型目录解析 / 帮助文本 / WSL 路径与解码工具", () => {
  assert.deepEqual(agentCli.jimengModelsFromHelp("models: 4.6 4.7 seedance2.0 seedance2.5"), ["jimeng-4.7", "jimeng-4.6", "seedance2.5", "seedance2.0"]);
  assert.deepEqual(agentCli.jimengModelsFromHelp("nothing"), []);
  assert.equal(agentCli.windowsPathToWsl("C:\\Users\\a\\dreamina"), "/mnt/c/Users/a/dreamina");
  assert.equal(agentCli.wslPathToWindows("/mnt/c/Users/a"), "C:\\Users\\a");
  assert.equal(agentCli.shellQuote("a'b"), "'a'\\''b'");
  assert.equal(agentCli.decode(Buffer.from([0x61, 0x00, 0x62, 0x00, 0x00, 0x00])), "ab");
  assert.equal(agentCli.decode(Buffer.from("hello", "utf8")), "hello");
  assert.equal(agentCli.cleanWslStderr("keep\nlocalhost wsl NAT proxy\n  spaced  "), "keep\nspaced");
});
// ── C. 假 spawn 驱动：命令/参数、解析、超时、取消、退出码 ──────────

test("C1 · runJimengCli：命令与参数逐条断言 + cwd/env + JSON 解析字段", async () => {
  const payload = { submit_id: "s1", gen_status: "success", images: ["https://cdn/a.png"], total_credit: 12 };
  const env = setup({ exe: EXE, handler: jsonHandler(payload) });
  const raw = await agentCli.runJimengCli(["text2image", "--prompt=cat"]);
  assert.equal(env.harness.calls.length, 1);
  const call = env.harness.calls[0];
  assert.equal(call.command, EXE);
  assert.deepEqual(call.args, ["text2image", "--prompt=cat"]);
  assert.equal(nodePath.basename(call.options.cwd), "electron");
  // whichImpl 命中 PATH → runtime.mode="path" → 源语义是「用本机登录态」，托管 env 必须为空。
  assert.deepEqual(call.options.env, {}, "PATH 命中时走 host login，不覆盖宿主环境");
  assert.equal(raw.submit_id, "s1");
  assert.equal(raw.gen_status, "success");
  assert.equal(raw._stdout, JSON.stringify(payload));
  assert.equal(raw._stderr, undefined, "stderr 为空时不加 _stderr 字段");
  assert.deepEqual(agentCli.jimengMediaUrlsFromRaw(raw, "image"), ["https://cdn/a.png"]);
});

test("C1b · jimengCommand(isolated)：托管 HOME/XDG 环境变量映射到 dataDir", () => {
  const env = setup({ exe: EXE });
  const cliHome = nodePath.join(env.dataDir, "cli-home", "jimeng");
  const cmd = agentCli.jimengCommand(["text2image", "--prompt=x"], EXE, "isolated");
  assert.equal(cmd.command, EXE);
  assert.deepEqual(cmd.args, ["text2image", "--prompt=x"]);
  assert.equal(cmd.env.HOME, nodePath.join(cliHome, "home"));
  assert.equal(cmd.env.USERPROFILE, nodePath.join(cliHome, "home"));
  assert.equal(cmd.env.APPDATA, nodePath.join(cliHome, "config"));
  assert.equal(cmd.env.LOCALAPPDATA, nodePath.join(cliHome, "data"));
  assert.equal(cmd.env.XDG_CONFIG_HOME, nodePath.join(cliHome, "config"));
  assert.equal(cmd.env.XDG_CACHE_HOME, nodePath.join(cliHome, "cache"));
  assert.equal(cmd.env.XDG_DATA_HOME, nodePath.join(cliHome, "data"));
  assert.equal(cmd.env.DREAMINA_HOME, nodePath.join(cliHome, "home"));
});

test("C2 · runJimengCli：rawText 只回 _stdout/_stderr", async () => {
  setup({ exe: EXE, handler: () => ({ stdout: "hello", stderr: "warn" }) });
  const raw = await agentCli.runJimengCli(["user_credit"], 1000, true);
  assert.deepEqual(raw, { _stdout: "hello", _stderr: "warn" });
});

test("C3 · 输出解析失败：非 JSON 回退成 { text, _stdout }，extractJson 打分与容器齐全", async () => {
  setup({ exe: EXE, handler: () => ({ stdout: "not json" }) });
  const raw = await agentCli.runJimengCli(["list_task"]);
  assert.equal(raw.text, "not json");
  assert.equal(raw._stdout, "not json");
  assert.deepEqual(agentCli.extractJson(""), {});
  assert.deepEqual(agentCli.extractJson("[1,2]"), [1, 2]);
  assert.deepEqual(agentCli.extractJson('noise {"a":1} {"submit_id":"x","gen_status":"success"}'), { submit_id: "x", gen_status: "success" });
});

test("C4 · 非零退出：stderr 优先，无输出时 exit=<code>", async () => {
  setup({ exe: EXE, handler: () => ({ code: 2, stderr: "boom" }) });
  await assert.rejects(agentCli.runJimengCli(["user_credit"]), /boom/);
  setup({ exe: EXE, handler: () => ({ code: 3 }) });
  await assert.rejects(agentCli.runJimengCli(["user_credit"]), /exit=3/);
});

test("C5 · 超时：kill 子进程并报「即梦 CLI 执行超时」", async () => {
  const env = setup({ exe: EXE, handler: () => ({ neverClose: true }) });
  await assert.rejects(agentCli.runJimengCli(["user_credit"], 20), /即梦 CLI 执行超时/);
  assert.equal(env.harness.calls.length, 1);
  assert.equal(env.harness.calls[0].child.killed, true, "超时必须 kill");
});

test("C6 · 取消：AbortSignal 触发 kill，错误码 ABORTED", async () => {
  const env = setup({ exe: EXE, handler: () => ({ neverClose: true }) });
  const controller = new AbortController();
  const promise = agentCli.runJimengCli(["user_credit"], 60000, false, "runtime", { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "ABORTED");
    assert.match(error.message, /已取消/);
    return true;
  });
  assert.equal(env.harness.calls[0].child.killed, true, "取消必须 kill");
});

test("C7 · 子进程 error 事件原样 reject", async () => {
  setup({ exe: EXE, handler: () => ({ error: new Error("ENOENT spawn dreamina") }) });
  await assert.rejects(agentCli.runJimengCli(["user_credit"]), /ENOENT spawn dreamina/);
});

// ── D. 状态 / 登录 / 帮助 / 模型目录 ───────────────────────────────

test("D1 · jimengStatus：CLI 可用即 cli 验证 + 版本字段", async () => {
  const env = setup({ exe: EXE, handler: (record) => {
    if (record.args[0] === "--version") return { stdout: "dreamina version 1.4.2" };
    if (record.args[0] === "user_credit") return { stdout: JSON.stringify({ total_credit: 5 }) };
    return { stdout: "{}" };
  } });
  const status = await agentCli.jimengStatus();
  assert.equal(status.installed, true);
  assert.equal(status.logged_in, true);
  assert.equal(status.login_verified_by, "cli");
  assert.equal(status.cli_version, "1.4.2");
  assert.equal(status.version_ok, true);
  assert.equal(status.min_version, "1.4.2");
  assert.equal(status.raw.total_credit, 5);
  assert.equal(env.harness.calls.length, 2);
});

test("D2 · jimengStatus：CLI 报错但有 token 文件 → token 验证分支", async () => {
  const env = setup({ exe: EXE, handler: (record) => {
    if (record.args[0] === "--version") return { stdout: "dreamina version 1.3.0" };
    return { code: 1, stderr: "not logged in" };
  } });
  const tokenDir = nodePath.join(env.cliHomeDir, "home", ".dreamina_cli");
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(nodePath.join(tokenDir, "byted_cli_user_token.json"), JSON.stringify({ access_token: "T".repeat(40) }), "utf8");
  const status = await agentCli.jimengStatus();
  assert.equal(status.installed, true);
  assert.equal(status.logged_in, true);
  assert.equal(status.token_present, true);
  assert.equal(status.login_verified_by, "token");
  assert.equal(status.version_ok, false, "1.3.0 < 1.4.2");
  assert.match(status.credit_error, /not logged in/);
});

test("D3 · jimengCredit：成功与「有 token 但积分不可用」两条分支", async () => {
  setup({ exe: EXE, handler: jsonHandler({ total_credit: 9 }) });
  const ok = await agentCli.jimengCredit();
  assert.equal(ok.success, true);
  assert.equal(ok.available, true);
  assert.equal(ok.raw.total_credit, 9);

  const env = setup({ exe: EXE, handler: () => ({ code: 1, stderr: "credit unavailable" }) });
  const tokenDir = nodePath.join(env.cliHomeDir, "home", ".dreamina_cli");
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(nodePath.join(tokenDir, "byted_cli_user_token.json"), JSON.stringify({ access_token: "T".repeat(40) }), "utf8");
  const tokenOnly = await agentCli.jimengCredit();
  assert.equal(tokenOnly.success, true);
  assert.equal(tokenOnly.available, false);
  assert.equal(tokenOnly.token_present, true);
});

test("D4 · jimengLogout：执行 logout 并删除登录标记", async () => {
  const env = setup({ exe: EXE, handler: jsonHandler({ ok: true }) });
  fs.mkdirSync(env.cliHomeDir, { recursive: true });
  const marker = nodePath.join(env.cliHomeDir, ".managed-login.json");
  fs.writeFileSync(marker, JSON.stringify({ verifiedAt: 1 }), "utf8");
  const result = await agentCli.jimengLogout();
  assert.equal(result.success, true);
  assert.deepEqual(env.harness.calls[0].args, ["logout"]);
  assert.equal(fs.existsSync(marker), false, "logout 后标记被删");
});

test("D5 · jimengHelp：白名单命令透传，非白名单直接报错且不 spawn", async () => {
  const env = setup({ exe: EXE, handler: () => ({ stdout: "usage: dreamina", stderr: "tail" }) });
  const help = await agentCli.jimengHelp("text2image");
  assert.equal(help.success, true);
  assert.equal(help.command, "text2image");
  assert.equal(help.text, "usage: dreamina\ntail");
  assert.deepEqual(env.harness.calls[0].args, ["text2image", "-h"]);
  const before = env.harness.calls.length;
  await assert.rejects(agentCli.jimengHelp("rm -rf /"), /不支持的帮助命令/);
  assert.equal(env.harness.calls.length, before, "非白名单不得 spawn");
});

const LOGIN_DEVICE_TEXT = [
  "verification_uri: https://example.com/login",
  "user_code: ABCD-1234",
  "device_code: DEV-1",
  "expires_at: 999",
].join("\n");

function loginHandler(record) {
  if (record.args[0] === "login" && record.args[1] === "--headless") return { stdout: LOGIN_DEVICE_TEXT };
  if (record.args[0] === "login" && record.args[1] === "checklogin") return { stdout: JSON.stringify({ submit_id: "login-ok", status: "success" }) };
  if (record.args[0] === "user_credit") return { stdout: JSON.stringify({ total_credit: 1 }) };
  return { stdout: "{}" };
}

test("D6 · 登录会话：start 参数/字段，status 先 running 再 device_code 验证", async () => {
  const env = setup({ exe: EXE, handler: loginHandler, now: 4000 });
  const started = await agentCli.jimengLoginStart();
  assert.deepEqual(env.harness.calls[0].args, ["login", "--headless"]);
  assert.equal(started.success, true);
  assert.equal(started.started_at, 4000);
  assert.equal(started.running, true);

  const early = await agentCli.jimengLoginStatus();
  assert.equal(early.running, true);
  assert.equal(early.logged_in, false, "5s 内不重复探测");

  await tick();
  const verified = await agentCli.jimengLoginStatus();
  assert.equal(verified.logged_in, true);
  assert.equal(verified.login_verified_by, "cli");
  assert.deepEqual(env.harness.calls[1].args, ["login", "checklogin", "--device_code=DEV-1"]);
});

test("D7 · jimengModels：force 走 CLI help 解析，12h 内命中缓存", async () => {
  const env = setup({ exe: EXE, handler: () => ({ stdout: "models: 4.6 4.7 seedance2.0 seedance2.5" }) });
  const forced = await agentCli.jimengModels(true);
  assert.equal(forced.source, "cli-help");
  assert.equal(forced.cached, false);
  assert.ok(forced.models.includes("jimeng-4.7"));
  assert.equal(env.harness.calls.length, 7, "7 个 help 命令各一次");
  const cached = await agentCli.jimengModels(false);
  assert.equal(cached.cached, true);
  assert.equal(env.harness.calls.length, 7, "缓存命中不新增 spawn");
});
// ── E. 媒体解析 / 落盘 / 生成 / sharp ──────────────────────────────

test("E1 · 媒体解析：submitId 递归、result_json 展开、去重、本地文件转 data URL", () => {
  assert.equal(agentCli.submitId({ a: { submit_id: "s1" } }), "s1");
  assert.equal(agentCli.submitId({ a: { taskId: "t1" } }), "t1");
  assert.equal(agentCli.submitId("plain"), "");
  const parsed = agentCli.jimengMediaUrlsFromRaw({
    result_json: JSON.stringify({ images: ["https://cdn/a.png"] }),
    data: [{ url: "https://cdn/a.png" }, { url: "https://cdn/b.png" }],
  }, "image");
  assert.deepEqual(parsed, ["https://cdn/a.png", "https://cdn/b.png"]);

  const env = setup({ exe: "" });
  const png = nodePath.join(env.dataDir, "pic.png");
  fs.writeFileSync(png, Buffer.from([1, 2, 3]));
  // 源 collectMedia 只收 URL / /mnt/ / Windows 盘符：裸 unix 路径不会被收集；
  // 本地文件转 data URL 由 mediaValueToDisplay 负责（下载兜底路径见 E4）。
  assert.deepEqual(agentCli.jimengMediaUrlsFromRaw({ path: png }, "image"), []);
  assert.match(agentCli.mediaValueToDisplay(png, "image"), /^data:image\/png;base64,/);
  assert.equal(agentCli.mediaValueToDisplay("https://cdn/a.png", "image"), "https://cdn/a.png");
  assert.equal(agentCli.mediaValueToDisplay("data:image/png;base64,AAAA", "image"), "data:image/png;base64,AAAA");
  assert.equal(agentCli.mediaValueToDisplay(nodePath.join(env.dataDir, "missing.png"), "image"), "");
});

test("E2 · 任务状态 / 失败原因 / queueInfo / 排队 payload", () => {
  assert.equal(agentCli.jimengTaskSucceeded({ gen_status: "success" }), true);
  assert.equal(agentCli.jimengTaskSucceeded({ status: "FAILED" }), false);
  assert.equal(agentCli.jimengTaskSucceeded({ a: [{ state: "completed" }] }), true);
  assert.equal(agentCli.jimengFailureMessage({}), "");
  assert.equal(
    agentCli.jimengFailureMessage({ error: "final generation failed", submit_id: "s9" }),
    "即梦云端未完成生成，可能触发提示词、名人/版权内容审核，或云端生成失败。请调整提示词后重试（submit_id=s9）",
  );
  assert.match(agentCli.jimengFailureMessage({ reason: "generation error", submit_id: "s2" }), /即梦任务失败：generation error（submit_id=s2）/);
  assert.deepEqual(agentCli.queueInfo({ a: { queue_info: { queue_idx: 1 } } }), { queue_idx: 1 });
  assert.deepEqual(agentCli.queueInfo({ a: 1 }), {});

  const pending = agentCli.jimengPendingPayload(new agentCli.JimengPendingError("s3", "image", { queue_idx: 2, queue_length: 5, queue_status: "running" }, {}));
  assert.equal(pending.jimeng_pending, true);
  assert.equal(pending.status, "pending");
  assert.equal(pending.queue_index, 2);
  assert.equal(pending.queue_total, 5);
  assert.equal(pending.queue_status, "running");
  assert.match(pending.queue_text, /第 2\/5 位/);
  const noQueue = agentCli.jimengPendingPayload(new agentCli.JimengPendingError("s4", "video", {}, {}));
  assert.equal(noQueue.queue_index, undefined);
  assert.equal(noQueue.queue_text, "即梦云端生成中");
});

test("E3 · 临时文件扩展名映射与 <submit_id>_* 下载目录恢复", () => {
  const env = setup({ exe: "" });
  const files = [
    agentCli.tempMediaFile(Buffer.from([1]), "image/png"),
    agentCli.tempMediaFile(Buffer.from([1]), "image/jpeg"),
    agentCli.tempMediaFile(Buffer.from([1]), "image/webp"),
    agentCli.tempMediaFile(Buffer.from([1]), "video/mp4"),
    agentCli.tempMediaFile(Buffer.from([1]), "application/octet-stream", ".dat"),
  ];
  assert.deepEqual(files.map((file) => nodePath.extname(file)), [".png", ".jpg", ".webp", ".mp4", ".dat"]);
  for (const file of files) { assert.equal(fs.existsSync(file), true); fs.rmSync(file, { force: true }); }

  fs.mkdirSync(env.outputDir, { recursive: true });
  fs.writeFileSync(nodePath.join(env.outputDir, "s7_1.png"), "");
  fs.writeFileSync(nodePath.join(env.outputDir, "s7_2.mp4"), "");
  fs.writeFileSync(nodePath.join(env.outputDir, "other.png"), "");
  assert.deepEqual(agentCli.downloadedJimengMedia("s7", "image").map((file) => nodePath.basename(file)), ["s7_1.png"]);
  assert.deepEqual(agentCli.downloadedJimengMedia("s7", "video").map((file) => nodePath.basename(file)), ["s7_2.mp4"]);
  assert.deepEqual(agentCli.downloadedJimengMedia("", "image"), []);
});

test("E4 · queryJimengMedia：成功 / 下载目录兜底 / 失败 / 排队 / 异常转排队 / 缺 id", async () => {
  setup({ exe: EXE, handler: jsonHandler({ submit_id: "s1", images: ["https://cdn/a.png"] }) });
  const ok = await agentCli.queryJimengMedia("s1");
  assert.equal(ok.status, "succeeded");
  assert.equal(ok.submit_id, "s1");
  assert.deepEqual(ok.urls, ["https://cdn/a.png"]);

  const env = setup({ exe: EXE, handler: jsonHandler({ submit_id: "s8", status: "success" }) });
  fs.mkdirSync(env.outputDir, { recursive: true });
  fs.writeFileSync(nodePath.join(env.outputDir, "s8_1.png"), Buffer.from([9]));
  const recovered = await agentCli.queryJimengMedia("s8");
  assert.equal(recovered.status, "succeeded");
  assert.match(recovered.urls[0], /^data:image\/png;base64,/);

  setup({ exe: EXE, handler: jsonHandler({ submit_id: "s2", error: "task failed" }) });
  const failed = await agentCli.queryJimengMedia("s2");
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /task failed/);

  setup({ exe: EXE, handler: jsonHandler({ submit_id: "s3", gen_status: "running", queue_info: { queue_idx: 1, queue_length: 3 } }) });
  const pending = await agentCli.queryJimengMedia("s3");
  assert.equal(pending.status, "pending");
  assert.equal(pending.submit_id, "s3");
  assert.equal(pending.queue_index, 1);

  setup({ exe: EXE, handler: () => ({ code: 1, stderr: "任务生成中" }) });
  const thrownPending = await agentCli.queryJimengMedia("s4");
  assert.equal(thrownPending.status, "pending");

  await assert.rejects(agentCli.queryJimengMedia(""), /缺少 submit_id/);
});

test("E5 · generateJimengImage：成功字段 / 参考图比例 / deferPending", async () => {
  setup({ exe: EXE, handler: (record) => {
    if (record.args[0] === "text2image") return { stdout: JSON.stringify({ submit_id: "g1", images: ["https://cdn/g1.png"] }) };
    return { stdout: "{}" };
  } });
  const image = await agentCli.generateJimengImage("cat", "jimeng-5.0Pro", "1024x1024");
  assert.equal(image.command, "text2image");
  assert.equal(image.image, "https://cdn/g1.png");
  assert.deepEqual(image.images, ["https://cdn/g1.png"]);
  assert.equal(image.submit_id, "g1");
  assert.equal(image.raw._stdout, JSON.stringify({ submit_id: "g1", images: ["https://cdn/g1.png"] }));

  const sharpStub = () => () => ({ metadata: async () => ({ width: 1920, height: 1080 }) });
  const env2 = setup({ exe: EXE, handler: jsonHandler({ submit_id: "g2", images: ["https://cdn/g2.png"] }), sharpLoader: sharpStub });
  const ref2 = nodePath.join(env2.dataDir, "ref2.png");
  fs.writeFileSync(ref2, Buffer.from([1]));
  const withRef = await agentCli.generateJimengImage("cat", "jimeng-4.6", "1024x1024", [ref2]);
  assert.equal(withRef.command, "image2image");
  assert.equal(env2.harness.calls[0].args.includes("--ratio=16:9"), true);
  assert.equal(fs.existsSync(ref2), false, "参考图在 finally 里删除");

  setup({ exe: EXE, handler: jsonHandler({ submit_id: "p1" }) });
  await assert.rejects(agentCli.generateJimengImage("cat", "jimeng-5.0Pro", "1024x1024", [], { deferPending: true }), (error) => {
    assert.equal(error.name, "JimengPendingError");
    assert.equal(error.submit_id, "p1");
    return true;
  });
});

test("E6 · generateJimengVideo：成功字段 + 输入媒体清理", async () => {
  const env = setup({ exe: EXE, handler: (record) => {
    if (record.args[0] === "text2video") return { stdout: JSON.stringify({ submit_id: "v1", videos: ["https://cdn/v1.mp4"] }) };
    if (record.args[0] === "image2video") return { stdout: JSON.stringify({ submit_id: "v2", videos: ["https://cdn/v2.mp4"] }) };
    return { stdout: "{}" };
  } });
  const video = await agentCli.generateJimengVideo("run", "seedance2.0fast");
  assert.equal(video.command, "text2video");
  assert.deepEqual(video.videos, ["https://cdn/v1.mp4"]);
  assert.equal(video.submit_id, "v1");

  const input = nodePath.join(env.dataDir, "in.png");
  fs.writeFileSync(input, Buffer.from([1]));
  const second = await agentCli.generateJimengVideo("run", "seedance2.0fast", { imagePaths: [input] });
  assert.equal(second.command, "image2video");
  assert.deepEqual(second.videos, ["https://cdn/v2.mp4"]);
  assert.equal(fs.existsSync(input), false, "输入图被清理");
});

test("E7 · upscaleJimengImage：参数逐条 + 结果字段 + 输入清理", async () => {
  const env = setup({ exe: EXE, handler: jsonHandler({ submit_id: "u1", images: ["https://cdn/u1.png"] }) });
  const input = nodePath.join(env.dataDir, "up.png");
  fs.writeFileSync(input, Buffer.from([1]));
  const result = await agentCli.upscaleJimengImage(input, "4k");
  assert.equal(result.command, "image_upscale");
  assert.deepEqual(result.images, ["https://cdn/u1.png"]);
  assert.deepEqual(env.harness.calls[0].args, ["image_upscale", "--image=" + input, "--resolution_type=4k", "--poll=600"]);
  assert.equal(fs.existsSync(input), false);
});

test("E8 · storeOutputs：无 URL 时轮询 query_result 直到拿到 URL", async () => {
  let queryCount = 0;
  const env = setup({ advanceSleep: true, exe: EXE, handler: (record) => {
    if (record.args[0] === "query_result") {
      queryCount += 1;
      if (queryCount === 1) return { stdout: JSON.stringify({ submit_id: "q1", gen_status: "running" }) };
      return { stdout: JSON.stringify({ submit_id: "q1", images: ["https://cdn/q1.png"] }) };
    }
    return { stdout: JSON.stringify({ submit_id: "q1" }) };
  } });
  const urls = await agentCli.storeOutputs({ submit_id: "q1" }, "image");
  assert.deepEqual(urls, ["https://cdn/q1.png"]);
  assert.equal(queryCount, 2);
  assert.deepEqual(env.harness.calls[1].args, ["query_result", "--submit_id=q1", "--download_dir=" + env.outputDir]);
});

test("E9 · sharp：惰性加载成功走 metadata；缺失给 SHARP_UNAVAILABLE 结构化错误；生成侧回退比例", async () => {
  setup({ exe: "", sharpLoader: () => () => ({ metadata: async () => ({ autoOrient: { width: 1080, height: 1920 } }) }) });
  assert.deepEqual(agentCli.probeSharp(), { ok: true, available: true });
  assert.equal(await agentCli.jimengReferenceImageRatio("/x.png"), "9:16");

  setup({ exe: "", sharpLoader: () => { throw new Error("MODULE_NOT_FOUND sharp"); } });
  const probe = agentCli.probeSharp();
  assert.equal(probe.ok, false);
  assert.equal(probe.error, "SHARP_UNAVAILABLE");
  assert.match(probe.detail, /sharp/);
  await assert.rejects(agentCli.jimengReferenceImageRatio("/x.png"), (error) => {
    assert.equal(error.code, "SHARP_UNAVAILABLE");
    return true;
  });

  const env3 = setup({ exe: EXE, handler: jsonHandler({ submit_id: "s", images: ["https://cdn/s.png"] }), sharpLoader: () => { throw new Error("no sharp"); } });
  const refPath = nodePath.join(env3.dataDir, "r.png");
  fs.writeFileSync(refPath, Buffer.from([1]));
  const result = await agentCli.generateJimengImage("cat", "jimeng-4.6", "1024x1024", [refPath]);
  assert.equal(result.images[0], "https://cdn/s.png");
  assert.equal(env3.harness.calls[0].args.includes("--ratio=1:1"), true, "sharp 缺失时回退 ratioFromSize");
});
