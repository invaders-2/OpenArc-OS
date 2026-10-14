/**
 * B5c · 画布域命令面（扩展既有 canvas:command，不新建画布域）。
 *
 * 源：B5c 任务书要求的三件事在这里落地——素材库、.dxcanvas 打包、协作、内核能力、Agent 附件
 * 都通过**同一个 canvas:command** 暴露；每条命令登记 risk / credential / 中文 summary。
 *
 * 与既有实现的边界（为什么必须由本文件扩展，而不是新建 IPC）：
 *   · canvas-bootstrap.cjs:17-44 已有 RENDERER_COMMANDS 白名单与 canvas:command 处理器；
 *     本模块**不改它**，而是导出 extendRendererCommands() 与 dispatch()，由装配处接进去。
 *   · preload.cjs:140-142 只有 canvas.command(...) 一个顶层键；本批次**不新增顶层键**，
 *     因此所有请求与下行都走 canvas:command 的请求/应答（下行用 canvas/collab/events 拉取）。
 *   · 仓库当前**没有** canvas:event 通道（实测 preload.cjs:140-142 只有 command）——所以不能
 *     "沿用"一条不存在的通道；这里复用既有 canvas:command 应答面，并在 onEvent 注入点预留
 *     （hub.onBroadcast → events 队列；若 Lead 后续开 canvas:event，直接接同一个队列）。
 *
 * OUT（一律不引入）：dxosProtocol 云 AI、apiQuota、cloudEntitlement、publicMedia 上传、
 * api.dx-os.com、canvasCloudSync / dx-canvas-cloud 协议 —— 本文件零引用。
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildCanvasPackage, parseCanvasPackage, remapCanvasPackageDocument, sha256 } = require("./canvas-dxos-package.cjs");
const { CanvasCollabHub } = require("./canvas-dxos-collab.cjs");
const { buildCanvasKernelCapabilities, toCatalogDescriptors } = require("./canvas-dxos-capabilities.cjs");
const { extractAttachments } = require("./canvas-dxos-agent-attachments.cjs");

const CHANNEL = "canvas:command";
const MAX_INLINE_PACKAGE_BYTES = 32 * 1024 * 1024;

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });
const asStr = (value, max = 200) => (typeof value === "string" ? value.slice(0, max) : value == null ? null : String(value).slice(0, max));
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

/**
 * 命令登记表。每一条都必须有中文 summary / risk / credential（测试逐条断言）。
 * risk 取值与既有 agent 工具目录一致：read | write | delete | external。
 */
