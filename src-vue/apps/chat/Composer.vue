<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowUp, AtSign, Check, Plus, ChevronDown, FileText, Film, Image as ImageIcon, LayoutGrid, Mic, Paperclip, Plug, Slash, Sparkles, Square, Terminal, X } from "lucide-vue-next";
import { APPS } from "../../apps";
import { useShellStore } from "../../stores/shell";
import { openWorkspace, sizeText } from "./preview";
import type { ChatFile, ModelOpt, Pick, SendPayload } from "./types";

/**
 * 对话输入区（对齐 Claude / ChatGPT / Cursor）：
 *   · 附件：按钮 / 拖拽 / 粘贴（图片、视频、文档都行），存进 AI 工作文件夹 uploads/，AI 用 workspace_read 读；
 *   · @：引用本对话附件或工作文件夹里的文件；
 *   · /：命令、技能、MCP 工具、打开应用；
 *   · 模型切换（新对话生效，进行中的对话固定用开始时的模型）；
 *   · 上下文用量圆环；
 *   · 语音输入（按钮在 voice 插槽，由宿主决定是否可用）。
 */
const props = defineProps<{
  modelValue: string;
  disabled?: boolean;
  running?: boolean;
  placeholder?: string;
  models: ModelOpt[];
  selectedModelId: string;
  /** 当前对话绑定的模型（进行中的对话不能换） */
  lockedModelId?: string | null;
  usage?: { used: number; size: number | null } | null;
  modelCalls?: number;
  voice?: { available: boolean; recording: boolean; busy: boolean; hint: string } | null;
}>();
const emit = defineEmits<{
  (e: "update:modelValue", v: string): void;
  (e: "update:selectedModelId", v: string): void;
  (e: "send", p: SendPayload): void;
  (e: "stop"): void;
  (e: "command", name: string): void;
  (e: "voice"): void;
}>();

const chat = () => (window as any).openarc?.chat as { command: (c: Record<string, unknown>) => Promise<any> } | undefined;
const skillBridge = () => (window as any).openarc?.skill as { command: (c: Record<string, unknown>) => Promise<any> } | undefined;
const mcpBridge = () => (window as any).openarc?.mcp as { command: (c: Record<string, unknown>) => Promise<any> } | undefined;

const ta = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const files = ref<ChatFile[]>([]);
const picks = ref<Pick[]>([]);
const dragging = ref(false);
const notice = ref("");
let noticeTimer = 0;
function say(msg: string) { notice.value = msg; window.clearTimeout(noticeTimer); noticeTimer = window.setTimeout(() => { notice.value = ""; }, 2600); }

const text = computed({ get: () => props.modelValue, set: (v: string) => emit("update:modelValue", v) });
function autosize() { const el = ta.value; if (!el) return; el.style.height = "auto"; el.style.height = Math.min(240, el.scrollHeight) + "px"; }
watch(() => props.modelValue, () => nextTick(autosize));

