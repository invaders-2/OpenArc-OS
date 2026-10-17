/**
 * 天气数据的共享读取（0.6.1 · 桌面小组件复用天气应用的数据源与偏好键）。
 *
 * 单一事实来源：
 *   · 偏好键沿用天气应用既有的 localStorage：oa-weather-consent / oa-weather-cities；
 *   · 请求仍然走主进程的 weather:forecast（渲染层 CSP 禁止出网）；
 *   · 天气代码 → 中文/图标只在这里维护一份，天气应用与小组件共用。
 *
 * 没有开启联网、没有城市、或没有原生桥时，调用方必须显示真实空态；本模块不发请求。
 */
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Moon,
  Sun,
} from "lucide-vue-next";

export const WEATHER_CONSENT_KEY = "oa-weather-consent";
export const WEATHER_CITIES_KEY = "oa-weather-cities";

export type WeatherCity = { name: string; admin?: string; country?: string; lat: number; lon: number };
export type WeatherHour = { time: string; temp: number | null; code: number | null; pop: number | null };
export type WeatherDay = { date: string; code: number | null; max: number | null; min: number | null; pop: number | null; sunrise: string; sunset: string };
export type WeatherForecast = {
  current: { temp: number | null; feels: number | null; humidity: number | null; code: number | null; wind: number | null; isDay: boolean; time: string };
  hourly: WeatherHour[];
  daily: WeatherDay[];
};

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function readWeatherConsent(): boolean {
  return readJson<boolean>(WEATHER_CONSENT_KEY) === true;
}

export function readWeatherCities(): WeatherCity[] {
  const value = readJson<WeatherCity[]>(WEATHER_CITIES_KEY);
  if (!Array.isArray(value)) return [];
  return value.filter(
    (city): city is WeatherCity =>
      !!city && typeof city === "object" && typeof city.name === "string" && Number.isFinite(city.lat) && Number.isFinite(city.lon),
  );
}

export const weatherKey = (city: WeatherCity): string => city.lat.toFixed(3) + "," + city.lon.toFixed(3);

/** WMO 天气代码 → 中文 + 图标（与天气应用同一口径）。 */
export function wmo(code: number | null, day = true): { text: string; icon: unknown } {
  const c = code ?? -1;
  if (c === 0) return { text: "晴", icon: day ? Sun : Moon };
  if (c <= 2) return { text: c === 1 ? "大部晴朗" : "局部多云", icon: CloudSun };
  if (c === 3) return { text: "阴", icon: Cloud };
  if (c === 45 || c === 48) return { text: "雾", icon: CloudFog };
  if (c >= 51 && c <= 57) return { text: "毛毛雨", icon: CloudDrizzle };
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) {
    return { text: c >= 65 || c === 82 ? "大雨" : c === 61 || c === 80 ? "小雨" : "中雨", icon: CloudRain };
  }
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { text: "雪", icon: CloudSnow };
  if (c >= 95) return { text: "雷阵雨", icon: CloudLightning };
  return { text: "—", icon: Cloud };
}

export const deg = (value: number | null): string => (value === null || value === undefined ? "—" : Math.round(value) + "°");

/** 只有在「有桥 + 已同意联网 + 有城市」时才会真正请求；否则返回 null，不伪造结果。 */
export async function requestForecast(city: WeatherCity | null): Promise<WeatherForecast | null> {
  if (!city) return null;
  const bridge = typeof window === "undefined" ? undefined : window.openarc?.weather;
  if (!bridge || !readWeatherConsent()) return null;
  const reply = await bridge.forecast(city.lat, city.lon).catch(() => null);
  return reply && reply.ok ? (reply as WeatherForecast & { ok: true }) : null;
}
