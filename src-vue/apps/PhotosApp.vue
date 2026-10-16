<script setup lang="ts">
/**
 * 照片应用（Vue 壳层）· 图库 + 图像工坊。
 *
 * 与 React 版（src/photos/PhotosApp.tsx + LibraryView.tsx + StudioView.tsx）同结构、同状态分支、同文案：
 * 左栏两个子视图，右栏对应内容；三通道逐字对应 window.openarc.photos / photocraft / appExchange 的 command。
 *
 * 规则层不重写：错误码→中文、分页推导、来源/文件夹树、三态可见性、appExchange target 过滤与不可用态、
 * base64url 还原全部 import src/photos/photosLogic.ts 与 studioLogic.ts（无框架依赖的纯 TS）。
 * 样式只 import src/photos/photos.css 并套既有 .photos-* 类名，不新增 token / 字面色值 / 描边；
 * 外层 .split / .split-side / .split-nav / .split-main 与 .dialog 复用 styles.css 既有实现。
 *
 * 与 React 版的一处刻意差异：错误码只留在 data-* 属性里，界面正文只出现 photosLogic/studioLogic
 * 映射出的中文文案（React 版会在正文追加「（CODE）」）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Film,
  FolderPlus,
  Image as ImageIcon,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Send,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
} from "lucide-vue-next";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsDialog from "../design-system/DsDialog.vue";
import DsPageState from "../design-system/DsPageState.vue";
import DsSearchField from "../design-system/DsSearchField.vue";
import DsTextField from "../design-system/DsTextField.vue";
import {
  IMPORT_DESTINATIONS,
  PHOTOS_PAGE_LIMIT_DEFAULT,
  assignSummary,
  backgroundRemovalHint,
  base64UrlToBytes,
  base64UrlToDataUrl,
  buildLocalFolderTree,
  buildVirtualFolderTree,
  decodedByteLength,
  dependencyReport,
  domainBridge,
  flattenFolderTree,
  folderOptions,
  formatBytes,
  formatTimestamp,
  isAllowedPhotosCommand,
  localFailure,
  mergePage,
  pageState,
  photoKindLabel,
  photosErrorState,
  photosErrorText,
  resultFailure,
  resultValue,
  sourcesTruncationNotices,
  visionModelsView,
} from "../../src/photos/photosLogic";
import type { FailureView, LocalFolderNode, VisionModelsView } from "../../src/photos/photosLogic";
import {
  appExchangeErrorText,
  buildExchangeRequest,
  canEditProject,
  canPurge,
  defaultTargetKey,
  exchangeResultText,
  exportArtifactName,
  groupOptions,
  groupProjects,
  isAllowedAppExchangeCommand,
  isAllowedPhotocraftCommand,
  membersInputValue,
  newRequestId,
  parseMembersInput,
  photocraftErrorState,
  photocraftErrorText,
  sourceDownloadName,
  targetOptionLabel,
  targetsPageState,
  targetsUnavailableNotice,
  targetsView,
  TRASH_PURGE_HINT,
  visibilityControl,
  visibilityLabel,
  visibilityUpdatePayload,
} from "../../src/photos/studioLogic";
import type { Visibility } from "../../src/photos/studioLogic";
import type {
  AppExchangeTargetsValue,
  ExchangeCanvas,
  ExchangeResult,
  PhotoCraftGroup,
  PhotoCraftProject,
  PhotoItem,
  PhotoLocalFolder,
  PhotoSource,
  PhotosBackgroundRemovalValue,
  PhotosHealthValue,
  PhotosReversePromptValue,
  PhotosSourceFileValue,
  PhotosSourceThumbnailValue,
  PhotosSourcesListValue,
  PhotoVirtualFolder,
  PhotocraftProjectsListValue,
  PhotocraftReadSourceValue,
  PhotocraftTrashListValue,
} from "../../src/photos/types";
import "../../src/photos/photos.css";

type Tab = "library" | "studio";
const tab = ref<Tab>("library");

const host: unknown = typeof window === "undefined" ? null : window;
const photosBridge = domainBridge(host, "photos");
const photocraftBridge = domainBridge(host, "photocraft");
const exchangeBridge = domainBridge(host, "appExchange");

type NoticeTone = "info" | "success" | "warning" | "error";
type Notice = { tone: NoticeTone; text: string };
function noticeText(title: string, description?: string): string {
  return description ? title + "：" + description : title;
}
function failCode(res: unknown, fallback = "RESPONSE_INCOMPLETE"): string {
  return (resultFailure(res) || localFailure(fallback, "")).code;
}
function modelKey(model: { providerId: string; model: string }): string {
  return model.providerId + "\u0000" + model.model;
}
function isOk(res: unknown): boolean {
  return !!res && typeof res === "object" && (res as { ok?: unknown }).ok === true;
}

async function callPhotos(command: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  if (!photosBridge) return { ok: false, error: "NO_BRIDGE", message: "桌面桥未接入（当前环境没有照片域）" };
  if (!isAllowedPhotosCommand(command)) return { ok: false, error: "PHOTOS_COMMAND_NOT_ALLOWED", message: "" };
  try {
    return await photosBridge.command({ command, payload });
  } catch (error) {
    return { ok: false, error: "DXOS_ERR_INTERNAL", message: String((error as Error)?.message || error) };
  }
}
async function callPhotocraft(command: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  if (!photocraftBridge) return { ok: false, error: "NO_BRIDGE", message: "桌面桥未接入（当前环境没有图像工坊域）" };
  if (!isAllowedPhotocraftCommand(command)) return { ok: false, error: "PHOTOCRAFT_COMMAND_NOT_ALLOWED", message: "" };
  try {
    return await photocraftBridge.command({ command, payload });
  } catch (error) {
    return { ok: false, error: "DXOS_ERR_INTERNAL", message: String((error as Error)?.message || error) };
  }
}
async function callExchange(command: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  if (!exchangeBridge) return { ok: false, error: "NO_BRIDGE", message: "桌面桥未接入（当前环境没有应用互传域）" };
  if (!isAllowedAppExchangeCommand(command)) return { ok: false, error: "APP_EXCHANGE_COMMAND_NOT_ALLOWED", message: "" };
  try {
    return await exchangeBridge.command({ command, payload });
  } catch (error) {
    return { ok: false, error: "DXOS_ERR_INTERNAL", message: String((error as Error)?.message || error) };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   图库视图（photos 域 + appExchange）
   ══════════════════════════════════════════════════════════════════════════ */
type LibraryDialog =
  | { kind: "add-source" }
  | { kind: "new-folder"; parentId: string | null }
  | { kind: "remove-folder"; folder: PhotoVirtualFolder }
  | { kind: "remove-source"; source: PhotoSource }
  | { kind: "assign" }
  | { kind: "import" }
  | null;

type LibraryDetail =
  | { status: "none" }
  | { status: "loading"; item: PhotoItem }
  | { status: "ready"; item: PhotoItem; raw?: string; preview: string; hasRaw: boolean; size?: number; note?: string }
  | { status: "error"; item: PhotoItem; code: string; text: string };

type PromptState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; text: string; providerId: string; model: string }
  | { status: "error"; code: string; text: string };

type RemovalState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; dataUrl: string; raw: string; bytes: number }
  | { status: "error"; code: string; text: string };

const LIB_PAGE = PHOTOS_PAGE_LIMIT_DEFAULT;

const libNotice = ref<Notice | null>(null);
function notifyLib(tone: NoticeTone, title: string, description?: string) {
  libNotice.value = { tone, text: noticeText(title, description) };
}

const libLoading = ref(true);
const libBusy = ref<string | null>(null);
const libFailure = ref<FailureView | null>(null);
const sources = ref<PhotoSource[]>([]);
const folders = ref<PhotoLocalFolder[]>([]);
const virtualFolders = ref<PhotoVirtualFolder[]>([]);
const items = ref<PhotoItem[]>([]);
const slice = reactive({ offset: 0, limit: LIB_PAGE, total: 0, truncated: false });
const libNotices = ref<string[]>([]);
const health = ref<PhotosHealthValue | null>(null);

const sourceFilter = ref<string | null>(null);
const localFilter = ref<PhotoLocalFolder | null>(null);
const virtualFilter = ref<PhotoVirtualFolder | null>(null);
const expandedVirtual = reactive(new Set<string>());
const query = ref("");
const selection = ref<string[]>([]);

const libSelected = ref<PhotoItem | null>(null);
const libDialog = ref<LibraryDialog>(null);
const addPath = ref("");
const folderName = ref("");
const folderParent = ref("");
const assignTarget = ref("");
const importDestination = ref<"canvas" | "library">("canvas");
const importTargetId = ref("");
const canvases = ref<ExchangeCanvas[]>([]);
const exchangeNote = ref("");

const detail = ref<LibraryDetail>({ status: "none" });
const vision = ref<VisionModelsView | null>(null);
const visionPick = ref("");
const promptState = ref<PromptState>({ status: "idle" });
const removal = ref<RemovalState>({ status: "idle" });

const thumbUrls = reactive<Record<string, string>>({});
const thumbFailedIds = reactive<Record<string, boolean>>({});
const thumbCache = new Map<string, string>();
const thumbFailed = new Set<string>();
let detailSeq = 0;

async function loadPage(nextOffset: number) {
  libLoading.value = true;
  libBusy.value = nextOffset === 0 ? "reload" : "more";
  const res = await callPhotos("photos/sources/list", { offset: nextOffset, limit: LIB_PAGE });
  const value = resultValue<PhotosSourcesListValue>(res);
  if (value) {
    sources.value = Array.isArray(value.sources) ? value.sources : [];
    folders.value = Array.isArray(value.folders) ? value.folders : [];
    virtualFolders.value = Array.isArray(value.virtualFolders) ? value.virtualFolders : [];
    const pageItems = Array.isArray(value.items) ? value.items : [];
    items.value = nextOffset === 0 ? pageItems : mergePage(items.value, pageItems, (item) => item.id);
    slice.offset = Number(value.offset) || 0;
    slice.limit = Number(value.limit) || LIB_PAGE;
    slice.total = Number(value.total) || 0;
    slice.truncated = value.truncated === true;
    libNotices.value = sourcesTruncationNotices(value);
    libFailure.value = null;
  } else {
    libFailure.value = resultFailure(res) || localFailure("RESPONSE_INCOMPLETE", "photos/sources/list 没有返回记录");
  }
  libLoading.value = false;
  libBusy.value = null;
}

async function loadHealth() {
  const res = await callPhotos("photos/health", {});
  const value = resultValue<PhotosHealthValue>(res);
  if (value) health.value = value;
}

/* ── 缩略图：网格项进入视口 120px 才请求（与 React 版同一条懒加载规则）── */
const gridRoot = ref<HTMLElement | null>(null);
const observedCards = new Set<string>();
let cardObserver: IntersectionObserver | null = null;

