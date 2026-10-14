/**
 * B5e · AI 图像声明 / 元数据（逐函数移植自只读源 server/aiImageDeclaration.ts:1-373）。
 *
 * 行号为源文件行号：
 *   · :5-6      DECLARATION_LABEL / DECLARATION_URI
 *   · :8-11     XMP_HEADER / PNG_SIGNATURE / 归档上限
 *   · :13-27    crc32
 *   · :29-47    xmpPacket（写入/合并 Iptc4xmpExt:DigitalSourceType）
 *   · :53-139   addWindowsKeyword（JPEG EXIF XPKeywords，源注释 :49-52）
 *   · :141-171  addJpegDeclaration（APP1 XMP）
 *   · :173-181  pngChunk / :183-216 addPngDeclaration（iTXt XMP）
 *   · :218-224  riffChunk / :226-250 addWebpDeclaration（XMP chunk）
 *   · :255-263  imageKind / :265-273 normalizeToJpeg / :275-278 addDeclaration
 *   · :281-285  normalizedJpegName / :287-291 safeZipName
 *   · :293-334  readZip（inflateRawSync；上限 2000 项 / 500MB）
 *   · :343-373  processDeclarationUpload（单图直出 / 多图打包 ZIP）
 *   · zip.ts:25-80 buildZip（store 存储，零依赖）—— 逐字移植
 *
 * 解析（readDeclaration）是源没有导出的能力，按任务"写入与解析往返"补齐：
 *   与写入路径一一对应地扫 JPEG APP1 / PNG iTXt / WebP XMP 与 JPEG EXIF XPKeywords，
 *   只做"断言存在性与取值"，不改字节。
 *
 * 文件系统/图像库依赖注入：
 *   · sharpLoader 未注入时惰性 require('sharp')；缺失 → MEDIA_DEPENDENCY_UNAVAILABLE，
 *     绝不用假图/占位转换兜底（PNG/WebP → JPEG 必须真实解码）。
 *   · 纯 JPEG 路径（addJpegDeclaration + addWindowsKeyword）不需要 sharp。
 */
"use strict";

const { inflateRawSync } = require("node:zlib");

const {
  createMediaError,
  MEDIA_ERR_INVALID_INPUT,
  MEDIA_ERR_DEPENDENCY_UNAVAILABLE,
} = require("./media-domain.cjs");

/** 源 aiImageDeclaration.ts:5-6 */
const DECLARATION_LABEL = "contains-synthetic-performer";
const DECLARATION_URI = "http://cv.iptc.org/newscodes/digitalsourcetype/" + DECLARATION_LABEL;

/** 源 :8-11 */
const XMP_HEADER = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii");
const EXIF_HEADER = Buffer.from("Exif\0\0", "ascii");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_ARCHIVE_ENTRIES = 2000;
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

let extensions = Object.freeze({});

/** 依赖注入：{ sharpLoader }。 */
function configureAiImageDeclaration(options) {
  if (options && typeof options === "object") extensions = Object.freeze(Object.assign({}, extensions, options));
  return Object.assign({}, extensions);
}

function effective(options) {
  return Object.assign({}, extensions, options || {});
}

function resolveSharp(options) {
  const opts = effective(options);
  if (typeof opts.sharpLoader === "function") {
    let loaded;
    try { loaded = opts.sharpLoader(); }
    catch { throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "sharp 未安装，无法把 PNG/WebP 转为 JPEG 以写入声明", "缺少 sharp：安装 sharp 后重试；纯 JPEG 输入不需要 sharp。"); }
    if (loaded) return loaded;
  }
  try {
    return require("sharp");
  } catch {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "sharp 未安装，无法把 PNG/WebP 转为 JPEG 以写入声明", "缺少 sharp：安装 sharp 后重试；纯 JPEG 输入不需要 sharp。");
  }
}

