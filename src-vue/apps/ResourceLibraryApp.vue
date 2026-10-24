<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import DsButton from "../design-system/DsButton.vue";
import DsDialog from "../design-system/DsDialog.vue";
import DsSearchField from "../design-system/DsSearchField.vue";
import { useShellStore } from "../stores/shell";
import { Brain, Clock, Code2, Download, FileText, FolderOpen, Image as ImageIcon, LayoutGrid, Layers, List, MapPin, Music, Sparkles, Star, Trash2, Type, Video, X } from "lucide-vue-next";

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

type MediaDetail = { kind?: string; width: number | null; height: number | null; durationMs: number | null; status?: string };
type SourceDetail = { origin: string; storage?: { kind?: string; label?: string }; generated?: { taskId?: string | null; callId?: string | null; model?: string | null } | null };
type CollectionDetail = { collectionId: string; name: string; scope?: string | null };
type ProjectDetail = { projectId: string; name: string };
type CanvasNodeDetail = { nodeId: string; boardId: string; boardName: string; x: number; y: number; resourceVersion?: number; versionMode?: string };
type ResourceDetailInfo = {
  media: MediaDetail | null;
  sourceInfo: SourceDetail | null;
  collection: CollectionDetail | null;
  projects: ProjectDetail[];
  canvasNodes: CanvasNodeDetail[];
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
const shell = useShellStore();

const category = ref("all");
const view = ref<"grid" | "list">(typeof localStorage !== "undefined" && localStorage.getItem("oa-resource-view") === "list" ? "list" : "grid");
const query = ref("");
const sort = ref("updated");
const direction = ref("desc");
const filterCollection = ref<string | null>(null);
const filterTag = ref<string | null>(null);
const items = ref<Descriptor[]>([]);

/* ── task-50：网格真实缩略图（resource/thumbnail）──────────────────────────
   只在网格视图、且资源确实是图片时才请求；进入视口才请求（IntersectionObserver），
   失败/过期回退类型图标；列表视图完全不请求、也不渲染图片。 */
type ThumbEntry = { state: "idle" | "loading" | "loaded" | "failed"; url?: string; error?: string; requested?: boolean };
const thumbs = ref<Record<string, ThumbEntry>>({});
const thumbElements = new WeakMap<Element, Descriptor>();
const thumbInflight = new Set<string>();
let thumbObserver: IntersectionObserver | null = null;

function isImageResource(r: Descriptor): boolean {
  return r.resourceType === "image" || /^image\//i.test(r.mimeType || "");
}
function thumbOf(r: Descriptor): ThumbEntry {
  return thumbs.value[r.resourceRef] || { state: "idle", requested: false };
}
function thumbStateOf(r: Descriptor): string {
  return isImageResource(r) ? thumbOf(r).state : "skipped";
}
function thumbUrlOf(r: Descriptor): string {
  const entry = thumbOf(r);
  return entry.state === "loaded" && entry.url ? entry.url : "";
}
function setThumb(resourceRef: string, entry: ThumbEntry) {
  thumbs.value = { ...thumbs.value, [resourceRef]: entry };
}
async function requestThumb(r: Descriptor) {
  const resourceRef = r.resourceRef;
  if (!isImageResource(r) || thumbInflight.has(resourceRef)) return;
  const current = thumbOf(r);
  if (current.state === "loaded" || current.state === "failed" || current.state === "loading") return;
  thumbInflight.add(resourceRef);
  setThumb(resourceRef, { state: "loading", requested: true });
  const res = await cmd({ type: "resource/thumbnail", resourceRef });
  thumbInflight.delete(resourceRef);
  if (res && res.ok && typeof res.url === "string" && res.url) setThumb(resourceRef, { state: "loaded", url: res.url, requested: true });
  else setThumb(resourceRef, { state: "failed", requested: true, error: String((res && res.error) || "THUMBNAIL_UNAVAILABLE") });
}
function ensureThumbObserver(): IntersectionObserver | null {
  if (thumbObserver || typeof IntersectionObserver === "undefined") return thumbObserver;
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const descriptor = thumbElements.get(entry.target);
      if (descriptor) void requestThumb(descriptor);
      thumbObserver?.unobserve(entry.target);
    }
  }, { rootMargin: "240px 0px" });
  return thumbObserver;
}
/** 模板 ref 回调：列表视图直接跳过（零请求）；网格里状态已定的卡片不再重复观察。 */
function bindThumb(el: unknown, r: Descriptor) {
  if (view.value !== "grid") return;
  if (!el || typeof el !== "object" || !isImageResource(r)) return;
  const state = thumbOf(r).state;
  if (state === "loaded" || state === "failed" || state === "loading") return;
  thumbElements.set(el as Element, r);
  const observer = ensureThumbObserver();
  if (observer) observer.observe(el as Element);
  else void requestThumb(r);
}
function markThumbFailed(r: Descriptor) {
  if (!isImageResource(r)) return;
  setThumb(r.resourceRef, { state: "failed", requested: true, error: "IMAGE_LOAD_FAILED" });
}
/** 分组后内容区内部滚动：IntersectionObserver 之外再兜底按可见区域请求，避免分组布局下漏观察。 */
function onContentScroll() {
  const byId = new Map(items.value.map((item) => [item.resourceId, item]));
  const cards = document.querySelectorAll<HTMLElement>(".rl-grid [data-d3-04a-item]");
  const top = -240;
  const bottom = window.innerHeight + 240;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom < top || rect.top > bottom) continue;
    const descriptor = byId.get(card.getAttribute("data-d3-04a-item") || "");
    if (descriptor) void requestThumb(descriptor);
  }
}
onBeforeUnmount(() => { thumbObserver?.disconnect(); thumbObserver = null; });

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

/* ── task-61：按来源/画布分组、时间过滤、固定详情与真实媒体尺寸/时长 ───────── */
type GroupMode = "source" | "canvas" | "none";
type TimeFilter = "all" | "24h" | "7d" | "30d";
const groupMode = ref<GroupMode>("none");
const timeFilter = ref<TimeFilter>("all");
const GROUP_MODES: { id: GroupMode; label: string }[] = [
  { id: "source", label: "按来源" },
  { id: "canvas", label: "按画布" },
];
const TIME_FILTERS: { id: TimeFilter; label: string; ms: number | null }[] = [
  { id: "all", label: "全部时间", ms: null },
  { id: "24h", label: "最近 24 小时", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "近 7 天", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "近 30 天", ms: 30 * 24 * 60 * 60 * 1000 },
];
const canvasRefs = ref<Record<string, { canvasId: string; title: string; updatedAt: number }[]>>({});
const canvasGroupsLoading = ref(false);
const canvasGroupsLoaded = ref(false);
const canvasGroupsError = ref("");
const detailImageSize = ref<{ width: number; height: number } | null>(null);
const detailDuration = ref<number | null>(null);
const downloadBusy = ref(false);
const downloadNotice = ref("");
const downloadError = ref("");
const detailInfo = ref<ResourceDetailInfo | null>(null);
const locateNotice = ref("");

