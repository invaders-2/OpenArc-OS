/**
 * B7f · developer:command 合流一致性：白名单 ↔ dispatch ↔ 实现一一对应。
 *
 * 断言：
 *   ① 白名单 = B7a 基础 16 条 + B7b 四切片（lab / collab / migrations / realtime）registry 的并集；
 *   ② 无"登记未实现"：白名单每条命令都能命中一个真实 handler（不返回 NOT_IMPLEMENTED）；
 *   ③ 无"实现未登记"：developer-service.cjs 的 case 标签与四切片 handler 键都必须在白名单内；
 *   ④ bootstrap 合流：扩展命令命中切片、基座命令回落 bundle，未认证会话一律拒绝。
 *
 * 全离线：假 ipcMain / 假身份服务，无 Electron、无网络。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const domain = require("../electron/developer-domain.cjs");
const lab = require("../electron/developer-lab.cjs");
const collab = require("../electron/developer-collab.cjs");
const migrations = require("../electron/developer-migrations.cjs");
const realtime = require("../electron/developer-realtime.cjs");
const { IdentityStore } = require("../electron/identity-store.cjs");
const { createDeveloperBundle } = require("../electron/developer-service.cjs");
const { registerDeveloperIpc, disposeDeveloperIpc } = require("../electron/developer-bootstrap.cjs");

const tmpDirs = [];
after(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-dev-fusion-")); tmpDirs.push(dir); return dir; }

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
const TRUSTED_SENDER = { id: "trusted" };
const TRUSTED_URL = "file:///Application/OpenArc%20OS/index.html";
const trustedEvent = () => ({ sender: TRUSTED_SENDER, senderFrame: { url: TRUSTED_URL } });
const trustedGate = (event) => !!event && event.sender === TRUSTED_SENDER && !!event.senderFrame && event.senderFrame.url === TRUSTED_URL;

// ① 白名单 = 基座 ∪ 四切片 registry
test("白名单一一对应：16 基座 + 54 扩展 = 70 条，四切片 registry 全部登记", () => {
  const base = Object.keys(domain.DEVELOPER_BASE_COMMANDS);
  const ext = Object.keys(domain.DEVELOPER_EXTENSION_COMMANDS);
  assert.equal(base.length, 16);
  assert.equal(ext.length, 54);
  assert.equal(Object.keys(domain.DEVELOPER_COMMANDS).length, 70);
  const registry = [
    ...lab.DEVELOPER_LAB_COMMANDS, ...collab.DEVELOPER_COLLAB_COMMANDS,
    ...migrations.DEVELOPER_MIGRATION_COMMANDS, ...realtime.DEVELOPER_REALTIME_COMMANDS,
  ].map((entry) => entry.command);
  assert.deepEqual([...ext].sort(), [...new Set(registry)].sort(), "扩展白名单必须等于四切片 registry 并集");
  const merged = [...base, ...ext];
  assert.equal(new Set(merged).size, merged.length, "白名单不能有重复命令");
  for (const command of merged) assert.equal(domain.isDeveloperCommand(command), true, command);
});

// ② 无"登记未实现"：每条都能命中 handler
test("无登记未实现：四切片每条白名单命令都有 handler，dispatch 不返回 NOT_IMPLEMENTED", () => {
  const extensions = [
    lab.createDeveloperLabExtension({}),
    collab.createDeveloperCollabExtension({}),
    migrations.createDeveloperMigrationExtension({}),
    realtime.createDeveloperRealtimeExtension({}),
  ];
  for (const extension of extensions) {
    for (const entry of extension.registry) {
      assert.equal(typeof extension.handlers[entry.command], "function", entry.command + " 缺少 handler");
      const res = extension.dispatch({ command: entry.command, payload: {} });
      assert.notEqual(res.error, "NOT_IMPLEMENTED", entry.command + " 登记未实现");
      assert.notEqual(res.error, "DEVELOPER_COMMAND_NOT_ALLOWED", entry.command + " registry 与 dispatch 不一致");
      assert.equal(domain.isDeveloperCommand(entry.command), true, entry.command + " 未进白名单");
    }
  }
});

// ③ 无"实现未登记" + combine 全量路由
test("无实现未登记：基座 case 与四切片 handler 键全部在白名单内；combine 对 70 条全部路由", async () => {
  const extensions = [
    lab.createDeveloperLabExtension({}),
    collab.createDeveloperCollabExtension({}),
    migrations.createDeveloperMigrationExtension({}),
    realtime.createDeveloperRealtimeExtension({}),
  ];
  const handle = lab.combineDeveloperCommandHandlers({
    base: () => ({ ok: true, served: "base" }),
    extensions,
    isTrusted: () => true,
    identity: { current: "sess-fusion" },
    hostAppId: "ai",
  });
  const whitelist = Object.keys(domain.DEVELOPER_COMMANDS);
  for (const command of whitelist) {
    const res = await handle({}, { command, payload: {} });
    assert.notEqual(res.error, "DEVELOPER_COMMAND_NOT_ALLOWED", command + " 白名单但无实现");
    assert.notEqual(res.error, "NOT_IMPLEMENTED", command + " 登记未实现");
  }

  const source = fs.readFileSync(path.join(ROOT, "electron", "developer-service.cjs"), "utf8");
  const caseLabels = [...source.matchAll(/case "(developer\/[^"]+)":/g)].map((match) => match[1]);
  assert.equal(caseLabels.length, 16, "developer-service 基座应恰有 16 个 case");
  for (const label of caseLabels) assert.equal(domain.isDeveloperCommand(label), true, "实现未登记：" + label);
  const handlerKeys = extensions.flatMap((extension) => Object.keys(extension.handlers));
  for (const key of handlerKeys) assert.equal(domain.isDeveloperCommand(key), true, "实现未登记：" + key);
  const implemented = new Set([...caseLabels, ...handlerKeys]);
  assert.deepEqual([...implemented].sort(), [...whitelist].sort(), "白名单与实现必须一一对应");
});

// ④ bootstrap 合流：扩展命中切片、基座回落、未认证拒绝
test("bootstrap 合流：扩展命令命中切片、基座回落 bundle、未认证会话拒绝", async () => {
  const dir = tempDir();
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  try {
    const bundle = createDeveloperBundle({
      userDataDir: dir,
      identityStore: store,
      authorization: { resolveActor: () => ({ ok: true, user: { id: "u-fusion" } }) },
      clock: () => 1_700_000_000_000,
    });
    const ipcMain = makeIpcMain();
    const domainExtensions = lab.createDeveloperDomainExtensions({});
    registerDeveloperIpc({ ipcMain, bundle, domainExtensions, isTrusted: trustedGate, identity: { current: "sess-fusion" }, hostAppId: "ai" });

    const health = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/health", payload: {} });
    assert.equal(health.ok, true, JSON.stringify(health));
    // B7h：这里只有 lab 切片（createDeveloperDomainExtensions({}) 的默认），实际可达 = 16 + 20，
    // 不再拿静态白名单 70 冒充；白名单长度改在 declaredCommands 对照。
    assert.equal(health.value.commands, 36);
    assert.equal(health.value.declaredCommands, 70);
    assert.equal(health.value.degraded, true);
    assert.deepEqual(health.value.extensions, { lab: "ok", collab: "missing", migrations: "missing", realtime: "missing" });

    const templates = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/lab/templates", payload: {} });
    assert.equal(templates.ok, true, JSON.stringify(templates));
    assert.ok(Array.isArray(templates.templates));

    const labList = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/lab/list", payload: {} });
    assert.equal(labList.ok, false);
    assert.equal(labList.error, "DEVELOPER_LAB_UNAVAILABLE", "必须命中 lab 切片而不是被白名单拒绝");

    const denied = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/lab/templates", payload: {} });
    assert.equal(denied.ok, true);
    disposeDeveloperIpc({ ipcMain });
    registerDeveloperIpc({ ipcMain, bundle, domainExtensions, isTrusted: trustedGate, identity: { current: null } });
    const unauth = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/lab/templates", payload: {} });
    assert.equal(unauth.error, "DEVELOPER_UNAUTHENTICATED", "扩展命令也必须已认证");
  } finally { try { store.close(); } catch { /* 已关 */ } }
});

