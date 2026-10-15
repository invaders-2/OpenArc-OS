/**
 * B7x · automation app_action 可达性（全离线：真实 identity.db + 真实 developer-store +
 * 真实 automation-service；执行端是注入的假 runTool）。
 *
 * 覆盖验收条目：
 *   ① 已安装 App 的 canvas 声明（agent-tool 执行器 + kind=run 动作）投影成可执行 app_action，
 *      runNow 真的走到注入的 runTool（不伪造）；
 *   ② capabilities.tools 声明的工具同样可执行；
 *   ③ 没有任何可用动作 / 动作不存在时保持结构化拒绝（AUTOMATION_NOT_FOUND），不伪造成功；
 *   ④ 主进程 app_action 适配器复用同一份投影（源码级接线断言）。
 *
 * 只读源：server/automations.ts:122-146、server/automationBusinessActions.ts:69-108。
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { IdentityStore } = require("../electron/identity-store.cjs");
const { writeZip } = require("../electron/canvas-dxos-zip.cjs");
const developerDomain = require("../electron/developer-domain.cjs");
const { createDeveloperBundle } = require("../electron/developer-service.cjs");
const { createDeveloperStore } = require("../electron/developer-store.cjs");
const automationStore = require("../electron/automation-store.cjs");
const { createAutomationBundle } = require("../electron/automation-service.cjs");

const BASE = Date.UTC(2023, 10, 13, 0, 0, 0);
const USER = "u-app-action";
const tmpDirs = [];
const openStores = [];

afterEach(() => {
  automationStore.resetAutomationStoreForTests();
  while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } }
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeAuth() {
  return { resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: USER } } : { ok: false, error: "no-session" }) };
}

function makeClock(start = BASE) {
  let value = start;
  return { now: () => value, set: (next) => { value = next; } };
}

const json = (value) => Buffer.from(JSON.stringify(value));

function canvasNodeManifest() {
  return {
    format: "dx-canvas-nodes/v2",
    nodes: [{
      type: "demo.image-gen",
      version: 1,
      stateVersion: 1,
      capabilityVersion: 2,
      title: "品牌出图",
      defaultSize: { width: 320, height: 240 },
      inputs: [{ id: "prompt", title: "提示词", type: "text" }],
      outputs: [{ id: "images", title: "图片", type: "media.image[]", multiple: true }],
      host: { generation: { kind: "image", parameterPanel: "standard", outputPort: "images" }, output: { targets: ["inline"], defaultTarget: "inline", defaultPort: "images" } },
      agent: { actions: [{ id: "run", title: "生成品牌图片", kind: "run", promptParameter: "params.prompt" }, { id: "read", title: "读取设置", kind: "read" }] },
      semanticRoles: ["generator"],
      executor: { type: "agent-tool", toolName: "canvas.ai.generate" },
    }],
  };
}

/** 只有内建执行器（无 runTool 出口）的 canvas 声明 —— 不产生可执行动作。 */
function canvasNoExecutableManifest() {
  const manifest = canvasNodeManifest();
  manifest.nodes[0].executor = { type: "builtin", id: "demo.panel" };
  manifest.nodes[0].host = undefined;
  manifest.nodes[0].semanticRoles = undefined;
  return manifest;
}

function makeManifest(overrides = {}) {
  return Object.assign({ format: "dx-app/v2", id: "demo", name: "Demo App", description: "a demo developer application", version: "1.0.0", build: 1 }, overrides);
}

function buildPackage(manifest, entries) {
  return writeZip([
    { name: "dx-app.json", data: json(manifest) },
    { name: "index.html", data: Buffer.from("<html><body>demo</body></html>") },
    ...entries,
  ]);
}

