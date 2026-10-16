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
const { createMcpStdioLauncher } = require("./executor-launcher.cjs");
const domain = require("./mcp-domain.cjs");
const { isConnectedStatus } = require("./mcp-agent-tools.cjs");
const { paramSummaryText } = require("./mcp-tool-contract.cjs");
// B4e：开关持久化层的稳定错误码（不另写一份字面量）。
const { SWITCH_UNAVAILABLE } = require("./mcp-switch.cjs");
// B4e：聚合命令对外的文本一律走地基统一脱敏（密钥形态 + 本机绝对路径）。
const { redactText } = require("./dxos-foundation-errors.cjs");

/** MCP 中心由 shell 拥有的系统 App Principal 承载（app_principals 里已内置）。 */
const HOST_APP_ID = "mcp-center";

function createMcpBundle({ identityStore, authorization, authStore, userDataDir, safeStorage = null, launcher = null, clientFactory = null, fetchImpl = null, invocationGate = null, clock = null, logger = null, requestTimeoutMs = 8000, maxTools = 200, maxPages = 10, reconnectAttempts = 3, reconnectBackoffMs = 25 } = {}) {
  if (!identityStore) throw new Error("createMcpBundle 需要 identityStore");
  if (!authorization) throw new Error("createMcpBundle 需要 authorization");
  if (!authStore) throw new Error("createMcpBundle 需要 authStore");
  const mcpStore = new McpStore({ identity: identityStore, clock });
  // 生产路径只用 OS 安全后端；safeStorage 不可用 → credentialStore 不可用（无明文 fallback）。
  const backend = safeStorage ? safeStorageCredentialBackend({ safeStorage, dir: userDataDir }) : null;
  const credentialStore = new CredentialStore({ store: mcpStore, backend });
  // B4e 收口：每个真实连接都带上显式开关门（invocationGate）。未注入 = 客户端永远关闭（既有一律拒绝语义）。
  const factory = typeof clientFactory === "function"
    ? clientFactory
    : () => new McpClient({ launcher: launcher || createMcpStdioLauncher(), fetchImpl, invocationGate, requestTimeoutMs, maxTools, maxPages });
  const mcpService = new McpService({ identity: identityStore, authService: authorization, authStore, mcpStore, credentialStore, clientFactory: factory, requestTimeoutMs, maxTools, maxPages, reconnectAttempts, reconnectBackoffMs, clock, logger });

  /**
   * 内置 MCP 中心 App baseline（每个组织一份）：mcp-center 持有 mcp.* 四个动作。
   *
   * 播种语义（v21 起，与 model / resource baseline 同一口径）：**首次使用才给，撤销后永不再给**。
   * app_policy_provisions 记着 (organization_id, app_id, 'mcp') 是否已提供过 —— 有记录就跳过，
   * 因此治理侧撤销（删行）不会被下一次登录/重启复活；要恢复必须走治理正式重授。
   * 首次运行是"先建库、后注册管理员"，那时没有组织也没有记录，宿主在拿到会话时对该组织 seed 一次。
   */
  const seedMcpAppPolicy = ({ organizationId = null, grantedBy = "system:mcp-baseline" } = {}) => {
    if (!organizationId) return { ok: false, error: "NO_ORGANIZATION" };
    try {
      authStore.upsertApp({ appId: HOST_APP_ID, name: "MCP 中心", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
      if (!authStore.appById(HOST_APP_ID)) return { ok: true, seeded: false };
      if (authStore.policyProvisionByKey({ organizationId, appId: HOST_APP_ID, policyKey: "mcp" })) return { ok: true, seeded: false };
      authStore.upsertAppGrant({ appId: HOST_APP_ID, resourceType: "mcp", actions: [...domain.MCP_ACTIONS_ALL], grantedBy, organizationId });
      return { ok: true, seeded: true };
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
  // B4e：只读聚合（mcp__<server>__<tool>），供渲染层直接消费，消除 UI-2 的重复派生。
  // 它不是调用入口：真实调用入口是 mcp/toolInvocation/call；5 个旧命令名仍走拒绝分支。
  "mcp/agentTools",
  // B4e 收口：显式开关的**唯一写命令**（trusted + risk=mcp.manage + 审计），落 <userData>/dxos/mcp.json。
  "mcp/toolInvocation/set",
  // B4e 收口：**任务内**的 MCP 工具调用（真实 taskId + ControlledToolProxy 审批 → 真实传输）。
  "mcp/toolInvocation/call",
]);
/**
 * 旧调用命令名：**已不是调用入口**，保留显式登记只为让拒绝原因是产品边界而不是拼写错误 ——
 * 这 5 个名字一律回 MCP_TOOL_INVOCATION_NOT_ENABLED。
 *
 * 真实入口只有两个（同见上方 MCP_COMMANDS）：
 *   · mcp/toolInvocation/set —— 显式开关的唯一写命令，默认关闭，落 <userData>/dxos/mcp.json；
 *   · mcp/toolInvocation/call —— 任务内真实调用（可信 taskId + ControlledToolProxy 审批 → 真实传输）。
 * 开关关闭或本次未获批准都在传输前 fail closed：**未批准 = 0 次外发**。
 */
const MCP_TOOL_INVOCATION_COMMANDS = Object.freeze(["mcp/callTool", "mcp/call", "mcp/invoke", "mcp/invokeTool", "mcp/toolCall"]);

const asStr = (v, max = 512) => (typeof v === "string" ? v.slice(0, max) : v == null ? undefined : String(v).slice(0, max));
const requireStr = (v, max = 512) => { const s = asStr(v, max); return s && s.length ? s : null; };

/**
 * B4e · 工具调用结果 → 渲染层安全投影。
 * text 走地基统一脱敏并截断；只回稳定错误码/审批号，绝不回传输细节或凭据。
 */
function projectToolCallResult(res) {
  const out = { ok: res != null && res.ok === true };
  if (res && res.error) out.error = asStr(res.error, 120);
  if (res && res.decisionStatus) out.decisionStatus = asStr(res.decisionStatus, 40);
  if (res && res.approvalRequestId) out.approvalRequestId = asStr(res.approvalRequestId, 120);
  if (res && res.reasonCode) out.reasonCode = asStr(res.reasonCode, 120);
  if (out.ok) out.text = redactText(String((res && res.text) || "")).slice(0, 8000);
  return out;
}

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

function registerMcpIpc({ ipcMain, service, identity, isTrusted, hostAppId = HOST_APP_ID, agentTools = null, mcpServersSnapshot = null, toolInvocationEnabled = null, toolInvocationSwitch = null, audit = null, toolInvocation = null, resolveTaskContext = null }) {
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("mcp:command"); } catch { /* not registered */ } }

  /** 端口解引用：既接受实例，也接受返回实例的 getter（main.cjs 晚绑定 bridge 用）。 */
  const resolvePort = (port) => (typeof port === "function" ? port() : port);

  /**
   * B4e · 开关变更审计（先记意图，后记结果）。审计不可用一律拒绝写入 ——
   * 不允许"悄悄改变全局调用能力"的状态变更。
   * @returns {boolean} 是否真正落了一条审计
   */
  function auditSwitch(entry) {
    if (typeof audit !== "function") return false;
    try { return audit({
      action: "mcp.toolInvocation.set",
      decision: entry && entry.decision ? String(entry.decision) : null,
      reasonCode: entry && entry.reasonCode ? String(entry.reasonCode) : null,
      enabled: entry && entry.enabled === true,
      requestId: entry && entry.requestId ? String(entry.requestId) : null,
    }) === true; } catch { return false; }
  }

  /** B4e · 任务内工具调用：可信 taskId → 任务上下文（appId 由真实 Task 反推，渲染层自报无效）。 */
  async function handleToolInvocation(payload, context) {
    const port = resolvePort(toolInvocation);
    if (!port || typeof port.callByName !== "function" || typeof port.callDirect !== "function") {
      return { ok: false, error: domain.ERROR_CODE.MCP_TOOL_DISCOVERY_FAILED, detail: "tool-invocation-unavailable" };
    }
    const taskId = requireStr(payload.taskId, 120);
    if (!taskId) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "taskId" };
    // 解析器是**直接函数**（不是 getter）：它需要 { context, taskId }，不能当端口实例解引用。
    const resolver = typeof resolveTaskContext === "function" ? resolveTaskContext : null;
    if (!resolver) return { ok: false, error: domain.ERROR_CODE.MCP_UNAUTHORIZED, detail: "task-context-unavailable" };
    let task;
    try { task = await resolver({ context, taskId }); } catch { task = null; }
    if (!task || task.ok !== true) {
      return { ok: false, error: asStr((task && task.error) || domain.ERROR_CODE.MCP_UNAUTHORIZED, 80), detail: asStr(task && task.detail, 120) || null };
    }
    const fname = requireStr(payload.fname, 200);
    const serverId = requireStr(payload.serverId, 120);
    const toolName = requireStr(payload.toolName, 120);
    if (!fname && !(serverId && toolName)) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "fname-or-serverId+toolName" };
    // appId 来自真实 Task（不是 mcp-center，也不是渲染层自报）：ControlledToolProxy 会再校验 task.app_id。
    const callContext = { sessionRef: context.sessionRef, appId: task.appId || hostAppId, source: "ui", requestId: context.requestId };
    const options = { context: callContext, taskId: task.taskId || taskId, stepId: task.stepId || null, runId: task.runId || null };
    const args = payload.arguments && typeof payload.arguments === "object" && !Array.isArray(payload.arguments) ? payload.arguments : {};
    let res;
    try {
      res = fname ? await port.callByName(fname, args, options) : await port.callDirect(serverId, toolName, args, options);
    } catch {
      return { ok: false, error: domain.ERROR_CODE.MCP_INTERNAL_ERROR };
    }
    return projectToolCallResult(res);
  }

  /**
   * B4e · mcp/agentTools（只读聚合）。
   *
   * 数据源唯一：注入的 createMcpAgentTools 实例（agentTools / agentToolsForServer / searchAgentTools）。
   * 命令只做投影收敛：命名空间来自 mcp-agent-tools（mcp__<server>__<tool>），展示字段来自
   * 同一份 server 快照；description / paramText 一律走地基 redactText 脱敏。
   * 不返回本机路径、credentialRef、raw schema；enabled 只是"显式开关当前状态"，不是调用授权。
   *
   * 字段契约（UI-2 渲染层据此直接渲染，不再自行派生）：
   *   { ok:true, enabled:boolean, count:number, connectedServers:number, truncated:boolean,
   *     tools:[{ fname, serverId, serverName, toolName, status, description, paramText,
   *              riskClass:"EXTERNAL_SIDE_EFFECT", requiresApproval:true }] }
   */
  async function handleAgentTools(payload) {
    const api = resolvePort(agentTools);
    if (!api || typeof api.agentTools !== "function") {
      return { ok: false, error: domain.ERROR_CODE.MCP_TOOL_DISCOVERY_FAILED, detail: "mcp-agent-tools-unavailable", tools: [], count: 0, connectedServers: 0, enabled: false, truncated: false };
    }
    const serverId = requireStr(payload.serverId, 120);
    const searchOnly = payload.search === true;
    let res;
    try {
      res = serverId ? await api.agentToolsForServer(serverId)
        : searchOnly ? await api.searchAgentTools()
          : await api.agentTools();
    } catch {
      return { ok: false, error: domain.ERROR_CODE.MCP_TOOL_DISCOVERY_FAILED, detail: "mcp-agent-tools-failed", tools: [], count: 0, connectedServers: 0, enabled: false, truncated: false };
    }
    if (!res || res.ok !== true) {
      return { ok: false, error: (res && res.error) || domain.ERROR_CODE.MCP_TOOL_DISCOVERY_FAILED, detail: redactText(res && res.detail) || null, tools: [], count: 0, connectedServers: 0, enabled: false, truncated: false };
    }
    const index = typeof api.toolIndexSnapshot === "function" ? api.toolIndexSnapshot() : {};
    const rows = (() => { try { const v = resolvePort(mcpServersSnapshot); return Array.isArray(v) ? v : []; } catch { return []; } })();
    const rowById = new Map(rows.map((row) => [String(row && row.id), row]));
    const tools = [];
    for (const fn of Array.isArray(res.tools) ? res.tools : []) {
      const fname = fn && fn.function && fn.function.name;
      if (!fname) continue;
      const ref = index[fname] || {};
      const row = rowById.get(String(ref.serverId == null ? "" : ref.serverId));
      const toolRow = row && Array.isArray(row.tools) ? row.tools.find((t) => t && String(t.name) === String(ref.toolName)) : null;
      tools.push({
        fname: redactText(fname),
        serverId: redactText(ref.serverId != null ? ref.serverId : (row && row.id) || ""),
        serverName: redactText(ref.serverName || (row && row.name) || ""),
        toolName: redactText(ref.toolName != null ? ref.toolName : ""),
        status: String((row && row.status) || ""),
        description: redactText(toolRow && typeof toolRow.description === "string" ? toolRow.description : ""),
        paramText: redactText(paramSummaryText(toolRow ? toolRow.inputSchemaSummary : undefined)),
        riskClass: "EXTERNAL_SIDE_EFFECT",
        requiresApproval: true,
      });
    }
    let enabled = false;
    try { enabled = resolvePort(toolInvocationEnabled) === true; } catch { enabled = false; }
    const connectedServers = rows.filter((row) => row && row.enabled !== false && isConnectedStatus(row.status)).length;
    return { ok: true, enabled, count: tools.length, connectedServers, tools, truncated: false };
  }

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
        // B4e：只读聚合，不触碰调用/传输/审批；未注入 agent-tools 端口时结构化 MCP_TOOL_DISCOVERY_FAILED。
        case "mcp/agentTools": return await handleAgentTools(payload);
        // B4e 收口：显式开关写命令。trusted 已在入口校验；这里再做 risk=mcp.manage 授权 + 审计。
        case "mcp/toolInvocation/set": {
          if (typeof payload.enabled !== "boolean") return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "enabled" };
          const authz = typeof service.authorizeManage === "function" ? service.authorizeManage({ context }) : { ok: false, error: domain.ERROR_CODE.MCP_UNAUTHORIZED, reason: "manage-unavailable" };
          if (!authz.ok) {
            auditSwitch({ decision: "DENY", reasonCode: authz.reason || authz.error || "MCP_UNAUTHORIZED", enabled: payload.enabled, requestId: context.requestId });
            return { ok: false, error: domain.ERROR_CODE.MCP_UNAUTHORIZED, reason: authz.reason || null };
          }
          const sw = resolvePort(toolInvocationSwitch);
          if (!sw || typeof sw.setToolInvocationEnabled !== "function") {
            return { ok: false, error: SWITCH_UNAVAILABLE, detail: "开关端口未注入", enabled: false };
          }
          // 审计不可用 → 拒绝写入（不允许无审计的全局能力变更）。
          if (!auditSwitch({ decision: "REQUEST", reasonCode: null, enabled: payload.enabled, requestId: context.requestId })) {
            return { ok: false, error: "MCP_AUDIT_UNAVAILABLE", detail: "审计端口未注入：拒绝无审计的开关变更", enabled: false };
          }
          const written = sw.setToolInvocationEnabled(payload.enabled);
          auditSwitch({ decision: written && written.ok === true ? "ALLOW" : "DENY", reasonCode: written && written.ok === true ? null : (written && written.error) || SWITCH_UNAVAILABLE, enabled: written && written.enabled === true, requestId: context.requestId });
          if (!written || written.ok !== true) {
            return { ok: false, error: (written && written.error) || SWITCH_UNAVAILABLE, detail: (written && written.detail) || null, enabled: (written && written.enabled === true) };
          }
          return { ok: true, enabled: written.enabled === true, persisted: written.persisted === true, audited: true };
        }
        // B4e 收口：任务内 MCP 工具调用（真实 taskId + 审批链 → 真实传输）。
        case "mcp/toolInvocation/call": return await handleToolInvocation(payload, context);
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