const DXOS_CANVAS_COMMANDS = Object.freeze([
  // ---- 素材库（源 canvasAssetLibrary.ts 全部入口） ----
  { command: "canvas/assetLibrary/list", risk: "read", credential: "none", summary: "列举当前用户可见的素材库（本人 + 组织可见）" },
  { command: "canvas/assetLibrary/ensure", risk: "write", credential: "none", summary: "取得或创建默认素材库，并补齐系统提示词" },
  { command: "canvas/assetLibrary/create", risk: "write", credential: "none", summary: "新建一个素材库" },
  { command: "canvas/assetLibrary/get", risk: "read", credential: "none", summary: "读取素材库及其全部条目" },
  { command: "canvas/assetLibrary/items", risk: "read", credential: "none", summary: "按 kind / 关键词筛选素材库条目" },
  { command: "canvas/assetLibrary/import", risk: "write", credential: "none", summary: "导入素材字节（同 checksum 复用同一 ResourceRef 去重）" },
  { command: "canvas/assetLibrary/upsert", risk: "write", credential: "none", summary: "写入或更新 asset / prompt / workflow 条目（含版本历史与关联字段）" },
  { command: "canvas/assetLibrary/update", risk: "write", credential: "none", summary: "按基准版本更新素材库名称 / 可见性（version+1）" },
  { command: "canvas/assetLibrary/reference", risk: "read", credential: "none", summary: "返回条目的稳定 ResourceRef 与当前引用计数" },
  { command: "canvas/assetLibrary/attach", risk: "write", credential: "none", summary: "把素材库条目作为节点挂到画布上" },
  { command: "canvas/assetLibrary/delete", risk: "delete", credential: "none", summary: "删除素材条目（系统提示词受保护不可删）" },
  // ---- 协作（本机 / 局域网会话；云同步 OUT） ----
  { command: "canvas/collab/join", risk: "write", credential: "none", summary: "加入画布协作房间（鉴权后广播 presence）" },
  { command: "canvas/collab/leave", risk: "write", credential: "none", summary: "离开画布协作房间并广播 presence" },
  { command: "canvas/collab/presence", risk: "read", credential: "none", summary: "读取画布房间的在线成员" },
  { command: "canvas/collab/heartbeat", risk: "write", credential: "none", summary: "刷新本会话的最后活跃时间" },
  { command: "canvas/collab/cursor", risk: "write", credential: "none", summary: "广播光标位置（有限坐标，限速）" },
  { command: "canvas/collab/patch", risk: "write", credential: "none", summary: "广播补丁；基准版本落后时明确返回冲突，不广播过期补丁" },
  { command: "canvas/collab/events", risk: "read", credential: "none", summary: "拉取本会话来收到过的下行事件（presence / cursor / patch）" },
  { command: "canvas/collab/rooms", risk: "read", credential: "none", summary: "列出本进程内的协作房间（本机调试）" },
  { command: "canvas/collab/sweep", risk: "write", credential: "none", summary: "清理超过空闲超时的协作会话并广播 presence" },
  // ---- 内核能力（源 canvasKernelCapabilities.ts 的投影） ----
  { command: "canvas/capabilities/list", risk: "read", credential: "none", summary: "投影画布可被 Agent 调用的能力清单（含 risk / 副作用）" },
  // ---- Agent 附件（源 canvasAgentAttachments.ts + 本仓挂载语义） ----
  { command: "canvas/agentAttachments/list", risk: "read", credential: "none", summary: "列举挂载到画布上的 Agent 附件" },
  { command: "canvas/agentAttachments/extract", risk: "read", credential: "none", summary: "把 Agent 附件抽取为文本（不落盘、不挂载）" },
  { command: "canvas/agentAttachments/mount", risk: "write", credential: "none", summary: "把 Agent 产物导入资源域并挂载为画布节点" },
  { command: "canvas/agentAttachments/unmount", risk: "delete", credential: "none", summary: "卸载 Agent 附件节点（资源本身保留）" },
  // ---- .dxcanvas 打包（源 canvasPackage.ts） ----
  { command: "canvas/package/export", risk: "read", credential: "none", summary: "把画布与其素材打成 .dxcanvas（内联返回，超过 32MB 拒绝内联）" },
  { command: "canvas/package/import", risk: "write", credential: "none", summary: "解析 .dxcanvas，导入素材并新建画布" },
]);

const REGISTRY = new Map(DXOS_CANVAS_COMMANDS.map((entry) => [entry.command, entry]));

/** 与 canvas-bootstrap.RENDERER_COMMANDS 合并（不覆盖既有命令）。 */
function extendRendererCommands(baseCommands) {
  const base = Array.isArray(baseCommands) ? baseCommands : [];
  return Object.freeze([...new Set([...base, ...DXOS_CANVAS_COMMANDS.map((entry) => entry.command)])]);
}

/** tempDir 既可能是路径，也可能是返回路径的函数（与 canvas-service.attachRuntime 同一约定）。 */
function packageTempDir(dir) {
  if (typeof dir === "function") { try { return dir() || path.join(os.tmpdir(), "openarc-canvas-dxos"); } catch { return path.join(os.tmpdir(), "openarc-canvas-dxos"); } }
  return dir || path.join(os.tmpdir(), "openarc-canvas-dxos");
}

/**
 * 扩展装配。services 里没有的依赖会让对应命令结构化失败（不做假实现）。
 * @param hub 可注入现成 hub（测试用）；不注入则本函数自建并接管 onBroadcast → 事件队列。
 */
