/**
 * A03 · 画布内置节点运行期注册表（17 个 builtin.* 节点）。
 *
 * 与 developer-canvas-builtins.cjs 的分工：那份文件是**逐字移植的纯数据**，只给清单校验用；
 * 本文件在它之上补运行期需要的三件事，且不复制定义本身：
 *   1) 注册表：按 type 索引，builtin 与插件节点走同一个 register()；
 *   2) 参数 schema：JSON-Schema 子集，执行前校验（缺参 / 类型不符 / 超范围一律结构化拒绝）；
 *   3) 执行器映射：executor.id → 本地执行 / 生成端口 / 媒体处理端口 / 客户端渲染；
 *      没有注入对应端口的能力**不假执行**，返回结构化 CANVAS_NODE_EXECUTOR_UNAVAILABLE。
 *
 * 与 canvas-domain.NODE_TYPES 的区别沿用原模块口径：NODE_TYPES 是画布文档的卡片 kind，
 * 这里是 DXOS builtin.* 节点类型；两套命名空间不合并。
 */
"use strict";

const crypto = require("node:crypto");
const { BUILTIN_CANVAS_NODES } = require("./developer-canvas-builtins.cjs");

const FORMAT = "openarc-canvas-node-registry/v1";

const ERROR = Object.freeze({
  NODE_TYPE_UNKNOWN: "CANVAS_NODE_TYPE_UNKNOWN",
  NODE_PARAMS_INVALID: "CANVAS_NODE_PARAMS_INVALID",
  NODE_EXECUTOR_UNAVAILABLE: "CANVAS_NODE_EXECUTOR_UNAVAILABLE",
  NODE_EXECUTION_FAILED: "CANVAS_NODE_EXECUTION_FAILED",
  NODE_PORT_UNKNOWN: "CANVAS_NODE_PORT_UNKNOWN",
  NODE_PORT_INCOMPATIBLE: "CANVAS_NODE_PORT_INCOMPATIBLE",
  NODE_DEFINITION_INVALID: "CANVAS_NODE_DEFINITION_INVALID",
  NODE_TYPE_DUPLICATE: "CANVAS_NODE_TYPE_DUPLICATE",
});

/** 端口类型宇宙取自 17 个定义里真实出现过的 type（插件可自带新类型，兼容性按精确匹配）。 */
const PORT_TYPES = Object.freeze([
  "text", "table", "json", "file", "artifact",
  "media.image", "media.image[]", "media.video", "media.video[]", "media.audio", "media.audio[]",
]);

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });
const isObj = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value, max = 200) => (typeof value === "string" ? value.slice(0, max) : "");

const string = (maxLength, extra = {}) => ({ type: "string", maxLength, ...extra });
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const array = (items, extra = {}) => ({ type: "array", items, ...extra });

const mediaProperties = {
  images: array(string(400), { maxItems: 8 }),
  videos: array(string(400), { maxItems: 8 }),
  audios: array(string(400), { maxItems: 8 }),
};

/** 生成类参数：模型 / 尺寸等由 canvas-service 已有的解析链消费；这里只做输入形状约束。 */
const generationProperties = {
  prompt: string(4000),
  negativePrompt: string(2000),
  model: string(160),
  configId: string(120),
  count: integer(1, 4),
  size: string(32),
  ratio: string(32),
  resolution: string(32),
  customSize: string(32),
  customRatio: string(32),
};

const generationSchema = (extra = {}) => ({
  type: "object",
  properties: { ...generationProperties, ...mediaProperties, ...(extra.properties || {}) },
  additionalProperties: true,
});

