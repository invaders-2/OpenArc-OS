/**
 * CLI-2 · agent CLI 桥 / 小云雀工具桥离线回归测试。
 *
 * 覆盖：依赖探测 CLI_UNAVAILABLE、codex/gemini(agy) 参数拼装、超时、取消、非零退出、
 * --output-last-message 与 JSON 输出解析、antigravity 模型列表边界样例、
 * pippit 登录态 / 积分解析 / 图片·视频参数拼装 / 任务续查。
 *
 * 全部离线：which/spawn/spawnSync 都是假实现，不执行任何真实 CLI，不联网，
 * 只在 os.tmpdir() 下的临时目录里落少量测试文件。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const bridge = require("../electron/agent-cli-bridge.cjs");
const pippit = require("../electron/agent-pippit-tools.cjs");

const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeTempFile(dir, name, text) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, text);
  return target;
}

/** 假子进程：stdout/stderr 用 PassThrough，close/error 可手动或微任务触发。 */
function fakeChild({ stdout = "", stderr = "", code = 0, autoClose = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const stdin = { chunks: [], ended: false, write(chunk) { this.chunks.push(String(chunk)); return true; }, end() { this.ended = true; } };
  child.stdin = stdin;
  child.exitCode = null;
  child.killed = false;
  child.unrefCalls = 0;
  child.kill = () => { child.killed = true; child.exitCode = 1; return true; };
  child.unref = () => { child.unrefCalls += 1; };
  if (autoClose) {
    queueMicrotask(() => {
      if (stderr) child.stderr.write(stderr);
      if (stdout) child.stdout.write(stdout);
      child.exitCode = code;
      child.emit("close", code);
    });
  }
  return child;
}

/** 按 argv 路由到不同假子进程，并记录每次 spawn 的参数。 */
function routingSpawn(routes) {
  const calls = [];
  const children = [];
  const spawnImpl = (command, argv, spawnOptions) => {
    calls.push({ command, argv, options: spawnOptions });
    const route = routes.find((item) => (item.match ? item.match(command, argv) : true)) || { stdout: "", code: 0 };
    const child = route.child || fakeChild(route);
    children.push(child);
    return child;
  };
  return { spawnImpl, calls, children };
}

function bridgeFixture(options = {}) {
  const dataDir = tempDir("oa-cli2-data-");
  const workspace = tempDir("oa-cli2-ws-");
  const home = tempDir("oa-cli2-home-");
  bridge.resetAgentCliBridgeForTests();
  bridge.configureAgentCliBridge({
    spawnImpl: options.spawnImpl || ((command, argv) => fakeChild({ stdout: "" })),
    whichImpl: (command) => (options.which && options.which[command]) || "",
    dataDir,
    workspace,
    homedirImpl: () => home,
    env: options.env || {},
    platform: options.platform || "darwin",
    clock: options.clock || (() => 1700000000000),
    fetchImpl: options.fetchImpl,
  });
  return { dataDir, workspace, home };
}

function pippitFixture(options = {}) {
  const dataDir = tempDir("oa-pippit-data-");
  pippit.resetPippitToolsForTests();
  pippit.configurePippitTools({
    spawnImpl: options.spawnImpl || ((command, argv) => fakeChild({ stdout: "" })),
    spawnSyncImpl: options.spawnSyncImpl || (() => ({ status: 0, stdout: "", stderr: "" })),
    whichImpl: (command) => (options.which && options.which[command]) || "",
    dataDir,
    env: options.env || {},
    platform: options.platform || "darwin",
    bundledBin: options.bundledBin || path.join(dataDir, "no-such-bundled-cli"),
    clock: options.clock || (() => 1700000000000),
  });
  return { dataDir };
}

test("桥：未安装 CLI 时依赖探测返回 CLI_UNAVAILABLE，绝不假成功", () => {
  bridgeFixture({ which: {} });
  assert.equal(bridge.agentCliInstalled("codex"), false);
  assert.equal(bridge.agentCliInstalled("gemini"), false);
  assert.equal(bridge.agentCliRuntime("codex"), null);
  const probe = bridge.probeAgentCliDependency("codex");
  assert.equal(probe.ok, false);
  assert.equal(probe.error, "CLI_UNAVAILABLE");
  assert.match(probe.detail, /未找到 OpenAI Codex CLI/);
  assert.equal(probe.installed, false);
  assert.equal(bridge.isCliUnavailable(probe), true);
  const geminiProbe = bridge.probeAgentCliDependency("gemini");
  assert.equal(geminiProbe.ok, false);
  assert.equal(geminiProbe.error, "CLI_UNAVAILABLE");
  assert.match(geminiProbe.detail, /Gemini \/ Antigravity/);
  assert.equal(geminiProbe.installed, false);
  assert.equal(bridge.isCliUnavailable(geminiProbe), true);
});

test("桥：codex exec 参数拼装与 --output-last-message 输出解析", async () => {
  const imagePath = writeTempFile(tempDir("oa-cli2-img-"), "ref.png", "x");
  const calls = [];
  const children = [];
  const spawnImpl = (command, argv, spawnOptions) => {
    calls.push({ command, argv, options: spawnOptions });
    const marker = argv.indexOf("--output-last-message");
    if (marker >= 0) fs.writeFileSync(argv[marker + 1], "\uFEFF最终回答");
    const child = fakeChild({ stdout: "raw-stdout", code: 0 });
    children.push(child);
    return child;
  };
  const fixture = bridgeFixture({ which: { codex: "/fake/codex" }, spawnImpl });
  const result = await bridge.runAgentCliChat("codex", "写个函数", "gpt-5.5", 60000, { allowTools: true, imagePaths: [imagePath] });

  assert.equal(calls[0].command, "/fake/codex");
  assert.deepEqual(calls[0].argv.slice(0, 6), ["exec", "-C", fixture.workspace, "--sandbox", "workspace-write", "--skip-git-repo-check"]);
  assert.deepEqual(calls[0].argv.slice(6, 8), ["--model", "gpt-5.5"]);
  assert.deepEqual(calls[0].argv.slice(8, 10), ["--image", imagePath]);
  assert.equal(calls[0].argv[calls[0].argv.length - 1], "-");
  assert.equal(calls[0].options.cwd, fixture.workspace);
  assert.equal(children[0].stdin.chunks.join(""), "写个函数");
  assert.equal(children[0].stdin.ended, true);
  assert.equal(result.text, "最终回答");
  assert.equal(result.raw.code, 0);
});

test("桥：codex 只读模式与 gpt-image 模型不写 --model", async () => {
  const { spawnImpl, calls } = routingSpawn([{ stdout: "ok" }]);
  bridgeFixture({ which: { codex: "/fake/codex" }, spawnImpl });
  await bridge.runAgentCliChat("codex", "hi", "gpt-image-2", 30000);
  assert.ok(calls[0].argv.includes("--sandbox"));
  assert.equal(calls[0].argv[calls[0].argv.indexOf("--sandbox") + 1], "read-only");
  assert.equal(calls[0].argv.includes("--model"), false);
});

test("桥：codex 登录态与版本字段（agentCliStatus）", async () => {
  const { spawnImpl } = routingSpawn([
    { match: (command, argv) => argv[0] === "--version", stdout: "codex 1.2.3" },
    { match: (command, argv) => argv[0] === "login", stdout: "Logged in" },
  ]);
  bridgeFixture({ which: { codex: "/fake/codex" }, spawnImpl });
  const probed = bridge.probeAgentCliDependency("codex");
  assert.equal(probed.ok, true);
  assert.equal(probed.installed, true);
  assert.equal(bridge.isCliUnavailable(probed), false);
  const status = await bridge.agentCliStatus("codex");
  assert.equal(status.installed, true);
  assert.equal(status.logged_in, true);
  assert.equal(status.cli_version, "1.2.3");
  assert.equal(status.login_verified_by, "cli");
  assert.equal(status.runtime.provider, "codex");
});

test("桥：gemini(agy) 参数拼装与 JSON 输出解析", async () => {
  const { spawnImpl, calls } = routingSpawn([{ stdout: JSON.stringify({ response: "你好" }) }]);
  bridgeFixture({ which: { agy: "/fake/agy" }, spawnImpl });

  const first = await bridge.runAgentCliChat("gemini", "讲个笑话", "", 60000);
  assert.equal(calls[0].command, "/fake/agy");
  assert.deepEqual(calls[0].argv, ["--print-timeout", "60s", "-p", "讲个笑话"]);
  assert.equal(first.text, "你好");

  const second = await bridge.runAgentCliChat("gemini", "p", "gemini-x", 30000, { allowTools: true });
  assert.deepEqual(calls[1].argv, ["--print-timeout", "30s", "--model", "gemini-x", "--dangerously-skip-permissions", "-p", "p"]);
  assert.equal(second.text, "你好");
});

test("桥：gemini 原生 CLI 参数拼装（非 agy）", async () => {
  const { spawnImpl, calls } = routingSpawn([{ stdout: "plain answer" }]);
  bridgeFixture({ env: { GEMINI_BIN: "/fake/gemini" }, spawnImpl });
  const result = await bridge.runAgentCliChat("gemini", "hello", "", 15000);
  assert.equal(calls[0].command, "/fake/gemini");
  assert.deepEqual(calls[0].argv, ["--output-format", "json", "--skip-trust", "--prompt", "hello"]);
  assert.equal(result.text, "plain answer");
});

test("桥：超时会 kill 子进程并以错误 reject", async () => {
  const child = fakeChild({ autoClose: false });
  bridgeFixture({ which: { agy: "/fake/agy" }, spawnImpl: () => child });
  await assert.rejects(bridge.runAgentCliChat("gemini", "p", "", 25), /执行超时/);
  assert.equal(child.killed, true);
});

test("桥：AbortSignal 取消会 kill 子进程并带 ABORT_ERR", async () => {
  const child = fakeChild({ autoClose: false });
  bridgeFixture({ which: { agy: "/fake/agy" }, spawnImpl: () => child });
  const controller = new AbortController();
  const pending = bridge.runAgentCliChat("gemini", "p", "", 60000, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "ABORT_ERR");
    assert.match(error.message, /调用已取消/);
    return true;
  });
  assert.equal(child.killed, true);
});

