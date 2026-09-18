/**
 * D4-03 · Approval **推送**隔离（§44）。
 *
 * 读路径（listPending / getApprovalRequest）与决策路径都按"主进程当前 authenticated
 * session"过滤，但推送路径曾经直接转发 runtime 的快照，于是任何已登录会话都会收到
 * **别人任务**的 approval 快照。本用例跑真实 side-effect runtime + 真实 task/call 行 +
 * 产品 registerIdentityIpc 接线，断言推送的可见性与 listPending / getApprovalRequest 一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { IdentityService } = require("../electron/identity-service.cjs");
const { SessionSecretStore, memoryBackend } = require("../electron/session-secret-store.cjs");
const { createSideEffectGateway } = require("../electron/side-effect-bootstrap.cjs");
const { registerIdentityIpc } = require("../electron/identity-bootstrap.cjs");

const TRASH = "resource.trash";
const ABS_PATH_RE = /\/Users\/|\/private\/|\/var\/folders/;
/** approval 推送允许出现的**全部**字段（= approvalSnapshot 白名单，多一个都不行）。 */
const SNAPSHOT_FIELDS = [
  "approvalRequestId", "status", "toolId", "toolDisplayName", "riskClass", "effectClass",
  "targetDisplayName", "resourceRef", "expectedEffects", "expectedVersion", "currentVersion",
  "expiresAt", "requiresApproval",
].sort();

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-03-push-"));
  const fx = await createToolHarnessFixture({
    withAdapters: true,
    dbPath: path.join(root, "identity.db"),
    storeRoot: path.join(root, "library"),
    keepData: true,
    sideEffectRuntimeDir: path.join(root, "runtime"),
  });
  const created = await fx.createResource("Push Isolation Target");
  fx.grantTool("ai", ["tool.resource.trash"]);
  fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] });
  fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
  const run = fx.dshRunSetup(); // A 的真实 RUNNING task / step / run（task.session_ref = A 的会话）
  // 产品装配：main process 的 IdentityService —— 推送过滤读的就是它的 current。
  const service = new IdentityService({ store: fx.f.identity, secrets: new SessionSecretStore(memoryBackend()), allowAdmin: true });
  const pushes = [];
  const handlers = new Map();
  registerIdentityIpc({
    // 只替掉 Electron ipcMain 这一层：gateway / runtime / identity 都是产品实现。
    ipcMain: { handle: (channel, fn) => { handlers.set(channel, fn); } },
    service,
    sideEffect: createSideEffectGateway({ sideEffectRuntime: fx.sideEffectRuntime }),
    sendSideEffect: (payload) => pushes.push(payload),
    isTrusted: () => true,
  });
  /** Renderer 唯一入口（ApprovalPrompt 用的就是它）。 */
  const ipc = (command) => handlers.get("sideeffect:command")({}, command); // async handler → 必须 await
  /** 切换 main process 当前 authenticated session；null = 未登录。 */
  const asSession = (key) => { service.current = key ? fx.f.sessions[key] : null; };
  // §35 duplicate：同一个 step 上同 tool/args 会收敛成同一条 call，多 call 场景必须换 step。
  const propose = (r = run) => fx.sideEffectRuntime.proposeWrite({ context: fx.ctx(), taskId: r.taskId, stepId: r.stepId, runId: r.runId, toolId: TRASH, arguments: { resourceRef: created.resource.resourceRef } });
  const newRun = () => fx.dshRunSetup();
  return {
    fx, service, pushes, ipc, asSession, propose, newRun,
    storeRoot: fx.f.storeRoot,
    sessionA: fx.f.sessions.admin, // A = 任务 owner
    sessionB: fx.f.sessions.alice, // B = 另一个真实用户会话
    async close() {
      try { await fx.close(); } catch { /* ignore */ }
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

test("P1 · 当前会话 = B：A 任务进入 AWAITING_APPROVAL 时推送必须被静默丢弃", async () => {
  const s = await setup();
  try {
    s.asSession("alice"); // B 已登录
    const planned = await s.propose();
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(s.fx.sideEffectStore.callById(planned.approvalRequestId).status, "AWAITING_APPROVAL");
    assert.equal(s.pushes.length, 0, "B 的窗口不得收到 A 任务的推送：" + JSON.stringify(s.pushes));
    assert.deepEqual(await s.ipc({ type: "sideEffect/listPending" }), { ok: true, items: [] });
    const gotB = await s.ipc({ type: "sideEffect/getApprovalRequest", approvalRequestId: planned.approvalRequestId });
    assert.equal(gotB.ok, false, JSON.stringify(gotB));
    assert.equal(gotB.error, "SIDE_EFFECT_CALL_NOT_FOUND");
    // 与底层投影一致：B 会话下该 call 不可投影
    assert.equal(s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned.approvalRequestId, context: { sessionRef: s.sessionB } }), null);
  } finally { await s.close(); }
});

test("P2 · 当前会话 = A（owner）：推送投递，载荷 = 白名单投影且与 getApprovalRequest 一致", async () => {
  const s = await setup();
  try {
    s.asSession("admin");
    const planned = await s.propose();
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(s.pushes.length, 1, "owner 会话必须收到推送");
    const event = s.pushes[0];
    assert.equal(event.type, "sideEffect/approvalRequested");
    assert.deepEqual(Object.keys(event.request).sort(), SNAPSHOT_FIELDS, "推送不得新增/泄露字段");
    assert.equal(event.request.approvalRequestId, planned.approvalRequestId);
    const got = await s.ipc({ type: "sideEffect/getApprovalRequest", approvalRequestId: planned.approvalRequestId });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.deepEqual(event.request, got.request, "推送载荷必须与读路径同一份安全投影");
    const pending = await s.ipc({ type: "sideEffect/listPending" });
    assert.ok(pending.items.some((i) => i.approvalRequestId === planned.approvalRequestId), "owner 必须能在 listPending 里发现它（合法入口不丢）");
    const text = JSON.stringify(event);
    assert.ok(!text.includes(s.storeRoot), "推送不得含 store root");
    assert.ok(!ABS_PATH_RE.test(text), "推送不得含绝对路径");
  } finally { await s.close(); }
});

