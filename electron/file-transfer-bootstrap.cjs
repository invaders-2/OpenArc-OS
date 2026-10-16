/**
 * 文件传输域 IPC 引导：唯一渲染层入口 fileTransfer:command。
 *
 * 与 electron/canvas-bootstrap.cjs / developer-bootstrap.cjs 同一 trusted 边界：
 *   · isTrusted(event) 由宿主注入（main.cjs 的 trusted）；未注入即判 Forbidden（fail closed），
 *     绝不默认放行；
 *   · sessionRef / appId 一律由主进程从可信身份推导，忽略渲染层自报的 userId / owner / appId；
 *   · 只注册一条命令通道，不新增下行事件通道，不暴露 ipcRenderer / 宿主路径；
 *   · 命令表 file-transfer-domain.cjs:FILE_TRANSFER_COMMANDS 本身即白名单，未登记命令一律
 *     FILE_TRANSFER_COMMAND_NOT_ALLOWED。
 *
 * 本文件**不改** electron/main.cjs / electron/preload.cjs / src/types/openarc-ipc.d.ts；
 * 接线由 main.cjs 后续完成，调用面即下方 registerFileTransferIpc(ipcMain, deps)。
 */
"use strict";

const domain = require("./file-transfer-domain.cjs");

const FILE_TRANSFER_CHANNEL = "fileTransfer:command";
const FILE_TRANSFER_NOT_READY = domain.FILE_TRANSFER_ERR_NOT_READY;
const asStr = (value, max = 100) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));
const commandOf = (raw) => (raw.command != null ? asStr(raw.command, 100) : asStr(raw.type, 100));
const payloadOf = (raw) => (raw.payload && typeof raw.payload === "object" ? raw.payload : raw);

/**
 * 注册 fileTransfer:command。
 *
 * @param ipcMain Electron ipcMain（测试传假实现，只需 handle / removeHandler）。
 *
 * @param deps 装配参数对象：
 *   @param deps.bundle    createFileTransferBundle({ userDataDir, authorization, clock, logger })
 *                         的产物；缺失或没有 execute → 每次调用稳定回 FILE_TRANSFER_NOT_READY，
 *                         不注册半成品 handler。
 *   @param deps.identity  IdentityService（可选）：只读 identity.current 作为 sessionRef。
 *                         身份不从渲染层取，payload 里的 userId / owner 一律忽略。
 *   @param deps.isTrusted (event) => boolean：宿主 trusted 判据。**必须是函数**；缺失或返回假值
 *                         一律 throw Error("Forbidden")（fail closed）。
 *   @param deps.hostAppId 承载文件传输的 App Principal，默认 "file-transfer"。
 *
 * @returns {{ channel: string, dispose: () => void }}
 */
function registerFileTransferIpc(ipcMain, deps = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerFileTransferIpc 需要 ipcMain.handle");
  const { bundle = null, identity = null, isTrusted = null, hostAppId = "file-transfer" } = deps || {};
  const sessionRef = () => (identity && typeof identity === "object" ? identity.current || null : null);

  if (typeof ipcMain.removeHandler === "function") {
    try { ipcMain.removeHandler(FILE_TRANSFER_CHANNEL); } catch { /* 尚未注册 */ }
  }

  ipcMain.handle(FILE_TRANSFER_CHANNEL, async (event, raw) => {
    // 第一道：宿主信任判据（sender + senderFrame.url 双重条件，同 main.cjs trusted）。
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!bundle || typeof bundle.execute !== "function") {
      return { ok: false, error: FILE_TRANSFER_NOT_READY, message: "文件传输域尚未装配" };
    }
    if (!raw || typeof raw !== "object") {
      return domain.normalizeFileTransferError(domain.createFileTransferError(domain.FILE_TRANSFER_ERR_INVALID_INPUT, "fileTransfer:command 需要对象载荷"));
    }
    const command = commandOf(raw);
    if (!domain.isFileTransferCommand(command)) {
      return domain.normalizeFileTransferError(domain.fileTransferCommandNotAllowed(command));
    }
    const payload = payloadOf(raw) || {};
    return bundle.execute(command, payload, { sessionRef: sessionRef(), appId: hostAppId, requestId: asStr(payload.requestId, 100) });
  });

  return { channel: FILE_TRANSFER_CHANNEL, dispose: () => disposeFileTransferIpc(ipcMain) };
}

function disposeFileTransferIpc(ipcMain) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") {
    try { ipcMain.removeHandler(FILE_TRANSFER_CHANNEL); } catch { /* 忽略 */ }
  }
}

module.exports = { registerFileTransferIpc, disposeFileTransferIpc, FILE_TRANSFER_CHANNEL, FILE_TRANSFER_NOT_READY };
