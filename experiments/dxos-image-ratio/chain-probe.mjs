#!/usr/bin/env node
/**
 * dxos-image-ratio · 协议级链路探针。
 *
 * 起一个本地 OpenAI 兼容 stub（只监听 127.0.0.1），用**真实 HTTP** 调
 * provider-adapter.generateImage，再解 provider-adapter.mapImages 的结果：
 *   · 抓请求体里真正的 size 字符串（比例/分辨率映射的落点）
 *   · stub 按请求尺寸返回真实编码的 PNG 字节，测量返回图真实像素
 *   · stub 返回真实 JPEG 头但声明 mime_type=image/webp → 验证声明优先 / 魔数嗅探
 *   · stub 无视 size 返回固定尺寸 → 验证 mismatch 判定能识别"被上游改写"
 *
 * 与 live-probe.mjs 的区别：live-probe 打真网关（真实模型），本探针只验证我们这一侧
 * 的协议链事实，不冒充上游真实出图。
 */
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { measureImage } from "./measure.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-image-ratio");
const adapter = require(path.join(ROOT, "electron", "provider-adapter.cjs"));
const imageParams = require(path.join(ROOT, "electron", "image-params.cjs"));

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/** 真实可解码的纯色 PNG。 */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = 200; raw[o + 1] = 60; raw[o + 2] = 60;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const REAL_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9])]);

