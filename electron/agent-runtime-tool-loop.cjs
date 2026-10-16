"use strict";
/**
 * B3c · 服务端 Agent 工具循环。
 *
 * 逐字移植：
 *   · server/agent-runtime/serverToolLoop.ts:1-168  -> filterGatewayCapabilityTools / ServerAgentToolLoopCoordinator
 *   · shared/progressiveCapabilityRouter.ts:1-160   -> 复用 ./progressive-capability-router.cjs（B3b 单一实现；
 *     本文件原先内联的副本已删除，导出名保持不变）
 *   · shared/agentCapabilityContract.ts:1-60        -> CAPABILITY_DISCOVER_TOOL_NAME 常量（来自 ./agent-contracts.cjs）
 *
 * 新增（任务 B3c 明确要求"工具调用、结果回填、迭代上限"）：runServerToolLoop —— 真正把
 *   modelAdapter.call 与 B3d toolRunner.run 串起来的服务端循环。
 *   modelAdapter 形状对齐 electron/provider-protocol-service.cjs:151：
 *     call({ providerId, model, messages, tools, params, stream, signal, onEvent })
 *     成功返回 { ok:true, text, toolCalls:[{id,name,arguments}], usage }；失败 { ok:false, error }。
 *   toolRunner 形状：run(toolName, args, ctx)（B3d）；未注入时抛 AGENT_DEPENDENCY_UNAVAILABLE。
 */
const { requireDependency, dependencyUnavailable } = require("./agent-runtime-deps.cjs");

const { ProgressiveCapabilityToolset, createProgressiveCapabilityToolset } = require("./progressive-capability-router.cjs");
const { CAPABILITY_DISCOVER_TOOL_NAME } = require("./agent-contracts.cjs");

// ---------------------------------------------------------------------------
// serverToolLoop.ts 移植
// ---------------------------------------------------------------------------

/** 源 serverToolLoop.ts:35-39。 */
function observationContent(observation) {
  if (observation.status !== "completed") return JSON.stringify({ ok: false, error: observation.error || observation.status });
  if (typeof observation.result === "string") return observation.result;
  try {
    return JSON.stringify(observation.result ?? { ok: true });
  } catch {
    return String(observation.result);
  }
}

/** 源 serverToolLoop.ts:42-74。 */
function filterGatewayCapabilityTools(value, fallback, allowedNames) {
  const canonicalFallback = () => fallback.filter((tool) => allowedNames.has(tool.function.name));
  if (!Array.isArray(value)) return canonicalFallback();
  const canonical = new Map(fallback.map((tool) => [tool.function.name, tool]));
  return value.slice(0, 128).flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    const candidate = tool;
    if (candidate.type !== "function" || typeof candidate.function?.name !== "string"
      || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(candidate.function.name) || !allowedNames.has(candidate.function.name)) return [];
    const declared = canonical.get(candidate.function.name);
    if (declared) return [structuredClone(declared)];
    const metadata = candidate.x_dx_capability;
    if (metadata?.schema !== "dx-agent-capability/v1" || !String(metadata.id || "").trim()
      || !String(metadata.domain || "").trim() || !Array.isArray(metadata.intents)
      || !metadata.intents.some((intent) => String(intent).trim())) return [];
    return [{
      type: "function",
      function: {
        name: candidate.function.name,
        description: String(candidate.function.description || "").slice(0, 12000),
        parameters: candidate.function.parameters && typeof candidate.function.parameters === "object" && !Array.isArray(candidate.function.parameters)
          ? structuredClone(candidate.function.parameters) : { type: "object", properties: {} },
      },
      x_dx_capability: {
        schema: "dx-agent-capability/v1",
        id: String(metadata.id).trim().slice(0, 240),
        domain: String(metadata.domain).trim().slice(0, 160),
        intents: [...new Set(metadata.intents.map(String).map((intent) => intent.trim()).filter(Boolean))].slice(0, 64),
        ...(metadata.appId ? { appId: String(metadata.appId).trim().slice(0, 160) } : {}),
        ...(Array.isArray(metadata.requiredContext) ? { requiredContext: metadata.requiredContext.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 32) } : {}),
      },
    }];
  });
}

/** 源 serverToolLoop.ts:76-168。 */
class ServerAgentToolLoopCoordinator {
  constructor() {
    this.states = new Map();
  }

