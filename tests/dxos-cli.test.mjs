/**
 * DX OS 0.6.1 · CLI 域离线回归测试（不启动 Electron、不联网、不执行真实 CLI、不新增依赖）。
 *
 * 覆盖（对齐任务书验收）：
 *   ① 命令表即白名单：7 条登记命令，未登记一律 CLI_COMMAND_NOT_ALLOWED；
 *   ② 四个工具（codex / gemini / jimeng / pippit）的 installed 真 / 假两条路径；
 *   ③ 未安装 → CLI_UNAVAILABLE，detail 保留既有探测说明（探测过哪些路径）；
 *   ④ 工具不具备的子能力（codex/gemini 的 credit、gemini 的 logout）→ CLI_UNSUPPORTED；
 *   ⑤ 逐命令真实转发到既有出口（bridge / jimeng / pippit），不重写、不返回假数据；
 *   ⑥ trusted fail closed：缺 isTrusted / 伪造 sender 一律 Forbidden，且先于 bundle 判空；
 *   ⑦ 未认证：identity.current 为空 → CLI_UNAUTHENTICATED，且渲染层自报字段被忽略；
 *   ⑧ 未知异常由 dxos-foundation-errors 折叠为 DXOS_ERR_INTERNAL。
 *
 * 所有探查 / 执行出口都注入假实现，测试只验证"转发契约"和"如实失败"。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const domain = require("../electron/cli-domain.cjs");
const { createCliBundle } = require("../electron/cli-service.cjs");
const { registerCliIpc, disposeCliIpc } = require("../electron/cli-bootstrap.cjs");

const CLI_UNAVAILABLE = "CLI_UNAVAILABLE";

/** 未安装时既有出口的探测说明（与真实现文案口径一致，只做关键词断言）。 */
function probeDetail(tool) {
  if (tool === "codex") return "未找到 OpenAI Codex CLI（已探测 PATH / CODEX_BIN / ANTIGRAVITY_BIN / AGY_BIN / GEMINI_BIN）。";
  if (tool === "gemini") return "未找到 Gemini / Antigravity CLI（已探测 PATH / CODEX_BIN / ANTIGRAVITY_BIN / AGY_BIN / GEMINI_BIN）。";
  if (tool === "jimeng") return "dreamina：未找到可执行文件（探测方式：JIMENG_BIN/DREAMINA_BIN 环境变量 → 内置 cli-runtime/jimeng/bin/dreamina → whichImpl('dreamina' / 'dreamina.exe' / 'dreamina.cmd') → 非 Windows 不启用 WSL 分支）";
  return "未检测到小云雀 CLI（已探测 PIPPIT_CLI_BIN / 内置路径 / PATH 上的 pippit-tool-cli）。";
}

/**
 * 注入假出口。installed = { codex, gemini, jimeng, pippit } 控制安装态；
 * status/models/... 为对应工具的既有出口返回值（可含 Error 以模拟抛错）。
 */
