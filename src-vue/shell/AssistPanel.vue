<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { Check, CircleAlert, LoaderCircle, Square } from "lucide-vue-next";
import { useShellStore } from "../stores/shell";
import Orb from "./Orb.vue";
import { agentBridge, agentCommand, agentErrorText, prettyDetail } from "../agent/agentClient";

/**
 * 全局 AI · 助理浮层（10-16，按界面原型 assist-panel 与设计语言 §5.3）：
 * 屏幕上方居中的玻璃浮层，只有输入框 + 建议 + 当前任务卡；执行状态全部来自后端 task 桥
 * （task/run · task/get · task/cancel · task/resume · task/acknowledgeUnknownEffect · task/result 事件），
 * 与旧 React AIPanel 同一套语义（续接、结果未知的人工核查、验证失败如实展示），只是界面重做。
 * 「在对话中打开」把同一个任务交给对话应用，不复制数据。
 */
const shell = useShellStore();
const bridge = window.openarc?.task;
const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"];
const STATUS: Record<string, string> = {
  PENDING: "排队中", RUNNING: "执行中", WAITING: "等待你确认", VERIFYING: "验证中",
  SUCCEEDED: "已完成", FAILED: "失败", CANCELLED: "已停止", BLOCKED: "已暂停", running: "执行中", cancelling: "正在停止",
};
const ERR: Record<string, string> = {
  MODEL_CONFIG_UNAVAILABLE: "没有可用的文本模型：先到「系统设置 › 模型与服务商」配置一个。",
  CAPABILITY_UNAVAILABLE: "当前默认模型不支持这个能力。",
  TASK_FORBIDDEN: "当前身份无权发起任务。",
  INTERNAL_ERROR: "任务运行时还没就绪。",
  RESUME_REJECTED: "续接被拒绝。",
};
const errText = (c: string) => (c ? ERR[c] ?? `请求被拒绝（${c}）` : "");

const q = ref("");
const input = ref<HTMLInputElement | null>(null);
const taskId = ref<string | null>(null);
const goal = ref("");
const status = ref("idle");
const revision = ref<number | null>(null);
const steps = ref<{ stepId: string; sequence: number; status: string; input: { goal?: string } | null }[]>([]);
const result = ref("");
const error = ref("");
const busy = ref(false);
const resumable = ref(false);
const stopReason = ref<string | null>(null);
const recovery = ref<any>(null);
const verifications = ref<any[]>([]);

/* task-35 · Jarvis 能力面：真实读 agent/tool/catalog + agent/health，能力发现走 agent/jarvis/run。 */
const agent = agentBridge();
const capOpen = ref(false);
const capLoading = ref(false);
const capError = ref("");
const capFilter = ref("");
const agentHealth = ref<any>(null);
const catalog = ref<any>(null);
const jarvisRun = ref<any>(null);
const routeResult = ref<any>(null);
const routeError = ref("");

