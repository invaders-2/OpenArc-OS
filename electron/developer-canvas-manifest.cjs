/**
 * B7x · 画布插件清单校验（**纯逻辑，无 I/O**）。
 *
 * 为什么单独一层：dx-app.json 的 canvas 字段描述"这个开发者 App 向画布注册哪些节点 / 模板"，
 * 它的结构、节点命名空间、端口类型、执行器、Agent 动作与危险路径必须先在一处冻结，
 * 再交给 electron/developer-domain.cjs 做文件围栏（路径 / 大小 / JSON）与清单合流。
 *
 * 逐函数移植自只读源（行号为源文件行号，括号内为源函数）：
 *   · shared/canvasPlugin.ts:1-5                 清单 format / capabilityVersion 常量
 *   · shared/canvasPluginValidation.ts:20-58     端口类型白名单 / object / identifier / positiveInteger / ports
 *   · shared/canvasPluginValidation.ts:60-75     executor（执行器类型白名单）
 *   · shared/canvasPluginValidation.ts:77-100    parameterSchema（enum / canvasOutputPort 引用校验）
 *   · shared/canvasPluginValidation.ts:102-143   hostCapabilities（generation / output / storage）
 *   · shared/canvasPluginValidation.ts:145-181   agentDeclaration（agent.actions / aliases）
 *   · shared/canvasPluginValidation.ts:183-236   nodeOperations（reads / writes 危险路径 fail closed）
 *   · shared/canvasPluginValidation.ts:238-267   stateMigrations（__proto__ / prototype / constructor 拒绝）
 *   · shared/canvasPluginValidation.ts:269-327   validateCanvasNodeManifest
 *   · shared/canvasPluginValidation.ts:329-382   validateCanvasTemplateManifest
 *   · shared/canvasPortCompatibility.ts:1-35     canvasPortCompatibility
 *   · server/developerApps.ts:379-410            normalizeCanvasDeclaration（本文件只做结构部分）
 *
 * 内置节点定义单独移植到 electron/developer-canvas-builtins.cjs（源
 *   src/apps/canvas/builtinCanvasNodes.ts:6-139 + nodes/director3d/definition.ts:6-18）。
 *   validateCanvasTemplateManifest 按源 developerApps.ts:404 的 allDefinitions
 *   = [...BUILTIN_CANVAS_NODES, ...插件节点] 做存在性与端口兼容判定：
 *   builtin.* 引用不再"无法验证而跳过"，未声明的 builtin 节点 / 端口 / 不兼容连线
 *   都与插件节点同一口径结构化拒绝。
 *
 * 未移植项（逐条登记，不猜测）：registerBuiltinCanvasNodes（源 :141-144）与
 *   builtinNodeTypeForCard（源 :146-166）依赖 CanvasNodeRegistry / CanvasCard，
 *   属于编辑器运行期，不在清单校验路径上。
 *
 * 错误规约：本文件只抛普通 Error，并在 err.canvasCode 上带稳定的子码；
 *   electron/developer-domain.cjs 据此映射成 DEVELOPER_* 错误码与 detail.reason。
 */
"use strict";

const CANVAS_NODE_MANIFEST_FORMAT = "dx-canvas-nodes/v1";           // 源 canvasPlugin.ts:1
const CANVAS_NODE_MANIFEST_V2_FORMAT = "dx-canvas-nodes/v2";        // 源 canvasPlugin.ts:2
const CANVAS_NODE_CAPABILITY_VERSION = 2;                           // 源 canvasPlugin.ts:3
const CANVAS_TEMPLATE_MANIFEST_FORMAT = "dx-canvas-templates/v1";   // 源 canvasPlugin.ts:4

// 内置节点定义（源 developerApps.ts:20 的 import 位置）。
const { BUILTIN_CANVAS_NODES } = require("./developer-canvas-builtins.cjs");

/** 端口类型白名单（源 canvasPluginValidation.ts:20-23）。 */
const PORT_TYPES = new Set([
  "text", "text[]", "json", "table", "file", "file[]", "media.image", "media.image[]",
  "media.video", "media.video[]", "media.audio", "media.audio[]", "artifact", "event",
]);
/** 源 canvasPluginValidation.ts:24 的提示串（缺一字都会让插件作者写错类型）。 */
const PORT_TYPE_HINT = "合法类型：text、text[]、json、table、file、file[]、media.image、media.image[]、media.video、media.video[]、media.audio、media.audio[]、artifact、event；图片/视频/音频不要写 image、video、audio 或 media";

/** 稳定子码：抛出点只带 canvasCode，映射错误码的职责留在 developer-domain。 */
function fail(code, message) {
  const error = new Error(message);
  error.canvasCode = code;
  throw error;
}