function parseSize(text) {
  const m = /^(\d{2,5})\s*x\s*(\d{2,5})$/i.exec(String(text || "").trim());
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

async function startStub({ log = () => {} } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body = null; try { body = JSON.parse(raw.toString("utf8")); } catch {}
    seen.push({ url: req.url, method: req.method, body });
    const size = parseSize(body && body.size);
    let item;
    const mode = (body && body.__mode) || "echo";
    if (mode === "rewrite") item = { b64_json: makePng(1024, 1024).toString("base64") };
    else if (mode === "jpeg-sniff") item = { b64_json: REAL_JPEG.toString("base64") };
    else if (mode === "jpeg-declared-webp") item = { b64_json: REAL_JPEG.toString("base64"), mime_type: "image/webp" };
    else item = { b64_json: makePng(size ? size.width : 1024, size ? size.height : 1024).toString("base64") };
    const payload = JSON.stringify({ created: 1, data: [item] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { baseUrl: "http://127.0.0.1:" + port + "/v1", seen, close: () => new Promise((r) => server.close(() => r(true))) };
}

async function callAdapter(baseUrl, { size, mode }) {
  const out = await adapter.generateImage({
    baseUrl, apiKey: "stub-key", model: "stub-model", prompt: "p", size, count: 1,
    params: mode ? { __mode: mode } : {},
  });
  if (!out.res.ok) return { ok: false, status: out.res.status };
  const body = await out.res.json();
  const items = adapter.mapImages(body);
  const first = items[0];
  const bytes = first && first.b64 ? Buffer.from(first.b64, "base64") : null;
  return { ok: true, items, mime: first ? first.mime : null, image: bytes ? measureImage(bytes) : null };
}

const rows = [];
const ratioCases = [
  { ratio: "1:1", resolution: "1k" },
  { ratio: "16:9", resolution: "1k" },
  { ratio: "9:16", resolution: "1k" },
  { ratio: "wide", resolution: "2k" },
  { ratio: "custom", resolution: "1k", customRatio: "16:9" },
];

/**
 * 从画布页真源里取出它自己的 apiImageSize（白盒执行，不重写实现）。
 * 只抓自包含的常量与函数；抓不到就抛，不回退成"影子实现"。
 */
function loadUiApiImageSize() {
  const pageJs = fs.readFileSync(path.join(ROOT, "public", "novai-canvas", "static", "js", "canvas.js"), "utf8");
  const grabConst = (name) => {
    const multi = new RegExp("const " + name + " = \\{[\\s\\S]*?\\n\\};").exec(pageJs);
    const single = new RegExp("const " + name + " = \\{[^}]*\\};").exec(pageJs);
    const m = single || multi;
    if (!m) throw new Error("画布页缺少常量 " + name);
    return m[0];
  };
  const grabFn = (name) => {
    const m = new RegExp("function " + name + "\\([\\s\\S]*?\\n\\}").exec(pageJs);
    if (!m) throw new Error("画布页缺少函数 " + name);
    return m[0];
  };
  const src = [
    grabConst("RES_LONG_SIDE"), grabConst("RES_PIXEL_LIMIT"), grabConst("SIZE_MAP"), grabConst("GPT_IMAGE_2_SIZE_MAP"),
    grabFn("parseRatioValue"), grabFn("isGptImageAutoSizeModel"), grabFn("apiImageSize"),
    "return apiImageSize;",
  ].join("\n");
  return new Function(src)();
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  const stub = await startStub();
  try {
    for (const c of ratioCases) {
      const size = imageParams.resolveImageSize(c);
      const got = await callAdapter(stub.baseUrl, { size });
      const sent = stub.seen[stub.seen.length - 1].body.size;
      const expected = parseSize(size);
      rows.push({
        kind: "ratio-map", input: c, mappedSize: size, sentSize: sent,
        actual: got.image, mime: got.mime,
        match: !!(got.image && expected && got.image.width === expected.width && got.image.height === expected.height),
      });
    }
    // 显式 size 优先：节点比例 1:1 4k，但显式 size=1536x1024
    {
      const size = imageParams.resolveImageSize({ size: "1536x1024", ratio: "1:1", resolution: "4k" });
      const got = await callAdapter(stub.baseUrl, { size });
      const sent = stub.seen[stub.seen.length - 1].body.size;
      rows.push({ kind: "explicit-priority", mappedSize: size, sentSize: sent, actual: got.image, mime: got.mime, match: !!(got.image && got.image.width === 1536 && got.image.height === 1024) });
    }
    // 上游无视 size：请求 1536x1024 实际 1024x1024 → mismatch 能被识别
    {
      const got = await callAdapter(stub.baseUrl, { size: "1536x1024", mode: "rewrite" });
      const sent = stub.seen[stub.seen.length - 1].body.size;
      rows.push({ kind: "upstream-rewrite", sentSize: sent, actual: got.image, mime: got.mime, match: !!(got.image && got.image.width === 1536 && got.image.height === 1024), expectedMatch: false });
    }
    // mime：JPEG 字节无声明 → 嗅探 image/jpeg（修复前会是 image/png）
    {
      const got = await callAdapter(stub.baseUrl, { size: "1024x1024", mode: "jpeg-sniff" });
      rows.push({ kind: "mime-sniff-jpeg", sentSize: stub.seen[stub.seen.length - 1].body.size, actual: got.image, mime: got.mime, expectMime: "image/jpeg", mimeOk: got.mime === "image/jpeg" });
    }
    // mime：JPEG 字节但声明 webp → 声明优先
    {
      const got = await callAdapter(stub.baseUrl, { size: "1024x1024", mode: "jpeg-declared-webp" });
      rows.push({ kind: "mime-declared-wins", sentSize: stub.seen[stub.seen.length - 1].body.size, actual: got.image, mime: got.mime, expectMime: "image/webp", mimeOk: got.mime === "image/webp" });
    }
    // 画布页自己的 apiImageSize（用户在界面选的东西最终就是它算成 size）与本模块逐项对照
    {
      const ui = loadUiApiImageSize();
      for (const key of ["square", "portrait", "landscape", "portrait43", "landscape43", "story", "wide", "ultrawide", "ultratall"]) {
        const uiSize = ui(key, "1k");
        const ourSize = imageParams.resolveImageSize({ ratio: key, resolution: "1k" });
        rows.push({ kind: "ui-function", ratio: key, uiSize, ourSize, equal: uiSize === ourSize });
      }
      const uiCustom = ui("custom", "1k", "16:9");
      const ourCustom = imageParams.resolveImageSize({ ratio: "custom", resolution: "1k", customRatio: "16:9" });
      rows.push({ kind: "ui-function", ratio: "custom(16:9)", uiSize: uiCustom, ourSize: ourCustom, equal: uiCustom === ourCustom });
      // 已知分歧（画布页旧算法只在近 1:1 时压高不压宽）：1:1 自定义比例会算成非方形
      const uiNearSquare = ui("custom", "1k", "1:1");
      const ourNearSquare = imageParams.resolveImageSize({ ratio: "custom", resolution: "1k", customRatio: "1:1" });
      rows.push({ kind: "ui-known-divergence", ratio: "custom(1:1)", uiSize: uiNearSquare, ourSize: ourNearSquare, equal: uiNearSquare === ourNearSquare });
    }
  } finally {
    await stub.close();
  }
  const out = { at: new Date().toISOString(), stubRequests: stub.seen.length, rows };
  fs.writeFileSync(path.join(ART, "chain-probe.json"), JSON.stringify(out, null, 2));
  const allOk = rows.every((r) => {
    if (r.kind === "upstream-rewrite") return r.match === false; // 这条本来就该 mismatch
    if (r.kind === "ui-known-divergence") return r.equal === false; // 已知的画布页旧算法分歧
    if (r.kind === "ui-function") return r.equal === true;
    if (r.mimeOk !== undefined) return r.mimeOk;
    return r.match === true;
  });
  console.log(JSON.stringify(out, null, 2));
  console.log(allOk ? "CHAIN_PROBE_OK" : "CHAIN_PROBE_FAILED");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => { console.error("CHAIN_PROBE_ERROR " + (err && err.stack)); process.exit(2); });
