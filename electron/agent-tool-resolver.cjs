"use strict";
/**
 * B-T2 · Agent 工具解析器（源 toolResolver.ts 逐函数移植 + 权限判定）。
 *
 * 源（DXSRC = DX OS.app/Contents/Resources/app.asar.unpacked/server）：
 *   · toolResolver.ts:5-13    ToolResolverRequest
 *   · toolResolver.ts:15-19   ToolResolverResult
 *   · toolResolver.ts:21      DEFAULT_AGENT_SOURCES
 *   · toolResolver.ts:23-26   allowedRisk
 *   · toolResolver.ts:28-59   resolveTools（按来源/域/意图/风险/客户端过滤 + openaiTools + executors）
 *   · toolResolver.ts:61-69   resolveReactTools
 *
 * 依赖替换：
 *   · 源 import toolCatalogSnapshot -> require ./agent-tool-catalog.cjs（T1 产出；可注入 catalog 覆盖）
 *   · 源 import capabilityMetadata  -> ./agent-contracts.cjs（既有移植）
 *   · 源 import type AuthUser       -> 普通对象；权限走注入的 auth 适配器
 *
 * T2 新增（源没有、本轮验收要求）：
 *   · 按名解析 resolveToolByName / 按来源解析 resolveToolsBySource
 *   · 权限判定 resolveToolPermission：调用注入的 { canUseAppPermission(user, permission) }；
 *     适配器未注入时按保守策略拒绝，并返回结构化错误（code='auth_unavailable'）
 *   · 解析命中/未命中统一为 { ok, ... } 或 { ok:false, error:{ code, message } }
 */
const { capabilityMetadata } = require("./agent-contracts.cjs");

/** 结构化错误码：catalog_unavailable / auth_unavailable / permission_denied / not_found / invalid_request / internal。 */
const TOOL_RESOLVER_ERROR_CODES = Object.freeze([
  "catalog_unavailable", "auth_unavailable", "permission_denied", "not_found", "invalid_request", "internal",
]);

class ToolResolverError extends Error {
  constructor(code, message, extra) {
    super(String(message));
    this.name = "ToolResolverError";
    this.code = String(code);
    if (extra && typeof extra === "object") {
      if (extra.cause !== undefined) this.cause = extra.cause;
      if (extra.detail !== undefined) this.detail = extra.detail;
    }
  }
}

/** 结构化失败投影；调用方只依赖 code/message，不解析异常文本。 */
function toResolverErrorPayload(error) {
  if (error instanceof ToolResolverError) {
    return {
      ok: false, code: error.code, message: error.message,
      ...(error.detail !== undefined ? { detail: error.detail } : {}),
    };
  }
  return { ok: false, code: "internal", message: String((error && error.message) || error) };
}

function resolverFailure(code, message, extra) {
  return { ok: false, error: { code: String(code), message: String(message), ...(extra || {}) } };
}

function resolverFailureFrom(error) {
  const payload = toResolverErrorPayload(error);
  return { ok: false, error: { code: payload.code, message: payload.message, ...(payload.detail !== undefined ? { detail: payload.detail } : {}) } };
}

/** 本地注入点：目录与权限适配器都可覆盖；默认目录走 require，默认权限为空（保守拒绝）。 */
let resolverOptions = { catalog: null, auth: null };

function configureToolResolver(patch = {}) {
  const next = { ...resolverOptions };
  for (const key of ["catalog", "auth"]) if (patch[key] !== undefined) next[key] = patch[key];
  resolverOptions = next;
  return { ...resolverOptions };
}

function resetToolResolverForTests() {
  resolverOptions = { catalog: null, auth: null };
  return { ...resolverOptions };
}

function toolResolverDeps() {
  return { ...resolverOptions };
}

/** 源 toolResolver.ts:21。 */
const DEFAULT_AGENT_SOURCES = Object.freeze(["system", "file", "skill", "mcp"]);

/** 目录依赖：注入优先；未注入时 require T1 的 electron/agent-tool-catalog.cjs。 */
function loadCatalog() {
  if (resolverOptions.catalog) return resolverOptions.catalog;
  let mod;
  try {
    mod = require("./agent-tool-catalog.cjs");
  } catch (error) {
    throw new ToolResolverError("catalog_unavailable", "工具目录未就绪：agent-tool-catalog.cjs 不可用", { cause: error });
  }
  if (!mod || typeof mod.toolCatalogSnapshot !== "function") {
    throw new ToolResolverError("catalog_unavailable", "工具目录接口不完整：缺少 toolCatalogSnapshot()");
  }
  return mod;
}

