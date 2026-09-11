import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Bot,
  Clock,
  File as FileIcon,
  FileText,
  Film,
  Folder,
  Image as ImageIcon,
  Music,
  LayoutGrid,
  List,
  Lock,
  LogOut,
  Monitor,
  Package,
  Search,
  Share,
  Sliders,
  Store,
  Tag,
  User,
  Wand2,
} from "lucide-react";
// Token 层必须先于组件层导入：tokens.css 只声明自定义属性与 base reset，
// styles.css 全部是消费方。顺序颠倒会让组件拿到未定义的 var()。
import "./design-system/tokens.css";
import "./styles.css";
import domain from "../electron/window-domain.cjs";
import type { WindowCommand } from "../electron/window-domain.cjs";
import { useDesktop } from "./desktop/useDesktop";
// 别名导入：本模块里有 `declare global { interface Window }`，
// 直接叫 Window 会在类型位置与全局 Window 撞名。
import {
  AIPanel,
  AddressBar,
  AssistantPill,
  ContextMenu,
  Dock,
  TopBar,
  WebViewport,
  Window as DesktopWindow,
  startDrag,
  startResize,
} from "./desktop/components";
import type { MenuItem } from "./desktop/components";
import { Dialog } from "./desktop/Dialog";
import { useIdentity } from "./identity/useIdentity";
import { BootRetry, BootSurface, LockScreen, LoginScreen, SetupScreen } from "./identity/AuthScreens";

type DisplayInfo = {
  id: number;
  scaleFactor: number;
  workArea: { x: number; y: number; width: number; height: number };
  internal: boolean;
  primary: boolean;
};
declare global {
  interface Window {
    openarc?: {
      sync: (p: unknown) => Promise<{ ok?: boolean; error?: string; results?: unknown[] }>;
      navigate: (windowId: string, url: string) => Promise<{ error?: string; ok?: boolean }>;
      action: (windowId: string, action: string) => Promise<{ error?: string; ok?: boolean }>;
      onNativeState: (cb: (e: Record<string, string>) => void) => () => void;
      onDisplay: (cb: (d: DisplayInfo[]) => void) => () => void;
      identity?: {
        command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
        onEvent: (cb: (e: { event: string; snapshot?: unknown }) => void) => () => void;
      };
      files?: {
        pathFor: (file: File) => string;
        import: (
          folderId: string,
          paths: string[],
        ) => Promise<{ ok?: boolean; entries?: FileEntry[]; added?: FileEntry[]; error?: string }>;
        list: (folderId: string) => Promise<{ ok?: boolean; entries?: FileEntry[]; error?: string }>;
        rename: (folderId: string, id: string, name: string) => Promise<{ ok?: boolean; entries?: FileEntry[]; error?: string }>;
        remove: (folderId: string, id: string) => Promise<{ ok?: boolean; entries?: FileEntry[]; error?: string }>;
        read: (folderId: string, id: string) => Promise<{
          ok?: boolean;
          entry?: FileEntry;
          mime?: string;
          kind?: string;
          dataUrl?: string;
          text?: string;
          error?: string;
        }>;
        thumb: (
          folderId: string,
          id: string,
          size?: number,
        ) => Promise<{ ok?: boolean; dataUrl?: string; error?: string }>;
        info: (
          folderId: string,
          id: string,
        ) => Promise<{ ok?: boolean; width?: number; height?: number; error?: string }>;
        startDrag: (folderId: string, id: string) => void;
        copy: (
          folderId: string,
          ids: string[],
          toFolderId: string,
        ) => Promise<{ ok?: boolean; entries?: FileEntry[]; error?: string }>;
        move: (folderId: string, ids: string[], toFolderId: string) => Promise<{ ok?: boolean; error?: string }>;
        exportTo: (
          folderId: string,
          ids: string[],
        ) => Promise<{ ok?: boolean; count?: number; dest?: string; error?: string }>;
      };
    };
  }
}

/** 文件服务返回的条目（不含磁盘路径 —— 路径永不过桥）。 */
type FileEntry = { id: string; name: string; ext: string; size: number; mtime: number };

/** 文件夹里的一行：子文件夹或文件服务里的文件，统一结构后再排序 / 分组。 */
type Row = { id: string; name: string; kind: "folder" | "file"; ext?: string; size?: number; mtime?: number };

/** 按扩展名给线性图标：App 里的图标统一线性，文件类型也一致。 */
const FILE_KINDS: Record<string, string[]> = {
  // ai / psd / eps 归到 image：macOS 对它们是能出真实内容缩略图的（.ai 实测通过）
  image: ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "svg", "tif", "tiff", "avif", "ai", "psd", "eps"],
  video: ["mp4", "mov", "m4v", "avi", "mkv", "webm"],
  audio: ["mp3", "wav", "aac", "flac", "m4a", "ogg"],
  doc: ["pdf", "doc", "docx", "pages", "rtf", "pad", "txt", "md"],
  text: ["txt", "md", "json", "csv", "log", "ts", "tsx", "js", "jsx", "css", "html", "yml", "yaml", "xml"],
  archive: ["zip", "tar", "gz", "rar", "7z"],
};
/** 会去文件服务取缩略图的后缀（图片 / 视频 / 文档 —— 其余用线性图标，不浪费一次 IPC）。 */
const THUMB_EXTS = [...FILE_KINDS.image, ...FILE_KINDS.video, ...FILE_KINDS.doc];

/** 后缀 → 类别（渲染层用，和 FileGlyph 同一份表）。 */
const kindOfExt = (ext: string) => Object.keys(FILE_KINDS).find((k) => FILE_KINDS[k].includes(ext)) ?? "other";

/** 浏览器**自己**能渲染的图片格式；其余的（psd/ai/eps/tiff…）请主进程出一张位图。 */
const WEB_IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

/** 桌面本身也是一个真实的存储文件夹：拖到桌面的文件就存在这里。 */
const DESKTOP_ID = "desktop";
/** 桌面图标栅格：整理与"网格吸附"共用同一套数。 */
// 初始落位放在右侧空白区：左侧/中部会被默认窗口与品牌区压住
const DESK_GRID = { x0: 1150, y0: 88, dx: 108, dy: 118, cols: 2 };
/** 内置壁纸只保留两种：浅色 / 深色主题色（其余预设与动态 Aurora 已按用户口径删除）。 */
const WALLPAPERS = [
  { id: "theme-light", name: "浅色主题色" },
  { id: "theme-dark", name: "深色主题色" },
];

/** 上传的自定义壁纸存在这个真实存储文件夹里（静态图片 / 动图 / 视频都走它）。 */
const WALLPAPER_ID = "wallpapers";
/** 只读文件协议的媒体地址：openarc-file://media/<folderId>/<id>。 */
const fileUrl = (folderId: string, id: string) =>
  "openarc-file://media/" + encodeURIComponent(folderId) + "/" + encodeURIComponent(id);

function FileGlyph({ ext, size }: { ext: string; size: number }) {
  const kind = Object.keys(FILE_KINDS).find((k) => FILE_KINDS[k].includes(ext));
  if (kind === "image") return <ImageIcon size={size} strokeWidth={1.25} />;
  if (kind === "video") return <Film size={size} strokeWidth={1.25} />;
  if (kind === "audio") return <Music size={size} strokeWidth={1.25} />;
  if (kind === "doc" || kind === "text") return <FileText size={size} strokeWidth={1.25} />;
  if (kind === "archive") return <Archive size={size} strokeWidth={1.25} />;
  return <FileIcon size={size} strokeWidth={1.25} />;
}

// D1-04B 玻璃材质档位：单值三态。full = 完整玻璃，reduced = 降合成成本，
// solid = 关闭 backdrop-filter 走实色（原"减少透明度"）。
// 与 reduce motion 完全解耦：减少动效不改变材质，降低材质不关动画。
type GlassMode = "full" | "reduced" | "solid";
type Folder = { id: string; name: string; x: number; y: number; parentId?: string };

const FOLDER_PREFIX = domain.FOLDER_PREFIX;
const icon = (name: string) => "./icons/" + name + ".png";
const apps = [
  { id: "home", name: "应用中心", icon: "apps" },
  { id: "browser", name: "浏览器", icon: "safari" },
  { id: "files", name: "文件", icon: "finder" },
  { id: "canvas", name: "无限画布", icon: "freeform" },
  { id: "skills", name: "Skill 中心", icon: "shortcuts" },
  { id: "settings", name: "系统设置", icon: "settings" },
] as const;

/** 胶囊开关（role=switch）：设置页与控制中心共用，受控、无内部状态。 */
function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="switch"
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

/** 文件夹窗口的浏览状态（按 windowId 存）：当前文件夹 / 查看方式 / 搜索 / 排序 / 前进后退历史。
 *  这些是**窗口内的浏览状态**，不进窗口域 —— 窗口域只管窗口本身。 */
type FolderUI = {
  folderId: string;
  view: "grid" | "list";
  query: string;
  sort: "name" | "date" | "size";
  group: boolean;
  history: string[];
  at: number;
};

