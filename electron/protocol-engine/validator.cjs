"use strict";
/**
 * dx-protocol/v2 校验器（纯函数，无 I/O）。
 * 源：DXSRC/protocol-engine/validator.ts:1-298 逐条移植。
 * 保留全部拒绝规则：非法模板变量/危险字段/禁止 header/multipart boundary 归属/
 * retry 与 fallback 的重复提交保护等；这些是安全边界，不做简化。
 */
const { PROTOCOL_V2_SCHEMA } = require("./types.cjs");

const ID = /^[a-z0-9][a-z0-9:_-]{1,63}$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const REQUEST_MODES = new Set(["json", "query", "path", "multipart", "binary"]);
const RESPONSE_MODES = new Set(["json", "text", "binary", "sse", "ndjson"]);
const TEMPLATE_ROOTS = new Set(["requestId", "model", "prompt", "params", "inputs", "provider", "captures", "derived"]);
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "cookie", "set-cookie"]);
const SELECTOR = /^\$(?:\.[A-Za-z0-9_-]+|\[(?:\d+|\*)\])*$/;

class ProtocolValidationError extends Error {
  constructor(issues) {
    super("协议校验失败：" + issues.join("；"));
    this.name = "ProtocolValidationError";
    this.issues = issues;
  }
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function safePath(path) {
  if (path.startsWith("/")) return true;
  try {
    const url = new URL(path);
    return url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch { return false; }
}

function validateTemplates(value, path, issues, depth = 0, roots = TEMPLATE_ROOTS) {
  if (depth > 20) { issues.push(path + " 模板嵌套超过 20 层"); return; }
  if (typeof value === "string") {
    for (const match of value.matchAll(/{{[\s]*([^{}]+?)[\s]*}}/g)) {
      const expression = match[1].trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\[(?:\*|\d+)]))*$/.test(expression)) {
        issues.push(path + " 包含非法模板表达式「" + expression + "」");
        continue;
      }
      if (!roots.has(expression.split(".")[0])) issues.push(path + " 使用了未授权模板变量「" + expression + "」");
    }
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, index) => validateTemplates(item, path + "[" + index + "]", issues, depth + 1, roots));
  if (!value || typeof value !== "object") return;
  const descriptor = value;
  if (Object.prototype.hasOwnProperty.call(descriptor, "$merge") || Object.prototype.hasOwnProperty.call(descriptor, "$coalesce")) {
    const operator = Object.prototype.hasOwnProperty.call(descriptor, "$merge") ? "$merge" : "$coalesce";
    const sources = descriptor[operator];
    if (Object.keys(descriptor).length !== 1 || !Array.isArray(sources) || !sources.length) issues.push(path + "." + operator + " 必须是唯一字段且值为非空数组");
    else validateTemplates(sources, path + "." + operator, issues, depth + 1, roots);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(descriptor, "$concat")) {
    if (Object.keys(descriptor).length !== 1 || !Array.isArray(descriptor.$concat)) issues.push(path + ".$concat 必须是唯一字段且值为数组");
    else validateTemplates(descriptor.$concat, path + ".$concat", issues, depth + 1, roots);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(descriptor, "$dataUrlBase64")) {
    if (Object.keys(descriptor).length !== 1 || typeof descriptor.$dataUrlBase64 !== "string") issues.push(path + ".$dataUrlBase64 必须是唯一字段且值为模板字符串");
    else validateTemplates(descriptor.$dataUrlBase64, path + ".$dataUrlBase64", issues, depth + 1, roots);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(descriptor, "$keyValue")) {
    const definition = object(descriptor.$keyValue);
    if (Object.keys(descriptor).length !== 1 || Object.keys(definition).some((key) => !["key", "value"].includes(key)) || !Object.prototype.hasOwnProperty.call(definition, "key") || !Object.prototype.hasOwnProperty.call(definition, "value")) issues.push(path + ".$keyValue 只能包含 key 和 value");
    else validateTemplates(definition, path + ".$keyValue", issues, depth + 1, roots);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(descriptor, "$map")) {
    const map = object(descriptor.$map);
    if (Object.keys(descriptor).length !== 1 || Object.keys(map).some((key) => !["from", "template"].includes(key)) || !Object.prototype.hasOwnProperty.call(map, "from") || !Object.prototype.hasOwnProperty.call(map, "template")) {
      issues.push(path + ".$map 只能包含 from 和 template");
      return;
    }
    validateTemplates(map.from, path + ".$map.from", issues, depth + 1, roots);
    validateTemplates(map.template, path + ".$map.template", issues, depth + 1, new Set([...roots, "item"]));
    return;
  }
  if (Object.prototype.hasOwnProperty.call(descriptor, "$cardinality")) {
    const cardinality = object(descriptor.$cardinality);
    if (Object.keys(descriptor).length !== 1 || Object.keys(cardinality).some((key) => !["from", "zero", "one", "two", "many"].includes(key)) || !["from", "zero", "one", "many"].every((key) => Object.prototype.hasOwnProperty.call(cardinality, key))) {
      issues.push(path + ".$cardinality 必须包含 from、zero、one、many，且只能额外包含 two");
      return;
    }
    validateTemplates(cardinality.from, path + ".$cardinality.from", issues, depth + 1, roots);
    validateTemplates(cardinality.zero, path + ".$cardinality.zero", issues, depth + 1, roots);
    const branchRoots = new Set([...roots, "item", "items"]);
    validateTemplates(cardinality.one, path + ".$cardinality.one", issues, depth + 1, branchRoots);
    if (cardinality.two !== undefined) validateTemplates(cardinality.two, path + ".$cardinality.two", issues, depth + 1, branchRoots);
    validateTemplates(cardinality.many, path + ".$cardinality.many", issues, depth + 1, branchRoots);
    return;
  }
  for (const [key, item] of Object.entries(descriptor)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) issues.push(path + " 包含危险字段「" + key + "」");
    validateTemplates(item, path + "." + key, issues, depth + 1, roots);
  }
}