/** 参数 schema 只覆盖本仓真实消费的键；未声明的键允许存在（画布节点可能带 UI 私有字段）。 */
const PARAM_SCHEMAS = Object.freeze({
  "builtin.director-3d": { type: "object", properties: {}, additionalProperties: true },
  "builtin.image-asset": { type: "object", properties: { ref: string(400), url: string(400), name: string(200), mime: string(120) }, additionalProperties: true },
  "builtin.video-asset": { type: "object", properties: { ref: string(400), url: string(400), name: string(200), mime: string(120) }, additionalProperties: true },
  "builtin.audio-asset": { type: "object", properties: { ref: string(400), url: string(400), name: string(200), mime: string(120) }, additionalProperties: true },
  "builtin.file-asset": { type: "object", properties: { ref: string(400), url: string(400), name: string(200), mime: string(120) }, additionalProperties: true },
  "builtin.image-generator": generationSchema(),
  "builtin.midjourney-generator": generationSchema(),
  "builtin.video-generator": generationSchema(),
  "builtin.audio-generator": generationSchema(),
  "builtin.llm": {
    type: "object",
    properties: {
      prompt: string(4000),
      messages: array({ type: "object", properties: { role: string(20), content: string(20000) }, required: ["role", "content"], additionalProperties: true }, { minItems: 1, maxItems: 64 }),
      model: string(160), configId: string(120), systemPrompt: string(4000),
    },
    additionalProperties: true,
  },
  "builtin.table": { type: "object", properties: { protocolParams: { type: "object" }, table: { type: "object" }, rows: array({ type: "object" }) }, additionalProperties: true },
  "builtin.image-compare": { type: "object", properties: { ...mediaProperties, columns: integer(1, 8) }, required: ["images"], additionalProperties: true },
  "builtin.mosaic": { type: "object", properties: { images: array(string(400), { minItems: 1, maxItems: 12 }), texts: array(string(2000), { maxItems: 12 }), columns: integer(1, 8), gap: integer(0, 64), background: string(32) }, required: ["images"], additionalProperties: true },
  "builtin.group": { type: "object", properties: {}, additionalProperties: true },
  "builtin.prompt": { type: "object", properties: { prompt: string(20000) }, additionalProperties: true },
  "builtin.sticky": { type: "object", properties: { prompt: string(20000) }, additionalProperties: true },
  "builtin.junction": { type: "object", properties: { inputs: array({}) }, additionalProperties: true },
});

/**
 * executor.id → 运行方式。generation / media-process / plugin 需要**显式注入端口**；
 * client-render 由画布宿主渲染，主进程不假装能跑。
 */
const EXECUTOR_PROFILES = Object.freeze({
  "canvas.asset.image": { kind: "asset", capability: "canvas.asset", output: "image" },
  "canvas.asset.video": { kind: "asset", capability: "canvas.asset", output: "video" },
  "canvas.asset.audio": { kind: "asset", capability: "canvas.asset", output: "audio" },
  "canvas.asset.file": { kind: "asset", capability: "canvas.asset", output: "file" },
  "canvas.generate.image": { kind: "generation", capability: "model-generation" },
  "canvas.generate.video": { kind: "generation", capability: "model-generation" },
  "canvas.generate.audio": { kind: "generation", capability: "model-generation" },
  "canvas.generate.midjourney": { kind: "generation", capability: "model-generation" },
  "canvas.llm": { kind: "generation", capability: "model-generation" },
  "canvas.director3d": { kind: "client-render", capability: "client-renderer" },
  "canvas.table": { kind: "local", handler: "table" },
  "canvas.prompt": { kind: "local", handler: "text" },
  "canvas.sticky": { kind: "local", handler: "text" },
  "canvas.group": { kind: "local", handler: "noop" },
  "canvas.junction": { kind: "local", handler: "junction" },
  "canvas.image.compare": { kind: "media-process", capability: "media-processing" },
  "canvas.image.mosaic": { kind: "media-process", capability: "media-processing" },
});

const BUILTIN_EXECUTOR_IDS = Object.freeze(BUILTIN_CANVAS_NODES.map((node) => node.executor && node.executor.id));

function validateDefinition(def) {
  const errors = [];
  if (!isObj(def)) return { ok: false, errors: [{ path: "definition", message: "节点定义必须是对象" }] };
  const type = str(def.type, 120);
  if (!/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/i.test(type)) errors.push({ path: "type", message: "type 必须是由点分隔的小写命名空间" });
  if (!isObj(def.executor) || !str(def.executor.type, 40) || !str(def.executor.id, 120)) errors.push({ path: "executor", message: "executor.type / executor.id 必填" });
  const checkPorts = (list, axis) => {
    if (!Array.isArray(list)) { errors.push({ path: axis, message: "必须是数组" }); return; }
    for (const [index, port] of list.entries()) {
      if (!isObj(port) || !str(port.id, 80) || !str(port.type, 40)) errors.push({ path: axis + "[" + index + "]", message: "端口需要 id 与 type" });
    }
  };
  checkPorts(def.inputs || [], "inputs");
  checkPorts(def.outputs || [], "outputs");
  return { ok: errors.length === 0, errors };
}

