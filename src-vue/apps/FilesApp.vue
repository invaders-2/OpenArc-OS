<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Archive,
  Building2,
  Cloud,
  File as FileIcon,
  FileText,
  Film,
  Folder,
  HardDrive,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Monitor,
  Music,
  RefreshCw,
  Search,
} from "lucide-vue-next";
import DsButton from "../design-system/DsButton.vue";
import DsContextMenu, { type MenuEntry } from "../design-system/DsContextMenu.vue";
import FolderIcon from "../shell/FolderIcon.vue";
import SharedDrivePanel from "./SharedDrivePanel.vue";
import TransferCenter from "./TransferCenter.vue";
import { useShellStore } from "../stores/shell";
import { platformCommand, platformErrorCode, platformErrorText, shareLabel, sharedNodesOf } from "./sharedDrive";
import type { SharedNode } from "./sharedDrive";
import { kindOfExt } from "../wallpapers";

/**
 * 访达（10-15 按界面原型升级）。
 *
 * 口径与既有产品一致（src/main.tsx:1847 起的文件夹窗口）：访达打开的就是「桌面」这个文件夹，
 * 子文件夹来自 oa-folders（parentId 为空 = 桌面根），文件来自文件服务 window.openarc.files。
 * 布局：左侧栏（个人收藏 / 桌面文件夹 / 位置）+ 工具条（前进后退 · 标题 · 搜索 · 视图 · 排序）
 *       + 内容区（分组、图标/列表、多选、右键、拖入导入、改名）+ 状态栏。
 * DOM 复用既有产品的 class（.split / .pane-toolbar / .folder-body / .file-cell …），外观同源。
 *
 * D3-04D 的受控资源库入口（添加到资源库 / 链接 / 导出 / 显示源文件）保留在底部「资源库」条里，
 * [data-d3-04d="files"] 及全部 data-* 钩子不变 —— experiments/vue-resource 探针仍按原契约验收。
 */
const DESKTOP_ID = "desktop";
const THUMB_KINDS = ["image", "video", "doc"];

const shell = useShellStore();
const files = () => window.openarc?.files;

type Row = { id: string; name: string; kind: "folder" | "file"; ext?: string; size?: number; mtime?: number };

/* ── 导航：同一窗口内的历史栈 ─────────────────────────────────────────── */
const history = ref<string[]>([DESKTOP_ID]);
const at = ref(0);
const folderId = computed(() => history.value[at.value]);
/** 传输中心 / 共享盘与文件浏览共用同一个窗口：files = 文件、transfers = 传输中心、shared = 共享盘。 */
const mode = ref<"files" | "transfers" | "shared">("files");
function go(fid: string) {
  mode.value = "files";
  sharedRoot.value = null;
  if (fid === folderId.value) return;
  history.value = [...history.value.slice(0, at.value + 1), fid];
  at.value = history.value.length - 1;
  query.value = "";
  selected.value = [];
}
const folderName = (fid: string) =>
  fid === DESKTOP_ID ? "桌面" : (shell.folders.find((f) => f.id === fid)?.name ?? "文件夹");
const title = computed(() => folderName(folderId.value));

/* ── 视图状态 ────────────────────────────────────────────────────────── */
const view = ref<"grid" | "list">("grid");
const sort = ref<"name" | "date" | "size">("name");
const group = ref(true);
const query = ref("");
const selected = ref<string[]>([]);
const renaming = ref<string | null>(null);

/* ── 数据：子文件夹（本地）+ 文件服务条目 ─────────────────────────────── */
const entries = ref<Record<string, OpenArcFileEntry[]>>({});
const thumbs = ref<Record<string, string>>({});
async function refresh(fid = folderId.value) {
  const b = files();
  if (!b) return;
  try {
    const res = await b.list(fid);
    entries.value = { ...entries.value, [fid]: res?.entries ?? [] };
    for (const e of res?.entries ?? []) {
      const key = fid + "/" + e.id;
      if (!b.thumb || key in thumbs.value || !THUMB_KINDS.includes(kindOfExt(e.ext))) continue;
      thumbs.value = { ...thumbs.value, [key]: "" };
      void b
        .thumb(fid, e.id)
        .then((t) => (thumbs.value = { ...thumbs.value, [key]: t?.ok && t.dataUrl ? t.dataUrl : "" }))
        .catch(() => undefined);
    }
  } catch {
    entries.value = { ...entries.value, [fid]: [] };
  }
}
onMounted(() => {
  void refresh();
  void loadSharedRoots();
});

