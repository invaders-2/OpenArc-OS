/**
 * B5e · Illustrator 配置 + 临时导出（逐函数移植自只读源 server/illustratorConfig.ts:1-162
 * 与 server/illustratorTempExports.ts:1-49）。
 *
 * illustratorConfig.ts 行号：
 *   · :5-39     IllustratorTemplateMapping / IllustratorTemplateFunction / IllustratorConfig
 *   · :41-51    CONFIG_FILE / defaults
 *   · :53-55    text / :57-78 mappings / :80-105 templates
 *   · :107-122  readIllustratorConfig
 *   · :124-142  updateIllustratorConfig（原子写：tmp + rename）
 *   · :144-162  THUMBNAIL_DIR / safeTemplateId / saveIllustratorTemplateThumbnail / illustratorTemplateThumbnail
 *
 * illustratorTempExports.ts 行号：
 *   · :6-8      导出目录 / exportsById / previewsById
 *   · :10-18    prepareIllustratorTempExport
 *   · :20-23    illustratorTempExport / :25-31 prepareIllustratorPreview / :33-36 illustratorPreview
 *   · :38-49    cleanupIllustratorTempExports
 *
 * 本机无 Illustrator：命令面在 illustratorAvailable !== true 时一律回结构化
 *   { ok:false, error:"MEDIA_DEPENDENCY_UNAVAILABLE", detail:"..." }
 * 不假实现、不伪造导出。纯配置/临时导出逻辑仍完整保留，供注入适配器后真实使用。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { createMediaError, MEDIA_ERR_NOT_FOUND, MEDIA_ERR_INVALID_INPUT, MEDIA_ERR_DEPENDENCY_UNAVAILABLE } = require("./media-domain.cjs");

let extensions = Object.freeze({});

/** 依赖注入：{ dataDir, tmpDir, illustratorAvailable, illustratorAdapter, clock }。 */
function configureIllustrator(options) {
  if (options && typeof options === "object") extensions = Object.freeze(Object.assign({}, extensions, options));
  return Object.assign({}, extensions);
}

function effective(options) { return Object.assign({}, extensions, options || {}); }

function illustratorUnavailable(message, options) {
  const opts = effective(options);
  if (opts.illustratorAvailable === true) return null;
  return createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, message || "本机未安装 Adobe Illustrator", "缺少 Illustrator：安装 Illustrator，并通过 illustratorAvailable=true + illustratorAdapter 注入后重试。");
}

function dataDirOf(options) {
  const opts = effective(options);
  if (!opts.dataDir) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "Illustrator 配置目录未装配（缺少 dataDir）", "缺少 dataDir：注入后重试。");
  return opts.dataDir;
}

function configFile(options) { return path.join(dataDirOf(options), "illustrator", "config.json"); }
function thumbnailDir(options) { return path.join(dataDirOf(options), "illustrator", "thumbnails"); }
function exportDirectory(options) { return path.join(effective(options).tmpDir || os.tmpdir(), "dxos-illustrator-exports"); }

const exportsById = new Map();
const previewsById = new Map();

/** 源 illustratorConfig.ts:42-51 defaults。 */
function defaults() {
  return { version: 1, barcodeTemplatePath: "", barcodePdfOutputPath: "", illustratorVersion: "", illustratorDirectory: "", previewResolution: 2048, templateFunctions: [], updatedAt: 0 };
}

/** 源 :53-55 text。 */
function text(value, max) { return String(value == null ? "" : value).trim().slice(0, max || 4096); }