// ---------------------------------------------------------------------------
// 基础校验（源 canvasPluginValidation.ts:26-58）
// ---------------------------------------------------------------------------

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CANVAS_STRUCTURE", label + " 必须是对象");
  return value;
}

function identifier(value, label) {
  const result = String(value || "").trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(result)) fail("CANVAS_STRUCTURE", label + " 不合法");
  return result;
}

function positiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) fail("CANVAS_STRUCTURE", label + " 必须是正整数");
  return result;
}

/** 源 :43-58。端口 id / 类型 / 标题全部走白名单，重复 id 一律拒绝。 */
function ports(value, label) {
  if (!Array.isArray(value)) fail("CANVAS_STRUCTURE", label + " 必须是数组");
  if (value.length > 64) fail("CANVAS_STRUCTURE", label + " 最多允许 64 个端口");
  const ids = new Set();
  return value.map((raw, index) => {
    const port = object(raw, label + "[" + index + "]");
    const id = identifier(port.id, label + "[" + index + "].id");
    if (ids.has(id)) fail("CANVAS_STRUCTURE", label + " 存在重复端口：" + id);
    ids.add(id);
    const type = String(port.type || "");
    if (!PORT_TYPES.has(type)) fail("CANVAS_UNKNOWN_PORT_TYPE", label + "." + id + " 使用了未知端口类型：" + (type || "(空)") + "。" + PORT_TYPE_HINT);
    const title = String(port.title || "").trim();
    if (!title || title.length > 80) fail("CANVAS_STRUCTURE", label + "." + id + ".title 长度必须为 1–80");
    return Object.assign({ id, title, type }, port.required === true ? { required: true } : {}, port.multiple === true ? { multiple: true } : {});
  });
}

// ---------------------------------------------------------------------------
// 执行器 / 参数 / 宿主能力 / Agent / 操作 / 迁移
// ---------------------------------------------------------------------------

/** 源 :60-75：执行器类型即入口白名单；未列出的类型一律拒绝。 */
function executor(value, label) {
  const raw = object(value, label);
  const type = String(raw.type || "");
  const required = (key) => {
    const result = String(raw[key] || "").trim();
    if (!result || result.length > 160) fail("CANVAS_STRUCTURE", label + "." + key + " 不能为空且不能超过 160 字符");
    return result;
  };
  if (type === "builtin") return { type, id: required("id") };
  if (type === "skill") return { type, skillId: required("skillId") };
  if (type === "mcp-tool") return { type, serverId: required("serverId"), toolName: required("toolName") };
  if (type === "agent-tool") return { type, toolName: required("toolName") };
  if (type === "workflow") return { type, workflowId: required("workflowId") };
  if (type === "app-bridge") return { type, action: required("action") };
  return fail("CANVAS_UNSUPPORTED_EXECUTOR", label + ".type 不受支持：" + (type || "(空)"));
}

/** 源 :77-100：参数 schema 只驱动 UI；canvasOutputPort 必须引用已声明 outputs。 */
function parameterSchema(value, label, outputs) {
  if (value === undefined) return undefined;
  const schema = object(value, label);
  if (schema.type !== undefined && schema.type !== "object") fail("CANVAS_STRUCTURE", label + ".type 只支持 object");
  const rawProperties = schema.properties === undefined ? schema : object(schema.properties, label + ".properties");
  const properties = Object.entries(rawProperties).filter(([key]) => key !== "type").map(([key, raw]) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) fail("CANVAS_STRUCTURE", label + ".properties." + key + " 字段名不合法");
    const field = object(raw, label + ".properties." + key);
    const type = String(field.type || "string");
    if (!["string", "number", "integer", "boolean"].includes(type)) fail("CANVAS_STRUCTURE", label + ".properties." + key + ".type 暂不支持：" + type);
    const values = field.enum;
    if (values !== undefined && (!Array.isArray(values) || !values.length || values.length > 100)) fail("CANVAS_STRUCTURE", label + ".properties." + key + ".enum 必须是 1–100 项数组");
    if (field.enumNames !== undefined && (!Array.isArray(field.enumNames) || !Array.isArray(values) || field.enumNames.length !== values.length)) fail("CANVAS_STRUCTURE", label + ".properties." + key + ".enumNames 必须与 enum 等长");
    if (Array.isArray(values) && field.default !== undefined && !values.some((candidate) => Object.is(candidate, field.default))) fail("CANVAS_STRUCTURE", label + ".properties." + key + ".default 必须属于 enum");
    if ((type === "number" || type === "integer") && field.minimum !== undefined && field.maximum !== undefined && Number(field.minimum) > Number(field.maximum)) fail("CANVAS_STRUCTURE", label + ".properties." + key + " 的 minimum 不能大于 maximum");
    return { key, field };
  });
  const byKey = new Map(properties.map((item) => [item.key, item.field]));
  const outputTarget = byKey.get("canvasOutputTarget");
  if (Array.isArray(outputTarget && outputTarget.enum) && outputTarget.enum.some((item) => !["inline", "text-node", "table-node"].includes(String(item)))) fail("CANVAS_STRUCTURE", label + ".canvasOutputTarget 包含未知输出目标");
  const outputPort = byKey.get("canvasOutputPort");
  if (Array.isArray(outputPort && outputPort.enum) && outputPort.enum.some((item) => !outputs.some((port) => port.id === String(item)))) fail("CANVAS_STRUCTURE", label + ".canvasOutputPort 必须引用 outputs 中已声明的端口");
  return schema;
}

