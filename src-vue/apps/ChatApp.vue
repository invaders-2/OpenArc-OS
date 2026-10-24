<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { ArrowUp, ChevronDown, CircleAlert, Monitor, MoreHorizontal, Paperclip, ShieldQuestion, Sparkles, Square, SquarePen, Wrench } from "lucide-vue-next";
import ResourcePicker from "./ResourcePicker.vue";

/**
 * 对话（task-53）：DSH Harness 会话面。task 桥是唯一真源。
 * task-52 已把 safeEvent/safeCall 并进 task/get，并在运行结束补发 task/event；
 * 这里按 eventId 增量合并，不伪造 token 流式。模型选择读 model/list + defaults/get，
 * 但 task/run 的模型由主进程冻结，所选模型不会下发（界面明确写出）。
 */
type Task = { taskId: string; goal: string; status: string; updatedAt: number; createdAt?: number; revision: number; modelConfigId?: string | null };
type Step = { stepId: string; sequence: number; status: string; input: { goal?: string } | null; kind?: string };
type Artifact = { stepId: string | null; content: unknown; createdAt: number; type?: string };
type SafeEvent = { eventId: string; sequence: number; eventType: string; createdAt: number; safePayload: any };
type SafeCall = { callId: string; stepId: string | null; status: string; startedAt: number; completedAt: number | null; usage?: any; providerErrorCode?: string | null };
type Detail = {
  task: Task; steps: Step[]; artifacts: Artifact[]; events: SafeEvent[]; calls: SafeCall[];
  appendable: boolean; appendReason: string | null; resumable: boolean; stopReason: string | null;
  recovery: any; budgetLedger: any; verifications: any[];
};
type ModelOption = { configId: string; displayName: string; providerName: string; isDefault: boolean };
type Approval = { approvalRequestId: string; toolId: string; toolDisplayName?: string; riskClass?: string | null; effectClass?: string; targetDisplayName?: string | null };

const taskBridge = (window as any).openarc?.task;
const resourceBridge = (window as any).openarc?.resource;
const modelBridge = (window as any).openarc?.model;
const sideEffectBridge = (window as any).openarc?.sideEffect;
const tasks = ref<Task[]>([]);
const currentId = ref<string | null>(null);
const detail = ref<Detail | null>(null);
const draft = ref("");
const sending = ref(false);
const error = ref("");
const scroller = ref<HTMLElement | null>(null);
const panelOpen = ref(true);
const listQuery = ref("");
const resourcePickerOpen = ref(false);
const openTurns = ref<Set<string>>(new Set());
function toggleTurn(key: string) { const next = new Set(openTurns.value); if (next.has(key)) next.delete(key); else next.add(key); openTurns.value = next; }
const models = ref<ModelOption[]>([]);
const defaultModelId = ref("");
const selectedModelId = ref("");
const modelError = ref("");
const approvals = ref<Approval[]>([]);
const approvalError = ref("");
let off: (() => void) | null = null;
let offApproval: (() => void) | null = null;
let poll = 0;

const STATUS: Record<string, string> = { PENDING: "排队中", RUNNING: "执行中", WAITING: "等待确认", BLOCKED: "已阻塞", SUCCEEDED: "已完成", COMPLETED: "已完成", FAILED: "失败", CANCELLED: "已取消" };
const ERR: Record<string, string> = {
  MODEL_CONFIG_UNAVAILABLE: "没有可用的文本模型：请先在「系统设置 › 模型与服务商」配置 chat 模型。",
  CAPABILITY_UNAVAILABLE: "当前默认模型不支持对话。", TASK_FORBIDDEN: "当前身份无权使用任务运行时，请先登录。",
  APPEND_NOT_ALLOWED: "这段对话现在不能继续追加，可以新建一段对话。", INTERNAL_ERROR: "任务运行时尚未就绪。",
  INVALID_INPUT: "请求参数不完整。", TASK_NOT_FOUND: "任务不存在或已失效。", TASK_CANCELLED: "任务已取消。",
  TASK_REVISION_CONFLICT: "任务状态已变化，请刷新后再试。",
};
const errText = (code?: string | null) => (code ? ERR[code] ?? "请求被拒绝（" + code + "）" : "请求失败");
const running = (s?: string) => ["PENDING", "RUNNING", "WAITING"].includes(String(s || ""));
const terminal = (s?: string) => ["SUCCEEDED", "COMPLETED", "FAILED", "CANCELLED"].includes(String(s || ""));
const asText = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 2));
const when = (t: number) => { const d = new Date(Number(t) || 0); if (!Number.isFinite(d.getTime())) return ""; return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : (d.getMonth() + 1) + "/" + d.getDate(); };
const selectedModel = computed(() => models.value.find((m) => m.configId === selectedModelId.value) || null);
const defaultModel = computed(() => models.value.find((m) => m.configId === defaultModelId.value) || null);
const modelHint = computed(() => {
  if (!modelBridge) return "";
  if (modelError.value) return modelError.value;
  if (!models.value.length) return "还没有可用的对话模型，请在系统设置里添加。";
  return defaultModel.value ? "默认对话模型：" + defaultModel.value.displayName + "（" + defaultModel.value.providerName + "），在系统设置里更改" : modelHint2.value;
});

