/**
 * B7c · 天气可选插件（逐函数移植 server/weather.ts:1-128）。
 *
 * 逐函数对应：
 *   weather.ts:12-30   WMO / WMO_EN 映射表（逐字）
 *   weather.ts:31-34   desc(code, locale)
 *   weather.ts:44      cache（Map + 15 分钟 TTL）
 *   weather.ts:46-54   fetchJson（AbortController + 12 秒超时）
 *   weather.ts:56-81   weatherAt（当前 + 未来 7 天）
 *   weather.ts:84-99   getWeather（地理编码 → 预报，中文/英文城市名）
 *   weather.ts:102-128 getWeatherAt（经纬度 + 逆地理编码，逆地理失败不影响预报）
 *
 * 与源文件的差异（任务书硬要求）：
 *   · **网络一律经注入 fetch**；未注入即结构化 { ok:false, error:"INTEGRATION_UNAVAILABLE", detail }，
 *     函数不再 throw（源 weather.ts 用 throw），保证 IPC 出口恒为同一形状；
 *   · 三个远端地址可被 endpoints 覆盖（测试指向本地 127.0.0.1 stub，离线可跑）。
 *
 * OUT（不引入）：任何 api.dx-os.com / 云端实时房间 / 远端更新。
 */
"use strict";

const { INTEGRATION_ERR_UNAVAILABLE, INTEGRATION_ERR_INVALID_INPUT } = require("./plugin-registry.cjs");

const DEFAULT_ENDPOINTS = Object.freeze({
  geo: "https://geocoding-api.open-meteo.com/v1/search",
  reverseGeo: "https://nominatim.openstreetmap.org/reverse",
  forecast: "https://api.open-meteo.com/v1/forecast",
});

// weather.ts:12-22 逐字搬运
const WMO = {
  0: ["晴", "☀️"], 1: ["晴间多云", "🌤️"], 2: ["多云", "⛅"], 3: ["阴", "☁️"],
  45: ["雾", "🌫️"], 48: ["冻雾", "🌫️"],
  51: ["小雨", "🌦️"], 53: ["小雨", "🌦️"], 55: ["小雨", "🌧️"], 56: ["冻雨", "🌧️"], 57: ["冻雨", "🌧️"],
  61: ["小雨", "🌦️"], 63: ["中雨", "🌧️"], 65: ["大雨", "🌧️"], 66: ["冻雨", "🌧️"], 67: ["冻雨", "🌧️"],
  71: ["小雪", "🌨️"], 73: ["中雪", "🌨️"], 75: ["大雪", "❄️"], 77: ["雪粒", "🌨️"],
  80: ["阵雨", "🌦️"], 81: ["阵雨", "🌧️"], 82: ["强阵雨", "⛈️"],
  85: ["阵雪", "🌨️"], 86: ["强阵雪", "❄️"],
  95: ["雷阵雨", "⛈️"], 96: ["雷阵雨，局地冰雹", "⛈️"], 99: ["强雷雨，局地冰雹", "⛈️"],
};
// weather.ts:23-30 逐字搬运
const WMO_EN = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Heavy freezing drizzle",
  61: "Light rain", 63: "Moderate rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Heavy freezing rain",
  71: "Light snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Rain showers", 81: "Rain showers", 82: "Heavy rain showers", 85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Heavy thunderstorm with hail",
};

/** weather.ts:31-34 逐字移植。 */
function desc(code, locale) {
  const mapped = WMO[code] || ["未知", "🌡️"];
  return { text: locale === "en-US" ? WMO_EN[code] || "Unknown" : mapped[0], icon: mapped[1] };
}

