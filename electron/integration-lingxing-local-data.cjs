/**
 * B7d · 领星本地数据缓存 + 同步作业（逐函数移植 server/lingxingLocalData.ts:1-787 的本地部分）。
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
 * 未移植（源中同一文件但不属本波"缓存/映射/同步作业"）：lingxingBusinessAnalytics、
 * queryLingxingOperatorDashboard、exportLingxingOperatorDashboard、importZiniaoVcFile、
 * ziniaoVcRows、queryZiniaoVcData、listZiniaoVcFiles（后者的文件列举已随紫鸟插件移植）。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createHash } = crypto;

const { INTEGRATION_ERR_UNAVAILABLE, INTEGRATION_ERR_INVALID_INPUT } = require("./plugin-registry.cjs");

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
    close: () => { try { db.close(); } catch { /* 忽略 */ } },
  };
}

module.exports = { createLingxingLocalData, writeTransaction, openDatabase, DB_FILE_NAME, ADVERTISING_SYNC_STOPPED };
