/**
 * X2 · automation 同步动作接线测试（全离线：假 MCP 传输 / 真实 identity.db / 临时目录）。
 *
 * 覆盖任务书验收点：
 *   · automation 的 lingxing_cache_sync / ziniao_download / ziniao_data_sync 在"插件启用 + 依赖就绪"下
 *     被派发到 plugin-service 的真实方法（pluginBundle.automationAdapter），且真实传输被调用；
 *   · 插件默认关时结构化 AGENT_DEPENDENCY_UNAVAILABLE（dependency 精确到方法）且 0 次网络。
 *
 * 只读源：server/automationBusinessActions.ts:69-147（动作分派与依赖语义）。
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
const { createAutomationBundle } = require("../electron/automation-service.cjs");
const { createPluginBundle } = require("../electron/plugin-service.cjs");

const BASE = Date.UTC(2023, 10, 13, 0, 0, 0);
const USER = "u-auto";
const tmpDirs = [];
const openStores = [];
const openBundles = [];

afterEach(() => {
  store.resetAutomationStoreForTests();
  while (openBundles.length) { const bundle = openBundles.pop(); try { bundle.ziniao.close(); } catch { /* 已关 */ } try { bundle.lingxing.close(); } catch { /* 已关 */ } }
  while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } }
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(dir); return dir; }
function makeAuth() { return { resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: USER } } : { ok: false, error: "no-session" }) }; }
function trackPlugin(bundle) { openBundles.push(bundle); return bundle; }
function openAutomation(integrations) {
  const dir = tempDir("dxos-automation-sync-");
  const idStore = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(idStore);
  return createAutomationBundle({ identityStore: idStore, authorization: makeAuth(), clock: () => BASE, sleeper: async () => {}, integrations });
}
const invoke = (bundle, command, payload) => bundle.execute(command, payload, { sessionRef: "sess-auto", requestId: "req-auto" });

const okProbe = () => ({ ok: true, status: "ok", detail: "" });
const SAMPLE_SALES = [{ asin: "B0TEST0001", item_name: "样例产品一", volume: 3, amount: 99.5, order_items: 2, sessions: 40, currency_code: "CNY", seller_name: "样例店铺", country: "US", brand: "样例品牌" }];
const SUCCESS_DOWNLOAD = [{ file: "/tmp/vc.xlsx", files: ["/tmp/vc.xlsx"], rowCount: 5, downloadedDays: 1, skippedExistingDays: 0 }];

function makeMcpPort() {
  const calls = [];
  return {
    calls,
    async callTool(request) {
      calls.push({ serverId: request.serverId, toolName: request.toolName, args: request.arguments });
      if (request.toolName === "query_product_performance_asin_lists") return { ok: true, text: JSON.stringify({ code: 1, data: { list: SAMPLE_SALES, total: SAMPLE_SALES.length } }) };
      if (request.toolName === "start_client") return { ok: true, text: "{}" };
      if (request.toolName === "list_stores") return { ok: true, text: JSON.stringify([{ browserOauth: "oauth-1", browserName: "店铺一" }]) };
      if (request.toolName === "download_vc_summary") return { ok: true, text: JSON.stringify(SUCCESS_DOWNLOAD) };
      return { ok: true, text: JSON.stringify({ code: 1, data: {} }) };
    },
  };
}

function makeWorkbook(sheets) {
  return { worksheets: sheets.map((sheet) => ({
    name: sheet.name,
    rowCount: sheet.rows.length,
    columnCount: Math.max(...sheet.rows.map((row) => row.length)),
    getRow: (number) => {
      const cells = sheet.rows[number - 1];
      return { cellCount: cells.length, getCell: (column) => ({ text: String(cells[column - 1] == null ? "" : cells[column - 1]), value: cells[column - 1] }) };
    },
  })) };
}
const VC_ROWS = [
  ["日期", "账号", "Asin", "国家", "Product Title", "Brand", "Manufacturing or Sourcing", "Ordered Revenue", "Ordered Units", "Shipped Revenue", "Shipped COGS", "Shipped Units", "Customer Returns", "Session"],
  ["2026/01/02", "店铺A", "b0vc0001", "US", "商品一", "品牌A", "FBA", "120.5", "3", "100", "40", "2", "1", "55"],
  ["2026-01-03", "店铺A", "B0VC0001", "US", "商品一", "品牌A", "FBA", "80", "2", "70", "30", "2", "0", "40"],
];

function runAction(bundle, automationId) { return bundle.execute("automation/runNow", { automationId, await: true }, { sessionRef: "sess-auto", requestId: "req-auto" }); }

// ── 插件启用 + 依赖就绪：真实方法被派发并调用真实传输 ──────────────────────
test("automation 同步：lingxing_cache_sync 派发到真实方法并调用真实传输", async () => {
  const mcp = makeMcpPort();
  const pluginBundle = trackPlugin(createPluginBundle({
    userDataDir: tempDir("dxos-plugin-sync-"), safeStorage: null, mcpTransport: mcp,
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await pluginBundle.execute("integration/plugins/enable", { id: "lingxing" }, { sessionRef: "s1" })).ok, true);
  const automation = openAutomation(pluginBundle.automationAdapter);

  const created = store.createAutomation(USER, { instruction: "每日同步领星", schedule: { type: "once", at: BASE + 1000 }, action: { type: "lingxing_cache_sync", args: { days: 1 } } });
  const result = await runAction(automation, created.id);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.value.result.result, /领星缓存同步作业已启动/);
  await pluginBundle.lingxing.whenIdle();
  assert.ok(mcp.calls.some((call) => call.toolName === "query_product_performance_asin_lists"), "必须真正调用领星 MCP 工具");
});

