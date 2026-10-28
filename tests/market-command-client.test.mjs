import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "node_modules/.cache/oa-market-command-client-" + process.pid + ".mjs");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await esbuild.build({
  stdin: {
    contents: 'export * from "./src-vue/apps/market/commandClient.ts"; export * from "./src-vue/apps/market/marketNormalization.ts";',
    resolveDir: ROOT,
    sourcefile: "market-command-client-test.ts",
  },
  bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent",
});
test.after(() => { try { fs.rmSync(OUT, { force: true }); } catch { /* 忽略 */ } });
const mod = await import(pathToFileURL(OUT).href);
const options = { missingCode: "MISSING", internalCode: "INTERNAL" };

test("commandClient：缺桥、成功信封、后端错误和异常 detail 统一归一化", async () => {
  assert.deepEqual(await mod.commandClient(null, "x", {}, options), { ok: false, error: "MISSING", detail: "" });
  assert.deepEqual(await mod.commandClient({ command: async () => ({ ok: true, value: 0 }) }, "x", {}, options), { ok: true, value: 0, error: "", detail: "" });
  assert.deepEqual(await mod.commandClient({ command: async () => ({ ok: false, value: { kept: true }, error: "DENIED", detail: "why" }) }, "x", {}, options), { ok: false, value: { kept: true }, error: "DENIED", detail: "why" });
  assert.deepEqual(await mod.commandClient({ command: async () => { throw new Error("boom"); } }, "x", {}, options), { ok: false, error: "INTERNAL", detail: "boom" });
  assert.deepEqual(await mod.commandClient({ command: async () => "not-an-envelope" }, "x", {}, options), { ok: false, value: undefined, error: "INTERNAL", detail: "" });
});

test("marketCall：保留 marketUpdate 优先与 market fallback，skill 保留专用错误码", async () => {
  const calls = [];
  globalThis.window = { openarc: {
    marketUpdate: { command: async (req) => { calls.push(["update", req]); return { ok: true, value: "new" }; } },
    market: { command: async () => ({ ok: true, value: "old" }) },
  } };
  assert.equal((await mod.marketCall("market/catalog", { a: 1 })).value, "new");
  assert.deepEqual(calls, [["update", { command: "market/catalog", payload: { a: 1 } }]]);
  globalThis.window = { openarc: { market: { command: async () => ({ ok: true, value: "fallback" }) } } };
  assert.equal((await mod.marketCall("market/catalog")).value, "fallback");
  globalThis.window = { openarc: {} };
  assert.equal((await mod.marketCall("market/catalog")).error, "MARKET_NOT_READY");
  assert.equal((await mod.skillCall("skill/list")).error, "SKILL_NOT_READY");
  globalThis.window = { openarc: { skill: { command: async () => { throw new Error("skill boom"); } } } };
  assert.deepEqual(await mod.skillCall("skill/list"), { ok: false, error: "SKILL_INTERNAL", detail: "skill boom" });
});

test("纯 normalize：集成依赖、第三方目录/健康与 Skill 保留后端语义", () => {
  const plugin = mod.normalizeIntegrationPlugin({ id: "weather", enabled: true, dependencies: [{ id: "cred", kind: "credential", required: true }, null], missingRequired: ["cred", 2] });
  assert.equal(plugin.name, "weather");
  assert.equal(plugin.status, "disabled");
  assert.equal(plugin.dependencies.length, 1);
  assert.equal(plugin.dependencies[0].status, "unknown");
  assert.deepEqual(plugin.missingRequired, ["cred"]);
  assert.equal(mod.normalizeIntegrationPlugin(null), null);

  const list = mod.normalizeThirdList({
    systemVersion: "0.1.0",
    local: { present: true, ok: true, apps: [{ id: "local", size: "12" }, { name: "missing id" }], rejected: [{ id: "bad" }] },
    online: { configured: true, ok: true, apps: [{ id: "online", source: "local" }] },
    installed: [{ id: "local", installedAt: "42" }, { id: "" }],
  }, "未知");
  assert.equal(list.local.apps[0].size, 12);
  assert.equal(list.local.apps[0].source, "local");
  assert.equal(list.local.rejected[0].reason, "未知");
  assert.equal(list.online.apps[0].source, "online");
  assert.equal(list.installed.length, 1);
  assert.equal(list.installed[0].installedAt, 42);
  assert.equal(list.installed[0].effectiveSource, "builtin");

  const health = mod.normalizeHealth({ effectiveSource: "installed", installedLoadable: true, installed: { version: "2.0.0" } });
  assert.equal(health.ok, true);
  assert.equal(health.installed.version, "2.0.0");
  const skill = mod.normalizeMarketSkill({ id: "writing", builtin: true, source: { instructions: "write" } });
  assert.equal(skill.enabled, true);
  assert.equal(skill.source.instructions, "write");
  assert.equal(mod.normalizeMarketSkill({}), null);
});
