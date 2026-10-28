/**
 * APIMart 参考图上传：NOVAI 档位 + 413 降档 + 人话错误（task-44）。
 *
 * 档位：900KB/2048 → 576KB/1536 → 384KB/1280 → 256KB/1024；每档 JPEG 质量二分 45–95；
 * 只有 413 才降档；最终失败给结构化错误 + 人话（1MB 网关上限 / 不是本机 / 减少参考图）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const apimart = require("../electron/provider-adapter-apimart.cjs");

const API_KEY = "sk-upload-compress";
const ORIGINAL_BYTES = 2 * 1024 * 1024;
const SMALL_BYTES = 100 * 1024;

function dataUrl(bytes) {
  return "data:image/png;base64," + Buffer.alloc(bytes, 0x41).toString("base64");
}

/** 假 nativeImage：toJPEG 大小 = 原图 × 缩放 × 质量/100；记录 create / resize 目标宽。 */
function fakeNativeImage(originalBytes) {
  const counter = { create: 0, resizeWidths: [], qualities: [] };
  const make = (scale) => ({
    isEmpty: () => false,
    getSize: () => ({ width: 2000, height: 1000 }),
    resize: ({ width }) => { counter.resizeWidths.push(width); return make(scale * (width / 2000)); },
    toJPEG: (quality) => { counter.qualities.push(quality); return Buffer.alloc(Math.max(512, Math.round(originalBytes * scale * (quality / 100))), 0x41); },
    toPNG: () => Buffer.alloc(Math.max(512, Math.round(originalBytes * scale)), 0x41),
  });
  return { counter, createFromBuffer() { counter.create += 1; return make(1); } };
}

function startMock({ limitBytes = Infinity, status = null } = {}) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const entry = { path: new URL(req.url, "http://127.0.0.1").pathname, bytes: raw.length, raw };
        requests.push(entry);
        if (status) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "boom" } })); return; }
        if (raw.length > limitBytes) {
          res.writeHead(413, { "content-type": "text/html" });
          res.end("<html><head><title>413 Request Entity Too Large</title></head><body><h1>413 Request Entity Too Large</h1><hr><center>nginx</center></body></html>");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ url: "https://cdn.example/upload-" + requests.length + ".png" }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, baseUrl: "http://127.0.0.1:" + server.address().port, close: () => new Promise((d) => server.close(d)) }));
  });
}

test("① 小于 900KB：直接上传，不触发压缩", async () => {
  const mock = await startMock();
  try {
    const nativeImage = fakeNativeImage(ORIGINAL_BYTES);
    const out = await apimart.upload({ fetchImpl: fetch, apiKey: API_KEY, baseUrl: mock.baseUrl, value: dataUrl(SMALL_BYTES), kind: "image", nativeImage });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(mock.requests.length, 1);
    assert.equal(nativeImage.counter.create, 0, "小图不该走 nativeImage");
    assert.ok(mock.requests[0].bytes < SMALL_BYTES + 4096);
    assert.equal(out.attempts[0].tier, 900000);
    assert.equal(out.attempts[0].maxLongEdge, 2048);
  } finally { await mock.close(); }
});

test("② 超过 900KB：先压到 900KB 档（长边 2048）再传，JPEG 质量二分 45–95", async () => {
  const mock = await startMock();
  try {
    const nativeImage = fakeNativeImage(ORIGINAL_BYTES);
    const out = await apimart.upload({ fetchImpl: fetch, apiKey: API_KEY, baseUrl: mock.baseUrl, value: dataUrl(ORIGINAL_BYTES), kind: "image", nativeImage });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(mock.requests.length, 1);
    assert.equal(nativeImage.counter.create, 1);
    assert.ok(mock.requests[0].bytes < 900000 + 4096, "上传体积必须小于 900000 字节：" + mock.requests[0].bytes);
    assert.ok(nativeImage.counter.qualities.every((q) => q >= 45 && q <= 95), "质量必须落在 45–95：" + JSON.stringify(nativeImage.counter.qualities.slice(0, 8)));
    const raw = mock.requests[0].raw.toString("latin1");
    assert.match(raw, /name="file"/);
    assert.match(raw, /Content-Type: image\/jpeg/);
  } finally { await mock.close(); }
});

