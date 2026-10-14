/**
 * B7d · 领星集成测试（全离线：假 workbook / 假 transport / 临时目录 / 假 safeStorage）。
 *
 * 覆盖任务书验收点：
 *   ① 映射导入（源 lingxingMappings.ts 语义；注入解析器，源中无样例文件 → 用源格式样例数据）；
 *   ② 本地数据缓存 + 同步作业状态机（running → complete，去重，写入与查询）；
 *   ③ 广告缓存同步作业（start / get / stop / stats / query / stores）；
 *   ④ 云 API 未注入 transport → 结构化 INTEGRATION_UNAVAILABLE，绝不假数据；
 *   ⑤ 凭据走 safeStorage（credential-store），磁盘无明文，投影只给掩码。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLingxingIntegration, CREDENTIAL_REF } = require("../electron/integration-lingxing.cjs");
const { safeStorageCredentialBackend } = require("../electron/credential-store.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-lingxing-")); tmpDirs.push(dir); return dir; }

/** 源 lingxingMappings.ts 读取的最小 workbook 形状（worksheets / getRow / getCell / cellCount / columnCount）。 */
function makeSheet(name, rows) {
  const rowObjects = rows.map((cells) => ({
    cellCount: cells.length,
    getCell: (column) => ({ text: cells[column - 1] == null ? "" : String(cells[column - 1]), value: cells[column - 1] }),
  }));
  return { name, rowCount: rows.length, columnCount: Math.max(...rows.map((row) => row.length)), getRow: (number) => rowObjects[number - 1] };
}
function makeWorkbook(sheets) { return { worksheets: sheets.map((sheet) => makeSheet(sheet.name, sheet.rows)) }; }

// 源格式样例：第 2 行才是 ASIN 表头（验证 HEADER_SCAN_ROWS 扫描）；负责人多值用「、」分隔。
const SAMPLE_ROWS = [
  ["领星映射导出", "", "", "", ""],
  ["ASIN", "站点", "负责人", "商品名称", "SKU"],
  ["b0test0001", "US", "张三、李四", "样例产品一", "SKU-1"],
  ["B0TEST0002", "UK", "王五", "样例产品二", "SKU-2"],
  ["", "DE", "赵六", "没有 ASIN 的行应跳过", "SKU-3"],
];

function fakeTransport(dateRows) {
  return async (server, tool) => {
    if (tool === "query_product_performance_asin_lists") return JSON.stringify({ code: 1, data: { list: dateRows, total: dateRows.length } });
    if (tool === "ad_auth_shops") return JSON.stringify({ code: 1, data: [{ profile_id: "p1", alias: "样例广告店", country: "US" }] });
    if (tool === "ad_campaign_report") return JSON.stringify({ code: 1, data: [{ campaign_name: "camp-1", spends: 12.5, ads_type: "SP" }], recordsFiltered: 1 });
    return JSON.stringify({ code: 1, data: {} });
  };
}
const SAMPLE_SALES = [{ asin: "B0TEST0001", item_name: "样例产品一", volume: 3, amount: 99.5, order_items: 2, sessions: 40, currency_code: "CNY", seller_name: "样例店铺", country: "US", brand: "样例品牌" }];

