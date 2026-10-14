/**
 * B6c · 平台域 IPC 引导：唯一渲染层入口 platform:command。
 *
 * 与 electron/media-bootstrap.cjs:1-62 / skill-bootstrap.cjs / agent-bootstrap.cjs / task-bootstrap.cjs
 * 同一 trusted 边界：
 *   · isTrusted(event) 由宿主注入（main.cjs 的 trusted），未注入即判 Forbidden（fail closed）；
 *   · sessionRef / appId 一律由主进程从可信身份推导，忽略渲染层自报的 userId / role / appId；
 *   · 本批只有一条命令通道（platform:command），不新增下行事件通道，不暴露 ipcRenderer。
 *
 * 导出 disposePlatformIpc：移除 handler，允许同一进程内重复注册（测试与热重载路径）。
 */
"use strict";

const platformDomain = require("./platform-domain.cjs");

const PLATFORM_NOT_READY = "PLATFORM_NOT_READY";
const asStr = (value, max = 100) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));

/**
 * 注册 platform:command。
 * @param ipcMain   Electron ipcMain（测试传假实现，只需 handle / removeHandler）
 * @param bundle    createPlatformBundle(...) 产物；null 时返回稳定的 PLATFORM_NOT_READY
 * @param isTrusted (event) => boolean；缺失即拒绝全部调用（绝不默认放行）
 * @param identity  IdentityService（可选）：只读 identity.current 作为 sessionRef
 * @param hostAppId 承载平台能力的 App Principal（默认 "ai"，与 platform-service.cjs:47 一致）
 */
function registerPlatformIpc({ ipcMain, bundle, isTrusted = null, identity = null, hostAppId = "ai" } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerPlatformIpc 需要 ipcMain.handle");
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("platform:command"); } catch { /* 尚未注册 */ } }
  ipcMain.handle("platform:command", async (event, raw) => {
    // 第一道：宿主信任判据（sender + senderFrame.url 双重条件，同 main.cjs trusted）。
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!bundle || typeof bundle.execute !== "function") return { ok: false, error: PLATFORM_NOT_READY, message: "平台域尚未装配" };
    if (!raw || typeof raw !== "object") return platformDomain.normalizePlatformError(platformDomain.createPlatformError(platformDomain.PLATFORM_ERR_INVALID_INPUT, "platform:command 需要对象载荷"));
    const command = raw.command != null ? asStr(raw.command, 100) : asStr(raw.type, 100);
    if (!platformDomain.isPlatformCommand(command)) return platformDomain.normalizePlatformError(platformDomain.platformCommandNotAllowed(command));
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    const context = {
      // sessionRef / appId 来自可信主进程；payload.userId / payload.role / payload.appId 一概忽略。
      sessionRef: identity && typeof identity === "object" ? identity.current || null : null,
      appId: hostAppId,
      requestId: asStr(payload.requestId, 100),
    };
    return bundle.execute(command, payload, context);
  });
  return { channel: "platform:command", dispose: () => disposePlatformIpc({ ipcMain }) };
}

function disposePlatformIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("platform:command"); } catch { /* 忽略 */ } }
}

module.exports = { registerPlatformIpc, disposePlatformIpc, PLATFORM_NOT_READY };