test("桥：非零退出抛出调用失败并带上 stderr", async () => {
  const { spawnImpl } = routingSpawn([{ stdout: "", stderr: "boom", code: 1 }]);
  bridgeFixture({ which: { agy: "/fake/agy" }, spawnImpl });
  await assert.rejects(bridge.runAgentCliChat("gemini", "p", "", 5000), (error) => {
    assert.match(error.message, /调用失败/);
    assert.match(error.message, /boom/);
    return true;
  });
});

test("桥：parseAntigravityModels 边界样例", () => {
  const parse = bridge.parseAntigravityModels;
  assert.deepEqual(parse({ stdout: '["gemini-2.5-pro",{"id":"claude-3-opus"},"bad model!"]', stderr: "", code: 0 }).models, ["gemini-2.5-pro", "claude-3-opus"]);
  assert.deepEqual(parse({ stdout: JSON.stringify({ models: [{ model: "gpt-5" }] }), stderr: "", code: 0 }).models, ["gpt-5"]);
  assert.deepEqual(parse({ stdout: JSON.stringify({ data: ["gemini-2.0-flash"] }), stderr: "", code: 0 }).models, ["gemini-2.0-flash"]);
  const table = parse({ stdout: "\u001b[32m│ gemini-2.5-flash │ 说明\n* claude-3-7-sonnet\n│ not-a-model\n", stderr: "", code: 0 });
  assert.deepEqual(table.models, ["gemini-2.5-flash", "claude-3-7-sonnet"]);
  assert.deepEqual(parse({ stdout: '["gemini-x","gemini-x"]', stderr: "", code: 0 }).models, ["gemini-x"]);
  const authRequired = parse({ stdout: "", stderr: "Please sign in to view available models", code: 1 });
  assert.equal(authRequired.loggedIn, false);
  assert.deepEqual(authRequired.models, []);
  assert.match(authRequired.reason, /登录/);
  assert.equal(parse({ stdout: "", stderr: "network error", code: 1 }).loggedIn, null);
  const empty = parse({ stdout: "nothing here", stderr: "", code: 0 });
  assert.equal(empty.loggedIn, null);
  assert.match(empty.reason, /未返回可识别/);
});

