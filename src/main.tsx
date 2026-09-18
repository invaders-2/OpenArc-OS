import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  ChevronDown,
  Clock,
  Eraser,
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
  RotateCcw,
  Search,
  Share,
  Store,
  Tag,
  Trash2,
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
import { applyCursors, CURSOR_SIZE_DEFAULT, CURSOR_SIZE_MAX, CURSOR_SIZE_MIN } from "./desktop/cursors";
// 别名导入：本模块里有 `declare global { interface Window }`，
// 直接叫 Window 会在类型位置与全局 Window 撞名。
import {
  AIPanel,
  AddressBar,
  AssistantPill,
  ContextMenu,
  Dock,
  FolderIcon,
  TopBar,
  WebViewport,
  Window as DesktopWindow,
  startDrag,
  startResize,
} from "./desktop/components";
import type { MenuItem } from "./desktop/components";
import { Dialog } from "./desktop/Dialog";
import { useIdentity } from "./identity/useIdentity";
import { ResourceLibraryApp } from "./resource/ResourceLibraryApp";
import { BootRetry, BootSurface, LockScreen, LoginScreen, SetupScreen } from "./identity/AuthScreens";
import { ProtectedResourceFixture } from "./authorization/ProtectedResourceFixture";
import { SettingsContent } from "./settings/SettingsContent";
import { GovernanceApp } from "./governance/GovernanceApp";
import { FilesApp } from "./governance/FilesApp";
import { CanvasApp } from "./governance/CanvasApp";
import { ProjectsApp } from "./governance/ProjectsApp";
import { ApprovalPrompt } from "./approval/ApprovalPrompt";
import { errorText } from "./identity/types";
import { Avatar } from "./identity/Avatar";
import { AvatarPicker } from "./identity/AvatarPicker";

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
      authorization?: {
        command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      device?: {
        command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      resource?: {
        command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      governance?: {
        command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      model?: {
        command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      sideEffect?: {
        command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
        onEvent: (cb: (e: { type?: string; request?: unknown }) => void) => () => void;
      },
      files?: {
        pathFor: (file: File) => string;
        import: (
          folderId: string,
          paths: string[],
        ) => Promise<{ ok?: boolean; entries?: FileEntry[]; added?: FileEntry[]; error?: string }>;
        list: (folderId: string) => Promise<{ ok?: boolean; entries?: FileEntry[]; error?: string }>;
        rename: (folderId: string, id: string, name: string) => Promise<{ ok?: boolean; entries?: FileEntry[]; error?: string }>;
        remove: (folderId: string, id: string) => Promise<{ ok?: boolean; entries?: FileEntry[]; error?: string }>;
        /** 系统级回收站（软删除）。remove 仍是永久删除，回收站窗口里才用它。 */
        trash: (folderId: string, id: string) => Promise<{ ok?: boolean; entries?: FileEntry[]; error?: string }>;
        trashList: () => Promise<{
          ok?: boolean;
          entries?: (FileEntry & { folderId?: string; deletedAt?: number })[];
          error?: string;
        }>;
        trashRestore: (id: string) => Promise<{
          ok?: boolean;
          folderId?: string;
          recreated?: boolean;
          id?: string;
          error?: string;
        }>;
        trashPurge: (id: string) => Promise<{ ok?: boolean; error?: string }>;
        trashEmpty: () => Promise<{ ok?: boolean; removed?: number; error?: string }>;
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

/** 系统回收站里的一条：文件条目 + 原文件夹与删除时间（恢复要用原夹去重名）。 */
type TrashEntry = FileEntry & { folderId: string; deletedAt: number };

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

/** 字节数给人看（文件夹窗口与桌面「显示简介」共用一份口径）。 */
const fmtSize = (n?: number) =>
  n === undefined
    ? "—"
    : n < 1024
      ? n + " B"
      : n < 1048576
        ? (n / 1024).toFixed(1) + " KB"
        : (n / 1048576).toFixed(1) + " MB";

/** 浏览器**自己**能渲染的图片格式；其余的（psd/ai/eps/tiff…）请主进程出一张位图。 */
const WEB_IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

/** 桌面本身也是一个真实的存储文件夹：拖到桌面的文件就存在这里。 */
const DESKTOP_ID = "desktop";
/**
 * 桌面栅格：整理与"网格吸附"共用同一套数，**格子尺寸跟着图标大小走**
 * （用户口径：网格吸附按文件夹/文件大小排列，间距照 macOS 桌面）。
 *
 * 间距 = 图标 × 0.35：图标越大间距越大，比例上跟 macOS 桌面一致（图标越大不会显得越挤）。
 * 磁贴比图标本身宽/高一点（留出标签与内边距），这里按最宽的那种磁贴算，保证两种磁贴都不挤。
 */
const DESK_LATTICE = { tileW: 38, tileH: 37, gapRatio: 0.35, right: 20, top: 8 };
const deskLattice = (icon: number, hostW = innerWidth, hostH = innerHeight) => {
  const tileW = icon + DESK_LATTICE.tileW;
  const tileH = icon + DESK_LATTICE.tileH;
  const gap = Math.round(icon * DESK_LATTICE.gapRatio);
  const dx = tileW + gap;
  const dy = tileH + gap;
  // 首格在最右上角，往下排满一列再往左一列 —— 与 macOS 桌面同序
  const rows = Math.max(1, Math.floor((hostH - DESK_BOUND.top - DESK_BOUND.bottom) / dy));
  return { x0: hostW - DESK_LATTICE.right - tileW, y0: DESK_BOUND.top + DESK_LATTICE.top, dx, dy, rows, tileW, tileH };
};
/** 桌面图标的禁入边距：**顶栏那一条不许压**（用户口径：桌面顶部那边不可越界），
    右侧与底部也各留一点，别让图标一半挂在屏幕外。 */
const DESK_BOUND = { top: 52, right: 96, bottom: 140 };
const clampDeskPos = (p: { x: number; y: number }) => ({
  x: Math.max(0, Math.min(innerWidth - DESK_BOUND.right, p.x)),
  y: Math.max(DESK_BOUND.top, Math.min(innerHeight - DESK_BOUND.bottom, p.y)),
});
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

/** 上传壁纸的显示方式（填充 / 适应 / 拉伸 + 自定义缩放与位置）。**不改原图**，只改画法。 */
type WallpaperStyle = { fit: "cover" | "contain" | "fill"; zoom: number; x: number; y: number };
const WALLPAPER_STYLE: WallpaperStyle = { fit: "cover", zoom: 1, x: 0, y: 0 };
/** 壁纸选择器默认只铺一排：5 张，第 6 张起由「查看更多」展开。 */
const WALLPAPER_ROW = 5;

const FOLDER_PREFIX = domain.FOLDER_PREFIX;
const icon = (name: string) => "./icons/" + name + ".png";
const apps = [
  { id: "home", name: "应用中心", icon: "apps" },
  { id: "browser", name: "浏览器", icon: "safari" },
  { id: "files", name: "访达", icon: "finder" },
  { id: "resource-library", name: "资源库", icon: "finder" },
  { id: "canvas", name: "无限画布", icon: "freeform" },
  { id: "projects", name: "项目", icon: "folder" },
  { id: "organization", name: "组织治理", icon: "settings" },
  { id: "skills", name: "Skill 中心", icon: "shortcuts" },
  { id: "settings", name: "系统设置", icon: "settings" },
  // 系统级回收站：与其它 App 不同，它在程序坞里固定在分隔线右侧（见 components.tsx 的 Dock）。
  { id: "trash", name: "回收站", icon: "trash" },
] as const;

/** 程序坞的默认成员与顺序；"还原默认程序坞"就是回到它。 */
const DOCK_DEFAULT = apps.map((a) => a.id);

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
  const { state, dispatch, hostSize, overlays, setOverlays, snapshotLayers, nativeVisibleOf, browserEvents, clearBrowserEvent } =
    useDesktop({ locked });

  // ---------------------------------------------------------------------------
  // 桌面对象（文件夹）仍是独立的一类状态：它们不是窗口，不进 Window Manager。
  // ---------------------------------------------------------------------------
  const [folders, setFolders] = useState<Folder[]>(() => {
    try {
      const raw = localStorage.getItem("oa-folders");
      const parsed = raw ? JSON.parse(raw) : [];
      // 同一层夹取：桌面文件夹的位置同样不许压到顶栏
      return Array.isArray(parsed)
        ? parsed.map((v) => ({ ...v, ...clampDeskPos({ x: v?.x ?? 0, y: v?.y ?? 0 }) }))
        : [];
    } catch {
      return [];
    }
  });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [bouncing, setBouncing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    folder?: string;
    file?: string;
    /** 右键的是哪个 Dock 图标。 */
    dock?: string;
    /** 右键的是程序坞空白。 */
    dockSurface?: boolean;
    /** 右键的是哪张上传的壁纸。 */
    wallpaper?: string;
    /** 桌面多选（框选或 ⌘ 点）后右键：整组操作。 */
    deskGroup?: string[];
    /** 菜单底边贴在 (x, y) 上方并水平居中 —— 程序坞右键用，避免菜单掉出屏幕。 */
    above?: boolean;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [query, setQuery] = useState("");
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
  /** Dock 图标尺寸（px）。范围 / 默认值对齐 macOS 的"大小"滑块。 */
  const [dockSize, setDockSize] = useState(() => {
    const v = Number(localStorage.getItem("oa-dock-size"));
    return Number.isFinite(v) && v >= 32 && v <= 80 ? v : 47;
  });
  /** 桌面图标尺寸（px）：桌面上的文件夹与文件共用这一个大小（用户口径：支持自定义大小）。 */
  const [deskIcon, setDeskIcon] = useState(() => {
    const v = Number(localStorage.getItem("oa-desk-icon"));
    return Number.isFinite(v) && v >= 40 && v <= 96 ? v : 58;
  });
  /** 自绘光标：开关（false = 整套退回系统关键字）与尺寸（px）。 */
  const [cursorCustom, setCursorCustom] = useState(() => localStorage.getItem("oa-cursor-custom") !== "false");
  const [cursorSize, setCursorSize] = useState(() => {
    const v = Number(localStorage.getItem("oa-cursor-size"));
    return Number.isFinite(v) && v >= CURSOR_SIZE_MIN && v <= CURSOR_SIZE_MAX ? v : CURSOR_SIZE_DEFAULT;
  });
  /**
   * 程序坞的成员与顺序。**这个数组就是唯一真值**：顺序即顺序，缺谁就是谁被移除。
   * 读取时不自动补回缺失的 app —— 补回来的话用户永远删不掉任何一个。
   */
  const [dockIds, setDockIds] = useState<string[]>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem("oa-dock") || "null");
      if (Array.isArray(raw)) {
        const known = new Set<string>(DOCK_DEFAULT);
        const kept = raw.filter((v): v is string => typeof v === "string" && known.has(v));
        if (kept.length) {
          // 一次性合并迁移：老用户的 oa-dock 里没有回收站，自动补到末尾（不要求重置程序坞）。
          // 之后用户自己移除不再补回 —— 与"数组即唯一真值"的既有语义一致；标记见下面的 useEffect。
          if (!localStorage.getItem("oa-dock-trash") && !kept.includes("trash")) kept.push("trash");
          return kept;
        }
      }
    } catch {
      /* 存储损坏就回默认 */
    }
    return [...DOCK_DEFAULT];
  });
  const dockApps = useMemo(
    () => dockIds.map((id) => apps.find((a) => a.id === id)).filter((a): a is (typeof apps)[number] => !!a),
    [dockIds],
  );
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
  /**
   * 个人资料草稿（改资料免密码，入口只在系统设置）。
   * 草稿自身份快照，保存时才把"确实改动过的字段"交给主进程（undefined = 不改）。
   */
  const [profileName, setProfileName] = useState("");
  const [profileAvatar, setProfileAvatar] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);
  const savedFlash = useRef<number | null>(null);

  useEffect(() => {
    setProfileName(identity.snapshot.displayName ?? "");
    setProfileAvatar(identity.snapshot.avatarRef);
  }, [identity.snapshot.displayName, identity.snapshot.avatarRef]);

  useEffect(
    () => () => {
      if (savedFlash.current) window.clearTimeout(savedFlash.current);
    },
    [],
  );

  const profileNameDirty = profileName.trim() !== (identity.snapshot.displayName ?? "");
  const profileAvatarDirty = profileAvatar !== null && profileAvatar !== identity.snapshot.avatarRef;
  // 显示名不允许为空，清空不算一次可提交的改动。
  const profileCanSave = !identity.busy && profileName.trim().length > 0 && (profileNameDirty || profileAvatarDirty);

  const saveProfile = async () => {
    if (!profileCanSave) return;
    setProfileSaved(false);
    const input: { displayName?: string; avatarRef?: string } = {};
    if (profileNameDirty) input.displayName = profileName.trim();
    if (profileAvatarDirty && profileAvatar) input.avatarRef = profileAvatar;
    const res = await identity.updateProfile(input);
    if (res && (res as { ok?: boolean }).ok !== false) {
      setProfileSaved(true);
      if (savedFlash.current) window.clearTimeout(savedFlash.current);
      savedFlash.current = window.setTimeout(() => setProfileSaved(false), 2000);
    }
  };
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
  // ---------------------------------------------------------------------------
  // 系统级回收站（软删除）。条目只在回收站窗口打开时拉取；恢复/删除后刷新。
  // ---------------------------------------------------------------------------
  const [trashEntries, setTrashEntries] = useState<TrashEntry[]>([]);
  const [trashSel, setTrashSel] = useState<string[]>([]);
  const [trashView, setTrashView] = useState<"grid" | "list">("grid");
  const [trashConfirm, setTrashConfirm] = useState<{ kind: "purge" | "empty"; id?: string; name?: string } | null>(null);
  const refreshTrash = useCallback(async () => {
    const bridge = window.openarc?.files;
    if (!bridge?.trashList) return;
    try {
      const res = await bridge.trashList();
      if (res && Array.isArray(res.entries)) setTrashEntries(res.entries as TrashEntry[]);
    } catch {
      /* 主进程不可用时保持原样 */
    }
  }, []);
  /** 恢复：刷新它原来所在的文件夹（原夹不存在时后端会重建），并清掉选择。 */
  const restoreFromTrash = async (ids: string[]) => {
    const bridge = window.openarc?.files;
    if (!bridge?.trashRestore || !ids.length) return;
    for (const id of ids) {
      const res = await bridge.trashRestore(id);
      if (res?.ok && res.folderId) void refreshFiles(res.folderId);
    }
    await refreshFiles(DESKTOP_ID);
    setTrashSel([]);
    await refreshTrash();
  };
  const purgeFromTrash = async (ids: string[]) => {
    const bridge = window.openarc?.files;
    if (!bridge?.trashPurge || !ids.length) return;
    for (const id of ids) await bridge.trashPurge(id);
    setTrashSel([]);
    await refreshTrash();
  };
  const emptyTrash = async () => {
    await window.openarc?.files?.trashEmpty?.();
    setTrashSel([]);
    await refreshTrash();
  };
  /** 危险操作走既有 Dialog；overlays.dialog 让原生视图让位、背景 inert。 */
  const openTrashConfirm = (c: { kind: "purge" | "empty"; id?: string; name?: string }) => {
    setTrashConfirm(c);
    setOverlays((o) => ({ ...o, dialog: true }));
  };
  const closeTrashConfirm = () => {
    setTrashConfirm(null);
    setOverlays((o) => ({ ...o, dialog: false }));
  };
  useEffect(() => {
    if (state.windows.some((w) => w.appId === "trash")) void refreshTrash();
  }, [state.windows, refreshTrash]);
  /** 当前选中的条目（按 windowId），Quick Look 的目标。 */
  /** 当前选中的条目（按 windowId 存 **一组 id**，支持多选）。 */
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  /** 框选矩形（windowId + 相对 folder-body 的矩形）与「显示简介」浮层。 */
  const [marquee, setMarquee] = useState<{ winId: string; x: number; y: number; w: number; h: number } | null>(null);
  /** 刚刚发生过一次真正的框选拖动 —— 用来吃掉浏览器补发的那个 click。 */
  const marqueeDrag = useRef(false);
  /** 桌面框选：选中的桌面条目（文件夹与文件同一个集合）+ 橡皮筋矩形。 */
  const [deskSel, setDeskSel] = useState<string[]>([]);
  const [deskMarquee, setDeskMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  /** 桌面拖拽悬停在"不接受落点"的区域（程序坞 / 顶栏）：自绘禁止光标。 */
  const [deskDropInvalid, setDeskDropInvalid] = useState(false);
  /** 按住 ⌘（拖到系统 = 拷贝/别名）：可拖拽条目换成自绘拷贝光标。 */
  const [cmdDown, setCmdDown] = useState(false);
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
    const folderId = windowFolderId({ id: fid, appId: domain.byId(state, fid)?.appId ?? "" });
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
      const fid = windowFolderId(win);
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
      const parsed = JSON.parse(localStorage.getItem("oa-desktop-icons") || "{}") as Record<string, { x: number; y: number }>;
      if (!parsed || typeof parsed !== "object") return {};
      // 旧版本在顶栏上方松手会算出负坐标，载入时先夹回可视区
      return Object.fromEntries(
        Object.entries(parsed).map(([k, v]) => [k, clampDeskPos({ x: v?.x ?? 0, y: v?.y ?? 0 })]),
      );
    } catch {
      return {};
    }
  });
  const [snap, setSnap] = useState(() => localStorage.getItem("oa-snap") !== "0");
  const [wallpaper, setWallpaper] = useState(() => localStorage.getItem("oa-wallpaper") || "theme-dark");
  /** 锁屏/登录壁纸独立于桌面：same = 跟随桌面当前壁纸。 */
  const [lockWallpaper, setLockWallpaper] = useState(() => localStorage.getItem("oa-lock-wallpaper") || "same");
  /** 每张上传壁纸各自的显示方式（key = 存储条目 id）。 */
  const [wallpaperStyle, setWallpaperStyle] = useState<Record<string, WallpaperStyle>>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem("oa-wallpaper-style") || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
  /** 壁纸选择器是否已点「查看更多」（默认只铺一排 5 张）。 */
  const [wallpapersOpen, setWallpapersOpen] = useState(false);
  /** 正在调整尺寸的上传条目 id（null = 对话框关着）。 */
  const [styleTarget, setStyleTarget] = useState<string | null>(null);
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
  useEffect(() => {
    localStorage.setItem("oa-lock-wallpaper", lockWallpaper);
  }, [lockWallpaper]);
  useEffect(() => {
    localStorage.setItem("oa-wallpaper-style", JSON.stringify(wallpaperStyle));
  }, [wallpaperStyle]);
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
  /** 选择器里的壁纸全集：内置主题色在前，上传的在后 —— 尺寸一律相同。 */
  const wallpaperItems = [
    ...WALLPAPERS.map((wp) => ({ kind: "preset" as const, id: wp.id, name: wp.name, ext: "" })),
    ...customWallpapers.map((e) => ({ kind: "custom" as const, id: e.id, name: e.name, ext: e.ext })),
  ];
  const styleEntry = styleTarget ? (customWallpapers.find((e) => e.id === styleTarget) ?? null) : null;
  const styleOf = (id: string) => wallpaperStyle[id] ?? WALLPAPER_STYLE;
  /** 同一套显示方式同时喂给桌面壁纸和它的预览图，所见即所得。 */
  const mediaStyle = (st: WallpaperStyle): React.CSSProperties => ({
    objectFit: st.fit,
    transform: `scale(${st.zoom}) translate(${st.x}%, ${st.y}%)`,
  });
  /** 锁屏/登录要用的壁纸：same 跟随桌面；自定义条目解析成纯数据，identity 层不碰 files 服务。 */
  const effectiveLockWallpaper = lockWallpaper === "same" ? wallpaper : lockWallpaper;
  const lockWallpaperEntry = effectiveLockWallpaper.startsWith("custom:")
    ? (customWallpapers.find((e) => e.id === effectiveLockWallpaper.slice(7)) ?? null)
    : null;
  const lockWallpaperProp = {
    id: effectiveLockWallpaper,
    src: lockWallpaperEntry ? fileUrl(WALLPAPER_ID, lockWallpaperEntry.id) : undefined,
    kind: lockWallpaperEntry ? (kindOfExt(lockWallpaperEntry.ext) === "video" ? ("video" as const) : ("image" as const)) : undefined,
    style: lockWallpaperEntry ? mediaStyle(styleOf(lockWallpaperEntry.id)) : undefined,
  };
  const patchStyle = (id: string, p: Partial<WallpaperStyle>) =>
    setWallpaperStyle((m) => ({ ...m, [id]: { ...WALLPAPER_STYLE, ...m[id], ...p } }));
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);
  /** 上传壁纸：拷进 wallpapers 存储文件夹，然后把它设为当前壁纸。 */
  /** 删除自定义壁纸（真实删存储条目）；删掉的正好是当前壁纸就退回内置极光。 */
  const deleteWallpaper = async (entryId: string) => {
    if (!window.openarc?.files) return;
    await window.openarc.files.remove(WALLPAPER_ID, entryId);
    // 条目没了，它的显示设置也不该留在 localStorage 里
    setWallpaperStyle((m) => {
      if (!(entryId in m)) return m;
      const next = { ...m };
      delete next[entryId];
      return next;
    });
    await refreshFiles(WALLPAPER_ID);
    if (wallpaper === "custom:" + entryId) setWallpaper("theme-dark");
    if (lockWallpaper === "custom:" + entryId) setLockWallpaper("same");
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
  /** 锁屏区块的上传：同一份存储与画法，上传成功即选中为锁屏壁纸。 */
  const uploadLockWallpaper = async (file: File | undefined) => {
    if (!file || !window.openarc?.files) return;
    const p = window.openarc.files.pathFor(file);
    if (!p) return;
    const res = await window.openarc.files.import(WALLPAPER_ID, [p]);
    await refreshFiles(WALLPAPER_ID);
    const added = res?.added?.[res.added.length - 1];
    if (added) setLockWallpaper("custom:" + added.id);
  };
  /**
   * 替换上传的壁纸：新图先入库，**显示设置跟着搬到新条目**，再删掉旧条目 ——
   * 对用户来说就是"同一张壁纸换了张图"，位置与大小不变。
   */
  const replaceWallpaper = async (file: File | undefined) => {
    const target = replaceTarget.current;
    replaceTarget.current = null;
    if (!file || !target || !window.openarc?.files) return;
    const p = window.openarc.files.pathFor(file);
    if (!p) return;
    const res = await window.openarc.files.import(WALLPAPER_ID, [p]);
    const added = res?.added?.[res.added.length - 1];
    if (!added) return;
    setWallpaperStyle((m) => {
      if (!(target in m)) return m;
      const next = { ...m, [added.id]: m[target] };
      delete next[target];
      return next;
    });
    if (wallpaper === "custom:" + target) setWallpaper("custom:" + added.id);
    // 锁屏壁纸也指着这条就一起搬到新条目，否则会留下一个悬空的 custom id
    if (lockWallpaper === "custom:" + target) setLockWallpaper("custom:" + added.id);
    await window.openarc.files.remove(WALLPAPER_ID, target);
    await refreshFiles(WALLPAPER_ID);
  };
  /** 上传壁纸的右键 / ⋯ 菜单；触发元素交回去，菜单卸载后焦点不丢。 */
  const openWallpaperMenu = (x: number, y: number, entryId: string, trigger?: HTMLElement) => {
    menuTrigger.current = trigger ?? (document.activeElement as HTMLElement);
    setMenu({ x, y, wallpaper: entryId });
  };
  /**
   * 调整尺寸的对话框。走 overlays.dialog 是硬要求：原生网页视图据它整块让位，
   * 桌面也要真的 inert —— 少了这一步就是"对话框开着但键盘还在桌面"。
   */
  const openStyleDialog = (entryId: string) => {
    setStyleTarget(entryId);
    setOverlays((o) => ({ ...o, dialog: true }));
  };
  const closeStyleDialog = () => {
    setStyleTarget(null);
    setOverlays((o) => ({ ...o, dialog: false }));
  };
  /**
   * 一张壁纸格子 —— 选择器与「显示全部」下拉共用同一份。
   * 用户口径就是"不管内置还是上传，预览图尺寸要一样"，两份实现迟早会漂移。
   */
  const wallpaperTile = (it: (typeof wallpaperItems)[number]) =>
    it.kind === "preset" ? (
      <button
        key={it.id}
        className={"wallpaper-option" + (wallpaper === it.id ? " on" : "")}
        data-wallpaper={it.id}
        aria-pressed={wallpaper === it.id}
        onClick={() => setWallpaper(it.id)}
      >
        <span>{it.name}</span>
      </button>
    ) : (
      <div className="wallpaper-cell" key={it.id}>
        <button
          className={"wallpaper-option" + (wallpaper === "custom:" + it.id ? " on" : "")}
          aria-pressed={wallpaper === "custom:" + it.id}
          onClick={() => setWallpaper("custom:" + it.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            openWallpaperMenu(e.clientX, e.clientY, it.id, e.currentTarget);
          }}
        >
          {kindOfExt(it.ext) === "video" ? (
            <video
              src={fileUrl(WALLPAPER_ID, it.id)}
              style={mediaStyle(styleOf(it.id))}
              muted
              loop
              autoPlay
              playsInline
            />
          ) : (
            <img src={fileUrl(WALLPAPER_ID, it.id)} style={mediaStyle(styleOf(it.id))} alt="" />
          )}
          <span>{it.name}</span>
        </button>
        <button
          className="wallpaper-more"
          aria-label="壁纸选项"
          title="壁纸选项"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openWallpaperMenu(r.left, r.bottom + 4, it.id, e.currentTarget);
          }}
        >
          ⋯
        </button>
        <button
          className="wallpaper-del"
          aria-label="删除壁纸"
          title="删除壁纸"
          onClick={() => void deleteWallpaper(it.id)}
        >
          ✕
        </button>
      </div>
    );
  /** 锁屏壁纸格子：复用桌面那套网格/格子样式，但选中态绑 lockWallpaper。 */
  const lockWallpaperTile = (it: (typeof wallpaperItems)[number]) =>
    it.kind === "preset" ? (
      <button
        key={it.id}
        className={"wallpaper-option" + (lockWallpaper === it.id ? " on" : "")}
        data-lock-wallpaper={it.id}
        aria-pressed={lockWallpaper === it.id}
        onClick={() => setLockWallpaper(it.id)}
      >
        <span>{it.name}</span>
      </button>
    ) : (
      <button
        key={it.id}
        className={"wallpaper-option" + (lockWallpaper === "custom:" + it.id ? " on" : "")}
        data-lock-wallpaper={"custom:" + it.id}
        aria-pressed={lockWallpaper === "custom:" + it.id}
        onClick={() => setLockWallpaper("custom:" + it.id)}
      >
        {kindOfExt(it.ext) === "video" ? (
          <video src={fileUrl(WALLPAPER_ID, it.id)} style={mediaStyle(styleOf(it.id))} muted loop autoPlay playsInline />
        ) : (
          <img src={fileUrl(WALLPAPER_ID, it.id)} style={mediaStyle(styleOf(it.id))} alt="" />
        )}
        <span>{it.name}</span>
      </button>
    );
  const desktopFiles = useMemo(() => {
    const list = [...(filesByFolder[DESKTOP_ID] ?? [])];
    if (deskSort === "date") list.sort((a, b) => b.mtime - a.mtime);
    else if (deskSort === "size") list.sort((a, b) => b.size - a.size);
    else list.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    return list;
  }, [filesByFolder, deskSort]);
  /** 当前桌面栅格：跟着图标大小与窗口尺寸走（窗口变了要重算行数）。 */
  const deskGrid = useMemo(() => deskLattice(deskIcon, hostSize.width, hostSize.height), [deskIcon, hostSize]);
  const gridPos = (index: number) =>
    clampDeskPos({
      // 首格在右上角，往下排满 rows 行再往左一列（macOS 桌面的顺序）
      x: deskGrid.x0 - Math.floor(index / deskGrid.rows) * deskGrid.dx,
      y: deskGrid.y0 + (index % deskGrid.rows) * deskGrid.dy,
    });
  /** 落格坐标必须夹一次：在顶栏上方松手时，向上取整会算出负的格位（实测会被甩到 -30）。 */
  const snapPos = (x: number, y: number) =>
    clampDeskPos({
      x: deskGrid.x0 - Math.round((deskGrid.x0 - x) / deskGrid.dx) * deskGrid.dx,
      y: deskGrid.y0 + Math.round((y - deskGrid.y0) / deskGrid.dy) * deskGrid.dy,
    });
  const deskPos = (id: string, index: number) => desktopIcons[id] ?? gridPos(index);
  /** 一个桌面条目的当前位置：文件夹读 folders，文件读落格记录。 */
  const deskEntryPos = (id: string): { x: number; y: number } => {
    const f = folders.find((v) => v.id === id);
    if (f) return { x: f.x, y: f.y };
    return deskPos(id, Math.max(0, desktopFiles.findIndex((v) => v.id === id)));
  };
  const setDeskEntryPos = (id: string, p: { x: number; y: number }) => {
    if (folders.some((v) => v.id === id))
      setFolders((fs) => fs.map((v) => (v.id === id ? { ...v, x: p.x, y: p.y } : v)));
    else setDesktopIcons((m) => ({ ...m, [id]: p }));
  };
  /** 落格：把条目动画到栅格（只有这一步用过渡，所以看起来是"轻轻吸过去"而不是跳）。 */
  const settleEntry = (id: string, pos: { x: number; y: number }) => {
    setDeskEntryPos(id, clampDeskPos(pos));
    setSettling(id);
    window.setTimeout(() => setSettling((cur) => (cur === id ? null : cur)), 280);
  };
  /**
   * 桌面框选（用户口径：桌面支持鼠标按住框选）。
   *
   * 只在"点到的就是桌面本身"时启动 —— 图标、窗口、程序坞、顶栏都有自己的指针语义，
   * 抢它们的指针等于把它们全部弄坏。命中判定用图标与橡皮筋的真实矩形求交。
   */
  const startDesktopMarquee = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (el !== e.currentTarget && !el.classList.contains("desktop-wallpaper")) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    const keep = e.shiftKey ? deskSel : [];
    if (!e.shiftKey) setDeskSel([]); // 空白处按下 = 先取消选择（与 Finder 一致）
    const move = (ev: PointerEvent) => {
      const x1 = ev.clientX - rect.left;
      const y1 = ev.clientY - rect.top;
      const box = {
        left: Math.min(x0, x1),
        top: Math.min(y0, y1),
        right: Math.max(x0, x1),
        bottom: Math.max(y0, y1),
      };
      setDeskMarquee({ x: box.left, y: box.top, w: box.right - box.left, h: box.bottom - box.top });
      const hitting: string[] = [];
      document
        .querySelectorAll<HTMLElement>(".desktop-folder[data-folder-id], .desktop-file[data-entry-id]")
        .forEach((tile) => {
          const r = tile.getBoundingClientRect();
          const cx = r.left - rect.left;
          const cy = r.top - rect.top;
          if (cx < box.right && cx + r.width > box.left && cy < box.bottom && cy + r.height > box.top)
            hitting.push(tile.dataset.folderId || tile.dataset.entryId || "");
        });
      setDeskSel([...new Set([...keep, ...hitting.filter(Boolean)])]);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDeskMarquee(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /**
   * 桌面图标按下：先定选中集合，再**整组**跟手拖（用户口径：框选后能拖拽移动）。
   * 拖动过程 1:1 不吸附，松手才落格；松手落在文件夹磁贴或**打开的文件夹窗口**上 = 整组搬进去。
   */
  const dragDesktopSelection = (e: React.PointerEvent, id: string) => {
    // ⌘ + 按下 = 拖到系统（Finder / 桌面）：走原生 startDrag。
    // 桌面图标**不能**再挂 HTML5 draggable —— 那样浏览器会把"按下+移动"判成 HTML5 拖拽，
    // 指针事件被吞掉，位置就再也拖不动了（实测如此）。
    if (e.metaKey) {
      window.openarc?.files?.startDrag(DESKTOP_ID, id);
      return;
    }
    const el = e.currentTarget as HTMLElement;
    el.focus(); // 键盘路径（空格 Quick Look / Enter 打开）依赖焦点
    // 点在已选中的图标上 = 保持整组；点在其他图标上 = 先变成单选（Shift / Ctrl 是增删）
    const wasSelected = deskSel.includes(id);
    const next =
      e.shiftKey || e.ctrlKey
        ? wasSelected
          ? deskSel.filter((x) => x !== id)
          : [...deskSel, id]
        : wasSelected
          ? deskSel
          : [id];
    setDeskSel(next);
    const ids = next.includes(id) ? next : [id];
    const x0 = e.clientX;
    const y0 = e.clientY;
    const starts = ids.map((x) => [x, deskEntryPos(x)] as const);
    /**
     * 松手 / 悬停时"会落进哪个文件夹"。三条判据，从严到宽：
     *   1. 指针底下就是文件夹（窗口里的小文件夹格子优先于它所在的窗口）；
     *   2. 指针压在"正在拖的这个图标"上时，用图标真实矩形与文件夹求交；
     *   3. 重叠面积要盖住图标的三成 —— 路过蹭一下不算，摆上去才算。
     * 用户口径：「移动文件到文件夹，自动放进文件夹里」。
     */
    const dropRef = { el: null as HTMLElement | null };
    const asTarget = (node: Element | null): { el: HTMLElement; id: string } | null => {
      if (!node) return null;
      const cell = node.closest<HTMLElement>(".file-cell[data-entry-id]");
      const cellId = cell?.dataset.entryId;
      // 窗口里显示的"子文件夹格子"优先：拖到哪个文件夹上就进哪个
      if (cell && cellId && folders.some((v) => v.id === cellId) && !ids.includes(cellId))
        return { el: cell, id: cellId };
      const holder = node.closest<HTMLElement>("[data-drop-folder]");
      const holderId = holder?.dataset.dropFolder;
      if (holder && holderId && holderId !== DESKTOP_ID && !ids.includes(holderId))
        return { el: holder, id: holderId };
      return null;
    };
    // 被拖图标的矩形用**状态里的位置**算，不读 DOM —— DOM 慢一帧，高亮会晚一步
    // （实测：松手时能进文件夹，拖动过程中却不亮）
    const rectAt = (dx: number, dy: number) => {
      const found = starts.find(([x]) => x === id);
      const s = found ? found[1] : { x: 0, y: 0 };
      const p = clampDeskPos({ x: s.x + dx, y: s.y + dy });
      return { left: p.x, top: p.y, right: p.x + el.offsetWidth, bottom: p.y + el.offsetHeight };
    };
    /**
     * 指针底下是什么就按什么判（和 macOS 一样，只认指针位置）。
     * 用 elementsFromPoint 取整摞：正在拖的图标永远压在指针下，跳过它看下面那一层，
     * 不然"把图标挪到文件夹上"永远判不出来。
     */
    const underPointer = (clientX: number, clientY: number) => {
      for (const node of document.elementsFromPoint(clientX, clientY)) {
        const tile = (node as HTMLElement).closest?.("[data-entry-id],[data-folder-id]") as HTMLElement | null;
        const tileId = tile?.dataset.entryId || tile?.dataset.folderId;
        if (tileId && ids.includes(tileId)) continue;
        const hit = asTarget(node as HTMLElement);
        if (hit) return hit;
      }
      return null;
    };
    const resolveTarget = (clientX: number, clientY: number, rect: { left: number; top: number; right: number; bottom: number }) => {
      const under = underPointer(clientX, clientY);
      if (under) return under;
      let best: { el: HTMLElement; id: string } | null = null;
      let bestArea = 0;
      // 兜底只认**桌面上的文件夹磁贴**（用户口径：叠到文件夹上就自动放进去）。
      // 窗口正文不参与兜底 —— 桌面大半被窗口盖着，靠矩形求交会把图标误吞进"某个文件夹"（用户实测：拖一下就消失）。
      document.querySelectorAll<HTMLElement>(".desktop-folder[data-drop-folder]").forEach((c) => {
        const hit = asTarget(c);
        if (!hit || hit.el !== c) return;
        const r = c.getBoundingClientRect();
        const w = Math.min(r.right, rect.right) - Math.max(r.left, rect.left);
        const h = Math.min(r.bottom, rect.bottom) - Math.max(r.top, rect.top);
        const area = w > 0 && h > 0 ? w * h : 0;
        if (area > bestArea) {
          bestArea = area;
          best = hit;
        }
      });
      return best && bestArea >= (rect.right - rect.left) * (rect.bottom - rect.top) * 0.3 ? best : null;
    };
    const markTarget = (node: HTMLElement | null) => {
      const ref = dropRef as { el: HTMLElement | null };
      if (ref.el === node) return;
      ref.el?.classList.remove("drop-target");
      ref.el = node;
      node?.classList.add("drop-target");
    };
    el.setPointerCapture(e.pointerId);
    const move = (ev: Event) => {
      const p = ev as PointerEvent;
      const dx = p.clientX - x0;
      const dy = p.clientY - y0;
      for (const [x, s] of starts) setDeskEntryPos(x, clampDeskPos({ x: s.x + dx, y: s.y + dy }));
      markTarget(resolveTarget(p.clientX, p.clientY, rectAt(dx, dy))?.el ?? null);
      // 落点无效（程序坞 / 顶栏不吃桌面拖拽）时才换禁止光标：跳过跟手的图标本身再看下一层
      let invalid = false;
      for (const node of document.elementsFromPoint(p.clientX, p.clientY)) {
        const el = node as HTMLElement;
        const tile = el.closest?.("[data-entry-id],[data-folder-id]") as HTMLElement | null;
        const tileId = tile?.dataset.entryId || tile?.dataset.folderId;
        if (tileId && ids.includes(tileId)) continue;
        invalid = !!(el.closest?.(".dock") || el.closest?.(".topbar"));
        break;
      }
      setDeskDropInvalid((cur) => (cur === invalid ? cur : invalid));
    };
    const end = (ev?: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      const hit = ev ? resolveTarget(ev.clientX, ev.clientY, rectAt(ev.clientX - x0, ev.clientY - y0)) : null;
      markTarget(null);
      setDeskDropInvalid(false);
      if (hit) {
        void moveInto(hit.id, DESKTOP_ID, ids).then(() => {
          setDesktopIcons((m) => {
            const out = { ...m };
            for (const x of ids) delete out[x];
            return out;
          });
          setDeskSel([]);
        });
        return;
      }
      if (snap) {
        const dx = ev ? ev.clientX - x0 : 0;
        const dy = ev ? ev.clientY - y0 : 0;
        for (const [x, s] of starts) settleEntry(x, snapPos(s.x + dx, s.y + dy));
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };
  /**
   * 「显示简介」的唯一实现：桌面与文件夹窗口共用同一份字段口径。
   * 位置名与 folderId 由调用方给 —— 同一个条目在桌面和在窗口里都要说清"它在哪"。
   */
  const describeEntry = async (row: Row, location: string, folderId: string) => {
    setInfo({
      title: row.name,
      subtitle: row.kind === "folder" ? "文件夹" : row.ext ? row.ext.toUpperCase() + " 文件" : "文件",
      rows:
        row.kind === "folder"
          ? [
              { k: "种类", v: "文件夹" },
              { k: "包含", v: String(folders.filter((f) => f.parentId === row.id).length) + " 个子文件夹" },
              { k: "位置", v: location },
            ]
          : [
              { k: "种类", v: row.ext ? row.ext.toUpperCase() + " 文件" : "文件" },
              { k: "大小", v: fmtSize(row.size) },
              { k: "修改时间", v: row.mtime ? new Date(row.mtime).toLocaleString("zh-CN") : "—" },
              { k: "所在", v: location },
            ],
    });
    // 图片再补一行真实分辨率（读不出来就不编）
    if (row.kind === "file" && window.openarc?.files && kindOfExt(row.ext ?? "") === "image") {
      const inf = await window.openarc.files.info(folderId, row.id);
      if (inf?.ok && inf.width) {
        setInfo((cur) =>
          cur && cur.title === row.name
            ? { ...cur, rows: [...cur.rows, { k: "分辨率", v: `${inf.width} × ${inf.height}` }] }
            : cur,
        );
      }
    }
  };
  /** 桌面条目的「显示简介」（用户口径：桌面选择文件右键要能看简介）。 */
  const showDesktopInfo = async (entryId: string) => {
    const f = folders.find((v) => v.id === entryId);
    if (f) return describeEntry({ id: f.id, name: f.name, kind: "folder" }, "桌面", DESKTOP_ID);
    const file = desktopFiles.find((v) => v.id === entryId);
    if (file)
      return describeEntry(
        { id: file.id, name: file.name, kind: "file", ext: file.ext, size: file.size, mtime: file.mtime },
        "桌面",
        DESKTOP_ID,
      );
  };
  const deskEntryName = (entryId: string) =>
    folders.find((f) => f.id === entryId)?.name ?? desktopFiles.find((f) => f.id === entryId)?.name ?? entryId;
  const copyDeskNames = (ids: string[]) => {
    void navigator.clipboard?.writeText(ids.map(deskEntryName).join("\n"));
  };
  /** 多选时的「显示简介」：说清整组有多少文件夹/文件、总大小（用户口径里的"群组"）。 */
  const showSelectionInfo = (ids: string[]) => {
    const files = ids
      .filter((x) => !folders.some((v) => v.id === x))
      .map((x) => desktopFiles.find((v) => v.id === x))
      .filter((v): v is FileEntry => !!v);
    const folderCount = ids.length - files.length;
    setInfo({
      title: `${ids.length} 项`,
      subtitle: "多选",
      rows: [
        {
          k: "包含",
          v:
            [folderCount ? `${folderCount} 个文件夹` : "", files.length ? `${files.length} 个文件` : ""]
              .filter(Boolean)
              .join("、") || "—",
        },
        { k: "总大小", v: fmtSize(files.reduce((n, v) => n + (v.size ?? 0), 0)) },
        { k: "位置", v: "桌面" },
      ],
    });
  };
  /** 删除桌面选中项：文件走文件服务，虚拟文件夹连带子文件夹与它的窗口。 */
  const deleteDesktopSelection = async (ids: string[]) => {
    for (const x of ids) {
      if (folders.some((f) => f.id === x)) removeFolder(x);
      else await window.openarc?.files?.trash(DESKTOP_ID, x);
    }
    setDesktopIcons((m) => {
      const out = { ...m };
      for (const x of ids) delete out[x];
      return out;
    });
    setDeskSel([]);
    await refreshFiles(DESKTOP_ID);
    await refreshTrash();
  };
  /** 「用所选 N 项新建文件夹」= 用户口径里的"编组"：新文件夹吃下整组，随即进入改名。 */
  const newFolderFromSelection = async (ids: string[]) => {
    if (!ids.length) return;
    const first = deskEntryPos(ids[0]);
    const used = new Set(folders.filter((v) => !v.parentId).map((v) => v.name));
    let name = "新建文件夹";
    for (let i = 2; used.has(name); i += 1) name = `新建文件夹 ${i}`;
    const folder: Folder = {
      id: "f" + Date.now().toString(36),
      name,
      x: Math.max(0, Math.round(first.x + deskGrid.dx)),
      y: Math.max(52, Math.round(first.y)),
    };
    setFolders((fs) => [...fs, folder]);
    await moveInto(folder.id, DESKTOP_ID, ids);
    setDesktopIcons((m) => {
      const out = { ...m };
      for (const x of ids) delete out[x];
      return out;
    });
    setDeskSel([]);
    setRenaming(folder.id);
  };

  /**
   * 整理：把桌面上的**文件夹与文件一起**重新落到栅格上。
   * 文件夹在前、文件在后，与文件夹窗口里的分组同一口径；栅格本身跟着图标大小走（见 deskLattice）。
   */
  const arrangeDesktop = (sort?: "name" | "date" | "size") => {
    const key = sort ?? deskSort;
    const list = [...(filesByFolder[DESKTOP_ID] ?? [])];
    if (key === "date") list.sort((a, b) => b.mtime - a.mtime);
    else if (key === "size") list.sort((a, b) => b.size - a.size);
    else list.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    const deskFolders = folders.filter((v) => !v.parentId).sort((a, b) => a.name.localeCompare(b.name, "zh"));
    const order = [...deskFolders.map((v) => v.id), ...list.map((v) => v.id)];
    const at = (id: string) => order.indexOf(id);
    setFolders((fs) => fs.map((v) => (at(v.id) >= 0 ? { ...v, ...gridPos(at(v.id)) } : v)));
    setDesktopIcons(() => {
      const next: Record<string, { x: number; y: number }> = {};
      list.forEach((v) => {
        next[v.id] = gridPos(at(v.id));
      });
      return next;
    });
    setDeskSel([]);
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
      // 返回克隆出来的文件夹 id：调用方要把它们摆到鼠标旁边
      const cloned: string[] = [];
      for (const x of folderIds) cloned.push(await cloneFolder(x, toFolderId, folders));
      return cloned;
    },
    [folders, refreshFiles],
  );
  /**
   * 落到桌面的东西摆在**鼠标旁边**（用户口径：「按住移动到桌面，落脚点在鼠标旁边」）。
   * 多个条目按 22px 递进错开，像 macOS 那样一小叠，而不是全压在一个点上。
   */
  const placeAtDrop = (clientX: number, clientY: number, ids: string[]) => {
    const wanted = ids.filter(Boolean);
    if (!wanted.length) return;
    const base = clampDeskPos({ x: clientX - deskGrid.tileW / 2, y: clientY - 14 });
    const spot = (i: number) => clampDeskPos({ x: base.x + i * 22, y: base.y + i * 22 });
    const folderIds = wanted.filter((x) => folders.some((v) => v.id === x));
    if (folderIds.length)
      setFolders((fs) =>
        fs.map((v) => (folderIds.includes(v.id) ? { ...v, ...spot(folderIds.indexOf(v.id)) } : v)),
      );
    const fileIds = wanted.filter((x) => !folderIds.includes(x));
    if (fileIds.length)
      setDesktopIcons((m) => {
        const next = { ...m };
        fileIds.forEach((x, i) => {
          next[x] = spot(folderIds.length + i);
        });
        return next;
      });
  };
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

  /**
   * 窗口此刻在浏览哪个 folderId。
   *
   * 文件夹窗口把它写在 appId 里；**访达窗口没有 appId 前缀，默认落在桌面** ——
   * 用户口径："文件 app 改为访达，跟 Apple 一个逻辑，打开就是打开文件夹的意思。"
   */
  const windowFolderId = (win: { id: string; appId: string }) =>
    folderUI[win.id]?.folderId ??
    (win.appId.startsWith(FOLDER_PREFIX)
      ? win.appId.slice(FOLDER_PREFIX.length)
      : win.appId === "files"
        ? DESKTOP_ID
        : null);

  /**
   * 顶栏"最近应用"的身份：**文件夹窗口属于访达**。
   *
   * 文件夹窗口的 appId 是 `folder:<id>`（见 openFolder），在顶栏对不上任何线性图标，
   * 于是每打开一个文件夹就多一个占位方块。用户口径："打开文件夹上方不需要显示 icon，
   * 全部统一到访达里面" —— 它们在这里折成访达这一个身份。
   */
  const appIdentity = (w: { appId: string }) =>
    w.appId === "files" || w.appId.startsWith(FOLDER_PREFIX) ? "files" : w.appId;

  /** 一个 App 的全部窗口 id。访达把文件夹窗口算在内 —— 它们就是访达的窗口。 */
  const appWindowIds = (appId: string) => state.windows.filter((w) => appIdentity(w) === appId).map((w) => w.id);

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
      ["dock-size", dockSize],
      ["desk-icon", deskIcon],
      ["cursor-custom", cursorCustom],
      ["cursor-size", cursorSize],
    ])
      localStorage.setItem("oa-" + k, String(v));
  }, [reduced, glass, dark, dockSize, deskIcon, cursorCustom, cursorSize]);

  // 自绘光标：尺寸 / 开关 / 深浅色任一变化都重写根上的 --cursor-* 变量。
  useEffect(() => {
    applyCursors({ enabled: cursorCustom, size: cursorSize, dark });
  }, [cursorCustom, cursorSize, dark]);
  useEffect(() => {
    localStorage.setItem("oa-dock", JSON.stringify(dockIds));
    // 迁移标记：首次补过回收站后就落一次，避免"用户移除回收站后重启又被自动补回"。
    if (!localStorage.getItem("oa-dock-trash")) localStorage.setItem("oa-dock-trash", "1");
  }, [dockIds]);
  useEffect(() => {
    localStorage.setItem("oa-folders", JSON.stringify(folders));
  }, [folders]);

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

  /** ⌘ 的按下/抬起只改指针外观；拖拽行为仍在各自的手势里决定。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => setCmdDown(e.metaKey);
    const off = () => setCmdDown(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", off);
    };
  }, []);

  const runningApps = useMemo(() => new Set(state.windows.map((w) => w.appId)), [state.windows]);
  /** 顶栏的最近应用：**一个 App 一个图标**（文件夹折进访达），保留每个身份最新的那个窗口。 */
  const recentApps = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; title: string; appId: string }[] = [];
    for (const w of [...state.windows].reverse()) {
      const appId = appIdentity(w);
      if (seen.has(appId)) continue;
      seen.add(appId);
      out.push({ id: w.id, title: w.meta.title, appId });
    }
    return out;
  }, [state.windows]);
  /** 任一窗口全屏 → Dock 自动隐藏；指针碰到底部才唤回。 */
  const anyMaximized = state.windows.some((w) => w.state === domain.WSTATE.MAXIMIZED);
  const [dockPeek, setDockPeek] = useState(false);

  // 文件夹窗口打开 / 切换目录后，向文件服务取一次条目（每个 folderId 只取一次）
  useEffect(() => {
    if (!window.openarc?.files) return;
    const ids = new Set<string>();
    for (const win of state.windows) {
      const fid = windowFolderId(win);
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
    // 访达 = 打开"桌面"这个文件夹本身（Apple 的口径：访达打开的是一个文件夹）
    const folder = folderOf(id) ?? (w?.appId === "files" ? { id: DESKTOP_ID, name: "桌面", x: 0, y: 0 } : undefined);
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
        // 根目录（访达打开的桌面）下的文件夹 parentId 是 undefined，统一按 DESKTOP_ID 归一
        ...folders
          .filter((f) => (f.parentId ?? DESKTOP_ID) === shown.id)
          .map((f) => ({ id: f.id, name: f.name, kind: "folder" as const })),
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
        marqueeDrag.current = false; // 每次按下先归零：只有这次真的拖动过才置位
        const move = (ev: PointerEvent) => {
          const x1 = ev.clientX - rect.left;
          const y1 = ev.clientY - rect.top;
          const box = {
            left: Math.min(x0, x1),
            top: Math.min(y0, y1),
            right: Math.max(x0, x1),
            bottom: Math.max(y0, y1),
          };
          if (box.right - box.left > 3 || box.bottom - box.top > 3) marqueeDrag.current = true;
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
      /** 显示简介：与桌面共用同一份实现（describeEntry），字段口径不会两头漂移。 */
      const showInfo = async (row: Row) => {
        setPaneMenu(null);
        await describeEntry(row, shown.name, shown.id);
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
        // 删除 = 移入系统回收站（可恢复）；永久删除只在回收站窗口里发生。
        void window.openarc?.files?.trash(shown.id, entryId).then(() => {
          void refreshFiles(shown.id);
          void refreshTrash();
        });
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
              {
                id: "group",
                label: `用所选 ${picked.length} 项新建文件夹`,
                onSelect: () => {
                  const fid = createSubfolder(shown.id);
                  void moveInto(fid, shown.id, ids);
                  setSelected((m) => ({ ...m, [id]: [] }));
                },
              },
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
              // 框选松手后浏览器还会补一个 click。不挡掉它，"框选完选择就没了"（实测真的这样）。
              if (marqueeDrag.current) {
                marqueeDrag.current = false;
                return;
              }
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
              data-drop-folder={shown.id}
              data-marquee={marquee?.winId === id ? "files" : undefined}
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
                              <FolderIcon size={ui.view === "grid" ? 46 : 24} />
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
    if (w?.appId === "trash") {
      const sel = trashSel;
      const any = sel.length > 0;
      const nameOf = (entryId: string) => trashEntries.find((e) => e.id === entryId)?.name ?? entryId;
      /** 与文件夹窗口同一套选择语义：单击单选、⌘/Ctrl 加减选、Shift 扩选。 */
      const toggle = (entryId: string, e: React.MouseEvent) => {
        setTrashSel((cur) => {
          if (e.metaKey || e.ctrlKey) return cur.includes(entryId) ? cur.filter((x) => x !== entryId) : [...cur, entryId];
          if (e.shiftKey && cur.length) {
            const order = trashEntries.map((v) => v.id);
            const a = order.indexOf(cur[cur.length - 1]);
            const b = order.indexOf(entryId);
            if (a >= 0 && b >= 0) return order.slice(Math.min(a, b), Math.max(a, b) + 1);
          }
          return [entryId];
        });
      };
      return (
        <div className="split">
          <nav className="split-side" aria-label="回收站操作">
            <div className="split-section">回收站</div>
            <button className="split-nav" aria-current={sel.length === 0} onClick={() => setTrashSel([])}>
              <Trash2 size={16} /> <span className="split-nav-label">全部项目</span>
            </button>
            <div className="split-section">操作</div>
            <button className="split-nav" disabled={!any} onClick={() => void restoreFromTrash(sel)}>
              <RotateCcw size={16} /> <span className="split-nav-label">恢复</span>
            </button>
            <button
              className="split-nav"
              disabled={!any}
              onClick={() =>
                openTrashConfirm({ kind: "purge", id: sel[0], name: sel.length > 1 ? sel.length + " 项" : nameOf(sel[0]) })
              }
            >
              <Trash2 size={16} /> <span className="split-nav-label">永久删除</span>
            </button>
            <button className="split-nav" disabled={!trashEntries.length} onClick={() => openTrashConfirm({ kind: "empty" })}>
              <Eraser size={16} /> <span className="split-nav-label">清空回收站</span>
            </button>
          </nav>
          <div className="split-main">
            <div className="pane-toolbar">
              <strong className="pane-title">回收站</strong>
              <div className="toolbar-spacer" />
              <span className="badge">{trashEntries.length} 项</span>
              <div className="segmented" role="group" aria-label="查看方式">
                <button aria-pressed={trashView === "grid"} aria-label="图标" onClick={() => setTrashView("grid")}>
                  <LayoutGrid size={15} />
                </button>
                <button aria-pressed={trashView === "list"} aria-label="列表" onClick={() => setTrashView("list")}>
                  <List size={15} />
                </button>
              </div>
            </div>
            <div
              className="folder-body"
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest(".file-cell")) setTrashSel([]);
              }}
            >
              {trashEntries.length === 0 ? (
                <div className="empty-content">
                  <img className="large-icon" src={icon("trash")} alt="" draggable={false} />
                  <p>回收站是空的。</p>
                </div>
              ) : (
                <div className={trashView === "grid" ? "file-grid" : "file-list"}>
                  {trashEntries.map((e) => (
                    <div
                      key={e.id}
                      className={"file-cell " + (sel.includes(e.id) ? "selected" : "")}
                      role="button"
                      tabIndex={0}
                      title={e.name}
                      data-entry-id={e.id}
                      onClick={(ev) => toggle(e.id, ev)}
                      onDoubleClick={() => void restoreFromTrash([e.id])}
                      onKeyDown={(ev) => {
                        // 键盘可达：Enter / 空格 = 恢复，Delete = 永久删除（同样先确认）。
                        if (ev.key === "Enter" || ev.code === "Space") {
                          ev.preventDefault();
                          void restoreFromTrash([e.id]);
                        }
                        if (ev.key === "Delete" || ev.key === "Backspace") {
                          ev.preventDefault();
                          openTrashConfirm({ kind: "purge", id: e.id, name: e.name });
                        }
                      }}
                      onContextMenu={(ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        const ids = sel.includes(e.id) ? sel : [e.id];
                        if (!sel.includes(e.id)) setTrashSel([e.id]);
                        setPaneMenu({
                          x: ev.clientX,
                          y: ev.clientY,
                          items: [
                            { id: "restore", label: "恢复", onSelect: () => void restoreFromTrash(ids) },
                            { separator: true },
                            {
                              id: "purge",
                              label: ids.length > 1 ? `永久删除 ${ids.length} 项` : "永久删除",
                              danger: true,
                              onSelect: () =>
                                openTrashConfirm({
                                  kind: "purge",
                                  id: ids[0],
                                  name: ids.length > 1 ? ids.length + " 项" : nameOf(ids[0]),
                                }),
                            },
                          ],
                        });
                      }}
                    >
                      <span className="file-glyph">
                        <FileGlyph ext={e.ext} size={trashView === "grid" ? 40 : 22} />
                      </span>
                      <span className="file-name">{e.name}</span>
                    </div>
                  ))}
                </div>
              )}
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
                              : a.id === "files"
                                ? "本地文件 · 真实存储"
                                : a.id === "trash"
                                  ? "已删除的文件 · 可恢复"
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
    if (w?.appId === "resource-library") return <ResourceLibraryApp />;
    if (w?.appId === "files") return <FilesApp />;
    if (w?.appId === "canvas") return <CanvasApp />;
    if (w?.appId === "projects") return <ProjectsApp />;
    if (w?.appId === "organization") return <GovernanceApp />;
    if (w?.appId === "settings")
      return (
        <SettingsContent
          role={identity.snapshot.role}
          appearanceBody={
            <>
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
                  <div className="segmented text" role="group" aria-label="材质">
                    <button aria-pressed={glass === "full"} onClick={() => setGlass("full")}>
                      完整玻璃
                    </button>
                    <button aria-pressed={glass === "reduced"} onClick={() => setGlass("reduced")}>
                      降低材质
                    </button>
                    <button aria-pressed={glass === "solid"} onClick={() => setGlass("solid")}>
                      实色
                    </button>
                  </div>
                  {/* 探针钩子：device-ui 依赖 .material-select 在设置打开时就在 DOM 里。
                      可见控件已按设计基线改回分段控件，这里保留一个不可见镜像。 */}
                  <select
                    className="material-select"
                    hidden
                    aria-hidden="true"
                    tabIndex={-1}
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
                    程序坞图标大小
                    <span className="footnote"> 拖动滑块调整 Dock 图标尺寸</span>
                  </span>
                  <span className="setting-range-wrap">
                    <input
                      className="setting-range"
                      type="range"
                      min={32}
                      max={80}
                      step={1}
                      value={dockSize}
                      onChange={(e) => setDockSize(Number(e.target.value))}
                      aria-label="程序坞图标大小"
                    />
                    <span className="setting-range-value">{dockSize}px</span>
                  </span>
                </div>
                <div className="setting-row">
                  <span>
                    桌面图标大小
                    <span className="footnote"> 拖动滑块调整桌面文件夹与文件的尺寸</span>
                  </span>
                  <span className="setting-range-wrap">
                    <input
                      className="setting-range"
                      type="range"
                      min={40}
                      max={96}
                      step={1}
                      value={deskIcon}
                      onChange={(e) => setDeskIcon(Number(e.target.value))}
                      aria-label="桌面图标大小"
                    />
                    <span className="setting-range-value">{deskIcon}px</span>
                  </span>
                </div>
                <Switch label="使用自绘光标" checked={cursorCustom} onChange={setCursorCustom} />
                <div className="setting-row">
                  <span>
                    光标大小
                    <span className="footnote"> 拖动滑块调整自绘光标尺寸</span>
                  </span>
                  <span className="setting-range-wrap">
                    <input
                      className="setting-range"
                      type="range"
                      min={CURSOR_SIZE_MIN}
                      max={CURSOR_SIZE_MAX}
                      step={1}
                      value={cursorSize}
                      disabled={!cursorCustom}
                      onChange={(e) => setCursorSize(Number(e.target.value))}
                      aria-label="光标大小"
                    />
                    <span className="setting-range-value">{cursorSize}px</span>
                  </span>
                </div>
                <div className="setting-row">
                  <span>壁纸</span>
                  <span className="wallpaper-actions">
                    {wallpaperItems.length > WALLPAPER_ROW ? (
                      <button
                        className="control-button"
                        aria-expanded={wallpapersOpen}
                        onClick={() => setWallpapersOpen((v) => !v)}
                      >
                        {wallpapersOpen ? "收起" : "查看更多"}
                        <ChevronDown size={13} />
                      </button>
                    ) : null}
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
                  </span>
                </div>
                <input
                  ref={replaceInput}
                  type="file"
                  accept="image/*,video/*"
                  aria-label="替换壁纸图片"
                  hidden
                  onChange={(e) => {
                    void replaceWallpaper(e.target.files?.[0]);
                    e.currentTarget.value = "";
                  }}
                />
                <div className="wallpaper-grid">
                  {/* 默认只有一排 5 张，第 6 张起藏起来；点「查看更多」就地展开（不是弹窗） */}
                  {(wallpapersOpen ? wallpaperItems : wallpaperItems.slice(0, WALLPAPER_ROW)).map(wallpaperTile)}
                </div>

                <h3>锁屏壁纸</h3>
                <div className="setting-row">
                  <span>
                    锁屏壁纸
                    <span className="footnote"> 登录界面与锁屏共用同一张，独立于桌面</span>
                  </span>
                  <span className="wallpaper-actions">
                    <label className="control-button" data-d3-id="settings-lock-wallpaper-upload">
                      上传壁纸
                      <input
                        type="file"
                        accept="image/*,video/*"
                        hidden
                        onChange={(e) => {
                          void uploadLockWallpaper(e.target.files?.[0]);
                          e.currentTarget.value = "";
                        }}
                      />
                    </label>
                  </span>
                </div>
                <div className="wallpaper-grid">
                  {/* 第一格是「同桌面」：跟随桌面当前壁纸，不复制它的选择 */}
                  <button
                    className={"wallpaper-option" + (lockWallpaper === "same" ? " on" : "")}
                    data-lock-wallpaper="same"
                    data-d3-id="settings-lock-wallpaper-same"
                    aria-pressed={lockWallpaper === "same"}
                    onClick={() => setLockWallpaper("same")}
                  >
                    <span>同桌面</span>
                  </button>
                  {wallpaperItems.map(lockWallpaperTile)}
                </div>

                <h3>个人资料</h3>
                <div className="setting-row">
                  <span>头像</span>
                  <span className="profile-avatar" data-d3-id="settings-avatar">
                    <Avatar avatarRef={profileAvatar} name={profileName} />
                  </span>
                </div>
                <AvatarPicker
                  avatarRef={profileAvatar}
                  onChange={(next) => {
                    setProfileAvatar(next);
                    setProfileSaved(false);
                  }}
                  disabled={identity.busy}
                  idPrefix="settings-avatar"
                />
                <label className="field">
                  显示名
                  <input
                    value={profileName}
                    onChange={(e) => {
                      setProfileName(e.target.value);
                      setProfileSaved(false);
                    }}
                    placeholder="显示名"
                    autoComplete="off"
                    data-d3-id="settings-name"
                  />
                </label>
                <div className="profile-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={!profileCanSave}
                    onClick={() => void saveProfile()}
                    data-d3-id="settings-save"
                  >
                    {identity.busy ? "正在保存…" : profileSaved ? "已保存" : "保存"}
                  </button>
                </div>
                <p className="profile-hint">保存后立即生效，不需要输入密码。</p>
                {identity.error ? (
                  <p className="auth-error" role="alert" data-d3-id="settings-error">
                    {errorText(identity.error.code, identity.error.detail)}
                  </p>
                ) : null}
            </>
          }
        />
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

  const missingDockApps = apps.filter((a) => !dockIds.includes(a.id));
  const restoreDock = {
    id: "reset",
    label: "还原默认程序坞",
    disabled: dockIds.join("|") === DOCK_DEFAULT.join("|"),
    onSelect: () => setDockIds([...DOCK_DEFAULT]),
  };
  const menuItems: MenuItem[] = menu
    ? menu.dock
      ? [
          { id: "open", label: "打开", onSelect: () => activateApp(menu.dock!) },
          {
            id: "quit",
            label: "关闭应用",
            // 没有窗口可关时不做无效动作；文件夹窗口算访达的窗口，一起关掉
            disabled: appWindowIds(menu.dock).length === 0,
            onSelect: () => {
              for (const id of appWindowIds(menu.dock!)) onCommand({ type: "window/close", id });
            },
          },
          { separator: true },
          {
            id: "remove",
            label: "从程序坞中移除",
            // 至少留一个：全删光会让程序坞只剩"全局 AI"，用户就再没有入口把它加回来
            disabled: dockIds.length <= 1,
            onSelect: () => setDockIds((ids) => ids.filter((v) => v !== menu.dock)),
          },
          { separator: true },
          restoreDock,
        ]
      : menu.dockSurface
        ? [
            ...(missingDockApps.length
              ? ([
                  {
                    id: "add",
                    label: "添加到程序坞",
                    submenu: missingDockApps.map((a) => ({
                      id: "add-" + a.id,
                      label: a.name,
                      onSelect: () => setDockIds((ids) => (ids.includes(a.id) ? ids : [...ids, a.id])),
                    })),
                    onSelect: () => {},
                  },
                ] as MenuItem[])
              : []),
            { separator: true },
            restoreDock,
          ]
        : menu.wallpaper
          ? [
              { id: "size", label: "调整尺寸…", onSelect: () => openStyleDialog(menu.wallpaper!) },
              {
                id: "replace",
                label: "替换图片…",
                onSelect: () => {
                  replaceTarget.current = menu.wallpaper!;
                  replaceInput.current?.click();
                },
              },
              { separator: true },
              {
                id: "delete-wallpaper",
                label: "删除",
                danger: true,
                onSelect: () => void deleteWallpaper(menu.wallpaper!),
              },
            ]
          : menu.deskGroup
            ? [
                { id: "open", label: "打开", disabled: true, onSelect: () => {} },
                { id: "info", label: "显示简介", onSelect: () => showSelectionInfo(menu.deskGroup!) },
                {
                  id: "group",
                  label: `用所选 ${menu.deskGroup.length} 项新建文件夹`,
                  onSelect: () => void newFolderFromSelection(menu.deskGroup!),
                },
                {
                  id: "copy-name",
                  label: `拷贝 ${menu.deskGroup.length} 项名称`,
                  onSelect: () => copyDeskNames(menu.deskGroup!),
                },
                { separator: true },
                {
                  id: "copy",
                  label: `拷贝 ${menu.deskGroup.length} 项`,
                  onSelect: () => setClip({ mode: "copy", folderId: DESKTOP_ID, ids: menu.deskGroup! }),
                },
                {
                  id: "cut",
                  label: `剪切 ${menu.deskGroup.length} 项`,
                  onSelect: () => setClip({ mode: "cut", folderId: DESKTOP_ID, ids: menu.deskGroup! }),
                },
                { separator: true },
                {
                  id: "delete",
                  label: `删除 ${menu.deskGroup.length} 项`,
                  danger: true,
                  onSelect: () => void deleteDesktopSelection(menu.deskGroup!),
                },
              ]
            : menu.folder
      ? [
          {
            id: "open",
            label: "打开",
            onSelect: () => {
              const f = folders.find((v) => v.id === menu.folder);
              if (f) openFolder(f);
            },
          },
          { id: "info", label: "显示简介", onSelect: () => void showDesktopInfo(menu.folder!) },
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
            { id: "info", label: "显示简介", onSelect: () => void showDesktopInfo(menu.file!) },
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
                // 桌面删除同样先进回收站，可在回收站窗口里恢复。
                void window.openarc?.files?.trash(DESKTOP_ID, menu.file!).then(() => {
                  void refreshFiles(DESKTOP_ID);
                  void refreshTrash();
                });
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
      data-marquee={deskMarquee ? "desk" : undefined}
      data-drop-invalid={deskDropInvalid ? "1" : undefined}
      data-cmd={cmdDown ? "1" : undefined}
      data-glass={glass}
      data-identity-gate={gate}
      data-wallpaper={wallpaper}
      style={{ "--dock-icon": `${dockSize}px`, "--desk-icon": `${deskIcon}px` } as React.CSSProperties}
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
            // 落点在鼠标那儿，不是栅格另一头：先把鼠标坐标接住，再等搬运完成
            const dropX = e.clientX;
            const dropY = e.clientY;
            if (e.altKey) {
              const before = new Set((filesByFolder[DESKTOP_ID] ?? []).map((v) => v.id));
              const cloned = await copyInto(DESKTOP_ID, p.folderId, p.ids);
              const res = await window.openarc?.files?.list(DESKTOP_ID);
              const added = (res?.entries ?? []).map((v) => v.id).filter((id) => !before.has(id));
              placeAtDrop(dropX, dropY, [...added, ...cloned]);
            } else {
              await moveInto(DESKTOP_ID, p.folderId, p.ids);
              placeAtDrop(dropX, dropY, p.ids);
            }
          } catch {
            /* 载荷损坏就当作没有拖拽 */
          }
        })();
      }}
      onPointerDown={startDesktopMarquee}
      onContextMenu={(e) => {
        if (!showDesktop) return;
        // 只有"桌面本身"才弹桌面菜单（含"新建文件夹"）。
        // 窗口内部的右键由各窗口自己决定：文件夹有内容菜单，其余窗口不弹。
        if ((e.target as HTMLElement).closest(".window")) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* 桌面框选：与指针 1:1 的橡皮筋（图标之上、窗口之下） */}
      {deskMarquee ? (
        <div
          className="marquee"
          aria-hidden="true"
          style={{ left: deskMarquee.x, top: deskMarquee.y, width: deskMarquee.w, height: deskMarquee.h }}
        />
      ) : null}

      {/* 壁纸层：内置主题色由 data-wallpaper 提供；自定义壁纸画在这里 */}
      <div className="desktop-wallpaper" aria-hidden="true">
        {customEntry ? (
          kindOfExt(customEntry.ext) === "video" ? (
            <video
              className="wallpaper-media"
              src={fileUrl(WALLPAPER_ID, customEntry.id)}
              style={mediaStyle(styleOf(customEntry.id))}
              autoPlay
              muted
              loop
              playsInline
            />
          ) : (
            <img
              className="wallpaper-media"
              src={fileUrl(WALLPAPER_ID, customEntry.id)}
              style={mediaStyle(styleOf(customEntry.id))}
              alt=""
            />
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
          wallpaper={lockWallpaperProp}
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
          recent={recentApps}
          onFocusWindow={(id) => onCommand({ type: "window/focus", id })}
          onCommand={onCommand}
          onToggleSearch={() => setOverlays((o) => ({ ...o, search: !o.search }))}
          onToggleAI={() => {
            setOverlays((o) => ({ ...o, ai: !o.ai }));
            bounce("__ai");
          }}
          animated={!reduced}
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
        {folders
          .filter((f) => !f.parentId)
          .map((f) => (
          <div
            key={f.id}
            className={
              "desktop-folder" + (settling === f.id ? " settling" : "") + (deskSel.includes(f.id) ? " selected" : "")
            }
            style={{ left: f.x, top: f.y }}
            tabIndex={0}
            data-folder-id={f.id}
            data-drop-folder={f.id}
            onDragOver={(e) => {
              if (!hasInternalDrag(e)) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
            }}
            onDrop={(e) => void handleInternalDrop(e, f.id)}
            onPointerDown={(e) => dragDesktopSelection(e, f.id)}
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
              // 右键落在未选中的图标上 → 先把它设为唯一选中；落在选中集合内 → 对整组操作
              const ids = deskSel.includes(f.id) ? deskSel : [f.id];
              if (!deskSel.includes(f.id)) setDeskSel([f.id]);
              setMenu(
                ids.length > 1
                  ? { x: e.clientX, y: e.clientY, deskGroup: ids }
                  : { x: e.clientX, y: e.clientY, folder: f.id },
              );
            }}
          >
            <FolderIcon size={deskIcon} />
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
              className={
                "desktop-file" + (settling === f.id ? " settling" : "") + (deskSel.includes(f.id) ? " selected" : "")
              }
              style={{ left: p.x, top: p.y }}
              data-entry-id={f.id}
              tabIndex={0}
              // focus 与选中都在 dragDesktopSelection 里：不这样做时点击不产生焦点，
              // "点一下文件再按空格"就不会生效（用户口径：桌面文件也要支持空格查看）。
              onPointerDown={(e) => dragDesktopSelection(e, f.id)}
              onDoubleClick={() => void openPreview(DESKTOP_ID, f.id)}
              onKeyDown={(e) => {
                // 与文件夹窗口内的口径一致：空格 = Quick Look，Enter = 打开。
                if (e.target !== e.currentTarget) return;
                if (e.code === "Space" || e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  // 全局空格处理器（document 级）不再重复触发一次
                  e.stopPropagation();
                  void openPreview(DESKTOP_ID, f.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                menuTrigger.current = e.currentTarget as HTMLElement;
                const ids = deskSel.includes(f.id) ? deskSel : [f.id];
                if (!deskSel.includes(f.id)) setDeskSel([f.id]);
                setMenu(
                  ids.length > 1
                    ? { x: e.clientX, y: e.clientY, deskGroup: ids }
                    : { x: e.clientX, y: e.clientY, file: f.id },
                );
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
                  <FileGlyph ext={f.ext} size={Math.round(deskIcon * 0.76)} />
                </span>
              )}
              <span className="desktop-file-name">{f.name}</span>
            </div>
          );
        })}
        <AssistantPill
          animated={!reduced}
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
          apps={dockApps}
          runningApps={runningApps}
          bouncing={bouncing}
          reduced={reduced}
          iconSize={dockSize}
          hidden={anyMaximized && !dockPeek}
          onPointerLeave={() => setDockPeek(false)}
          onReorder={(next) =>
            setDockIds((ids) => {
              // Dock 只排分隔线左侧的 App；回收站是固定槽位，重排后要原样保留它。
              const out = next.filter((v) => v !== "trash");
              if (ids.includes("trash")) out.push("trash");
              return out;
            })
          }
          onItemMenu={(appId, e) => {
            e.preventDefault();
            e.stopPropagation();
            const el = e.currentTarget as HTMLElement;
            menuTrigger.current = el;
            // 锚在图标**上方**：Dock 贴着屏幕底边，菜单从光标往下展开会掉出屏幕
            const r = el.getBoundingClientRect();
            setMenu({ x: r.left + r.width / 2, y: r.top, dock: appId, above: true });
          }}
          onSurfaceMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const el = e.currentTarget as HTMLElement;
            menuTrigger.current = el;
            setMenu({ x: e.clientX, y: el.getBoundingClientRect().top, dockSurface: true, above: true });
          }}
          onActivate={activateApp}
          onToggleAI={() => {
            setOverlays((o) => ({ ...o, ai: !o.ai }));
            bounce("__ai");
          }}
        />
        {/* D3-02：最小 Protected Resource Fixture。未注入 resourceRef 时返回 null。 */}
        <ProtectedResourceFixture />
      </div>

      {overlays.ai ? (
        <AIPanel
          animated={!reduced}
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
              <div className="segmented text" role="group" aria-label="材质">
                <button aria-pressed={glass === "full"} onClick={() => setGlass("full")}>
                  完整玻璃
                </button>
                <button aria-pressed={glass === "reduced"} onClick={() => setGlass("reduced")}>
                  降低材质
                </button>
                <button aria-pressed={glass === "solid"} onClick={() => setGlass("solid")}>
                  实色
                </button>
              </div>
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

      {/* D4-03C4：Trusted Approval UI。打开时与 Dialog 同一条规则 —— 原生视图整块让位。 */}
      <ApprovalPrompt onOpenChange={(open) => setOverlays((o) => (o.dialog === open ? o : { ...o, dialog: open }))} />

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
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
          label={menu.dock || menu.dockSurface ? "程序坞菜单" : menu.wallpaper ? "壁纸菜单" : "桌面菜单"}
          anchorAbove={menu.above}
          className={menu.dock || menu.dockSurface ? "dock-menu" : undefined}
        />
      ) : null}

      {/* 上传壁纸的尺寸：填充/适应/拉伸 + 自定义缩放与位置。改动即时生效（所见即所得）。 */}
      <Dialog
        open={styleTarget !== null}
        title={styleEntry ? "调整「" + styleEntry.name + "」" : "调整壁纸尺寸"}
        returnFocusTo={menuTrigger.current}
        onClose={closeStyleDialog}
        footer={
          <>
            <button className="ghost" onClick={() => styleTarget && patchStyle(styleTarget, WALLPAPER_STYLE)}>
              恢复默认
            </button>
            <button className="primary" onClick={closeStyleDialog}>
              完成
            </button>
          </>
        }
      >
        {styleTarget ? (
          <>
            <div className="setting-row">
              <span>显示方式</span>
              <div className="segmented text" role="group" aria-label="显示方式">
                {(
                  [
                    ["cover", "填充"],
                    ["contain", "适应"],
                    ["fill", "拉伸"],
                  ] as const
                ).map(([fit, label]) => (
                  <button
                    key={fit}
                    aria-pressed={styleOf(styleTarget).fit === fit}
                    onClick={() => patchStyle(styleTarget, { fit })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-row">
              <span>
                缩放
                <span className="footnote"> 只改画法，不动原图</span>
              </span>
              <span className="setting-range-wrap">
                <input
                  className="setting-range"
                  type="range"
                  min={50}
                  max={200}
                  step={1}
                  value={Math.round(styleOf(styleTarget).zoom * 100)}
                  onChange={(e) => patchStyle(styleTarget, { zoom: Number(e.target.value) / 100 })}
                  aria-label="壁纸缩放"
                />
                <span className="setting-range-value">{Math.round(styleOf(styleTarget).zoom * 100)}%</span>
              </span>
            </div>
            {(
              [
                ["x", "水平位置"],
                ["y", "垂直位置"],
              ] as const
            ).map(([axis, label]) => (
              <div className="setting-row" key={axis}>
                <span>{label}</span>
                <span className="setting-range-wrap">
                  <input
                    className="setting-range"
                    type="range"
                    min={-50}
                    max={50}
                    step={1}
                    value={styleOf(styleTarget)[axis]}
                    onChange={(e) => patchStyle(styleTarget, { [axis]: Number(e.target.value) })}
                    aria-label={label}
                  />
                  <span className="setting-range-value">{styleOf(styleTarget)[axis]}%</span>
                </span>
              </div>
            ))}
          </>
        ) : null}
      </Dialog>

      {/* 真实产品消费：删除文件夹前的确认。Dialog 由产品自身使用，
          而不是只在 gallery 里存在 —— 这是 §41 能标 CLOSED BY D2-02 的前提。 */}
      {/* open 认 pendingDelete 而不是 overlays.dialog：后者现在是"有对话框开着"的聚合开关，
          两个对话框（删除确认 / 调整壁纸尺寸）各自有真值，否则会互相把对方一起打开。 */}
      <Dialog
        open={pendingDelete !== null}
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

      {/* 回收站危险操作（永久删除 / 清空）的二次确认：复用同一个 Dialog 原语。
          不传 returnFocusTo：默认回到打开它的那个按钮 / 条目，正是键盘用户的原位。 */}
      <Dialog
        open={trashConfirm !== null}
        title={trashConfirm?.kind === "empty" ? "清空回收站" : "永久删除"}
        onClose={closeTrashConfirm}
        footer={
          <>
            <button className="ghost" onClick={closeTrashConfirm}>
              取消
            </button>
            <button
              className="primary danger"
              onClick={() => {
                const c = trashConfirm;
                closeTrashConfirm();
                if (!c) return;
                if (c.kind === "empty") void emptyTrash();
                else if (c.id) void purgeFromTrash([c.id]);
              }}
            >
              {trashConfirm?.kind === "empty" ? "清空" : "永久删除"}
            </button>
          </>
        }
      >
        {trashConfirm?.kind === "empty" ? (
          <p>确定清空回收站吗？{trashEntries.length} 个项目将被永久删除。</p>
        ) : (
          <p>确定永久删除「{trashConfirm?.name}」吗？</p>
        )}
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
          wallpaper={lockWallpaperProp}
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
