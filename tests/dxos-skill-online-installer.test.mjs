/** task-25 D09 · ModelScope 在线安装器注入（默认结构化不可用，注入 runner 才联网/落盘）。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const skillPack = require("../electron/skill-pack.cjs");
const skillDomain = require("../electron/skill-domain.cjs");

const dirs = [];
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-skill-online-")); dirs.push(dir); return dir; }
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function skillStore() {
  const skills = new Map();
  return {
    skills,
    listSkills: () => [...skills.values()],
    saveCustomSkill: (input) => { const skill = { ...input }; skills.set(skill.id, skill); return skill; },
    deleteCustomSkillsForPack: () => 0,
    resolveChatTarget: () => ({ provider: { id: "p" }, model: "m" }),
    updateCustomSkillDisplay: (id, name) => skills.get(id),
  };
}

test("D09 · 未注入安装器：结构化依赖缺失；注入 runner 后安装 SKILL.md 并注册", async () => {
  const dir = tempDir();
  skillPack.resetSkillPackForTests();
  skillPack.configureSkillPack({ userDataDir: dir, skillStore: skillStore() });
  await assert.rejects(
    () => skillPack.importOnlineSkillPack("npx skills add https://modelscope.cn/skills/owner/collection"),
    (error) => error && error.code === "AGENT_DEPENDENCY_UNAVAILABLE" && error.dependency === "runner.onlineInstaller",
  );

  const runner = {
    run: async ({ cwd }) => {
      const target = path.join(cwd, ".agents", "skills", "demo");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "SKILL.md"), "---\nname: demo\ndescription: 在线技能\n---\n正文");
      return { ok: true };
    },
  };
  skillPack.configureSkillPack({
    userDataDir: dir,
    skillStore: skillStore(),
    runner,
    agentWorkspace: {
      registerAgentWorkspace: () => null,
      deleteAgentWorkspaceProfiles: () => 0,
      deleteAgentWorkspaceProfilesForPack: () => 0,
    },
  });
  const installed = await skillPack.importOnlineSkillPack("npx skills add https://modelscope.cn/skills/owner/collection");
  assert.ok(installed && installed.pack && installed.pack.id, JSON.stringify(installed));
  assert.equal(installed.source.provider, "ModelScope");
  assert.ok(Array.isArray(installed.skills) && installed.skills.length >= 1);
  assert.equal(Object.keys(skillDomain.SKILL_COMMANDS).length, 15, "不得扩前端冻结命令白名单");
  const service = fs.readFileSync(path.join(process.cwd(), "electron", "skill-service.cjs"), "utf8");
  assert.ok(service.includes("onlineInstaller"));
  assert.ok(service.includes("payload.onlineSource != null"));
  assert.ok(service.includes("importOnlineSkillPack"));
});
