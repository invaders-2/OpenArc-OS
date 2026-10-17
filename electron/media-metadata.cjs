/**
 * task-63 · 资源详情媒体元数据（零依赖、只读、有界）。
 * 有真实可解析值才返回 known/partial；解析不出或格式不支持一律 status="unknown" 且数值为 null。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_READ_BYTES = 64 * 1024 * 1024;
const UNKNOWN = Object.freeze({ width: null, height: null, durationMs: null, status: "unknown" });

function kindOf({ mimeType = "", name = "", resourceType = "" } = {}) {
  const mime = String(mimeType || "").toLowerCase();
  const ext = path.extname(String(name || "")).toLowerCase();
  const type = String(resourceType || "").toLowerCase();
  if (mime.startsWith("image/") || type === "image" || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".avif"].includes(ext)) return "image";
  if (mime.startsWith("video/") || type === "video" || [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"].includes(ext)) return "video";
  if (mime.startsWith("audio/") || type === "audio" || [".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac"].includes(ext)) return "audio";
  return "unknown";
}

function readHead(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const st = fs.fstatSync(fd);
    const size = Math.min(st.size, MAX_READ_BYTES);
    const buf = Buffer.alloc(size);
    const bytes = fs.readSync(fd, buf, 0, size, 0);
    return { ok: true, buf: buf.subarray(0, bytes), size: st.size, truncated: st.size > MAX_READ_BYTES };
  } catch {
    return { ok: false };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function png(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
    const length = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

function gif(buf) {
  if (buf.length < 10 || String(buf.subarray(0, 3)) !== "GIF") return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function webp(buf) {
  if (buf.length < 30 || String(buf.subarray(0, 4)) !== "RIFF" || String(buf.subarray(8, 12)) !== "WEBP") return null;
  const chunk = String(buf.subarray(12, 16));
  if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (chunk === "VP8 " && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L" && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

function boxes(buf, start, end) {
  const out = [];
  let i = start;
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i);
    const type = String(buf.subarray(i + 4, i + 8));
    if (size === 1) { if (i + 16 > end) break; size = Number(buf.readBigUInt64BE(i + 8)); }
    if (size === 0) size = end - i;
    if (size < 8 || i + size > end) break;
    out.push({ type, start: i, size, body: i + 8 });
    i += size;
  }
  return out;
}

function mp4(buf) {
  if (buf.length < 16) return null;
  const top = boxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) return null;
  let durationMs = null;
  let width = null;
  let height = null;
  for (const child of boxes(buf, moov.body, moov.start + moov.size)) {
    if (child.type === "mvhd") {
      const p = child.body;
      if (p + 4 > buf.length) continue;
      const version = buf[p];
      if (version === 1 && p + 32 <= buf.length) {
        const timescale = buf.readUInt32BE(p + 20);
        const duration = Number(buf.readBigUInt64BE(p + 24));
        if (timescale > 0) durationMs = Math.round((duration * 1000) / timescale);
      } else if (p + 20 <= buf.length) {
        const timescale = buf.readUInt32BE(p + 12);
        const duration = buf.readUInt32BE(p + 16);
        if (timescale > 0) durationMs = Math.round((duration * 1000) / timescale);
      }
    }
    if (child.type === "trak") {
      for (const trakChild of boxes(buf, child.body, child.start + child.size)) {
        if (trakChild.type !== "tkhd" || trakChild.body + 4 > buf.length) continue;
        const p = trakChild.body;
        const version = buf[p];
        const base = version === 1 ? p + 88 : p + 76;
        if (base + 8 <= buf.length) {
          const w = buf.readUInt32BE(base) / 65536;
          const h = buf.readUInt32BE(base + 4) / 65536;
          if (w > 0 && h > 0) { width = Math.round(w); height = Math.round(h); }
        }
      }
    }
  }
  return { width, height, durationMs };
}

function readMediaMetadata({ filePath, mimeType = "", name = "", resourceType = "" } = {}) {
  const kind = kindOf({ mimeType, name, resourceType });
  if (kind === "unknown" || !filePath) return { kind, ...UNKNOWN };
  const head = readHead(filePath);
  if (!head.ok) return { kind, ...UNKNOWN };
  let parsed = null;
  try {
    if (kind === "image") {
      parsed = png(head.buf) || jpeg(head.buf) || gif(head.buf) || webp(head.buf);
    } else if (kind === "video" || kind === "audio") {
      parsed = mp4(head.buf);
    }
  } catch { parsed = null; }
  if (!parsed) return { kind, ...UNKNOWN };
  const width = Number.isFinite(parsed.width) && parsed.width > 0 ? parsed.width : null;
  const height = Number.isFinite(parsed.height) && parsed.height > 0 ? parsed.height : null;
  const durationMs = Number.isFinite(parsed.durationMs) && parsed.durationMs >= 0 ? parsed.durationMs : null;
  const any = width != null || height != null || durationMs != null;
  const allExpected = kind === "image" ? width != null && height != null : durationMs != null;
  return { kind, width, height, durationMs, status: any ? (allExpected ? "known" : "partial") : "unknown" };
}

module.exports = { readMediaMetadata, kindOf, MAX_READ_BYTES };
