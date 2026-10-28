/**
 * B6a · 自动化域 IPC 集成测试（全离线：假 ipcMain / 假 webContents，无 Electron、无网络）。
 *
 * 覆盖本轮验收条目：
 *   ① trusted(sender) fail closed：缺 isTrusted / 伪造 sender 一律拒绝（且先于 bundle 判空）
 *   ② 命令表 risk/credential/中文 summary + needsCredential 投影（credential 键会被 foundation 掩码，故改名）
 *   ③ 未白名单命令被拒且无副作用；command / type 两种命令体写法
 *   ④ automation:event 信封（P1 六字段）与 sequence 单调
 *   ⑤ 返回值脱敏：绝对路径替换为 <path>、密钥字段掩码
 *   ⑥ payload.userId 被忽略：actor 只从主进程注入的 sessionRef 推导
 *   ⑦ automation/runNow + automation/runs 经 IPC 真跑通
 *   ⑧ dispose 后可重复注册；bundle 未装配 → AUTOMATION_NOT_READY
 *   ⑨ preload 顶层 automation 键与 main.cjs 装配契约（源码级结构断言）
 *
 * 只读源：electron/automation-domain.cjs、automation-service.cjs、automation-bootstrap.cjs、
 *         dxos-foundation-events.cjs、dxos-foundation-errors.cjs。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { IdentityStore } = require("../electron/identity-store.cjs");
const store = require("../electron/automation-store.cjs");
const domain = require("../electron/automation-domain.cjs");
const { createAutomationBundle } = require("../electron/automation-service.cjs");
const { registerAutomationIpc, disposeAutomationIpc, AUTOMATION_NOT_READY } = require("../electron/automation-bootstrap.cjs");

const tmpDirs = [];
const openStores = [];

afterEach(() => {
  store.resetAutomationStoreForTests();
  while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } }
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** 假 ipcMain：只需要 handle / removeHandler，与 electron/automation-bootstrap.cjs:37 的用法一致。 */
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
const forgedEvent = () => ({ sender: { id: "evil" }, senderFrame: { url: "https://evil.example/" } });
const trustedGate = (event) => !!event && event.sender === TRUSTED_SENDER && !!event.senderFrame && event.senderFrame.url === TRUSTED_URL;

function makeAuth() {
  return { resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: "u-auto" } } : { ok: false, error: "no-session" }) };
}

function openBundle() {
  const dir = tempDir("dxos-automation-ipc-");
  const idStore = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(idStore);
  const calls = [];
  const bundle = createAutomationBundle({
    identityStore: idStore,
    authorization: makeAuth(),
    sleeper: async () => {},
    integrations: { lingxingCacheSync: async (args) => { calls.push(args); return "领星完成"; } },
  });
  return { dir, idStore, bundle, calls, identity: { current: "sess-ipc" } };
}

// ── ① trusted fail closed ────────────────────────────────────────────────
test("trusted：缺 isTrusted / 伪造 sender 一律 Forbidden，且先于 bundle 判空", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerAutomationIpc({ ipcMain, bundle: fx.bundle, identity: fx.identity });
  await assert.rejects(() => ipcMain.invoke("automation:command", trustedEvent(), { command: "automation/list" }), /Forbidden/);
  await assert.rejects(() => ipcMain.invoke("automation:command", forgedEvent(), { command: "automation/list" }), /Forbidden/);

  disposeAutomationIpc({ ipcMain });
  registerAutomationIpc({ ipcMain, bundle: null, isTrusted: trustedGate, identity: fx.identity });
  await assert.rejects(() => ipcMain.invoke("automation:command", forgedEvent(), { command: "automation/list" }), /Forbidden/);
  const notReady = await ipcMain.invoke("automation:command", trustedEvent(), { command: "automation/list" });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, AUTOMATION_NOT_READY);
});

