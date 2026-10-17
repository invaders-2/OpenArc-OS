import { defineStore } from "pinia";
import domain from "../../electron/window-domain.cjs";
import manager from "../../electron/window-manager.cjs";
import folderTrashLib from "../../electron/folder-trash.cjs";
import type { WindowCommand, WindowStateModel } from "../../electron/window-domain.cjs";
import { APPS, appById, DOCK_DEFAULT } from "../apps";
import { CURSOR_SIZE_DEFAULT, CURSOR_SIZE_MAX, CURSOR_SIZE_MIN } from "../../src/desktop/cursors";
import {
  WALLPAPER_ID,
  fileUrl as mediaUrl,
  WALLPAPER_STYLE,
  fileUrl,
  kindOfExt,
  wallpaperItemsOf,
  type CustomWallpaper,
  type WallpaperItem,
  type WallpaperStyle,
} from "../wallpapers";

export type GlassMode = "full" | "reduced" | "solid";

/** 快速查看的内容（与既有产品 preview 同形：只认 id，媒体走 openarc-file 流式协议）。 */
export interface ShellPreview {
  name: string;
  ext: string;
  kind: string;
  src?: string;
  text?: string;
}
/** 显示简介（与既有产品 info 同形）。 */
export interface ShellInfo {
  title: string;
  subtitle?: string;
  rows: { k: string; v: string }[];
}
const WEB_IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

/** 通知（壳层本地队列）。来源 app 决定图标；后端事件接入后由 notify() 统一入队。 */
export interface ShellNotice {
  id: string;
  appId: string;
  title: string;
  body: string;
  time: number;
}
export type ThemeMode = "system" | "light" | "dark";

/** 渲染层消费的窗口投影：域对象 `Window` 的只读视图（DOM 只需要这些字段）。 */
export interface ShellWindow {
  id: string;
  appId: string;
  title: string;
  bounds: { x: number; y: number; w: number; h: number };
  /** 层级：与既有窗口域同口径，DOM 上的 zIndex = 10 + z。 */
  z: number;
  visible: boolean;
  maximized: boolean;
}

export interface DesktopFolder {
  id: string;
  name: string;
  x: number;
  y: number;
  parentId?: string;
}

/**
 * 桌面图标的禁入边距与既有产品一致（`src/main.tsx:309`）：顶栏那一条不许压。
 */
export const DESK_BOUND = { top: 52, right: 96, bottom: 140 };

export function clampDeskPos(p: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(innerWidth - DESK_BOUND.right, p.x)),
    y: Math.max(DESK_BOUND.top, Math.min(innerHeight - DESK_BOUND.bottom, p.y)),
  };
}

/**
 * 默认工作区（`src/desktop/useDesktop.ts:58-67` 的 defaultWorkspace 逐字同义）：
 * 首次启动 / 数据不可信 / 新用户给一份可用的空桌面，而不是空屏。
 * meta 必须给，否则窗口标题与顶栏会直接显示 appId（"home"）。
 */
function defaultWorkspace(): WindowStateModel {
  // 10-15：应用中心改为程序坞上方的「应用程序」弹窗，不再是窗口 —— 开机就是干净的桌面。
  return domain.createState() as WindowStateModel;
}

/**
 * 新窗口的默认几何（10-15 按界面原型放大）：原先固定 830×570，在 1440×900 上显得局促。
 * 现在按屏幕取约 75% × 75%（上限 1100×700，下限保持 830×570），逐个错开 24/20px。
 */
