/** D3-04C · resource-preview-security.test —— capability / Range / 无路径泄漏 / XSS / 畸形。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createResourceFixture, searchDomain } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");

function png() {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);
}

test("invalid / expired capability -> 403 / 410", async () => {
  assert.equal((await f.previewService.handleProtocolRequest(new Request("openarc-resource://preview/cap_nope"))).status, 403);
  const src = f.writeSource("exp.png", png());
  const imp = await f.resourceService.importManaged({ context: alice, sourcePath: src, name: "exp.png" });
  const minted = await f.previewService.preview({ context: alice, resourceRef: imp.resource.resourceId });
  f.advance(searchDomain.PREVIEW_CAPABILITY_TTL_MS + 1);
  assert.equal((await f.previewService.handleProtocolRequest(new Request(minted.url))).status, 410);
});

test("Range 请求 -> 206 + Content-Range + 正确字节", async () => {
  const bytes = png();
  const src = f.writeSource("range.png", bytes);
  const imp = await f.resourceService.importManaged({ context: alice, sourcePath: src, name: "range.png" });
  const minted = await f.previewService.preview({ context: alice, resourceRef: imp.resource.resourceId });
  const full = await f.previewService.handleProtocolRequest(new Request(minted.url));
  assert.equal(full.status, 200);
  assert.equal((await full.arrayBuffer()).byteLength, bytes.length);
  const partial = await f.previewService.handleProtocolRequest(new Request(minted.url, { headers: { Range: "bytes=0-9" } }));
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("Content-Range"), "bytes 0-9/" + bytes.length);
  assert.equal((await partial.arrayBuffer()).byteLength, 10);
  const bad = await f.previewService.handleProtocolRequest(new Request(minted.url, { headers: { Range: "bytes=99999-" } }));
  assert.equal(bad.status, 416);
});

test("preview 响应不泄漏本地路径 / sourceLocator", async () => {
  const src = f.writeSource("sec.png", png());
  const imp = await f.resourceService.importManaged({ context: alice, sourcePath: src, name: "sec.png" });
  const pv = await f.previewService.preview({ context: alice, resourceRef: imp.resource.resourceId });
  const json = JSON.stringify(pv);
  assert.equal(json.includes(f.storeRoot), false);
  assert.equal(json.includes(src), false);
  assert.equal(json.includes("objects/sha256"), false);
});

test("capability 不得变成永久 token：TTL 有界且到期失效", async () => {
  const src = f.writeSource("ttl.png", png());
  const imp = await f.resourceService.importManaged({ context: alice, sourcePath: src, name: "ttl.png" });
  const pv = await f.previewService.preview({ context: alice, resourceRef: imp.resource.resourceId });
  assert.ok(pv.expiresAt - f.now() <= searchDomain.PREVIEW_CAPABILITY_TTL_MS);
  f.advance(searchDomain.PREVIEW_CAPABILITY_TTL_MS + 1);
  assert.equal((await f.previewService.handleProtocolRequest(new Request(pv.url))).status, 410);
});

test("XSS：snippet 是结构化 spans；preview 文本按纯文本返回", async () => {
  const payload = '<script>alert(1)</script> <img src=x onerror=alert(2)> & <b>bold</b>';
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "xss", content: payload });
  const search = await f.searchService.search({ context: alice, query: "script", limit: 5 });
  assert.ok(search.total >= 1);
  const snippet = search.items[0].snippet;
  assert.ok(Array.isArray(snippet.spans));
  assert.ok(snippet.spans.every((s) => typeof s.text === "string" && typeof s.match === "boolean"));
  const pv = await f.previewService.preview({ context: alice, resourceRef: r.resource.resourceId });
  assert.equal(pv.text, payload);
});

test("UI 源码不得使用 dangerouslySetInnerHTML 渲染 snippet", () => {
  const src = fs.readFileSync(new URL("../src/resource/ResourceLibraryApp.tsx", import.meta.url), "utf8");
  assert.equal(src.includes("dangerouslySetInnerHTML"), false);
});

test("畸形 / 随机字节作为 image：preview 与 protocol 不崩溃", async () => {
  const junk = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37) % 256));
  const src = f.writeSource("junk.png", junk);
  const imp = await f.resourceService.importManaged({ context: alice, sourcePath: src, name: "junk.png", mimeType: "image/png" });
  const pv = await f.previewService.preview({ context: alice, resourceRef: imp.resource.resourceId });
  assert.equal(pv.ok, true);
  const res = await f.previewService.handleProtocolRequest(new Request(pv.url));
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, junk.length);
});
