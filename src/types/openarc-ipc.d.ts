/**
 * P1 · DX OS 地基：window.openarc 契约类型。
 *
 * 为什么现有域要在这里再声明一遍：src/main.tsx 里已有一份内联的
 * `declare global { interface Window { openarc?: {...} } }`，而 TS 对同一属性
 * 的多次声明要求"后续类型可赋值给先前类型"。因此本文件仍然完整列出既有域
 * （与 electron/preload.cjs 实际暴露面一致），再把计划 §4 的新域追加为**可选**成员 ——
 * 可选成员使两个声明互相可赋值，既不扩大运行时暴露面，也不触发 TS2717。
 *
 * 本文件只有类型：没有运行时逻辑，不新增桥键。任何一个 window.openarc.* 能否真正使用，
 * 仍取决于 electron/preload.cjs 与主进程是否注册了对应通道。
 */

/** 三个下行事件类别的统一信封（与 electron/dxos-foundation-events.cjs 一致）。 */
export type OpenArcEventKind = "progress" | "log" | "approval";
export type OpenArcLogLevel = "debug" | "info" | "warn" | "error";

export interface OpenArcEvent<TPayload = unknown> {
  channel: string;
  domain: string;
  kind: OpenArcEventKind;
  /** 同一 channel 内单调递增，前端据此判断是否丢事件。 */
  sequence: number;
  /** 毫秒时间戳（主进程时钟）。 */
  at: number;
  payload: TPayload;
}

/** 统一错误规约的渲染层形态（electron/dxos-foundation-errors.cjs）。 */
export interface OpenArcFailure {
  ok: false;
  error: string;
  message: string;
  detail?: unknown;
}
export interface OpenArcSuccess<T = Record<string, unknown>> {
  ok: true;
  value: T;
}
export type OpenArcResult<T = Record<string, unknown>> = OpenArcSuccess<T> | OpenArcFailure;

/** 原生层只读事件（沿用 src/main.tsx 既有形状）。 */
export type OpenArcNativeEvent = {
  type?: string;
  windowId?: string;
  tabId?: string | null;
  url?: string;
  title?: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  attached?: boolean;
  code?: number;
  message?: string;
  loadError?: { code: number; message: string; url: string } | null;
  event?: string;
  permission?: string;
  origin?: string;
  scheme?: string;
  reason?: string;
  error?: string;
  downloadId?: string;
  filename?: string;
  state?: string;
  received?: number;
  total?: number;
  sessionKey?: string | null;
};

export type OpenArcDisplayInfo = {
  id: number;
  scaleFactor: number;
  workArea: { x: number; y: number; width: number; height: number };
  internal: boolean;
  primary: boolean;
};

/** 文件服务条目（不含磁盘路径 —— 路径永不过桥）。 */
export type OpenArcFileEntry = { id: string; name: string; ext: string; size: number; mtime: number };

