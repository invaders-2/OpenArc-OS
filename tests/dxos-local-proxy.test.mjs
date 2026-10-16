/**
 * 本机代理探测 · 离线测试（假 ipcMain / 假 execFile / 假 fetch / 假 fs；无 Electron、无网络、无依赖）。
 *
 * 覆盖验收项：
 *   ① win32 netstat 样例文本解析（逐字正则），含非法/空输入
 *   ② lsof（darwin/linux 共用）与 linux /proc 纯解析
 *   ③ 可达性未显式开启时**不出网**（注入 fake fetch，断言 0 次调用）
 *   ④ 探测失败必须结构化返回（reachable:false + error），不得静默成功
 *   ⑤ 未知命令被拒（LOCAL_PROXY_COMMAND_NOT_ALLOWED）
 *   ⑥ 命令元数据 risk: external 且默认零出网
 *   ⑦ trusted fail closed / dispose 后可重复注册
 *
 * 只读源：electron/local-proxy-domain.cjs、local-proxy-service.cjs、local-proxy-bootstrap.cjs。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const domain = require("../electron/local-proxy-domain.cjs");
const { createLocalProxyService } = require("../electron/local-proxy-service.cjs");
const { registerLocalProxyIpc, disposeLocalProxyIpc, LOCAL_PROXY_CHANNEL, LOCAL_PROXY_NOT_READY } = require("../electron/local-proxy-bootstrap.cjs");

// ── 假件 ───────────────────────────────────────────────────────────────────
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

function makeExecFile(table) {
  const calls = [];
  const fn = async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (!Object.prototype.hasOwnProperty.call(table, file)) {
      const error = new Error("spawn " + file + " ENOENT");
      error.code = "ENOENT";
      throw error;
    }
    const value = table[file];
    return typeof value === "function" ? value(args, opts) : value;
  };
  fn.calls = calls;
  return fn;
}

const TRUSTED_SENDER = { id: "trusted-web-contents" };
const TRUSTED_URL = "file:///Application/OpenArc%20OS/index.html";
const trustedEvent = () => ({ sender: TRUSTED_SENDER, senderFrame: { url: TRUSTED_URL } });
const fakeEvent = () => ({ sender: { id: "evil" }, senderFrame: { url: "https://evil.example/" } });
const trustedGate = (event) => !!event && event.sender === TRUSTED_SENDER && !!event.senderFrame && event.senderFrame.url === TRUSTED_URL;
const asStr = (value) => (typeof value === "string" ? value : value == null ? undefined : String(value));

// ── 样例文本（真实形态） ───────────────────────────────────────────────────
const NETSTAT_SAMPLE = [
  "",
  "活动连接",
  "",
  "  协议  本地地址          外部地址        状态           PID",
  "  TCP    127.0.0.1:7890         0.0.0.0:0              LISTENING       1234",
  "  TCP    127.0.0.1:7891         0.0.0.0:0              LISTENING       1234",
  "  TCP    [::1]:9090             [::]:0                 LISTENING       5678",
  "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       9999",
  "  TCP    192.168.1.5:5000       0.0.0.0:0              LISTENING       7777",
  "  TCP    127.0.0.1:7890         127.0.0.1:54321        ESTABLISHED     1234",
  "  TCP    127.0.0.1:0            0.0.0.0:0              LISTENING       1234",
  "  TCP    127.0.0.1:70000        0.0.0.0:0              LISTENING       1234",
  "  TCP    127.0.0.1:8000         0.0.0.0:0              LISTENING       0",
  "",
].join("\r\n");

const POWERSHELL_SAMPLE = "1234|clash-verge\r\n5678|mihomo\r\n9999|chrome\r\n";
const REG_SAMPLE = [
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  "    ProxyEnable    REG_DWORD    0x1",
  "    ProxyServer    REG_SZ    127.0.0.1:7890",
  "",
].join("\r\n");

const LSOF_SAMPLE = [
  "COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
  "mihomo    12345  me    8u  IPv4 0x1234567890      0t0  TCP 127.0.0.1:7890 (LISTEN)",
  "ClashX    23456  me   10u  IPv4 0x2234567890      0t0  TCP 127.0.0.1:7891 (LISTEN)",
  "node      34567  me   20u  IPv6 0x3234567890      0t0  TCP [::1]:9090 (LISTEN)",
  "verge     45678  me   12u  IPv4 0x4234567890      0t0  TCP 192.168.1.5:8080 (LISTEN)",
  "",
].join("\n");

const PROC_NET_TCP = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 0100007F:1ED2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0",
  "   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000000000000000 100 0 0 10 0",
  "   2: 0100007F:1ED2 0100007F:C001 01 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0000000000000000 100 0 0 10 0",
  "",
].join("\n");
const PROC_NET_TCP6 = [
  "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000000000000000000001000000:2382 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0000000000000000 100 0 0 10 0",
  "",
].join("\n");

function makeProcFs() {
  const files = {
    "/proc/net/tcp": PROC_NET_TCP,
    "/proc/net/tcp6": PROC_NET_TCP6,
    "/proc/4242/comm": "mihomo\n",
    "/proc/9999/comm": "chrome\n",
  };
  const dirs = {
    "/proc": [
      { name: "4242", isDirectory: () => true },
      { name: "9999", isDirectory: () => true },
      { name: "1", isDirectory: () => true },
      { name: "self", isDirectory: () => true },
    ],
    "/proc/4242/fd": ["3", "4"],
    "/proc/9999/fd": ["5"],
    "/proc/1/fd": [],
  };
  const links = {
    "/proc/4242/fd/3": "socket:[11111]",
    "/proc/4242/fd/4": "socket:[33333]",
    "/proc/9999/fd/5": "socket:[22222]",
  };
  return {
    readFileSync(file) { if (!(file in files)) throw new Error("ENOENT " + file); return files[file]; },
    readdirSync(dir) { if (!(dir in dirs)) throw new Error("ENOENT " + dir); return dirs[dir]; },
    readlinkSync(link) { if (!(link in links)) throw new Error("ENOENT " + link); return links[link]; },
  };
}

function win32Service(overrides = {}) {
  return createLocalProxyService(Object.assign({
    platform: "win32",
    execFile: makeExecFile({
      "reg.exe": { stdout: REG_SAMPLE, stderr: "" },
      "netstat.exe": { stdout: NETSTAT_SAMPLE, stderr: "" },
      "powershell.exe": { stdout: POWERSHELL_SAMPLE, stderr: "" },
    }),
    env: {},
    getConfiguredProxy: () => "http://127.0.0.1:1080",
  }, overrides));
}

// ── ① win32 netstat 纯解析（逐字正则） ─────────────────────────────────────
test("win32：netstat 回环 LISTENING 解析只认 127.0.0.1/[::1]，端口 1..65535、pid>0", () => {
  assert.deepEqual(domain.parseWindowsLoopbackListeners(NETSTAT_SAMPLE), [
    { port: 7890, pid: 1234 },
    { port: 7891, pid: 1234 },
    { port: 9090, pid: 5678 },
  ]);
  // 无前导空白、无 CRLF 的紧凑行同样命中（逐字正则 \s* / \s+）
  assert.deepEqual(domain.parseWindowsLoopbackListeners("TCP 127.0.0.1:1080 0.0.0.0:0 LISTENING 42"), [{ port: 1080, pid: 42 }]);
});

test("② 非法/空输入：纯解析函数一律返回空结果，不抛异常", () => {
  for (const value of ["", "   ", "\n\n", "not netstat output", "  TCP  10.0.0.1:8080 0.0.0.0:0 LISTENING 9"]) {
    assert.deepEqual(domain.parseWindowsLoopbackListeners(value), [], JSON.stringify(value));
  }
  for (const value of [null, undefined, 42, {}, []]) {
    assert.deepEqual(domain.parseWindowsLoopbackListeners(value), []);
    assert.equal(domain.parseWindowsProcessNames(value).size, 0);
    assert.deepEqual(domain.parseMacLoopbackListeners(value), []);
    assert.deepEqual(domain.parseLinuxProcNetLoopbackListeners(value, 4), []);
    assert.equal(domain.parseMacSystemProxy(value), "");
    assert.equal(domain.parseWindowsSystemProxy(value), "");
    assert.equal(domain.proxyUrl(value), "");
    assert.equal(domain.parseProcFdTarget(value), null);
  }
  assert.equal(domain.parseWindowsSystemProxy("    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    127.0.0.1:7890"), "");
  assert.equal(domain.parseMacSystemProxy("  HTTPEnable : 0\n  HTTPPort : 0\n  HTTPSEnable : 0\n  HTTPSPort : 0"), "");
});

test("① win32：进程名 / 系统代理 / proxyUrl 解析", () => {
  const names = domain.parseWindowsProcessNames(POWERSHELL_SAMPLE);
  assert.equal(names.get(1234), "clash-verge");
  assert.equal(names.get(5678), "mihomo");
  assert.equal(names.get(9999), "chrome");
  assert.equal(domain.parseWindowsSystemProxy(REG_SAMPLE), "http://127.0.0.1:7890");
  assert.equal(domain.parseWindowsSystemProxy("    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=1.2.3.4:80;https=127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(domain.proxyUrl("http://127.0.0.1:7890/"), "http://127.0.0.1:7890");
  assert.equal(domain.proxyUrl("socks5://127.0.0.1:7890"), "");
  assert.equal(domain.proxyUrl("http://user:pass@127.0.0.1:7890"), "");
  assert.equal(domain.proxyUrl("127.0.0.1:7890"), "");
});

test("② lsof 与 linux /proc 纯解析", () => {
  assert.deepEqual(domain.parseMacLoopbackListeners(LSOF_SAMPLE), [
    { url: "http://127.0.0.1:7890", source: "mihomo" },
    { url: "http://127.0.0.1:7891", source: "ClashX" },
  ]);
  assert.deepEqual(domain.parseLinuxProcNetLoopbackListeners(PROC_NET_TCP, 4), [
    { port: 7890, inode: 11111, address: "127.0.0.1", family: 4 },
  ]);
  assert.deepEqual(domain.parseLinuxProcNetLoopbackListeners(PROC_NET_TCP6, 6), [
    { port: 9090, inode: 33333, address: "::1", family: 6 },
  ]);
  assert.equal(domain.parseProcFdTarget("socket:[11111]"), 11111);
  assert.equal(domain.parseProcFdTarget("anon_inode:[eventpoll]"), null);
  assert.equal(domain.parseProcFdTarget("/dev/null"), null);
  const index = domain.buildInodePidIndex([
    { pid: 4242, target: "socket:[11111]" },
    { pid: 1, target: "anon_inode:[eventpoll]" },
    { pid: 5151, target: "socket:[11111]" },
  ]);
  assert.equal(index.get(11111), 4242);
  assert.equal(index.size, 1);
});

// ── ③ 未显式开启探测 = 零出网 ─────────────────────────────────────────────
test("③ 可达性未显式开启时不出网：注入 fake fetch，断言 0 次调用", async () => {
  let fetchCalls = 0;
  const service = win32Service({ fetch: async () => { fetchCalls += 1; return { status: 200 }; } });

  const implicit = await service.execute("desktop/proxy/detect", {});
  assert.equal(implicit.ok, true, JSON.stringify(implicit));
  assert.equal(implicit.value.probeEnabled, false);
  assert.equal(implicit.value.network.attempted, false);
  assert.equal(implicit.value.network.reason, "probe-not-enabled");
  assert.deepEqual(implicit.value.probes, []);
  assert.equal(implicit.value.loopbackOnly, true);
  assert.deepEqual(implicit.value.candidates.map((item) => item.url), [
    "http://127.0.0.1:1080",
    "http://127.0.0.1:7890",
    "http://127.0.0.1:7891",
    "http://127.0.0.1:9090",
  ]);

  const explicitOff = await service.execute("desktop/proxy/detect", { probe: false });
  assert.equal(explicitOff.ok, true);
  assert.equal(explicitOff.value.network.attempted, false);

  assert.equal(fetchCalls, 0, "未显式 probe=true 时绝不能发起任何网络调用");
});

test("③ probe 非布尔值：结构化拒绝，且不发起网络调用", async () => {
  let fetchCalls = 0;
  const service = win32Service({ fetch: async () => { fetchCalls += 1; return { status: 200 }; } });
  const res = await service.execute("desktop/proxy/detect", { probe: "true" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "LOCAL_PROXY_INVALID_INPUT");
  assert.equal(fetchCalls, 0);
});

// ── ④ 探测结果：成功 / 失败都必须结构化 ───────────────────────────────────
test("④ 显式 probe=true 且上游成功：可达，返回 status 与 latencyMs", async () => {
  const service = win32Service({ fetch: async (url) => { assert.equal(url, domain.GOOGLE_MODELS_URL); return { status: 200 }; } });
  const res = await service.execute("desktop/proxy/detect", { probe: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.network.attempted, true);
  assert.equal(res.value.network.host, "generativelanguage.googleapis.com");
  assert.equal(res.value.probes.length, res.value.candidateCount);
  for (const probe of res.value.probes) {
    assert.equal(probe.reachable, true);
    assert.equal(probe.status, 200);
    assert.equal(typeof probe.latencyMs, "number");
  }
});

test("④ 探测失败结构化返回：reachable:false + error，绝不静默成功", async () => {
  const service = win32Service({
    fetch: async () => { const error = new Error("fetch failed"); error.cause = { code: "ECONNREFUSED" }; throw error; },
  });
  const res = await service.execute("desktop/proxy/detect", { probe: true });
  assert.equal(res.ok, true);
  assert.equal(res.value.network.attempted, true);
  assert.equal(res.value.probes.length, res.value.candidateCount);
  for (const probe of res.value.probes) {
    assert.equal(probe.reachable, false);
    assert.equal(probe.error, "ECONNREFUSED");
  }
});

test("④ 上游状态非法（0 / 999）同样结构化失败", async () => {
  for (const status of [0, 999, undefined]) {
    const service = win32Service({ fetch: async () => ({ status }) });
    const res = await service.execute("desktop/proxy/detect", { probe: true });
    assert.equal(res.ok, true);
    for (const probe of res.value.probes) {
      assert.equal(probe.reachable, false);
      assert.equal(probe.error, "无效的上游响应");
    }
  }
});

test("④ 单一来源不可用时进入 unavailable[]，命令仍结构化成功（不静默）", async () => {
  const service = createLocalProxyService({
    platform: "win32",
    execFile: makeExecFile({
      "reg.exe": { stdout: REG_SAMPLE, stderr: "" },
      "netstat.exe": { stdout: NETSTAT_SAMPLE, stderr: "" },
      // powershell.exe 不在表内 → ENOENT
    }),
    env: {},
    getConfiguredProxy: () => "",
  });
  const res = await service.execute("desktop/proxy/detect", {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.candidates, [{ url: "http://127.0.0.1:7890", source: "Windows 系统代理", kind: "system" }]);
  assert.equal(res.value.unavailable.length, 1);
  assert.equal(res.value.unavailable[0].source, "powershell.exe Get-Process");
  assert.match(res.value.unavailable[0].reason, /ENOENT/);
});

// ── linux：lsof 优先，失败退回 /proc ──────────────────────────────────────
test("linux：lsof 可用时用 lsof；失败则退回 /proc 并只保留代理进程", async () => {
  const lsofExec = makeExecFile({ lsof: { stdout: LSOF_SAMPLE, stderr: "" } });
  const viaLsof = createLocalProxyService({ platform: "linux", execFile: lsofExec, env: {}, getConfiguredProxy: () => "", fs: makeProcFs() });
  const lsofRes = await viaLsof.execute("desktop/proxy/detect", {});
  assert.equal(lsofRes.ok, true);
  assert.deepEqual(lsofRes.value.candidates.map((item) => item.url), ["http://127.0.0.1:7890", "http://127.0.0.1:7891"]);
  assert.deepEqual(lsofRes.value.unavailable, []);

  const noLsof = createLocalProxyService({ platform: "linux", execFile: makeExecFile({}), env: {}, getConfiguredProxy: () => "", fs: makeProcFs() });
  const procRes = await noLsof.execute("desktop/proxy/detect", {});
  assert.equal(procRes.ok, true, JSON.stringify(procRes));
  assert.deepEqual(procRes.value.candidates.map((item) => item.url), ["http://127.0.0.1:7890", "http://127.0.0.1:9090"]);
  assert.equal(procRes.value.candidates[0].source, "mihomo");
  assert.equal(procRes.value.unavailable.some((item) => item.source.startsWith("lsof")), true);
});

// ── ⑤ / ⑦ bootstrap：未知命令 / trusted / dispose ────────────────────────
test("⑤ 命令元数据：risk=external、默认零出网、credential=false", () => {
  const commands = domain.listLocalProxyCommands();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "desktop/proxy/detect");
  assert.equal(commands[0].risk, "external");
  assert.equal(commands[0].credential, false);
  assert.equal(commands[0].probesExternal, true);
  assert.equal(commands[0].network.default, "off");
  assert.equal(commands[0].network.enableWith, "probe=true");
  assert.match(commands[0].summary, /出网/);
  assert.equal(domain.isLocalProxyCommand("desktop/proxy/detect"), true);
  assert.equal(domain.isLocalProxyCommand("desktop/nope"), false);
});

test("⑤ 未知命令被拒；载荷非对象为 INVALID_INPUT", async () => {
  const ipcMain = makeIpcMain();
  registerLocalProxyIpc({ ipcMain, service: win32Service(), isTrusted: trustedGate, identity: { current: "sess-proxy" } });
  assert.equal(LOCAL_PROXY_CHANNEL, "desktop:command");

  const unknown = await ipcMain.invoke("desktop:command", trustedEvent(), { command: "desktop/nope" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "LOCAL_PROXY_COMMAND_NOT_ALLOWED");

  const missing = await ipcMain.invoke("desktop:command", trustedEvent(), {});
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "LOCAL_PROXY_COMMAND_NOT_ALLOWED");

  const notObject = await ipcMain.invoke("desktop:command", trustedEvent(), "not-an-object");
  assert.equal(notObject.ok, false);
  assert.equal(notObject.error, "LOCAL_PROXY_INVALID_INPUT");

  // command / type 两种写法都接受
  const byCommand = await ipcMain.invoke("desktop:command", trustedEvent(), { command: "desktop/proxy/detect", payload: {} });
  assert.equal(byCommand.ok, true);
  const byType = await ipcMain.invoke("desktop:command", trustedEvent(), { type: "desktop/proxy/detect", payload: {} });
  assert.equal(byType.ok, true);
});

test("⑦ trusted fail closed：缺 isTrusted / 伪造 sender 一律 Forbidden，且先于 service 判空", async () => {
  const ipcMain = makeIpcMain();
  registerLocalProxyIpc({ ipcMain, service: win32Service() });
  await assert.rejects(() => ipcMain.invoke("desktop:command", trustedEvent(), { command: "desktop/proxy/detect" }), /Forbidden/);

  disposeLocalProxyIpc({ ipcMain });
  registerLocalProxyIpc({ ipcMain, service: null, isTrusted: trustedGate });
  await assert.rejects(() => ipcMain.invoke("desktop:command", fakeEvent(), { command: "desktop/proxy/detect" }), /Forbidden/);
  const notReady = await ipcMain.invoke("desktop:command", trustedEvent(), { command: "desktop/proxy/detect" });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, LOCAL_PROXY_NOT_READY);
});

test("⑦ 身份边界：payload.userId 被忽略，service 收到主进程 appId", async () => {
  const seen = [];
  const service = {
    async execute(command, payload, context) { seen.push({ command, payload, context }); return { ok: true, value: {} }; },
  };
  const ipcMain = makeIpcMain();
  registerLocalProxyIpc({ ipcMain, service, isTrusted: trustedGate, identity: { current: "sess-real" }, appId: "ai" });
  await ipcMain.invoke("desktop:command", trustedEvent(), { command: "desktop/proxy/detect", payload: { userId: "attacker", role: "SUPER_ADMIN", appId: "evil", probe: false } });
  assert.equal(seen[0].context.sessionRef, "sess-real");
  assert.equal(seen[0].context.appId, "ai");
  assert.equal(seen[0].payload.userId, "attacker");
});

test("⑦ dispose 移除 handler，可重复注册（测试与热重载路径）", async () => {
  const ipcMain = makeIpcMain();
  registerLocalProxyIpc({ ipcMain, service: win32Service(), isTrusted: trustedGate });
  assert.equal(ipcMain.handlers.has("desktop:command"), true);
  disposeLocalProxyIpc({ ipcMain });
  assert.equal(ipcMain.handlers.has("desktop:command"), false);
  await assert.rejects(() => ipcMain.invoke("desktop:command", trustedEvent(), { command: "desktop/proxy/detect" }), /NO_HANDLER/);
  registerLocalProxyIpc({ ipcMain, service: win32Service(), isTrusted: trustedGate });
  assert.equal(ipcMain.handlers.has("desktop:command"), true);
});

// ── 探测环境（源:100-101 语义） ───────────────────────────────────────────
test("探测子进程环境：代理注入 + NO_PROXY 回环 + 删除 ALL_PROXY", () => {
  const env = domain.buildProbeEnv({ PATH: "/usr/bin", ALL_PROXY: "socks5://x:1", HTTPS_PROXY: "http://old" }, "http://127.0.0.1:7890");
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost,::1");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal("ALL_PROXY" in env, false);
  assert.equal(env.PATH, "/usr/bin");
  assert.match(domain.buildProbeScript(domain.GOOGLE_MODELS_URL, 8000), /AbortSignal\.timeout\(8000\)/);
});
