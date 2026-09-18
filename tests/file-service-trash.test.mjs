/**
 * 系统级回收站（file-service.cjs 软删除）语义单测。
 *
 * 覆盖：移入 / 列出 / 恢复（含重名、原文件夹不存在、原 id 复用）/ 永久删除 / 清空 /
 *       索引原子性（无 .tmp 残留、坏索引不崩）/ 非法 folderId 与路径穿越拒绝 /
 *       remove 仍然是永久删除（不进回收站）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createFileService } = require("../electron/file-service.cjs");

/** 每个用例一个独立 userData，互不污染。 */
const fresh = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-trash-"));
  const svc = createFileService({ userDataDir: dir });
  return { dir, svc, root: path.join(dir, "files"), trashDir: path.join(dir, "files", ".trash") };
};

const importFile = (dir, svc, folderId, name, body = "hello world") => {
  // 放到一个独立暂存目录，让 basename 恰好是 name（importPaths 用 basename 当条目名）
  const stage = fs.mkdtempSync(path.join(dir, "stage-"));
  const src = path.join(stage, name);
  fs.writeFileSync(src, body);
  const res = svc.importPaths(folderId, [src]);
  assert.equal(res.ok, true);
  assert.equal(res.added.length, 1);
  return res.added[0];
};

const readTrashIndex = (trashDir) => JSON.parse(fs.readFileSync(path.join(trashDir, "index.json"), "utf8")).entries;

test("trash: 移入回收站后原文件夹清空，物理文件搬到 .trash 且内容不变", () => {
  const { dir, svc, root, trashDir } = fresh();
  const entry = importFile(dir, svc, "desktop", "hello.txt");
  const phys = path.join(root, "desktop", entry.file);
  assert.equal(fs.existsSync(phys), true, "前提：导入后物理文件在桌面文件夹");

  const res = svc.trash("desktop", entry.id);
  assert.equal(res.ok, true);
  assert.equal(typeof res.trashId, "string");
  assert.deepEqual(svc.list("desktop").entries, [], "原文件夹索引应清空");
  assert.equal(fs.existsSync(phys), false, "原物理文件应被搬走");

  const trash = svc.listTrash();
  assert.equal(trash.ok, true);
  assert.equal(trash.entries.length, 1);
  const t = trash.entries[0];
  assert.equal(t.id, res.trashId);
  assert.equal(t.origId, entry.id);
  assert.equal(t.folderId, "desktop");
  assert.equal(t.name, "hello.txt");
  assert.equal(typeof t.deletedAt, "number");

  const moved = fs.readdirSync(trashDir).filter((f) => f !== "index.json");
  assert.equal(moved.length, 1, "回收站目录里应有且仅有一个物理文件");
  assert.equal(fs.readFileSync(path.join(trashDir, moved[0]), "utf8"), "hello world");

  assert.equal(fs.existsSync(path.join(trashDir, "index.json.tmp")), false, "索引不得残留 .tmp");
  assert.equal(readTrashIndex(trashDir).length, 1);
});

test("trash: listTrash 按删除时间倒序", async () => {
  const { dir, svc } = fresh();
  const a = importFile(dir, svc, "desktop", "a.txt");
  const b = importFile(dir, svc, "desktop", "b.txt");
  svc.trash("desktop", a.id);
  await new Promise((r) => setTimeout(r, 5));
  svc.trash("desktop", b.id);
  const list = svc.listTrash().entries;
  assert.deepEqual(list.map((e) => e.name), ["b.txt", "a.txt"]);
});

test("restore: 回到原文件夹并复用原 id（桌面图标位置不跳）", () => {
  const { dir, svc, root } = fresh();
  const entry = importFile(dir, svc, "desktop", "photo.png", "PNGDATA");
  const { trashId } = svc.trash("desktop", entry.id);

  const res = svc.restore(trashId);
  assert.equal(res.ok, true);
  assert.equal(res.folderId, "desktop");
  assert.equal(res.recreated, false);
  assert.equal(res.id, entry.id, "原 id 空闲时应复用");
  const back = svc.list("desktop").entries;
  assert.equal(back.length, 1);
  assert.equal(back[0].id, entry.id);
  assert.equal(back[0].name, "photo.png");
  assert.equal(fs.readFileSync(path.join(root, "desktop", back[0].file), "utf8"), "PNGDATA");
  assert.deepEqual(svc.listTrash().entries, []);
});

test("restore: 原文件夹已有同名条目时自动改名（不覆盖）", () => {
  const { dir, svc } = fresh();
  const first = importFile(dir, svc, "docs", "notes.txt", "v1");
  const { trashId } = svc.trash("docs", first.id);
  const second = importFile(dir, svc, "docs", "notes.txt", "v2");

  const res = svc.restore(trashId);
  assert.equal(res.ok, true);
  const names = svc.list("docs").entries.map((e) => e.name).sort();
  assert.deepEqual(names, ["notes 2.txt", "notes.txt"]);
  const restored = svc.list("docs").entries.find((e) => e.id === res.id);
  assert.equal(restored.name, "notes 2.txt");
  assert.notEqual(restored.id, second.id);
  assert.equal(svc.resolve("docs", restored.id).path.endsWith(".txt"), true);
});

