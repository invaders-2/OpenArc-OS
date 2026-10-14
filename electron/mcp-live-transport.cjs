/**
 * B4e 收口 · MCP 真实 tools/call 传输（生产装配点）。
 *
 * 为什么需要单独一层：
 *   B4d 的 createMcpAgentTools 只能接受**注入的** transport —— 之前"生产不注入"，
 *   于是"工具调用"只在测试注入的假传输上被证明。本层把 McpService 已建立的真实活连接
 *   （electron/mcp-service.cjs:599 this.live: connectionId → { client }）变成 transport 端口，
 *   再由 electron/main.cjs 注入 bridge/createMcpAgentTools。
 *
 * 边界（一条都不放宽）：
 *   · 显式开关由**本层再查一次**（mcpSwitch.isToolInvocationEnabled()）：关闭时 0 次 tools/call；
 *   · 真正的请求仍由 McpClient.callTool 发出，客户端还会再查一次开关并要求审批凭证
 *     （electron/mcp-client.cjs 的 #invocationAuthorized）—— 三层都 fail closed；
 *   · 没有活连接时回 MCP_CONNECTION_NOT_FOUND，绝不新建/复用别的连接的客户端；
 *   · 本层不发工具参数以外的任何字段，不落盘、不留日志。
 */
"use strict";

const domain = require("./mcp-domain.cjs");

/** 开关真值：未注入 / 抛错 / 非严格 true 一律 false。 */
function switchEnabled(switchPort) {
  if (!switchPort) return false;
  try {
    if (typeof switchPort.isEnabled === "function") return switchPort.isEnabled() === true;
    if (typeof switchPort.isToolInvocationEnabled === "function") return switchPort.isToolInvocationEnabled() === true;
  } catch {
    return false;
  }
  return false;
}

/**
 * @param {object} options
 * @param {object} options.mcpService McpService 实例（必须有 live: Map<connectionId, {client}>）。
 * @param {object} options.switchPort 显式开关（{ isToolInvocationEnabled() } / { isEnabled() }）。
 * @returns {{ kind:string, callTool: (request:object, gate?:object)=>Promise<object> }}
 */
function createMcpLiveTransport({ mcpService = null, switchPort = null } = {}) {
  return {
    kind: "mcp-live",
    async callTool(request = {}, gate = null) {
      if (switchEnabled(switchPort) !== true) {
        return { ok: false, error: domain.ERROR_CODE.MCP_TOOL_INVOCATION_NOT_ENABLED };
      }
      const serverId = request && request.serverId != null ? String(request.serverId) : "";
      const toolName = request && request.toolName != null ? String(request.toolName) : "";
      if (!serverId || !toolName) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT };
      if (!mcpService || !mcpService.live || typeof mcpService.live.get !== "function") {
        return { ok: false, error: domain.ERROR_CODE.MCP_UNREACHABLE, detail: "mcp-live-registry-unavailable" };
      }
      const entry = mcpService.live.get(serverId);
      if (!entry || !entry.client || typeof entry.client.callTool !== "function") {
        return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND, detail: "no-live-connection" };
      }
      return await entry.client.callTool(
        {
          name: toolName,
          arguments: request.arguments && typeof request.arguments === "object" && !Array.isArray(request.arguments) ? request.arguments : {},
          signal: request.signal || null,
          ...(Number(request.timeoutMs) > 0 ? { timeoutMs: Number(request.timeoutMs) } : {}),
        },
        gate && gate.authorization ? gate.authorization : null,
      );
    },
  };
}

module.exports = { createMcpLiveTransport, switchEnabled };
