"use strict";

const { isCalendarCommand, CODES, createCalendarError, normalizeCalendarError } = require("./calendar-domain.cjs");

function registerCalendarIpc({ ipcMain, bundle, identity, isTrusted } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerCalendarIpc 需要 ipcMain.handle");
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("calendar:command"); } catch {} }
  ipcMain.handle("calendar:command", async (event, raw) => {
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!bundle || typeof bundle.execute !== "function") return { ok: false, error: "CALENDAR_NOT_READY", message: "日历域尚未装配" };
    if (!raw || typeof raw !== "object") return normalizeCalendarError(createCalendarError(CODES.INVALID_INPUT, "calendar:command 需要对象载荷"));
    const command = typeof raw.command === "string" ? raw.command : raw.type;
    if (!isCalendarCommand(command)) return normalizeCalendarError(createCalendarError(CODES.COMMAND_NOT_ALLOWED, "未知日历命令：" + command));
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    return bundle.execute(command, payload, { sessionRef: identity && identity.current ? identity.current : null });
  });
  return { channel: "calendar:command" };
}
function disposeCalendarIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("calendar:command"); } catch {} }
}
module.exports = { registerCalendarIpc, disposeCalendarIpc };
