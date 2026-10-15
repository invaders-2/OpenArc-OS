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
  /** P3：工具调用经既有 side-effect 审批链。**不另暴露 bridge 方法**：preload 只给 command，实际入口是 mcp/toolInvocation/call（默认关闭 + 逐次审批；未批准 0 次外发）。 */
  callTool?: OpenArcCommandFn;
  onEvent?: (callback: (event: OpenArcEvent) => void) => () => void;
}

/**
 * B4e · mcp/agentTools 的工具行。
 *
 * 与 electron/mcp-bootstrap.cjs 的 handleAgentTools 返回逐字段对应；
 * fname 是 Agent 侧命名空间 `mcp__<server>__<tool>`（electron/mcp-agent-tools.cjs:507），
 * 渲染层直接渲染，不再自行派生（原先 UI-2 在 src/mcp/McpCenter.tsx 复制了一份聚合规则）。
 * 文本字段（description / paramText / 名称）都已在主进程走地基 redactText 脱敏；
 * enabled 只表示显式开关当前状态，**不代表**该工具已被授权调用。
 */
export interface OpenArcMcpAgentTool {
  fname: string;
  serverId: string;
  serverName: string;
  toolName: string;
  /** 连接状态（connected 表示已就绪；其余照实回投影状态）。 */
  status: string;
  description: string;
  /** 参数摘要展示文案（服务端未回 inputSchema 时是明确的说明句，不是空串）。 */
  paramText: string;
  riskClass: "EXTERNAL_SIDE_EFFECT";
  requiresApproval: true;
}

