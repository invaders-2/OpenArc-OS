/**
 * photos 域 · 服务层（唯一落盘实现 + 命令分发 + 供应商/数据库/虚拟树依赖装配）。
 *
 * 逐段移植自只读源（行号为源行号）：
 *   · photoSources.ts:50-145                    → DiskPhotoLibrary（photos-store.cjs）
 *   · photoLibraryIndex.ts:14-65                → createPhotoLibraryIndex 的缓存 + 可见性过滤（本文件）
 *   · photoSourceVisualFeatures.ts:11-134       → 特征读写 / 相关排序（本文件，ccsDb → 注入 DatabaseSync）
 *   · index.ts:5743-6132 的 /api/photos/* 处理  → dispatch 的逐命令语义
 *   · index.ts:6081-6092 / :6094-6132           → visionModels / reversePrompt 的供应商入口
 *   · index.ts:6534-6578                        → backgroundRemoval（复用 media-background-removal.cjs）
 *
 * 落盘位置：<userData>/dxos/photos（photos-store.cjs:resolvePhotosRoot 统一围栏）。
 *
 * 依赖装配（全部可选，缺失即结构化不可用，绝不假成功）：
 *   · db            node:sqlite DatabaseSync（identity.db）—— v27 已建
 *                   photo_source_visual_features / photo_source_related_rankings（dxos-foundation-schema.cjs:276-277）
 *   · providerStore 既有 B2 provider-protocol-store.cjs（providers.json + safeStorage）——唯一供应商来源
 *   · vision        { list(), describe({ target, dataUrl, prompt, signal }) }，供测试/宿主替换供应商实现
 *   · fetchImpl     默认全局 fetch（reversePrompt 直连 OpenAI 兼容 chat/completions）
 *   · sharpLoader   惰性 sharp 解析（缺依赖回结构化不可用，绝不回假图）
 *   · videoPoster   宿主注入的视频封面函数 (filePath, size) => Buffer|string；缺失即视频缩略图结构化不可用
 *   · importer      宿主注入的图片导入器（画布 / 资产库）；缺失即 photos/importImage 结构化不可用
 *   · fsImpl        dxos-fs.cjs 实例（photos/library 的虚拟树来源）
 *   · shareAccess   (user, share) => boolean；缺省只认 public 与 department:
 *
 * 为什么 importImage / videoPoster 用注入：本仓禁止改 main.cjs，画布与资产库的接线由 Lead 统一做；
 * 这里固定调用面而不是复制一套画布写入逻辑（源 index.ts:5949-5989 直接操作 canvas 域内部对象）。
 *
 * 刻意排除（任务铁律 OUT，出现即拒绝而不是静默忽略）：
 *   · 云能力（cloudAccount / 云 AI / api.dx-os.com / apiQuota / 计费配额）——一个字段都不接收；
 *   · 源 index.ts:6121 runWithAgentModelFallback 的"代理模型自动回退"属于 agent 域编排，
 *     本域只按显式 providerId+model 或可用列表第一项调用，不猜测、不静默切换账号。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const domain = require("./photos-domain.cjs");
const foundationErrors = require("./dxos-foundation-errors.cjs");
const { DiskPhotoLibrary, resolvePhotosRoot, THUMBNAIL_CACHE_DIR_NAME } = require("./photos-store.cjs");

const HOST_APP_ID = "photos";
/** 源 index.ts:5941：图片导入上限 100 MB。 */
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
/** 源 index.ts:6101-6110 先压到 512KB；本仓不新增模糊压缩依赖，直接卡原始字节上限。 */
const MAX_INLINE_BYTES = 32 * 1024 * 1024;
const MAX_REVERSE_IMAGE_BYTES = 8 * 1024 * 1024;
/** 源 index.ts:6123 describeImage(..., 120_000, 1200)。 */
const REVERSE_TIMEOUT_MS = 120_000;
const REVERSE_MAX_TOKENS = 1200;
/** 源 index.ts:6120 的提示词正文（逐字保留）。 */
const REVERSE_PROMPT = "请分析图片并输出一段可直接复制使用的中文图片生成提示词。描述主体、场景、构图、光线、色彩、材质、风格与画幅；若有清晰可见的文字，准确记录文字。只描述可见内容，不要猜测原始模型、种子或作者真正使用的提示词。只输出提示词正文。";
/** 源 index.ts:6081-6092 resolveVisionTargets：本仓按 provider-protocol-store 的 caps 认定视觉模型。 */
const VISION_CAPABILITIES = Object.freeze(["vision", "vlm", "llm.chat.vision", "llm.vision", "image-understanding"]);

/** 统一"怎么配"提示：不含任何密钥形态，也不含宿主绝对路径。 */
const VISION_CONFIG_HINT = "请先在「设置 → API 供应商」添加一个支持视觉（vision / vlm）的平台，填入自填的 baseUrl 与 API Key，并在该平台下勾选模型 caps 含 vision 的模型；本仓没有内置云供应商，也不会代替你调用 api.dx-os.com。";
const IMPORT_CONFIG_HINT = "画布 / 资产库导入器尚未装配：请在主进程装配 photos bundle 时注入 importer({ userId, destination, targetId, name, mime, data, sourceId, prompt })。";
const VIDEO_POSTER_HINT = "视频缩略图需要宿主注入 videoPoster(filePath, size)；本仓不自带 ffmpeg 封面缓存。";
const SHARP_HINT = "缺少 sharp：安装 sharp 或由宿主注入 sharpLoader 后重试；图片缩略图不会用假图兜底。";

