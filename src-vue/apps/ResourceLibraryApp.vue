<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import DsButton from "../design-system/DsButton.vue";
import DsDialog from "../design-system/DsDialog.vue";
import DsSearchField from "../design-system/DsSearchField.vue";
import { Brain, Clock, Code2, FileText, FolderOpen, Image as ImageIcon, LayoutGrid, Layers, List, Music, Sparkles, Star, Trash2, Type, Video } from "lucide-vue-next";

/* 10-15 按原型：侧栏 / 卡片的线性图标与中文类型名 */
const NAV_ICON: Record<string, unknown> = {
  all: Layers, memory: Brain, documents: FileText, images: ImageIcon, videos: Video, audio: Music, code: Code2,
  prompts: Type, generated: Sparkles, favorites: Star, recent: Clock, trash: Trash2,
};
const TYPE_ICON: Record<string, unknown> = {
  image: ImageIcon, video: Video, audio: Music, document: FileText, text: FileText, code: Code2, memory: Brain, prompt: Type, generated: Sparkles,
};
const TYPE_LABEL: Record<string, string> = {
  image: "图片", video: "视频", audio: "音频", document: "文档", text: "文本", code: "代码", memory: "Memory", prompt: "Prompt", generated: "生成产物",
};

/**
 * D3-04B · Resource Library App（三栏：Navigation / Content / Inspector）。
 *
 * 对齐 src/resource/ResourceLibraryApp.tsx：只通过 window.openarc.resource.command 访问资源，
 * 授权 / 查询过滤 / 版本 / Trash 全部由主进程 ResourceService 决定，本组件只做展示与 UX。
 * 所有 data-d3-04a / 04b / 04c 契约逐条保留，DOM 结构、class 名与 React 逐项一致。
 */
type Descriptor = {
  resourceId: string;
  resourceRef: string;
  resourceType: string;
  mimeType: string;
  name: string;
  description: string;
  storageMode: string;
  size: number | null;
  version: number;
  scope: string | null;
  departmentId: string | null;
  collectionId: string | null;
  ownerUserId: string | null;
  storageDeviceId: string | null;
  memorySubtype: string | null;
  language: string | null;
  availability: string;
  trashed: boolean;
  favorite: boolean;
  recentAt: number | null;
  createdAt: number;
  updatedAt: number;
  source?: { label?: string };
  snippet?: { text: string; spans: { text: string; match: boolean }[]; truncated: boolean; matched: boolean };
  matchedFields?: string[];
  indexStatus?: string;
};

type PreviewState = {
  kind: string;
  availability: string;
  mimeType?: string;
  size?: number | null;
  version?: number;
  text?: string;
  truncated?: boolean;
  url?: string;
  error?: string;
  thumbnailUrl?: string;
};

type CollectionView = { collectionId: string; name: string; description: string; resourceCount: number; editable: boolean; scope: string };
type TagView = { tagId: string; name: string; source?: string };
type VersionView = { version: number; size: number | null; createdAt: number; createdBy: string | null; source: string };

type Inspector = {
  resource: Descriptor;
  location: { storageMode: string; deviceId: string | null; availability: string };
  capabilities: { effective: Record<string, boolean>; effectiveActions: string[]; userActions: string[]; appActions: string[]; userDenied: string | null; appDenied: string | null };
  tags: TagView[];
  collection: CollectionView | null;
  versions: VersionView[];
  relations: { outgoing: number; incoming: number };
  provenance: { source: string; memorySubtype: string | null; language: string | null; generatedSourceTaskId: string | null; generatedSourceCallId: string | null; generatedSourceModel: string | null };
  trashed: boolean;
  favorite: boolean;
};

const NAV: { id: string; label: string; empty: string }[] = [
  { id: "all", label: "全部", empty: "还没有资源。用「导入」或「新建」添加第一个。" },
  { id: "memory", label: "Memory", empty: "暂无 Memory。用「新建」创建一条。" },
  { id: "documents", label: "文档", empty: "暂无文档资源。" },
  { id: "images", label: "图片", empty: "暂无图片资源。" },
  { id: "videos", label: "视频", empty: "暂无视频资源。" },
  { id: "audio", label: "音频", empty: "暂无音频资源。" },
  { id: "code", label: "代码", empty: "暂无代码资源。" },
  { id: "prompts", label: "Prompt", empty: "暂无 Prompt 资源。" },
  { id: "generated", label: "生成产物", empty: "暂无生成产物。" },
  { id: "favorites", label: "收藏", empty: "还没有收藏任何资源。" },
  { id: "recent", label: "最近", empty: "还没有最近打开的记录。" },
  { id: "trash", label: "回收站", empty: "回收站是空的。" },
];