/* ---------- 附件 ---------- */
const MAX_FILE = 100 * 1024 * 1024;
const kindOf = (name: string, mime = "") => {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (mime.startsWith("image/") || /^(png|jpe?g|gif|webp|bmp|svg|avif)$/.test(ext)) return "image";
  if (mime.startsWith("video/") || /^(mp4|m4v|webm|mov)$/.test(ext)) return "video";
  if (mime.startsWith("audio/") || /^(mp3|wav|m4a|ogg|flac)$/.test(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return "doc";
};
async function addFiles(list: FileList | File[]) {
  const b = chat();
  if (!b) { say("附件只在 OpenArc 桌面应用里可用。"); return; }
  for (const f of Array.from(list).slice(0, 10)) {
    const name = f.name || (f.type.startsWith("image/") ? "粘贴的图片." + (f.type.split("/")[1] || "png") : "附件");
    const item: ChatFile = { path: "", name, size: f.size, mime: f.type, kind: kindOf(name, f.type), state: "uploading" };
    if (item.kind === "image" || item.kind === "video") { try { item.localUrl = URL.createObjectURL(f); } catch { /* ignore */ } }
    files.value = [...files.value, item];
    const idx = files.value.length - 1;
    const patch = (next: Partial<ChatFile>) => { files.value = files.value.map((x, i) => (i === idx ? { ...x, ...next } : x)); };
    if (f.size > MAX_FILE) { patch({ state: "failed", error: "超过 100 MB" }); continue; }
    try {
      const data = new Uint8Array(await f.arrayBuffer());
      const r = await b.command({ command: "upload/add", name, data });
      if (r?.ok) patch({ ...r.file, state: "ready", localUrl: item.localUrl });
      else patch({ state: "failed", error: r?.error === "UPLOAD_TOO_LARGE" ? "超过 100 MB" : "上传失败" });
    } catch { patch({ state: "failed", error: "上传失败" }); }
  }
}
function removeFile(i: number) { const f = files.value[i]; if (f?.localUrl) { try { URL.revokeObjectURL(f.localUrl); } catch { /* ignore */ } } files.value = files.value.filter((_, j) => j !== i); }
function onPick(e: Event) { const input = e.target as HTMLInputElement; if (input.files?.length) void addFiles(input.files); input.value = ""; }
function onDrop(e: DragEvent) { dragging.value = false; if (e.dataTransfer?.files?.length) { e.preventDefault(); void addFiles(e.dataTransfer.files); } }
function onDragOver(e: DragEvent) { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); dragging.value = true; } }
function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.files;
  if (items && items.length) { e.preventDefault(); void addFiles(items); }
}
const uploading = computed(() => files.value.some((f) => f.state === "uploading"));

/* ---------- @ 与 / 弹出菜单 ---------- */
type MenuItem = { key: string; group: string; label: string; sub?: string; icon: any; run: () => void };
const menu = ref<{ type: "at" | "slash"; query: string; start: number } | null>(null);
const menuIndex = ref(0);
const wsFiles = ref<{ path: string; name: string; size: number; kind: string }[]>([]);
const skills = ref<{ id: string; name: string; description?: string }[]>([]);
const mcps = ref<{ id: string; name: string }[]>([]);
let wsTimer = 0;

