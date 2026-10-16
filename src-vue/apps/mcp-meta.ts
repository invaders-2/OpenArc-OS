/**
 * MCP 中心共享元数据（对齐 src/mcp/McpCenter.tsx 的类型 / 文案 / 取值口径）。
 *
 * 这里只有类型、常量与纯函数，没有任何 UI；每条都从 React 真值源逐字搬运，
 * 包括「未登记状态照原样显示」「错误码 fallback」这类边界口径。
 */
export type Tone = "neutral" | "success" | "warning" | "danger";

export type McpTool = { name: string; description?: string; inputSchemaSummary?: string };

export type McpConnection = {
  connectionId: string;
  name?: string;
  transport?: string;
  location?: string;
  /* 契约 A 写的是 endpointJson / capabilitiesJson / toolsJson；
     主进程实现（electron/mcp-domain.cjs projectConnection）投影的是
     endpoint / capabilities / tools / toolsHidden。两边都读。 */
  endpointJson?: { serverKey?: string; url?: string; endpointScope?: string } | null;
  endpoint?: { serverKey?: string; url?: string; endpointScope?: string } | null;
  authMode?: string;
  credentialConfigured?: boolean;
  enabled?: boolean;
  status?: string;
  lastErrorCode?: string | null;
  protocolVersion?: string | null;
  serverName?: string | null;
  serverVersion?: string | null;
  capabilitiesJson?: unknown;
  capabilities?: unknown;
  toolsJson?: unknown;
  tools?: unknown;
  toolsHash?: string | null;
  visibility?: string;
  ownerUserId?: string | null;
  organizationId?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  lastConnectedAt?: number | null;
  toolsHidden?: boolean;
  toolsRedacted?: boolean;
  access?: {
    canView?: boolean;
    canUse?: boolean;
    canManage?: boolean;
    isOwner?: boolean;
    connectionScope?: string;
  } | null;
};

export type McpResult = Record<string, unknown> & { ok?: boolean; error?: unknown };

export type DetailState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ready"; connection: McpConnection }
  | { kind: "unauthorized"; code: string }
  | { kind: "error"; code: string };

export type Failure = { code: string; context: string };

export type Form = {
  name: string;
  transport: "stdio" | "http";
  location: "LOCAL_DEVICE" | "REMOTE_SERVICE";
  serverKey: string;
  url: string;
  authMode: "NONE" | "BEARER";
  credentialSecret: string;
  visibility: "PERSONAL" | "ORGANIZATION";
};

export type DialogKind = "create" | "edit" | "delete" | null;

/** 契约 C：本地连接只接受白名单 serverKey（第一批只有这一个）。 */
export const LOCAL_SERVER_KEYS = ["openarc-test-echo"] as const;

export const TEST_LOG_LIMIT = 20;

/** 契约 A 的五个状态。未登记状态照原样显示，不塌缩成"统一不可用"。 */
export const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  DISABLED: { label: "已停用 DISABLED", tone: "neutral" },
  CONNECTING: { label: "连接中 CONNECTING", tone: "neutral" },
  READY: { label: "就绪 READY", tone: "success" },
  ERROR: { label: "错误 ERROR", tone: "danger" },
  AUTH_REQUIRED: { label: "需重新授权 AUTH_REQUIRED", tone: "warning" },
};

export const TRANSPORT_LABEL: Record<string, string> = {
  stdio: "stdio（本地进程）",
  http: "http（远程服务）",
};

/** 执行位置与传输是两根轴，分别显示，不合并。 */
export const LOCATION_LABEL: Record<string, string> = {
  LOCAL_DEVICE: "本地设备",
  REMOTE_SERVICE: "远程服务",
};

export const VISIBILITY_LABEL: Record<string, string> = {
  PERSONAL: "仅本人 PERSONAL",
  ORGANIZATION: "组织 ORGANIZATION",
};

export const AUTH_MODE_LABEL: Record<string, string> = {
  NONE: "无需授权 NONE",
  BEARER: "Bearer 凭据 BEARER",
};

export const SCOPE_LABEL: Record<string, string> = {
  LOCALHOST: "仅本机 LOCALHOST",
  LAN_EXPLICIT: "局域网（显式放开）LAN_EXPLICIT",
  REMOTE_HTTPS: "公网 HTTPS REMOTE_HTTPS",
};

