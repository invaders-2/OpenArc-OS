import type { Component } from "vue";
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
}

export const APPS: readonly AppEntry[] = [
  { id: "home", name: "应用中心", icon: "apps" },
  { id: "browser", name: "浏览器", icon: "safari" },
  { id: "files", name: "访达", icon: "finder" },
  { id: "resource-library", name: "资源库", icon: "finder" },
  { id: "canvas", name: "AI Studio", icon: "freeform" },
  { id: "projects", name: "项目", icon: "folder" },
  { id: "organization", name: "组织治理", icon: "settings" },
  { id: "skills", name: "Skill 中心", icon: "shortcuts" },
  { id: "mcp-center", name: "MCP 中心", icon: "sharing" },
  { id: "settings", name: "系统设置", icon: "settings" },
  { id: "trash", name: "回收站", icon: "trash" },
  // ── 10-15 按界面原型补齐的应用（后台未接入的先显示真实空态，不放演示数据）──
  { id: "chat", name: "对话", icon: "messages" },
  { id: "automation", name: "自动化", icon: "clock" },
  { id: "market", name: "应用市场", icon: "app-store" },
  { id: "calendar", name: "日历", icon: "calendar" },
  { id: "notes", name: "文稿", icon: "text-editor" },
  { id: "photos", name: "相册", icon: "photos" },
  { id: "music", name: "音乐", icon: "music" },
  { id: "weather", name: "天气", icon: "weather" },
  { id: "video", name: "视频剪辑", icon: "video" },
  { id: "dev", name: "开发者", icon: "terminal" },
  { id: "declare", name: "图片声明", icon: "image-tag" },
  // 10-16 对齐 DX OS「视频工坊」：剧本 → 视觉设定 → 分镜 → 出图 → 成片（media/short-drama/*）
  { id: "drama", name: "短剧工坊", icon: "drama" },
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
  canvas: "创作", photos: "创作", music: "创作", notes: "创作", video: "创作", declare: "创作", drama: "创作",
  chat: "效率", automation: "效率", calendar: "效率", weather: "效率", browser: "效率", market: "效率",
  projects: "团队与资源", organization: "团队与资源", "resource-library": "团队与资源", skills: "团队与资源", "mcp-center": "团队与资源",
};
export const APP_CATEGORIES = ["效率", "创作", "团队与资源", "系统"];
