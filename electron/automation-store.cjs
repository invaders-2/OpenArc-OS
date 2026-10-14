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
 *   · **没有 server/desktop 双领取（有意的本地化简化）**：源把动作分成"服务端执行"和"桌面客户端领取"
 *     两条链（automations.ts:297-312 / :349-364），各有客户端标识（client_id='server' / 桌面 id）。
 *     本移植的调度器就在主进程内，领取只此一条：claimDueAutomation 对所有已启用且到点的定义
 *     一视同仁，统一记 client_id='main'。源 recoverStaleRuns（:314-329）因 server 侧另有启动期
 *     recoverInterruptedServerAutomationRuns 兜底而排除 client_id='server'；本移植没有那条独立兜底，
 *     故 per-claim 的 stale 扫描覆盖所有 client_id —— 这是"stale 恢复不能省"的必要取舍，不是遗漏。
 *   · **视图改用 camelCase**：源 mapAutomation 直接回 snake_case 行字段；IPC 出口统一成
 *     公开投影（automationView / runView），不含 SQL 列名，便于渲染层稳定消费与脱敏。
 *   · **恢复分两层（都保留）**：启动期 recoverInterruptedRuns() 把上次遗留的全部 running 置 failed
 *     （消息如实说明"主进程曾重启"，源 automations.ts:370-381）；每次领取（claimDueAutomation）前
 *     先做 recoverStaleRuns()，按源 10 分钟口径（:315 cutoff = now - staleAfterMs，:316-317
 *     started_at<cutoff）把僵尸 running 收敛为 failed，终结"不重启就长期挂 running"。阈值是常量
 *     DEFAULT_STALE_AFTER_MS，可经 configureAutomationStore({ staleAfterMs }) 或
 *     recoverStaleRuns({ staleAfterMs }) 注入。两层的 UPDATE 都带 `AND status='running'`
 *     / `AND last_status='running'`（源 :321-322 同款），先到者生效、重复调用幂等，绝不覆盖已收敛的运行。
 *     源的 stale 终态文案是"桌面会话中断，任务未完成"；本移植按实际阈值写成"N 分钟未完成"以便审计。
 *   · **重试属于一次运行的内部策略**：automation-service.cjs 按 action.retry 在一次运行内重试，
 *     本层只落一行运行记录（源没有重试，见 automation-domain.cjs 顶部说明）。
 *
 * ## 数据库句柄与依赖注入
 *   configureAutomationStore({ db, clock, idFactory, appActions, staleAfterMs })
 *     · db           —— node:sqlite DatabaseSync（prepare/run/get/all），即 identity-store 的连接；
 *     · clock        —— 可选，默认 Date.now（测试用假时钟驱动调度）；
 *     · idFactory    —— 可选，默认 randomUUID；
 *     · appActions   —— app_action 参数规约适配器（B7）；未注入时定义 app_action 结构化依赖缺失；
 *     · staleAfterMs —— 可选，stale 阈值（默认 DEFAULT_STALE_AFTER_MS = 源 10 分钟口径）。
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
/** 源 automations.ts:315：stale 判定是 cutoff = now - 10 分钟，started_at 早于 cutoff 才算僵尸。 */
const DEFAULT_STALE_AFTER_MS = 10 * 60_000;
let automationStaleAfterMs = DEFAULT_STALE_AFTER_MS;

function configureAutomationStore(options) {
  const opts = options || {};
  if (opts.db) automationDb = opts.db;
  if (typeof opts.clock === "function") automationClock = opts.clock;
  if (typeof opts.idFactory === "function") automationIdFactory = opts.idFactory;
  // staleAfterMs 只接受正数；未给时沿用默认 10 分钟（测试注入小阈值以推进假时钟）。
  if (Number.isFinite(opts.staleAfterMs) && opts.staleAfterMs > 0) automationStaleAfterMs = Math.floor(opts.staleAfterMs);
  automationAppActions = opts.appActions && typeof opts.appActions.normalize === "function" ? opts.appActions : null;
  return { db: automationDb, appActions: !!automationAppActions, staleAfterMs: automationStaleAfterMs };
}