/** 对话用的模型由主进程按默认模型冻结，界面只显示、不提供无效的切换。 */
const modelLabel = computed(() => {
  const id = detail.value?.task.modelConfigId;
  const m = (id && models.value.find((x) => x.configId === id)) || defaultModel.value;
  return m ? m.displayName : models.value.length ? "默认模型" : "未配置模型";
});
const modelHint2 = computed(() => "对话使用「系统设置 › 模型与服务商」里的默认对话模型");
async function loadModels() {
  if (!modelBridge) return;
  modelError.value = "";
  const [list, defaults] = await Promise.all([modelBridge.command({ command: "model/list" }).catch(() => null), modelBridge.command({ command: "defaults/get" }).catch(() => null)]);
  const items = Array.isArray(list?.items) ? list.items : [];
  defaultModelId.value = defaults?.personal?.chat || defaults?.organization?.chat || "";
  models.value = items.filter((m: any) => String(m.status || "enabled") !== "disabled" && (!Array.isArray(m.capabilities) || m.capabilities.includes("chat"))).map((m: any) => ({
    configId: String(m.configId), displayName: String(m.displayName || m.remoteModelId || m.configId),
    providerName: String(m.providerName || m.providerId || "provider"), isDefault: String(m.configId) === defaultModelId.value,
  }));
  if (!selectedModelId.value) selectedModelId.value = defaultModelId.value || models.value[0]?.configId || "";
}
function mergeEvents(rows: SafeEvent[] | undefined) {
  if (!detail.value || !Array.isArray(rows)) return;
  const byId = new Map(detail.value.events.map((e) => [e.eventId, e]));
  for (const row of rows) if (row && row.eventId) byId.set(row.eventId, row);
  detail.value = { ...detail.value, events: [...byId.values()].sort((a, b) => a.sequence - b.sequence) };
}
async function loadList() {
  if (!taskBridge) return;
  const r = await taskBridge.command({ command: "task/list" }).catch(() => null);
  if (r?.ok) tasks.value = [...r.items].sort((a: Task, b: Task) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
async function loadDetail(id = currentId.value) {
  if (!taskBridge || !id) return;
  const r = await taskBridge.command({ command: "task/get", payload: { taskId: id } }).catch(() => null);
  if (!r?.ok || id !== currentId.value) return;
  const prev = detail.value?.task.taskId === id ? detail.value : null;
  detail.value = {
    task: r.task, steps: Array.isArray(r.steps) ? r.steps : [], artifacts: Array.isArray(r.artifacts) ? r.artifacts : [],
    events: prev ? prev.events : [], calls: Array.isArray(r.calls) ? r.calls : [], appendable: r.appendable === true,
    appendReason: r.appendReason || null, resumable: r.resumable === true, stopReason: r.stopReason || null,
    recovery: r.recovery || null, budgetLedger: r.budgetLedger || null, verifications: Array.isArray(r.verifications) ? r.verifications : [],
  };
  mergeEvents(r.events);
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
}

/* 会话列表：搜索 + 按「今天 / 更早」分组 */
const sessionGroups = computed(() => {
  const q = listQuery.value.trim().toLowerCase();
  const list = q ? tasks.value.filter((t) => String(t.goal || "").toLowerCase().includes(q)) : tasks.value;
  const today = new Date().toDateString();
  const a = list.filter((t) => new Date(Number(t.updatedAt) || 0).toDateString() === today);
  const b = list.filter((t) => new Date(Number(t.updatedAt) || 0).toDateString() !== today);
  return [{ label: "今天", items: a }, { label: "更早", items: b }].filter((g) => g.items.length);
});
const statusTone = (s: string) => (running(s) ? "run" : s === "FAILED" || s === "BLOCKED" ? "bad" : "done");
const toolTone = (status: string) => (status === "执行完成" ? "ok" : status === "执行中" ? "run" : /等待/.test(status) ? "wait" : /失败|拒|阻止/.test(status) ? "bad" : "idle");
/** 每一轮 = 用户提问 + 这一轮的工具步骤 + 助手回答；工具事件按时间归到它之后第一个产出回答的轮次。 */
const turns = computed(() => {
  const d = detail.value; if (!d) return [] as { key: string; ask: string; answer: string; pending: boolean; failed: boolean; tools: any[] }[];
  const steps = [...d.steps].sort((a, b) => a.sequence - b.sequence);
  const rows = steps.map((s, i) => {
    const ask = s.input?.goal ?? (i === 0 ? d.task.goal : "");
    const arts = d.artifacts.filter((a) => a.stepId === s.stepId); const last = arts[arts.length - 1];
    const failed = !last && ["FAILED", "CANCELLED", "BLOCKED"].includes(s.status);
    const pending = !last && !failed;
    return { key: s.stepId, ask, answer: last ? asText(last.content) : failed ? "这一步" + (STATUS[s.status] || s.status) + "。" : "", pending, failed, doneAt: last ? Number(last.createdAt) || 0 : Infinity, tools: [] as any[] };
  });
  if (!rows.length) rows.push({ key: "goal", ask: d.task.goal, answer: running(d.task.status) ? "" : STATUS[d.task.status] ?? "", pending: running(d.task.status), failed: false, doneAt: Infinity, tools: [] });
  for (const card of toolCards.value) {
    const target = rows.find((r) => card.at <= r.doneAt) || rows[rows.length - 1];
    target.tools.push(card);
  }
  return rows;
});
const TOOL_STATUS: Record<string, string> = { "tool.proposed": "已提议", "tool.validated": "已校验", "tool.denied": "已拒绝", "tool.approval_required": "等待审批", "tool.execution.started": "执行中", "tool.execution.succeeded": "执行完成", "tool.execution.failed": "执行失败", "tool.execution.blocked": "执行被阻止", "harness.tool_proposed": "已提议", "harness.permission_requested": "等待权限", "harness.permission_rejected": "权限被拒" };
const TOOL_RANK: Record<string, number> = { "已提议": 1, "已校验": 2, "等待审批": 3, "等待权限": 3, "执行中": 4, "执行完成": 5, "执行失败": 5, "执行被阻止": 5, "已拒绝": 5, "权限被拒": 5 };
const toolNameOf = (p: any) => {
  const values = [p?.toolDisplayName, p?.toolName, p?.name, p?.safeToolName, p?.tool?.displayName, p?.tool?.name, p?.safeToolId, p?.toolId, p?.toolCallId];
  for (const v of values) {
    const s = String(v == null ? "" : v).trim();
    if (s && !/^tool_call(_update)?$/i.test(s) && s !== "工具调用") return s;
  }
  return "工具调用";
};
const toolCards = computed(() => {
  const evs = detail.value?.events || [];
  const byKey = new Map<string, { key: string; title: string; toolId: string; status: string; detail: string; rank: number; sequence: number; at: number }>();
  for (const e of evs) {
    if (!/^(tool\.|harness\.tool|harness\.permission)/.test(e.eventType)) continue;
    const p = e.safePayload || {};
    const title = toolNameOf(p);
    // tool-69 的 safe toolId/toolName 优先；没有 proposalId 时用 eventId，绝不把 12 个提议折叠成一个。
    const key = String(p.proposalId || p.toolCallId || p.executionId || (p.toolId ? p.toolId + ":" + e.eventId : e.eventId));
    const status = TOOL_STATUS[e.eventType] || e.eventType;
    const rank = TOOL_RANK[status] || 0;
    const detail = String(p.reasonCode || p.decision || p.reason || (p.toolVersion != null ? "v" + p.toolVersion : "") || "");
    const toolId = String(p.toolId || p.safeToolId || "");
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { key, title, toolId, status, detail, rank, sequence: e.sequence, at: Number(e.createdAt) || 0 });
    else if (rank >= prev.rank) { prev.title = title !== "工具调用" ? title : prev.title; prev.status = status; prev.detail = detail || prev.detail; prev.rank = rank; prev.toolId = toolId || prev.toolId; prev.sequence = e.sequence; }
    else if (title !== "工具调用") prev.title = title;
  }
  return [...byKey.values()].sort((a, b) => a.sequence - b.sequence).slice(-24).map((card) => ({
    ...card,
    // 提议事件的 title 可能是 call_3_0（ACP toolCallId）；执行事件带真实 toolId（如 browser_read_page）时以它为准。
    title: (/^call[_-]/i.test(card.title) && card.toolId ? card.toolId : card.title),
  }));
});
const BUDGET_LABEL: Record<string, string> = { TOOL_CALLS: "工具调用", TOOL_ROUNDS: "工具轮次", MODEL_CALLS: "模型调用" };
const RESUME_REASON_TEXT: Record<string, string> = {
  RESUME_NOT_BLOCKED: "任务未处于可续接的阻塞状态。", RESUME_CANCELLED: "任务已取消，不能续接。", RESUME_IN_FLIGHT: "任务仍在执行，稍后再试。",
  RESUME_NO_HARNESS_RUN: "没有可续接的运行记录。", RESUME_NOT_BUDGET_STOP: "当前阻塞不是预算耗尽。", RESUME_UNKNOWN_BUDGET_KIND: "预算类型未知，不能自动续接。",
  RESUME_UNKNOWN_EFFECT_PRESENT: "存在结果未知的副作用，先核查后才能续接。", RESUME_SIDE_EFFECT_PENDING: "有审批/执行中的副作用，先处理再续接。",
  RESUME_ACTIVE_LEASE: "有正在执行的受控操作，稍后再试。", RESUME_LIMIT_REACHED: "续接次数已达上限（3 次）。", RESUME_NO_SAFE_CONTINUATION: "没有可用于续接的已完成产物。",
};
const budgetInfo = computed(() => {
  const d = detail.value; const ledger = d?.budgetLedger; if (!d || !ledger) return null;
  const exhaust = [...(d.events || [])].reverse().find((e) => e.eventType === "task.budget_exhausted");
  const exhausted = d.task.status === "BLOCKED" && (d.stopReason === "BUDGET_EXHAUSTED" || ledger.stopReason === "BUDGET_EXHAUSTED" || !!exhaust);
  if (!exhausted) return null;
  const kinds = ledger.kinds || {};
  const kind = String(ledger.nextGrant?.kind || exhaust?.safePayload?.kind || "TOOL_CALLS");
  const rows = Object.keys(BUDGET_LABEL).map((k) => ({ key: k, label: BUDGET_LABEL[k], consumed: Number(kinds[k]?.consumed) || 0, authorized: Number(kinds[k]?.authorized) || 0, remaining: Number(kinds[k]?.remaining) || 0 }));
  const focus = rows.find((r) => r.key === kind) || rows.find((r) => r.consumed >= r.authorized) || rows[0];
  const nextGrant = ledger.nextGrant && ledger.nextGrant.kind === kind ? ledger.nextGrant : null;
  const add = Number(nextGrant?.amount) || 0;
  const reason = String(ledger.reason || "");
  return {
    kind, label: BUDGET_LABEL[kind] || kind, rows, focus, nextGrant, add,
    exhaustedText: focus.label + "已用 " + focus.consumed + " / " + focus.authorized + "，剩余 " + focus.remaining + "。",
    resumeText: "续接次数 " + (Number(ledger.resumeCount) || 0) + " / " + (Number(ledger.maxResumes) || 3) + "（剩余 " + (Number(ledger.remainingResumes) || 0) + " 次）",
    resumable: d.resumable === true && !!nextGrant,
    reasonText: RESUME_REASON_TEXT[reason] || (reason ? "后端拒绝续接（" + reason + "）" : "当前不可续接。"),
  };
});
const resuming = ref(false);
const budgetError = ref("");
const budgetNotice = ref("");
async function resumeBudget() {
  if (!taskBridge || !currentId.value || !detail.value || resuming.value) return;
  resuming.value = true; budgetError.value = ""; budgetNotice.value = "";
  try {
    const r = await taskBridge.command({ command: "task/resume", payload: { taskId: currentId.value, expectedRevision: detail.value.task.revision } }).catch(() => null);
    if (!r?.ok) { budgetError.value = errText(r?.error) + (r?.detail ? "（" + String(r.detail).slice(0, 160) + "）" : ""); return; }
    budgetNotice.value = "已追加 " + (budgetInfo.value?.add || 0) + " 次" + (budgetInfo.value?.label || "预算") + "，任务继续执行…";
    await Promise.all([loadList(), loadDetail()]);
  } finally { resuming.value = false; }
}
const eventRows = computed(() => (detail.value?.events || []).slice(-40));
const recoveryCalls = computed<any[]>(() => Array.isArray(detail.value?.recovery?.calls) ? detail.value!.recovery.calls : []);
const needsAck = computed(() => detail.value?.recovery?.applicable === true && recoveryCalls.value.some((c) => !c.acknowledged));

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
const BACKTICK = String.fromCharCode(96);
function inlineMarkdown(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(new RegExp(BACKTICK + "([^" + BACKTICK + "]+)" + BACKTICK, "g"), "<code>$1</code>");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return out;
}
function markdown(src: string): string {
  const text = String(src || ""); const fence = BACKTICK + BACKTICK + BACKTICK;
  const parts = text.split(new RegExp("(?:^|\\n)\\s*" + fence + "([a-zA-Z0-9_-]*)\\n([\\s\\S]*?)\\n\\s*" + fence, "g"));
  let out = "";
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 3 === 1) continue; const chunk = parts[i] || "";
    if (i % 3 === 2) { out += '<pre class="chat-code"><code>' + escapeHtml(chunk.replace(/\n$/, "")) + "</code></pre>"; continue; }
    let list: string[] = []; const flush = () => { if (!list.length) return; out += "<ul>" + list.map((x) => "<li>" + inlineMarkdown(x) + "</li>").join("") + "</ul>"; list = []; };
    for (const line of chunk.split(/\n/)) {
      const h = /^(#{1,4})\s+(.*)$/.exec(line); if (h) { flush(); out += "<h" + h[1].length + ">" + inlineMarkdown(h[2]) + "</h" + h[1].length + ">"; continue; }
      const li = /^\s*[-*]\s+(.*)$/.exec(line); if (li) { list.push(li[1]); continue; }
      flush(); if (line.trim()) out += "<p>" + inlineMarkdown(line) + "</p>";
    }
    flush();
  }
  return out || "<p>" + inlineMarkdown(text) + "</p>";
}
function select(id: string | null) { currentId.value = id; detail.value = null; error.value = ""; if (id) void loadDetail(id); }
function newSession() { select(null); draft.value = ""; error.value = ""; modelError.value = ""; }
async function send() {
  const text = draft.value.trim(); if (!text || sending.value || !taskBridge) return;
  sending.value = true; error.value = ""; const id = currentId.value;
  const r = id ? await taskBridge.command({ command: "task/appendStep", payload: { taskId: id, goal: text } }).catch(() => null) : await taskBridge.command({ command: "task/run", payload: { goal: text } }).catch(() => null);
  sending.value = false;
  if (!r?.ok) { error.value = errText(r?.error) + (r?.detail ? "（" + String(r.detail).slice(0, 160) + "）" : ""); return; }
  draft.value = ""; currentId.value = r.taskId; await Promise.all([loadList(), loadDetail(r.taskId)]);
}
async function stop() { if (!taskBridge || !currentId.value) return; const r = await taskBridge.command({ command: "task/cancel", payload: { taskId: currentId.value } }).catch(() => null); if (!r?.ok) error.value = errText(r?.error); await loadDetail(); }
async function resume() { if (!taskBridge || !currentId.value || !detail.value) return; const r = await taskBridge.command({ command: "task/resume", payload: { taskId: currentId.value, expectedRevision: detail.value.task.revision } }).catch(() => null); if (!r?.ok) error.value = errText(r?.error); await loadDetail(); }
async function acknowledge(callId: string) { if (!taskBridge || !currentId.value) return; const r = await taskBridge.command({ command: "task/acknowledgeUnknownEffect", payload: { taskId: currentId.value, callId } }).catch(() => null); if (!r?.ok) error.value = errText(r?.error); await loadDetail(); }
function onKey(e: KeyboardEvent) { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); } }
async function attachResource(ref: string) {
  resourcePickerOpen.value = false;
  let name = ref;
  const res = await resourceBridge?.command({ type: "resource/get", resourceRef: ref }).catch(() => null);
  if (res && res.ok && res.resource && res.resource.name) name = String(res.resource.name);
  draft.value = (draft.value ? draft.value.replace(/\s+$/, "") + " " : "") + "@" + name + " ";
}
async function loadApprovals() { if (!sideEffectBridge) return; const r = await sideEffectBridge.command({ type: "sideEffect/listPending" }).catch(() => null); if (Array.isArray(r?.items)) approvals.value = r.items; else if (r?.ok === false) approvalError.value = String(r.error || "APPROVAL_UNAVAILABLE"); }
onMounted(async () => {
  await Promise.all([loadList(), loadModels(), loadApprovals()]);
  off = taskBridge?.onEvent((ev: any) => {
    if (!ev) return;
    if (ev.type === "task/result") { void loadList(); if (ev.taskId === currentId.value) void loadDetail(); }
    else if (ev.type === "task/event" && ev.taskId === currentId.value) mergeEvents(ev.events);
  }) ?? null;
  offApproval = sideEffectBridge?.onEvent?.((ev: any) => { if (ev?.type === "sideEffect/approvalRequested") { if (ev.request) approvals.value = [ev.request, ...approvals.value.filter((a) => a.approvalRequestId !== ev.request.approvalRequestId)]; else void loadApprovals(); } }) ?? null;
  poll = window.setInterval(() => { if (detail.value && (running(detail.value.task.status) || sending.value)) void loadDetail(); if (running(detail.value?.task.status)) void loadApprovals(); }, 700);
});
onBeforeUnmount(() => { off?.(); offApproval?.(); window.clearInterval(poll); });
</script>

