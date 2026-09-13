/** D3-04C · resource-extractor.test —— Extractor Registry / 本地提取边界。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { ResourceExtractorRegistry, EXTRACTOR } = require("../electron/extractors.cjs");

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");

test("registry 按 resourceType / mimeType 选择 extractor", () => {
  const reg = new ResourceExtractorRegistry();
  assert.equal(reg.resolve({ resource_type: "memory", mime_type: "text/plain" }), EXTRACTOR.TEXT);
  assert.equal(reg.resolve({ resource_type: "code", mime_type: "text/javascript" }), EXTRACTOR.TEXT);
  assert.equal(reg.resolve({ resource_type: "document", mime_type: "text/markdown" }), EXTRACTOR.TEXT);
  assert.equal(reg.resolve({ resource_type: "document", mime_type: "application/pdf" }), EXTRACTOR.PDF_METADATA_ONLY);
  assert.equal(reg.resolve({ resource_type: "image", mime_type: "image/png" }), EXTRACTOR.METADATA_ONLY);
  assert.equal(reg.resolve({ resource_type: "video", mime_type: "video/mp4" }), EXTRACTOR.METADATA_ONLY);
  assert.equal(reg.resolve({ resource_type: "audio", mime_type: "audio/wav" }), EXTRACTOR.METADATA_ONLY);
});

test("text 类型真实提取正文并索引", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Doc", content: "unique-extractor-body-token" });
  const out = await f.searchService.indexResource(r.resource.resourceId);
  assert.equal(out.status, "READY");
  const search = await f.searchService.search({ context: alice, query: "unique-extractor-body-token", limit: 5 });
  assert.equal(search.total, 1);
});

test("PDF 无本地文本层 -> NO_TEXT + UNSUPPORTED_TEXT_EXTRACTION（不 OCR）", async () => {
  const reg = new ResourceExtractorRegistry();
  const out = await reg.extract({ row: { resource_type: "document", mime_type: "application/pdf" }, readContent: async () => ({ ok: true, text: "should-not-be-used" }) });
  assert.equal(out.hasText, false);
  assert.equal(out.unsupportedText, true);
});

test("image/video/audio 只做 metadata 索引（不自动 Vision / 转写）", async () => {
  const reg = new ResourceExtractorRegistry();
  for (const row of [{ resource_type: "image", mime_type: "image/png" }, { resource_type: "video", mime_type: "video/mp4" }, { resource_type: "audio", mime_type: "audio/wav" }]) {
    const out = await reg.extract({ row, readContent: async () => ({ ok: true, text: "nope" }) });
    assert.equal(out.hasText, false);
    assert.equal(out.unsupportedText, false);
  }
});