function compatibleType(fromType, toType) {
  if (!fromType || !toType) return false;
  if (fromType === toType) return true;
  return toType === "artifact" || fromType === "artifact";
}

function validateAgainstSchema(schema, value, path, errors) {
  if (!isObj(schema)) return;
  if (value === undefined) return;
  if (schema.enum && !schema.enum.includes(value)) { errors.push({ path, message: "取值不在枚举内" }); return; }
  const type = schema.type;
  if (type === "string") {
    if (typeof value !== "string") { errors.push({ path, message: "必须是字符串" }); return; }
    if (schema.minLength != null && value.length < schema.minLength) errors.push({ path, message: "长度小于 " + schema.minLength });
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push({ path, message: "长度超过 " + schema.maxLength });
    return;
  }
  if (type === "integer") {
    if (!Number.isInteger(value)) { errors.push({ path, message: "必须是整数" }); return; }
    if (schema.minimum != null && value < schema.minimum) errors.push({ path, message: "小于最小值 " + schema.minimum });
    if (schema.maximum != null && value > schema.maximum) errors.push({ path, message: "大于最大值 " + schema.maximum });
    return;
  }
  if (type === "number") {
    if (!Number.isFinite(value)) { errors.push({ path, message: "必须是有限数字" }); return; }
    if (schema.minimum != null && value < schema.minimum) errors.push({ path, message: "小于最小值 " + schema.minimum });
    if (schema.maximum != null && value > schema.maximum) errors.push({ path, message: "大于最大值 " + schema.maximum });
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") errors.push({ path, message: "必须是布尔值" });
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) { errors.push({ path, message: "必须是数组" }); return; }
    if (schema.minItems != null && value.length < schema.minItems) errors.push({ path, message: "至少 " + schema.minItems + " 项" });
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push({ path, message: "最多 " + schema.maxItems + " 项" });
    for (const [index, item] of value.entries()) validateAgainstSchema(schema.items || {}, item, path + "[" + index + "]", errors);
    return;
  }
  if (type === "object") {
    if (!isObj(value)) { errors.push({ path, message: "必须是对象" }); return; }
    const properties = isObj(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!(key in value)) errors.push({ path: path + "." + key, message: "必填" });
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) validateAgainstSchema(child, value[key], path + "." + key, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in properties)) errors.push({ path: path + "." + key, message: "未声明的字段" });
    }
  }
}

const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const hasMedia = (params) => ["images", "videos", "audios"].some((key) => Array.isArray(params[key]) && params[key].length > 0);

/** 定义本身没有 required，真实运行约束在这里补：生成要有 prompt 或媒体；LLM 要有 prompt 或 messages。 */
function ruleErrors(type, params) {
  const errors = [];
  if (["builtin.image-generator", "builtin.video-generator", "builtin.audio-generator"].includes(type)) {
    if (!nonEmptyString(params.prompt) && !hasMedia(params)) errors.push({ path: "params.prompt", message: "prompt 或 images/videos/audios 至少给一个" });
  }
  if (type === "builtin.midjourney-generator" && !nonEmptyString(params.prompt)) errors.push({ path: "params.prompt", message: "Midjourney 必须给 prompt" });
  if (type === "builtin.llm") {
    const hasMessages = Array.isArray(params.messages) && params.messages.length > 0;
    if (!nonEmptyString(params.prompt) && !hasMessages) errors.push({ path: "params.prompt", message: "prompt 或 messages 至少给一个" });
  }
  return errors;
}

class CanvasNodeRegistry {
  constructor({ definitions = BUILTIN_CANVAS_NODES, extraDefinitions = [], ports = {}, canvasService = null } = {}) {
    this.ports = ports && typeof ports === "object" ? ports : {};
    this.canvasService = canvasService || null;
    this.definitions = new Map();
    this.order = [];
    for (const def of Array.isArray(definitions) ? definitions : []) this.register(def, { origin: "builtin" });
    for (const def of Array.isArray(extraDefinitions) ? extraDefinitions : []) this.register(def, { origin: "plugin" });
  }

