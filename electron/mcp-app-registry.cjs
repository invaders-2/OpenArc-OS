/**
 * Y1 · 宿主侧 App 托管 MCP 注册表（归属 + 连接生命周期）。
 *
 * 解决的问题：electron/mcp-agent-tools.cjs 的三个 App 托管 MCP 入口
 * （assertAppManagedMcpAvailable / syncAppManagedMcpServers / removeAppManagedMcpServers）
 * 原先只保留签名 + 结构化不可用，根因是缺"宿主侧注册表"：谁（哪个已安装 App）声明/托管了
 * 哪些 MCP 服务，以及这些服务的连接怎么随 App 启用/禁用变化。
 *
 * 本层只补**归属与生命周期**，一个权限都不放宽（对齐源 server/mcp.ts:372-434 的语义，
 * 但落地口径换成本仓既有策略，不照抄源的"任意 stdio command"）：
 *   · :372-382  assertAppManagedMcpAvailable —— ID 冲突校验（源抛异常，本层结构化返回）；
 *   · :384-426  syncAppManagedMcpServers   —— 按 managedByAppId 持久化声明并连接/断开；
 *   · :428-434  removeAppManagedMcpServers —— 移除该 App 的全部托管服务。
 *
 * 安全边界（不可违反）：
 *   1) "App 声明了"不构成任何许可。每条声明都必须先过 electron/mcp-domain.cjs 的既有策略：
 *        · 本地 stdio：只认 mcp-domain.cjs:72 LOCAL_SERVERS 白名单里的 serverKey
 *          （localServerEnv:82 只给 PATH；程序与参数由主进程固定映射，App 的 command/args 不生效）；
 *        · 远程 http：走 mcp-domain.cjs:112 validateRemoteEndpoint（复用 model-domain.validateEndpoint
 *          的 file:// / metadata IP / URL 内嵌凭据 / 明文远程拒绝口径）。
 *      任一声明不满足 → 整批**结构化拒绝**（错误码 + policy + detail），本轮 **0 次 save / 0 次 connect**，
 *      与源"先 assert 再 persist"的 fail-fast 语义一致。
 *   2) 不新造第二套配置文件：托管归属存在**既有 MCP 配置来源**（connections 端口的记录）上，
 *      字段就是 managedByAppId —— 不新开 mcp-apps.json 之类的文件。
 *   3) 连接的"不可用"沿用既有语义：enabled=false + status=DISABLED。
 *      electron/mcp-agent-tools.cjs 的聚合只看 enabled===false 就跳过（:676），
 *      callResolved 对 enabled===false 直接回 MCP_SERVER_NOT_CONNECTED（:812），无需另立门禁。
 *
 * connections 端口 = 既有 MCP 配置来源/连接目录（形状与 mcp-agent-tools.cjs:611 的 options.servers 一致）：
 *   list() → [{ id, name, transport, location, endpoint, managedByAppId?, enabled, status, ... }]
 *   save(cfg) → 持久化并回记录（同 id 幂等更新）
 *   connect(cfg) / disconnect(id)
 *   remove(id)  —— 清理记录；缺失时 remove/卸载清理结构化失败，不半途断开后留残记录
 *
 * 全程离线：本文件不发网络、不 spawn 进程；进程/连接由注入的端口负责。
 */
"use strict";

const domain = require("./mcp-domain.cjs");

/** 与 electron/agent-runtime-deps.cjs:17 / mcp-agent-tools.cjs:97 同一个码，便于上层统一判定"能力未接入"。 */
const AGENT_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";

