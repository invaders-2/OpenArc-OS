"use strict";
/**
 * dx-protocol/v2 声明式编译器：把 protocol + workflow 编译成可执行 HTTP 计划。
 * 源：DXSRC/protocol-engine/compiler.ts:1-484 逐条移植（含 $merge/$coalesce/$concat/
 * $dataUrlBase64/$keyValue/$map/$cardinality 渲染语义与 derive 表达式求值）。
 */
const { validateProtocolV2, isProviderProtocolV2, isModelProtocolV2 } = require("./validator.cjs");
const { findModelProfile } = require("./modelProfile.cjs");
const { geminiToolDefinitions } = require("./geminiToolSchema.cjs");

const UNDEFINED = Symbol("protocol-template-undefined");
const WHOLE_TEMPLATE = /^{{[\s]*([^{}]+?)[\s]*}}$/;
const DEFERRED_INPUT_REF = "__dxProtocolInputRef";

function expressionParts(expression) {
  return expression.replace(/\[(\*|\d+)]/g, ".$1").split(".").filter(Boolean).map((part) => /^\d+$/.test(part) ? Number(part) : part);
}

function expressionValue(root, expression) {
  let values = [root];
  let hasWildcard = false;
  for (const part of expressionParts(expression)) {
    if (part === "*") {
      hasWildcard = true;
      values = values.flatMap((value) => Array.isArray(value) ? value : []);
      continue;
    }
    if (typeof part === "number") {
      values = values.flatMap((value) => Array.isArray(value) && part < value.length ? [value[part]] : []);
      continue;
    }
    values = values.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      return Object.prototype.hasOwnProperty.call(value, part) ? [value[part]] : [];
    });
  }
  if (hasWildcard) return values.filter((value) => value !== undefined);
  return values.length ? values[0] : UNDEFINED;
}

function renderString(value, context) {
  const templateRoot = context.locals ? { ...context, ...context.locals } : context;
  const whole = value.match(WHOLE_TEMPLATE);
  if (whole) {
    const expression = whole[1].trim();
    const localInputField = /^(?:item)\.(url|name)$/.exec(expression);
    if (context.deferInputRefs && context.localInput && localInputField) {
      const field = localInputField[1];
      const asset = context.inputs[context.localInput.group][context.localInput.index];
      const ref = "inputs." + context.localInput.group + "." + context.localInput.index + "." + field;
      return { [DEFERRED_INPUT_REF]: ref, base: asset ? asset[field] ?? null : null };
    }
    const resolved = expressionValue(templateRoot, expression);
    if (resolved === UNDEFINED && expression.startsWith("captures.")) return "<capture:" + expression.slice("captures.".length) + ">";
    const normalizedExpression = expression.replace(/\[(\*|\d+)]/g, ".$1");
    const inputRef = /^inputs\.(images|videos|audios|files)\.(\*|\d+)\.(url|name)$/.exec(normalizedExpression);
    if (context.deferInputRefs && inputRef) {
      const group = inputRef[1];
      const field = inputRef[3];
      const base = inputRef[2] === "*"
        ? context.inputs[group].map((asset) => asset[field] ?? null)
        : (context.inputs[group][Number(inputRef[2])] ? context.inputs[group][Number(inputRef[2])][field] : undefined) ?? null;
      return { [DEFERRED_INPUT_REF]: normalizedExpression, base };
    }
    return resolved;
  }
  return value.replace(/{{[\s]*([^{}]+?)[\s]*}}/g, (_match, expression) => {
    const normalized = String(expression).trim();
    const resolved = expressionValue(templateRoot, normalized);
    if (resolved === UNDEFINED && normalized.startsWith("captures.")) return "<capture:" + normalized.slice("captures.".length) + ">";
    return resolved === UNDEFINED || resolved == null ? "" : String(resolved);
  });
}

