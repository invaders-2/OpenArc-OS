/**
 * 壁纸 / 桌面文件的共享常量与纯函数。
 *
 * 取值与既有产品逐项一致（src/main.tsx:288-346）：
 *   WALLPAPERS  内置主题色只有两种（浅色 / 深色），其余预设与动态 Aurora 已删
 *   WALLPAPER_ID / DESKTOP_ID  真实存储文件夹 id
 *   WALLPAPER_STYLE  上传壁纸默认画法（填充 / 100% / 不偏移）
 *   WALLPAPER_ROW  选择器默认只铺一排 5 张，第 6 张起由「查看更多」展开
 *   fileUrl()  openarc-file://media/<folderId>/<id>（CSP 已允许该协议）
 *   kindOfExt()  与既有产品同一份 FILE_KINDS 表
 */
export type WallpaperFit = "cover" | "contain" | "fill";
export type WallpaperStyle = { fit: WallpaperFit; zoom: number; x: number; y: number };

export const WALLPAPER_STYLE: WallpaperStyle = { fit: "cover", zoom: 1, x: 0, y: 0 };

export const WALLPAPERS = [
  { id: "theme-light", name: "浅色主题色" },
  { id: "theme-dark", name: "深色主题色" },
] as const;

export const WALLPAPER_ID = "wallpapers";
export const DESKTOP_ID = "desktop";
export const WALLPAPER_ROW = 5;

export const fileUrl = (folderId: string, id: string) =>
  "openarc-file://media/" + encodeURIComponent(folderId) + "/" + encodeURIComponent(id);

const FILE_KINDS: Record<string, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "svg", "tif", "tiff", "avif", "ai", "psd", "eps"],
  video: ["mp4", "mov", "m4v", "avi", "mkv", "webm"],
  audio: ["mp3", "wav", "aac", "flac", "m4a", "ogg"],
  doc: ["pdf", "doc", "docx", "pages", "rtf", "pad", "txt", "md"],
  text: ["txt", "md", "json", "csv", "log", "ts", "tsx", "js", "jsx", "css", "html", "yml", "yaml", "xml"],
  archive: ["zip", "tar", "gz", "rar", "7z"],
};

export const kindOfExt = (ext: string) =>
  Object.keys(FILE_KINDS).find((k) => FILE_KINDS[k].includes(ext)) ?? "other";

export type CustomWallpaper = { id: string; name: string; ext: string };
export type WallpaperItem = { kind: "preset" | "custom"; id: string; name: string; ext: string };

export const wallpaperItemsOf = (custom: readonly CustomWallpaper[]): WallpaperItem[] => [
  ...WALLPAPERS.map((wp) => ({ kind: "preset" as const, id: wp.id, name: wp.name, ext: "" })),
  ...custom.map((e) => ({ kind: "custom" as const, id: e.id, name: e.name, ext: e.ext })),
];