function validateSelectors(value, path, issues) {
  const selectors = typeof value === "string" ? [value] : strings(value);
  if (!selectors.length) { issues.push(path + " 必须是 JSONPath 字符串或字符串数组"); return; }
  for (const selector of selectors) if (!SELECTOR.test(selector)) issues.push(path + " 包含不受支持的 selector「" + selector + "」");
}

const EXPRESSION_OPS = new Set(["coalesce", "add", "multiply", "min", "max", "subtract", "divide", "round", "floor", "ceil", "toString", "upper", "lower", "clamp", "roundMultiple", "lookup"]);

function validateExpression(value, path, issues, depth = 0) {
  if (depth > 20) { issues.push(path + " 表达式嵌套超过 20 层"); return; }
  const expression = object(value);
  if (typeof expression.ref === "string") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\[\*]))*$/.test(expression.ref)) issues.push(path + ".ref 无效");
    else if (!TEMPLATE_ROOTS.has(expression.ref.split(".")[0])) issues.push(path + ".ref 使用了未授权变量");
    return;
  }
  if (Object.prototype.hasOwnProperty.call(expression, "literal")) return;
  const op = String(expression.op || "");
  if (!EXPRESSION_OPS.has(op)) { issues.push(path + ".op 不受支持"); return; }
  if (["coalesce", "add", "multiply", "min", "max"].includes(op)) {
    if (!Array.isArray(expression.values) || !expression.values.length) issues.push(path + ".values 不能为空");
    else expression.values.forEach((item, index) => validateExpression(item, path + ".values[" + index + "]", issues, depth + 1));
  } else if (["subtract", "divide"].includes(op)) {
    validateExpression(expression.left, path + ".left", issues, depth + 1);
    validateExpression(expression.right, path + ".right", issues, depth + 1);
  } else {
    validateExpression(expression.value, path + ".value", issues, depth + 1);
  }
  if (op === "clamp" && (!(Number(expression.min) <= Number(expression.max)) || !Number.isFinite(Number(expression.min)) || !Number.isFinite(Number(expression.max)))) issues.push(path + " clamp 范围无效");
  if (op === "roundMultiple" && (!(Number(expression.multiple) > 0) || !Number.isFinite(Number(expression.multiple)))) issues.push(path + ".multiple 必须大于 0");
  if (op === "lookup" && !Object.keys(object(expression.cases)).length) issues.push(path + ".cases 不能为空");
}