// ── ① 映射导入 ────────────────────────────────────────────────────────────
test("领星映射：注入解析器导入样例表格，站点聚合 / 负责人多值 / 落盘与重读一致", async () => {
  const dir = tempDir();
  const integration = createLingxingIntegration({ dataDir: dir, readWorkbook: async () => makeWorkbook([{ name: "映射", rows: SAMPLE_ROWS }]) });
  assert.equal(integration.getLingxingMapping(), null, "未导入时为 null");

  const dataset = await integration.importLingxingMapping({ originalname: "领星映射.xlsx", buffer: Buffer.from("fake-xlsx-bytes") });
  assert.equal(dataset.version, 1);
  assert.equal(dataset.fileName, "领星映射.xlsx");
  assert.equal(dataset.asinCount, 2, "空 ASIN 行必须跳过");
  assert.equal(dataset.rowCount, 2);
  assert.equal(dataset.sheets.length, 1);
  assert.equal(dataset.sheets[0].headerRow, 2, "表头在第 2 行");
  assert.equal(dataset.sheets[0].mappedRows, 2);

  const principal = dataset.fields.find((field) => field.label === "负责人");
  assert.ok(principal, "负责人字段应存在");
  assert.deepEqual(principal.uniqueValues, ["李四", "王五", "张三"], "负责人按「、」拆成多值并按 zh-CN 排序（空 ASIN 行的赵六被跳过）");
  assert.ok(dataset.siteFieldId, "站点字段应被识别");
  assert.equal(dataset.siteRecords.B0TEST0001.US[principal.id][0], "张三");
  assert.equal(dataset.siteRecordCount, 2, "两个 ASIN 各一个站点");

  const file = integration.getLingxingMappingFile();
  assert.equal(file.contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.ok(fs.existsSync(file.path), "源文件必须落盘");

  // "重启"：新实例从磁盘重读
  const reopened = createLingxingIntegration({ dataDir: dir, readWorkbook: async () => makeWorkbook([{ name: "映射", rows: SAMPLE_ROWS }]) });
  const again = reopened.getLingxingMapping();
  assert.equal(again.asinCount, 2);
  assert.equal(again.storedFileName, dataset.storedFileName);
});

test("领星映射：未注入解析器 / 未上传 / 不支持格式 → 结构化错误码", async () => {
  const dir = tempDir();
  const integration = createLingxingIntegration({ dataDir: dir });
  await assert.rejects(() => integration.importLingxingMapping({ originalname: "a.xlsx", buffer: Buffer.from("x") }), (error) => error.code === "INTEGRATION_UNAVAILABLE");
  await assert.rejects(() => integration.importLingxingMapping({ originalname: "a.txt", buffer: Buffer.from("x") }), (error) => error.code === "INTEGRATION_INVALID_INPUT");
  assert.throws(() => integration.getLingxingMappingFile(), (error) => error.code === "INTEGRATION_NOT_FOUND");
});

// ── ② 本地缓存 + 同步作业状态机 ─────────────────────────────────────────
test("领星缓存：同步作业状态机 running → complete，写入可查询，重复启动返回同一活动作业", async () => {
  const dir = tempDir();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const integration = createLingxingIntegration({
    dataDir: dir,
    transport: async (server, tool) => { if (tool === "query_product_performance_asin_lists") { await gate; return JSON.stringify({ code: 1, data: { list: SAMPLE_SALES, total: 1 } }); } return JSON.stringify({ code: 1, data: {} }); },
  });
  const first = integration.startLingxingCacheSync(2);
  assert.equal(first.status, "running");
  assert.equal(first.totalDays, 2);
  const second = integration.startLingxingCacheSync(2);
  assert.equal(second.id, first.id, "活动作业进行中时重复启动返回同一作业");

  release();
  await integration.whenIdle();
  const done = integration.getLingxingCacheJob(first.id);
  assert.equal(done.status, "complete");
  assert.equal(done.completedDays, 2);
  assert.equal(done.rows, 2, "两天各一条");

  const rows = integration.lingxingLocalRows();
  assert.equal(rows.total, 2);
  assert.equal(rows.rows[0].asin, "B0TEST0001");
  assert.equal(rows.rows[0].account, "样例店铺");
  assert.equal(rows.rows[0].source, "lingxing");

  const query = integration.queryLingxingLocalData({ search: "样例" });
  assert.equal(query.total, 1);
  assert.equal(query.rows[0].amount, 199, "两天合计");
  assert.equal(query.summary.lingxingRows, 2);

  const stats = integration.lingxingCacheStats();
  assert.equal(stats.cacheDays, 2, "同步成功后写回 cache_days");
  assert.equal(stats.rows, 2);
});

test("领星缓存：未注入 transport → 结构化 INTEGRATION_UNAVAILABLE；非法清理范围被拒", async () => {
  const dir = tempDir();
  const integration = createLingxingIntegration({ dataDir: dir });
  assert.throws(() => integration.startLingxingCacheSync(3), (error) => error.code === "INTEGRATION_UNAVAILABLE");
  assert.throws(() => integration.clearLingxingStoredData("nope"), (error) => error.code === "INTEGRATION_INVALID_INPUT");
  const cleared = integration.clearLingxingStoredData("all");
  assert.equal(cleared.rows, 0);
});

// ── ③ 广告同步作业 ──────────────────────────────────────────────────────
test("领星广告：同步作业落缓存，店铺列举与查询可用", async () => {
  const dir = tempDir();
  const integration = createLingxingIntegration({ dataDir: dir, transport: fakeTransport(SAMPLE_SALES) });
  const job = integration.startLingxingAdvertisingCacheSync(1, ["p1"]);
  assert.equal(job.status, "running");
  await integration.whenIdle();
  const done = integration.getLingxingAdvertisingCacheJob(job.id);
  assert.equal(done.status, "complete", JSON.stringify(done));
  assert.equal(done.completedUnits, 6, "6 个视图各完成一次");

  const stores = integration.listCachedLingxingAdvertisingStores();
  assert.equal(stores.length, 1);
  assert.equal(stores[0].name, "样例广告店");

  const query = integration.queryLingxingAdvertisingCache({ start: job.start, end: job.end, view: "campaign", profileId: "p1" });
  assert.equal(query.total, 1);
  assert.equal(query.rows[0].campaign_name, "camp-1");
  assert.equal(query.summary.spends, undefined, "汇总行由源逻辑过滤，仅返回明细");

  const stopped = integration.stopLingxingAdvertisingCacheJob("no-such-id");
  assert.equal(stopped, null);
});

// ── ⑤ 凭据 ───────────────────────────────────────────────────────────────
test("领星凭据：写入 safeStorage，磁盘无明文，投影只给掩码", () => {
  const dir = tempDir();
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from("ENC:" + Buffer.from(String(value)).toString("base64")),
    decryptString: (blob) => Buffer.from(String(blob).slice(4), "base64").toString(),
  };
  const credentials = safeStorageCredentialBackend({ safeStorage: fakeSafeStorage, dir });
  const integration = createLingxingIntegration({ dataDir: dir, credentials });
  const secret = "LINGXING-SECRET-abcdef123456";
  const saved = integration.saveCredential({ secret });
  assert.equal(saved.ref, CREDENTIAL_REF);
  assert.equal(saved.mask, "LING••••3456");

  const credentialFile = path.join(dir, "credentials", CREDENTIAL_REF + ".bin");
  assert.ok(fs.existsSync(credentialFile), "凭据文件必须存在");
  assert.equal(fs.readFileSync(credentialFile, "utf8").includes(secret), false, "磁盘上不得出现明文");

  const status = integration.credentialStatus();
  assert.equal(status.credentialSet, true);
  assert.equal(status.mask, "LING••••3456");
  assert.equal(JSON.stringify(status).includes(secret), false, "投影不得回传明文");
});

