<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import DsButton from "../design-system/DsButton.vue";
import ResourcePicker from "./ResourcePicker.vue";
import { Bot, Folder, Plus } from "lucide-vue-next";
import { iconUrl } from "../apps";
import {
  AGENT_MODES, agentBridge, agentCommand, agentErrorText, eventLabel, eventTime, formatAgentTime,
  isLiveTask, prettyDetail, taskStatusText, type AssistantMode,
} from "../agent/agentClient";

/**
 * D3-04D · Projects（资源项目逐段迁移）。task-35 增加项目 Agent 会话：
 * 资源项目仍走 resource 桥；Agent 项目走 agent 桥，两套项目根分开展示，不互相冒充。
 * thinking/agent 创建真实 dx task；assistant 同步跑项目 Agent；任务/事件/检查点/续跑/回答全部取真实后端。
 */
type ResBridge = { command: (c: Record<string, unknown>) => Promise<any> };

const bridge = (): ResBridge | undefined => (window as any).openarc?.resource;
const agent = agentBridge();

const projects = ref<any[]>([]);
const projectId = ref<string | null>(null);
const resources = ref<any[]>([]);
const name = ref("");
const picking = ref(false);
const error = ref<string | null>(null);
const view = ref<"resources" | "agent">("resources");

const agentProjects = ref<any[]>([]);
const agentProjectId = ref<string | null>(null);
const newAgentName = ref("");
const agentTasks = ref<any[]>([]);
const selectedTaskId = ref<string | null>(null);
const taskDetail = ref<any>(null);
const taskEvents = ref<any[]>([]);
const taskRun = ref<any>(null);
const runError = ref("");
const taskBusy = ref(false);
const agentError = ref("");
const mode = ref<AssistantMode>("thinking");
const instruction = ref("");
const answer = ref("");
const followUp = ref("");
const outcome = ref<any>(null);
const rootProbe = ref<{ ok: boolean; message: string } | null>(null);
const agentLoading = ref(false);
let poll = 0;

const current = computed(() => projects.value.find((p) => p.id === projectId.value) ?? null);
const agentProject = computed(() => agentProjects.value.find((p) => p.id === agentProjectId.value) ?? null);
const modeInfo = computed(() => AGENT_MODES.find((m) => m.id === mode.value) ?? AGENT_MODES[1]);
const task = computed(() => taskDetail.value?.task ?? null);
const taskStatus = computed(() => String(task.value?.status || ""));
const waitingQuestion = computed(() => {
  for (let i = taskEvents.value.length - 1; i >= 0; i -= 1) {
    if (taskEvents.value[i]?.type === "task.waiting_user") return String(taskEvents.value[i].message || "").trim();
  }
  return "";
});
const canPause = computed(() => ["queued", "planning", "running", "verifying"].includes(taskStatus.value));
const canResume = computed(() => ["paused", "interrupted", "failed"].includes(taskStatus.value));
const canCancel = computed(() => !!task.value && !["completed", "cancelled"].includes(taskStatus.value));
const runRecovery = computed(() => taskRun.value?.recovery ?? null);
const bridgeReady = !!bridge();
const ERR: Record<string, string> = { NO_BRIDGE: "项目服务只在 OpenArc 桌面应用里可用。", INTERNAL_ERROR: "项目服务暂时不可用。", FORBIDDEN: "没有权限执行这个操作。" };
const errText = (e: string) => ERR[e] ?? `操作被拒绝（${e}）`;