// ── ② 命令表 ─────────────────────────────────────────────────────────────
test("命令表：13 条必需命令、risk/needsCredential/中文 summary 合法", () => {
  const required = [
    "automation/list", "automation/get", "automation/create", "automation/update", "automation/delete",
    "automation/enable", "automation/disable", "automation/runNow", "automation/cancel", "automation/runs",
    "automation/catalog", "automation/parse", "automation/health",
  ];
  const commands = domain.listAutomationCommands();
  assert.deepEqual(commands.map((entry) => entry.command), required);
  for (const entry of commands) {
    assert.ok(["read", "use", "manage", "destructive"].includes(entry.risk), entry.command + " risk=" + entry.risk);
    assert.equal(typeof entry.needsCredential, "boolean", entry.command);
    assert.ok(entry.summary && /[\u4e00-\u9fff]/.test(entry.summary), entry.command + " summary 必须为中文");
    assert.equal(entry.credential, undefined, "IPC 投影不得带 credential 键（会被 foundation 掩码）");
  }
  assert.equal(domain.automationCommandRisk("automation/runNow"), "use");
  assert.equal(domain.automationCommandRisk("automation/delete"), "destructive");
  assert.equal(domain.automationCommandRisk("automation/nope"), null);
  assert.equal(domain.automationCommandRequiresCredential("automation/runNow"), true);
  assert.equal(domain.automationCommandRequiresCredential("automation/list"), false);
  assert.equal(domain.isAutomationCommand("automation/health"), true);
  assert.equal(domain.isAutomationCommand("automation/nope"), false);
});

// ── ③ 白名单与命令体 ─────────────────────────────────────────────────────
test("白名单：未登记命令被拒且无副作用；command / type 两种写法；非法载荷回输入错误", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerAutomationIpc({ ipcMain, bundle: fx.bundle, identity: fx.identity, isTrusted: trustedGate });

  const denied = await ipcMain.invoke("automation:command", trustedEvent(), { command: "automation/nuke" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "AUTOMATION_COMMAND_NOT_ALLOWED");
  assert.equal(denied.value, undefined);
  // 无副作用：automations 表仍是空。
  assert.equal(fx.idStore.connection.prepare("SELECT COUNT(*) AS c FROM automations").get().c, 0);

  const notObject = await ipcMain.invoke("automation:command", trustedEvent(), "not-an-object");
  assert.equal(notObject.ok, false);
  assert.equal(notObject.error, "AUTOMATION_INVALID_INPUT");

  const byCommand = await ipcMain.invoke("automation:command", trustedEvent(), { command: "automation/list" });
  assert.equal(byCommand.ok, true);
  assert.deepEqual(byCommand.value.automations, []);
  const byType = await ipcMain.invoke("automation:command", trustedEvent(), { type: "automation/list", payload: {} });
  assert.equal(byType.ok, true);

  const missingId = await ipcMain.invoke("automation:command", trustedEvent(), { command: "automation/get", payload: {} });
  assert.equal(missingId.ok, false);
  assert.equal(missingId.error, "AUTOMATION_INVALID_INPUT");

  // 白名单是分发入口的第一道，直接调 execute 同样拒绝。
  const viaExecute = await fx.bundle.execute("automation/nuke", {}, { sessionRef: "sess-ipc" });
  assert.equal(viaExecute.error, "AUTOMATION_COMMAND_NOT_ALLOWED");
});

