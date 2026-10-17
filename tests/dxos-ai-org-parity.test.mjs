/** task-34 · AI/组织后端对齐（F01/F03/F04/F10/F14/F15/F16）。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const gateway = require("../electron/agent-gateway-entry.cjs");
const { ToolRegistry, BUILTIN_CONTRACTS } = require("../electron/tool-registry.cjs");
const { IdentityStore } = require("../electron/identity-store.cjs");
const schema = require("../electron/dxos-foundation-schema.cjs");
const agentTaskStore = require("../electron/agent-task-store.cjs");
const { ServerAgentToolLoopCoordinator } = require("../electron/agent-runtime-tool-loop.cjs");
const notes = require("../electron/ai-org-parity-notes.cjs");
const { createAgentBundle } = require("../electron/agent-service.cjs");
const { CanvasStore } = require("../electron/canvas-store.cjs");
const { createProjectAgentWorker } = require("../electron/project-agent-worker.cjs");
const { CanvasService } = require("../electron/canvas-service.cjs");

const ACTOR = { id: "u1", role: "ADMIN", team_id: "org1", displayName: "U1" };

function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-ai-org-")); return dir; }

test("F01 · system-jarvis 信封：desktop/jarvis-overlay/profile 固定，身份来自 actor", () => {
  const envelope = gateway.buildJarvisEnvelope({ actor: ACTOR, instruction: "打开音乐并播放", projectId: "p1" });
  assert.equal(envelope.profileId, "system-jarvis");
  assert.deepEqual(envelope.source, { type: "desktop", appId: "agent", entryPoint: "jarvis-overlay" });
  assert.equal(envelope.scope.projectId, "p1");
  assert.equal(envelope.actor.userId, "u1");
  assert.throws(() => gateway.buildJarvisEnvelope({ actor: ACTOR, instruction: "" }), (error) => error.statusCode === 400);
});

test("F01 · capability_discover 披露：客户端工具返回 clientAction，不假称服务端已执行", () => {
  const disclosure = gateway.discloseEntryCapabilities({
    route: { toolDescriptors: [
      { name: "open_app", source: "system", risk: "read", handler: { type: "client" } },
      { name: "file_read", source: "file", risk: "read", handler: { type: "file-tool", toolName: "fs_read" } },
      { name: "media_image_generate", source: "capability", risk: "external", handler: { type: "system-capability", skillId: "media" } },
    ] },
    capabilities: ["app:system:open_app", "app:file:file_read"],
  });
  assert.equal(disclosure.capabilityDiscover.name, "capability_discover");
  assert.deepEqual(disclosure.clientTools.map((tool) => tool.name), ["open_app"]);
  assert.deepEqual(disclosure.serverTools.map((tool) => tool.name), ["file_read", "media_image_generate"]);
  assert.deepEqual(disclosure.capabilities, ["app:system:open_app", "app:file:file_read"]);
});

test("F04 · developer-app：app.<id>.agent.run 校验、固定 boundary、跨 APP/项目/会话拒绝", () => {
  const app = { enabled: true, manifest: { id: "demo", permissions: ["app.demo.agent.run"] } };
  const scope = gateway.assertDeveloperAppScope({ actor: ACTOR, appId: "demo", app, projectId: "p1", payloadAppId: "demo", payloadProjectId: "p1", payloadSessionId: "devapp:demo:user:u1" });
  assert.equal(scope.permission, "app.demo.agent.run");
  assert.deepEqual(scope.capabilityBoundary, ["media.*", "file:*", "app:demo:*"]);
  const envelope = gateway.buildDeveloperAppEnvelope({ actor: ACTOR, app, appId: "demo", instruction: "生成一张图", projectId: "p1" });
  assert.equal(envelope.profileId, "developer-app");
  assert.deepEqual(envelope.source, { type: "app", appId: "demo", entryPoint: "developer-app-bridge" });
  assert.deepEqual(envelope.capabilityBoundary, ["media.*", "file:*", "app:demo:*"]);
  assert.throws(() => gateway.assertDeveloperAppScope({ actor: ACTOR, appId: "demo", app: { enabled: true, manifest: { id: "demo", permissions: [] } }, projectId: "p1" }), (error) => error.statusCode === 403);
  assert.throws(() => gateway.assertDeveloperAppScope({ actor: ACTOR, appId: "demo", app, projectId: "p1", payloadAppId: "other" }), (error) => error.statusCode === 403);
  assert.throws(() => gateway.assertDeveloperAppScope({ actor: ACTOR, appId: "demo", app, projectId: "p1", payloadProjectId: "p2" }), (error) => error.statusCode === 403);
  assert.throws(() => gateway.assertDeveloperAppScope({ actor: ACTOR, appId: "demo", app, projectId: "p1", payloadSessionId: "other" }), (error) => error.statusCode === 403);
  assert.throws(() => gateway.assertDeveloperAppScope({ actor: ACTOR, appId: "demo", app: { ...app, enabled: false }, projectId: "p1" }), (error) => error.statusCode === 403);
});

test("F01 · Harness Tool Registry：桌面/媒体/文件/capability_discover contract 已登记", () => {
  const registry = new ToolRegistry();
  for (const id of ["desktop.open_app", "desktop.music.play", "desktop.music.control", "media.list", "file.read", "capability.discover"]) {
    assert.ok(registry.get(id, 1), "缺少 contract：" + id);
  }
  const open = registry.get("desktop.open_app", 1);
  assert.equal(open.executionProvider, "desktop-client");
  assert.equal(open.riskClass, "READ_ONLY");
  const discover = registry.get("capability.discover", 1);
  assert.equal(discover.executionProvider, "openarc-capability");
  assert.ok(BUILTIN_CONTRACTS.some((contract) => contract.toolId === "capability.discover"));
});

test("F10 · 4 条内置 agent_profiles 种子：可查/enabled/builtin，重复执行不重复插入", () => {
  const dir = tempDir();
  try {
    const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
    try {
      const first = schema.seedAgentProfiles(store.connection);
      assert.equal(first, 4);
      const again = schema.seedAgentProfiles(store.connection);
      assert.equal(again, 0, "种子必须幂等");
      const rows = store.connection.prepare("SELECT id,enabled,builtin,capability_scopes_json,allowed_risks_json FROM agent_profiles ORDER BY id").all();
      assert.deepEqual(rows.map((row) => row.id), ["general", "maker", "researcher", "reviewer"]);
      assert.equal(rows.every((row) => row.enabled === 1 && row.builtin === 1), true);
      assert.match(rows.find((row) => row.id === "reviewer").allowed_risks_json, /read/);
      agentTaskStore.configureAgentTaskStore({ db: store.connection });
      assert.equal(agentTaskStore.latestCheckpoint("missing"), null);
      agentTaskStore.addCheckpoint("task-cp", null, { state: { step: 7 }, observations: [], ledger: [], toolCalls: 2, reviewAttempts: 0, filesChanged: false });
      const saved = agentTaskStore.latestCheckpoint("task-cp");
      assert.equal(saved.state.state.step, 7);
      assert.equal(saved.state.toolCalls, 2);
    } finally { store.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("F15 · 项目角色映射：viewer/editor/manager ↔ owner/member + can_create_tasks", () => {
  assert.equal(agentTaskStore.openArcRoleToDx("manager"), "owner");
  assert.equal(agentTaskStore.openArcRoleToDx("editor"), "member");
  assert.equal(agentTaskStore.openArcRoleToDx("viewer"), "member");
  assert.equal(agentTaskStore.dxRoleToOpenArc("owner"), "manager");
  assert.equal(agentTaskStore.dxRoleToOpenArc("member", true), "editor");
  assert.equal(agentTaskStore.dxRoleToOpenArc("member", false), "viewer");
  assert.equal(agentTaskStore.canCreateTasksForOpenArcRole("manager"), true);
  assert.equal(agentTaskStore.canCreateTasksForOpenArcRole("editor"), true);
  assert.equal(agentTaskStore.canCreateTasksForOpenArcRole("viewer"), false);
});

test("F03 · 0.6.1 无步数上限：maxSteps=null 用 Infinity；snapshot 往返仍恢复 Infinity", () => {
  const coordinator = new ServerAgentToolLoopCoordinator();
  const state = coordinator.create({ runId: "run-1", messages: [], tools: [], maxSteps: null, system: "" });
  assert.equal(state.maxSteps, Infinity);
  const snapshot = coordinator.snapshot("run-1");
  const json = JSON.parse(JSON.stringify(snapshot));
  assert.equal(json.maxSteps, null, "JSON 中 Infinity 落为 null");
  coordinator.delete("run-1");
  const restored = coordinator.restore(json);
  assert.equal(restored.maxSteps, Infinity);
});

test("F03 · 后台 worker：入队/领取/心跳/checkpoint/完成，过期租约不自动重试副作用", async () => {
  const dir = tempDir();
  try {
    const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
    try {
      let tick = 1000;
      const clock = () => tick;
      const worker = createProjectAgentWorker({ db: store.connection, clock, runJob: async () => ({ text: "done" }) });
      const job = worker.enqueue({ projectId: "p1", userId: "u1", instruction: "做一件事" });
      assert.equal(job.status, "queued");
      let seen = null;
      const result = await worker.runOnce("w1");
      assert.equal(result.status, "completed");
      assert.ok(result.id);
      // 再入队一个让 runJob 保存 checkpoint 并返回等待
      worker.enqueue({ projectId: "p1", userId: "u1", instruction: "长任务" });
      const worker2 = createProjectAgentWorker({
        db: store.connection, clock,
        runJob: async (claimed, control) => {
          seen = claimed.id;
          control.saveCheckpoint({ state: { step: 3 } });
          return { waitingForUser: true, question: "继续？" };
        },
      });
      const waiting = await worker2.runOnce("w2");
      assert.equal(waiting.status, "waiting");
      assert.equal(seen, waiting.id);
      assert.match(waiting.checkpoint_json, /step/);
      // 过期 running → 默认 failed（不自动重试已执行副作用）
      const stale = worker2.enqueue({ projectId: "p1", userId: "u1", instruction: "过期" });
      const claimed = worker2.claimNext("w3");
      assert.equal(claimed.id, stale.id);
      tick += 10 * 60 * 1000;
      assert.equal(worker2.recoverExpired(), 1);
      assert.equal(worker2.jobById(stale.id).status, "failed");
    } finally { store.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("F01/F04 · agent/project/run gateway 分支：复用冻结命令面，client 工具返回动作", async () => {
  const dir = tempDir();
  try {
    const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
    try {
      const authorization = { resolveActor: () => ({ ok: true, user: { id: "u1", role: "ADMIN", team_id: "org1" }, organizationId: "org1" }) };
      const fakeRuntime = {
        normalizeEnvelope: (raw, actor) => ({ ...raw, actorId: actor.id }),
        prepare: () => ({ runId: "run-gw", prepared: { trace: { runId: "run-gw" }, systemPromptAdditions: [], route: { tools: [], toolDescriptors: [{ name: "open_app", source: "system", risk: "read", handler: { type: "client" } }] }, capabilities: [{ id: "app:system:open_app" }] } }),
        create: () => {}, start: () => {}, complete: () => {}, fail: () => {}, append: () => {},
      };
      const bundle = createAgentBundle({
        identityStore: store, authorization, authStore: { appGrantsForApp: () => [] }, modelService: null,
        userDataDir: dir, dbPath: path.join(dir, "identity.db"),
        projectAgent: { agentRuntime: fakeRuntime },
      });
      const ctx = { sessionRef: "s1", appId: "agent", requestId: "r1" };
      const jarvis = await bundle.execute("agent/project/run", { gateway: "jarvis", instruction: "打开设置", action: { tool: "open_app", arguments: { app: "settings" } } }, ctx);
      assert.equal(jarvis.ok, true, JSON.stringify(jarvis));
      assert.equal(jarvis.value.gateway, "system-jarvis");
      assert.equal(jarvis.value.execution.clientAction.tool, "open_app");
      assert.equal(jarvis.value.execution.clientAction.arguments.app, "settings");
      assert.equal(jarvis.value.disclosure.capabilityDiscover.name, "capability_discover");

      bundle.configureDeveloperService({ execute: async () => ({ ok: true, value: { enabled: true, manifest: { id: "demo", permissions: ["app.demo.agent.run"] } } }) });
      const dev = await bundle.execute("agent/project/run", { gateway: "developer-app", appId: "demo", instruction: "生成图", action: { tool: "open_app", arguments: {} } }, ctx);
      assert.equal(dev.ok, true, JSON.stringify(dev));
      assert.equal(dev.value.gateway, "developer-app");
      assert.equal(dev.value.sessionId, "devapp:demo:user:u1");
    } finally { store.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("F14/F16 · 记录不适用/有意差异（不实现自动超管与本地计费）", () => {
  assert.equal(notes.AI_ORG_PARITY_NOTES.F16.status, "INTENTIONAL_DIFFERENCE");
  assert.equal(notes.AI_ORG_PARITY_NOTES.F14.status, "NOT_APPLICABLE");
  const preload = fs.readFileSync(path.join(process.cwd(), "electron", "preload.cjs"), "utf8");
  assert.equal(/ensureLocalAdminSession|desktop-session|DX_DESKTOP_AUTH_SECRET/.test(preload), false);
});

test("F15 · 画布邀请运行时：read 邀请可兑换，成员可读不可写", async () => {
  const fx = await createResourceFixture();
  try {
    const canvasStore = new CanvasStore({ identity: fx.identity, clock: fx.clock });
    const service = new CanvasService({ identity: fx.identity, store: canvasStore, resourceStore: fx.resourceStore, resourceService: fx.resourceService, authService: fx.authService, clock: fx.clock });
    const adminCtx = { sessionRef: fx.sessions.admin, appId: "canvas", source: "ui" };
    const aliceCtx = { sessionRef: fx.sessions.alice, appId: "canvas", source: "ui" };
    const created = service.createCanvas({ context: adminCtx, title: "邀请画布" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const invite = service.createCanvasInvite({ context: adminCtx, canvasId: created.canvas.canvasId, permission: "read" });
    assert.equal(invite.ok, true, JSON.stringify(invite));
    const code = invite.code;
    assert.ok(code);
    const redeemed = service.redeemCanvasInvite({ context: aliceCtx, code });
    assert.equal(redeemed.ok, true, JSON.stringify(redeemed));
    const read = service.getCanvas({ context: aliceCtx, canvasId: created.canvas.canvasId });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.canvas.access.canEdit, false, "read 邀请不得给编辑权");
    const write = service.applyCommand({ context: aliceCtx, canvasId: created.canvas.canvasId, baseRevision: read.canvas.revision, command: { type: "node.add", node: { type: "text", x: 0, y: 0, name: "x" } }, actorKind: "USER" });
    assert.equal(write.ok, false);
  } finally { fx.close(); }
});
