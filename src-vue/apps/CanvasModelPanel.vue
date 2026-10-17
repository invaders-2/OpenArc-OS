<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Cpu, RefreshCw, Settings, X } from "lucide-vue-next";
import { useShellStore } from "../stores/shell";

/**
 * task-58：画布模型可用性面板（Vue 宿主 chrome，不改画布页/后端）。
 *
 * 所有事实来自 model 桥：canvas/models（可用模型 + defaultsState + transports）+ model/list（名称）。
 * 图像/视频分开显示默认模型与可用性；无默认、默认不可用、没有模型、传输未接通都给出结构化 code
 * 和“打开模型设置”修复入口。视频传输由后端决定（task-55 前 transports=false，界面如实写未接通）。
 */
const props = defineProps<{ panelKey?: string }>();
const shell = useShellStore();
const bridge = (window as any).openarc?.model;
const open = ref(false);
const loading = ref(false);
const error = ref("");
const data = ref<any>(null);
const listItems = ref<any[]>([]);
const labels = computed(() => {
  const out = new Map<string, string>();
  for (const m of listItems.value) out.set(String(m.configId), String(m.displayName || m.remoteModelId || m.configId));
  for (const m of Array.isArray(data.value?.models) ? data.value.models : []) if (!out.has(String(m.configId))) out.set(String(m.configId), String(m.displayName || m.remoteModelId || m.configId));
  return out;
});
const CAPS = [
  { id: "image", cap: "image-generation", label: "图像生成", short: "图像" },
  { id: "video", cap: "video-generation", label: "视频生成", short: "视频" },
] as const;
const REASON: Record<string, string> = {
  MODEL_NOT_FOUND: "默认模型已不存在",
  MODEL_DISABLED: "默认模型已停用",
  CAPABILITY_UNAVAILABLE: "默认模型不具备该能力",
  MODEL_UNAUTHORIZED: "当前身份无权使用默认模型",
  TRANSPORT_UNAVAILABLE: "后端未接通该能力的传输",
  NO_MODEL: "没有可用模型",
  NO_DEFAULT: "没有设置默认模型",
  NO_BRIDGE: "模型桥不可用",
};
function reasonText(code?: string | null) { return code ? (REASON[code] || code) : ""; }
function modelsOf(cap: string): any[] {
  return (Array.isArray(data.value?.models) ? data.value.models : []).filter((m: any) => Array.isArray(m.capabilities) && m.capabilities.includes(cap));
}
function info(cap: string) {
  const models = modelsOf(cap);
  const def = data.value?.defaultsState?.[cap] || {};
  const transport = data.value?.transports?.[cap];
  const defaultLabel = def.configId ? (labels.value.get(String(def.configId)) || String(def.configId)) : "";
  let code = "";
  let text = "";
  let fix = false;
  if (!bridge) { code = "NO_BRIDGE"; text = "模型桥不可用"; }
  else if (transport === false) { code = "TRANSPORT_UNAVAILABLE"; text = "传输未接通（后端能力未就绪）"; }
  else if (!models.length) { code = "NO_MODEL"; text = "没有可用模型"; fix = true; }
  else if (def.configId && def.usable === false) { code = def.reason || "MODEL_UNAVAILABLE"; text = reasonText(code); fix = true; }
  else if (!def.configId) { code = "NO_DEFAULT"; text = "未设置默认模型"; fix = true; }
  else { code = ""; text = "默认可用"; }
  return { models, def, transport, defaultLabel, code, text, fix };
}
const rows = computed(() => CAPS.map((item) => ({ ...item, ...info(item.cap) })));

async function load() {
  if (!bridge) { error.value = "模型桥不可用：只能在 OpenArc 桌面应用里查看。"; return; }
  loading.value = true;
  error.value = "";
  try {
    const [used, list] = await Promise.all([
      bridge.command({ command: "canvas/models" }).catch(() => null),
      bridge.command({ command: "model/list" }).catch(() => null),
    ]);
    if (used?.ok === false) error.value = used.error || "MODEL_UNAVAILABLE";
    else data.value = used;
    listItems.value = Array.isArray(list?.items) ? list.items : [];
    if (!used || used.ok !== true) error.value = String(used?.error || "MODEL_UNAVAILABLE");
  } finally {
    loading.value = false;
  }
}
function toggle() {
  open.value = !open.value;
  if (open.value && !data.value) void load();
}
function openModelSettings() {
  shell.requestModelSettings();
  shell.activateApp("settings");
  open.value = false;
}
onMounted(() => { void load(); });
</script>