/* ── 共享盘 / 部门盘（platform/fs/shared/*，只读安全节点投影）──────────── */
const sharedRoots = ref<SharedNode[]>([]);
const sharedRoot = ref<SharedNode | null>(null);
const sharedLoading = ref(false);
const sharedFailure = ref<string | null>(null);
const sharedFailureCode = ref("");

async function loadSharedRoots() {
  sharedLoading.value = true;
  sharedFailure.value = null;
  sharedFailureCode.value = "";
  const res = await platformCommand("platform/fs/shared/roots");
  sharedLoading.value = false;
  if (!res.ok) {
    sharedRoots.value = [];
    sharedFailure.value = platformErrorText(res);
    sharedFailureCode.value = platformErrorCode(res);
    return;
  }
  const value = res.value && typeof res.value === "object" ? (res.value as Record<string, unknown>) : {};
  sharedRoots.value = sharedNodesOf(value.roots);
}
function openSharedRoot(node: SharedNode) {
  sharedRoot.value = node;
  mode.value = "shared";
}

/* 10-16：桌面双击文件夹 → 访达打开到那里（同一窗口复用，已开着就直接跳转） */
function takeFinderRequest() {
  if (!shell.finderRequest.pending) return;
  shell.finderRequest.pending = false;
  go(shell.finderRequest.folderId);
}
watch(() => shell.finderRequest.seq, takeFinderRequest);
takeFinderRequest();
watch(folderId, (fid) => void refresh(fid));

const rows = computed<Row[]>(() => {
  const fid = folderId.value;
  const q = query.value.trim().toLowerCase();
  const list: Row[] = [
    ...shell.folders
      .filter((f) => (f.parentId ?? DESKTOP_ID) === fid)
      .map((f) => ({ id: f.id, name: f.name, kind: "folder" as const })),
    ...(entries.value[fid] ?? []).map((e) => ({
      id: e.id,
      name: e.name,
      kind: "file" as const,
      ext: e.ext,
      size: e.size,
      mtime: e.mtime,
    })),
  ].filter((r) => !q || r.name.toLowerCase().includes(q));
  return list.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    if (sort.value === "date") return (b.mtime ?? 0) - (a.mtime ?? 0);
    if (sort.value === "size") return (b.size ?? 0) - (a.size ?? 0);
    return a.name.localeCompare(b.name, "zh");
  });
});
const GROUP_LABEL: Record<string, string> = {
  folder: "文件夹",
  image: "图片",
  video: "视频",
  audio: "音频",
  doc: "文档",
  text: "文档",
  archive: "压缩包",
  other: "其它",
};
const groupOf = (r: Row) => (r.kind === "folder" ? "folder" : kindOfExt(r.ext ?? ""));
const groups = computed(() => {
  if (!group.value) return [{ label: "", rows: rows.value }];
  const out: { label: string; rows: Row[] }[] = [];
  for (const key of ["folder", "image", "video", "audio", "doc", "text", "archive", "other"]) {
    const bucket = rows.value.filter((r) => groupOf(r) === key);
    if (bucket.length) {
      const prev = out.find((g) => g.label === GROUP_LABEL[key]);
      if (prev) prev.rows.push(...bucket);
      else out.push({ label: GROUP_LABEL[key], rows: bucket });
    }
  }
  return out;
});
const glyphFor = (ext = "") => {
  const k = kindOfExt(ext);
  if (k === "image") return ImageIcon;
  if (k === "video") return Film;
  if (k === "audio") return Music;
  if (k === "doc" || k === "text") return FileText;
  if (k === "archive") return Archive;
  return FileIcon;
};
const fmtSize = (n?: number) =>
  n == null ? "—" : n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
