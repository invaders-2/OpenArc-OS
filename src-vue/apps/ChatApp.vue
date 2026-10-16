<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { ArrowUp, SquarePen } from "lucide-vue-next";
import { iconUrl } from "../apps";

/**
 * 对话（10-15）：直接用全局 AI 的任务运行时（task 桥），不另起一套会话存储。
 *   · 左侧 = task/list（与全局 AI 同一份任务）；
 *   · 一次对话 = 一个任务；第一句 = 任务目标，后续每句 = task/appendStep（资格由主进程判定）；
 *   · 回复 = 该步骤落库的产物（artifact），运行中经 task:event 推送 + 2s 轮询兜底。
 * 模型 / 身份 / 预算全部由主进程决定，这里拿不到也不伪造。
 */
type Task = { taskId: string; goal: string; status: string; updatedAt: number; revision: number };
type Step = { stepId: string; sequence: number; status: string; input: { goal?: string } | null };
type Artifact = { stepId: string | null; content: unknown; createdAt: number };
type Msg = { key: string; role: "user" | "assistant"; text: string; pending?: boolean; failed?: boolean };

const bridge = window.openarc?.task;
const tasks = ref<Task[]>([]);
const currentId = ref<string | null>(null);
const detail = ref<{ task: Task; steps: Step[]; artifacts: Artifact[]; appendable: boolean; appendReason: string | null } | null>(null);
const draft = ref("");
const sending = ref(false);
const error = ref("");
const scroller = ref<HTMLElement | null>(null);

const STATUS: Record<string, string> = {
  PENDING: "排队中", RUNNING: "进行中", WAITING: "等待确认", SUCCEEDED: "已完成", FAILED: "失败", CANCELLED: "已取消", BLOCKED: "已阻塞",
};
const ERR: Record<string, string> = {
  MODEL_CONFIG_UNAVAILABLE: "没有可用的文本模型：请先在「设置 › 模型」里配置。",
  CAPABILITY_UNAVAILABLE: "当前默认模型不支持对话。",
  TASK_FORBIDDEN: "当前身份无权使用任务运行时，请先登录。",
  APPEND_NOT_ALLOWED: "这段对话现在不能继续追加，可以新建一段对话。",
  INTERNAL_ERROR: "任务运行时尚未就绪。",
};
const errText = (code?: string | null) => (code ? ERR[code] ?? `请求被拒绝（${code}）` : "请求失败");
const running = (s?: string) => s === "PENDING" || s === "RUNNING" || s === "WAITING";
const asText = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 2));

async function loadList() {
  if (!bridge) return;
  const r = await bridge.command({ command: "task/list" }).catch(() => null);
  if (r?.ok) tasks.value = [...r.items].sort((a: Task, b: Task) => b.updatedAt - a.updatedAt);
}
async function loadDetail(id = currentId.value) {
  if (!bridge || !id) return;
  const r = await bridge.command({ command: "task/get", payload: { taskId: id } }).catch(() => null);
  if (!r?.ok || id !== currentId.value) return;
  detail.value = { task: r.task, steps: r.steps, artifacts: r.artifacts, appendable: r.appendable, appendReason: r.appendReason };
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
}

const messages = computed<Msg[]>(() => {
  const d = detail.value;
  if (!d) return [];
  const out: Msg[] = [];
  const steps = [...d.steps].sort((a, b) => a.sequence - b.sequence);
  steps.forEach((s, i) => {
    const ask = s.input?.goal ?? (i === 0 ? d.task.goal : "");
    if (ask) out.push({ key: s.stepId + ":u", role: "user", text: ask });
    const arts = d.artifacts.filter((a) => a.stepId === s.stepId);
    const last = arts[arts.length - 1];
    if (last) out.push({ key: s.stepId + ":a", role: "assistant", text: asText(last.content) });
    else if (s.status === "FAILED" || s.status === "CANCELLED")
      out.push({ key: s.stepId + ":a", role: "assistant", text: STATUS[s.status], failed: true });
    else out.push({ key: s.stepId + ":a", role: "assistant", text: "思考中…", pending: true });
  });
  if (!steps.length) {
    out.push({ key: "goal", role: "user", text: d.task.goal });
    out.push({ key: "wait", role: "assistant", text: running(d.task.status) ? "思考中…" : STATUS[d.task.status] ?? "", pending: running(d.task.status) });
  }
  return out;
});

