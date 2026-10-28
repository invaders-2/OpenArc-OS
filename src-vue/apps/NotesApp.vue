<script setup lang="ts">
import { t } from "../i18n";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { FilePlus2, Search } from "lucide-vue-next";
import DsButton from "../design-system/DsButton.vue";
import { iconUrl } from "../apps";
import { useShellStore } from "../stores/shell";
import { officeCapabilityDetail, officeCapabilityLabel, probeOfficeCapability } from "./officeCapability";
import type { OfficeCapability } from "./officeCapability";

/**
 * 文稿（10-15）：真实的本地文本文稿。
 *   · 列表 = 访达（桌面 + 各文件夹）里所有 .md / .txt；
 *   · 新建落在桌面「文稿」文件夹（没有就建），所以在访达里也能看到、拖走、删除；
 *   · 编辑自动保存（停顿 600ms），走 files.writeText —— 主进程只允许改写 md/txt。
 */
type Doc = { key: string; folderId: string; id: string; name: string; mtime: number; folder: string };
const shell = useShellStore();
const docs = ref<Doc[]>([]);
const loading = ref(false);
const query = ref("");
const current = ref<Doc | null>(null);
const text = ref("");
const title = ref("");
const status = ref<"" | "saving" | "saved" | "error">("");
let timer: number | null = null;
let dirty = false;
const mode = ref<"edit" | "preview">("preview");
const summaries = ref<Record<string, string>>({});
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch));
function inlineMd(line: string) {
  return escapeHtml(line).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
}
function renderMd(source: string) {
  const lines = String(source || "").split("\n");
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { out.push("<ul>" + list.map((item) => "<li>" + inlineMd(item) + "</li>").join("") + "</ul>"); list = []; } };
  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { flush(); out.push("<h" + heading[1].length + ">" + inlineMd(heading[2]) + "</h" + heading[1].length + ">"); continue; }
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) { list.push(item[1]); continue; }
    flush();
    if (line.trim()) out.push("<p>" + inlineMd(line) + "</p>");
  }
  flush();
  return out.join("");
}
const rendered = computed(() => renderMd(text.value));
const stripMd = (text: string) => text.replace(/[#>*_`\[\]()!-]/g, " ").replace(/\s+/g, " ").trim();

const folderName = (fid: string) => (fid === "desktop" ? "桌面" : shell.folders.find((f) => f.id === fid)?.name ?? "文件夹");
const baseName = (n: string) => n.replace(/\.(md|txt)$/i, "");

async function load() {
  const b = window.openarc?.files;
  if (!b) return;
  loading.value = true;
  const out: Doc[] = [];
  for (const fid of ["desktop", ...shell.folders.map((f) => f.id)]) {
    const res = await b.list(fid).catch(() => null);
    for (const e of res?.entries ?? []) {
      if (!/^(md|txt)$/i.test(e.ext)) continue;
      out.push({ key: fid + "/" + e.id, folderId: fid, id: e.id, name: e.name, mtime: e.mtime ?? 0, folder: folderName(fid) });
    }
  }
  docs.value = out.sort((a, b) => b.mtime - a.mtime);
  loading.value = false;
  void loadSummaries(docs.value.slice(0, 20));
}

async function loadSummaries(list: Doc[]) {
  const b = window.openarc?.files;
  if (!b?.read) return;
  for (const d of list) {
    const r = await b.read(d.folderId, d.id).catch(() => null);
    if (r?.text) summaries.value = { ...summaries.value, [d.key]: stripMd(r.text).slice(0, 28) };
  }
}
const summaryOf = (d: Doc) => summaries.value[d.key] || d.folder;
const dirtyLabel = computed(() => (status.value === "saving" ? t("正在保存…") : dirty ? t("已修改") : status.value === "error" ? t("保存失败") : t("已保存")));
const canSave = computed(() => !!current.value && (dirty || status.value === ""));

async function saveNow() {
  if (!current.value) return;
  dirty = true;
  await flush();
}

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q ? docs.value.filter((d) => d.name.toLowerCase().includes(q)) : docs.value;
});

async function flush() {
  if (timer) window.clearTimeout(timer);
  timer = null;
  const d = current.value;
  const b = window.openarc?.files;
  if (!d || !dirty || !b?.writeText) return;
  dirty = false;
  status.value = "saving";
  const r = await b.writeText(d.folderId, d.id, "", text.value).catch(() => null);
  status.value = r?.ok ? "saved" : "error";
  if (r?.ok) d.mtime = r.entry?.mtime ?? Date.now();
}

async function open(d: Doc) {
  await flush();
  const r = await window.openarc?.files?.read?.(d.folderId, d.id).catch(() => null);
  current.value = d;
  title.value = baseName(d.name);
  text.value = r?.text ?? "";
  status.value = r?.ok ? "" : "error";
}

