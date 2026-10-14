"use strict";
/**
 * B6a · 自动化域持久层（表 automations / automation_runs 已在 v22 建好，原样使用，不改表）。
 *
 * ## 来源
 *   · automations.ts:31-58      AutomationRow / RunRow 的形状
 *   · automations.ts:60-73      json 解析与 mapAutomation
 *   · automations.ts:250-295    list / create / update / delete
 *   · automations.ts:297-334    claimDue（事务领取）与 recoverStaleRuns
 *   · automations.ts:336-347    runAutomationNow
 *   · automations.ts:349-392    claimDueServerAutomation / recoverInterruptedServerAutomationRuns / completeAutomationRun
 *
 * ## 与源不同的点（有意为之）
 *   · **不建表、不改表**：automations / automation_runs 由 identity-store.cjs:1603 的 v22 迁移
 *     （dxos-foundation-schema.cjs:196-197 的 DDL）建好；本文件没有任何 CREATE / ALTER。
 *   · **没有 server/desktop 双领取**：源把动作分成"服务端执行"和"桌面客户端领取"两条链
 *     （automations.ts:297-312 / :349-364）。本移植的调度器就在主进程内，领取只此一条：
 *     claimDueAutomation 对所有已启用且到点的定义一视同仁。
 *   · **视图改用 camelCase**：源 mapAutomation 直接回 snake_case 行字段；IPC 出口统一成
 *     公开投影（automationView / runView），不含 SQL 列名，便于渲染层稳定消费与脱敏。
 *   · **恢复只发生在启动**：源的 recoverStaleRuns（:314-329）按"多客户端 + 10 分钟"判定僵尸运行；
 *     本移植是单进程本地调度器，用 recoverInterruptedRuns() 在启动时把所有 running 运行置 failed
 *     （消息如实说明"主进程曾重启"），绝不伪造完成。
 *   · **重试属于一次运行的内部策略**：automation-service.cjs 按 action.retry 在一次运行内重试，
 *     本层只落一行运行记录（源没有重试，见 automation-domain.cjs 顶部说明）。
 *
 * ## 数据库句柄与依赖注入
 *   configureAutomationStore({ db, clock, idFactory, appActions })
 *     · db          —— node:sqlite DatabaseSync（prepare/run/get/all），即 identity-store 的连接；
 *     · clock       —— 可选，默认 Date.now（测试用假时钟驱动调度）；
 *     · idFactory   —— 可选，默认 randomUUID；
 *     · appActions  —— app_action 参数规约适配器（B7）；未注入时定义 app_action 结构化依赖缺失。
 *   resetAutomationStoreForTests() —— 清空注入，供测试隔离。
 *
 * 参照：electron/media-store.cjs:1-140（同形的注入 + writeTransaction）。
 */

const { randomUUID } = require("node:crypto");
const domain = require("./automation-domain.cjs");

const {
  createAutomationError,
  normalizeDefinition,
  nextRunAt,
  AUTOMATION_ERR_INVALID_INPUT,
  AUTOMATION_ERR_NOT_FOUND,
  AUTOMATION_ERR_CONFLICT,
  AUTOMATION_ERR_DEPENDENCY_UNAVAILABLE,
} = domain;

// ---------------------------------------------------------------------------
// 依赖注入
// ---------------------------------------------------------------------------
let automationDb = null;
let automationClock = () => Date.now();
let automationIdFactory = () => randomUUID();
let automationAppActions = null;

function configureAutomationStore(options) {
  const opts = options || {};
  if (opts.db) automationDb = opts.db;
  if (typeof opts.clock === "function") automationClock = opts.clock;
  if (typeof opts.idFactory === "function") automationIdFactory = opts.idFactory;
  automationAppActions = opts.appActions && typeof opts.appActions.normalize === "function" ? opts.appActions : null;
  return { db: automationDb, appActions: !!automationAppActions };
}

function resetAutomationStoreForTests() {
  automationDb = null;
  automationClock = () => Date.now();
  automationIdFactory = () => randomUUID();
  automationAppActions = null;
}

