"use strict";
/**
 * B3c · Agent 请求信封 / 中间件管线 / JSON Schema 校验。
 *
 * 逐字移植（函数名、字段名、默认值、错误码语义）：
 *   · server/agent-runtime/envelope.ts:1-109          -> normalizeAgentRequestEnvelopeV1 / validateAgentRequestEnvelopeV1
 *   · server/agent-runtime/middleware.ts:1-42        -> AgentMiddlewarePipeline
 *   · server/agent-runtime/schemaValidator.ts:1-84   -> validateJsonSchema / validateJsonSchemaDefinition
 *   · shared/agentRequestContract.ts:1-58            -> AGENT_REQUEST_SCHEMA_V1 常量与枚举集合
 *
 * B4 说明：源 AuthUser 来自 server/auth.ts。本模块不 import auth，只消费真实调用方传入的
 * actor 对象；为兼容后续 B4 直接传 userId 的写法，额外接受字符串。
 */
const { randomUUID } = require("node:crypto");

const AGENT_REQUEST_SCHEMA_V1 = "dx-agent-request/v1";
const SOURCE_TYPES = new Set(["desktop", "project", "app", "automation", "channel", "api"]);
const INTERACTION_POLICIES = new Set(["interactive", "non-interactive", "confirm-risky"]);
const AGENT_GOAL_MAX_LENGTH = 20000;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, max) {
  return String(value || "").trim().slice(0, max);
}

function optionalText(value, max) {
  const result = text(value, max);
  return result || undefined;
}

function stringList(value, maxItems = 64) {
  if (!Array.isArray(value)) return undefined;
  const items = [...new Set(value.map((item) => text(item, 200)).filter(Boolean))].slice(0, maxItems);
  return items.length ? items : undefined;
}

/** B4 适配：Actor 既可能是 AuthUser 对象，也可能是纯 userId 字符串。 */
function actorUserId(actor) {
  if (typeof actor === "string") return text(actor, 160);
  return text(record(actor).id, 160);
}

/**
 * 源 envelope.ts:26-105。身份只取服务端会话（actor.id），请求体里的 actor 字段被忽略。
 * 缺 goal / app 来源缺 appId 时抛 statusCode 400，与源一致。
 */
function normalizeAgentRequestEnvelopeV1(raw, actor) {
  const input = record(raw);
  const sourceInput = record(input.source);
  const sessionInput = record(input.session);
  const scopeInput = record(input.scope);
  const modelInput = record(input.modelPreference);
  const deliveryInput = record(input.deliveryTarget);
  const sourceType = SOURCE_TYPES.has(sourceInput.type) ? sourceInput.type : "api";
  const policy = INTERACTION_POLICIES.has(input.interactionPolicy) ? input.interactionPolicy : "interactive";
  const goal = text(input.goal, AGENT_GOAL_MAX_LENGTH);
  if (!goal) throw Object.assign(new Error("Agent 请求缺少 goal"), { statusCode: 400 });
  const appId = optionalText(sourceInput.appId, 120);
  if (sourceType === "app" && !appId) throw Object.assign(new Error("APP Agent 请求缺少 source.appId"), { statusCode: 400 });
  const userId = actorUserId(actor);

  const envelope = {
    schema: AGENT_REQUEST_SCHEMA_V1,
    requestId: optionalText(input.requestId, 160) || randomUUID(),
    source: {
      type: sourceType,
      ...(appId ? { appId } : {}),
      ...(optionalText(sourceInput.channelId, 160) ? { channelId: optionalText(sourceInput.channelId, 160) } : {}),
      ...(optionalText(sourceInput.entryPoint, 120) ? { entryPoint: optionalText(sourceInput.entryPoint, 120) } : {}),
    },
    actor: {
      userId,
      ...(optionalText(input.organizationId, 160) ? { organizationId: optionalText(input.organizationId, 160) } : {}),
    },
    session: {
      ...(optionalText(sessionInput.sessionId, 160) ? { sessionId: optionalText(sessionInput.sessionId, 160) } : {}),
      ...(optionalText(sessionInput.threadId, 160) ? { threadId: optionalText(sessionInput.threadId, 160) } : {}),
      ...(optionalText(sessionInput.continuationOfRunId, 160) ? { continuationOfRunId: optionalText(sessionInput.continuationOfRunId, 160) } : {}),
    },
    scope: {
      ...(optionalText(scopeInput.projectId, 160) ? { projectId: optionalText(scopeInput.projectId, 160) } : {}),
      ...(optionalText(scopeInput.canvasId, 160) ? { canvasId: optionalText(scopeInput.canvasId, 160) } : {}),
      ...(optionalText(scopeInput.appWorkspaceId, 160) ? { appWorkspaceId: optionalText(scopeInput.appWorkspaceId, 160) } : {}),
      ...(stringList(scopeInput.knowledgeScopeIds, 32) ? { knowledgeScopeIds: stringList(scopeInput.knowledgeScopeIds, 32) } : {}),
    },
    goal,
    ...(optionalText(input.profileId, 120) ? { profileId: optionalText(input.profileId, 120) } : {}),
    ...(input.appContext !== undefined ? { appContext: input.appContext } : {}),
    interactionPolicy: policy,
    ...(stringList(input.capabilityBoundary) ? { capabilityBoundary: stringList(input.capabilityBoundary) } : {}),
    ...((optionalText(modelInput.providerId, 160) || optionalText(modelInput.model, 240))
      ? {
          modelPreference: {
            ...(optionalText(modelInput.providerId, 160) ? { providerId: optionalText(modelInput.providerId, 160) } : {}),
            ...(optionalText(modelInput.model, 240) ? { model: optionalText(modelInput.model, 240) } : {}),
          },
        }
      : {}),
    ...(deliveryInput.type && ["app", "desktop", "channel", "webhook"].includes(String(deliveryInput.type))
      ? {
          deliveryTarget: {
            type: deliveryInput.type,
            ...(optionalText(deliveryInput.targetId, 160) ? { targetId: optionalText(deliveryInput.targetId, 160) } : {}),
          },
        }
      : {}),
    ...(optionalText(input.correlationId, 160) ? { correlationId: optionalText(input.correlationId, 160) } : {}),
    ...(optionalText(input.causationId, 160) ? { causationId: optionalText(input.causationId, 160) } : {}),
  };
  return envelope;
}