/** 源 zip.ts:5-18（与源 aiImageDeclaration.ts:13-27 同一多项式）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

/** 源 :23-27 */
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** 源 :29-47 xmpPacket。 */
function xmpPacket(existing) {
  if (existing) {
    const attr = /\s+Iptc4xmpExt:DigitalSourceType=(['"])[\s\S]*?\1/;
    if (attr.test(existing)) return existing.replace(attr, ' Iptc4xmpExt:DigitalSourceType="' + DECLARATION_URI + '"');
    const description = /<rdf:Description\b/;
    if (description.test(existing)) {
      const namespace = existing.includes("xmlns:Iptc4xmpExt=")
        ? ""
        : ' xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"';
      return existing.replace(description, '<rdf:Description' + namespace + ' Iptc4xmpExt:DigitalSourceType="' + DECLARATION_URI + '"');
    }
  }
  return '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="DX OS AI图片声明">\n' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    '<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" ' +
    'Iptc4xmpExt:DigitalSourceType="' + DECLARATION_URI + '"/>\n' +
    '</rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>';
}

/** 源 :53-139 addWindowsKeyword：新 IFD0 指向原 TIFF，避免移动相机 EXIF 破坏内部偏移。 */
function addWindowsKeyword(input) {
  let offset = 2;
  let exifStart = -1;
  let exifEnd = -1;
  let existingTiff = null;
  while (offset + 4 <= input.length && input[offset] === 0xff) {
    const marker = input[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const segmentLength = input.readUInt16BE(offset + 2);
    const end = offset + 2 + segmentLength;
    if (segmentLength < 2 || end > input.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "JPEG 段结构无效");
    if (marker === 0xe1 && input.subarray(offset + 4, offset + 10).equals(EXIF_HEADER)) {
      exifStart = offset;
      exifEnd = end;
      existingTiff = Buffer.from(input.subarray(offset + 10, end));
      break;
    }
    offset = end;
  }

  const keyword = Buffer.from(DECLARATION_LABEL + "\0", "utf16le");
  let tiff;
  if (existingTiff) {
    if (existingTiff.length < 8) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "EXIF 数据无效");
    const byteOrder = existingTiff.subarray(0, 2).toString("ascii");
    const little = byteOrder === "II";
    if (!little && byteOrder !== "MM") throw createMediaError(MEDIA_ERR_INVALID_INPUT, "EXIF 字节序无效");
    const read16 = (at) => (little ? existingTiff.readUInt16LE(at) : existingTiff.readUInt16BE(at));
    const read32 = (at) => (little ? existingTiff.readUInt32LE(at) : existingTiff.readUInt32BE(at));
    const write16 = (target, value, at) => (little ? target.writeUInt16LE(value, at) : target.writeUInt16BE(value, at));
    const write32 = (target, value, at) => (little ? target.writeUInt32LE(value, at) : target.writeUInt32BE(value, at));
    if (read16(2) !== 42) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "EXIF TIFF 标识无效");
    const oldIfdOffset = read32(4);
    if (oldIfdOffset + 2 > existingTiff.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "EXIF IFD0 无效");
    const oldCount = read16(oldIfdOffset);
    const oldEntriesEnd = oldIfdOffset + 2 + oldCount * 12;
    if (oldEntriesEnd + 4 > existingTiff.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "EXIF IFD0 不完整");
    const entries = [];
    for (let index = 0; index < oldCount; index++) {
      const entry = Buffer.from(existingTiff.subarray(oldIfdOffset + 2 + index * 12, oldIfdOffset + 14 + index * 12));
      if (read16(oldIfdOffset + 2 + index * 12) !== 0x9c9e) entries.push(entry);
    }
    const xpEntry = Buffer.alloc(12);
    write16(xpEntry, 0x9c9e, 0);
    write16(xpEntry, 1, 2); // BYTE；Windows XPKeywords 的规范类型（源 :99）
    write32(xpEntry, keyword.length, 4);
    entries.push(xpEntry);
    entries.sort((a, b) => (little ? a.readUInt16LE(0) - b.readUInt16LE(0) : a.readUInt16BE(0) - b.readUInt16BE(0)));

    const padding = existingTiff.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
    const newIfdOffset = existingTiff.length + padding.length;
    const newIfd = Buffer.alloc(2 + entries.length * 12 + 4);
    write16(newIfd, entries.length, 0);
    entries.forEach((entry, index) => entry.copy(newIfd, 2 + index * 12));
    const nextIfd = read32(oldEntriesEnd);
    write32(newIfd, nextIfd, 2 + entries.length * 12);
    const keywordOffset = newIfdOffset + newIfd.length;
    const xpIndex = entries.findIndex((entry) => (little ? entry.readUInt16LE(0) : entry.readUInt16BE(0)) === 0x9c9e);
    write32(newIfd, keywordOffset, 2 + xpIndex * 12 + 8);
    tiff = Buffer.concat([existingTiff, padding, newIfd, keyword]);
    write32(tiff, newIfdOffset, 4);
  } else {
    tiff = Buffer.alloc(8 + 2 + 12 + 4 + keyword.length);
    tiff.write("II", 0, 2, "ascii");
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x9c9e, 10);
    tiff.writeUInt16LE(1, 12);
    tiff.writeUInt32LE(keyword.length, 14);
    tiff.writeUInt32LE(26, 18);
    tiff.writeUInt32LE(0, 22);
    keyword.copy(tiff, 26);
  }

  const payload = Buffer.concat([EXIF_HEADER, tiff]);
  if (payload.length + 2 > 0xffff) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "EXIF 元数据过大，无法添加 Windows 标记");
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  const fullSegment = Buffer.concat([segment, payload]);
  if (exifStart >= 0) return Buffer.concat([input.subarray(0, exifStart), fullSegment, input.subarray(exifEnd)]);
  return Buffer.concat([input.subarray(0, 2), fullSegment, input.subarray(2)]);
}

