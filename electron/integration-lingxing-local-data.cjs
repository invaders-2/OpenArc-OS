/**
 * B7d/B7e3 · 领星本地数据缓存 + 同步作业 + 业务分析 / 运营看板 / 汇率 / 紫鸟 VC（逐函数移植 server/lingxingLocalData.ts:1-1248）。
 *
 * 逐函数对应（源行号）：
 *   lingxingLocalData.ts:9-121    建库 + 全部 DDL（逐字；better-sqlite3 → node:sqlite DatabaseSync）
 *   lingxingLocalData.ts:123-149  ensureSalesColumn 迁移 + ziniao 一次性并入 + source 索引
 *   lingxingLocalData.ts:151-176  uniqueText / normalizeGroupedText / skuValues / salesDimensions
 *   lingxingLocalData.ts:178-193  backfillSalesDimensions
 *   lingxingLocalData.ts:195-230  LingxingCacheJob / LingxingAdCacheJob / jobs / adJobs
 *   lingxingLocalData.ts:232-282  isoDate / cacheRange / dateKeys / num / metricNum
 *   lingxingLocalData.ts:438-483  parseSalesResponse / fetchDate（云查询经**注入 transport**）
 *   lingxingLocalData.ts:485-517  replaceDate / databaseBytes / ziniaoVcStats
 *   lingxingLocalData.ts:519-570  lingxingCacheStats / getLingxingCacheJob / startLingxingCacheSync
 *   lingxingLocalData.ts:572-784  广告：advertisingTools / decode / args / stores / snapshot / 缓存作业 / 查询
 *   lingxingLocalData.ts:786-812  clearLingxingStoredData
 *   lingxingLocalData.ts:814-857  queryLingxingAdvertisingCache
 *   lingxingLocalData.ts:859-944  lingxingLocalRows / queryLingxingLocalData
 *
 * 与源文件的差异（任务书硬约束）：
 *   · 源用 better-sqlite3（含 db.transaction()）；本仓不新增依赖，改用内置 node:sqlite 的
 *     DatabaseSync，事务以 BEGIN/COMMIT/ROLLBACK 实现 writeTransaction()；
 *   · 源云调用直接 callDirect('lingxing', ...)；本移植改为**注入 transport(serverId, tool, args)**，
 *     未注入即结构化不可用（INTEGRATION_UNAVAILABLE），绝不返回假数据；
 *   · 查询/字段名与源逐字一致；失败以带 code 的 Error 抛出，由 plugin-service 转结构化。
 *
 * B7e3 补齐（原"未移植项"清单已全部落地，本文件**不再有未移植项**）：
 *   lingxingLocalData.ts:14-30      getLingxingCurrencyRates（注入 fetch；未注入即回退内置汇率，与源 catch 分支一致）
 *   lingxingLocalData.ts:946-1044   lingxingBusinessAnalytics（区间对比 / 日趋势 / 商品 / 维度 / 分组）
 *   lingxingLocalData.ts:1078-1158  queryLingxingOperatorDashboard（ASIN 汇总 + 广告指标 + 可选每日明细）
 *   lingxingLocalData.ts:1160-1186  exportLingxingOperatorDashboard（注入 writeWorkbook；未注入即结构化不可用）
 *   lingxingLocalData.ts:267-436    importZiniaoVcFile（工作簿解析走注入 readWorkbook）
 *   lingxingLocalData.ts:1188-1247  queryZiniaoVcData / ziniaoVcRows
 *
 * 忠实移植说明：queryZiniaoVcData / ziniaoVcRows 读 ziniao_vc_daily；源在启动时已把该表并入
 * lingxing_daily_sales 后清空（本文件开头的 INSERT ... SELECT + DELETE），所以它们对空表返回空是源行为；
 * 线上路径请用 queryLingxingLocalData({ source: "ziniao" })。
 *
 * 另：agnes.ts / agnesEndpoint.ts 已由 B7e3 落地为 electron/plugin-agnes.cjs；
 * developerOAuth.ts（开发者 OAuth / PKCE）不属本文件，已在 developer-domain.cjs 文件头的"未移植项"里登记。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createHash } = crypto;

const { INTEGRATION_ERR_UNAVAILABLE, INTEGRATION_ERR_INVALID_INPUT, INTEGRATION_ERR_INTERNAL } = require("./plugin-registry.cjs");

const DB_FILE_NAME = "lingxing-local.db";
const ADVERTISING_SYNC_STOPPED = "LINGXING_ADVERTISING_SYNC_STOPPED";

const SCHEMA_SQL = "CREATE TABLE IF NOT EXISTS lingxing_daily_sales (\n  business_date TEXT NOT NULL,\n  record_key TEXT NOT NULL,\n  asin TEXT, sku TEXT, item_name TEXT, volume REAL, amount REAL, orders REAL, sessions REAL, currency TEXT,\n  source_type TEXT NOT NULL DEFAULT 'lingxing',\n  account TEXT, country TEXT, brand TEXT, source_view TEXT,\n  shipped_revenue REAL, shipped_cogs REAL, shipped_units REAL, customer_returns REAL, source_file TEXT,\n  data TEXT NOT NULL, synced_at INTEGER NOT NULL,\n  PRIMARY KEY (business_date, record_key)\n);\nCREATE INDEX IF NOT EXISTS idx_lingxing_daily_sales_date ON lingxing_daily_sales (business_date);\nCREATE TABLE IF NOT EXISTS ziniao_vc_daily (\n  business_date TEXT NOT NULL, account TEXT NOT NULL, country TEXT NOT NULL, asin TEXT NOT NULL,\n  product_title TEXT, brand TEXT, source_view TEXT NOT NULL,\n  ordered_revenue REAL, ordered_units REAL, shipped_revenue REAL, shipped_cogs REAL, shipped_units REAL,\n  customer_returns REAL, sessions REAL, source_file TEXT NOT NULL, imported_at INTEGER NOT NULL, raw_data TEXT NOT NULL,\n  PRIMARY KEY (business_date, account, asin, country, source_view)\n);\nCREATE INDEX IF NOT EXISTS idx_ziniao_vc_daily_date ON ziniao_vc_daily (business_date);\nCREATE INDEX IF NOT EXISTS idx_ziniao_vc_daily_asin ON ziniao_vc_daily (asin);\nCREATE TABLE IF NOT EXISTS lingxing_cache_config (id INTEGER PRIMARY KEY CHECK (id = 1), cache_days INTEGER NOT NULL, updated_at INTEGER NOT NULL);\nINSERT OR IGNORE INTO lingxing_cache_config (id, cache_days, updated_at) VALUES (1, 7, 0);\nCREATE TABLE IF NOT EXISTS lingxing_sync_runs (\n  id TEXT PRIMARY KEY, start_date TEXT NOT NULL, end_date TEXT NOT NULL, cache_days INTEGER NOT NULL,\n  rows INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, error TEXT\n);\nCREATE TABLE IF NOT EXISTS lingxing_ad_reports (\n  range_start TEXT NOT NULL, range_end TEXT NOT NULL, view_type TEXT NOT NULL, profile_id TEXT NOT NULL, record_key TEXT NOT NULL,\n  is_summary INTEGER NOT NULL DEFAULT 0, store_name TEXT, country TEXT, data TEXT NOT NULL, synced_at INTEGER NOT NULL,\n  PRIMARY KEY (range_start, range_end, view_type, profile_id, record_key)\n);\nCREATE INDEX IF NOT EXISTS idx_lingxing_ad_reports_query ON lingxing_ad_reports (view_type, profile_id, range_start, range_end, is_summary);\nCREATE TABLE IF NOT EXISTS lingxing_ad_cache_config (\n  id INTEGER PRIMARY KEY CHECK (id = 1), cache_days INTEGER NOT NULL, range_start TEXT, range_end TEXT, rows INTEGER NOT NULL DEFAULT 0, synced_at INTEGER\n);\nINSERT OR IGNORE INTO lingxing_ad_cache_config (id, cache_days, rows) VALUES (1, 7, 0);";

function fail(code, detail) { const error = new Error(detail); error.code = code; return error; }

/** better-sqlite3 db.transaction(fn) 的 node:sqlite 等价物（BEGIN/COMMIT/ROLLBACK）。 */
function writeTransaction(db, fn) {
  return function transaction(...args) {
    db.exec("BEGIN");
    try {
      const result = fn(...args);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* 忽略回滚失败 */ }
      throw error;
    }
  };
}

function openDatabase(dbPath) {
  let sqlite;
  try { sqlite = require("node:sqlite"); } catch { throw fail(INTEGRATION_ERR_UNAVAILABLE, "node:sqlite 不可用：需要 Node >= 22.5（Electron 主进程同版本）。"); }
  if (!sqlite || !sqlite.DatabaseSync) throw fail(INTEGRATION_ERR_UNAVAILABLE, "node:sqlite 缺少 DatabaseSync。");
  return new sqlite.DatabaseSync(dbPath);
}

