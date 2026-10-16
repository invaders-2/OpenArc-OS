/**
 * photos 域移植回归测试（全离线：假 ipcMain / 假授权 / 临时 userData / :memory: SQLite，
 * 不启动 Electron、不联网、不下载模型）。
 *
 * 覆盖任务书验收条目：
 *   ① 来源增删与去重（同一真实目录重复添加只保留一条）
 *   ② 虚拟文件夹父子关系与越界拒绝（父不存在 NOT_FOUND；删除父级联子级）
 *   ③ assign 批量（folderId=null 移出；解析不到的 id 记 skipped）
 *   ④ 图库分页与截断（photos/sources/list 与 photos/library 的 total/offset/limit/truncated 显式返回）
 *   ⑤ 未知 id 结构化 NOT_FOUND（来源 / 文件夹 / 文件全部一致）
 *   ⑥ 路径穿越拒绝（'..' / 绝对路径 / 软链接逃逸）
 *   ⑦ 无供应商时视觉能力结构化不可用（visionModels available=false + 配置提示；reversePrompt PROVIDER_UNAVAILABLE）
 *   ⑧ 字节出口无 + / = 且 base64url 解码逐字节一致
 *   附加：trusted fail-closed、命令白名单、特征向量写入/查询、相关排序缓存、
 *         缩略图结构化依赖、抠图结构化依赖、导入器未装配结构化不可用、未认证。
 *
 * 只读源：server/photoSources.ts、server/photoLibraryIndex.ts、server/photoSourceVisualFeatures.ts、server/index.ts。
 * 行号引用见 electron/photos-{domain,store,service}.cjs 顶部注释。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const domain = require("../electron/photos-domain.cjs");
const { createPhotosBundle } = require("../electron/photos-service.cjs");
const { DiskPhotoLibrary, resolvePhotosRoot } = require("../electron/photos-store.cjs");
const { registerPhotosIpc, disposePhotosIpc, PHOTOS_CHANNEL, PHOTOS_NOT_READY } = require("../electron/photos-bootstrap.cjs");
const { createDxosFs } = require("../electron/dxos-fs.cjs");
const { DatabaseSync } = require("node:sqlite");

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tmpDir(prefix = "dxos-photos-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { if (handlers.has(channel)) throw new Error("重复注册 handler：" + channel); handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    invoke(channel, event, raw) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error("没有 handler：" + channel);
      return fn(event, raw);
    },
  };
}

const TRUSTED_EVENT = { sender: "shell", senderFrame: { url: "file:///app/dist/index.html" } };
const makeAuth = (actorId = "u1") => ({ resolveActor: () => ({ ok: true, user: { id: actorId, role: "ADMIN", team_id: "org1", departmentId: null }, organizationId: "org1" }) });

/** v27 迁移里的两张表（dxos-foundation-schema.cjs:276-277），这里按原样建到 :memory:。 */
function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE photo_source_visual_features (source_id TEXT NOT NULL, updated_ts REAL NOT NULL, features_json TEXT NOT NULL, PRIMARY KEY(source_id, updated_ts))");
  db.exec("CREATE TABLE photo_source_related_rankings (image_id TEXT NOT NULL, catalog_hash TEXT NOT NULL, description_hash TEXT NOT NULL, ranked_ids_json TEXT NOT NULL, PRIMARY KEY(image_id, catalog_hash, description_hash))");
  return db;
}

function makeSourceTree() {
  const dir = tmpDir("dxos-photos-source-");
  fs.writeFileSync(path.join(dir, "a.jpg"), Buffer.from("aaaa"));
  fs.writeFileSync(path.join(dir, "b.png"), Buffer.from("bbbb"));
  fs.writeFileSync(path.join(dir, "c.txt"), Buffer.from("not media"));
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "d.webp"), Buffer.from("dddd"));
  fs.writeFileSync(path.join(dir, "sub", "e.mp4"), Buffer.from("eeee"));
  // 用会产生 '+' '/' 的字节验证 base64url 出口
  fs.writeFileSync(path.join(dir, "roundtrip.jpg"), Buffer.from([0xfb, 0xff, 0xbf, 0x00, 0x10]));
  for (let i = 0; i < 8; i += 1) fs.writeFileSync(path.join(dir, "pad-" + String(i).padStart(2, "0") + ".jpg"), Buffer.from("pad" + i));
  // 软链接逃逸：source/escape -> 外部目录
  const outside = tmpDir("dxos-photos-outside-");
  fs.writeFileSync(path.join(outside, "secret.jpg"), Buffer.from("secret"));
  fs.symlinkSync(outside, path.join(dir, "escape"));
  return { dir, outside };
}

