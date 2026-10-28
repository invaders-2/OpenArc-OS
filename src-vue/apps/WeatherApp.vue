<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ChevronDown, Globe, Plus, RefreshCw, Search, X } from "lucide-vue-next";
import { iconUrl } from "../apps";
import { WEATHER_CITIES_KEY, WEATHER_CONSENT_KEY, deg, readWeatherCities, readWeatherConsent, wmo, type WeatherCity } from "./weatherShared";

/**
 * 天气（10-15）：数据来自 Open-Meteo，经主进程取（渲染层 CSP 禁止出网）。
 * 第一次使用必须由用户明确开启联网；开启前不发任何请求，也不显示示例温度。
 * 城市列表存本机 localStorage「oa-weather-cities」。
 */
/** 与桌面小组件共用的类型/偏好键/天气码映射都在 weatherShared；这里只保留请求与视图状态。 */
type City = WeatherCity;
type Hour = { time: string; temp: number | null; code: number | null; pop: number | null };
type Day = { date: string; code: number | null; max: number | null; min: number | null; pop: number | null; sunrise: string; sunset: string };
type Fc = { current: { temp: number | null; feels: number | null; humidity: number | null; code: number | null; wind: number | null; isDay: boolean; time: string }; hourly: Hour[]; daily: Day[] };

const bridge = window.openarc?.weather;
const CONSENT = WEATHER_CONSENT_KEY;
const CITIES = WEATHER_CITIES_KEY;
const save = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* 存储不可用 */
  }
};

const consent = ref<boolean>(readWeatherConsent());
const cities = ref<City[]>(readWeatherCities());
const idx = ref(0);
const fc = ref<Record<string, Fc>>({});
const loading = ref(false);
const error = ref("");
const adding = ref(false);
const query = ref("");
const results = ref<City[]>([]);
const searching = ref(false);

const key = (c: City) => `${c.lat.toFixed(3)},${c.lon.toFixed(3)}`;
const city = computed(() => cities.value[idx.value] ?? null);
const data = computed(() => (city.value ? fc.value[key(city.value)] ?? null : null));

const ERR: Record<string, string> = { TIMEOUT: "请求超时", NETWORK: "网络不可用", INVALID_INPUT: "参数无效" };
const errText = (e?: string) => (e ? ERR[e] ?? (e.startsWith("UPSTREAM_") ? "天气服务暂时不可用" : e) : "请求失败");

async function refresh(c = city.value) {
  if (!bridge || !c || !consent.value) return;
  loading.value = true;
  error.value = "";
  const r = await bridge.forecast(c.lat, c.lon).catch(() => null);
  loading.value = false;
  if (r?.ok) fc.value = { ...fc.value, [key(c)]: r };
  else error.value = errText(r?.error);
}
async function refreshAll() {
  for (const c of cities.value) await refresh(c);
}
function enable() {
  consent.value = true;
  save(CONSENT, true);
  if (!cities.value.length) adding.value = true;
  void refreshAll();
}
function disable() {
  consent.value = false;
  save(CONSENT, false);
  fc.value = {};
}

let t = 0;
function onQuery() {
  window.clearTimeout(t);
  t = window.setTimeout(async () => {
    const q = query.value.trim();
    if (!q || !bridge) return void (results.value = []);
    searching.value = true;
    const r = await bridge.geocode(q).catch(() => null);
    searching.value = false;
    results.value = r?.ok ? r.items : [];
    if (!r?.ok) error.value = errText(r?.error);
  }, 350);
}
function addCity(c: City) {
  if (!cities.value.some((x) => key(x) === key(c))) cities.value.push(c);
  save(CITIES, cities.value);
  idx.value = cities.value.findIndex((x) => key(x) === key(c));
  adding.value = false;
  query.value = "";
  results.value = [];
  void refresh(c);
}
function removeCity(i: number) {
  cities.value.splice(i, 1);
  save(CITIES, cities.value);
  idx.value = Math.min(idx.value, Math.max(0, cities.value.length - 1));
}

/* 天气码映射与 deg() 已抽到 weatherShared.ts，与桌面小组件共用同一口径。 */
const hours = computed(() => {
  const d = data.value;
  if (!d) return [];
  const start = Math.max(0, d.hourly.findIndex((h) => h.time >= d.current.time.slice(0, 13)));
  return d.hourly.slice(start, start + 24);
});
const range = computed(() => {
  const ds = data.value?.daily ?? [];
  const mins = ds.map((d) => d.min ?? 0);
  const maxs = ds.map((d) => d.max ?? 0);
  return { lo: Math.min(...mins), hi: Math.max(...maxs) };
});
const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const dayLabel = (s: string, i: number) => (i === 0 ? "今天" : WEEK[new Date(s + "T00:00").getDay()]);
const hourLabel = (s: string, i: number) => (i === 0 ? "现在" : `${s.slice(11, 13)}时`);

onMounted(() => {
  if (consent.value) void refreshAll();
});
</script>

