"use strict";
/**
 * task-34 F01/F04 · Agent gateway 入口的纯校验/信封构造。
 *
 * 只做三件事，便于单测且不把策略散进 IPC：
 *   · system-jarvis 的 desktop/jarvis-overlay 信封（Vue AssistPanel 的等价 agent 路径）；
 *   · developer-app 的 app/developer-app-bridge 信封 + 固定 capabilityBoundary + 会话隔离键；
 *   · 入口能力披露（capability_discover + client/server 工具分组）。
 * 身份（actor）一律由主进程传入；本模块不接受渲染层自报 userId/role。
 */
const { normalizeAgentRequestEnvelopeV1 } = require("./agent-runtime-envelope.cjs");

const JARVIS_PROFILE_ID = "system-jarvis";
const DEVELOPER_APP_PROFILE_ID = "developer-app";
const JARVIS_ENTRY_POINT = "jarvis-overlay";
const DEVELOPER_APP_ENTRY_POINT = "developer-app-bridge";

function gatewayError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode, code: "AGENT_GATEWAY_" + (statusCode === 403 ? "FORBIDDEN" : statusCode === 400 ? "INVALID_INPUT" : "CONFLICT") });
}

function requiredText(value, field, max = 8000) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw gatewayError(field + " 必填", 400);
  if (text.length > max) throw gatewayError(field + " 过长", 400);
  return text;
}

function buildJarvisEnvelope({ actor, instruction, projectId = null, threadId = null, requestId = null } = {}) {
  const goal = requiredText(instruction, "instruction");
  const sessionId = threadId || ("jarvis:" + String(actor && actor.id != null ? actor.id : "anonymous"));
  return normalizeAgentRequestEnvelopeV1({
    schema: "dx-agent-request/v1",
    requestId: requestId || undefined,
    goal,
    source: { type: "desktop", appId: "agent", entryPoint: JARVIS_ENTRY_POINT },
    session: { sessionId, threadId: threadId || undefined },
    scope: { ...(projectId ? { projectId: String(projectId) } : {}) },
    profileId: JARVIS_PROFILE_ID,
    interactionPolicy: "confirm-risky",
    deliveryTarget: { type: "desktop", targetId: "agent" },
  }, actor);
}

function appAgentPermission(appId, manifestId = null) {
  const id = String(manifestId || appId || "").trim();
  return id ? "app." + id + ".agent.run" : null;
}

function assertDeveloperAppPermission({ app, appId } = {}) {
  const id = String(appId || "");
  if (!id) throw gatewayError("appId 必填", 400);
  if (!app) throw gatewayError("开发者应用不存在：" + id, 404);
  if (app.enabled !== true) throw gatewayError("开发者应用未安装或未启用：" + id, 403);
  const permissions = app.manifest && Array.isArray(app.manifest.permissions) ? app.manifest.permissions : [];
  const manifestId = app.manifest && app.manifest.id ? String(app.manifest.id) : null;
  const expected = [appAgentPermission(id, manifestId), manifestId ? appAgentPermission(id) : null].filter(Boolean);
  if (!expected.some((permission) => permissions.includes(permission))) {
    throw gatewayError("APP 未声明 " + (expected[expected.length - 1] || ("app." + id + ".agent.run")) + " 权限", 403);
  }
  return { permission: expected.find((permission) => permissions.includes(permission)), manifestId };
}

function developerAppCapabilityBoundary(appId) {
  return ["media.*", "file:*", "app:" + String(appId) + ":*"];
}

function developerAppSessionKey({ actor, appId } = {}) {
  const userId = String(actor && actor.id != null ? actor.id : "anonymous");
  return "devapp:" + String(appId) + ":user:" + userId;
}

function assertDeveloperAppScope({ actor, appId, app, projectId, sessionId = null, payloadAppId = null, payloadProjectId = null, payloadSessionId = null } = {}) {
  const permission = assertDeveloperAppPermission({ app, appId });
  if (payloadAppId != null && String(payloadAppId) !== String(appId)) throw gatewayError("跨 APP 访问被拒绝", 403);
  if (payloadProjectId != null && String(payloadProjectId) !== String(projectId)) throw gatewayError("跨项目访问被拒绝", 403);
  const expectedSession = sessionId || developerAppSessionKey({ actor, appId });
  if (payloadSessionId != null && String(payloadSessionId) !== expectedSession) throw gatewayError("跨会话访问被拒绝", 403);
  return { permission: permission.permission, manifestId: permission.manifestId, sessionId: expectedSession, capabilityBoundary: developerAppCapabilityBoundary(appId) };
}

function buildDeveloperAppEnvelope({ actor, app, appId, instruction, projectId, sessionId = null, requestId = null } = {}) {
  const goal = requiredText(instruction, "instruction");
  const scope = assertDeveloperAppScope({ actor, appId, app, projectId, sessionId });
  if (!projectId) throw gatewayError("projectId 必填", 400);
  return normalizeAgentRequestEnvelopeV1({
    schema: "dx-agent-request/v1",
    requestId: requestId || undefined,
    goal,
    source: { type: "app", appId: String(appId), entryPoint: DEVELOPER_APP_ENTRY_POINT },
    session: { sessionId: scope.sessionId, threadId: scope.sessionId },
    scope: { projectId: String(projectId) },
    profileId: DEVELOPER_APP_PROFILE_ID,
    capabilityBoundary: scope.capabilityBoundary,
    interactionPolicy: "confirm-risky",
    deliveryTarget: { type: "desktop", targetId: "agent" },
  }, actor);
}

const CLIENT_TOOL_NAMES = Object.freeze(["open_app", "music_play", "music_control"]);

/** 入口披露：capability_discover + 工具按 client/server 分组（client 返回动作，不假称已执行）。 */
function discloseEntryCapabilities(prepared) {
  const route = prepared && prepared.route ? prepared.route : {};
  const descriptors = Array.isArray(route.toolDescriptors) ? route.toolDescriptors : [];
  const tools = descriptors.map((descriptor) => ({
    name: descriptor.name,
    source: descriptor.source,
    risk: descriptor.risk,
    handler: descriptor.handler ? { ...descriptor.handler } : null,
    clientExecutable: CLIENT_TOOL_NAMES.includes(descriptor.name) || (descriptor.handler && descriptor.handler.type === "client"),
  }));
  return {
    capabilityDiscover: {
      name: "capability_discover",
      description: "先发现再执行：按 intent/domain 激活相关能力，未激活工具不应被猜测调用。",
      intents: ["system", "media", "file", "app", "canvas", "mcp", "skill"],
    },
    capabilities: Array.isArray(prepared && prepared.capabilities) ? prepared.capabilities.map((capability) => capability.id || capability) : [],
    tools,
    clientTools: tools.filter((tool) => tool.clientExecutable),
    serverTools: tools.filter((tool) => !tool.clientExecutable),
  };
}

module.exports = {
  JARVIS_PROFILE_ID,
  DEVELOPER_APP_PROFILE_ID,
  JARVIS_ENTRY_POINT,
  DEVELOPER_APP_ENTRY_POINT,
  CLIENT_TOOL_NAMES,
  buildJarvisEnvelope,
  buildDeveloperAppEnvelope,
  assertDeveloperAppPermission,
  assertDeveloperAppScope,
  developerAppCapabilityBoundary,
  developerAppSessionKey,
  discloseEntryCapabilities,
};
