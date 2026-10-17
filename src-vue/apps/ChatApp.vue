<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { ArrowUp, ChevronDown, CircleAlert, Plus, ShieldQuestion, Square, Wrench } from "lucide-vue-next";

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
type Msg = { key: string; role: "user" | "assistant"; text: string; pending?: boolean; failed?: boolean };
type ModelOption = { configId: string; displayName: string; providerName: string; isDefault: boolean };
type Approval = { approvalRequestId: string; toolId: string; toolDisplayName?: string; riskClass?: string | null; effectClass?: string; targetDisplayName?: string | null };

const taskBridge = (window as any).openarc?.task;
const modelBridge = (window as any).openarc?.model;
const sideEffectBridge = (window as any).openarc?.sideEffect;
const tasks = ref<Task[]>([]);
const currentId = ref<string | null>(null);
const detail = ref<Detail | null>(null);
const draft = ref("");
const sending = ref(false);
const error = ref("");
const scroller = ref<HTMLElement | null>(null);
const processOpen = ref(true);
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
  if (!modelBridge) return "模型桥不可用。";
  if (modelError.value) return modelError.value;
  if (!models.value.length) return "还没有可用的 chat 模型；可在系统设置里配置。";
  if (selectedModel.value && selectedModel.value.configId !== defaultModelId.value) return "任务桥按后端默认模型执行；这里选择其他模型不会下发（后端尚无任务级模型覆盖命令）。";
  return defaultModel.value ? "默认模型：" + defaultModel.value.displayName + "（" + defaultModel.value.providerName + "）" : "后端未绑定 chat 默认模型。";
});

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
const messages = computed<Msg[]>(() => {
  const d = detail.value; if (!d) return [];
  const out: Msg[] = []; const steps = [...d.steps].sort((a, b) => a.sequence - b.sequence);
  steps.forEach((s, i) => {
    const ask = s.input?.goal ?? (i === 0 ? d.task.goal : ""); if (ask) out.push({ key: s.stepId + ":u", role: "user", text: ask });
    const arts = d.artifacts.filter((a) => a.stepId === s.stepId); const last = arts[arts.length - 1];
    if (last) out.push({ key: s.stepId + ":a", role: "assistant", text: asText(last.content) });
    else if (["FAILED", "CANCELLED", "BLOCKED"].includes(s.status)) out.push({ key: s.stepId + ":a", role: "assistant", text: "步骤" + (STATUS[s.status] || s.status) + "。", failed: true });
    else out.push({ key: s.stepId + ":a", role: "assistant", text: "思考中…", pending: true });
  });
  if (!steps.length) { out.push({ key: "goal", role: "user", text: d.task.goal }); out.push({ key: "wait", role: "assistant", text: running(d.task.status) ? "思考中…" : STATUS[d.task.status] ?? "", pending: running(d.task.status) }); }
  return out;
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
  const byKey = new Map<string, { key: string; title: string; toolId: string; status: string; detail: string; rank: number; sequence: number }>();
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
    if (!prev) byKey.set(key, { key, title, toolId, status, detail, rank, sequence: e.sequence });
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
    <nav class="split-side" aria-label="对话">
      <div class="split-section">对话 <small class="planned-count">{{ tasks.length }}</small></div>
      <button type="button" class="split-nav chat-new" :aria-current="currentId === null ? 'true' : undefined" data-chat-new @click="newSession"><Plus :size="14" /> <span class="split-nav-label">新对话</span></button>
      <div class="notes-list" data-chat-sessions>
        <button v-for="t in tasks" :key="t.taskId" type="button" class="notes-item" :data-chat-session="t.taskId" :aria-current="currentId === t.taskId ? 'true' : undefined" @click="select(t.taskId)"><span class="notes-item-name">{{ t.goal }}</span><small>{{ when(t.updatedAt) }} · {{ STATUS[t.status] ?? t.status }}</small></button>
      </div>
      <p class="planned-note">与「全局 AI」共用 task 桥；历史就是真实任务记录。</p>
    </nav>
    <div class="split-main chat-main">
      <div class="pane-toolbar chat-toolbar">
        <strong class="pane-title chat-title">{{ detail?.task.goal ?? "新对话" }}</strong>
        <div class="toolbar-spacer" />
        <label v-if="modelBridge" class="chat-model-pick" title="模型来自 model/list；任务桥按后端默认模型执行"><span>模型</span>
          <select v-model="selectedModelId" data-chat-model :disabled="!models.length"><option v-if="!models.length" value="">未配置</option><option v-for="m in models" :key="m.configId" :value="m.configId">{{ m.displayName }}{{ m.isDefault ? "（默认）" : "" }}</option></select>
        </label>
        <span v-if="detail" class="notes-status" data-chat-status>{{ STATUS[detail.task.status] ?? detail.task.status }}</span>
        <button v-if="detail && (running(detail.task.status) || sending)" type="button" class="chat-stop" data-chat-stop aria-label="停止任务" title="停止任务" @click="stop"><Square :size="13" /></button>
      </div>
      <p v-if="modelHint" class="chat-model-hint" data-chat-model-hint>{{ modelHint }}</p>
      <div ref="scroller" class="chat-scroll">
        <div v-if="!taskBridge" class="empty-content"><p>任务运行时只在 OpenArc 桌面应用里可用。</p></div>
        <div v-else-if="!currentId" class="chat-empty" data-chat-empty><div class="chat-empty-mark">✦</div><h2>开始一段新对话</h2><p>发一条消息；任务运行时会把步骤、模型调用、工具调用与审批事件写回这里。当前没有 token 级流式，界面按 task/get 快照增量展示。</p></div>
        <div v-for="m in messages" :key="m.key" class="chat-msg" :data-role="m.role" :data-chat-message="m.role" :class="{ pending: m.pending, failed: m.failed }"><div class="chat-bubble"><div v-if="m.role === 'assistant'" class="chat-md" data-chat-markdown v-html="markdown(m.text)" /><template v-else>{{ m.text }}</template></div></div>
        <section v-if="detail && (toolCards.length || eventRows.length)" class="chat-process" data-chat-process>
          <button type="button" class="chat-process-head" :aria-expanded="processOpen" @click="processOpen = !processOpen"><ChevronDown :size="13" :class="{ closed: !processOpen }" /><span>过程 · 工具 {{ toolCards.length }} · 事件 {{ eventRows.length }}</span><small>task/get 快照增量</small></button>
          <template v-if="processOpen">
            <div v-if="toolCards.length" class="chat-tools" data-chat-tools><div v-for="card in toolCards" :key="card.key" class="chat-tool" :data-chat-tool="card.title" :data-chat-tool-id="card.toolId" :data-chat-tool-status="card.status"><Wrench :size="13" /><strong>{{ card.title }}</strong><span :data-chat-tool-state="card.status">{{ card.status }}</span><small v-if="card.toolId && card.toolId !== card.title" class="chat-tool-id">{{ card.toolId }}</small><small v-if="card.detail">{{ card.detail }}</small></div></div>
            <ol v-if="eventRows.length" class="chat-events" data-chat-events><li v-for="e in eventRows" :key="e.eventId" :data-chat-event="e.eventType"><span class="chat-event-seq">#{{ e.sequence }}</span><span class="chat-event-type">{{ e.eventType }}</span><small>{{ when(e.createdAt) }}</small><code v-if="e.safePayload" class="chat-event-payload">{{ JSON.stringify(e.safePayload).slice(0, 220) }}</code></li></ol>
          </template>
        </section>
        <div v-if="approvals.length" class="chat-approvals" data-chat-approvals><div v-for="a in approvals" :key="a.approvalRequestId" class="chat-approval" :data-chat-approval="a.approvalRequestId"><ShieldQuestion :size="15" /><div><strong>等待你的审批</strong><p>{{ a.toolDisplayName || a.toolId }} · {{ a.riskClass || a.effectClass || "副作用" }}<span v-if="a.targetDisplayName"> · {{ a.targetDisplayName }}</span></p><small>审批入口在系统审批浮层（复用 ApprovalPrompt）；批准/拒绝后这里刷新真实状态。</small></div></div></div>
        <p v-if="approvalError" class="chat-error" data-chat-approval-error>审批请求暂不可用（{{ approvalError }}）</p>
        <section v-if="budgetInfo" class="chat-budget" data-chat-budget :data-chat-budget-kind="budgetInfo.kind" :data-chat-budget-resumable="budgetInfo.resumable">
          <CircleAlert :size="16" />
          <div>
            <strong>任务已暂停：{{ budgetInfo.label }}预算用完</strong>
            <p data-chat-budget-summary>{{ budgetInfo.exhaustedText }}</p>
            <div class="chat-budget-metrics">
              <span v-for="row in budgetInfo.rows" :key="row.key" :data-chat-budget-row="row.key">消耗 {{ row.consumed }} / {{ row.authorized }} · 剩余 {{ row.remaining }}</span>
            </div>
            <p class="chat-budget-resume-meta" data-chat-budget-resume-meta>{{ budgetInfo.resumeText }}<span v-if="budgetInfo.add"> · 继续执行追加 +{{ budgetInfo.add }}</span></p>
            <p v-if="budgetError" class="chat-error" role="alert" data-chat-budget-error>{{ budgetError }}</p>
            <button v-if="budgetInfo.resumable" type="button" class="chat-mini chat-budget-resume" data-chat-budget-resume :disabled="resuming" @click="resumeBudget">{{ resuming ? "正在续接…" : "继续执行（追加 +" + budgetInfo.add + "）" }}</button>
            <small v-else class="chat-budget-reason" data-chat-budget-reason>{{ budgetInfo.reasonText }}</small>
          </div>
        </section>
        <p v-if="budgetNotice" class="chat-hint chat-budget-notice" data-chat-budget-notice>{{ budgetNotice }}</p>
        <div v-if="detail && detail.task.status === 'BLOCKED' && !budgetInfo" class="chat-blocked" data-chat-blocked><CircleAlert :size="16" /><div><strong>任务已阻塞{{ detail.stopReason ? "：" + detail.stopReason : "" }}</strong><p v-if="needsAck">有工具结果未知：先核对实际影响并确认，才能恢复。</p><div v-for="c in recoveryCalls" :key="c.callId" class="chat-recovery" :data-chat-recovery-call="c.callId"><span>{{ c.toolId }} · {{ c.recoveryResult }}</span><button v-if="!c.acknowledged" type="button" class="chat-mini" :data-chat-ack="c.callId" @click="acknowledge(c.callId)">我已核查</button><small v-else>已人工确认</small></div><button v-if="detail.resumable" type="button" class="chat-mini" data-chat-resume @click="resume">恢复任务</button></div></div>
      </div>
      <p v-if="error" class="chat-error" role="alert" data-chat-error>{{ error }}</p>
      <p v-else-if="detail && !detail.appendable && terminal(detail.task.status) && detail.appendReason" class="chat-hint" data-chat-append-hint>这段对话不能继续追加（{{ detail.appendReason }}）；可以新建对话。</p>
      <form class="chat-composer" @submit.prevent="send">
        <textarea v-model="draft" rows="1" data-chat-input :placeholder="currentId ? '继续这段对话…' : '给助理发消息…'" aria-label="消息" :disabled="!taskBridge || sending" @keydown="onKey" />
        <button v-if="running(detail?.task.status)" type="button" class="chat-send chat-send-stop" data-chat-stop-composer aria-label="停止任务" @click="stop"><Square :size="13" /></button>
        <button v-else type="submit" class="chat-send" data-chat-send aria-label="发送" :disabled="!draft.trim() || sending || !taskBridge"><ArrowUp :size="15" /></button>
      </form>
      <p class="chat-stream-note" data-chat-stream-note>事件增量来自 task/get 轮询 + 运行结束 task/event 补批；后端没有 token 级流式，界面不伪造打字机效果。</p>
    </div>
  </div>
</template>

<style scoped>
.chat-toolbar { gap: 10px; }
.chat-model-pick { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: var(--fs-micro); }
.chat-model-pick select { max-width: 220px; padding: 3px 7px; border-radius: var(--radius-sm); background: rgb(var(--text-rgb) / 0.06); color: var(--text); font: inherit; font-size: var(--fs-caption); }
.chat-model-hint { margin: 0 28px 4px; color: var(--muted); font-size: var(--fs-micro); line-height: var(--lh-normal); }
.chat-stop { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; color: var(--muted); background: rgb(var(--text-rgb) / 0.06); }
.chat-empty { margin: auto; max-width: 560px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--muted); }
.chat-empty h2 { margin: 0; font-size: var(--fs-title); font-weight: var(--fw-medium); color: var(--text); }
.chat-empty p { margin: 0; font-size: var(--fs-caption); line-height: var(--lh-relaxed); }
.chat-empty-mark { width: 52px; height: 52px; border-radius: 50%; display: grid; place-items: center; background: rgb(var(--text-rgb) / 0.06); color: var(--text); font-size: 24px; }
.chat-md { white-space: normal; }
.chat-md :deep(p) { margin: 0 0 6px; }
.chat-md :deep(h1), .chat-md :deep(h2), .chat-md :deep(h3), .chat-md :deep(h4) { margin: 8px 0 4px; font-size: var(--fs-body); font-weight: var(--fw-medium); }
.chat-md :deep(ul) { margin: 4px 0; padding-left: 18px; }
.chat-md :deep(code) { padding: 1px 4px; border-radius: 4px; background: rgb(var(--text-rgb) / 0.08); font-family: var(--font-mono); font-size: 0.92em; }
.chat-md :deep(.chat-code) { margin: 6px 0; padding: 8px 10px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.07); overflow: auto; white-space: pre; }
.chat-md :deep(.chat-code code) { background: transparent; padding: 0; }
.chat-process { border-top: 0.5px solid var(--line); padding-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.chat-process-head { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: var(--fs-caption); text-align: left; padding: 2px 0; }
.chat-process-head svg { transition: transform var(--quick) var(--ease); }
.chat-process-head svg.closed { transform: rotate(-90deg); }
.chat-process-head small { margin-left: auto; font-size: var(--fs-micro); }
.chat-tools { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 6px; }
.chat-tool { display: flex; align-items: center; gap: 7px; padding: 7px 9px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.05); font-size: var(--fs-caption); min-width: 0; }
.chat-tool strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-tool span { margin-left: auto; color: var(--muted); font-size: var(--fs-micro); white-space: nowrap; }
.chat-tool small { flex-basis: 100%; color: var(--muted); font-size: var(--fs-micro); }
.chat-tool-id { font-family: var(--font-mono); }
.chat-tool[data-chat-tool-state="执行完成"] span { color: var(--success-text, #1e7e34); }
.chat-tool[data-chat-tool-state="执行失败"] span, .chat-tool[data-chat-tool-state="已拒绝"] span, .chat-tool[data-chat-tool-state="权限被拒"] span, .chat-tool[data-chat-tool-state="执行被阻止"] span { color: var(--failed); }
.chat-budget { display: flex; gap: 8px; padding: 11px 12px; border-radius: var(--radius-md); background: color-mix(in srgb, #ff9f0a 12%, transparent); font-size: var(--fs-caption); }
.chat-budget strong { display: block; font-weight: var(--fw-medium); }
.chat-budget p { margin: 3px 0; color: var(--muted); }
.chat-budget-metrics { display: flex; flex-wrap: wrap; gap: 5px; margin: 6px 0 3px; }
.chat-budget-metrics span { padding: 2px 7px; border-radius: var(--radius-sm); background: rgb(var(--text-rgb) / 0.06); color: var(--text); font-size: var(--fs-micro); }
.chat-budget-resume-meta { font-size: var(--fs-micro); }
.chat-budget-notice { color: var(--success-text, #1e7e34) !important; }
.chat-budget-resume { margin-top: 6px; }
.chat-budget-resume:disabled { opacity: 0.55; }
.chat-budget-reason { display: block; margin-top: 5px; color: var(--muted); font-size: var(--fs-micro); }
.chat-events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 210px; overflow: auto; }
.chat-events li { display: flex; align-items: baseline; gap: 7px; font-size: var(--fs-micro); }
.chat-event-seq { color: var(--muted); min-width: 24px; }
.chat-event-type { font-family: var(--font-mono); }
.chat-events small { margin-left: auto; color: var(--muted); }
.chat-event-payload { flex-basis: 100%; color: var(--muted); overflow-wrap: anywhere; }
.chat-approvals { display: flex; flex-direction: column; gap: 6px; }
.chat-approval { display: flex; gap: 8px; padding: 9px 11px; border-radius: var(--radius-md); background: color-mix(in srgb, #ff9f0a 10%, transparent); font-size: var(--fs-caption); }
.chat-approval strong { display: block; font-weight: var(--fw-medium); }
.chat-approval p { margin: 2px 0; }
.chat-approval small { color: var(--muted); font-size: var(--fs-micro); }
.chat-blocked { display: flex; gap: 8px; padding: 10px 12px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.05); font-size: var(--fs-caption); }
.chat-blocked p { margin: 3px 0; color: var(--muted); }
.chat-recovery { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.chat-mini { margin-top: 6px; padding: 3px 9px; border-radius: var(--radius-sm); background: rgb(var(--text-rgb) / 0.08); color: var(--text); font-size: var(--fs-micro); }
.chat-send-stop { background: var(--text); color: rgb(var(--content-rgb)); }
.chat-stream-note { margin: 0 28px 12px; color: var(--muted); font-size: var(--fs-micro); }
</style>
