import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "node_modules/.cache/oa-canvas-agent-state-" + process.pid + ".mjs");
const values = new Map();
const localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null; },
  setItem(key, value) { values.set(key, String(value)); },
  removeItem(key) { values.delete(key); },
};
const downloads = [];
globalThis.localStorage = localStorage;
globalThis.window = globalThis;
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
globalThis.dispatchEvent = () => true;
globalThis.document = { createElement(tag) { assert.equal(tag, "a"); return { href: "", download: "", click() { downloads.push(this.download); } }; } };
globalThis.URL.createObjectURL = () => "blob:legacy-export";
globalThis.URL.revokeObjectURL = () => {};

await esbuild.build({ entryPoints: [path.join(ROOT, "src/canvas/canvas-next/agent/state.ts")], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent" });
const { AgentState } = await import(pathToFileURL(OUT).href);
after(() => fs.rmSync(OUT, { force: true }));
afterEach(() => { values.clear(); downloads.length = 0; delete globalThis.openarc; });
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function backend() {
  let userId = "user-a";
  let listener = null;
  const memories = [];
  const skills = [];
  const tasks = [];
  let sequence = 0;
  let failMemory = null;
  const api = {
    identity: { onEvent(callback) { listener = callback; return () => { listener = null; }; } },
    resource: { command: async (request) => {
      if (request.type === "resource/query") return { ok: true, items: memories.filter((row) => row.owner === userId).map(({ text, ...row }) => row) };
      if (request.type === "resource/readText") {
        const row = memories.find((item) => item.owner === userId && item.resourceRef === request.resourceRef);
        return row ? { ok: true, text: row.text } : { ok: false, error: "NOT_FOUND" };
      }
      if (request.type === "resource/create") {
        if (failMemory === request.content) { failMemory = null; return { ok: false, error: "INJECTED_FAILURE" }; }
        const row = { owner: userId, resourceRef: "resource://memory/" + (++sequence), text: request.content, memorySubtype: request.memorySubtype, attributes: request.attributes };
        memories.push(row); return { ok: true, resource: row };
      }
      if (request.type === "resource/delete") {
        const index = memories.findIndex((item) => item.owner === userId && item.resourceRef === request.resourceRef);
        if (index < 0) return { ok: false, error: "NOT_FOUND" };
        memories.splice(index, 1); return { ok: true };
      }
      return { ok: false, error: "UNKNOWN_RESOURCE_COMMAND" };
    } },
    skill: { command: async ({ command, payload }) => {
      if (command === "skill/list") return { ok: true, value: { items: skills.filter((skill) => skill.ownerUserId === userId) } };
      if (command === "skill/save") {
        const id = payload.skill.id;
        const existing = skills.find((skill) => skill.id === id && skill.ownerUserId === userId);
        if (existing) Object.assign(existing, payload.skill);
        else skills.push({ ...payload.skill, ownerUserId: userId, enabled: true });
        return { ok: true, value: {} };
      }
      return { ok: false, error: "UNKNOWN_SKILL_COMMAND" };
    } },
    task: { command: async ({ command, payload }) => {
      if (command === "task/list") return { ok: true, items: tasks.filter((task) => task.owner === userId).map((task) => ({ taskId: task.taskId })) };
      if (command === "task/get") {
        const task = tasks.find((item) => item.owner === userId && item.taskId === payload.taskId);
        return task ? { ok: true, task: task.task, steps: task.steps, artifacts: task.artifacts || [] } : { ok: false, error: "TASK_FORBIDDEN" };
      }
      return { ok: false, error: "UNKNOWN_TASK_COMMAND" };
    } },
  };
  return {
    api, memories, skills, tasks,
    get userId() { return userId; },
    set userId(value) { userId = value; },
    switchTo(value) { userId = value; listener && listener({ snapshot: { userId: value } }); },
    failMemoryOnce(value) { failMemory = value; },
  };
}

function canvasTask(owner, taskId, goal, canvasId = "canvas-1") {
  return { owner, taskId, task: { taskId, goal, status: "SUCCEEDED", createdAt: 1, updatedAt: 2 }, steps: [{ input: { type: "canvas.task.v1", canvasId } }], artifacts: [{ content: "done-" + taskId }] };
}

test("2A · AgentState 的记忆、Skill、Task 按账号和画布隔离，旧共享键不自动读取", async () => {
  const be = backend(); globalThis.openarc = be.api;
  values.set("canvas-next:mem:user", JSON.stringify(["legacy-must-not-autoload"]));
  be.memories.push({ owner: "user-b", resourceRef: "resource://memory/b", text: "B private", memorySubtype: "personal-preference", attributes: { scope: "user", canvasId: null } });
  be.skills.push({ id: "b_skill", name: "B skill", ownerUserId: "user-b", enabled: true });
  be.tasks.push(canvasTask("user-a", "task-a", "A conversation"), canvasTask("user-a", "task-other", "Other canvas", "canvas-2"), canvasTask("user-b", "task-b", "B conversation"));
  const state = new AgentState("canvas-1"); await flush();
  assert.deepEqual(state.memUser, []);
  assert.equal(state.memUser.some((row) => row.text.includes("legacy")), false);
  assert.deepEqual(state.convs.map((row) => row.id), ["task-a"]);
  await state.addMemory("user", "A preference");
  await state.addMemory("canvas", "A canvas fact");
  await state.saveSkills({ id: "a_skill", name: "A skill", desc: "A", kw: "a", md: "prompt", src: "我的", on: true }, true);
  assert.equal(state.memUser[0].text, "A preference");
  assert.equal(state.memCanvas[0].canvasId, "canvas-1");
  assert.equal(state.skills[0].id, "a_skill");

  be.switchTo("user-b"); await flush();
  assert.deepEqual(state.memUser.map((row) => row.text), ["B private"]);
  assert.deepEqual(state.memCanvas, []);
  assert.deepEqual(state.skills.map((row) => row.id), ["b_skill"]);
  assert.deepEqual(state.convs.map((row) => row.id), ["task-b"]);
  be.switchTo("user-a"); await flush();
  assert.deepEqual(state.memUser.map((row) => row.text), ["A preference"]);
  assert.deepEqual(state.skills.map((row) => row.id), ["a_skill"]);
  state.dispose();
});

test("2A · 身份切换使旧的延迟加载响应失效，不覆盖新账号", async () => {
  const be = backend();
  const firstQuery = deferred();
  let queries = 0;
  const resource = be.api.resource.command;
  be.api.resource.command = async (request) => {
    if (request.type === "resource/query" && ++queries === 1) return firstQuery.promise;
    return resource(request);
  };
  be.memories.push({ owner: "user-a", resourceRef: "resource://memory/stale-a", text: "stale A", memorySubtype: "personal-preference", attributes: { scope: "user", canvasId: null } });
  globalThis.openarc = be.api;
  const state = new AgentState("canvas-1");
  be.switchTo("user-b");
  firstQuery.resolve({ ok: true, items: [{ resourceRef: "resource://memory/stale-a", memorySubtype: "personal-preference", attributes: { scope: "user" } }] });
  await flush();
  assert.equal(be.userId, "user-b");
  assert.deepEqual(state.memUser, []);
  assert.equal(state.memUser.some((row) => row.text === "stale A"), false);
  state.dispose();
});

test("2A · 显式导入失败保留旧数据，重试幂等；旧对话仅导出且不创建 Task", async () => {
  const be = backend(); globalThis.openarc = be.api;
  values.set("canvas-next:mem:user", JSON.stringify(["fact-one", "fact-two"]));
  values.set("canvas-next:mem:canvas:canvas-1", JSON.stringify(["canvas-fact"]));
  values.set("canvas-next:skills:mine", JSON.stringify([{ id: "legacy_skill", name: "Legacy skill", desc: "Legacy", kw: "legacy", md: "prompt", src: "我的", on: true }]));
  values.set("canvas-next:convs:canvas-1", JSON.stringify([{ id: "legacy-conv", title: "Legacy", msgs: [], at: 1 }]));
  const state = new AgentState("canvas-1"); await flush();
  be.failMemoryOnce("fact-two");
  await state.importLegacy();
  assert.match(state.importState, /导入未完成/);
  assert.equal(be.memories.filter((row) => row.text === "fact-one").length, 1);
  assert.equal(be.memories.some((row) => row.text === "fact-two"), false);
  assert.equal(be.skills.length, 0);
  assert.ok(values.has("canvas-next:mem:user"));
  assert.ok(values.has("canvas-next:skills:mine"));
  assert.equal(be.tasks.length, 0);
  assert.equal(downloads.length, 0);

  await state.importLegacy();
  assert.match(state.importState, /^已导入/);
  assert.equal(be.memories.filter((row) => row.text === "fact-one").length, 1);
  assert.equal(be.memories.filter((row) => row.text === "fact-two").length, 1);
  assert.equal(be.memories.filter((row) => row.text === "canvas-fact").length, 1);
  assert.equal(be.skills.filter((row) => row.id === "legacy_skill").length, 1);
  assert.equal(be.skills[0].ownerUserId, "user-a");
  assert.equal(be.tasks.length, 0);
  assert.deepEqual(downloads, ["canvas-canvas-1-legacy-conversations.json"]);
  assert.ok(values.has("canvas-next:convs:canvas-1"));
  await state.importLegacy();
  assert.equal(be.memories.length, 3);
  assert.equal(be.skills.length, 1);
  state.dispose();
});

test("2A · 导入途中切换账号会停止后续写入", async () => {
  const be = backend(); globalThis.openarc = be.api;
  values.set("canvas-next:mem:user", JSON.stringify(["a-one", "a-two"]));
  const state = new AgentState("canvas-1"); await flush();
  const created = be.api.resource.command;
  be.api.resource.command = async (request) => {
    const result = await created(request);
    if (request.type === "resource/create") be.switchTo("user-b");
    return result;
  };
  await state.importLegacy();
  assert.equal(be.memories.filter((row) => row.owner === "user-a").length, 1);
  assert.equal(be.memories.filter((row) => row.owner === "user-b").length, 0);
  state.dispose();
});
