/**
 * 单一读模型 · 两套任务表的统一只读投影。
 *
 * ## 边界（硬约束，不因调用方而变）
 *   1. **只读读模型**：本模块只执行 SELECT；**不写任何表**（源码里不出现任何写语句关键词，
 *      也不调用 Statement.run），不 require 任何 store
 *      （task-store.cjs / agent-task-store.cjs / agent-service.cjs 一概不引入）。
 *   2. **不改变任何一方状态机**：不做状态迁移、不写事件、不"顺手"修数据；DX 的 11 态与
 *      core 的 7 态都原样保留在 statusRaw，本模块只额外给出统一语义。
 *   3. 统一状态词汇 = core 的 7 态（PENDING / RUNNING / WAITING / SUCCEEDED / FAILED /
 *      CANCELLED / BLOCKED），DX 的 11 态按 DX_TO_CORE_STATUS 显式映射进来；映射表双向可解释
 *      （CORE_TO_DX_STATUS 给规范代表，CORE_TO_DX_STATUSES 给全部来源集合）。
 *   4. 依赖缺失（db 未注入 / 两边表不存在）一律抛**结构化错误 + 明确 detail**，绝不返回假成功；
 *      对未知/脏状态不做猜测，status 投影为 null 并置 statusMapping.complete = false。
 *
 * ## 为什么两套表并存
 *   · DX 源（新表，11 态）：dx_tasks / dx_task_steps / dx_task_events
 *     schema：electron/dxos-agent-schema.cjs:65-79；状态表：electron/agent-task-store.cjs:54-67
 *   · core 源（既有表，7 态）：tasks / task_steps / task_events
 *     schema：electron/identity-store.cjs:846-908；状态表：electron/task-domain.cjs:9-18
 *   两者各自服务不同链路（DX = agent 任务域状态机；core = DSH/ACP Task Runtime）。
 *   本模块不合并表、不改任一状态机，只提供"同一个读入口"。
 *
 * ## 源行号（写实现时逐条核对）
 *   · core 7 态：electron/task-domain.cjs:9-18；合法性判定：:287
 *   · core 表结构：electron/identity-store.cjs:846-864（tasks，status CHECK 七态 :851）、
 *     :868-882（task_steps）、:899-908（task_events）
 *   · DX 11 态：electron/agent-task-store.cjs:54-67
 *   · DX 三张表：electron/dxos-agent-schema.cjs:66（dx_tasks）、:67（dx_task_steps）、:68（dx_task_events）
 *   · DX 取任务 / 事件：electron/agent-task-store.cjs:568-572、:596-600
 *   · dx_task_events.id 为 INTEGER PRIMARY KEY AUTOINCREMENT：dxos-agent-schema.cjs:68
 */
"use strict";

/** 该模块自我声明的边界文本；调用方（命令 / UI / 审计）可原样展示。 */
const UNIFIED_VIEW_BOUNDARY = "这是读模型：不写任何表、不改变任何一方状态机。";

/** 统一来源标识。 */
const SOURCE_DX = "dx";
const SOURCE_CORE = "core";
const UNIFIED_SOURCES = Object.freeze([SOURCE_DX, SOURCE_CORE]);

/**
 * DX 11 态（electron/agent-task-store.cjs:55-66，源自 taskStore.ts:6）。
 * 顺序即源文件声明顺序，便于测试逐项对齐。
 */
const DX_TASK_STATUSES = Object.freeze([
  "queued",
  "planning",
  "running",
  "verifying",
  "completed",
  "waiting_user",
  "waiting_children",
  "paused",
  "interrupted",
  "failed",
  "cancelled",
]);

/**
 * core 7 态（electron/task-domain.cjs:9-17；identity-store.cjs:851 的 CHECK 同集合）。
 * 统一状态词汇就取这 7 个值，DX 侧全部投影到它们。
 */
const CORE_TASK_STATUSES = Object.freeze(["PENDING", "RUNNING", "WAITING", "SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"]);

/** DX → core：每个 DX 状态恰映射一个 core 状态；11 个 DX 状态全覆盖（多对一允许）。 */
const DX_TO_CORE_STATUS = Object.freeze({
  queued: "PENDING",
  planning: "RUNNING",
  running: "RUNNING",
  verifying: "RUNNING",
  completed: "SUCCEEDED",
  waiting_user: "WAITING",
  waiting_children: "WAITING",
  paused: "BLOCKED",
  interrupted: "BLOCKED",
  failed: "FAILED",
  cancelled: "CANCELLED",
});

