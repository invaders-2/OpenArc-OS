/** D3-04C 探针 03 · Preview：text / image / video / audio / pdf 元数据 / capability / Range / Trash。 */
import fs from "node:fs";
import { Probe, createResourceFixture, searchDomain } from "./lib.mjs";

const p = new Probe("03-preview", "Preview Service / 安全交付 / capability / Range / 无路径泄漏");
const f = await createResourceFixture();
const alice = f.ctx("alice");
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 9)]);
try {
  const text = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "PreviewText", content: "preview 正文 plain text" });
  const textPv = await f.previewService.preview({ context: alice, resourceRef: text.resource.resourceId });
  p.assert("text preview 返回纯文本", textPv.ok && textPv.kind === "text" && textPv.text === "preview 正文 plain text", "kind=" + textPv.kind);
  p.assert("text preview 不泄漏本地路径", !JSON.stringify(textPv).includes(f.storeRoot), "");

  const imgPath = f.writeSource("pic.png", png());
  const img = await f.resourceService.importManaged({ context: alice, sourcePath: imgPath, name: "pic.png", mimeType: "image/png" });
  const imgPv = await f.previewService.preview({ context: alice, resourceRef: img.resource.resourceId });
  p.assert("image preview 签发 openarc-resource capability URL", imgPv.ok && imgPv.kind === "image" && imgPv.url.startsWith("openarc-resource://preview/"), "");
  p.assert("capability URL 不含本地路径 / checksum", !JSON.stringify(imgPv).includes(f.storeRoot) && !JSON.stringify(imgPv).includes("objects/sha256"), "");
  const full = await f.previewService.handleProtocolRequest(new Request(imgPv.url));
  p.assert("protocol handler 授权后 200 + 完整字节", full.status === 200 && (await full.arrayBuffer()).byteLength === png().length, "status=" + full.status);
  const partial = await f.previewService.handleProtocolRequest(new Request(imgPv.url, { headers: { Range: "bytes=0-99" } }));
  p.assert("Range -> 206 + Content-Range", partial.status === 206 && partial.headers.get("Content-Range") === "bytes 0-99/" + png().length, "status=" + partial.status);
  const bad = await f.previewService.handleProtocolRequest(new Request(imgPv.url, { headers: { Range: "bytes=999999-" } }));
  p.assert("越界 Range -> 416", bad.status === 416, "status=" + bad.status);
  p.assert("随机 capability -> 403", (await f.previewService.handleProtocolRequest(new Request("openarc-resource://preview/cap_bogus"))).status === 403, "");

  const th = await f.previewService.thumbnail({ context: alice, resourceRef: img.resource.resourceId });
  p.assert("Node 环境 thumbnail 明确 UNSUPPORTED（不伪造，真实缩略图由 Electron 探针覆盖）", th.ok === false && th.error === "PREVIEW_UNSUPPORTED", th.error || "unexpected");

  // PDF：metadata-only 索引（无 OCR）
  const pdfPath = f.writeSource("doc.pdf", Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF"));
  const pdf = await f.resourceService.importManaged({ context: alice, sourcePath: pdfPath, name: "doc.pdf", mimeType: "application/pdf" });
  const pdfIdx = await f.searchService.indexResource(pdf.resource.resourceId);
  p.assert("PDF 仅元数据索引，正文抽取标 UNSUPPORTED_TEXT_EXTRACTION", pdfIdx.ok && pdfIdx.errorCode === "UNSUPPORTED_TEXT_EXTRACTION", "errorCode=" + pdfIdx.errorCode);
  const pdfByName = await f.searchService.search({ context: alice, query: "doc.pdf", limit: 10 });
  p.assert("PDF 仍可按文件名检索（元数据索引用途）", pdfByName.total >= 1, "total=" + pdfByName.total);
  const pdfPv = await f.previewService.preview({ context: alice, resourceRef: pdf.resource.resourceId });
  p.assert("PDF preview 走 capability 流（交 Chromium viewer）", pdfPv.ok && pdfPv.kind === "pdf" && pdfPv.url.startsWith("openarc-resource://"), "");

  // video / audio capability + Range
  for (const [name, mime, kind] of [["clip.webm", "video/webm", "video"], ["sound.webm", "audio/webm", "audio"]]) {
    const src = f.writeSource(name, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 3)]));
    const m = await f.resourceService.importManaged({ context: alice, sourcePath: src, name, mimeType: mime });
    const pv = await f.previewService.preview({ context: alice, resourceRef: m.resource.resourceId });
    p.assert(kind + " preview capability + supportsRange", pv.ok && pv.kind === kind && pv.supportsRange === true, "kind=" + pv.kind);
    const r206 = await f.previewService.handleProtocolRequest(new Request(pv.url, { headers: { Range: "bytes=100-299" } }));
    p.assert(kind + " Range 206", r206.status === 206, "status=" + r206.status);
  }

  // capability 到期
  const before = f.now();
  f.advance(searchDomain.PREVIEW_CAPABILITY_TTL_MS + 1);
  p.assert("capability 到期 -> 410", (await f.previewService.handleProtocolRequest(new Request(imgPv.url))).status === 410, "ttl=" + searchDomain.PREVIEW_CAPABILITY_TTL_MS);

  // Trash 默认拒绝（且不留绕过）
  f.resourceService.delete({ context: alice, resourceRef: text.resource.resourceId });
  const trashed = await f.previewService.preview({ context: alice, resourceRef: text.resource.resourceId });
  p.assert("Trash 默认拒绝 preview，无 includeTrashed 绕过", trashed.ok === false && trashed.error === "RESOURCE_TRASHED" && trashed.text === undefined, trashed.error || "");
  p.assert("探针期间无本地路径外泄", !JSON.stringify([textPv, imgPv, pdfPv]).includes(f.storeRoot), "now=" + (f.now() - before));
} finally {
  f.close();
}
p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