/** 本层自己的结构化错误码（只加既有 mcp-domain 没有的语义）。 */
const APP_MCP_ERROR = Object.freeze({
  /** 连接目录端口缺方法：不落盘、不连接，如实报缺哪个端口。 */
  PORT_UNAVAILABLE: AGENT_DEPENDENCY_UNAVAILABLE,
  /** 声明本身非法（缺 id / 批内重复 id）。 */
  INVALID_DECLARATION: domain.ERROR_CODE.MCP_INVALID_INPUT,
  /** 源 mcp.ts:378 的 "MCP Server ID 已被占用"。 */
  SERVER_ID_CONFLICT: "MCP_APP_SERVER_ID_CONFLICT",
  /** 本地 stdio 不在 mcp-domain.cjs:72 LOCAL_SERVERS 白名单（源 :397 的 transport 判定不变）。 */
  LOCAL_POLICY: "MCP_APP_LOCAL_POLICY_REJECTED",
  /** 远程 endpoint 不满足 mcp-domain.cjs:112 的 SSRF/协议/凭据口径。 */
  REMOTE_POLICY: "MCP_APP_REMOTE_POLICY_REJECTED",
});

/** 策略标签：结构化拒绝时告诉调用方"卡在哪条既有策略上"。 */
const POLICY = Object.freeze({
  LOCAL_SERVERS: "LOCAL_SERVERS_WHITELIST",
  REMOTE_ENDPOINT: "REMOTE_ENDPOINT_POLICY",
});

const asText = (v, max) => String(v == null ? "" : v).slice(0, max);

/** 端口缺失的统一结构化结果：dependency 精确到方法，便于 IPC / 上层转述。 */
function portUnavailable(dependency, detail) {
  return { ok: false, error: AGENT_DEPENDENCY_UNAVAILABLE, dependency: String(dependency), detail: String(detail) };
}

/** 端口形状检查：只检查本轮真正会用到的同步/异步方法。 */
function requirePort(connections) {
  if (!connections || typeof connections.list !== "function") return portUnavailable("connections.list", "缺少宿主侧 MCP 配置来源：无法读取既有托管归属");
  if (typeof connections.save !== "function") return portUnavailable("connections.save", "缺少宿主侧 MCP 配置来源：无法持久化 App 托管归属");
  if (typeof connections.disconnect !== "function") return portUnavailable("connections.disconnect", "缺少连接生命周期端口：无法断开 App 托管连接");
  if (typeof connections.connect !== "function") return portUnavailable("connections.connect", "缺少连接生命周期端口：无法连接 App 托管服务");
  return { ok: true };
}

/** 记录里的 endpoint 可能是对象，也可能已经被既有来源序列化成 JSON 字符串。 */
function readEndpoint(record) {
  const raw = record && record.endpoint !== undefined ? record.endpoint : record && record.endpointJson;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string" && raw) {
    try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed : null; } catch { return null; }
  }
  return null;
}

/**
 * 单条声明的既有策略判定（源 :397-404 的 transport 判定 + 本仓白名单/SSRF 口径）。
 *
 * @returns {{ok:true, plan:object} | {ok:false, error:string, policy:string, declarationId:string, detail:string}}
 */
