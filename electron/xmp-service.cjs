/**
 * 图片来源声明（10-15，「图片声明」应用用）：把 IPTC 数字来源类型写进图片的 XMP 元数据。
 *
 *   · 完全由 AI 生成 → http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia
 *   · AI 参与编辑     → http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia
 *
 * 只处理 PNG（iTXt「XML:com.adobe.xmp」块）与 JPEG（APP1 XMP 段）；纯 Buffer 变换、不碰像素数据。
 * 原图不改动：调用方把结果另存为副本。图片里已有 XMP 时整段替换（只保留本次声明），并在结果里如实标出。
 */
"use strict";

const NS_SOURCE = "http://cv.iptc.org/newscodes/digitalsourcetype/";
const SOURCE_TYPES = { ai: "trainedAlgorithmicMedia", mix: "compositeWithTrainedAlgorithmicMedia" };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const XMP_KEYWORD = "XML:com.adobe.xmp";
const JPEG_XMP_NS = "http://ns.adobe.com/xap/1.0/\0";

function xmpPacket(kind) {
  const type = SOURCE_TYPES[kind];
  if (!type) throw new Error("INVALID_KIND");
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    '  <rdf:Description rdf:about=""\n' +
    '    xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"\n' +
    `    Iptc4xmpExt:DigitalSourceType="${NS_SOURCE}${type}"/>\n` +
    " </rdf:RDF>\n" +
    "</x:xmpmeta>\n" +
    '<?xpacket end="w"?>'
  );
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function declarePng(buf, xmp) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return { ok: false, error: "NOT_PNG" };
  const out = [buf.subarray(0, 8)];
  let off = 8;
  let inserted = false;
  let replaced = false;
  // iTXt：keyword \0 compressionFlag(0) compressionMethod(0) languageTag \0 translatedKeyword \0 text
  const itxt = pngChunk("iTXt", Buffer.concat([Buffer.from(XMP_KEYWORD + "\0\0\0\0\0", "latin1"), Buffer.from(xmp, "utf8")]));
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const end = off + 12 + len;
    if (end > buf.length) return { ok: false, error: "CORRUPT" };
    const chunk = buf.subarray(off, end);
    const isXmp = type === "iTXt" && buf.toString("latin1", off + 8, off + 8 + XMP_KEYWORD.length + 1) === XMP_KEYWORD + "\0";
    if (isXmp) replaced = true;
    else {
      // 放在第一个 IDAT 之前（XMP 规范要求在图像数据之前）
      if (!inserted && (type === "IDAT" || type === "IEND")) {
        out.push(itxt);
        inserted = true;
      }
      out.push(chunk);
    }
    off = end;
    if (type === "IEND") break;
  }
  if (!inserted) return { ok: false, error: "CORRUPT" };
  return { ok: true, buffer: Buffer.concat(out), replaced };
}

function declareJpeg(buf, xmp) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { ok: false, error: "NOT_JPEG" };
  const payload = Buffer.concat([Buffer.from(JPEG_XMP_NS, "latin1"), Buffer.from(xmp, "utf8")]);
  if (payload.length + 2 > 0xffff) return { ok: false, error: "TOO_LARGE" };
  const seg = Buffer.alloc(4);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg.writeUInt16BE(payload.length + 2, 2);
  const app1 = Buffer.concat([seg, payload]);
  const head = [buf.subarray(0, 2)];
  let off = 2;
  let replaced = false;
  let insertAt = -1;
  // 只遍历扫描数据之前的标记段（SOS 之后是熵编码数据，原样保留）
  while (off + 4 <= buf.length && buf[off] === 0xff) {
    const marker = buf[off + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI
    const len = buf.readUInt16BE(off + 2);
    const end = off + 2 + len;
    if (end > buf.length) return { ok: false, error: "CORRUPT" };
    const isXmp = marker === 0xe1 && buf.toString("latin1", off + 4, off + 4 + JPEG_XMP_NS.length) === JPEG_XMP_NS;
    if (isXmp) replaced = true;
    else {
      // XMP 段放在 APP0(JFIF) / APP1(Exif) 之后、其余标记之前
      if (insertAt < 0 && !(marker === 0xe0 || (marker === 0xe1 && !isXmp))) {
        head.push(app1);
        insertAt = off;
      }
      head.push(buf.subarray(off, end));
    }
    off = end;
  }
  if (insertAt < 0) head.push(app1);
  return { ok: true, buffer: Buffer.concat([...head, buf.subarray(off)]), replaced };
}

/** ext 取物理扩展名；kind = "ai" | "mix"。 */
function declareImage(buf, ext, kind) {
  if (!SOURCE_TYPES[kind]) return { ok: false, error: "INVALID_INPUT" };
  const xmp = xmpPacket(kind);
  const e = String(ext || "").toLowerCase();
  if (e === "png") return declarePng(buf, xmp);
  if (e === "jpg" || e === "jpeg") return declareJpeg(buf, xmp);
  return { ok: false, error: "UNSUPPORTED" };
}

/** 读回声明（测试与界面核对用）：返回 DigitalSourceType 的取值或 null。 */
function readDeclaration(buf) {
  const s = buf.toString("latin1");
  const m = /Iptc4xmpExt:DigitalSourceType="([^"]+)"/.exec(s);
  return m ? m[1] : null;
}

module.exports = { declareImage, readDeclaration, SOURCE_TYPES, NS_SOURCE, crc32 };
