/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/**
 * 渲染进程桥（electron/preload.cjs）里**壳层真的用到的那几条**。
 * 完整声明在 src/main.tsx 的 declare global 里；Vue 入口不 import 那个文件，
 * 因此这里按 preload 的实际形状重新声明一次，不多不少。
 * model / device / files 是设置页迁移（ModelSettings / DevicePane / 壁纸）需要的三条，
 * 形状与 preload.cjs 一一对应。
 */
interface OpenArcIdentityBridge {
  command: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onEvent: (callback: (event: { event: string; reason?: string; snapshot?: unknown }) => void) => () => void;
}

/** 命令面桥（model / device …）：一个 command(command, payload) 入口。 */
interface OpenArcCommandBridge {
  command: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** 文件服务条目（与 electron/file-service.cjs 的 FileEntry 同形）。 */
interface OpenArcFileEntry {
  id: string;
  name: string;
  ext: string;
  size?: number;
  mtime?: number;
  kind?: string;
}

/** 壁纸上传/列出/删除真正走的文件 IPC（electron/preload.cjs 的 openarc.files）。 */
interface OpenArcFilesBridge {
  pathFor: (file: File) => string;
  import: (
    folderId: string,
    paths: string[],
  ) => Promise<{ ok?: boolean; entries?: OpenArcFileEntry[]; added?: OpenArcFileEntry[]; error?: string }>;
  list: (folderId: string) => Promise<{ ok?: boolean; entries?: OpenArcFileEntry[]; error?: string }>;
  remove: (folderId: string, id: string) => Promise<{ ok?: boolean; entries?: OpenArcFileEntry[]; error?: string }>;
  /** 以下四条是访达窗口（FilesApp.vue）用到的，形状同 preload.cjs。 */
  rename?: (folderId: string, id: string, name: string) => Promise<{ ok?: boolean; error?: string }>;
  trash?: (folderId: string, id: string, groupId?: string) => Promise<{ ok?: boolean; error?: string }>;
  thumb?: (folderId: string, id: string, size?: number) => Promise<{ ok?: boolean; dataUrl?: string; error?: string }>;
  exportTo?: (folderId: string, ids: string[]) => Promise<{ ok?: boolean; error?: string }>;
  move?: (folderId: string, ids: string[], toFolderId: string) => Promise<{ ok?: boolean; error?: string }>;
  copy?: (folderId: string, ids: string[], toFolderId: string) => Promise<{ ok?: boolean; error?: string; count?: number }>;
  /** 系统回收站（软删除 / 恢复 / 永久删除 / 清空），形状同 preload.cjs。 */
  trashList?: () => Promise<{ ok?: boolean; entries?: OpenArcTrashEntry[]; error?: string }>;
  trashRestore?: (id: string) => Promise<{ ok?: boolean; folderId?: string; error?: string }>;
  trashPurge?: (id: string) => Promise<{ ok?: boolean; error?: string }>;
  trashEmpty?: () => Promise<{ ok?: boolean; error?: string }>;
  writeText?: (
    folderId: string,
    id: string | null,
    name: string,
    text: string,
  ) => Promise<{ ok?: boolean; entry?: OpenArcFileEntry; error?: string }>;
  read?: (
    folderId: string,
    id: string,
  ) => Promise<{ ok?: boolean; entry?: OpenArcFileEntry; mime?: string; kind?: string; dataUrl?: string; text?: string }>;
}

/** 回收站条目（file-service listTrash 的形状）。 */
interface OpenArcTrashEntry {
  id: string;
  name: string;
  ext: string;
  size: number;
  mtime: number;
  folderId?: string;
  deletedAt?: number;
  groupId?: string;
}

/** 原生窗口状态（main.cjs 的 window:control/state 与 window:state 同形）。 */
interface OpenArcWindowState {
  maximized: boolean;
  fullScreen: boolean;
  minimized: boolean;
  focused: boolean;
}

/** 窗口控制桥（第 40 个顶层键，形状同 preload.cjs 的 windowControl）。 */
interface OpenArcWindowControlBridge {
  state: () => Promise<{ ok: boolean; value?: OpenArcWindowState & { closing?: boolean }; error?: string; message?: string }>;
  minimize: () => Promise<{ ok: boolean; value?: OpenArcWindowState & { closing?: boolean }; error?: string; message?: string }>;
  toggleMaximize: () => Promise<{ ok: boolean; value?: OpenArcWindowState & { closing?: boolean }; error?: string; message?: string }>;
  close: () => Promise<{ ok: boolean; value?: OpenArcWindowState & { closing?: boolean }; error?: string; message?: string }>;
  onStateChange?: (callback: (state: OpenArcWindowState) => void) => () => void;
}

interface OpenArcEventBridge {
  command: (command: { command: string; payload?: Record<string, unknown> }) => Promise<any>;
  onEvent?: (callback: (event: any) => void) => () => void;
}
interface OpenArcBridge {
  /** 唯一的原生层上行通道：把 Window Manager 结算出的意图交给主进程。 */
  sync: (payload: unknown) => Promise<{ ok?: boolean; error?: string; results?: unknown[] }>;
  /** 只下发只读的显示器信息，不暴露任何窗口控制能力。 */
  onDisplay?: (callback: (displays: unknown[]) => void) => () => void;
  identity?: OpenArcIdentityBridge;
  model?: OpenArcCommandBridge;
  device?: OpenArcCommandBridge;
  /** MCP 中心：唯一入口 command({command,payload})，形状与 electron/preload.cjs 的 openarc.mcp 一致。 */
  mcp?: OpenArcCommandBridge;
  files?: OpenArcFilesBridge;
  /** 10-16 · DX OS 后端域（形状同 preload.cjs：command({command,payload}) + 可选 onEvent，返回 {ok,value}）。 */
  skill?: OpenArcEventBridge;
  automation?: OpenArcEventBridge;
  media?: OpenArcEventBridge;
  agent?: OpenArcEventBridge;
  developer?: OpenArcCommandBridge;
  integration?: OpenArcCommandBridge;
  market?: OpenArcCommandBridge;
  /**
   * Stage 1 在线更新桥（第 39 个顶层键，形状同 preload.cjs）：
   * 只有一条 command({command,payload})，派发 market/update/*（status/check/install/rollback/sources/source/set）。
   */
  marketUpdate?: OpenArcCommandBridge;
  platform?: OpenArcCommandBridge;
  /** 浏览器（10-15 迁入新壳层用到的四条，形状同 preload.cjs） */
  navigate?: (windowId: string, url: string, tabId?: string) => Promise<unknown>;
  action?: (windowId: string, action: string, tabId?: string) => Promise<unknown>;
  browser?: (command: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  onNativeState?: (callback: (event: any) => void) => () => void;
  /** 视频剪辑（形状同 preload.cjs）：本机 FFmpeg，路径与参数都在主进程。 */
  video?: {
    status: () => Promise<{ ok: boolean; available: boolean; version?: string; busy?: boolean }>;
    probe: (folderId: string, id: string) => Promise<{ ok: boolean; duration?: number; width?: number; height?: number; hasAudio?: boolean; error?: string }>;
    export: (payload: {
      clips: { folderId: string; id: string; start: number; end: number }[];
      resolution: string;
      folderId: string;
      name: string;
    }) => Promise<{ ok: boolean; entry?: OpenArcFileEntry; duration?: number; error?: string; detail?: string }>;
    cancel: () => Promise<{ ok: boolean }>;
    onProgress: (callback: (event: { ratio: number }) => void) => () => void;
  };
  /** 图片声明（形状同 preload.cjs） */
  image?: {
    declare: (
      items: { folderId: string; id: string }[],
      kind: "ai" | "mix",
    ) => Promise<{ ok: boolean; error?: string; results?: { id: string; ok: boolean; entry?: OpenArcFileEntry; replaced?: boolean; error?: string }[] }>;
  };
  /** 系统信息（形状同 preload.cjs） */
  system?: { info: () => Promise<any> };
  /** Windows 自绘 caption：窗口控制（形状同 preload.cjs） */
  windowControl?: OpenArcWindowControlBridge;
  /** 天气（形状同 preload.cjs）：出网只在主进程，固定 Open-Meteo。 */
  weather?: {
    geocode: (name: string) => Promise<any>;
    forecast: (lat: number, lon: number) => Promise<any>;
  };
  /** D4-04 Task 桥（形状同 preload.cjs）：受控命令 + 进度事件。对话应用与全局 AI 共用。 */
  task?: {
    command: (command: { command: string; payload?: Record<string, unknown> }) => Promise<any>;
    onEvent: (callback: (event: any) => void) => () => void;
  };
}

interface Window {
  openarc?: OpenArcBridge;
}