/** 稳定错误码 → 人话（与 electron/mcp-domain.cjs 的 ERROR_CODE 逐条对齐）。 */
export const ERROR_LABEL: Record<string, string> = {
  MCP_CONNECTION_NOT_FOUND: "连接不存在，可能已被删除，或当前账号无权访问",
  MCP_COMMAND_NOT_ALLOWED: "命令不在 mcp:command 白名单内",
  MCP_INVALID_INPUT: "输入不完整或被拒绝",
  MCP_UNAUTHORIZED: "当前账号或该应用没有被授这个动作",
  MCP_LOCAL_SERVER_NOT_ALLOWED: "本地服务不在白名单：第一批只允许登记过的本地测试服务",
  MCP_ENDPOINT_BLOCKED: "端点被拒绝：只接受 http(s)，且禁止 file://、元数据地址、URL 内嵌凭据与明文远程",
  MCP_CONNECTION_DISABLED: "连接已停用：先「启用」再做连接 / 重连 / 测试",
  MCP_CONNECTION_BUSY: "该连接上已有一次握手在进行，稍后重试",
  MCP_PROTOCOL_ERROR: "MCP 协议错误：服务端没有按 JSON-RPC 2.0 响应",
  MCP_PROTOCOL_VERSION_UNSUPPORTED: "服务端协议版本不在受支持列表内",
  MCP_TIMEOUT: "服务端没有在限定时间内响应",
  MCP_UNREACHABLE: "连不上服务端（本地进程未起来，或远程不可达）",
  MCP_AUTH_REQUIRED: "认证失败，需要重新授权或更新凭据",
  MCP_CREDENTIAL_MISSING: "该连接声明需要 Bearer 凭据，但还没有可用的凭据",
  MCP_CREDENTIAL_STORE_UNAVAILABLE: "凭据存储不可用，无法保存或读取凭据",
  MCP_TOOL_DISCOVERY_FAILED: "tools/list 没有成功返回：工具清单未发现",
  MCP_TOOL_INVOCATION_NOT_ENABLED: "第一批不开放工具调用，这里只做连接管理与能力发现",
  MCP_RECONNECT_LIMIT: "重连次数已达上限，已停止重试（不空转）",
  MCP_SESSION_ENDED: "会话已结束（登出 / 锁屏 / 应用退出），连接已收掉；重新登录后可再次连接",
  MCP_INTERNAL_ERROR: "主进程内部错误",
  LOCAL_INPUT_REQUIRED: "名称不能为空（界面上先行拦截，没有发给后端）",
  RESPONSE_INCOMPLETE: "主进程返回的记录不完整，界面不猜内容",
  NO_BRIDGE: "桌面桥未接入（当前环境没有 MCP 域）",
  INTERNAL_ERROR: "主进程返回异常",
  SESSION_EXPIRED: "会话已过期，请重新登录",
  SESSION_REVOKED: "会话已失效，请重新登录",
};

/**
 * 后端以"拒绝"作答时，哪些码按「无权」渲染。
 * MCP_CONNECTION_NOT_FOUND 不在此列：主进程对"别人的个人连接"故意回这个码（不暴露存在）。
 */
export const AUTHORIZATION_CODES = new Set(["MCP_UNAUTHORIZED", "FORBIDDEN", "UNAUTHORIZED", "PERMISSION_DENIED"]);

/** status === "AUTH_REQUIRED" 是主路径，这两条错误码是兜底，避免入口消失。 */
export const AUTH_ERROR_CODES = new Set(["MCP_AUTH_REQUIRED", "MCP_CREDENTIAL_MISSING"]);

export const isAuthorizationCode = (code: string) => AUTHORIZATION_CODES.has(code);

export const errorText = (code: string) => ERROR_LABEL[code] || "MCP 操作失败";

export const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export const asText = (v: unknown, fallback = "—"): string => {
  if (typeof v === "string") return v.trim() ? v : fallback;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : fallback;
  if (typeof v === "boolean") return v ? "是" : "否";
  return fallback;
};

export const timeText = (ts: unknown): string => {
  const n = Number(ts);
  if (ts == null || !Number.isFinite(n)) return "—";
  return new Date(n).toLocaleString("zh-CN", { hour12: false });
};

/** 契约名优先，主进程实现名兜底。 */
export const endpointOf = (c: McpConnection | null): Record<string, unknown> => {
  const v = c ? (c.endpointJson ?? c.endpoint) : null;
  return isObject(v) ? v : {};
};

export const capabilitiesOf = (c: McpConnection | null): unknown =>
  c ? (c.capabilitiesJson ?? c.capabilities) : null;

export const toolsRawOf = (c: McpConnection | null): unknown => {
  const v = c ? (c.toolsJson ?? c.tools) : null;
  return Array.isArray(v) ? v : null;
};

export const toolsHiddenOf = (c: McpConnection | null): boolean =>
  !!c && (c.toolsHidden === true || c.toolsRedacted === true);

