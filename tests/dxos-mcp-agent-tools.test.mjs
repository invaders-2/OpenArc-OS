/**
 * B4d · MCP 工具聚合 + 调用审批链 离线测试。
 *
 * 全程离线：只用假 client / 假审批端口 / 假连接目录端口，不 spawn 进程、不联网、不 npm install。
 * 被测算的是产品装配点 createMcpAgentTools（electron/mcp-agent-tools.cjs），
 * 不是测试自造的复制品。
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mod = require("../electron/mcp-agent-tools.cjs");
const {
  createMcpAgentTools,
  parseImport,
  isMcpDisconnectedError,
  isSystemServer,
  systemServerIdsOf,
  createControlledToolProxyApprovalPort,
  createSideEffectApprovalPort,
  MCP_AGENT_ERROR,
  DECISION_STATUS,
  AGENT_DEPENDENCY_UNAVAILABLE,
} = mod;

// ── 夹具 ──────────────────────────────────────────────────────────────
/** 连接目录/配置端口：内存实现，记录 save/connect/disconnect/refresh 调用。 */
function makeServers(initial = []) {
  const state = new Map();
  for (const s of initial) state.set(s.id, { status: "connected", tools: [], enabled: true, ...s });
  const calls = { save: [], connect: [], disconnect: [], refresh: [] };
  return {
    state,
    calls,
    list() {
      return [...state.values()].map((s) => ({ ...s, tools: (s.tools || []).map((t) => ({ ...t })) }));
    },
    save(cfg) {
      const id = cfg.id || "srv-" + (state.size + 1);
      const prev = state.get(id) || {};
      const next = { status: "DISABLED", tools: [], ...prev, ...cfg, id };
      state.set(id, next);
      calls.save.push(next);
      return next;
    },
    connect(cfg) {
      calls.connect.push(cfg.id);
      const cur = state.get(cfg.id);
      if (cur) cur.status = "connected";
      return cur || null;
    },
    disconnect(id) {
      calls.disconnect.push(id);
      const cur = state.get(id);
      if (cur) cur.status = "DISABLED";
    },
    setStatus(id, status) { state.get(id).status = status; },
    refresh(id) { calls.refresh.push(id); const cur = state.get(id); if (cur) cur.status = "connected"; return cur || null; },
  };
}

/** 假 tools/call 传输：记录请求；handler 可返回结果或抛错。 */
function makeTransport(handler) {
  const calls = [];
  return {
    calls,
    async callTool(req) { calls.push(req); return handler(req, calls.length); },
  };
}

/** 假审批端口：固定裁决 + 记录入参 + 可选延迟/抛错。 */
function makeGate(decision, { throws = null } = {}) {
  const calls = [];
  return {
    calls,
    async authorize(req) {
      calls.push(req);
      if (throws) throw throws;
      return typeof decision === "function" ? decision(req, calls.length) : decision;
    },
  };
}

const TEXT_OK = (text) => ({ content: [{ type: "text", text }] });

function tool(name, description = "", inputSchema = { type: "object", properties: {} }) {
  return { name, description, inputSchema };
}

/** 两个连通 server（一个可搜索工具）+ 一个停用 + 一个未连接。 */
function twoServers() {
  return makeServers([
    { id: "alpha", name: "Alpha", enabled: true, status: "connected", tools: [tool("echo_sum", "求和"), tool("web_search", "联网搜索")] },
    { id: "beta", name: "Beta", enabled: true, status: "connected", tools: [tool("read_file", "读取文件")] },
    { id: "gamma", name: "Gamma", enabled: false, status: "connected", tools: [tool("ghost", "停用服务器")] },
    { id: "delta", name: "Delta", enabled: true, status: "ERROR", tools: [tool("broken", "未连接服务器")] },
  ]);
}

const APPROVE = { decisionStatus: DECISION_STATUS.ALLOWED, reasonCode: "ALLOW" };

