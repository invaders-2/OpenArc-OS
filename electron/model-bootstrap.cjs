/**
 * D4-01 · Model 装配 + `model:command` IPC（Closure A）。
 *
 * 单一 Renderer 入口：window.openarc.model.command(...) → ipcMain "model:command"。
 * 显式命令白名单 + 静态 switch dispatch（不做动态 modelService[command] 调用）。
 * actor sessionRef / appId 一律由可信主进程决定，忽略 Renderer 自报的 userId/appId/role。
 * 绝不暴露 credential raw / credentialRef / proxy capability / raw HTTP / raw SQL。
 */
"use strict";
const { ModelStore } = require("./model-store.cjs");
const { CredentialStore, safeStorageCredentialBackend } = require("./credential-store.cjs");
const { ModelService } = require("./model-service.cjs");
const { ModelProxy } = require("./model-proxy.cjs");

const HOST_APP_ID = "resource-library";

function createModelBundle({ identityStore, authorization, authStore, userDataDir, safeStorage = null, fetchImpl = fetch, clock = null, logger = null } = {}) {
  if (!identityStore) throw new Error("createModelBundle 需要 identityStore");
  if (!authorization) throw new Error("createModelBundle 需要 authorization");
  if (!authStore) throw new Error("createModelBundle 需要 authStore");
  const modelStore = new ModelStore({ identity: identityStore, clock });
  // 生产路径只用 OS 安全后端；safeStorage 不可用 → credentialStore 不可用（无明文 fallback）。
  const backend = safeStorage ? safeStorageCredentialBackend({ safeStorage, dir: userDataDir }) : null;
  const credentialStore = new CredentialStore({ store: modelStore, backend });
  const modelService = new ModelService({ identity: identityStore, authService: authorization, authStore, modelStore, credentialStore, fetchImpl, clock, logger });
  const modelProxy = new ModelProxy({ modelService, clock: clock || (() => Date.now()), logger });
  // 内置 Model App baseline：resource-library 可管理/测试，ai 可用；其余 App 默认 DENY。
  try {
    const admin = identityStore.allUsers().find((u) => u.role === "ADMIN") || null;
    const orgId = admin ? admin.team_id : (identityStore.allTeams()[0] ? identityStore.allTeams()[0].id : "");
    const seed = (appId, actions) => { if (authStore.appById(appId)) authStore.upsertAppGrant({ appId, resourceType: "model", actions, grantedBy: "system:model-baseline", organizationId: orgId }); };
    seed("resource-library", ["model.view", "model.use", "model.manage", "model.test"]);
    seed("ai", ["model.view", "model.use", "model.test"]);
  } catch { /* baseline 失败不阻塞装配 */ }
  return { modelStore, credentialStore, modelService, modelProxy };
}

/** Renderer 白名单。新增能力必须显式登记；未知命令一律 MODEL_COMMAND_NOT_ALLOWED。 */
const MODEL_COMMANDS = Object.freeze([
  "provider/list", "provider/create", "provider/update", "provider/setStatus", "provider/delete",
  "credential/status", "credential/set", "credential/replace", "credential/delete",
  "model/list", "model/create", "model/update", "model/setStatus",
  "defaults/get", "defaults/set",
  "model/test",
]);
const MODEL_COMMAND_NOT_ALLOWED = "MODEL_COMMAND_NOT_ALLOWED";

const asStr = (v, max = 512) => (typeof v === "string" ? v.slice(0, max) : v == null ? undefined : String(v).slice(0, max));
const requireStr = (v, max = 512) => { const s = asStr(v, max); return s && s.length ? s : null; };