// ---------------------------------------------------------------------------
// D5-03 第三批 · 生命周期接线（会话结束 / 撤权 / 关应用）
//
// 三条路径都汇到同一份 dispose / closeAppConnections：只收连接与在途请求、只落状态，
// **绝不改写 enabled**（那是用户意图），也绝不留 READY 假象。
// ---------------------------------------------------------------------------

const MCP_SESSION_END_EVENTS = Object.freeze({
  "identity/logged-out": "logout",
  "identity/locked": "lock",
  // 会话自然到期（空闲 / 绝对）与登出、锁屏同归属：都是"这条会话结束了"。
  "identity/session-expired": "expired",
});

/**
 * 会话结束 → dispose reason 的口径。reason 会原样落进连接日志的 detail，
 * 那是日志里唯一说明"谁把连接收掉"的字段，读日志的人必须一眼看出归属：
 *   · 自然到期 → "expired:<idle|absolute>"（前缀标归属；光看 "idle" 读不出是会话过期）；
 *   · 登出 / 锁屏 / 关应用 / 撤权 → 沿用既有 reason（logout / user / app-quit /
 *     app-grant-revoked），一个字符都不许动 —— 第三批门禁按这些字面量断言。
 */
function sessionEndReason(event, kind) {
  if (kind === "expired") return "expired:" + ((event && event.reason) || "unknown");
  return event && event.reason ? String(event.reason) : kind;
}