  /** builtin 与插件节点走同一条登记路径；重复 type 拒绝而不是覆盖。 */
  register(def, { origin = "plugin" } = {}) {
    const validation = validateDefinition(def);
    if (!validation.ok) return fail(ERROR.NODE_DEFINITION_INVALID, { type: def && def.type, errors: validation.errors });
    const type = String(def.type);
    if (this.definitions.has(type)) return fail(ERROR.NODE_TYPE_DUPLICATE, { type });
    const descriptor = Object.freeze({
      type,
      origin: origin === "builtin" ? "builtin" : "plugin",
      title: str(def.title, 120),
      description: str(def.description, 500),
      category: str(def.category, 40),
      version: Number(def.version) || 1,
      stateVersion: Number(def.stateVersion) || 1,
      defaultSize: isObj(def.defaultSize) ? { width: Number(def.defaultSize.width) || 0, height: Number(def.defaultSize.height) || 0 } : null,
      inputs: (Array.isArray(def.inputs) ? def.inputs : []).map((port) => ({ id: String(port.id), title: str(port.title, 80), type: String(port.type), ...(port.multiple === true ? { multiple: true } : {}), ...(port.required === true ? { required: true } : {}) })),
      outputs: (Array.isArray(def.outputs) ? def.outputs : []).map((port) => ({ id: String(port.id), title: str(port.title, 80), type: String(port.type), ...(port.multiple === true ? { multiple: true } : {}) })),
      executor: { type: String(def.executor.type), id: String(def.executor.id) },
      paramSchema: PARAM_SCHEMAS[type] || { type: "object", properties: {}, additionalProperties: true },
    });
    this.definitions.set(type, descriptor);
    this.order.push(type);
    return ok({ node: this.describe(type) });
  }

  has(type) { return this.definitions.has(String(type || "")); }

  get(type) { return this.definitions.get(String(type || "")) || null; }

  executorOf(type) {
    const def = this.get(type);
    if (!def) return null;
    const profile = EXECUTOR_PROFILES[def.executor.id] || { kind: "plugin", capability: "plugin-node-executor" };
    let available = false;
    let reason = "no-executor-port";
    if (profile.kind === "asset" || profile.kind === "local") { available = true; reason = null; }
    else if (profile.kind === "generation") {
      const port = type === "builtin.video-generator" && typeof this.ports.videoGeneration === "function" ? this.ports.videoGeneration : this.ports.generation;
      const supported = typeof port === "function" && (typeof port.supports !== "function" || port.supports(type));
      available = !!supported;
      reason = typeof port !== "function" ? "no-generation-port" : available ? null : "unsupported-model-kind";
    }
    else if (profile.kind === "media-process") {
      const port = this.ports.mediaProcess;
      const supported = typeof port === "function" && (typeof port.supports !== "function" || port.supports(type));
      available = !!supported;
      reason = typeof port !== "function" ? "no-media-port" : available ? null : "unsupported-media-kind";
    }
    else if (profile.kind === "client-render") { available = false; reason = "requires-client-renderer"; }
    else if (profile.kind === "plugin") { available = typeof this.ports.plugin === "function"; reason = available ? null : "no-plugin-port"; }
    return { ...profile, available, reason };
  }

  describe(type) {
    const def = this.get(type);
    if (!def) return null;
    const executor = this.executorOf(type);
    return { ...def, executable: !!executor.available, unavailable: executor.available ? null : { code: ERROR.NODE_EXECUTOR_UNAVAILABLE, detail: { type: def.type, executorId: def.executor.id, capability: executor.capability, reason: executor.reason } } };
  }

  list() { return this.order.map((type) => this.describe(type)); }

  summary() {
    const nodes = this.list();
    const digest = crypto.createHash("sha256").update(JSON.stringify(nodes.map((node) => ({ type: node.type, origin: node.origin, executor: node.executor, inputs: node.inputs, outputs: node.outputs, paramSchema: node.paramSchema })))).digest("hex");
    return {
      format: FORMAT,
      digests: { registry: digest },
      generatedAt: Date.now(),
      count: nodes.length,
      builtinCount: nodes.filter((node) => node.origin === "builtin").length,
      pluginCount: nodes.filter((node) => node.origin === "plugin").length,
      executableCount: nodes.filter((node) => node.executable).length,
      types: nodes.map((node) => node.type),
    };
  }

