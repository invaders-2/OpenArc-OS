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
const { safeURL } = require("./policy.cjs");
const { safeUrlForAudit } = require("./browser-control-authority.cjs");

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
function createToolAdapters({ resourceService = null, searchService = null, browserControl = null, extra = {} } = {}) {
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
    /**
     * D4-03C3 · read-only recovery verifier：按历史 SideEffectPlan 重读真实 Resource Domain，
     * 返回三态 APPLIED / NOT_APPLIED / INDETERMINATE。绝不 mutation / execute / retry / restore。
     */
    function trashRecoveryVerify({ preconditions }) {
      const ref = String((preconditions && preconditions.resourceRef) || "");
      const expectedVersion = preconditions && preconditions.expectedVersion != null ? Number(preconditions.expectedVersion) : null;
      if (!ref) return { outcome: "INDETERMINATE", reason: "NO_RESOURCE_REF" };
      if (typeof resourceService.sideEffectPrecondition !== "function") return { outcome: "INDETERMINATE", reason: "VERIFIER_UNAVAILABLE" };
      const cur = resourceService.sideEffectPrecondition({ resourceRef: ref });
      if (!cur || !cur.ok) return { outcome: "INDETERMINATE", reason: "RESOURCE_READ_FAILED", detail: { resourceRef: ref } };
      const currentVersion = Number(cur.expectedVersion);
      const status = String(cur.registryStatus || "");
      if (cur.trashed === true) {
        if (status === "deleted") return { outcome: "APPLIED", reason: "TRASHED_AND_DELETED", detail: { resourceRef: cur.resourceRef, currentVersion } };
        return { outcome: "INDETERMINATE", reason: "TRASHED_BUT_STATUS_INCONSISTENT", detail: { resourceRef: cur.resourceRef, currentVersion, registryStatus: status } };
      }
      if (status === "active" && (expectedVersion == null || currentVersion === expectedVersion)) {
        return { outcome: "NOT_APPLIED", reason: "STILL_ACTIVE_AT_EXPECTED_VERSION", detail: { resourceRef: cur.resourceRef, expectedVersion, currentVersion } };
      }
      return { outcome: "INDETERMINATE", reason: "STATE_OR_VERSION_CHANGED", detail: { resourceRef: cur.resourceRef, expectedVersion, currentVersion, registryStatus: status } };
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
      /** D4-03C3：UNKNOWN_EFFECT read-only recovery verification（三态）。 */
      async recoveryVerify({ call, preconditions }) {
        if (call && call.toolId === "resource.trash") return trashRecoveryVerify({ preconditions });
        return { outcome: "INDETERMINATE", reason: "RECOVERY_VERIFIER_UNAVAILABLE" };
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

  if (browserControl) {
    /**
     * 目标只从**用户已授权的控制目标**里解析；模型给的 viewId 只是"请求"。
     * 缺省 viewId 时：恰好一个已授权目标才可推断，多个必须显式指定（绝不猜）。
     */
    const targetOf = ({ context, args }) => {
      const userId = context && context.actorUserId ? String(context.actorUserId) : "";
      const appId = (context && context.appId) || "ai";
      if (!userId) return { ok: false, error: "BROWSER_CONTROL_FORBIDDEN" };
      const resolved = browserControl.resolveTarget({ userId, appId, viewId: args && args.viewId });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      return { ok: true, userId, appId, viewId: resolved.viewId };
    };
    providers.BrowserControl = {
      toolIds: ["browser.read.page", "browser.navigate"],
      async prepare({ args }) { return { plan: { dryRun: false, provider: "BrowserControl", hasViewId: !!(args && args.viewId) } }; },
      /** 只读 plan：目标 +（导航时）**已校验的地址**一起进 SideEffectPlan，0 mutation。 */
      async plan({ context, args, contract }) {
        const t = targetOf({ context, args });
        if (!t.ok) return null;
        const state = browserControl.inspect({ userId: t.userId, appId: t.appId, viewId: t.viewId });
        if (!state.ok) return null;
        if (contract && contract.toolId === "browser.navigate") {
          const url = typeof (args && args.url) === "string" ? args.url : "";
          if (!safeURL(url)) return null;
          return {
            targets: [t.viewId],
            preconditions: { targetRef: t.viewId, targetType: "browser-tab", url },
            expectedEffects: [{ action: "navigate", target: t.viewId, from: safeUrlForAudit(state.url), to: safeUrlForAudit(url) }],
          };
        }
        return {
          targets: [t.viewId],
          preconditions: { targetRef: t.viewId, targetType: "browser-tab" },
          expectedEffects: [{ action: "readPage", target: t.viewId, from: safeUrlForAudit(state.url) }],
        };
      },
      /**
       * 执行：导航**只用持久化的 trusted plan**（targetRef / url），不读 Harness 入参 ——
       * 批准的目标与地址就是执行的目标与地址；读取的目标同样只从授权表解析。
       */
      async execute({ context, args, contract, preconditions, expectedEffects, callId = null }) {
        const appId = (context && context.appId) || "ai";
        const userId = context && context.actorUserId ? String(context.actorUserId) : "";
        if (!userId) return { ok: false, knownNoEffect: true, error: "BROWSER_CONTROL_FORBIDDEN" };
        if (contract && contract.toolId === "browser.navigate") {
          const viewId = preconditions && preconditions.targetRef;
          const url = preconditions && preconditions.url;
          if (!viewId || typeof url !== "string") return { ok: false, knownNoEffect: true, error: "BROWSER_CONTROL_TARGET_GONE" };
          // 执行入参必须与 plan 自己的效果副本自洽；不自洽 = plan 被改过 → 明确拒绝，0 派发。
          const planTo = Array.isArray(expectedEffects) && expectedEffects[0] && typeof expectedEffects[0].to === "string" ? expectedEffects[0].to : null;
          if (planTo != null && planTo !== safeUrlForAudit(url)) return { ok: false, knownNoEffect: true, error: "BROWSER_CONTROL_PRECONDITION_CHANGED" };
          const res = await browserControl.navigate({ userId, appId, viewId, url, callId });
          // 三态严格映射：
          //   NOT_APPLIED → 能证明这次没生效（FAILED，0 重试）；
          //   其余已派发但不可知（超时 / 视图消失 / 被别人的导航顶掉）→ UNKNOWN_EFFECT，绝不猜成 FAILED。
          if (!res.ok) {
            if (res.notApplied) return { ok: false, knownNoEffect: true, error: res.error, detail: res.detail || null };
            return res.dispatched ? { ok: false, ambiguous: true, error: res.error, detail: res.detail || null } : { ok: false, knownNoEffect: true, error: res.error };
          }
          return { ok: true, result: { viewId: res.viewId, url: res.url, ok: true, requested: res.requested, redirected: !!res.redirected, noop: !!res.noop, dispatchSeq: res.dispatchSeq == null ? null : Number(res.dispatchSeq) } };
        }
        const resolved = browserControl.resolveTarget({ userId, appId, viewId: (preconditions && preconditions.targetRef) || (args && args.viewId) });
        if (!resolved.ok) return { ok: false, error: resolved.error };
        const page = await browserControl.readPage({ userId, appId, viewId: resolved.viewId });
        if (!page.ok) return { ok: false, error: page.error };
        // 正文原样交给调用方，并**显式标注 untrusted**：它永远不是指令，也不进审计。
        return { ok: true, result: { viewId: page.viewId, url: page.url, title: page.title, text: page.text, truncated: page.truncated, untrusted: true } };
      },
      /**
       * UNKNOWN_EFFECT 的**只读**恢复核查（三态，绝不 mutation / retry）：
       * 只有"这次派发的加载真的完成"（loadURL promise resolve）才升级为 APPLIED；
       * 无证据（冷启动 / 记录被挤掉）或只被中止 → INDETERMINATE —— 绝不拿"当前 URL 相等"顶替证据。
       */
      async recoveryVerify({ call, preconditions }) {
        const viewId = preconditions && preconditions.targetRef;
        const approved = preconditions && typeof preconditions.url === "string" ? preconditions.url : null;
        // **只认这次执行自己的派发**：绝不拿"该标签最近一次导航"（可能是用户自己点的）来顶替证据。
        const bound = browserControl.callDispatchSeq && call ? browserControl.callDispatchSeq(call.callId) : null;
        if (!bound) return { outcome: "INDETERMINATE", reason: "NO_DISPATCH_BINDING", detail: { callId: (call && call.callId) || null, viewId: viewId || null } };
        const ev = browserControl.dispatchEvidence ? browserControl.dispatchEvidence({ viewId: bound.viewId, seq: bound.seq }) : null;
        if (!ev) return { outcome: "INDETERMINATE", reason: "NO_DISPATCH_EVIDENCE", detail: { viewId: viewId || null } };
        if (ev.loaded && ev.loaded.url) {
          const appliedUrl = String(ev.loaded.url);
          return {
            outcome: "APPLIED",
            reason: appliedUrl === String(ev.requested) ? "OUR_DISPATCH_LOADED" : "OUR_DISPATCH_LOADED_REDIRECTED",
            detail: { seq: ev.seq, requested: safeUrlForAudit(ev.requested), approved: safeUrlForAudit(approved || ""), appliedUrl: safeUrlForAudit(appliedUrl) },
          };
        }
        return { outcome: "INDETERMINATE", reason: ev.loadError ? "DISPATCH_ABORTED" : "DISPATCH_UNSETTLED", detail: { seq: ev.seq, loadError: ev.loadError || null } };
      },
      /** 导航 = 派发证据 + READ_AFTER_WRITE；读取 = 结果形态 + 目标归属。 */
      async verify({ context, result, contract }) {
        const appId = (context && context.appId) || "ai";
        const userId = context && context.actorUserId ? String(context.actorUserId) : "";
        if (!userId) return { ok: false, detail: { reason: "NO_ACTOR" } };
        if (contract && contract.toolId === "browser.navigate") {
          // 归因只认**这次派发**的证据：绝不因为"当前 URL 恰好等于目标"就把别人的导航算成本次成功。
          const ev = browserControl.dispatchEvidence ? browserControl.dispatchEvidence({ viewId: result && result.viewId, seq: result && result.dispatchSeq }) : null;
          if (!ev) return { ok: false, detail: { reason: "NO_DISPATCH_EVIDENCE" } };
          if (result && result.dispatchSeq != null && Number(ev.seq) !== Number(result.dispatchSeq)) return { ok: false, detail: { reason: "DISPATCH_MISMATCH", expected: result.dispatchSeq, observed: ev.seq } };
          const appliedUrl = ev.loaded ? String(ev.loaded.url || "") : null;
          const applied = !!appliedUrl && appliedUrl === String((result && result.url) || "");
          const now = browserControl.inspect({ userId, appId, viewId: result && result.viewId });
          if (!applied) return { ok: true, applied: false, confidence: "KNOWN_NO_EFFECT", detail: { seq: ev.seq, loadError: ev.loadError || null, appliedUrl: safeUrlForAudit(appliedUrl || ""), observedUrl: now.ok ? safeUrlForAudit(now.url) : null } };
          return {
            ok: true, applied: true,
            detail: {
              seq: ev.seq, appliedUrl: safeUrlForAudit(appliedUrl), expectedUrl: safeUrlForAudit(result && result.url),
              redirected: !!(result && result.redirected), superseded: !!ev.superseded,
              // 之后用户又导航走了也不会改变这条结论：写确实生效过，只是页面已经不在那里。
              observedUrl: now.ok ? safeUrlForAudit(now.url) : null, stillThere: !!(now.ok && String(now.url) === appliedUrl),
            },
          };
        }
        const okShape = !!(result && typeof result.viewId === "string" && typeof result.url === "string" && typeof result.text === "string" && typeof result.truncated === "boolean" && result.untrusted === true);
        return { ok: okShape, detail: { viewId: result && result.viewId, textLength: result && typeof result.text === "string" ? result.text.length : 0, untrusted: !!(result && result.untrusted) } };
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
