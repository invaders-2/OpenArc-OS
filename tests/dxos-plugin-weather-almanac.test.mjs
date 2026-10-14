/**
 * B7c · 天气 / 黄历可选插件测试（全离线：本地 127.0.0.1 stub HTTP 服务，不访问任何外网）。
 *
 * 覆盖任务书验收点：
 *   ① 天气逐函数移植：地理编码 → 当前 + 7 天预报、WMO 中文/emoji 映射、15 分钟缓存；
 *   ② 黄历逐函数移植：按年请求、当天新鲜即复用缓存、失败退回 stale 缓存、年份参数校验；
 *   ③ 未注入 fetch → 结构化 { ok:false, error:"INTEGRATION_UNAVAILABLE", detail }；
 *   ④ 本地 127.0.0.1 stub 走真实 HTTP（不是打桩函数），证明解析的是真实响应体。
 *
 * 只读源：electron/integration-weather.cjs（server/weather.ts:1-128）、
 *         electron/integration-almanac.cjs（server/calendarAlmanac.ts:1-119）。
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createWeatherIntegration, desc } = require("../electron/integration-weather.cjs");
const { createAlmanacIntegration } = require("../electron/integration-almanac.cjs");

const tmpDirs = [];
const servers = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
after(() => { for (const server of servers) { try { server.close(); } catch { /* 忽略 */ } } });

function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-weather-")); tmpDirs.push(dir); return dir; }

/** 本地 stub：只监听 127.0.0.1 随机端口；路由固定，响应体由 payload 决定。 */
function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const hit = handler(url, req);
      if (!hit) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
      if (hit.status && hit.status !== 200) { res.writeHead(hit.status); res.end(""); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(hit.body));
    });
    server.listen(0, "127.0.0.1", () => { servers.push(server); resolve({ server, base: "http://127.0.0.1:" + server.address().port }); });
  });
}

const FORECAST_BODY = {
  current: { temperature_2m: 20.6, apparent_temperature: 19.4, relative_humidity_2m: 71, weather_code: 61, wind_speed_10m: 12.5 },
  daily: {
    time: ["2026-01-01", "2026-01-02"],
    weather_code: [0, 95],
    temperature_2m_max: [24.4, 26.6],
    temperature_2m_min: [14.2, 16.1],
    precipitation_probability_max: [5, 80],
  },
};

// ── ① 天气解析 ────────────────────────────────────────────────────────────
test("天气：本地 stub 解析当前 + 逐日预报，WMO 映射与缓存生效（离线）", async () => {
  const calls = [];
  const stub = await startStub((url) => {
    calls.push(url.pathname);
    if (url.pathname === "/geo") return { body: { results: [{ latitude: 31.23, longitude: 121.47, name: "上海", country: "中国" }] } };
    if (url.pathname === "/forecast") return { body: FORECAST_BODY };
    return null;
  });
  const weather = createWeatherIntegration({
    fetch,
    endpoints: { geo: stub.base + "/geo", forecast: stub.base + "/forecast", reverseGeo: stub.base + "/reverse" },
    clock: () => 1_700_000_000_000,
  });

  const res = await weather.getWeather("上海");
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.city, "上海");
  assert.equal(res.value.country, "中国");
  assert.equal(res.value.current.temp, 21);
  assert.equal(res.value.current.feels, 19);
  assert.equal(res.value.current.humidity, 71);
  assert.equal(res.value.current.wind, 13);
  assert.deepEqual(res.value.current.text, "小雨");
  assert.equal(res.value.current.icon, "🌦️");
  assert.equal(res.value.daily.length, 2);
  assert.equal(res.value.daily[0].max, 24);
  assert.equal(res.value.daily[1].text, "雷阵雨");
  assert.equal(res.value.daily[1].pop, 80);
  assert.equal(res.cached, false);

  const again = await weather.getWeather("上海");
  assert.equal(again.cached, true, "15 分钟内命中缓存");
  assert.deepEqual(calls, ["/geo", "/forecast"], "缓存命中不得再发请求");

  const en = await weather.getWeather("Shanghai", "en-US");
  assert.equal(en.value.current.text, "Light rain", "en-US 走 WMO_EN");
});

test("天气：空城市 / 找不到城市 / 无效坐标 → 结构化错误；逆地理失败不影响预报", async () => {
  const stub = await startStub((url) => {
    if (url.pathname === "/geo") return { body: { results: [] } };
    if (url.pathname === "/geo-ok") return { body: { results: [{ latitude: 1, longitude: 2, name: "OK", country: "C" }] } };
    if (url.pathname === "/forecast") return { body: FORECAST_BODY };
    if (url.pathname === "/reverse") return { status: 500 };
    return null;
  });
  const weather = createWeatherIntegration({
    fetch,
    endpoints: { geo: stub.base + "/geo", forecast: stub.base + "/forecast", reverseGeo: stub.base + "/reverse" },
    clock: () => 1,
  });
  assert.equal((await weather.getWeather("")).error, "INTEGRATION_INVALID_INPUT");
  const notFound = await weather.getWeather("不存在城");
  assert.equal(notFound.ok, false);
  assert.equal(notFound.error, "INTEGRATION_NOT_FOUND");
  assert.match(notFound.detail, /没找到城市/);
  assert.equal((await weather.getWeatherAt(999, 0)).error, "INTEGRATION_INVALID_INPUT");

  const at = await weather.getWeatherAt(31.23, 121.47);
  assert.equal(at.ok, true, JSON.stringify(at));
  assert.equal(at.value.city, "当前位置", "逆地理 500 时退回默认城市名");
});

