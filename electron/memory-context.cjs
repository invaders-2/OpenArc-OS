/**
 * D4-05 S4 · A36 · MemoryContext —— 受控记忆装配（无缓存，每次重新检索 + 重新授权）。
 *
 * 永久边界：
 *   · 只在**任务上下文装配**时读取 memory，绝不写入任何持久层（无 memory 写入、无 context 持久化）；
 *   · 每次 assemble 都重新 validateSession → 重新授权检索 → 逐条 getCapabilities → readText；
 *   · 任何一步失败一律 fail-closed（不注入、不抛），绝不把“未授权/已删/他人”内容交给 Harness；
 *   · 只做有界读取与脱敏，正文绝不进入审计 / 日志 / DB。
 *
 * 本文档不是第二套权限系统：所有判定都委托 IdentityStore / AuthorizationService /
 * SearchService / ResourceService / TaskService。hooks.afterSearch 是 **test-only** 同步点，
 * production 默认 null，绝不改变装配结果。
 */
"use strict";

const MEMORY_CONTEXT_REASON = Object.freeze({
  SESSION_INVALID: "MEMORY_SESSION_INVALID",
  TASK_FORBIDDEN: "MEMORY_TASK_FORBIDDEN",
});

/** 有界装配：条数 / 单条字符 / 总量 / 单次读取字节。 */
const DEFAULT_LIMITS = Object.freeze({
  maxItems: 5,
  maxItemChars: 1200,
  maxTotalChars: 4000,
  maxReadBytes: 64 * 1024,
});

// 与仓库既有 gate（task-service.sanitizeEvidenceValue / d4-05-smoke SECRET_RE）保持一致的脱敏形态。
const SENSITIVE_PATH_RE = /\/Users\/[^\s"']*|\/private\/[^\s"']*|\/var\/folders\/[^\s"']*/g;
const CAPABILITY_RE = /mpx_[A-Za-z0-9_-]+|tpx_[A-Za-z0-9_-]+/g;
const CREDENTIAL_RE = /credential[^\s"',}\]]*/gi;

function sanitizeMemoryText(text) {
  return String(text == null ? "" : text)
    .replace(SENSITIVE_PATH_RE, "[REDACTED_PATH]")
    .replace(CAPABILITY_RE, "[REDACTED_CAPABILITY]")
    .replace(CREDENTIAL_RE, "[REDACTED_CREDENTIAL]");
}

class MemoryContext {
  constructor({ searchService, resourceService, taskService, authService, identity, clock = null, logger = null, limits = null, hooks = null } = {}) {
    if (!searchService) throw new Error("MemoryContext 需要 SearchService");
    if (!resourceService) throw new Error("MemoryContext 需要 ResourceService");
    if (!taskService) throw new Error("MemoryContext 需要 TaskService");
    if (!authService) throw new Error("MemoryContext 需要 AuthorizationService");
    if (!identity) throw new Error("MemoryContext 需要 IdentityStore");
    this.searchService = searchService;
    this.resourceService = resourceService;
    this.taskService = taskService;
    this.authService = authService;
    this.identity = identity;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger;
    this.limits = Object.assign({}, DEFAULT_LIMITS, limits || {});
    this.hooks = Object.assign({ afterSearch: null }, hooks || {});
  }

  /** 只读 safe 审计：count / refs(ref+version) / reason，绝不含正文。 */
  #audit(result, count, refs, reason) {
    try {
      this.logger?.log?.({ event: "memory-context", result, count, refs, reason: reason || null });
    } catch {
      /* audit 失败绝不改变装配结果 */
    }
  }

  async assemble({ context, taskId, goal = null } = {}) {
    const limits = this.limits;
    const empty = (result, reason) => ({ ok: result === "ALLOW", memories: [], reason: reason || null });

    // 1) 每次装配重新校验 sensitive session：失败绝不注入、绝不抛。
    const session = this.identity.validateSession(context && context.sessionRef, { sensitive: true });
    if (!session.ok) {
      this.#audit("DENY", 0, [], MEMORY_CONTEXT_REASON.SESSION_INVALID);
      return { ok: false, reason: MEMORY_CONTEXT_REASON.SESSION_INVALID, memories: [] };
    }

    // 2) task owner/app 由 TaskService 权威判定（绝不信任 Harness 自报 taskId）。
    const loaded = this.taskService.getTask({ context, taskId });
    if (!loaded.ok) {
      this.#audit("DENY", 0, [], MEMORY_CONTEXT_REASON.TASK_FORBIDDEN);
      return { ok: false, reason: MEMORY_CONTEXT_REASON.TASK_FORBIDDEN, memories: [] };
    }
    const query = typeof goal === "string" && goal.trim() ? goal.trim() : String(loaded.task.goal || "");
    if (!query) return empty("ALLOW", null);

    // 3) 授权检索：SearchService 服务端逐批 authorizeMany（agent=true → user 侧 useByAgent）。
    let search = null;
    try {
      search = await this.searchService.search({ context, query, filter: { resourceType: "memory" }, agent: true, limit: limits.maxItems });
    } catch {
      search = null;
    }
    if (!search || !search.ok || !Array.isArray(search.items) || search.items.length === 0) return empty("ALLOW", null);
    const candidates = search.items.slice(0, limits.maxItems);

    // 4) test-only 同步点：production 默认 null。检索已完成、最后检查尚未发生。
    if (typeof this.hooks.afterSearch === "function") {
      await this.hooks.afterSearch({ context, taskId, candidates });
    }

    // 5) 最后检查：每条候选重新 getCapabilities(agent) + readText；任一失败即丢弃
    //    （已删除 / 已撤权 / trash / 读取失败 → 绝不注入）。
    const memories = [];
    let total = 0;
    for (const candidate of candidates) {
      if (memories.length >= limits.maxItems || total >= limits.maxTotalChars) break;
      const caps = this.authService.getCapabilities({ context, resource: candidate.resourceId, agent: true });
      if (!caps || !caps.ok || !caps.capabilities || !caps.capabilities.canRead) continue;
      let read = null;
      try {
        read = await this.resourceService.readText({ context, resourceRef: candidate.resourceRef, maxBytes: limits.maxReadBytes });
      } catch {
        read = null;
      }
      if (!read || !read.ok || typeof read.text !== "string") continue;
      let text = sanitizeMemoryText(read.text).slice(0, limits.maxItemChars);
      const room = limits.maxTotalChars - total;
      if (room <= 0) break;
      if (text.length > room) text = text.slice(0, room);
      total += text.length;
      memories.push({
        resourceId: candidate.resourceId,
        resourceRef: candidate.resourceRef,
        name: sanitizeMemoryText(candidate.name || ""),
        version: candidate.version,
        checksum: candidate.checksum || null,
        text,
      });
    }
    this.#audit("ALLOW", memories.length, memories.map((m) => ({ resourceRef: m.resourceRef, version: m.version })), null);
    return { ok: true, memories, reason: null };
  }
}

module.exports = { MemoryContext, MEMORY_CONTEXT_REASON, DEFAULT_LIMITS, sanitizeMemoryText };
