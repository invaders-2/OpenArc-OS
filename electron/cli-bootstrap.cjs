/**
 * DX OS 0.6.1 · CLI 域 IPC 引导：唯一渲染层入口 cli:command。
 *
 * 与 electron/app-exchange-bootstrap.cjs / photos-bootstrap.cjs 同一 trusted 边界：
 *   · isTrusted(event) 由宿主注入（main.cjs 的 trusted）；未注入或返回假值一律
 *     throw Error("Forbidden")（fail closed），绝不默认放行；
 *   · 会话未认证（identity.current 为空）→ 稳定回 CLI_UNAUTHENTICATED，不落任何子进程；
 *   · sessionRef / appId 一律由主进程从可信身份推导，忽略渲染层自报的 userId / role / appId；
 *   · cli-domain.cjs:CLI_COMMANDS 本身即白名单，未登记命令一律 CLI_COMMAND_NOT_ALLOWED；
 *   · 未装配（bundle 缺失）→ 稳定回 CLI_NOT_READY，不注册半成品 handler。
 *
 * bootstrap 只承担 trusted / 认证 / 白名单；真实探测与执行在 cli-service.cjs。
 *
 * 接线（由 Lead 在 main.cjs 统一完成）：
 *   const { createCliBundle } = require("./cli-service.cjs");
 *   const { registerCliIpc } = require("./cli-bootstrap.cjs");
 *   registerCliIpc(ipcMain, {
 *     bundle: createCliBundle({}),          // 缺省即复用三个既有 CLI 出口
 *     identity: identity.service,           // 只读 identity.current 作 sessionRef
 *     isTrusted: trusted,
 *     hostAppId: "cli",
 *   });
 */
"use strict";

const domain = require("./cli-domain.cjs");

const CLI_NOT_READY = domain.CLI_ERR_NOT_READY;
const asStr = (value, max = 100) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));
const commandOf = (raw) => (raw.command != null ? asStr(raw.command, 100) : asStr(raw.type, 100));
const payloadOf = (raw) => (raw.payload && typeof raw.payload === "object" ? raw.payload : raw);

/**
 * 注册 cli:command。
 *
 * @param ipcMain Electron ipcMain（测试传假实现，只需 handle / removeHandler）。
 * @param deps    { bundle, isTrusted, identity, hostAppId }
 *   · bundle    createCliBundle(...) 产物；缺失或没有 execute → 每次调用稳定回 CLI_NOT_READY
 *   · isTrusted (event) => boolean；缺失即拒绝全部调用（绝不默认放行）
 *   · identity  IdentityService（可选）：只读 identity.current 作为 sessionRef；为空即未认证
 *   · hostAppId 承载 CLI 域的 App Principal（默认 "cli"）
 */
function registerCliIpc(ipcMain, deps = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerCliIpc 需要 ipcMain.handle");
  const { bundle = null, isTrusted = null, identity = null, hostAppId = "cli" } = deps || {};
  const sessionRef = () => (identity && typeof identity === "object" ? identity.current || null : null);

  if (typeof ipcMain.removeHandler === "function") {
    try { ipcMain.removeHandler(domain.CLI_COMMAND_CHANNEL); } catch { /* 尚未注册 */ }
  }

  ipcMain.handle(domain.CLI_COMMAND_CHANNEL, async (event, raw) => {
    // 第一道：宿主信任判据（sender + senderFrame.url 双重条件，同 main.cjs trusted）。
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!bundle || typeof bundle.execute !== "function") return domain.normalizeCliError(domain.cliNotReady());
    if (!raw || typeof raw !== "object") return domain.normalizeCliError(domain.cliInvalidInput("cli:command 需要对象载荷"));
    const command = commandOf(raw);
    if (!domain.isCliCommand(command)) return domain.normalizeCliError(domain.cliCommandNotAllowed(command));
    // 第二道：会话认证。sessionRef 只来自主进程可信身份，渲染层自报字段一概忽略。
    const ref = sessionRef();
    if (!ref) return domain.normalizeCliError(domain.cliUnauthenticated());
    const payload = payloadOf(raw) || {};
    return bundle.execute(command, payload, { sessionRef: ref, appId: asStr(hostAppId, 60) || "cli", requestId: asStr(payload.requestId, 100) });
  });

  return { channel: domain.CLI_COMMAND_CHANNEL, dispose: () => disposeCliIpc(ipcMain) };
}

function disposeCliIpc(ipcMain) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") {
    try { ipcMain.removeHandler(domain.CLI_COMMAND_CHANNEL); } catch { /* 忽略 */ }
  }
}

module.exports = { registerCliIpc, disposeCliIpc, CLI_COMMAND_CHANNEL: domain.CLI_COMMAND_CHANNEL, CLI_NOT_READY };
