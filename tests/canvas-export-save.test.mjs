/**
 * 画布导出落盘（task-40）：
 *   A) 主进程 canvas/saveExport 的实现（electron/canvas-export-save.cjs）：参数校验 / 重名 -1/-2 / 大小上限 / 路径安全；
 *   B) 渲染层 saveCanvasBlob 的契约：必须走 canvas/saveExport（不再用 <a download>），把 base64/mime/文件名交出去，
 *      并按主进程返回的真实路径给 toast 用的 ~ 短路径；失败要如实返回原因。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const save = require("../electron/canvas-export-save.cjs");
const { createExportSaver, safeExportName, decodeBase64, uniqueExportPath, defaultDownloadsDir, MAX_EXPORT_BYTES } = save;

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001a5f645400000000049454e44ae426082", "hex");
const b64 = (buf) => buf.toString("base64");
const cleanups = [];
test.after(() => { for (const dir of cleanups) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } } });
function tempDir(prefix = "oa-save-export-") { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); cleanups.push(dir); return dir; }

/* ══════════════════════════════════════════════════════════════════════════
   A. 主进程落盘实现
   ══════════════════════════════════════════════════════════════════════════ */

test("A1 正常落盘：文件真的出现、字节一致、返回真实路径", async () => {
  const dir = tempDir();
  const saver = createExportSaver({ dir });
  const out = await saver({ fileName: "未命名画布.png", mime: "image/png", base64: b64(PNG_BYTES) });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.bytes, PNG_BYTES.length);
  assert.equal(out.renamed, false);
  assert.equal(path.dirname(out.path), dir);
  assert.equal(out.fileName, "未命名画布.png");
  assert.deepEqual(fs.readFileSync(out.path), PNG_BYTES, "落盘内容必须与传入字节完全一致");
  assert.equal(fs.existsSync(out.path + ".part"), false, "临时文件不能留在目录里");
});

test("A2 重名自动 -1 / -2，绝不覆盖已有文件", async () => {
  const dir = tempDir();
  const saver = createExportSaver({ dir });
  const first = await saver({ fileName: "画布.png", mime: "image/png", base64: b64(PNG_BYTES) });
  const second = await saver({ fileName: "画布.png", mime: "image/png", base64: b64(Buffer.concat([PNG_BYTES, Buffer.from([1])])) });
  const third = await saver({ fileName: "画布.png", mime: "image/png", base64: b64(Buffer.concat([PNG_BYTES, Buffer.from([2])])) });
  assert.equal(first.fileName, "画布.png");
  assert.equal(second.fileName, "画布-1.png");
  assert.equal(third.fileName, "画布-2.png");
  assert.equal(second.renamed, true);
  assert.equal(third.renamed, true);
  assert.equal(fs.existsSync(first.path) && fs.existsSync(second.path) && fs.existsSync(third.path), true);
  assert.equal(fs.readFileSync(first.path).length, PNG_BYTES.length, "已有文件不能被后来的覆盖");
});

test("A3 文件名安全：路径分隔符 / 穿越 / 非法扩展名 / 超长", () => {
  assert.equal(safeExportName("../../evil.png").fileName, "evil.png");
  assert.equal(safeExportName("a/b\\c.png").fileName, "c.png");
  assert.equal(safeExportName("  画布.png  ").fileName, "画布.png");
  assert.equal(safeExportName("").error, "INVALID_INPUT");
  assert.equal(safeExportName("..").error, "INVALID_INPUT");
  assert.equal(safeExportName("画布.gif").error, "INVALID_EXTENSION");
  assert.equal(safeExportName("画布").error, "INVALID_EXTENSION", "没有扩展名也要拒");
  const long = safeExportName("长".repeat(300) + ".png");
  assert.equal(long.ok, true);
  assert.ok(long.fileName.length <= 124, "限长后仍然 ≤120 主体 + .png");
  assert.equal(long.fileName.endsWith(".png"), true);
});

test("A4 base64 与 mime 校验、大小上限", async () => {
  const dir = tempDir();
  const saver = createExportSaver({ dir });
  assert.equal((await saver({ fileName: "a.png", base64: "" })).error, "INVALID_INPUT");
  assert.equal((await saver({ fileName: "a.png", base64: "!!!!" })).error, "INVALID_INPUT");
  assert.equal((await saver({ fileName: "a.png", mime: "image/gif", base64: b64(PNG_BYTES) })).error, "INVALID_MIME");
  const dataUrl = await saver({ fileName: "a.png", base64: "data:image/png;base64," + b64(PNG_BYTES) });
  assert.equal(dataUrl.ok, true, "带 data: 前缀也能收");
  const tiny = createExportSaver({ dir, maxBytes: 8 });
  const over = await tiny({ fileName: "b.png", mime: "image/png", base64: b64(PNG_BYTES) });
  assert.equal(over.error, "LIMIT_EXCEEDED", JSON.stringify(over));
  assert.equal(MAX_EXPORT_BYTES, 200 * 1024 * 1024, "默认上限 200MB");
  assert.equal(decodeBase64("AAAA").ok, true);
  assert.equal(decodeBase64("AAA").ok, false, "长度不合法要拒");
});

