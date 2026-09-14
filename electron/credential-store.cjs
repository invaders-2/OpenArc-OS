/**
 * D4-01 · Credential Boundary（同步实现）。
 * 只保存 credentialRef；raw secret 只进 OS 安全后端；**禁止 plaintext fallback**。
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const domain = require("./model-domain.cjs");

function safeStorageCredentialBackend({ safeStorage, dir }) {
  const root = path.join(dir, "credentials");
  const file = (id) => path.join(root, id + ".bin");
  return {
    kind: "electron-safe-storage",
    available: () => !!safeStorage && safeStorage.isEncryptionAvailable() === true,
    put(id, secret) { const blob = safeStorage.encryptString(String(secret)); fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.writeFileSync(file(id), blob.toString("base64"), { mode: 0o600 }); try { fs.chmodSync(file(id), 0o600); } catch { /* ignore */ } return true; },
    get(id) { try { return safeStorage.decryptString(Buffer.from(fs.readFileSync(file(id), "utf8"), "base64")); } catch { return null; } },
    delete(id) { try { fs.rmSync(file(id), { force: true }); } catch { /* ignore */ } return true; },
    has(id) { try { return fs.statSync(file(id)).isFile(); } catch { return false; } },
  };
}
/** 仅测试注入；绝不作为生产 fallback。 */
function memoryCredentialBackend() {
  const map = new Map();
  return { kind: "memory-test-only", available: () => true, put(id, s) { map.set(id, String(s)); return true; }, get(id) { return map.has(id) ? map.get(id) : null; }, delete(id) { map.delete(id); return true; }, has(id) { return map.has(id); } };
}

class CredentialStore {
  constructor({ store, backend } = {}) { this.store = store; this.backend = backend || null; }
  available() { return !!this.backend && this.backend.available() === true; }
  createSync({ ownerUserId, organizationId, scope = "PERSONAL", providerOrigin, providerConfigId, secret }) {
    if (!this.available()) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_STORE_UNAVAILABLE };
    if (!secret || String(secret).length < 4) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    if (!providerOrigin) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    const credentialRef = "cred_" + crypto.randomBytes(12).toString("base64url");
    const meta = this.store.createCredentialMeta({ credentialRef, ownerUserId, organizationId, scope, providerOrigin, providerConfigId, version: 1, status: "CONFIGURED" });
    this.backend.put(credentialRef, secret);
    return { ok: true, credentialRef, credentialVersion: meta.credential_version, status: meta.status };
  }
  replaceSync({ credentialRef, secret }) {
    if (!this.available()) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_STORE_UNAVAILABLE };
    const meta = this.store.credentialByRef(credentialRef);
    if (!meta) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    if (!secret || String(secret).length < 4) return { ok: false, error: domain.ERROR_CODE.INVALID_INPUT };
    this.backend.put(credentialRef, secret);
    const next = this.store.updateCredentialMeta(credentialRef, { version: meta.credential_version + 1, status: "CONFIGURED" });
    return { ok: true, credentialRef, credentialVersion: next.credential_version, status: next.status };
  }
  deleteSync({ credentialRef }) {
    const meta = this.store.credentialByRef(credentialRef);
    if (!meta) return { ok: true, changed: false };
    this.backend.delete(credentialRef);
    this.store.updateCredentialMeta(credentialRef, { status: "DELETED" });
    return { ok: true, changed: true };
  }
  has({ credentialRef }) { const meta = this.store.credentialByRef(credentialRef); return { ok: true, configured: !!(meta && meta.status === "CONFIGURED" && this.available()) }; }
  resolveInternalSync({ credentialRef }) {
    if (!this.available()) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_STORE_UNAVAILABLE };
    const meta = this.store.credentialByRef(credentialRef);
    if (!meta || meta.status !== "CONFIGURED") return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_MISSING };
    const secret = this.backend.get(credentialRef);
    if (!secret) return { ok: false, error: domain.ERROR_CODE.CREDENTIAL_MISSING };
    return { ok: true, secret, credentialVersion: meta.credential_version, providerOrigin: meta.provider_origin, providerConfigId: meta.provider_config_id };
  }
}
module.exports = { CredentialStore, safeStorageCredentialBackend, memoryCredentialBackend };