/** 源 :102-143：宿主能力声明；生成类节点必须落到对应 canvas.ai agent-tool。 */
function hostCapabilities(value, nodeExecutor, outputs, label) {
  if (value === undefined) return undefined;
  const host = object(value, label);
  const result = {};
  if (host.generation !== undefined) {
    const generation = object(host.generation, label + ".generation");
    const kind = String(generation.kind || "");
    if (!["text", "image", "video", "audio"].includes(kind)) fail("CANVAS_STRUCTURE", label + ".generation.kind 不受支持");
    if (generation.parameterPanel !== "standard") fail("CANVAS_STRUCTURE", label + ".generation.parameterPanel 必须是 standard");
    const outputPort = String(generation.outputPort || "");
    const output = outputs.find((port) => port.id === outputPort);
    if (!output) fail("CANVAS_STRUCTURE", label + ".generation.outputPort 必须引用 outputs 端口");
    const expected = kind === "text" ? "text" : "media." + kind;
    if (!output.type.startsWith(expected)) fail("CANVAS_STRUCTURE", label + ".generation.outputPort 类型必须匹配 " + kind);
    if (nodeExecutor.type !== "agent-tool" || nodeExecutor.toolName !== (kind === "text" ? "canvas.ai.generate-text" : "canvas.ai.generate")) fail("CANVAS_STRUCTURE", label + ".generation 必须使用对应的 canvas.ai agent-tool 执行器");
    const allowedFields = new Set(["platform", "model", "ratio", "resolution", "quality", "count", "duration", "seed"]);
    const fields = generation.fields === undefined ? undefined : [...new Set((Array.isArray(generation.fields) ? generation.fields : []).map(String))];
    if (generation.fields !== undefined && (!Array.isArray(generation.fields) || fields.some((field) => !allowedFields.has(field)))) fail("CANVAS_STRUCTURE", label + ".generation.fields 包含未知标准字段");
    result.generation = Object.assign({ kind, parameterPanel: "standard", outputPort }, fields ? { fields } : {});
  }
  if (host.output !== undefined) {
    const output = object(host.output, label + ".output");
    const allowed = new Set(["inline", "text-node", "table-node"]);
    if (!Array.isArray(output.targets) || !output.targets.length) fail("CANVAS_STRUCTURE", label + ".output.targets 至少需要一项");
    const targets = [...new Set(output.targets.map(String))];
    if (targets.some((target) => !allowed.has(target))) fail("CANVAS_STRUCTURE", label + ".output.targets 包含未知目标");
    const defaultTarget = String(output.defaultTarget || "");
    if (!targets.includes(defaultTarget)) fail("CANVAS_STRUCTURE", label + ".output.defaultTarget 必须属于 targets");
    const defaultPort = String(output.defaultPort || "");
    if (!outputs.some((port) => port.id === defaultPort)) fail("CANVAS_STRUCTURE", label + ".output.defaultPort 必须引用 outputs 端口");
    result.output = { targets, defaultTarget, defaultPort };
  }
  if (host.storage !== undefined) {
    const storage = object(host.storage, label + ".storage");
    if (storage.enabled !== true) fail("CANVAS_STRUCTURE", label + ".storage.enabled 必须是 true");
    const maxBytes = storage.maxBytes === undefined ? undefined : Number(storage.maxBytes);
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 5 * 1024 * 1024)) fail("CANVAS_STRUCTURE", label + ".storage.maxBytes 必须在 1KB–5MB");
    result.storage = Object.assign({ enabled: true }, maxBytes ? { maxBytes } : {});
  }
  if (host.cancellable !== undefined) result.cancellable = host.cancellable === true;
  return result;
}

