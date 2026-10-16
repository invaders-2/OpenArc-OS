/**
 * 最小 PNG 写入器（零依赖）—— 只用于给照片探针造真实可解码的图片文件。
 *
 * 为什么自己写：photos 的缩略图走 sharp 真解码，测试夹具用 Buffer.from("aaaa")
 * 的假字节会让 photos/sourceThumbnail 回 PHOTOS_DECODE_FAILED，网格就永远等不到缩略图。
 * 这里用 node:zlib + 手写 CRC32 生成合法 RGB PNG，不引入任何第三方图片库。
 */
import fs from "node:fs";
import zlib from "node:zlib";

const CRC_TABLE = (function () {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, "ascii"), data]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

/** 以 rgb(x, y) -> [r,g,b] 生成 width×height 的 8bit RGB PNG 文件。 */
export function writePng(file, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o] = 0;
    o += 1;
    for (let x = 0; x < width; x += 1) {
      const px = rgb(x, y) || [0, 0, 0];
      raw[o] = px[0] & 0xff;
      raw[o + 1] = px[1] & 0xff;
      raw[o + 2] = px[2] & 0xff;
      o += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return png.length;
}