// ── ① 工具聚合：多 server 去重 / 命名空间 ────────────────────────────────
describe("工具聚合", () => {
  it("只聚合 enabled 且 connected 的 server，并按 mcp__<server>__<tool> 命名空间", async () => {
    const api = createMcpAgentTools({ servers: twoServers() });
    const res = await api.agentTools();
    assert.equal(res.ok, true);
    const names = res.tools.map((t) => t.function.name);
    assert.deepEqual(names, ["mcp__alpha__echo_sum", "mcp__alpha__web_search", "mcp__beta__read_file"]);
    // 停用 / 未连接的 server 一个都不出现
    assert.equal(names.some((n) => n.includes("gamma") || n.includes("ghost")), false);
    assert.equal(names.some((n) => n.includes("delta") || n.includes("broken")), false);
    // function 定义形状与源一致
    const first = res.tools[0];
    assert.equal(first.type, "function");
    assert.equal(first.function.description, "[MCP:Alpha] 求和");
    assert.equal(first.function.parameters.type, "object");
  });

  it("生成名非法字符转下划线，索引与返回列表严格一致", async () => {
    const servers = makeServers([
      { id: "fs server", name: "文件服务", enabled: true, status: "connected", tools: [tool("read.file")] },
    ]);
    const api = createMcpAgentTools({ servers });
    const res = await api.agentTools();
    assert.deepEqual(res.tools.map((t) => t.function.name), ["mcp__fs_server__read_file"]);
    assert.deepEqual(api.toolIndexSnapshot(), { mcp__fs_server__read_file: { serverId: "fs server", serverName: "文件服务", toolName: "read.file" } });
  });

  it("同一生成名去重（首个胜），不产生重复 function 定义", async () => {
    const servers = makeServers([
      { id: "a b", name: "A", enabled: true, status: "connected", tools: [tool("t", "第一个")] },
      { id: "a_b", name: "B", enabled: true, status: "connected", tools: [tool("t", "第二个")] },
      { id: "same", name: "S", enabled: true, status: "connected", tools: [tool("t", "x"), tool("t", "重复同 server")] },
    ]);
    const api = createMcpAgentTools({ servers });
    const res = await api.agentTools();
    const names = res.tools.map((t) => t.function.name);
    assert.equal(names.filter((n) => n === "mcp__a_b__t").length, 1);
    assert.equal(names.filter((n) => n === "mcp__same__t").length, 1);
    assert.equal(names.length, 2);
    const index = api.toolIndexSnapshot();
    assert.deepEqual(Object.keys(index).sort(), ["mcp__a_b__t", "mcp__same__t"]);
    assert.equal(index["mcp__a_b__t"].serverName, "A");
  });

  it("agentToolsForServer 只给指定 server 的工具", async () => {
    const api = createMcpAgentTools({ servers: twoServers() });
    const res = await api.agentToolsForServer("beta");
    assert.deepEqual(res.tools.map((t) => t.function.name), ["mcp__beta__read_file"]);
  });

  it("searchAgentTools 只给搜索/浏览类工具", async () => {
    const api = createMcpAgentTools({ servers: twoServers() });
    const res = await api.searchAgentTools();
    assert.deepEqual(res.tools.map((t) => t.function.name), ["mcp__alpha__web_search"]);
  });

  it("连接目录端口未注入 → 结构化 AGENT_DEPENDENCY_UNAVAILABLE，不假装空成功", async () => {
    const api = createMcpAgentTools({});
    const res = await api.agentTools();
    assert.equal(res.ok, false);
    assert.equal(res.error, AGENT_DEPENDENCY_UNAVAILABLE);
    assert.equal(res.dependency, "servers");
    assert.deepEqual(res.tools, []);
  });
});