/** 源 :145-181：Agent 可见动作；configure 动作的可写参数只能是白名单。 */
function agentDeclaration(value, label) {
  if (value === undefined) return undefined;
  const agent = object(value, label);
  if (!Array.isArray(agent.actions) || !agent.actions.length || agent.actions.length > 16) fail("CANVAS_STRUCTURE", label + ".actions 必须包含 1–16 个动作");
  const ids = new Set();
  const actions = agent.actions.map((raw, index) => {
    const action = object(raw, label + ".actions[" + index + "]");
    const id = identifier(action.id, label + ".actions[" + index + "].id");
    if (ids.has(id)) fail("CANVAS_STRUCTURE", label + ".actions 存在重复动作：" + id);
    ids.add(id);
    const title = String(action.title || "").trim();
    if (!title || title.length > 80) fail("CANVAS_STRUCTURE", label + ".actions." + id + ".title 长度必须为 1–80");
    const kind = String(action.kind || "");
    if (!["run", "read", "configure"].includes(kind)) fail("CANVAS_STRUCTURE", label + ".actions." + id + ".kind 不受支持");
    const promptParameter = action.promptParameter === undefined ? undefined : String(action.promptParameter);
    if (promptParameter !== undefined && promptParameter !== "params.prompt") fail("CANVAS_STRUCTURE", label + ".actions." + id + ".promptParameter 只支持 params.prompt");
    const configurableParameters = action.configurableParameters === undefined
      ? undefined
      : [...new Set((Array.isArray(action.configurableParameters) ? action.configurableParameters : []).map((item) => String(item || "").trim()).filter(Boolean))];
    if (action.configurableParameters !== undefined && (!Array.isArray(action.configurableParameters) || !configurableParameters.length || configurableParameters.length > 64 || configurableParameters.some((key) => !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)))) {
      fail("CANVAS_STRUCTURE", label + ".actions." + id + ".configurableParameters 必须是 1–64 个合法参数名");
    }
    if (configurableParameters && kind !== "configure") fail("CANVAS_STRUCTURE", label + ".actions." + id + ".configurableParameters 只能用于 configure 动作");
    return Object.assign(
      { id, title, kind },
      action.description ? { description: String(action.description).slice(0, 300) } : {},
      promptParameter ? { promptParameter: "params.prompt" } : {},
      action.acceptsCanvasInputs === true ? { acceptsCanvasInputs: true } : {},
      configurableParameters ? { configurableParameters } : {},
    );
  });
  const aliases = agent.aliases === undefined ? undefined : [...new Set((Array.isArray(agent.aliases) ? agent.aliases : []).map((alias) => String(alias || "").trim()).filter(Boolean))];
  if (agent.aliases !== undefined && (!Array.isArray(agent.aliases) || !aliases.length || aliases.length > 32 || aliases.some((alias) => alias.length > 80))) fail("CANVAS_STRUCTURE", label + ".aliases 必须是 1–32 个不超过 80 字符的名称");
  return Object.assign({}, agent.discoverable === false ? { discoverable: false } : {}, aliases ? { aliases } : {}, { actions });
}

/** 源 :183-236：v2 节点操作；reads / writes 的路径段拒绝原型污染（危险项 fail closed）。 */
function nodeOperations(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 64) fail("CANVAS_STRUCTURE", label + " 必须包含 1–64 个操作");
  const ids = new Set();
  const allowedKinds = new Set(["query", "mutation", "execution", "control"]);
  const allowedSideEffects = new Set(["none", "local", "external", "paid"]);
  const allowedRisks = new Set(["low", "medium", "high"]);
  const allowedIdempotency = new Set(["idempotent", "keyed", "non-idempotent"]);
  const allowedConfirmations = new Set(["never", "on-ambiguity", "on-risk", "always"]);
  const paths = (raw, pathLabel) => {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || raw.length > 64) fail("CANVAS_STRUCTURE", pathLabel + " 必须是最多 64 项的路径数组");
    const result = [...new Set(raw.map((item) => String(item || "").trim()))];
    if (result.some((path) => !/^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_-]*)*$/.test(path) || path.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part)))) fail("CANVAS_UNSAFE_PATH", pathLabel + " 包含不合法路径");
    return result;
  };
  return value.map((raw, index) => {
    const operation = object(raw, label + "[" + index + "]");
    const id = String(operation.id || "").trim();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) fail("CANVAS_STRUCTURE", label + "[" + index + "].id 不合法");
    if (ids.has(id)) fail("CANVAS_STRUCTURE", label + " 存在重复操作：" + id);
    ids.add(id);
    const title = String(operation.title || "").trim();
    if (!title || title.length > 80) fail("CANVAS_STRUCTURE", label + "." + id + ".title 长度必须为 1–80");
    const kind = String(operation.kind || "");
    const sideEffect = String(operation.sideEffect || "");
    const risk = String(operation.risk || "");
    const idempotency = String(operation.idempotency || "");
    const confirmation = String(operation.confirmation || "");
    const executorBinding = String(operation.executorBinding || "").trim();
    if (!allowedKinds.has(kind)) fail("CANVAS_STRUCTURE", label + "." + id + ".kind 不受支持");
    if (!allowedSideEffects.has(sideEffect)) fail("CANVAS_STRUCTURE", label + "." + id + ".sideEffect 不受支持");
    if (!allowedRisks.has(risk)) fail("CANVAS_STRUCTURE", label + "." + id + ".risk 不受支持");
    if (!allowedIdempotency.has(idempotency)) fail("CANVAS_STRUCTURE", label + "." + id + ".idempotency 不受支持");
    if (!allowedConfirmations.has(confirmation)) fail("CANVAS_STRUCTURE", label + "." + id + ".confirmation 不受支持");
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,159}$/.test(executorBinding)) fail("CANVAS_STRUCTURE", label + "." + id + ".executorBinding 不合法");
    const inputSchema = operation.inputSchema === undefined ? undefined : object(operation.inputSchema, label + "." + id + ".inputSchema");
    const outputSchema = operation.outputSchema === undefined ? undefined : object(operation.outputSchema, label + "." + id + ".outputSchema");
    const reads = paths(operation.reads, label + "." + id + ".reads");
    const writes = paths(operation.writes, label + "." + id + ".writes");
    return Object.assign(
      { id, title },
      operation.description ? { description: String(operation.description).slice(0, 300) } : {},
      { kind },
      inputSchema ? { inputSchema } : {},
      outputSchema ? { outputSchema } : {},
      reads ? { reads } : {},
      writes ? { writes } : {},
      { sideEffect, risk, idempotency, confirmation, executorBinding },
    );
  });
}

