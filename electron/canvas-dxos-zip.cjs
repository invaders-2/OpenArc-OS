/**
 * B5c · 无限画布：零依赖 ZIP 编解码（.dxcanvas 的载体）。
 *
 * 为什么自己写而不是引 adm-zip / jszip：
 *   硬约束「不新增依赖」。源 server/canvasPackage.ts:6 用 adm-zip，本仓 node_modules 里没有
 *   （实测 require('adm-zip') 失败），因此用 node:zlib 的 deflateRaw/inflateRaw 自己实现
 *   最小 ZIP 读写。只支持 store(0) / deflate(8) 与单盘、非 Zip64、非加密 —— 超出即明确拒绝，
 *   不做"尽力而为"的静默降级。
 *
 * 与源的关系：
 *   · 源 server/canvasPackage.ts:11-14 的格式常量与体积上限在 canvas-dxos-package.cjs 落地；
 *     本文件只负责"字节 ⇄ 条目"，不做画布语义。
 *   · 源用 adm-zip 的 getEntries/getEntry/header.size；这里等价能力是 readZip(buffer) 返回
 *     [{ name, data, crc32 }]，并且**在读时校验 CRC 与长度**（源并未校验 CRC，这里是增强项）。
 */
"use strict";

const zlib = require("node:zlib");

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** 单文件与总量上限：与源 server/canvasPackage.ts:12-14 同口径。 */
const ZIP_LIMITS = Object.freeze({
  ENTRIES: 5000,
  ENTRY_BYTES: 500 * 1024 * 1024,
  TOTAL_BYTES: 1024 * 1024 * 1024,
  NAME_CHARS: 300,
});

const METHOD = Object.freeze({ STORE: 0, DEFLATE: 8 });

// ---------------------------------------------------------------------------
// CRC32（ZIP 规范多项式 0xEDB88320）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buffer[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

/**
 * @param {Array<{ name: string, data: Buffer }>} entries
 * @returns {Buffer} 一个可被标准 unzip 读取的 ZIP
 */
function writeZip(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("ZIP 至少需要一个条目");
  if (entries.length > ZIP_LIMITS.ENTRIES) throw new Error("ZIP 条目数量超过上限");
  const locals = [];
  const centrals = [];
  const names = new Set();
  let offset = 0;
  let total = 0;
  for (const entry of entries) {
    const name = String((entry && entry.name) || "");
    if (!name || name.length > ZIP_LIMITS.NAME_CHARS) throw new Error("ZIP 条目名无效");
    if (names.has(name)) throw new Error("ZIP 包含重复条目名：" + name);
    names.add(name);
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || "");
    if (raw.length > ZIP_LIMITS.ENTRY_BYTES) throw new Error("ZIP 单个条目超过 500 MB：" + name);
    total += raw.length;
    if (total > ZIP_LIMITS.TOTAL_BYTES) throw new Error("ZIP 条目总量超过 1 GB");
    const stored = raw.length < 64 ? raw : zlib.deflateRawSync(raw);
    const method = stored.length < raw.length ? METHOD.DEFLATE : METHOD.STORE;
    const payload = method === METHOD.DEFLATE ? stored : raw;
    const crc = crc32(raw);
    const nameBuf = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // bit 11：UTF-8 名称
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // dos time
    local.writeUInt16LE(0x2821, 12); // dos date：2020-01-01，固定值保证可复现
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2821, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

function findEocd(buffer) {
  const minimum = 22;
  if (buffer.length < minimum) return -1;
  const start = Math.max(0, buffer.length - (0xffff + minimum));
  for (let i = buffer.length - minimum; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 读 ZIP 并**校验每个条目的长度与 CRC**（源 server/canvasPackage.ts:86-122 只比对清单里的大小，
 * 这里把"包内字节被改动"也挡在解析层）。
 * @returns {Array<{ name: string, data: Buffer }>}
 */
function readZip(buffer, limits = {}) {
  const maxEntries = Number(limits.maxEntries) > 0 ? Number(limits.maxEntries) : ZIP_LIMITS.ENTRIES;
  const maxEntryBytes = Number(limits.maxEntryBytes) > 0 ? Number(limits.maxEntryBytes) : ZIP_LIMITS.ENTRY_BYTES;
  const maxTotalBytes = Number(limits.maxTotalBytes) > 0 ? Number(limits.maxTotalBytes) : ZIP_LIMITS.TOTAL_BYTES;
  const eocdAt = findEocd(buffer);
  if (eocdAt < 0) throw new Error("不是有效的 ZIP：缺少中央目录结尾记录");
  const totalEntries = buffer.readUInt16LE(eocdAt + 10);
  const centralSize = buffer.readUInt32LE(eocdAt + 12);
  const centralOffset = buffer.readUInt32LE(eocdAt + 16);
  if (!totalEntries) throw new Error("ZIP 为空");
  if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) throw new Error("不支持 Zip64 画布包");
  if (totalEntries > maxEntries) throw new Error("画布包文件数量无效");
  if (centralOffset + centralSize > buffer.length) throw new Error("ZIP 中央目录越界");

  const out = [];
  const names = new Set();
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== SIG_CENTRAL) throw new Error("ZIP 中央目录损坏");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (flags & 0x1) throw new Error("不支持加密的 ZIP 条目");
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (!name) throw new Error("ZIP 条目名缺失");
    if (names.has(name)) throw new Error("画布包包含重复文件：" + name);
    names.add(name);
    if (compressedSize > maxEntryBytes || uncompressedSize > maxEntryBytes) throw new Error("画布包包含超过 500 MB 的单个文件");
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error("ZIP 本地文件头损坏：" + name);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error("ZIP 条目数据越界：" + name);
    const payload = buffer.subarray(dataStart, dataEnd);
    let data;
    if (method === METHOD.STORE) data = Buffer.from(payload);
    else if (method === METHOD.DEFLATE) {
      try { data = zlib.inflateRawSync(payload); }
      catch { throw new Error("ZIP 条目解压失败：" + name); }
    } else throw new Error("不支持的 ZIP 压缩方式：" + method);
    if (data.length !== uncompressedSize) throw new Error("ZIP 条目长度校验失败：" + name);
    if (crc32(data) !== crc) throw new Error("ZIP 条目 CRC 校验失败：" + name);
    total += data.length;
    if (total > maxTotalBytes) throw new Error("画布包素材总量超过 1 GB");
    out.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

module.exports = { crc32, writeZip, readZip, ZIP_LIMITS, METHOD };