function makeHarness(options = {}) {
  const userDataDir = options.userDataDir || tmpDir();
  const db = options.db === undefined ? makeDb() : options.db;
  const bundle = createPhotosBundle({
    userDataDir,
    authorization: options.authorization === undefined ? makeAuth() : options.authorization,
    db,
    providerStore: options.providerStore || null,
    fsImpl: options.fsImpl || null,
    shareAccess: options.shareAccess || null,
    sharpLoader: options.sharpLoader || null,
    videoPoster: options.videoPoster || null,
    importer: options.importer || null,
    vision: options.vision || null,
  });
  const ipcMain = fakeIpcMain();
  registerPhotosIpc(ipcMain, { bundle, identity: { current: "session-1" }, isTrusted: (event) => !!event && event.sender === "shell" });
  const call = (command, payload) => ipcMain.invoke(PHOTOS_CHANNEL, TRUSTED_EVENT, { command, payload });
  return { userDataDir, db, bundle, ipcMain, call };
}

// 取值都是 0.125 的整数倍：JSON 往返精确，便于断言编码无损。
const vector = (seed) => Array.from({ length: 192 }, (_, i) => ((i + seed) % 9) * 0.125);

/**
 * 特征出口按 100 一段切 chunks（单个 192 维数组过 IPC 会被 foundation 静默截到 100 维）。
 * 每段都必须 <= 100，否则就是数据损坏。
 */
function decodeFeature(entry) {
  assert.equal(entry.length, 192);
  assert.equal(entry.chunkSize, 100);
  assert.ok(entry.chunks.length >= 2);
  for (const chunk of entry.chunks) assert.ok(chunk.length <= 100, "任何一段都不得超过 foundation 的 100 项截断阈值");
  return entry.chunks.flat();
}

/** 取出某个名字的本地条目。 */
function itemNamed(listValue, name) {
  return listValue.items.find((item) => item.name === name);
}

// ---------------------------------------------------------------------------
// ① 来源增删与去重
// ---------------------------------------------------------------------------

test("来源：添加真实目录、按真实路径去重、移除；未知 id 回 NOT_FOUND", async () => {
  const h = makeHarness();
  const { dir } = makeSourceTree();

  const first = await h.call("photos/sources/add", { path: dir });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.created, true);
  assert.equal(typeof first.value.source.id, "string");
  assert.equal(first.value.source.available, true);
  // 宿主绝对路径绝不过 IPC
  assert.equal(JSON.stringify(first.value).includes(dir), false, "来源视图不得回宿主绝对路径");

  const second = await h.call("photos/sources/add", { path: dir + path.sep + "." });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.created, false, "同一真实目录不得产生第二条来源");
  assert.equal(second.value.source.id, first.value.source.id);

  const listing = await h.call("photos/sources/list", { limit: 100 });
  assert.equal(listing.ok, true, JSON.stringify(listing));
  assert.equal(listing.value.sources.length, 1);
  assert.equal(listing.value.sources[0].id, first.value.source.id);

  const removed = await h.call("photos/sources/remove", { id: first.value.source.id });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.value.removed, true);
  const after = await h.call("photos/sources/list", {});
  assert.equal(after.value.sources.length, 0);

  const missing = await h.call("photos/sources/remove", { id: "does-not-exist" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, domain.PHOTOS_ERR_NOT_FOUND);
});

