"use strict";

const foundationErrors = require("./dxos-foundation-errors.cjs");

const CALENDAR_COMMANDS = Object.freeze({
  "calendar/event/list": { risk: "read" },
  "calendar/event/create": { risk: "manage" },
  "calendar/event/update": { risk: "manage" },
  "calendar/event/delete": { risk: "destructive" },
  "calendar/event/import-legacy": { risk: "manage" },
});
const CODES = Object.freeze({
  INVALID_INPUT: "CALENDAR_INVALID_INPUT",
  UNAUTHENTICATED: "CALENDAR_UNAUTHENTICATED",
  NOT_FOUND: "CALENDAR_NOT_FOUND",
  CONFLICT: "CALENDAR_CONFLICT",
  COMMAND_NOT_ALLOWED: "CALENDAR_COMMAND_NOT_ALLOWED",
  INTERNAL: "CALENDAR_INTERNAL",
});

function createCalendarError(code, message, detail) {
  const error = new Error(foundationErrors.redactText(message || code));
  error.code = Object.values(CODES).includes(code) ? code : CODES.INTERNAL;
  if (detail !== undefined) error.detail = foundationErrors.redactValue(detail);
  return error;
}
function normalizeCalendarError(error) {
  if (error && Object.values(CODES).includes(error.code)) {
    const result = { ok: false, error: error.code, message: foundationErrors.redactText(error.message || error.code) };
    if (error.detail !== undefined) result.detail = foundationErrors.redactValue(error.detail);
    return result;
  }
  return foundationErrors.normalizeError(error, { fallbackCode: CODES.INTERNAL });
}
function isCalendarCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(CALENDAR_COMMANDS, command);
}
function listCalendarCommands() {
  return Object.entries(CALENDAR_COMMANDS).map(([command, entry]) => ({ command, risk: entry.risk, needsCredential: false }));
}

module.exports = { CALENDAR_COMMANDS, CODES, createCalendarError, normalizeCalendarError, isCalendarCommand, listCalendarCommands };