  create(input) {
    const existing = this.states.get(input.runId);
    if (existing) return existing;
    const state = { ...input, messages: structuredClone(input.messages), tools: structuredClone(input.tools), step: 0, pending: [], discoveryHistory: [], terminal: false, content: "" };
    this.states.set(input.runId, state);
    return state;
  }

  get(runId) { return this.states.get(runId); }
  restore(state) { this.states.set(state.runId, structuredClone(state)); return this.states.get(state.runId); }
  delete(runId) { this.states.delete(runId); }
  snapshot(runId) { const state = this.states.get(runId); return state ? structuredClone(state) : undefined; }

  async advance(state, input) {
    if (state.terminal) return { runId: state.runId, content: state.content, toolCalls: [], terminal: true, step: state.step };
    if (state.pending.length) {
      const observations = input.observations || [];
      const expected = new Map(state.pending.map((call) => [call.id, call]));
      if (observations.length !== expected.size || observations.some((item) => !expected.has(item.invocationId) || expected.get(item.invocationId)?.name !== item.toolName)) {
        throw Object.assign(new Error("客户端工具 observation 与待执行 invocation 不匹配。"), { statusCode: 409 });
      }
      for (const observation of observations) {
        await input.onObservation?.(observation);
        state.messages.push({ role: "tool", tool_call_id: observation.invocationId, content: observationContent(observation) });
      }
      state.pending = [];
    } else if (input.observations?.length) {
      throw Object.assign(new Error("当前 Agent Run 没有等待客户端工具结果。"), { statusCode: 409 });
    }

    for (;;) {
      if (state.step >= state.maxSteps) {
        state.terminal = true;
        state.content ||= "Agent 已达到最大规划步数。";
        return { runId: state.runId, content: state.content, toolCalls: [], terminal: true, step: state.step, reason: "step_limit" };
      }
      const toolset = createProgressiveCapabilityToolset(state.tools, { surface: state.surface });
      for (const item of state.discoveryHistory) {
        toolset.discover(item.args);
        toolset.applyTargets(item.targets);
      }
      if (!state.bootstrapApplied && state.bootstrapIntents?.length) {
        const args = { intents: [...new Set(state.bootstrapIntents.map(String).map((item) => item.trim()).filter(Boolean))] };
        const local = toolset.discover(args);
        const discovered = await input.discover(args, local);
        toolset.applyTargets(discovered.targets);
        state.discoveryHistory.push({ args, targets: discovered.targets });
        state.bootstrapApplied = true;
      }
      const result = await input.model(state.messages, state.system, toolset.tools(), state.step);
      state.step += 1;
      state.content = result.content || state.content;
      if (!result.toolCalls.length) {
        state.messages.push({ role: "assistant", content: result.content || "" });
        state.terminal = true;
        return { runId: state.runId, content: state.content, toolCalls: [], terminal: true, step: state.step };
      }
      state.messages.push({
        role: "assistant", content: result.content || "",
        tool_calls: result.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
      });
      const clientCalls = [];
      for (const call of result.toolCalls) {
        if (!toolset.isDiscovery(call.name)) { clientCalls.push(call); continue; }
        let args = {};
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          /* schema validation happens at model boundary */
        }
        const local = toolset.discover(args);
        const discovered = await input.discover(args, local);
        toolset.applyTargets(discovered.targets);
        state.discoveryHistory.push({ args, targets: discovered.targets });
        const observation = { invocationId: call.id, toolName: call.name, status: "completed", result: discovered };
        await input.onObservation?.(observation);
        state.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(discovered) });
      }
      if (!clientCalls.length) continue;
      state.pending = clientCalls;
      return { runId: state.runId, content: result.content || "", toolCalls: clientCalls, terminal: false, step: state.step };
    }
  }
}

const serverAgentToolLoops = new ServerAgentToolLoopCoordinator();

// ---------------------------------------------------------------------------
// 服务端工具循环驱动（本次新增，任务 B3c E 条）
// ---------------------------------------------------------------------------

/** 把 provider 返回的 tool_calls 归一成 AgentToolCallV1 { id, name, arguments }。 */
function normalizeToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((call, index) => {
    if (!call || typeof call !== "object") return [];
    const id = String(call.id || call.tool_call_id || "call_" + index);
    const name = String(call.name || call.function?.name || "").trim();
    if (!name) return [];
    const rawArgs = call.arguments !== undefined ? call.arguments : call.function?.arguments;
    const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
    return [{ id, name, arguments: args }];
  });
}