function thumbKey(item: PhotoItem): string {
  return item.id + ":" + item.updated_ts;
}
async function loadThumb(item: PhotoItem) {
  if (thumbUrls[item.id] || thumbFailedIds[item.id]) return;
  const key = thumbKey(item);
  const cached = thumbCache.get(key);
  if (cached) {
    thumbUrls[item.id] = cached;
    return;
  }
  if (thumbFailed.has(key)) {
    thumbFailedIds[item.id] = true;
    return;
  }
  const res = await callPhotos("photos/sourceThumbnail", { id: item.id, size: 256 });
  const value = resultValue<PhotosSourceThumbnailValue>(res);
  if (!value || typeof value.data !== "string") {
    thumbFailed.add(key);
    thumbFailedIds[item.id] = true;
    return;
  }
  const dataUrl = base64UrlToDataUrl(value.data, "image/jpeg");
  thumbCache.set(key, dataUrl);
  thumbUrls[item.id] = dataUrl;
}
function observeCards() {
  const rootEl = gridRoot.value;
  if (!rootEl) return;
  if (typeof IntersectionObserver !== "function") {
    for (const item of visibleItems.value) void loadThumb(item);
    return;
  }
  if (!cardObserver) {
    cardObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          const id = el.dataset.photoId || "";
          if (!id) continue;
          cardObserver?.unobserve(el);
          const item = items.value.find((entry2) => entry2.id === id);
          if (item) void loadThumb(item);
        }
      },
      { rootMargin: "120px" },
    );
  }
  rootEl.querySelectorAll<HTMLElement>("[data-photo-id]").forEach((el) => {
    const id = el.dataset.photoId || "";
    if (!id || observedCards.has(id) || thumbUrls[id]) return;
    observedCards.add(id);
    cardObserver?.observe(el);
  });
}
watch(tab, (value) => {
  if (value !== "library") {
    cardObserver?.disconnect();
    cardObserver = null;
    observedCards.clear();
    return;
  }
  void nextTick(() => observeCards());
});

/* ── 详情：快速点选时只有最后一次响应落地 ── */
async function openItem(item: PhotoItem) {
  const seq = ++detailSeq;
  libSelected.value = item;
  detail.value = { status: "loading", item };
  promptState.value = { status: "idle" };
  removal.value = { status: "idle" };
  const rawRes = item.kind === "image" ? await callPhotos("photos/sourceFile", { id: item.id }) : null;
  if (detailSeq !== seq) return;
  const rawValue = rawRes ? resultValue<PhotosSourceFileValue>(rawRes) : null;
  if (rawValue && typeof rawValue.data === "string") {
    detail.value = {
      status: "ready",
      item,
      raw: rawValue.data,
      preview: base64UrlToDataUrl(rawValue.data, rawValue.mime || item.mime),
      hasRaw: true,
      size: Number(rawValue.size) || item.size,
    };
    return;
  }
  const rawFail = rawRes ? resultFailure(rawRes) : null;
  const thumbRes = await callPhotos("photos/sourceThumbnail", { id: item.id, size: 1024 });
  if (detailSeq !== seq) return;
  const thumbValue = resultValue<PhotosSourceThumbnailValue>(thumbRes);
  if (thumbValue && typeof thumbValue.data === "string") {
    detail.value = {
      status: "ready",
      item,
      preview: base64UrlToDataUrl(thumbValue.data, "image/jpeg"),
      hasRaw: false,
      note: rawFail
        ? photosErrorText(rawFail.code)
        : item.kind === "video"
          ? "视频只提供封面缩略图；原片导出走文件传输域。"
          : "",
    };
    return;
  }
  const finalFail = resultFailure(thumbRes) || rawFail;
  detail.value = finalFail
    ? { status: "error", item, code: finalFail.code, text: photosErrorText(finalFail.code) }
    : { status: "error", item, code: "RESPONSE_INCOMPLETE", text: photosErrorText("RESPONSE_INCOMPLETE") };
}
function retryDetail() {
  const d = detail.value;
  const item = d.status === "error" || d.status === "loading" ? d.item : libSelected.value;
  if (item) void openItem(item);
}

/* ── 来源 / 文件夹 / 归类 / 导入 ── */
function resetFilters() {
  sourceFilter.value = null;
  localFilter.value = null;
  virtualFilter.value = null;
  query.value = "";
}
function toggleSource(id: string) {
  localFilter.value = null;
  sourceFilter.value = sourceFilter.value === id ? null : id;
}
function toggleLocal(node: PhotoLocalFolder) {
  sourceFilter.value = node.sourceId;
  localFilter.value = localFilter.value && localFilter.value.id === node.id ? null : node;
}
function toggleVirtual(node: PhotoVirtualFolder) {
  virtualFilter.value = virtualFilter.value && virtualFilter.value.id === node.id ? null : node;
}
function toggleVirtualExpand(id: string) {
  if (expandedVirtual.has(id)) expandedVirtual.delete(id);
  else expandedVirtual.add(id);
}
function toggleSelection(id: string) {
  selection.value = selection.value.includes(id) ? selection.value.filter((value) => value !== id) : [...selection.value, id];
}
function openAddSource() {
  addPath.value = "";
  libDialog.value = { kind: "add-source" };
}
function openNewFolder(parentId: string | null) {
  folderName.value = "";
  folderParent.value = parentId || "";
  libDialog.value = { kind: "new-folder", parentId };
}
function openRemoveFolder(node: { id: string; name: string; parentId: string | null }) {
  libDialog.value = { kind: "remove-folder", folder: { id: node.id, name: node.name, parentId: node.parentId } };
}
function openRemoveSource(source: PhotoSource) {
  libDialog.value = { kind: "remove-source", source };
}
function openAssign() {
  assignTarget.value = "";
  libDialog.value = { kind: "assign" };
}
function libFail(context: string, res: unknown) {
  notifyLib("error", context + "失败", photosErrorText(failCode(res)));
}

async function submitAddSource() {
  const path = addPath.value.trim();
  if (!path) return;
  libBusy.value = "add-source";
  const res = await callPhotos("photos/sources/add", { path });
  const value = resultValue<{ source: PhotoSource; created: boolean }>(res);
  libBusy.value = null;
  if (!value) {
    libFail("添加来源", res);
    return;
  }
  libDialog.value = null;
  addPath.value = "";
  notifyLib(value.created ? "success" : "info", value.created ? "已添加来源" : "这个文件夹已经是来源", value.source?.name || path);
  await loadPage(0);
}
async function submitFolder() {
  const name = folderName.value.trim();
  if (!name) return;
  libBusy.value = "folder";
  const res = await callPhotos("photos/folders/create", { name, parentId: folderParent.value || null });
  const value = resultValue<{ folder: PhotoVirtualFolder }>(res);
  libBusy.value = null;
  if (!value) {
    libFail("新建文件夹", res);
    return;
  }
  libDialog.value = null;
  folderName.value = "";
  folderParent.value = "";
  notifyLib("success", "已新建文件夹", value.folder?.name || name);
  await loadPage(0);
}
async function submitRemoveFolder(folder: PhotoVirtualFolder) {
  libBusy.value = "remove-folder";
  const res = await callPhotos("photos/folders/remove", { id: folder.id });
  const value = resultValue<{ id: string; removed: boolean; removedFolderIds: string[] }>(res);
  libBusy.value = null;
  if (!value) {
    libFail("删除文件夹", res);
    return;
  }
  libDialog.value = null;
  if (virtualFilter.value && value.removedFolderIds.indexOf(virtualFilter.value.id) >= 0) virtualFilter.value = null;
  notifyLib("success", "已删除文件夹", "同时删除了 " + Math.max(0, (value.removedFolderIds?.length || 1) - 1) + " 个子文件夹，并清空了它们上的归类。");
  await loadPage(0);
}
async function submitRemoveSource() {
  const d = libDialog.value;
  if (!d || d.kind !== "remove-source") return;
  libBusy.value = "remove-source";
  const res = await callPhotos("photos/sources/remove", { id: d.source.id });
  const value = resultValue<{ id: string; removed: boolean }>(res);
  libBusy.value = null;
  if (!value) {
    libFail("移除来源", res);
    return;
  }
  if (sourceFilter.value === d.source.id) sourceFilter.value = null;
  if (localFilter.value && localFilter.value.sourceId === d.source.id) localFilter.value = null;
  notifyLib("success", "已移除来源", d.source.name);
  thumbCache.clear();
  thumbFailed.clear();
  libDialog.value = null;
  await loadPage(0);
}
async function submitAssign() {
  if (!selection.value.length) return;
  libBusy.value = "assign";
  const res = await callPhotos("photos/folders/assign", { ids: selection.value, folderId: assignTarget.value || null });
  const value = resultValue<unknown>(res);
  libBusy.value = null;
  if (!value) {
    libFail("归类", res);
    return;
  }
  libDialog.value = null;
  notifyLib("success", "归类完成", assignSummary(value));
  selection.value = [];
  await loadPage(0);
}
async function openImport() {
  libDialog.value = { kind: "import" };
  exchangeNote.value = "";
  importDestination.value = "canvas";
  importTargetId.value = "";
  canvases.value = [];
  if (!exchangeBridge) {
    exchangeNote.value = "桌面桥未接入（当前环境没有应用互传域），画布列表无法读取。";
    return;
  }
  try {
    const res = await callExchange("appExchange/targets", {});
    const value = resultValue<{ canvases?: ExchangeCanvas[] }>(res);
    if (value) canvases.value = Array.isArray(value.canvases) ? value.canvases : [];
    else {
      const fail = resultFailure(res);
      exchangeNote.value = fail ? "读取画布列表失败：" + appExchangeErrorText(fail.code) : "读取画布列表失败：返回记录不完整";
    }
  } catch (error) {
    exchangeNote.value = "读取画布列表失败：" + String((error as Error)?.message || error);
  }
}
async function submitImport() {
  const item = detail.value.status === "ready" ? detail.value.item : libSelected.value;
  if (!item) return;
  const targetId = importTargetId.value.trim();
  if (!targetId) {
    const destination = IMPORT_DESTINATIONS.find((entry) => entry.id === importDestination.value);
    notifyLib("warning", "请先填目标 ID", destination?.hint);
    return;
  }
  libBusy.value = "import";
  const res = await callPhotos("photos/importImage", { sourceId: item.id, targetId, destination: importDestination.value });
  const value = resultValue<{ destination: string; targetId: string; cardId?: string; itemId?: string; nodeId?: string }>(res);
  libBusy.value = null;
  if (!value) {
    libFail("导入", res);
    return;
  }
  libDialog.value = null;
  const where = value.cardId ? "画布卡片 " + value.cardId : value.itemId ? "素材库条目 " + value.itemId : value.nodeId ? "节点 " + value.nodeId : value.targetId;
  notifyLib("success", "已导入", where);
}