async function loadCapabilities() {
  if (!agent) {
    capError.value = "Agent 桥不可用：只能在桌面应用内查看能力。";
    return;
  }
  capLoading.value = true;
  capError.value = "";
  try {
    const [health, tools] = await Promise.all([
      agentCommand("agent/health", {}, agent),
      agentCommand("agent/tool/catalog", { executableOnly: false }, agent),
    ]);
    if (health.ok) agentHealth.value = health.value;
    else capError.value = agentErrorText(health.error, health.message);
    if (tools.ok) catalog.value = tools.value;
    else capError.value = agentErrorText(tools.error, tools.message);
  } finally {
    capLoading.value = false;
  }
}
function openCapabilities() {
  capOpen.value = !capOpen.value;
  if (capOpen.value) void loadCapabilities();
}
async function discoverJarvis() {
  if (!agent) return;
  capLoading.value = true;
  capError.value = "";
  try {
    const res = await agentCommand("agent/jarvis/run", { instruction: q.value.trim() || "查看当前可用的桌面能力" }, agent);
    if (res.ok) jarvisRun.value = res.value;
    else capError.value = agentErrorText(res.error, res.message);
  } finally {
    capLoading.value = false;
  }
}
async function routePreview() {
  if (!agent) return;
  capLoading.value = true;
  routeError.value = "";
  routeResult.value = null;
  try {
    const res = await agentCommand("agent/capability/route", { instruction: q.value.trim() || "查看当前可用的桌面能力" }, agent);
    if (res.ok) routeResult.value = res.value?.route ?? res.value;
    else routeError.value = agentErrorText(res.error, res.message);
  } finally {
    capLoading.value = false;
  }
}
const toolRows = computed(() => {
  const items = Array.isArray(catalog.value?.descriptors) ? catalog.value.descriptors : [];
  const needle = capFilter.value.trim().toLowerCase();
  return items.filter((tool: any) => !needle || String(tool.name + " " + (tool.title || "") + " " + (tool.source || "")).toLowerCase().includes(needle));
});
const sourceCounts = computed(() => {
  const counts: Record<string, number> = {};
  for (const tool of Array.isArray(catalog.value?.descriptors) ? catalog.value.descriptors : []) {
    counts[tool.source || "other"] = (counts[tool.source || "other"] || 0) + 1;
  }
  return counts;
});
const disclosure = computed(() => jarvisRun.value?.disclosure ?? null);

const chips = ["总结一下我桌面上的文稿", "帮我列一份本周工作计划", "用资源库里的图片写一段产品介绍", "解释一下 MCP 是什么"];

function apply(got: any) {
  if (!got?.ok || !got.task) return;
  goal.value = got.task.goal || goal.value;
  status.value = String(got.task.status || "");
  revision.value = typeof got.task.revision === "number" ? got.task.revision : null;
  if (TERMINAL.includes(status.value)) busy.value = false;
  steps.value = Array.isArray(got.steps) ? [...got.steps].sort((a, b) => a.sequence - b.sequence) : [];
  const arts = Array.isArray(got.artifacts) ? got.artifacts : [];
  const last = arts[arts.length - 1];
  if (last && typeof last.content === "string") result.value = last.content;
  resumable.value = got.resumable === true;
  stopReason.value = got.stopReason || null;
  recovery.value = got.recovery || null;
  verifications.value = Array.isArray(got.verifications) ? got.verifications : [];
}
async function refresh() {
  if (!bridge || !taskId.value) return;
  apply(await bridge.command({ command: "task/get", payload: { taskId: taskId.value } }).catch(() => null));
}
async function go() {
  const text = q.value.trim();
  if (!text || !bridge || busy.value) return;
  busy.value = true;
  error.value = "";
  result.value = "";
  steps.value = [];
  goal.value = text;
  status.value = "running";
  const r = await bridge.command({ command: "task/run", payload: { goal: text } }).catch(() => null);
  if (r?.ok) {
    taskId.value = r.taskId;
    q.value = "";
    void refresh();
  } else {
    busy.value = false;
    status.value = "idle";
    taskId.value = null;
    error.value = errText(r?.error || "INTERNAL_ERROR");
  }
}
async function cancel() {
  if (!bridge || !taskId.value) return;
  await bridge.command({ command: "task/cancel", payload: { taskId: taskId.value } }).catch(() => null);
  status.value = "cancelling";
}
async function resume() {
  if (!bridge || !taskId.value || busy.value || !resumable.value) return;
  busy.value = true;
  error.value = "";
  const r = await bridge.command({ command: "task/resume", payload: { taskId: taskId.value, expectedRevision: revision.value } }).catch(() => null);
  if (!r?.ok) {
    busy.value = false;
    error.value = errText(r?.error || "RESUME_REJECTED");
  } else status.value = "running";
}
async function acknowledge(callId: string) {
  if (!bridge || !taskId.value) return;
  const r = await bridge.command({ command: "task/acknowledgeUnknownEffect", payload: { taskId: taskId.value, callId } }).catch(() => null);
  if (!r?.ok) error.value = errText(r?.error || "ACKNOWLEDGE_FAILED");
  await refresh();
}
function newTask() {
  taskId.value = null;
  status.value = "idle";
  steps.value = [];
  result.value = "";
  error.value = "";
  goal.value = "";
  void nextTick(() => input.value?.focus());
}
function toChat() {
  shell.closeAI();
  shell.activateApp("chat");
}
function pick(c: string) {
  q.value = c;
  void go();
}

