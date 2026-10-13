/**
 * P1 · DX OS 地基：配额预扣 / 结算原语。
 *
 * 为什么把预扣和结算放在一处：DX OS 的 apiQuota.ts 是先 reserve（按估价占用额度）
 * 再 settle（按任务终态释放或计入），两条语句必须共用同一张 api_quota_usage 表与
 * 同一套状态语义，拆开就会各写一套。
 *
 * 为什么缺表时直接报错：本地部署只有 identity.db 一条连接，配额表由 v22 迁移建立。
 * 表不在只可能是库没迁到位；此时静默返回"无限制"等于绕过配额（fail open），
 * 所以这里一律抛 DXOS_ERR_QUOTA_LEDGER_MISSING。
 */
"use strict";

const crypto = require("node:crypto");
const {
  createDxosError,
  DXOS_ERR_INVALID_INPUT,
  DXOS_ERR_CONFLICT,
  DXOS_ERR_QUOTA_EXCEEDED,
  DXOS_ERR_QUOTA_LEDGER_MISSING,
} = require("./dxos-foundation-errors.cjs");
const { DXOS_QUOTA_TABLES } = require("./dxos-foundation-schema.cjs");

/** 与 apiQuota.ts:276-277 对齐：只有 reserved 会流转成 spent / released。 */
const QUOTA_STATUS = Object.freeze({ RESERVED: "reserved", SPENT: "spent", RELEASED: "released" });
const SETTLE_OUTCOMES = Object.freeze(["completed", "failed", "cancelled", "released"]);

function assertMicros(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw createDxosError(DXOS_ERR_INVALID_INPUT, field + " 必须是正的安全整数（微元）");
  return value;
}

function assertId(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw createDxosError(DXOS_ERR_INVALID_INPUT, field + " 必须是非空字符串");
  return value;
}

