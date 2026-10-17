<script setup lang="ts">
import { t } from "../i18n";
/**
 * 日历（0.6.1）：月视图 + 本机日程 + 农历/黄历 + 提醒 + 本地规则建日程。
 *
 * 三个来源，边界写在界面上：
 *   1) 本机日程：localStorage「oa-calendar-events」（沿用旧键，旧条目不丢），可加时间与提前提醒；
 *   2) 农历 / 黄历：integration/plugins/list → integration/plugins/enable（黄历插件默认关闭）→
 *      integration/almanac/years（在线万年历，按年缓存；离线 / 未启用 / 未注入 fetch 时结构化不可用）；
 *   3) 提醒：定时器 + 浏览器 Notification + 壳层通知中心；提醒记录持久化到日程条目，
 *      应用没运行时到点的提醒在下次启动时「补发应用内通知」并标记为错过，不假装准时送达。
 *
 * AI 建日程：当前没有模型生成日程的命令通道，因此使用本地规则解析（不调用模型），
 * 结果先预览、可逐项手改，确认后才写入本机日程；无法识别的部分逐条说明。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { Bell, BellRing, CalendarClock, ChevronLeft, ChevronRight, Plus, RefreshCw, Sparkles, X } from "lucide-vue-next";
import DsButton from "../design-system/DsButton.vue";
import { useShellStore } from "../stores/shell";
import { parseSchedule, REMINDER_OPTIONS, reminderOptionLabel } from "./scheduleParse";
import type { ParsedSchedule } from "./scheduleParse";

/* ══════════════════════════════════════════════════════════════════════════
   本机日程（localStorage，旧格式兼容）
   ══════════════════════════════════════════════════════════════════════════ */
