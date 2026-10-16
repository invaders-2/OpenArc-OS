/**
 * B6a · 自动化 IPC 引导：唯一渲染层入口 automation:command + 下行 automation:event。
 *
 * 与 electron/skill-bootstrap.cjs:1-61 / media-bootstrap.cjs:1-62 / agent-bootstrap.cjs
 * 同一 trusted 边界：
 *   · isTrusted(event) 由宿主注入（main.cjs 的 trusted），未注入即判 Forbidden（fail closed）；
 *   · sessionRef / appId 一律由主进程从可信身份推导，忽略渲染层自报的 userId / role / appId；
 *   · 事件体沿用 electron/dxos-foundation-events.cjs 的 P1 信封（channel/domain/kind/sequence/at/payload）。
 *
 * 导出 disposeAutomationIpc：移除 handler，允许同一进程内重复注册（测试与热重载路径）。
 */
"use strict";

const automationDomain = require("./automation-domain.cjs");

const AUTOMATION_NOT_READY = "AUTOMATION_NOT_READY";
const asStr = (value, max = 100) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));

/** 把 bundle 的 P1 事件接到宿主 send（send 抛错不改变业务路径）。 */
function wireAutomationEvents({ bundle, send } = {}) {
  if (!bundle || typeof send !== "function") return false;
  if (typeof bundle.setEventSink !== "function") return false;
  return bundle.setEventSink((event) => { try { send(event); } catch { /* 事件推送失败不改变业务结果 */ } });
}

/**
 * 注册 automation:command。
 * @param ipcMain  Electron ipcMain（测试传假实现，只需 handle / removeHandler）
 * @param bundle   createAutomationBundle(...) 产物；null 时返回稳定的 AUTOMATION_NOT_READY
 * @param send     (event) => void；有值时接线下行事件到 "automation:event"
 * @param isTrusted (event) => boolean；缺失即拒绝全部调用（绝不默认放行）
 * @param identity  IdentityService（可选）：只读 identity.current 作为 sessionRef
 * @param hostAppId 承载自动化的 App Principal（默认 "ai"，与 automation-service.cjs:38 一致）
 */
function registerAutomationIpc({ ipcMain, bundle, send = null, isTrusted = null, identity = null, hostAppId = "ai" } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerAutomationIpc 需要 ipcMain.handle");
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("automation:command"); } catch { /* 尚未注册 */ } }
  if (typeof send === "function") wireAutomationEvents({ bundle, send });
  ipcMain.handle("automation:command", async (event, raw) => {
    // 第一道：宿主信任判据（sender + senderFrame.url 双重条件，同 main.cjs trusted）。
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!bundle || typeof bundle.execute !== "function") return { ok: false, error: AUTOMATION_NOT_READY, message: "自动化域尚未装配" };
    if (!raw || typeof raw !== "object") return automationDomain.normalizeAutomationError(automationDomain.createAutomationError(automationDomain.AUTOMATION_ERR_INVALID_INPUT, "automation:command 需要对象载荷"));
    const command = raw.command != null ? asStr(raw.command, 100) : asStr(raw.type, 100);
    if (!automationDomain.isAutomationCommand(command)) return automationDomain.normalizeAutomationError(automationDomain.automationCommandNotAllowed(command));
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    const context = {
      // sessionRef / appId 来自可信主进程；payload.userId / payload.role / payload.appId 一概忽略。
      sessionRef: identity && typeof identity === "object" ? identity.current || null : null,
      appId: hostAppId,
      requestId: asStr(payload.requestId, 100),
    };
    return bundle.execute(command, payload, context);
  });
  return { channel: "automation:command", eventChannel: automationDomain.AUTOMATION_EVENT_CHANNEL, dispose: () => disposeAutomationIpc({ ipcMain }) };
}

function disposeAutomationIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("automation:command"); } catch { /* 忽略 */ } }
}

module.exports = { registerAutomationIpc, disposeAutomationIpc, wireAutomationEvents, AUTOMATION_NOT_READY };