/** 协商是否已经发生过：没有协商结果时不假装"服务端没有能力"。 */
export const negotiatedOf = (c: McpConnection | null): boolean =>
  !!c && (c.protocolVersion != null || c.status === "READY");

export const toolsOf = (c: McpConnection | null): McpTool[] => {
  const raw = toolsRawOf(c);
  if (!raw) return [];
  return (raw as unknown[]).filter(isObject).map((t) => ({
    name: asText(t.name, "（未命名工具）"),
    description: typeof t.description === "string" ? t.description : undefined,
    inputSchemaSummary:
      typeof t.inputSchemaSummary === "string" ? t.inputSchemaSummary : undefined,
  }));
};

export const statusMeta = (status: unknown): { label: string; tone: Tone } => {
  const key = typeof status === "string" ? status : "";
  return STATUS_META[key] || { label: (key || "未知状态") + "（未登记）", tone: "neutral" };
};

/** 响应字段名未被契约钉死，按 device / model 的既有口径容错读取。 */
export const arrayOf = (res: McpResult, ...keys: string[]): unknown[] => {
  for (const k of keys) {
    const v = res[k];
    if (Array.isArray(v)) return v;
  }
  return [];
};

export const pickConnection = (res: McpResult): McpConnection | null => {
  for (const k of ["connection", "item", "record"]) {
    const v = res[k];
    if (isObject(v) && typeof v.connectionId === "string") return v as unknown as McpConnection;
  }
  if (typeof res.connectionId === "string") return res as unknown as McpConnection;
  return null;
};

export const emptyForm = (): Form => ({
  name: "",
  transport: "stdio",
  location: "LOCAL_DEVICE",
  serverKey: LOCAL_SERVER_KEYS[0],
  url: "",
  authMode: "NONE",
  credentialSecret: "",
  visibility: "PERSONAL",
});

/**
 * 从 token 读实际时长。必须读组件自己所在的元素，不能读 documentElement：
 * 产品内开关 .reduced 挂在 .desktop 上。减少动态效果下 --dur-* = 0ms。
 */
export const tokenMs = (el: HTMLElement | null, name: string): number => {
  if (!el || typeof window === "undefined") return 0;
  const raw = window.getComputedStyle(el).getPropertyValue(name).trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  if (raw.endsWith("ms")) return n;
  if (raw.endsWith("s")) return n * 1000;
  return n;
};

/** MCP capability 取值形态：true / {} / {listChanged:true} —— 原样翻译，不猜能力。 */
export const CAPABILITY_LABEL: Record<string, string> = {
  tools: "工具 tools",
  resources: "资源 resources",
  prompts: "提示模板 prompts",
  logging: "日志 logging",
  completions: "补全 completions",
  experimental: "实验特性 experimental",
};

export const CAPABILITY_FLAG_LABEL: Record<string, string> = {
  listChanged: "列表变更通知",
  subscribe: "支持订阅",
};

export const capabilityFlagText = (v: unknown): string => {
  if (v === true) return "支持";
  if (v === false || v == null) return "不支持";
  if (isObject(v)) {
    const on = Object.entries(v)
      .filter(([, x]) => x === true)
      .map(([k]) => CAPABILITY_FLAG_LABEL[k] || k);
    return on.length ? on.join(" · ") : "已声明，但没有开启子能力";
  }
  return asText(v);
};

/** 测试日志字段别名容错；一条都对不上时原样打印这一条。 */
export const LOG_KEYS = {
  time: ["at", "timestamp", "time", "startedAt", "createdAt"],
  phase: ["event", "phase", "stage", "step", "kind", "type"],
  level: ["level", "severity"],
  code: ["errorCode", "error", "code", "reason", "failureCode"],
  message: ["detail", "message", "summary", "text"],
  ok: ["ok", "success", "passed"],
};

export const LEVEL_LABEL: Record<string, string> = {
  INFO: "信息",
  WARN: "注意",
  WARNING: "注意",
  ERROR: "失败",
  DEBUG: "调试",
};

export const firstKey = (o: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = o[k];
    if (v == null || v === "") continue;
    if (typeof v === "number" || typeof v === "string") return String(v);
  }
  return null;
};

export const endpointText = (c: McpConnection | null): string => {
  if (!c) return "—";
  const ep = endpointOf(c);
  if (c.transport === "http") {
    const url = asText(ep.url, "（未记录端点）");
    const scope = asText(ep.endpointScope, "");
    return scope ? url + " · " + (SCOPE_LABEL[scope] || scope) : url;
  }
  const key = asText(ep.serverKey, "（未记录本地服务）");
  return "本地服务键 " + key + "（主进程映射到受控程序与固定参数）";
};