// ⑤ B7h：经 bootstrap 覆盖四切片全部命令（此前只覆盖 lab）
test("bootstrap 四切片全命令可达：health 报 70 且 70 条逐一不被 COMMAND_NOT_ALLOWED 拒绝", async () => {
  const dir = tempDir();
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  try {
    const bundle = createDeveloperBundle({
      userDataDir: dir,
      identityStore: store,
      authorization: { resolveActor: () => ({ ok: true, user: { id: "u-fusion" } }) },
      clock: () => 1_700_000_000_000,
    });
    // 四个切片全部登记（依赖用最小替身：本用例验证的是"路由 + 白名单合流 + health 可达数"，
    // 各切片内部行为由 dxos-developer-{lab,collab,migrations,realtime}.test.mjs 覆盖）。
    const domainExtensions = lab.createDeveloperDomainExtensions({
      lab: {}, collab: {}, migrationStore: {}, migrationFs: null, realtimeHub: {},
    });
    assert.equal(domainExtensions.commandNames.length, 54);

    const ipcMain = makeIpcMain();
    registerDeveloperIpc({ ipcMain, bundle, domainExtensions, isTrusted: trustedGate, identity: { current: "sess-fusion" }, hostAppId: "ai" });

    const health = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/health", payload: {} });
    assert.equal(health.ok, true, JSON.stringify(health));
    assert.equal(health.value.commands, 70, "四切片齐备时实际可达 = 16 + 54");
    assert.equal(health.value.declaredCommands, 70);
    assert.equal(health.value.degraded, false);
    assert.deepEqual(health.value.extensions, { lab: "ok", collab: "ok", migrations: "ok", realtime: "ok" });

    for (const command of Object.keys(domain.DEVELOPER_COMMANDS)) {
      const res = await ipcMain.invoke("developer:command", trustedEvent(), { command, payload: {} });
      assert.notEqual(res.error, "DEVELOPER_COMMAND_NOT_ALLOWED", command + " 经 bootstrap 必须可达");
    }
  } finally { try { store.close(); } catch { /* 已关 */ } }
});