<template>
  <div class="weather-app" data-weather-app :data-weather-consent="consent ? 'on' : 'off'">
    <div class="wx-bg" aria-hidden="true" />

    <div v-if="!bridge" class="wx-empty">
      <img class="large-icon" :src="iconUrl('weather')" alt="" draggable="false" />
      <p>天气只在 OpenArc 桌面应用里可用。</p>
    </div>

    <div v-else-if="!consent" class="wx-empty">
      <img class="large-icon" :src="iconUrl('weather')" alt="" draggable="false" />
      <h2 class="planned-title">开启天气</h2>
      <p>天气需要联网：OpenArc 会把你添加的城市名或经纬度发给 Open-Meteo 查询预报，不发送任何账号信息。</p>
      <button class="planned-cta" @click="enable">开启并联网</button>
    </div>

    <template v-else>
      <div class="wx-top">
        <details class="wx-city-menu" data-weather-city-menu>
          <summary class="wx-city-btn" data-weather-city><Globe :size="13" /><span>{{ city?.name ?? "选择城市" }}</span><ChevronDown :size="12" /></summary>
          <div class="wx-city-pop">
            <button v-for="(c, i) in cities" :key="key(c)" type="button" class="wx-city-option" :class="{ on: i === idx }" @click="idx = i; adding = false">
              <span>{{ c.name }}</span>
              <small>{{ consent && fc[key(c)] ? deg(fc[key(c)].current.temp) : "" }}</small>
            </button>
            <button type="button" class="wx-city-option" :disabled="!consent" @click="adding = true"><Plus :size="13" /> 添加城市</button>
            <button type="button" class="wx-city-option" @click="disable">停止联网</button>
          </div>
        </details>
      </div>

      <div class="wx-scroll">
        <div v-if="adding || !city" class="wx-add" data-weather-add>
          <label class="ds-search wx-search">
            <Search class="ds-search__icon" :size="13" />
            <input v-model="query" class="ds-search__input" type="search" placeholder="输入城市名，例如 上海" aria-label="搜索城市" autofocus @input="onQuery" />
          </label>
          <p v-if="searching" class="wx-note">正在搜索…</p>
          <button v-for="r in results" :key="key(r)" type="button" class="wx-result" @click="addCity(r)">
            <strong>{{ r.name }}</strong>
            <small>{{ [r.admin, r.country].filter(Boolean).join(" · ") }}</small>
          </button>
          <p v-if="!searching && query && !results.length" class="wx-note">没有找到匹配的城市。</p>
          <button type="button" class="wx-cancel" @click="adding = false">返回天气</button>
        </div>

        <template v-else-if="data">
          <section class="wx-hero" data-weather-current>
            <div class="wx-city-name">{{ city.name }}</div>
            <div class="wx-temp" data-weather-temp>{{ deg(data.current.temp) }}</div>
            <div class="wx-desc">{{ wmo(data.current.code, data.current.isDay).text }}</div>
            <div class="wx-hilo">最高 {{ deg(data.daily[0]?.max ?? null) }} 最低 {{ deg(data.daily[0]?.min ?? null) }}</div>
            <div class="wx-src">Open-Meteo</div>
            <button type="button" class="wx-refresh" :disabled="loading" aria-label="刷新天气" title="刷新天气" @click="refresh()"><RefreshCw :size="14" :class="{ 'wx-spin': loading }" /></button>
          </section>

          <section class="wx-card" data-weather-hours>
            <div class="wx-card-title">接下来 12 小时 · {{ wmo(data.current.code, data.current.isDay).text }}</div>
            <div class="wx-hours">
              <div v-for="(h, i) in hours.slice(0, 12)" :key="h.time" class="wx-hour" data-weather-hour>
                <span class="wx-hour-label">{{ hourLabel(h.time, i) }}</span>
                <component :is="wmo(h.code).icon" :size="19" />
                <b class="wx-hour-temp">{{ deg(h.temp) }}</b>
              </div>
            </div>
          </section>

          <section class="wx-card wx-week" data-weather-week>
            <div class="wx-card-title">7 日预报</div>
            <div v-for="(d, i) in data.daily" :key="d.date" class="wx-day wx-week-row" data-weather-week-row>
              <span class="wx-day-name">{{ dayLabel(d.date, i) }}</span>
              <component :is="wmo(d.code).icon" :size="18" />
              <span class="wx-day-min">{{ deg(d.min) }}</span>
              <span class="wx-bar"><span class="wx-bar-fill" :style="{ left: (((d.min ?? 0) - range.lo) / Math.max(1, range.hi - range.lo)) * 100 + '%', right: 100 - (((d.max ?? 0) - range.lo) / Math.max(1, range.hi - range.lo)) * 100 + '%' }" /></span>
              <span class="wx-day-max">{{ deg(d.max) }}</span>
            </div>
          </section>
        </template>

        <div v-else class="wx-status" data-weather-status>
          <p>{{ loading ? "正在获取天气…" : error || "暂无数据" }}</p>
          <button v-if="error && !loading" type="button" class="wx-retry" @click="refresh()">重试</button>
        </div>
      </div>
    </template>
  </div>