function registerModelIpc({ ipcMain, service, identity, isTrusted, hostAppId = HOST_APP_ID }) {
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("model:command"); } catch { /* not registered */ } }
  ipcMain.handle("model:command", async (e, raw) => {
    if (isTrusted && !isTrusted(e)) throw Error("Forbidden");
    if (!service) return { ok: false, error: "INTERNAL_ERROR", detail: "model-not-ready" };
    if (!raw || typeof raw !== "object") return { ok: false, error: "INVALID_INPUT" };
    const command = raw.command != null ? asStr(raw.command, 80) : asStr(raw.type, 80);
    if (!MODEL_COMMANDS.includes(command)) return { ok: false, error: MODEL_COMMAND_NOT_ALLOWED, detail: asStr(command, 80) || null };
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    // actor/app 一律来自可信宿主，忽略 payload.userId / payload.appId / payload.role
    const context = { sessionRef: identity?.current ?? null, appId: hostAppId, source: "ui", requestId: asStr(payload.requestId, 80) };
    const secret = typeof payload.secret === "string" ? payload.secret.slice(0, 4096) : null;
    const credentialSecret = typeof payload.credentialSecret === "string" ? payload.credentialSecret.slice(0, 4096) : null;
    try {
      switch (command) {
        case "provider/list": return service.listProviders({ context });
        case "provider/create": {
          const baseUrl = requireStr(payload.baseUrl, 2048);
          if (!baseUrl) return { ok: false, error: "INVALID_INPUT" };
          return service.createProvider({ context, displayName: asStr(payload.displayName, 200), baseUrl, adapterType: asStr(payload.adapterType, 60), endpointScope: asStr(payload.endpointScope, 30), allowLan: !!payload.allowLan, scope: asStr(payload.scope, 20), credentialSecret });
        }
        case "provider/update": return service.updateProvider({ context, providerId: requireStr(payload.providerId, 120), displayName: asStr(payload.displayName, 200), baseUrl: asStr(payload.baseUrl, 2048), endpointScope: asStr(payload.endpointScope, 30), status: asStr(payload.status, 20), allowLan: !!payload.allowLan, credentialSecret });
        case "provider/setStatus": return service.setProviderStatus({ context, providerId: requireStr(payload.providerId, 120), status: asStr(payload.status, 20) });
        case "provider/delete": return service.deleteProvider({ context, providerId: requireStr(payload.providerId, 120) });
        case "credential/status": return service.credentialStatusForProvider({ context, providerId: requireStr(payload.providerId, 120) });
        case "credential/set": return service.setProviderCredential({ context, providerId: requireStr(payload.providerId, 120), secret });
        case "credential/replace": return service.replaceProviderCredential({ context, providerId: requireStr(payload.providerId, 120), secret });
        case "credential/delete": return service.deleteProviderCredential({ context, providerId: requireStr(payload.providerId, 120) });
        case "model/list": return service.listModels({ context });
        case "model/create": {
          const remoteModelId = requireStr(payload.remoteModelId, 200);
          if (!remoteModelId) return { ok: false, error: "INVALID_INPUT" };
          return service.createModel({ context, providerId: requireStr(payload.providerId, 120), remoteModelId, displayName: asStr(payload.displayName, 200), capabilities: Array.isArray(payload.capabilities) ? payload.capabilities.slice(0, 16).map((c) => asStr(c, 40)) : [], scope: asStr(payload.scope, 20) });
        }
        case "model/update": return service.updateModel({ context, configId: requireStr(payload.configId, 120), displayName: asStr(payload.displayName, 200), capabilities: Array.isArray(payload.capabilities) ? payload.capabilities.slice(0, 16).map((c) => asStr(c, 40)) : null });
        case "model/setStatus": return service.setModelStatus({ context, configId: requireStr(payload.configId, 120), status: asStr(payload.status, 20) });
        case "defaults/get": return service.getDefaults({ context });
        case "defaults/set": return service.setDefault({ context, capability: requireStr(payload.capability, 40), configId: requireStr(payload.configId, 120), scope: asStr(payload.scope, 20) });
        case "model/test": return service.testConnection({ context, configId: requireStr(payload.configId, 120) });
        default: return { ok: false, error: MODEL_COMMAND_NOT_ALLOWED };
      }
    } catch {
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  });
}

function disposeModelIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("model:command"); } catch { /* ignore */ } }
}

module.exports = { createModelBundle, registerModelIpc, disposeModelIpc, MODEL_COMMANDS, MODEL_COMMAND_NOT_ALLOWED, HOST_APP_ID };