test("桥：agentCliModels('gemini') 经 agy 解析、标记 cli-models 并缓存", async () => {
  const { spawnImpl, calls } = routingSpawn([
    { match: (command, argv) => argv[0] === "models", stdout: JSON.stringify([{ id: "gemini-2.5-pro" }, { id: "claude-3-7" }]) },
  ]);
  bridgeFixture({ which: { agy: "/fake/agy" }, spawnImpl });

  const first = await bridge.agentCliModels("gemini");
  assert.deepEqual(first.models, ["auto", "gemini-2.5-pro", "claude-3-7"]);
  assert.equal(first.source, "cli-models");
  assert.equal(first.cached, false);
  assert.equal(first.count, 3);
  assert.ok(first.model_items.every((item) => item.verified_by === "cli-models"));
  assert.deepEqual(first.chat_models, ["auto", "gemini-2.5-pro", "claude-3-7"]);

  const second = await bridge.agentCliModels("gemini");
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1, "缓存命中后不应再次 spawn");
  assert.equal(await bridge.agentCliDefaultModel("gemini"), "auto");
});

test("桥：agentCliModels('codex') 在无任何依赖时全离线回退默认目录", async () => {
  bridgeFixture({ which: {}, spawnImpl: () => { throw new Error("不应 spawn"); } });
  const catalog = await bridge.agentCliModels("codex");
  assert.deepEqual(catalog.models, ["gpt-5.5", "gpt-image-2"]);
  assert.equal(catalog.default_model, "gpt-5.5");
  assert.equal(catalog.source, "cli-defaults");
  assert.equal(catalog.image_source, "cli-defaults");
  assert.deepEqual(catalog.image_operations, ["image.generate", "image.edit"]);
});

