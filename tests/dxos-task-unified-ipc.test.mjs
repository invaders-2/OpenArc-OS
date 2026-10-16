/**
 * agent/task/unified-list · IPC 级回归（全离线）。
 *
 * 用例覆盖任务书第 4 条"接入一处真实使用"：
 *   · 命令在 agent:command 白名单内、risk=read、credential=false；
 *   · 真实走 registerAgentIpc → bundle.execute → task-unified-view 全链路；
 *   · 返回同一投影（dx + core），且调用前后两套表行数/哈希不变（只读）；
 *   · source 过滤、limit 越界、依赖缺失各自的真实返回形状。
 *
 * ipcMain / webContents 为假实现；SQLite 走真 IdentityStore；不联网、不写产品数据。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { TaskStore } = require("../electron/task-store.cjs");
const agentDomain = require("../electron/agent-domain.cjs");
const { createAgentBundle } = require("../electron/agent-service.cjs");
const { registerAgentIpc, disposeAgentIpc } = require("../electron/agent-bootstrap.cjs");

const TABLES = ["dx_tasks", "dx_task_steps", "dx_task_events", "tasks", "task_steps", "task_events"];
const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
function snapshot(db) {
  const out = {};
  for (const table of TABLES) {
    const rows = db.prepare("SELECT * FROM " + table + " ORDER BY 1").all();
    out[table] = { count: rows.length, hash: sha256(JSON.stringify(rows)) };
  }
  return out;
}

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { if (handlers.has(channel)) throw new Error("重复注册 handler：" + channel); handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    invoke(channel, event, raw) { const fn = handlers.get(channel); if (!fn) throw new Error("没有 handler：" + channel); return fn(event, raw); },
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-unified-ipc-"));
  dirs.push(dir);
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  let tick = 1_700_000_000_000;
  const clock = () => { tick += 1; return tick; };
  const authStore = { appGrantsForApp: () => [{ appId: "ai", actions: ["files.read", "files.write"] }] };
  const authorization = { resolveActor: () => ({ ok: true, user: { id: "u1", role: "ADMIN", team_id: "org1" }, organizationId: "org1" }) };
  const bundle = createAgentBundle({ identityStore: store, authorization, authStore, modelService: null, userDataDir: dir, clock, dbPath: path.join(dir, "identity.db") });
  const ipcMain = fakeIpcMain();
  const events = [];
  registerAgentIpc({ ipcMain, bundle, send: (event) => events.push(event), isTrusted: (event) => !!event && event.sender === "shell", identity: { current: "session-1" } });
  const okEvent = { sender: "shell", senderFrame: { url: "file:///app/dist/index.html" } };
  const call = (command, payload) => ipcMain.invoke("agent:command", okEvent, { command, payload });
  return { dir, store, bundle, ipcMain, events, call, taskStore: new TaskStore({ identity: store, clock }), dispose: () => { disposeAgentIpc({ ipcMain }); try { store.close(); } catch { /* 已关闭 */ } } };
}

test("命令表：agent/task/unified-list 已登记，risk=read、credential=false、中文摘要", () => {
  assert.equal(agentDomain.isAgentCommand("agent/task/unified-list"), true);
  assert.equal(agentDomain.agentCommandRisk("agent/task/unified-list"), "read");
  assert.equal(agentDomain.agentCommandRequiresCredential("agent/task/unified-list"), false);
  const entry = agentDomain.agentCommandEntry("agent/task/unified-list");
  assert.ok(/[\u4e00-\u9fa5]/.test(entry.summary), "summary 缺中文");
  assert.equal(agentDomain.listAgentCommands().length, 28);
});

