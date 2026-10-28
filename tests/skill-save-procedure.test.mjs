import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSkillBundle } = require("../electron/skill-service.cjs");
const skillStore = require("../electron/skill-store.cjs");

test("保存分析后的 procedure 工作流", async () => {
  skillStore.resetSkillStoreForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-skill-procedure-"));
  try {
    const bundle = createSkillBundle({ userDataDir: dir, authorization: { resolveActor: () => ({ ok: true, user: { id: "debug-user", organizationId: "debug-org" } }) } });
    const skill = { id: "skill_creator_demo", name: "销售周报", description: "把门店销售数据整理成周报", systemPrompt: "先检查输入", kind: "procedure", v2: { version: 1, steps: [{ title: "检查", detail: "检查输入", uses: "analysis" }] } };
    const result = await bundle.execute("skill/save", { skill }, { sessionRef: "debug" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.skill.kind, "procedure");
  } finally {
    skillStore.resetSkillStoreForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