test("来源：非绝对路径 / 不存在目录 / 文件路径都被拒绝", async () => {
  const h = makeHarness();
  const { dir } = makeSourceTree();
  const relative = await h.call("photos/sources/add", { path: "relative/folder" });
  assert.equal(relative.ok, false);
  assert.equal(relative.error, domain.PHOTOS_ERR_INVALID_INPUT);

  const absent = await h.call("photos/sources/add", { path: path.join(tmpDir(), "nope") });
  assert.equal(absent.ok, false);
  assert.equal(absent.error, domain.PHOTOS_ERR_NOT_FOUND);

  const file = await h.call("photos/sources/add", { path: path.join(dir, "a.jpg") });
  assert.equal(file.ok, false);
  assert.equal(file.error, domain.PHOTOS_ERR_INVALID_INPUT);
});

// ---------------------------------------------------------------------------
// ② 虚拟文件夹父子关系与越界拒绝
// ---------------------------------------------------------------------------

test("虚拟文件夹：父子关系、父不存在 NOT_FOUND、名称非法 INVALID_INPUT、删除父级联子级", async () => {
  const h = makeHarness();
  const parent = await h.call("photos/folders/create", { name: "旅行" });
  assert.equal(parent.ok, true, JSON.stringify(parent));
  assert.equal(parent.value.folder.parentId, null);

  const child = await h.call("photos/folders/create", { name: "京都", parentId: parent.value.folder.id });
  assert.equal(child.ok, true, JSON.stringify(child));
  assert.equal(child.value.folder.parentId, parent.value.folder.id);

  const grandchild = await h.call("photos/folders/create", { name: "夜景", parentId: child.value.folder.id });
  assert.equal(grandchild.ok, true, JSON.stringify(grandchild));

  const orphan = await h.call("photos/folders/create", { name: "孤儿", parentId: "no-such-folder" });
  assert.equal(orphan.ok, false);
  assert.equal(orphan.error, domain.PHOTOS_ERR_NOT_FOUND);

  const empty = await h.call("photos/folders/create", { name: "   " });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, domain.PHOTOS_ERR_INVALID_INPUT);

  const tooLong = await h.call("photos/folders/create", { name: "x".repeat(81) });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error, domain.PHOTOS_ERR_INVALID_INPUT);

  const removed = await h.call("photos/folders/remove", { id: parent.value.folder.id });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.value.removedFolderIds.length, 3, "删除父级必须级联子级与孙级");

  const listing = await h.call("photos/sources/list", {});
  assert.deepEqual(listing.value.virtualFolders, []);

  const missing = await h.call("photos/folders/remove", { id: "no-such-folder" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, domain.PHOTOS_ERR_NOT_FOUND);
});

// ---------------------------------------------------------------------------
// ③ assign 批量
// ---------------------------------------------------------------------------

test("归类：批量 assign、skipped 回执、folderId=null 移出、未知文件夹 NOT_FOUND", async () => {
  const h = makeHarness();
  const { dir } = makeSourceTree();
  const source = await h.call("photos/sources/add", { path: dir });
  assert.equal(source.ok, true);
  const list = await h.call("photos/sources/list", { limit: 100 });
  assert.equal(list.ok, true, JSON.stringify(list));
  const a = itemNamed(list.value, "a.jpg");
  const b = itemNamed(list.value, "b.png");
  assert.ok(a && b);

  const folder = await h.call("photos/folders/create", { name: "精选" });
  assert.equal(folder.ok, true);
  const folderId = folder.value.folder.id;

  const assigned = await h.call("photos/folders/assign", { ids: [a.id, b.id, "local:missing:none.jpg"], folderId });
  assert.equal(assigned.ok, true, JSON.stringify(assigned));
  assert.equal(assigned.value.assigned, 2);
  assert.equal(assigned.value.skipped.length, 1);
  assert.equal(assigned.value.skipped[0], "local:missing:none.jpg");

  const afterAssign = await h.call("photos/sources/list", { limit: 100 });
  assert.equal(itemNamed(afterAssign.value, "a.jpg").virtualFolderId, folderId);
  assert.equal(itemNamed(afterAssign.value, "b.png").virtualFolderId, folderId);

  const cleared = await h.call("photos/folders/assign", { ids: [a.id], folderId: null });
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal(cleared.value.cleared, 1);
  const afterClear = await h.call("photos/sources/list", { limit: 100 });
  assert.equal(itemNamed(afterClear.value, "a.jpg").virtualFolderId, null);

  const badFolder = await h.call("photos/folders/assign", { ids: [a.id], folderId: "no-such-folder" });
  assert.equal(badFolder.ok, false);
  assert.equal(badFolder.error, domain.PHOTOS_ERR_NOT_FOUND);

  const emptyIds = await h.call("photos/folders/assign", { ids: [], folderId: null });
  assert.equal(emptyIds.ok, false);
  assert.equal(emptyIds.error, domain.PHOTOS_ERR_INVALID_INPUT);
});

