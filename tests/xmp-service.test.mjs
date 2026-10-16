// 图片声明：XMP（IPTC DigitalSourceType）写入 PNG / JPEG，结构合法、可重复写（替换而非叠加）、像素数据不动。
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { declareImage, readDeclaration, NS_SOURCE, crc32 } = require("../electron/xmp-service.cjs");

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}
function tinyPng() {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
}
function chunks(buf) {
  const out = []; let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString("latin1", off + 4, off + 8);
    const crcOk = buf.readUInt32BE(off + 8 + len) === crc32(buf.subarray(off + 4, off + 8 + len));
    out.push({ type, crcOk }); off += 12 + len;
  }
  return out;
}

test("PNG：iTXt 放在 IDAT 之前、CRC 正确；再次写入是替换", () => {
  const a = declareImage(tinyPng(), "png", "ai");
  assert.equal(a.ok, true);
  assert.deepEqual(chunks(a.buffer).map((c) => c.type), ["IHDR", "iTXt", "IDAT", "IEND"]);
  assert.ok(chunks(a.buffer).every((c) => c.crcOk));
  assert.equal(readDeclaration(a.buffer), NS_SOURCE + "trainedAlgorithmicMedia");
  const b = declareImage(a.buffer, "png", "mix");
  assert.equal(b.replaced, true);
  assert.equal(chunks(b.buffer).filter((c) => c.type === "iTXt").length, 1);
  assert.equal(readDeclaration(b.buffer), NS_SOURCE + "compositeWithTrainedAlgorithmicMedia");
});

test("JPEG：APP1 XMP 插在 APP0 之后，扫描数据原样保留", () => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0xaa, 0xbb, 0xcc, 0xff, 0xd9]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sos]);
  const r = declareImage(jpg, "jpg", "ai");
  assert.equal(r.ok, true);
  assert.deepEqual([...r.buffer.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...r.buffer.subarray(2, 4)], [0xff, 0xe0]);
  assert.deepEqual([...r.buffer.subarray(20, 22)], [0xff, 0xe1]);
  assert.ok(r.buffer.subarray(r.buffer.length - sos.length).equals(sos));
  const again = declareImage(r.buffer, "jpeg", "mix");
  assert.equal(again.replaced, true);
  assert.equal(again.buffer.toString("latin1").split("DigitalSourceType=").length - 1, 1);
});

test("不支持 / 非法输入如实拒绝", () => {
  assert.equal(declareImage(Buffer.from("x"), "webp", "ai").error, "UNSUPPORTED");
  assert.equal(declareImage(Buffer.from("x"), "png", "ai").error, "NOT_PNG");
  assert.equal(declareImage(Buffer.from("x"), "jpg", "ai").error, "NOT_JPEG");
  assert.equal(declareImage(tinyPng(), "png", "other").error, "INVALID_INPUT");
});
