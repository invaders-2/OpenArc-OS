<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { CalendarClock, ChevronLeft, MessageSquare, MoreHorizontal, Pause, Pencil, Play, Plus, Trash2 } from "lucide-vue-next";
import DsDialog from "../../design-system/DsDialog.vue";

/**
 * 对话里的「自动化」（对标 ChatGPT 定时任务 / Codex 自动化 / Claude 定时任务）：
 *   · 一条自动化 = 名称 + 提示词 + 时间 + 模型；到点由主进程调度器（automation 域，动作 chat_task）
 *     以当前登录用户新开一段全局 AI 对话执行，对话出现在左侧列表里；
 *   · 每次运行记下它开的那段对话，点开就能看；对话的实时状态从 task 列表取（审批 / 失败都在对话里处理）；
 *   · 只列 chat_task 类自动化，其余动作（钉钉 / 领星 …）在「自动化」应用里管理。
 */
type Task = { taskId: string; status: string; updatedAt: number };
type ModelOption = { configId: string; displayName: string; providerName: string; isDefault: boolean };
type Schedule =
  | { type: "daily"; hour: number; minute: number; timezone?: string }
  | { type: "weekly"; weekdays: number[]; hour: number; minute: number; timezone?: string }
  | { type: "interval"; everyMs: number; anchor?: number; timezone?: string }
  | { type: "once"; at: number; timezone?: string }
  | { type: "cron"; expression: string; timezone?: string };
type Run = { id: string; status: string; result: string | null; error: string | null; createdAt: number; startedAt: number | null; completedAt: number | null };
type Def = {
  id: string; title: string; instruction: string; schedule: Schedule; enabled: boolean;
  action: { type: string; args?: { prompt?: string; modelConfigId?: string } };
  nextRunAt: number | null; lastRunAt: number | null; lastStatus: string | null; lastError: string | null; runs?: Run[];
};

const props = defineProps<{ tasks: Task[]; models: ModelOption[]; defaultModelId: string }>();
const emit = defineEmits<{ open: [taskId: string]; changed: [map: Record<string, string>, enabledCount: number] }>();

const bridge = (window as any).openarc?.automation as { command: (c: Record<string, unknown>) => Promise<any>; onEvent?: (fn: (ev: any) => void) => () => void } | undefined;
type Res = { ok?: boolean; value?: any; error?: string; message?: string };
async function call(command: string, payload: Record<string, unknown> = {}): Promise<Res> {
  if (!bridge?.command) return { ok: false, error: "NO_BRIDGE" };
  try { return (await bridge.command({ command, payload })) || { ok: false, error: "AUTOMATION_INTERNAL" }; } catch { return { ok: false, error: "AUTOMATION_INTERNAL" }; }
}
const val = (r: Res) => (r.value && typeof r.value === "object" ? r.value : (r as any));
const ERR: Record<string, string> = {
  NO_BRIDGE: "自动化只在 OpenArc 桌面应用里可用", AUTOMATION_INVALID_INPUT: "填写的内容不完整或不正确", AUTOMATION_UNAUTHENTICATED: "请先登录",
  AUTOMATION_FORBIDDEN: "没有权限", AUTOMATION_NOT_FOUND: "这条自动化已不存在", AUTOMATION_CONFLICT: "它正在运行，稍后再试",
  AGENT_DEPENDENCY_UNAVAILABLE: "全局 AI 还没就绪", AUTOMATION_INTERNAL: "自动化服务出错",
};
const errText = (r: Res) => {
  const msg = typeof r.message === "string" && r.message && !/^[A-Z_]+$/.test(r.message) ? r.message : "";
  return msg || ERR[String(r.error)] || "操作失败（" + String(r.error || "UNKNOWN") + "）";
};