const CREATE_TYPES = [
  { id: "memory", label: "Memory" },
  { id: "text", label: "文本" },
  { id: "code", label: "代码" },
  { id: "prompt", label: "Prompt" },
];
const MEMORY_SUBTYPES = [
  { id: "personal-preference", label: "个人偏好" },
  { id: "project-memory", label: "项目记忆" },
  { id: "decision-memory", label: "决策记忆" },
  { id: "conversation-memory", label: "对话记忆" },
  { id: "agent-memory", label: "Agent 记忆" },
];
const AVAILABILITY_LABEL: Record<string, string> = {
  AVAILABLE: "可用",
  SOURCE_MISSING: "源文件丢失",
  SOURCE_CHANGED: "源文件已变化",
  DEVICE_OFFLINE: "设备离线",
  DEVICE_DISABLED: "设备已停用",
  DEVICE_REVOKED: "设备已撤销",
  DEVICE_UNKNOWN: "设备未知",
  INTEGRITY_FAILED: "完整性错误",
  TRASHED: "回收站",
  UNKNOWN: "未知",
};

const fmtSize = (n: number | null) => (n == null ? "-" : n < 1024 ? n + " bytes" : n < 1024 * 1024 ? (n / 1024).toFixed(1) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB");
const fmtTime = (t: number | null) => (t == null ? "-" : new Date(t).toLocaleString());

const bridge = () => (window as any).openarc?.resource;
const hasBridge = !!bridge();

const category = ref("all");
const view = ref<"grid" | "list">(typeof localStorage !== "undefined" && localStorage.getItem("oa-resource-view") === "list" ? "list" : "grid");
const query = ref("");
const sort = ref("updated");
const direction = ref("desc");
const filterCollection = ref<string | null>(null);
const filterTag = ref<string | null>(null);
const items = ref<Descriptor[]>([]);
const total = ref(0);
const hasMore = ref(false);
const offset = ref(0);
const collections = ref<CollectionView[]>([]);
const tags = ref<TagView[]>([]);
const selectedId = ref<string | null>(null);
const inspector = ref<Inspector | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const searchMode = ref(false);
const preview = ref<PreviewState | null>(null);
const indexStatus = ref<{ indexStatus: string; stale: boolean; documentVersion: number | null; resourceVersion: number | null; indexedAt: number | null } | null>(null);
const reindexing = ref<{ processed: number; remaining: number; total: number } | null>(null);

const createOpen = ref(false);
const collectionOpen = ref(false);
const editor = ref<{ resourceRef: string; name: string; content: string; expectedVersion: number; resourceType: string } | null>(null);
const conflict = ref<{ resourceRef: string; draft: string; name: string; currentVersion: number } | null>(null);
const pendingDelete = ref<{ resourceRef: string; name: string; references: number } | null>(null);

const createType = ref("memory");
const createName = ref("");
const createSubtype = ref("personal-preference");
const createCollectionId = ref("");
const createTags = ref("");
const createContent = ref("");
const collectionName = ref("");
const tagDraft = ref("");

async function cmd(payload: Record<string, unknown>): Promise<any> {
  const b = bridge();
  if (!b) return { ok: false, error: "NO_BRIDGE" };
  try {
    return await b.command(payload);
  } catch {
    return { ok: false, error: "INTERNAL_ERROR" };
  }
}

async function reload(nextOffset = 0) {
  if (!bridge()) return;
  busy.value = true;
  const filter: Record<string, unknown> = {};
  if (filterCollection.value) filter.collectionId = filterCollection.value;
  if (filterTag.value) filter.tagId = filterTag.value;
  const q = query.value.trim();
  searchMode.value = !!q;
  if (q) filter.category = category.value;
  const res = q
    ? await cmd({ type: "resource/search", query: q, filter, limit: 60, offset: nextOffset })
    : await cmd({ type: "resource/query", category: category.value, filter, sort: sort.value, direction: direction.value, limit: 60, offset: nextOffset });
  if (res && res.ok) {
    items.value = nextOffset === 0 ? res.items : [...items.value, ...res.items];
    total.value = res.total;
    hasMore.value = !!res.hasMore;
    offset.value = nextOffset;
    error.value = q && res.totalIsLowerBound ? "结果可能不完整（索引扫描达到上限）" : null;
  } else {
    error.value = String((res && res.error) || "INTERNAL_ERROR");
  }
  busy.value = false;
}

async function loadPreview(resourceRef: string) {
  preview.value = null;
  const res = await cmd({ type: "resource/preview", resourceRef });
  if (res && res.ok) {
    preview.value = res as PreviewState;
    if (res.kind === "image") {
      const th = await cmd({ type: "resource/thumbnail", resourceRef });
      if (th && th.ok && th.url && preview.value) preview.value = { ...preview.value, thumbnailUrl: th.url };
    }
  } else {
    const err = String((res && res.error) || "ERROR");
    preview.value = { kind: "error", availability: err, error: err };
  }
}

async function loadIndexStatus(resourceRef: string) {
  const res = await cmd({ type: "resource/indexStatus", resourceRef });
  indexStatus.value = res && res.ok ? res : null;
}

async function rebuildIndex() {
  reindexing.value = { processed: 0, remaining: 1, total: 0 };
  for (let i = 0; i < 500; i += 1) {
    const res = await cmd({ type: "resource/reindex", mode: "all", limit: 200 });
    if (!res || !res.ok) {
      error.value = String((res && res.error) || "INDEX_FAILED");
      break;
    }
    reindexing.value = { processed: res.processed, remaining: res.remaining, total: res.total };
    if (res.remaining <= 0) break;
  }
  if (selectedId.value) void loadIndexStatus(selectedId.value);
  await reload(0);
}

async function loadCollections() {
  const res = await cmd({ type: "resource/listCollections" });
  if (res && res.ok) collections.value = res.items || [];
}

async function loadTags() {
  const res = await cmd({ type: "resource/listTags" });
  if (res && res.ok) tags.value = res.items || [];
}

onMounted(() => {
  void reload(0);
  void loadCollections();
});
watch([category, query, filterCollection, filterTag, sort, direction], () => {
  void reload(0);
});
watch(view, (v) => {
  if (typeof localStorage !== "undefined") localStorage.setItem("oa-resource-view", v);
});

async function select(resourceId: string, opts: { touch?: boolean } = {}) {
  const touch = opts.touch !== false;
  selectedId.value = resourceId;
  const res = await cmd({ type: "resource/inspector", resourceRef: resourceId });
  inspector.value = res && res.ok ? (res as Inspector) : null;
  if (touch) void cmd({ type: "resource/touchRecent", resourceRef: resourceId });
  void loadPreview(resourceId);
  void loadIndexStatus(resourceId);
}

async function afterMutation(message: string) {
  notice.value = message;
  await Promise.all([reload(0), loadCollections(), loadTags()]);
  if (selectedId.value) {
    const res = await cmd({ type: "resource/inspector", resourceRef: selectedId.value });
    if (res && res.ok) inspector.value = res as Inspector;
    else if (!res || res.error === "NOT_FOUND_OR_FORBIDDEN") {
      inspector.value = null;
      selectedId.value = null;
    }
  }
}

async function doImport() {
  error.value = null;
  const res = await cmd({ type: "resource/pickImport" });
  if (!res || !res.ok) {
    if (res && res.error !== "CANCELLED") error.value = String(res.error);
    return;
  }
  await afterMutation("已导入并复制到 OpenArc");
  await select(res.resource.resourceId);
}
async function doLink() {
  error.value = null;
  const res = await cmd({ type: "resource/pickLink" });
  if (!res || !res.ok) {
    if (res && res.error !== "CANCELLED") error.value = String(res.error);
    return;
  }
  await afterMutation("已创建 Linked 资源（未复制内容）");
  await select(res.resource.resourceId);
}

async function openEditor(resourceRef: string) {
  const info = await cmd({ type: "resource/get", resourceRef });
  if (!info || !info.ok) {
    error.value = String((info && info.error) || "INTERNAL_ERROR");
    return;
  }
  const read = await cmd({ type: "resource/readText", resourceRef });
  if (!read || !read.ok) {
    error.value = String((read && read.error) || "INTERNAL_ERROR");
    return;
  }
  editor.value = { resourceRef, name: info.resource.name, content: read.text, expectedVersion: info.resource.version, resourceType: info.resource.resourceType };
}

async function saveEditor() {
  if (!editor.value) return;
  const res = await cmd({ type: "resource/replaceText", resourceRef: editor.value.resourceRef, content: editor.value.content, expectedVersion: editor.value.expectedVersion });
  if (res && res.ok) {
    editor.value = null;
    await afterMutation("已保存为新版本 v" + res.resource.version);
    return;
  }
  if (res && res.error === "VERSION_CONFLICT") {
    const current = Number(res.current || 0);
    conflict.value = { resourceRef: editor.value.resourceRef, draft: editor.value.content, name: editor.value.name, currentVersion: current };
    editor.value = null;
    return;
  }
  error.value = String((res && res.error) || "INTERNAL_ERROR");
}

async function saveAsNew() {
  if (!conflict.value) return;
  const res = await cmd({ type: "resource/create", resourceType: "text", name: conflict.value.name + " (副本)", content: conflict.value.draft });
  if (res && res.ok) {
    conflict.value = null;
    await afterMutation("已另存为新资源");
    await select(res.resource.resourceId);
  } else {
    error.value = String((res && res.error) || "INTERNAL_ERROR");
  }
}

async function confirmPermanentDelete(resourceRef: string, name: string) {
  const res = await cmd({ type: "resource/incomingReferences", resourceRef });
  const references = res && res.ok ? (res.items || []).length : 0;
  pendingDelete.value = { resourceRef, name, references };
}

const navItems = NAV;
const currentNav = computed(() => navItems.find((n) => n.id === category.value));
const inTrash = computed(() => category.value === "trash");
const caps = computed<Record<string, boolean>>(() => inspector.value?.capabilities?.effective || {});
const canEdit = computed(() => !!caps.value.canEdit);
const canDelete = computed(() => !!caps.value.canDelete);

function chooseNav(id: string) {
  category.value = id;
  filterCollection.value = null;
  filterTag.value = null;
  selectedId.value = null;
  inspector.value = null;
}
function chooseUnfiled() {
  filterCollection.value = "unfiled";
  category.value = "all";
}
function chooseCollection(collectionId: string) {
  filterCollection.value = collectionId;
  category.value = "all";
}
function toggleTag(tagId: string) {
  filterTag.value = filterTag.value === tagId ? null : tagId;
  category.value = "all";
}

async function toggleFavorite() {
  if (!inspector.value) return;
  const wasFavorite = inspector.value.favorite;
  await cmd({ type: "resource/setFavorite", resourceRef: inspector.value.resource.resourceId, favorite: !wasFavorite });
  await afterMutation(wasFavorite ? "已取消收藏" : "已收藏");
}
async function deleteSelected() {
  if (!inspector.value) return;
  await cmd({ type: "resource/delete", resourceRef: inspector.value.resource.resourceId });
  await afterMutation("已移入回收站");
}
async function restoreSelected() {
  if (!inspector.value) return;
  await cmd({ type: "resource/restore", resourceRef: inspector.value.resource.resourceId });
  await afterMutation("已恢复");
}
async function restoreVersion(version: number) {
  if (!inspector.value) return;
  const current = inspector.value.resource.version;
  await cmd({ type: "resource/restoreVersion", resourceRef: inspector.value.resource.resourceId, version, expectedVersion: current });
  await afterMutation("已恢复为 v" + (current + 1));
}
async function removeTag(tagId: string) {
  if (!inspector.value) return;
  await cmd({ type: "resource/removeTag", resourceRef: inspector.value.resource.resourceId, tagId });
  await afterMutation("已移除标签");
}
async function addTag() {
  if (!inspector.value) return;
  const name = tagDraft.value;
  if (!name.trim()) return;
  await cmd({ type: "resource/assignTag", resourceRef: inspector.value.resource.resourceId, name });
  tagDraft.value = "";
  await afterMutation("已添加标签");
}
async function onCollectionChange(event: Event) {
  if (!inspector.value) return;
  const value = (event.target as HTMLSelectElement).value;
  await cmd({ type: "resource/setCollection", resourceRef: inspector.value.resource.resourceId, collectionId: value || null });
  await afterMutation("已移动 Collection");
}
async function renameCollection() {
  if (!inspector.value || !inspector.value.collection) return;
  const name = window.prompt("重命名 Collection", inspector.value.collection.name);
  if (name) {
    await cmd({ type: "resource/updateCollection", collectionId: inspector.value.collection.collectionId, name });
    await afterMutation("Collection 已重命名");
  }
}
async function deleteCollection() {
  if (!inspector.value || !inspector.value.collection) return;
  const res = await cmd({ type: "resource/deleteCollection", collectionId: inspector.value.collection.collectionId });
  await afterMutation(res && res.ok ? "Collection 已删除，资源转入 Unfiled（" + res.movedToUnfiled + "）" : "删除失败");
}

async function submitCreate() {
  const res = await cmd({
    type: "resource/create",
    resourceType: createType.value,
    name: createName.value,
    content: createContent.value,
    memorySubtype: createSubtype.value || null,
    collectionId: createCollectionId.value || null,
    tags: createTags.value.split(",").map((s) => s.trim()).filter(Boolean),
  });
  if (res && res.ok) {
    createOpen.value = false;
    await afterMutation("已创建资源");
    await select(res.resource.resourceId);
  } else {
    error.value = String((res && res.error) || "INTERNAL_ERROR");
  }
}

async function submitCollection() {
  const res = await cmd({ type: "resource/createCollection", name: collectionName.value });
  if (res && res.ok) {
    collectionOpen.value = false;
    await afterMutation("Collection 已创建");
  } else {
    error.value = String((res && res.error) || "INTERNAL_ERROR");
  }
}

function openCreate() {
  createOpen.value = true;
}
function openCollection() {
  collectionOpen.value = true;
}
async function confirmPermanent() {
  if (!pendingDelete.value) return;
  const res = await cmd({ type: "resource/permanentDelete", resourceRef: pendingDelete.value.resourceRef });
  pendingDelete.value = null;
  await afterMutation(res && res.ok ? "已永久删除" : "删除失败");
}
async function conflictReload() {
  if (!conflict.value) return;
  await select(conflict.value.resourceRef);
  conflict.value = null;
}
async function reindexOne() {
  if (!inspector.value) return;
  const ref = inspector.value.resource.resourceId;
  await cmd({ type: "resource/reindex", resourceRef: ref });
  void loadIndexStatus(ref);
  void reload(0);
}
</script>

<template>
  <div v-if="!hasBridge" class="split">
    <div class="split-main">
      <div class="empty-content" data-d3-04b="unavailable">
        <h1>资源库</h1>
        <span class="badge">不可用</span>
        <p>资源存储需要主进程服务。当前环境没有 OpenArc 服务。</p>
      </div>
    </div>
  </div>

  <div v-else class="split">
    <div class="split-main">
      <h1>资源库</h1>
      <div class="rl-app" :class="{ 'has-inspector': !!inspector }" data-d3-04a="resource-library" data-d3-04b="app">
        <nav class="rl-nav" aria-label="资源库导航">
          <div class="rl-nav-section">分类</div>
          <button
            v-for="n in navItems"
            :key="n.id"
            type="button"
            class="rl-nav-item"
            :class="{ 'is-active': category === n.id }"
            :data-d3-04b-nav="n.id"
            :aria-current="category === n.id ? 'page' : undefined"
            @click="chooseNav(n.id)"
          >
            <component :is="NAV_ICON[n.id] || FileText" :size="15" /> {{ n.label }}
          </button>
          <div class="rl-nav-section">
            收藏集
            <button type="button" class="rl-nav-add" aria-label="新建收藏集" data-d3-04b-action="new-collection" @click="openCollection">+</button>
          </div>
          <button type="button" class="rl-nav-item" :class="{ 'is-active': filterCollection === 'unfiled' }" data-d3-04b-nav="unfiled" @click="chooseUnfiled"><FolderOpen :size="15" /> 未归类</button>
          <button
            v-for="c in collections"
            :key="c.collectionId"
            type="button"
            class="rl-nav-item"
            :class="{ 'is-active': filterCollection === c.collectionId }"
            :data-d3-04b-nav="'col:' + c.collectionId"
            @click="chooseCollection(c.collectionId)"
          >
            {{ c.name }} <span class="rl-count">{{ c.resourceCount }}</span>
          </button>
          <div v-if="tags.length" class="rl-nav-section">标签</div>
          <div class="rl-tag-list">
            <button v-for="t in tags" :key="t.tagId" type="button" class="rl-tag" :class="{ 'is-active': filterTag === t.tagId }" :data-d3-04b-tag="t.tagId" @click="toggleTag(t.tagId)">{{ t.name }}</button>
          </div>
        </nav>

        <section class="rl-content" aria-label="资源列表">
          <div class="rl-head">
            <h2 class="rl-title">{{ currentNav ? currentNav.label : "全部" }} <small>{{ total }} 项</small></h2>
          </div>
          <div class="rl-toolbar">
            <DsSearchField :value="query" placeholder="全文搜索（本地索引，中文可用）" label="全文搜索" @update:value="query = $event" />
            <div class="rl-toolbar-actions">
              <DsButton variant="secondary" size="sm" data-d3-04a-action="import" @click="doImport">导入</DsButton>
              <DsButton variant="secondary" size="sm" data-d3-04a-action="link" @click="doLink">链接文件</DsButton>
              <DsButton variant="primary" size="sm" data-d3-04b-action="create" @click="openCreate">新建</DsButton>
              <label class="rl-field">
                <span>排序</span>
                <select v-model="sort" aria-label="排序字段">
                  <option value="updated">更新时间</option>
                  <option value="created">创建时间</option>
                  <option value="name">名称</option>
                  <option value="size">大小</option>
                </select>
              </label>
              <DsButton variant="ghost" size="sm" aria-label="切换排序方向" @click="direction = direction === 'asc' ? 'desc' : 'asc'">{{ direction === "asc" ? "↑" : "↓" }}</DsButton>
              <div class="rl-viewtoggle" role="group" aria-label="视图切换">
                <button type="button" :aria-pressed="view === 'grid'" data-d3-04b-view="grid" aria-label="网格" title="网格" @click="view = 'grid'"><LayoutGrid :size="14" /></button>
                <button type="button" :aria-pressed="view === 'list'" data-d3-04b-view="list" aria-label="列表" title="列表" @click="view = 'list'"><List :size="14" /></button>
              </div>
            </div>
          </div>

          <p v-if="error" class="rl-error" data-d3-04b-error role="alert">{{ error }}</p>
          <p v-if="notice" class="rl-notice" data-d3-04b-notice role="status">{{ notice }}</p>
          <p v-if="reindexing" class="rl-notice" data-d3-04c-reindex role="status">索引重建：{{ reindexing.processed }} 已处理 / 剩余 {{ reindexing.remaining }}</p>
          <p v-if="searchMode" class="rl-searchmode" data-d3-04c-search-mode role="status">全文搜索：{{ total }} 条授权结果</p>

          <p v-if="items.length === 0 && !busy" class="rl-empty" data-d3-04a-empty>{{ currentNav ? currentNav.empty : "暂无资源。" }}</p>

          <div :class="view === 'grid' ? 'rl-grid' : 'rl-list'" :data-d3-04b-view-mode="view" role="list" aria-label="资源">
            <button
              v-for="r in items"
              :key="r.resourceId"
              type="button"
              role="listitem"
              class="rl-card"
              :class="{ 'is-selected': selectedId === r.resourceId }"
              :data-d3-04a-item="r.resourceId"
              :data-d3-04b-item="r.resourceId"
              :aria-label="r.name + '，' + r.resourceType + '，' + AVAILABILITY_LABEL[r.availability]"
              @click="select(r.resourceId)"
              @dblclick="openEditor(r.resourceRef)"
            >
              <span class="rl-thumb" aria-hidden="true"><component :is="TYPE_ICON[r.resourceType] || FileText" :size="24" :stroke-width="1.5" /></span>
              <div class="rl-card-top">
                <span class="rl-type">{{ TYPE_LABEL[r.resourceType] || r.resourceType }}</span>
                <span v-if="r.favorite" class="rl-fav" aria-label="已收藏">★</span>
              </div>
              <div class="rl-card-name">{{ r.name }}</div>
              <div v-if="r.snippet && r.snippet.matched" class="rl-card-snippet" data-d3-04c-snippet>
                <template v-for="(s, i) in r.snippet.spans" :key="i">
                  <mark v-if="s.match">{{ s.text }}</mark>
                  <span v-else>{{ s.text }}</span>
                </template>
                {{ r.snippet.truncated ? "…" : "" }}
              </div>
              <div v-if="r.matchedFields && r.matchedFields.length" class="rl-card-fields" data-d3-04c-fields>命中：{{ r.matchedFields.join(" / ") }}</div>
              <div class="rl-card-meta">{{ r.storageMode }} · {{ r.availability === "AVAILABLE" ? "可用" : AVAILABILITY_LABEL[r.availability] }}</div>
              <div class="rl-card-foot">
                <span>{{ fmtSize(r.size) }}</span>
                <span>v{{ r.version }}</span>
              </div>
              <div class="rl-card-ref">{{ r.resourceRef }}</div>
            </button>
          </div>

          <div v-if="hasMore" class="rl-more">
            <DsButton variant="secondary" size="sm" :disabled="busy" @click="reload(offset + 60)">加载更多（{{ items.length }}/{{ total }}）</DsButton>
          </div>
        </section>

        <aside v-if="inspector" class="rl-inspector" aria-label="资源检查器">
          <div class="rl-inspector-body" :data-d3-04b-inspector-ref="inspector.resource.resourceId">
            <h2 data-d3-04b-inspector-name>{{ inspector.resource.name }}</h2>
            <div class="rl-badges">
              <span class="rl-type">{{ inspector.resource.resourceType }}</span>
              <span v-if="inspector.resource.memorySubtype" class="rl-type">{{ inspector.resource.memorySubtype }}</span>
              <span class="rl-type">{{ inspector.resource.storageMode }}</span>
              <span class="rl-type">{{ AVAILABILITY_LABEL[inspector.resource.availability] }}</span>
              <span v-if="inspector.favorite" class="rl-type">★ 收藏</span>
            </div>

            <div class="rl-actions">
              <DsButton v-if="!inspector.trashed" variant="ghost" size="sm" data-d3-04b-action="favorite" :aria-pressed="inspector.favorite" @click="toggleFavorite">{{ inspector.favorite ? "取消收藏" : "收藏" }}</DsButton>
              <DsButton v-if="['memory', 'text', 'code', 'prompt'].includes(inspector.resource.resourceType) && !inspector.trashed" variant="secondary" size="sm" data-d3-04b-action="edit" :disabled="!canEdit" @click="openEditor(inspector.resource.resourceRef)">编辑内容</DsButton>
              <DsButton v-if="!inspector.trashed" variant="danger" size="sm" data-d3-04b-action="delete" :disabled="!canDelete" @click="deleteSelected">删除</DsButton>
              <template v-else>
                <DsButton variant="secondary" size="sm" data-d3-04b-action="restore" @click="restoreSelected">恢复</DsButton>
                <DsButton variant="danger" size="sm" data-d3-04b-action="permanent-delete" @click="confirmPermanentDelete(inspector.resource.resourceId, inspector.resource.name)">永久删除</DsButton>
              </template>
            </div>

            <section class="rl-block" aria-label="预览" :data-d3-04c-preview="preview ? preview.kind : 'none'">
              <h3>预览</h3>
              <p v-if="!preview" class="rl-note">加载中…</p>
              <pre v-else-if="preview.kind === 'text'" class="rl-preview-text" data-d3-04c-preview-text>{{ preview.text }}{{ preview.truncated ? "\n…（已截断）" : "" }}</pre>
              <img v-else-if="preview.kind === 'image' && preview.url" class="rl-preview-media" data-d3-04c-preview-image :src="preview.thumbnailUrl || preview.url" :alt="inspector.resource.name" />
              <video v-else-if="preview.kind === 'video' && preview.url" class="rl-preview-media" data-d3-04c-preview-video controls preload="metadata" :src="preview.url" />
              <audio v-else-if="preview.kind === 'audio' && preview.url" data-d3-04c-preview-audio controls :src="preview.url" />
              <iframe v-else-if="preview.kind === 'pdf' && preview.url" class="rl-preview-pdf" data-d3-04c-preview-pdf title="PDF Preview" :src="preview.url" />
              <p v-else class="rl-note" data-d3-04c-preview-error>{{ preview.error || preview.availability || "预览不可用" }}</p>
            </section>

            <dl class="rl-meta">
              <div><dt>描述</dt><dd>{{ inspector.resource.description || "-" }}</dd></div>
              <div><dt>类型</dt><dd>{{ inspector.resource.mimeType }}</dd></div>
              <div><dt>大小</dt><dd>{{ fmtSize(inspector.resource.size) }}</dd></div>
              <div><dt>所有者</dt><dd>{{ inspector.resource.ownerUserId || "-" }}</dd></div>
              <div><dt>范围</dt><dd>{{ inspector.resource.scope || "-" }}</dd></div>
              <div><dt>部门</dt><dd>{{ inspector.resource.departmentId || "-" }}</dd></div>
              <div><dt>收藏集</dt><dd>{{ inspector.collection ? inspector.collection.name : "未归类" }}</dd></div>
              <div><dt>版本</dt><dd>v{{ inspector.resource.version }}</dd></div>
              <div><dt>创建</dt><dd>{{ fmtTime(inspector.resource.createdAt) }}</dd></div>
              <div><dt>更新</dt><dd>{{ fmtTime(inspector.resource.updatedAt) }}</dd></div>
              <div><dt>存储设备</dt><dd>{{ inspector.resource.storageDeviceId || "-" }}</dd></div>
              <div><dt>来源</dt><dd>{{ inspector.resource.source ? inspector.resource.source.label : "-" }}</dd></div>
              <div v-if="inspector.provenance.generatedSourceModel"><dt>模型</dt><dd>{{ inspector.provenance.generatedSourceModel }}</dd></div>
            </dl>

            <section class="rl-block" aria-label="标签">
              <h3>标签</h3>
              <div class="rl-tag-list">
                <span v-for="t in inspector.tags" :key="t.tagId" class="rl-tag">
                  {{ t.name }}
                  <button v-if="!inspector.trashed && canEdit" type="button" :aria-label="'移除标签 ' + t.name" @click="removeTag(t.tagId)">×</button>
                </span>
              </div>
              <form v-if="!inspector.trashed && canEdit" class="rl-inline" @submit.prevent="addTag">
                <input v-model="tagDraft" name="tag" data-d3-04b-tag-input placeholder="添加标签" aria-label="添加标签" />
                <DsButton size="sm" type="submit" data-d3-04b-tag-add>添加</DsButton>
              </form>
            </section>

            <section class="rl-block" aria-label="Collection 归属">
              <h3>收藏集</h3>
              <select v-if="!inspector.trashed && canEdit" data-d3-04b-collection aria-label="移动到 Collection" :value="inspector.collection ? inspector.collection.collectionId : ''" @change="onCollectionChange">
                <option value="">未归类</option>
                <option v-for="c in collections" :key="c.collectionId" :value="c.collectionId">{{ c.name }}</option>
              </select>
              <p v-else>{{ inspector.collection ? inspector.collection.name : "未归类" }}</p>
              <div v-if="inspector.collection && inspector.collection.editable" class="rl-inline">
                <DsButton variant="ghost" size="sm" data-d3-04b-action="rename-collection" @click="renameCollection">重命名</DsButton>
                <DsButton variant="danger" size="sm" data-d3-04b-action="delete-collection" @click="deleteCollection">删除 Collection</DsButton>
              </div>
            </section>

            <section class="rl-block" aria-label="权限">
              <h3>权限</h3>
              <p class="rl-cap" data-d3-04b-cap="canRead">Can Read: {{ String(!!caps.canRead) }}</p>
              <p class="rl-cap" data-d3-04b-cap="canEdit">Can Edit: {{ String(!!caps.canEdit) }}</p>
              <p class="rl-cap" data-d3-04b-cap="canDelete">Can Delete: {{ String(!!caps.canDelete) }}</p>
              <p class="rl-cap" data-d3-04b-cap="canManageAccess">Can Manage Access: {{ String(!!caps.canManageAccess) }}</p>
              <p class="rl-cap" data-d3-04b-cap="canUseByAgent">Can Use by Agent: {{ String(!!caps.canUseByAgent) }}</p>
              <p class="rl-cap-note">当前 App（resource-library）与 User 的能力交集；App 无权限时操作同样被拒。</p>
            </section>

            <section v-if="inspector.versions.length > 0" class="rl-block" aria-label="版本历史">
              <h3>版本</h3>
              <ul class="rl-versions">
                <li v-for="v in inspector.versions.slice().reverse()" :key="v.version">
                  <span>v{{ v.version }}</span>
                  <span>{{ fmtSize(v.size) }}</span>
                  <span>{{ fmtTime(v.createdAt) }}</span>
                  <DsButton v-if="!inspector.trashed && canEdit && v.version !== inspector.resource.version" size="sm" variant="ghost" :data-d3-04b-restore-version="v.version" @click="restoreVersion(v.version)">恢复</DsButton>
                </li>
              </ul>
            </section>

            <section class="rl-block" aria-label="引用关系">
              <h3>关联</h3>
              <p>引用：{{ inspector.relations.incoming }} incoming · {{ inspector.relations.outgoing }} outgoing</p>
            </section>

            <section class="rl-block" aria-label="索引">
              <h3>索引</h3>
              <p class="rl-cap" data-d3-04c-index-status>Index Status: {{ indexStatus ? indexStatus.indexStatus + (indexStatus.stale ? "（STALE）" : "") : "-" }}</p>
              <p class="rl-cap" data-d3-04c-index-version>Indexed Version: {{ indexStatus && indexStatus.documentVersion != null ? "v" + indexStatus.documentVersion : "-" }} / Resource Version: {{ indexStatus && indexStatus.resourceVersion != null ? "v" + indexStatus.resourceVersion : "-" }}</p>
              <div class="rl-inline">
                <DsButton variant="secondary" size="sm" data-d3-04c-action="reindex" :disabled="!!reindexing" @click="reindexOne">重新索引</DsButton>
                <DsButton variant="ghost" size="sm" data-d3-04c-action="rebuild-index" :disabled="!!reindexing" @click="rebuildIndex">重建全部索引</DsButton>
              </div>
              <p class="rl-cap-note">索引是派生数据；Authorization 每次搜索实时检查，不依赖索引。</p>
            </section>
          </div>
        </aside>

        <DsDialog :open="createOpen" title="新建资源" @close="createOpen = false">
          <form id="rl-create-form" class="rl-form" @submit.prevent="submitCreate">
            <label>类型
              <select v-model="createType" data-d3-04b-create-type>
                <option v-for="t in CREATE_TYPES" :key="t.id" :value="t.id">{{ t.label }}</option>
              </select>
            </label>
            <label>名称<input v-model="createName" name="name" data-d3-04b-create-name required /></label>
            <label>Memory 类型
              <select v-model="createSubtype" name="memorySubtype" data-d3-04b-create-subtype>
                <option v-for="s in MEMORY_SUBTYPES" :key="s.id" :value="s.id">{{ s.label }}</option>
              </select>
            </label>
            <label>Collection
              <select v-model="createCollectionId" name="collectionId">
                <option value="">未归类</option>
                <option v-for="c in collections" :key="c.collectionId" :value="c.collectionId">{{ c.name }}</option>
              </select>
            </label>
            <label>标签（逗号分隔）<input v-model="createTags" name="tags" /></label>
            <label>内容<textarea v-model="createContent" name="content" data-d3-04b-create-content :rows="6" /></label>
          </form>
          <template #footer>
            <DsButton variant="primary" data-d3-04b-action="create-submit" @click="submitCreate">创建</DsButton>
          </template>
        </DsDialog>

        <DsDialog :open="collectionOpen" title="新建 Collection" @close="collectionOpen = false">
          <label class="rl-form">名称<input id="rl-collection-name" v-model="collectionName" data-d3-04b-collection-name /></label>
          <template #footer>
            <DsButton variant="primary" data-d3-04b-action="collection-submit" @click="submitCollection">创建</DsButton>
          </template>
        </DsDialog>

        <DsDialog :open="!!editor" title="编辑内容" @close="editor = null">
          <div v-if="editor" class="rl-form">
            <p class="rl-note">{{ editor.name }} · v{{ editor.expectedVersion }} · 保存会形成新版本</p>
            <textarea v-model="editor.content" data-d3-04b-editor :rows="14" />
          </div>
          <template #footer>
            <DsButton variant="primary" data-d3-04b-save @click="saveEditor">保存</DsButton>
          </template>
        </DsDialog>

        <DsDialog :open="!!conflict" title="版本冲突" @close="conflict = null">
          <p data-d3-04b-conflict>资源已被其他操作更新（当前 v{{ conflict ? conflict.currentVersion : "?" }}）。你的草稿不会覆盖它。</p>
          <template #footer>
            <div class="rl-inline">
              <DsButton variant="secondary" data-d3-04b-conflict-reload @click="conflictReload">重新加载</DsButton>
              <DsButton variant="primary" data-d3-04b-conflict-saveas @click="saveAsNew">另存为新资源</DsButton>
            </div>
          </template>
        </DsDialog>

        <DsDialog :open="!!pendingDelete" title="永久删除" @close="pendingDelete = null">
          <p>不可恢复。{{ pendingDelete && pendingDelete.references > 0 ? "被 " + pendingDelete.references + " 个对象引用。" : "没有对象引用它。" }}</p>
          <template #footer>
            <div class="rl-inline">
              <DsButton variant="secondary" @click="pendingDelete = null">取消</DsButton>
              <DsButton variant="danger" data-d3-04b-permanent-confirm @click="confirmPermanent">永久删除</DsButton>
            </div>
          </template>
        </DsDialog>
      </div>
    </div>
  </div>
</template>