// ── ② 按名 / 按 server 调用（审批通过路径）──────────────────────────────
describe("按名与按 server 调用", () => {
  it("callByName：审批先于传输，调用底层真实工具名并回文本", async () => {
    const servers = twoServers();
    const order = [];
    const transport = makeTransport(async (req) => { order.push("transport"); return TEXT_OK(JSON.stringify(req.arguments)); });
    const gate = { async authorize(req) { order.push("approve"); return APPROVE; } };
    const api = createMcpAgentTools({ servers, transport, approval: gate });

    const res = await api.callByName("mcp__alpha__echo_sum", { a: 1, b: 2 });
    assert.equal(res.ok, true);
    assert.equal(res.text, JSON.stringify({ a: 1, b: 2 }));
    assert.deepEqual(order, ["approve", "transport"]);
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].toolName, "echo_sum");
    assert.equal(transport.calls[0].serverId, "alpha");
  });

  it("callDirect：按 serverId + 工具名直调", async () => {
    const servers = twoServers();
    const transport = makeTransport(async () => TEXT_OK("pong"));
    const api = createMcpAgentTools({ servers, transport, approval: makeGate(APPROVE) });
    const res = await api.callDirect("beta", "read_file", { path: "x" });
    assert.equal(res.ok, true);
    assert.equal(res.text, "pong");
    assert.deepEqual(transport.calls[0], { serverId: "beta", toolName: "read_file", arguments: { path: "x" }, signal: null });
  });

  it("未知名 → UNKNOWN_MCP_TOOL，0 次传输", async () => {
    const transport = makeTransport(async () => TEXT_OK("never"));
    const api = createMcpAgentTools({ servers: twoServers(), transport, approval: makeGate(APPROVE) });
    const res = await api.callByName("mcp__nope__nope", {});
    assert.equal(res.ok, false);
    assert.equal(res.error, MCP_AGENT_ERROR.UNKNOWN_MCP_TOOL);
    assert.equal(transport.calls.length, 0);
  });

  it("未知 server / 停用 server → 结构化错误，0 次传输", async () => {
    const transport = makeTransport(async () => TEXT_OK("never"));
    const api = createMcpAgentTools({ servers: twoServers(), transport, approval: makeGate(APPROVE) });
    const missing = await api.callDirect("nope", "t", {});
    assert.equal(missing.error, MCP_AGENT_ERROR.MCP_SERVER_NOT_FOUND);
    const disabled = await api.callDirect("gamma", "ghost", {});
    assert.equal(disabled.error, MCP_AGENT_ERROR.MCP_SERVER_NOT_CONNECTED);
    assert.equal(transport.calls.length, 0);
  });

  it("服务端 isError → MCP_TOOL_CALL_FAILED（不把错误当成功文本）", async () => {
    const transport = makeTransport(async () => ({ content: [{ type: "text", text: "boom" }], isError: true }));
    const api = createMcpAgentTools({ servers: twoServers(), transport, approval: makeGate(APPROVE) });
    const res = await api.callDirect("alpha", "echo_sum", {});
    assert.equal(res.ok, false);
    assert.equal(res.error, MCP_AGENT_ERROR.MCP_TOOL_CALL_FAILED);
    assert.equal(res.text, "boom");
  });

  it("未注入传输 → MCP_TOOL_INVOCATION_NOT_ENABLED（本仓 mcp-client 未实现 tools/call）", async () => {
    const gate = makeGate(APPROVE);
    const api = createMcpAgentTools({ servers: twoServers(), approval: gate });
    const res = await api.callDirect("alpha", "echo_sum", {});
    assert.equal(res.ok, false);
    assert.equal(res.error, MCP_AGENT_ERROR.MCP_TOOL_INVOCATION_NOT_ENABLED);
    assert.equal(gate.calls.length, 1); // 审批确实先跑了，只是没有传输
  });
});

// ── ③ 断连识别与一次重连 ────────────────────────────────────────────────
describe("断连错误识别", () => {
  it("isMcpDisconnectedError 真值表与源一致", () => {
    assert.equal(isMcpDisconnectedError(new Error("Transport is not connected")), true);
    assert.equal(isMcpDisconnectedError(new Error("MCP error -32000: Connection closed")), true);
    assert.equal(isMcpDisconnectedError(new Error("Connection is closed")), true);
    assert.equal(isMcpDisconnectedError("client not connected"), true);
    assert.equal(isMcpDisconnectedError(new Error("connection not established")), true);
    assert.equal(isMcpDisconnectedError(new Error("Invalid params")), false);
    assert.equal(isMcpDisconnectedError(new Error("tool execution failed")), false);
    assert.equal(isMcpDisconnectedError(null), false);
  });

  it("callByName 遇断连：重连一次并重放；第二次成功", async () => {
    const servers = twoServers();
    const transport = makeTransport(async (_req, n) => {
      if (n === 1) throw new Error("Transport is not connected");
      return TEXT_OK("recovered");
    });
    const api = createMcpAgentTools({ servers, transport, approval: makeGate(APPROVE) });
    const res = await api.callByName("mcp__beta__read_file", {});
    assert.equal(res.ok, true);
    assert.equal(res.text, "recovered");
    assert.equal(transport.calls.length, 2);
    assert.deepEqual(servers.calls.disconnect, ["beta"]);
    assert.deepEqual(servers.calls.connect, ["beta"]);
  });

  it("callByName 遇非断连错误：只调一次，不重连", async () => {
    const servers = twoServers();
    const transport = makeTransport(async () => { throw new Error("Invalid params"); });
    const api = createMcpAgentTools({ servers, transport, approval: makeGate(APPROVE) });
    const res = await api.callByName("mcp__beta__read_file", {});
    assert.equal(res.ok, false);
    assert.equal(res.error, MCP_AGENT_ERROR.MCP_TOOL_CALL_FAILED);
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(servers.calls.disconnect, []);
  });
});

