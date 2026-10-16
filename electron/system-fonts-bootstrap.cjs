/**
 * DX OS 0.6.1 · 系统字体域 IPC 引导：唯一渲染层入口 systemFonts:command + 下行 systemFonts:event。
 *
 * 与 electron/platform-bootstrap.cjs:1-51 / media-bootstrap.cjs / device-bootstrap.cjs 同一条 trusted 边界：
 *   · isTrusted(event) 由宿主注入（main.cjs 的 trusted），未注入即 Forbidden（fail closed）；
 *   · sessionRef / appId 一律由主进程从可信身份推导，忽略渲染层自报的 userId / role / appId；
 *   · 通道名是字面量（安全回归探针按字面量扫描 IPC 暴露面），不做变量拼通道名。
 *
 * 源对照：server/systemFonts.ts:115-120 的两条 HTTP 路由
 *   GET /api/system/fonts        → systemFonts/list   （registry.list）
 *   GET /api/system/fonts/:id    → systemFonts/read   （:118 id 正则，registry.read）
 *
 * 导出 disposeSystemFontsIpc：移除 handler，允许同一进程内重复注册（测试与热重载路径）。
 *
 * 【接线参数签名】（main.cjs / preload.cjs 由 Lead 统一接线，本文件不动那两处）
 *   bundle = createSystemFontsBundle({
 *     roots = systemFontDirectories(),  // 可选：字体根目录；显式传 [] 即不扫描任何目录
 *     io = node:fs/promises 适配器,      // 可选：realpath / readdir / stat / open（测试注入受控实现）
 *     maxBytes = 64 MiB,                 // 可选：单字体字节上限（源 systemFonts.ts:8）
 *     cacheTtlMs = 300000,               // 可选：目录清单缓存 TTL（源 :69）
 *     now, maxScanDepth, maxScanEntries, // 可选：时钟与扫描边界（源 :72-73）
 *     onEvent,                           // 可选：(event) => void，等价于随后 setEventSink
 *   })
 *   registerSystemFontsIpc(ipcMain, { bundle, isTrusted, identity, send, hostAppId })   // 也支持 { ipcMain, ... } 形式
 *     · isTrusted 必填（生产传 main.cjs 的 trusted）：缺失即 Forbidden（fail closed）
 *     · send      可选：(event) => void，宿主负责 webContents 存活判定后 send "systemFonts:event"
 *     · identity  可选：只读 identity.current 作为 context.sessionRef（仅审计，不据此鉴权）
 *     · hostAppId 可选：默认 "ai"
 *   返回 { channel: "systemFonts:command", eventChannel: "systemFonts:event", dispose }
 *   disposeSystemFontsIpc({ ipcMain }) | disposeSystemFontsIpc(ipcMain)
 *   wireSystemFontsEvents({ service, send })
 */
"use strict";

const domain = require("./system-fonts-domain.cjs");
const { createSystemFontsService } = require("./system-fonts-service.cjs");

const SYSTEM_FONTS_NOT_READY = "SYSTEM_FONTS_NOT_READY";
const asStr = (value, max = 100) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));

/** 把 service 的 P1 事件信封接到宿主 send（send 抛错不改变业务路径）。 */
function wireSystemFontsEvents({ service, send } = {}) {
  if (!service || typeof service.setEventSink !== "function" || typeof send !== "function") return false;
  return service.setEventSink((event) => { try { send(event); } catch { /* 事件推送失败不改变业务结果 */ } });
}

/** 装配字体域（默认读本机三平台字体目录；可注入 roots / io / maxBytes 供测试与宿主覆写）。 */
function createSystemFontsBundle(options = {}) {
  const service = createSystemFontsService(options);
  if (typeof options.onEvent === "function") service.setEventSink(options.onEvent);

  async function execute(command, payload, context = {}) {
    const body = payload && typeof payload === "object" ? payload : {};
    switch (command) {
      case "systemFonts/list":
        return domain.toSystemFontsIpcResult(() => service.listFonts({ limit: body.limit, offset: body.offset, refresh: body.refresh === true }));
      case "systemFonts/read":
        return domain.toSystemFontsIpcResult(() => service.readFont(body.id));
      default:
        return domain.normalizeSystemFontsError(domain.systemFontsCommandNotAllowed(command));
    }
  }

  return { service, execute, setEventSink: service.setEventSink };
}

