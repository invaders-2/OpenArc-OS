/**
 * X4 · main.cjs 的 automation integrations 接线（全离线：真实 identity.db + 假时钟 + 真实 plugin-service）。
 *
 * 覆盖任务书验收点：
 *   · 源码级：main.cjs 的 integrations 适配器取自 plugin-service 的唯一真值
 *     pluginBundle.automationAdapter；只有它缺失才回落旧实现，且回落必须出声（不静默）；
 *     装配 createPluginBundle 处不注入任何 MCP 传输（无人值守同步的授权通道待产品决策）。
 *   · 运行时：完全不注入传输时，自动化同步动作一律结构化
 *     INTEGRATION_UNAVAILABLE → AGENT_DEPENDENCY_UNAVAILABLE，且 0 次网络。
 *
 * 只读源：electron/plugin-service.cjs:927-992（automationAdapter 真值）、
 *         server/automationBusinessActions.ts:69-147（同步动作语义）。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { IdentityStore } = require("../electron/identity-store.cjs");
const automationStore = require("../electron/automation-store.cjs");
const { createAutomationBundle } = require("../electron/automation-service.cjs");
const { createPluginBundle } = require("../electron/plugin-service.cjs");

const BASE = Date.UTC(2023, 10, 13, 0, 0, 0);
const USER = "u-auto-wiring";
const MAIN_PATH = path.join(process.cwd(), "electron", "main.cjs");
const tmpDirs = [];
const openStores = [];
const openBundles = [];

afterEach(() => {
  automationStore.resetAutomationStoreForTests();
  while (openBundles.length) {
    const bundle = openBundles.pop();
    try { bundle.ziniao.close(); } catch { /* 已关 */ }
    try { bundle.lingxing.close(); } catch { /* 已关 */ }
  }
  while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } }
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(dir); return dir; }
function makeAuth() { return { resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: USER } } : { ok: false, error: "no-session" }) }; }
const okProbe = () => ({ ok: true, status: "ok", detail: "" });

/** 与 electron/main.cjs 的装配同形：只注入 fetch（网络计数），绝不注入任何 MCP 传输。 */
function makePluginBundle() {
  const calls = [];
  const bundle = createPluginBundle({
    userDataDir: tempDir("dxos-plugin-wiring-"),
    safeStorage: null,
    fetch: async (...args) => { calls.push(args); return { ok: false, status: 0, json: async () => ({}) }; },
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  });
  openBundles.push(bundle);
  return { bundle, calls };
}

function openAutomation(integrations) {
  const dir = tempDir("dxos-automation-wiring-");
  const idStore = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(idStore);
  return createAutomationBundle({ identityStore: idStore, authorization: makeAuth(), clock: () => BASE, sleeper: async () => {}, integrations });
}
const invoke = (bundle, command, payload) => bundle.execute(command, payload, { sessionRef: "sess-wiring", requestId: "req-wiring" });

// ── 源码级装配契约 ─────────────────────────────────────────────────────────
test("装配契约（源码级）：main.cjs 的 integrations 取 pluginBundle.automationAdapter，缺省才回落且出声", () => {
  const main = fs.readFileSync(MAIN_PATH, "utf8");
  assert.ok(main.includes("pluginBundle.automationAdapter"), "main.cjs 必须使用 plugin-service 导出的唯一真值 automationAdapter");
  assert.ok(/if\s*\(pluginBundle\.automationAdapter\)/.test(main), "必须按 automationAdapter 是否存在分支");
  // 回落必须可观察：写清原因 + console.warn 出声，绝不静默。
  assert.ok(main.includes("未导出 automationAdapter"), "回落原因必须显式写明");
  assert.ok(main.includes('console.warn("[openarc] " + automationIntegrationsNote)'), "回落必须 console.warn 出声");
  assert.ok(main.includes("integrations: automationIntegrationsNote,"), "回落原因必须进 automation/health 的 adapterNotes");
  // 旧适配器只能出现在回落分支：任务书描述的旧接线（无条件使用）必须消失。
  assert.equal(main.includes("const automationIntegrations = createAutomationIntegrationsAdapter({ pluginBundle });"), false, "不得再无条件使用旧 integrations 适配器");
});