const selectedItem = computed<Descriptor | null>(() => {
  if (!selectedId.value) return null;
  return items.value.find((item) => item.resourceId === selectedId.value) || inspector.value?.resource || null;
});
const timeFilterLabel = computed(() => TIME_FILTERS.find((item) => item.id === timeFilter.value)?.label || "全部时间");
const timeFilteredItems = computed<Descriptor[]>(() => {
  const rule = TIME_FILTERS.find((item) => item.id === timeFilter.value);
  if (!rule || rule.ms == null) return items.value;
  const cutoff = Date.now() - rule.ms;
  return items.value.filter((item) => Math.max(Number(item.updatedAt) || 0, Number(item.createdAt) || 0) >= cutoff);
});
const groupedItems = computed<{ key: string; label: string; hint: string; items: Descriptor[] }[]>(() => {
  const list = timeFilteredItems.value;
  if (groupMode.value === "none") return [{ key: "all", label: "", hint: "", items: list }];
  if (groupMode.value === "source") {
    const groups = new Map<string, Descriptor[]>();
    for (const item of list) {
      const label = item.source?.label || "未知来源";
      const bucket = groups.get(label) || [];
      bucket.push(item);
      groups.set(label, bucket);
    }
    return [...groups.entries()].map(([label, items]) => ({ key: "source:" + label, label, hint: "", items }));
  }
  if (canvasGroupsLoading.value) return [];
  const byCanvas = new Map<string, { label: string; updatedAt: number; items: Descriptor[] }>();
  const unfiled: Descriptor[] = [];
  for (const item of list) {
    const refs = canvasRefs.value[item.resourceId] || canvasRefs.value[item.resourceRef] || [];
    if (!refs.length) { unfiled.push(item); continue; }
    const seen = new Set<string>();
    for (const canvas of refs) {
      if (seen.has(canvas.canvasId)) continue;
      seen.add(canvas.canvasId);
      const bucket = byCanvas.get(canvas.canvasId) || { label: canvas.title || "未命名画布", updatedAt: canvas.updatedAt || 0, items: [] };
      bucket.items.push(item);
      bucket.updatedAt = Math.max(bucket.updatedAt, canvas.updatedAt || 0);
      byCanvas.set(canvas.canvasId, bucket);
    }
  }
  const groups = [...byCanvas.entries()]
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .map(([canvasId, bucket]) => ({ key: "canvas:" + canvasId, label: bucket.label, hint: "", items: bucket.items }));
  if (unfiled.length) groups.push({ key: "canvas:unfiled", label: "未关联画布", hint: "未在任何画布引用", items: unfiled });
  return groups;
});
async function loadCanvasGroups(force = false) {
  if (canvasGroupsLoading.value || (canvasGroupsLoaded.value && !force)) return;
  canvasGroupsLoading.value = true;
  canvasGroupsError.value = "";
  try {
    const list = await cmd({ type: "resource/listBoards" });
    const rows = list && list.ok && Array.isArray(list.items) ? list.items : [];
    const map: Record<string, { canvasId: string; title: string; updatedAt: number }[]> = {};
    for (const row of rows.slice(0, 40)) {
      const got = await cmd({ type: "resource/getBoard", boardId: row.id });
      if (!got || !got.ok || !Array.isArray(got.nodes)) continue;
      for (const node of got.nodes) {
        const id = String(node.resourceId || "");
        if (!id) continue;
        const bucket = map[id] || [];
        bucket.push({ canvasId: String(row.id), title: String(row.name || "未命名画布"), updatedAt: Number(row.updated_at) || 0 });
        map[id] = bucket;
      }
    }
    canvasRefs.value = map;
    canvasGroupsLoaded.value = true;
  } catch {
    canvasGroupsError.value = "读取画布引用失败";
    canvasGroupsLoaded.value = true;
  } finally {
    canvasGroupsLoading.value = false;
  }
}
function chooseGroupMode(mode: GroupMode) {
  groupMode.value = mode;
  if (mode === "canvas") void loadCanvasGroups();
}
function captureImageMeta(event: Event) {
  const img = event.target as HTMLImageElement | null;
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  detailImageSize.value = { width: img.naturalWidth, height: img.naturalHeight };
}
function captureDuration(event: Event) {
  const media = event.target as HTMLMediaElement | null;
  if (!media || !Number.isFinite(media.duration) || media.duration <= 0) return;
  detailDuration.value = media.duration;
}
function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") : m + ":" + String(s).padStart(2, "0");
}
const ORIGIN_LABEL: Record<string, string> = {
  user: "用户创建",
  import: "导入",
  linked: "链接",
  generated: "AI 生成",
  restore: "版本恢复",
  unknown: "未知来源",
};
const detailMediaText = computed(() => {
  if (!selectedItem.value) return "";
  const media = detailInfo.value?.media;
  if (media && media.width != null && media.height != null) return media.width + " × " + media.height + " px";
  if (media && media.durationMs != null) return formatDuration(media.durationMs / 1000);
  if (detailImageSize.value) return detailImageSize.value.width + " × " + detailImageSize.value.height + " px";
  if (detailDuration.value != null) return formatDuration(detailDuration.value);
  return "";
});
const detailTypeText = computed(() => {
  const item = selectedItem.value;
  if (!item) return "";
  const label = TYPE_LABEL[item.resourceType] || item.resourceType;
  return item.mimeType ? label + " · " + item.mimeType : label;
});
const detailSourceText = computed(() => {
  const info = detailInfo.value?.sourceInfo;
  if (!info) return selectedItem.value?.source?.label || "";
  const origin = ORIGIN_LABEL[info.origin] || info.origin || "未知来源";
  const storage = info.storage && info.storage.label ? info.storage.label : "";
  return storage ? origin + " · " + storage : origin;
});
const detailCollectionText = computed(() => detailInfo.value?.collection?.name || inspector.value?.collection?.name || "");
const detailProjectsText = computed(() => (detailInfo.value?.projects || []).map((project) => project.name).filter(Boolean).join(" / "));
const detailCanvasNodes = computed<CanvasNodeDetail[]>(() => detailInfo.value?.canvasNodes || []);
const detailCanvasText = computed(() => {
  const names = [...new Set(detailCanvasNodes.value.map((node) => node.boardName).filter(Boolean))];
  return names.join(" / ");
});
async function loadDetailInfo(resourceRef: string) {
  detailInfo.value = null;
  const res = await cmd({ type: "resource/get", resourceRef });
  if (!res || !res.ok) return;
  detailInfo.value = {
    media: res.media && typeof res.media === "object" ? res.media : null,
    sourceInfo: res.sourceInfo && typeof res.sourceInfo === "object" ? res.sourceInfo : null,
    collection: res.collection && typeof res.collection === "object" ? res.collection : null,
    projects: Array.isArray(res.projects) ? res.projects : [],
    canvasNodes: Array.isArray(res.canvasNodes) ? res.canvasNodes : [],
  };
}
async function downloadSelected() {
  if (!selectedItem.value || downloadBusy.value) return;
  downloadNotice.value = "";
  downloadError.value = "";
  downloadBusy.value = true;
  const item = selectedItem.value;
  const res = await cmd({ type: "resource/download", resourceRef: item.resourceRef });
  downloadBusy.value = false;
  if (res && res.ok && (res.dataUrl || res.base64)) {
    const link = document.createElement("a");
    link.href = res.dataUrl || "data:" + String(res.mimeType || "application/octet-stream") + ";base64," + String(res.base64);
    link.download = String(res.fileName || item.name || "resource");
    document.body.appendChild(link);
    link.click();
    link.remove();
    downloadNotice.value = "已开始下载：" + link.download;
    return;
  }
  downloadError.value = "下载失败：" + String((res && res.error) || "DOWNLOAD_FAILED");
}
function locateInCanvas(node: CanvasNodeDetail) {
  locateNotice.value = "已打开 AI Studio。画布：" + (node.boardName || node.boardId) + " · 节点 " + node.nodeId + "（" + node.x + ", " + node.y + "）；当前版本没有跨应用节点定位命令，不能自动滚动到该节点。";
  shell.activateApp("canvas");
}
function closeDetail() {
  selectedId.value = null;
  inspector.value = null;
  preview.value = null;
  indexStatus.value = null;
  detailInfo.value = null;
  detailImageSize.value = null;
  detailDuration.value = null;
  downloadNotice.value = "";
  downloadError.value = "";
  locateNotice.value = "";
}

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
    void loadCardVideoMeta();
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

