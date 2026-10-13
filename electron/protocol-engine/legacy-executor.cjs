"use strict";
/**
 * W4 · legacy 协议执行器聚合出口。
 *
 * 只做聚合与惰性装配，不含任何协议实现：
 *   chat   → electron/protocol-engine/legacy-executor-chat.cjs   （W4a）
 *   images → electron/protocol-engine/legacy-executor-images.cjs （W4b）
 *   media  → electron/protocol-engine/legacy-executor-media.cjs  （W4c，本批）
 *
 * 为什么用函数内惰性 require + getter：
 *   三个子模块由并行任务分别落地，聚合文件可能在子模块尚未出现时就被 require。
 *   顶层 require 任一缺失文件都会让整个聚合模块抛 MODULE_NOT_FOUND，从而拖垮其它
 *   已就绪的子模块。因此这里在「属性被访问 / 展平函数被调用」时才 require；
 *   缺失时返回 LEGACY_DEPENDENCY_UNAVAILABLE 占位实现，绝不假装可用。
 *
 * 注意：若子模块存在但它在加载时又缺少别的依赖，该错误会原样抛出（不吞）。
 */

const LEGACY_DEPENDENCY_UNAVAILABLE = "LEGACY_DEPENDENCY_UNAVAILABLE";

/** 子模块名 → 相对路径。 */
const MODULE_PATHS = {
  chat: "./legacy-executor-chat.cjs",
  images: "./legacy-executor-images.cjs",
  media: "./legacy-executor-media.cjs",
};

/** 已加载的子模块缓存（null 表示确认缺失）。 */
const moduleCache = Object.create(null);

/** 判断 MODULE_NOT_FOUND 是不是「子模块文件本身缺失」，而非其依赖缺失。 */
function isMissingExecutorModule(error, relativePath) {
  if (!error || error.code !== "MODULE_NOT_FOUND") return false;
  const message = String(error.message || "");
  const base = relativePath.replace(/^\.\//, "");
  return message.indexOf(relativePath) >= 0 || message.indexOf(base) >= 0;
}

/** 缺失子模块的占位：任意属性都返回一个返回结构化错误的函数。 */
function missingModulePlaceholder(key) {
  const detail = "legacy-executor-" + key + ".cjs 尚未落地（W4 批次）";
  return new Proxy({}, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === "LEGACY_DEPENDENCY_UNAVAILABLE") return LEGACY_DEPENDENCY_UNAVAILABLE;
      return function unavailableExport() {
        return { ok: false, error: LEGACY_DEPENDENCY_UNAVAILABLE, detail };
      };
    },
  });
}

/** 惰性加载某个子模块；文件缺失返回 null（缓存），依赖缺失则抛出。 */
function loadModule(key) {
  if (key in moduleCache) return moduleCache[key];
  const relativePath = MODULE_PATHS[key];
  if (!relativePath) throw new Error("未知 legacy 执行器子模块：" + String(key));
  let mod = null;
  try {
    mod = require(relativePath);
  } catch (error) {
    if (!isMissingExecutorModule(error, relativePath)) throw error;
    mod = null;
  }
  moduleCache[key] = mod;
  return mod;
}

function moduleNamespace(key) {
  return loadModule(key) || missingModulePlaceholder(key);
}

/** 某展平函数名 → 所属子模块。 */
const FLATTENED = {
  // chat（W4a）
  callChat: "chat",
  streamChat: "chat",
  chatWithTools: "chat",
  describeImage: "chat",
  fetchModels: "chat",
  fetchModelCatalog: "chat",
  setProtocolTransport: "chat",
  // images（W4b）
  generateImages: "images",
  generateImagesUnmetered: "images",
  editOpenAiCompatibleGenerationImages: "images",
  generateApimartImages: "images",
  generateGeminiImages: "images",
  generateVolcengineImages: "images",
  volcengineImageSize: "images",
  parseImagePayload: "images",
  parseApimartImagePayload: "images",
  requestZkkiImages: "images",
  requestGrok2ApiImages: "images",
  apimartImageConfig: "images",
  apimartImageConfigFromParams: "images",
  geminiImageParts: "images",
  imageTaskId: "images",
  imageTaskStatus: "images",
  prepareApibEditInputs: "images",
  usesGenerationEndpointForImageEdit: "images",
  apibImageAspectRatio: "images",
  apibImageResolution: "images",
  isGptBestAsyncImageProvider: "images",
  isApibOpenAiImageProvider: "images",
  openAiImageQuality: "images",
  // media（W4c）
  generateVideos: "media",
  generateSpeech: "media",
  transcribeAudio: "media",
  generateMusic: "media",
  editImages: "media",
  uploadApimartMedia: "media",
  generateVolcengineVideos: "media",
  volcengineVideoReferenceContentItems: "media",
  generateMinimaxVideos: "media",
  submitMidjourney: "media",
  getMidjourneyTask: "media",
  submitMidjourneyAction: "media",
  submitMidjourneyModal: "media",
  generateMidjourneyImages: "media",
};

/** 展平函数 getter：优先取真实实现，缺失时给结构化错误实现。 */
function flattenedGetter(name, key) {
  return function getFlattened() {
    const mod = loadModule(key);
    const fn = mod && mod[name];
    if (typeof fn === "function") return fn;
    const detail = "legacy-executor-" + key + ".cjs " + (mod ? "未导出" : "尚未落地（W4 批次）") + " " + name;
    return function unavailableExport() {
      return { ok: false, error: LEGACY_DEPENDENCY_UNAVAILABLE, detail };
    };
  };
}

for (const [name, key] of Object.entries(FLATTENED)) {
  Object.defineProperty(module.exports, name, { enumerable: true, configurable: true, get: flattenedGetter(name, key) });
}

// 命名空间（chat / images / media）以 getter 暴露，访问时才 require。
Object.defineProperty(module.exports, "chat", { enumerable: true, configurable: true, get: () => moduleNamespace("chat") });
Object.defineProperty(module.exports, "images", { enumerable: true, configurable: true, get: () => moduleNamespace("images") });
Object.defineProperty(module.exports, "media", { enumerable: true, configurable: true, get: () => moduleNamespace("media") });

module.exports.LEGACY_DEPENDENCY_UNAVAILABLE = LEGACY_DEPENDENCY_UNAVAILABLE;
module.exports.MODULE_PATHS = Object.freeze({ ...MODULE_PATHS });
module.exports.loadModule = loadModule;
