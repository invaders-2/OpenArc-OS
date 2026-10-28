import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { registerTaskIpc, normalizeCanvasTaskContext } = require("../electron/task-bootstrap.cjs");
const esbuild = require("esbuild");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "node_modules/.cache/oa-canvas-agent-task-" + process.pid + ".mjs");
await esbuild.build({ entryPoints: [path.join(ROOT, "src/canvas/canvas-next/agent/task.ts")], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent" });
const projection = await import(pathToFileURL(OUT).href);
test.after(() => fs.rmSync(OUT, { force: true }));

const CONTEXT = { schemaVersion: 1, canvasId: "canvas_1", selectedNodeIds: ["node_1"], resourceRefs: ["openarc-asset:res_1"], completionConditions: ["创建后读回验证"] };

test("1A · canvasContext 只保留有界引用，不接收画布正文或 Renderer 身份", () => {
  const normalized = normalizeCanvasTaskContext({ ...CONTEXT, userId: "mallory", sessionRef: "forged", appId: "root", doc: { nodes: [{ text: "正文" }] } });
  assert.equal(normalized.ok, true, JSON.stringify(normalized));
  assert.deepEqual(normalized.context, { type: "canvas.task.v1", ...CONTEXT });
  assert.equal(JSON.stringify(normalized.context).includes("mallory"), false);
  assert.equal(JSON.stringify(normalized.context).includes("正文"), false);
  assert.equal(normalizeCanvasTaskContext({ ...CONTEXT, selectedNodeIds: "node_1" }).ok, false);
  assert.equal(normalizeCanvasTaskContext({ ...CONTEXT, completionConditions: ["x".repeat(161)] }).ok, false);
});

function fakeIpc() { const handlers = new Map(); return { handlers, handle(name, fn) { handlers.set(name, fn); }, removeHandler(name) { handlers.delete(name); } }; }

test("1A · 真实 task:command 注入可信 session/app，canvasContext 进入既有 runTask(stepInput)", async () => {
  const ipc = fakeIpc(); const calls = [];
  const taskService = {
    modelService: { resolveModel: () => ({ ok: true, snapshot: { modelConfigId: "cfg_chat" } }) },
    createTask(input) { calls.push(["createTask", input]); return { ok: true, task: { taskId: "task_1", revision: 1, status: "PENDING" } }; },
    getEvents: () => ({ ok: true, items: [] }), getCalls: () => ({ ok: true, items: [] }),
  };
  const orchestrator = { runTask(input) { calls.push(["runTask", input]); return Promise.resolve({ ok: true, task: { status: "SUCCEEDED" } }); } };
  const canvasService = { getCanvas(input) { calls.push(["getCanvas", input]); return { ok: true, canvas: { canvasId: "canvas_1" } }; } };
  registerTaskIpc({ ipcMain: ipc, taskService, orchestrator, canvasService, identity: { current: "trusted_session" }, isTrusted: () => true });
  const result = await ipc.handlers.get("task:command")({}, { type: "task/run", goal: "创建一个节点", sessionRef: "forged", appId: "root", canvasContext: CONTEXT });
  assert.equal(result.ok, true, JSON.stringify(result));
  const admission = calls.find(([name]) => name === "getCanvas")[1];
  assert.equal(admission.context.sessionRef, "trusted_session");
  assert.equal(admission.context.appId, "ai");
  const run = calls.find(([name]) => name === "runTask")[1];
  assert.deepEqual(run.stepInput, { type: "canvas.task.v1", ...CONTEXT });
  assert.equal(run.context.sessionRef, "trusted_session");
  assert.equal(run.context.appId, "ai");
});

test("1A · 目标画布不可访问时不创建任务", async () => {
  const ipc = fakeIpc(); let created = 0;
  const taskService = { modelService: { resolveModel: () => ({ ok: true, snapshot: { modelConfigId: "cfg" } }) }, createTask() { created++; return { ok: true, task: { taskId: "t", revision: 1 } }; } };
  registerTaskIpc({ ipcMain: ipc, taskService, orchestrator: {}, canvasService: { getCanvas: () => ({ ok: false, error: "NOT_FOUND_OR_FORBIDDEN" }) }, identity: { current: "trusted" }, isTrusted: () => true });
  const result = await ipc.handlers.get("task:command")({}, { type: "task/run", goal: "test", canvasContext: CONTEXT });
  assert.equal(result.ok, false);
  assert.equal(result.error, "CANVAS_NOT_FOUND_OR_FORBIDDEN");
  assert.equal(created, 0);
});

test("1A · Agent 可到达源码没有 execPlan/t.run/本地计划直写出口", () => {
  const panel = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/agent/AgentPanel.tsx"), "utf8");
  const next = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/agent/AgentPanelNext.tsx"), "utf8");
  const actual = fs.readFileSync(path.join(ROOT, "src/canvas/tapnow/AgentPanel.tsx"), "utf8");
  const planner = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/agent/planner.ts"), "utf8");
  const state = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/agent/state.ts"), "utf8");
  for (const source of [panel, next, actual, planner, state]) {
    assert.equal(/execPlan|opsToPlan|rulePlan|t\.run\?\(|run\?:\s*\(\)\s*=>\s*Promise/.test(source), false);
    assert.equal(/store\.(?:mutate|addNodes|patchGen|removeNodes|updateNode)\s*\(/.test(source), false);
  }
  for (const source of [panel, next, actual]) {
    assert.match(source, /runAgentTask/);
    assert.match(source, /cancelAgentTask/);
    assert.match(source, /refreshAuthoritative/);
    assert.equal(/localPlanner|localExecution|from "\.\/operations"/.test(source), false);
  }
  assert.match(actual, /subscribeAgentTask/);
  assert.match(actual, /defaultChatModel/);
  assert.equal(/a\.effort|reasoningEffort/.test(actual), false);
  assert.match(fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/CanvasApp.tsx"), "utf8"), /\.\.\/tapnow\/AgentPanel/);
});

test("1A · UI 步骤只投影真实 safeEvent：等待、执行、失败、停止与完成", () => {
  const base = { taskId: "t", steps: [], calls: [], artifacts: [], verifications: [] };
  const waiting = { ...base, status: "WAITING", events: [{ eventId: "e1", eventType: "tool.side_effect.waiting_approval", safePayload: { callId: "c1", toolId: "canvas.edit" } }] };
  assert.deepEqual(projection.taskToolSteps(waiting), [{ label: "canvas.edit", state: "wait" }]);
  assert.equal(projection.taskStatusText(waiting.status), "等待你的批准");
  assert.match(projection.taskAnswer(waiting), /自动模式也不会跳过/);
  const running = { ...waiting, status: "RUNNING", events: [...waiting.events, { eventId: "e2", eventType: "tool.side_effect.execution_started", safePayload: { callId: "c1", toolId: "canvas.edit" } }] };
  assert.equal(projection.taskToolSteps(running)[0].state, "run");
  const failed = { ...running, status: "FAILED", events: [...running.events, { eventId: "e3", eventType: "tool.side_effect.execution_blocked", safePayload: { callId: "c1", toolId: "canvas.edit" } }] };
  assert.equal(projection.taskToolSteps(failed)[0].state, "error");
  assert.equal(projection.taskAnswer({ ...base, status: "CANCELLED", events: [] }), "已停止；已经完成的操作保留，后续步骤不会继续。");
  const succeeded = { ...base, status: "SUCCEEDED", events: [] };
  assert.equal(projection.taskAnswer(succeeded, "pending"), "任务已完成，正在重读权威画布。");
  assert.equal(projection.taskAnswer(succeeded, "refreshed"), "任务已完成，画布已按权威文档刷新。");
  assert.match(projection.taskAnswer(succeeded, "skipped"), /未保存编辑已保留/);
  assert.match(projection.taskAnswer(succeeded, "failed"), /刷新失败/);
});

test("1A · BLOCKED 收敛本次 UI watch，但不伪装成 Task 持久终态；同步回调也清理", () => {
  assert.equal(projection.TASK_PERSISTENT_TERMINAL.has("BLOCKED"), false);
  assert.equal(projection.TASK_UI_SETTLED.has("BLOCKED"), true);
  let unsubscribe = 0; let settled = 0;
  const backend = { watchAgentTask(_id, onSnapshot) { onSnapshot({ taskId: "t", status: "BLOCKED", steps: [], events: [], calls: [], artifacts: [], verifications: [] }); return () => { unsubscribe++; }; } };
  const watcher = projection.subscribeAgentTask(backend, "t", () => {}, () => { settled++; });
  assert.equal(watcher.settled(), true);
  assert.equal(unsubscribe, 1, "同步 BLOCKED 必须在返回后立刻取消底层订阅");
  assert.equal(settled, 1, "同步 BLOCKED 必须通知调用方不要登记 watcher");
  watcher.stop();
  assert.equal(unsubscribe, 1, "重复 stop 不重复清理");
});
