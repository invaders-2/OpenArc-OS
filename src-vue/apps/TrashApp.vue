<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  Archive,
  Eraser,
  File as FileIcon,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  RotateCcw,
  Trash2,
} from "lucide-vue-next";
import * as folderTrashLib from "../../electron/folder-trash.ts";
import type { FolderTrashRecord } from "../../electron/folder-trash.ts";
import DsButton from "../design-system/DsButton.vue";
import DsContextMenu, { type MenuEntry } from "../design-system/DsContextMenu.vue";
import DsDialog from "../design-system/DsDialog.vue";
import FolderIcon from "../shell/FolderIcon.vue";
import { useShellStore } from "../stores/shell";
import { kindOfExt } from "../wallpapers";
import { iconUrl } from "../apps";

/**
 * 回收站（10-15 迁到新壳层，逐条对齐 src/main.tsx:2392 的回收站窗口与 620-790 的回收站逻辑）。
 *
 * 三个分区：文件夹（oa-folder-trash 记录 + 同组文件）/ 文件（文件服务回收站）/ 来自资源库
 * （resource/query category=trash，只列已授权的 TRASHED 资源，空则不出现）。
 * 恢复按行类型分派；永久删除与清空走 DsDialog 二次确认，不可撤销。
 * 双击 / 回车 / 空格 = 恢复，Delete = 永久删除（同样先确认）。
 */
type TrashRow =
  | { key: string; kind: "folder"; name: string; groupId: string; fileCount: number; ext?: undefined }
  | { key: string; kind: "file"; name: string; ext: string; trashId: string; folderId: string; origId: string }
  | { key: string; kind: "resource"; name: string; ext: string; resourceRef: string };
type ResourceTrashItem = { resourceRef: string; name: string; resourceType?: string };

const RESOURCE_EXT: Record<string, string> = {
  image: "png",
  video: "mp4",
  audio: "mp3",
  text: "txt",
  code: "ts",
  prompt: "md",
  memory: "md",
  document: "pdf",
};

const shell = useShellStore();
const files = () => window.openarc?.files;

const entries = ref<OpenArcTrashEntry[]>([]);
const records = ref<FolderTrashRecord[]>(readRecords());
const resources = ref<ResourceTrashItem[]>([]);
const thumbs = ref<Record<string, string>>({});
const sel = ref<string[]>([]);

function readRecords(): FolderTrashRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem("oa-folder-trash") || "null");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
function saveRecords(list: FolderTrashRecord[]) {
  records.value = list;
  localStorage.setItem("oa-folder-trash", JSON.stringify(list));
}

async function resourceCmd(payload: Record<string, unknown>): Promise<any> {
  const b = (window as any).openarc?.resource;
  if (!b) return { ok: false, error: "NO_BRIDGE" };
  try {
    return await b.command(payload);
  } catch {
    return { ok: false, error: "INTERNAL_ERROR" };
  }
}
async function loadThumbs() {
  const b = files();
  if (!b?.thumb) return;
  const next: Record<string, string> = {};
  for (const row of rows.value.all) {
    if (row.kind !== "file" || !["png", "jpg", "jpeg", "webp", "gif", "mp4", "mov", "webm"].includes(row.ext.toLowerCase())) continue;
    const res = await b.thumb(row.folderId, row.origId).catch(() => null);
    if (res?.ok && res.dataUrl) next[row.key] = res.dataUrl;
  }
  thumbs.value = next;
}
async function refresh() {
  records.value = readRecords();
  try {
    const res = await files()?.trashList?.();
    if (res && Array.isArray(res.entries)) entries.value = res.entries;
  } catch {
    /* 主进程不可用时保持原样 */
  }
  const r = await resourceCmd({ type: "resource/query", category: "trash", sort: "updated", direction: "desc", limit: 60 });
  resources.value = r && r.ok && Array.isArray(r.items) ? r.items : [];
  shell.trashFull = rows.value.all.length > 0;
  void loadThumbs();
}
onMounted(() => void refresh());

