/**
 * DX OS 0.6.1 · codex-canvas 安装器（移植：server/codexCanvasInstaller.ts:1-69）。
 *
 * 与源的三处必要差异：
 *   1. 源顶层 import MCP SDK（codexCanvasInstaller.ts:5-6）、按需 import esbuild（:29），
 *      本仓不新增 npm 依赖且要求惰性探测：SDK / esbuild / codex CLI 全部在函数内
 *      require.resolve + dynamic import，缺失时返回结构化的依赖不可用，绝不伪造成功。
 *   2. 源的桥接由 esbuild 现场打包 scripts/dxos-canvas-mcp.mjs 到 dataPath('cache'...)（:27-32）。
 *      本仓不引入打包器，改为优先接受显式桥接文件（环境变量），再回落仓库内同名入口；
 *      都没有时返回 BRIDGE_UNAVAILABLE 并说明缺什么。
 *   3. 源的 installCodexCanvasMcp 直接抛 Error（:66）；本仓一律返回结构化 { ok:false, error }，
 *      命令侧才能稳定映射成 CLI_UNAVAILABLE / DEPENDENCY_UNAVAILABLE。
 */
"use strict";

const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { delimiter, isAbsolute, join, resolve } = require("node:path");
const { promisify } = require("node:util");

const runFile = promisify(execFile);
const SERVER_NAME = "dxos-canvas";
const MCP_SDK_PACKAGE = "@modelcontextprotocol/sdk";
// codexCanvasInstaller.ts:42 桥接必须暴露的工具；缺一条即视为桥接不完整。
const REQUIRED_BRIDGE_TOOLS = Object.freeze([
  "connect_canvas", "read_canvas", "find_nodes", "get_nodes",
  "rename_node", "edit_node", "change_connection", "create_cards",
]);
const BRIDGE_ENV_KEYS = Object.freeze(["OPENARC_CODEX_CANVAS_BRIDGE", "DX_DESKTOP_MCP_BRIDGE"]);
const CODEX_INSTALL_HINT = "安装 OpenAI Codex CLI 后重试：npm install -g @openai/codex（或用 CODEX_BIN 指定绝对路径）";
const MCP_SDK_INSTALL_HINT = "缺少 " + MCP_SDK_PACKAGE + "：本仓不新增依赖，请由承载桥接的独立进程自带该包，或在宿主仓库 npm install " + MCP_SDK_PACKAGE;
const BRIDGE_INSTALL_HINT = "缺少 Codex 桥接入口：把 scripts/dxos-canvas-mcp.mjs 放回仓库，或设置 OPENARC_CODEX_CANVAS_BRIDGE（也兼容 DX_DESKTOP_MCP_BRIDGE）指向已打包的桥接文件";

class CodexCanvasInstallerError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "CodexCanvasInstallerError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

function codexCliCandidates(env = process.env) {
  // codexCanvasInstaller.ts:12-19 的候选顺序：LOCALAPPDATA 本地安装 → PATH 上的 codex。
  const local = env.LOCALAPPDATA;
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  return [
    ...(local ? [join(local, "Programs", "OpenAI", "Codex", "bin", exe)] : []),
    exe,
  ];
}

/** 惰性解析 codex CLI：未安装返回 null（不像源那样直接抛或无条件回退裸名）。 */
function resolveCodexCli({ env = process.env, exists = existsSync, codexBin = null } = {}) {
  const explicit = String(codexBin || env.CODEX_BIN || "").trim();
  if (explicit) return isAbsolute(explicit) && exists(explicit) ? explicit : null;
  const candidates = codexCliCandidates(env);
  const [localCandidate] = candidates;
  if (localCandidate && (localCandidate.includes("/") || localCandidate.includes("\\")) && exists(localCandidate)) return localCandidate;
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  for (const dir of String(env.PATH || "").split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (dir && exists(candidate)) return candidate;
    }
  }
  return null;
}

/** 惰性探测 MCP SDK（不 require 顶层；只在真正要用时才 resolve）。 */
function probeMcpSdk({ requireFn = require } = {}) {
  try {
    requireFn.resolve(MCP_SDK_PACKAGE + "/client/index.js");
    requireFn.resolve(MCP_SDK_PACKAGE + "/client/stdio.js");
    return { available: true, missing: [] };
  } catch {
    return { available: false, missing: [MCP_SDK_PACKAGE], install: [MCP_SDK_INSTALL_HINT] };
  }
}