type CalEvent = {
  id: string;
  date: string;
  time: string;
  title: string;
  reminderMinutes?: number | null;
  remindedAt?: number | null;
  missed?: boolean;
};
const KEY = "oa-calendar-events";
function readEvents(): CalEvent[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((event) => event && typeof event.title === "string" && /^\d{4}-\d{2}-\d{2}$/.test(event.date))
      .map((event) => ({
        id: String(event.id || "ev" + Math.random().toString(36).slice(2, 8)),
        date: String(event.date),
        time: typeof event.time === "string" ? event.time : "",
        title: String(event.title),
        reminderMinutes:
          typeof event.reminderMinutes === "number" && Number.isFinite(event.reminderMinutes)
            ? Math.max(0, Math.round(event.reminderMinutes))
            : null,
        remindedAt: typeof event.remindedAt === "number" ? event.remindedAt : null,
        missed: event.missed === true,
      }));
  } catch {
    return [];
  }
}
const events = ref<CalEvent[]>(readEvents());
function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(events.value));
  } catch {
    /* 存储不可用：本次会话仍可用，界面上不假装已持久化 */
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (date: Date) => date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
const todayKey = ymd(new Date());

const cursor = ref(new Date());
const selected = ref(todayKey);
const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
const monthLabel = computed(() => cursor.value.getFullYear() + " 年 " + (cursor.value.getMonth() + 1) + " 月");

const byDate = computed(() => {
  const map = new Map<string, CalEvent[]>();
  for (const event of events.value) {
    const list = map.get(event.date) ?? [];
    list.push(event);
    map.set(event.date, list);
  }
  for (const list of map.values()) list.sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
  return map;
});

function shift(n: number) {
  const current = cursor.value;
  cursor.value = new Date(current.getFullYear(), current.getMonth() + n, 1);
  ensureVisibleAlmanac();
}
function goToday() {
  cursor.value = new Date();
  selected.value = todayKey;
  ensureVisibleAlmanac();
}

/* ══════════════════════════════════════════════════════════════════════════
   农历 / 黄历（integration 域，黄历插件默认关闭）
   ══════════════════════════════════════════════════════════════════════════ */
type IntegrationResult = { ok?: boolean; value?: unknown; error?: string; message?: string; detail?: unknown };
type AlmanacDay = {
  date: string;
  lunar_month_name?: string;
  lunar_day_name?: string;
  ganzhi_year?: string;
  ganzhi_month?: string;
  ganzhi_day?: string;
  solar_term?: string;
  solar_festival?: string;
  legal_holiday_name?: string;
  legal_holiday_type?: string;
  is_workday?: boolean;
  is_rest_day?: boolean;
  is_weekend?: boolean;
  weekday_cn?: string;
};
function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function integrationBridge(): { command?: (command: Record<string, unknown>) => Promise<unknown> } | null {
  if (typeof window === "undefined") return null;
  const api = (window.openarc as { integration?: { command?: (command: Record<string, unknown>) => Promise<unknown> } } | undefined)?.integration;
  return api || null;
}
async function integrationCommand(command: string, payload: Record<string, unknown> = {}): Promise<IntegrationResult> {
  const bridge = integrationBridge();
  const run = bridge && typeof bridge.command === "function" ? bridge.command : null;
  if (!run) return { ok: false, error: "INTEGRATION_UNAVAILABLE", detail: "集成桥未接入" };
  try {
    const res = (await run({ command, payload })) as IntegrationResult | null;
    return res && typeof res === "object" ? res : { ok: false, error: "INTEGRATION_INTERNAL" };
  } catch (error) {
    return { ok: false, error: "INTEGRATION_INTERNAL", detail: String((error as Error)?.message || error) };
  }
}
function integrationErrorText(result: IntegrationResult | null): string {
  if (!result) return "集成域没有返回结果";
  const code = String(result.error || "INTEGRATION_INTERNAL");
  const detail = typeof result.detail === "string" && result.detail.trim() ? result.detail.trim() : typeof result.message === "string" ? result.message.trim() : "";
  const base =
    code === "INTEGRATION_UNAVAILABLE"
      ? "在线万年历不可用（黄历插件未启用、主进程没有注入网络，或当前离线）"
      : code === "INTEGRATION_UNAUTHENTICATED"
        ? "集成域需要已认证会话"
        : code === "INTEGRATION_NOT_READY"
          ? "集成域尚未装配"
          : code === "INTEGRATION_INVALID_INPUT"
            ? "请求参数无效"
            : "集成域调用失败";
  return base + (detail && !base.includes(detail) ? "：" + detail : "") + "（" + code + "）";
}

function normalizeAlmanacDay(raw: unknown): AlmanacDay | null {
  const day = recordOf(raw);
  const date = textOf(day.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    date,
    lunar_month_name: textOf(day.lunar_month_name) || undefined,
    lunar_day_name: textOf(day.lunar_day_name) || undefined,
    ganzhi_year: textOf(day.ganzhi_year) || undefined,
    ganzhi_month: textOf(day.ganzhi_month) || undefined,
    ganzhi_day: textOf(day.ganzhi_day) || undefined,
    solar_term: textOf(day.solar_term) || undefined,
    solar_festival: textOf(day.solar_festival) || undefined,
    legal_holiday_name: textOf(day.legal_holiday_name) || undefined,
    legal_holiday_type: textOf(day.legal_holiday_type) || undefined,
    is_workday: day.is_workday === true,
    is_rest_day: day.is_rest_day === true,
    is_weekend: day.is_weekend === true,
    weekday_cn: textOf(day.weekday_cn) || undefined,
  };
}

const almanacDays = ref<Map<string, AlmanacDay>>(new Map());
const almanacEnabled = ref(false);
const almanacChecked = ref(false);
const almanacCheckError = ref<IntegrationResult | null>(null);
const almanacLoading = ref(false);
const almanacFailure = ref<IntegrationResult | null>(null);
const almanacLoadedYears = ref<Set<number>>(new Set());
const enableBusy = ref(false);
const enableFailure = ref<IntegrationResult | null>(null);

const almanacBridgeMissing = computed(() => !integrationBridge());
const almanacState = computed<"bridge-missing" | "checking" | "check-failed" | "disabled" | "loading" | "error" | "ready" | "idle">(() => {
  if (almanacBridgeMissing.value) return "bridge-missing";
  if (!almanacChecked.value) return "checking";
  if (almanacCheckError.value) return "check-failed";
  if (!almanacEnabled.value) return "disabled";
  if (almanacLoading.value) return "loading";
  if (almanacFailure.value) return "error";
  if (almanacDays.value.size) return "ready";
  return "idle";
});
const almanacStateText = computed(() => {
  switch (almanacState.value) {
    case "bridge-missing": return "集成桥未接入：农历 / 黄历不可用；本机日程仍可正常使用。";
    case "checking": return "正在检查黄历插件状态…";
    case "check-failed": return "检查黄历插件失败：" + integrationErrorText(almanacCheckError.value);
    case "disabled": return "黄历插件默认关闭（插件全部默认关，避免后台联网）。启用后才会从在线万年历读取农历 / 节气 / 节假日。";
    case "loading": return "正在读取 " + cursor.value.getFullYear() + " 年农历…（在线万年历，按年缓存）";
    case "error": return "农历数据不可用：" + integrationErrorText(almanacFailure.value) + "。本机日程不受影响。";
    case "ready": return "农历 / 节气 / 节假日来自在线万年历（uapis.cn，按年缓存）。本机日程与提醒独立保存。";
    default: return "还没有农历数据。";
  }
});

async function initAlmanac() {
  if (almanacBridgeMissing.value) {
    almanacChecked.value = true;
    return;
  }
  const result = await integrationCommand("integration/plugins/list");
  almanacChecked.value = true;
  if (!result.ok) {
    almanacCheckError.value = result;
    return;
  }
  const value = recordOf(result.value);
  const items = Array.isArray(value.items) ? value.items : [];
  const plugin = items.find((item) => textOf(recordOf(item).id) === "almanac");
  almanacEnabled.value = !!(plugin && recordOf(plugin).enabled === true);
  if (almanacEnabled.value) await ensureAlmanac(cursor.value.getFullYear());
}

async function enableAlmanac() {
  enableBusy.value = true;
  enableFailure.value = null;
  const result = await integrationCommand("integration/plugins/enable", { id: "almanac" });
  enableBusy.value = false;
  if (!result.ok) {
    enableFailure.value = result;
    return;
  }
  almanacEnabled.value = true;
  almanacCheckError.value = null;
  await ensureAlmanac(cursor.value.getFullYear());
  ensureVisibleAlmanac();
}

async function ensureAlmanac(year: number) {
  if (!almanacEnabled.value || almanacLoadedYears.value.has(year) || almanacLoading.value) return;
  almanacLoading.value = true;
  almanacFailure.value = null;
  const result = await integrationCommand("integration/almanac/years", { years: [year] });
  almanacLoading.value = false;
  if (!result.ok) {
    almanacFailure.value = result;
    return;
  }
  const years = Array.isArray(result.value) ? result.value : [];
  const next = new Map(almanacDays.value);
  let count = 0;
  for (const rawYear of years) {
    const days = Array.isArray(recordOf(rawYear).days) ? (recordOf(rawYear).days as unknown[]) : [];
    for (const rawDay of days) {
      const day = normalizeAlmanacDay(rawDay);
      if (!day) continue;
      next.set(day.date, day);
      count += 1;
    }
  }
  if (!count) {
    almanacFailure.value = { ok: false, error: "INTEGRATION_INVALID_INPUT", detail: "在线万年历没有返回日期数据" };
    return;
  }
  almanacDays.value = next;
  const loaded = new Set(almanacLoadedYears.value);
  loaded.add(year);
  almanacLoadedYears.value = loaded;
}

function ensureVisibleAlmanac() {
  if (!almanacEnabled.value) return;
  const year = cursor.value.getFullYear();
  const month = cursor.value.getMonth();
  const years = new Set<number>([year]);
  if (month === 11) years.add(year + 1);
  if (month === 0) years.add(year - 1);
  for (const target of years) void ensureAlmanac(target);
}

function lunarHint(day: AlmanacDay | null): string {
  if (!day) return "";
  if (day.solar_term) return day.solar_term;
  if (day.legal_holiday_name && (day.legal_holiday_type === "rest" || day.is_rest_day === true)) return day.legal_holiday_name;
  if (day.solar_festival) return day.solar_festival;
  if (day.lunar_day_name === "初一") return day.lunar_month_name || "初一";
  return day.lunar_day_name || "";
}
const isRestDay = (day: AlmanacDay | null) => !!day && day.is_rest_day === true && day.legal_holiday_type !== "workday_adjust";
const isWorkAdjust = (day: AlmanacDay | null) => !!day && day.legal_holiday_type === "workday_adjust";

const cells = computed(() => {
  const year = cursor.value.getFullYear();
  const month = cursor.value.getMonth();
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(year, month, 1 - lead + index);
    const key = ymd(date);
    const day = almanacDays.value.get(key) || null;
    return {
      key,
      day: date.getDate(),
      inMonth: date.getMonth() === month,
      today: key === todayKey,
      list: byDate.value.get(key) ?? [],
      almanac: day,
      lunar: lunarHint(day),
      rest: isRestDay(day),
      workAdjust: isWorkAdjust(day),
    };
  });
});