/** B4e · mcp/agentTools 的返回契约（只读聚合）。 */
export interface OpenArcMcpAgentToolsResult {
  ok: boolean;
  /** 显式开关（<userData>/dxos/mcp.json 的 tools.invocationEnabled）当前状态。 */
  enabled: boolean;
  count: number;
  /** 已启用且已连接（READY）的 server 数，用于区分"没连接"与"连接了但没工具"。 */
  connectedServers: number;
  truncated: boolean;
  tools: OpenArcMcpAgentTool[];
  error?: string;
  detail?: string | null;
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
/**
 * B5a 媒体域：FFmpeg 渲染作业、ffprobe 探测、封面缓存、租约心跳、产物落盘。
 *
 * 唯一入口 command({ command, payload })（受控白名单，见 electron/media-domain.cjs 的 MEDIA_COMMANDS），
 * 以及 media:event 下行（主进程封装的 P1 信封，channel="media:event"）。
 * 这里没有 raw ffmpeg 句柄 / 凭据 / ipcRenderer / 绝对路径 —— sessionRef 与 appId 由主进程注入，
 * renderer 自报的 userId / role / appId 一律忽略。
 */
export type OpenArcMediaCommand =
  | "media/project/ensure"
  | "media/asset/save"
  | "media/asset/list"
  | "media/asset/delete"
  | "media/probe"
  | "media/poster/get"
  | "media/poster/invalidate"
  | "media/render/submit"
  | "media/render/get"
  | "media/render/list"
  | "media/render/run"
  | "media/render/cancel"
  | "media/render/heartbeat"
  | "media/render/recover"
  | "media/artifact/list"
  | "media/health";

/** 命令体：{ command, payload }；payload 缺省时退化为命令体本身（与 skill/agent 域同形）。 */
export interface OpenArcMediaCommandRequest {
  command: OpenArcMediaCommand;
  payload?: Record<string, unknown>;
}

/** ffprobe 探测结果（electron/media-domain.cjs parseFfprobeOutput）。 */
export interface OpenArcMediaProbe {
  durationMs: number;
  sizeBytes: number;
  formatName: string;
  bitRate?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  sampleRate?: number;
}

/** 渲染作业安全投影：绝对路径不出主进程，只回成片相对文件名。 */
export interface OpenArcMediaRenderJob {
  id: string;
  projectId: string;
  timelineVersion: number;
  status: "queued" | "running" | "interrupted" | "completed" | "failed" | "cancelled";
  progress: number;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  hasOutput: boolean;
  outputRelativePath: string | null;
  workerAssigned: boolean;
}

/** 素材安全投影（无磁盘绝对路径）。 */
export interface OpenArcMediaAsset {
  id: string;
  projectId: string;
  kind: "video" | "image" | "audio" | "subtitle";
  name: string;
  mime: string;
  size: number;
  durationMs?: number;
  width?: number;
  height?: number;
  hasVideo?: boolean;
  hasAudio?: boolean;
  relativePath: string;
  createdAt: number;
}

/** 落盘产物条目：relativePath 形如 "renders/<id>.mp4"，永不含绝对路径。 */
export interface OpenArcMediaArtifact {
  kind: "asset" | "render" | "poster";
  id: string;
  fileName: string;
  relativePath: string;
  bytes: number;
  mtime: number;
}

export interface OpenArcMediaBridge extends OpenArcCommandBridge, OpenArcEventBridge {}
/**
 * B6a 自动化域：定义 CRUD / 启停 / 调度 / 运行记录。
 *
 * 唯一入口 command({ command, payload })（受控白名单，见 electron/automation-domain.cjs 的 AUTOMATION_COMMANDS），
 * 以及 automation:event 下行（主进程封装的 P1 信封，channel="automation:event"）。
 * 这里没有 raw SQL / 数据库句柄 / 凭据 / 绝对路径 / ipcRenderer —— sessionRef 与 appId 由主进程注入，
 * renderer 自报的 userId / role / appId 一律忽略；automation:command 全部过 main.cjs 的 trusted(event)。
 * 业务动作的对外依赖（B7 开发者 App / 第三方集成插件 / B4 本地账号）未装配时返回
 * { ok:false, error:"AGENT_DEPENDENCY_UNAVAILABLE", detail:{ dependency } }，绝不假执行。
 */
export type OpenArcAutomationCommand =
  | "automation/list"
  | "automation/get"
  | "automation/create"
  | "automation/update"
  | "automation/delete"
  | "automation/enable"
  | "automation/disable"
  | "automation/runNow"
  | "automation/cancel"
  | "automation/runs"
  | "automation/catalog"
  | "automation/parse"
  | "automation/health";

export interface OpenArcAutomationCommandRequest {
  command: OpenArcAutomationCommand;
  payload?: Record<string, unknown>;
}

/** 执行时间：源的 daily/weekly/once（automations.ts:5-8）+ B6a 扩展的 cron/interval。 */
export type OpenArcAutomationSchedule =
  | { type: "daily"; hour: number; minute: number; timezone?: string }
  | { type: "weekly"; weekdays: number[]; hour: number; minute: number; timezone?: string }
  | { type: "once"; at: number; timezone?: string }
  | { type: "cron"; expression: string; timezone?: string }
  | { type: "interval"; everyMs: number; anchor?: number; timezone?: string };

export type OpenArcAutomationActionType =
  | "music_play"
  | "music_control"
  | "open_app"
  | "agent_instruction"
  | "ziniao_download"
  | "lingxing_cache_sync"
  | "ziniao_data_sync"
  | "dingtalk_group_notify"
  | "dingtalk_person_notify"
  | "workflow_sequence"
  | "app_action";

/** action.retry 是 B6a 扩展：在一次运行内重试，运行记录仍只落一行（result 里带真实 attempts）。 */
export interface OpenArcAutomationRetry {
  maxAttempts: number;
  delayMs: number;
}

export interface OpenArcAutomationAction {
  type: OpenArcAutomationActionType;
  args: Record<string, unknown>;
  retry?: OpenArcAutomationRetry;
}

export interface OpenArcAutomationRun {
  id: string;
  automationId: string;
  scheduledFor: number;
  status: "running" | "success" | "failed" | "cancelled" | string;
  clientId: string | null;
  result: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface OpenArcAutomation {
  id: string;
  userId: string;
  title: string;
  instruction: string;
  action: OpenArcAutomationAction | null;
  schedule: OpenArcAutomationSchedule | null;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  runs?: OpenArcAutomationRun[];
}

export interface OpenArcAutomationBridge extends OpenArcCommandBridge, OpenArcEventBridge {}

/**
 * B7c 集成域：**可选插件，默认关闭**。
 *
 * 唯一入口 command({ command, payload })（受控白名单，见 electron/plugin-service.cjs 的
 * INTEGRATION_COMMANDS，B7f 起含 B7d 领星 / 紫鸟 / 夸克与 B7e2 RunningHub / ModelScope）。
 * 三个内置插件 dingtalk / weather / almanac 默认全关；未启用、
 * 或已启用但依赖缺失 / 运行时能力（fetch / safeStorage）未注入时，一律返回
 * { ok:false, error:"INTEGRATION_UNAVAILABLE", detail:"<缺什么、怎么装>" }，绝不假实现。
 * 开关落 <userData>/dxos/integrations.json；钉钉凭据走 safeStorage，明文不过桥。
 */
export type OpenArcIntegrationCommand =
  | "integration/health"
  | "integration/commands"
  | "integration/plugins/list"
  | "integration/plugins/get"
  | "integration/plugins/enable"
  | "integration/plugins/disable"
  | "integration/plugins/health"
  | "integration/dingtalk/status"
  | "integration/dingtalk/channels"
  | "integration/dingtalk/channels/save"
  | "integration/dingtalk/channels/delete"
  | "integration/dingtalk/contacts"
  | "integration/dingtalk/contacts/record"
  | "integration/dingtalk/send"
  | "integration/dingtalk/send-to-user"
  | "integration/dingtalk/agent-config/get"
  | "integration/dingtalk/agent-config/save"
  | "integration/weather/query"
  | "integration/almanac/years"
  | "integration/lingxing/status"
  | "integration/lingxing/mapping/get"
  | "integration/lingxing/mapping/import"
  | "integration/lingxing/mapping/file"
  | "integration/lingxing/cache/stats"
  | "integration/lingxing/cache/sync/start"
  | "integration/lingxing/cache/sync/get"
  | "integration/lingxing/cache/rows"
  | "integration/lingxing/cache/query"
  | "integration/lingxing/cache/clear"
  | "integration/lingxing/advertising/sync/start"
  | "integration/lingxing/advertising/sync/get"
  | "integration/lingxing/advertising/sync/stop"
  | "integration/lingxing/advertising/cache/stats"
  | "integration/lingxing/advertising/cache/query"
  | "integration/lingxing/credential/save"
  | "integration/lingxing/credential/status"
  | "integration/ziniao/status"
  | "integration/ziniao/jobs/list"
  | "integration/ziniao/jobs/current"
  | "integration/ziniao/jobs/start"
  | "integration/ziniao/jobs/control"
  | "integration/ziniao/jobs/delete"
  | "integration/ziniao/jobs/recover"
  | "integration/ziniao/vc/files"
  | "integration/ziniao/credential/save"
  | "integration/ziniao/credential/status"
  | "integration/quark/status"
  | "integration/quark/account"
  | "integration/quark/login/start"
  | "integration/quark/login/stop"
  | "integration/quark/logout"
  | "integration/quark/search"
  | "integration/quark/browse"
  | "integration/quark/download"
  | "integration/quark/upload"
  | "integration/quark/search-history/get"
  | "integration/quark/search-history/record"
  | "integration/quark/search-history/clear"
  | "integration/quark/downloads/clean"
  | "integration/quark/credential/status"
  | "integration/runninghub/status"
  | "integration/runninghub/credentials/save"
  | "integration/runninghub/credentials/delete"
  | "integration/runninghub/models"
  | "integration/runninghub/generate-images"
  | "integration/runninghub/edit-images"
  | "integration/runninghub/generate-videos"
  | "integration/modelscope/status"
  | "integration/modelscope/credentials/save"
  | "integration/modelscope/credentials/delete"
  | "integration/modelscope/generate-images"
  | "integration/modelscope/edit-images";

export interface OpenArcIntegrationCommandRequest {
  command: OpenArcIntegrationCommand;
  payload?: Record<string, unknown>;
}

/** 插件健康报告的失败形状：detail 是人话的"缺什么、怎么装"。 */
export interface OpenArcIntegrationFailure {
  ok: false;
  error: string;
  detail: string;
}
export type OpenArcIntegrationResult<T = Record<string, unknown>> = OpenArcSuccess<T> | OpenArcIntegrationFailure;

export interface OpenArcIntegrationDependency {
  id: string;
  /** binary：PATH 二进制；python：Python 包；network：网络可达性；credential：凭据已配置。 */
  kind: "binary" | "python" | "network" | "credential";
  label: string;
  required: boolean;
  status: "ok" | "missing" | "unknown";
  detail: string;
  install: string;
}

export interface OpenArcIntegrationPluginHealth {
  id: string;
  name: string;
  kind: string;
  version: string;
  description: string;
  enabled: boolean;
  status: "disabled" | "healthy" | "degraded" | "unavailable";
  dependencies: OpenArcIntegrationDependency[];
  capabilities: { name: string; available: boolean }[];
  missingRequired: string[];
  missingOptional: string[];
  detail: string;
}

export interface OpenArcIntegrationPluginSummary {
  id: string;
  name: string;
  description: string;
  kind: string;
  version: string;
  enabled: boolean;
  requiredDependencies: string[];
  optionalDependencies: string[];
  capabilities: string[];
}

export interface OpenArcIntegrationBridge extends OpenArcCommandBridge {
  command: (command: OpenArcIntegrationCommandRequest) => Promise<OpenArcIntegrationResult<unknown>>;
}

/**
 * B7a 开发者平台域：本地 App 生命周期（装载 / 启用 / 禁用 / 回滚 / 卸载）+ 出网治理。
 *
 * 唯一入口 command({ command, payload })（受控白名单，见 electron/developer-domain.cjs 的 DEVELOPER_COMMANDS；
 * B7f 起为 B7a 的 16 条 + B7b 的 lab / collab / migrations / realtime 54 条，共 70 条）。
 * 不暴露 ipcRenderer / 包目录绝对路径 / 凭据密钥；sessionRef 与 appId 由主进程注入，
 * renderer 自报的 userId / role / appId 一律忽略；developer:command 全部过 main.cjs 的 trusted(event)。
 * 六张表沿用 v22：user_installed_apps / user_app_install_state / app_market_releases（本地清单缓存）/
 * app_credential_bindings / app_runtime_events / app_network_audit，不新建第二套存储。
 *
 * developer/health 的两个计数字段语义不同，不得互相冒充（见 electron/developer-service.cjs:566-592）：
 *   commands         **实际可达数** = 基座 16 条 + 已装配扩展切片（lab / collab / migrations /
 *                    realtime）的命令数。切片装配失败由 main.cjs 逐切片 try/catch 捕获，
 *                    health 同步给出 degraded / degradedReason / extensions，commands 随之下降。
 *   declaredCommands **静态白名单长度** = domain.listDeveloperCommands().length（B7f 起固定 70）。
 *                    只表示契约声明了多少条，不代表运行时都装配成功或可达。
 */
export type OpenArcDeveloperCommand =
  | "developer/install"
  | "developer/uninstall"
  | "developer/enable"
  | "developer/disable"
  | "developer/rollback"
  | "developer/list"
  | "developer/get"
  | "developer/history"
  | "developer/validate"
  | "developer/credential/bind"
  | "developer/credential/list"
  | "developer/credential/unbind"
  | "developer/network/evaluate"
  | "developer/network/request"
  | "developer/runtime/report"
  | "developer/health"
  | "developer/lab/templates"
  | "developer/lab/example"
  | "developer/lab/create"
  | "developer/lab/createFromTemplate"
  | "developer/lab/get"
  | "developer/lab/list"
  | "developer/lab/setOwner"
  | "developer/lab/delete"
  | "developer/lab/readFile"
  | "developer/lab/writeFile"
  | "developer/lab/setIcon"
  | "developer/lab/zip"
  | "developer/lab/preview"
  | "developer/lab/verifyPreviewToken"
  | "developer/lab/icon/normalize"
  | "developer/lab/icon/auto"
  | "developer/docs/catalog"
  | "developer/docs/get"
  | "developer/docs/status"
  | "developer/docs/refresh"
  | "developer/collab/create"
  | "developer/collab/list"
  | "developer/collab/get"
  | "developer/collab/update"
  | "developer/collab/setMembers"
  | "developer/collab/applyChangeset"
  | "developer/collab/setSharing"
  | "developer/collab/createInvite"
  | "developer/collab/revokeInvite"
  | "developer/collab/redeemInvite"
  | "developer/collab/delete"
  | "developer/collab/roomAccess"
  | "developer/migrations/apply"
  | "developer/migrations/applyChain"
  | "developer/migrations/saveSnapshot"
  | "developer/migrations/restoreSnapshot"
  | "developer/migrations/snapshotStatus"
  | "developer/migrations/deleteSnapshots"
  | "developer/migrations/deleteSnapshot"
  | "developer/realtime/create"
  | "developer/realtime/list"
  | "developer/realtime/get"
  | "developer/realtime/join"
  | "developer/realtime/reconnect"
  | "developer/realtime/leave"
  | "developer/realtime/send"
  | "developer/realtime/setState"
  | "developer/realtime/members"
  | "developer/realtime/close"
  | "developer/realtime/stats"
  | "developer/realtime/cleanup"
  | "developer/realtime/events"
  | "developer/realtime/transportStatus"
  | "developer/realtime/lanServer";

export interface OpenArcDeveloperCommandRequest {
  command: OpenArcDeveloperCommand;
  /** 装载 / 校验时携带 base64 包内容（package 或 packageBase64）；其余命令是各自参数。 */
  payload?: Record<string, unknown>;
}

/** dx-app/v2 清单安全投影（不含 agent.toolManifest 等随包路径）。 */
export interface OpenArcDeveloperManifest {
  format: "dx-app/v1" | "dx-app/v2";
  id: string;
  version: string;
  build: number;
  releaseChannel: "stable" | "beta" | "dev";
  minSystemVersion: string;
  maxSystemVersion: string | null;
  dataVersion: number;
  name: string;
  subtitle: string;
  description: string;
  category: "software" | "games";
  entry: string;
  multiInstance: boolean;
  backgroundMode: "release" | "keep-alive";
  permissions: string[];
  network: { domains: string[]; methods: string[]; maxResponseBytes: number } | null;
  hasMigrations: boolean;
  migrations: { from: number; to: number }[];
}

export interface OpenArcDeveloperApp {
  appId: string;
  enabled: boolean;
  version: string;
  build: number;
  releaseChannel: "stable" | "beta" | "dev";
  installedAt: number | null;
  updatedAt: number | null;
  packageSize: number;
  sha256: string;
  historyCount: number;
  manifest: OpenArcDeveloperManifest | null;
  capabilities: Record<string, unknown>;
}

/** 可回滚的历史版本（卸载会清清单缓存与凭据绑定，运行时事件与网络审计保留）。 */
export interface OpenArcDeveloperRelease {
  version: string;
  build: number;
  releaseChannel: "stable" | "beta" | "dev";
  dataVersion: number;
  publishedAt: number;
  revokedAt: number | null;
}

export interface OpenArcDeveloperBridge extends OpenArcCommandBridge {
  command: (command: OpenArcDeveloperCommandRequest) => Promise<OpenArcResult<unknown>>;
}

/**
 * B7c 本地市场域：**只读本地清单**，不联网、不下载、不安装。
 *
 * 云发布 / 审核 / 灰度 / 市场远端服务（api.dx-os.com）一律 OUT（任务书硬约束）。
 * 清单结构非法 → MARKET_MANIFEST_INVALID；目录或清单缺失 → MARKET_CATALOG_MISSING。
 */
export type OpenArcMarketCommand =
  | "market/catalog"
  | "market/apps/list"
  | "market/apps/get"
  | "market/skillpacks/list"
  | "market/skillpacks/get"
  | "market/health";

export interface OpenArcMarketCommandRequest {
  command: OpenArcMarketCommand;
  payload?: Record<string, unknown>;
}

export interface OpenArcMarketFailure {
  ok: false;
  error: string;
  detail: string;
}
export type OpenArcMarketResult<T = Record<string, unknown>> = OpenArcSuccess<T> | OpenArcMarketFailure;

/** 与 electron/market-domain.cjs 的 normalizeMarketplaceApp 一致（源 marketplace.ts:181-205）。 */
export interface OpenArcMarketApp {
  id: string;
  name: string;
  category: "software" | "games";
  categoryIds: string[];
  subtitle: string;
  summary: string;
  iconUrl?: string;
  coverImageUrl?: string;
  tags: string[];
  featured: boolean;
  version: string;
  build: number;
  channel: "stable" | "beta" | "dev";
  packageSize: number;
  minSystemVersion: string;
  publishedAt: number;
}

export interface OpenArcMarketSkillPack {
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string;
  tags: string[];
  packageSize: number;
  /** 相对入口路径（拒绝绝对路径与目录穿越）；缺省表示由技能中心自行解析。 */
  entry?: string;
  publishedAt: number;
}

export interface OpenArcMarketCatalog {
  generatedAt: number;
  page: { id: string; title: string };
  source: "local";
  categories: { id: string; name: string; icon: string; description: string; count: number }[];
  apps: OpenArcMarketApp[];
  skillPacks: OpenArcMarketSkillPack[];
  rejected: { apps: number; skillPacks: number };
}

export interface OpenArcMarketBridge extends OpenArcCommandBridge {
  command: (command: OpenArcMarketCommandRequest) => Promise<OpenArcMarketResult<unknown>>;
}
/** P7 云替身：本地无对端，契约保留、默认关闭（DXOS_ERR_UNSUPPORTED）。 */
export interface OpenArcCloudBridge extends OpenArcCommandBridge {}
/** P6 更新：本地更新源检查。 */
export interface OpenArcUpdateBridge extends OpenArcCommandBridge {}
/** P6 诊断：运行时诊断、进程监控、数据快照 / 恢复。 */
export interface OpenArcDiagnosticsBridge extends OpenArcCommandBridge {}

/**
 * B6c 平台域：诊断 / 数据保护 / 网络安全 / 供应商测试安全。
 *
 * 唯一入口 command({ command, payload })（受控白名单，见 electron/platform-domain.cjs 的 PLATFORM_COMMANDS）。
 * 这里没有 raw 环境变量 / 绝对路径 / 凭据 / ipcRenderer —— sessionRef 与 appId 由主进程注入，
 * renderer 自报的 userId / role / appId 一律忽略；platform:command 全部过 main.cjs 的 trusted(event)。
 */
export type OpenArcPlatformCommand =
  | "platform/diagnostics/app"
  | "platform/diagnostics/process"
  | "platform/diagnostics/record"
  | "platform/data/integrity"
  | "platform/data/snapshot/create"
  | "platform/data/snapshot/verify"
  | "platform/data/snapshot/list"
  | "platform/data/snapshot/restore"
  | "platform/network/evaluate"
  | "platform/provider/test-check"
  | "platform/health";

export interface OpenArcPlatformCommandRequest {
  command: OpenArcPlatformCommand;
  payload?: Record<string, unknown>;
}

/** 出网判定结果（electron/platform-service.cjs evaluateNetwork）：allowed=false 时 reason 非空。 */
export interface OpenArcNetworkDecision {
  allowed: boolean;
  host: string;
  origin: string;
  reason: "DNS_FAILED" | "DNS_EMPTY" | "PRIVATE_ADDRESS" | null;
  addresses: string[];
}

export interface OpenArcPlatformBridge extends OpenArcCommandBridge {}

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
  automation?: OpenArcAutomationBridge;
  integration?: OpenArcIntegrationBridge;
  developer?: OpenArcDeveloperBridge;
  market?: OpenArcMarketBridge;
  cloud?: OpenArcCloudBridge;
  update?: OpenArcUpdateBridge;
  diagnostics?: OpenArcDiagnosticsBridge;
  /** B6c：平台域（与 preload.cjs 的第 22 个顶层键 platform 一一对应）。 */
  platform?: OpenArcPlatformBridge;
}

declare global {
  interface Window {
    openarc?: OpenArcBridge;
  }
}
