/**
 * DX OS 0.6.1 · CLI 域纯逻辑（无 IO、无子进程、无网络）。
 *
 * 目标：把本仓**已有的** CLI 能力（electron/agent-cli-bridge.cjs / agent-cli-tools.cjs /
 * agent-pippit-tools.cjs）从「模块内函数」升级为对齐 DX OS /api/cli/* 的「命令出口」。
 * 命令名逐字对照（见 electron/protocol-engine/legacy-protocols.cjs 的 cli:* 供应商协议）：
 *   cli/list          → 依赖清单（四个工具）
 *   cli/status        → /api/cli/<tool>/status
 *   cli/models        → /api/cli/<tool>/models
 *   cli/credit        → /api/cli/<tool>/credit（仅即梦 / 小云雀）
 *   cli/login/start   → /api/cli/<tool>/login/start
 *   cli/login/status  → /api/cli/<tool>/login/status
 *   cli/logout        → /api/cli/<tool>/logout
 *
 * 本文件只做纯逻辑：命令表（即白名单）、工具表、错误码、信封规约。
 * 真正的探测 / 状态 / 模型 / 积分 / 登录 / 登出调用全部落在 cli-service.cjs，
 * 逐条转发到既有出口，绝不重写、绝不伪造。
 *
 * 错误码与 foundation 的脱敏规约复用 electron/dxos-foundation-errors.cjs，
 * 不产生第二套错误协议；未知异常一律折叠成 DXOS_ERR_INTERNAL。
 *
 * 关于 CLI_UNAUTHENTICATED：任务书冻结的错误码面向"域业务失败"；会话未认证是本域
 * 必须 fail closed 的安全边界（与 OCR / PHOTOS / PLATFORM 的 *_UNAUTHENTICATED 同形），
 * 因此单列一条，不占用 CLI_FAILED 的语义。
 */
"use strict";

const foundationErrors = require("./dxos-foundation-errors.cjs");

/** 唯一渲染层入口通道（字面量；安全回归探针按字面量扫描 IPC 暴露面）。 */
const CLI_COMMAND_CHANNEL = "cli:command";

/** 域自有错误码（渲染层可稳定判别）。 */
const CLI_ERR_COMMAND_NOT_ALLOWED = "CLI_COMMAND_NOT_ALLOWED";
const CLI_ERR_NOT_READY = "CLI_NOT_READY";
const CLI_ERR_INVALID_INPUT = "CLI_INVALID_INPUT";
const CLI_ERR_UNAVAILABLE = "CLI_UNAVAILABLE";
const CLI_ERR_UNSUPPORTED = "CLI_UNSUPPORTED";
const CLI_ERR_FAILED = "CLI_FAILED";
const CLI_ERR_UNAUTHENTICATED = "CLI_UNAUTHENTICATED";

const CLI_ERROR_CODES = Object.freeze([
  CLI_ERR_COMMAND_NOT_ALLOWED,
  CLI_ERR_NOT_READY,
  CLI_ERR_INVALID_INPUT,
  CLI_ERR_UNAVAILABLE,
  CLI_ERR_UNSUPPORTED,
  CLI_ERR_FAILED,
  CLI_ERR_UNAUTHENTICATED,
]);

/** cli:command 白名单：命令表本身即白名单，未登记命令一律 COMMAND_NOT_ALLOWED，不做动态分发。 */
const CLI_COMMANDS = Object.freeze({
  "cli/list": { risk: "read", credential: false, summary: "列出四个 CLI 工具的安装 / 版本 / 能力 / 是否必须登录（不启动子进程）" },
  "cli/status": { risk: "read", credential: false, summary: "查询一个 CLI 工具的安装状态、版本、登录态与运行时" },
  "cli/models": { risk: "read", credential: false, summary: "查询一个 CLI 工具的模型目录" },
  "cli/credit": { risk: "read", credential: true, summary: "查询即梦 / 小云雀积分余额（仅这两个工具具备该能力）" },
  "cli/login/start": { risk: "use", credential: false, summary: "发起一个 CLI 工具的登录流程（终端 / 浏览器授权链接）" },
  "cli/login/status": { risk: "read", credential: false, summary: "查询登录流程状态（idle / pending / authorized / failed）" },
  "cli/logout": { risk: "manage", credential: false, summary: "退出一个 CLI 工具的登录态" },
});

const CLI_COMMAND_ORDER = Object.freeze([
  "cli/list",
  "cli/status",
  "cli/models",
  "cli/credit",
  "cli/login/start",
  "cli/login/status",
  "cli/logout",
]);

/**
 * 工具表：id / 展示名 / 必须登录 / 该工具**真实具备**的子能力。
 * capabilities 是 cli/credit / cli/logout 这类"按工具分流"命令的唯一判据；
 * 未登记的能力一律 CLI_UNSUPPORTED，绝不落到"假成功"。
 *
 *   · codex / gemini：agent-cli-bridge.cjs（codex / antigravity·gemini）——没有积分能力；
 *     bridge.agentCliLogout("gemini") 明确回"没有统一的安全退出命令"，因此 gemini 无 logout。
 *   · jimeng / pippit：积分来自 agent-cli-tools.jimengCredit / agent-pippit-tools.pippitCredit。
 */