function detectMenu() {
  const el = ta.value; if (!el) { menu.value = null; return; }
  const pos = el.selectionStart ?? text.value.length;
  const before = text.value.slice(0, pos);
  const at = /(^|\s)@([^\s@]{0,60})$/.exec(before);
  if (at) { openMenu("at", at[2], pos - at[2].length - 1); return; }
  const slash = /^\/([^\s/]{0,40})$/.exec(before);
  if (slash) { openMenu("slash", slash[1], 0); return; }
  menu.value = null;
}
function openMenu(type: "at" | "slash", query: string, start: number) {
  const changed = !menu.value || menu.value.type !== type || menu.value.query !== query;
  menu.value = { type, query, start };
  if (changed) menuIndex.value = 0;
  if (type === "at") { window.clearTimeout(wsTimer); wsTimer = window.setTimeout(() => void loadWorkspace(query), 120); }
  if (type === "slash" && !skills.value.length && !mcps.value.length) void loadSlashSources();
}
async function loadWorkspace(query: string) {
  const r = await chat()?.command({ command: "workspace/files", query, limit: 30 }).catch(() => null);
  wsFiles.value = Array.isArray(r?.items) ? r.items : [];
}
let slashLoaded = false;
async function loadSlashSources() {
  if (slashLoaded) return; slashLoaded = true;
  const [s, m] = await Promise.all([
    skillBridge()?.command({ command: "skill/list", payload: {} }).catch(() => null),
    mcpBridge()?.command({ command: "mcp/list", payload: {} }).catch(() => null),
  ]);
  const sv = s && (s.value && typeof s.value === "object" ? s.value : s);
  const sItems = Array.isArray(sv?.items) ? sv.items : Array.isArray(sv?.skills) ? sv.skills : [];
  skills.value = sItems.filter((x: any) => x && x.id && x.enabled !== false).map((x: any) => ({ id: String(x.id), name: String(x.name || x.id), description: String(x.description || "") }));
  const mItems = Array.isArray(m?.items) ? m.items : Array.isArray(m?.connections) ? m.connections : [];
  mcps.value = mItems.filter((x: any) => x && x.connectionId).map((x: any) => ({ id: String(x.connectionId), name: String(x.displayName || x.name || x.serverName || x.connectionId) }));
}
const FILE_ICON: Record<string, any> = { image: ImageIcon, video: Film, audio: Film, pdf: FileText, doc: FileText, code: FileText, markdown: FileText, text: FileText, csv: FileText, html: FileText, file: FileText };
const COMMANDS = [
  { id: "new", label: "新对话", sub: "开始一段新对话" },
  { id: "model", label: "切换模型", sub: "选这段对话用哪个模型" },
  { id: "attach", label: "上传附件", sub: "选择文件、图片或视频" },
  { id: "files", label: "工作文件夹", sub: "浏览 AI 工作文件夹里的文件" },
  { id: "resource", label: "引用资源", sub: "从资源库选一个资源" },
  { id: "clear", label: "清空输入", sub: "清掉输入框、附件和已选技能" },
];
const menuItems = computed<MenuItem[]>(() => {
  const m = menu.value; if (!m) return [];
  const q = m.query.toLowerCase();
  const hit = (...xs: (string | undefined)[]) => !q || xs.some((x) => String(x || "").toLowerCase().includes(q));
  const out: MenuItem[] = [];
  if (m.type === "at") {
    for (const f of files.value.filter((f) => f.state === "ready" && hit(f.name, f.path))) out.push({ key: "a:" + f.path, group: "本条消息的附件", label: f.name, sub: f.path, icon: FILE_ICON[f.kind] || FileText, run: () => insertMention(f.path) });
    for (const f of wsFiles.value) {
      if (out.some((x) => x.key === "a:" + f.path)) continue;
      out.push({ key: "w:" + f.path, group: "工作文件夹", label: f.name, sub: f.path + " · " + sizeText(f.size), icon: FILE_ICON[f.kind] || FileText, run: () => { insertMention(f.path); addRef(f); } });
    }
    return out.slice(0, 40);
  }
  for (const c of COMMANDS) if (hit(c.label, c.id, c.sub)) out.push({ key: "c:" + c.id, group: "命令", label: "/" + c.id + "  " + c.label, sub: c.sub, icon: Terminal, run: () => runCommand(c.id) });
  for (const s of skills.value) if (hit(s.name, s.id, s.description)) out.push({ key: "s:" + s.id, group: "技能", label: s.name, sub: s.description || s.id, icon: Sparkles, run: () => addPick({ kind: "skill", id: s.id, name: s.name }) });
  for (const c of mcps.value) if (hit(c.name, c.id)) out.push({ key: "m:" + c.id, group: "MCP 工具", label: c.name, sub: "让 AI 用这个 MCP 服务的工具（每次调用都要你批准）", icon: Plug, run: () => addPick({ kind: "mcp", id: c.id, name: c.name }) });
  for (const a of APPS.filter((x) => x.id !== "chat" && x.id !== "home")) if (hit(a.name, a.id)) out.push({ key: "p:" + a.id, group: "打开应用", label: a.name, icon: LayoutGrid, run: () => { clearTrigger(); useShellStore().activateApp(a.id); } });
  return out.slice(0, 60);
});
const groupedMenu = computed(() => {
  const groups: { name: string; items: (MenuItem & { index: number })[] }[] = [];
  menuItems.value.forEach((it, index) => {
    let g = groups.find((x) => x.name === it.group);
    if (!g) { g = { name: it.group, items: [] }; groups.push(g); }
    g.items.push({ ...it, index });
  });
  return groups;
});
function clearTrigger() {
  const m = menu.value; if (!m) return;
  const el = ta.value; const pos = el?.selectionStart ?? text.value.length;
  text.value = text.value.slice(0, m.start) + text.value.slice(pos);
  menu.value = null;
  nextTick(() => { el?.focus(); el?.setSelectionRange(m.start, m.start); });
}
function insertMention(path: string) {
  const m = menu.value; if (!m) return;
  const el = ta.value; const pos = el?.selectionStart ?? text.value.length;
  const ins = "@" + path + " ";
  text.value = text.value.slice(0, m.start) + ins + text.value.slice(pos);
  menu.value = null;
  const caret = m.start + ins.length;
  nextTick(() => { el?.focus(); el?.setSelectionRange(caret, caret); });
}
function addRef(f: { path: string; name: string; size: number; kind: string }) {
  if (files.value.some((x) => x.path === f.path)) return;
  files.value = [...files.value, { path: f.path, name: f.name, size: f.size, kind: f.kind, state: "ready", ref: true }];
}
function addPick(p: Pick) { clearTrigger(); if (!picks.value.some((x) => x.kind === p.kind && x.id === p.id)) picks.value = [...picks.value, p]; }
const modelOpen = ref(false);
/** 「+」菜单：附件 / 引用文件 / 命令与技能（对标 ChatGPT、Claude 的输入框，左下只留一个入口）。 */
const plusOpen = ref(false);
function runCommand(id: string) {
  clearTrigger();
  if (id === "attach") fileInput.value?.click();
  else if (id === "model") modelOpen.value = true;
  else if (id === "clear") { text.value = ""; files.value = []; picks.value = []; }
  else if (id === "files") { text.value = "@"; nextTick(() => { ta.value?.focus(); ta.value?.setSelectionRange(1, 1); detectMenu(); }); }
  else emit("command", id);
}
function onKey(e: KeyboardEvent) {
  if (menu.value && menuItems.value.length) {
    if (e.key === "ArrowDown") { e.preventDefault(); menuIndex.value = (menuIndex.value + 1) % menuItems.value.length; scrollMenu(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); menuIndex.value = (menuIndex.value - 1 + menuItems.value.length) % menuItems.value.length; scrollMenu(); return; }
    if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) { e.preventDefault(); menuItems.value[menuIndex.value]?.run(); return; }
  }
  if (e.key === "Escape" && menu.value) { e.preventDefault(); menu.value = null; return; }
  if (e.key === "Backspace" && !text.value && (picks.value.length || files.value.length) && (ta.value?.selectionStart ?? 0) === 0) {
    if (picks.value.length) picks.value = picks.value.slice(0, -1);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
}
const menuEl = ref<HTMLElement | null>(null);
function scrollMenu() { nextTick(() => menuEl.value?.querySelector('[data-active="1"]')?.scrollIntoView({ block: "nearest" })); }