const running = computed(() => busy.value && !TERMINAL.includes(status.value));
const stepIcon = (s: string) => (s === "SUCCEEDED" ? Check : s === "FAILED" || s === "CANCELLED" ? CircleAlert : LoaderCircle);

let off: (() => void) | null = null;
let poll = 0;
onMounted(async () => {
  await nextTick();
  input.value?.focus();
  // 恢复：最近一个仍在进行中的任务（后端为准），已结束的不再自动摊开
  if (bridge) {
    const list = await bridge.command({ command: "task/list" }).catch(() => null);
    const items = list?.ok && Array.isArray(list.items) ? list.items : [];
    const live = [...items].reverse().find((t: any) => !TERMINAL.includes(String(t.status)));
    if (live) {
      taskId.value = live.taskId;
      busy.value = true;
      await refresh();
    }
  }
  off =
    bridge?.onEvent((ev: any) => {
      if (ev?.type !== "task/result" || ev.taskId !== taskId.value) return;
      busy.value = false;
      if (ev.error) error.value = errText(ev.error);
      void refresh();
    }) ?? null;
  poll = window.setInterval(() => {
    if (running.value) void refresh();
  }, 1000);
});
onBeforeUnmount(() => {
  off?.();
  window.clearInterval(poll);
});
</script>

