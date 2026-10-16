/**
 * B4e 收口 · MCP 工具调用**真实链路**离线端到端测试。
 *
 * 证明的不再是"注入假 transport 的测试对象"，而是产品装配点：
 *   · electron/mcp-live-transport.cjs  —— 生产真实传输（McpService 的活连接）
 *   · electron/mcp-client.cjs          —— 显式开关 + 审批凭证双条件门
 *   · electron/mcp-switch.cjs          —— <userData>/dxos/mcp.json 显式开关
 *   · electron/mcp-agent-tools.cjs     —— createTaskApprovalPort（ControlledToolProxy.propose）
 *   · electron/mcp-bootstrap.cjs       —— mcp/toolInvocation/set（开关写命令 + 审计）
 *
 * 本机 loopback MCP 服务由 tests/fixtures/mcp/loopback-tool-server.mjs 提供（只监听 127.0.0.1，自起自停）。
 * 全程离线：唯一的网络出口是 127.0.0.1，且被 guarded fetch 断言（出现任何非 loopback 请求即失败）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { McpStore } = require("../electron/mcp-store.cjs");
const { McpService } = require("../electron/mcp-service.cjs");
const { McpClient } = require("../electron/mcp-client.cjs");
const { CredentialStore, memoryCredentialBackend } = require("../electron/credential-store.cjs");
const { createMcpSwitch } = require("../electron/mcp-switch.cjs");
const { createMcpAgentBridge } = require("../electron/mcp-agent-bridge.cjs");
const { createMcpLiveTransport } = require("../electron/mcp-live-transport.cjs");
const { createTaskApprovalPort } = require("../electron/mcp-agent-tools.cjs");
const { mcpToolIdFor, MCP_TOOL_VERSION } = require("../electron/mcp-tool-contract.cjs");
const { registerMcpIpc, MCP_COMMANDS } = require("../electron/mcp-bootstrap.cjs");
const domain = require("../electron/mcp-domain.cjs");

const SERVER = path.join(import.meta.dirname, "fixtures", "mcp", "loopback-tool-server.mjs");

/** 起一个只在 127.0.0.1 监听的 MCP 工具服务（端口 0 = 系统分配）。 */
function startLoopbackToolServer() {
  const child = spawn(process.execPath, [SERVER, "--http", "--port=0"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += String(d); });
  const ready = new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("loopback-tool-server 未在 5s 内就绪：" + stderr)), 5000);
    child.stdout.on("data", (d) => {
      buffer += String(d);
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      try {
        const info = JSON.parse(buffer.slice(0, index));
        clearTimeout(timer);
        resolve(info);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
  return { child, ready, stop() { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } } };
}

/**
 * 真实装配：ToolHarnessFixture（真实 Task/Proxy/Registry）+ 真实 McpService/McpClient + 显式开关。
 * 唯一网络出口 = 本机 loopback（guardedFetch 断言）。
 */
async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-mcp-live-"));
  const server = startLoopbackToolServer();
  const info = await server.ready;
  const fx = await createToolHarnessFixture();
  const f = fx.f;
  const sw = createMcpSwitch({ userDataDir: path.join(tmp, "userData") });

  const urlsSeen = [];
  const guardedFetch = (url, init) => {
    let parsed;
    try { parsed = new URL(String(url)); } catch { return Promise.reject(new Error("BAD_URL")); }
    urlsSeen.push(parsed.origin);
    if (parsed.hostname !== "127.0.0.1") return Promise.reject(new Error("NON_LOOPBACK_REQUEST:" + parsed.origin));
    return fetch(url, init);
  };

  const mcpStore = new McpStore({ identity: f.identity });
  const credentialStore = new CredentialStore({ store: mcpStore, backend: memoryCredentialBackend() });
  const mcpService = new McpService({
    identity: f.identity,
    authService: f.authService,
    authStore: f.store,
    mcpStore,
    credentialStore,
    clientFactory: () => new McpClient({ invocationGate: () => sw.isToolInvocationEnabled(), fetchImpl: guardedFetch, requestTimeoutMs: 5000 }),
    requestTimeoutMs: 5000,
  });

  // MCP 中心 App baseline（与 mcp-bootstrap.seedMcpAppPolicy / mcp-fixtures 同一口径）。
  f.store.upsertApp({ appId: "mcp-center", name: "MCP 中心", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
  f.store.upsertAppGrant({ appId: "mcp-center", resourceType: "mcp", actions: ["mcp.view", "mcp.use", "mcp.manage", "mcp.test"], grantedBy: "test", organizationId: f.orgId });

  const mcpCtx = { sessionRef: f.sessions.admin, appId: "mcp-center", source: "ui" };
  const created = mcpService.createConnection({ context: mcpCtx, name: "本机回环工具", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: info.url } });
  assert.equal(created.ok, true, JSON.stringify(created));
  const connectionId = created.connection.connectionId;
  assert.equal(mcpService.setEnabled({ context: mcpCtx, connectionId, enabled: true }).ok, true);
  const connected = await mcpService.connect({ context: mcpCtx, connectionId });
  assert.equal(connected.ok, true, JSON.stringify(connected));

  const transport = createMcpLiveTransport({ mcpService, switchPort: sw });
  const task = fx.createTask();
  const taskId = task.task.taskId;
  // 任务上下文：appId 来自真实 Task（"ai"），不是 mcp-center —— ControlledToolProxy 会再校验归属。
  const taskCtx = { sessionRef: f.sessions.admin, appId: task.task.app_id || "ai", source: "ui" };

  const makeApproval = (trustedApproval) => createTaskApprovalPort({ proxy: fx.toolProxy, toolIdFor: mcpToolIdFor, toolVersionFor: () => MCP_TOOL_VERSION, trustedApproval });
  const makeBridge = (approval) => createMcpAgentBridge({ mcpService, context: () => mcpCtx, switch: sw, registry: fx.toolRegistry, transport, approval });

  const serverState = async () => {
    const res = await fetch("http://127.0.0.1:" + info.port + "/__state");
    return res.json();
  };

  return {
    tmp, server, info, fx, f, sw, connectionId, transport, task, taskId, taskCtx, makeApproval, makeBridge, urlsSeen, serverState,
    async close() {
      try { await mcpService.dispose(); } catch { /* ignore */ }
      try { server.stop(); } catch { /* ignore */ }
      try { await fx.close(); } catch { /* ignore */ }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

test("端到端（本机 loopback 真实传输）：开关关 → NOT_ENABLED；开+未审批 → APPROVAL_REQUIRED；审批通过 → 真实 tools/call；拒绝/超时 → 0 传输", async () => {
  const env = await setup();
  try {
    const { sw, taskId, taskCtx, makeApproval, makeBridge, serverState, info } = env;
    const toolId = mcpToolIdFor(env.connectionId, "loop_echo");
    const args = { a: 1, b: 2 };

    // ── ① 开关关：0 审批、0 传输（即使审批端口会放行）───────────────────────
    let approvalCalls = 0;
    const countingApproval = { authorize: async () => { approvalCalls += 1; return { decisionStatus: "ALLOWED" }; } };
    const offBridge = makeBridge(countingApproval);
    const off = await offBridge.mcpAgentTools.callDirect(env.connectionId, "loop_echo", args, { context: taskCtx, taskId });
    assert.equal(off.ok, false);
    assert.equal(off.error, "MCP_TOOL_INVOCATION_NOT_ENABLED");
    assert.equal(approvalCalls, 0, "开关关闭时连审批都不该跑");
    assert.equal((await serverState()).toolsCalls.length, 0, "开关关闭时 0 次 tools/call");

    // ── ② 开关开 + 未审批：ControlledToolProxy.propose 到达（真实 Task/合同）→ APPROVAL_REQUIRED，0 传输 ──
    sw.setToolInvocationEnabled(true);
    assert.equal(sw.isToolInvocationEnabled(), true);
    const pendingBridge = makeBridge(makeApproval(null));
    const pending = await pendingBridge.mcpAgentTools.callDirect(env.connectionId, "loop_echo", args, { context: taskCtx, taskId });
    assert.equal(pending.ok, false, JSON.stringify(pending));
    assert.equal(pending.error, "APPROVAL_REQUIRED");
    assert.ok(pending.approvalRequestId, "必须拿到审批请求号（proposalId）");
    assert.equal((await serverState()).toolsCalls.length, 0, "未审批时 0 次 tools/call");

    // ── ③ 开关开 + 审批通过：真实 tools/call 到达 loopback 服务并取回结果 ─────
    const approvedBridge = makeBridge(makeApproval(async ({ proposalId, taskId: seenTaskId }) => {
      assert.ok(proposalId, "可信审批必须拿到 proposalId");
      assert.equal(seenTaskId, taskId, "可信审批必须拿到真实 taskId");
      return { decision: "APPROVED" };
    }));
    const approved = await approvedBridge.mcpAgentTools.callDirect(env.connectionId, "loop_echo", args, { context: taskCtx, taskId });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.deepEqual(JSON.parse(approved.text), { tool: "loop_echo", arguments: args });
    const stateAfter = await serverState();
    assert.equal(stateAfter.toolsCalls.length, 1, "审批通过后必须恰好 1 次真实 tools/call");
    assert.equal(stateAfter.toolsCalls[0].name, "loop_echo");
    assert.deepEqual(stateAfter.toolsCalls[0].arguments, args);

    // ── ④ 审批拒绝：0 传输 ─────────────────────────────────────────────────
    const deniedBridge = makeBridge(makeApproval(async () => ({ decision: "DENIED", reasonCode: "USER_DENIED" })));
    const denied = await deniedBridge.mcpAgentTools.callDirect(env.connectionId, "loop_echo", { a: 9 }, { context: taskCtx, taskId });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "APPROVAL_DENIED");
    assert.equal((await serverState()).toolsCalls.length, 1, "拒绝后 tools/call 数不增");

    // ── ⑤ 审批超时：0 传输 ─────────────────────────────────────────────────
    const timeoutBridge = makeBridge(makeApproval(async () => ({ decision: "TIMEOUT" })));
    const timedOut = await timeoutBridge.mcpAgentTools.callDirect(env.connectionId, "loop_echo", { a: 9 }, { context: taskCtx, taskId });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.error, "APPROVAL_TIMEOUT");
    assert.equal((await serverState()).toolsCalls.length, 1, "超时后 tools/call 数不增");

    // ── 全程只有 loopback ──────────────────────────────────────────────────
    assert.ok(env.urlsSeen.length > 0, "必须真实发生过 HTTP 请求（initialize / tools/list）");
    for (const origin of env.urlsSeen) assert.equal(origin, "http://127.0.0.1:" + info.port, "出现非 loopback 请求：" + origin);
    assert.equal(toolId, mcpToolIdFor(env.connectionId, "loop_echo"));
    // 端到端证据（粘进报告）：loopback 服务端实际看到的请求与 tools/call 明细。
    console.log("[loopback-evidence] " + JSON.stringify({
      loopbackOrigin: "http://127.0.0.1:" + info.port,
      observedOrigins: [...new Set(env.urlsSeen)],
      serverByMethod: stateAfter.byMethod,
      toolsCalls: stateAfter.toolsCalls,
      taskId,
      controlledProxyToolId: toolId,
    }));
  } finally {
    await env.close();
  }
});

test("mcp-client 双条件门：未注入开关 / 未带审批凭证 → 既有 NOT_ENABLED；注入开关 + ALLOWED 凭证才放行", async () => {
  const closed = new McpClient({});
  assert.deepEqual(closed.callTool({ name: "x" }), { ok: false, error: "MCP_TOOL_INVOCATION_NOT_ENABLED" });

  const gated = new McpClient({ invocationGate: () => true });
  assert.deepEqual(gated.callTool({ name: "x" }), { ok: false, error: "MCP_TOOL_INVOCATION_NOT_ENABLED" });
  assert.deepEqual(gated.callTool({ name: "x" }, { approval: { decision: "DENIED" } }), { ok: false, error: "MCP_TOOL_INVOCATION_NOT_ENABLED" });
  assert.deepEqual(gated.callTool({ name: "x" }, { approval: { decision: "APPROVAL_REQUIRED" } }), { ok: false, error: "MCP_TOOL_INVOCATION_NOT_ENABLED" });

  // 开关抛错 = 关闭（fail closed）
  const throwing = new McpClient({ invocationGate: () => { throw new Error("boom"); } });
  assert.deepEqual(throwing.callTool({ name: "x" }, { approval: { decision: "ALLOWED" } }), { ok: false, error: "MCP_TOOL_INVOCATION_NOT_ENABLED" });

  // 条件都满足：方法会真正走请求路径（未连接 → 传输层错误，而不是伪造成功）
  const open = new McpClient({ invocationGate: () => true });
  const res = await open.callTool({ name: "x" }, { approval: { decision: "ALLOWED" } });
  assert.equal(res.ok, false);
  assert.equal(res.error, "MCP_UNREACHABLE");
});

test("mcp/toolInvocation/set：trusted + mcp.manage + 审计，落 mcp.json；未授权/无审计端口结构化拒绝", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-mcp-switch-ipc-"));
  try {
    const sw = createMcpSwitch({ userDataDir: dir });
    const audits = [];
    const handlers = new Map();
    const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
    let trusted = true;
    let manageOk = true;
    registerMcpIpc({
      ipcMain,
      service: { listConnections: () => ({ ok: true, items: [] }), authorizeManage: () => (manageOk ? { ok: true } : { ok: false, error: "MCP_UNAUTHORIZED", reason: "app-action-missing" }) },
      identity: { current: "s1" },
      isTrusted: () => trusted,
      toolInvocationSwitch: () => sw,
      audit: (entry) => { audits.push(entry); return true; },
      toolInvocationEnabled: () => sw.isToolInvocationEnabled(),
    });
    const invoke = (raw) => handlers.get("mcp:command")({}, raw);
    assert.equal(MCP_COMMANDS.includes("mcp/toolInvocation/set"), true);

    // 未授权：MCP_UNAUTHORIZED，且开关不变
    manageOk = false;
    const denied = await invoke({ command: "mcp/toolInvocation/set", payload: { enabled: true } });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "MCP_UNAUTHORIZED");
    assert.equal(sw.isToolInvocationEnabled(), false);

    // 非白名单/形状不符：结构化 MCP_INVALID_INPUT
    manageOk = true;
    const bad = await invoke({ command: "mcp/toolInvocation/set", payload: { enabled: "yes" } });
    assert.equal(bad.error, "MCP_INVALID_INPUT");

    // 正常写入：落 <userData>/dxos/mcp.json + 写审计
    const ok = await invoke({ command: "mcp/toolInvocation/set", payload: { enabled: true } });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.enabled, true);
    assert.equal(ok.persisted, true);
    assert.equal(sw.isToolInvocationEnabled(), true);
    assert.equal(JSON.parse(fs.readFileSync(sw.filePath, "utf8")).tools.invocationEnabled, true);
    assert.ok(audits.some((a) => a.decision === "REQUEST"));
    assert.ok(audits.some((a) => a.decision === "ALLOW"));

    // trusted 必须：非 trusted 抛 Forbidden
    trusted = false;
    await assert.rejects(() => invoke({ command: "mcp/toolInvocation/set", payload: { enabled: false } }), /Forbidden/);
    assert.equal(sw.isToolInvocationEnabled(), true, "非 trusted 不得改开关");

    // 无审计端口：拒绝写入（不允许无审计的全局能力变更）
    trusted = true;
    registerMcpIpc({
      ipcMain,
      service: { listConnections: () => ({ ok: true, items: [] }), authorizeManage: () => ({ ok: true }) },
      identity: { current: "s1" },
      isTrusted: () => true,
      toolInvocationSwitch: () => sw,
      toolInvocationEnabled: () => sw.isToolInvocationEnabled(),
    });
    const noAudit = await handlers.get("mcp:command")({}, { command: "mcp/toolInvocation/set", payload: { enabled: false } });
    assert.equal(noAudit.error, "MCP_AUDIT_UNAVAILABLE");
    assert.equal(sw.isToolInvocationEnabled(), true);

    // 旧调用命令仍被拒（既有产品边界不放宽）
    const legacy = await handlers.get("mcp:command")({}, { command: "mcp/callTool", payload: {} });
    assert.equal(legacy.error, domain.ERROR_CODE.MCP_TOOL_INVOCATION_NOT_ENABLED);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp/toolInvocation/call：缺 taskId / 任务上下文解析失败 → 结构化拒绝；未注入端口 → 结构化不可用", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
  registerMcpIpc({
    ipcMain,
    service: { listConnections: () => ({ ok: true, items: [] }) },
    identity: { current: "s1" },
    isTrusted: () => true,
  });
  const invoke = (raw) => handlers.get("mcp:command")({}, raw);
  // 未注入 toolInvocation 端口
  const noPort = await invoke({ command: "mcp/toolInvocation/call", payload: { taskId: "t1", serverId: "s", toolName: "t" } });
  assert.equal(noPort.ok, false);
  assert.equal(noPort.error, "MCP_TOOL_DISCOVERY_FAILED");

  registerMcpIpc({
    ipcMain,
    service: { listConnections: () => ({ ok: true, items: [] }) },
    identity: { current: "s1" },
    isTrusted: () => true,
    toolInvocation: () => ({ callByName: async () => ({ ok: false, error: "NEVER" }), callDirect: async () => ({ ok: false, error: "NEVER" }) }),
    resolveTaskContext: ({ taskId }) => (taskId === "t-ok" ? { ok: true, taskId, appId: "ai" } : { ok: false, error: "MCP_UNAUTHORIZED" }),
  });
  const noTask = await handlers.get("mcp:command")({}, { command: "mcp/toolInvocation/call", payload: { serverId: "s", toolName: "t" } });
  assert.equal(noTask.error, "MCP_INVALID_INPUT");
  const badTask = await handlers.get("mcp:command")({}, { command: "mcp/toolInvocation/call", payload: { taskId: "nope", serverId: "s", toolName: "t" } });
  assert.equal(badTask.error, "MCP_UNAUTHORIZED");
});
