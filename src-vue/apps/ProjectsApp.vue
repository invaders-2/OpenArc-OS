<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import DsButton from "../design-system/DsButton.vue";
import ResourcePicker from "./ResourcePicker.vue";
import { Brain, Code2, FileText, Folder, Image as ImageIcon, Music, Plus, Sparkles, Type, Video } from "lucide-vue-next";
import { watch } from "vue";
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

const tab = ref<"tasks" | "files" | "members" | "memory">("tasks");
const creatingProject = ref(false);
const newTaskOpen = ref(false);
const newTaskTitle = ref("");
const newTaskMode = ref<AssistantMode>("thinking");
const agentProjectCounts = ref<Record<string, number>>({});
const resourceThumbs = ref<Record<string, string>>({});

const current = computed(() => projects.value.find((p) => p.id === projectId.value) ?? null);
const matchingResourceProject = computed(() => {
  if (!agentProject.value) return null;
  return projects.value.find((p) => p.name === agentProject.value.name) ?? null;
});
const RES_ICON: Record<string, unknown> = {
  memory: Brain, text: FileText, document: FileText, image: ImageIcon, video: Video, audio: Music, code: Code2, prompt: Type, generated: Sparkles,
};
const taskStats = computed(() => {
  const list = agentTasks.value;
  const done = list.filter((t) => t.status === "completed").length;
  const running = list.filter((t) => ["queued", "planning", "running", "verifying"].includes(String(t.status))).length;
  const waiting = list.filter((t) => t.status === "waiting_user").length;
  return { done, running, waiting, total: list.length, progress: list.length ? Math.round((done / list.length) * 100) : 0 };
});
function taskPercent(t: any): number | null {
  if (t.status === "completed") return 100;
  if (t.status === "cancelled" || t.status === "failed") return 0;
  return null;
}
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
  if (res.ok) { resources.value = Array.isArray(res.items) ? res.items : []; await loadResourceThumbs(); }
  else error.value = res.error;
}
async function loadAgentProjects() {
  if (!agent) return;
  const res = await agentCommand("agent/project/list", {}, agent);
  if (!res.ok) { agentError.value = agentErrorText(res.error, res.message); return; }
  agentProjects.value = Array.isArray(res.value?.items) ? res.value.items : [];
  await loadAgentProjectCounts();
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
  projectId.value = null;
  tab.value = "tasks";
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
async function loadAgentProjectCounts() {
  if (!agent) return;
  const next: Record<string, number> = {};
  for (const project of agentProjects.value) {
    const res = await agentCommand("agent/task/list", { projectId: project.id }, agent);
    next[project.id] = res.ok && Array.isArray(res.value?.items) ? res.value.items.length : 0;
  }
  agentProjectCounts.value = next;
}
async function loadAgentTasks() {
  if (!agent || !agentProjectId.value) return;
  const res = await agentCommand("agent/task/list", { projectId: agentProjectId.value }, agent);
  if (!res.ok) { agentError.value = agentErrorText(res.error, res.message); return; }
  agentTasks.value = Array.isArray(res.value?.items) ? res.value.items : [];
  if (selectedTaskId.value && !agentTasks.value.some((t) => t.taskId === selectedTaskId.value)) {
    selectedTaskId.value = null;
    taskDetail.value = null;
    taskEvents.value = [];
  }
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
  if (res.ok) { name.value = ""; await loadProjects(); projectId.value = res.project.id; tab.value = "files"; await loadResources(res.project.id); }
  else error.value = res.error;
}
async function selectProject(id: string) {
  projectId.value = id;
  agentProjectId.value = null;
  tab.value = "files";
  view.value = "resources";
  void loadResources(id);
}
async function loadResourceThumbs() {
  const next: Record<string, string> = {};
  for (const row of resources.value) {
    const ref = row && row.resource ? row.resource.resourceRef : "";
    if (!row.authorized || !ref) continue;
    const res = await cmd({ type: "resource/thumbnail", resourceRef: ref });
    if (res && res.ok && typeof res.url === "string" && res.url) next[row.resourceId] = res.url;
  }
  resourceThumbs.value = next;
}
function taskProgressWidth(t: any): string {
  const value = taskPercent(t);
  return value == null ? "0" : value + "%";
}
function selectResourceForAgent(id: string) {
  projectId.value = id;
  agentProjectId.value = null;
  tab.value = "files";
  view.value = "resources";
  void loadResources(id);
}
watch(tab, (next) => {
  if (next !== "files") return;
  if (agentProject.value && matchingResourceProject.value && projectId.value !== matchingResourceProject.value.id) {
    void loadResources(matchingResourceProject.value.id);
  }
});
async function openTaskRow(t: any) {
  if (selectedTaskId.value === t.taskId) {
    selectedTaskId.value = null;
    return;
  }
  await selectTask(t.taskId);
}
async function createTaskFromDialog() {
  if (!agent || !agentProject.value || !newTaskTitle.value.trim()) return;
  const res = await agentCommand("agent/task/create", {
    projectId: agentProject.value.id,
    instruction: newTaskTitle.value.trim(),
    title: newTaskTitle.value.trim().slice(0, 60),
    executionProfile: newTaskMode.value === "agent" ? "agent" : "thinking",
  }, agent);
  if (!res.ok) { agentError.value = agentErrorText(res.error, res.message); return; }
  newTaskOpen.value = false;
  newTaskTitle.value = "";
  await loadAgentTasks();
  await loadAgentProjectCounts();
  if (res.value?.task?.taskId) await selectTask(res.value.task.taskId);
}
async function createResourceProjectForAgent() {
  if (!agentProject.value) return;
  const res = await cmd({ type: "resource/createProject", name: agentProject.value.name });
  if (!res.ok) { error.value = res.error; return; }
  await loadProjects();
  projectId.value = res.project.id;
  tab.value = "files";
  view.value = "resources";
  await loadResources(res.project.id);
}
async function addResource(ref: string) {
  picking.value = false;
  if (!projectId.value) return;
  const res = await cmd({ type: "resource/addProjectResource", projectId: projectId.value, resourceRef: ref });
  if (res.ok) { await loadResources(projectId.value); await loadResourceThumbs(); }
  else error.value = res.error;
}
</script>

<template>
  <div class="split projects-app">
    <nav class="split-side pj-side" aria-label="项目">
      <div class="split-section">项目</div>
      <div class="projects" data-agent-projects data-d3-04d="projects">
        <p v-if="!agent" class="agent-side-empty" data-agent-bridge-missing>Agent 桥不可用：只能在桌面应用内使用。</p>
        <p v-else-if="!agentProjects.length" class="agent-side-empty" data-agent-projects-empty>还没有 Agent 项目。点下方「新建项目」创建。</p>
        <ul v-else class="pj-list" data-d3-04d-projects>
          <li v-for="p in agentProjects" :key="p.id">
            <button
              type="button"
              class="split-nav pj-nav"
              :data-agent-project="p.id"
              :data-d3-04d-project="p.id"
              :aria-current="agentProjectId === p.id ? 'true' : undefined"
              @click="selectAgentProject(p.id)"
            >
              <Folder :size="16" />
              <span class="split-nav-label">{{ p.name }}</span>
              <span class="pj-count">{{ agentProjectCounts[p.id] ?? 0 }}</span>
              <span class="agent-root-mark" :data-agent-root="p.root_node_id ? 'set' : 'missing'" :title="p.root_node_id ? '后端有项目根' : '后端没有 dx 项目根'" />
            </button>
          </li>
        </ul>
        <form v-if="agent && creatingProject" class="pj-new" @submit.prevent="createAgentProject(); creatingProject = false">
          <Plus :size="15" />
          <input v-model="newAgentName" data-agent-project-name placeholder="项目名称" aria-label="新 Agent 项目名称" />
          <button type="submit" class="pj-new-btn" data-agent-project-new :disabled="!newAgentName.trim()">新建</button>
        </form>
        <button v-else-if="agent" type="button" class="split-nav pj-create" data-agent-project-create @click="creatingProject = true">
          <Plus :size="16" /><span class="split-nav-label">新建项目</span>
        </button>
      </div>

      <div class="split-section">资源项目</div>
      <div class="projects">
        <ul class="pj-list">
          <li v-for="p in projects" :key="p.id">
            <button type="button" class="split-nav pj-nav" :data-d3-04d-project="p.id" :aria-current="projectId === p.id ? 'true' : undefined" @click="selectProject(p.id)">
              <Folder :size="16" /><span class="split-nav-label">{{ p.name }}</span>
            </button>
          </li>
        </ul>
        <form class="pj-new" @submit.prevent="create">
          <Plus :size="15" />
          <input v-model="name" data-d3-04d-project-name placeholder="新建资源项目" aria-label="新资源项目名称" />
          <button type="submit" class="pj-new-btn" data-d3-04d-project-new :disabled="!bridgeReady" :data-empty="!name.trim()">新建</button>
        </form>
        <p v-if="!bridgeReady" class="agent-side-empty">资源桥不可用（仅桌面应用）。</p>
      </div>
    </nav>

    <div class="split-main pj-main">
      <div class="pane-toolbar pj-toolbar">
        <div class="pj-title-block">
          <strong class="pj-title">{{ agentProject ? agentProject.name : current ? current.name : "项目" }}</strong>
          <span class="pj-sub" data-project-owner-due>
            <template v-if="agentProject">负责人未设置 · 截止未设置</template>
            <template v-else-if="current">资源项目 · {{ resources.length }} 个引用</template>
            <template v-else>选择或新建项目</template>
          </span>
        </div>
        <span class="toolbar-spacer" />
        <div class="segmented text" role="group" aria-label="项目视图" data-project-tabs>
          <button type="button" :aria-pressed="tab === 'tasks'" data-project-tab="tasks" @click="tab = 'tasks'">任务控制台</button>
          <button type="button" :aria-pressed="tab === 'files'" data-project-tab="files" @click="tab = 'files'">文件</button>
          <button type="button" :aria-pressed="tab === 'members'" data-project-tab="members" @click="tab = 'members'">成员</button>
          <button type="button" :aria-pressed="tab === 'memory'" data-project-tab="memory" @click="tab = 'memory'">项目记忆</button>
        </div>
        <DsButton v-if="agentProject" variant="primary" size="sm" data-project-new-task @click="newTaskOpen = true"><Plus :size="13" /> 新任务</DsButton>
        <DsButton v-else-if="projectId" variant="secondary" size="sm" data-d3-04d-project-add @click="picking = true"><Plus :size="13" /> 引用资源</DsButton>
      </div>

      <p v-if="agentError" class="gov-error pj-error" role="alert" data-project-agent-error>{{ agentError }}</p>
      <p v-if="error" class="gov-error pj-error" role="alert" data-d3-04d-project-error>{{ errText(error) }}</p>

      <section v-if="tab === 'tasks'" class="pj-body">
        <template v-if="agentProject">
          <div class="pj-stats">
            <div class="pj-stat pj-stat-progress">
              <span class="pj-cap">整体进度</span>
              <div class="pj-stat-row"><b class="pj-num">{{ taskStats.progress }}%</b><div class="progress grow"><i :style="{ width: taskStats.progress + '%' }" /></div></div>
              <small class="pj-cap">按已完成任务占比推导；无事件不编进度</small>
            </div>
            <div class="pj-stat"><span class="pj-cap">进行中</span><b class="pj-num">{{ taskStats.running }}</b></div>
            <div class="pj-stat"><span class="pj-cap">等待确认</span><b class="pj-num">{{ taskStats.waiting }}</b></div>
            <div class="pj-stat"><span class="pj-cap">已完成</span><b class="pj-num">{{ taskStats.done }}</b></div>
          </div>

          <p v-if="!agentTasks.length" class="pj-note" data-project-tasks-empty>还没有任务。点右上角「新任务」创建真实 agent 任务。</p>
          <table v-else class="tbl pj-table" data-project-agent-tasks>
            <thead><tr><th>任务</th><th>执行者</th><th>状态</th><th style="width: 170px">进度</th><th></th></tr></thead>
            <tbody>
              <tr
                v-for="t in agentTasks"
                :key="t.taskId"
                :class="{ sel: selectedTaskId === t.taskId }"
                :data-project-agent-task-item="t.taskId"
                @click="openTaskRow(t)"
              >
                <td><b class="pj-task-title">{{ t.title || t.instruction }}</b><div v-if="t.errorMessage" class="pj-err">{{ t.errorMessage }}</div></td>
                <td class="pj-mut">助理 · {{ t.executionProfile || t.mode || "thinking" }}</td>
                <td><span class="pj-status" :data-project-agent-task-item-status="t.status">{{ taskStatusText(t.status) }}</span></td>
                <td>
                  <div class="progress" :class="{ ind: isLiveTask(t.status) }"><i :style="{ width: taskProgressWidth(t) }" :data-known="taskPercent(t) != null ? '1' : '0'" /></div>
                  <small v-if="taskPercent(t) == null" class="pj-cap">进度不可推导</small>
                </td>
                <td class="pj-actions">
                  <button v-if="t.status === 'waiting_user'" type="button" data-project-go-confirm @click.stop="openTaskRow(t)">去确认</button>
                  <button v-else-if="['failed', 'interrupted', 'paused'].includes(String(t.status))" type="button" data-project-retry @click.stop="selectTask(t.taskId); resumeTask()">重试</button>
                </td>
              </tr>
            </tbody>
          </table>

          <div v-if="selectedTaskId && task" class="pj-expand" data-project-agent-task="detail">
            <div class="pj-expand-head">
              <b>{{ task.title || task.instruction }}</b>
              <span class="pj-status" :data-project-agent-status="task.status">{{ taskStatusText(task.status) }}</span>
            </div>
            <p class="pj-meta">
              <span>profile {{ task.executionProfile || "—" }}</span>
              <span>mode {{ task.mode || "—" }}</span>
              <span data-project-agent-checkpoints>检查点 {{ taskDetail?.checkpoints ?? 0 }}</span>
              <span v-if="task.agentRunId">run {{ task.agentRunId }}</span>
            </p>
            <div class="pj-expand-actions">
              <button v-if="canPause" type="button" data-project-agent-pause @click="pauseTask">暂停</button>
              <button v-if="canResume" type="button" data-project-agent-resume @click="resumeTask">恢复</button>
              <button v-if="canCancel" type="button" class="danger" data-project-agent-cancel @click="cancelTask">取消</button>
              <button type="button" :disabled="taskBusy" data-project-agent-refresh @click="refreshTask">刷新状态</button>
            </div>
            <div v-if="task.status === 'waiting_user'" class="pj-answer" data-project-agent-approval>
              <strong>需要你确认 / 回答（后端 task.waiting_user）</strong>
              <p>{{ waitingQuestion || "后端事件里没有返回问题文本；下面是完整事件记录。" }}</p>
              <textarea v-model="answer" data-project-agent-answer-input placeholder="回答后端的问题后再继续" />
              <button type="button" :disabled="!answer.trim()" data-project-agent-answer @click="answerTask">回答并继续</button>
            </div>
            <div v-if="!isLiveTask(task.status) && task.mode === 'react'" class="pj-answer" data-project-agent-continue-block>
              <strong>追加要求（后端 task/continue）</strong>
              <textarea v-model="followUp" data-project-agent-continue-input placeholder="追加要求…" />
              <button type="button" :disabled="!followUp.trim()" data-project-agent-continue @click="continueTask">追加并重新入队</button>
            </div>
            <div v-if="taskDetail?.steps?.length" class="pj-steps">
              <div class="pj-section-title">步骤</div>
              <ol>
                <li v-for="s in taskDetail.steps" :key="s.id" :data-project-agent-step="s.id" :data-s="s.status">
                  <span class="pj-step-mark">{{ stepIcon(s.status) }}</span>
                  <span class="pj-step-title">{{ s.title || s.tool || "步骤" }}</span>
                  <small>{{ stepText(s.status) }}</small>
                </li>
              </ol>
            </div>
            <div class="pj-timeline">
              <div class="pj-section-title">事件记录</div>
              <p v-if="!taskEvents.length" class="pj-note">没有任务事件。</p>
              <ul v-else class="pj-events" data-project-agent-events>
                <li v-for="e in taskEvents" :key="e.id || e.sequence" :data-project-agent-event="e.type">
                  <span class="pj-event-seq">#{{ e.sequence }}</span>
                  <span class="pj-event-text">{{ eventSummary(e) }}</span>
                  <small>{{ eventTime(e) }}</small>
                </li>
              </ul>
            </div>
            <div v-if="taskRun" class="pj-run" data-project-agent-run>
              <div class="pj-section-title">Run 检查点 / 恢复信息</div>
              <p>状态 {{ taskRun.run?.status || "—" }}<span v-if="runRecovery"> · 检查点 #{{ runRecovery.checkpointSequence ?? "—" }} / {{ runRecovery.checkpointPhase || "—" }} · 尝试 {{ runRecovery.attemptNo }}</span></p>
            </div>
            <div v-if="taskDetail?.deliverables?.length" class="pj-deliverables" data-project-agent-deliverables>
              <div class="pj-section-title">产物</div>
              <p v-for="d in taskDetail.deliverables" :key="d.id">{{ d.name }} · {{ d.type }}</p>
            </div>
            <p v-if="task.errorMessage" class="pj-err" data-project-agent-task-error>{{ task.errorMessage }}</p>
          </div>

          <details class="pj-compose" data-project-agent-compose>
            <summary>直接交给项目 Agent（同步，真实 agent/project/run）</summary>
            <div class="segmented text pj-modes" role="group" aria-label="Agent 模式" data-project-agent-modes>
              <button v-for="m in AGENT_MODES" :key="m.id" type="button" :aria-pressed="mode === m.id" :data-project-agent-mode="m.id" @click="setMode(m.id)">{{ m.label }}</button>
            </div>
            <p class="pj-note">{{ modeInfo.hint }}</p>
            <form class="pj-compose-form" @submit.prevent="sendAgent">
              <textarea v-model="instruction" data-project-agent-input :placeholder="mode === 'assistant' ? '让项目 Agent 读取/修改项目文件或调用能力…' : '交给项目 Agent 的完整任务指令…'" :disabled="agentLoading" rows="2" />
              <DsButton type="submit" variant="primary" size="sm" data-project-agent-send :disabled="!instruction.trim() || agentLoading" :status="agentLoading ? 'loading' : 'idle'">发送</DsButton>
            </form>
            <div v-if="outcome" class="pj-outcome" data-project-agent-outcome>
              <div class="pj-expand-head"><b>项目 Agent 回复</b><span class="pj-status">{{ outcome.complete === false ? "未通过完成验收" : "已完成" }}</span></div>
              <pre class="pj-result">{{ outcome.text || prettyDetail(outcome) }}</pre>
            </div>
          </details>
        </template>
        <div v-else class="pj-empty" data-project-no-agent>
          <FileText :size="30" class="pj-empty-icon" />
          <p><b>资源项目没有任务控制台</b></p>
          <p class="pj-note">任务来自真实 agent 项目（agent/task/*）；左侧「项目」分组里选一个 agent 项目。</p>
        </div>
      </section>

      <section v-else-if="tab === 'files'" class="pj-body">
        <template v-if="agentProject">
          <template v-if="matchingResourceProject">
            <div class="pj-files-head">
              <span class="pj-cap">{{ matchingResourceProject.name }} · {{ resources.length }} 个引用</span>
              <DsButton variant="secondary" size="sm" data-project-files-add @click="selectResourceForAgent(matchingResourceProject.id)"><Plus :size="13" /> 引用资源</DsButton>
            </div>
            <p v-if="!resources.length" class="pj-note">这个资源项目还没有引用资源。</p>
            <div v-else class="pj-grid" data-project-files>
              <div v-for="r in resources" :key="r.resourceId" class="pj-file" :data-project-file="r.resourceId">
                <span class="pj-file-thumb">
                  <img v-if="r.authorized && resourceThumbs[r.resourceId]" :src="resourceThumbs[r.resourceId]" alt="" />
                  <component v-else :is="RES_ICON[r.resource?.resourceType] || FileText" :size="26" :stroke-width="1.4" />
                </span>
                <b class="pj-file-name">{{ r.authorized ? r.resource.name : r.resourceRef }}</b>
                <small class="pj-cap">{{ r.authorized ? (r.resource.resourceType || "资源") : "无访问权限" }}</small>
              </div>
            </div>
          </template>
          <div v-else class="pj-empty" data-project-files-empty>
            <Folder :size="30" class="pj-empty-icon" />
            <p><b>这个 Agent 项目还没有同名资源项目</b></p>
            <p class="pj-note">文件通过资源项目的引用进入项目；后端没有把 agent 项目直接挂资源。</p>
            <DsButton variant="secondary" size="sm" @click="createResourceProjectForAgent">创建同名资源项目</DsButton>
          </div>
        </template>
        <template v-else-if="projectId">
          <div class="pj-files-head">
            <span class="pj-cap">{{ resources.length }} 个引用 · 访问权逐个重新校验</span>
            <DsButton variant="secondary" size="sm" data-d3-04d-project-add @click="picking = true"><Plus :size="13" /> 引用资源</DsButton>
          </div>
          <p v-if="!resources.length" class="pj-note">还没有引用任何资源。用「引用资源」从资源库里挑选。</p>
          <div v-else class="pj-grid" data-d3-04d-project-resources>
            <div v-for="r in resources" :key="r.resourceId" class="pj-file" :data-d3-04d-project-resource="r.resourceId" :data-d3-04d-project-resource-authorized="r.authorized ? 'true' : 'false'">
              <span class="pj-file-thumb">
                <img v-if="r.authorized && resourceThumbs[r.resourceId]" :src="resourceThumbs[r.resourceId]" alt="" />
                <component v-else :is="RES_ICON[r.resource?.resourceType] || FileText" :size="26" :stroke-width="1.4" />
              </span>
              <b class="pj-file-name">{{ r.authorized ? r.resource.name : r.resourceRef }}</b>
              <small class="pj-cap">{{ r.authorized ? "可访问" : "无访问权限" }}</small>
            </div>
          </div>
        </template>
        <div v-else class="pj-empty">
          <Folder :size="30" class="pj-empty-icon" />
          <p><b>{{ projects.length ? "选择一个项目" : "还没有项目" }}</b></p>
          <p class="pj-note">资源项目把相关资源引用放在一起；在左侧新建或选择。</p>
        </div>
      </section>

      <section v-else-if="tab === 'members'" class="pj-body">
        <div class="pj-empty" data-project-members-unverified>
          <p><b>成员、角色、项目权限未接入</b></p>
          <p class="pj-note">后端没有项目成员 / 角色 / 本项权限字段，这里不列假成员（NOT VERIFIED）。真实的访问控制由授权域逐个资源判定。</p>
        </div>
      </section>

      <section v-else class="pj-body">
        <div class="pj-empty" data-project-memory-unverified>
          <p><b>项目记忆未接入</b></p>
          <p class="pj-note">后端没有项目记忆的列表 / 添加 / 删除命令，这里不造记忆条目（NOT VERIFIED）。Memory 类型资源仍可在资源库查看。</p>
        </div>
      </section>

      <ResourcePicker v-if="picking" picker-app-id="resource-library" :requested-actions="['resource.view']" title="引用资源" @choose="addResource" @cancel="picking = false" />

      <div v-if="newTaskOpen" class="pj-modal" data-project-new-task-dialog>
        <div class="pj-modal-card" role="dialog" aria-modal="true" aria-label="新建任务">
          <header class="pj-modal-head"><b>新建任务</b><button type="button" aria-label="关闭" @click="newTaskOpen = false">×</button></header>
          <label class="pj-field"><span>任务名称</span><input v-model="newTaskTitle" data-project-new-task-title placeholder="例如：生成 3 张门店海报" /></label>
          <div class="pj-field"><span>执行者</span>
            <div class="segmented text"><button type="button" aria-pressed="true">助理</button><button type="button" disabled title="后端没有本人执行任务的命令">自己（未接入）</button></div>
          </div>
          <div class="pj-field"><span>执行设备</span>
            <div class="segmented text"><button type="button" aria-pressed="true" disabled>本机 · D1</button></div>
            <small class="pj-cap">任务命令没有设备字段（NOT VERIFIED）</small>
          </div>
          <label class="pj-field"><span>执行方式</span>
            <select v-model="newTaskMode" data-project-new-task-mode>
              <option value="thinking">thinking</option>
              <option value="agent">agent</option>
            </select>
          </label>
          <footer class="pj-modal-foot">
            <DsButton variant="secondary" size="sm" @click="newTaskOpen = false">取消</DsButton>
            <DsButton variant="primary" size="sm" data-project-new-task-submit :disabled="!newTaskTitle.trim()" @click="createTaskFromDialog">创建</DsButton>
          </footer>
        </div>
      </div>
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

/* ── 原型对照（task-6）：项目列表 / 任务控制台 / 文件 / 成员 / 记忆 ───────── */
.projects-app .split-side { margin-right: 0; }
.projects-app .split-main { padding: 0; padding-top: 0 !important; }
.pj-main { overflow: hidden; display: flex; flex-direction: column; }
.pj-toolbar { height: 52px; margin: 0; padding: 0 20px; flex: none; }
.pj-body { padding: 8px 24px 24px; }
.pj-stats { grid-template-columns: minmax(0, 1fr) 140px 140px 140px; gap: 12px; }
.pj-stat { padding: 12px 16px; }
.pj-table th { padding: 9px 8px; }
.pj-table td { padding: 9px 8px; height: 41px; }
.pj-table th:nth-child(1), .pj-table td:nth-child(1) { width: 44%; }
.pj-table th:nth-child(2), .pj-table td:nth-child(2) { width: 16%; }
.pj-table th:nth-child(3), .pj-table td:nth-child(3) { width: 15%; }
.pj-table th:nth-child(4), .pj-table td:nth-child(4) { width: 20%; }
.pj-side .split-section { padding: 12px 10px 4px; font-size: var(--fs-micro); font-weight: var(--fw-medium); color: var(--muted); }
.pj-nav { min-height: 32px; padding: 0 10px; gap: 9px; }
.pj-count { margin-left: auto; color: var(--muted); font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
.pj-create { width: 100%; color: var(--muted); }
.pj-create:hover { color: var(--text); }
.pj-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pj-title-block { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.pj-title { font-size: var(--fs-body); font-weight: var(--fw-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pj-sub { color: var(--muted); font-size: var(--fs-micro); }
.pj-body { flex: 1; min-height: 0; overflow: auto; padding: 4px 16px 16px; }
.pj-error { margin: 0 16px 8px; }
.pj-stats { display: grid; grid-template-columns: minmax(220px, 1.6fr) repeat(3, minmax(92px, 1fr)); gap: 12px; margin-bottom: 16px; }
.pj-stat { padding: 12px 14px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.05); display: flex; flex-direction: column; gap: 4px; }
.pj-stat-row { display: flex; align-items: center; gap: 12px; }
.pj-stat-row .progress { flex: 1; }
.pj-num { font-size: 24px; font-weight: var(--fw-regular); font-variant-numeric: tabular-nums; line-height: 1.1; }
.pj-cap { color: var(--muted); font-size: var(--fs-micro); }
.pj-table { width: 100%; border-collapse: collapse; }
.pj-table th { text-align: left; padding: 7px 8px; color: var(--muted); font-size: var(--fs-micro); font-weight: var(--fw-regular); border-bottom: 0.5px solid var(--line); }
.pj-table td { padding: 9px 8px; vertical-align: middle; border-bottom: 0.5px solid var(--line); font-size: var(--fs-caption); }
.pj-table tbody tr { cursor: pointer; }
.pj-table tbody tr:hover { background: rgb(var(--text-rgb) / 0.04); }
.pj-table tbody tr.sel { background: rgb(var(--text-rgb) / 0.08); }
.pj-task-title { font-weight: var(--fw-medium); }
.pj-mut { color: var(--muted); }
.pj-status { display: inline-flex; height: 22px; align-items: center; padding: 0 8px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.06); color: var(--muted); font-size: var(--fs-micro); }
.pj-status[data-project-agent-task-item-status="completed"], .pj-status[data-project-agent-status="completed"] { color: var(--text); background: rgb(var(--text-rgb) / 0.1); }
.pj-status[data-project-agent-task-item-status="failed"], .pj-status[data-project-agent-status="failed"] { color: var(--failed); }
.pj-status[data-project-agent-task-item-status="waiting_user"], .pj-status[data-project-agent-status="waiting_user"] { color: var(--text); background: rgb(var(--text-rgb) / 0.14); }
.pj-table .progress { height: 6px; border-radius: 999px; background: rgb(var(--text-rgb) / 0.1); overflow: hidden; }
.pj-table .progress i { display: block; height: 100%; background: var(--text); border-radius: inherit; }
.pj-actions button, .pj-expand-actions button, .pj-answer button { height: 24px; padding: 0 10px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.07); color: var(--text); font-size: var(--fs-micro); }
.pj-actions button:hover, .pj-expand-actions button:hover { background: rgb(var(--text-rgb) / 0.12); }
.pj-expand-actions button.danger { color: var(--failed); }
.pj-actions button:disabled, .pj-expand-actions button:disabled, .pj-answer button:disabled { opacity: 0.45; }
.pj-expand { margin-top: 14px; padding: 14px 16px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.05); display: flex; flex-direction: column; gap: 10px; }
.pj-expand-head { display: flex; align-items: center; gap: 10px; justify-content: space-between; }
.pj-expand-head b { font-weight: var(--fw-medium); font-size: var(--fs-secondary); }
.pj-meta { display: flex; flex-wrap: wrap; gap: 12px; margin: 0; color: var(--muted); font-size: var(--fs-micro); }
.pj-answer { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.05); }
.pj-answer strong { font-size: var(--fs-caption); font-weight: var(--fw-medium); }
.pj-answer p { margin: 0; color: var(--muted); font-size: var(--fs-caption); white-space: pre-wrap; }
.pj-answer button { align-self: flex-start; }
.pj-answer textarea, .pj-compose-form textarea { width: 100%; box-sizing: border-box; min-height: 52px; resize: vertical; padding: 8px 10px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.05); color: var(--text); font: inherit; font-size: var(--fs-caption); outline: none; }
.pj-answer textarea:focus, .pj-compose-form textarea:focus { box-shadow: 0 0 0 2px var(--focus); }
.pj-section-title { color: var(--muted); font-size: var(--fs-micro); margin-bottom: 4px; }
.pj-steps ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.pj-steps li { display: flex; align-items: center; gap: 8px; font-size: var(--fs-caption); }
.pj-step-mark { width: 16px; color: var(--muted); text-align: center; }
.pj-step-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pj-events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow: auto; }
.pj-events li { display: flex; gap: 8px; align-items: baseline; font-size: var(--fs-caption); }
.pj-event-seq { color: var(--muted); font-size: var(--fs-micro); min-width: 26px; }
.pj-event-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.pj-events small { color: var(--muted); font-size: var(--fs-micro); }
.pj-run p, .pj-deliverables p { margin: 0; font-size: var(--fs-caption); }
.pj-compose { margin-top: 16px; padding: 12px 14px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); }
.pj-compose > summary { cursor: pointer; color: var(--muted); font-size: var(--fs-caption); }
.pj-compose-form { display: flex; gap: 8px; align-items: flex-end; margin-top: 8px; }
.pj-compose-form textarea { flex: 1; }
.pj-outcome { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.pj-result { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: var(--fs-caption); line-height: var(--lh-relaxed); max-height: 220px; overflow: auto; }
.pj-files-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.pj-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.pj-file { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.05); min-width: 0; }
.pj-file-thumb { aspect-ratio: 4 / 3; display: grid; place-items: center; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.05); color: var(--muted); overflow: hidden; }
.pj-file-thumb img { width: 100%; height: 100%; object-fit: cover; }
.pj-file-name { font-size: var(--fs-caption); font-weight: var(--fw-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pj-note { margin: 0; color: var(--muted); font-size: var(--fs-caption); line-height: var(--lh-relaxed); }
.pj-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; padding: 46px 20px; color: var(--text); }
.pj-empty p { margin: 0; }
.pj-empty-icon { color: var(--muted); opacity: 0.7; margin-bottom: 4px; }
.pj-empty .pj-note { max-width: 420px; }
.pj-modal { position: absolute; inset: 0; z-index: 20; display: grid; place-items: center; background: rgb(0 0 0 / 0.18); }
.pj-modal-card { width: min(420px, calc(100% - 32px)); padding: 16px; border-radius: var(--radius-lg); background: rgb(var(--content-rgb) / 0.98); box-shadow: var(--elevation-3); display: flex; flex-direction: column; gap: 12px; }
.pj-modal-head { display: flex; align-items: center; justify-content: space-between; }
.pj-modal-head b { font-size: var(--fs-secondary); font-weight: var(--fw-medium); }
.pj-modal-head button { width: 24px; height: 24px; border-radius: var(--radius-pill); color: var(--muted); }
.pj-field { display: flex; flex-direction: column; gap: 5px; font-size: var(--fs-caption); }
.pj-field > span { color: var(--muted); }
.pj-field input, .pj-field select { height: 30px; padding: 0 10px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.06); color: var(--text); font: inherit; font-size: var(--fs-caption); outline: none; }
.pj-field input:focus, .pj-field select:focus { box-shadow: 0 0 0 2px var(--focus); }
.pj-modal-foot { display: flex; justify-content: flex-end; gap: 8px; }

