/**
 * dxos-image-ratio · 无需第三方依赖的图片测量：真实像素 + 魔数格式。
 * 只解析文件头，不信任任何上游声明的尺寸/mime。
 */

export function sniffMime(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 6 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  if (b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp") {
    const brand = b.toString("ascii", 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (/^(heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) return "image/heic";
    return "image/" + brand;
  }
  return "application/octet-stream";
}

function pngSize(b) {
  if (b.length < 24) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegSize(b) {
  let pos = 2;
  const SOF = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  while (pos + 9 < b.length) {
    if (b[pos] !== 0xff) { pos += 1; continue; }
    const marker = b[pos + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
    const len = b.readUInt16BE(pos + 2);
    if (len < 2) break;
    if (SOF.has(marker)) return { width: b.readUInt16BE(pos + 7), height: b.readUInt16BE(pos + 5) };
    pos += 2 + len;
  }
  return null;
}

function webpSize(b) {
  const fourcc = b.toString("ascii", 12, 16);
  if (fourcc === "VP8X" && b.length >= 30) {
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  if (fourcc === "VP8 " && b.length >= 30) {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === "VP8L" && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  return null;
}

function gifSize(b) { return b.length >= 10 ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : null; }
function bmpSize(b) { return b.length >= 26 ? { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) } : null; }

export function measureImage(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const mime = sniffMime(b);
  let size = null;
  if (mime === "image/png") size = pngSize(b);
  else if (mime === "image/jpeg") size = jpegSize(b);
  else if (mime === "image/webp") size = webpSize(b);
  else if (mime === "image/gif") size = gifSize(b);
  else if (mime === "image/bmp") size = bmpSize(b);
  return { mime, bytes: b.length, width: size ? size.width : null, height: size ? size.height : null, magic: b.subarray(0, 8).toString("hex") };
}

export function parseSize(text) {
  const m = /^(\d{2,5})\s*x\s*(\d{2,5})$/.exec(String(text || "").trim());
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}
