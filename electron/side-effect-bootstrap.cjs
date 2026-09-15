/**
 * D4-03C4 · Trusted Approval Gateway（唯一入口）。
 *
 * 它是 Renderer ↔ OpenArc main process 之间**唯一**的 approval 通道。
 *
 * 信任边界（§13 / §43 / §44）：
 *   · Renderer 只能发送 { type, approvalRequestId, decision }；
 *   · sessionRef 由 main process 从 IdentityService 当前 authenticated session 注入，
 *     Renderer 自报的 userId / role / appId / sessionRef / risk / planHash / effectClass / argumentsHash
 *     一律忽略；
 *   · target / risk / expectedEffects / preconditions 全部由主进程从
 *     SideEffectCall + Tool Registry + Resource Domain 重新推导，绝不信任 Harness 文案或 Renderer 输入。
 */
"use strict";

const SIDE_EFFECT_COMMANDS = Object.freeze([
  "sideEffect/listPending",
  "sideEffect/getApprovalRequest",
  "sideEffect/decideApproval",
]);

/** Renderer 只允许提交的两个 decision。 */
const APPROVAL_ACTIONS = Object.freeze({ APPROVE: "APPROVE", DENY: "DENY" });

/** 安全 gateway：只暴露只读快照 + trusted decision。 */
function createSideEffectGateway({ sideEffectRuntime, onApprovalRequested = null } = {}) {
  if (!sideEffectRuntime) throw new Error("createSideEffectGateway 需要 SideEffectRuntime");
  if (typeof onApprovalRequested === "function") sideEffectRuntime.onApprovalRequested = onApprovalRequested;
  return {
    /** 供 main process 接线推送用；Renderer 永远拿不到这个对象。 */
    runtime: sideEffectRuntime,
    listPendingApprovals({ context = {} } = {}) { return sideEffectRuntime.listPendingApprovals({ context }); },
    getApprovalRequest({ context = {}, approvalRequestId } = {}) {
      const request = sideEffectRuntime.approvalSnapshot({ approvalRequestId, context });
      if (!request) return { ok: false, error: "SIDE_EFFECT_CALL_NOT_FOUND" };
      return { ok: true, request };
    },
    decideApproval({ context = {}, approvalRequestId, decision } = {}) {
      const act = String(decision || "").toUpperCase();
      if (act !== APPROVAL_ACTIONS.APPROVE && act !== APPROVAL_ACTIONS.DENY) return { ok: false, error: "INVALID_INPUT" };
      const res = sideEffectRuntime.decideApproval({ context, approvalRequestId, decision: act });
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || "SIDE_EFFECT_CALL_NOT_FOUND" };
      return { ok: true, approvalRequestId, decision: act, status: res.call ? res.call.status : null };
    },
  };
}

function registerSideEffectIpc({ ipcMain, service, identity, isTrusted, send = null }) {
  ipcMain.handle("sideeffect:command", async (e, command) => {
    if (isTrusted && !isTrusted(e)) throw Error("Forbidden");
    if (!service) return { ok: false, error: "INTERNAL_ERROR", detail: "side-effect-not-ready" };
    if (!command || typeof command !== "object") return { ok: false, error: "INVALID_INPUT" };
    const type = String(command.type || "");
    if (!SIDE_EFFECT_COMMANDS.includes(type)) return { ok: false, error: "INVALID_INPUT" };
    // trusted context：sessionRef 恒来自主进程当前会话；appId 由 SideEffectRuntime 从真实 Task 反推。
    const context = { sessionRef: (identity && identity.current) || null, source: "user", requestId: command.requestId };
    try {
      switch (type) {
        case "sideEffect/listPending": return service.listPendingApprovals({ context });
        case "sideEffect/getApprovalRequest": return service.getApprovalRequest({ context, approvalRequestId: command.approvalRequestId });
        case "sideEffect/decideApproval": return service.decideApproval({ context, approvalRequestId: command.approvalRequestId, decision: command.decision });
        default: return { ok: false, error: "INVALID_INPUT" };
      }
    } catch {
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  });
  void send;
}

module.exports = { SIDE_EFFECT_COMMANDS, APPROVAL_ACTIONS, createSideEffectGateway, registerSideEffectIpc };