function resetAutomationStoreForTests() {
  automationDb = null;
  automationClock = () => Date.now();
  automationIdFactory = () => randomUUID();
  automationAppActions = null;
  automationStaleAfterMs = DEFAULT_STALE_AFTER_MS;
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

/** stale 收敛的错误文案：保留源"中断/未完成、绝不伪造成功"的语义，按实际阈值写明分钟数便于审计。 */
function staleRunMessage(staleAfterMs) {
  return "运行超过 " + Math.max(1, Math.round(staleAfterMs / 60000)) + " 分钟未完成，已判定为中断并置为失败";
}

/**
 * 源 automations.ts:314-329 的本地单进程版本：把 started_at 超过 staleAfterMs 且仍为 running 的运行
 * 收敛为 failed（源终态同样是 failed，源文案"桌面会话中断，任务未完成"）。
 *   · 源按 (automation 归属 + 10 分钟 + client_id<>'server') 判定；本移植领取是全局的，故不加归属过滤，
 *     且因没有 server 侧独立启动兜底，client_id 一律纳入扫描（见文件头"没有 server/desktop 双领取"）。
 *   · automation_runs 无 heartbeat 列（DDL 见 dxos-foundation-schema.cjs:197），与源 :316-317 一致只用
 *     started_at；started_at IS NULL 的运行不参与（等价于源的 NULL 比较）。
 *   · UPDATE 带 `AND status='running'` / `AND last_status='running'`（源 :321-322 同款），
 *     重复调用幂等：changes=0 的运行不计数、不改写先到者的结果。
 *   · 返回 { count, recovered }；recovered 供调用方写事件/审计。onRecovered 在事务提交后逐个触发，
 *     回调抛错不回滚、不影响已落库结果。
 * options: { now?, staleAfterMs?, onRecovered?(item) }
 */
function recoverStaleRuns(options = {}) {
  const at = Number.isFinite(options.now) ? options.now : now();
  const staleAfterMs = Number.isFinite(options.staleAfterMs) && options.staleAfterMs > 0
    ? Math.floor(options.staleAfterMs)
    : automationStaleAfterMs;
  const cutoff = at - staleAfterMs;
  const result = writeTransaction(() => {
    const db = getAutomationDb();
    const stale = db.prepare("SELECT r.id,r.automation_id FROM automation_runs r JOIN automations a ON a.id=r.automation_id WHERE r.status='running' AND r.started_at IS NOT NULL AND r.started_at<? ORDER BY r.started_at").all(cutoff);
    if (!stale.length) return { count: 0, recovered: [] };
    const message = staleRunMessage(staleAfterMs);
    const updateRun = db.prepare("UPDATE automation_runs SET status='failed',error=?,completed_at=? WHERE id=? AND status='running'");
    const updateAutomation = db.prepare("UPDATE automations SET last_status='failed',last_error=?,updated_at=? WHERE id=? AND last_status='running'");
    const recovered = [];
    for (const item of stale) {
      if (!updateRun.run(message, at, item.id).changes) continue;
      updateAutomation.run(message, at, item.automation_id);
      recovered.push({ runId: item.id, automationId: item.automation_id, error: message });
    }
    return { count: recovered.length, recovered };
  });
  if (typeof options.onRecovered === "function") for (const item of result.recovered) options.onRecovered(item);
  return result;
}

/**
 * 领取一个到点的自动化运行：
 *   · 先做 recoverStaleRuns（源 automations.ts:332 的领取前 stale 恢复，绝不可省）；
 *   · 事务内选 enabled=1 且 next_run_at <= now 的候选（按 next_run_at 升序，最多 50 个）；
 *   · INSERT OR IGNORE 落 automation_runs（唯一索引 idx_automation_runs_scheduled 防重）；
 *     若该 (automation_id, scheduled_for) 已存在则跳过候选，绝不重复触发；
 *   · 成功后推进 next_run_at 并把定义置为 running。
 * 返回 { userId, automation, run }；没有可领取的返回 null。
 * options: { now?, staleAfterMs?, onStaleRecovered?(item) } —— staleAfterMs/回调透传给恢复步骤。
 */
function claimDueAutomation(options = {}) {
  const at = Number.isFinite(options.now) ? options.now : now();
  recoverStaleRuns({ now: at, staleAfterMs: options.staleAfterMs, onRecovered: options.onStaleRecovered });
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
  DEFAULT_STALE_AFTER_MS,
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
  recoverStaleRuns,
  staleRunMessage,
};