async function cmd(payload: Record<string, unknown>): Promise<any> {
  const b = bridge();
  if (!b) return { ok: false, error: "NO_BRIDGE" };
  try { return await b.command(payload); } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
}
async function loadProjects() {
  const res = await cmd({ type: "resource/listProjects" });
  if (res.ok) projects.value = Array.isArray(res.items) ? res.items : [];
  else error.value = res.error;
}
async function loadResources(id: string) {
  const res = await cmd({ type: "resource/listProjectResources", projectId: id });
  if (res.ok) resources.value = Array.isArray(res.items) ? res.items : [];
  else error.value = res.error;
}
async function loadAgentProjects() {
  if (!agent) return;
  const res = await agentCommand("agent/project/list", {}, agent);
  if (!res.ok) { agentError.value = agentErrorText(res.error, res.message); return; }
  agentProjects.value = Array.isArray(res.value?.items) ? res.value.items : [];
  if (!agentProjectId.value && agentProjects.value.length) await selectAgentProject(agentProjects.value[0].id);
}
async function probeRoot() {
  rootProbe.value = null;
  if (!agent || !agentProject.value) return;
  const rootNodeId = String(agentProject.value.root_node_id || "");
  if (!rootNodeId) {
    rootProbe.value = { ok: false, message: "后端项目没有 dx_project_roots.root_node_id；项目 Agent 文件工具没有根。" };
    return;
  }
  const res = await agentCommand("agent/tool/call", { tool: "fs_list", rootNodeId, arguments: {} }, agent);
  rootProbe.value = res.ok
    ? { ok: true, message: "文件根可读（fs_list 已返回真实目录）" }
    : { ok: false, message: agentErrorText(res.error, res.message) };
}
async function selectAgentProject(id: string) {
  agentProjectId.value = id;
  view.value = "agent";
  selectedTaskId.value = null;
  taskDetail.value = null;
  taskEvents.value = [];
  taskRun.value = null;
  runError.value = "";
  outcome.value = null;
  agentError.value = "";
  answer.value = "";
  followUp.value = "";
  await Promise.all([loadAgentTasks(), probeRoot()]);
}
async function loadAgentTasks() {
  if (!agent || !agentProjectId.value) return;
  const res = await agentCommand("agent/task/list", { projectId: agentProjectId.value }, agent);
  if (!res.ok) { agentError.value = agentErrorText(res.error, res.message); return; }
  agentTasks.value = Array.isArray(res.value?.items) ? res.value.items : [];
  if (!selectedTaskId.value && agentTasks.value.length) await selectTask(agentTasks.value[0].taskId);
}
async function selectTask(id: string) {
  selectedTaskId.value = id;
  outcome.value = null;
  await refreshTask();
}
async function refreshTask() {
  if (!agent || !selectedTaskId.value) return;
  taskBusy.value = true;
  try {
    const [detail, events] = await Promise.all([
      agentCommand("agent/task/get", { taskId: selectedTaskId.value }, agent),
      agentCommand("agent/task/events", { taskId: selectedTaskId.value, afterSequence: 0 }, agent),
    ]);
    if (!detail.ok) { agentError.value = agentErrorText(detail.error, detail.message); return; }
    taskDetail.value = detail.value;
    taskEvents.value = events.ok && Array.isArray(events.value?.items) ? events.value.items : [];
    const runId = detail.value?.task?.agentRunId;
    if (runId) {
      const inspected = await agentCommand("agent/run/inspect", { runId }, agent);
      if (inspected.ok) { taskRun.value = inspected.value?.inspection ?? null; runError.value = ""; }
      else { taskRun.value = null; runError.value = agentErrorText(inspected.error, inspected.message); }
    } else { taskRun.value = null; runError.value = ""; }
  } finally { taskBusy.value = false; }
}
async function sendAgent() {
  const text = instruction.value.trim();
  if (!agent || !agentProject.value || !text || agentLoading.value) return;
  agentError.value = "";
  outcome.value = null;
  agentLoading.value = true;
  try {
    if (mode.value === "assistant") {
      const res = await agentCommand("agent/project/run", { projectId: agentProject.value.id, instruction: text }, agent);
      if (res.ok) { outcome.value = res.value?.outcome ?? res.value; instruction.value = ""; }
      else agentError.value = agentErrorText(res.error, res.message);
      return;
    }
    const res = await agentCommand("agent/task/create", {
      projectId: agentProject.value.id, instruction: text,
      executionProfile: modeInfo.value.executionProfile, title: text.slice(0, 60),
    }, agent);
    if (!res.ok) { agentError.value = agentErrorText(res.error, res.message); return; }
    instruction.value = "";
    selectedTaskId.value = res.value?.task?.taskId ?? null;
    await loadAgentTasks();
    if (selectedTaskId.value) await refreshTask();
  } finally { agentLoading.value = false; }
}
async function act(command: string, payload: Record<string, unknown>) {
  if (!agent || !selectedTaskId.value) return;
  agentError.value = "";
  const res = await agentCommand(command, { taskId: selectedTaskId.value, ...payload }, agent);
  if (!res.ok) { agentError.value = agentErrorText(res.error, res.message); return; }
  if (command === "agent/task/answer") answer.value = "";
  if (command === "agent/task/continue") followUp.value = "";
  await refreshTask();
  await loadAgentTasks();
}
const answerTask = () => act("agent/task/answer", { answer: answer.value.trim() });
const continueTask = () => act("agent/task/continue", { message: followUp.value.trim() });
const pauseTask = () => act("agent/task/pause", {});
const resumeTask = () => act("agent/task/resume", {});
const cancelTask = () => act("agent/task/cancel", {});
async function createAgentProject() {
  const projectName = newAgentName.value.trim();
  if (!agent || !projectName) return;
  agentError.value = "";
  const rootNodeId = "oa-agent-" + projectName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, "-").slice(0, 40) + "-" + Date.now().toString(36);
  const res = await agentCommand("agent/project/create", { name: projectName, rootNodeId }, agent);
  if (!res.ok) { agentError.value = agentErrorText(res.error, res.message); return; }
  newAgentName.value = "";
  await loadAgentProjects();
  if (res.value?.project?.id) await selectAgentProject(res.value.project.id);
}
function setMode(next: AssistantMode) { mode.value = next; agentError.value = ""; outcome.value = null; }
function showAgentView() {
  view.value = "agent";
  if (!agentProjectId.value && agentProjects.value.length) void selectAgentProject(agentProjects.value[0].id);
}
function eventSummary(row: any): string {
  const label = eventLabel(row?.type);
  const message = String(row?.message || "").trim();
  return message ? label + " · " + message : label;
}
const stepIcon = (s: string) => (s === "completed" ? "✓" : s === "failed" ? "!" : "·");
const stepText = (s: string) => ({ queued: "排队", running: "执行中", completed: "完成", failed: "失败", cancelled: "取消" } as Record<string, string>)[s] || s;