/** 源 :238-267：节点状态迁移；路径同样拒绝原型污染与未知迁移操作。 */
function stateMigrations(value, stateVersion, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) fail("CANVAS_STRUCTURE", label + " 必须是最多 32 项的数组");
  const safePath = (raw, pathLabel) => {
    const path = String(raw || "").trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_-]*)*$/.test(path) || path.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part))) fail("CANVAS_UNSAFE_PATH", pathLabel + " 不合法");
    return path;
  };
  const migrations = value.map((raw, index) => {
    const migration = object(raw, label + "[" + index + "]");
    const from = positiveInteger(migration.from, label + "[" + index + "].from");
    const to = positiveInteger(migration.to, label + "[" + index + "].to");
    if (to !== from + 1 || to > stateVersion) fail("CANVAS_STRUCTURE", label + "[" + index + "] 必须逐版本迁移且不能超过 stateVersion");
    if (!Array.isArray(migration.operations) || migration.operations.length > 64) fail("CANVAS_STRUCTURE", label + "[" + index + "].operations 必须是最多 64 项的数组");
    const operations = migration.operations.map((operationRaw, operationIndex) => {
      const operation = object(operationRaw, label + "[" + index + "].operations[" + operationIndex + "]");
      if (operation.type === "set-default") return { type: "set-default", path: safePath(operation.path, "set-default.path"), value: operation.value };
      if (operation.type === "rename") return { type: "rename", from: safePath(operation.from, "rename.from"), to: safePath(operation.to, "rename.to") };
      if (operation.type === "delete") return { type: "delete", path: safePath(operation.path, "delete.path") };
      return fail("CANVAS_STRUCTURE", label + "[" + index + "] 存在未知迁移操作");
    });
    return { from, to, operations };
  }).sort((left, right) => left.from - right.from);
  const seen = new Set();
  for (const migration of migrations) {
    if (seen.has(migration.from)) fail("CANVAS_STRUCTURE", label + " 存在重复 from：" + migration.from);
    seen.add(migration.from);
  }
  return migrations;
}

// ---------------------------------------------------------------------------
// 节点清单 / 模板清单（源 canvasPluginValidation.ts:269-382）
// ---------------------------------------------------------------------------