<template>
  <div class="split chat-app">
    <!-- 原型 C：会话列表 280（搜索 · 今天 / 更早） -->
    <nav class="split-side chat-side" aria-label="对话">
      <div class="chat-side-top">
        <label class="ds-search chat-search"><input v-model="listQuery" class="ds-search__input" type="search" placeholder="搜索对话" aria-label="搜索对话" /></label>
        <button type="button" class="chat-icon-btn" data-chat-new title="新对话" aria-label="新对话" @click="newSession"><SquarePen :size="16" /></button>
      </div>
      <div class="chat-sessions" data-chat-sessions>
        <template v-for="g in sessionGroups" :key="g.label">
          <div class="split-section">{{ g.label }}</div>
          <button v-for="t in g.items" :key="t.taskId" type="button" class="chat-session" :data-chat-session="t.taskId" :aria-current="currentId === t.taskId ? 'true' : undefined" @click="select(t.taskId)">
            <span class="chat-session-name">{{ t.goal }}</span>
            <small><span v-if="running(t.status)" class="chat-live" aria-hidden="true" />{{ STATUS[t.status] ?? t.status }} · {{ when(t.updatedAt) }}</small>
          </button>
        </template>
        <p v-if="!tasks.length" class="chat-side-empty">还没有对话。</p>
        <p v-else-if="!sessionGroups.length" class="chat-side-empty">没有匹配的对话。</p>
      </div>
    </nav>

    <div class="split-main chat-main">
      <div class="pane-toolbar chat-toolbar">
        <strong class="pane-title chat-title">{{ detail?.task.goal ?? "新对话" }}</strong>
        <span v-if="detail" class="chat-status" data-chat-status :data-tone="statusTone(detail.task.status)">{{ STATUS[detail.task.status] ?? detail.task.status }}</span>
        <div class="toolbar-spacer" />
        <details class="chat-menu" data-chat-model-menu>
          <summary class="chat-model" data-chat-model :title="modelHint">{{ modelLabel }} <ChevronDown :size="12" /></summary>
          <div class="chat-menu-body">
            <p class="chat-menu-note">对话模型由主进程按默认模型冻结，这里只读展示（切换 NOT VERIFIED）。</p>
            <button v-for="m in models" :key="m.configId" type="button" :class="{ on: m.isDefault }" disabled>
              {{ m.displayName }} <small>{{ m.providerName }}</small>
            </button>
            <p v-if="!models.length" class="chat-menu-note">还没有可用的对话模型；请到「系统设置 › 模型与服务商」添加。</p>
            <button type="button" data-chat-model-refresh @click="loadModels">刷新模型列表</button>
          </div>
        </details>
        <span class="chat-device" data-chat-device title="后端任务没有设备字段，这里是只读环境标识（NOT VERIFIED）"><Monitor :size="12" /> 本机 · D1</span>
        <details class="chat-menu chat-menu-right" data-chat-more>
          <summary class="chat-icon-btn" aria-label="更多" title="更多"><MoreHorizontal :size="16" /></summary>
          <div class="chat-menu-body">
            <button type="button" :disabled="!detail" data-chat-refresh @click="loadDetail()">刷新任务状态</button>
            <button type="button" :disabled="!running(detail?.task.status)" data-chat-menu-stop @click="stop">停止任务</button>
            <button type="button" data-chat-menu-new @click="newSession">新对话</button>
          </div>
        </details>
      </div>

      <div class="chat-body">
        <div class="chat-col">
          <div ref="scroller" class="chat-scroll">
            <div class="chat-thread">
              <div v-if="!taskBridge" class="chat-empty"><p>对话只在 OpenArc 桌面应用里可用。</p></div>
              <div v-else-if="!currentId" class="chat-empty" data-chat-empty>
                <div class="chat-empty-mark"><Sparkles :size="22" :stroke-width="1.5" /></div>
                <h2>有什么可以帮你？</h2>
                <p>可以直接提问，也可以让助理动手做事：它会一步步调用工具，需要你确认的操作会先停下来请你批准。</p>
                <p v-if="!models.length && modelBridge" class="chat-empty-warn">还没有可用的对话模型，请先到「系统设置 › 模型与服务商」添加。</p>
              </div>

              <template v-for="turn in turns" :key="turn.key">
                <div class="chat-msg" data-role="user" data-chat-message="user"><div class="chat-bubble">{{ turn.ask }}</div></div>
                <div class="chat-msg chat-msg-ai" data-role="assistant" data-chat-message="assistant" :class="{ pending: turn.pending, failed: turn.failed }">
                  <span class="chat-orb" aria-hidden="true" />
                  <div class="chat-bubble">
                    <!-- 任务卡：这一轮调用了哪些工具、现在做到哪一步（结构化摘要，不展示思维链） -->
                    <div v-if="turn.tools.length" class="chat-taskcard" data-chat-tools>
                      <button type="button" class="chat-taskcard-head" :aria-expanded="openTurns.has(turn.key)" @click="toggleTurn(turn.key)">
                        <Wrench :size="13" /><span>{{ turn.pending ? "正在执行" : "已执行" }} {{ turn.tools.length }} 个步骤</span>
                        <small>{{ turn.tools[turn.tools.length - 1].title }} · {{ turn.tools[turn.tools.length - 1].status }}</small>
                        <ChevronDown :size="13" class="chat-chev" :class="{ open: openTurns.has(turn.key) }" />
                      </button>
                      <ol v-if="openTurns.has(turn.key)" class="chat-steps">
                        <li v-for="card in turn.tools" :key="card.key" :data-chat-tool="card.title" :data-chat-tool-id="card.toolId" :data-chat-tool-status="card.status" :data-chat-tool-state="card.status">
                          <span class="chat-step-dot" :data-tone="toolTone(card.status)" />
                          <span class="chat-step-name">{{ card.title }}</span>
                          <small>{{ card.status }}</small>
                        </li>
                      </ol>
                    </div>
                    <span v-if="turn.pending" class="chat-typing"><i /><i /><i /><span class="chat-caret" /></span>
                    <div v-else class="chat-md" data-chat-markdown v-html="markdown(turn.answer)" />
                  </div>
                </div>
              </template>

              <div v-for="a in approvals" :key="a.approvalRequestId" class="chat-card chat-card-warn" :data-chat-approval="a.approvalRequestId">
                <ShieldQuestion :size="16" />
                <div><strong>等待你确认</strong><p>{{ a.toolDisplayName || a.toolId }}<span v-if="a.targetDisplayName"> · {{ a.targetDisplayName }}</span></p><small>请在弹出的确认窗口里批准或拒绝，结果会回到这里。</small></div>
              </div>
              <p v-if="approvalError" class="chat-error" data-chat-approval-error>暂时读不到待确认的操作。</p>

              <section v-if="budgetInfo" class="chat-card chat-card-warn" data-chat-budget :data-chat-budget-kind="budgetInfo.kind" :data-chat-budget-resumable="budgetInfo.resumable">
                <CircleAlert :size="16" />
                <div>
                  <strong>任务已暂停：{{ budgetInfo.label }}次数用完</strong>
                  <p data-chat-budget-summary>{{ budgetInfo.exhaustedText }}</p>
                  <p class="chat-card-meta" data-chat-budget-resume-meta>{{ budgetInfo.resumeText }}</p>
                  <p v-if="budgetError" class="chat-error" role="alert" data-chat-budget-error>{{ budgetError }}</p>
                  <button v-if="budgetInfo.resumable" type="button" class="chat-mini" data-chat-budget-resume :disabled="resuming" @click="resumeBudget">{{ resuming ? "正在继续…" : "继续执行（再给 " + budgetInfo.add + " 次）" }}</button>
                  <small v-else class="chat-card-meta" data-chat-budget-reason>{{ budgetInfo.reasonText }}</small>
                </div>
              </section>
              <p v-if="budgetNotice" class="chat-hint" data-chat-budget-notice>{{ budgetNotice }}</p>
              <div v-if="detail && detail.task.status === 'BLOCKED' && !budgetInfo" class="chat-card" data-chat-blocked>
                <CircleAlert :size="16" />
                <div>
                  <strong>任务已暂停</strong>
                  <p v-if="needsAck">有操作的结果不确定：请先核对实际影响，再确认继续。</p>
                  <div v-for="c in recoveryCalls" :key="c.callId" class="chat-recovery" :data-chat-recovery-call="c.callId"><span>{{ c.toolId }}</span><button v-if="!c.acknowledged" type="button" class="chat-mini" :data-chat-ack="c.callId" @click="acknowledge(c.callId)">我已核对</button><small v-else>已确认</small></div>
                  <button v-if="detail.resumable" type="button" class="chat-mini" data-chat-resume @click="resume">继续任务</button>
                </div>
              </div>

              <details v-if="detail" class="chat-process" data-chat-process>
                <summary>处理过程 · {{ toolCards.length }} 个工具 · {{ detail.calls.length }} 次模型调用</summary>
                <div class="chat-kv"><span>状态</span><b>{{ STATUS[detail.task.status] ?? detail.task.status }}</b></div>
                <div class="chat-kv"><span>轮次</span><b>{{ turns.length }}</b></div>
                <ol v-if="toolCards.length" class="chat-steps">
                  <li v-for="card in toolCards" :key="card.key"><span class="chat-step-dot" :data-tone="toolTone(card.status)" /><span class="chat-step-name">{{ card.title }}</span><small>{{ card.status }}</small></li>
                </ol>
                <details v-if="eventRows.length" class="chat-debug" open>
                  <summary>事件记录（{{ eventRows.length }}）</summary>
                  <ol class="chat-events" data-chat-events><li v-for="e in eventRows" :key="e.eventId" :data-chat-event="e.eventType"><span class="chat-event-type">{{ e.eventType }}</span><small>{{ when(e.createdAt) }}</small></li></ol>
                </details>
              </details>
            </div>
          </div>

          <div class="chat-dock">
            <p v-if="error" class="chat-error" role="alert" data-chat-error>{{ error }}</p>
            <p v-else-if="detail && !detail.appendable && terminal(detail.task.status) && detail.appendReason" class="chat-hint" data-chat-append-hint>这段对话已结束，不能继续追加；可以新建一段对话。</p>
            <form class="chat-composer" @submit.prevent="send">
              <textarea v-model="draft" rows="1" data-chat-input :placeholder="currentId ? '继续这段对话…' : '给助理发消息，或输入 / 选择 Skill'" aria-label="消息" :disabled="!taskBridge || sending" @keydown="onKey" />
              <div class="chat-composer-bar">
                <button type="button" class="chat-chip" disabled title="附件命令未接入（NOT VERIFIED）"><Paperclip :size="12" /> 附件</button>
                <span class="chat-chip is-static" data-chat-skill title="Skill 选择命令未接入，这里是只读占位（NOT VERIFIED）"><Wrench :size="12" /> 自动选择能力</span>
                <button type="button" class="chat-chip" data-chat-resource @click="resourcePickerOpen = true">引用资源</button>
                <span class="toolbar-spacer" />
                <span class="chat-kbd">回车发送 · ⇧回车换行</span>
                <button v-if="running(detail?.task.status)" type="button" class="chat-send chat-send-stop" data-chat-stop aria-label="停止" title="停止" @click="stop"><Square :size="12" /></button>
                <button v-else type="submit" class="chat-send" data-chat-send aria-label="发送" :disabled="!draft.trim() || sending || !taskBridge"><ArrowUp :size="15" /></button>
              </div>
            </form>
          </div>
        </div>

        <!-- 原型没有右侧第三栏：任务步骤 / 事件收进消息流末尾的「处理过程」折叠块。 -->
      </div>
      <ResourcePicker v-if="resourcePickerOpen" picker-app-id="chat" :requested-actions="['resource.view']" title="引用资源" @choose="attachResource" @cancel="resourcePickerOpen = false" />
    </div>
  </div>