/** 取一次目录快照；返回结果必须带 descriptors 数组，否则视为目录不可用。 */
function catalogSnapshot(input, options) {
  const catalog = (options && options.catalog) || loadCatalog();
  if (!catalog || typeof catalog.toolCatalogSnapshot !== "function") {
    throw new ToolResolverError("catalog_unavailable", "工具目录接口不完整：缺少 toolCatalogSnapshot()");
  }
  const snapshot = catalog.toolCatalogSnapshot(input);
  if (!snapshot || !Array.isArray(snapshot.descriptors)) {
    throw new ToolResolverError("catalog_unavailable", "工具目录返回结果缺少 descriptors 数组");
  }
  return snapshot;
}

/** 权限适配器：显式注入优先；未注入返回 null（= 保守拒绝，不伪造通过）。 */
function loadAuth(options) {
  if (options && options.auth !== undefined) return options.auth || null;
  return resolverOptions.auth || null;
}

function actorIdOf(actor) {
  return actor && actor.id !== undefined && actor.id !== null ? String(actor.id) : null;
}

/**
 * T2 权限判定：对 descriptor.permissions 逐条调用 canUseAppPermission(actor, permission)。
 * 未注入 auth 适配器 -> allowed:false / code='auth_unavailable'（保守拒绝，结构化）。
 * 工具未声明 permissions -> allowed:true（无需权限适配器）。
 */
function resolveToolPermission(tool, actor, options) {
  const permissions = Array.isArray(tool && tool.permissions) ? tool.permissions.filter(Boolean).map(String) : [];
  const base = { toolName: tool && tool.name, actorId: actorIdOf(actor), permissions };
  if (!permissions.length) return { ...base, allowed: true, code: "ok", message: "未声明权限" };
  const auth = loadAuth(options);
  if (!auth || typeof auth.canUseAppPermission !== "function") {
    return { ...base, allowed: false, code: "auth_unavailable", message: "权限适配器未注入，按保守策略拒绝：" + (tool && tool.name) };
  }
  for (const permission of permissions) {
    let allowed;
    try {
      allowed = auth.canUseAppPermission(actor, permission) === true;
    } catch (error) {
      return { ...base, allowed: false, code: "auth_unavailable", permission, message: "权限适配器调用失败：" + String((error && error.message) || error) };
    }
    if (!allowed) {
      return { ...base, allowed: false, code: "permission_denied", permission, message: "当前账户没有权限：" + permission };
    }
  }
  return { ...base, allowed: true, code: "ok", message: "权限通过" };
}

/** 需要异常语义的调用方：权限不通过直接抛 ToolResolverError。 */
function assertToolPermission(tool, actor, options) {
  const decision = resolveToolPermission(tool, actor, options);
  if (!decision.allowed) {
    throw new ToolResolverError(decision.code, decision.message, { detail: { toolName: tool && tool.name, permission: decision.permission } });
  }
  return decision;
}

/** 源 toolResolver.ts:23-26。includeRisk 为空 = 不过滤。 */
function allowedRisk(tool, includeRisk) {
  if (!Array.isArray(includeRisk) || !includeRisk.length) return true;
  return includeRisk.includes(tool.risk);
}

/** 源 toolResolver.ts:33/46 的 domain 推导（app 源带 appId 前缀）。 */
function domainOf(tool) {
  if (tool.domain) return tool.domain;
  return tool.source === "app" ? "app." + (tool.appId || tool.sourceId) : tool.source;
}

/** 源 toolResolver.ts:34/47 的 intent 推导（缺省回退 capabilityId 或 source.name）。 */
function intentKeys(tool) {
  if (Array.isArray(tool.intents) && tool.intents.length) return tool.intents;
  return [tool.capabilityId || (tool.source + "." + tool.name)];
}

/**
 * 源 toolResolver.ts:28-36 的过滤链（不含权限，权限在 resolveTools 里逐条判定）：
 *   intent=project.agent 且未显式给 sources -> DEFAULT_AGENT_SOURCES；
 *   executableOnly 默认 true；sources/domains/intents/includeRisk 过滤；project.agent 排除 client handler。
 */
function collectToolDescriptors(request, options) {
  const req = request && typeof request === "object" ? request : {};
  const requested = Array.isArray(req.requestedSources) && req.requestedSources.length
    ? req.requestedSources
    : req.intent === "project.agent" ? [...DEFAULT_AGENT_SOURCES] : undefined;
  const executableOnly = req.executableOnly === undefined ? true : req.executableOnly;
  const snapshot = catalogSnapshot({ actor: req.actor, executableOnly }, options);
  let descriptors = snapshot.descriptors.slice();
  if (requested && requested.length) descriptors = descriptors.filter((tool) => requested.includes(tool.source));
  if (Array.isArray(req.domains) && req.domains.length) descriptors = descriptors.filter((tool) => req.domains.includes(domainOf(tool)));
  if (Array.isArray(req.intents) && req.intents.length) descriptors = descriptors.filter((tool) => intentKeys(tool).some((intent) => req.intents.includes(intent)));
  descriptors = descriptors.filter((tool) => allowedRisk(tool, req.includeRisk));
  if (req.intent === "project.agent") descriptors = descriptors.filter((tool) => (tool.handler && tool.handler.type) !== "client");
  return descriptors;
}