function evaluateDeclaration(declaration) {
  const raw = declaration && typeof declaration === "object" ? declaration : {};
  const id = asText(raw.id, 120).trim();
  if (!id) return { ok: false, error: APP_MCP_ERROR.INVALID_DECLARATION, policy: null, declarationId: null, detail: "声明缺少 id" };
  const url = raw.url == null ? "" : String(raw.url);
  // 源 mcp.ts:397：transport === 'http' || url 存在 → http，否则 stdio。
  const transport = raw.transport === "http" || url ? domain.TRANSPORT.HTTP : domain.TRANSPORT.STDIO;
  const location = transport === domain.TRANSPORT.HTTP ? domain.LOCATION.REMOTE_SERVICE : domain.LOCATION.LOCAL_DEVICE;
  const name = asText(raw.name || id, 120);

  if (location === domain.LOCATION.LOCAL_DEVICE) {
    // 本地没有 App 自带命令：只认既有白名单 key；App 的 command/args 一律不参与映射。
    const serverKey = raw.serverKey == null ? "" : String(raw.serverKey);
    const v = domain.validateLocalEndpoint({ serverKey });
    if (!v.ok) {
      return {
        ok: false,
        error: APP_MCP_ERROR.LOCAL_POLICY,
        policy: POLICY.LOCAL_SERVERS,
        declarationId: id,
        detail: serverKey
          ? "serverKey 不在 mcp-domain.cjs:72 LOCAL_SERVERS 白名单：" + asText(serverKey, 80)
          : "本地 stdio 不接受 App 自带 command/args，必须引用 LOCAL_SERVERS 白名单 serverKey",
      };
    }
    return {
      ok: true,
      plan: {
        id,
        name,
        transport,
        location,
        endpoint: { serverKey: v.serverKey },
        serverKey: v.serverKey,
        autoStart: raw.autoStart === true,
        // autoStart 缺省 = undefined：留给 sync 决定"沿用上次 / 默认关"，与源 :410 一致。
        autoStartDeclared: typeof raw.autoStart === "boolean",
        command: raw.command ? String(raw.command) : undefined,
        args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      },
    };
  }

  const v = domain.validateRemoteEndpoint(url);
  if (!v.ok) {
    return {
      ok: false,
      error: APP_MCP_ERROR.REMOTE_POLICY,
      policy: POLICY.REMOTE_ENDPOINT,
      declarationId: id,
      detail: "URL 未通过 mcp-domain.cjs:112 validateRemoteEndpoint：" + asText(v.detail || "blocked", 120),
    };
  }
  return {
    ok: true,
    plan: {
      id,
      name,
      transport,
      location,
      endpoint: { url: v.url, endpointScope: v.endpointScope },
      url: v.url,
      autoStart: raw.autoStart === true,
      autoStartDeclared: typeof raw.autoStart === "boolean",
    },
  };
}

/** 已落库记录 → 重新判定（App 启用时"按白名单与策略重新判定"，而不是无条件复活）。 */
function evaluateRecord(record) {
  const endpoint = readEndpoint(record);
  if (!endpoint) return { ok: false, error: APP_MCP_ERROR.INVALID_DECLARATION, policy: null, detail: "记录缺少可判定的 endpoint" };
  if (endpoint.serverKey) return evaluateDeclaration({ id: record.id, name: record.name, transport: domain.TRANSPORT.STDIO, serverKey: endpoint.serverKey });
  return evaluateDeclaration({ id: record.id, name: record.name, transport: domain.TRANSPORT.HTTP, url: endpoint.url });
}

/**
 * @param {object} options
 * @param {object} options.connections  既有 MCP 配置来源 + 连接生命周期端口（见文件头）。
 * @param {object|function} [options.appState]  已安装 App 启用态端口：{ isEnabled(appId) } 或 (appId)=>boolean。
 *    未注入 = 不按 App 态抑制连接（仍用声明 autoStart/上次 enabled）。
 * @param {()=>number} [options.clock] @param {(event:string, detail:object)=>void} [options.logger]
 */
