/**
 * B7d · 领星映射表格（逐函数移植 server/lingxingMappings.ts:1-289）。
 *
 * 逐函数对应（源行号）：
 *   lingxingMappings.ts:39-41   MAX_FILE_BYTES / MAX_ROWS / HEADER_SCAN_ROWS
 *   lingxingMappings.ts:43-53   mappingRoot / mappingDir / metadataPath
 *   lingxingMappings.ts:55-58   validDataset
 *   lingxingMappings.ts:60-80   migrateLatestUserMapping（旧用户目录 → shared）
 *   lingxingMappings.ts:82-114  normalizeHeader / isAsinHeader / isSiteHeader / isPrincipalHeader /
 *                               splitMultiValues / normalizeAsin / decodeFileName / fieldId
 *   lingxingMappings.ts:116-141 enrichSiteRecords（负责人多值拆分 + 站点维度聚合）
 *   lingxingMappings.ts:143-153 cellText / readWorkbook
 *   lingxingMappings.ts:155-264 importLingxingMapping
 *   lingxingMappings.ts:266-277 getLingxingMapping
 *   lingxingMappings.ts:279-289 getLingxingMappingFile
 *
 * 与源文件的差异（任务书硬约束）：
 *   · 源 readWorkbook 用动态 import('exceljs')；本仓不新增依赖，改为**注入 readWorkbook**。
 *     未注入时结构化不可用（INTEGRATION_UNAVAILABLE），绝不假装解析成功；
 *   · 源落 dataPath('lingxing-mappings')；本移植落 <dataDir>/lingxing-mappings（dataDir 由主进程注入）；
 *   · 函数全部返回源形状对象；失败以带 code 的 Error 抛出，由 plugin-service 统一转结构化。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const { INTEGRATION_ERR_UNAVAILABLE, INTEGRATION_ERR_INVALID_INPUT, INTEGRATION_ERR_NOT_FOUND } = require("./plugin-registry.cjs");

// lingxingMappings.ts:39-41 逐字
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_ROWS = 200000;
const HEADER_SCAN_ROWS = 50;

const MAPPING_DIR_NAME = "lingxing-mappings";
const SHARED_DIR_NAME = "shared";
const METADATA_FILE_NAME = "mapping.json";

function fail(code, detail) { const error = new Error(detail); error.code = code; return error; }

// ── 路径（lingxingMappings.ts:43-53） ──
function createMappingPaths(dataDir) {
  const root = dataDir ? path.join(String(dataDir), MAPPING_DIR_NAME) : null;
  const dir = root ? path.join(root, SHARED_DIR_NAME) : null;
  return { root, dir, metadata: dir ? path.join(dir, METADATA_FILE_NAME) : null };
}

// lingxingMappings.ts:55-58 逐字
function validDataset(value) {
  const dataset = value;
  return !!dataset && dataset.version === 1 && !!dataset.records && Array.isArray(dataset.fields) && typeof dataset.storedFileName === "string";
}

// lingxingMappings.ts:82-84
function normalizeHeader(value) {
  return String(value == null ? "" : value).trim().toLocaleLowerCase().replace(/[\s_\-:：]+/g, "");
}
// lingxingMappings.ts:86-88
function isAsinHeader(value) { return new Set(["asin", "asin码", "asinid", "商品asin"]).has(normalizeHeader(value)); }
// lingxingMappings.ts:90-92
function isSiteHeader(value) {
  return new Set(["站点", "站点代码", "国家站点", "销售站点", "site", "sitecode", "marketplace", "marketplacecode", "countrycode"]).has(normalizeHeader(value));
}
// lingxingMappings.ts:94-96
function isPrincipalHeader(value) { return new Set(["负责人", "principal", "owner"]).has(normalizeHeader(value)); }
// lingxingMappings.ts:98-100
function splitMultiValues(value) { return String(value == null ? "" : value).split(/[,，、;；]+/).map((item) => item.trim()).filter(Boolean); }
// lingxingMappings.ts:102-104
function normalizeAsin(value) { return String(value == null ? "" : value).trim().toUpperCase(); }
// lingxingMappings.ts:106-110
function decodeFileName(value) {
  const text = String(value == null ? "" : value);
  if ([...text].some((character) => character.charCodeAt(0) > 255)) return text;
  const decoded = Buffer.from(text, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? text : decoded;
}
// lingxingMappings.ts:112-114
function fieldId(label) {
  return "field_" + createHash("sha1").update(normalizeHeader(label)).digest("hex").slice(0, 12);
}
// lingxingMappings.ts:143-145
function cellText(cell) { return String((cell && cell.text) || "").trim(); }

// lingxingMappings.ts:116-141 逐函数移植
function enrichSiteRecords(dataset) {
  const principalFieldIds = new Set(dataset.fields.filter((field) => isPrincipalHeader(field.label)).map((field) => field.id));
  const fields = dataset.fields.map((field) => {
    if (!principalFieldIds.has(field.id)) return field;
    const uniqueValues = [...new Set(field.uniqueValues.flatMap(splitMultiValues))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    return Object.assign({}, field, { uniqueValues, valueCount: uniqueValues.length });
  });
  const siteFieldId = dataset.siteFieldId || ((fields.find((field) => isSiteHeader(field.label)) || {}).id || "");
  const siteRecords = {};
  if (siteFieldId) {
    for (const [asin, rows] of Object.entries(dataset.recordRows || {})) {
      for (const row of rows) {
        const site = String(row[siteFieldId] || "").trim().toUpperCase();
        if (!site) continue;
        if (!siteRecords[asin]) siteRecords[asin] = {};
        const record = siteRecords[asin][site] || (siteRecords[asin][site] = {});
        for (const [id, value] of Object.entries(row)) {
          if (!value) continue;
          const values = record[id] || (record[id] = []);
          for (const item of principalFieldIds.has(id) ? splitMultiValues(value) : [value]) if (!values.includes(item)) values.push(item);
        }
      }
    }
  }
  return Object.assign({}, dataset, {
    fields, siteFieldId, siteRecords,
    siteRecordCount: Object.values(siteRecords).reduce((count, sites) => count + Object.keys(sites).length, 0),
  });
}

/** lingxingMappings.ts:60-80：旧版按用户目录的 mapping.json 迁移到 shared/（只挑 uploadedAt 最新的一份）。 */
function migrateLatestUserMapping(paths) {
  if (!paths.root || !paths.dir || !paths.metadata) return;
  if (fs.existsSync(paths.metadata) || !fs.existsSync(paths.root)) return;
  let latest = null;
  for (const entry of fs.readdirSync(paths.root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === SHARED_DIR_NAME) continue;
    const directory = path.join(paths.root, entry.name);
    const legacyMetadata = path.join(directory, METADATA_FILE_NAME);
    if (!fs.existsSync(legacyMetadata)) continue;
    try {
      const dataset = JSON.parse(fs.readFileSync(legacyMetadata, "utf8"));
      if (!validDataset(dataset) || !fs.existsSync(path.join(directory, dataset.storedFileName))) continue;
      if (!latest || dataset.uploadedAt > latest.dataset.uploadedAt) latest = { directory, dataset };
    } catch { /* 跳过损坏的旧映射 */ }
  }
  if (!latest) return;
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.copyFileSync(path.join(latest.directory, latest.dataset.storedFileName), path.join(paths.dir, latest.dataset.storedFileName));
  const temporaryMetadata = paths.metadata + "." + process.pid + ".migrating.tmp";
  fs.writeFileSync(temporaryMetadata, JSON.stringify(latest.dataset), "utf8");
  fs.renameSync(temporaryMetadata, paths.metadata);
}