/** 登出 / 锁屏 / 自然到期 = 会话结束：立刻收掉活连接与在途握手（与关应用同一个 dispose）。 */
function attachMcpSessionLifecycle({ identityService, mcpService, logger = null } = {}) {
  if (!identityService || typeof identityService.onEvent !== "function" || !mcpService || typeof mcpService.dispose !== "function") return () => {};
  return identityService.onEvent((event) => {
    const kind = MCP_SESSION_END_EVENTS[event && event.event];
    if (!kind) return;
    const reason = sessionEndReason(event, kind);
    Promise.resolve()
      .then(() => mcpService.dispose({ reason }))
      .then((res) => logger?.log?.({ event: "mcp-session-end", result: res && res.ok === false ? "ERROR" : "OK", detail: { reason, closed: (res && res.closed) || 0, aborted: (res && res.aborted) || 0, ended: (res && res.ended) || 0 } }))
      .catch((e) => logger?.log?.({ event: "mcp-session-end", result: "ERROR", error_code: "DISPOSE_FAILED", detail: String((e && e.message) || e) }));
  });
}

/** 撤销 App 的 mcp.* 授权后：立刻收掉该组织下的活连接与在途握手（命令层仍实时回 MCP_UNAUTHORIZED）。 */
function attachMcpAppGrantRevocation({ authorization, mcpService } = {}) {
  if (!authorization || !mcpService || typeof mcpService.closeAppConnections !== "function") return () => {};
  const previous = typeof authorization.onAppGrantRevoked === "function" ? authorization.onAppGrantRevoked : null;
  const handler = (info) => {
    if (previous) { try { previous(info); } catch { /* 其它订阅者失败不影响 MCP 收尾 */ } }
    if (!info || String(info.resourceType || "") !== "mcp") return;
    try { mcpService.closeAppConnections({ appId: info.appId || null, organizationId: info.organizationId || null, reason: "app-grant-revoked" }); } catch { /* 收尾失败不改变"授权已撤销"这个事实 */ }
  };
  authorization.onAppGrantRevoked = handler;
  return () => { if (authorization.onAppGrantRevoked === handler) authorization.onAppGrantRevoked = previous; };
}

