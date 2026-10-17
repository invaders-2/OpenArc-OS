/** task-69 · AI 任务预算、harness.tool_proposed 安全字段、画布上下文结构化拒绝。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const taskDomain = require("../electron/task-domain.cjs");
const { createTaskBundle, TOOL_FACADE_CONFIG } = require("../electron/task-bootstrap.cjs");
const { mapAcpEvents } = require("../electron/task-harness-orchestrator.cjs");
const catalog = require("../electron/agent-tool-catalog.cjs");

test("AI 任务预算集中常量：toolCalls=32 / modelCalls=16 / toolRounds=8；普通 BUDGET_BASE 仍 8/8/4", () => {
  assert.deepEqual(taskDomain.AI_TASK_BUDGET, { MODEL_CALLS: 16, TOOL_CALLS: 32, TOOL_ROUNDS: 8 });
  assert.deepEqual(taskDomain.BUDGET_BASE, { MODEL_CALLS: 8, TOOL_CALLS: 8, TOOL_ROUNDS: 4 });
  assert.equal(TOOL_FACADE_CONFIG.maxCalls, 32);
});

test("真实 createTaskBundle 采用 AI 预算，orchestrator 轮次上限为 8", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-task69-budget-"));
  const { createResourceFixture } = await import("./resource-fixtures.mjs");
  const f = await createResourceFixture();
  try {
    const bundle = createTaskBundle({ identityStore: f.identity, authorization: f.authService, authStore: f.store, dbPath: ":memory:", storeRoot: f.storeRoot, runtimeDir: path.join(dir, "runtime") });
    assert.deepEqual(bundle.taskService.budgetConfig, { MODEL_CALLS: 16, TOOL_CALLS: 32, TOOL_ROUNDS: 8 });
    assert.equal(bundle.orchestrator, null, "modelProxy 缺席时 orchestrator 不装配；预算仍按 AI 常量注入");
  } finally { f.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("harness.tool_proposed 事件只带 safe toolId/name，不带 arguments", () => {
  const { events } = mapAcpEvents([
    { type: "tool.proposed", raw: "tool_call", toolCallId: "call-1", title: "canvas_run", rawInput: { arguments: { prompt: "SECRET_PROMPT", token: "sk-secret" } } },
    { type: "tool.proposed", raw: "tool_call", toolCallId: "call-2", title: "fs_read", rawInput: { arguments: { path: "/private/secret" } } },
  ]);
  const proposed = events.filter((event) => event.eventType === "harness.tool_proposed");
  assert.equal(proposed.length, 2);
  assert.deepEqual(proposed[0].safePayload, { acpType: "tool_call", toolCallId: "call-1", toolId: "canvas_run", name: "canvas_run" });
  assert.deepEqual(proposed[1].safePayload, { acpType: "tool_call", toolCallId: "call-2", toolId: "fs_read", name: "fs_read" });
  const serialized = JSON.stringify(proposed);
  assert.equal(serialized.includes("SECRET_PROMPT"), false);
  assert.equal(serialized.includes("sk-secret"), false);
  assert.equal(serialized.includes("/private/secret"), false);
});

test("画布客户端工具缺 app.canvas.current 时返回结构化 TOOL_CONTEXT_UNAVAILABLE 且 retryable=false", async () => {
  const descriptor = {
    name: "canvas_run", title: "运行画布", description: "运行节点", source: "app", sourceId: "canvas",
    enabled: true, executable: true, status: "ready", statusText: "ready", inputSchema: { type: "object" },
    permissions: [], risk: "write", sideEffects: [], whenToUse: [], domain: "app.canvas", intents: [],
    requiredContext: ["app.canvas.current"], handler: { type: "client", command: "canvas/run" },
  };
  catalog.configureToolCatalog({ sources: { canvas: { list: () => [descriptor] } }, auth: null });
  try {
    await assert.rejects(
      () => catalog.runCatalogTool("canvas_run", {}, { id: "user-1" }, { sourceId: "canvas" }),
      (error) => {
        assert.equal(error.code, "TOOL_CONTEXT_UNAVAILABLE");
        assert.equal(error.retryable, false);
        assert.deepEqual(error.requiredContext, ["app.canvas.current"]);
        assert.match(error.message, /app\.canvas\.current/);
        return true;
      },
    );
  } finally { catalog.resetToolCatalogForTests(); }
});