const selectedLabel = computed(() => {
  const [y, m, d] = selected.value.split("-").map(Number);
  const weekday = WEEK[(new Date(y, m - 1, d).getDay() + 6) % 7];
  return m + " 月 " + d + " 日 周" + weekday + (selected.value === todayKey ? " · 今天" : "");
});
const agenda = computed(() => byDate.value.get(selected.value) ?? []);
const selectedAlmanac = computed(() => almanacDays.value.get(selected.value) || null);
const selectedRows = computed(() => {
  const day = selectedAlmanac.value;
  if (!day) return [];
  const lunar = [day.lunar_month_name, day.lunar_day_name].filter(Boolean).join("");
  const ganzhi = [day.ganzhi_year ? day.ganzhi_year + "年" : "", day.ganzhi_month ? day.ganzhi_month + "月" : "", day.ganzhi_day ? day.ganzhi_day + "日" : ""].filter(Boolean).join(" ");
  const festivals = [day.solar_festival, day.legal_holiday_name].filter(Boolean).join(" · ");
  return [
    { key: "lunar", label: "农历", value: lunar },
    { key: "ganzhi", label: "干支", value: ganzhi },
    { key: "term", label: "节气", value: day.solar_term || "" },
    { key: "festival", label: "节日", value: festivals },
    {
      key: "rest",
      label: "休班",
      value: isRestDay(day) ? "休息日" : isWorkAdjust(day) ? "调休上班" : day.is_workday === true ? "工作日" : "",
    },
  ].filter((row) => row.value);
});