test("装配契约（源码级）：main.cjs 装配 plugin-service 不注入 MCP 传输（授权通道待产品决策）", () => {
  const main = fs.readFileSync(MAIN_PATH, "utf8");
  const start = main.indexOf("pluginBundle = createPluginBundle({");
  assert.notEqual(start, -1, "main.cjs 必须装配 createPluginBundle");
  const end = main.indexOf("});", start);
  assert.notEqual(end, -1);
  const block = main.slice(start, end);
  for (const key of ["mcpTransport", "mcpCallDirect", "transportFactory"]) {
    assert.equal(block.includes(key), false, "授权通道未决策前不得注入 " + key + "（保持 fail-closed）");
  }
  assert.ok(block.includes("授权通道待产品决策"), "装配处必须写明授权通道待产品决策");
});

// ── 运行时：未注入传输 = 未决策前保持不可用 ───────────────────────────────
test("未注入传输：automationAdapter 同步动作在适配器层结构化 INTEGRATION_UNAVAILABLE，0 次网络", async () => {
  const { bundle, calls } = makePluginBundle();
  assert.ok(bundle.automationAdapter && typeof bundle.automationAdapter === "object", "plugin-service 必须导出 automationAdapter");
  for (const [method, args] of [["lingxingCacheSync", { days: 1 }], ["ziniaoDownload", { days: 1 }], ["ziniaoDataSync", { days: 7 }]]) {
    await assert.rejects(() => bundle.automationAdapter[method](args), (error) => {
      assert.equal(error.code, "INTEGRATION_UNAVAILABLE", method + " 必须结构化不可用");
      return true;
    });
  }
  assert.equal(calls.length, 0, "未注入传输且插件默认关时不得发起任何网络请求");
});

test("未注入传输：插件已启用仍结构化 INTEGRATION_UNAVAILABLE（闸门在传输，不在插件开关）", async () => {
  const { bundle, calls } = makePluginBundle();
  const enabled = await bundle.execute("integration/plugins/enable", { id: "lingxing" }, { sessionRef: "sess-wiring" });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  await assert.rejects(() => bundle.automationAdapter.lingxingCacheSync({ days: 1 }), (error) => {
    assert.equal(error.code, "INTEGRATION_UNAVAILABLE");
    assert.match(String(error.message), /未注入.*传输/);
    return true;
  });
  assert.equal(calls.length, 0, "未注入传输不得发起网络");
});

test("未注入传输：自动化同步动作结构化 AGENT_DEPENDENCY_UNAVAILABLE 且 0 次网络", async () => {
  const { bundle, calls } = makePluginBundle();
  const automation = openAutomation(bundle.automationAdapter);
  const cases = [
    { action: { type: "lingxing_cache_sync", args: { days: 1 } }, dependency: "integrations.lingxingCacheSync" },
    { action: { type: "ziniao_download", args: { days: 1 } }, dependency: "integrations.ziniaoDownload" },
    { action: { type: "ziniao_data_sync", args: { days: 7 } }, dependency: "integrations.ziniaoDataSync" },
  ];
  for (const item of cases) {
    const created = automationStore.createAutomation(USER, { instruction: "未决策", schedule: { type: "once", at: BASE + 1000 }, action: item.action });
    const result = await invoke(automation, "automation/runNow", { automationId: created.id, await: true });
    assert.equal(result.ok, false, item.action.type);
    assert.equal(result.error, "AGENT_DEPENDENCY_UNAVAILABLE", item.action.type);
    assert.equal(result.detail.dependency, item.dependency, item.action.type);
    assert.equal(result.detail.causeCode, "INTEGRATION_UNAVAILABLE", item.action.type);
  }
  assert.equal(calls.length, 0, "未决策前保持不可用：0 次网络");
});
