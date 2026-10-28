"use strict";

const { randomUUID, createHash } = require("node:crypto");
const { createCalendarError, CODES } = require("./calendar-domain.cjs");

const CALENDAR_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS calendar_events (
    owner_id TEXT NOT NULL,
    id TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    reminder_minutes INTEGER,
    reminded_at INTEGER,
    missed INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_calendar_events_owner_date ON calendar_events(owner_id, date, time)",
]);

function applyCalendarLayer(db) {
  for (const statement of CALENDAR_DDL) db.exec(statement);
}
function text(value, max = 500) {
  return typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max);
}
function normalizeEvent(input, idFactory = randomUUID) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const date = text(source.date, 10);
  const time = text(source.time, 5);
  const title = text(source.title, 500).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw createCalendarError(CODES.INVALID_INPUT, "日程日期必须是 YYYY-MM-DD");
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw createCalendarError(CODES.INVALID_INPUT, "日程时间必须是 HH:MM 或留空");
  if (!title) throw createCalendarError(CODES.INVALID_INPUT, "日程标题不能为空");
  const reminderMinutes = source.reminderMinutes == null ? null : Number(source.reminderMinutes);
  if (reminderMinutes != null && (!Number.isFinite(reminderMinutes) || reminderMinutes < 0 || reminderMinutes > 525600)) {
    throw createCalendarError(CODES.INVALID_INPUT, "提前提醒分钟数无效");
  }
  const remindedAt = source.remindedAt == null ? null : Number(source.remindedAt);
  return {
    id: text(source.id, 128) || idFactory(),
    date,
    time,
    title,
    reminderMinutes: reminderMinutes == null ? null : Math.round(reminderMinutes),
    remindedAt: remindedAt != null && Number.isFinite(remindedAt) ? remindedAt : null,
    missed: source.missed === true,
  };
}
function legacyId(event) {
  if (text(event && event.id, 128)) return text(event.id, 128);
  const digest = createHash("sha256").update(JSON.stringify([event.date, event.time, event.title, event.reminderMinutes ?? null])).digest("hex").slice(0, 24);
  return "legacy_" + digest;
}
function view(row) {
  return {
    id: row.id,
    date: row.date,
    time: row.time,
    title: row.title,
    reminderMinutes: row.reminder_minutes,
    remindedAt: row.reminded_at,
    missed: row.missed === 1,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

class CalendarStore {
  constructor({ db, clock = () => Date.now(), idFactory = randomUUID } = {}) {
    if (!db) throw new Error("CalendarStore 需要 db");
    this.db = db;
    this.clock = clock;
    this.idFactory = idFactory;
  }
  list(ownerId) {
    return this.db.prepare("SELECT * FROM calendar_events WHERE owner_id=? ORDER BY date,time,created_at").all(ownerId).map(view);
  }
  get(ownerId, id) {
    const row = this.db.prepare("SELECT * FROM calendar_events WHERE owner_id=? AND id=?").get(ownerId, id);
    return row ? view(row) : null;
  }
  create(ownerId, input) {
    const event = normalizeEvent(input, this.idFactory);
    const ts = this.clock();
    this.db.prepare("INSERT INTO calendar_events(owner_id,id,date,time,title,reminder_minutes,reminded_at,missed,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)")
      .run(ownerId, event.id, event.date, event.time, event.title, event.reminderMinutes, event.remindedAt, event.missed ? 1 : 0, ts, ts);
    return this.get(ownerId, event.id);
  }
  update(ownerId, id, patch, expectedVersion) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw createCalendarError(CODES.INVALID_INPUT, "更新日程需要 expectedVersion");
    const current = this.get(ownerId, id);
    if (!current) throw createCalendarError(CODES.NOT_FOUND, "日程不存在或无权访问");
    if (current.version !== expectedVersion) throw createCalendarError(CODES.CONFLICT, "日程已被其他窗口修改，请重新读取", { expectedVersion, currentVersion: current.version });
    const event = normalizeEvent({ ...current, ...patch, id }, this.idFactory);
    const changed = this.db.prepare("UPDATE calendar_events SET date=?,time=?,title=?,reminder_minutes=?,reminded_at=?,missed=?,version=version+1,updated_at=? WHERE owner_id=? AND id=? AND version=?")
      .run(event.date, event.time, event.title, event.reminderMinutes, event.remindedAt, event.missed ? 1 : 0, this.clock(), ownerId, id, expectedVersion).changes;
    if (!changed) throw createCalendarError(CODES.CONFLICT, "日程版本冲突，请重新读取");
    return this.get(ownerId, id);
  }
  delete(ownerId, id, expectedVersion) {
    if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) throw createCalendarError(CODES.INVALID_INPUT, "expectedVersion 无效");
    const changed = expectedVersion === undefined
      ? this.db.prepare("DELETE FROM calendar_events WHERE owner_id=? AND id=?").run(ownerId, id).changes
      : this.db.prepare("DELETE FROM calendar_events WHERE owner_id=? AND id=? AND version=?").run(ownerId, id, expectedVersion).changes;
    if (!changed) {
      const current = this.get(ownerId, id);
      throw createCalendarError(current ? CODES.CONFLICT : CODES.NOT_FOUND, current ? "日程版本冲突，请重新读取" : "日程不存在或无权访问");
    }
    return true;
  }
  importLegacy(ownerId, inputs) {
    if (!Array.isArray(inputs) || inputs.length > 5000) throw createCalendarError(CODES.INVALID_INPUT, "旧日程必须是至多 5000 条的数组");
    const events = inputs.map((input) => normalizeEvent({ ...input, id: legacyId(input) }, this.idFactory));
    let imported = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const ts = this.clock();
      const statement = this.db.prepare("INSERT INTO calendar_events(owner_id,id,date,time,title,reminder_minutes,reminded_at,missed,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(owner_id,id) DO NOTHING");
      for (const event of events) imported += statement.run(ownerId, event.id, event.date, event.time, event.title, event.reminderMinutes, event.remindedAt, event.missed ? 1 : 0, ts, ts).changes;
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return { imported, skipped: events.length - imported, items: this.list(ownerId) };
  }
}

module.exports = { CALENDAR_DDL, applyCalendarLayer, CalendarStore, normalizeEvent };
