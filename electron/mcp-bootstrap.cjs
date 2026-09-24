/**
 * D5-03 第一批 · MCP 装配 + mcp:command IPC。
 *
 * 单一 Renderer 入口：window.openarc.mcp.command(...) → ipcMain "mcp:command"。
 * 显式命令白名单 + 静态 switch dispatch；actor sessionRef / appId 一律由可信主进程决定，
 * 忽略 Renderer 自报的 userId / role / sessionRef。
 * 绝不暴露 credentialRef / raw secret / 本机路径 / raw SQL。
 *
 * 本地连接的程序与参数由 mcp-domain 的白名单固定映射 —— 渲染层只能给 serverKey。
 */
"use strict";

const { McpStore } = require("./mcp-store.cjs");
const { McpService } = require("./mcp-service.cjs");
const { McpClient } = require("./mcp-client.cjs");
const { CredentialStore, safeStorageCredentialBackend } = require("./credential-store.cjs");
const { createDefaultExecutorLauncher } = require("./executor-launcher.cjs");
const domain = require("./mcp-domain.cjs");

/** MCP 中心由 shell 拥有的系统 App Principal 承载（app_principals 里已内置）。 */
const HOST_APP_ID = "mcp-center";

function createMcpBundle({ identityStore, authorization, authStore, userDataDir, safeStorage = null, launcher = null, clientFactory = null, fetchImpl = null, clock = null, logger = null, requestTimeoutMs = 8000, maxTools = 200, maxPages = 10, reconnectAttempts = 3, reconnectBackoffMs = 25 } = {}) {
  if (!identityStore) throw new Error("createMcpBundle 需要 identityStore");
  if (!authorization) throw new Error("createMcpBundle 需要 authorization");
  if (!authStore) throw new Error("createMcpBundle 需要 authStore");
  const mcpStore = new McpStore({ identity: identityStore, clock });
  // 生产路径只用 OS 安全后端；safeStorage 不可用 → credentialStore 不可用（无明文 fallback）。
  const backend = safeStorage ? safeStorageCredentialBackend({ safeStorage, dir: userDataDir }) : null;
  const credentialStore = new CredentialStore({ store: mcpStore, backend });
  const factory = typeof clientFactory === "function"
    ? clientFactory
    : () => new McpClient({ launcher: launcher || createDefaultExecutorLauncher(), fetchImpl, requestTimeoutMs, maxTools, maxPages });
  const mcpService = new McpService({ identity: identityStore, authService: authorization, authStore, mcpStore, credentialStore, clientFactory: factory, requestTimeoutMs, maxTools, maxPages, reconnectAttempts, reconnectBackoffMs, clock, logger });

  /**
   * 内置 MCP 中心 App baseline（每个组织一份）：mcp-center 持有 mcp.* 四个动作。
   * 为什么按组织重复调用：与 model-baseline 同因（首次运行先建库、后注册管理员），
   * 宿主在拿到会话时对该会话的组织再 seed 一次（upsert 幂等）。
   */
  const seedMcpAppPolicy = ({ organizationId = null, grantedBy = "system:mcp-baseline" } = {}) => {
    if (!organizationId) return { ok: false, error: "NO_ORGANIZATION" };
    try {
      authStore.upsertApp({ appId: HOST_APP_ID, name: "MCP 中心", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
      if (authStore.appById(HOST_APP_ID)) authStore.upsertAppGrant({ appId: HOST_APP_ID, resourceType: "mcp", actions: [...domain.MCP_ACTIONS_ALL], grantedBy, organizationId });
      return { ok: true };
    } catch {
      return { ok: false, error: "SEED_FAILED" };
    }
  };
  try {
    const admin = identityStore.allUsers().find((u) => u.role === "ADMIN") || null;
    const team = identityStore.allTeams()[0] || null;
    seedMcpAppPolicy({ organizationId: admin ? admin.team_id : (team ? team.id : null), grantedBy: admin ? admin.id : "system:mcp-baseline" });
  } catch { /* baseline 失败不阻塞装配 */ }

  return { mcpStore, credentialStore, mcpService, seedMcpAppPolicy };
}

/** Renderer 白名单。新增能力必须显式登记；未知命令一律 MCP_COMMAND_NOT_ALLOWED。 */
const MCP_COMMANDS = Object.freeze([
  "mcp/list",
  "mcp/get",
  "mcp/create",
  "mcp/update",
  "mcp/delete",
  "mcp/setEnabled",
  "mcp/connect",
  "mcp/reconnect",
  "mcp/test",
  "mcp/testLog",
]);
/**
 * 工具调用入口：第一批**不开放**。
 * 单独登记而不是落进"未知命令"，是为了让拒绝原因是产品边界而不是拼写错误 ——
 * 任何调用入口都明确回 MCP_TOOL_INVOCATION_NOT_ENABLED。
 */
const MCP_TOOL_INVOCATION_COMMANDS = Object.freeze(["mcp/callTool", "mcp/call", "mcp/invoke", "mcp/invokeTool", "mcp/toolCall"]);

const asStr = (v, max = 512) => (typeof v === "string" ? v.slice(0, max) : v == null ? undefined : String(v).slice(0, max));
const requireStr = (v, max = 512) => { const s = asStr(v, max); return s && s.length ? s : null; };

/** patch 只接受白名单键，且值都按标量收敛；其余字段由服务层再判一次。 */
function sanitizePatch(raw) {
  if (!raw || typeof raw !== "object") return {};
  const patch = {};
  if (raw.name !== undefined) patch.name = asStr(raw.name, 160);
  if (raw.visibility !== undefined) patch.visibility = asStr(raw.visibility, 20);
  if (raw.authMode !== undefined) patch.authMode = asStr(raw.authMode, 20);
  if (raw.credentialSecret !== undefined && typeof raw.credentialSecret === "string") patch.credentialSecret = raw.credentialSecret.slice(0, 4096);
  if (raw.endpoint !== undefined && raw.endpoint && typeof raw.endpoint === "object") {
    patch.endpoint = { serverKey: asStr(raw.endpoint.serverKey, 120), url: asStr(raw.endpoint.url, 2048) };
  }
  return patch;
}

function registerMcpIpc({ ipcMain, service, identity, isTrusted, hostAppId = HOST_APP_ID }) {
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("mcp:command"); } catch { /* not registered */ } }
  ipcMain.handle("mcp:command", async (e, raw) => {
    if (isTrusted && !isTrusted(e)) throw Error("Forbidden");
    if (!service) return { ok: false, error: domain.ERROR_CODE.MCP_INTERNAL_ERROR, detail: "mcp-not-ready" };
    if (!raw || typeof raw !== "object") return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT };
    const command = raw.command != null ? asStr(raw.command, 80) : asStr(raw.type, 80);
    if (MCP_TOOL_INVOCATION_COMMANDS.includes(command)) return { ok: false, error: domain.ERROR_CODE.MCP_TOOL_INVOCATION_NOT_ENABLED };
    if (!MCP_COMMANDS.includes(command)) return { ok: false, error: domain.ERROR_CODE.MCP_COMMAND_NOT_ALLOWED, detail: command || null };
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    // actor/app 一律来自可信宿主，忽略 payload.userId / payload.appId / payload.role / payload.sessionRef
    const context = { sessionRef: identity?.current ?? null, appId: hostAppId, source: "ui", requestId: asStr(payload.requestId, 80) };
    try {
      switch (command) {
        case "mcp/list": return service.listConnections({ context });
        case "mcp/get": return service.getConnection({ context, connectionId: requireStr(payload.connectionId, 120) });
        case "mcp/create": {
          const name = requireStr(payload.name, 160);
          if (!name) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "name" };
          return service.createConnection({
            context,
            name,
            transport: asStr(payload.transport, 20),
            location: asStr(payload.location, 30),
            endpoint: payload.endpoint && typeof payload.endpoint === "object" ? { serverKey: asStr(payload.endpoint.serverKey, 120), url: asStr(payload.endpoint.url, 2048) } : {},
            authMode: asStr(payload.authMode, 20),
            credentialSecret: typeof payload.credentialSecret === "string" ? payload.credentialSecret.slice(0, 4096) : null,
            visibility: asStr(payload.visibility, 20),
          });
        }
        case "mcp/update": return service.updateConnection({ context, connectionId: requireStr(payload.connectionId, 120), patch: sanitizePatch(payload.patch) });
        case "mcp/delete": return service.deleteConnection({ context, connectionId: requireStr(payload.connectionId, 120) });
        case "mcp/setEnabled": return service.setEnabled({ context, connectionId: requireStr(payload.connectionId, 120), enabled: !!payload.enabled });
        case "mcp/connect": return await service.connect({ context, connectionId: requireStr(payload.connectionId, 120) });
        case "mcp/reconnect": return await service.reconnect({ context, connectionId: requireStr(payload.connectionId, 120) });
        case "mcp/test": return await service.test({ context, connectionId: requireStr(payload.connectionId, 120) });
        case "mcp/testLog": return service.testLog({ context, connectionId: requireStr(payload.connectionId, 120), limit: payload.limit });
        default: return { ok: false, error: domain.ERROR_CODE.MCP_COMMAND_NOT_ALLOWED };
      }
    } catch {
      // 异常文本可能夹带路径 / SQL / 参数值，一律收敛。
      return { ok: false, error: domain.ERROR_CODE.MCP_INTERNAL_ERROR };
    }
  });
}

function disposeMcpIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("mcp:command"); } catch { /* ignore */ } }
}

module.exports = { createMcpBundle, registerMcpIpc, disposeMcpIpc, MCP_COMMANDS, MCP_TOOL_INVOCATION_COMMANDS, HOST_APP_ID };