/* ══════════════════════════════════════════════════════════════════════════
   提醒：定时器 + Notification + 壳层通知中心；错过如实补发
   ══════════════════════════════════════════════════════════════════════════ */
type SystemNotifyState = "sent" | "denied" | "unsupported" | "failed";
type ReminderLogRow = { id: string; title: string; at: number; system: SystemNotifyState; late: boolean };
const shell = useShellStore();
const reminderLog = ref<ReminderLogRow[]>([]);
const missedCount = ref(0);
const missedDismissed = ref(false);
const notificationPermission = ref<string>(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
const delivering = new Set<string>();
let timer: number | undefined;

const SYSTEM_NOTIFY_LABEL: Record<SystemNotifyState, string> = {
  sent: "系统通知已发送",
  denied: "系统通知未授权",
  unsupported: "系统通知不支持",
  failed: "系统通知发送失败",
};
const permissionText = computed(() => {
  if (typeof Notification === "undefined") return "系统通知不支持（本机 Web Notification 不可用）；应用内通知仍会入队。";
  return notificationPermission.value === "granted"
    ? "系统通知已授权。"
    : notificationPermission.value === "denied"
      ? "系统通知被拒绝：提醒仍会进入应用内通知中心，但不会弹系统横幅。"
      : "系统通知尚未授权：首次触发提醒时会请求权限。";
});

function eventTimestamp(event: CalEvent): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(event.date);
  if (!match) return null;
  const time = /^(\d{1,2}):(\d{2})$/.exec(event.time || "");
  const hour = time ? Number(time[1]) : 0;
  const minute = time ? Number(time[2]) : 0;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour, minute, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}
function reminderAt(event: CalEvent): number | null {
  if (event.reminderMinutes == null || !event.time) return null;
  const base = eventTimestamp(event);
  if (base == null) return null;
  return base - Math.max(0, event.reminderMinutes) * 60_000;
}
function reminderStatus(event: CalEvent): string {
  if (event.reminderMinutes == null || !event.time) return "";
  if (event.remindedAt != null) return event.missed ? "已补发（错过）" : "已提醒";
  const due = reminderAt(event);
  return due != null && due <= Date.now() ? "待触发" : reminderOptionLabel(event.reminderMinutes);
}

async function systemNotify(title: string, body: string): Promise<SystemNotifyState> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    notificationPermission.value = permission;
    if (permission !== "granted") return permission === "denied" ? "denied" : "failed";
    new Notification(title, { body });
    return "sent";
  } catch {
    return "failed";
  }
}

async function deliverReminder(event: CalEvent, late: boolean) {
  if (event.remindedAt != null || delivering.has(event.id)) return;
  delivering.add(event.id);
  const title = "日程提醒：" + event.title;
  const body = [event.date, event.time].filter(Boolean).join(" ") + (late ? "（应用未运行时到点，现补发）" : "");
  const system = await systemNotify(title, body);
  event.remindedAt = Date.now();
  if (late) {
    event.missed = true;
    missedCount.value += 1;
  }
  persist();
  shell.notify({ appId: "calendar", title, body });
  reminderLog.value = [
    { id: "rl" + Math.random().toString(36).slice(2, 8), title: event.title, at: Date.now(), system, late },
    ...reminderLog.value,
  ].slice(0, 20);
  delivering.delete(event.id);
}

function collectDue(late: boolean) {
  const now = Date.now();
  for (const event of events.value) {
    if (event.reminderMinutes == null || !event.time || event.remindedAt != null) continue;
    const due = reminderAt(event);
    if (due != null && due <= now) void deliverReminder(event, late);
  }
}

