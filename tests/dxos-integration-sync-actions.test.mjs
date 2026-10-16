/**
 * X2 · 领星 / 紫鸟同步动作接线测试（全离线：假 MCP 传输 / 临时目录 / 假 safeStorage）。
 *
 * 覆盖任务书验收点：
 *   ① 插件默认关 → 同步动作与 automation 适配器结构化 INTEGRATION_UNAVAILABLE 且 0 次网络；
 *   ② 依赖缺失（紫鸟 python3）→ enable 结构化拒绝 + detail 写清缺什么；force 启用后调用仍不可用，0 次网络；
 *   ③ 启用 + 依赖就绪 → 真实传输被调用（既有 MCP tools/call 形状 / mcpCallDirect 桥形状 / transportFactory）；
 *   ④ 传输失败（{ ok:false }）→ 结构化，绝不冒充成功；
 *   ⑤ ziniao_data_sync 逐字对齐源 automationBusinessActions.ts:122-135 的三种返回。
 *
 * 只读源：server/automationBusinessActions.ts:20-61,109-147。
 * 接线契约：createPluginBundle({ mcpTransport | mcpCallDirect | transportFactory })。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPluginBundle } = require("../electron/plugin-service.cjs");
const { safeStorageCredentialBackend } = require("../electron/credential-store.cjs");

const tmpDirs = [];
const openBundles = [];
afterEach(() => {
  while (openBundles.length) { const bundle = openBundles.pop(); try { bundle.ziniao.close(); } catch { /* 已关 */ } try { bundle.lingxing.close(); } catch { /* 已关 */ } }
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-sync-actions-")); tmpDirs.push(dir); return dir; }
function track(bundle) { openBundles.push(bundle); return bundle; }

const okProbe = () => ({ ok: true, status: "ok", detail: "" });
const missingPython = () => ({ ok: false, status: "missing", detail: "PATH 中找不到 python3" });

const SAMPLE_SALES = [{ asin: "B0TEST0001", item_name: "样例产品一", volume: 3, amount: 99.5, order_items: 2, sessions: 40, currency_code: "CNY", seller_name: "样例店铺", country: "US", brand: "样例品牌" }];
const SUCCESS_DOWNLOAD = [{ file: "/tmp/vc.xlsx", files: ["/tmp/vc.xlsx"], rowCount: 5, downloadedDays: 1, skippedExistingDays: 0 }];

/** 既有 MCP tools/call 端口（createMcpLiveTransport 的调用形状），callTool 记录每次请求。 */
function makeMcpPort({ sales = SAMPLE_SALES, stores = [{ browserOauth: "oauth-1", browserName: "店铺一" }], download = SUCCESS_DOWNLOAD } = {}) {
  const calls = [];
  return {
    calls,
    async callTool(request) {
      calls.push({ serverId: request.serverId, toolName: request.toolName, args: request.arguments });
      if (request.toolName === "query_product_performance_asin_lists") return { ok: true, text: JSON.stringify({ code: 1, data: { list: sales, total: sales.length } }) };
      if (request.toolName === "start_client") return { ok: true, text: "{}" };
      if (request.toolName === "list_stores") return { ok: true, text: JSON.stringify(stores) };
      if (request.toolName === "download_vc_summary") return { ok: true, text: JSON.stringify(download) };
      return { ok: true, text: JSON.stringify({ code: 1, data: {} }) };
    },
  };
}

function makeSheet(name, rows) {
  const rowObjects = rows.map((cells) => ({ cellCount: cells.length, getCell: (column) => ({ text: cells[column - 1] == null ? "" : String(cells[column - 1]), value: cells[column - 1] }) }));
  return { name, rowCount: rows.length, columnCount: Math.max(...rows.map((row) => row.length)), getRow: (number) => rowObjects[number - 1] };
}
function makeWorkbook(sheets) { return { worksheets: sheets.map((sheet) => makeSheet(sheet.name, sheet.rows)) }; }

// 源 lingxingLocalData.ts 的 VC 汇总列；两行不同日期、同一 ASIN。
const VC_ROWS = [
  ["日期", "账号", "Asin", "国家", "Product Title", "Brand", "Manufacturing or Sourcing", "Ordered Revenue", "Ordered Units", "Shipped Revenue", "Shipped COGS", "Shipped Units", "Customer Returns", "Session"],
  ["2026/01/02", "店铺A", "b0vc0001", "US", "商品一", "品牌A", "FBA", "120.5", "3", "100", "40", "2", "1", "55"],
  ["2026-01-03", "店铺A", "B0VC0001", "US", "商品一", "品牌A", "FBA", "80", "2", "70", "30", "2", "0", "40"],
];