<template>
  <div class="assist-wrap" @pointerdown.self="shell.closeAI()">
    <section class="assist" role="dialog" aria-label="全局 AI" data-ai-panel :data-ai-status="status" :data-ai-task-id="taskId || ''">
      <div class="assist-in">
        <Orb :size="26" :animated="!shell.reduced" class="assist-orb" :class="{ busy: running }" />
        <input
          ref="input"
          v-model="q"
          data-ai-goal
          aria-label="告诉助理你要做什么"
          :placeholder="taskId ? '再交代一件事…' : '告诉助理你要做什么，例如：总结桌面上的文稿'"
          :disabled="running"
          @keydown.enter.prevent="go"
        />
        <kbd v-if="!running" class="assist-kbd" aria-hidden="true">↵</kbd>
        <button v-else class="assist-stop" data-ai-cancel aria-label="停止任务" title="停止" @click="cancel"><Square :size="11" /></button>
      </div>

      <p v-if="error" class="assist-err" role="alert" data-ai-error>{{ error }}</p>

      <div v-if="!taskId" class="assist-chips">
        <button v-for="c in chips" :key="c" type="button" class="assist-chip" @click="pick(c)">{{ c }}</button>
        <button type="button" class="assist-chip assist-chip-cap" data-ai-capabilities @click="openCapabilities">{{ capOpen ? "收起能力" : "能力与工具" }}</button>
      </div>

      <div v-if="capOpen" class="assist-caps" data-ai-caps>
        <div class="assist-caps-head">
          <strong>Jarvis 能力面</strong>
          <span class="badge" :data-ai-agent-health="agentHealth?.status || ''">{{ agentHealth ? "运行时 " + agentHealth.status : "运行时状态未知" }}</span>
          <button type="button" :disabled="capLoading" data-ai-caps-refresh @click="loadCapabilities">{{ capLoading ? "读取中…" : "刷新" }}</button>
        </div>
        <div class="assist-caps-actions">
          <button type="button" :disabled="capLoading" data-ai-caps-discover @click="discoverJarvis">能力发现（agent/jarvis/run）</button>
          <button type="button" :disabled="capLoading" data-ai-caps-route @click="routePreview">按当前指令路由能力</button>
        </div>
        <p v-if="capError" class="assist-err" role="alert" data-ai-agent-error>{{ capError }}</p>

        <div v-if="catalog" class="assist-caps-summary" data-ai-caps-summary>
          <span>工具 {{ catalog.summary?.total ?? 0 }} · 就绪 {{ catalog.summary?.ready ?? 0 }} · 待配置 {{ catalog.summary?.pending ?? 0 }}</span>
          <span v-for="(count, source) in sourceCounts" :key="source" class="assist-source-count">{{ source }} {{ count }}</span>
        </div>

        <div v-if="disclosure" class="assist-caps-block" data-ai-jarvis-disclosure>
          <div class="assist-caps-label">Agent 网关披露 · {{ jarvisRun?.profileId || "system-jarvis" }}</div>
          <p>run {{ jarvisRun?.runId || "—" }} · 能力 {{ disclosure.capabilities?.length ?? 0 }} · 工具 {{ disclosure.tools?.length ?? 0 }}</p>
          <p v-if="disclosure.clientTools?.length">客户端执行：{{ disclosure.clientTools.map((t: any) => t.name).join("、") }}</p>
          <p v-if="disclosure.serverTools?.length">服务端工具：{{ disclosure.serverTools.map((t: any) => t.name).join("、") }}</p>
          <p class="assist-caps-muted">客户端动作只返回待执行动作，界面不会假装已经执行。</p>
        </div>

        <div v-if="routeResult" class="assist-caps-block" data-ai-route>
          <div class="assist-caps-label">能力路由</div>
          <p>模型 {{ routeResult.model?.providerId || "—" }} / {{ routeResult.model?.model || "—" }} · 工具 {{ routeResult.toolDescriptors?.length ?? 0 }}</p>
          <p v-if="routeResult.warnings?.length" class="assist-caps-warn">{{ routeResult.warnings.join("；") }}</p>
        </div>
        <p v-if="routeError" class="assist-err" role="alert" data-ai-route-error>{{ routeError }}</p>

        <input v-model="capFilter" class="assist-caps-filter" data-ai-caps-filter placeholder="筛选工具名 / 来源" aria-label="筛选 Agent 工具" />
        <ul v-if="toolRows.length" class="assist-tool-list">
          <li v-for="tool in toolRows" :key="tool.name" :data-ai-tool="tool.name" :data-ai-tool-status="tool.status" :data-ai-tool-source="tool.source">
            <span class="assist-tool-status" :data-s="tool.status">{{ tool.status }}</span>
            <span class="assist-tool-name">{{ tool.name }}</span>
            <span class="assist-tool-desc">{{ tool.title }} · {{ tool.statusText || tool.description }}</span>
          </li>
        </ul>
        <p v-else class="assist-caps-muted" data-ai-tools-empty>{{ catalog ? "没有符合条件的工具。" : "工具目录未返回。" }}</p>
      </div>

      <div v-if="taskId" class="assist-body">
        <div class="assist-card">
          <div class="assist-card-head">
            <strong class="assist-goal">{{ goal }}</strong>
            <span class="assist-status" :data-s="status" data-ai-status-text>{{ STATUS[status] || status }}</span>
          </div>
          <ol v-if="steps.length" class="assist-steps">
            <li v-for="s in steps" :key="s.stepId" :data-s="s.status">
              <component :is="stepIcon(s.status)" :size="13" :class="{ spin: !TERMINAL.includes(s.status) && s.status !== 'WAITING' }" />
              <span>{{ s.input?.goal || "执行任务" }}</span>
              <small>{{ STATUS[s.status] || s.status }}</small>
            </li>
          </ol>
          <div v-if="result" class="assist-result" data-ai-result>{{ result }}</div>

          <div v-if="status === 'BLOCKED' && resumable" class="assist-note" data-ai-resume-block>
            <span>预算用完暂停了（{{ stopReason || "BUDGET_EXHAUSTED" }}）。续接会再授权一份预算。</span>
            <button data-ai-resume :disabled="busy" @click="resume">续接任务</button>
          </div>
          <div v-if="recovery && recovery.calls && recovery.calls.length" class="assist-note warn" data-ai-recovery>
            <span>有操作结果未知：不会自动重试。核对实际情况后再确认。</span>
            <div v-for="c in recovery.calls" :key="c.callId" class="assist-call" :data-ai-recovery-call="c.callId">
              <small>{{ c.toolId }}{{ c.resourceRef ? " · " + c.resourceRef : "" }} · {{ c.status }}</small>
              <span v-if="c.acknowledged" data-ai-acknowledged>已人工确认</span>
              <button v-else data-ai-acknowledge @click="acknowledge(c.callId)">我已核查</button>
            </div>
          </div>
          <div v-if="verifications.some((v) => v.status === 'FAILED')" class="assist-note warn" data-ai-verification>
            <span data-ai-verification-fail>结果没通过验证，不算完成。</span>
          </div>
        </div>
        <div class="assist-foot">
          <span>与手动操作走同一套权限；写入、删除等操作都会先问你。</span>
          <button data-ai-capabilities @click="openCapabilities">{{ capOpen ? "收起能力" : "能力" }}</button>
          <button @click="toChat">在对话中打开</button>
          <button class="ghost" :disabled="running" @click="newTask">新任务</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.assist-chip-cap { color: var(--muted); }