function renderTemplate(value, context, depth = 0) {
  if (depth > 20) throw new Error("协议模板嵌套超过 20 层");
  if (typeof value === "string") return renderString(value, context);
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, context, depth + 1)).filter((item) => item !== UNDEFINED);
  if (!value || typeof value !== "object") return value;
  const descriptor = value;
  if (Object.prototype.hasOwnProperty.call(descriptor, "$merge")) {
    const sources = renderTemplate(descriptor.$merge, context, depth + 1);
    if (!Array.isArray(sources) || sources.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("$merge 的每一项都必须渲染为对象");
    return Object.assign({}, ...sources);
  }
  if (Object.prototype.hasOwnProperty.call(descriptor, "$coalesce")) {
    const sources = descriptor.$coalesce;
    if (!Array.isArray(sources)) throw new Error("$coalesce 必须是数组");
    for (const source of sources) {
      const rendered = renderTemplate(source, context, depth + 1);
      if (rendered !== UNDEFINED && rendered !== undefined && rendered !== null && rendered !== "" && (!Array.isArray(rendered) || rendered.length)) return rendered;
    }
    return UNDEFINED;
  }
  if (Object.prototype.hasOwnProperty.call(descriptor, "$concat")) {
    const sources = renderTemplate(descriptor.$concat, context, depth + 1);
    if (!Array.isArray(sources) || sources.some((item) => !Array.isArray(item))) throw new Error("$concat 的每一项都必须渲染为数组");
    return sources.flat();
  }
  if (Object.prototype.hasOwnProperty.call(descriptor, "$dataUrlBase64")) {
    const rendered = renderTemplate(descriptor.$dataUrlBase64, context, depth + 1);
    if (typeof rendered !== "string") throw new Error("$dataUrlBase64 必须渲染为 Data URL 字符串");
    if (/^<local-asset:[^>]+>$/.test(rendered)) return rendered;
    const match = /^data:[^;,]+(?:;[^,]*)?;base64,([A-Za-z0-9+/=\r\n]+)$/s.exec(rendered);
    if (!match) throw new Error("$dataUrlBase64 收到无效的 Base64 Data URL");
    return match[1].replace(/[\s]+/g, "");
  }
  if (Object.prototype.hasOwnProperty.call(descriptor, "$keyValue")) {
    const definition = descriptor.$keyValue;
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new Error("$keyValue 必须是对象");
    const rendered = renderTemplate(definition, context, depth + 1);
    const key = String(rendered.key || "").trim();
    if (!key) return UNDEFINED;
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("$keyValue 包含危险字段名");
    return { [key]: rendered.value };
  }
  if (Object.prototype.hasOwnProperty.call(descriptor, "$map")) {
    const map = descriptor.$map;
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("$map 必须是对象");
    const definition = map;
    const source = renderTemplate(definition.from, context, depth + 1);
    if (!Array.isArray(source)) throw new Error("$map.from 必须渲染为数组");
    const inputGroup = typeof definition.from === "string" ? (/^{{[\s]*inputs\.(images|videos|audios|files)[\s]*}}$/.exec(definition.from) || [])[1] : undefined;
    return source.map((item, index) => renderTemplate(definition.template, {
      ...context,
      locals: { ...(context.locals || {}), item },
      ...(inputGroup ? { localInput: { group: inputGroup, index } } : {}),
    }, depth + 1)).filter((item) => item !== UNDEFINED);
  }
  if (Object.prototype.hasOwnProperty.call(descriptor, "$cardinality")) {
    const cardinality = descriptor.$cardinality;
    if (!cardinality || typeof cardinality !== "object" || Array.isArray(cardinality)) throw new Error("$cardinality 必须是对象");
    const definition = cardinality;
    let source = renderTemplate(definition.from, context, depth + 1);
    if (source && typeof source === "object" && !Array.isArray(source) && typeof source[DEFERRED_INPUT_REF] === "string") {
      const expression = String(source[DEFERRED_INPUT_REF]);
      const match = /^inputs\.(images|videos|audios|files)\.\*\.(url|name)$/.exec(expression);
      if (match) {
        const group = match[1];
        const field = match[2];
        source = context.inputs[group].map((asset, index) => ({ [DEFERRED_INPUT_REF]: "inputs." + group + "." + index + "." + field, base: asset[field] ?? null }));
      }
    }
    if (!Array.isArray(source)) throw new Error("$cardinality.from 必须渲染为数组");
    const branch = source.length === 0 ? definition.zero : source.length === 1 ? definition.one : source.length === 2 && definition.two !== undefined ? definition.two : definition.many;
    return renderTemplate(branch, { ...context, locals: { ...(context.locals || {}), item: source[0], items: source } }, depth + 1);
  }
  const result = {};
  for (const [key, item] of Object.entries(descriptor)) {
    const rendered = renderTemplate(item, context, depth + 1);
    if (rendered !== UNDEFINED) result[key] = rendered;
  }
  return result;
}