function makeFakes(options = {}) {
  const installed = options.installed || {};
  const status = options.status || {};
  const models = options.models || {};
  const credit = options.credit || {};
  const loginStart = options.loginStart || {};
  const loginStatus = options.loginStatus || {};
  const logout = options.logout || {};
  const probeThrow = options.probeThrow || {};
  const calls = [];

  const bridge = {
    probeAgentCliDependency(tool) {
      calls.push(["probe", tool]);
      if (probeThrow[tool]) throw probeThrow[tool];
      if (installed[tool]) return { ok: true, installed: true, tool, runtime: { command: tool + "-bin", mode: "host", home: "home-" + tool, label: tool + " label", provider: tool, detail: tool + " runtime detail" } };
      return { ok: false, installed: false, error: CLI_UNAVAILABLE, detail: probeDetail(tool) };
    },
    agentCliInstalled: (tool) => !!installed[tool],
    async agentCliStatus(tool) { calls.push(["status", tool]); if (status[tool] instanceof Error) throw status[tool]; return status[tool]; },
    async agentCliModels(tool) { calls.push(["models", tool]); return models[tool]; },
    async agentCliLoginStart(tool) { calls.push(["loginStart", tool]); if (loginStart[tool] instanceof Error) throw loginStart[tool]; return loginStart[tool]; },
    async agentCliLoginStatus(tool) { calls.push(["loginStatus", tool]); return loginStatus[tool]; },
    async agentCliLogout(tool) { calls.push(["logout", tool]); return logout[tool]; },
  };

  const tools = {
    CLI_UNAVAILABLE,
    isCliUnavailable: (value) => !!value && typeof value === "object" && value.error === CLI_UNAVAILABLE,
    jimengCliInstalled: () => !!installed.jimeng,
    probeJimengCli() {
      calls.push(["jimengProbe"]);
      if (installed.jimeng) return { ok: true, installed: true, exe: "dreamina-bin", runtime: { mode: "path", path: "dreamina-bin", label: "本机 dreamina", detail: "使用本机 dreamina 登录态，无需 API Key。", home: "home-jimeng" } };
      return { ok: false, installed: false, error: CLI_UNAVAILABLE, detail: probeDetail("jimeng") };
    },
    async jimengStatus() { calls.push(["jimengStatus"]); if (status.jimeng instanceof Error) throw status.jimeng; return status.jimeng; },
    async jimengModels() { calls.push(["jimengModels"]); return models.jimeng; },
    async jimengCredit() { calls.push(["jimengCredit"]); if (credit.jimeng instanceof Error) throw credit.jimeng; return credit.jimeng; },
    async jimengLoginStart() { calls.push(["jimengLoginStart"]); return loginStart.jimeng; },
    async jimengLoginStatus() { calls.push(["jimengLoginStatus"]); return loginStatus.jimeng; },
    async jimengLogout() { calls.push(["jimengLogout"]); return logout.jimeng; },
  };

  const pippit = {
    CLI_UNAVAILABLE,
    isCliUnavailable: (value) => !!value && typeof value === "object" && value.error === CLI_UNAVAILABLE,
    pippitCliInstalled: () => !!installed.pippit,
    probePippitCliDependency() {
      calls.push(["pippitProbe"]);
      if (installed.pippit) return { ok: true, installed: true, runtime: { path: "pippit-bin", mode: "path", label: "本机 pippit-tool-cli" } };
      return { ok: false, installed: false, error: CLI_UNAVAILABLE, detail: probeDetail("pippit") };
    },
    async pippitStatus() { calls.push(["pippitStatus"]); return status.pippit; },
    async pippitModels() { calls.push(["pippitModels"]); return models.pippit; },
    async pippitCredit() { calls.push(["pippitCredit"]); if (credit.pippit instanceof Error) throw credit.pippit; return credit.pippit; },
    async pippitLoginStart() { calls.push(["pippitLoginStart"]); return loginStart.pippit; },
    async pippitLoginStatus() { calls.push(["pippitLoginStatus"]); return loginStatus.pippit; },
    async pippitLogout() { calls.push(["pippitLogout"]); return logout.pippit; },
  };

  return { bridge, tools, pippit, calls, bundle: createCliBundle({ bridge, tools, pippit }) };
}

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, fn) => { handlers.set(channel, fn); },
    removeHandler: (channel) => { handlers.delete(channel); },
    invoke: (channel, event, raw) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error("No handler registered: " + channel);
      return fn(event, raw);
    },
  };
}

// ── ① 命令表即白名单 ─────────────────────────────────────────────────────
test("命令表：7 条登记命令，未登记命令不是合法命令", () => {
  assert.equal(domain.CLI_COMMAND_ORDER.length, 7);
  assert.deepEqual(domain.CLI_COMMAND_ORDER, ["cli/list", "cli/status", "cli/models", "cli/credit", "cli/login/start", "cli/login/status", "cli/logout"]);
  for (const command of domain.CLI_COMMAND_ORDER) assert.equal(domain.isCliCommand(command), true, command + " 必须登记");
  assert.equal(domain.isCliCommand("cli/nope"), false);
  assert.equal(domain.isCliCommand(""), false);
  assert.equal(domain.isCliCommand(null), false);
  assert.equal(domain.listCliCommands().length, 7);
  const codes = [...domain.CLI_ERROR_CODES];
  for (const code of ["CLI_COMMAND_NOT_ALLOWED", "CLI_NOT_READY", "CLI_INVALID_INPUT", "CLI_UNAVAILABLE", "CLI_UNSUPPORTED", "CLI_FAILED", "CLI_UNAUTHENTICATED"]) {
    assert.ok(codes.includes(code), "缺少错误码 " + code);
  }
});