const items = ref<Def[]>([]);
const loading = ref(true);
const failure = ref("");
const notice = ref("");
const busy = ref("");
const currentId = ref<string | null>(null);
const current = computed(() => items.value.find((a) => a.id === currentId.value) || null);
const menuFor = ref<string | null>(null);
const confirmDel = ref<Def | null>(null);
let noticeTimer = 0;
function flash(text: string) { notice.value = text; window.clearTimeout(noticeTimer); noticeTimer = window.setTimeout(() => { notice.value = ""; }, 3500); }

async function load() {
  const r = await call("automation/list");
  loading.value = false;
  if (!r.ok) { failure.value = errText(r); return; }
  failure.value = "";
  items.value = ((val(r).automations || []) as Def[]).filter((a) => a.action?.type === "chat_task");
  emit("changed", taskMap.value, items.value.filter((a) => a.enabled).length);
}

/* ── 运行记录 → 它开的那段对话 ── */
function taskIdOf(run: Run): string | null {
  if (!run.result) return null;
  try { const v = JSON.parse(run.result); const id = v?.output?.taskId; return typeof id === "string" ? id : null; } catch { return null; }
}
/** taskId → 自动化名：左侧对话列表据此给自动化开的对话加标记。 */
const taskMap = computed(() => {
  const out: Record<string, string> = {};
  for (const a of items.value) for (const r of a.runs || []) { const id = taskIdOf(r); if (id) out[id] = a.title; }
  return out;
});
const TASK_STATUS: Record<string, string> = { PENDING: "排队中", RUNNING: "执行中", WAITING: "等待你确认", BLOCKED: "已停下", SUCCEEDED: "已完成", COMPLETED: "已完成", FAILED: "失败", CANCELLED: "已取消" };
function runState(run: Run): { text: string; tone: "ok" | "run" | "wait" | "bad" | "idle" } {
  const id = taskIdOf(run);
  const t = id ? props.tasks.find((x) => x.taskId === id) : null;
  if (t) {
    const s = t.status;
    const tone = s === "SUCCEEDED" || s === "COMPLETED" ? "ok" : s === "WAITING" || s === "BLOCKED" ? "wait" : s === "FAILED" || s === "CANCELLED" ? "bad" : "run";
    return { text: TASK_STATUS[s] || s, tone };
  }
  if (run.status === "running") return { text: "正在启动", tone: "run" };
  if (run.status === "failed") return { text: "没有运行：" + (run.error || "失败"), tone: "bad" };
  if (run.status === "cancelled") return { text: "已取消", tone: "bad" };
  return { text: id ? "对话已从列表删除" : "已完成", tone: "idle" };
}