/** 源 envelope.ts:107-109。只做结构判定，不做归一化。 */
function validateAgentRequestEnvelopeV1(value) {
  const input = record(value);
  const source = record(input.source);
  const actor = record(input.actor);
  return input.schema === AGENT_REQUEST_SCHEMA_V1
    && Boolean(text(input.requestId, 160))
    && Boolean(text(input.goal, AGENT_GOAL_MAX_LENGTH))
    && SOURCE_TYPES.has(source.type)
    && Boolean(text(actor.userId, 160))
    && INTERACTION_POLICIES.has(input.interactionPolicy);
}

// ---------------------------------------------------------------------------
// 中间件管线（middleware.ts:1-42）
// ---------------------------------------------------------------------------

/**
 * 源 middleware.ts:11-40。构造时按 order 升序排序；execute 先顺序 before，
 * operation 成功后逆序 after，失败时逆序 onError；onError 返回 'handled' 时
 * 管线吞掉异常并返回 undefined（与源一致的显式语义）。
 */
class AgentMiddlewarePipeline {
  constructor(middlewares = []) {
    this.middlewares = [...middlewares].sort((left, right) => left.order - right.order);
  }

  async execute(context, operation) {
    const active = this.middlewares.filter((item) => item.appliesTo?.(context) !== false);
    const entered = [];
    try {
      for (const middleware of active) {
        await middleware.before?.(context);
        entered.push(middleware);
      }
      const result = await operation(context);
      for (const middleware of [...entered].reverse()) await middleware.after?.(context, result);
      return result;
    } catch (error) {
      for (const middleware of [...entered].reverse()) {
        if (await middleware.onError?.(context, error) === "handled") return undefined;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// JSON Schema 校验（schemaValidator.ts:1-84）
// ---------------------------------------------------------------------------

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 源 schemaValidator.ts:31-49：只允许内联 Schema，禁止 $ref/$defs，深度 12、属性 256、32 KiB。 */
function validateJsonSchemaDefinition(rawSchema) {
  if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema)) return [{ path: "$", message: "Schema 必须是对象" }];
  if (Buffer.byteLength(JSON.stringify(rawSchema), "utf8") > 32 * 1024) return [{ path: "$", message: "Schema 不能超过 32 KiB" }];
  const issues = [];
  let propertyCount = 0;
  const walk = (value, path, depth) => {
    if (depth > 12) {
      issues.push({ path, message: "Schema 嵌套不能超过 12 层" });
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const schema = value;
    if ("$ref" in schema || "$defs" in schema || "definitions" in schema) issues.push({ path, message: "不允许引用或远程 Schema" });
    const properties = schema.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      propertyCount += Object.keys(properties).length;
      for (const [key, child] of Object.entries(properties)) walk(child, path + ".properties." + key, depth + 1);
    }
    if (schema.items) walk(schema.items, path + ".items", depth + 1);
  };
  walk(rawSchema, "$", 0);
  if (propertyCount > 256) issues.push({ path: "$", message: "Schema properties 总数不能超过 256" });
  return issues;
}

/** 源 schemaValidator.ts:51-84。返回问题数组（空数组 = 通过）。 */
function validateJsonSchema(value, rawSchema, path = "$") {
  if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema)) return [{ path, message: "Schema 必须是对象" }];
  const schema = rawSchema;
  const issues = [];
  const actual = valueType(value);
  const allowed = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (allowed.length && !allowed.includes(actual) && !(actual === "integer" && allowed.includes("number"))) {
    return [{ path, message: "应为 " + allowed.join("|") + "，实际为 " + actual }];
  }
  if (schema.const !== undefined && !same(value, schema.const)) issues.push({ path, message: "不等于 const 约束" });
  if (schema.enum && !schema.enum.some((item) => same(item, value))) issues.push({ path, message: "不在 enum 允许值中" });
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push({ path, message: "长度小于 " + schema.minLength });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push({ path, message: "长度大于 " + schema.maxLength });
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: "小于 " + schema.minimum });
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: "大于 " + schema.maximum });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path, message: "元素少于 " + schema.minItems });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path, message: "元素多于 " + schema.maxItems });
    if (schema.items) value.forEach((item, index) => issues.push(...validateJsonSchema(item, schema.items, path + "[" + index + "]")));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rec = value;
    for (const key of schema.required || []) if (!(key in rec)) issues.push({ path: path + "." + key, message: "缺少必填字段" });
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in rec) issues.push(...validateJsonSchema(rec[key], child, path + "." + key));
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(rec)) if (!known.has(key)) issues.push({ path: path + "." + key, message: "不允许额外字段" });
    }
  }
  return issues;
}

module.exports = {
  AGENT_REQUEST_SCHEMA_V1,
  SOURCE_TYPES,
  INTERACTION_POLICIES,
  AGENT_GOAL_MAX_LENGTH,
  normalizeAgentRequestEnvelopeV1,
  validateAgentRequestEnvelopeV1,
  AgentMiddlewarePipeline,
  validateJsonSchema,
  validateJsonSchemaDefinition,
};