const rows = computed(() => {
  const sections = folderTrashLib.buildTrashSections({
    fileEntries: entries.value,
    folderRecords: records.value,
    resourceItems: resources.value,
  });
  const folderRows: TrashRow[] = sections.folders.map((r) => ({
    key: "g:" + r.groupId,
    kind: "folder",
    name: r.name,
    groupId: r.groupId,
    fileCount: r.fileCount,
  }));
  const fileRows: TrashRow[] = sections.files.map((e) => ({
    key: "f:" + e.id,
    kind: "file",
    name: e.name,
    ext: e.ext,
    trashId: e.id,
    folderId: String(e.folderId ?? ""),
    origId: String((e as { origId?: string }).origId ?? e.id),
    from: String((e as { from?: string }).from || ""),
  }));
  const resourceRows: TrashRow[] = (sections.resources as ResourceTrashItem[]).map((it) => ({
    key: "r:" + it.resourceRef,
    kind: "resource",
    name: it.name,
    resourceRef: it.resourceRef,
    ext: RESOURCE_EXT[String(it.resourceType ?? "")] ?? "",
  }));
  return { folderRows, fileRows, resourceRows, all: [...folderRows, ...fileRows, ...resourceRows], isEmpty: sections.isEmpty };
});
const byKey = computed(() => new Map(rows.value.all.map((r) => [r.key, r])));
const labelOf = (key: string) => {
  const r = byKey.value.get(key);
  if (!r) return key;
  return r.kind === "folder" && r.fileCount > 0 ? `${r.name}（${r.fileCount} 个文件）` : r.name;
};
const fromLabel = (row: TrashRow) => { const from = String((row as any).from || "").trim(); return !from || from === "回收站" ? "来源未知（NOT VERIFIED）" : "来自 " + from; };
const glyphFor = (ext = "") => {
  const k = kindOfExt(ext);
  if (k === "image") return ImageIcon;
  if (k === "video") return Film;
  if (k === "audio") return Music;
  if (k === "doc" || k === "text") return FileText;
  if (k === "archive") return Archive;
  return FileIcon;
};

/** 与访达同一套选择语义：单击单选、⌘/Ctrl 加减选、Shift 扩选。 */
function toggle(key: string, e: MouseEvent) {
  const cur = sel.value;
  if (e.metaKey || e.ctrlKey) sel.value = cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key];
  else if (e.shiftKey && cur.length) {
    const order = rows.value.all.map((v) => v.key);
    const a = order.indexOf(cur[cur.length - 1]);
    const b = order.indexOf(key);
    sel.value = a >= 0 && b >= 0 ? order.slice(Math.min(a, b), Math.max(a, b) + 1) : [key];
  } else sel.value = [key];
}

/* ── 恢复 / 永久删除 / 清空 ─────────────────────────────────────────── */
async function restore(keys: string[]) {
  if (!keys.length) return;
  const b = files();
  for (const key of keys) {
    const row = byKey.value.get(key);
    if (!row) continue;
    if (row.kind === "folder") {
      const rec = records.value.find((r) => r.groupId === row.groupId);
      if (!rec) continue;
      // 子树元数据放回原位（同名 / 父目录已不在时由 planFolderRestore 处理）
      const plan = folderTrashLib.planFolderRestore(rec, shell.folders);
      shell.folders.push(...plan.added);
      shell.persistFolders();
      for (const id of folderTrashLib.trashIdsOfGroup(entries.value, rec.groupId)) await b?.trashRestore?.(id);
      saveRecords(records.value.filter((r) => r.groupId !== rec.groupId));
    } else if (row.kind === "file") {
      await b?.trashRestore?.(row.trashId);
    } else {
      await resourceCmd({ type: "resource/restore", resourceRef: row.resourceRef });
    }
  }
  sel.value = [];
  await refresh();
}
async function purge(keys: string[]) {
  const b = files();
  for (const key of keys) {
    const row = byKey.value.get(key);
    if (!row) continue;
    if (row.kind === "folder") {
      for (const id of folderTrashLib.trashIdsOfGroup(entries.value, row.groupId)) await b?.trashPurge?.(id);
      saveRecords(records.value.filter((r) => r.groupId !== row.groupId));
    } else if (row.kind === "file") await b?.trashPurge?.(row.trashId);
    else await resourceCmd({ type: "resource/permanentDelete", resourceRef: row.resourceRef });
  }
  sel.value = [];
  await refresh();
}
async function empty() {
  await files()?.trashEmpty?.();
  saveRecords([]);
  for (const it of resources.value) await resourceCmd({ type: "resource/permanentDelete", resourceRef: it.resourceRef });
  sel.value = [];
  await refresh();
}

const confirm = ref<{ kind: "purge"; keys: string[]; label: string } | { kind: "empty" } | null>(null);
const requestPurge = (keys: string[]) =>
  (confirm.value = { kind: "purge", keys, label: keys.length > 1 ? keys.length + " 项" : labelOf(keys[0]) });
