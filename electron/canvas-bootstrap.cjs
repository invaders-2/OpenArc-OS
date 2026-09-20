/**
 * D5-02 · 画布装配 + IPC。
 *
 * 渲染进程（OpenArc 外壳里的画布宿主）只暴露**受控画布命令**：
 *   - 画布页面本身运行在 sandbox iframe 里，没有 openarc 桥、没有 IPC、没有文件系统、没有凭据；
 *     它的所有请求都由宿主经这里转发（见 public/novai-canvas/openarc-bridge.js）。
 *   - 身份与会话一律由主进程从已认证 session 推导；payload 里的 userId/owner 一律忽略。
 */
"use strict";

const { CanvasStore } = require("./canvas-store.cjs");
const { CanvasService } = require("./canvas-service.cjs");

const HOST_APP_ID = "canvas";

/** 宿主（渲染层）可下发的画布命令白名单。新增能力必须显式登记。 */
const RENDERER_COMMANDS = Object.freeze([
  "canvas/create",
  "canvas/list",
  "canvas/get",
  "canvas/save",
  "canvas/trash",
  "canvas/restore",
  "canvas/purge",
  "canvas/share",
  "canvas/shares",
  "canvas/visibility",
  "canvas/command",
  "canvas/undo",
  "canvas/log",
  "canvas/assetStates",
  // D5-02 Closure：一次生成 = 一个 Task（预算/停止/审计归属）；图片统一进资源库
  "canvas/run",
  "canvas/runStop",
  "canvas/runState",
  "canvas/runs",
  "canvas/runFinish",
  "canvas/modelChat",
  "canvas/modelImage",
  "canvas/importAsset",
  "canvas/readAsset",
]);
const CANVAS_COMMAND_NOT_ALLOWED = "CANVAS_COMMAND_NOT_ALLOWED";

const asStr = (v, max = 512) => (typeof v === "string" ? v.slice(0, max) : v == null ? undefined : String(v).slice(0, max));

function createCanvasBundle({ identity = null, identityStore = null, resourceStore = null, resourceService = null, authService = null, clock = null, logger = null } = {}) {
  const idStore = identityStore || identity;
  if (!idStore) throw new Error("createCanvasBundle 需要 identityStore");
  const store = new CanvasStore({ identity: idStore, clock });
  const service = new CanvasService({ identity: idStore, store, resourceStore, resourceService, authService, clock, logger });
  return { store, service };
}