<template>
  <div class="canvas-model-host" :data-canvas-model-host="props.panelKey || 'canvas'">
    <button
      v-if="!open"
      type="button"
      class="canvas-model-trigger"
      data-canvas-model-trigger
      :aria-expanded="open"
      aria-label="画布模型可用性"
      @click="toggle"
    >
      <Cpu :size="13" />
      <span>模型</span>
      <i v-for="row in rows" :key="row.id" class="canvas-model-dot" :data-s="row.code ? 'bad' : 'ok'" :title="row.label + '：' + row.text" />
    </button>

    <section v-else class="canvas-model-panel" data-canvas-model-panel aria-label="画布模型可用性">
      <header class="canvas-model-head">
        <Cpu :size="14" />
        <strong>画布模型</strong>
        <button type="button" class="canvas-model-icon" data-canvas-model-refresh aria-label="刷新模型状态" :disabled="loading" @click="load"><RefreshCw :size="12" :class="{ spin: loading }" /></button>
        <button type="button" class="canvas-model-icon" data-canvas-model-close aria-label="关闭模型面板" @click="open = false"><X :size="13" /></button>
      </header>
      <p v-if="error" class="canvas-model-error" role="alert" data-canvas-model-error>{{ error }}</p>
      <div v-for="row in rows" :key="row.id" class="canvas-model-row" :data-canvas-model-row="row.id" :data-canvas-model-status="row.code || 'ok'" :data-canvas-model-code="row.code">
        <div class="canvas-model-row-head">
          <span class="canvas-model-cap">{{ row.label }}</span>
          <span class="canvas-model-state" :data-s="row.code ? 'bad' : 'ok'">{{ row.text }}</span>
        </div>
        <p class="canvas-model-default" :data-canvas-model-default="row.id">
          默认模型：{{ row.defaultLabel || "未设置" }}
          <span v-if="row.def.usable === true">· 可用</span>
        </p>
        <p class="canvas-model-models" :data-canvas-model-list="row.id">
          {{ row.models.length ? "可用模型：" + row.models.map((m) => m.displayName || m.remoteModelId).join("、") : "可用模型：无" }}
        </p>
        <p v-if="row.transport === false" class="canvas-model-transport" :data-canvas-model-transport="row.id">
          视频传输由后端提供；当前 transport=false，生成按钮会按不可用处理（等待 task-55 接通）。
        </p>
        <button v-if="row.fix" type="button" class="canvas-model-fix" :data-canvas-model-fix="row.id" @click="openModelSettings">
          <Settings :size="12" /> 打开模型设置修复
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.canvas-model-host { position: absolute; left: 18px; bottom: 18px; z-index: 8; }
.canvas-model-trigger { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 11px; border-radius: 999px; background: rgb(var(--surface-rgb) / 0.86); backdrop-filter: blur(18px); box-shadow: 0 2px 10px rgb(0 0 0 / 0.12), inset 0 0 0 0.5px rgb(var(--text-rgb) / 0.12); color: var(--text); font-size: var(--fs-caption); }
.canvas-model-trigger:hover { background: rgb(var(--surface-rgb) / 0.96); }
.canvas-model-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); opacity: 0.5; }
.canvas-model-dot[data-s="ok"] { background: var(--success, #34c759); opacity: 1; }
.canvas-model-dot[data-s="bad"] { background: var(--failed); opacity: 1; }
.canvas-model-panel { width: 340px; padding: 12px; border-radius: 16px; display: flex; flex-direction: column; gap: 9px; background: rgb(var(--surface-rgb) / 0.94); backdrop-filter: blur(28px) saturate(1.5); box-shadow: 0 18px 50px rgb(0 0 0 / 0.2), inset 0 0 0 0.5px rgb(var(--text-rgb) / 0.12); }
.canvas-model-head { display: flex; align-items: center; gap: 7px; font-size: var(--fs-secondary); }
.canvas-model-head strong { flex: 1; font-weight: var(--fw-medium); }
.canvas-model-icon { width: 22px; height: 22px; padding: 0; border-radius: 6px; display: grid; place-items: center; color: var(--muted); background: transparent; }
.canvas-model-icon:hover { color: var(--text); background: var(--row-hover); }
.canvas-model-error { margin: 0; color: var(--failed); font-size: var(--fs-caption); }
.canvas-model-row { display: flex; flex-direction: column; gap: 3px; padding: 9px 10px; border-radius: 10px; background: rgb(var(--text-rgb) / 0.05); }
.canvas-model-row-head { display: flex; align-items: baseline; gap: 8px; }
.canvas-model-cap { font-weight: var(--fw-medium); font-size: var(--fs-caption); }
.canvas-model-state { margin-left: auto; color: var(--muted); font-size: var(--fs-micro); }
.canvas-model-state[data-s="bad"] { color: var(--failed); }
.canvas-model-default, .canvas-model-models, .canvas-model-transport { margin: 0; color: var(--muted); font-size: var(--fs-micro); line-height: 1.4; overflow-wrap: anywhere; }
.canvas-model-transport { color: var(--failed); }
.canvas-model-fix { align-self: flex-start; margin-top: 3px; display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 7px; background: rgb(var(--text-rgb) / 0.08); color: var(--text); font-size: var(--fs-micro); }
.canvas-model-fix:hover { background: rgb(var(--text-rgb) / 0.13); }
.spin { animation: canvas-model-spin 1s linear infinite; }
@keyframes canvas-model-spin { to { transform: rotate(360deg); } }
.desktop.reduced .spin { animation: none; }
</style>
