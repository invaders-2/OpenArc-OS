/**
 * 应用互传域 · 服务层（命令分发 + 幂等落库 + 注入端口编排）。
 *
 * 逐段移植自只读源（行号为源文件行号）：
 *   · server/appExchange.ts:52-56   getAppExchange（按 id + user_id 只读，仅本人）
 *   · server/appExchange.ts:57-58   inFlight 单飞：并发重试共享同一 promise
 *   · server/appExchange.ts:59-67   同 requestId 同 fingerprint 复用、不同 fingerprint 拒绝
 *   · server/appExchange.ts:68-73   落库前先查 (user_id, request_id) 复用既有结果
 *   · server/appExchange.ts:74-88   资产鉴权 → 目标校验（先于读字节）→ 读 blob → sharp 元数据 → 二次鉴权
 *   · server/appExchange.ts:89-142  三个 target 的落点：image.receive 复制节点 / image.edit 建项目 / canvas 建卡片
 *   · server/appExchange.ts:131-133 ExchangeResult 组装并以 (user_id, request_id) 唯一键插入
 *   · server/appExchange.ts:135-141 提交成功后通知 changed；失败按 copiedId 回收副本
 *   · server/appExchangeRoutes.ts:14-28  targets / get / inspect / exchange 的鉴权与返回形状
 *   · server/appExchangeRoutes.ts:29-47  app-exchange-images：multipart 字节上传（唯一字节通道）
 *
 * ## 与源不同的点（有意为之）
 *   · **端口注入取代直接 import**：photos / photocraft / canvas 三个域正被并行实现，这里只吃
 *     `ports`（{ getNode, readBlob, saveBlob, createNode, getCanvas, canEditCanvas, canvasFolder,
 *     createCanvasCard, resolveCanvasRef, findNearestCanvasPlacement, syncCanvas, canViewCanvasMedia, listCanvases,
 *     ensureCanvasRoot, ensureFolder, purgeNode, createPhotoCraftProject, canViewPhotoCraftFile,
 *     canRead, canOpen, changed, sharpLoader }）。未注入即结构化 DEPENDENCY_UNAVAILABLE，绝不假成功。
 *   · **express / multer 不进主进程**：源路由由 HTTP 承担，这里改由 appExchange:command 承载；
 *     appExchange-images 直接吃 Buffer / Uint8Array / base64，等价于源 multer 的 memoryStorage。
 *   · **事务边界**：源用 better-sqlite3 的 ccsDb.transaction(...).immediate() 把建节点 + 插入结果
 *     包成一个同步事务；本移植的端口可以是 async（图像工坊建项目 / 画布 sync），因此不做跨端口长事务，
 *     改为"目标操作成功后再单条 INSERT"，用表自带的 UNIQUE(user_id, request_id) + inFlight 单飞兜住
 *     并发幂等；冲突时回收本次副本并回既有结果（源 :69-72 的等价物）。
 *   · **不新增 / 不修改表**：app_exchanges 已由 identity-store.cjs v27（dxos-foundation-schema.cjs:280）
 *     建好，本文件没有任何 CREATE / ALTER，也不动 SCHEMA_VERSION。
 *   · **不实现任何云能力**：不引用 cloudAccount / apiQuota / api.dx-os.com。
 */
"use strict";

const { randomUUID, createHash } = require("node:crypto");
const domain = require("./app-exchange-domain.cjs");

const {
  MAX_IMAGE_BYTES,
  APP_EXCHANGE_FOLDER_NAME,
  IMAGE_STUDIO_APP_ID,
  CANVAS_APP_ID,
  EXCHANGE_ACCEPTED_MIMES,
} = domain;

/** 承载应用互传的 App Principal（bootstrap 缺省 appId）。 */
const HOST_APP_ID = "app-exchange";
/** 下行事件通道名（<domain>:event 约定）；main.cjs 接线时用来把 changed 通知推给渲染层。 */
const APP_EXCHANGE_EVENT_CHANNEL = "appExchange:event";

const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);

/** 源 appExchangeRoutes.ts:31：multer memoryStorage 的等价物（Buffer / Uint8Array / ArrayBuffer / base64）。 */
function decodeImageBytes(payload) {
  const raw = payload.bytes !== undefined ? payload.bytes : payload.data;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (typeof raw === "string" && payload.encoding === "base64") return Buffer.from(raw, "base64");
  throw domain.invalidInput("需要图片字节（bytes 或 encoding=base64 的 data）", { field: "bytes" });
}