/** core → DX：每个 core 状态的**规范代表**（反向解释与回填默认值用）。 */
const CORE_TO_DX_STATUS = Object.freeze({
  PENDING: "queued",
  RUNNING: "running",
  WAITING: "waiting_user",
  SUCCEEDED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  BLOCKED: "paused",
});

/** core → DX：每个 core 状态的**全部来源集合**（反向可解释，非只给代表）。 */
const CORE_TO_DX_STATUSES = Object.freeze({
  PENDING: Object.freeze(["queued"]),
  RUNNING: Object.freeze(["planning", "running", "verifying"]),
  WAITING: Object.freeze(["waiting_user", "waiting_children"]),
  SUCCEEDED: Object.freeze(["completed"]),
  FAILED: Object.freeze(["failed"]),
  CANCELLED: Object.freeze(["cancelled"]),
  BLOCKED: Object.freeze(["paused", "interrupted"]),
});

/** 统一状态的语义说明（中文，供 UI 与文档复用）。 */
const CORE_STATUS_SEMANTICS = Object.freeze({
  PENDING: "已入队，尚未开始执行",
  RUNNING: "正在执行（DX 的规划 / 执行 / 校验都归入此态）",
  WAITING: "等待外部输入（用户回答或子任务）",
  SUCCEEDED: "已成功完成（终态）",
  FAILED: "已失败（终态）",
  CANCELLED: "已取消（终态）",
  BLOCKED: "已停止但可续接（DX 的暂停 / 中断都归入此态）",
});

/** 结构化错误码：调用方据此判别，不靠 message 字符串。 */
const UNIFIED_VIEW_ERR_INVALID_INPUT = "UNIFIED_VIEW_INVALID_INPUT";
const UNIFIED_VIEW_ERR_DEPENDENCY_UNAVAILABLE = "UNIFIED_VIEW_DEPENDENCY_UNAVAILABLE";
const UNIFIED_VIEW_ERR_NOT_FOUND = "UNIFIED_VIEW_NOT_FOUND";
const UNIFIED_VIEW_ERR_AMBIGUOUS = "UNIFIED_VIEW_AMBIGUOUS_SOURCE";
const UNIFIED_VIEW_ERROR_CODES = Object.freeze([
  UNIFIED_VIEW_ERR_INVALID_INPUT,
  UNIFIED_VIEW_ERR_DEPENDENCY_UNAVAILABLE,
  UNIFIED_VIEW_ERR_NOT_FOUND,
  UNIFIED_VIEW_ERR_AMBIGUOUS,
]);

/** 每套来源各自必须存在的三张表。 */
const REQUIRED_TABLES = Object.freeze({
  [SOURCE_DX]: Object.freeze(["dx_tasks", "dx_task_steps", "dx_task_events"]),
  [SOURCE_CORE]: Object.freeze(["tasks", "task_steps", "task_events"]),
});

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

/** 构造带稳定 code 与 detail 的读模型错误；调用方（agent-service）据此映射域错误码。 */
function createUnifiedViewError(code, message, detail) {
  const error = new Error(message == null ? code : String(message));
  error.name = "UnifiedViewError";
  error.code = UNIFIED_VIEW_ERROR_CODES.includes(code) ? code : UNIFIED_VIEW_ERR_INVALID_INPUT;
  error.detail = detail === undefined ? undefined : detail;
  return error;
}

function isUnifiedViewError(error) {
  return !!error && typeof error === "object" && typeof error.code === "string" && UNIFIED_VIEW_ERROR_CODES.includes(error.code);
}

function isSource(value) {
  return value === SOURCE_DX || value === SOURCE_CORE;
}

/** 依赖检查：db 必须是有 prepare 的 SQLite 句柄（IdentityStore.connection）。 */
function requireDb(options) {
  const db = options && options.db;
  if (!db || typeof db.prepare !== "function") {
    throw createUnifiedViewError(UNIFIED_VIEW_ERR_DEPENDENCY_UNAVAILABLE, "统一读模型需要 SQLite 连接（db.prepare 不可用）", {
      dependency: "sqlite",
      hint: "把 identityStore.connection 注入 db；未注入即不返回任何任务，绝不伪造空成功",
    });
  }
  return db;
}