// ---------------------------------------------------------------------------
// ④ 图库分页与截断
// ---------------------------------------------------------------------------

test("来源分页：total / offset / limit / truncated 显式返回，且只回媒体文件", async () => {
  const h = makeHarness();
  const { dir } = makeSourceTree();
  await h.call("photos/sources/add", { path: dir });

  const first = await h.call("photos/sources/list", { offset: 0, limit: 5 });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.total, 13, "4 个根文件 + 2 个子目录媒体 + roundtrip + 8 个 pad");
  assert.equal(first.value.items.length, 5);
  assert.equal(first.value.offset, 0);
  assert.equal(first.value.limit, 5);
  assert.equal(first.value.truncated, true);
  assert.equal(first.value.items.some((item) => item.name === "c.txt"), false, "非媒体扩展名不进索引");

  const last = await h.call("photos/sources/list", { offset: 10, limit: 5 });
  assert.equal(last.ok, true);
  assert.equal(last.value.items.length, 3);
  assert.equal(last.value.truncated, false);

  const overLimit = await h.call("photos/sources/list", { limit: 101 });
  assert.equal(overLimit.ok, false);
  assert.equal(overLimit.error, domain.PHOTOS_ERR_INVALID_INPUT);

  const badOffset = await h.call("photos/sources/list", { offset: -1 });
  assert.equal(badOffset.ok, false);
  assert.equal(badOffset.error, domain.PHOTOS_ERR_INVALID_INPUT);
});

test("虚拟树图库：按可见性过滤 + 分页", async () => {
  const userDataDir = tmpDir();
  const fsImpl = createDxosFs({ userDataDir });
  const systemRoot = fsImpl.ensureSystemRoot();
  const project = fsImpl.ensureUserFolder("项目", "u1");
  void systemRoot;
  for (let i = 0; i < 7; i += 1) {
    fsImpl.createNode({ name: "photo-" + i + ".png", type: "file", parentId: project.id, mime: "image/png", size: 10 + i, ownerId: "u1" });
  }
  fsImpl.createNode({ name: "note.txt", type: "file", parentId: project.id, mime: "text/plain", size: 3, ownerId: "u1" });

  const h = makeHarness({ userDataDir, fsImpl });
  const page = await h.call("photos/library", { offset: 0, limit: 5 });
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.equal(page.value.total, 7);
  assert.equal(page.value.items.length, 5);
  assert.equal(page.value.truncated, true);
  assert.equal(page.value.items.every((item) => item.kind === "image"), true);
  assert.equal(page.value.items[0].path, "项目", "文件夹链应排除 .系统目录");

  const rest = await h.call("photos/library", { offset: 5, limit: 5 });
  assert.equal(rest.value.items.length, 2);
  assert.equal(rest.value.truncated, false);
});

test("虚拟树图库：未装配 fsImpl 时结构化 DEPENDENCY_UNAVAILABLE，不静默回空", async () => {
  const h = makeHarness();
  const result = await h.call("photos/library", {});
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, domain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE);
  assert.match(result.detail.hint, /fsImpl/);
});

// ---------------------------------------------------------------------------
// ⑤ 未知 id 结构化 NOT_FOUND
// ---------------------------------------------------------------------------

test("未知 id：sourceFile / sourceThumbnail 都回 PHOTOS_NOT_FOUND", async () => {
  const h = makeHarness();
  const file = await h.call("photos/sourceFile", { id: "local:nope:none.jpg" });
  assert.equal(file.ok, false);
  assert.equal(file.error, domain.PHOTOS_ERR_NOT_FOUND);

  const thumb = await h.call("photos/sourceThumbnail", { id: "local:nope:none.jpg" });
  assert.equal(thumb.ok, false);
  assert.equal(thumb.error, domain.PHOTOS_ERR_NOT_FOUND);

  const noId = await h.call("photos/sourceFile", {});
  assert.equal(noId.ok, false);
  assert.equal(noId.error, domain.PHOTOS_ERR_INVALID_INPUT);
});