function createWeatherIntegration(options = {}) {
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const endpoints = Object.assign({}, DEFAULT_ENDPOINTS, options.endpoints && typeof options.endpoints === "object" ? options.endpoints : {});
  const ttl = Number.isFinite(options.ttlMs) ? Number(options.ttlMs) : 15 * 60 * 1000;
  const timeout = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 12000;
  const cache = new Map();
  const localeText = (locale, zh, en) => (locale === "en-US" ? en : zh);

  /** weather.ts:46-54：超时 + 非 2xx 抛错；这里把错误留成 throw，由调用方转结构化。 */
  async function fetchJson(url, headers = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const response = await fetchImpl(url, { headers: { "User-Agent": "DX-OS/0.1 weather", ...headers }, signal: ctrl.signal });
      if (!response || response.ok !== true) throw new Error("Weather service returned HTTP " + (response && response.status));
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  /** weather.ts:56-81 逐函数移植。 */
  async function weatherAt(latitude, longitude, city, country, locale) {
    const query = endpoints.forecast + "?latitude=" + latitude + "&longitude=" + longitude +
      "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7";
    const forecast = await fetchJson(query);
    const current = (forecast && forecast.current) || {};
    const daily = (forecast && forecast.daily) || {};
    const currentDesc = desc(Number(current.weather_code), locale);
    return {
      city,
      country,
      current: {
        temp: Math.round(Number(current.temperature_2m)),
        feels: Math.round(Number(current.apparent_temperature)),
        humidity: Math.round(Number(current.relative_humidity_2m)),
        wind: Math.round(Number(current.wind_speed_10m)),
        code: Number(current.weather_code), text: currentDesc.text, icon: currentDesc.icon,
      },
      daily: (daily.time || []).map((date, index) => {
        const code = Number(daily.weather_code && daily.weather_code[index]);
        const mapped = desc(code, locale);
        return {
          date,
          max: Math.round(Number(daily.temperature_2m_max && daily.temperature_2m_max[index])),
          min: Math.round(Number(daily.temperature_2m_min && daily.temperature_2m_min[index])),
          pop: Math.round(Number((daily.precipitation_probability_max && daily.precipitation_probability_max[index]) || 0)),
          code, text: mapped.text, icon: mapped.icon,
        };
      }),
      updatedTs: clock(),
    };
  }

  function unavailable(detail) { return { ok: false, error: INTEGRATION_ERR_UNAVAILABLE, detail }; }

  /** weather.ts:84-99 逐函数移植（失败从 throw 改成结构化返回）。 */
  async function getWeather(city, locale = "zh-CN") {
    if (typeof fetchImpl !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），天气不可用");
    const key = String(city == null ? "" : city).trim();
    if (!key) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: localeText(locale, "请输入城市", "A city is required") };
    const cacheKey = locale + ":" + key;
    const hit = cache.get(cacheKey);
    if (hit && clock() - hit.ts < ttl) return { ok: true, value: hit.data, cached: true };
    try {
      const geoLanguage = locale === "en-US" ? "en" : "zh";
      const geo = await fetchJson(endpoints.geo + "?name=" + encodeURIComponent(key) + "&count=1&language=" + geoLanguage + "&format=json");
      const location = geo && geo.results && geo.results[0];
      if (!location) return { ok: false, error: "INTEGRATION_NOT_FOUND", detail: localeText(locale, "没找到城市「" + key + "」", 'City not found: "' + key + '"') };
      const data = await weatherAt(Number(location.latitude), Number(location.longitude), location.name || key, location.country, locale);
      cache.set(cacheKey, { data, ts: clock() });
      return { ok: true, value: data, cached: false };
    } catch (error) {
      return { ok: false, error: INTEGRATION_ERR_UNAVAILABLE, detail: String((error && error.message) || error).slice(0, 300) };
    }
  }

  /** weather.ts:102-128 逐函数移植（失败从 throw 改成结构化返回）。 */
  async function getWeatherAt(latitude, longitude, locale = "zh-CN") {
    if (typeof fetchImpl !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），天气不可用");
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: localeText(locale, "无效的位置坐标", "Invalid location coordinates") };
    }
    const cacheKey = locale + ":coords:" + latitude.toFixed(2) + "," + longitude.toFixed(2);
    const hit = cache.get(cacheKey);
    if (hit && clock() - hit.ts < ttl) return { ok: true, value: hit.data, cached: true };
    let city = localeText(locale, "当前位置", "Current Location");
    let country;
    try {
      const language = locale === "en-US" ? "en" : "zh-CN,zh,en";
      const reverse = await fetchJson(
        endpoints.reverseGeo + "?lat=" + encodeURIComponent(latitude) + "&lon=" + encodeURIComponent(longitude) + "&format=jsonv2&zoom=10&addressdetails=1",
        { "Accept-Language": language },
      );
      const address = (reverse && reverse.address) || {};
      city = address.city || address.municipality || address.town || address.county || address.village || city;
      country = address.country;
    } catch {
      // weather.ts:121-123：逆地理是可选服务，失败不影响预报。
    }
    try {
      const data = await weatherAt(latitude, longitude, city, country, locale);
      cache.set(cacheKey, { data, ts: clock() });
      return { ok: true, value: data, cached: false };
    } catch (error) {
      return { ok: false, error: INTEGRATION_ERR_UNAVAILABLE, detail: String((error && error.message) || error).slice(0, 300) };
    }
  }

  return { endpoints, getWeather, getWeatherAt, desc, clearCache: () => cache.clear(), cacheSize: () => cache.size };
}

module.exports = { createWeatherIntegration, desc, WMO, WMO_EN, DEFAULT_ENDPOINTS };