const upcomingReminders = computed(() =>
  events.value
    .filter((event) => event.reminderMinutes != null && event.time && event.remindedAt == null)
    .map((event) => ({ event, due: reminderAt(event) }))
    .filter((row): row is { event: CalEvent; due: number } => row.due != null)
    .sort((a, b) => a.due - b.due)
    .slice(0, 8),
);
function formatDue(ts: number): string {
  const date = new Date(ts);
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

onMounted(() => {
  void initAlmanac();
  /* 先补发「应用没运行时到点」的提醒，再启动定时器处理未来的提醒。 */
  collectDue(true);
  timer = window.setInterval(() => collectDue(false), 15_000);
});
onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
});

/* ══════════════════════════════════════════════════════════════════════════
   新增 / 删除日程
   ══════════════════════════════════════════════════════════════════════════ */
const draftTitle = ref("");
const draftTime = ref("");
const draftReminder = ref<number | null>(10);
const titleInput = ref<HTMLInputElement | null>(null);
const notice = ref("");

function add() {
  const title = draftTitle.value.trim();
  if (!title) return;
  const time = draftTime.value;
  events.value.push({
    id: "ev" + Date.now().toString(36),
    date: selected.value,
    time,
    title,
    reminderMinutes: time ? draftReminder.value : null,
    remindedAt: null,
    missed: false,
  });
  persist();
  draftTitle.value = "";
  draftTime.value = "";
  notice.value = time
    ? "已加入本机日程" + (draftReminder.value != null ? "，提醒：" + reminderOptionLabel(draftReminder.value) : "，不提醒") + "。"
    : "已加入本机日程（全天，不设提醒）。";
  window.setTimeout(() => collectDue(false), 0);
}
function remove(id: string) {
  events.value = events.value.filter((event) => event.id !== id);
  persist();
}
async function quickAdd(key: string) {
  selected.value = key;
  await nextTick();
  titleInput.value?.focus();
}

/* ══════════════════════════════════════════════════════════════════════════
   AI 建日程：本地规则解析（无模型通道，结果先预览）
   ══════════════════════════════════════════════════════════════════════════ */
const aiText = ref("");
const aiDraft = ref<ParsedSchedule | null>(null);
const aiError = ref("");
const aiNotice = ref("");
const aiTitle = ref("");
const aiDate = ref(selected.value);
const aiTime = ref("");
const aiReminder = ref<number | null>(10);

function parseAi() {
  const text = aiText.value.trim();
  if (!text) {
    aiError.value = "先写一句日程，例如「明天下午 3 点开会，提前 10 分钟提醒」。";
    aiDraft.value = null;
    return;
  }
  aiError.value = "";
  const parsed = parseSchedule(text, selected.value);
  aiDraft.value = parsed;
  aiTitle.value = parsed.title;
  aiDate.value = parsed.date;
  aiTime.value = parsed.time;
  aiReminder.value = parsed.time ? parsed.reminderMinutes : null;
  aiNotice.value = "";
}
function addAi() {
  const title = aiTitle.value.trim();
  if (!title) {
    aiError.value = "预览里的标题不能为空。";
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(aiDate.value)) {
    aiError.value = "预览里的日期格式不对，请填 YYYY-MM-DD。";
    return;
  }
  events.value.push({
    id: "ev" + Date.now().toString(36),
    date: aiDate.value,
    time: aiTime.value,
    title,
    reminderMinutes: aiTime.value ? aiReminder.value : null,
    remindedAt: null,
    missed: false,
  });
  persist();
  aiNotice.value = "已加入本机日程（来自本地规则解析，可继续修改）。";
  aiDraft.value = null;
  aiText.value = "";
  window.setTimeout(() => collectDue(false), 0);
}
</script>