// ---------------------------------------------------------------------------
// ⑥ 路径穿越拒绝
// ---------------------------------------------------------------------------

test("路径穿越：'..' / 绝对路径 / 软链接逃逸 / 非法 id 形态全部拒绝", async () => {
  const h = makeHarness();
  const { dir } = makeSourceTree();
  const source = await h.call("photos/sources/add", { path: dir });
  assert.equal(source.ok, true);
  const sourceId = source.value.source.id;

  const escapes = [
    "local:" + sourceId + ":../secret.jpg",
    "local:" + sourceId + ":sub/../../secret.jpg",
    "local:" + sourceId + ":/etc/passwd",
    "local:" + sourceId + ":escape/secret.jpg",
    "local:" + sourceId + ":",
    "local::a.jpg",
    "local:" + sourceId + ":sub/./d.webp",
  ];
  for (const id of escapes) {
    const result = await h.call("photos/sourceFile", { id });
    assert.equal(result.ok, false, "必须拒绝：" + id);
    assert.equal(result.error, domain.PHOTOS_ERR_NOT_FOUND, "必须拒绝：" + id);
  }

  // 正常 id 仍可读
  const good = await h.call("photos/sourceFile", { id: "local:" + sourceId + ":sub/d.webp" });
  assert.equal(good.ok, true, JSON.stringify(good));
});

// ---------------------------------------------------------------------------
// ⑦ 无供应商时视觉能力结构化不可用
// ---------------------------------------------------------------------------

test("视觉能力：无供应商时 visionModels 明确不可用，reversePrompt 结构化 PROVIDER_UNAVAILABLE", async () => {
  const h = makeHarness();
  const { dir } = makeSourceTree();
  const source = await h.call("photos/sources/add", { path: dir });
  const sourceId = source.value.source.id;

  const models = await h.call("photos/visionModels", {});
  assert.equal(models.ok, true, JSON.stringify(models));
  assert.equal(models.value.available, false);
  assert.deepEqual(models.value.models, []);
  assert.match(models.value.hint, /API 供应商/);

  const reversed = await h.call("photos/reversePrompt", { imageId: "local:" + sourceId + ":a.jpg" });
  assert.equal(reversed.ok, false);
  assert.equal(reversed.error, domain.PHOTOS_ERR_PROVIDER_UNAVAILABLE);
  assert.match(reversed.detail.hint, /API 供应商/);

  const notImage = await h.call("photos/reversePrompt", { imageId: "local:" + sourceId + ":sub/e.mp4" });
  assert.equal(notImage.ok, false);
  assert.equal(notImage.error, domain.PHOTOS_ERR_INVALID_INPUT);
});