/** 源 toolResolver.ts:37-51。 */
function buildOpenAiTools(descriptors) {
  return descriptors.map((tool) => {
    const when = Array.isArray(tool.whenToUse) ? tool.whenToUse : [];
    const hints = when.length ? "\n适用场景：" + when.join("；") : "";
    return {
      type: "function",
      function: {
        name: tool.name,
        description: "[" + tool.title + "] " + tool.description + hints,
        parameters: tool.inputSchema,
      },
      x_dx_capability: capabilityMetadata({
        id: tool.capabilityId || tool.source + ":" + tool.sourceId + ":" + tool.name,
        domain: domainOf(tool),
        intents: intentKeys(tool),
        appId: tool.appId,
        requiredContext: tool.requiredContext,
      }),
    };
  });
}

/** 源 toolResolver.ts:52-57。 */
function buildExecutors(descriptors) {
  return Object.fromEntries(descriptors.map((tool) => [tool.name, {
    type: tool.handler && tool.handler.type,
    source: tool.source,
    sourceId: tool.sourceId,
    toolName: tool.handler && tool.handler.toolName,
  }]));
}

/**
 * 源 toolResolver.ts:28-59 + T2 权限层。
 * 返回 { descriptors, openaiTools, executors, denied }：denied 为结构化拒绝清单（不静默丢弃）。
 */
function resolveTools(request, options) {
  const req = request && typeof request === "object" ? request : {};
  const candidates = collectToolDescriptors(req, options);
  const descriptors = [];
  const denied = [];
  for (const tool of candidates) {
    const permission = resolveToolPermission(tool, req.actor, options);
    if (permission.allowed) descriptors.push(tool);
    else denied.push({
      name: tool.name, source: tool.source, sourceId: tool.sourceId,
      code: permission.code, message: permission.message, permission: permission.permission,
    });
  }
  return { descriptors, openaiTools: buildOpenAiTools(descriptors), executors: buildExecutors(descriptors), denied };
}

/** 源 toolResolver.ts:61-69。 */
function resolveReactTools(actor, options) {
  return resolveTools({
    intent: "project.agent",
    actor,
    requestedSources: [...DEFAULT_AGENT_SOURCES],
    executableOnly: true,
    includeRisk: ["read", "write", "delete", "external"],
  }, options);
}

/**
 * T2 按名解析：命中 -> { ok:true, descriptor, openaiTool, executor, permission }；
 * 未命中 -> not_found；权限不通过 -> permission_denied / auth_unavailable；目录不可用 -> catalog_unavailable。
 */
function resolveToolByName(name, request, options) {
  const toolName = String(name === undefined || name === null ? "" : name).trim();
  if (!toolName) return resolverFailure("invalid_request", "工具名不能为空");
  const req = request && typeof request === "object" ? request : {};
  let candidates;
  try {
    candidates = collectToolDescriptors(req, options);
  } catch (error) {
    return resolverFailureFrom(error);
  }
  const descriptor = candidates.find((tool) => tool.name === toolName);
  if (!descriptor) return resolverFailure("not_found", "未知工具：" + toolName);
  const permission = resolveToolPermission(descriptor, req.actor, options);
  if (!permission.allowed) {
    return resolverFailure(permission.code, permission.message, { toolName, permission: permission.permission, permissions: permission.permissions });
  }
  return {
    ok: true,
    descriptor,
    openaiTool: buildOpenAiTools([descriptor])[0],
    executor: buildExecutors([descriptor])[toolName],
    permission,
  };
}

/** T2 按来源解析：等价于 resolveTools({ requestedSources: [source] })。 */
function resolveToolsBySource(source, request, options) {
  const sourceId = String(source === undefined || source === null ? "" : source).trim();
  if (!sourceId) return resolverFailure("invalid_request", "来源不能为空");
  const req = { ...(request && typeof request === "object" ? request : {}), requestedSources: [sourceId] };
  try {
    return { ok: true, source: sourceId, ...resolveTools(req, options) };
  } catch (error) {
    return resolverFailureFrom(error);
  }
}

module.exports = {
  ToolResolverError,
  TOOL_RESOLVER_ERROR_CODES,
  toResolverErrorPayload,
  resolverFailure,
  configureToolResolver,
  resetToolResolverForTests,
  toolResolverDeps,
  DEFAULT_AGENT_SOURCES,
  loadCatalog,
  catalogSnapshot,
  loadAuth,
  resolveToolPermission,
  assertToolPermission,
  allowedRisk,
  domainOf,
  intentKeys,
  collectToolDescriptors,
  buildOpenAiTools,
  buildExecutors,
  resolveTools,
  resolveReactTools,
  resolveToolByName,
  resolveToolsBySource,
};

