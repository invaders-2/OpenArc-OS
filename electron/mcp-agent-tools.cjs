/**
 * B4d · MCP 缺口：工具聚合 + 调用审批链（源 server/mcp.ts 逐函数移植）。
 *
 * ── 本文件覆盖的源行号（源：server/mcp.ts，共 1129 行）────────────────────────
 *   · :460-464        JSON_SCHEMA_TYPES / isRecord
 *   · :466-486        collectionItemType / normalizeSchemaType
 *   · :488-532        sanitizeJsonSchema（聚合出来的 parameters 走这里）
 *   · :244-245        SEARCH_TOOL_RE / isSearchTool
 *   · :820-841        collectAgentTools（mcp__<server>__<tool> 命名空间）
 *   · :844-848        agentTools
 *   · :850-854        agentToolsForServer
 *   · :856-860        searchAgentTools
 *   · :862-881        callByName
 *   · :883-991        callDirect（去掉领星网关分支，见下）
 *   · :993-1001       initMcp
 *   · :1003-1007      migrateMcpStorage
 *   · :1010-1035      toStrMap / entryToServer / guessName（parseImport 内部）
 *   · :1052-1106      parseImport
 *   · :1108-1129      importServers
 *   · :312            isSystemServer（SYSTEM_SERVERS 见 :246-296、SYSTEM_IDS 见 :297）
 *   · :666-669        isMcpDisconnectedError
 *   · :801-807        refreshServer
 *   · :809-818        setServerEnabled
 *
 * ── 云与商业化（本文件逐条核对，确认无引用）──────────────────────────────────
 *   · dxosProtocol（云端 AI 任务）：源 server/mcp.ts 全文 grep 无命中 → 本文件无引用，无需注入。
 *   · apiQuota（计费）：同上，源 server/mcp.ts 无命中 → 不引入。
 *   · cloudEntitlement（权益/会员门禁）：同上，源 server/mcp.ts 无命中 → 不引入。
 *   结论：B4d 的 mcp.ts 这一段本来就不触云；三者在别批（B4a/B4b/B4c）处理，本文件不做兼容层。
 *
 * ── 依赖后续批次 / 第三方 → 只保留签名 + 结构化 AGENT_DEPENDENCY_UNAVAILABLE ──
 *   · assertAppManagedMcpAvailable(:372-382) / syncAppManagedMcpServers(:384-426) /
 *     removeAppManagedMcpServers(:428-434)：依赖开发者 App（B7，源走 managedByAppId）。
 *     本波无法落地 → 原样保留签名，一律返回 { ok:false, error:AGENT_DEPENDENCY_UNAVAILABLE }，
 *     绝不落盘、绝不假装注册成功。
 *   · buildLingxingGatewayActionArgs(:155-198) / parseLingxingGatewayTool(:200-232)：
 *     领星 ERP 网关属第三方集成插件（B7，默认关）。本波不移植目录查询/缓存/版本重试
 *     （源 :120-243、:534-549 withServerCallPacing 一并留给 B7）；只保留签名 + 结构化不可用。
 *
 * ── 与源的三处**有意**差异（都为了"失败要出声"，不是偷偷兜底）───────────────
 *   1) 源用模块级全局状态（runtime / loadCfg / persist / toolIndex）。本仓不新建全局：
 *      配置与运行时状态通过 options.servers 端口注入（未注入 = 结构化
 *      AGENT_DEPENDENCY_UNAVAILABLE），工具索引挂在返回的 API 实例上（见 createMcpAgentTools）。
 *   2) 源 callByName/callDirect 直接 throw。本文件返回结构化结果
 *      { ok:true, text } / { ok:false, error, decisionStatus?, approvalRequestId? }，
 *      否则无法把 APPROVAL_REQUIRED / APPROVAL_DENIED 如实交给调用方（本批硬要求）。
 *   3) 源 collectAgentTools 不去重（同名生成名会互相覆盖 toolIndex）。本文件显式按生成名去重
 *      （首个胜），并保证索引与返回列表严格一致。
 *
 * ── 传输接线（B4e 收口后）────────────────────────────────────────────────────
 *   · 本文件仍不含 JSON-RPC/子进程代码：真实请求由注入的传输发出。
 *     生产装配点是 electron/mcp-live-transport.cjs（McpService 的活连接），由 main.cjs
 *     注入 bridge；测试可注入假传输观察调用次数。
 *   · 未注入 transport / clientFor 时返回结构化 MCP_TOOL_INVOCATION_NOT_ENABLED，
 *     **绝不伪造成功**。
 *   · 审批通过后本层签发 authorization 凭证（第二参数）交给传输；electron/mcp-client.cjs
 *     会复核"开关开启 + 审批凭证 ALLOWED"才真正发 tools/call（双条件 fail closed）。
 *   · 审批链：options.approval 未注入时，无法证明审批 → 返回结构化
 *     AGENT_DEPENDENCY_UNAVAILABLE（fail closed，0 次远端调用）。已提供两个**真实**适配器：
 *     createControlledToolProxyApprovalPort（包 electron/controlled-tool-proxy.cjs 的
 *     propose()）与 createSideEffectApprovalPort（包 electron/side-effect-runtime.cjs 的
 *     proposeWrite()）。两者都只是把既有裁决投影成 DECISION_STATUS，不新建第二套 authority。
 *   · 配置读写（initMcp/migrateMcpStorage/refreshServer/setServerEnabled/importServers）：
 *     源是 dataPath('mcp.json') 的原始配置模型；本仓 MCP 连接是 SQLite + 本地白名单
 *     （electron/mcp-domain.cjs:94-104 LOCAL_SERVERS，没有任意 command）。两者不可直接映射 →
 *     通过 options.servers 端口注入；未注入时结构化 AGENT_DEPENDENCY_UNAVAILABLE。
 *
 * 全程离线：本文件不触盘、不发网络、不 require 任何第三方包。
 */
"use strict";

const domain = require("./mcp-domain.cjs");

/** 复用 mcp-domain 的稳定错误码，不另造一套 MCP_*。 */
const ERROR_CODE = domain.ERROR_CODE;

/** B4d 自己的结构化结果码（只加 mcp-domain 里没有的语义）。 */
const MCP_AGENT_ERROR = Object.freeze({
  UNKNOWN_MCP_TOOL: "UNKNOWN_MCP_TOOL",
  MCP_SERVER_NOT_FOUND: "MCP_SERVER_NOT_FOUND",
  MCP_SERVER_NOT_CONNECTED: "MCP_SERVER_NOT_CONNECTED",
  MCP_TOOL_INVOCATION_NOT_ENABLED: ERROR_CODE.MCP_TOOL_INVOCATION_NOT_ENABLED,
  MCP_CONNECTION_NOT_FOUND: ERROR_CODE.MCP_CONNECTION_NOT_FOUND,
  MCP_IMPORT_INVALID: "MCP_IMPORT_INVALID",
  MCP_SYSTEM_SERVER_PROTECTED: "MCP_SYSTEM_SERVER_PROTECTED",
  MCP_TOOL_CALL_FAILED: "MCP_TOOL_CALL_FAILED",
  MCP_APPROVAL_FAILED: "MCP_APPROVAL_FAILED",
  AGENT_DEPENDENCY_UNAVAILABLE: "AGENT_DEPENDENCY_UNAVAILABLE",
});