test("视觉能力：注入 providerStore（含 vision caps）后 visionModels 列出模型，reversePrompt 走注入实现", async () => {
  const providerStore = {
    listPublic: () => [
      { id: "p1", name: "自填平台", enabled: true, has_key: true, base_url: "https://example.invalid/v1", models: [{ model: "vision-1", caps: ["llm", "vision"] }, { model: "text-1", caps: ["llm"] }] },
      { id: "p2", name: "无 Key", enabled: true, has_key: false, models: [{ model: "vision-2", caps: ["vlm"] }] },
    ],
    get: () => ({ api_key: "should-not-be-used" }),
  };
  const calls = [];
  const vision = {
    list: () => [{ providerId: "p1", providerName: "自填平台", model: "vision-1" }],
    describe: async ({ target, imageId }) => { calls.push({ target, imageId }); return "  一只猫坐在窗台  "; },
  };
  const h = makeHarness({ providerStore, vision });
  const { dir } = makeSourceTree();
  const source = await h.call("photos/sources/add", { path: dir });
  const sourceId = source.value.source.id;

  const models = await h.call("photos/visionModels", {});
  assert.equal(models.ok, true, JSON.stringify(models));
  assert.equal(models.value.available, true);
  assert.deepEqual(models.value.models, [{ providerId: "p1", providerName: "自填平台", model: "vision-1" }]);

  const reversed = await h.call("photos/reversePrompt", { imageId: "local:" + sourceId + ":a.jpg", providerId: "p1", model: "vision-1" });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));
  assert.equal(reversed.value.text, "一只猫坐在窗台");
  assert.equal(reversed.value.providerId, "p1");
  assert.equal(calls.length, 1);

  const missingModel = await h.call("photos/reversePrompt", { imageId: "local:" + sourceId + ":a.jpg", providerId: "p1", model: "nope" });
  assert.equal(missingModel.ok, false);
  assert.equal(missingModel.error, domain.PHOTOS_ERR_PROVIDER_UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// ⑧ 字节出口 base64url
// ---------------------------------------------------------------------------

test("字节出口：sourceFile/sourceThumbnail 回 base64url（无 + / =）且解码逐字节一致", async () => {
  const thumbBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
  const fakeSharp = (() => {
    const instance = { rotate() { return instance; }, resize() { return instance; }, jpeg() { return instance; }, toBuffer: async () => thumbBytes };
    const sharp = () => instance;
    sharp.kernel = { lanczos3: 1 };
    return sharp;
  })();
  const h = makeHarness({ sharpLoader: () => fakeSharp });
  const { dir } = makeSourceTree();
  const source = await h.call("photos/sources/add", { path: dir });
  const sourceId = source.value.source.id;

  const raw = fs.readFileSync(path.join(dir, "roundtrip.jpg"));
  const file = await h.call("photos/sourceFile", { id: "local:" + sourceId + ":roundtrip.jpg" });
  assert.equal(file.ok, true, JSON.stringify(file));
  assert.equal(file.value.encoding, "base64url");
  assert.equal(file.value.size, raw.length);
  assert.doesNotMatch(file.value.data, /[+/=]/, "字节出口不得含 + / =");
  assert.deepEqual(Buffer.from(file.value.data, "base64url"), raw, "base64url 解码必须逐字节一致");

  const thumb = await h.call("photos/sourceThumbnail", { id: "local:" + sourceId + ":a.jpg" });
  assert.equal(thumb.ok, true, JSON.stringify(thumb));
  assert.equal(thumb.value.mime, "image/jpeg");
  assert.equal(thumb.value.cached, false);
  assert.doesNotMatch(thumb.value.data, /[+/=]/);
  assert.deepEqual(Buffer.from(thumb.value.data, "base64url"), thumbBytes);

  const cached = await h.call("photos/sourceThumbnail", { id: "local:" + sourceId + ":a.jpg" });
  assert.equal(cached.value.cached, true, "第二次必须命中缩略图缓存");

  const badSize = await h.call("photos/sourceThumbnail", { id: "local:" + sourceId + ":a.jpg", size: 4 });
  assert.equal(badSize.ok, false);
  assert.equal(badSize.error, domain.PHOTOS_ERR_INVALID_INPUT);
});

// ---------------------------------------------------------------------------
// 特征 / 相关排序
// ---------------------------------------------------------------------------

test("视觉特征：写入 / 查询 192 维向量，mtime 不一致即拒绝写入", async () => {
  const h = makeHarness();
  const { dir } = makeSourceTree();
  await h.call("photos/sources/add", { path: dir });
  const list = await h.call("photos/sources/list", { limit: 100 });
  const a = itemNamed(list.value, "a.jpg");
  const b = itemNamed(list.value, "b.png");

  const badVector = await h.call("photos/features/compute", { items: [{ id: a.id, updated_ts: a.updated_ts, features: [0.5, 0.5] }] });
  assert.equal(badVector.ok, true, JSON.stringify(badVector));
  assert.equal(badVector.value.saved, 0, "维度不符不得写入");

  const stored = await h.call("photos/features/compute", { items: [{ id: a.id, updated_ts: a.updated_ts, features: vector(1) }, { id: b.id, updated_ts: b.updated_ts, features: vector(2) }] });
  assert.equal(stored.ok, true, JSON.stringify(stored));
  assert.equal(stored.value.saved, 2);

  const query = await h.call("photos/features/query", { items: [{ id: a.id, updated_ts: a.updated_ts }, { id: b.id, updated_ts: b.updated_ts }] });
  assert.equal(query.ok, true, JSON.stringify(query));
  assert.equal(query.value.chunkSize, 100);
  assert.equal(query.value.total, 2);
  assert.deepEqual(decodeFeature(query.value.features[a.id + ":" + a.updated_ts]), vector(1));
  assert.deepEqual(decodeFeature(query.value.features[b.id + ":" + b.updated_ts]), vector(2));

  const stale = await h.call("photos/features/compute", { items: [{ id: a.id, updated_ts: a.updated_ts + 5, features: vector(3) }] });
  assert.equal(stale.ok, true);
  assert.equal(stale.value.saved, 0, "mtime 不一致不得写入");

  const noDb = makeHarness({ db: null });
  const unavailable = await noDb.call("photos/features/query", { items: [{ id: a.id, updated_ts: a.updated_ts }] });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, domain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE);
});

