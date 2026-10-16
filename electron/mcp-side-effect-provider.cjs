/**
 * D5-04 · MCP 外部工具 → 既有 SideEffectAuthority 的 provider（plan / execute 两个方向）。
 *
 * 为什么单独成文件：MCP 工具的"批准并执行"权威只能是既有的 SideEffectAuthority
 * （electron/side-effect-authority.cjs），本层只把一次 MCP tools/call 投影成该 authority 能
 * plan / execute / verify 的 adapter —— **不复制**它的审批、状态机、lease/claim 与审计。
 * 注册点是既有 adapters 注册表（electron/tool-adapters.cjs:385 adapterFor），
 * 由 main.cjs 晚绑定为 providers.McpExternal（活连接只存在于 main 进程，见
 * electron/side-effect-runtime.cjs:49 IN_PROCESS_EXECUTION_PROVIDERS）。
 *
 * 信任边界：
 *   · plan 只读：不传输、不落盘；把**脱敏**参数摘要（字段名 + 类型/长度，绝不回值）写进
 *     SideEffectPlan（electron/side-effect-authority.cjs:299 sanitizePreconditions / :300 sanitizeEffects）。
 *   · 执行入参绝不从 Harness payload 回读：plan 时把原始 args 绑定到进程内存的 bindRef，
 *     bindRef 随 plan 持久化（preconditions.targetRef）；execute 只按这份绑定发请求，
 *     argsDigest 与批准时的 expectedEffects[0].argsDigest 逐字节比对，不符即 0 传输。
 *   · 授权凭证只在 authority 已完成 approval + claim 之后才构造；McpClient 仍复核
 *     "显式开关 + 凭证 ALLOWED"双条件（electron/mcp-client.cjs:839 #invocationAuthorized），绝不绕过。
 *   · 失败一律结构化：确定没发出去 → knownNoEffect（FAILED，0 retry）；发出去了但结果不可知
 *     （服务端报错 / 超时 / 抛错）→ ambiguous（UNKNOWN_EFFECT，0 retry）；绝不假成功。
 *
 * 本文件不触盘 / 不发网络（网络只由注入的 transport 发出）/ 不 require 第三方包。
 */
"use strict";
const crypto = require("node:crypto");
const { EXECUTION_POLICY } = require("./side-effect-domain.cjs");
const { fingerprint } = require("./tool-domain.cjs");

/** 进程内存绑定：与 approval TTL 同量级（electron/side-effect-domain.cjs:124 默认 10 分钟）。 */
const BINDING_TTL_MS = 10 * 60 * 1000;
const MAX_BINDINGS = 128;
const SUMMARY_MAX_KEYS = 12;

/** 值的类型标签（摘要只用它，绝不回值）。 */
function valueTypeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean" || t === "object") return t;
  return "unknown";
}

/**
 * 审批界面看到的参数摘要：**只回字段名 + 类型（字符串只回长度）**，绝不回参数值本身 ——
 * 外部工具参数可能夹带用户数据 / 凭据形态，绝不能因为"要展示"就把它写进 side_effect_calls。
 */
function summarizeArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "非对象参数";
  const keys = Object.keys(args);
  if (!keys.length) return "无参数";
  const parts = keys.slice(0, SUMMARY_MAX_KEYS).map((key) => {
    const value = args[key];
    const type = valueTypeOf(value);
    if (type === "string") return key + "(string:" + String(value).length + ")";
    if (type === "array") return key + "(array:" + value.length + ")";
    return key + "(" + type + ")";
  });
  if (keys.length > SUMMARY_MAX_KEYS) parts.push("…");
  return parts.join(", ").slice(0, 300);
}

/**
 * @param {object} options
 * @param {object} options.transport  tools/call 传输端口（electron/mcp-live-transport.cjs:39），
 *   callTool(request, gate) → { ok:true, content, isError, structuredContent } | { ok:false, error }。
 * @param {object} options.registry   ToolRegistry（动态 allowlist 与执行合同复核）。
 * @param {()=>number} [options.clock] @param {number} [options.bindingTtlMs] @param {number} [options.maxBindings]
 */