/** 源 :269-327 validateCanvasNodeManifest。 */
function validateCanvasNodeManifest(value, pluginId) {
  const manifest = object(value, "canvas.nodes.json");
  if (manifest.format !== CANVAS_NODE_MANIFEST_FORMAT && manifest.format !== CANVAS_NODE_MANIFEST_V2_FORMAT) fail("CANVAS_STRUCTURE", "节点清单 format 必须是 " + CANVAS_NODE_MANIFEST_FORMAT + " 或 " + CANVAS_NODE_MANIFEST_V2_FORMAT);
  if (!Array.isArray(manifest.nodes) || !manifest.nodes.length) fail("CANVAS_STRUCTURE", "节点清单至少需要一个节点");
  if (manifest.nodes.length > 128) fail("CANVAS_STRUCTURE", "单个节点清单最多允许 128 个节点");
  const types = new Set();
  const nodes = manifest.nodes.map((raw, index) => {
    const node = object(raw, "nodes[" + index + "]");
    const type = String(node.type || "").trim();
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(type)) fail("CANVAS_UNKNOWN_NODE_TYPE", "nodes[" + index + "].type 不合法");
    if (pluginId && !type.startsWith(pluginId + ".")) fail("CANVAS_UNKNOWN_NODE_TYPE", "插件节点必须使用 " + pluginId + ".* 命名空间：" + type);
    if (types.has(type)) fail("CANVAS_STRUCTURE", "节点类型重复：" + type);
    types.add(type);
    const title = String(node.title || "").trim();
    if (!title || title.length > 120) fail("CANVAS_STRUCTURE", type + ".title 长度必须为 1–120");
    const size = object(node.defaultSize, type + ".defaultSize");
    const width = Number(size.width);
    const height = Number(size.height);
    if (!Number.isFinite(width) || width < 48 || width > 4000 || !Number.isFinite(height) || height < 32 || height > 4000) fail("CANVAS_STRUCTURE", type + ".defaultSize 超出允许范围");
    const version = positiveInteger(node.version, type + ".version");
    const nodeStateVersion = positiveInteger(node.stateVersion, type + ".stateVersion");
    const migrations = stateMigrations(node.stateMigrations, nodeStateVersion, type + ".stateMigrations");
    const inputs = ports(node.inputs, type + ".inputs");
    const outputs = ports(node.outputs, type + ".outputs");
    const nodeExecutor = executor(node.executor, type + ".executor");
    const parameters = parameterSchema(node.parameters, type + ".parameters", outputs);
    const host = hostCapabilities(node.host, nodeExecutor, outputs, type + ".host");
    const agent = agentDeclaration(node.agent, type + ".agent");
    const capabilityVersion = node.capabilityVersion === undefined ? undefined : Number(node.capabilityVersion);
    if (capabilityVersion !== undefined && capabilityVersion !== CANVAS_NODE_CAPABILITY_VERSION) fail("CANVAS_STRUCTURE", type + ".capabilityVersion 只支持 " + CANVAS_NODE_CAPABILITY_VERSION);
    const allowedRoles = new Set(["asset", "source", "transform", "generator", "agent", "data", "sink", "control", "layout"]);
    const semanticRoles = node.semanticRoles === undefined ? undefined : [...new Set((Array.isArray(node.semanticRoles) ? node.semanticRoles : []).map(String))];
    if (node.semanticRoles !== undefined && (!semanticRoles.length || semanticRoles.some((role) => !allowedRoles.has(role)))) fail("CANVAS_STRUCTURE", type + ".semanticRoles 包含未知角色");
    const operations = nodeOperations(node.operations, type + ".operations");
    // 越权 fail closed：v2 能力字段（semanticRoles / operations）必须显式声明 capabilityVersion。
    if ((semanticRoles || operations) && capabilityVersion !== CANVAS_NODE_CAPABILITY_VERSION) fail("CANVAS_V2_CAPABILITY_REQUIRED", type + " 使用 v2 能力字段时必须声明 capabilityVersion: " + CANVAS_NODE_CAPABILITY_VERSION);
    return Object.assign(
      { type, version, stateVersion: nodeStateVersion },
      capabilityVersion ? { capabilityVersion: CANVAS_NODE_CAPABILITY_VERSION } : {},
      { title },
      node.description ? { description: String(node.description).slice(0, 500) } : {},
      node.category ? { category: String(node.category).slice(0, 80) } : {},
      node.icon ? { icon: String(node.icon).slice(0, 240) } : {},
      { defaultSize: { width, height }, inputs, outputs },
      parameters ? { parameters } : {},
      host ? { host } : {},
      agent ? { agent } : {},
      semanticRoles ? { semanticRoles } : {},
      operations ? { operations } : {},
      migrations ? { stateMigrations: migrations } : {},
      { executor: nodeExecutor },
    );
  });
  if (manifest.format === CANVAS_NODE_MANIFEST_V2_FORMAT && nodes.some((node) => node.capabilityVersion !== CANVAS_NODE_CAPABILITY_VERSION)) fail("CANVAS_STRUCTURE", "V2 节点清单中的每个节点都必须声明 capabilityVersion: " + CANVAS_NODE_CAPABILITY_VERSION);
  return { format: manifest.format, nodes };
}

/**
 * 源 :329-382 validateCanvasTemplateManifest。
 * definitions 的语义与源 developerApps.ts:404 一致：调用方只传**插件节点**定义，
 * 本函数前置内置节点定义组成 allDefinitions，两者走同一套存在性 / 端口兼容判定。
 * 与源一样，definitions === undefined 时不做声明式校验；真实调用方 developer-domain.cjs
 * 始终传入数组，内置节点因此始终参与校验。
 */