/* 原型侧栏每个类型都带真实数量：resource/query limit=1 只取 total，不拉数据。 */
const typeCounts = ref<Record<string, number>>({});
async function loadTypeCounts() {
  const ids = ["all", "memory", "documents", "images", "videos", "audio", "code", "prompts", "generated", "favorites"];
  const next: Record<string, number> = {};
  for (const id of ids) {
    const res = await cmd({ type: "resource/query", category: id, limit: 1, offset: 0 });
    if (res && res.ok) next[id] = Number(res.total) || 0;
  }
  typeCounts.value = next;
}

/* 打开：可编辑文本类进编辑器；图片/视频/音频把预览放大（真实预留在详情里）。 */
const expandedPreview = ref(false);
function openSelected() {
  const r = inspector.value?.resource;
  if (!r) return;
  if (["memory", "text", "code", "prompt"].includes(r.resourceType)) {
    void openEditor(r.resourceRef);
    return;
  }
  expandedPreview.value = !expandedPreview.value;
}
/* 卡片收藏星与视频时长：收藏走 resource/setFavorite；时长用预览 URL 的真实 metadata。 */
const cardVideoUrls = ref<Record<string, string>>({});
const cardDurations = ref<Record<string, number>>({});
async function favoriteCard(r: Descriptor) {
  await cmd({ type: "resource/setFavorite", resourceRef: r.resourceRef, favorite: !r.favorite });
  await afterMutation(r.favorite ? "已取消收藏" : "已收藏");
}
async function loadCardVideoMeta() {
  for (const r of items.value.filter((item) => item.resourceType === "video").slice(0, 8)) {
    if (cardVideoUrls.value[r.resourceId]) continue;
    const res = await cmd({ type: "resource/preview", resourceRef: r.resourceRef });
    if (res && res.ok && typeof res.url === "string" && res.url) {
      cardVideoUrls.value = { ...cardVideoUrls.value, [r.resourceId]: res.url };
    }
  }
}
function setCardDuration(r: Descriptor, event: Event) {
  const media = event.target as HTMLVideoElement;
  const duration = Number(media.duration);
  if (Number.isFinite(duration) && duration > 0) cardDurations.value = { ...cardDurations.value, [r.resourceId]: duration };
}
function durationOf(r: Descriptor): string {
  const value = cardDurations.value[r.resourceId];
  if (!value) return "";
  const total = Math.round(value);
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
}

const isEditableResource = (r: Descriptor) => ["memory", "text", "code", "prompt"].includes(r.resourceType);

const SCOPE_LABEL: Record<string, string> = { PERSONAL: "仅自己", DEPARTMENT: "本部门", ORGANIZATION: "组织", TEAM: "团队" };
const agentAllowed = computed(() => {
  const effective = inspector.value?.capabilities?.effective || {};
  return effective["resource.read"] === true || effective.read === true;
});
function scopeLabelOf(value: string | null | undefined): string {
  if (!value) return "仅自己";
  return SCOPE_LABEL[value] || value;
}

onMounted(() => {
  void reload(0);
  void loadCollections();
  void loadTags();
  void loadTypeCounts();
});
watch([category, query, filterCollection, filterTag, sort, direction], () => {
  void reload(0);
});
watch(view, (v) => {
  if (typeof localStorage !== "undefined") localStorage.setItem("oa-resource-view", v);
  void nextTick(onContentScroll);
});
watch([groupMode, timeFilter], () => { void nextTick(onContentScroll); }, { flush: "post" });

async function select(resourceId: string, opts: { touch?: boolean } = {}) {
  const touch = opts.touch !== false;
  selectedId.value = resourceId;
  detailImageSize.value = null;
  detailDuration.value = null;
  downloadNotice.value = "";
  downloadError.value = "";
  locateNotice.value = "";
  void loadDetailInfo(resourceId);
  const res = await cmd({ type: "resource/inspector", resourceRef: resourceId });
  inspector.value = res && res.ok ? (res as Inspector) : null;
  if (touch) void cmd({ type: "resource/touchRecent", resourceRef: resourceId });
  void loadPreview(resourceId);
  void loadIndexStatus(resourceId);
}

