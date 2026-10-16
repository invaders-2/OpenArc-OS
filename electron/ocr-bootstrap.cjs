/**
 * DX OS 0.6.1 · OCR IPC 引导：唯一渲染层入口 ocr:command + 下行 ocr:event。
 *
 * 与 electron/media-bootstrap.cjs:1-61 同一 trusted 边界：
 *   · isTrusted(event) 由宿主注入（main.cjs 的 trusted），未注入即判 Forbidden（fail closed）；
 *   · sessionRef 一律由主进程从可信身份推导，忽略渲染层自报的 userId / role / appId；
 *   · 事件体沿用 electron/dxos-foundation-events.cjs 的 P1 信封（channel/domain/kind/sequence/at/payload）。
 *
 * 源：server/ocrRoutes.ts:9 registerOcrRoutes(app, authorize, recognize) —— 移植侧把
 * 路由与鉴权换成 IPC 命令总线，命令表与执行在 ocr-domain.cjs / ocr-service.cjs。
 *
 * 【接线参数签名】（main.cjs 由 Lead 统一接线，本文件不动 main.cjs / preload.cjs）
 *   registerOcrIpc({
 *     ipcMain,                                   // 必填：Electron ipcMain（需 handle / 可选 removeHandler）
 *     bundle,                                    // 必填：createOcrBundle(...) 产物；null 时回 OCR_NOT_READY
 *     send = null,                               // 可选：(event) => void；有值时接 bundle.setEventSink 到 "ocr:event"
 *     isTrusted = null,                          // 必填（生产）：(event) => boolean；缺省拒绝全部调用
 *     identity = null,                           // 可选：IdentityService；只读 identity.current 作为 sessionRef
 *   })
 *   返回 { channel: "ocr:command", eventChannel: "ocr:event", dispose }
 *   disposeOcrIpc({ ipcMain })                   // 移除 handler，可重复注册（测试/热重载）
 *   wireOcrEvents({ bundle, send })              // 只接事件通道
 *
 * providerStore 由 main.cjs 的 providerProtocol.store 注入 createOcrBundle；
 * 用户在「系统设置 › 模型与服务商」里创建的 paddleocr-vl 供应商即被 ocr:command 消费。
 */
"use strict";

const ocrDomain = require("./ocr-domain.cjs");

const OCR_NOT_READY = "OCR_NOT_READY";
const asStr = (value, max = 100) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));

/** 把 bundle 的 P1 事件接到宿主 send（send 抛错不改变业务路径）。 */
function wireOcrEvents({ bundle, send } = {}) {
  if (!bundle || typeof send !== "function") return false;
  if (typeof bundle.setEventSink !== "function") return false;
  return bundle.setEventSink((event) => {
    try {
      send(event);
    } catch {
      /* 事件推送失败不改变业务结果 */
    }
  });
}

/**
 * 注册 ocr:command。
 * @param ipcMain  Electron ipcMain（测试传假实现，只需 handle / removeHandler）
 * @param bundle   createOcrBundle(...) 产物；null 时返回稳定的 OCR_NOT_READY
 * @param send     (event) => void；有值时接线下行事件到 "ocr:event"
 * @param isTrusted (event) => boolean；缺失即拒绝全部调用（绝不默认放行）
 * @param identity  IdentityService（可选）：只读 identity.current 作为 sessionRef
 */
function registerOcrIpc({ ipcMain, bundle, send = null, isTrusted = null, identity = null } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerOcrIpc 需要 ipcMain.handle");
  if (typeof ipcMain.removeHandler === "function") {
    try {
      ipcMain.removeHandler("ocr:command");
    } catch {
      /* 尚未注册 */
    }
  }
  if (typeof send === "function") wireOcrEvents({ bundle, send });
  ipcMain.handle("ocr:command", async (event, raw) => {
    // 第一道：宿主信任判据（sender + senderFrame.url 双重条件，同 main.cjs trusted）。
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!bundle || typeof bundle.execute !== "function") return { ok: false, error: OCR_NOT_READY, message: "OCR 域尚未装配" };
    if (!raw || typeof raw !== "object") return ocrDomain.normalizeOcrError(ocrDomain.createOcrError(ocrDomain.OCR_ERR_INVALID_INPUT, "ocr:command 需要对象载荷"));
    const command = raw.command != null ? asStr(raw.command, 100) : asStr(raw.type, 100);
    if (!ocrDomain.isOcrCommand(command)) return ocrDomain.normalizeOcrError(ocrDomain.ocrCommandNotAllowed(command));
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    const context = {
      // sessionRef 来自可信主进程；payload.userId / payload.role / payload.appId 一概忽略。
      sessionRef: identity && typeof identity === "object" ? identity.current || null : null,
      requestId: asStr(payload.requestId, 100),
    };
    return bundle.execute(command, payload, context);
  });
  return { channel: "ocr:command", eventChannel: ocrDomain.OCR_EVENT_CHANNEL, dispose: () => disposeOcrIpc({ ipcMain }) };
}

function disposeOcrIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") {
    try {
      ipcMain.removeHandler("ocr:command");
    } catch {
      /* 忽略 */
    }
  }
}

module.exports = { registerOcrIpc, disposeOcrIpc, wireOcrEvents, OCR_NOT_READY };