function doConfirm() {
  const c = confirm.value;
  confirm.value = null;
  if (!c) return;
  if (c.kind === "empty") void empty();
  else void purge(c.keys);
}

const menu = ref<{ x: number; y: number; keys: string[] } | null>(null);
const menuItems = computed<MenuEntry[]>(() => {
  const n = menu.value?.keys.length ?? 0;
  return [
    { id: "restore", label: n > 1 ? `恢复 ${n} 项` : "恢复" },
    { separator: true },
    { id: "purge", label: n > 1 ? `永久删除 ${n} 项` : "永久删除", danger: true },
  ];
});
function openMenu(e: MouseEvent, key: string) {
  const keys = sel.value.includes(key) ? sel.value : [key];
  if (!sel.value.includes(key)) sel.value = [key];
  menu.value = { x: e.clientX, y: e.clientY, keys };
}
function onMenu(id: string) {
  const keys = menu.value?.keys ?? [];
  menu.value = null;
  if (id === "restore") void restore(keys);
  else requestPurge(keys);
}
function onKey(e: KeyboardEvent, key: string) {
  if (e.key === "Enter" || e.code === "Space") {
    e.preventDefault();
    void restore([key]);
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    requestPurge([key]);
  }
}
const sections = computed(() =>
  [
    { id: "folder", label: "文件夹", rows: rows.value.folderRows },
    { id: "file", label: "文件", rows: rows.value.fileRows },
    { id: "resource", label: "来自资源库", rows: rows.value.resourceRows },
  ].filter((s) => s.rows.length),
);
</script>

<template>
  <div class="split trash-app">
    <nav class="split-side trash-side" aria-label="回收站">
      <div class="split-section">回收站</div>
      <button type="button" class="split-nav" :aria-current="sel.length === 0 ? 'true' : undefined" @click="sel = []">
        <Trash2 :size="16" /> <span class="split-nav-label">全部项目</span><small class="trash-count">{{ rows.all.length }}</small>
      </button>
      <div class="split-section">说明</div>
      <p class="trash-note" data-trash-note>删除的文件会在这里保留 30 天。已有引用不会被悄悄改指到同名文件。</p>
    </nav>

    <div class="split-main">
      <div class="pane-toolbar trash-toolbar">
        <strong class="pane-title">回收站</strong>
        <div class="toolbar-spacer" />
        <span class="trash-count-label">{{ rows.all.length }} 项</span>
        <button type="button" class="trash-restore" data-trash-restore :disabled="!sel.length" @click="restore(sel)">
          <RotateCcw :size="14" /> 恢复
        </button>
        <button type="button" class="trash-empty-btn" data-trash-empty :disabled="!rows.all.length" @click="confirm = { kind: 'empty' }">
          <Eraser :size="14" /> 清空回收站
        </button>
      </div>
      <div class="folder-body trash-body" @click.self="sel = []">
        <div v-if="rows.isEmpty" class="empty-content trash-empty" data-trash-empty-state>
          <img class="large-icon" :src="iconUrl('trash')" alt="" draggable="false" />
          <p>回收站是空的</p>
        </div>
        <div v-else class="trash-grid" @click.self="sel = []">
          <div
            v-for="row in rows.all"
            :key="row.key"
            class="trash-item"
            :class="{ selected: sel.includes(row.key) }"
            role="button"
            tabindex="0"
            :title="row.name"
            :data-entry-id="row.key"
            :data-trash-kind="row.kind"
            @click.stop="toggle(row.key, $event)"
            @dblclick="restore([row.key])"
            @keydown="onKey($event, row.key)"
            @contextmenu.prevent.stop="openMenu($event, row.key)"
          >
            <FolderIcon v-if="row.kind === 'folder'" :size="46" />
            <span v-else class="trash-glyph">
              <img v-if="thumbs[row.key]" class="trash-thumb" :src="thumbs[row.key]" alt="" draggable="false" />
              <component :is="glyphFor(row.ext)" v-else :size="40" />
            </span>
            <span class="trash-name">{{ row.name }}</span>
            <span class="trash-from">{{ fromLabel(row) }}</span>
          </div>
        </div>
      </div>
      <footer class="finder-status">
        <span>{{ sel.length ? `已选 ${sel.length} 项，共 ${rows.all.length} 项` : `${rows.all.length} 项` }}</span>
        <span>双击恢复 · Delete 永久删除</span>
      </footer>
    </div>

    <Teleport v-if="menu" to=".desktop">
      <DsContextMenu :x="menu.x" :y="menu.y" :items="menuItems" label="回收站" @select="onMenu" @close="menu = null" />
    </Teleport>
    <Teleport to=".desktop">
      <DsDialog
        :open="confirm !== null"
        :title="confirm?.kind === 'empty' ? '永久删除回收站中的全部项目？' : '永久删除'"
        @close="confirm = null"
      >
        <p v-if="confirm?.kind === 'empty'">{{ rows.all.length }} 个项目将被永久删除，无法恢复。正在被其他项目引用的资源会显示为“已失效”。</p>
        <p v-else>确定永久删除「{{ confirm?.kind === "purge" ? confirm.label : "" }}」吗？</p>
        <p class="muted">此操作不可撤销。</p>
        <template #footer>
          <DsButton variant="ghost" size="sm" @click="confirm = null">取消</DsButton>
          <DsButton variant="danger" size="sm" data-trash-confirm @click="doConfirm">
            永久删除
          </DsButton>
        </template>
      </DsDialog>
    </Teleport>
  </div>