function createAppManagedMcpRegistry({ connections = null, appState = null, clock = null, logger = null } = {}) {
  const now = typeof clock === "function" ? clock : () => Date.now();
  const log = typeof logger === "function" ? logger : null;

  function appEnabled(appId) {
    if (!appState) return null; // 未装配 = 不介入（null 与"已禁用"区分开）
    try {
      if (typeof appState === "function") return appState(appId) !== false;
      if (typeof appState.isEnabled === "function") return appState.isEnabled(appId) !== false;
    } catch { return false; }
    return null;
  }

  function guard() { return requirePort(connections); }

  async function listAll() {
    const rows = await connections.list();
    return Array.isArray(rows) ? rows.filter((row) => row && row.id) : [];
  }

  function ownedOf(rows, appId) {
    const key = String(appId || "");
    return rows.filter((row) => String(row.managedByAppId || "") === key);
  }

  /**
   * 源 mcp.ts:372-382。ID 冲突 + 既有策略判定，**不落盘**。
   * 任一声明不合规 → 整批结构化拒绝（fail-fast，保证 sync 的 0 次 save / 0 次 connect）。
   */
  async function assertAvailable(appId, declarations) {
    const port = guard();
    if (!port.ok) return port;
    const key = String(appId || "").trim();
    if (!key) return { ok: false, error: APP_MCP_ERROR.INVALID_DECLARATION, detail: "缺少 appId" };
    const list = Array.isArray(declarations) ? declarations : [];
    const plans = [];
    const seen = new Set();
    for (const declaration of list) {
      const verdict = evaluateDeclaration(declaration);
      if (!verdict.ok) return verdict;
      if (seen.has(verdict.plan.id)) return { ok: false, error: APP_MCP_ERROR.INVALID_DECLARATION, declarationId: verdict.plan.id, detail: "批内重复 id：" + verdict.plan.id };
      seen.add(verdict.plan.id);
      plans.push(verdict.plan);
    }
    const existing = await listAll();
    for (const plan of plans) {
      const collision = existing.find((item) => String(item.id) === plan.id);
      if (collision && String(collision.managedByAppId || "") !== key) {
        return {
          ok: false,
          error: APP_MCP_ERROR.SERVER_ID_CONFLICT,
          appId: key,
          declarationId: plan.id,
          owner: collision.managedByAppId ? String(collision.managedByAppId) : (collision.builtin === true ? "builtin" : "user"),
          detail: "MCP Server ID 已被占用：" + plan.id,
        };
      }
    }
    return { ok: true, appId: key, plans };
  }

  /**
   * 源 mcp.ts:384-426。按 managedByAppId 持久化声明，断开并清理不再声明的，连接允许且启用的。
   * 未通过 assertAvailable 时立即返回：0 次 save / 0 次 connect（不半途落盘）。
   */
  async function sync(appId, sourceRoot, declarations) {
    const port = guard();
    if (!port.ok) return port;
    const gate = await assertAvailable(appId, declarations);
    if (!gate.ok) return gate;
    const key = gate.appId;
    const plans = gate.plans;
    const existing = await listAll();
    const owned = ownedOf(existing, key);
    const declaredIds = new Set(plans.map((plan) => plan.id));

    const removed = [];
    if (owned.some((row) => !declaredIds.has(String(row.id)))) {
      if (typeof connections.remove !== "function") return portUnavailable("connections.remove", "端口未提供 remove：无法清理 App 不再声明的托管服务");
    }
    for (const row of owned) {
      if (declaredIds.has(String(row.id))) continue;
      await connections.disconnect(String(row.id));
      await connections.remove(String(row.id));
      removed.push(String(row.id));
    }

    const appOn = appEnabled(key);
    const saved = [];
    const connected = [];
    const skipped = [];
    for (const plan of plans) {
      const previous = existing.find((row) => String(row.id) === plan.id);
      // 源 :410：显式 autoStart 属包契约；未声明时沿用用户上次状态，新服务默认关。
      const wantsEnabled = plan.autoStartDeclared ? plan.autoStart : previous ? previous.enabled === true : false;
      // App 已禁用时其托管服务一律不可用（既有语义 = enabled:false + DISABLED），不因为 autoStart 就偷偷连上。
      const enabled = wantsEnabled && appOn !== false;
      const record = {
        id: plan.id,
        name: plan.name,
        transport: plan.transport,
        location: plan.location,
        endpoint: plan.endpoint,
        managedByAppId: key,
        appManaged: true,
        autoStart: plan.autoStart === true,
        enabled,
        status: enabled ? "CONNECTING" : domain.STATUS.DISABLED,
        updatedAt: now(),
      };
      const stored = (await connections.save(record)) || record;
      saved.push(stored);
      if (!wantsEnabled) { skipped.push({ id: plan.id, reason: "DISABLED" }); continue; }
      if (appOn === false) { skipped.push({ id: plan.id, reason: "APP_DISABLED" }); continue; }
      await connections.connect(stored);
      connected.push(plan.id);
    }
    if (log) { try { log("mcp-app-sync", { appId: key, saved: saved.length, connected: connected.length, removed: removed.length }); } catch { /* 日志失败不影响主流程 */ } }
    // sourceRoot 只用于源的 cwd 越界校验（:393-396）；本仓本地程序由白名单固定映射、无 App cwd，
    // 这里如实保留签名但不假装用它做了路径校验。
    void sourceRoot;
    return { ok: true, appId: key, servers: saved, connected, removed, skipped };
  }

  /** 源 mcp.ts:428-434。移除该 App 的全部托管记录；别的 App 的记录不动。 */
  async function remove(appId) {
    const port = guard();
    if (!port.ok) return port;
    const key = String(appId || "").trim();
    if (!key) return { ok: false, error: APP_MCP_ERROR.INVALID_DECLARATION, detail: "缺少 appId" };
    const rows = await listAll();
    const owned = ownedOf(rows, key);
    if (!owned.length) return { ok: true, appId: key, count: 0, removed: [], disconnected: 0 };
    if (typeof connections.remove !== "function") return portUnavailable("connections.remove", "端口未提供 remove：无法清理 App 托管记录");
    const removed = [];
    for (const row of owned) {
      const id = String(row.id);
      await connections.disconnect(id);
      await connections.remove(id);
      removed.push(id);
    }
    if (log) { try { log("mcp-app-remove", { appId: key, count: removed.length }); } catch { /* 忽略 */ } }
    return { ok: true, appId: key, count: removed.length, removed, disconnected: removed.length };
  }

  /**
   * App 启用/禁用 → 其托管连接的生命周期（任务书 item 2 的"绑定"落点）。
   *   禁用：断开 + enabled=false + status=DISABLED（既有"不可用"语义，不改 enabled 以外的字段）；
   *   启用：逐条按既有白名单/策略**重新判定**，通过才 save(enabled=true) + connect；不通过如实记 rejected。
   */
  async function setAppEnabled(appId, enabled) {
    const port = guard();
    if (!port.ok) return port;
    const key = String(appId || "").trim();
    if (!key) return { ok: false, error: APP_MCP_ERROR.INVALID_DECLARATION, detail: "缺少 appId" };
    const rows = await listAll();
    const owned = ownedOf(rows, key);
    if (enabled !== true) {
      const disabled = [];
      for (const row of owned) {
        const id = String(row.id);
        await connections.disconnect(id);
        await connections.save({ ...row, enabled: false, status: domain.STATUS.DISABLED, updatedAt: now() });
        disabled.push(id);
      }
      return { ok: true, appId: key, enabled: false, count: owned.length, disabled };
    }
    const connected = [];
    const rejected = [];
    for (const row of owned) {
      const id = String(row.id);
      const verdict = evaluateRecord(row);
      if (!verdict.ok) { rejected.push({ id, error: verdict.error, policy: verdict.policy || null, detail: verdict.detail }); continue; }
      const stored = (await connections.save({ ...row, enabled: true, status: "CONNECTING", updatedAt: now() })) || row;
      await connections.connect(stored);
      connected.push(id);
    }
    return { ok: rejected.length === 0, appId: key, enabled: true, count: owned.length, connected, rejected };
  }

  /** 只读：某 App 当前托管的记录（不落盘）。 */
  async function listOwned(appId) {
    const port = guard();
    if (!port.ok) return port;
    const key = String(appId || "").trim();
    const rows = await listAll();
    return { ok: true, appId: key, servers: ownedOf(rows, key) };
  }

  return { assertAvailable, sync, remove, setAppEnabled, listOwned, evaluateDeclaration, evaluateRecord };
}

module.exports = {
  createAppManagedMcpRegistry,
  evaluateDeclaration,
  evaluateRecord,
  APP_MCP_ERROR,
  POLICY,
  AGENT_DEPENDENCY_UNAVAILABLE,
};
