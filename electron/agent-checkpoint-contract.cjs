/**
 * B3a · Agent 检查点契约（移植自 DX OS 0.5.1 shared/agentCheckpointContract.ts）。
 *
 * 源：<DX OS.app>/Contents/Resources/app.asar.unpacked/shared/agentCheckpointContract.ts
 *   · :1  AGENT_CHECKPOINT_SCHEMA = 'dx-agent-checkpoint/v1'
 *   · :3-:9  AgentCheckpointPhase（6 态）
 *   · :11 DurableToolCall = { id, name, arguments }
 *   · :13-:22 AgentCheckpointState（持久执行游标；刻意不含隐藏推理/凭据/供应商密钥）
 *
 * TS 的 type 在运行时不存在，这里把它们的"运行时形态"固定成常量与校验函数：
 *   · AGENT_CHECKPOINT_SCHEMA —— 落库的 schema_version 字面量；
 *   · AGENT_CHECKPOINT_PHASES + isCheckpointPhase —— phase 的运行时白名单；
 *   · AGENT_CHECKPOINT_STATE_FIELDS / DURABLE_TOOL_CALL_FIELDS —— 契约字段名（供后续批次对接）。
 */
"use strict";

/** shared/agentCheckpointContract.ts:1 */
const AGENT_CHECKPOINT_SCHEMA = "dx-agent-checkpoint/v1";

/** shared/agentCheckpointContract.ts:3-:9 —— 顺序与源一致。 */
const AGENT_CHECKPOINT_PHASES = Object.freeze([
  "model_response_persisted",
  "tool_progress",
  "waiting_user",
  "waiting_children",
  "verification",
  "terminal",
]);

/** @returns {boolean} 是否为合法 phase（不抛错，纯判定）。 */
function isCheckpointPhase(value) {
  return AGENT_CHECKPOINT_PHASES.includes(value);
}

/** shared/agentCheckpointContract.ts:14-:22 —— AgentCheckpointState 的字段名（schema 必有，其余可选）。 */
const AGENT_CHECKPOINT_STATE_FIELDS = Object.freeze([
  "schema",
  "turnId",
  "iteration",
  "nextToolIndex",
  "pendingToolCalls",
  "lastSteerSequence",
  "schemaCorrectionCount",
  "operationIds",
]);

/** shared/agentCheckpointContract.ts:11 —— DurableToolCall 的字段名。 */
const DURABLE_TOOL_CALL_FIELDS = Object.freeze(["id", "name", "arguments"]);

module.exports = {
  AGENT_CHECKPOINT_SCHEMA,
  AGENT_CHECKPOINT_PHASES,
  isCheckpointPhase,
  AGENT_CHECKPOINT_STATE_FIELDS,
  DURABLE_TOOL_CALL_FIELDS,
};