async function afterMutation(message: string) {
  notice.value = message;
  await Promise.all([reload(0), loadCollections(), loadTags(), loadTypeCounts()]);
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

const TYPE_NAV = NAV.filter((n) => ["all", "memory", "documents", "images", "videos", "audio", "code", "prompts", "generated"].includes(n.id));
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
      <div class="rl-app" :data-detail-open="selectedId ? 'true' : 'false'" data-d3-04a="resource-library" data-d3-04b="app">
        <nav class="rl-nav rl-nav--proto" aria-label="资源库导航">
          <div class="rl-nav-section">资源库</div>
          <button
            v-for="n in TYPE_NAV"
            :key="n.id"
            type="button"
            class="rl-nav-item"
            :class="{ 'is-active': category === n.id }"
            :data-d3-04b-nav="n.id"
            :aria-current="category === n.id ? 'page' : undefined"
            @click="chooseNav(n.id)"
          >
            <component :is="NAV_ICON[n.id] || FileText" :size="16" />
            <span class="rl-nav-label">{{ n.label }}</span>
            <span class="rl-count">{{ typeCounts[n.id] ?? 0 }}</span>
          </button>
          <div class="rl-nav-section">快捷</div>
          <button type="button" class="rl-nav-item" :class="{ 'is-active': category === 'favorites' }" :data-d3-04b-nav="'favorites'" @click="chooseNav('favorites')">
            <Star :size="16" /><span class="rl-nav-label">收藏</span><span class="rl-count">{{ typeCounts.favorites ?? 0 }}</span>
          </button>
          <button type="button" class="rl-nav-item" :class="{ 'is-active': category === 'recent' }" data-d3-04b-nav="recent" @click="chooseNav('recent')">
            <Clock :size="16" /><span class="rl-nav-label">最近</span>
          </button>
          <div class="rl-nav-section">
            集合
            <button type="button" class="rl-nav-add" aria-label="新建收藏集" data-d3-04b-action="new-collection" @click="openCollection">+</button>
          </div>
          <button type="button" class="rl-nav-item" :class="{ 'is-active': filterCollection === 'unfiled' }" data-d3-04b-nav="unfiled" @click="chooseUnfiled"><FolderOpen :size="16" /><span class="rl-nav-label">未归类</span></button>
          <button
            v-for="c in collections"
            :key="c.collectionId"
            type="button"
            class="rl-nav-item"
            :class="{ 'is-active': filterCollection === c.collectionId }"
            :data-d3-04b-nav="'col:' + c.collectionId"
            @click="chooseCollection(c.collectionId)"
          >
            <Layers :size="16" /><span class="rl-nav-label">{{ c.name }}</span> <span class="rl-count">{{ c.resourceCount }}</span>
          </button>
          <div class="rl-nav-section">回收站</div>
          <button type="button" class="rl-nav-item" :class="{ 'is-active': category === 'trash' }" data-d3-04b-nav="trash" @click="chooseNav('trash')">
            <Trash2 :size="16" /><span class="rl-nav-label">回收站</span>
          </button>
        </nav>

        <section class="rl-content" aria-label="资源列表" @scroll.passive="onContentScroll">
          <div class="rl-toolbar rl-toolbar--proto">
            <h2 class="rl-title">
              {{ currentNav ? currentNav.label : "全部" }}
              <small>{{ timeFilteredItems.length }} 项 · 本地优先，不自动上传</small>
            </h2>
            <span class="toolbar-spacer" />
            <DsSearchField :value="query" placeholder="搜索名称、标签、内容" label="搜索资源" @update:value="query = $event" />
            <details class="rl-menu" data-rl-add-menu>
              <summary class="rl-add">＋ 添加</summary>
              <div class="rl-menu-body">
                <button type="button" data-d3-04a-action="import" @click="doImport">导入文件…</button>
                <button type="button" data-d3-04a-action="link" @click="doLink">链接文件…</button>
                <button type="button" data-d3-04b-action="create" @click="openCreate">新建资源…</button>
              </div>
            </details>
            <details class="rl-menu" data-rl-more-menu>
              <summary aria-label="更多选项" title="更多选项">⋯</summary>
              <div class="rl-menu-body rl-menu-body--wide">
                <label class="rl-field"><span>时间</span>
                  <select v-model="timeFilter" data-rl-time-filter aria-label="时间过滤">
                    <option v-for="f in TIME_FILTERS" :key="f.id" :value="f.id">{{ f.label }}</option>
                  </select>
                </label>
                <label class="rl-field"><span>排序</span>
                  <select v-model="sort" aria-label="排序字段">
                    <option value="updated">更新时间</option>
                    <option value="created">创建时间</option>
                    <option value="name">名称</option>
                    <option value="size">大小</option>
                  </select>
                </label>
                <button type="button" class="rl-menu-item" @click="direction = direction === 'asc' ? 'desc' : 'asc'">{{ direction === "asc" ? "升序 ↑" : "降序 ↓" }}</button>
                <div class="rl-menu-row" role="group" aria-label="分组方式">
                  <button type="button" :class="{ 'is-active': groupMode === 'none' }" data-rl-group-mode="none" @click="chooseGroupMode('none')">不分组</button>
                  <button type="button" :class="{ 'is-active': groupMode === 'source' }" data-rl-group-mode="source" @click="chooseGroupMode('source')">按来源</button>
                  <button type="button" :class="{ 'is-active': groupMode === 'canvas' }" data-rl-group-mode="canvas" @click="chooseGroupMode('canvas')">按画布</button>
                </div>
                <div class="rl-menu-row" role="group" aria-label="视图切换">
                  <button type="button" :class="{ 'is-active': view === 'grid' }" data-d3-04b-view="grid" @click="view = 'grid'">网格</button>
                  <button type="button" :class="{ 'is-active': view === 'list' }" data-d3-04b-view="list" @click="view = 'list'">列表</button>
                </div>
                <button type="button" class="rl-menu-item" data-d3-04c-action="rebuild-index" :disabled="!!reindexing" @click="rebuildIndex">重建搜索索引</button>
              </div>
            </details>
          </div>
          <div v-if="tags.length" class="rl-chips" data-rl-tag-chips>
            <button v-for="t in tags" :key="t.tagId" type="button" class="rl-chip" :class="{ on: filterTag === t.tagId }" :data-d3-04b-tag="t.tagId" @click="toggleTag(t.tagId)">{{ t.name }}</button>
          </div>

          <p v-if="error" class="rl-error" data-d3-04b-error role="alert">{{ error }}</p>
          <p v-if="notice" class="rl-notice" data-d3-04b-notice role="status">{{ notice }}</p>
          <p v-if="reindexing" class="rl-notice" data-d3-04c-reindex role="status">索引重建：{{ reindexing.processed }} 已处理 / 剩余 {{ reindexing.remaining }}</p>
          <p v-if="searchMode" class="rl-searchmode" data-d3-04c-search-mode role="status">全文搜索：{{ total }} 条授权结果</p>
          <p v-if="groupMode === 'canvas' && canvasGroupsError" class="rl-error" data-rl-canvas-groups-error role="alert">{{ canvasGroupsError }}</p>
          <p v-if="groupMode === 'canvas' && canvasGroupsLoading" class="rl-note" data-rl-canvas-groups-loading>正在读取画布分组…</p>

          <p v-if="timeFilteredItems.length === 0 && !busy" class="rl-empty" data-d3-04a-empty>{{ timeFilter === "all" ? (currentNav ? currentNav.empty : "暂无资源。") : timeFilterLabel + "内没有资源（已加载 " + items.length + " 项）。" }}</p>

          <section v-for="group in groupedItems" :key="group.key" class="rl-group" :data-rl-group="group.key">
            <header v-if="groupMode !== 'none'" class="rl-group-head">
              <strong class="rl-group-title">{{ group.label }}</strong>
              <span class="rl-group-count">{{ group.items.length }}</span>
              <span v-if="group.hint" class="rl-group-hint">{{ group.hint }}</span>
              <span class="rl-group-time">{{ timeFilterLabel }}</span>
            </header>
            <div :class="view === 'grid' ? 'rl-grid' : 'rl-list'" :data-d3-04b-view-mode="view" role="list" :aria-label="'资源分组 ' + group.label">
              <div
                v-for="r in group.items"
                :key="r.resourceId"
                role="listitem"
                tabindex="0"
                class="rl-card"
                :class="{ 'is-selected': selectedId === r.resourceId }"
                :data-d3-04a-item="r.resourceId"
                :data-d3-04b-item="r.resourceId"
                :ref="(el) => bindThumb(el, r)"
                :aria-label="r.name + '，' + r.resourceType + '，' + AVAILABILITY_LABEL[r.availability]"
                @click="select(r.resourceId)"
                @dblclick="isEditableResource(r) ? openEditor(r.resourceRef) : openSelected()"
                @keydown.enter.prevent="select(r.resourceId)"
              >
                <span
                  class="rl-thumb"
                  aria-hidden="true"
                  :data-rl-thumb-ref="r.resourceRef"
                  :data-rl-thumb-type="isImageResource(r) ? 'image' : 'other'"
                  :data-rl-thumb-state="thumbStateOf(r)"
                  :data-rl-thumb-requested="thumbOf(r).requested ? '1' : '0'"
                  :data-rl-thumb-error="thumbOf(r).error || ''"
                >
                  <img
                    v-if="thumbUrlOf(r)"
                    class="rl-thumb-img"
                    :src="thumbUrlOf(r)"
                    alt=""
                    loading="lazy"
                    decoding="async"
                    @error="markThumbFailed(r)"
                  />
                  <component v-else :is="TYPE_ICON[r.resourceType] || FileText" :size="28" :stroke-width="1.4" />
                  <button type="button" class="rl-fav-btn" :class="{ 'is-on': r.favorite }" :aria-label="r.favorite ? '取消收藏' : '收藏'" :data-rl-fav="r.resourceId" @click.stop="favoriteCard(r)">★</button>
                  <span v-if="durationOf(r)" class="rl-duration">{{ durationOf(r) }}</span>
                  <video
                    v-if="cardVideoUrls[r.resourceId] && !cardDurations[r.resourceId]"
                    class="rl-duration-source"
                    :src="cardVideoUrls[r.resourceId]"
                    preload="metadata"
                    aria-hidden="true"
                    @loadedmetadata="setCardDuration(r, $event)"
                  />
                </span>
                <div class="rl-card-body">
                  <div class="rl-card-name">{{ r.name }}</div>
                  <div class="rl-card-meta">{{ TYPE_LABEL[r.resourceType] || r.resourceType }} · {{ scopeLabelOf(r.scope) }}</div>
                  <div v-if="r.snippet && r.snippet.matched" class="rl-card-snippet" data-d3-04c-snippet>
                    <template v-for="(s, i) in r.snippet.spans" :key="i">
                      <mark v-if="s.match">{{ s.text }}</mark>
                      <span v-else>{{ s.text }}</span>
                    </template>
                    {{ r.snippet.truncated ? "…" : "" }}
                  </div>
                  <div v-if="r.matchedFields && r.matchedFields.length" class="rl-card-fields" data-d3-04c-fields>命中：{{ r.matchedFields.join(" / ") }}</div>
                </div>
              </div>
            </div>
          </section>

          <div v-if="hasMore" class="rl-more">
            <DsButton variant="secondary" size="sm" :disabled="busy" @click="reload(offset + 60)">加载更多（{{ items.length }}/{{ total }}）</DsButton>
          </div>
        </section>

        <aside class="rl-detail" :class="{ 'is-open': !!selectedId }" aria-label="资源详情" data-d3-04b-detail>
          <div v-if="!selectedId" class="rl-detail-empty" data-rl-detail-empty>
            <span class="rl-detail-empty-icon"><FileText :size="26" :stroke-width="1.2" /></span>
            <p>选择左侧资源查看详情</p>
            <p class="rl-note">大预览、类型、尺寸/时长、时间、来源、所有者与可用性都在这里。</p>
          </div>

          <div v-else-if="!inspector" class="rl-detail-empty" data-rl-detail-loading>
            <span class="ds-spinner" aria-hidden="true" />
            <p>正在读取资源详情…</p>
          </div>

          <div v-else class="rl-detail-body" :data-d3-04b-inspector-ref="inspector.resource.resourceId">
            <div class="rl-detail-head">
              <span class="rl-type">{{ TYPE_LABEL[inspector.resource.resourceType] || inspector.resource.resourceType }}</span>
              <span class="rl-type" :data-rl-availability="inspector.resource.availability">{{ AVAILABILITY_LABEL[inspector.resource.availability] }}</span>
              <button type="button" class="rl-detail-close" aria-label="关闭详情" data-rl-detail-close @click="closeDetail"><X :size="15" /></button>
            </div>

            <section class="rl-detail-preview" aria-label="预览" :data-d3-04c-preview="preview ? preview.kind : 'none'">
              <img
                v-if="preview && preview.kind === 'image' && preview.url"
                class="rl-detail-media"
                data-d3-04c-preview-image
                :src="preview.url"
                :alt="inspector.resource.name"
                @load="captureImageMeta"
              />
              <video
                v-else-if="preview && preview.kind === 'video' && preview.url"
                class="rl-detail-media"
                data-d3-04c-preview-video
                controls
                preload="metadata"
                :src="preview.url"
                @loadedmetadata="captureDuration"
              />
              <audio
                v-else-if="preview && preview.kind === 'audio' && preview.url"
                data-d3-04c-preview-audio
                controls
                preload="metadata"
                :src="preview.url"
                @loadedmetadata="captureDuration"
              />
              <iframe
                v-else-if="preview && preview.kind === 'pdf' && preview.url"
                class="rl-detail-pdf"
                data-d3-04c-preview-pdf
                title="PDF Preview"
                :src="preview.url"
              />
              <pre v-else-if="preview && preview.kind === 'text'" class="rl-detail-text" data-d3-04c-preview-text>{{ preview.text }}{{ preview.truncated ? "\n…（已截断）" : "" }}</pre>
              <p v-else-if="!preview" class="rl-note" data-rl-preview-loading>加载预览…</p>
              <p v-else class="rl-note" data-d3-04c-preview-error>{{ preview.error || preview.availability || "预览不可用" }}</p>
            </section>

            <h2 class="rl-detail-name" data-d3-04b-inspector-name>{{ inspector.resource.name }}</h2>

            <dl class="rl-fields" data-rl-detail-fields>
              <div v-if="detailTypeText"><dt>类型</dt><dd>{{ detailTypeText }}</dd></div>
              <div v-if="detailMediaText"><dt>尺寸 / 时长</dt><dd :data-rl-media-meta="detailMediaText">{{ detailMediaText }}</dd></div>
              <div v-if="inspector.resource.size != null"><dt>大小</dt><dd>{{ fmtSize(inspector.resource.size) }}</dd></div>
              <div v-if="inspector.resource.createdAt"><dt>创建</dt><dd>{{ fmtTime(inspector.resource.createdAt) }}</dd></div>
              <div v-if="inspector.resource.updatedAt"><dt>更新</dt><dd>{{ fmtTime(inspector.resource.updatedAt) }}</dd></div>
              <div v-if="detailSourceText"><dt>来源</dt><dd data-rl-detail-source>{{ detailSourceText }}</dd></div>
              <div v-if="detailCollectionText"><dt>集合</dt><dd data-rl-detail-collection>{{ detailCollectionText }}</dd></div>
              <div v-if="detailProjectsText"><dt>项目</dt><dd data-rl-detail-projects>{{ detailProjectsText }}</dd></div>
              <div v-if="detailCanvasText"><dt>画布</dt><dd data-rl-detail-canvas>{{ detailCanvasText }}</dd></div>
              <div><dt>引用 ID</dt><dd class="mono" :title="inspector.resource.resourceRef">{{ inspector.resource.resourceRef }}</dd></div>
              <div v-if="inspector.resource.ownerUserId"><dt>所有者</dt><dd class="mono" :title="inspector.resource.ownerUserId">{{ inspector.resource.ownerUserId }}</dd></div>
              <div><dt>可用性</dt><dd :data-rl-detail-availability="inspector.resource.availability">{{ AVAILABILITY_LABEL[inspector.resource.availability] }}</dd></div>
            </dl>

            <div class="rl-detail-scope">
              <div class="rl-frow">
                <div class="rl-lab"><b>可见范围</b><small>仅自己 / 本部门 / 组织</small></div>
                <strong class="rl-value" :data-rl-scope="inspector.resource.scope || 'PERSONAL'">{{ scopeLabelOf(inspector.resource.scope) }}</strong>
              </div>
              <p class="rl-note" data-rl-scope-note>数据层没有范围修改命令，这里只读展示（可编辑范围 NOT VERIFIED）。</p>
              <div class="rl-frow">
                <div class="rl-lab"><b>允许 Agent 使用</b><small>开启后获授权的助理与应用可以读取它</small></div>
                <strong class="rl-value" :data-rl-agent="agentAllowed ? 'on' : 'off'">{{ agentAllowed ? "允许" : "不允许" }}</strong>
              </div>
              <p class="rl-note" data-rl-agent-note>Agent 授权开关命令未接入；这里显示的是能力位（可切换开关 NOT VERIFIED）。</p>
            </div>

            <div class="rl-detail-actions">
              <DsButton variant="primary" size="sm" data-rl-detail-open @click="openSelected">打开</DsButton>
              <DsButton variant="secondary" size="sm" :status="downloadBusy ? 'loading' : 'idle'" :disabled="inspector.resource.trashed" data-rl-detail-download @click="downloadSelected"><Download :size="14" /> 下载</DsButton>
              <DsButton v-if="detailCanvasNodes.length" variant="secondary" size="sm" data-rl-detail-locate @click="locateInCanvas(detailCanvasNodes[0])"><MapPin :size="14" /> 在画布中定位</DsButton>
              <DsButton variant="ghost" size="sm" data-d3-04b-action="favorite" :aria-pressed="inspector.favorite" @click="toggleFavorite">{{ inspector.favorite ? "取消收藏" : "收藏" }}</DsButton>
              <DsButton v-if="['memory', 'text', 'code', 'prompt'].includes(inspector.resource.resourceType) && !inspector.trashed" variant="secondary" size="sm" data-d3-04b-action="edit" :disabled="!canEdit" @click="openEditor(inspector.resource.resourceRef)">编辑内容</DsButton>
              <DsButton v-if="!inspector.trashed" variant="danger" size="sm" data-d3-04b-action="delete" :disabled="!canDelete" @click="deleteSelected">移到回收站</DsButton>
              <template v-else>
                <DsButton variant="secondary" size="sm" data-d3-04b-action="restore" @click="restoreSelected">恢复</DsButton>
                <DsButton variant="danger" size="sm" data-d3-04b-action="permanent-delete" @click="confirmPermanentDelete(inspector.resource.resourceId, inspector.resource.name)">永久删除</DsButton>
              </template>
            </div>
            <p v-if="downloadNotice" class="rl-ok" role="status" data-rl-download-notice>{{ downloadNotice }}</p>
            <p v-if="downloadError" class="rl-error" role="alert" data-rl-download-error>{{ downloadError }}</p>
            <p v-if="locateNotice" class="rl-note" role="status" data-rl-locate-notice>{{ locateNotice }}</p>

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


<style scoped>
/* task-61：左侧分类 / 中间按来源/画布分组 / 右侧固定详情。 */
.rl-app {
  grid-template-columns: 216px minmax(0, 1fr) 340px;
  position: relative;
}
.rl-head { display: flex; align-items: center; gap: 10px; margin: 2px 0 10px; }
.rl-group-switch {
  margin-left: auto;
  display: inline-flex;
  gap: 1px;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: var(--sunken);
}
.rl-group-switch button {
  border: 0;
  background: none;
  color: var(--muted);
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  cursor: pointer;
  font-size: var(--fs-caption);
}
.rl-group-switch button.is-active { background: rgb(var(--content-rgb)); color: var(--text); box-shadow: 0 1px 2px rgb(0 0 0 / 0.1); }
.rl-group { margin: 0 0 18px; }
.rl-group-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 8px;
  padding: 0 2px;
}
.rl-group-title { font-size: var(--fs-secondary); font-weight: var(--fw-medium); color: var(--text); }
.rl-group-count {
  padding: 0 7px;
  border-radius: var(--radius-pill);
  background: rgb(var(--text-rgb) / 0.07);
  color: var(--muted);
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
  line-height: 17px;
}
.rl-group-hint { color: var(--muted); font-size: var(--fs-micro); }
.rl-group-time { margin-left: auto; color: var(--muted); font-size: var(--fs-micro); }

