/**
 * B6b · fsAdapter 契约测试（按 B3 / B4 / B5 调用方的真实用法，全离线）。
 *
 * 形状来源：
 *   · agent-runtime-workspace.cjs:17-33 契约头 + :71/84/115/143/155-159/238/257/271/359-433/388-428
 *   · agent-builtin-tools.cjs:125-334
 *   · agent-project-snapshot.cjs:24-51
 *   · skill-runner.cjs:527-571、674-690
 *   · agent-task-store.cjs:31、1553
 *   （canvas-dxos-agent-attachments.cjs 全文未引用 fsAdapter，故无对应用例。）
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDxosFsAdapter } = require("../electron/dxos-fs-adapter.cjs");

const dirs = [];
const FIXED_MS = 1700000000000;
after(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

function mkDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || "dxos-fs-adapter-"));
  dirs.push(dir);
  return dir;
}

function mkAdapter(dataDir) {
  return createDxosFsAdapter({ dataDir: dataDir || mkDir(), clock: () => FIXED_MS });
}

/** agent-runtime-workspace.cjs:17-33 契约头 + 五个调用方实际用到的字段并集。 */
const CONTRACT = [
  "getNode", "listChildren", "findByPath", "isWithinRoot", "readBlob",
  "getFsRevision", "getFsCommitState", "ensureSystemRoot", "ensureFolder",
  "createNode", "resolvePath", "copyNode", "renameNode", "moveNode",
  "removeNode", "setContent", "saveBlob", "stageContentAddressedBlob",
  "prepareFsArtifactBatchPlan", "serializeFsArtifactBatchPlan",
  "publishFsArtifactBatchPlan", "collectOrphanContentBlobs",
];

test("契约面：调用方用到的字段全部存在且可空调用安全", () => {
  const a = mkAdapter();
  for (const key of CONTRACT) assert.equal(typeof a[key], "function", "缺少 fsAdapter." + key);
  assert.equal(a.getNode("missing"), null);
  assert.equal(a.findByPath("missing-root", "a.txt"), null);
  assert.equal(a.readBlob("missing"), null);
  assert.equal(a.isWithinRoot("x", "y"), false);
});

test("B3 用法：workspace 建树 / findByPath / isWithinRoot / copyNode（agent-runtime-workspace.cjs:135-159、238、257-263）", () => {
  const a = mkAdapter();
  const sysRoot = a.ensureSystemRoot();
  const container = a.ensureFolder(".agent-workspaces", sysRoot.id);
  assert.equal(typeof container, "string"); // 源 fs.ts:685-691 返回 id，调用方 :156-158 直接当 parentId
  const userContainer = a.ensureFolder("u1", container, "u1");
  const workspaceRoot = a.createNode({ name: "run1", type: "folder", parentId: userContainer, ownerId: "u1" });

  const file = a.createNode({ name: "a.txt", type: "file", parentId: workspaceRoot.id, content: "v1" });
  assert.equal(a.findByPath(workspaceRoot.id, "a.txt").id, file.id);
  assert.equal(a.listChildren(workspaceRoot.id).nodes.length, 1);
  assert.equal(a.isWithinRoot(workspaceRoot.id, file.id), true);
  assert.equal(a.isWithinRoot(workspaceRoot.id, sysRoot.id), false);

  // workspaceStore 的 manifest 依赖 node.content / node.updated_ts（agent-runtime-workspace.cjs:68-77）
  const node = a.findByPath(workspaceRoot.id, "a.txt");
  assert.equal(typeof node.updated_ts, "number");
  assert.equal(createHash("sha256").update(Buffer.from(node.content, "utf8")).digest("hex").length, 64);

  // copyNode：把源项目节点复制进 workspace 根（agent-runtime-workspace.cjs:159）
  const copy = a.copyNode(file.id, userContainer);
  assert.equal(a.findByPath(userContainer, "a.txt").id, copy.id);

  // builtin-tools 的 rename / setContent / move / remove 一致（agent-builtin-tools.cjs:287-334）
  assert.equal(a.renameNode(copy.id, "b.txt").name, "b.txt");
  assert.equal(a.setContent(copy.id, "v2").content, "v2");
  assert.equal(a.moveNode(copy.id, workspaceRoot.id).parentId, workspaceRoot.id);
  assert.equal(a.removeNode(copy.id), 1);
  assert.equal(a.findByPath(workspaceRoot.id, "b.txt"), null);
});