/** 源 :57-78 mappings。 */
function mappings(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw : {};
    const bounds = item.bounds && typeof item.bounds === "object" ? item.bounds : null;
    return {
      id: text(item.id, 120) || "mapping-" + index,
      uuid: text(item.uuid, 256),
      sourceIndex: Number.isSafeInteger(Number(item.sourceIndex)) ? Math.max(0, Number(item.sourceIndex)) : index,
      sourceContents: text(item.sourceContents, 20000),
      label: text(item.label, 160) || "字段 " + (index + 1),
      defaultValue: text(item.defaultValue, 20000),
      enabled: item.enabled !== false,
      kind: item.kind === "barcode" ? "barcode" : "text",
      targetUuids: Array.isArray(item.targetUuids) ? item.targetUuids.map((uuid) => text(uuid, 256)).filter(Boolean).slice(0, 500) : undefined,
      digitFrameUuids: Array.isArray(item.digitFrameUuids) ? item.digitFrameUuids.map((uuid) => text(uuid, 256)).filter(Boolean).slice(0, 20) : undefined,
      bounds: bounds && ["x", "y", "width", "height"].every((key) => Number.isFinite(Number(bounds[key]))) ? {
        x: Number(bounds.x), y: Number(bounds.y), width: Math.max(0, Number(bounds.width)), height: Math.max(0, Number(bounds.height)),
      } : undefined,
    };
  });
}

/** 源 :80-105 templates。 */
function templates(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((raw) => {
    const item = raw && typeof raw === "object" ? raw : {};
    const id = text(item.id, 120);
    const name = text(item.name, 160);
    const sourcePath = text(item.sourcePath);
    const artboardRaw = item.artboard && typeof item.artboard === "object" ? item.artboard : null;
    const sizeRaw = artboardRaw && artboardRaw.size && typeof artboardRaw.size === "object" ? artboardRaw.size : null;
    if (!id || !name || !sourcePath) return [];
    return [{
      id,
      name,
      sourcePath,
      outputPath: text(item.outputPath),
      outputName: text(item.outputName, 240) || name,
      mappings: mappings(item.mappings).filter((mapping) => mapping.enabled),
      artboard: sizeRaw && Number(sizeRaw.width) > 0 && Number(sizeRaw.height) > 0 ? {
        index: Math.max(0, Number(artboardRaw && artboardRaw.index) || 0),
        name: text(artboardRaw && artboardRaw.name, 160) || undefined,
        size: { width: Number(sizeRaw.width), height: Number(sizeRaw.height) },
      } : undefined,
      updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : Date.now(),
    }];
  });
}

/** 源 :107-122 readIllustratorConfig。 */
function readIllustratorConfig(options) {
  const file = configFile(options);
  if (!fs.existsSync(file)) return defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: 1,
      barcodeTemplatePath: text(raw.barcodeTemplatePath),
      barcodePdfOutputPath: text(raw.barcodePdfOutputPath),
      illustratorVersion: text(raw.illustratorVersion, 80),
      illustratorDirectory: text(raw.illustratorDirectory),
      previewResolution: [1024, 2048, 4096].includes(Number(raw.previewResolution)) ? Number(raw.previewResolution) : 2048,
      templateFunctions: templates(raw.templateFunctions),
      updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
    };
  } catch { return defaults(); }
}

/** 源 :124-142 updateIllustratorConfig（原子写）。 */
function updateIllustratorConfig(patch, options) {
  const opts = effective(options);
  const current = readIllustratorConfig(opts);
  const p = patch && typeof patch === "object" ? patch : {};
  const next = {
    ...current,
    ...(Object.hasOwn(p, "barcodeTemplatePath") ? { barcodeTemplatePath: text(p.barcodeTemplatePath) } : {}),
    ...(Object.hasOwn(p, "barcodePdfOutputPath") ? { barcodePdfOutputPath: text(p.barcodePdfOutputPath) } : {}),
    ...(Object.hasOwn(p, "illustratorVersion") ? { illustratorVersion: text(p.illustratorVersion, 80) } : {}),
    ...(Object.hasOwn(p, "illustratorDirectory") ? { illustratorDirectory: text(p.illustratorDirectory) } : {}),
    ...(Object.hasOwn(p, "previewResolution") && [1024, 2048, 4096].includes(Number(p.previewResolution)) ? { previewResolution: Number(p.previewResolution) } : {}),
    ...(Object.hasOwn(p, "templateFunctions") ? { templateFunctions: templates(p.templateFunctions) } : {}),
    version: 1,
    updatedAt: (opts.clock || (() => Date.now()))(),
  };
  const file = configFile(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp-" + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, file);
  return next;
}

/** 源 :146-149 safeTemplateId。 */
function safeTemplateId(id) {
  if (!/^[a-zA-Z0-9_-]{3,160}$/.test(id)) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "模板 ID 不合法");
  return id;
}