test("领星凭据：safeStorage 不可用 → 结构化拒绝，不落明文", () => {
  const dir = tempDir();
  const integration = createLingxingIntegration({ dataDir: dir, credentials: null });
  assert.throws(() => integration.saveCredential({ secret: "abcd1234" }), (error) => error.code === "INTEGRATION_UNAVAILABLE");
  assert.equal(integration.credentialStatus().credentialSet, false);
  assert.equal(fs.existsSync(path.join(dir, "credentials")), false, "不得创建任何明文凭据");
});

// ── ⑥ B7e3：业务分析 / 运营看板 / 汇率 / 导出 ─────────────────────────────
test("领星分析：同步后可查业务分析 / 运营看板 / 汇率，并导出（注入 writer）", async () => {
  const dir = tempDir();
  const integration = createLingxingIntegration({
    dataDir: dir,
    transport: fakeTransport(SAMPLE_SALES),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ rates: { USD: 0.14, EUR: 0.12, GBP: 0.104 } }) }),
    writeWorkbook: async (spec) => Buffer.from("XLSX:" + spec.sheets.map((sheet) => sheet.name + "/" + sheet.rows.length).join(",")),
  });
  const job = integration.startLingxingCacheSync(2);
  await integration.whenIdle();
  assert.equal(job.status, "complete");

  const analytics = integration.lingxingBusinessAnalytics({ start: job.start, end: job.end });
  assert.equal(analytics.current.amount, 199);
  assert.equal(analytics.current.asinCount, 1, "两天同一 ASIN 去重");
  assert.equal(analytics.daily.length, 2);
  assert.equal(analytics.products.length, 1);
  assert.equal(analytics.products[0].change, null, "上一周期无数据 → 变化率为 null（源 analyticsRatio）");
  assert.equal(analytics.comparisonAvailable, false);
  assert.equal(analytics.dimensions.account[0].name, "样例店铺");
  assert.equal(analytics.groups[0].name, "未映射 ASIN");
  assert.equal(analytics.groups[0].amount, 199);

  const dashboard = integration.queryLingxingOperatorDashboard({ start: job.start, end: job.end, includeDaily: true });
  assert.equal(dashboard.total, 1);
  assert.equal(dashboard.summary.amount, 199);
  assert.equal(dashboard.summary.sessions, 80, "两天 sessions 合计");
  assert.equal(dashboard.rows[0].asin, "B0TEST0001");
  assert.equal(dashboard.daily.length, 2, "每日明细仅覆盖当前页 ASIN");

  const rates = await integration.getLingxingCurrencyRates();
  assert.equal(rates.source, "live");
  assert.equal(rates.rates.USD, 0.14);

  const exported = await integration.exportLingxingOperatorDashboard({ start: job.start, end: job.end, currency: "USD" });
  assert.match(exported.fileName, /^运营看板_USD_/);
  assert.equal(exported.data.toString(), "XLSX:运营汇总/1,每日明细/2");
  const specSheet = { name: "运营汇总", rows: dashboard.rows };
  assert.equal(specSheet.rows[0].amount, 199);
});

