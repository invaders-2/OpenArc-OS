/**
 * D4-02B · Official DeepSeek Harness ACP Adapter（OpenArc ACP Client）。
 *
 * 永久边界：**OpenArc = Task Authority，Harness = Reasoning Runtime**。
 * 本 Adapter 只做 ACP v1 over stdio 的 client 侧：initialize / session-new /
 * prompt / update / cancel / close / dispose，外加隔离 DSH_HOME、显式 env
 * allowlist + secret scrub、permission 一律 reject、bounded shutdown。
 *
 * 它**不**拥有 queue / Task status / Step status / Task revision / retry /
 * recovery / lease / permission state —— 那些属于 TaskService。
 * 它**不**持有 Provider API Key；模型经 OpenArc Model Proxy（Harness Model
 * Adapter）走。
 */
"use strict";
const { spawn } = require("node:child_process");
const { Readable, Writable } = require("node:stream");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { HarnessModelAdapter } = require("./harness-model-adapter.cjs");

const ACP_PROTOCOL_VERSION = 1;

const HARNESS_ERROR = Object.freeze({
  PROCESS_EXITED: "HARNESS_PROCESS_EXITED",
  PROTOCOL_ERROR: "HARNESS_PROTOCOL_ERROR",
  PROTOCOL_UNSUPPORTED: "HARNESS_PROTOCOL_UNSUPPORTED",
  START_TIMEOUT: "HARNESS_START_TIMEOUT",
  TURN_TIMEOUT: "HARNESS_TURN_TIMEOUT",
  CANCELLED: "HARNESS_CANCELLED",
  PERMISSION_DENIED: "HARNESS_PERMISSION_DENIED",
  NOT_STARTED: "HARNESS_NOT_STARTED",
});