function compactEmpty(value) {
  if (value === undefined || value === null || value === "") return UNDEFINED;
  if (Array.isArray(value)) {
    const items = value.map(compactEmpty).filter((item) => item !== UNDEFINED);
    return items.length ? items : UNDEFINED;
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value).map(([key, item]) => [key, compactEmpty(item)]).filter((entry) => entry[1] !== UNDEFINED);
  return entries.length ? Object.fromEntries(entries) : UNDEFINED;
}

function finiteNumber(value, path) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(path + " 没有得到有限数字");
  return number;
}

function evaluateExpression(expression, context, path, depth = 0) {
  if (depth > 20) throw new Error(path + " 表达式嵌套超过 20 层");
  if ("ref" in expression) {
    const value = expressionValue(context, expression.ref);
    return value === UNDEFINED ? undefined : value;
  }
  if ("literal" in expression) return structuredClone(expression.literal);
  const evaluate = (value, suffix) => evaluateExpression(value, context, path + "." + suffix, depth + 1);
  if (expression.op === "coalesce") {
    for (let index = 0; index < expression.values.length; index += 1) {
      const value = evaluate(expression.values[index], "values[" + index + "]");
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  }
  if (expression.op === "add" || expression.op === "multiply" || expression.op === "min" || expression.op === "max") {
    const values = expression.values.map((value, index) => finiteNumber(evaluate(value, "values[" + index + "]"), path));
    if (expression.op === "add") return values.reduce((sum, value) => sum + value, 0);
    if (expression.op === "multiply") return values.reduce((product, value) => product * value, 1);
    return expression.op === "min" ? Math.min(...values) : Math.max(...values);
  }
  if (expression.op === "subtract" || expression.op === "divide") {
    const left = finiteNumber(evaluate(expression.left, "left"), path);
    const right = finiteNumber(evaluate(expression.right, "right"), path);
    if (expression.op === "divide" && right === 0) throw new Error(path + " 不能除以 0");
    return expression.op === "subtract" ? left - right : left / right;
  }
  if (!("value" in expression)) throw new Error(path + " 表达式缺少 value");
  const value = evaluate(expression.value, "value");
  if (expression.op === "toString") return String(value ?? "");
  if (expression.op === "upper") return String(value ?? "").toUpperCase();
  if (expression.op === "lower") return String(value ?? "").toLowerCase();
  if (expression.op === "round") return Math.round(finiteNumber(value, path));
  if (expression.op === "floor") return Math.floor(finiteNumber(value, path));
  if (expression.op === "ceil") return Math.ceil(finiteNumber(value, path));
  if (expression.op === "clamp") return Math.max(expression.min, Math.min(expression.max, finiteNumber(value, path)));
  if (expression.op === "roundMultiple") {
    const rounded = Math.round(finiteNumber(value, path) / expression.multiple) * expression.multiple;
    return Math.max(expression.min ?? -Infinity, Math.min(expression.max ?? Infinity, rounded));
  }
  if (expression.op === "lookup") {
    const key = String(value ?? "");
    return structuredClone(Object.prototype.hasOwnProperty.call(expression.cases, key) ? expression.cases[key] : expression.fallback);
  }
  throw new Error(path + " 使用了未知表达式");
}

function pathValue(context, key) {
  let direct = expressionValue(context, key);
  if (direct === UNDEFINED && !key.includes(".")) direct = expressionValue(context, "captures." + key);
  return direct === UNDEFINED ? "<capture:" + key + ">" : encodeURIComponent(String(direct));
}

function joinUrl(baseUrl, path) {
  if (/^https?:\/\//i.test(path)) return path;
  const base = baseUrl.replace(/\/+$/, "");
  let suffix = path.replace(/^\/+/, "");
  for (const prefix of ["api/v3", "v1beta", "v1", "v2"]) {
    if (base.toLowerCase().endsWith("/" + prefix) && suffix.toLowerCase().startsWith(prefix + "/")) {
      suffix = suffix.slice(prefix.length).replace(/^\/+/, "");
      break;
    }
  }
  const versionMatch = /\/(v\d+(?:beta\d*)?)$/i.exec(base);
  const suffixVersion = (/^(v\d+(?:beta\d*)?)(?:\/|$)/i.exec(suffix) || [])[1];
  if (versionMatch && suffixVersion) {
    if (versionMatch[1].toLowerCase() === suffixVersion.toLowerCase()) suffix = suffix.slice(suffixVersion.length).replace(/^\/+/, "");
    else return base.slice(0, versionMatch.index) + "/" + suffix;
  }
  return base + "/" + suffix;
}

function authHeader(provider, credential, redactSecrets) {
  if (provider.auth.type === "none") return {};
  const header = provider.auth.header || (provider.auth.type === "google_api_key" ? "x-goog-api-key" : provider.auth.type === "api_key_header" ? "x-api-key" : "Authorization");
  const prefix = provider.auth.prefix ?? (provider.auth.type === "bearer" ? "Bearer " : "");
  const secret = redactSecrets ? "<secret:" + (provider.auth.credentialRef || "api_key") + ">" : String(credential || "");
  return { [header]: prefix + secret };
}

function withRequestIdentity(request, requestId, idempotentSubmit = false) {
  const headers = { ...request.headers };
  const hasHeader = (name) => Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
  if (!hasHeader("X-Request-Id")) headers["X-Request-Id"] = requestId;
  if (idempotentSubmit && !["GET", "HEAD"].includes(request.method) && !hasHeader("Idempotency-Key")) headers["Idempotency-Key"] = requestId;
  return { ...request, headers };
}

function withSafePollRetry(request) {
  if (!["GET", "HEAD"].includes(request.method)) return request;
  const retry = request.retry || { attempts: 1 };
  return {
    ...request,
    retry: { ...retry, attempts: Math.max(3, retry.attempts || 1), retryStatus: [...new Set([...(retry.retryStatus || []), 520, 524])] },
  };
}

function compileOperation(operation, context, provider, credential, redactSecrets) {
  context.derived = {};
  for (const [key, expression] of Object.entries(operation.derive || {})) context.derived[key] = evaluateExpression(expression, context, "derive." + key);
  const renderPath = (path) => path.replace(/{([A-Za-z_][A-Za-z0-9_.]*)}/g, (_match, key) => pathValue(context, String(key)));
  const renderedPath = renderPath(operation.path);
  const query = renderTemplate(operation.queryTemplate || {}, context);
  const operationUrl = (path, queryValues = query) => {
    const url = new URL(joinUrl(context.provider.baseUrl, renderPath(path)));
    for (const [key, value] of Object.entries(queryValues)) {
      if (value == null || value === "") continue;
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
      else url.searchParams.set(key, String(value));
    }
    return url.toString();
  };
  const renderedHeaders = renderTemplate(operation.headersTemplate || {}, context);
  const headers = Object.fromEntries(Object.entries({
    ...(provider.headers || {}),
    ...authHeader(provider, credential, redactSecrets),
    ...Object.fromEntries(Object.entries(renderedHeaders).map(([key, value]) => [key, String(value)])),
  }).sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase())));
  const renderedBody = renderTemplate(operation.bodyTemplate, context);
  const body = operation.omitEmpty ? compactEmpty(renderedBody) : renderedBody;
  return {
    method: operation.method,
    url: operationUrl(renderedPath),
    headers,
    requestMode: operation.requestMode || "json",
    responseMode: operation.responseMode || "json",
    ...(body === UNDEFINED || body === undefined ? {} : { body }),
    ...((operation.timeoutMs || (provider.defaults && provider.defaults.timeoutMs)) ? { timeoutMs: operation.timeoutMs || provider.defaults.timeoutMs } : {}),
    ...(operation.successStatus && operation.successStatus.length ? { successStatus: [...operation.successStatus] } : {}),
    ...(operation.retry ? { retry: structuredClone(operation.retry) } : {}),
    ...(operation.fallbacks && operation.fallbacks.length ? { fallbacks: operation.fallbacks.map((fallback) => ({
      url: operationUrl(fallback.path, fallback.queryTemplate === undefined ? query : renderTemplate(fallback.queryTemplate, context)),
      onStatus: [...(fallback.onStatus || [])], onNetworkError: fallback.onNetworkError === true,
    })) } : {}),
  };
}

