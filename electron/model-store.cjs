/** D4-01 · Model 持久层（只存 metadata；raw secret 只在 Credential Backend）。 */
"use strict";
const crypto = require("node:crypto");

const SQL = {
  insertProvider: "INSERT INTO model_providers (provider_id, organization_id, owner_user_id, scope, display_name, adapter_type, base_url, endpoint_scope, status, credential_ref, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)",
  providerById: "SELECT * FROM model_providers WHERE provider_id = ?",
  providersOfOrg: "SELECT * FROM model_providers WHERE organization_id = ? ORDER BY created_at",
  updateProvider: "UPDATE model_providers SET display_name = ?, adapter_type = ?, base_url = ?, endpoint_scope = ?, status = ?, credential_ref = ?, version = version + 1, updated_at = ? WHERE provider_id = ?",
  updateProviderCredential: "UPDATE model_providers SET credential_ref = ?, version = version + 1, updated_at = ? WHERE provider_id = ?",
  deleteProvider: "DELETE FROM model_providers WHERE provider_id = ?",
  insertConfig: "INSERT INTO model_configs (config_id, provider_id, organization_id, owner_user_id, scope, display_name, remote_model_id, capabilities, verified_capabilities, status, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,'enabled',1,?,?)",
  configById: "SELECT * FROM model_configs WHERE config_id = ?",
  configsOfOrg: "SELECT * FROM model_configs WHERE organization_id = ? ORDER BY created_at",
  updateConfig: "UPDATE model_configs SET display_name = ?, remote_model_id = ?, capabilities = ?, status = ?, version = version + 1, updated_at = ? WHERE config_id = ?",
  deleteConfig: "DELETE FROM model_configs WHERE config_id = ?",
  upsertDefault: "INSERT INTO model_defaults (organization_id, owner_user_id, capability, config_id, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(organization_id, owner_user_id, capability) DO UPDATE SET config_id = excluded.config_id, updated_at = excluded.updated_at",
  defaultOf: "SELECT * FROM model_defaults WHERE organization_id = ? AND owner_user_id = ? AND capability = ?",
  defaultsOfOrg: "SELECT * FROM model_defaults WHERE organization_id = ?",
  insertCredential: "INSERT INTO model_credentials (credential_ref, owner_user_id, organization_id, scope, provider_origin, provider_config_id, credential_version, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  credentialByRef: "SELECT * FROM model_credentials WHERE credential_ref = ?",
  updateCredential: "UPDATE model_credentials SET credential_version = ?, status = ?, updated_at = ? WHERE credential_ref = ?",
  insertCall: "INSERT INTO model_call_records (id, request_id, user_id, app_id, provider_id, model_id, config_version, started_at, duration_ms, status, error_code, input_tokens, output_tokens, total_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  callsOfOrg: "SELECT * FROM model_call_records ORDER BY started_at DESC LIMIT ?",
};

class ModelStore {
  constructor({ identity, clock } = {}) {
    if (!identity) throw new Error("ModelStore 需要 IdentityStore");
    this.identity = identity; this.db = identity.connection;
    this.clock = typeof clock === "function" ? clock : identity.clock;
  }
  transactSync(fn) { return this.identity.transactSync(fn); }

  insertProvider({ organizationId, ownerUserId = null, scope = "PERSONAL", displayName, adapterType = "openai-compatible", baseUrl, endpointScope, credentialRef = null, providerId = null }) {
    const id = providerId || "prv_" + crypto.randomBytes(10).toString("base64url"); const now = this.clock();
    this.db.prepare(SQL.insertProvider).run(id, String(organizationId), ownerUserId, String(scope), String(displayName || ""), String(adapterType), String(baseUrl), String(endpointScope), "enabled", credentialRef, now, now);
    return this.providerById(id);
  }
  providerById(id) { return this.db.prepare(SQL.providerById).get(String(id || "")) || null; }
  providersOfOrg(orgId) { return this.db.prepare(SQL.providersOfOrg).all(String(orgId || "")); }
  updateProvider(id, { displayName, adapterType, baseUrl, endpointScope, status, credentialRef }) {
    const c = this.providerById(id); if (!c) return null; const now = this.clock();
    this.db.prepare(SQL.updateProvider).run(displayName == null ? c.display_name : String(displayName), adapterType == null ? c.adapter_type : String(adapterType), baseUrl == null ? c.base_url : String(baseUrl), endpointScope == null ? c.endpoint_scope : String(endpointScope), status == null ? c.status : String(status), credentialRef === undefined ? c.credential_ref : credentialRef, now, String(id));
    return this.providerById(id);
  }
  setProviderCredential(id, credentialRef) { this.db.prepare(SQL.updateProviderCredential).run(credentialRef, this.clock(), String(id)); return this.providerById(id); }
  deleteProvider(id) { return { changed: this.db.prepare(SQL.deleteProvider).run(String(id || "")).changes > 0 }; }