test("execute：未知命令回 CLI_COMMAND_NOT_ALLOWED，不落到任何出口", async () => {
  const f = makeFakes({ installed: {} });
  const result = await f.bundle.execute("cli/nope", {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "CLI_COMMAND_NOT_ALLOWED");
  assert.equal(f.calls.length, 0);
});

// ── ② 四工具 installed 真 / 假两条路径 ───────────────────────────────────
test("cli/list：四个工具全部未安装 → installed:false、version:null、detail 保留探测说明", async () => {
  const f = makeFakes({ installed: {} });
  const result = await f.bundle.execute("cli/list", {});
  assert.equal(result.ok, true);
  const tools = result.value.tools;
  assert.deepEqual(tools.map((tool) => tool.id), ["codex", "gemini", "jimeng", "pippit"]);
  for (const tool of tools) {
    assert.equal(tool.installed, false, tool.id + " 未安装");
    assert.equal(tool.version, null);
    assert.equal(tool.loginRequired, true);
    assert.ok(Array.isArray(tool.capabilities) && tool.capabilities.length > 0);
  }
  assert.match(tools.find((tool) => tool.id === "codex").detail, /CODEX_BIN/);
  assert.match(tools.find((tool) => tool.id === "gemini").detail, /GEMINI_BIN/);
  assert.match(tools.find((tool) => tool.id === "jimeng").detail, /JIMENG_BIN/);
  assert.match(tools.find((tool) => tool.id === "pippit").detail, /PIPPIT_CLI_BIN/);
  // 未安装不得伪造版本 / 安装态。
  assert.ok(tools.every((tool) => tool.version === null && tool.installed === false));
});

test("cli/list：四个工具全部安装 → installed:true，能力集合逐工具不同", async () => {
  const f = makeFakes({ installed: { codex: true, gemini: true, jimeng: true, pippit: true } });
  const result = await f.bundle.execute("cli/list", {});
  const byId = Object.fromEntries(result.value.tools.map((tool) => [tool.id, tool]));
  for (const id of ["codex", "gemini", "jimeng", "pippit"]) assert.equal(byId[id].installed, true, id + " 已安装");
  assert.deepEqual(byId.codex.capabilities, ["status", "models", "login/start", "login/status", "logout"]);
  assert.deepEqual(byId.gemini.capabilities, ["status", "models", "login/start", "login/status"]);
  assert.deepEqual(byId.jimeng.capabilities, ["status", "models", "credit", "login/start", "login/status", "logout"]);
  assert.deepEqual(byId.pippit.capabilities, ["status", "models", "credit", "login/start", "login/status", "logout"]);
  assert.equal(byId.codex.capabilities.includes("credit"), false);
  assert.equal(byId.gemini.capabilities.includes("logout"), false);
});

test("cli/status：未安装 → installed:false、loggedIn:null，detail 保留探测路径", async () => {
  const f = makeFakes({ installed: {} });
  for (const tool of ["codex", "gemini", "jimeng", "pippit"]) {
    const result = await f.bundle.execute("cli/status", { tool });
    assert.equal(result.ok, true, tool);
    assert.equal(result.value.installed, false);
    assert.equal(result.value.version, null);
    assert.equal(result.value.loggedIn, null);
    assert.match(result.value.detail, /探测|未找到|未检测到/);
  }
});

test("cli/status：四个工具安装后逐工具返回真实版本 / 登录态 / runtime", async () => {
  const f = makeFakes({
    installed: { codex: true, gemini: true, jimeng: true, pippit: true },
    status: {
      codex: { installed: true, logged_in: true, cli_version: "1.2.3", runtime: { label: "codex label", path: "codex-bin", mode: "host", home: "home-codex", provider: "codex" }, message: "Codex 已安装" },
      gemini: { installed: true, logged_in: null, cli_version: "2.0.0", runtime: { label: "gemini label", path: "gemini-bin", mode: "host", home: "home-gemini", provider: "gemini" }, message: "Gemini 已安装；登录状态执行时校验" },
      jimeng: { installed: true, logged_in: false, cli_version: "1.4.2", runtime: { mode: "path", path: "dreamina-bin", label: "本机 dreamina", home: "home-jimeng" }, message: "未登录" },
      pippit: { installed: true, logged_in: true, cli_version: "0.1.0", runtime: { path: "pippit-bin", mode: "path", label: "本机 pippit-tool-cli" }, message: "小云雀已登录" },
    },
  });
  const codex = await f.bundle.execute("cli/status", { tool: "codex" });
  assert.equal(codex.value.version, "1.2.3");
  assert.equal(codex.value.loggedIn, true);
  assert.equal(codex.value.runtime.command, "codex-bin");
  assert.equal(codex.value.runtime.mode, "host");
  assert.equal(codex.value.runtime.home, "home-codex");
  assert.equal(codex.value.runtime.label, "codex label");
  assert.equal(codex.value.runtime.provider, "codex");

  const gemini = await f.bundle.execute("cli/status", { tool: "gemini" });
  assert.equal(gemini.value.loggedIn, null, "gemini 登录态未知必须是 null，不得伪造 false");

  const jimeng = await f.bundle.execute("cli/status", { tool: "jimeng" });
  assert.equal(jimeng.value.version, "1.4.2");
  assert.equal(jimeng.value.loggedIn, false);
  assert.equal(jimeng.value.runtime.command, "dreamina-bin");
  assert.equal(jimeng.value.runtime.provider, "jimeng");

  const pippit = await f.bundle.execute("cli/status", { tool: "pippit" });
  assert.equal(pippit.value.version, "0.1.0");
  assert.equal(pippit.value.loggedIn, true);
  assert.equal(pippit.value.runtime.command, "pippit-bin");
});

test("cli/status / cli/models / cli/credit：tool 非法 → CLI_INVALID_INPUT", async () => {
  const f = makeFakes({ installed: {} });
  for (const command of ["cli/status", "cli/models", "cli/credit", "cli/login/start", "cli/login/status", "cli/logout"]) {
    const missing = await f.bundle.execute(command, {});
    assert.equal(missing.ok, false, command);
    assert.equal(missing.error, "CLI_INVALID_INPUT", command);
    const bogus = await f.bundle.execute(command, { tool: "not-a-tool" });
    assert.equal(bogus.error, "CLI_INVALID_INPUT", command);
  }
});

// ── ③ 未安装 → CLI_UNAVAILABLE（detail 有探测路径）────────────────────────
test("未安装：models / credit / login / logout 一律 CLI_UNAVAILABLE 且 detail 含探测路径", async () => {
  const f = makeFakes({ installed: {} });
  const cases = [
    ["cli/models", { tool: "codex" }],
    ["cli/models", { tool: "jimeng" }],
    ["cli/credit", { tool: "jimeng" }],
    ["cli/credit", { tool: "pippit" }],
    ["cli/login/start", { tool: "pippit" }],
    ["cli/login/status", { tool: "jimeng" }],
    ["cli/logout", { tool: "codex" }],
  ];
  for (const [command, payload] of cases) {
    const result = await f.bundle.execute(command, payload);
    assert.equal(result.ok, false, command + " / " + payload.tool);
    assert.equal(result.error, "CLI_UNAVAILABLE", command + " / " + payload.tool);
    assert.ok(typeof result.detail === "string" && result.detail.length > 0, command + " 必须带 detail");
    assert.match(result.detail, /PATH|CODEX_BIN|JIMENG_BIN|PIPPIT_CLI_BIN|GEMINI_BIN|探测/);
  }
});

// ── ④ 不支持的子能力 → CLI_UNSUPPORTED ──────────────────────────────────
test("CLI_UNSUPPORTED：codex/gemini 没有 credit，gemini 没有 logout", async () => {
  const f = makeFakes({ installed: { codex: true, gemini: true, jimeng: true, pippit: true } });
  const codexCredit = await f.bundle.execute("cli/credit", { tool: "codex" });
  assert.equal(codexCredit.ok, false);
  assert.equal(codexCredit.error, "CLI_UNSUPPORTED");
  const geminiCredit = await f.bundle.execute("cli/credit", { tool: "gemini" });
  assert.equal(geminiCredit.error, "CLI_UNSUPPORTED");
  const geminiLogout = await f.bundle.execute("cli/logout", { tool: "gemini" });
  assert.equal(geminiLogout.ok, false);
  assert.equal(geminiLogout.error, "CLI_UNSUPPORTED");
  // 不支持的子能力不得落到积分 / 登出出口，也不得伪造成功。
  assert.equal(f.calls.some((call) => call[0] === "jimengCredit" || call[0] === "pippitCredit" || call[0] === "logout"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(geminiLogout, "loggedOut"), false);
});

// ── ⑤ 逐命令真实转发既有出口 ─────────────────────────────────────────────
test("cli/models：codex 实时目录逐字转发（model_items → {id,name}，cached 透传）", async () => {
  const f = makeFakes({
    installed: { codex: true },
    models: { codex: { models: ["gpt-5.5", "gpt-image-2"], model_items: [{ model: "gpt-5.5", name: "GPT 5.5", type: "llm" }, { model: "gpt-image-2", type: "image" }], cached: true } },
  });
  const result = await f.bundle.execute("cli/models", { tool: "codex" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.models, [{ id: "gpt-5.5", name: "GPT 5.5" }, { id: "gpt-image-2", name: "gpt-image-2" }]);
  assert.equal(result.value.cached, true);
  assert.ok(f.calls.some((call) => call[0] === "models" && call[1] === "codex"));
});

test("cli/models：gemini / 即梦 / 小云雀各自走既有出口", async () => {
  const f = makeFakes({
    installed: { gemini: true, jimeng: true, pippit: true },
    models: {
      gemini: { models: ["auto", "gemini-3.1-flash-image"], cached: false },
      jimeng: { models: ["jimeng-5.0Pro", "seedance2.0fast"], source: "fallback", cached: true },
      pippit: { models: ["seedream_5.0_pro", "Seedance_2.5"], model_items: [{ model: "seedream_5.0_pro", type: "image" }, { model: "Seedance_2.5", type: "video" }] },
    },
  });
  const gemini = await f.bundle.execute("cli/models", { tool: "gemini" });
  assert.deepEqual(gemini.value.models, [{ id: "auto", name: "auto" }, { id: "gemini-3.1-flash-image", name: "gemini-3.1-flash-image" }]);
  const jimeng = await f.bundle.execute("cli/models", { tool: "jimeng" });
  assert.deepEqual(jimeng.value.models, [{ id: "jimeng-5.0Pro", name: "jimeng-5.0Pro" }, { id: "seedance2.0fast", name: "seedance2.0fast" }]);
  assert.equal(jimeng.value.cached, true);
  const pippit = await f.bundle.execute("cli/models", { tool: "pippit" });
  assert.deepEqual(pippit.value.models, [{ id: "seedream_5.0_pro", name: "seedream_5.0_pro" }, { id: "Seedance_2.5", name: "Seedance_2.5" }]);
  assert.ok(f.calls.some((call) => call[0] === "jimengModels"));
  assert.ok(f.calls.some((call) => call[0] === "pippitModels"));
});

test("cli/models：即梦出口中途回 CLI_UNAVAILABLE 时不伪造目录", async () => {
  const f = makeFakes({ installed: { jimeng: true } });
  f.tools.jimengModels = async () => ({ ok: false, error: CLI_UNAVAILABLE, detail: "dreamina：未找到可执行文件（探测方式：JIMENG_BIN/DREAMINA_BIN）" });
  const result = await f.bundle.execute("cli/models", { tool: "jimeng" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "CLI_UNAVAILABLE");
  assert.match(result.detail, /JIMENG_BIN/);
});

test("cli/credit：即梦 / 小云雀积分逐字转发，其余工具 CLI_UNSUPPORTED", async () => {
  const f = makeFakes({
    installed: { jimeng: true, pippit: true, codex: true },
    credit: {
      jimeng: { success: true, available: true, logged_in: true, raw: { total_credit: 1234 } },
      pippit: { success: true, total_remain_amount: "42", raw: { total_remain_amount: "42" } },
    },
  });
  const jimeng = await f.bundle.execute("cli/credit", { tool: "jimeng" });
  assert.equal(jimeng.ok, true);
  assert.equal(jimeng.value.credit.raw.total_credit, 1234);
  const pippit = await f.bundle.execute("cli/credit", { tool: "pippit" });
  assert.equal(pippit.value.credit.total_remain_amount, "42");
  assert.ok(f.calls.some((call) => call[0] === "jimengCredit"));
  assert.ok(f.calls.some((call) => call[0] === "pippitCredit"));
});

test("cli/login/start：即梦回浏览器授权链接 + 设备码，不假装已登录", async () => {
  const f = makeFakes({
    installed: { jimeng: true },
    loginStart: { jimeng: { success: true, running: true, login_url: "https://jimeng.example/login?qr=1", qr_url: "https://jimeng.example/login?qr=1", user_code: "USER-1234", device_code: "DEV-5678", text: "请在浏览器中完成授权" } },
  });
  const result = await f.bundle.execute("cli/login/start", { tool: "jimeng" });
  assert.equal(result.ok, true);
  assert.equal(result.value.tool, "jimeng");
  assert.equal(result.value.started, true);
  assert.equal(result.value.url, "https://jimeng.example/login?qr=1");
  assert.equal(result.value.code, "USER-1234");
  assert.match(result.value.detail, /浏览器/);
  assert.equal(Object.prototype.hasOwnProperty.call(result.value, "loggedIn"), false);
});

test("cli/login/start：小云雀回浏览器授权链接", async () => {
  const f = makeFakes({
    installed: { pippit: true },
    loginStart: { pippit: { started: true, running: true, login_url: "https://xyq.jianying.com/cli/pippit-tool-login?code=abc", text: "小云雀登录页面已生成，请在浏览器中完成授权。" } },
  });
  const result = await f.bundle.execute("cli/login/start", { tool: "pippit" });
  assert.equal(result.value.started, true);
  assert.equal(result.value.url, "https://xyq.jianying.com/cli/pippit-tool-login?code=abc");
  assert.match(result.value.detail, /浏览器/);
});

test("cli/login/start：codex 在当前平台要求系统终端 → CLI_FAILED（不伪装 started）", async () => {
  const f = makeFakes({ installed: { codex: true }, loginStart: { codex: new Error("当前版本请先在系统终端中运行 CLI 完成登录") } });
  const result = await f.bundle.execute("cli/login/start", { tool: "codex" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "CLI_FAILED");
  assert.match(result.message, /系统终端/);
});

test("cli/login/status：authorized / pending / failed / idle 四态", async () => {
  const f = makeFakes({
    installed: { codex: true, gemini: true, jimeng: true, pippit: true },
    loginStatus: {
      codex: { logged_in: true, running: false, text: "已登录" },
      gemini: { logged_in: false, running: true, text: "等待授权中" },
      jimeng: { logged_in: false, running: false, error: "登录进程提前退出" },
      pippit: { logged_in: false, running: false, text: "当前不在登录流程中" },
    },
  });
  assert.equal((await f.bundle.execute("cli/login/status", { tool: "codex" })).value.status, "authorized");
  assert.equal((await f.bundle.execute("cli/login/status", { tool: "gemini" })).value.status, "pending");
  assert.equal((await f.bundle.execute("cli/login/status", { tool: "jimeng" })).value.status, "failed");
  assert.equal((await f.bundle.execute("cli/login/status", { tool: "pippit" })).value.status, "idle");
});

test("cli/logout：codex / 即梦 / 小云雀成功回 loggedOut:true；失败回 CLI_FAILED", async () => {
  const f = makeFakes({
    installed: { codex: true, jimeng: true, pippit: true },
    logout: {
      codex: { success: true },
      jimeng: { success: true, raw: {} },
      pippit: { success: true },
    },
  });
  for (const tool of ["codex", "jimeng", "pippit"]) {
    const result = await f.bundle.execute("cli/logout", { tool });
    assert.equal(result.ok, true, tool);
    assert.equal(result.value.loggedOut, true, tool);
  }
  const failing = makeFakes({ installed: { codex: true }, logout: { codex: { success: false, message: "退出失败" } } });
  const failure = await failing.bundle.execute("cli/logout", { tool: "codex" });
  assert.equal(failure.ok, false);
  assert.equal(failure.error, "CLI_FAILED");
  assert.equal(Object.prototype.hasOwnProperty.call(failure, "loggedOut"), false);
});

// ── ⑧ 未知异常折叠为 DXOS_ERR_INTERNAL ───────────────────────────────────
test("未知异常：探测出口抛出未预期异常 → DXOS_ERR_INTERNAL", async () => {
  const f = makeFakes({ installed: { codex: true }, probeThrow: { codex: new TypeError("probe exploded") } });
  const result = await f.bundle.execute("cli/status", { tool: "codex" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DXOS_ERR_INTERNAL");
  assert.equal(domain.normalizeCliError(new Error("boom")).error, "DXOS_ERR_INTERNAL");
  assert.equal(domain.normalizeCliError({ code: "ENOENT", message: "no such file" }).detail.causeCode, "ENOENT");
});

// ── ⑥ / ⑦ bootstrap：trusted fail closed + 未认证 + 白名单 ────────────────
test("bootstrap：缺 isTrusted / isTrusted=false 一律 Forbidden（fail closed，先于 bundle 判空）", async () => {
  const f = makeFakes({ installed: {} });
  const trustedEvent = { sender: {}, senderFrame: { url: "file:///app/index.html" } };
  const noTrust = createIpcMain();
  registerCliIpc(noTrust, { bundle: f.bundle, identity: { current: { sessionRef: "s1" } } });
  await assert.rejects(() => noTrust.invoke("cli:command", trustedEvent, { command: "cli/list" }), /Forbidden/);

  const deny = createIpcMain();
  registerCliIpc(deny, { bundle: f.bundle, identity: { current: { sessionRef: "s1" } }, isTrusted: () => false });
  await assert.rejects(() => deny.invoke("cli:command", trustedEvent, { command: "cli/list" }), /Forbidden/);

  // trusted 先于 bundle 判空：bundle 缺失 + 非 trusted → 仍 Forbidden。
  const noBundle = createIpcMain();
  registerCliIpc(noBundle, { bundle: null, isTrusted: () => false });
  await assert.rejects(() => noBundle.invoke("cli:command", trustedEvent, { command: "cli/list" }), /Forbidden/);

  // trusted 通过但 bundle 缺失 → 稳定的 CLI_NOT_READY（不注册半成品 handler）。
  const ready = createIpcMain();
  registerCliIpc(ready, { bundle: null, isTrusted: (event) => event === trustedEvent });
  const allowed = await ready.invoke("cli:command", trustedEvent, { command: "cli/list" });
  assert.equal(allowed.ok, false);
  assert.equal(allowed.error, "CLI_NOT_READY");
});

test("bootstrap：未认证 → CLI_UNAUTHENTICATED，渲染层自报身份字段被忽略", async () => {
  const f = makeFakes({ installed: {} });
  const event = { sender: {}, senderFrame: { url: "file:///app/index.html" } };
  const isTrusted = () => true;

  const noIdentity = createIpcMain();
  registerCliIpc(noIdentity, { bundle: f.bundle, isTrusted });
  const first = await noIdentity.invoke("cli:command", event, { command: "cli/list", userId: "admin", role: "ADMIN", sessionRef: "forged" });
  assert.equal(first.ok, false);
  assert.equal(first.error, "CLI_UNAUTHENTICATED");

  const emptySession = createIpcMain();
  registerCliIpc(emptySession, { bundle: f.bundle, identity: { current: null }, isTrusted });
  const second = await emptySession.invoke("cli:command", event, { command: "cli/list", sessionRef: "forged" });
  assert.equal(second.error, "CLI_UNAUTHENTICATED");

  const authenticated = createIpcMain();
  registerCliIpc(authenticated, { bundle: f.bundle, identity: { current: { sessionRef: "real-session", userId: "u1" } }, isTrusted });
  const third = await authenticated.invoke("cli:command", event, { command: "cli/list" });
  assert.equal(third.ok, true);
  assert.deepEqual(third.value.tools.map((tool) => tool.id), ["codex", "gemini", "jimeng", "pippit"]);
});

test("bootstrap：载荷 / 命令白名单 / 未装配逐个拒绝，dispose 可重复注册", async () => {
  const f = makeFakes({ installed: {} });
  const event = { sender: {}, senderFrame: { url: "file:///app/index.html" } };
  const ipc = createIpcMain();
  registerCliIpc(ipc, { bundle: f.bundle, identity: { current: { sessionRef: "s1" } }, isTrusted: (e) => e === event });

  assert.equal((await ipc.invoke("cli:command", event, null)).error, "CLI_INVALID_INPUT");
  assert.equal((await ipc.invoke("cli:command", event, "not-object")).error, "CLI_INVALID_INPUT");
  assert.equal((await ipc.invoke("cli:command", event, { command: "cli/nope" })).error, "CLI_COMMAND_NOT_ALLOWED");
  assert.equal((await ipc.invoke("cli:command", event, { type: "cli/status", tool: "codex" })).ok, true, "type 别名应与 command 等价");

  const before = ipc.handlers.size;
  registerCliIpc(ipc, { bundle: f.bundle, identity: { current: { sessionRef: "s1" } }, isTrusted: (e) => e === event });
  assert.equal(ipc.handlers.size, before, "重复注册不得新增 handler");
  disposeCliIpc(ipc);
  assert.equal(ipc.handlers.has("cli:command"), false);
});