/**
 * 注册 systemFonts:command。
 *
 * @param ipcMain Electron ipcMain（测试传假实现，只需 handle / removeHandler）
 * @param deps    { bundle, isTrusted, identity, send, hostAppId }
 *   · bundle    createSystemFontsBundle(...) 产物；null / 非对象 → 稳定的 SYSTEM_FONTS_NOT_READY
 *   · isTrusted (event) => boolean；缺失即拒绝全部调用（绝不默认放行）
 *   · identity  IdentityService（可选）：只读 identity.current 作为 sessionRef（字体域不据此鉴权，仅审计）
 *   · send      (event) => void；有值时把 service 事件接到 systemFonts:event（宿主负责 webContents 存活判定）
 *   · hostAppId 承载字体域的 App Principal（默认 "ai"）
 */
function registerSystemFontsIpc(ipcMainOrOptions, maybeOptions) {
  const options = ipcMainOrOptions && typeof ipcMainOrOptions.handle === "function"
    ? Object.assign({}, maybeOptions || {}, { ipcMain: ipcMainOrOptions })
    : (ipcMainOrOptions || {});
  const { ipcMain, bundle, isTrusted = null, identity = null, send = null, hostAppId = "ai" } = options;
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerSystemFontsIpc 需要 ipcMain.handle");
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler(domain.SYSTEM_FONTS_COMMAND_CHANNEL); } catch { /* 尚未注册 */ } }
  if (typeof send === "function") wireSystemFontsEvents({ service: bundle && bundle.service, send });

  ipcMain.handle(domain.SYSTEM_FONTS_COMMAND_CHANNEL, async (event, raw) => {
    // 第一道：宿主信任判据（sender + senderFrame.url 双重条件，同 main.cjs trusted）。
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!bundle || typeof bundle.execute !== "function") return { ok: false, error: SYSTEM_FONTS_NOT_READY, message: "字体域尚未装配" };
    if (!raw || typeof raw !== "object") return domain.normalizeSystemFontsError(domain.createSystemFontsError(domain.SYSTEM_FONTS_ERR_INVALID_INPUT, "systemFonts:command 需要对象载荷"));
    const command = raw.command != null ? asStr(raw.command, 100) : asStr(raw.type, 100);
    if (!domain.isSystemFontsCommand(command)) return domain.normalizeSystemFontsError(domain.systemFontsCommandNotAllowed(command));
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    const context = {
      // sessionRef / appId 来自可信主进程；payload.userId / payload.role / payload.appId 一概忽略。
      sessionRef: identity && typeof identity === "object" ? identity.current || null : null,
      appId: hostAppId,
      requestId: asStr(payload.requestId, 100),
    };
    return bundle.execute(command, payload, context);
  });

  return {
    channel: domain.SYSTEM_FONTS_COMMAND_CHANNEL,
    eventChannel: domain.SYSTEM_FONTS_EVENT_CHANNEL,
    dispose: () => disposeSystemFontsIpc({ ipcMain }),
  };
}

function disposeSystemFontsIpc(arg) {
  const ipcMain = arg && typeof arg.handle === "function" ? arg : (arg || {}).ipcMain;
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler(domain.SYSTEM_FONTS_COMMAND_CHANNEL); } catch { /* 忽略 */ } }
}

module.exports = {
  registerSystemFontsIpc,
  disposeSystemFontsIpc,
  wireSystemFontsEvents,
  createSystemFontsBundle,
  SYSTEM_FONTS_NOT_READY,
};
