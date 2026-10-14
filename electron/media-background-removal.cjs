/**
 * B5e · 本地抠图（逐函数移植自只读源 server/backgroundRemoval.ts:1-282）。
 *
 * 与源的关系（行号为源文件行号）：
 *   · :12-31   模型族常量 SUPPORTED_MODELS / 目录与目录 URL（网络部分 OUT，见下）
 *   · :91-112  catalog() 的**纯解析**部分保留为 parseModelCatalog（网络 fetch 由注入模型目录替代）
 *   · :114-118 definition / :120-129 localModelPath
 *   · :173-187 getSession（模型路径与 session 均可注入）
 *   · :189-202 buildInput / :204-223 buildMask —— 逐字移植
 *   · :225-242 backgroundRemovalStatus
 *   · :244-249 downloadBackgroundRemovalModel —— 网络下载，属 OUT（下方注明）
 *   · :251-282 removeImageBackground —— 逐字移植，依赖经 sharpLoader / onnxSessionFactory 注入
 *
 * 本机缺 onnxruntime-node 与模型时，任何推理入口都回结构化
 *   { ok:false, error:"MEDIA_DEPENDENCY_UNAVAILABLE", detail:"<缺什么/怎么装>" }
 * 绝不返回假图；也绝不把"没跑成"包装成成功。模型路径可用 modelPath 直接注入。
 *
 * OUT（云 / 商业化 / 网络）逐条注明：
 *   · 源 :29-30   DX_ACCOUNT_API_URL / 模型目录 URL（api.dx-os.com）—— 联网，OUT
 *   · 源 :91-112  远端模型目录 fetch —— OUT，改为注入 modelCatalog / models
 *   · 源 :131-171 模型下载（downloadUrl + sha256 校验）—— 联网，OUT；本机模型用 modelPath 注入
 *   · 源 :40-74   probeOrtRuntime 子进程探针 —— 改为惰性 require 探测，不 spawn
 *   · 源 :244-249 downloadBackgroundRemovalModel —— 即上述下载，OUT
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  createMediaError,
  MEDIA_ERR_INVALID_INPUT,
  MEDIA_ERR_NOT_FOUND,
  MEDIA_ERR_DEPENDENCY_UNAVAILABLE,
} = require("./media-domain.cjs");

/** 源 backgroundRemoval.ts:31 支持模型集合。 */
const SUPPORTED_MODELS = Object.freeze(["ben2-base"]);

/**
 * 离线默认目录（源 :14-26 ModelDefinition 字段逐字对应）。
 * downloadUrl/sha256/size 留空表示"本仓不下载"；真实推理请注入 modelPath 或 models。
 */
const DEFAULT_MODELS = Object.freeze([
  Object.freeze({
    id: "ben2-base",
    name: "BEN2 Base",
    filename: "ben2-base-1.0.0.onnx",
    version: "1.0.0",
    downloadUrl: "",
    sha256: "",
    size: 0,
    inputWidth: 1024,
    inputHeight: 1024,
    normalize: "imagenet",
    sigmoid: true,
  }),
]);

/** 源 :101-102 校验用的版本号 / sha256 形态。 */
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

/** 缺依赖时的可操作提示：缺什么、怎么装。 */
function dependencyDetail(missing) {
  return "缺少 " + missing.join(" / ") +
    "：安装 onnxruntime-node 与 sharp，并把 .onnx 模型放入模型目录（或用 modelPath 注入绝对路径）后重试；" +
    "本仓不下载模型，也不返回假图。";
}

let extensions = Object.freeze({});

/** 依赖注入入口：{ modelDir, modelPath, models, onnxRuntime, onnxSessionFactory, sharpLoader }。 */
function configureBackgroundRemoval(options) {
  if (options && typeof options === "object") extensions = Object.freeze(Object.assign({}, extensions, options));
  return Object.assign({}, extensions);
}

function effective(options) {
  return Object.assign({}, extensions, options || {});
}

/** 源 :96-109 的纯解析部分（网络 fetch 已 OUT）。 */
function parseModelCatalog(body) {
  const items = body && Array.isArray(body.models) ? body.models : [];
  return items.flatMap((item) => {
    const row = item && typeof item === "object" ? item : {};
    const id = String(row.id || "");
    const sha256 = String(row.sha256 || "").toLowerCase();
    const downloadUrl = String(row.downloadUrl || "");
    const version = String(row.version || "");
    if (!SUPPORTED_MODELS.includes(id) || !VERSION_RE.test(version) || !SHA256_RE.test(sha256) || !downloadUrl.startsWith("https://")) return [];
    return [{
      id,
      name: String(row.name || id),
      filename: id + "-" + version + ".onnx",
      version,
      downloadUrl,
      sha256,
      size: Number(row.size || 0),
      inputWidth: Number(row.inputWidth || 1024),
      inputHeight: Number(row.inputHeight || 1024),
      normalize: row.normalize === "imagenet" ? "imagenet" : "zero-one",
      sigmoid: row.sigmoid === true,
    }];
  });
}

