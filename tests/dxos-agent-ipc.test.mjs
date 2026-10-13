/**
 * B3 · Agent 域 IPC 回归测试（全离线）。
 *
 * 覆盖任务书 B3 第 9 条：
 *   ① 命令表白名单与 risk / credential 属性（electron/agent-domain.cjs）
 *   ② trusted(event) 拒绝伪造 sender（electron/agent-bootstrap.cjs）
 *   ③ 未白名单命令被拒且无副作用（不触碰任何表）
 *   ④ agent:event 信封字段（P1）与 sequence 单调
 *   ⑤ 返回值不含密钥与绝对路径（走真实 task/get 指令）
 *   ⑥ disposeAgentIpc 后可重复注册
 * 另加：真实命令烟测（project / task / run / tool / memory / health）与依赖未接时的结构化拒绝
 *       （fsAdapter=B6 未落地、modelResolver 未注入）。
 *
 * 全部离线：SQLite 走真实 IdentityStore（临时目录文件库，agent_* 表由 v23 迁移建立）；
 * ipcMain / webContents 为假实现；actor 由假 authorization.resolveActor 提供，
 * 不触网、不写入任何产品数据。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const agentDomain = require("../electron/agent-domain.cjs");
const { createAgentBundle } = require("../electron/agent-service.cjs");
const { registerAgentIpc, disposeAgentIpc } = require("../electron/agent-bootstrap.cjs");

const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

/** 假 ipcMain：与 Electron 同形（handle / removeHandler），重复注册即抛错。 */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { if (handlers.has(channel)) throw new Error("重复注册 handler：" + channel); handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    invoke(channel, event, raw) { const fn = handlers.get(channel); if (!fn) throw new Error("没有 handler：" + channel); return fn(event, raw); },
  };
}