/** 源 appExchange.ts:53 / :69 / :132 使用的三张查询；表已由 v27 建好。 */
function createExchangeStore(db) {
  return {
    findById(userId, id) {
      return db.prepare("SELECT result_json FROM app_exchanges WHERE id=? AND user_id=?").get(String(id), String(userId)) || null;
    },
    findByRequest(userId, requestId) {
      return db.prepare("SELECT fingerprint,result_json FROM app_exchanges WHERE user_id=? AND request_id=?").get(String(userId), String(requestId)) || null;
    },
    insert({ id, userId, requestId, fingerprint, resultJson, createdAt }) {
      db.prepare("INSERT INTO app_exchanges(id,user_id,request_id,fingerprint,result_json,created_at) VALUES (?,?,?,?,?,?)").run(String(id), String(userId), String(requestId), String(fingerprint), String(resultJson), Number(createdAt));
    },
  };
}

function isUniqueViolation(error) {
  return /UNIQUE|constraint/i.test(String((error && (error.message || error.code)) || ""));
}

/**
 * 装配应用互传域。
 * @param identity      IdentityStore（取 connection / clock）——真实接线由 Lead 注入。
 * @param db            node:sqlite DatabaseSync（可选；identity.connection 优先路径的显式替代，供测试）。
 * @param authorization 授权服务（resolveActor，与 file-transfer-service.cjs:262-271 同一形状）。
 * @param ports         依赖注入端口；缺哪个就在用到那个命令时结构化依赖不可用。
 * @param clock / logger 可选。
 */