test("B3 用法：内容寻址 blob + Journal 计划序列化 / 发布 / 提交状态（agent-runtime-workspace.cjs:359-433）", () => {
  const a = mkAdapter();
  const root = a.createNode({ name: "proj", type: "folder", parentId: null, ownerId: "u1" });
  const bytes = Buffer.from("BINARY-PAYLOAD");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const staged = a.stageContentAddressedBlob(bytes, sha);
  assert.equal(staged.sha256, sha);

  const state0 = a.getFsCommitState();
  const plan = a.prepareFsArtifactBatchPlan(root.id, [
    { path: "notes/a.txt", kind: "text", content: "hello", ownerId: "u1" },
    { path: "assets/a.bin", kind: "binary", blobSha256: sha, mime: "application/octet-stream", bytes: bytes.length, ownerId: "u1" },
  ]);
  assert.equal(plan.baseRevision, state0.revision);
  assert.equal(plan.targetRevision, state0.revision + 1);

  const record = a.serializeFsArtifactBatchPlan(plan);
  assert.equal("targetNodes" in record, false);
  assert.equal(typeof record.resultNodeIds["notes/a.txt"], "string");

  a.publishFsArtifactBatchPlan(plan, "commit-1");
  const state1 = a.getFsCommitState();
  assert.equal(state1.revision, plan.targetRevision);
  assert.equal(state1.lastCommitId, "commit-1");
  assert.equal(a.findByPath(root.id, "notes/a.txt").content, "hello");
  const binary = a.findByPath(root.id, "assets/a.bin");
  assert.equal(binary.blobSha256, sha);
  assert.deepEqual(a.readBlob(binary.id), bytes);

  // 孤儿收集 dryRun 不改盘（源 fs.ts:437-459）
  const orphan = a.collectOrphanContentBlobs({ dryRun: true, minAgeMs: 0 });
  assert.deepEqual(orphan.deleted, []);
  assert.deepEqual(orphan.candidates, []);
});

test("B4 用法：resolvePath / ensureFolder(id) / createNode(mime,size) / saveBlob（skill-runner.cjs:527-571、674-690）", () => {
  const a = mkAdapter();
  const resolved = a.resolvePath(null, "角色/苏离.png", true);
  assert.equal(resolved.leaf, "苏离.png");
  assert.equal(typeof resolved.parentId, "string");
  assert.equal(a.findByPath(null, "角色/苏离.png"), null); // 中间目录已建，叶子还没建

  const bytes = Buffer.from("IMGBYTES");
  const node = a.createNode({ name: resolved.leaf, type: "file", parentId: resolved.parentId, mime: "image/png", size: bytes.length });
  assert.equal(node.content, undefined); // 上传型节点不写内联内容（源 fs.ts:583-596）
  a.saveBlob(node.id, bytes);
  assert.deepEqual(a.readBlob(node.id), bytes);
  assert.equal(a.getNode(node.id).mime, "image/png");

  // 无 path 时落到 ensureFolder("生成图片", rootId)（skill-runner.cjs:541）
  const generated = a.ensureFolder("生成图片", null);
  assert.equal(typeof generated, "string");
  const img = a.createNode({ name: "img_1.png", type: "file", parentId: generated, mime: "image/png", size: 1 });
  a.saveBlob(img.id, Buffer.from("x"));
  assert.ok(a.findByPath(null, "生成图片/img_1.png"));

  // 越界路径拒绝（源 fs.ts:642-660 硬化）
  assert.throws(() => a.resolvePath(null, "../etc/passwd", true), (e) => e.code === "FS_PATH_ESCAPE");
});

test("B4 用法：project snapshot 的 createNode/findByPath/getNode/setContent（agent-project-snapshot.cjs:24-51）", () => {
  const a = mkAdapter();
  const project = a.createNode({ name: "proj", type: "folder", parentId: null });
  assert.equal(a.findByPath(project.id, ".ccs-ai"), null);
  const dir = a.createNode({ name: ".ccs-ai", type: "folder", parentId: project.id });
  assert.equal(a.findByPath(project.id, ".ccs-ai").id, dir.id);
  assert.equal(a.getNode(project.id).id, project.id);
  const file = a.createNode({ name: "snapshot.json", type: "file", parentId: dir.id, content: "{}" });
  assert.equal(a.setContent(file.id, '{"v":1}').content, '{"v":1}');
});

test("并发提交冲突：透传 statusCode 409 / code FS_REVISION_CONFLICT", () => {
  const dataDir = mkDir("dxos-fs-adapter-race-");
  const a = mkAdapter(dataDir);
  const b = mkAdapter(dataDir);
  const root = a.createNode({ name: "root", type: "folder", parentId: null });
  const plan = a.prepareFsArtifactBatchPlan(root.id, [{ path: "a.txt", kind: "text", content: "A", ownerId: "u1" }]);
  b.createNode({ name: "b.txt", type: "file", parentId: root.id, content: "B" });
  assert.throws(
    () => a.publishFsArtifactBatchPlan(plan, "c1"),
    (e) => e.statusCode === 409 && e.code === "FS_REVISION_CONFLICT",
  );
  const plan2 = a.prepareFsArtifactBatchPlan(root.id, [{ path: "a.txt", kind: "text", content: "A", ownerId: "u1" }]);
  a.publishFsArtifactBatchPlan(plan2, "c2");
  assert.equal(a.getFsCommitState().lastCommitId, "c2");
});

test("非契约 escape hatch：adapter.store 暴露回收站/快照/共享盘源函数；clock 注入决定时间戳", () => {
  const a = mkAdapter();
  assert.equal(typeof a.store.snapshotSubtree, "function");
  assert.equal(typeof a.store.listTrash, "function");
  assert.equal(typeof a.store.ensurePublicRoot, "function");
  const root = a.createNode({ name: "proj", type: "folder", parentId: null });
  assert.equal(a.getNode(root.id).created_ts, Math.floor(FIXED_MS / 1000));
  const snap = a.store.snapshotSubtree(root.id);
  assert.equal(snap.format, "dx-fs-subtree/v1");
  assert.equal(snap.createdAt, FIXED_MS);
});