.assist-caps { border-top: 0.5px solid rgb(var(--text-rgb) / 0.08); padding: 10px 16px 14px; max-height: 34vh; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
.assist-caps-head { display: flex; align-items: center; gap: 8px; }
.assist-caps-head strong { flex: 1; font-size: var(--fs-secondary); font-weight: var(--fw-medium); }
.assist-caps-head button, .assist-caps-actions button { padding: 3px 9px; border-radius: var(--radius-md); font-size: var(--fs-micro); background: rgb(var(--text-rgb) / 0.08); color: var(--text); }
.assist-caps-head button:disabled, .assist-caps-actions button:disabled { opacity: 0.45; }
.assist-caps-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.assist-caps-summary { display: flex; flex-wrap: wrap; gap: 6px; color: var(--muted); font-size: var(--fs-micro); }
.assist-source-count { padding: 0 6px; border-radius: 999px; background: rgb(var(--text-rgb) / 0.05); }
.assist-caps-block { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.05); font-size: var(--fs-caption); }
.assist-caps-block p { margin: 0; }
.assist-caps-label { color: var(--muted); font-size: var(--fs-micro); }
.assist-caps-muted { margin: 0; color: var(--muted); font-size: var(--fs-micro); }
.assist-caps-warn { color: var(--failed); }
.assist-caps-filter { width: 100%; box-sizing: border-box; padding: 6px 9px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.05); color: var(--text); font: inherit; font-size: var(--fs-caption); outline: none; }
.assist-caps-filter:focus { box-shadow: 0 0 0 2px var(--focus); }
.assist-tool-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.assist-tool-list li { display: grid; grid-template-columns: 52px minmax(90px, 0.5fr) minmax(0, 1fr); gap: 8px; align-items: baseline; font-size: var(--fs-micro); }
.assist-tool-status { color: var(--muted); }
.assist-tool-status[data-s="ready"] { color: var(--success-text, #1e7e34); }
.assist-tool-status[data-s="unavailable"], .assist-tool-status[data-s="disabled"] { color: var(--failed); }
.assist-tool-name { font-family: var(--font-mono); overflow-wrap: anywhere; }
.assist-tool-desc { color: var(--muted); overflow-wrap: anywhere; }
</style>
