/**
 * B7c · 黄历（在线万年历）可选插件（逐函数移植 server/calendarAlmanac.ts:1-119）。
 *
 * 逐函数对应：
 *   calendarAlmanac.ts:34-40 shanghaiDateKey（Asia/Shanghai 日期键）
 *   calendarAlmanac.ts:42-44 cachePath（<cacheDir>/<year>.json）
 *   calendarAlmanac.ts:46-56 readCache（version/year/days 校验）
 *   calendarAlmanac.ts:58-67 saveCache（写临时文件 + rename）
 *   calendarAlmanac.ts:69-102 refreshYear（当天新鲜即复用；失败退回 stale 缓存）
 *   calendarAlmanac.ts:104-110 loadYear（同一年并发只发一次请求）
 *   calendarAlmanac.ts:112-118 onlineCalendarYears（去重、最多 3 个、1900–2100）
 *
 * 与源文件的差异（任务书硬要求）：
 *   · **网络一律经注入 fetch**；未注入即结构化 { ok:false, error:"INTEGRATION_UNAVAILABLE", detail }；
 *   · 远端地址 source 与缓存目录 cacheDir 都可注入（测试指向本地 127.0.0.1 stub，离线可跑）；
 *   · 源用 ensureDataDir('cache','calendar-almanac')，本移植由主进程传 <userData>/dxos/integrations/calendar-almanac。
 *
 * 缓存目录只写 JSON，不含任何凭据。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { INTEGRATION_ERR_UNAVAILABLE, INTEGRATION_ERR_INVALID_INPUT } = require("./plugin-registry.cjs");

const DEFAULT_SOURCE = "https://uapis.cn/api/v1/misc/holiday-calendar";

function createAlmanacIntegration(options = {}) {
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : null;
  const source = typeof options.source === "string" && options.source.trim() ? options.source.trim() : DEFAULT_SOURCE;
  const cacheDir = options.cacheDir ? String(options.cacheDir) : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const inflight = new Map();

  /** calendarAlmanac.ts:34-40 逐字移植。 */
  function shanghaiDateKey(timestamp = clock()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(timestamp));
    const value = (type) => (parts.find((part) => part.type === type) || {}).value || "";
    return value("year") + "-" + value("month") + "-" + value("day");
  }

  function cachePath(year) { return cacheDir ? path.join(cacheDir, year + ".json") : null; }

  /** calendarAlmanac.ts:46-56 逐字移植。 */
  function readCache(year) {
    const file = cachePath(year);
    if (!file || !fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed.version !== 1 || parsed.year !== year || !Array.isArray(parsed.days) || !parsed.days.length) return null;
      return parsed;
    } catch { return null; }
  }

  /** calendarAlmanac.ts:58-67 逐字移植。 */
  function saveCache(cache) {
    const file = cachePath(cache.year);
    if (!file) return false;
    const temp = file + "." + process.pid + "." + clock() + ".tmp";
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(cache), "utf8");
      fs.renameSync(temp, file);
      return true;
    } catch {
      return false;
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch { /* 忽略 */ }
    }
  }

  /** calendarAlmanac.ts:69-102 逐函数移植。 */
  async function refreshYear(year) {
    const cached = readCache(year);
    const today = shanghaiDateKey();
    if (cached && cached.fetchedDay === today) return { ...cached, cached: true, stale: false };

    try {
      const url = new URL(source);
      url.searchParams.set("year", String(year));
      url.searchParams.set("timezone", "Asia/Shanghai");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      let response;
      try {
        response = await fetchImpl(url, {
          headers: { accept: "application/json", "user-agent": "DX-OS-Calendar/1.0" },
          signal: ctrl.signal,
        });
      } finally { clearTimeout(timer); }
      if (!response || response.ok !== true) throw new Error("在线万年历返回 HTTP " + (response && response.status));
      const body = await response.json();
      const days = Array.isArray(body && body.days)
        ? body.days.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(String((day && day.date) || "")))
        : [];
      if (days.length < 28) throw new Error((body && body.message) || "在线万年历没有返回完整日期数据");
      const next = { version: 1, source, year, fetchedAt: clock(), fetchedDay: today, days };
      saveCache(next);
      return { ...next, cached: false, stale: false };
    } catch (error) {
      if (cached) return { ...cached, cached: true, stale: true };
      throw error;
    }
  }

  /** calendarAlmanac.ts:104-110 逐字移植。 */
  function loadYear(year) {
    const current = inflight.get(year);
    if (current) return current;
    const task = refreshYear(year).finally(() => inflight.delete(year));
    inflight.set(year, task);
    return task;
  }

  /** calendarAlmanac.ts:112-118 逐函数移植（throw 改为结构化返回）。 */
  async function onlineCalendarYears(years) {
    if (typeof fetchImpl !== "function") return { ok: false, error: INTEGRATION_ERR_UNAVAILABLE, detail: "未注入 fetch（网络访问在主进程统一开关），在线万年历不可用" };
    const input = Array.isArray(years) ? years : [];
    const normalized = [...new Set(input.map((year) => Math.trunc(Number(year))))];
    if (!normalized.length || normalized.length > 3 || normalized.some((year) => !Number.isFinite(year) || year < 1900 || year > 2100)) {
      return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "年份参数无效，每次最多查询 3 个 1900–2100 年之间的年份" };
    }
    try {
      const value = await Promise.all(normalized.map(loadYear));
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: INTEGRATION_ERR_UNAVAILABLE, detail: String((error && error.message) || error).slice(0, 300) };
    }
  }

  return { source, cacheDir, onlineCalendarYears, shanghaiDateKey, clearInflight: () => inflight.clear() };
}

module.exports = { createAlmanacIntegration, DEFAULT_SOURCE };
