"use strict";
/**
 * B3c · Agent Profile 胶囊表。
 *
 * 逐字移植 server/agent-runtime/profiles.ts:1-54（含 5 个内置胶囊的每一个字段）。
 * 源 import 的 AgentRequestEnvelopeV1 只是类型，运行时无需引入。
 */
const BUILTIN_APP_AGENT_CAPSULES = [
  {
    id: "system-jarvis", appId: "agent", sourceTypes: ["desktop", "automation"], entryPoints: ["jarvis-overlay"],
    capabilityScopes: ["system:*", "media.*", "file:*", "skill:*", "mcp:*", "app:*"], knowledgeScopes: ["user:self"], memoryScopes: ["user.preferences"],
    maxModelCalls: 8, maxToolCalls: 32, systemInstructions: "你是 DX OS 系统级助理，只能通过已授权能力操作系统。",
  },
  {
    id: "conversation", appId: "tasks", sourceTypes: ["app"], entryPoints: ["conversation"],
    capabilityScopes: ["system:*", "media.*", "skill:*", "mcp:*"], knowledgeScopes: ["user:self"], memoryScopes: ["session.current"],
    maxModelCalls: 8, maxToolCalls: 24, systemInstructions: "你是 DX OS 对话 Agent；普通问答直接回答，需要真实操作时调用能力。",
  },
  {
    id: "project-assistant", sourceTypes: ["project", "app"], entryPoints: ["project-assistant", "project-converse"],
    capabilityScopes: ["system:*", "media.*", "file:*", "skill:*", "mcp:*", "app:*"], knowledgeScopes: ["project:current"], memoryScopes: ["project.facts", "session.current"],
    maxModelCalls: 12, maxToolCalls: 40, systemInstructions: "你是项目范围内的 Agent，所有文件与知识访问必须保持在当前项目授权边界内。",
  },
  {
    id: "canvas-agent", appId: "canvas", sourceTypes: ["app"], entryPoints: ["agent-panel"],
    capabilityScopes: ["media.*", "skill:*", "app:*"], knowledgeScopes: ["project:current", "app:canvas:current"], memoryScopes: ["app.canvas.session"],
    maxModelCalls: 12, maxToolCalls: 48, systemInstructions: "你是无限画布 Agent，通过 Skill 和画布能力产生可验证的节点与媒体结果。",
  },
  {
    id: "developer-app", sourceTypes: ["app"], entryPoints: ["developer-app-bridge"],
    capabilityScopes: ["media.*", "file:*", "app:*"], knowledgeScopes: ["project:current", "app:current"], memoryScopes: ["app.session"],
    maxModelCalls: 10, maxToolCalls: 32, systemInstructions: "你是由 DX Developer APP 发起的受限 Agent。只能访问该 APP 的私有项目和服务端授权的能力边界，不得访问其他 APP、项目或凭据。",
  },
];

/** 源 profiles.ts:46-48。 */
function getAppAgentCapsule(id) {
  return id ? BUILTIN_APP_AGENT_CAPSULES.find((capsule) => capsule.id === id) : undefined;
}

/** 源 profiles.ts:50-54。显式 profileId 优先；否则按 sourceType + appId 匹配第一个胶囊。 */
function capsuleForEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return undefined;
  if (envelope.profileId) return getAppAgentCapsule(envelope.profileId);
  const source = envelope.source || {};
  return BUILTIN_APP_AGENT_CAPSULES.find((capsule) =>
    capsule.sourceTypes.includes(source.type)
    && (!capsule.appId || capsule.appId === source.appId),
  );
}

module.exports = { BUILTIN_APP_AGENT_CAPSULES, getAppAgentCapsule, capsuleForEnvelope };