test("P3 · 会话切回 A 后仍能发现 B 会话期间产生的 pending（挂载查询等价）", async () => {
  const s = await setup();
  try {
    s.asSession("alice");
    const planned = await s.propose();
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(s.pushes.length, 0);
    s.asSession("admin"); // 切回 owner
    const pending = await s.ipc({ type: "sideEffect/listPending" }); // ApprovalPrompt 挂载时走的就是这条命令
    assert.ok(pending.items.some((i) => i.approvalRequestId === planned.approvalRequestId), "owner 不能丢失这条待决请求：" + JSON.stringify(pending));
    const got = await s.ipc({ type: "sideEffect/getApprovalRequest", approvalRequestId: planned.approvalRequestId });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.request.approvalRequestId, planned.approvalRequestId);
  } finally { await s.close(); }
});

test("P4 · 无 authenticated session：不推送、不改任何状态", async () => {
  const s = await setup();
  try {
    s.asSession(null);
    const planned = await s.propose();
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(s.pushes.length, 0, "未登录时不得推送");
    assert.equal(s.fx.sideEffectStore.callById(planned.approvalRequestId).status, "AWAITING_APPROVAL", "静默丢弃不得改状态");
    assert.equal(s.fx.sideEffectStore.approvalsOfCall(planned.approvalRequestId).length, 0);
  } finally { await s.close(); }
});

test("P5 · 决策路径不受影响：owner APPROVE/DENY 正常，非 owner 会话决策仍被拒", async () => {
  const s = await setup();
  try {
    s.asSession("admin");
    const toApprove = await s.propose();
    const approved = await s.ipc({ type: "sideEffect/decideApproval", approvalRequestId: toApprove.approvalRequestId, decision: "APPROVE" });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(approved.status, "APPROVED");
    const toDeny = await s.propose(s.newRun());
    const denied = await s.ipc({ type: "sideEffect/decideApproval", approvalRequestId: toDeny.approvalRequestId, decision: "DENY" });
    assert.equal(denied.ok, true, JSON.stringify(denied));
    assert.equal(denied.status, "BLOCKED");
    // 既有语义：decision 只认 user/role（task owner 或 ADMIN），不认 sessionRef —— 本轮不改。
    const foreign = await s.propose(s.newRun());
    s.asSession("alice");
    const rejected = await s.ipc({ type: "sideEffect/decideApproval", approvalRequestId: foreign.approvalRequestId, decision: "APPROVE" });
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.error, "SIDE_EFFECT_APPROVAL_FORBIDDEN");
    assert.equal(s.fx.sideEffectStore.callById(foreign.approvalRequestId).status, "AWAITING_APPROVAL", "被拒决策不得改 call 状态");
  } finally { await s.close(); }
});

test("P6 · 无 session：读路径空 / not-found，声明了 context 的投影一律 null", async () => {
  const s = await setup();
  try {
    s.asSession(null);
    const planned = await s.propose();
    assert.equal(planned.ok, true, JSON.stringify(planned));
    // 声明了 context 却没有 session：等于未认证窗口，不得放行（修复前这里能拿到完整快照）
    assert.equal(s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned.approvalRequestId, context: {} }), null);
    assert.equal(s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned.approvalRequestId, context: { sessionRef: null } }), null);
    assert.deepEqual(await s.ipc({ type: "sideEffect/listPending" }), { ok: true, items: [] });
    const got = await s.ipc({ type: "sideEffect/getApprovalRequest", approvalRequestId: planned.approvalRequestId });
    assert.equal(got.ok, false, JSON.stringify(got));
    assert.equal(got.error, "SIDE_EFFECT_CALL_NOT_FOUND");
    // gateway 默认 context（不传）同样不得放行
    assert.deepEqual(s.fx.sideEffectRuntime.listPendingApprovals({}), { ok: true, items: [] });
  } finally { await s.close(); }
});

test("P7 · A 会话下读路径正常（正对照）", async () => {
  const s = await setup();
  try {
    s.asSession("admin");
    const planned = await s.propose();
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const pending = await s.ipc({ type: "sideEffect/listPending" });
    assert.ok(pending.items.some((i) => i.approvalRequestId === planned.approvalRequestId), JSON.stringify(pending));
    const got = await s.ipc({ type: "sideEffect/getApprovalRequest", approvalRequestId: planned.approvalRequestId });
    assert.equal(got.ok, true, JSON.stringify(got));
    const snap = s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned.approvalRequestId, context: { sessionRef: s.sessionA } });
    assert.equal(snap && snap.approvalRequestId, planned.approvalRequestId);
  } finally { await s.close(); }
});

test("P8 · context == null 的内部投影语义未变（推送钩子用）", async () => {
  const s = await setup();
  try {
    s.asSession(null); // 内部投影与窗口会话无关
    const planned = await s.propose();
    const internal = s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned.approvalRequestId });
    assert.ok(internal && internal.approvalRequestId === planned.approvalRequestId, "内部无 context 投影保持既有语义");
  } finally { await s.close(); }
});
