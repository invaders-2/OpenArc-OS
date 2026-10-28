"use strict";

const PREFIX = "media.upload.litterbox.";
const DESTINATION = "Litterbox（catbox.moe）";
const RETENTION = "24h";
const MAX_BYTES = 200 * 1024 * 1024;
const AUDIT_ORIGIN = "https://litterbox.catbox.moe";
const AUDIT_PATH = "/resources/internals/api.php";

function createUploadConsentService({ identityStore, authorization, clock = () => Date.now() } = {}) {
  const db = identityStore && (identityStore.connection || identityStore.db);
  if (!db) throw new Error("createUploadConsentService 需要 identityStore 数据库连接");
  function actor(context) {
    if (!authorization || typeof authorization.resolveActor !== "function") return null;
    const result = authorization.resolveActor({ context });
    return result && result.ok === true && result.user && result.user.id != null ? result.user : null;
  }
  function userId(context) {
    const user = actor(context);
    if (!user) {
      const error = new Error("当前会话未认证，不能修改或执行第三方上传");
      error.code = "UPLOAD_UNAUTHENTICATED";
      throw error;
    }
    return String(user.id);
  }
  function allowed(ownerId) {
    const row = db.prepare("SELECT preference_value FROM system_preferences WHERE preference_key=?").get(PREFIX + ownerId);
    if (!row) return false;
    try { return JSON.parse(row.preference_value).allowed === true; } catch { return false; }
  }
  function audit(ownerId, status) {
    db.prepare("INSERT INTO app_network_audit(user_id,app_id,method,origin,pathname,status,response_bytes,credential_ref,created_at) VALUES (?,?,?,?,?,?,0,0,?)")
      .run(ownerId, "media", "UPLOAD_CONSENT", AUDIT_ORIGIN, AUDIT_PATH, status, clock());
  }
  function lastStatus(ownerId) {
    const row = db.prepare("SELECT status,created_at FROM app_network_audit WHERE user_id=? AND app_id='media' AND method='UPLOAD_CONSENT' ORDER BY id DESC LIMIT 1").get(ownerId);
    return row ? { status: row.status, at: row.created_at } : null;
  }
  function state(context) {
    const ownerId = userId(context);
    return { allowed: allowed(ownerId), provider: "litterbox", destination: DESTINATION, retention: RETENTION, maxBytes: MAX_BYTES, last: lastStatus(ownerId) };
  }
  function setAllowed(context, next) {
    const ownerId = userId(context);
    const value = next === true;
    db.prepare("INSERT INTO system_preferences(preference_key,preference_value,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(preference_key) DO UPDATE SET preference_value=excluded.preference_value,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
      .run(PREFIX + ownerId, JSON.stringify({ allowed: value, updatedAt: clock() }), ownerId, clock());
    audit(ownerId, value ? 1 : 2);
    return state(context);
  }
  function assertAllowed(context) {
    const ownerId = userId(context);
    if (!allowed(ownerId)) {
      const error = new Error("尚未授权把素材上传到第三方 Litterbox；模型授权不等于图床授权");
      error.code = "UPLOAD_CONSENT_REQUIRED";
      throw error;
    }
    return ownerId;
  }
  async function authorizedUpload(context, input, uploader) {
    const ownerId = assertAllowed(context);
    try {
      const result = await uploader(input);
      audit(ownerId, 3);
      return result;
    } catch (error) {
      audit(ownerId, 4);
      throw error;
    }
  }
  async function execute(command, payload, context = {}) {
    try {
      if (command === "uploadConsent/get") return { ok: true, value: state(context) };
      if (command === "uploadConsent/set") return { ok: true, value: setAllowed(context, payload && payload.allowed === true) };
      return { ok: false, error: "UPLOAD_CONSENT_COMMAND_NOT_ALLOWED" };
    } catch (error) {
      return { ok: false, error: String(error && error.code || "UPLOAD_CONSENT_FAILED"), message: String(error && error.message || error).slice(0, 300) };
    }
  }
  return { execute, state, setAllowed, assertAllowed, authorizedUpload };
}

module.exports = { createUploadConsentService, DESTINATION, RETENTION, MAX_BYTES };
