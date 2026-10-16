/**
 * 随包技能包机制测试（全离线：临时目录 + 真实 resources/ 目录，不联网、不执行包内文件）。
 *
 * 覆盖任务书验收点：
 *   ① 随包目录为空 → 有效空态（列出为空、导入结构化 NOT_FOUND），不是错误；
 *   ② 放入自建示例包 → 可被列出、可被导入（包级 importBundledSkillPack + 技能级 importSkillPackage）；
 *   ③ 非法包（非 ZIP / 缺 SKILL.md）→ 结构化拒绝；
 *   ④ 越界包名 / 非文件 → 结构化拒绝；
 *   ⑤ 扫描优先级：显式注入 bundledDir > 环境变量 > <应用根>/resources/bundled-skill-packages。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const skillPack = require("../electron/skill-pack.cjs");
const skillImport = require("../electron/skill-import.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_DIR = path.join(ROOT, "resources", "bundled-skill-packages");
const EXAMPLE_ZIP = path.join(BUNDLED_DIR, "dxos-example-bundle.zip");

const tmpDirs = [];
afterEach(() => {
  skillPack.resetSkillPackForTests();
  skillImport.resetSkillImportForTests();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});
function tempDir(prefix = "dxos-bundled-") { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(dir); return dir; }

test("随包目录为空：列出为空数组、导入结构化 NOT_FOUND（有效空态，不是错误）", () => {
  const emptyDir = path.join(tempDir(), "bundled-skill-packages");
  fs.mkdirSync(emptyDir, { recursive: true });
  const emptyApp = path.join(tempDir(), "app");
  fs.mkdirSync(emptyApp, { recursive: true });
  skillPack.configureSkillPack({ userDataDir: tempDir(), bundledDir: emptyDir, appDir: emptyApp });

  assert.deepEqual(skillPack.listBundledSkillPackages(), []);
  assert.throws(() => skillPack.importBundledSkillPack("does-not-exist"), (error) => error.kind === "SKILL_PACK_FAILED" && error.reason === "NOT_FOUND");
  assert.throws(() => skillPack.resolveBundledSkillPackage("does-not-exist"), (error) => error.reason === "NOT_FOUND");
});

test("自建示例包：可被列出、可读、可导入为本地技能包", () => {
  assert.ok(fs.existsSync(EXAMPLE_ZIP), "示例包必须随仓存在：" + EXAMPLE_ZIP);
  const userDataDir = tempDir();
  skillPack.configureSkillPack({ userDataDir });

  const listed = skillPack.listBundledSkillPackages();
  const entry = listed.find((item) => item.name === "dxos-example-bundle.zip");
  assert.ok(entry, "示例包应出现在随包列表：" + JSON.stringify(listed));
  assert.ok(entry.bytes > 0);
  assert.ok(entry.directory.startsWith(path.join(ROOT, "resources")));

  const buffer = skillPack.readBundledSkillPackage("dxos-example-bundle");
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.equals(fs.readFileSync(EXAMPLE_ZIP)));

  const imported = skillPack.importBundledSkillPack("dxos-example-bundle");
  assert.equal(imported.skillCount, 1, "示例包应含 1 个 SKILL.md");
  assert.equal(imported.name, "dxos example bundle");
  assert.equal(imported.bundledPath, EXAMPLE_ZIP);
  const packs = skillPack.listSkillPacks();
  assert.equal(packs.length, 1);
  assert.equal(packs[0].skillCount, 1);
  assert.ok(fs.existsSync(path.join(userDataDir, "dxos", "skill-packs", imported.id, "source", "SKILL.md")));
});

test("自建示例包：走标准导入路径 skillImport.importSkillPackage 也能解析", () => {
  const saved = [];
  skillImport.configureSkillImport({ skillStore: { saveCustomSkill: (skill) => { saved.push(skill); return skill; } } });
  const result = skillImport.importSkillPackage(skillPack.readBundledSkillPackage("dxos-example-bundle"));
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, "随包示例技能包");
  assert.equal(result.skills[0].id, "dxos-example-bundle");
  assert.equal(saved.length, 1);
  assert.match(result.skills[0].systemPrompt, /随包示例技能/);
});

test("扫描优先级：显式注入的 bundledDir 先于 <应用根>/resources", () => {
  const dir = tempDir();
  fs.copyFileSync(EXAMPLE_ZIP, path.join(dir, "dxos-example-bundle.zip"));
  skillPack.configureSkillPack({ userDataDir: tempDir(), bundledDir: dir });
  const entry = skillPack.listBundledSkillPackages().find((item) => item.name === "dxos-example-bundle.zip");
  assert.ok(entry);
  assert.equal(entry.directory, dir, "同名包应命中显式注入目录");
  assert.ok(skillPack.bundledPackageDirs()[0] === dir);
});

test("非法包：非 ZIP 结构化 INVALID_ZIP；缺 SKILL.md 结构化拒绝", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "bad.zip"), "this is not a zip", "utf8");
  skillPack.configureSkillPack({ userDataDir: tempDir(), bundledDir: dir, appDir: path.join(tempDir(), "app") });
  assert.throws(() => skillPack.importBundledSkillPack("bad"), (error) => error.kind === "SKILL_PACK_FAILED" && error.reason === "INVALID_ZIP");

  // 合法 ZIP 但没有 SKILL.md → 随包导入结构化拒绝
  const noSkillZip = skillImport.buildZip([{ name: "readme.txt", data: Buffer.from("no skill here") }]);
  const dir2 = tempDir();
  fs.writeFileSync(path.join(dir2, "noskill.zip"), noSkillZip);
  skillPack.configureSkillPack({ userDataDir: tempDir(), bundledDir: dir2, appDir: path.join(tempDir(), "app") });
  assert.throws(() => skillPack.importBundledSkillPack("noskill"), (error) => error.reason === "NO_SKILL_FOUND");
});

test("越界包名 / 非文件：结构化拒绝，不越界读取", () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "dirpkg.zip"), { recursive: true });
  skillPack.configureSkillPack({ userDataDir: tempDir(), bundledDir: dir });

  for (const name of ["../evil", "..", "/etc/passwd", "a/b", "a\\b", ""]) {
    assert.throws(() => skillPack.resolveBundledSkillPackage(name), (error) => error.kind === "SKILL_PACK_FAILED" && (error.reason === "UNSAFE_PATH" || error.reason === "EMPTY_NAME"), "应拒绝包名：" + JSON.stringify(name));
  }
  // 目录不是文件：既不被列出，也不能解析
  assert.equal(skillPack.listBundledSkillPackages().some((item) => item.name === "dirpkg.zip"), false);
  assert.throws(() => skillPack.resolveBundledSkillPackage("dirpkg"), (error) => error.reason === "NOT_FOUND");
});