/** 默认 XLSX/CSV 解析器：本仓未随包 exceljs，未注入即结构化不可用（不新增依赖）。 */
async function defaultReadWorkbook() {
  throw fail(INTEGRATION_ERR_UNAVAILABLE, "未注入表格解析器 readWorkbook（本移植不新增依赖，未随包 exceljs）；请在主进程注入解析器后重试");
}

function createLingxingMappings(options = {}) {
  const dataDir = options.dataDir ? String(options.dataDir) : null;
  const paths = createMappingPaths(dataDir);
  const readWorkbook = typeof options.readWorkbook === "function" ? options.readWorkbook : defaultReadWorkbook;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();

  /** lingxingMappings.ts:155-264 逐函数移植。失败抛带 code 的 Error。 */
  async function importLingxingMapping(file) {
    const buffer = file && file.buffer;
    if (!buffer || !buffer.length) throw fail(INTEGRATION_ERR_INVALID_INPUT, "请选择需要上传的映射表格");
    if (buffer.length > MAX_FILE_BYTES) throw fail(INTEGRATION_ERR_INVALID_INPUT, "映射表格不能超过 24 MB");
    const fileName = decodeFileName((file && file.originalname) || "mapping.xlsx");
    const extension = path.extname(fileName).toLocaleLowerCase();
    if (![".xlsx", ".csv"].includes(extension)) throw fail(INTEGRATION_ERR_INVALID_INPUT, "目前支持 XLSX 和 CSV 格式");

    const workbook = await readWorkbook(buffer, extension);
    const records = {};
    const recordRows = {};
    const fieldLabels = new Map();
    const fieldValues = new Map();
    const sheets = [];
    let rowCount = 0;

    for (const worksheet of workbook.worksheets || []) {
      let headerRowNumber = 0;
      let asinColumn = 0;
      const scanEnd = Math.min(worksheet.rowCount, HEADER_SCAN_ROWS);
      for (let rowNumber = 1; rowNumber <= scanEnd; rowNumber += 1) {
        const row = worksheet.getRow(rowNumber);
        for (let column = 1; column <= Math.max(row.cellCount, worksheet.columnCount); column += 1) {
          if (isAsinHeader(cellText(row.getCell(column)))) {
            headerRowNumber = rowNumber;
            asinColumn = column;
            break;
          }
        }
        if (asinColumn) break;
      }
      if (!asinColumn) continue;

      const headerRow = worksheet.getRow(headerRowNumber);
      const columns = [];
      for (let column = 1; column <= Math.max(headerRow.cellCount, worksheet.columnCount); column += 1) {
        const label = cellText(headerRow.getCell(column));
        if (!label || column === asinColumn) continue;
        const normalized = normalizeHeader(label);
        if (!normalized) continue;
        const existingLabel = fieldLabels.get(normalized);
        const finalLabel = existingLabel || label;
        const id = fieldId(finalLabel);
        fieldLabels.set(normalized, finalLabel);
        if (!fieldValues.has(id)) fieldValues.set(id, new Set());
        columns.push({ column, id, label: finalLabel });
      }

      let mappedRows = 0;
      for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
        if (rowCount >= MAX_ROWS) throw fail(INTEGRATION_ERR_INVALID_INPUT, "映射表格数据不能超过 " + MAX_ROWS.toLocaleString() + " 行");
        const row = worksheet.getRow(rowNumber);
        const asin = normalizeAsin(cellText(row.getCell(asinColumn)));
        if (!asin) continue;
        const record = records[asin] || (records[asin] = {});
        const sourceRow = {};
        for (const column of columns) {
          const value = cellText(row.getCell(column.column));
          if (!value) continue;
          sourceRow[column.id] = value;
          const values = record[column.id] || (record[column.id] = []);
          if (!values.includes(value)) values.push(value);
          const bucket = fieldValues.get(column.id);
          if (bucket) bucket.add(value);
        }
        const asinRows = recordRows[asin] || (recordRows[asin] = []);
        asinRows.push(sourceRow);
        mappedRows += 1;
        rowCount += 1;
      }
      sheets.push({ name: worksheet.name, headerRow: headerRowNumber, rowCount: worksheet.rowCount, mappedRows });
    }

    if (!sheets.length) throw fail(INTEGRATION_ERR_INVALID_INPUT, "没有找到 ASIN 表头；请确认至少一个工作表包含名为 ASIN 的列");
    if (!rowCount) throw fail(INTEGRATION_ERR_INVALID_INPUT, "找到了 ASIN 表头，但没有读取到有效的 ASIN 数据");

    const labelById = new Map([...fieldLabels.values()].map((label) => [fieldId(label), label]));
    const fields = [...fieldValues.entries()].map(([id, values]) => ({
      id,
      label: labelById.get(id) || id,
      uniqueValues: [...values].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })),
      valueCount: values.size,
    }));

    if (!paths.dir || !paths.metadata) throw fail(INTEGRATION_ERR_UNAVAILABLE, "映射表格需要可写的本地数据目录（dataDir 未配置）");
    fs.mkdirSync(paths.dir, { recursive: true });
    const digest = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    const storedFileName = "mapping-source-" + digest + extension;
    const storedPath = path.join(paths.dir, storedFileName);
    if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, buffer);
    const dataset = enrichSiteRecords({
      version: 1,
      fileName,
      storedFileName,
      fileSize: buffer.length,
      uploadedAt: clock(),
      asinCount: Object.keys(records).length,
      rowCount,
      fields,
      sheets,
      records,
      recordRows,
    });
    const targetMetadata = paths.metadata;
    const temporaryMetadata = targetMetadata + "." + process.pid + ".tmp";
    fs.writeFileSync(temporaryMetadata, JSON.stringify(dataset), "utf8");
    fs.renameSync(temporaryMetadata, targetMetadata);
    for (const entry of fs.readdirSync(paths.dir)) {
      if (entry.startsWith("mapping-source-") && entry !== storedFileName) fs.rmSync(path.join(paths.dir, entry), { force: true });
    }
    return dataset;
  }

  /** lingxingMappings.ts:266-277 逐函数移植。 */
  function getLingxingMapping() {
    migrateLatestUserMapping(paths);
    if (!paths.metadata || !fs.existsSync(paths.metadata)) return null;
    try {
      const dataset = JSON.parse(fs.readFileSync(paths.metadata, "utf8"));
      if (!validDataset(dataset)) return null;
      return enrichSiteRecords(dataset);
    } catch {
      return null;
    }
  }

  /** lingxingMappings.ts:279-289 逐函数移植。 */
  function getLingxingMappingFile() {
    const dataset = getLingxingMapping();
    if (!dataset) throw fail(INTEGRATION_ERR_NOT_FOUND, "尚未上传映射表格");
    const file = path.join(paths.dir, dataset.storedFileName);
    if (!fs.existsSync(file)) throw fail(INTEGRATION_ERR_NOT_FOUND, "最新映射源文件不存在，请重新上传");
    return {
      path: file,
      fileName: dataset.fileName,
      contentType: dataset.fileName.toLocaleLowerCase().endsWith(".csv") ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }

  /** B7d 增补：删除映射（源无对应函数；用于"重置"路径，保持磁盘与内存一致）。 */
  function clearLingxingMapping() {
    if (!paths.dir || !paths.metadata) return { ok: true, value: { cleared: false } };
    let cleared = false;
    try { if (fs.existsSync(paths.metadata)) { fs.rmSync(paths.metadata, { force: true }); cleared = true; } } catch { /* 忽略 */ }
    try {
      if (fs.existsSync(paths.dir)) {
        for (const entry of fs.readdirSync(paths.dir)) if (entry.startsWith("mapping-source-")) { fs.rmSync(path.join(paths.dir, entry), { force: true }); cleared = true; }
      }
    } catch { /* 忽略 */ }
    return { ok: true, value: { cleared } };
  }

  return { paths, importLingxingMapping, getLingxingMapping, getLingxingMappingFile, clearLingxingMapping };
}

module.exports = {
  createLingxingMappings,
  createMappingPaths,
  defaultReadWorkbook,
  validDataset,
  normalizeHeader,
  isAsinHeader,
  isSiteHeader,
  isPrincipalHeader,
  splitMultiValues,
  normalizeAsin,
  decodeFileName,
  fieldId,
  cellText,
  enrichSiteRecords,
  migrateLatestUserMapping,
  MAX_FILE_BYTES,
  MAX_ROWS,
  HEADER_SCAN_ROWS,
  MAPPING_DIR_NAME,
  SHARED_DIR_NAME,
  METADATA_FILE_NAME,
};
