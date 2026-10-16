/**
 * PhotoCraft 域 IPC 引导：唯一渲染层入口 photocraft:command。
 *
 * 与 electron/file-transfer-bootstrap.cjs / canvas-bootstrap.cjs 同一 trusted 边界：
 *   · isTrusted(event) 由宿主注入（main.cjs 的 trusted）；未注入即判 Forbidden（fail closed），
 *     绝不默认放行；
 *   · sessionRef / appId 一律由主进程从可信身份推导，忽略渲染层自报的 userId / owner / appId；
 *   · 只注册一条命令通道，不新增下行事件通道，不暴露 ipcRenderer / 宿主路径；
 *   · 命令表 photocraft-domain.cjs:PHOTOCRAFT_COMMANDS 本身即白名单，未登记命令一律
 *     PHOTOCRAFT_COMMAND_NOT_ALLOWED。
 *
 * 本文件**不改** electron/main.cjs / electron/preload.cjs / src/types/openarc-ipc.d.ts；
 * 接线由 Lead 统一做，调用面即下方 registerPhotocraftIpc(ipcMain, deps)。
 */
"use strict";

const domain = require("./photocraft-domain.cjs");

const PHOTOCRAFT_CHANNEL = domain.PHOTOCRAFT_CHANNEL;
const PHOTOCRAFT_NOT_READY = domain.PHOTOCRAFT_ERR_NOT_READY;
const asStr = (value, max = 100) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));
const commandOf = (raw) => (raw.command != null ? asStr(raw.command, 100) : asStr(raw.type, 100));
const payloadOf = (raw) => (raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? raw.payload : raw);

/**
 * 注册 photocraft:command。
 *
 * @param ipcMain Electron ipcMain（测试传假实现，只需 handle / removeHandler）。
 * @param deps 装配参数对象：
 *   @param deps.bundle    createPhotocraftBundle({ userDataDir, identity, authorization, ... })
 *                         的产物；缺失或没有 execute → 每次调用稳定回 PHOTOCRAFT_NOT_READY，
 *                         不注册半成品 handler。
 *   @param deps.identity  IdentityService（可选）：只读 identity.current 作为 sessionRef。
 *                         身份不从渲染层取，payload 里的 userId / owner 一律忽略。
 *   @param deps.isTrusted (event) => boolean：宿主 trusted 判据。**必须是函数**；缺失或返回假值
 *                         一律 throw Error("Forbidden")（fail closed）。
 *   @param deps.hostAppId 承载 PhotoCraft 的 App Principal，默认 "photocraft"。
 *
 * @returns {{ channel: string, dispose: () => void }}
 */
function registerPhotocraftIpc(ipcMain, deps = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerPhotocraftIpc 需要 ipcMain.handle");
  const { bundle = null, identity = null, isTrusted = null, hostAppId = "photocraft" } = deps || {};
  const sessionRef = () => (identity && typeof identity === "object" ? identity.current || null : null);

  if (typeof ipcMain.removeHandler === "function") {
    try { ipcMain.removeHandler(PHOTOCRAFT_CHANNEL); } catch { /* 尚未注册 */ }
  }

  ipcMain.handle(PHOTOCRAFT_CHANNEL, async (event, raw) => {
    // 第一道：宿主信任判据（sender + senderFrame.url 双重条件，同 main.cjs trusted）。
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!bundle || typeof bundle.execute !== "function") {
      return { ok: false, error: PHOTOCRAFT_NOT_READY, message: "PhotoCraft 域尚未装配" };
    }
    if (!raw || typeof raw !== "object") {
      return domain.normalizePhotocraftError(domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_INVALID_INPUT, "photocraft:command 需要对象载荷"));
    }
    const command = commandOf(raw);
    if (!domain.isPhotocraftCommand(command)) {
      return domain.normalizePhotocraftError(domain.photocraftCommandNotAllowed(command));
    }
    const payload = payloadOf(raw) || {};
    return bundle.execute(command, payload, { sessionRef: sessionRef(), appId: hostAppId, requestId: asStr(payload.requestId, 100) });
  });

  return { channel: PHOTOCRAFT_CHANNEL, dispose: () => disposePhotocraftIpc(ipcMain) };
}

function disposePhotocraftIpc(ipcMain) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") {
    try { ipcMain.removeHandler(PHOTOCRAFT_CHANNEL); } catch { /* 忽略 */ }
  }
}

module.exports = { registerPhotocraftIpc, disposePhotocraftIpc, PHOTOCRAFT_CHANNEL, PHOTOCRAFT_NOT_READY };
