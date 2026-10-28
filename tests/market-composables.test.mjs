import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "node_modules/.cache/oa-market-composables-" + process.pid + ".mjs");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await esbuild.build({
  stdin: {
    contents: 'export * from "./src-vue/apps/market/useIntegrations.ts"; export * from "./src-vue/apps/market/useThirdPartyMarket.ts"; export * from "./src-vue/apps/market/useAppUpdates.ts";',
    resolveDir: ROOT,
    sourcefile: "market-composables-test.ts",
  },
  bundle: true, format: "esm", platform: "browser", outfile: OUT, logLevel: "silent",
});
test.after(() => { try { fs.rmSync(OUT, { force: true }); } catch { /* 忽略 */ } });
const mod = await import(pathToFileURL(OUT).href);
const matchesQuery = (...values) => values.some((value) => String(value).includes("match")) || !values.length;
const all = () => true;
const bridge = (command) => ({ command });
const ok = (value) => ({ ok: true, value });

test("useIntegrations：health 成功/失败、enable 后重读、open/connect 路由", async () => {
  const calls = [];
  let enabled = false;
  globalThis.window = { openarc: { integration: bridge(async ({ command, payload }) => {
    calls.push({ command, payload });
    if (command === "integration/plugins/enable") { enabled = true; return ok({}); }
    return ok({ items: [{ id: "weather", name: "Weather", description: "match", enabled, status: "ready", dependencies: [] }] });
  }) } };
  const activated = [];
  const state = mod.useIntegrations({ matchesQuery, activateApp: (id) => activated.push(id) });
  await state.loadIntegrations();
  assert.equal(state.integrationLoaded.value, true);
  assert.equal(state.integrationPlugins.value.length, 1);
  assert.equal(state.discoverExternal.value.length, 1);
  assert.equal(state.externalStateOf(state.integrationPlugins.value[0]), "install");
  await state.externalAction(state.integrationPlugins.value[0]);
  assert.equal(enabled, true);
  assert.equal(calls.filter((call) => call.command === "integration/plugins/health").length, 2);
  assert.equal(state.externalStateOf(state.integrationPlugins.value[0]), "open");
  await state.externalAction(state.integrationPlugins.value[0]);
  assert.deepEqual(activated, ["integrations"]);
  const connecting = { ...state.integrationPlugins.value[0], status: "unavailable" };
  await state.externalAction(connecting);
  assert.deepEqual(activated, ["integrations", "integrations"]);

  globalThis.window = { openarc: { integration: bridge(async () => ({ ok: false, error: "INTEGRATION_UNAVAILABLE", detail: "offline" })) } };
  const failed = mod.useIntegrations({ matchesQuery: all, activateApp: () => {} });
  await failed.loadIntegrations();
  assert.deepEqual(failed.integrationError.value, { code: "INTEGRATION_UNAVAILABLE", detail: "offline" });
  assert.deepEqual(failed.integrationPlugins.value, []);
});

