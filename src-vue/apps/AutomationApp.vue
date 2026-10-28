<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Activity, History, List, Play, Plus, Sparkles, Square, Trash2, Zap } from "lucide-vue-next";
import { iconUrl } from "../apps";
import { useShellStore } from "../stores/shell";
import DsDialog from "../design-system/DsDialog.vue";

/**
 * 自动化（10-16 接后端 automation 域，取代 10-15 的「渲染进程里定时 + localStorage」）。
 *
 *   · 调度在主进程（automation-service.cjs，15 秒一轮），OpenArc 开着就会按时运行，窗口关了也不影响；
 *   · 「定义即授权」：创建 / 启用 = 对该定义声明的动作范围授权，停用 / 删除即撤销；每次运行落审计；
 *   · 动作：让助理执行指令（agent_instruction）、钉钉通知、领星 / 紫鸟同步、联动流程（多个后台动作串行）；
 *     桌面类动作（播放音乐 / 打开应用）后端没有执行端，如实标为不可用；
 *   · 「一句话创建」= automation/parse（本机规则解析，不调用模型）；
 *   · 10-15 版存在本机 oa-automations 的定义，打开时提示一键迁移（只迁可定时的；迁移成功才清本机副本）。
 */
const shell = useShellStore();
const bridge = window.openarc?.automation;
type Res = { ok?: boolean; value?: any; error?: string; message?: string; detail?: any };
async function send(command: string, payload: Record<string, unknown> = {}): Promise<Res> {
  if (!bridge?.command) return { ok: false, error: "NO_BRIDGE" };
  try {
    return (await bridge.command({ command, payload })) || { ok: false, error: "AUTOMATION_INTERNAL" };
  } catch {
    return { ok: false, error: "AUTOMATION_INTERNAL" };
  }
}
const val = (r: Res) => (r.value && typeof r.value === "object" ? r.value : (r as any));
const ERR: Record<string, string> = {
  NO_BRIDGE: "自动化服务没有接入",
  AUTOMATION_INVALID_INPUT: "填写的内容不完整或不正确",
  AUTOMATION_UNAUTHENTICATED: "请先登录",
  AUTOMATION_FORBIDDEN: "没有权限",
  AUTOMATION_NOT_FOUND: "这条自动化已不存在",
  AUTOMATION_CONFLICT: "它正在运行，稍后再试",
  AGENT_DEPENDENCY_UNAVAILABLE: "执行这个动作需要的能力还没接入",
  AUTOMATION_UNAVAILABLE: "暂时不可用",
  AUTOMATION_CANCELLED: "已取消",
  AUTOMATION_INTERNAL: "自动化服务出错",
};
const errText = (r: Res | { error?: string; message?: string }) => {
  const code = String(r.error || "AUTOMATION_INTERNAL");
  const msg = typeof r.message === "string" && r.message && !/^[A-Z_]+$/.test(r.message) ? r.message : "";
  return (msg || ERR[code] || "操作失败") + "（" + code + "）";
};

type Schedule =
  | { type: "daily"; hour: number; minute: number; timezone?: string }
  | { type: "weekly"; weekdays: number[]; hour: number; minute: number; timezone?: string }
  | { type: "interval"; everyMs: number; anchor?: number; timezone?: string }
  | { type: "once"; at: number; timezone?: string }
  | { type: "cron"; expression: string; timezone?: string };
type Action = { type: string; args?: Record<string, any>; retry?: { maxAttempts: number; delayMs: number } };
type Def = { id: string; title: string; instruction: string; action: Action; schedule: Schedule; enabled: boolean; nextRunAt: number | null; lastRunAt: number | null; lastStatus: string | null; lastError: string | null };
type Run = { id: string; status: string; result: string | null; error: string | null; createdAt: number; startedAt: number | null; completedAt: number | null; scheduledFor: number | null };

const items = ref<Def[]>([]);
const health = ref<any>(null);
const loading = ref(true);
const message = ref("");
const failure = ref("");
const filter = ref<"all" | "on" | "off">("all");
const currentId = ref<string | null>(null);
const view = ref<"overview" | "all" | "runs">("overview");
const allRuns = ref<any[]>([]);
const current = computed(() => items.value.find((a) => a.id === currentId.value) ?? null);
const list = computed(() => items.value.filter((a) => (filter.value === "all" ? true : filter.value === "on" ? a.enabled : !a.enabled)));

async function load() {
  const [h, l] = await Promise.all([send("automation/health"), send("automation/list")]);
  health.value = h.ok ? val(h) : null;
  if (l.ok) items.value = (val(l).automations || []) as Def[];
  else failure.value = errText(l);
  loading.value = false;
  if (currentId.value) void loadRuns(currentId.value);
}