/** 各应用的首开尺寸（10-15 取自界面原型 OA.APPS 的 w/h）；没列的走通用尺寸。 */
const APP_SIZE: Record<string, [number, number]> = {
  files: [940, 590], "resource-library": [1080, 680], browser: [1060, 690], canvas: [1140, 730], chat: [1000, 680],
  projects: [1060, 680], skills: [1060, 690], "mcp-center": [1020, 660], market: [1060, 710], automation: [1000, 660],
  organization: [1060, 680], settings: [940, 660], calendar: [1000, 680], weather: [780, 640], music: [940, 620],
  photos: [980, 640], notes: [940, 640], video: [1200, 760], dev: [1200, 740], declare: [860, 600], drama: [1180, 760], protocols: [1120, 720], trash: [880, 580],
  integrations: [1160, 720],
  home: [940, 640],
};
function defaultBounds(index: number, appId?: string) {
  const W = typeof window !== "undefined" ? window.innerWidth : 1440;
  const H = typeof window !== "undefined" ? window.innerHeight : 900;
  const size = appId ? APP_SIZE[appId] : undefined;
  // 底部给程序坞留出 110px：窗口不压到 Dock 上
  const maxH = H - 52 - 110 - 20;
  const w = size ? Math.round(Math.min(size[0], W - 64)) : Math.round(Math.max(830, Math.min(1100, W * 0.75)));
  const h = size ? Math.round(Math.max(420, Math.min(size[1], maxH))) : Math.round(Math.max(480, Math.min(680, H - 52 - 110 - 40)));
  const step = index % 6;
  const y = Math.min(52 + 14 + step * 18, H - 110 - h);
  return {
    x: Math.max(16, Math.round((W - w) / 2) - 60 + step * 24),
    y: Math.max(52, y),
    w,
    h,
  };
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/**
 * 外观持久化键与既有产品**逐字相同**（`src/main.tsx:477-547`）：
 *   oa-theme  跟随系统 / 浅色 / 深色
 *   oa-dark   旧布尔键，保留写入以兼容既有数据（读取优先 oa-theme）
 *   oa-glass  full / reduced / solid
 *   oa-opaque 更旧的"减少透明度"布尔键，只在没有 oa-glass 时当回退
 *   oa-motion 减少动态效果
 */
function initialTheme(): ThemeMode {
  const saved = localStorage.getItem("oa-theme");
  if (saved === "system" || saved === "light" || saved === "dark") return saved;
  const legacy = localStorage.getItem("oa-dark");
  return legacy === null ? "system" : legacy === "true" ? "dark" : "light";
}

function initialGlass(): GlassMode {
  const v = localStorage.getItem("oa-glass");
  if (v === "full" || v === "reduced" || v === "solid") return v;
  return localStorage.getItem("oa-opaque") === "true" ? "solid" : "full";
}

export const useShellStore = defineStore("shell", {
  state: () => ({
    theme: initialTheme(),
    systemDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    glass: initialGlass(),
    reduced: localStorage.getItem("oa-motion") === "true",
    wallpaper: localStorage.getItem("oa-wallpaper") || "theme-dark",
    /** 图标尺寸：范围与默认值逐项对齐既有产品（`src/main.tsx:483-491`）。 */
    dockSize: (() => {
      const v = Number(localStorage.getItem("oa-dock-size"));
      return Number.isFinite(v) && v >= 32 && v <= 80 ? v : 47;
    })(),
    deskIcon: (() => {
      const v = Number(localStorage.getItem("oa-desk-icon"));
      return Number.isFinite(v) && v >= 40 && v <= 96 ? v : 58;
    })(),

    /** 自绘光标：开关（false = 整套退回系统关键字）与尺寸（px）。键与既有产品逐字相同。 */
    cursorCustom: localStorage.getItem("oa-cursor-custom") !== "false",
    cursorSize: (() => {
      const v = Number(localStorage.getItem("oa-cursor-size"));
      return Number.isFinite(v) && v >= CURSOR_SIZE_MIN && v <= CURSOR_SIZE_MAX ? v : CURSOR_SIZE_DEFAULT;
    })(),

    /** 锁屏/登录壁纸独立于桌面：same = 跟随桌面当前壁纸。 */
    lockWallpaper: localStorage.getItem("oa-lock-wallpaper") || "same",
    /** 每张上传壁纸各自的显示方式（key = 存储条目 id）。 */
    wallpaperStyle: readJson<Record<string, WallpaperStyle>>("oa-wallpaper-style", {}),
    /** 上传到 wallpapers 存储文件夹的条目（进设置页时拉一次）。 */
    customWallpapers: [] as CustomWallpaper[],

    /**
     * 外部请求切到「模型 / AI」pane 的递增计数（与 src/main.tsx:476 的 modelSettingsRequest 同义）。
     * 画布页点"打开 OpenArc 总 API 设置"时 +1；画布页本身尚未迁移，这里先保留接线点。
     */
    modelSettingsRequest: 0,

    controlCenterOpen: false,
    searchOpen: false,
    aiOpen: false,
    quickLookOpen: false,
    preview: null as ShellPreview | null,
    /** 回收站是否有东西（程序坞空桶 / 满桶）；文件服务回收站 + 文件夹记录 + 资源库回收站任一非空即为满 */
    trashFull: false,
    info: null as ShellInfo | null,
    notificationsOpen: false,
    /** 应用程序弹窗（10-15，macOS 27 口径：程序坞「应用中心」打开的浮层，取代应用中心窗口）。 */
    appsOpen: false,
    /** 最近打开的应用（弹窗第一行），存本机 oa-recent-apps。 */
    recentLaunch: readJson<string[]>("oa-recent-apps", []).filter((x) => typeof x === "string"),
    /** 通知中心列表（新的在前）与右上角浮动通知（4.5s 自动收起） */
    notices: [] as ShellNotice[],
    toasts: [] as ShellNotice[],
    /** 桌面小组件（日期 / 进行中的任务）显示开关，默认显示 */
    widgets: localStorage.getItem("oa-widgets") !== "false",
    /** 界面缩放（10-15，系统设置 › 外观）：窗口内容的缩放比例，存 oa-ui-scale。浏览器 / 画布窗口不缩放（原生视图几何）。 */
    uiScale: (() => {
      const v = Number(localStorage.getItem("oa-ui-scale"));
      return [0.9, 1, 1.1, 1.2].includes(v) ? v : 1;
    })(),
    /** 专注模式：开启时只进通知中心，不弹浮动通知 */
    focusMode: localStorage.getItem("oa-focus-mode") === "true",

    /**
     * **窗口状态的唯一权威是 electron/window-domain.cjs**（与 React 同一条线）：
     * 这里只持有它的模型，改状态一律派发 window-manager 的命令。
     * 渲染层不再有第二份窗口 state，因此"AI 绕过命令层直接改 state"没有落点。
     */
    model: defaultWorkspace() as WindowStateModel,
    /** 与 `src/desktop/useDesktop.ts:79` 的 host() 同义：原生视图结算要用宿主尺寸。 */
    hostSize: { width: window.innerWidth, height: window.innerHeight },

    /**
     * 程序坞成员与顺序：与既有产品同一个持久化键 oa-dock，读取规则逐条一致
     * （src/main.tsx:502-519：数组即真值；空数组/损坏回默认；旧数据一次性补回收站）。
     */
    dockIds: (() => {
      try {
        const raw: unknown = JSON.parse(localStorage.getItem("oa-dock") || "null");
        if (Array.isArray(raw)) {
          // 已知 = 注册表里的全部应用（可被固定到程序坞），而不只是默认成员
          const known = new Set<string>(APPS.map((x) => x.id));
          const kept = raw.filter((v): v is string => typeof v === "string" && known.has(v));
          if (kept.length) {
            if (!localStorage.getItem("oa-dock-trash") && !kept.includes("trash")) kept.push("trash");
            return kept;
          }
        }
      } catch {
        /* 存储损坏就回默认 */
      }
      return [...DOCK_DEFAULT];
    })(),
    folders: [] as DesktopFolder[],
    desktopIcons: {} as Record<string, { x: number; y: number }>,
    /** 10-16：访达跳转请求（桌面双击文件夹 → 访达打开到该文件夹）；seq 每次 +1 触发 watch。 */
    finderRequest: { folderId: "desktop", seq: 0, pending: false },
  }),
  getters: {
    dark(state): boolean {
      return state.theme === "system" ? state.systemDark : state.theme === "dark";
    },
    /** 壳根上的内联结构变量：既有产品同样写在 `.desktop` 的 style 上（src/main.tsx:3282）。 */
    rootStyle(state): Record<string, string> {
      return { "--dock-icon": state.dockSize + "px", "--desk-icon": state.deskIcon + "px", "--ui-zoom": String(state.uiScale) };
    },
    anyOverlay(state): boolean {
      return (
        state.controlCenterOpen ||
        state.searchOpen ||
        state.quickLookOpen ||
        state.aiOpen ||
        state.notificationsOpen ||
        state.appsOpen
      );
    },
    /** 壁纸选择器全集：内置主题色在前，上传的在后（与既有产品同序）。 */
    wallpaperItems(state): WallpaperItem[] {
      return wallpaperItemsOf(state.customWallpapers);
    },
    /** 域的 `windows` 是稳定创建序（DOM 节点顺序），z/visible 都是它的投影。 */
    windows(state): ShellWindow[] {
      return state.model.windows.map((w) => ({
        id: w.id,
        appId: w.appId,
        title: w.meta.title,
        bounds: w.bounds,
        z: w.z,
        visible: w.visible,
        maximized: w.state === domain.WSTATE.MAXIMIZED,
      }));
    },
    focusedWindowId(state): string | null {
      return state.model.focused;
    },
    focusedWindow(state): ShellWindow | null {
      return this.windows.find((w) => w.id === state.model.focused) ?? null;
    },
    /** 与 `src/main.tsx:1808-1818` 同义：一个 App 一个图标，保留最新的那个窗口。 */
    recentApps(state): { id: string; title: string; appId: string }[] {
      const seen = new Set<string>();
      const out: { id: string; title: string; appId: string }[] = [];
      for (const w of [...state.model.windows].reverse()) {
        if (seen.has(w.appId)) continue;
        seen.add(w.appId);
        out.push({ id: w.id, title: w.meta.title, appId: w.appId });
      }
      return out;
    },
    runningApps(state): Set<string> {
      return new Set(state.model.windows.map((w) => w.appId));
    },
    dockApps(state): typeof APPS {
      return state.dockIds
        .map((id: string) => APPS.find((a) => a.id === id))
        .filter((a): a is (typeof APPS)[number] => a !== undefined);
    },
    /** 回收站是系统级固定槽位（程序坞分隔线右侧），不参与排序。 */
    mainDockApps(): typeof APPS {
      return this.dockApps.filter((a) => a.id !== "trash");
    },
    trashApp(): (typeof APPS)[number] | null {
      return this.dockApps.find((a) => a.id === "trash") ?? null;
    },
    /** 桌面上的文件夹：与既有产品同一条规则 —— 只画顶层（`src/main.tsx:3420`）。 */
    desktopFolders(state): DesktopFolder[] {
      return state.folders.filter((f) => !f.parentId);
    },
  },
  actions: {
    /** 唯一的窗口状态写入口：与 React 共用 electron/window-manager.cjs 的 reduce。 */
    dispatch(command: WindowCommand) {
      const next = manager.reduce(this.model, command);
      if (next !== this.model) this.model = next;
    },

    /**
     * 宿主尺寸变化 → 重新收拢（`src/desktop/useDesktop.ts:152-171` 同一条路径）。
     * 不 reflow，窗口被拖出可见区后用户既抓不到也关不掉。
     */
    watchHostSize() {
      const reflow = () => {
        const size = { width: window.innerWidth, height: window.innerHeight };
        this.hostSize = size;
        this.dispatch({ type: "system/reflow", areas: [manager.areaOf(size)], host: size });
      };
      window.addEventListener("resize", reflow);
      window.openarc?.onDisplay?.(() => reflow());
    },

    /** 跟随系统：只在用户没显式选过浅/深时生效。 */
    watchSystemTheme() {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const on = (e: MediaQueryListEvent) => {
        this.systemDark = e.matches;
      };
      mq.addEventListener("change", on);
      return () => mq.removeEventListener("change", on);
    },
    setTheme(next: ThemeMode) {
      this.theme = next;
      localStorage.setItem("oa-theme", next);
      localStorage.setItem("oa-dark", String(this.dark));
    },
    setGlass(next: GlassMode) {
      this.glass = next;
      localStorage.setItem("oa-glass", next);
    },
    setReduced(next: boolean) {
      this.reduced = next;
      localStorage.setItem("oa-motion", String(next));
    },
    setWallpaper(next: string) {
      this.wallpaper = next;
      localStorage.setItem("oa-wallpaper", next);
    },

    toggleControlCenter() {
      this.controlCenterOpen = !this.controlCenterOpen;
      if (this.controlCenterOpen) {
        this.searchOpen = false;
        this.notificationsOpen = false;
      }
    },
    toggleNotifications() {
      this.notificationsOpen = !this.notificationsOpen;
      if (this.notificationsOpen) {
        this.controlCenterOpen = false;
        this.searchOpen = false;
      }
    },
    closeNotifications() {
      this.notificationsOpen = false;
    },
    /** 入队一条通知：进通知中心；非专注模式下同时弹一条浮动通知。 */
    notify(n: { appId: string; title: string; body?: string }) {
      const item: ShellNotice = {
        id: Math.random().toString(36).slice(2, 10),
        appId: n.appId,
        title: n.title,
        body: n.body || "",
        time: Date.now(),
      };
      this.notices.unshift(item);
      if (this.notices.length > 50) this.notices.length = 50;
      if (this.focusMode) return;
      this.toasts.push(item);
      window.setTimeout(() => this.dismissToast(item.id), 4500);
    },
    dismissToast(id: string) {
      const i = this.toasts.findIndex((t) => t.id === id);
      if (i >= 0) this.toasts.splice(i, 1);
    },
    clearNotices() {
      this.notices.splice(0);
    },
    setFocusMode(next: boolean) {
      this.focusMode = next;
      localStorage.setItem("oa-focus-mode", String(next));
    },
    closeControlCenter() {
      this.controlCenterOpen = false;
    },
    toggleSearch() {
      this.searchOpen = !this.searchOpen;
      if (this.searchOpen) {
        this.controlCenterOpen = false;
        this.notificationsOpen = false;
      }
    },
    closeSearch() {
      this.searchOpen = false;
    },
    /** 画布页的模型引导入口（外部请求）；调用方随后 activateApp("settings")。 */
    requestModelSettings() {
      this.modelSettingsRequest += 1;
    },
    toggleAI() {
      this.aiOpen = !this.aiOpen;
    },
    closeAI() {
      this.aiOpen = false;
    },
    openQuickLook() {
      this.quickLookOpen = true;
    },
    /**
     * 打开快速查看（对齐 src/main.tsx:820 openPreview）：图片/视频/音频走流式协议，
     * 浏览器渲染不了的图片向主进程要 1024 位图，其余读回文本。没有文件桥时什么也不做。
     */
    async openPreview(folderId: string, entry: { id: string; name: string; ext?: string }) {
      const bridge = typeof window !== "undefined" ? window.openarc?.files : undefined;
      if (!bridge) return;
      const ext = (entry.ext ?? "").toLowerCase();
      const kind = kindOfExt(ext);
      this.info = null;
      if (kind === "image" || kind === "video" || kind === "audio") {
        if (kind === "image" && !WEB_IMAGE_EXTS.includes(ext)) {
          const big = await bridge.thumb?.(folderId, entry.id, 1024);
          this.preview = big?.ok && big.dataUrl
            ? { name: entry.name, ext, kind: "image", src: big.dataUrl }
            : { name: entry.name, ext, kind: "other" };
        } else {
          this.preview = { name: entry.name, ext, kind, src: mediaUrl(folderId, entry.id) };
        }
      } else {
        const res = await bridge.read?.(folderId, entry.id);
        this.preview = {
          name: entry.name,
          ext,
          kind: String(res?.kind ?? "other"),
          src: res?.dataUrl,
          text: res?.text,
        };
      }
      this.quickLookOpen = true;
    },
    showInfo(info: ShellInfo) {
      this.preview = null;
      this.info = info;
      this.quickLookOpen = true;
    },
    closeQuickLook() {
      this.quickLookOpen = false;
      this.preview = null;
      this.info = null;
    },
    closeAllOverlays() {
      this.controlCenterOpen = false;
      this.searchOpen = false;
      this.quickLookOpen = false;
      this.aiOpen = false;
      this.notificationsOpen = false;
      this.appsOpen = false;
    },
    /** Esc / 点遮罩：只关最上面那一层（层序与既有产品一致：QuickLook > AI > 控制中心 > 搜索）。 */
    closeTopOverlay() {
      if (this.appsOpen) this.appsOpen = false;
      else if (this.quickLookOpen) this.quickLookOpen = false;
      else if (this.aiOpen) this.aiOpen = false;
      else if (this.controlCenterOpen) this.controlCenterOpen = false;
      else if (this.notificationsOpen) this.notificationsOpen = false;
      else if (this.searchOpen) this.searchOpen = false;
    },

    focusWindow(id: string) {
      this.dispatch({ type: "window/focus", id });
    },
    /**
     * 启动 / 唤起到前台一个 App（`src/main.tsx:1687-1706` 的 activateApp 逐条对齐）：
     * 点 Dock = 聚焦最近的窗口；全部最小化时先恢复；一个窗口都没有才新建。
     */
    /** 程序坞「应用中心」：打开 / 收起应用程序弹窗（其它浮层同时收起）。 */
    toggleApps() {
      const next = !this.appsOpen;
      this.closeAllOverlays();
      this.appsOpen = next;
    },
    activateApp(appId: string) {
      // 应用中心不再是窗口，而是程序坞上方的应用程序弹窗
      if (appId === "home") {
        this.toggleApps();
        return;
      }
      this.recentLaunch = [appId, ...this.recentLaunch.filter((x: string) => x !== appId)].slice(0, 7);
      try {
        localStorage.setItem("oa-recent-apps", JSON.stringify(this.recentLaunch));
      } catch {
        /* 存储不可用 */
      }
      const mine = domain.windowsOfApp(this.model, appId);
      const visibleId = [...mine].reverse().find((id) => domain.byId(this.model, id)?.state !== domain.WSTATE.MINIMIZED);
      const topId = mine[mine.length - 1];
      if (visibleId) this.dispatch({ type: "window/focus", id: visibleId });
      else if (topId) this.dispatch({ type: "window/restore", id: topId });
      else {
        const app = appById(appId);
        this.dispatch({
          type: "window/open",
          appId,
          bounds: defaultBounds(this.model.windows.length, appId),
          meta: { title: app?.name || appId, icon: app?.icon || "apps" },
        });
      }
      this.closeAllOverlays();
    },
    /** 应用目录「添加到 / 移出程序坞」：写回同一个持久化键 oa-dock（回收站固定在末尾，不可移出）。 */
    toggleDock(appId: string) {
      if (appId === "trash") return;
      const has = this.dockIds.includes(appId);
      const next = has ? this.dockIds.filter((id: string) => id !== appId) : [...this.dockIds.filter((id: string) => id !== "trash"), appId, "trash"];
      this.dockIds = next;
      try {
        localStorage.setItem("oa-dock", JSON.stringify(next));
      } catch {
        /* 存储不可用：本次会话内仍生效 */
      }
    },
    setDockSize(px: number) {
      if (!Number.isFinite(px) || px < 32 || px > 80) return;
      this.dockSize = px;
      localStorage.setItem("oa-dock-size", String(px));
    },
    setDeskIconSize(px: number) {
      if (!Number.isFinite(px) || px < 40 || px > 96) return;
      this.deskIcon = px;
      localStorage.setItem("oa-desk-icon", String(px));
    },
    setCursorCustom(next: boolean) {
      this.cursorCustom = next;
      localStorage.setItem("oa-cursor-custom", String(next));
    },
    setCursorSize(px: number) {
      if (!Number.isFinite(px) || px < CURSOR_SIZE_MIN || px > CURSOR_SIZE_MAX) return;
      this.cursorSize = px;
      localStorage.setItem("oa-cursor-size", String(px));
    },
    setLockWallpaper(next: string) {
      this.lockWallpaper = next;
      localStorage.setItem("oa-lock-wallpaper", next);
    },
    /** 改画法不动原图（与 src/main.tsx:974 的 patchStyle 同义）。 */
    patchWallpaperStyle(id: string, patch: Partial<WallpaperStyle>) {
      this.wallpaperStyle = {
        ...this.wallpaperStyle,
        [id]: { ...WALLPAPER_STYLE, ...this.wallpaperStyle[id], ...patch },
      };
      localStorage.setItem("oa-wallpaper-style", JSON.stringify(this.wallpaperStyle));
    },

    // ── 壁纸存储：真实走 openarc.files（文件 IPC），不伪造条目 ────────────────
    async refreshWallpapers() {
      const bridge = typeof window !== "undefined" ? window.openarc?.files : undefined;
      if (!bridge?.list) return;
      try {
        const res = await bridge.list(WALLPAPER_ID);
        if (res && res.ok && Array.isArray(res.entries)) {
          this.customWallpapers = res.entries.map((e) => ({ id: e.id, name: e.name, ext: e.ext }));
        }
      } catch {
        /* 主进程不可用时保持原样 */
      }
    },
    /** 上传壁纸：拷进 wallpapers 存储文件夹，然后设为当前壁纸（desktop 或锁屏）。 */
    async uploadWallpaper(file: File | undefined, target: "desktop" | "lock") {
      const bridge = typeof window !== "undefined" ? window.openarc?.files : undefined;
      if (!file || !bridge?.pathFor || !bridge?.import) return;
      const p = bridge.pathFor(file);
      if (!p) return;
      const res = await bridge.import(WALLPAPER_ID, [p]);
      await this.refreshWallpapers();
      const added = res?.added?.[res.added.length - 1];
      if (!added) return;
      if (target === "desktop") this.setWallpaper("custom:" + added.id);
      else this.setLockWallpaper("custom:" + added.id);
    },
    /**
     * 替换上传的壁纸：新图先入库，**显示设置跟着搬到新条目**，再删掉旧条目 ——
     * 对用户来说就是"同一张壁纸换了张图"，位置与大小不变（src/main.tsx:1017 同义）。
     */
    async replaceWallpaper(file: File | undefined, targetId: string) {
      const bridge = typeof window !== "undefined" ? window.openarc?.files : undefined;
      if (!file || !bridge?.pathFor || !bridge?.import || !bridge?.remove) return;
      const p = bridge.pathFor(file);
      if (!p) return;
      const res = await bridge.import(WALLPAPER_ID, [p]);
      const added = res?.added?.[res.added.length - 1];
      if (!added) return;
      if (targetId in this.wallpaperStyle) {
        const next = { ...this.wallpaperStyle };
        next[added.id] = next[targetId];
        delete next[targetId];
        this.wallpaperStyle = next;
        localStorage.setItem("oa-wallpaper-style", JSON.stringify(next));
      }
      if (this.wallpaper === "custom:" + targetId) this.setWallpaper("custom:" + added.id);
      if (this.lockWallpaper === "custom:" + targetId) this.setLockWallpaper("custom:" + added.id);
      await bridge.remove(WALLPAPER_ID, targetId);
      await this.refreshWallpapers();
    },
    /** 删除自定义壁纸（真实删存储条目）；删掉的正好是当前壁纸就退回内置深色。 */
    async deleteWallpaper(entryId: string) {
      const bridge = typeof window !== "undefined" ? window.openarc?.files : undefined;
      if (!bridge?.remove) return;
      await bridge.remove(WALLPAPER_ID, entryId);
      if (entryId in this.wallpaperStyle) {
        const next = { ...this.wallpaperStyle };
        delete next[entryId];
        this.wallpaperStyle = next;
        localStorage.setItem("oa-wallpaper-style", JSON.stringify(next));
      }
      await this.refreshWallpapers();
      if (this.wallpaper === "custom:" + entryId) this.setWallpaper("theme-dark");
      if (this.lockWallpaper === "custom:" + entryId) this.setLockWallpaper("same");
    },
    /** 锁屏/登录要用的壁纸：same 跟随桌面；custom 条目解析成纯数据（与 main.tsx:963 同义）。 */
    resolveLockWallpaper(): { id: string; src?: string; kind?: "image" | "video"; style?: WallpaperStyle } {
      const effective = this.lockWallpaper === "same" ? this.wallpaper : this.lockWallpaper;
      if (!effective.startsWith("custom:")) return { id: effective };
      const entry = this.customWallpapers.find((e) => e.id === effective.slice(7));
      if (!entry) return { id: effective };
      return {
        id: effective,
        src: fileUrl(WALLPAPER_ID, entry.id),
        kind: kindOfExt(entry.ext) === "video" ? "video" : "image",
        style: this.wallpaperStyle[entry.id] ?? WALLPAPER_STYLE,
      };
    },
    closeWindow(id: string) {
      this.dispatch({ type: "window/close", id });
    },
    minimizeWindow(id: string) {
      this.dispatch({ type: "window/minimize", id });
    },
    toggleMaximize(id: string) {
      const w = domain.byId(this.model, id);
      if (!w) return;
      if (w.state === domain.WSTATE.MAXIMIZED) this.dispatch({ type: "window/unmaximize", id });
      else this.dispatch({ type: "window/maximize", id, host: this.hostSize });
    },

    // ── 桌面图标位置：与既有产品同一个持久化键 `oa-desktop-icons` ──────────────
    loadDesktopState() {
      const folders = readJson<unknown>("oa-folders", []);
      this.folders = Array.isArray(folders)
        ? (folders as DesktopFolder[]).map((f) => ({
            ...f,
            ...clampDeskPos({ x: f?.x ?? 0, y: f?.y ?? 0 }),
          }))
        : [];
      const icons = readJson<unknown>("oa-desktop-icons", {});
      this.desktopIcons =
        icons && typeof icons === "object"
          ? Object.fromEntries(
              Object.entries(icons as Record<string, { x: number; y: number }>).map(([k, v]) => [
                k,
                clampDeskPos({ x: v?.x ?? 0, y: v?.y ?? 0 }),
              ]),
            )
          : {};
    },
    persistFolders() {
      localStorage.setItem("oa-folders", JSON.stringify(this.folders));
    },
    /** 在访达里打开某个文件夹（桌面双击 / 右键「打开」）。 */
    openFolder(folderId: string) {
      this.finderRequest = { folderId, seq: this.finderRequest.seq + 1, pending: true };
      this.activateApp("files");
    },
    /** 桌面文件图标位置（与 React 同一个键 oa-desktop-icons）。 */
    setIconPos(id: string, pos: { x: number; y: number }) {
      this.desktopIcons = { ...this.desktopIcons, [id]: clampDeskPos(pos) };
      try {
        localStorage.setItem("oa-desktop-icons", JSON.stringify(this.desktopIcons));
      } catch {
        /* 存储不可用 */
      }
    },
    setFolderPos(id: string, pos: { x: number; y: number }) {
      const folder = this.folders.find((f) => f.id === id);
      if (!folder) return;
      const next = clampDeskPos(pos);
      folder.x = next.x;
      folder.y = next.y;
      this.persistFolders();
    },
    /** 应用专属文件夹（如「文稿」）：按名字找桌面顶层文件夹，没有就在桌面右上栅格旁建一个。 */
    ensureFolder(name: string): DesktopFolder {
      const hit = this.folders.find((f) => !f.parentId && f.name === name);
      if (hit) return hit;
      const folder: DesktopFolder = {
        id: "f" + Date.now().toString(36),
        name,
        ...clampDeskPos({ x: window.innerWidth - 220, y: 64 + (this.folders.filter((f) => !f.parentId).length % 6) * 104 }),
      };
      this.folders.push(folder);
      this.persistFolders();
      return folder;
    },
    /** 桌面右键「新建文件夹」：落在指针处，命名规则与既有产品 createFolder（src/main.tsx:3199）一致。 */
    createFolder(x: number, y: number): DesktopFolder {
      const used = new Set(this.folders.map((f) => f.name));
      let name = "新建文件夹";
      for (let i = 2; used.has(name); i += 1) name = `新建文件夹 ${i}`;
      const folder: DesktopFolder = {
        id: "f" + Date.now().toString(36),
        name,
        ...clampDeskPos({ x: Math.round(x), y: Math.round(y) }),
      };
      this.folders.push(folder);
      this.persistFolders();
      return folder;
    },
    /** 桌面右键「整理」：桌面文件夹按名称依次落进右上角起的栅格（与既有产品同一套栅格）。 */
    arrangeFolders(place: (index: number) => { x: number; y: number }) {
      const top = this.folders
        .filter((f) => !f.parentId)
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
      top.forEach((f, i) => Object.assign(f, place(i)));
      this.persistFolders();
    },
    /** 访达里的子文件夹（parentId 指向所在文件夹；桌面根目录的 parentId 为空）。 */
    createSubfolder(parentId: string): DesktopFolder {
      const used = new Set(this.folders.filter((f) => (f.parentId ?? "desktop") === parentId).map((f) => f.name));
      let name = "新建文件夹";
      for (let i = 2; used.has(name); i += 1) name = `新建文件夹 ${i}`;
      const folder: DesktopFolder =
        parentId === "desktop"
          ? { id: "f" + Date.now().toString(36), name, ...clampDeskPos({ x: innerWidth - 120, y: 60 }) }
          : { id: "f" + Date.now().toString(36), name, x: 0, y: 0, parentId };
      this.folders.push(folder);
      this.persistFolders();
      return folder;
    },
    /**
     * 删除文件夹 = 整棵子树软删除进系统回收站（对齐 src/main.tsx:3223 removeFolder）：
     * 元数据记入 oa-folder-trash，子树里的真实文件以同一 groupId 进文件服务回收站，恢复时整组回原位。
     */
    async removeFolder(id: string) {
      const subtree = folderTrashLib.collectSubtree(this.folders, id);
      if (!subtree.length) return;
      const groupId = "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const record = folderTrashLib.buildFolderTrashRecord({ folders: this.folders, rootId: id, groupId });
      if (record) {
        const list = readJson<unknown[]>("oa-folder-trash", []);
        localStorage.setItem("oa-folder-trash", JSON.stringify([...(Array.isArray(list) ? list : []), record]));
      }
      const bridge = typeof window !== "undefined" ? window.openarc?.files : undefined;
      if (bridge?.trash) {
        for (const f of subtree) {
          const listed = await bridge.list(f.id);
          for (const e of listed?.entries ?? []) await bridge.trash(f.id, e.id, groupId);
        }
      }
      const doomed = new Set(subtree.map((f) => f.id));
      this.folders = this.folders.filter((f) => !doomed.has(f.id));
      this.persistFolders();
      this.trashFull = true;
    },
    /**
     * 把一批条目移进目标文件夹（对齐 src/main.tsx:1524 moveInto）：
     * 文件走文件服务 move；子文件夹改 parentId，并做环检测（不能移进自己或自己的子孙）。
     */
    async moveInto(toFolderId: string, srcFolderId: string, ids: string[]) {
      if (toFolderId === srcFolderId) return;
      const isFolder = (x: string) => this.folders.some((f) => f.id === x);
      const fileIds = ids.filter((x) => !isFolder(x));
      const folderIds = ids.filter(isFolder);
      const bridge = typeof window !== "undefined" ? window.openarc?.files : undefined;
      if (fileIds.length && bridge?.move) await bridge.move(srcFolderId, fileIds, toFolderId);
      for (const f of this.folders) {
        if (!folderIds.includes(f.id)) continue;
        let cur: string | undefined = toFolderId;
        let cycle = false;
        while (cur) {
          if (cur === f.id) {
            cycle = true;
            break;
          }
          cur = this.folders.find((x) => x.id === cur)?.parentId;
        }
        if (cycle) continue;
        if (toFolderId === "desktop") {
          delete f.parentId;
          Object.assign(f, clampDeskPos({ x: innerWidth - 120, y: 60 }));
        } else f.parentId = toFolderId;
      }
      this.persistFolders();
    },
    /** 刷新程序坞的空桶 / 满桶状态（删除、恢复、清空之后都调一次）。 */
    async refreshTrashState() {
      const folderRecs = readJson<unknown[]>("oa-folder-trash", []);
      if (Array.isArray(folderRecs) && folderRecs.length) {
        this.trashFull = true;
        return;
      }
      const bridge = typeof window !== "undefined" ? window.openarc?.files : undefined;
      try {
        const res = await bridge?.trashList?.();
        this.trashFull = !!res?.entries?.length;
      } catch {
        /* 主进程不可用：保持原样 */
      }
    },
    renameFolder(id: string, name: string) {
      const folder = this.folders.find((f) => f.id === id);
      const next = name.trim();
      if (!folder || !next) return;
      folder.name = next;
      this.persistFolders();
    },
    setUiScale(next: number) {
      this.uiScale = next;
      try {
        localStorage.setItem("oa-ui-scale", String(next));
      } catch {
        /* 存储不可用 */
      }
    },
    setWidgets(next: boolean) {
      this.widgets = next;
      localStorage.setItem("oa-widgets", String(next));
    },
  },
});
