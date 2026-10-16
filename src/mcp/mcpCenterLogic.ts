/**
 * UI-2b · MCP 中心：后端命令契约与展示投影的纯逻辑层（无 React / 无 DOM / 无 I/O）。
 *
 * 边界（本轮关键要求）：这里**不做任何工具聚合推导**。
 *   命名空间 fname、参数摘要 paramText、来源连接、风险等级与审批要求全部由主进程
 *   mcp/agentTools 给出（electron/mcp-bootstrap.cjs:115-172 / electron/mcp-tool-contract.cjs:39-45），
 *   渲染层只做字段校验、丢弃不完整行并把契约字段照实投影。
 *   旧派生（aggregateToolsOf / safeName / isConnectedStatus / paramSummaryText）已从
 *   src/mcp/McpCenter.tsx 删除；界面不再自己拼 mcp__<server>__<tool>，也不再自己算参数文案。
 *
 * 为什么单拆一层：命令白名单、字段契约、参数文案回归锚点、enabled=false 的提示文案
 * 都是可离线断言的规则，放 .tsx 里只能在浏览器里测（与 taskConsoleLogic / modelProtocolLogic 同口径）。
 */

/** 只读聚合命令：与 electron/mcp-bootstrap.cjs#handleAgentTools 同一条。 */
export const MCP_AGENT_TOOLS_COMMAND = "mcp/agentTools";

/**
 * 工具调用开关的**唯一写命令**（electron/mcp-bootstrap.cjs:282-303）：
 * trusted + risk=mcp.manage 授权 + 审计，落主进程的 userData 下 mcp.json，默认关闭。
 * 它不是调用入口：调用命令是 mcp/toolInvocation/call，界面**不发也不登记** ——
 * 这里只翻转"允许不允许发起"，每次调用仍要过审批。
 */
export const MCP_TOOL_SWITCH_COMMAND = "mcp/toolInvocation/set";

/** 本页会发出的命令（mcp:command 白名单的子集，逐条对齐 mcp-bootstrap.cjs 的 switch）。 */
export const MCP_CONSOLE_COMMANDS: readonly string[] = [
  "mcp/list",
  "mcp/get",
  "mcp/testLog",
  "mcp/agentTools",
  "mcp/toolInvocation/set",
];

/** mcp/agentTools 的载荷键：只有业务查询参数，身份字段由主进程注入。 */
export const MCP_AGENT_TOOLS_QUERY_KEYS: readonly string[] = ["serverId", "search"];

/** 开关写命令的载荷键：只有 enabled；身份字段由主进程注入，与 agentToolsQuery 同一口径。 */
export const MCP_TOOL_SWITCH_PAYLOAD_KEYS: readonly string[] = ["enabled"];

/** 未注入 agent-tools 端口时的稳定错误码（electron/mcp-domain.cjs:59）。 */
export const MCP_TOOL_DISCOVERY_FAILED = "MCP_TOOL_DISCOVERY_FAILED";

/** 外部 MCP 工具的固定风险等级（mcp-tool-contract.cjs:64）。 */
export const MCP_TOOL_RISK_EXTERNAL_SIDE_EFFECT = "EXTERNAL_SIDE_EFFECT";

export const isAllowedMcpCommand = (command: unknown): command is string =>
  typeof command === "string" && MCP_CONSOLE_COMMANDS.indexOf(command) >= 0;

export const isAllowedAgentToolsQueryKey = (key: unknown): key is string =>
  typeof key === "string" && MCP_AGENT_TOOLS_QUERY_KEYS.indexOf(key) >= 0;

/** 单条聚合工具：字段契约逐字对齐 mcp-bootstrap.cjs:156-166。 */
export type AgentToolRow = {
  fname: string;
  serverId: string;
  serverName: string;
  toolName: string;
  status: string;
  description: string;
  paramText: string;
  riskClass: string;
  requiresApproval: boolean;
};

