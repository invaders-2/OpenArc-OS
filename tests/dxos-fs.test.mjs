/**
 * B6b · DX 虚拟文件树回归测试（全离线，os.tmpdir 临时目录）。
 *
 * 覆盖本轮验收条目：
 *   ① 树操作（节点/路径解析/创建/重命名/移动/复制/软删）与路径越界拒绝
 *   ② blob 往返 + 内容寻址 + 哈希不符拒绝 + 损坏检测
 *   ③ 缩略图
 *   ④ 共享盘 / 部门盘可见性
 *   ⑤ 回收站软删 / 恢复 / 清空
 *   ⑥ 快照创建 / 列举 / 恢复
 *   ⑦ 并发写冲突（revision 乐观锁）
 *   ⑧ 系统根 / 用户固定目录 / 搜索 / 打包 / 存储统计
 *   ⑨ 数据目录来源 = dxos-foundation-paths.cjs 的 directory.fs
 *
 * 只读源：server/fs.ts:1-1451。全部用例不触网、不启动 Electron、不碰真实桌面文件。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDxosFs, resolveFsDataDir } = require("../electron/dxos-fs.cjs");
const { resolveDxosPaths, resolveDxosFsDir } = require("../electron/dxos-foundation-paths.cjs");

const dirs = [];
after(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

function mkDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || "dxos-fs-"));
  dirs.push(dir);
  return dir;
}

function mkStore(options) {
  return createDxosFs(Object.assign({ dataDir: mkDir() }, options || {}));
}

test("树操作：创建/列举/路径解析/重命名/移动/复制/软删（源 fs.ts:485-1023）", () => {
  const s = mkStore();
  // 首次 load 落 seed（源 fs.ts:174-181）
  const rootList = s.listChildren(null);
  assert.deepEqual(rootList.path, [{ id: null, name: "桌面" }]);
  assert.deepEqual(rootList.nodes.map((n) => n.name), ["文稿", "便签.txt"]);

  const docsId = s.ensureFolder("文档", null, "u1");
  assert.equal(typeof docsId, "string"); // 源 fs.ts:685-691 返回 id
  const target = s.resolvePath(null, "文档/子目录/report.md", true);
  assert.equal(target.leaf, "report.md");
  const file = s.createNode({ name: target.leaf, type: "file", parentId: target.parentId, content: "hello" });
  assert.equal(s.findByPath(null, "文档/子目录/report.md").id, file.id);
  assert.deepEqual(s.listChildren(target.parentId).nodes.map((n) => n.name), ["report.md"]);

  // 同父目录重名自动 (2)（源 fs.ts:469-478）
  const dup = s.createNode({ name: "report.md", type: "file", parentId: target.parentId, content: "x" });
  assert.equal(dup.name, "report (2).md");

  // 重命名（源 fs.ts:791-805）
  assert.equal(s.renameNode(dup.id, "summary.md").name, "summary.md");

  // 移动（源 fs.ts:947-965）
  assert.equal(s.moveNode(file.id, docsId).parentId, docsId);
  assert.equal(s.findByPath(null, "文档/report.md").id, file.id);

  // 禁止移动到自身子孙（源 fs.ts:953-959）
  assert.throws(() => s.moveNode(docsId, target.parentId), /自己的子目录/);

  // 复制文件夹递归（源 fs.ts:968-1012）
  const copy = s.copyNode(docsId, null);
  assert.equal(copy.name, "文档 (2)");
  assert.ok(s.findByPath(null, "文档 (2)/子目录/summary.md"));
  assert.equal(s.getNode(copy.id).type, "folder");
});

test("路径越界拒绝（源 fs.ts:642-660 + 文件头硬化）", () => {
  const s = mkStore();
  const root = s.createNode({ name: "proj", type: "folder", parentId: null });
  const isEscape = (e) => e && e.code === "FS_PATH_ESCAPE" && e.statusCode === 400;
  assert.throws(() => s.resolvePath(root.id, "../escape.txt", true), isEscape);
  assert.throws(() => s.resolvePath(root.id, "a/../../x.txt", true), isEscape);
  assert.throws(() => s.resolvePath(root.id, "/etc/passwd", true), isEscape);
  assert.throws(() => s.resolvePath(root.id, "C:/Windows/x", true), isEscape);
  // findByPath 沿用源 try/catch -> null（源 fs.ts:663-670）
  assert.equal(s.findByPath(root.id, "../escape.txt"), null);
  // 文件名清理后不可能带分隔符（源 fs.ts:481-483）
  const node = s.createNode({ name: "../x/y.txt", type: "file", parentId: root.id, content: "z" });
  assert.equal(node.name.includes("/"), false);
  assert.equal(s.countSubtree(root.id), 2);
  // 批量计划同样拒绝越界（源 fs.ts:348）
  assert.throws(
    () => s.prepareFsArtifactBatchPlan(root.id, [{ path: "../x.txt", kind: "text", content: "x", ownerId: "u1" }]),
    /无效的文本提交路径/,
  );
});

test("blob：saveBlob/readBlob 往返 + 内容寻址 + 哈希校验（源 fs.ts:51-168、85-116）", () => {
  const s = mkStore();
  const root = s.createNode({ name: "root", type: "folder", parentId: null });
  const node = s.createNode({ name: "a.bin", type: "file", parentId: root.id, mime: "application/octet-stream", size: 4 });
  const bytes = Buffer.from("BLOB");
  s.saveBlob(node.id, bytes);
  assert.equal(s.hasBlob(node.id), true);
  assert.deepEqual(s.readBlob(node.id), bytes);
  assert.equal(s.hasBlob("missing"), false);

  // 内容寻址：stage 幂等 + created 标记
  const first = s.stageContentAddressedBlob(bytes);
  assert.equal(first.created, true);
  assert.equal(first.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(s.hasContentAddressedBlob(first.sha256), true);
  assert.equal(s.stageContentAddressedBlob(bytes).created, false);
  // 期望哈希不符 -> 拒绝
  assert.throws(() => s.stageContentAddressedBlob(bytes, "0".repeat(64)), /不一致/);
  // 目标已存在但内容被篡改 -> 拒绝
  fs.writeFileSync(first.path, Buffer.from("TAMPERED"));
  assert.throws(() => s.stageContentAddressedBlob(bytes), /已损坏|校验失败/);

  // 通过 Journal 计划写二进制节点 -> readBlob 走内容寻址路径
  const s2 = mkStore();
  const root2 = s2.createNode({ name: "root", type: "folder", parentId: null });
  const staged = s2.stageContentAddressedBlob(Buffer.from("PNGDATA"));
  const plan = s2.prepareFsArtifactBatchPlan(root2.id, [
    { path: "img/a.png", kind: "binary", blobSha256: staged.sha256, mime: "image/png", bytes: 7, ownerId: "u1" },
  ]);
  s2.publishFsArtifactBatchPlan(plan, "commit-1");
  const written = s2.findByPath(root2.id, "img/a.png");
  assert.equal(written.blobSha256, staged.sha256);
  assert.deepEqual(s2.readBlob(written.id), Buffer.from("PNGDATA"));
});

test("缩略图（源 fs.ts:63-81）", () => {
  const s = mkStore();
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(s.hasThumbnail(id), false);
  s.saveThumbnail(id, Buffer.from("thumb"));
  assert.equal(s.hasThumbnail(id), true);
  assert.equal(fs.existsSync(s.thumbnailPath(id)), true);
  s.saveThumbnail(id, Buffer.from("thumb256"), 256);
  assert.equal(s.hasThumbnail(id, 256), true);
  s.deleteThumbnail(id);
  assert.equal(s.hasThumbnail(id), false);
  assert.equal(s.hasThumbnail(id, 256), false);
});

test("共享盘 / 部门盘可见性与归属（源 fs.ts:846-926、551-603）", () => {
  const s = mkStore();
  const pub = s.ensurePublicRoot();
  assert.equal(pub.share, "public");
  assert.equal(s.shareZoneOf(pub.id), "public");
  const child = s.createNode({ name: "公告.txt", type: "file", parentId: pub.id, content: "hi" });
  assert.equal(s.shareZoneOf(child.id), "public");

  const dept = s.ensureDepartmentRoot("d1", "设计部");
  assert.equal(dept.share, "department:d1");
  assert.equal(dept.name, "设计部（部门）");
  assert.deepEqual(s.listChildren(dept.id).nodes, []);

  // 二次调用幂等
  assert.equal(s.ensurePublicRoot().id, pub.id);
  assert.equal(s.ensureDepartmentRoot("d1", "设计部").id, dept.id);

  // 私人目录：其他用户不能创建内容（源 fs.ts:578）
  const priv = s.createNode({ name: "私人", type: "folder", parentId: null, ownerId: "u1" });
  assert.throws(
    () => s.createNode({ name: "x.txt", type: "file", parentId: priv.id, ownerId: "u2" }),
    /不能在其他用户的文件夹中创建内容/,
  );
  // 共享区内允许跨用户协作
  const shared = s.createNode({ name: "协作.txt", type: "file", parentId: pub.id, ownerId: "u2" });
  assert.equal(s.shareZoneOf(shared.id), "public");

  // 画布 / 资产库共享标记（源 fs.ts:879-912）
  const proj = s.createNode({ name: "proj", type: "folder", parentId: null });
  s.setCanvasFolderShare(proj.id, "c1", true);
  assert.equal(s.shareZoneOf(proj.id), "canvas:c1");
  s.setCanvasFolderShare(proj.id, "c1", false);
  assert.equal(s.shareZoneOf(proj.id), null);
  s.setAssetLibraryFolderShare(proj.id, "lib1", true);
  assert.equal(s.shareZoneOf(proj.id), "asset-library:lib1");
});

test("回收站：软删 / 列举 / 恢复 / 清空（源 fs.ts:1015-1098）", () => {
  const s = mkStore();
  const folder = s.createNode({ name: "文档", type: "folder", parentId: null });
  const file = s.createNode({ name: "note.txt", type: "file", parentId: folder.id, content: "hi" });
  assert.equal(s.removeNode(file.id), 1);
  assert.equal(s.isInTrash(file.id), true);
  const trashed = s.listTrash();
  assert.equal(trashed.length, 1);
  assert.equal(trashed[0].id, file.id);
  assert.equal(trashed[0].origPath, "文档");
  assert.equal(s.getNode(file.id).content, "hi"); // 软删保留数据

  const restored = s.restoreNode(file.id);
  assert.equal(restored.trashed, false);
  assert.equal(s.isInTrash(file.id), false);
  assert.equal(s.findByPath(null, "文档/note.txt").id, file.id);

  // 删除父目录 -> 整棵子树视为已删，但废纸篓只列被删的根
  s.removeNode(folder.id);
  assert.equal(s.isInTrash(file.id), true);
  assert.equal(s.findByPath(null, "文档/note.txt"), null);
  assert.equal(s.listTrash().length, 1);
  assert.equal(s.emptyTrash(), 2);
  assert.equal(s.getNode(folder.id), null);
  assert.equal(s.getNode(file.id), null);
});

test("快照：创建 / 列举 / 恢复（源 fs.ts:1330-1395）", () => {
  const s = mkStore();
  const root = s.createNode({ name: "项目", type: "folder", parentId: null });
  const file = s.createNode({ name: "a.txt", type: "file", parentId: root.id, content: "v1" });
  const dir = s.createNode({ name: "子", type: "folder", parentId: root.id });
  const inner = s.createNode({ name: "b.txt", type: "file", parentId: dir.id, mime: "text/plain", size: 1 });
  s.saveBlob(inner.id, Buffer.from("B"));

  const snap = s.snapshotSubtree(root.id);
  assert.equal(snap.format, "dx-fs-subtree/v1");
  assert.equal(snap.rootId, root.id);
  assert.equal(snap.nodes.length, 3);
  assert.equal(Object.keys(snap.blobs).length, 1);

  const listing = [
    { name: "子", type: "folder", depth: 0 },
    { name: "b.txt", type: "file", depth: 1 },
    { name: "a.txt", type: "file", depth: 0 },
  ];
  assert.deepEqual(s.subtree(root.id), listing);

  // 改动：改内容、加文件、把快照里的子目录软删
  s.setContent(file.id, "v2");
  s.createNode({ name: "c.txt", type: "file", parentId: root.id, content: "C" });
  s.removeNode(dir.id);

  assert.equal(s.restoreSubtreeSnapshot(root.id, snap), 3);
  assert.equal(s.getNode(file.id).content, "v1");
  assert.equal(s.findByPath(root.id, "c.txt"), null);
  assert.ok(s.findByPath(root.id, "子/b.txt"));
  assert.deepEqual(s.readBlob(inner.id), Buffer.from("B"));
  assert.deepEqual(s.subtree(root.id), listing);
});

test("并发写冲突：Journal 基线过期 -> 409 FS_REVISION_CONFLICT（源 fs.ts:275-292、416-433）", () => {
  const dataDir = mkDir("dxos-fs-race-");
  const a = createDxosFs({ dataDir });
  const b = createDxosFs({ dataDir });
  const root = a.createNode({ name: "root", type: "folder", parentId: null });
  const plan = a.prepareFsArtifactBatchPlan(root.id, [{ path: "a.txt", kind: "text", content: "A", ownerId: "u1" }]);
  const base = a.getFsCommitState().revision;
  assert.equal(plan.baseRevision, base);

  // 另一实例先提交，版本前进
  b.createNode({ name: "b.txt", type: "file", parentId: root.id, content: "B" });
  assert.equal(b.getFsCommitState().revision, base + 1);
  assert.throws(
    () => a.publishFsArtifactBatchPlan(plan, "commit-1"),
    (e) => e.statusCode === 409 && e.code === "FS_REVISION_CONFLICT",
  );

  // 重新取基线后成功；同 commitId 重放走「已发布」校验而不重复写盘
  const plan2 = a.prepareFsArtifactBatchPlan(root.id, [{ path: "a.txt", kind: "text", content: "A", ownerId: "u1" }]);
  a.publishFsArtifactBatchPlan(plan2, "commit-2");
  const after1 = a.getFsCommitState();
  assert.equal(after1.revision, plan2.targetRevision);
  assert.equal(after1.lastCommitId, "commit-2");
  a.publishFsArtifactBatchPlan(plan2, "commit-2");
  assert.equal(a.getFsCommitState().revision, plan2.targetRevision);
  assert.equal(a.findByPath(root.id, "a.txt").content, "A");
});

test("系统根 / 用户固定目录 / 搜索 / 打包 / 存储统计（源 fs.ts:698-789、1163-1234、1264-1434）", () => {
  const s = mkStore();
  const root = s.createNode({ name: "proj", type: "folder", parentId: null, ownerId: "u1" });
  const docs = s.createNode({ name: "docs", type: "folder", parentId: root.id });
  s.createNode({ name: "readme.md", type: "file", parentId: docs.id, content: "hello DXOS world" });
  s.createNode({ name: "logo.png", type: "file", parentId: docs.id, mime: "image/png", size: 3 });

  // 搜索（源 fs.ts:1264-1313）
  assert.equal(s.searchNodes(root.id, "readme").length, 1);
  const contentHit = s.searchNodes(root.id, "dxos");
  assert.equal(contentHit.length, 1);
  assert.equal(contentHit[0].snippet.includes("DXOS"), true);
  assert.equal(s.searchNodes(root.id, "logo", { content: false }).length, 1);

  // 系统根 + 用户固定目录在隐藏根下，且面包屑不暴露系统目录（源 fs.ts:698-789、485-500）
  const sysRoot = s.ensureSystemRoot();
  const userFolder = s.ensureUserFolder("文稿", "u1");
  assert.equal(userFolder.parentId, sysRoot.id);
  assert.equal(s.ensureUserFolder("文稿", "u1").id, userFolder.id);
  assert.deepEqual(s.listChildren(userFolder.id).path, [{ id: userFolder.id, name: "文稿" }]);

  // 打包（源 fs.ts:1398-1434）
  const zip = s.collectZipEntries([docs.id]);
  assert.deepEqual(zip.map((e) => e.name), ["docs/readme.md", "docs/logo.png"]);
  assert.equal(zip[0].data.toString("utf8"), "hello DXOS world");

  // 存储统计（源 fs.ts:1163-1234）
  const report = s.storageReport({ u1: "用户一" });
  assert.ok(report.totalBytes >= 16);
  const child = s.storageChildren(root.id, { u1: "用户一" });
  assert.deepEqual(child.path, [{ id: null, name: "桌面" }, { id: root.id, name: "proj" }]);
  assert.equal(child.items.length, 1);

  // 子树计数 / 体积（源 fs.ts:1437-1451、1127-1144）
  assert.equal(s.countSubtree(root.id), 4);
  assert.ok(s.subtreeByteSize(root.id) >= 16);
});

test("数据目录来源：dxos-foundation-paths.cjs 的 directory.fs（B6b 新增登记）", () => {
  const userDataDir = mkDir("dxos-userdata-");
  const expected = resolveDxosFsDir(userDataDir);
  assert.equal(expected, path.join(resolveDxosPaths(userDataDir).root, "fs"));
  assert.equal(expected, path.join(userDataDir, "dxos", "fs"));

  const s = createDxosFs({ userDataDir });
  assert.equal(s.dataDir, expected);
  const root = s.createNode({ name: "x", type: "folder", parentId: null });
  assert.ok(fs.existsSync(path.join(expected, "fs.json")));
  assert.equal(s.getNode(root.id).name, "x");

  assert.equal(resolveFsDataDir({ userDataDir }), expected);
  assert.throws(() => createDxosFs({}), (e) => e.code === "FS_DATA_DIR_REQUIRED");
});
