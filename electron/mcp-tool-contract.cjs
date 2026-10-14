/**
 * B4e · MCP 工具 → ToolRegistry contract 适配（外部风险 + 强制审批）。
 *
 * 为什么需要：B4d 的审批适配器（electron/mcp-agent-tools.cjs:378-433）会把
 * toolIdFor(serverId, toolName) 交给 ControlledToolProxy.propose / SideEffectRuntime.proposeWrite；
 * 若该 toolId 在 Registry 里没有 contract，propose 会以"解析失败"收敛为 DENIED（fail closed，不是成功）。
 * 本层负责把聚合出来的 MCP 工具登记成**真实 contract**，riskClass = EXTERNAL_SIDE_EFFECT：
 *   · sideEffect / requiresApproval 不在这里手写，由 ToolRegistry.register 依 risk 推导
 *     （electron/tool-domain.cjs:202-215：EXTERNAL_SIDE_EFFECT → SIDE_EFFECT.EXTERNAL 且 approvalRequired=true），
 *     避免"自己声明自己审批"的第二套语义；
 *   · toolId 必须过 isWellFormedToolId（electron/tool-domain.cjs:69-70：只允许
 *     [a-z][a-z0-9]* 的点分小段，**下划线不合法**），故 serverId / toolName 按非字母数字切段后再拼接；
 *   · 只读：不执行、不传输、不落盘。
 */
"use strict";

const { RISK_CLASS } = require("./tool-domain.cjs");
const { EXECUTION_POLICY } = require("./side-effect-domain.cjs");
const { sanitizeJsonSchema } = require("./mcp-agent-tools.cjs");

const MCP_TOOL_VERSION = 1;
/** executionProvider 静态名：真实执行只可能发生在外部 MCP 服务端，本仓没有 MCP adapter，绝不冒充。 */
const EXTERNAL_EXECUTION_PROVIDER = "McpExternal";

/**
 * 值 → 合法 toolId 小段数组：按非 [a-z0-9] 切分；段首非字母时补 s 前缀。
 * 例："fs server" → ["fs","server"]；"read.file" → ["read","file"]；"2fa" → ["s2fa"]。
 */
function toolIdSegments(value) {
  const parts = String(value == null ? "" : value).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const segs = parts.map((part) => (/^[a-z]/.test(part) ? part : "s" + part));
  return segs.length ? segs : ["x"];
}

/** 源语义命名空间是 mcp__<server>__<tool>（electron/mcp-agent-tools.cjs:507）；Registry toolId 另用点分合法形态。 */
function mcpToolIdFor(serverId, toolName) {
  return ["mcp", ...toolIdSegments(serverId), ...toolIdSegments(toolName)].join(".");
}

/** MCP 侧参数摘要的展示文案（与渲染层 UI-2 旧派生逐字一致，避免两处各写一份）。 */
function paramSummaryText(summary) {
  const text = typeof summary === "string" ? summary.trim() : "";
  if (!text) return "未返回参数摘要（服务端未提供 inputSchema）";
  if (/properties:\s*none/.test(text)) return text + "（参数为空对象）";
  return text;
}

/**
 * 单个 MCP 工具的 Registry contract。
 * 有意不写 sideEffect / requiresApproval：由 Registry 依 riskClass 推导，测试据此断言。
 */
function buildMcpToolContract({ serverId, serverName = null, toolName, description = "", inputSchema = null, version = MCP_TOOL_VERSION } = {}) {
  const id = mcpToolIdFor(serverId, toolName);
  const schema = inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)
    ? sanitizeJsonSchema(inputSchema, true)
    : { type: "object", additionalProperties: true, properties: {} };
  return {
    toolId: id,
    version,
    displayName: "MCP " + (serverName || serverId) + " · " + toolName,
    description: String(description || "").slice(0, 300) || ("外部 MCP 工具：" + toolName),
    inputSchema: schema,
    // 外部工具返回形状由服务端决定，不在本层收窄；执行权也不在本仓。
    outputSchema: { type: "object", additionalProperties: true },
    riskClass: RISK_CLASS.EXTERNAL_SIDE_EFFECT,
    requiredPermissions: [],
    resourceActions: [],
    executionProvider: EXTERNAL_EXECUTION_PROVIDER,
    enabled: true,
    expectedSideEffects: ["在外部 MCP 服务器上执行工具（不可信边界，需审批）"],
    approvalPolicy: "ONE_CALL",
    leasePolicy: "SINGLE_ACTIVE",
    // D5-04：把 MCP 接成既有 SideEffectAuthority 的 provider。外部副作用必须由 contract 显式声明
    // 执行合同（CONTROLLED_EXTERNAL_EFFECT），否则 plan 阶段就 BLOCKED（见 side-effect-authority）。
    idempotencySupport: true,
    verificationStrategy: "EXTERNAL_ACKNOWLEDGED",
    executionPolicy: EXECUTION_POLICY.CONTROLLED_EXTERNAL_EFFECT,
    // provider 需要反向解析执行目标：toolId 是 lossy 派生（切段/小写），原始 serverId/toolName 必须随合同带上。
    externalTarget: { serverId: String(serverId == null ? "" : serverId), toolName: String(toolName == null ? "" : toolName) },
  };
}

/** createMcpAgentBridge 的 server 行（projectMcpServer 投影）→ 待登记描述符；只取已连接 server 的工具。 */
function descriptorsFromServerRows(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.connected !== true) continue;
    for (const tool of Array.isArray(row.tools) ? row.tools : []) {
      if (!tool || typeof tool.name !== "string" || !tool.name) continue;
      out.push({
        serverId: String(row.id),
        serverName: row.name || null,
        toolName: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : null,
      });
    }
  }
  return out;
}

/**
 * 幂等登记：已是同一 (toolId, version) 的 contract 记为 skipped，不覆盖、不抛。
 * 返回结构化结果，绝不静默吞掉登记失败。
 */
function registerMcpToolContracts(registry, descriptors, { version = MCP_TOOL_VERSION } = {}) {
  const registered = [];
  const skipped = [];
  const errors = [];
  if (!registry || typeof registry.register !== "function" || typeof registry.get !== "function") {
    return { ok: false, error: "MCP_REGISTRY_UNAVAILABLE", detail: "未注入 ToolRegistry", registered, skipped, errors, toolIds: [] };
  }
  for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
    let contract;
    try {
      contract = buildMcpToolContract({ ...(descriptor || {}), version });
    } catch (error) {
      errors.push({ serverId: descriptor && descriptor.serverId, toolName: descriptor && descriptor.toolName, detail: String((error && error.message) || error).slice(0, 200) });
      continue;
    }
    if (registry.get(contract.toolId, version)) { skipped.push(contract.toolId); continue; }
    try {
      registry.register(contract);
      registered.push(contract.toolId);
    } catch (error) {
      const message = String((error && error.message) || error);
      if (/duplicate/i.test(message)) { skipped.push(contract.toolId); continue; }
      errors.push({ toolId: contract.toolId, detail: message.slice(0, 200) });
    }
  }
  return { ok: errors.length === 0, registered, skipped, errors, toolIds: [...registered, ...skipped] };
}

module.exports = {
  MCP_TOOL_VERSION,
  EXTERNAL_EXECUTION_PROVIDER,
  toolIdSegments,
  mcpToolIdFor,
  paramSummaryText,
  buildMcpToolContract,
  descriptorsFromServerRows,
  registerMcpToolContracts,
};
