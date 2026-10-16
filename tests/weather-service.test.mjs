// 天气服务：只访问固定的 Open-Meteo 主机、参数校验、只回挑选过的字段。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createWeatherService } = require("../electron/weather-service.cjs");

function svc(body, seen = []) {
  return createWeatherService({ fetchImpl: async (url) => { seen.push(url); return { ok: true, json: async () => body }; } });
}

test("URL 只指向固定主机，城市名被编码", async () => {
  const seen = [];
  await svc({ results: [] }, seen).geocode("上海&x=1");
  await svc({}, seen).forecast(31.2, 121.4);
  assert.ok(seen[0].startsWith("https://geocoding-api.open-meteo.com/v1/search?name=%E4%B8%8A%E6%B5%B7%26x%3D1&"));
  assert.ok(seen[1].startsWith("https://api.open-meteo.com/v1/forecast?latitude=31.2000&longitude=121.4000&"));
});

test("非法输入不出网", async () => {
  const seen = [];
  const w = svc({}, seen);
  assert.equal((await w.geocode("  ")).error, "INVALID_INPUT");
  assert.equal((await w.forecast(91, 0)).error, "INVALID_INPUT");
  assert.equal((await w.forecast("x", 0)).error, "INVALID_INPUT");
  assert.equal(seen.length, 0);
});

test("只回挑选字段；上游错误如实返回", async () => {
  const r = await svc({ results: [{ name: "上海", latitude: 31.2, longitude: 121.4, secret: "x" }, { name: "坏数据" }] }).geocode("上海");
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].secret, undefined);
  const bad = createWeatherService({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal((await bad.forecast(1, 1)).error, "UPSTREAM_503");
  const down = createWeatherService({ fetchImpl: async () => { throw new Error("x"); } });
  assert.equal((await down.geocode("a")).error, "NETWORK");
});