test("相关推荐：首次查询即时排序并缓存，后续命中 cache", async () => {
  const h = makeHarness();
  const { dir } = makeSourceTree();
  await h.call("photos/sources/add", { path: dir });
  const list = await h.call("photos/sources/list", { limit: 100 });
  const a = itemNamed(list.value, "a.jpg");
  const b = itemNamed(list.value, "b.png");
  const d = itemNamed(list.value, "d.webp");

  await h.call("photos/features/compute", {
    items: [
      { id: a.id, updated_ts: a.updated_ts, features: vector(0) },
      { id: b.id, updated_ts: b.updated_ts, features: vector(0) },
      { id: d.id, updated_ts: d.updated_ts, features: vector(6) },
    ],
  });

  const body = {
    id: a.id,
    catalogSignature: "catalog-v1",
    descriptionSignature: "desc-v1",
    updated_ts: a.updated_ts,
    folderId: null,
    candidates: [
      { id: b.id, updated_ts: b.updated_ts, folderId: null },
      { id: d.id, updated_ts: d.updated_ts, folderId: null },
    ],
    semanticScores: [],
  };
  const first = await h.call("photos/related/query", body);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.computed, true);
  assert.equal(first.value.cached, false);
  assert.deepEqual(first.value.ids, [b.id, d.id], "同向量 b 必须排在异向量 d 之前");
  assert.equal(first.value.total, 2);
  assert.equal(first.value.truncated, false);

  const second = await h.call("photos/related/query", body);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.computed, false);
  assert.equal(second.value.cached, true);
  assert.deepEqual(second.value.ids, first.value.ids);

  const paged = await h.call("photos/related/query", { ...body, limit: 1 });
  assert.equal(paged.value.ids.length, 1);
  assert.equal(paged.value.truncated, true);

  const noFeatures = await h.call("photos/related/query", { ...body, id: d.id, catalogSignature: "other", candidates: [{ id: a.id, updated_ts: a.updated_ts, folderId: null }] });
  assert.equal(noFeatures.ok, true, JSON.stringify(noFeatures));
  assert.equal(noFeatures.value.ids, null, "缺参考特征时回 ids=null，不假排序");
});

// ---------------------------------------------------------------------------
// 依赖缺失时结构化不可用
// ---------------------------------------------------------------------------

test("抠图：复用 media-background-removal，缺 onnxruntime/模型即结构化 DEPENDENCY_UNAVAILABLE", async () => {
  const h = makeHarness();
  const result = await h.call("photos/backgroundRemoval", { image: Buffer.from([1, 2, 3]).toString("base64url"), model: "ben2-base" });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, domain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE);
});