/* ── 文案 ── */
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n: number) => String(n).padStart(2, "0");
function scheduleText(s: Schedule | null | undefined) {
  if (!s) return "时间未知";
  if (s.type === "daily") return "每天 " + pad(s.hour) + ":" + pad(s.minute);
  if (s.type === "weekly") {
    const d = [...s.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const label = d.length === 5 && [1, 2, 3, 4, 5].every((x) => d.includes(x)) ? "工作日" : d.length === 7 ? "每天" : "每周" + d.map((x) => WEEK[x]).join("、");
    return label + " " + pad(s.hour) + ":" + pad(s.minute);
  }
  if (s.type === "interval") { const m = Math.round(s.everyMs / 60000); return m % 60 === 0 ? "每 " + m / 60 + " 小时" : "每 " + m + " 分钟"; }
  if (s.type === "once") return "一次 · " + fmt(s.at);
  if (s.type === "cron") return "cron " + s.expression;
  return "时间未知";
}
function fmt(t: number | null | undefined) {
  if (!t) return "—";
  const d = new Date(t);
  const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "今天 " + hm;
  if (d.toDateString() === new Date(today.getTime() + 86400000).toDateString()) return "明天 " + hm;
  if (d.toDateString() === new Date(today.getTime() - 86400000).toDateString()) return "昨天 " + hm;
  return d.getMonth() + 1 + "/" + d.getDate() + " " + hm;
}
/** 列表 / 详情里的一行时间：一次性的不再重复「下次」。 */
const planText = (a: Def) => (a.schedule?.type === "once" && a.enabled && a.nextRunAt ? scheduleText(a.schedule) : scheduleText(a.schedule) + " · " + nextText(a));
const nextText = (a: Def) => (!a.enabled ? "已暂停" : a.nextRunAt ? "下次 " + fmt(a.nextRunAt) : "不会再运行");
const modelName = (id?: string) => {
  const m = props.models.find((x) => x.configId === (id || props.defaultModelId));
  return id ? m?.displayName || "已不可用的模型" : "默认模型" + (m ? "（" + m.displayName + "）" : "");
};

/* ── 新建 / 编辑 ── */
type Kind = "daily" | "weekdays" | "weekly" | "interval" | "once";
const editing = ref<null | { id: string | null }>(null);
const form = reactive({ title: "", prompt: "", kind: "daily" as Kind, time: "09:00", weekdays: [1] as number[], every: 1, unit: "hour" as "min" | "hour", onceAt: "", modelConfigId: "" });
const formError = ref("");
function localInput(t: number) { const d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function startNew(preset?: Partial<typeof form>) {
  Object.assign(form, { title: "", prompt: "", kind: "daily", time: "09:00", weekdays: [1], every: 1, unit: "hour", onceAt: localInput(Date.now() + 3600000), modelConfigId: "" }, preset || {});
  formError.value = ""; editing.value = { id: null };
}
function startEdit(a: Def) {
  menuFor.value = null;
  const s = a.schedule;
  Object.assign(form, { title: a.title, prompt: a.action.args?.prompt || a.instruction, modelConfigId: a.action.args?.modelConfigId || "", time: "09:00", weekdays: [1], every: 1, unit: "hour", onceAt: localInput(Date.now() + 3600000) });
  if (s.type === "daily") Object.assign(form, { kind: "daily", time: pad(s.hour) + ":" + pad(s.minute) });
  else if (s.type === "weekly") {
    const wd = [...s.weekdays].sort();
    Object.assign(form, { kind: wd.join() === "1,2,3,4,5" ? "weekdays" : "weekly", weekdays: wd, time: pad(s.hour) + ":" + pad(s.minute) });
  } else if (s.type === "interval") { const m = Math.round(s.everyMs / 60000); Object.assign(form, { kind: "interval", every: m % 60 === 0 ? m / 60 : m, unit: m % 60 === 0 ? "hour" : "min" }); }
  else if (s.type === "once") Object.assign(form, { kind: "once", onceAt: localInput(s.at) });
  formError.value = ""; editing.value = { id: a.id };
}
function toggleDay(d: number) { form.weekdays = form.weekdays.includes(d) ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d]; }
function buildSchedule(): Schedule | string {
  const [h, m] = form.time.split(":").map(Number);
  const clockOk = Number.isInteger(h) && Number.isInteger(m);
  if (form.kind === "daily") return clockOk ? { type: "daily", hour: h, minute: m } : "请选择时间";
  if (form.kind === "weekdays") return clockOk ? { type: "weekly", weekdays: [1, 2, 3, 4, 5], hour: h, minute: m } : "请选择时间";
  if (form.kind === "weekly") return !form.weekdays.length ? "至少选一天" : clockOk ? { type: "weekly", weekdays: [...form.weekdays].sort(), hour: h, minute: m } : "请选择时间";
  if (form.kind === "interval") {
    const minutes = Math.round(Number(form.every) * (form.unit === "hour" ? 60 : 1));
    return minutes >= 5 ? { type: "interval", everyMs: minutes * 60000 } : "最短每 5 分钟运行一次";
  }
  const at = new Date(form.onceAt).getTime();
  return Number.isFinite(at) && at > Date.now() ? { type: "once", at } : "请选一个以后的时间";
}
async function save() {
  const prompt = form.prompt.trim();
  if (!prompt) { formError.value = "请写下要让 AI 做的事"; return; }
  const schedule = buildSchedule();
  if (typeof schedule === "string") { formError.value = schedule; return; }
  const title = form.title.trim() || prompt.replace(/\s+/g, " ").slice(0, 24);
  const definition = { title, instruction: prompt, schedule: { ...schedule, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined }, action: { type: "chat_task", args: { prompt, ...(form.modelConfigId ? { modelConfigId: form.modelConfigId } : {}) } } };
  busy.value = "save";
  const id = editing.value?.id;
  const r = id ? await call("automation/update", { automationId: id, definition }) : await call("automation/create", { definition });
  busy.value = "";
  if (!r.ok) { formError.value = errText(r); return; }
  editing.value = null;
  const saved = val(r).automation as Def | undefined;
  await load();
  if (saved?.id) currentId.value = saved.id;
  flash(id ? "已保存" : "已创建，" + (saved ? nextText(saved) : "会按时运行"));
}

/* ── 操作 ── */
async function runNow(a: Def) {
  menuFor.value = null; busy.value = "run:" + a.id;
  const r = await call("automation/runNow", { automationId: a.id });
  busy.value = "";
  if (!r.ok) { flash(errText(r)); return; }
  flash("已开始运行，会新开一段对话");
  window.setTimeout(load, 800); window.setTimeout(load, 2500);
}
async function toggle(a: Def) {
  menuFor.value = null;
  const r = await call(a.enabled ? "automation/disable" : "automation/enable", { automationId: a.id });
  if (!r.ok) { flash(errText(r)); return; }
  await load();
}
async function remove() {
  const a = confirmDel.value; if (!a) return;
  confirmDel.value = null;
  const r = await call("automation/delete", { automationId: a.id });
  if (!r.ok) { flash(errText(r)); return; }
  if (currentId.value === a.id) currentId.value = null;
  await load(); flash("已删除「" + a.title + "」");
}

const TEMPLATES: { title: string; desc: string; preset: Partial<typeof form> }[] = [
  { title: "每日行业早报", desc: "每天 9:00", preset: { title: "每日行业早报", kind: "daily", time: "09:00", prompt: "联网搜索过去 24 小时 AI 行业的重要新闻，挑 5 条最值得关注的，用中文各写两三句话总结，并附上来源链接。" } },
  { title: "工作日待办整理", desc: "工作日 8:30", preset: { title: "工作日待办整理", kind: "weekdays", time: "08:30", prompt: "查看工作文件夹里最近一天新增或修改的文件，帮我列出今天需要跟进的事项，按优先级排好。" } },
  { title: "每周工作回顾", desc: "每周五 17:30", preset: { title: "每周工作回顾", kind: "weekly", weekdays: [5], time: "17:30", prompt: "回顾这周工作文件夹里的变化，写一份简短的周报：本周进展、遇到的问题、下周计划。" } },
  { title: "网页变化监测", desc: "每 2 小时", preset: { title: "网页变化监测", kind: "interval", every: 2, unit: "hour", prompt: "打开 https://example.com ，看看和上次相比有没有新内容；有的话总结变化，没有就回复「没有变化」。" } },
];

let off: (() => void) | null = null;
let reloadTimer = 0;
function onDocDown(e: MouseEvent) { if (!(e.target as HTMLElement).closest?.("[data-auto-menu],[data-auto-more]")) menuFor.value = null; }
onMounted(() => {
  void load();
  document.addEventListener("mousedown", onDocDown);
  off = bridge?.onEvent?.((ev: any) => {
    const p = ev?.payload || ev;
    if (!p || !p.runId || p.command) return; // 只看运行生命周期
    window.clearTimeout(reloadTimer); reloadTimer = window.setTimeout(load, 300);
  }) ?? null;
});
onBeforeUnmount(() => { off?.(); document.removeEventListener("mousedown", onDocDown); window.clearTimeout(reloadTimer); window.clearTimeout(noticeTimer); });
defineExpose({ startNew, reload: load });
</script>

<template>
  <div class="auto" data-chat-automations>
    <div class="pane-toolbar auto-toolbar">
      <button v-if="current" type="button" class="auto-icon" data-auto-back aria-label="返回自动化列表" title="返回" @click="currentId = null"><ChevronLeft :size="16" /></button>
      <strong class="pane-title auto-title">{{ current ? current.title : "自动化" }}</strong>
      <div class="toolbar-spacer" />
      <button type="button" class="auto-primary" data-auto-new @click="startNew()"><Plus :size="14" />新建自动化</button>
    </div>

    <div class="auto-scroll">
      <div class="auto-col">
        <p v-if="failure" class="auto-msg bad" role="alert">{{ failure }}</p>

        <!-- 详情 -->
        <template v-if="current">
          <section class="auto-card" :data-auto-detail="current.id">
            <div class="auto-meta"><CalendarClock :size="13" />{{ planText(current) }} · {{ modelName(current.action.args?.modelConfigId) }}</div>
            <p class="auto-prompt">{{ current.action.args?.prompt || current.instruction }}</p>
            <p v-if="current.lastError" class="auto-msg bad">上次没有运行成功：{{ current.lastError }}</p>
            <div class="auto-actions">
              <button type="button" class="auto-btn strong" data-auto-run :disabled="busy === 'run:' + current.id || current.lastStatus === 'running'" @click="runNow(current)"><Play :size="13" />立即运行</button>
              <button type="button" class="auto-btn" data-auto-toggle @click="toggle(current)"><Pause v-if="current.enabled" :size="13" /><Play v-else :size="13" />{{ current.enabled ? "暂停" : "启用" }}</button>
              <button type="button" class="auto-btn" data-auto-edit @click="startEdit(current)"><Pencil :size="13" />编辑</button>
              <div class="toolbar-spacer" />
              <button type="button" class="auto-btn danger" data-auto-delete @click="confirmDel = current"><Trash2 :size="13" />删除</button>
            </div>
          </section>
          <div class="auto-section">运行记录</div>
          <p v-if="!(current.runs || []).length" class="auto-empty-line">还没有运行过。点「立即运行」先试一次，确认结果符合预期。</p>
          <div v-for="r in current.runs || []" :key="r.id" class="auto-run" :data-auto-run-row="r.id">
            <span class="auto-dot" :data-tone="runState(r).tone" />
            <span class="auto-run-time">{{ fmt(r.startedAt || r.createdAt) }}</span>
            <span class="auto-run-text">{{ runState(r).text }}</span>
            <button v-if="taskIdOf(r) && tasks.some((t) => t.taskId === taskIdOf(r))" type="button" class="auto-btn" :data-auto-open="taskIdOf(r)" @click="emit('open', taskIdOf(r)!)"><MessageSquare :size="13" />查看对话</button>
          </div>
        </template>

        <!-- 列表 -->
        <template v-else>
          <div class="auto-head">
            <h2>让 AI 按时替你做事</h2>
            <p>写好要做的事，选好时间。到点 AI 会新开一段对话去完成，完成后通知你。OpenArc 开着并已登录时才会运行；写文件、执行命令等操作仍会等你确认。</p>
          </div>
          <div v-if="items.length" class="auto-list">
            <div v-for="a in items" :key="a.id" class="auto-item" :data-auto-item="a.id" :data-enabled="a.enabled">
              <button type="button" class="auto-item-main" @click="currentId = a.id">
                <span class="auto-item-icon"><CalendarClock :size="16" /></span>
                <span class="auto-item-text">
                  <b>{{ a.title }}</b>
                  <small>{{ planText(a) }}</small>
                  <small v-if="a.runs && a.runs.length" class="auto-item-last"><span class="auto-dot" :data-tone="runState(a.runs[0]).tone" />上次 {{ fmt(a.runs[0].startedAt || a.runs[0].createdAt) }} · {{ runState(a.runs[0]).text }}</small>
                </span>
              </button>
              <span class="auto-switch" role="switch" tabindex="0" :aria-checked="a.enabled" :data-auto-switch="a.id" :aria-label="(a.enabled ? '暂停 ' : '启用 ') + a.title" @click="toggle(a)" @keydown.enter.space.prevent="toggle(a)" />
              <div class="auto-more-wrap">
                <button type="button" class="auto-icon" :data-auto-more="a.id" aria-label="更多操作" title="更多" @click="menuFor = menuFor === a.id ? null : a.id"><MoreHorizontal :size="15" /></button>
                <div v-if="menuFor === a.id" class="auto-menu" data-auto-menu role="menu">
                  <button type="button" role="menuitem" data-auto-menu-run @click="runNow(a)"><Play :size="13" />立即运行</button>
                  <button type="button" role="menuitem" @click="startEdit(a)"><Pencil :size="13" />编辑</button>
                  <button type="button" role="menuitem" class="danger" @click="menuFor = null; confirmDel = a"><Trash2 :size="13" />删除</button>
                </div>
              </div>
            </div>
          </div>
          <template v-if="!loading">
            <div class="auto-section">{{ items.length ? "从模板新建" : "从模板开始" }}</div>
            <div class="auto-templates">
              <button v-for="t in TEMPLATES" :key="t.title" type="button" class="auto-template" :data-auto-template="t.title" @click="startNew(t.preset)">
                <b>{{ t.title }}</b><small>{{ t.desc }}</small><span>{{ t.preset.prompt }}</span>
              </button>
            </div>
          </template>
        </template>
      </div>
    </div>

    <div v-if="notice" class="auto-toast" role="status" data-auto-toast>{{ notice }}</div>

    <DsDialog :open="!!editing" :title="editing?.id ? '编辑自动化' : '新建自动化'" @close="editing = null">
      <form class="auto-form" data-auto-form @submit.prevent="save">
        <label class="auto-field"><span>名称</span><input v-model="form.title" data-auto-title maxlength="60" placeholder="例如：每日行业早报" /></label>
        <label class="auto-field"><span>要让 AI 做的事</span><textarea v-model="form.prompt" data-auto-prompt rows="5" maxlength="20000" placeholder="像在对话里一样写清楚要做什么、结果要什么样。可以用联网搜索、技能和工作文件夹。" /></label>
        <div class="auto-field">
          <span>频率</span>
          <div class="auto-seg" role="radiogroup" aria-label="频率">
            <button v-for="k in ([['daily', '每天'], ['weekdays', '工作日'], ['weekly', '每周'], ['interval', '每隔'], ['once', '一次']] as const)" :key="k[0]" type="button" role="radio" :aria-checked="form.kind === k[0]" :data-auto-kind="k[0]" @click="form.kind = k[0]; formError = ''">{{ k[1] }}</button>
          </div>
        </div>
        <div v-if="form.kind === 'weekly'" class="auto-days" aria-label="星期">
          <button v-for="d in [1, 2, 3, 4, 5, 6, 0]" :key="d" type="button" :aria-pressed="form.weekdays.includes(d)" :data-auto-day="d" @click="toggleDay(d)">{{ WEEK[d] }}</button>
        </div>
        <div class="auto-row">
          <label v-if="form.kind === 'daily' || form.kind === 'weekdays' || form.kind === 'weekly'" class="auto-field"><span>时间</span><input v-model="form.time" type="time" data-auto-time /></label>
          <div v-else-if="form.kind === 'interval'" class="auto-field">
            <span>间隔</span>
            <div class="auto-inline"><input v-model.number="form.every" type="number" min="1" max="1000" data-auto-every /><select v-model="form.unit" data-auto-unit><option value="min">分钟</option><option value="hour">小时</option></select></div>
          </div>
          <label v-else class="auto-field"><span>运行时间</span><input v-model="form.onceAt" type="datetime-local" data-auto-once /></label>
          <label class="auto-field"><span>模型</span>
            <select v-model="form.modelConfigId" data-auto-model>
              <option value="">默认模型</option>
              <option v-for="m in models" :key="m.configId" :value="m.configId">{{ m.displayName }} · {{ m.providerName }}</option>
            </select>
          </label>
        </div>
        <p class="auto-note">每次运行都会新开一段对话。需要你确认的操作会停在那段对话里等你。</p>
        <p v-if="formError" class="auto-msg bad" role="alert" data-auto-form-error>{{ formError }}</p>
      </form>
      <template #footer>
        <button type="button" @click="editing = null">取消</button>
        <button type="button" class="primary" data-auto-save :disabled="busy === 'save'" @click="save">{{ editing?.id ? "保存" : "创建" }}</button>
      </template>
    </DsDialog>

    <DsDialog :open="!!confirmDel" title="删除自动化" @close="confirmDel = null">
      <p>删除「{{ confirmDel?.title }}」？之后不再运行，运行记录也会删除。它开过的对话会保留。</p>
      <template #footer>
        <button type="button" @click="confirmDel = null">取消</button>
        <button type="button" class="primary danger" data-auto-confirm-delete @click="remove">删除</button>
      </template>
    </DsDialog>
  </div>
</template>

<style scoped>
.auto { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.auto-toolbar { gap: 8px; height: 52px; margin: 0; padding: 0 12px 0 20px; flex: none; }
.auto-title { font-size: var(--fs-headline); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.auto-icon { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--radius-md); color: var(--muted); }
.auto-icon:hover { background: rgb(var(--text-rgb) / 0.07); color: var(--text); }
.auto-primary { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 12px; border-radius: var(--radius-pill); background: var(--text); color: rgb(var(--content-rgb)); font-size: var(--fs-caption); }
.auto-scroll { flex: 1; min-height: 0; overflow: auto; padding: 20px 24px 32px; }
.auto-col { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 10px; }
.auto-head h2 { margin: 6px 0 4px; font-size: var(--fs-title); font-weight: var(--fw-medium); }
.auto-head p { margin: 0 0 6px; color: var(--muted); font-size: var(--fs-secondary); line-height: var(--lh-relaxed); }
.auto-section { margin-top: 12px; font-size: var(--fs-caption); color: var(--muted); }
.auto-list { display: flex; flex-direction: column; gap: 6px; }
.auto-item { display: flex; align-items: center; gap: 10px; padding: 4px 8px 4px 4px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); }
.auto-item[data-enabled="false"] .auto-item-text { opacity: 0.55; }
.auto-item-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 8px; text-align: left; color: var(--text); border-radius: var(--radius-md); }
.auto-item-icon { flex: none; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: rgb(var(--content-rgb)); color: var(--text); }
.auto-item-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.auto-item-text b { font-size: var(--fs-secondary); font-weight: var(--fw-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.auto-item-text small { display: flex; align-items: center; gap: 5px; color: var(--muted); font-size: var(--fs-caption); }
.auto-switch { flex: none; position: relative; width: 32px; height: 18px; border-radius: 9px; background: rgb(var(--text-rgb) / 0.18); cursor: pointer; transition: background var(--quick, 0.15s); }
.auto-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 0.25); transition: transform var(--quick, 0.15s); }
.auto-switch[aria-checked="true"] { background: #34c759; }
.auto-switch[aria-checked="true"]::after { transform: translateX(14px); }
.auto-more-wrap { position: relative; }
.auto-menu { position: absolute; right: 0; top: 30px; z-index: 20; min-width: 132px; padding: 4px; border-radius: var(--radius-lg); background: rgb(var(--content-rgb)); box-shadow: 0 6px 24px rgb(0 0 0 / 0.16), 0 0 0 0.5px var(--line); display: flex; flex-direction: column; }
.auto-menu button { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: var(--radius-md); font-size: var(--fs-secondary); color: var(--text); text-align: left; }
.auto-menu button:hover { background: rgb(var(--text-rgb) / 0.06); }
.auto-menu .danger, .auto-btn.danger { color: var(--failed); }
.auto-templates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.auto-template { display: flex; flex-direction: column; gap: 3px; padding: 12px 14px; border-radius: var(--radius-lg); text-align: left; color: var(--text); box-shadow: inset 0 0 0 0.5px var(--line); }
.auto-template:hover { background: rgb(var(--text-rgb) / 0.035); }
.auto-template b { font-size: var(--fs-secondary); font-weight: var(--fw-medium); }
.auto-template small { color: var(--muted); font-size: var(--fs-caption); }
.auto-template span { margin-top: 4px; color: var(--muted); font-size: var(--fs-caption); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.auto-card { padding: 14px 16px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); display: flex; flex-direction: column; gap: 10px; }
.auto-meta { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: var(--fs-caption); }
.auto-prompt { margin: 0; white-space: pre-wrap; font-size: var(--fs-body); line-height: 1.7; }
.auto-actions { display: flex; align-items: center; gap: 6px; }
.auto-btn { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px; border-radius: var(--radius-pill); font-size: var(--fs-caption); color: var(--text); box-shadow: inset 0 0 0 0.5px var(--line); background: rgb(var(--content-rgb)); }
.auto-btn:hover:not(:disabled) { background: rgb(var(--text-rgb) / 0.05); }
.auto-btn:disabled { opacity: 0.5; }
.auto-btn.strong { background: var(--text); color: rgb(var(--content-rgb)); box-shadow: none; }
.auto-run { display: flex; align-items: center; gap: 10px; padding: 8px 4px; border-bottom: 0.5px solid var(--line); font-size: var(--fs-secondary); }
.auto-run-time { flex: none; width: 92px; color: var(--muted); font-size: var(--fs-caption); font-variant-numeric: tabular-nums; }
.auto-run-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.auto-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: rgb(var(--text-rgb) / 0.3); }
.auto-dot[data-tone="ok"] { background: #34c759; }
.auto-dot[data-tone="run"] { background: #0a84ff; }
.auto-dot[data-tone="wait"] { background: #ff9f0a; }
.auto-dot[data-tone="bad"] { background: var(--failed); }
.auto-empty-line, .auto-note { margin: 0; color: var(--muted); font-size: var(--fs-caption); line-height: 1.6; }
.auto-msg { margin: 0; font-size: var(--fs-caption); }
.auto-msg.bad { color: var(--failed); }
.auto-toast { position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%); padding: 8px 14px; border-radius: var(--radius-pill); background: var(--text); color: rgb(var(--content-rgb)); font-size: var(--fs-caption); box-shadow: 0 6px 20px rgb(0 0 0 / 0.18); }
.auto-form { display: flex; flex-direction: column; gap: 12px; width: min(520px, 76vw); max-width: 100%; }
.auto-field { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 0; }
.auto-field > span { font-size: var(--fs-caption); color: var(--muted); }
.auto-field input, .auto-field textarea, .auto-field select { box-sizing: border-box; width: 100%; padding: 7px 10px; border-radius: var(--radius-md); border: 0.5px solid var(--line); background: rgb(var(--content-rgb)); color: var(--text); font: inherit; font-size: var(--fs-secondary); }
.auto-field textarea { resize: vertical; line-height: 1.6; }
.auto-row { display: flex; gap: 12px; }
.auto-inline { display: flex; gap: 6px; }
.auto-inline input { width: 90px; flex: none; }
.auto-seg { display: inline-flex; padding: 2px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.06); align-self: flex-start; }
.auto-seg button { padding: 4px 12px; border-radius: var(--radius-pill); font-size: var(--fs-caption); color: var(--muted); }
.auto-seg button[aria-checked="true"] { background: rgb(var(--content-rgb)); color: var(--text); box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }
.auto-days { display: flex; gap: 6px; }
.auto-days button { width: 30px; height: 30px; border-radius: 50%; font-size: var(--fs-caption); box-shadow: inset 0 0 0 0.5px var(--line); color: var(--text); }
.auto-days button[aria-pressed="true"] { background: var(--text); color: rgb(var(--content-rgb)); box-shadow: none; }
</style>