test("天气：未注入 fetch → INTEGRATION_UNAVAILABLE，不假数据", async () => {
  const weather = createWeatherIntegration({});
  const res = await weather.getWeather("上海");
  assert.equal(res.ok, false);
  assert.equal(res.error, "INTEGRATION_UNAVAILABLE");
  assert.match(res.detail, /fetch/);
  assert.equal(desc(999).text, "未知");
});

// ── ② 黄历解析 ────────────────────────────────────────────────────────────
function holidayDays(year) {
  const days = [];
  for (let month = 1; month <= 12; month += 1) {
    for (const day of [1, 10, 20]) {
      days.push({ date: year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0"), lunar_month_name: "冬月", lunar_day_name: "初一", solar_term: "" });
    }
  }
  return days;
}

test("黄历：本地 stub 按年解析、落缓存，当天再次查询命中缓存（离线）", async () => {
  const calls = [];
  const stub = await startStub((url) => {
    calls.push(url.searchParams.get("year"));
    return { body: { days: holidayDays(Number(url.searchParams.get("year"))) } };
  });
  const cacheDir = path.join(tempDir(), "calendar-almanac");
  const fixed = Date.UTC(2026, 0, 1, 4, 0, 0);
  const almanac = createAlmanacIntegration({ fetch, source: stub.base + "/holiday", cacheDir, clock: () => fixed });

  const res = await almanac.onlineCalendarYears([2024, 2024, 2025]);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.length, 2, "年份去重");
  assert.equal(res.value[0].year, 2024);
  assert.equal(res.value[0].cached, false);
  assert.equal(res.value[0].stale, false);
  assert.equal(res.value[0].days.length, 36);
  assert.ok(fs.existsSync(path.join(cacheDir, "2024.json")));

  calls.length = 0;
  const again = await almanac.onlineCalendarYears([2024]);
  assert.equal(again.value[0].cached, true, "当天新鲜必须复用缓存");
  assert.deepEqual(calls, [], "缓存命中不得再发请求");
  const cached = JSON.parse(fs.readFileSync(path.join(cacheDir, "2024.json"), "utf8"));
  assert.equal(cached.version, 1);
  assert.equal(cached.year, 2024);
});

test("黄历：年份参数校验、请求失败退回 stale 缓存、无缓存时结构化不可用", async () => {
  const cacheDir = path.join(tempDir(), "almanac");
  const fixed = Date.UTC(2026, 0, 1, 4, 0, 0);
  const dead = createAlmanacIntegration({ fetch, source: "http://127.0.0.1:1/holiday", cacheDir, clock: () => fixed });

  assert.equal((await dead.onlineCalendarYears([])).error, "INTEGRATION_INVALID_INPUT");
  assert.equal((await dead.onlineCalendarYears([2024, 2025, 2026, 2027])).error, "INTEGRATION_INVALID_INPUT");
  assert.equal((await dead.onlineCalendarYears([1800])).error, "INTEGRATION_INVALID_INPUT");

  // 手工放一份"昨天"的缓存 → 远端不可达时应退回 stale。
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "2024.json"), JSON.stringify({ version: 1, source: "stub", year: 2024, fetchedAt: 1, fetchedDay: "1999-01-01", days: holidayDays(2024) }), "utf8");
  const stale = await dead.onlineCalendarYears([2024]);
  assert.equal(stale.ok, true, JSON.stringify(stale));
  assert.equal(stale.value[0].cached, true);
  assert.equal(stale.value[0].stale, true);

  const noCache = createAlmanacIntegration({ fetch, source: "http://127.0.0.1:1/holiday", cacheDir: path.join(tempDir(), "empty"), clock: () => fixed });
  const failed = await noCache.onlineCalendarYears([2025]);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "INTEGRATION_UNAVAILABLE");

  const noFetch = createAlmanacIntegration({ cacheDir });
  const blocked = await noFetch.onlineCalendarYears([2024]);
  assert.equal(blocked.error, "INTEGRATION_UNAVAILABLE");
  assert.match(blocked.detail, /fetch/);
});

test("黄历：远端返回不足 28 天视为失败（源 calendarAlmanac.ts:85-87）", async () => {
  const stub = await startStub(() => ({ body: { days: holidayDays(2024).slice(0, 3) } }));
  const almanac = createAlmanacIntegration({ fetch, source: stub.base + "/holiday", cacheDir: path.join(tempDir(), "short"), clock: () => Date.UTC(2026, 0, 1) });
  const res = await almanac.onlineCalendarYears([2024]);
  assert.equal(res.ok, false);
  assert.equal(res.error, "INTEGRATION_UNAVAILABLE");
});