function getAutomationDb() {
  if (!automationDb) {
    const error = new Error("automation-store 未注入数据库句柄（configureAutomationStore({ db })）");
    error.code = AUTOMATION_ERR_DEPENDENCY_UNAVAILABLE;
    error.dependency = "db";
    throw error;
  }
  return automationDb;
}

function now() {
  return automationClock();
}

/** 源 automations.ts:297 的 ccsDb.transaction(fn).immediate() 等价实现。 */
function writeTransaction(work) {
  const db = getAutomationDb();
  if (db.isTransaction || db.inTransaction) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = work();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 已回滚 */
    }
    throw error;
  }
}

function json(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * 公开投影：只回渲染层需要的 camelCase 字段，不暴露 SQL 列名与 internals。
 * schedule / action 的 JSON 解析失败时回 null（如实反映脏数据，不猜）。
 */
function automationView(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.created_by,
    title: row.title,
    instruction: row.instruction,
    action: json(row.action_json),
    schedule: json(row.schedule_json),
    enabled: !!row.enabled,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runView(row) {
  if (!row) return null;
  return {
    id: row.id,
    automationId: row.automation_id,
    scheduledFor: row.scheduled_for,
    status: row.status,
    clientId: row.client_id,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

// ---------------------------------------------------------------------------
// 定义 CRUD（源 automations.ts:250-295）
// ---------------------------------------------------------------------------

const RUN_HISTORY_LIMIT = 20;

function getAutomationRow(userId, id) {
  const db = getAutomationDb();
  return db.prepare("SELECT * FROM automations WHERE id=? AND created_by=?").get(String(id), String(userId));
}

function listRunRows(automationId, limit) {
  const db = getAutomationDb();
  const capped = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.round(limit) : RUN_HISTORY_LIMIT));
  return db.prepare("SELECT * FROM automation_runs WHERE automation_id=? ORDER BY created_at DESC LIMIT ?").all(String(automationId), capped);
}

/** 源 automations.ts:250-255 */
function listAutomations(userId) {
  const db = getAutomationDb();
  const rows = db.prepare("SELECT * FROM automations WHERE created_by=? ORDER BY created_at DESC").all(String(userId));
  return rows.map((row) => Object.assign(automationView(row), { runs: listRunRows(row.id, RUN_HISTORY_LIMIT).map(runView) }));
}

/** 源 automations.ts:257-264 */
function createAutomation(userId, input) {
  const db = getAutomationDb();
  const at = now();
  const value = normalizeDefinition(input, { now: at, appActions: automationAppActions });
  const id = automationIdFactory();
  db.prepare("INSERT INTO automations(id,created_by,title,instruction,action_json,schedule_json,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?)")
    .run(id, String(userId), value.title, value.instruction, JSON.stringify(value.action), JSON.stringify(value.schedule), nextRunAt(value.schedule, at - 1), at, at);
  return automationView(db.prepare("SELECT * FROM automations WHERE id=?").get(id));
}

/** 源 automations.ts:266-290（enabled 与定义变更一并处理）。 */
function updateAutomation(userId, id, input) {
  const db = getAutomationDb();
  const source = input && typeof input === "object" ? input : {};
  const row = getAutomationRow(userId, id);
  if (!row) throw createAutomationError(AUTOMATION_ERR_NOT_FOUND, "自动化任务不存在");
  const at = now();
  const enabled = source.enabled === undefined ? !!row.enabled : !!source.enabled;
  const currentSchedule = json(row.schedule_json);
  const currentAction = json(row.action_json);
  const definitionChanged = source.schedule !== undefined || source.action !== undefined || source.instruction !== undefined || source.retry !== undefined;
  const value = definitionChanged
    ? normalizeDefinition({
        title: source.title === undefined ? row.title : source.title,
        instruction: source.instruction === undefined ? row.instruction : source.instruction,
        schedule: source.schedule || currentSchedule,
        action: source.action || currentAction,
        retry: source.retry,
      }, { now: at, appActions: automationAppActions })
    : null;
  const schedule = value ? value.schedule : currentSchedule;
  const title = value ? value.title : (source.title === undefined ? row.title : String(source.title).trim() || row.title);
  const instruction = value ? value.instruction : row.instruction;
  const action = value ? value.action : currentAction;
  db.prepare("UPDATE automations SET title=?,instruction=?,action_json=?,schedule_json=?,enabled=?,next_run_at=?,updated_at=? WHERE id=?")
    .run(
      title,
      instruction,
      JSON.stringify(action),
      JSON.stringify(schedule),
      enabled ? 1 : 0,
      enabled ? nextRunAt(schedule, at - 1) : null,
      at,
      String(id),
    );
  return automationView(db.prepare("SELECT * FROM automations WHERE id=?").get(id));
}

/** 源 automations.ts:292-295 */
function deleteAutomation(userId, id) {
  const db = getAutomationDb();
  const result = db.prepare("DELETE FROM automations WHERE id=? AND created_by=?").run(String(id), String(userId));
  if (!result.changes) throw createAutomationError(AUTOMATION_ERR_NOT_FOUND, "自动化任务不存在");
  return { id: String(id), deleted: true };
}

/** 读取单个定义 + 最近运行（源只有 list；本域给 CRUD 补齐 get）。 */
function getAutomation(userId, id) {
  const row = getAutomationRow(userId, id);
  if (!row) throw createAutomationError(AUTOMATION_ERR_NOT_FOUND, "自动化任务不存在");
  return Object.assign(automationView(row), { runs: listRunRows(row.id, RUN_HISTORY_LIMIT).map(runView) });
}

// ---------------------------------------------------------------------------
// 调度领取（源 automations.ts:297-312 / :349-364 的本地单进程版本）
// ---------------------------------------------------------------------------

/**
 * 领取一个到点的自动化运行：
 *   · 事务内选 enabled=1 且 next_run_at <= now 的候选（按 next_run_at 升序，最多 50 个）；
 *   · INSERT OR IGNORE 落 automation_runs（唯一索引 idx_automation_runs_scheduled 防重）；
 *     若该 (automation_id, scheduled_for) 已存在则跳过候选，绝不重复触发；
 *   · 成功后推进 next_run_at 并把定义置为 running。
 * 返回 { userId, automation, run }；没有可领取的返回 null。
 */
function claimDueAutomation(options = {}) {
  const at = Number.isFinite(options.now) ? options.now : now();
  return writeTransaction(() => {
    const db = getAutomationDb();
    const candidates = db.prepare("SELECT * FROM automations WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT 50").all(at);
    for (const row of candidates) {
      const scheduledFor = row.next_run_at;
      const runId = automationIdFactory();
      const inserted = db.prepare("INSERT OR IGNORE INTO automation_runs(id,automation_id,scheduled_for,status,client_id,created_at,started_at) VALUES(?,?,?,'running',?,?,?)")
        .run(runId, row.id, scheduledFor, "main", at, at);
      if (!inserted.changes) continue;
      const schedule = json(row.schedule_json);
      db.prepare("UPDATE automations SET next_run_at=?,last_run_at=?,last_status=?,last_error=NULL,updated_at=? WHERE id=?")
        .run(nextRunAt(schedule, at), at, "running", at, row.id);
      return {
        userId: row.created_by,
        automation: automationView(row),
        run: runView(db.prepare("SELECT * FROM automation_runs WHERE id=?").get(runId)),
      };
    }
    return null;
  });
}

/** 源 automations.ts:336-347：立即运行一次（不改 next_run_at）。 */
function runAutomationNow(userId, id, clientId) {
  const db = getAutomationDb();
  const row = getAutomationRow(userId, id);
  if (!row) throw createAutomationError(AUTOMATION_ERR_NOT_FOUND, "自动化任务不存在");
  const at = now();
  const runId = automationIdFactory();
  db.prepare("INSERT INTO automation_runs(id,automation_id,scheduled_for,status,client_id,created_at,started_at) VALUES(?,?,?,'running',?,?,?)")
    .run(runId, String(id), at, String(clientId || "manual"), at, at);
  db.prepare("UPDATE automations SET last_run_at=?,last_status=?,last_error=NULL,updated_at=? WHERE id=?").run(at, "running", at, String(id));
  return {
    userId: String(userId),
    automation: automationView(db.prepare("SELECT * FROM automations WHERE id=?").get(id)),
    run: runView(db.prepare("SELECT * FROM automation_runs WHERE id=?").get(runId)),
  };
}

function getRun(userId, runId) {
  const db = getAutomationDb();
  const row = db.prepare("SELECT r.* FROM automation_runs r JOIN automations a ON a.id=r.automation_id WHERE r.id=? AND a.created_by=?").get(String(runId), String(userId));
  if (!row) throw createAutomationError(AUTOMATION_ERR_NOT_FOUND, "执行记录不存在");
  return runView(row);
}

/** 源 automations.ts:383-392，status 额外支持 cancelled（取消不伪造成功）。 */
function completeAutomationRun(userId, runId, input) {
  const db = getAutomationDb();
  const row = db.prepare("SELECT r.*,a.created_by FROM automation_runs r JOIN automations a ON a.id=r.automation_id WHERE r.id=? AND a.created_by=?").get(String(runId), String(userId));
  if (!row) throw createAutomationError(AUTOMATION_ERR_NOT_FOUND, "执行记录不存在");
  const status = ["success", "failed", "cancelled"].includes(input && input.status) ? input.status : "failed";
  const at = now();
  db.prepare("UPDATE automation_runs SET status=?,result=?,error=?,completed_at=? WHERE id=?")
    .run(status, (input && input.result) || null, (input && input.error) || null, at, String(runId));
  db.prepare("UPDATE automations SET last_status=?,last_error=?,updated_at=? WHERE id=?")
    .run(status, status === "failed" ? ((input && input.error) || "执行失败") : null, at, row.automation_id);
  return runView(db.prepare("SELECT * FROM automation_runs WHERE id=?").get(runId));
}

/** automation/runs：按自动化或按用户列出运行记录（源只有定义内嵌 20 条）。 */
function listRuns(userId, input) {
  const db = getAutomationDb();
  const source = input && typeof input === "object" ? input : {};
  const limit = Math.max(1, Math.min(200, Number.isFinite(source.limit) ? Math.round(source.limit) : 50));
  if (source.automationId) {
    const row = getAutomationRow(userId, source.automationId);
    if (!row) throw createAutomationError(AUTOMATION_ERR_NOT_FOUND, "自动化任务不存在");
    return listRunRows(row.id, limit).map(runView);
  }
  return db.prepare("SELECT r.* FROM automation_runs r JOIN automations a ON a.id=r.automation_id WHERE a.created_by=? ORDER BY r.created_at DESC LIMIT ?").all(String(userId), limit).map(runView);
}

/** 源 automations.ts:370-381 的本地单进程版本：启动时把遗留 running 运行如实置 failed。 */
function recoverInterruptedRuns() {
  const at = now();
  return writeTransaction(() => {
    const db = getAutomationDb();
    const rows = db.prepare("SELECT id,automation_id FROM automation_runs WHERE status='running'").all();
    const updateRun = db.prepare("UPDATE automation_runs SET status='failed',error=?,completed_at=? WHERE id=?");
    const updateAutomation = db.prepare("UPDATE automations SET last_status='failed',last_error=?,updated_at=? WHERE id=?");
    const message = "主进程曾重启，本次执行未完成，请检查业务状态后重试";
    for (const row of rows) {
      updateRun.run(message, at, row.id);
      updateAutomation.run(message, at, row.automation_id);
    }
    return rows.length;
  });
}

module.exports = {
  RUN_HISTORY_LIMIT,
  configureAutomationStore,
  resetAutomationStoreForTests,
  getAutomationDb,
  writeTransaction,
  automationView,
  runView,
  listAutomations,
  getAutomation,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  claimDueAutomation,
  runAutomationNow,
  getRun,
  completeAutomationRun,
  listRuns,
  recoverInterruptedRuns,
};
