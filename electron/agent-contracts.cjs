"use strict";
/**
 * B3b · Agent 共享契约（CJS 运行时投影）。
 *
 * 来源（DXSRC = DX OS.app/Contents/Resources/app.asar.unpacked）：
 *   · shared/agentRequestContract.ts:1-57        Agent 请求信封 / 工具调用 / 网关步进
 *   · shared/agentSupervisorContract.ts:1-50     Supervisor 运行状态 / 节点 / 巡检 DTO
 *   · shared/agentCapabilityContract.ts:1-60     能力工具元数据 / 发现请求与结果
 *
 * 说明：三个源文件除 const 与 capabilityMetadata() 外都是编译期 type/interface，
 * CJS 侧只保留运行时真正用到的常量与函数；interface 以 JSDoc typedef 逐字段保留，
 * 不把 TS type 伪造成可执行代码。
 */

/** shared/agentCapabilityContract.ts:1 */
const AGENT_CAPABILITY_METADATA_KEY = "x_dx_capability";
/** shared/agentCapabilityContract.ts:2 */
const CAPABILITY_DISCOVER_TOOL_NAME = "capability_discover";
/** shared/agentRequestContract.ts:1 */
const AGENT_REQUEST_SCHEMA_V1 = "dx-agent-request/v1";

/** shared/agentSupervisorContract.ts:1 */
const SUPERVISOR_RUN_STATUSES = Object.freeze(["created", "running", "waiting_user", "completed", "failed", "cancelled"]);

/**
 * shared/agentCapabilityContract.ts:45-59
 * 与源逐字对应：intents 去空、去重；appId / requiredContext 仅在非空时出现。
 */
function capabilityMetadata(input) {
  const raw = input && typeof input === "object" ? input : {};
  return {
    schema: "dx-agent-capability/v1",
    id: raw.id,
    domain: raw.domain,
    intents: [...new Set((Array.isArray(raw.intents) ? raw.intents : []).map(String).map((item) => item.trim()).filter(Boolean))],
    ...(raw.appId ? { appId: raw.appId } : {}),
    ...(Array.isArray(raw.requiredContext) && raw.requiredContext.length
      ? { requiredContext: [...new Set(raw.requiredContext)] }
      : {}),
  };
}

module.exports = {
  AGENT_REQUEST_SCHEMA_V1,
  AGENT_CAPABILITY_METADATA_KEY,
  CAPABILITY_DISCOVER_TOOL_NAME,
  SUPERVISOR_RUN_STATUSES,
  capabilityMetadata,
};

/**
 * @typedef {('desktop'|'project'|'app'|'automation'|'channel'|'api')} AgentRequestSourceType
 * @typedef {('interactive'|'non-interactive'|'confirm-risky')} AgentInteractionPolicy
 *
 * @typedef {Object} AgentRequestEnvelopeV1
 * @property {string} schema                       // 'dx-agent-request/v1'
 * @property {string} requestId
 * @property {{ type: AgentRequestSourceType, appId?: string, channelId?: string, entryPoint?: string }} source
 * @property {{ userId: string, organizationId?: string }} actor
 * @property {{ sessionId?: string, threadId?: string, continuationOfRunId?: string }} session
 * @property {{ projectId?: string, canvasId?: string, appWorkspaceId?: string, knowledgeScopeIds?: string[] }} scope
 * @property {string} goal
 * @property {string} [profileId]
 * @property {unknown} [appContext]
 * @property {AgentInteractionPolicy} interactionPolicy
 * @property {string[]} [capabilityBoundary]
 * @property {{ providerId?: string, model?: string }} [modelPreference]
 * @property {{ type: ('app'|'desktop'|'channel'|'webhook'), targetId?: string }} [deliveryTarget]
 * @property {string} [correlationId]
 * @property {string} [causationId]
 *
 * @typedef {Object} AgentToolCallV1
 * @property {string} id
 * @property {string} name
 * @property {string} arguments
 *
 * @typedef {Object} AgentGatewayStepResultV1
 * @property {string} runId
 * @property {string} content
 * @property {AgentToolCallV1[]} toolCalls
 * @property {boolean} terminal
 *
 * @typedef {Object} AgentSupervisorNode
 * @property {string} runId
 * @property {string|null} parentRunId
 * @property {string|null} taskId
 * @property {string|null} agentProfileId
 * @property {number} depth
 * @property {string} status
 * @property {string} goal
 * @property {string|null} errorMessage
 * @property {number} createdAt
 * @property {number|null} startedAt
 * @property {number|null} completedAt
 * @property {number} modelCalls
 * @property {number} toolCalls
 * @property {number|null} queueDurationMs
 * @property {number} wallDurationMs
 * @property {number} artifactCount
 * @property {number} artifactBytes
 *
 * @typedef {Object} AgentSupervisorInspection
 * @property {{ id: string, status: string, goal: string, errorMessage?: string, createdAt: number, startedAt?: number, completedAt?: number, agentProfileId?: string }} run
 * @property {AgentSupervisorNode[]} children
 * @property {Object} usage
 * @property {Object} timing
 * @property {Object} artifacts
 * @property {{ required: boolean, state: string, feedback: string[], items: Array<Object> }} review
 * @property {Array<Object>} corrections
 * @property {Record<string, Object>} recovery
 * @property {Record<string, Object>} nodeActivity
 * @property {Record<string, Object>} routing
 *
 * @typedef {Object} AgentCapabilityToolMetadataV1
 * @property {'dx-agent-capability/v1'} schema
 * @property {string} id
 * @property {string} domain
 * @property {string[]} intents
 * @property {string} [appId]
 * @property {string[]} [requiredContext]
 *
 * @typedef {Object} AgentFunctionToolV1
 * @property {'function'} type
 * @property {{ name: string, description?: string, parameters?: Record<string, unknown> }} function
 * @property {AgentCapabilityToolMetadataV1} [x_dx_capability]
 *
 * @typedef {Object} CapabilityDiscoveryRequestV1
 * @property {string[]} [intents]
 * @property {string[]} [domains]
 * @property {string} [reason]
 * @property {{ images?: number, videos?: number, audios?: number, files?: number }} [references]
 * @property {{ resolution?: string }} [requirements]
 *
 * @typedef {Object} CapabilityDiscoveryResultV1
 * @property {Array<{ id: string, domain: string, intents: string[], toolName: string }>} activated
 * @property {string[]} unavailable
 * @property {Record<string, Array<Object>>} [targets]
 */
