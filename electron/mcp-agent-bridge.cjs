"use strict";
/**
 * B4 收口 · MCP → Agent 工具目录的只读装配桥。
 *
 * 为什么单独一层：
 *   D5-03 的 MCP 域已经有真实连接目录（electron/mcp-bootstrap.cjs:23 createMcpBundle →
 *   McpService.listConnections，mcp-service.cjs:147），而 B4d 的 createMcpAgentTools
 *   （electron/mcp-agent-tools.cjs:470）要的 servers 端口形状是
 *   { list(): [{ id, name, enabled, status, tools:[{name,description,inputSchema}] }] }。
 *   两者不是同一投影：MCP 域用 connectionId / STATUS.READY / tools[].inputSchemaSummary，
 *   catalog 只认 id / status==='connected' / tools[].inputSchema（agent-tool-catalog.cjs:262-272、:333-358）。
 *   本桥只做**字段等价翻译**，不新建 MCP 连接模型、不复制授权判定、不落盘、不联网。
 *
 * 边界（与 B4d 一致，一条都不放宽）：
 *   · 目录只读：list() 调 mcpService.listConnections（沿用 D5-03 的 app grant 与可见性判定），
 *     无 session / 无授权时返回空数组并记录原因，绝不用原始数据库行绕过授权。
 *   · 工具调用：本桥默认不注入 transport / clientFor → createMcpAgentTools 的 invokeRemote
 *     返回结构化 MCP_TOOL_INVOCATION_NOT_ENABLED（mcp-agent-tools.cjs:575-579）；
 *     审批端口（approval）未注入时 requestApproval 先 fail closed（mcp-agent-tools.cjs:534-535），
 *     远端调用次数为 0。本桥不修改 electron/mcp-client.cjs 的产品边界。
 *   · 工具入参 schema：MCP 域落库时只保留 inputSchemaSummary（mcp-domain.cjs:157-177 sanitizeTool），
 *     完整 inputSchema 不持久化 → 这里照实不补 schema，catalog 落到空对象 schema，绝不伪造参数。
 */
const { createMcpAgentTools, isConnectedStatus } = require("./mcp-agent-tools.cjs");

/** MCP 中心的承载 App Principal；与 mcp-bootstrap.cjs:21 同一约定（不复制第二套常量）。 */
const MCP_HOST_APP_ID = "mcp-center";

/**
 * McpService 投影（mcp-domain.cjs:281-307 projectConnection）→ catalog / createMcpAgentTools 的 server 行。
 *   · status：MCP 域的就绪态是 'READY'（mcp-domain.cjs:25），catalog 的 connected 判据是 'connected'
 *     （agent-tool-catalog.cjs:267 / :337）→ 只把 READY 翻译成 connected，其余状态原样保留；
 *   · toolsHidden=true（App 只有 mcp.view 没有 mcp.use）→ tools 置空，不产出可执行工具。
 */
function projectMcpServer(projected) {
  if (!projected || typeof projected !== "object") return null;
  const id = projected.connectionId == null ? "" : String(projected.connectionId);
  if (!id) return null;
  const toolsHidden = projected.toolsHidden === true;
  const connected = projected.enabled === true && isConnectedStatus(projected.status);
  const tools = toolsHidden || !Array.isArray(projected.tools) ? [] : projected.tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || !tool.name) return [];
    return [{
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      // 只有服务端真回过完整 schema 时才带（当前落库路径不带），不猜、不补。
      ...(tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
      ...(typeof tool.inputSchemaSummary === "string" ? { inputSchemaSummary: tool.inputSchemaSummary } : {}),
    }];
  });
  return {
    id,
    name: projected.name == null ? "" : String(projected.name),
    serverName: projected.serverName || null,
    enabled: projected.enabled === true,
    connected,
    status: connected ? "connected" : String(projected.status || "DISABLED"),
    toolsVisible: !toolsHidden,
    tools,
  };
}

/**
 * 装配 MCP → Agent 桥。
 *
 * @param {object} options
 * @param {object} options.mcpService  McpService 实例（必须有同步方法 listConnections）；
 *   缺失或形状不符 → 返回 null（调用方据此保持 catalog mcp 来源 available:false，不伪造）。
 * @param {() => object} [options.context]  调用时求值的可信上下文（sessionRef / appId）；
 *   sessionRef 只由宿主从已认证身份推导（main.cjs 的 identity.service.current），渲染层给不了。
 * @param {string} [options.hostAppId]  查询连接目录所用的 App Principal（默认 mcp-center）。
 * @param {object} [options.approval]  B4d 审批端口；不注入 = fail closed（0 次传输）。
 * @param {object} [options.transport] / [options.clientFor]  tools/call 传输端口；
 *   生产不注入（产品边界仍是 MCP_TOOL_INVOCATION_NOT_ENABLED），仅测试可注入以观察调用次数。
 * @returns {{ mcpAgentTools: object, mcpServersSnapshot: () => object[], serversPort: object, snapshot: () => object, statusReason: () => string|null }|null}
 */
function createMcpAgentBridge({ mcpService = null, context = null, hostAppId = MCP_HOST_APP_ID, approval = null, transport = null, clientFor = null, systemServerIds = null, clock = null, logger = null } = {}) {
  if (!mcpService || typeof mcpService.listConnections !== "function") return null;
  const contextOf = () => {
    const base = typeof context === "function" ? context() : context;
    const value = base && typeof base === "object" ? base : {};
    return { ...value, appId: value.appId || hostAppId };
  };

  let lastReason = null;
  /** 同步快照（catalog 的 sourceList 不 await，agent-tool-catalog.cjs:62-65）。 */
  function snapshot() {
    let result;
    try {
      result = mcpService.listConnections({ context: contextOf() });
    } catch {
      lastReason = "MCP_SNAPSHOT_FAILED";
      return { ok: false, rows: [], reason: lastReason };
    }
    if (!result || result.ok !== true) {
      lastReason = (result && result.error) || "MCP_UNAUTHORIZED";
      return { ok: false, rows: [], reason: lastReason };
    }
    lastReason = null;
    const rows = (Array.isArray(result.items) ? result.items : []).map(projectMcpServer).filter(Boolean);
    return { ok: true, rows, reason: null };
  }
  function list() { return snapshot().rows; }

  const serversPort = { list };
  const mcpAgentTools = createMcpAgentTools({ servers: serversPort, approval, transport, clientFor, systemServerIds, clock, logger });
  return {
    mcpAgentTools,
    /** 与 createMcpAgentTools 共用同一份只读快照，保证目录与可调用索引看到同一批 server。 */
    mcpServersSnapshot: list,
    serversPort,
    snapshot,
    statusReason: () => lastReason,
  };
}

module.exports = { createMcpAgentBridge, projectMcpServer, MCP_HOST_APP_ID };
