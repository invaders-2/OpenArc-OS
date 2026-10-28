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
// D5-02：画布命令的**同一份**校验/归一化（手工路径与 AI 路径共用）。
const canvasDomain = require("./canvas-domain.cjs");
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
function createToolAdapters({ resourceService = null, searchService = null, browserControl = null, canvasService = null, webAccess = null, workspace = null, agentMemory = null, extra = {} } = {}) {
  const providers = {};
  // 全局 AI 工作文件夹（第 2 期）：读 / 列 / 搜只读，写文件和运行命令走 SideEffectAuthority。
  if (workspace) providers.Workspace = require("./agent-workspace.cjs").createWorkspaceProvider({ workspace });
  // 全局 AI 长期记忆（第 3 期）：memory_save 只排队，本轮成功后由 orchestrator 写入；memory_search 只读。
  if (agentMemory) providers.AgentMemory = require("./agent-memory.cjs").createAgentMemoryProvider({ memory: agentMemory });

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

  if (resourceService) {
    /**
     * 10-16 · 素材库 AI：读正文 + 文本写回。
     * 单独一个 provider（与 ResourceService 分开），因为只读路径的 execute 不带 contract，
     * 不能靠 contract.toolId 区分"读元数据"和"读正文"。
     */
    const TEXT_MIMES = ["application/json", "application/xml", "application/javascript", "application/x-yaml", "application/yaml", "application/toml", "application/x-sh", "application/sql", "application/x-ndjson", "image/svg+xml"];
    const isTextMime = (mime) => { const m = String(mime || "").toLowerCase().split(";")[0].trim(); return m.startsWith("text/") || TEXT_MIMES.includes(m); };
    const idOf = (ref) => String(ref || "").replace(/^resource:\/\//, "");
    const sha256 = (text) => require("node:crypto").createHash("sha256").update(String(text), "utf8").digest("hex");
    const MAX_SAVE_NAME = 120;
    const saveName = (name) => {
      const base = String(name || "").replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, MAX_SAVE_NAME) || "AI 生成";
      return /\.[A-Za-z0-9]{1,8}$/.test(base) ? base : base + ".md";
    };
    providers.ResourceContent = {
      toolIds: ["resource.read.content", "resource.save.text"],
      async prepare({ args }) {
        if (args && typeof args.resourceRef === "string") return { plan: { provider: "ResourceContent", resourceRefs: [String(args.resourceRef)] } };
        return { plan: { provider: "ResourceContent", resourceRefs: [] } };
      },
      /** 只读 plan（只有写回会走到这里）：0 mutation。目标是"新资源"，用内容哈希 + 名字描述。 */
      async plan({ args, contract }) {
        if (!contract || contract.toolId !== "resource.save.text") {
          const ref = String((args && args.resourceRef) || "");
          return { targets: [ref], preconditions: { resourceRef: ref, targetType: "resource" }, expectedEffects: [{ action: "readContent", resourceRef: ref }] };
        }
        const content = typeof (args && args.content) === "string" ? args.content : "";
        if (!content) return null;
        const name = saveName(args.name);
        const contentSha256 = sha256(content);
        const description = typeof args.description === "string" ? args.description.slice(0, 500) : "";
        return {
          targets: ["library:new:" + contentSha256.slice(0, 16)],
          // 正文随 plan 持久化（执行时 authority 只给 preconditions，不给 Harness 入参）。
          preconditions: { targetType: "resource-create", name, contentSha256, bytes: Buffer.byteLength(content, "utf8"), content, ...(description ? { description } : {}) },
          expectedEffects: [{ action: "create", resourceType: "text", name, bytes: Buffer.byteLength(content, "utf8") }],
        };
      },
      async execute({ context, args, contract, preconditions, callId }) {
        if (contract && contract.toolId === "resource.save.text") {
          if (typeof resourceService.importText !== "function") return { ok: false, knownNoEffect: true, error: "TOOL_EXECUTION_FAILED" };
          // 只用审批时持久化的正文；缺失或与哈希不符 → 已知无效果，不写入。
          const content = preconditions && typeof preconditions.content === "string" ? preconditions.content : "";
          if (!content || !preconditions.contentSha256 || preconditions.contentSha256 !== sha256(content)) return { ok: false, knownNoEffect: true, error: "SIDE_EFFECT_PRECONDITION_CHANGED" };
          // 幂等：同一 callId 已经写过就复用，绝不产生第二份。
          if (callId && typeof resourceService.generatedByCall === "function") {
            const prior = resourceService.generatedByCall({ callId });
            if (prior && prior.ok && prior.found && !prior.trashed) return { ok: true, result: { resourceRef: prior.resourceRef, name: prior.name, version: prior.version, size: prior.size, reused: true } };
          }
          let res;
          try {
            res = await resourceService.importText({
              // 以「资源库」App 身份入库：AI App 的 Resource baseline 只有读，写回的能力边界是
              // tool.resource.saveText（管理员显式授予）+ 本次审批 + 用户本人的 create 授权（authorizeCreate 照常裁决），
              // 不给 AI App 通用的 resource.create。
              context: { ...context, appId: "resource-library" },
              text: content, name: saveName(preconditions.name),
              description: typeof preconditions.description === "string" ? preconditions.description : "",
              resourceType: "text", source: "generated",
              generated: { taskId: (context && context.taskId) || null, callId: callId || null, model: null },
            });
          } catch {
            return { ok: false, ambiguous: true, error: "SIDE_EFFECT_UNKNOWN_EFFECT" };
          }
          if (!res || !res.ok) {
            const err = String((res && res.error) || "RESOURCE_CREATE_FAILED");
            return { ok: false, knownNoEffect: true, error: err };
          }
          const d = res.resource || {};
          return { ok: true, result: { resourceRef: String(d.resourceRef), name: String(d.name || ""), version: Number(d.version || 1), size: Number(d.size || 0), reused: false } };
        }
        // —— 只读：读正文 ——
        if (typeof resourceService.get !== "function") return { ok: false, error: "TOOL_EXECUTION_FAILED" };
        const ref = String(args.resourceRef);
        const meta = await resourceService.get({ context, resourceRef: ref });
        if (!meta || !meta.ok) return { ok: false, error: (meta && meta.error) || "RESOURCE_NOT_AVAILABLE" };
        const d = meta.resource || {};
        const base = { resourceRef: String(d.resourceRef || ref), name: clip(String(d.name || ""), 200), mimeType: String(d.mimeType || "") };
        if (d.size != null) base.size = Number(d.size);
        const mime = String(d.mimeType || "").toLowerCase();
        if (isTextMime(mime) || ["text", "memory", "prompt", "code"].includes(String(d.resourceType || ""))) {
          const maxChars = Math.min(32000, Math.max(200, Number(args.maxChars) || 32000));
          const r = typeof resourceService.readTextBounded === "function" ? await resourceService.readTextBounded({ context, resourceRef: ref, maxBytes: maxChars * 3 }) : null;
          if (!r || !r.ok) return { ok: false, error: (r && r.error) || "RESOURCE_NOT_AVAILABLE" };
          const full = String(r.text || "");
          const text = full.length > maxChars ? full.slice(0, maxChars) : full;
          return { ok: true, result: { ...base, contentKind: "text", text, truncated: !!r.truncated || full.length > maxChars } };
        }
        if (mime.startsWith("image/") || String(d.resourceType || "") === "image") {
          return { ok: true, result: { ...base, contentKind: "image", canvasUrl: "openarc-asset:" + idOf(d.resourceRef || ref), note: "图片不返回字节；在画布里引用请用 canvas_edit 的 node.add，节点 type 为 image、url 为 canvasUrl。" } };
        }
        const kind = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "binary";
        return { ok: true, result: { ...base, contentKind: kind, note: "该类型没有可读文本正文。" } };
      },
      async verify({ args, result, contract, callId }) {
        if (contract && contract.toolId === "resource.save.text") {
          // 真实 Domain 复读：资源存在、未进废纸篓、名字一致才算写入成功。
          const ref = String((result && result.resourceRef) || "");
          if (!ref || typeof resourceService.sideEffectPrecondition !== "function") return { ok: false, detail: { reason: "VERIFIER_UNAVAILABLE" } };
          const pre = resourceService.sideEffectPrecondition({ resourceRef: ref });
          if (!pre || !pre.ok) return { ok: false, detail: { reason: "VERIFIER_UNAVAILABLE" } };
          if (pre.trashed === true) return { ok: true, applied: false, confidence: "KNOWN_NO_EFFECT", detail: { resourceRef: ref, trashed: true } };
          return { ok: true, applied: true, detail: { resourceRef: pre.resourceRef, version: pre.expectedVersion } };
        }
        const ok = !!(result && result.resourceRef === String(args.resourceRef) && typeof result.contentKind === "string");
        return { ok, detail: { resourceRefMatches: ok } };
      },
      /** UNKNOWN_EFFECT 恢复核验：按 callId 找这次写回产生的资源（三态）。 */
      async recoveryVerify({ call }) {
        if (!call || call.toolId !== "resource.save.text") return { outcome: "INDETERMINATE", reason: "RECOVERY_VERIFIER_UNAVAILABLE" };
        if (typeof resourceService.generatedByCall !== "function") return { outcome: "INDETERMINATE", reason: "VERIFIER_UNAVAILABLE" };
        const got = resourceService.generatedByCall({ callId: call.callId });
        if (!got || !got.ok) return { outcome: "INDETERMINATE", reason: "RESOURCE_READ_FAILED" };
        if (got.found) return { outcome: "APPLIED", reason: "GENERATED_RESOURCE_PRESENT", detail: { resourceRef: got.resourceRef, trashed: !!got.trashed } };
        return { outcome: "NOT_APPLIED", reason: "NO_RESOURCE_FOR_CALL" };
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

  if (webAccess) {
    // 联网（只读）：web.search / web.fetch。正文 / 摘要原样交给调用方并标注 untrusted。
    providers.WebAccess = {
      toolIds: ["web.search", "web.fetch"],
      async prepare({ args }) { return { plan: { dryRun: false, provider: "WebAccess", hasUrl: !!(args && args.url) } }; },
      async execute({ args, contract, signal }) {
        const toolId = contract && contract.toolId;
        const res = toolId === "web.fetch" || (!toolId && args && args.url)
          ? await webAccess.fetch({ url: args && args.url, maxChars: args && args.maxChars, signal })
          : await webAccess.search({ query: args && args.query, limit: args && args.limit, signal });
        if (!res || !res.ok) return { ok: false, error: (res && res.error) || "WEB_UNAVAILABLE" };
        return { ok: true, result: res.result };
      },
      async verify({ result }) {
        if (!result) return { ok: false, detail: { reason: "NO_RESULT" } };
        if (Array.isArray(result.results)) return { ok: result.results.every((r) => r && typeof r.url === "string"), detail: { results: result.results.length } };
        return { ok: typeof result.text === "string", detail: { chars: typeof result.text === "string" ? result.text.length : 0, truncated: !!result.truncated } };
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

  if (canvasService) {
    /** 只读项目：目标画布必须属于当前账号（或已共享给它 / 组织可见）。*/
    function canvasTarget({ context, args }) {
      const actorUserId = context && context.actorUserId ? String(context.actorUserId) : "";
      if (!actorUserId) return { ok: false, error: "CANVAS_FORBIDDEN" };
      const canvasId = String((args && args.canvasId) || "");
      if (!canvasId) return { ok: false, error: "INVALID_INPUT" };
      return { ok: true, actorUserId, canvasId };
    }
    function canvasActor(context) {
      return context && context.actorUserId ? String(context.actorUserId) : "";
    }
    /** task-71：无 canvasId 时优先最近可编辑画布；没有则由执行端新建。 */
    function pickEditableCanvas(context) {
      const listed = canvasService.listCanvases({ context });
      if (!listed || !listed.ok) return null;
      return (listed.canvases || listed.items || []).find((entry) => entry && entry.access && entry.access.canEdit) || null;
    }
    providers.CanvasControl = {
      toolIds: ["canvas.read", "canvas.edit", "canvas.list", "canvas.generate.image"],
      async prepare({ args }) { return { plan: { dryRun: false, provider: "CanvasControl", hasCanvasId: !!(args && args.canvasId) } }; },
      /**
       * 只读 plan：目标画布 + **基准 revision** 与命令指纹一起进 SideEffectPlan（0 mutation）。
       * 批准后执行的就是这份 plan 里的 revision —— 用户在批准与执行之间改了画布，
       * 版本检查会让这次 AI 编辑失败并保留用户内容（A38）。
       */
      async plan({ context, args, contract }) {
        const toolId = contract && contract.toolId;
        if (toolId === "canvas.list") {
          if (!canvasActor(context)) return null;
          return { targets: ["canvas:list"], preconditions: { targetRef: "canvas:list", targetType: "canvas-list" }, expectedEffects: [{ action: "read", target: "canvas:list", from: "list", to: "summary" }] };
        }
        if (toolId === "canvas.generate.image") {
          if (!canvasActor(context)) return null;
          const requested = String((args && args.canvasId) || "");
          let target = requested || null;
          let doc = null;
          if (target) {
            doc = canvasService.getCanvas({ context, canvasId: target });
            if (!doc || !doc.ok || !doc.canvas.access || !doc.canvas.access.canEdit) return null;
          } else {
            const chosen = pickEditableCanvas(context);
            target = chosen ? String(chosen.canvasId) : null;
            if (target) {
              doc = canvasService.getCanvas({ context, canvasId: target });
              if (!doc || !doc.ok || !doc.canvas.access || !doc.canvas.access.canEdit) return null;
            }
          }
          // 没有默认图像模型时不要发起审批；执行端也会返回 MODEL_CONFIG_UNAVAILABLE。
          if (!canvasService.modelService || typeof canvasService.modelService.resolveModel !== "function") return null;
          const resolved = canvasService.modelService.resolveModel({ context: { ...context, appId: "canvas" }, capability: "image-generation" });
          if (!resolved || !resolved.ok) return null;
          const prompt = String((args && args.prompt) || "").slice(0, 4000);
          return {
            targets: [target || "canvas:new"],
            preconditions: {
              targetRef: target || "canvas:new", targetType: "canvas", canvasId: target,
              revision: doc ? Number(doc.canvas.revision) : null,
              prompt, count: Math.max(1, Math.min(4, Number(args && args.count) || 1)),
              size: args && args.size ? String(args.size).slice(0, 32) : null,
              createIfMissing: !target,
              modelConfigId: resolved.snapshot.modelConfigId,
            },
            expectedEffects: [{ action: "image.generate", target: target || "canvas:new", from: "prompt", to: "image-node+resource" }],
          };
        }
        const t = canvasTarget({ context, args });
        if (!t.ok) return null;
        const doc = canvasService.getCanvas({ context: { ...context, sessionRef: context && context.sessionRef }, canvasId: t.canvasId });
        if (!doc || !doc.ok) return null;
        if (contract && contract.toolId === "canvas.read") {
          return { targets: [t.canvasId], preconditions: { targetRef: t.canvasId, targetType: "canvas", revision: doc.canvas.revision }, expectedEffects: [{ action: "read", target: t.canvasId, from: "revision:" + doc.canvas.revision, to: "summary" }] };
        }
        // 写入必须先过**同一条权限规则**（只读成员连"计划一次写入"都不允许）。
        if (!doc.canvas.access || !doc.canvas.access.canEdit) return null;
        const command = args && args.command && typeof args.command === "object" ? args.command : null;
        if (!command || typeof command.type !== "string") return null;
        const normalized = canvasDomain.normalizeCommand(command);
        if (!normalized.ok || !canvasDomain.AGENT_COMMANDS.includes(normalized.command.type)) return null;
        const fp = JSON.stringify(normalized.command).slice(0, 2000);
        return {
          targets: [t.canvasId],
          preconditions: { targetRef: t.canvasId, targetType: "canvas", revision: doc.canvas.revision, commandFingerprint: fp, command: normalized.command },
          expectedEffects: [{ action: normalized.command.type, target: t.canvasId, from: "revision:" + doc.canvas.revision, to: "revision:" + (doc.canvas.revision + 1) }],
        };
      },
      /** 执行**只用持久化的 trusted plan**（revision + 命令），不读 Harness 入参。*/
      async execute({ context, args, contract, preconditions }) {
        const actorUserId = context && context.actorUserId ? String(context.actorUserId) : "";
        if (!actorUserId) return { ok: false, knownNoEffect: true, error: "CANVAS_FORBIDDEN" };
        const toolId = contract && contract.toolId;
        if (toolId === "canvas.list") {
          const listed = canvasService.listCanvases({ context });
          if (!listed || !listed.ok) return { ok: false, knownNoEffect: true, error: listed && listed.error ? listed.error : "CANVAS_UNAVAILABLE" };
          const limit = Math.max(1, Math.min(50, Number(args && args.limit) || 20));
          const canvases = (listed.canvases || listed.items || []).slice(0, limit).map((entry) => ({
            canvasId: entry.canvasId, title: entry.title, revision: entry.revision, updatedAt: entry.updatedAt,
            canEdit: !!(entry.access && entry.access.canEdit), accessSource: entry.access ? entry.access.source || null : null,
          }));
          return { ok: true, result: { canvases, count: canvases.length } };
        }
        if (toolId === "canvas.generate.image") {
          const modelService = canvasService.modelService;
          if (!modelService || typeof modelService.generateImage !== "function") return { ok: false, knownNoEffect: true, error: "CANVAS_MODEL_UNAVAILABLE" };
          const resolved = typeof modelService.resolveModel === "function"
            ? modelService.resolveModel({ context: { ...context, appId: "canvas" }, capability: "image-generation" })
            : null;
          if (!resolved || !resolved.ok) return { ok: false, knownNoEffect: true, error: (resolved && resolved.error) || "MODEL_CONFIG_UNAVAILABLE" };
          let canvasId = String((preconditions && preconditions.canvasId) || (args && args.canvasId) || "");
          if (!canvasId) {
            const chosen = pickEditableCanvas(context);
            canvasId = chosen ? String(chosen.canvasId) : "";
          }
          if (!canvasId) {
            const created = canvasService.createCanvas({ context, title: "AI 生成画布" });
            if (!created || !created.ok) return { ok: false, knownNoEffect: true, error: created && created.error ? created.error : "CANVAS_CREATE_FAILED" };
            canvasId = created.canvas.canvasId;
          }
          const prompt = String((preconditions && preconditions.prompt) || (args && args.prompt) || "").slice(0, 4000);
          if (!prompt) return { ok: false, knownNoEffect: true, error: "INVALID_INPUT" };
          const gen = await modelService.generateImage({
            context: { ...context, appId: "canvas" }, prompt,
            size: (preconditions && preconditions.size) || (args && args.size) || null,
            count: Math.max(1, Math.min(4, Number((preconditions && preconditions.count) || (args && args.count) || 1))),
            capability: "image-generation",
          });
          if (!gen || gen.ok !== true) return { ok: false, knownNoEffect: true, error: (gen && gen.error) || "MODEL_ERROR" };
          const images = Array.isArray(gen.images) ? gen.images : [];
          const first = images.find((image) => image && typeof image.dataUrl === "string" && image.dataUrl.startsWith("data:image/"));
          if (!first) return { ok: false, knownNoEffect: true, error: "IMAGE_ARTIFACT_UNSUPPORTED" };
          const imported = await canvasService.importAsset({ context, canvasId, name: "AI 生成图片", dataUrl: first.dataUrl });
          if (!imported || !imported.ok) return { ok: false, knownNoEffect: true, error: imported && imported.error ? imported.error : "RESOURCE_IMPORT_FAILED" };
          const resourceRef = imported.ref;
          const applied = canvasService.applyCommand({
            context, canvasId,
            command: { type: "node.add", node: { type: "image", url: resourceRef, name: "AI 生成图片", prompt, model: resolved.snapshot ? resolved.snapshot.modelId : null } },
            actorKind: "AGENT",
          });
          if (!applied || !applied.ok) return { ok: false, knownNoEffect: false, error: applied && applied.error ? applied.error : "CANVAS_NODE_ADD_FAILED" };
          const nodeId = applied.touched && applied.touched.nodeIds ? applied.touched.nodeIds[0] : (applied.result && applied.result.node ? applied.result.node.id : null);
          return { ok: true, result: { canvasId, nodeId, resourceRef, revision: applied.canvas.revision, images: images.map((image) => (image.dataUrl ? { dataUrl: image.dataUrl } : { url: image.url })) } };
        }
        const canvasId = preconditions && preconditions.targetRef;
        if (!canvasId) return { ok: false, knownNoEffect: true, error: "CANVAS_TARGET_GONE" };
        if (contract && contract.toolId === "canvas.read") {
          const got = canvasService.readCanvas({ context, canvasId });
          if (!got.ok) return { ok: false, knownNoEffect: true, error: got.error };
          return { ok: true, result: got.summary };
        }
        const command = preconditions && preconditions.command;
        const baseRevision = preconditions && preconditions.revision;
        if (!command || typeof command.type !== "string") return { ok: false, knownNoEffect: true, error: "CANVAS_PRECONDITION_CHANGED" };
        const res = canvasService.applyCommand({ context, canvasId, baseRevision, command, actorKind: "AGENT" });
        if (!res.ok) {
          // 版本冲突 / 只读 / 输入非法 → 都**没有**发生写入（knownNoEffect），绝不重试。
          return { ok: false, knownNoEffect: true, error: res.error, detail: res.detail ? { reason: res.detail } : null };
        }
        return { ok: true, result: { canvasId, revision: res.canvas.revision, commandType: res.command.type, touched: res.touched || null } };
      },
      /** READ_AFTER_WRITE：读回画布，确认 revision 前进且目标节点/连线确实存在（或确实被删）。*/
      async verify({ context, result, preconditions, contract }) {
        const toolId = contract && contract.toolId;
        if (toolId === "canvas.list") return { ok: true, applied: true, detail: { count: result && result.count } };
        const canvasId = (result && result.canvasId) || (preconditions && preconditions.targetRef);
        if (!canvasId || canvasId === "canvas:new") return { ok: false, detail: { reason: "NO_TARGET" } };
        const got = canvasService.getCanvas({ context, canvasId });
        if (!got || !got.ok) return { ok: false, detail: { reason: "READ_BACK_FAILED" } };
        if (toolId === "canvas.generate.image") {
          const nodeId = result && result.nodeId;
          const resourceRef = result && result.resourceRef;
          const node = nodeId && Array.isArray(got.canvas.doc.nodes) ? got.canvas.doc.nodes.find((item) => item.id === nodeId) : null;
          const resourceOk = resourceRef && resourceService && typeof resourceService.get === "function"
            ? (() => { const id = String(resourceRef).replace(/^openarc-asset:/, ""); const r = resourceService.get({ context, resourceRef: id }); return !!(r && r.ok); })()
            : true;
          return { ok: !!(node && resourceOk), applied: !!(node && resourceOk), detail: { nodeId: nodeId || null, nodePresent: !!node, resourceRef: resourceRef || null, resourceOk } };
        }
        if (contract && contract.toolId === "canvas.read") return { ok: true, applied: true, detail: { revision: got.canvas.revision } };
        const revisionOk = Number(got.canvas.revision) > Number(preconditions && preconditions.revision);
        const touched = (result && result.touched) || {};
        const ids = [...(touched.nodeIds || []), ...(touched.edgeIds || [])];
        const present = ids.filter((id) => got.canvas.doc.nodes.some((n) => n.id === id) || got.canvas.doc.connections.some((c) => c.id === id));
        const applied = revisionOk && (touched.removed ? present.length === 0 : present.length === ids.length);
        return { ok: true, applied, detail: { revision: got.canvas.revision, expectedRevision: preconditions && preconditions.revision, touchedCheck: { ids: ids.length, present: present.length, removed: !!touched.removed } } };
      },
      /**
       * UNKNOWN_EFFECT 恢复：只读账本比对。**只认这次计划里的那条命令**，
       * 不拿"revision 变了"当证据（可能是用户自己改的）。
       */
      async recoveryVerify({ context, call, preconditions }) {
        const canvasId = preconditions && preconditions.targetRef;
        if (!canvasId) return { outcome: "INDETERMINATE", reason: "NO_TARGET" };
        const got = canvasService.getCanvas({ context, canvasId });
        if (!got || !got.ok) return { outcome: "INDETERMINATE", reason: "READ_BACK_FAILED" };
        const fp = preconditions && preconditions.commandFingerprint;
        const log = canvasService.commandLog({ context, canvasId, limit: 20 });
        const hit = log && log.ok ? log.items.find((it) => JSON.stringify(it.command) === fp && it.outcome === "APPLIED") : null;
        if (hit) return { outcome: "APPLIED", reason: "COMMAND_IN_JOURNAL", detail: { commandId: hit.id, revision: hit.resultRevision } };
        if (Number(got.canvas.revision) === Number(preconditions && preconditions.revision)) return { outcome: "NOT_APPLIED", reason: "REVISION_UNCHANGED" };
        return { outcome: "INDETERMINATE", reason: "REVISION_MOVED_WITHOUT_OUR_COMMAND", detail: { revision: got.canvas.revision, base: preconditions && preconditions.revision } };
      },
    };
  }

  Object.assign(providers, extra);
  /**
   * provider 必须声明 allowlist：静态 `toolIds` 数组，或动态 `allowsTool(toolId)` 谓词
   * （MCP 外部工具的 toolId 由服务端目录派生，无法在装配期写死）。**只按 executionProvider +
   * static predicate 解析，绝不从 arguments 解析 module/path**。
   */
  function adapterFor({ executionProvider, toolId }) {
    const provider = providers[String(executionProvider)];
    if (!provider) return null;
    if (typeof provider.allowsTool === "function") return provider.allowsTool(String(toolId)) ? provider : null;
    if (!Array.isArray(provider.toolIds) || !provider.toolIds.includes(String(toolId))) return null;
    return provider;
  }
  return { providers, adapterFor, MAX_SEARCH_LIMIT };
}

module.exports = { createToolAdapters, projectFields, MAX_SEARCH_LIMIT, SAFE_METADATA_FIELDS, SEARCH_ITEM_FIELDS };
