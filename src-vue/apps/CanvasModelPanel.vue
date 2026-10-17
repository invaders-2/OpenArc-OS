<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Cpu, RefreshCw, RotateCcw, Save, Settings, X } from "lucide-vue-next";
import { useShellStore } from "../stores/shell";

/**
 * task-62：画布全局供应商 + 模型选择（只改 src-vue 宿主面板）。
 *
 * 事实源仍是 model 桥：canvas/models（可用模型 + defaultsState + transports）+ model/list（名称）。
 * 按画布节点类型分三组过滤：文本=chat、图片=image-generation、视频=video-generation；
 * 选择供应商 + 模型后写 model/defaults/set(capability, configId, scope=PERSONAL)，
 * 刷新面板并从后端重新读回；应用后重载画布帧，使画布页重新拉 /api/config 看到新默认。
 * 视频传输由后端决定（当前 transports=false，界面如实提示，不把“设置了默认”说成“视频已可用”）。
 */
const props = defineProps<{ panelKey?: string }>();
const shell = useShellStore();
const bridge = (window as any).openarc?.model;
const rootEl = ref<HTMLElement | null>(null);
const open = ref(false);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const saveStatus = ref("");
const data = ref<any>(null);
const listItems = ref<any[]>([]);
const picks = ref<Record<string, { providerId: string; configId: string }>>({});
const CAPS = [
  { id: "chat", cap: "chat", label: "文本节点", short: "文本" },
  { id: "image", cap: "image-generation", label: "图片节点", short: "图片" },
  { id: "video", cap: "video-generation", label: "视频节点", short: "视频" },
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
const labels = computed(() => {
  const out = new Map<string, string>();
  for (const m of listItems.value) out.set(String(m.configId), String(m.displayName || m.remoteModelId || m.configId));
  for (const m of Array.isArray(data.value?.models) ? data.value.models : []) if (!out.has(String(m.configId))) out.set(String(m.configId), String(m.displayName || m.remoteModelId || m.configId));
  return out;
});
function modelsOf(cap: string): any[] {
  return (Array.isArray(data.value?.models) ? data.value.models : []).filter((m: any) => Array.isArray(m.capabilities) && m.capabilities.includes(cap));
}
function providersOf(cap: string): { id: string; name: string; models: any[] }[] {
  const map = new Map<string, { id: string; name: string; models: any[] }>();
  for (const m of modelsOf(cap)) {
    const id = String(m.providerId || "unknown");
    if (!map.has(id)) map.set(id, { id, name: String(m.providerName || id), models: [] });
    map.get(id)!.models.push(m);
  }
  return [...map.values()];
}
function modelsUnder(cap: string, providerId: string): any[] {
  return providersOf(cap).find((p) => p.id === providerId)?.models || [];
}
function info(cap: string) {
  const models = modelsOf(cap);
  const def = data.value?.defaultsState?.[cap] || {};
  const transport = data.value?.transports?.[cap];
  let code = "";
  let text = "";
  if (!bridge) { code = "NO_BRIDGE"; text = "模型桥不可用"; }
  else if (transport === false) { code = "TRANSPORT_UNAVAILABLE"; text = "传输未接通（后端能力未就绪）"; }
  else if (!models.length) { code = "NO_MODEL"; text = "没有可用模型"; }
  else if (def.configId && def.usable === false) { code = def.reason || "MODEL_UNAVAILABLE"; text = reasonText(code); }
  else if (!def.configId) { code = "NO_DEFAULT"; text = "未设置默认模型"; }
  else { code = ""; text = "默认可用"; }
  return { models, def, transport, code, text, defaultLabel: def.configId ? (labels.value.get(String(def.configId)) || String(def.configId)) : "" };
}
const rows = computed(() => CAPS.map((item) => ({ ...item, ...info(item.cap) })));
function pickOf(cap: string) { return picks.value[cap] || { providerId: "", configId: "" }; }
function syncPicks() {
  const next: Record<string, { providerId: string; configId: string }> = {};
  for (const item of CAPS) {
    const models = modelsOf(item.cap);
    const defId = String(data.value?.defaultsState?.[item.cap]?.configId || "");
    const current = models.find((m: any) => String(m.configId) === defId) || models[0];
    next[item.cap] = {
      providerId: current ? String(current.providerId || "") : "",
      configId: current ? String(current.configId) : "",
    };
  }
  picks.value = next;
}
function setProvider(cap: string, providerId: string) {
  const first = modelsUnder(cap, providerId)[0];
  picks.value = { ...picks.value, [cap]: { providerId, configId: first ? String(first.configId) : "" } };
  saveStatus.value = "";
}
function setModel(cap: string, configId: string) {
  picks.value = { ...picks.value, [cap]: { ...pickOf(cap), configId } };
  saveStatus.value = "";
}
function dirty(cap: string): boolean {
  const chosen = pickOf(cap).configId;
  return !!chosen && chosen !== String(data.value?.defaultsState?.[cap]?.configId || "");
}
async function load() {
  if (!bridge) { error.value = "模型桥不可用：只能在 OpenArc 桌面应用里查看。"; return; }
  loading.value = true;
  error.value = "";
  try {
    const [used, list] = await Promise.all([
      bridge.command({ command: "canvas/models" }).catch(() => null),
      bridge.command({ command: "model/list" }).catch(() => null),
    ]);
    if (used?.ok === false) { error.value = String(used.error || "MODEL_UNAVAILABLE"); data.value = null; }
    else { data.value = used; syncPicks(); }
    listItems.value = Array.isArray(list?.items) ? list.items : [];
  } finally {
    loading.value = false;
  }
}
async function applyAll() {
  if (!bridge || saving.value) return;
  const targets = CAPS.filter((item) => dirty(item.cap));
  if (!targets.length) { saveStatus.value = "没有需要应用的更改。"; return; }
  saving.value = true;
  error.value = "";
  saveStatus.value = "";
  const applied: string[] = [];
  try {
    for (const item of targets) {
      const configId = pickOf(item.cap).configId;
      if (!configId) continue;
      const res = await bridge.command({ command: "defaults/set", payload: { capability: item.cap, configId, scope: "PERSONAL" } }).catch(() => null);
      if (!res?.ok) { error.value = item.short + "默认写入失败：" + String(res?.error || "UNKNOWN"); return; }
      applied.push(item.short);
    }
    await load();
    saveStatus.value = applied.length ? "已应用：" + applied.join("、") + "（PERSONAL 全局默认）" : "没有需要应用的更改。";
    if (applied.length) reloadCanvasFrame();
  } finally {
    saving.value = false;
  }
}
function resetAll() {
  syncPicks();
  saveStatus.value = "已恢复为后端当前默认。";
  error.value = "";
}
/** 应用后让画布帧重新拉 /api/config；不重建 React 宿主、不丢掉当前画布页 URL。 */
function reloadCanvasFrame() {
  const frame = rootEl.value?.closest("section.window")?.querySelector<HTMLIFrameElement>("[data-canvas-frame]");
  if (!frame) return;
  const src = frame.getAttribute("src");
  if (!src) return;
  try {
    // 保留画布 URL（含 canvasId / #oa 片段），只加一个一次性的查询键迫使 frame 重新拉 /api/config。
    const url = new URL(src);
    url.searchParams.set("oa_model_rev", String(Date.now()));
    frame.src = url.toString();
  } catch {
    frame.src = src;
  }
}
function openModelSettings() {
  shell.requestModelSettings();
  shell.activateApp("settings");
  open.value = false;
}
function toggle() {
  open.value = !open.value;
  if (open.value && !data.value) void load();
}
onMounted(() => { void load(); });
</script>

<template>
  <div ref="rootEl" class="canvas-model-host" :data-canvas-model-host="props.panelKey || 'canvas'">
    <button v-if="!open" type="button" class="canvas-model-trigger" data-canvas-model-trigger :aria-expanded="open" aria-label="画布模型可用性" @click="toggle">
      <Cpu :size="13" /><span>模型</span>
      <i v-for="row in rows" :key="row.id" class="canvas-model-dot" :data-s="row.code ? 'bad' : 'ok'" :title="row.label + '：' + row.text" />
    </button>

    <section v-else class="canvas-model-panel" data-canvas-model-panel aria-label="画布模型可用性">
      <header class="canvas-model-head">
        <Cpu :size="14" /><strong>画布模型</strong>
        <button type="button" class="canvas-model-icon" data-canvas-model-refresh aria-label="刷新模型状态" :disabled="loading" @click="load"><RefreshCw :size="12" :class="{ spin: loading }" /></button>
        <button type="button" class="canvas-model-icon" data-canvas-model-close aria-label="关闭模型面板" @click="open = false"><X :size="13" /></button>
      </header>
      <p class="canvas-model-global" data-canvas-model-scope>全局默认（PERSONAL）· 应用于所有画布节点</p>
      <p v-if="error" class="canvas-model-error" role="alert" data-canvas-model-error>{{ error }}</p>
      <p v-if="saveStatus" class="canvas-model-saved" role="status" data-canvas-model-save-status>{{ saveStatus }}</p>

      <div v-for="row in rows" :key="row.id" class="canvas-model-row" :data-canvas-model-row="row.id" :data-canvas-model-status="row.code || 'ok'" :data-canvas-model-code="row.code">
        <div class="canvas-model-row-head">
          <span class="canvas-model-cap">{{ row.label }}</span>
          <span class="canvas-model-state" :data-s="row.code ? 'bad' : 'ok'">{{ row.text }}</span>
        </div>
        <p class="canvas-model-default" :data-canvas-model-default="row.id">当前默认：{{ row.defaultLabel || "未设置" }}<span v-if="row.def.usable === true"> · 可用</span></p>

        <div v-if="row.models.length" class="canvas-model-picks">
          <label>
            <span>供应商</span>
            <select :data-canvas-model-provider="row.id" :value="pickOf(row.cap).providerId" @change="setProvider(row.cap, ($event.target as HTMLSelectElement).value)">
              <option v-for="p in providersOf(row.cap)" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </label>
          <label>
            <span>模型</span>
            <select :data-canvas-model-select="row.id" :value="pickOf(row.cap).configId" @change="setModel(row.cap, ($event.target as HTMLSelectElement).value)">
              <option v-for="m in modelsUnder(row.cap, pickOf(row.cap).providerId)" :key="m.configId" :value="m.configId">{{ m.displayName || m.remoteModelId }}</option>
            </select>
          </label>
        </div>
        <p v-else class="canvas-model-models" :data-canvas-model-list="row.id">可用模型：无</p>

        <p v-if="row.transport === false" class="canvas-model-transport" :data-canvas-model-transport="row.id">该能力的传输由后端提供；当前 transport=false，即使设置默认也还不能生成（视频等待 task-55）。</p>
        <div class="canvas-model-row-actions">
          <button v-if="row.code === 'NO_MODEL' || row.code === 'CAPABILITY_UNAVAILABLE' || row.code === 'MODEL_DISABLED' || row.code === 'NO_DEFAULT'" type="button" class="canvas-model-fix" :data-canvas-model-fix="row.id" @click="openModelSettings">
            <Settings :size="12" /> 打开模型设置修复
          </button>
        </div>
      </div>
      <footer class="canvas-model-footer">
        <button type="button" class="canvas-model-apply" data-canvas-model-apply :disabled="saving || !CAPS.some((item) => dirty(item.cap))" @click="applyAll"><Save :size="11" /> 应用更改</button>
        <button type="button" class="canvas-model-reset" data-canvas-model-reset :disabled="saving" @click="resetAll"><RotateCcw :size="11" /> 撤销更改</button>
        <span class="canvas-model-foot-note">写入 PERSONAL 全局默认</span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.canvas-model-host { position: absolute; left: 18px; bottom: 18px; z-index: 8; max-width: min(380px, calc(100% - 36px)); }
.canvas-model-trigger { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 11px; border-radius: 999px; background: rgb(var(--surface-rgb) / 0.86); backdrop-filter: blur(18px); box-shadow: 0 2px 10px rgb(0 0 0 / 0.12), inset 0 0 0 0.5px rgb(var(--text-rgb) / 0.12); color: var(--text); font-size: var(--fs-caption); }
.canvas-model-trigger:hover { background: rgb(var(--surface-rgb) / 0.96); }
.canvas-model-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); opacity: 0.5; }
.canvas-model-dot[data-s="ok"] { background: var(--success, #34c759); opacity: 1; }
.canvas-model-dot[data-s="bad"] { background: var(--failed); opacity: 1; }
.canvas-model-panel { max-height: min(620px, calc(100vh - 150px)); overflow: auto; width: 370px; max-width: 100%; padding: 12px; border-radius: 16px; display: flex; flex-direction: column; gap: 9px; background: rgb(var(--surface-rgb) / 0.95); backdrop-filter: blur(28px) saturate(1.5); box-shadow: 0 18px 50px rgb(0 0 0 / 0.2), inset 0 0 0 0.5px rgb(var(--text-rgb) / 0.12); }
.canvas-model-head { display: flex; align-items: center; gap: 7px; font-size: var(--fs-secondary); }
.canvas-model-head strong { flex: 1; font-weight: var(--fw-medium); }
.canvas-model-global { margin: -3px 0 1px; color: var(--muted); font-size: var(--fs-micro); }
.canvas-model-icon { width: 22px; height: 22px; padding: 0; border-radius: 6px; display: grid; place-items: center; color: var(--muted); background: transparent; }
.canvas-model-icon:hover { color: var(--text); background: var(--row-hover); }
.canvas-model-error { margin: 0; color: var(--failed); font-size: var(--fs-caption); }
.canvas-model-saved { margin: 0; color: var(--success-text, #1e7e34); font-size: var(--fs-caption); }
.canvas-model-row { display: flex; flex-direction: column; gap: 5px; padding: 9px 10px; border-radius: 10px; background: rgb(var(--text-rgb) / 0.05); }
.canvas-model-row-head { display: flex; align-items: baseline; gap: 8px; }
.canvas-model-cap { font-weight: var(--fw-medium); font-size: var(--fs-caption); }
.canvas-model-state { margin-left: auto; color: var(--muted); font-size: var(--fs-micro); }
.canvas-model-state[data-s="bad"] { color: var(--failed); }
.canvas-model-default, .canvas-model-models, .canvas-model-transport { margin: 0; color: var(--muted); font-size: var(--fs-micro); line-height: 1.4; overflow-wrap: anywhere; }
.canvas-model-transport { color: var(--failed); }
.canvas-model-picks { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.canvas-model-picks label { display: flex; flex-direction: column; gap: 2px; min-width: 0; color: var(--muted); font-size: var(--fs-micro); }
.canvas-model-picks select { width: 100%; min-width: 0; padding: 4px 6px; border-radius: 6px; background: rgb(var(--text-rgb) / 0.07); color: var(--text); font: inherit; font-size: var(--fs-caption); }
.canvas-model-row-actions { display: flex; flex-wrap: wrap; gap: 5px; }
.canvas-model-apply, .canvas-model-reset, .canvas-model-footer { display: flex; align-items: center; gap: 6px; padding-top: 4px; border-top: 0.5px solid var(--line); }
.canvas-model-foot-note { margin-left: auto; color: var(--muted); font-size: var(--fs-micro); }
.canvas-model-fix { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 7px; background: rgb(var(--text-rgb) / 0.08); color: var(--text); font-size: var(--fs-micro); }
.canvas-model-apply { background: rgb(var(--text-rgb) / 0.14); }
.canvas-model-apply:disabled, .canvas-model-reset:disabled { opacity: 0.4; }
.canvas-model-fix { background: transparent; color: var(--muted); text-decoration: underline; text-underline-offset: 2px; }
.spin { animation: canvas-model-spin 1s linear infinite; }
@keyframes canvas-model-spin { to { transform: rotate(360deg); } }
.desktop.reduced .spin { animation: none; }
</style>
