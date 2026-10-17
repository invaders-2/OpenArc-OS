<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Pause, Play, RefreshCw, SkipBack, SkipForward, Sparkles } from "lucide-vue-next";
import { useShellStore } from "../stores/shell";
import { locale, t } from "../i18n";
import { currentTrack, ensureLoaded, musicState, step, toggle } from "../apps/music-state";
import { deg, readWeatherCities, readWeatherConsent, requestForecast, wmo, type WeatherCity, type WeatherForecast } from "../apps/weatherShared";

/**
 * 桌面小组件（10-15 按界面原型新增，0.6.1 补音乐 / 天气）。
 *   - 日期：月 / 日 / 星期，跟随真实时间
 *   - 进行中的任务：任务引擎接入前如实显示空态，并给一个交给全局 AI 的入口
 *   - 音乐：复用访达音频数据源（files 桥 / 桌面与各文件夹），可直接播放 / 上一首 / 下一首。
 *           音乐应用的「音乐库」曲目目前没有可播放的字节出口，因此小组件只控制访达音频；
 *           两边播放器各自独立（音乐应用正由另一执行者重做，共享播放状态留给后续收口）。
 *   - 天气：与天气应用同一份偏好（oa-weather-consent / oa-weather-cities）与同一条 weather 桥；
 *           未开启联网 / 没有城市 / 没有数据时一律显示真实空态，不放示例温度
 * 桌面右键「隐藏小组件 / 显示小组件」控制显隐（oa-widgets）。
 */
const shell = useShellStore();
const now = ref(new Date());
const weatherBridge = typeof window === "undefined" ? undefined : window.openarc?.weather;
const weatherConsent = ref(readWeatherConsent());
const weatherCity = ref<WeatherCity | null>(readWeatherCities()[0] ?? null);
const forecast = ref<WeatherForecast | null>(null);
const weatherLoading = ref(false);
const weatherError = ref("");
let clockTimer = 0;
let weatherTimer = 0;

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const month = computed(() =>
  locale.value === "en-US" ? now.value.toLocaleDateString("en-US", { month: "short" }) : `${now.value.getMonth() + 1}月`,
);
const day = computed(() => now.value.getDate());
const week = computed(() =>
  locale.value === "en-US" ? now.value.toLocaleDateString("en-US", { weekday: "short" }) : `星期${WEEK[now.value.getDay()]}`,
);

