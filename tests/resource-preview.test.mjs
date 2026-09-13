/** D3-04C · resource-preview.test —— Preview kinds / bounded text / capability。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

test("text preview：返回正文；大文本截断", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "PrevText", content: "preview body" });
  const pv = await f.previewService.preview({ context: alice, resourceRef: r.resource.resourceId });
  assert.equal(pv.ok, true);
  assert.equal(pv.kind, "text");
  assert.equal(pv.text, "preview body");
  assert.equal(pv.availability, "AVAILABLE");

  const big = "x".repeat(400 * 1024);
  const r2 = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Big", content: big });
  const pv2 = await f.previewService.preview({ context: alice, resourceRef: r2.resource.resourceId });
  assert.equal(pv2.truncated, true);
  assert.ok(pv2.text.length <= 256 * 1024 + 4);
});

test("image preview：签发 capability URL，supportsRange", async () => {
  const p = f.writeSource("prev.png", PNG);
  const imp = await f.resourceService.importManaged({ context: alice, sourcePath: p, name: "prev.png" });
  const pv = await f.previewService.preview({ context: alice, resourceRef: imp.resource.resourceId });
  assert.equal(pv.ok, true);
  assert.equal(pv.kind, "image");
  assert.ok(pv.url.startsWith("openarc-resource://preview/"));
  assert.equal(pv.supportsRange, true);
  assert.ok(pv.expiresAt > f.now());
});

test("video / audio / pdf preview 按 mime 分派（capability）", async () => {
  const cases = [["v.mp4", "video/mp4", "video"], ["a.wav", "audio/wav", "audio"], ["d.pdf", "application/pdf", "pdf"]];
  for (const [name, mime, kind] of cases) {
    const r = await f.resourceService.importManaged({ context: alice, sourcePath: f.writeSource(name, Buffer.from("data")), name, mimeType: mime });
    const pv = await f.previewService.preview({ context: alice, resourceRef: r.resource.resourceId });
    assert.equal(pv.ok, true, name + " preview 应成功");
    assert.equal(pv.kind, kind);
    assert.ok(pv.url.startsWith("openarc-resource://preview/"));
  }
});

test("Trash 默认拒绝 preview，且不提供绕过（不交付已删内容 / 不泄漏路径）", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "TrashPrev", content: "secret-body" });
  f.resourceService.delete({ context: alice, resourceRef: r.resource.resourceId });
  const denied = await f.previewService.preview({ context: alice, resourceRef: r.resource.resourceId });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "RESOURCE_TRASHED");
  assert.equal(denied.text, undefined);
  assert.equal(denied.url, undefined);
  // 显式 includeTrashed 也不得交付已删内容
  const forced = await f.previewService.preview({ context: alice, resourceRef: r.resource.resourceId, includeTrashed: true });
  assert.equal(forced.ok, false);
  assert.equal(forced.text, undefined);
  assert.equal(JSON.stringify(forced).includes(f.storeRoot), false);
});

test("源文件丢失 -> SOURCE_MISSING 预览不可用", async () => {
  const src = f.writeSource("linked-prev.txt", "linked preview");
  const link = f.resourceService.createLinked({ context: alice, sourcePath: src, name: "LinkedPrev" });
  const okPv = await f.previewService.preview({ context: alice, resourceRef: link.resource.resourceId });
  assert.equal(okPv.ok, true);
  fs.rmSync(src);
  const pv = await f.previewService.preview({ context: alice, resourceRef: link.resource.resourceId });
  assert.equal(pv.ok, false);
  assert.equal(pv.error, "SOURCE_MISSING");
});