function validateOperation(id, value, path, issues) {
  const operation = object(value);
  const method = String(operation.method || "").toUpperCase();
  const operationPath = String(operation.path || "");
  if (!ID.test(id.replace(/\./g, "_"))) issues.push(path + " operation id「" + id + "」无效");
  if (!METHODS.has(method)) issues.push(path + ".method 不受支持");
  if (!operationPath || !safePath(operationPath.replace(/{[A-Za-z_][A-Za-z0-9_]*}/g, "value"))) issues.push(path + ".path 必须是相对路径、HTTPS，或 localhost HTTP");
  if (operation.requestMode != null && !REQUEST_MODES.has(String(operation.requestMode))) issues.push(path + ".requestMode 不受支持");
  if (operation.responseMode != null && !RESPONSE_MODES.has(String(operation.responseMode))) issues.push(path + ".responseMode 不受支持");
  if (operation.timeoutMs != null && (!(Number(operation.timeoutMs) > 0) || Number(operation.timeoutMs) > 3600000)) issues.push(path + ".timeoutMs 必须在 1–3600000 之间");
  if (operation.successStatus != null && (!Array.isArray(operation.successStatus) || !operation.successStatus.length || operation.successStatus.some((status) => !Number.isInteger(Number(status)) || Number(status) < 100 || Number(status) > 599))) issues.push(path + ".successStatus 必须是非空 HTTP 状态码数组");
  const headers = object(operation.headersTemplate);
  for (const key of Object.keys(headers)) if (FORBIDDEN_HEADERS.has(key.toLowerCase())) issues.push(path + ".headersTemplate 禁止设置 " + key);
  if (operation.requestMode === "multipart" && Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) issues.push(path + ".headersTemplate 的 multipart Content-Type 必须由执行器生成 boundary");
  if (operation.requestMode === "multipart" && (!operation.bodyTemplate || typeof operation.bodyTemplate !== "object" || Array.isArray(operation.bodyTemplate))) issues.push(path + ".bodyTemplate 在 multipart 模式下必须是对象");
  if (operation.requestMode === "binary" && (!operation.bodyTemplate || typeof operation.bodyTemplate !== "object" || Array.isArray(operation.bodyTemplate) || !Object.prototype.hasOwnProperty.call(operation.bodyTemplate, "$binary"))) issues.push(path + ".bodyTemplate 在 binary 模式下必须包含 $binary");
  if (operation.omitEmpty != null && typeof operation.omitEmpty !== "boolean") issues.push(path + ".omitEmpty 必须是布尔值");
  for (const key of ["headersTemplate", "queryTemplate", "bodyTemplate"]) validateTemplates(operation[key], path + "." + key, issues);
  for (const [key, expression] of Object.entries(object(operation.derive))) validateExpression(expression, path + ".derive." + key, issues);
  const response = object(operation.response);
  for (const [key, selector] of Object.entries(response)) validateSelectors(selector, path + ".response." + key, issues);
  const retry = object(operation.retry);
  if (operation.retry != null) {
    if (!Number.isInteger(Number(retry.attempts)) || Number(retry.attempts) < 1 || Number(retry.attempts) > 10) issues.push(path + ".retry.attempts 必须是 1–10 的整数");
    if (retry.delayMs != null && (!(Number(retry.delayMs) >= 0) || Number(retry.delayMs) > 300000)) issues.push(path + ".retry.delayMs 必须在 0–300000 之间");
    if (retry.backoff != null && (Number(retry.backoff) < 1 || Number(retry.backoff) > 10)) issues.push(path + ".retry.backoff 必须在 1–10 之间");
    if (retry.retryStatus != null && (!Array.isArray(retry.retryStatus) || retry.retryStatus.some((status) => !Number.isInteger(Number(status)) || Number(status) < 100 || Number(status) > 599))) issues.push(path + ".retry.retryStatus 必须是 HTTP 状态码数组");
    const hasRetryStatus = Array.isArray(retry.retryStatus) && retry.retryStatus.length > 0;
    if (Number(retry.attempts) > 1 && !hasRetryStatus && retry.retryNetwork !== true) issues.push(path + ".retry 必须明确声明 retryStatus 或 retryNetwork=true");
  }
  const fallbacks = Array.isArray(operation.fallbacks) ? operation.fallbacks : [];
  if (operation.fallbacks != null && !Array.isArray(operation.fallbacks)) issues.push(path + ".fallbacks 必须是数组");
  if (fallbacks.length > 8) issues.push(path + ".fallbacks 不能超过 8 项");
  const fallbackPaths = new Set();
  for (const [index, fallbackRaw] of fallbacks.entries()) {
    const fallback = object(fallbackRaw);
    const fallbackPath = String(fallback.path || "");
    if (!fallbackPath || !safePath(fallbackPath.replace(/{[A-Za-z_][A-Za-z0-9_]*}/g, "value"))) issues.push(path + ".fallbacks[" + index + "].path 无效");
    if (fallbackPaths.has(fallbackPath)) issues.push(path + ".fallbacks[" + index + "].path 重复");
    fallbackPaths.add(fallbackPath);
    if (fallback.queryTemplate != null && (typeof fallback.queryTemplate !== "object" || Array.isArray(fallback.queryTemplate))) issues.push(path + ".fallbacks[" + index + "].queryTemplate 必须是对象");
    validateTemplates(fallback.queryTemplate, path + ".fallbacks[" + index + "].queryTemplate", issues);
    if (fallback.onStatus != null && (!Array.isArray(fallback.onStatus) || fallback.onStatus.some((status) => !Number.isInteger(Number(status)) || Number(status) < 100 || Number(status) > 599))) issues.push(path + ".fallbacks[" + index + "].onStatus 必须是 HTTP 状态码数组");
    if (!(Array.isArray(fallback.onStatus) && fallback.onStatus.length) && fallback.onNetworkError !== true) issues.push(path + ".fallbacks[" + index + "] 必须明确声明 onStatus 或 onNetworkError=true");
  }
}