/* task-8 final overrides */
.projects-app .split-side { margin: 8px 0 8px 8px !important; }
.pj-stats { grid-template-columns: minmax(0, 1fr) 140px 140px 140px; }
.pj-stat { padding: 10px 14px; }
.pj-table th { padding: 7px 8px; }
.pj-table td { height: 41px; padding: 8px; }

.pj-body { padding: 8px 24px 24px !important; }
.pj-toolbar { align-items: center; }
.pj-table td { height: 41px; padding: 4px 8px; }
.pj-stats { grid-template-columns: minmax(0, 1fr) 140px 140px 140px; }

.pj-stat { padding: 6px 14px; }
.pj-num { font-size: 22px; }
.pj-table td { padding: 3px 8px; height: 41px; }
.pj-actions button { height: 22px; }

.pj-stat { padding: 4px 14px; }
.pj-num { font-size: 20px; }
.pj-table td { height: 41px; padding: 2px 8px; }
.pj-table tbody tr { height: 41px; }

.pj-stat { padding: 8px 14px; }
.pj-table td { height: 41px; padding: 0 8px; }
.pj-task-title { line-height: 20px; }
.pj-table tbody tr { height: 41px; }

.pj-stat { padding: 10px 14px; }
.pj-table td { height: 38px; padding: 0 8px; }
</style>
