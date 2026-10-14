/**
 * B7d · 插件框架纳入测试（全离线：假 ipcMain / 假 safeStorage / 临时目录）。
 *
 * 覆盖任务书验收点：
 *   ① 六个插件默认全关；未动开关不写状态文件；
 *   ② 必需依赖缺失 → enable 结构化 { ok:false, error:"INTEGRATION_UNAVAILABLE", detail:"<缺什么/怎么装>" }；
 *   ③ 开关持久化与"重启"保持（同一 userData 新实例）；
 *   ④ 命令白名单 ↔ 元数据（risk/credential/中文 summary）↔ 实现一一对应；
 *   ⑤ IPC trusted：经 integration:command 的 trusted 边界，payload.userId 不参与身份；
 *   ⑥ 凭据不落明文与掩码（经真实 bundle 路径）。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const { createPluginBundle, INTEGRATION_COMMANDS, INTEGRATION_COMMAND_META, describeIntegrationCommands } = require("../electron/plugin-service.cjs");
const { registerIntegrationIpc, disposeIntegrationIpc } = require("../electron/plugin-bootstrap.cjs");
const { STATE_FILE_NAME } = require("../electron/plugin-registry.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-int-plugin-")); tmpDirs.push(dir); return dir; }

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from("ENC:" + Buffer.from(String(value)).toString("base64")),
    decryptString: (blob) => Buffer.from(String(blob).slice(4), "base64").toString(),
  };
}
function makeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    async invoke(channel, event, payload) { const fn = handlers.get(channel); if (!fn) throw new Error("NO_HANDLER " + channel); return fn(event, payload); },
  };
}
const TRUSTED_SENDER = { id: "trusted-web-contents" };
const TRUSTED_URL = "file:///Application/OpenArc%20OS/index.html";
const trustedEvent = () => ({ sender: TRUSTED_SENDER, senderFrame: { url: TRUSTED_URL } });
const fakeEvent = () => ({ sender: { id: "evil" }, senderFrame: { url: "https://evil.example/" } });
const trustedGate = (event) => !!event && event.sender === TRUSTED_SENDER && !!event.senderFrame && event.senderFrame.url === TRUSTED_URL;

// ── ① 默认全关 ────────────────────────────────────────────────────────────
test("默认全关：六个插件 enabled=false，未动开关不写状态文件", async () => {
  const dir = tempDir();
  const bundle = createPluginBundle({ userDataDir: dir, safeStorage: null });
  const items = bundle.registry.list();
  const ids = items.map((item) => item.id);
  for (const id of ["dingtalk", "weather", "almanac", "lingxing", "ziniao", "quark"]) assert.ok(ids.includes(id), "缺少插件 " + id);
  assert.ok(items.every((item) => item.enabled === false), "默认必须全部关闭");
  assert.equal(fs.existsSync(path.join(dir, "dxos", STATE_FILE_NAME)), false);
  const health = await bundle.execute("integration/health", {}, { sessionRef: "s1" });
  assert.equal(health.value.plugins, bundle.registry.list().length);
  assert.deepEqual(health.value.enabled, []);
});

// ── ② 缺依赖结构化拒绝 ────────────────────────────────────────────────────
test("缺依赖：夸克 CLI 缺失 / 紫鸟 python3 缺失 → INTEGRATION_UNAVAILABLE + 安装提示", async () => {
  const dir = tempDir();
  const bundle = createPluginBundle({
    userDataDir: dir,
    safeStorage: null,
    quarkCliPath: null,
    probes: { binary: (target) => ({ ok: false, status: "missing", detail: "找不到 " + target }), python: () => ({ ok: false, status: "missing", detail: "未安装" }) },
  });
  const quark = await bundle.execute("integration/plugins/enable", { id: "quark" }, { sessionRef: "s1" });
  assert.equal(quark.ok, false);
  assert.equal(quark.error, "INTEGRATION_UNAVAILABLE");
  assert.match(quark.detail, /quark-drive\.cjs/, "必须给出可执行安装提示");
  assert.equal(bundle.registry.isEnabled("quark"), false);

  const ziniao = await bundle.execute("integration/plugins/enable", { id: "ziniao" }, { sessionRef: "s1" });
  assert.equal(ziniao.error, "INTEGRATION_UNAVAILABLE");
  assert.match(ziniao.detail, /python3/);
  assert.equal(bundle.registry.isEnabled("ziniao"), false);

  // 依赖齐备后（注入探测）可正常启用
  const ready = createPluginBundle({
    userDataDir: tempDir(),
    safeStorage: null,
    quarkCliPath: null,
    probes: { binary: () => ({ ok: true, status: "ok", detail: "" }), python: () => ({ ok: true, status: "ok", detail: "" }) },
  });
  assert.equal((await ready.execute("integration/plugins/enable", { id: "ziniao" }, { sessionRef: "s1" })).ok, true);
});

// ── ③ 持久化 / 重启 ───────────────────────────────────────────────────────
test("开关持久化：写 integrations.json，新实例重启后保持（含新插件）", async () => {
  const dir = tempDir();
  const first = createPluginBundle({ userDataDir: dir, safeStorage: null });
  assert.equal((await first.execute("integration/plugins/enable", { id: "lingxing" }, { sessionRef: "s1" })).ok, true);
  assert.equal((await first.execute("integration/plugins/enable", { id: "dingtalk" }, { sessionRef: "s1" })).ok, true);
  const file = path.join(dir, "dxos", STATE_FILE_NAME);
  assert.ok(fs.existsSync(file));
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.plugins.lingxing.enabled, true);
  assert.equal(parsed.plugins.quark, undefined, "未动过的插件不写空条目");

  const second = createPluginBundle({ userDataDir: dir, safeStorage: null });
  assert.equal(second.registry.isEnabled("lingxing"), true, "重启后保持");
  assert.equal(second.registry.isEnabled("dingtalk"), true);
  assert.equal(second.registry.isEnabled("quark"), false);
  assert.equal((await second.execute("integration/plugins/disable", { id: "lingxing" }, { sessionRef: "s1" })).ok, true);
  const third = createPluginBundle({ userDataDir: dir, safeStorage: null });
  assert.equal(third.registry.isEnabled("lingxing"), false);
});

// ── ④ 白名单 ↔ 元数据 ↔ 实现 一一对应 ────────────────────────────────────
test("白名单一一对应：每条命令都有 risk/credential/中文 summary，且都有实现（非 COMMAND_NOT_ALLOWED）", async () => {
  const meta = INTEGRATION_COMMAND_META;
  assert.deepEqual(Object.keys(meta), [...INTEGRATION_COMMANDS], "白名单必须由元数据键生成（恒等）");
  for (const command of INTEGRATION_COMMANDS) {
    const entry = meta[command];
    assert.ok(["read", "use", "manage", "destructive"].includes(entry.risk), command + " risk");
    assert.equal(typeof entry.credential, "boolean", command + " credential");
    assert.ok(entry.summary.length > 0, command + " summary");
  }
  assert.equal(describeIntegrationCommands().length, INTEGRATION_COMMANDS.length);
  assert.ok(INTEGRATION_COMMANDS.length >= 60, "B7c 18 条 + B7d 新命令");

  const bundle = createPluginBundle({ userDataDir: tempDir(), safeStorage: null });
  for (const command of INTEGRATION_COMMANDS) {
    const result = await bundle.execute(command, {}, { sessionRef: "s1" });
    assert.notEqual(result.error, "INTEGRATION_COMMAND_NOT_ALLOWED", command + " 已在白名单但分发未实现");
  }
  const unknown = await bundle.execute("integration/not-registered", {}, { sessionRef: "s1" });
  assert.equal(unknown.error, "INTEGRATION_COMMAND_NOT_ALLOWED");

  // 反向：源码里不能出现"实现未登记"的 case 标签
  const serviceSource = fs.readFileSync(path.join(ROOT, "electron", "plugin-service.cjs"), "utf8");
  const caseLabels = serviceSource.split('case "').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('"')));
  assert.ok(caseLabels.length >= INTEGRATION_COMMANDS.length, "命令 case 数量应覆盖全部白名单");
  for (const label of caseLabels) assert.ok(INTEGRATION_COMMANDS.includes(label), "实现未登记项：" + label);
});

// ── ⑤ IPC trusted ─────────────────────────────────────────────────────────
test("integration:command：trusted fail closed、身份只认主进程、未认证拒绝", async () => {
  const ipcMain = makeIpcMain();
  const bundle = createPluginBundle({ userDataDir: tempDir(), safeStorage: null });
  registerIntegrationIpc({ ipcMain, bundle, isTrusted: trustedGate, identity: { current: "sess-real" } });

  await assert.rejects(() => ipcMain.invoke("integration:command", fakeEvent(), { command: "integration/health" }), /Forbidden/);
  const ok = await ipcMain.invoke("integration:command", trustedEvent(), { command: "integration/health", payload: { userId: "attacker", role: "SUPER_ADMIN", appId: "evil" } });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.plugins, bundle.registry.list().length, "payload 身份不参与判定");

  disposeIntegrationIpc({ ipcMain });
  registerIntegrationIpc({ ipcMain, bundle, isTrusted: trustedGate, identity: { current: null } });
  const unauth = await ipcMain.invoke("integration:command", trustedEvent(), { command: "integration/health" });
  assert.equal(unauth.error, "INTEGRATION_UNAUTHENTICATED");

  const denied = await ipcMain.invoke("integration:command", trustedEvent(), { command: "integration/nope" });
  assert.equal(denied.error, "INTEGRATION_COMMAND_NOT_ALLOWED");
});

// ── ⑥ 凭据 ───────────────────────────────────────────────────────────────
test("凭据：经 integration:command 写入 safeStorage，磁盘无明文、投影只给掩码", async () => {
  const dir = tempDir();
  const bundle = createPluginBundle({ userDataDir: dir, safeStorage: fakeSafeStorage() });
  assert.equal((await bundle.execute("integration/plugins/enable", { id: "lingxing" }, { sessionRef: "s1" })).ok, true);
  const secret = "LINGXING-INTEGRATION-SECRET-7788";
  const saved = await bundle.execute("integration/lingxing/credential/save", { secret }, { sessionRef: "s1" });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.mask, "LING••••7788");

  const credentialFile = path.join(dir, "credentials", "lingxing.credential.bin");
  assert.ok(fs.existsSync(credentialFile), "凭据文件必须存在");
  assert.equal(fs.readFileSync(credentialFile, "utf8").includes(secret), false, "磁盘上不得出现明文");

  const status = await bundle.execute("integration/lingxing/credential/status", {}, { sessionRef: "s1" });
  assert.equal(status.value.credentialSet, true);
  assert.equal(JSON.stringify(status).includes(secret), false, "投影不得回传明文");
});

// ── ⑦ B7e3 登记：新插件 / 新命令白名单 ↔ 元数据 ↔ 实现 ────────────────────
test("插件登记：createPluginBundle 目录包含 agnes / runninghub / modelscope，默认全关", async () => {
  const bundle = createPluginBundle({ userDataDir: tempDir(), safeStorage: null });
  const items = bundle.registry.list();
  const ids = items.map((item) => item.id);
  for (const id of ["agnes", "runninghub", "modelscope"]) assert.ok(ids.includes(id), "缺少插件 " + id);
  assert.ok(items.every((item) => item.enabled === false), "默认必须全部关闭");
  const health = await bundle.execute("integration/health", {}, { sessionRef: "s1" });
  assert.deepEqual(health.value.enabled, []);
});

test("命令登记：B7e3 新增命令均在白名单、有 risk/credential/中文 summary，且分发已实现", async () => {
  const expected = [
    "integration/agnes/status", "integration/agnes/credentials/save", "integration/agnes/credentials/delete",
    "integration/agnes/generate-images", "integration/agnes/edit-images", "integration/agnes/generate-videos",
    "integration/runninghub/chat", "integration/runninghub/describe-image", "integration/runninghub/inspect",
    "integration/runninghub/submit", "integration/runninghub/task/query", "integration/runninghub/upload",
    "integration/lingxing/analytics", "integration/lingxing/operator/dashboard",
    "integration/lingxing/operator/export", "integration/lingxing/currency/rates",
    "integration/ziniao/vc/import", "integration/ziniao/vc/rows", "integration/ziniao/vc/query",
  ];
  for (const command of expected) {
    assert.ok(INTEGRATION_COMMANDS.includes(command), "白名单缺少 " + command);
    const entry = INTEGRATION_COMMAND_META[command];
    assert.ok(entry, command + " 缺少元数据");
    assert.ok(["read", "use", "manage", "destructive"].includes(entry.risk), command + " risk");
    assert.equal(typeof entry.credential, "boolean", command + " credential");
    assert.ok(entry.summary.length > 0, command + " summary");
  }
  const bundle = createPluginBundle({ userDataDir: tempDir(), safeStorage: null });
  for (const command of expected) {
    const result = await bundle.execute(command, {}, { sessionRef: "s1" });
    assert.notEqual(result.error, "INTEGRATION_COMMAND_NOT_ALLOWED", command + " 已在白名单但分发未实现");
    assert.notEqual(result.error, "INTEGRATION_INVALID_INPUT", command + " 空载荷不应是入参错误（未启用应为不可用）");
  }
});

