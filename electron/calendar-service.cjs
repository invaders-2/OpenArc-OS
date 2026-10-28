"use strict";

const { CalendarStore } = require("./calendar-store.cjs");
const { CODES, createCalendarError, normalizeCalendarError, isCalendarCommand } = require("./calendar-domain.cjs");

function createCalendarBundle({ identityStore, authorization, clock = null, idFactory = null } = {}) {
  const db = identityStore && (identityStore.connection || identityStore.db);
  if (!db) throw new Error("createCalendarBundle 需要 identityStore 数据库连接");
  const store = new CalendarStore({ db, clock: clock || undefined, idFactory: idFactory || undefined });

  function actor(context) {
    if (!authorization || typeof authorization.resolveActor !== "function") return null;
    const result = authorization.resolveActor({ context });
    return result && result.ok === true && result.user && result.user.id != null ? result.user : null;
  }
  async function execute(command, payload, ctx = {}) {
    if (!isCalendarCommand(command)) return normalizeCalendarError(createCalendarError(CODES.COMMAND_NOT_ALLOWED, "未知日历命令：" + command));
    const context = { sessionRef: typeof ctx.sessionRef === "string" ? ctx.sessionRef : null, appId: "calendar", source: "calendar" };
    const user = actor(context);
    if (!user) return normalizeCalendarError(createCalendarError(CODES.UNAUTHENTICATED, "当前会话未认证，calendar 命令被拒绝"));
    const ownerId = String(user.id);
    const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    try {
      switch (command) {
        case "calendar/event/list": return { ok: true, value: { items: store.list(ownerId) } };
        case "calendar/event/create": return { ok: true, value: { event: store.create(ownerId, body.event && typeof body.event === "object" ? body.event : body) } };
        case "calendar/event/update": {
          const id = typeof body.id === "string" ? body.id : "";
          if (!id) throw createCalendarError(CODES.INVALID_INPUT, "日程 id 必填");
          const patch = body.patch && typeof body.patch === "object" && !Array.isArray(body.patch) ? body.patch : {};
          delete patch.id;
          delete patch.ownerId;
          delete patch.ownerUserId;
          delete patch.version;
          return { ok: true, value: { event: store.update(ownerId, id, patch, body.expectedVersion) } };
        }
        case "calendar/event/delete": {
          const id = typeof body.id === "string" ? body.id : "";
          if (!id) throw createCalendarError(CODES.INVALID_INPUT, "日程 id 必填");
          return { ok: true, value: { deleted: store.delete(ownerId, id, body.expectedVersion) } };
        }
        case "calendar/event/import-legacy": return { ok: true, value: store.importLegacy(ownerId, body.events) };
        default: throw createCalendarError(CODES.COMMAND_NOT_ALLOWED, "未知日历命令");
      }
    } catch (error) {
      return normalizeCalendarError(error);
    }
  }
  return { execute, store };
}

module.exports = { createCalendarBundle };
