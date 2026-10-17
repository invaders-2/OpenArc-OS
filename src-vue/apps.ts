import type { Component } from "vue";
import { locale } from "./i18n";
import {
  Compass,
  Folder,
  LayoutGrid,
  PenTool,
  Puzzle,
  Settings,
} from "lucide-vue-next";

/**
 * 应用注册表 —— 与既有产品 `src/main.tsx:350` 的 `apps` **逐项一致**（id / name / icon）。
 * 图标名是 `public/icons/<icon>.png` 的彩色身份图标，不是线性图标：
 * 程序坞条目必须与既有产品同源，否则一眼就能看出是两套壳。
 */
export interface AppEntry {
  id: string;
  name: string;
  icon: string;
  /**
   * 随包内置版本（当前 OpenArc OS 构建里编译进来的应用代码版本）。
   * 取值依据：本期所有内置应用与 package.json 的构建版本对齐（0.1.0）；画布已单独发过包
   * （dist-updates/canvas-0.1.0.zip），内置版本同样从 0.1.0 起算。此后按应用各自的发布节奏递增。
   * 与后端 electron/market-update-domain.cjs 的 APP_BUILTIN_VERSIONS 必须逐项一致
   * （tests/dxos-market-all-apps.test.mjs 强制核对）。
   */
  version: string;
}

export const APPS: readonly AppEntry[] = [
  { id: "home", name: "应用中心", icon: "apps", version: "0.1.0" },
  { id: "browser", name: "浏览器", icon: "safari", version: "0.1.0" },
  { id: "files", name: "访达", icon: "finder", version: "0.1.0" },
  { id: "resource-library", name: "资源库", icon: "finder", version: "0.1.0" },
  { id: "canvas", name: "AI Studio", icon: "freeform", version: "0.1.0" },
  { id: "projects", name: "项目", icon: "folder", version: "0.1.0" },
  { id: "organization", name: "组织", icon: "settings", version: "0.1.0" },
  { id: "skills", name: "Skill 中心", icon: "shortcuts", version: "0.1.0" },
  { id: "mcp-center", name: "MCP 中心", icon: "sharing", version: "0.1.0" },
  // 0.6.1：第三方集成入口（领星 / 紫鸟 / 钉钉 / 夸克 / 天气 / 黄历等可选插件）。
  // 图标复用随包的 sharing 身份图标：本批只允许改 src-vue / src/types，不新增 public 资产。
  { id: "integrations", name: "第三方集成", icon: "sharing", version: "0.1.0" },
  // 10-16：协议中心（模型 / 供应商协议，原「模型与服务商 › 协议」标签独立成应用）
  { id: "protocols", name: "协议中心", icon: "protocols", version: "0.1.0" },
  { id: "settings", name: "系统设置", icon: "settings", version: "0.1.0" },
  { id: "trash", name: "回收站", icon: "trash", version: "0.1.0" },
  // ── 10-15 按界面原型补齐的应用（后台未接入的先显示真实空态，不放演示数据）──
  { id: "chat", name: "对话", icon: "messages", version: "0.1.0" },
  { id: "automation", name: "自动化", icon: "clock", version: "0.1.0" },
  { id: "market", name: "应用市场", icon: "app-store", version: "0.1.0" },
  { id: "calendar", name: "日历", icon: "calendar", version: "0.1.0" },
  { id: "notes", name: "文稿", icon: "text-editor", version: "0.1.0" },
  { id: "photos", name: "相册", icon: "photos", version: "0.1.0" },
  { id: "music", name: "音乐", icon: "music", version: "0.1.0" },
  { id: "weather", name: "天气", icon: "weather", version: "0.1.0" },
  { id: "video", name: "视频剪辑", icon: "video", version: "0.1.0" },
  { id: "dev", name: "开发者", icon: "terminal", version: "0.1.0" },
  { id: "declare", name: "图片声明", icon: "image-tag", version: "0.1.0" },
  // 10-16 对齐 DX OS「视频工坊」：剧本 → 视觉设定 → 分镜 → 出图 → 成片（media/short-drama/*）
  { id: "drama", name: "短剧工坊", icon: "drama", version: "0.1.0" },
];