onMounted(() => {
  void loadProjects();
  void loadAgentProjects();
  poll = window.setInterval(() => {
    if (agentProjectId.value && task.value && isLiveTask(taskStatus.value)) void refreshTask();
  }, 1800);
});
onBeforeUnmount(() => window.clearInterval(poll));

async function create() {
  const res = await cmd({ type: "resource/createProject", name: name.value || "未命名项目" });
  if (res.ok) { name.value = ""; await loadProjects(); projectId.value = res.project.id; await loadResources(res.project.id); }
  else error.value = res.error;
}
async function selectProject(id: string) { projectId.value = id; view.value = "resources"; void loadResources(id); }
async function addResource(ref: string) {
  picking.value = false;
  if (!projectId.value) return;
  const res = await cmd({ type: "resource/addProjectResource", projectId: projectId.value, resourceRef: ref });
  if (res.ok) await loadResources(projectId.value);
  else error.value = res.error;
}
</script>

<template>
  <div class="split projects-app">
    <nav class="split-side" aria-label="项目">
      <div class="split-section">Agent 项目</div>
      <div class="projects" data-agent-projects>
        <p v-if="!agent" class="agent-side-empty" data-agent-bridge-missing>Agent 桥不可用：只能在桌面应用内使用。</p>
        <p v-else-if="!agentProjects.length" class="agent-side-empty" data-agent-projects-empty>还没有 Agent 项目。先在下方创建，后端会返回真实 project id 与根状态。</p>
        <ul v-else class="pj-list">
          <li v-for="p in agentProjects" :key="p.id">
            <button type="button" class="split-nav agent-side-item" :data-agent-project="p.id" :aria-current="agentProjectId === p.id ? 'true' : undefined" @click="selectAgentProject(p.id)">
              <Bot :size="16" />
              <span class="split-nav-label">{{ p.name }}</span>
              <span class="agent-root-mark" :data-agent-root="p.root_node_id ? 'set' : 'missing'" :title="p.root_node_id ? '后端有项目根' : '后端没有 dx 项目根'" />
            </button>
          </li>
        </ul>
        <form v-if="agent" class="pj-new" @submit.prevent="createAgentProject">
          <Plus :size="15" />
          <input v-model="newAgentName" data-agent-project-name placeholder="新建 Agent 项目" aria-label="新 Agent 项目名称" />
          <button type="submit" class="pj-new-btn" data-agent-project-new :disabled="!newAgentName.trim()" :data-empty="!newAgentName.trim()">新建</button>
        </form>
      </div>

      <div class="split-section">资源项目</div>
      <div class="projects" data-d3-04d="projects">
        <ul class="pj-list" data-d3-04d-projects>
          <li v-for="p in projects" :key="p.id">
            <button type="button" class="split-nav" :data-d3-04d-project="p.id" :aria-pressed="projectId === p.id" :aria-current="projectId === p.id ? 'true' : undefined" @click="selectProject(p.id)">
              <Folder :size="16" /> <span class="split-nav-label">{{ p.name }}</span>
            </button>
          </li>
        </ul>
        <form class="pj-new" @submit.prevent="create">
          <Plus :size="15" />
          <input v-model="name" data-d3-04d-project-name placeholder="新建资源项目" aria-label="新项目名称" />
          <button type="submit" class="pj-new-btn" data-d3-04d-project-new :disabled="!bridgeReady" :data-empty="!name.trim()">新建</button>
        </form>
      </div>
    </nav>

    <div class="split-main pj-main agent-main">
      <div class="pane-toolbar">
        <strong class="pane-title">{{ view === "agent" ? (agentProject ? agentProject.name : "Agent 会话") : (current ? current.name : "项目") }}</strong>
        <span v-if="view === 'resources' && current" class="badge">{{ resources.length }} 个资源</span>
        <span v-if="view === 'agent' && agentProject" class="badge" :data-project-agent-root-badge="rootProbe ? (rootProbe.ok ? 'ok' : 'missing') : 'unknown'">{{ rootProbe ? (rootProbe.ok ? "文件根可读" : "文件根不可用") : "根状态未知" }}</span>
        <div class="toolbar-spacer" />
        <div class="segmented text" role="group" aria-label="项目视图">
          <button type="button" :aria-pressed="view === 'resources'" data-project-view="resources" @click="view = 'resources'">资源</button>
          <button type="button" :aria-pressed="view === 'agent'" data-project-view="agent" @click="showAgentView">Agent 会话</button>
        </div>
        <DsButton v-if="view === 'resources' && projectId" variant="primary" size="sm" data-d3-04d-project-add @click="picking = true"><Plus :size="13" /> 引用资源</DsButton>
      </div>

      <p v-if="error && view === 'resources'" class="gov-error" role="alert" data-d3-04d-project-error>{{ errText(error) }}</p>

      <section v-if="view === 'resources'" class="agent-scroll">
        <template v-if="projectId" :data-d3-04d-project-active="projectId">
          <p v-if="!resources.length" class="set-cap">还没有引用任何资源。用「引用资源」从资源库里挑选，项目只保存引用，访问权逐个重新校验。</p>
          <div v-else class="pj-table" data-d3-04d-project-resources>
            <div class="pj-tr pj-th"><span>资源</span><span>访问</span></div>
            <div v-for="r in resources" :key="r.resourceId" class="pj-tr" :data-d3-04d-project-resource="r.resourceId" :data-d3-04d-project-resource-authorized="r.authorized ? 'true' : 'false'">
              <span class="gov-name">{{ r.authorized ? r.resource.name : r.resourceRef }}</span>
              <span class="badge" :class="{ ok: r.authorized }">{{ r.authorized ? "可访问" : "无访问权限" }}</span>
            </div>
          </div>
        </template>
        <div v-else class="empty-content">
          <img class="large-icon" :src="iconUrl('folder')" alt="" draggable="false" />
          <h2 class="planned-title">{{ projects.length ? "选择一个项目" : "还没有项目" }}</h2>
          <p>项目把相关的资源引用放在一起，成员按各自的权限访问。在左侧新建或选择一个项目。</p>
        </div>
      </section>

      <section v-else class="agent-panel" data-project-agent-panel>
        <div v-if="!agentProject" class="empty-content">
          <Bot :size="42" class="agent-empty-icon" />
          <h2 class="planned-title">选择一个 Agent 项目</h2>
          <p>Agent 会话按后端 agent/project/list 的真实项目隔离；资源项目不会在这里冒充 Agent 项目。</p>
        </div>
        <template v-else>
          <div class="agent-head">
            <div class="agent-head-text">
              <strong>{{ agentProject.name }}</strong>
              <p class="agent-sub">
                <span data-project-agent-project-id>{{ agentProject.id }}</span>
                <span v-if="agentProject.root_node_id" class="agent-root-id" :title="agentProject.root_node_id">根 {{ agentProject.root_node_id }}</span>
                <span v-else class="agent-root-missing">没有 dx 项目根</span>
              </p>
            </div>
            <div class="segmented text" role="group" aria-label="Agent 模式" data-project-agent-modes>
              <button v-for="m in AGENT_MODES" :key="m.id" type="button" :aria-pressed="mode === m.id" :data-project-agent-mode="m.id" @click="setMode(m.id)">{{ m.label }}</button>
            </div>
          </div>
          <p class="agent-mode-hint" data-project-agent-mode-hint>{{ modeInfo.hint }}</p>
          <p v-if="rootProbe && !rootProbe.ok" class="agent-root-warn" data-project-agent-root-warn>{{ rootProbe.message }}</p>

          <div class="agent-thread">
            <aside class="agent-tasks" aria-label="项目任务" data-project-agent-tasks>
              <div class="agent-tasks-head">任务 <span>{{ agentTasks.length }}</span></div>
              <p v-if="!agentTasks.length" class="agent-tasks-empty">还没有任务。</p>
              <button v-for="t in agentTasks" :key="t.taskId" type="button" class="agent-task-row" :class="{ active: selectedTaskId === t.taskId }" :data-project-agent-task-item="t.taskId" :aria-current="selectedTaskId === t.taskId ? 'true' : undefined" @click="selectTask(t.taskId)">
                <span class="agent-task-title">{{ t.title || t.instruction }}</span>
                <span class="agent-task-state" :data-project-agent-task-item-status="t.status">{{ taskStatusText(t.status) }}</span>
              </button>
            </aside>

            <div class="agent-conversation">
              <div v-if="task" class="agent-card" :data-project-agent-task="task.taskId">
                <div class="agent-card-head">
                  <strong>{{ task.title || task.instruction }}</strong>
                  <span class="agent-status" :data-project-agent-status="task.status">{{ taskStatusText(task.status) }}</span>
                </div>
                <p class="agent-meta">
                  <span>profile {{ task.executionProfile || "—" }}</span>
                  <span>mode {{ task.mode || "—" }}</span>
                  <span data-project-agent-checkpoints>检查点 {{ taskDetail?.checkpoints ?? 0 }}</span>
                  <span v-if="task.agentRunId">run {{ task.agentRunId }}</span>
                </p>
                <div class="agent-actions">
                  <button v-if="canPause" type="button" data-project-agent-pause @click="pauseTask">暂停</button>
                  <button v-if="canResume" type="button" data-project-agent-resume @click="resumeTask">恢复</button>
                  <button v-if="canCancel" type="button" class="danger" data-project-agent-cancel @click="cancelTask">取消</button>
                  <button type="button" :disabled="taskBusy" data-project-agent-refresh @click="refreshTask">刷新真实状态</button>
                </div>

                <div v-if="task.status === 'waiting_user'" class="agent-approval" data-project-agent-approval>
                  <strong>需要你确认/回答（后端 task.waiting_user）</strong>
                  <p>{{ waitingQuestion || "后端事件里没有返回问题文本；下面是完整事件日志。" }}</p>
                  <textarea v-model="answer" data-project-agent-answer-input placeholder="回答后端的问题后再继续" />
                  <button type="button" :disabled="!answer.trim()" data-project-agent-answer @click="answerTask">回答并继续</button>
                </div>

                <div v-if="!isLiveTask(task.status) && task.mode === 'react'" class="agent-approval" data-project-agent-continue-block>
                  <strong>追加要求（后端 task/continue）</strong>
                  <p>已结束/暂停的任务可追加一条要求并重新入队；固定步骤任务不支持。</p>
                  <textarea v-model="followUp" data-project-agent-continue-input placeholder="追加要求…" />
                  <button type="button" :disabled="!followUp.trim()" data-project-agent-continue @click="continueTask">追加并重新入队</button>
                </div>

                <div v-if="taskDetail?.steps?.length" class="agent-steps">
                  <div class="agent-section-title">步骤</div>
                  <ol>
                    <li v-for="s in taskDetail.steps" :key="s.id" :data-project-agent-step="s.id" :data-s="s.status">
                      <span class="agent-step-mark">{{ stepIcon(s.status) }}</span>
                      <span class="agent-step-title">{{ s.title || s.tool || "步骤" }}</span>
                      <small>{{ stepText(s.status) }}</small>
                    </li>
                  </ol>
                </div>

                <div class="agent-timeline">
                  <div class="agent-section-title">事件 / 检查点</div>
                  <p v-if="!taskEvents.length" class="agent-tasks-empty">没有任务事件。</p>
                  <ul v-else class="agent-events" data-project-agent-events>
                    <li v-for="e in taskEvents" :key="e.id || e.sequence" :data-project-agent-event="e.type">
                      <span class="agent-event-seq">#{{ e.sequence }}</span>
                      <span class="agent-event-text">{{ eventSummary(e) }}</span>
                      <small>{{ eventTime(e) }}</small>
                      <small v-if="e.data && Object.keys(e.data).length" class="agent-event-data">{{ prettyDetail(e.data, 240) }}</small>
                    </li>
                  </ul>
                </div>

                <div v-if="taskRun" class="agent-run" data-project-agent-run>
                  <div class="agent-section-title">Run 检查点 / 恢复信息</div>
                  <p>状态 {{ taskRun.run?.status || "—" }}<span v-if="runRecovery"> · 检查点 #{{ runRecovery.checkpointSequence ?? "—" }} / {{ runRecovery.checkpointPhase || "—" }} · 尝试 {{ runRecovery.attemptNo }}</span></p>
                  <p v-if="runRecovery" class="agent-run-detail">iteration {{ runRecovery.iteration ?? "—" }} · nextToolIndex {{ runRecovery.nextToolIndex ?? "—" }} · 检查点时间 {{ formatAgentTime(runRecovery.checkpointAt) || "—" }}</p>
                  <p v-if="taskRun.nodeActivity" class="agent-run-detail">模型调用 {{ taskRun.nodeActivity.recorded?.modelCalls ?? "—" }} · 工具调用 {{ taskRun.nodeActivity.recorded?.toolCalls ?? "—" }}</p>
                </div>
                <p v-else-if="runError" class="agent-run-error" data-project-agent-run-error>{{ runError }}</p>

                <div v-if="taskDetail?.deliverables?.length" class="agent-deliverables" data-project-agent-deliverables>
                  <div class="agent-section-title">产物</div>
                  <p v-for="d in taskDetail.deliverables" :key="d.id">{{ d.name }} · {{ d.type }}</p>
                </div>
                <div v-if="task.errorMessage" class="agent-error" data-project-agent-task-error>{{ task.errorMessage }}</div>
              </div>

              <div v-else-if="outcome" class="agent-card" data-project-agent-outcome>
                <div class="agent-card-head">
                  <strong>项目 Agent 回复</strong>
                  <span class="agent-status" :data-project-agent-outcome-complete="outcome.complete === true ? 'true' : outcome.complete === false ? 'false' : 'unknown'">{{ outcome.complete === false ? "未通过完成验收" : "已完成" }}</span>
                </div>
                <pre class="agent-result">{{ outcome.text || prettyDetail(outcome) }}</pre>
                <p class="agent-meta"><span v-if="outcome.filesChanged">文件有改动</span><span v-if="Array.isArray(outcome.agentTrace?.toolsUsed)">工具 {{ outcome.agentTrace.toolsUsed.length }} 个</span></p>
                <div v-if="Array.isArray(outcome.agentTrace?.toolsUsed) && outcome.agentTrace.toolsUsed.length" class="agent-trace" data-project-agent-trace>
                  <span v-for="tool in outcome.agentTrace.toolsUsed" :key="tool">{{ tool }}</span>
                </div>
              </div>

              <div v-else class="agent-empty-chat">
                <p>{{ mode === "assistant" ? "助理模式会同步跑一轮项目 Agent，并显示后端的真实回复。" : "发送后创建真实任务；任务由后端队列推进，这里按 task/get 轮询状态。" }}</p>
              </div>
            </div>
          </div>

          <form class="agent-compose" @submit.prevent="sendAgent">
            <textarea v-model="instruction" data-project-agent-input :placeholder="mode === 'assistant' ? '让项目 Agent 读取/修改项目文件或调用能力…' : '交给项目 Agent 的完整任务指令…'" :disabled="agentLoading" rows="2" />
            <div class="agent-compose-foot">
              <span>{{ modeInfo.label }}模式 · 写操作仍受后端权限/审批链约束</span>
              <DsButton type="submit" variant="primary" size="sm" data-project-agent-send :disabled="!instruction.trim() || agentLoading" :status="agentLoading ? 'loading' : 'idle'">发送</DsButton>
            </div>
          </form>
          <p v-if="agentError" class="gov-error agent-error" role="alert" data-project-agent-error>{{ agentError }}</p>
        </template>
      </section>

      <ResourcePicker v-if="picking" picker-app-id="resource-library" :requested-actions="['resource.view']" title="引用资源" @choose="addResource" @cancel="picking = false" />
    </div>
  </div>