// ── ④ 审批链三条路径（本批关键要求）─────────────────────────────────────
describe("调用审批链", () => {
  let transport;
  let servers;
  beforeEach(() => {
    servers = twoServers();
    transport = makeTransport(async () => TEXT_OK("should-not-run"));
  });

  it("路径一（未审批）：APPROVAL_REQUIRED，绝不调远端", async () => {
    const gate = makeGate({ decisionStatus: DECISION_STATUS.APPROVAL_REQUIRED, reasonCode: "TOOL_APPROVAL_REQUIRED", approvalRequestId: "call_1" });
    const api = createMcpAgentTools({ servers, transport, approval: gate });
    const res = await api.callByName("mcp__alpha__echo_sum", { a: 1 });
    assert.equal(res.ok, false);
    assert.equal(res.error, "APPROVAL_REQUIRED");
    assert.equal(res.decisionStatus, DECISION_STATUS.APPROVAL_REQUIRED);
    assert.equal(res.approvalRequestId, "call_1");
    assert.equal(res.reasonCode, "TOOL_APPROVAL_REQUIRED");
    assert.equal(transport.calls.length, 0);
    assert.equal(gate.calls.length, 1);
    assert.equal(gate.calls[0].toolName, "echo_sum");
    assert.equal(gate.calls[0].serverId, "alpha");
  });

  it("路径二（审批通过）：执行并回结果", async () => {
    const gate = makeGate(APPROVE);
    const api = createMcpAgentTools({ servers, transport, approval: gate });
    const res = await api.callByName("mcp__alpha__echo_sum", { a: 1 });
    assert.equal(res.ok, true);
    assert.equal(res.text, "should-not-run");
    assert.equal(transport.calls.length, 1);
    // 审批入参必须带上真实请求，审批方才能判断
    assert.deepEqual(gate.calls[0].arguments, { a: 1 });
  });

  it("路径三（审批拒绝）：APPROVAL_DENIED，绝不调远端", async () => {
    const gate = makeGate({ decisionStatus: DECISION_STATUS.DENIED, reasonCode: "TOOL_FORBIDDEN" });
    const api = createMcpAgentTools({ servers, transport, approval: gate });
    const res = await api.callByName("mcp__alpha__echo_sum", {});
    assert.equal(res.ok, false);
    assert.equal(res.error, "APPROVAL_DENIED");
    assert.equal(res.decisionStatus, DECISION_STATUS.DENIED);
    assert.equal(res.reasonCode, "TOOL_FORBIDDEN");
    assert.equal(transport.calls.length, 0);
  });

  it("INVALID / BLOCKED 裁决同样收敛为 APPROVAL_DENIED", async () => {
    for (const status of [DECISION_STATUS.INVALID, DECISION_STATUS.BLOCKED]) {
      const t = makeTransport(async () => TEXT_OK("never"));
      const api = createMcpAgentTools({ servers, transport: t, approval: makeGate({ decisionStatus: status }) });
      const res = await api.callByName("mcp__alpha__echo_sum", {});
      assert.equal(res.error, "APPROVAL_DENIED", status);
      assert.equal(t.calls.length, 0);
    }
  });

  it("审批端口未注入 → AGENT_DEPENDENCY_UNAVAILABLE（fail closed，0 次远端）", async () => {
    const api = createMcpAgentTools({ servers, transport });
    const res = await api.callByName("mcp__alpha__echo_sum", {});
    assert.equal(res.ok, false);
    assert.equal(res.error, AGENT_DEPENDENCY_UNAVAILABLE);
    assert.equal(res.dependency, "mcpApproval");
    assert.equal(transport.calls.length, 0);
  });

  it("审批端口抛错 / 返回未知裁决 → MCP_APPROVAL_FAILED，0 次远端", async () => {
    const throwing = createMcpAgentTools({ servers, transport, approval: makeGate(null, { throws: new Error("db down") }) });
    const r1 = await throwing.callByName("mcp__alpha__echo_sum", {});
    assert.equal(r1.error, MCP_AGENT_ERROR.MCP_APPROVAL_FAILED);

    const t2 = makeTransport(async () => TEXT_OK("never"));
    const unknown = createMcpAgentTools({ servers, transport: t2, approval: makeGate({ decisionStatus: "SOMETHING_ELSE" }) });
    const r2 = await unknown.callByName("mcp__alpha__echo_sum", {});
    assert.equal(r2.error, MCP_AGENT_ERROR.MCP_APPROVAL_FAILED);
    assert.equal(t2.calls.length, 0);
    assert.equal(transport.calls.length, 0);
  });
});