function validateCanvasTemplateManifest(value, pluginId, definitions) {
  const manifest = object(value, "canvas.templates.json");
  if (manifest.format !== CANVAS_TEMPLATE_MANIFEST_FORMAT) fail("CANVAS_STRUCTURE", "模板清单 format 必须是 " + CANVAS_TEMPLATE_MANIFEST_FORMAT);
  if (!Array.isArray(manifest.templates) || !manifest.templates.length || manifest.templates.length > 64) fail("CANVAS_STRUCTURE", "模板清单需要包含 1–64 个模板");
  const templateIds = new Set();
  const allDefinitions = definitions === undefined ? undefined : [...BUILTIN_CANVAS_NODES, ...definitions];
  return {
    format: CANVAS_TEMPLATE_MANIFEST_FORMAT,
    templates: manifest.templates.map((raw, index) => {
      const template = object(raw, "templates[" + index + "]");
      const id = identifier(template.id, "templates[" + index + "].id");
      if (templateIds.has(id)) fail("CANVAS_STRUCTURE", "模板 ID 重复：" + id);
      templateIds.add(id);
      const title = String(template.title || "").trim();
      if (!title || title.length > 120) fail("CANVAS_STRUCTURE", id + ".title 长度必须为 1–120");
      if (!Array.isArray(template.nodes) || !template.nodes.length || template.nodes.length > 256) fail("CANVAS_STRUCTURE", id + ".nodes 需要包含 1–256 个节点");
      const nodeIds = new Set();
      const nodes = template.nodes.map((nodeRaw, nodeIndex) => {
        const node = object(nodeRaw, id + ".nodes[" + nodeIndex + "]");
        const nodeId = identifier(node.id, id + ".nodes[" + nodeIndex + "].id");
        if (nodeIds.has(nodeId)) fail("CANVAS_STRUCTURE", id + " 节点 ID 重复：" + nodeId);
        nodeIds.add(nodeId);
        const nodeType = String(node.nodeType || "").trim();
        if (!nodeType.startsWith("builtin.") && !nodeType.startsWith(pluginId + ".")) fail("CANVAS_UNKNOWN_NODE_TYPE", id + " 只能引用 builtin.* 或 " + pluginId + ".* 节点：" + nodeType);
        return Object.assign(
          { id: nodeId, nodeType, x: Number(node.x) || 0, y: Number(node.y) || 0 },
          node.parameters && typeof node.parameters === "object" && !Array.isArray(node.parameters) ? { parameters: node.parameters } : {},
          node.pluginState && typeof node.pluginState === "object" && !Array.isArray(node.pluginState) ? { pluginState: node.pluginState } : {},
        );
      });
      if (allDefinitions) for (const node of nodes) if (!allDefinitions.some((definition) => definition.type === node.nodeType)) fail("CANVAS_UNKNOWN_NODE_TYPE", id + " 引用了未声明节点类型：" + node.nodeType);
      const connections = Array.isArray(template.connections) ? template.connections.slice(0, 512).map((connectionRaw, connectionIndex) => {
        const connection = object(connectionRaw, id + ".connections[" + connectionIndex + "]");
        const from = String(connection.from || "");
        const to = String(connection.to || "");
        if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) fail("CANVAS_STRUCTURE", id + " 存在无效模板连线：" + from + " → " + to);
        const fromPort = connection.fromPort ? String(connection.fromPort) : "";
        const toPort = connection.toPort ? String(connection.toPort) : "";
        if (allDefinitions) {
          const sourceInstance = nodes.find((node) => node.id === from);
          const targetInstance = nodes.find((node) => node.id === to);
          const sourceDefinition = allDefinitions.find((node) => node.type === sourceInstance.nodeType);
          const targetDefinition = allDefinitions.find((node) => node.type === targetInstance.nodeType);
          // builtin.* 与插件节点同一口径：解析不到定义即拒绝，不再"无法验证而跳过"。
          if (!sourceDefinition) fail("CANVAS_UNKNOWN_NODE_TYPE", id + " 引用了未声明节点类型：" + sourceInstance.nodeType);
          if (!targetDefinition) fail("CANVAS_UNKNOWN_NODE_TYPE", id + " 引用了未声明节点类型：" + targetInstance.nodeType);
          const sources = fromPort ? sourceDefinition.outputs.filter((port) => port.id === fromPort) : sourceDefinition.outputs;
          const targets = toPort ? targetDefinition.inputs.filter((port) => port.id === toPort) : targetDefinition.inputs;
          if (fromPort && !sources.length) fail("CANVAS_STRUCTURE", id + " 的输出端口不存在：" + sourceInstance.nodeType + "." + fromPort);
          if (toPort && !targets.length) fail("CANVAS_STRUCTURE", id + " 的输入端口不存在：" + targetInstance.nodeType + "." + toPort);
          const compatible = sources.flatMap((source) => targets.map((target) => ({ source, target, result: canvasPortCompatibility(source, target) }))).filter((item) => item.result.ok);
          if (!compatible.length) fail("CANVAS_PORT_INCOMPATIBLE", id + " 的模板连线端口不兼容：" + sourceInstance.nodeType + " → " + targetInstance.nodeType);
          if ((!fromPort || !toPort) && compatible.length !== 1) fail("CANVAS_STRUCTURE", id + " 的模板连线存在多个兼容端口，必须明确声明 fromPort 和 toPort");
        }
        return Object.assign({ from, to }, fromPort ? { fromPort } : {}, toPort ? { toPort } : {});
      }) : [];
      return Object.assign({ id, title }, template.description ? { description: String(template.description).slice(0, 500) } : {}, template.category ? { category: String(template.category).slice(0, 80) } : {}, { nodes, connections });
    }),
  };
}

