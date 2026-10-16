/**
 * canvas × photos / app-exchange · 端口适配层（唯一实例，主进程内装配）。
 *
 * 为什么需要这一层：app-exchange 的 canvas target（DX image.import）与 photos/importImage 的
 * importer 都要求"画布写原语 + 素材引用 + 可读判定"，而既有能力分散在四处：
 *   · CanvasService（electron/canvas-service.cjs）—— 画布文档 / 权限 / 版本检查 / 命令层；
 *   · CanvasAssetLibraryService（electron/canvas-dxos-asset-library.cjs）—— 素材库导入（checksum 去重）；
 *   · ResourceService（electron/resource-service.cjs）—— 素材字节的唯一落点（ResourceRef）；
 *   · dxos-fs（electron/dxos-fs.cjs）—— 画布项目虚拟树与共享区可见性。
 * 本文件只做形状转换与编排，**不新建画布 / 不新建素材系统 / 不新建审批**：
 *   · 权限一律走 CanvasService 的 evaluateCanvasAccess（画布）与既有授权（资源）；
 *   · 画布文档只写 openarc-asset:<ResourceRef> 引用，绝不写图片字节（本仓既有口径）。
 *
 * 与调用方的字段形状（以调用点为准，不发明字段）：
 *   · app-exchange-service.cjs:228-263 —— getCanvas(projectId, viewer) / canEditCanvas(canvasId, viewer) /
 *     canvasFolder(canvas, viewer) / createCanvasCard(x, y, spec) / findNearestCanvasPlacement({desired,size,occupied}) /
 *     syncCanvas(canvasId, viewer, { upserts }) / canViewCanvasMedia(nodeId, viewer, canvasId) / canRead(viewer, node)；
 *   · photos-service.cjs:650-671 —— importer({ userId, user, destination, targetId, name, mime, data, sourceId, prompt })
 *     回 { cardId } 或 { itemId }。
 *
 * fs 节点 → 资源域引用的两步口径（不假实现，失败一律结构化依赖不可用）：
 *   · app-exchange 的 canvas 分支先把字节写进 **dxos 虚拟树**（createNode + saveBlob），再把该 fs 节点
 *     id 交给 createCanvasCard；而画布文档的媒体口径是 **资源域** openarc-asset:<ResourceRef>。
 *   · 同步的 createCanvasCard 只能等价解析"这份字节已经在资源域里"的情形（readBlob → sha256 →
 *     canvas_dxos_store.resourceByChecksum，即素材库同一套 checksum 去重）；资源域没有对应内容时回
 *     APP_EXCHANGE_DEPENDENCY_UNAVAILABLE，detail 指明缺的能力。
 *   · fs-only 的字节由 **async resolveCanvasRef**（本层提供的端口）补齐：先复用既有 checksum 命中，
 *     否则经既有 resourceService.importManaged 把字节落进资源域拿 ResourceRef；app-exchange-service
 *     的 canvas 分支 await 它，再把引用交给 createCanvasCard。
 */
"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const foundation = require("./dxos-foundation-errors.cjs");
const appExchangeDomain = require("./app-exchange-domain.cjs");
const photosDomain = require("./photos-domain.cjs");

const CARD_ID_PREFIX = "card_";
const DEFAULT_CARD_WIDTH = 300;
const DEFAULT_CARD_HEIGHT = 200;
const CARD_DESIRED = Object.freeze({ x: 480, y: 300 });
const PLACEMENT_GAP = 24;
const PLACEMENT_MAX_RINGS = 64;
/** 画布节点 url / refs 的唯一合法形态（与 canvas-dxos-package.cjs:34 同一模式）。 */
const ASSET_REF_RE = /^openarc-asset:[A-Za-z0-9_.#:-]{1,160}$/;
/** node.edit 允许改的字段（canvas-domain.cjs:39-43）；inputs 不在其中，只能随 node.add 写入。 */
const EDITABLE_CARD_KEYS = Object.freeze(["x", "y", "w", "h", "title", "name", "url", "mediaKind", "params", "refs"]);
/** 递归扫描时禁止出现的字节/内联字段名（画布文档只存引用）。 */
const FORBIDDEN_DOC_KEYS = Object.freeze(["bytes", "data", "base64", "blob", "buffer", "content", "dataUrl", "src", "path"]);

const isPlain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : value == null ? null : String(value).slice(0, max));
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const rectOf = (item) => ({
  x: num(item && item.x),
  y: num(item && item.y),
  w: Math.max(0, num(item && item.w)),
  h: Math.max(0, num(item && item.h)),
});
const overlaps = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