// ── ⑤ import / parse：合法与非法输入 ─────────────────────────────────────
describe("parseImport / importServers", () => {
  it("纯 URL → http 单条，名称从路径猜", () => {
    const out = parseImport("https://mcp.example.com/mcp");
    assert.equal(out.length, 1);
    assert.equal(out[0].transport, "http");
    assert.equal(out[0].url, "https://mcp.example.com/mcp");
    assert.equal(out[0].name, "mcp");
  });

  it("命令行一行 → stdio，name 去掉 @latest", () => {
    const out = parseImport("npx -y @scope/some-mcp@latest");
    assert.deepEqual(out, [{ name: "some-mcp", transport: "stdio", command: "npx", args: ["-y", "@scope/some-mcp@latest"] }]);
  });

  it("Claude/Cursor 的 mcpServers 字典 → stdio + http 混合", () => {
    const text = JSON.stringify({
      mcpServers: {
        files: { command: "npx", args: ["-y", "fs-mcp"], env: { TOKEN: "x" }, cwd: "/tmp" },
        remote: { url: "https://a.example/mcp", headers: { Authorization: "Bearer y" } },
      },
    });
    const out = parseImport(text);
    assert.deepEqual(out[0], { name: "files", transport: "stdio", command: "npx", args: ["-y", "fs-mcp"], env: { TOKEN: "x" }, cwd: "/tmp" });
    assert.deepEqual(out[1], { name: "remote", transport: "http", url: "https://a.example/mcp", headers: { Authorization: "Bearer y" } });
  });

  it("VS Code 的 servers / mcp.servers 两种包装都认", () => {
    assert.equal(parseImport(JSON.stringify({ servers: { a: { command: "node", args: ["s.js"] } } }))[0].name, "a");
    assert.equal(parseImport(JSON.stringify({ mcp: { servers: { b: { command: "uvx", args: ["mcp"] } } } }))[0].name, "b");
  });

  it("serverKey 声明（平铺 / endpoint）解析为本地 stdio 白名单引用，只留 key", () => {
    assert.deepEqual(parseImport(JSON.stringify({ mcpServers: { echo: { serverKey: "openarc-test-echo" } } })), [
      { name: "echo", transport: "stdio", serverKey: "openarc-test-echo" },
    ]);
    assert.deepEqual(parseImport(JSON.stringify({ servers: { e2: { endpoint: { serverKey: "openarc-test-echo" } } } })), [
      { name: "e2", transport: "stdio", serverKey: "openarc-test-echo" },
    ]);
    // 单对象：名从 serverKey 猜；即使一起带 command，也不产出可执行字段。
    assert.deepEqual(parseImport(JSON.stringify({ serverKey: "openarc-test-echo", command: "/bin/sh", args: ["-c", "id"] })), [
      { name: "openarc-test-echo", transport: "stdio", serverKey: "openarc-test-echo" },
    ]);
  });

  it("单个 {command,args} 对象与尾逗号容错", () => {
    const out = parseImport('{ "command": "python", "args": ["-m", "srv"], }');
    assert.equal(out.length, 1);
    assert.equal(out[0].command, "python");
    // 源 guessName：args 里没有 '/' 或 'mcp' 时 src 取 command 本身
    assert.equal(out[0].name, "python");
  });

  it("非法输入一律抛 MCP_IMPORT_INVALID（消息与源一致）", () => {
    const cases = [["", "内容为空"], ["{bad json", "JSON 解析失败，请检查格式"], ["[]", "没有找到可导入的服务器"], ['{ "name": "x" }', "没有找到可导入的服务器"]];
    for (const [text, message] of cases) {
      let caught = null;
      try { parseImport(text); } catch (e) { caught = e; }
      assert.ok(caught, "应抛错: " + JSON.stringify(text));
      assert.equal(caught.code, MCP_AGENT_ERROR.MCP_IMPORT_INVALID);
      assert.match(caught.message, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("importServers 合法输入：同名视为更新（复用既有 id）", async () => {
    const servers = makeServers([{ id: "existing", name: "files", enabled: true, status: "DISABLED", tools: [] }]);
    const api = createMcpAgentTools({ servers });
    const text = JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "fs-mcp"] }, other: { url: "https://x.example/mcp" } } });
    const res = await api.importServers(text);
    assert.equal(res.ok, true);
    assert.equal(res.count, 2);
    assert.equal(res.saved[0].id, "existing");
    assert.equal(res.saved[1].id, "srv-2"); // 假端口按 state.size+1 生成
    assert.equal(servers.calls.save.length, 2);
    assert.equal(servers.calls.save[0].enabled, true);
  });

  it("importServers 非法输入 → 结构化 MCP_IMPORT_INVALID，不落盘", async () => {
    const servers = makeServers([]);
    const api = createMcpAgentTools({ servers });
    const res = await api.importServers("{不是 JSON");
    assert.equal(res.ok, false);
    assert.equal(res.error, MCP_AGENT_ERROR.MCP_IMPORT_INVALID);
    assert.match(res.detail, /JSON 解析失败/);
    assert.equal(servers.calls.save.length, 0);
  });

  it("importServers 未注入配置端口 → AGENT_DEPENDENCY_UNAVAILABLE", async () => {
    const api = createMcpAgentTools({});
    const res = await api.importServers("https://x.example/mcp");
    assert.equal(res.error, AGENT_DEPENDENCY_UNAVAILABLE);
  });
});

