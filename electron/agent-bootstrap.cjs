"use strict";
/**
 * B3 · Agent IPC 引导：唯一渲染层入口 agent:command + 下行 agent:event。
 *
 * 与 electron/model-bootstrap.cjs:96-110 / task-bootstrap.cjs:108-118 同一 trusted 边界：
 *   · trusted(event) 由宿主注入（main.cjs 的 trusted），未注入即判 Forbidden（fail closed）；
 *   · sessionRef / appId 一律由主进程从可信身份推导，忽略渲染层自报的 userId / role / appId；
 *   · 事件体沿用 electron/dxos-foundation-events.cjs 的 P1 信封（channel/domain/kind/sequence/at/payload）。
 *
 * 导出 disposeAgentIpc：移除 handler，允许同一进程内重复注册（测试与热重载路径）。
 */
const agentDomain = require("./agent-domain.cjs");

const AGENT_NOT_READY = "AGENT_NOT_READY";
const asStr = (value, max = 80) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));

/** 把 bundle 的 P1 事件接到宿主 send（已封装；send 抛错不改变业务路径）。 */
function wireAgentEvents({ bundle, send } = {}) {
  if (!bundle || typeof send !== "function") return false;
  if (typeof bundle.setEventSink !== "function") return false;
  return bundle.setEventSink((event) => { try { send(event); } catch { /* 事件推送失败不改变业务结果 */ } });
}

/**
 * 注册 agent:command。
 * @param ipcMain  Electron ipcMain（测试传假实现，只需 handle / removeHandler）
 * @param bundle   createAgentBundle(...) 产物；null 时返回稳定的 AGENT_NOT_READY
 * @param send     (event) => void；有值时接线下行事件到 "agent:event"
 * @param isTrusted (event) => boolean；缺失即拒绝全部调用（绝不默认放行）
 * @param identity  IdentityService（可选）：只读 identity.current 作为 sessionRef
 * @param hostAppId 承载 Agent 的 App Principal（默认 "ai"）
 */
function registerAgentIpc({ ipcMain, bundle, send = null, isTrusted = null, identity = null, hostAppId = "ai" } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerAgentIpc 需要 ipcMain.handle");
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("agent:command"); } catch { /* 尚未注册 */ } }
  if (typeof send === "function") wireAgentEvents({ bundle, send });
  ipcMain.handle("agent:command", async (event, raw) => {
    // 第一道：宿主信任判据（sender + senderFrame.url 双重条件，同 main.cjs trusted）。
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!bundle || typeof bundle.execute !== "function") return { ok: false, error: AGENT_NOT_READY, message: "Agent 域尚未装配" };
    if (!raw || typeof raw !== "object") return agentDomain.normalizeAgentError(agentDomain.createAgentError(agentDomain.AGENT_ERR_INVALID_INPUT, "agent:command 需要对象载荷"));
    const command = raw.command != null ? asStr(raw.command, 80) : asStr(raw.type, 80);
    if (!agentDomain.isAgentCommand(command)) return agentDomain.normalizeAgentError(agentDomain.agentCommandNotAllowed(command));
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    const context = {
      // sessionRef / appId 来自可信主进程；payload.userId / payload.role / payload.appId 一概忽略。
      sessionRef: identity && typeof identity === "object" ? identity.current || null : null,
      appId: hostAppId,
      requestId: asStr(payload.requestId, 80),
    };
    return bundle.execute(command, payload, context);
  });
  return { channel: "agent:command", eventChannel: agentDomain.AGENT_EVENT_CHANNEL, dispose: () => disposeAgentIpc({ ipcMain }) };
}

function disposeAgentIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("agent:command"); } catch { /* 忽略 */ } }
}

module.exports = { registerAgentIpc, disposeAgentIpc, wireAgentEvents, AGENT_NOT_READY };
