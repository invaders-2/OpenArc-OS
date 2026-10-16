<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Archive, File as FileIcon, FileText, Film, Image as ImageIcon, Music } from "lucide-vue-next";
import { useShellStore, type DesktopFolder } from "../stores/shell";
import { gridPos } from "./desktop-lattice";
import DsContextMenu, { type MenuEntry } from "../design-system/DsContextMenu.vue";
import DesktopWidgets from "./DesktopWidgets.vue";
import FolderIcon from "./FolderIcon.vue";
import Orb from "./Orb.vue";
import TopBar from "./TopBar.vue";

const shell = useShellStore();

/**
 * 桌面层（既有产品 src/main.tsx:3394-3541 里 .desktop-surface 的前半段）：
 * TopBar → 桌面文件夹 → 桌面文件 → 全局 AI 胶囊。窗口层与程序坞由 App.vue 排在它们后面，
 * 保证 .desktop-surface 的子元素顺序与既有产品一致。
 *
 * 本阶段不接 IPC：桌面"文件"来自真实存储（window.openarc.files），这里先用空清单占位，
 * 渲染路径与落格规则已按既有实现备好（oa-desktop-icons 键语义相同）。
 */
interface DesktopFile {
  id: string;
  name: string;
  ext: string;
  thumb?: string;
}
/* 10-16：桌面上的真实文件（files 服务的 desktop 文件夹），不再是空表 */
const desktopFiles = ref<DesktopFile[]>([]);
async function refreshDesktopFiles() {
  const b = window.openarc?.files;
  if (!b) return;
  const res = await b.list("desktop").catch(() => null);
  const list: DesktopFile[] = (res?.entries ?? []).map((e) => ({ id: e.id, name: e.name, ext: String(e.ext || "").toLowerCase() }));
  const old = new Map(desktopFiles.value.map((f) => [f.id, f.thumb]));
  desktopFiles.value = list.map((f) => ({ ...f, thumb: old.get(f.id) }));
  for (const f of desktopFiles.value) {
    if (f.thumb || !["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "avif", "mp4", "mov", "pdf"].includes(f.ext)) continue;
    const t = await b.thumb?.("desktop", f.id, 128).catch(() => null);
    if (t?.ok && t.dataUrl) f.thumb = t.dataUrl;
  }
}
let poll = 0;
onMounted(() => {
  void refreshDesktopFiles();
  // 访达 / 拖入 / 回收站都会改桌面内容：窗口重新获得焦点与每 4 秒各刷新一次（列表很小）
  poll = window.setInterval(refreshDesktopFiles, 4000);
  window.addEventListener("focus", refreshDesktopFiles);
});
onBeforeUnmount(() => {
  window.clearInterval(poll);
  window.removeEventListener("focus", refreshDesktopFiles);
});

const FILE_KINDS: Record<string, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "tiff", "psd", "ai", "eps"],
  video: ["mp4", "mov", "m4v", "avi", "mkv", "webm"],
  audio: ["mp3", "wav", "aac", "flac", "m4a", "ogg"],
  doc: ["pdf", "doc", "docx", "pages", "rtf", "pad", "txt", "md"],
  text: ["txt", "md", "json", "csv", "log", "ts", "tsx", "js", "jsx", "css", "html", "yml", "yaml", "xml"],
  archive: ["zip", "tar", "gz", "rar", "7z"],
};

const glyphFor = (ext: string) => {
  const kind = Object.keys(FILE_KINDS).find((k) => FILE_KINDS[k].includes(ext)) ?? "other";
  if (kind === "image") return ImageIcon;
  if (kind === "video") return Film;
  if (kind === "audio") return Music;
  if (kind === "doc" || kind === "text") return FileText;
  if (kind === "archive") return Archive;
  return FileIcon;
};

const files = computed(() =>
  desktopFiles.value.map((f, i) => ({ ...f, pos: shell.desktopIcons[f.id] ?? gridPos(i, shell.deskIcon) })),
);

/**
 * 桌面右键菜单（10-15 按原型补齐，条目对齐既有产品 src/main.tsx:3106-3197 的空白处菜单）：
 * 新建文件夹 → 整理 → 小组件显隐 → 壁纸（内置 + 已上传，勾选当前）→ 更多壁纸设置。
 * 既有产品的壁纸是子菜单；DsContextMenu 不做子菜单，这里平铺成一个带小标题的分组。
 */