.rl-detail {
  margin: 8px 8px 8px 0;
  padding: 14px;
  border-radius: var(--radius-lg);
  background: var(--sunken);
  overflow: auto;
  min-width: 0;
  min-height: 0;
}
.rl-detail-empty {
  height: 100%;
  min-height: 220px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
  color: var(--muted);
  font-size: var(--fs-secondary);
  padding: 0 12px;
}
.rl-detail-empty-icon { color: var(--muted); opacity: 0.7; }
.rl-detail-empty .rl-note { margin: 0; max-width: 230px; }
.rl-detail-body { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.rl-detail-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.rl-detail-close {
  margin-left: auto;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--radius-md);
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.rl-detail-close:hover { background: var(--row-hover); color: var(--text); }
.rl-detail-preview {
  min-height: 120px;
  max-height: 240px;
  border-radius: var(--radius-md);
  background: rgb(var(--text-rgb) / 0.05);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.rl-detail-media { display: block; max-width: 100%; max-height: 240px; object-fit: contain; }
.rl-detail-pdf { width: 100%; height: 220px; border: 0; }
.rl-detail-text {
  margin: 0;
  padding: 10px 12px;
  width: 100%;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: var(--fs-caption);
  line-height: var(--lh-relaxed);
  color: var(--text);
}
.rl-detail-name { margin: 0; font-size: var(--fs-heading); font-weight: var(--fw-medium); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.rl-fields { margin: 0; display: grid; grid-template-columns: 78px minmax(0, 1fr); gap: 6px 10px; font-size: var(--fs-caption); }
.rl-fields div { display: contents; }
.rl-fields dt { color: var(--muted); }
.rl-fields dd { margin: 0; color: var(--text); overflow-wrap: anywhere; min-width: 0; }
.rl-fields dd.mono { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rl-detail-actions .ds-btn { min-width: 0; }
.rl-detail-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.rl-detail-actions .ds-btn:first-child { flex: 1 1 auto; justify-content: center; }
.rl-ok { margin: 0; color: var(--accent); font-size: var(--fs-caption); }
.rl-note { line-height: var(--lh-relaxed); }
.rl-nav { margin: 8px 0 8px 8px; }
.rl-content { padding: 10px 16px 14px; }

/* ── 原型对照（task-5）：两栏 + 右侧滑入详情 + 卡片网格 ───────────────── */
.rl-app { grid-template-columns: 218px minmax(0, 1fr); }
.rl-app[data-detail-open="true"] { grid-template-columns: 218px minmax(0, 1fr) 300px; }
.rl-app[data-detail-open="false"] .rl-detail { display: none; }
.rl-content { position: relative; padding-top: 0; }
.rl-nav { width: 210px; }
.rl-toolbar--proto .rl-title { font-size: 15px; line-height: 22px; }
.rl-toolbar--proto { height: 52px; margin: 0; padding: 0 10px; }
.rl-toolbar--proto .rl-title { font-size: var(--fs-secondary); }
.rl-chips { margin: 0; padding: 0 10px 10px; }
.rl-grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; padding-top: 8px; }
.rl-card .rl-thumb { aspect-ratio: auto; height: 190px; }
.rl-nav--proto .rl-nav-section {
  padding: 12px 10px 4px;
  font-size: var(--fs-micro);
  font-weight: var(--fw-medium);
  color: var(--muted);
}
.rl-nav--proto .rl-nav-item {
  min-height: 32px;
  padding: 0 10px;
  gap: 9px;
  border-radius: var(--radius-md);
  font-size: var(--fs-secondary);
}
.rl-nav--proto .rl-nav-label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.rl-nav--proto .rl-nav-item .rl-count { margin-left: auto; font-size: var(--fs-micro); color: var(--muted); font-variant-numeric: tabular-nums; }
.rl-nav--proto .rl-nav-item.is-active { background: rgb(var(--text-rgb) / 0.1); color: var(--text); font-weight: var(--fw-medium); }
.rl-toolbar--proto { display: flex; align-items: center; gap: 10px; margin: 0 0 10px; }
.rl-toolbar--proto .rl-title { display: flex; align-items: baseline; gap: 8px; margin: 0; font-size: var(--fs-title); font-weight: var(--fw-medium); }
.rl-toolbar--proto .rl-title small { font-size: var(--fs-caption); font-weight: var(--fw-regular); color: var(--muted); }
.rl-toolbar--proto .ds-search { width: 210px; flex: none; }
.rl-menu { position: relative; }
.rl-menu > summary {
  list-style: none;
  cursor: pointer;
  height: 28px;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-pill);
  background: rgb(var(--text-rgb) / 0.07);
  font-size: var(--fs-secondary);
  color: var(--text);
  user-select: none;
}
.rl-menu > summary::-webkit-details-marker { display: none; }
.rl-menu[open] > summary { background: rgb(var(--text-rgb) / 0.12); }
.rl-menu > summary.rl-add { background: var(--accent); color: var(--on-accent); }
.rl-menu-body {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 20;
  min-width: 180px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-radius: var(--radius-lg);
  background: rgb(var(--content-rgb) / 0.98);
  box-shadow: var(--elevation-2);
}
.rl-menu-body--wide { min-width: 240px; }
.rl-menu-body button {
  border: 0;
  background: none;
  text-align: left;
  padding: 7px 10px;
  border-radius: var(--radius-md);
  font-size: var(--fs-secondary);
  color: var(--text);
  cursor: pointer;
}
.rl-menu-body button:hover { background: var(--row-hover); }
.rl-menu-body button.is-active { background: rgb(var(--text-rgb) / 0.1); font-weight: var(--fw-medium); }
.rl-menu-row { display: flex; gap: 4px; padding: 4px; }
.rl-menu-row button { flex: 1 1 auto; text-align: center; padding: 5px 6px; }
.rl-field { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; font-size: var(--fs-caption); color: var(--muted); }
.rl-field select { border: 0; background: rgb(var(--text-rgb) / 0.06); color: var(--text); border-radius: var(--radius-md); padding: 4px 6px; font: inherit; font-size: var(--fs-caption); }
.rl-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 0 0 12px; }
.rl-chip {
  height: 26px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius-pill);
  background: rgb(var(--text-rgb) / 0.06);
  color: var(--muted);
  font-size: var(--fs-caption);
  cursor: pointer;
  transition: background var(--dur-feedback) var(--ease-standard), color var(--dur-feedback) var(--ease-standard);
}
.rl-chip:hover { background: rgb(var(--text-rgb) / 0.1); color: var(--text); }
.rl-chip.on { background: var(--accent); color: var(--on-accent); }
.rl-grid { grid-template-columns: repeat(auto-fill, minmax(176px, 1fr)); gap: 14px; }
.rl-card {
  border-radius: var(--radius-lg);
  background: rgb(var(--text-rgb) / 0.04);
  box-shadow: var(--elevation-1);
  overflow: hidden;
  cursor: pointer;
}
.rl-card:hover { background: rgb(var(--text-rgb) / 0.07); box-shadow: var(--elevation-card-hover); }
.rl-card.is-selected { box-shadow: 0 0 0 2px var(--accent); }
.rl-card .rl-thumb { aspect-ratio: 4 / 3; display: grid; place-items: center; position: relative; color: var(--muted); background: rgb(var(--text-rgb) / 0.04); }
.rl-card .rl-thumb-img { width: 100%; height: 100%; object-fit: cover; }
.rl-fav-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--radius-pill);
  background: rgb(var(--content-rgb) / 0.82);
  color: var(--muted);
  font-size: 13px;
  line-height: 1;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.rl-fav-btn.is-on { color: var(--text); }