function registerCanvasIpc({ ipcMain, service, identity, isTrusted, hostAppId = HOST_APP_ID }) {
  if (typeof ipcMain.removeHandler === "function") {
    try { ipcMain.removeHandler("canvas:command"); } catch { /* not registered */ }
  }
  ipcMain.handle("canvas:command", async (e, raw) => {
    if (isTrusted && !isTrusted(e)) throw Error("Forbidden");
    if (!service) return { ok: false, error: "INTERNAL_ERROR", detail: "canvas-not-ready" };
    if (!raw || typeof raw !== "object") return { ok: false, error: "INVALID_INPUT" };
    // 命令名只接受**字符串**：canvas/command 这类命令把具体的画布命令放在 command 字段（对象）里。
    const command = typeof raw.command === "string" ? asStr(raw.command, 80) : asStr(raw.type, 80);
    if (!RENDERER_COMMANDS.includes(command)) return { ok: false, error: CANVAS_COMMAND_NOT_ALLOWED, detail: asStr(command, 80) || null };
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    // 身份只来自主进程：渲染层传的 userId / owner / sessionRef 一律忽略。
    const context = { sessionRef: identity?.current ?? null, appId: hostAppId, source: "ui", requestId: asStr(payload.requestId, 80) };
    try {
      switch (command) {
        case "canvas/create":
          return service.createCanvas({ context, title: asStr(payload.title, 200), icon: asStr(payload.icon, 16), kind: asStr(payload.kind, 20) });
        case "canvas/list":
          return service.listCanvases({ context, includeTrashed: !!payload.includeTrashed });
        case "canvas/get":
          return service.getCanvas({ context, canvasId: asStr(payload.canvasId, 120) });
        case "canvas/save":
          return service.saveCanvas({
            context, canvasId: asStr(payload.canvasId, 120),
            baseRevision: payload.baseRevision == null ? null : Number(payload.baseRevision),
            doc: payload.doc, title: asStr(payload.title, 200), icon: asStr(payload.icon, 16),
          });
        case "canvas/trash": return service.trashCanvas({ context, canvasId: asStr(payload.canvasId, 120) });
        case "canvas/restore": return service.restoreCanvas({ context, canvasId: asStr(payload.canvasId, 120) });
        case "canvas/purge": return service.purgeCanvas({ context, canvasId: asStr(payload.canvasId, 120) });
        case "canvas/share": return service.shareCanvas({ context, canvasId: asStr(payload.canvasId, 120), userId: asStr(payload.userId, 120), role: asStr(payload.role, 20) });
        case "canvas/shares": return service.listShares({ context, canvasId: asStr(payload.canvasId, 120) });
        case "canvas/visibility": return service.setVisibility({ context, canvasId: asStr(payload.canvasId, 120), visibility: asStr(payload.visibility, 20) });
        case "canvas/command":
          return service.applyCommand({
            context, canvasId: asStr(payload.canvasId, 120),
            baseRevision: payload.baseRevision == null ? null : Number(payload.baseRevision),
            command: payload.command, actorKind: "USER",
          });
        case "canvas/undo":
          return service.undoLastCommand({ context, canvasId: asStr(payload.canvasId, 120), baseRevision: payload.baseRevision == null ? null : Number(payload.baseRevision) });
        case "canvas/log": return service.commandLog({ context, canvasId: asStr(payload.canvasId, 120), limit: Number(payload.limit) || 20 });
        case "canvas/assetStates": return service.assetStates({ context, refs: Array.isArray(payload.refs) ? payload.refs : [] });
        // ---- 生成运行：预算 / 停止 / 模型调用（唯一入口） ----
        case "canvas/run":
          return service.startRun({ context, canvasId: asStr(payload.canvasId, 120), nodeId: asStr(payload.nodeId, 120), kind: asStr(payload.kind, 20) });
        case "canvas/runStop":
          return service.stopRun({ context, canvasId: asStr(payload.canvasId, 120), runId: asStr(payload.runId, 120), reason: asStr(payload.reason, 60) });
        case "canvas/runState":
          return service.runState({ context, canvasId: asStr(payload.canvasId, 120), runId: asStr(payload.runId, 120) });
        case "canvas/runs":
          return service.listRuns({ context, canvasId: asStr(payload.canvasId, 120), limit: Number(payload.limit) || 20 });
        case "canvas/runFinish":
          return service.finishRun({ context, canvasId: asStr(payload.canvasId, 120), runId: asStr(payload.runId, 120), status: asStr(payload.status, 20) });
        case "canvas/modelChat":
          return service.modelCall({
            context, canvasId: asStr(payload.canvasId, 120), runId: asStr(payload.runId, 120), kind: "chat",
            messages: Array.isArray(payload.messages) ? payload.messages.slice(0, 64) : [], configId: asStr(payload.configId, 120),
          });
        case "canvas/modelImage":
          return service.modelCall({
            context, canvasId: asStr(payload.canvasId, 120), runId: asStr(payload.runId, 120), kind: "image",
            prompt: asStr(payload.prompt, 4000), size: asStr(payload.size, 32), count: Math.max(1, Math.min(4, Number(payload.count) || 1)), configId: asStr(payload.configId, 120),
          });
        case "canvas/importAsset":
          return service.importAsset({ context, canvasId: asStr(payload.canvasId, 120), name: asStr(payload.name, 120), dataUrl: typeof payload.dataUrl === "string" ? payload.dataUrl.slice(0, 12 * 1024 * 1024) : "" });
        case "canvas/readAsset":
          return service.readAsset({ context, ref: asStr(payload.ref, 200) });
        default: return { ok: false, error: CANVAS_COMMAND_NOT_ALLOWED };
      }
    } catch {
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  });
}

function disposeCanvasIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") {
    try { ipcMain.removeHandler("canvas:command"); } catch { /* ignore */ }
  }
}

module.exports = { createCanvasBundle, registerCanvasIpc, disposeCanvasIpc, RENDERER_COMMANDS, CANVAS_COMMAND_NOT_ALLOWED, HOST_APP_ID };
