/**
 * D4-03A · Tool Registry（唯一权威）。
 *
 * Registry 只由 OpenArc trusted code 管理：Harness 不能 register / modify schema /
 * enable / 改 risk class。每个 Tool 有固定 contract（id/version/schema/risk/sideEffect/
 * requiresApproval/permissions/executionProvider/enabled）。
 *
 * 内置少量测试 Tool（test.echo / resource.read.metadata）；**绝不注册** shell / terminal /
 * filesystem.write / process.spawn / MCP / browser side-effect。
 */
"use strict";
const domain = require("./tool-domain.cjs");
const { RISK_CLASS, SIDE_EFFECT, TOOL_ERROR, isWellFormedToolId, approvalRequiredForRisk, sideEffectForRisk } = domain;

const CONTRACT_FIELDS = ["toolId", "version", "displayName", "description", "inputSchema", "outputSchema", "riskClass", "sideEffect", "requiresApproval", "requiredPermissions", "resourceActions", "executionProvider", "enabled", "expectedSideEffects"];

/** 极简 JSON Schema 子集校验器：object/string/integer/number/boolean/array + additionalProperties:false。*/
function validateSchema(schema, value, path = "$") {
  const errors = [];
  if (!schema || typeof schema !== "object") return { ok: true, errors };
  const type = schema.type;
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const typeOk = !type || (type === "integer" ? Number.isInteger(value) : type === "number" ? typeof value === "number" : type === "object" ? actual === "object" : type === "array" ? actual === "array" : actual === type);
  if (!typeOk) { errors.push({ path, reason: "TYPE_MISMATCH", expected: type }); return { ok: false, errors }; }
  if (type === "object" && value && typeof value === "object") {
    const props = schema.properties || {};
    for (const req of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, req)) errors.push({ path: path + "." + req, reason: "REQUIRED" });
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) {
        if (schema.additionalProperties === false) errors.push({ path: path + "." + key, reason: "ADDITIONAL_PROPERTY" });
        continue;
      }
      const sub = validateSchema(props[key], value[key], path + "." + key);
      if (!sub.ok) errors.push(...sub.errors);
    }
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errors.push({ path, reason: "MIN_LENGTH" });
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push({ path, reason: "MAX_LENGTH" });
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push({ path, reason: "PATTERN" });
    if (schema.enum && !schema.enum.includes(value)) errors.push({ path, reason: "ENUM" });
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push({ path, reason: "MINIMUM" });
    if (schema.maximum != null && value > schema.maximum) errors.push({ path, reason: "MAXIMUM" });
  }
  if (Array.isArray(value)) {
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push({ path, reason: "MAX_ITEMS" });
    if (schema.items) value.forEach((v, i) => { const sub = validateSchema(schema.items, v, path + "[" + i + "]"); if (!sub.ok) errors.push(...sub.errors); });
  }
  return { ok: errors.length === 0, errors };
}