test("IPC：unified-list 走真实全链路，返回两套投影且只读（行数/哈希不变）", async () => {
  const s = setup();
  const project = await s.call("agent/project/create", { name: "统一读模型项目", rootNodeId: "root_ipc" });
  assert.equal(project.ok, true);
  const projectId = project.value.project.id;

  const created = await s.call("agent/task/create", { projectId, instruction: "写周报" });
  assert.equal(created.ok, true);
  const dxTaskId = created.value.task.taskId;
  assert.equal(created.value.task.status, "queued");

  // core 侧：同 id 的 DSH/ACP 任务（2 步 + 1 事件），证明两套投影互不污染。
  s.taskStore.insertTask({ taskId: dxTaskId, userId: "u1", appId: "ai", status: "WAITING", goal: "DSH 链路任务", createdAt: 500, updatedAt: 600 });
  s.taskStore.insertStep({ taskId: dxTaskId, sequence: 1, kind: "model", status: "SUCCEEDED" });
  s.taskStore.insertStep({ taskId: dxTaskId, sequence: 2, kind: "model", status: "PENDING" });
  s.taskStore.appendEvent({ taskId: dxTaskId, eventType: "task.waiting", safePayload: { message: "等待用户回答" }, at: 550 });

  const before = snapshot(s.store.connection);
  const res = await s.call("agent/task/unified-list", {});
  assert.equal(res.ok, true);
  assert.equal(res.value.readModel, true);
  assert.match(res.value.boundary, /读模型/);
  assert.equal(res.value.items.length, 2);
  const dx = res.value.items.find((item) => item.source === "dx");
  const core = res.value.items.find((item) => item.source === "core");
  assert.equal(dx.id, dxTaskId);
  assert.equal(dx.title, "写周报");
  assert.equal(dx.status, "PENDING");
  assert.equal(core.id, dxTaskId);
  assert.equal(core.title, "DSH 链路任务");
  assert.equal(core.status, "WAITING");
  assert.equal(core.stepCount, 2);
  assert.equal(core.lastEvent.message, "等待用户回答");
  assert.deepEqual(snapshot(s.store.connection), before, "只读命令改变了表内容");

  // source 过滤 & limit。
  const onlyCore = await s.call("agent/task/unified-list", { source: "core" });
  assert.deepEqual(onlyCore.value.items.map((item) => item.source), ["core"]);
  const limited = await s.call("agent/task/unified-list", { limit: 1 });
  assert.equal(limited.value.items.length, 1);

  // limit 越界 → 结构化 AGENT_INVALID_INPUT（detail 里保留读模型原始码），不是 INTERNAL。
  const bad = await s.call("agent/task/unified-list", { limit: 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, agentDomain.AGENT_ERR_INVALID_INPUT);
  assert.equal(bad.detail.causeCode, "UNIFIED_VIEW_INVALID_INPUT");

  // source 非法同样结构化。
  const badSource = await s.call("agent/task/unified-list", { source: "nope" });
  assert.equal(badSource.ok, false);
  assert.equal(badSource.error, agentDomain.AGENT_ERR_INVALID_INPUT);

  // health 命令数同步（27 → 28）。
  const health = await s.call("agent/health");
  assert.equal(health.value.commands, 28);

  // 只读命令不产生任何拒绝事件（正常返回）。
  assert.ok(s.events.filter((e) => e.kind === "progress").length >= 2);
  s.dispose();
});

test("IPC：db 缺失时命令结构化 AGENT_DEPENDENCY_UNAVAILABLE，不返回假空列表", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-unified-nodb-"));
  dirs.push(dir);
  const authStore = { appGrantsForApp: () => [{ appId: "ai", actions: ["files.read"] }] };
  const authorization = { resolveActor: () => ({ ok: true, user: { id: "u1", role: "ADMIN" } }) };
  const bundle = createAgentBundle({ identityStore: null, authorization, authStore, modelService: null, userDataDir: dir });
  const res = await bundle.execute("agent/task/unified-list", {}, { sessionRef: "s1" });
  assert.equal(res.ok, false);
  assert.equal(res.error, agentDomain.AGENT_ERR_DEPENDENCY_UNAVAILABLE);
  assert.equal(res.detail.causeCode, "UNIFIED_VIEW_DEPENDENCY_UNAVAILABLE");
  assert.equal(res.detail.dependency, "sqlite");
});

// ---------------------------------------------------------------------------
// U2 · 每侧真实计数 + 截断标记（IPC 级）：共享 limit 挤掉一侧时不当成空
// ---------------------------------------------------------------------------

test("IPC：limit 截断时如实返回每侧真实计数与截断标记（不把截断当空）", async () => {
  const s = setup();
  const project = await s.call("agent/project/create", { name: "截断读模型项目", rootNodeId: "root_trunc_ipc" });
  assert.equal(project.ok, true);
  const projectId = project.value.project.id;
  // 两条 DX（clock 递增，较新）+ 一条更老的 core（created_at=1）；limit=2 会把 core 整段挤出 items。
  const first = await s.call("agent/task/create", { projectId, instruction: "dx 一" });
  const second = await s.call("agent/task/create", { projectId, instruction: "dx 二" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  s.taskStore.insertTask({ taskId: "core_trunc_ipc", userId: "u1", appId: "ai", status: "PENDING", goal: "core 老任务", createdAt: 1, updatedAt: 2 });

  const res = await s.call("agent/task/unified-list", { limit: 2 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.counts, { dx: 2, core: 1, total: 3 }, "counts 必须是每侧真实总数，不是取回行数");
  assert.deepEqual(res.value.listed, { dx: 2, core: 0, total: 2 });
  assert.equal(res.value.truncated, true);
  assert.deepEqual(res.value.truncatedSides, ["core"]);
  assert.equal(res.value.items.some((item) => item.source === "core"), false);
  assert.equal(res.value.items.length, 2);

  // 不截断时 counts == listed。
  const full = await s.call("agent/task/unified-list", {});
  assert.deepEqual(full.value.listed, { dx: 2, core: 1, total: 3 });
  assert.equal(full.value.truncated, false);
  assert.deepEqual(full.value.truncatedSides, []);
  s.dispose();
});
