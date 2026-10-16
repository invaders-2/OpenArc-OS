/**
 * Y4 · 既有 MCP 配置来源之上的可写 connections 端口。
 *
 * 解决的问题：electron/mcp-app-registry.cjs（Y1）已经实现了"App 托管 MCP 的归属 + 连接生命周期"，
 * 但它要的 connections 端口（list/save/connect/disconnect/remove）在生产里没有落点 ——
 * electron/mcp-bootstrap.cjs 只暴露了 McpService（create/list/connect/... 各自一套签名），
 * 与注册表要的端口形状不是一回事。本文件把这套形状架在**既有** McpService + McpStore 之上：
 *   · 不新造第二套配置文件 / 表：读写仍是 mcp_connections（identity-store.cjs:1245 的唯一权威表）；
 *   · 策略判定不复制：stdio 只认 mcp-domain.cjs:72 LOCAL_SERVERS 的 serverKey，
 *     http 走 mcp-domain.cjs:112 validateRemoteEndpoint（经 encodeEndpoint 统一编码）；
 *   · 授权不绕过：list 走 McpService.listConnections（app grant + 可见性判定），
 *     save/connect/disconnect/remove 都要求一个可解析的已认证会话（authorization.resolveActor）。
 *
 * 托管归属 managedByAppId 的落点（为什么不加列 / 不建表）：
 *   · 硬约束不改 SCHEMA_VERSION（多处迁移测试冻结在 v26），mcp_connections 也没有 owner app 列；
 *   · 因此把归属写进 endpoint_json 的附加键 managedByAppId —— 仍是同一张表、同一条记录、同一次写入；
 *   · 该键对既有解析路径不可见：mcp-domain.cjs:268 projectEndpoint 只回 serverKey / url，
 *     mcp-service.cjs:543 握手只取 serverKey / url，多出的键既不投影给渲染层也不参与连接。
 *   · Y6：MCP 中心的通用编辑路径（mcp-service.updateConnection）重写端点时，
 *     经 mcp-domain.carryManagedByAppId 原样携带该键，归属不再随端点覆盖丢失。
 *
 * 全程离线：本文件不发网络、不 spawn 进程；真实连接由 McpService 的既有活连接负责。
 */
"use strict";

const crypto = require("node:crypto");
const domain = require("./mcp-domain.cjs");

const SS = "AGENT_DEPENDENCY_UNAVAILABLE";

/** 端口自己的结构化错误码（只加既有 mcp-domain 没有的语义）。 */
const PORT_ERROR = Object.freeze({
  /** 端口缺依赖：精确到方法，便于 IPC / 上层转述。 */
  UNAVAILABLE: SS,
  INVALID_INPUT: domain.ERROR_CODE.MCP_INVALID_INPUT,
  UNAUTHORIZED: domain.ERROR_CODE.MCP_UNAUTHORIZED,
  NOT_FOUND: domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND,
});

const STATUS_VALUES = new Set(Object.values(domain.STATUS));

const asText = (value, max) => String(value == null ? "" : value).slice(0, max);

/** 结构化错误：带 code，调用方既能 catch 也能读码（不静默）。 */
function portError(code, detail) {
  const error = new Error(String(code) + (detail ? "：" + detail : ""));
  error.name = "McpConnectionsPortError";
  error.code = String(code);
  if (detail !== undefined) error.detail = String(detail);
  return error;
}

/**
 * Y4 生产装配守卫：端口 / App 托管注册表都是**可选**能力，构造抛错时不能把主进程启动链拖死。
 * main.cjs 用它包住两处构造点；失败返回 ok:false + 原因，由调用方降到 null 并如实记一条降级日志
 * （不静默、不假装能力还在 —— 上层据 null 保持既有结构化 AGENT_DEPENDENCY_UNAVAILABLE）。
 *
 * @param {string} label  构造点名字（日志/原因用）
 * @param {() => object} build  真正构造；抛错被这里收掉
 * @param {(event:string, detail:object)=>void} [log]
 * @returns {{ok:true, value:object} | {ok:false, value:null, error:"CONSTRUCTION_FAILED", label:string, detail:string}}
 */
function constructOrDegrade(label, build, log) {
  const name = String(label == null ? "unknown" : label).slice(0, 120);
  try {
    if (typeof build !== "function") {
      return { ok: false, value: null, error: "CONSTRUCTION_FAILED", label: name, detail: "missing-builder" };
    }
    return { ok: true, value: build() };
  } catch (error) {
    const detail = String((error && error.message) || error).slice(0, 300);
    if (typeof log === "function") { try { log("mcp-wiring-construct-failed", { label: name, detail }); } catch { /* 日志失败不改变降级 */ } }
    return { ok: false, value: null, error: "CONSTRUCTION_FAILED", label: name, detail };
  }
}