function createLingxingLocalData(options = {}) {
  const dataDir = options.dataDir ? String(options.dataDir) : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const transport = typeof options.transport === "function" ? options.transport : null;
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : null;
  const readWorkbook = typeof options.readWorkbook === "function" ? options.readWorkbook : null;
  const writeWorkbook = typeof options.writeWorkbook === "function" ? options.writeWorkbook : null;
  const ziniaoOutputRoot = typeof options.ziniaoOutputRoot === "function" ? options.ziniaoOutputRoot : null;
  const dbPath = dataDir ? path.join(dataDir, DB_FILE_NAME) : ":memory:";
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA_SQL);

  // lingxingLocalData.ts:123-137 逐字
  function ensureSalesColumn(name, definition) {
    const columns = db.prepare("PRAGMA table_info(lingxing_daily_sales)").all();
    if (!columns.some((column) => column.name === name)) db.exec("ALTER TABLE lingxing_daily_sales ADD COLUMN " + name + " " + definition);
  }
  ensureSalesColumn("source_type", "TEXT NOT NULL DEFAULT 'lingxing'");
  ensureSalesColumn("account", "TEXT");
  ensureSalesColumn("country", "TEXT");
  ensureSalesColumn("brand", "TEXT");
  ensureSalesColumn("source_view", "TEXT");
  ensureSalesColumn("shipped_revenue", "REAL");
  ensureSalesColumn("shipped_cogs", "REAL");
  ensureSalesColumn("shipped_units", "REAL");
  ensureSalesColumn("customer_returns", "REAL");
  ensureSalesColumn("source_file", "TEXT");

  // lingxingLocalData.ts:139-149 逐字（ziniao_vc_daily 为空时是 no-op）
  db.exec("INSERT OR IGNORE INTO lingxing_daily_sales " +
    "(business_date,record_key,asin,sku,item_name,volume,amount,orders,sessions,currency,source_type,account,country,brand,source_view,shipped_revenue,shipped_cogs,shipped_units,customer_returns,source_file,data,synced_at) " +
    "SELECT business_date, 'ziniao:' || account || ':' || asin || ':' || country || ':' || source_view, asin,'',product_title,ordered_units,ordered_revenue,0,sessions,'','ziniao',account,country,brand,source_view, " +
    "shipped_revenue,shipped_cogs,shipped_units,customer_returns,source_file,raw_data,imported_at FROM ziniao_vc_daily");
  db.exec("DELETE FROM ziniao_vc_daily");
  db.exec("CREATE INDEX IF NOT EXISTS idx_lingxing_daily_sales_source ON lingxing_daily_sales (source_type, business_date)");

  // ── lingxingLocalData.ts:151-176 逐字 ──
  function uniqueText(values) {
    return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value == null ? "" : value).trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })).join("、");
  }
  function normalizeGroupedText(value) {
    return uniqueText(String(value || "").split(/[,，、;；]+/));
  }
  function skuValues(row) {
    const direct = [row.local_sku, row.sku, row.msku].flatMap((value) => Array.isArray(value) ? value : [value]);
    const encoded = String(row.msku_sid_str || "").split("!$").map((entry) => entry.split("$|$")[0]);
    return uniqueText([...direct, ...encoded]);
  }
  function salesDimensions(row) {
    const stores = Array.isArray(row.seller_store_countries)
      ? row.seller_store_countries.filter((value) => !!value && typeof value === "object") : [];
    return {
      sku: skuValues(row),
      account: uniqueText([row.seller_name, row.store_name, ...stores.map((store) => store.seller_name)]),
      country: uniqueText([row.country, row.country_name, ...stores.map((store) => store.country)]),
      brand: uniqueText([row.brand, row.brands]),
    };
  }

  // lingxingLocalData.ts:178-193
  const backfillSalesDimensions = writeTransaction(db, () => {
    const rows = db.prepare("SELECT business_date,record_key,data FROM lingxing_daily_sales WHERE source_type='lingxing' AND (COALESCE(sku,'')='' OR COALESCE(account,'')='' OR COALESCE(country,'')='' OR COALESCE(brand,'')='')").all();
    const update = db.prepare("UPDATE lingxing_daily_sales SET " +
      "sku=CASE WHEN COALESCE(sku,'')='' THEN ? ELSE sku END, " +
      "account=CASE WHEN COALESCE(account,'')='' THEN ? ELSE account END, " +
      "country=CASE WHEN COALESCE(country,'')='' THEN ? ELSE country END, " +
      "brand=CASE WHEN COALESCE(brand,'')='' THEN ? ELSE brand END " +
      "WHERE business_date=? AND record_key=?");
    for (const item of rows) {
      try {
        const dimensions = salesDimensions(JSON.parse(item.data));
        update.run(dimensions.sku, dimensions.account, dimensions.country, dimensions.brand, item.business_date, item.record_key);
      } catch { /* 损坏的旧行仍可通过原始 data 查看 */ }
    }
  });
  backfillSalesDimensions();

  // ── lingxingLocalData.ts:195-230 作业内存态 ──
  const jobs = new Map();
  let activeJobId = "";
  const adJobs = new Map();
  let activeAdJobId = "";

  // lingxingLocalData.ts:232-282 逐字
  function isoDate(date) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  }
  function cacheRange(days) {
    const end = new Date();
    end.setHours(12, 0, 0, 0);
    end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - days + 1);
    return { start: isoDate(start), end: isoDate(end) };
  }
  function dateKeys(start, end) {
    const result = [];
    const cursor = new Date(start + "T12:00:00");
    const last = new Date(end + "T12:00:00");
    while (cursor <= last) {
      result.push(isoDate(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return result;
  }
  function num(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function metricNum(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const parsed = Number(String(value == null ? "" : value).replace(/[^\d.+-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function requireTransport() {
    if (typeof transport !== "function") throw fail(INTEGRATION_ERR_UNAVAILABLE, "未注入领星云 API 传输（transport/callDirect）；注入后可用，绝不返回假数据");
  }

  // ── lingxingLocalData.ts:438-483 逐字（callDirect → 注入 transport） ──
  function parseSalesResponse(text) {
    const parsed = JSON.parse(text);
    if (parsed.success === false || (typeof parsed.code === "number" && parsed.code !== 1)) {
      throw new Error(String(parsed.msg || parsed.message || "领星业务查询失败"));
    }
    const outer = parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
    if (outer.success === false || (typeof outer.code === "number" && outer.code !== 1)) {
      throw new Error(String(outer.msg || outer.message || "领星业务查询失败"));
    }
    const payload = outer.data && typeof outer.data === "object" ? outer.data : outer;
    const list = Array.isArray(payload.list) ? payload.list.filter((row) => !!row && typeof row === "object") : null;
    const total = Math.max(0, num(payload.total != null ? payload.total : parsed.total));
    return { list, total };
  }
  async function fetchDate(date) {
    requireTransport();
    const rows = [];
    const pageSize = 200;
    for (let offset = 0, page = 0; page < 1000; page += 1, offset += pageSize) {
      const args = {
        offset, length: pageSize, start_date: date, end_date: date,
        summary_field: "asin", summary_field_level1: "asin", turn_on_summary: 1, currency_code: "CNY",
        sort_field: "amount", sort_type: "desc", date_type: "purchase", date_range_type: 0, date_view_order_type: 0,
      };
      let result = { list: null, total: 0 };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // 第一个参数是**集成声明的服务名**（源 lingxingLocalData.ts 的 callDirect('lingxing', ...) 形状），
        // 不是 MCP 域内的 connectionId；由 electron/mcp-live-transport.cjs 的 resolveLiveConnection
        // 按真实语义解析到当前启用的活连接，解析不到会结构化拒绝（不静默、不伪造）。
        result = parseSalesResponse(await transport("lingxing", "query_product_performance_asin_lists", args));
        if (result.list || result.total === 0) break;
      }
      if (!result.list && result.total > 0) throw new Error(date + " 返回 " + result.total + " 条记录，但明细尚未就绪");
      const list = result.list || [];
      rows.push(...list);
      if (!list.length || rows.length >= result.total || list.length < pageSize) break;
    }
    return rows;
  }

  // lingxingLocalData.ts:485-500 逐字
  const replaceDate = writeTransaction(db, (date, rows, syncedAt) => {
    db.prepare("DELETE FROM lingxing_daily_sales WHERE source_type='lingxing' AND business_date=?").run(date);
    const insert = db.prepare("INSERT OR REPLACE INTO lingxing_daily_sales " +
      "(business_date,record_key,asin,sku,item_name,volume,amount,orders,sessions,currency,source_type,account,country,brand,data,synced_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    rows.forEach((row, index) => {
      const asin = String(row.asin || "").trim();
      const dimensions = salesDimensions(row);
      const fallback = createHash("sha1").update(JSON.stringify(row)).digest("hex").slice(0, 20);
      const key = asin || dimensions.sku || (fallback + "-" + index);
      insert.run(date, key, asin, dimensions.sku, String(row.item_name || row.local_name || ""), num(row.volume), num(row.amount != null ? row.amount : row.sales_amount), num(row.order_items != null ? row.order_items : row.order_num), num(row.sessions), String(row.currency_code || "CNY"),
        "lingxing", dimensions.account, dimensions.country, dimensions.brand, JSON.stringify(row), syncedAt);
    });
  });

  // lingxingLocalData.ts:502-517
  function databaseBytes() {
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { total += fs.statSync(dbPath + suffix).size; } catch { /* 可选 SQLite 旁文件 */ }
    }
    return total;
  }
  function ziniaoVcStats() {
    const summary = db.prepare("SELECT MIN(business_date) AS start, MAX(business_date) AS end, COUNT(*) AS rows, " +
      "COUNT(DISTINCT business_date) AS dayCount, COUNT(DISTINCT account) AS accountCount, " +
      "COUNT(DISTINCT asin) AS asinCount, MAX(synced_at) AS lastImportedAt FROM lingxing_daily_sales WHERE source_type='ziniao'").get();
    const days = db.prepare("SELECT business_date AS date, COUNT(*) AS rows, SUM(LENGTH(data)) AS approxBytes, " +
      "MAX(synced_at) AS syncedAt FROM lingxing_daily_sales WHERE source_type='ziniao' GROUP BY business_date ORDER BY business_date DESC").all();
    return Object.assign({}, summary, { days });
  }

  // lingxingLocalData.ts:519-570 逐函数移植
  function lingxingCacheStats() {
    const config = db.prepare("SELECT cache_days AS cacheDays, updated_at AS updatedAt FROM lingxing_cache_config WHERE id=1").get();
    const summary = db.prepare("SELECT MIN(business_date) AS start, MAX(business_date) AS end, COUNT(*) AS rows, " +
      "COUNT(DISTINCT business_date) AS dayCount, MAX(synced_at) AS lastSyncedAt, " +
      "SUM(CASE WHEN source_type='lingxing' THEN 1 ELSE 0 END) AS lingxingRows, " +
      "SUM(CASE WHEN source_type='ziniao' THEN 1 ELSE 0 END) AS ziniaoRows FROM lingxing_daily_sales").get();
    const days = db.prepare("SELECT business_date AS date, COUNT(*) AS rows, SUM(LENGTH(data)) AS approxBytes, " +
      "MAX(synced_at) AS syncedAt FROM lingxing_daily_sales GROUP BY business_date ORDER BY business_date DESC").all();
    return Object.assign({}, summary, {
      cacheDays: config ? config.cacheDays : 0,
      configUpdatedAt: config ? config.updatedAt : 0,
      bytes: databaseBytes(), days, ziniao: ziniaoVcStats(),
      advertising: lingxingAdvertisingCacheStats(),
      activeJob: activeJobId ? jobs.get(activeJobId) || null : null,
    });
  }
  function getLingxingCacheJob(id) { return jobs.get(id) || null; }

  function startLingxingCacheSync(rawDays) {
    requireTransport();
    const days = Math.min(180, Math.max(1, Math.floor(Number(rawDays) || 7)));
    if (activeJobId) {
      const active = jobs.get(activeJobId);
      if (active && active.status === "running") return active;
    }
    const range = cacheRange(days);
    const job = Object.assign({ id: crypto.randomUUID(), status: "running" }, range, {
      cacheDays: days, currentDate: "", completedDays: 0, totalDays: days, rows: 0, startedAt: clock(),
    });
    jobs.set(job.id, job);
    activeJobId = job.id;
    db.prepare("INSERT INTO lingxing_sync_runs (id,start_date,end_date,cache_days,rows,started_at,status) VALUES (?,?,?,?,?,?,?)")
      .run(job.id, job.start, job.end, days, 0, job.startedAt, "running");
    void (async () => {
      try {
        for (const date of dateKeys(job.start, job.end)) {
          job.currentDate = date;
          const rows = await fetchDate(date);
          replaceDate(date, rows, clock());
          job.rows += rows.length;
          job.completedDays += 1;
        }
        db.prepare("DELETE FROM lingxing_daily_sales WHERE source_type='lingxing' AND (business_date < ? OR business_date > ?)").run(job.start, job.end);
        db.prepare("UPDATE lingxing_cache_config SET cache_days=?,updated_at=? WHERE id=1").run(days, clock());
        job.status = "complete";
        job.finishedAt = clock();
        db.prepare("UPDATE lingxing_sync_runs SET rows=?,finished_at=?,status=? WHERE id=?").run(job.rows, job.finishedAt, job.status, job.id);
      } catch (cause) {
        job.status = "error";
        job.error = String((cause && cause.message) || cause);
        job.finishedAt = clock();
        db.prepare("UPDATE lingxing_sync_runs SET rows=?,finished_at=?,status=?,error=? WHERE id=?").run(job.rows, job.finishedAt, job.status, job.error, job.id);
      } finally {
        if (activeJobId === job.id) activeJobId = "";
      }
    })();
    return job;
  }

  // ── lingxingLocalData.ts:572-784 广告缓存（逐函数移植） ──
  const advertisingTools = [
    { view: "campaign", tool: "ad_campaign_report" },
    { view: "group", tool: "ad_campaign_group_report" },
    { view: "product", tool: "ad_campaign_product_report" },
    { view: "keyword", tool: "ad_campaign_keyword_report" },
    { view: "searchTerm", tool: "ad_campaign_search_term_report" },
    { view: "targeting", tool: "ad_campaign_targeting_report" },
  ];
  function decodeAdvertisingRows(text) {
    let current = JSON.parse(text);
    for (let depth = 0; depth < 8; depth += 1) {
      if (Array.isArray(current)) return { rows: current.filter((row) => !!row && typeof row === "object"), meta: {} };
      if (!current || typeof current !== "object") break;
      const object = current;
      if (object.success === false || (object.code !== undefined && Number(object.code) !== 1)) throw new Error(String(object.msg || object.message || "领星广告查询失败"));
      if (Array.isArray(object.data)) return { rows: object.data.filter((row) => !!row && typeof row === "object"), meta: object };
      current = object.data;
    }
    return { rows: [], meta: {} };
  }
  function advertisingValue(row, keys) {
    for (const key of keys) {
      const value = row[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return "";
  }
  function advertisingSummaryRow(row) {
    return !advertisingValue(row, ["name", "campaign_name", "ad_group_name", "keyword_text", "query", "asin", "sku", "targeting_text", "campaign_id", "ad_group_id"]);
  }
  function advertisingArgs(view, profileId, start, end, page, length) {
    const args = { report_date: start + " - " + end, profile_ids: [profileId], page, length, sort_field: "spends", sort_type: "desc" };
    if (view === "group" || view === "keyword") args.with_ring = 0;
    if (view === "product") { args.profile_id = Number(profileId); args.with_ring = false; }
    if (view === "searchTerm") args.with_ring = false;
    if (view === "targeting") { args.with_ring = 0; args.length = String(length); }
    return args;
  }
  async function advertisingStores() {
    requireTransport();
    const decoded = decodeAdvertisingRows(await transport("lingxing", "ad_auth_shops", {}));
    const stores = decoded.rows.map((row) => ({
      profileId: String(advertisingValue(row, ["profile_id", "sid"])).trim(),
      name: String(advertisingValue(row, ["alias", "store_name"])).trim(),
      country: String(advertisingValue(row, ["country", "store_country"])).trim(),
    })).filter((store) => store.profileId);
    return [...new Map(stores.map((store) => [store.profileId, store])).values()];
  }
  async function fetchAdvertisingSnapshot(tool, view, profileId, start, end, shouldStop) {
    const detail = [];
    let summary = {};
    const pageSize = 100;
    for (let page = 1; page <= 100; page += 1) {
      if (shouldStop()) throw new Error(ADVERTISING_SYNC_STOPPED);
      const decoded = decodeAdvertisingRows(await transport("lingxing", tool, advertisingArgs(view, profileId, start, end, page, pageSize)));
      if (shouldStop()) throw new Error(ADVERTISING_SYNC_STOPPED);
      const pageSummary = page === 1 ? decoded.rows.find(advertisingSummaryRow) || {} : {};
      if (page === 1) summary = pageSummary;
      const rows = decoded.rows.filter((row) => row !== pageSummary);
      detail.push(...rows);
      const total = Number(advertisingValue(decoded.meta, ["recordsFiltered", "recordsTotal", "total"])) || 0;
      if (!rows.length || rows.length < pageSize || (total > 0 && detail.length >= total)) break;
    }
    return { rows: detail, summary };
  }
  const replaceAdvertisingSnapshot = writeTransaction(db, (input) => {
    db.prepare("DELETE FROM lingxing_ad_reports WHERE range_start=? AND range_end=? AND view_type=? AND profile_id=?")
      .run(input.start, input.end, input.view, input.profileId);
    const insert = db.prepare("INSERT INTO lingxing_ad_reports " +
      "(range_start,range_end,view_type,profile_id,record_key,is_summary,store_name,country,data,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
    const write = (row, index, isSummary) => {
      const data = JSON.stringify(row);
      const key = isSummary ? "__summary__" : createHash("sha1").update(data).digest("hex").slice(0, 24) + "-" + index;
      insert.run(input.start, input.end, input.view, input.profileId, key, isSummary, input.storeName, input.country, data, input.syncedAt);
    };
    write(input.summary, 0, 1);
    input.rows.forEach((row, index) => write(row, index, 0));
  });

  function startLingxingAdvertisingCacheSync(rawDays, rawProfileIds) {
    requireTransport();
    const days = Math.min(90, Math.max(1, Math.floor(Number(rawDays) || 7)));
    if (activeAdJobId) {
      const active = adJobs.get(activeAdJobId);
      if (active) return active;
    }
    const range = cacheRange(days);
    const job = Object.assign({ id: crypto.randomUUID(), status: "running" }, range, {
      cacheDays: days, currentStore: "", currentView: "", completedUnits: 0, totalUnits: 0, rows: 0, startedAt: clock(),
    });
    adJobs.set(job.id, job);
    activeAdJobId = job.id;
    void (async () => {
      const stopped = () => job.status === "stopped";
      try {
        const allowed = new Set((Array.isArray(rawProfileIds) ? rawProfileIds : []).map((value) => String(value || "").trim()).filter(Boolean));
        const allStores = await advertisingStores();
        const stores = allowed.size ? allStores.filter((store) => allowed.has(store.profileId)) : allStores;
        if (!stores.length) throw new Error("当前账号没有可用的广告授权店铺");
        job.totalUnits = stores.length * advertisingTools.length;
        for (const store of stores) {
          if (stopped()) throw new Error(ADVERTISING_SYNC_STOPPED);
          job.currentStore = store.name || store.profileId;
          for (const definition of advertisingTools) {
            if (stopped()) throw new Error(ADVERTISING_SYNC_STOPPED);
            job.currentView = definition.view;
            const snapshot = await fetchAdvertisingSnapshot(definition.tool, definition.view, store.profileId, job.start, job.end, stopped);
            replaceAdvertisingSnapshot(Object.assign({
              start: job.start, end: job.end, view: definition.view, profileId: store.profileId,
              storeName: store.name, country: store.country,
            }, snapshot, { syncedAt: clock() }));
            job.rows += snapshot.rows.length;
            job.completedUnits += 1;
          }
        }
        db.prepare("UPDATE lingxing_ad_cache_config SET cache_days=?,range_start=?,range_end=?,rows=?,synced_at=? WHERE id=1")
          .run(days, job.start, job.end, job.rows, clock());
        job.status = "complete";
        job.finishedAt = clock();
      } catch (cause) {
        if (job.status === "stopped" || String((cause && cause.message) || cause) === ADVERTISING_SYNC_STOPPED) {
          job.status = "stopped";
          job.finishedAt || (job.finishedAt = clock());
          return;
        }
        job.status = "error";
        job.error = String((cause && cause.message) || cause);
        job.finishedAt = clock();
      } finally {
        if (activeAdJobId === job.id) activeAdJobId = "";
      }
    })();
    return job;
  }
  function getLingxingAdvertisingCacheJob(id) { return adJobs.get(id) || null; }
  function stopLingxingAdvertisingCacheJob(id) {
    const job = adJobs.get(id);
    if (!job) return null;
    if (job.status === "running") { job.status = "stopped"; job.finishedAt = clock(); }
    return job;
  }
  function listCachedLingxingAdvertisingStores() {
    return db.prepare("SELECT profile_id AS profileId, COALESCE(MAX(NULLIF(store_name,'')), profile_id) AS name, " +
      "COALESCE(MAX(NULLIF(country,'')), '') AS country FROM lingxing_ad_reports GROUP BY profile_id ORDER BY name").all();
  }
  function lingxingAdvertisingCacheStats() {
    const config = db.prepare("SELECT cache_days AS cacheDays,range_start AS start,range_end AS end,rows,synced_at AS syncedAt FROM lingxing_ad_cache_config WHERE id=1").get();
    const stored = db.prepare("SELECT COUNT(*) AS storedRows,COUNT(DISTINCT profile_id) AS storeCount,COUNT(DISTINCT view_type) AS viewCount FROM lingxing_ad_reports WHERE is_summary=0").get();
    const latestRange = db.prepare("SELECT range_start AS start,range_end AS end FROM lingxing_ad_reports " +
      "WHERE is_summary=0 GROUP BY range_start,range_end ORDER BY MAX(synced_at) DESC LIMIT 1").get();
    return Object.assign({}, config, stored, {
      start: (latestRange && latestRange.start) || (config && config.start),
      end: (latestRange && latestRange.end) || (config && config.end),
      stores: listCachedLingxingAdvertisingStores(),
      activeJob: activeAdJobId ? adJobs.get(activeAdJobId) || null : null,
    });
  }

  // lingxingLocalData.ts:786-812
  function clearLingxingStoredData(rawScope) {
    const scope = String(rawScope || "");
    if (!["sales", "ziniao", "advertising", "all"].includes(scope)) throw fail(INTEGRATION_ERR_INVALID_INPUT, "不支持的存储清理范围");
    const salesRunning = !!activeJobId && jobs.get(activeJobId) && jobs.get(activeJobId).status === "running";
    const advertisingRunning = !!activeAdJobId && adJobs.get(activeAdJobId) && adJobs.get(activeAdJobId).status === "running";
    if ((scope === "sales" || scope === "all") && salesRunning) throw fail(INTEGRATION_ERR_INVALID_INPUT, "领星销售数据正在同步，请完成后再清理");
    if ((scope === "advertising" || scope === "all") && advertisingRunning) throw fail(INTEGRATION_ERR_INVALID_INPUT, "广告数据正在下载，请先停止任务再清理");
    const clear = writeTransaction(db, () => {
      if (scope === "sales" || scope === "all") {
        db.prepare("DELETE FROM lingxing_daily_sales WHERE source_type='lingxing'").run();
        db.prepare("DELETE FROM lingxing_sync_runs").run();
        db.prepare("UPDATE lingxing_cache_config SET updated_at=0 WHERE id=1").run();
      }
      if (scope === "ziniao" || scope === "all") db.prepare("DELETE FROM lingxing_daily_sales WHERE source_type='ziniao'").run();
      if (scope === "advertising" || scope === "all") {
        db.prepare("DELETE FROM lingxing_ad_reports").run();
        db.prepare("UPDATE lingxing_ad_cache_config SET range_start=NULL,range_end=NULL,rows=0,synced_at=NULL WHERE id=1").run();
      }
    });
    clear();
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* :memory: 无 WAL */ }
    try { db.exec("VACUUM"); } catch { /* 忽略 */ }
    return lingxingCacheStats();
  }

  // lingxingLocalData.ts:814-857
  function queryLingxingAdvertisingCache(options = {}) {
    const start = String(options.start || "");
    const end = String(options.end || "");
    const view = advertisingTools.some((item) => item.view === options.view) ? options.view : "campaign";
    const profileId = String(options.profileId || "");
    const rows = db.prepare("SELECT data,store_name AS storeName,country FROM lingxing_ad_reports " +
      "WHERE range_start=? AND range_end=? AND view_type=? AND profile_id=? AND is_summary=0").all(start, end, view, profileId);
    const search = String(options.search || "").trim().toLocaleLowerCase();
    const sponsoredType = String(options.sponsoredType || "").toLocaleLowerCase();
    const state = String(options.state || "").toLocaleLowerCase();
    const parsed = rows.map((item) => {
      const row = JSON.parse(item.data);
      return Object.assign({}, row, { store_name: advertisingValue(row, ["store_name"]) || item.storeName, country: advertisingValue(row, ["country"]) || item.country });
    }).filter((row) => {
      if (search && !JSON.stringify(row).toLocaleLowerCase().includes(search)) return false;
      if (sponsoredType && String(advertisingValue(row, ["ads_type", "sponsored_type", "creative_type"])).toLocaleLowerCase() !== sponsoredType) return false;
      if (state && String(advertisingValue(row, ["state", "serving_status", "ads_state"])).toLocaleLowerCase() !== state) return false;
      return true;
    }).sort((a, b) => num(advertisingValue(b, ["spends", "spend", "cost"])) - num(advertisingValue(a, ["spends", "spend", "cost"])));
    const summaryStored = db.prepare("SELECT data FROM lingxing_ad_reports " +
      "WHERE range_start=? AND range_end=? AND view_type=? AND profile_id=? AND is_summary=1 LIMIT 1").get(start, end, view, profileId);
    const page = Math.max(1, Math.floor(Number(options.page) || 1));
    const length = Math.min(200, Math.max(1, Math.floor(Number(options.length) || 200)));
    return {
      cached: rows.length > 0 || !!summaryStored,
      rows: parsed.slice((page - 1) * length, page * length),
      summary: summaryStored && summaryStored.data ? JSON.parse(summaryStored.data) : {},
      total: parsed.length, page, length,
    };
  }

  // lingxingLocalData.ts:859-944
  function lingxingLocalRows(date, limit = 200, offset = 0) {
    const boundedLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const boundedOffset = Math.max(0, Math.floor(offset));
    const where = date ? "WHERE business_date=?" : "";
    const args = date ? [date] : [];
    const total = db.prepare("SELECT COUNT(*) AS n FROM lingxing_daily_sales " + where).get(...args).n;
    const rows = db.prepare("SELECT business_date AS date,source_type AS source,account,country,brand,asin,sku,item_name AS itemName, " +
      "volume,amount,orders,sessions,currency,shipped_revenue AS shippedRevenue,shipped_cogs AS shippedCogs, " +
      "shipped_units AS shippedUnits,customer_returns AS customerReturns,synced_at AS syncedAt " +
      "FROM lingxing_daily_sales " + where + " ORDER BY business_date DESC, amount DESC LIMIT ? OFFSET ?").all(...args, boundedLimit, boundedOffset);
    return { rows, total, limit: boundedLimit, offset: boundedOffset };
  }

  function queryLingxingLocalData(options = {}) {
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
    const start = validDate(options.start);
    const end = validDate(options.end);
    const groupBy = options.groupBy === "sku" ? "sku" : "asin";
    const groupExpression = groupBy === "sku" ? "COALESCE(NULLIF(sku,''),NULLIF(asin,''),record_key)" : "COALESCE(NULLIF(asin,''),NULLIF(sku,''),record_key)";
    const where = [];
    const args = [];
    if (options.source === "lingxing" || options.source === "ziniao") { where.push("source_type = ?"); args.push(options.source); }
    if (start) { where.push("business_date >= ?"); args.push(start); }
    if (end) { where.push("business_date <= ?"); args.push(end); }
    const search = String(options.search || "").trim().slice(0, 120);
    if (search) {
      where.push("(item_name LIKE ? OR asin LIKE ? OR sku LIKE ? OR account LIKE ? OR brand LIKE ?)");
      const pattern = "%" + search + "%";
      args.push(pattern, pattern, pattern, pattern, pattern);
    }
    const asins = [...new Set((Array.isArray(options.asins) ? options.asins : [])
      .map((value) => String(value || "").trim().toUpperCase()).filter(Boolean))].slice(0, 5000);
    if (asins.length) {
      where.push("UPPER(asin) IN (" + asins.map(() => "?").join(",") + ")");
      args.push(...asins);
    }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const groupedSql = "SELECT MIN(business_date) AS startDate, MAX(business_date) AS endDate, " +
      "source_type AS source, GROUP_CONCAT(DISTINCT account) AS account, GROUP_CONCAT(DISTINCT country) AS country, GROUP_CONCAT(DISTINCT brand) AS brand, " +
      "MAX(asin) AS asin, MAX(sku) AS sku, MAX(item_name) AS itemName, " +
      "SUM(volume) AS volume, SUM(amount) AS amount, SUM(orders) AS orders, " +
      "SUM(sessions) AS sessions, MAX(currency) AS currency, " +
      "SUM(shipped_revenue) AS shippedRevenue, SUM(shipped_cogs) AS shippedCogs, " +
      "SUM(shipped_units) AS shippedUnits, SUM(customer_returns) AS customerReturns " +
      "FROM lingxing_daily_sales " + whereSql + " GROUP BY source_type, " + groupExpression;
    const total = db.prepare("SELECT COUNT(*) AS n FROM (" + groupedSql + ")").get(...args).n;
    const summary = db.prepare("SELECT COUNT(*) AS sourceRows, COUNT(DISTINCT business_date) AS dayCount, " +
      "SUM(volume) AS volume, SUM(amount) AS amount, SUM(orders) AS orders, SUM(sessions) AS sessions, " +
      "SUM(shipped_revenue) AS shippedRevenue, SUM(shipped_cogs) AS shippedCogs, " +
      "SUM(shipped_units) AS shippedUnits, SUM(customer_returns) AS customerReturns, " +
      "SUM(CASE WHEN source_type='lingxing' THEN 1 ELSE 0 END) AS lingxingRows, " +
      "SUM(CASE WHEN source_type='ziniao' THEN 1 ELSE 0 END) AS ziniaoRows " +
      "FROM lingxing_daily_sales " + whereSql).get(...args);
    const sortExpressions = {
      itemName: "itemName", asin: "asin", sku: "sku", volume: "volume", amount: "amount",
      orders: "orders", sessions: "sessions", cvr: "(orders / NULLIF(sessions,0))",
      shippedRevenue: "shippedRevenue", shippedCogs: "shippedCogs", shippedUnits: "shippedUnits", customerReturns: "customerReturns",
    };
    const sort = sortExpressions[String(options.sort || "")] || "amount";
    const direction = options.direction === "asc" ? "ASC" : "DESC";
    const limit = Math.min(500, Math.max(1, Math.floor(Number(options.limit) || 200)));
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const rows = db.prepare(groupedSql + " ORDER BY " + sort + " " + direction + ", asin ASC LIMIT ? OFFSET ?")
      .all(...args, limit, offset)
      .map((row) => Object.assign({}, row, {
        sku: normalizeGroupedText(row.sku),
        account: normalizeGroupedText(row.account),
        country: normalizeGroupedText(row.country),
        brand: normalizeGroupedText(row.brand),
      }));
    return { rows, summary, total, limit, offset, start: start || null, end: end || null, groupBy };
  }


  // ── lingxingLocalData.ts:14-30 汇率（网络经注入 fetch；未注入即回退内置汇率，与源 catch 分支一致） ──
  const FALLBACK_CURRENCY_RATES = Object.freeze({ CNY: 1, USD: 0.14, EUR: 0.12, GBP: 0.104, JPY: 21.7, CAD: 0.193, AUD: 0.214, CHF: 0.11 });
  let currencyRatesCache = { rates: FALLBACK_CURRENCY_RATES, updatedAt: 0, source: "fallback" };
  async function getLingxingCurrencyRates() {
    if (currencyRatesCache.source === "live" && Date.now() - currencyRatesCache.updatedAt < 6 * 60 * 60 * 1000) return currencyRatesCache;
    try {
      if (typeof fetchImpl !== "function") throw new Error("未注入 fetch");
      const response = await fetchImpl("https://api.frankfurter.app/latest?from=CNY&to=USD,EUR,GBP,JPY,CAD,AUD,CHF", { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const payload = await response.json();
      const rates = Object.assign({ CNY: 1 }, payload.rates || {});
      if (!["USD", "EUR", "GBP"].every((code) => Number.isFinite(rates[code]) && rates[code] > 0)) throw new Error("汇率数据不完整");
      currencyRatesCache = { rates, updatedAt: Date.now(), source: "live" };
    } catch {
      currencyRatesCache = { rates: FALLBACK_CURRENCY_RATES, updatedAt: Date.now(), source: "fallback" };
    }
    return currencyRatesCache;
  }

  // ── lingxingLocalData.ts:946-1044 业务分析（逐字；JSON 维度直接用已物化列，避免逐行解析） ──
  function analyticsRatio(current, previous) {
    if (!previous) return current ? null : 0;
    return (current - previous) / previous;
  }
  function lingxingBusinessAnalytics(options = {}) {
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
    const latest = (db.prepare("SELECT MAX(business_date) AS date FROM lingxing_daily_sales").get() || {}).date || isoDate(new Date());
    const end = validDate(options.end) || latest;
    const requestedStart = validDate(options.start);
    const defaultStart = new Date(end + "T12:00:00"); defaultStart.setDate(defaultStart.getDate() - 29);
    const start = requestedStart || isoDate(defaultStart);
    const dayCount = Math.max(1, Math.round((new Date(end + "T12:00:00").getTime() - new Date(start + "T12:00:00").getTime()) / 86400000) + 1);
    const previousEndDate = new Date(start + "T12:00:00"); previousEndDate.setDate(previousEndDate.getDate() - 1);
    const previousStartDate = new Date(previousEndDate); previousStartDate.setDate(previousStartDate.getDate() - dayCount + 1);
    const previousStart = isoDate(previousStartDate), previousEnd = isoDate(previousEndDate);
    const source = options.source === "lingxing" || options.source === "ziniao" ? options.source : "all";
    const sourceWhere = source === "all" ? "" : "source_type=? AND ";
    const sourceArgs = source === "all" ? [] : [source];
    const baseArgs = [...sourceArgs, previousStart, end];
    const metricSql = (prefix = "") => `SUM(CASE WHEN business_date BETWEEN ? AND ? THEN COALESCE(${prefix}amount,0) ELSE 0 END) AS amount,
    SUM(CASE WHEN business_date BETWEEN ? AND ? THEN COALESCE(${prefix}volume,0) ELSE 0 END) AS volume,
    SUM(CASE WHEN business_date BETWEEN ? AND ? THEN COALESCE(${prefix}orders,0) ELSE 0 END) AS orders,
    SUM(CASE WHEN business_date BETWEEN ? AND ? THEN COALESCE(${prefix}sessions,0) ELSE 0 END) AS sessions`;
    const metricArgs = [start, end, start, end, start, end, start, end];
    const previousMetricSql = `SUM(CASE WHEN business_date BETWEEN ? AND ? THEN COALESCE(amount,0) ELSE 0 END) AS previousAmount,
    SUM(CASE WHEN business_date BETWEEN ? AND ? THEN COALESCE(volume,0) ELSE 0 END) AS previousVolume,
    SUM(CASE WHEN business_date BETWEEN ? AND ? THEN COALESCE(orders,0) ELSE 0 END) AS previousOrders,
    SUM(CASE WHEN business_date BETWEEN ? AND ? THEN COALESCE(sessions,0) ELSE 0 END) AS previousSessions`;
    const previousMetricArgs = [previousStart, previousEnd, previousStart, previousEnd, previousStart, previousEnd, previousStart, previousEnd];
    const summary = db.prepare(`SELECT ${metricSql()}, ${previousMetricSql}, COUNT(DISTINCT CASE WHEN business_date BETWEEN ? AND ? THEN NULLIF(asin,'') END) AS asinCount
    FROM lingxing_daily_sales WHERE ${sourceWhere}business_date BETWEEN ? AND ?`).get(...metricArgs, ...previousMetricArgs, start, end, ...baseArgs);
    const current = { amount: Number(summary.amount) || 0, volume: Number(summary.volume) || 0, orders: Number(summary.orders) || 0, sessions: Number(summary.sessions) || 0, asinCount: Number(summary.asinCount) || 0 };
    const previous = { amount: Number(summary.previousAmount) || 0, volume: Number(summary.previousVolume) || 0, orders: Number(summary.previousOrders) || 0, sessions: Number(summary.previousSessions) || 0 };
    const daily = db.prepare(`SELECT business_date AS date, SUM(amount) AS amount, SUM(volume) AS volume, SUM(orders) AS orders, SUM(sessions) AS sessions
    FROM lingxing_daily_sales WHERE ${sourceWhere}business_date BETWEEN ? AND ? GROUP BY business_date ORDER BY business_date`).all(...sourceArgs, start, end);
    const products = db.prepare(`SELECT COALESCE(NULLIF(asin,''),NULLIF(sku,''),record_key) AS productKey, MAX(asin) AS asin, MAX(sku) AS sku, MAX(item_name) AS itemName, MAX(brand) AS brand,
    ${metricSql()}, ${previousMetricSql}
    FROM lingxing_daily_sales WHERE ${sourceWhere}business_date BETWEEN ? AND ?
    GROUP BY COALESCE(NULLIF(asin,''),NULLIF(sku,''),record_key) ORDER BY amount DESC`).all(...metricArgs, ...previousMetricArgs, ...baseArgs);
    const normalizedProducts = products.map((row) => {
      const amount = Number(row.amount) || 0, previousAmount = Number(row.previousAmount) || 0;
      const orders = Number(row.orders) || 0, sessions = Number(row.sessions) || 0;
      return Object.assign({}, row, { asin: String(row.asin || ""), amount, previousAmount, volume: Number(row.volume) || 0, previousVolume: Number(row.previousVolume) || 0,
        orders, sessions, cvr: sessions ? orders / sessions : 0, change: analyticsRatio(amount, previousAmount) });
    });
    const dimensions = {};
    const dimensionExpressions = {
      account: "COALESCE(NULLIF(account,''),'未分类')",
      country: "COALESCE(NULLIF(country,''),'未分类')",
      brand: "COALESCE(NULLIF(brand,''),'未分类')",
    };
    for (const key of ["account", "country", "brand"]) {
      const expression = dimensionExpressions[key];
      dimensions[key] = db.prepare(`SELECT ${expression} AS name, SUM(amount) AS amount, SUM(volume) AS volume
      FROM lingxing_daily_sales WHERE ${sourceWhere}business_date BETWEEN ? AND ? GROUP BY ${expression} ORDER BY amount DESC LIMIT 20`).all(...sourceArgs, start, end);
    }
    const groupMap = options.groupMap && typeof options.groupMap === "object" ? options.groupMap : {};
    const groupTotals = new Map();
    for (const product of normalizedProducts) {
      const name = String(groupMap[String(product.asin || "").toUpperCase()] || "未映射 ASIN");
      const group = groupTotals.get(name) || { name, amount: 0, volume: 0, previousAmount: 0, asinCount: 0 };
      group.amount += Number(product.amount) || 0; group.volume += Number(product.volume) || 0; group.previousAmount += Number(product.previousAmount) || 0;
      if (product.amount || product.volume || product.orders || product.sessions) group.asinCount += 1;
      groupTotals.set(name, group);
    }
    const groups = [...groupTotals.values()].map((group) => Object.assign({}, group, { change: analyticsRatio(group.amount, group.previousAmount) })).sort((a, b) => b.amount - a.amount);
    const comparisonAvailable = previous.amount > 0;
    const growth = comparisonAvailable
      ? normalizedProducts.filter((row) => row.amount > 0 && row.previousAmount > 0 && Number(row.change) > 0).sort((a, b) => Number(b.change) - Number(a.change)).slice(0, 8)
      : normalizedProducts.filter((row) => row.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 8);
    const decline = comparisonAvailable
      ? normalizedProducts.filter((row) => row.previousAmount > 0 && Number(row.change) < 0).sort((a, b) => Number(a.change) - Number(b.change)).slice(0, 8)
      : normalizedProducts.filter((row) => row.sessions >= 10).sort((a, b) => a.cvr - b.cvr || b.sessions - a.sessions).slice(0, 8);
    const productTotal = normalizedProducts.length;
    const productLimit = Math.min(200, Math.max(1, Math.floor(Number(options.limit) || 200)));
    const productOffset = Math.max(0, Math.floor(Number(options.offset) || 0));
    return {
      range: { start, end, dayCount, previousStart, previousEnd }, source, current, previous,
      comparisonAvailable,
      ratios: { amount: analyticsRatio(current.amount, previous.amount), volume: analyticsRatio(current.volume, previous.volume), orders: analyticsRatio(current.orders, previous.orders), sessions: analyticsRatio(current.sessions, previous.sessions) },
      daily, products: normalizedProducts.slice(productOffset, productOffset + productLimit), productTotal, productLimit, productOffset,
      growth, decline,
      newProducts: normalizedProducts.filter((row) => row.amount > 0 && !row.previousAmount).sort((a, b) => b.amount - a.amount).slice(0, 8),
      dimensions, groups: groups.slice(0, 20),
    };
  }

  // ── lingxingLocalData.ts:1078-1158 运营看板 ──
  function operatorNumber(data, aliases) {
    for (const key of aliases) {
      const value = Number(data[key]);
      if (Number.isFinite(value)) return value;
    }
    return 0;
  }
  function addOperatorMetrics(target, row) {
    let data = {};
    try { data = JSON.parse(String(row.data || "{}")); } catch { /* 保持空对象 */ }
    target.sessions += Number(row.sessions) || operatorNumber(data, ["sessions", "session"]);
    target.volume += Number(row.volume) || 0;
    target.orders += Number(row.orders) || 0;
    target.amount += Number(row.amount) || 0;
    target.impressions += operatorNumber(data, ["impressions", "impression"]);
    target.clicks += operatorNumber(data, ["clicks", "click"]);
    target.spend += operatorNumber(data, ["spend", "spends", "cost"]);
    target.adOrders += operatorNumber(data, ["ad_order_quantity", "ad_orders", "ad_order"]);
    target.adSales += operatorNumber(data, ["ad_sales_amount", "ad_sales"]);
    target.returns += Number(row.customer_returns) || operatorNumber(data, ["return_count", "return_goods_count", "returns"]);
    target.organicOrders += operatorNumber(data, ["nature_order_items", "organic_orders", "natural_orders"]);
  }
  function emptyOperatorRow(row, date) {
    return Object.assign({}, date ? { date } : {}, {
      asin: String(row.asin || "").toUpperCase(), sku: String(row.sku || ""),
      itemName: String(row.item_name || ""), country: String(row.country || ""), account: String(row.account || ""),
      sessions: 0, volume: 0, orders: 0, amount: 0, impressions: 0, clicks: 0, spend: 0,
      adOrders: 0, adSales: 0, returns: 0, organicOrders: 0,
    });
  }
  function queryLingxingOperatorDashboard(options = {}) {
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
    const latest = (db.prepare("SELECT MAX(business_date) AS date FROM lingxing_daily_sales").get() || {}).date || isoDate(new Date());
    const end = validDate(options.end) || latest;
    const start = validDate(options.start) || end;
    const asins = [...new Set((Array.isArray(options.asins) ? options.asins : []).map((value) => String(value || "").trim().toUpperCase()).filter(Boolean))].slice(0, 5000);
    const asinWhere = asins.length ? " AND UPPER(asin) IN (" + asins.map(() => "?").join(",") + ")" : "";
    const sourceRows = db.prepare(`SELECT business_date, asin, sku, item_name, country, account, sessions, volume, orders, amount, customer_returns, data
    FROM lingxing_daily_sales WHERE business_date BETWEEN ? AND ? AND NULLIF(asin,'') IS NOT NULL${asinWhere}
    ORDER BY business_date, asin`).all(start, end, ...asins);
    const summaryMap = new Map();
    const dailyMap = new Map();
    for (const row of sourceRows) {
      const asin = String(row.asin || "").toUpperCase();
      const date = String(row.business_date || "");
      const summary = summaryMap.get(asin) || emptyOperatorRow(row);
      if (!summary.itemName && row.item_name) summary.itemName = String(row.item_name);
      if (!summary.sku && row.sku) summary.sku = String(row.sku);
      if (!summary.country && row.country) summary.country = String(row.country);
      if (!summary.account && row.account) summary.account = String(row.account);
      addOperatorMetrics(summary, row);
      summaryMap.set(asin, summary);
      if (options.includeDaily === true) {
        const dailyKey = asin + "\u0000" + date;
        const daily = dailyMap.get(dailyKey) || emptyOperatorRow(row, date);
        addOperatorMetrics(daily, row);
        dailyMap.set(dailyKey, daily);
      }
    }
    const search = String(options.search || "").trim().toLocaleLowerCase().slice(0, 120);
    const filteredRows = [...summaryMap.values()].filter((row) => !search || [row.asin, row.sku, row.country, row.account, row.itemName]
      .some((value) => String(value || "").toLocaleLowerCase().includes(search)))
      .sort((a, b) => b.amount - a.amount || b.volume - a.volume);
    const total = filteredRows.length;
    const limit = Math.min(200, Math.max(1, Math.floor(Number(options.limit) || 200)));
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const rows = options.paginate === false ? filteredRows : filteredRows.slice(offset, offset + limit);
    const pageAsins = new Set(rows.map((row) => row.asin));
    const daily = options.includeDaily === true
      ? [...dailyMap.values()].filter((row) => pageAsins.has(row.asin))
        .sort((a, b) => a.asin.localeCompare(b.asin) || String(a.date).localeCompare(String(b.date)))
      : [];
    const summary = filteredRows.reduce((target, row) => {
      for (const key of ["sessions", "volume", "orders", "amount", "impressions", "clicks", "spend", "adOrders", "adSales", "returns", "organicOrders"]) target[key] += Number(row[key]) || 0;
      return target;
    }, emptyOperatorRow({}));
    return { start, end, rows, daily, summary, total, limit, offset, asinCount: total, sourceRows: sourceRows.length };
  }

  // ── lingxingLocalData.ts:1160-1186 运营看板导出。
  //   源用 exceljs 写 xlsx；本仓不新增依赖，改为注入 workBookWriter（未注入即结构化不可用，绝不返回假文件）。 ──
  async function exportLingxingOperatorDashboard(options = {}) {
    const result = queryLingxingOperatorDashboard(Object.assign({}, options, { paginate: false, includeDaily: true }));
    const currency = String(options.currency || "CNY").toUpperCase();
    const rate = (await getLingxingCurrencyRates()).rates[currency] || 1;
    const columns = [
      ["date", "日期"], ["itemName", "产品名"], ["asin", "ASIN"], ["country", "国家"], ["sku", "SKU"], ["currency", "货币"], ["sessions", "Session"],
      ["volume", "销量"], ["orders", "订单"], ["amount", "总销售额"], ["averageSalePerPcs", "平均销售额 / pcs"], ["impressions", "曝光"], ["clicks", "点击"], ["spend", "广告花费"],
      ["adOrders", "广告订单"], ["adSales", "广告销售额"], ["returns", "退货"], ["organicOrders", "自然订单"],
    ];
    const buildSheet = (name, rows, includeDate) => {
      const used = columns.filter(([key]) => includeDate || key !== "date");
      return {
        name,
        freeze: { ySplit: 1, xSplit: includeDate ? 3 : 2 },
        columns: used.map(([key, header]) => ({ key, header, width: key === "itemName" ? 38 : key === "asin" || key === "sku" ? 18 : 14 })),
        rows: rows.map((row) => Object.assign({}, row, { currency, amount: row.amount * rate, averageSalePerPcs: row.volume ? row.amount / row.volume * rate : null, spend: row.spend * rate, adSales: row.adSales * rate })),
        numberFormats: { amount: "#,##0.00", averageSalePerPcs: "#,##0.00", spend: "#,##0.00", adSales: "#,##0.00" },
        autoFilter: true,
        headerFont: { bold: true, color: { argb: "FFFFFFFF" } },
        headerFill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFF05A36" } },
      };
    };
    if (typeof writeWorkbook !== "function") throw fail(INTEGRATION_ERR_UNAVAILABLE, "未注入工作簿写入器 writeWorkbook（本移植不新增依赖，未随包 exceljs）；注入后导出可用，绝不返回假文件");
    let data;
    try {
      data = await writeWorkbook({ creator: "DX OS · 领星运营看板", sheets: [buildSheet("运营汇总", result.rows, false), buildSheet("每日明细", result.daily, true)] });
    } catch (cause) {
      throw fail(INTEGRATION_ERR_INTERNAL, "工作簿写入失败：" + String((cause && cause.message) || cause));
    }
    if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) throw fail(INTEGRATION_ERR_INTERNAL, "工作簿写入器未返回二进制数据");
    return { data: Buffer.from(data), fileName: "运营看板_" + currency + "_" + result.start + "_" + result.end + ".xlsx" };
  }


  // ── lingxingLocalData.ts:267-436 紫鸟 VC 导入（逐函数移植；工作簿解析改为注入 readWorkbook） ──
  function normalizeVcDate(value) {
    if (value instanceof Date && Number.isFinite(value.getTime())) return isoDate(value);
    const text = String(value == null ? "" : value).trim();
    const matched = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    if (!matched) return "";
    return matched[1] + "-" + matched[2].padStart(2, "0") + "-" + matched[3].padStart(2, "0");
  }
  function resolveZiniaoVcRoot() {
    if (ziniaoOutputRoot) {
      const value = ziniaoOutputRoot();
      if (value) return path.resolve(String(value));
    }
    return path.resolve(path.join(dataDir || os.tmpdir(), "ziniao-vc"));
  }
  function isInside(root, candidate) {
    const relativePath = path.relative(root, candidate);
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  }
  function describeVcFile(filePath) {
    const info = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const match = fileName.match(/^VC汇总_(.+)_(\d{8}-\d{8})\.xlsx$/i);
    return { path: filePath, fileName, store: (match && match[1]) || "", dateRange: (match && match[2]) || "", bytes: info.size, updatedAt: info.mtimeMs };
  }
  function vcCellValue(cell) {
    if (cell.value instanceof Date) return cell.value;
    return cell.text || cell.value || "";
  }
  async function parseZiniaoVcWorkbook(filePath) {
    if (typeof readWorkbook !== "function") throw fail(INTEGRATION_ERR_UNAVAILABLE, "未注入表格解析器 readWorkbook（本移植不新增依赖，未随包 exceljs）；注入后 VC 导入可用");
    const buffer = fs.readFileSync(filePath);
    const workbook = await readWorkbook(buffer, ".xlsx");
    const result = [];
    for (const worksheet of workbook.worksheets || []) {
      const headers = new Map();
      const headerRow = worksheet.getRow(1);
      for (let column = 1; column <= Math.max(headerRow.cellCount, worksheet.columnCount); column += 1) {
        const label = String(headerRow.getCell(column).text || "").trim().toLowerCase();
        if (label) headers.set(label, column);
      }
      const required = ["日期", "账号", "asin"];
      if (!required.every((header) => headers.has(header))) continue;
      const read = (row, header) => {
        const column = headers.get(header.toLowerCase());
        return column ? vcCellValue(row.getCell(column)) : "";
      };
      for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
        const row = worksheet.getRow(rowNumber);
        const businessDate = normalizeVcDate(read(row, "日期"));
        const account = String(read(row, "账号") || "").trim();
        const asin = String(read(row, "asin") || "").trim().toUpperCase();
        if (!businessDate || !account || !asin) continue;
        const rawData = Object.fromEntries([...headers.entries()].map(([header, column]) => [header, vcCellValue(row.getCell(column)) instanceof Date ? row.getCell(column).text : vcCellValue(row.getCell(column))]));
        result.push({
          businessDate,
          account,
          country: String(read(row, "国家") || "").trim(),
          asin,
          productTitle: String(read(row, "product title") || "").trim(),
          brand: String(read(row, "brand") || "").trim(),
          sourceView: String(read(row, "manufacturing or sourcing") || "").trim(),
          orderedRevenue: metricNum(read(row, "ordered revenue")),
          orderedUnits: metricNum(read(row, "ordered units")),
          shippedRevenue: metricNum(read(row, "shipped revenue")),
          shippedCogs: metricNum(read(row, "shipped cogs")),
          shippedUnits: metricNum(read(row, "shipped units")),
          customerReturns: metricNum(read(row, "customer returns")),
          sessions: metricNum(read(row, "session")),
          rawData,
        });
      }
    }
    if (!result.length) throw fail(INTEGRATION_ERR_INVALID_INPUT, "没有在工作簿中找到可导入的 VC 汇总数据，请确认包含日期、账号和 Asin 列");
    return result;
  }
  const importNewZiniaoVcRows = writeTransaction(db, (rows, sourceFile, importedAt) => {
    const scopes = new Set(rows.map((row) => row.businessDate + "\u0000" + row.account));
    const exists = db.prepare("SELECT 1 FROM lingxing_daily_sales WHERE source_type='ziniao' AND business_date=? AND account=? LIMIT 1");
    const newScopes = new Set();
    for (const scope of scopes) {
      const parts = scope.split("\u0000");
      if (!exists.get(parts[0], parts[1])) newScopes.add(scope);
    }
    const insert = db.prepare(`INSERT OR REPLACE INTO lingxing_daily_sales
      (business_date,record_key,asin,sku,item_name,volume,amount,orders,sessions,currency,source_type,account,country,brand,source_view,shipped_revenue,shipped_cogs,shipped_units,customer_returns,source_file,data,synced_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let importedRows = 0;
    for (const row of rows) {
      if (!newScopes.has(row.businessDate + "\u0000" + row.account)) continue;
      const key = "ziniao:" + row.account + ":" + row.asin + ":" + row.country + ":" + row.sourceView;
      insert.run(row.businessDate, key, row.asin, "", row.productTitle, row.orderedUnits, row.orderedRevenue, 0, row.sessions, "",
        "ziniao", row.account, row.country, row.brand, row.sourceView, row.shippedRevenue, row.shippedCogs, row.shippedUnits,
        row.customerReturns, sourceFile, JSON.stringify(row.rawData), importedAt);
      importedRows += 1;
    }
    return { importedRows, skippedRows: rows.length - importedRows, importedScopes: newScopes.size, skippedScopes: scopes.size - newScopes.size };
  });
  async function importZiniaoVcFile(rawPath) {
    const rootPath = resolveZiniaoVcRoot();
    let root;
    try { root = fs.realpathSync(rootPath); } catch { throw fail(INTEGRATION_ERR_INVALID_INPUT, "紫鸟保存目录不存在：" + rootPath); }
    const requested = path.resolve(String(rawPath || ""));
    if (!requested || path.extname(requested).toLowerCase() !== ".xlsx") throw fail(INTEGRATION_ERR_INVALID_INPUT, "请选择紫鸟生成的 VC 汇总 XLSX 文件");
    let target;
    try { target = fs.realpathSync(requested); } catch { throw fail(INTEGRATION_ERR_INVALID_INPUT, "文件不存在：" + requested); }
    if (!isInside(root, target)) throw fail(INTEGRATION_ERR_INVALID_INPUT, "只能导入当前紫鸟保存目录中的文件");
    if (!/^VC汇总_/i.test(path.basename(target))) throw fail(INTEGRATION_ERR_INVALID_INPUT, "请选择文件名以“VC汇总_”开头的文件");
    const rows = await parseZiniaoVcWorkbook(target);
    const importedAt = Date.now();
    const result = importNewZiniaoVcRows(rows, target, importedAt);
    const dates = [...new Set(rows.map((row) => row.businessDate))].sort();
    return {
      file: describeVcFile(target),
      rows: result.importedRows,
      parsedRows: rows.length,
      skippedRows: result.skippedRows,
      importedScopes: result.importedScopes,
      skippedScopes: result.skippedScopes,
      start: dates[0],
      end: dates[dates.length - 1],
      dayCount: dates.length,
      accountCount: new Set(rows.map((row) => row.account)).size,
      asinCount: new Set(rows.map((row) => row.asin)).size,
      importedAt,
    };
  }

  // ── lingxingLocalData.ts:1188-1247 紫鸟 VC 查询。
  //   忠实移植：这两段读的是 ziniao_vc_daily；源启动时已把该表并入 lingxing_daily_sales 后清空（见文件头），
  //   因此空表是源行为本身；在线路径请用 queryLingxingLocalData({ source: "ziniao" })。 ──
  function queryZiniaoVcData(options = {}) {
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
    const start = validDate(options.start);
    const end = validDate(options.end);
    const where = [];
    const args = [];
    if (start) { where.push("business_date >= ?"); args.push(start); }
    if (end) { where.push("business_date <= ?"); args.push(end); }
    const search = String(options.search || "").trim().slice(0, 120);
    if (search) {
      where.push("(product_title LIKE ? OR asin LIKE ? OR account LIKE ? OR brand LIKE ?)");
      const pattern = "%" + search + "%";
      args.push(pattern, pattern, pattern, pattern);
    }
    const asins = [...new Set((Array.isArray(options.asins) ? options.asins : [])
      .map((value) => String(value || "").trim().toUpperCase()).filter(Boolean))].slice(0, 5000);
    if (asins.length) {
      where.push("UPPER(asin) IN (" + asins.map(() => "?").join(",") + ")");
      args.push(...asins);
    }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const groupedSql = `SELECT MIN(business_date) AS startDate, MAX(business_date) AS endDate,
      asin, '' AS sku, MAX(product_title) AS itemName, GROUP_CONCAT(DISTINCT account) AS account,
      GROUP_CONCAT(DISTINCT country) AS country, GROUP_CONCAT(DISTINCT brand) AS brand,
      SUM(ordered_units) AS volume, SUM(ordered_revenue) AS amount, 0 AS orders, SUM(sessions) AS sessions,
      SUM(shipped_revenue) AS shippedRevenue, SUM(shipped_cogs) AS shippedCogs,
      SUM(shipped_units) AS shippedUnits, SUM(customer_returns) AS customerReturns, '' AS currency
    FROM ziniao_vc_daily ${whereSql} GROUP BY asin`;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM (${groupedSql})`).get(...args).n;
    const summary = db.prepare(`SELECT COUNT(*) AS sourceRows, COUNT(DISTINCT business_date) AS dayCount,
      COUNT(DISTINCT account) AS accountCount, COUNT(DISTINCT asin) AS asinCount,
      SUM(ordered_units) AS volume, SUM(ordered_revenue) AS amount, 0 AS orders, SUM(sessions) AS sessions,
      SUM(shipped_revenue) AS shippedRevenue, SUM(shipped_cogs) AS shippedCogs,
      SUM(shipped_units) AS shippedUnits, SUM(customer_returns) AS customerReturns
      FROM ziniao_vc_daily ${whereSql}`).get(...args);
    const sortExpressions = {
      itemName: "itemName", asin: "asin", sku: "sku", volume: "volume", amount: "amount", orders: "orders",
      sessions: "sessions", cvr: "(volume / NULLIF(sessions,0))", shippedRevenue: "shippedRevenue",
      shippedCogs: "shippedCogs", shippedUnits: "shippedUnits", customerReturns: "customerReturns",
    };
    const sort = sortExpressions[String(options.sort || "")] || "amount";
    const direction = options.direction === "asc" ? "ASC" : "DESC";
    const limit = Math.min(500, Math.max(1, Math.floor(Number(options.limit) || 200)));
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const rows = db.prepare(groupedSql + " ORDER BY " + sort + " " + direction + ", asin ASC LIMIT ? OFFSET ?").all(...args, limit, offset);
    return { rows, summary, total, limit, offset, start: start || null, end: end || null, groupBy: "asin", source: "ziniao" };
  }
  function ziniaoVcRows(date, limit = 200, offset = 0) {
    const boundedLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const boundedOffset = Math.max(0, Math.floor(offset));
    const where = date ? "WHERE business_date=?" : "";
    const args = date ? [date] : [];
    const total = db.prepare("SELECT COUNT(*) AS n FROM ziniao_vc_daily " + where).get(...args).n;
    const rows = db.prepare("SELECT business_date AS date, account, country, asin, '' AS sku, product_title AS itemName, brand, " +
      "ordered_units AS volume, ordered_revenue AS amount, 0 AS orders, sessions, '' AS currency, " +
      "shipped_revenue AS shippedRevenue, shipped_cogs AS shippedCogs, shipped_units AS shippedUnits, " +
      "customer_returns AS customerReturns, imported_at AS syncedAt " +
      "FROM ziniao_vc_daily " + where + " ORDER BY business_date DESC, ordered_revenue DESC LIMIT ? OFFSET ?").all(...args, boundedLimit, boundedOffset);
    return { rows, total, limit: boundedLimit, offset: boundedOffset };
  }

  return {
    dbPath, db,
    getActiveJobId: () => activeJobId,
    getActiveAdJobId: () => activeAdJobId,
    whenIdle: async () => { while (activeJobId || activeAdJobId) await new Promise((resolve) => setTimeout(resolve, 5)); },
    parseSalesResponse, fetchDate, replaceDate, salesDimensions,
    lingxingCacheStats, getLingxingCacheJob, startLingxingCacheSync,
    lingxingAdvertisingCacheStats, getLingxingAdvertisingCacheJob, startLingxingAdvertisingCacheSync,
    stopLingxingAdvertisingCacheJob, listCachedLingxingAdvertisingStores, queryLingxingAdvertisingCache,
    clearLingxingStoredData, lingxingLocalRows, queryLingxingLocalData,
    getLingxingCurrencyRates, lingxingBusinessAnalytics, queryLingxingOperatorDashboard, exportLingxingOperatorDashboard,
    normalizeVcDate, resolveZiniaoVcRoot, describeVcFile, parseZiniaoVcWorkbook, importZiniaoVcFile, queryZiniaoVcData, ziniaoVcRows,
    close: () => { try { db.close(); } catch { /* 忽略 */ } },
  };
}

module.exports = { createLingxingLocalData, writeTransaction, openDatabase, DB_FILE_NAME, ADVERTISING_SYNC_STOPPED };
