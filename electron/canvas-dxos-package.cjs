/**
 * B5c · 无限画布 .dxcanvas 打包 / 解包 / 校验。
 *
 * 源：server/canvasPackage.ts（161 行）。对应关系：
 *   · 格式常量 CANVAS_PACKAGE_FORMAT 与三条体积上限 ← 源 :11-14
 *   · buildCanvasPackage（素材收集 + 命名 + 清单） ← 源 :52-78
 *   · safePackageEntryName（危险路径拒绝） ← 源 :80-84
 *   · parseCanvasPackage（清单/素材/大小校验） ← 源 :86-122
 *   · remapCanvasPackageDocument（导入后重映射、断掉导出方运行态） ← 源 :154-161
 *
 * 本仓差异（不照抄源）：
 *   ① 源用 adm-zip（源 :6）；本仓无该依赖，改走 canvas-dxos-zip.cjs 的零依赖实现，
 *      并在解析层额外校验每个素材的 SHA-256（源只比对大小，源 :115）。
 *   ② 源素材身份是 fs nodeId（源 :90-100）；OpenArc 素材身份是资源域 ResourceRef
 *      （node.url = "openarc-asset:<resourceId>"），因此 sourceId 取 resourceId。
 *      仍**不建第二套素材系统**：字节由调用方经 resourceService 解析/回写。
 *   ③ 源文档是 cards/inputs/result/history；OpenArc 画布文档是 nodes/connections，
 *      媒体引用出现在节点 url 或任意字符串字段。这里按"遍历文档找 openarc-asset:"
 *      收集，语义等价（哪个节点引用了哪个素材）。
 */
"use strict";

const crypto = require("node:crypto");
const { writeZip, readZip } = require("./canvas-dxos-zip.cjs");

/** 源 server/canvasPackage.ts:11-14。 */
const CANVAS_PACKAGE_FORMAT = "dx-canvas-package/v1";
const CANVAS_PACKAGE_VERSION = 1;
const MAX_CANVAS_PACKAGE_FILES = 5000;
const MAX_CANVAS_PACKAGE_ASSET_BYTES = 500 * 1024 * 1024;
const MAX_CANVAS_PACKAGE_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 20 * 1024 * 1024;