</template>

<style scoped>
.trash-count { margin-left: auto; color: var(--muted); font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
.trash-note { margin: 2px 10px 0; color: var(--muted); font-size: var(--fs-caption); line-height: 1.6; }
.trash-toolbar { height: 52px; min-height: 52px; }
.trash-count-label { color: var(--muted); font-size: var(--fs-micro); font-variant-numeric: tabular-nums; margin-right: 4px; }
.trash-restore, .trash-purge, .trash-empty-btn { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 12px; border-radius: var(--radius-pill); font-size: var(--fs-caption); }
.trash-restore { background: rgb(var(--text-rgb) / 0.08); }
.trash-purge { color: var(--muted); }
.trash-empty-btn { background: rgb(var(--text-rgb) / 0.06); color: var(--danger, #d33); }
.trash-empty-btn:disabled, .trash-restore:disabled, .trash-purge:disabled { opacity: 0.4; }
.trash-body { padding: 16px 20px; }
.trash-empty { margin: auto; }
.trash-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 4px 12px; align-content: start; }
.trash-item { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 12px 8px; border-radius: var(--radius-md); text-align: center; }
.trash-item:hover { background: rgb(var(--text-rgb) / 0.04); }
.trash-item.selected { background: rgb(var(--text-rgb) / 0.1); }
.trash-glyph { display: grid; place-items: center; height: 46px; color: var(--muted); }
.trash-name { font-size: var(--fs-caption); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trash-from { font-size: var(--fs-micro); color: var(--muted); }

.trash-app .split-side { flex: 0 0 200px; width: 200px; }
.trash-note { margin: 15px 10px 0 2px; }
.trash-body { padding: 0; }
.trash-grid { padding: 4px 18px; min-height: 147px; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; }
.trash-item { padding: 18px 8px; height: 119px; box-sizing: border-box; }
.trash-toolbar { padding-right: 16px; }
.trash-restore, .trash-empty-btn { height: 30px; padding: 0 7px; gap: 4px; font-size: 11px; }

.trash-app .split-main { padding: 0; }
.trash-app .folder-body { padding: 0; margin: 0; }
.trash-note { margin: 15px 2px 0 2px; font-size: 11px; line-height: 1.5; }

.trash-app { gap: 0; }
.trash-app .folder-body { padding: 0 !important; margin: 0 !important; }
.trash-app .trash-grid { margin: 0; }
.trash-note { min-height: 66px; font-size: 12px; line-height: 1.7; }

.trash-app .split-main { margin: 0 !important; padding: 0 !important; }
.trash-app .pane-toolbar { margin: 0 !important; }
.trash-body { padding: 0 !important; margin: 0 !important; }
.trash-grid { padding-top: 4px; margin-top: 0 !important; }
.trash-note { min-height: 0; font-size: 13px; line-height: 1.7; }
.trash-restore { padding: 0 5px; }

.trash-app { gap: 0 !important; }
.trash-toolbar { gap: 8px; padding-right: 18px; }

.trash-app .split-main { margin-left: -8px !important; }

.trash-app .split-side { margin-right: 0; }
.trash-app .split-main { margin-left: -8px !important; }

.trash-glyph { height: 46px; width: 56px; overflow: hidden; border-radius: 6px; }
.trash-thumb { width: 56px; height: 42px; object-fit: cover; display: block; }
</style>
