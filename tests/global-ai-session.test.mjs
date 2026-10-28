/** 全局 AI 会话化：同一任务的下一轮接着上一轮的 dsh 会话（真实 dsh + 假模型）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { sessionDirName, buildFollowupPrompt } = require("../electron/task-harness-orchestrator.cjs");
const { modelLimits, buildAcpPatch } = require("../electron/harness-adapter.cjs");

const FIRST = "OPENARC_FIRST_TURN_MARKER";
const SECOND = "OPENARC_SECOND_TURN_MARKER";

test("同一对话的第二轮恢复同一个 dsh 会话：模型看得到第一轮的问答，只收到新一轮的问题", async () => {
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oa-sessions-"));
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    fx.fp.state.toolLoopPlan = [];
    const orch = fx.makeDshOrchestrator({ memoryContext: null, sessionRoot, persona: "You are the OpenArc desktop assistant." });
    const t = fx.createTask("Remember the word " + FIRST);
    const r1 = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const dir = path.join(sessionRoot, sessionDirName(t.task.taskId));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "openarc-session.json"), "utf8"));
    assert.equal(saved.taskId, t.task.taskId);
    assert.ok(saved.sessionId);
    assert.ok(fs.existsSync(path.join(dir, "dsh-home")), "会话目录在 run 结束后保留");

    const before = fx.fp.state.toolLoopBodies.length;
    const r2 = await orch.appendStep({ context: fx.ctx(), taskId: t.task.taskId, goal: "What word? " + SECOND, expectedRevision: r1.task.revision });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    const second = fx.fp.state.toolLoopBodies.slice(before).join("\n");
    assert.match(second, new RegExp(FIRST), "第二轮的模型请求里有第一轮的内容");
    assert.match(second, new RegExp(SECOND));
    assert.match(second, /OpenArc desktop assistant/, "人设换成 OpenArc 助手");
    assert.doesNotMatch(second, /coding agent/);
    // 第二轮的用户消息只有新问题，不再重复整段系统说明
    const lastUser = JSON.parse(fx.fp.state.toolLoopBodies.at(-1)).messages.filter((m) => m.role === "user").at(-1);
    const lastUserText = typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
    assert.match(lastUserText, new RegExp(SECOND));
    assert.doesNotMatch(lastUserText, /OpenArc reasoning runtime/);
    const again = JSON.parse(fs.readFileSync(path.join(dir, "openarc-session.json"), "utf8"));
    assert.equal(again.sessionId, saved.sessionId, "沿用同一个会话");
  } finally { await fx.close(); fs.rmSync(sessionRoot, { recursive: true, force: true }); }
});

test("会话恢复失败（会话文件被删）时自动开新会话，这一轮照常完成", async () => {
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oa-sessions-"));
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    fx.fp.state.toolLoopPlan = [];
    const orch = fx.makeDshOrchestrator({ memoryContext: null, sessionRoot });
    const t = fx.createTask("first");
    const r1 = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r1.ok, true);
    const dir = path.join(sessionRoot, sessionDirName(t.task.taskId));
    fs.writeFileSync(path.join(dir, "openarc-session.json"), JSON.stringify({ taskId: t.task.taskId, sessionId: "missing-session" }));
    const r2 = await orch.appendStep({ context: fx.ctx(), taskId: t.task.taskId, goal: "second", expectedRevision: r1.task.revision });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "openarc-session.json"), "utf8"));
    assert.notEqual(saved.sessionId, "missing-session");
  } finally { await fx.close(); fs.rmSync(sessionRoot, { recursive: true, force: true }); }
});

test("不配置 sessionRoot 时行为不变：每个 run 用临时目录，用完删除", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    fx.fp.state.toolLoopPlan = [];
    const adapter = fx.makeDshAdapter();
    const t = fx.createTask();
    const info = await adapter.start({ context: fx.ctx(), modelConfigId: t.task.modelConfigId, maxCalls: 1 });
    assert.equal(info.persistent, false);
    assert.equal(info.resumed, false);
    const root = path.dirname(info.dshHome);
    await adapter.dispose();
    assert.equal(fs.existsSync(root), false);
  } finally { await fx.close(); }
});

test("提示与模型上限：续轮只发新问题；按模型名估上下文窗口；patch 带上窗口与人设", () => {
  assert.match(buildFollowupPrompt({ stepInput: { appended: true, goal: "  hi  " } }), /^Today's date: \d{4}-\d\d-\d\d\.\nhi$/);
  assert.match(buildFollowupPrompt({ stepInput: { continuation: true } }), /Continue the task/);
  assert.equal(buildFollowupPrompt({ stepInput: null }), null);
  assert.deepEqual(modelLimits("deepseek-chat"), { contextWindow: 128000, maxTokens: 8192 });
  assert.deepEqual(modelLimits("claude-sonnet-4"), { contextWindow: 200000, maxTokens: 8192 });
  assert.deepEqual(modelLimits("my-local-model"), { contextWindow: 65536, maxTokens: 8192 });
  const patch = buildAcpPatch({ contextWindow: 128000, maxTokens: 8192, persona: "It's OpenArc" });
  assert.match(patch, /contextWindow: 128000/);
  assert.match(patch, /maxTokens: 8192/);
  assert.match(patch, /personaPrefix: 'It''s OpenArc'/);
  assert.match(buildAcpPatch(), /contextWindow: 32768/, "默认值不变");
  assert.doesNotMatch(buildAcpPatch(), /personaPrefix/);
});

test("planTool：todo_write 的清单变成计划（实时推送 + harness.plan 事件），不算工具步骤", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    fx.fp.state.toolLoopPlan = [{ id: "call_todo_1", name: "todo_write", args: { todos: [{ content: "Search the web", status: "in_progress" }, { content: "Summarize", status: "pending" }] } }];
    const orch = fx.makeDshOrchestrator({ memoryContext: null, planTool: true });
    const progress = [];
    orch.setProgressSink((taskId, u) => progress.push({ taskId, ...u }));
    const t = fx.createTask("plan it");
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.ok, true, JSON.stringify(r));
    const plan = progress.find((p) => p.kind === "plan");
    assert.ok(plan, "运行中推送了计划");
    assert.equal(plan.taskId, t.task.taskId);
    assert.deepEqual(plan.items, [{ content: "Search the web", status: "in_progress" }, { content: "Summarize", status: "pending" }]);
    assert.equal(progress.some((p) => p.kind === "tool" && p.name === "todo_write"), false);
    const ev = fx.taskStore.eventsOfTask(t.task.taskId).find((e) => e.event_type === "harness.plan");
    assert.ok(ev, "落了一条 harness.plan");
    assert.equal(JSON.parse(ev.safe_payload).items.length, 2);
  } finally { await fx.close(); }
});

test("未开 planTool 时 todo_write 不对模型开放", () => {
  assert.doesNotMatch(buildAcpPatch({}), /tool-todo/);
  assert.match(buildAcpPatch({ planTool: true }), /- id: tool-todo\n  disabled: false/);
});