/** 源 :114-118 definition：未知模型一律"不支持的抠图模型"。 */
function definition(id, options) {
  const opts = effective(options);
  if (opts.model && opts.model.id === id) return opts.model;
  const models = Array.isArray(opts.models) ? opts.models : DEFAULT_MODELS;
  const model = models.find((item) => item && item.id === id);
  if (!model) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "不支持的抠图模型");
  return model;
}

/** 源 :120 元数据路径。 */
function metadataPath(model, dir) {
  return path.join(dir, model.id + "-" + model.version + ".json");
}

/** 源 :122-129 localModelPath；modelPath 注入优先（本仓不下载，允许直接指定已装模型）。 */
function localModelPath(model, options) {
  const opts = effective(options);
  if (typeof opts.modelPath === "string" && opts.modelPath) return opts.modelPath;
  const dir = opts.modelDir || null;
  if (!dir) return "";
  const file = path.join(dir, model.filename);
  try {
    const info = fs.statSync(file);
    const metadata = JSON.parse(fs.readFileSync(metadataPath(model, dir), "utf8"));
    if (info.size === model.size && metadata.version === model.version && metadata.sha256 === model.sha256) return file;
  } catch { /* 未安装或元数据不符 */ }
  return "";
}

/** 源 :40-83 探针的子进程版本替换为惰性 require：不 spawn、不联网。 */
function sharpFromLoader(options) {
  const opts = effective(options);
  if (typeof opts.sharpLoader !== "function") return undefined;
  const loaded = opts.sharpLoader();
  return loaded || undefined;
}

function resolveSharp(options) {
  let loaded;
  try {
    loaded = sharpFromLoader(options);
  } catch {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "sharp 未安装，无法解码抠图输入或编码 PNG", dependencyDetail(["sharp"]));
  }
  if (loaded) return loaded;
  try {
    return require("sharp");
  } catch {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "sharp 未安装，无法解码抠图输入或编码 PNG", dependencyDetail(["sharp"]));
  }
}

async function loadOnnxRuntime(options) {
  const opts = effective(options);
  if (opts.onnxRuntime && typeof opts.onnxRuntime === "object") return opts.onnxRuntime;
  try {
    return require("onnxruntime-node");
  } catch {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "onnxruntime-node 未安装，无法进行本地抠图", dependencyDetail(["onnxruntime-node"]));
  }
}

/** 源 :173-187 getSession：session 缓存键 = `${id}:${version}`；注入工厂时直接产 session。 */
const sessions = new Map();
async function getSession(model, runtime, options) {
  const opts = effective(options);
  const modelPath = localModelPath(model, opts);
  if (typeof opts.onnxSessionFactory === "function") {
    const injected = await opts.onnxSessionFactory({ model, runtime, modelPath });
    if (!injected) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, model.name + " 的推理会话不可用", dependencyDetail(["模型会话"]));
    return injected;
  }
  const key = model.id + ":" + model.version;
  let session = sessions.get(key);
  if (!session) {
    if (!modelPath) throw createMediaError(MEDIA_ERR_NOT_FOUND, model.name + " 尚未下载或未注入 modelPath");
    if (typeof runtime.InferenceSession?.create !== "function") throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "onnxruntime-node 缺少 InferenceSession.create", dependencyDetail(["onnxruntime-node"]));
    session = runtime.InferenceSession.create(modelPath, { executionProviders: ["cpu"], graphOptimizationLevel: "all" });
    sessions.set(key, session);
    session.catch(() => sessions.delete(key));
  }
  return session;
}

/** 源 :189-202 buildInput。 */
function buildInput(rgb, model) {
  const pixels = model.inputWidth * model.inputHeight;
  const input = new Float32Array(3 * pixels);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      let value = rgb[pixel * 3 + channel] / 255;
      if (model.normalize === "imagenet") value = (value - mean[channel]) / std[channel];
      input[channel * pixels + pixel] = value;
    }
  }
  return input;
}

/** 源 :204-223 buildMask。output.data 即 Tensor 的 Float32Array。 */
function buildMask(output, model) {
  const source = output.data;
  const mask = new Uint8Array(model.inputWidth * model.inputHeight);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < mask.length; i += 1) {
    const raw = source[i];
    const value = model.sigmoid ? 1 / (1 + Math.exp(-raw)) : raw;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = Math.max(1e-6, max - min);
  for (let i = 0; i < mask.length; i += 1) {
    const raw = source[i];
    const value = model.sigmoid ? 1 / (1 + Math.exp(-raw)) : raw;
    mask[i] = Math.round(Math.max(0, Math.min(1, (value - min) / span)) * 255);
  }
  return mask;
}