</template>

<style scoped>
.chat-side { width: 260px; }
.chat-side-top { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.chat-search { flex: 1; min-width: 0; }
.chat-icon-btn { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--radius-md); color: var(--muted); }
.chat-icon-btn:hover, .chat-icon-btn[aria-pressed="true"] { background: rgb(var(--text-rgb) / 0.07); color: var(--text); }
.chat-sessions { flex: 1; min-height: 0; overflow: auto; scrollbar-width: none; display: flex; flex-direction: column; gap: 1px; }
.chat-sessions::-webkit-scrollbar { display: none; }
.chat-session { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 7px 10px; border-radius: var(--radius-md); text-align: left; color: var(--text); }
.chat-session:hover { background: rgb(var(--text-rgb) / 0.05); }
.chat-session[aria-current="true"] { background: rgb(var(--sidebar-selected-rgb, 224 224 224)); }
.chat-session-name { font-size: var(--fs-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-session[aria-current="true"] .chat-session-name { font-weight: var(--fw-medium); }
.chat-session small { display: flex; align-items: center; gap: 5px; font-size: var(--fs-caption); color: var(--muted); }
.chat-live { width: 6px; height: 6px; border-radius: 50%; background: #34c759; }
.chat-side-empty { margin: 8px 10px; font-size: var(--fs-caption); color: var(--muted); }

.chat-toolbar { gap: 10px; }
.chat-title { max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-headline); }
.chat-status { font-size: var(--fs-caption); color: var(--muted); }
.chat-status[data-tone="run"] { color: var(--text); }
.chat-status[data-tone="bad"] { color: var(--failed); }
.chat-model { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-caption); color: var(--muted); }

.chat-body { flex: 1; min-height: 0; display: flex; }
.chat-col { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.chat-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-width: none; padding: 16px 24px 8px; }
.chat-scroll::-webkit-scrollbar { display: none; }
/* 消息流最大宽 720 居中（原型 C） */
.chat-thread { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; min-height: 100%; }
.chat-msg { display: flex; }
.chat-msg[data-role="user"] { justify-content: flex-end; }
.chat-bubble { max-width: 100%; font-size: var(--fs-body); line-height: 1.7; color: var(--text); overflow-wrap: anywhere; }
/* 用户消息：右对齐、sunken 底、12 圆角；助手回复：左对齐、无底色 */
.chat-msg[data-role="user"] .chat-bubble { max-width: 80%; padding: 8px 14px; border-radius: 12px; background: var(--sunken); color: var(--text); white-space: pre-wrap; }
.chat-msg[data-role="assistant"] .chat-bubble { width: 100%; max-width: 100%; padding: 0; border-radius: 0; background: none; white-space: normal; }
.chat-dock .chat-composer { margin: 0 auto; border-radius: 14px; }
.chat-msg.failed .chat-bubble { color: var(--failed); }
.chat-typing { display: inline-flex; gap: 4px; padding: 6px 0; }
.chat-typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: chat-dot 1.2s infinite ease-in-out; }
.chat-typing i:nth-child(2) { animation-delay: 0.15s; }
.chat-typing i:nth-child(3) { animation-delay: 0.3s; }
@keyframes chat-dot { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }

.chat-empty { margin: auto; max-width: 480px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--muted); }
.chat-empty h2 { margin: 0; font-size: var(--fs-title); font-weight: var(--fw-medium); color: var(--text); }
.chat-empty p { margin: 0; font-size: var(--fs-secondary); line-height: var(--lh-relaxed); }
.chat-empty-warn { color: var(--warning-text, #a05a00) !important; }
.chat-empty-mark { width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; background: var(--sunken); color: var(--text); }

.chat-md { white-space: normal; }
.chat-md :deep(p) { margin: 0 0 8px; }
.chat-md :deep(p:last-child) { margin-bottom: 0; }
.chat-md :deep(h1), .chat-md :deep(h2), .chat-md :deep(h3), .chat-md :deep(h4) { margin: 10px 0 4px; font-size: var(--fs-headline); font-weight: var(--fw-medium); }
.chat-md :deep(ul) { margin: 4px 0 8px; padding-left: 20px; }
.chat-md :deep(code) { padding: 1px 4px; border-radius: 4px; background: rgb(var(--text-rgb) / 0.08); font-family: var(--font-mono); font-size: 0.92em; }
.chat-md :deep(.chat-code) { margin: 8px 0; padding: 10px 12px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.06); overflow: auto; white-space: pre; scrollbar-width: none; }
.chat-md :deep(.chat-code code) { background: transparent; padding: 0; }

/* 任务卡（一等公民）：收起时一行摘要，展开列出每一步 */
.chat-taskcard { border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); }
.chat-taskcard-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 14px; text-align: left; color: var(--text); font-size: var(--fs-secondary); }
.chat-taskcard-head small { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: var(--fs-caption); text-align: right; }
.chat-chev { flex: none; color: var(--muted); transition: transform var(--quick) var(--ease); }
.chat-chev.open { transform: rotate(180deg); }
.chat-steps { list-style: none; margin: 0; padding: 2px 14px 10px; display: flex; flex-direction: column; gap: 6px; }
.chat-steps li { display: flex; align-items: center; gap: 8px; font-size: var(--fs-caption); min-width: 0; }
.chat-step-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.chat-steps small { flex: none; color: var(--muted); }
.chat-step-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: rgb(var(--text-rgb) / 0.3); }
.chat-step-dot[data-tone="ok"] { background: #34c759; }
.chat-step-dot[data-tone="run"] { background: #0a84ff; }
.chat-step-dot[data-tone="wait"] { background: #ff9f0a; }
.chat-step-dot[data-tone="bad"] { background: var(--failed); }

.chat-card { display: flex; gap: 10px; padding: 12px 14px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); font-size: var(--fs-secondary); }
.chat-card-warn { background: color-mix(in srgb, #ff9f0a 10%, transparent); }
.chat-card strong { display: block; font-weight: var(--fw-medium); }
.chat-card p { margin: 3px 0; color: var(--muted); }
.chat-card small, .chat-card-meta { color: var(--muted); font-size: var(--fs-caption); }
.chat-recovery { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.chat-mini { margin-top: 8px; padding: 4px 12px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.08); color: var(--text); font-size: var(--fs-caption); }
.chat-mini:disabled { opacity: 0.55; }

.chat-dock { padding: 4px 24px 16px; }
.chat-dock > * { max-width: 720px; margin-left: auto; margin-right: auto; }
.chat-error, .chat-hint { margin: 0 auto 8px; font-size: var(--fs-caption); }
.chat-error { color: var(--failed); }
.chat-hint { color: var(--muted); }
.chat-send-stop { background: var(--text); color: rgb(var(--content-rgb)); }

.chat-panel { flex: none; width: 300px; min-height: 0; overflow: auto; scrollbar-width: none; padding: 12px 20px 16px 4px; display: flex; flex-direction: column; gap: 8px; }
.chat-panel::-webkit-scrollbar { display: none; }
.chat-panel h4 { margin: 8px 0 0; font-size: var(--fs-secondary); font-weight: var(--fw-medium); color: var(--muted); }
.chat-panel-card { border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); padding: 4px 0; }
.chat-kv { display: flex; justify-content: space-between; padding: 7px 14px; font-size: var(--fs-secondary); }
.chat-kv span { color: var(--muted); }
.chat-kv b { font-weight: var(--fw-regular); }
.chat-steps-panel { padding: 10px 14px; }
.chat-debug { font-size: var(--fs-caption); color: var(--muted); }
.chat-debug summary { cursor: pointer; padding: 4px 0; }
.chat-events { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.chat-events li { display: flex; gap: 8px; }
.chat-event-type { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@container (max-width: 960px) { .chat-panel { display: none; } }

/* ── 原型对照（task-7）：两栏 / 右对齐实心气泡 / 助理圆球 / 输入区 chips ─── */
.chat-app .chat-main { margin: 0; }
.chat-app .split-main { padding: 0; padding-top: 0 !important; }
.chat-app .chat-side { flex: 0 0 240px; width: 240px; margin-right: 0; padding-top: 44px; }
.chat-app .pane-toolbar { height: 52px; margin: 0; padding: 0 20px; flex: none; }
.chat-app .chat-dock { padding: 4px 24px 16px; }
.chat-app .chat-scroll { padding: 16px 24px 8px; }
.chat-toolbar .chat-model { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 9px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.06); color: var(--text); font-size: var(--fs-caption); list-style: none; cursor: default; }
.chat-toolbar .chat-model::-webkit-details-marker { display: none; }
.chat-device { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.05); color: var(--muted); font-size: var(--fs-micro); }
.chat-menu { position: relative; }
.chat-menu > summary { list-style: none; }
.chat-menu > summary::-webkit-details-marker { display: none; }
.chat-menu-body { position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; min-width: 230px; padding: 6px; display: flex; flex-direction: column; gap: 2px; border-radius: var(--radius-lg); background: rgb(var(--content-rgb) / 0.98); box-shadow: var(--elevation-2); }
.chat-menu-body button { text-align: left; padding: 7px 10px; border-radius: var(--radius-md); color: var(--text); font-size: var(--fs-caption); background: none; }
.chat-menu-body button:hover:not(:disabled) { background: var(--row-hover); }
.chat-menu-body button:disabled { color: var(--muted); opacity: 1; }
.chat-menu-body button.on { background: rgb(var(--text-rgb) / 0.08); font-weight: var(--fw-medium); }
.chat-menu-body button small { color: var(--muted); font-size: var(--fs-micro); margin-left: 4px; }
.chat-menu-note { margin: 4px 8px 6px; color: var(--muted); font-size: var(--fs-micro); line-height: var(--lh-normal); }
.chat-menu-right > summary { display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--radius-md); color: var(--muted); }

.chat-msg { align-items: flex-start; }
.chat-msg[data-role="user"] .chat-bubble { max-width: 78%; padding: 9px 14px; border-radius: 14px; background: var(--accent); color: var(--on-accent); white-space: pre-wrap; }
.chat-msg-ai { gap: 9px; width: 100%; }
.chat-orb { flex: none; width: 24px; height: 24px; margin-top: 3px; border-radius: 50%; background: radial-gradient(circle at 32% 28%, rgb(var(--content-rgb) / 0.95), rgb(var(--text-rgb) / 0.28) 70%); box-shadow: inset 0 0 0 0.5px rgb(var(--text-rgb) / 0.12); }
.chat-msg.chat-msg-ai .chat-bubble { flex: 1; min-width: 0; padding: 10px 14px; border-radius: 14px; background: rgb(var(--text-rgb) / 0.06); white-space: normal; }
.chat-dock .chat-composer textarea { min-height: 36px; max-height: 140px; }
.chat-dock .chat-composer { padding: 6px 10px; }
.chat-msg-ai .chat-bubble .chat-taskcard { background: rgb(var(--text-rgb) / 0.05); }
.chat-caret { display: inline-block; width: 7px; height: 15px; margin-left: 3px; border-radius: 1px; background: var(--text); animation: chat-caret 1s steps(2, start) infinite; vertical-align: -2px; }
@keyframes chat-caret { 50% { opacity: 0; } }
.chat-step-dot[data-tone="ok"], .chat-step-dot[data-tone="run"] { background: var(--text); }
.chat-step-dot[data-tone="wait"] { background: var(--muted); }

.chat-process { margin-top: 4px; padding: 10px 12px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.03); }
.chat-process > summary { cursor: pointer; color: var(--muted); font-size: var(--fs-caption); }
.chat-process .chat-kv { padding: 5px 0; }
.chat-process .chat-steps { padding: 4px 0; }

.chat-composer { display: flex; flex-direction: column; gap: 8px; }
.chat-composer-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.chat-chip { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.055); color: var(--muted); font-size: var(--fs-caption); }
.chat-chip:hover:not(:disabled) { color: var(--text); background: rgb(var(--text-rgb) / 0.09); }
.chat-chip:disabled { opacity: 0.6; }
.chat-chip.is-static { cursor: default; }
.chat-kbd { color: var(--muted); font-size: var(--fs-micro); }
.chat-dock .chat-composer { border-radius: 16px; background: rgb(var(--text-rgb) / 0.045); padding: 10px 12px; }
.chat-dock .chat-composer textarea { background: none; padding: 2px 0 4px; height: 34px; field-sizing: fixed; }