  insertConfig({ providerId, organizationId, ownerUserId = null, scope = "PERSONAL", displayName = "", remoteModelId, capabilities = [] }) {
    const id = "mcf_" + crypto.randomBytes(10).toString("base64url"); const now = this.clock();
    this.db.prepare(SQL.insertConfig).run(id, String(providerId), String(organizationId), ownerUserId, String(scope), String(displayName || ""), String(remoteModelId), JSON.stringify(capabilities), JSON.stringify([]), now, now);
    return this.configById(id);
  }
  configById(id) { return this.db.prepare(SQL.configById).get(String(id || "")) || null; }
  configsOfOrg(orgId) { return this.db.prepare(SQL.configsOfOrg).all(String(orgId || "")); }
  updateConfig(id, { displayName, remoteModelId, capabilities, status, verifiedCapabilities }) {
    const c = this.configById(id); if (!c) return null; const now = this.clock();
    this.db.prepare(SQL.updateConfig).run(displayName == null ? c.display_name : String(displayName), remoteModelId == null ? c.remote_model_id : String(remoteModelId), capabilities == null ? c.capabilities : JSON.stringify(capabilities), status == null ? c.status : String(status), now, String(id));
    if (verifiedCapabilities) this.db.prepare("UPDATE model_configs SET verified_capabilities = ? WHERE config_id = ?").run(JSON.stringify(verifiedCapabilities), String(id));
    return this.configById(id);
  }
  deleteConfig(id) { return { changed: this.db.prepare(SQL.deleteConfig).run(String(id || "")).changes > 0 }; }

  setDefault({ organizationId, ownerUserId = "", capability, configId }) { this.db.prepare(SQL.upsertDefault).run(String(organizationId), String(ownerUserId || ""), String(capability), String(configId), this.clock()); return this.defaultOf({ organizationId, ownerUserId, capability }); }
  defaultOf({ organizationId, ownerUserId = "", capability }) { return this.db.prepare(SQL.defaultOf).get(String(organizationId), String(ownerUserId || ""), String(capability)) || null; }
  defaultsOfOrg(orgId) { return this.db.prepare(SQL.defaultsOfOrg).all(String(orgId || "")); }

  createCredentialMeta({ credentialRef, ownerUserId, organizationId, scope, providerOrigin, providerConfigId, version = 1, status = "CONFIGURED" }) {
    const now = this.clock();
    this.db.prepare(SQL.insertCredential).run(String(credentialRef), String(ownerUserId), String(organizationId), String(scope), String(providerOrigin), providerConfigId || null, Number(version), String(status), now, now);
    return this.credentialByRef(credentialRef);
  }
  credentialByRef(ref) { return this.db.prepare(SQL.credentialByRef).get(String(ref || "")) || null; }
  updateCredentialMeta(ref, { version, status }) {
    const c = this.credentialByRef(ref); if (!c) return null;
    this.db.prepare(SQL.updateCredential).run(version == null ? c.credential_version : Number(version), status == null ? c.status : String(status), this.clock(), String(ref));
    return this.credentialByRef(ref);
  }

  insertCall(rec) {
    const id = "mcall_" + crypto.randomBytes(10).toString("base64url");
    this.db.prepare(SQL.insertCall).run(id, rec.requestId || null, rec.userId || null, rec.appId || null, rec.providerId || null, rec.modelId || null, rec.configVersion == null ? null : Number(rec.configVersion), Number(rec.startedAt || this.clock()), rec.durationMs == null ? null : Number(rec.durationMs), String(rec.status || "UNKNOWN"), rec.errorCode || null, rec.inputTokens == null ? null : Number(rec.inputTokens), rec.outputTokens == null ? null : Number(rec.outputTokens), rec.totalTokens == null ? null : Number(rec.totalTokens));
    return id;
  }
  recentCalls(limit = 100) { return this.db.prepare(SQL.callsOfOrg).all(Math.max(1, Math.min(1000, Number(limit) || 100))); }
}

module.exports = { ModelStore, SQL };
