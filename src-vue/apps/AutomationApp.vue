<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { Play, Plus, Trash2 } from "lucide-vue-next";
import { iconUrl } from "../apps";
import { automation, nextRunAt, persistAutomations, runAutomation, type Automation, type Schedule } from "../automation-runtime";
import { useShellStore } from "../stores/shell";

/**
 * 自动化（10-15）：按时间触发一个「全局 AI 任务」。运行时见 automation-runtime.ts。
 * 「文件变化」触发需要主进程监听能力，尚未接入，如实标注不可选。
 */
const shell = useShellStore();
const filter = ref<"all" | "on" | "off" | "daily" | "interval" | "manual">("all");
const currentId = ref<string | null>(null);
const now = ref(Date.now());
let timer = 0;
onMounted(() => (timer = window.setInterval(() => (now.value = Date.now()), 15000)));
onBeforeUnmount(() => window.clearInterval(timer));

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const list = computed(() =>
  automation.items.filter((a) => {
    const k = a.schedule.kind;
    return filter.value === "all" ? true
      : filter.value === "on" ? a.enabled
      : filter.value === "off" ? !a.enabled
      : filter.value === "daily" ? k === "daily" || k === "weekly"
      : k === filter.value;
  }),
);
const current = computed(() => automation.items.find((a) => a.id === currentId.value) ?? null);

const scheduleText = (s: Schedule) =>
  s.kind === "daily" ? `每天 ${s.time}`
  : s.kind === "weekly" ? `每${WEEK[s.weekday]} ${s.time}`
  : s.kind === "interval" ? `每 ${s.minutes} 分钟`
  : "手动运行";
const fmt = (t: number) => {
  const d = new Date(t);
  const same = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return same ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};
const nextText = (a: Automation) => {
  void now.value;
  const t = nextRunAt(a);
  return !a.enabled ? "已暂停" : t ? `下次 ${fmt(t)}` : "仅手动";
};

/* 编辑表单（新建与编辑共用） */
const form = reactive({ name: "", goal: "", kind: "daily" as Schedule["kind"], time: "09:00", weekday: 1, minutes: 60 });
const editing = ref(false);
function startNew() {
  Object.assign(form, { name: "", goal: "", kind: "daily", time: "09:00", weekday: 1, minutes: 60 });
  currentId.value = null;
  editing.value = true;
}
function startEdit(a: Automation) {
  const s = a.schedule;
  Object.assign(form, {
    name: a.name, goal: a.goal, kind: s.kind,
    time: "time" in s ? s.time : "09:00",
    weekday: s.kind === "weekly" ? s.weekday : 1,
    minutes: s.kind === "interval" ? s.minutes : 60,
  });
  editing.value = true;
}
function buildSchedule(): Schedule {
  if (form.kind === "daily") return { kind: "daily", time: form.time };
  if (form.kind === "weekly") return { kind: "weekly", time: form.time, weekday: Number(form.weekday) };
  if (form.kind === "interval") return { kind: "interval", minutes: Math.max(5, Number(form.minutes) || 60) };
  return { kind: "manual" };
}
function save() {
  const goal = form.goal.trim();
  if (!goal) return;
  const name = form.name.trim() || goal.slice(0, 20);
  if (current.value) {
    Object.assign(current.value, { name, goal, schedule: buildSchedule() });
  } else {
    const a: Automation = { id: "au" + Date.now().toString(36), name, goal, schedule: buildSchedule(), enabled: true, createdAt: Date.now(), runs: [] };
    automation.items.unshift(a);
    currentId.value = a.id;
  }
  persistAutomations();
  editing.value = false;
}
function toggle(a: Automation) {
  a.enabled = !a.enabled;
  if (a.enabled && a.schedule.kind === "interval") a.lastRunAt = Date.now();
  persistAutomations();
}
function remove(a: Automation) {
  automation.items.splice(automation.items.indexOf(a), 1);
  persistAutomations();
  currentId.value = null;
}
const ERR: Record<string, string> = {
  MODEL_CONFIG_UNAVAILABLE: "没有可用的文本模型",
  TASK_FORBIDDEN: "未登录或无权限",
  NO_RUNTIME: "任务运行时不可用",
  INTERNAL_ERROR: "任务运行时尚未就绪",
};
</script>

