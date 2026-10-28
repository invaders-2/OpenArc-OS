"use strict";

function registerUploadConsentIpc({ ipcMain, service, identity, isTrusted } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerUploadConsentIpc 需要 ipcMain.handle");
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("uploadConsent:command"); } catch {} }
  ipcMain.handle("uploadConsent:command", async (event, raw) => {
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!service || typeof service.execute !== "function") return { ok: false, error: "UPLOAD_CONSENT_NOT_READY" };
    if (!raw || typeof raw !== "object") return { ok: false, error: "UPLOAD_CONSENT_INVALID_INPUT" };
    return service.execute(raw.command, raw.payload && typeof raw.payload === "object" ? raw.payload : {}, { sessionRef: identity && identity.current ? identity.current : null, appId: "settings", source: "settings" });
  });
  return { channel: "uploadConsent:command" };
}
function disposeUploadConsentIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("uploadConsent:command"); } catch {} }
}
module.exports = { registerUploadConsentIpc, disposeUploadConsentIpc };