/** 源 :141-171 addJpegDeclaration。 */
function addJpegDeclaration(input) {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "JPEG 文件无效");
  let offset = 2;
  let existingStart = -1;
  let existingEnd = -1;
  let existingXmp;
  while (offset + 4 <= input.length && input[offset] === 0xff) {
    const marker = input[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const segmentLength = input.readUInt16BE(offset + 2);
    const end = offset + 2 + segmentLength;
    if (segmentLength < 2 || end > input.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "JPEG 段结构无效");
    if (marker === 0xe1 && input.subarray(offset + 4, offset + 4 + XMP_HEADER.length).equals(XMP_HEADER)) {
      existingStart = offset;
      existingEnd = end;
      existingXmp = input.subarray(offset + 4 + XMP_HEADER.length, end).toString("utf8");
      break;
    }
    offset = end;
  }
  const payload = Buffer.concat([XMP_HEADER, Buffer.from(xmpPacket(existingXmp), "utf8")]);
  if (payload.length + 2 > 0xffff) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "XMP 元数据过大");
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  const fullSegment = Buffer.concat([segment, payload]);
  if (existingStart >= 0) return Buffer.concat([input.subarray(0, existingStart), fullSegment, input.subarray(existingEnd)]);
  return Buffer.concat([input.subarray(0, 2), fullSegment, input.subarray(2)]);
}

/** 源 :173-181 pngChunk。 */
function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}

/** 源 :183-216 addPngDeclaration。 */
function addPngDeclaration(input) {
  if (!input.subarray(0, 8).equals(PNG_SIGNATURE)) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "PNG 文件无效");
  const chunks = [PNG_SIGNATURE];
  let offset = 8;
  let inserted = false;
  let existingXmp;
  const parsed = [];
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > input.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "PNG 块结构无效");
    const type = input.subarray(offset + 4, offset + 8).toString("ascii");
    const data = input.subarray(offset + 8, offset + 8 + length);
    const isXmp = type === "iTXt" && data.subarray(0, 18).toString("latin1") === "XML:com.adobe.xmp\0";
    if (isXmp) {
      const separators = [];
      for (let i = 0; i < data.length && separators.length < 5; i++) if (data[i] === 0) separators.push(i);
      const textStart = separators.length >= 5 ? separators[4] + 1 : 22;
      existingXmp = data.subarray(textStart).toString("utf8");
    } else parsed.push({ type, raw: input.subarray(offset, end), data });
    offset = end;
    if (type === "IEND") break;
  }
  const xmpData = Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"), Buffer.from(xmpPacket(existingXmp), "utf8")]);
  for (const chunk of parsed) {
    if (!inserted && chunk.type === "IDAT") {
      chunks.push(pngChunk("iTXt", xmpData));
      inserted = true;
    }
    chunks.push(chunk.raw);
  }
  if (!inserted) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "PNG 缺少图像数据");
  return Buffer.concat(chunks);
}

/** 源 :218-224 riffChunk。 */
function riffChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + (data.length % 2));
  out.write(type, 0, 4, "ascii");
  out.writeUInt32LE(data.length, 4);
  data.copy(out, 8);
  return out;
}