function App() {
  const identity = useIdentity();
  /**
   * 锁定时整块原生视图必须让位（§15 / §40）—— 这是唯一能盖住 WebContentsView 的机制，
   * DOM z-index 对它无效，因此 lock 必须一路传到主进程的 overlayOpen。
   */
  const locked = identity.phase === "locked";
  const { state, dispatch, overlays, setOverlays, snapshotLayers, nativeVisibleOf, browserEvents, clearBrowserEvent } =
    useDesktop({ locked });

  // ---------------------------------------------------------------------------
  // 桌面对象（文件夹）仍是独立的一类状态：它们不是窗口，不进 Window Manager。
  // ---------------------------------------------------------------------------
  const [folders, setFolders] = useState<Folder[]>(() => {
    try {
      const raw = localStorage.getItem("oa-folders");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [bouncing, setBouncing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; folder?: string; file?: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const dockRef = useRef<HTMLElement>(null);
  const searchPanel = useRef<HTMLDivElement>(null);
  const searchTrigger = useRef<HTMLElement | null>(null);
  /** 右键菜单的来源元素。对话框关闭后焦点要回到它 —— 菜单本身届时已卸载。 */
  const menuTrigger = useRef<HTMLElement | null>(null);

  const [reduced, setReduced] = useState(() => localStorage.getItem("oa-motion") === "true");
  const [glass, setGlass] = useState<GlassMode>(() => {
    const v = localStorage.getItem("oa-glass");
    if (v === "full" || v === "reduced" || v === "solid") return v;
    return localStorage.getItem("oa-opaque") === "true" ? "solid" : "full";
  });
  /**
   * 外观：跟随系统 / 浅色 / 深色（默认跟随系统）。
   * 旧键 oa-dark（布尔）保留写入以兼容既有数据；读取优先 oa-theme。
   */
  const [theme, setTheme] = useState<"system" | "light" | "dark">(() => {
    const saved = localStorage.getItem("oa-theme");
    if (saved === "system" || saved === "light" || saved === "dark") return saved;
    const legacy = localStorage.getItem("oa-dark");
    return legacy === null ? "system" : legacy === "true" ? "dark" : "light";
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const dark = theme === "system" ? systemDark : theme === "dark";
  useEffect(() => {
    localStorage.setItem("oa-theme", theme);
    localStorage.setItem("oa-dark", String(dark));
  }, [theme, dark]);
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  /** 左右分栏的当前页（设置 / 应用中心 / Skill 中心各一份，互不影响）。 */
  const [settingsTab, setSettingsTab] = useState<"appearance" | "model">("appearance");
  const [appTab, setAppTab] = useState<"all" | "pro" | "recent">("all");
  const [skillTab, setSkillTab] = useState<"market" | "mine" | "installed">("market");
  const [folderUI, setFolderUI] = useState<Record<string, FolderUI>>({});
  /** 文件服务里的条目（按 folderId）。渲染层只拿索引，拿不到磁盘路径。 */
  const [filesByFolder, setFilesByFolder] = useState<Record<string, FileEntry[]>>({});
  const refreshFiles = useCallback(async (folderId: string) => {
    const bridge = window.openarc?.files;
    if (!bridge) return;
    try {
      const res = await bridge.list(folderId);
      if (res && Array.isArray(res.entries)) setFilesByFolder((m) => ({ ...m, [folderId]: res.entries as FileEntry[] }));
    } catch {
      /* 主进程不可用时保持原样 */
    }
  }, []);
  /** 当前选中的条目（按 windowId），Quick Look 的目标。 */
  /** 当前选中的条目（按 windowId 存 **一组 id**，支持多选）。 */
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  /** 框选矩形（windowId + 相对 folder-body 的矩形）与「显示简介」浮层。 */
  const [marquee, setMarquee] = useState<{ winId: string; x: number; y: number; w: number; h: number } | null>(null);
  const [info, setInfo] = useState<{ title: string; subtitle?: string; rows: { k: string; v: string }[] } | null>(null);
  /** 应用内剪贴板（复制 / 剪切），粘贴进当前文件夹。 */
  const [clip, setClip] = useState<{ mode: "copy" | "cut"; folderId: string; ids: string[] } | null>(null);
  /** 键盘快捷键要读"当前文件夹窗口"的最新状态，用 ref 传（避免把整套 state 塞进 effect 依赖）。 */
  const fileOpsRef = useRef<{ copy: () => void; cut: () => void; paste: () => void } | null>(null);
  const [preview, setPreview] = useState<{
    entry: FileEntry;
    mime: string;
    kind: string;
    /** 流式媒体源（图片/视频/音频走 openarc-file 协议）。 */
    src?: string;
    dataUrl?: string;
    text?: string;
  } | null>(null);
  /** 打开 Quick Look：只认 id，主进程回 data URL / 文本（**不暴露磁盘路径**）。 */
  const openPreview = useCallback(
    async (folderId: string, entryId: string) => {
      const bridge = window.openarc?.files;
      if (!bridge) return;
      const known = (filesByFolder[folderId] ?? []).find((e) => e.id === entryId);
      if (!known) return;
      const kind = kindOfExt(known.ext);
      // 图片 / 视频 / 音频走**流式协议**：大视频也能播、能拖进度条；不再塞 data URL。
      // 文本 / 其它才需要主进程把内容读回来。
      if (kind === "image" || kind === "video" || kind === "audio") {
        // psd / ai / eps / tiff 这类浏览器渲染不了的图片：向主进程要一张 1024 位图
        if (kind === "image" && !WEB_IMAGE_EXTS.includes((known.ext ?? "").toLowerCase())) {
          const big = await bridge.thumb(folderId, entryId, 1024);
          if (big?.ok && big.dataUrl) {
            setPreview({ entry: known, mime: "", kind: "image", src: big.dataUrl });
            return;
          }
          setPreview({ entry: known, mime: "application/octet-stream", kind: "other" });
          return;
        }
        setPreview({ entry: known, mime: "", kind, src: fileUrl(folderId, entryId) });
        return;
      }
      const res = await bridge.read(folderId, entryId);
      if (!res || !res.ok || !res.entry) return;
      setPreview({
        entry: res.entry ?? known,
        mime: String(res.mime ?? ""),
        kind: String(res.kind ?? "other"),
        dataUrl: res.dataUrl,
        text: res.text,
      });
    },
    [filesByFolder],
  );
  /** 键盘回调里读最新状态用（避免把整套 state 塞进 effect 依赖）。 */
  const quickLookRef = useRef<() => void>(() => {});
  quickLookRef.current = () => {
    const fid = state.focused;
    if (!fid) return;
    const folderId =
      folderUI[fid]?.folderId ?? (fid.startsWith(FOLDER_PREFIX) ? fid.slice(FOLDER_PREFIX.length) : null);
    const entryId = (selected[fid] ?? [])[0];
    if (!folderId || !entryId) return;
    void openPreview(folderId, entryId);
  };
  /** 缩略图缓存（key = folderId/entryId；空串表示"确认没有缩略图"，避免反复请求）。 */
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    const bridge = window.openarc?.files;
    if (!bridge?.thumb) return;
    const folderIds = new Set<string>();
    for (const win of state.windows) {
      if (!win.appId.startsWith(FOLDER_PREFIX)) continue;
      const fid = folderUI[win.id]?.folderId ?? win.appId.slice(FOLDER_PREFIX.length);
      if (fid) folderIds.add(fid);
    }
    // 桌面上的文件也要缩略图
    folderIds.add(DESKTOP_ID);
    for (const fid of folderIds) {
      for (const e of filesByFolder[fid] ?? []) {
        if (!THUMB_EXTS.includes(e.ext)) continue;
        const key = fid + "/" + e.id;
        if (thumbs[key] !== undefined) continue;
        void bridge
          .thumb(fid, e.id)
          .then((res) => setThumbs((m) => ({ ...m, [key]: res && res.ok && res.dataUrl ? res.dataUrl : "" })))
          .catch(() => setThumbs((m) => ({ ...m, [key]: "" })));
      }
    }
  }, [state.windows, folderUI, filesByFolder, thumbs]);
  // ---------------------------------------------------------------------------
  // 桌面：图标位置 / 网格吸附 / 壁纸 / 排列方式（都持久化）
  // ---------------------------------------------------------------------------
  const [desktopIcons, setDesktopIcons] = useState<Record<string, { x: number; y: number }>>(() => {
    try {
      return JSON.parse(localStorage.getItem("oa-desktop-icons") || "{}");
    } catch {
      return {};
    }
  });
  const [snap, setSnap] = useState(() => localStorage.getItem("oa-snap") !== "0");
  const [wallpaper, setWallpaper] = useState(() => localStorage.getItem("oa-wallpaper") || "theme-dark");
  /** 正在"落格"的图标 id：只有松手后的这一段才用过渡，拖动过程严格 1:1。 */
  const [settling, setSettling] = useState<string | null>(null);
  const [deskSort, setDeskSort] = useState<"name" | "date" | "size">("name");
  useEffect(() => {
    localStorage.setItem("oa-desktop-icons", JSON.stringify(desktopIcons));
  }, [desktopIcons]);
  useEffect(() => {
    localStorage.setItem("oa-snap", snap ? "1" : "0");
  }, [snap]);
  useEffect(() => {
    localStorage.setItem("oa-wallpaper", wallpaper);
  }, [wallpaper]);
  /** 桌面上的文件来自真实存储（folderId = desktop），缩略图与文件夹里同一套。 */
  useEffect(() => {
    void refreshFiles(DESKTOP_ID);
  }, [refreshFiles]);
  /** 自定义壁纸来自真实存储（folderId = wallpapers）。 */
  useEffect(() => {
    void refreshFiles(WALLPAPER_ID);
  }, [refreshFiles]);
  const customWallpapers = filesByFolder[WALLPAPER_ID] ?? [];
  const customEntry = wallpaper.startsWith("custom:")
    ? (customWallpapers.find((e) => e.id === wallpaper.slice(7)) ?? null)
    : null;
  /** 上传壁纸：拷进 wallpapers 存储文件夹，然后把它设为当前壁纸。 */
  /** 删除自定义壁纸（真实删存储条目）；删掉的正好是当前壁纸就退回内置极光。 */
  const deleteWallpaper = async (entryId: string) => {
    if (!window.openarc?.files) return;
    await window.openarc.files.remove(WALLPAPER_ID, entryId);
    await refreshFiles(WALLPAPER_ID);
    if (wallpaper === "custom:" + entryId) setWallpaper("theme-dark");
  };
  const uploadWallpaper = async (file: File | undefined) => {
    if (!file || !window.openarc?.files) return;
    const p = window.openarc.files.pathFor(file);
    if (!p) return;
    const res = await window.openarc.files.import(WALLPAPER_ID, [p]);
    await refreshFiles(WALLPAPER_ID);
    const added = res?.added?.[res.added.length - 1];
    if (added) setWallpaper("custom:" + added.id);
  };
  const desktopFiles = useMemo(() => {
    const list = [...(filesByFolder[DESKTOP_ID] ?? [])];
    if (deskSort === "date") list.sort((a, b) => b.mtime - a.mtime);
    else if (deskSort === "size") list.sort((a, b) => b.size - a.size);
    else list.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    return list;
  }, [filesByFolder, deskSort]);
  const gridPos = (index: number) => ({
    x: DESK_GRID.x0 + (index % DESK_GRID.cols) * DESK_GRID.dx,
    y: DESK_GRID.y0 + Math.floor(index / DESK_GRID.cols) * DESK_GRID.dy,
  });
  const snapPos = (x: number, y: number) => ({
    x: DESK_GRID.x0 + Math.round((x - DESK_GRID.x0) / DESK_GRID.dx) * DESK_GRID.dx,
    y: DESK_GRID.y0 + Math.round((y - DESK_GRID.y0) / DESK_GRID.dy) * DESK_GRID.dy,
  });
  const deskPos = (id: string, index: number) => desktopIcons[id] ?? gridPos(index);
  /** 落格：把图标动画到栅格（只有这一步用过渡，所以看起来是"轻轻吸过去"而不是跳）。 */
  const settleTo = (id: string, pos: { x: number; y: number }) => {
    setDesktopIcons((m) => ({ ...m, [id]: pos }));
    setSettling(id);
    window.setTimeout(() => setSettling((cur) => (cur === id ? null : cur)), 280);
  };
  /**
   * 拖桌面图标：**拖动过程 1:1 跟手、不吸附**，松手时才用一段过渡落到栅格。
   * （之前边拖边吸附，指针动一像素图标就跳一格，手感很生硬。）
   */
  const dragDesktopIcon = (e: React.PointerEvent, id: string) => {
    // ⌘ + 按下 = 拖到系统（Finder / 桌面）：直接走原生 startDrag。
    // 桌面图标**不能**再挂 HTML5 draggable —— 那样浏览器会把"按下+移动"判成 HTML5 拖拽，
    // 指针事件被吞掉，位置就再也拖不动了（实测如此）。
    if (e.metaKey) {
      window.openarc?.files?.startDrag(DESKTOP_ID, id);
      return;
    }
    const start = deskPos(id, desktopFiles.findIndex((f) => f.id === id));
    const x0 = e.clientX;
    const y0 = e.clientY;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let last = start;
    const move = (ev: Event) => {
      const p = ev as PointerEvent;
      const nx = Math.max(0, Math.min(window.innerWidth - 96, start.x + p.clientX - x0));
      const ny = Math.max(52, Math.min(window.innerHeight - 140, start.y + p.clientY - y0));
      last = { x: nx, y: ny };
      setDesktopIcons((m) => ({ ...m, [id]: last }));
    };
    const end = (ev?: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      // 松手时若落在桌面上的某个文件夹磁贴里 → 搬进那个文件夹
      const dropped = ev ? (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null) : null;
      const into = dropped?.closest("[data-folder-id]") as HTMLElement | null;
      if (into?.dataset.folderId) {
        void moveInto(into.dataset.folderId, DESKTOP_ID, [id]);
        setDesktopIcons((m) => {
          const next = { ...m };
          delete next[id];
          return next;
        });
        return;
      }
      if (snap) settleTo(id, snapPos(last.x, last.y));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };
  /** 整理：按指定（或当前）排列顺序把桌面文件重新落到栅格上。 */
  const arrangeDesktop = (sort?: "name" | "date" | "size") => {
    const key = sort ?? deskSort;
    const list = [...(filesByFolder[DESKTOP_ID] ?? [])];
    if (key === "date") list.sort((a, b) => b.mtime - a.mtime);
    else if (key === "size") list.sort((a, b) => b.size - a.size);
    else list.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    setDesktopIcons((m) => {
      const next = { ...m };
      list.forEach((f, i) => {
        next[f.id] = gridPos(i);
      });
      return next;
    });
  };

  // ---------------------------------------------------------------------------
  // 条目搬运：应用内移动/复制（应用层实现，文件夹窗口、侧栏、桌面磁贴共用同一套）
  // ---------------------------------------------------------------------------
  /** 把一批条目移动进目标文件夹：文件走文件服务，子文件夹改 parentId（带环检测）。 */
  const moveInto = useCallback(
    async (toFolderId: string, srcFolderId: string, ids: string[]) => {
      if (toFolderId === srcFolderId) return;
      const isFolder = (x: string) => folders.some((f) => f.id === x);
      const fileIds = ids.filter((x) => !isFolder(x));
      const folderIds = ids.filter(isFolder);
      if (fileIds.length && window.openarc?.files) {
        await window.openarc.files.move(srcFolderId, fileIds, toFolderId);
        await refreshFiles(srcFolderId);
        await refreshFiles(toFolderId);
      }
      if (folderIds.length) {
        setFolders((list) =>
          list.map((f) => {
            if (!folderIds.includes(f.id)) return f;
            // 不能移进自己或自己的子孙，否则会出现环
            let cur: string | undefined = toFolderId;
            while (cur) {
              if (cur === f.id) return f;
              cur = list.find((x) => x.id === cur)?.parentId;
            }
            // 拖到桌面 = 回到桌面根（桌面文件夹在虚拟树里就是"没有父"的那一层）
            return { ...f, parentId: toFolderId === DESKTOP_ID ? undefined : toFolderId };
          }),
        );
      }
    },
    [folders, refreshFiles],
  );
  /** 深拷贝一个虚拟文件夹（含子文件夹与其中的文件）。 */
  const cloneFolder = async (srcId: string, parentId: string, snapshot: Folder[]): Promise<string> => {
    const src = snapshot.find((f) => f.id === srcId);
    const newId = "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    setFolders((list) => [...list, { id: newId, name: (src?.name ?? "文件夹") + " 副本", x: 0, y: 0, parentId }]);
    if (window.openarc?.files) {
      const res = await window.openarc.files.list(srcId);
      const ids = (res?.entries ?? []).map((x) => x.id);
      if (ids.length) await window.openarc.files.copy(srcId, ids, newId);
    }
    for (const child of snapshot.filter((f) => f.parentId === srcId)) await cloneFolder(child.id, newId, snapshot);
    return newId;
  };
  /** 复制一批条目到目标文件夹：文件走文件服务，子文件夹递归深拷贝。 */
  const copyInto = useCallback(
    async (toFolderId: string, srcFolderId: string, ids: string[]) => {
      const isFolder = (x: string) => folders.some((f) => f.id === x);
      const fileIds = ids.filter((x) => !isFolder(x));
      const folderIds = ids.filter(isFolder);
      if (fileIds.length && window.openarc?.files) {
        await window.openarc.files.copy(srcFolderId, fileIds, toFolderId);
        await refreshFiles(toFolderId);
      }
      for (const x of folderIds) await cloneFolder(x, toFolderId, folders);
    },
    [folders, refreshFiles],
  );
  /** 拖拽载荷（内部搬运专用 MIME，不会和"从电脑拖入文件"混淆）。 */
  const INTERNAL_DND = "application/x-openarc";
  const hasInternalDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(INTERNAL_DND);
  /**
   * 内部拖拽落到某个文件夹上。默认**移动**；按住 Option 是**复制**
   * （与 macOS 一致：同卷拖动=移动，Option=复制）。
   */
  const handleInternalDrop = async (e: React.DragEvent, toFolderId: string) => {
    const raw = e.dataTransfer.getData(INTERNAL_DND);
    if (!raw) return false;
    e.preventDefault();
    e.stopPropagation();
    try {
      const payload = JSON.parse(raw) as { folderId: string; ids: string[] };
      if (!payload?.ids?.length || payload.folderId === toFolderId) return true;
      if (e.altKey) await copyInto(toFolderId, payload.folderId, payload.ids);
      else await moveInto(toFolderId, payload.folderId, payload.ids);
    } catch {
      /* 载荷损坏就当作没有拖拽 */
    }
    return true;
  };
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  /**
   * 唯一的命令入口。**组件与未来的 AI 都只能经由它改窗口状态**（§20 / §21）。
   * 这里只是一层 dispatch 转发，没有任何"顺手也改一下"的旁路。
   */
  const onCommand = (c: WindowCommand) => dispatch(c);

  const folderOf = (id: string) =>
    id.startsWith(FOLDER_PREFIX) ? folders.find((f) => f.id === id.slice(FOLDER_PREFIX.length)) : undefined;
  const titleOf = (id: string) => domain.byId(state, id)?.meta.title || folderOf(id)?.name || id;
  const iconOf = (id: string) => domain.byId(state, id)?.meta.icon || (folderOf(id) ? "folder" : "apps");

  const bounce = (id: string) => {
    if (reduced) return;
    setBouncing(id);
    window.setTimeout(() => setBouncing((cur) => (cur === id ? null : cur)), 760);
  };

  /**
   * 启动 / 唤起到前台一个 App。
   *
   * macOS 习惯：**点 Dock 图标 = 聚焦该 App 最近的窗口**，全部最小化时先恢复它，
   * 只有该 App 一个窗口都没有时才新建。这不是额外功能，而是 §32 的直接后果 ——
   * Dock 消费的是 `appId → windowIds[]`，不是"一个 App 一个窗口"。
   *
   * 早先的实现只派发 `window/open`（按 id 幂等）：当窗口 id ≠ appId 时
   * （例如两个浏览器窗口 browser-a / browser-b），点 Dock 既恢复不了最小化的窗口，
   * 还会因为 id 对不上而多开一个 —— 双浏览器探针抓到的真实缺陷。
   */
  const activateApp = (appId: string) => {
    setOverlays((o) => ({ ...o, search: false }));
    bounce(appId);
    const mine = domain.windowsOfApp(state, appId);
    // order 是自底向上的唯一真值，因此"最近的窗口"就是末尾那个
    const visibleId = [...mine].reverse().find((id) => domain.byId(state, id)?.state !== domain.WSTATE.MINIMIZED);
    const topId = mine[mine.length - 1];
    if (visibleId) {
      onCommand({ type: "window/focus", id: visibleId });
      return;
    }
    if (topId) {
      onCommand({ type: "window/restore", id: topId });
      return;
    }
    const app = apps.find((a) => a.id === appId);
    onCommand({ type: "window/open", appId, meta: { title: app?.name || appId, icon: app?.icon || "apps" } });
  };

  const openFolder = (f: Folder) => {
    setMenu(null);
    const id = FOLDER_PREFIX + f.id;
    onCommand({ type: "window/open", appId: id, meta: { title: f.name, icon: "folder" } });
  };

  // ---------------------------------------------------------------------------
  // 副作用：主题 / 桌面对象持久化
  // ---------------------------------------------------------------------------
  useEffect(() => {
    for (const [k, v] of [
      ["motion", reduced],
      ["glass", glass],
      ["dark", dark],
    ])
      localStorage.setItem("oa-" + k, String(v));
  }, [reduced, glass, dark]);
  useEffect(() => {
    localStorage.setItem("oa-folders", JSON.stringify(folders));
  }, [folders]);

  // Dock 波浪放大（纯视觉，与窗口状态无关）
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const items = Array.from(dock.querySelectorAll<HTMLElement>(".dock-item"));
    const RANGE = 135;
    const reset = () => items.forEach((el) => el.style.setProperty("--s", "1"));
    if (reduced) {
      reset();
      return;
    }
    const apply = (x: number) =>
      items.forEach((el) => {
        const r = el.getBoundingClientRect();
        const distance = Math.abs(r.left + r.width / 2 - x);
        const t = Math.max(0, 1 - distance / RANGE);
        el.style.setProperty("--s", (1 + 0.62 * t * t * (3 - 2 * t)).toFixed(3));
      });
    const move = (e: PointerEvent) => apply(e.clientX);
    dock.addEventListener("pointermove", move);
    dock.addEventListener("pointerleave", reset);
    return () => {
      dock.removeEventListener("pointermove", move);
      dock.removeEventListener("pointerleave", reset);
      reset();
    };
  }, [reduced]);

  // 搜索面板的焦点进出（焦点陷阱由 Dialog 原语承担；这里是搜索自己的开关语义）
  useEffect(() => {
    if (overlays.search) {
      searchTrigger.current = document.activeElement as HTMLElement;
      searchPanel.current?.querySelector("input")?.focus();
    } else {
      searchTrigger.current?.focus?.();
    }
  }, [overlays.search]);

  // 全局快捷键。Esc 只关闭**覆盖层**，不碰窗口 —— 窗口关闭是显式命令。
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOverlays((o) => ({ ...o, search: !o.search }));
      }
      // 空格 = Quick Look（只在有选中条目、且焦点不在输入框里时）
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.code === "Space" && !typing) {
        e.preventDefault();
        quickLookRef.current();
      }
      // 复制 / 剪切 / 粘贴（与右键菜单同一套动作）
      if ((e.metaKey || e.ctrlKey) && !typing) {
        const k = e.key.toLowerCase();
        if (k === "c") {
          e.preventDefault();
          fileOpsRef.current?.copy();
        } else if (k === "x") {
          e.preventDefault();
          fileOpsRef.current?.cut();
        } else if (k === "v") {
          e.preventDefault();
          fileOpsRef.current?.paste();
        }
      }
      if (e.key === "Escape") {
        setOverlays((o) => ({ ...o, search: false, ai: false, control: false }));
        setMenu(null);
        setPreview(null);
        setInfo(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [setOverlays]);

  const runningApps = useMemo(() => new Set(state.windows.map((w) => w.appId)), [state.windows]);
  /** 任一窗口全屏 → Dock 自动隐藏；指针碰到底部才唤回。 */
  const anyMaximized = state.windows.some((w) => w.state === domain.WSTATE.MAXIMIZED);
  const [dockPeek, setDockPeek] = useState(false);

  // 文件夹窗口打开 / 切换目录后，向文件服务取一次条目（每个 folderId 只取一次）
  useEffect(() => {
    if (!window.openarc?.files) return;
    const ids = new Set<string>();
    for (const win of state.windows) {
      if (!win.appId.startsWith(FOLDER_PREFIX)) continue;
      const fid = folderUI[win.id]?.folderId ?? win.appId.slice(FOLDER_PREFIX.length);
      if (fid) ids.add(fid);
    }
    for (const fid of ids) if (!(fid in filesByFolder)) void refreshFiles(fid);
  }, [state.windows, folderUI, filesByFolder, refreshFiles]);

  /**
   * 浏览器原生视图此刻是否真的可见 —— 文案与占位必须与它一致，否则界面在撒谎。
   * 必须按 **windowId** 查（不是写死 "browser"）：同一 App 可以开多个窗口（§12），
   * 写死的话第二个浏览器窗口会显示第一个的可见性。
   */
  const browserVisibleOf = (id: string) => nativeVisibleOf(id);

  // ---------------------------------------------------------------------------
  // 各 App 的内容。浏览器窗口通过 AddressBar / WebViewport 消费原生视图状态。
  // ---------------------------------------------------------------------------
  const content = (id: string) => {
    const w = domain.byId(state, id);
    const folder = folderOf(id);
    if (folder) {
      const ui: FolderUI =
        folderUI[id] ?? {
          folderId: folder.id,
          view: "grid",
          query: "",
          sort: "name",
          group: true,
          history: [folder.id],
          at: 0,
        };
      const patch = (p: Partial<FolderUI>) => setFolderUI((m) => ({ ...m, [id]: { ...ui, ...p } }));
      /** 同一窗口内切换文件夹（不新建窗口）：历史栈支持前进/后退。 */
      const go = (fid: string) => {
        if (fid === ui.folderId) return;
        const history = [...ui.history.slice(0, ui.at + 1), fid];
        patch({ folderId: fid, history, at: history.length - 1, query: "" });
      };
      const shown = folders.find((f) => f.id === ui.folderId) ?? folder;
      /**
       * 文件服务（D3-04）接入前文件夹里没有真实条目，因此条目集恒为空。
       * 搜索 / 排序的**代码路径是真实的**，只是当前没有数据可筛 —— 不放假文件。
       */
      const q = ui.query.trim().toLowerCase();
      /** 子文件夹 + 文件服务条目，统一成 Row 后再排序 / 分组。 */
      const rows: Row[] = [
        ...folders.filter((f) => f.parentId === shown.id).map((f) => ({ id: f.id, name: f.name, kind: "folder" as const })),
        ...(filesByFolder[shown.id] ?? []).map((f) => ({
          id: f.id,
          name: f.name,
          kind: "file" as const,
          ext: f.ext,
          size: f.size,
          mtime: f.mtime,
        })),
      ].filter((r) => !q || r.name.toLowerCase().includes(q));
      const bySort = (a: Row, b: Row) => {
        if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
        if (ui.sort === "date") return (b.mtime ?? 0) - (a.mtime ?? 0);
        if (ui.sort === "size") return (b.size ?? 0) - (a.size ?? 0);
        return a.name.localeCompare(b.name, "zh");
      };
      rows.sort(bySort);
      const GROUP_LABEL: Record<string, string> = {
        folder: "文件夹",
        image: "图片",
        video: "视频",
        audio: "音频",
        doc: "文档",
        archive: "压缩包",
        other: "其它",
      };
      const groupOf = (r: Row) => (r.kind === "folder" ? "folder" : kindOfExt(r.ext ?? ""));
      const groupedRows: { label: string; rows: Row[] }[] = [];
      if (ui.group) {
        for (const key of ["folder", "image", "video", "audio", "doc", "archive", "other"]) {
          const bucket = rows.filter((r) => groupOf(r) === key);
          if (bucket.length) groupedRows.push({ label: GROUP_LABEL[key], rows: bucket });
        }
      } else {
        groupedRows.push({ label: "", rows });
      }
      const selIds = selected[id] ?? [];
      const isSelected = (entryId: string) => selIds.includes(entryId);
      /** 单击：默认单选；Cmd/Ctrl = 加减选；Shift = 按当前顺序扩选。 */
      const pick = (entryId: string, e: React.MouseEvent) => {
        setSelected((m) => {
          const cur = m[id] ?? [];
          if (e.metaKey || e.ctrlKey) {
            return { ...m, [id]: cur.includes(entryId) ? cur.filter((x) => x !== entryId) : [...cur, entryId] };
          }
          if (e.shiftKey && cur.length) {
            const order = rows.map((r) => r.id);
            const a = order.indexOf(cur[cur.length - 1]);
            const b = order.indexOf(entryId);
            if (a >= 0 && b >= 0) return { ...m, [id]: order.slice(Math.min(a, b), Math.max(a, b) + 1) };
          }
          return { ...m, [id]: [entryId] };
        });
      };
      /** 框选：空白处按下拖动，命中的条目整体选中（Finder 的橡皮筋选择）。 */
      const startMarquee = (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        const body = e.currentTarget as HTMLElement;
        if ((e.target as HTMLElement).closest(".file-cell")) return;
        const rect = body.getBoundingClientRect();
        const x0 = e.clientX - rect.left;
        const y0 = e.clientY - rect.top;
        const move = (ev: PointerEvent) => {
          const x1 = ev.clientX - rect.left;
          const y1 = ev.clientY - rect.top;
          const box = {
            left: Math.min(x0, x1),
            top: Math.min(y0, y1),
            right: Math.max(x0, x1),
            bottom: Math.max(y0, y1),
          };
          setMarquee({ winId: id, x: box.left, y: box.top, w: box.right - box.left, h: box.bottom - box.top });
          const hitting: string[] = [];
          body.querySelectorAll<HTMLElement>(".file-cell[data-entry-id]").forEach((cell) => {
            const r = cell.getBoundingClientRect();
            const cx = r.left - rect.left;
            const cy = r.top - rect.top;
            if (cx < box.right && cx + r.width > box.left && cy < box.bottom && cy + r.height > box.top)
              hitting.push(cell.dataset.entryId || "");
          });
          setSelected((m) => ({ ...m, [id]: hitting.filter(Boolean) }));
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          setMarquee(null);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      };
      const fmtSize = (n?: number) =>
        n === undefined
          ? "—"
          : n < 1024
            ? n + " B"
            : n < 1048576
              ? (n / 1024).toFixed(1) + " KB"
              : (n / 1048576).toFixed(1) + " MB";
      /** 显示简介：全部是真实数据（子项数 / 类型 / 大小 / 修改时间）。 */
      const showInfo = async (row: Row) => {
        setPaneMenu(null);
        const rowsOut: { k: string; v: string }[] =
          row.kind === "folder"
            ? [
                { k: "种类", v: "文件夹" },
                { k: "包含", v: String(folders.filter((f) => f.parentId === row.id).length) + " 个子文件夹" },
                { k: "位置", v: shown.name },
              ]
            : [
                { k: "种类", v: row.ext ? row.ext.toUpperCase() + " 文件" : "文件" },
                { k: "大小", v: fmtSize(row.size) },
                { k: "修改时间", v: row.mtime ? new Date(row.mtime).toLocaleString("zh-CN") : "—" },
                { k: "所在", v: shown.name },
              ];
        setInfo({
          title: row.name,
          subtitle: row.kind === "folder" ? "文件夹" : row.ext ? row.ext.toUpperCase() + " 文件" : "文件",
          rows: rowsOut,
        });
        // 图片再补一行真实分辨率（读不出来就不编）
        if (row.kind === "file" && window.openarc?.files && kindOfExt(row.ext ?? "") === "image") {
          const inf = await window.openarc.files.info(shown.id, row.id);
          if (inf?.ok && inf.width) {
            setInfo((cur) =>
              cur && cur.title === row.name
                ? { ...cur, rows: [...cur.rows, { k: "分辨率", v: `${inf.width} × ${inf.height}` }] }
                : cur,
            );
          }
        }
      };
      const copyNames = (ids: string[]) => {
        setPaneMenu(null);
        void navigator.clipboard?.writeText(rows.filter((r) => ids.includes(r.id)).map((r) => r.name).join("\n"));
      };
      /** 改名：子文件夹走窗口内状态，文件走文件服务 —— 同一套按 id 的机制。 */
      const commitRename = (entryId: string, kind: "folder" | "file", name: string) => {
        if (kind === "folder") {
          renameFolder(entryId, name);
          return;
        }
        void window.openarc?.files
          ?.rename(shown.id, entryId, name)
          .then(() => refreshFiles(shown.id))
          .finally(() => setRenaming(null));
      };
      const removeFile = (entryId: string) => {
        void window.openarc?.files?.remove(shown.id, entryId).then(() => refreshFiles(shown.id));
      };
      /** 外部拖入：把 File 换成磁盘路径 → 交给主进程**拷贝进** userData。 */
      const importDropped = async (dropped: FileList) => {
        const bridge = window.openarc?.files;
        if (!bridge) return;
        const paths = Array.from(dropped)
          .map((f) => bridge.pathFor(f))
          .filter((p): p is string => !!p);
        if (!paths.length) return;
        await bridge.import(shown.id, paths);
        await refreshFiles(shown.id);
      };
      /** 复制 / 剪切 / 粘贴（键盘与右键菜单共用同一套动作）。 */
      const doCopy = () => {
        if (selIds.length) setClip({ mode: "copy", folderId: shown.id, ids: selIds });
      };
      const doCut = () => {
        if (selIds.length) setClip({ mode: "cut", folderId: shown.id, ids: selIds });
      };
      const doPaste = async () => {
        if (!clip) return;
        setPaneMenu(null);
        if (clip.mode === "cut") {
          await moveInto(shown.id, clip.folderId, clip.ids);
          setClip(null);
        } else {
          await copyInto(shown.id, clip.folderId, clip.ids);
        }
      };
      /** 导出到电脑：让用户挑一个真实目录，把文件复制出去。 */
      const exportItems = async (ids: string[]) => {
        setPaneMenu(null);
        const fileIds = rows.filter((r) => ids.includes(r.id) && r.kind === "file").map((r) => r.id);
        if (!fileIds.length || !window.openarc?.files) return;
        await window.openarc.files.exportTo(shown.id, fileIds);
      };
      const doExport = () => void exportItems(selIds);
      fileOpsRef.current = { copy: doCopy, cut: doCut, paste: () => void doPaste() };
      /**
       * 条目右键菜单。对齐 Finder 的常用项：
       *   单选文件夹：打开 / 显示简介 / 重命名 / 删除
       *   单选文件：  打开 / 显示简介 / 重命名 / 拷贝名称 / 删除
       *   多选：      拷贝 N 项名称 / 删除 N 项
       */
      const openEntryMenu = (x: number, y: number, ids: string[]) => {
        const picked = rows.filter((r) => ids.includes(r.id));
        const one = picked.length === 1 ? picked[0] : null;
        const renameItem = (row: Row): MenuItem => ({
          id: "rename",
          label: "重命名",
          // 延到菜单卸载之后再进入重命名：菜单卸载时会把焦点还给触发元素，
          // 若同步进入重命名，输入框会立刻被抢焦点而提交并消失。
          onSelect: () => window.setTimeout(() => setRenaming(row.id), 0),
        });
        const hasFiles = picked.some((r) => r.kind === "file");
        const items: MenuItem[] = one
          ? one.kind === "folder"
            ? [
                { id: "open", label: "打开", onSelect: () => go(one.id) },
                { id: "info", label: "显示简介", onSelect: () => void showInfo(one) },
                renameItem(one),
                { separator: true },
                { id: "copy", label: "拷贝", onSelect: doCopy },
                { id: "cut", label: "剪切", onSelect: doCut },
                { separator: true },
                { id: "delete", label: "删除", danger: true, onSelect: () => removeFolder(one.id) },
              ]
            : [
                { id: "open", label: "打开", onSelect: () => void openPreview(shown.id, one.id) },
                { id: "info", label: "显示简介", onSelect: () => void showInfo(one) },
                renameItem(one),
                { id: "copy", label: "拷贝名称", onSelect: () => copyNames([one.id]) },
                { separator: true },
                { id: "copy", label: "拷贝", onSelect: doCopy },
                { id: "cut", label: "剪切", onSelect: doCut },
                { id: "export", label: "导出到电脑…", onSelect: () => void exportItems(ids) },
                { separator: true },
                { id: "delete", label: "删除", danger: true, onSelect: () => removeFile(one.id) },
              ]
          : [
              { id: "open", label: "打开", disabled: true, onSelect: () => {} },
              { id: "copy", label: "拷贝 " + picked.length + " 项名称", onSelect: () => copyNames(ids) },
              { separator: true },
              { id: "copy", label: "拷贝 " + picked.length + " 项", onSelect: doCopy },
              { id: "cut", label: "剪切 " + picked.length + " 项", onSelect: doCut },
              ...(hasFiles
                ? ([{ id: "export", label: "导出到电脑…", onSelect: () => void exportItems(ids) }] as MenuItem[])
                : []),
              { separator: true },
              {
                id: "delete",
                label: "删除 " + picked.length + " 项",
                danger: true,
                onSelect: () => {
                  for (const r of picked) if (r.kind === "folder") removeFolder(r.id);
                  for (const r of picked) if (r.kind === "file") removeFile(r.id);
                },
              },
            ];
        setPaneMenu({ x, y, items });
      };
      const openPaneMenu = (x: number, y: number, which: "sort" | "content") => {
        const sortItems: MenuItem[] = [
          { id: "s-name", label: "名称", onSelect: () => patch({ sort: "name" }) },
          { id: "s-date", label: "日期", onSelect: () => patch({ sort: "date" }) },
          { id: "s-size", label: "大小", onSelect: () => patch({ sort: "size" }) },
        ];
        const contentItems: MenuItem[] = [
          { id: "nf", label: "新建文件夹", onSelect: () => createSubfolder(shown.id) },
          ...(clip
            ? ([
                {
                  id: "paste",
                  label:
                    clip.mode === "cut"
                      ? `粘贴（移动 ${clip.ids.length} 项）`
                      : `粘贴（拷贝 ${clip.ids.length} 项）`,
                  onSelect: () => void doPaste(),
                },
              ] as MenuItem[])
            : []),
          {
            id: "info",
            label: "显示简介",
            onSelect: () => void showInfo({ id: shown.id, name: shown.name, kind: "folder" }),
          },
          { separator: true },
          { id: "group", label: ui.group ? "关闭群组" : "使用群组", onSelect: () => patch({ group: !ui.group }) },
          { id: "s-name", label: "排序方式：名称", onSelect: () => patch({ sort: "name" }) },
          { id: "s-date", label: "排序方式：日期", onSelect: () => patch({ sort: "date" }) },
          { id: "s-size", label: "排序方式：大小", onSelect: () => patch({ sort: "size" }) },
          { separator: true },
          { id: "vo-grid", label: "显示为图标", onSelect: () => patch({ view: "grid" }) },
          { id: "vo-list", label: "显示为列表", onSelect: () => patch({ view: "list" }) },
        ];
        setPaneMenu({ x, y, items: which === "sort" ? sortItems : contentItems });
      };
      return (
        <div className="split">
          <nav className="split-side" aria-label="桌面文件夹">
            <div className="split-section">桌面</div>
            {folders
              .filter((f) => !f.parentId)
              .map((f) => (
                <button
                  key={f.id}
                  className="split-nav"
                  aria-current={f.id === shown.id}
                  onClick={() => go(f.id)}
                  onDragOver={(e) => {
                    if (!hasInternalDrag(e)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
                  }}
                  onDrop={(e) => void handleInternalDrop(e, f.id)}
                >
                  <Folder size={16} /> <span className="split-nav-label">{f.name}</span>
                </button>
              ))}
          </nav>
          <div
            className="split-main"
            onClick={(e) => {
              // 整块内容区（含工具栏下方的空白）点一下 = 取消选择；点条目由条目自己设选择
              if (!(e.target as HTMLElement).closest(".file-cell")) setSelected((m) => ({ ...m, [id]: [] }));
            }}
          >
            <div className="pane-toolbar" onPointerDown={(e) => w && startDrag(e, w, onCommand)}>
              <button
                className="icon-button"
                aria-label="后退"
                disabled={ui.at <= 0}
                onClick={() => patch({ folderId: ui.history[ui.at - 1], at: ui.at - 1, query: "" })}
              >
                <ArrowLeft size={15} />
              </button>
              <button
                className="icon-button"
                aria-label="前进"
                disabled={ui.at >= ui.history.length - 1}
                onClick={() => patch({ folderId: ui.history[ui.at + 1], at: ui.at + 1, query: "" })}
              >
                <ArrowRight size={15} />
              </button>
              <strong className="pane-title">{shown.name}</strong>
              <div className="toolbar-spacer" />
              <label className="search-field">
                <Search size={13} />
                <input
                  aria-label="搜索此文件夹"
                  placeholder="搜索"
                  value={ui.query}
                  onChange={(e) => patch({ query: e.target.value })}
                />
              </label>
              <div className="segmented" role="group" aria-label="查看方式">
                <button aria-pressed={ui.view === "grid"} aria-label="图标" onClick={() => patch({ view: "grid" })}>
                  <LayoutGrid size={15} />
                </button>
                <button aria-pressed={ui.view === "list"} aria-label="列表" onClick={() => patch({ view: "list" })}>
                  <List size={15} />
                </button>
              </div>
              <button
                className="icon-button"
                aria-label="排序方式"
                aria-haspopup="menu"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  openPaneMenu(r.left, r.bottom + 4, "sort");
                }}
              >
                <ArrowUpDown size={15} />
              </button>
              <button className="icon-button" aria-label="共享" disabled title="文件服务接入后可用">
                <Share size={15} />
              </button>
              <button className="icon-button" aria-label="标签" disabled title="文件服务接入后可用">
                <Tag size={15} />
              </button>
            </div>
            <div
              className="folder-body"
              onPointerDown={startMarquee}
              onContextMenu={(e) => {
                e.preventDefault();
                // 不要冒泡到桌面：否则桌面菜单会同时打开、盖在文件夹菜单上
                e.stopPropagation();
                // 空白处右键 = 先清空选择，再弹"文件夹级"菜单
                if (!(e.target as HTMLElement).closest(".file-cell")) setSelected((m) => ({ ...m, [id]: [] }));
                openPaneMenu(e.clientX, e.clientY, "content");
              }}
              onDragOver={(e) => {
                // 内部搬运动作：拖到空白处 = 移进当前文件夹
                if (hasInternalDrag(e)) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
                  return;
                }
                if (!window.openarc?.files) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(e) => {
                if (hasInternalDrag(e)) {
                  void handleInternalDrop(e, shown.id);
                  return;
                }
                if (!window.openarc?.files) return;
                e.preventDefault();
                void importDropped(e.dataTransfer.files);
              }}
            >
              {rows.length === 0 ? (
                <div className="empty-content">
                  <img className="large-icon" src={icon("folder")} alt="" draggable={false} />
                  <span className="badge">{q ? "无匹配项" : "暂无内容"}</span>
                  {q ? (
                    <p>没有匹配「{ui.query}」的项目。</p>
                  ) : (
                    <p>把电脑里的文件、图片、视频、文档拖到这里即可存入；右键可新建子文件夹。</p>
                  )}
                </div>
              ) : (
                <div className="file-groups">
                  {groupedRows.map((g) => (
                    <div className="file-group-block" key={g.label || "all"}>
                      {g.label ? <div className="split-section">{g.label}</div> : null}
                      <div className={ui.view === "grid" ? "file-grid" : "file-list"}>
                        {g.rows.map((r) => (
                          <div
                            className={"file-cell " + (isSelected(r.id) ? "selected" : "")}
                            key={r.kind + r.id}
                            role="button"
                            tabIndex={0}
                            title={r.name}
                            data-entry-id={r.id}
                            draggable
                            onDragStart={(e) => {
                              // 拖已选中的条目 = 拖整个选择；拖未选中的 = 只拖它自己
                              const ids = isSelected(r.id) ? selIds : [r.id];
                              if (!isSelected(r.id)) setSelected((m) => ({ ...m, [id]: [r.id] }));
                              // 按住 ⌘ 拖动 = 走原生拖拽**导出到系统**（Finder/桌面）；
                              // 原生拖拽与页面内 HTML5 拖拽互斥，所以必须把 HTML5 这一路取消。
                              if (e.metaKey && r.kind === "file" && ids.length === 1) {
                                e.preventDefault();
                                window.openarc?.files?.startDrag(shown.id, r.id);
                                return;
                              }
                              e.dataTransfer.setData(INTERNAL_DND, JSON.stringify({ folderId: shown.id, ids }));
                              e.dataTransfer.effectAllowed = "copyMove";
                            }}
                            onDragOver={(e) => {
                              if (r.kind !== "folder" || !hasInternalDrag(e)) return;
                              e.preventDefault();
                              e.stopPropagation();
                              e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
                            }}
                            onDrop={(e) => {
                              if (r.kind === "folder") void handleInternalDrop(e, r.id);
                            }}
                            onClick={(e) => pick(r.id, e)}
                            onDoubleClick={() => (r.kind === "folder" ? go(r.id) : void openPreview(shown.id, r.id))}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") r.kind === "folder" ? go(r.id) : void openPreview(shown.id, r.id);
                              if (e.key === "F2") setRenaming(r.id);
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              // 右键落在未选中的条目上 → 先把它设为唯一选中；落在选中集合内 → 对整个集合操作
                              const ids = selIds.includes(r.id) ? selIds : [r.id];
                              if (!selIds.includes(r.id)) setSelected((m) => ({ ...m, [id]: [r.id] }));
                              openEntryMenu(e.clientX, e.clientY, ids);
                            }}
                          >
                            {r.kind === "folder" ? (
                              <img className="file-icon" src={icon("folder")} alt="" draggable={false} />
                            ) : renaming === r.id ? null : thumbs[shown.id + "/" + r.id] ? (
                              <img
                                className="file-thumb"
                                src={thumbs[shown.id + "/" + r.id]}
                                alt=""
                                draggable={false}
                              />
                            ) : (
                              <span className="file-glyph">
                                <FileGlyph ext={r.ext ?? ""} size={ui.view === "grid" ? 40 : 22} />
                              </span>
                            )}
                            {renaming === r.id ? (
                              <input
                                className="folder-rename"
                                autoFocus
                                aria-label="名称"
                                defaultValue={r.name}
                                onClick={(e) => e.stopPropagation()}
                                onDoubleClick={(e) => e.stopPropagation()}
                                onBlur={(e) => commitRename(r.id, r.kind, e.currentTarget.value)}
                                onKeyDown={(e) => {
                                  // 必须拦住：否则回车会冒泡到磁贴的 onKeyDown，把"提交重命名"变成"进入该文件夹"
                                  e.stopPropagation();
                                  if (e.key === "Enter") commitRename(r.id, r.kind, e.currentTarget.value);
                                  if (e.key === "Escape") setRenaming(null);
                                }}
                              />
                            ) : (
                              <span className="file-name">{r.name}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {marquee?.winId === id ? (
                <div
                  className="marquee"
                  style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          </div>
        </div>
      );
    }
    if (w?.appId === "home")
      return (
        <div className="split">
          <nav className="split-side" aria-label="应用分类">
            <div className="split-section">应用</div>
            <button className="split-nav" aria-current={appTab === "all"} onClick={() => setAppTab("all")}>
              <LayoutGrid size={16} /> 全部应用
            </button>
            <button className="split-nav" aria-current={appTab === "recent"} onClick={() => setAppTab("recent")}>
              <Clock size={16} /> 最近使用
            </button>
            <div className="split-section">专业</div>
            <button className="split-nav" aria-current={appTab === "pro"} onClick={() => setAppTab("pro")}>
              <Wand2 size={16} /> 专业应用
            </button>
          </nav>
          <div className="split-main">
            {appTab === "all" ? (
              <>
                <h1>应用中心</h1>
                <p className="subtitle">一个桌面，连接你的应用、创意与 AI。</p>
                <div className="app-grid">
                  {apps
                    .filter((a) => a.id !== "home")
                    .map((a) => (
                      <button className="app-card" key={a.id} onClick={() => activateApp(a.id)}>
                        <img className="app-icon" src={icon(a.icon)} alt="" draggable={false} />
                        <strong>{a.name}</strong>
                        <small>
                          {a.id === "browser"
                            ? "真实网页 · 隔离运行"
                            : a.id === "settings"
                              ? "外观与全局模型"
                              : "规划中 · 查看说明"}
                        </small>
                      </button>
                    ))}
                </div>
              </>
            ) : appTab === "pro" ? (
              <>
                <h1>专业应用</h1>
                <p className="subtitle">本机已安装的 Adobe 应用；启动与操控尚未接入。</p>
                <div className="adobe-row">
                  <div className="adobe ps">Ps</div>
                  <div>
                    <strong>Adobe Photoshop</strong>
                    <small>已安装 27.1.0 · MCP 未连接</small>
                  </div>
                  <div className="adobe illustrator">Ai</div>
                  <div>
                    <strong>Adobe Illustrator</strong>
                    <small>已安装 30.0.0 · MCP 未连接</small>
                  </div>
                </div>
              </>
            ) : (
              <>
                <h1>最近使用</h1>
                <p className="subtitle">当前打开的窗口。</p>
                {state.windows.length === 0 ? (
                  <p className="muted">还没有打开任何应用窗口。</p>
                ) : (
                  <div className="list">
                    {state.windows.map((win) => (
                      <button
                        className="list-row"
                        key={win.id}
                        onClick={() => onCommand({ type: "window/focus", id: win.id })}
                      >
                        <img className="list-icon" src={icon(win.meta.icon)} alt="" draggable={false} />
                        <span>{win.meta.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      );
    if (w?.appId === "browser" || w?.kind === "browser") {
      const url = w.meta.url || "https://example.com";
      const visible = browserVisibleOf(id);
      return (
        <div className="browser-shell">
          <AddressBar
            url={url}
            onUrlChange={(v) => onCommand({ type: "system/native-state", windowId: id, url: v })}
            onNavigate={() => {
              if (!window.openarc) {
                clearBrowserEvent();
                return;
              }
              void window.openarc.navigate(id, url);
            }}
            onAction={(a) => void window.openarc?.action(id, a)}
          />
          <div className="browser-status" role="status">
            {browserEvents?.windowId === id
              ? browserEvents.message
              : visible
                ? "正在显示网页。桌面窗口可遮挡它，遮挡时由快照补齐。"
                : w.meta.url || "输入地址开始浏览。外部页面与桌面权限隔离。"}
          </div>
          <WebViewport nativeVisible={visible} error={undefined} />
        </div>
      );
    }
    if (w?.appId === "settings")
      return (
        <div className="split">
          <nav className="split-side" aria-label="设置分类">
            <div className="split-section">系统</div>
            <button
              className="split-nav"
              aria-current={settingsTab === "appearance"}
              onClick={() => setSettingsTab("appearance")}
            >
              <Sliders size={16} /> 外观与交互
            </button>
            <button className="split-nav" aria-current={settingsTab === "model"} onClick={() => setSettingsTab("model")}>
              <Bot size={16} /> 全局模型服务
            </button>
          </nav>
          <div className="split-main">
            {settingsTab === "appearance" ? (
              <>
                <h1>外观与交互</h1>
                <p className="subtitle">整个工作空间，遵循你的习惯。</p>
                <div className="setting-row">
                  <span>外观</span>
                  <div className="segmented text" role="group" aria-label="外观">
                    <button aria-pressed={theme === "system"} onClick={() => setTheme("system")}>
                      跟随系统
                    </button>
                    <button aria-pressed={theme === "light"} onClick={() => setTheme("light")}>
                      浅色
                    </button>
                    <button aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
                      深色
                    </button>
                  </div>
                </div>
                <Switch label="减少动态效果" checked={reduced} onChange={setReduced} />
                <div className="setting-row">
                  <span>
                    材质
                  </span>
                  <select
                    className="material-select"
                    value={glass}
                    onChange={(e) => setGlass(e.target.value as GlassMode)}
                  >
                    <option value="full">完整玻璃</option>
                    <option value="reduced">降低材质</option>
                    <option value="solid">实色</option>
                  </select>
                </div>
                <div className="setting-row">
                  <span>
                    壁纸
                  </span>
                  <label className="control-button">
                    上传壁纸
                    <input
                      type="file"
                      accept="image/*,video/*"
                      hidden
                      onChange={(e) => {
                        void uploadWallpaper(e.target.files?.[0]);
                        e.currentTarget.value = "";
                      }}
                    />
                  </label>
                </div>
                <div className="wallpaper-grid">
                  {WALLPAPERS.map((wp) => (
                    <button
                      key={wp.id}
                      className={"wallpaper-option" + (wallpaper === wp.id ? " on" : "")}
                      data-wallpaper={wp.id}
                      aria-pressed={wallpaper === wp.id}
                      onClick={() => setWallpaper(wp.id)}
                    >
                      <span>{wp.name}</span>
                    </button>
                  ))}
                  {customWallpapers.map((e) => (
                    <div className="wallpaper-cell" key={e.id}>
                      <button
                        className={"wallpaper-option" + (wallpaper === "custom:" + e.id ? " on" : "")}
                        aria-pressed={wallpaper === "custom:" + e.id}
                        onClick={() => setWallpaper("custom:" + e.id)}
                      >
                        {kindOfExt(e.ext) === "video" ? (
                          <video src={fileUrl(WALLPAPER_ID, e.id)} muted loop autoPlay playsInline />
                        ) : (
                          <img src={fileUrl(WALLPAPER_ID, e.id)} alt="" />
                        )}
                        <span>{e.name}</span>
                      </button>
                      <button
                        className="wallpaper-del"
                        aria-label="删除壁纸"
                        title="删除壁纸"
                        onClick={() => void deleteWallpaper(e.id)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <h1>
                  全局模型服务 <span className="badge">尚未连接</span>
                </h1>
                <p className="subtitle">统一配置所有应用使用的模型；当前字段仅保留在内存，不保存、不发送。</p>
                <label className="field">
                  API 地址
                  <input
                    placeholder="https://api.example.com/v1"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                  />
                </label>
                <label className="field">
                  模型名称
                  <input placeholder="填写自定义模型名" value={model} onChange={(e) => setModel(e.target.value)} />
                </label>
              </>
            )}
          </div>
        </div>
      );
    if (w?.appId === "skills")
      return (
        <div className="split">
          <nav className="split-side" aria-label="Skill 分类">
            <div className="split-section">Skill</div>
            <button className="split-nav" aria-current={skillTab === "market"} onClick={() => setSkillTab("market")}>
              <Store size={16} /> 市场
            </button>
            <button className="split-nav" aria-current={skillTab === "mine"} onClick={() => setSkillTab("mine")}>
              <User size={16} /> 我的技能
            </button>
            <div className="split-section">本机</div>
            <button
              className="split-nav"
              aria-current={skillTab === "installed"}
              onClick={() => setSkillTab("installed")}
            >
              <Package size={16} /> 已安装
            </button>
          </nav>
          <div className="split-main">
            <div className="empty-content">
              <img className="large-icon" src={icon("shortcuts")} alt="" draggable={false} />
              <h1>Skill 中心</h1>
              <span className="badge">尚未实现</span>
              <p>市场、自定义技能、版本与团队分享将在后续阶段接入。</p>
              <p className="muted">当前仅验证桌面窗口生命周期，不显示模拟业务数据。</p>
            </div>
          </div>
        </div>
      );
    return (
      <div className="empty-content">
        <img className="large-icon" src={icon(iconOf(id))} alt="" draggable={false} />
        <h1>{apps.find((a) => a.id === w?.appId)?.name}</h1>
        <span className="badge">尚未实现</span>
        <p>
          {w?.appId === "skills"
            ? "市场、自定义技能、版本与团队分享将在后续阶段接入。"
            : w?.appId === "canvas"
              ? "内容块、连线和项目保存将在后续阶段接入。"
              : "个人文件、团队项目和设备文件将在后续阶段接入。"}
        </p>
        <p className="muted">当前仅验证桌面窗口生命周期，不显示模拟业务数据。</p>
      </div>
    );
  };

  const menuItems: MenuItem[] = menu
    ? menu.folder
      ? [
          {
            id: "open",
            label: "打开",
            onSelect: () => {
              const f = folders.find((v) => v.id === menu.folder);
              if (f) openFolder(f);
            },
          },
          { id: "rename", label: "重命名", onSelect: () => window.setTimeout(() => setRenaming(menu.folder!), 0) },
          { separator: true },
          {
            id: "delete",
            label: "删除",
            danger: true,
            onSelect: () => {
              setPendingDelete(menu.folder!);
              // 必须同时置 overlays.dialog：原生视图让位（§17）与背景 inert（§16）
              // 都吃这一个开关。少了这一步，"对话框打开时网页仍在吃键盘"会静默复现。
              setOverlays((o) => ({ ...o, dialog: true }));
            },
          },
        ]
      : menu.file
        ? [
            { id: "open", label: "打开", onSelect: () => void openPreview(DESKTOP_ID, menu.file!) },
            {
              id: "copy-name",
              label: "拷贝名称",
              onSelect: () =>
                void navigator.clipboard?.writeText(desktopFiles.find((f) => f.id === menu.file)?.name ?? ""),
            },
            { separator: true },
            {
              id: "copy",
              label: "拷贝",
              onSelect: () => setClip({ mode: "copy", folderId: DESKTOP_ID, ids: [menu.file!] }),
            },
            {
              id: "cut",
              label: "剪切",
              onSelect: () => setClip({ mode: "cut", folderId: DESKTOP_ID, ids: [menu.file!] }),
            },
            { separator: true },
            {
              id: "delete",
              label: "删除",
              danger: true,
              onSelect: () => {
                void window.openarc?.files?.remove(DESKTOP_ID, menu.file!).then(() => refreshFiles(DESKTOP_ID));
              },
            },
          ]
        : [
            { id: "new-folder", label: "新建文件夹", onSelect: () => createFolder(menu.x, menu.y) },
            ...(clip
              ? ([
                  {
                    id: "paste",
                    label:
                      clip.mode === "cut"
                        ? `粘贴（移动 ${clip.ids.length} 项）`
                        : `粘贴（拷贝 ${clip.ids.length} 项）`,
                    onSelect: () => {
                      void (async () => {
                        if (clip.mode === "cut") {
                          await moveInto(DESKTOP_ID, clip.folderId, clip.ids);
                          setClip(null);
                        } else {
                          await copyInto(DESKTOP_ID, clip.folderId, clip.ids);
                        }
                      })();
                    },
                  },
                ] as MenuItem[])
              : []),
            { separator: true },
            { id: "arrange", label: "整理", onSelect: () => arrangeDesktop() },
            { id: "snap", label: "网格吸附", checked: snap, onSelect: () => setSnap((v) => !v) },
            {
              id: "sort-name",
              label: "排列方式：名称",
              checked: deskSort === "name",
              onSelect: () => {
                setDeskSort("name");
                arrangeDesktop("name");
              },
            },
            {
              id: "sort-date",
              label: "排列方式：日期",
              checked: deskSort === "date",
              onSelect: () => {
                setDeskSort("date");
                arrangeDesktop("date");
              },
            },
            {
              id: "sort-size",
              label: "排列方式：大小",
              checked: deskSort === "size",
              onSelect: () => {
                setDeskSort("size");
                arrangeDesktop("size");
              },
            },
            { separator: true },
            {
              id: "wallpaper",
              label: "壁纸",
              // 父项只负责展开子菜单（onSelect 不会被调用，但类型上必须给）
              onSelect: () => {},
              submenu: [
                ...WALLPAPERS.map(
                  (wp): MenuItem => ({
                    id: "wp-" + wp.id,
                    label: wp.name,
                    checked: wallpaper === wp.id,
                    onSelect: () => setWallpaper(wp.id),
                  }),
                ),
                { separator: true },
                ...(customWallpapers.length
                  ? ([
                      ...customWallpapers.map(
                        (e): MenuItem => ({
                          id: "wp-c-" + e.id,
                          label: e.name,
                          checked: wallpaper === "custom:" + e.id,
                          onSelect: () => setWallpaper("custom:" + e.id),
                        }),
                      ),
                    ] as MenuItem[])
                  : // 没有自定义壁纸时给一条可走的入口（在设置里上传），不做假菜单
                    ([
                      {
                        id: "wp-none",
                        label: "自定义壁纸请到设置里上传",
                        disabled: true,
                        onSelect: () => {},
                      },
                    ] as MenuItem[])),
              ],
            },
          ]
    : [];

  function createFolder(x: number, y: number) {
    const used = new Set(folders.map((f) => f.name));
    let name = "新建文件夹";
    for (let i = 2; used.has(name); i += 1) name = `新建文件夹 ${i}`;
    const folder: Folder = { id: "f" + Date.now().toString(36), name, x: Math.max(0, Math.round(x)), y: Math.max(52, Math.round(y)) };
    setFolders((fs) => [...fs, folder]);
    setMenu(null);
    setRenaming(folder.id);
  }
  /** 在当前文件夹里新建**子文件夹**（同一窗口内导航，不新建窗口）。 */
  function createSubfolder(parentId: string) {
    const used = new Set(folders.filter((f) => f.parentId === parentId).map((f) => f.name));
    let name = "新建文件夹";
    for (let i = 2; used.has(name); i += 1) name = `新建文件夹 ${i}`;
    const folder: Folder = { id: "f" + Date.now().toString(36), name, x: 0, y: 0, parentId };
    setFolders((fs) => [...fs, folder]);
    setPaneMenu(null);
    return folder.id;
  }
  function removeFolder(id: string) {
    setFolders((fs) => {
      // 删文件夹要连带它的子文件夹，否则会留下无父的孤儿条目
      const doomed = new Set([id]);
      for (let changed = true; changed; ) {
        changed = false;
        for (const f of fs)
          if (f.parentId && doomed.has(f.parentId) && !doomed.has(f.id)) {
            doomed.add(f.id);
            changed = true;
          }
      }
      return fs.filter((f) => !doomed.has(f.id));
    });
    onCommand({ type: "window/close", id: FOLDER_PREFIX + id });
    setMenu(null);
    closeDialog();
  }
  function closeDialog() {
    setPendingDelete(null);
    setOverlays((o) => ({ ...o, dialog: false }));
  }
  function renameFolder(id: string, name: string) {
    const next = name.trim();
    setFolders((fs) => fs.map((f) => (f.id === id ? { ...f, name: next || f.name } : f)));
    setRenaming(null);
  }

  const dragFolder = (e: React.PointerEvent, f: Folder) => {
    if (renaming === f.id) return;
    const x = e.clientX;
    const y = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    const el = e.currentTarget as HTMLElement;
    let last = { x: f.x, y: f.y };
    const move = (ev: Event) => {
      const p = ev as PointerEvent;
      const nx = Math.max(0, Math.min(innerWidth - 88, f.x + p.clientX - x));
      const ny = Math.max(52, Math.min(innerHeight - 160, f.y + p.clientY - y));
      last = { x: nx, y: ny };
      // 拖动过程同样不吸附，松手才落格
      setFolders((fs) => fs.map((v) => (v.id === f.id ? { ...v, x: nx, y: ny } : v)));
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      if (snap) {
        const target = snapPos(last.x, last.y);
        setFolders((fs) => fs.map((v) => (v.id === f.id ? { ...v, x: target.x, y: target.y } : v)));
        setSettling(f.id);
        window.setTimeout(() => setSettling((cur) => (cur === f.id ? null : cur)), 280);
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const deleteTarget = pendingDelete ? folders.find((f) => f.id === pendingDelete) : null;

  /**
   * 身份门禁（§38 / §39）。
   *
   *   checking        → 只画启动态。**绝不先画桌面再闪回登录**——
   *                     恢复结果出来之前桌面内容根本不存在
   *   uninitialized   → 只能进初始化；刷新/回退也回不到可提交的空表单之外
   *   unauthenticated → 登录
   *   locked          → 桌面 DOM 保留（窗口状态不丢，§40），整块 inert + 锁屏覆盖
   *   ready / unavailable → 桌面
   *
   * `unavailable` = 没有主进程（浏览器 / 视觉回归环境）。
   * 真实产品里 preload 恒在，因此它不是可绕过的后门。
   */
  const gate = identity.phase;
  const showDesktop = gate === "unavailable" || gate === "ready" || gate === "locked";

  return (
    <div
      className={`desktop ${dark ? "dark" : ""} ${reduced ? "reduced" : ""}`}
      data-glass={glass}
      data-identity-gate={gate}
      data-wallpaper={wallpaper}
      onDragOver={(e) => {
        // 桌面磁贴要能接住内部拖拽；不 preventDefault 的话浏览器直接拒绝 drop
        if (!hasInternalDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
      }}
      onDrop={(e) => {
        // 拖到桌面空白 = 把条目搬进"桌面"这个真实存储文件夹（桌面上的文件就是缩略图）
        if (!hasInternalDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        void (async () => {
          try {
            const p = JSON.parse(e.dataTransfer.getData(INTERNAL_DND)) as { folderId: string; ids: string[] };
            if (!p?.ids?.length || p.folderId === DESKTOP_ID) return;
            if (e.altKey) await copyInto(DESKTOP_ID, p.folderId, p.ids);
            else await moveInto(DESKTOP_ID, p.folderId, p.ids);
          } catch {
            /* 载荷损坏就当作没有拖拽 */
          }
        })();
      }}
      onContextMenu={(e) => {
        if (!showDesktop) return;
        // 只有"桌面本身"才弹桌面菜单（含"新建文件夹"）。
        // 窗口内部的右键由各窗口自己决定：文件夹有内容菜单，其余窗口不弹。
        if ((e.target as HTMLElement).closest(".window")) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* 壁纸层：内置主题色由 data-wallpaper 提供；自定义壁纸画在这里 */}
      <div className="desktop-wallpaper" aria-hidden="true">
        {customEntry ? (
          kindOfExt(customEntry.ext) === "video" ? (
            <video
              className="wallpaper-media"
              src={fileUrl(WALLPAPER_ID, customEntry.id)}
              autoPlay
              muted
              loop
              playsInline
            />
          ) : (
            <img className="wallpaper-media" src={fileUrl(WALLPAPER_ID, customEntry.id)} alt="" />
          )
        ) : null}
      </div>

      {gate === "checking" ? (
        identity.bootError ? (
          <BootRetry message={identity.bootError} onRetry={identity.retry} />
        ) : (
          <BootSurface />
        )
      ) : null}

      {gate === "uninitialized" ? (
        <SetupScreen
          busy={identity.busy}
          error={identity.error}
          onSubmit={async (input) => {
            const res = await identity.initialize(input);
            // 初始化成功后不自动登录：交给登录页，让"初始口令是否可用"被真实验证一次
            if (res && res.ok) return res;
            return res;
          }}
        />
      ) : null}

      {gate === "unauthenticated" ? (
        <LoginScreen
          busy={identity.busy}
          error={identity.error}
          defaultIdentifier={identity.snapshot.identifier || ""}
          onSubmit={(input) => identity.login(input)}
        />
      ) : null}

      {/* Dialog 打开时背景必须 inert：语义层就挡住，而不是只靠 Tab 循环这一层技巧。
          display:contents 让这个包装盒不参与布局，因此不改变任何既有版式。 */}
      {showDesktop ? (
        <>
          <div className="desktop-surface" inert={overlays.dialog || locked || undefined}>
        <TopBar
          searchOpen={overlays.search}
          controlOpen={overlays.control}
          onToggleControl={() => setOverlays((o) => ({ ...o, control: !o.control }))}
          recent={[...state.windows].reverse().map((w) => ({ id: w.id, title: w.meta.title, appId: w.appId }))}
          onFocusWindow={(id) => onCommand({ type: "window/focus", id })}
          onCommand={onCommand}
          onToggleSearch={() => setOverlays((o) => ({ ...o, search: !o.search }))}
          onToggleAI={() => {
            setOverlays((o) => ({ ...o, ai: !o.ai }));
            bounce("__ai");
          }}
          identity={
            gate === "unavailable"
              ? null
              : {
                  displayName: identity.snapshot.displayName,
                  locked,
                  onLock: () => void identity.lock(),
                  onLogout: () => void identity.logout(),
                }
          }
        />
        <div className="desktop-brand">
          <div>OpenArc</div>
          <p>A space for everything you create.</p>
        </div>
        {folders
          .filter((f) => !f.parentId)
          .map((f) => (
          <div
            key={f.id}
            className={"desktop-folder" + (settling === f.id ? " settling" : "")}
            style={{ left: f.x, top: f.y }}
            tabIndex={0}
            data-folder-id={f.id}
            onDragOver={(e) => {
              if (!hasInternalDrag(e)) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
            }}
            onDrop={(e) => void handleInternalDrop(e, f.id)}
            onPointerDown={(e) => dragFolder(e, f)}
            onDoubleClick={() => openFolder(f)}
            onKeyDown={(e) => {
              // 事件必须来自磁贴自身：重命名输入框里的 Enter 会冒泡上来，
              // 若不拦就会"提交重命名的同时把文件夹窗口也打开"（探针抓到的真实缺陷）。
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter") openFolder(f);
              if (e.key === "F2") setRenaming(f.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              menuTrigger.current = e.currentTarget as HTMLElement;
              setMenu({ x: e.clientX, y: e.clientY, folder: f.id });
            }}
          >
            <img className="desktop-folder-icon" src={icon("folder")} alt="" draggable={false} />
            {renaming === f.id ? (
              <input
                className="folder-rename"
                autoFocus
                aria-label="文件夹名称"
                defaultValue={f.name}
                onPointerDown={(e) => e.stopPropagation()}
                onBlur={(e) => renameFolder(f.id, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") renameFolder(f.id, e.currentTarget.value);
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <span className="folder-name">{f.name}</span>
            )}
          </div>
        ))}
        {/* 桌面上的文件：与文件夹里同一套真实存储 + 真实缩略图 */}
        {desktopFiles.map((f, i) => {
          const p = deskPos(f.id, i);
          return (
            <div
              key={f.id}
              className={"desktop-file" + (settling === f.id ? " settling" : "")}
              style={{ left: p.x, top: p.y }}
              data-entry-id={f.id}
              tabIndex={0}
              onPointerDown={(e) => dragDesktopIcon(e, f.id)}
              onDoubleClick={() => void openPreview(DESKTOP_ID, f.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                menuTrigger.current = e.currentTarget as HTMLElement;
                setMenu({ x: e.clientX, y: e.clientY, file: f.id });
              }}
            >
              {thumbs[DESKTOP_ID + "/" + f.id] ? (
                <img
                  className="desktop-thumb"
                  src={thumbs[DESKTOP_ID + "/" + f.id]}
                  alt=""
                  draggable={false}
                />
              ) : (
                <span className="desktop-glyph">
                  <FileGlyph ext={f.ext} size={44} />
                </span>
              )}
              <span className="desktop-file-name">{f.name}</span>
            </div>
          );
        })}
        <AssistantPill
          onActivate={() => {
            setOverlays((o) => ({ ...o, ai: !o.ai }));
            bounce("__ai");
          }}
        />
        {state.windows.map((w) => (
          <DesktopWindow
            key={w.id}
            window={w}
            focused={state.focused === w.id}
            onCommand={onCommand}
            onResizeStart={(e) => startResize(e, w, onCommand)}
            snapshots={snapshotLayers.filter((s) => s.windowId === w.id)}
          >
            {content(w.id)}
          </DesktopWindow>
        ))}
        {anyMaximized && !dockPeek ? (
          <div className="dock-hint" onPointerEnter={() => setDockPeek(true)} aria-hidden="true" />
        ) : null}
        <Dock
          apps={apps}
          runningApps={runningApps}
          bouncing={bouncing}
          dockRef={dockRef}
          hidden={anyMaximized && !dockPeek}
          onPointerLeave={() => setDockPeek(false)}
          onActivate={activateApp}
          onToggleAI={() => {
            setOverlays((o) => ({ ...o, ai: !o.ai }));
            bounce("__ai");
          }}
        />
      </div>

      {overlays.ai ? (
        <AIPanel
          onClose={() => setOverlays((o) => ({ ...o, ai: false }))}
          onOpenSettings={() => {
            setOverlays((o) => ({ ...o, ai: false }));
            activateApp("settings");
          }}
        />
      ) : null}

      {overlays.control ? (
        <>
          {/* 不压暗桌面（不同于搜索），只做点击外部关闭 */}
          <div className="cc-shade" onClick={() => setOverlays((o) => ({ ...o, control: false }))} />
          <div className="control-center" role="dialog" aria-modal="true" aria-label="控制中心">
            <div className="setting-row">
              <span>外观</span>
              <div className="segmented text" role="group" aria-label="外观">
                <button aria-pressed={theme === "system"} onClick={() => setTheme("system")}>
                  跟随系统
                </button>
                <button aria-pressed={theme === "light"} onClick={() => setTheme("light")}>
                  浅色
                </button>
                <button aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
                  深色
                </button>
              </div>
            </div>
            <Switch label="减少动态效果" checked={reduced} onChange={setReduced} />
            <div className="setting-row">
              <span>材质</span>
              <select
                className="material-select"
                aria-label="材质"
                value={glass}
                onChange={(e) => setGlass(e.target.value as GlassMode)}
              >
                <option value="full">完整玻璃</option>
                <option value="reduced">降低材质</option>
                <option value="solid">实色</option>
              </select>
            </div>
            <div className="cc-status">
              <Monitor size={13} /> 本机 · D1
            </div>
            {gate === "unavailable" ? null : (
              <div className="cc-actions">
                <button onClick={() => void identity.lock()} disabled={locked}>
                  <Lock size={13} /> 锁定
                </button>
                <button onClick={() => void identity.logout()}>
                  <LogOut size={13} /> {identity.snapshot.displayName || "退出"}
                </button>
              </div>
            )}
          </div>
        </>
      ) : null}

      {overlays.search ? (
        <div className="search-shade" onClick={() => setOverlays((o) => ({ ...o, search: false }))}>
          <div className="search-panel" ref={searchPanel} role="dialog" aria-modal="true" aria-label="搜索应用" onClick={(e) => e.stopPropagation()}>
            <div className="search-input">
              <img className="search-icon" src={icon("spotlight")} alt="" />
              <input
                aria-label="搜索应用名称"
                placeholder="搜索应用…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Tab") return;
                  const items = Array.from(
                    searchPanel.current?.querySelectorAll<HTMLElement>("button,input") || [],
                  );
                  if (!items.length) return;
                  const first = items[0];
                  const last = items[items.length - 1];
                  if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                  } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                  }
                }}
              />
              <button onClick={() => setOverlays((o) => ({ ...o, search: false }))}>Esc</button>
            </div>
            {apps
              .filter((a) => a.name.toLowerCase().includes(query.toLowerCase()))
              .map((a) => (
                <button className="search-result" key={a.id} onClick={() => activateApp(a.id)}>
                  <img className="result-icon" src={icon(a.icon)} alt="" />
                  {a.name}
                  <ArrowRight size={16} />
                </button>
              ))}
          </div>
        </div>
      ) : null}

      {preview ? (
        <div className="quicklook" role="dialog" aria-modal="true" aria-label="快速查看" onClick={() => setPreview(null)}>
          <div className="quicklook-card" onClick={(e) => e.stopPropagation()}>
            <div className="quicklook-body">
              {preview.kind === "image" && (preview.src || preview.dataUrl) ? (
                <img src={preview.src || preview.dataUrl} alt={preview.entry.name} draggable={false} />
              ) : preview.kind === "video" && (preview.src || preview.dataUrl) ? (
                <video src={preview.src || preview.dataUrl} controls autoPlay />
              ) : preview.kind === "audio" && (preview.src || preview.dataUrl) ? (
                <audio src={preview.src || preview.dataUrl} controls autoPlay />
              ) : preview.kind === "text" ? (
                <pre className="quicklook-text">{preview.text}</pre>
              ) : preview.kind === "pdf" ? (
                <p className="muted">PDF 预览需要后续接入只读文件协议（当前不开放 data: 框架）。</p>
              ) : (
                <p className="muted">
                  暂不支持预览该格式{preview.entry.ext ? "（." + preview.entry.ext + "）" : ""}。
                </p>
              )}
            </div>
            <div className="quicklook-name">
              {preview.entry.name}
              <span className="muted">空格 / Esc 关闭</span>
            </div>
          </div>
        </div>
      ) : null}

      {info ? (
        <div className="quicklook" role="dialog" aria-modal="true" aria-label="显示简介" onClick={() => setInfo(null)}>
          <div className="quicklook-card info-card" onClick={(e) => e.stopPropagation()}>
            <h2 className="info-title">{info.title}</h2>
            {info.subtitle ? <p className="muted">{info.subtitle}</p> : null}
            <dl className="info-rows">
              {info.rows.map((row) => (
                <div className="info-row" key={row.k}>
                  <dt>{row.k}</dt>
                  <dd>{row.v}</dd>
                </div>
              ))}
            </dl>
            <p className="muted">点击任意处关闭</p>
          </div>
        </div>
      ) : null}

      {paneMenu ? (
        <ContextMenu
          x={paneMenu.x}
          y={paneMenu.y}
          items={paneMenu.items}
          onClose={() => setPaneMenu(null)}
          label="文件夹菜单"
        />
      ) : null}
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} label="桌面菜单" />
      ) : null}

      {/* 真实产品消费：删除文件夹前的确认。Dialog 由产品自身使用，
          而不是只在 gallery 里存在 —— 这是 §41 能标 CLOSED BY D2-02 的前提。 */}
      <Dialog
        open={overlays.dialog}
        title="删除文件夹"
        returnFocusTo={menuTrigger.current}
        onClose={closeDialog}
        footer={
          <>
            <button className="ghost" onClick={closeDialog}>
              取消
            </button>
            <button className="primary danger" onClick={() => deleteTarget && removeFolder(deleteTarget.id)}>
              删除
            </button>
          </>
        }
      >
        <p>
          确定删除「{deleteTarget?.name}」吗？该文件夹内的内容不会随之删除。
        </p>
        <p className="muted">此操作不可撤销。</p>
        </Dialog>
        </>
      ) : null}

      {/*
        锁屏是**覆盖层**而不是页面：桌面 DOM 与窗口状态都还在（§40），
        只是整块 inert + 原生视图已隐藏。因此解锁后窗口原样回来，
        不存在"锁定把浏览器会话销毁"这种副作用。
      */}
      {gate === "locked" ? (
        <LockScreen
          snapshot={identity.snapshot}
          busy={identity.busy}
          error={identity.error}
          onUnlock={(password) => identity.unlock(password)}
          onLogout={() => identity.logout()}
        />
      ) : null}
    </div>
  );
}

/**
 * 最后一道兜底：**任何渲染期异常都不允许把界面变成空白**。
 * 只依赖最朴素的样式类，不读任何应用状态，所以它自己几乎不可能再挂。
 */
class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("openarc/render-error", error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="auth-screen" data-d3-id="render-error">
        <div className="auth-boot">
          <strong>OpenArc</strong>
          <span className="muted">界面遇到了一个错误。窗口状态没有丢，重新加载即可继续。</span>
          <button className="control-button" onClick={() => location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
