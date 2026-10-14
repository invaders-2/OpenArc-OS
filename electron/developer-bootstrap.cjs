/**
 * B7a/B7f · 开发者平台 IPC 引导：唯一渲染层入口 developer:command。
 *
 * 与 electron/platform-bootstrap.cjs:1-53 / media-bootstrap.cjs / skill-bootstrap.cjs 同一 trusted 边界：
 *   · isTrusted(event) 由宿主注入（main.cjs 的 trusted），未注入即判 Forbidden（fail closed）；
 *   · sessionRef / appId 一律由主进程从可信身份推导，忽略渲染层自报的 userId / role / appId；
 *   · 本批只有一条命令通道（developer:command），不新增下行事件通道，不暴露 ipcRenderer；
 *   · 命令表（electron/developer-domain.cjs:DEVELOPER_COMMANDS）本身即白名单，未登记命令一律
 *     DEVELOPER_COMMAND_NOT_ALLOWED。
 *
 * B7f 合流：白名单已在 developer-domain.cjs 合并 B7b 的 lab / collab / migrations / realtime
 * （16 + 54 = 70 条）。这里用 developer-lab.cjs 的 combineDeveloperCommandHandlers（即
 * createDeveloperDomainExtensions(...).combine(...) 的同一实现）把 B7b 四切片接到唯一
 * developer:command：扩展 registry 命中即交给切片，未命中回落 B7a 基座 bundle.execute。
 * hostAppId 固定 "ai"，与 developer-service.cjs:43 的 HOST_APP_ID 一致。
 *
 * 导出 disposeDeveloperIpc：移除 handler，允许同一进程内重复注册（测试与热重载路径）。
 */
"use strict";

const developerDomain = require("./developer-domain.cjs");
const { combineDeveloperCommandHandlers } = require("./developer-lab.cjs");

const DEVELOPER_NOT_READY = "DEVELOPER_NOT_READY";
const asStr = (value, max = 100) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));
const commandOf = (raw) => (raw.command != null ? asStr(raw.command, 100) : asStr(raw.type, 100));
const payloadOf = (raw) => (raw.payload && typeof raw.payload === "object" ? raw.payload : raw);

/**
 * 注册 developer:command。
 * @param ipcMain   Electron ipcMain（测试传假实现，只需 handle / removeHandler）
 * @param bundle    createDeveloperBundle(...) 产物；null 时返回稳定的 DEVELOPER_NOT_READY
 * @param domainExtensions  createDeveloperDomainExtensions(...) 产物（可选）：
 *        提供时其 .combine(...) 负责 B7b 四切片分发，未提供时只有 B7a 基座。
 * @param isTrusted (event) => boolean；缺失即拒绝全部调用（绝不默认放行）
 * @param identity  IdentityService（可选）：只读 identity.current 作为 sessionRef
 * @param hostAppId 承载开发者能力的 App Principal（默认 "ai"，与 developer-service.cjs:43 一致）
 */
function registerDeveloperIpc({ ipcMain, bundle, domainExtensions = null, isTrusted = null, identity = null, hostAppId = "ai" } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerDeveloperIpc 需要 ipcMain.handle");
  const ext = domainExtensions && typeof domainExtensions.combine === "function" ? domainExtensions : null;
  const owned = new Set(ext && Array.isArray(ext.commandNames) ? ext.commandNames : []);
  const sessionRef = () => (identity && typeof identity === "object" ? identity.current || null : null);

  // B7a 基座：认证 / 数据库可用性 / 分发都在 developer-service.cjs（不在这里复制第二套）。
  const base = (event, raw) => {
    const payload = payloadOf(raw);
    return bundle.execute(commandOf(raw), payload, { sessionRef: sessionRef(), appId: hostAppId, requestId: asStr(payload.requestId, 100) });
  };
  const combined = ext ? ext.combine({ base, identity, isTrusted, hostAppId }) : null;

  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("developer:command"); } catch { /* 尚未注册 */ } }
  ipcMain.handle("developer:command", async (event, raw) => {
    // 第一道：宿主信任判据（sender + senderFrame.url 双重条件，同 main.cjs trusted）。
    if (typeof isTrusted !== "function" || !isTrusted(event)) throw Error("Forbidden");
    if (!bundle || typeof bundle.execute !== "function") return { ok: false, error: DEVELOPER_NOT_READY, message: "开发者平台尚未装配" };
    if (!raw || typeof raw !== "object") return developerDomain.normalizeDeveloperError(developerDomain.createDeveloperError(developerDomain.DEVELOPER_ERR_INVALID_INPUT, "developer:command 需要对象载荷"));
    const command = commandOf(raw);
    if (!developerDomain.isDeveloperCommand(command)) return developerDomain.normalizeDeveloperError(developerDomain.developerCommandNotAllowed(command));
    // B7b 扩展命令也要求已认证会话：sessionRef 只来自主进程 identity.current，payload 自报一律忽略。
    if (owned.has(command) && !sessionRef()) {
      return developerDomain.normalizeDeveloperError(developerDomain.createDeveloperError(developerDomain.DEVELOPER_ERR_UNAUTHENTICATED, "developer:command 需要已认证会话"));
    }
    return combined ? combined(event, raw) : base(event, raw);
  });
  return { channel: "developer:command", dispose: () => disposeDeveloperIpc({ ipcMain }) };
}

function disposeDeveloperIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("developer:command"); } catch { /* 忽略 */ } }
}

module.exports = { registerDeveloperIpc, disposeDeveloperIpc, DEVELOPER_NOT_READY };