const isPlain = domain.isPlainObject;
const clip = domain.clipText;

// ---------------------------------------------------------------------------
// 数据库小工具（node:sqlite 没有 better-sqlite3 的 db.transaction()）
// ---------------------------------------------------------------------------

function requireDb(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw domain.createPhotosError(
      domain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE,
      "视觉特征缓存需要 identity.db 的 node:sqlite 连接（DatabaseSync）",
      { dependency: "database", hint: "photos bundle 需要注入 identity-store 的数据库连接；v27 迁移已建好两张表。" },
    );
  }
  return db;
}

/** BEGIN IMMEDIATE / COMMIT / ROLLBACK（同 developer-service.cjs:355 的做法）。 */
function writeTransaction(db, run) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 回滚失败不覆盖原错误 */ }
    throw error;
  }
}

function parseFeaturesJson(value, validator) {
  try {
    const parsed = JSON.parse(value);
    return validator(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 192 维向量不能直接以单个数字数组过 IPC：foundation 的 redactValue 把任何数组切到 100 项
 * （dxos-foundation-errors.cjs:68），192 维会被静默截断成 100 维（=数据损坏）。所以特征出口
 * 按 100 一段切成 chunks（每段都在截断阈值之内），并显式给 length / chunkSize；
 * 前端 concat(chunks) 即还原，数值仍是原生双精度，不做 Float32 有损转换。
 */
function encodeFeatureVector(vector) {
  const chunks = [];
  for (let index = 0; index < vector.length; index += domain.PHOTOS_PAGE_LIMIT_MAX) {
    chunks.push(vector.slice(index, index + domain.PHOTOS_PAGE_LIMIT_MAX));
  }
  return { length: vector.length, chunkSize: domain.PHOTOS_PAGE_LIMIT_MAX, chunks };
}

// ---------------------------------------------------------------------------
// bundle
// ---------------------------------------------------------------------------

/**
 * 装配 photos 域。
 * @returns {{ execute, service, store, root, dependencies, inspect, dispose }}
 */
function createPhotosBundle(options = {}) {
  const authorization = options.authorization || null;
  const db = options.db || null;
  const providerStore = options.providerStore || null;
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : (typeof fetch === "function" ? fetch : null);
  const sharpLoader = typeof options.sharpLoader === "function" ? options.sharpLoader : null;
  const videoPoster = typeof options.videoPoster === "function" ? options.videoPoster : null;
  const importer = typeof options.importer === "function" ? options.importer : null;
  const vision = isPlain(options.vision) && typeof options.vision.describe === "function" ? options.vision : null;
  const fsImpl = options.fsImpl || null;
  const shareAccess = typeof options.shareAccess === "function" ? options.shareAccess : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;
  // fsAccess 是"虚拟树节点是否可见且 mtime 一致"的判据。生产由宿主在装配时注入；
  // payload.fsAccess 只是同进程测试/内部调用的逃生口（IPC structured clone 不会把函数带过来）。
  const injectedFsAccess = typeof options.fsAccess === "function" ? options.fsAccess : null;
  const fsAccessFor = (payload) => (isPlain(payload) && typeof payload.fsAccess === "function" ? payload.fsAccess : injectedFsAccess);

  const userDataDir = options.userDataDir;
  const root = options.root ? path.resolve(String(options.root)) : resolvePhotosRoot(userDataDir);
  const store = options.store || new DiskPhotoLibrary({ root, clock, logger });

  // -------------------------------------------------------------------------
  // 供应商（源 index.ts:6081-6092 / :6109-6125）
  // -------------------------------------------------------------------------

  function usableVisionTargets() {
    if (vision) {
      let list = [];
      try { list = vision.list ? vision.list() : []; } catch { list = []; }
      return Array.isArray(list) ? list.filter((item) => item && item.providerId && item.model) : [];
    }
    if (!providerStore || typeof providerStore.listPublic !== "function") return [];
    let providers = [];
    try { providers = providerStore.listPublic() || []; } catch { providers = []; }
    const out = [];
    const seen = new Set();
    for (const provider of providers) {
      if (!provider || provider.id == null || provider.enabled === false || provider.has_key !== true) continue;
      const models = Array.isArray(provider.models) ? provider.models : [];
      for (const model of models) {
        const name = model && typeof model.model === "string" ? model.model : "";
        if (!name) continue;
        const caps = Array.isArray(model.caps) ? model.caps.map((cap) => String(cap).toLowerCase()) : [];
        if (!caps.some((cap) => VISION_CAPABILITIES.includes(cap))) continue;
        const key = String(provider.id) + ":" + name;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ providerId: String(provider.id), providerName: String(provider.name || provider.id), model: name });
      }
    }
    return out;
  }

  async function describeImageWithProvider(target, dataUrl, prompt, signal) {
    if (!providerStore || typeof providerStore.get !== "function") {
      throw domain.createPhotosError(domain.PHOTOS_ERR_PROVIDER_UNAVAILABLE, "没有可用的视觉模型供应商", { hint: VISION_CONFIG_HINT });
    }
    const internal = providerStore.get(target.providerId);
    if (!internal || !internal.api_key) {
      throw domain.createPhotosError(domain.PHOTOS_ERR_PROVIDER_UNAVAILABLE, "视觉模型供应商缺少 API Key，请补充密钥", { providerId: target.providerId, hint: VISION_CONFIG_HINT });
    }
    if (!fetchImpl) {
      throw domain.createPhotosError(domain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE, "当前运行环境没有 fetch，无法调用视觉模型", { dependency: "fetch" });
    }
    let baseUrl = String(internal.base_url || "").trim();
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw domain.createPhotosError(domain.PHOTOS_ERR_PROVIDER_UNAVAILABLE, "视觉模型供应商 baseUrl 不可用，请检查设置", { providerId: target.providerId, hint: VISION_CONFIG_HINT });
    }
    const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), REVERSE_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + String(internal.api_key) },
        body: JSON.stringify({
          model: target.model,
          stream: false,
          max_tokens: REVERSE_MAX_TOKENS,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl } }] }],
        }),
        signal: controller.signal,
      });
      if (!response || response.ok !== true) {
        throw domain.createPhotosError(domain.PHOTOS_ERR_PROVIDER_FAILED, "视觉模型调用失败（HTTP " + String(response && response.status) + "），请检查 baseUrl、API Key 与额度");
      }
      const body = await response.json().catch(() => null);
      const choices = body && Array.isArray(body.choices) ? body.choices : [];
      const content = choices[0] && choices[0].message ? choices[0].message.content : null;
      const text = typeof content === "string" ? content : null;
      if (!text) throw domain.createPhotosError(domain.PHOTOS_ERR_PROVIDER_FAILED, "视觉模型没有返回可用文本");
      return text;
    } catch (error) {
      if (error && error.name === "AbortError") throw domain.createPhotosError(domain.PHOTOS_ERR_PROVIDER_FAILED, "视觉模型调用超时或已取消");
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", abort);
    }
  }

  function visionModels() {
    const models = usableVisionTargets();
    if (models.length) return { available: true, models, hint: null };
    return { available: false, models: [], hint: VISION_CONFIG_HINT };
  }

  // -------------------------------------------------------------------------
  // 虚拟树图库（源 photoLibraryIndex.ts:14-65）
  // -------------------------------------------------------------------------

  let cachedRevision = -1;
  let cachedEntries = [];

  function fsAvailable() {
    return !!fsImpl && typeof fsImpl.listChildren === "function";
  }

  function collectFsNodes() {
    const nodes = [];
    const seen = new Set();
    const queue = [null];
    while (queue.length) {
      const parentId = queue.shift();
      let listing;
      try { listing = fsImpl.listChildren(parentId); } catch { continue; }
      const children = listing && Array.isArray(listing.nodes) ? listing.nodes : [];
      for (const node of children) {
        if (!node || typeof node.id !== "string" || seen.has(node.id)) continue;
        seen.add(node.id);
        nodes.push(node);
        if (node.type === "folder") queue.push(node.id);
        if (nodes.length >= domain.PHOTOS_MAX_INDEX_ITEMS) return nodes;
      }
    }
    return nodes;
  }

  /** 源 photoLibraryIndex.ts:17-48：一次构建、按 ancestors 推导文件夹链与 share。 */
  function buildEntries(nodes) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const entries = [];
    for (const node of nodes) {
      if (node.type !== "file" || node.trashed) continue;
      const kind = domain.classifyLibraryNode(node);
      if (!kind) continue;
      const folders = [];
      const visited = new Set();
      let parent = node.parentId ? byId.get(node.parentId) : undefined;
      let share = node.share || "";
      let inTrash = false;
      while (parent && !visited.has(parent.id)) {
        visited.add(parent.id);
        if (parent.trashed) { inTrash = true; break; }
        if (!share && parent.share) share = parent.share;
        if (!parent.system && !String(parent.name || "").startsWith(".")) folders.unshift(parent.name);
        parent = parent.parentId ? byId.get(parent.parentId) : undefined;
      }
      if (inTrash) continue;
      entries.push({
        node,
        folderId: node.parentId == null ? null : node.parentId,
        folderName: folders[folders.length - 1] || domain.PHOTOS_DESKTOP_LABEL,
        path: folders.join(" / ") || domain.PHOTOS_DESKTOP_LABEL,
        kind,
        ownerId: node.ownerId || null,
        share,
      });
    }
    return entries;
  }

  function libraryEntries() {
    if (!fsAvailable()) return [];
    let revision = -1;
    try { revision = Number(fsImpl.getFsRevision()); } catch { revision = -1; }
    if (!Number.isFinite(revision)) revision = -1;
    if (revision !== cachedRevision) {
      cachedEntries = buildEntries(collectFsNodes());
      cachedRevision = revision;
    }
    return cachedEntries;
  }

  function defaultShareAccess(user, share) {
    const value = String(share || "");
    if (value === "public") return true;
    if (value.startsWith("department:")) return !!user && (user.role === "superadmin" || value.slice("department:".length) === user.departmentId);
    return false;
  }

  function listLibrary(user, pagination) {
    if (!fsAvailable()) {
      throw domain.createPhotosError(
        domain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE,
        "虚拟文件树未装配，无法列出图库",
        { dependency: "fsImpl", hint: "装配 photos bundle 时注入 dxos-fs.cjs 实例（fsImpl）后 photos/library 才有数据来源。" },
      );
    }
    const entries = libraryEntries()
      .filter((entry) => domain.libraryEntryVisible(entry, user && user.id, (share) => (shareAccess ? shareAccess(user, share) : defaultShareAccess(user, share))));
    const sorted = entries.slice().sort((left, right) => {
      const delta = (Number(right.node.updated_ts) || 0) - (Number(left.node.updated_ts) || 0);
      if (delta) return delta;
      return String(left.node.name).localeCompare(String(right.node.name)) || String(left.node.id).localeCompare(String(right.node.id));
    });
    const page = domain.paginate(sorted, pagination);
    return { items: page.items.map(domain.libraryItemView), total: page.total, offset: page.offset, limit: page.limit, truncated: page.truncated };
  }

  // -------------------------------------------------------------------------
  // 特征缓存（源 photoSourceVisualFeatures.ts:11-54）
  // -------------------------------------------------------------------------

  /**
   * 源 :11-19：只有"文件仍在且 mtime 一致"的项才写缓存。
   * 非 local: 的虚拟树节点需要宿主提供 fsAccess；未注入即跳过（不伪造命中）。
   */
  function currentCacheItem(userId, input, fsAccess) {
    if (!input || typeof input.id !== "string" || input.id.length > domain.PHOTOS_MAX_ID_LENGTH || !Number.isFinite(input.updated_ts)) return null;
    if (!input.id.startsWith("local:")) {
      if (typeof fsAccess !== "function") return null;
      let visible = false;
      try { visible = !!fsAccess(input.id, input.updated_ts); } catch { visible = false; }
      return visible ? { id: "fs:" + input.id, updatedTs: input.updated_ts } : null;
    }
    const file = store.resolveSourceFile(userId, input.id);
    if (!file || !String(file.mime).startsWith("image/")) return null;
    return Math.abs(file.updated_ts - Number(input.updated_ts)) < 0.001 ? { id: input.id, updatedTs: file.updated_ts } : null;
  }

  function readFeatures(userId, inputs, fsAccess) {
    const handle = requireDb(db);
    const find = handle.prepare("SELECT features_json FROM photo_source_visual_features WHERE source_id=? AND updated_ts=?");
    const features = {};
    for (const input of inputs.slice(0, domain.PHOTOS_MAX_FEATURE_BATCH)) {
      const item = currentCacheItem(userId, input, fsAccess);
      if (!item) continue;
      const row = find.get(item.id, item.updatedTs);
      if (!row) continue;
      const vector = parseFeaturesJson(row.features_json, domain.isValidFeatureVector);
      if (vector) features[input.id + ":" + input.updated_ts] = vector;
    }
    return features;
  }

  function saveFeatures(userId, inputs, fsAccess) {
    const handle = requireDb(db);
    const upsert = handle.prepare("INSERT OR REPLACE INTO photo_source_visual_features(source_id,updated_ts,features_json) VALUES (?,?,?)");
    const prune = handle.prepare("DELETE FROM photo_source_visual_features WHERE source_id=? AND updated_ts<>?");
    let saved = 0;
    writeTransaction(handle, () => {
      for (const input of inputs.slice(0, domain.PHOTOS_MAX_FEATURE_BATCH)) {
        if (!domain.isValidFeatureVector(input.features)) continue;
        const item = currentCacheItem(userId, input, fsAccess);
        if (!item) continue;
        upsert.run(item.id, item.updatedTs, JSON.stringify(input.features));
        prune.run(item.id, item.updatedTs);
        saved += 1;
      }
    });
    return { saved, total: Math.min(inputs.length, domain.PHOTOS_MAX_FEATURE_BATCH), skipped: Math.min(inputs.length, domain.PHOTOS_MAX_FEATURE_BATCH) - saved };
  }

  // -------------------------------------------------------------------------
  // 相关推荐（源 photoSourceVisualFeatures.ts:56-134）
  // -------------------------------------------------------------------------

  function relatedKey(userId, imageId, catalogSignature, descriptionSignature, fsAccess, updatedTs) {
    if (catalogSignature.length > domain.PHOTOS_MAX_SIGNATURE_LENGTH || descriptionSignature.length > domain.PHOTOS_MAX_SIGNATURE_LENGTH) return null;
    if (imageId.startsWith("local:")) {
      if (!store.resolveSourceFile(userId, imageId)) return null;
    } else {
      if (typeof fsAccess !== "function") return null;
      let visible = false;
      try { visible = !!fsAccess(imageId, updatedTs == null ? NaN : updatedTs); } catch { visible = false; }
      if (!visible) return null;
    }
    return {
      imageId: imageId.startsWith("local:") ? imageId : "fs:" + userId + ":" + imageId,
      catalogHash: domain.signatureHash(catalogSignature),
      descriptionHash: domain.signatureHash(descriptionSignature),
    };
  }

  function readRelatedRanking(userId, imageId, catalogSignature, descriptionSignature, fsAccess, updatedTs) {
    const handle = requireDb(db);
    const key = relatedKey(userId, imageId, catalogSignature, descriptionSignature, fsAccess, updatedTs);
    if (!key) return null;
    const row = handle.prepare("SELECT ranked_ids_json FROM photo_source_related_rankings WHERE image_id=? AND catalog_hash=? AND description_hash=?")
      .get(key.imageId, key.catalogHash, key.descriptionHash);
    if (!row) return null;
    const ids = parseFeaturesJson(row.ranked_ids_json, (value) => Array.isArray(value) && value.length <= domain.PHOTOS_MAX_RANKED_IDS && value.every((id) => typeof id === "string"));
    return ids;
  }

  function saveRelatedRanking(userId, imageId, catalogSignature, descriptionSignature, ids, fsAccess, updatedTs) {
    const handle = requireDb(db);
    const key = relatedKey(userId, imageId, catalogSignature, descriptionSignature, fsAccess, updatedTs);
    if (!key || !Array.isArray(ids) || ids.length > domain.PHOTOS_MAX_RANKED_IDS) return false;
    if (!ids.every((id) => typeof id === "string" && id.length <= domain.PHOTOS_MAX_ID_LENGTH && (id.startsWith("local:") || (typeof fsAccess === "function" && !!fsAccess(id, NaN))))) return false;
    writeTransaction(handle, () => {
      handle.prepare("INSERT OR REPLACE INTO photo_source_related_rankings(image_id,catalog_hash,description_hash,ranked_ids_json) VALUES (?,?,?,?)")
        .run(key.imageId, key.catalogHash, key.descriptionHash, JSON.stringify(ids));
      // 源 :131-133：保留同一图片的多个个人描述变体，但丢弃旧目录的排序。
      handle.prepare("DELETE FROM photo_source_related_rankings WHERE image_id=? AND catalog_hash<>?")
        .run(key.imageId, key.catalogHash);
    });
    return true;
  }

  function queryRelatedRanking(userId, body, fsAccess) {
    const handle = requireDb(db);
    const key = domain.normalizeRelatedKey(body);
    const imageId = key.id;
    const referenceUpdatedTs = Number(body.updated_ts);
    const referenceFolderId = body.folderId == null ? null : String(body.folderId);
    const cached = readRelatedRanking(userId, imageId, key.catalogSignature, key.descriptionSignature, fsAccess, referenceUpdatedTs);
    if (cached) return { ids: cached, computed: false, cached: true };
    const rawCandidates = Array.isArray(body.candidates) ? body.candidates : [];
    const rawSemantic = Array.isArray(body.semanticScores) ? body.semanticScores : [];
    if (rawCandidates.length > domain.PHOTOS_MAX_RANKED_IDS || rawSemantic.length > domain.PHOTOS_MAX_RANKED_IDS) return { ids: null, computed: false, cached: false };
    const candidates = [];
    const seen = new Set();
    for (const raw of rawCandidates) {
      const candidate = domain.normalizeRelatedCandidate(raw);
      if (!candidate) return { ids: null, computed: false, cached: false };
      if (!candidate.id.startsWith("local:") && !(typeof fsAccess === "function" && !!fsAccess(candidate.id, candidate.updated_ts))) return { ids: null, computed: false, cached: false };
      if (seen.has(candidate.id)) return { ids: null, computed: false, cached: false };
      seen.add(candidate.id);
      candidates.push(candidate);
    }
    const find = handle.prepare("SELECT features_json FROM photo_source_visual_features WHERE source_id=? AND updated_ts=?");
    const vector = (id, ts) => {
      const row = find.get(id.startsWith("local:") ? id : "fs:" + id, ts);
      if (!row) return null;
      return parseFeaturesJson(row.features_json, domain.isValidFeatureVector);
    };
    const reference = vector(imageId, referenceUpdatedTs);
    if (!reference) return { ids: null, computed: false, cached: false };
    const semantic = new Map(domain.normalizeSemanticEntries(rawSemantic));
    const ranked = [];
    for (const candidate of candidates) {
      const features = vector(candidate.id, candidate.updated_ts);
      if (!features) return { ids: null, computed: false, cached: false };
      const sameFolder = candidate.folderId === referenceFolderId ? 0.025 : 0;
      ranked.push({ id: candidate.id, score: domain.relatedScore(reference, features, semantic.get(candidate.id) || 0, sameFolder, semantic.size) });
    }
    const result = ranked.sort((left, right) => right.score - left.score).map((entry) => entry.id);
    saveRelatedRanking(userId, imageId, key.catalogSignature, key.descriptionSignature, result, fsAccess, referenceUpdatedTs);
    return { ids: result, computed: true, cached: false };
  }

  // -------------------------------------------------------------------------
  // 图像来源解析（本地文件夹 / 虚拟树节点）
  // -------------------------------------------------------------------------

  /** 统一出口：任何入口都回 { mime, name, buffer }，绝不回宿主路径。 */
  function resolveImageSource(userId, id) {
    if (typeof id !== "string" || !id) return null;
    if (id.startsWith("local:")) {
      const file = store.resolveSourceFile(userId, id);
      if (!file) return null;
      try { return { mime: file.mime, name: file.name, buffer: fs.readFileSync(file.path), size: file.size }; } catch { return null; }
    }
    if (!fsAvailable() || typeof fsImpl.getNode !== "function" || typeof fsImpl.readBlob !== "function") return null;
    let node;
    try { node = fsImpl.getNode(id); } catch { return null; }
    if (!node || node.type !== "file" || node.trashed) return null;
    let buffer;
    try { buffer = fsImpl.readBlob(id); } catch { return null; }
    if (!buffer || !buffer.length) return null;
    return { mime: String(node.mime || ""), name: String(node.name || id), buffer: Buffer.from(buffer), size: buffer.length };
  }

  // -------------------------------------------------------------------------
  // 缩略图 / 字节出口
  // -------------------------------------------------------------------------

  function resolveSharp() {
    if (sharpLoader) {
      try {
        const loaded = sharpLoader();
        if (loaded) return loaded;
      } catch { /* 注入失败 → 结构化不可用 */ }
    }
    try {
      return require("sharp");
    } catch {
      throw domain.createPhotosError(domain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE, "sharp 未安装，无法生成缩略图", { dependency: "sharp", hint: SHARP_HINT });
    }
  }

  function normalizeThumbnailSize(raw) {
    if (raw === undefined || raw === null) return 256;
    const size = Number(raw);
    if (!Number.isSafeInteger(size) || size < 16 || size > 1024) {
      throw domain.createPhotosError(domain.PHOTOS_ERR_INVALID_INPUT, "缩略图尺寸必须是 16..1024 的整数");
    }
    return size;
  }

  async function sourceThumbnail(userId, payload) {
    const id = domain.requireId(payload.id, "id");
    const file = store.resolveSourceFile(userId, id);
    if (!file) throw domain.createPhotosError(domain.PHOTOS_ERR_NOT_FOUND, "素材不存在或源文件夹不可访问");
    const size = normalizeThumbnailSize(payload.size);
    const cacheKey = store.thumbnailCacheKey(file, size);
    const target = store.thumbnailCachePath(cacheKey);
    if (fs.existsSync(target)) {
      return { id, mime: "image/jpeg", size, cached: true, encoding: "base64url", data: domain.encodePhotoBytes(fs.readFileSync(target)) };
    }
    let buffer;
    if (String(file.mime).startsWith("video/")) {
      if (!videoPoster) throw domain.createPhotosError(domain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE, "视频缩略图未装配", { dependency: "videoPoster", hint: VIDEO_POSTER_HINT });
      const poster = await videoPoster(file.path, size);
      if (!poster) throw domain.createPhotosError(domain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE, "视频封面生成失败", { dependency: "videoPoster", hint: VIDEO_POSTER_HINT });
      buffer = Buffer.isBuffer(poster) ? poster : fs.readFileSync(String(poster));
    } else {
      const sharp = resolveSharp();
      buffer = await sharp(fs.readFileSync(file.path)).rotate().resize(size, size, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = target + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temporary, buffer);
      fs.renameSync(temporary, target);
    } catch (error) {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* 清理失败不覆盖原错误 */ }
      throw error;
    }
    return { id, mime: "image/jpeg", size, cached: false, encoding: "base64url", data: domain.encodePhotoBytes(buffer) };
  }

  function sourceFile(userId, payload) {
    const id = domain.requireId(payload.id, "id");
    const file = store.resolveSourceFile(userId, id);
    if (!file) throw domain.createPhotosError(domain.PHOTOS_ERR_NOT_FOUND, "素材不存在或源文件夹不可访问");
    if (file.size > MAX_INLINE_BYTES) {
      throw domain.createPhotosError(domain.PHOTOS_ERR_TOO_LARGE, "文件超过单次内联上限，请改用缩略图或分片传输", { size: file.size, maxInlineBytes: MAX_INLINE_BYTES });
    }
    const data = fs.readFileSync(file.path);
    return { id, name: file.name, mime: file.mime, size: data.length, encoding: "base64url", data: domain.encodePhotoBytes(data) };
  }

  // -------------------------------------------------------------------------
  // 反向提示词 / 抠图 / 导入
  // -------------------------------------------------------------------------

  async function reversePrompt(userId, payload) {
    const imageId = domain.requireId(payload.imageId, "imageId");
    const source = resolveImageSource(userId, imageId);
    if (!source) throw domain.createPhotosError(domain.PHOTOS_ERR_NOT_FOUND, "图片不存在或没有访问权限");
    if (!String(source.mime).startsWith("image/")) throw domain.createPhotosError(domain.PHOTOS_ERR_INVALID_INPUT, "请选择图片进行提示词反推");
    if (source.buffer.length > MAX_REVERSE_IMAGE_BYTES) {
      throw domain.createPhotosError(domain.PHOTOS_ERR_TOO_LARGE, "图片过大，无法进行提示词反推", { size: source.buffer.length, maxBytes: MAX_REVERSE_IMAGE_BYTES });
    }
    const dataUrl = "data:" + source.mime + ";base64," + source.buffer.toString("base64");
    const targets = usableVisionTargets();
    const providerId = clip(payload.providerId, 200).trim();
    const model = clip(payload.model, 200).trim();
    if (!!providerId !== !!model) throw domain.createPhotosError(domain.PHOTOS_ERR_INVALID_INPUT, "请同时选择平台和模型");
    const routes = providerId ? targets.filter((target) => target.providerId === providerId && target.model === model) : targets;
    if (!routes.length) {
      throw domain.createPhotosError(domain.PHOTOS_ERR_PROVIDER_UNAVAILABLE, providerId ? "所选视觉模型不可用，请在设置中重新选择" : "没有可用的视觉模型供应商", { hint: VISION_CONFIG_HINT, available: targets.length });
    }
    let lastError = null;
    for (const target of routes) {
      try {
        const text = vision ? await vision.describe({ target, dataUrl, prompt: REVERSE_PROMPT, imageId, userId }) : await describeImageWithProvider(target, dataUrl, REVERSE_PROMPT, null);
        const value = String(text == null ? "" : text).trim();
        if (!value) throw domain.createPhotosError(domain.PHOTOS_ERR_PROVIDER_FAILED, "视觉模型返回了空提示词");
        return { text: value, providerId: target.providerId, model: target.model };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || domain.createPhotosError(domain.PHOTOS_ERR_PROVIDER_FAILED, "视觉模型调用失败");
  }

  function decodeImagePayload(payload) {
    const body = isPlain(payload) ? payload : {};
    let value = body.image;
    if (value === undefined || value === null) value = body.base64;
    if (value === undefined || value === null) value = body.dataUrl;
    if (value === undefined || value === null) value = body.data;
    let buffer = null;
    if (typeof value === "string") {
      const text = value.startsWith("data:") && value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
      const compact = text.replace(/\s+/g, "");
      if (!compact || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) throw domain.createPhotosError(domain.PHOTOS_ERR_INVALID_INPUT, "图片载荷不是有效的 base64");
      buffer = Buffer.from(compact, "base64url");
    } else if (Buffer.isBuffer(body.bytes)) {
      buffer = Buffer.from(body.bytes);
    } else if (Array.isArray(body.bytes) && body.bytes.length && body.bytes.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
      buffer = Buffer.from(body.bytes);
    }
    if (!buffer || !buffer.length) throw domain.createPhotosError(domain.PHOTOS_ERR_INVALID_INPUT, "请提供图片字节（字段：image / base64 / dataUrl / data / bytes）");
    if (buffer.length > MAX_IMPORT_BYTES) throw domain.createPhotosError(domain.PHOTOS_ERR_TOO_LARGE, "图片超过 100 MB", { maxBytes: MAX_IMPORT_BYTES });
    return buffer;
  }

  async function backgroundRemoval(payload) {
    const buffer = decodeImagePayload(payload);
    let removal;
    try {
      removal = require("./media-background-removal.cjs");
    } catch {
      throw domain.createPhotosError(domain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE, "本地抠图模块不可用", { dependency: "media-background-removal" });
    }
    try {
      const output = await removal.removeImageBackground(buffer, String(payload.model || ""), { sharpLoader });
      return { mime: "image/png", bytes: output.length, encoding: "base64url", data: domain.encodePhotoBytes(output) };
    } catch (error) {
      const code = error && typeof error.code === "string" ? error.code : "";
      if (code.startsWith("MEDIA_")) {
        throw domain.createPhotosError(domain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE, error.message || "本地抠图依赖不可用", error.detail);
      }
      throw error;
    }
  }

  async function importImage(userId, user, payload) {
    const sourceId = domain.requireId(payload.sourceId, "sourceId");
    const targetId = domain.requireId(payload.targetId, "targetId");
    const destination = String(payload.destination || "");
    if (destination !== "canvas" && destination !== "library") {
      throw domain.createPhotosError(domain.PHOTOS_ERR_INVALID_INPUT, "请选择图片和导入目标", { destinations: ["canvas", "library"] });
    }
    const source = resolveImageSource(userId, sourceId);
    if (!source) throw domain.createPhotosError(domain.PHOTOS_ERR_NOT_FOUND, "图片不存在或没有读取权限");
    if (!String(source.mime).startsWith("image/")) throw domain.createPhotosError(domain.PHOTOS_ERR_INVALID_INPUT, "目前仅支持导入图片");
    if (source.buffer.length > MAX_IMPORT_BYTES) throw domain.createPhotosError(domain.PHOTOS_ERR_TOO_LARGE, "图片超过 100 MB，暂不支持导入", { maxBytes: MAX_IMPORT_BYTES });
    if (!importer) throw domain.createPhotosError(domain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE, "画布 / 资产库导入器未装配", { dependency: "importer", hint: IMPORT_CONFIG_HINT });
    const prompt = clip(payload.prompt, 20_000).trim();
    const result = await importer({ userId, user, destination, targetId, name: source.name, mime: source.mime, data: source.buffer, sourceId, prompt });
    if (!isPlain(result)) throw domain.createPhotosError(domain.PHOTOS_ERR_INTERNAL, "导入器没有返回结果");
    const value = { destination, targetId };
    if (result.cardId) value.cardId = String(result.cardId);
    if (result.itemId) value.itemId = String(result.itemId);
    if (result.nodeId) value.nodeId = String(result.nodeId);
    if (destination === "canvas" && !value.cardId) throw domain.createPhotosError(domain.PHOTOS_ERR_INTERNAL, "画布导入器没有返回卡片 id");
    if (destination === "library" && !value.itemId) throw domain.createPhotosError(domain.PHOTOS_ERR_INTERNAL, "资产库导入器没有返回条目 id");
    return value;
  }

  // -------------------------------------------------------------------------
  // 装配 / 分发
  // -------------------------------------------------------------------------

  function health() {
    let sources = 0;
    try { sources = store.snapshot().sources; } catch { sources = 0; }
    let libraryNodes = 0;
    try { libraryNodes = libraryEntries().length; } catch { libraryNodes = 0; }
    let sharpReady = false;
    if (sharpLoader) {
      try { sharpReady = !!sharpLoader(); } catch { sharpReady = false; }
    } else {
      try { require("sharp"); sharpReady = true; } catch { /* 真缺 */ }
    }
    return {
      status: "ready",
      directory: "dxos/photos",
      sources,
      libraryNodes,
      pageLimitDefault: domain.PHOTOS_PAGE_LIMIT_DEFAULT,
      pageLimitMax: domain.PHOTOS_PAGE_LIMIT_MAX,
      // 布尔事实，缺失不降级成假成功（同 file-transfer-service.cjs:335-337 的 dependencies 口径）。
      dependencies: {
        identity: !!authorization,
        database: !!db,
        providerStore: !!providerStore,
        vision: !!vision,
        fsLibrary: fsAvailable(),
        shareAccess: !!shareAccess,
        sharp: sharpReady,
        videoPoster: !!videoPoster,
        importer: !!importer,
        fetch: !!fetchImpl,
      },
    };
  }

  function listSources(userId, payload) {
    const pagination = domain.normalizePagination(payload);
    return store.listSources(userId, pagination);
  }

  function addSource(userId, payload) {
    const result = store.addSource(payload.path);
    return {
      source: { id: result.source.id, name: result.source.name, available: true },
      created: result.created,
    };
  }

  async function dispatch(command, payload, ctx) {
    const userId = ctx.userId;
    const user = ctx.user;
    switch (command) {
      case "photos/sources/list":
        return listSources(userId, payload);
      case "photos/sources/add":
        return addSource(userId, payload);
      case "photos/sources/remove":
        return store.removeSource(domain.requireId(payload.id, "id"));
      case "photos/folders/create":
        return { folder: store.createFolder(userId, payload.name, domain.normalizeOptionalParentId(payload.parentId)) };
      case "photos/folders/remove":
        return store.removeFolder(userId, domain.requireId(payload.id, "id"));
      case "photos/folders/assign": {
        const ids = domain.normalizeAssignIds(payload.ids);
        const folderId = domain.normalizeOptionalParentId(payload.folderId);
        return store.assignFolder(userId, ids, folderId);
      }
      case "photos/library":
        return listLibrary(user, domain.normalizePagination(payload));
      case "photos/sourceFile":
        return sourceFile(userId, payload);
      case "photos/sourceThumbnail":
        return await sourceThumbnail(userId, payload);
      case "photos/importImage":
        return await importImage(userId, user, payload);
      case "photos/features/compute":
        return saveFeatures(userId, domain.normalizeFeatureWriteItems(payload.items), fsAccessFor(payload));
      case "photos/features/query": {
        const raw = readFeatures(userId, domain.normalizeFeatureQueryItems(payload.items), fsAccessFor(payload));
        const features = {};
        for (const [key, vector] of Object.entries(raw)) features[key] = encodeFeatureVector(vector);
        return { features, total: Object.keys(features).length, chunkSize: domain.PHOTOS_PAGE_LIMIT_MAX };
      }
      case "photos/related/compute": {
        const key = domain.normalizeRelatedKey(payload);
        const saved = saveRelatedRanking(userId, key.id, key.catalogSignature, key.descriptionSignature, payload.ids, fsAccessFor(payload), Number(payload.updated_ts));
        return { saved, count: Array.isArray(payload.ids) ? payload.ids.length : 0 };
      }
      case "photos/related/query": {
        const result = queryRelatedRanking(userId, payload, fsAccessFor(payload));
        if (!result.ids) return { ids: null, computed: result.computed, cached: false, total: 0, offset: 0, limit: domain.PHOTOS_PAGE_LIMIT_DEFAULT, truncated: false };
        const pagination = domain.normalizePagination(payload);
        const page = domain.paginate(result.ids, pagination);
        return { ids: page.items, computed: result.computed, cached: result.cached, total: page.total, offset: page.offset, limit: page.limit, truncated: page.truncated };
      }
      case "photos/reversePrompt":
        return await reversePrompt(userId, payload);
      case "photos/visionModels":
        return visionModels();
      case "photos/backgroundRemoval":
        return await backgroundRemoval(payload);
      case "photos/health":
        return health();
      default:
        throw domain.photosCommandNotAllowed(command);
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

  /** 唯一命令入口：白名单 → actor 解析 → dispatch → 脱敏。 */
  async function execute(command, payload, ctx = {}) {
    if (!domain.isPhotosCommand(command)) return domain.normalizePhotosError(domain.photosCommandNotAllowed(command));
    const context = {
      sessionRef: clip(ctx && ctx.sessionRef, 160),
      appId: clip(ctx && ctx.appId, 60) || HOST_APP_ID,
      source: "photos",
      requestId: clip(ctx && ctx.requestId, 100),
    };
    const actorResult = resolveActor(context);
    if (!actorResult.ok) {
      return domain.normalizePhotosError(domain.createPhotosError(domain.PHOTOS_ERR_UNAUTHENTICATED, actorResult.message || "当前会话未认证，photos 命令被拒绝"));
    }
    const user = actorResult.user;
    context.userId = String(user.id);
    const body = isPlain(payload) ? payload : {};
    try {
      const value = await dispatch(command, body, { userId: context.userId, user, context });
      return { ok: true, value: foundationErrors.redactValue(value) };
    } catch (error) {
      if (logger) {
        try { logger({ scope: "photos", command, at: clock(), ok: false, code: error && error.code ? String(error.code) : "PHOTOS_INTERNAL" }); } catch { /* 审计失败不影响业务结果 */ }
      }
      return domain.normalizePhotosError(error);
    }
  }

  const dependencies = Object.freeze({
    userDataDir: !!userDataDir,
    root: !!root,
    identity: !!authorization,
    database: !!db,
    providerStore: !!providerStore,
    fsImpl: fsAvailable(),
  });

  return {
    execute,
    service: store,
    store,
    root,
    dependencies,
    /** 只读诊断入口（测试与主进程内部使用）：库条目数 / 缩略图缓存目录，不含宿主绝对路径。 */
    inspect: () => ({
      rootLabel: "dxos/photos",
      thumbnailCacheDir: THUMBNAIL_CACHE_DIR_NAME,
      libraryNodes: fsAvailable() ? libraryEntries().length : 0,
      commands: domain.listPhotosCommands().map((entry) => entry.command),
    }),
    dispose: () => ({ disposed: true }),
  };
}

module.exports = {
  createPhotosBundle,
  HOST_APP_ID,
  MAX_IMPORT_BYTES,
  MAX_INLINE_BYTES,
  MAX_REVERSE_IMAGE_BYTES,
  REVERSE_TIMEOUT_MS,
  REVERSE_MAX_TOKENS,
  REVERSE_PROMPT,
  VISION_CAPABILITIES,
  VISION_CONFIG_HINT,
  IMPORT_CONFIG_HINT,
  VIDEO_POSTER_HINT,
  SHARP_HINT,
};