const newCardId = () => CARD_ID_PREFIX + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

/**
 * 纯几何：从 desired 出发向外扩环，返回第一个不与 occupied 重叠的整数落点。
 * 调用方（app-exchange-service.cjs:253-260）把结果 Object.assign 到卡片上，故只返回 {x,y}。
 */
function findNearestCanvasPlacement({ desired = {}, size = {}, occupied = [], gap = PLACEMENT_GAP } = {}) {
  const want = { x: num(desired.x), y: num(desired.y), w: Math.max(1, num(size.w, DEFAULT_CARD_WIDTH)), h: Math.max(1, num(size.h, DEFAULT_CARD_HEIGHT)) };
  const taken = (Array.isArray(occupied) ? occupied : []).map(rectOf).filter((item) => item.w > 0 || item.h > 0);
  const round = (x, y) => ({ x: Math.round(x), y: Math.round(y) });
  const free = (x, y) => !taken.some((item) => overlaps({ x, y, w: want.w, h: want.h }, item, gap));
  if (free(want.x, want.y)) return round(want.x, want.y);
  const stepX = Math.max(40, want.w + gap);
  const stepY = Math.max(40, want.h + gap);
  for (let ring = 1; ring <= PLACEMENT_MAX_RINGS; ring += 1) {
    const candidates = [];
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        candidates.push({ x: want.x + dx * stepX, y: want.y + dy * stepY, distance: dx * dx + dy * dy });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
    for (const candidate of candidates) {
      const x = Math.round(candidate.x);
      const y = Math.round(candidate.y);
      if (free(x, y)) return { x, y };
    }
  }
  return round(want.x, want.y);
}

/** 递归拒绝字节 / 内联 data: 与字节字段名（params 等自由字段也要过这道闸）。 */
function assertRefOnly(value, path = "") {
  if (value == null) return;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    throw appExchangeDomain.invalidInput("画布文档只存引用，不接收图片字节", { field: path || "payload" });
  }
  if (typeof value === "string") {
    if (/^data:[^;,]{0,60};base64,/i.test(value)) throw appExchangeDomain.invalidInput("画布文档只存引用，不接收内联字节", { field: path || "payload" });
    return;
  }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.slice(0, 50).forEach((item, index) => assertRefOnly(item, path + "[" + index + "]"));
    return;
  }
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    const next = path ? path + "." + key : key;
    if (FORBIDDEN_DOC_KEYS.includes(key) && item != null) throw appExchangeDomain.invalidInput("画布文档只存引用，不接收字节或内联地址", { field: next });
    assertRefOnly(item, next);
  }
}

/** 卡片 inputs 清洗：只留引用与尺寸元数据，url 一律重写成已解析的 openarc-asset 引用。 */
function sanitizeInputs(inputs, ref) {
  if (!Array.isArray(inputs)) return undefined;
  const out = [];
  for (const item of inputs.slice(0, 24)) {
    if (!isPlain(item)) continue;
    const clean = {};
    for (const key of ["nodeId", "name", "kind", "role"]) if (item[key] != null) clean[key] = clip(item[key], 200);
    if (Number.isFinite(Number(item.w))) clean.w = Number(item.w);
    if (Number.isFinite(Number(item.h))) clean.h = Number(item.h);
    if (ref) clean.url = ref;
    out.push(clean);
  }
  return out.length ? out : undefined;
}

function cardToAddNode(card) {
  const node = { id: card.id, type: "image", x: card.x, y: card.y, w: card.w, h: card.h };
  for (const key of ["title", "name", "url", "mediaKind", "params", "inputs", "refs"]) if (card[key] !== undefined) node[key] = card[key];
  return node;
}