test("桥：gptImageInvocation 尺寸升级与 provider 判定", () => {
  const codexFixture = bridgeFixture({ which: {}, env: {} });
  const codexInvocation = bridge.gptImageInvocation("", "1024x1024", "请给我 4K 大图", path.join(codexFixture.home, ".codex", "auth.json"));
  assert.equal(codexInvocation.provider, "codex");
  assert.equal(codexInvocation.model, "gpt-5.5");
  assert.equal(codexInvocation.size, "4K");

  bridgeFixture({ which: {}, env: { OPENAI_API_KEY: "sk-test" } });
  const openaiInvocation = bridge.gptImageInvocation("", "1024x1024", "请给我 4K 大图");
  assert.equal(openaiInvocation.provider, "openai");
  assert.equal(openaiInvocation.model, "gpt-image-2");
  assert.equal(openaiInvocation.size, "1024x1024");
});

test("桥：codexImageAuthEnv 仅在环境无 Key 时从 auth.json 提取", () => {
  const fixture = bridgeFixture({ which: {}, env: {} });
  const authPath = writeTempFile(fixture.dataDir, "auth.json", JSON.stringify({ OPENAI_API_KEY: "sk-abc" }));
  assert.deepEqual(bridge.codexImageAuthEnv(authPath), { OPENAI_API_KEY: "sk-abc" });

  bridgeFixture({ which: {}, env: { OPENAI_API_KEY: "sk-env" } });
  assert.deepEqual(bridge.codexImageAuthEnv(authPath), {});
});

