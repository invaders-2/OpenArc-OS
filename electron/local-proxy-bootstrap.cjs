/**
 * 本机代理探测 · IPC 引导（渲染层唯一入口 desktop:command）。
 *
 * 与 electron/platform-bootstrap.cjs:30-47 / media-bootstrap.cjs / device-bootstrap.cjs
 * 同一 trusted 边界：
 *   · isTrusted(event) 由宿主注入（main.cjs 的 trusted），未注入即判 Forbidden（fail closed）；
 *   · sessionRef / appId 一律由主进程推导，忽略渲染层自报的 payload.userId / role / appId；
 *   · 单条命令通道，不新增下行事件通道，不暴露 ipcRenderer。
 *
 * ---------------------------------------------------------------------------
 * 接线参数（由 Lead 在 main.cjs 统一做，本文件不改 main.cjs / preload.cjs）
 * ---------------------------------------------------------------------------
 *   const { createLocalProxyService } = require("./local-proxy-service.cjs");
 *   const { registerLocalProxyIpc } = require("./local-proxy-bootstrap.cjs");
 *
 *   const localProxy = createLocalProxyService({
 *     // 源 desktopConfigFile().proxyUrl || ''：主进程已有的桌面配置读取函数
 *     getConfiguredProxy: () => (desktopConfigFile().proxyUrl || ""),
 *     logger: (line) => { ... },        // 可选
 *   });
 *
 *   registerLocalProxyIpc({
 *     ipcMain,                          // Electron ipcMain
 *     service: localProxy,              // createLocalProxyService(...) 产物
 *     isTrusted: trusted,               // main.cjs 既有的 (event) => boolean；不传=全部拒绝
 *     identity,                         // IdentityService（可选）；只读 .current 作 sessionRef
 *     appId: "ai",                      // 承载 App Principal，与 platform-service HOST_APP_ID 一致
 *     // channel: "desktop:command",    // 默认即 desktop:command
 *   });
 *
 *   preload.cjs 追加（第 27 个顶层键，仅一条能力）：
 *     desktop: { command: (command) => ipcRenderer.invoke("desktop:command", command) },
 *
 *   src/types/openarc-ipc.d.ts 追加 desktop 桥声明（命令字面量 "desktop/proxy/detect"）。
 *
 * fail closed 契约：service 缺失 → { ok:false, error:"LOCAL_PROXY_NOT_READY" }；
 * 载荷非对象 → LOCAL_PROXY_INVALID_INPUT；未登记命令 → LOCAL_PROXY_COMMAND_NOT_ALLOWED。
 */
"use strict";

const localProxyDomain = require("./local-proxy-domain.cjs");

const LOCAL_PROXY_CHANNEL = "desktop:command";
const LOCAL_PROXY_NOT_READY = "LOCAL_PROXY_NOT_READY";
const asStr = (value, max = 100) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));

/**
 * 注册 desktop:command。
 * @param ipcMain   Electron ipcMain（测试传假实现，只需 handle / removeHandler）
 * @param service   createLocalProxyService(...) 产物；缺失返回稳定的 LOCAL_PROXY_NOT_READY
 * @param isTrusted (event) => boolean；缺失即拒绝全部调用（绝不默认放行）
 * @param identity  IdentityService（可选）：只读 identity.current 作为 sessionRef
 * @param appId     承载能力的 App Principal（默认 "ai"）
 * @param channel   命令通道名（默认 desktop:command）
 */
function registerLocalProxyIpc({ ipcMain, service, isTrusted = null, identity = null, appId = "ai", channel = LOCAL_PROXY_CHANNEL } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerLocalProxyIpc 需要 ipcMain.handle");
  const name = asStr(channel, 60) || LOCAL_PROXY_CHANNEL;
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler(name); } catch { /* 尚未注册 */ } }
  ipcMain.handle(name, async (event, raw) => {
    // 第一道：宿主信任判据（与 main.cjs trusted / platform-bootstrap.cjs:32 同一条边界）。
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!service || typeof service.execute !== "function") return { ok: false, error: LOCAL_PROXY_NOT_READY, message: "本机代理探测域尚未装配" };
    if (!raw || typeof raw !== "object") return localProxyDomain.normalizeLocalProxyError(localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INVALID_INPUT, "desktop:command 需要对象载荷"));
    const command = raw.command != null ? asStr(raw.command, 100) : asStr(raw.type, 100);
    if (!localProxyDomain.isLocalProxyCommand(command)) return localProxyDomain.normalizeLocalProxyError(localProxyDomain.localProxyCommandNotAllowed(command));
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    const context = {
      // sessionRef / appId 来自可信主进程；payload.userId / payload.role / payload.appId 一概忽略。
      sessionRef: identity && typeof identity === "object" ? identity.current || null : null,
      appId: asStr(appId, 60) || "ai",
      requestId: asStr(payload.requestId, 100),
    };
    return service.execute(command, payload, context);
  });
  return { channel: name, dispose: () => disposeLocalProxyIpc({ ipcMain, channel: name }) };
}

function disposeLocalProxyIpc({ ipcMain, channel = LOCAL_PROXY_CHANNEL } = {}) {
  const name = asStr(channel, 60) || LOCAL_PROXY_CHANNEL;
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler(name); } catch { /* 忽略 */ } }
}

module.exports = { registerLocalProxyIpc, disposeLocalProxyIpc, LOCAL_PROXY_CHANNEL, LOCAL_PROXY_NOT_READY };
