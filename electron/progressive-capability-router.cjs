"use strict";
/**
 * B3b · 渐进式能力工具集（CJS 移植）。
 *
 * 来源：shared/progressiveCapabilityRouter.ts:1-160。
 * 逐字对应：仅收敛 x_dx_capability.schema === 'dx-agent-capability/v1' 的 function 工具；
 * discoveryTool 的 JSON Schema、目标约束文案、applyTargets 的首选 Target 语义保持不变。
 */
const { CAPABILITY_DISCOVER_TOOL_NAME } = require("./agent-contracts.cjs");

/** progressiveCapabilityRouter.ts:8-10 */
function unique(items) {
  return [...new Set(items.map(String).map((item) => item.trim()).filter(Boolean))];
}

/** progressiveCapabilityRouter.ts:12-14 */
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** progressiveCapabilityRouter.ts:16-39 */
function targetFieldSchema(value) {
  const field = record(value);
  const key = String(field.key || "").trim();
  if (!key) return null;
  const rawType = String(field.type || "text").toLowerCase();
  const options = Array.isArray(field.options)
    ? field.options.map((item) => {
      const option = record(item);
      return option.value === undefined ? item : option.value;
    }).filter((item) => item !== undefined)
    : [];
  return {
    key,
    required: field.required === true,
    schema: {
      type: rawType === "number" || rawType === "slider" ? "number" : rawType === "toggle" || rawType === "boolean" ? "boolean" : "string",
      ...(field.label ? { description: String(field.label) } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
      ...(options.length ? { enum: options } : {}),
      ...(Number.isFinite(Number(field.min)) ? { minimum: Number(field.min) } : {}),
      ...(Number.isFinite(Number(field.max)) ? { maximum: Number(field.max) } : {}),
    },
  };
}

/** progressiveCapabilityRouter.ts:41-67 */
function constrainToolForTarget(tool, target) {
  const targetParameters = record(target.parameters);
  const fields = Array.isArray(targetParameters.fields)
    ? targetParameters.fields.map(targetFieldSchema).filter((item) => !!item)
    : [];
  const original = record(tool.function.parameters);
  const properties = { ...record(original.properties) };
  for (const field of fields) properties[field.key] = field.schema;
  const required = unique([
    ...(Array.isArray(original.required) ? original.required.map(String) : []),
    ...fields.filter((field) => field.required).map((field) => field.key),
  ]);
  const targetLabel = [target.providerName, target.model, target.operationId].filter(Boolean).join(" / ");
  return {
    ...tool,
    function: {
      ...tool.function,
      description: `${tool.function.description || tool.function.name}\n[V2 自动目标] ${targetLabel}。参数已按当前首选 Target 声明约束；Provider fallback 由系统负责。`,
      parameters: {
        ...original,
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
      },
    },
  };
}

/** progressiveCapabilityRouter.ts:69-156 */
class ProgressiveCapabilityToolset {
  constructor(tools, options = {}) {
    this.all = (Array.isArray(tools) ? tools : []).filter((tool) =>
      tool.type === "function" && tool.function && tool.function.name
      && tool.x_dx_capability && tool.x_dx_capability.schema === "dx-agent-capability/v1");
    this.activeNames = new Set();
    this.constrained = new Map();
    const intents = unique(this.all.flatMap((tool) => tool.x_dx_capability.intents || []));
    const domains = unique(this.all.map((tool) => tool.x_dx_capability.domain || ""));
    const catalog = this.all.map((tool) => {
      const meta = tool.x_dx_capability;
      const title = String(tool.function.description || tool.function.name).replace(/\s+/g, " ").slice(0, 180);
      return `${meta.intents.join("|")} → ${title}`;
    }).join("\n");
    this.discoveryTool = {
      type: "function",
      function: {
        name: CAPABILITY_DISCOVER_TOOL_NAME,
        description: [
          `发现并激活${options.surface ? `${options.surface}可用的` : ""}具体能力。普通问答可以直接回答；需要读取、修改、生成、调用 APP 或外部服务时，先调用本工具选择一个或多个意图。不要猜测尚未激活的工具名。`,
          "可用意图摘要：", catalog,
        ].filter(Boolean).join("\n"),
        parameters: {
          type: "object",
          properties: {
            intents: { type: "array", items: { type: "string", enum: intents }, minItems: 1, description: "本轮需要激活的精确能力意图；复合任务可选择多个。" },
            domains: { type: "array", items: { type: "string", enum: domains }, description: "只有无法确定精确意图时才按能力域发现。" },
            reason: { type: "string", description: "简述选择原因。" },
            references: {
              type: "object", description: "当前任务明确可用的素材数量；只填写已经存在或用户已提供的素材。",
              properties: {
                images: { type: "integer", minimum: 0 }, videos: { type: "integer", minimum: 0 },
                audios: { type: "integer", minimum: 0 }, files: { type: "integer", minimum: 0 },
              },
            },
            requirements: {
              type: "object", description: "用户明确要求的输出规格；系统据此跳过不支持的高优先级模型。",
              properties: { resolution: { type: "string", description: "例如 2k、4k、720p、1080p。" } },
            },
          },
          anyOf: [{ required: ["intents"] }, { required: ["domains"] }],
        },
      },
    };
  }

  /** progressiveCapabilityRouter.ts:116-118 */
  tools() {
    return [this.discoveryTool, ...this.all.filter((tool) => this.activeNames.has(tool.function.name)).map((tool) => this.constrained.get(tool.function.name) || tool)];
  }

  /** progressiveCapabilityRouter.ts:120-122 */
  isDiscovery(name) {
    return name === CAPABILITY_DISCOVER_TOOL_NAME;
  }

  /** progressiveCapabilityRouter.ts:124-144 */
  discover(value) {
    const input = record(value);
    const requestedIntents = unique(Array.isArray(input.intents) ? input.intents : []);
    const requestedDomains = unique(Array.isArray(input.domains) ? input.domains : []);
    const requested = new Set([...requestedIntents, ...requestedDomains]);
    const activated = this.all.filter((tool) => {
      const meta = tool.x_dx_capability;
      return requestedDomains.includes(meta.domain) || meta.intents.some((intent) => requestedIntents.includes(intent));
    });
    for (const tool of activated) this.activeNames.add(tool.function.name);
    const matched = new Set(activated.flatMap((tool) => [tool.x_dx_capability.domain, ...tool.x_dx_capability.intents]));
    return {
      activated: activated.map((tool) => ({
        id: tool.x_dx_capability.id,
        domain: tool.x_dx_capability.domain,
        intents: [...tool.x_dx_capability.intents],
        toolName: tool.function.name,
      })),
      unavailable: [...requested].filter((item) => !matched.has(item)),
    };
  }

  /** progressiveCapabilityRouter.ts:146-155 */
  applyTargets(targets) {
    if (!targets) return;
    for (const tool of this.all) {
      if (!this.activeNames.has(tool.function.name)) continue;
      const intent = (tool.x_dx_capability.intents || []).find((item) => targets[item] && targets[item].length);
      const target = intent ? targets[intent] && targets[intent][0] : undefined;
      if (target) this.constrained.set(tool.function.name, constrainToolForTarget(tool, target));
    }
  }
}

/** progressiveCapabilityRouter.ts:158-160 */
function createProgressiveCapabilityToolset(tools, options = {}) {
  return new ProgressiveCapabilityToolset(tools, options);
}

module.exports = {
  ProgressiveCapabilityToolset,
  createProgressiveCapabilityToolset,
};
