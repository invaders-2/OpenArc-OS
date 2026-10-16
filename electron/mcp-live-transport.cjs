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
 *   · serverId 先按 connectionId 直取，再按集成声明的服务名在 live 里解析（resolveLiveConnection）；
 *     没有活连接 / 解析不出 / 命中多条一律 MCP_CONNECTION_NOT_FOUND + 具体 reason，
 *     绝不新建连接、绝不随机挑一条、绝不伪造成功；
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
 * 服务名 → 当前**活着的**真实连接。
 *
 * 为什么需要：request.serverId 有两种形态 ——
 *   1) MCP 域内的 connectionId（mcp-agent-tools / side-effect provider 一直这么传）；
 *   2) 集成/插件声明的服务名：server/lingxingLocalData.ts 的 callDirect('lingxing', ...) 形状，
 *      现落在 electron/integration-lingxing-local-data.cjs:231 / :376 / :390 与
 *      electron/integration-ziniao.cjs:208 / :217。
 * 对第 2 种，mcpService.live 的键是随机 connectionId（electron/mcp-service.cjs:612、
 * electron/mcp-store.cjs:62），直接 live.get(服务名) 必然取不到 —— 就是这条把自动化集成动作卡死。
 *
 * 只按身份字段匹配，且命中必须唯一：
 *   · endpoint_json.managedByAppId —— App/插件托管归属（electron/mcp-connections-port.cjs:84-101）；
 *   · endpoint_json.serverKey —— 本地 stdio 白名单键（electron/mcp-domain.cjs:137）；
 *   · row.server_name —— 实际协商出的服务端名（electron/mcp-service.cjs:597）；
 *   · row.name 的整词 —— 用户给这个服务起的名字（连接名）。
 * 命中 0 条 → 结构化拒绝并说明；命中 ≥2 条 → 歧义，同样拒绝，绝不随机挑一条。
 * 刻意**不**按"哪个连接发现了同名工具"匹配：多个连接连同一个服务端时会全部命中，那是歧义不是依据。
 *
 * @returns {{ok:true, connectionId:string, entry:object} | {ok:false, error:string, detail:string}}
 */
function resolveLiveConnection(mcpService, serverId) {
  const raw = serverId == null ? "" : String(serverId);
  const direct = mcpService.live.get(raw);
  if (direct) return { ok: true, connectionId: raw, entry: direct };
  const store = mcpService.store;
  if (!store || typeof store.connectionById !== "function") {
    return { ok: false, error: domain.ERROR_CODE.MCP_UNREACHABLE, detail: "service-registry-unavailable" };
  }
  const needle = raw.trim().toLowerCase();
  const needleTokens = needle.split(/[^a-z0-9]+/).filter(Boolean);
  const matches = [];
  for (const connectionId of mcpService.live.keys()) {
    const row = store.connectionById(connectionId);
    if (!row) continue;
    const endpoint = domain.parseJson(row.endpoint_json, null) || {};
    const managedByAppId = endpoint.managedByAppId != null ? String(endpoint.managedByAppId).trim().toLowerCase() : "";
    const serverKey = endpoint.serverKey != null ? String(endpoint.serverKey).trim().toLowerCase() : "";
    const negotiatedName = row.server_name != null ? String(row.server_name).trim().toLowerCase() : "";
    const nameTokens = String(row.name == null ? "" : row.name).trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const byName = needleTokens.length > 0 && needleTokens.every((token) => nameTokens.includes(token));
    if (managedByAppId === needle || serverKey === needle || negotiatedName === needle || byName) {
      matches.push(String(connectionId));
    }
  }
  const unique = [...new Set(matches)];
  if (unique.length === 1) return { ok: true, connectionId: unique[0], entry: mcpService.live.get(unique[0]) };
  if (unique.length > 1) {
    return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND, detail: "service-ambiguous:" + raw.trim().slice(0, 80) + ":candidates=" + unique.slice(0, 5).join(",") };
  }
  return { ok: false, error: domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND, detail: "service-unresolved:" + raw.trim().slice(0, 80) };
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
      // 解析到真实的活连接：serverId 可能是 connectionId，也可能是集成声明的服务名（见 resolveLiveConnection 顶部）。
      // 解析不到 / 命中多条 → 结构化拒绝并说明原因（不静默、不伪造、不随机挑）。
      const resolved = resolveLiveConnection(mcpService, serverId);
      if (!resolved.ok) return { ok: false, error: resolved.error, detail: resolved.detail };
      const entry = resolved.entry;
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
