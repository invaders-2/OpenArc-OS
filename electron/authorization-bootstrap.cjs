/**
 * D3-02 · Authorization 装配 + IPC（与 identity-bootstrap 同一条接线）。
 *
 * 产品主进程与 UI 探针共用这一份实现，保证"验证过的线"与"产品跑的线"是同一条。
 * 渲染进程**只能下发只读查询**：authorize / capabilities / resource / resolve /
 * notification / list / search。治理写操作（grant / revoke）不在 renderer 桥里，
 * 它们由主进程服务层（以及未来的管理端）调用（§78）。
 */
"use strict";

const { AuthorizationStore } = require("./authorization-store.cjs");
const { AuthorizationService } = require("./authorization-service.cjs");

function createAuthorizationService({ identityStore, logger } = {}) {
  if (!identityStore) throw new Error("createAuthorizationService 需要 identityStore");
  const authStore = new AuthorizationStore({ identity: identityStore });
  const authorization = new AuthorizationService({ identity: identityStore, authStore, logger });
  return { authorization, authStore };
}

/** 渲染进程可下发的只读授权命令。**白名单**，新增能力必须显式登记。 */
const RENDERER_COMMANDS = Object.freeze([
  "authorization/authorize",
  "authorization/capabilities",
  "authorization/resource",
  "authorization/resolve",
  "authorization/notification",
  "authorization/list",
  "authorization/search",
]);

/**
 * 注册 authorization:command。
 *
 * sessionRef **不从命令里取**，而是用 IdentityService 当前持有的 session ——
 * 渲染进程无法伪造/提升自己的会话身份（§35）。
 */
function registerAuthorizationIpc({ ipcMain, service, identity, isTrusted }) {
  // 通道名必须是**字面量**：安全回归探针按字面量扫描 IPC 暴露面，
  // 用变量拼通道名会让新增通道逃过冻结清单（D2-02 security-surface）。
  ipcMain.handle("authorization:command", async (e, command) => {
    if (isTrusted && !isTrusted(e)) throw Error("Forbidden");
    if (!service) return { ok: false, error: "INTERNAL_ERROR", detail: "authorization-not-ready" };
    if (!command || typeof command !== "object") return { ok: false, error: "INVALID_INPUT" };
    const type = String(command.type || "");
    if (!RENDERER_COMMANDS.includes(type)) return { ok: false, error: "INVALID_INPUT" };
    const context = {
      sessionRef: identity?.current ?? null,
      appId: command.appId ? String(command.appId) : "resource-library",
      source: "ui",
      requestId: command.requestId,
      agentSessionId: command.agentSessionId || null,
    };
    const resource = command.resourceRef || command.resourceId;
    try {
      switch (type) {
        case "authorization/authorize":
          return service.authorize({ context, action: command.action, resource });
        case "authorization/capabilities":
          return service.getCapabilities({ context, resource });
        case "authorization/resource":
          return service.getResource({ context, resource });
        case "authorization/resolve":
          return service.resolveResourceRef({ context, resource });
        case "authorization/notification":
          return service.notificationReauthorize({ context, resource });
        case "authorization/list":
          return service.listAuthorizedResources({ context, action: command.action, filter: command.filter });
        case "authorization/search":
          return service.searchAuthorizedResources({ context, query: command.query, action: command.action, filter: command.filter });
        default:
          return { ok: false, error: "INVALID_INPUT" };
      }
    } catch {
      // 异常文本可能夹带路径 / SQL / 参数值，一律收敛（§78）。
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  });
}

module.exports = { createAuthorizationService, registerAuthorizationIpc, RENDERER_COMMANDS };