function cardToEditPatch(card) {
  const patch = {};
  for (const key of EDITABLE_CARD_KEYS) if (card[key] !== undefined) patch[key] = card[key];
  return patch;
}

/**
 * 装配适配层。所有依赖可缺省；缺哪个就在用到它的端口上结构化失败（构造期不抛，避免拖死启动链）。
 * @param canvasService     identity.canvasDocService（唯一画布文档服务）
 * @param assetLibrary      identity.canvasAssetLibrary（素材库；photos→library 用）
 * @param resourceService   既有资源域服务（canvasService.importAsset 内部已用，这里只做可用性判定）
 * @param resourceStore     既有资源存储（可用性判定）
 * @param canvasDxosStore   identity.canvasDxosStore（checksum 去重查询）
 * @param fsStore           dxos-fs 适配器（getNode/shareZoneOf/readBlob/ensureCanvasRoot）
 * @param sessionRef        () => 主进程可信会话 ref（identity.service.current）
 */
function createCanvasExchangePorts(options = {}) {
  const canvasService = options.canvasService || null;
  const assetLibrary = options.assetLibrary || null;
  const resourceService = options.resourceService || null;
  const resourceStore = options.resourceStore || null;
  const canvasDxosStore = options.canvasDxosStore || null;
  const fsStore = options.fsStore || null;
  /** 既接受 dxos-fs 适配器（有 .store）也接受裸 createDxosFs 实例（测试/内部调用）。 */
  const fsRoot = (fsStore && fsStore.store) || fsStore || null;
  const readBlobFn = (fsStore && typeof fsStore.readBlob === "function" ? fsStore.readBlob : null)
    || (fsRoot && typeof fsRoot.readBlob === "function" ? fsRoot.readBlob : null);
  const sessionRefOption = options.sessionRef;
  const sessionRef = typeof sessionRefOption === "function"
    ? sessionRefOption
    : () => (typeof sessionRefOption === "string" ? sessionRefOption : null);

  /** app-exchange 的调用序列是 getCanvas → canEditCanvas → createCanvasCard → syncCanvas（同一同步块），
   *  createCanvasCard 的签名 (x, y, spec) 不带画布/viewer，故用最近一次 getCanvas 的绑定补齐。 */
  const bound = { canvasId: null, viewerId: null };

  const ctxOf = (appId) => ({ sessionRef: sessionRef(), appId, source: appId === "photos" ? "photos-import" : "app-exchange" });

  function createDxosError(code, message, detail) { return foundation.createDxosError(code, message, detail); }
  function aeDependency(name, detail) {
    return appExchangeDomain.createAppExchangeError(appExchangeDomain.APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE, "应用互传画布端口依赖的既有能力不可用：" + String(name || "unknown"), { dependency: String(name || "unknown"), ...(detail || {}) });
  }
  function aeForbidden(message, detail) { return appExchangeDomain.forbidden(message, detail); }
  function aeNotFound(message, detail) { return appExchangeDomain.notFound(message, detail); }
  function aeInvalid(message, detail) { return appExchangeDomain.invalidInput(message, detail); }
  function aeConflict(message, detail) { return appExchangeDomain.conflict(message, detail); }
  function photosDependency(name, detail) {
    return photosDomain.createPhotosError(photosDomain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE, "画布 / 素材库导入器依赖的既有能力不可用：" + String(name || "unknown"), { dependency: String(name || "unknown"), ...(detail || {}) });
  }
  function photosInvalid(message, detail) { return photosDomain.createPhotosError(photosDomain.PHOTOS_ERR_INVALID_INPUT, message, detail); }
  function photosForbidden(message, detail) { return photosDomain.createPhotosError(photosDomain.PHOTOS_ERR_FORBIDDEN, message, detail); }
  function photosNotFound(message, detail) { return photosDomain.createPhotosError(photosDomain.PHOTOS_ERR_NOT_FOUND, message, detail); }

  /** CanvasService 的失败码 → 调用方错误码（画布侧一律 APP_EXCHANGE_*，不折成看不出原因的 INTERNAL）。 */
  function canvasFailure(res, fallback) {
    const reason = String((res && res.error) || fallback || "CANVAS_ERROR");
    if (reason === "NOT_FOUND" || reason === "NOT_FOUND_OR_FORBIDDEN") return aeNotFound("画布不存在或没有访问权限", { reason });
    if (reason === "READ_ONLY") return aeForbidden("没有编辑该画布的权限", { reason });
    if (reason === "LIMIT_EXCEEDED") return createDxosError(foundation.DXOS_ERR_QUOTA_EXCEEDED, "画布节点数已达上限", { reason });
    if (reason === "REVISION_CONFLICT") return aeConflict("画布已被其他修改更新，请重试", { reason });
    if (reason === "INVALID_INPUT" || reason === "UNSUPPORTED_COMMAND") return aeInvalid("画布命令不合法", { reason });
    return aeDependency("canvasService", { reason });
  }

  function requireCanvasService() {
    if (!canvasService || typeof canvasService.getCanvas !== "function" || typeof canvasService.applyCommand !== "function") throw aeDependency("canvasService");
    return canvasService;
  }

  function viewOf(canvasId, appId = "app-exchange") {
    const service = requireCanvasService();
    const id = String(canvasId == null ? "" : canvasId);
    if (!id) return null;
    const view = service.getCanvas({ context: ctxOf(appId), canvasId: id });
    return view && view.ok === true ? view : null;
  }

  // ---------------------------------------------------------------- app-exchange canvas ports

  function getCanvas(projectId, viewer) {
    const service = requireCanvasService();
    const canvasId = String(projectId == null ? "" : projectId);
    if (!canvasId) return null;
    const view = service.getCanvas({ context: ctxOf("app-exchange"), canvasId });
    if (!view || view.ok !== true) return null;
    const canvas = view.canvas || {};
    const doc = canvas.doc || {};
    bound.canvasId = canvas.canvasId;
    bound.viewerId = viewer && viewer.id != null ? String(viewer.id) : null;
    return {
      id: canvas.canvasId,
      title: canvas.title,
      ownerId: canvas.ownerUserId,
      revision: Number(canvas.revision || 1),
      viewport: doc.viewport || { x: 0, y: 0, scale: 1 },
      access: { canEdit: !!(canvas.access && canvas.access.canEdit), canView: !!(canvas.access && canvas.access.canView) },
      cards: (Array.isArray(doc.nodes) ? doc.nodes : []).map((node) => ({
        id: node.id, x: node.x, y: node.y, w: node.w, h: node.h,
        groupId: node.groupId || null, title: node.title || node.name || "", url: node.url,
      })),
    };
  }

  function canEditCanvas(canvasId, viewer) {
    const view = viewOf(canvasId);
    if (!view) return false;
    bound.canvasId = view.canvas.canvasId;
    bound.viewerId = viewer && viewer.id != null ? String(viewer.id) : null;
    return !!(view.canvas.access && view.canvas.access.canEdit);
  }

  /** 画布媒体目录 = dxos 虚拟树的「项目」根（既有 ensureCanvasRoot，幂等）。 */
  function canvasFolder(canvas, viewer) {
    if (!fsRoot || typeof fsRoot.ensureCanvasRoot !== "function") throw aeDependency("canvasFolder", { missing: "dxos-fs.ensureCanvasRoot" });
    const ownerId = (canvas && canvas.ownerId) || (viewer && viewer.id);
    if (ownerId == null) throw aeDependency("canvasFolder", { missing: "canvas.ownerId" });
    const root = fsRoot.ensureCanvasRoot(String(ownerId));
    const folderId = root && root.id ? root.id : (typeof root === "string" ? root : null);
    if (!folderId) throw aeDependency("canvasFolder", { missing: "dxos-fs.ensureCanvasRoot" });
    return folderId;
  }

  /** fs 节点 → openarc-asset 引用：只有"这份字节已经在资源域"时才能同步等价解析（checksum 去重）。 */
  function refFromFsNode(nodeId) {
    if (!nodeId || !readBlobFn) return null;
    if (!canvasDxosStore || typeof canvasDxosStore.resourceByChecksum !== "function") return null;
    let raw = null;
    try { raw = readBlobFn(String(nodeId)); } catch { return null; }
    if (!raw) return null;
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (!bytes.length) return null;
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const row = canvasDxosStore.resourceByChecksum(checksum, bytes.length);
    if (!row || !row.resource_id) return null;
    if (bound.viewerId && row.owner_user_id != null && String(row.owner_user_id) !== String(bound.viewerId)) return null;
    return "openarc-asset:" + String(row.resource_id);
  }

  function directRef(value) {
    return typeof value === "string" && ASSET_REF_RE.test(value) ? value : null;
  }

  function resolveMediaRef(spec) {
    const direct = directRef(spec.url) || directRef(spec.ref) || (Array.isArray(spec.refs) ? spec.refs.map(directRef).find(Boolean) : null);
    if (direct) return direct;
    for (const item of Array.isArray(spec.inputs) ? spec.inputs : []) {
      if (typeof item === "string") { const hit = directRef(item); if (hit) return hit; continue; }
      if (!isPlain(item)) continue;
      const inline = directRef(item.url) || directRef(item.ref) || (Array.isArray(item.refs) ? item.refs.map(directRef).find(Boolean) : null);
      if (inline) return inline;
      const viaBytes = refFromFsNode(item.nodeId);
      if (viaBytes) return viaBytes;
    }
    return null;
  }

  /**
   * fs 节点字节 → 资源域 ResourceRef（异步）。画布文档只存 openarc-asset 引用，而 app-exchange 的
   * canvas 分支只有 dxos 虚拟树里的 fs 副本（/api/fs/raw/<nodeId>），故需要时经既有
   * resourceService.importManaged 先把字节落进资源域。已有同 owner 资源时直接复用（refFromFsNode，
   * 与素材库同一套 checksum 去重），避免重复 resource_registry 行。
   * 不是假成功：资源域不可用 / 导入失败一律抛结构化 APP_EXCHANGE_DEPENDENCY_UNAVAILABLE。
   */
  async function resolveCanvasRef({ nodeId, name, mime, canvasId } = {}) {
    const existing = refFromFsNode(nodeId);
    if (existing) return existing;
    let raw = null;
    try { if (readBlobFn && nodeId) raw = readBlobFn(String(nodeId)); } catch { raw = null; }
    const bytes = raw == null ? null : (Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    if (!bytes || !bytes.length) throw aeDependency("resolveCanvasRef", { missing: "fs-node-to-ResourceRef" });
    if (!resourceService || typeof resourceService.importManaged !== "function") throw aeDependency("resourceService", { missing: "resourceService.importManaged" });
    const display = clip(name, 120) || "canvas-image";
    const dir = path.join(os.tmpdir(), "openarc-canvas-exchange");
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const safe = String(display).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "canvas-image";
    const file = path.join(dir, "app-exchange-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8) + "-" + safe);
    fs.writeFileSync(file, bytes);
    try {
      // appId 与既有导入路径一致（canvas-service.importAsset / asset-library 都走 resource-library）。
      const imported = await resourceService.importManaged({
        context: { ...ctxOf("app-exchange"), appId: "resource-library", canvasId: clip(canvasId, 120) || undefined },
        sourcePath: file, name: display, resourceType: "image", mimeType: clip(mime, 60) || undefined, scope: "PERSONAL",
      });
      if (!imported || imported.ok !== true) throw aeDependency("resourceService", { missing: "fs-node-to-ResourceRef", reason: (imported && imported.error) || "IMPORT_FAILED" });
      const id = imported.resource && (imported.resource.resourceId || imported.resource.resourceRef);
      if (!id) throw aeDependency("resourceService", { missing: "fs-node-to-ResourceRef", reason: "NO_RESOURCE_REF" });
      return "openarc-asset:" + String(id).replace(/^openarc-asset:/, "").replace(/^openarc-resource:/, "").replace(/^resource:\/\//, "");
    } finally {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
  }

  function createCanvasCard(x, y, spec) {
    requireCanvasService();
    const input = isPlain(spec) ? spec : {};
    const ref = resolveMediaRef(input);
    if (!ref) {
      throw aeDependency("createCanvasCard", {
        missing: "fs-node-to-ResourceRef",
        hint: "画布节点 url 只接受 openarc-asset:<ResourceRef>；app-exchange 传的是 /api/fs/raw/<fsNodeId>，同步 createCanvasCard 解析不了 fs-only 字节（resourceService.importManaged 是异步）。app-exchange-service 的 canvas 分支会先 await 端口 resolveCanvasRef 拿到引用；直接调用本函数时请先经该端口导入，或传入已知的 openarc-asset 引用。",
      });
    }
    const params = isPlain(input.params) ? input.params : undefined;
    if (params) assertRefOnly(params, "params");
    const card = {
      id: clip(input.id, 120) || newCardId(),
      type: "image",
      x: num(x),
      y: num(y),
      w: Math.max(1, num(input.w, DEFAULT_CARD_WIDTH)),
      h: Math.max(1, num(input.h, DEFAULT_CARD_HEIGHT)),
      title: clip(input.title, 200) || undefined,
      name: clip(input.name, 200) || clip(input.title, 200) || undefined,
      url: ref,
      refs: [ref],
      mediaKind: "image",
      inputs: sanitizeInputs(input.inputs, ref),
      params,
    };
    const canvasId = clip(input.canvasId, 120) || bound.canvasId;
    if (canvasId) {
      const res = canvasService.applyCommand({
        context: ctxOf("app-exchange"), canvasId, baseRevision: null, actorKind: "USER",
        command: { type: "node.add", node: cardToAddNode(card) },
      });
      if (!res || res.ok !== true) throw canvasFailure(res, "CREATE_CARD_FAILED");
      const created = res.result && res.result.node ? res.result.node : null;
      if (created && created.id) card.id = created.id;
      card.canvasId = canvasId;
      card.revision = res.canvas ? res.canvas.revision : null;
    }
    return card;
  }

  function syncCanvas(canvasId, viewer, patch) {
    const service = requireCanvasService();
    const id = String(canvasId == null ? "" : canvasId);
    const upserts = patch && Array.isArray(patch.upserts) ? patch.upserts : [];
    let view = viewOf(id);
    if (!view) throw aeNotFound("目标画布不存在或没有访问权限");
    if (!view.canvas.access || !view.canvas.access.canEdit) throw aeForbidden("目标画布不可编辑");
    for (const card of upserts) {
      const input = isPlain(card) ? card : {};
      const id2 = clip(input.id, 120);
      if (!id2) throw aeInvalid("画布卡片缺少 id", { field: "upserts[].id" });
      const existing = (Array.isArray(view.canvas.doc && view.canvas.doc.nodes) ? view.canvas.doc.nodes : []).some((node) => node && node.id === id2);
      const command = existing
        ? { type: "node.edit", id: id2, patch: cardToEditPatch(input) }
        : { type: "node.add", node: cardToAddNode(input) };
      if (command.type === "node.edit" && !Object.keys(command.patch).length) continue;
      const res = service.applyCommand({ context: ctxOf("app-exchange"), canvasId: id, baseRevision: null, command, actorKind: "USER" });
      if (!res || res.ok !== true) throw canvasFailure(res, "SYNC_CANVAS_FAILED");
      view = { ok: true, canvas: res.canvas };
    }
    return { version: view.canvas.revision, revision: view.canvas.revision, canvasId: id };
  }

  function canViewCanvasMedia(nodeId, viewer, canvasId) {
    const view = viewOf(canvasId);
    return !!(view && view.canvas.access && view.canvas.access.canView);
  }

  /** 素材库可见性：与 CanvasAssetLibraryService.#access（canvas-dxos-asset-library.cjs:100-106）同一规则，
   *  不新建判定 —— owner 可编辑，ORGANIZATION 库对同组织成员只读可见。 */
  function canViewAssetLibrary(libraryId, viewer) {
    if (!canvasDxosStore || typeof canvasDxosStore.libraryById !== "function") return false;
    const row = canvasDxosStore.libraryById(String(libraryId || ""));
    if (!row || row.deleted_at) return false;
    if (String(row.owner_user_id) === String(viewer.id != null ? viewer.id : "")) return true;
    return row.visibility === "ORGANIZATION" && String(row.organization_id) === String(viewer.team_id || "");
  }

  /** fs 节点可读判定：共享区（public / department: / canvas: / asset-library:）沿祖先继承，否则看 ownerId。 */
  function canRead(viewer, node) {
    if (!viewer || !isPlain(node)) return false;
    if (node.trashed) return false;
    const userId = viewer.id != null ? String(viewer.id) : "";
    const zone = fsRoot && typeof fsRoot.shareZoneOf === "function" ? fsRoot.shareZoneOf(node.id) : null;
    if (!zone) return node.ownerId != null && String(node.ownerId) === userId;
    if (zone === "public") return true;
    if (zone.startsWith("department:")) return String(viewer.team_id || "") === zone.slice("department:".length);
    if (zone.startsWith("canvas:")) return canViewCanvasMedia(node.id, viewer, zone.slice("canvas:".length));
    if (zone.startsWith("asset-library:")) return canViewAssetLibrary(zone.slice("asset-library:".length), viewer);
    return false;
  }

  // ---------------------------------------------------------------- photos importer

  function naturalCardSize() {
    return { w: DEFAULT_CARD_WIDTH, h: DEFAULT_CARD_HEIGHT };
  }

  async function importToCanvas({ data, name, mime, targetId, prompt, sourceId }) {
    const service = requireCanvasServicePhotos();
    const canvasId = String(targetId == null ? "" : targetId);
    const view = viewOf(canvasId, "photos");
    if (!view) throw photosNotFound("目标画布不存在或没有访问权限");
    if (!view.canvas.access || !view.canvas.access.canEdit) throw photosForbidden("没有编辑目标画布的权限");
    if (typeof service.importAsset !== "function") throw photosDependency("canvasService.importAsset");
    const mimeType = String(mime || "").startsWith("image/") ? String(mime) : "image/png";
    const display = clip(name, 120) || "photo-image";
    const imported = await service.importAsset({
      context: ctxOf("photos"), canvasId,
      name: display,
      dataUrl: "data:" + mimeType + ";base64," + data.toString("base64"),
    });
    if (!imported || imported.ok !== true) throw photosDependency("canvasService.importAsset", { reason: (imported && imported.error) || "IMPORT_FAILED" });
    const ref = String(imported.ref || "");
    if (!ASSET_REF_RE.test(ref)) throw photosDependency("canvasService.importAsset", { reason: "NO_RESOURCE_REF" });
    const size = naturalCardSize();
    const occupied = (Array.isArray(view.canvas.doc && view.canvas.doc.nodes) ? view.canvas.doc.nodes : []).map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h }));
    const placement = findNearestCanvasPlacement({ desired: CARD_DESIRED, size, occupied });
    const node = {
      type: "image", x: placement.x, y: placement.y, w: size.w, h: size.h,
      name: display, title: clip(name, 200) || display, url: ref, refs: [ref], mediaKind: "image",
      ...(sourceId ? { inputs: sanitizeInputs([{ nodeId: sourceId, name: display, kind: "image", role: "input", w: size.w, h: size.h }], ref) } : {}),
      ...(prompt ? { params: { prompt: clip(prompt, 20000) } } : {}),
    };
    const res = service.applyCommand({ context: ctxOf("photos"), canvasId, baseRevision: view.canvas.revision, command: { type: "node.add", node }, actorKind: "USER" });
    if (!res || res.ok !== true) throw photosCanvasFailure(res);
    const created = res.result && res.result.node ? res.result.node : null;
    return { cardId: created ? created.id : null, nodeId: created ? created.id : null };
  }

  function requireCanvasServicePhotos() {
    if (!canvasService) throw photosDependency("canvasService");
    return canvasService;
  }

  function photosCanvasFailure(res) {
    const reason = String((res && res.error) || "CANVAS_ERROR");
    if (reason === "LIMIT_EXCEEDED") return photosDomain.createPhotosError(photosDomain.PHOTOS_ERR_TOO_LARGE, "画布节点数已达上限", { reason });
    if (reason === "READ_ONLY" || reason === "NOT_FOUND_OR_FORBIDDEN") return photosForbidden("目标画布不可编辑", { reason });
    if (reason === "INVALID_INPUT" || reason === "UNSUPPORTED_COMMAND") return photosInvalid("画布命令不合法", { reason });
    return photosDependency("canvasService", { reason });
  }

  function mapLibraryFailure(res) {
    const reason = String((res && res.error) || "IMPORT_FAILED");
    if (reason === "NOT_FOUND") return photosNotFound("目标素材库不存在或没有访问权限", { reason });
    if (reason === "READ_ONLY" || reason === "FORBIDDEN") return photosForbidden("没有编辑目标素材库的权限", { reason });
    if (reason === "RESOURCE_UNAVAILABLE" || reason === "CANVAS_UNAVAILABLE") return photosDependency("resourceService", { reason });
    if (reason === "INVALID_INPUT" || reason === "LIMIT_EXCEEDED") return photosInvalid("素材库导入被拒绝", { reason });
    return photosDependency("assetLibrary", { reason });
  }

  async function importToLibrary({ data, name, mime, targetId }) {
    if (!assetLibrary || typeof assetLibrary.importAssetItem !== "function") throw photosDependency("assetLibrary", { hint: "需要注入 identity.canvasAssetLibrary" });
    const mimeType = String(mime || "").startsWith("image/") ? String(mime) : "image/png";
    const display = clip(name, 160) || "未命名素材";
    const imported = await assetLibrary.importAssetItem({
      context: ctxOf("photos"), libraryId: String(targetId == null ? "" : targetId),
      name: display, mime: mimeType, base64: data.toString("base64"), title: display,
    });
    if (!imported || imported.ok !== true) throw mapLibraryFailure(imported);
    return { itemId: imported.item.id, item: imported.item };
  }

  /** photos-service.cjs:663 的调用面：destination 只认 canvas / library。 */
  async function importer(input = {}) {
    const destination = String(input.destination || "");
    const data = Buffer.isBuffer(input.data) ? input.data : (input.data instanceof Uint8Array ? Buffer.from(input.data) : Buffer.from(input.data || []));
    const viewer = isPlain(input.user) ? input.user : { id: input.userId };
    if (!data.length) throw photosInvalid("图片内容为空");
    if (destination === "canvas") return importToCanvas({ data, name: input.name, mime: input.mime, targetId: input.targetId, prompt: input.prompt, sourceId: input.sourceId });
    if (destination === "library") return importToLibrary({ data, name: input.name, mime: input.mime, targetId: input.targetId });
    throw photosInvalid("请选择图片和导入目标", { destinations: ["canvas", "library"] });
  }

  return {
    importer,
    ports: {
      getCanvas,
      canEditCanvas,
      canvasFolder,
      createCanvasCard,
      resolveCanvasRef,
      findNearestCanvasPlacement,
      syncCanvas,
      canViewCanvasMedia,
      canRead,
    },
    /** 可用性事实（布尔，缺失不降级成假成功）。 */
    dependencies: Object.freeze({
      canvasService: !!canvasService,
      assetLibrary: !!assetLibrary,
      resourceService: !!resourceService,
      resourceStore: !!resourceStore,
      canvasDxosStore: !!canvasDxosStore,
      fsStore: !!(fsRoot && typeof fsRoot.ensureCanvasRoot === "function"),
    }),
  };
}

module.exports = {
  createCanvasExchangePorts,
  findNearestCanvasPlacement,
  ASSET_REF_RE,
  DEFAULT_CARD_WIDTH,
  DEFAULT_CARD_HEIGHT,
  CARD_DESIRED,
};