// ⑥ B7h：模拟切片装配失败 → health 显式 degraded + 缺哪片，且缺片命令回落 COMMAND_NOT_ALLOWED
test("切片装配失败可观测：health degraded/缺哪片，缺片命令回落 COMMAND_NOT_ALLOWED", async () => {
  const dir = tempDir();
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  try {
    const bundle = createDeveloperBundle({
      userDataDir: dir,
      identityStore: store,
      authorization: { resolveActor: () => ({ ok: true, user: { id: "u-fusion" } }) },
      clock: () => 1_700_000_000_000,
    });
    // migrations / realtime 模拟构造失败：不登记切片（依赖传 null）。
    const domainExtensions = lab.createDeveloperDomainExtensions({ lab: {}, collab: {} });
    assert.equal(domainExtensions.commandNames.length, 32);

    const ipcMain = makeIpcMain();
    registerDeveloperIpc({
      ipcMain, bundle, domainExtensions,
      extensionStatus: { extensions: { migrations: "missing", realtime: "missing" }, error: "模拟故障：migrations / realtime 切片装配失败" },
      isTrusted: trustedGate, identity: { current: "sess-fusion" }, hostAppId: "ai",
    });

    const health = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/health", payload: {} });
    assert.equal(health.ok, true, JSON.stringify(health));
    assert.equal(health.value.degraded, true, "任一切片失败必须显式 degraded");
    assert.equal(health.value.commands, 48, "实际可达 = 16 + 20 lab + 12 collab");
    assert.equal(health.value.declaredCommands, 70);
    assert.equal(health.value.extensions.migrations, "missing");
    assert.equal(health.value.extensions.realtime, "missing");
    assert.match(String(health.value.degradedReason), /模拟故障/, "失败原因必须带进 health，不得只吞成 warn");

    const missingMigration = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/migrations/apply", payload: {} });
    assert.equal(missingMigration.ok, false);
    assert.equal(missingMigration.error, "DEVELOPER_COMMAND_NOT_ALLOWED");
    const missingRealtime = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/realtime/create", payload: {} });
    assert.equal(missingRealtime.ok, false);
    assert.equal(missingRealtime.error, "DEVELOPER_COMMAND_NOT_ALLOWED");

    // 装配成功的切片不受缺片拖累。
    const labOk = await ipcMain.invoke("developer:command", trustedEvent(), { command: "developer/lab/templates", payload: {} });
    assert.equal(labOk.ok, true, JSON.stringify(labOk));
  } finally { try { store.close(); } catch { /* 已关 */ } }
});

