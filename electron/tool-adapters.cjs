/**
 * D4-03B · Tool Adapters（静态 allowlist）。
 *
 * 只通过 Registry 的 executionProvider 映射到这里的受信任 adapter；
 * **禁止动态 require / import(arguments.path) / eval / new Function**。
 * Adapter 只能调用既有 Domain（ResourceService / SearchService），绝不直接 SQL。
 *
 * 接口：prepare(context, args) / execute(context, args, signal) / verify(context, args, result)。
 */
"use strict";
const domain = require("./tool-domain.cjs");

const MAX_SEARCH_LIMIT = 20;
const MAX_STRING = 200;
const SAFE_METADATA_FIELDS = ["resourceRef", "name", "resourceType", "mimeType", "version", "updatedAt", "size", "scope"];
const SEARCH_ITEM_FIELDS = ["resourceRef", "name", "resourceType", "mimeType", "version", "snippet"];

function clip(value, max = MAX_STRING) {
  if (typeof value !== "string") return value;
  return value.length > max ? value.slice(0, max) + "…" : value;
}
/** 只保留 allowlist 字段；null/undefined 省略；字符串 bounded。 */
function projectFields(source, fields, { maxString = MAX_STRING } = {}) {
  const out = {};
  for (const key of fields) {
    const v = source == null ? undefined : source[key];
    if (v === undefined || v === null) continue;
    out[key] = typeof v === "string" ? clip(v, maxString) : v;
  }
  return out;
}

