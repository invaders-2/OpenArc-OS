/**
 * D5-03 第一批测试夹具。
 *
 * 在 D3-03 的 device-fixtures（真实 IdentityStore + AuthorizationStore + AuthorizationService）
 * 之上叠加真实的 McpStore + CredentialStore + McpService + mcp:command IPC，
 * 保证测的这条线就是产品跑的那条线。
 *
 * 受控测试服务是自建 fixture（tests/fixtures/mcp/echo-server.mjs），不连任何第三方。
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createDeviceFixture } from "./device-fixtures.mjs";

const require = createRequire(import.meta.url);
const { McpStore } = require("../electron/mcp-store.cjs");
const { McpService } = require("../electron/mcp-service.cjs");
const { McpClient } = require("../electron/mcp-client.cjs");
const { CredentialStore, memoryCredentialBackend } = require("../electron/credential-store.cjs");
const { NodeChildProcessLauncher } = require("../electron/executor-launcher.cjs");
const { registerMcpIpc, MCP_COMMANDS, MCP_TOOL_INVOCATION_COMMANDS } = require("../electron/mcp-bootstrap.cjs");
const domain = require("../electron/mcp-domain.cjs");

export { domain, MCP_COMMANDS, MCP_TOOL_INVOCATION_COMMANDS, McpClient, NodeChildProcessLauncher, McpService, McpStore, CredentialStore, memoryCredentialBackend };
export const ECHO_HTTP_PATH = fileURLToPath(new URL("./fixtures/mcp/echo-server.mjs", import.meta.url));

/** 与 fixture 实际返回值一一对应（断言必须对着它，而不是对着客户端自己的常量）。 */
export const ECHO = Object.freeze({
  serverKey: "openarc-test-echo",
  serverName: "openarc-test-echo",
  serverVersion: "1.4.0",
  protocolVersion: "2025-06-18",
  tools: ["echo_sum", "describe_self"],
});

/** 收集 pid 的 launcher 包装：用于断言"停用/删除真的收掉了子进程"。 */
export function recordingLauncher() {
  const inner = new NodeChildProcessLauncher();
  const pids = [];
  return {
    pids,
    launcher: {
      available: true,
      launch(opts) {
        const handle = inner.launch(opts);
        if (handle.pid != null) pids.push(handle.pid);
        return handle;
      },
    },
  };
}

export function startEchoServer(args = []) {
  const child = spawn(process.execPath, [ECHO_HTTP_PATH, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += String(d); });
  const ready = new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("echo-server 未在 5s 内就绪：" + stderr)), 5000);
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
  return {
    child,
    ready,
    stop() { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } },
  };
}

/** 测试专用 seam：给白名单 stdio 程序追加参数（例如 --no-response），不改产品白名单本身。 */
function withStdioArgs(launcher, stdioArgs) {
  if (!Array.isArray(stdioArgs) || stdioArgs.length === 0) return launcher;
  return {
    available: launcher.available !== false,
    launch(opts) {
      return launcher.launch({ ...opts, args: [...(opts.args || []), ...stdioArgs] });
    },
  };
}

export async function createMcpFixture({ requestTimeoutMs = 4000, maxTools = 200, maxPages = 10, reconnectAttempts = 2, reconnectBackoffMs = 5, launcher = null, stdioArgs = null, clientFactory = null, credentialBackend = null } = {}) {
  const fx = await createDeviceFixture({ dbPath: ":memory:" });
  const mcpStore = new McpStore({ identity: fx.identity, clock: fx.clock });
  const credentialStore = new CredentialStore({ store: mcpStore, backend: credentialBackend || memoryCredentialBackend() });
  const activeLauncher = withStdioArgs(launcher || new NodeChildProcessLauncher(), stdioArgs);
  const mcpService = new McpService({
    identity: fx.identity,
    authService: fx.authService,
    authStore: fx.store,
    mcpStore,
    credentialStore,
    clientFactory: typeof clientFactory === "function" ? clientFactory : () => new McpClient({ launcher: activeLauncher, requestTimeoutMs, maxTools, maxPages }),
    requestTimeoutMs,
    maxTools,
    maxPages,
    reconnectAttempts,
    reconnectBackoffMs,
    clock: fx.clock,
  });
  // 内置 App baseline：MCP 中心持有 mcp.* 全量动作；resource-library 只有 mcp.view（无权看工具描述）。
  fx.store.upsertApp({ appId: "mcp-center", name: "MCP 中心", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
  fx.store.upsertAppGrant({ appId: "mcp-center", resourceType: "mcp", actions: ["mcp.view", "mcp.use", "mcp.manage", "mcp.test"], grantedBy: "test", organizationId: fx.orgId });
  fx.store.upsertApp({ appId: "resource-library", name: "资源库", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
  fx.store.upsertAppGrant({ appId: "resource-library", resourceType: "mcp", actions: ["mcp.view"], grantedBy: "test", organizationId: fx.orgId });

  const identityRef = { current: fx.sessions.admin };
  const ipc = { handlers: new Map() };
  registerMcpIpc({
    ipcMain: { handle: (channel, fn) => ipc.handlers.set(channel, fn), removeHandler: () => {} },
    service: mcpService,
    identity: identityRef,
    isTrusted: () => true,
  });
  const invoke = (command) => ipc.handlers.get("mcp:command")({}, command);

  return {
    ...fx,
    mcpStore,
    credentialStore,
    mcpService,
    identityRef,
    ipc,
    invoke,
    /** 以 MCP 中心 App 身份调用（sessionRef 由主进程注入这条线在真机上成立，这里同样只给 session）。 */
    mcpCtx: (key = "admin", extra = {}) => ({ sessionRef: fx.sessions[key], appId: "mcp-center", source: "ui", ...extra }),
    as: (key) => { identityRef.current = fx.sessions[key]; return identityRef; },
    /** 建一个本地（stdio 白名单）连接。 */
    async createLocal(overrides = {}, key = "admin") {
      const res = await invoke({
        command: "mcp/create",
        name: overrides.name || "本地测试回显",
        transport: "stdio",
        location: "LOCAL_DEVICE",
        endpoint: { serverKey: overrides.serverKey || ECHO.serverKey },
        authMode: overrides.authMode || "NONE",
        credentialSecret: overrides.credentialSecret,
        visibility: overrides.visibility || "PERSONAL",
      });
      return res;
    },
    async close() {
      try { await mcpService.dispose(); } catch { /* ignore */ }
      try { fx.identity.close(); } catch { /* ignore */ }
    },
  };
}

/** 轮询等待条件成立（有界，不 sleep 猜）。 */
export async function waitFor(fn, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