function select(id: string | null) {
  currentId.value = id;
  detail.value = null;
  error.value = "";
  if (id) void loadDetail(id);
}

async function send() {
  const text = draft.value.trim();
  if (!text || sending.value || !bridge) return;
  sending.value = true;
  error.value = "";
  const id = currentId.value;
  const r = id
    ? await bridge.command({ command: "task/appendStep", payload: { taskId: id, goal: text } }).catch(() => null)
    : await bridge.command({ command: "task/run", payload: { goal: text } }).catch(() => null);
  sending.value = false;
  if (!r?.ok) {
    error.value = errText(r?.error);
    return;
  }
  draft.value = "";
  currentId.value = r.taskId;
  await Promise.all([loadList(), loadDetail(r.taskId)]);
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send();
  }
}

let off: (() => void) | null = null;
let poll = 0;
onMounted(() => {
  void loadList();
  off = bridge?.onEvent((ev: { type?: string; taskId?: string }) => {
    if (ev?.type !== "task/result") return;
    void loadList();
    if (ev.taskId === currentId.value) void loadDetail();
  }) ?? null;
  poll = window.setInterval(() => {
    if (detail.value && running(detail.value.task.status)) void loadDetail();
  }, 2000);
});
onBeforeUnmount(() => {
  off?.();
  window.clearInterval(poll);
});

const when = (t: number) => {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : `${d.getMonth() + 1}/${d.getDate()}`;
};
</script>

<template>
  <div class="split chat-app">
    <nav class="split-side" aria-label="对话">
      <div class="split-section">对话 <small class="planned-count">{{ tasks.length }}</small></div>
      <button type="button" class="split-nav" :aria-current="currentId === null ? 'true' : undefined" @click="select(null)">
        <SquarePen :size="14" /> <span class="split-nav-label">新对话</span>
      </button>
      <div class="notes-list">
        <button
          v-for="t in tasks"
          :key="t.taskId"
          type="button"
          class="notes-item"
          :aria-current="currentId === t.taskId ? 'true' : undefined"
          @click="select(t.taskId)"
        >
          <span class="notes-item-name">{{ t.goal }}</span>
          <small>{{ when(t.updatedAt) }} · {{ STATUS[t.status] ?? t.status }}</small>
        </button>
      </div>
      <p class="planned-note">与「全局 AI」共用同一份任务记录。</p>
    </nav>
    <div class="split-main chat-main">
      <div class="pane-toolbar">
        <strong class="pane-title chat-title">{{ detail?.task.goal ?? "新对话" }}</strong>
        <div class="toolbar-spacer" />
        <span v-if="detail" class="notes-status">{{ STATUS[detail.task.status] ?? detail.task.status }}</span>
      </div>
      <div ref="scroller" class="chat-scroll">
        <div v-if="!bridge" class="empty-content">
          <img class="large-icon" :src="iconUrl('messages')" alt="" draggable="false" />
          <p>任务运行时只在 OpenArc 桌面应用里可用。</p>
        </div>
        <div v-else-if="!currentId" class="empty-content">
          <img class="large-icon" :src="iconUrl('messages')" alt="" draggable="false" />
          <p>提问或交代一项任务。助理会在授权范围内调用 Skill 与工具，写操作会先请你确认。</p>
        </div>
        <div v-for="m in messages" :key="m.key" class="chat-msg" :data-role="m.role" :class="{ pending: m.pending, failed: m.failed }">
          <div class="chat-bubble">{{ m.text }}</div>
        </div>
      </div>
      <p v-if="error" class="chat-error" role="alert">{{ error }}</p>
      <p v-else-if="detail && !detail.appendable && !running(detail.task.status) && detail.appendReason" class="chat-hint">
        这段对话不能继续追加（{{ detail.appendReason }}），发送将被拒绝；可以新建对话。
      </p>
      <form class="chat-composer" @submit.prevent="send">
        <textarea
          v-model="draft"
          rows="1"
          :placeholder="currentId ? '继续这段对话…' : '给助理发消息…'"
          aria-label="消息"
          :disabled="!bridge"
          @keydown="onKey"
        />
        <button type="submit" class="chat-send" aria-label="发送" :disabled="!draft.trim() || sending || !bridge">
          <ArrowUp :size="15" />
        </button>
      </form>
    </div>
  </div>
</template>