const menu = ref<{ x: number; y: number } | null>(null);
const menuItems = computed<MenuEntry[]>(() => [
  { id: "new-folder", label: "新建文件夹" },
  { separator: true },
  { id: "arrange", label: "整理" },
  { id: "widgets", label: shell.widgets ? "隐藏小组件" : "显示小组件" },
  { separator: true },
  { header: "壁纸" },
  ...shell.wallpaperItems.map((w) => {
    const id = w.kind === "custom" ? "custom:" + w.id : w.id;
    return { id: "wp:" + id, label: w.name, checked: shell.wallpaper === id };
  }),
  { id: "wallpaper-settings", label: "壁纸与外观设置…" },
]);
function openMenu(e: MouseEvent) {
  menu.value = { x: e.clientX, y: e.clientY };
}
function onMenu(id: string) {
  const at = menu.value;
  menu.value = null;
  if (id === "new-folder" && at) shell.createFolder(at.x - shell.deskIcon / 2, at.y - shell.deskIcon / 2);
  else if (id === "arrange") shell.arrangeFolders((i) => gridPos(desktopFiles.value.length + i, shell.deskIcon));
  else if (id === "widgets") shell.setWidgets(!shell.widgets);
  else if (id === "wallpaper-settings") shell.activateApp("settings");
  else if (id.startsWith("wp:")) shell.setWallpaper(id.slice(3));
}

/**
 * 文件夹拖拽落位：位置夹回可视区并落进 oa-folders（与既有产品同一条规则）。
 * 指针监听挂在 window 上（不在元素上依赖 setPointerCapture），与既有实现的取舍一致。
 */
/* ── 10-16 · 桌面条目：选中、双击打开、右键菜单、重命名、文件拖动 ── */
const selectedId = ref<string | null>(null);
const renamingId = ref<string | null>(null);
const renameText = ref("");
const itemMenu = ref<{ x: number; y: number; kind: "folder" | "file"; id: string } | null>(null);
const itemMenuItems = computed<MenuEntry[]>(() =>
  itemMenu.value?.kind === "folder"
    ? [
        { id: "open", label: "打开" },
        { id: "rename", label: "重命名" },
        { separator: true },
        { id: "trash", label: "移到回收站", danger: true },
      ]
    : [
        { id: "preview", label: "快速查看" },
        { id: "reveal", label: "在访达中显示" },
        { separator: true },
        { id: "trash", label: "移到回收站", danger: true },
      ],
);
function openItemMenu(e: MouseEvent, kind: "folder" | "file", id: string) {
  selectedId.value = id;
  menu.value = null;
  itemMenu.value = { x: e.clientX, y: e.clientY, kind, id };
}
function openFile(f: DesktopFile) {
  void shell.openPreview("desktop", { id: f.id, name: f.name, ext: f.ext });
}
async function onItemMenu(action: string) {
  const m = itemMenu.value;
  itemMenu.value = null;
  if (!m) return;
  if (m.kind === "folder") {
    if (action === "open") shell.openFolder(m.id);
    else if (action === "rename") startRename(m.id);
    else if (action === "trash") await shell.removeFolder(m.id);
  } else {
    const f = desktopFiles.value.find((x) => x.id === m.id);
    if (!f) return;
    if (action === "preview") openFile(f);
    else if (action === "reveal") shell.openFolder("desktop");
    else if (action === "trash") {
      await window.openarc?.files?.trash?.("desktop", f.id).catch(() => null);
      void shell.refreshTrashState();
      await refreshDesktopFiles();
    }
  }
}
function startRename(id: string) {
  renamingId.value = id;
  renameText.value = shell.desktopFolders.find((f) => f.id === id)?.name ?? "";
}
function commitRename() {
  if (renamingId.value) shell.renameFolder(renamingId.value, renameText.value);
  renamingId.value = null;
}
function onFolderKey(e: KeyboardEvent, id: string) {
  if (renamingId.value) return;
  if (e.key === "Enter") startRename(id);
  else if ((e.metaKey && e.key === "o") || (e.metaKey && e.key === "ArrowDown")) shell.openFolder(id);
}
function dragFile(event: PointerEvent, f: { id: string; pos: { x: number; y: number } }) {
  if (event.button !== 0) return;
  selectedId.value = f.id;
  const sx = event.clientX;
  const sy = event.clientY;
  const { x: x0, y: y0 } = f.pos;
  const move = (ev: PointerEvent) => shell.setIconPos(f.id, { x: x0 + ev.clientX - sx, y: y0 + ev.clientY - sy });
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
}