// ── ① 默认关：结构化拒绝 + 0 次网络 ────────────────────────────────────────
test("默认关：同步命令与 automation 适配器均结构化 INTEGRATION_UNAVAILABLE，0 次网络", async () => {
  const mcp = makeMcpPort();
  let networkProbes = 0;
  const bundle = track(createPluginBundle({
    userDataDir: tempDir(), safeStorage: null, mcpTransport: mcp,
    probes: { binary: okProbe, python: okProbe, network: () => { networkProbes += 1; return { ok: true, status: "ok", detail: "" }; } },
  }));

  const lingxing = await bundle.execute("integration/lingxing/cache/sync/start", { days: 1 }, { sessionRef: "s1" });
  assert.equal(lingxing.ok, false);
  assert.equal(lingxing.error, "INTEGRATION_UNAVAILABLE");
  assert.match(lingxing.detail, /默认关闭/);

  const ziniao = await bundle.execute("integration/ziniao/jobs/start", { stores: [{ selector: "s1", name: "店铺一" }] }, { sessionRef: "s1" });
  assert.equal(ziniao.ok, false);
  assert.equal(ziniao.error, "INTEGRATION_UNAVAILABLE");

  await assert.rejects(() => bundle.automationAdapter.lingxingCacheSync({ days: 1 }), (error) => error.code === "INTEGRATION_UNAVAILABLE");
  await assert.rejects(() => bundle.automationAdapter.ziniaoDownload({ stores: [{ selector: "s1", name: "店铺一" }] }), (error) => error.code === "INTEGRATION_UNAVAILABLE");
  await assert.rejects(() => bundle.automationAdapter.ziniaoDataSync({ days: 7 }), (error) => error.code === "INTEGRATION_UNAVAILABLE");

  assert.equal(mcp.calls.length, 0, "默认关不得发起任何 tools/call");
  assert.equal(networkProbes, 0, "默认关不得触发网络探测");
});

// ── ② 依赖缺失：detail 写清缺什么 + 0 次网络 ──────────────────────────────
test("依赖缺失：python3 缺失 → enable 拒绝并给出安装提示；force 启用后调用仍不可用，0 次网络", async () => {
  const mcp = makeMcpPort();
  let networkProbes = 0;
  const bundle = track(createPluginBundle({
    userDataDir: tempDir(), safeStorage: null, mcpTransport: mcp,
    probes: {
      binary: (target) => (target === "python3" ? missingPython() : okProbe()),
      python: () => ({ ok: false, status: "missing", detail: "未安装" }),
      network: () => { networkProbes += 1; return { ok: true, status: "ok", detail: "" }; },
    },
  }));

  const enabled = await bundle.execute("integration/plugins/enable", { id: "ziniao" }, { sessionRef: "s1" });
  assert.equal(enabled.ok, false);
  assert.equal(enabled.error, "INTEGRATION_UNAVAILABLE");
  assert.match(enabled.detail, /python3/, "detail 必须写清缺 python3");
  assert.match(enabled.detail, /安装 Python 3/, "detail 必须给出安装提示");

  // force 进入"已启用但依赖缺失"状态（registry 允许显式降级启用）。
  const forced = await bundle.execute("integration/plugins/enable", { id: "ziniao", force: true }, { sessionRef: "s1" });
  assert.equal(forced.ok, true);
  assert.equal(forced.value.status, "unavailable");

  const started = await bundle.execute("integration/ziniao/jobs/start", { stores: [{ selector: "s1", name: "店铺一" }] }, { sessionRef: "s1" });
  assert.equal(started.ok, false);
  assert.equal(started.error, "INTEGRATION_UNAVAILABLE");
  assert.match(started.detail, /python3/);

  await assert.rejects(() => bundle.automationAdapter.ziniaoDataSync({ days: 7 }), (error) => error.code === "INTEGRATION_UNAVAILABLE");
  assert.equal(mcp.calls.length, 0, "依赖缺失不得发起任何 tools/call");
  assert.equal(networkProbes, 0, "依赖缺失不得触发网络探测");
});