const fmtDate = (t?: number) => (t ? new Date(t).toLocaleDateString("zh-CN") : "—");

/* ── 选择：单击单选，⌘/Ctrl 加减选，Shift 扩选 ─────────────────────── */
function pick(id: string, e: MouseEvent) {
  const cur = selected.value;
  if (e.metaKey || e.ctrlKey) selected.value = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  else if (e.shiftKey && cur.length) {
    const order = rows.value.map((r) => r.id);
    const a = order.indexOf(cur[cur.length - 1]);
    const b = order.indexOf(id);
    selected.value = a >= 0 && b >= 0 ? order.slice(Math.min(a, b), Math.max(a, b) + 1) : [id];
  } else selected.value = [id];
}
function openRow(r: Row) {
  if (r.kind === "folder") go(r.id);
  else void shell.openPreview(folderId.value, r);
}
/** 空格 = 快速查看当前选中的第一个文件（Finder 口径） */
function quickLook() {
  // 再按一次空格 = 关闭（焦点还在条目上，事件到不了 QuickLook 自己的监听）
  if (shell.quickLookOpen) return shell.closeQuickLook();
  const r = rows.value.find((x) => x.id === selected.value[0]);
  if (r && r.kind === "file") void shell.openPreview(folderId.value, r);
}
const KIND_LABEL: Record<string, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  doc: "文档",
  text: "文本",
  archive: "压缩包",
  other: "文件",
};
/** 显示简介：字段口径与既有产品 describeEntry 一致（名称 / 种类 / 大小 / 修改日期 / 位置）。 */
async function showInfo(r: Row | null) {
  if (!r) {
    const sub = shell.folders.filter((f) => (f.parentId ?? DESKTOP_ID) === folderId.value).length;
    const fileCount = (entries.value[folderId.value] ?? []).length;
    shell.showInfo({
      title: title.value,
      subtitle: "文件夹",
      rows: [
        { k: "包含", v: `${sub} 个文件夹，${fileCount} 个文件` },
        { k: "位置", v: folderId.value === DESKTOP_ID ? "本机 · D1" : "桌面" },
      ],
    });
    return;
  }
  if (r.kind === "folder") {
    const sub = shell.folders.filter((f) => f.parentId === r.id).length;
    const listed = await files()?.list(r.id).catch(() => null);
    shell.showInfo({
      title: r.name,
      subtitle: "文件夹",
      rows: [
        { k: "包含", v: `${sub} 个文件夹，${listed?.entries?.length ?? 0} 个文件` },
        { k: "位置", v: title.value },
      ],
    });
    return;
  }
  shell.showInfo({
    title: r.name,
    subtitle: (KIND_LABEL[kindOfExt(r.ext ?? "")] ?? "文件") + (r.ext ? " · ." + r.ext : ""),
    rows: [
      { k: "大小", v: fmtSize(r.size) },
      { k: "修改日期", v: r.mtime ? new Date(r.mtime).toLocaleString("zh-CN") : "—" },
      { k: "位置", v: title.value },
    ],
  });
}

/* ── 应用内拖拽搬运（专用 MIME，与"从电脑拖入"区分）──────────────────── */
const INTERNAL_DND = "application/x-openarc";
const dropTarget = ref<string | null>(null);
const isInternal = (e: DragEvent) => !!e.dataTransfer?.types.includes(INTERNAL_DND);
function onDragStart(e: DragEvent, r: Row) {
  if (!selected.value.includes(r.id)) selected.value = [r.id];
  e.dataTransfer?.setData(INTERNAL_DND, JSON.stringify({ folderId: folderId.value, ids: selected.value }));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}
function onDragOverTarget(e: DragEvent, targetId: string) {
  if (!isInternal(e)) return;
  e.preventDefault();
  e.stopPropagation();
  dropTarget.value = targetId;
}
async function onDropTarget(e: DragEvent, targetId: string) {
  dropTarget.value = null;
  if (!isInternal(e)) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    const payload = JSON.parse(e.dataTransfer?.getData(INTERNAL_DND) || "{}");
    const ids = (payload.ids as string[]).filter((x) => x !== targetId);
    if (!ids.length) return;
    await shell.moveInto(targetId, payload.folderId, ids);
    selected.value = [];
    await refresh(payload.folderId);
    await refresh(targetId);
  } catch {
    /* 载荷损坏：忽略 */
  }
}

