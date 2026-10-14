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

/** 本页会发出的命令（mcp:command 白名单的子集，逐条对齐 mcp-bootstrap.cjs 的 switch）。 */
export const MCP_CONSOLE_COMMANDS: readonly string[] = [
  "mcp/list",
  "mcp/get",
  "mcp/testLog",
  "mcp/agentTools",
];

/** mcp/agentTools 的载荷键：只有业务查询参数，身份字段由主进程注入。 */
export const MCP_AGENT_TOOLS_QUERY_KEYS: readonly string[] = ["serverId", "search"];

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