const trackName = computed(() => (currentTrack.value ? currentTrack.value.name.replace(/\.[^.]+$/, "") : t("未在播放")));
const fmt = (value: number) => (Number.isFinite(value) ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}` : "0:00");

function syncWeatherPrefs() {
  weatherConsent.value = readWeatherConsent();
  weatherCity.value = readWeatherCities()[0] ?? null;
}

async function loadWeather() {
  syncWeatherPrefs();
  if (!weatherBridge || !weatherConsent.value || !weatherCity.value) {
    forecast.value = null;
    weatherError.value = "";
    return;
  }
  weatherLoading.value = true;
  weatherError.value = "";
  const data = await requestForecast(weatherCity.value);
  weatherLoading.value = false;
  if (data) forecast.value = data;
  else {
    forecast.value = null;
    weatherError.value = "天气服务暂时不可用";
  }
}

function openWeather() {
  shell.activateApp("weather");
}
function openMusic() {
  shell.activateApp("music");
}

const weatherIcon = computed(() => wmo(forecast.value?.current.code ?? null, forecast.value?.current.isDay ?? true).icon);
const weatherText = computed(() => wmo(forecast.value?.current.code ?? null, forecast.value?.current.isDay ?? true).text);

onMounted(() => {
  clockTimer = window.setInterval(() => (now.value = new Date()), 60000);
  weatherTimer = window.setInterval(() => void loadWeather(), 30 * 60 * 1000);
  void ensureLoaded();
  void loadWeather();
});
onBeforeUnmount(() => {
  window.clearInterval(clockTimer);
  window.clearInterval(weatherTimer);
});
</script>

<template>
  <div class="desk-widgets" aria-label="桌面小组件">
    <section class="widget widget-date" :aria-label="t('日期')">
      <small>{{ month }}</small>
      <strong>{{ day }}</strong>
      <span>{{ week }}</span>
    </section>
    <section class="widget widget-tasks" :aria-label="t('进行中的任务')">
      <header><b>{{ t("进行中的任务") }}</b><small>0</small></header>
      <p>{{ t("没有进行中的任务。") }}</p>
      <button class="widget-action" @click="shell.toggleAI()">
        <Sparkles :size="13" /> {{ t("交给全局 AI") }}
      </button>
    </section>

    <section class="widget widget-music" :aria-label="t('音乐')" data-widget-music>
      <header><b>{{ t("音乐") }}</b><small>{{ musicState.tracks.length ? t("访达 · {n} 首", { n: musicState.tracks.length }) : t("访达") }}</small></header>
      <template v-if="musicState.loading">
        <p class="widget-note">{{ t("正在读取访达里的音频…") }}</p>
      </template>
      <template v-else-if="!musicState.tracks.length">
        <p class="widget-note">{{ t("访达里还没有音频。") }}</p>
        <button class="widget-action" @click="openMusic">{{ t("打开音乐") }}</button>
      </template>
      <template v-else>
        <p class="widget-track" :title="trackName">{{ trackName }}</p>
        <div class="widget-controls">
          <button type="button" aria-label="上一首" @click="step(-1)"><SkipBack :size="14" /></button>
          <button type="button" class="widget-play" :aria-label="musicState.playing ? '暂停' : '播放'" @click="toggle">
            <Pause v-if="musicState.playing" :size="15" />
            <Play v-else :size="15" />
          </button>
          <button type="button" aria-label="下一首" @click="step(1)"><SkipForward :size="14" /></button>
          <span class="widget-time">{{ fmt(musicState.time) }}</span>
        </div>
        <button class="widget-action" @click="openMusic">{{ t("打开音乐") }}</button>
      </template>
    </section>

    <section class="widget widget-weather" :aria-label="t('天气')" data-widget-weather>
      <header>
        <b>{{ weatherCity?.name || t("天气") }}</b>
        <small v-if="forecast">{{ weatherText }}</small>
        <button v-if="weatherConsent && weatherCity && weatherBridge" type="button" class="widget-refresh" :class="{ spinning: weatherLoading }" :aria-label="t('刷新天气')" :disabled="weatherLoading" @click="loadWeather">
          <RefreshCw :size="12" />
        </button>
      </header>
      <template v-if="!weatherBridge">
        <p class="widget-note">{{ t("天气只在桌面应用里可用。") }}</p>
      </template>
      <template v-else-if="!weatherConsent">
        <p class="widget-note">{{ t("未开启天气联网。") }}</p>
        <button class="widget-action" @click="openWeather">{{ t("打开天气开启") }}</button>
      </template>
      <template v-else-if="!weatherCity">
        <p class="widget-note">{{ t("还没有添加城市。") }}</p>
        <button class="widget-action" @click="openWeather">{{ t("打开天气添加") }}</button>
      </template>
      <template v-else-if="weatherLoading && !forecast">
        <p class="widget-note">{{ t("正在获取天气…") }}</p>
      </template>
      <template v-else-if="weatherError && !forecast">
        <p class="widget-note">{{ weatherError }}</p>
        <button class="widget-action" @click="openWeather">{{ t("打开天气") }}</button>
      </template>
      <template v-else-if="forecast">
        <div class="widget-wx">
          <component :is="weatherIcon" :size="28" />
          <strong>{{ deg(forecast.current.temp) }}</strong>
          <span class="widget-wx-range">{{ t("最高 {max} 最低 {min}", { max: deg(forecast.daily[0]?.max ?? null), min: deg(forecast.daily[0]?.min ?? null) }) }}</span>
        </div>
        <button class="widget-action" @click="openWeather">{{ t("打开天气") }}</button>
      </template>
      <template v-else>
        <p class="widget-note">{{ t("暂无天气数据。") }}</p>
        <button class="widget-action" @click="openWeather">{{ t("打开天气") }}</button>
      </template>
    </section>
  </div>
</template>

<style scoped>
/* 2×2 小组件栅格：日期 / 任务 / 音乐 / 天气。只消费 tokens。 */
.desk-widgets {
  grid-template-columns: 210px 210px;
}
.widget-music header,
.widget-weather header {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  margin-bottom: 6px;
}
.widget-music header b,
.widget-weather header b {
  font-weight: var(--fw-medium);
}
.widget-music header small,
.widget-weather header small {
  color: var(--muted);
  margin-left: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.widget-refresh {
  margin-left: auto;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-pill);
  color: var(--muted);
}
.widget-refresh:hover:not(:disabled) {
  background: rgb(var(--text-rgb) / 0.08);
  color: var(--text);
}
.widget-refresh.spinning svg {
  animation: widget-spin 900ms linear infinite;
}
@keyframes widget-spin {
  to {
    transform: rotate(360deg);
  }
}
.widget-note {
  margin: 0 0 10px;
  color: var(--muted);
}
.widget-track {
  margin: 0 0 8px;
  font-size: var(--fs-secondary);
  font-weight: var(--fw-medium);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.widget-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-bottom: 8px;
}
.widget-controls button {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-pill);
  color: var(--text);
}
.widget-controls button:hover {
  background: rgb(var(--text-rgb) / 0.1);
}
.widget-controls .widget-play {
  background: rgb(var(--accent-rgb));
  color: rgb(var(--on-accent-rgb));
}
.widget-time {
  margin-left: auto;
  font-size: var(--fs-micro);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.widget-wx {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 2px 0 8px;
}
.widget-wx strong {
  font-size: 26px;
  line-height: 1.1;
  font-weight: var(--fw-medium);
  font-variant-numeric: tabular-nums;
}
.widget-wx-range {
  font-size: var(--fs-micro);
  color: var(--muted);
  line-height: var(--lh-normal);
}
</style>