/** 桥接入口：显式环境变量优先（打包/独立进程），否则回落仓库 scripts/dxos-canvas-mcp.mjs。 */
function resolveBridge({ env = process.env, exists = existsSync, bridgeEntry = null } = {}) {
  for (const key of BRIDGE_ENV_KEYS) {
    const configured = String(env[key] || "").trim();
    if (!configured) continue;
    if (exists(configured)) return { available: true, path: configured, source: key, missing: [] };
    // codexCanvasInstaller.ts:24 同义：显式配置但文件不在 = 安装包缺件。
    return { available: false, missing: [configured], install: [BRIDGE_INSTALL_HINT], detail: "DX OS 安装包缺少 Codex 桥接程序，请更新或重新安装软件" };
  }
  const entry = bridgeEntry || resolve(process.cwd(), "scripts", "dxos-canvas-mcp.mjs");
  if (exists(entry)) return { available: true, path: entry, source: "repo", missing: [] };
  return { available: false, missing: [entry], install: [BRIDGE_INSTALL_HINT] };
}

/**
 * 依赖体检：codex CLI / MCP SDK / 桥接入口三项独立探测，任一项缺失都如实报告。
 * @param deps 可注入 { env, exists, requireFn, codexBin, bridgeEntry }（测试用）。
 */
function codexCanvasInstallStatus({ deps = {} } = {}) {
  const { env = process.env, exists = existsSync, requireFn = require, codexBin = null, bridgeEntry = null } = deps;
  const codexPath = resolveCodexCli({ env, exists, codexBin });
  const mcpSdk = probeMcpSdk({ requireFn });
  const bridge = resolveBridge({ env, exists, bridgeEntry });
  const codex = { available: !!codexPath, path: codexPath || null, missing: codexPath ? [] : ["codex"], install: codexPath ? [] : [CODEX_INSTALL_HINT] };
  const missing = [...(codex.missing || []), ...(mcpSdk.missing || []), ...(bridge.missing || [])];
  const install = [...(codex.install || []), ...(mcpSdk.install || []), ...(bridge.install || [])];
  return { ok: missing.length === 0, codex, mcpSdk, bridge, missing, install };
}

/**
 * 等价 GET /api/codex-canvas/setup（index.ts:1193-1202）的服务端部分。
 * 源 codexCanvasInstaller.ts:46-51：command 用 DX_DESKTOP_MCP_NODE 或 process.execPath，
 * 参数 = [bridge, port]；manualCommand 供用户手工 codex mcp add。
 */
function codexCanvasMcpSetup({ port, deps = {} } = {}) {
  const status = codexCanvasInstallStatus({ deps });
  if (!status.bridge.available) {
    return fail("BRIDGE_UNAVAILABLE", { missing: status.bridge.missing, install: status.bridge.install, detail: status.bridge.detail || null, status });
  }
  const env = deps.env || process.env;
  const command = String(env.DX_DESKTOP_MCP_NODE || env.OPENARC_MCP_NODE || process.execPath);
  const bridge = status.bridge.path;
  const args = [bridge, String(port)];
  return ok({ command, args, bridge, manualCommand: "codex mcp add " + SERVER_NAME + " -- \"" + command + "\" \"" + bridge + "\" " + port });
}

/** 惰性加载 MCP SDK；缺失抛结构化错误（不顶层 import）。 */
async function loadMcpSdk(deps = {}) {
  const probe = probeMcpSdk(deps);
  if (!probe.available) {
    throw new CodexCanvasInstallerError("MCP_SDK_UNAVAILABLE", MCP_SDK_INSTALL_HINT, { missing: probe.missing, install: probe.install });
  }
  // 源 codexCanvasInstaller.ts:5-6 是静态 ESM import；CJS 侧只能动态 import。
  const index = await import(MCP_SDK_PACKAGE + "/client/index.js");
  const stdio = await import(MCP_SDK_PACKAGE + "/client/stdio.js");
  return { Client: index.Client, StdioClientTransport: stdio.StdioClientTransport };
}

