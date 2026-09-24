/**
 * D5-03 第一批 · MCP 持久层（SQLite；与 identity/authorization/model 共用同一条连接）。
 *
 * 只做记录读写：状态机判定、白名单校验、投影都在 mcp-domain / mcp-service。
 * raw secret 永不落库 —— 这里只有 credential_ref（真值在 OS 安全后端，见 credential-store.cjs）。
 */
"use strict";

const crypto = require("node:crypto");

const LOG_KEEP = 50;

const SQL = {
  insertConnection:
    "INSERT INTO mcp_connections (connection_id, organization_id, owner_user_id, visibility, name, transport, location, endpoint_json, auth_mode, credential_ref, enabled, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  connectionById: "SELECT * FROM mcp_connections WHERE connection_id = ?",
  connectionsOfOrg: "SELECT * FROM mcp_connections WHERE organization_id = ? ORDER BY created_at",
  deleteConnection: "DELETE FROM mcp_connections WHERE connection_id = ?",
  insertCredential:
    "INSERT INTO mcp_credentials (credential_ref, owner_user_id, organization_id, scope, provider_origin, provider_config_id, credential_version, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  credentialByRef: "SELECT * FROM mcp_credentials WHERE credential_ref = ?",
  updateCredential: "UPDATE mcp_credentials SET credential_version = ?, status = ?, updated_at = ? WHERE credential_ref = ?",
  insertLog: "INSERT INTO mcp_connection_logs (connection_id, at, level, event, error_code, detail) VALUES (?,?,?,?,?,?)",
  logsOfConnection: "SELECT * FROM mcp_connection_logs WHERE connection_id = ? ORDER BY at DESC, id DESC LIMIT ?",
  pruneLogs: "DELETE FROM mcp_connection_logs WHERE connection_id = ? AND id NOT IN (SELECT id FROM mcp_connection_logs WHERE connection_id = ? ORDER BY at DESC, id DESC LIMIT ?)",
  deleteLogs: "DELETE FROM mcp_connection_logs WHERE connection_id = ?",
};

/** 可写列白名单：渲染层给不了表名/列名，也不存在动态 SQL 拼接面。 */
const COLUMNS = Object.freeze({
  name: "name",
  transport: "transport",
  location: "location",
  endpointJson: "endpoint_json",
  authMode: "auth_mode",
  credentialRef: "credential_ref",
  enabled: "enabled",
  status: "status",
  lastErrorCode: "last_error_code",
  protocolVersion: "protocol_version",
  serverName: "server_name",
  serverVersion: "server_version",
  capabilitiesJson: "capabilities_json",
  toolsJson: "tools_json",
  toolsHash: "tools_hash",
  lastConnectedAt: "last_connected_at",
  visibility: "visibility",
});

class McpStore {
  constructor({ identity, clock } = {}) {
    if (!identity) throw new Error("McpStore 需要 IdentityStore");
    this.identity = identity;
    this.db = identity.connection;
    this.clock = typeof clock === "function" ? clock : identity.clock;
  }
  transactSync(fn) {
    return this.identity.transactSync(fn);
  }

  insertConnection({ organizationId, ownerUserId = null, visibility = "PERSONAL", name, transport, location, endpointJson, authMode = "NONE", credentialRef = null, enabled = false, status = "DISABLED", connectionId = null }) {
    const id = connectionId || "mcp_" + crypto.randomBytes(10).toString("base64url");
    const now = this.clock();
    this.db.prepare(SQL.insertConnection).run(id, String(organizationId), ownerUserId, String(visibility), String(name || ""), String(transport), String(location), String(endpointJson), String(authMode), credentialRef, enabled ? 1 : 0, String(status), now, now);
    return this.connectionById(id);
  }

  connectionById(id) {
    return this.db.prepare(SQL.connectionById).get(String(id || "")) || null;
  }

  connectionsOfOrg(orgId) {
    return this.db.prepare(SQL.connectionsOfOrg).all(String(orgId || ""));
  }

  /** 白名单列的局部更新；value === undefined 表示"这次不改这一列"。 */
  updateConnection(id, patch = {}) {
    const current = this.connectionById(id);
    if (!current) return null;
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(COLUMNS)) {
      if (!(key in patch) || patch[key] === undefined) continue;
      sets.push(column + " = ?");
      const v = patch[key];
      values.push(key === "enabled" ? (v ? 1 : 0) : v === null ? null : String(v));
    }
    if (!sets.length) return current;
    sets.push("updated_at = ?");
    values.push(this.clock());
    this.db.prepare("UPDATE mcp_connections SET " + sets.join(", ") + " WHERE connection_id = ?").run(...values, String(id));
    return this.connectionById(id);
  }

  deleteConnection(id) {
    return { changed: this.db.prepare(SQL.deleteConnection).run(String(id || "")).changes > 0 };
  }

  // ---- 凭据元数据（与 credential-store.cjs 的 CredentialStore 契约一致） ----
  createCredentialMeta({ credentialRef, ownerUserId, organizationId, scope = "PERSONAL", providerOrigin, providerConfigId = null, version = 1, status = "CONFIGURED" }) {
    const now = this.clock();
    this.db.prepare(SQL.insertCredential).run(String(credentialRef), String(ownerUserId), String(organizationId), String(scope), String(providerOrigin), providerConfigId || null, Number(version), String(status), now, now);
    return this.credentialByRef(credentialRef);
  }

  credentialByRef(ref) {
    return this.db.prepare(SQL.credentialByRef).get(String(ref || "")) || null;
  }

  updateCredentialMeta(ref, { version, status }) {
    const c = this.credentialByRef(ref);
    if (!c) return null;
    this.db.prepare(SQL.updateCredential).run(version == null ? c.credential_version : Number(version), status == null ? c.status : String(status), this.clock(), String(ref));
    return this.credentialByRef(ref);
  }

  // ---- 连接日志（有界保留，支撑 UI 的测试日志面板） ----
  appendLog({ connectionId, level = "INFO", event, errorCode = null, detail = null }) {
    const id = this.db.prepare(SQL.insertLog).run(String(connectionId), this.clock(), String(level), String(event), errorCode || null, detail == null ? null : String(detail)).lastInsertRowid;
    try {
      this.db.prepare(SQL.pruneLogs).run(String(connectionId), String(connectionId), LOG_KEEP);
    } catch {
      /* 日志裁剪失败不影响主流程；上限仍由 logsOfConnection 的 LIMIT 兜底 */
    }
    return Number(id);
  }

  deleteLogsOfConnection(connectionId) {
    return { changed: this.db.prepare(SQL.deleteLogs).run(String(connectionId || "")).changes > 0 };
  }

  logsOfConnection(connectionId, limit = 20) {
    const n = Math.max(1, Math.min(LOG_KEEP, Number(limit) || 20));
    return this.db.prepare(SQL.logsOfConnection).all(String(connectionId || ""), n);
  }
}

module.exports = { McpStore, SQL, COLUMNS, LOG_KEEP };
