import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const skillStore = require("../electron/skill-store.cjs");
const skillImport = require("../electron/skill-import.cjs");
const skillPack = require("../electron/skill-pack.cjs");
const skillRunner = require("../electron/skill-runner.cjs");
const skillAnalyzer = require("../electron/skill-analyzer.cjs");
const skillWorkspace = require("../electron/skill-workspace.cjs");
const { createSkillBundle } = require("../electron/skill-service.cjs");
const dirs = [];

afterEach(() => {
  skillStore.resetSkillStoreForTests();
  skillImport.resetSkillImportForTests();
  skillPack.resetSkillPackForTests();
  skillRunner.resetSkillRunnerForTests();
  skillAnalyzer.resetSkillAnalyzerForTests();
  skillWorkspace.resetSkillWorkspaceForTests();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function fixture() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-skill-owner-"));
  dirs.push(userDataDir);
  const authorization = { resolveActor({ context }) { return context.sessionRef ? { ok: true, user: { id: context.sessionRef } } : { ok: false }; } };
  const identityStore = { db: { exec() {}, prepare() { return { run() { return { changes: 0 }; }, all() { return []; }, get() { return undefined; } }; } } };
  const bundle = () => createSkillBundle({ userDataDir, authorization, identityStore });
  const invoke = (service, userId, command, payload = {}) => service.execute(command, payload, { sessionRef: userId });
  return { userDataDir, bundle, invoke };
}

function custom(id, name = id) {
  return { id, name, description: name + " description", systemPrompt: "Use " + name };
}

function packageZip() {
  return skillImport.buildZip([
    { name: "skill.json", data: Buffer.from(JSON.stringify({ format: "ccs-skill/v1", id: "owned_pack_skill", name: "Owned pack", description: "Owned pack", systemPrompt: "pack prompt" })) },
    { name: "SKILL.md", data: Buffer.from("# Owned pack") },
  ]).toString("base64");
}

test("2A · 自定义 Skill 按账号隔离，重启保留 owner，旧未归属数据默认隐藏", async () => {
  const { userDataDir, bundle, invoke } = fixture();
  let service = bundle();
  assert.equal((await invoke(service, "user-a", "skill/save", { skill: custom("account_a_skill") })).ok, true);
  skillStore.saveCustomSkill(custom("legacy_unowned"));
  const listB = await invoke(service, "user-b", "skill/list");
  assert.equal(listB.ok, true);
  assert.equal(listB.value.items.some((skill) => skill.id === "account_a_skill" || skill.id === "legacy_unowned"), false);
  for (const [command, payload] of [
    ["skill/get", { skillId: "account_a_skill" }],
    ["skill/enable", { skillId: "account_a_skill" }],
    ["skill/run", { skillId: "account_a_skill" }],
    ["skill/delete", { skillId: "account_a_skill" }],
    ["skill/pack/export", { skillId: "account_a_skill" }],
  ]) {
    const denied = await invoke(service, "user-b", command, payload);
    assert.equal(denied.ok, false, command);
    assert.equal(denied.error, "SKILL_NOT_FOUND", command);
  }
  assert.equal((await invoke(service, "user-b", "skill/save", { skill: custom("account_b_skill") })).ok, true);
  assert.equal((await invoke(service, "user-b", "skill/delete", { skillId: "account_b_skill" })).ok, true);
  assert.equal((await invoke(service, "user-a", "skill/get", { skillId: "account_a_skill" })).ok, true);

  service = bundle();
  const reopenedA = await invoke(service, "user-a", "skill/list");
  const reopenedB = await invoke(service, "user-b", "skill/list");
  assert.equal(reopenedA.value.items.find((skill) => skill.id === "account_a_skill").ownerUserId, "user-a");
  assert.equal(reopenedB.value.items.some((skill) => skill.id === "account_a_skill" || skill.id === "legacy_unowned"), false);
  assert.equal(fs.existsSync(path.join(userDataDir, "dxos", "skills.json")), true);
});

test("2A · 新导入 Skill 与技能包仅归当前账号，导出和卸载不可越权", async () => {
  const { bundle, invoke } = fixture();
  const service = bundle();
  const archiveBase64 = packageZip();
  const imported = await invoke(service, "user-a", "skill/pack/import", { archiveBase64 });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.value.skills[0].ownerUserId, "user-a");
  const installed = await invoke(service, "user-a", "skill/pack/install", { archiveBase64, sourceName: "owned.zip" });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.ok(installed.value.skills.every((skill) => skill.ownerUserId === "user-a"));
  const packId = installed.value.pack.id;
  const listB = await invoke(service, "user-b", "skill/pack/list");
  assert.equal(listB.value.items.length, 0);
  assert.equal((await invoke(service, "user-b", "skill/pack/export", { packId })).error, "SKILL_NOT_FOUND");
  assert.equal((await invoke(service, "user-b", "skill/pack/uninstall", { packId })).error, "SKILL_NOT_FOUND");
  assert.equal((await invoke(service, "user-a", "skill/pack/list")).value.items.length, 1);
  assert.equal((await invoke(service, "user-a", "skill/pack/export", { packId })).ok, true);
  const removed = await invoke(service, "user-a", "skill/pack/uninstall", { packId });
  assert.equal(removed.ok, true, JSON.stringify(removed));
});
