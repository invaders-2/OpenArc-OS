/**
 * D4-05 · S4（A36 记忆越权）——真实 memory 资源 + 搜索授权 + 真实 orchestrator 任务上下文。
 *
 * 覆盖：
 *   · alice 个人 memory（唯一 token）alice 检索可见；
 *   · alice trash 后检索不可见；永久删除后派生索引文档被移除；
 *   · 切换账号 dana/新 session → 检索不到该内容，也检索不到 alice 的其他 memory；
 *   · 真实 orchestrator 起任务，捕获实际 model 请求体，断言 prompt/上下文不含已删或他人 memory 内容。
 *
 * 诚实说明：本版本 buildPrompt 只含 goal + safe step input + prior artifact，**没有** memory→任务
 * 上下文的正向注入；因此“新任务上下文不出现已删/他人内容”是负向要求成立，而正向记忆检索能力不存在。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
after(() => fx.close());

const alice = { sessionRef: fx.f.sessions.alice, appId: "resource-library", source: "ui" };
const dana = { sessionRef: fx.f.sessions.dana, appId: "resource-library", source: "ui" };
const search = (context, query) => fx.f.searchService.search({ context, query, limit: 10 });
const TOKEN_A = "D405_ALICE_MEM_TOKEN_9f3a";
const TOKEN_D = "D405_DANA_MEM_TOKEN_4c17";

test("D4-05 S4 A36 · alice 个人 memory 检索可见 → 删除后不可见 + 索引移除 → 切账号不可见", async () => {
  const created = await fx.f.resourceService.createResource({ context: alice, resourceType: "memory", name: "D405 Alice Memory " + TOKEN_A, content: TOKEN_A + " private body", memorySubtype: "project-memory" });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  const aliceId = created.resource.resourceId;

  const visible = await search(alice, TOKEN_A);
  assert.equal(visible.total, 1, "alice 必须能检索到自己的 memory：" + JSON.stringify(visible.total));

  const otherBefore = await search(dana, TOKEN_A);
  assert.equal(otherBefore.total, 0, "dana 不能检索到 alice 的 memory");
  assert.equal(JSON.stringify(otherBefore).includes(TOKEN_A), false, "dana 结果正文不得泄漏 alice token");

  const danaMem = await fx.f.resourceService.createResource({ context: dana, resourceType: "memory", name: "D405 Dana Memory " + TOKEN_D, content: TOKEN_D + " dana body", memorySubtype: "project-memory" });
  assert.equal(danaMem.ok, true);
  assert.equal((await search(dana, TOKEN_D)).total, 1, "dana 能检索到自己的 memory");
  assert.equal((await search(alice, TOKEN_D)).total, 0, "alice 不能检索到 dana 的 memory");

  // trash（可逆删除）→ 检索不可见（授权过滤，不泄漏）。
  fx.f.resourceService.delete({ context: alice, resourceRef: aliceId });
  const afterTrash = await search(alice, TOKEN_A);
  assert.equal(afterTrash.total, 0, "trash 后 alice 也检索不到");
  assert.equal(JSON.stringify(afterTrash).includes(TOKEN_A), false, "trash 结果不得返回已删内容");

  // 永久删除 → 派生索引文档被移除。
  fx.f.resourceService.permanentDelete({ context: alice, resourceRef: aliceId });
  assert.equal(fx.f.searchStore.documentById(aliceId), null, "永久删除后索引文档必须移除");
  assert.equal((await search(dana, TOKEN_A)).total, 0);

  // dana 的 memory 仍完整（证明删除只作用于 alice 自己的资源）。
  assert.ok(fx.f.searchStore.documentById(danaMem.resource.resourceId), "dana memory 索引仍在");
  assert.equal((await search(dana, TOKEN_D)).total, 1);
  fx.f.resourceService.permanentDelete({ context: dana, resourceRef: danaMem.resource.resourceId });
  assert.equal(fx.f.searchStore.documentById(danaMem.resource.resourceId), null);
});

test("D4-05 S4 A36 · 切账号新任务：捕获真实 model 请求体，prompt/上下文不含已删或他人 memory 内容", async () => {
  const TOKEN_A2 = "D405_ALICE_DELETED_5b21";
  const TOKEN_D2 = "D405_DANA_OWN_7e44";
  const a = await fx.f.resourceService.createResource({ context: alice, resourceType: "memory", name: "D405 Deleted " + TOKEN_A2, content: TOKEN_A2 + " to-be-deleted", memorySubtype: "project-memory" });
  assert.equal(a.ok, true);
  const d = await fx.f.resourceService.createResource({ context: dana, resourceType: "memory", name: "D405 Own " + TOKEN_D2, content: TOKEN_D2 + " own memory", memorySubtype: "project-memory" });
  assert.equal(d.ok, true);
  // 删除 alice 的 memory；dana 自己的 memory 保留。
  fx.f.resourceService.delete({ context: alice, resourceRef: a.resource.resourceId });
  fx.f.resourceService.permanentDelete({ context: alice, resourceRef: a.resource.resourceId });
  assert.equal(fx.f.searchStore.documentById(a.resource.resourceId), null, "已删 memory 索引移除");
  assert.equal((await search(dana, TOKEN_D2)).total, 1, "dana 自己 memory 仍可检索（能力存在）");
  assert.equal((await search(dana, TOKEN_A2)).total, 0, "dana 检索不到 alice 已删 memory");

  // 切到 dana / 新 session，用真实 orchestrator 起一个任务；捕获实际 model 请求体。
  const org = fx.enableOrgModel();
  assert.equal(org.ok, true, JSON.stringify(org));
  const danaTaskCtx = { sessionRef: fx.f.sessions.dana, appId: "ai", source: "test" };
  const t = fx.taskService.createTask({ context: danaTaskCtx, goal: "summarize the project notes", modelConfigId: org.configId });
  assert.equal(t.ok, true, JSON.stringify(t.error));
  fx.fp.state.toolLoopBodies.length = 0;
  fx.fp.state.toolLoopPlan = [];
  const dsh = fx.makeDshOrchestrator();
  const r = await dsh.runTask({ context: danaTaskCtx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
  assert.equal(r.ok, true, "dana 的任务必须真实跑通：" + JSON.stringify(r.error));

  const bodies = fx.fp.state.toolLoopBodies.join("\n");
  assert.ok(bodies.length > 0, "必须捕获到真实 model 请求体");
  assert.ok(bodies.includes("Task goal:"), "请求体必须含 OpenArc 构造的 prompt（正向对照）");
  assert.equal(bodies.includes(TOKEN_A2), false, "上下文不得含已删 memory 内容：" + TOKEN_A2);
  assert.equal(bodies.includes(TOKEN_D2), false, "上下文不得含（他人/自己）memory 内容：" + TOKEN_D2);
  assert.equal(bodies.includes("D405 Deleted"), false, "上下文不得含已删 memory 名称");
  assert.equal(bodies.includes("D405 Own"), false, "上下文不得含 memory 名称");
});
