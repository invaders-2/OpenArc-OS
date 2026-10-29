<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Brain, CalendarClock, LayoutGrid, Puzzle, Check, ChevronRight, Circle, CircleAlert, CircleDot, Copy, FileText, Globe, Image as ImageIcon, Layers, ListChecks, Monitor, MoreHorizontal, Film, PanelRight, Pencil, Pin, PinOff, Play, Trash2, FolderOpen, RotateCcw, ShieldQuestion, Sparkles, SquarePen, Wrench } from "lucide-vue-next";
import ResourcePicker from "./ResourcePicker.vue";
import PreviewPanel from "./chat/PreviewPanel.vue";
import Composer from "./chat/Composer.vue";
import AutomationsPanel from "./chat/AutomationsPanel.vue";
import PluginsPanel from "./chat/PluginsPanel.vue";
import AppsPanel from "./chat/AppsPanel.vue";
import WebActivity from "./chat/WebActivity.vue";
import WebSources from "./chat/WebSources.vue";
import { citeLinks, mergeLiveWeb, sourcesOf, toWebAct, type WebAct } from "./chat/web";
import type { Pick as ComposerPick } from "./chat/types";
import { buildGoal, goalTitle, parseGoal } from "./chat/goal";
import type { ChatFile, SendPayload } from "./chat/types";
import { sizeText } from "./chat/preview";
import { renderMarkdown } from "./chat/markdown";
import { preview, openCode, openInBrowser, openLocalMedia, openUrl, openWorkspace } from "./chat/preview";
import "./chat/chat-rich.css";
import { useShellStore } from "../stores/shell";

/**
 * 对话（task-53）：DSH Harness 会话面。task 桥是唯一真源。
 * task-52 已把 safeEvent/safeCall 并进 task/get，并在运行结束补发 task/event；
 * 这里按 eventId 增量合并，不伪造 token 流式。新对话可在输入区选模型（task/run 的 modelConfigId），
 * 对话开始后模型固定。
 */