// ---------------------------------------------------------------------------
// 端口兼容（源 shared/canvasPortCompatibility.ts:1-35）
// ---------------------------------------------------------------------------

function arrayBase(type) {
  return type.endsWith("[]") ? type.slice(0, -2) : type;
}
function isArrayType(type) {
  return type.endsWith("[]");
}

/** 纯兼容判定：编辑器 / 安装期 / 执行期共用同一口径。 */
function canvasPortCompatibility(source, target) {
  if (source.type === target.type) return { ok: true, coercion: "none" };
  if (target.type === "artifact") return { ok: source.type !== "event", coercion: source.type === "event" ? null : "artifact", reason: source.type === "event" ? "事件端口不能作为数据制品连接" : undefined };
  if (target.type === "file" && (source.type.startsWith("media.") || source.type === "file")) return { ok: !isArrayType(source.type), coercion: "file" };
  if (target.type === "file[]" && (source.type.startsWith("media.") || source.type === "file" || source.type === "file[]")) return { ok: true, coercion: isArrayType(source.type) ? "file" : "wrap" };
  if (target.type === "json" && source.type === "table") return { ok: true, coercion: "none" };
  const sourceBase = arrayBase(source.type);
  const targetBase = arrayBase(target.type);
  if (sourceBase === targetBase) {
    if (!isArrayType(source.type) && isArrayType(target.type)) return { ok: true, coercion: "wrap" };
    if (isArrayType(source.type) && !isArrayType(target.type)) {
      return target.multiple ? { ok: true, coercion: "flatten" } : { ok: false, coercion: null, reason: "多值输出不能连接到单值输入" };
    }
  }
  return { ok: false, coercion: null, reason: source.type + " 不能连接到 " + target.type };
}

function canConnectCanvasPorts(source, target) {
  return canvasPortCompatibility(source, target).ok;
}

// ---------------------------------------------------------------------------
// 清单声明结构（源 server/developerApps.ts:379-399 的纯结构部分）
// ---------------------------------------------------------------------------

/**
 * 源 developerApps.ts:381-398 的结构规则（不含文件 I/O）：
 *   · nodeManifests / templateManifests 若出现必须是字符串数组（最多 32 项、去重、去空白）；
 *   · 两者不能同时为空 —— "canvas 至少需要声明一个节点或模板清单"。
 */
function normalizeCanvasDeclarationShape(value, normalizePath) {
  const declaration = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalize = typeof normalizePath === "function" ? normalizePath : (item) => item;
  const cleanStringList = (raw, max) => (Array.isArray(raw) ? raw.map((item) => String(item == null ? "" : item).trim()).filter(Boolean).slice(0, max) : []);
  // 源 developerApps.ts:384 的顺序：先截断 32 项，再逐项 safePath，最后去重。
  const manifestPaths = (raw, label) => {
    if (raw !== undefined && !Array.isArray(raw)) fail("CANVAS_DECLARATION", "canvas." + label + " 必须是字符串数组");
    return [...new Set(cleanStringList(raw, 32).map((item) => normalize(item)))];
  };
  const nodeManifests = manifestPaths(declaration.nodeManifests, "nodeManifests");
  const templateManifests = manifestPaths(declaration.templateManifests, "templateManifests");
  if (!nodeManifests.length && !templateManifests.length) fail("CANVAS_DECLARATION", "canvas 至少需要声明一个节点或模板清单");
  return { nodeManifests, templateManifests };
}

module.exports = {
  CANVAS_NODE_MANIFEST_FORMAT,
  CANVAS_NODE_MANIFEST_V2_FORMAT,
  CANVAS_NODE_CAPABILITY_VERSION,
  CANVAS_TEMPLATE_MANIFEST_FORMAT,
  PORT_TYPES,
  PORT_TYPE_HINT,
  canvasPortCompatibility,
  canConnectCanvasPorts,
  validateCanvasNodeManifest,
  validateCanvasTemplateManifest,
  normalizeCanvasDeclarationShape,
};