// ── ⑥ 系统 server 保护 ────────────────────────────────────────────────────
describe("系统 server 保护", () => {
  it("isSystemServer 支持 Set / 数组白名单（源 SYSTEM_IDS 口径）", () => {
    assert.equal(isSystemServer("lingxing", new Set(["lingxing", "ziniao"])), true);
    assert.equal(isSystemServer("ziniao", ["lingxing", "ziniao"]), true);
    assert.equal(isSystemServer("mine", new Set(["lingxing"])), false);
    assert.equal(isSystemServer("lingxing", null), false);
  });

  it("systemServerIdsOf 从 builtin / managedBy 推导（源 builtin:true 语义）", () => {
    const ids = systemServerIdsOf([
      { id: "lingxing", builtin: true },
      { id: "video-clip", managedBy: "video-editor" },
      { id: "mine" },
      null,
    ]);
    assert.deepEqual([...ids].sort(), ["lingxing", "video-clip"]);
  });

  it("API isSystemServer 使用注入的白名单", () => {
    const api = createMcpAgentTools({ servers: twoServers(), systemServerIds: ["alpha"] });
    assert.equal(api.isSystemServer("alpha"), true);
    assert.equal(api.isSystemServer("beta"), false);
  });

  it("未显式给白名单时，从连接记录的 builtin 标记推导", async () => {
    const servers = makeServers([{ id: "sys", name: "系统", builtin: true, enabled: true, status: "connected", tools: [] }]);
    const api = createMcpAgentTools({ servers });
    await api.listServers();
    assert.equal(api.isSystemServer("sys"), true);
    assert.equal(api.isSystemServer("other"), false);
  });
});