// ── ③ 启用 + 依赖就绪：真实调用既有 MCP tools/call 通道 ────────────────────
test("启用 + 就绪：领星缓存同步经 mcpTransport 真调用，落库可查", async () => {
  const mcp = makeMcpPort();
  const bundle = track(createPluginBundle({
    userDataDir: tempDir(), safeStorage: null, mcpTransport: mcp,
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await bundle.execute("integration/plugins/enable", { id: "lingxing" }, { sessionRef: "s1" })).ok, true);

  const started = await bundle.execute("integration/lingxing/cache/sync/start", { days: 2 }, { sessionRef: "s1" });
  assert.equal(started.ok, true, JSON.stringify(started));
  await bundle.lingxing.whenIdle();
  const job = bundle.lingxing.getLingxingCacheJob(started.value.job.id);
  assert.equal(job.status, "complete");
  assert.equal(job.rows, 2, "两天各一条");
  assert.ok(mcp.calls.length >= 2, "每天至少一次 tools/call");
  assert.equal(mcp.calls[0].serverId, "lingxing");
  assert.equal(mcp.calls[0].toolName, "query_product_performance_asin_lists");
  assert.equal(bundle.lingxing.lingxingLocalRows().total, 2);
});

test("启用 + 就绪：automation 适配器经 mcpTransport 真调用（领星 / 紫鸟下载）", async () => {
  const mcp = makeMcpPort();
  const bundle = track(createPluginBundle({
    userDataDir: tempDir(), safeStorage: null, mcpTransport: mcp,
    sleeper: (ms) => new Promise((resolve) => setTimeout(resolve, 1)),
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await bundle.execute("integration/plugins/enable", { id: "lingxing" }, { sessionRef: "s1" })).ok, true);
  assert.equal((await bundle.execute("integration/plugins/enable", { id: "ziniao" }, { sessionRef: "s1" })).ok, true);

  // Y2：适配器等到终态才返回（源 automationBusinessActions.ts:20-61），并如实带出结果文案。
  const lingxingText = await bundle.automationAdapter.lingxingCacheSync({ days: 1 });
  assert.equal(lingxingText, "领星近 1 天数据已缓存，共 1 条");
  await bundle.lingxing.whenIdle();
  assert.ok(mcp.calls.some((call) => call.toolName === "query_product_performance_asin_lists"));

  const ziniaoText = await bundle.automationAdapter.ziniaoDownload({ from: "2026-01-01", to: "2026-01-02", stores: [{ selector: "s1", name: "店铺一" }] });
  assert.equal(ziniaoText, "紫鸟下载完成：新增 1 个按日文件，检查 1 个店铺");
  await bundle.ziniao.whenIdle();
  assert.ok(mcp.calls.some((call) => call.toolName === "download_vc_summary"));
  const done = bundle.ziniao.getZiniaoDownloadJob();
  assert.equal(done.status, "completed");
});

test("启用 + 就绪：mcpCallDirect 桥形状 { ok:true, text } 被归一为集成契约", async () => {
  const calls = [];
  const bundle = track(createPluginBundle({
    userDataDir: tempDir(), safeStorage: null,
    mcpCallDirect: async (server, tool, args) => { calls.push({ server, tool, args }); return { ok: true, text: JSON.stringify({ code: 1, data: { list: SAMPLE_SALES, total: 1 } }) }; },
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await bundle.execute("integration/plugins/enable", { id: "lingxing" }, { sessionRef: "s1" })).ok, true);

  const started = await bundle.execute("integration/lingxing/cache/sync/start", { days: 1 }, { sessionRef: "s1" });
  assert.equal(started.ok, true);
  await bundle.lingxing.whenIdle();
  assert.equal(bundle.lingxing.getLingxingCacheJob(started.value.job.id).status, "complete");
  assert.ok(calls.length >= 1);
  assert.equal(calls[0].server, "lingxing");
});

test("传输失败：{ ok:false } 归一为结构化错误，作业如实 failed，绝不冒充成功", async () => {
  const bundle = track(createPluginBundle({
    userDataDir: tempDir(), safeStorage: null,
    mcpCallDirect: async () => ({ ok: false, error: "MCP_TOOL_INVOCATION_NOT_ENABLED", detail: "MCP 工具调用开关未开启" }),
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await bundle.execute("integration/plugins/enable", { id: "lingxing" }, { sessionRef: "s1" })).ok, true);
  const started = await bundle.execute("integration/lingxing/cache/sync/start", { days: 1 }, { sessionRef: "s1" });
  assert.equal(started.ok, true);
  await bundle.lingxing.whenIdle();
  const job = bundle.lingxing.getLingxingCacheJob(started.value.job.id);
  assert.equal(job.status, "error");
  assert.match(job.error, /开关未开启/);
});

test("启用 + 就绪：transportFactory 按既有语义构造（收到 pluginId/server/tool/凭据）", async () => {
  const dir = tempDir();
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from("ENC:" + Buffer.from(String(value)).toString("base64")),
    decryptString: (blob) => Buffer.from(String(blob).slice(4), "base64").toString(),
  };
  const credentials = safeStorageCredentialBackend({ safeStorage: fakeSafeStorage, dir });
  const seen = [];
  const bundle = track(createPluginBundle({
    userDataDir: dir, credentials,
    transportFactory: ({ pluginId, server, tool, args, credential }) => {
      seen.push({ pluginId, server, tool, credential });
      return async () => JSON.stringify({ code: 1, data: { list: SAMPLE_SALES, total: 1 } });
    },
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await bundle.execute("integration/plugins/enable", { id: "lingxing" }, { sessionRef: "s1" })).ok, true);
  assert.equal((await bundle.execute("integration/lingxing/credential/save", { secret: "LINGXING-SECRET-7788" }, { sessionRef: "s1" })).ok, true);

  const started = await bundle.execute("integration/lingxing/cache/sync/start", { days: 1 }, { sessionRef: "s1" });
  assert.equal(started.ok, true);
  await bundle.lingxing.whenIdle();
  assert.equal(bundle.lingxing.getLingxingCacheJob(started.value.job.id).status, "complete");
  assert.ok(seen.length >= 1);
  assert.equal(seen[0].pluginId, "lingxing");
  assert.equal(seen[0].server, "lingxing");
  assert.match(String(seen[0].credential), /LINGXING-SECRET-7788/);
});

// ── ⑤ ziniao_data_sync 逐字对齐源 ─────────────────────────────────────────
test("ziniao_data_sync：逐字对齐源 automationBusinessActions.ts:122-135 的三种返回", async () => {
  const dir = tempDir();
  const vcRoot = path.join(dir, "ziniao-vc");
  fs.mkdirSync(vcRoot, { recursive: true });
  const now = Date.now();
  const recent = path.join(vcRoot, "VC汇总_店铺A_20260102-20260103.xlsx");
  const stale = path.join(vcRoot, "VC汇总_店铺B_20260102-20260103.xlsx");
  fs.writeFileSync(recent, "fake-bytes");
  fs.writeFileSync(stale, "fake-bytes");
  fs.utimesSync(recent, new Date(now), new Date(now));
  fs.utimesSync(stale, new Date(now - 10 * 86400000), new Date(now - 10 * 86400000));

  const bundle = track(createPluginBundle({
    userDataDir: dir, safeStorage: null, ziniaoOutDir: vcRoot,
    workbookReader: async () => makeWorkbook([{ name: "VC", rows: VC_ROWS }]),
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await bundle.execute("integration/plugins/enable", { id: "ziniao" }, { sessionRef: "s1" })).ok, true);

  // 两个文件同一份工作簿：第一个导入 2 行，第二个 2 行全部重复跳过。
  const first = await bundle.ziniaoDataSync({ days: 365 });
  assert.match(first, /^已检查 2 个紫鸟文件，新增 2 条数据，跳过 2 条已有记录$/);
  assert.equal(bundle.lingxing.queryLingxingLocalData({ source: "ziniao" }).total, 1, "同一 ASIN 聚合为 1 行");

  const second = await bundle.ziniaoDataSync({ days: 365 });
  assert.match(second, /^已检查 2 个紫鸟文件，数据均已存在，跳过 4 条重复记录$/);

  // 把最近文件改旧：days=1 窗口内没有文件。
  fs.utimesSync(recent, new Date(now - 10 * 86400000), new Date(now - 10 * 86400000));
  const none = await bundle.ziniaoDataSync({ days: 1 });
  assert.equal(none, "最近 1 天没有需要同步的紫鸟文件");

  // automation 适配器同一条真实方法。
  const viaAdapter = await bundle.automationAdapter.ziniaoDataSync({ days: 365 });
  assert.match(viaAdapter, /数据均已存在/);
});