function openDeveloper() {
  const dir = tempDir("dxos-app-action-");
  const identityStore = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(identityStore);
  const clock = makeClock();
  const bundle = createDeveloperBundle({ userDataDir: dir, identityStore, authorization: makeAuth(), clock: () => clock.now(), lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
  return {
    dir,
    identityStore,
    clock,
    install: (manifest, entries) => bundle.execute("developer/install", { package: buildPackage(manifest, entries).toString("base64") }, { sessionRef: "s-dev", requestId: "r-dev" }),
    run: (command, payload) => bundle.execute(command, payload || {}, { sessionRef: "s-dev", requestId: "r-dev" }),
  };
}

/** 与 electron/main.cjs 的 createAutomationDeveloperAppsAdapter 同一条装配路径（同一工厂）。 */
function openAutomation(fx, runTool) {
  const developerStore = createDeveloperStore({ db: fx.identityStore.connection, dataRoot: path.join(fx.dir, "dxos"), clock: () => fx.clock.now() });
  const developerApps = developerDomain.createDeveloperAppActionAdapter({ store: developerStore, runTool });
  const clock = makeClock();
  const bundle = createAutomationBundle({
    identityStore: fx.identityStore,
    authorization: makeAuth(),
    clock: () => clock.now(),
    sleeper: async () => {},
    developerApps,
    localAccounts: { findUser: (userId) => ({ id: String(userId) }) },
    toolCatalog: { runTool },
  });
  return {
    bundle,
    clock,
    invoke: (command, payload) => bundle.execute(command, payload || {}, { sessionRef: "s-auto", requestId: "r-auto" }),
  };
}

// ── ① canvas 声明真的可执行 ──────────────────────────────────────────────
test("app_action：已安装 App 的 canvas 动作真的走到 runTool（假执行端）", async () => {
  const fx = openDeveloper();
  const installed = await fx.install(makeManifest({ canvas: { nodeManifests: ["canvas.nodes.json"] } }), [
    { name: "canvas.nodes.json", data: json(canvasNodeManifest()) },
  ]);
  assert.equal(installed.ok, true, JSON.stringify(installed));

  const calls = [];
  const fakeRunTool = async (toolName, values, actor, options) => {
    calls.push({ toolName, values, actor, options });
    return "画布动作已执行：" + toolName;
  };
  const auto = openAutomation(fx, fakeRunTool);

  const created = await auto.invoke("automation/create", {
    definition: { instruction: "品牌出图", schedule: { type: "once", at: BASE + 1000 }, action: { type: "app_action", args: { appId: "dev-demo", actionId: "demo.image-gen.run" } } },
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  auto.clock.set(BASE + 1000);
  const run = await auto.invoke("automation/runNow", { automationId: created.value.automation.id, await: true });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.match(run.value.result.result, /canvas\.ai\.generate/);
  assert.deepEqual(calls.map((call) => call.toolName), ["canvas.ai.generate"]);
  assert.deepEqual(calls[0].options, { sourceId: "dev-demo" });
  assert.equal(calls[0].actor.id, USER);
});

test("app_action：capabilities.tools 声明的工具同样可执行（投影含两类来源）", async () => {
  const fx = openDeveloper();
  const installed = await fx.install(makeManifest({ agent: { toolManifest: "agent.tools.json" } }), [
    { name: "agent.tools.json", data: json({ tools: [{ name: "demo_tool", title: "演示工具", risk: "read", handler: { type: "app-api", endpoint: "/x" } }] }) },
  ]);
  assert.equal(installed.ok, true, JSON.stringify(installed));

  const calls = [];
  const fakeRunTool = async (toolName, values) => { calls.push({ toolName, values }); return "工具已执行"; };
  const auto = openAutomation(fx, fakeRunTool);

  const created = await auto.invoke("automation/create", {
    definition: { instruction: "调用工具", schedule: { type: "once", at: BASE + 1000 }, action: { type: "app_action", args: { appId: "dev-demo", actionId: "demo_tool", values: { query: "x" } } } },
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  auto.clock.set(BASE + 1000);
  const run = await auto.invoke("automation/runNow", { automationId: created.value.automation.id, await: true });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.deepEqual(calls, [{ toolName: "demo_tool", values: { query: "x" } }]);
});

// ── ③ 无可用动作：结构化拒绝，不伪造 ─────────────────────────────────────
test("app_action：无可用动作 / 动作不存在时结构化拒绝（AUTOMATION_NOT_FOUND）", async () => {
  const fx = openDeveloper();
  const installed = await fx.install(makeManifest({ canvas: { nodeManifests: ["canvas.nodes.json"] } }), [
    { name: "canvas.nodes.json", data: json(canvasNoExecutableManifest()) },
  ]);
  assert.equal(installed.ok, true, JSON.stringify(installed));

  const auto = openAutomation(fx, async () => "不应被调用");
  const noAction = await auto.invoke("automation/create", {
    definition: { instruction: "无动作", schedule: { type: "once", at: BASE + 1000 }, action: { type: "app_action", args: { appId: "dev-demo", actionId: "demo.image-gen.run" } } },
  });
  assert.equal(noAction.ok, false, JSON.stringify(noAction));
  assert.equal(noAction.error, "AUTOMATION_NOT_FOUND");

  const unknown = await auto.invoke("automation/create", {
    definition: { instruction: "未知动作", schedule: { type: "once", at: BASE + 1000 }, action: { type: "app_action", args: { appId: "dev-demo", actionId: "nope" } } },
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "AUTOMATION_NOT_FOUND");

  const missingApp = await auto.invoke("automation/create", {
    definition: { instruction: "未知 App", schedule: { type: "once", at: BASE + 1000 }, action: { type: "app_action", args: { appId: "dev-missing", actionId: "demo.image-gen.run" } } },
  });
  assert.equal(missingApp.ok, false);
  assert.equal(missingApp.error, "AUTOMATION_NOT_FOUND");
});

test("app_action：能力目录只列出真实可执行动作（read 动作不投影）", async () => {
  const fx = openDeveloper();
  await fx.install(makeManifest({ canvas: { nodeManifests: ["canvas.nodes.json"] } }), [
    { name: "canvas.nodes.json", data: json(canvasNodeManifest()) },
  ]);
  const developerStore = createDeveloperStore({ db: fx.identityStore.connection, dataRoot: path.join(fx.dir, "dxos"), clock: () => fx.clock.now() });
  const adapter = developerDomain.createDeveloperAppActionAdapter({ store: developerStore, runTool: async () => "x" });
  const catalog = adapter.catalog(USER);
  assert.equal(catalog.length, 1);
  assert.deepEqual(catalog[0].actions.map((action) => action.id), ["demo.image-gen.run"]);
  assert.equal(catalog[0].enabled, true);
  assert.deepEqual(adapter.installedAppIds(USER), ["dev-demo"]);
});

test("app_action：App 未安装（已禁用）时执行期结构化拒绝，不伪造成功", async () => {
  const fx = openDeveloper();
  await fx.install(makeManifest({ canvas: { nodeManifests: ["canvas.nodes.json"] } }), [
    { name: "canvas.nodes.json", data: json(canvasNodeManifest()) },
  ]);
  const auto = openAutomation(fx, async () => "不应被调用");
  const created = await auto.invoke("automation/create", {
    definition: { instruction: "禁用后执行", schedule: { type: "once", at: BASE + 1000 }, action: { type: "app_action", args: { appId: "dev-demo", actionId: "demo.image-gen.run" } } },
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const disabled = await fx.run("developer/disable", { appId: "dev-demo" });
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  auto.clock.set(BASE + 1000);
  const run = await auto.invoke("automation/runNow", { automationId: created.value.automation.id, await: true });
  assert.equal(run.ok, false, JSON.stringify(run));
  assert.equal(run.error, "AUTOMATION_INVALID_INPUT");
  assert.match(String(run.message), /未安装/);
});

// ── ④ 主进程接线（源码级） ───────────────────────────────────────────────
test("装配契约（源码级）：main.cjs 的 app_action 适配器复用 developer-domain 的工厂", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "electron", "main.cjs"), "utf8");
  assert.ok(main.includes("createDeveloperAppActionAdapter"), "main.cjs 必须复用 createDeveloperAppActionAdapter");
  assert.ok(!/退化为能力清单里的工具声明/.test(main), "main.cjs 不得再保留旧的 tools-only 投影注释");
  // 投影真值只有一处：developer-domain.cjs。
  const adapterSource = fs.readFileSync(path.join(process.cwd(), "electron", "developer-domain.cjs"), "utf8");
  assert.ok(adapterSource.includes("function projectDeveloperAppActions"), "投影函数必须在 developer-domain.cjs");
  assert.ok(adapterSource.includes("capabilities.canvas"), "投影必须读取 capabilities.canvas");
});