<template>
  <div class="split cal-app" data-calendar-app="1" :data-cal-almanac="almanacState">
    <nav class="split-side" :aria-label="t('日历')">
      <div class="split-section">{{ t("日历") }}</div>
      <button type="button" class="split-nav" aria-current="true">
        <CalendarClock :size="15" aria-hidden="true" />
        <span class="split-nav-label">{{ t("本机日历") }}</span><small class="planned-count">{{ events.length }}</small>
      </button>
      <div class="split-section">{{ selectedLabel }}</div>
      <div class="cal-agenda" data-cal-agenda>
        <div v-for="event in agenda" :key="event.id" class="cal-agenda-item">
          <span class="cal-agenda-time">{{ event.time || t("全天") }}</span>
          <span class="cal-agenda-title" :title="event.title">{{ event.title }}</span>
          <span v-if="reminderStatus(event)" class="cal-reminder-chip" :data-cal-reminder-status="event.id">
            <Bell :size="10" aria-hidden="true" /> {{ reminderStatus(event) }}
          </span>
          <button class="cal-agenda-del" :aria-label="'删除 ' + event.title" @click="remove(event.id)"><X :size="12" /></button>
        </div>
        <p v-if="!agenda.length" class="planned-note">{{ t("这一天没有日程。") }}</p>
      </div>
      <form class="cal-add" @submit.prevent="add">
        <input ref="titleInput" v-model="draftTitle" class="cal-add-title" :placeholder="t('新日程')" :aria-label="t('日程标题')" />
        <div class="cal-add-row">
          <input v-model="draftTime" type="time" class="cal-add-time" :aria-label="t('时间（留空为全天）')" />
          <select v-model="draftReminder" class="cal-add-select" :disabled="!draftTime" :aria-label="t('提前提醒')">
            <option v-for="option in REMINDER_OPTIONS" :key="String(option.value)" :value="option.value">{{ option.label }}</option>
          </select>
        </div>
        <button type="submit" class="planned-today cal-add-btn" :disabled="!draftTitle.trim()"><Plus :size="12" /> {{ t("添加") }}</button>
      </form>
      <p v-if="notice" class="planned-note" role="status" data-cal-notice>{{ notice }}</p>
      <p class="planned-note">{{ t("日程与提醒保存在本机（localStorage）；提醒依赖应用运行，应用没运行时到点的提醒会在下次启动时补发并标记「错过」。") }}</p>
    </nav>

    <div class="split-main cal-main">
      <div class="pane-toolbar">
        <strong class="pane-title">{{ monthLabel }}</strong>
        <div class="toolbar-spacer" />
        <button class="icon-button" :aria-label="t('上个月')" @click="shift(-1)"><ChevronLeft :size="15" /></button>
        <button class="planned-today" @click="goToday">{{ t("今天") }}</button>
        <button class="icon-button" :aria-label="t('下个月')" @click="shift(1)"><ChevronRight :size="15" /></button>
      </div>

      <div class="cal-almanac-banner" :data-cal-almanac-banner="almanacState">
        <span class="cal-almanac-text">{{ almanacStateText }}</span>
        <template v-if="almanacState === 'disabled'">
          <DsButton size="sm" variant="secondary" :status="enableBusy ? 'loading' : 'idle'" @click="enableAlmanac" data-cal-enable-almanac>
            <Sparkles :size="13" :stroke-width="1.5" /> {{ t("启用黄历插件") }}
          </DsButton>
          <span v-if="enableFailure" class="cal-almanac-error" role="alert">{{ integrationErrorText(enableFailure) }}</span>
        </template>
        <DsButton v-else-if="almanacState === 'check-failed' || almanacState === 'error'" size="sm" variant="secondary" :status="almanacLoading ? 'loading' : 'idle'" @click="initAlmanac(); ensureVisibleAlmanac()">
          <RefreshCw :size="13" :stroke-width="1.5" /> {{ t("重新读取") }}
        </DsButton>
      </div>

      <p v-if="missedCount > 0 && !missedDismissed" class="cal-missed" role="status" data-cal-missed>
        检测到 {{ missedCount }} 条在应用未运行时到点的提醒，已补发应用内通知并标记为「错过」；系统通知可能没有弹出。
        <button type="button" class="cal-missed__close" :aria-label="t('知道了')" @click="missedDismissed = true"><X :size="12" /></button>
      </p>

      <div class="cal-grid" role="grid" :aria-label="monthLabel">
        <div v-for="week in WEEK" :key="week" class="cal-head">周{{ week }}</div>
        <div
          v-for="cell in cells"
          :key="cell.key"
          class="cal-cell"
          :class="{ out: !cell.inMonth, today: cell.today, selected: cell.key === selected, 'is-rest': cell.rest, 'is-work': cell.workAdjust }"
          role="gridcell"
          :aria-selected="cell.key === selected"
          :data-cal-date="cell.key"
          @click="selected = cell.key"
          @dblclick="quickAdd(cell.key)"
        >
          <span class="cal-day">{{ cell.day }}</span>
          <span v-if="cell.lunar" class="cal-lunar" :class="{ 'is-term': !!cell.almanac?.solar_term, 'is-holiday': !!cell.almanac?.legal_holiday_name }" :data-cal-lunar="cell.key">{{ cell.lunar }}</span>
          <span v-for="event in cell.list.slice(0, 1)" :key="event.id" class="cal-chip" :title="event.title">{{ event.time ? event.time + " " : "" }}{{ event.title }}</span>
          <span v-if="cell.list.length > 1" class="cal-more">还有 {{ cell.list.length - 1 }} 项</span>
        </div>
      </div>
    </div>

    <aside class="cal-side" :aria-label="t('当天详情与提醒')">
      <section class="cal-panel" data-cal-day-detail>
        <div class="cal-panel-head">
          <strong>{{ selectedLabel }}</strong>
          <span v-if="selectedAlmanac" class="cal-panel-sub">{{ selectedAlmanac.lunar_month_name || "" }}{{ selectedAlmanac.lunar_day_name || "" }}</span>
        </div>
        <dl v-if="selectedRows.length" class="cal-kv">
          <template v-for="row in selectedRows" :key="row.key">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </template>
        </dl>
        <p v-else class="cal-hint" data-cal-day-detail-empty>
          {{ almanacState === "ready" ? t("这一天没有返回农历字段。") : t("农历 / 黄历数据未加载；本机日程与提醒不受影响。") }}
        </p>
      </section>

      <section class="cal-panel" data-cal-reminders>
        <div class="cal-panel-head"><strong>{{ t("提醒") }}</strong><DsButton size="sm" variant="ghost" @click="collectDue(false)">{{ t("检查一次") }}</DsButton></div>
        <p class="cal-hint" data-cal-permission>{{ permissionText }}</p>
        <ul v-if="upcomingReminders.length" class="cal-upcoming" data-cal-upcoming>
          <li v-for="row in upcomingReminders" :key="row.event.id" class="cal-upcoming-row">
            <BellRing :size="12" aria-hidden="true" />
            <span class="cal-upcoming-title" :title="row.event.title">{{ row.event.title }}</span>
            <span class="cal-upcoming-time">{{ formatDue(row.due) }}</span>
          </li>
        </ul>
        <p v-else class="cal-hint" data-cal-upcoming-empty>{{ t("没有待触发的提醒。给日程设时间并选择「提前 N 分钟」即可。") }}</p>
        <div v-if="reminderLog.length" class="cal-reminder-log" data-cal-reminder-log>
          <div v-for="row in reminderLog" :key="row.id" class="cal-reminder-log-row">
            <span class="cal-reminder-log-title">{{ row.title }}{{ row.late ? t("（错过补发）") : "" }}</span>
            <span class="cal-reminder-log-status">{{ SYSTEM_NOTIFY_LABEL[row.system] }} · 应用内已入队</span>
          </div>
        </div>
      </section>

      <section class="cal-panel" data-cal-ai>
        <div class="cal-panel-head"><strong>{{ t("AI 建日程") }}</strong><span class="cal-panel-sub">{{ t("本地规则解析") }}</span></div>
        <p class="cal-hint">{{ t("不调用模型：当前没有模型生成日程的命令通道。这里按本地规则解析日期 / 时间 / 提醒 / 标题，结果先预览、可手改，确认后才写入本机日程。") }}</p>
        <div class="cal-ai-input">
          <input v-model="aiText" type="text" :aria-label="t('用一句话描述日程')" :placeholder="t('例如：明天下午 3 点开会，提前 10 分钟提醒')" @keydown.enter.prevent="parseAi" />
          <DsButton size="sm" @click="parseAi"><Sparkles :size="13" :stroke-width="1.5" /> {{ t("解析") }}</DsButton>
        </div>
        <p v-if="aiError" class="cal-error" role="alert" data-cal-ai-error>{{ aiError }}</p>
        <template v-if="aiDraft">
          <ul v-if="aiDraft.notes.length" class="cal-ai-notes" data-cal-ai-notes>
            <li v-for="note in aiDraft.notes" :key="note">{{ note }}</li>
          </ul>
          <div class="cal-ai-preview" data-cal-ai-preview>
            <label class="cal-ai-field">
              <span>{{ t("标题") }}</span>
              <input v-model="aiTitle" type="text" :aria-label="t('解析后的日程标题')" />
            </label>
            <label class="cal-ai-field">
              <span>{{ t("日期") }}</span>
              <input v-model="aiDate" type="date" :aria-label="t('解析后的日期')" />
            </label>
            <label class="cal-ai-field">
              <span>{{ t("时间（留空全天）") }}</span>
              <input v-model="aiTime" type="time" :aria-label="t('解析后的时间')" />
            </label>
            <label class="cal-ai-field">
              <span>{{ t("提醒") }}</span>
              <select v-model="aiReminder" :disabled="!aiTime" :aria-label="t('解析后的提醒')">
                <option v-for="option in REMINDER_OPTIONS" :key="String(option.value)" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
          </div>
          <div class="cal-ai-actions">
            <DsButton size="sm" @click="addAi">{{ t("加入日程") }}</DsButton>
            <DsButton size="sm" variant="ghost" @click="aiDraft = null; aiError = ''">{{ t("取消") }}</DsButton>
          </div>
        </template>
        <p v-if="aiNotice" class="cal-hint" data-cal-ai-notice>{{ aiNotice }}</p>
      </section>
    </aside>
  </div>