test("restore: 原文件夹已不存在时重建它并报告 recreated", () => {
  const { dir, svc, root } = fresh();
  const entry = importFile(dir, svc, "gone", "orphan.md", "# orphan");
  const { trashId } = svc.trash("gone", entry.id);
  // 模拟"原文件夹已不存在"：直接删掉它的存储目录
  fs.rmSync(path.join(root, "gone"), { recursive: true, force: true });
  assert.equal(fs.existsSync(path.join(root, "gone")), false);

  const res = svc.restore(trashId);
  assert.equal(res.ok, true);
  assert.equal(res.folderId, "gone");
  assert.equal(res.recreated, true);
  const back = svc.list("gone").entries;
  assert.equal(back.length, 1);
  assert.equal(fs.readFileSync(svc.resolve("gone", back[0].id).path, "utf8"), "# orphan");
});

test("restore: 找不到条目时 NOT_FOUND，不误删任何东西", () => {
  const { svc } = fresh();
  assert.deepEqual(svc.restore("tNotExist"), { ok: false, error: "NOT_FOUND" });
});

test("purge: 只删选中的一条，物理文件一并删除", () => {
  const { dir, svc, trashDir } = fresh();
  const a = importFile(dir, svc, "desktop", "a.txt");
  const b = importFile(dir, svc, "desktop", "b.txt");
  const ta = svc.trash("desktop", a.id).trashId;
  const tb = svc.trash("desktop", b.id).trashId;

  const res = svc.purge(ta);
  assert.equal(res.ok, true);
  assert.deepEqual(svc.listTrash().entries.map((e) => e.id), [tb]);
  const phys = fs.readdirSync(trashDir).filter((f) => f !== "index.json");
  assert.equal(phys.length, 1, "只剩另一条的物理文件");

  assert.deepEqual(svc.purge("tNotExist"), { ok: false, error: "NOT_FOUND" });
});

test("empty: 清空回收站，索引与物理文件都清干净", () => {
  const { dir, svc, trashDir } = fresh();
  svc.trash("desktop", importFile(dir, svc, "desktop", "a.txt").id);
  svc.trash("desktop", importFile(dir, svc, "desktop", "b.txt").id);
  const res = svc.empty();
  assert.equal(res.ok, true);
  assert.equal(res.removed, 2);
  assert.deepEqual(svc.listTrash().entries, []);
  assert.deepEqual(fs.readdirSync(trashDir), ["index.json"]);
});

test("原子性/健壮性: 索引坏掉时 listTrash 返回空而不是抛错", () => {
  const { dir, svc, trashDir } = fresh();
  svc.trash("desktop", importFile(dir, svc, "desktop", "a.txt").id);
  fs.writeFileSync(path.join(trashDir, "index.json"), "{ 这不是 JSON");
  const list = svc.listTrash();
  assert.equal(list.ok, true);
  assert.deepEqual(list.entries, []);
  // 坏索引之后仍可继续用：下一次 trash 会重建索引
  const another = importFile(dir, svc, "desktop", "b.txt");
  assert.equal(svc.trash("desktop", another.id).ok, true);
  assert.equal(svc.listTrash().entries.length, 1);
  assert.equal(fs.existsSync(path.join(trashDir, "index.json.tmp")), false);
});

test("安全: 非法 folderId / 保留目录 / 路径穿越全部拒绝", () => {
  const { dir, svc, root, trashDir } = fresh();
  const entry = importFile(dir, svc, "desktop", "safe.txt");
  svc.trash("desktop", entry.id);
  const [trashEntry] = svc.listTrash().entries;

  // folderId 白名单：点号、斜杠、.. 都不行
  assert.deepEqual(svc.trash("../evil", entry.id), { ok: false, error: "INVALID_INPUT" });
  assert.deepEqual(svc.trash(".trash", entry.id), { ok: false, error: "INVALID_INPUT" });
  assert.deepEqual(svc.list(".trash"), { ok: false, error: "INVALID_INPUT" });
  assert.deepEqual(svc.list("../../etc"), { ok: false, error: "INVALID_INPUT" });
  // id 穿越：purdge/restore 只认索引里记录的 id
  assert.deepEqual(svc.purge("../../etc/passwd"), { ok: false, error: "INVALID_INPUT" });
  assert.deepEqual(svc.restore("../etc"), { ok: false, error: "INVALID_INPUT" });
  assert.deepEqual(svc.trash("desktop", "../../etc/passwd"), { ok: false, error: "NOT_FOUND" });
  // 回收站目录外的文件没有被前三条调用碰到
  assert.equal(svc.listTrash().entries.length, 1);
  assert.equal(svc.listTrash().entries[0].id, trashEntry.id);
  assert.equal(fs.existsSync(path.join(root, "..", "evil")), false);
  assert.equal(fs.readdirSync(trashDir).includes("index.json"), true);
});

test("remove 保持不变: 仍是永久删除，不产生回收站条目", () => {
  const { dir, svc, root, trashDir } = fresh();
  const entry = importFile(dir, svc, "desktop", "bye.txt");
  const res = svc.remove("desktop", entry.id);
  assert.equal(res.ok, true);
  assert.deepEqual(svc.listTrash().entries, [], "remove 不应进回收站");
  assert.equal(fs.existsSync(path.join(root, "desktop", entry.file)), false);
  assert.deepEqual(fs.readdirSync(trashDir), [], "回收站目录应保持空（无 index.json 也无物理文件）");
});
