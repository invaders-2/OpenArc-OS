/** 全局 AI 第 4 期：子 agent（dsh 的 spawn 子 agent，前台等结果，最多一层，用同一套受控工具和预算）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { buildAcpPatch } = require("../electron/harness-adapter.cjs");
const { buildAgentNotes } = require("../electron/task-harness-orchestrator.cjs");

const enabledIds = (patch) => {
  const ids = [];
  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^- id: (.+)$/);
    if (m && lines[i + 1] === "  disabled: false") ids.push(m[1]);
  }
  return ids;
};

test("子 agent 开关：默认全关；打开后只放开 tool-subagent（前台、最多一层、不选模型），其余委派工具仍关", () => {
  const off = buildAcpPatch({});
  assert.match(off, /- id: tool-subagent\n  disabled: true/);
  assert.deepEqual(enabledIds(off), []);
  const on = buildAcpPatch({ subagentTool: true });
  assert.deepEqual(enabledIds(on), ["tool-subagent"]);
  assert.doesNotMatch(on, /- id: tool-subagent\n  disabled: true/);
  for (const id of ["tool-subagent-fork", "tool-subagent-control", "tool-subagent-list-agents", "tool-bash", "tool-fs", "tool-jobs", "tool-workflow"]) {
    assert.match(on, new RegExp("- id: " + id + "\\n  disabled: true"), id + " 仍关");
  }
  assert.match(on, /provider: spawn/);
  assert.match(on, /backgroundMode: one-shot/);
  assert.match(on, /enableRunInBackground: false/);
  assert.match(on, /maxDepth: 1/);
  assert.match(on, /modelSelectionSettings: false/);
  assert.match(buildAgentNotes({ subagents: true }), /subagent tool/);
  assert.doesNotMatch(buildAgentNotes({}), /subagent tool/);
});

test("真实 dsh：主 AI 调 subagent → 子 agent 用同一套受控工具查资料 → 结果交回主 AI；子 agent 不能再往下派", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeMaxCalls: 8 });
  try {
    const seen = [];
    fx.fp.state.toolLoopRouter = ({ msgs, flat, names, toolNames }) => {
      const users = JSON.stringify(msgs.filter((m) => m.role === "user"));
      const isChild = /CHILD_TASK_MARK/.test(users) && !/PARENT_GOAL_MARK/.test(users);
      seen.push({ isChild, names: names.slice(), toolNames });
      if (isChild) {
        if (!names.includes("resource_search")) return { name: "resource_search", args: { query: "CHILD_QUERY", limit: 3 } };
        if (!names.includes("subagent")) return { name: "subagent", args: { description: "再往下派", prompt: "CHILD_TASK_MARK grandchild" } };
        const last = msgs.filter((m) => m.role === "tool").slice(-1)[0];
        return "CHILD_RESULT_OK nested=" + String(last && last.content).slice(0, 300);
      }
      if (!names.includes("subagent")) return { id: "call_sub", name: "subagent", args: { description: "查资料", prompt: "CHILD_TASK_MARK 帮我查一下" } };
      return "PARENT_DONE " + (/CHILD_RESULT_OK/.test(flat) ? "GOT_CHILD" : "NO_CHILD");
    };
    const orch = fx.makeDshOrchestrator({ memoryContext: null, subagentTool: true });
    const t = fx.createTask("PARENT_GOAL_MARK 用子 agent 查资料");
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.artifact.content, "PARENT_DONE GOT_CHILD");

    const parent = seen.filter((s) => !s.isChild);
    const child = seen.filter((s) => s.isChild);
    assert.ok(parent[0].toolNames.includes("subagent"), "主 AI 看得到 subagent 工具");
    assert.ok(child.length >= 2, "子 agent 真的跑了");
    assert.ok(child[0].toolNames.includes("resource_search") && child[0].toolNames.includes("workspace_write") === parent[0].toolNames.includes("workspace_write"), "子 agent 用同一套受控工具");
    assert.ok(!child[0].toolNames.some((n) => /^(bash|shell|read_file|write_file|fs_)/.test(n)), "子 agent 没有 dsh 自带的文件 / shell 工具");
    assert.equal(seen.filter((s) => s.isChild && s.names.length === 0).length, 1, "孙子 agent 没有被创建（最多一层）");

    // 子 agent 的工具调用照样记在这个任务的受控工具账上。
    const proposals = fx.toolStore.proposalsOfTask ? fx.toolStore.proposalsOfTask(t.task.taskId) : null;
    if (proposals) assert.ok(proposals.some((p) => (p.tool_id || p.toolId) === "resource.search"), "子 agent 的工具调用记在任务上");
  } finally { await fx.close(); }
});