<template>
  <div class="split automation-app">
    <nav class="split-side" aria-label="自动化">
      <div class="split-section">自动化</div>
      <button
        v-for="[id, label] in ([['all', '全部'], ['on', '运行中'], ['off', '已暂停']] as const)"
        :key="id" type="button" class="split-nav" :aria-current="filter === id ? 'true' : undefined" @click="filter = id"
      >
        <span class="split-nav-label">{{ label }}</span>
        <small class="planned-count">{{ id === "all" ? automation.items.length : automation.items.filter((a) => a.enabled === (id === "on")).length }}</small>
      </button>
      <div class="split-section">触发方式</div>
      <button
        v-for="[id, label] in ([['daily', '定时'], ['interval', '间隔'], ['manual', '手动']] as const)"
        :key="id" type="button" class="split-nav" :aria-current="filter === id ? 'true' : undefined" @click="filter = id"
      >
        <span class="split-nav-label">{{ label }}</span>
      </button>
      <button type="button" class="split-nav" disabled title="需要主进程文件监听能力，尚未接入">
        <span class="split-nav-label">文件变化</span><small class="planned-count">未接入</small>
      </button>
      <p class="planned-note">只在 OpenArc 运行时触发；关着时错过的不补跑。</p>
    </nav>

    <div class="split-main au-main">
      <div class="pane-toolbar">
        <strong class="pane-title">{{ editing ? (current ? "编辑自动化" : "新建自动化") : current ? current.name : "自动化" }}</strong>
        <div class="toolbar-spacer" />
        <button class="icon-button" aria-label="新建自动化" title="新建自动化" @click="startNew"><Plus :size="15" /></button>
      </div>

      <!-- 编辑 -->
      <form v-if="editing" class="au-form" @submit.prevent="save">
        <label>名称<input v-model="form.name" placeholder="例如：每日桌面整理" /></label>
        <label>让助理做什么<textarea v-model="form.goal" rows="4" placeholder="例如：把桌面上今天新增的截图移到「截图」文件夹，并按日期命名" /></label>
        <div class="au-row">
          <label>触发
            <select v-model="form.kind">
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="interval">每隔一段时间</option>
              <option value="manual">仅手动</option>
            </select>
          </label>
          <label v-if="form.kind === 'weekly'">星期
            <select v-model.number="form.weekday"><option v-for="(w, i) in WEEK" :key="i" :value="i">{{ w }}</option></select>
          </label>
          <label v-if="form.kind === 'daily' || form.kind === 'weekly'">时间<input v-model="form.time" type="time" /></label>
          <label v-if="form.kind === 'interval'">间隔（分钟）<input v-model.number="form.minutes" type="number" min="5" step="5" /></label>
        </div>
        <p class="planned-note">触发时会以这段描述发起一个普通任务；涉及写操作仍会先请你确认。</p>
        <div class="au-actions">
          <button type="button" class="planned-today" @click="editing = false">取消</button>
          <button type="submit" class="planned-cta" :disabled="!form.goal.trim()">保存</button>
        </div>
      </form>

      <!-- 详情 -->
      <div v-else-if="current" class="au-detail">
        <div class="au-card">
          <div class="au-meta">{{ scheduleText(current.schedule) }} · {{ nextText(current) }}</div>
          <p class="au-goal">{{ current.goal }}</p>
          <div class="au-actions">
            <button class="planned-cta" :disabled="automation.running.has(current.id)" @click="runAutomation(current)"><Play :size="13" /> 立即运行</button>
            <button class="planned-today" @click="toggle(current)">{{ current.enabled ? "暂停" : "启用" }}</button>
            <button class="planned-today" @click="startEdit(current)">编辑</button>
            <div class="toolbar-spacer" />
            <button class="icon-button" aria-label="删除自动化" title="删除" @click="remove(current)"><Trash2 :size="14" /></button>
          </div>
        </div>
        <div class="split-section">运行记录</div>
        <p v-if="!current.runs?.length" class="planned-note">还没有运行过。</p>
        <div v-for="r in current.runs" :key="r.at" class="au-run">
          <span class="au-dot" :data-ok="r.ok" />
          <span>{{ fmt(r.at) }}</span>
          <span class="au-run-text">{{ r.ok ? "已交给助理" : ERR[r.error ?? ""] ?? r.error }}</span>
          <button v-if="r.ok" class="planned-today" @click="shell.activateApp('chat')">在对话中查看</button>
        </div>
      </div>

      <!-- 列表 -->
      <div v-else-if="list.length" class="au-list">
        <button v-for="a in list" :key="a.id" type="button" class="au-item" @click="currentId = a.id">
          <span class="au-item-main">
            <span class="au-item-name">{{ a.name }}</span>
            <small>{{ scheduleText(a.schedule) }} · {{ nextText(a) }}</small>
          </span>
          <span class="au-switch" role="switch" :aria-checked="a.enabled" :aria-label="(a.enabled ? '暂停 ' : '启用 ') + a.name" @click.stop="toggle(a)" />
        </button>
      </div>
      <div v-else class="empty-content">
        <img class="large-icon" :src="iconUrl('clock')" alt="" draggable="false" />
        <h2 class="planned-title">还没有自动化</h2>
        <p>按时间自动让助理完成一项任务，例如每天早上整理桌面、每周汇总文稿。</p>
        <button class="planned-cta" @click="startNew"><Plus :size="14" /> 新建自动化</button>
      </div>
    </div>
  </div>
</template>