/**
 * 程序坞默认成员与顺序：既有 11 项（与 `src/main.tsx:369` 的 DOCK_DEFAULT 同义）+ 原型里常驻的「对话」。
 * 其余新应用只出现在应用中心与聚焦搜索里，不默认占程序坞。
 */
export const DOCK_DEFAULT: readonly string[] = [
  "home", "browser", "files", "resource-library", "canvas", "chat", "projects",
  "organization", "skills", "mcp-center", "settings", "trash",
];

export const appById = (id: string): AppEntry | undefined => APPS.find((a) => a.id === id);

/**
 * 0.6.1 · 应用显示名（英文界面）。
 * 注册表里的 name 仍是中文源语言（与既有产品逐项一致，tests/dxos-market-all-apps 也按该行解析）；
 * 英文只在渲染层通过这里覆盖，不改数据、不影响市场/更新用的 appId。
 */
const APP_NAME_EN: Record<string, string> = {
  home: "App Center",
  browser: "Browser",
  files: "Finder",
  "resource-library": "Resource Library",
  canvas: "AI Studio",
  projects: "Projects",
  organization: "Organization",
  skills: "Skill Center",
  "mcp-center": "MCP Center",
  integrations: "Integrations",
  protocols: "Protocols",
  settings: "System Settings",
  trash: "Trash",
  chat: "Chat",
  automation: "Automation",
  market: "App Store",
  calendar: "Calendar",
  notes: "Notes",
  photos: "Photos",
  music: "Music",
  weather: "Weather",
  video: "Video Editor",
  dev: "Developer",
  declare: "Image Declaration",
  drama: "Short Drama Studio",
};

/** 当前语言的显示名；没有英文条目时回退注册表 name。 */
export function appDisplayName(entry: AppEntry | undefined): string {
  if (!entry) return "";
  return locale.value === "en-US" ? APP_NAME_EN[entry.id] ?? entry.name : entry.name;
}

/** 按 appId 取显示名（窗口标题 / 通知 / 搜索共用）。 */
export function appDisplayNameById(id: string): string {
  return appDisplayName(appById(id));
}

/** 图标地址：与既有产品一致的相对路径（dev 下由 Vite 服务 public/）。 */
export const iconUrl = (name: string): string => "./icons/" + name + ".png";

/**
 * 顶栏"最近应用"的线性图标，逐项对齐 `src/components.tsx:56` 的 `appLineIcon`。
 * 顶栏统一线性、应用身份保持彩色 —— 这是既有产品的既定分工，不是我们新定的规则。
 */
export const APP_LINE_ICON: Record<string, Component> = {
  home: LayoutGrid,
  browser: Compass,
  files: Folder,
  canvas: PenTool,
  skills: Puzzle,
  settings: Settings,
};

export const lineIconFor = (appId: string): Component => APP_LINE_ICON[appId] ?? LayoutGrid;

/** 应用分类（应用程序弹窗的分类条与应用市场共用口径）。没列的归「其他」。 */
export const APP_CATEGORY: Record<string, string> = {
  files: "系统", trash: "系统", settings: "系统", dev: "系统",
  integrations: "团队与资源",
  canvas: "创作", photos: "创作", music: "创作", notes: "创作", video: "创作", declare: "创作", drama: "创作",
  chat: "效率", automation: "效率", calendar: "效率", weather: "效率", browser: "效率", market: "效率",
  projects: "团队与资源", organization: "团队与资源", "resource-library": "团队与资源", skills: "团队与资源", "mcp-center": "团队与资源", protocols: "团队与资源",
};
export const APP_CATEGORIES = ["效率", "创作", "团队与资源", "系统"];
