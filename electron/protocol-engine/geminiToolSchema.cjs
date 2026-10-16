"use strict";
/**
 * Gemini function-declaration 的 JSON Schema 归一化。
 * 源：DXSRC/geminiToolSchema.ts:1-53
 */
function isSchema(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeNode(value, depth) {
  if (!isSchema(value) || depth > 16) return { type: "object", properties: {} };
  const branches = ["allOf", "anyOf", "oneOf"].flatMap((key) =>
    Array.isArray(value[key]) ? value[key].filter(isSchema).map((branch) => ({ kind: key, schema: normalizeNode(branch, depth + 1) })) : []);
  const rawType = Array.isArray(value.type) ? value.type.find((type) => type !== "null") : value.type;
  const type = typeof rawType === "string" && ["object", "array", "string", "number", "integer", "boolean"].includes(rawType.toLowerCase()) ? rawType.toLowerCase()
    : branches.some(({ schema }) => schema.type === "object") || isSchema(value.properties) ? "object"
      : branches.find(({ schema }) => schema.type !== "object")?.schema.type || "object";
  const result = { type };
  if (typeof value.description === "string") result.description = value.description;
  if (type === "object") {
    const properties = {};
    const required = new Set(Array.isArray(value.required) ? value.required.filter((name) => typeof name === "string") : []);
    for (const { kind, schema } of branches) {
      if (schema.type !== "object") continue;
      Object.assign(properties, schema.properties);
      if (kind === "allOf" && Array.isArray(schema.required)) for (const name of schema.required) required.add(name);
    }
    if (isSchema(value.properties)) for (const [name, property] of Object.entries(value.properties)) properties[name] = normalizeNode(property, depth + 1);
    result.properties = properties;
    const validRequired = [...required].filter((name) => Object.prototype.hasOwnProperty.call(properties, name));
    if (validRequired.length) result.required = validRequired;
    if (value.additionalProperties !== undefined) result.additionalProperties = value.additionalProperties !== false;
  }
  if (type === "array") result.items = normalizeNode(value.items ?? branches.find(({ schema }) => schema.items !== undefined)?.schema.items, depth + 1);
  const variants = [value, ...branches.map(({ schema }) => schema)];
  const enums = variants.flatMap((schema) => Array.isArray(schema.enum) ? schema.enum : []);
  if (enums.length) result.enum = [...new Set(enums.filter((item) => item !== null))];
  if (value.default !== undefined) result.default = value.default;
  return result;
}

function geminiToolParameters(value) {
  const normalized = normalizeNode(value, 0);
  return normalized.type === "object" ? normalized : { type: "object", properties: {} };
}

function geminiToolDefinitions(value) {
  if (!Array.isArray(value)) return value;
  return value.map((tool) => isSchema(tool) && isSchema(tool.function)
    ? { ...tool, function: { ...tool.function, parameters: geminiToolParameters(tool.function.parameters) } }
    : tool);
}

module.exports = { geminiToolParameters, geminiToolDefinitions };
