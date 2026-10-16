/**
 * 天气服务（10-15，「天气」应用用）。
 *
 * 数据源：Open-Meteo（免 key 公共接口）。设计约束：
 *   · 只访问两个固定主机（geocoding-api.open-meteo.com / api.open-meteo.com），URL 由本模块拼装，
 *     渲染进程只能给「城市名」或「经纬度」，拿不到任意出网能力；
 *   · 渲染层的 CSP 是 connect-src 'none'，所以出网只在主进程；
 *   · 是否联网由用户在天气应用里明确开启（渲染层的同意开关），本模块不缓存、不上报任何身份信息；
 *   · 返回值只挑需要的字段（数值 / 短字符串），超时 8s。
 */
"use strict";

const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT_MS = 8000;

function createWeatherService({ fetchImpl }) {
  async function getJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) return { ok: false, error: "UPSTREAM_" + res.status };
      return { ok: true, data: await res.json() };
    } catch (e) {
      return { ok: false, error: e && e.name === "AbortError" ? "TIMEOUT" : "NETWORK" };
    } finally {
      clearTimeout(timer);
    }
  }
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v, n = 80) => (typeof v === "string" ? v.slice(0, n) : "");
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);

  async function geocode(name) {
    const q = String(name ?? "").trim().slice(0, 60);
    if (!q) return { ok: false, error: "INVALID_INPUT" };
    const url = `${GEO}?name=${encodeURIComponent(q)}&count=8&language=zh&format=json`;
    const r = await getJson(url);
    if (!r.ok) return r;
    const items = arr(r.data && r.data.results, 8)
      .map((x) => ({
        name: str(x.name), admin: str(x.admin1), country: str(x.country),
        lat: num(x.latitude), lon: num(x.longitude), timezone: str(x.timezone, 40),
      }))
      .filter((x) => x.name && x.lat !== null && x.lon !== null);
    return { ok: true, items };
  }

  async function forecast(lat, lon) {
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return { ok: false, error: "INVALID_INPUT" };
    const url = `${FORECAST}?latitude=${la.toFixed(4)}&longitude=${lo.toFixed(4)}`
      + "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day"
      + "&hourly=temperature_2m,weather_code,precipitation_probability"
      + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset"
      + "&timezone=auto&forecast_days=7";
    const r = await getJson(url);
    if (!r.ok) return r;
    const d = r.data || {};
    const c = d.current || {};
    const h = d.hourly || {};
    const dy = d.daily || {};
    return {
      ok: true,
      timezone: str(d.timezone, 40),
      current: {
        time: str(c.time, 20), temp: num(c.temperature_2m), feels: num(c.apparent_temperature),
        humidity: num(c.relative_humidity_2m), code: num(c.weather_code), wind: num(c.wind_speed_10m), isDay: c.is_day === 1,
      },
      hourly: arr(h.time, 168).map((t, i) => ({
        time: str(t, 20), temp: num(arr(h.temperature_2m, 168)[i]), code: num(arr(h.weather_code, 168)[i]),
        pop: num(arr(h.precipitation_probability, 168)[i]),
      })),
      daily: arr(dy.time, 7).map((t, i) => ({
        date: str(t, 12), code: num(arr(dy.weather_code, 7)[i]), max: num(arr(dy.temperature_2m_max, 7)[i]),
        min: num(arr(dy.temperature_2m_min, 7)[i]), pop: num(arr(dy.precipitation_probability_max, 7)[i]),
        sunrise: str(arr(dy.sunrise, 7)[i], 20), sunset: str(arr(dy.sunset, 7)[i], 20),
      })),
    };
  }

  return { geocode, forecast };
}

module.exports = { createWeatherService, GEO, FORECAST };
