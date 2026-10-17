<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Plus, RefreshCw, Search, X } from "lucide-vue-next";
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
  <div class="split weather-app">
    <nav class="split-side" aria-label="城市">
      <div class="split-section">城市</div>
      <button
        v-for="(c, i) in cities"
        :key="key(c)"
        type="button"
        class="notes-item wx-city"
        :aria-current="i === idx && !adding ? 'true' : undefined"
        @click="idx = i; adding = false"
      >
        <span class="wx-city-row">
          <span class="notes-item-name">{{ c.name }}</span>
          <span class="wx-city-temp">{{ consent && fc[key(c)] ? deg(fc[key(c)].current.temp) : "" }}</span>
        </span>
        <small>{{ [c.admin, c.country].filter(Boolean).join(" · ") }}</small>
        <span class="wx-del" role="button" :aria-label="'移除 ' + c.name" @click.stop="removeCity(i)"><X :size="11" /></span>
      </button>
      <button type="button" class="split-nav" :disabled="!consent" @click="adding = true"><Plus :size="14" /> <span class="split-nav-label">添加城市</span></button>
      <p class="planned-note">
        数据来自 Open-Meteo。
        <a v-if="consent" href="#" class="wx-link" @click.prevent="disable">停止联网</a>
      </p>
    </nav>

    <div class="split-main wx-main">
      <div class="pane-toolbar">
        <strong class="pane-title">{{ adding ? "添加城市" : city?.name ?? "天气" }}</strong>
        <div class="toolbar-spacer" />
        <span v-if="error" class="chat-error wx-err">{{ error }}</span>
        <button v-if="consent && city && !adding" class="icon-button" aria-label="刷新" title="刷新" :disabled="loading" @click="refresh()">
          <RefreshCw :size="14" :class="{ 'wx-spin': loading }" />
        </button>
      </div>

      <!-- 未开启联网 -->
      <div v-if="!bridge" class="empty-content">
        <img class="large-icon" :src="iconUrl('weather')" alt="" draggable="false" />
        <p>天气只在 OpenArc 桌面应用里可用。</p>
      </div>
      <div v-else-if="!consent" class="empty-content">
        <img class="large-icon" :src="iconUrl('weather')" alt="" draggable="false" />
        <h2 class="planned-title">开启天气</h2>
        <p>天气需要联网：OpenArc 会把你添加的城市名或经纬度发给 Open-Meteo（open-meteo.com）查询预报，不发送任何账号信息。</p>
        <button class="planned-cta" @click="enable">开启并联网</button>
      </div>

      <!-- 添加城市 -->
      <div v-else-if="adding || !city" class="wx-add">
        <label class="ds-search wx-search">
          <Search class="ds-search__icon" :size="13" />
          <input v-model="query" class="ds-search__input" type="search" placeholder="输入城市名，例如 上海" aria-label="搜索城市" autofocus @input="onQuery" />
        </label>
        <p v-if="searching" class="planned-note">正在搜索…</p>
        <button v-for="r in results" :key="key(r)" type="button" class="wx-result" @click="addCity(r)">
          <strong>{{ r.name }}</strong>
          <small>{{ [r.admin, r.country].filter(Boolean).join(" · ") }}</small>
        </button>
        <p v-if="!searching && query && !results.length" class="planned-note">没有找到匹配的城市。</p>
      </div>

      <!-- 预报 -->
      <div v-else-if="data" class="wx-body">
        <section class="wx-now">
          <component :is="wmo(data.current.code, data.current.isDay).icon" :size="44" class="wx-now-icon" />
          <div>
            <div class="wx-now-temp">{{ deg(data.current.temp) }}</div>
            <div class="wx-now-text">
              {{ wmo(data.current.code, data.current.isDay).text }} · 最高 {{ deg(data.daily[0]?.max ?? null) }} 最低 {{ deg(data.daily[0]?.min ?? null) }}
            </div>
          </div>
          <dl class="wx-facts">
            <div><dt>体感</dt><dd>{{ deg(data.current.feels) }}</dd></div>
            <div><dt>湿度</dt><dd>{{ data.current.humidity ?? "—" }}%</dd></div>
            <div><dt>风速</dt><dd>{{ data.current.wind ?? "—" }} km/h</dd></div>
            <div><dt>日出 / 日落</dt><dd>{{ data.daily[0]?.sunrise.slice(11) }} / {{ data.daily[0]?.sunset.slice(11) }}</dd></div>
          </dl>
        </section>
        <section class="wx-card">
          <div class="split-section">未来 24 小时</div>
          <div class="wx-hours">
            <div v-for="(h, i) in hours" :key="h.time" class="wx-hour">
              <small>{{ hourLabel(h.time, i) }}</small>
              <component :is="wmo(h.code).icon" :size="18" />
              <span>{{ deg(h.temp) }}</span>
              <small class="wx-pop">{{ h.pop ? h.pop + "%" : "" }}</small>
            </div>
          </div>
        </section>
        <section class="wx-card">
          <div class="split-section">7 日预报</div>
          <div v-for="(d, i) in data.daily" :key="d.date" class="wx-day">
            <span class="wx-day-name">{{ dayLabel(d.date, i) }}</span>
            <component :is="wmo(d.code).icon" :size="17" />
            <small class="wx-pop">{{ d.pop ? d.pop + "%" : "" }}</small>
            <span class="wx-day-min">{{ deg(d.min) }}</span>
            <span class="wx-bar">
              <span
                class="wx-bar-fill"
                :style="{
                  left: (((d.min ?? 0) - range.lo) / Math.max(1, range.hi - range.lo)) * 100 + '%',
                  right: (100 - (((d.max ?? 0) - range.lo) / Math.max(1, range.hi - range.lo)) * 100) + '%',
                }"
              />
            </span>
            <span class="wx-day-max">{{ deg(d.max) }}</span>
          </div>
        </section>
      </div>
      <div v-else class="empty-content">
        <p>{{ loading ? "正在获取天气…" : error || "暂无数据" }}</p>
      </div>
    </div>
  </div>
</template>