/* task-8 final overrides */
.chat-app .chat-side { margin: 8px 0 8px 8px !important; }
.chat-app .chat-scroll { padding: 16px 20px 8px; }
.chat-app .chat-thread { max-width: none; }
.chat-dock .chat-composer { padding: 6px 10px; }
.chat-dock .chat-composer textarea { height: 34px; }

.chat-app .pane-toolbar { padding-right: 12px; }
.chat-dock { padding-bottom: 15px; }
.chat-app .chat-scroll { padding: 16px 20px 8px; }

.chat-msg[data-role="user"] { width: 100%; }
.chat-app .pane-toolbar { padding-right: 7px; }
.chat-dock { padding-bottom: 10px; }
.chat-dock .chat-composer textarea { height: 31px; }

.chat-app .chat-scroll { padding-top: 8px; }
.chat-msg[data-role="user"] { width: 100%; }
.chat-msg[data-role="user"] .chat-bubble { margin-left: auto; }
.chat-dock { padding-bottom: 8px; }

.chat-app .chat-thread { align-items: stretch !important; width: 100% !important; }
.chat-app .chat-msg[data-role="user"] { width: 100% !important; justify-content: flex-end !important; }
.chat-app .chat-msg[data-role="user"] .chat-bubble { max-width: 414px; margin-left: auto !important; }
.chat-app .chat-model { padding: 0 4px; }
.chat-dock { padding-bottom: 3px; }

.chat-app .chat-model { padding: 0 6px; margin-right: 4px; }
.chat-dock { padding-bottom: 0; }
.chat-dock .chat-composer textarea { height: 29px; }

.chat-app .chat-msg[data-role="user"] .chat-bubble { width: 414px; flex: 0 0 414px; max-width: 414px; }
.chat-dock .chat-composer textarea { height: 24px; }

.chat-msg[data-role="user"] .chat-bubble { margin-right: 4px !important; }
.chat-app .chat-composer { padding: 3px 10px; }

.chat-dock { padding-bottom: 2px; }
.chat-app .chat-composer { padding: 4px 10px; }
</style>
