/**
 * 照片应用 · 图库视图。
 *
 * 只经 window.openarc.photos.command（photos:command）与 appExchange:command（列表画布）取值：
 * 没有 raw fs、没有宿主绝对路径、字节一律 base64url 回渲染层。
 *
 * 与冻结契约的对应（每条命令在界面里的落点）：
 *   photos/sources/list     来源列表 + 来源子目录 + 虚拟文件夹 + 本地照片分页网格（本页主数据）
 *   photos/sources/add | remove      来源的添加 / 移除
 *   photos/folders/create | remove   虚拟文件夹的新建 / 级联删除
 *   photos/folders/assign            选中照片的批量归入（folderId=null 表示移出）
 *   photos/sourceThumbnail           网格缩略图（懒加载，IntersectionObserver 触发）
 *   photos/sourceFile                详情原图与下载（超 32MB 回 PHOTOS_TOO_LARGE，界面明确说）
 *   photos/visionModels | reversePrompt   反推提示词（无供应商给配置指引）
 *   photos/backgroundRemoval         一键抠图（缺依赖给结构化提示）
 *   photos/health                    依赖事实（右侧详情底部只读展示）
 * appExchange/targets                导入到画布时用它列出的画布（target 表由后端过滤）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Film,
  FolderPlus,
  Image as ImageIcon,
  Plus,
  RefreshCw,
  Scissors,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Badge, Button, IconButton, ScrollArea, SearchField, TextField, useToast } from "../design-system/primitives";
import { PageState } from "../design-system/page-states";
import { Dialog } from "../desktop/Dialog";
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
  flattenFolderTree,
  formatBytes,
  folderOptions,
  formatTimestamp,
  isAllowedPhotosCommand,
  localFailure,
  mergePage,
  pageState,
  photoKindLabel,
  photosErrorState,
  photosErrorText,
  photosFailureLine,
  resultFailure,
  resultValue,
  sourcesTruncationNotices,
  visionModelsView,
} from "./photosLogic";
import type { FailureView, LocalFolderNode } from "./photosLogic";
import type {
  DomainBridge,
  ExchangeCanvas,
  PhotoItem,
  PhotoLocalFolder,
  PhotoSource,
  PhotosBackgroundRemovalValue,
  PhotosHealthValue,
  PhotosReversePromptValue,
  PhotosSourceFileValue,
  PhotosSourceThumbnailValue,
  PhotosSourcesListValue,
  PhotosVisionModelsValue,
  PhotoVirtualFolder,
} from "./types";

/** 缩略图请求的最小间隔；命中缓存后不再发命令。 */
type ThumbRequest = (item: PhotoItem) => Promise<string | null>;

type DetailState =
  | { status: "none" }
  | { status: "loading"; item: PhotoItem }
  | {
      status: "ready";
      item: PhotoItem;
      /** 原图（base64url，可为空 —— 视频没有原图内联出口）。 */
      raw?: string;
      /** 展示用 data URL（原图或缩略图）。 */
      preview: string;
      /** 原图字节是否可用（下载与抠图依赖它）。 */
      hasRaw: boolean;
      size?: number;
      note?: string;
    }
  | { status: "error"; item: PhotoItem; code: string; text: string };

type ImportDialogState = { destination: "canvas" | "library"; targetId: string };

/* ══════════════════════════════════════════════════════════════════════════
   网格卡片：缩略图懒加载（进入视口 120px 才请求）
   ══════════════════════════════════════════════════════════════════════════ */
