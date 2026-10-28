import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createImportRemote, createAssetPublicUrl } = require("../electron/canvas-asset-public-url.cjs");
const { isBlockedArtifactAddress } = require("../electron/protocol-engine/artifactDownload.cjs");
const { createUploadConsentService } = require("../electron/upload-consent-service.cjs");
const { IdentityStore } = require("../electron/identity-store.cjs");

const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  if (req.url === "/ok.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.from("png-data")); return; }
  if (req.url === "/redirect-private") { res.writeHead(302, { location: "http://127.0.0.1/ok.png" }); res.end(); return; }
  if (req.url.startsWith("/hop")) {
    const n = Number(req.url.slice(4)) || 0;
    res.writeHead(302, { location: "/hop" + (n + 1) }); res.end(); return;
  }
  if (req.url === "/large" || req.url === "/forged") {
    res.writeHead(200, { "content-type": "image/png", ...(req.url === "/forged" ? { "content-length": "1" } : {}) });
    for (let i = 0; i < 16; i += 1) res.write(Buffer.alloc(1024, i));
    res.end(); return;
  }
  if (req.url === "/mime") { res.writeHead(200, { "content-type": "text/plain" }); res.end("not-media"); return; }
  if (req.url === "/slow") { res.writeHead(200, { "content-type": "image/png" }); res.write("x"); return; }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const connect = () => net.connect({ host: "127.0.0.1", port });
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup = async () => [{ address: "127.0.0.1", family: 4 }];
const base = `http://public.example:${port}`;
const imports = [];
const service = { importAsset(input) { imports.push(input); return { ok: true, ref: "openarc-asset:test" }; } };
const makeImport = (options = {}) => createImportRemote(service, { maxBytes: 4096, timeoutMs: 1000, lookup: publicLookup, connect, ...options });
after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
afterEach(() => { requests.length = 0; imports.length = 0; });
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

test("公开正常下载经 pinned DNS 与真实 HTTP 流进入资源库", async () => {
  const result = await makeImport()({ context: {}, canvasId: "c1", url: base + "/ok.png" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.bytes, 8);
  assert.equal(result.mime, "image/png");
  assert.equal(imports.length, 1);
  assert.deepEqual(requests, ["/ok.png"]);
});

test("公开 URL → 内网重定向在第二跳前拒绝，不读取内网正文", async () => {
  const result = await makeImport()({ context: {}, url: base + "/redirect-private" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "INVALID_INPUT");
  assert.deepEqual(requests, ["/redirect-private"]);
  assert.equal(imports.length, 0);
});

test("DNS 解析到私网与 IPv6/映射/保留地址全部拒绝", async () => {
  const result = await makeImport({ lookup: privateLookup })({ context: {}, url: base + "/ok.png" });
  assert.equal(result.error, "INVALID_INPUT");
  assert.equal(requests.length, 0);
  for (const address of ["::1", "::", "fe80::1", "fc00::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "100.64.0.1", "169.254.169.254", "224.0.0.1"]) {
    assert.equal(isBlockedArtifactAddress(address), true, address);
  }
  assert.equal(isBlockedArtifactAddress("93.184.216.34"), false);
});

test("重定向超过上限、无长度大响应和伪造长度中途超限", async () => {
  assert.equal((await makeImport()({ context: {}, url: base + "/hop0" })).error, "DOWNLOAD_FAILED");
  const noLength = await makeImport()({ context: {}, url: base + "/large" });
  assert.equal(noLength.error, "LIMIT_EXCEEDED");
  const forged = await makeImport()({ context: {}, url: base + "/forged" });
  assert.equal(forged.ok, false, "伪造 Content-Length 可由 HTTP 解析器直接拒绝，但不得导入");
  assert.equal(forged.error, "DOWNLOAD_FAILED");
  assert.equal(imports.length, 0);
});

test("超时与主动取消都停止下载，不导入半成品", async () => {
  const timeout = await makeImport({ timeoutMs: 20 })({ context: {}, url: base + "/slow" });
  assert.equal(timeout.error, "TIMEOUT");
  const controller = new AbortController();
  const pending = makeImport({ timeoutMs: 10000 })({ context: {}, url: base + "/slow", signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const cancelled = await pending;
  assert.equal(cancelled.error, "CANCELLED");
  assert.equal(imports.length, 0);
});

test("非媒体 Content-Type 拒绝，不用扩展名掩盖", async () => {
  const result = await makeImport()({ context: {}, url: base + "/mime" });
  assert.equal(result.error, "INVALID_INPUT");
  assert.equal(imports.length, 0);
});

function consentFixture() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-upload-consent-"));
  dirs.push(userDataDir);
  const dbPath = path.join(userDataDir, "identity.db");
  let identity = new IdentityStore({ path: dbPath }).open();
  const authorization = { resolveActor({ context }) { return context.sessionRef ? { ok: true, user: { id: context.sessionRef } } : { ok: false }; } };
  const create = () => createUploadConsentService({ identityStore: identity, authorization });
  return { create, authorization, restart() { identity.close(); identity = new IdentityStore({ path: dbPath }).open(); }, get identity() { return identity; } };
}

test("未授权上传 0 请求；授权、失败审计、撤权与重启持久化", async () => {
  const fx = consentFixture();
  const context = { sessionRef: "user-a" };
  let calls = 0;
  const url = "https://litter.catbox.moe/public-file-url-should-not-be-audited";
  const uploader = async () => { calls += 1; return { url, expiresAt: Date.now() + 1000 }; };
  const consent = fx.create();
  await assert.rejects(() => consent.authorizedUpload(context, {}, uploader), (error) => error.code === "UPLOAD_CONSENT_REQUIRED");
  assert.equal(calls, 0);
  const granted = await consent.execute("uploadConsent/set", { allowed: true }, context);
  assert.equal(granted.ok, true);
  assert.equal(granted.value.allowed, true);
  await consent.authorizedUpload(context, {}, uploader);
  assert.equal(calls, 1);
  const failedUploader = async () => { calls += 1; throw new Error("upload failed without secrets"); };
  await assert.rejects(() => consent.authorizedUpload(context, {}, failedUploader));
  assert.equal(consent.state(context).last.status, 4);
  fx.restart();
  const reopened = fx.create();
  assert.equal(reopened.state(context).allowed, true);
  await reopened.execute("uploadConsent/set", { allowed: false }, context);
  await assert.rejects(() => reopened.authorizedUpload(context, {}, uploader), (error) => error.code === "UPLOAD_CONSENT_REQUIRED");
  assert.equal(calls, 2);
  fx.restart();
  assert.equal(fx.create().state(context).allowed, false);
  const audit = JSON.stringify(fx.identity.connection.prepare("SELECT * FROM app_network_audit").all());
  assert.equal(audit.includes(url), false);
  assert.equal(audit.includes("素材正文"), false);
  assert.equal(audit.includes("api_key"), false);
});

test("Canvas 缓存命中前重新查授权；data URL 超限在解码前拒绝", async () => {
  const fx = consentFixture();
  const context = { sessionRef: "user-a" };
  const consent = fx.create();
  let calls = 0;
  const uploader = async () => { calls += 1; return { url: "https://litter.catbox.moe/not-in-audit", expiresAt: Date.now() + 86400000 }; };
  const asset = createAssetPublicUrl({}, { authorize: consent.assertAllowed, uploader: (ctx, input) => consent.authorizedUpload(ctx, input, uploader), maxBytes: 8 });
  const dataUrl = "data:image/png;base64," + Buffer.from("png").toString("base64");
  assert.equal((await asset({ context, dataUrl })).error, "UPLOAD_CONSENT_REQUIRED");
  await consent.execute("uploadConsent/set", { allowed: true }, context);
  assert.equal((await asset({ context, dataUrl })).ok, true);
  assert.equal((await asset({ context, dataUrl })).cached, true);
  assert.equal(calls, 1);
  await consent.execute("uploadConsent/set", { allowed: false }, context);
  assert.equal((await asset({ context, dataUrl })).error, "UPLOAD_CONSENT_REQUIRED");
  assert.equal(calls, 1);
  await consent.execute("uploadConsent/set", { allowed: true }, context);
  const oversized = "data:image/png;base64," + Buffer.alloc(16, 1).toString("base64");
  assert.equal((await asset({ context, dataUrl: oversized })).error, "LIMIT_EXCEEDED");
  assert.equal(calls, 1);
});