/** 源 :151-157 saveIllustratorTemplateThumbnail。 */
function saveIllustratorTemplateThumbnail(id, sourcePath, options) {
  const target = path.join(thumbnailDir(options), safeTemplateId(id) + ".png");
  if (!fs.existsSync(sourcePath)) throw createMediaError(MEDIA_ERR_NOT_FOUND, "模板预览文件不存在");
  fs.mkdirSync(thumbnailDir(options), { recursive: true });
  fs.copyFileSync(sourcePath, target);
  return target;
}

/** 源 :159-162 illustratorTemplateThumbnail。 */
function illustratorTemplateThumbnail(id, options) {
  const target = path.join(thumbnailDir(options), safeTemplateId(id) + ".png");
  return fs.existsSync(target) ? target : null;
}

/** 源 illustratorTempExports.ts:10-18 prepareIllustratorTempExport。 */
function prepareIllustratorTempExport(ownerId, name, options) {
  const dir = exportDirectory(options);
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const safeName = (String(name).replace(/[^\p{L}\p{N}._-]/gu, "_").replace(/^\.+/, "") || "Illustrator").slice(0, 80);
  const fileName = safeName.replace(/\.pdf$/i, "") + ".pdf";
  const filePath = path.join(dir, id + ".pdf");
  exportsById.set(id, { ownerId, path: filePath, name: fileName });
  return { id, path: filePath, name: fileName };
}

/** 源 :20-23 illustratorTempExport。 */
function illustratorTempExport(ownerId, id) {
  const item = exportsById.get(id);
  return item && item.ownerId === ownerId && fs.existsSync(item.path) ? item : null;
}

/** 源 :25-31 prepareIllustratorPreview。 */
function prepareIllustratorPreview(ownerId, options) {
  const dir = exportDirectory(options);
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const filePath = path.join(dir, id + ".png");
  previewsById.set(id, { ownerId, path: filePath });
  return { id, path: filePath };
}

/** 源 :33-36 illustratorPreview。 */
function illustratorPreview(ownerId, id) {
  const item = previewsById.get(id);
  return item && item.ownerId === ownerId && fs.existsSync(item.path) ? item : null;
}

/** 源 :38-49 cleanupIllustratorTempExports。 */
function cleanupIllustratorTempExports(ownerId) {
  let removed = 0;
  for (const [id, item] of exportsById) {
    if (item.ownerId !== ownerId) continue;
    try { fs.unlinkSync(item.path); removed++; } catch { /* 导出可能尚未生成文件（源 :41） */ }
    exportsById.delete(id);
  }
  for (const [id, item] of previewsById) {
    if (item.ownerId !== ownerId) continue;
    try { fs.unlinkSync(item.path); removed++; } catch { /* 预览可能尚未生成文件（源 :46） */ }
    previewsById.delete(id);
  }
  return { removed };
}

module.exports = {
  configureIllustrator,
  illustratorUnavailable,
  defaults,
  text,
  mappings,
  templates,
  readIllustratorConfig,
  updateIllustratorConfig,
  safeTemplateId,
  saveIllustratorTemplateThumbnail,
  illustratorTemplateThumbnail,
  prepareIllustratorTempExport,
  illustratorTempExport,
  prepareIllustratorPreview,
  illustratorPreview,
  cleanupIllustratorTempExports,
};