/** 与 electron/agent-runtime-deps.cjs:17 同一个码，便于上层统一判"该能力本轮未接入"。 */
const AGENT_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";

/** 审批裁决词汇与 electron/tool-domain.cjs:26 DECISION_STATUS 完全一致（不新造）。 */
const DECISION_STATUS = Object.freeze({
  ALLOWED: "ALLOWED",
  DENIED: "DENIED",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  INVALID: "INVALID",
  BLOCKED: "BLOCKED",
});

/** 结构化依赖缺失：保留 name/code/dependency 三元组，便于 IPC 侧判定。 */
function dependencyUnavailable(dependency, detail) {
  const out = { ok: false, error: AGENT_DEPENDENCY_UNAVAILABLE, dependency: String(dependency) };
  if (detail !== undefined) out.detail = String(detail);
  return out;
}

/** 源 mcp.ts:462-464。 */
function isRecord(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 源 mcp.ts:460。 */
const JSON_SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

/** 源 mcp.ts:466-469。 */
function collectionItemType(label) {
  const m = String(label).match(/^(?:array|list|set|seq|sequence)\s*<\s*(.+?)\s*>$/i);
  return m && m[1] ? m[1] : null;
}

/** 源 mcp.ts:471-486。把 MCP 服务端常见的松散类型标注收敛成 JSON Schema 类型。 */
function normalizeSchemaType(v) {
  if (Array.isArray(v)) {
    const types = v.map((x) => normalizeSchemaType(x)).flatMap((x) => (Array.isArray(x) ? x : x ? [x] : []));
    return types.length ? [...new Set(types)] : undefined;
  }
  if (typeof v !== "string") return undefined;
  const raw = v.trim();
  const t = raw.toLowerCase();
  if (JSON_SCHEMA_TYPES.has(t)) return t;
  if (t === "str") return "string";
  if (t === "int" || t === "long") return "integer";
  if (t === "float" || t === "double" || t === "decimal") return "number";
  if (t === "bool") return "boolean";
  if (/^(map|dict|dictionary|record)\b/.test(t)) return "object";
  if (/^(array|list|set|seq|sequence)\b/.test(t)) return "array";
  if (t === "any" || t === "unknown" || t === "object any") return undefined;
  return "string";
}

/** 源 mcp.ts:488-532。root=true 时强制顶层 type=object（供 agent function.parameters 用）。 */
function sanitizeJsonSchema(schema, root = false) {
  const src = isRecord(schema) ? schema : {};
  const out = {};
  const rawType = src.type;
  const type = normalizeSchemaType(rawType);
  if (type) out.type = Array.isArray(type) && type.length === 1 ? type[0] : type;

  for (const [key, value] of Object.entries(src)) {
    if (key === "type" || key === "$schema") continue;
    if (key === "properties" && isRecord(value)) {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeJsonSchema(v)]));
    } else if (key === "items") {
      out.items = sanitizeJsonSchema(value);
    } else if (key === "additionalProperties") {
      out.additionalProperties = isRecord(value) ? sanitizeJsonSchema(value) : value !== false;
    } else if ((key === "oneOf" || key === "anyOf" || key === "allOf") && Array.isArray(value)) {
      out[key] = value.map((v) => sanitizeJsonSchema(v));
    } else if ((key === "$defs" || key === "definitions" || key === "patternProperties") && isRecord(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeJsonSchema(v)]));
    } else if (key === "required" && Array.isArray(value)) {
      out.required = value.filter((x) => typeof x === "string");
    } else {
      out[key] = value;
    }
  }

  if (typeof rawType === "string") {
    const itemType = collectionItemType(rawType.trim());
    if (itemType && !out.items) out.items = sanitizeJsonSchema({ type: itemType });
    if (/^(map|dict|dictionary|record)\b/i.test(rawType.trim()) && out.additionalProperties === undefined) out.additionalProperties = true;
  }
  if (root) out.type = "object";
  if (out.type === "object" && out.properties === undefined && out.additionalProperties === undefined) out.properties = {};
  if (out.type === "array" && out.items === undefined) out.items = {};
  return out;
}

