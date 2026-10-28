import test from "node:test";
import assert from "node:assert/strict";
import { creatorDocument, creatorDraftOf, creatorVersionText } from "../src/skills/skillCreatorLogic.ts";

test("创建助手只组合真实用户要求与现有说明", () => {
  const text = creatorDocument([
    { id: "a", role: "assistant", text: "不得重复插入的模型回复", at: 1 },
    { id: "u1", role: "user", text: "  创建周报技能  ", at: 2 },
    { id: "u2", role: "user", text: "增加缺失字段检查", at: 3 },
  ], "原有执行说明");
  assert.ok(text.includes("原有执行说明"));
  assert.ok(text.indexOf("创建周报技能") < text.indexOf("增加缺失字段检查"));
  assert.ok(!text.includes("不得重复插入的模型回复"));
});

test("结构化结果递增版本并保留可编辑步骤", () => {
  const draft = creatorDraftOf({
    id: "weekly_report",
    name: "周报",
    description: "生成周报",
    systemPrompt: "先检查输入",
    v2: { steps: [{ title: "检查", detail: "检查缺失字段", uses: "analysis" }], version: 1 },
  }, { version: 2 }, ["缺少联网权限"]);
  assert.equal(draft.v2.version, 3);
  assert.equal(draft.v2.steps[0].title, "检查");
  assert.deepEqual(draft.warnings, ["缺少联网权限"]);
  assert.equal(creatorVersionText(draft), "第 3 版 · 1 个步骤");
  const first = creatorDraftOf({ id: "first", name: "首版", v2: { steps: [{ title: "一步", detail: "执行" }] } }, null);
  assert.equal(first.v2.version, 1);
  assert.equal(creatorVersionText(first), "第 1 版 · 1 个步骤");
  assert.throws(() => creatorDraftOf({ id: "bad", name: "bad" }, null), /缺少 v2/);
});