/** 源 :225-242 backgroundRemovalStatus。 */
async function backgroundRemovalStatus(options) {
  const opts = effective(options);
  const models = Array.isArray(opts.models) ? opts.models : DEFAULT_MODELS;
  return models.map((model) => {
    const downloaded = !!localModelPath(model, opts);
    return {
      id: model.id,
      name: model.name,
      version: model.version,
      size: model.size,
      downloaded,
      downloading: false,
      downloadedBytes: downloaded ? model.size : 0,
      totalBytes: model.size,
      available: true,
    };
  });
}

/**
 * 结构化依赖探测：任何一项缺失即 { ok:false, error:"MEDIA_DEPENDENCY_UNAVAILABLE", detail }。
 * 全部就绪时返回 { ok:true, onnxruntime, sharp, modelPath }（modelPath 只在主进程内部使用）。
 */
async function probeBackgroundRemovalDependencies(options) {
  const opts = effective(options);
  const missing = [];
  if (typeof opts.onnxSessionFactory !== "function") {
    try { require("onnxruntime-node"); } catch { missing.push("onnxruntime-node"); }
  }
  let sharpReady = false;
  if (typeof opts.sharpLoader === "function") {
    // 注入的 loader 是权威判据：抛错/返回空即视为 sharp 不可用，不偷偷回退 require。
    try { sharpReady = !!opts.sharpLoader(); } catch { sharpReady = false; }
  } else {
    try { require("sharp"); sharpReady = true; } catch { /* 真缺 */ }
  }
  if (!sharpReady) missing.push("sharp");
  const modelPath = localModelPath(DEFAULT_MODELS[0], opts);
  if (!modelPath) missing.push("模型文件 " + DEFAULT_MODELS[0].filename);
  if (missing.length) return { ok: false, error: MEDIA_ERR_DEPENDENCY_UNAVAILABLE, detail: dependencyDetail(missing) };
  return { ok: true, onnxruntime: true, sharp: true, modelPath };
}

/**
 * 源 :251-282 removeImageBackground —— 逐字移植。
 * 依赖：runtime（onnxruntime 或注入）、sharp（sharpLoader 或本地）、session（onnxSessionFactory 或本地模型）。
 */
async function removeImageBackground(image, modelId, options) {
  const opts = effective(options);
  const model = definition(modelId, opts);
  const runtime = await loadOnnxRuntime(opts);
  const sharp = resolveSharp(opts);
  // 尺寸从下面同一份解码像素流取，避免 orientation 之后 RGBA 行漂移（源 :254-255 注释）。
  const decoded = await sharp(image).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = decoded.info.width;
  const height = decoded.info.height;
  if (!width || !height) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "无法读取图片尺寸");
  const rgb = await sharp(decoded.data, { raw: decoded.info }).resize(model.inputWidth, model.inputHeight, { fit: "fill" }).raw().toBuffer();
  const session = await getSession(model, runtime, opts);
  const inputName = session.inputNames[0];
  const results = await session.run({ [inputName]: new runtime.Tensor("float32", buildInput(rgb, model), [1, 3, model.inputHeight, model.inputWidth]) });
  const output = results[session.outputNames[0]];
  if (!output) throw createMediaError(MEDIA_ERR_INVALID_INPUT, model.name + " 没有返回遮罩");
  const resizedMask = await sharp(buildMask(output, model), { raw: { width: model.inputWidth, height: model.inputHeight, channels: 1 } })
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (resizedMask.info.width !== width || resizedMask.info.height !== height || resizedMask.info.channels < 1) {
    throw createMediaError(MEDIA_ERR_INVALID_INPUT, model.name + " 返回了无效遮罩尺寸");
  }
  const original = decoded.data;
  const rgba = Buffer.allocUnsafe(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba[pixel * 4] = original[pixel * 3];
    rgba[pixel * 4 + 1] = original[pixel * 3 + 1];
    rgba[pixel * 4 + 2] = original[pixel * 3 + 2];
    rgba[pixel * 4 + 3] = resizedMask.data[pixel * resizedMask.info.channels];
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

module.exports = {
  SUPPORTED_MODELS,
  DEFAULT_MODELS,
  configureBackgroundRemoval,
  parseModelCatalog,
  definition,
  localModelPath,
  dependencyDetail,
  buildInput,
  buildMask,
  backgroundRemovalStatus,
  probeBackgroundRemovalDependencies,
  removeImageBackground,
  // 源 :244-249 downloadBackgroundRemovalModel 属 OUT（联网下载），不导出。
};