function createMcpSideEffectProvider({ transport = null, registry = null, clock = null, bindingTtlMs = BINDING_TTL_MS, maxBindings = MAX_BINDINGS } = {}) {
  const now = typeof clock === "function" ? clock : () => Date.now();
  /** bindRef → { args, serverId, toolName, argsDigest, createdAt }；只活进程内存，绝不落库 / 事件 / 日志。 */
  const bindings = new Map();

  function prune() {
    const cutoff = now() - Math.max(1, Number(bindingTtlMs) || BINDING_TTL_MS);
    for (const [key, value] of bindings) if (value.createdAt < cutoff) bindings.delete(key);
    while (bindings.size > maxBindings) bindings.delete(bindings.keys().next().value);
  }

  /** 动态 allowlist：只有 Registry 里 executionProvider = McpExternal 的 toolId 才归本 provider。 */
  function allowsTool(toolId) {
    if (!registry || typeof registry.versionsOf !== "function" || typeof registry.get !== "function") return false;
    for (const version of registry.versionsOf(toolId)) {
      const contract = registry.get(toolId, version);
      if (contract && contract.executionProvider === "McpExternal") return true;
    }
    return false;
  }

  function targetOf(contract) {
    const target = contract && contract.externalTarget && typeof contract.externalTarget === "object" ? contract.externalTarget : null;
    const serverId = target && target.serverId != null ? String(target.serverId) : "";
    const toolName = target && target.toolName != null ? String(target.toolName) : "";
    if (!serverId || !toolName) return null;
    return { serverId, toolName };
  }

  return {
    provider: "McpExternal",
    allowsTool,
    /** plan：pure read，0 传输。返回 null = 无计划（authority 收敛 SIDE_EFFECT_NO_PLAN，fail closed）。 */
    async plan({ args, contract }) {
      if (!transport || typeof transport.callTool !== "function") return null;
      const target = targetOf(contract);
      if (!target) return null;
      if (!contract || contract.executionPolicy !== EXECUTION_POLICY.CONTROLLED_EXTERNAL_EFFECT) return null;
      const payload = args && typeof args === "object" && !Array.isArray(args) ? args : {};
      const argsDigest = fingerprint(payload);
      prune();
      const bindRef = "mcpbind_" + crypto.randomBytes(10).toString("base64url");
      bindings.set(bindRef, { args: payload, serverId: target.serverId, toolName: target.toolName, argsDigest, createdAt: now() });
      return {
        targets: [target.serverId],
        // bindRef 随 plan 持久化；执行入参只能来自这份绑定，绝不回读 Harness payload。
        preconditions: { targetRef: bindRef, targetType: "mcp-tool" },
        expectedEffects: [{
          action: "tools/call",
          serverRef: target.serverId,
          toolRef: target.toolName,
          argsDigest,
          argsSummary: summarizeArguments(payload),
        }],
      };
    },
    /** execute：只在 authority claim 之后被调用；真实 tools/call 由注入 transport 发出。 */
    async execute({ contract, preconditions, expectedEffects, callId }) {
      const target = targetOf(contract);
      const bindRef = preconditions && typeof preconditions.targetRef === "string" ? preconditions.targetRef : "";
      const binding = bindRef ? bindings.get(bindRef) : null;
      if (!binding) return { ok: false, knownNoEffect: true, error: "MCP_BINDING_UNAVAILABLE" };
      if (!target || binding.serverId !== target.serverId || binding.toolName !== target.toolName) return { ok: false, knownNoEffect: true, error: "MCP_BINDING_MISMATCH" };
      const approved = Array.isArray(expectedEffects) && expectedEffects[0] ? expectedEffects[0] : null;
      if (!approved || approved.argsDigest !== binding.argsDigest) return { ok: false, knownNoEffect: true, error: "MCP_ARGUMENTS_CHANGED" };
      if (!transport || typeof transport.callTool !== "function") return { ok: false, knownNoEffect: true, error: "MCP_TRANSPORT_UNAVAILABLE" };
      // 凭证只在 authority 已 approval + claim 之后构造；McpClient 仍复核开关 + ALLOWED（第二道门）。
      const gate = { authorization: { invocationEnabled: true, approval: { decision: "ALLOWED", approvalRequestId: callId || null } } };
      let res;
      try {
        res = await transport.callTool({ serverId: binding.serverId, toolName: binding.toolName, arguments: binding.args }, gate);
      } catch (e) {
        return { ok: false, ambiguous: true, error: "MCP_TOOL_CALL_FAILED", detail: String((e && e.message) || e).slice(0, 200) };
      }
      if (!res || res.ok !== true) {
        const error = (res && res.error) || "MCP_TOOL_CALL_FAILED";
        // 只有"确定没发出去"的错误才算 knownNoEffect；其余（UNREACHABLE 等）一律 UNKNOWN_EFFECT。
        const notSent = ["MCP_TOOL_INVOCATION_NOT_ENABLED", "MCP_CONNECTION_NOT_FOUND", "MCP_INVALID_INPUT"].includes(String(error));
        return notSent
          ? { ok: false, knownNoEffect: true, error, detail: res && res.detail != null ? String(res.detail).slice(0, 200) : null }
          : { ok: false, ambiguous: true, error, detail: res && res.detail != null ? String(res.detail).slice(0, 200) : null };
      }
      if (res.isError === true) {
        // 服务端明确回了工具错误：请求已到达外部系统，副作用是否发生**不可知** → UNKNOWN_EFFECT，绝不报成功。
        return { ok: false, ambiguous: true, error: "MCP_TOOL_ERROR", detail: "外部服务端返回 isError" };
      }
      const content = Array.isArray(res.content) ? res.content : [];
      const responseDigest = fingerprint({
        serverId: binding.serverId, toolName: binding.toolName, argsDigest: binding.argsDigest,
        content, structuredContent: res.structuredContent === undefined ? null : res.structuredContent,
      });
      return {
        ok: true,
        result: {
          ok: true, serverRef: binding.serverId, toolRef: binding.toolName,
          argsDigest: binding.argsDigest, responseDigest,
          content, isError: false,
          structuredContent: res.structuredContent === undefined ? null : res.structuredContent,
        },
      };
    },
    /**
     * verify：外部副作用本仓无法独立观测（不在我们进程里）。唯一可用证据是**服务端对这次批准请求
     * 的成功应答**：argsDigest 必须与批准计划逐字节一致，且带 responseDigest。这不是 READ_AFTER_WRITE，
     * 报告里如实标注为 EXTERNAL_ACKNOWLEDGED。
     */
    async verify({ result, expectedEffects }) {
      if (!result || result.ok !== true) return { ok: false, detail: { reason: "NO_RESULT" } };
      const approved = Array.isArray(expectedEffects) && expectedEffects[0] ? expectedEffects[0] : null;
      if (!approved || result.argsDigest !== approved.argsDigest) return { ok: false, detail: { reason: "ARGS_DIGEST_MISMATCH" } };
      if (typeof result.responseDigest !== "string" || !result.responseDigest) return { ok: false, detail: { reason: "NO_RESPONSE_EVIDENCE" } };
      return { ok: true, applied: true, detail: { basis: "EXTERNAL_ACKNOWLEDGED", serverRef: result.serverRef, toolRef: result.toolRef, argsDigest: result.argsDigest, responseDigest: result.responseDigest } };
    },
    /** recoveryVerify：只读；外部系统状态不可观测 → INDETERMINATE（UNKNOWN_EFFECT 不自动收敛、不 retry）。 */
    async recoveryVerify({ contract, preconditions }) {
      const target = targetOf(contract);
      return { outcome: "INDETERMINATE", reason: "EXTERNAL_EFFECT_UNOBSERVABLE", detail: { serverRef: target ? target.serverId : null, toolRef: target ? target.toolName : null, bindRef: preconditions && preconditions.targetRef ? preconditions.targetRef : null } };
    },
  };
}

module.exports = { createMcpSideEffectProvider, summarizeArguments, BINDING_TTL_MS, MAX_BINDINGS };