/** 静态 allowlist：provider → adapter（绝不从 arguments 解析 module/path）。*/
function createToolAdapters({ resourceService = null, searchService = null, extra = {} } = {}) {
  const providers = {};

  providers.test = {
    toolIds: ["test.echo", "test.write", "test.noverify"],
    async prepare() { return { plan: { dryRun: false, provider: "test" } }; },
    /** D4-03C1：side-effect 只读 plan，生成 targets/preconditions/expectedEffects；mutation = 0。 */
    async plan({ args }) {
      const target = clip(String((args && args.target) || ""), 100);
      return {
        targets: [target],
        preconditions: { targetRef: target, targetType: "test-target" },
        expectedEffects: [{ action: "update", target, description: "Update test target '" + target + "'" }],
      };
    },
    async execute({ args }) { return { ok: true, result: { echo: clip(String((args && args.message) || ""), MAX_STRING) } }; },
    async verify({ result }) { return { ok: !!(result && typeof result.echo === "string"), detail: { echoLength: result && result.echo ? result.echo.length : 0 } }; },
  };

  if (resourceService) {
    /** D4-03C2：resource.trash 的只读 precondition 快照（真实 Domain state；0 mutation）。 */
    function trashPlan(args) {
      const ref = String((args && args.resourceRef) || "");
      if (typeof resourceService.sideEffectPrecondition !== "function") return null;
      const pre = resourceService.sideEffectPrecondition({ resourceRef: ref });
      if (!pre || !pre.ok) return null;
      if (pre.trashed === true) return null;
      return {
        targets: [pre.resourceRef],
        preconditions: { resourceRef: pre.resourceRef, expectedVersion: pre.expectedVersion, registryStatus: pre.registryStatus },
        expectedEffects: [{ action: "trash", resourceRef: pre.resourceRef, expectedVersion: pre.expectedVersion, trashed: true }],
      };
    }
    /** 真实业务 Domain 写入；expectedVersion 只来自 SideEffectPlan（preconditions），不是 Harness payload。 */
    async function trashExecute({ context, args, preconditions }) {
      if (typeof resourceService.delete !== "function") return { ok: false, knownNoEffect: true, error: "TOOL_EXECUTION_FAILED" };
      const expectedVersion = preconditions && preconditions.expectedVersion != null ? Number(preconditions.expectedVersion) : null;
      let res;
      try {
        res = await resourceService.delete({ context, resourceRef: String(args.resourceRef), expectedVersion });
      } catch {
        // Domain 结果无法可靠确认 → 交给 authority 进入 UNKNOWN_EFFECT，绝不猜 FAILED 后 retry。
        return { ok: false, ambiguous: true, error: "SIDE_EFFECT_UNKNOWN_EFFECT" };
      }
      if (!res || !res.ok) {
        const err = (res && res.error) || "RESOURCE_DELETE_FAILED";
        const knownNoEffect = ["VERSION_CONFLICT", "RESOURCE_TRASHED", "NOT_FOUND_OR_FORBIDDEN", "INVALID_INPUT"].includes(String(err));
        return { ok: false, knownNoEffect, error: err === "VERSION_CONFLICT" ? "SIDE_EFFECT_PRECONDITION_CHANGED" : err };
      }
      return { ok: true, result: { resourceRef: String(args.resourceRef), trashed: true, version: res.resource ? res.resource.version : undefined, changed: !!res.changed } };
    }
    /** 真实 Domain verifier：重新读取 Resource Domain，只有 truly trashed 才算 PASS。 */
    async function trashVerify({ args, result }) {
      const ref = String((args && args.resourceRef) || (result && result.resourceRef) || "");
      if (typeof resourceService.sideEffectPrecondition !== "function") return { ok: false, detail: { reason: "VERIFIER_UNAVAILABLE" } };
      const pre = resourceService.sideEffectPrecondition({ resourceRef: ref });
      if (!pre || !pre.ok) return { ok: false, detail: { reason: "VERIFIER_UNAVAILABLE" } };
      if (pre.trashed === true) return { ok: true, applied: true, detail: { resourceRef: pre.resourceRef, trashed: true } };
      return { ok: true, applied: false, confidence: "KNOWN_NO_EFFECT", detail: { resourceRef: pre.resourceRef, trashed: false } };
    }
    providers.ResourceService = {
      toolIds: ["resource.read.metadata", "resource.trash"],
      async prepare({ args }) { return { plan: { provider: "ResourceService", resourceRefs: [String(args.resourceRef)] } }; },
      async plan({ args, contract }) {
        if (contract && contract.toolId === "resource.trash") return trashPlan(args);
        const ref = String((args && args.resourceRef) || "");
        return { targets: [ref], preconditions: { resourceRef: ref, targetType: "resource" }, expectedEffects: [{ action: "readMetadata", resourceRef: ref }] };
      },
      async execute({ context, args, contract, preconditions }) {
        if (contract && contract.toolId === "resource.trash") return trashExecute({ context, args, preconditions });
        if (typeof resourceService.get !== "function") return { ok: false, error: "TOOL_EXECUTION_FAILED" };
        const res = await resourceService.get({ context, resourceRef: String(args.resourceRef) });
        if (!res || !res.ok) return { ok: false, error: (res && res.error) || "RESOURCE_NOT_AVAILABLE" };
        const d = res.resource || {};
        return { ok: true, result: projectFields({ resourceRef: d.resourceRef, name: d.name, resourceType: d.resourceType, mimeType: d.mimeType, version: d.version, updatedAt: d.updatedAt, size: d.size, scope: d.scope }, SAFE_METADATA_FIELDS) };
      },
      async verify({ args, result, contract }) {
        if (contract && contract.toolId === "resource.trash") return trashVerify({ args, result });
        return { ok: !!(result && result.resourceRef && result.resourceRef === String(args.resourceRef)), detail: { resourceRefMatches: !!(result && result.resourceRef === String(args.resourceRef)) } };
      },
    };
  }

  if (searchService) {
    providers.SearchService = {
      toolIds: ["resource.search"],
      async prepare({ args }) { return { plan: { provider: "SearchService", query: clip(String(args.query), MAX_STRING) } }; },
      async execute({ context, args }) {
        if (typeof searchService.search !== "function") return { ok: false, error: "TOOL_EXECUTION_FAILED" };
        const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Number(args.limit) || 5));
        const filter = args.kind ? { resourceType: clip(String(args.kind), 40) } : {};
        const res = await searchService.search({ context, query: clip(String(args.query), MAX_STRING), filter, agent: true, limit });
        if (!res || !res.ok) return { ok: false, error: (res && res.error) || "TOOL_EXECUTION_FAILED" };
        const items = (res.items || []).slice(0, limit).map((it) => projectFields({ resourceRef: it.resourceRef, name: it.name, resourceType: it.resourceType, mimeType: it.mimeType, version: it.version, snippet: it.snippet && typeof it.snippet === "object" ? it.snippet.text : it.snippet }, SEARCH_ITEM_FIELDS, { maxString: 160 }));
        const total = Number(res.total || items.length);
        return { ok: true, result: { items, count: total, truncated: !!res.hasMore || total > items.length, maxLimit: MAX_SEARCH_LIMIT } };
      },
      async verify({ args, result }) {
        if (!result || !Array.isArray(result.items)) return { ok: false, detail: { reason: "NO_ITEMS" } };
        return { ok: result.items.every((it) => it && typeof it.resourceRef === "string") && result.maxLimit === MAX_SEARCH_LIMIT && result.count >= result.items.length, detail: { count: result.count, items: result.items.length } };
      },
    };
  }

  Object.assign(providers, extra);
  /** provider 必须声明 toolIds；providerFor 只按 executionProvider + static allowlist 解析。*/
  function adapterFor({ executionProvider, toolId }) {
    const provider = providers[String(executionProvider)];
    if (!provider) return null;
    if (!Array.isArray(provider.toolIds) || !provider.toolIds.includes(String(toolId))) return null;
    return provider;
  }
  return { providers, adapterFor, MAX_SEARCH_LIMIT };
}

module.exports = { createToolAdapters, projectFields, MAX_SEARCH_LIMIT, SAFE_METADATA_FIELDS, SEARCH_ITEM_FIELDS };