function validateAssetRules(raw, path, issues) {
  for (const [kind, value] of Object.entries(object(raw))) {
    if (!["images", "videos", "audios", "files"].includes(kind)) { issues.push(path + "." + kind + " 不是支持的素材类型"); continue; }
    const rule = object(value);
    if (!["data_url", "public_url", "remote_name", "upload_operation"].includes(String(rule.mode || ""))) issues.push(path + "." + kind + ".mode 不受支持");
    if (rule.maxBytes != null && (!Number.isInteger(Number(rule.maxBytes)) || Number(rule.maxBytes) < 1 || Number(rule.maxBytes) > 500 * 1024 * 1024)) issues.push(path + "." + kind + ".maxBytes 必须是 1–524288000 的整数");
    if (rule.maxDimension != null && (!Number.isInteger(Number(rule.maxDimension)) || Number(rule.maxDimension) < 64 || Number(rule.maxDimension) > 16384)) issues.push(path + "." + kind + ".maxDimension 必须是 64–16384 的整数");
    if (rule.mimeTypes != null && !strings(rule.mimeTypes).length) issues.push(path + "." + kind + ".mimeTypes 必须是非空字符串数组");
  }
}

function validateBase(raw, issues) {
  if (raw.schemaVersion !== PROTOCOL_V2_SCHEMA) issues.push("schemaVersion 必须是 " + PROTOCOL_V2_SCHEMA);
  if (!ID.test(String(raw.id || ""))) issues.push("id 只能使用小写字母、数字、冒号、下划线和短横线，长度 2–64");
  if (!String(raw.label || "").trim()) issues.push("缺少 label");
  const executor = object(raw.executor);
  if (!["declarative", "native"].includes(String(executor.type || ""))) issues.push("executor.type 必须是 declarative 或 native");
  if (executor.type === "declarative" && !String(executor.engine || "").trim()) issues.push("declarative executor 缺少 engine");
  if (executor.type === "native" && !ID.test(String(executor.adapter || ""))) issues.push("native executor 缺少合法 adapter");
}

function validateProvider(raw, issues) {
  const auth = object(raw.auth);
  if (!["bearer", "api_key_header", "google_api_key", "none"].includes(String(auth.type || ""))) issues.push("auth.type 不受支持");
  if (auth.credentialRef != null && !["api_key", "wallet_api_key"].includes(String(auth.credentialRef))) issues.push("auth.credentialRef 不受支持");
  for (const key of Object.keys(object(raw.headers))) if (FORBIDDEN_HEADERS.has(key.toLowerCase())) issues.push("headers 禁止设置 " + key);
  validateOperation("models", raw.models, "models", issues);
  if (!object(raw.models).response) issues.push("models.response 缺失");
  const operations = object(raw.operations);
  if (Object.keys(operations).length > 100) issues.push("operations 不能超过 100 个");
  for (const [id, operation] of Object.entries(operations)) validateOperation(id, operation, "operations." + id, issues);
}