/** 内置少量真实测试 Tool contract。*/
const BUILTIN_CONTRACTS = Object.freeze([
  {
    toolId: "test.echo",
    version: 1,
    displayName: "Test Echo",
    description: "测试专用：原样返回 message。无副作用，绝不在生产 profile 注册。",
    inputSchema: { type: "object", additionalProperties: false, properties: { message: { type: "string", minLength: 1, maxLength: 200 } }, required: ["message"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { echo: { type: "string" } }, required: ["echo"] },
    riskClass: RISK_CLASS.READ_ONLY,
    sideEffect: SIDE_EFFECT.NONE,
    requiresApproval: false,
    requiredPermissions: [],
    resourceActions: [],
    executionProvider: "test",
    enabled: true,
    expectedSideEffects: ["no side effect"],
  },
  {
    toolId: "test.write",
    version: 1,
    displayName: "Test Write (approval probe)",
    description: "测试专用：可逆写入探针，永久 requiresApproval；D4-03A 绝不执行。",
    inputSchema: { type: "object", additionalProperties: false, properties: { target: { type: "string", minLength: 1, maxLength: 100 } }, required: ["target"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] },
    riskClass: RISK_CLASS.REVERSIBLE_WRITE,
    sideEffect: SIDE_EFFECT.WRITE,
    requiresApproval: true,
    requiredPermissions: [],
    resourceActions: [],
    executionProvider: "test",
    enabled: true,
    expectedSideEffects: ["writes test target (dry-run only in D4-03A; never executed)"],
  },
  {
    toolId: "resource.read.metadata",
    version: 1,
    displayName: "Read Resource Metadata",
    description: "读取 Resource metadata（D4-03A 只做 dry-run ExecutionPlan，不执行）。",
    inputSchema: { type: "object", additionalProperties: false, properties: { resourceRef: { type: "string", pattern: "^resource://[A-Za-z0-9_-]+$" } }, required: ["resourceRef"] },
    outputSchema: { type: "object", additionalProperties: true, properties: { resourceRef: { type: "string" }, name: { type: "string" } }, required: ["resourceRef"] },
    riskClass: RISK_CLASS.READ_ONLY,
    sideEffect: SIDE_EFFECT.READ,
    requiresApproval: false,
    requiredPermissions: ["tool.resource.readMetadata"],
    resourceActions: ["resource.read"],
    executionProvider: "ResourceService",
    enabled: true,
    expectedSideEffects: ["reads resource metadata (dry-run only in D4-03A)"],
  },
]);

function frozenContract(c) {
  return Object.freeze({ ...c, requiredPermissions: Object.freeze([...(c.requiredPermissions || [])]), resourceActions: Object.freeze([...(c.resourceActions || [])]), expectedSideEffects: Object.freeze([...(c.expectedSideEffects || [])]) });
}

class ToolRegistry {
  constructor({ contracts = null } = {}) {
    this.tools = new Map();
    for (const c of (contracts && contracts.length ? contracts : BUILTIN_CONTRACTS)) this.register(c);
  }
  key(toolId, version) { return String(toolId) + "@" + String(version); }
  register(contract) {
    if (!contract || typeof contract !== "object") throw new Error("tool contract required");
    const toolId = String(contract.toolId || "");
    if (!isWellFormedToolId(toolId)) throw new Error("invalid toolId: " + toolId);
    const version = Number(contract.version);
    if (!Number.isInteger(version) || version < 1) throw new Error("invalid tool version: " + contract.version);
    if (!domain.RISK_CLASS_ALL.includes(contract.riskClass)) throw new Error("invalid riskClass: " + contract.riskClass);
    if (contract.sideEffect && !domain.SIDE_EFFECT_ALL.includes(contract.sideEffect)) throw new Error("invalid sideEffect: " + contract.sideEffect);
    if (contract.inputSchema && contract.inputSchema.type !== "object") throw new Error("inputSchema must be object");
    if (this.tools.has(this.key(toolId, version))) throw new Error("duplicate tool contract: " + this.key(toolId, version));
    const normalized = frozenContract({ sideEffect: sideEffectForRisk(contract.riskClass), requiresApproval: approvalRequiredForRisk(contract.riskClass), ...contract, toolId, version });
    this.tools.set(this.key(toolId, version), normalized);
    return normalized;
  }
  /** 稳定 toolId 集合（版本无关）。*/
  ids() { return [...new Set([...this.tools.keys()].map((k) => k.split("@")[0]))].sort(); }
  versionsOf(toolId) { return [...this.tools.keys()].filter((k) => k.split("@")[0] === String(toolId)).map((k) => Number(k.split("@")[1])).sort((a, b) => a - b); }
  get(toolId, version) { return this.tools.get(this.key(toolId, version)) || null; }
  list() { return [...this.tools.values()].map((c) => ({ toolId: c.toolId, version: c.version, displayName: c.displayName, riskClass: c.riskClass, sideEffect: c.sideEffect, requiresApproval: c.requiresApproval, enabled: c.enabled })); }
  /**
   * resolve：未知 / 版本不符 / disabled 均返回 ok:false，但尽量带 contract 供 decision 记录 risk。
   */
  resolve(toolId, version) {
    if (!isWellFormedToolId(toolId)) return { ok: false, error: TOOL_ERROR.TOOL_NOT_FOUND };
    const versions = this.versionsOf(toolId);
    if (!versions.length) return { ok: false, error: TOOL_ERROR.TOOL_NOT_FOUND };
    const v = Number(version);
    const contract = this.get(toolId, v);
    if (!contract) return { ok: false, error: TOOL_ERROR.TOOL_VERSION_UNSUPPORTED, supportedVersions: versions };
    if (contract.enabled === false) return { ok: false, error: TOOL_ERROR.TOOL_DISABLED, contract };
    return { ok: true, contract };
  }
  validateInput(contract, args) { return validateSchema(contract.inputSchema, args); }
  /** dry-run：只生成 ExecutionPlan，绝不执行。*/
  buildExecutionPlan(contract, args, resourceRefs = []) {
    return Object.freeze({
      toolId: contract.toolId,
      toolVersion: contract.version,
      resourceRefs: Object.freeze([...resourceRefs]),
      riskClass: contract.riskClass,
      sideEffect: contract.sideEffect,
      requiredPermissions: Object.freeze([...(contract.requiredPermissions || [])]),
      resourceActions: Object.freeze([...(contract.resourceActions || [])]),
      approvalRequired: !!contract.requiresApproval,
      expectedSideEffects: Object.freeze([...(contract.expectedSideEffects || [])]),
      executionProvider: contract.executionProvider,
      dryRun: true,
      execute: false,
    });
  }
}

module.exports = { ToolRegistry, validateSchema, BUILTIN_CONTRACTS, CONTRACT_FIELDS };