/* ---------- 模型 ---------- */
const locked = computed(() => !!props.lockedModelId);
const shownModelId = computed(() => props.lockedModelId || props.selectedModelId);
const modelName = computed(() => props.models.find((m) => m.configId === shownModelId.value)?.displayName || (props.models.length ? "默认模型" : "未配置模型"));
function chooseModel(id: string) { emit("update:selectedModelId", id); modelOpen.value = false; }

/* ---------- 上下文用量 ---------- */
const ctx = computed(() => {
  const u = props.usage; if (!u || !u.size) return null;
  const pct = Math.max(0, Math.min(1, u.used / u.size));
  return { used: u.used, size: u.size, pct, text: Math.round(pct * 100) + "%" };
});
const fmtK = (n: number) => (n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "K" : String(n));
const ctxOpen = ref(false);
const RING = 2 * Math.PI * 7;

/* ---------- 发送 ---------- */
const canSend = computed(() => !props.disabled && !uploading.value && (!!text.value.trim() || files.value.some((f) => f.state === "ready")));
function submit() {
  if (!canSend.value) { if (uploading.value) say("附件还在上传…"); return; }
  const ready = files.value.filter((f) => f.state === "ready");
  emit("send", { text: text.value.trim(), files: ready, picks: [...picks.value], modelConfigId: locked.value ? null : props.selectedModelId || null });
}
/** 发送成功后由宿主调用：清掉附件和已选技能。 */
function reset() { for (const f of files.value) if (f.localUrl) { try { URL.revokeObjectURL(f.localUrl); } catch { /* ignore */ } } files.value = []; picks.value = []; menu.value = null; }
function setFiles(list: ChatFile[]) { files.value = list.map((f) => ({ ...f, state: "ready" as const })); }
function focus() { ta.value?.focus(); }
defineExpose({ reset, setFiles, focus, addPick, openPicker: () => fileInput.value?.click() });