</template>
<style scoped>
/* task-11：全窗天气卡片 · 中性灰阶渐变（规范优先，不用蓝色） */
.weather-app { position: relative; height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--text); }
.wx-bg { position: absolute; inset: 0; background: linear-gradient(180deg, rgb(var(--text-rgb) / 0.16) 0%, rgb(var(--text-rgb) / 0.07) 48%, rgb(var(--text-rgb) / 0.02) 100%); pointer-events: none; }
.wx-top { position: relative; z-index: 1; flex: none; display: flex; justify-content: flex-end; padding: 14px 16px 0; }
.wx-city-menu { position: relative; }
.wx-city-menu > summary { list-style: none; }
.wx-city-menu > summary::-webkit-details-marker { display: none; }
.wx-city-btn { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 12px; border-radius: var(--radius-pill); background: rgb(var(--content-rgb) / 0.5); font-size: var(--fs-caption); }
.wx-city-pop { position: absolute; right: 0; top: calc(100% + 6px); z-index: 10; min-width: 180px; padding: 6px; display: flex; flex-direction: column; gap: 2px; border-radius: var(--radius-lg); background: rgb(var(--content-rgb) / 0.98); box-shadow: var(--elevation-2); }
.wx-city-option { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; border-radius: var(--radius-md); text-align: left; font-size: var(--fs-caption); }
.wx-city-option:hover { background: var(--row-hover); }
.wx-city-option.on { background: rgb(var(--text-rgb) / 0.08); font-weight: var(--fw-medium); }
.wx-city-option small { color: var(--muted); }
.wx-scroll { position: relative; z-index: 1; flex: 1; min-height: 0; overflow: auto; padding: 0 36px 20px; display: flex; flex-direction: column; gap: 11px; }
.wx-hero { position: relative; flex: none; text-align: center; padding: 15px 0 4px; }
.wx-city-name { font-size: 26px; line-height: 1.2; }
.wx-temp { font-size: 84px; font-weight: 200; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.wx-desc { font-size: var(--fs-body); }
.wx-hilo { font-size: var(--fs-caption); color: var(--muted); margin-top: 2px; }
.wx-src { font-size: 10px; color: var(--muted); opacity: 0.7; margin-top: 3px; }
.wx-refresh { position: absolute; right: 4px; top: 8px; width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--radius-pill); color: var(--muted); }
.wx-refresh:hover { background: rgb(var(--text-rgb) / 0.08); color: var(--text); }
.wx-card { flex: none; padding: 14px 16px 16px; border-radius: var(--radius-lg); background: rgb(var(--content-rgb) / 0.45); }
.wx-card-title { font-size: var(--fs-caption); color: var(--muted); margin-bottom: 8px; }
.wx-hours { display: grid; grid-template-columns: repeat(12, 36px); justify-content: space-between; gap: 4px; padding-top: 10px; }
.wx-hour { display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 3px 0; font-size: var(--fs-micro); color: var(--text); }
.wx-hour-label { color: var(--muted); white-space: nowrap; }
.wx-hour-temp { font-weight: var(--fw-regular); font-variant-numeric: tabular-nums; }
.wx-week { display: flex; flex-direction: column; gap: 2px; padding-top: 12px; }
.wx-week .wx-card-title { margin-bottom: 0; }
.wx-day { display: grid; grid-template-columns: 42px 20px 38px minmax(0, 1fr) 38px; align-items: center; gap: 8px; height: 33.6px; font-size: var(--fs-caption); }
.wx-day-name { color: var(--text); }
.wx-day-min { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
.wx-day-max { text-align: right; font-variant-numeric: tabular-nums; }
.wx-bar { position: relative; height: 5px; border-radius: 999px; background: rgb(var(--text-rgb) / 0.12); overflow: hidden; }
.wx-bar-fill { position: absolute; top: 0; bottom: 0; border-radius: 999px; background: rgb(var(--text-rgb) / 0.55); }
.wx-add { display: flex; flex-direction: column; gap: 8px; padding-top: 18px; }
.wx-search { width: 100%; }
.wx-note { margin: 0; color: var(--muted); font-size: var(--fs-caption); }
.wx-result { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: var(--radius-md); text-align: left; background: rgb(var(--content-rgb) / 0.4); }
.wx-result small { color: var(--muted); font-size: var(--fs-micro); }
.wx-cancel { align-self: flex-start; height: 26px; padding: 0 10px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.07); font-size: var(--fs-caption); }
.wx-status { margin: auto; text-align: center; color: var(--muted); font-size: var(--fs-secondary); }
.wx-retry { margin-top: 8px; height: 28px; padding: 0 12px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.08); color: var(--text); font-size: var(--fs-caption); }
.wx-empty { position: relative; z-index: 1; flex: 1; margin: auto; max-width: 460px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--muted); padding: 24px; }
.wx-empty h2 { margin: 0; color: var(--text); }
.wx-empty p { margin: 0; font-size: var(--fs-secondary); line-height: var(--lh-relaxed); }



.wx-hour { width: 36px; }

.wx-hour { width: 36px !important; max-width: 36px; min-width: 0; justify-self: start; box-sizing: border-box; }
</style>
