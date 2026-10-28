/** 全局 AI 第 3 期：长期记忆（自动记，回复里说「已记住」，存在资源库的 agent-memory 里）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { createAgentMemory, createAgentMemoryProvider, memoryNotes, rememberedNote } = require("../electron/agent-memory.cjs");
const { ToolRegistry, buildBridgeManifest } = require("../electron/tool-registry.cjs");
const { READ_TOOL_IDS, WRITE_TOOL_IDS } = require("../electron/dsh-tool-profile.cjs");

const memoryOf = (fx, markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-mem-"))) => createAgentMemory({ resourceService: fx.f.resourceService, authService: fx.f.authService, authStore: fx.f.store, identity: fx.f.identity, clock: fx.f.clock, markerDir });
const orgOf = (fx, key = "admin") => fx.f.identity.validateSession(fx.f.sessions[key], { sensitive: false }).user.team_id;

test("记忆排队：太短 / 像密钥的不收，同一轮重复只算一条，一轮最多 5 条；说明文字和「已记住」", () => {
  const m = createAgentMemory({ resourceService: { list: () => ({ ok: true, items: [] }) } });
  assert.equal(m.queue({ taskId: "t1", content: "x" }).error, "MEMORY_EMPTY");
  assert.equal(m.queue({ taskId: "t1", content: "我的 API key: sk-abcdefghijklmnopqrstuvwx" }).error, "MEMORY_LOOKS_SECRET");
  assert.equal(m.queue({ taskId: "t1", content: "密码：hunter2hunter2" }).error, "MEMORY_LOOKS_SECRET");
  assert.equal(m.queue({ content: "没有任务" }).error, "MEMORY_NO_TASK");
  assert.equal(m.queue({ taskId: "t1", content: "用户叫小林" }).ok, true);
  assert.equal(m.queue({ taskId: "t1", content: "用户叫小林" }).duplicate, true);
  for (let i = 0; i < 4; i += 1) assert.equal(m.queue({ taskId: "t1", content: "事实 " + i }).ok, true);
  assert.equal(m.queue({ taskId: "t1", content: "第六条" }).error, "MEMORY_TOO_MANY_THIS_TURN");
  assert.equal(m.pending("t1").length, 5);
  m.discard("t1");
  assert.equal(m.pending("t1").length, 0);
  assert.match(memoryNotes([{ text: "用户叫小林" }]), /memory_save[\s\S]*- 用户叫小林/);
  assert.doesNotMatch(memoryNotes([]), /What you remember/);
  assert.equal(rememberedNote([{ content: "a", duplicate: true }]), "");
  assert.match(rememberedNote([{ content: "用户叫小林" }]), /已记住：用户叫小林/);
});

test("记忆写进资源库：只在 flush 时写；能召回、能搜；重复不再写；别人看不到；授权只补一次，撤掉后不再补", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true });
  try {
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-mem-"));
    const mem = memoryOf(fx, markerDir);
    const ctx = fx.ctx();
    const org = orgOf(fx);
    assert.equal(fx.f.store.appGrantByKey({ appId: "ai", resourceType: "memory", organizationId: org }), null, "默认 ai 应用没有 memory 授权");
    const noMarker = createAgentMemory({ resourceService: fx.f.resourceService, authService: fx.f.authService, authStore: fx.f.store, identity: fx.f.identity });
    assert.deepEqual(await noMarker.recall({ context: ctx }), []);
    assert.equal(fx.f.store.appGrantByKey({ appId: "ai", resourceType: "memory", organizationId: org }), null, "没有标记目录时不自动补授权");
    assert.deepEqual(await mem.recall({ context: ctx }), []);
    assert.ok(fx.f.store.appGrantByKey({ appId: "ai", resourceType: "memory", organizationId: org }), "第一次用到记忆时补授权");
    assert.equal(fs.readdirSync(markerDir).length, 1, "留下一次性标记");

    mem.queue({ taskId: "t1", content: "用户叫小林，喜欢简洁的回答" });
    mem.queue({ taskId: "t1", content: "当前项目是 OpenArc OS" });
    assert.deepEqual(await mem.recall({ context: ctx }), [], "排队不写");
    const saved = await mem.flush({ context: ctx, taskId: "t1" });
    assert.equal(saved.filter((s) => !s.duplicate).length, 2, JSON.stringify(saved));
    const list = fx.f.resourceService.list({ context: fx.f.adminCtx(), filter: { resourceType: "memory" } }).items;
    assert.equal(list.filter((r) => r.memorySubtype === "agent-memory").length, 2, "存成资源库里的 agent-memory");

    const recalled = await mem.recall({ context: ctx });
    assert.deepEqual(recalled.map((r) => r.text).sort(), ["当前项目是 OpenArc OS", "用户叫小林，喜欢简洁的回答"]);
    const found = await mem.search({ context: ctx, query: "小林" });
    assert.equal(found.count, 1);
    assert.match(found.memories[0].text, /小林/);

    mem.queue({ taskId: "t2", content: "用户叫小林，喜欢简洁的回答" });
    const again = await mem.flush({ context: ctx, taskId: "t2" });
    assert.equal(again[0].duplicate, true, "已有的不再写");
    assert.equal((await mem.recall({ context: ctx })).length, 2);

    assert.deepEqual(await mem.recall({ context: fx.ctx("alice") }), [], "别的用户看不到");

    const grant = fx.f.store.appGrantByKey({ appId: "ai", resourceType: "memory", organizationId: org });
    assert.ok(grant);
    fx.f.store.revokeAppGrant(grant.id, { by: "admin" });
    assert.deepEqual(await mem.recall({ context: ctx }), [], "管理员撤掉授权后读不到");
    assert.equal(fx.f.store.appGrantByKey({ appId: "ai", resourceType: "memory", organizationId: org }), null, "撤掉后不会被重新补上");
    assert.deepEqual(await memoryOf(fx, markerDir).recall({ context: ctx }), [], "重启后（新实例同一标记目录）也不补");
    assert.equal(fx.f.store.appGrantByKey({ appId: "ai", resourceType: "memory", organizationId: org }), null);
  } finally { await fx.close(); }
});

test("记忆工具进了只读清单：memory_save 只排队，memory_search 只读", async () => {
  const reg = new ToolRegistry();
  assert.ok(READ_TOOL_IDS.includes("memory.save") && READ_TOOL_IDS.includes("memory.search"));
  assert.ok(!WRITE_TOOL_IDS.includes("memory.save"));
  const m = buildBridgeManifest(reg, { readToolIds: READ_TOOL_IDS, writeToolIds: WRITE_TOOL_IDS });
  assert.equal(m.routes["memory.save"], m.routes["skill.list"]);
  const calls = [];
  const fake = { queue: (a) => { calls.push(a); return { ok: true, queued: 1 }; }, search: async () => ({ memories: [], count: 0 }) };
  const p = createAgentMemoryProvider({ memory: fake });
  const r = await p.execute({ context: {}, args: { content: "用户叫小林" }, contract: { toolId: "memory.save" }, taskId: "task_1" });
  assert.equal(r.ok, true);
  assert.equal(r.result.status, "queued");
  assert.deepEqual(calls, [{ taskId: "task_1", content: "用户叫小林", title: undefined }]);
});

test("真实 dsh：模型调用 memory_save → 本轮成功后写进资源库并在回复里说「已记住」；下一轮首条提示带上这条记忆", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeMaxCalls: 8 });
  try {
    const mem = memoryOf(fx);
    fx.adapters.providers.AgentMemory = createAgentMemoryProvider({ memory: mem });
    fx.grantTool("ai", ["tool.memory.use"]);
    fx.fp.state.toolLoopPlan = [{ id: "call_mem_save", name: "memory_save", args: { content: "用户叫小林，偏好中文回复" } }];
    const orch = fx.makeDshOrchestrator({ memoryContext: null, agentMemory: mem });
    const t = fx.createTask("记住：我叫小林，以后用中文回复");
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.artifact.content, /已记住：用户叫小林，偏好中文回复/);
    const recalled = await mem.recall({ context: fx.ctx() });
    assert.deepEqual(recalled.map((x) => x.text), ["用户叫小林，偏好中文回复"]);

    fx.fp.state.toolLoopPlan = [];
    fx.fp.state.toolLoopBodies.length = 0;
    const t2 = fx.createTask("帮我写一句问候");
    const r2 = await orch.runTask({ context: fx.ctx(), taskId: t2.task.taskId, expectedRevision: t2.task.revision });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.match(fx.fp.state.toolLoopBodies.join("\n"), /用户叫小林，偏好中文回复/, "新对话的首条提示带上了记忆");
    assert.doesNotMatch(r2.artifact.content, /已记住/, "这一轮没记新东西就不说");
  } finally { await fx.close(); }
});
