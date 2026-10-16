// 文稿写入通道（files:writeText）：只允许 md/txt、1MB 上限、重名不覆盖、不能借道改写其它类型。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createFileService } = require("../electron/file-service.cjs");

const fresh = () => createFileService({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "oa-wt-")) });

test("新建补 .md、重名加后缀、覆盖写后可读回", () => {
  const f = fresh();
  const a = f.writeText("notes", "", "纪要", "# a");
  assert.equal(a.ok, true);
  assert.equal(a.entry.name, "纪要.md");
  assert.equal(f.writeText("notes", "", "纪要.md", "").entry.name, "纪要 2.md");
  assert.equal(f.writeText("notes", a.entry.id, "", "# b").ok, true);
  assert.equal(f.read("notes", a.entry.id).text, "# b");
});

test("拒绝：非法文件夹、不存在条目、非文本条目、超限", () => {
  const f = fresh();
  assert.equal(f.writeText("../x", "", "a", "").error, "INVALID_INPUT");
  assert.equal(f.writeText("notes", "nope", "", "").error, "NOT_FOUND");
  const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oa-src-")), "p.png");
  fs.writeFileSync(src, "png");
  const img = f.importPaths("notes", [src]).added[0];
  assert.equal(f.writeText("notes", img.id, "", "x").error, "UNSUPPORTED");
  assert.equal(f.writeText("notes", "", "big", "x".repeat(1024 * 1024 + 1)).error, "TOO_LARGE");
});