/** 所有 <domain>:command 的统一形状：命令体由主进程白名单校验。 */
export type OpenArcCommandFn = (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
export type OpenArcCommandBridge = { command: OpenArcCommandFn };
export type OpenArcEventBridge = { onEvent: (callback: (event: OpenArcEvent) => void) => () => void };

// ---------------------------------------------------------------------------
// 既有域（与 src/main.tsx 内联声明逐字同形；行为以 electron/preload.cjs 为准）
// ---------------------------------------------------------------------------

export interface OpenArcModelBridge extends OpenArcCommandBridge {
  /** P2：协议表 / 能力 manifest / 供应商掩码视图。 */
  protocols?: OpenArcCommandFn;
  providerView?: OpenArcCommandFn;
  /** W5：模型流式调用下行事件（model:event，P1 信封）。 */
  onEvent?: (callback: (event: OpenArcEvent) => void) => () => void;
}

export interface OpenArcMcpBridge extends OpenArcCommandBridge {
  /** P3：开放工具调用（经 side-effect 审批链）。 */
  callTool?: OpenArcCommandFn;
  onEvent?: (callback: (event: OpenArcEvent) => void) => () => void;
}

export interface OpenArcTaskBridge extends OpenArcCommandBridge {
  onEvent: (callback: (event: OpenArcEvent) => void) => () => void;
}

/**
 * B3 Agent 域。
 *
 * 唯一入口 command(...)（受控白名单：task / run / tool / capability / project / memory / react / health），
 * 以及 agent:event 下行（主进程封装的 P1 信封）。这里没有 raw credential / credentialRef / 本机路径 /
 * ipcRenderer —— sessionRef 与 appId 由主进程注入，renderer 自报的身份字段一律忽略。
 */
export interface OpenArcAgentBridge extends OpenArcCommandBridge {
  onEvent: (callback: (event: OpenArcEvent) => void) => () => void;
}

export interface OpenArcCanvasBridge extends OpenArcCommandBridge {
  /** P5：素材库 / .dxcanvas 打包 / 协作会话。 */
  assets?: OpenArcCommandFn;
  package?: OpenArcCommandFn;
  collab?: OpenArcCommandFn;
}

export interface OpenArcSideEffectBridge {
  command: OpenArcCommandFn;
  onEvent: (callback: (event: { type?: string; request?: unknown }) => void) => () => void;
}

export interface OpenArcFilesBridge {
  pathFor: (file: File) => string;
  import: (folderId: string, paths: string[]) => Promise<{ ok?: boolean; entries?: OpenArcFileEntry[]; added?: OpenArcFileEntry[]; error?: string }>;
  list: (folderId: string) => Promise<{ ok?: boolean; entries?: OpenArcFileEntry[]; error?: string }>;
  rename: (folderId: string, id: string, name: string) => Promise<{ ok?: boolean; entries?: OpenArcFileEntry[]; error?: string }>;
  remove: (folderId: string, id: string) => Promise<{ ok?: boolean; entries?: OpenArcFileEntry[]; error?: string }>;
  trash: (folderId: string, id: string, groupId?: string) => Promise<{ ok?: boolean; entries?: OpenArcFileEntry[]; error?: string }>;
  trashList: () => Promise<{ ok?: boolean; entries?: (OpenArcFileEntry & { folderId?: string; deletedAt?: number; groupId?: string })[]; error?: string }>;
  trashRestore: (id: string) => Promise<{ ok?: boolean; folderId?: string; recreated?: boolean; id?: string; error?: string }>;
  trashPurge: (id: string) => Promise<{ ok?: boolean; error?: string }>;
  trashEmpty: () => Promise<{ ok?: boolean; removed?: number; error?: string }>;
  read: (folderId: string, id: string) => Promise<{ ok?: boolean; entry?: OpenArcFileEntry; mime?: string; kind?: string; dataUrl?: string; text?: string; error?: string }>;
  thumb: (folderId: string, id: string, size?: number) => Promise<{ ok?: boolean; dataUrl?: string; error?: string }>;
  info: (folderId: string, id: string) => Promise<{ ok?: boolean; width?: number; height?: number; error?: string }>;
  startDrag: (folderId: string, id: string) => void;
  copy: (folderId: string, ids: string[], toFolderId: string) => Promise<{ ok?: boolean; entries?: OpenArcFileEntry[]; error?: string }>;
  move: (folderId: string, ids: string[], toFolderId: string) => Promise<{ ok?: boolean; error?: string }>;
  exportTo: (folderId: string, ids: string[]) => Promise<{ ok?: boolean; count?: number; dest?: string; error?: string }>;
}

// ---------------------------------------------------------------------------
// 计划 §4 新增的 12 个域（全部可选：主进程未注册时桥上就没有这个键）
// ---------------------------------------------------------------------------

/** P3 技能：注册 / 启停 / 导入导出 / 执行 / 分析。 */
export interface OpenArcSkillBridge extends OpenArcCommandBridge, OpenArcEventBridge {}
/** P5 媒体：FFmpeg 渲染作业、探测、封面、产物。 */
export interface OpenArcMediaBridge extends OpenArcCommandBridge, OpenArcEventBridge {}
/** P5 ComfyUI：本地实例启停、工作流、运行。 */
export interface OpenArcComfyBridge extends OpenArcCommandBridge, OpenArcEventBridge {}
/** P6 自动化：定义、调度、运行记录。 */
export interface OpenArcAutomationBridge extends OpenArcCommandBridge, OpenArcEventBridge {}
/** P7 外部集成：可选第三方插件（默认关闭）。 */
export interface OpenArcIntegrationBridge extends OpenArcCommandBridge {}
/** P7 开发者平台：manifest、实验室、打包、发布。 */
export interface OpenArcDeveloperBridge extends OpenArcCommandBridge {}
/** P7 本地市场：目录清单、安装 / 回滚。 */
export interface OpenArcMarketBridge extends OpenArcCommandBridge {}
/** P7 云替身：本地无对端，契约保留、默认关闭（DXOS_ERR_UNSUPPORTED）。 */
export interface OpenArcCloudBridge extends OpenArcCommandBridge {}
/** P6 更新：本地更新源检查。 */
export interface OpenArcUpdateBridge extends OpenArcCommandBridge {}
/** P6 诊断：运行时诊断、进程监控、数据快照 / 恢复。 */
export interface OpenArcDiagnosticsBridge extends OpenArcCommandBridge {}

export interface OpenArcBridge {
  sync: (p: unknown) => Promise<{ ok?: boolean; error?: string; results?: unknown[] }>;
  navigate: (windowId: string, url: string, tabId?: string) => Promise<{ error?: string; ok?: boolean }>;
  action: (windowId: string, action: string, tabId?: string) => Promise<{ error?: string; ok?: boolean }>;
  browser?: OpenArcCommandFn;
  onNativeState: (cb: (e: OpenArcNativeEvent) => void) => () => void;
  onDisplay: (cb: (d: OpenArcDisplayInfo[]) => void) => () => void;
  identity?: {
    command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
    onEvent: (cb: (e: { event: string; snapshot?: unknown }) => void) => () => void;
  };
  authorization?: OpenArcCommandBridge;
  device?: OpenArcCommandBridge;
  resource?: OpenArcCommandBridge;
  governance?: OpenArcCommandBridge;
  model?: OpenArcModelBridge;
  mcp?: OpenArcMcpBridge;
  sideEffect?: OpenArcSideEffectBridge;
  files?: OpenArcFilesBridge;
  /** preload 已暴露、main.tsx 既有声明遗漏的两个域（P1 补齐契约）。 */
  canvas?: OpenArcCanvasBridge;
  task?: OpenArcTaskBridge;
  /** B3：Agent 域（与 preload.cjs 的顶层 agent 键一一对应）。 */
  agent?: OpenArcAgentBridge;
  skill?: OpenArcSkillBridge;
  media?: OpenArcMediaBridge;
  comfy?: OpenArcComfyBridge;
  automation?: OpenArcAutomationBridge;
  integration?: OpenArcIntegrationBridge;
  developer?: OpenArcDeveloperBridge;
  market?: OpenArcMarketBridge;
  cloud?: OpenArcCloudBridge;
  update?: OpenArcUpdateBridge;
  diagnostics?: OpenArcDiagnosticsBridge;
}

declare global {
  interface Window {
    openarc?: OpenArcBridge;
  }
}