/* ── 文案 ── */
const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (n: number) => String(n).padStart(2, "0");
function scheduleText(s: Schedule | null | undefined) {
  if (!s) return "触发时间未知（NOT VERIFIED）";
  const kind = String((s as any).kind || (s as any).type || "");
  const time = (s as any).time as string | undefined;
  const hour = Number((s as any).hour);
  const minute = Number((s as any).minute);
  const clock = time || (Number.isFinite(hour) ? pad(hour) + ":" + pad(Number.isFinite(minute) ? minute : 0) : "");
  if (kind === "daily") return clock ? `每天 ${clock}` : "每天（时间未知）";
  if (kind === "weekly") {
    const days = Array.isArray((s as any).weekdays) ? (s as any).weekdays : [];
    const label = days.length ? days.map((d: number) => "周" + (WEEK[d] || "").slice(1)).join("、") : "每周";
    return clock ? `${label} ${clock}` : label;
  }
  if (kind === "interval") {
    const m = Math.round(Number((s as any).everyMs || 0) / 60000);
    return m > 0 ? (m % 60 === 0 ? `每 ${m / 60} 小时` : `每 ${m} 分钟`) : "每隔一段时间";
  }
  if (kind === "once") return clock ? `仅一次 · ${clock}` : "仅一次";
  if (kind === "cron") return (s as any).expression ? `cron ${(s as any).expression}` : "自定义计划（NOT VERIFIED）";
  return "触发时间未知（NOT VERIFIED）";
}
const ACTION_LABEL: Record<string, string> = {
  agent_instruction: "让助理执行",
  dingtalk_group_notify: "钉钉群通知",
  dingtalk_person_notify: "钉钉个人通知",
  lingxing_cache_sync: "领星数据同步",
  ziniao_download: "紫鸟报表下载",
  ziniao_data_sync: "紫鸟数据同步",
  workflow_sequence: "联动流程",
  app_action: "应用动作",
  music_play: "播放音乐",
  music_control: "音乐控制",
  open_app: "打开应用",
};
const actionText = (a: Action | null | undefined) => (a ? ACTION_LABEL[a.type] || a.type : "—");
function fmt(t: number | null | undefined) {
  if (!t) return "—";
  const d = new Date(t);
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `今天 ${hm}`;
  const tm = new Date(today.getTime() + 86400000);
  if (d.toDateString() === tm.toDateString()) return `明天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
const STATUS: Record<string, string> = { running: "运行中", success: "成功", completed: "成功", failed: "失败", cancelled: "已取消", queued: "排队中" };
const nextText = (a: Def) => (!a.enabled ? "已暂停" : a.nextRunAt ? `下次 ${fmt(a.nextRunAt)}` : "没有下一次");

/* ── 能力可用性（来自 health，不猜） ── */
const desktopReason = computed(() => {
  const d = (health.value?.dependencyDetails || []).find((x: any) => x.name === "desktop");
  return d && !d.injected ? "OpenArc 还没有桌面执行端（播放音乐 / 打开应用），暂不能定时执行" : "";
});
const ACTIONS = [
  { type: "agent_instruction", label: "让助理执行一条指令", group: "常用" },
  { type: "dingtalk_group_notify", label: "发钉钉群通知", group: "集成（需先启用对应集成）" },
  { type: "dingtalk_person_notify", label: "发钉钉个人通知", group: "集成（需先启用对应集成）" },
  { type: "lingxing_cache_sync", label: "同步领星数据", group: "集成（需先启用对应集成）" },
  { type: "ziniao_download", label: "下载紫鸟报表", group: "集成（需先启用对应集成）" },
  { type: "ziniao_data_sync", label: "同步紫鸟数据", group: "集成（需先启用对应集成）" },
];

/* ── 运行记录 ── */
const runs = ref<Run[]>([]);
async function loadRuns(id: string) {
  const r = await send("automation/runs", { automationId: id, limit: 30 });
  if (r.ok && currentId.value === id) runs.value = (val(r).runs || []) as Run[];
}
async function loadAllRuns() {
  const r = await send("automation/runs", { limit: 50 });
  if (r.ok) allRuns.value = (val(r).runs || []) as any[];
}
const autoTitle = (id: string) => items.value.find((a) => a.id === id)?.title || "—";
const runStatus = (st: string) => ({ success: "已完成", completed: "已完成", failed: "失败", running: "执行中", queued: "排队中", stopped: "已暂停" } as Record<string, string>)[st] || st;
const fmtRun = (ts?: number) => {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const runDuration = (r: any) => {
  if (!r.startedAt || !r.finishedAt) return "—";
  const sec = Math.max(0, Math.round((Number(r.finishedAt) - Number(r.startedAt)) / 1000));
  return sec + " s";
};
const stats = computed(() => [
  { label: "运行正常", value: items.value.filter((a) => a.enabled && a.lastStatus !== "failed").length },
  { label: "需要处理", value: items.value.filter((a) => a.lastStatus === "failed").length },
  { label: "今天已运行", value: allRuns.value.filter((r) => r.startedAt && new Date(Number(r.startedAt)).toDateString() === new Date().toDateString()).length },
]);
function open(a: Def) {
  currentId.value = a.id;
  editing.value = false;
  runs.value = [];
  void loadRuns(a.id);
}
const busy = ref<string | null>(null);
watch(view, (v) => {
  if (v === "runs" || v === "all") void loadAllRuns();
});
async function runNow(a: Def) {
  busy.value = "run:" + a.id;
  failure.value = "";
  const r = await send("automation/runNow", { automationId: a.id, clientId: "manual" });
  busy.value = null;
  if (!r.ok) return void (failure.value = errText(r));
  message.value = `已开始运行「${a.title}」`;
  await load();
}
async function cancelRun(run: Run) {
  const r = await send("automation/cancel", { runId: run.id });
  if (!r.ok) failure.value = errText(r);
  if (currentId.value) await loadRuns(currentId.value);
}
async function toggle(a: Def) {
  busy.value = "toggle:" + a.id;
  const r = await send(a.enabled ? "automation/disable" : "automation/enable", { automationId: a.id });
  busy.value = null;
  if (!r.ok) return void (failure.value = errText(r));
  await load();
}
const confirmDel = ref<Def | null>(null);
async function remove() {
  const a = confirmDel.value;
  confirmDel.value = null;
  if (!a) return;
  const r = await send("automation/delete", { automationId: a.id });
  if (!r.ok) return void (failure.value = errText(r));
  message.value = `已删除「${a.title}」`;
  currentId.value = null;
  await load();
}

/* ── 新建 / 编辑 ── */
const editing = ref(false);
const editId = ref<string | null>(null);
const formError = ref("");
const form = reactive({
  title: "",
  actionType: "agent_instruction",
  instruction: "",
  content: "",
  days: 7,
  kind: "daily" as Schedule["type"],
  time: "09:00",
  weekdays: [1] as number[],
  minutes: 60,
  onceAt: "",
  cron: "0 9 * * 1-5",
  retries: 1,
});
function reset() {
  Object.assign(form, { title: "", actionType: "agent_instruction", instruction: "", content: "", days: 7, kind: "daily", time: "09:00", weekdays: [1], minutes: 60, onceAt: "", cron: "0 9 * * 1-5", retries: 1 });
  formError.value = "";
}
function fillFrom(def: { title?: string; instruction?: string; action?: Action; schedule?: Schedule }) {
  reset();
  form.title = def.title || "";
  form.instruction = def.instruction || def.action?.args?.instruction || "";
  const a = def.action;
  if (a) {
    form.actionType = ACTIONS.some((x) => x.type === a.type) ? a.type : "agent_instruction";
    if (a.args?.instruction) form.instruction = String(a.args.instruction);
    if (a.args?.content) form.content = String(a.args.content);
    if (a.args?.days) form.days = Number(a.args.days);
    if (a.retry) form.retries = a.retry.maxAttempts;
  }
  const s = def.schedule;
  if (s) {
    form.kind = s.type;
    if (s.type === "daily" || s.type === "weekly") form.time = `${pad(s.hour)}:${pad(s.minute)}`;
    if (s.type === "weekly") form.weekdays = [...s.weekdays];
    if (s.type === "interval") form.minutes = Math.round(s.everyMs / 60000);
    if (s.type === "once") {
      const d = new Date(s.at);
      form.onceAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    if (s.type === "cron") form.cron = s.expression;
  }
}
function startNew() {
  reset();
  editId.value = null;
  editing.value = true;
  currentId.value = null;
}
function startEdit(a: Def) {
  fillFrom(a);
  editId.value = a.id;
  editing.value = true;
}
function buildSchedule(): Schedule | string {
  const [h, m] = form.time.split(":").map(Number);
  if (form.kind === "daily") return { type: "daily", hour: h, minute: m };
  if (form.kind === "weekly") return form.weekdays.length ? { type: "weekly", weekdays: [...form.weekdays], hour: h, minute: m } : "每周至少选一天";
  if (form.kind === "interval") return Number(form.minutes) >= 5 ? { type: "interval", everyMs: Math.round(Number(form.minutes)) * 60000 } : "间隔至少 5 分钟";
  if (form.kind === "once") {
    const at = form.onceAt ? new Date(form.onceAt).getTime() : NaN;
    return Number.isFinite(at) && at > Date.now() ? { type: "once", at } : "单次执行的时间必须晚于现在";
  }
  return form.cron.trim() ? { type: "cron", expression: form.cron.trim() } : "请填写 cron 表达式";
}
function buildAction(): Action | string {
  const t = form.actionType;
  let args: Record<string, any> = {};
  if (t === "agent_instruction") {
    if (!form.instruction.trim()) return "写一下要让助理做什么";
    args = { instruction: form.instruction.trim() };
  } else if (t === "dingtalk_group_notify" || t === "dingtalk_person_notify") {
    if (!form.content.trim()) return "写一下通知内容";
    args = { content: form.content.trim(), includeResult: false };
  } else args = { days: Number(form.days) || 7 };
  const out: Action = { type: t, args };
  if (form.retries > 1) out.retry = { maxAttempts: Math.min(5, form.retries), delayMs: 60000 };
  return out;
}
async function save() {
  formError.value = "";
  const schedule = buildSchedule();
  if (typeof schedule === "string") return void (formError.value = schedule);
  const action = buildAction();
  if (typeof action === "string") return void (formError.value = action);
  const instruction = form.actionType === "agent_instruction" ? form.instruction.trim() : form.content.trim() || ACTION_LABEL[form.actionType];
  const title = form.title.trim() || instruction.slice(0, 24);
  busy.value = "save";
  const r = editId.value
    ? await send("automation/update", { automationId: editId.value, title, instruction, schedule, action })
    : await send("automation/create", { title, instruction, schedule, action });
  busy.value = null;
  if (!r.ok) return void (formError.value = errText(r));
  const saved = val(r).automation as Def | undefined;
  editing.value = false;
  message.value = editId.value ? `已保存「${title}」` : `已创建「${title}」，到点会自动运行`;
  await load();
  if (saved) open(saved);
}

/* ── 一句话创建（本机规则解析） ── */
const quick = ref("");
const quickError = ref("");
async function parseQuick() {
  quickError.value = "";
  if (!quick.value.trim()) return;
  const r = await send("automation/parse", { instruction: quick.value.trim() });
  if (!r.ok) return void (quickError.value = errText(r));
  const def = val(r).definition;
  if (!def) return void (quickError.value = "没能识别出时间和要做的事，换个说法试试，例如「每天早上 9 点整理桌面截图」");
  fillFrom(def);
  if (!ACTIONS.some((x) => x.type === def.action?.type)) {
    form.actionType = "agent_instruction";
    if (!form.instruction) form.instruction = quick.value.trim();
    quickError.value = def.action?.type ? `识别到的动作「${ACTION_LABEL[def.action.type] || def.action.type}」暂不能定时执行，已改为让助理执行。` : "";
  }
  editId.value = null;
  editing.value = true;
  currentId.value = null;
}

/* ── 旧版（10-15，本机定时）迁移 ── */
const LEGACY = "oa-automations";
type Legacy = { id: string; name: string; goal: string; enabled: boolean; schedule: { kind: string; time?: string; weekday?: number; minutes?: number } };
const legacy = ref<Legacy[]>([]);
function readLegacy() {
  try {
    const v = JSON.parse(localStorage.getItem(LEGACY) || "[]");
    legacy.value = Array.isArray(v) ? v.filter((a: any) => a && typeof a.goal === "string") : [];
  } catch {
    legacy.value = [];
  }
}
const migratable = computed(() => legacy.value.filter((a) => a.schedule && a.schedule.kind !== "manual"));
async function migrate() {
  let ok = 0;
  const left: Legacy[] = [];
  for (const a of legacy.value) {
    const s = a.schedule || { kind: "manual" };
    const [h, m] = String(s.time || "09:00").split(":").map(Number);
    const schedule =
      s.kind === "daily" ? { type: "daily", hour: h, minute: m }
      : s.kind === "weekly" ? { type: "weekly", weekdays: [Number(s.weekday) || 0], hour: h, minute: m }
      : s.kind === "interval" ? { type: "interval", everyMs: Math.max(5, Number(s.minutes) || 60) * 60000 }
      : null;
    if (!schedule) { left.push(a); continue; }
    const r = await send("automation/create", { title: a.name || a.goal.slice(0, 24), instruction: a.goal, schedule, action: { type: "agent_instruction", args: { instruction: a.goal } } });
    if (r.ok) {
      ok += 1;
      if (a.enabled === false && val(r).automation?.id) await send("automation/disable", { automationId: val(r).automation.id });
    } else left.push(a);
  }
  try {
    localStorage.setItem(LEGACY + "-backup", JSON.stringify(legacy.value));
    if (left.length) localStorage.setItem(LEGACY, JSON.stringify(left));
    else localStorage.removeItem(LEGACY);
  } catch {
    /* 存储不可用 */
  }
  readLegacy();
  message.value = `已迁移 ${ok} 个自动化到后台调度` + (left.length ? `；${left.length} 个（仅手动 / 失败）留在本机` : "");
  await load();
}

/* ── 事件：运行状态变化即刷新 ── */
let off: (() => void) | null = null;
let reloadTimer = 0;
function scheduleReload() {
  window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => void load(), 300);
}
onMounted(() => {
  void loadAllRuns();
  readLegacy();
  void load();
  off =
    bridge?.onEvent?.((ev: any) => {
      // 只响应运行生命周期（带 runId）：每条命令本身也会发 begin/completed 进度事件，
      // 对它们刷新会形成「刷新 → 命令 → 事件 → 刷新」的循环。
      const p = ev?.payload || ev;
      if (!p || !p.runId || p.command) return;
      scheduleReload();
    }) ?? null;
});
onBeforeUnmount(() => {
  off?.();
  window.clearTimeout(reloadTimer);
});
</script>

<template>
  <div class="split automation-app" data-automation-app>
    <nav class="split-side au-side" aria-label="自动化">
      <div class="split-section">自动化</div>
      <button type="button" class="split-nav" data-au-tab="overview" :aria-current="view === 'overview' ? 'true' : undefined" @click="view = 'overview'; currentId = null; editing = false"><Activity :size="16" /> <span class="split-nav-label">概览</span></button>
      <button type="button" class="split-nav" data-au-tab="all" :aria-current="view === 'all' ? 'true' : undefined" @click="view = 'all'; currentId = null; editing = false"><List :size="16" /> <span class="split-nav-label">全部自动化</span><small class="au-count">{{ items.length }}</small></button>
      <button type="button" class="split-nav" data-au-tab="runs" :aria-current="view === 'runs' ? 'true' : undefined" @click="view = 'runs'; currentId = null; editing = false"><History :size="16" /> <span class="split-nav-label">运行记录</span></button>
      <div class="split-section">后台服务</div>
      <p class="au-side-note" data-au-health><i class="au-dot-ok" />{{ health?.schedulerRunning ? "运行中 · 每 15 秒检查计划任务" : "调度器未运行" }}</p>
    </nav>

    <div class="split-main au-main">
      <div class="pane-toolbar au-toolbar">
        <strong class="pane-title">{{ editing ? (editId ? "编辑自动化" : "新建自动化") : current ? current.title : ({ overview: "概览", all: "全部自动化", runs: "运行记录" } as any)[view] }}</strong>
        <div class="toolbar-spacer" />
        <button type="button" class="au-primary" data-automation-new @click="startNew"><Plus :size="14" /> 新建自动化</button>
      </div>
      <p v-if="message" class="vd-msg sk-msg" role="status">{{ message }}</p>
      <p v-if="failure" class="vd-msg sk-msg err" role="alert">{{ failure }}</p>

      <div v-if="legacy.length && !editing" class="au-legacy" data-automation-legacy>
        <span>本机还有 {{ legacy.length }} 个旧版自动化（只在窗口开着时运行）。迁移到后台调度后更可靠{{ legacy.length - migratable.length ? `；其中 ${legacy.length - migratable.length} 个是「仅手动」，不迁移` : "" }}。</span>
        <button class="planned-cta" :disabled="!migratable.length" @click="migrate">迁移</button>
      </div>

      <!-- 编辑 -->
      <form v-if="editing" class="au-form" data-automation-form @submit.prevent="save">
        <label>名称<input v-model="form.title" placeholder="例如：每日桌面整理" /></label>
        <label>做什么
          <select v-model="form.actionType">
            <optgroup v-for="g in [...new Set(ACTIONS.map((a) => a.group))]" :key="g" :label="g">
              <option v-for="a in ACTIONS.filter((x) => x.group === g)" :key="a.type" :value="a.type">{{ a.label }}</option>
            </optgroup>
            <option disabled>播放音乐 / 打开应用（暂不可用）</option>
          </select>
        </label>
        <label v-if="form.actionType === 'agent_instruction'">让助理做什么<textarea v-model="form.instruction" rows="4" placeholder="例如：把桌面上今天新增的截图移到「截图」文件夹，并按日期命名" /></label>
        <label v-else-if="form.actionType.startsWith('dingtalk')">通知内容<textarea v-model="form.content" rows="3" placeholder="要发出去的内容" /></label>
        <label v-else>同步最近几天<input v-model.number="form.days" type="number" min="1" max="365" /></label>
        <div class="au-row">
          <label>什么时候
            <select v-model="form.kind">
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="interval">每隔一段时间</option>
              <option value="once">只运行一次</option>
              <option value="cron">cron 表达式</option>
            </select>
          </label>
          <label v-if="form.kind === 'daily' || form.kind === 'weekly'">时间<input v-model="form.time" type="time" /></label>
          <label v-if="form.kind === 'interval'">间隔（分钟）<input v-model.number="form.minutes" type="number" min="5" step="5" /></label>
          <label v-if="form.kind === 'once'">时间<input v-model="form.onceAt" type="datetime-local" /></label>
          <label v-if="form.kind === 'cron'">表达式<input v-model="form.cron" placeholder="分 时 日 月 周，如 0 9 * * 1-5" /></label>
          <label>失败重试
            <select v-model.number="form.retries"><option :value="1">不重试</option><option :value="2">1 次</option><option :value="3">2 次</option></select>
          </label>
        </div>
        <div v-if="form.kind === 'weekly'" class="au-week">
          <label v-for="(w, i) in WEEK" :key="i" class="au-day" :class="{ on: form.weekdays.includes(i) }">
            <input v-model="form.weekdays" type="checkbox" :value="i" />{{ w.slice(1) }}
          </label>
        </div>
        <p class="planned-note">保存即授权它按时执行上面这个动作；停用或删除即撤销。涉及写操作的步骤仍会先请你确认。</p>
        <p v-if="formError" class="vd-msg sk-msg err" role="alert">{{ formError }}</p>
        <div class="au-actions">
          <button type="button" class="planned-today" @click="editing = false">取消</button>
          <button type="submit" class="planned-cta" :disabled="busy === 'save'" data-automation-save>保存</button>
        </div>
      </form>

      <!-- 详情 -->
      <div v-else-if="current" class="au-detail" :data-automation-id="current.id">
        <div class="au-card">
          <div class="au-meta">{{ scheduleText(current.schedule) }} · {{ nextText(current) }} · {{ actionText(current.action) }}</div>
          <p class="au-goal">{{ current.action?.args?.instruction || current.action?.args?.content || current.instruction }}</p>
          <p v-if="current.lastError" class="vd-msg sk-msg err">上次失败：{{ current.lastError }}</p>
          <div class="au-actions">
            <button class="planned-cta" :disabled="busy === 'run:' + current.id || current.lastStatus === 'running'" data-automation-run @click="runNow(current)">
              <Play :size="13" /> 立即运行
            </button>
            <button class="planned-today" @click="toggle(current)">{{ current.enabled ? "暂停" : "启用" }}</button>
            <button class="planned-today" @click="startEdit(current)">编辑</button>
            <div class="toolbar-spacer" />
            <button class="icon-button" aria-label="删除自动化" title="删除" @click="confirmDel = current"><Trash2 :size="14" /></button>
          </div>
        </div>
        <div class="split-section">运行记录</div>
        <p v-if="!runs.length" class="planned-note">还没有运行过。</p>
        <div v-for="r in runs" :key="r.id" class="au-run" :data-run-status="r.status">
          <span class="au-dot" :data-ok="r.status === 'success' || r.status === 'completed'" :data-running="r.status === 'running'" />
          <span>{{ fmt(r.startedAt || r.createdAt) }}</span>
          <span class="au-run-text">{{ STATUS[r.status] || r.status }}{{ r.error ? " · " + r.error : r.result ? " · " + String(r.result).slice(0, 80) : "" }}</span>
          <button v-if="r.status === 'running'" class="planned-today" @click="cancelRun(r)"><Square :size="11" /> 取消</button>
          <button v-else-if="current.action?.type === 'agent_instruction' && (r.status === 'success' || r.status === 'completed')" class="planned-today" @click="shell.activateApp('chat')">在对话中查看</button>
        </div>
      </div>

      <!-- 概览 / 列表 / 运行记录 -->
      <template v-else>
        <template v-if="view === 'runs'">
          <table class="au-runs" data-au-runs>
            <thead><tr><th>时间</th><th>自动化</th><th>结果</th><th>耗时</th></tr></thead>
            <tbody>
              <tr v-for="r in allRuns" :key="r.id" class="au-run-row" :data-run-status="r.status">
                <td class="au-num">{{ fmtRun(r.startedAt) }}</td><td>{{ autoTitle(r.automationId) }}</td>
                <td><span class="badge" :class="{ ok: r.status === 'success' || r.status === 'completed' }">{{ runStatus(r.status) }}</span></td>
                <td class="au-num">{{ runDuration(r) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!allRuns.length" class="set-cap">还没有运行记录。</p>
        </template>

        <template v-else>
          <template v-if="view === 'overview'">
            <div class="au-overview-head"><b class="au-ov-title">让日常工作自己运转</b><p class="au-ov-desc">设置时间和应用动作，OpenArc 会在后台按顺序执行，结果写进通知与运行记录。</p></div>
          </template>
          <template v-if="view === 'overview'">
            <div class="au-stats au-stats-inline">
              <div v-for="st in stats" :key="'all-' + st.label" class="au-stat"><span>{{ st.label }}</span><b>{{ st.value }}</b></div>
            </div>
          </template>
          <template v-else>
          <div class="au-quick">
            <Sparkles :size="15" />
            <input v-model="quick" placeholder="用一句话创建，例如：每周一早上 9 点汇总上周的文稿" aria-label="用一句话创建自动化" data-automation-quick @keydown.enter.prevent="parseQuick" />
            <button class="au-ghost" :disabled="!quick.trim()" @click="parseQuick">生成</button>
          </div>
          <p v-if="quickError" class="vd-msg sk-msg err">{{ quickError }}</p>
          <div v-if="list.length" class="au-list" style="margin-top: 120px">
            <div v-for="a in list" :key="a.id" class="au-rule" :data-au-rule="a.id" :data-automation-item="a.id">
              <Zap :size="16" class="au-zap" />
              <span class="au-rule-main" @click="open(a)">
                <b>{{ a.title }}</b>
                <small>{{ scheduleText(a.schedule) }} · {{ actionText(a.action) }}</small>
                <small v-if="a.lastError" class="au-err">上次运行：{{ a.lastError }}</small>
              </span>
              <span class="au-next">下次 {{ nextText(a).replace(/^下次\s*/, "") }}</span>
              <span class="au-status"><span v-if="a.lastStatus === 'running'" class="badge"><span class="au-spin" />执行中</span><span v-else class="badge" :class="{ ok: a.lastStatus === 'success' || a.lastStatus === 'completed' }">{{ runStatus(a.lastStatus || (a.enabled ? "queued" : "stopped")) }}</span></span>
              <button type="button" class="au-run-one" :disabled="busy === 'run:' + a.id || a.lastStatus === 'running' || !a.enabled" @click.stop="runNow(a)">执行一次</button>
              <span class="au-switch" role="switch" :aria-checked="a.enabled" :aria-label="(a.enabled ? '暂停 ' : '启用 ') + a.title" @click.stop="toggle(a)" />
            </div>
          </div>
          <div v-else-if="!loading" class="empty-content">
            <img class="large-icon" :src="iconUrl('clock')" alt="" draggable="false" />
            <h2 class="planned-title">还没有自动化</h2>
            <p>按时间让助理完成一项任务，例如每天早上整理桌面、每周汇总文稿。{{ desktopReason ? "（" + desktopReason + "）" : "" }}</p>
            <button class="planned-cta" @click="startNew"><Plus :size="14" /> 新建自动化</button>
          </div>
          </template>
          <template v-if="false">
            <div class="split-section au-recent-title">最近运行</div>
            <table class="au-runs">
              <thead><tr><th>时间</th><th>自动化</th><th>结果</th><th>耗时</th></tr></thead>
              <tbody>
                <tr v-for="r in allRuns.slice(0, 3)" :key="'recent-' + r.id" class="au-run-row" :data-run-status="r.status">
                  <td class="au-num">{{ fmtRun(r.startedAt) }}</td><td>{{ autoTitle(r.automationId) }}</td>
                  <td><span class="badge" :class="{ ok: r.status === 'success' || r.status === 'completed' }">{{ runStatus(r.status) }}</span></td>
                  <td class="au-num">{{ runDuration(r) }}</td>
                </tr>
              </tbody>
            </table>
          </template>
        </template>
      </template>
    </div>

    <DsDialog :open="!!confirmDel" title="删除自动化" @close="confirmDel = null">
      <p>删除「{{ confirmDel?.title }}」以及它的运行记录？删除后不再运行，也不能恢复。</p>
      <template #footer>
        <button @click="confirmDel = null">取消</button>
        <button class="primary danger" @click="remove">删除</button>
      </template>
    </DsDialog>
  </div>
</template>
<style scoped>

.au-side { flex: 0 0 200px; width: 200px; }
.au-side .split-nav { height: 32px; min-height: 32px; }
.au-count { margin-left: auto; color: var(--muted); font-size: var(--fs-micro); }
.au-side-note { margin: 4px 10px; color: var(--muted); font-size: var(--fs-caption); line-height: 1.5; }
.au-dot-ok { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #2fb344; margin-right: 6px; }
.au-toolbar { height: 52px; min-height: 52px; margin: 0; padding: 0 20px; border-bottom: 0.5px solid var(--line); }
.au-app .split-main, .automation-app .split-main { padding: 0 !important; margin-left: -8px !important; }
.au-primary { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 12px; border-radius: var(--radius-pill); background: var(--text); color: var(--content); font-size: var(--fs-caption); }
.au-overview { padding: 20px 24px; }
.au-ov-title { font-size: 18px; font-weight: var(--fw-medium); }
.au-ov-desc { margin: 4px 0 0; color: var(--muted); font-size: var(--fs-secondary); }
.au-stats { display: flex; gap: 12px; margin-top: 18px; }
.au-stat { flex: 1; padding: 14px 16px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); display: flex; flex-direction: column; gap: 6px; }
.au-stat span { color: var(--muted); font-size: var(--fs-micro); }
.au-stat b { font-size: 28px; font-weight: var(--fw-medium); font-variant-numeric: tabular-nums; }
.au-quick { display: flex; align-items: center; gap: 8px; margin: 14px 24px 10px; padding: 0 10px; height: 34px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.05); }
.au-quick input { flex: 1; min-width: 0; background: transparent; border: 0; outline: 0; font-size: var(--fs-caption); }
.au-ghost { height: 24px; padding: 0 10px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.08); font-size: var(--fs-micro); }
.au-list { margin: 0 24px; border-radius: var(--radius-lg); overflow: hidden; }
.au-rule { display: flex; align-items: center; gap: 10px; min-height: 60px; padding: 0 12px; border-bottom: 0.5px solid var(--line); }
.au-zap { color: var(--muted); flex: none; }
.au-rule-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; cursor: default; }
.au-rule-main b { font-size: var(--fs-secondary); font-weight: var(--fw-medium); }
.au-rule-main small { color: var(--muted); font-size: var(--fs-micro); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.au-err { color: var(--warn, #b26a00) !important; }
.au-next { width: 96px; flex: none; color: var(--muted); font-size: var(--fs-micro); }
.au-status { width: 100px; flex: none; }
.au-run-one { height: 26px; padding: 0 10px; border-radius: var(--radius-pill); font-size: var(--fs-micro); color: var(--muted); }
.au-run-one:disabled { opacity: 0.4; }
.au-switch { flex: none; }
.au-spin { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid currentColor; border-top-color: transparent; display: inline-block; animation: au-spin 0.8s linear infinite; }
@keyframes au-spin { to { transform: rotate(360deg); } }
.au-runs { width: calc(100% - 48px); margin: 14px 24px 0; border-collapse: collapse; font-size: var(--fs-caption); }
.au-runs th { text-align: left; height: 30px; color: var(--muted); font-size: 12px; font-weight: var(--fw-regular); border-bottom: 0.5px solid var(--line); }
.au-runs td { height: 41px; border-bottom: 0.5px solid var(--line); }
.au-num { color: var(--muted); font-variant-numeric: tabular-nums; }
.au-recent-title { margin: 18px 24px 0; color: var(--muted); font-size: var(--fs-micro); }

.au-side { padding-left: 10px; padding-right: 8px; }
.au-side .split-section { padding: 8px 10px 6px; }
.au-stats-inline { margin: 14px 24px 10px; }
.au-primary { min-width: 111px; justify-content: center; }

.automation-app .split-main { padding: 0 !important; }
.au-list { margin-left: 24px !important; margin-right: 24px !important; }
.au-rule { margin: 0; }
.au-overview-head { padding: 16px 24px 0; }
.au-stats-inline { margin: 14px 24px 8px; }
.au-stat { padding: 16px 16px; }
.au-switch { margin-left: 12px; }

.au-side .split-section:first-child { margin-top: -24px; }
.au-list { margin: 0 !important; padding: 0 24px; }
.au-rule { min-height: 63.7px; }
.au-status { width: 66px; }
.au-status .badge { white-space: nowrap; }
.au-stat { padding: 18px 16px; }
.au-switch { margin-left: auto; margin-right: 8px; }

.au-overview-head { padding-top: 10px; }
.au-stat { padding: 16px; }
.au-stats-inline { margin: 8px 24px 8px; }
.au-status { width: 66px; height: 20px; display: flex; align-items: center; position: relative; left: -50px; }

.au-stats-inline { margin-top: 14px; margin-bottom: 18px; }

.au-rule .au-switch { width: 36px; }

.au-primary { background: var(--text) !important; color: #fff !important; white-space: nowrap; overflow: visible; }
.au-status { position: static !important; left: 0 !important; }
.au-run-one { width: 100px; flex: none; }
.au-switch { width: 36px; height: 21px; border-radius: 999px; background: rgb(var(--text-rgb) / 0.2); position: relative; display: inline-block; flex: none; }
.au-switch::after { content: ""; position: absolute; width: 17px; height: 17px; border-radius: 50%; background: #fff; top: 2px; left: 2px; transition: left 160ms ease; }
.au-switch[aria-checked="true"] { background: rgb(var(--text-rgb) / 0.85); }
.au-switch[aria-checked="true"]::after { left: 17px; }

.au-run-one { width: 110px; }

.au-list { margin-top: 120px !important; }
</style>