function validateModel(raw, issues) {
  const operations = object(raw.operations);
  const workflows = object(raw.workflows);
  if (!Object.keys(operations).length) issues.push("模型协议至少需要一个 operation");
  if (!Object.keys(workflows).length) issues.push("模型协议至少需要一个 workflow");
  if (Object.keys(operations).length > 100) issues.push("operations 不能超过 100 个");
  if (Object.keys(workflows).length > 100) issues.push("workflows 不能超过 100 个");
  for (const [id, operation] of Object.entries(operations)) validateOperation(id, operation, "operations." + id, issues);
  for (const [id, value] of Object.entries(workflows)) {
    const workflow = object(value);
    const submit = String(workflow.submit || "");
    if (!operations[submit]) issues.push("workflows." + id + ".submit 引用了不存在的 operation「" + submit + "」");
    const uploads = Array.isArray(workflow.uploads) ? workflow.uploads : [];
    if (workflow.uploads != null && !Array.isArray(workflow.uploads)) issues.push("workflows." + id + ".uploads 必须是数组");
    if (uploads.length > 16) issues.push("workflows." + id + ".uploads 不能超过 16 项");
    const uploadTargets = new Set();
    for (const [index, uploadRaw] of uploads.entries()) {
      const upload = object(uploadRaw);
      const operation = String(upload.operation || "");
      const inputs = String(upload.inputs || "");
      const result = object(upload.result);
      if (!operations[operation]) issues.push("workflows." + id + ".uploads[" + index + "].operation 引用了不存在的 operation「" + operation + "」");
      if (!["images", "videos", "audios", "files"].includes(inputs)) issues.push("workflows." + id + ".uploads[" + index + "].inputs 不受支持");
      if (!String(result.source || "")) issues.push("workflows." + id + ".uploads[" + index + "].result.source 不能为空");
      if (!["url", "remoteName"].includes(String(result.target || ""))) issues.push("workflows." + id + ".uploads[" + index + "].result.target 不受支持");
      const targetKey = inputs + ":" + String(result.target || "");
      if (uploadTargets.has(targetKey)) issues.push("workflows." + id + ".uploads[" + index + "] 重复声明 " + targetKey);
      uploadTargets.add(targetKey);
      if (operation && !Object.prototype.hasOwnProperty.call(object(object(operations[operation]).response), String(result.source || ""))) {
        issues.push("workflows." + id + ".uploads[" + index + "].result.source 未由 operation.response 声明");
      }
    }
    const poll = object(workflow.poll);
    if (workflow.poll != null) {
      const operation = String(poll.operation || "");
      if (!operations[operation]) issues.push("workflows." + id + ".poll.operation 引用了不存在的 operation「" + operation + "」");
      if (!(Number(poll.intervalMs) >= 100) || Number(poll.intervalMs) > 300000) issues.push("workflows." + id + ".poll.intervalMs 必须在 100–300000 之间");
      if (poll.maxAttempts != null && (!Number.isInteger(Number(poll.maxAttempts)) || Number(poll.maxAttempts) < 1 || Number(poll.maxAttempts) > 100000)) issues.push("workflows." + id + ".poll.maxAttempts 必须是 1–100000 的整数");
      if (poll.maxDurationMs != null && (!(Number(poll.maxDurationMs) >= 60000) || Number(poll.maxDurationMs) > 86400000)) issues.push("workflows." + id + ".poll.maxDurationMs 必须在 60000–86400000 之间");
      const status = object(poll.status);
      for (const key of ["pending", "success", "failure"]) if (!strings(status[key]).length) issues.push("workflows." + id + ".poll.status." + key + " 不能为空");
    }
    const download = String(workflow.download || "");
    if (download && !operations[download]) issues.push("workflows." + id + ".download 引用了不存在的 operation「" + download + "」");
  }
  for (const [id, value] of Object.entries(object(raw.modelProfiles))) {
    const profile = object(value);
    if (!strings(profile.capabilities).length) issues.push("modelProfiles." + id + ".capabilities 不能为空");
    for (const [intent, workflow] of Object.entries(object(profile.workflows))) if (!workflows[String(workflow)]) issues.push("modelProfiles." + id + ".workflows." + intent + " 引用了不存在的 workflow「" + String(workflow) + "」");
    for (const schemaId of strings(profile.uiSchemas)) if (!object(raw.uiSchemas)[schemaId]) issues.push("modelProfiles." + id + ".uiSchemas 引用了不存在的 schema「" + schemaId + "」");
    validateAssetRules(profile.assets, "modelProfiles." + id + ".assets", issues);
  }
  validateAssetRules(raw.assets, "assets", issues);
}

function validateProtocolV2(value) {
  const raw = object(value);
  const issues = [];
  let serialized = "";
  try { serialized = JSON.stringify(value); } catch { issues.push("协议必须可以序列化为 JSON"); }
  if (serialized.length > 256 * 1024) issues.push("协议 JSON 不能超过 256 KiB");
  validateBase(raw, issues);
  if (raw.kind === "provider") validateProvider(raw, issues);
  else if (raw.kind === "model") validateModel(raw, issues);
  else issues.push("kind 必须是 provider 或 model");
  if (issues.length) throw new ProtocolValidationError(issues);
  return structuredClone(raw);
}

function isProviderProtocolV2(protocol) { return protocol.kind === "provider"; }
function isModelProtocolV2(protocol) { return protocol.kind === "model"; }

module.exports = { ProtocolValidationError, validateProtocolV2, isProviderProtocolV2, isModelProtocolV2, safePath, validateOperation, validateExpression };
