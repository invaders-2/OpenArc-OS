/** D4-03B Final Closure · official dsh 真实 tool_call 执行 E2E（plugin → Tool Facade → ControlledToolProxy → Domain）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolHarnessFixture, PROVIDER_SECRET } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const VISIBLE = "OPENARC_DSH_VISIBLE_RESOURCE";
const HIDDEN = "OPENARC_DSH_HIDDEN_RESOURCE";
const TABLES = ["tasks", "task_steps", "task_events", "task_artifacts", "task_verifications", "task_harness_runs", "task_tool_proposals", "tool_decisions", "tool_executions", "authorization_audit"];
function dumpDb(identity) { let text = ""; for (const t of TABLES) { try { for (const row of identity.connection.prepare("SELECT * FROM " + t).all()) text += JSON.stringify(row) + "\n"; } catch { /* ignore */ } } return text; }

async function visibleFixture(extra = {}) {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", ...extra });
  const created = await fx.createResource(VISIBLE);
  await fx.f.searchService.indexResource(created.resource.resourceId);
  fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]);
  return { fx, created };
}

test("Official dsh E2E：tool_call → Tool Facade → Proxy → Search/Resource Domain → result 回 dsh → 续推理 → Artifact/Verification/Task SUCCEEDED", async () => {
  const { fx, created } = await visibleFixture();
  try {
    const before = fx.f.resourceStore.resourceRowById(created.resource.resourceId);
    const beforeCount = Number(fx.f.identity.connection.prepare("SELECT COUNT(*) AS c FROM resource_registry").get().c);
    let searchCalls = 0; let readCalls = 0;
    const s0 = fx.f.searchService.search.bind(fx.f.searchService);
    fx.f.searchService.search = (...a) => { searchCalls += 1; return s0(...a); };
    const r0 = fx.f.resourceService.get.bind(fx.f.resourceService);
    fx.f.resourceService.get = (...a) => { readCalls += 1; return r0(...a); };

    const ctx = fx.ctx();
    const t = fx.createTask();
    const orch = fx.makeDshOrchestrator();
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });

    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.task.status, "SUCCEEDED");
    assert.equal(r.artifact.content, "OPENARC_DSH_TOOL_OK");
    assert.equal(r.verification.status, "PASS");

    // §27：3 次真实 model 请求，无 hidden retry。
    assert.equal(fx.fp.state.requests, 3, "expected exactly 3 model calls");
    assert.deepEqual(fx.fp.state.toolCalls, ["resource_search", "resource_read_metadata"]);
    // §31：exactly 2 OpenArc tool，且无 shell/fs/web 等。
    const advertised = fx.fp.state.toolLoop.toolNames.slice().sort();
    assert.deepEqual(advertised, ["resource_read_metadata", "resource_search"]);
    for (const bad of ["run_code", "shell", "terminal", "filesystem", "write", "web", "mcp", "process", "exit_plan_mode"]) assert.ok(!advertised.includes(bad), "不得暴露 " + bad);

    // §28：2 proposals / 2 decisions / 2 executions / 2 verifications，Domain 各 1 次。
    const props = fx.toolStore.proposalsOfTask(t.task.taskId);
    const decs = fx.toolStore.decisionsOfTask(t.task.taskId);
    const execs = fx.toolStore.executionsOfTask(t.task.taskId);
    assert.equal(props.length, 2);
    assert.equal(decs.length, 2);
    assert.ok(decs.every((d) => d.decision === "ALLOWED"), JSON.stringify(decs.map((d) => d.reason_code)));
    assert.equal(execs.length, 2);
    assert.ok(execs.every((e) => e.status === "SUCCEEDED" && e.verification_status === "PASS"), JSON.stringify(execs));
    assert.equal(searchCalls, 1, "SearchService.search exactly 1");
    assert.equal(readCalls, 1, "ResourceService.get exactly 1");

    // §48：READ_ONLY 0 mutation。
    const after = fx.f.resourceStore.resourceRowById(created.resource.resourceId);
    assert.equal(Number(after.version), Number(before.version));
    assert.equal(Number(after.updated_at), Number(before.updated_at));
    assert.equal(Number(fx.f.identity.connection.prepare("SELECT COUNT(*) AS c FROM resource_registry").get().c), beforeCount);

    // §46/§47：Secret / capability / 绝对路径 0 hit。
    const dump = dumpDb(fx.f.identity);
    assert.ok(!dump.includes(PROVIDER_SECRET), "Provider Secret 不得落库");
    assert.ok(!dump.includes("mpx_"), "Model capability 不得落库");
    assert.ok(!dump.includes("tpx_"), "Tool capability 不得落库");
    assert.ok(!/\/Users\/|\/private\/|\/var\/folders/.test(dump), "绝对路径不得落库");
    assert.ok(!dump.includes(fx.f.storeRoot), "store root 不得落库");
    assert.ok(!/\/Users\/|\/private\/|\/var\/folders/.test(r.artifact.content), "artifact 不得含绝对路径");
  } finally { await fx.close(); }
});