/**
 * 关闭应用：有界等待 dispose（默认 2s），超时或异常只作为结果留痕，绝不阻塞退出。
 * 返回字段与 dispose 对齐，另加 timedOut / error / skipped。
 */
function disposeMcpBounded({ service = null, timeoutMs = 2000, reason = "app-quit" } = {}) {
  if (!service || typeof service.dispose !== "function") return Promise.resolve({ ok: true, closed: 0, aborted: 0, ended: 0, skipped: true });
  let timer = null;
  const limit = Math.max(0, Number(timeoutMs) || 0);
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, closed: 0, aborted: 0, ended: 0, error: "DISPOSE_TIMEOUT", timedOut: true }), limit);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([Promise.resolve().then(() => service.dispose({ reason })), timeout])
    .then((res) => { if (timer) clearTimeout(timer); return res && typeof res === "object" ? res : { ok: true }; })
    .catch((e) => { if (timer) clearTimeout(timer); return { ok: false, closed: 0, aborted: 0, ended: 0, error: String((e && e.message) || e) }; });
}

module.exports = { createMcpBundle, registerMcpIpc, disposeMcpIpc, attachMcpSessionLifecycle, attachMcpAppGrantRevocation, disposeMcpBounded, MCP_COMMANDS, MCP_TOOL_INVOCATION_COMMANDS, MCP_SESSION_END_EVENTS, HOST_APP_ID };