test("useThirdPartyMarket：本地优先去重、来源保存、安装/回滚、health 与兼容性", async () => {
  const calls = [];
  let source = "https://market.example/catalog.json";
  const listValue = {
    systemVersion: "1.2.0",
    local: { present: true, ok: true, apps: [{ id: "same", name: "Local", version: "1.0.0", minSystemVersion: "1.0.0", maxSystemVersion: "2.0.0" }], rejected: [{ id: "bad" }] },
    online: { configured: true, ok: true, apps: [{ id: "same", name: "Online duplicate" }, { id: "online", name: "Online", packageUrl: "https://market.example/app.zip", minSystemVersion: "2.0.0" }], rejected: [] },
    installed: [{ id: "same", version: "1.0.0" }],
  };
  globalThis.window = { openarc: { marketUpdate: bridge(async ({ command, payload }) => {
    calls.push({ command, payload });
    if (command === "market/thirdparty/list") return ok(listValue);
    if (command === "market/thirdparty/source/get") return ok({ url: source });
    if (command === "market/thirdparty/source/set") { source = payload.url; return ok({}); }
    if (command === "market/thirdparty/install") return ok({ installed: { alreadyInstalled: true, version: "1.0.0" } });
    if (command === "market/thirdparty/rollback") return ok({ rolledBackTo: "0.9.0" });
    if (command === "market/update/health") return ok({ effectiveSource: "installed", installedLoadable: true, installed: { version: "1.0.0" } });
    throw new Error("unexpected " + command);
  }) } };
  const state = mod.useThirdPartyMarket({ matchesQuery: all });
  await state.loadThirdParty();
  assert.deepEqual(state.catalogApps.value.map((app) => app.id), ["same", "online"]);
  assert.equal(state.catalogApps.value[0].name, "Local", "在线重复 id 不覆盖本地目录");
  assert.equal(state.rejectedEntries.value.length, 1);
  assert.equal(state.installedOf("same").version, "1.0.0");
  assert.equal(state.thirdHealth.same.installedLoadable, true);
  assert.match(state.installedHealthText("same"), /可加载/);
  assert.equal(state.compatibilityOf(state.localApps.value[0]).ok, true);
  assert.equal(state.compatibilityOf(state.onlineApps.value[1]).ok, false);
  assert.match(state.packageText(state.onlineApps.value[1]), /market\.example/);

  state.askInstall(state.localApps.value[0]);
  assert.equal(state.installPick.value.id, "same");
  await state.acceptInstall();
  assert.match(state.thirdNotice.value, /alreadyInstalled/);
  assert.deepEqual(calls.find((call) => call.command === "market/thirdparty/install").payload, { appId: "same", confirm: true });
  state.askRollback(state.installedOf("same"));
  await state.acceptRollback();
  assert.match(state.thirdNotice.value, /0\.9\.0/);

  state.thirdSourceDraft.value = "  https://market.example/next.json  ";
  await state.saveThirdSource();
  assert.equal(source, "https://market.example/next.json");
  assert.equal(state.thirdSourceDraft.value, source);
  assert.match(state.thirdNotice.value, /已保存/);
  assert.equal(calls.filter((call) => call.command === "market/thirdparty/list").length, 4);
});

test("useAppUpdates：真实状态分区、版本投影与全应用 healthRows", async () => {
  const status = (appId) => ({
    appId, builtinVersion: "0.1.0", current: appId === "canvas" ? { version: "1.0.0", installedAt: 1 } : null,
    checkedAt: 100, latest: appId === "canvas" ? { version: "2.0.0", publishedAt: 2 } : null,
    updateAvailable: appId === "canvas", loadable: true, source: { kind: "local", owner: "", repo: "" },
  });
  globalThis.window = { openarc: { marketUpdate: bridge(async ({ command, payload }) => {
    if (command === "market/update/status") return ok(status(payload.appId));
    if (command === "market/update/health") {
      if (payload.appId === "files") return { ok: false, error: "MARKET_UPDATE_NOT_READY", detail: "no keys" };
      return ok({ effectiveSource: "builtin" });
    }
    throw new Error("unexpected " + command);
  }) } };
  const state = mod.useAppUpdates({ matchesQuery: all, descOf: () => "" });
  await state.loadStatuses();
  assert.equal(state.statusLoaded.value, true);
  assert.equal(state.statusBusy.value, false);
  assert.deepEqual(state.upgradable.value.map((app) => app.id), ["canvas"]);
  assert.equal(state.upToDate.value.length, 23);
  assert.equal(state.statusCurrent("canvas"), "1.0.0");
  assert.equal(state.statusLatest("canvas"), "2.0.0");
  assert.equal(state.statusChecked("canvas"), "100");
  await state.loadHealthRows();
  assert.equal(state.healthRows.value.length, 24);
  assert.equal(state.healthBusy.value, false);
  assert.equal(state.healthVersionText({ app: state.healthRows.value.find((row) => row.app.id === "canvas").app }), "1.0.0");
  assert.equal(state.healthRows.value.find((row) => row.app.id === "files").error.code, "MARKET_UPDATE_NOT_READY");
  assert.equal(state.healthRows.value.find((row) => row.app.id === "weather").health.effectiveSource, "builtin");
});
