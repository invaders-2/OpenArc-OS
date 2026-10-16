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

/**
 * 模型/协议出网代理设置（model:command 的 model/proxy/get | model/proxy/set）。
 * 只描述代理地址本身；地址必须形如 http(s)://host:port，绝不含用户名/密码。
 */
export interface OpenArcModelEgressProxy {
  enabled: boolean;
  url: string | null;
}

/** model/proxy/set 的回包：changed 表示本次是否真的改动了落库值（未变则不写审计）。 */
export interface OpenArcModelEgressProxyResult extends OpenArcModelEgressProxy {
  ok: true;
  changed: boolean;
}

export interface OpenArcModelBridge extends OpenArcCommandBridge {
  /** P2：协议表 / 能力 manifest / 供应商掩码视图。 */
  protocols?: OpenArcCommandFn;
  providerView?: OpenArcCommandFn;
  /** W5：模型流式调用下行事件（model:event，P1 信封）。 */
  onEvent?: (callback: (event: OpenArcEvent) => void) => () => void;
  /** 模型出网代理（默认关闭；只作用于模型与协议出口，不写 globalThis）。 */
  egressProxy?: OpenArcModelEgressProxy;
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

/**
 * 应用在线更新（第 39 个顶层键 marketUpdate；命令通道复用 market:command）。
 *
 * 泛化后：status / check / install / rollback 接受 payload.appId（任意已注册应用；缺省 = "canvas"）。
 * 每个应用的发现约定：ModelScope updates/<appId>/latest.json + <appId>-<version>.zip，
 * GitHub tag <appId>-v*；安装目录 <userData>/dxos/apps/<appId>/<version>/。
 * sources / source/set 是整机级设置（payload.appId 只影响回显的 manifestPath）。
 *
 * 冻结包格式 openarc-app/v1：<appId>-<version>.zip 内 manifest.json（id 必须等于 appId）
 * + manifest.sig；校验链 = Ed25519(manifest.sig, manifest.json 原始字节) → manifest.files 的 sha256。
 * 诚实边界：渲染层未接入加载路径的应用（loadable=false）即使源里有包也不可安装，
 * install 结构化回 MARKET_UPDATE_NOT_LOADABLE。错误码全部为 MARKET_UPDATE_*（未知异常折叠 DXOS_ERR_INTERNAL）。
 */
export type OpenArcMarketUpdateCommand =
  | "market/update/status"
  | "market/update/check"
  | "market/update/install"
  | "market/update/rollback"
  | "market/update/sources"
  | "market/update/source/set";

/** 更新源注册表 kind；默认源是 modelscope-repo（默认 owner/repo = bllack/OpenArc-OS，见 market-update-domain.cjs 的 DEFAULT_SOURCE_KIND）。 */
export type OpenArcMarketUpdateSourceKind = "github-releases" | "modelscope-repo";

export interface OpenArcMarketUpdateCommandRequest {
  command: OpenArcMarketUpdateCommand;
  payload?: Record<string, unknown>;
}

export interface OpenArcMarketUpdateCurrent {
  version: string;
  digest: string | null;
  installedAt: number;
}

export interface OpenArcMarketUpdateLatest {
  version: string;
  notesUrl: string | null;
  publishedAt: number;
}

export interface OpenArcMarketUpdateRepository {
  owner: string;
  repo: string;
}

/** 当前选中的更新源：kind 只能在注册表内。 */
export interface OpenArcMarketUpdateSourceRef extends OpenArcMarketUpdateRepository {
  kind: OpenArcMarketUpdateSourceKind;
}

export interface OpenArcMarketUpdateSourceDescriptor {
  kind: OpenArcMarketUpdateSourceKind;
  label: string;
  defaultRepository: OpenArcMarketUpdateRepository;
  allowedHosts: string[];
  configurableFields: string[];
  manifestPath: string | null;
}

export interface OpenArcMarketUpdateStatus {
  /** 任意已注册应用 id（缺省请求回落 "canvas"）。 */
  appId: string;
  current: OpenArcMarketUpdateCurrent | null;
  builtinVersion: string;
  source: OpenArcMarketUpdateSourceRef;
  checkedAt: number | null;
  latest: OpenArcMarketUpdateLatest | null;
  updateAvailable: boolean;
  canRollback: boolean;
  /** 已安装包形态 / 应用声明的包形态；后端不懂就回 null，不臆造。 */
  packageKind: string | null;
  /** 渲染层是否已接入该应用的已安装包加载路径（本期只有 canvas 为 true）。 */
  loadable: boolean;
  loader: string | null;
  loadReason: string | null;
}

export interface OpenArcMarketUpdateInstallResult {
  installed: { appId: string; version: string; digest: string; kind?: string; entry?: string | null };
  previous: { version: string } | null;
}

export interface OpenArcMarketUpdateRollbackResult {
  rolledBackTo: string;
  previous: { version: string };
}

export interface OpenArcMarketUpdateSources extends OpenArcMarketUpdateSourceRef {
  defaultRepository: OpenArcMarketUpdateRepository;
  defaultSource: { kind: OpenArcMarketUpdateSourceKind };
  apiUrl: string;
  allowedHosts: string[];
  channel: "stable" | "beta" | "dev";
  configurableFields: string[];
  manifestPath: string | null;
  selected: OpenArcMarketUpdateSourceRef;
  sources: OpenArcMarketUpdateSourceDescriptor[];
}

export interface OpenArcMarketUpdateBridge extends OpenArcCommandBridge {
  command: (command: OpenArcMarketUpdateCommandRequest) => Promise<OpenArcMarketResult<unknown>>;
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

/**
 * 0.6.1 系统字体域：本机字体清单 / 按 id 读字节。
 *
 * 唯一入口 command({ command, payload })（受控白名单，见 electron/system-fonts-domain.cjs）；
 * onEvent 只收主进程封装的 P1 信封。不暴露字体绝对路径 / 通用 fs / ipcRenderer；
 * sessionRef 与 appId 由主进程注入，renderer 自报的身份字段一律忽略。
 */
export interface OpenArcSystemFontsBridge extends OpenArcCommandBridge, OpenArcEventBridge {}

/** 0.6.1 OCR 域：provider/list、ocr/recognize；供应商密钥只在主进程内解出，不过桥。 */
export interface OpenArcOcrBridge extends OpenArcCommandBridge, OpenArcEventBridge {}

/** 0.6.1 文件传输域：begin / chunk / complete / status / cancel / cleanup / health；无通用 fs / 任意路径。 */
export interface OpenArcFileTransferBridge extends OpenArcCommandBridge {}

/**
 * 0.6.1 codex-canvas 域：status / pair / revoke / relay / setup / install / commands。
 *
 * 独立通道 codexCanvas:command / codexCanvas:event（并入 canvas:command 需改 canvas-bootstrap
 * 的冻结白名单，超出本轮授权范围）；中继只落到既有画布服务，不自起 HTTP。
 */
export interface OpenArcCodexCanvasBridge extends OpenArcCommandBridge, OpenArcEventBridge {}

/**
 * 0.6.1 本机代理探测域：当前唯一命令 desktop/proxy/detect（默认零出网）。
 *
 * 独立通道 desktop:command（并入 platform:command 需改 platform-domain 的冻结白名单，
 * 超出本轮授权范围）。
 */
export interface OpenArcDesktopBridge extends OpenArcCommandBridge {}

/**
 * 0.6.2 photos 域：本地照片来源 / 虚拟文件夹 / 图库 / 视觉特征 / 反向提示词 / 抠图 / 缩略图。
 *
 * 唯一入口 command({ command, payload })（受控白名单，见 electron/photos-domain.cjs 的
 * PHOTOS_COMMANDS，命令名与 /api/photos/* 路由一一对应）。source 视图只回 id / name / available，
 * 绝不回宿主绝对路径；列表命令一律显式回 total / offset / limit / truncated。不暴露 ipcRenderer /
 * 通用 fs；sessionRef 与 appId 由主进程注入，renderer 自报的 userId / owner / appId 一律忽略。
 * 失败形状是统一信封 { ok:false, error, message, detail? }，error 取 PHOTOS_*（见
 * OpenArcPhotosErrorCode）或非域错误归一后的 DXOS_* 码。
 */
export type OpenArcPhotosCommand =
  | "photos/sources/list"
  | "photos/sources/add"
  | "photos/sources/remove"
  | "photos/folders/create"
  | "photos/folders/remove"
  | "photos/folders/assign"
  | "photos/library"
  | "photos/sourceFile"
  | "photos/sourceThumbnail"
  | "photos/importImage"
  | "photos/reversePrompt"
  | "photos/visionModels"
  | "photos/backgroundRemoval"
  | "photos/health";

/** photos 域自有错误码（electron/photos-domain.cjs:PHOTOS_ERROR_CODES）。 */
export type OpenArcPhotosErrorCode =
  | "PHOTOS_COMMAND_NOT_ALLOWED"
  | "PHOTOS_NOT_READY"
  | "PHOTOS_INVALID_INPUT"
  | "PHOTOS_UNAUTHENTICATED"
  | "PHOTOS_FORBIDDEN"
  | "PHOTOS_NOT_FOUND"
  | "PHOTOS_CONFLICT"
  | "PHOTOS_PATH_ESCAPE"
  | "PHOTOS_TOO_LARGE"
  | "PHOTOS_DEPENDENCY_UNAVAILABLE"
  | "PHOTOS_PROVIDER_UNAVAILABLE"
  | "PHOTOS_PROVIDER_FAILED"
  | "PHOTOS_INTERNAL";

/** 来源条目（不含宿主路径）：sourceFile / sourceThumbnail 等也都只以小写 id 定位。 */
export interface OpenArcPhotosItem {
  id: string;
  name: string;
  sourceId: string;
  relativePath: string;
  folderPath: string;
  mime: string;
  kind: "image" | "video";
  size: number;
  updated_ts: number;
  virtualFolderId: string | null;
}
export interface OpenArcPhotosSourceView { id: string; name: string; available: boolean; }
export interface OpenArcPhotosFolderView { id: string; name: string; parentId: string | null; }
export interface OpenArcPhotosSourceFolderView extends OpenArcPhotosFolderView { sourceId: string; path: string; }
/** photos 列表命令的统一分页字段。 */
export interface OpenArcPhotosPage { total: number; offset: number; limit: number; truncated: boolean; }

/** photos/sources/list 的成功 value（store.listSources 的逐字投影）。 */
export interface OpenArcPhotosSourceListValue extends OpenArcPhotosPage {
  sources: OpenArcPhotosSourceView[];
  sourcesTotal: number;
  sourcesTruncated: boolean;
  folders: OpenArcPhotosSourceFolderView[];
  foldersTotal: number;
  foldersTruncated: boolean;
  virtualFolders: OpenArcPhotosFolderView[];
  virtualFoldersTotal: number;
  virtualFoldersTruncated: boolean;
  items: OpenArcPhotosItem[];
  walkCapReached: boolean;
}
export interface OpenArcPhotosSourceAddValue { source: OpenArcPhotosSourceView; created: boolean; }
export interface OpenArcPhotosRemoveValue { id: string; removed: boolean; }
export interface OpenArcPhotosFolderRemoveValue extends OpenArcPhotosRemoveValue { removedFolderIds: string[]; }
export interface OpenArcPhotosFolderCreateValue { folder: OpenArcPhotosFolderView; }
export interface OpenArcPhotosFolderAssignValue {
  folderId: string | null;
  assigned: number;
  cleared: number;
  skipped: string[];
}
export interface OpenArcPhotosLibraryNodeView {
  id: string;
  name: string;
  type: "file";
  parentId: string | null;
  mime: string | null;
  size: number;
  created_ts: number;
  updated_ts: number;
}
export interface OpenArcPhotosLibraryItem {
  node: OpenArcPhotosLibraryNodeView;
  folderId: string | null;
  folderName: string;
  path: string;
  kind: "image" | "video";
}
export interface OpenArcPhotosLibraryValue extends OpenArcPhotosPage { items: OpenArcPhotosLibraryItem[]; }
/** 内联字节出口：base64url（不含 + / =，绕开 foundation 的路径替换）。 */
export interface OpenArcPhotosSourceFileValue {
  id: string;
  name: string;
  mime: string;
  size: number;
  encoding: "base64url";
  data: string;
}
export interface OpenArcPhotosThumbnailValue {
  id: string;
  mime: "image/jpeg";
  size: number;
  cached: boolean;
  encoding: "base64url";
  data: string;
}
/** 导入结果：canvas 必回 cardId，library 必回 itemId（service 侧强校验）。 */
export interface OpenArcPhotosImportValue {
  destination: "canvas" | "library";
  targetId: string;
  cardId?: string;
  itemId?: string;
  nodeId?: string;
}
export interface OpenArcPhotosReversePromptValue { text: string; providerId: string; model: string; }
export interface OpenArcPhotosVisionModel { providerId: string; providerName: string; model: string; }
export interface OpenArcPhotosVisionModelsValue {
  available: boolean;
  models: OpenArcPhotosVisionModel[];
  hint: string | null;
}
export interface OpenArcPhotosBackgroundRemovalValue {
  mime: "image/png";
  bytes: number;
  encoding: "base64url";
  data: string;
}
export interface OpenArcPhotosHealthValue {
  status: "ready";
  directory: "dxos/photos";
  sources: number;
  libraryNodes: number;
  pageLimitDefault: number;
  pageLimitMax: number;
  dependencies: {
    identity: boolean;
    database: boolean;
    providerStore: boolean;
    vision: boolean;
    fsLibrary: boolean;
    shareAccess: boolean;
    sharp: boolean;
    videoPoster: boolean;
    importer: boolean;
    fetch: boolean;
  };
}
/** 命令 → 成功 value 的逐字映射；失败统一为 OpenArcFailure。 */
export interface OpenArcPhotosValueByCommand {
  "photos/sources/list": OpenArcPhotosSourceListValue;
  "photos/sources/add": OpenArcPhotosSourceAddValue;
  "photos/sources/remove": OpenArcPhotosRemoveValue;
  "photos/folders/create": OpenArcPhotosFolderCreateValue;
  "photos/folders/remove": OpenArcPhotosFolderRemoveValue;
  "photos/folders/assign": OpenArcPhotosFolderAssignValue;
  "photos/library": OpenArcPhotosLibraryValue;
  "photos/sourceFile": OpenArcPhotosSourceFileValue;
  "photos/sourceThumbnail": OpenArcPhotosThumbnailValue;
  "photos/importImage": OpenArcPhotosImportValue;
  "photos/reversePrompt": OpenArcPhotosReversePromptValue;
  "photos/visionModels": OpenArcPhotosVisionModelsValue;
  "photos/backgroundRemoval": OpenArcPhotosBackgroundRemovalValue;
  "photos/health": OpenArcPhotosHealthValue;
}

export type OpenArcPhotosCommandRequest =
  | { command: "photos/sources/list"; payload?: { offset?: number; limit?: number } }
  | { command: "photos/sources/add"; payload: { path: string } }
  | { command: "photos/sources/remove"; payload: { id: string } }
  | { command: "photos/folders/create"; payload: { name: string; parentId?: string | null } }
  | { command: "photos/folders/remove"; payload: { id: string } }
  | { command: "photos/folders/assign"; payload: { ids: string[]; folderId?: string | null } }
  | { command: "photos/library"; payload?: { offset?: number; limit?: number } }
  | { command: "photos/sourceFile"; payload: { id: string } }
  | { command: "photos/sourceThumbnail"; payload: { id: string; size?: number } }
  | { command: "photos/importImage"; payload: { sourceId: string; targetId: string; destination: "canvas" | "library"; prompt?: string } }
  | { command: "photos/reversePrompt"; payload: { imageId: string; providerId?: string; model?: string } }
  | { command: "photos/visionModels"; payload?: Record<string, never> }
  | {
      command: "photos/backgroundRemoval";
      payload: {
        image?: string;
        base64?: string;
        dataUrl?: string;
        data?: string;
        bytes?: Uint8Array | number[];
        model?: string;
      };
    }
  | { command: "photos/health"; payload?: Record<string, never> };

/** 统一信封：{ ok:true, value } | { ok:false, error, message, detail? }。 */
export type OpenArcPhotosResult<T = unknown> = OpenArcSuccess<T> | OpenArcFailure;

export interface OpenArcPhotosBridge extends OpenArcCommandBridge {
  command: (command: OpenArcPhotosCommandRequest) => Promise<OpenArcPhotosResult<unknown>>;
}

/**
 * 0.6.2 PhotoCraft（图像工坊）域：项目 / 分组 / 源文件 / 导出 / 剪贴板 / 回收站。
 *
 * 唯一入口 command({ command, payload })（受控白名单，见 electron/photocraft-domain.cjs 的
 * PHOTOCRAFT_COMMANDS）。项目落 dxos 虚拟树，visibility 三态 private / public / restricted；
 * 写操作（update / writeSource / export / saveClipboardTemp / trash / restore / purge）严格等价 owner。
 * 白名单里另有 projects/saveBundle 与 projects/save-bundle 两条保留命令，固定回
 * PHOTOCRAFT_UNSUPPORTED（由 file-transfer 域承接），不在此桥的推荐命令面内。
 * 失败形状是统一信封 { ok:false, error, message, detail? }，error 取 PHOTOCRAFT_*。
 */
export type OpenArcPhotoCraftCommand =
  | "photocraft/projects/list"
  | "photocraft/projects/create"
  | "photocraft/projects/get"
  | "photocraft/projects/update"
  | "photocraft/projects/trash"
  | "photocraft/projects/restore"
  | "photocraft/projects/purge"
  | "photocraft/projects/readSource"
  | "photocraft/projects/writeSource"
  | "photocraft/projects/export"
  | "photocraft/projects/saveClipboardTemp"
  | "photocraft/trash/list"
  | "photocraft/groups/create"
  | "photocraft/groups/remove";

/** PhotoCraft 域自有错误码（electron/photocraft-domain.cjs:PHOTOCRAFT_ERROR_CODES）。 */
export type OpenArcPhotoCraftErrorCode =
  | "PHOTOCRAFT_COMMAND_NOT_ALLOWED"
  | "PHOTOCRAFT_INVALID_INPUT"
  | "PHOTOCRAFT_UNAUTHENTICATED"
  | "PHOTOCRAFT_NOT_FOUND"
  | "PHOTOCRAFT_FORBIDDEN"
  | "PHOTOCRAFT_CONFLICT"
  | "PHOTOCRAFT_TOO_LARGE"
  | "PHOTOCRAFT_UNSUPPORTED"
  | "PHOTOCRAFT_NOT_READY"
  | "PHOTOCRAFT_INTERNAL";

/** dxos 虚拟树节点（非宿主路径；宿主绝对路径从不过桥）。 */
export interface OpenArcPhotoCraftFsNode {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  ownerId?: string | null;
  mime?: string;
  size?: number;
  content?: string;
  blobSha256?: string;
  created_ts?: number;
  updated_ts?: number;
  trashed?: boolean;
  system?: boolean;
  share?: string;
}
/** 项目可见性（源三态）。 */
export type OpenArcPhotoCraftVisibility = "private" | "public" | "restricted";
/** 项目 summary（electron/photocraft-domain.cjs:buildProjectSummary 逐字投影）。 */
export interface OpenArcPhotoCraftProject {
  id: string;
  groupId: string;
  ownerId: string;
  ownerName: string;
  title: string;
  visibility: OpenArcPhotoCraftVisibility;
  members: string[];
  mine: boolean;
  access: "owner" | "read";
  sourceNodeId: string | null;
  sourceName: string;
  sourceMime: string;
  sourceSize: number;
  sourceSha256: string;
  previewSha256: string;
  previewUrl: string;
  statePath: string;
  createdAt: number;
  updatedAt: number;
  /** 仅回收站中的项目带该字段。 */
  deletedAt?: number;
  /** 仅 projects/get 额外注入：宿主可读的源文件 URL。 */
  sourceUrl?: string;
}
export interface OpenArcPhotoCraftGroup {
  id: string;
  name: string;
  mine: boolean;
  isDefault: boolean;
}
export interface OpenArcPhotoCraftWorkspaceValue {
  projects: OpenArcPhotoCraftProject[];
  groups: OpenArcPhotoCraftGroup[];
}
export interface OpenArcPhotoCraftProjectValue { project: OpenArcPhotoCraftProject; }
export interface OpenArcPhotoCraftCreateValue {
  project: OpenArcPhotoCraftProject;
  source: OpenArcPhotoCraftFsNode | null;
}
export interface OpenArcPhotoCraftSourceValue {
  name: string;
  mime: string;
  size: number;
  sha256: string;
  base64: string;
}
export interface OpenArcPhotoCraftWriteSourceValue {
  node: OpenArcPhotoCraftFsNode;
  project: OpenArcPhotoCraftProject;
}
export interface OpenArcPhotoCraftExportValue {
  node: OpenArcPhotoCraftFsNode;
  project: OpenArcPhotoCraftProject;
}
export interface OpenArcPhotoCraftClipboardValue { node: OpenArcPhotoCraftFsNode; }
export interface OpenArcPhotoCraftTrashListValue { projects: OpenArcPhotoCraftProject[]; }
export interface OpenArcPhotoCraftGroupCreateValue { group: OpenArcPhotoCraftFsNode; }
export interface OpenArcPhotoCraftGroupRemoveValue {
  deleted: string;
  moved: number;
  fallbackGroupId: string;
}
/** 命令 → 成功 value 的逐字映射；trash / restore / purge 成功回空对象。 */
export interface OpenArcPhotoCraftValueByCommand {
  "photocraft/projects/list": OpenArcPhotoCraftWorkspaceValue;
  "photocraft/projects/create": OpenArcPhotoCraftCreateValue;
  "photocraft/projects/get": OpenArcPhotoCraftProjectValue;
  "photocraft/projects/update": OpenArcPhotoCraftProjectValue;
  "photocraft/projects/trash": Record<string, never>;
  "photocraft/projects/restore": Record<string, never>;
  "photocraft/projects/purge": Record<string, never>;
  "photocraft/projects/readSource": OpenArcPhotoCraftSourceValue;
  "photocraft/projects/writeSource": OpenArcPhotoCraftWriteSourceValue;
  "photocraft/projects/export": OpenArcPhotoCraftExportValue;
  "photocraft/projects/saveClipboardTemp": OpenArcPhotoCraftClipboardValue;
  "photocraft/trash/list": OpenArcPhotoCraftTrashListValue;
  "photocraft/groups/create": OpenArcPhotoCraftGroupCreateValue;
  "photocraft/groups/remove": OpenArcPhotoCraftGroupRemoveValue;
}

export type OpenArcPhotoCraftCommandRequest =
  | { command: "photocraft/projects/list"; payload?: Record<string, never> }
  | {
      command: "photocraft/projects/create";
      payload: { title?: string; name?: string; groupId?: string | null; mime?: string; content?: string | Uint8Array };
    }
  | { command: "photocraft/projects/get"; payload: { id: string } }
  | {
      command: "photocraft/projects/update";
      payload: { id: string; title?: string; groupId?: string; visibility?: OpenArcPhotoCraftVisibility; members?: string[] };
    }
  | { command: "photocraft/projects/trash"; payload: { id: string } }
  | { command: "photocraft/projects/restore"; payload: { id: string } }
  | { command: "photocraft/projects/purge"; payload: { id: string } }
  | { command: "photocraft/projects/readSource"; payload: { id: string } }
  | { command: "photocraft/projects/writeSource"; payload: { id: string; name?: string; mime?: string; content: string | Uint8Array } }
  | { command: "photocraft/projects/export"; payload: { id: string; name?: string; mime?: string; content: string | Uint8Array } }
  | { command: "photocraft/projects/saveClipboardTemp"; payload: { id: string; name?: string; mime?: string; content: string | Uint8Array } }
  | { command: "photocraft/trash/list"; payload?: Record<string, never> }
  | { command: "photocraft/groups/create"; payload: { name: string } }
  | { command: "photocraft/groups/remove"; payload: { id: string } };

/** 统一信封：{ ok:true, value } | { ok:false, error, message, detail? }。 */
export type OpenArcPhotoCraftResult<T = unknown> = OpenArcSuccess<T> | OpenArcFailure;

export interface OpenArcPhotoCraftBridge extends OpenArcCommandBridge {
  command: (command: OpenArcPhotoCraftCommandRequest) => Promise<OpenArcPhotoCraftResult<unknown>>;
}

/**
 * 0.6.2 应用互传域：targets / get / inspect / exchange / appExchange-images。
 *
 * 唯一入口 command({ command, payload })（受控白名单，见 electron/app-exchange-domain.cjs 的
 * APP_EXCHANGE_COMMANDS）。两条 JSON 命令只传引用（nodeId / canvasId / photoCraftProjectId），
 * 出现 bytes / url / path 等字节或 URL 字段一律 APP_EXCHANGE_BYTES_NOT_ALLOWED；
 * appExchange-images 是唯一允许字节的通道。target 表的 dev-photocraft 已映射为 image-studio
 * （sourceAppId / sourceTitle 保留为只读备注）。失败形状是统一信封
 * { ok:false, error, message, detail? }，error 取 APP_EXCHANGE_*。
 */
export type OpenArcAppExchangeCommand =
  | "appExchange/targets"
  | "appExchange/get"
  | "appExchange/exchange"
  | "appExchange/inspect"
  | "appExchange-images";

/** 应用互传域自有错误码（electron/app-exchange-domain.cjs:APP_EXCHANGE_ERROR_CODES）。 */
export type OpenArcAppExchangeErrorCode =
  | "APP_EXCHANGE_COMMAND_NOT_ALLOWED"
  | "APP_EXCHANGE_INVALID_INPUT"
  | "APP_EXCHANGE_UNAUTHENTICATED"
  | "APP_EXCHANGE_NOT_FOUND"
  | "APP_EXCHANGE_CONFLICT"
  | "APP_EXCHANGE_FORBIDDEN"
  | "APP_EXCHANGE_TARGET_UNSUPPORTED"
  | "APP_EXCHANGE_BYTES_NOT_ALLOWED"
  | "APP_EXCHANGE_STALE_REVISION"
  | "APP_EXCHANGE_TOO_LARGE"
  | "APP_EXCHANGE_IMAGE_INVALID"
  | "APP_EXCHANGE_IMAGE_ENGINE_UNAVAILABLE"
  | "APP_EXCHANGE_DEPENDENCY_UNAVAILABLE"
  | "APP_EXCHANGE_NOT_READY"
  | "APP_EXCHANGE_INTERNAL";

export interface OpenArcAppExchangeTarget {
  appId: string;
  title: string;
  action: string;
  accepts: string[];
  creates: string;
  sourceAppId: string;
  sourceTitle: string;
  mapping: string;
  mappingNote: string;
}
export interface OpenArcAppExchangeCanvasRef { id: string; title: string; }
export interface OpenArcAppExchangeTargetsValue {
  version: number;
  targets: OpenArcAppExchangeTarget[];
  canvases: OpenArcAppExchangeCanvasRef[];
}
export interface OpenArcAppExchangeRequestPayload {
  requestId: string;
  target: { appId: string; action: string; projectId?: string };
  asset: {
    nodeId: string;
    canvasId?: string;
    photoCraftProjectId?: string;
    revision?: string;
  };
}
export interface OpenArcAppExchangeTargetRef {
  appId: string;
  projectId: string;
  cardId?: string;
  assetNodeId?: string;
}
export interface OpenArcAppExchangeSourceRef {
  nodeId: string;
  canvasId?: string;
  photoCraftProjectId?: string;
  revision: string;
}
export interface OpenArcAppExchangeAssetSummary { name: string; mime: string; size: number; sha256: string; }
export interface OpenArcAppExchangeResultValue {
  id: string;
  status: "completed";
  target: OpenArcAppExchangeTargetRef;
  source: OpenArcAppExchangeSourceRef;
  asset: OpenArcAppExchangeAssetSummary;
  createdAt: number;
}
export interface OpenArcAppExchangeInspectValue {
  asset: { nodeId: string; name: string; size: number; mime: string; revision: string };
}
export interface OpenArcAppExchangeImageUploadValue { asset: { nodeId: string }; }
/** 命令 → 成功 value 的逐字映射。 */
export interface OpenArcAppExchangeValueByCommand {
  "appExchange/targets": OpenArcAppExchangeTargetsValue;
  "appExchange/get": OpenArcAppExchangeResultValue;
  "appExchange/exchange": OpenArcAppExchangeResultValue;
  "appExchange/inspect": OpenArcAppExchangeInspectValue;
  "appExchange-images": OpenArcAppExchangeImageUploadValue;
}

export type OpenArcAppExchangeCommandRequest =
  | { command: "appExchange/targets"; payload?: Record<string, never> }
  | { command: "appExchange/get"; payload: { id: string } }
  | { command: "appExchange/exchange"; payload: OpenArcAppExchangeRequestPayload }
  | {
      command: "appExchange/inspect";
      payload: { asset: { nodeId: string; canvasId?: string; photoCraftProjectId?: string; revision?: string } };
    }
  | {
      command: "appExchange-images";
      payload: {
        mime: string;
        name?: string;
        bytes?: Uint8Array | number[] | ArrayBuffer;
        data?: string;
        encoding?: "base64";
      };
    };

/** 统一信封：{ ok:true, value } | { ok:false, error, message, detail? }。 */
export type OpenArcAppExchangeResult<T = unknown> = OpenArcSuccess<T> | OpenArcFailure;

export interface OpenArcAppExchangeBridge extends OpenArcCommandBridge {
  command: (command: OpenArcAppExchangeCommandRequest) => Promise<OpenArcAppExchangeResult<unknown>>;
}

/**
 * 0.6.1 CLI 域：list / status / models / credit / login/start / login/status / logout。
 *
 * 唯一入口 command({ command, payload })（受控白名单，见 electron/cli-domain.cjs 的 CLI_COMMANDS）；
 * 四个工具 codex / gemini / jimeng / pippit：codex 与 gemini 没有 credit，gemini 没有 logout ——
 * 对不支持的子能力一律回 CLI_UNSUPPORTED，绝不伪造成功。未安装回 CLI_UNAVAILABLE
 * （detail 保留既有探测说明）；已确认执行失败 CLI_FAILED；会话未认证 CLI_UNAUTHENTICATED；
 * 未知异常折叠为 DXOS_ERR_INTERNAL。
 */
export type OpenArcCliTool = "codex" | "gemini" | "jimeng" | "pippit";

export type OpenArcCliCommand =
  | "cli/list"
  | "cli/status"
  | "cli/models"
  | "cli/credit"
  | "cli/login/start"
  | "cli/login/status"
  | "cli/logout";

/** CLI 域自有错误码（electron/cli-domain.cjs:CLI_ERROR_CODES）。 */
export type OpenArcCliErrorCode =
  | "CLI_COMMAND_NOT_ALLOWED"
  | "CLI_NOT_READY"
  | "CLI_INVALID_INPUT"
  | "CLI_UNAVAILABLE"
  | "CLI_UNSUPPORTED"
  | "CLI_FAILED"
  | "CLI_UNAUTHENTICATED";

export interface OpenArcCliRuntime {
  command?: string;
  mode?: string;
  home?: string;
  label?: string;
  provider?: string;
}
export interface OpenArcCliToolSummary {
  id: OpenArcCliTool;
  name: string;
  installed: boolean;
  version: string | null;
  detail: string | null;
  capabilities: string[];
  loginRequired: boolean;
}
export interface OpenArcCliListValue { tools: OpenArcCliToolSummary[]; }
export interface OpenArcCliStatusValue {
  tool: OpenArcCliTool;
  installed: boolean;
  version: string | null;
  loggedIn: boolean | null;
  runtime?: OpenArcCliRuntime;
  detail: string | null;
}
export interface OpenArcCliModel { id: string; name: string; }
export interface OpenArcCliModelsValue { tool: OpenArcCliTool; models: OpenArcCliModel[]; cached?: boolean; }
export interface OpenArcCliCreditValue { tool: OpenArcCliTool; credit: unknown; }
export interface OpenArcCliLoginStartValue { tool: OpenArcCliTool; started: true; url?: string; code?: string; detail: string; }
export interface OpenArcCliLoginStatusValue { tool: OpenArcCliTool; status: "idle" | "pending" | "authorized" | "failed"; detail: string; }
export interface OpenArcCliLogoutValue { tool: OpenArcCliTool; loggedOut: true; }

/** 命令 → 成功 value 的逐字映射。 */
export interface OpenArcCliValueByCommand {
  "cli/list": OpenArcCliListValue;
  "cli/status": OpenArcCliStatusValue;
  "cli/models": OpenArcCliModelsValue;
  "cli/credit": OpenArcCliCreditValue;
  "cli/login/start": OpenArcCliLoginStartValue;
  "cli/login/status": OpenArcCliLoginStatusValue;
  "cli/logout": OpenArcCliLogoutValue;
}

export type OpenArcCliCommandRequest =
  | { command: "cli/list"; payload?: Record<string, never> }
  | { command: "cli/status"; payload: { tool: OpenArcCliTool } }
  | { command: "cli/models"; payload: { tool: OpenArcCliTool } }
  | { command: "cli/credit"; payload: { tool: OpenArcCliTool } }
  | { command: "cli/login/start"; payload: { tool: OpenArcCliTool } }
  | { command: "cli/login/status"; payload: { tool: OpenArcCliTool } }
  | { command: "cli/logout"; payload: { tool: OpenArcCliTool } };

/** 统一信封：{ ok:true, value } | { ok:false, error, message, detail? }。 */
export type OpenArcCliResult<T = unknown> = OpenArcSuccess<T> | OpenArcFailure;

export interface OpenArcCliBridge extends OpenArcCommandBridge {
  command: (command: OpenArcCliCommandRequest) => Promise<OpenArcCliResult<unknown>>;
}

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
  /** 0.6.1：系统字体域（与 preload.cjs 第 30 个顶层键 systemFonts 一一对应）。 */
  systemFonts?: OpenArcSystemFontsBridge;
  /** 0.6.1：OCR 域（第 31 个顶层键 ocr）。 */
  ocr?: OpenArcOcrBridge;
  /** 0.6.1：文件传输域（第 32 个顶层键 fileTransfer）。 */
  fileTransfer?: OpenArcFileTransferBridge;
  /** 0.6.1：codex-canvas 域（第 33 个顶层键 codexCanvas）。 */
  codexCanvas?: OpenArcCodexCanvasBridge;
  /** 0.6.1：本机代理探测域（第 34 个顶层键 desktop）。 */
  desktop?: OpenArcDesktopBridge;
  /** 0.6.2：photos 域（与 preload.cjs 第 35 个顶层键 photos 一一对应）。 */
  photos?: OpenArcPhotosBridge;
  /** 0.6.2：PhotoCraft 域（第 36 个顶层键 photocraft）。 */
  photocraft?: OpenArcPhotoCraftBridge;
  /** 0.6.2：应用互传域（第 37 个顶层键 appExchange）。 */
  appExchange?: OpenArcAppExchangeBridge;
  /** 0.6.1：CLI 域（第 38 个顶层键 cli，对齐 DX OS /api/cli/*）。 */
  cli?: OpenArcCliBridge;
  /** Stage 1：画布在线更新域（第 39 个顶层键 marketUpdate；命令通道复用 market:command）。 */
  marketUpdate?: OpenArcMarketUpdateBridge;
}

declare global {
  interface Window {
    openarc?: OpenArcBridge;
  }
}