</template>

<style scoped>
/* 只写日历应用自身需要的布局；颜色 / 间距 / 圆角 / 时长全部走 design-system token。 */
.cal-app {
  min-height: 0;
}
.cal-main {
  min-width: 0;
  min-height: 0;
  padding-bottom: var(--space-4);
}
.cal-almanac-banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  flex: none;
  margin-bottom: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--sunken);
  font-size: var(--fs-micro);
  line-height: var(--lh-relaxed);
  color: var(--muted);
}
.cal-almanac-text {
  flex: 1 1 320px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.cal-almanac-error,
.cal-error {
  margin: 0;
  font-size: var(--fs-micro);
  line-height: var(--lh-relaxed);
  color: var(--failed);
  overflow-wrap: anywhere;
}
.cal-missed {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  margin: 0 0 var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--sunken);
  font-size: var(--fs-caption);
  line-height: var(--lh-relaxed);
  color: var(--text);
}
.cal-missed__close {
  margin-left: auto;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  color: var(--muted);
}
.cal-missed__close:hover {
  background: var(--row-hover);
  color: var(--text);
}
.cal-cell .cal-lunar {
  display: block;
  align-self: flex-end;
  font-size: var(--fs-micro);
  line-height: 1.2;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.cal-cell .cal-lunar.is-term {
  color: var(--text);
}
.cal-cell.is-rest .cal-day {
  color: var(--failed);
}
.cal-cell.is-rest .cal-lunar {
  color: var(--failed);
}
.cal-cell.is-work .cal-lunar {
  color: var(--warning-text, #8a4b00);
}
.cal-cell.is-work .cal-day::after {
  content: "班";
  margin-left: 2px;
  font-size: 9px;
  color: var(--muted);
}
.cal-side {
  flex: 0 0 320px;
  min-width: 260px;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-right: var(--space-1);
}
.cal-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background: rgb(var(--content-rgb) / var(--content-alpha));
  box-shadow: var(--elevation-1);
}
.cal-panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}
.cal-panel-head strong {
  font-size: var(--fs-secondary);
  font-weight: var(--fw-medium);
}
.cal-panel-sub {
  font-size: var(--fs-micro);
  color: var(--muted);
}
.cal-hint {
  margin: 0;
  font-size: var(--fs-micro);
  line-height: var(--lh-relaxed);
  color: var(--muted);
  overflow-wrap: anywhere;
}
.cal-kv {
  margin: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-1) var(--space-3);
  font-size: var(--fs-caption);
}
.cal-kv dt {
  color: var(--muted);
}
.cal-kv dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.cal-reminder-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  font-size: var(--fs-micro);
  color: var(--muted);
}
.cal-add-select,
.cal-ai-field select {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  outline: none;
  border-radius: var(--radius-md);
  background: rgb(var(--text-rgb) / 0.06);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-caption);
  padding: 5px 8px;
}
.cal-upcoming,
.cal-ai-notes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cal-upcoming-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-caption);
}
.cal-upcoming-row svg {
  color: var(--muted);
  flex: none;
}
.cal-upcoming-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cal-upcoming-time {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.cal-reminder-log {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--space-1);
  padding-top: var(--space-1);
  box-shadow: inset 0 1px 0 var(--line);
}
.cal-reminder-log-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--fs-micro);
  color: var(--muted);
}
.cal-reminder-log-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}
.cal-ai-input {
  display: flex;
  gap: var(--space-2);
}
.cal-ai-input input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px var(--space-2);
  border: 0;
  outline: none;
  border-radius: var(--radius-md);
  background: rgb(var(--text-rgb) / 0.06);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-caption);
}
.cal-ai-notes {
  padding-left: var(--space-4);
  list-style: disc;
  color: var(--muted);
  font-size: var(--fs-micro);
  line-height: var(--lh-relaxed);
}
.cal-ai-preview {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}
.cal-ai-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--fs-micro);
  color: var(--muted);
  min-width: 0;
}
.cal-ai-field input {
  min-width: 0;
  padding: 5px var(--space-2);
  border: 0;
  outline: none;
  border-radius: var(--radius-md);
  background: rgb(var(--text-rgb) / 0.06);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-caption);
}
.cal-ai-actions {
  display: flex;
  gap: var(--space-2);
}
/* 窄窗口：右栏换到主区下方，不挤掉月历。 */
@container (max-width: 900px) {
  .cal-app {
    flex-wrap: wrap;
  }
  .cal-side {
    flex-basis: 100%;
    min-width: 0;
    max-height: 42%;
  }
}
</style>