/* ── 反推提示词 / 抠图 / 下载 ── */
async function loadVision(): Promise<VisionModelsView> {
  if (vision.value) return vision.value;
  const res = await callPhotos("photos/visionModels", {});
  const value = resultValue<unknown>(res);
  const view: VisionModelsView = value
    ? visionModelsView(value)
    : { available: false, models: [], hint: photosErrorText(failCode(res, "PHOTOS_DEPENDENCY_UNAVAILABLE")) };
  vision.value = view;
  if (view.models.length) visionPick.value = modelKey(view.models[0]);
  return view;
}
async function runReversePrompt() {
  const item = detail.value.status === "ready" ? detail.value.item : libSelected.value;
  if (!item) return;
  const view = await loadVision();
  if (!view.available) {
    promptState.value = { status: "error", code: "PHOTOS_PROVIDER_UNAVAILABLE", text: photosErrorText("PHOTOS_PROVIDER_UNAVAILABLE") + " " + view.hint };
    return;
  }
  const picked = view.models.find((model) => modelKey(model) === visionPick.value) || view.models[0];
  promptState.value = { status: "loading" };
  const res = await callPhotos("photos/reversePrompt", { imageId: item.id, providerId: picked.providerId, model: picked.model });
  const value = resultValue<PhotosReversePromptValue>(res);
  if (!value || typeof value.text !== "string") {
    const fail = resultFailure(res) || localFailure("RESPONSE_INCOMPLETE", "");
    promptState.value = {
      status: "error",
      code: fail.code,
      text: photosErrorText(fail.code) + (fail.code === "PHOTOS_PROVIDER_UNAVAILABLE" ? " " + view.hint : ""),
    };
    return;
  }
  promptState.value = { status: "ready", text: value.text, providerId: value.providerId, model: value.model };
}
async function runRemoval() {
  const d = detail.value;
  if (d.status !== "ready" || !d.raw) return;
  removal.value = { status: "loading" };
  const res = await callPhotos("photos/backgroundRemoval", { image: d.raw });
  const value = resultValue<PhotosBackgroundRemovalValue>(res);
  if (value && typeof value.data === "string") {
    removal.value = {
      status: "ready",
      dataUrl: base64UrlToDataUrl(value.data, "image/png"),
      raw: value.data,
      bytes: Number(value.bytes) || decodedByteLength(value.data),
    };
    return;
  }
  const fail = resultFailure(res) || localFailure("DXOS_ERR_INTERNAL", "");
  removal.value = { status: "error", code: fail.code, text: backgroundRemovalHint(fail.detail, fail.code) };
}
function downloadRaw(item: PhotoItem, raw: string, mime: string, suffix?: string) {
  try {
    const bytes = base64UrlToBytes(raw);
    const blob = new Blob([bytes as unknown as BlobPart], { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = (suffix ? item.name.replace(/(\.[^.]+)?$/, suffix) : item.name) || "photo";
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    notifyLib("error", "下载失败", String((error as Error)?.message || error));
  }
}
function downloadDetailRaw() {
  const d = detail.value;
  if (d.status !== "ready" || !d.raw) return;
  downloadRaw(d.item, d.raw, d.item.mime);
}
function downloadRemovalRaw() {
  const d = detail.value;
  const r = removal.value;
  if (d.status !== "ready" || r.status !== "ready") return;
  downloadRaw(d.item, r.raw, "image/png", "-抠图.png");
}
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notifyLib("success", "已复制提示词");
  } catch {
    notifyLib("warning", "复制失败", "请手动选中提示词正文复制。");
  }
}
function copyPrompt() {
  if (promptState.value.status === "ready") void copyText(promptState.value.text);
}

/* ── 图库派生数据 ── */
const page = computed(() => pageState({ offset: slice.offset, limit: slice.limit, total: slice.total, loaded: items.value.length, truncated: slice.truncated }));
const virtualTree = computed(() => buildVirtualFolderTree(virtualFolders.value));
const virtualRows = computed(() => flattenFolderTree(virtualTree.value.roots, expandedVirtual));
const virtualFolderOptions = computed(() => folderOptions(virtualFolders.value));
const localRows = computed(() => {
  const out: LocalFolderNode[] = [];
  const visit = (nodes: LocalFolderNode[]) => {
    for (const node of nodes) {
      out.push(node);
      visit(node.children);
    }
  };
  for (const nodes of buildLocalFolderTree(folders.value).values()) visit(nodes);
  return out;
});
const visibleItems = computed(() => {
  const needle = query.value.trim().toLowerCase();
  const source = sourceFilter.value;
  const local = localFilter.value;
  const virtual = virtualFilter.value;
  return items.value.filter((item) => {
    if (source && item.sourceId !== source) return false;
    if (local && item.sourceId !== local.sourceId) return false;
    if (local && item.relativePath !== local.path && !item.relativePath.startsWith(local.path + "/")) return false;
    if (virtual && item.virtualFolderId !== virtual.id) return false;
    if (needle && !item.name.toLowerCase().includes(needle)) return false;
    return true;
  });
});
watch(
  () => visibleItems.value.map((item) => item.id).join("|"),
  () => {
    void nextTick(() => observeCards());
  },
);
const filterActive = computed(() => Boolean(sourceFilter.value || localFilter.value || virtualFilter.value || query.value.trim()));
const libraryListState = computed<"loading" | "empty" | "error" | "ready">(() => {
  if (libFailure.value && items.value.length === 0 && !libLoading.value) return "error";
  if (libLoading.value && items.value.length === 0) return "loading";
  if (items.value.length === 0) return "empty";
  return "ready";
});
const dependencyRows = computed(() => dependencyReport(health.value));
const virtualFolderName = computed(() => {
  const d = detail.value;
  if (d.status !== "ready") return "";
  const id = d.item.virtualFolderId;
  if (!id) return "未归类";
  return virtualTree.value.byId.get(id)?.name || "已删除的文件夹";
});
const pendingRemoveFolder = computed(() => (libDialog.value?.kind === "remove-folder" ? libDialog.value.folder : null));
const pendingRemoveSource = computed(() => (libDialog.value?.kind === "remove-source" ? libDialog.value.source : null));

/* ══════════════════════════════════════════════════════════════════════════
   图像工坊视图（photocraft 域 + appExchange）
   ══════════════════════════════════════════════════════════════════════════ */
type StudioView = "projects" | "trash";
type StudioDialog =
  | { kind: "create" }
  | { kind: "new-group" }
  | { kind: "remove-group"; group: PhotoCraftGroup }
  | { kind: "trash"; project: PhotoCraftProject }
  | { kind: "purge"; project: PhotoCraftProject }
  | { kind: "send" }
  | null;

const studioNotice = ref<Notice | null>(null);
function notifyStudio(tone: NoticeTone, title: string, description?: string) {
  studioNotice.value = { tone, text: noticeText(title, description) };
}

const studioView = ref<StudioView>("projects");
const studioLoading = ref(true);
const studioFailure = ref<FailureView | null>(null);
const projects = ref<PhotoCraftProject[]>([]);
const trashed = ref<PhotoCraftProject[]>([]);
const groups = ref<PhotoCraftGroup[]>([]);
const studioSelectedId = ref<string | null>(null);
const studioBusy = ref<string | null>(null);

const projectTitle = ref("");
const projectGroupDraft = ref("");
const projectVisibility = ref<Visibility>("private");
const projectMembersText = ref("");

const studioDialog = ref<StudioDialog>(null);
const createTitle = ref("");
const createGroup = ref("");
const createFileName = ref("");
const groupName = ref("");

const sendTargets = ref<AppExchangeTargetsValue | null>(null);
const sendTargetsLoading = ref(false);
const sendTargetsErrorCode = ref<string | null>(null);
const sendTargetKey = ref("");
const sendCanvasId = ref("");
const sendError = ref("");
const sendResult = ref<ExchangeResult | null>(null);

const createFileInput = ref<HTMLInputElement | null>(null);
const exportFileInput = ref<HTMLInputElement | null>(null);

function decodeBase64Bytes(data: string): Uint8Array {
  const binary = atob(String(data == null ? "" : data));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function saveBytes(name: string, bytes: Uint8Array, mime: string) {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name || "download.bin";
  anchor.click();
  URL.revokeObjectURL(url);
}
function readFileBase64(file: File): Promise<{ name: string; mime: string; contentBase64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取本地文件失败"));
    reader.onload = () => {
      const text = String(reader.result || "");
      const comma = text.indexOf(",");
      resolve({
        name: file.name,
        mime: file.type || "application/octet-stream",
        contentBase64: comma >= 0 ? text.slice(comma + 1) : text,
      });
    };
    reader.readAsDataURL(file);
  });
}

async function loadProjects() {
  studioLoading.value = true;
  const res = await callPhotocraft("photocraft/projects/list", {});
  const value = resultValue<PhotocraftProjectsListValue>(res);
  if (value) {
    projects.value = Array.isArray(value.projects) ? value.projects : [];
    groups.value = Array.isArray(value.groups) ? value.groups : [];
    studioFailure.value = null;
  } else {
    studioFailure.value = resultFailure(res) || localFailure("RESPONSE_INCOMPLETE", "projects/list 没有返回记录");
  }
  studioLoading.value = false;
}
async function loadTrash() {
  studioLoading.value = true;
  const res = await callPhotocraft("photocraft/trash/list", {});
  const value = resultValue<PhotocraftTrashListValue>(res);
  if (value) {
    trashed.value = Array.isArray(value.projects) ? value.projects : [];
    studioFailure.value = null;
  } else {
    studioFailure.value = resultFailure(res) || localFailure("RESPONSE_INCOMPLETE", "trash/list 没有返回记录");
  }
  studioLoading.value = false;
}

onMounted(() => {
  void loadPage(0);
  void loadHealth();
  void loadProjects();
  void loadTrash();
  void nextTick(() => observeCards());
});
onBeforeUnmount(() => {
  cardObserver?.disconnect();
  cardObserver = null;
});