/** 表存在性：缺表即结构化依赖错误（迁移未落位时不能假装"没有任务"）。 */
function requireTables(db, source) {
  const missing = [];
  for (const table of REQUIRED_TABLES[source]) {
    const found = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!found) missing.push(table);
  }
  if (missing.length) {
    throw createUnifiedViewError(UNIFIED_VIEW_ERR_DEPENDENCY_UNAVAILABLE, "统一读模型缺少表：" + missing.join(", "), {
      dependency: "schema",
      source,
      missing,
    });
  }
}

/** 允许的 limit：正整数，1..MAX_LIMIT；越界即报错而不是静默截断。 */
function normalizeLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw createUnifiedViewError(UNIFIED_VIEW_ERR_INVALID_INPUT, "limit 必须是 1.." + MAX_LIMIT + " 的整数", { limit: value });
  }
  return n;
}

function safeJson(text) {
  if (typeof text !== "string" || !text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** DX 状态 → core 状态；未知状态返回 null（不猜测）。 */
function mapDxStatusToCore(status) {
  const key = status == null ? "" : String(status);
  return Object.prototype.hasOwnProperty.call(DX_TO_CORE_STATUS, key) ? DX_TO_CORE_STATUS[key] : null;
}

/** core 状态 → DX 规范代表；未知状态返回 null。 */
function mapCoreStatusToDx(status) {
  const key = status == null ? "" : String(status);
  return Object.prototype.hasOwnProperty.call(CORE_TO_DX_STATUS, key) ? CORE_TO_DX_STATUS[key] : null;
}

/**
 * 统一状态判定：
 *   · core 源：状态本身就是统一词汇，原样返回（非法值返回 null）；
 *   · dx 源：经 DX_TO_CORE_STATUS 映射（未知值返回 null）。
 */
function unifiedStatusOf(source, status) {
  if (source === SOURCE_CORE) return CORE_TASK_STATUSES.includes(String(status)) ? String(status) : null;
  if (source === SOURCE_DX) return mapDxStatusToCore(status);
  return null;
}

/** 状态语义映射的完整解释（供命令 / UI / 测试消费，双向可读）。 */
function explainStatusMapping(source, status) {
  if (!isSource(source)) throw createUnifiedViewError(UNIFIED_VIEW_ERR_INVALID_INPUT, "source 必须是 dx | core", { source });
  const raw = status == null ? null : String(status);
  const unified = unifiedStatusOf(source, raw);
  const fromDx = source === SOURCE_DX;
  return Object.freeze({
    source,
    statusRaw: raw,
    unifiedStatus: unified,
    complete: unified != null,
    direction: fromDx ? "dx->core" : "core(identity)",
    dxStatuses: unified == null ? Object.freeze([]) : Object.freeze((CORE_TO_DX_STATUSES[unified] || []).slice()),
    coreStatuses: unified == null ? Object.freeze([]) : Object.freeze([unified]),
    canonicalDxStatus: unified == null ? null : CORE_TO_DX_STATUS[unified],
    semantics: unified == null ? null : CORE_STATUS_SEMANTICS[unified],
  });
}

/** 显式映射表：DX 11 态逐行给出 core 映射；顺序 = DX_TASK_STATUSES 声明顺序。 */
function statusMappingTable() {
  return DX_TASK_STATUSES.map((dx) => Object.freeze({
    dx,
    core: DX_TO_CORE_STATUS[dx],
    canonicalDxOfCore: CORE_TO_DX_STATUS[DX_TO_CORE_STATUS[dx]],
    semantics: CORE_STATUS_SEMANTICS[DX_TO_CORE_STATUS[dx]],
  }));
}

/**
 * 自检：11×7 全覆盖 + 双向可解释 + 代表一致。
 * 返回 true 或抛 UNIFIED_VIEW_INVALID_INPUT（不静默）。
 */
function assertStatusMapComplete() {
  const dxKeys = Object.keys(DX_TO_CORE_STATUS);
  if (dxKeys.length !== DX_TASK_STATUSES.length || !DX_TASK_STATUSES.every((s) => dxKeys.includes(s))) {
    throw createUnifiedViewError(UNIFIED_VIEW_ERR_INVALID_INPUT, "DX 状态映射未覆盖 11 态", { dxKeys });
  }
  for (const dx of DX_TASK_STATUSES) {
    const core = DX_TO_CORE_STATUS[dx];
    if (!CORE_TASK_STATUSES.includes(core)) {
      throw createUnifiedViewError(UNIFIED_VIEW_ERR_INVALID_INPUT, "DX 状态映射到未知 core 状态：" + dx + " -> " + String(core), { dx, core });
    }
    const reverse = CORE_TO_DX_STATUSES[core] || [];
    if (!reverse.includes(dx)) {
      throw createUnifiedViewError(UNIFIED_VIEW_ERR_INVALID_INPUT, "反向映射缺边：" + core + " 未列出 " + dx, { dx, core, reverse });
    }
  }
  const coreKeys = Object.keys(CORE_TO_DX_STATUS);
  if (coreKeys.length !== CORE_TASK_STATUSES.length || !CORE_TASK_STATUSES.every((s) => coreKeys.includes(s))) {
    throw createUnifiedViewError(UNIFIED_VIEW_ERR_INVALID_INPUT, "core 状态映射未覆盖 7 态", { coreKeys });
  }
  for (const core of CORE_TASK_STATUSES) {
    const canonical = CORE_TO_DX_STATUS[core];
    if (!DX_TASK_STATUSES.includes(canonical)) {
      throw createUnifiedViewError(UNIFIED_VIEW_ERR_INVALID_INPUT, "core 代表不是合法 DX 状态：" + core + " -> " + String(canonical), { core, canonical });
    }
    // 代表必须真的映射回该 core（否则"双向可解释"不成立）。
    if (DX_TO_CORE_STATUS[canonical] !== core) {
      throw createUnifiedViewError(UNIFIED_VIEW_ERR_INVALID_INPUT, "代表不一致：" + canonical + " -> " + String(DX_TO_CORE_STATUS[canonical]) + " != " + core, { core, canonical });
    }
    const reverse = CORE_TO_DX_STATUSES[core] || [];
    if (!reverse.includes(canonical)) {
      throw createUnifiedViewError(UNIFIED_VIEW_ERR_INVALID_INPUT, "反向集合缺规范代表：" + core + " -> " + canonical, { core, canonical, reverse });
    }
  }
  // 反向集合之并必须恰好等于 11 态（无多、无漏）。
  const union = [];
  for (const core of CORE_TASK_STATUSES) for (const dx of CORE_TO_DX_STATUSES[core]) union.push(dx);
  const sortedUnion = union.slice().sort();
  const sortedDx = DX_TASK_STATUSES.slice().sort();
  if (JSON.stringify(sortedUnion) !== JSON.stringify(sortedDx)) {
    throw createUnifiedViewError(UNIFIED_VIEW_ERR_INVALID_INPUT, "反向集合之并与 11 态不一致", { union: sortedUnion, dx: sortedDx });
  }
  return true;
}

/** 统一的标题：DX 用 title；core 没有 title，查询里已用 goal 别名成 title（语义最贴近的既有列）。 */
function unifiedTitle(row) {
  return row.title == null ? null : String(row.title);
}

/** 单行 → 统一投影。row 已由查询侧归一（字段名统一见 queryDx / queryCore）。 */
function projectRow(source, row) {
  const mapping = explainStatusMapping(source, row.status);
  return Object.freeze({
    key: source + ":" + String(row.id),
    id: String(row.id),
    source,
    title: unifiedTitle(row),
    status: mapping.unifiedStatus,
    statusRaw: mapping.statusRaw,
    statusMapping: mapping,
    createdAt: row.created_at == null ? null : Number(row.created_at),
    updatedAt: row.updated_at == null ? null : Number(row.updated_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    stepCount: Number(row.step_count || 0),
    eventCount: Number(row.event_count || 0),
    lastEvent: row.last_event_type == null ? null : Object.freeze({
      type: String(row.last_event_type),
      message: row.last_event_message == null ? null : String(row.last_event_message),
      at: row.last_event_at == null ? null : Number(row.last_event_at),
    }),
    readOnly: true,
  });
}

/**
 * DX 行查询（只读 SELECT）。
 *   最近事件按 dx_task_events.id DESC —— 该列是 AUTOINCREMENT（dxos-agent-schema.cjs:68），
 *   单调递增即插入顺序；sequence 允许 NULL，用它排序会把 NULL 排到末尾，故不用。
 */
const DX_SELECT_COLUMNS = [
  "t.id AS id",
  "t.title AS title",
  "t.status AS status",
  "t.created_at AS created_at",
  "t.updated_at AS updated_at",
  "t.started_at AS started_at",
  "t.completed_at AS completed_at",
  "(SELECT COUNT(*) FROM dx_task_steps s WHERE s.task_id = t.id) AS step_count",
  "(SELECT COUNT(*) FROM dx_task_events e WHERE e.task_id = t.id) AS event_count",
  "(SELECT e.type FROM dx_task_events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) AS last_event_type",
  "(SELECT e.message FROM dx_task_events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) AS last_event_message",
  "(SELECT e.created_at FROM dx_task_events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) AS last_event_at",
].join(", ");

const DX_SELECT_LIST = "SELECT " + DX_SELECT_COLUMNS + " FROM dx_tasks t";
const DX_SELECT_ONE = "SELECT " + DX_SELECT_COLUMNS + " FROM dx_tasks t WHERE t.id = ?";

/** core 行查询（只读 SELECT）；最近事件按 task_events.sequence DESC（identity-store.cjs:902-906）。 */
const CORE_SELECT_COLUMNS = [
  "t.task_id AS id",
  "t.goal AS title",
  "t.status AS status",
  "t.created_at AS created_at",
  "t.updated_at AS updated_at",
  "t.started_at AS started_at",
  "t.completed_at AS completed_at",
  "(SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.task_id) AS step_count",
  "(SELECT COUNT(*) FROM task_events e WHERE e.task_id = t.task_id) AS event_count",
  "(SELECT e.event_type FROM task_events e WHERE e.task_id = t.task_id ORDER BY e.sequence DESC LIMIT 1) AS last_event_type",
  "(SELECT e.safe_payload FROM task_events e WHERE e.task_id = t.task_id ORDER BY e.sequence DESC LIMIT 1) AS last_event_payload",
  "(SELECT e.created_at FROM task_events e WHERE e.task_id = t.task_id ORDER BY e.sequence DESC LIMIT 1) AS last_event_at",
].join(", ");

const CORE_SELECT_LIST = "SELECT " + CORE_SELECT_COLUMNS + " FROM tasks t";
const CORE_SELECT_ONE = "SELECT " + CORE_SELECT_COLUMNS + " FROM tasks t WHERE t.task_id = ?";

/** core 的 last_event_payload 里若有 message 字段，取出作为统一 message；没有就是 null。 */
function coreLastEventMessage(row) {
  const payload = safeJson(row.last_event_payload);
  if (payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.message === "string") return payload.message;
  return null;
}

function normalizeCoreRow(row) {
  return Object.assign({}, row, { last_event_message: coreLastEventMessage(row) });
}

function queryDxList(db, options, limit) {
  const where = [];
  const params = [];
  if (options.userId != null && options.userId !== "") { where.push("t.created_by = ?"); params.push(String(options.userId)); }
  const sql = DX_SELECT_LIST + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY t.created_at DESC LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function queryDxOne(db, id) {
  const row = db.prepare(DX_SELECT_ONE).get(String(id));
  return row || null;
}

function queryCoreList(db, options, limit) {
  const where = [];
  const params = [];
  if (options.userId != null && options.userId !== "") { where.push("t.user_id = ?"); params.push(String(options.userId)); }
  const sql = CORE_SELECT_LIST + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY t.created_at DESC LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params).map(normalizeCoreRow);
}

function queryCoreOne(db, id) {
  const row = db.prepare(CORE_SELECT_ONE).get(String(id));
  return row ? normalizeCoreRow(row) : null;
}

/** 稳定排序：created_at DESC，其次 source 名称，再其次 id；避免同刻任务顺序不定。 */
function sortUnified(items) {
  return items.slice().sort((a, b) => {
    const at = a.createdAt == null ? 0 : a.createdAt;
    const bt = b.createdAt == null ? 0 : b.createdAt;
    if (at !== bt) return bt - at;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 请求的来源集合：source 省略 = 两套都读。 */
function requestedSources(source) {
  if (source === undefined || source === null || source === "") return UNIFIED_SOURCES.slice();
  if (!isSource(source)) throw createUnifiedViewError(UNIFIED_VIEW_ERR_INVALID_INPUT, "source 必须是 dx | core", { source });
  return [source];
}

/**
 * 只读统一列表。
 * @param {{ db: object, source?: "dx"|"core", userId?: string, limit?: number }} options
 * @returns {{ readModel: true, boundary: string, sources: string[], counts: object, items: object[] }}
 */
function listUnifiedTasks(options) {
  const db = requireDb(options);
  const opts = options || {};
  const sources = requestedSources(opts.source);
  const limit = normalizeLimit(opts.limit);
  for (const source of sources) requireTables(db, source);
  const rawDx = sources.includes(SOURCE_DX) ? queryDxList(db, opts, limit) : [];
  const rawCore = sources.includes(SOURCE_CORE) ? queryCoreList(db, opts, limit) : [];
  const items = sortUnified([
    ...rawDx.map((row) => projectRow(SOURCE_DX, row)),
    ...rawCore.map((row) => projectRow(SOURCE_CORE, row)),
  ]).slice(0, limit);
  return Object.freeze({
    readModel: true,
    boundary: UNIFIED_VIEW_BOUNDARY,
    sources: Object.freeze(sources.slice()),
    counts: Object.freeze({ dx: rawDx.length, core: rawCore.length, total: items.length }),
    items: Object.freeze(items),
  });
}

/**
 * 只读统一单条。
 *   · 显式 source：只查该来源（同名 id 绝不互相污染）；
 *   · 省略 source：两边都查；命中 0 条 → NOT_FOUND；命中 2 条 → AMBIGUOUS（带 candidates）；
 *     命中 1 条 → 返回该条。绝不"优先取一边"。
 * @param {{ db: object, id: string, source?: "dx"|"core" }} options
 */
function getUnifiedTask(options) {
  const db = requireDb(options);
  const opts = options || {};
  const id = opts.id == null ? "" : String(opts.id);
  if (!id) throw createUnifiedViewError(UNIFIED_VIEW_ERR_INVALID_INPUT, "id 必填", { id: opts.id });
  if (opts.source !== undefined && opts.source !== null && opts.source !== "") {
    if (!isSource(opts.source)) throw createUnifiedViewError(UNIFIED_VIEW_ERR_INVALID_INPUT, "source 必须是 dx | core", { source: opts.source });
    requireTables(db, opts.source);
    const row = opts.source === SOURCE_DX ? queryDxOne(db, id) : queryCoreOne(db, id);
    if (!row) throw createUnifiedViewError(UNIFIED_VIEW_ERR_NOT_FOUND, "任务不存在：" + id, { id, source: opts.source });
    return projectRow(opts.source, row);
  }
  for (const source of UNIFIED_SOURCES) requireTables(db, source);
  const found = [];
  const dxRow = queryDxOne(db, id);
  if (dxRow) found.push(projectRow(SOURCE_DX, dxRow));
  const coreRow = queryCoreOne(db, id);
  if (coreRow) found.push(projectRow(SOURCE_CORE, coreRow));
  if (found.length === 0) throw createUnifiedViewError(UNIFIED_VIEW_ERR_NOT_FOUND, "任务不存在：" + id, { id });
  if (found.length > 1) {
    throw createUnifiedViewError(UNIFIED_VIEW_ERR_AMBIGUOUS, "同一 id 在两套表中都存在，必须显式指定 source：" + id, {
      id,
      candidates: found.map((item) => item.source),
      hint: "两套表的 id 命名空间独立；本读模型不做优先级猜测",
    });
  }
  return found[0];
}

/** 读模型自检（导出给测试与健康检查）；不碰数据库。 */
function unifiedViewSelfCheck() {
  assertStatusMapComplete();
  return true;
}

module.exports = {
  UNIFIED_VIEW_BOUNDARY,
  UNIFIED_VIEW_ERROR_CODES,
  UNIFIED_VIEW_ERR_INVALID_INPUT,
  UNIFIED_VIEW_ERR_DEPENDENCY_UNAVAILABLE,
  UNIFIED_VIEW_ERR_NOT_FOUND,
  UNIFIED_VIEW_ERR_AMBIGUOUS,
  SOURCE_DX,
  SOURCE_CORE,
  UNIFIED_SOURCES,
  DX_TASK_STATUSES,
  CORE_TASK_STATUSES,
  DX_TO_CORE_STATUS,
  CORE_TO_DX_STATUS,
  CORE_TO_DX_STATUSES,
  CORE_STATUS_SEMANTICS,
  createUnifiedViewError,
  isUnifiedViewError,
  isSource,
  mapDxStatusToCore,
  mapCoreStatusToDx,
  unifiedStatusOf,
  explainStatusMapping,
  statusMappingTable,
  assertStatusMapComplete,
  unifiedViewSelfCheck,
  listUnifiedTasks,
  getUnifiedTask,
};