function workflowFor(modelProtocol, model, intent) {
  const profile = findModelProfile(modelProtocol.modelProfiles, model);
  const requested = profile && profile[1].workflows ? profile[1].workflows[intent] : undefined;
  const id = requested || (modelProtocol.workflows[intent] ? intent : "");
  if (!id || !modelProtocol.workflows[id]) throw new Error("模型协议「" + modelProtocol.id + "」没有匹配 " + intent + " 的 workflow");
  return { id, workflow: modelProtocol.workflows[id], profileId: profile && profile[0], profile: profile && profile[1] };
}

function compileProtocolPlan(args) {
  const provider = validateProtocolV2(args.providerProtocol);
  const model = validateProtocolV2(args.modelProtocol);
  if (!isProviderProtocolV2(provider)) throw new Error("providerProtocol 必须是平台协议");
  if (!isModelProtocolV2(model)) throw new Error("modelProtocol 必须是模型协议");
  if (provider.executor.type !== "declarative" || model.executor.type !== "declarative") throw new Error("纯函数编译器只接受 declarative v2 协议");
  const selected = workflowFor(model, args.task.model, args.task.intent);
  const context = {
    requestId: args.task.requestId,
    model: args.task.model,
    prompt: String(args.task.prompt || ""),
    params: {
      ...((selected.profile && selected.profile.defaults) || {}), ...args.task.params,
      ...(model.id === "gemini" && args.task.intent === "llm.tools" && args.task.params.tools !== undefined
        ? { tools: geminiToolDefinitions(args.task.params.tools) } : {}),
    },
    inputs: structuredClone(args.task.inputs),
    provider: { id: provider.id, baseUrl: args.baseUrl },
    captures: {},
    derived: {},
  };
  const operation = (id) => {
    const value = model.operations[id] || (provider.operations ? provider.operations[id] : undefined);
    if (!value) throw new Error("workflow 引用了不存在的 operation「" + id + "」");
    return value;
  };
  const uploadSteps = [];
  for (const upload of selected.workflow.uploads || []) {
    for (const [index, asset] of context.inputs[upload.inputs].entries()) {
      if (upload.result.target === "url" && asset.url || upload.result.target === "remoteName" && asset.name && !asset.dataUrl) continue;
      const uploadInputs = { images: [], videos: [], audios: [], files: [] };
      uploadInputs[upload.inputs] = [structuredClone(asset)];
      uploadSteps.push({
        id: "upload",
        operation: upload.operation,
        request: withRequestIdentity(compileOperation(operation(upload.operation), { ...context, inputs: uploadInputs }, provider, args.credential, args.redactSecrets !== false), args.task.requestId),
        capture: operation(upload.operation).response,
        upload: { inputs: upload.inputs, index, source: upload.result.source, target: upload.result.target },
      });
    }
  }
  const submitContext = { ...context, deferInputRefs: uploadSteps.length > 0 };
  const steps = [...uploadSteps, {
    id: "submit",
    operation: selected.workflow.submit,
    request: withRequestIdentity(compileOperation(operation(selected.workflow.submit), submitContext, provider, args.credential, args.redactSecrets !== false), args.task.requestId, true),
    capture: operation(selected.workflow.submit).response,
    result: selected.workflow.result,
  }];
  if (selected.workflow.poll) steps.push({
    id: "poll", operation: selected.workflow.poll.operation,
    request: withSafePollRetry(withRequestIdentity(compileOperation(operation(selected.workflow.poll.operation), context, provider, args.credential, args.redactSecrets !== false), args.task.requestId)),
    capture: operation(selected.workflow.poll.operation).response,
    repeat: selected.workflow.poll,
  });
  if (selected.workflow.download) steps.push({
    id: "download", operation: selected.workflow.download,
    request: withRequestIdentity(compileOperation(operation(selected.workflow.download), context, provider, args.credential, args.redactSecrets !== false), args.task.requestId),
    result: selected.workflow.result,
  });
  return {
    format: "dx-protocol-plan/v1", requestId: args.task.requestId,
    protocol: { provider: provider.id, model: model.id, ...(selected.profileId ? { profile: selected.profileId } : {}) },
    intent: args.task.intent, workflow: selected.id, steps,
  };
}

module.exports = { compileProtocolPlan, DEFERRED_INPUT_REF, expressionValue, renderTemplate, evaluateExpression, joinUrl };