type Task = { taskId: string; goal: string; status: string; updatedAt: number; createdAt?: number; revision: number; modelConfigId?: string | null };
type Step = { stepId: string; sequence: number; status: string; input: { goal?: string } | null; kind?: string };
type Artifact = { stepId: string | null; content: unknown; createdAt: number; type?: string };
type SafeEvent = { eventId: string; sequence: number; eventType: string; createdAt: number; safePayload: any };
type SafeCall = { callId: string; stepId: string | null; status: string; startedAt: number; completedAt: number | null; usage?: any; providerErrorCode?: string | null };
type Detail = {
  task: Task; steps: Step[]; artifacts: Artifact[]; events: SafeEvent[]; calls: SafeCall[];
  appendable: boolean; appendReason: string | null; resumable: boolean; stopReason: string | null;
  recovery: any; budgetLedger: any; verifications: any[]; contextWindow?: number | null;
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
/** 主区显示什么：对话，或侧栏顶部入口「自动化 / 插件 / 应用」。 */
const mode = ref<"chat" | "automations" | "plugins" | "apps">("chat");
/** 自动化开出来的对话：taskId → 自动化名（列表里加时钟标记）。 */
const autoTasks = ref<Record<string, string>>({});
const autoCount = ref(0);
function onAutoChanged(map: Record<string, string>, count: number) { autoTasks.value = map; autoCount.value = count; }
const automationBridge = (window as any).openarc?.automation;
/** 开着对话时也要知道哪些对话来自自动化（不打开自动化页也能显示标记）。 */
async function loadAutoMap() {
  const r = await automationBridge?.command?.({ command: "automation/list", payload: {} }).catch(() => null);
  if (!r?.ok) return;
  const list = ((r.value || r).automations || []).filter((a: any) => a?.action?.type === "chat_task");
  const map: Record<string, string> = {};
  for (const a of list) for (const run of a.runs || []) { try { const id = JSON.parse(run.result || "null")?.output?.taskId; if (typeof id === "string") map[id] = a.title; } catch { /* 跳过坏记录 */ } }
  onAutoChanged(map, list.filter((a: any) => a.enabled).length);
}
let offAuto: (() => void) | null = null;
function openAutomations() { mode.value = "automations"; sessionMenu.value = null; }
function openMode(m: "plugins" | "apps") { mode.value = m; sessionMenu.value = null; }
/** 插件页「在对话中使用」：新对话 + 输入区预先选好这个技能 / 连接。 */
function useInChat(pick: ComposerPick) { newSession(); nextTick(() => { composer.value?.addPick(pick); composer.value?.focus(); }); }
/** 应用页「在对话中试试」：新对话 + 填好示例（不自动发送，让用户先看一眼）。 */
function tryInChat(prompt: string) { newSession(); draft.value = prompt; nextTick(() => composer.value?.focus()); }
const resourcePickerOpen = ref(false);
const openTurns = ref<Set<string>>(new Set());
function toggleTurn(key: string) { const next = new Set(openTurns.value); if (next.has(key)) next.delete(key); else next.add(key); openTurns.value = next; }
const models = ref<ModelOption[]>([]);
const defaultModelId = ref("");
const selectedModelId = ref("");
const modelError = ref("");
const approvals = ref<Approval[]>([]);
const approvalError = ref("");
/** 运行中的实时进度（只给界面看，不落库）：流式文字、当前计划、正在用的工具。 */
type PlanItem = { content: string; status: "pending" | "in_progress" | "completed" };
type Live = { taskId: string; text: string; plan: PlanItem[]; tool: string; thinking: string; thinkStart: number; thinkMs: number; usage: { used: number; size: number | null } | null; web: WebAct[] };
const live = ref<Live | null>(null);
/** 思考过程不落库（后端规则），只在本次运行期间留在界面上：按轮次记下来，重开应用后不再显示。 */
const thoughts = ref<Record<string, { text: string; ms: number }>>({});
const openThoughts = ref<Set<string>>(new Set());
function toggleThought(key: string) { const next = new Set(openThoughts.value); if (next.has(key)) next.delete(key); else next.add(key); openThoughts.value = next; }
function onProgress(ev: any) {
  if (!ev || ev.taskId !== currentId.value) return;
  const cur: Live = live.value && live.value.taskId === ev.taskId ? live.value : { taskId: ev.taskId, text: "", plan: [], tool: "", thinking: "", thinkStart: 0, thinkMs: 0, usage: null, web: [] };
  // 思考结束 = 出现了正文或工具调用：记下思考用时
  const endThink = (c: Live) => (c.thinkStart && !c.thinkMs ? { ...c, thinkMs: Date.now() - c.thinkStart } : c);
  if (ev.kind === "text" && typeof ev.text === "string") live.value = { ...endThink(cur), text: (cur.text + ev.text).slice(-20000), tool: "" };
  else if (ev.kind === "thinking" && typeof ev.text === "string") {
    const restart = cur.thinkMs > 0; // 工具调用之后又开始想：接着累计
    live.value = { ...cur, thinking: (cur.thinking + (restart && cur.thinking ? "\n\n" : "") + ev.text).slice(-40000), thinkStart: restart ? Date.now() - cur.thinkMs : cur.thinkStart || Date.now(), thinkMs: 0 };
  }
  else if (ev.kind === "plan" && Array.isArray(ev.items)) live.value = { ...cur, plan: ev.items };
  else if (ev.kind === "tool" && typeof ev.name === "string") live.value = { ...endThink(cur), tool: ev.name };
  else if (ev.kind === "usage" && Number.isFinite(Number(ev.used))) live.value = { ...cur, usage: { used: Number(ev.used), size: Number(ev.size) || null } };
  // 联网过程：正在搜索 / 已搜索（带结果）/ 正在读取 / 已读取
  else if (ev.kind === "web" && ev.activity) live.value = { ...endThink(cur), web: mergeLiveWeb(cur.web, ev.activity) };
}
/** 一轮结束：把这轮的思考过程留在界面上（按轮次 key）。 */
function keepThought() {
  const lv = live.value; if (!lv || !lv.thinking) return;
  const tail = turns.value[turns.value.length - 1]; if (!tail) return;
  thoughts.value = { ...thoughts.value, [tail.key]: { text: lv.thinking, ms: lv.thinkMs || (lv.thinkStart ? Date.now() - lv.thinkStart : 0) } };
}
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
const defaultModel = computed(() => models.value.find((m) => m.configId === defaultModelId.value) || null);
async function loadModels() {
  if (!modelBridge) return;
  modelError.value = "";
  const [list, defaults, providers] = await Promise.all([modelBridge.command({ command: "model/list" }).catch(() => null), modelBridge.command({ command: "defaults/get" }).catch(() => null), modelBridge.command({ command: "provider/list" }).catch(() => null)]);
  const providerNames = new Map<string, string>((Array.isArray(providers?.items) ? providers.items : []).map((p: any) => [String(p.providerId), String(p.displayName || p.providerId)]));
  const items = Array.isArray(list?.items) ? list.items : [];
  defaultModelId.value = defaults?.personal?.chat || defaults?.organization?.chat || "";
  models.value = items.filter((m: any) => String(m.status || "enabled") !== "disabled" && (!Array.isArray(m.capabilities) || m.capabilities.includes("chat"))).map((m: any) => ({
    configId: String(m.configId), displayName: String(m.displayName || m.remoteModelId || m.configId),
    providerName: String(m.providerName || providerNames.get(String(m.providerId)) || "服务商"), isDefault: String(m.configId) === defaultModelId.value,
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
    contextWindow: Number(r.contextWindow) || null,
  };
  mergeEvents(r.events);
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
}

/* 会话列表：搜索 + 按「今天 / 更早」分组 */
const sessionGroups = computed(() => {
  const q = listQuery.value.trim().toLowerCase();
  const hidden = new Set(prefs.value.hidden);
  const visible = tasks.value.filter((t) => !hidden.has(t.taskId));
  const list = q ? visible.filter((t) => (titleOf(t) + "\n" + String(t.goal || "")).toLowerCase().includes(q)) : visible;
  const pinned = new Set(prefs.value.pinned);
  const pins = prefs.value.pinned.map((id) => list.find((t) => t.taskId === id)).filter(Boolean) as Task[];
  const rest = list.filter((t) => !pinned.has(t.taskId));
  const today = new Date().toDateString();
  const a = rest.filter((t) => new Date(Number(t.updatedAt) || 0).toDateString() === today);
  const b = rest.filter((t) => new Date(Number(t.updatedAt) || 0).toDateString() !== today);
  return [{ label: "置顶", items: pins }, { label: "今天", items: a }, { label: "更早", items: b }].filter((g) => g.items.length);
});
/* 对话列表整理：重命名 / 置顶 / 删除（只从列表移除，任务记录和审计保留）。偏好按登录用户存在主进程。 */
const chatBridge = (window as any).openarc?.chat as { command: (c: Record<string, unknown>) => Promise<any> } | undefined;
const prefs = ref<{ titles: Record<string, string>; pinned: string[]; hidden: string[] }>({ titles: {}, pinned: [], hidden: [] });
function setPrefs(r: any) { if (r?.ok) prefs.value = { titles: r.titles || {}, pinned: Array.isArray(r.pinned) ? r.pinned : [], hidden: Array.isArray(r.hidden) ? r.hidden : [] }; }
async function loadPrefs() { if (chatBridge) setPrefs(await chatBridge.command({ command: "prefs/get" }).catch(() => null)); }
async function updatePref(taskId: string, action: string, title = "") {
  if (!chatBridge) return false;
  const r = await chatBridge.command({ command: "prefs/update", taskId, action, title }).catch(() => null);
  setPrefs(r); return !!r?.ok;
}
const titleOf = (t: Task) => prefs.value.titles[t.taskId] || goalTitle(t.goal);
const sessionMenu = ref<{ id: string; x: number; y: number } | null>(null);
const renaming = ref<{ id: string; value: string } | null>(null);
const undoHide = ref<{ id: string; title: string; pinned: boolean } | null>(null);
let undoTimer = 0;
function openSessionMenu(e: MouseEvent, t: Task) {
  e.preventDefault(); e.stopPropagation();
  const host = (e.currentTarget as HTMLElement).closest(".chat-side")?.getBoundingClientRect();
  sessionMenu.value = { id: t.taskId, x: e.clientX - (host?.left || 0), y: e.clientY - (host?.top || 0) };
}
function startRename(id: string) {
  sessionMenu.value = null;
  const t = tasks.value.find((x) => x.taskId === id); if (!t) return;
  renaming.value = { id, value: titleOf(t) };
  nextTick(() => { const el = document.querySelector<HTMLInputElement>("[data-chat-rename-input]"); el?.focus(); el?.select(); });
}
async function commitRename() {
  const r = renaming.value; if (!r) return; renaming.value = null;
  const t = tasks.value.find((x) => x.taskId === r.id);
  const v = r.value.trim();
  await updatePref(r.id, "rename", t && v === goalTitle(t.goal) ? "" : v);
}
async function togglePin(id: string) { sessionMenu.value = null; await updatePref(id, prefs.value.pinned.includes(id) ? "unpin" : "pin"); }
async function hideSession(id: string) {
  sessionMenu.value = null;
  const t = tasks.value.find((x) => x.taskId === id);
  const wasPinned = prefs.value.pinned.includes(id);
  if (t && running(t.status) && taskBridge) await taskBridge.command({ command: "task/cancel", payload: { taskId: id } }).catch(() => null);
  if (!(await updatePref(id, "hide"))) { flash("删除失败，请稍后再试"); return; }
  if (currentId.value === id) newSession();
  undoHide.value = { id, title: t ? titleOf(t) : "对话", pinned: wasPinned };
  window.clearTimeout(undoTimer); undoTimer = window.setTimeout(() => { undoHide.value = null; }, 6000);
}
async function undoHideSession() { const u = undoHide.value; if (!u) return; undoHide.value = null; await updatePref(u.id, "unhide"); if (u.pinned) await updatePref(u.id, "pin"); }
function onDocDown(e: MouseEvent) { if (!(e.target as HTMLElement).closest?.("[data-chat-session-menu]")) sessionMenu.value = null; if (!(e.target as HTMLElement).closest?.("[data-chat-files-pop],[data-chat-files-toggle]")) filesOpen.value = false; }

/* 本对话文件：用户发过的附件 + AI 回答里提到的工作文件夹文件 */
const filesOpen = ref(false);
const convoFiles = computed(() => {
  const out: { path: string; name: string; from: "附件" | "AI 生成" }[] = [];
  const seen = new Set<string>();
  for (const t of turns.value) {
    for (const f of parseGoal(t.ask).files) if (!seen.has(f.path)) { seen.add(f.path); out.push({ path: f.path, name: f.name, from: "附件" }); }
    for (const m of String(t.answer || "").matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/") || href.includes("..")) continue;
      const path = href.replace(/^\.\//, "");
      if (seen.has(path)) continue;
      seen.add(path); out.push({ path, name: path.split("/").pop() || path, from: "AI 生成" });
    }
  }
  return out;
});

/* 语音输入：录音 → 「模型与服务商」里的语音转写模型 → 文字放进输入框。没配转写模型就如实提示。 */
const voiceState = ref({ available: false, recording: false, busy: false, model: "" });
const voice = computed(() => ({
  available: voiceState.value.available, recording: voiceState.value.recording, busy: voiceState.value.busy,
  hint: voiceState.value.recording ? "再点一次结束录音" : voiceState.value.busy ? "正在转成文字…" : voiceState.value.available ? "语音输入（" + voiceState.value.model + "）" : "语音输入：需要先在「系统设置 › 模型与服务商」添加支持语音转写的音频模型",
}));
let recorder: MediaRecorder | null = null;
let recChunks: Blob[] = [];
let recStream: MediaStream | null = null;
async function loadVoice() {
  const r = await chatBridge?.command({ command: "voice/status" }).catch(() => null);
  voiceState.value = { ...voiceState.value, available: !!r?.available, model: String(r?.model || "") };
}
const VOICE_ERR: Record<string, string> = { VOICE_NO_MODEL: "还没有语音转写模型：请在「系统设置 › 模型与服务商」添加支持转写的音频模型。", VOICE_EMPTY: "没录到声音。", VOICE_TOO_LONG: "录音太长了（上限 25 MB）。", VOICE_FAILED: "转写失败" };
async function toggleVoice() {
  if (voiceState.value.busy) return;
  if (voiceState.value.recording) { recorder?.stop(); return; }
  if (!voiceState.value.available) { await loadVoice(); if (!voiceState.value.available) { flash(VOICE_ERR.VOICE_NO_MODEL); return; } }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch { flash("无法使用麦克风：请在系统设置里允许 OpenArc 访问麦克风。"); return; }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find((m) => (window as any).MediaRecorder?.isTypeSupported?.(m)) || "";
  recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  recChunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = async () => {
    recStream?.getTracks().forEach((t) => t.stop()); recStream = null;
    voiceState.value = { ...voiceState.value, recording: false, busy: true };
    try {
      const blob = new Blob(recChunks, { type: recorder?.mimeType || "audio/webm" });
      const r = await chatBridge?.command({ command: "voice/transcribe", data: new Uint8Array(await blob.arrayBuffer()), mime: blob.type }).catch(() => null);
      if (r?.ok && r.text) { draft.value = (draft.value ? draft.value.replace(/\s+$/, "") + " " : "") + r.text; nextTick(() => composer.value?.focus()); }
      else if (r?.ok) flash("没听清，再试一次？");
      else flash((VOICE_ERR[r?.error] || "转写失败") + (r?.detail ? "（" + String(r.detail).slice(0, 80) + "）" : ""));
    } finally { voiceState.value = { ...voiceState.value, busy: false }; recorder = null; }
  };
  recorder.start();
  voiceState.value = { ...voiceState.value, recording: true };
}
const statusTone = (s: string) => (running(s) ? "run" : s === "FAILED" || s === "BLOCKED" ? "bad" : "done");
const toolTone = (status: string) => (status === "执行完成" ? "ok" : status === "执行中" ? "run" : /等待/.test(status) ? "wait" : /失败|拒|阻止/.test(status) ? "bad" : "idle");
type Turn = {
  key: string; ask: string; answer: string; pending: boolean; failed: boolean; tools: any[]; doneAt: number;
  askAt: number; answerAt: number; summary: string; dur: string; rows: WorkRow[]; nodes: NodeRef[]; media: MediaRef[];
  plan: PlanItem[]; web: WebAct[];
};
/** 每一轮 = 用户提问 + 这一轮的工具步骤 + 助手回答；工具/事件按时间归到它之后第一个产出回答的轮次。 */
const turns = computed<Turn[]>(() => {
  const d = detail.value; if (!d) return [];
  const steps = [...d.steps].sort((a, b) => a.sequence - b.sequence);
  const rows: Turn[] = steps.map((s, i) => {
    const ask = s.input?.goal ?? (i === 0 ? d.task.goal : "");
    const arts = d.artifacts.filter((a) => a.stepId === s.stepId); const last = arts[arts.length - 1];
    const failed = !last && ["FAILED", "CANCELLED", "BLOCKED"].includes(s.status);
    const pending = !last && !failed;
    return {
      key: s.stepId, ask, answer: last ? asText(last.content) : failed ? "这一步" + (STATUS[s.status] || s.status) + "。" : "", pending, failed, tools: [],
      doneAt: last ? Number(last.createdAt) || 0 : Infinity,
      // 真实消息时间：用户侧用这一步的 createdAt（没有就退回任务创建时间），助手侧用产物时间
      askAt: Number((s as any).createdAt) || (i === 0 ? Number(d.task.createdAt) || 0 : 0),
      answerAt: last ? Number(last.createdAt) || 0 : 0,
      summary: "", dur: "", rows: [], nodes: [], media: [], plan: [], web: [],
    };
  });
  if (!rows.length) rows.push({
    key: "goal", ask: d.task.goal, answer: running(d.task.status) ? "" : STATUS[d.task.status] ?? "", pending: running(d.task.status), failed: false, tools: [],
    doneAt: Infinity, askAt: Number(d.task.createdAt) || 0, answerAt: Number(d.task.updatedAt) || 0, summary: "", dur: "", rows: [], nodes: [], media: [], plan: [], web: [],
  });
  for (const card of toolCards.value) {
    const target = rows.find((r) => card.at <= r.doneAt) || rows[rows.length - 1];
    target.tools.push(card);
  }
  // 事件里明确带 nodeId / 媒体 url 的，归到同一轮（没有 id/url 的什么也不渲染）
  for (const e of d.events) {
    const at = Number(e.createdAt) || 0;
    const target = rows.find((r) => at <= r.doneAt) || rows[rows.length - 1];
    // 联网记录里的 url 是搜索结果 / 网页地址，不是生成的媒体，单独处理
    if (e.eventType === "harness.web_activity") { const w = toWebAct(e.safePayload, e.eventId); if (w) target.web.push(w); continue; }
    for (const n of nodeRefsIn((e as any).safePayload)) if (!target.nodes.some((x) => x.id === n.id)) target.nodes.push(n);
    for (const m of mediaRefsIn((e as any).safePayload)) if (!target.media.some((x) => x.url === m.url)) target.media.push(m);
    // 这一轮最后一次计划（todo_write）：后一条覆盖前一条
    if (e.eventType === "harness.plan" && Array.isArray(e.safePayload?.items)) target.plan = e.safePayload.items;
  }
  // 运行中：用实时推送的计划（比落库的更新）
  const lv = live.value;
  const tail = rows[rows.length - 1];
  if (lv && lv.taskId === d.task.taskId && tail && tail.pending && lv.plan.length) tail.plan = lv.plan;
  // 运行中：已落库的联网记录 + 实时推送里还没落库的（按搜索词 / 地址去重）
  if (lv && lv.taskId === d.task.taskId && tail && tail.pending && lv.web.length) {
    const sig = (a: WebAct) => a.kind + "|" + (a.query || a.url || "");
    const stored = new Set(tail.web.map(sig));
    tail.web = [...tail.web, ...lv.web.filter((a) => !stored.has(sig(a)))];
  }
  for (const r of rows) {
    const searches = r.web.filter((a) => a.kind === "search"); const reads = r.web.filter((a) => a.kind === "fetch");
    let si = 0; let fi = 0;
    r.summary = r.tools.length ? summarize(r.tools) : "";
    const start = r.tools.length ? Math.min(...r.tools.map((t) => Number(t.at) || r.askAt || Infinity)) : 0;
    const end = r.answerAt || (r.pending ? Date.now() : 0);
    r.dur = start && end && end > start ? "· " + durText(end - start) : "";
    r.rows = r.tools.map((t: any, i: number) => {
      const raw = String(t.title || "工具调用");
      const thinking = /thinking|reasoning|已思考/i.test(raw);
      const failed = /失败|阻止|拒绝|错误|error/i.test(String(t.status || "") + " " + String(t.detail || ""));
      return {
        key: t.key || String(i),
        kind: (thinking ? "thinking" : "tool") as "tool" | "thinking",
        icon: thinking ? "thinking" : rowIcon(raw),
        text: thinking ? raw : webRowText(raw, searches, reads, () => si++, () => fi++),
        // TapNow 实测：成功行只有动词句（无状态后缀），失败才带「(失败)」
        suffix: failed ? "(失败)" : "",
        failed,
        // 原始状态/错误码/详情留在 title 里，便于排查（不显示在正文）
        raw: [String(t.status || ""), String(t.detail || "")].filter(Boolean).join(" · "),
      };
    });
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
  // todo_write 是助手自己的计划清单（已显示成计划卡片）：它的提议和后续更新都不算工具步骤
  const planCalls = new Set(evs.filter((e) => e.safePayload?.toolId === "todo_write" || e.safePayload?.name === "todo_write").map((e) => String(e.safePayload?.toolCallId || "")).filter(Boolean));
  for (const e of evs) {
    if (!/^(tool\.|harness\.tool|harness\.permission)/.test(e.eventType)) continue;
    const p = e.safePayload || {};
    // todo_write 是助手自己的计划清单，已经显示成计划卡片，不算工具步骤
    if (p.toolId === "todo_write" || p.name === "todo_write" || (p.toolCallId && planCalls.has(String(p.toolCallId)))) continue;
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
/* ---------- task-17 对话卡片：消息元信息 / 中间过程组 / 节点 chip / 结果媒体卡 / 空态建议 ---------- */
/**
 * e2e 夹具入口：只有测试在页面加载前塞了 window.__chatFixture 才生效，
 * 正常路径完全不读它（设置后 detail/列表来自夹具，回复与发送都只记录不下发）。
 */
const fixture = (window as any).__chatFixture as { detail?: Detail; tasks?: Task[] } | undefined;
const fixtureMode = !!fixture;
type NodeRef = { id: string; title: string };
type MediaRef = { url: string; name: string; kind: "image" | "video"; nodeId?: string };
type WorkRow = { key: string; kind: "tool" | "thinking"; icon: string; text: string; suffix: string; failed: boolean; raw: string };
const ROW_ICON: Record<string, any> = { doc: FileText, image: ImageIcon, canvas: Layers, gen: Sparkles, tool: Wrench, thinking: Brain, globe: Globe };
const SUGGESTIONS = [
  { icon: Sparkles, title: "写一段产品介绍", sub: "给一个产品名和目标用户，写 200 字卖点文案", prompt: "帮我写一段产品介绍：产品名「轻叠」(可折叠收纳盒)，目标用户是租房的小户型年轻人。要求 200 字以内，先说清解决什么问题，再讲三个具体卖点，语气克制、不要夸张形容词，最后给一句标题。" },
  { icon: ListChecks, title: "把文字整理成要点", sub: "贴一段文字，整理成可直接用的要点清单", prompt: "把下面这段文字整理成要点清单，保留数字和专有名词，合并重复项，每条不超过 30 字：\n\n（把要整理的原文粘贴在这里）" },
];
const toastMsg = ref("");
let toastTimer = 0;
function flash(msg: string) { toastMsg.value = msg; window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { toastMsg.value = ""; }, 1800); }
const copiedKey = ref("");
const copiedText = ref("");
const lastSent = ref("");
const pad2 = (n: number) => String(n).padStart(2, "0");
/** TapNow 的时间戳句式：「10月23日 09:07」 */
function msgTime(t: number) {
  const ts = Number(t) || 0; if (!ts) return "";
  const d = new Date(ts); if (!Number.isFinite(d.getTime())) return "";
  return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}
function durText(ms: number) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000)); if (!s) return "";
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60); const r = s % 60;
  if (m < 60) return m + "m" + (r ? pad2(r) + "s" : "");
  const h = Math.floor(m / 60); const m2 = m % 60;
  return h + "h" + (m2 ? pad2(m2) + "m" : "");
}
/**
 * 工具行文案（TapNow 实测是动词句：「已创建文本节点」「修改画布 1 次」）。
 * 只映射我们真实有的工具；映射不到就**原样显示 toolId**，绝不编中文。
 */
const TOOL_LABEL: Array<[RegExp, string]> = [
  [/^(read_file|read_files|read_selected_node|read_text_node)$/i, "读取文件"],
  [/^(write_file|write_text_node)$/i, "写入文件"],
  [/^(web_fetch|browser_read_page|fetch_url)$/i, "读取网页"],
  [/^web_search$/i, "联网搜索"],
  [/^(image_search|search_images)$/i, "搜索参考图"],
  [/^(canvas_update_nodes|update_nodes|edit_canvas|connect_nodes)$/i, "修改画布"],
  [/^(canvas_get_state|canvas_read|read_canvas|get_canvas)$/i, "查看画布"],
  [/^(canvas_generate_image|generate_image|generate_video)$/i, "准备生成节点"],
  [/^(submit_generation|prepare_generation|prepareGenerations)$/i, "准备生成节点"],
  [/^create_text_node$/i, "创建文本节点"],
  [/^create_image_node$/i, "创建图片节点"],
  [/^(read_skill_file|readSkillFile)$/i, "读取技能"],
  [/^(find_files|search_files)$/i, "查找文件"],
  [/^(task_ask|ask_user|ask_question)$/i, "向你确认"],
  [/^skill_list$/i, "查看技能"],
  [/^skill_load$/i, "读取技能"],
  [/^workspace_list$/i, "查看工作文件夹"],
  [/^workspace_read$/i, "读取文件"],
  [/^workspace_search$/i, "查找文件"],
  [/^workspace_write$/i, "写入文件"],
  [/^workspace_exec$/i, "运行命令"],
  [/^memory_save$/i, "记住"],
  [/^memory_search$/i, "查找记忆"],
  [/^subagent$/i, "交给子 agent"],
  [/^mcp_/i, "调用 MCP 工具"],
  [/^(thinking|reasoning)$/i, "已思考"],
];
/** 工作明细里的联网行：按顺序对上联网记录，显示搜索词 / 网站（对不上就保持原文案）。 */
function webRowText(raw: string, searches: WebAct[], reads: WebAct[], nextS: () => number, nextF: () => number) {
  const head = String(raw || "").trim().split(/\s+/)[0] || "";
  if (/^web_search$/i.test(head)) { const a = searches[nextS()]; if (a?.query) return "联网搜索 · " + a.query; }
  else if (/^web_fetch$/i.test(head)) { const a = reads[nextF()]; if (a?.url) { let h = a.url; try { h = new URL(a.url).hostname.replace(/^www\./, ""); } catch { /* 原样 */ } return "读取网页 · " + (a.title || h); } }
  return toolLabel(raw);
}
function toolLabel(title: string) {
  const text = String(title || "").trim(); if (!text) return "工具调用";
  const parts = text.split(/\s+/); const head = parts[0]; const rest = parts.slice(1).join(" ");
  for (const [re, label] of TOOL_LABEL) if (re.test(head)) return rest ? label + " · " + rest : label;
  return text;
}
/** 摘要句：用 TapNow 的动词口径归类计数（没有对应类别的不硬塞） */
const TOOL_CATEGORY: Array<[RegExp, string]> = [
  [/^(canvas_get_state|canvas_read|read_canvas|get_canvas)$/i, "canvasView"],
  [/^(canvas_update_nodes|update_nodes|edit_canvas|connect_nodes|create_text_node|create_image_node)$/i, "canvasEdit"],
  [/^(canvas_generate_image|generate_image|generate_video|submit_generation|prepare_generation|prepareGenerations)$/i, "gen"],
  [/^(image_search|search_images)$/i, "search"],
  [/^web_search$/i, "webSearch"],
  [/^(read_file|read_files|write_file|web_fetch|browser_read_page|read_skill_file|readSkillFile|find_files|search_files|workspace_list|workspace_read|workspace_search)$/i, "read"],
  [/^(skill_list|skill_load)$/i, "skill"],
  [/^workspace_write$/i, "fileWrite"],
  [/^workspace_exec$/i, "exec"],
  [/^memory_save$/i, "memSave"],
  [/^memory_search$/i, "memRead"],
  [/^subagent$/i, "sub"],
  [/^mcp_/i, "mcp"],
];
function toolCategory(title: string) {
  const head = String(title || "").trim().split(/\s+/)[0] || "";
  for (const [re, kind] of TOOL_CATEGORY) if (re.test(head)) return kind;
  return "other";
}
const ICON_BY_CATEGORY: Record<string, string> = { canvasView: "canvas", canvasEdit: "canvas", gen: "gen", search: "image", webSearch: "globe", read: "doc", skill: "doc", fileWrite: "doc", exec: "tool", memSave: "doc", memRead: "doc", sub: "tool", mcp: "tool", other: "tool" };
function rowIcon(title: string) { return ICON_BY_CATEGORY[toolCategory(title)] || "tool"; }
function summarize(tools: any[]) {
  const c: Record<string, number> = { canvasView: 0, canvasEdit: 0, gen: 0, search: 0, webSearch: 0, read: 0, skill: 0, fileWrite: 0, exec: 0, memSave: 0, memRead: 0, sub: 0, mcp: 0, other: 0 };
  for (const t of tools) c[toolCategory(String(t.title || ""))] += 1;
  const parts: string[] = [];
  if (c.canvasView) parts.push("查看了画布 " + c.canvasView + " 次");
  if (c.canvasEdit) parts.push("修改画布 " + c.canvasEdit + " 次");
  if (c.gen) parts.push("准备了 " + c.gen + " 个生成节点");
  if (c.search) parts.push("搜索了 " + c.search + " 次参考图");
  if (c.webSearch) parts.push("联网搜索了 " + c.webSearch + " 次");
  if (c.read) parts.push("读取了 " + c.read + " 个文件/网页");
  if (c.skill) parts.push("查看了 " + c.skill + " 次技能");
  if (c.fileWrite) parts.push("写入了 " + c.fileWrite + " 个文件");
  if (c.exec) parts.push("运行了 " + c.exec + " 条命令");
  if (c.memRead) parts.push("翻了 " + c.memRead + " 次记忆");
  if (c.memSave) parts.push("记下了 " + c.memSave + " 件事");
  if (c.sub) parts.push("派了 " + c.sub + " 个子 agent");
  if (c.mcp) parts.push("调用了 " + c.mcp + " 次 MCP 工具");
  if (!parts.length) return tools.length ? "完成了 " + tools.length + " 个操作" : "";
  return parts.join("，") + (tools.length ? " · 共 " + tools.length + " 个操作" : "");
}
/** 只看明确带 nodeId / nodeIds / node{id} 的 payload：没有 id 就不渲染 chip（不猜） */
function nodeRefsIn(payload: any): NodeRef[] {
  const out: NodeRef[] = [];
  const push = (id: any, title: any) => {
    const s = String(id || "").trim(); if (!s || s.length > 120) return;
    if (out.some((x) => x.id === s)) return;
    out.push({ id: s, title: String(title || s).slice(0, 40) });
  };
  if (!payload || typeof payload !== "object") return out;
  if (typeof payload.nodeId === "string") push(payload.nodeId, payload.nodeTitle ?? payload.title ?? payload.name);
  if (Array.isArray(payload.nodeIds)) for (const x of payload.nodeIds) push(typeof x === "string" ? x : x?.id, typeof x === "string" ? null : (x?.title ?? x?.name));
  if (payload.node && typeof payload.node === "object") push(payload.node.id, payload.node.title ?? payload.node.name);
  return out;
}
/** 只看明确带 url 的 payload：没有 URL 就不渲染媒体卡（不做占位假图） */
function mediaRefsIn(payload: any): MediaRef[] {
  const out: MediaRef[] = []; if (!payload || typeof payload !== "object") return out;
  const walk = (v: any, depth = 0) => {
    if (!v || depth > 3 || typeof v !== "object") return;
    if (typeof v.url === "string" && /^(https?:|asset:|blob:|file:|data:image\/)/.test(v.url) && !out.some((x) => x.url === v.url)) {
      const name = String(v.fileName || v.name || decodeURIComponent(v.url.split("/").pop() || "") || "输出").slice(0, 80);
      out.push({ url: v.url, name, kind: /\.(mp4|mov|webm|m4v)(\?|$)/i.test(v.url) || v.kind === "video" || /^video\//.test(String(v.mime || v.mimeType || "")) ? "video" : "image", nodeId: typeof v.nodeId === "string" ? v.nodeId : undefined });
    }
    for (const k of Object.keys(v)) if (v[k] && typeof v[k] === "object") walk(v[k], depth + 1);
  };
  walk(payload);
  return out.slice(0, 4);
}
async function copyText(text: string, key: string) {
  const value = String(text || "");
  try { await navigator.clipboard.writeText(value); } catch {
    const ta = document.createElement("textarea"); ta.value = value; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } finally { ta.remove(); }
  }
  copiedKey.value = key; copiedText.value = value; flash("已复制");
}
/** 画布桥：外壳把画布以 ReactIsland 挂在同一个 document 里 —— 先聚焦画布窗口，再在节点元素上派发真实 pointerdown（等价于用户点一下） */
function focusNode(ref: NodeRef | { id?: string; title?: string }) {
  const id = String(ref?.id || ""); if (!id) return;
  const shell = useShellStore();
  const win = shell.windows.find((w: any) => w.appId === "canvas");
  if (win) shell.focusWindow(win.id);
  const el = document.querySelector('.cn-root [data-id="' + id + '"]') as HTMLElement | null;
  if (!el) { flash("这个节点所在的画布还没打开"); return; }
  const r = el.getBoundingClientRect();
  const base = { bubbles: true, cancelable: true, clientX: r.left + Math.min(40, r.width / 2), clientY: r.top + 24, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1 }));
  el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
  flash("已定位画布节点");
}
function openMedia(m: MediaRef) {
  if (m.nodeId) { window.dispatchEvent(new CustomEvent("cn:lightbox", { detail: m.nodeId })); return; }
  if (!m.url) return;
  if (/^https?:/i.test(m.url)) void openUrl(m.url, m.name);
  else openLocalMedia(m.url, m.name, m.kind);
}
/**
 * 消息正文里的点击（事件委托）：链接 / 工作文件夹文件 / 外部图片 → 预览侧栏；代码块的复制 / 预览。
 * 按住 ⌘ / Ctrl 点链接：直接交给 OpenArc 浏览器。
 */
async function onThreadClick(e: MouseEvent) {
  const el = (e.target as HTMLElement | null)?.closest?.("[data-md-act]") as HTMLElement | null;
  if (!el) return;
  const act = el.getAttribute("data-md-act");
  if (act === "link") {
    const href = el.getAttribute("href") || "";
    e.preventDefault();
    if (!/^https?:/i.test(href)) return;
    if (e.metaKey || e.ctrlKey) { void openInBrowser(href); return; }
    void openUrl(href, (el.textContent || "").trim().slice(0, 60));
    return;
  }
  if (act === "ws") { e.preventDefault(); void openWorkspace(el.getAttribute("data-md-src") || "", (el.textContent || "").trim()); return; }
  if (act === "image") {
    const src = el.getAttribute("data-md-src") || "";
    if (/^https?:/i.test(src)) void openUrl(src);
    else if (src) openLocalMedia(src, el.getAttribute("alt") || "图片", "image");
    return;
  }
  const block = el.closest(".md-code") as HTMLElement | null;
  const code = block?.querySelector("pre code")?.textContent || "";
  if (act === "code-copy") {
    await copyText(code, "code");
    el.textContent = "已复制"; window.setTimeout(() => { el.textContent = "复制"; }, 1400);
    return;
  }
  if (act === "code-preview") void openCode(code, block?.getAttribute("data-md-lang") || "");
}
/** 这一轮只用了联网工具：联网过程区已经把每一步列清楚，不再重复显示工具明细。 */
const onlyWeb = (turn: Turn) => turn.web.length > 0 && turn.tools.every((t: any) => /^web_(search|fetch)$/i.test(String(t.title || "").trim().split(/\s+/)[0] || ""));
/** 联网结果 / 来源的点击：默认在预览侧栏打开，按住 ⌘ / Ctrl 交给 OpenArc 浏览器。 */
function onWebOpen(url: string, title: string, ev: MouseEvent) {
  if (!/^https?:/i.test(url)) return;
  if (ev && (ev.metaKey || ev.ctrlKey)) { void openInBrowser(url); return; }
  void openUrl(url, String(title || "").slice(0, 60));
}
/** 工具结果里的 http(s) 媒体：经主进程取回（同一套安全检查）后再显示，界面本身不直连外网。 */
const mediaSrc = ref<Record<string, string>>({});
const mediaPending = new Set<string>();
function srcOf(m: MediaRef) {
  if (!/^https?:/i.test(m.url)) return m.url;
  const hit = mediaSrc.value[m.url]; if (hit) return hit;
  if (!mediaPending.has(m.url)) {
    mediaPending.add(m.url);
    void (window as any).openarc?.chat?.command({ command: "preview/remote", url: m.url }).then((r: any) => {
      if (r?.ok && r.previewUrl) mediaSrc.value = { ...mediaSrc.value, [m.url]: r.previewUrl };
    }).catch(() => null);
  }
  return "";
}
/** 气泡里图片附件的缩略图：经预览协议取工作文件夹里的图（只取一次）。 */
const thumbs = ref<Record<string, string>>({});
const thumbPending = new Set<string>();
function thumbOf(path: string) {
  if (thumbs.value[path]) return thumbs.value[path];
  if (!thumbPending.has(path) && chatBridge) {
    thumbPending.add(path);
    void chatBridge.command({ command: "preview/workspace", path }).then((r: any) => { if (r?.ok && r.kind === "image" && r.previewUrl) thumbs.value = { ...thumbs.value, [path]: r.previewUrl }; }).catch(() => null);
  }
  return "";
}
/** 编辑重发：把这句话放回输入框，改完再发（作为新的一轮）。 */
function editTurn(turn: { ask: string }) {
  const p = parseGoal(turn.ask);
  draft.value = p.text;
  composer.value?.setFiles(p.files);
  nextTick(() => { const el = document.querySelector<HTMLTextAreaElement>("[data-chat-input]"); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); });
}
function useSuggestion(s: { prompt: string }) { draft.value = s.prompt; nextTick(() => document.querySelector<HTMLTextAreaElement>("[data-chat-input]")?.focus()); }
function retryTurn(turn: { ask: string }) { void sendGoal(String(turn.ask || ""), null); }

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

/** Markdown 渲染（GFM 表格 / 任务列表 / 代码高亮 / 公式），见 chat/markdown.ts。 */
const markdown = (src: string) => renderMarkdown(src);
const planDone = (plan: PlanItem[]) => plan.filter((x) => x.status === "completed").length;
function thoughtOf(turn: Turn): { text: string; ms: number; live: boolean } | null {
  const lv = liveFor(turn);
  if (lv && lv.thinking) return { text: lv.thinking, ms: lv.thinkMs || 0, live: !lv.thinkMs };
  const kept = thoughts.value[turn.key];
  return kept ? { ...kept, live: false } : null;
}
/** 思考中默认展开，想完自动收起；用户点过就按用户的来。 */
const thoughtOpen = (turn: Turn) => { const t = thoughtOf(turn); const flipped = openThoughts.value.has(turn.key); return t?.live ? !flipped : flipped; };
const liveFor = (turn: Turn) => (turn.pending && live.value && live.value.taskId === currentId.value ? live.value : null);
function select(id: string | null) { mode.value = "chat"; currentId.value = id; detail.value = null; error.value = ""; live.value = null; if (id) void loadDetail(id); }
function newSession() { select(null); draft.value = ""; error.value = ""; modelError.value = ""; composer.value?.reset(); }
const composer = ref<InstanceType<typeof Composer> | null>(null);
function send(p: SendPayload) {
  const goal = buildGoal(p.text, p.files, p.picks);
  return sendGoal(goal, p.modelConfigId, true);
}
async function sendGoal(goal: string, modelConfigId: string | null, fromComposer = false) {
  const text = goal.trim(); if (!text || sending.value || !taskBridge) return;
  // 夹具模式（e2e）：只记录这次发送，绝不下发到任何后端
  if (fixtureMode) { lastSent.value = text; draft.value = ""; composer.value?.reset(); flash("已发送（夹具模式：不会发给任何后端）"); return; }
  sending.value = true; error.value = ""; const id = currentId.value; live.value = null;
  const runPayload: Record<string, unknown> = { goal: text };
  if (modelConfigId) runPayload.modelConfigId = modelConfigId;
  const r = id ? await taskBridge.command({ command: "task/appendStep", payload: { taskId: id, goal: text } }).catch(() => null) : await taskBridge.command({ command: "task/run", payload: runPayload }).catch(() => null);
  sending.value = false;
  if (!r?.ok) { error.value = errText(r?.error) + (r?.detail ? "（" + String(r.detail).slice(0, 160) + "）" : ""); return; }
  if (fromComposer) { draft.value = ""; composer.value?.reset(); }
  currentId.value = r.taskId; await Promise.all([loadList(), loadDetail(r.taskId)]);
}
function onComposerCommand(name: string) {
  if (name === "new") newSession();
  else if (name === "resource") resourcePickerOpen.value = true;
}
/** 输入区的上下文用量：运行中用实时值，否则用最近一次记录；窗口大小缺失时用模型的上下文上限。 */
const ctxUsage = computed(() => {
  const lv = live.value && live.value.taskId === currentId.value ? live.value.usage : null;
  const d = detail.value;
  let u = lv;
  if (!u && d) { const e = [...d.events].reverse().find((x) => x.safePayload?.usage && Number.isFinite(Number(x.safePayload.usage.used))); if (e) u = { used: Number(e.safePayload.usage.used), size: Number(e.safePayload.usage.size) || null }; }
  if (!u) return d?.contextWindow ? { used: 0, size: d.contextWindow } : null;
  return { used: u.used, size: u.size || d?.contextWindow || null };
});
const lockedModelId = computed(() => (currentId.value ? detail.value?.task.modelConfigId || defaultModelId.value || null : null));
const composerPlaceholder = computed(() => (currentId.value ? "继续这段对话…（@ 引用文件，/ 命令与技能）" : "给助理发消息，@ 引用文件，/ 选择技能或命令"));
async function stop() { if (!taskBridge || !currentId.value) return; const r = await taskBridge.command({ command: "task/cancel", payload: { taskId: currentId.value } }).catch(() => null); if (!r?.ok) error.value = errText(r?.error); await loadDetail(); }
async function resume() { if (!taskBridge || !currentId.value || !detail.value) return; const r = await taskBridge.command({ command: "task/resume", payload: { taskId: currentId.value, expectedRevision: detail.value.task.revision } }).catch(() => null); if (!r?.ok) error.value = errText(r?.error); await loadDetail(); }
async function acknowledge(callId: string) { if (!taskBridge || !currentId.value) return; const r = await taskBridge.command({ command: "task/acknowledgeUnknownEffect", payload: { taskId: currentId.value, callId } }).catch(() => null); if (!r?.ok) error.value = errText(r?.error); await loadDetail(); }
async function attachResource(ref: string) {
  resourcePickerOpen.value = false;
  let name = ref;
  const res = await resourceBridge?.command({ type: "resource/get", resourceRef: ref }).catch(() => null);
  if (res && res.ok && res.resource && res.resource.name) name = String(res.resource.name);
  draft.value = (draft.value ? draft.value.replace(/\s+$/, "") + " " : "") + "@" + name + " ";
}
async function loadApprovals() { if (!sideEffectBridge) return; const r = await sideEffectBridge.command({ type: "sideEffect/listPending" }).catch(() => null); if (Array.isArray(r?.items)) approvals.value = r.items; else if (r?.ok === false) approvalError.value = String(r.error || "APPROVAL_UNAVAILABLE"); }
onMounted(async () => {
  if (fixtureMode) {
    if (fixture?.tasks) tasks.value = fixture.tasks;
    if (fixture?.detail) { detail.value = fixture.detail; currentId.value = fixture.detail.task.taskId; }
    return;
  }
  document.addEventListener("mousedown", onDocDown);
  await Promise.all([loadList(), loadModels(), loadApprovals(), loadPrefs(), loadVoice(), loadAutoMap()]);
  offAuto = automationBridge?.onEvent?.((ev: any) => { const p = ev?.payload || ev; if (p && p.runId && !p.command && (p.phase === "completed" || p.phase === "failed")) { void loadAutoMap(); void loadList(); } }) ?? null;
  off = taskBridge?.onEvent((ev: any) => {
    if (!ev) return;
    if (ev.type === "task/result") { void loadList(); void loadApprovals(); if (autoTasks.value[ev.taskId] !== undefined || !prefs.value.titles[ev.taskId]) void loadPrefs(); if (ev.taskId === currentId.value) { keepThought(); live.value = null; void loadDetail(); } }
    else if (ev.type === "task/progress") onProgress(ev);
    else if (ev.type === "task/created") { void loadList(); void loadPrefs(); void loadAutoMap(); }
    else if (ev.type === "task/event" && ev.taskId === currentId.value) mergeEvents(ev.events);
  }) ?? null;
  offApproval = sideEffectBridge?.onEvent?.((ev: any) => { if (ev?.type === "sideEffect/approvalRequested") { if (ev.request) approvals.value = [ev.request, ...approvals.value.filter((a) => a.approvalRequestId !== ev.request.approvalRequestId)]; else void loadApprovals(); } }) ?? null;
  poll = window.setInterval(() => { if (detail.value && (running(detail.value.task.status) || sending.value)) void loadDetail(); if (running(detail.value?.task.status) || approvals.value.length) void loadApprovals(); }, 700);
});
/* 后台任务：点通知时外壳把要打开的对话放在 taskFocus；当前看着哪段对话告诉外壳，避免对正在看的对话再弹通知 */
const shellStore = useShellStore();
watch(() => shellStore.taskFocus, (id) => { if (!id) return; if (id !== currentId.value) select(id); shellStore.taskFocus = null; void loadList(); }, { immediate: true });
watch(currentId, (id) => { shellStore.viewingTaskId = id; }, { immediate: true });
onBeforeUnmount(() => { document.removeEventListener("mousedown", onDocDown); window.clearTimeout(undoTimer); if (recorder && recorder.state !== "inactive") recorder.stop(); recStream?.getTracks().forEach((t) => t.stop()); off?.(); offApproval?.(); offAuto?.(); window.clearInterval(poll); shellStore.viewingTaskId = null; });
</script>

<template>
  <div class="split chat-app">
    <!-- 原型 C：会话列表 280（搜索 · 今天 / 更早） -->
    <nav class="split-side chat-side" aria-label="对话">
      <div class="chat-side-top">
        <label class="ds-search chat-search"><input v-model="listQuery" class="ds-search__input" type="search" placeholder="搜索对话" aria-label="搜索对话" /></label>
      </div>
      <button type="button" class="chat-nav" data-chat-new :aria-current="mode === 'chat' && !currentId ? 'page' : undefined" @click="newSession">
        <SquarePen :size="15" /><span>新对话</span>
      </button>
      <button type="button" class="chat-nav" data-chat-nav-automations :aria-current="mode === 'automations' ? 'page' : undefined" @click="openAutomations">
        <CalendarClock :size="15" /><span>自动化</span><small v-if="autoCount" data-chat-nav-count>{{ autoCount }}</small>
      </button>
      <button type="button" class="chat-nav" data-chat-nav-plugins :aria-current="mode === 'plugins' ? 'page' : undefined" @click="openMode('plugins')">
        <Puzzle :size="15" /><span>插件</span>
      </button>
      <button type="button" class="chat-nav" data-chat-nav-apps :aria-current="mode === 'apps' ? 'page' : undefined" @click="openMode('apps')">
        <LayoutGrid :size="15" /><span>应用</span>
      </button>
      <div class="chat-sessions" data-chat-sessions>
        <template v-for="g in sessionGroups" :key="g.label">
          <div class="split-section">{{ g.label }}</div>
          <div v-for="t in g.items" :key="t.taskId" class="chat-session-row" :aria-current="mode === 'chat' && currentId === t.taskId ? 'true' : undefined">
            <form v-if="renaming && renaming.id === t.taskId" class="chat-session chat-session-edit" @submit.prevent="commitRename">
              <input v-model="renaming.value" data-chat-rename-input maxlength="80" aria-label="对话名称" @keydown.esc.prevent="renaming = null" @blur="commitRename" />
            </form>
            <button v-else type="button" class="chat-session" :data-chat-session="t.taskId" :aria-current="mode === 'chat' && currentId === t.taskId ? 'true' : undefined" @click="select(t.taskId)" @dblclick="startRename(t.taskId)" @contextmenu="openSessionMenu($event, t)">
              <span class="chat-session-name"><Pin v-if="prefs.pinned.includes(t.taskId)" :size="11" class="chat-session-pin" /><CalendarClock v-if="autoTasks[t.taskId]" :size="11" class="chat-session-pin" :data-chat-session-auto="t.taskId" :aria-label="'来自自动化：' + autoTasks[t.taskId]" />{{ titleOf(t) }}</span>
              <small><span v-if="running(t.status)" class="chat-live" aria-hidden="true" />{{ STATUS[t.status] ?? t.status }} · {{ when(t.updatedAt) }}</small>
            </button>
            <button v-if="!renaming || renaming.id !== t.taskId" type="button" class="chat-session-more" :data-chat-session-more="t.taskId" title="更多" aria-label="对话操作" @click="openSessionMenu($event, t)"><MoreHorizontal :size="14" /></button>
          </div>
        </template>
        <p v-if="!tasks.length" class="chat-side-empty">还没有对话。</p>
        <p v-else-if="!sessionGroups.length" class="chat-side-empty">没有匹配的对话。</p>
      </div>
      <div v-if="sessionMenu" class="chat-menu-body chat-session-menu" data-chat-session-menu :style="{ left: Math.min(sessionMenu.x, 120) + 'px', top: sessionMenu.y + 'px', right: 'auto' }" role="menu">
        <button type="button" role="menuitem" data-chat-session-rename @click="startRename(sessionMenu.id)"><Pencil :size="13" />重命名</button>
        <button type="button" role="menuitem" data-chat-session-pin @click="togglePin(sessionMenu.id)"><PinOff v-if="prefs.pinned.includes(sessionMenu.id)" :size="13" /><Pin v-else :size="13" />{{ prefs.pinned.includes(sessionMenu.id) ? "取消置顶" : "置顶" }}</button>
        <button type="button" role="menuitem" class="danger" data-chat-session-delete @click="hideSession(sessionMenu.id)"><Trash2 :size="13" />删除</button>
        <p class="chat-menu-note">删除只是从列表移除，任务记录和审计会保留。</p>
      </div>
      <div v-if="undoHide" class="chat-undo" role="status" data-chat-undo>
        <span>已删除「{{ undoHide.title.slice(0, 16) }}」</span><button type="button" data-chat-undo-btn @click="undoHideSession">撤销</button>
      </div>
    </nav>

    <div v-if="mode === 'automations'" class="split-main chat-main">
      <AutomationsPanel :tasks="tasks" :models="models" :default-model-id="defaultModelId" @open="select" @changed="onAutoChanged" />
    </div>
    <div v-if="mode === 'plugins'" class="split-main chat-main"><PluginsPanel @use="useInChat" /></div>
    <div v-if="mode === 'apps'" class="split-main chat-main"><AppsPanel @try="tryInChat" /></div>
    <div class="split-main chat-main" :class="{ 'chat-main-hidden': mode !== 'chat' }">
      <div class="pane-toolbar chat-toolbar">
        <strong class="pane-title chat-title">{{ detail ? titleOf(detail.task) : "新对话" }}</strong>
        <span v-if="detail" class="chat-status" data-chat-status :data-tone="statusTone(detail.task.status)">{{ STATUS[detail.task.status] ?? detail.task.status }}</span>
        <div class="toolbar-spacer" />
        <div v-if="convoFiles.length" class="chat-files-wrap">
          <button type="button" class="chat-icon-btn chat-files-btn" data-chat-files-toggle :aria-pressed="filesOpen" title="本对话的文件" aria-label="本对话的文件" @click="filesOpen = !filesOpen"><FolderOpen :size="16" /><small>{{ convoFiles.length }}</small></button>
          <div v-if="filesOpen" class="chat-menu-body chat-files-pop" data-chat-files-pop role="menu">
            <p class="chat-menu-note">本对话的文件（点开在右侧预览）</p>
            <button v-for="f in convoFiles" :key="f.path" type="button" role="menuitem" :data-chat-files-item="f.path" :title="f.path" @click="filesOpen = false; openWorkspace(f.path, f.name)">
              <FileText :size="13" /><span class="chat-files-name">{{ f.name }}</span><small>{{ f.from }}</small>
            </button>
          </div>
        </div>
        <button v-if="preview.items.length" type="button" class="chat-icon-btn" data-chat-preview-toggle :aria-pressed="preview.open" :title="preview.open ? '收起预览' : '打开预览'" aria-label="预览侧栏" @click="preview.open = !preview.open"><PanelRight :size="16" /></button>
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
            <div class="chat-thread" @click="onThreadClick">
              <div v-if="!taskBridge" class="chat-empty"><p>对话只在 OpenArc 桌面应用里可用。</p></div>
              <div v-else-if="!currentId" class="chat-empty" data-chat-empty>
                <div class="chat-empty-mark"><Sparkles :size="22" :stroke-width="1.5" /></div>
                <h2>有什么可以帮你？</h2>
                <p>可以直接提问，也可以让助理动手做事：它会一步步调用工具，需要你确认的操作会先停下来请你批准。</p>
                <p v-if="!models.length && modelBridge" class="chat-empty-warn">还没有可用的对话模型，请先到「系统设置 › 模型与服务商」添加。</p>
                <div class="chat-suggest" data-chat-suggest>
                  <button v-for="(s, i) in SUGGESTIONS" :key="s.title" type="button" class="chat-suggest-card" :data-chat-suggest-card="i" @click="useSuggestion(s)">
                    <component :is="s.icon" :size="16" class="chat-suggest-ic" />
                    <span class="chat-suggest-body"><strong>{{ s.title }}</strong><small>{{ s.sub }}</small></span>
                    <ChevronRight :size="16" class="chat-suggest-arrow" />
                  </button>
                </div>
              </div>

              <template v-for="turn in turns" :key="turn.key">
                <div class="chat-msg" data-role="user" data-chat-message="user">
                  <div v-if="parseGoal(turn.ask).picks.length" class="chat-picks" data-chat-bubble-picks>
                    <span v-for="p in parseGoal(turn.ask).picks" :key="p.kind + p.id" class="cmp-pick"><Sparkles v-if="p.kind === 'skill'" :size="12" /><Wrench v-else :size="12" />{{ p.kind === "skill" ? "技能" : "MCP" }} · {{ p.name }}</span>
                  </div>
                  <div v-if="parseGoal(turn.ask).files.length" class="chat-files" data-chat-bubble-files>
                    <button v-for="f in parseGoal(turn.ask).files" :key="f.path" type="button" class="chat-file" data-chat-bubble-file :title="f.path" @click="openWorkspace(f.path, f.name)">
                      <span class="chat-file-ic"><img v-if="f.kind === 'image' && thumbOf(f.path)" :src="thumbOf(f.path)" alt="" /><ImageIcon v-else-if="f.kind === 'image'" :size="15" /><Film v-else-if="f.kind === 'video' || f.kind === 'audio'" :size="15" /><FileText v-else :size="15" /></span>
                      <span class="chat-file-meta"><span class="chat-file-name">{{ f.name }}</span><span class="chat-file-sub">{{ (f.ref ? "引用 · " : "") + (f.size ? sizeText(f.size) : f.path) }}</span></span>
                    </button>
                  </div>
                  <div v-if="parseGoal(turn.ask).text" class="chat-bubble">{{ parseGoal(turn.ask).text }}</div>
                  <div class="chat-meta">
                    <time class="chat-time" data-chat-time>{{ msgTime(turn.askAt) }}</time>
                    <span class="toolbar-spacer" />
                    <button type="button" class="chat-act" data-chat-edit title="编辑后重新发送" aria-label="编辑重发" @click="editTurn(turn)"><Pencil :size="13" /></button>
                    <button type="button" class="chat-act" data-chat-copy :data-copied="copiedKey === 'u:' + turn.key ? '1' : null" title="复制这条消息" aria-label="复制" @click="copyText(parseGoal(turn.ask).text, 'u:' + turn.key)">
                      <Check v-if="copiedKey === 'u:' + turn.key" :size="13" /><Copy v-else :size="13" />
                    </button>
                  </div>
                </div>
                <div class="chat-msg chat-msg-ai" data-role="assistant" data-chat-message="assistant" :class="{ pending: turn.pending, failed: turn.failed }">
                  <span class="chat-orb" aria-hidden="true" />
                  <div class="chat-bubble">
                    <!-- 思考过程：运行中实时显示，结束后折叠成「已思考 Xs」（不落库，本次运行期间可看） -->
                    <section v-if="thoughtOf(turn)" class="chat-think" :class="{ live: thoughtOf(turn)!.live }" data-chat-think>
                      <button type="button" class="chat-think-head" :aria-expanded="thoughtOpen(turn)" data-chat-think-toggle @click="toggleThought(turn.key)">
                        <Brain :size="13" /><span class="chat-think-label">{{ thoughtOf(turn)!.live ? "思考中…" : "已思考" + (thoughtOf(turn)!.ms >= 1000 ? " " + durText(thoughtOf(turn)!.ms) : "") }}</span>
                        <ChevronRight :size="14" class="chat-chev" :class="{ open: thoughtOpen(turn) }" />
                      </button>
                      <div v-if="thoughtOpen(turn)" class="chat-think-body" data-chat-think-body>{{ thoughtOf(turn)!.text }}</div>
                    </section>
                    <!-- 计划卡片：助手用 todo_write 列出的步骤，运行中实时更新 -->
                    <section v-if="turn.plan.length" class="chat-plan" data-chat-plan>
                      <header class="chat-plan-head"><ListChecks :size="14" /><span>计划</span><small data-chat-plan-progress>{{ planDone(turn.plan) }} / {{ turn.plan.length }}</small></header>
                      <ol class="chat-plan-items">
                        <li v-for="(it, i) in turn.plan" :key="i" :data-chat-plan-item="it.status" :class="it.status">
                          <Check v-if="it.status === 'completed'" :size="13" class="chat-plan-ic" />
                          <CircleDot v-else-if="it.status === 'in_progress'" :size="13" class="chat-plan-ic" />
                          <Circle v-else :size="13" class="chat-plan-ic" />
                          <span>{{ it.content }}</span>
                        </li>
                      </ol>
                    </section>
                    <!-- 联网过程（参照 Codex / ChatGPT）：搜索词、结果、读过的网页；运行中实时更新 -->
                    <WebActivity v-if="turn.web.length" :acts="turn.web" :live="!!liveFor(turn)" @open="onWebOpen" />
                    <!-- 中间过程组：一行摘要句 + 耗时 + chevron；展开是左侧竖线 + 缩进明细（13px） -->
                    <div v-if="turn.tools.length && !onlyWeb(turn)" class="chat-working" data-chat-tools :data-open="openTurns.has(turn.key) ? '1' : '0'">
                      <button type="button" class="chat-working-head" :aria-expanded="openTurns.has(turn.key)" @click="toggleTurn(turn.key)">
                        <ListChecks :size="14" class="chat-work-led" />
                        <span class="chat-work-summary" data-chat-summary>{{ turn.summary }}</span>
                        <span v-if="turn.dur" class="chat-work-dur" data-chat-duration>{{ turn.dur }}</span>
                        <ChevronRight :size="16" class="chat-chev" :class="{ open: openTurns.has(turn.key) }" />
                      </button>
                      <Transition name="chatwork">
                      <ol v-if="openTurns.has(turn.key)" class="chat-work-rows" data-chat-work-rows>
                        <li v-for="row in turn.rows" :key="row.key" :class="{ thinking: row.kind === 'thinking', failed: row.failed }" :data-chat-row="row.kind" :data-chat-row-status="row.suffix">
                          <component :is="ROW_ICON[row.icon] || Wrench" :size="13" class="chat-work-ic" />
                          <span class="chat-work-text">{{ row.text }}</span>
                          <small v-if="row.suffix" class="chat-work-status" :class="{ 'is-failed': row.failed }" :title="row.raw || row.suffix">{{ row.suffix }}</small>
                        </li>
                      </ol>
                      </Transition>
                    </div>
                    <template v-if="turn.pending">
                      <p v-if="liveFor(turn)?.tool && !(turn.web.length && /^web_(search|fetch)$/i.test(liveFor(turn)!.tool))" class="chat-live-tool" data-chat-live-tool><Wrench :size="12" /> 正在{{ toolLabel(liveFor(turn)!.tool) }}…</p>
                      <div v-if="liveFor(turn)?.text" class="chat-md chat-md-live" data-chat-live-text v-html="markdown(liveFor(turn)!.text)" />
                      <span v-else class="chat-typing"><i /><i /><i /><span class="chat-caret" /></span>
                    </template>
                    <div v-else class="chat-md" data-chat-markdown v-html="turn.web.length ? citeLinks(markdown(turn.answer)) : markdown(turn.answer)" />
                    <WebSources v-if="!turn.pending && turn.web.length && sourcesOf(turn.web, turn.answer).length" :sources="sourcesOf(turn.web, turn.answer)" @open="onWebOpen" />
                    <div v-if="!turn.pending && turn.nodes.length" class="chat-chips" data-chat-nodes>
                      <button v-for="n in turn.nodes" :key="n.id" type="button" class="chat-nodechip" :data-chat-node="n.id" :title="'在画布中定位：' + n.title" @click="focusNode(n)"><Layers :size="12" /><span>{{ n.title }}</span></button>
                    </div>
                    <template v-if="!turn.pending && turn.media.length">
                      <figure v-for="m in turn.media" :key="m.url" class="chat-media" data-chat-media :data-chat-media-kind="m.kind" :data-chat-media-src="m.url">
                        <video v-if="m.kind === 'video' && srcOf(m)" :src="srcOf(m)" controls playsinline preload="metadata" />
                        <button v-else type="button" class="chat-media-thumb" :aria-label="'预览 ' + m.name" @click="openMedia(m)">
                          <img v-if="srcOf(m)" :src="srcOf(m)" :alt="m.name" loading="lazy" />
                          <span v-else class="chat-media-wait"><Play v-if="m.kind === 'video'" :size="18" /><ImageIcon v-else :size="18" /></span>
                        </button>
                        <figcaption>
                          <span class="chat-media-name">{{ m.name }}</span>
                          <button type="button" class="chat-media-open" data-chat-media-preview @click="openMedia(m)">预览</button>
                          <button v-if="m.nodeId" type="button" class="chat-media-open" data-chat-media-canvas @click="focusNode({ id: m.nodeId, title: m.name })">在画布中</button>
                        </figcaption>
                      </figure>
                    </template>
                    <div class="chat-meta" data-chat-meta-ai>
                      <time class="chat-time" data-chat-time>{{ msgTime(turn.answerAt || turn.askAt) }}</time>
                      <span class="toolbar-spacer" />
                      <button type="button" class="chat-act" data-chat-copy :data-copied="copiedKey === 'a:' + turn.key ? '1' : null" :data-copied-text="copiedKey === 'a:' + turn.key ? copiedText : null" title="复制这条回答" aria-label="复制" @click="copyText(turn.answer, 'a:' + turn.key)">
                        <Check v-if="copiedKey === 'a:' + turn.key" :size="13" /><Copy v-else :size="13" />
                      </button>
                      <button type="button" class="chat-act" data-chat-retry title="重试：把这句话再发一次" aria-label="重试" @click="retryTurn(turn)"><RotateCcw :size="13" /></button>
                    </div>
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
            <p v-if="toastMsg" class="chat-toast" role="status" data-chat-toast>{{ toastMsg }}</p>
            <p v-if="lastSent" class="chat-hint" data-chat-last-sent>{{ lastSent }}</p>
            <p v-if="error" class="chat-error" role="alert" data-chat-error>{{ error }}</p>
            <p v-else-if="detail && !detail.appendable && terminal(detail.task.status) && detail.appendReason" class="chat-hint" data-chat-append-hint>这段对话已结束，不能继续追加；可以新建一段对话。</p>
            <Composer
              ref="composer" v-model="draft" v-model:selected-model-id="selectedModelId" :disabled="!taskBridge || sending" :running="running(detail?.task.status)"
              :placeholder="composerPlaceholder" :models="models" :locked-model-id="lockedModelId" :usage="ctxUsage" :model-calls="detail?.calls.length || 0"
              :voice="voice" @send="send" @stop="stop" @command="onComposerCommand" @voice="toggleVoice"
            />
          </div>
        </div>

        <!-- 右侧预览侧栏：网页 / 文件 / 代码 / 媒体（点消息里的链接、文件、代码块「预览」打开） -->
        <PreviewPanel v-if="preview.open && preview.items.length" />
      </div>
      <ResourcePicker v-if="resourcePickerOpen" picker-app-id="chat" :requested-actions="['resource.view']" title="引用资源" @choose="attachResource" @cancel="resourcePickerOpen = false" />
    </div>
  </div>
</template>

<style scoped>
.chat-side { width: 260px; }
.chat-plan { margin: 0 0 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.02); }
.chat-plan-head { display: flex; align-items: center; gap: 6px; font-size: var(--fs-caption); color: var(--muted); margin-bottom: 4px; }
.chat-plan-head span { font-weight: var(--fw-medium); color: var(--text); }
.chat-plan-head small { margin-left: auto; font-variant-numeric: tabular-nums; }
.chat-plan-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: var(--fs-secondary); }
.chat-plan-items li { display: flex; align-items: flex-start; gap: 6px; line-height: 1.45; }
.chat-plan-ic { flex: none; margin-top: 3px; color: var(--muted); }
.chat-plan-items li.completed { color: var(--muted); }
.chat-plan-items li.completed span { text-decoration: line-through; text-decoration-color: rgb(var(--text-rgb) / 0.3); }
.chat-plan-items li.completed .chat-plan-ic { color: var(--success, #2f9e5b); }
.chat-plan-items li.in_progress { font-weight: var(--fw-medium); }
.chat-plan-items li.in_progress .chat-plan-ic { color: var(--accent); }
.chat-live-tool { display: flex; align-items: center; gap: 5px; margin: 0 0 4px; font-size: var(--fs-caption); color: var(--muted); }
.chat-md-live { opacity: 0.92; }
.chat-side-top { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.chat-nav { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; margin-bottom: 1px; border-radius: var(--radius-md); color: var(--text); font-size: var(--fs-secondary); text-align: left; }
.chat-nav:hover { background: rgb(var(--text-rgb) / 0.05); }
.chat-nav[aria-current="page"] { background: rgb(var(--sidebar-selected-rgb, 224 224 224)); font-weight: var(--fw-medium); }
.chat-nav[data-chat-nav-apps] { margin-bottom: 8px; }
.chat-nav span { flex: 1; }
.chat-nav small { min-width: 18px; padding: 0 5px; border-radius: 9px; background: rgb(var(--text-rgb) / 0.08); color: var(--muted); font-size: var(--fs-micro, 11px); text-align: center; }
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

/* 消息正文的 Markdown 样式在 chat/chat-rich.css */

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
/* 切到「自动化」时对话区只是藏起来（输入中的草稿、滚动位置都保留） */
.chat-app .chat-main.chat-main-hidden { display: none !important; }
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

/* task-8 final overrides */
.chat-app .chat-side { margin: 8px 0 8px 8px !important; }
.chat-app .chat-scroll { padding: 16px 20px 8px; }
.chat-app .chat-thread { max-width: none; }

.chat-app .pane-toolbar { padding-right: 12px; }
.chat-dock { padding-bottom: 15px; }
.chat-app .chat-scroll { padding: 16px 20px 8px; }

.chat-msg[data-role="user"] { width: 100%; }
.chat-app .pane-toolbar { padding-right: 7px; }
.chat-dock { padding-bottom: 10px; }

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

.chat-app .chat-msg[data-role="user"] .chat-bubble { width: 414px; flex: 0 0 414px; max-width: 414px; }

.chat-msg[data-role="user"] .chat-bubble { margin-right: 4px !important; }

.chat-dock { padding-bottom: 2px; }
/* 输入框外观统一在 chat/chat-rich.css（.cmp）；这里只留底部呼吸空间 */
.chat-app .chat-dock { padding-bottom: 16px; }

/* ---------- task-17 对话卡片 ---------- */
.chat-meta { display: flex; align-items: center; gap: 4px; margin-top: 6px; min-height: 24px; }
.chat-msg[data-role="user"] .chat-meta { justify-content: flex-end; }
/* 时间戳默认不占位（w=0 + opacity=0），悬停消息或键盘 focus 时展开（TapNow 实测：data-message-time） */
.chat-time { display: inline-block; width: 0; height: 24px; line-height: 24px; overflow: hidden; white-space: nowrap; opacity: 0; font-size: 12px; color: rgb(var(--text-rgb) / 0.8); font-variant-numeric: tabular-nums; transition: opacity var(--quick) ease; }
.chat-msg:hover .chat-time, .chat-msg:focus-within .chat-time { width: auto; opacity: 1; }
.chat-act { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-md); color: var(--muted); }
.chat-act:hover { background: rgb(var(--text-rgb) / 0.08); color: var(--text); }
.chat-act[data-copied="1"] { color: var(--text); }
.chat-working { margin: 2px 0 6px; }
.chat-working-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 2px 0; text-align: left; color: var(--muted); font-size: 13px; line-height: 1.65; }
.chat-working-head:hover { color: var(--text); }
.chat-work-led { flex: none; width: 16px; height: 16px; opacity: 0.6; }
.chat-work-summary { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 1.65; }
.chat-work-dur { flex: none; font-size: 13px; color: rgb(var(--text-rgb) / 0.5); font-variant-numeric: tabular-nums; }
.chat-working-head .chat-chev { flex: none; width: 16px; height: 16px; opacity: 0.6; transition: transform 150ms cubic-bezier(0.33, 1, 0.68, 1); }
.chat-working-head:hover .chat-chev { opacity: 1; }
.chat-working-head .chat-chev.open { transform: rotate(90deg); }
.chat-work-rows { margin: 2px 0 0 8px; padding: 2px 0 2px 14px; border-left: 1px solid rgb(var(--text-rgb) / 0.1); display: flex; flex-direction: column; }
.chat-work-rows li { display: flex; align-items: center; gap: 6px; min-height: 25px; font-size: 13px; line-height: 1.65; color: rgb(var(--text-rgb) / 0.62); }
.chat-work-ic { flex: none; opacity: 0.55; }
.chat-work-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-work-status { flex: none; font-size: 12px; color: rgb(var(--text-rgb) / 0.42); }
.chat-work-rows li.failed .chat-work-status { color: var(--warning-text, #a05a00); }
.chat-work-rows li.thinking { font-style: italic; opacity: 0.62; }
.chat-work-rows li.thinking .chat-work-ic { opacity: 0.45; }
.chat-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
/* 结果节点 chip 按 TapNow 实测：h20 / r4 / 13px / 14 图标 / max-w 120 / 内描边 hover */
.chat-nodechip { display: inline-flex; align-items: center; gap: 4px; height: 20px; min-width: 24px; max-width: 120px; padding: 0 4px; border-radius: 4px; background: rgb(var(--text-rgb) / 0.07); box-shadow: inset 0 0 0 1px rgb(var(--text-rgb) / 0.1); color: rgb(var(--text-rgb) / 0.6); font-size: 13px; }
.dark .chat-nodechip { background: rgb(40, 40, 40); box-shadow: none; color: rgba(255, 255, 255, 0.6); }
.chat-nodechip:hover { color: rgb(var(--text-rgb) / 0.8); filter: brightness(1.1); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08); }
.chat-nodechip svg { flex: none; width: 14px; height: 14px; opacity: 0.75; }
.chat-nodechip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-media { margin: 8px 0 0; max-width: 100%; border: 1px solid rgb(var(--text-rgb) / 0.08); border-radius: var(--radius-lg); overflow: hidden; background: rgb(var(--text-rgb) / 0.03); }
.chat-media-thumb { display: block; width: 100%; padding: 0; }
.chat-media-thumb img { display: block; width: 100%; max-height: 180px; object-fit: contain; background: #000; }
.chat-media figcaption { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: var(--fs-caption); }
.chat-media-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.chat-media-open { flex: none; height: 24px; padding: 0 10px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.08); color: var(--text); font-size: var(--fs-caption); }
.chat-media-open:hover { background: rgb(var(--text-rgb) / 0.14); }
.chat-suggest { display: flex; flex-direction: column; gap: 8px; width: 100%; margin-top: 14px; }
.chat-suggest-card { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 12px 12px 12px 14px; text-align: left; border: 1px solid rgb(var(--text-rgb) / 0.08); border-radius: var(--radius-xl); background: rgb(var(--text-rgb) / 0.03); transition: transform var(--quick) ease, border-color var(--quick) ease, background-color var(--quick) ease; }
.chat-suggest-card:hover { transform: translateY(-1px); border-color: rgb(var(--text-rgb) / 0.18); background: rgb(var(--text-rgb) / 0.06); }
.chat-suggest-ic { flex: none; margin-top: 1px; color: var(--muted); }
.chat-suggest-card:hover .chat-suggest-ic { color: var(--text); }
.chat-suggest-body { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
.chat-suggest-body strong { font-size: var(--fs-secondary); font-weight: var(--fw-medium); color: var(--text); }
.chat-suggest-body small { font-size: var(--fs-caption); color: var(--muted); line-height: var(--lh-normal); }
.chat-suggest-arrow { flex: none; margin-top: 2px; color: var(--muted); opacity: 0.5; }
.chat-suggest-card:hover .chat-suggest-arrow { opacity: 0.9; }
.chat-toast { margin: 0 0 4px; font-size: var(--fs-caption); color: var(--muted); }
.chat-media-wait { display: grid; place-items: center; height: 120px; color: var(--muted); }
.chat-lightbox { position: fixed; inset: 0; z-index: 90; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; background: rgba(0, 0, 0, 0.84); }
.chat-lightbox img { max-width: calc(100vw - 48px); max-height: calc(100vh - 140px); object-fit: contain; border-radius: var(--radius-lg); }
.chat-lightbox-bar { display: flex; align-items: center; gap: 12px; font-size: var(--fs-caption); color: rgba(255, 255, 255, 0.8); }
.chat-lightbox-close { height: 26px; padding: 0 12px; border-radius: var(--radius-pill); background: rgba(255, 255, 255, 0.14); color: #fff; font-size: var(--fs-caption); }
/* 展开/收起：150ms cubic-bezier(.33,1,.68,1)（TapNow 实测值） */
.chatwork-enter-active, .chatwork-leave-active { transition: opacity 150ms cubic-bezier(0.33, 1, 0.68, 1), transform 150ms cubic-bezier(0.33, 1, 0.68, 1); }
.chatwork-enter-from, .chatwork-leave-to { opacity: 0; transform: translateY(-2px); }
@media (prefers-reduced-motion: reduce) {
  .chat-suggest-card { transition: none; }
  .chat-suggest-card:hover { transform: none; }
  .chatwork-enter-active, .chatwork-leave-active { transition: none; }
  .chat-work-rows { animation: none !important; }
  .chat-time { transition: none; }
}
</style>
