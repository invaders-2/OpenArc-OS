/**
 * B5a · 媒体 IPC 引导：唯一渲染层入口 media:command + 下行 media:event。
 *
 * 与 electron/skill-bootstrap.cjs:1-61 / agent-bootstrap.cjs / model-bootstrap.cjs / task-bootstrap.cjs
 * 同一 trusted 边界：
 *   · isTrusted(event) 由宿主注入（main.cjs 的 trusted），未注入即判 Forbidden（fail closed）；
 *   · sessionRef / appId 一律由主进程从可信身份推导，忽略渲染层自报的 userId / role / appId；
 *   · 事件体沿用 electron/dxos-foundation-events.cjs 的 P1 信封（channel/domain/kind/sequence/at/payload）。
 *
 * 导出 disposeMediaIpc：移除 handler，允许同一进程内重复注册（测试与热重载路径）。
 */
"use strict";

const mediaDomain = require("./media-domain.cjs");

const MEDIA_NOT_READY = "MEDIA_NOT_READY";
const asStr = (value, max = 100) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));

/** 把 bundle 的 P1 事件接到宿主 send（send 抛错不改变业务路径）。 */
function wireMediaEvents({ bundle, send } = {}) {
  if (!bundle || typeof send !== "function") return false;
  if (typeof bundle.setEventSink !== "function") return false;
  return bundle.setEventSink((event) => { try { send(event); } catch { /* 事件推送失败不改变业务结果 */ } });
}

/**
 * 注册 media:command。
 * @param ipcMain  Electron ipcMain（测试传假实现，只需 handle / removeHandler）
 * @param bundle   createMediaBundle(...) 产物；null 时返回稳定的 MEDIA_NOT_READY
 * @param send     (event) => void；有值时接线下行事件到 "media:event"
 * @param isTrusted (event) => boolean；缺失即拒绝全部调用（绝不默认放行）
 * @param identity  IdentityService（可选）：只读 identity.current 作为 sessionRef
 * @param hostAppId 承载媒体的 App Principal（默认 "ai"，与 media-service.cjs:47 一致）
 */
function registerMediaIpc({ ipcMain, bundle, send = null, isTrusted = null, identity = null, hostAppId = "ai" } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerMediaIpc 需要 ipcMain.handle");
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("media:command"); } catch { /* 尚未注册 */ } }
  if (typeof send === "function") wireMediaEvents({ bundle, send });
  ipcMain.handle("media:command", async (event, raw) => {
    // 第一道：宿主信任判据（sender + senderFrame.url 双重条件，同 main.cjs trusted）。
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!bundle || typeof bundle.execute !== "function") return { ok: false, error: MEDIA_NOT_READY, message: "媒体域尚未装配" };
    if (!raw || typeof raw !== "object") return mediaDomain.normalizeMediaError(mediaDomain.createMediaError(mediaDomain.MEDIA_ERR_INVALID_INPUT, "media:command 需要对象载荷"));
    const command = raw.command != null ? asStr(raw.command, 100) : asStr(raw.type, 100);
    if (!mediaDomain.isMediaCommand(command)) return mediaDomain.normalizeMediaError(mediaDomain.mediaCommandNotAllowed(command));
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    const context = {
      // sessionRef / appId 来自可信主进程；payload.userId / payload.role / payload.appId 一概忽略。
      sessionRef: identity && typeof identity === "object" ? identity.current || null : null,
      appId: hostAppId,
      requestId: asStr(payload.requestId, 100),
    };
    return bundle.execute(command, payload, context);
  });
  return { channel: "media:command", eventChannel: mediaDomain.MEDIA_EVENT_CHANNEL, dispose: () => disposeMediaIpc({ ipcMain }) };
}

function disposeMediaIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("media:command"); } catch { /* 忽略 */ } }
}

module.exports = { registerMediaIpc, disposeMediaIpc, wireMediaEvents, MEDIA_NOT_READY };