test("导入：未注入 importer 即结构化 DEPENDENCY_UNAVAILABLE；注入后回 cardId", async () => {
  const h = makeHarness();
  const { dir } = makeSourceTree();
  const source = await h.call("photos/sources/add", { path: dir });
  const sourceId = source.value.source.id;
  const missing = await h.call("photos/importImage", { sourceId: "local:" + sourceId + ":a.jpg", targetId: "canvas-1", destination: "canvas" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, domain.PHOTOS_ERR_DEPENDENCY_UNAVAILABLE);
  assert.match(missing.detail.hint, /importer/);

  const injected = makeHarness({ importer: async ({ destination, name }) => ({ cardId: destination + ":" + name }) });
  const added = await injected.call("photos/sources/add", { path: dir });
  const sid = added.value.source.id;
  const ok = await injected.call("photos/importImage", { sourceId: "local:" + sid + ":a.jpg", targetId: "canvas-1", destination: "canvas" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.value.canvasId, undefined);
  assert.equal(ok.value.cardId, "canvas:a.jpg");

  const wrongDestination = await injected.call("photos/importImage", { sourceId: "local:" + sid + ":a.jpg", targetId: "canvas-1", destination: "cloud" });
  assert.equal(wrongDestination.ok, false);
  assert.equal(wrongDestination.error, domain.PHOTOS_ERR_INVALID_INPUT);
});

// ---------------------------------------------------------------------------
// 引导层：trusted fail-closed / 命令白名单 / 未装配 / 未认证
// ---------------------------------------------------------------------------

test("引导层：非 trusted 事件抛 Forbidden（fail closed）", async () => {
  const h = makeHarness();
  await assert.rejects(
    () => h.ipcMain.invoke(PHOTOS_CHANNEL, { sender: "evil", senderFrame: { url: "https://evil.example" } }, { command: "photos/health", payload: {} }),
    /Forbidden/,
  );
});

test("引导层：未知命令回 PHOTOS_COMMAND_NOT_ALLOWED，未装配回 PHOTOS_NOT_READY", async () => {
  const h = makeHarness();
  const unknown = await h.call("photos/nope", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, domain.PHOTOS_ERR_COMMAND_NOT_ALLOWED);

  const ipcMain = fakeIpcMain();
  registerPhotosIpc(ipcMain, { bundle: null, identity: { current: "s" }, isTrusted: () => true });
  const notReady = await ipcMain.invoke(PHOTOS_CHANNEL, TRUSTED_EVENT, { command: "photos/health", payload: {} });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, PHOTOS_NOT_READY);
});

test("未认证：authorization 缺失时全部命令回 PHOTOS_UNAUTHENTICATED", async () => {
  const h = makeHarness({ authorization: null });
  const result = await h.call("photos/health", {});
  assert.equal(result.ok, false);
  assert.equal(result.error, domain.PHOTOS_ERR_UNAUTHENTICATED);
});

test("白名单：18 条冻结命令全部注册，命令名与源路由一一对应", () => {
  const expected = [
    "photos/sources/list", "photos/sources/add", "photos/sources/remove",
    "photos/folders/create", "photos/folders/remove", "photos/folders/assign",
    "photos/library", "photos/sourceFile", "photos/sourceThumbnail", "photos/importImage",
    "photos/features/compute", "photos/features/query", "photos/related/compute", "photos/related/query",
    "photos/reversePrompt", "photos/visionModels", "photos/backgroundRemoval", "photos/health",
  ];
  for (const command of expected) assert.equal(domain.isPhotosCommand(command), true, command);
  assert.equal(domain.listPhotosCommands().length, expected.length);
});

test("落盘：来源清单固定在 <userData>/dxos/photos 之下并原子写", async () => {
  const userDataDir = tmpDir();
  const h = makeHarness({ userDataDir });
  const { dir } = makeSourceTree();
  await h.call("photos/sources/add", { path: dir });
  assert.equal(fs.existsSync(path.join(userDataDir, "dxos", "photos", "sources-shared.json")), true);
  const files = fs.readdirSync(path.join(userDataDir, "dxos", "photos")).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(files, [], "原子写不得残留 .tmp");
  assert.equal(h.bundle.root, resolvePhotosRoot(userDataDir));
  assert.equal(new DiskPhotoLibrary({ root: h.bundle.root }).readSharedSources().length, 1);

  const health = await h.call("photos/health", {});
  assert.equal(health.ok, true, JSON.stringify(health));
  assert.equal(health.value.directory, "dxos/photos");
  assert.equal(health.value.dependencies.database, true);
});

test("dispose 后 handler 被移除", () => {
  const h = makeHarness();
  assert.equal(h.ipcMain.handlers.has(PHOTOS_CHANNEL), true);
  disposePhotosIpc(h.ipcMain);
  assert.equal(h.ipcMain.handlers.has(PHOTOS_CHANNEL), false);
});