// ── ⑦ 配置 / 运行时（源 :801-818 / :993-1007）─────────────────────────────
describe("配置与运行时", () => {
  it("refreshServer 走端口 refresh", async () => {
    const servers = twoServers();
    const api = createMcpAgentTools({ servers });
    const res = await api.refreshServer("beta");
    assert.equal(res.ok, true);
    assert.equal(res.runtime.status, "connected");
    assert.deepEqual(servers.calls.refresh, ["beta"]);
  });

  it("refreshServer 无 refresh 时退化为 disconnect + connect", async () => {
    const servers = twoServers();
    delete servers.refresh;
    const api = createMcpAgentTools({ servers });
    const res = await api.refreshServer("beta");
    assert.equal(res.ok, true);
    assert.deepEqual(servers.calls.disconnect, ["beta"]);
    assert.deepEqual(servers.calls.connect, ["beta"]);
  });

  it("refreshServer 未知 server → MCP_SERVER_NOT_FOUND", async () => {
    const api = createMcpAgentTools({ servers: twoServers() });
    const res = await api.refreshServer("nope");
    assert.equal(res.error, MCP_AGENT_ERROR.MCP_SERVER_NOT_FOUND);
  });

  it("setServerEnabled 持久化并断开/连接", async () => {
    const servers = twoServers();
    const api = createMcpAgentTools({ servers });
    const off = await api.setServerEnabled("beta", false);
    assert.equal(off.ok, true);
    assert.equal(off.enabled, false);
    assert.equal(servers.calls.save.at(-1).enabled, false);
    assert.equal(servers.calls.disconnect.at(-1), "beta");
    const on = await api.setServerEnabled("beta", true);
    assert.equal(on.enabled, true);
    assert.equal(servers.calls.connect.at(-1), "beta");
  });

  it("setServerEnabled 无 save 端口 → 结构化不可用", async () => {
    const servers = twoServers();
    delete servers.save;
    const api = createMcpAgentTools({ servers });
    const res = await api.setServerEnabled("beta", false);
    assert.equal(res.error, AGENT_DEPENDENCY_UNAVAILABLE);
  });

  it("initMcp 补写配置并连接启用项；migrateMcpStorage 只重写存储", async () => {
    const servers = twoServers();
    const api = createMcpAgentTools({ servers });
    const init = await api.initMcp();
    assert.equal(init.ok, true);
    assert.equal(init.count, 4);
    assert.equal(init.connected, 3); // alpha / beta / delta（disabled 的 gamma 不连）
    const migrated = await api.migrateMcpStorage();
    assert.deepEqual(migrated, { ok: true, count: 4 });
  });

  it("配置端口未注入 → 全部结构化 AGENT_DEPENDENCY_UNAVAILABLE", async () => {
    const api = createMcpAgentTools({});
    for (const res of [await api.refreshServer("x"), await api.setServerEnabled("x", true), await api.initMcp(), await api.migrateMcpStorage()]) {
      assert.equal(res.error, AGENT_DEPENDENCY_UNAVAILABLE);
    }
  });
});

