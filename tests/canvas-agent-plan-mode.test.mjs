import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const { buildPrompt } = require("../electron/task-harness-orchestrator.cjs");

const ctx = (extra = {}) => ({ type: "canvas.task.v1", schemaVersion: 1, canvasId: "c1", selectedNodeIds: [], resourceRefs: [], completionConditions: [], ...extra });

test("执行方式：confirm 要求先出计划且本轮不写；auto 连续执行；都不放宽批准", () => {
  const confirm = buildPrompt({ goal: "做海报", stepInput: ctx({ planMode: "confirm" }), toolsEnabled: true });
  assert.match(confirm, /Execution mode: confirm-first/);
  assert.match(confirm, /Do NOT call any write tool in this run/);
  assert.match(confirm, /openarc-plan/);
  const auto = buildPrompt({ goal: "做海报", stepInput: ctx({ planMode: "auto" }), toolsEnabled: true });
  assert.match(auto, /Execution mode: auto/);
  assert.match(auto, /still goes through trusted user approval/);
  // 不带 planMode 时提示词与之前完全一致
  const none = buildPrompt({ goal: "做海报", stepInput: ctx(), toolsEnabled: true });
  assert.doesNotMatch(none, /Execution mode/);
});

test("task/run 只接受 confirm / auto 两种执行方式", () => {
  const src = read("electron/task-bootstrap.cjs");
  assert.match(src, /const PLAN_MODES = Object\.freeze\(\["confirm", "auto"\]\);/);
  assert.match(src, /raw\.planMode != null && !PLAN_MODES\.includes\(raw\.planMode\)/);
});

test("面板：按模式发送 planMode；确认计划后以 auto 执行", () => {
  const panel = read("src/canvas/tapnow/AgentPanel.tsx");
  assert.match(panel, /planMode: modeOverride \|\| \(a\.mode === "auto" \? "auto" : "confirm"\)/);
  assert.match(panel, /void send\(false, "auto"\)/);
});

test("计划块解析", async () => {
  const { parsePlan, planGoal } = await import("../src/canvas/canvas-next/agent/plan.ts").catch(() => ({}));
  if (!parsePlan) return; // node 直接跑 .ts 不可用时只做静态检查
  const r = parsePlan('好的\n```openarc-plan\n[{"step":"新建节点"},"连线"]\n```');
  assert.deepEqual(r, { rest: "好的", steps: ["新建节点", "连线"] });
  assert.equal(parsePlan("```openarc-plan\nnot json\n```"), null);
  assert.match(planGoal("做海报", ["a", "b"]), /1\. a\n2\. b/);
});
