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
 *   · 工具调用：本桥自身不构造 transport / clientFor，也不放宽客户端的双条件门；未注入时
 *     createMcpAgentTools 的 invokeRemote 返回结构化 MCP_TOOL_INVOCATION_NOT_ENABLED
 *     （mcp-agent-tools.cjs:575-579）；审批端口（approval）未注入时 requestApproval 先 fail closed
 *     （mcp-agent-tools.cjs:534-535），远端调用次数为 0。生产装配（main.cjs）注入活连接 + 审批端口，
 *     开关默认关闭；本桥不修改 electron/mcp-client.cjs 的产品边界。
 *   · 工具入参 schema：MCP 域落库时只保留 inputSchemaSummary（mcp-domain.cjs:157-177 sanitizeTool），
 *     完整 inputSchema 不持久化 → 这里照实不补 schema，catalog 落到空对象 schema，绝不伪造参数。
 *
 * B4e 增量（默认关闭，显式开关 + Registry 合同）：
 *   · switch：注入的显式开关端口原样转交 createMcpAgentTools；产品装配（main.cjs）注入
 *     electron/mcp-switch.cjs（默认 false）→ 关闭时在审批之前回 MCP_TOOL_INVOCATION_NOT_ENABLED。
 *   · registry：注入 ToolRegistry 时，把"已连接 server 的工具"幂等登记为 EXTERNAL_SIDE_EFFECT
 *     contract（electron/mcp-tool-contract.cjs）；这样 B4d 的审批适配器（toolIdFor=mcpToolIdFor）
 *     才有 contract 可解析，否则 ControlledToolProxy.propose 会 fail closed 成 DENIED。
 *   · proxy / sideEffectRuntime + taskId：未显式给 approval 时，自动包出既有两个审批适配器，
 *     不新建第二套 authority。传输仍必须由调用方注入（生产由 main.cjs 注入 mcp-live-transport = 传输边界不放宽）。
 */
const { createMcpAgentTools, isConnectedStatus, createControlledToolProxyApprovalPort, createSideEffectApprovalPort, createTaskApprovalPort } = require("./mcp-agent-tools.cjs");
const { mcpToolIdFor, registerMcpToolContracts, descriptorsFromServerRows, MCP_TOOL_VERSION } = require("./mcp-tool-contract.cjs");

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
 *   生产由 main.cjs 注入 electron/mcp-live-transport.cjs（McpService 的活连接）；
 *   未注入时 createMcpAgentTools 回 MCP_TOOL_INVOCATION_NOT_ENABLED（不伪造传输）。
 * @param {function} [options.trustedApproval]  可信审批决定来源（APPROVED/DENIED/TIMEOUT）；
 *   注入后审批端口为 createTaskApprovalPort（propose → 可信决定 → 执行），未注入则保持 APPROVAL_REQUIRED。
 * @param {object} [options.switch]  B4e 显式开关端口（{ isEnabled() } / { isToolInvocationEnabled() }）。
 * @param {object} [options.registry]  B4e ToolRegistry；注入后幂等登记 MCP 工具 contract。
 * @param {object} [options.connections]  Y4 既有 MCP 配置来源之上的可写 connections 端口
 *   （mcp-connections-port.cjs：list/save/connect/disconnect/remove）。
 *   注入后 createMcpAgentTools 的 servers 端口**保留原来的只读 list**（授权后的投影），
 *   另外把 save/connect/disconnect/remove 接到该端口 —— 配置读写走既有 SQLite 表，不改授权读路径。
 *   未注入时 serversPort 与从前逐字一致（只有 list），配置读写保持既有结构化降级。
 * @param {object} [options.appRegistry]  Y1 宿主侧 App 托管 MCP 注册表（mcp-app-registry.cjs）；
 *   原样转交 createMcpAgentTools。未注入时 assert/sync/remove 保持既有结构化降级。
 * @param {number} [options.version]  MCP 工具 contract 版本（默认 MCP_TOOL_VERSION）。
 * @param {object} [options.proxy]  ControlledToolProxy；与 taskId 同时给出且未显式给 approval 时自动包适配器。
 * @param {object} [options.sideEffectRuntime]  SideEffectRuntime；与 taskId 同时给出且未显式给 approval 时自动包适配器。
 * @param {string} [options.taskId] @param {string} [options.stepId] @param {string} [options.runId]
 * @returns {{ mcpAgentTools: object, mcpServersSnapshot: () => object[], serversPort: object, snapshot: () => object, statusReason: () => string|null, registerToolContracts: () => object, listToolContracts: () => string[], toolContractReport: () => object }|null}
 */