function onDocClick(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (!t.closest?.(".cmp-model")) modelOpen.value = false;
  if (!t.closest?.(".cmp-plus")) plusOpen.value = false;
  if (!t.closest?.(".cmp-ctx")) ctxOpen.value = false;
  if (!t.closest?.(".cmp-menu") && !t.closest?.(".cmp-input")) menu.value = null;
}
onMounted(() => { document.addEventListener("mousedown", onDocClick); autosize(); });
onBeforeUnmount(() => { document.removeEventListener("mousedown", onDocClick); window.clearTimeout(noticeTimer); window.clearTimeout(wsTimer); });
</script>

<template>
  <div class="cmp chat-composer" :class="{ dragging }" data-chat-composer @dragover="onDragOver" @dragleave.self="dragging = false" @drop="onDrop">
    <div v-if="menu && menuItems.length" ref="menuEl" class="cmp-menu" :data-chat-menu="menu.type" role="listbox">
      <template v-for="g in groupedMenu" :key="g.name">
        <div class="cmp-menu-group">{{ g.name }}</div>
        <button v-for="it in g.items" :key="it.key" type="button" class="cmp-menu-item" role="option" :data-active="it.index === menuIndex ? '1' : null" :aria-selected="it.index === menuIndex" :data-chat-menu-item="it.key" @mouseenter="menuIndex = it.index" @mousedown.prevent="it.run()">
          <component :is="it.icon" :size="14" class="cmp-menu-ic" />
          <span class="cmp-menu-label">{{ it.label }}</span>
          <small v-if="it.sub" class="cmp-menu-sub">{{ it.sub }}</small>
        </button>
      </template>
    </div>
    <div v-else-if="menu && menu.type === 'at'" class="cmp-menu cmp-menu-empty">工作文件夹里没有匹配的文件。可以先上传附件。</div>

    <div v-if="files.length || picks.length" class="cmp-chips" data-chat-attachments>
      <span v-for="p in picks" :key="p.kind + p.id" class="cmp-pick" :data-chat-pick="p.kind">
        <Sparkles v-if="p.kind === 'skill'" :size="12" /><Plug v-else :size="12" />{{ p.kind === "skill" ? "技能" : "MCP" }} · {{ p.name }}
        <button type="button" class="chat-file-x" aria-label="移除" @click="picks = picks.filter((x) => x !== p)"><X :size="11" /></button>
      </span>
      <div v-for="(f, i) in files" :key="i + f.name" class="chat-file" :data-state="f.state" data-chat-attachment :title="f.path || f.name" @click="f.state === 'ready' && f.path && openWorkspace(f.path, f.name)">
        <span class="chat-file-ic"><img v-if="f.kind === 'image' && f.localUrl" :src="f.localUrl" alt="" /><component :is="FILE_ICON[f.kind] || FileText" v-else :size="15" /></span>
        <span class="chat-file-meta"><span class="chat-file-name">{{ f.name }}</span><span class="chat-file-sub">{{ f.state === "uploading" ? "上传中…" : f.state === "failed" ? f.error || "上传失败" : (f.ref ? "引用 · " : "") + sizeText(f.size) }}</span></span>
        <button type="button" class="chat-file-x" aria-label="移除附件" @click.stop="removeFile(i)"><X :size="11" /></button>
      </div>
    </div>

    <textarea
      ref="ta" v-model="text" class="cmp-input" rows="1" data-chat-input :placeholder="placeholder" aria-label="消息" :disabled="disabled"
      @keydown="onKey" @input="detectMenu(); autosize()" @click="detectMenu" @paste="onPaste"
    />

    <div class="cmp-bar">
      <input ref="fileInput" type="file" multiple hidden data-chat-file-input @change="onPick" />
      <div class="cmp-plus">
        <button type="button" class="cmp-btn cmp-plus-btn" data-chat-plus title="添加附件、引用文件、命令与技能" aria-label="更多输入方式" :aria-expanded="plusOpen" @click="plusOpen = !plusOpen"><Plus :size="17" /></button>
        <div v-if="plusOpen" class="cmp-pop cmp-plus-pop" data-chat-plus-menu role="menu">
          <button type="button" role="menuitem" data-chat-attach @click="plusOpen = false; fileInput?.click()"><Paperclip :size="15" /><span class="cmp-pop-main">添加附件<small>也可以拖进来或直接粘贴</small></span></button>
          <button type="button" role="menuitem" data-chat-at @click="plusOpen = false; text = text + (text && !/\s$/.test(text) ? ' @' : '@'); nextTick(() => { ta?.focus(); detectMenu(); })"><AtSign :size="15" /><span class="cmp-pop-main">引用工作文件夹的文件<small>输入 @</small></span></button>
          <button type="button" role="menuitem" data-chat-slash @click="plusOpen = false; text = '/' + text.replace(/^\//, ''); nextTick(() => { ta?.focus(); ta?.setSelectionRange(1, 1); detectMenu(); })"><Slash :size="15" /><span class="cmp-pop-main">命令、技能与应用<small>输入 /</small></span></button>
        </div>
      </div>
      <span class="toolbar-spacer" />
      <p v-if="notice" class="cmp-notice" role="status">{{ notice }}</p>
      <div v-if="ctx" class="cmp-ctx">
        <button type="button" class="cmp-ctx-btn" data-chat-context :title="'上下文 ' + fmtK(ctx.used) + ' / ' + fmtK(ctx.size)" :aria-expanded="ctxOpen" @click="ctxOpen = !ctxOpen">
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" class="ring-bg" /><circle cx="9" cy="9" r="7" class="ring-fg" :stroke-dasharray="RING" :stroke-dashoffset="RING * (1 - ctx.pct)" /></svg>
          <span>{{ ctx.text }}</span>
        </button>
        <div v-if="ctxOpen" class="cmp-pop cmp-ctx-pop" data-chat-context-pop>
          <strong>上下文用量</strong>
          <div class="cmp-ctx-bar"><i :style="{ width: Math.max(2, ctx.pct * 100) + '%' }" /></div>
          <dl><dt>已用</dt><dd>{{ ctx.used.toLocaleString() }} tokens</dd><dt>窗口</dt><dd>{{ ctx.size.toLocaleString() }} tokens</dd><dt>本对话模型调用</dt><dd>{{ modelCalls ?? 0 }} 次</dd></dl>
          <p class="cmp-pop-note">按对话模型估算。快满时 AI 会自动压缩较早的内容；需要彻底重来可以新开对话。</p>
        </div>
      </div>

      <div class="cmp-model">
        <button type="button" class="cmp-model-btn" data-chat-model :aria-expanded="modelOpen" :title="locked ? '这段对话固定使用开始时的模型；要换模型请新开对话' : '选择模型'" @click="modelOpen = !modelOpen">
          {{ modelName }} <ChevronDown :size="12" />
        </button>
        <div v-if="modelOpen" class="cmp-pop cmp-model-pop" data-chat-model-menu role="menu">
          <p v-if="locked" class="cmp-pop-note">这段对话开始时用的是「{{ modelName }}」，中途不能换。选别的模型会用于下一段新对话。</p>
          <button v-for="m in models" :key="m.configId" type="button" role="menuitemradio" :aria-checked="m.configId === selectedModelId" :data-chat-model-option="m.configId" @click="chooseModel(m.configId)">
            <span class="cmp-pop-main">{{ m.displayName }}<small>{{ m.providerName }}</small></span>
            <Check v-if="m.configId === (locked ? lockedModelId : selectedModelId)" :size="14" />
          </button>
          <p v-if="!models.length" class="cmp-pop-note">还没有可用的对话模型，请到「系统设置 › 模型与服务商」添加。</p>
        </div>
      </div>

      <button v-if="voice" type="button" class="cmp-btn" :class="{ rec: voice.recording }" :disabled="voice.busy" :data-available="voice.available ? 1 : 0" :title="voice.hint" :aria-pressed="voice.recording" aria-label="语音输入" data-chat-voice @click="emit('voice')"><Mic :size="15" /></button>
      <button v-if="running" type="button" class="chat-send chat-send-stop" data-chat-stop aria-label="停止" title="停止" @click="emit('stop')"><Square :size="12" /></button>
      <button v-else type="button" class="chat-send" data-chat-send aria-label="发送" title="发送（回车）· ⇧回车换行" :disabled="!canSend" @click="submit"><ArrowUp :size="15" /></button>
    </div>
    <div v-if="dragging" class="cmp-drop">松开即可添加附件</div>
  </div>
</template>
