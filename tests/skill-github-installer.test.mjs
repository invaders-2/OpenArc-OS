import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSkillGithubInstaller, parseGithubRepository, MAX_ARCHIVE_BYTES } = require("../electron/skill-github-installer.cjs");
const skillImport = require("../electron/skill-import.cjs");
const skillPack = require("../electron/skill-pack.cjs");
const skillStore = require("../electron/skill-store.cjs");
const skillRunner = require("../electron/skill-runner.cjs");
const skillAnalyzer = require("../electron/skill-analyzer.cjs");
const skillWorkspace = require("../electron/skill-workspace.cjs");
const { createSkillBundle } = require("../electron/skill-service.cjs");

const dirs = [];
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
afterEach(() => {
  skillStore.resetSkillStoreForTests();
  skillImport.resetSkillImportForTests();
  skillPack.resetSkillPackForTests();
  skillRunner.resetSkillRunnerForTests();
  skillAnalyzer.resetSkillAnalyzerForTests();
  skillWorkspace.resetSkillWorkspaceForTests();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}
function archive(entries = []) {
  return skillImport.buildZip(entries.length ? entries : [
    { name: "repo-commit/SKILL.md", data: Buffer.from("---\nname: Demo Skill\ndescription: 从仓库导入\n---\n只读取输入并输出摘要") },
    { name: "repo-commit/scripts/setup.py", data: Buffer.from("print('not executed')") },
    { name: "repo-commit/package.json", data: Buffer.from('{"scripts":{"postinstall":"do-not-run"}}') },
    { name: "repo-commit/node_modules/ignored/SKILL.md", data: Buffer.from("ignored") },
  ]);
}
function githubFetch(bytes, calls = []) {
  return async (url) => {
    calls.push(url);
    if (url.endsWith("/repos/owner/repo")) return response(JSON.stringify({ default_branch: "main" }));
    if (url.includes("/commits/main")) return response(JSON.stringify({ sha: COMMIT }));
    if (url.startsWith("https://codeload.github.com/owner/repo/zip/")) return response(bytes);
    return response("not found", 404);
  };
}
function serviceFixture() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-skill-github-"));
  dirs.push(userDataDir);
  const calls = [];
  const bytes = archive();
  const service = createSkillBundle({
    userDataDir,
    authorization: { resolveActor: ({ context }) => context.sessionRef ? { ok: true, user: { id: context.sessionRef } } : { ok: false } },
    githubFetcher: githubFetch(bytes, calls),
  });
  return { service, calls, bytes };
}

test("GitHub 地址只接受公开仓库根地址，不接受凭据、其它主机或仓库内路径", () => {
  assert.deepEqual(parseGithubRepository("https://github.com/owner/repo.git").repository, "owner/repo");
  for (const value of [
    "http://github.com/owner/repo", "https://evil.test/owner/repo", "https://user:secret@github.com/owner/repo",
    "https://github.com/owner/repo/tree/main", "github.com/owner/repo", "https://github.com/owner",
  ]) assert.throws(() => parseGithubRepository(value), (error) => error.code === "SKILL_INVALID_INPUT");
});

test("预览固定 commit 和 ZIP 哈希；跨账号拒绝，安装一次性且默认停用", async () => {
  const calls = [];
  const imports = [];
  let now = 1000;
  const installer = createSkillGithubInstaller({
    fetchImpl: githubFetch(archive(), calls),
    clock: () => now,
    idFactory: () => "preview-fixed",
    importArchive: (bytes, sourceName, options) => {
      imports.push({ bytes, sourceName, options });
      return { pack: { id: "pack_demo" }, skills: [{ id: "skill_demo", enabled: false }] };
    },
  });
  const preview = await installer.inspect("https://github.com/owner/repo", "user-a");
  assert.equal(preview.commit, COMMIT);
  assert.equal(preview.skills[0].name, "Demo Skill");
  assert.deepEqual(preview.skills[0].path, "repo-commit/SKILL.md");
  assert.ok(preview.scripts.some((name) => name.endsWith("setup.py")));
  assert.ok(preview.scripts.some((name) => name.endsWith("package.json")));
  assert.equal(JSON.stringify(preview).includes("not executed"), false);
  assert.ok(calls.some((url) => url.endsWith("/zip/" + COMMIT)));
  await assert.rejects(() => installer.install(preview.previewId, "user-b"), (error) => error.code === "SKILL_FORBIDDEN");
  const installed = await installer.install(preview.previewId, "user-a");
  assert.equal(installed.source.previewId, preview.previewId);
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0].options, { enabled: false });
  assert.equal(imports[0].sourceName, "repo-0123456789ab.zip");
  assert.equal(skillPack.readZipEntries(imports[0].bytes).some((file) => file.name.includes("node_modules")), false);
  await assert.rejects(() => installer.install(preview.previewId, "user-a"), (error) => error.code === "SKILL_NOT_FOUND");

  const second = await installer.inspect("https://github.com/owner/repo", "user-a");
  now += 15 * 60 * 1000 + 1;
  await assert.rejects(() => installer.install(second.previewId, "user-a"), (error) => error.code === "SKILL_NOT_FOUND");
});