// ── ④ 事件信封 ───────────────────────────────────────────────────────────
test("automation:event：P1 六字段齐备、sequence 单调、channel 固定", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  const events = [];
  registerAutomationIpc({ ipcMain, bundle: fx.bundle, identity: fx.identity, isTrusted: trustedGate, send: (event) => events.push(event) });
  await ipcMain.invoke("automation:command", trustedEvent(), { command: "automation/list" });
  await ipcMain.invoke("automation:command", trustedEvent(), {
    command: "automation/create",
    payload: { definition: { instruction: "每天同步", schedule: { type: "daily", hour: 9, minute: 0 }, action: { type: "lingxing_cache_sync", args: {} } } },
  });
  assert.ok(events.length >= 4, "每个命令 begin + completed 各一条");
  const fields = ["channel", "domain", "kind", "sequence", "at", "payload"];
  for (const event of events) {
    for (const field of fields) assert.ok(Object.prototype.hasOwnProperty.call(event, field), "事件缺 " + field);
    assert.equal(event.channel, "automation:event");
    assert.equal(event.domain, "automation");
    assert.equal(event.kind, "progress");
    assert.equal(typeof event.sequence, "number");
    assert.equal(typeof event.at, "number");
    assert.equal(typeof event.payload, "object");
  }
  const sequences = events.map((event) => event.sequence);
  for (let i = 1; i < sequences.length; i += 1) assert.ok(sequences[i] > sequences[i - 1], "sequence 必须严格单调");
  const phases = events.map((event) => event.payload.phase);
  assert.ok(phases.filter((phase) => phase === "begin").length >= 2);
  assert.ok(phases.filter((phase) => phase === "completed").length >= 2);
});

// ── ⑤ 返回值脱敏 ─────────────────────────────────────────────────────────
test("返回值脱敏：绝对路径替换为 <path>、密钥字段掩码", async () => {
  const fx = openBundle();
  const leakedPath = "/Users/wepingli/secret/leak.txt";
  const leakedKey = "sk-abcdef123456";
  const ipcMain = makeIpcMain();
  registerAutomationIpc({ ipcMain, bundle: fx.bundle, identity: fx.identity, isTrusted: trustedGate });
  const create = await ipcMain.invoke("automation:command", trustedEvent(), {
    command: "automation/create",
    payload: {
      definition: {
        instruction: "读取 " + leakedPath,
        schedule: { type: "daily", hour: 8, minute: 0 },
        action: { type: "agent_instruction", args: { instruction: "读取 " + leakedPath, apiKey: leakedKey } },
      },
    },
  });
  assert.equal(create.ok, true, JSON.stringify(create));
  const fetched = await ipcMain.invoke("automation:command", trustedEvent(), { command: "automation/get", payload: { automationId: create.value.automation.id } });
  assert.equal(fetched.ok, true);
  const serialized = JSON.stringify(fetched);
  assert.ok(!serialized.includes(leakedPath), "绝对路径不得过桥");
  assert.ok(!serialized.includes(leakedKey), "裸密钥不得过桥");
  assert.ok(serialized.includes("<path>"), "路径应替换为 <path>");
  assert.equal(fetched.value.automation.action.args.apiKey, "****3456");
});

// ── ⑥ payload.userId 被忽略 ──────────────────────────────────────────────
test("身份：payload.userId 被忽略，sessionRef 缺省即未认证", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerAutomationIpc({ ipcMain, bundle: fx.bundle, identity: { current: null }, isTrusted: trustedGate });
  const denied = await ipcMain.invoke("automation:command", trustedEvent(), { command: "automation/list", payload: { userId: "forged-superadmin" } });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "AUTOMATION_UNAUTHENTICATED");

  disposeAutomationIpc({ ipcMain });
  registerAutomationIpc({ ipcMain, bundle: fx.bundle, identity: { current: "sess-ipc" }, isTrusted: trustedGate });
  const allowed = await ipcMain.invoke("automation:command", trustedEvent(), { command: "automation/create", payload: { userId: "forged-superadmin", definition: { instruction: "x", schedule: { type: "daily", hour: 1, minute: 0 }, action: { type: "lingxing_cache_sync", args: {} } } } });
  assert.equal(allowed.ok, true);
  // 归属只认 sessionRef 推导出的 u-auto，而不是 payload 自报的 userId。
  assert.equal(allowed.value.automation.userId, "u-auto");
  assert.equal(fx.idStore.connection.prepare("SELECT created_by FROM automations").get().created_by, "u-auto");
});