/** 等价 codexCanvasInstaller.ts:37-44：真连桥接 stdio，列工具并校验必需工具齐全。 */
async function checkBridge({ command, args, deps = {} } = {}) {
  const sdk = await loadMcpSdk(deps);
  const Client = sdk.Client;
  const StdioClientTransport = sdk.StdioClientTransport;
  if (typeof Client !== "function" || typeof StdioClientTransport !== "function") {
    throw new CodexCanvasInstallerError("MCP_SDK_UNAVAILABLE", "MCP SDK 形状不完整（缺少 Client / StdioClientTransport）", { missing: [MCP_SDK_PACKAGE] });
  }
  const client = new Client({ name: "openarc-canvas-install-check", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command, args }));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    const absent = REQUIRED_BRIDGE_TOOLS.filter((name) => !names.includes(name));
    if (absent.length) throw new CodexCanvasInstallerError("BRIDGE_INCOMPLETE", "桥接工具列表不完整", { missing: absent });
  } finally {
    await client.close().catch(() => {});
  }
  return ok({ tools: [...REQUIRED_BRIDGE_TOOLS] });
}

/**
 * 等价 POST /api/codex-canvas/install（index.ts:1204-1208）+ codexCanvasInstaller.ts:53-68。
 * 返回结构化结果；任何缺失依赖都带 missing / install 说明。
 */
async function installCodexCanvasMcp({ port, deps = {} } = {}) {
  const status = codexCanvasInstallStatus({ deps });
  if (!status.codex.available) {
    return fail("CLI_UNAVAILABLE", { missing: status.codex.missing, install: status.codex.install, detail: "未找到 OpenAI Codex CLI", status });
  }
  if (!status.bridge.available) {
    return fail("BRIDGE_UNAVAILABLE", { missing: status.bridge.missing, install: status.bridge.install, detail: status.bridge.detail || null, status });
  }
  if (!status.mcpSdk.available) {
    return fail("MCP_SDK_UNAVAILABLE", { missing: status.mcpSdk.missing, install: status.mcpSdk.install, status });
  }
  const setup = codexCanvasMcpSetup({ port, deps });
  if (!setup.ok) return setup;
  const runCommand = typeof deps.runCommand === "function" ? deps.runCommand : runFile;
  try {
    await checkBridge({ command: setup.command, args: setup.args, deps });
    await runCommand(status.codex.path, ["mcp", "add", SERVER_NAME, "--", setup.command, ...setup.args], { timeout: 20_000, windowsHide: true });
    const { stdout } = await runCommand(status.codex.path, ["mcp", "get", SERVER_NAME, "--json"], { timeout: 10_000, windowsHide: true });
    let saved = null;
    try { saved = JSON.parse(stdout); } catch { saved = null; }
    if (!saved || saved.transport?.command !== setup.command || JSON.stringify(saved.transport?.args) !== JSON.stringify(setup.args)) {
      throw new CodexCanvasInstallerError("REGISTER_MISMATCH", "Codex 保存的桥接路径与当前 OpenArc 不一致");
    }
  } catch (error) {
    const code = error instanceof CodexCanvasInstallerError ? error.code : "REGISTER_FAILED";
    const detail = String((error && error.stderr) || (error && error.message) || error).trim().slice(0, 400);
    return fail(code, { missing: error && error.missing ? error.missing : [], install: error && error.install ? error.install : [], detail });
  }
  return ok({
    registered: true,
    bridge: setup.bridge,
    command: setup.command,
    args: setup.args,
    restartHint: "若当前 Codex 任务没有出现 " + SERVER_NAME + " 工具，请新建任务或重启 Codex。",
  });
}

module.exports = {
  SERVER_NAME,
  MCP_SDK_PACKAGE,
  REQUIRED_BRIDGE_TOOLS,
  BRIDGE_ENV_KEYS,
  CODEX_INSTALL_HINT,
  MCP_SDK_INSTALL_HINT,
  BRIDGE_INSTALL_HINT,
  CodexCanvasInstallerError,
  codexCliCandidates,
  resolveCodexCli,
  probeMcpSdk,
  resolveBridge,
  codexCanvasInstallStatus,
  codexCanvasMcpSetup,
  loadMcpSdk,
  checkBridge,
  installCodexCanvasMcp,
};