test("A5 目录不存在会自动建；下载目录可用 OPENARC_DOWNLOADS_DIR 覆盖", async () => {
  const root = tempDir();
  const nested = path.join(root, "a", "b");
  const out = await createExportSaver({ dir: nested })({ fileName: "x.jpg", mime: "image/jpeg", base64: b64(Buffer.from([0xff, 0xd8, 0xff, 0xe0])) });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(fs.existsSync(out.path), true);
  const old = process.env.OPENARC_DOWNLOADS_DIR;
  process.env.OPENARC_DOWNLOADS_DIR = path.join(root, "isolated-downloads");
  try { assert.equal(defaultDownloadsDir(), path.resolve(process.env.OPENARC_DOWNLOADS_DIR)); }
  finally { if (old === undefined) delete process.env.OPENARC_DOWNLOADS_DIR; else process.env.OPENARC_DOWNLOADS_DIR = old; }
});

/* ══════════════════════════════════════════════════════════════════════════
   B. 渲染层契约（bundled exportCanvas.ts，跑真实现）
   ══════════════════════════════════════════════════════════════════════════ */

const bundle = path.join(os.tmpdir(), "oa-save-export-bundle-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [path.join(ROOT, "src/canvas/canvas-next/exportCanvas.ts")],
  bundle: true, format: "esm", platform: "neutral", outfile: bundle, logLevel: "silent",
});
const { saveCanvasBlob, shortenPath } = await import(pathToFileURL(bundle).href);
test.after(() => { try { fs.rmSync(bundle, { force: true }); } catch { /* 忽略 */ } });

test("B1 saveCanvasBlob 走 canvas/saveExport：文件名 / mime / base64 都对，返回真实路径", async () => {
  const sent = [];
  const out = await saveCanvasBlob(new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }), "未命名画布-2x.png", async (payload) => {
    sent.push(payload);
    return { ok: true, path: "/Users/boss/Downloads/未命名画布-2x.png", fileName: "未命名画布-2x.png", bytes: PNG_BYTES.length };
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "canvas/saveExport");
  assert.equal(sent[0].fileName, "未命名画布-2x.png");
  assert.equal(sent[0].mime, "image/png");
  assert.deepEqual(Buffer.from(String(sent[0].base64), "base64"), PNG_BYTES, "base64 必须就是图片字节");
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.path, "/Users/boss/Downloads/未命名画布-2x.png");
  assert.equal(out.display, "~/Downloads/未命名画布-2x.png", "toast 用 ~ 开头的短路径");
  assert.equal(out.bytes, PNG_BYTES.length);
});

test("B2 JPEG 用 image/jpeg；主进程失败时如实返回原因（不抛异常）", async () => {
  const jpegBlob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" });
  let mime = "";
  await saveCanvasBlob(jpegBlob, "a.jpg", async (payload) => { mime = payload.mime; return { ok: true, path: "/Users/boss/Downloads/a.jpg" }; });
  assert.equal(mime, "image/jpeg");
  const failed = await saveCanvasBlob(jpegBlob, "a.jpg", async () => ({ ok: false, error: "SAVE_FAILED", detail: "EACCES: permission denied" }));
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "SAVE_FAILED");
  assert.match(failed.detail, /EACCES/);
  const thrown = await saveCanvasBlob(jpegBlob, "a.jpg", async () => { throw new Error("ipc gone"); });
  assert.equal(thrown.ok, false);
  assert.match(thrown.detail, /ipc gone/);
});

test("B3 没有 openarc 桥（独立页）：不硬报成功，明确 NO_BRIDGE", async () => {
  const out = await saveCanvasBlob(new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }), "x.png");
  assert.equal(out.ok, false);
  assert.equal(out.error, "NO_BRIDGE");
});

test("B4 shortenPath：macOS / Linux 家目录都收成 ~", () => {
  assert.equal(shortenPath("/Users/boss/Downloads/a.png"), "~/Downloads/a.png");
  assert.equal(shortenPath("/home/boss/Downloads/a.png"), "~/Downloads/a.png");
  assert.equal(shortenPath("/tmp/a.png"), "/tmp/a.png");
  assert.equal(shortenPath(null), "");
});