const ASSET_REF_PATTERN = /^openarc-asset:([A-Za-z0-9_.#:-]{1,160})$/;
const MANIFEST_NAME = "canvas.json";

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

// ---------------------------------------------------------------------------
// 校验与命名
// ---------------------------------------------------------------------------

/**
 * 源 :80-84 的等价实现，并补 NUL/控制字符拒绝。
 * @returns {string}
 */
function safePackageEntryName(name) {
  const normalized = String(name == null ? "" : name).replace(/\\/g, "/");
  if (!normalized) throw new Error("画布包包含空的文件路径");
  if (/[\u0000-\u001f]/.test(normalized)) throw new Error("画布包文件路径包含控制字符");
  if (normalized.startsWith("/")) throw new Error("画布包包含绝对路径");
  if (/^[A-Za-z]:/.test(normalized)) throw new Error("画布包包含盘符路径");
  if (normalized.split("/").includes("..")) throw new Error("画布包包含不安全的文件路径");
  return normalized;
}

/** 源 :31-34：文件名清理（去掉路径分隔符和控制字符，去掉前导点）。 */
function packageFileName(value, fallback) {
  const clean = String(value || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
  return (clean || fallback).slice(0, 180);
}

/**
 * 收集文档里的素材引用：resourceId → 引用它的节点 id 集合。
 * 源 :36-50 走 cards.inputs/result/history；这里按字符串遍历，覆盖 OpenArc 的 nodes 结构。
 */
function collectMediaReferences(document) {
  const references = new Map();
  const seenNodes = new WeakSet();
  const visit = (value, nodeId) => {
    if (typeof value === "string") {
      const match = ASSET_REF_PATTERN.exec(value);
      if (match) {
        const list = references.get(match[1]) || new Set();
        if (nodeId) list.add(nodeId);
        references.set(match[1], list);
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    if (seenNodes.has(value)) return;
    seenNodes.add(value);
    if (Array.isArray(value)) { for (const item of value) visit(item, nodeId); return; }
    const nextNodeId = typeof value.id === "string" && typeof value.type === "string" ? value.id : nodeId;
    for (const item of Object.values(value)) visit(item, nextNodeId);
  };
  visit(document, null);
  return references;
}

// ---------------------------------------------------------------------------
// 打包（源 :52-78）
// ---------------------------------------------------------------------------

/**
 * @param document 画布文档（OpenArc 口径：nodes/connections/viewport/logs）
 * @param resolveAsset (resourceId) => { data: Buffer, name: string, mime: string } | null
 * @param meta { canvasId?, title?, icon?, kind?, revision?, exportedAt? }
 * @returns {Buffer} .dxcanvas（ZIP）
 */
function buildCanvasPackage(document, resolveAsset, meta = {}) {
  if (typeof resolveAsset !== "function") throw new Error("buildCanvasPackage 需要 resolveAsset");
  const entries = [];
  const assets = [];
  let totalBytes = 0;
  for (const [sourceId, nodeIds] of collectMediaReferences(document)) {
    const resolved = resolveAsset(sourceId);
    if (!resolved || !resolved.data) {
      // 源 :59-62：文档里明确引用的素材缺失 → 导出失败，不静默丢素材。
      const where = [...nodeIds].slice(0, 3).join("、") || sourceId;
      throw new Error("画布素材不存在或不可导出：" + where);
    }
    const data = Buffer.isBuffer(resolved.data) ? resolved.data : Buffer.from(resolved.data);
    if (data.byteLength > MAX_CANVAS_PACKAGE_ASSET_BYTES) throw new Error("单个画布素材超过 500 MB：" + (resolved.name || sourceId));
    totalBytes += data.byteLength;
    if (totalBytes > MAX_CANVAS_PACKAGE_TOTAL_BYTES) throw new Error("画布导出素材总量超过 1 GB");
    const name = packageFileName(resolved.name, sourceId);
    const assetPath = "assets/" + String(assets.length + 1).padStart(5, "0") + "-" + name;
    const checksum = sha256(data);
    assets.push({ sourceId, path: assetPath, name, mime: resolved.mime || "application/octet-stream", bytes: data.byteLength, checksum });
    entries.push({ name: assetPath, data });
  }
  const manifest = {
    format: CANVAS_PACKAGE_FORMAT,
    version: CANVAS_PACKAGE_VERSION,
    exportedAt: Number(meta.exportedAt) || Date.now(),
    canvas: {
      id: String(meta.canvasId || ""),
      title: String(meta.title || "").slice(0, 200),
      icon: String(meta.icon || "").slice(0, 16),
      kind: String(meta.kind || "").slice(0, 40),
      revision: Number(meta.revision) || 0,
    },
    document: structuredClone(document),
    assets,
  };
  return writeZip([
    { name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") },
    ...entries,
  ]);
}

// ---------------------------------------------------------------------------
// 解包（源 :86-122）
// ---------------------------------------------------------------------------

/**
 * @returns {{ manifest: object, assets: Array<{ sourceId, name, mime, bytes, checksum, data: Buffer }> }}
 */
function parseCanvasPackage(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  if (!buffer.length) throw new Error("画布包为空");
  let entries;
  try { entries = readZip(buffer, { maxEntries: MAX_CANVAS_PACKAGE_FILES, maxEntryBytes: MAX_CANVAS_PACKAGE_ASSET_BYTES, maxTotalBytes: MAX_CANVAS_PACKAGE_TOTAL_BYTES }); }
  catch (error) { throw new Error("画布包无法读取：" + String((error && error.message) || error)); }
  if (!entries.length) throw new Error("画布包文件数量无效");
  const byName = new Map();
  let totalBytes = 0;
  for (const entry of entries) {
    const name = safePackageEntryName(entry.name);
    byName.set(name, entry);
    totalBytes += entry.data.byteLength;
    if (totalBytes > MAX_CANVAS_PACKAGE_TOTAL_BYTES) throw new Error("画布包素材总量超过 1 GB");
  }
  const manifestEntry = byName.get(MANIFEST_NAME);
  if (!manifestEntry || manifestEntry.data.byteLength > MAX_MANIFEST_BYTES) throw new Error("画布包缺少有效的 " + MANIFEST_NAME);
  let manifest;
  try { manifest = JSON.parse(manifestEntry.data.toString("utf8")); }
  catch { throw new Error("画布包清单无法解析"); }
  if (!manifest || manifest.format !== CANVAS_PACKAGE_FORMAT || !manifest.document || !Array.isArray(manifest.assets)) throw new Error("不支持的画布包格式");
  if (manifest.version !== undefined && Number(manifest.version) !== CANVAS_PACKAGE_VERSION) throw new Error("不支持的画布包版本：" + manifest.version);
  if (manifest.assets.length > MAX_CANVAS_PACKAGE_FILES) throw new Error("画布包素材数量过多");
  const sourceIds = new Set();
  const assets = manifest.assets.map((asset) => {
    if (!asset || typeof asset !== "object") throw new Error("画布包素材索引无效");
    const assetPath = safePackageEntryName(asset.path);
    if (!assetPath.startsWith("assets/")) throw new Error("画布素材路径无效");
    const entry = byName.get(assetPath);
    if (!entry) throw new Error("画布素材缺失：" + (asset.name || assetPath));
    const data = entry.data;
    if (Number(asset.bytes) !== data.byteLength) throw new Error("画布素材大小校验失败：" + (asset.name || assetPath));
    if (asset.checksum && String(asset.checksum) !== sha256(data)) throw new Error("画布素材校验和不一致：" + (asset.name || assetPath));
    const sourceId = String(asset.sourceId || "");
    if (!sourceId || sourceIds.has(sourceId)) throw new Error("画布包素材索引无效或重复");
    if (!ASSET_REF_PATTERN.test("openarc-asset:" + sourceId)) throw new Error("画布包素材索引不合法");
    sourceIds.add(sourceId);
    return { sourceId, path: assetPath, name: packageFileName(asset.name, "画布素材"), mime: String(asset.mime || "application/octet-stream").slice(0, 120), bytes: data.byteLength, checksum: String(asset.checksum || ""), data };
  });
  return { manifest, assets };
}

// ---------------------------------------------------------------------------
// 导入重映射（源 :124-161）
// ---------------------------------------------------------------------------

function remapValue(value, mediaIds, sourceCanvasId, targetCanvasId) {
  if (typeof value === "string") {
    const match = ASSET_REF_PATTERN.exec(value);
    if (match) {
      const target = mediaIds.get(match[1]);
      return target ? "openarc-asset:" + target : value;
    }
    if (sourceCanvasId && value === sourceCanvasId) return targetCanvasId;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => remapValue(item, mediaIds, sourceCanvasId, targetCanvasId));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const mappedKey = mediaIds.get(key) || key;
    output[mappedKey] = remapValue(item, mediaIds, sourceCanvasId, targetCanvasId);
  }
  return output;
}

/**
 * 源 :154-161：导入进来的文档不能带着导出方的运行态与来源。
 * 这里等价地：清空 logs、重置节点 runStatus/runError、丢弃 assetLibrarySources、重映射素材与画布 id。
 * @param mediaIds Map<旧 resourceId, 新 resourceId>
 */
function remapCanvasPackageDocument(document, mediaIds, targetCanvasId) {
  const sourceCanvasId = String(document && document.id ? document.id : "");
  const imported = remapValue(structuredClone(document), mediaIds instanceof Map ? mediaIds : new Map(), sourceCanvasId, String(targetCanvasId || ""));
  delete imported.assetLibrarySources;
  imported.logs = [];
  imported.nodes = (Array.isArray(imported.nodes) ? imported.nodes : []).map((node) => {
    if (!node || typeof node !== "object") return node;
    if (node.runStatus !== undefined || node.runError !== undefined) return { ...node, runStatus: "", runError: "" };
    return node;
  });
  return imported;
}

module.exports = {
  CANVAS_PACKAGE_FORMAT, CANVAS_PACKAGE_VERSION, MAX_CANVAS_PACKAGE_FILES,
  MAX_CANVAS_PACKAGE_ASSET_BYTES, MAX_CANVAS_PACKAGE_TOTAL_BYTES, MANIFEST_NAME,
  safePackageEntryName, packageFileName, collectMediaReferences,
  buildCanvasPackage, parseCanvasPackage, remapCanvasPackageDocument, sha256,
};