/**
 * serverToolLoop 的服务端驱动：模型 → toolRunner → 结果回填 → 再调用模型，直到收敛。
 * 返回 { runId, content, terminal, step, reason? }。
 * 迭代上限：step >= maxSteps 时终止并给 reason='step_limit'。
 * 工具失败：observation.status='failed'，错误文本回填给模型（不吞异常、不伪造成功）。
 */
async function runServerToolLoop(input) {
  const modelAdapter = input.modelAdapter || requireDependency("modelAdapter");
  const toolRunner = input.toolRunner || requireDependency("toolRunner");
  if (!modelAdapter || typeof modelAdapter.call !== "function") throw dependencyUnavailable("modelAdapter.call");
  if (!toolRunner || typeof toolRunner.run !== "function") throw dependencyUnavailable("toolRunner.run");
  const maxSteps = Number.isFinite(Number(input.maxSteps)) ? Math.max(1, Math.floor(Number(input.maxSteps))) : 8;
  const conversation = structuredClone(input.messages || []);
  const discoveryHistory = [];
  const tools = structuredClone(input.tools || []);
  let step = 0;
  let content = "";
  let bootstrapApplied = false;

  for (;;) {
    if (step >= maxSteps) {
      return { runId: input.runId, content: content || "Agent 已达到最大规划步数。", toolCalls: [], terminal: true, step, reason: "step_limit" };
    }
    const toolset = createProgressiveCapabilityToolset(tools, { surface: input.surface });
    for (const item of discoveryHistory) {
      toolset.discover(item.args);
      toolset.applyTargets(item.targets);
    }
    if (!bootstrapApplied && input.bootstrapIntents?.length) {
      const args = { intents: [...new Set(input.bootstrapIntents.map(String).map((item) => item.trim()).filter(Boolean))] };
      const local = toolset.discover(args);
      const discovered = input.discover ? await input.discover(args, local) : local;
      toolset.applyTargets(discovered.targets);
      discoveryHistory.push({ args, targets: discovered.targets });
      bootstrapApplied = true;
    }

    const response = await modelAdapter.call({
      providerId: input.providerId,
      model: input.model,
      messages: conversation,
      tools: toolset.tools(),
      params: input.params || {},
      stream: false,
      signal: input.signal,
      onEvent: input.onEvent || (() => {}),
    });
    if (!response || response.ok !== true) {
      const error = new Error("Agent 模型调用失败：" + String(response?.error || "UNKNOWN"));
      error.code = response?.error || "MODEL_CALL_FAILED";
      error.requestId = response?.requestId;
      throw error;
    }
    step += 1;
    content = response.text || content;
    const toolCalls = normalizeToolCalls(response.toolCalls);
    if (!toolCalls.length) {
      conversation.push({ role: "assistant", content: response.text || "" });
      return { runId: input.runId, content, toolCalls: [], terminal: true, step };
    }
    conversation.push({
      role: "assistant", content: response.text || "",
      tool_calls: toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
    });

    for (const call of toolCalls) {
      if (toolset.isDiscovery(call.name)) {
        let args = {};
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          /* 交给模型边界校验 */
        }
        const local = toolset.discover(args);
        const discovered = input.discover ? await input.discover(args, local) : local;
        toolset.applyTargets(discovered.targets);
        discoveryHistory.push({ args, targets: discovered.targets });
        const observation = { invocationId: call.id, toolName: call.name, status: "completed", result: discovered };
        await input.onObservation?.(observation);
        conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(discovered) });
        continue;
      }
      let args = {};
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        args = {};
      }
      const startedAt = Date.now();
      let observation;
      try {
        const result = await toolRunner.run(call.name, args, { runId: input.runId, step, signal: input.signal, ...(input.toolContext || {}) });
        observation = { invocationId: call.id, toolName: call.name, status: "completed", result, latencyMs: Date.now() - startedAt };
      } catch (error) {
        observation = { invocationId: call.id, toolName: call.name, status: "failed", error: String(error?.message || error).slice(0, 2000), latencyMs: Date.now() - startedAt };
      }
      await input.onObservation?.(observation);
      conversation.push({ role: "tool", tool_call_id: call.id, content: observationContent(observation) });
    }
  }
}

module.exports = {
  CAPABILITY_DISCOVER_TOOL_NAME,
  ProgressiveCapabilityToolset,
  createProgressiveCapabilityToolset,
  filterGatewayCapabilityTools,
  observationContent,
  normalizeToolCalls,
  ServerAgentToolLoopCoordinator,
  serverAgentToolLoops,
  runServerToolLoop,
};