/** endpoint_json 里的托管归属键；对既有解析路径不可见（见文件头）。单一真值在 mcp-domain。 */
const MANAGED_KEY = domain.MANAGED_BY_APP_KEY;

function parseEndpoint(row) {
  return domain.parseJson(row && row.endpoint_json, null);
}

function managedByAppIdOf(row) {
  const parsed = parseEndpoint(row);
  return parsed && parsed[MANAGED_KEY] ? String(parsed[MANAGED_KEY]) : null;
}

/** 既有 endpoint 编码 + 归属附加键；不保留 App 自带的任何 command/args。 */
function encodeWithOwner({ location, transport, endpoint, managedByAppId }) {
  const encoded = domain.encodeEndpoint({ location, transport, endpoint, allowLan: false });
  if (!encoded.ok) return encoded;
  if (!managedByAppId) {
    // 去掉旧归属：把归属当普通附加键，清空时不残留。
    const base = domain.parseJson(encoded.json, {}) || {};
    if (MANAGED_KEY in base) { delete base[MANAGED_KEY]; return { ok: true, json: JSON.stringify(base), origin: encoded.origin }; }
    return encoded;
  }
  const base = domain.parseJson(encoded.json, {}) || {};
  base[MANAGED_KEY] = String(managedByAppId);
  return { ok: true, json: JSON.stringify(base), origin: encoded.origin };
}

function connectedStatusOf(status) {
  const value = String(status || "");
  return value === "connected" || value === "READY";
}

/** 记录 → 端口投影：只暴露既有允许的 endpoint 形态（serverKey / url），归属单独成字段。 */
function toRecord(row) {
  if (!row || !row.connection_id) return null;
  const parsed = parseEndpoint(row) || {};
  const endpoint = parsed.serverKey
    ? { serverKey: String(parsed.serverKey) }
    : parsed.url
      ? { url: String(parsed.url), ...(parsed.endpointScope ? { endpointScope: String(parsed.endpointScope) } : {}) }
      : {};
  const managedByAppId = managedByAppIdOf(row);
  return {
    id: String(row.connection_id),
    connectionId: String(row.connection_id),
    name: row.name,
    transport: row.transport,
    location: row.location,
    endpoint,
    serverKey: endpoint.serverKey,
    url: endpoint.url,
    managedByAppId,
    appManaged: !!managedByAppId,
    enabled: row.enabled === 1 || row.enabled === true,
    status: String(row.status || domain.STATUS.DISABLED),
    builtin: false,
  };
}

/**
 * 生产装配点：在既有 MCP 存储/服务之上提供注册表要的 connections 端口。
 *
 * @param {object} options
 * @param {object} options.mcpService  McpService 实例（listConnections/connect/setEnabled/deleteConnection/...）。
 * @param {object} [options.mcpStore]  McpStore 实例；缺省取 mcpService.store（同一份既有存储）。
 * @param {object} [options.authorization]  AuthorizationService；缺省取 mcpService.authService。
 * @param {() => object} [options.context]  可信上下文（sessionRef 只由宿主推导）；缺省空上下文 + hostAppId。
 * @param {string} [options.hostAppId]  承载 MCP 中心的 App Principal（默认 mcp-center）。
 * @param {() => number} [options.clock] @param {(event:string, detail:object)=>void} [options.logger]
 */