const CLI_TOOLS = Object.freeze({
  codex: Object.freeze({ id: "codex", name: "OpenAI Codex CLI", loginRequired: true, capabilities: Object.freeze(["status", "models", "login/start", "login/status", "logout"]) }),
  gemini: Object.freeze({ id: "gemini", name: "Gemini / Antigravity CLI", loginRequired: true, capabilities: Object.freeze(["status", "models", "login/start", "login/status"]) }),
  jimeng: Object.freeze({ id: "jimeng", name: "即梦 dreamina CLI", loginRequired: true, capabilities: Object.freeze(["status", "models", "credit", "login/start", "login/status", "logout"]) }),
  pippit: Object.freeze({ id: "pippit", name: "小云雀 pippit-tool-cli", loginRequired: true, capabilities: Object.freeze(["status", "models", "credit", "login/start", "login/status", "logout"]) }),
});

const CLI_TOOL_ORDER = Object.freeze(["codex", "gemini", "jimeng", "pippit"]);

function isCliCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(CLI_COMMANDS, command);
}

function cliCommandEntry(command) {
  return isCliCommand(command) ? CLI_COMMANDS[command] : null;
}

function cliCommandRisk(command) {
  const entry = cliCommandEntry(command);
  return entry ? entry.risk : null;
}

function cliCommandRequiresCredential(command) {
  const entry = cliCommandEntry(command);
  return !!(entry && entry.credential);
}

function listCliCommands() {
  return CLI_COMMAND_ORDER.map((command) => ({
    command,
    risk: CLI_COMMANDS[command].risk,
    needsCredential: CLI_COMMANDS[command].credential,
    summary: CLI_COMMANDS[command].summary,
  }));
}

function isCliTool(tool) {
  return typeof tool === "string" && Object.prototype.hasOwnProperty.call(CLI_TOOLS, tool);
}

function cliToolEntry(tool) {
  return isCliTool(tool) ? CLI_TOOLS[tool] : null;
}

function listCliTools() {
  return CLI_TOOL_ORDER.map((id) => ({ id, name: CLI_TOOLS[id].name, capabilities: [...CLI_TOOLS[id].capabilities], loginRequired: CLI_TOOLS[id].loginRequired }));
}

/** 构造带稳定 code 的 CLI 域错误；message / detail 过 foundation 脱敏。 */
function createCliError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "CliError";
  err.code = CLI_ERROR_CODES.includes(code) ? code : foundationErrors.DXOS_ERR_INTERNAL;
  if (detail !== undefined) err.detail = foundationErrors.redactValue(detail);
  return err;
}

function isCliError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && CLI_ERROR_CODES.includes(err.code);
}

function redactCliValue(value) {
  return foundationErrors.redactValue(value);
}

/** CLI 域错误 → 渲染层安全结果。形状与 foundation 一致：{ ok:false, error, message, detail? }。 */
function normalizeCliError(err) {
  if (isCliError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    return out;
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

function cliCommandNotAllowed(command) {
  return createCliError(CLI_ERR_COMMAND_NOT_ALLOWED, "未知或未授权的 cli 命令：" + String(command == null ? "" : command), { command: command == null ? null : String(command) });
}

function cliInvalidInput(message, detail) {
  return createCliError(CLI_ERR_INVALID_INPUT, message || "cli 命令入参非法", detail);
}

function cliNotReady() {
  return createCliError(CLI_ERR_NOT_READY, "CLI 域尚未装配");
}

function cliUnauthenticated() {
  return createCliError(CLI_ERR_UNAUTHENTICATED, "当前会话未认证，CLI 命令被拒绝");
}

function cliUnavailable(detail, tool) {
  return createCliError(CLI_ERR_UNAVAILABLE, "未检测到 CLI" + (tool ? "（" + tool + "）" : ""), detail === undefined ? undefined : detail);
}

function cliUnsupported(tool, capability) {
  return createCliError(CLI_ERR_UNSUPPORTED, "工具 " + String(tool) + " 不具备能力：" + String(capability), { tool: tool == null ? null : String(tool), capability: capability == null ? null : String(capability) });
}

function cliFailed(message, detail) {
  return createCliError(CLI_ERR_FAILED, message || "CLI 命令执行失败", detail);
}

/** 渲染层出口：成功 { ok:true, value }；失败 normalizeCliError（与 foundation.toIpcResult 同形）。 */
async function toCliIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: redactCliValue(value) };
  } catch (err) {
    return normalizeCliError(err);
  }
}

module.exports = {
  CLI_COMMAND_CHANNEL,
  CLI_ERR_COMMAND_NOT_ALLOWED,
  CLI_ERR_NOT_READY,
  CLI_ERR_INVALID_INPUT,
  CLI_ERR_UNAVAILABLE,
  CLI_ERR_UNSUPPORTED,
  CLI_ERR_FAILED,
  CLI_ERR_UNAUTHENTICATED,
  CLI_ERROR_CODES,
  CLI_COMMANDS,
  CLI_COMMAND_ORDER,
  CLI_TOOLS,
  CLI_TOOL_ORDER,
  isCliCommand,
  cliCommandEntry,
  cliCommandRisk,
  cliCommandRequiresCredential,
  listCliCommands,
  isCliTool,
  cliToolEntry,
  listCliTools,
  createCliError,
  isCliError,
  redactCliValue,
  normalizeCliError,
  cliCommandNotAllowed,
  cliInvalidInput,
  cliNotReady,
  cliUnauthenticated,
  cliUnavailable,
  cliUnsupported,
  cliFailed,
  toCliIpcResult,
};
