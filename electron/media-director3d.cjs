/**
 * B5e · 导演台 3D 模型目录（逐函数移植自只读源 server/director3dModels.ts:1-147）。
 *
 * 行号为源文件行号：
 *   · :9-21     Director3DModelKind / Director3DModelDefinition
 *   · :29-33    MODEL_DIR / 目录 URL / 下载状态（目录 URL 为网络，OUT）
 *   · :35-38    safeModelId
 *   · :40-58    catalog() 的纯解析部分（远端 fetch OUT，改为注入 models / modelCatalog）
 *   · :60-61    modelPath / metadataPath
 *   · :63-71    installedVersions（本地扫描）
 *   · :73-80    localModelPath（stat + 元数据版本/哈希比对）
 *   · :82-86    definition
 *   · :120-134  director3DModelStatus（条目投影）
 *   · :142-147  director3DModelFile
 *
 * OUT（云 / 商业化 / 网络）逐条注明：
 *   · :30-31  DX_ACCOUNT_API_URL / DX_DIRECTOR3D_MODEL_CATALOG_URL（api.dx-os.com）—— OUT
 *   · :40-44  远端目录 fetch —— OUT，改为注入 modelCatalog / models
 *   · :88-118 downloadModel（downloadUrl + sha256 校验，AbortSignal 120s）—— 联网，OUT
 *   · :136-140 downloadDirector3DModel —— 即上述下载，OUT
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createMediaError, MEDIA_ERR_NOT_FOUND, MEDIA_ERR_DEPENDENCY_UNAVAILABLE } = require("./media-domain.cjs");

const MODEL_KINDS = Object.freeze(["male", "female", "character", "prop"]);
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

let extensions = Object.freeze({});

/** 依赖注入：{ dataDir, models, modelCatalog, clock }。 */
function configureDirector3D(options) {
  if (options && typeof options === "object") extensions = Object.freeze(Object.assign({}, extensions, options));
  return Object.assign({}, extensions);
}

function effective(options) { return Object.assign({}, extensions, options || {}); }

function modelDir(options) {
  const opts = effective(options);
  if (!opts.dataDir) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "导演台模型目录未装配（缺少 dataDir）", "缺少 dataDir：注入后重试。");
  return path.join(opts.dataDir, "models", "director3d");
}

/** 源 :35-38 safeModelId。 */
function safeModelId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,80}$/.test(id) ? id : "";
}

/** 源 :45-55 的纯解析：非法条目一律丢弃（不猜、不兜底）。 */
function parseDirector3DCatalog(body) {
  const items = body && Array.isArray(body.models) ? body.models : [];
  return items.flatMap((item) => {
    const row = item && typeof item === "object" ? item : {};
    const id = safeModelId(row.id);
    const version = String(row.version || "");
    const sha256 = String(row.sha256 || "").toLowerCase();
    const downloadUrl = String(row.downloadUrl || "");
    const size = Math.floor(Number(row.size) || 0);
    const kind = MODEL_KINDS.includes(String(row.kind)) ? String(row.kind) : "character";
    if (!id || !VERSION_RE.test(version) || !SHA256_RE.test(sha256) || !downloadUrl.startsWith("https://") || size < 1) return [];
    return [{ id, name: String(row.name || id).slice(0, 100), description: String(row.description || "").slice(0, 300), version, format: "fbx", kind, downloadUrl, sha256, size }];
  });
}

/** 源 :40-58 catalog：网络 OUT，改为注入 models / modelCatalog；都缺则空目录。 */
function catalog(options) {
  const opts = effective(options);
  if (Array.isArray(opts.models)) return opts.models;
  if (opts.modelCatalog) return parseDirector3DCatalog(opts.modelCatalog);
  return [];
}

/** 源 :60-61 modelPath / metadataPath。 */
function modelPath(model, options) { return path.join(modelDir(options), model.id + "-" + model.version + "." + model.format); }
function metadataPath(model, options) { return path.join(modelDir(options), model.id + "-" + model.version + ".json"); }

/** 源 :63-71 installedVersions。 */
function installedVersions(id, options) {
  try {
    const names = fs.readdirSync(modelDir(options));
    const escaped = String(id).replace(/[.*+?^$()|[\]\\]/g, "\\$&");
    return names.flatMap((name) => {
      const match = name.match(new RegExp("^" + escaped + "-(.+)\\.json$"));
      return match && match[1] ? [match[1]] : [];
    });
  } catch { return []; }
}

/** 源 :73-80 localModelPath。 */
function localModelPath(model, options) {
  const file = modelPath(model, options);
  try {
    const info = fs.statSync(file);
    const metadata = JSON.parse(fs.readFileSync(metadataPath(model, options), "utf8"));
    if (info.size === model.size && metadata.version === model.version && metadata.sha256 === model.sha256) return file;
  } catch { /* 未安装或陈旧 */ }
  return "";
}

/** 源 :82-86 definition。 */
function definition(id, options) {
  const model = catalog(options).find((item) => item.id === safeModelId(id));
  if (!model) throw createMediaError(MEDIA_ERR_NOT_FOUND, "导演台模型不存在或未发布");
  return model;
}

/** 源 :120-134 director3DModelStatus（条目投影；fileUrl 只给相对路径）。 */
function director3DModelStatus(options) {
  const opts = effective(options);
  return catalog(opts).map((model) => {
    const downloaded = !!localModelPath(model, opts);
    const versions = installedVersions(model.id, opts);
    const localVersion = downloaded ? model.version : versions.sort().at(-1) || "";
    return {
      id: model.id, name: model.name, description: model.description, version: model.version, format: model.format, kind: model.kind, size: model.size,
      downloaded, updateAvailable: !!localVersion && localVersion !== model.version, localVersion,
      downloading: false, downloadedBytes: downloaded ? model.size : 0, totalBytes: model.size,
      fileUrl: downloaded ? "/api/director3d/models/" + encodeURIComponent(model.id) + "/file?v=" + encodeURIComponent(model.version) : "",
    };
  });
}

/** 源 :142-147 director3DModelFile；返回绝对路径供主进程内部读取，绝不回渲染层。 */
function director3DModelFile(id, options) {
  const model = definition(id, options);
  const filePath = localModelPath(model, options);
  if (!filePath || !fs.existsSync(filePath)) throw createMediaError(MEDIA_ERR_NOT_FOUND, "模型尚未下载");
  return { path: filePath, model };
}

module.exports = {
  MODEL_KINDS,
  configureDirector3D,
  safeModelId,
  parseDirector3DCatalog,
  catalog,
  modelPath,
  metadataPath,
  installedVersions,
  localModelPath,
  definition,
  director3DModelStatus,
  director3DModelFile,
  // 源 :88-118 downloadModel / :136-140 downloadDirector3DModel 属 OUT（联网下载），不导出。
};
