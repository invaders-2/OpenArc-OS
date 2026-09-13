/**
 * D3-03 · Device 装配 + IPC（与 identity-bootstrap / authorization-bootstrap 同一条接线）。
 *
 * 与 D3-02 的只读授权桥有一个**有意的区别**，必须显式写清楚：
 * 设备管理在 §49 里要求 Super Admin 能在 UI 里 Start Pairing / Disable / Enable / Revoke，
 * 所以这条桥包含**写操作**。安全性由三件事保证，而不是靠"桥里只有读"：
 *   ① sessionRef 不从命令里取，一律用 IdentityService 当前会话（渲染进程无法伪造身份，§35）；
 *   ② 每个动作在 DeviceService 里都过 SUPER_ADMIN + 动作授权（§13 §14 §51）；
 *   ③ 返回给渲染进程的对象恒为 publicDevice（§48），私钥 / 凭据 / pairing secret 从不出现。
 */
"use strict";

const { DeviceStore } = require("./device-store.cjs");
const { DeviceService } = require("./device-service.cjs");
const { DEVICE_ACTION } = require("./device-domain.cjs");

/**
 * 渲染进程可下发的设备命令**白名单**。
 * 新增能力必须在这里显式登记，并且安全回归探针会按字面量扫描这条通道。
 */
const RENDERER_COMMANDS = Object.freeze([
  "device/list",
  "device/get",
  "device/pairing.create",
  "device/pairing.list",
  "device/pairing.revoke",
  "device/disable",
  "device/enable",
  "device/revoke",
  "device/rename",
  "device/audit",
]);

function createDeviceBundle({ identityStore, authorization = null, logger = null, serviceIdentity = null } = {}) {
  if (!identityStore) throw new Error("createDeviceBundle 需要 identityStore");
  const deviceStore = new DeviceStore({ identity: identityStore });
  const deviceService = new DeviceService({ identity: identityStore, deviceStore, authService: authorization, logger, serviceIdentity });
  return { deviceService, deviceStore };
}

/**
 * 注册 device:command。
 *
 * 通道名必须是**字面量** —— 安全回归探针按字面量扫描 IPC 暴露面，
 * 用变量拼通道名会让新增通道逃过冻结清单（D2-02 security-surface 的既有口径）。
 */
function registerDeviceIpc({ ipcMain, service, identity, isTrusted }) {
  ipcMain.handle("device:command", async (e, command) => {
    if (isTrusted && !isTrusted(e)) throw Error("Forbidden");
    if (!service) return { ok: false, error: "INTERNAL_ERROR", detail: "device-not-ready" };
    if (!command || typeof command !== "object") return { ok: false, error: "INVALID_INPUT" };
    const type = String(command.type || "");
    if (!RENDERER_COMMANDS.includes(type)) return { ok: false, error: "INVALID_INPUT" };
    const context = { sessionRef: identity?.current ?? null, appId: command.appId ? String(command.appId) : "resource-library", source: "ui" };
    const deviceId = command.deviceId ? String(command.deviceId) : null;
    const requestId = command.requestId ? String(command.requestId) : null;
    try {
      switch (type) {
        case "device/list":
          return service.listDevices({ context });
        case "device/get":
          return service.getDevice({ context, deviceId });
        case "device/pairing.create":
          return service.createPairing({ context, ttlMs: command.ttlMs, departmentId: command.departmentId || null, requestId });
        case "device/pairing.list":
          return service.listPairings({ context });
        case "device/pairing.revoke":
          return service.revokePairing({ context, pairingId: command.pairingId, requestId });
        case "device/disable":
          return service.disableDevice({ context, deviceId, requestId });
        case "device/enable":
          return service.enableDevice({ context, deviceId, requestId });
        case "device/revoke":
          return service.revokeDevice({ context, deviceId, requestId });
        case "device/rename":
          return service.renameDevice({ context, deviceId, displayName: command.displayName, requestId });
        case "device/audit":
          return service.deviceAudit({ context, deviceId });
        default:
          return { ok: false, error: "INVALID_INPUT" };
      }
    } catch {
      // 任何异常都收敛成 INTERNAL_ERROR：异常文本可能夹带路径、SQL、参数值
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  });
}

module.exports = { createDeviceBundle, registerDeviceIpc, RENDERER_COMMANDS, DEVICE_ACTION };
