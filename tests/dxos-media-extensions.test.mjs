/**
 * B5e · 媒体域剩余部分测试（全离线，无网络、无 Electron）。
 *
 * 覆盖：
 *   ① 命令表一致性（50 条；命令表 ↔ dispatch 一一对应，无 COMMAND_NOT_ALLOWED 漏网）
 *   ② 抠图：依赖缺失结构化不可用；注入假 runtime/sharp/session 的真实推理路径；sharp 缺失
 *   ③ AI 声明：JPEG / PNG / WebP 写入→解析往返；processDeclarationUpload 单图与 ZIP；sharp 缺失
 *   ④ 短剧：编排 Timeline → 注入假渲染提交（对接 B5a worker 面）
 *   ⑤ 音乐库：扫描根注入、元数据覆盖、artwork 目标与写入、条目索引不含绝对路径
 *   ⑥ Illustrator：默认结构化不可用；注入可用后配置/临时导出真实往返
 *   ⑦ Figma：注入 fetch 的清单解析；未注入 viteBuild 不可用；白名单过滤
 *   ⑧ 3D 模型目录：非法条目剔除、本地扫描与投影
 *   ⑨ publicMedia：本地映射、路径穿越拒绝、上传已移除断言；sharp 缺失
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const mediaDomain = require("../electron/media-domain.cjs");
const mediaStore = require("../electron/media-store.cjs");
const { createMediaBundle, configureMediaExtensions } = require("../electron/media-service.cjs");
const backgroundRemoval = require("../electron/media-background-removal.cjs");
const aiDeclaration = require("../electron/media-ai-image-declaration.cjs");
const shortDrama = require("../electron/media-short-drama.cjs");
const library = require("../electron/media-library.cjs");
const illustrator = require("../electron/media-illustrator.cjs");
const figma = require("../electron/media-figma-preview.cjs");
const director3d = require("../electron/media-director3d.cjs");
const publicMedia = require("../electron/media-public-media.cjs");
const { createDxosFsAdapter } = require("../electron/dxos-fs-adapter.cjs");

const tmpDirs = [];
after(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const STUB_AUTH = { resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: "u-b5e" } } : { ok: false, error: "no-session" }) };

function openBundle(dir, options = {}) {
  mediaStore.resetMediaStoreForTests();
  return createMediaBundle(Object.assign({ userDataDir: dir, authorization: STUB_AUTH, clock: () => Date.now() }, options));
}

async function exec(bundle, command, payload = {}) {
  return bundle.execute(command, payload, { sessionRef: "sess-b5e" });
}

// ── ① 命令表一致性 ────────────────────────────────────────────────────────
test("命令表：共 50 条，risk/summary/needsCredential 合法", () => {
  const commands = mediaDomain.listMediaCommands();
  // 10-16：+3 media/short-drama/get / image（只读视图与画面预览）、visual-image（角色 / 场景参考图）
  assert.equal(commands.length, 53);
  for (const entry of commands) {
    assert.ok(Object.prototype.hasOwnProperty.call(mediaDomain.RISK_LEVELS, entry.risk), "非法 risk：" + entry.command);
    assert.equal(entry.needsCredential, false);
    assert.ok(typeof entry.summary === "string" && entry.summary.length >= 8, "summary 过短：" + entry.command);
  }
  // B5e 新增命令抽样
  for (const name of [
    "media/background-removal/status", "media/background-removal/remove",
    "media/ai-declaration/apply", "media/ai-declaration/read", "media/ai-declaration/process",
    "media/short-drama/render", "media/library/scan", "media/library/artwork/targets",
    "media/illustrator/config/get", "media/figma-preview/build",
    "media/director3d/models/list", "media/public-media/url",
  ]) assert.ok(mediaDomain.isMediaCommand(name), "缺少命令：" + name);
  assert.equal(mediaDomain.mediaCommandRisk("media/background-removal/remove"), "use");
});

test("命令表 ↔ dispatch：每条新命令都被分发（绝不落 COMMAND_NOT_ALLOWED）", async () => {
  const dir = tempDir("dxos-media-ext-dispatch-");
  const bundle = openBundle(dir);
  const newCommands = mediaDomain.listMediaCommands().map((entry) => entry.command)
    .filter((command) => command.startsWith("media/background-removal/") || command.startsWith("media/ai-declaration/")
      || command.startsWith("media/short-drama/") || command.startsWith("media/library/")
      || command.startsWith("media/illustrator/") || command.startsWith("media/figma-preview/")
      || command.startsWith("media/director3d/") || command.startsWith("media/public-media/"));
  assert.equal(newCommands.length, 37); // 10-16 +3 media/short-drama/get、image、visual-image
  for (const command of newCommands) {
    const result = await exec(bundle, command, {});
    assert.notEqual(result.error, "MEDIA_COMMAND_NOT_ALLOWED", "未登记 dispatch：" + command);
  }
});

// ── ② 本地抠图 ───────────────────────────────────────────────────────────
test("抠图：onnxruntime 缺失 → 结构化不可用（绝不返回假图）", async () => {
  const dir = tempDir("dxos-media-ext-bg-");
  backgroundRemoval.configureBackgroundRemoval({ modelDir: dir, sharpLoader: null, onnxRuntime: null, onnxSessionFactory: null });
  const probe = await backgroundRemoval.probeBackgroundRemovalDependencies();
  assert.equal(probe.ok, false);
  assert.equal(probe.error, "MEDIA_DEPENDENCY_UNAVAILABLE");
  assert.match(probe.detail, /onnxruntime-node/);

  await assert.rejects(
    () => backgroundRemoval.removeImageBackground(Buffer.from([0xff, 0xd8]), "ben2-base"),
    (error) => { assert.equal(error.code, "MEDIA_DEPENDENCY_UNAVAILABLE"); assert.match(error.detail, /onnxruntime-node/); return true; },
  );
  // 未知模型：输入错误（而不是依赖错误）
  await assert.rejects(() => backgroundRemoval.removeImageBackground(Buffer.alloc(0), "nope"), (error) => error.code === "MEDIA_INVALID_INPUT");

  const bundle = openBundle(dir);
  const viaIpc = await exec(bundle, "media/background-removal/status", {});
  assert.equal(viaIpc.ok, false);
  assert.equal(viaIpc.error, "MEDIA_DEPENDENCY_UNAVAILABLE");
  assert.ok(typeof viaIpc.detail === "string" && viaIpc.detail.length > 10);
});

test("抠图：sharp 缺失 → 结构化不可用", async () => {
  backgroundRemoval.configureBackgroundRemoval({
    modelDir: null,
    sharpLoader: () => { throw new Error("sharp not installed"); },
    onnxRuntime: { Tensor: function Tensor() {} },
    onnxSessionFactory: async () => ({ inputNames: ["i"], outputNames: ["o"], run: async () => ({}) }),
    model: { id: "ben2-base", name: "BEN2 Base", version: "1.0.0", filename: "x.onnx", size: 0, inputWidth: 2, inputHeight: 2, normalize: "zero-one", sigmoid: false },
    modelPath: "/injected/model.onnx",
  });
  const probe = await backgroundRemoval.probeBackgroundRemovalDependencies();
  assert.equal(probe.ok, false);
  assert.match(probe.detail, /sharp/);
  await assert.rejects(() => backgroundRemoval.removeImageBackground(Buffer.alloc(4), "ben2-base"), (error) => {
    assert.equal(error.code, "MEDIA_DEPENDENCY_UNAVAILABLE");
    assert.match(error.detail, /sharp/);
    return true;
  });
});

test("抠图：注入假 sharp/runtime/session 走真实推理路径并产出 PNG", async () => {
  function fakeSharp() {
    const builder = {
      rotate: () => builder,
      removeAlpha: () => builder,
      resize: () => builder,
      raw: () => builder,
      png: () => builder,
      toBuffer: async (out) => {
        if (out && out.resolveWithObject) {
          if (ctor && ctor.raw && ctor.raw.channels === 1) return { data: new Uint8Array(4), info: { width: 2, height: 2, channels: 1 } };
          return { data: Buffer.alloc(2 * 2 * 3), info: { width: 2, height: 2 } };
        }
        if (ctor && ctor.raw && ctor.raw.channels === 4) return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        return Buffer.alloc(2 * 2 * 3);
      },
    };
    let ctor;
    const fn = (input, options) => { ctor = options; return builder; };
    fn.kernel = { lanczos3: "lanczos3" };
    return fn;
  }
  const model = { id: "ben2-base", name: "BEN2 Base", version: "1.0.0", filename: "x.onnx", size: 0, inputWidth: 2, inputHeight: 2, normalize: "zero-one", sigmoid: false };
  let tensorSeen = null;
  const runtime = { Tensor: function Tensor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; tensorSeen = this; } };
  const session = { inputNames: ["input"], outputNames: ["output"], run: async (feed) => ({ output: { data: new Float32Array([0, 0, 1, 1]) }, feed }) };
  backgroundRemoval.configureBackgroundRemoval({
    sharpLoader: () => fakeSharp(),
    onnxRuntime: runtime,
    onnxSessionFactory: async () => session,
    model,
    modelPath: "/injected/model.onnx",
  });
  const out = await backgroundRemoval.removeImageBackground(Buffer.alloc(8), "ben2-base");
  assert.ok(Buffer.isBuffer(out));
  assert.equal(out.subarray(0, 4).toString("hex"), "89504e47");
  assert.ok(tensorSeen);
  assert.deepEqual(tensorSeen.dims, [1, 3, 2, 2]);
  // 纯函数：归一化与遮罩
  const input = backgroundRemoval.buildInput(new Uint8Array([255, 0, 128]), { inputWidth: 1, inputHeight: 1, normalize: "zero-one" });
  assert.equal(Math.round(input[0] * 1000) / 1000, 1);
  const mask = backgroundRemoval.buildMask({ data: new Float32Array([0, 1]) }, { inputWidth: 2, inputHeight: 1, sigmoid: false });
  assert.deepEqual([...mask], [0, 255]);
});

// ── ③ AI 图像声明 ────────────────────────────────────────────────────────
test("AI 声明：JPEG / PNG / WebP 写入→解析往返", async () => {
  const sharp = require("sharp");
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 0, b: 0 } } }).jpeg().toBuffer();
  const declaredJpeg = aiDeclaration.addWindowsKeyword(aiDeclaration.addJpegDeclaration(jpeg));
  const readJpeg = aiDeclaration.readDeclaration("a.jpg", declaredJpeg);
  assert.equal(readJpeg.format, "jpeg");
  assert.equal(readJpeg.declared, true);
  assert.equal(readJpeg.xmpPresent, true);
  assert.equal(readJpeg.windowsKeyword, true);
  assert.equal(readJpeg.label, aiDeclaration.DECLARATION_LABEL);

  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 255, b: 0 } } }).png().toBuffer();
  const readPng = aiDeclaration.readDeclaration("a.png", aiDeclaration.addPngDeclaration(png));
  assert.equal(readPng.format, "png");
  assert.equal(readPng.declared, true);
  assert.equal(readPng.xmpPresent, true);

  const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 255 } } }).webp().toBuffer();
  const readWebp = aiDeclaration.readDeclaration("a.webp", aiDeclaration.addWebpDeclaration(webp));
  assert.equal(readWebp.format, "webp");
  assert.equal(readWebp.declared, true);

  // addDeclaration 走真实 sharp（PNG→JPEG）
  const declared = await aiDeclaration.addDeclaration("a.png", png);
  assert.equal(aiDeclaration.imageKind("a.png", declared), "jpeg");
  assert.equal(aiDeclaration.readDeclaration("a.jpg", declared).declared, true);

  // 未声明图片：declared=false
  assert.equal(aiDeclaration.readDeclaration("a.jpg", jpeg).declared, false);
});

test("AI 声明：processDeclarationUpload 单图直出与 ZIP 打包", async () => {
  const sharp = require("sharp");
  const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
  const single = await aiDeclaration.processDeclarationUpload([{ name: "one.jpg", data: jpeg }]);
  assert.equal(single.mime, "image/jpeg");
  assert.equal(single.imageCount, 1);
  assert.equal(single.filename, "one.jpg");
  assert.equal(aiDeclaration.readDeclaration("one.jpg", single.data).declared, true);

  const zip = aiDeclaration.buildZip([{ name: "one.jpg", data: jpeg }, { name: "one.jpg", data: jpeg }]);
  const many = await aiDeclaration.processDeclarationUpload([
    { name: "one.jpg", data: jpeg },
    { name: "two.jpg", data: jpeg },
  ]);
  assert.equal(many.mime, "application/zip");
  assert.equal(many.imageCount, 2);
  assert.equal(many.filename, "AI图片声明_已处理.zip");
  const entries = aiDeclaration.readZip(many.data);
  assert.equal(entries.length, 2);
  assert.ok(aiDeclaration.readZip(zip).length === 2);

  await assert.rejects(() => aiDeclaration.processDeclarationUpload([]), (error) => error.code === "MEDIA_INVALID_INPUT");
  await assert.rejects(() => aiDeclaration.processDeclarationUpload([{ name: "x.txt", data: Buffer.from("hi") }]), (error) => error.code === "MEDIA_INVALID_INPUT");
  assert.throws(() => aiDeclaration.safeZipName("../evil"), (error) => error.code === "MEDIA_INVALID_INPUT");
});

test("AI 声明：sharp 缺失时 PNG/WebP 转换结构化不可用；纯 JPEG 不受影响", async () => {
  const sharp = require("sharp");
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  const broken = { sharpLoader: () => { throw new Error("sharp missing"); } };
  await assert.rejects(() => aiDeclaration.addDeclaration("a.png", png, broken), (error) => {
    assert.equal(error.code, "MEDIA_DEPENDENCY_UNAVAILABLE");
    assert.match(error.detail, /sharp/);
    return true;
  });
  // 纯 JPEG 不经过 sharp
  const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
  const declared = await aiDeclaration.addDeclaration("a.jpg", jpeg, broken);
  assert.ok(Buffer.isBuffer(declared));
});

test("AI 声明：IPC 往返（base64url 出口，绝不被路径脱敏破坏）", async () => {
  const dir = tempDir("dxos-media-ext-decl-");
  const bundle = openBundle(dir);
  const sharp = require("sharp");
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 5, g: 6, b: 7 } } }).png().toBuffer();
  const applied = await exec(bundle, "media/ai-declaration/apply", { name: "photo.png", base64: png.toString("base64") });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.value.fileName, "photo.jpg");
  assert.equal(applied.value.mime, "image/jpeg");
  const bytes = Buffer.from(applied.value.data, "base64url");
  assert.equal(aiDeclaration.readDeclaration("photo.jpg", bytes).declared, true);

  const read = await exec(bundle, "media/ai-declaration/read", { name: "photo.jpg", base64: bytes.toString("base64") });
  assert.equal(read.ok, true);
  assert.equal(read.value.declaration.declared, true);
});

// ── ④ 短剧编排 → 渲染 ────────────────────────────────────────────────────
test("短剧：分镜编排为 Timeline 并交给注入的假渲染提交", async () => {
  const dir = tempDir("dxos-media-ext-drama-");
  const fsAdapter = createDxosFsAdapter({ dataDir: path.join(dir, "fs") });
  const submitted = [];
  const renderSubmit = async (input) => { submitted.push(input); return { id: "fake-job-1", status: "queued" }; };
  shortDrama.configureShortDrama({ dataDir: dir, fsAdapter, renderSubmit, clock: () => 1700000000000 });

  const project = shortDrama.createDramaProject("测试短剧", "u1");
  assert.ok(project.folderId);
  assert.ok(project.folders.assets);
  project.shots = [
    { id: "shot-1", title: "开场", scene: "街道", duration: 2, imageStatus: "ready", videoStatus: "idle", images: [{ id: "img-1", nodeId: "node-1", url: "/api/fs/raw/node-1", kind: "generated" }], selectedImageId: "img-1" },
    { id: "shot-2", title: "对峙", scene: "室内", duration: 3, imageStatus: "ready", videoStatus: "idle", images: [{ id: "img-2", nodeId: "node-2", url: "/api/fs/raw/node-2", kind: "generated" }], selectedImageId: "img-2" },
  ];
  shortDrama.save([project]);

  const plan = shortDrama.buildDramaTimeline(project);
  assert.equal(plan.shotCount, 2);
  assert.equal(plan.durationMs, 5000);
  assert.equal(plan.timeline.schemaVersion, "1.0");
  assert.equal(plan.timeline.timebase, 1000);
  assert.equal(plan.timeline.tracks[0].clips.length, 2);
  assert.equal(plan.timeline.tracks[0].clips[1].timelineStartMs, 2000);
  assert.deepEqual(plan.timeline.tracks[0].clips.map((clip) => clip.assetId), ["node-1", "node-2"]);

  const result = await shortDrama.submitDramaRender(project.id);
  assert.equal(submitted.length, 1);
  assert.equal(result.job.id, "fake-job-1");
  assert.equal(result.plan.shotCount, 2);
  assert.equal(submitted[0].timeline.tracks[0].clips[0].assetId, "node-1");

  // 没有就绪分镜图 → INVALID_INPUT（不假提交）
  project.shots = [{ id: "s", title: "x", duration: 1, images: [] }];
  shortDrama.save([project]);
  await assert.rejects(() => shortDrama.submitDramaRender(project.id), (error) => error.code === "MEDIA_INVALID_INPUT");

  // 未注入渲染提交面 → 结构化不可用
  shortDrama.configureShortDrama({ renderSubmit: null });
  project.shots = [{ id: "s", title: "x", duration: 1, images: [{ id: "i", nodeId: "n" }], selectedImageId: "i" }];
  shortDrama.save([project]);
  await assert.rejects(() => shortDrama.submitDramaRender(project.id), (error) => {
    assert.equal(error.code, "MEDIA_DEPENDENCY_UNAVAILABLE");
    return true;
  });
});

// ── ⑤ 音乐库 ─────────────────────────────────────────────────────────────
test("音乐库：扫描根注入、标签兜底、元数据覆盖、artwork 目标与写入", async () => {
  const dir = tempDir("dxos-media-ext-lib-");
  const root = path.join(dir, "music");
  fs.mkdirSync(path.join(root, "专辑"), { recursive: true });
  fs.writeFileSync(path.join(root, "song-b.mp3"), Buffer.alloc(64));
  fs.writeFileSync(path.join(root, "专辑", "song-a.flac"), Buffer.alloc(128));
  fs.writeFileSync(path.join(root, "note.txt"), "not audio");

  library.configureMediaLibrary({ dataDir: dir, musicMetadataLoader: null, clock: () => 1700000000000 });
  library.resetLibraryForTests();

  const tracks = await library.scan({ dirs: [root] });
  assert.equal(tracks.length, 2, "只识别 AUDIO_EXT 内的文件");
  for (const track of tracks) {
    assert.match(track.id, /^[a-f0-9]{16}$/);
    assert.ok(track.size > 0);
  }
  const json = JSON.stringify(tracks);
  assert.equal(json.includes(root), false, "条目不得包含绝对路径");
  const nested = tracks.find((track) => track.folder === "专辑");
  assert.ok(nested, "相对子目录 folder 应保留");

  // 元数据覆盖层（手工/AI）
  const target = tracks[0];
  assert.equal(library.setMeta([{ id: target.id, artist: "歌手A", album: "专辑A", title: "曲名A" }]), 1);
  const rescanned = await library.scan({ dirs: [root] });
  const covered = rescanned.find((track) => track.id === target.id);
  assert.equal(covered.artist, "歌手A");
  assert.equal(covered.album, "专辑A");
  assert.equal(covered.title, "曲名A");

  const targets = await library.artworkTargets();
  assert.deepEqual(targets.artists, ["歌手A"]);
  assert.deepEqual(targets.albums, [{ artist: "歌手A", album: "专辑A", key: "歌手A\n专辑A" }]);

  // artwork 写入
  const artwork = Buffer.concat([Buffer.alloc(256, 1), Buffer.from([0xff])]);
  const id = library.putArtwork("artist", "歌手A", artwork);
  assert.match(id, /^[a-f0-9]{16}$/);
  assert.ok(fs.existsSync(library.artworkPath(id)));
  const afterTargets = await library.artworkTargets();
  assert.equal(afterTargets.artists.includes("歌手A"), false, "写入后不再作为缺失目标");
  // 重新扫描一次让缓存条目带上新图（源 scrapeArtwork 结尾同样 scan()）
  const finalTracks = await library.scan({ dirs: [root] });
  const withArt = finalTracks.find((track) => track.artist === "歌手A");
  assert.equal(withArt.artistImage, "/api/library/artwork/" + id);

  // setDirs 真实校验
  const setResult = library.setDirs([root, path.join(dir, "missing")]);
  assert.deepEqual(setResult.errors, ["目录不存在：" + path.join(dir, "missing")]);
  assert.deepEqual(setResult.dirs, [root]);
  assert.equal(library.getConfig().trackCount, finalTracks.length);
});

// ── ⑥ Illustrator ────────────────────────────────────────────────────────
test("Illustrator：默认结构化不可用；注入可用后配置与临时导出真实往返", async () => {
  const dir = tempDir("dxos-media-ext-ai-");
  illustrator.configureIllustrator({ dataDir: dir, tmpDir: path.join(dir, "tmp"), illustratorAvailable: false });
  const unavailable = illustrator.illustratorUnavailable();
  assert.equal(unavailable.code, "MEDIA_DEPENDENCY_UNAVAILABLE");
  assert.match(unavailable.detail, /Illustrator/);

  const bundle = openBundle(dir, { mediaExtensions: { illustratorAvailable: false } });
  for (const command of ["media/illustrator/config/get", "media/illustrator/config/update", "media/illustrator/temp-export/prepare", "media/illustrator/temp-export/cleanup"]) {
    const result = await exec(bundle, command, {});
    assert.equal(result.ok, false, command);
    assert.equal(result.error, "MEDIA_DEPENDENCY_UNAVAILABLE", command);
    assert.ok(typeof result.detail === "string" && result.detail.length > 0);
  }

  // 注入可用：纯逻辑真实往返
  illustrator.configureIllustrator({ dataDir: dir, tmpDir: path.join(dir, "tmp"), illustratorAvailable: true });
  const updated = illustrator.updateIllustratorConfig({
    barcodeTemplatePath: "  /templates/barcode.ai  ",
    previewResolution: 4096,
    templateFunctions: [{ id: "fn-1", name: "模板", sourcePath: "/src/t.ai", mappings: [{ id: "m1", label: "名称", enabled: true }, { id: "m2", label: "禁用", enabled: false }] }],
  });
  assert.equal(updated.barcodeTemplatePath, "/templates/barcode.ai");
  assert.equal(updated.previewResolution, 4096);
  assert.equal(updated.templateFunctions.length, 1);
  assert.equal(updated.templateFunctions[0].mappings.length, 1, "禁用映射被过滤（源 :96）");
  const reread = illustrator.readIllustratorConfig();
  assert.deepEqual(reread.templateFunctions, updated.templateFunctions);

  const prepared = illustrator.prepareIllustratorTempExport("u1", "输出/文件.pdf");
  assert.match(prepared.name, /\.pdf$/);
  assert.equal(illustrator.illustratorTempExport("u2", prepared.id), null, "他人不可见");
  fs.writeFileSync(prepared.path, "pdf");
  assert.equal(illustrator.illustratorTempExport("u1", prepared.id).name, prepared.name);
  const cleaned = illustrator.cleanupIllustratorTempExports("u1");
  assert.equal(cleaned.removed, 1);
  assert.equal(illustrator.illustratorTempExport("u1", prepared.id), null);
});

// ── ⑦ Figma 预览 ─────────────────────────────────────────────────────────
test("Figma：注入 fetch 的清单解析 + 白名单过滤", async () => {
  const dir = tempDir("dxos-media-ext-figma-");
  figma.configureFigmaPreview({ dataDir: dir, fetchImpl: null, viteBuild: null });
  await assert.rejects(() => figma.fetchFigmaPreviewFiles("https://example.com/p.json"), (error) => {
    assert.equal(error.code, "MEDIA_DEPENDENCY_UNAVAILABLE");
    return true;
  });

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ projectId: "proj-12345678", files: [
      { path: "src/main.ts", content: "export const a = 1" },
      { path: "index.html", content: "<div/>" },
      { path: "../evil.ts", content: "x" },
      { path: "src/../../etc/passwd", content: "x" },
      { path: "notes.md", content: "x" },
    ] }) };
  };
  const fetched = await figma.fetchFigmaPreviewFiles("https://example.com/preview.json", { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(fetched.projectId, "proj-12345678");
  assert.deepEqual(fetched.files.map((file) => file.path), ["src/main.ts", "index.html"]);
  assert.deepEqual(figma.selectPreviewFiles([{ path: "package.json", content: "{}" }, { path: "a/b.ts", content: "x" }]).map((f) => f.path), ["package.json"]);

  // 未注入 viteBuild → 结构化不可用
  await assert.rejects(() => figma.buildFigmaPreview("proj-12345678", fetched.files), (error) => error.code === "MEDIA_DEPENDENCY_UNAVAILABLE");
  assert.throws(() => figma.safeProjectId("short"), (error) => error.code === "MEDIA_INVALID_INPUT");

  // 注入假 viteBuild：真实落盘 source/ 并返回 URL
  let buildArgs = null;
  const result = await figma.buildFigmaPreview("proj-12345678", fetched.files, { viteBuild: async (args) => { buildArgs = args; }, vuePlugin: () => ({ name: "fake-vue" }) });
  assert.equal(result.projectId, "proj-12345678");
  assert.equal(result.url, "/api/figma/preview/proj-12345678/dist/index.html");
  assert.ok(buildArgs.root.endsWith(path.join("proj-12345678", "source")));
  assert.equal(fs.readFileSync(path.join(buildArgs.root, "src", "main.ts"), "utf8"), "export const a = 1");
  assert.equal(fs.existsSync(path.join(buildArgs.root, "..", "evil.ts")), false);
});

// ── ⑧ 3D 模型目录 ────────────────────────────────────────────────────────
test("3D 模型：非法条目剔除、本地扫描与条目投影", () => {
  const dir = tempDir("dxos-media-ext-3d-");
  const sha = "a".repeat(64);
  const body = { models: [
    { id: "Hero-01", version: "1.2.0", sha256: sha, downloadUrl: "https://cdn.example.com/h.fbx", size: 100, kind: "male", name: "男主", description: "d" },
    { id: "bad id!", version: "1.0.0", sha256: sha, downloadUrl: "https://cdn.example.com/x.fbx", size: 10 },
    { id: "no-sha", version: "1.0.0", sha256: "zz", downloadUrl: "https://cdn.example.com/x.fbx", size: 10 },
    { id: "no-url", version: "1.0.0", sha256: sha, downloadUrl: "http://cdn.example.com/x.fbx", size: 10 },
    { id: "no-size", version: "1.0.0", sha256: sha, downloadUrl: "https://cdn.example.com/x.fbx", size: 0 },
    { id: "bad-ver", version: "v1", sha256: sha, downloadUrl: "https://cdn.example.com/x.fbx", size: 10 },
  ] };
  const parsed = director3d.parseDirector3DCatalog(body);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "hero-01");
  assert.equal(parsed[0].kind, "male");
  assert.equal(parsed[0].format, "fbx");

  director3d.configureDirector3D({ dataDir: dir, models: parsed });
  let status = director3d.director3DModelStatus();
  assert.equal(status.length, 1);
  assert.equal(status[0].downloaded, false);
  assert.equal(status[0].fileUrl, "");
  assert.equal(status[0].totalBytes, 100);

  // 本地安装（文件大小 + 元数据 sha/version 一致）
  const modelDir = path.join(dir, "models", "director3d");
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, "hero-01-1.2.0.fbx"), Buffer.alloc(100));
  fs.writeFileSync(path.join(modelDir, "hero-01-1.2.0.json"), JSON.stringify({ id: "hero-01", version: "1.2.0", sha256: sha, size: 100 }));
  status = director3d.director3DModelStatus();
  assert.equal(status[0].downloaded, true);
  assert.equal(status[0].updateAvailable, false);
  assert.equal(status[0].fileUrl, "/api/director3d/models/hero-01/file?v=1.2.0");
  assert.deepEqual(director3d.installedVersions("hero-01"), ["1.2.0"]);
  const file = director3d.director3DModelFile("hero-01");
  assert.ok(file.path.endsWith("hero-01-1.2.0.fbx"));
  assert.throws(() => director3d.director3DModelFile("missing"), (error) => error.code === "MEDIA_NOT_FOUND");

  // 未匹配元数据（sha 不符）→ 视为未安装
  fs.writeFileSync(path.join(modelDir, "hero-01-1.2.0.json"), JSON.stringify({ id: "hero-01", version: "1.2.0", sha256: "b".repeat(64), size: 100 }));
  assert.equal(director3d.director3DModelStatus()[0].downloaded, false);
});

// ── ⑨ publicMedia 本地部分 ───────────────────────────────────────────────
test("publicMedia：本地目录/URL 映射、路径穿越拒绝、上传已移除", async () => {
  const dir = tempDir("dxos-media-ext-pub-");
  publicMedia.configurePublicMedia({ dataDir: dir, sharpLoader: null });
  const mediaDir = path.join(dir, "public-media");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "pic.jpg"), Buffer.alloc(64, 3));

  const items = publicMedia.listPublicMedia();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "pic.jpg");
  assert.equal(items[0].url, "/api/public-media/pic.jpg");
  assert.equal(publicMedia.publicMediaUrl("pic.jpg"), "/api/public-media/pic.jpg");
  assert.ok(publicMedia.resolvePublicMediaPath("pic.jpg").endsWith("pic.jpg"));
  assert.throws(() => publicMedia.publicMediaUrl("../secret"), (error) => error.code === "MEDIA_INVALID_INPUT" || error.code === "MEDIA_NOT_FOUND");
  assert.throws(() => publicMedia.resolvePublicMediaPath("missing.jpg"), (error) => error.code === "MEDIA_NOT_FOUND");

  // 上传面已整段移除
  assert.equal(publicMedia.PUBLIC_MEDIA_UPLOAD_REMOVED, true);
  assert.equal(typeof publicMedia.uploadCanvasFreeMedia, "undefined");
  assert.equal(typeof publicMedia.verifyDirectMediaUrl, "undefined");
  assert.equal("LITTERBOX_UPLOAD_URL" in publicMedia, false);

  // 本地 JPEG 转换（sharp 存在）
  const sharp = require("sharp");
  const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0 } } }).png().toBuffer();
  const normalized = await publicMedia.normalizePublicImageForApimartVideo({ buf: png, mime: "image/png", name: "ref.png" });
  assert.equal(normalized.mime, "image/jpeg");
  assert.equal(normalized.name, "ref.jpg");
  assert.equal(aiDeclaration.imageKind(normalized.name, normalized.buf), "jpeg");
  const passthrough = await publicMedia.normalizePublicImageForApimartVideo({ buf: Buffer.from("v"), mime: "video/mp4", name: "v.mp4" });
  assert.equal(passthrough.mime, "video/mp4");

  // sharp 缺失 → 结构化不可用
  await assert.rejects(() => publicMedia.normalizePublicImageForApimartVideo({ buf: png, mime: "image/png", name: "r.png" }, { sharpLoader: () => { throw new Error("no sharp"); } }), (error) => {
    assert.equal(error.code, "MEDIA_DEPENDENCY_UNAVAILABLE");
    return true;
  });
});

test("依赖注入总线：configureMediaExtensions 可单独调用（未注入即结构化不可用）", () => {
  const result = configureMediaExtensions({ dataDir: tempDir("dxos-media-ext-bus-") });
  assert.deepEqual(result, { configured: true });
});