function createQuotaLedger(options = {}) {
  const db = options.db;
  if (!db || typeof db.prepare !== "function") throw createDxosError(DXOS_ERR_INVALID_INPUT, "配额账本需要共享 SQLite 连接（DatabaseSync）");
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : () => crypto.randomUUID();

  function missingTables() {
    const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
    return DXOS_QUOTA_TABLES.filter((name) => !present.has(name));
  }

  function assertReady() {
    const missing = missingTables();
    if (missing.length) {
      throw createDxosError(DXOS_ERR_QUOTA_LEDGER_MISSING, "配额账本表缺失，identity.db 可能未迁移到 v22", { tables: missing });
    }
    return true;
  }

  /** 预扣：插入一条 reserved 用量；同一 id 重复预扣按冲突拒绝（任务 id 即用量 id）。 */
  function reserve(input = {}) {
    assertReady();
    const id = input.id == null ? idFactory() : assertId(input.id, "id");
    const ownerId = assertId(input.ownerId, "ownerId");
    const departmentId = assertId(input.departmentId, "departmentId");
    const providerId = assertId(input.providerId, "providerId");
    const modelId = assertId(input.modelId, "modelId");
    const amount = assertMicros(input.amountMicros, "amountMicros");
    const now = Number.isFinite(input.now) ? input.now : clock();
    const existing = db.prepare("SELECT * FROM api_quota_usage WHERE id=?").get(id);
    if (existing) throw createDxosError(DXOS_ERR_CONFLICT, "配额请求编号已使用", { id });
    // 显式 limitMicros 是"总额度"，remainingMicros() 给的是"剩余额度" —— 语义不同，
    // 混用会二次扣减（先减已用、再拿已用去比）。
    if (Number.isFinite(input.limitMicros)) {
      const used = usageFor({ departmentId, providerId });
      if (used + amount > input.limitMicros) {
        throw createDxosError(DXOS_ERR_QUOTA_EXCEEDED, "部门配额不足", { remainingMicros: Math.max(0, input.limitMicros - used) });
      }
    } else {
      const remaining = remainingMicros({ departmentId, providerId });
      if (remaining != null && amount > remaining) {
        throw createDxosError(DXOS_ERR_QUOTA_EXCEEDED, "部门配额不足", { remainingMicros: remaining });
      }
    }
    db.prepare("INSERT INTO api_quota_usage (id,owner_id,department_id,provider_id,model_id,amount,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, ownerId, departmentId, providerId, modelId, amount, QUOTA_STATUS.RESERVED, now, now);
    return { id, amountMicros: amount, status: QUOTA_STATUS.RESERVED, createdAt: now, updatedAt: now };
  }

  /** 结算：completed -> spent，其余终态 -> released（释放额度）。只结算仍为 reserved 的行。 */
  function settle(id, outcome) {
    assertReady();
    assertId(id, "id");
    if (!SETTLE_OUTCOMES.includes(outcome)) throw createDxosError(DXOS_ERR_INVALID_INPUT, "未知结算状态：" + String(outcome));
    const next = outcome === "completed" ? QUOTA_STATUS.SPENT : QUOTA_STATUS.RELEASED;
    const result = db.prepare("UPDATE api_quota_usage SET status=?,updated_at=? WHERE id=? AND status=?").run(next, clock(), id, QUOTA_STATUS.RESERVED);
    return { id, status: next, changed: Number(result && result.changes ? result.changes : 0) };
  }

  /** 已占用额度（微元）：reserved + spent，不含 released。 */
  function usageFor(input = {}) {
    assertReady();
    const departmentId = assertId(input.departmentId, "departmentId");
    const providerId = input.providerId == null ? null : String(input.providerId);
    const row = db.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM api_quota_usage WHERE department_id=? AND (? IS NULL OR provider_id=?) AND status<>?")
      .get(departmentId, providerId, providerId, QUOTA_STATUS.RELEASED);
    return Number(row && row.amount ? row.amount : 0);
  }

  /**
   * 规则允许的剩余额度（微元）；没有任何适用规则返回 null（= 不限额）。
   * 部门总额度规则（provider_id='')与平台规则同时存在时取更紧的那个 —— 与 apiQuota.ts:256-262
   * 逐条判定的结果一致。
   */
  function remainingMicros(input = {}) {
    assertReady();
    const departmentId = assertId(input.departmentId, "departmentId");
    const providerId = input.providerId == null ? null : String(input.providerId);
    const rules = db.prepare("SELECT * FROM api_quota_rules WHERE department_id=? AND (provider_id='' OR provider_id=?)").all(departmentId, providerId);
    if (!rules.length) return null;
    let remaining = Infinity;
    for (const rule of rules) {
      const used = rule.provider_id === ""
        ? db.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM api_quota_usage WHERE department_id=? AND status<>?").get(departmentId, QUOTA_STATUS.RELEASED).amount
        : db.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM api_quota_usage WHERE department_id=? AND provider_id=? AND status<>?").get(departmentId, rule.provider_id, QUOTA_STATUS.RELEASED).amount;
      remaining = Math.min(remaining, Number(rule.limit_amount) - Number(used));
    }
    return Math.max(0, remaining);
  }

  function rowFor(id) {
    assertReady();
    return db.prepare("SELECT * FROM api_quota_usage WHERE id=?").get(assertId(id, "id")) || null;
  }

  function listRules() {
    assertReady();
    return db.prepare("SELECT * FROM api_quota_rules ORDER BY department_id, provider_id").all();
  }

  /** 规则写入：limit=0 表示该部门/平台不启用配额。 */
  function saveRule(departmentId, providerId, limitMicros) {
    assertReady();
    assertId(departmentId, "departmentId");
    if (typeof providerId !== "string") throw createDxosError(DXOS_ERR_INVALID_INPUT, "providerId 必须是字符串（空串表示部门总额度）");
    if (!Number.isSafeInteger(limitMicros) || limitMicros < 0) throw createDxosError(DXOS_ERR_INVALID_INPUT, "limitMicros 必须是非负安全整数");
    db.prepare("INSERT INTO api_quota_rules (department_id,provider_id,limit_amount,updated_at) VALUES (?,?,?,?) ON CONFLICT(department_id,provider_id) DO UPDATE SET limit_amount=excluded.limit_amount,updated_at=excluded.updated_at")
      .run(departmentId, providerId, limitMicros, clock());
    return { departmentId, providerId, limitMicros };
  }

  function removeRule(departmentId, providerId) {
    assertReady();
    db.prepare("DELETE FROM api_quota_rules WHERE department_id=? AND provider_id=?").run(assertId(departmentId, "departmentId"), String(providerId));
  }

  return { assertReady, missingTables, reserve, settle, usageFor, remainingMicros, rowFor, listRules, saveRule, removeRule };
}

module.exports = { QUOTA_STATUS, SETTLE_OUTCOMES, DXOS_QUOTA_TABLES, createQuotaLedger };