function PhotoCard({
  item,
  selected,
  checked,
  onOpen,
  onToggle,
  requestThumb,
}: {
  item: PhotoItem;
  selected: boolean;
  checked: boolean;
  onOpen: (item: PhotoItem) => void;
  onToggle: (id: string) => void;
  requestThumb: ThumbRequest;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const hostRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || url || failed) return;
    if (typeof IntersectionObserver !== "function") {
      void requestThumb(item).then((next) => (next ? setUrl(next) : setFailed("缩略图不可用")));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void requestThumb(item).then((next) => (next ? setUrl(next) : setFailed(photosErrorText("PHOTOS_DEPENDENCY_UNAVAILABLE"))));
      },
      { rootMargin: "120px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [item, requestThumb, url, failed]);

  return (
    <li ref={hostRef} className="photos-card-host">
      <button
        type="button"
        className="photos-card"
        aria-pressed={selected}
        aria-label={"查看 " + item.name}
        onClick={() => onOpen(item)}
      >
        <span className="photos-card__thumb">
          {url ? <img src={url} alt="" draggable={false} /> : failed ? <ImageIcon size={20} strokeWidth={1.25} /> : <span className="ds-spinner" aria-hidden="true" />}
          {item.kind === "video" ? (
            <span className="photos-card__kind">
              <Badge tone="neutral" size="sm">
                <Film size={11} strokeWidth={1.5} /> 视频
              </Badge>
            </span>
          ) : null}
        </span>
        <span className="photos-card__name" title={item.name}>
          {item.name}
        </span>
        <span className="photos-card__meta">
          {formatBytes(item.size)} · {formatTimestamp(item.updated_ts)}
        </span>
      </button>
      <input
        type="checkbox"
        className="photos-card__check"
        aria-label={"选择 " + item.name}
        checked={checked}
        onChange={() => onToggle(item.id)}
      />
    </li>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   图库视图主体
   ══════════════════════════════════════════════════════════════════════════ */
type LibraryDialog =
  | { kind: "add-source" }
  | { kind: "new-folder"; parentId: string | null }
  | { kind: "remove-folder"; folder: PhotoVirtualFolder }
  | { kind: "remove-source"; source: PhotoSource }
  | { kind: "assign" }
  | { kind: "import" }
  | null;

export function LibraryView({ photos, exchange }: { photos: DomainBridge | null; exchange: DomainBridge | null }) {
  const { toast } = useToast();
  const call = useCallback(
    async (command: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
      if (!photos) return { ok: false, error: "NO_BRIDGE", message: "桌面桥未接入（当前环境没有照片域）" };
      if (!isAllowedPhotosCommand(command)) return { ok: false, error: "PHOTOS_COMMAND_NOT_ALLOWED", message: "" };
      try {
        return await photos.command({ command, payload });
      } catch (error) {
        return { ok: false, error: "DXOS_ERR_INTERNAL", message: String((error as Error)?.message || error) };
      }
    },
    [photos],
  );

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<FailureView | null>(null);
  const [sources, setSources] = useState<PhotoSource[]>([]);
  const [folders, setFolders] = useState<PhotoLocalFolder[]>([]);
  const [virtualFolders, setVirtualFolders] = useState<PhotoVirtualFolder[]>([]);
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [slice, setSlice] = useState({ offset: 0, limit: PHOTOS_PAGE_LIMIT_DEFAULT, total: 0, truncated: false });
  const [notices, setNotices] = useState<string[]>([]);
  const [health, setHealth] = useState<PhotosHealthValue | null>(null);

  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [localFilter, setLocalFilter] = useState<PhotoLocalFolder | null>(null);
  const [virtualFilter, setVirtualFilter] = useState<PhotoVirtualFolder | null>(null);
  const [expandedLocal, setExpandedLocal] = useState<Set<string>>(new Set());
  const [expandedVirtual, setExpandedVirtual] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string[]>([]);

  const [selected, setSelected] = useState<PhotoItem | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "none" });
  const [dialog, setDialog] = useState<LibraryDialog>(null);
  const [addPath, setAddPath] = useState("");
  const [folderName, setFolderName] = useState("");
  const [folderParent, setFolderParent] = useState<string>("");
  const [assignTarget, setAssignTarget] = useState<string>("");
  const [importState, setImportState] = useState<ImportDialogState>({ destination: "canvas", targetId: "" });
  const [canvases, setCanvases] = useState<ExchangeCanvas[]>([]);
  const [exchangeNote, setExchangeNote] = useState("");

  const [vision, setVision] = useState<PhotosVisionModelsValue | null>(null);
  const [visionPick, setVisionPick] = useState("");
  const [promptState, setPromptState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; text: string; providerId: string; model: string }
    | { status: "error"; code: string; text: string }
  >({ status: "idle" });
  const [removal, setRemoval] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; dataUrl: string; raw: string; bytes: number }
    | { status: "error"; code: string; text: string }
  >({ status: "idle" });

  const thumbCache = useRef(new Map<string, string>());
  const thumbFailed = useRef(new Set<string>());
  /** 详情请求的序号：快速点选时只有最后一次的响应能落地（MOTION_SYSTEM §3 旧回调不覆盖新状态）。 */
  const detailSeq = useRef(0);

  const loadPage = useCallback(
    async (nextOffset: number) => {
      setLoading(true);
      setBusy(nextOffset === 0 ? "reload" : "more");
      const res = await call("photos/sources/list", { offset: nextOffset, limit: PHOTOS_PAGE_LIMIT_DEFAULT });
      const value = resultValue<PhotosSourcesListValue>(res);
      if (value) {
        setSources(Array.isArray(value.sources) ? value.sources : []);
        setFolders(Array.isArray(value.folders) ? value.folders : []);
        setVirtualFolders(Array.isArray(value.virtualFolders) ? value.virtualFolders : []);
        setItems((prev) => (nextOffset === 0 ? (Array.isArray(value.items) ? value.items : []) : mergePage(prev, value.items || [], (item) => item.id)));
        setSlice({
          offset: Number(value.offset) || 0,
          limit: Number(value.limit) || PHOTOS_PAGE_LIMIT_DEFAULT,
          total: Number(value.total) || 0,
          truncated: value.truncated === true,
        });
        setNotices(sourcesTruncationNotices(value));
        setFailure(null);
      } else {
        setFailure(resultFailure(res) || localFailure("RESPONSE_INCOMPLETE", "photos/sources/list 没有返回记录"));
      }
      setLoading(false);
      setBusy(null);
    },
    [call],
  );

  useEffect(() => {
    void loadPage(0);
  }, [loadPage]);

  useEffect(() => {
    const run = async () => {
      const res = await call("photos/health", {});
      const value = resultValue<PhotosHealthValue>(res);
      if (value) setHealth(value);
    };
    void run();
  }, [call]);

  const requestThumb = useCallback<ThumbRequest>(
    async (item) => {
      const key = item.id + ":" + item.updated_ts;
      const cached = thumbCache.current.get(key);
      if (cached) return cached;
      if (thumbFailed.current.has(key)) return null;
      const res = await call("photos/sourceThumbnail", { id: item.id, size: 256 });
      const value = resultValue<PhotosSourceThumbnailValue>(res);
      if (!value || typeof value.data !== "string") {
        thumbFailed.current.add(key);
        return null;
      }
      const dataUrl = base64UrlToDataUrl(value.data, "image/jpeg");
      thumbCache.current.set(key, dataUrl);
      return dataUrl;
    },
    [call],
  );

  const openItem = useCallback(
    async (item: PhotoItem) => {
      const seq = detailSeq.current + 1;
      detailSeq.current = seq;
      setSelected(item);
      setDetail({ status: "loading", item });
      setPromptState({ status: "idle" });
      setRemoval({ status: "idle" });
      const rawRes = item.kind === "image" ? await call("photos/sourceFile", { id: item.id }) : null;
      if (detailSeq.current !== seq) return;
      const rawValue = rawRes ? resultValue<PhotosSourceFileValue>(rawRes) : null;
      if (rawValue && typeof rawValue.data === "string") {
        setDetail({
          status: "ready",
          item,
          raw: rawValue.data,
          preview: base64UrlToDataUrl(rawValue.data, rawValue.mime || item.mime),
          hasRaw: true,
          size: Number(rawValue.size) || item.size,
        });
        return;
      }
      const rawFail = rawRes ? resultFailure(rawRes) : null;
      const thumbRes = await call("photos/sourceThumbnail", { id: item.id, size: 1024 });
      if (detailSeq.current !== seq) return;
      const thumbValue = resultValue<PhotosSourceThumbnailValue>(thumbRes);
      if (thumbValue && typeof thumbValue.data === "string") {
        setDetail({
          status: "ready",
          item,
          preview: base64UrlToDataUrl(thumbValue.data, "image/jpeg"),
          hasRaw: false,
          note: rawFail
            ? photosErrorText(rawFail.code)
            : item.kind === "video"
              ? "视频只提供封面缩略图；原片导出走文件传输域。"
              : "",
        });
        return;
      }
      const finalFail = resultFailure(thumbRes) || rawFail;
      setDetail(
        finalFail
          ? { status: "error", item, code: finalFail.code, text: photosErrorText(finalFail.code) }
          : { status: "error", item, code: "RESPONSE_INCOMPLETE", text: photosErrorText("RESPONSE_INCOMPLETE") },
      );
    },
    [call],
  );

  const failToast = useCallback(
    (title: string, res: unknown) => {
      const fail = resultFailure(res) || localFailure("RESPONSE_INCOMPLETE", "");
      toast({ kind: "error", title, description: photosFailureLine(title.replace(/失败$/, ""), fail.code) });
    },
    [toast],
  );

  const submitAddSource = useCallback(async () => {
    const path = addPath.trim();
    if (!path) return;
    setBusy("add-source");
    const res = await call("photos/sources/add", { path });
    const value = resultValue<{ source: PhotoSource; created: boolean }>(res);
    setBusy(null);
    if (!value) {
      failToast("添加来源失败", res);
      return;
    }
    setDialog(null);
    setAddPath("");
    toast({
      kind: value.created ? "success" : "info",
      title: value.created ? "已添加来源" : "这个文件夹已经是来源",
      description: value.source?.name || path,
    });
    await loadPage(0);
  }, [addPath, call, failToast, loadPage, toast]);

  const submitFolder = useCallback(async () => {
    const name = folderName.trim();
    if (!name) return;
    setBusy("folder");
    const res = await call("photos/folders/create", { name, parentId: folderParent || null });
    const value = resultValue<{ folder: PhotoVirtualFolder }>(res);
    setBusy(null);
    if (!value) {
      failToast("新建文件夹失败", res);
      return;
    }
    setDialog(null);
    setFolderName("");
    setFolderParent("");
    toast({ kind: "success", title: "已新建文件夹", description: value.folder?.name || name });
    await loadPage(0);
  }, [call, failToast, folderName, folderParent, loadPage, toast]);

  const submitRemoveFolder = useCallback(
    async (folder: PhotoVirtualFolder) => {
      setBusy("remove-folder");
      const res = await call("photos/folders/remove", { id: folder.id });
      const value = resultValue<{ id: string; removed: boolean; removedFolderIds: string[] }>(res);
      setBusy(null);
      if (!value) {
        failToast("删除文件夹失败", res);
        return;
      }
      setDialog(null);
      if (virtualFilter && value.removedFolderIds.indexOf(virtualFilter.id) >= 0) setVirtualFilter(null);
      toast({
        kind: "success",
        title: "已删除文件夹",
        description: "同时删除了 " + Math.max(0, (value.removedFolderIds?.length || 1) - 1) + " 个子文件夹，并清空了它们上的归类。",
      });
      await loadPage(0);
    },
    [call, failToast, loadPage, toast, virtualFilter],
  );

  const submitRemoveSource = useCallback(async () => {
    if (dialog?.kind !== "remove-source") return;
    setBusy("remove-source");
    const res = await call("photos/sources/remove", { id: dialog.source.id });
    const value = resultValue<{ id: string; removed: boolean }>(res);
    setBusy(null);
    if (!value) {
      failToast("移除来源失败", res);
      return;
    }
    if (sourceFilter === dialog.source.id) setSourceFilter(null);
    if (localFilter && localFilter.sourceId === dialog.source.id) setLocalFilter(null);
    toast({ kind: "success", title: "已移除来源", description: dialog.source.name });
    thumbCache.current.clear();
    thumbFailed.current.clear();
    setDialog(null);
    await loadPage(0);
  }, [call, dialog, failToast, loadPage, localFilter, sourceFilter, toast]);

  const submitAssign = useCallback(async () => {
    if (!selection.length) return;
    setBusy("assign");
    const res = await call("photos/folders/assign", { ids: selection, folderId: assignTarget || null });
    const value = resultValue<unknown>(res);
    setBusy(null);
    if (!value) {
      failToast("归类失败", res);
      return;
    }
    setDialog(null);
    toast({ kind: "success", title: "归类完成", description: assignSummary(value) });
    setSelection([]);
    await loadPage(0);
  }, [assignTarget, call, failToast, loadPage, selection, toast]);

  const openImport = useCallback(async () => {
    setDialog({ kind: "import" });
    setExchangeNote("");
    setImportState({ destination: "canvas", targetId: "" });
    if (!exchange) {
      setExchangeNote("桌面桥未接入（当前环境没有应用互传域），画布列表无法读取。");
      return;
    }
    try {
      const res = await exchange.command({ command: "appExchange/targets" });
      const value = resultValue<{ canvases?: ExchangeCanvas[] }>(res);
      if (value) setCanvases(Array.isArray(value.canvases) ? value.canvases : []);
      else {
        const fail = resultFailure(res);
        setExchangeNote(fail ? "读取画布列表失败：" + fail.code : "读取画布列表失败：返回记录不完整");
      }
    } catch (error) {
      setExchangeNote("读取画布列表失败：" + String((error as Error)?.message || error));
    }
  }, [exchange]);

  const submitImport = useCallback(async () => {
    const item = detail.status === "ready" ? detail.item : selected;
    if (!item) return;
    const targetId = importState.targetId.trim();
    if (!targetId) {
      toast({ kind: "warning", title: "请先填目标 ID", description: IMPORT_DESTINATIONS.find((d) => d.id === importState.destination)?.hint });
      return;
    }
    setBusy("import");
    const res = await call("photos/importImage", { sourceId: item.id, targetId, destination: importState.destination });
    const value = resultValue<{ destination: string; targetId: string; cardId?: string; itemId?: string; nodeId?: string }>(res);
    setBusy(null);
    if (!value) {
      failToast("导入失败", res);
      return;
    }
    setDialog(null);
    const where = value.cardId ? "画布卡片 " + value.cardId : value.itemId ? "素材库条目 " + value.itemId : value.nodeId ? "节点 " + value.nodeId : value.targetId;
    toast({ kind: "success", title: "已导入", description: where });
  }, [call, detail, failToast, importState, selected, toast]);

  const loadVision = useCallback(async () => {
    if (vision) return vision;
    const res = await call("photos/visionModels", {});
    const value = resultValue<unknown>(res);
    const view = value
      ? visionModelsView(value)
      : { available: false, models: [], hint: photosErrorText(resultFailure(res)?.code || "PHOTOS_DEPENDENCY_UNAVAILABLE") };
    setVision(view);
    if (view.models.length) setVisionPick(view.models[0].providerId + "\u0000" + view.models[0].model);
    return view;
  }, [call, vision]);

  const runReversePrompt = useCallback(async () => {
    const item = detail.status === "ready" ? detail.item : selected;
    if (!item) return;
    const view = await loadVision();
    if (!view.available) {
      setPromptState({ status: "error", code: "PHOTOS_PROVIDER_UNAVAILABLE", text: photosErrorText("PHOTOS_PROVIDER_UNAVAILABLE") + " " + view.hint });
      return;
    }
    const picked = view.models.find((model) => model.providerId + "\u0000" + model.model === visionPick) || view.models[0];
    setPromptState({ status: "loading" });
    const res = await call("photos/reversePrompt", { imageId: item.id, providerId: picked.providerId, model: picked.model });
    const value = resultValue<PhotosReversePromptValue>(res);
    if (!value || typeof value.text !== "string") {
      const fail = resultFailure(res) || localFailure("RESPONSE_INCOMPLETE", "");
      setPromptState({ status: "error", code: fail.code, text: photosErrorText(fail.code) + (fail.code === "PHOTOS_PROVIDER_UNAVAILABLE" ? " " + view.hint : "") });
      return;
    }
    setPromptState({ status: "ready", text: value.text, providerId: value.providerId, model: value.model });
  }, [call, detail, loadVision, selected, visionPick]);

  const runRemoval = useCallback(async () => {
    if (detail.status !== "ready" || !detail.raw) return;
    setRemoval({ status: "loading" });
    const res = await call("photos/backgroundRemoval", { image: detail.raw });
    const value = resultValue<PhotosBackgroundRemovalValue>(res);
    if (value && typeof value.data === "string") {
      setRemoval({
        status: "ready",
        dataUrl: base64UrlToDataUrl(value.data, "image/png"),
        raw: value.data,
        bytes: Number(value.bytes) || decodedByteLength(value.data),
      });
      return;
    }
    const fail = resultFailure(res) || localFailure("DXOS_ERR_INTERNAL", "");
    setRemoval({ status: "error", code: fail.code, text: backgroundRemovalHint(fail.detail, fail.code) });
  }, [call, detail]);

  const downloadRaw = useCallback(
    (item: PhotoItem, raw: string, mime: string, suffix?: string) => {
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
        toast({ kind: "error", title: "下载失败", description: String((error as Error)?.message || error) });
      }
    },
    [toast],
  );

  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast({ kind: "success", title: "已复制提示词" });
      } catch {
        toast({ kind: "warning", title: "复制失败", description: "请手动选中提示词正文复制。" });
      }
    },
    [toast],
  );

  /* ── 派生数据 ─────────────────────────────────────────────────────────── */
  const page = pageState({ offset: slice.offset, limit: slice.limit, total: slice.total, loaded: items.length, truncated: slice.truncated });
  const localTree = useMemo(() => buildLocalFolderTree(folders), [folders]);
  const virtualTree = useMemo(() => buildVirtualFolderTree(virtualFolders), [virtualFolders]);
  const virtualRows = useMemo(() => flattenFolderTree(virtualTree.roots, expandedVirtual), [virtualTree, expandedVirtual]);
  const visibleItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (sourceFilter && item.sourceId !== sourceFilter) return false;
      if (localFilter && item.sourceId !== localFilter.sourceId) return false;
      if (localFilter && item.relativePath !== localFilter.path && !item.relativePath.startsWith(localFilter.path + "/")) return false;
      if (virtualFilter && item.virtualFolderId !== virtualFilter.id) return false;
      if (needle && !item.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [items, query, sourceFilter, localFilter, virtualFilter]);
  const filterActive = Boolean(sourceFilter || localFilter || virtualFilter || query.trim());
  const listState: "loading" | "empty" | "error" | "ready" =
    failure && items.length === 0 && !loading
      ? "error"
      : loading && items.length === 0
        ? "loading"
        : items.length === 0
          ? "empty"
          : "ready";
  const dependencyRows = useMemo(() => dependencyReport(health), [health]);
  const selectionCount = selection.length;

  const localRows = useMemo(() => {
    const out: { node: LocalFolderNode; sourceName: string }[] = [];
    const visit = (nodes: readonly LocalFolderNode[], sourceName: string) => {
      for (const node of nodes) {
        out.push({ node, sourceName });
        visit(node.children, sourceName);
      }
    };
    for (const [sourceId, nodes] of localTree) {
      const name = sources.find((source) => source.id === sourceId)?.name || sourceId;
      visit(nodes, name);
    }
    return out;
  }, [localTree, sources]);

  const resetFilters = useCallback(() => {
    setSourceFilter(null);
    setLocalFilter(null);
    setVirtualFilter(null);
    setQuery("");
  }, []);

  return (
    <div className="photos-lib" data-photos-lib="1" data-photos-state={listState}>
      <aside className="photos-pane photos-lib-side" aria-label="来源与文件夹">
        <div className="photos-pane-head">
          <h3>来源</h3>
          <IconButton
            label="添加照片来源"
            size="sm"
            onClick={() => {
              setAddPath("");
              setDialog({ kind: "add-source" });
            }}
          >
            <Plus size={15} strokeWidth={1.5} />
          </IconButton>
        </div>
        <ScrollArea label="来源与文件夹" className="photos-scroll">
          <ul className="photos-list">
            <li className="photos-row">
              <button
                type="button"
                className="photos-row__main"
                aria-pressed={!sourceFilter && !localFilter && !virtualFilter}
                onClick={resetFilters}
              >
                <ImageIcon size={14} strokeWidth={1.5} />
                <span className="photos-row__name">全部照片</span>
                <span className="photos-row__facts">{page.total}</span>
              </button>
            </li>
            {sources.map((source) => (
              <li key={source.id} className={"photos-row" + (sourceFilter === source.id ? " is-active" : "")}>
                <button
                  type="button"
                  className="photos-row__main"
                  aria-pressed={sourceFilter === source.id}
                  disabled={!source.available}
                  onClick={() => {
                    setLocalFilter(null);
                    setSourceFilter(sourceFilter === source.id ? null : source.id);
                  }}
                >
                  <span className="photos-row__name" title={source.name}>
                    {source.name}
                  </span>
                  <span className="photos-row__facts">
                    {source.available ? null : (
                      <Badge tone="warning" size="sm">
                        不可用
                      </Badge>
                    )}
                  </span>
                </button>
                <IconButton label={"移除来源 " + source.name} size="sm" onClick={() => setDialog({ kind: "remove-source", source })}>
                  <Trash2 size={14} strokeWidth={1.5} />
                </IconButton>
              </li>
            ))}
          </ul>

          <div className="photos-sub-head">
            <span>来源子目录</span>
          </div>
          <ul className="photos-list">
            {localRows.length ? (
              localRows.map((row) => (
                <li key={row.node.id} className={"photos-row" + (localFilter && localFilter.id === row.node.id ? " is-active" : "")}>
                  <button
                    type="button"
                    className={"photos-row__main photos-indent"}
                    style={{ "--photos-depth": row.node.depth } as CSSProperties}
                    aria-pressed={Boolean(localFilter && localFilter.id === row.node.id)}
                    title={row.node.path}
                    onClick={() => {
                      setSourceFilter(row.node.sourceId);
                      setLocalFilter(localFilter && localFilter.id === row.node.id ? null : row.node);
                    }}
                  >
                    <span className="photos-row__name">{row.node.name}</span>
                  </button>
                </li>
              ))
            ) : (
              <li className="photos-hint">还没有可用的子目录（来源未添加或不可访问）。</li>
            )}
          </ul>

          <div className="photos-sub-head">
            <span>虚拟文件夹</span>
            <IconButton label="新建虚拟文件夹" size="sm" onClick={() => setDialog({ kind: "new-folder", parentId: null })}>
              <FolderPlus size={14} strokeWidth={1.5} />
            </IconButton>
          </div>
          <ul className="photos-list">
            {virtualRows.length ? (
              virtualRows.map(({ node, depth }) => (
                <li key={node.id} className={"photos-row" + (virtualFilter && virtualFilter.id === node.id ? " is-active" : "")}>
                  <button
                    type="button"
                    className="photos-folder-toggle"
                    data-empty={node.children.length === 0}
                    aria-label={(expandedVirtual.has(node.id) ? "收起 " : "展开 ") + node.name}
                    onClick={() =>
                      setExpandedVirtual((prev) => {
                        const next = new Set(prev);
                        if (next.has(node.id)) next.delete(node.id);
                        else next.add(node.id);
                        return next;
                      })
                    }
                  >
                    {expandedVirtual.has(node.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  <button
                    type="button"
                    className={"photos-row__main photos-indent"}
                    style={{ "--photos-depth": depth } as CSSProperties}
                    aria-pressed={Boolean(virtualFilter && virtualFilter.id === node.id)}
                    onClick={() => setVirtualFilter(virtualFilter && virtualFilter.id === node.id ? null : node)}
                  >
                    <span className="photos-row__name">{node.name}</span>
                    {node.orphan ? (
                      <Badge tone="warning" size="sm">
                        上级缺失
                      </Badge>
                    ) : null}
                  </button>
                  <IconButton label={"新建子文件夹 " + node.name} size="sm" onClick={() => setDialog({ kind: "new-folder", parentId: node.id })}>
                    <Plus size={13} strokeWidth={1.5} />
                  </IconButton>
                  <IconButton label={"删除文件夹 " + node.name} size="sm" onClick={() => setDialog({ kind: "remove-folder", folder: { id: node.id, name: node.name, parentId: node.parentId } })}>
                    <Trash2 size={13} strokeWidth={1.5} />
                  </IconButton>
                </li>
              ))
            ) : (
              <li className="photos-hint">还没有虚拟文件夹。新建一个后可以把照片批量归入。</li>
            )}
          </ul>
        </ScrollArea>
      </aside>

      <section className="photos-pane photos-pane--flat" aria-label="照片网格">
        <div className="photos-toolbar">
          <div className="photos-toolbar__grow">
            <SearchField value={query} onValueChange={setQuery} placeholder="按文件名筛选已载入的照片" label="筛选照片" />
          </div>
          <span className="photos-count">
            {page.label}
            {page.truncated ? "（还有更多）" : ""}
          </span>
          <Button
            variant="secondary"
            size="sm"
            status={busy === "reload" ? "loading" : "idle"}
            iconStart={<RefreshCw size={14} strokeWidth={1.5} />}
            onClick={() => void loadPage(0)}
          >
            刷新
          </Button>
          <Button variant="secondary" size="sm" disabled={!page.hasNext || busy !== null} onClick={() => void loadPage(page.nextOffset)}>
            加载更多
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={selectionCount === 0}
            onClick={() => {
              setAssignTarget("");
              setDialog({ kind: "assign" });
            }}
          >
            归入文件夹{selectionCount ? "（" + selectionCount + "）" : ""}
          </Button>
        </div>

        {failure && items.length > 0 ? (
          <div className="photos-banner">
            <p className="photos-error" role="alert" data-photos-error-code={failure.code}>
              {photosFailureLine("刷新目录", failure.code)}
            </p>
          </div>
        ) : null}

        {notices.length ? (
          <ul className="photos-list-notices" data-photos-notices>
            {notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        ) : null}

        {filterActive && items.length ? (
          <p className="photos-hint" data-photos-filter-note>
            筛选与搜索只作用于已载入的 {items.length} 张照片；要继续用「加载更多」把后面的页取回来。
          </p>
        ) : null}

        {listState === "loading" ? (
          <PageState kind="loading" title="正在读取照片目录…" description="来源、子目录与照片清单都由主进程按当前账号索引，界面不缓存宿主路径。" />
        ) : listState === "error" ? (
          <PageState
            kind="error"
            title="读取照片目录失败"
            description={failure ? photosErrorText(failure.code) + "（" + failure.code + "）" : ""}
            onAction={() => void loadPage(0)}
          />
        ) : listState === "empty" ? (
          <PageState
            kind="empty"
            title={filterActive ? "当前筛选没有照片" : "还没有照片"}
            description={
              filterActive
                ? "换一个来源或文件夹筛选，或者清空搜索词。列表里只统计已载入的页。"
                : "添加一个本机文件夹作为来源后，应用会索引其中的图片与视频（只读，不改动原文件）。"
            }
          />
        ) : visibleItems.length === 0 ? (
          <PageState
            kind="empty"
            title="当前筛选没有照片"
            description="换一个来源或文件夹筛选，或者清空搜索词。筛选与搜索只作用于已载入的页。"
          />
        ) : (
          <ScrollArea label="照片网格" className="photos-scroll">
            <ul className="photos-grid" data-photos-grid>
              {visibleItems.map((item) => (
                <PhotoCard
                  key={item.id}
                  item={item}
                  selected={Boolean(selected && selected.id === item.id)}
                  checked={selection.indexOf(item.id) >= 0}
                  onOpen={(next) => void openItem(next)}
                  onToggle={(id) =>
                    setSelection((prev) => (prev.indexOf(id) >= 0 ? prev.filter((value) => value !== id) : [...prev, id]))
                  }
                  requestThumb={requestThumb}
                />
              ))}
            </ul>
          </ScrollArea>
        )}
      </section>

      <aside className="photos-pane photos-inspector" aria-label="照片详情">
        <div className="photos-pane-head">
          <h3>详情</h3>
          {selected ? (
            <Badge tone="neutral" size="sm">
              {photoKindLabel(selected.kind)}
            </Badge>
          ) : null}
        </div>
        <ScrollArea label="照片详情" className="photos-scroll">
          {detail.status === "none" ? (
            <p className="photos-hint">在网格里选一张照片，可以看原图、下载、导入到画布或素材库、反推提示词、一键抠图。</p>
          ) : detail.status === "loading" ? (
            <PageState kind="loading" title="正在读取照片…" />
          ) : detail.status === "error" ? (
            <PageState
              kind={photosErrorState(detail.code)}
              title="读取照片失败"
              description={detail.text + "（" + detail.code + "）"}
              onAction={() => void openItem(detail.item)}
            />
          ) : (
            <div className="photos-detail" data-photos-detail="1">
              <div className="photos-detail__preview">
                <img src={detail.preview} alt={detail.item.name} />
              </div>
              <dl className="photos-kv">
                <dt>文件名</dt>
                <dd>{detail.item.name}</dd>
                <dt>类型</dt>
                <dd>{detail.item.mime || photoKindLabel(detail.item.kind)}</dd>
                <dt>大小</dt>
                <dd>{formatBytes(detail.size || detail.item.size)}</dd>
                <dt>修改时间</dt>
                <dd>{formatTimestamp(detail.item.updated_ts)}</dd>
                <dt>相对路径</dt>
                <dd>{detail.item.relativePath}</dd>
                <dt>虚拟文件夹</dt>
                <dd>
                  {detail.item.virtualFolderId
                    ? virtualTree.byId.get(detail.item.virtualFolderId)?.name || "已删除的文件夹"
                    : "未归类"}
                </dd>
                {detail.note ? (
                  <>
                    <dt>提示</dt>
                    <dd>{detail.note}</dd>
                  </>
                ) : null}
              </dl>

              <div className="photos-actions">
                <Button
                  size="sm"
                  iconStart={<Download size={14} strokeWidth={1.5} />}
                  disabled={!detail.hasRaw}
                  onClick={() => detail.raw && downloadRaw(detail.item, detail.raw, detail.item.mime)}
                >
                  {detail.item.kind === "video" ? "原片不可内联" : "下载原图"}
                </Button>
                <Button size="sm" iconStart={<Send size={14} strokeWidth={1.5} />} onClick={() => void openImport()}>
                  导入到画布 / 素材库
                </Button>
              </div>

              <section className="photos-group" aria-label="反推提示词">
                <div className="photos-pane-head">
                  <h3>反推提示词</h3>
                </div>
                <p className="photos-hint">
                  用已配置的视觉模型描述这张图。结果只是一段可编辑的提示词，不会写回任何项目；模型调用会外发这张图。
                </p>
                {vision && !vision.available ? (
                  <div className="photos-hint-box" data-photos-vision-unavailable>
                    <span>{photosErrorText("PHOTOS_PROVIDER_UNAVAILABLE")}</span>
                    <span>{vision.hint}</span>
                    <div className="photos-actions">
                      <Button size="sm" variant="secondary" onClick={() => setVision(null)}>
                        重新检查供应商
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    {vision && vision.available ? (
                      <div className="photos-form__row">
                        <label htmlFor="photos-vision-model">视觉模型</label>
                        <select
                          id="photos-vision-model"
                          className="photos-select"
                          value={visionPick}
                          onChange={(event) => setVisionPick(event.target.value)}
                        >
                          {vision.models.map((model) => (
                            <option key={model.providerId + "\u0000" + model.model} value={model.providerId + "\u0000" + model.model}>
                              {model.providerName} · {model.model}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                    <div className="photos-actions">
                      <Button
                        size="sm"
                        status={promptState.status === "loading" ? "loading" : "idle"}
                        iconStart={<Sparkles size={14} strokeWidth={1.5} />}
                        disabled={!detail.item.mime.startsWith("image/")}
                        onClick={() => void runReversePrompt()}
                      >
                        {vision ? "反推提示词" : "检查视觉模型并反推"}
                      </Button>
                      {promptState.status === "ready" ? (
                        <Button size="sm" variant="secondary" onClick={() => void copyText(promptState.text)}>
                          复制
                        </Button>
                      ) : null}
                    </div>
                  </>
                )}
                {promptState.status === "error" ? (
                  <p className="photos-error" role="alert" data-photos-prompt-error={promptState.code}>
                    {promptState.text}（{promptState.code}）
                  </p>
                ) : null}
                {promptState.status === "ready" ? (
                  <p className="photos-prompt" data-photos-prompt>
                    {promptState.text}
                  </p>
                ) : null}
              </section>

              <section className="photos-group" aria-label="一键抠图">
                <div className="photos-pane-head">
                  <h3>一键抠图</h3>
                </div>
                <p className="photos-hint">在本地抠掉背景并输出 PNG。图片不会离开这台机器；依赖缺失时不会返回假图。</p>
                <div className="photos-actions">
                  <Button
                    size="sm"
                    status={removal.status === "loading" ? "loading" : "idle"}
                    iconStart={<Scissors size={14} strokeWidth={1.5} />}
                    disabled={!detail.hasRaw || !detail.item.mime.startsWith("image/")}
                    onClick={() => void runRemoval()}
                  >
                    抠图
                  </Button>
                  {removal.status === "ready" ? (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        iconStart={<Download size={14} strokeWidth={1.5} />}
                        onClick={() => downloadRaw(detail.item, removal.raw, "image/png", "-抠图.png")}
                      >
                        下载 PNG
                      </Button>
                    </>
                  ) : null}
                </div>
                {removal.status === "error" ? (
                  <div className="photos-hint-box" role="alert" data-photos-removal-error={removal.code}>
                    <span>{removal.text}</span>
                    <span>错误码：{removal.code}</span>
                  </div>
                ) : null}
                {removal.status === "ready" ? (
                  <div className="photos-detail__preview">
                    <img src={removal.dataUrl} alt="抠图结果" />
                  </div>
                ) : null}
              </section>
            </div>
          )}

          {dependencyRows.length ? (
            <section className="photos-group" aria-label="能力与依赖">
              <div className="photos-pane-head">
                <h3>能力与依赖</h3>
              </div>
              <ul className="photos-list">
                {dependencyRows.map((row) => (
                  <li key={row.key} className="photos-row">
                    <span className="photos-row__main">
                      <span className="photos-row__name" title={row.hint}>
                        {row.label}
                      </span>
                      <span className="photos-row__facts">
                        <Badge tone={row.available ? "success" : "warning"} size="sm">
                          {row.available ? "已装配" : "未装配"}
                        </Badge>
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </ScrollArea>
      </aside>

      <Dialog
        open={dialog?.kind === "add-source"}
        title="添加照片来源"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button status={busy === "add-source" ? "loading" : "idle"} onClick={() => void submitAddSource()}>
              添加
            </Button>
          </>
        }
      >
        <div className="photos-form">
          <TextField
            label="本机文件夹绝对路径"
            hint="主进程会做 realpath 与目录校验；同一个真实目录重复添加只保留一条来源。宿主路径不会回渲染层。"
            value={addPath}
            placeholder="/Users/你的名字/Pictures"
            onChange={(event) => setAddPath(event.target.value)}
          />
        </div>
      </Dialog>

      <Dialog
        open={dialog?.kind === "new-folder"}
        title="新建虚拟文件夹"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button status={busy === "folder" ? "loading" : "idle"} onClick={() => void submitFolder()}>
              新建
            </Button>
          </>
        }
      >
        <div className="photos-form">
          <TextField label="文件夹名称" required value={folderName} onChange={(event) => setFolderName(event.target.value)} hint="最多 80 个字。" />
          <div className="photos-form__row">
            <label htmlFor="photos-folder-parent">上级文件夹</label>
            <select
              id="photos-folder-parent"
              className="photos-select"
              value={folderParent}
              onChange={(event) => setFolderParent(event.target.value)}
            >
              <option value="">（顶层）</option>
              {folderOptions(virtualFolders).map((option) => (
                <option key={option.id} value={option.id}>
                  {"　".repeat(option.depth) + option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={dialog?.kind === "remove-folder"}
        title="删除虚拟文件夹"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              status={busy === "remove-folder" ? "loading" : "idle"}
              onClick={() => dialog?.kind === "remove-folder" && void submitRemoveFolder(dialog.folder)}
            >
              删除
            </Button>
          </>
        }
      >
        <p className="photos-hint">
          删除「{dialog?.kind === "remove-folder" ? dialog.folder.name : ""}」会级联删除它的全部子文件夹，并清空这些文件夹上的照片归类。
          照片本身不会被删除（来源里的原文件不动）。
        </p>
      </Dialog>

      <Dialog
        open={dialog?.kind === "remove-source"}
        title="移除照片来源"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              status={busy === "remove-source" ? "loading" : "idle"}
              onClick={() => void submitRemoveSource()}
            >
              移除
            </Button>
          </>
        }
      >
        <p className="photos-hint">
          只从应用的来源清单里移除「{dialog?.kind === "remove-source" ? dialog.source.name : ""}」；磁盘上的照片不会被删除，重新添加同一目录即可恢复。
        </p>
      </Dialog>

      <Dialog
        open={dialog?.kind === "assign"}
        title={"把 " + selectionCount + " 张照片归入文件夹"}
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button status={busy === "assign" ? "loading" : "idle"} onClick={() => void submitAssign()}>
              归类
            </Button>
          </>
        }
      >
        <div className="photos-form">
          <div className="photos-form__row">
            <label htmlFor="photos-assign-target">目标文件夹</label>
            <select
              id="photos-assign-target"
              className="photos-select"
              value={assignTarget}
              onChange={(event) => setAssignTarget(event.target.value)}
            >
              <option value="">移出文件夹（取消归类）</option>
              {folderOptions(virtualFolders).map((option) => (
                <option key={option.id} value={option.id}>
                  {"　".repeat(option.depth) + option.label}
                </option>
              ))}
            </select>
          </div>
          <p className="photos-hint">单次最多归类 100 张；已经不在来源里的照片会计入「跳过」，不会中断整批操作。</p>
        </div>
      </Dialog>

      <Dialog
        open={dialog?.kind === "import"}
        title="导入照片"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button status={busy === "import" ? "loading" : "idle"} onClick={() => void submitImport()}>
              导入
            </Button>
          </>
        }
      >
        <div className="photos-form">
          <div className="photos-form__row">
            <span>导入目标</span>
            <div className="segmented text" role="group" aria-label="导入目标">
              {IMPORT_DESTINATIONS.map((destination) => (
                <button
                  key={destination.id}
                  type="button"
                  aria-pressed={importState.destination === destination.id}
                  onClick={() => setImportState((prev) => ({ ...prev, destination: destination.id, targetId: "" }))}
                >
                  {destination.label}
                </button>
              ))}
            </div>
          </div>
          {importState.destination === "canvas" && canvases.length ? (
            <div className="photos-form__row">
              <label htmlFor="photos-import-canvas">目标画布</label>
              <select
                id="photos-import-canvas"
                className="photos-select"
                value={importState.targetId}
                onChange={(event) => setImportState((prev) => ({ ...prev, targetId: event.target.value }))}
              >
                <option value="">请选择画布</option>
                {canvases.map((canvas) => (
                  <option key={canvas.id} value={canvas.id}>
                    {canvas.title}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <TextField
              label={importState.destination === "canvas" ? "目标画布 ID" : "目标素材库位置 ID"}
              hint={IMPORT_DESTINATIONS.find((destination) => destination.id === importState.destination)?.hint}
              value={importState.targetId}
              onChange={(event) => setImportState((prev) => ({ ...prev, targetId: event.target.value }))}
            />
          )}
          {exchangeNote ? <p className="photos-hint" data-photos-exchange-note>{exchangeNote}</p> : null}
          <p className="photos-hint">导入由主进程注入的导入器执行；未装配时回 PHOTOS_DEPENDENCY_UNAVAILABLE，不会留下半个产物。</p>
        </div>
      </Dialog>
    </div>
  );
}