const studioPool = computed(() => (studioView.value === "trash" ? trashed.value : projects.value));
const studioSelected = computed(() => studioPool.value.find((project) => project.id === studioSelectedId.value) || null);
const studioOwners = computed(() => canEditProject(studioSelected.value));
const studioMemberDraft = computed(() => parseMembersInput(projectMembersText.value));
const studioControl = computed(() =>
  visibilityControl({ visibility: projectVisibility.value, mine: studioSelected.value ? studioSelected.value.mine : false, members: studioMemberDraft.value }),
);
const buckets = computed(() => groupProjects(projects.value, groups.value));
const studioGroupOptions = computed(() => groupOptions(groups.value));
const projectedTargets = computed(() => targetsView(sendTargets.value, studioSelected.value ? studioSelected.value.sourceMime : ""));
const pickedTarget = computed(() => projectedTargets.value.targets.find((item) => item.key === sendTargetKey.value) || null);
const sendPanelState = computed(() =>
  targetsPageState({
    value: sendTargets.value,
    errorCode: sendTargetsErrorCode.value,
    loading: sendTargetsLoading.value,
    mime: studioSelected.value ? studioSelected.value.sourceMime : "",
  }),
);
const studioListState = computed<"loading" | "empty" | "error" | "unavailable" | "unauthorized" | "ready">(() => {
  if (studioLoading.value && studioPool.value.length === 0) return "loading";
  if (studioFailure.value && studioPool.value.length === 0) {
    const state = photocraftErrorState(studioFailure.value.code);
    if (state === "unauthorized") return "unauthorized";
    if (state === "unavailable") return "unavailable";
    return "error";
  }
  if (studioPool.value.length === 0) return "empty";
  return "ready";
});
const studioErrorKind = computed<"error" | "unavailable" | "unauthorized">(() => {
  if (studioListState.value === "unauthorized") return "unauthorized";
  if (studioListState.value === "unavailable") return "unavailable";
  return "error";
});
const studioGroupName = computed(() => {
  const selected = studioSelected.value;
  if (!selected) return "未命名分组";
  return groups.value.find((group) => group.id === selected.groupId)?.name || "未命名分组";
});
const pendingRemoveGroup = computed(() => (studioDialog.value?.kind === "remove-group" ? studioDialog.value.group : null));
const pendingTrashProject = computed(() => (studioDialog.value?.kind === "trash" ? studioDialog.value.project : null));
const pendingPurgeProject = computed(() => (studioDialog.value?.kind === "purge" ? studioDialog.value.project : null));

watch(
  () => {
    const selected = studioSelected.value;
    return selected ? selected.id + ":" + selected.updatedAt : "";
  },
  () => {
    const selected = studioSelected.value;
    if (!selected) return;
    projectTitle.value = selected.title;
    projectGroupDraft.value = selected.groupId;
    projectVisibility.value = selected.visibility;
    projectMembersText.value = membersInputValue(selected.members);
    sendError.value = "";
    sendResult.value = null;
  },
  { immediate: true },
);

function studioFail(context: string, res: unknown) {
  notifyStudio("error", context + "失败", photocraftErrorText(failCode(res)));
}
function exchangeFail(context: string, res: unknown) {
  const fail = resultFailure(res) || localFailure("RESPONSE_INCOMPLETE", "");
  notifyStudio("error", context + "未完成", targetsUnavailableNotice(fail.code, fail.detail));
}
function studioReload() {
  void (studioView.value === "trash" ? loadTrash() : loadProjects());
}
function selectStudioView(next: StudioView) {
  studioView.value = next;
  studioSelectedId.value = null;
}
function openCreateDialog() {
  createTitle.value = "";
  createGroup.value = groups.value.find((group) => group.isDefault)?.id || groups.value[0]?.id || "";
  createFileName.value = "";
  studioDialog.value = { kind: "create" };
}
function openNewGroup() {
  groupName.value = "";
  studioDialog.value = { kind: "new-group" };
}
function openRemoveGroup(group: { id: string; name: string; mine: boolean; isDefault: boolean }) {
  studioDialog.value = { kind: "remove-group", group: { id: group.id, name: group.name, mine: group.mine, isDefault: group.isDefault } };
}
function openTrashDialog(project: PhotoCraftProject) {
  studioDialog.value = { kind: "trash", project };
}
function openPurgeDialog(project: PhotoCraftProject) {
  studioDialog.value = { kind: "purge", project };
}
function onCreateFileChange(event: Event) {
  createFileName.value = (event.target as HTMLInputElement).files?.[0]?.name || "";
}

async function saveProject() {
  const project = studioSelected.value;
  if (!project || !studioOwners.value) return;
  const payload: Record<string, unknown> = { id: project.id };
  const nextTitle = projectTitle.value.trim();
  if (nextTitle && nextTitle !== project.title) payload.title = nextTitle;
  if (projectGroupDraft.value && projectGroupDraft.value !== project.groupId) payload.groupId = projectGroupDraft.value;
  if (projectVisibility.value !== project.visibility) {
    const next = visibilityUpdatePayload(projectVisibility.value, studioMemberDraft.value);
    payload.visibility = next.visibility;
    payload.members = next.members;
  } else if (projectVisibility.value === "restricted" && membersInputValue(studioMemberDraft.value) !== membersInputValue(project.members)) {
    payload.members = studioMemberDraft.value;
  }
  if (Object.keys(payload).length === 1) {
    notifyStudio("info", "没有需要保存的改动");
    return;
  }
  studioBusy.value = "save";
  const res = await callPhotocraft("photocraft/projects/update", payload);
  const value = resultValue<{ project: PhotoCraftProject }>(res);
  studioBusy.value = null;
  if (!value) {
    studioFail("保存项目", res);
    return;
  }
  notifyStudio("success", "已保存", value.project?.title || nextTitle);
  await loadProjects();
}
async function submitCreate() {
  const nextTitle = createTitle.value.trim();
  if (!nextTitle) {
    notifyStudio("warning", "请填写项目名称");
    return;
  }
  studioBusy.value = "create";
  let payload: Record<string, unknown> = { title: nextTitle };
  if (createGroup.value) payload.groupId = createGroup.value;
  const file = createFileInput.value?.files?.[0];
  if (file) {
    try {
      const read = await readFileBase64(file);
      payload = { ...payload, name: read.name, mime: read.mime, contentBase64: read.contentBase64 };
    } catch (error) {
      studioBusy.value = null;
      notifyStudio("error", "读取本地文件失败", String((error as Error)?.message || error));
      return;
    }
  }
  const res = await callPhotocraft("photocraft/projects/create", payload);
  const value = resultValue<{ project: PhotoCraftProject }>(res);
  studioBusy.value = null;
  if (!value) {
    studioFail("新建项目", res);
    return;
  }
  studioDialog.value = null;
  createTitle.value = "";
  createGroup.value = "";
  createFileName.value = "";
  if (createFileInput.value) createFileInput.value.value = "";
  studioSelectedId.value = value.project?.id || null;
  notifyStudio("success", "已新建项目", value.project?.title || nextTitle);
  await loadProjects();
}
async function submitCreateGroup() {
  studioBusy.value = "group";
  const res = await callPhotocraft("photocraft/groups/create", groupName.value.trim() ? { name: groupName.value.trim() } : {});
  const value = resultValue<{ group: PhotoCraftGroup }>(res);
  studioBusy.value = null;
  if (!value) {
    studioFail("新建分组", res);
    return;
  }
  studioDialog.value = null;
  groupName.value = "";
  notifyStudio("success", "已新建分组", value.group?.name || "默认分组");
  await loadProjects();
}
async function submitRemoveGroup(group: PhotoCraftGroup) {
  studioBusy.value = "remove-group";
  const res = await callPhotocraft("photocraft/groups/remove", { id: group.id });
  const value = resultValue<{ deleted: string; moved: number; fallbackGroupId: string }>(res);
  studioBusy.value = null;
  if (!value) {
    studioFail("删除分组", res);
    return;
  }
  studioDialog.value = null;
  notifyStudio("success", "已删除分组", "已把 " + Number(value.moved || 0) + " 个项目移回默认分组");
  await loadProjects();
}
async function runTrash() {
  const d = studioDialog.value;
  if (!d || d.kind !== "trash") return;
  studioBusy.value = "trash";
  const res = await callPhotocraft("photocraft/projects/trash", { id: d.project.id });
  studioBusy.value = null;
  if (!isOk(res)) {
    studioFail("移入回收站", res);
    return;
  }
  studioDialog.value = null;
  studioSelectedId.value = null;
  notifyStudio("success", "已移入回收站", d.project.title);
  await loadProjects();
  await loadTrash();
}
async function runRestore(project: PhotoCraftProject) {
  studioBusy.value = "restore:" + project.id;
  const res = await callPhotocraft("photocraft/projects/restore", { id: project.id });
  studioBusy.value = null;
  if (!isOk(res)) {
    studioFail("恢复项目", res);
    return;
  }
  notifyStudio("success", "已恢复", project.title);
  await loadProjects();
  await loadTrash();
}
async function runPurge() {
  const d = studioDialog.value;
  if (!d || d.kind !== "purge") return;
  studioBusy.value = "purge";
  const res = await callPhotocraft("photocraft/projects/purge", { id: d.project.id });
  studioBusy.value = null;
  if (!isOk(res)) {
    studioFail("彻底删除", res);
    return;
  }
  studioDialog.value = null;
  studioSelectedId.value = null;
  notifyStudio("success", "已彻底删除", d.project.title);
  await loadTrash();
}
async function studioDownloadSource() {
  const project = studioSelected.value;
  if (!project) return;
  studioBusy.value = "download";
  const res = await callPhotocraft("photocraft/projects/readSource", { id: project.id });
  const value = resultValue<PhotocraftReadSourceValue>(res);
  studioBusy.value = null;
  if (!value || typeof value.base64 !== "string") {
    studioFail("下载源文件", res);
    return;
  }
  const name = sourceDownloadName(value.name, value.mime);
  try {
    saveBytes(name, decodeBase64Bytes(value.base64), value.mime);
    notifyStudio("success", "已开始下载", name);
  } catch (error) {
    notifyStudio("error", "解码源文件失败", String((error as Error)?.message || error));
  }
}
async function submitExport() {
  const project = studioSelected.value;
  if (!project || !studioOwners.value) return;
  const input = exportFileInput.value;
  const file = input?.files?.[0];
  if (!file) return;
  studioBusy.value = "export";
  try {
    const read = await readFileBase64(file);
    const name = exportArtifactName(project, read.name);
    const res = await callPhotocraft("photocraft/projects/export", { id: project.id, name, mime: read.mime, contentBase64: read.contentBase64 });
    studioBusy.value = null;
    if (input) input.value = "";
    if (!resultValue(res)) {
      studioFail("写入导出目录", res);
      return;
    }
    notifyStudio("success", "已写入导出目录", name);
    await loadProjects();
    studioSelectedId.value = project.id;
  } catch (error) {
    studioBusy.value = null;
    notifyStudio("error", "读取本地文件失败", String((error as Error)?.message || error));
  }
}
async function openSend() {
  const project = studioSelected.value;
  if (!project) return;
  studioDialog.value = { kind: "send" };
  sendError.value = "";
  sendResult.value = null;
  sendCanvasId.value = "";
  sendTargets.value = null;
  sendTargetsErrorCode.value = null;
  sendTargetsLoading.value = true;
  const res = await callExchange("appExchange/targets", {});
  const value = resultValue<AppExchangeTargetsValue>(res);
  if (value) {
    sendTargets.value = value;
    sendTargetKey.value = defaultTargetKey(targetsView(value, project.sourceMime).targets, project.sourceMime) || "";
  } else {
    sendTargetsErrorCode.value = resultFailure(res)?.code || "RESPONSE_INCOMPLETE";
  }
  sendTargetsLoading.value = false;
}
async function submitSend() {
  const project = studioSelected.value;
  if (!project) return;
  const picked = pickedTarget.value;
  if (!picked) {
    sendError.value = "请选择一个目标";
    return;
  }
  const built = buildExchangeRequest({
    requestId: newRequestId(project.id, Date.now()),
    target: { appId: picked.target.appId, action: picked.target.action, projectId: picked.needsCanvas ? sendCanvasId.value : undefined },
    asset: { nodeId: project.sourceNodeId || "", photoCraftProjectId: project.id, revision: project.sourceSha256 || undefined },
    needsCanvas: picked.needsCanvas,
  });
  if (!built.ok) {
    sendError.value = built.message;
    return;
  }
  studioBusy.value = "send";
  const res = await callExchange("appExchange/exchange", built.request as unknown as Record<string, unknown>);
  const value = resultValue<ExchangeResult>(res);
  studioBusy.value = null;
  if (!value) {
    const fail = resultFailure(res) || localFailure("DXOS_ERR_INTERNAL", "");
    sendError.value = targetsUnavailableNotice(fail.code, fail.detail);
    return;
  }
  sendResult.value = value;
  sendError.value = "";
  notifyStudio("success", "已发送", exchangeResultText(value));
}
</script>

