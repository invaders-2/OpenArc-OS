/**
 * 图床上传器测试（全离线）：createLitterboxUploader 只认注入的 fetchImpl，绝不发真实网络请求。
 *
 * 覆盖：成功映射（multipart 字段 + 直链 + 有效期）、错误域名 / 非 https 拒绝、
 * 超限 / 非媒体 MIME 拒绝、超时归一化、直链复验失败、未注入 fetchImpl。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLitterboxUploader } = require("../electron/media-litterbox.cjs");

const UPLOAD_URL = "https://litterbox.catbox.moe/resources/internals/api.php";
const MEDIA = Buffer.from("PNGDATA!");
const HOURS_72 = 72 * 60 * 60 * 1000;

function makeResponse({ ok = true, status = 200, contentType = null, text = "" } = {}) {
  return {
    ok,
    status,
    headers: { get: (key) => (String(key).toLowerCase() === "content-type" ? contentType : null) },
    text: async () => text,
    body: null,
  };
}

function fakeFetch({ directUrl = "https://litter.catbox.moe/abc123.png", probeStatus = 206, probeType = "image/png", uploadResponse = null } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (init.method === "POST") return uploadResponse || makeResponse({ text: directUrl });
    return makeResponse({ status: probeStatus, contentType: probeType });
  };
  return { fetchImpl, calls };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test("成功映射：multipart 字段齐全，返回 https 直链与 72h 有效期", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const uploader = createLitterboxUploader({ fetchImpl, timeoutMs: 500, maxBytes: 1024 });
  const before = Date.now();
  const result = await uploader({ fileName: "shot.png", bytes: MEDIA, mime: "image/png" });

  assert.equal(result.url, "https://litter.catbox.moe/abc123.png");
  assert.equal(result.service, "litterbox");
  assert.ok(Number.isFinite(result.expiresAt), "expiresAt 必须是毫秒时间戳");
  assert.ok(result.expiresAt >= before + HOURS_72 && result.expiresAt <= Date.now() + HOURS_72, "expiresAt 必须约等于 72h 后");

  assert.equal(calls.length, 2, "一次上传 + 一次直链复验");
  assert.equal(calls[0].url, UPLOAD_URL);
  assert.equal(calls[0].init.method, "POST");
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData, "上传体必须是 multipart FormData");
  assert.equal(form.get("reqtype"), "fileupload");
  assert.equal(form.get("time"), "72h");
  const file = form.get("fileToUpload");
  assert.equal(file.name, "shot.png");
  assert.equal(file.type, "image/png");
  assert.equal(file.size, MEDIA.length);

  assert.equal(calls[1].url, "https://litter.catbox.moe/abc123.png");
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[1].init.headers.range, "bytes=0-1023");
});

test("直链校验：响应类型组与素材声明一致才通过（200 也接受）", async () => {
  const { fetchImpl } = fakeFetch({ probeStatus: 200, probeType: "video/mp4; codecs=avc1" });
  const uploader = createLitterboxUploader({ fetchImpl, timeoutMs: 500, maxBytes: 1024 });
  const result = await uploader({ fileName: "clip.mp4", bytes: MEDIA, mime: "video/mp4" });
  assert.equal(result.service, "litterbox");
});

test("错误域名拒绝：图床返回外部域名即无效输入，且不再发起直链复验", async () => {
  const { fetchImpl, calls } = fakeFetch({ directUrl: "https://evil.example.com/abc.png" });
  const uploader = createLitterboxUploader({ fetchImpl, timeoutMs: 500, maxBytes: 1024 });
  await rejectsWith(uploader({ fileName: "a.png", bytes: MEDIA, mime: "image/png" }), "MEDIA_INVALID_INPUT");
  assert.equal(calls.length, 1, "域名不合法时不得继续复验");
});

test("非 https 拒绝：降级协议直链即无效输入", async () => {
  const { fetchImpl } = fakeFetch({ directUrl: "http://litter.catbox.moe/abc.png" });
  const uploader = createLitterboxUploader({ fetchImpl, timeoutMs: 500, maxBytes: 1024 });
  await rejectsWith(uploader({ fileName: "a.png", bytes: MEDIA, mime: "image/png" }), "MEDIA_INVALID_INPUT");
});

test("超限拒绝：按 MB 提示上限，detail 留精确字节，不发请求", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const maxBytes = 2 * 1024 * 1024;
  const uploader = createLitterboxUploader({ fetchImpl, timeoutMs: 500, maxBytes });
  await assert.rejects(() => uploader({ fileName: "big.png", bytes: Buffer.alloc(maxBytes + 1, 1), mime: "image/png" }), (error) => {
    assert.equal(error.code, "MEDIA_INVALID_INPUT");
    assert.match(error.message, /图片超过 2 MB，免费图床不支持这么大的文件/);
    assert.equal(error.detail.bytes, maxBytes + 1);
    assert.equal(error.detail.maxBytes, maxBytes);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("非媒体 MIME 拒绝：zip / 空 MIME 都不上传", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const uploader = createLitterboxUploader({ fetchImpl, timeoutMs: 500, maxBytes: 1024 });
  await rejectsWith(uploader({ fileName: "a.zip", bytes: MEDIA, mime: "application/zip" }), "MEDIA_INVALID_INPUT");
  await rejectsWith(uploader({ fileName: "a.bin", bytes: MEDIA }), "MEDIA_INVALID_INPUT");
  assert.equal(calls.length, 0);
});

test("超时归一化：注入 fetch 忽略 signal 时仍按 MEDIA_TIMEOUT 返回", async () => {
  const uploader = createLitterboxUploader({ fetchImpl: () => new Promise(() => {}), timeoutMs: 20, maxBytes: 1024 });
  await rejectsWith(uploader({ fileName: "a.png", bytes: MEDIA, mime: "image/png" }), "MEDIA_TIMEOUT");
});

test("超时归一化：注入 fetch 抛 AbortError 时同样映射成 MEDIA_TIMEOUT", async () => {
  const fetchImpl = (input, init = {}) => new Promise((_, reject) => {
    if (init.signal) init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const uploader = createLitterboxUploader({ fetchImpl, timeoutMs: 20, maxBytes: 1024 });
  await rejectsWith(uploader({ fileName: "a.png", bytes: MEDIA, mime: "image/png" }), "MEDIA_TIMEOUT");
});

test("octet-stream 放行：catbox 回通用类型时仍成功，并在 detail 留事实", async () => {
  const { fetchImpl, calls } = fakeFetch({ probeType: "application/octet-stream" });
  const uploader = createLitterboxUploader({ fetchImpl, timeoutMs: 500, maxBytes: 1024 });
  const result = await uploader({ fileName: "a.png", bytes: MEDIA, mime: "image/png" });
  assert.equal(result.service, "litterbox");
  assert.deepEqual(result.detail, { contentType: "application/octet-stream" });
  assert.equal(calls.length, 2);
});

test("text/html 直链仍拒绝：非媒体类型不放行", async () => {
  const { fetchImpl } = fakeFetch({ probeType: "text/html" });
  const uploader = createLitterboxUploader({ fetchImpl, timeoutMs: 500, maxBytes: 1024 });
  await rejectsWith(uploader({ fileName: "a.png", bytes: MEDIA, mime: "image/png" }), "MEDIA_DEPENDENCY_UNAVAILABLE");
});

test("直链复验失败：非 200/206 或类型组不符 → 依赖不可用", async () => {
  const missing = fakeFetch({ probeStatus: 404 });
  await rejectsWith(createLitterboxUploader({ fetchImpl: missing.fetchImpl, timeoutMs: 500, maxBytes: 1024 })({ fileName: "a.png", bytes: MEDIA, mime: "image/png" }), "MEDIA_DEPENDENCY_UNAVAILABLE");

  const wrongType = fakeFetch({ probeType: "text/html" });
  await rejectsWith(createLitterboxUploader({ fetchImpl: wrongType.fetchImpl, timeoutMs: 500, maxBytes: 1024 })({ fileName: "a.png", bytes: MEDIA, mime: "image/png" }), "MEDIA_DEPENDENCY_UNAVAILABLE");
});

test("未注入 fetchImpl：结构化依赖不可用（默认不联网）", async () => {
  const uploader = createLitterboxUploader({ timeoutMs: 500, maxBytes: 1024 });
  await rejectsWith(uploader({ fileName: "a.png", bytes: MEDIA, mime: "image/png" }), "MEDIA_DEPENDENCY_UNAVAILABLE");
});