function setup({ grants = ["files.read", "files.write"], actorId = "u1" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-b3-ipc-"));
  dirs.push(dir);
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  let tick = 1_700_000_000_000;
  const clock = () => { tick += 1; return tick; };
  const authStore = { appGrantsForApp: () => [{ appId: "ai", actions: [...grants] }] };
  const authorization = { resolveActor: () => ({ ok: true, user: { id: actorId, role: "ADMIN", team_id: "org1" }, organizationId: "org1" }) };
  const bundle = createAgentBundle({ identityStore: store, authorization, authStore, modelService: null, userDataDir: dir, clock, dbPath: path.join(dir, "identity.db") });
  const ipcMain = fakeIpcMain();
  const events = [];
  const register = (options = {}) => registerAgentIpc({ ipcMain, bundle, send: (event) => events.push(event), isTrusted: (event) => !!event && event.sender === "shell", identity: { current: "session-1" }, ...options });
  register();
  const okEvent = { sender: "shell", senderFrame: { url: "file:///app/dist/index.html" } };
  const call = (command, payload) => ipcMain.invoke("agent:command", okEvent, { command, payload });
  const countTasks = () => store.connection.prepare("SELECT COUNT(*) AS n FROM dx_tasks").get().n;
  return { dir, store, bundle, ipcMain, events, okEvent, call, register, countTasks, close: () => { try { store.close(); } catch { /* 已关闭 */ } } };
}

// ---------------------------------------------------------------------------
// ① 命令表白名单与 risk / credential
// ---------------------------------------------------------------------------

const REQUIRED_COMMANDS = [
  "agent/task/create", "agent/task/list", "agent/task/get", "agent/task/events", "agent/task/answer",
  "agent/task/continue", "agent/task/pause", "agent/task/cancel", "agent/task/resume", "agent/task/delete",
  "agent/task/trace", "agent/task/stats",
  "agent/run/get", "agent/run/inspect", "agent/run/list",
  "agent/tool/catalog", "agent/tool/describe", "agent/tool/call",
  "agent/capability/route",
  "agent/project/create", "agent/project/list", "agent/project/snapshot",
  "agent/memory/list", "agent/memory/save",
  "agent/react/run",
  "agent/health",
];

test("命令表：26 条白名单齐备，risk ∈ read|use|manage|destructive，credential 为布尔且中文摘要", () => {
  const keys = Object.keys(agentDomain.AGENT_COMMANDS).sort();
  assert.deepEqual(keys, [...REQUIRED_COMMANDS].sort());
  assert.equal(keys.length, 26);
  for (const [command, entry] of Object.entries(agentDomain.AGENT_COMMANDS)) {
    assert.ok(["read", "use", "manage", "destructive"].includes(entry.risk), command + " risk=" + entry.risk);
    assert.equal(typeof entry.credential, "boolean", command + " credential 非布尔");
    assert.ok(typeof entry.summary === "string" && entry.summary.length > 0 && /[\u4e00-\u9fa5]/.test(entry.summary), command + " summary 缺中文");
  }
  assert.equal(agentDomain.agentCommandRequiresCredential("agent/tool/call"), true);
  assert.equal(agentDomain.agentCommandRequiresCredential("agent/task/list"), false);
  assert.equal(agentDomain.agentCommandRisk("agent/task/delete"), "destructive");
  assert.equal(agentDomain.agentCommandRisk("agent/run/list"), "read");
  assert.equal(agentDomain.agentCommandRisk("agent/不存在"), null);
  assert.equal(agentDomain.isAgentCommand("agent/health"), true);
  assert.equal(agentDomain.isAgentCommand("credential/getRaw"), false);
});

// ---------------------------------------------------------------------------
// ② trusted(event) 拒绝伪造 sender
// ---------------------------------------------------------------------------

test("IPC：trusted(event) 拒绝伪造 sender，且未注入 isTrusted 一律 Forbidden", async () => {
  const s = setup();
  const forged = { sender: "evil", senderFrame: { url: "file:///app/dist/index.html" } };
  await assert.rejects(() => s.ipcMain.invoke("agent:command", forged, { command: "agent/health" }), /Forbidden/);
  await assert.rejects(() => s.ipcMain.invoke("agent:command", { sender: "evil", senderFrame: { url: "file:///app/dist/index.html" } }, { command: "agent/task/create", payload: { projectId: "p", instruction: "x" } }), /Forbidden/);
  // 被拒路径不得产生任何副作用 / 事件
  assert.equal(s.countTasks(), 0);
  assert.equal(s.events.length, 0);

  // 缺 isTrusted：新通道也应 fail closed，而不是默认放行
  const raw = fakeIpcMain();
  registerAgentIpc({ ipcMain: raw, bundle: s.bundle, send: () => {} });
  await assert.rejects(() => raw.invoke("agent:command", s.okEvent, { command: "agent/health" }), /Forbidden/);
});

// ---------------------------------------------------------------------------
// ③ 未白名单命令被拒且无副作用
// ---------------------------------------------------------------------------

test("IPC：未白名单命令返回 AGENT_COMMAND_NOT_ALLOWED 且不触碰任何表", async () => {
  const s = setup();
  const before = s.countTasks();
  const res = await s.call("credential/getRaw");
  assert.equal(res.ok, false);
  assert.equal(res.error, agentDomain.AGENT_ERR_COMMAND_NOT_ALLOWED);
  assert.equal(s.countTasks(), before);
  const projectRows = s.store.connection.prepare("SELECT COUNT(*) AS n FROM projects").get().n;
  assert.equal(projectRows, 0);

  // bundle.execute 直调同样拒绝（不依赖 bootstrap 的预检）
  const direct = await s.bundle.execute("agent/未知命令", {}, { sessionRef: "s1" });
  assert.equal(direct.ok, false);
  assert.equal(direct.error, agentDomain.AGENT_ERR_COMMAND_NOT_ALLOWED);
});

// ---------------------------------------------------------------------------
// ④ agent:event 信封字段与 sequence 单调
// ---------------------------------------------------------------------------

test("事件：agent:event 为 P1 信封（channel/domain/kind/sequence/at/payload），sequence 严格单调", async () => {
  const s = setup();
  await s.call("agent/health");
  await s.call("agent/task/list");
  assert.ok(s.events.length >= 4, "至少应有 begin/completed 各两条");
  const fields = ["channel", "domain", "kind", "sequence", "at", "payload"];
  s.events.forEach((event, index) => {
    assert.ok(event && typeof event === "object", "事件 " + index + " 非对象");
    for (const field of fields) assert.ok(field in event, "事件 " + index + " 缺字段 " + field);
    assert.equal(event.channel, "agent:event");
    assert.equal(event.domain, "agent");
    assert.ok(["progress", "log", "approval"].includes(event.kind), "kind=" + event.kind);
    assert.equal(typeof event.sequence, "number");
    assert.equal(typeof event.at, "number");
    assert.ok(event.payload && typeof event.payload === "object");
  });
  const sequences = s.events.map((event) => event.sequence);
  for (let index = 1; index < sequences.length; index += 1) assert.ok(sequences[index] > sequences[index - 1], "sequence 非单调：" + sequences.join(","));
  assert.deepEqual(s.events.filter((event) => event.kind === "progress").slice(0, 2).map((event) => event.payload.phase), ["begin", "completed"]);
});

// ---------------------------------------------------------------------------
// ⑤ 返回值不含密钥与绝对路径
// ---------------------------------------------------------------------------

test("脱敏：返回值不含绝对路径 / 裸密钥，也不出现凭据字段名", async () => {
  const s = setup();
  const project = await s.call("agent/project/create", { name: "脱敏项目", rootNodeId: "root_redact" });
  assert.equal(project.ok, true);
  const SECRET = "sk-TEST0123456789SECRET";
  // 路径与密钥分开断言：foundation 的 POSIX 路径正则会吞掉同行的后续文本，
  // 混在一条里无法证明密钥形态替换本身生效。
  const withPath = await s.call("agent/task/create", { projectId: project.value.project.id, instruction: "请读取 /Users/wepingli/secret.txt 的内容" });
  assert.equal(withPath.ok, true);
  const pathJson = JSON.stringify(await s.call("agent/task/get", { taskId: withPath.value.task.taskId }));
  assert.equal(pathJson.includes("/Users/"), false, "返回值带出了绝对路径");
  assert.match(pathJson, /<path>/);

  const withSecret = await s.call("agent/task/create", { projectId: project.value.project.id, instruction: "调用模型时使用 api_key: " + SECRET });
  assert.equal(withSecret.ok, true);
  const secretJson = JSON.stringify(await s.call("agent/task/get", { taskId: withSecret.value.task.taskId }));
  assert.equal(secretJson.includes(SECRET), false, "返回值带出了裸密钥");
  assert.match(secretJson, /<redacted>/);

  const got = await s.call("agent/task/get", { taskId: withSecret.value.task.taskId });
  assert.equal(Object.prototype.hasOwnProperty.call(got.value.task, "api_key"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(got.value.task, "credentialRef"), false);
});

// ---------------------------------------------------------------------------
// ⑥ dispose 后可重复注册
// ---------------------------------------------------------------------------

test("生命周期：disposeAgentIpc 后 handler 移除，可重复注册；重复 dispose 不抛", async () => {
  const s = setup();
  assert.equal(s.ipcMain.handlers.has("agent:command"), true);
  disposeAgentIpc({ ipcMain: s.ipcMain });
  assert.equal(s.ipcMain.handlers.has("agent:command"), false);
  s.register();
  assert.equal(s.ipcMain.handlers.has("agent:command"), true);
  const res = await s.call("agent/health");
  assert.equal(res.ok, true);
  disposeAgentIpc({ ipcMain: s.ipcMain });
  disposeAgentIpc({ ipcMain: s.ipcMain });
  assert.equal(s.ipcMain.handlers.has("agent:command"), false);
  // 重新注册再次可用
  s.register();
  assert.equal((await s.call("agent/health")).ok, true);
});

// ---------------------------------------------------------------------------
// 真实命令烟测 + 结构化依赖拒绝
// ---------------------------------------------------------------------------

test("真实命令：project/task/run/tool/memory/health 全链路，B6 未接的路径结构化拒绝", async () => {
  const s = setup();
  const project = await s.call("agent/project/create", { name: "烟测项目", rootNodeId: "root_smoke" });
  assert.equal(project.ok, true);
  const projectId = project.value.project.id;

  const created = await s.call("agent/task/create", { projectId, instruction: "写一份周报" });
  assert.equal(created.ok, true);
  const taskId = created.value.task.taskId;
  assert.equal(created.value.task.status, "queued");

  const list = await s.call("agent/task/list", { projectId });
  assert.equal(list.ok, true);
  assert.ok(list.value.items.some((item) => item.taskId === taskId));

  const events = await s.call("agent/task/events", { taskId });
  assert.equal(events.ok, true);
  assert.ok(events.value.items.length >= 1, "createTask 至少写一条 task.created 事件");

  const trace = await s.call("agent/task/trace", { taskId });
  assert.equal(trace.ok, true);
  assert.equal(trace.value.id, taskId);

  const stats = await s.call("agent/task/stats", {});
  assert.equal(stats.ok, true);
  assert.ok(Array.isArray(stats.value.byStatus));

  const runs = await s.call("agent/run/list", {});
  assert.equal(runs.ok, true);
  assert.ok(Array.isArray(runs.value.items));

  const missingRun = await s.call("agent/run/get", { runId: "run-not-exist" });
  assert.equal(missingRun.ok, false);
  assert.equal(missingRun.error, agentDomain.AGENT_ERR_NOT_FOUND);

  const catalog = await s.call("agent/tool/catalog", {});
  assert.equal(catalog.ok, true);
  assert.ok(catalog.value.descriptors.length > 0);
  assert.ok(catalog.value.descriptors.some((item) => item.name === "fs_read"));

  const describe = await s.call("agent/tool/describe", { tool: "fs_read" });
  assert.equal(describe.ok, true);
  assert.equal(describe.value.descriptor.name, "fs_read");
  assert.equal(describe.value.permission.allowed, true);

  // B6 fsAdapter 未落地：解析通过，但执行在产生副作用之前结构化拒绝
  const called = await s.call("agent/tool/call", { tool: "fs_read", arguments: { path: "a.txt" } });
  assert.equal(called.ok, false);
  assert.equal(called.error, agentDomain.AGENT_ERR_DEPENDENCY_UNAVAILABLE);
  assert.equal(called.detail.dependency, "fsAdapter");

  // 未授予的权限：授权适配器按保守策略拒绝，工具不可描述（不静默放行）
  const denied = await s.call("agent/tool/describe", { tool: "music_play" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, agentDomain.AGENT_ERR_FORBIDDEN);
  assert.equal(denied.detail.permission, "music.play");

  const memory = await s.call("agent/memory/save", { projectId, content: "项目记忆一" });
  assert.equal(memory.ok, true);
  const memories = await s.call("agent/memory/list", { projectId });
  assert.equal(memories.ok, true);
  assert.ok(memories.value.items.some((item) => item.content === "项目记忆一"));

  const snapshot = await s.call("agent/project/snapshot", { projectId });
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.error, agentDomain.AGENT_ERR_DEPENDENCY_UNAVAILABLE);

  const route = await s.call("agent/capability/route", { instruction: "生成一段介绍" });
  assert.equal(route.ok, false);
  assert.equal(route.error, agentDomain.AGENT_ERR_DEPENDENCY_UNAVAILABLE);

  const react = await s.call("agent/react/run", { taskId });
  assert.equal(react.ok, true);
  assert.equal(react.value.outcome.kind, "failed");
  assert.equal(react.value.outcome.code, agentDomain.AGENT_ERR_DEPENDENCY_UNAVAILABLE);

  const health = await s.call("agent/health");
  assert.equal(health.ok, true);
  assert.equal(health.value.status, "ok");
  assert.equal(health.value.dependencies.db, true);
  assert.equal(health.value.dependencies.modelAdapter, false);
  assert.equal(health.value.dependencies.fsAdapter, false);
  assert.equal(health.value.commands, 26);
  assert.equal(health.value.eventChannel, "agent:event");
});


test("任务状态机：pause → continue → resume → answer → cancel → delete 逐条可用", async () => {
  const s = setup();
  const project = await s.call("agent/project/create", { name: "状态机项目", rootNodeId: "root_state" });
  const projectId = project.value.project.id;

  const task = await s.call("agent/task/create", { projectId, instruction: "整理会议纪要" });
  const taskId = task.value.task.taskId;
  const paused = await s.call("agent/task/pause", { taskId });
  assert.equal(paused.ok, true);
  assert.equal(paused.value.task.status, "paused");
  const continued = await s.call("agent/task/continue", { taskId, message: "再补充一条结论" });
  assert.equal(continued.ok, true);
  assert.equal(continued.value.task.status, "queued");

  // answer 只接受 waiting_user：用真实 store 把任务置到该状态（等价 worker 写入），再走命令
  s.store.connection.prepare("UPDATE dx_tasks SET status='waiting_user', waiting_question=? WHERE id=?").run("继续吗", taskId);
  const answered = await s.call("agent/task/answer", { taskId, answer: "继续" });
  assert.equal(answered.ok, true);
  assert.equal(answered.value.task.status, "queued");

  const cancelled = await s.call("agent/task/cancel", { taskId });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.value.task.status, "cancelled");

  const resumable = await s.call("agent/task/create", { projectId, instruction: "第二个任务" });
  const resumableId = resumable.value.task.taskId;
  assert.equal((await s.call("agent/task/pause", { taskId: resumableId })).value.task.status, "paused");
  const resumed = await s.call("agent/task/resume", { taskId: resumableId });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.value.task.status, "queued");

  const deleted = await s.call("agent/task/delete", { taskId: resumableId });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.value.deleted, true);
  const gone = await s.call("agent/task/get", { taskId: resumableId });
  assert.equal(gone.ok, false);
  assert.equal(gone.error, agentDomain.AGENT_ERR_NOT_FOUND);
});

test("鉴权：resolveActor 失败时不派发命令，返回 AGENT_UNAUTHENTICATED", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-b3-auth-"));
  dirs.push(dir);
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  const bundle = createAgentBundle({
    identityStore: store,
    authorization: { resolveActor: () => ({ ok: false, error: "SESSION_EXPIRED" }) },
    authStore: null, modelService: null, userDataDir: dir,
  });
  const result = await bundle.execute("agent/task/list", {}, { sessionRef: "expired" });
  assert.equal(result.ok, false);
  assert.equal(result.error, agentDomain.AGENT_ERR_UNAUTHENTICATED);
  assert.equal(store.connection.prepare("SELECT COUNT(*) AS n FROM dx_tasks").get().n, 0);
  store.close();
});