/** 运行时必须从 OpenArc 管理或冻结的等价路径启动，绝不依赖用户 PATH。 */
function resolveDshRuntime() {
  return process.env.OPENARC_DSH_RUNTIME || path.join(os.homedir(), "Library", "Application Support", "DSH Desktop", "runtime");
}
function resolveDshBin(runtime = resolveDshRuntime()) {
  if (process.env.OPENARC_DSH_BIN) return process.env.OPENARC_DSH_BIN;
  const managed = path.join(runtime, "node_modules", ".bin", "dsh");
  if (fs.existsSync(managed)) return managed;
  const local = path.join(__dirname, "..", "node_modules", ".bin", "dsh");
  if (fs.existsSync(local)) return local;
  return null;
}
function resolveAcpSdk(runtime = resolveDshRuntime()) {
  try { return require.resolve("@agentclientprotocol/sdk"); } catch { /* fall through */ }
  const p = path.join(runtime, "node_modules", "@agentclientprotocol", "sdk", "dist", "acp.js");
  return fs.existsSync(p) ? p : null;
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function dshVersion(runtime = resolveDshRuntime()) {
  return readJson(path.join(runtime, "node_modules", "@deepseek-ai", "dsh", "package.json"))?.version || null;
}
function sdkVersion(sdkPath) {
  try { return readJson(path.join(path.dirname(path.dirname(sdkPath)), "package.json"))?.version || null; } catch { return null; }
}

function harnessError(code, detail) { const e = new Error(code + (detail ? ": " + detail : "")); e.code = code; return e; }

/** 显式 allowlist；其余一律不继承。 */
const ENV_ALLOWLIST = ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SHELL"];
/** 显式清除的敏感变量（即使出现在 allowlist 之外也强制删除）。 */
const SECRET_DENYLIST = [
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY", "AZURE_API_KEY",
  "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "SSH_AUTH_SOCK",
];
function buildHarnessEnv({ dshHome, bridgeBaseUrl, capability, workspace, extra = {} } = {}) {
  const env = {};
  for (const k of ENV_ALLOWLIST) if (process.env[k] != null) env[k] = process.env[k];
  for (const k of SECRET_DENYLIST) delete env[k];
  env.HOME = path.join(dshHome, "home");
  env.DSH_HOME = dshHome;
  env.DSH_PERMISSION_MODE = "read-only";
  env.DSH_TELEMETRY_MODE = "DISABLED";
  if (bridgeBaseUrl) env.OPENARC_HARNESS_BRIDGE = bridgeBaseUrl;
  if (capability) env.OPENARC_MODEL_PROXY_CAPABILITY = capability;
  if (workspace) env.OPENARC_HARNESS_WORKSPACE = workspace;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

/** OpenArc 管理的 ACP profile patch：ACP stdio ON，模型走 OpenArc，其它全部关。 */
function buildAcpPatch() {
  const disabled = [
    "llm-deepseek", "llm-retry", "session-telemetry-otel",
    "web", "web-search-deepseek", "web-fetch-http",
    "tool-bash", "tool-pwsh", "tool-fs", "tool-fs-search", "tool-web", "tool-jobs",
    "tool-skill", "tool-goal", "tool-ralph", "tool-workflow", "tool-present",
    "tool-subagent", "tool-subagent-fork", "tool-subagent-control", "tool-subagent-list-agents",
    "skill", "skill-filesystem",
  ];
  const lines = [];
  for (const id of disabled) { lines.push("- id: " + id, "  disabled: true"); }
  lines.push(
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    "      openarc:",
    "        displayName: OpenArc Model Proxy",
    "        api: openai-completions",
    "        baseURL: !!js process.env.OPENARC_HARNESS_BRIDGE",
    "        apiKeyEnv: OPENARC_MODEL_PROXY_CAPABILITY",
    "        retryPolicy:",
    "          mode: normal",
    "          maxRetries: 0",
    "        models:",
    "          - id: openarc-task-model",
    "            name: OpenArc Task Model",
    "            contextWindow: 32768",
    "            maxTokens: 4096",
    "            input:",
    "              - text",
    "- id: agent-default-model",
    "  config:",
    "    provider: openarc",
    "    model: openarc-task-model",
    "- id: acp",
    "  config:",
    "    provider: openarc",
    "    model: openarc-task-model",
    ""
  );
  return lines.join("\n");
}

class HarnessAdapter {
  constructor({ modelProxy = null, logger = null, clock = null, dshBin = null, dshRuntime = null, sdkPath = null, dshArgs = null, keepTemp = false } = {}) {
    if (!modelProxy) throw new Error("HarnessAdapter 需要 ModelProxy");
    this.modelProxy = modelProxy;
    this.logger = logger;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.runtime = dshRuntime || resolveDshRuntime();
    this.bin = dshBin || resolveDshBin(this.runtime);
    this.sdkPath = sdkPath || resolveAcpSdk(this.runtime);
    this.dshArgs = dshArgs;
    this.keepTemp = keepTemp;
    this.dshVersion = dshVersion(this.runtime);
    this.sdkVersion = this.sdkPath ? sdkVersion(this.sdkPath) : null;
    this.protocolVersion = ACP_PROTOCOL_VERSION;
    this.bridge = null;
    this.child = null;
    this.conn = null;
    this.sessionId = null;
    this.capability = null;
    this.dshHome = null;
    this.workspace = null;
    this.events = [];
    this.permissions = [];
    this.started = false;
    this.processExited = false;
    this.exitCode = null;
    this.protocolError = false;
    this.stderr = "";
    this._exitWaiters = [];
  }

  /** Harness 只能拿到 Proxy endpoint + scoped capability + safe model metadata。 */
  async start({ context, modelConfigId, maxCalls = 4, ttlMs = 120000, workspace = null, startTimeoutMs = 30000, requestId = null } = {}) {
    if (!this.bin) throw harnessError(HARNESS_ERROR.NOT_STARTED, "dsh executable not found");
    if (!this.sdkPath) throw harnessError(HARNESS_ERROR.NOT_STARTED, "ACP SDK not found");
    const cap = this.modelProxy.issueCapability({ context, configId: modelConfigId, allowedCapabilities: ["chat"], maxCalls, ttlMs });
    if (!cap.ok) { const e = harnessError(cap.error === "MODEL_CONFIG_UNAVAILABLE" ? HARNESS_ERROR.NOT_STARTED : cap.error); throw e; }
    this.capability = { capabilityId: cap.capability.capabilityId, token: cap.capability.token, maxCalls: cap.capability.maxCalls, modelConfigId: cap.capability.modelConfigId, modelConfigVersion: cap.capability.modelConfigVersion };

    this.bridge = new HarnessModelAdapter({ modelProxy: this.modelProxy, logger: this.logger, clock: this.clock, expectedToken: this.capability.token, requestId });
    this.modelRequestId = requestId;
    await this.bridge.start();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-02b-"));
    this.root = root;
    this.dshHome = path.join(root, "dsh-home");
    this.workspace = workspace || path.join(root, "workspace");
    fs.mkdirSync(this.dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.dshHome, "home"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.workspace, { recursive: true });

    const env = buildHarnessEnv({ dshHome: this.dshHome, bridgeBaseUrl: this.bridge.baseUrl, capability: this.capability.token, workspace: this.workspace });
    this.childEnv = env;
    let args = this.dshArgs;
    if (!args) {
      const patchPath = path.join(root, "openarc-acp.yml");
      fs.writeFileSync(patchPath, buildAcpPatch(), { mode: 0o600 });
      args = ["--profile", "acp", "--patch", patchPath];
    }
    this.child = spawn(this.bin, args, { env, cwd: this.workspace, stdio: ["pipe", "pipe", "pipe"] });
    this.started = true;
    this.child.stderr.on("data", (d) => { this.stderr += String(d); if (this.stderr.length > 200000) this.stderr = this.stderr.slice(-200000); });
    this.child.on("exit", (code, signal) => { this.processExited = true; this.exitCode = code; for (const w of this._exitWaiters.splice(0)) w({ code, signal }); });
    // stdout 只允许 ACP protocol：不解析、不记录，交给 SDK。
    const { ClientSideConnection, ndJsonStream } = await import(require("node:url").pathToFileURL(this.sdkPath).href);
    const stream = ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout));
    const client = {
      sessionUpdate: async (params) => { this.#onUpdate(params); },
      requestPermission: async (params) => { this.permissions.push(this.#safePermission(params)); this.events.push({ type: "permission.requested", at: this.clock() }); return { outcome: "cancelled" }; },
      readTextFile: async () => { throw harnessError(HARNESS_ERROR.PERMISSION_DENIED, "fs disabled"); },
      writeTextFile: async () => { throw harnessError(HARNESS_ERROR.PERMISSION_DENIED, "fs disabled"); },
    };
    this.conn = new ClientSideConnection(() => client, stream);

    const init = await this.#withTimeout(
      this.conn.initialize({ protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }),
      startTimeoutMs, HARNESS_ERROR.START_TIMEOUT
    );
    if (Number(init.protocolVersion) !== ACP_PROTOCOL_VERSION) throw harnessError(HARNESS_ERROR.PROTOCOL_UNSUPPORTED, "agent protocolVersion=" + init.protocolVersion);
    this.agentInfo = init.agentInfo || null;
    const session = await this.conn.newSession({ cwd: this.workspace, mcpServers: [], additionalDirectories: [] });
    this.sessionId = session.sessionId;
    return {
      sessionId: this.sessionId,
      dshHome: this.dshHome,
      workspace: this.workspace,
      capabilityId: this.capability.capabilityId,
      modelConfigId: this.capability.modelConfigId,
      modelConfigVersion: this.capability.modelConfigVersion,
      dshVersion: this.dshVersion,
      sdkVersion: this.sdkVersion,
      protocolVersion: init.protocolVersion,
      agentInfo: this.agentInfo,
    };
  }

  #safePermission(params) {
    const call = params && params.toolCall ? params.toolCall : {};
    return { sessionId: params?.sessionId || null, toolCallId: call.toolCallId || call.id || null, kind: call.kind || null, title: typeof call.title === "string" ? call.title.slice(0, 120) : null, options: Array.isArray(params?.options) ? params.options.length : 0, at: this.clock() };
  }

  /** ACP session/update → 内部 HarnessEvent（保留原始类型，绝不发明事件）。 */
  #onUpdate(params) {
    const u = params && params.update ? params.update : {};
    const raw = u.sessionUpdate || "unknown";
    const ev = { type: raw, at: this.clock(), raw };
    if (raw === "agent_message_chunk" && u.content && typeof u.content.text === "string") { ev.type = "text.delta"; ev.text = u.content.text; }
    else if (raw === "agent_thought_chunk" && u.content && typeof u.content.text === "string") { ev.type = "reasoning.delta"; ev.text = u.content.text; }
    else if (raw === "tool_call" || raw === "tool_call_update") { ev.type = "tool.proposed"; ev.toolCallId = u.toolCallId || null; }
    else if (raw === "plan") { ev.type = "plan"; }
    else if (raw === "usage_update") { ev.type = "usage"; ev.usage = u.usage || null; }
    this.events.push(ev);
  }

  #withTimeout(promise, ms, code) {
    let t;
    const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(harnessError(code)), Math.max(1, ms)); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  async prompt(text, { timeoutMs = 120000 } = {}) {
    if (!this.conn || !this.sessionId) throw harnessError(HARNESS_ERROR.NOT_STARTED);
    if (this.processExited) throw harnessError(HARNESS_ERROR.PROCESS_EXITED);
    this.turnCancelled = false;
    try {
      const res = await this.#withTimeout(
        this.conn.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text: String(text) }] }),
        timeoutMs, HARNESS_ERROR.TURN_TIMEOUT
      );
      this.assertAlive();
      return { ok: true, stopReason: res.stopReason, text: this.#collectedText(), events: this.events.slice() };
    } catch (e) {
      if (e.code === HARNESS_ERROR.TURN_TIMEOUT) { try { await this.cancel(); } catch { /* ignore */ } throw e; }
      // child 被杀时 SDK 可能先报 "connection closed"，等一个 bounded 窗口再判定进程已退出。
      if (!this.processExited) await Promise.race([this.waitExit(500), new Promise((r) => setTimeout(r, 250))]);
      if (this.processExited) throw harnessError(HARNESS_ERROR.PROCESS_EXITED);
      if (e.code) throw e;
      if (/parse|invalid|unexpected|malformed|json/i.test(String(e.message))) { this.protocolError = true; throw harnessError(HARNESS_ERROR.PROTOCOL_ERROR, String(e.message).slice(0, 120)); }
      throw harnessError(HARNESS_ERROR.PROTOCOL_ERROR, String(e.message).slice(0, 120));
    }
  }

  #collectedText() { return this.events.filter((e) => e.type === "text.delta").map((e) => e.text).join(""); }

  assertAlive() {
    if (this.processExited) throw harnessError(HARNESS_ERROR.PROCESS_EXITED);
    if (this.protocolError) throw harnessError(HARNESS_ERROR.PROTOCOL_ERROR);
  }

  async cancel() {
    if (!this.conn || !this.sessionId) return { ok: false, error: HARNESS_ERROR.NOT_STARTED };
    this.turnCancelled = true;
    await this.conn.cancel({ sessionId: this.sessionId });
    return { ok: true };
  }

  /** Harness turn 一结束（success/failure/cancel/timeout/crash/conflict/blocked）立即 revoke，不等 TTL。*/
  revokeModelCapability() {
    if (!this.capability || !this.capability.token) return { ok: true, changed: false };
    const r = this.modelProxy.revokeCapability(this.capability.token);
    this.capability = null;
    return r;
  }

  async closeSession() {
    if (!this.conn || !this.sessionId) return { ok: true, changed: false };
    try { await this.#withTimeout(this.conn.closeSession({ sessionId: this.sessionId }), 10000, HARNESS_ERROR.TURN_TIMEOUT); } catch { /* best effort */ }
    const id = this.sessionId; this.sessionId = null;
    return { ok: true, sessionId: id };
  }

  waitExit(ms = 5000) {
    if (this.processExited) return Promise.resolve({ code: this.exitCode });
    return new Promise((resolve) => { const w = (x) => resolve(x); this._exitWaiters.push(w); setTimeout(() => resolve({ code: null, timeout: true }), ms); });
  }

  /** bounded shutdown：closeSession → stdin close → SIGTERM → bounded SIGKILL。 */
  async dispose() {
    try { await this.closeSession(); } catch { /* ignore */ }
    const child = this.child;
    if (child && !this.processExited) {
      try { child.stdin.end(); } catch { /* ignore */ }
      const exited = await Promise.race([this.waitExit(2500), new Promise((r) => setTimeout(() => r({ timeout: true }), 2500))]);
      if (exited && exited.timeout && !this.processExited) {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        const term = await Promise.race([this.waitExit(2000), new Promise((r) => setTimeout(() => r({ timeout: true }), 2000))]);
        if (term && term.timeout && !this.processExited) { try { child.kill("SIGKILL"); } catch { /* ignore */ } await this.waitExit(1500); }
      }
    }
    try { await this.bridge?.stop(); } catch { /* ignore */ }
    this.bridge = null;
    if (!this.keepTemp && this.root) { try { fs.rmSync(this.root, { recursive: true, force: true }); } catch { /* ignore */ } }
    return { ok: true, exited: this.processExited, exitCode: this.exitCode, protocolError: this.protocolError };
  }
}

module.exports = { HarnessAdapter, HARNESS_ERROR, ACP_PROTOCOL_VERSION, resolveDshRuntime, resolveDshBin, resolveAcpSdk, dshVersion, buildHarnessEnv, buildAcpPatch };