  validateParams(type, params) {
    const def = this.get(type);
    if (!def) return fail(ERROR.NODE_TYPE_UNKNOWN, { type: String(type || "") });
    if (params === undefined || params === null) params = {};
    if (!isObj(params)) return fail(ERROR.NODE_PARAMS_INVALID, { type: def.type, errors: [{ path: "params", message: "参数必须是对象" }] });
    const errors = [];
    validateAgainstSchema(def.paramSchema, params, "params", errors);
    errors.push(...ruleErrors(def.type, params));
    if (errors.length) return fail(ERROR.NODE_PARAMS_INVALID, { type: def.type, errors });
    return ok({ type: def.type, params });
  }

  validatePorts(type, ports) {
    const def = this.get(type);
    if (!def) return fail(ERROR.NODE_TYPE_UNKNOWN, { type: String(type || "") });
    const entries = Array.isArray(ports)
      ? ports.map((port) => ({ id: port && (port.id || port.port), type: port && port.type }))
      : Object.entries(isObj(ports) ? ports : {}).map(([id, portType]) => ({ id, type: portType }));
    const errors = [];
    for (const entry of entries) {
      const input = def.inputs.find((port) => port.id === entry.id);
      if (!input) { errors.push({ path: "ports." + String(entry.id), message: "节点 " + def.type + " 没有输入端口 " + String(entry.id), code: ERROR.NODE_PORT_UNKNOWN }); continue; }
      if (!compatibleType(String(entry.type || ""), input.type)) errors.push({ path: "ports." + input.id, message: "类型不兼容：" + String(entry.type || "") + " → " + input.type, code: ERROR.NODE_PORT_INCOMPATIBLE });
    }
    if (errors.length) return fail(ERROR.NODE_PORT_INCOMPATIBLE, { type: def.type, errors });
    return ok({ type: def.type, ports: entries });
  }

  validateConnection({ from, fromPort, to, toPort } = {}) {
    const fromDef = this.get(from);
    if (!fromDef) return fail(ERROR.NODE_TYPE_UNKNOWN, { type: String(from || ""), side: "from" });
    const toDef = this.get(to);
    if (!toDef) return fail(ERROR.NODE_TYPE_UNKNOWN, { type: String(to || ""), side: "to" });
    const output = fromDef.outputs.find((port) => port.id === String(fromPort || ""));
    if (!output) return fail(ERROR.NODE_PORT_UNKNOWN, { type: fromDef.type, port: String(fromPort || ""), side: "output" });
    const input = toDef.inputs.find((port) => port.id === String(toPort || ""));
    if (!input) return fail(ERROR.NODE_PORT_UNKNOWN, { type: toDef.type, port: String(toPort || ""), side: "input" });
    if (!compatibleType(output.type, input.type)) return fail(ERROR.NODE_PORT_INCOMPATIBLE, { from: fromDef.type, fromPort: output.id, fromType: output.type, to: toDef.type, toPort: input.id, toType: input.type });
    return ok({ from: { type: fromDef.type, port: output.id, outputType: output.type }, to: { type: toDef.type, port: input.id, inputType: input.type } });
  }

