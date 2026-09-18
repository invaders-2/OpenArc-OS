/**
 * 桌面虚拟文件夹 · 系统回收站语义单测（electron/folder-trash.cjs 纯逻辑 +
 * file-service.cjs 的 groupId 分组），并覆盖任务要求的边界：
 *   · 嵌套子树整棵进回收站
 *   · 恢复回原位与原名称
 *   · 重名自动改名（不覆盖、不丢）
 *   · 父级已被删 → 归到桌面根
 *   · 组内多文件一起恢复 / 一起永久删除
 *   · 回收站分区：文件夹 / 文件 / 来自资源库（空资源 → 不出现该分区）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const folderTrash = require("../electron/folder-trash.cjs");
const { createFileService } = require("../electron/file-service.cjs");

const F = (id, name, parentId, x = 10, y = 20) => (parentId ? { id, name, parentId, x, y } : { id, name, x, y });

test("collectSubtree: 收集整棵嵌套子树（父先于子），不包含无关兄弟", () => {
  const folders = [
    F("a", "项目"),
    F("b", "子一", "a"),
    F("c", "孙", "b"),
    F("d", "兄弟"),
    F("e", "别人的孩子", "d"),
  ];
  assert.deepEqual(folderTrash.collectSubtree(folders, "a").map((f) => f.id), ["a", "b", "c"]);
  assert.deepEqual(folderTrash.collectSubtree(folders, "d").map((f) => f.id), ["d", "e"]);
  assert.deepEqual(folderTrash.collectSubtree(folders, "nope"), []);
});

test("buildFolderTrashRecord: 记录根名 / 删除时间 / 整棵子树；根不存在返回 null", () => {
  const folders = [F("a", "项目"), F("b", "子一", "a")];
  const rec = folderTrash.buildFolderTrashRecord({ folders, rootId: "a", groupId: "g1", deletedAt: 123 });
  assert.equal(rec.groupId, "g1");
  assert.equal(rec.rootId, "a");
  assert.equal(rec.name, "项目");
  assert.equal(rec.deletedAt, 123);
  assert.deepEqual(rec.folders.map((f) => f.id), ["a", "b"]);
  assert.deepEqual(rec.folders[1].parentId, "a");
  assert.equal(folderTrash.buildFolderTrashRecord({ folders, rootId: "ghost", groupId: "g2" }), null);
});

test("planFolderRestore: 父级还在 → 原位、原名称、原坐标", () => {
  const existing = [F("p", "父级")];
  const rec = { groupId: "g1", rootId: "a", name: "项目", deletedAt: 1, folders: [F("a", "项目", "p", 33, 44)] };
  const plan = folderTrash.planFolderRestore(rec, existing);
  assert.equal(plan.reparented, 0);
  assert.equal(plan.renamed, 0);
  assert.deepEqual(plan.added, [{ id: "a", name: "项目", x: 33, y: 44, parentId: "p" }]);
});

test("planFolderRestore: 父级已被删 → 归到桌面根（省略 parentId），并计数", () => {
  const rec = {
    groupId: "g1",
    rootId: "a",
    name: "项目",
    deletedAt: 1,
    folders: [F("a", "项目", "gone"), F("b", "子一", "a")],
  };
  const plan = folderTrash.planFolderRestore(rec, []);
  assert.equal(plan.reparented, 1, "根的原父级不存在，应归到桌面根");
  assert.equal(plan.added[0].parentId, undefined);
  assert.equal(plan.added[0].name, "项目");
  assert.equal(plan.added[1].parentId, "a", "子级的父级在恢复集合里，应保持原位");
});

test("planFolderRestore: 同父级重名 → 自动加 ' 2' / ' 3'（不覆盖）", () => {
  const existing = [F("x", "项目"), F("y", "项目 2")];
  const rec = { groupId: "g1", rootId: "a", name: "项目", deletedAt: 1, folders: [F("a", "项目")] };
  const plan = folderTrash.planFolderRestore(rec, existing);
  assert.equal(plan.renamed, 1);
  assert.equal(plan.added[0].name, "项目 3");
});

test("planFolderRestore: 多条记录连续恢复时，后者能看到前者（不会撞名）", () => {
  let working = [];
  const r1 = { groupId: "g1", rootId: "a", name: "项目", deletedAt: 1, folders: [F("a", "项目")] };
  const r2 = { groupId: "g2", rootId: "b", name: "项目", deletedAt: 2, folders: [F("b", "项目")] };
  working = [...working, ...folderTrash.planFolderRestore(r1, working).added];
  working = [...working, ...folderTrash.planFolderRestore(r2, working).added];
  assert.deepEqual(working.map((f) => f.name), ["项目", "项目 2"]);
});

test("buildTrashSections: 文件夹独立成条、组内文件隐藏、普通文件保留、资源分区透传", () => {
  const folderRecords = [{ groupId: "g1", rootId: "a", name: "项目", deletedAt: 5, folders: [F("a", "项目")] }];
  const fileEntries = [
    { id: "t1", name: "a.txt", ext: "txt", size: 1, mtime: 1, groupId: "g1" },
    { id: "t2", name: "b.txt", ext: "txt", size: 1, mtime: 2 },
  ];
  const s = folderTrash.buildTrashSections({ fileEntries, folderRecords, resourceItems: [] });
  assert.equal(s.folders.length, 1);
  assert.equal(s.folders[0].fileCount, 1);
  assert.deepEqual(s.files.map((e) => e.id), ["t2"], "组内文件不应再单独出现");
  assert.equal(s.resources.length, 0, "没有已授权资源 → 不出现资源分区");
  assert.equal(s.isEmpty, false);
  assert.deepEqual(folderTrash.trashIdsOfGroup(fileEntries, "g1"), ["t1"]);
});

test("buildTrashSections: 孤儿组（记录已丢）仍作为文件显示，不会'看不见但没释放'", () => {
  const fileEntries = [{ id: "t9", name: "x.txt", ext: "txt", size: 1, mtime: 1, groupId: "gGone" }];
  const s = folderTrash.buildTrashSections({ fileEntries, folderRecords: [], resourceItems: [] });
  assert.deepEqual(s.files.map((e) => e.id), ["t9"]);
  assert.equal(s.folders.length, 0);
});

test("buildTrashSections: 全空时 isEmpty=true；仅资源时也非空", () => {
  assert.equal(folderTrash.buildTrashSections({}).isEmpty, true);
  const s = folderTrash.buildTrashSections({ resourceItems: [{ resourceRef: "res:1", name: "记忆" }] });
  assert.equal(s.isEmpty, false);
  assert.equal(s.resources.length, 1);
});

test("file-service: groupId 落进回收站索引；组内多文件可整体恢复", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-folder-trash-"));
  const svc = createFileService({ userDataDir: dir });
  const stage = fs.mkdtempSync(path.join(dir, "stage-"));
  const a = path.join(stage, "a.txt");
  const b = path.join(stage, "b.txt");
  fs.writeFileSync(a, "A");
  fs.writeFileSync(b, "B");
  const ea = svc.importPaths("fld1", [a]).added[0];
  const eb = svc.importPaths("fld1", [b]).added[0];
  const groupId = "gTest01";
  assert.equal(svc.trash("fld1", ea.id, groupId).ok, true);
  assert.equal(svc.trash("fld1", eb.id, groupId).ok, true);
  assert.deepEqual(svc.list("fld1").entries, []);

  const entries = svc.listTrash().entries;
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.groupId === groupId));
  const ids = folderTrash.trashIdsOfGroup(entries, groupId);
  assert.equal(ids.length, 2);

  // 组内整体恢复
  for (const id of ids) assert.equal(svc.restore(id).ok, true);
  assert.deepEqual(svc.list("fld1").entries.map((e) => e.name).sort(), ["a.txt", "b.txt"]);
  assert.deepEqual(svc.listTrash().entries, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file-service: 非法 groupId 被丢弃（不会写进索引）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-folder-trash-"));
  const svc = createFileService({ userDataDir: dir });
  const stage = fs.mkdtempSync(path.join(dir, "stage-"));
  const p = path.join(stage, "a.txt");
  fs.writeFileSync(p, "A");
  const e = svc.importPaths("fld1", [p]).added[0];
  assert.equal(svc.trash("fld1", e.id, "../../evil").ok, true);
  const entry = svc.listTrash().entries[0];
  assert.equal("groupId" in entry, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