function createMcpAgentBridge({ mcpService = null, context = null, hostAppId = MCP_HOST_APP_ID, approval = null, transport = null, clientFor = null, systemServerIds = null, switch: switchPort = null, registry = null, connections = null, appRegistry = null, version = MCP_TOOL_VERSION, proxy = null, sideEffectRuntime = null, taskId = null, stepId = null, runId = null, trustedApproval = null, clock = null, logger = null } = {}) {
  if (!mcpService || typeof mcpService.listConnections !== "function") return null;
  const contextOf = () => {
    const base = typeof context === "function" ? context() : context;
    const value = base && typeof base === "object" ? base : {};
    return { ...value, appId: value.appId || hostAppId };
  };

  // B4e：只有显式注入时才把开关传给 createMcpAgentTools（保持既有单测合同不变）；
  // 产品装配（main.cjs）永远注入 → 默认关闭。
  const explicitSwitch = switchPort || null;
  // B4e：未显式给 approval 时，用既有适配器包出真实审批端口（不新建第二套 authority）。
  // taskId 可为空：MCP 的任务上下文可以逐调用传入（mcp/toolInvocation/call 经可信解析），
  // 缺 taskId 的调用仍会在 propose 前 fail closed（0 次传输）。
  let approvalPort = approval;
  if (!approvalPort && proxy && typeof trustedApproval === "function") {
    approvalPort = createTaskApprovalPort({ proxy, taskId, toolIdFor: mcpToolIdFor, toolVersionFor: () => version, stepId, runId, trustedApproval });
  }
  if (!approvalPort && proxy) {
    approvalPort = createControlledToolProxyApprovalPort({ proxy, taskId, toolIdFor: mcpToolIdFor, toolVersionFor: () => version, stepId, runId });
  }
  if (!approvalPort && sideEffectRuntime && taskId) {
    approvalPort = createSideEffectApprovalPort({ runtime: sideEffectRuntime, taskId, toolIdFor: mcpToolIdFor, toolVersionFor: () => version, stepId, runId });
  }

  let lastReason = null;
  const registeredToolIds = new Set();
  let lastContractReport = { ok: true, registered: [], skipped: [], errors: [], toolIds: [] };

  function registerFromRows(rows) {
    if (!registry) return lastContractReport;
    lastContractReport = registerMcpToolContracts(registry, descriptorsFromServerRows(rows), { version });
    for (const id of lastContractReport.toolIds) registeredToolIds.add(id);
    return lastContractReport;
  }

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
    // B4e：目录成功后才登记合同；登记失败不改变只读目录投影（如实留在 toolContractReport.errors）。
    if (registry) { try { registerFromRows(rows); } catch { /* 登记失败由下一次报告暴露 */ } }
    return { ok: true, rows, reason: null };
  }
  function list() { return snapshot().rows; }

  // Y4：connections 端口只补**配置读写**（save/connect/disconnect/remove），
  // 只读 list 仍是上面的授权后投影 —— 换端口不能让原始数据库行绕过 app grant / 可见性判定。
  const connectionsPort = connections && typeof connections.list === "function"
    && typeof connections.save === "function"
    && typeof connections.connect === "function"
    && typeof connections.disconnect === "function"
    ? connections
    : null;
  const serversPort = connectionsPort
    ? {
        list,
        save: (config) => connectionsPort.save(config),
        connect: (config) => connectionsPort.connect(config),
        disconnect: (id) => connectionsPort.disconnect(id),
        ...(typeof connectionsPort.remove === "function" ? { remove: (id) => connectionsPort.remove(id) } : {}),
        ...(typeof connectionsPort.refresh === "function" ? { refresh: (id) => connectionsPort.refresh(id) } : {}),
      }
    : { list };
  const mcpAgentTools = createMcpAgentTools({ servers: serversPort, approval: approvalPort, transport, clientFor, switch: explicitSwitch, systemServerIds, appRegistry, clock, logger });
  return {
    mcpAgentTools,
    /** 与 createMcpAgentTools 共用同一份只读快照，保证目录与可调用索引看到同一批 server。 */
    mcpServersSnapshot: list,
    serversPort,
    snapshot,
    statusReason: () => lastReason,
    /** B4e：对当前目录主动登记一次合同（幂等），返回结构化报告。 */
    registerToolContracts: () => registerFromRows(list()),
    listToolContracts: () => [...registeredToolIds],
    toolContractReport: () => ({ ...lastContractReport }),
    approvalPortKind: approvalPort && approvalPort.kind ? approvalPort.kind : null,
  };
}

module.exports = { createMcpAgentBridge, projectMcpServer, MCP_HOST_APP_ID };
