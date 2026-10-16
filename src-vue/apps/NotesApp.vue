<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { FilePlus2, Search } from "lucide-vue-next";
import { iconUrl } from "../apps";
import { useShellStore } from "../stores/shell";

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

onMounted(load);
onBeforeUnmount(() => void flush());
</script>

<template>
  <div class="split notes-app">
    <nav class="split-side" aria-label="文稿">
      <label class="ds-search notes-search">
        <Search class="ds-search__icon" :size="13" />
        <input v-model="query" class="ds-search__input" type="search" placeholder="搜索文稿" aria-label="搜索文稿" />
      </label>
      <div class="split-section">全部文稿 <small class="planned-count">{{ docs.length }}</small></div>
      <div class="notes-list">
        <button
          v-for="d in shown"
          :key="d.key"
          type="button"
          class="notes-item"
          :aria-current="current?.key === d.key ? 'true' : undefined"
          @click="open(d)"
        >
          <span class="notes-item-name">{{ baseName(d.name) }}</span>
          <small>{{ when(d.mtime) }} · {{ d.folder }}</small>
        </button>
        <p v-if="!loading && !shown.length" class="planned-note">{{ query ? "没有匹配的文稿" : "访达里还没有 .md / .txt 文稿" }}</p>
      </div>
    </nav>
    <div class="split-main notes-main">
      <div class="pane-toolbar">
        <input
          v-if="current"
          v-model="title"
          class="notes-title"
          aria-label="文稿名称"
          @blur="rename"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
        />
        <strong v-else class="pane-title">文稿</strong>
        <div class="toolbar-spacer" />
        <span v-if="status" class="notes-status">{{ { saving: "正在保存…", saved: "已保存", error: "保存失败" }[status] }}</span>
        <button class="icon-button" aria-label="新建文稿" title="新建文稿" @click="create"><FilePlus2 :size="15" /></button>
      </div>
      <textarea
        v-if="current"
        v-model="text"
        class="notes-editor"
        spellcheck="false"
        placeholder="开始写点什么…"
        aria-label="文稿内容"
        @input="onInput"
      />
      <div v-else class="empty-content">
        <img class="large-icon" :src="iconUrl('text-editor')" alt="" draggable="false" />
        <p>选择左侧的文稿，或新建一篇。新文稿保存在桌面「文稿」文件夹里。</p>
        <button class="planned-cta" @click="create"><FilePlus2 :size="14" /> 新建文稿</button>
      </div>
    </div>
  </div>
</template>