test("领星导出：未注入 writer → INTEGRATION_UNAVAILABLE；未注入 fetch → 回退内置汇率", async () => {
  const dir = tempDir();
  const integration = createLingxingIntegration({ dataDir: dir });
  await assert.rejects(() => integration.exportLingxingOperatorDashboard({}), (error) => error.code === "INTEGRATION_UNAVAILABLE");
  const rates = await integration.getLingxingCurrencyRates();
  assert.equal(rates.source, "fallback");
  assert.equal(rates.rates.CNY, 1);
  assert.equal(rates.rates.USD, 0.14);
});

// ── ⑦ B7e3：紫鸟 VC 导入 / 行级读取 / 聚合查询 ────────────────────────────
test("紫鸟 VC：注入 readWorkbook 导入 VC汇总，写入 lingxing 本地库；legacy 查询忠实返回空表", async () => {
  const dir = tempDir();
  const vcRoot = path.join(dir, "ziniao-vc");
  fs.mkdirSync(vcRoot, { recursive: true });
  const vcFile = path.join(vcRoot, "VC汇总_店铺A_20260102-20260103.xlsx");
  fs.writeFileSync(vcFile, "fake-xlsx-bytes");

  const VC_ROWS = [
    ["日期", "账号", "Asin", "国家", "Product Title", "Brand", "Manufacturing or Sourcing", "Ordered Revenue", "Ordered Units", "Shipped Revenue", "Shipped COGS", "Shipped Units", "Customer Returns", "Session"],
    ["2026/01/02", "店铺A", "b0vc0001", "US", "商品一", "品牌A", "FBA", "120.5", "3", "100", "40", "2", "1", "55"],
    ["2026-01-03", "店铺A", "B0VC0001", "US", "商品一", "品牌A", "FBA", "80", "2", "70", "30", "2", "0", "40"],
    ["", "店铺A", "B0VC0009", "US", "无日期行应跳过", "", "", "1", "1", "1", "1", "1", "0", "1"],
  ];
  const integration = createLingxingIntegration({
    dataDir: dir,
    ziniaoOutputRoot: () => vcRoot,
    readWorkbook: async () => makeWorkbook([{ name: "VC", rows: VC_ROWS }]),
  });

  const imported = await integration.importZiniaoVcFile(vcFile);
  assert.equal(imported.rows, 2, "两条有效行（无日期行跳过）");
  assert.equal(imported.parsedRows, 2);
  assert.equal(imported.start, "2026-01-02");
  assert.equal(imported.end, "2026-01-03");
  assert.equal(imported.accountCount, 1);
  assert.equal(imported.asinCount, 1, "大小写归一后同一 ASIN");
  assert.equal(imported.file.store, "店铺A");
  assert.equal(imported.file.dateRange, "20260102-20260103");

  const query = integration.queryLingxingLocalData({ source: "ziniao" });
  assert.equal(query.total, 1);
  assert.equal(query.rows[0].amount, 200.5, "两天 Ordered Revenue 合计");
  assert.equal(query.rows[0].sku, "");

  // 重复导入：同一 (日期, 账号) 已存在 → 全部跳过（源 importNewZiniaoVcRows 的 scope 去重）
  const again = await integration.importZiniaoVcFile(vcFile);
  assert.equal(again.rows, 0);
  assert.equal(again.skippedRows, 2);

  // 源启动时已清空 ziniao_vc_daily；legacy 两个查询函数返回空表是源行为本身。
  assert.equal(integration.ziniaoVcRows().total, 0);
  assert.equal(integration.queryZiniaoVcData().total, 0);
});

test("紫鸟 VC：目录外文件 / 非 VC汇总 前缀 / 未注入 readWorkbook → 结构化错误", async () => {
  const dir = tempDir();
  const vcRoot = path.join(dir, "vc");
  fs.mkdirSync(vcRoot, { recursive: true });
  const good = path.join(vcRoot, "VC汇总_店铺A_20260102-20260103.xlsx");
  fs.writeFileSync(good, "x");
  const bad = path.join(dir, "other.xlsx");
  fs.writeFileSync(bad, "x");
  const noReader = createLingxingIntegration({ dataDir: dir, ziniaoOutputRoot: () => vcRoot });
  await assert.rejects(() => noReader.importZiniaoVcFile(good), (error) => error.code === "INTEGRATION_UNAVAILABLE");
  const withReader = createLingxingIntegration({ dataDir: dir, ziniaoOutputRoot: () => vcRoot, readWorkbook: async () => makeWorkbook([]) });
  await assert.rejects(() => withReader.importZiniaoVcFile(bad), (error) => error.code === "INTEGRATION_INVALID_INPUT");
  fs.writeFileSync(path.join(vcRoot, "not-vc.xlsx"), "x");
  await assert.rejects(() => withReader.importZiniaoVcFile(path.join(vcRoot, "not-vc.xlsx")), (error) => error.code === "INTEGRATION_INVALID_INPUT");
});