/* ── 框选（Finder 的橡皮筋选择）──────────────────────────────────────── */
const marquee = ref<{ x: number; y: number; w: number; h: number } | null>(null);
let marqueeMoved = false;
function startMarquee(e: PointerEvent) {
  if (e.button !== 0 || (e.target as HTMLElement).closest(".file-cell")) return;
  const body = e.currentTarget as HTMLElement;
  const rect = body.getBoundingClientRect();
  const x0 = e.clientX - rect.left + body.scrollLeft;
  const y0 = e.clientY - rect.top + body.scrollTop;
  marqueeMoved = false;
  const move = (ev: PointerEvent) => {
    const x1 = ev.clientX - rect.left + body.scrollLeft;
    const y1 = ev.clientY - rect.top + body.scrollTop;
    const box = { left: Math.min(x0, x1), top: Math.min(y0, y1), right: Math.max(x0, x1), bottom: Math.max(y0, y1) };
    if (box.right - box.left < 4 && box.bottom - box.top < 4) return;
    marqueeMoved = true;
    marquee.value = { x: box.left, y: box.top, w: box.right - box.left, h: box.bottom - box.top };
    const hit: string[] = [];
    body.querySelectorAll<HTMLElement>(".file-cell[data-entry-id]").forEach((cell) => {
      const c = cell.getBoundingClientRect();
      const cx = c.left - rect.left + body.scrollLeft;
      const cy = c.top - rect.top + body.scrollTop;
      if (cx < box.right && cx + c.width > box.left && cy < box.bottom && cy + c.height > box.top)
        hit.push(cell.dataset.entryId || "");
    });
    selected.value = hit.filter(Boolean);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    marquee.value = null;
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
function clearSelection() {
  // 框选松手后浏览器还会补一个 click：这一下不能把刚框好的选择清掉
  if (marqueeMoved) {
    marqueeMoved = false;
    return;
  }
  selected.value = [];
}

/* ── 改名 / 删除 / 新建 ─────────────────────────────────────────────── */
async function commitRename(r: Row, name: string) {
  renaming.value = null;
  const next = name.trim();
  if (!next || next === r.name) return;
  if (r.kind === "folder") shell.renameFolder(r.id, next);
  else {
    await files()?.rename?.(folderId.value, r.id, next);
    await refresh();
  }
}
function startRename(id: string) {
  // 菜单卸载会把焦点还回去：延一拍再进入改名，否则输入框立刻失焦提交
  window.setTimeout(() => {
    renaming.value = id;
    void nextTick(() => document.querySelector<HTMLInputElement>(".finder .folder-rename")?.select());
  }, 0);
}
async function trashFiles(ids: string[]) {
  const b = files();
  if (!b?.trash) return;
  for (const id of ids) await b.trash(folderId.value, id);
  selected.value = [];
  if (ids.length) shell.trashFull = true;
  await refresh();
}
function newFolder() {
  const f = shell.createSubfolder(folderId.value);
  selected.value = [f.id];
  startRename(f.id);
}

/* ── 右键菜单 ──────────────────────────────────────────────────────── */
const menu = ref<{ x: number; y: number; items: MenuEntry[]; act: Record<string, () => void> } | null>(null);
function entryMenu(e: MouseEvent, r: Row) {
  if (!selected.value.includes(r.id)) selected.value = [r.id];
  const ids = selected.value;
  const picked = rows.value.filter((x) => ids.includes(x.id));
  const fileIds = picked.filter((x) => x.kind === "file").map((x) => x.id);
  const one = picked.length === 1 ? picked[0] : null;
  const folderIds = picked.filter((x) => x.kind === "folder").map((x) => x.id);
  const items: MenuEntry[] = [
    { id: "open", label: "打开", disabled: !one },
    { id: "info", label: "显示简介", disabled: !one },
    { id: "rename", label: "重命名", disabled: !one },
    { id: "copy-name", label: picked.length > 1 ? `拷贝 ${picked.length} 项名称` : "拷贝名称" },
    { separator: true },
    { id: "export", label: "导出到电脑…", disabled: !fileIds.length || !files()?.exportTo },
    { separator: true },
    {
      id: "trash",
      label: picked.length > 1 ? `移到回收站（${picked.length} 项）` : "移到回收站",
      danger: true,
    },
  ];
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    items,
    act: {
      open: () => one && openRow(one),
      info: () => one && void showInfo(one),
      rename: () => one && startRename(one.id),
      "copy-name": () => void navigator.clipboard?.writeText(picked.map((x) => x.name).join("\n")),
      export: () => void files()?.exportTo?.(folderId.value, fileIds),
      trash: () =>
        void (async () => {
          // 文件夹整棵子树进回收站；被选中祖先覆盖的子孙不再重复回收
          for (const fid of folderIds) if (shell.folders.some((f) => f.id === fid)) await shell.removeFolder(fid);
          await trashFiles(fileIds);
        })(),
    },
  };
}
function paneMenu(e: MouseEvent, which: "content" | "sort") {
  if (which === "content") selected.value = [];
  const sortItems: MenuEntry[] = [
    { id: "s-name", label: "名称", checked: sort.value === "name" },
    { id: "s-date", label: "日期", checked: sort.value === "date" },
    { id: "s-size", label: "大小", checked: sort.value === "size" },
  ];
  const items: MenuEntry[] =
    which === "sort"
      ? sortItems
      : [
          { id: "new", label: "新建文件夹" },
          { id: "info", label: "显示简介" },
          { separator: true },
          { id: "group", label: group.value ? "关闭群组" : "使用群组" },
          { header: "排序方式" },
          ...sortItems,
          { separator: true },
          { id: "v-grid", label: "显示为图标", checked: view.value === "grid" },
          { id: "v-list", label: "显示为列表", checked: view.value === "list" },
        ];
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = {
    x: which === "sort" ? r.left : e.clientX,
    y: which === "sort" ? r.bottom + 4 : e.clientY,
    items,
    act: {
      new: newFolder,
      info: () => void showInfo(null),
      group: () => (group.value = !group.value),
      "s-name": () => (sort.value = "name"),
      "s-date": () => (sort.value = "date"),
      "s-size": () => (sort.value = "size"),
      "v-grid": () => (view.value = "grid"),
      "v-list": () => (view.value = "list"),
    },
  };
}
function onMenu(id: string) {
  const fn = menu.value?.act[id];
  menu.value = null;
  fn?.();
}

/* ── 从电脑拖入 = 拷贝进当前文件夹 ─────────────────────────────────── */
const dropping = ref(false);
async function onDrop(e: DragEvent) {
  dropping.value = false;
  const b = files();
  if (!b || !e.dataTransfer?.files.length) return;
  const paths = Array.from(e.dataTransfer.files)
    .map((f) => b.pathFor(f))
    .filter(Boolean);
  if (!paths.length) return;
  await b.import(folderId.value, paths);
  await refresh();
}

const status = computed(() => {
  const n = rows.value.length;
  const s = selected.value.length;
  return s ? `已选 ${s} 项，共 ${n} 项` : `${n} 项`;
});
const topFolders = computed(() => shell.folders.filter((f) => !f.parentId));

/* ── D3-04D：受控的资源库入口（逻辑与契约原样保留）──────────────────── */
type ResourceItem = { resourceId: string; name: string; storageMode: string; resourceRef: string };
const bridge = () => (window as any).openarc?.resource;
const libItems = ref<ResourceItem[]>([]);
const libError = ref<string | null>(null);
const libNotice = ref<string | null>(null);
const exportRef = ref("");
async function cmd(payload: Record<string, unknown>): Promise<any> {
  const b = bridge();
  if (!b) return { ok: false, error: "NO_BRIDGE" };
  try {
    return await b.command(payload);
  } catch {
    return { ok: false, error: "INTERNAL_ERROR" };
  }
}
async function add(mode: "import" | "link") {
  const res = await cmd({ type: mode === "import" ? "resource/pickImport" : "resource/pickLink" });
  if (res.ok) {
    libItems.value = [...libItems.value, res.resource];
    libNotice.value = mode === "import" ? "已复制到资源库" : "已在资源库里链接原文件";
    libError.value = null;
  } else if (res.error !== "CANCELLED") {
    libError.value = res.error;
  }
}
async function doExport() {
  const res = await cmd({ type: "resource/export", resourceRef: exportRef.value.trim() });
  if (res.ok) {
    libNotice.value = "已导出 " + res.bytes + " 字节";
    libError.value = null;
  } else if (res.error !== "CANCELLED") {
    libError.value = res.error;
  }
}
async function doReveal() {
  const res = await cmd({ type: "resource/revealSource", resourceRef: exportRef.value.trim() });
  if (!res.ok) libError.value = res.error;
}
</script>

<template>
  <div class="split finder">
    <nav class="split-side" aria-label="访达边栏">
      <div class="split-section">个人收藏</div>
      <button
        type="button"
        class="split-nav"
        :class="{ 'drop-target': dropTarget === 'side:desktop' }"
        :aria-current="folderId === 'desktop' ? 'true' : undefined"
        @click="go('desktop')"
        @dragover="onDragOverTarget($event, 'desktop'), (dropTarget = 'side:desktop')"
        @dragleave="dropTarget = null"
        @drop="onDropTarget($event, 'desktop')"
      >
        <Monitor :size="16" /> <span class="split-nav-label">桌面</span>
      </button>
      <template v-if="topFolders.length">
        <div class="split-section">桌面文件夹</div>
        <button
          v-for="f in topFolders"
          :key="f.id"
          type="button"
          class="split-nav"
          :aria-current="folderId === f.id ? 'true' : undefined"
          :class="{ 'drop-target': dropTarget === 'side:' + f.id }"
          @click="go(f.id)"
          @dragover="onDragOverTarget($event, f.id), (dropTarget = 'side:' + f.id)"
          @dragleave="dropTarget = null"
          @drop="onDropTarget($event, f.id)"
        >
          <Folder :size="16" /> <span class="split-nav-label">{{ f.name }}</span>
        </button>
      </template>
      <div class="split-section">共享盘</div>
      <div class="finder-shared" data-finder-shared>
        <p v-if="sharedLoading" class="finder-shared-hint" data-shared-roots-loading>正在读取共享盘…</p>
        <div v-else-if="sharedFailure" class="finder-shared-block">
          <p class="finder-shared-error" role="alert" :data-shared-roots-error="sharedFailureCode">{{ sharedFailure }}</p>
          <DsButton size="sm" variant="secondary" :status="sharedLoading ? 'loading' : 'idle'" @click="loadSharedRoots">
            <RefreshCw :size="13" :stroke-width="1.5" /> 重新读取
          </DsButton>
        </div>
        <template v-else-if="sharedRoots.length">
          <button
            v-for="node in sharedRoots"
            :key="node.id"
            type="button"
            class="split-nav"
            :aria-current="mode === 'shared' && sharedRoot && sharedRoot.id === node.id ? 'true' : undefined"
            :data-shared-root="node.id"
            @click="openSharedRoot(node)"
          >
            <Building2 v-if="node.share && node.share.startsWith('department:')" :size="16" />
            <Cloud v-else :size="16" />
            <span class="split-nav-label" :title="node.name">{{ node.name }}</span>
            <small class="planned-count">{{ shareLabel(node.share) }}</small>
          </button>
        </template>
        <p v-else class="finder-shared-hint" data-shared-roots-empty>没有可见的共享盘：公共盘为空，且你不属于任何部门。权限由后端判定，界面不伪造入口。</p>
      </div>
      <div class="split-section">位置</div>
      <div class="split-nav finder-location"><HardDrive :size="16" /> <span class="split-nav-label">本机 · D1</span></div>
      <button
        type="button"
        class="split-nav"
        data-finder-transfers
        :aria-current="mode === 'transfers' ? 'true' : undefined"
        @click="mode = 'transfers'; sharedRoot = null"
      >
        <ArrowUpDown :size="16" /> <span class="split-nav-label">传输中心</span>
      </button>
    </nav>

    <div class="split-main finder-main" @click.self="clearSelection">
      <TransferCenter v-if="mode === 'transfers'" />
      <SharedDrivePanel v-else-if="mode === 'shared' && sharedRoot" :key="sharedRoot.id" :root="sharedRoot" />
      <template v-else>
      <div class="pane-toolbar">
        <button class="icon-button" aria-label="后退" :disabled="at <= 0" @click="at -= 1">
          <ArrowLeft :size="15" />
        </button>
        <button class="icon-button" aria-label="前进" :disabled="at >= history.length - 1" @click="at += 1">
          <ArrowRight :size="15" />
        </button>
        <strong class="pane-title">{{ title }}</strong>
        <div class="toolbar-spacer" />
        <div class="segmented" role="group" aria-label="查看方式">
          <button :aria-pressed="view === 'grid'" aria-label="图标" @click="view = 'grid'"><LayoutGrid :size="15" /></button>
          <button :aria-pressed="view === 'list'" aria-label="列表" @click="view = 'list'"><List :size="15" /></button>
        </div>
        <button class="icon-button" aria-label="排序方式" aria-haspopup="menu" @click="paneMenu($event, 'sort')">
          <ArrowUpDown :size="15" />
        </button>
        <label class="search-field">
          <Search :size="13" />
          <input v-model="query" type="search" aria-label="搜索此文件夹" placeholder="搜索" />
        </label>
      </div>

      <div
        class="folder-body"
        :class="{ 'drop-active': dropping }"
        :data-drop-folder="folderId"
        tabindex="-1"
        :data-marquee="marquee ? 'files' : undefined"
        @click.self="clearSelection"
        @pointerdown="startMarquee"
        @keydown.space.prevent="quickLook"
        @contextmenu.prevent.stop="paneMenu($event, 'content')"
        @dragover.prevent="dropping = !isInternal($event) && !!files()"
        @dragleave="dropping = false"
        @drop.prevent="!isInternal($event) && onDrop($event)"
      >
        <div v-if="!rows.length" class="empty-content">
          <FolderIcon :size="64" />
          <span class="badge">{{ query ? "无匹配项" : "暂无内容" }}</span>
          <p v-if="query">没有匹配「{{ query }}」的项目。</p>
          <p v-else>把电脑里的文件、图片、视频、文档拖到这里即可存入；右键可新建子文件夹。</p>
        </div>
        <div v-else class="file-groups">
          <div v-if="view === 'list'" class="file-list-head" aria-hidden="true">
            <span>名称</span><span>修改日期</span><span>大小</span>
          </div>
          <div v-for="g in groups" :key="g.label || 'all'" class="file-group-block">
            <div v-if="g.label" class="split-section">{{ g.label }}</div>
            <div :class="view === 'grid' ? 'file-grid' : 'file-list'">
              <div
                v-for="r in g.rows"
                :key="r.kind + r.id"
                class="file-cell"
                :class="{ selected: selected.includes(r.id), 'drop-target': dropTarget === r.id }"
                draggable="true"
                @dragstart="onDragStart($event, r)"
                @dragover="r.kind === 'folder' && onDragOverTarget($event, r.id)"
                @dragleave="dropTarget === r.id && (dropTarget = null)"
                @drop="r.kind === 'folder' && onDropTarget($event, r.id)"
                role="button"
                tabindex="0"
                :title="r.name"
                :data-entry-id="r.id"
                @click.stop="pick(r.id, $event)"
                @dblclick="openRow(r)"
                @keydown.enter="openRow(r)"
                @keydown.f2="startRename(r.id)"
                @keydown.space.prevent.stop="quickLook"
                @contextmenu.prevent.stop="entryMenu($event, r)"
              >
                <FolderIcon v-if="r.kind === 'folder'" :size="view === 'grid' ? 46 : 22" />
                <img
                  v-else-if="thumbs[folderId + '/' + r.id]"
                  class="file-thumb"
                  :src="thumbs[folderId + '/' + r.id]"
                  alt=""
                  draggable="false"
                />
                <span v-else class="file-glyph"><component :is="glyphFor(r.ext)" :size="view === 'grid' ? 40 : 20" /></span>
                <input
                  v-if="renaming === r.id"
                  class="folder-rename"
                  aria-label="名称"
                  :value="r.name"
                  autofocus
                  @click.stop
                  @dblclick.stop
                  @keydown.stop.enter="commitRename(r, ($event.target as HTMLInputElement).value)"
                  @keydown.stop.esc="renaming = null"
                  @blur="commitRename(r, ($event.target as HTMLInputElement).value)"
                />
                <span v-else class="file-name">{{ r.name }}</span>
                <template v-if="view === 'list'">
                  <span class="file-meta">{{ r.kind === "folder" ? "—" : fmtDate(r.mtime) }}</span>
                  <span class="file-meta">{{ r.kind === "folder" ? "文件夹" : fmtSize(r.size) }}</span>
                </template>
              </div>
            </div>
          </div>
        </div>
        <div
          v-if="marquee"
          class="marquee"
          aria-hidden="true"
          :style="{ left: marquee.x + 'px', top: marquee.y + 'px', width: marquee.w + 'px', height: marquee.h + 'px' }"
        />
      </div>

      <footer class="finder-status">
        <span>{{ status }}</span>
        <span>本机 · D1</span>
      </footer>

      <!-- D3-04D 受控资源库入口：契约原样保留 -->
      <section class="finder-library" data-d3-04d="files" aria-label="资源库">
        <div class="gov-form">
          <b class="finder-library-label">资源库</b>
          <DsButton variant="primary" size="sm" data-d3-04d-files-import @click="add('import')" title="复制一份由资源库管理">添加到资源库</DsButton>
          <DsButton variant="secondary" size="sm" data-d3-04d-files-link @click="add('link')" title="不复制，只记录原文件位置">链接原文件</DsButton>
          <div class="toolbar-spacer" />
          <input v-model="exportRef" data-d3-04d-files-ref placeholder="resource://..." />
          <DsButton variant="secondary" size="sm" data-d3-04d-files-export @click="doExport">导出为普通文件</DsButton>
          <DsButton variant="ghost" size="sm" data-d3-04d-files-reveal @click="doReveal">显示源文件</DsButton>
        </div>
        <p v-if="libError" class="gov-error" role="alert" data-d3-04d-files-error>{{ libError }}</p>
        <p v-if="libNotice" class="gov-notice" role="status" data-d3-04d-files-notice>{{ libNotice }}</p>
        <ul v-show="libItems.length" class="gov-list" data-d3-04d-files-items>
          <li v-for="r in libItems" :key="r.resourceId" :data-d3-04d-file="r.resourceId" class="gov-row">
            <span class="gov-name">{{ r.name }}</span>
            <span class="gov-meta">{{ r.storageMode }} · {{ r.resourceRef }}</span>
          </li>
        </ul>
      </section>
      </template>
    </div>

    <Teleport v-if="menu" to=".desktop">
      <DsContextMenu :x="menu.x" :y="menu.y" :items="menu.items" label="访达" @select="onMenu" @close="menu = null" />
    </Teleport>
  </div>
</template>


<style scoped>
/* 共享盘入口只写侧栏状态；主体在 SharedDrivePanel（自带 scoped 样式）。 */
.finder-shared {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.finder-shared-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: 0 var(--space-2);
}
.finder-shared-hint {
  margin: 0;
  padding: 4px var(--space-2);
  font-size: var(--fs-micro);
  line-height: var(--lh-relaxed);
  color: var(--muted);
  overflow-wrap: anywhere;
}
.finder-shared-error {
  margin: 0;
  font-size: var(--fs-micro);
  line-height: var(--lh-relaxed);
  color: var(--failed);
  overflow-wrap: anywhere;
}
.finder-shared .split-nav {
  width: 100%;
}
</style>