test("③ 413 → 576KB 档降档成功（每档带自己的长边上限）", async () => {
  const mock = await startMock({ limitBytes: 576000 });
  try {
    const nativeImage = fakeNativeImage(ORIGINAL_BYTES);
    const out = await apimart.upload({ fetchImpl: fetch, apiKey: API_KEY, baseUrl: mock.baseUrl, value: dataUrl(ORIGINAL_BYTES), kind: "image", nativeImage });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(mock.requests.length, 2, "900KB 档 413 → 576KB 档成功：" + JSON.stringify(mock.requests.map((r) => r.bytes)));
    assert.ok(mock.requests[1].bytes <= 576000 + 4096);
    assert.deepEqual(out.attempts.map((a) => a.tier), [900000, 576000]);
    assert.deepEqual(out.attempts.map((a) => a.maxLongEdge), [2048, 1536]);
    assert.deepEqual(out.attempts.map((a) => a.status), [413, 200]);
  } finally { await mock.close(); }
});

test("④ 始终 413：四档全试，结构化失败 + 人话（不是裸 PROVIDER_PROTOCOL_ERROR / 不吐 HTML）", async () => {
  const mock = await startMock({ limitBytes: 1 });
  try {
    const nativeImage = fakeNativeImage(ORIGINAL_BYTES);
    const out = await apimart.upload({ fetchImpl: fetch, apiKey: API_KEY, baseUrl: mock.baseUrl, value: dataUrl(ORIGINAL_BYTES), kind: "image", nativeImage });
    assert.equal(out.ok, false);
    assert.equal(out.error, "PROVIDER_UPLOAD_TOO_LARGE");
    assert.equal(mock.requests.length, 4);
    assert.deepEqual(out.attempts.map((a) => a.tier), [900000, 576000, 384000, 256000]);
    assert.deepEqual(out.attempts.map((a) => a.maxLongEdge), [2048, 1536, 1280, 1024]);
    assert.match(out.detail, /1MB/);
    assert.match(out.detail, /不是本机/);
    assert.match(out.detail, /减少参考图/);
    assert.equal(out.detail.includes("<html"), false, "不能把网关 HTML 原文抛给用户");
  } finally { await mock.close(); }
});

test("⑤ 允许内联时（改图链路）非 413 失败：返回压缩后的 data URL，且 ≤900KB", async () => {
  const mock = await startMock({ status: 500 });
  try {
    const nativeImage = fakeNativeImage(ORIGINAL_BYTES);
    const out = await apimart.upload({ fetchImpl: fetch, apiKey: API_KEY, baseUrl: mock.baseUrl, value: dataUrl(ORIGINAL_BYTES), kind: "image", nativeImage, allowInline: true });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.inline, true);
    assert.match(out.url, /^data:image\/jpeg;base64,/);
    assert.ok(Buffer.from(out.url.split(",")[1], "base64").length <= 900 * 1024);
  } finally { await mock.close(); }
});

test("⑥ 没有 nativeImage（非 Electron）：原图发一次即结构化失败，不假装压缩", async () => {
  const mock = await startMock({ limitBytes: 1 });
  try {
    const out = await apimart.upload({ fetchImpl: fetch, apiKey: API_KEY, baseUrl: mock.baseUrl, value: dataUrl(ORIGINAL_BYTES), kind: "image" });
    assert.equal(out.ok, false);
    assert.equal(out.error, "PROVIDER_UPLOAD_TOO_LARGE");
    assert.equal(mock.requests.length, 1);
    assert.match(out.detail, /1MB/);
  } finally { await mock.close(); }
});