.rl-duration {
  position: absolute;
  left: 8px;
  bottom: 8px;
  padding: 0 6px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-sm);
  background: rgb(0 0 0 / 0.55);
  color: #fff;
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
}
.rl-duration-source { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.rl-card-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 2px; }
.rl-card-name { font-size: var(--fs-secondary); font-weight: var(--fw-medium); color: var(--text); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rl-card-meta { font-size: var(--fs-caption); color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rl-detail-scope { display: flex; flex-direction: column; gap: 6px; padding: 10px 0 2px; }
.rl-frow { display: flex; align-items: center; gap: 10px; justify-content: space-between; }
.rl-lab { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: var(--fs-secondary); }
.rl-lab small { color: var(--muted); font-size: var(--fs-micro); }
.rl-value { font-size: var(--fs-secondary); font-weight: var(--fw-medium); }
.rl-cap, .rl-note { color: var(--muted); font-size: var(--fs-micro); line-height: var(--lh-normal); }

/* task-8：详情改为 grid 内嵌列（不再覆盖卡片/底部栏） */
.rl-detail {
  position: static;
  width: auto;
  height: auto;
  min-height: 0;
  margin: 0;
  padding: 14px;
  border-radius: 0;
  border-left: 0.5px solid var(--line);
  background: rgb(var(--content-rgb) / 0.98);
  overflow: auto;
  transform: none;
  pointer-events: auto;
  box-shadow: none;
  z-index: auto;
}

@media (max-width: 1180px) {
  .rl-app { grid-template-columns: 200px minmax(0, 1fr); }
  .rl-detail {
    position: absolute;
    top: 8px;
    right: 8px;
    bottom: 8px;
    width: min(360px, calc(100% - 56px));
    z-index: 20;
    margin: 0;
    background: rgb(var(--content-rgb));
    box-shadow: var(--shadow);
    transform: translateX(calc(100% + 24px));
    transition: transform var(--dur-standard) var(--ease-standard);
    pointer-events: none;
  }
  .rl-detail.is-open { transform: none; pointer-events: auto; }
}

@media (max-width: 820px) {
  .rl-app { grid-template-columns: 176px minmax(0, 1fr); }
  .rl-content { padding: 8px 10px 12px; }
  .rl-detail { width: min(340px, calc(100% - 24px)); }
  .rl-toolbar-actions { margin-left: 0; }
  .rl-group-time { display: none; }
}
</style>
<style scoped>
/* task-57：卡片固定结构 = 92px 缩略图槽 + 下方文字区（task-61 重排后继续生效）。 */
.rl-card {
  display: flex;
  flex-direction: column;
  gap: 0;
  height: 100%;
  padding: 0;
  overflow: hidden;
}
.rl-card > .rl-card-body { margin-left: 0; margin-right: 0; }
.rl-thumb {
  flex: 0 0 92px;
  width: 100%;
  height: 92px;
  min-height: 92px;
  margin: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rl-thumb-img {
  display: block;
  flex: none;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
}
.rl-card-body {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px 10px;
}
.rl-card-name { min-width: 0; }
.rl-list .rl-card { height: auto; padding: 0; }
.rl-list .rl-card .rl-thumb { display: none; }
.rl-list .rl-card-body { padding: 10px 12px; }

/* task-8 final overrides */
.rl-nav { margin: 8px 0 8px 8px !important; width: 210px; }
.rl-content { padding: 0 10px 14px; }
.rl-toolbar--proto { padding: 0; }
.rl-toolbar--proto .rl-title { margin-left: 10px; font-size: 15px; line-height: 22px; }
.rl-chips { padding: 0 0 10px 10px; }
.rl-grid { padding: 18px 0 0; }
.rl-card .rl-thumb { height: 190px; aspect-ratio: auto; }
.rl-card-body { padding: 10px 12px; }

.rl-content { padding: 0 0 14px; }
.rl-toolbar--proto { padding: 0 20px; align-items: center; margin: 0; }
.rl-toolbar--proto .rl-title { margin-left: 0; }
.rl-chips { margin: 0; padding: 0 0 10px 20px; }
.rl-grid { padding: 18px 0 0 0; }
.rl-card { min-height: 244px; }
.rl-card .rl-thumb { height: 190px; min-height: 190px; }

.rl-grid { padding: 18px 0 0 24px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
.rl-card .rl-thumb { height: 185px; min-height: 185px; }
.rl-toolbar--proto .rl-title { align-self: center; }

.rl-toolbar--proto .rl-title { margin-top: 10px; }

.rl-chips { padding-bottom: 0; }
.rl-grid { padding: 18px 24px 0 24px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
.rl-card { width: 250px; min-width: 0; }
.rl-card .rl-thumb { height: 185px; min-height: 185px; }

.rl-grid { margin: 18px 24px 0; padding: 0; width: auto; }
.rl-toolbar--proto .rl-title { margin-top: 15px; }

@container (max-width: 760px) {
  .rl-toolbar--proto { flex-wrap: wrap; height: auto; min-height: 52px; padding: 6px 20px; row-gap: 6px; }
  .rl-toolbar--proto .ds-search { width: 180px; }
}
</style>