function createMcpConnectionsPort({ mcpService = null, mcpStore = null, authorization = null, context = null, hostAppId = "mcp-center", clock = null, logger = null } = {}) {
  const store = mcpStore || (mcpService && mcpService.store) || null;
  const auth = authorization || (mcpService && mcpService.authService) || null;
  const now = typeof clock === "function" ? clock : () => Date.now();
  const log = typeof logger === "function" ? logger : null;

  function contextOf() {
    const base = typeof context === "function" ? context() : context;
    const value = base && typeof base === "object" ? base : {};
    return { ...value, appId: value.appId || hostAppId };
  }

  function guard() {
    if (!store || typeof store.connectionById !== "function") {
      return { ok: false, error: PORT_ERROR.UNAVAILABLE, dependency: "connections.store", detail: "缺少既有 MCP 存储：无法读写托管记录" };
    }
    if (!mcpService || typeof mcpService.listConnections !== "function") {
      return { ok: false, error: PORT_ERROR.UNAVAILABLE, dependency: "connections.list", detail: "缺少既有 MCP 服务：无法列出连接目录" };
    }
    return { ok: true };
  }

  function requireGuard() {
    const g = guard();
    if (!g.ok) throw portError(g.error, g.detail);
    return g;
  }

  /** 端口方法都要求一个可解析的已认证会话；解析失败一律结构化拒绝（不静默回退）。 */
  function actorOf() {
    if (!auth || typeof auth.resolveActor !== "function") throw portError(PORT_ERROR.UNAUTHORIZED, "authorization");
    let res;
    try { res = auth.resolveActor({ context: contextOf() }); }
    catch { throw portError(PORT_ERROR.UNAUTHORIZED, "resolve-actor-failed"); }
    if (!res || res.ok !== true || !res.user || res.user.id == null) throw portError(PORT_ERROR.UNAUTHORIZED, (res && (res.reason || res.error)) || "no-session");
    return res;
  }

  /** 既有连接目录（授权后的投影）+ 原始记录的归属/端点补充。 */
  function list() {
    requireGuard();
    const res = mcpService.listConnections({ context: contextOf() });
    if (!res || res.ok !== true) throw portError(res && res.error ? res.error : PORT_ERROR.UNAUTHORIZED, res && (res.reason || res.error));
    const items = Array.isArray(res.items) ? res.items : [];
    const out = [];
    for (const item of items) {
      if (!item || item.connectionId == null) continue;
      const raw = store.connectionById(item.connectionId);
      if (!raw) continue;
      const record = toRecord(raw);
      out.push({
        ...record,
        serverName: item.serverName || null,
        connected: record.enabled === true && connectedStatusOf(record.status),
        tools: Array.isArray(item.tools) ? item.tools : [],
        toolsVisible: item.toolsHidden !== true,
      });
    }
    return out;
  }

  /** 状态收敛：既有投影可能给 'connected'，数据库 CHECK 只认 mcp-domain STATUS 五个值。 */
  function normalizeStatus(status, { enabled, existing }) {
    const value = String(status || "");
    const mapped = value === "connected" ? domain.STATUS.READY : value;
    if (STATUS_VALUES.has(mapped)) return enabled ? mapped : domain.STATUS.DISABLED;
    if (existing && existing.status && STATUS_VALUES.has(String(existing.status))) return enabled ? String(existing.status) : domain.STATUS.DISABLED;
    return enabled ? domain.STATUS.CONNECTING : domain.STATUS.DISABLED;
  }

  /**
   * 幂等 upsert：同 id 更新既有记录，新 id 落一条既有表记录。
   * 只写 endpoint（serverKey/url）+ 归属；App 自带的 command/args 到不了这里。
   */
  function save(config) {
    requireGuard();
    const raw = config && typeof config === "object" ? config : {};
    const requestedId = asText(raw.id != null ? raw.id : raw.connectionId, 120).trim();
    const existing = requestedId ? store.connectionById(requestedId) : null;
    // Y6：补齐"新记录可缺 id"的最小能力 —— 导入等调用点只负责 transport/location/endpoint，
    // id 由端口生成（与 McpStore.insertConnection 同前缀）；已有记录仍按既有 id 幂等更新。
    const id = requestedId || (existing ? String(existing.connection_id) : "mcp_" + crypto.randomBytes(10).toString("base64url"));
    const managedByAppId = raw.managedByAppId != null
      ? asText(raw.managedByAppId, 120)
      : (existing ? managedByAppIdOf(existing) : null);
    const transport = String(raw.transport || (existing && existing.transport) || "");
    const location = String(raw.location || (existing && existing.location) || "");
    if (![domain.TRANSPORT.STDIO, domain.TRANSPORT.HTTP].includes(transport)) throw portError(PORT_ERROR.INVALID_INPUT, "transport");
    if (![domain.LOCATION.LOCAL_DEVICE, domain.LOCATION.REMOTE_SERVICE].includes(location)) throw portError(PORT_ERROR.INVALID_INPUT, "location");
    let endpoint = raw.endpoint;
    if (!endpoint || typeof endpoint !== "object") {
      const parsed = existing ? parseEndpoint(existing) : null;
      endpoint = parsed && parsed.serverKey
        ? { serverKey: parsed.serverKey }
        : parsed && parsed.url ? { url: parsed.url } : (raw.serverKey ? { serverKey: raw.serverKey } : raw.url ? { url: raw.url } : null);
    }
    if (!endpoint) throw portError(PORT_ERROR.INVALID_INPUT, "endpoint");
    const encoded = encodeWithOwner({ location, transport, endpoint, managedByAppId });
    if (!encoded.ok) throw portError(encoded.error, encoded.detail);
    const enabled = raw.enabled === undefined ? (existing ? existing.enabled === 1 || existing.enabled === true : false) : raw.enabled === true;
    const status = normalizeStatus(raw.status, { enabled, existing });
    const patch = {
      name: raw.name != null ? asText(raw.name, 120) : (existing ? existing.name : id),
      transport,
      location,
      endpointJson: encoded.json,
      enabled,
      status,
    };
    let row;
    if (existing) {
      row = store.updateConnection(id, patch);
    } else {
      const actor = actorOf();
      row = store.insertConnection({
        connectionId: id,
        organizationId: actor.organizationId,
        ownerUserId: actor.user.id,
        visibility: domain.VISIBILITY.PERSONAL,
        name: patch.name,
        transport,
        location,
        endpointJson: encoded.json,
        authMode: domain.AUTH_MODE.NONE,
        credentialRef: null,
        enabled,
        status,
      });
    }
    if (!row) throw portError(PORT_ERROR.NOT_FOUND, id);
    return { ...toRecord(row), origin: encoded.origin, updatedAt: now() };
  }

  /** 真实连接：复用 McpService 的既有活连接与握手；失败如实返回，不抛断整批。 */
  async function connect(config) {
    requireGuard();
    const id = asText(config && (config.id != null ? config.id : config.connectionId), 120).trim();
    if (!id) throw portError(PORT_ERROR.INVALID_INPUT, "id");
    const res = await mcpService.connect({ context: contextOf(), connectionId: id });
    if (!res || res.ok !== true) {
      if (log) { try { log("mcp-connections-connect", { id, error: (res && res.error) || "MCP_UNREACHABLE" }); } catch { /* 日志失败不改变结果 */ } }
      return { ok: false, error: (res && res.error) || domain.ERROR_CODE.MCP_UNREACHABLE, detail: res && res.detail, record: toRecord(store.connectionById(id)) };
    }
    return { ok: true, reused: res.reused === true, record: toRecord(store.connectionById(id)) };
  }

  /** 断开：走既有 setEnabled(false)（关活连接 + enabled=false + DISABLED），不删记录。 */
  function disconnect(id) {
    requireGuard();
    const key = asText(id, 120).trim();
    if (!key) throw portError(PORT_ERROR.INVALID_INPUT, "id");
    const res = mcpService.setEnabled({ context: contextOf(), connectionId: key, enabled: false });
    if (!res || res.ok !== true) {
      if (log) { try { log("mcp-connections-disconnect", { id: key, error: (res && res.error) || PORT_ERROR.NOT_FOUND }); } catch { /* 忽略 */ } }
      return { ok: false, error: (res && res.error) || PORT_ERROR.NOT_FOUND, record: toRecord(store.connectionById(key)) };
    }
    return { ok: true, record: toRecord(store.connectionById(key)) };
  }

  /** 移除：走既有 deleteConnection（关活连接 + 删记录 + 删日志）。 */
  function remove(id) {
    requireGuard();
    const key = asText(id, 120).trim();
    if (!key) throw portError(PORT_ERROR.INVALID_INPUT, "id");
    const res = mcpService.deleteConnection({ context: contextOf(), connectionId: key });
    if (!res || res.ok !== true) {
      if (log) { try { log("mcp-connections-remove", { id: key, error: (res && res.error) || PORT_ERROR.NOT_FOUND }); } catch { /* 忽略 */ } }
      return { ok: false, error: (res && res.error) || PORT_ERROR.NOT_FOUND };
    }
    return { ok: true, changed: res.changed === true };
  }

  /**
   * Y6：端口提供"刷新"语义（mcp-agent-tools.refreshServer 的 refresh 分支）。
   * 复用 McpService 既有 reconnect（先收活连接再重新握手）；没有 reconnect 时才退到 connect。
   * 关键：不碰 enabled —— 刷新不能像 disconnect 那样把启用状态翻成 false。
   */
  async function refresh(id) {
    requireGuard();
    const key = asText(id, 120).trim();
    if (!key) throw portError(PORT_ERROR.INVALID_INPUT, "id");
    const row = store.connectionById(key);
    if (!row) return { ok: false, error: PORT_ERROR.NOT_FOUND, id: key, status: null };
    const enabled = row.enabled === 1 || row.enabled === true;
    if (!enabled) return { ok: true, id: key, status: domain.STATUS.DISABLED, error: null, refreshed: false };
    const res = typeof mcpService.reconnect === "function"
      ? await mcpService.reconnect({ context: contextOf(), connectionId: key })
      : await mcpService.connect({ context: contextOf(), connectionId: key });
    const fresh = store.connectionById(key);
    const ok = !!(res && res.ok === true);
    return {
      ok,
      id: key,
      status: fresh ? String(fresh.status) : null,
      error: ok ? null : ((res && res.error) || domain.ERROR_CODE.MCP_UNREACHABLE),
      refreshed: ok,
      attempts: res && res.attempts != null ? res.attempts : null,
    };
  }

  return { list, save, connect, disconnect, remove, refresh, hostAppId: String(hostAppId) };
}

module.exports = { createMcpConnectionsPort, constructOrDegrade, PORT_ERROR, MANAGED_KEY, portError };