</template>

<style scoped>
.agent-main { overflow: hidden; }
.agent-scroll { flex: 1; min-height: 0; overflow: auto; }
.agent-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding: 4px 16px 16px; overflow: hidden; }
.agent-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.agent-head-text { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.agent-head-text strong { font-size: var(--fs-body); font-weight: var(--fw-medium); }
.agent-sub { margin: 0; display: flex; gap: 10px; flex-wrap: wrap; color: var(--muted); font-size: var(--fs-micro); }
.agent-root-id { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-root-missing { color: var(--failed); }
.agent-mode-hint { margin: 0; color: var(--muted); font-size: var(--fs-caption); line-height: var(--lh-normal); }
.agent-root-warn { margin: 0; color: var(--failed); font-size: var(--fs-caption); }
.agent-thread { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(150px, 200px) minmax(0, 1fr); gap: 12px; overflow: hidden; }
.agent-tasks { min-height: 0; overflow: auto; border-right: 0.5px solid var(--line); padding-right: 8px; display: flex; flex-direction: column; gap: 2px; }
.agent-tasks-head { display: flex; justify-content: space-between; color: var(--muted); font-size: var(--fs-micro); padding: 0 6px 6px; }
.agent-tasks-empty { margin: 0; padding: 8px 6px; color: var(--muted); font-size: var(--fs-caption); }
.agent-task-row { display: flex; flex-direction: column; gap: 2px; padding: 7px 8px; border-radius: var(--radius-sm); text-align: left; color: var(--text); }
.agent-task-row:hover { background: rgb(var(--text-rgb) / 0.05); }
.agent-task-row.active { background: rgb(var(--text-rgb) / 0.09); }
.agent-task-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-caption); }
.agent-task-state { color: var(--muted); font-size: var(--fs-micro); }
.agent-conversation { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.agent-card { border-radius: var(--radius-lg); background: rgb(var(--content-rgb) / 0.7); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.agent-card-head { display: flex; align-items: baseline; gap: 10px; }
.agent-card-head strong { flex: 1; min-width: 0; font-size: var(--fs-secondary); font-weight: var(--fw-medium); overflow-wrap: anywhere; }
.agent-status { flex: none; padding: 2px 8px; border-radius: 999px; background: rgb(var(--text-rgb) / 0.06); color: var(--muted); font-size: var(--fs-micro); }
.agent-status[data-project-agent-status="completed"] { color: var(--success-text, #1e7e34); }
.agent-status[data-project-agent-status="failed"], .agent-status[data-project-agent-status="interrupted"] { color: var(--failed); }
.agent-status[data-project-agent-status="waiting_user"] { color: var(--text); background: rgb(var(--text-rgb) / 0.12); }
.agent-meta { margin: 0; display: flex; flex-wrap: wrap; gap: 10px; color: var(--muted); font-size: var(--fs-micro); }
.agent-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.agent-actions button, .agent-approval button { padding: 4px 10px; border-radius: var(--radius-md); font-size: var(--fs-caption); background: rgb(var(--text-rgb) / 0.08); color: var(--text); }
.agent-actions button.danger { color: var(--failed); }
.agent-actions button:disabled, .agent-approval button:disabled { opacity: 0.45; }
.agent-approval { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.06); }
.agent-approval p { margin: 0; color: var(--muted); font-size: var(--fs-caption); white-space: pre-wrap; }
.agent-approval textarea, .agent-compose textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 54px; padding: 8px 10px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.05); color: var(--text); font: inherit; font-size: var(--fs-caption); outline: none; }
.agent-approval textarea:focus, .agent-compose textarea:focus { box-shadow: 0 0 0 2px var(--focus); }
.agent-approval button { align-self: flex-start; }
.agent-section-title { color: var(--muted); font-size: var(--fs-micro); margin-bottom: 4px; }
.agent-steps ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.agent-steps li { display: flex; align-items: center; gap: 8px; font-size: var(--fs-caption); }
.agent-step-mark { width: 16px; color: var(--muted); text-align: center; }
.agent-step-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-steps li[data-s="completed"] .agent-step-mark { color: var(--success, #34c759); }
.agent-steps li[data-s="failed"] .agent-step-mark { color: var(--failed); }
.agent-events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow: auto; }
.agent-events li { display: flex; gap: 8px; align-items: baseline; font-size: var(--fs-caption); flex-wrap: wrap; }
.agent-event-seq { color: var(--muted); font-size: var(--fs-micro); min-width: 26px; }
.agent-event-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.agent-events small { color: var(--muted); font-size: var(--fs-micro); }
.agent-event-data { flex-basis: 100%; color: var(--muted); font-family: var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.agent-run, .agent-deliverables { display: flex; flex-direction: column; gap: 3px; font-size: var(--fs-caption); }
.agent-run p, .agent-deliverables p { margin: 0; }
.agent-run-detail, .agent-run-error { color: var(--muted); font-size: var(--fs-micro); }
.agent-run-error { color: var(--failed); }
.agent-result { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: var(--fs-body); line-height: var(--lh-relaxed); max-height: 34vh; overflow: auto; user-select: text; }
.agent-trace { display: flex; flex-wrap: wrap; gap: 6px; }
.agent-trace span { padding: 1px 7px; border-radius: 999px; background: rgb(var(--text-rgb) / 0.06); color: var(--muted); font-size: var(--fs-micro); }
.agent-empty-chat { color: var(--muted); font-size: var(--fs-caption); padding: 18px 4px; }
.agent-empty-icon { color: var(--muted); margin-bottom: 10px; }
.agent-compose { flex: none; display: flex; flex-direction: column; gap: 6px; }
.agent-compose-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--muted); font-size: var(--fs-micro); }
.agent-error { margin: 0; }
.agent-side-empty { margin: 0; padding: 6px 10px; color: var(--muted); font-size: var(--fs-micro); line-height: var(--lh-normal); }
.agent-side-item { gap: 8px; }
.agent-root-mark { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); opacity: 0.4; flex: none; }
.agent-root-mark[data-agent-root="set"] { background: var(--success, #34c759); opacity: 1; }
@container (max-width: 820px) {
  .agent-thread { grid-template-columns: 1fr; }
  .agent-tasks { border-right: 0; border-bottom: 0.5px solid var(--line); max-height: 150px; padding: 0 0 8px; }
}
</style>