function createAppExchangeBundle({ identity = null, db = null, authorization = null, ports = null, clock = null, logger = null } = {}) {
  const database = db || (identity && identity.connection) || null;
  const portSet = ports && typeof ports === "object" ? ports : {};
  const clockFn = typeof clock === "function" ? clock : (identity && typeof identity.clock === "function" ? identity.clock : () => Date.now());
  const store = database ? createExchangeStore(database) : null;
  /** 源 appExchange.ts:58：同一 (user, requestId) 的并发重试共享同一 promise。 */
  const inFlight = new Map();

  function requirePort(name) {
    if (typeof portSet[name] !== "function") throw domain.dependencyUnavailable(name);
    return portSet[name];
  }

  function requireDatabase() {
    if (!store) throw domain.dependencyUnavailable("identity.connection");
    return store;
  }

  /** sharp 只能惰性 require（铁律 1）；缺失即结构化不可用，不回落成假成功。 */
  let cachedSharp = null;
  function resolveSharp() {
    if (typeof portSet.sharpLoader === "function") {
      let loaded = null;
      try { loaded = portSet.sharpLoader(); } catch (error) {
        throw domain.createAppExchangeError(domain.APP_EXCHANGE_ERR_IMAGE_ENGINE_UNAVAILABLE, "sharp 未安装，无法校验图片", { causeCode: (error && error.code) || "SHARP_LOAD_FAILED" });
      }
      if (typeof loaded !== "function") throw domain.createAppExchangeError(domain.APP_EXCHANGE_ERR_IMAGE_ENGINE_UNAVAILABLE, "sharp 未安装，无法校验图片", { causeCode: "SHARP_LOAD_FAILED" });
      return loaded;
    }
    if (cachedSharp) return cachedSharp;
    try { cachedSharp = require("sharp"); } catch (error) {
      throw domain.createAppExchangeError(domain.APP_EXCHANGE_ERR_IMAGE_ENGINE_UNAVAILABLE, "sharp 未安装，无法校验图片", { causeCode: (error && error.code) || "SHARP_UNAVAILABLE" });
    }
    return cachedSharp;
  }

  /** 源 appExchange.ts:39-51。 */
  function inspectExchangeAsset(viewer, asset) {
    const getNode = requirePort("getNode");
    const isInTrash = requirePort("isInTrash");
    const node = getNode(asset.nodeId);
    if (!node || node.type !== "file" || isInTrash(node.id)) throw domain.notFound("素材不存在或已删除");
    let checked = false;
    let allowed = false;
    if (typeof portSet.canRead === "function") { checked = true; allowed = !!portSet.canRead(viewer, node); }
    if (!allowed && asset.canvasId) { const canView = requirePort("canViewCanvasMedia"); checked = true; allowed = !!canView(asset.nodeId, viewer, asset.canvasId); }
    if (!allowed && asset.photoCraftProjectId) { const canView = requirePort("canViewPhotoCraftFile"); checked = true; allowed = !!canView(asset.nodeId, viewer, asset.photoCraftProjectId); }
    if (!checked) throw domain.dependencyUnavailable("canRead");
    if (!allowed) throw domain.forbidden("没有读取该素材的权限");
    if (!EXCHANGE_ACCEPTED_MIMES.includes(node.mime || "")) throw domain.invalidInput("目前仅支持 PNG、JPEG、WebP 图片", { field: "asset.nodeId" });
    if (!node.size || node.size > MAX_IMAGE_BYTES) throw domain.createAppExchangeError(domain.APP_EXCHANGE_ERR_TOO_LARGE, "图片大小必须在 1 字节到 64 MB 之间");
    const revision = node.blobSha256 || String(node.updated_ts);
    if (asset.revision && asset.revision !== revision) throw domain.createAppExchangeError(domain.APP_EXCHANGE_ERR_STALE_REVISION, "来源图片已变化，请重新发送");
    return { node, revision };
  }

  /** 源 appExchange.ts:78-79。 */
  function readImageBytes(nodeId) {
    const readBlob = requirePort("readBlob");
    const raw = readBlob(nodeId);
    if (!raw) throw domain.notFound("图片文件不存在或已删除");
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw domain.createAppExchangeError(domain.APP_EXCHANGE_ERR_TOO_LARGE, "图片文件不存在或超过 64 MB");
    return bytes;
  }

  /** 源 appExchange.ts:80：sharp(bytes, { limitInputPixels }).metadata()。 */
  async function readImageMetadata(bytes) {
    const sharp = resolveSharp();
    try {
      return await sharp(bytes, { limitInputPixels: domain.MAX_IMAGE_PIXELS }).metadata();
    } catch (error) {
      throw domain.createAppExchangeError(domain.APP_EXCHANGE_ERR_IMAGE_INVALID, "图片格式无效", { causeCode: (error && error.code) || "IMAGE_DECODE_FAILED" });
    }
  }

  function parseResult(json) {
    try { return JSON.parse(json); } catch (error) {
      throw domain.createAppExchangeError(domain.APP_EXCHANGE_ERR_INTERNAL, "发送记录已损坏", { causeCode: "RESULT_JSON_INVALID" });
    }
  }

  /** 源 appExchangeRoutes.ts:14-17：按 canOpen 过滤 target；画布可写清单只在 canvas 可用时返回。 */
  function listTargets(viewer) {
    const canOpen = requirePort("canOpen");
    const targets = domain.APP_EXCHANGE_TARGETS.filter((target) => canOpen(viewer, target.appId));
    let canvases = [];
    if (targets.some((target) => target.appId === CANVAS_APP_ID)) {
      const listCanvases = requirePort("listCanvases");
      canvases = (listCanvases(viewer) || []).filter((canvas) => canvas && canvas.access !== "read").map((canvas) => ({ id: canvas.id, title: canvas.title }));
    }
    return { version: domain.APP_EXCHANGE_VERSION, targets: targets.map((target) => ({ ...target })), canvases };
  }

  /** 源 appExchange.ts:52-56。 */
  function getAppExchange(viewer, id) {
    const rows = requireDatabase();
    const key = typeof id === "string" ? id.trim() : "";
    if (!key || key.length > 128) throw domain.invalidInput("发送记录 ID 无效", { field: "id" });
    const row = rows.findById(viewer.id, key);
    if (!row) throw domain.notFound("发送记录不存在");
    return parseResult(row.result_json);
  }

  function purgeCreated(created) {
    for (const createdId of created.reverse()) {
      try { if (typeof portSet.purgeNode === "function") portSet.purgeNode(createdId); } catch (error) { /* 尽力回收孤儿副本 */ }
    }
  }

  /** 源 appExchange.ts:89-142：目标落点 + 结果落库 + 失败回收。 */
  async function commitTarget(viewer, input, node, bytes, metadata, revision, sha256, fingerprint) {
    const rows = requireDatabase();
    const created = [];
    let committed = false;
    try {
      let target;
      let patch;
      if (input.target.appId === IMAGE_STUDIO_APP_ID && input.target.action === "image.receive") {
        // 源 :99-103：receive 只复制一份文件引用到「应用互联」，不覆盖任何已有文档。
        const ensureCanvasRoot = requirePort("ensureCanvasRoot");
        const ensureFolder = requirePort("ensureFolder");
        const createNode = requirePort("createNode");
        const saveBlob = requirePort("saveBlob");
        const folder = ensureFolder(APP_EXCHANGE_FOLDER_NAME, ensureCanvasRoot(viewer.id).id, viewer.id);
        const copied = createNode({ name: node.name, type: "file", parentId: folder, ownerId: viewer.id, mime: node.mime, size: bytes.length });
        created.push(copied.id);
        saveBlob(copied.id, bytes);
        target = { appId: IMAGE_STUDIO_APP_ID, projectId: "", assetNodeId: copied.id };
      } else if (input.target.appId === IMAGE_STUDIO_APP_ID) {
        // 源 :104-107：image.edit 新建图像工坊项目（不覆盖已有项目，projectId 已被 validate 拒绝）。
        const createPhotoCraftProject = requirePort("createPhotoCraftProject");
        const createdProject = await createPhotoCraftProject(viewer, { name: node.name, mime: node.mime, content: bytes });
        const projectId = createdProject && createdProject.project && createdProject.project.id;
        if (!projectId) throw domain.createAppExchangeError(domain.APP_EXCHANGE_ERR_INTERNAL, "图像工坊未返回项目 ID");
        if (createdProject.source && createdProject.source.id) created.push(createdProject.source.id);
        target = { appId: IMAGE_STUDIO_APP_ID, projectId: String(projectId) };
      } else {
        // 源 :108-129：canvas 落一个素材节点 + 一张已定位的图片卡片。
        const getCanvas = requirePort("getCanvas");
        const canEditCanvas = requirePort("canEditCanvas");
        const canvasFolder = requirePort("canvasFolder");
        const createNode = requirePort("createNode");
        const saveBlob = requirePort("saveBlob");
        const createCanvasCard = requirePort("createCanvasCard");
        const findNearestCanvasPlacement = requirePort("findNearestCanvasPlacement");
        const syncCanvas = requirePort("syncCanvas");
        const canvas = getCanvas(input.target.projectId, viewer);
        if (!canvas || !canEditCanvas(canvas.id, viewer)) throw domain.forbidden("目标画布不可编辑");
        const copied = createNode({ name: node.name, type: "file", parentId: canvasFolder(canvas, viewer), mime: node.mime, size: bytes.length, ownerId: canvas.ownerId });
        created.push(copied.id);
        saveBlob(copied.id, bytes);
        // 画布文档只存 openarc-asset 引用：fs 副本字节还不在资源域时，先 await 注入端口导入拿 ResourceRef
        // 再建卡片（端口未注入则保持旧路径，createCanvasCard 内部还会做一次同步 checksum 解析）。
        const resolveCanvasRef = typeof portSet.resolveCanvasRef === "function" ? portSet.resolveCanvasRef : null;
        const mediaRef = resolveCanvasRef ? await resolveCanvasRef({ nodeId: copied.id, name: node.name, mime: node.mime, canvasId: canvas.id }) : null;
        const rotated = [5, 6, 7, 8].includes(Number(metadata.orientation));
        const width = rotated ? metadata.height : metadata.width;
        const height = rotated ? metadata.width : metadata.height;
        const card = createCanvasCard(0, 0, {
          title: node.name,
          w: domain.CANVAS_CARD_WIDTH,
          h: Math.max(domain.CANVAS_CARD_MIN_HEIGHT, Math.min(domain.CANVAS_CARD_MAX_HEIGHT, Math.round((domain.CANVAS_CARD_WIDTH * height) / width))),
          ...(typeof mediaRef === "string" && mediaRef ? { url: mediaRef } : {}),
          inputs: [{ nodeId: copied.id, name: node.name, url: "/api/fs/raw/" + copied.id, kind: "image", role: "input", w: width, h: height }],
          params: { mode: "i2i", protocolParams: { mediaManualSize: true, mediaFrameLocked: true } },
        });
        const viewport = (canvas && canvas.viewport) || {};
        const scale = Math.max(0.2, Number(viewport.scale) || 1);
        Object.assign(card, findNearestCanvasPlacement({
          desired: {
            x: Math.round((domain.CANVAS_CARD_DESIRED.x - (Number(viewport.x) || 0)) / scale),
            y: Math.round((domain.CANVAS_CARD_DESIRED.y - (Number(viewport.y) || 0)) / scale),
          },
          size: { w: card.w, h: card.h },
          occupied: (canvas.cards || []).filter((item) => !item.groupId).map((item) => ({ x: item.x, y: item.y, w: item.w, h: item.h })),
        }));
        const saved = syncCanvas(canvas.id, viewer, { upserts: [card] });
        patch = { version: saved && saved.version, upserts: [card] };
        target = { appId: CANVAS_APP_ID, projectId: canvas.id, cardId: card.id };
      }
      const id = randomUUID();
      const createdAt = Number(clockFn());
      const result = { id, status: "completed", target, source: { ...input.asset, revision }, asset: { name: node.name, mime: node.mime, size: bytes.length, sha256 }, createdAt };
      try {
        rows.insert({ id, userId: viewer.id, requestId: input.requestId, fingerprint, resultJson: JSON.stringify(result), createdAt });
      } catch (error) {
        // 跨进程 / 竞态兜底：UNIQUE(user_id, request_id) 命中即回既有结果，并回收本次副本。
        const raced = isUniqueViolation(error) ? rows.findByRequest(viewer.id, input.requestId) : null;
        if (raced && raced.fingerprint === fingerprint) {
          purgeCreated(created);
          return parseResult(raced.result_json);
        }
        if (raced) throw domain.conflict("请求 ID 已用于其他发送操作");
        throw error;
      }
      committed = true;
      // 源 :136-137：通知失败绝不能把已提交的导入变成失败重试。
      try { if (typeof portSet.changed === "function") portSet.changed(result.target.appId === CANVAS_APP_ID ? result.target.projectId : undefined, patch); } catch (error) { /* 客户端可自行刷新 */ }
      return result;
    } catch (error) {
      if (!committed) purgeCreated(created);
      throw error;
    }
  }

  /** 源 appExchange.ts:59-146。 */
  async function sendAppExchange(viewer, raw) {
    requireDatabase();
    const input = domain.validateExchangeRequest(raw);
    const fingerprint = domain.fingerprintOf(input);
    const key = String(viewer.id) + ":" + input.requestId;
    const pending = inFlight.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw domain.conflict("请求 ID 已用于其他发送操作");
      return pending.promise;
    }
    const execute = async () => {
      // 源 appExchangeRoutes.ts:24：打开目标应用的权限先于幂等复用判定。
      const canOpen = requirePort("canOpen");
      if (!canOpen(viewer, input.target.appId)) throw domain.forbidden("没有打开目标应用的权限");
      const rows = requireDatabase();
      const previous = rows.findByRequest(viewer.id, input.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw domain.conflict("请求 ID 已用于其他发送操作");
        return parseResult(previous.result_json);
      }
      const { node, revision } = inspectExchangeAsset(viewer, input.asset);
      // 源 :75-77：目标校验先于读取或发布任何字节。
      if (input.target.appId === CANVAS_APP_ID) {
        const canvas = requirePort("getCanvas")(input.target.projectId, viewer);
        if (!canvas || !requirePort("canEditCanvas")(canvas.id, viewer)) throw domain.forbidden("目标画布不可编辑");
      }
      const bytes = readImageBytes(node.id);
      const metadata = await readImageMetadata(bytes);
      domain.evaluateImageMetadata(metadata, node.mime);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      // 源 :87-88：异步校验后重新鉴权（权限可能已被撤销）。
      inspectExchangeAsset(viewer, { ...input.asset, revision });
      return commitTarget(viewer, input, node, bytes, metadata, revision, sha256, fingerprint);
    };
    const promise = execute();
    inFlight.set(key, { fingerprint, promise });
    try { return await promise; } finally { inFlight.delete(key); }
  }

  /** 源 appExchangeRoutes.ts:32-47：唯一允许字节的通道（等价 multer memoryStorage + 落节点）。 */
  function receiveImage(viewer, payload) {
    if (!domain.isPlainObject(payload)) throw domain.invalidInput("appExchange-images 需要对象载荷");
    const canOpen = requirePort("canOpen");
    if (!canOpen(viewer, IMAGE_STUDIO_APP_ID)) throw domain.forbidden("没有打开图像工坊的权限");
    const mime = typeof payload.mime === "string" ? payload.mime.slice(0, 60) : "";
    if (!EXCHANGE_ACCEPTED_MIMES.includes(mime)) throw domain.invalidInput("请选择支持的图片", { field: "mime" });
    const bytes = decodeImageBytes(payload);
    if (!bytes.length) throw domain.invalidInput("请选择支持的图片", { field: "bytes" });
    if (bytes.length > MAX_IMAGE_BYTES) throw domain.createAppExchangeError(domain.APP_EXCHANGE_ERR_TOO_LARGE, "图片上传失败，最大支持 64 MB");
    const name = domain.sanitizeImageName(payload.name);
    const ensureCanvasRoot = requirePort("ensureCanvasRoot");
    const ensureFolder = requirePort("ensureFolder");
    const createNode = requirePort("createNode");
    const saveBlob = requirePort("saveBlob");
    const ownerId = viewer.id;
    const folder = ensureFolder(APP_EXCHANGE_FOLDER_NAME, ensureCanvasRoot(ownerId).id, ownerId);
    const node = createNode({ name, type: "file", parentId: folder, ownerId, mime, size: bytes.length });
    try {
      saveBlob(node.id, bytes);
    } catch (error) {
      try { if (typeof portSet.purgeNode === "function") portSet.purgeNode(node.id); } catch (cleanupError) { /* 尽力回收 */ }
      throw error;
    }
    return { asset: { nodeId: node.id } };
  }

  async function dispatch(command, payload, viewer) {
    switch (command) {
      case "appExchange/targets":
        return listTargets(viewer);
      case "appExchange/get":
        return getAppExchange(viewer, payload.id);
      case "appExchange/inspect": {
        domain.assertReferenceOnly(payload);
        const asset = domain.normalizeExchangeAsset(payload.asset);
        const { node, revision } = inspectExchangeAsset(viewer, asset);
        return { asset: { nodeId: node.id, name: node.name, size: node.size, mime: node.mime, revision } };
      }
      case "appExchange/exchange":
        return sendAppExchange(viewer, payload);
      case "appExchange-images":
        return receiveImage(viewer, payload);
      default:
        throw domain.appExchangeCommandNotAllowed(command);
    }
  }

  /** sessionRef → actor；不可解析即 { ok:false }，绝不伪造身份（同 file-transfer-service.cjs:262-271）。 */
  function resolveActor(context) {
    if (!authorization || typeof authorization.resolveActor !== "function") return { ok: false, message: "授权服务未装配" };
    try {
      const result = authorization.resolveActor({ context });
      if (!result || result.ok !== true || !result.user || result.user.id == null) return { ok: false, message: (result && (result.error || result.reason)) || "会话无效" };
      return result;
    } catch (error) {
      return { ok: false, message: String((error && error.message) || error) };
    }
  }

  /** 唯一命令入口：白名单 → actor 解析 → dispatch → 脱敏；失败统一 normalizeAppExchangeError。 */
  async function execute(command, payload, ctx = {}) {
    if (!domain.isAppExchangeCommand(command)) return domain.normalizeAppExchangeError(domain.appExchangeCommandNotAllowed(command));
    const context = {
      sessionRef: clip(ctx && ctx.sessionRef, 160),
      appId: clip(ctx && ctx.appId, 60) || HOST_APP_ID,
      source: HOST_APP_ID,
      requestId: clip(ctx && ctx.requestId, 100),
    };
    const actorResult = resolveActor(context);
    if (!actorResult.ok) {
      return domain.normalizeAppExchangeError(domain.createAppExchangeError(domain.APP_EXCHANGE_ERR_UNAUTHENTICATED, actorResult.message || "当前会话未认证，appExchange 命令被拒绝"));
    }
    const viewer = actorResult.user;
    context.userId = String(viewer.id);
    const body = payload && typeof payload === "object" ? payload : {};
    return domain.toAppExchangeIpcResult(() => dispatch(command, body, viewer));
  }

  // 键名避开 isSecretKey 的子串；值给布尔/计数事实，缺失不降级成假成功。
  const dependencies = Object.freeze({
    identity: !!authorization,
    database: !!database,
    portCount: Object.keys(portSet).length,
    store: !!store,
  });

  return {
    execute,
    dependencies,
    ports: portSet,
    database,
    /** 主进程内部 / 测试可直接用的服务面（viewer 由调用方给出）。 */
    service: {
      listTargets,
      getAppExchange,
      inspectExchangeAsset,
      sendAppExchange,
      receiveImage,
      store,
    },
  };
}

module.exports = {
  HOST_APP_ID,
  APP_EXCHANGE_EVENT_CHANNEL,
  createAppExchangeBundle,
  createExchangeStore,
  decodeImageBytes,
};
