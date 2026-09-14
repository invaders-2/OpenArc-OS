/** D4-03B · resource.search 真实 Domain 执行：授权搜索 / 隐私 / limit 上限 / 0 泄漏。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

async function setup() {
  const fx = await createToolHarnessFixture({ withAdapters: true });
  const created = await fx.createResource("Searchable Needle");
  await fx.f.searchService.indexResource(created.resource.resourceId);
  fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]);
  const ctx = fx.ctx();
  const t = fx.createTask();
  const s = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
  return { fx, ctx, taskId: t.task.taskId, taskRevision: s.task.revision, resourceRef: created.resource.resourceRef };
}
const spy = (fx) => { const orig = fx.f.searchService.search.bind(fx.f.searchService); const box = { calls: 0 }; fx.f.searchService.search = (...a) => { box.calls += 1; return orig(...a); }; return box; };

test("authorized search：真实 SearchService.search 1 次 → 命中 + bounded count/maxLimit", async () => {
  const { fx, ctx, taskId } = await setup();
  try {
    const box = spy(fx);
    fx.toolProxy.propose({ context: ctx, taskId, toolId: "resource.search", toolVersion: 1, arguments: { query: "Searchable", limit: 5 }, proposalId: "search_ok" });
    const r = await fx.toolProxy.executeReadOnly({ context: ctx, taskId, proposalId: "search_ok" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(box.calls, 1);
    assert.ok(Array.isArray(r.result.items));
    assert.ok(r.result.items.length >= 1);
    assert.equal(r.result.maxLimit, 20);
    assert.ok(r.result.count >= r.result.items.length);
    assert.equal(r.verificationStatus, "PASS");
    for (const item of r.result.items) assert.ok(item.resourceRef.startsWith("resource://"));
  } finally { await fx.close(); }
});

test("search privacy：User B 不返回 User A 的 private resource（0 result，无差异错误）", async () => {
  const { fx } = await setup();
  try {
    const alice = { sessionRef: fx.f.sessions.alice, appId: "ai" };
    const t = fx.taskService.createTask({ context: alice, goal: "search privacy" });
    fx.taskService.startTask({ context: alice, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const p = fx.toolProxy.propose({ context: alice, taskId: t.task.taskId, toolId: "resource.search", toolVersion: 1, arguments: { query: "Searchable Needle", limit: 5 }, proposalId: "search_priv" });
    assert.equal(p.decisionStatus, "ALLOWED");
    const r = await fx.toolProxy.executeReadOnly({ context: alice, taskId: t.task.taskId, proposalId: "search_priv" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.items.length, 0, "隐藏资源不得出现在 result");
    assert.equal(r.result.count, 0);
    assert.ok(!JSON.stringify(r.result).includes("Searchable Needle"));
  } finally { await fx.close(); }
});

test("limit 上限：超限 / 巨值 → INVALID，0 Domain call", async () => {
  const { fx, ctx, taskId } = await setup();
  try {
    const box = spy(fx);
    const p = fx.toolProxy.propose({ context: ctx, taskId, toolId: "resource.search", toolVersion: 1, arguments: { query: "x", limit: 1000000 }, proposalId: "search_huge" });
    assert.equal(p.decisionStatus, "INVALID");
    assert.equal(p.reasonCode, "TOOL_ARGUMENT_INVALID");
    const r = await fx.toolProxy.executeReadOnly({ context: ctx, taskId, proposalId: "search_huge" });
    assert.equal(r.ok, false);
    assert.equal(box.calls, 0);
  } finally { await fx.close(); }
});

test("非字符串 query / FTS 注入样式只作为普通 query，不越权", async () => {
  const { fx, ctx, taskId } = await setup();
  try {
    const p = fx.toolProxy.propose({ context: ctx, taskId, toolId: "resource.search", toolVersion: 1, arguments: { query: '\" OR 1=1 --' }, proposalId: "search_inj" });
    assert.equal(p.decisionStatus, "ALLOWED");
    const r = await fx.toolProxy.executeReadOnly({ context: ctx, taskId, proposalId: "search_inj" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(Array.isArray(r.result.items));
    assert.equal(fx.toolStore.executionsOfTask(taskId).length, 1);
  } finally { await fx.close(); }
});