function dragFolder(event: PointerEvent, folder: DesktopFolder) {
  if (event.button !== 0 || renamingId.value === folder.id) return;
  selectedId.value = folder.id;
  const startX = event.clientX;
  const startY = event.clientY;
  const x0 = folder.x;
  const y0 = folder.y;
  const move = (ev: PointerEvent) => {
    shell.setFolderPos(folder.id, { x: x0 + ev.clientX - startX, y: y0 + ev.clientY - startY });
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
}
</script>

<template>
  <TopBar />

  <!-- 桌面空白处：只接右键与点击（窗口层、文件夹都在它之后，天然压在上面） -->
  <div class="desk-backdrop" @contextmenu.prevent="openMenu" @pointerdown="menu = null; itemMenu = null; selectedId = null; commitRename()" />
  <DesktopWidgets v-if="shell.widgets" />

  <div
    v-for="folder in shell.desktopFolders"
    :key="folder.id"
    class="desktop-folder"
    :style="{ left: folder.x + 'px', top: folder.y + 'px' }"
    tabindex="0"
    :data-folder-id="folder.id"
    :data-drop-folder="folder.id"
    :class="{ selected: selectedId === folder.id }"
    :aria-label="'文件夹 ' + folder.name"
    @pointerdown="dragFolder($event, folder)"
    @dblclick="shell.openFolder(folder.id)"
    @keydown="onFolderKey($event, folder.id)"
    @contextmenu.prevent.stop="openItemMenu($event, 'folder', folder.id)"
  >
    <FolderIcon :size="shell.deskIcon" />
    <input
      v-if="renamingId === folder.id"
      v-model="renameText"
      class="folder-rename"
      aria-label="文件夹名称"
      autofocus
      @pointerdown.stop
      @keydown.enter.prevent="commitRename"
      @keydown.esc.prevent="renamingId = null"
      @blur="commitRename"
    />
    <span v-else class="folder-name">{{ folder.name }}</span>
  </div>

  <div
    v-for="file in files"
    :key="file.id"
    class="desktop-file"
    :style="{ left: file.pos.x + 'px', top: file.pos.y + 'px' }"
    :data-entry-id="file.id"
    tabindex="0"
    :class="{ selected: selectedId === file.id }"
    :aria-label="'文件 ' + file.name"
    @pointerdown="dragFile($event, file)"
    @dblclick="openFile(file)"
    @keydown.space.prevent="openFile(file)"
    @contextmenu.prevent.stop="openItemMenu($event, 'file', file.id)"
  >
    <img v-if="file.thumb" class="desktop-thumb" :src="file.thumb" alt="" draggable="false" />
    <span v-else class="desktop-glyph">
      <component :is="glyphFor(file.ext)" :size="Math.round(shell.deskIcon * 0.76)" />
    </span>
    <span class="desktop-file-name">{{ file.name }}</span>
  </div>

  <!-- 10-15 按界面原型：桌面中央的「全局 AI」胶囊去掉，入口统一在顶栏与程序坞 -->
  <button v-if="false" class="assistant-pill" @click="shell.toggleAI()">
    <Orb :size="19" class="pill-icon" :animated="!shell.reduced" />
    <span>全局 AI</span>
    <span class="pill-status">未连接</span>
  </button>

  <DsContextMenu
    v-if="menu"
    :x="menu.x"
    :y="menu.y"
    :items="menuItems"
    label="桌面"
    @select="onMenu"
    @close="menu = null"
  />
  <DsContextMenu
    v-if="itemMenu"
    :x="itemMenu.x"
    :y="itemMenu.y"
    :items="itemMenuItems"
    :label="itemMenu.kind === 'folder' ? '文件夹' : '文件'"
    @select="onItemMenu"
    @close="itemMenu = null"
  />
</template>