// ── ⑦ runNow + runs ──────────────────────────────────────────────────────
test("runNow / runs：经 IPC 真跑通一次运行并落 automation_runs", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerAutomationIpc({ ipcMain, bundle: fx.bundle, identity: fx.identity, isTrusted: trustedGate });
  const create = await ipcMain.invoke("automation:command", trustedEvent(), {
    command: "automation/create",
    payload: { definition: { instruction: "同步", schedule: { type: "daily", hour: 8, minute: 0 }, action: { type: "lingxing_cache_sync", args: { days: 3 } } } },
  });
  const run = await ipcMain.invoke("automation:command", trustedEvent(), { command: "automation/runNow", payload: { automationId: create.value.automation.id, await: true } });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.value.result.status, "success");
  assert.equal(run.value.result.result, "领星完成");
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.calls[0].days, 3);

  const runs = await ipcMain.invoke("automation:command", trustedEvent(), { command: "automation/runs", payload: { automationId: create.value.automation.id } });
  assert.equal(runs.ok, true);
  assert.equal(runs.value.runs.length, 1);
  assert.equal(runs.value.runs[0].status, "success");
  assert.equal(fx.idStore.connection.prepare("SELECT COUNT(*) AS c FROM automation_runs").get().c, 1);
});

// ── ⑧ dispose / health ───────────────────────────────────────────────────
test("dispose：移除 handler 后可重复注册；health 只暴露布尔依赖清单", async () => {
  const fx = openBundle();
  const ipcMain = makeIpcMain();
  registerAutomationIpc({ ipcMain, bundle: fx.bundle, identity: fx.identity, isTrusted: trustedGate });
  assert.equal((await ipcMain.invoke("automation:command", trustedEvent(), { command: "automation/health" })).ok, true);
  disposeAutomationIpc({ ipcMain });
  assert.equal(ipcMain.handlers.has("automation:command"), false);
  await assert.rejects(() => ipcMain.invoke("automation:command", trustedEvent(), { command: "automation/health" }), /NO_HANDLER/);
  disposeAutomationIpc({ ipcMain });
  disposeAutomationIpc({});

  registerAutomationIpc({ ipcMain, bundle: fx.bundle, identity: fx.identity, isTrusted: trustedGate });
  const health = await ipcMain.invoke("automation:command", trustedEvent(), { command: "automation/health" });
  assert.equal(health.ok, true);
  assert.equal(health.value.status, "ok");
  assert.equal(typeof health.value.dependencies.integrations, "boolean");
  assert.equal(health.value.dependencies.db, true);
  assert.equal(health.value.schedulerRunning, false);
  assert.ok(!JSON.stringify(health).includes("wepingli"));
});

// ── ⑨ 装配契约（源码级） ─────────────────────────────────────────────────
test("装配契约：preload 顶层 automation 键 + main.cjs 装配 automation:command / automation:event", () => {
  const preload = fs.readFileSync(path.join(process.cwd(), "electron", "preload.cjs"), "utf8");
  assert.ok(/\n  automation: \{/.test(preload), "preload 必须有顶层 automation 键");
  assert.ok(preload.includes('ipcRenderer.invoke("automation:command"'));
  assert.ok(preload.includes('ipcRenderer.on("automation:event"'));
  assert.ok(!preload.includes("ipcRenderer,") || preload.includes("const { contextBridge, ipcRenderer, webUtils }"), "不暴露原始 ipcRenderer 对象");
  const main = fs.readFileSync(path.join(process.cwd(), "electron", "runtime-composition.cjs"), "utf8");
  assert.ok(main.includes('require("./automation-service.cjs")'));
  assert.ok(main.includes('require("./automation-bootstrap.cjs")'));
  assert.ok(main.includes("registerAutomationIpc("));
  assert.ok(main.includes('win.webContents.send("automation:event", event)'));
  assert.ok(main.includes("automationBundle.startScheduler()"));
  const lifecycle = fs.readFileSync(path.join(process.cwd(), "electron", "app-lifecycle.cjs"), "utf8");
  assert.ok(lifecycle.includes("automationBundle.stopScheduler()"));
});
