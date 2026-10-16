/**
 * B5c · .dxcanvas 打包 / 解包 / 校验（全离线，不联网、不依赖新增库）。
 * 被测：electron/canvas-dxos-zip.cjs + electron/canvas-dxos-package.cjs（产品真实代码）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const zip = require("../electron/canvas-dxos-zip.cjs");
const pkg = require("../electron/canvas-dxos-package.cjs");

const RES_A = "res_aaaa1111";
const RES_B = "res_bbbb2222";
const assetA = Buffer.from("hello-canvas-asset-A");
const assetB = Buffer.from("x".repeat(4096));

function baseDoc() {
  return {
    nodes: [
      { id: "n1", type: "image", x: 0, y: 0, url: "openarc-asset:" + RES_A, runStatus: "running", runError: "boom" },
      { id: "n2", type: "prompt", x: 10, y: 10, text: "提示词", refs: ["openarc-asset:" + RES_B] },
    ],
    connections: [{ id: "c1", from: "n1", to: "n2" }],
    viewport: { x: 0, y: 0, scale: 1 },
    logs: [{ at: 1, text: "旧日志" }],
  };
}
const assets = new Map([
  [RES_A, { data: assetA, name: "A 素材.png", mime: "image/png" }],
  [RES_B, { data: assetB, name: "b.bin", mime: "application/octet-stream" }],
]);
const resolve = (id) => assets.get(id) || null;

test("打包往返：清单/素材/校验和齐备，路径可控", () => {
  const buffer = pkg.buildCanvasPackage(baseDoc(), resolve, { canvasId: "cv_1", title: "画布 A", icon: "🧩", kind: "classic", revision: 7, exportedAt: 1234 });
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
  const parsed = pkg.parseCanvasPackage(buffer);
  assert.equal(parsed.manifest.format, pkg.CANVAS_PACKAGE_FORMAT);
  assert.equal(parsed.manifest.version, pkg.CANVAS_PACKAGE_VERSION);
  assert.equal(parsed.manifest.exportedAt, 1234);
  assert.equal(parsed.manifest.canvas.title, "画布 A");
  assert.equal(parsed.manifest.canvas.revision, 7);
  assert.equal(parsed.assets.length, 2, "两个素材都要打进包");
  const bySource = new Map(parsed.assets.map((a) => [a.sourceId, a]));
  assert.deepEqual(bySource.get(RES_A).data, assetA);
  assert.deepEqual(bySource.get(RES_B).data, assetB);
  assert.equal(bySource.get(RES_A).mime, "image/png");
  assert.equal(bySource.get(RES_A).bytes, assetA.length);
  assert.equal(bySource.get(RES_A).checksum, pkg.sha256(assetA));
  for (const asset of parsed.assets) assert.match(asset.path, /^assets\/[0-9]{5}-/);
});

test("导入重映射：素材引用换成新 ResourceRef，导出方的运行态被清掉", () => {
  const buffer = pkg.buildCanvasPackage(baseDoc(), resolve, { canvasId: "cv_1", title: "画布 A" });
  const parsed = pkg.parseCanvasPackage(buffer);
  const mediaIds = new Map([[RES_A, "res_new1111"], [RES_B, "res_new2222"]]);
  const doc = pkg.remapCanvasPackageDocument(parsed.manifest.document, mediaIds, "cv_target");
  assert.equal(doc.nodes[0].url, "openarc-asset:res_new1111");
  assert.deepEqual(doc.nodes[1].refs, ["openarc-asset:res_new2222"]);
  assert.equal(doc.nodes[0].runStatus, "", "导出方的运行态不能带进来");
  assert.equal(doc.nodes[0].runError, "");
  assert.deepEqual(doc.logs, [], "导入画布不继承导出方日志");
  assert.deepEqual(doc.connections, parsed.manifest.document.connections);
});

test("文档引用了不存在的素材 → 导出直接失败，不静默丢素材", () => {
  const doc = baseDoc();
  doc.nodes.push({ id: "n3", type: "image", x: 0, y: 0, url: "openarc-asset:res_missing9" });
  assert.throws(() => pkg.buildCanvasPackage(doc, resolve, {}), /素材不存在|不可导出/);
});

test("危险路径一律拒绝（绝对路径 / 盘符 / 上级目录 / 反斜杠 / 控制字符）", () => {
  for (const bad of ["/etc/passwd", "C:/Windows/x", "assets/../../x", "x\u0000y", ""]) {
    assert.throws(() => pkg.safePackageEntryName(bad), /画布包/);
  }
  assert.equal(pkg.safePackageEntryName("assets/00001-a.png"), "assets/00001-a.png");
  // 源 canvasPackage.ts:81 的口径：反斜杠是"归一化"，不是拒绝
  assert.equal(pkg.safePackageEntryName("assets\\00001-a.png"), "assets/00001-a.png");
});

test("损坏拒绝：CRC/长度/截断/重复条目", () => {
  const buffer = pkg.buildCanvasPackage(baseDoc(), resolve, {});
  // ① 改动素材字节 → CRC 或长度校验失败
  const at = buffer.indexOf(assetA);
  assert.notEqual(at, -1, "小素材在包内是 store 方式，字节应可直接定位");
  const flipped = Buffer.from(buffer);
  flipped[at] ^= 0xff;
  assert.throws(() => pkg.parseCanvasPackage(flipped), /画布包无法读取/);
  // ② 截断 → 找不到中央目录结尾记录
  assert.throws(() => pkg.parseCanvasPackage(buffer.subarray(0, buffer.length - 12)), /画布包无法读取/);
  // ③ 重复条目名（把第二条中央目录名改成与第一条同长同名）
  const dup = zip.writeZip([{ name: "assets/aaa.bin", data: Buffer.from("a") }, { name: "assets/bbb.bin", data: Buffer.from("b") }]);
  const nameAt = dup.lastIndexOf(Buffer.from("assets/bbb.bin"));
  assert.notEqual(nameAt, -1);
  Buffer.from("assets/aaa.bin").copy(dup, nameAt);
  assert.throws(() => zip.readZip(dup), /重复文件/);
  // ④ 写侧重复条目名也拒绝
  assert.throws(() => zip.writeZip([{ name: "a", data: Buffer.from("1") }, { name: "a", data: Buffer.from("2") }]), /重复条目名/);
});

test("清单校验：格式 / 版本 / 缺失素材 / 大小 / 校验和 / 重复 sourceId", () => {
  const make = (manifest, extra = []) => zip.writeZip([
    { name: pkg.MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest)) },
    ...extra,
  ]);
  const good = {
    format: pkg.CANVAS_PACKAGE_FORMAT, version: 1, exportedAt: 1,
    canvas: { id: "cv", title: "t", icon: "i", kind: "classic", revision: 1 },
    document: baseDoc(),
    assets: [{ sourceId: RES_A, path: "assets/00001-a.png", name: "a.png", mime: "image/png", bytes: assetA.length, checksum: pkg.sha256(assetA) }],
  };
  const assetEntry = { name: "assets/00001-a.png", data: assetA };
  assert.equal(pkg.parseCanvasPackage(make(good, [assetEntry])).assets.length, 1);
  assert.throws(() => pkg.parseCanvasPackage(make({ ...good, format: "other/v1" }, [assetEntry])), /不支持的画布包格式/);
  assert.throws(() => pkg.parseCanvasPackage(make({ ...good, version: 2 }, [assetEntry])), /不支持的画布包版本/);
  assert.throws(() => pkg.parseCanvasPackage(make({ ...good, assets: [{ ...good.assets[0], path: "assets/99999-x.png" }] }, [assetEntry])), /素材缺失/);
  assert.throws(() => pkg.parseCanvasPackage(make({ ...good, assets: [{ ...good.assets[0], bytes: 999 }] }, [assetEntry])), /大小校验失败/);
  assert.throws(() => pkg.parseCanvasPackage(make({ ...good, assets: [{ ...good.assets[0], checksum: "deadbeef" }] }, [assetEntry])), /校验和不一致/);
  assert.throws(() => pkg.parseCanvasPackage(make({ ...good, assets: [good.assets[0], { ...good.assets[0] }] }, [assetEntry])), /索引无效或重复/);
  assert.throws(() => pkg.parseCanvasPackage(make({ ...good, assets: "nope" }, [assetEntry])), /不支持的画布包格式/);
  // 清单自身不是 JSON
  assert.throws(() => pkg.parseCanvasPackage(zip.writeZip([{ name: pkg.MANIFEST_NAME, data: Buffer.from("{oops") }])), /清单无法解析/);
  // 清单素材路径不在 assets/ 下
  assert.throws(() => pkg.parseCanvasPackage(make({ ...good, assets: [{ ...good.assets[0], path: "../00001-a.png" }] }, [assetEntry])), /画布包/);
  // zip 内的危险路径条目
  assert.throws(() => pkg.parseCanvasPackage(zip.writeZip([{ name: "../evil.txt", data: Buffer.from("x") }])), /不安全的文件路径/);
  // 空包
  assert.throws(() => pkg.parseCanvasPackage(Buffer.alloc(0)), /画布包为空/);
  assert.throws(() => pkg.parseCanvasPackage(Buffer.from("not a zip at all........")), /画布包无法读取/);
});

test("ZIP 基础：store/deflate 两种方式都能往返，UTF-8 名称保留", () => {
  const entries = [
    { name: "small.txt", data: Buffer.from("s") },
    { name: "大文件.bin", data: Buffer.from("中文".repeat(500)) },
  ];
  const back = zip.readZip(zip.writeZip(entries));
  assert.equal(back.length, 2);
  assert.deepEqual(back.map((e) => e.name), ["small.txt", "大文件.bin"]);
  assert.deepEqual(back[1].data, entries[1].data);
  assert.equal(zip.crc32(Buffer.from("abc")), 0x352441c2);
});
