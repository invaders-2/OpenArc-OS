<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-vue-next";

/**
 * 日历（10-15）：月视图 + 本机日程。
 * 日程只存在本机（localStorage「oa-calendar-events」），不伪造任何外部来源；
 * 系统日历 / 团队日程接入后作为额外来源并入，同一份视图。
 */
type CalEvent = { id: string; date: string; time: string; title: string };
const KEY = "oa-calendar-events";
function readEvents(): CalEvent[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.filter((e) => e && typeof e.title === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.date)) : [];
  } catch {
    return [];
  }
}
const events = ref<CalEvent[]>(readEvents());
function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(events.value));
  } catch {
    /* 存储不可用：本次会话内仍可用 */
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = ymd(new Date());

const cursor = ref(new Date());
const selected = ref(todayKey);
const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
const monthLabel = computed(() => `${cursor.value.getFullYear()} 年 ${cursor.value.getMonth() + 1} 月`);

const byDate = computed(() => {
  const m = new Map<string, CalEvent[]>();
  for (const e of events.value) {
    const list = m.get(e.date) ?? [];
    list.push(e);
    m.set(e.date, list);
  }
  for (const list of m.values()) list.sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
  return m;
});

const cells = computed(() => {
  const y = cursor.value.getFullYear();
  const mo = cursor.value.getMonth();
  const lead = (new Date(y, mo, 1).getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(y, mo, 1 - lead + i);
    const key = ymd(d);
    return { key, day: d.getDate(), inMonth: d.getMonth() === mo, today: key === todayKey, list: byDate.value.get(key) ?? [] };
  });
});
function shift(n: number) {
  const c = cursor.value;
  cursor.value = new Date(c.getFullYear(), c.getMonth() + n, 1);
}
function goToday() {
  cursor.value = new Date();
  selected.value = todayKey;
}

const selectedLabel = computed(() => {
  const [y, m, d] = selected.value.split("-").map(Number);
  const w = WEEK[(new Date(y, m - 1, d).getDay() + 6) % 7];
  return `${m} 月 ${d} 日 周${w}${selected.value === todayKey ? " · 今天" : ""}`;
});
const agenda = computed(() => byDate.value.get(selected.value) ?? []);

const draftTitle = ref("");
const draftTime = ref("");
const titleInput = ref<HTMLInputElement | null>(null);
function add() {
  const title = draftTitle.value.trim();
  if (!title) return;
  events.value.push({ id: "ev" + Date.now().toString(36), date: selected.value, time: draftTime.value, title });
  persist();
  draftTitle.value = "";
  draftTime.value = "";
}
function remove(id: string) {
  events.value = events.value.filter((e) => e.id !== id);
  persist();
}
async function quickAdd(key: string) {
  selected.value = key;
  await nextTick();
  titleInput.value?.focus();
}
</script>

<template>
  <div class="split planned-app cal-app">
    <nav class="split-side" aria-label="日历">
      <div class="split-section">日历</div>
      <button type="button" class="split-nav" aria-current="true">
        <span class="split-nav-label">本机日历</span><small class="planned-count">{{ events.length }}</small>
      </button>
      <div class="split-section">{{ selectedLabel }}</div>
      <div class="cal-agenda">
        <div v-for="e in agenda" :key="e.id" class="cal-agenda-item">
          <span class="cal-agenda-time">{{ e.time || "全天" }}</span>
          <span class="cal-agenda-title">{{ e.title }}</span>
          <button class="cal-agenda-del" :aria-label="'删除 ' + e.title" @click="remove(e.id)"><X :size="12" /></button>
        </div>
        <p v-if="!agenda.length" class="planned-note">这一天没有日程。</p>
      </div>
      <form class="cal-add" @submit.prevent="add">
        <input ref="titleInput" v-model="draftTitle" class="cal-add-title" placeholder="新日程" aria-label="日程标题" />
        <div class="cal-add-row">
          <input v-model="draftTime" type="time" class="cal-add-time" aria-label="时间（留空为全天）" />
          <button type="submit" class="planned-today cal-add-btn" :disabled="!draftTitle.trim()"><Plus :size="12" /> 添加</button>
        </div>
      </form>
      <p class="planned-note">日程保存在本机。系统日历 / 团队日程尚未接入。</p>
    </nav>
    <div class="split-main">
      <div class="pane-toolbar">
        <strong class="pane-title">{{ monthLabel }}</strong>
        <div class="toolbar-spacer" />
        <button class="icon-button" aria-label="上个月" @click="shift(-1)"><ChevronLeft :size="15" /></button>
        <button class="planned-today" @click="goToday">今天</button>
        <button class="icon-button" aria-label="下个月" @click="shift(1)"><ChevronRight :size="15" /></button>
      </div>
      <div class="cal-grid" role="grid" :aria-label="monthLabel">
        <div v-for="w in WEEK" :key="w" class="cal-head">周{{ w }}</div>
        <div
          v-for="c in cells"
          :key="c.key"
          class="cal-cell"
          :class="{ out: !c.inMonth, today: c.today, selected: c.key === selected }"
          role="gridcell"
          :aria-selected="c.key === selected"
          @click="selected = c.key"
          @dblclick="quickAdd(c.key)"
        >
          <span class="cal-day">{{ c.day }}</span>
          <span v-for="e in c.list.slice(0, 2)" :key="e.id" class="cal-chip">{{ e.time ? e.time + " " : "" }}{{ e.title }}</span>
          <span v-if="c.list.length > 2" class="cal-more">还有 {{ c.list.length - 2 }} 项</span>
        </div>
      </div>
    </div>
  </div>
</template>