// ── ⑧ 审批链适配器（真实接口接线）────────────────────────────────────────
describe("既有审批链适配器", () => {
  it("createControlledToolProxyApprovalPort 投影 ControlledToolProxy.propose 的裁决", async () => {
    const seen = [];
    const proxy = { propose(req) { seen.push(req); return { ok: true, decisionStatus: DECISION_STATUS.APPROVAL_REQUIRED, reasonCode: "TOOL_APPROVAL_REQUIRED", proposal: { proposalId: "p1" } }; } };
    const port = createControlledToolProxyApprovalPort({ proxy, taskId: "task_1", toolIdFor: (s, t) => `mcp.${s}.${t}`, toolVersionFor: () => 3 });
    const decision = await port.authorize({ context: { sessionRef: "s" }, serverId: "alpha", toolName: "echo_sum", arguments: { a: 1 } });
    assert.equal(decision.decisionStatus, DECISION_STATUS.APPROVAL_REQUIRED);
    assert.equal(decision.proposalId, "p1");
    assert.deepEqual(seen[0], { context: { sessionRef: "s" }, taskId: "task_1", stepId: null, runId: null, toolId: "mcp.alpha.echo_sum", toolVersion: 3, arguments: { a: 1 } });
  });

  it("createControlledToolProxyApprovalPort 缺依赖 → 结构化不可用", async () => {
    assert.equal((await createControlledToolProxyApprovalPort({}).authorize({})).error, AGENT_DEPENDENCY_UNAVAILABLE);
    const noToolId = createControlledToolProxyApprovalPort({ proxy: { propose: () => ({ ok: true }) }, taskId: "t" });
    assert.equal((await noToolId.authorize({ serverId: "a", toolName: "b" })).error, AGENT_DEPENDENCY_UNAVAILABLE);
  });

  it("接入 api 后：APPROVAL_REQUIRED 直接拦下，0 次远端", async () => {
    const transport = makeTransport(async () => TEXT_OK("never"));
    const proxy = { propose: () => ({ ok: true, decisionStatus: DECISION_STATUS.APPROVAL_REQUIRED, reasonCode: "TOOL_APPROVAL_REQUIRED", proposal: { proposalId: "p2" } }) };
    const approval = createControlledToolProxyApprovalPort({ proxy, taskId: "t", toolIdFor: (s, t) => `mcp.${s}.${t}` });
    const api = createMcpAgentTools({ servers: twoServers(), transport, approval });
    const res = await api.callDirect("alpha", "echo_sum", {});
    assert.equal(res.error, "APPROVAL_REQUIRED");
    assert.equal(res.approvalRequestId, "p2");
    assert.equal(transport.calls.length, 0);
  });

  it("createSideEffectApprovalPort 把 proposeWrite 的 approvalRequestId 投影为 APPROVAL_REQUIRED", async () => {
    const runtime = { proposeWrite: () => ({ ok: true, approvalRequestId: "call_9" }) };
    const port = createSideEffectApprovalPort({ runtime, taskId: "t", toolIdFor: (s, t) => `mcp.${s}.${t}` });
    const ok = await port.authorize({ serverId: "alpha", toolName: "echo_sum", arguments: {} });
    assert.equal(ok.decisionStatus, DECISION_STATUS.APPROVAL_REQUIRED);
    assert.equal(ok.approvalRequestId, "call_9");

    const denied = createSideEffectApprovalPort({ runtime: { proposeWrite: () => ({ ok: false, error: "TOOL_DENIED" }) }, taskId: "t", toolIdFor: () => "x" });
    assert.equal((await denied.authorize({})).decisionStatus, DECISION_STATUS.DENIED);
  });
});

// ── ⑨ 依赖宿主能力 / 第三方：只保留签名 + 结构化不可用 ────────────────────
describe("宿主能力依赖占位", () => {
  it("App 托管 MCP（源 :372-434）缺宿主侧注册表 → AGENT_DEPENDENCY_UNAVAILABLE", () => {
    const a = mod.assertAppManagedMcpAvailable("app", []);
    const b = mod.syncAppManagedMcpServers("app", "/root", []);
    const c = mod.removeAppManagedMcpServers("app");
    for (const res of [a, b, c]) {
      assert.equal(res.ok, false);
      assert.equal(res.error, AGENT_DEPENDENCY_UNAVAILABLE);
      assert.equal(res.dependency, "developerApps");
    }
  });

  it("领星网关 helper（源 :155/:200）→ AGENT_DEPENDENCY_UNAVAILABLE", () => {
    const a = mod.buildLingxingGatewayActionArgs({ toolId: "x" }, {}, true);
    const b = mod.parseLingxingGatewayTool("{}", "x");
    for (const res of [a, b]) {
      assert.equal(res.ok, false);
      assert.equal(res.dependency, "lingxingGateway");
    }
    // 实例上也挂了同名占位
    const api = createMcpAgentTools({});
    assert.equal(api.buildLingxingGatewayActionArgs({}, {}, true).error, AGENT_DEPENDENCY_UNAVAILABLE);
    assert.equal(api.syncAppManagedMcpServers("a", "/b", []).dependency, "developerApps");
  });
});