/** 源 :226-250 addWebpDeclaration。 */
function addWebpDeclaration(input) {
  if (input.length < 12 || input.subarray(0, 4).toString("ascii") !== "RIFF" || input.subarray(8, 12).toString("ascii") !== "WEBP") {
    throw createMediaError(MEDIA_ERR_INVALID_INPUT, "WebP 文件无效");
  }
  const chunks = [];
  let offset = 12;
  let existingXmp;
  while (offset + 8 <= input.length) {
    const type = input.subarray(offset, offset + 4).toString("ascii");
    const length = input.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (end > input.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "WebP 块结构无效");
    const data = Buffer.from(input.subarray(offset + 8, offset + 8 + length));
    if (type === "XMP ") existingXmp = data.toString("utf8");
    else {
      if (type === "VP8X" && data.length) data[0] |= 0x04;
      chunks.push(riffChunk(type, data));
    }
    offset = end;
  }
  chunks.push(riffChunk("XMP ", Buffer.from(xmpPacket(existingXmp), "utf8")));
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** 源 :255-263 imageKind：先按真实字节识别，扩展名只作损坏文件提示兜底。 */
function imageKind(name, data) {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) return "jpeg";
  if (data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "png";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (/\.jpe?g$/i.test(name)) return "jpeg";
  if (/\.png$/i.test(name)) return "png";
  if (/\.webp$/i.test(name)) return "webp";
  return null;
}

/** 源 :265-273 normalizeToJpeg：非 JPEG 必须真实解码，sharp 缺失即结构化不可用。 */
async function normalizeToJpeg(name, data, options) {
  const kind = imageKind(name, data);
  if (!kind) return null;
  if (kind === "jpeg") return data;
  const sharp = resolveSharp(options);
  return sharp(data)
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

/** 源 :275-278 addDeclaration。 */
async function addDeclaration(name, data, options) {
  const jpeg = await normalizeToJpeg(name, data, options);
  return jpeg ? addWindowsKeyword(addJpegDeclaration(jpeg)) : null;
}

/** 源 :281-285 normalizedJpegName：所有输入统一输出为 JPEG，错误扩展名同步修正。 */
function normalizedJpegName(name) {
  const current = name.match(/\.[^./]+$/)?.[0].toLowerCase();
  const valid = current === ".jpg" || current === ".jpeg";
  return valid ? name : current ? name.slice(0, -current.length) + ".jpg" : name + ".jpg";
}

/** 源 :287-291 safeZipName。 */
function safeZipName(name) {
  const clean = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.split("/").some((part) => part === "..")) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "ZIP 中包含不安全路径");
  return clean;
}

/** 源 :293-334 readZip（inflateRawSync；上限与源一致）。 */
function readZip(input) {
  let eocd = -1;
  for (let i = input.length - 22; i >= Math.max(0, input.length - 65557); i--) {
    if (input.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "ZIP 文件无效或不受支持");
  const count = input.readUInt16LE(eocd + 10);
  const centralOffset = input.readUInt32LE(eocd + 16);
  if (count > MAX_ARCHIVE_ENTRIES) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "ZIP 文件数量超过 " + MAX_ARCHIVE_ENTRIES + " 个");
  const entries = [];
  let total = 0;
  let offset = centralOffset;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > input.length || input.readUInt32LE(offset) !== 0x02014b50) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "ZIP 目录结构无效");
    const flags = input.readUInt16LE(offset + 8);
    const method = input.readUInt16LE(offset + 10);
    const compressedSize = input.readUInt32LE(offset + 20);
    const size = input.readUInt32LE(offset + 24);
    const nameLength = input.readUInt16LE(offset + 28);
    const extraLength = input.readUInt16LE(offset + 30);
    const commentLength = input.readUInt16LE(offset + 32);
    const localOffset = input.readUInt32LE(offset + 42);
    const rawName = input.subarray(offset + 46, offset + 46 + nameLength);
    const name = safeZipName(rawName.toString(flags & 0x0800 ? "utf8" : "latin1"));
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (flags & 0x0001) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "暂不支持加密 ZIP");
    if (localOffset + 30 > input.length || input.readUInt32LE(localOffset) !== 0x04034b50) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "ZIP 文件项无效");
    const localNameLength = input.readUInt16LE(localOffset + 26);
    const localExtraLength = input.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = input.subarray(start, start + compressedSize);
    if (compressed.length !== compressedSize) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "ZIP 文件项不完整");
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : null;
    if (!data) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "ZIP 使用了不支持的压缩方式：" + method);
    if (data.length !== size) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "ZIP 文件项大小校验失败");
    total += data.length;
    if (total > MAX_UNCOMPRESSED_BYTES) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "ZIP 解压后超过 500 MB");
    entries.push({ name, data });
  }
  return entries;
}

/** 源 zip.ts:25-80 buildZip（store，零依赖，UTF-8 名称位）。 */
function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, entry.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + size;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, centralBuf, eocd]);
}