function createCanvasDxosExtension({ identity, store, canvasService = null, resourceService = null, assetLibrary = null, attachments = null, hub = null, authorize = null, tempDir = null, nodeTypes = [], clock = null } = {}) {
  if (!identity) throw new Error("createCanvasDxosExtension 需要 identity");
  const events = new Map(); // "canvasId\u0000clientId" → array
  const keepEvent = (delivery) => {
    const recipients = Array.isArray(delivery.to) ? delivery.to : [];
    for (const clientId of recipients) {
      const key = String(delivery.canvasId) + "\u0000" + String(clientId);
      const queue = events.get(key) || [];
      queue.push({ ...delivery, to: undefined });
      if (queue.length > 200) queue.splice(0, queue.length - 200);
      events.set(key, queue);
    }
  };
  // hub 级 authorize 必须显式注入（CanvasCollabHub 缺省拒绝）：本扩展的 canvas/collab/join 在
  // 命令层已经做了真实鉴权（session + getCanvas 访问判定），故这里显式给出判定，而不是依赖默认拒绝。
  // 调用方仍可传 authorize 覆盖；注入现成 hub 时以 hub 自身配置为准。
  const collabAuthorize = typeof authorize === "function"
    ? authorize
    : (request) => !!(request && request.canvasId && request.clientId && request.userId);
  const collabHub = hub || new CanvasCollabHub({ clock, authorize: collabAuthorize });
  collabHub.onBroadcast = keepEvent;

  const actorOf = (context) => {
    const view = identity.validateSession(context && context.sessionRef, { sensitive: false });
    return view && view.ok ? view.user : null;
  };

  /**
   * 默认素材解析：优先走既有 canvas-service.readAsset（与画布页面同一条受控读取路径，
   * 含"资源属于当前用户本人"的兜底），失败再退回 resource-service.readDataUrl。
   */
  const resolveAssetDefault = (resourceId, context) => {
    let dataUrl = null;
    let name = null;
    if (canvasService && typeof canvasService.readAsset === "function") {
      // canvas-service.readAsset 只认裸 resourceId / resource://（authorization-domain.parseResourceRef），
      // 不能把 openarc-asset: 前缀原样传进去。
      const read = canvasService.readAsset({ context, ref: String(resourceId) });
      if (read && read.ok) { dataUrl = read.dataUrl; name = read.name; }
    }
    if (!dataUrl && resourceService && typeof resourceService.readDataUrl === "function") {
      const data = resourceService.readDataUrl({ context, resourceRef: String(resourceId), maxBytes: 64 * 1024 * 1024 });
      if (data && data.ok) { dataUrl = data.dataUrl; name = data.name; }
    }
    if (!dataUrl) return null;
    const match = /^data:([^;,]{1,120});base64,([A-Za-z0-9+/=]*)$/.exec(dataUrl);
    if (!match) return null;
    return { data: Buffer.from(match[2], "base64"), name, mime: match[1] };
  };

  const handlers = {
    "canvas/assetLibrary/list": (payload, context) => assetLibrary.listLibraries({ context }),
    "canvas/assetLibrary/ensure": (payload, context) => assetLibrary.ensureDefaultLibrary({ context }),
    "canvas/assetLibrary/create": (payload, context) => assetLibrary.createLibrary({ context, name: asStr(payload.name, 120), visibility: asStr(payload.visibility, 20) }),
    "canvas/assetLibrary/get": (payload, context) => assetLibrary.getLibrary({ context, libraryId: asStr(payload.libraryId, 120) }),
    "canvas/assetLibrary/items": (payload, context) => assetLibrary.listItems({ context, libraryId: asStr(payload.libraryId, 120), kind: asStr(payload.kind, 20), query: asStr(payload.query, 120) }),
    "canvas/assetLibrary/import": (payload, context) => assetLibrary.importAssetItem({
      context, libraryId: asStr(payload.libraryId, 120), name: asStr(payload.name, 120), mime: asStr(payload.mime, 120),
      dataUrl: typeof payload.dataUrl === "string" ? payload.dataUrl.slice(0, 12 * 1024 * 1024) : null,
      base64: typeof payload.base64 === "string" ? payload.base64.slice(0, 12 * 1024 * 1024) : null,
      sourcePath: asStr(payload.sourcePath, 500), title: asStr(payload.title, 160), group: asStr(payload.group, 40),
      tags: Array.isArray(payload.tags) ? payload.tags : [], sourceKey: asStr(payload.sourceKey, 500),
    }),
    "canvas/assetLibrary/upsert": (payload, context) => assetLibrary.upsertItem({ context, libraryId: asStr(payload.libraryId, 120), item: payload.item && typeof payload.item === "object" ? payload.item : {} }),
    "canvas/assetLibrary/update": (payload, context) => assetLibrary.updateLibrary({ context, libraryId: asStr(payload.libraryId, 120), name: asStr(payload.name, 120), visibility: asStr(payload.visibility, 20), baseVersion: num(payload.baseVersion) }),
    "canvas/assetLibrary/reference": (payload, context) => assetLibrary.referenceItem({ context, libraryId: asStr(payload.libraryId, 120), itemId: asStr(payload.itemId, 120) }),
    "canvas/assetLibrary/attach": (payload, context) => assetLibrary.attachItemToCanvas({ context, libraryId: asStr(payload.libraryId, 120), itemId: asStr(payload.itemId, 120), canvasId: asStr(payload.canvasId, 120), x: num(payload.x) || 0, y: num(payload.y) || 0 }),
    "canvas/assetLibrary/delete": (payload, context) => assetLibrary.deleteItem({ context, libraryId: asStr(payload.libraryId, 120), itemId: asStr(payload.itemId, 120) }),

    "canvas/collab/join": (payload, context) => {
      const user = actorOf(context);
      if (!user) return fail("NOT_FOUND_OR_FORBIDDEN");
      const canvasId = asStr(payload.canvasId, 120);
      if (!canvasService || typeof canvasService.getCanvas !== "function") return fail("CANVAS_UNAVAILABLE");
      const view = canvasService.getCanvas({ context, canvasId });
      if (!view || !view.ok) return view && view.error ? view : fail("NOT_FOUND");
      return collabHub.join({
        canvasId, clientId: asStr(payload.clientId, 120), userId: user.id,
        username: asStr(payload.username, 80) || user.display_name || user.identifier || user.id,
        canEdit: !!(view.canvas.access && view.canvas.access.canEdit),
      });
    },
    "canvas/collab/leave": (payload) => collabHub.leave({ canvasId: asStr(payload.canvasId, 120), clientId: asStr(payload.clientId, 120) }),
    "canvas/collab/presence": (payload) => ok({ presence: collabHub.presence(asStr(payload.canvasId, 120)) }),
    "canvas/collab/heartbeat": (payload) => collabHub.heartbeat({ canvasId: asStr(payload.canvasId, 120), clientId: asStr(payload.clientId, 120) }),
    "canvas/collab/cursor": (payload) => collabHub.cursor({ canvasId: asStr(payload.canvasId, 120), clientId: asStr(payload.clientId, 120), x: payload.x, y: payload.y, nodeId: asStr(payload.nodeId, 120) }),
    "canvas/collab/patch": (payload) => collabHub.submitPatch({
      canvasId: asStr(payload.canvasId, 120), clientId: asStr(payload.clientId, 120),
      baseRevision: num(payload.baseRevision), currentRevision: num(payload.currentRevision),
      payload: payload.patch && typeof payload.patch === "object" ? { patches: Array.isArray(payload.patch.patches) ? payload.patch.patches : [], upserts: Array.isArray(payload.patch.upserts) ? payload.patch.upserts : [], deletedIds: Array.isArray(payload.patch.deletedIds) ? payload.patch.deletedIds : [], connections: Array.isArray(payload.patch.connections) ? payload.patch.connections : [] } : {},
    }),
    "canvas/collab/events": (payload) => {
      const key = String(asStr(payload.canvasId, 120) || "") + "\u0000" + String(asStr(payload.clientId, 120) || "");
      const queue = events.get(key) || [];
      events.set(key, []);
      return ok({ events: queue });
    },
    "canvas/collab/rooms": () => ok({ rooms: collabHub.liveRooms() }),
    "canvas/collab/sweep": () => collabHub.sweepIdle(),

    "canvas/capabilities/list": () => {
      const projection = buildCanvasKernelCapabilities({ nodeTypes });
      return ok({ projection, descriptors: toCatalogDescriptors(projection.capabilities), registry: DXOS_CANVAS_COMMANDS.map((entry) => ({ ...entry })) });
    },

    "canvas/agentAttachments/list": (payload, context) => attachments.list({ context, canvasId: asStr(payload.canvasId, 120), includeRemoved: !!payload.includeRemoved }),
    "canvas/agentAttachments/extract": (payload) => {
      const files = Array.isArray(payload.files) ? payload.files : [];
      const normalized = files.slice(0, 12).map((file) => ({
        name: asStr(file && file.name, 300),
        mime: asStr(file && file.mime, 120),
        size: num(file && file.size),
        buffer: Buffer.from(typeof (file && (file.base64 || file.dataUrl)) === "string" ? String(file.base64 || file.dataUrl).replace(/^data:[^;]*;base64,/, "") : "", "base64"),
      }));
      const extracted = extractAttachments(normalized);
      if (!extracted.ok) return extracted;
      return ok({ attachments: extracted.attachments.map(({ buffer, ...rest }) => rest) });
    },
    "canvas/agentAttachments/mount": (payload, context) => {
      const files = (Array.isArray(payload.files) ? payload.files : []).slice(0, 12).map((file) => ({
        name: asStr(file && file.name, 300), mime: asStr(file && file.mime, 120), size: num(file && file.size),
        buffer: Buffer.from(typeof (file && (file.base64 || file.dataUrl)) === "string" ? String(file.base64 || file.dataUrl).replace(/^data:[^;]*;base64,/, "") : "", "base64"),
      }));
      return attachments.mount({ context, canvasId: asStr(payload.canvasId, 120), files, runId: asStr(payload.runId, 120) });
    },
    "canvas/agentAttachments/unmount": (payload, context) => attachments.unmount({ context, canvasId: asStr(payload.canvasId, 120), attachmentId: asStr(payload.attachmentId, 120) }),

    "canvas/package/export": (payload, context) => {
      if (!canvasService || typeof canvasService.getCanvas !== "function") return fail("CANVAS_UNAVAILABLE");
      const canvasId = asStr(payload.canvasId, 120);
      const view = canvasService.getCanvas({ context, canvasId });
      if (!view || !view.ok) return view && view.error ? view : fail("NOT_FOUND");
      const buffer = buildCanvasPackage(view.canvas.doc, (resourceId) => resolveAssetDefault(resourceId, context), {
        canvasId, title: view.canvas.title, icon: view.canvas.icon, kind: view.canvas.kind, revision: view.canvas.revision,
      });
      if (buffer.byteLength > MAX_INLINE_PACKAGE_BYTES) return fail("LIMIT_EXCEEDED", "package-too-large-to-inline");
      return ok({ byteLength: buffer.byteLength, sha256: sha256(buffer), base64: buffer.toString("base64"), format: "dx-canvas-package/v1" });
    },
    "canvas/package/import": async (payload, context) => {
      if (!canvasService) return fail("CANVAS_UNAVAILABLE");
      if (!resourceService || typeof resourceService.importManaged !== "function") return fail("RESOURCE_UNAVAILABLE");
      const base64 = typeof payload.base64 === "string" ? payload.base64 : "";
      if (!base64) return fail("INVALID_INPUT", "base64");
      const buffer = Buffer.from(base64, "base64");
      if (!buffer.length) return fail("INVALID_INPUT", "empty");
      let parsed;
      // 解析失败必须是"结构化失败"，不能把异常抛回 IPC 边界（否则渲染层只看到 INTERNAL_ERROR）。
      try { parsed = parseCanvasPackage(buffer); }
      catch (error) { return fail(String((error && error.message) || error), "package"); }
      const created = canvasService.createCanvas({
        context,
        title: String(payload.title || parsed.manifest.canvas.title || "导入画布").slice(0, 200) + "（导入）",
        icon: parsed.manifest.canvas.icon || "🧩",
        kind: parsed.manifest.canvas.kind || "classic",
      });
      if (!created.ok) return created;
      const canvasId = created.canvas.canvasId;
      const dir = packageTempDir(tempDir);
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      const mediaIds = new Map();
      try {
        for (const asset of parsed.assets) {
          const safe = String(asset.name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "asset";
          const file = path.join(dir, "dxcanvas-" + crypto.randomBytes(4).toString("hex") + "-" + safe);
          fs.writeFileSync(file, asset.data);
          try {
            const imported = await resourceService.importManaged({ context: { ...context, appId: "resource-library" }, sourcePath: file, name: safe, mimeType: asset.mime, scope: "PERSONAL" });
            if (!imported || !imported.ok) throw new Error(imported && imported.error ? imported.error : "IMPORT_FAILED");
            const ref = imported.resource && (imported.resource.resourceId || imported.resource.resourceRef);
            mediaIds.set(asset.sourceId, String(ref).replace(/^resource:\/\//, "").replace(/^openarc-asset:/, ""));
          } finally {
            try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
          }
        }
        const doc = remapCanvasPackageDocument(parsed.manifest.document, mediaIds, canvasId);
        const saved = canvasService.saveCanvas({ context, canvasId, baseRevision: created.canvas.revision, doc });
        if (!saved.ok) throw new Error(saved.error);
        return ok({ canvas: saved.canvas, canvasId, importedAssets: mediaIds.size });
      } catch (error) {
        // 失败回滚：导入失败的画布不留在列表里（资源对象由资源域 GC 处理，不在这里硬删）。
        try { canvasService.purgeCanvas({ context, canvasId }); } catch { /* best effort */ }
        return fail(String((error && error.message) || error));
      }
    },
  };

  const dispatch = ({ command, payload, context } = {}) => {
    const entry = REGISTRY.get(String(command || ""));
    if (!entry) return fail("CANVAS_COMMAND_NOT_ALLOWED", String(command || ""));
    const handler = handlers[entry.command];
    if (typeof handler !== "function") return fail("NOT_IMPLEMENTED", entry.command);
    const safePayload = payload && typeof payload === "object" ? payload : {};
    return handler(safePayload, context || {});
  };

  return {
    channel: CHANNEL,
    registry: DXOS_CANVAS_COMMANDS.map((entry) => ({ ...entry })),
    commandNames: DXOS_CANVAS_COMMANDS.map((entry) => entry.command),
    extendRendererCommands: () => extendRendererCommands([]),
    hub: collabHub,
    events: {
      drain(canvasId, clientId) {
        const key = String(canvasId || "") + "\u0000" + String(clientId || "");
        const queue = events.get(key) || [];
        events.set(key, []);
        return queue;
      },
      size() { let total = 0; for (const queue of events.values()) total += queue.length; return total; },
    },
    dispatch,
    handlers,
  };
}

/**
 * 把扩展接到既有 canvas:command 上：先试扩展，再落回 base。
 * base 为空时只处理扩展命令（未登记命令返回 CANVAS_COMMAND_NOT_ALLOWED）。
 */
function combineCanvasCommandHandlers({ base = null, extension, identity = null, isTrusted = null, hostAppId = "canvas" } = {}) {
  if (!extension) throw new Error("combineCanvasCommandHandlers 需要 extension");
  return async (event, raw) => {
    if (typeof isTrusted === "function" && !isTrusted(event)) throw Error("Forbidden");
    if (!raw || typeof raw !== "object") return fail("INVALID_INPUT");
    const command = typeof raw.command === "string" ? raw.command : typeof raw.type === "string" ? raw.type : "";
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    if (REGISTRY.has(command)) {
      const context = { sessionRef: identity ? identity.current : null, appId: hostAppId, source: "ui", requestId: asStr(payload.requestId, 80) };
      try { return extension.dispatch({ command, payload, context }); }
      catch { return fail("INTERNAL_ERROR"); }
    }
    if (typeof base === "function") return base(event, raw);
    return fail("CANVAS_COMMAND_NOT_ALLOWED", command);
  };
}

/**
 * Electron 侧注册（供装配处调用）：**只注册一个** canvas:command。
 * 注意：Electron 不允许同一通道二次 handle，所以这里先 removeHandler 再 handle；
 * 若 canvas-bootstrap 已注册，装配处应改为把 combineCanvasCommandHandlers 的结果交给它，
 * 或在本函数之前不要注册（见报告"待接线"）。
 */
function registerCanvasDxosIpc({ ipcMain, extension, base = null, identity = null, isTrusted = null, channel = CHANNEL } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerCanvasDxosIpc 需要 ipcMain");
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler(channel); } catch { /* not registered */ } }
  ipcMain.handle(channel, combineCanvasCommandHandlers({ base, extension, identity, isTrusted }));
}

function describeCommands() { return DXOS_CANVAS_COMMANDS.map((entry) => ({ ...entry })); }

module.exports = {
  CHANNEL, MAX_INLINE_PACKAGE_BYTES, DXOS_CANVAS_COMMANDS, REGISTRY,
  extendRendererCommands, createCanvasDxosExtension, combineCanvasCommandHandlers, registerCanvasDxosIpc, describeCommands,
};