test("automation 同步：ziniao_download 派发到真实方法并调用真实传输", async () => {
  const mcp = makeMcpPort();
  const pluginBundle = trackPlugin(createPluginBundle({
    userDataDir: tempDir("dxos-plugin-sync-"), safeStorage: null, mcpTransport: mcp,
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await pluginBundle.execute("integration/plugins/enable", { id: "ziniao" }, { sessionRef: "s1" })).ok, true);
  const automation = openAutomation(pluginBundle.automationAdapter);

  // automation 定义规约只保留 days；此处补 stores（源由 list_stores 解析，本仓适配器透传 args）。
  const created = store.createAutomation(USER, { instruction: "下载紫鸟", schedule: { type: "once", at: BASE + 1000 }, action: { type: "ziniao_download", args: { days: 1, stores: [{ selector: "s1", name: "店铺一" }] } } });
  const result = await runAction(automation, created.id);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.value.result.result, /紫鸟下载作业已启动：.+（店铺 1 个）/);
  await pluginBundle.ziniao.whenIdle();
  assert.ok(mcp.calls.some((call) => call.toolName === "download_vc_summary"), "必须真正调用紫鸟 MCP 工具");
});

test("automation 同步：ziniao_download 未给 stores 时按源 list_stores 解析店铺", async () => {
  const mcp = makeMcpPort();
  const pluginBundle = trackPlugin(createPluginBundle({
    userDataDir: tempDir("dxos-plugin-sync-"), safeStorage: null, mcpTransport: mcp,
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await pluginBundle.execute("integration/plugins/enable", { id: "ziniao" }, { sessionRef: "s1" })).ok, true);
  const automation = openAutomation(pluginBundle.automationAdapter);

  const created = store.createAutomation(USER, { instruction: "下载紫鸟", schedule: { type: "once", at: BASE + 1000 }, action: { type: "ziniao_download", args: { days: 1 } } });
  const result = await runAction(automation, created.id);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.value.result.result, /紫鸟下载作业已启动：.+（店铺 1 个）/);
  await pluginBundle.ziniao.whenIdle();
  const tools = mcp.calls.map((call) => call.toolName);
  assert.ok(tools.includes("start_client"), "必须按源先 start_client");
  assert.ok(tools.includes("list_stores"), "必须按源 list_stores 解析店铺");
  assert.ok(tools.includes("download_vc_summary"), "解析到店铺后必须真正下载");
});

test("automation 同步：ziniao_data_sync 派发到真实方法（本地 VC 文件 → 本地库，无需网络）", async () => {
  const dir = tempDir("dxos-plugin-sync-");
  const vcRoot = path.join(dir, "ziniao-vc");
  fs.mkdirSync(vcRoot, { recursive: true });
  const vcFile = path.join(vcRoot, "VC汇总_店铺A_20260102-20260103.xlsx");
  fs.writeFileSync(vcFile, "fake-bytes");
  const now = Date.now();
  fs.utimesSync(vcFile, new Date(now), new Date(now));

  const mcp = makeMcpPort();
  const pluginBundle = trackPlugin(createPluginBundle({
    userDataDir: dir, safeStorage: null, mcpTransport: mcp, ziniaoOutDir: vcRoot,
    workbookReader: async () => makeWorkbook([{ name: "VC", rows: VC_ROWS }]),
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await pluginBundle.execute("integration/plugins/enable", { id: "ziniao" }, { sessionRef: "s1" })).ok, true);
  const automation = openAutomation(pluginBundle.automationAdapter);

  const created = store.createAutomation(USER, { instruction: "同步紫鸟数据", schedule: { type: "once", at: BASE + 1000 }, action: { type: "ziniao_data_sync", args: { days: 365 } } });
  const result = await runAction(automation, created.id);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.value.result.result, /^已检查 1 个紫鸟文件，新增 2 条数据$/);
  assert.equal(pluginBundle.lingxing.queryLingxingLocalData({ source: "ziniao" }).total, 1);
  assert.equal(mcp.calls.length, 0, "ziniao_data_sync 只读本地文件与本地库，不发起网络");
});

// ── 插件默认关：结构化依赖缺失 + 0 次网络 ─────────────────────────────────
test("automation 同步：插件默认关 → AGENT_DEPENDENCY_UNAVAILABLE（精确到方法）且 0 次网络", async () => {
  const mcp = makeMcpPort();
  const pluginBundle = trackPlugin(createPluginBundle({
    userDataDir: tempDir("dxos-plugin-sync-"), safeStorage: null, mcpTransport: mcp,
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  const automation = openAutomation(pluginBundle.automationAdapter);

  const cases = [
    { action: { type: "lingxing_cache_sync", args: { days: 1 } }, dependency: "integrations.lingxingCacheSync" },
    { action: { type: "ziniao_download", args: { days: 1 } }, dependency: "integrations.ziniaoDownload" },
    { action: { type: "ziniao_data_sync", args: { days: 7 } }, dependency: "integrations.ziniaoDataSync" },
  ];
  for (const item of cases) {
    const created = store.createAutomation(USER, { instruction: "缺依赖", schedule: { type: "once", at: BASE + 1000 }, action: item.action });
    const result = await runAction(automation, created.id);
    assert.equal(result.ok, false, item.action.type);
    assert.equal(result.error, "AGENT_DEPENDENCY_UNAVAILABLE", item.action.type);
    assert.equal(result.detail.dependency, item.dependency, item.action.type);
  }
  assert.equal(mcp.calls.length, 0, "默认关不得发起任何 tools/call");
});