  async #writeBack({ context, canvasId, nodeId, type, executorId, params, outputs }) {
    if (!this.canvasService || typeof this.canvasService.getCanvas !== "function" || typeof this.canvasService.applyCommand !== "function") return { ok: false, error: "CANVAS_UNAVAILABLE" };
    const current = await Promise.resolve(this.canvasService.getCanvas({ context, canvasId }));
    if (!current || current.ok !== true) return { ok: false, error: (current && current.error) || "CANVAS_NOT_FOUND" };
    const doc = current.canvas && current.canvas.doc;
    const node = doc && Array.isArray(doc.nodes) ? doc.nodes.find((item) => item && String(item.id) === String(nodeId)) : null;
    if (!node) return { ok: false, error: "CANVAS_NODE_NOT_FOUND" };
    const previous = isObj(node.params) ? node.params : {};
    const applied = await Promise.resolve(this.canvasService.applyCommand({
      context, canvasId,
      command: { type: "node.edit", id: String(nodeId), patch: { params: { ...previous, ...params, lastRunResult: outputs }, runStatus: "DONE", runError: null } },
    }));
    if (!applied || applied.ok !== true) return { ok: false, error: (applied && applied.error) || "CANVAS_WRITE_BACK_FAILED" };
    return { ok: true, revision: applied.canvas ? applied.canvas.revision : applied.revision == null ? null : applied.revision, type, executorId };
  }

  async execute({ type = null, params, context = null, canvasId = null, nodeId = null, writeBack = false, node = null } = {}) {
    let targetNode = node && isObj(node) ? node : null;
    let resolvedType = type ? String(type) : null;
    if (!targetNode && this.canvasService && typeof this.canvasService.getCanvas === "function" && canvasId && nodeId) {
      const current = await Promise.resolve(this.canvasService.getCanvas({ context, canvasId }));
      const doc = current && current.ok === true && current.canvas ? current.canvas.doc : null;
      targetNode = doc && Array.isArray(doc.nodes) ? doc.nodes.find((item) => item && String(item.id) === String(nodeId)) || null : null;
    }
    if (!resolvedType && targetNode) resolvedType = String(targetNode.type || "");
    if (!resolvedType) return fail(ERROR.NODE_TYPE_UNKNOWN, { type: null });
    const def = this.get(resolvedType);
    if (!def) return fail(ERROR.NODE_TYPE_UNKNOWN, { type: resolvedType });
    const inputParams = params === undefined ? (targetNode && isObj(targetNode.params) ? targetNode.params : {}) : params;
    const validation = this.validateParams(resolvedType, inputParams);
    if (!validation.ok) return validation;
    const executor = this.executorOf(resolvedType);
    const base = { type: resolvedType, executorId: def.executor.id, capability: executor.capability || null };
    if (!executor.available) return fail(ERROR.NODE_EXECUTOR_UNAVAILABLE, { ...base, reason: executor.reason });
    let outputs = null;
    try {
      if (executor.kind === "local") {
        if (executor.handler === "text") outputs = { [def.outputs[0] ? def.outputs[0].id : "text"]: str(validation.params.prompt, 20000) };
        else if (executor.handler === "table") {
          const table = isObj(validation.params.protocolParams) && isObj(validation.params.protocolParams.table) ? validation.params.protocolParams.table : (isObj(validation.params.table) ? validation.params.table : { columns: [], rows: [] });
          outputs = { [def.outputs[0] ? def.outputs[0].id : "table"]: table, rows: Array.isArray(table.rows) ? table.rows : [] };
        } else if (executor.handler === "junction") {
          const incoming = Array.isArray(validation.params.inputs) ? validation.params.inputs : [];
          outputs = { [def.outputs[0] ? def.outputs[0].id : "out"]: incoming };
        } else outputs = {};
      } else if (executor.kind === "asset") {
        outputs = { [executor.output]: validation.params.ref || validation.params.url || null };
      } else {
        const portName = executor.kind === "generation"
          ? (resolvedType === "builtin.video-generator" && typeof this.ports.videoGeneration === "function" ? "videoGeneration" : "generation")
          : executor.kind === "media-process" ? "mediaProcess" : "plugin";
        const port = this.ports[portName];
        if (typeof port !== "function") return fail(ERROR.NODE_EXECUTOR_UNAVAILABLE, { ...base, reason: executor.reason });
        const portResult = await port({ type: resolvedType, executorId: def.executor.id, capability: executor.capability, params: validation.params, context, canvasId, nodeId, node: targetNode });
        if (!portResult || typeof portResult !== "object") return fail(ERROR.NODE_EXECUTION_FAILED, { ...base, reason: "executor-returned-invalid-result" });
        if (portResult.ok === false) return fail(portResult.error || ERROR.NODE_EXECUTION_FAILED, portResult.detail || { ...base });
        outputs = portResult.outputs === undefined ? (portResult.value === undefined ? portResult.result === undefined ? null : portResult.result : portResult.value) : portResult.outputs;
      }
    } catch (error) {
      return fail(ERROR.NODE_EXECUTION_FAILED, { ...base, message: String((error && error.message) || error).slice(0, 500) });
    }
    const result = ok({ ...base, status: executor.kind === "asset" ? "NOOP" : "DONE", outputs, result: outputs });
    if (writeBack && canvasId && nodeId) {
      result.writeBack = await this.#writeBack({ context, canvasId, nodeId, type: resolvedType, executorId: def.executor.id, params: validation.params, outputs });
    }
    return result;
  }
}

function createCanvasNodeRegistry(options = {}) {
  return new CanvasNodeRegistry(options);
}

module.exports = {
  FORMAT, ERROR, PORT_TYPES, PARAM_SCHEMAS, EXECUTOR_PROFILES, BUILTIN_EXECUTOR_IDS,
  validateDefinition, compatibleType, CanvasNodeRegistry, createCanvasNodeRegistry,
};