/** mcp/agentTools 的界面投影（不新增、不改写任何后端字段语义）。 */
export type AgentToolsView = {
  ok: boolean;
  enabled: boolean;
  count: number;
  connectedServers: number;
  truncated: boolean;
  tools: AgentToolRow[];
  error: string | null;
  detail: string | null;
  /** 回包里被丢弃的不完整行数：不拿空数组冒充"没有工具"。 */
  invalidRows: number;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

const bool = (v: unknown): boolean => v === true;

/**
 * 把 mcp/agentTools 的回包投影成界面视图。
 *   · 成功：{ ok:true, enabled, count, connectedServers, truncated, tools:[...] }
 *   · 失败：{ ok:false, error:"MCP_TOOL_DISCOVERY_FAILED", detail }
 * tools 里缺 fname 的行无法与后端索引对上，直接丢弃并计数（invalidRows），
 * 不补默认名、不推断来源。count 取回包自报值，界面不重算。
 */
export function normalizeAgentToolsResult(raw: unknown): AgentToolsView {
  const res = isObject(raw) ? raw : {};
  const error = typeof res.error === "string" && res.error ? res.error : null;
  const detail = typeof res.detail === "string" && res.detail ? res.detail : null;
  const rows = Array.isArray(res.tools) ? res.tools : [];
  const tools: AgentToolRow[] = [];
  let invalidRows = 0;
  for (const item of rows) {
    if (!isObject(item)) {
      invalidRows += 1;
      continue;
    }
    const fname = str(item.fname);
    if (!fname) {
      invalidRows += 1;
      continue;
    }
    tools.push({
      fname,
      serverId: str(item.serverId),
      serverName: str(item.serverName),
      toolName: str(item.toolName),
      status: str(item.status),
      description: str(item.description),
      paramText: str(item.paramText),
      riskClass: str(item.riskClass),
      requiresApproval: bool(item.requiresApproval),
    });
  }
  return {
    ok: res.ok === true,
    enabled: bool(res.enabled),
    count: Number.isFinite(Number(res.count)) ? Number(res.count) : tools.length,
    connectedServers: Number.isFinite(Number(res.connectedServers)) ? Number(res.connectedServers) : 0,
    truncated: bool(res.truncated),
    tools,
    error,
    detail,
    invalidRows,
  };
}

/** 只带上行白名单键的查询对象：身份字段与未登记键一律丢弃。 */
export function agentToolsQuery(serverId?: string | null, search?: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const id = serverId == null ? "" : String(serverId).trim();
  if (id) out.serverId = id;
  if (search === true) out.search = true;
  return out;
}

/* ── 风险 / 审批：照后端 riskClass 与 requiresApproval 显示，不自己推断 ── */
export const AGENT_TOOL_RISK_LABEL: Record<string, string> = {
  EXTERNAL_SIDE_EFFECT: "外部副作用 EXTERNAL_SIDE_EFFECT",
};

export function agentToolRiskText(riskClass: unknown): string {
  const key = typeof riskClass === "string" ? riskClass : "";
  if (!key) return "风险等级未标注";
  return AGENT_TOOL_RISK_LABEL[key] || key + "（未登记风险等级）";
}

export function agentToolApprovalText(requiresApproval: unknown): string {
  if (requiresApproval === true) return "调用需逐次审批";
  if (requiresApproval === false) return "无需审批";
  return "审批要求未标注";
}

/** 审批语义说明：界面不提供直接调用按钮，调用走审批链。 */
export const AGENT_TOOLS_BOUNDARY =
  "只读展示：工具清单、命名空间与参数摘要都来自主进程 mcp/agentTools；界面不提供任何「运行工具 / 调用工具」入口，调用一律走审批（ControlledToolProxy / SideEffectRuntime），本页只展示与提示。";

/** enabled=false 的明确提示：说清"默认关闭"意味着什么。 */
export const AGENT_TOOLS_DISABLED_TEXT =
  "工具调用默认关闭：Agent 侧会看到这些工具，但一次都不会真的执行；开启后每次调用仍要单独通过审批。界面不提供直接调用的按钮。";

export const AGENT_TOOLS_ENABLED_TEXT =
  "工具调用开关当前已开启：清单可见，但每一次调用仍要单独通过审批，界面不提供直接调用的按钮。";

/** 开关状态 → 可见提示；未知状态（回包缺字段）照实说"未返回"。 */
export function agentToolsInvocationText(enabled: unknown): string {
  if (enabled === true) return AGENT_TOOLS_ENABLED_TEXT;
  if (enabled === false) return AGENT_TOOLS_DISABLED_TEXT;
  return "工具调用开关状态未返回：界面不假设它开着或关着。";
}

export function agentToolsEmptyText(connectedServers: unknown): string {
  return Number(connectedServers) > 0
    ? "已连接的服务还没有工具快照：连接成功后由 tools/list 分页发现。"
    : "还没有已连接（READY）的服务，所以工具聚合为空；连接成功后由 tools/list 发现。";
}

/** 三种参数文案的第三种（空回包）逐字沿用旧派生：与 mcp-tool-contract.cjs:42 相同。 */
export const MCP_TOOL_PARAM_EMPTY_TEXT = "未返回参数摘要（服务端未提供 inputSchema）";

/**
 * 参数文案：只用于把回包里的 paramText 空值转成可见占位。
 * 三种真实文案（空对象 / 未返回 / 原文）由后端 mcp-tool-contract.cjs#paramSummaryText 给出，
 * 渲染层**不再**计算（回归锚点见 tests/dxos-mcp-center.test.mjs）。
 */
export function agentToolParamText(paramText: unknown): string {
  const text = typeof paramText === "string" ? paramText : "";
  return text || MCP_TOOL_PARAM_EMPTY_TEXT;
}

export function agentToolsDetailText(view: AgentToolsView): string {
  if (view.detail) return view.detail;
  if (view.error) return view.error;
  return "主进程没有给出更多说明。";
}

/* ══════════════════════════════════════════════════════════════════════════
   UI-3 · 工具调用开关：读（mcp/agentTools.enabled）+ 写（mcp/toolInvocation/set）
   ──────────────────────────────────────────────────────────────────────────
   这一层只做三件可离线断言的事：
     ① 把"读到的 enabled + 读到/没读到"映射成显式状态（加载 / 就绪 / 越权 /
        依赖缺失 / 错误），界面不自己当权限权威；
     ② 把写回包投影成 { ok, enabled, persisted, audited, error, detail }，
        并明确：**回包没给布尔就是 null** —— 界面绝不做乐观翻转；
     ③ 错误码 → 人话文案（含"状态没有改变"这一事实，禁止夸大后果）。
   界面不提供任何"直接调用工具"的入口：调用命令不在这里出现（见单测源码级断言）。
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 读侧状态码里按"未登录 / 越权"渲染的集合。
 * MCP_UNAUTHORIZED 是后端主路径；后三个是渲染层既有的会话码（ERROR_LABEL 同口径）。
 */
export const TOOL_SWITCH_UNAUTHORIZED_CODES: readonly string[] = [
  "MCP_UNAUTHORIZED",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "PERMISSION_DENIED",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
];

export function isToolSwitchUnauthorized(code: unknown): boolean {
  return typeof code === "string" && TOOL_SWITCH_UNAUTHORIZED_CODES.indexOf(code) >= 0;
}

/**
 * 读侧状态：显式五分支，未知状态不塌缩成"关着"。
 * 加载中与"还没读到"分开；依赖缺失（MCP_TOOL_DISCOVERY_FAILED）单列，因为它不是权限问题。
 */
export type ToolSwitchReadState =
  | { kind: "loading" }
  | { kind: "ready"; enabled: boolean }
  | { kind: "unauthorized"; code: string }
  | { kind: "unavailable"; code: string }
  | { kind: "error"; code: string };

export function toolSwitchReadState(
  view: AgentToolsView | null,
  loading: boolean,
): ToolSwitchReadState {
  if (!view) return loading ? { kind: "loading" } : { kind: "error", code: "RESPONSE_INCOMPLETE" };
  if (view.ok) return { kind: "ready", enabled: view.enabled };
  const code = view.error || "INTERNAL_ERROR";
  if (isToolSwitchUnauthorized(code)) return { kind: "unauthorized", code };
  if (code === MCP_TOOL_DISCOVERY_FAILED) return { kind: "unavailable", code };
  return { kind: "error", code };
}

/**
 * 写回包投影（mcp/toolInvocation/set，electron/mcp-bootstrap.cjs:282-303）。
 * enabled 只在后端明确回了布尔时才是布尔；其余一律 null —— 这是"不乐观切换"的根据。
 */
export type ToolSwitchWriteResult = {
  ok: boolean;
  enabled: boolean | null;
  persisted: boolean;
  audited: boolean;
  error: string | null;
  detail: string | null;
};

export function normalizeToolSwitchResult(raw: unknown): ToolSwitchWriteResult {
  const res = isObject(raw) ? raw : {};
  return {
    ok: res.ok === true,
    enabled: typeof res.enabled === "boolean" ? res.enabled : null,
    persisted: res.persisted === true,
    audited: res.audited === true,
    error: typeof res.error === "string" && res.error ? res.error : null,
    detail: typeof res.detail === "string" && res.detail ? res.detail : null,
  };
}

/** 开关写命令的载荷：只带 enabled 布尔，身份字段与未登记键一律丢弃。 */
export function toolSwitchPayload(enabled: unknown): { enabled: boolean } {
  return { enabled: enabled === true };
}

/** 只有读到明确状态才允许写：状态未知/越权/依赖缺失时不发写命令。 */
export function toolSwitchNextValue(state: ToolSwitchReadState): boolean | null {
  return state.kind === "ready" ? !state.enabled : null;
}

/** 开关控件的可见文案：说清"按下去会发生什么"，不靠颜色表达当前态。 */
export function toolSwitchToggleText(enabled: boolean): string {
  return enabled ? "关闭工具调用开关" : "打开工具调用开关";
}

/** 状态行文案（role=status 播报）：每种状态都有话，避免"只剩一个颜色点"。 */
export function toolSwitchStateText(state: ToolSwitchReadState): string {
  switch (state.kind) {
    case "loading":
      return "正在读取开关状态…";
    case "ready":
      return state.enabled
        ? "当前：已打开 —— 允许发起调用，每次仍要单独审批"
        : "当前：已关闭（默认）—— 不会发起任何工具调用";
    case "unauthorized":
      return "当前账号无权查看或修改这个开关";
    case "unavailable":
      return "开关依赖缺失：主进程没有注入工具聚合端口";
    default:
      return "开关状态未知：界面不猜它开着还是关着";
  }
}

/**
 * 写侧错误码 → 人话。全部以"状态没有改变"收尾：未落盘的开关变更不产生任何后果，
 * 也不把它说成"调用被阻止"之类的戏剧化结论。未登记的码原样带出。
 */
export const TOOL_SWITCH_ERROR_LABEL: Record<string, string> = {
  MCP_INVALID_INPUT: "开关请求形状不对（enabled 必须是布尔）：状态没有改变",
  MCP_COMMAND_NOT_ALLOWED: "命令不在 mcp:command 白名单内：状态没有改变",
  MCP_UNAUTHORIZED: "当前账号没有管理 MCP 的权限（mcp.manage）：状态没有改变",
  MCP_SWITCH_UNAVAILABLE: "开关无法落盘（缺少可写的配置目录）：状态没有改变",
  MCP_AUDIT_UNAVAILABLE: "审计不可用，拒绝无审计的开关变更：状态没有改变",
  MCP_TOOL_DISCOVERY_FAILED: "工具聚合端口未注入（依赖缺失）：读不到开关状态，也没有做任何更改",
  MCP_INTERNAL_ERROR: "主进程内部错误：状态没有改变",
  RESPONSE_INCOMPLETE: "主进程没有返回开关状态：界面不猜，状态没有改变",
  NO_BRIDGE: "桌面桥未接入（当前环境没有 MCP 域）：状态没有改变",
  INTERNAL_ERROR: "主进程返回异常：状态没有改变",
  SESSION_EXPIRED: "会话已过期，请重新登录；状态没有改变",
  SESSION_REVOKED: "会话已失效，请重新登录；状态没有改变",
};

export function toolSwitchErrorText(code: unknown): string {
  const key = typeof code === "string" && code ? code : "INTERNAL_ERROR";
  return TOOL_SWITCH_ERROR_LABEL[key] || "开关未完成（" + key + "）：状态没有改变";
}

/** 开关风险与机制的显式说明：默认关闭的含义 + 逐次审批 + 定时任务未开放。 */
export const TOOL_SWITCH_RISK_TEXT =
  "这个开关决定 Agent 能不能发起 MCP 工具调用，默认关闭：关着的时候，即使 Agent 看得到工具，一次都不会真的执行。打开只放开“允许发起”这一步，每次调用仍然要单独通过审批（走既有审批权威，没有批准就不会外发）。无人值守的定时任务暂不开放，目前只覆盖有人在场的调用。";

/** 产品边界：本区块只有开关，没有直接调用入口。 */
export const TOOL_SWITCH_BOUNDARY_TEXT =
  "这里只提供开关，不提供任何「直接运行工具 / 调用工具」的入口：调用一律经既有审批链（ControlledToolProxy / SideEffectRuntime），未批准不会外发。";