/** 源 mcp.ts:429-431。agent 工具名只允许 [a-zA-Z0-9_-]。 */
function safeName(s) {
  return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 源 mcp.ts:244-245。 */
const SEARCH_TOOL_RE = /\b(search|web|internet|fetch|crawl|scrape|browse|browser|page|url|news|query|weather|bing|google|duckduckgo|brave|tavily|searx|firecrawl|playwright)\b|搜索|联网|网页|抓取|浏览|新闻|天气/i;

/** 源 mcp.ts:240-242。 */
function isSearchTool(cfg, tool) {
  return SEARCH_TOOL_RE.test(`${cfg && cfg.name} ${cfg && cfg.id} ${tool && tool.name} ${(tool && tool.description) || ""}`);
}

/**
 * 源 mcp.ts:312（isSystemServer = SYSTEM_IDS.has(id)；SYSTEM_SERVERS 见 :246-296）。
 * 本仓没有源 SYSTEM_SERVERS 常量表，系统身份由端口给出的 systemServerIds 决定；
 * 未给时回退到连接记录上的 builtin / managedBy 标记（与源 builtin:true 同义）。
 */
function isSystemServer(id, systemServerIds = null) {
  const key = String(id || "");
  if (systemServerIds instanceof Set) return systemServerIds.has(key);
  if (Array.isArray(systemServerIds)) return systemServerIds.map(String).includes(key);
  return false;
}

/** 从连接描述符推导系统 server 集合：builtin === true 或带 managedBy（源 :246-296 的两种标记）。 */
function systemServerIdsOf(servers = []) {
  const out = new Set();
  for (const server of Array.isArray(servers) ? servers : []) {
    if (!server) continue;
    if (server.builtin === true || server.managedBy) out.add(String(server.id || ""));
  }
  return out;
}

/**
 * 源 mcp.ts:666-669。连接被服务端/子进程中断的措辞识别。
 * 注意：它只识别"连接掉了"，不把业务错误当成断连 —— 与源完全一致。
 */
function isMcpDisconnectedError(error) {
  const message = String((error && error.message) || error || "");
  return /\bnot connected\b|client.*not connected|transport.*not connected|connection.*not (?:established|open)|connection (?:is )?closed/i.test(message);
}

// ── 一键导入：解析各种常见的 MCP 配置格式（源 mcp.ts:1009-1106）─────────────
// 支持同源 5 种：
//   1. {"mcpServers": {name: {command,args,env}}}
//   2. {"servers": {...}} / {"mcp": {"servers": {...}}}
//   3. 单个服务器对象 {"command":"...","args":[...]} 或 {"url":"..."}
//   4. 纯 URL（http/https 一行）
//   5. 命令行一行（npx -y @scope/some-mcp@latest）

/** 导入解析失败统一带 error.code，供 importServers 收敛成结构化结果。 */
function importError(message) {
  const err = new Error(message);
  err.name = "McpImportError";
  err.code = MCP_AGENT_ERROR.MCP_IMPORT_INVALID;
  return err;
}

/** 源 mcp.ts:1010-1016。 */
function toStrMap(v) {
  if (!v || typeof v !== "object") return undefined;
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = String(val);
  return Object.keys(out).length ? out : undefined;
}

/** 源 mcp.ts:1018-1027。 */
function entryToServer(name, v) {
  const url = typeof v.url === "string" ? v.url : typeof v.serverUrl === "string" ? v.serverUrl : "";
  if (url) return { name, transport: "http", url, headers: toStrMap(v.headers) };
  const command = typeof v.command === "string" ? v.command.trim() : "";
  if (!command) return null;
  const args = Array.isArray(v.args) ? v.args.map(String) : [];
  const cwd = typeof v.cwd === "string" && v.cwd.trim() ? v.cwd.trim() : undefined;
  return { name, transport: "stdio", command, args, env: toStrMap(v.env), cwd };
}

/** 源 mcp.ts:1029-1035。从条目里猜一个可读名称（去掉 scope/版本号/-mcp 后缀之类）。 */
function guessName(fallback, s) {
  if (fallback && fallback !== "mcp") return fallback;
  const src = s.url || (s.args || []).find((a) => a.includes("/") || a.includes("mcp")) || s.command || "mcp";
  return String(src).split("/").pop().replace(/@latest$/, "").replace(/\.(js|py)$/, "") || "mcp";
}

/**
 * 源 mcp.ts:1052-1106。合法输入返回 ParsedServer[]；非法输入 throw（与源一致，消息也一致），
 * 但额外带 code = MCP_IMPORT_INVALID，方便 importServers / IPC 直接判定。
 */
function parseImport(text) {
  const raw = String(text || "").trim();
  if (!raw) throw importError("内容为空");

  // 纯 URL
  if (/^https?:\/\/\S+$/i.test(raw)) {
    return [{ name: guessName("", { name: "", transport: "http", url: raw }), transport: "http", url: raw }];
  }

  // 命令行一行（npx / uvx / uv / node / python …）
  if (!raw.startsWith("{") && !raw.startsWith("[")) {
    const parts = raw.split(/\s+/);
    if (parts.length < 1) throw importError("无法识别的格式");
    const s = { name: "", transport: "stdio", command: parts[0], args: parts.slice(1) };
    s.name = guessName("", s);
    return [s];
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    // 宽容：去掉尾逗号再试一次
    try {
      json = JSON.parse(raw.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      throw importError("JSON 解析失败，请检查格式");
    }
  }
  const obj = json;

  // 找到 servers map
  let map = null;
  if (obj.mcpServers && typeof obj.mcpServers === "object") map = obj.mcpServers;
  else if (obj.servers && typeof obj.servers === "object") map = obj.servers;
  else if (obj.mcp && typeof obj.mcp === "object" && obj.mcp.servers) map = obj.mcp.servers;

  const out = [];
  if (map) {
    for (const [name, v] of Object.entries(map)) {
      if (!v || typeof v !== "object") continue;
      const s = entryToServer(name, v);
      if (s) out.push(s);
    }
  } else {
    // 单个服务器对象
    const s = entryToServer("", obj);
    if (s) {
      s.name = guessName("", s);
      out.push(s);
    }
  }
  if (!out.length) {
    throw importError("没有找到可导入的服务器（支持 mcpServers/servers 格式、单个 {command,args} 对象、URL 或命令行）");
  }
  return out;
}

// ── 依赖开发者 App（B7）→ 只保留签名 + 结构化不可用（源 mcp.ts:372-434）──────
/** 源 :372-382。开发者 App 托管 MCP 的 ID 冲突校验；B7 落地前不可用。 */
function assertAppManagedMcpAvailable(appId, declarations) {
  void appId;
  void declarations;
  return dependencyUnavailable("developerApps", "开发者 App 托管 MCP 属 B7，本波未落地");
}
/** 源 :384-426。注册/同步 App 自带 MCP；B7 落地前不可用（不落盘、不连进程）。 */
function syncAppManagedMcpServers(appId, sourceRoot, declarations) {
  void appId;
  void sourceRoot;
  void declarations;
  return dependencyUnavailable("developerApps", "开发者 App 托管 MCP 属 B7，本波未落地");
}
/** 源 :428-434。移除 App 托管 MCP；B7 落地前不可用。 */
function removeAppManagedMcpServers(appId) {
  void appId;
  return dependencyUnavailable("developerApps", "开发者 App 托管 MCP 属 B7，本波未落地");
}

// ── 领星 ERP 网关 helper（第三方集成插件 B7，默认关）→ 签名 + 结构化不可用 ──
/** 源 :155-198。领星 search→action 参数构造；属第三方集成插件（B7），本波不移植。 */
function buildLingxingGatewayActionArgs(metadata, args, usesObjectParams) {
  void metadata;
  void args;
  void usesObjectParams;
  return dependencyUnavailable("lingxingGateway", "领星网关属第三方集成插件（B7，默认关），本波未落地");
}
/** 源 :200-232。领星目录返回解析；属第三方集成插件（B7），本波不移植。 */
function parseLingxingGatewayTool(searchText, toolName) {
  void searchText;
  void toolName;
  return dependencyUnavailable("lingxingGateway", "领星网关属第三方集成插件（B7，默认关），本波未落地");
}

// ── 审批链适配器：把既有 authority 的裁决投影成 DECISION_STATUS，不新建第二套 ──
/**
 * 真实适配器 1：包 electron/controlled-tool-proxy.cjs 的 propose()（READ 路由）。
 *
 * 注意（必须如实告知上层）：源 MCP 工具在本仓 ToolRegistry 里还没有 contract，
 * 因此 proxy.propose() 现在会以 Registry 解析失败收敛为 DENIED —— 这是 fail-closed，
 * 不是成功。等 MCP 工具 contract 进入 Registry（后续批次）后本适配器即可放行。
 *
 * @param {object} opts
 * @param {object} opts.proxy   ControlledToolProxy 实例（必须提供）
 * @param {string} opts.taskId  真实 Task（propose 强制要求）
 * @param {(serverId:string, toolName:string)=>string} opts.toolIdFor
 * @param {(serverId:string, toolName:string)=>number} [opts.toolVersionFor]
 * @param {string} [opts.stepId] @param {string} [opts.runId]
 */
function createControlledToolProxyApprovalPort({ proxy, taskId = null, toolIdFor, toolVersionFor = null, stepId = null, runId = null } = {}) {
  return {
    kind: "controlled-tool-proxy",
    async authorize({ context = {}, serverId, toolName, arguments: args, taskId: callTaskId = null, stepId: callStepId = null, runId: callRunId = null } = {}) {
      if (!proxy || typeof proxy.propose !== "function") return dependencyUnavailable("controlledToolProxy", "未注入 ControlledToolProxy");
      // 任务上下文既可在构造时固定（agent tool loop），也可逐调用传入（mcp/toolInvocation/call 经可信 taskId 解析）。
      const effectiveTaskId = callTaskId != null && String(callTaskId) !== "" ? String(callTaskId) : (taskId ? String(taskId) : null);
      if (!effectiveTaskId) return dependencyUnavailable("controlledToolProxy", "缺少 taskId：propose 强制要求真实 Task");
      if (typeof toolIdFor !== "function") return dependencyUnavailable("controlledToolProxy", "缺少 toolIdFor：无法把 MCP 工具映射到 Registry toolId");
      const toolId = toolIdFor(serverId, toolName);
      const res = proxy.propose({
        context: context || {},
        taskId: effectiveTaskId,
        stepId: callStepId || stepId || null,
        runId: callRunId || runId || null,
        toolId,
        toolVersion: toolVersionFor ? toolVersionFor(serverId, toolName) : null,
        arguments: args && typeof args === "object" ? args : {},
      });
      if (!res || res.ok !== true) return { decisionStatus: DECISION_STATUS.DENIED, reasonCode: (res && res.reasonCode) || "TOOL_DENIED" };
      const proposalId = res.proposal ? res.proposal.proposalId : null;
      // ControlledToolProxy 没有独立的 approvalRequestId：审批请求就是这次 proposal 本身。
      return { decisionStatus: res.decisionStatus, reasonCode: res.reasonCode || null, proposalId, approvalRequestId: proposalId };
    },
  };
}

/**
 * 真实适配器 2：包 electron/side-effect-runtime.cjs 的 proposeWrite()（WRITE 路由）。
 *
 * 只把"已登记、等待可信用户审批"如实投影为 APPROVAL_REQUIRED + approvalRequestId；
 * 本层**不执行**：执行权在 SideEffectAuthority（lease/claim/verify），MCP 传输拿不到它。
 * 未登记（Registry 无 contract）时 proposeWrite 会返回失败 → 投影为 DENIED。
 */
function createSideEffectApprovalPort({ runtime, taskId = null, toolIdFor, toolVersionFor = null, stepId = null, runId = null } = {}) {
  return {
    kind: "side-effect-runtime",
    async authorize({ context = {}, serverId, toolName, arguments: args, taskId: callTaskId = null, stepId: callStepId = null, runId: callRunId = null } = {}) {
      if (!runtime || typeof runtime.proposeWrite !== "function") return dependencyUnavailable("sideEffectRuntime", "未注入 SideEffectRuntime");
      const effectiveTaskId = callTaskId != null && String(callTaskId) !== "" ? String(callTaskId) : (taskId ? String(taskId) : null);
      if (!effectiveTaskId) return dependencyUnavailable("sideEffectRuntime", "缺少 taskId：proposeWrite 强制要求真实 Task");
      if (typeof toolIdFor !== "function") return dependencyUnavailable("sideEffectRuntime", "缺少 toolIdFor：无法把 MCP 工具映射到 Registry toolId");
      const toolId = toolIdFor(serverId, toolName);
      const planned = await runtime.proposeWrite({
        context: context || {},
        taskId: effectiveTaskId,
        stepId: callStepId || stepId || null,
        runId: callRunId || runId || null,
        toolId,
        toolVersion: toolVersionFor ? toolVersionFor(serverId, toolName) : null,
        arguments: args && typeof args === "object" ? args : {},
      });
      if (planned && planned.ok === true && planned.approvalRequestId) {
        return { decisionStatus: DECISION_STATUS.APPROVAL_REQUIRED, approvalRequestId: planned.approvalRequestId, reasonCode: null };
      }
      return { decisionStatus: DECISION_STATUS.DENIED, reasonCode: (planned && planned.error) || "SIDE_EFFECT_NO_PLAN" };
    },
  };
}

/**
 * B4e 收口 · **任务内** MCP 工具调用的审批端口（生产装配点）。
 *
 * 两段：
 *   1) ControlledToolProxy.propose（唯一权威裁决：session / Task 归属 / Registry 合同 / schema / risk）；
 *   2) propose 收敛为 APPROVAL_REQUIRED 时，交给注入的 trustedApproval 取**可信用户决定**
 *      （APPROVED / DENIED / TIMEOUT）。未注入 trustedApproval = 保持 APPROVAL_REQUIRED
 *      （等待审批，0 次传输），绝不自动放行 —— 与仓库"external 副作用必须显式审批"一致。
 *
 * trustedApproval 是**宿主注入的可信决定来源**（UI / 既有审批网关）；本层不新建审批权威。
 */
function createTaskApprovalPort({ proxy, taskId = null, toolIdFor, toolVersionFor = null, stepId = null, runId = null, trustedApproval = null, approvalTimeoutMs = 0 } = {}) {
  const proposePort = createControlledToolProxyApprovalPort({ proxy, taskId, toolIdFor, toolVersionFor, stepId, runId });
  return {
    kind: "task-approval",
    async authorize(payload = {}) {
      const base = await proposePort.authorize(payload);
      if (!base || base.decisionStatus !== DECISION_STATUS.APPROVAL_REQUIRED) return base;
      if (typeof trustedApproval !== "function") return base; // 等待审批：0 次传输
      let outcome;
      try {
        outcome = await trustedApproval({
          approvalRequestId: base.approvalRequestId || null,
          proposalId: base.proposalId || null,
          taskId: payload.taskId || taskId || null,
          serverId: payload.serverId,
          toolName: payload.toolName,
          arguments: payload.arguments && typeof payload.arguments === "object" ? payload.arguments : {},
          timeoutMs: approvalTimeoutMs,
        });
      } catch (e) {
        return { decisionStatus: DECISION_STATUS.DENIED, reasonCode: "APPROVAL_FAILED", detail: String((e && e.message) || e).slice(0, 200) };
      }
      const decision = String((outcome && (outcome.decision || outcome.decisionStatus)) || "").toUpperCase();
      if (decision === "APPROVED" || decision === DECISION_STATUS.ALLOWED) {
        return { decisionStatus: DECISION_STATUS.ALLOWED, approvalRequestId: base.approvalRequestId || null, proposalId: base.proposalId || null, reasonCode: "APPROVED" };
      }
      if (decision === "TIMEOUT" || decision === "APPROVAL_TIMEOUT") {
        return { decisionStatus: "TIMEOUT", approvalRequestId: base.approvalRequestId || null, proposalId: base.proposalId || null, reasonCode: "APPROVAL_TIMEOUT" };
      }
      return { decisionStatus: DECISION_STATUS.DENIED, approvalRequestId: base.approvalRequestId || null, proposalId: base.proposalId || null, reasonCode: (outcome && outcome.reasonCode) || "APPROVAL_DENIED" };
    },
  };
}

/**
 * 从真实 Task 里解析"当前正在跑的 step / 最新 harness run"（**只读既有状态，不新建、不伪造**）。
 * authority 的 execution eligibility 要求 call 绑定 RUNNING step + latest run；调用方没给时按这里取。
 */
function deriveRunContext(runtime, taskId) {
  const taskStore = runtime && runtime.taskStore ? runtime.taskStore : null;
  if (!taskStore || !taskId) return { stepId: null, runId: null };
  let runningStep = null;
  try {
    const steps = typeof taskStore.stepsOfTask === "function" ? taskStore.stepsOfTask(String(taskId)) : [];
    runningStep = (Array.isArray(steps) ? steps : []).find((s) => s && String(s.status) === "RUNNING") || null;
  } catch { runningStep = null; }
  let chosenRun = null;
  try {
    const runs = typeof taskStore.harnessRunsOfTask === "function" ? taskStore.harnessRunsOfTask(String(taskId)) : [];
    const list = Array.isArray(runs) ? runs : [];
    if (runningStep) chosenRun = [...list].reverse().find((r) => r && String(r.step_id) === String(runningStep.step_id)) || null;
    if (!chosenRun) {
      const latest = list.length ? list[list.length - 1] : null;
      if (latest && String(latest.status) === "RUNNING") chosenRun = latest;
    }
  } catch { chosenRun = null; }
  // step 与 run 必须成对：只给 step 不给 run 仍会在 eligibility 的 run gate 失败，等于没有绑定。
  if (!chosenRun) return { stepId: null, runId: null };
  return { stepId: chosenRun.step_id || (runningStep ? runningStep.step_id : null), runId: chosenRun.run_id };
}

/**
 * D5-04 · **真实审批链**的任务内 MCP 审批端口（生产装配点）。
 *
 * 与 createTaskApprovalPort 的区别：不再要求宿主注入 trustedApproval 桩，而是把一次 MCP 调用交给
 * **既有 SideEffectAuthority** 走完整条链：
 *   proposeWrite（plan，electron/side-effect-runtime.cjs:102）
 *   → 既有 trusted 审批命令 sideEffect/decideApproval（electron/side-effect-bootstrap.cjs:39）
 *   → resolvePendingForStep（既有 lease/claim/verify 执行路径，electron/side-effect-runtime.cjs:400）
 *   → 结果交回本层；executed=true 让 callResolved 跳过第二次传输。
 *
 * 未批准 / 被拒 / 超时一律 0 传输；执行失败结构化返回，绝不假成功。本层不新建审批权威。
 */
function createSideEffectExecutionPort({ runtime, taskId = null, toolIdFor, toolVersionFor = null, stepId = null, runId = null, approvalTimeoutMs = null } = {}) {
  return {
    kind: "side-effect-execution",
    async authorize(payload = {}) {
      const { context = {}, serverId, toolName, arguments: args, taskId: callTaskId = null, stepId: callStepId = null, runId: callRunId = null } = payload || {};
      if (!runtime || typeof runtime.proposeWrite !== "function" || typeof runtime.resolvePendingForStep !== "function") {
        return dependencyUnavailable("sideEffectRuntime", "未注入 SideEffectRuntime（proposeWrite / resolvePendingForStep）");
      }
      const effectiveTaskId = callTaskId != null && String(callTaskId) !== "" ? String(callTaskId) : (taskId ? String(taskId) : null);
      if (!effectiveTaskId) return dependencyUnavailable("sideEffectRuntime", "缺少 taskId：proposeWrite 强制要求真实 Task");
      if (typeof toolIdFor !== "function") return dependencyUnavailable("sideEffectRuntime", "缺少 toolIdFor：无法把 MCP 工具映射到 Registry toolId");
      let effectiveStepId = callStepId || stepId || null;
      let effectiveRunId = callRunId || runId || null;
      if (!effectiveStepId || !effectiveRunId) {
        const derived = deriveRunContext(runtime, effectiveTaskId);
        if (!effectiveStepId) effectiveStepId = derived.stepId;
        if (!effectiveRunId) effectiveRunId = derived.runId;
      }
      const toolId = toolIdFor(serverId, toolName);
      let planned;
      try {
        planned = await runtime.proposeWrite({
          context: context || {}, taskId: effectiveTaskId, stepId: effectiveStepId, runId: effectiveRunId,
          toolId, toolVersion: toolVersionFor ? toolVersionFor(serverId, toolName) : null,
          arguments: args && typeof args === "object" ? args : {},
        });
      } catch (e) {
        return { decisionStatus: DECISION_STATUS.DENIED, reasonCode: "SIDE_EFFECT_PROPOSAL_FAILED", detail: String((e && e.message) || e).slice(0, 200) };
      }
      if (!planned || planned.ok !== true || !planned.approvalRequestId) {
        return { decisionStatus: DECISION_STATUS.DENIED, reasonCode: (planned && planned.error) || "SIDE_EFFECT_NO_PLAN" };
      }
      // 等既有 trusted 审批决定；APPROVED 后由同一条 lease/claim/verify 路径真实执行。
      let resolution;
      try {
        resolution = await runtime.resolvePendingForStep({ taskId: effectiveTaskId, stepId: effectiveStepId, runId: effectiveRunId, callIds: [planned.approvalRequestId], timeoutMs: approvalTimeoutMs });
      } catch (e) {
        return { decisionStatus: DECISION_STATUS.DENIED, approvalRequestId: planned.approvalRequestId, reasonCode: "SIDE_EFFECT_EXECUTION_FAILED", detail: String((e && e.message) || e).slice(0, 200) };
      }
      if (resolution && resolution.ok === true && resolution.decision === "APPROVED") {
        const normalized = normalizeCallResult(resolution.result == null ? { ok: true, content: [] } : resolution.result);
        // 成功与"已执行但结果失败"都回 executed=true：callResolved 据此绝不重复传输。
        return { decisionStatus: normalized.ok === true ? DECISION_STATUS.ALLOWED : DECISION_STATUS.DENIED, executed: true, approvalRequestId: planned.approvalRequestId, result: normalized, reasonCode: normalized.ok === true ? "APPROVED" : (normalized.error || "MCP_TOOL_CALL_FAILED") };
      }
      // 已派发但结果不可知 / 执行失败：同样 executed=true（绝不再发），错误结构化回传。
      if (resolution && (resolution.decision === "FAILED" || resolution.decision === "UNKNOWN_EFFECT")) {
        return {
          decisionStatus: DECISION_STATUS.DENIED, executed: true, approvalRequestId: planned.approvalRequestId,
          reasonCode: resolution.error || resolution.decision,
          result: { ok: false, error: resolution.error || "SIDE_EFFECT_EXECUTION_FAILED", detail: resolution.recoveredStatus || resolution.decision || null },
        };
      }
      if (resolution && resolution.decision === "TIMEOUT") return { decisionStatus: "TIMEOUT", approvalRequestId: planned.approvalRequestId, reasonCode: "APPROVAL_TIMEOUT" };
      return { decisionStatus: DECISION_STATUS.DENIED, executed: false, approvalRequestId: planned.approvalRequestId, reasonCode: (resolution && resolution.error) || "APPROVAL_DENIED" };
    },
  };
}

/** 连接就绪判定：兼容源措辞 'connected' 与本仓 mcp-domain STATUS 'READY'。 */
function isConnectedStatus(status) {
  const s = String(status || "");
  return s === "connected" || s === "READY";
}

/** MCP 工具返回 → 统一文本投影（源 :877-881 / :899-903）。 */
function normalizeCallResult(res) {
  if (res == null) return { ok: false, error: MCP_AGENT_ERROR.MCP_TOOL_CALL_FAILED, detail: "空响应" };
  // 本仓 McpClient.callTool() 的错误形状 { ok:false, error }
  if (res.ok === false) return { ok: false, error: res.error || MCP_AGENT_ERROR.MCP_TOOL_CALL_FAILED, detail: res.detail === undefined ? undefined : String(res.detail) };
  if (Array.isArray(res.content)) {
    const text = res.content.map((c) => (c && c.type === "text" ? c.text : `[${(c && c.type) || "unknown"}]`)).join("\n") || "(无返回内容)";
    if (res.isError) return { ok: false, error: MCP_AGENT_ERROR.MCP_TOOL_CALL_FAILED, detail: text, text };
    return { ok: true, text };
  }
  if (typeof res.text === "string") return { ok: true, text: res.text };
  return { ok: false, error: MCP_AGENT_ERROR.MCP_TOOL_CALL_FAILED, detail: "无法识别的工具返回形状" };
}

/**
 * B4d 唯一装配点（替代源 mcp.ts 的模块级 loadCfg/runtime/toolIndex）。
 *
 * @param {object} options
 * @param {object} [options.servers]  连接目录/配置端口：
 *    list():  [{ id, name, enabled, status, tools:[{name,description,inputSchema}], builtin?, managedBy?, error? }]
 *    save?(cfg) / disconnect?(id) / connect?(cfg) / refresh?(id)
 *    未注入 → 聚合/调用/配置读写一律结构化 AGENT_DEPENDENCY_UNAVAILABLE。
 * @param {object} [options.transport] tools/call 传输端口：callTool({ serverId, toolName, arguments, signal })。
 * @param {(serverId:string)=>object} [options.clientFor] 备选：返回 { callTool({name,arguments}) } 的活客户端。
 * @param {object} [options.approval] 审批链端口：authorize({ context, serverId, serverName, toolName, arguments })
 *    → { decisionStatus|decision, reasonCode?, approvalRequestId? }；未注入 → fail closed。
 * @param {object} [options.switch] B4e 显式开关端口：{ isEnabled() } 或 { isToolInvocationEnabled() }。
 *    未注入 = 保持既有组合语义（仅测试/低层组合用）；产品装配（mcp-agent-bridge.cjs）一定注入，
 *    且开关默认关闭 —— 关闭时 callByName/callDirect 在审批与传输之前就回
 *    MCP_TOOL_INVOCATION_NOT_ENABLED。
 * @param {Iterable<string>} [options.systemServerIds] 系统 server 白名单（源 SYSTEM_IDS）。
 * @param {()=>number} [options.clock] @param {object} [options.logger]
 */
function createMcpAgentTools(options = {}) {
  const serversPort = options.servers || null;
  const transport = options.transport || null;
  // B4e：MCP 工具调用显式开关端口（{ isEnabled() } 或 { isToolInvocationEnabled() }）。
  // 未注入 = 保持 B4d 既有组合语义（审批 → 传输）；产品装配（mcp-agent-bridge.cjs）一定注入。
  const switchPort = options.switch || null;
  const clientFor = typeof options.clientFor === "function" ? options.clientFor : null;
  const approval = options.approval || null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = options.logger || null;
  let systemIds = options.systemServerIds != null ? options.systemServerIds : null;
  /** 源 mcp.ts:126 toolIndex 的实例级替代：fname → { serverId, serverName, toolName }。 */
  let index = new Map();

  function isSystem(id) {
    if (systemIds != null) return isSystemServer(id, systemIds);
    return false;
  }

  /**
   * B4e 开关判据：未注入 switch 端口 → null（保持 B4d 既有组合语义）；
   * 注入后严格 === true 才放行，读取异常一律 fail closed（false）。
   */
  function isInvocationEnabled() {
    if (!switchPort) return null;
    try {
      if (typeof switchPort.isEnabled === "function") return switchPort.isEnabled() === true;
      if (typeof switchPort.isToolInvocationEnabled === "function") return switchPort.isToolInvocationEnabled() === true;
    } catch {
      return false;
    }
    return false;
  }

  async function listServers() {
    if (!serversPort || typeof serversPort.list !== "function") return null;
    const rows = await serversPort.list();
    const list = Array.isArray(rows) ? rows.filter((r) => r && r.id) : [];
    if (systemIds == null) systemIds = systemServerIdsOf(list);
    return list;
  }

  // ── 工具聚合（源 :820-860）──────────────────────────────────────────────
  async function collect(filter) {
    index = new Map();
    const rows = await listServers();
    if (rows === null) return { ...dependencyUnavailable("servers", "MCP 连接目录端口未注入，无法聚合工具"), tools: [] };
    const tools = [];
    const seen = new Set();
    for (const cfg of rows) {
      if (cfg.enabled === false) continue;
      if (!isConnectedStatus(cfg.status)) continue;
      for (const t of Array.isArray(cfg.tools) ? cfg.tools : []) {
        if (!t || !t.name) continue;
        if (filter && !filter(cfg, t)) continue;
        const fname = `mcp__${safeName(cfg.id)}__${safeName(t.name)}`;
        // 有意差异：源不去重（toolIndex 后写覆盖）。这里首个胜，且索引与列表严格一致。
        if (seen.has(fname)) continue;
        seen.add(fname);
        index.set(fname, { serverId: String(cfg.id), serverName: cfg.name || null, toolName: String(t.name) });
        tools.push({
          type: "function",
          function: {
            name: fname,
            description: `[MCP:${cfg.name}] ${t.description || t.name}`,
            parameters: sanitizeJsonSchema(t.inputSchema, true),
          },
        });
      }
    }
    return { ok: true, tools };
  }

  /** 源 :844-848。 */
  async function agentTools() { return collect(null); }
  /** 源 :850-854。 */
  async function agentToolsForServer(serverId) { return collect((cfg) => String(cfg.id) === String(serverId)); }
  /** 源 :856-860。 */
  async function searchAgentTools() { return collect((cfg, tool) => isSearchTool(cfg, tool)); }

  // ── 审批（本批关键要求：未通过审批绝不调远端）─────────────────────────────
  async function requestApproval({ server, serverId, toolName, args, context, taskId = null, stepId = null, runId = null }) {
    if (!approval || typeof approval.authorize !== "function") {
      return dependencyUnavailable("mcpApproval", "审批链未注入：无法证明审批，拒绝调用远端（fail closed）");
    }
    let decision;
    try {
      decision = await approval.authorize({
        context: context || {},
        serverId,
        serverName: server ? server.name || null : null,
        toolName,
        taskId: taskId == null ? null : String(taskId),
        stepId: stepId || null,
        runId: runId || null,
        arguments: args && typeof args === "object" ? args : {},
      });
    } catch (e) {
      return { ok: false, error: MCP_AGENT_ERROR.MCP_APPROVAL_FAILED, detail: String((e && e.message) || e) };
    }
    if (decision == null) return { ok: false, error: MCP_AGENT_ERROR.MCP_APPROVAL_FAILED, detail: "审批端口返回空" };
    const status = String(decision.decisionStatus || decision.decision || "").toUpperCase();
    const reasonCode = decision.reasonCode || null;
    // executed=true 表示"既有审批权威已经真实执行并回结果"（见 createSideEffectExecutionPort）：
    // callResolved 据此跳过第二次传输，绝不把一次调用发两遍；失败按结构化错误回，绝不冒充 APPROVAL_DENIED。
    if (decision.executed === true) {
      const result = decision.result && typeof decision.result === "object" ? decision.result : null;
      if (result && result.ok === true) return { ok: true, decisionStatus: DECISION_STATUS.ALLOWED, decision, executed: true, result };
      return { ok: false, error: (result && result.error) || MCP_AGENT_ERROR.MCP_TOOL_CALL_FAILED, detail: result && result.detail, decisionStatus: status || DECISION_STATUS.DENIED, reasonCode: reasonCode || (result && result.error) || MCP_AGENT_ERROR.MCP_TOOL_CALL_FAILED, executed: true, result };
    }
    if (status === DECISION_STATUS.ALLOWED) return { ok: true, decisionStatus: status, decision };
    if (status === DECISION_STATUS.APPROVAL_REQUIRED) {
      return { ok: false, error: "APPROVAL_REQUIRED", decisionStatus: status, approvalRequestId: decision.approvalRequestId || null, reasonCode };
    }
    // 审批超时与"拒绝"分开上报：调用方据此区分"用户点了拒绝"与"等不到人"。
    if (status === "TIMEOUT" || status === "APPROVAL_TIMEOUT") {
      return { ok: false, error: "APPROVAL_TIMEOUT", decisionStatus: "TIMEOUT", approvalRequestId: decision.approvalRequestId || null, reasonCode: reasonCode || "APPROVAL_TIMEOUT" };
    }
    if (status === DECISION_STATUS.DENIED || status === DECISION_STATUS.INVALID || status === DECISION_STATUS.BLOCKED) {
      return { ok: false, error: "APPROVAL_DENIED", decisionStatus: status, reasonCode };
    }
    // 未知裁决绝不猜成 ALLOWED。
    return { ok: false, error: MCP_AGENT_ERROR.MCP_APPROVAL_FAILED, detail: "审批端口返回未知裁决：" + status };
  }

  // ── 远端调用（本文件不含传输实现；传输必须注入）──────────────────────────
  /**
   * 审批通过后的**审批凭证**：既交给传输（第二个参数，深照既有 transport 入参形状不变），
   * McpClient.callTool 也据此复核"开关开启 + 审批通过"才发真实请求。
   * 未审批时本函数根本不会被调用（callResolved 已提前返回）。
   */
  function authorizationFor(gate) {
    const decision = gate && gate.decision && typeof gate.decision === "object" ? gate.decision : {};
    return {
      invocationEnabled: true,
      approval: {
        decision: "ALLOWED",
        approvalRequestId: decision.approvalRequestId || null,
        proposalId: decision.proposalId || null,
        reasonCode: (gate && gate.reasonCode) || null,
      },
    };
  }

  async function invokeRemote({ serverId, toolName, args, signal, authorization = null }) {
    const gate = authorization ? { authorization } : null;
    if (transport && typeof transport.callTool === "function") {
      return await transport.callTool({ serverId, toolName, arguments: args && typeof args === "object" ? args : {}, signal: signal || null }, gate);
    }
    if (clientFor) {
      const client = clientFor(serverId);
      if (!client || typeof client.callTool !== "function") {
        return { ok: false, error: MCP_AGENT_ERROR.MCP_TOOL_INVOCATION_NOT_ENABLED, detail: "clientFor 未返回可调用客户端" };
      }
      return await client.callTool({ name: toolName, arguments: args && typeof args === "object" ? args : {} }, authorization);
    }
    return {
      ok: false,
      error: MCP_AGENT_ERROR.MCP_TOOL_INVOCATION_NOT_ENABLED,
      detail: "未注入 transport / clientFor：本仓不伪造 tools/call 传输",
    };
  }

  async function reconnect(serverId) {
    const rows = await listServers();
    const server = rows ? rows.find((s) => String(s.id) === String(serverId)) : null;
    if (!server) return { ok: false, error: MCP_AGENT_ERROR.MCP_SERVER_NOT_FOUND, serverId: String(serverId) };
    if (server.enabled === false) return { ok: false, error: MCP_AGENT_ERROR.MCP_SERVER_NOT_CONNECTED, serverId: String(serverId), detail: "MCP 服务器未启用" };
    if (!serversPort || typeof serversPort.disconnect !== "function" || typeof serversPort.connect !== "function") {
      return { ok: false, error: MCP_AGENT_ERROR.MCP_SERVER_NOT_CONNECTED, serverId: String(serverId), detail: "端口未提供 disconnect/connect，无法重连" };
    }
    await serversPort.disconnect(String(serverId));
    await serversPort.connect(server);
    return { ok: true };
  }

  /** callByName / callDirect 的共同后半段：审批 → 传输 → 断连重试一次。 */
  async function callResolved(ref, args, { context = {}, signal = null, taskId = null, stepId = null, runId = null } = {}) {
    // B4e：开关未打开 → 在审批与传输之前就 fail closed（0 次审批、0 次传输）。
    if (isInvocationEnabled() === false) {
      return { ok: false, error: MCP_AGENT_ERROR.MCP_TOOL_INVOCATION_NOT_ENABLED, detail: "MCP 工具调用开关未开启（<userData>/dxos/mcp.json 的 tools.invocationEnabled）", switchEnabled: false };
    }
    const rows = await listServers();
    if (rows === null) return dependencyUnavailable("servers", "MCP 连接目录端口未注入");
    const server = rows.find((s) => String(s.id) === String(ref.serverId));
    if (!server) return { ok: false, error: MCP_AGENT_ERROR.MCP_SERVER_NOT_FOUND, serverId: String(ref.serverId) };
    if (server.enabled === false) return { ok: false, error: MCP_AGENT_ERROR.MCP_SERVER_NOT_CONNECTED, serverId: String(ref.serverId), detail: "MCP 服务器未启用" };

    const gate = await requestApproval({ server, serverId: String(ref.serverId), toolName: String(ref.toolName), args, context, taskId, stepId, runId });
    if (!gate.ok) return gate; // 未通过审批：0 次远端调用
    // 既有 SideEffectAuthority 已执行（executed=true）：直接回它的结果，不再发第二次 tools/call。
    if (gate.executed === true) return gate.result || { ok: false, error: MCP_AGENT_ERROR.MCP_TOOL_CALL_FAILED, detail: "审批执行端口未回可识别结果" };
    const authorization = authorizationFor(gate);

    let result;
    try {
      result = await invokeRemote({ serverId: String(ref.serverId), toolName: String(ref.toolName), args, signal, authorization });
    } catch (e) {
      if (!isMcpDisconnectedError(e)) return { ok: false, error: MCP_AGENT_ERROR.MCP_TOOL_CALL_FAILED, detail: String((e && e.message) || e) };
      // 源 :869-873：断连时重连并重放一次（只一次，不无限重试）
      const rc = await reconnect(ref.serverId);
      if (!rc.ok) return rc;
      try {
        result = await invokeRemote({ serverId: String(ref.serverId), toolName: String(ref.toolName), args, signal, authorization });
      } catch (e2) {
        return { ok: false, error: MCP_AGENT_ERROR.MCP_TOOL_CALL_FAILED, detail: String((e2 && e2.message) || e2) };
      }
    }
    if (logger && typeof logger.log === "function") {
      logger.log({ event: "mcp.agent.call", serverId: String(ref.serverId), tool: String(ref.toolName), at: clock() });
    }
    return normalizeCallResult(result);
  }

  /** 源 :862-881。 */
  async function callByName(fname, args, { context = {}, signal = null, taskId = null, stepId = null, runId = null } = {}) {
    const key = String(fname || "");
    if (!index.has(key)) await agentTools(); // 确保索引已建
    const ref = index.get(key);
    if (!ref) return { ok: false, error: MCP_AGENT_ERROR.UNKNOWN_MCP_TOOL, detail: key };
    return await callResolved(ref, args, { context, signal, taskId, stepId, runId });
  }

  /** 源 :883-991（去掉领星网关分支，见文件头）。 */
  async function callDirect(serverId, toolName, args, { context = {}, signal = null, taskId = null, stepId = null, runId = null } = {}) {
    const rows = await listServers();
    if (rows === null) return dependencyUnavailable("servers", "MCP 连接目录端口未注入");
    const id = String(serverId || "");
    const server = rows.find((s) => String(s.id) === id);
    if (!server) return { ok: false, error: MCP_AGENT_ERROR.MCP_SERVER_NOT_FOUND, serverId: id };
    if (!toolName) return { ok: false, error: ERROR_CODE.MCP_INVALID_INPUT, detail: "缺少 toolName" };
    return await callResolved({ serverId: id, toolName: String(toolName), serverName: server.name || null }, args, { context, signal, taskId, stepId, runId });
  }

  // ── 配置/运行时（源 :801-818 / :993-1007 / :1108-1129）───────────────────
  /** 源 :801-807。 */
  async function refreshServer(id) {
    const rows = await listServers();
    if (rows === null) return dependencyUnavailable("servers", "MCP 连接目录端口未注入");
    const server = rows.find((s) => String(s.id) === String(id));
    if (!server) return { ok: false, error: MCP_AGENT_ERROR.MCP_SERVER_NOT_FOUND, serverId: String(id) };
    if (serversPort && typeof serversPort.refresh === "function") {
      const rt = await serversPort.refresh(String(id));
      return { ok: true, serverId: String(id), runtime: { status: (rt && rt.status) || null, error: (rt && rt.error) || null } };
    }
    if (typeof serversPort.disconnect !== "function" || typeof serversPort.connect !== "function") {
      return dependencyUnavailable("servers.refresh", "端口未提供 refresh（或 disconnect/connect）");
    }
    await serversPort.disconnect(String(id));
    if (server.enabled !== false) await serversPort.connect(server);
    return { ok: true, serverId: String(id), runtime: { status: server.enabled === false ? "DISABLED" : "CONNECTING", error: null } };
  }

  /** 源 :809-818。只翻转启用开关，不动其它字段。 */
  async function setServerEnabled(id, enabled) {
    const rows = await listServers();
    if (rows === null) return dependencyUnavailable("servers", "MCP 连接目录端口未注入");
    const server = rows.find((s) => String(s.id) === String(id));
    if (!server) return { ok: false, error: MCP_AGENT_ERROR.MCP_SERVER_NOT_FOUND, serverId: String(id) };
    const on = enabled === true;
    const next = { ...server, enabled: on };
    if (typeof serversPort.save !== "function") return dependencyUnavailable("servers.save", "端口未提供 save，无法持久化启用状态");
    await serversPort.save(next);
    if (typeof serversPort.disconnect === "function") await serversPort.disconnect(String(id));
    if (on && typeof serversPort.connect === "function") await serversPort.connect(next);
    return { ok: true, serverId: String(id), enabled: on };
  }

  /** 源 :993-1001。启动时 best-effort 连接全部已启用服务器。 */
  async function initMcp() {
    const rows = await listServers();
    if (rows === null) return dependencyUnavailable("servers", "MCP 连接目录端口未注入");
    if (typeof serversPort.save === "function") for (const cfg of rows) await serversPort.save(cfg);
    else return dependencyUnavailable("servers.save", "端口未提供 save，无法补齐系统连接");
    let connected = 0;
    const failures = [];
    for (const cfg of rows) {
      if (cfg.enabled === false || typeof serversPort.connect !== "function") continue;
      try { await serversPort.connect(cfg); connected += 1; } catch (e) { failures.push({ serverId: String(cfg.id), detail: String((e && e.message) || e) }); }
    }
    return { ok: failures.length === 0, count: rows.length, connected, failures };
  }

  /** 源 :1003-1007。只重写存储，不启动任何 MCP 进程。 */
  async function migrateMcpStorage() {
    const rows = await listServers();
    if (rows === null) return dependencyUnavailable("servers", "MCP 连接目录端口未注入");
    if (typeof serversPort.save !== "function") return dependencyUnavailable("servers.save", "端口未提供 save，无法迁移存储");
    for (const cfg of rows) await serversPort.save(cfg);
    return { ok: true, count: rows.length };
  }

  /** 源 :1108-1129。同名视为更新，避免重复导入。 */
  async function importServers(text) {
    let parsed;
    try {
      parsed = parseImport(text);
    } catch (e) {
      return { ok: false, error: MCP_AGENT_ERROR.MCP_IMPORT_INVALID, detail: String((e && e.message) || e) };
    }
    const rows = await listServers();
    if (rows === null) return dependencyUnavailable("servers", "MCP 连接目录端口未注入");
    if (typeof serversPort.save !== "function") return dependencyUnavailable("servers.save", "端口未提供 save，无法导入");
    const saved = [];
    for (const p of parsed) {
      const prev = rows.find((x) => x.name === p.name);
      const cfg = await serversPort.save({
        id: prev ? prev.id : undefined,
        name: p.name,
        transport: p.transport,
        command: p.command,
        args: p.args,
        env: p.env,
        cwd: p.cwd,
        url: p.url,
        headers: p.headers,
        enabled: true,
      });
      saved.push(cfg);
    }
    return { ok: true, saved, count: saved.length };
  }

  return {
    agentTools,
    agentToolsForServer,
    searchAgentTools,
    callByName,
    callDirect,
    refreshServer,
    setServerEnabled,
    initMcp,
    migrateMcpStorage,
    importServers,
    listServers,
    isSystemServer: (id) => isSystem(id),
    /** 只读快照：便于调用方（与测试）核对索引与列表一致，不暴露内部 Map。 */
    toolIndexSnapshot: () => Object.fromEntries([...index.entries()].map(([k, v]) => [k, { ...v }])),
    /** B4e：开关是否允许发起工具调用；未注入 switch 端口返回 null（未接线，不冒充已开启）。 */
    toolInvocationEnabled: () => isInvocationEnabled(),
    /** 源 mcp.ts:372-434（B7 未落地）：签名 + 结构化不可用，实例上也挂一份。 */
    assertAppManagedMcpAvailable,
    syncAppManagedMcpServers,
    removeAppManagedMcpServers,
    buildLingxingGatewayActionArgs,
    parseLingxingGatewayTool,
  };
}

module.exports = {
  createMcpAgentTools,
  parseImport,
  isMcpDisconnectedError,
  isSystemServer,
  systemServerIdsOf,
  isSearchTool,
  safeName,
  sanitizeJsonSchema,
  normalizeSchemaType,
  isConnectedStatus,
  normalizeCallResult,
  createControlledToolProxyApprovalPort,
  createSideEffectApprovalPort,
  createTaskApprovalPort,
  createSideEffectExecutionPort,
  assertAppManagedMcpAvailable,
  syncAppManagedMcpServers,
  removeAppManagedMcpServers,
  buildLingxingGatewayActionArgs,
  parseLingxingGatewayTool,
  dependencyUnavailable,
  MCP_AGENT_ERROR,
  DECISION_STATUS,
  AGENT_DEPENDENCY_UNAVAILABLE,
  SEARCH_TOOL_RE,
};