async function create() {
  const b = window.openarc?.files;
  if (!b?.writeText) return;
  await flush();
  const folder = shell.ensureFolder("文稿");
  const r = await b.writeText(folder.id, null, "未命名文稿.md", "").catch(() => null);
  if (!r?.ok || !r.entry) {
    shell.notify({ appId: "notes", title: "无法新建文稿", body: r?.error ?? "写入失败" });
    return;
  }
  const d: Doc = { key: folder.id + "/" + r.entry.id, folderId: folder.id, id: r.entry.id, name: r.entry.name, mtime: r.entry.mtime ?? Date.now(), folder: folder.name };
  docs.value.unshift(d);
  await open(d);
}

async function rename() {
  const d = current.value;
  const next = title.value.trim();
  if (!d || !next || next === baseName(d.name)) return;
  const ext = d.name.match(/\.(md|txt)$/i)?.[0] ?? ".md";
  const r = await window.openarc?.files?.rename?.(d.folderId, d.id, next + ext).catch(() => null);
  if (r?.ok) d.name = next + ext;
  else title.value = baseName(d.name);
}

function onInput() {
  dirty = true;
  status.value = "";
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => void flush(), 600);
}

const when = (t: number) => {
  if (!t) return "";
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : `${d.getMonth() + 1}/${d.getDate()}`;
};

/* ── Office 能力状态：docx/xlsx 解析依赖不在本仓，如实显示（真实命令探测，不靠前端猜） ── */
const office = ref<OfficeCapability | null>(null);
async function loadOfficeCapability() {
  office.value = await probeOfficeCapability();
}
onMounted(load);
onMounted(loadOfficeCapability);
onBeforeUnmount(() => void flush());
</script>