/** 源 :343-373 processDeclarationUpload。 */
async function processDeclarationUpload(files, options) {
  if (!Array.isArray(files) || !files.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "请选择图片或 ZIP 文件");
  const output = [];
  let imageCount = 0;
  let archiveInput = false;
  for (const file of files) {
    const isZip = /\.zip$/i.test(file.name) || file.data.subarray(0, 4).toString("binary") === "PK\x03\x04";
    if (isZip) {
      archiveInput = true;
      const prefix = files.length > 1 ? file.name.replace(/\.zip$/i, "") + "/" : "";
      for (const entry of readZip(file.data)) {
        const kind = imageKind(entry.name, entry.data);
        const declared = kind ? await addDeclaration(entry.name, entry.data, options) : null;
        if (declared) imageCount++;
        output.push({ name: prefix + (kind ? normalizedJpegName(entry.name) : entry.name), data: declared || entry.data });
      }
    } else {
      const kind = imageKind(file.name, file.data);
      const declared = kind ? await addDeclaration(file.name, file.data, options) : null;
      if (!declared || !kind) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "不支持的图片格式：" + file.name + "（支持 JPG、PNG、WebP）");
      imageCount++;
      output.push({ name: safeZipName(normalizedJpegName(file.name)), data: declared });
    }
  }
  if (!imageCount) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "没有找到可处理的 JPG、PNG 或 WebP 图片");
  if (files.length === 1 && !archiveInput && output.length === 1) {
    const entry = output[0];
    return { data: entry.data, filename: entry.name, mime: "image/jpeg", imageCount };
  }
  return { data: buildZip(output), filename: "AI图片声明_已处理.zip", mime: "application/zip", imageCount };
}

// ---------------------------------------------------------------------------
// 解析（任务要求"写入/解析往返"；源没有导出解析入口）
// ---------------------------------------------------------------------------

function scanJpegXmp(data) {
  let offset = 2;
  while (offset + 4 <= data.length && data[offset] === 0xff) {
    const marker = data[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const segmentLength = data.readUInt16BE(offset + 2);
    const end = offset + 2 + segmentLength;
    if (segmentLength < 2 || end > data.length) return null;
    if (marker === 0xe1 && data.subarray(offset + 4, offset + 4 + XMP_HEADER.length).equals(XMP_HEADER)) {
      return data.subarray(offset + 4 + XMP_HEADER.length, end).toString("utf8");
    }
    offset = end;
  }
  return null;
}

function scanPngXmp(data) {
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) return null;
    const type = data.subarray(offset + 4, offset + 8).toString("ascii");
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === "iTXt" && chunk.subarray(0, 18).toString("latin1") === "XML:com.adobe.xmp\0") {
      const separators = [];
      for (let i = 0; i < chunk.length && separators.length < 5; i++) if (chunk[i] === 0) separators.push(i);
      const textStart = separators.length >= 5 ? separators[4] + 1 : 22;
      return chunk.subarray(textStart).toString("utf8");
    }
    offset = end;
    if (type === "IEND") break;
  }
  return null;
}

function scanWebpXmp(data) {
  let offset = 12;
  while (offset + 8 <= data.length) {
    const type = data.subarray(offset, offset + 4).toString("ascii");
    const length = data.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (end > data.length) return null;
    if (type === "XMP ") return data.subarray(offset + 8, offset + 8 + length).toString("utf8");
    offset = end;
  }
  return null;
}

/** 解析写入的声明（与写入路径一一对应）；不支持的格式回 INVALID_INPUT。 */
function readDeclaration(name, data) {
  const kind = imageKind(name, data);
  if (!kind) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "不支持的图片格式，无法解析声明");
  const xmp = kind === "jpeg" ? scanJpegXmp(data) : kind === "png" ? scanPngXmp(data) : scanWebpXmp(data);
  const xmpPresent = typeof xmp === "string";
  const windowsKeyword = kind === "jpeg" && data.includes(Buffer.from(DECLARATION_LABEL, "utf16le"));
  return {
    format: kind,
    declared: (xmpPresent && xmp.includes(DECLARATION_URI)) || windowsKeyword,
    label: DECLARATION_LABEL,
    uri: DECLARATION_URI,
    xmpPresent,
    windowsKeyword,
  };
}

module.exports = {
  DECLARATION_LABEL,
  DECLARATION_URI,
  MAX_ARCHIVE_ENTRIES,
  MAX_UNCOMPRESSED_BYTES,
  configureAiImageDeclaration,
  crc32,
  xmpPacket,
  addWindowsKeyword,
  addJpegDeclaration,
  pngChunk,
  addPngDeclaration,
  riffChunk,
  addWebpDeclaration,
  imageKind,
  normalizeToJpeg,
  addDeclaration,
  normalizedJpegName,
  safeZipName,
  readZip,
  buildZip,
  processDeclarationUpload,
  readDeclaration,
};