test("无 Skill、危险重定向和超限下载均不进入安装", async () => {
  const noSkill = createSkillGithubInstaller({ fetchImpl: githubFetch(skillImport.buildZip([{ name: "repo/README.md", data: Buffer.from("docs") }])) });
  await assert.rejects(() => noSkill.inspect("https://github.com/owner/repo", "user-a"), /NO_SKILL_FOUND|未找到/);
  const redirect = createSkillGithubInstaller({ fetchImpl: async () => response(null, 302, { location: "https://evil.test/archive.zip" }) });
  await assert.rejects(() => redirect.inspect("https://github.com/owner/repo", "user-a"), (error) => error.code === "SKILL_FORBIDDEN");
  const oversized = createSkillGithubInstaller({ fetchImpl: githubFetch(Buffer.alloc(10), []) });
  oversized.inspect;
  const huge = createSkillGithubInstaller({ fetchImpl: async (url) => {
    if (url.endsWith("/repos/owner/repo")) return response(JSON.stringify({ default_branch: "main" }));
    if (url.includes("/commits/main")) return response(JSON.stringify({ sha: COMMIT }));
    return response(new Uint8Array(8), 200, { "content-length": String(MAX_ARCHIVE_BYTES + 1) });
  } });
  await assert.rejects(() => huge.inspect("https://github.com/owner/repo", "user-a"), /大小上限/);
});

test("真实 Skill IPC：预览不落目录，导入默认停用、归当前账号并可手动启用", async () => {
  const { service, calls } = serviceFixture();
  const invoke = (user, command, payload = {}) => service.execute(command, payload, { sessionRef: user });
  const previewResult = await invoke("user-a", "skill/pack/inspectOnline", { source: "https://github.com/owner/repo" });
  assert.equal(previewResult.ok, true, JSON.stringify(previewResult));
  assert.equal((await invoke("user-a", "skill/pack/list")).value.items.length, 0);
  const previewId = previewResult.value.preview.previewId;
  assert.equal((await invoke("user-b", "skill/pack/installStaged", { previewId })).error, "SKILL_FORBIDDEN");
  const installed = await invoke("user-a", "skill/pack/installStaged", { previewId });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.value.source.commit, COMMIT);
  assert.ok(installed.value.skills.length >= 1);
  assert.ok(installed.value.skills.every((skill) => skill.enabled === false && skill.ownerUserId === "user-a"));
  assert.equal((await invoke("user-a", "skill/pack/installStaged", { previewId })).error, "SKILL_NOT_FOUND");

  const listA = await invoke("user-a", "skill/list");
  const imported = listA.value.items.filter((skill) => skill.source?.metadata?.packId === installed.value.pack.id);
  assert.ok(imported.length >= 1);
  assert.ok(imported.every((skill) => skill.enabled === false));
  assert.equal((await invoke("user-b", "skill/list")).value.items.some((skill) => imported.some((item) => item.id === skill.id)), false);
  assert.equal((await invoke("user-b", "skill/enable", { skillId: imported[0].id })).error, "SKILL_NOT_FOUND");
  assert.equal((await invoke("user-b", "skill/pack/uninstall", { packId: installed.value.pack.id })).error, "SKILL_NOT_FOUND");
  const enabled = await invoke("user-a", "skill/enable", { skillId: imported[0].id });
  assert.equal(enabled.value.skill.enabled, true);
  assert.equal((await invoke("user-a", "skill/pack/list")).value.items.length, 1);
  assert.equal(calls.filter((url) => url.startsWith("https://codeload.github.com/")).length, 1, "安装必须复用预览字节，不能重新下载分支");
});

test("GitHub 安装器不包含 shell / 子进程执行出口", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "electron", "skill-github-installer.cjs"), "utf8");
  assert.doesNotMatch(source, /child_process|spawn\s*\(|execFile\s*\(|process\.spawn/);
});