/** 记录型 fetchImpl：统计每次调用的 URL / host；本文件所有桥测试都不应触发它。 */
function recordingFetch() {
  const calls = [];
  const fetchImpl = async (url) => {
    let host = "";
    try { host = new URL(String(url)).host; } catch { /* 非 URL 也照样记录 */ }
    calls.push({ url: String(url), host });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

test("桥：agentCliDownloadInfo 云分发已收口——任何配置都不发 fetch、不出现 api.dx-os.com", async () => {
  const expected = { ok: false, error: "AGENT_DEPENDENCY_UNAVAILABLE", detail: "下载端点属云分发（OUT）：本地模式无对端" };
  const { fetchImpl, calls } = recordingFetch();

  bridgeFixture({ which: {}, fetchImpl });
  assert.deepEqual(await bridge.agentCliDownloadInfo("codex"), expected);

  bridgeFixture({ which: {}, fetchImpl, env: { DX_SOFTWARE_API_URL: "https://api.dx-os.com" } });
  const cloud = await bridge.agentCliDownloadInfo("gemini");
  assert.deepEqual(cloud, expected);
  assert.equal(cloud.ok, false);
  assert.equal(cloud.error, "AGENT_DEPENDENCY_UNAVAILABLE");

  assert.equal(calls.length, 0, "本地模式不得发起任何下载请求");
  const hosts = calls.map((call) => call.host);
  assert.equal(hosts.includes("api.dx-os.com"), false, "host 统计里不应出现 api.dx-os.com");
  assert.equal(calls.filter((call) => call.url.includes("api.dx-os.com")).length, 0);
});

// ---------------------------------------------------------------------------
// 小云雀（pippit-tool-cli）桥
// ---------------------------------------------------------------------------

/** 按 args[0] 路由假 spawnSync，并记录每次调用。 */
function pippitSpawn(routes) {
  const calls = [];
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return routes[args[0]] || { status: 0, stdout: "{}", stderr: "" };
  };
  return { spawnSyncImpl, calls };
}

test("小云雀：未安装时依赖探测返回 CLI_UNAVAILABLE，状态不假成功", async () => {
  pippitFixture({ which: {} });
  assert.equal(pippit.pippitCliInstalled(), false);
  const probe = pippit.probePippitCliDependency();
  assert.equal(probe.ok, false);
  assert.equal(probe.installed, false);
  assert.equal(probe.error, "CLI_UNAVAILABLE");
  assert.equal(pippit.isCliUnavailable(probe), true);
  assert.match(probe.detail, /未检测到小云雀 CLI/);
  const status = await pippit.pippitStatus();
  assert.deepEqual(status, { installed: false, logged_in: false, cli_version: "", runtime: { path: "", mode: "missing", label: "未检测到" } });
});

test("小云雀：登录态与版本解析（pippitStatus）", async () => {
  const { spawnSyncImpl } = pippitSpawn({
    "--version": { status: 0, stdout: "0.9.1\n", stderr: "" },
    status: { status: 0, stdout: JSON.stringify({ logged_in: true, source: "keychain" }), stderr: "" },
  });
  pippitFixture({ which: { "pippit-tool-cli": "/fake/pippit" }, spawnSyncImpl });
  const status = await pippit.pippitStatus();
  assert.equal(status.installed, true);
  assert.equal(status.cli_version, "0.9.1");
  assert.equal(status.logged_in, true);
  assert.equal(status.source, "keychain");
  assert.equal(status.runtime.mode, "path");
  assert.deepEqual(status.raw, { logged_in: true, source: "keychain" });
});

test("小云雀：积分查询解析 total_remain_amount", async () => {
  const { spawnSyncImpl, calls } = pippitSpawn({
    "get-credit-balance": { status: 0, stdout: JSON.stringify({ total_remain_amount: 1234.5 }), stderr: "" },
  });
  pippitFixture({ which: { "pippit-tool-cli": "/fake/pippit" }, spawnSyncImpl });
  const credit = await pippit.pippitCredit();
  assert.equal(credit.success, true);
  assert.equal(credit.total_remain_amount, "1234.5");
  assert.deepEqual(credit.raw, { total_remain_amount: 1234.5 });
  assert.deepEqual(calls[0].args, ["get-credit-balance"]);

  pippitFixture({ which: { "pippit-tool-cli": "/fake/pippit" }, spawnSyncImpl: () => ({ status: 0, stdout: '{"foo":1}', stderr: "" }) });
  const empty = await pippit.pippitCredit();
  assert.equal(empty.total_remain_amount, "0");
});

test("小云雀：图片参数拼装与 resolution 归一", () => {
  assert.deepEqual(pippit.buildPippitImageArgs({ prompt: "a cat", model: "seedream_5.0_pro", ratio: "16:9", resolution: "2k", count: 3, images: ["i1", "i2"] }),
    ["generate-image", "--prompt", "a cat", "--model", "seedream_5.0_pro", "--ratio", "2", "--generate-image-count", "3", "--resolution", "2K", "--image", "i1", "--image", "i2"]);
  assert.equal(pippit.buildPippitImageArgs({ prompt: "p", model: "seedream_5.0", resolution: "2K" }).includes("--resolution"), false);
  assert.deepEqual(pippit.buildPippitImageArgs({ prompt: "p", model: "m", ratio: "original", count: 99 }),
    ["generate-image", "--prompt", "p", "--model", "m", "--ratio", "0", "--generate-image-count", "10"]);
  assert.equal(pippit.normalizePippitImageResolution("Seedream_5.0_Pro", "4k"), "4K");
  assert.equal(pippit.normalizePippitImageResolution("seedream_5.0", "4K"), undefined);
  assert.equal(pippit.normalizePippitImageResolution("seedream_5.0_pro", "8K"), undefined);
});

test("小云雀：视频 / 超分 / 去字幕参数拼装", () => {
  const videos = pippit.buildPippitVideoArgs({
    prompt: "v", model: "Seedance_2.5", duration: 99, generateType: 1,
    images: Array.from({ length: 12 }, (_, index) => "i" + index),
    videos: ["a", "b", "c", "d"], audios: ["x", "y", "z", "w"],
  });
  assert.deepEqual(videos.slice(0, 5), ["generate-video", "--prompt", "v", "--model", "Seedance_2.5"]);
  assert.equal(videos[videos.indexOf("--duration") + 1], "30");
  assert.equal(videos[videos.indexOf("--generate-type") + 1], "1");
  assert.equal(videos.filter((arg) => arg === "--image").length, 9);
  assert.equal(videos.filter((arg) => arg === "--video").length, 3);
  assert.equal(videos.filter((arg) => arg === "--audio").length, 3);

  const defaults = pippit.buildPippitVideoArgs({ prompt: "v", model: "m" });
  assert.equal(defaults[defaults.indexOf("--duration") + 1], "5");
  assert.equal(defaults[defaults.indexOf("--ratio") + 1], "16:9");
  assert.equal(defaults[defaults.indexOf("--resolution") + 1], "720p");

  assert.deepEqual(pippit.buildPippitVideoUpscaleArgs({ video: "v.mp4", outputResolution: "1080P" }),
    ["video-super-resolution", "--video", "v.mp4", "--output-resolution", "1080p"]);
  assert.deepEqual(pippit.buildPippitVideoUpscaleArgs({ video: "v.mp4", outputResolution: "2k", toolVersion: "t1" }),
    ["video-super-resolution", "--video", "v.mp4", "--output-resolution", "2k", "--tool-version", "t1"]);
  assert.deepEqual(pippit.buildPippitEraseVideoSubtitleArgs({ video: "v.mp4" }), ["erase-video-subtitle", "--video", "v.mp4"]);
});

test("小云雀：提交成功返回 thread/run，缺 run_id 时拒绝自动重试", async () => {
  const { spawnSyncImpl, calls } = pippitSpawn({
    "generate-image": { status: 0, stdout: JSON.stringify({ thread_id: "t1", run_id: "r1", web_thread_link: "https://x" }), stderr: "" },
  });
  pippitFixture({ which: { "pippit-tool-cli": "/fake/pippit" }, spawnSyncImpl });
  const submitted = await pippit.submitPippitImage({ prompt: "a cat", model: "seedream_5.0_pro", ratio: "16:9" });
  assert.equal(submitted.threadId, "t1");
  assert.equal(submitted.runId, "r1");
  assert.equal(submitted.webThreadLink, "https://x");
  assert.equal(calls[0].command, "/fake/pippit");
  assert.equal(calls[0].args[0], "generate-image");

  pippitFixture({
    which: { "pippit-tool-cli": "/fake/pippit" },
    spawnSyncImpl: () => ({ status: 0, stdout: '{"thread_id":"t1"}', stderr: "" }),
  });
  await assert.rejects(pippit.submitPippitImage({ prompt: "p", model: "m" }), /不会自动重试/);
});

test("小云雀：任务续查 queryPippitResult 参数与结果路径解析", async () => {
  const { spawnSyncImpl, calls } = pippitSpawn({
    "query-result": {
      status: 0,
      stdout: JSON.stringify({
        completed: true,
        images: [{ output_path: "/img/a.png" }, { download_url: "https://d/b.jpg" }, "/img/c.png", { nope: 1 }],
        videos: [{ output_path: "/vid/v.mp4" }],
        error_message: "x",
      }),
      stderr: "",
    },
  });
  const fixture = pippitFixture({ which: { "pippit-tool-cli": "/fake/pippit" }, spawnSyncImpl });
  const result = await pippit.queryPippitResult("thread-1", "run-1", "task/1");
  assert.equal(result.completed, true);
  assert.deepEqual(result.images, ["/img/a.png", "https://d/b.jpg", "/img/c.png"]);
  assert.deepEqual(result.videos, ["/vid/v.mp4"]);
  assert.equal(result.error, "x");
  const expectedDir = path.join(fixture.dataDir, "cli-output", "pippit", "task_1");
  assert.deepEqual(calls[0].args, ["query-result", "--thread-id", "thread-1", "--run-id", "run-1", "--download-dir", expectedDir]);
  assert.equal(fs.existsSync(expectedDir), true);

  await assert.rejects(pippit.queryPippitResult("", ""), /缺少 thread_id\/run_id/);
});

test("小云雀：parsePippitJson 边界（末行 JSON / 内嵌 JSON / 非对象）", () => {
  assert.deepEqual(pippit.parsePippitJson('log line\n{"a":1}'), { a: 1 });
  assert.deepEqual(pippit.parsePippitJson('prefix {"c":{"d":3}} suffix'), { c: { d: 3 } });
  assert.deepEqual(pippit.parsePippitJson('{"b":2}\ntrailing'), { b: 2 });
  assert.throws(() => pippit.parsePippitJson("no json"), (error) => error.message === "no json");
  assert.throws(() => pippit.parsePippitJson("[1,2]"), (error) => error.message === "[1,2]");
  assert.throws(() => pippit.parsePippitJson(""), (error) => /没有返回 JSON/.test(error.message));
});

test("小云雀：登录启动从 stderr 解析授权链接", async () => {
  const children = [];
  const spawnImpl = (command, argv) => {
    const child = fakeChild({ autoClose: false });
    children.push(child);
    queueMicrotask(() => {
      child.emit("spawn");
      child.stderr.write("https://xyq.jianying.com/cli/pippit-tool-login?code=abc\n");
    });
    return child;
  };
  let tick = 0;
  pippitFixture({ which: { "pippit-tool-cli": "/fake/pippit" }, spawnImpl, clock: () => (tick += 1000) });
  const started = await pippit.pippitLoginStart();
  assert.equal(started.started, true);
  assert.equal(started.running, true);
  assert.equal(started.terminal_opened, false);
  assert.equal(started.login_url, "https://xyq.jianying.com/cli/pippit-tool-login?code=abc");
  assert.equal(children.length, 1);
});

