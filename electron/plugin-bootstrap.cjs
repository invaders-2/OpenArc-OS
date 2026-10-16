/**
 * B7c · 可选插件 / 本地市场 IPC 引导：唯一渲染层入口 integration:command 与 market:command。
 *
 * 与 electron/platform-bootstrap.cjs:1-53 / automation-bootstrap.cjs / media-bootstrap.cjs
 * 同一 trusted 边界：
 *   · isTrusted(event) 由宿主注入（main.cjs 的 trusted），未注入即判 Forbidden（fail closed）；
 *   · sessionRef / appId 一律由主进程从可信身份推导，忽略渲染层自报的 userId / role / appId；
 *   · 只有两条命令通道，不新增下行事件通道，不暴露 ipcRenderer。
 *
 * 导出 dispose*：移除 handler，允许同一进程内重复注册（测试与热重载路径）。
 */
"use strict";

const INTEGRATION_NOT_READY = "INTEGRATION_NOT_READY";
const MARKET_NOT_READY = "MARKET_NOT_READY";
const asStr = (value, max = 100) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));

/**
 * 注册 integration:command。
 * @param ipcMain   Electron ipcMain（测试传假实现，只需 handle / removeHandler）
 * @param bundle    createPluginBundle(...) 产物；null 时返回稳定的 INTEGRATION_NOT_READY
 * @param isTrusted (event) => boolean；缺失即拒绝全部调用（绝不默认放行）
 * @param identity  IdentityService（可选）：只读 identity.current 作为 sessionRef
 * @param hostAppId 承载集成能力的 App Principal（默认 "ai"，与 plugin-service.cjs:34 一致）
 */
function registerIntegrationIpc({ ipcMain, bundle, isTrusted = null, identity = null, hostAppId = "ai" } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerIntegrationIpc 需要 ipcMain.handle");
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("integration:command"); } catch { /* 尚未注册 */ } }
  ipcMain.handle("integration:command", async (event, raw) => {
    // 第一道：宿主信任判据（sender + senderFrame.url 双重条件，同 main.cjs trusted）。
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!bundle || typeof bundle.execute !== "function") return { ok: false, error: INTEGRATION_NOT_READY, detail: "集成域尚未装配" };
    if (!raw || typeof raw !== "object") return { ok: false, error: "INTEGRATION_INVALID_INPUT", detail: "integration:command 需要对象载荷" };
    const command = raw.command != null ? asStr(raw.command, 100) : asStr(raw.type, 100);
    if (!bundle.isIntegrationCommand(command)) return { ok: false, error: "INTEGRATION_COMMAND_NOT_ALLOWED", detail: "未知或未授权的 integration 命令：" + String(command == null ? "" : command) };
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    const context = {
      // sessionRef / appId 来自可信主进程；payload.userId / payload.role / payload.appId 一概忽略。
      sessionRef: identity && typeof identity === "object" ? identity.current || null : null,
      appId: hostAppId,
      requestId: asStr(payload.requestId, 100),
    };
    return bundle.execute(command, payload, context);
  });
  return { channel: "integration:command", dispose: () => disposeIntegrationIpc({ ipcMain }) };
}

/**
 * 注册 market:command（本地市场目录；不联网、不下载）。
 * @param bundle createMarketBundle(...) 产物；null 时返回稳定的 MARKET_NOT_READY
 */
function registerMarketIpc({ ipcMain, bundle, isTrusted = null, identity = null, hostAppId = "market-center" } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerMarketIpc 需要 ipcMain.handle");
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("market:command"); } catch { /* 尚未注册 */ } }
  ipcMain.handle("market:command", async (event, raw) => {
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!bundle || typeof bundle.execute !== "function") return { ok: false, error: MARKET_NOT_READY, detail: "本地市场尚未装配" };
    if (!raw || typeof raw !== "object") return { ok: false, error: "MARKET_INVALID_INPUT", detail: "market:command 需要对象载荷" };
    const command = raw.command != null ? asStr(raw.command, 100) : asStr(raw.type, 100);
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    const context = {
      sessionRef: identity && typeof identity === "object" ? identity.current || null : null,
      appId: hostAppId,
      requestId: asStr(payload.requestId, 100),
    };
    return bundle.execute(command, payload, context);
  });
  return { channel: "market:command", dispose: () => disposeMarketIpc({ ipcMain }) };
}

function disposeIntegrationIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("integration:command"); } catch { /* 忽略 */ } }
}
function disposeMarketIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("market:command"); } catch { /* 忽略 */ } }
}

module.exports = { registerIntegrationIpc, registerMarketIpc, disposeIntegrationIpc, disposeMarketIpc, INTEGRATION_NOT_READY, MARKET_NOT_READY };