<template>
  <div class="split" data-photos-app="1">
    <nav class="split-side" aria-label="照片子视图">
      <div class="split-section">照片</div>
      <button type="button" class="split-nav" :aria-current="tab === 'library'" @click="tab = 'library'">
        <ImageIcon :size="16" :stroke-width="1.25" /> 图库
      </button>
      <button type="button" class="split-nav" :aria-current="tab === 'studio'" @click="tab = 'studio'">
        <Wand2 :size="16" :stroke-width="1.25" /> 图像工坊
      </button>
    </nav>

    <div class="split-main" :data-photos-tab="tab">
      <div class="photos-view">
        <!-- ═══════════════════ 图库 ═══════════════════ -->
        <div v-if="tab === 'library'" class="photos-lib" data-photos-lib="1" :data-photos-state="libraryListState">
          <aside class="photos-pane photos-lib-side" aria-label="来源与文件夹">
            <div class="photos-pane-head">
              <h3>来源</h3>
              <button type="button" class="ds-iconbtn ds-iconbtn--ghost ds-iconbtn--sm" data-ds-comp="icon-button" data-ds-variant="ghost" data-ds-status="idle" aria-label="添加照片来源" @click="openAddSource">
                <Plus :size="15" :stroke-width="1.5" />
              </button>
            </div>
            <div class="ds-scroll photos-scroll" data-ds-comp="scroll-area" tabindex="0" role="region" aria-label="来源与文件夹">
              <ul class="photos-list">
                <li class="photos-row">
                  <button type="button" class="photos-row__main" :aria-pressed="!sourceFilter && !localFilter && !virtualFilter" @click="resetFilters">
                    <ImageIcon :size="14" :stroke-width="1.5" />
                    <span class="photos-row__name">全部照片</span>
                    <span class="photos-row__facts">{{ page.total }}</span>
                  </button>
                </li>
                <li v-for="source in sources" :key="source.id" class="photos-row" :class="{ 'is-active': sourceFilter === source.id }">
                  <button type="button" class="photos-row__main" :aria-pressed="sourceFilter === source.id" :disabled="!source.available" @click="toggleSource(source.id)">
                    <span class="photos-row__name" :title="source.name">{{ source.name }}</span>
                    <span class="photos-row__facts">
                      <DsBadge v-if="!source.available" tone="warning" size="sm">不可用</DsBadge>
                    </span>
                  </button>
                  <button type="button" class="ds-iconbtn ds-iconbtn--ghost ds-iconbtn--sm" data-ds-comp="icon-button" data-ds-variant="ghost" data-ds-status="idle" :aria-label="'移除来源 ' + source.name" @click="openRemoveSource(source)">
                    <Trash2 :size="14" :stroke-width="1.5" />
                  </button>
                </li>
              </ul>

              <div class="photos-sub-head"><span>来源子目录</span></div>
              <ul class="photos-list">
                <template v-if="localRows.length">
                  <li v-for="node in localRows" :key="node.id" class="photos-row" :class="{ 'is-active': !!localFilter && localFilter.id === node.id }">
                    <button type="button" class="photos-row__main photos-indent" :style="{ '--photos-depth': node.depth }" :aria-pressed="!!localFilter && localFilter.id === node.id" :title="node.path" @click="toggleLocal(node)">
                      <span class="photos-row__name">{{ node.name }}</span>
                    </button>
                  </li>
                </template>
                <li v-else class="photos-hint">还没有可用的子目录（来源未添加或不可访问）。</li>
              </ul>

              <div class="photos-sub-head">
                <span>虚拟文件夹</span>
                <button type="button" class="ds-iconbtn ds-iconbtn--ghost ds-iconbtn--sm" data-ds-comp="icon-button" data-ds-variant="ghost" data-ds-status="idle" aria-label="新建虚拟文件夹" @click="openNewFolder(null)">
                  <FolderPlus :size="14" :stroke-width="1.5" />
                </button>
              </div>
              <ul class="photos-list">
                <template v-if="virtualRows.length">
                  <li v-for="row in virtualRows" :key="row.node.id" class="photos-row" :class="{ 'is-active': !!virtualFilter && virtualFilter.id === row.node.id }">
                    <button type="button" class="photos-folder-toggle" :data-empty="row.node.children.length === 0" :aria-label="(expandedVirtual.has(row.node.id) ? '收起 ' : '展开 ') + row.node.name" @click="toggleVirtualExpand(row.node.id)">
                      <ChevronDown v-if="expandedVirtual.has(row.node.id)" :size="13" />
                      <ChevronRight v-else :size="13" />
                    </button>
                    <button type="button" class="photos-row__main photos-indent" :style="{ '--photos-depth': row.depth }" :aria-pressed="!!virtualFilter && virtualFilter.id === row.node.id" @click="toggleVirtual(row.node)">
                      <span class="photos-row__name">{{ row.node.name }}</span>
                      <DsBadge v-if="row.node.orphan" tone="warning" size="sm">上级缺失</DsBadge>
                    </button>
                    <button type="button" class="ds-iconbtn ds-iconbtn--ghost ds-iconbtn--sm" data-ds-comp="icon-button" data-ds-variant="ghost" data-ds-status="idle" :aria-label="'新建子文件夹 ' + row.node.name" @click="openNewFolder(row.node.id)">
                      <Plus :size="13" :stroke-width="1.5" />
                    </button>
                    <button type="button" class="ds-iconbtn ds-iconbtn--ghost ds-iconbtn--sm" data-ds-comp="icon-button" data-ds-variant="ghost" data-ds-status="idle" :aria-label="'删除文件夹 ' + row.node.name" @click="openRemoveFolder({ id: row.node.id, name: row.node.name, parentId: row.node.parentId })">
                      <Trash2 :size="13" :stroke-width="1.5" />
                    </button>
                  </li>
                </template>
                <li v-else class="photos-hint">还没有虚拟文件夹。新建一个后可以把照片批量归入。</li>
              </ul>
            </div>
          </aside>

          <section class="photos-pane photos-pane--flat" aria-label="照片网格">
            <div class="photos-toolbar">
              <div class="photos-toolbar__grow">
                <DsSearchField :value="query" placeholder="按文件名筛选已载入的照片" label="筛选照片" @update:value="query = $event" />
              </div>
              <span class="photos-count">{{ page.label }}{{ page.truncated ? "（还有更多）" : "" }}</span>
              <DsButton variant="secondary" size="sm" :status="libBusy === 'reload' ? 'loading' : 'idle'" @click="loadPage(0)">
                <RefreshCw :size="14" :stroke-width="1.5" /> 刷新
              </DsButton>
              <DsButton variant="secondary" size="sm" :disabled="!page.hasNext || libBusy !== null" @click="loadPage(page.nextOffset)">加载更多</DsButton>
              <DsButton variant="secondary" size="sm" :disabled="selection.length === 0" @click="openAssign">归入文件夹{{ selection.length ? "（" + selection.length + "）" : "" }}</DsButton>
            </div>

            <p v-if="libNotice" class="photos-hint" :class="{ 'photos-error': libNotice.tone === 'error' }" :role="libNotice.tone === 'error' ? 'alert' : 'status'">{{ libNotice.text }}</p>

            <div v-if="libFailure && items.length > 0" class="photos-banner">
              <p class="photos-error" role="alert" :data-photos-error-code="libFailure.code">刷新目录未完成：{{ photosErrorText(libFailure.code) }}</p>
            </div>

            <ul v-if="libNotices.length" class="photos-list-notices" data-photos-notices>
              <li v-for="notice in libNotices" :key="notice">{{ notice }}</li>
            </ul>

            <p v-if="filterActive && items.length" class="photos-hint" data-photos-filter-note>筛选与搜索只作用于已载入的 {{ items.length }} 张照片；要继续用「加载更多」把后面的页取回来。</p>

            <DsPageState v-if="libraryListState === 'loading'" kind="loading" title="正在读取照片目录…" description="来源、子目录与照片清单都由主进程按当前账号索引，界面不缓存宿主路径。" />
            <DsPageState v-else-if="libraryListState === 'error'" kind="error" title="读取照片目录失败" :description="libFailure ? photosErrorText(libFailure.code) : ''" :on-action="() => loadPage(0)" />
            <DsPageState v-else-if="libraryListState === 'empty'" kind="empty" :title="filterActive ? '当前筛选没有照片' : '还没有照片'" :description="filterActive ? '换一个来源或文件夹筛选，或者清空搜索词。列表里只统计已载入的页。' : '添加一个本机文件夹作为来源后，应用会索引其中的图片与视频（只读，不改动原文件）。'" />
            <DsPageState v-else-if="visibleItems.length === 0" kind="empty" title="当前筛选没有照片" description="换一个来源或文件夹筛选，或者清空搜索词。筛选与搜索只作用于已载入的页。" />
            <div v-else class="ds-scroll photos-scroll" data-ds-comp="scroll-area" tabindex="0" role="region" aria-label="照片网格">
              <ul ref="gridRoot" class="photos-grid" data-photos-grid>
                <li v-for="item in visibleItems" :key="item.id" class="photos-card-host" :data-photo-id="item.id">
                  <button type="button" class="photos-card" :aria-pressed="!!libSelected && libSelected.id === item.id" :aria-label="'查看 ' + item.name" @click="openItem(item)">
                    <span class="photos-card__thumb">
                      <img v-if="thumbUrls[item.id]" :src="thumbUrls[item.id]" alt="" draggable="false" />
                      <ImageIcon v-else-if="thumbFailedIds[item.id]" :size="20" :stroke-width="1.25" />
                      <span v-else class="ds-spinner" aria-hidden="true" />
                      <span v-if="item.kind === 'video'" class="photos-card__kind">
                        <DsBadge tone="neutral" size="sm"><Film :size="11" :stroke-width="1.5" /> 视频</DsBadge>
                      </span>
                    </span>
                    <span class="photos-card__name" :title="item.name">{{ item.name }}</span>
                    <span class="photos-card__meta">{{ formatBytes(item.size) }} · {{ formatTimestamp(item.updated_ts) }}</span>
                  </button>
                  <input type="checkbox" class="photos-card__check" :aria-label="'选择 ' + item.name" :checked="selection.includes(item.id)" @change="toggleSelection(item.id)" />
                </li>
              </ul>
            </div>
          </section>

          <aside class="photos-pane photos-inspector" aria-label="照片详情">
            <div class="photos-pane-head">
              <h3>详情</h3>
              <DsBadge v-if="libSelected" tone="neutral" size="sm">{{ photoKindLabel(libSelected.kind) }}</DsBadge>
            </div>
            <div class="ds-scroll photos-scroll" data-ds-comp="scroll-area" tabindex="0" role="region" aria-label="照片详情">
              <p v-if="detail.status === 'none'" class="photos-hint">在网格里选一张照片，可以看原图、下载、导入到画布或素材库、反推提示词、一键抠图。</p>
              <DsPageState v-else-if="detail.status === 'loading'" kind="loading" title="正在读取照片…" />
              <DsPageState v-else-if="detail.status === 'error'" :kind="photosErrorState(detail.code)" title="读取照片失败" :description="detail.text" :on-action="retryDetail" />
              <div v-else-if="detail.status === 'ready'" class="photos-detail" data-photos-detail="1">
                <div class="photos-detail__preview">
                  <img :src="detail.preview" :alt="detail.item.name" />
                </div>
                <dl class="photos-kv">
                  <dt>文件名</dt>
                  <dd>{{ detail.item.name }}</dd>
                  <dt>类型</dt>
                  <dd>{{ detail.item.mime || photoKindLabel(detail.item.kind) }}</dd>
                  <dt>大小</dt>
                  <dd>{{ formatBytes(detail.size || detail.item.size) }}</dd>
                  <dt>修改时间</dt>
                  <dd>{{ formatTimestamp(detail.item.updated_ts) }}</dd>
                  <dt>相对路径</dt>
                  <dd>{{ detail.item.relativePath }}</dd>
                  <dt>虚拟文件夹</dt>
                  <dd>{{ virtualFolderName }}</dd>
                  <template v-if="detail.note">
                    <dt>提示</dt>
                    <dd>{{ detail.note }}</dd>
                  </template>
                </dl>

                <div class="photos-actions">
                  <DsButton size="sm" :disabled="!detail.hasRaw" @click="downloadDetailRaw">
                    <Download :size="14" :stroke-width="1.5" /> {{ detail.item.kind === "video" ? "原片不可内联" : "下载原图" }}
                  </DsButton>
                  <DsButton size="sm" @click="openImport">
                    <Send :size="14" :stroke-width="1.5" /> 导入到画布 / 素材库
                  </DsButton>
                </div>

                <section class="photos-group" aria-label="反推提示词">
                  <div class="photos-pane-head"><h3>反推提示词</h3></div>
                  <p class="photos-hint">用已配置的视觉模型描述这张图。结果只是一段可编辑的提示词，不会写回任何项目；模型调用会外发这张图。</p>
                  <div v-if="vision && !vision.available" class="photos-hint-box" data-photos-vision-unavailable>
                    <span>{{ photosErrorText("PHOTOS_PROVIDER_UNAVAILABLE") }}</span>
                    <span>{{ vision.hint }}</span>
                    <div class="photos-actions">
                      <DsButton size="sm" variant="secondary" @click="vision = null">重新检查供应商</DsButton>
                    </div>
                  </div>
                  <template v-else>
                    <div v-if="vision && vision.available" class="photos-form__row">
                      <label for="photos-vision-model">视觉模型</label>
                      <select id="photos-vision-model" class="photos-select" v-model="visionPick">
                        <option v-for="model in vision.models" :key="modelKey(model)" :value="modelKey(model)">
                          {{ model.providerName }} · {{ model.model }}
                        </option>
                      </select>
                    </div>
                    <div class="photos-actions">
                      <DsButton size="sm" :status="promptState.status === 'loading' ? 'loading' : 'idle'" :disabled="!detail.item.mime.startsWith('image/')" @click="runReversePrompt">
                        <Sparkles :size="14" :stroke-width="1.5" /> {{ vision ? "反推提示词" : "检查视觉模型并反推" }}
                      </DsButton>
                      <DsButton v-if="promptState.status === 'ready'" size="sm" variant="secondary" @click="copyPrompt">复制</DsButton>
                    </div>
                  </template>
                  <p v-if="promptState.status === 'error'" class="photos-error" role="alert" :data-photos-prompt-error="promptState.code">{{ promptState.text }}</p>
                  <p v-if="promptState.status === 'ready'" class="photos-prompt" data-photos-prompt>{{ promptState.text }}</p>
                </section>

                <section class="photos-group" aria-label="一键抠图">
                  <div class="photos-pane-head"><h3>一键抠图</h3></div>
                  <p class="photos-hint">在本地抠掉背景并输出 PNG。图片不会离开这台机器；依赖缺失时不会返回假图。</p>
                  <div class="photos-actions">
                    <DsButton size="sm" :status="removal.status === 'loading' ? 'loading' : 'idle'" :disabled="!detail.hasRaw || !detail.item.mime.startsWith('image/')" @click="runRemoval">
                      <Scissors :size="14" :stroke-width="1.5" /> 抠图
                    </DsButton>
                    <DsButton v-if="removal.status === 'ready'" size="sm" variant="secondary" @click="downloadRemovalRaw">
                      <Download :size="14" :stroke-width="1.5" /> 下载 PNG
                    </DsButton>
                  </div>
                  <div v-if="removal.status === 'error'" class="photos-hint-box" role="alert" :data-photos-removal-error="removal.code">
                    <span>{{ removal.text }}</span>
                  </div>
                  <div v-if="removal.status === 'ready'" class="photos-detail__preview">
                    <img :src="removal.dataUrl" alt="抠图结果" />
                  </div>
                </section>
              </div>

              <section v-if="dependencyRows.length" class="photos-group" aria-label="能力与依赖">
                <div class="photos-pane-head"><h3>能力与依赖</h3></div>
                <ul class="photos-list">
                  <li v-for="row in dependencyRows" :key="row.key" class="photos-row">
                    <span class="photos-row__main">
                      <span class="photos-row__name" :title="row.hint">{{ row.label }}</span>
                      <span class="photos-row__facts">
                        <DsBadge :tone="row.available ? 'success' : 'warning'" size="sm">{{ row.available ? "已装配" : "未装配" }}</DsBadge>
                      </span>
                    </span>
                  </li>
                </ul>
              </section>
            </div>
          </aside>
        </div>

        <!-- ═══════════════════ 图像工坊 ═══════════════════ -->
        <div v-else class="photos-studio" data-photos-studio="1" :data-photos-state="studioListState">
          <aside class="photos-pane photos-studio-side" aria-label="图像工坊视图">
            <div class="photos-pane-head"><h3>图像工坊</h3></div>
            <ul class="photos-list">
              <li class="photos-row">
                <button type="button" class="photos-row__main" :aria-pressed="studioView === 'projects'" @click="selectStudioView('projects')">
                  <span class="photos-row__name">项目</span>
                  <span class="photos-row__facts">{{ projects.length }}</span>
                </button>
              </li>
              <li class="photos-row">
                <button type="button" class="photos-row__main" :aria-pressed="studioView === 'trash'" @click="selectStudioView('trash')">
                  <span class="photos-row__name">回收站</span>
                  <span class="photos-row__facts">{{ trashed.length }}</span>
                </button>
              </li>
            </ul>

            <div class="photos-sub-head">
              <span>分组</span>
              <button type="button" class="ds-iconbtn ds-iconbtn--ghost ds-iconbtn--sm" data-ds-comp="icon-button" data-ds-variant="ghost" data-ds-status="idle" aria-label="新建分组" @click="openNewGroup">
                <FolderPlus :size="14" :stroke-width="1.5" />
              </button>
            </div>
            <ul class="photos-list">
              <li v-for="group in studioGroupOptions" :key="group.id" class="photos-row">
                <span class="photos-row__main">
                  <span class="photos-row__name" :title="group.label">{{ group.label }}{{ group.isDefault ? "（默认）" : "" }}</span>
                  <span class="photos-row__facts">{{ projects.filter((project) => project.groupId === group.id).length }}</span>
                </span>
                <button v-if="!group.isDefault && group.mine" type="button" class="ds-iconbtn ds-iconbtn--ghost ds-iconbtn--sm" data-ds-comp="icon-button" data-ds-variant="ghost" data-ds-status="idle" :aria-label="'删除分组 ' + group.label" @click="openRemoveGroup({ id: group.id, name: group.label, mine: group.mine, isDefault: group.isDefault })">
                  <Trash2 :size="13" :stroke-width="1.5" />
                </button>
              </li>
            </ul>
            <p class="photos-hint">可见性是三态：私有 / 公开 / 指定成员。后端按 owner 与成员表过滤列表；共享项目对你是只读的。</p>
          </aside>

          <section class="photos-pane photos-pane--flat" aria-label="项目列表">
            <div class="photos-toolbar">
              <DsButton size="sm" @click="openCreateDialog"><Plus :size="14" :stroke-width="1.5" /> 新建项目</DsButton>
              <DsButton size="sm" variant="secondary" :status="studioLoading ? 'loading' : 'idle'" @click="studioReload">
                <RefreshCw :size="14" :stroke-width="1.5" /> 刷新
              </DsButton>
              <span class="photos-count">{{ studioView === "trash" ? "回收站 " + trashed.length + " 个项目" : "共 " + projects.length + " 个项目 / " + groups.length + " 个分组" }}</span>
            </div>

            <p v-if="studioNotice" class="photos-hint" :class="{ 'photos-error': studioNotice.tone === 'error' }" :role="studioNotice.tone === 'error' ? 'alert' : 'status'">{{ studioNotice.text }}</p>

            <p v-if="studioFailure && studioPool.length" class="photos-error" role="alert" :data-photos-error-code="studioFailure.code">刷新项目未完成：{{ photocraftErrorText(studioFailure.code) }}</p>

            <DsPageState v-if="studioListState === 'loading'" kind="loading" title="正在读取项目…" />
            <DsPageState v-else-if="studioListState === 'error' || studioListState === 'unavailable' || studioListState === 'unauthorized'" :kind="studioErrorKind" title="读取项目失败" :description="studioFailure ? photocraftErrorText(studioFailure.code) : ''" :on-action="studioReload" />
            <DsPageState v-else-if="studioListState === 'empty'" kind="empty" :title="studioView === 'trash' ? '回收站是空的' : '还没有项目'" :description="studioView === 'trash' ? '移入回收站的项目会出现在这里，可以恢复或彻底删除。' : '新建一个项目开始：可以只建空项目，也可以带上一个本地文件作为源文件。'" />
            <div v-else-if="studioView === 'trash'" class="ds-scroll photos-scroll" data-ds-comp="scroll-area" tabindex="0" role="region" aria-label="回收站项目">
              <ul class="photos-list">
                <li v-for="project in trashed" :key="project.id" class="photos-trash-row">
                  <span class="photos-trash-row__name" :title="project.title">{{ project.title }}</span>
                  <span class="photos-trash-row__facts">{{ formatBytes(project.sourceSize) }} · 删除于 {{ formatTimestamp(Number(project.deletedAt || 0) / 1000) }}</span>
                  <div class="photos-actions">
                    <DsButton size="sm" variant="secondary" :status="studioBusy === 'restore:' + project.id ? 'loading' : 'idle'" @click="runRestore(project)">
                      <RotateCcw :size="14" :stroke-width="1.5" /> 恢复
                    </DsButton>
                    <DsButton size="sm" variant="danger" :disabled="!canPurge(project)" @click="openPurgeDialog(project)">彻底删除</DsButton>
                  </div>
                </li>
              </ul>
            </div>
            <div v-else class="ds-scroll photos-scroll" data-ds-comp="scroll-area" tabindex="0" role="region" aria-label="项目列表">
              <div class="photos-groups">
                <section v-for="bucket in buckets" :key="bucket.group.id" class="photos-group" :aria-label="'分组 ' + bucket.group.name">
                  <div class="photos-group__head">
                    <strong>{{ bucket.group.name }}</strong>
                    <DsBadge v-if="bucket.isDefault" tone="neutral" size="sm">默认</DsBadge>
                    <DsBadge v-if="!bucket.mine" tone="neutral" size="sm">共享</DsBadge>
                    <span>{{ bucket.projects.length }} 个项目</span>
                  </div>
                  <ul v-if="bucket.projects.length" class="photos-list">
                    <li v-for="project in bucket.projects" :key="project.id">
                      <button type="button" class="photos-project" :class="{ 'is-active': studioSelectedId === project.id }" :aria-pressed="studioSelectedId === project.id" @click="studioSelectedId = project.id">
                        <span class="photos-project__title" :title="project.title">{{ project.title }}</span>
                        <span class="photos-project__facts">
                          <DsBadge :tone="project.visibility === 'public' ? 'success' : project.visibility === 'restricted' ? 'warning' : 'neutral'" size="sm">{{ visibilityLabel(project.visibility) }}</DsBadge>
                          <span>{{ project.mine ? "我的" : "共享" }}</span>
                          <span>{{ formatBytes(project.sourceSize) }}</span>
                          <span>{{ formatTimestamp(Number(project.updatedAt || 0) / 1000) }}</span>
                        </span>
                      </button>
                    </li>
                  </ul>
                  <p v-else class="photos-hint">这个分组还没有项目。</p>
                </section>
              </div>
            </div>
          </section>

          <aside class="photos-pane photos-studio-detail" aria-label="项目详情">
            <div class="photos-pane-head">
              <h3>项目详情</h3>
              <DsBadge v-if="studioSelected" :tone="studioSelected.access === 'owner' ? 'neutral' : 'warning'" size="sm">{{ studioSelected.access === "owner" ? "所有者" : "只读共享" }}</DsBadge>
            </div>
            <div class="ds-scroll photos-scroll" data-ds-comp="scroll-area" tabindex="0" role="region" aria-label="项目详情">
              <p v-if="!studioSelected" class="photos-hint">从中间选择一个项目，可以改信息、下载源文件、写入导出目录、发送到画布，或移入回收站。</p>
              <div v-else class="photos-detail" :data-photos-project-detail="studioSelected.id">
                <dl class="photos-kv">
                  <dt>所有者</dt>
                  <dd>{{ studioSelected.ownerName || "—" }}</dd>
                  <dt>分组</dt>
                  <dd>{{ studioGroupName }}</dd>
                  <dt>可见性</dt>
                  <dd>{{ visibilityLabel(studioSelected.visibility) }}（{{ studioSelected.visibility }}）</dd>
                  <dt>成员</dt>
                  <dd>{{ studioSelected.members.length ? studioSelected.members.join("、") : "—" }}</dd>
                  <dt>源文件</dt>
                  <dd>{{ studioSelected.sourceName || "（无源文件）" }}</dd>
                  <dt>大小</dt>
                  <dd>{{ formatBytes(studioSelected.sourceSize) }}</dd>
                  <dt>SHA-256</dt>
                  <dd class="is-mono" :title="studioSelected.sourceSha256">{{ studioSelected.sourceSha256 || "—" }}</dd>
                  <dt>更新时间</dt>
                  <dd>{{ formatTimestamp(Number(studioSelected.updatedAt || 0) / 1000) }}</dd>
                </dl>

                <p v-if="!studioOwners" class="photos-hint-box" data-photos-readonly>你不是这个项目的所有者，只能查看与下载；改名、可见性、成员、导出与移入回收站都不可用。</p>

                <section class="photos-group" aria-label="项目设置">
                  <div class="photos-pane-head"><h3>设置</h3></div>
                  <DsTextField label="项目名称" :model-value="projectTitle" :disabled="!studioOwners" hint="最多 120 个字；后端会清掉文件名里的非法字符。" @update:model-value="projectTitle = $event" />
                  <div class="photos-form__row">
                    <label for="photos-project-group">分组</label>
                    <select id="photos-project-group" class="photos-select" v-model="projectGroupDraft" :disabled="!studioOwners">
                      <option v-for="group in studioGroupOptions" :key="group.id" :value="group.id">{{ group.label }}{{ group.isDefault ? "（默认）" : "" }}</option>
                    </select>
                  </div>
                  <div class="photos-form__row">
                    <span>可见性</span>
                    <div class="segmented text" role="group" aria-label="可见性">
                      <button v-for="option in studioControl.options" :key="option.id" type="button" :aria-pressed="option.selected" :disabled="option.disabled" :title="option.hint" @click="projectVisibility = option.id">{{ option.label }}</button>
                    </div>
                    <p class="photos-hint" data-photos-visibility-note>{{ studioControl.note }}</p>
                  </div>
                  <div v-if="studioControl.requiresMembers" class="photos-form__row">
                    <label for="photos-members">成员账号 ID（一行一个，也接受空格或逗号分隔）</label>
                    <textarea id="photos-members" class="photos-textarea" v-model="projectMembersText" :disabled="!studioOwners" placeholder="usr_xxx" />
                  </div>
                  <div class="photos-actions">
                    <DsButton size="sm" :status="studioBusy === 'save' ? 'loading' : 'idle'" :disabled="!studioOwners" @click="saveProject">保存设置</DsButton>
                  </div>
                </section>

                <section class="photos-group" aria-label="文件与发送">
                  <div class="photos-pane-head"><h3>文件与发送</h3></div>
                  <div class="photos-actions">
                    <DsButton size="sm" variant="secondary" :disabled="!studioSelected.sourceNodeId || studioBusy === 'download'" :status="studioBusy === 'download' ? 'loading' : 'idle'" @click="studioDownloadSource">
                      <Download :size="14" :stroke-width="1.5" /> 下载源文件
                    </DsButton>
                    <DsButton size="sm" variant="secondary" :disabled="!studioOwners" :status="studioBusy === 'export' ? 'loading' : 'idle'" @click="exportFileInput?.click()">
                      <Upload :size="14" :stroke-width="1.5" /> 写入导出目录
                    </DsButton>
                    <DsButton size="sm" :disabled="!studioSelected.sourceNodeId" @click="openSend">
                      <Send :size="14" :stroke-width="1.5" /> 发送到画布
                    </DsButton>
                    <DsButton v-if="studioView === 'projects'" size="sm" variant="danger" :disabled="!studioOwners" @click="openTrashDialog(studioSelected)">移入回收站</DsButton>
                  </div>
                  <input ref="exportFileInput" type="file" hidden aria-hidden="true" tabindex="-1" @change="submitExport" />
                  <p class="photos-hint">「写入导出目录」把本机选中的文件写进项目的「导出/」目录并刷新预览（后端 photocraft/projects/export）。</p>
                </section>
              </div>
            </div>
          </aside>
        </div>

        <!-- ═══════════════════ 图库弹窗 ═══════════════════ -->
        <DsDialog :open="libDialog?.kind === 'add-source'" title="添加照片来源" @close="libDialog = null">
          <div class="photos-form">
            <DsTextField label="本机文件夹绝对路径" hint="主进程会做 realpath 与目录校验；同一个真实目录重复添加只保留一条来源。宿主路径不会回渲染层。" placeholder="/Users/你的名字/Pictures" :model-value="addPath" @update:model-value="addPath = $event" />
          </div>
          <template #footer>
            <DsButton variant="ghost" @click="libDialog = null">取消</DsButton>
            <DsButton :status="libBusy === 'add-source' ? 'loading' : 'idle'" @click="submitAddSource">添加</DsButton>
          </template>
        </DsDialog>

        <DsDialog :open="libDialog?.kind === 'new-folder'" title="新建虚拟文件夹" @close="libDialog = null">
          <div class="photos-form">
            <DsTextField label="文件夹名称" required hint="最多 80 个字。" :model-value="folderName" @update:model-value="folderName = $event" />
            <div class="photos-form__row">
              <label for="photos-folder-parent">上级文件夹</label>
              <select id="photos-folder-parent" class="photos-select" v-model="folderParent">
                <option value="">（顶层）</option>
                <option v-for="option in virtualFolderOptions" :key="option.id" :value="option.id">{{ "　".repeat(option.depth) + option.label }}</option>
              </select>
            </div>
          </div>
          <template #footer>
            <DsButton variant="ghost" @click="libDialog = null">取消</DsButton>
            <DsButton :status="libBusy === 'folder' ? 'loading' : 'idle'" @click="submitFolder">新建</DsButton>
          </template>
        </DsDialog>

        <DsDialog :open="libDialog?.kind === 'remove-folder'" title="删除虚拟文件夹" @close="libDialog = null">
          <p class="photos-hint">删除「{{ pendingRemoveFolder ? pendingRemoveFolder.name : "" }}」会级联删除它的全部子文件夹，并清空这些文件夹上的照片归类。照片本身不会被删除（来源里的原文件不动）。</p>
          <template #footer>
            <DsButton variant="ghost" @click="libDialog = null">取消</DsButton>
            <DsButton variant="danger" :status="libBusy === 'remove-folder' ? 'loading' : 'idle'" @click="pendingRemoveFolder && submitRemoveFolder(pendingRemoveFolder)">删除</DsButton>
          </template>
        </DsDialog>

        <DsDialog :open="libDialog?.kind === 'remove-source'" title="移除照片来源" @close="libDialog = null">
          <p class="photos-hint">只从应用的来源清单里移除「{{ pendingRemoveSource ? pendingRemoveSource.name : "" }}」；磁盘上的照片不会被删除，重新添加同一目录即可恢复。</p>
          <template #footer>
            <DsButton variant="ghost" @click="libDialog = null">取消</DsButton>
            <DsButton variant="danger" :status="libBusy === 'remove-source' ? 'loading' : 'idle'" @click="submitRemoveSource">移除</DsButton>
          </template>
        </DsDialog>

        <DsDialog :open="libDialog?.kind === 'assign'" :title="'把 ' + selection.length + ' 张照片归入文件夹'" @close="libDialog = null">
          <div class="photos-form">
            <div class="photos-form__row">
              <label for="photos-assign-target">目标文件夹</label>
              <select id="photos-assign-target" class="photos-select" v-model="assignTarget">
                <option value="">移出文件夹（取消归类）</option>
                <option v-for="option in virtualFolderOptions" :key="option.id" :value="option.id">{{ "　".repeat(option.depth) + option.label }}</option>
              </select>
            </div>
            <p class="photos-hint">单次最多归类 100 张；已经不在来源里的照片会计入「跳过」，不会中断整批操作。</p>
          </div>
          <template #footer>
            <DsButton variant="ghost" @click="libDialog = null">取消</DsButton>
            <DsButton :status="libBusy === 'assign' ? 'loading' : 'idle'" @click="submitAssign">归类</DsButton>
          </template>
        </DsDialog>

        <DsDialog :open="libDialog?.kind === 'import'" title="导入照片" @close="libDialog = null">
          <div class="photos-form">
            <div class="photos-form__row">
              <span>导入目标</span>
              <div class="segmented text" role="group" aria-label="导入目标">
                <button v-for="destination in IMPORT_DESTINATIONS" :key="destination.id" type="button" :aria-pressed="importDestination === destination.id" @click="importDestination = destination.id; importTargetId = ''">{{ destination.label }}</button>
              </div>
            </div>
            <div v-if="importDestination === 'canvas' && canvases.length" class="photos-form__row">
              <label for="photos-import-canvas">目标画布</label>
              <select id="photos-import-canvas" class="photos-select" v-model="importTargetId">
                <option value="">请选择画布</option>
                <option v-for="canvas in canvases" :key="canvas.id" :value="canvas.id">{{ canvas.title }}</option>
              </select>
            </div>
            <DsTextField v-else :label="importDestination === 'canvas' ? '目标画布 ID' : '目标素材库位置 ID'" :hint="IMPORT_DESTINATIONS.find((entry) => entry.id === importDestination)?.hint" :model-value="importTargetId" @update:model-value="importTargetId = $event" />
            <p v-if="exchangeNote" class="photos-hint" data-photos-exchange-note>{{ exchangeNote }}</p>
            <p class="photos-hint">导入由主进程注入的导入器执行；未装配时不会执行，也不会留下半个产物。</p>
          </div>
          <template #footer>
            <DsButton variant="ghost" @click="libDialog = null">取消</DsButton>
            <DsButton :status="libBusy === 'import' ? 'loading' : 'idle'" @click="submitImport">导入</DsButton>
          </template>
        </DsDialog>

        <!-- ═══════════════════ 图像工坊弹窗 ═══════════════════ -->
        <DsDialog :open="studioDialog?.kind === 'create'" title="新建图像工坊项目" @close="studioDialog = null">
          <div class="photos-form">
            <DsTextField label="项目名称" required hint="最多 120 个字；留空时后端会用「未命名项目」。" :model-value="createTitle" @update:model-value="createTitle = $event" />
            <div class="photos-form__row">
              <label for="photos-create-group">分组</label>
              <select id="photos-create-group" class="photos-select" v-model="createGroup">
                <option value="">默认分组</option>
                <option v-for="group in studioGroupOptions" :key="group.id" :value="group.id">{{ group.label }}</option>
              </select>
            </div>
            <div class="photos-form__row">
              <label for="photos-create-file">源文件（可选，最大 24 MB）</label>
              <input id="photos-create-file" ref="createFileInput" type="file" accept="image/*" @change="onCreateFileChange" />
              <p class="photos-hint">{{ createFileName ? "将写入：" + createFileName : "不选文件则创建一个空项目。" }}　文件以 base64 内联过桥（后端上限 24 MB），超过会被拒绝并提示文件过大。</p>
            </div>
          </div>
          <template #footer>
            <DsButton variant="ghost" @click="studioDialog = null">取消</DsButton>
            <DsButton :status="studioBusy === 'create' ? 'loading' : 'idle'" @click="submitCreate">新建</DsButton>
          </template>
        </DsDialog>

        <DsDialog :open="studioDialog?.kind === 'new-group'" title="新建分组" @close="studioDialog = null">
          <div class="photos-form">
            <DsTextField label="分组名称" hint="同名分组会直接复用，不会重复创建。" :model-value="groupName" @update:model-value="groupName = $event" />
          </div>
          <template #footer>
            <DsButton variant="ghost" @click="studioDialog = null">取消</DsButton>
            <DsButton :status="studioBusy === 'group' ? 'loading' : 'idle'" @click="submitCreateGroup">新建</DsButton>
          </template>
        </DsDialog>

        <DsDialog :open="studioDialog?.kind === 'remove-group'" title="删除分组" @close="studioDialog = null">
          <p class="photos-hint">删除「{{ pendingRemoveGroup ? pendingRemoveGroup.name : "" }}」后，里面的项目会被移回默认分组，项目本身不会被删除。</p>
          <template #footer>
            <DsButton variant="ghost" @click="studioDialog = null">取消</DsButton>
            <DsButton variant="danger" :status="studioBusy === 'remove-group' ? 'loading' : 'idle'" @click="pendingRemoveGroup && submitRemoveGroup(pendingRemoveGroup)">删除</DsButton>
          </template>
        </DsDialog>

        <DsDialog :open="studioDialog?.kind === 'trash'" title="移入回收站" @close="studioDialog = null">
          <p class="photos-hint">「{{ pendingTrashProject ? pendingTrashProject.title : "" }}」会连同缓存目录进入回收站，之后可以恢复。</p>
          <template #footer>
            <DsButton variant="ghost" @click="studioDialog = null">取消</DsButton>
            <DsButton variant="danger" :status="studioBusy === 'trash' ? 'loading' : 'idle'" @click="runTrash">移入回收站</DsButton>
          </template>
        </DsDialog>

        <DsDialog :open="studioDialog?.kind === 'purge'" title="彻底删除项目" @close="studioDialog = null">
          <p class="photos-hint">{{ TRASH_PURGE_HINT }}<br />目标：「{{ pendingPurgeProject ? pendingPurgeProject.title : "" }}」</p>
          <template #footer>
            <DsButton variant="ghost" @click="studioDialog = null">取消</DsButton>
            <DsButton variant="danger" :status="studioBusy === 'purge' ? 'loading' : 'idle'" @click="runPurge">彻底删除</DsButton>
          </template>
        </DsDialog>

        <DsDialog :open="studioDialog?.kind === 'send'" title="发送到应用" @close="studioDialog = null">
          <div class="photos-form">
            <p v-if="!studioSelected" class="photos-hint">没有选中的项目。</p>
            <template v-else>
              <p class="photos-hint">发送只传引用（nodeId + 项目 ID + revision），不传图片字节；目标列表由后端按打开权限过滤，界面不硬编码。</p>
              <template v-if="sendPanelState.kind === 'ready'">
                <div class="photos-form__row">
                  <label for="photos-target">目标应用</label>
                  <select id="photos-target" class="photos-select" v-model="sendTargetKey" @change="sendError = ''">
                    <option v-for="item in projectedTargets.targets" :key="item.key" :value="item.key" :disabled="item.disabled">{{ targetOptionLabel(item.target) }}{{ item.disabled ? "（不支持当前格式）" : "" }}</option>
                  </select>
                  <p v-if="pickedTarget && pickedTarget.disabled" class="photos-hint">{{ pickedTarget.disabledReason }}</p>
                  <p v-if="pickedTarget && pickedTarget.note" class="photos-hint">{{ pickedTarget.note }}</p>
                </div>
                <div v-if="pickedTarget && pickedTarget.needsCanvas" class="photos-form__row">
                  <label for="photos-target-canvas">目标画布</label>
                  <select id="photos-target-canvas" class="photos-select" v-model="sendCanvasId">
                    <option value="">请选择画布</option>
                    <option v-for="canvas in sendTargets?.canvases || []" :key="canvas.id" :value="canvas.id">{{ canvas.title }}</option>
                  </select>
                </div>
              </template>
              <div v-else class="photos-hint-box" :data-photos-targets-state="sendPanelState.kind">
                <span>{{ sendPanelState.title }}</span>
                <span>{{ sendPanelState.description }}</span>
                <div class="photos-actions">
                  <DsButton size="sm" variant="secondary" @click="openSend">重新读取目标</DsButton>
                </div>
              </div>
              <p v-if="sendError" class="photos-error" role="alert" data-photos-send-error>{{ sendError }}</p>
              <p v-if="sendResult" class="photos-prompt" data-photos-send-result>{{ exchangeResultText(sendResult) }}</p>
            </template>
          </div>
          <template #footer>
            <DsButton variant="ghost" @click="studioDialog = null">关闭</DsButton>
            <DsButton :status="studioBusy === 'send' ? 'loading' : 'idle'" :disabled="!pickedTarget || pickedTarget.disabled || (pickedTarget.needsCanvas && !sendCanvasId)" @click="submitSend">发送</DsButton>
          </template>
        </DsDialog>
      </div>
    </div>
  </div>
</template>