<template>
  <div class="split notes-app">
    <nav class="split-side notes-side" :aria-label="t('文稿')">
      <label class="ds-search notes-search">
        <Search class="ds-search__icon" :size="13" />
        <input v-model="query" class="ds-search__input" type="search" :placeholder="t('搜索文稿')" :aria-label="t('搜索文稿')" />
      </label>
      <div class="notes-list" data-notes-list>
        <button
          v-for="d in shown"
          :key="d.key"
          type="button"
          class="notes-item"
          :aria-current="current?.key === d.key ? 'true' : undefined"
          data-notes-row
          @click="open(d)"
        >
          <span class="notes-item-name">{{ baseName(d.name) }}</span>
          <small class="notes-item-sub">{{ when(d.mtime) }} · {{ summaryOf(d) }}</small>
        </button>
        <p v-if="!loading && !shown.length" class="notes-empty">{{ query ? t("没有匹配的文稿") : t("访达里还没有 .md / .txt 文稿") }}</p>
      </div>
    </nav>

    <div class="split-main notes-main">
      <div class="pane-toolbar notes-toolbar">
        <input
          v-if="current"
          v-model="title"
          class="notes-title notes-title-input"
          :aria-label="t('文稿名称')"
          @blur="rename"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
        />
        <strong v-else class="notes-title">{{ t("文稿") }}</strong>
        <span class="notes-state" :data-notes-state="status === 'saving' ? 'saving' : dirty ? 'dirty' : status === 'error' ? 'error' : 'saved'" data-notes-dirty>{{ dirtyLabel }}</span>
        <details class="notes-more"><summary aria-label="更多">⋯</summary><div class="notes-more-menu"><span
          class="notes-office set-cap"
          :data-notes-office="!office ? 'checking' : office.failure ? 'unknown' : (office.docx.available && office.xlsx.available ? 'available' : 'unavailable')"
          :data-notes-office-docx="office ? (office.docx.available ? '1' : '0') : ''"
          :data-notes-office-xlsx="office ? (office.xlsx.available ? '1' : '0') : ''"
          :title="officeCapabilityDetail(office)"
        >{{ officeCapabilityLabel(office) }}</span></div></details>
        <span class="toolbar-spacer" />
        <div class="segmented text notes-mode" role="group" aria-label="编辑或预览" data-notes-mode>
          <button type="button" :aria-pressed="mode === 'edit'" data-notes-mode-edit @click="mode = 'edit'">{{ t("编辑") }}</button>
          <button type="button" :aria-pressed="mode === 'preview'" data-notes-mode-preview @click="mode = 'preview'">{{ t("预览") }}</button>
        </div>
        <button class="notes-new" :aria-label="t('新建文稿')" :title="t('新建文稿')" data-notes-new @click="create"><FilePlus2 :size="14" /><span>{{ t("新建") }}</span></button>
        <DsButton variant="primary" size="sm" class="notes-save" data-notes-save :disabled="!canSave" @click="saveNow">{{ t("保存") }}</DsButton>
      </div>

      <div class="notes-editor" data-notes-editor>
        <div v-if="current" class="notes-paper" :class="{ 'is-preview': mode === 'preview' }" data-notes-paper>
          <textarea
            v-if="mode === 'edit'"
            v-model="text"
            class="notes-text"
            spellcheck="false"
            :placeholder="t('开始写点什么…')"
            :aria-label="t('文稿内容')"
            @input="onInput"
          />
          <div v-else class="notes-render" data-notes-render v-html="rendered" />
        </div>
        <div v-else class="empty-content">
          <img class="large-icon" :src="iconUrl('text-editor')" alt="" draggable="false" />
          <p>{{ t("选择左侧的文稿，或新建一篇。新文稿保存在桌面「文稿」文件夹里。") }}</p>
          <button class="planned-cta" @click="create"><FilePlus2 :size="14" /> {{ t("新建文稿") }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Office 能力状态只在工具栏占一行；结论很短，原始错误放 title，不挤占正文。 */
.notes-office {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* task-10：原型布局（侧栏 230 / 工具条 52 / 居中纸 680） */
.notes-app .split-side { flex: 0 0 230px; margin: 8px 0 8px 8px; padding: 44px 8px 10px; }
.notes-search { margin: 0 4px 8px; }
.notes-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.notes-item { display: flex; flex-direction: column; gap: 2px; padding: 7px 10px; border-radius: var(--radius-md); text-align: left; min-width: 0; }
.notes-item:hover { background: var(--row-hover); }
.notes-item[aria-current="true"] { background: rgb(var(--text-rgb) / 0.08); }
.notes-item-name { font-size: var(--fs-secondary); font-weight: var(--fw-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notes-item-sub { font-size: var(--fs-caption); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notes-empty { margin: 6px 10px; color: var(--muted); font-size: var(--fs-caption); }
.notes-app .split-main { padding: 0; padding-top: 0 !important; }
.notes-toolbar { height: 52px; min-height: 52px; margin: 0; padding: 0 20px; border-bottom: 0.5px solid var(--line); }
.notes-title { flex: 0 1 auto; min-width: 0; font-size: 15px; font-weight: var(--fw-medium); }
.notes-title-input { border: 0; background: transparent; color: var(--text); outline: none; max-width: 46%; padding: 2px 4px; border-radius: var(--radius-sm); }
.notes-title-input:focus { box-shadow: 0 0 0 2px var(--focus); }
.notes-state { flex: none; color: var(--muted); font-size: var(--fs-caption); }
.notes-mode { flex: none; }
.notes-office { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notes-save { flex: none; }
.notes-editor { flex: 1; min-height: 0; overflow: auto; padding: 20px 24px; display: flex; flex-direction: column; }
.notes-paper { width: 680px; max-width: 100%; flex: 1; min-height: 0; margin: 0 auto; padding: 36px 44px; border-radius: var(--radius-lg); background: rgb(var(--content-rgb) / 0.98); box-shadow: var(--elevation-1); display: flex; flex-direction: column; }
.notes-text { flex: 1; width: 100%; min-height: 100%; border: 0; outline: none; resize: none; background: transparent; color: var(--text); font: inherit; font-size: var(--fs-body); line-height: 1.8; }
.notes-paper.is-preview { background: rgb(var(--content-rgb) / 0.7); }
.notes-paper.is-preview .notes-text { cursor: default; }

.notes-app .split-side { margin: 8px 0 8px 8px !important; padding: 44px 10px 10px; }
.notes-search { height: 30px; margin: 0 0 10px; }
.notes-editor { padding: 28px 11px; }
.notes-paper { width: 680px; max-width: none; flex: none; min-height: 0; height: auto; }
.notes-text { height: 230px; min-height: 0; }
.notes-title-input { flex: 1; max-width: none; }
.notes-office { display: none; }
.notes-save { min-width: 50px; }

.notes-new { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 10px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.06); font-size: var(--fs-caption); }
.notes-new:hover { background: rgb(var(--text-rgb) / 0.1); }
.notes-toolbar .icon-button { width: 30px; height: 30px; }
.notes-toolbar .ds-btn { height: 30px; }
.notes-mode button { height: 30px; }
.notes-item { min-height: 54px; }
.notes-paper { min-height: 306px; }
.notes-render { flex: 1; color: var(--text); font-size: var(--fs-body); line-height: 1.8; overflow-wrap: anywhere; }
.notes-render h1 { font-size: 24px; font-weight: var(--fw-medium); margin: 0 0 12px; }
.notes-render h2 { font-size: 19px; font-weight: var(--fw-medium); margin: 14px 0 8px; }
.notes-render h3 { font-size: 16px; font-weight: var(--fw-medium); margin: 12px 0 6px; }
.notes-render p { margin: 0 0 10px; }
.notes-render ul { margin: 0 0 10px; padding-left: 20px; }
.notes-render code { padding: 1px 4px; border-radius: 4px; background: rgb(var(--text-rgb) / 0.08); font-family: var(--font-mono); font-size: 0.92em; }

.notes-more { position: relative; }
.notes-more > summary { list-style: none; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; }
.notes-more > summary::-webkit-details-marker { display: none; }
.notes-more-menu { position: absolute; right: 0; top: 28px; z-index: 20; padding: 8px; border-radius: var(--radius-md); background: rgb(var(--content-rgb) / 0.98); box-shadow: var(--elevation-2); white-space: nowrap; }
.notes-more-menu .notes-office { display: block; }
</style>
