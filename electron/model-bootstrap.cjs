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
const { createProviderProtocolBundle } = require("./provider-protocol-service.cjs");
const { createModelProviderBridge } = require("./model-provider-bridge.cjs");

// Settings / Models 由 shell 拥有的系统 App Principal 承载；不借 resource-library 的权限。
const HOST_APP_ID = "settings";

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
  // P2：DX OS 供应商/协议域。挂到 modelService 上，让 registerModelIpc 不必改签名
  // （identity-bootstrap.cjs 不在本任务 write scope 内）。
  const providerProtocol = createProviderProtocolBundle({ userDataDir, fetchImpl, clock: clock || (() => Date.now()), logger, safeStorage });
  modelService.providerProtocol = providerProtocol;
  // 缺陷 2：ModelStore（identity.db）→ provider-protocol-store（providers.json）单向镜像。
  // 技能 / 短剧 / provider/call / image-generate / protocol 都读后者，不镜像就"配了也用不了"。
  const providerBridge = createModelProviderBridge({ modelStore, credentialStore, providerProtocol, userDataDir, clock: clock || (() => Date.now()), logger });
  modelService.providerBridge = providerBridge;
  // 渲染层回传的 providerId 是 ModelStore 的 prv_*；provider/call / image-generate / protocol 出口
  // 经这层别名解析拿到 providers.json 的镜像 id，否则即便已镜像仍是 PROVIDER_NOT_FOUND。
  if (providerProtocol && providerProtocol.service && typeof providerProtocol.service.setProviderIdResolver === "function") {
    providerProtocol.service.setProviderIdResolver((providerId) => providerBridge.resolveProviderProtocolId(providerId));
  }
  /**
   * 内置 Model App baseline（每个组织一份）：settings 最小管理权，resource-library / ai 可用；
   * D5-02 起 **canvas 是独立 App Principal**（画布页面的模型调用以 canvas 身份被授权与审计）；
   * 其余 App 默认 DENY。
   *
   * 数据库可能在还没有任何用户时就装配完成（首次运行先建库、后注册管理员），
   * 那时既没有 team 也没有 admin，一次性 seed 会把授予落到 organization_id=""，谁都匹配不到。
   * 因此宿主在拿到会话时对该会话的组织再 seed 一次。
   *
   * 播种语义（v21 起）：**首次使用才给，撤销后永不再给**。app_policy_provisions 按
   * (organization_id, app_id, 'model') 记录是否已提供过；有记录（无论是否已撤销）就跳过。
   * 这一条是对"撤销（删行）下次登录又被种回来"的正面修复，不是幂等优化。
   */
  const seedModelAppPolicy = ({ organizationId = null, grantedBy = "system:model-baseline" } = {}) => {
    if (!organizationId) return { ok: false, error: "NO_ORGANIZATION" };
    try {
      authStore.upsertApp({ appId: HOST_APP_ID, name: "系统设置", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
      authStore.upsertApp({ appId: "canvas", name: "无限画布", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
      const seed = (appId, actions) => {
        if (!authStore.appById(appId)) return false;
        if (authStore.policyProvisionByKey({ organizationId, appId, policyKey: "model" })) return false;
        authStore.upsertAppGrant({ appId, resourceType: "model", actions, grantedBy, organizationId });
        return true;
      };
      const seeded = [
        seed(HOST_APP_ID, ["model.view", "model.use", "model.manage", "model.test"]),
        seed("resource-library", ["model.view", "model.use"]),
        seed("ai", ["model.view", "model.use", "model.test"]),
        seed("canvas", ["model.view", "model.use"]),
      ].some(Boolean);
      return { ok: true, seeded };
    } catch {
      return { ok: false, error: "SEED_FAILED" };
    }
  };
  try {
    const admin = identityStore.allUsers().find((u) => u.role === "ADMIN") || null;
    seedModelAppPolicy({ organizationId: admin ? admin.team_id : (identityStore.allTeams()[0] ? identityStore.allTeams()[0].id : null), grantedBy: admin ? admin.id : "system:model-baseline" });
  } catch { /* baseline 失败不阻塞装配 */ }
  return { modelStore, credentialStore, modelService, modelProxy, seedModelAppPolicy, providerProtocol, providerBridge };
}

/** Renderer 白名单。新增能力必须显式登记；未知命令一律 MODEL_COMMAND_NOT_ALLOWED。 */
const MODEL_COMMANDS = Object.freeze([
  "provider/list", "provider/create", "provider/update", "provider/setStatus", "provider/delete",
  "credential/status", "credential/set", "credential/replace", "credential/delete",
  "model/list", "model/create", "model/update", "model/setStatus",
  "defaults/get", "defaults/set",
  "model/test",
  // 模型/协议出口的**可选**代理（默认关闭；只影响模型域出网，绝不写 globalThis，也不碰在线更新/集成）。
  "model/proxy/get", "model/proxy/set",
  // 10-16：拉取服务商模型清单
  "provider/models",
  // D5-02：画布只读模型面（唯一入口；真正的生成调用走 canvas:command 的 run，见 canvas-bootstrap）。
  "canvas/models",
  // P2：模型与协议域（provider-protocol-service.cjs）。全部走同一 trusted(event) 校验。
  "protocol/list", "protocol/get", "protocol/validate", "protocol/save",
  "manifest/get", "provider/call", "provider/callStream", "image/generate", "protocol/execute",
  // W6b：legacy 协议族统一出口（legacy-executor.cjs）。凭据只在主进程解析，不回传渲染层。
  "legacy/chat", "legacy/chatStream", "legacy/chatTools", "legacy/images", "legacy/editImages",
  "legacy/videos", "legacy/audio", "legacy/catalog", "legacy/describeImage", "legacy/midjourney",
]);
const MODEL_COMMAND_NOT_ALLOWED = "MODEL_COMMAND_NOT_ALLOWED";

const asStr = (v, max = 512) => (typeof v === "string" ? v.slice(0, max) : v == null ? undefined : String(v).slice(0, max));
const requireStr = (v, max = 512) => { const s = asStr(v, max); return s && s.length ? s : null; };

function registerModelIpc({ ipcMain, service, identity, isTrusted, hostAppId = HOST_APP_ID, send = null }) {
  // P2 协议服务由 createModelBundle 挂载；测试里若用裸 ModelService，新命令报 PROTOCOL_NOT_READY。
  const protocolService = () => (service && service.providerProtocol ? service.providerProtocol : null);
  // W5：宿主注入 send 时，把流式事件接到 model:event（identity-bootstrap 不转发 send，故 main.cjs 另调 wireModelEvents）。
  if (typeof send === "function") wireModelEvents({ service, send });
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
          return service.createProvider({ context, displayName: asStr(payload.displayName, 200), baseUrl, adapterType: asStr(payload.adapterType, 60), endpointScope: asStr(payload.endpointScope, 30), allowLan: !!payload.allowLan, allowInsecureHttp: payload.allowInsecureHttp === true, scope: asStr(payload.scope, 20), credentialSecret });
        }
        // adapterType 缺省时 asStr 回 undefined，model-service 沿用原值（只有显式传才改协议）。
        case "provider/update": return service.updateProvider({ context, providerId: requireStr(payload.providerId, 120), displayName: asStr(payload.displayName, 200), baseUrl: asStr(payload.baseUrl, 2048), adapterType: asStr(payload.adapterType, 60), endpointScope: asStr(payload.endpointScope, 30), status: asStr(payload.status, 20), allowLan: !!payload.allowLan, allowInsecureHttp: Object.prototype.hasOwnProperty.call(payload, "allowInsecureHttp") ? payload.allowInsecureHttp === true : undefined, credentialSecret, scope: asStr(payload.scope, 20) });
        case "provider/setStatus": return service.setProviderStatus({ context, providerId: requireStr(payload.providerId, 120), status: asStr(payload.status, 20) });
        case "provider/delete": return service.deleteProvider({ context, providerId: requireStr(payload.providerId, 120) });
        case "provider/models": return service.listRemoteModels({ context, providerId: requireStr(payload.providerId, 120) });
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
        // 模型/协议出口代理：只读回 enabled/url（无凭据）；写入口校验 http(s)://host:port 并写授权审计。
        case "model/proxy/get":
          return typeof service.getEgressProxy === "function" ? service.getEgressProxy({ context }) : { ok: false, error: "PROXY_NOT_READY" };
        case "model/proxy/set":
          return typeof service.setEgressProxy === "function"
            ? service.setEgressProxy({ context, enabled: payload.enabled, url: payload.url })
            : { ok: false, error: "PROXY_NOT_READY" };
        // ---- D5-02 画布模型面：能力由 ModelService 判定，缺能力明确报错、绝不回落 ----
        case "canvas/models": return service.listModelsForUse({ context: { ...context, appId: "canvas" } });
        // ---- P2 模型与协议域：协议服务挂在 ModelService 上；缺失时明确报错，绝不静默回落 ----
        case "protocol/list":
          return protocolService() ? protocolService().service.listProtocols({
            kind: asStr(payload.kind, 40) || null,
            ported: payload.ported === true ? true : payload.ported === false ? false : null,
          }) : { ok: false, error: "PROTOCOL_NOT_READY" };
        case "protocol/get":
          return protocolService() ? protocolService().service.getProtocol({ kind: asStr(payload.kind, 40), id: requireStr(payload.id, 120), version: payload.version }) : { ok: false, error: "PROTOCOL_NOT_READY" };
        case "protocol/validate":
          return protocolService() ? protocolService().service.validateProtocol({ protocol: payload.protocol }) : { ok: false, error: "PROTOCOL_NOT_READY" };
        case "protocol/save":
          return protocolService() ? protocolService().service.saveProtocol({ kind: asStr(payload.kind, 40), protocol: payload.protocol }) : { ok: false, error: "PROTOCOL_NOT_READY" };
        case "manifest/get": {
          const protocol = protocolService();
          if (!protocol) return { ok: false, error: "PROTOCOL_NOT_READY" };
          return protocol.manifest.getManifest({
            protocolId: requireStr(payload.protocolId, 120), model: requireStr(payload.model, 200),
            intent: asStr(payload.intent, 60) || "llm.chat",
            references: payload.references && typeof payload.references === "object" ? payload.references : null,
            params: payload.params && typeof payload.params === "object" ? payload.params : null,
          });
        }
        case "provider/call": {
          const protocol = protocolService();
          if (!protocol) return { ok: false, error: "PROTOCOL_NOT_READY" };
          return protocol.service.call({
            providerId: requireStr(payload.providerId, 120), model: requireStr(payload.model, 200),
            messages: Array.isArray(payload.messages) ? payload.messages.slice(0, 128) : [],
            tools: Array.isArray(payload.tools) ? payload.tools.slice(0, 64) : null,
            params: payload.params && typeof payload.params === "object" ? payload.params : {},
            stream: payload.stream === true,
            requestId: asStr(payload.requestId, 80),
            allowLan: !!payload.allowLan,
          });
        }
        // W5：显式流式调用动作 —— 与 provider/call 同一出口，stream 恒为 true；
        // 增量经 provider-protocol-service 封装成 model:event 下发（见 wireModelEvents）。
        case "provider/callStream": {
          const protocol = protocolService();
          if (!protocol) return { ok: false, error: "PROTOCOL_NOT_READY" };
          return protocol.service.call({
            providerId: requireStr(payload.providerId, 120), model: requireStr(payload.model, 200),
            messages: Array.isArray(payload.messages) ? payload.messages.slice(0, 128) : [],
            tools: Array.isArray(payload.tools) ? payload.tools.slice(0, 64) : null,
            params: payload.params && typeof payload.params === "object" ? payload.params : {},
            stream: true,
            requestId: asStr(payload.requestId, 80),
            allowLan: !!payload.allowLan,
          });
        }
        case "image/generate": {
          const protocol = protocolService();
          if (!protocol) return { ok: false, error: "PROTOCOL_NOT_READY" };
          return protocol.service.generateImage({
            providerId: requireStr(payload.providerId, 120), model: requireStr(payload.model, 200),
            prompt: asStr(payload.prompt, 4000) || "",
            size: asStr(payload.size, 32) || null,
            count: Number(payload.count) || 1,
            params: payload.params && typeof payload.params === "object" ? payload.params : {},
            requestId: asStr(payload.requestId, 80),
            allowLan: !!payload.allowLan,
          });
        }
        case "protocol/execute": {
          const protocol = protocolService();
          if (!protocol) return { ok: false, error: "PROTOCOL_NOT_READY" };
          return protocol.service.executeProtocol({
            providerId: requireStr(payload.providerId, 120), protocolId: asStr(payload.protocolId, 120) || null,
            model: requireStr(payload.model, 200), intent: asStr(payload.intent, 60) || "llm.chat",
            prompt: asStr(payload.prompt, 4000) || "",
            params: payload.params && typeof payload.params === "object" ? payload.params : {},
            inputs: payload.inputs && typeof payload.inputs === "object" ? payload.inputs : {},
            requestId: asStr(payload.requestId, 80),
            allowLan: !!payload.allowLan,
          });
        }
        // ---- W6b：legacy 协议族统一出口。action 由命令名推导；凭据只在主进程解析 ----
        case "legacy/chat":
        case "legacy/chatStream":
        case "legacy/chatTools":
        case "legacy/images":
        case "legacy/editImages":
        case "legacy/videos":
        case "legacy/audio":
        case "legacy/catalog":
        case "legacy/describeImage":
        case "legacy/midjourney": {
          const protocol = protocolService();
          if (!protocol) return { ok: false, error: "PROTOCOL_NOT_READY" };
          return protocol.service.legacyExecute({
            providerId: requireStr(payload.providerId, 120),
            action: command.slice("legacy/".length),
            model: requireStr(payload.model, 200),
            messages: Array.isArray(payload.messages) ? payload.messages.slice(0, 128) : [],
            system: asStr(payload.system, 8000) || null,
            prompt: asStr(payload.prompt, 8000) || null,
            tools: Array.isArray(payload.tools) ? payload.tools.slice(0, 64) : null,
            params: payload.params && typeof payload.params === "object" ? payload.params : {},
            input: payload.input && typeof payload.input === "object" ? payload.input : null,
            inputs: Array.isArray(payload.inputs) ? payload.inputs.slice(0, 16) : [],
            intent: asStr(payload.intent, 60) || null,
            dataUrl: payload.dataUrl == null ? null : payload.dataUrl,
            timeoutMs: Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : null,
            requestId: asStr(payload.requestId, 80),
            allowLan: !!payload.allowLan,
          });
        }
        default: return { ok: false, error: MODEL_COMMAND_NOT_ALLOWED };
      }
    } catch {
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  });
}

/**
 * W5 · B2 遗留①：模型流式下行事件。
 * provider-protocol-service 已按 P1 信封（channel/domain/kind/sequence/at/payload）
 * 组装好事件；这里只把它交给宿主的 webContents.send("model:event", ...)。
 * 与 task:event / sideeffect:event 同一条 trusted 边界：只有主进程能调用。
 */
function wireModelEvents({ service, send } = {}) {
  if (!service || typeof send !== "function") return false;
  const target = service.providerProtocol && service.providerProtocol.service ? service.providerProtocol.service : null;
  if (!target || typeof target.setEventSink !== "function") return false;
  return target.setEventSink((event) => { try { send(event); } catch { /* 事件推送失败不改变业务路径 */ } });
}

function disposeModelIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("model:command"); } catch { /* ignore */ } }
}

module.exports = { createModelBundle, registerModelIpc, disposeModelIpc, wireModelEvents, MODEL_COMMANDS, MODEL_COMMAND_NOT_ALLOWED, HOST_APP_ID };
