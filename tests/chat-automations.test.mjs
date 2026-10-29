/**
 * 对话「自动化」：chat_task 动作（全局 AI 新开对话执行一条提示词）。
 *   ① 定义规约：提示词必填 / 模型 id 校验 / 最短 5 分钟间隔 / 多余参数丢弃
 *   ② 执行：调用 chatTask 适配器，运行记录里落 taskId；适配器缺失时结构化失败
 *   ③ registerTaskIpc.runAsCurrentUser：只有自动化所属用户在登录时才开对话
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const domain = require("../electron/automation-domain.cjs");
const store = require("../electron/automation-store.cjs");
const { createAutomationBundle } = require("../electron/automation-service.cjs");
const { registerTaskIpc } = require("../electron/task-bootstrap.cjs");

const BASE = Date.UTC(2026, 9, 29, 0, 0, 0);
const USER = "u-chat-auto";
const tmpDirs = [];
const openStores = [];
afterEach(() => {
  store.resetAutomationStoreForTests();
  while (openStores.length) { try { openStores.pop().close(); } catch { /* ignore */ } }
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function openBundle(bundle = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-auto-"));
  tmpDirs.push(dir);
  const idStore = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(idStore);
  return createAutomationBundle(Object.assign({
    identityStore: idStore,
    authorization: { resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: USER } } : { ok: false }) },
    clock: () => BASE,
    sleeper: async () => {},
  }, bundle));
}
const invoke = (bundle, command, payload) => bundle.execute(command, payload || {}, { sessionRef: "sess", requestId: "req" });
const def = (args, schedule = { type: "daily", hour: 9, minute: 0 }) => ({ title: "早报", instruction: "x", schedule, action: { type: "chat_task", args } });

test("chat_task 定义规约", () => {
  const ok = domain.normalizeDefinition(def({ prompt: "  搜一下新闻  ", modelConfigId: "cfg_1", junk: 1 }), { now: BASE });
  assert.deepEqual(ok.action, { type: "chat_task", args: { prompt: "搜一下新闻", modelConfigId: "cfg_1" } });
  const noModel = domain.normalizeDefinition(def({ prompt: "p", modelConfigId: "../bad id" }), { now: BASE });
  assert.deepEqual(noModel.action.args, { prompt: "p" });
  assert.throws(() => domain.normalizeDefinition({ ...def({ prompt: "" }), instruction: "" }, { now: BASE }), /要让 AI 做的事/);
  assert.throws(() => domain.normalizeDefinition(def({ prompt: "p" }, { type: "interval", everyMs: 60000 }), { now: BASE }), /5 分钟/);
  assert.equal(domain.isServerAutomationAction({ type: "chat_task" }), false, "不走集成授权闸门");
});

test("chat_task 执行：调用适配器并把 taskId 记进运行记录", async () => {
  const calls = [];
  const bundle = openBundle({ chatTask: { run: async (prompt, options) => { calls.push({ prompt, options }); return { taskId: "task_123", status: "SUCCEEDED", text: "完成" }; } } });
  const created = await invoke(bundle, "automation/create", { definition: def({ prompt: "写早报", modelConfigId: "cfg_9" }) });
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.value.automation.id;
  const ran = await invoke(bundle, "automation/runNow", { automationId: id, await: true });
  assert.equal(ran.ok, true, JSON.stringify(ran));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, "写早报");
  assert.equal(calls[0].options.userId, USER);
  assert.equal(calls[0].options.modelConfigId, "cfg_9");
  assert.equal(calls[0].options.title, "早报");
  const run = store.listRuns(USER, { automationId: id })[0];
  assert.equal(run.status, "success");
  assert.equal(JSON.parse(run.result).output.taskId, "task_123");
});

test("chat_task：适配器拒绝 / 缺失都如实失败", async () => {
  const refusing = openBundle({ chatTask: { run: async () => { const e = new Error("需要登录创建这条自动化的账号"); e.code = "TASK_NOT_SIGNED_IN"; throw e; } } });
  const a = await invoke(refusing, "automation/create", { definition: def({ prompt: "p" }) });
  const r = await invoke(refusing, "automation/runNow", { automationId: a.value.automation.id, await: true });
  assert.equal(r.ok, false);
  assert.match(r.message, /需要登录/);
  assert.equal(store.listRuns(USER, {})[0].status, "failed");
  store.resetAutomationStoreForTests();

  const bare = openBundle();
  const b = await invoke(bare, "automation/create", { definition: def({ prompt: "p" }) });
  const r2 = await invoke(bare, "automation/runNow", { automationId: b.value.automation.id, await: true });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "AGENT_DEPENDENCY_UNAVAILABLE");
  assert.equal(r2.detail.dependency, "chatTask");
});

test("runAsCurrentUser：只给自动化所属的已登录用户开对话", async () => {
  const sent = [];
  let created = 0;
  const taskService = {
    authService: { resolveActor: ({ context }) => (context.sessionRef === "sess-owner" ? { ok: true, user: { id: USER } } : context.sessionRef ? { ok: true, user: { id: "someone-else" } } : { ok: false }) },
    modelService: { resolveModel: () => ({ ok: true, snapshot: { modelConfigId: "cfg_default" } }) },
    createTask: ({ context, goal, modelConfigId }) => { created += 1; return { ok: true, task: { taskId: "t" + created, status: "PENDING", revision: 1, goal, modelConfigId, source: context.source } }; },
  };
  const orchestrator = { runTask: async ({ taskId }) => ({ ok: true, task: { taskId, status: "SUCCEEDED", goal: "g" }, artifact: { type: "text", content: "答" } }) };
  const identity = { current: "sess-owner" };
  const ipcMain = { handle() {}, removeHandler() {} };
  const runner = registerTaskIpc({ ipcMain, taskService, orchestrator, identity, isTrusted: () => true, send: (e) => sent.push(e) });
  const ok = runner.runAsCurrentUser({ userId: USER, goal: "做事" });
  assert.equal(ok.ok, true);
  const settled = await ok.settled;
  assert.equal(settled.task.status, "SUCCEEDED");
  assert.ok(sent.some((e) => e.type === "task/created" && e.taskId === ok.taskId), "通知界面刷新对话列表");
  assert.ok(sent.some((e) => e.type === "task/result" && e.taskId === ok.taskId));

  identity.current = "sess-other";
  assert.deepEqual(runner.runAsCurrentUser({ userId: USER, goal: "做事" }), { ok: false, error: "TASK_NOT_SIGNED_IN" });
  identity.current = null;
  assert.deepEqual(runner.runAsCurrentUser({ userId: USER, goal: "做事" }), { ok: false, error: "TASK_NOT_SIGNED_IN" });
  assert.equal(created, 1);
});
