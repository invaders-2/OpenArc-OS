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
/**
 * D5-03 第十二批：用户取消后等 agent 回 cancelled 的窗口。
 * ACP 的 `session/cancel` 是**通知**，协议允许 agent 不回；没有这个窗口，runTask 会挂在
 * 「等 agent 回话」上直到执行预算（180s）。窗口只覆盖收尾，不改变正常 turn 的语义。
 */
const CANCEL_SETTLE_MS = 750;

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

/**
 * 运行时必须来自 OpenArc 自己冻结的本地安装，绝不依赖用户 PATH，也绝不借用 DSH Desktop 共享运行时。
 * 共享运行时随桌面端升级而漂移，是版本不确定的源头：默认分支里不得出现它的路径。
 * 显式覆盖（OPENARC_DSH_RUNTIME / OPENARC_DSH_BIN）同样要**校验**，任何不符一律抛错，绝不回退到未知版本。
 */
const DSH_RUNTIME_ERROR = Object.freeze({ RUNTIME_MISSING: "DSH_RUNTIME_MISSING", VERSION_MISMATCH: "DSH_VERSION_MISMATCH" });
const PINNED_DSH_VERSION = "0.1.5-rc.2";
const PROJECT_RUNTIME_ROOT = path.resolve(__dirname, "..");
function dshPackageJson(runtime) { return path.join(runtime, "node_modules", "@deepseek-ai", "dsh", "package.json"); }
function assertDshRuntime(runtime, origin) {
  const pkg = readJson(dshPackageJson(runtime));
  if (!pkg || !pkg.version) throw harnessError(DSH_RUNTIME_ERROR.RUNTIME_MISSING, origin + " " + runtime + " 内没有 @deepseek-ai/dsh");
  if (pkg.version !== PINNED_DSH_VERSION) throw harnessError(DSH_RUNTIME_ERROR.VERSION_MISMATCH, origin + " " + runtime + " 需要 " + PINNED_DSH_VERSION + "，实际 " + pkg.version);
  return runtime;
}
function resolveDshRuntime() {
  const override = process.env.OPENARC_DSH_RUNTIME;
  return assertDshRuntime(override ? path.resolve(override) : PROJECT_RUNTIME_ROOT, override ? "OPENARC_DSH_RUNTIME" : "project runtime");
}
/** 该 bin 归属哪个 dsh 安装根（node_modules/.bin/dsh 是软链，必须走 realpath）。 */
function dshRuntimeRootOf(bin) {
  let real; try { real = fs.realpathSync(bin); } catch { return null; }
  for (let dir = path.dirname(real); ;) {
    if (fs.existsSync(dshPackageJson(dir))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
/** 只在已解析的运行时内找 bin；找不到返回 null（= 该运行时缺 bin，由调用方语义与 NOT_STARTED 区分）。 */
function resolveDshBin(runtime = resolveDshRuntime()) {
  const override = process.env.OPENARC_DSH_BIN;
  if (override) {
    const bin = path.resolve(override);
    const owner = dshRuntimeRootOf(bin);
    if (!owner) throw harnessError(DSH_RUNTIME_ERROR.RUNTIME_MISSING, "OPENARC_DSH_BIN " + bin + " 不属于任何 @deepseek-ai/dsh 安装");
    assertDshRuntime(owner, "OPENARC_DSH_BIN runtime");
    return bin;
  }
  const managed = path.join(runtime, "node_modules", ".bin", "dsh");
  return fs.existsSync(managed) ? managed : null;
}
/** ACP SDK 只认项目内那一份（PIN 1.4.0）；运行时切换不得改用别处副本。 */
function resolveAcpSdk() {
  try { return require.resolve("@agentclientprotocol/sdk"); } catch { return null; }
}
/**
 * task-66：优先使用随包 Node（app/node_modules/.bin/node，由 sync-app 复制）。
 * 没有随包 Node 时返回 null，调用方回退 process.execPath。
 */
function resolveDshNode(runtime = resolveDshRuntime()) {
  const explicit = process.env.OPENARC_DSH_NODE ? path.resolve(process.env.OPENARC_DSH_NODE) : null;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const bundled = path.join(runtime, "node_modules", ".bin", "node");
  try { return fs.existsSync(bundled) && fs.statSync(bundled).isFile() ? bundled : null; } catch { return null; }
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function dshVersion(runtime = resolveDshRuntime()) {
  return readJson(dshPackageJson(runtime))?.version || null;
}
function sdkVersion(sdkPath) {
  try { return readJson(path.join(path.dirname(path.dirname(sdkPath)), "package.json"))?.version || null; } catch { return null; }
}

function harnessError(code, detail) { const e = new Error(code + (detail ? ": " + detail : "")); e.code = code; return e; }

/**
 * task-66：DSH bin 带 #!/usr/bin/env node，Finder 启动的 GUI PATH 没有 node 时直接 127。
 * 永远用不依赖用户 PATH 的解释器执行 JS bin：
 *   · 打包 app 优先 app/node_modules/.bin/node（sync-app 随包复制，PATH 首位）；
 *   · 无随包 Node 时 Electron main 用 process.execPath + ELECTRON_RUN_AS_NODE=1；
 *   · Node（测试/CLI）用 process.execPath。
 * 自定义 dshBin 是可执行二进制（如 process.execPath）时按 direct 原样 spawn，不再套 Node。
 * 显式注入的 execPath/versions 供单测，不改变产品调用。
 */
function isJsBin(bin) {
  try {
    const real = fs.realpathSync(bin);
    if (/\.(?:m|c)?js$/.test(real)) return true;
    const fd = fs.openSync(real, "r");
    const head = Buffer.alloc(80);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    try { fs.closeSync(fd); } catch { /* ignore */ }
    return /^#!.*\bnode\b/.test(head.subarray(0, n).toString("utf8"));
  } catch {
    return /\.(?:m|c)?js$/.test(String(bin)) || /node_modules[\\/]\.bin[\\/]/.test(String(bin));
  }
}

function buildDshSpawn({ bin, args = [], env = {}, execPath = process.execPath, versions = process.versions, nodeBin = null, jsBin = true } = {}) {
  if (!bin) throw new Error("buildDshSpawn 需要 bin");
  const isElectron = !!(versions && versions.electron);
  const childEnv = { ...env };
  // 自定义 dshBin 可能是可执行二进制 / process.execPath 本身，不能再套一层 Node。
  if (!jsBin) return { command: String(bin), args: [...args], env: childEnv, interpreter: "direct" };
  if (nodeBin) {
    // 随包 Node：直接执行，并把它的目录放到 PATH 首位，让 dsh 的孙进程也能找到 node。
    const dir = path.dirname(nodeBin);
    childEnv.PATH = [dir, childEnv.PATH].filter(Boolean).join(path.delimiter);
    return { command: nodeBin, args: [String(bin), ...args], env: childEnv, interpreter: "bundled-node" };
  }
  if (isElectron) childEnv.ELECTRON_RUN_AS_NODE = "1";
  const interpreterArgs = isElectron ? ["--expose-internals"] : [];
  return { command: execPath, args: [...interpreterArgs, String(bin), ...args], env: childEnv, interpreter: isElectron ? "electron-node" : "node" };
}

/** 显式 allowlist；其余一律不继承。 */
const ENV_ALLOWLIST = ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SHELL"];
/** 显式清除的敏感变量（即使出现在 allowlist 之外也强制删除）。 */
const SECRET_DENYLIST = [
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY", "AZURE_API_KEY",
  "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "SSH_AUTH_SOCK",
];
function buildHarnessEnv({ dshHome, bridgeBaseUrl, capability, workspace, toolFacadeUrl = null, toolFacadeCapability = null, toolFacadeManifest = null, extra = {} } = {}) {
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
  // §8/§9：Tool Facade capability 只经 trusted child env 交给 dsh；不落盘。
  if (toolFacadeUrl) env.OPENARC_TOOL_FACADE_URL = toolFacadeUrl;
  if (toolFacadeCapability) env.OPENARC_TOOL_FACADE_CAPABILITY = toolFacadeCapability;
  if (toolFacadeManifest) env.OPENARC_TOOL_FACADE_MANIFEST = toolFacadeManifest;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

const MANAGED_TOOL_PROFILE = "openarc-acp";
const TOOL_FACADE_BUNDLE = path.join(__dirname, "dsh-openarc-read-tools");

/**
 * D4-03B Closure · 每个 run 生成隔离的 openarc-acp profile（DSH_HOME 内），
 * 经 official bundle 机制加载 OpenArc Tool Plugin。绝不触碰真实 ~/.dsh。
 */
function buildManagedToolProfile({ dshHome, manifest }) {
  const profileDir = path.join(dshHome, "profiles", MANAGED_TOOL_PROFILE);
  fs.mkdirSync(path.join(profileDir, "node_modules"), { recursive: true, mode: 0o700 });
  fs.cpSync(TOOL_FACADE_BUNDLE, path.join(profileDir, "node_modules", "dsh-openarc-read-tools"), { recursive: true });
  fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({ name: "dsh-profile-openarc-acp", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app", "dsh-openarc-read-tools"], patchReload: "startup" } } }, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), "[]\n", { mode: 0o600 });
  fs.writeFileSync(path.join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");
  const manifestPath = path.join(profileDir, "openarc-read-tools.manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { profileDir, manifestPath };
}

/**
 * 按模型名估上下文窗口 / 单次输出上限（模型配置里没有这项元数据）。
 * 估低只会让压缩提前发生；估高会让上游报超长，所以未知模型取保守值。
 */
const MODEL_LIMITS = Object.freeze([
  [/claude/i, 200000, 8192],
  [/gemini/i, 200000, 8192],
  [/deepseek|qwen|qwq|glm|kimi|moonshot|doubao|seed|minimax|mistral|llama|grok|ernie|hunyuan|step/i, 128000, 8192],
  [/gpt-5|gpt-4\.1|gpt-4o|o[134](-|$)/i, 128000, 8192],
]);
const DEFAULT_MODEL_LIMITS = Object.freeze({ contextWindow: 65536, maxTokens: 8192 });
function modelLimits(modelId) {
  const id = String(modelId || "");
  for (const [re, contextWindow, maxTokens] of MODEL_LIMITS) if (re.test(id)) return { contextWindow, maxTokens };
  return { ...DEFAULT_MODEL_LIMITS };
}

/** YAML 单行字符串（单引号转义），只用于 OpenArc 自己写的 persona 文本。 */
/** 计划条目只保留 content / status，限长限量（模型写的文字，按普通输出对待）。 */
const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);
function safePlan(entries) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries.slice(0, 20) : []) {
    if (!e || typeof e !== "object") continue;
    const content = typeof e.content === "string" ? e.content.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    if (!content) continue;
    out.push({ content, status: PLAN_STATUSES.has(e.status) ? e.status : "pending" });
  }
  return out;
}

function yamlQuote(text) { return "'" + String(text).replace(/[\r\n]+/g, " ").replace(/'/g, "''") + "'"; }

/** OpenArc 管理的 ACP profile patch：ACP stdio ON，模型走 OpenArc，其它全部关。 */
function buildAcpPatch({ contextWindow = 32768, maxTokens = 4096, persona = null, planTool = false, subagentTool = false } = {}) {
  const all = [
    "llm-deepseek", "llm-retry", "session-telemetry-otel",
    "web", "web-search-deepseek", "web-fetch-http",
    "tool-bash", "tool-pwsh", "tool-fs", "tool-fs-search", "tool-web", "tool-jobs",
    "tool-skill", "tool-goal", "tool-ralph", "tool-workflow", "tool-present",
    "tool-subagent", "tool-subagent-fork", "tool-subagent-control", "tool-subagent-list-agents",
    "skill", "skill-filesystem",
  ];
  // 全局 AI 子 agent（第 4 期）：只打开 dsh 的 spawn 子 agent 工具（前台等结果、最多一层），其余委派工具仍关。
  const disabled = subagentTool ? all.filter((id) => id !== "tool-subagent") : all;
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
    "            contextWindow: " + Math.max(8192, Math.floor(Number(contextWindow) || 32768)),
    "            maxTokens: " + Math.max(1024, Math.floor(Number(maxTokens) || 4096)),
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
  );
  if (persona) {
    // 全局 AI：把 dsh 默认的"coding agent / 工作目录"人设换成 OpenArc 助手（随会话保留，压缩后也在）。
    lines.push("- id: system-prompt", "  config:", "    personaPrefix: " + yamlQuote(persona), "    personaSuffix: ''");
  }
  if (planTool) {
    // 全局 AI：打开 dsh 自带的 todo_write（只改会话里的任务清单，不碰文件 / 网络），多步任务先列计划再执行。
    lines.push("- id: tool-todo", "  disabled: false");
  }
  if (subagentTool) {
    // 子 agent 和主 AI 用同一套 OpenArc 受控工具、同一个模型代理和预算；写入 / 命令照样要审批。
    lines.push(
      "- id: tool-subagent",
      "  disabled: false",
      "  config:",
      "    provider: spawn",
      "    toolName: subagent",
      "    modelSelectionSettings: false",
      "    backgroundMode: one-shot",
      "    enableRunInBackground: false",
      "    maxDepth: 1",
    );
  }
  lines.push("");
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
    this.dshBinIsScript = isJsBin(this.bin);
    this.node = resolveDshNode(this.runtime);
    this.sdkPath = sdkPath || resolveAcpSdk(this.runtime);
    this.dshArgs = dshArgs;
    this.keepTemp = keepTemp;
    this.dshVersion = dshVersion(this.runtime);
    this.sdkVersion = this.sdkPath ? sdkVersion(this.sdkPath) : null;
    this.protocolVersion = ACP_PROTOCOL_VERSION;
    this.bridge = null;
    this.toolFacade = null;
    this.toolCapability = null;
    this.child = null;
    this.conn = null;
    this.sessionId = null;
    this.capability = null;
    this.dshHome = null;
    this.workspace = null;
    this.events = [];
    this.listeners = new Set();
    this.permissions = [];
    this.started = false;
    this.processExited = false;
    this.exitCode = null;
    this.protocolError = false;
    this.stderr = "";
    // D5-03 第十批：在途启动的中断 / 收尾状态（启动预算见 start 的绝对截止时间）。
    this.disposed = false;
    this.interrupted = false;
    this._turnSettle = null;
    this._turnSettled = false;
    this.startupSettled = false;
    this._startupSettleDeferred = null;
    this._teardownPromise = null;
    this._exitWaiters = [];
  }

  /** Harness 只能拿到 Proxy endpoint + scoped capability + safe model metadata。 */
  /** modelConfigVersion = 本 run 的任务冻结版本；未绑定旧任务传 null（不校验，保持既有行为）。 */
  async start(args = {}) {
    const { startTimeoutMs = 30000 } = args;
    // D5-03 第十批：启动预算是一个**绝对截止时间**，initialize 与 session/new 共用它，
    // 绝不每段各自重新获得一份预算。启动被 cancel / dispose 中断时也不得再复活。
    const deadlineAt = this.#now() + Math.max(1, startTimeoutMs);
    this.startupSettled = false;
    this.interrupted = false;
    try {
      return await Promise.race([
        this.#runStartup(args, deadlineAt),
        this.#awaitStartupSettled().then(() => { throw harnessError(HARNESS_ERROR.START_TIMEOUT); }),
      ]);
    } catch (e) {
      // 启动失败（超时 / 中断 / 协议错）必须自己收干净：子进程、连接、临时目录、两类能力。
      await this.#runTeardown();
      throw e;
    }
  }

  async #runStartup(options, deadlineAt) {
    const { context, modelConfigId, modelConfigVersion = null, maxCalls = 4, ttlMs = 120000, workspace = null, requestId = null, toolFacade = null, memory = null, session = null, persona = null, planTool = false, subagentTool = false } = options;
    if (!this.bin) throw harnessError(HARNESS_ERROR.NOT_STARTED, "dsh executable not found in runtime " + this.runtime);
    if (!this.sdkPath) throw harnessError(HARNESS_ERROR.NOT_STARTED, "ACP SDK not found");
    // dispose 之后不再复用同一实例（启动、签发能力、spawn 子进程全部拒绝）。
    this.#assertNotInterrupted(HARNESS_ERROR.START_TIMEOUT);
    const cap = this.modelProxy.issueCapability({ context, configId: modelConfigId, allowedCapabilities: ["chat"], maxCalls, ttlMs, expectedModelConfigVersion: modelConfigVersion });
    if (!cap.ok) { const e = harnessError(cap.error === "MODEL_CONFIG_UNAVAILABLE" ? HARNESS_ERROR.NOT_STARTED : cap.error); throw e; }
    this.capability = { capabilityId: cap.capability.capabilityId, token: cap.capability.token, maxCalls: cap.capability.maxCalls, modelConfigId: cap.capability.modelConfigId, modelConfigVersion: cap.capability.modelConfigVersion };
    this.limits = modelLimits(cap.capability.modelId);

    this.bridge = new HarnessModelAdapter({ modelProxy: this.modelProxy, logger: this.logger, clock: this.clock, expectedToken: this.capability.token, requestId, memory });
    this.modelRequestId = requestId;
    await this.bridge.start();

    // 会话目录：给了 session.root 就用这个持久目录（同一对话跨轮复用 dsh 会话），否则每个 run 一个临时目录。
    const persistentRoot = session && typeof session.root === "string" && session.root ? path.resolve(session.root) : null;
    if (persistentRoot) fs.mkdirSync(persistentRoot, { recursive: true, mode: 0o700 });
    const root = persistentRoot || fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-02b-"));
    this.root = root;
    this.persistentRoot = !!persistentRoot;
    this.dshHome = path.join(root, "dsh-home");
    this.workspace = workspace || path.join(root, "workspace");
    fs.mkdirSync(this.dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.dshHome, "home"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.workspace, { recursive: true });

    // D4-03B Closure：official dsh Tool Facade —— 隔离 profile + official bundle + run 级 tpx_ capability。
    let facadeEnv = {}; let profileArgs = null;
    if (toolFacade) {
      if (!toolFacade.bridge || !toolFacade.manifest) throw harnessError(HARNESS_ERROR.NOT_STARTED, "toolFacade 需要 bridge + manifest");
      this.toolFacade = toolFacade;
      const profile = buildManagedToolProfile({ dshHome: this.dshHome, manifest: toolFacade.manifest });
      const cap = toolFacade.bridge.issueCapability({ context, taskId: toolFacade.taskId, stepId: toolFacade.stepId, runId: toolFacade.runId, allowedTools: toolFacade.manifest.toolIds, maxCalls: toolFacade.maxCalls, ttlMs: toolFacade.ttlMs });
      if (!cap.ok) throw harnessError(HARNESS_ERROR.NOT_STARTED, "tool capability: " + cap.error);
      this.toolCapability = cap.capability;
      facadeEnv = { toolFacadeUrl: toolFacade.bridge.baseUrl, toolFacadeCapability: cap.capability.token, toolFacadeManifest: profile.manifestPath };
      profileArgs = ["--profile", MANAGED_TOOL_PROFILE];
    }
    const env = buildHarnessEnv({ dshHome: this.dshHome, bridgeBaseUrl: this.bridge.baseUrl, capability: this.capability.token, workspace: this.workspace, ...facadeEnv });
    this.childEnv = env;
    let args = this.dshArgs;
    if (!args) {
      const patchPath = path.join(root, "openarc-acp.yml");
      fs.writeFileSync(patchPath, buildAcpPatch({ ...this.limits, persona, planTool, subagentTool }), { mode: 0o600 });
      args = profileArgs ? [...profileArgs, "--patch", patchPath] : ["--profile", "acp", "--patch", patchPath];
    }
    // task-66：不用 shebang（GUI 最小 PATH 无 node 会 127），显式用运行时自带 Node。
    const invocation = buildDshSpawn({ bin: this.bin, args, env, nodeBin: this.node, jsBin: this.dshBinIsScript });
    this.child = spawn(invocation.command, invocation.args, { env: invocation.env, cwd: this.workspace, stdio: ["pipe", "pipe", "pipe"] });
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

    let init;
    let started = null;
    try {
      init = await this.#withDeadline(
        this.conn.initialize({ protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }),
        deadlineAt, HARNESS_ERROR.START_TIMEOUT
      );
      this.#assertNotInterrupted(HARNESS_ERROR.START_TIMEOUT);
      if (Number(init.protocolVersion) !== ACP_PROTOCOL_VERSION) throw harnessError(HARNESS_ERROR.PROTOCOL_UNSUPPORTED, "agent protocolVersion=" + init.protocolVersion);
      this.agentInfo = init.agentInfo || null;
      const resumeId = session && typeof session.resumeSessionId === "string" && session.resumeSessionId ? session.resumeSessionId : null;
      this.resumed = false;
      if (resumeId && persistentRoot && typeof this.conn.resumeSession === "function") {
        // 接着上一轮的 dsh 会话（历史与压缩状态都在会话目录里）；恢复不了就开新会话，绝不让这一轮失败。
        try {
          await this.#withDeadline(this.conn.resumeSession({ sessionId: resumeId, cwd: this.workspace, mcpServers: [] }), deadlineAt, HARNESS_ERROR.START_TIMEOUT);
          this.resumed = true;
          started = { sessionId: resumeId };
        } catch (e) {
          if (e && e.code === HARNESS_ERROR.START_TIMEOUT) throw e;
          this.#assertNotInterrupted(HARNESS_ERROR.START_TIMEOUT);
          try { this.logger?.log?.({ event: "harness.session.resume_failed", detail: String((e && e.message) || e).slice(0, 200) }); } catch { /* ignore */ }
        }
      }
      if (!started) {
        started = await this.#withDeadline(
          this.conn.newSession({ cwd: this.workspace, mcpServers: [], additionalDirectories: [] }),
          deadlineAt, HARNESS_ERROR.START_TIMEOUT
        );
      }
    } catch (e) {
      if (e && e.code) throw e;
      this.protocolError = true;
      // 子进程死亡时 ACP 连接先关、exit 事件通常同 tick 才到：等一个很短的窗口再判定真实原因，
      // 绝不把「子进程没了」退化成协议错或内建错误（与 prompt 的失败归类同口径）。
      if (!this.processExited) await Promise.race([this.waitExit(250), new Promise((r) => setTimeout(r, 100))]);
      if (this.processExited) throw harnessError(HARNESS_ERROR.PROCESS_EXITED);
      throw harnessError(HARNESS_ERROR.PROTOCOL_ERROR, String((e && e.message) || e).slice(0, 120));
    }
    // 迟到的 session/new（截止时间已过 / 已被 cancel / dispose 中断）绝不复活启动。
    this.#assertNotInterrupted(HARNESS_ERROR.START_TIMEOUT);
    // 启动段内子进程死亡：按真实原因收敛，绝不把「没有 session 的成功」交给编排器。
    if (this.processExited) throw harnessError(HARNESS_ERROR.PROCESS_EXITED);
    if (!started || !started.sessionId) throw harnessError(HARNESS_ERROR.PROTOCOL_ERROR, "session/new 未返回 sessionId");
    this.sessionId = started.sessionId;
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
      toolExecutionMode: toolFacade ? "facade" : "openarc",
      toolCapabilityId: this.toolCapability ? this.toolCapability.capabilityId : null,
      resumed: !!this.resumed,
      persistent: this.persistentRoot,
      contextWindow: this.limits ? this.limits.contextWindow : null,
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
    else if (raw === "tool_call" || raw === "tool_call_update") {
      ev.type = "tool.proposed";
      ev.toolCallId = u.toolCallId || null;
      // OpenArc 测试约定：toolId 走 ACP title，version/arguments 走 rawInput。原始 rawInput 只交给 Tool Proxy，不落 TaskEvent。
      ev.title = typeof u.title === "string" ? u.title.slice(0, 160) : null;
      ev.kind = u.kind || null;
      ev.rawInput = u.rawInput && typeof u.rawInput === "object" ? u.rawInput : null;
    }
    else if (raw === "plan") { ev.type = "plan"; ev.plan = safePlan(Array.isArray(u.entries) ? u.entries : []); }
    else if (raw === "usage_update") { ev.type = "usage"; ev.usage = u.usage || null; }
    this.events.push(ev);
    // dsh 的 todo_write 不发 ACP plan 更新，这里把它的清单转成一条 plan 事件，界面统一按计划显示。
    if (raw === "tool_call" && ev.title === "todo_write" && ev.rawInput && Array.isArray(ev.rawInput.todos)) {
      const planEv = { type: "plan", at: ev.at, raw: "plan", plan: safePlan(ev.rawInput.todos), source: "todo_write" };
      this.events.push(planEv);
      this.#notify(planEv);
    }
    this.#notify(ev);
  }

  /** 运行中的进度订阅（计划 / 工具 / 文本片段），只给界面看，不落库。返回取消订阅函数。 */
  subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #notify(ev) {
    for (const fn of this.listeners) { try { fn(ev); } catch { /* 订阅方出错不影响 run */ } }
  }

  #withTimeout(promise, ms, code) { return this.#withDeadline(promise, this.#now() + Math.max(1, ms), code); }

  /**
   * D5-03 第十批：**绝对截止时间**版等待。`deadlineAt <= now` 立刻超时（剩余预算为 0），
   * 绝不退化成「本段重新计时」；中断信号同时打断等待。
   */
  #withDeadline(promise, deadlineAt, code) {
    const ms = Math.max(0, deadlineAt - this.#now());
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(harnessError(code)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  #now() { return this.clock(); }

  #assertNotInterrupted(code) { if (this.interrupted) throw harnessError(code); }

  #signalStartupSettled() {
    this.startupSettled = true;
    const settle = this._startupSettle;
    this._startupSettle = null;
    if (settle) settle();
  }

  #awaitStartupSettled() {
    if (this.startupSettled) return Promise.resolve();
    if (!this._startupSettleDeferred) {
      let settle;
      const promise = new Promise((r) => { settle = r; });
      this._startupSettleDeferred = { promise, settle };
    }
    return this._startupSettleDeferred.promise;
  }

  /**
   * 启动被中断（用户 cancel / 应用 dispose）：立刻让在途 start 有界收敛，
   * 之后 dispose 再回收子进程、连接、临时目录与两类能力。
   */
  abortStart() { this.interrupted = true; this.#signalStartupSettled(); }

  /** 启动失败（超时 / 中断 / 协议错）时的自清理：与 dispose 同一份收尾，幂等且只跑一次。 */
  #runTeardown() {
    const dispose = () => (async () => {
      try { this.revokeToolCapability(); } catch { /* ignore */ }
      try { this.revokeModelCapability(); } catch { /* ignore */ }
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
      // 持久会话目录留给下一轮恢复；只删每个 run 自己的临时目录。
      if (!this.keepTemp && this.root && !this.persistentRoot) { try { fs.rmSync(this.root, { recursive: true, force: true }); } catch { /* ignore */ } }
      return { ok: true, exited: this.processExited, exitCode: this.exitCode, protocolError: this.protocolError };
    })();
    if (!this._teardownPromise) this._teardownPromise = dispose().catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    return this._teardownPromise;
  }

  async prompt(text, { timeoutMs = 120000, cancelSettleMs = CANCEL_SETTLE_MS } = {}) {
    if (!this.conn || !this.sessionId) throw harnessError(HARNESS_ERROR.NOT_STARTED);
    if (this.processExited) throw harnessError(HARNESS_ERROR.PROCESS_EXITED);
    this.turnCancelled = false;
    this._turnSettle = null;
    this._turnSettled = false;
    // D4-03B：每次 prompt 只返回本 turn 产生的事件/文本，支持多 turn tool loop（不重复处理旧事件）。
    const from = this.events.length;
    const request = this.conn.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text: String(text) }] });
    try {
      const res = await this.#withTimeout(
        Promise.race([request, this.#awaitTurnCancelled(cancelSettleMs)]),
        timeoutMs, HARNESS_ERROR.TURN_TIMEOUT
      );
      this._turnSettled = true;
      this.assertAlive();
      const turnEvents = this.events.slice(from);
      return { ok: true, stopReason: res.stopReason, text: this.#collectedText(turnEvents), events: turnEvents };
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

  #collectedText(events = this.events) { return events.filter((e) => e.type === "text.delta").map((e) => e.text).join(""); }

  assertAlive() {
    if (this.processExited) throw harnessError(HARNESS_ERROR.PROCESS_EXITED);
    if (this.protocolError) throw harnessError(HARNESS_ERROR.PROTOCOL_ERROR);
  }

  /** 用户 cancel 同时打断在途启动段：启动未完成时也必须能被取消。 */
  async cancel() {
    this.abortStart();
    if (!this.conn || !this.sessionId) return { ok: false, error: HARNESS_ERROR.NOT_STARTED };
    this.turnCancelled = true;
    // 通知 agent（协议要求），随后等一个很小的窗口：agent 回了就按它的 stopReason 走，
    // 不回就由 prompt 侧的取消窗口按真实取消收尾 —— 两者都不会无界等待。
    const sent = await this.conn.cancel({ sessionId: this.sessionId }).then(() => true, () => false);
    const settle = this._turnSettle;
    this._turnSettle = null;
    if (settle) settle();
    return { ok: true, notified: sent };
  }

  /**
   * 只等一个很小的窗口：**用户真的取消过**之后，agent 仍未回 cancelled 时按真实取消结果收尾。
   * 没取消过就绝不武装这个窗口 —— 否则正常的慢 turn 会被误判成取消。
   */
  #awaitTurnCancelled(ms) {
    if (this.turnCancelled) return Promise.resolve({ stopReason: "cancelled" });
    const limit = Math.max(0, Number(ms) || 0);
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { if (timer) clearTimeout(timer); this._turnSettle = null; resolve({ stopReason: "cancelled" }); };
      this._turnSettle = done;
      timer = setTimeout(() => { if (this.turnCancelled) done(); }, limit);
    });
  }

  /** Harness turn 一结束（success/failure/cancel/timeout/crash/conflict/blocked）立即 revoke，不等 TTL。*/
  revokeModelCapability() {
    if (!this.capability || !this.capability.token) return { ok: true, changed: false };
    const r = this.modelProxy.revokeCapability(this.capability.token);
    this.capability = null;
    return r;
  }

  /** §18/§55：run 一结束（success/failure/cancel/crash/timeout/blocked）立即 revoke Tool capability，不等 TTL。 */
  revokeToolCapability() {
    if (!this.toolCapability || !this.toolCapability.token || !this.toolFacade) return { ok: true, changed: false };
    const r = this.toolFacade.bridge.revokeCapability(this.toolCapability.token);
    this.toolCapability = null;
    return r;
  }

  /**
   * D4-06 Closure · 只读预算状态。
   * 只有当 Model Proxy / Tool Facade capability 因预算被真实拒绝（429）进入 EXHAUSTED
   * 时才返回 exhausted；耗尽后 orchestrator 才有资格归为 BUDGET_EXHAUSTED（kind）。
   * 绝不改变任何 capability state，也绝不消耗预算。
   */
  budgetExhausted() {
    // D4 收口：TOOL_CALLS 优先于 MODEL_CALLS。Tool Facade 与 Model Proxy 同时耗尽时，
    // 必须归因到真实先触发的工具预算，绝不让 MODEL_CALLS 掩盖 TOOL_CALLS。
    const observed = { model: null, tool: null };
    if (this.capability && this.capability.token) {
      const state = this.modelProxy.capabilityState(this.capability.token);
      const maxCalls = this.capability.maxCalls == null ? null : this.capability.maxCalls;
      const remaining = state && state.remaining != null ? state.remaining : null;
      observed.model = { maxCalls, calls: maxCalls != null && remaining != null ? Math.max(0, maxCalls - remaining) : null, state: state ? state.state : null, remaining };
    }
    if (this.toolCapability && this.toolCapability.token && this.toolFacade) {
      const state = this.toolFacade.bridge.capabilityState(this.toolCapability.token);
      const maxCalls = state && state.maxCalls != null ? state.maxCalls : null;
      const calls = state && state.calls != null ? state.calls : null;
      observed.tool = { maxCalls, calls, state: state ? state.state : null, remaining: maxCalls != null && calls != null ? Math.max(0, maxCalls - calls) : null, exhaustedRejections: state && state.exhaustedRejections != null ? state.exhaustedRejections : null };
    }
    if (observed.tool && observed.tool.state === "EXHAUSTED") {
      return { exhausted: true, kind: "TOOL_CALLS", consumed: observed.tool.calls, maxCalls: observed.tool.maxCalls, observed };
    }
    if (observed.model && observed.model.state === "EXHAUSTED") {
      return { exhausted: true, kind: "MODEL_CALLS", consumed: observed.model.calls, maxCalls: observed.model.maxCalls, observed };
    }
    return { exhausted: false, kind: null, consumed: null, maxCalls: null, observed };
  }

  async closeSession() {
    const conn = this.conn;
    if (!conn || !this.sessionId) return { ok: true, changed: false };
    const id = this.sessionId;
    this.sessionId = null;
    try { await this.#withTimeout(conn.closeSession({ sessionId: id }), 10000, HARNESS_ERROR.TURN_TIMEOUT); } catch { /* best effort */ }
    return { ok: true, sessionId: id };
  }

  waitExit(ms = 5000) {
    if (this.processExited) return Promise.resolve({ code: this.exitCode });
    return new Promise((resolve) => { const w = (x) => resolve(x); this._exitWaiters.push(w); setTimeout(() => resolve({ code: null, timeout: true }), ms); });
  }

  /**
   * bounded shutdown：closeSession → stdin close → SIGTERM → bounded SIGKILL。
   * D5-03 第十批：**幂等**，且先打断在途启动（否则启动段会留在无界等待里）。
   */
  async dispose() {
    this.disposed = true;
    this.abortStart();
    return await this.#runTeardown();
  }
}

module.exports = { HarnessAdapter, HARNESS_ERROR, modelLimits, MODEL_LIMITS, DSH_RUNTIME_ERROR, ACP_PROTOCOL_VERSION, resolveDshRuntime, resolveDshBin, resolveDshNode, resolveAcpSdk, dshVersion, buildHarnessEnv, buildDshSpawn, buildAcpPatch, safePlan, buildManagedToolProfile, MANAGED_TOOL_PROFILE, TOOL_FACADE_BUNDLE };
