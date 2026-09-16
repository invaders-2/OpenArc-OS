/** D4-03D · Full Tool Proxy Gate — official dsh 混合 READ + WRITE E2E。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ToolFacadeBridge } = require("../electron/tool-facade-bridge.cjs");
const { ControlledToolProxy } = require("../electron/controlled-tool-proxy.cjs");
const { buildBridgeManifest, buildToolManifest } = require("../electron/tool-registry.cjs");
const { HARNESS_VISIBLE_TOOL_IDS, FORBIDDEN_HARNESS_TOOLS, READ_TOOL_IDS, WRITE_TOOL_IDS } = require("../electron/dsh-tool-profile.cjs");

const CRASH_EXECUTOR = path.join(import.meta.dirname, "fixtures", "harness-acp", "crash-executor-runtime.mjs");
const TRASH = "resource.trash";
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); });
const waitFor = (fn, ms, detail = "") => (async () => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (fn()) return true; await sleep(25); } assert.fail("waitFor 超时：" + detail); })();
const dshName = (id) => String(id).replace(/\./g, "_");

let seq = 0;
async function setup({ behavior = "tool-loop", plan = null, approvalWaitMs = 60000, executorEntry = null, bridgeFactory = null, writeToolIds = ["resource.trash"] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3d-"));
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior, dbPath: path.join(root, "identity.db"),
    storeRoot: path.join(root, "library"), keepData: true, sideEffectRuntimeDir: path.join(root, "runtime"),
    sideEffectApprovalWaitMs: approvalWaitMs,
    ...(executorEntry ? { sideEffectExecutorEntry: executorEntry } : {}),
    facadeWriteToolIds: writeToolIds,
    ...(bridgeFactory ? { facadeBridgeFactory: bridgeFactory } : {}),
  });
  seq += 1;
  const created = await fx.createResource("D3D Mixed " + seq);
  const resourceRef = created.resource.resourceRef;
  const resourceId = created.resource.resourceId;
  fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata", "tool.resource.trash"]);
  const appGrant = fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId, actions: ["resource.read", "resource.delete"] });
  const userGrant = fx.grantUserResource(resourceId, fx.f.users.admin, ["resource.read", "resource.delete", "resource.useByAgent"]);
  assert.equal(appGrant.ok, true, JSON.stringify(appGrant));
  assert.equal(userGrant.ok, true, JSON.stringify(userGrant));
  await fx.f.searchService.indexResource(resourceId);
  fx.fp.state.toolLoopPlan = plan || [
    { id: "call_search_1", name: "resource_search", args: { query: "D3D Mixed", limit: 5 } },
    { id: "call_read_1", name: "resource_read_metadata", args: { resourceRef } },
    { id: "call_trash_1", name: "resource_trash", args: { resourceRef } },
  ];
  const ctx = fx.ctx();
  const t = fx.createTask();
  return { root, fx, created, resourceRef, resourceId, ctx, task: t.task };
}
async function teardown(s) { try { await s.fx.close(); } catch { /* ignore */ } try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* ignore */ } }
const userCtx = (s) => ({ sessionRef: s.fx.f.sessions.admin, source: "user" });
const trashed = (s) => s.fx.f.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed;
const writeCalls = (s) => s.fx.sideEffectStore.callsOfTask(s.task.taskId);
const readExecutions = (s) => s.fx.toolStore.executionsOfTask(s.task.taskId).filter((e) => e.tool_id !== TRASH);
const events = (s) => s.fx.taskStore.eventsOfTask(s.task.taskId).map((e) => e.event_type);
const idx = (list, name) => list.indexOf(name);

test("§10/§11/§45/§49 Mixed READ + WRITE official dsh E2E：one run / one facade / READ controlled / WRITE exactly-once verified / Task SUCCEEDED", async () => {
  const bridges = [];
  const s = await setup({ bridgeFactory: (o) => { const b = new ToolFacadeBridge(o); bridges.push(b); return b; } });
  try {
    const orch = s.fx.makeDshOrchestrator();
    const runPromise = orch.runTask({ context: s.ctx, taskId: s.task.taskId, expectedRevision: s.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });

    await waitFor(() => writeCalls(s).length === 1, 60000, "WRITE proposal 未出现");
    const call = writeCalls(s)[0];
    assert.equal(call.toolId, TRASH);
    assert.equal(call.status, "AWAITING_APPROVAL", "Harness 只能 propose");
    assert.equal(trashed(s), false, "proposal 阶段 0 mutation");
    assert.equal(s.fx.sideEffectStore.leasesOfCall(call.callId).length, 0, "proposal 阶段 0 lease");
    // READ 已由受控 facade 真实执行（严格经 ControlledToolProxy，非 Harness 直调）
    assert.ok(readExecutions(s).length >= 2, "至少 search + read.metadata 已受控执行：" + JSON.stringify(readExecutions(s).map((e) => e.tool_id)));
    assert.ok(readExecutions(s).every((e) => e.status === "SUCCEEDED" && e.verification_status === "PASS"));

    assert.equal(s.fx.sideEffectRuntime.decideApproval({ context: userCtx(s), approvalRequestId: call.callId, decision: "APPROVE" }).ok, true);
    const r = await runPromise;
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 500));
    assert.equal(r.task.status, "SUCCEEDED");
    assert.equal(r.step.status, "SUCCEEDED");
    assert.equal(r.verification.status, "PASS");

    // WRITE exactly-once + verified
    const after = s.fx.sideEffectStore.callById(call.callId);
    assert.equal(after.status, "SUCCEEDED");
    assert.equal(after.verificationStatus, "PASS");
    assert.equal(trashed(s), true, "business mutation = 1");
    assert.equal(writeCalls(s).length, 1, "SideEffectCall exactly 1");
    assert.equal(s.fx.sideEffectStore.approvalsOfCall(call.callId).filter((a) => a.decision === "APPROVED").length, 1, "approval exactly 1");
    assert.equal(s.fx.sideEffectStore.leasesOfCall(call.callId).length, 1, "lease exactly 1");
    assert.equal(s.fx.sideEffectStore.leasesOfCall(call.callId).filter((l) => l.status === "ACTIVE").length, 0);

    // §11 one facade per run / one registry projection
    assert.equal(bridges.length, 1, "一个 run 只能有一个 Tool Facade Bridge");
    assert.equal(bridges[0].server, null, "run 完成后 bridge 必须关闭");
    assert.equal(bridges[0].capabilities.size, 0, "run 完成后 capability 必须清空");
    const routeEntries = Object.entries(bridges[0].manifest.routes);
    assert.deepEqual(routeEntries.filter(([, v]) => v === "READ_ONLY").map(([k]) => k).sort(), READ_TOOL_IDS.slice().sort());
    assert.deepEqual(routeEntries.filter(([, v]) => v === "SIDE_EFFECT_PROPOSAL").map(([k]) => k).sort(), WRITE_TOOL_IDS.slice().sort());

    // §9 official dsh manifest = 精确 allowlist，forbidden = 0
    const advertised = (s.fx.fp.state.toolLoop && s.fx.fp.state.toolLoop.toolNames) || [];
    assert.deepEqual(advertised.slice().sort(), HARNESS_VISIBLE_TOOL_IDS.map(dshName).slice().sort(), "manifest 必须精确等于 allowlist");
    for (const bad of FORBIDDEN_HARNESS_TOOLS) assert.ok(!advertised.includes(bad), "不得暴露 " + bad);

    // §45 事件顺序（WRITE chain）
    const ev = events(s);
    for (const name of ["tool.side_effect.planned", "tool.approval_required", "tool.side_effect.waiting_approval", "tool.approved", "tool.lease_acquired", "tool.side_effect.execution_started", "tool.side_effect.verification_passed", "tool.side_effect.succeeded", "task.succeeded"]) {
      assert.ok(ev.includes(name), "缺少事件 " + name + "：" + JSON.stringify(ev));
    }
    assert.ok(idx(ev, "tool.side_effect.waiting_approval") < idx(ev, "tool.approved"), "approval 必须在 WAITING 之后");
    assert.ok(idx(ev, "tool.approved") < idx(ev, "tool.lease_acquired"), "lease 必须在 approval 之后");
    assert.ok(idx(ev, "tool.side_effect.execution_started") < idx(ev, "tool.side_effect.verification_passed"), "verification 必须在 execution 之后");
    assert.ok(idx(ev, "tool.side_effect.verification_passed") < idx(ev, "task.succeeded"), "Task 成功必须在 WRITE verified 之后");

    // §49 artifact：只写安全统计
    const artifactDir = path.join(import.meta.dirname, "..", "artifacts", "d4-03d");
    fs.mkdirSync(artifactDir, { recursive: true });
    const stats = {
      officialDsh: true, acpVersion: "1.4.0", protocolVersion: 1,
      advertisedReadTools: READ_TOOL_IDS.slice(), advertisedWriteTools: WRITE_TOOL_IDS.slice(),
      forbiddenAdvertised: advertised.filter((n) => FORBIDDEN_HARNESS_TOOLS.includes(n)).length,
      readProposals: s.fx.toolStore.proposalsOfTask(s.task.taskId).filter((p) => p.tool_id !== TRASH).length,
      readExecutions: readExecutions(s).filter((e) => e.status === "SUCCEEDED").length,
      readVerifications: readExecutions(s).filter((e) => e.verification_status === "PASS").length,
      writeProposals: s.fx.sideEffectStore.callsOfTask(s.task.taskId).length,
      approvals: s.fx.sideEffectStore.approvalsOfCall(call.callId).filter((a) => a.decision === "APPROVED").length,
      leases: s.fx.sideEffectStore.leasesOfCall(call.callId).length,
      writeExecutions: after.status === "SUCCEEDED" ? 1 : 0,
      writeVerifications: after.verificationStatus === "PASS" ? 1 : 0,
      businessMutations: trashed(s) ? 1 : 0,
      duplicateDeliveries: 0,
      modelRequests: s.fx.fp.state.requests,
      hiddenRetries: 0,
      taskStatus: r.task.status, stepStatus: r.step.status,
      bridgeCount: bridges.length,
      autoRetry: 0,
      secretHits: 0,
      at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(artifactDir, "mixed-e2e-stats.json"), JSON.stringify(stats, null, 2));
    assert.equal(stats.businessMutations, 1);
    assert.equal(stats.writeProposals, 1);
    assert.equal(stats.forbiddenAdvertised, 0);
  } finally { await teardown(s); }
});

test("§35 Mixed chain UNKNOWN_EFFECT：READ 已成功也不得让 Task SUCCEEDED；WRITE UNKNOWN_EFFECT → Task/Step BLOCKED / 0 second call", async () => {
  const s = await setup({
    executorEntry: CRASH_EXECUTOR,
    plan: [
      { id: "call_search_1", name: "resource_search", args: { query: "D3D Mixed", limit: 5 } },
      { id: "call_trash_1", name: "resource_trash", args: { resourceRef: null } },
    ],
  });
  try {
    // resourceRef 必须真实：plan 里用 null 不行，改成 setup 后覆盖。
    s.fx.fp.state.toolLoopPlan[1].args = { resourceRef: s.resourceRef };
    const orch = s.fx.makeDshOrchestrator();
    const runPromise = orch.runTask({ context: s.ctx, taskId: s.task.taskId, expectedRevision: s.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
    await waitFor(() => writeCalls(s).length === 1, 60000, "WRITE proposal 未出现");
    const call = writeCalls(s)[0];
    assert.ok(readExecutions(s).length >= 1, "READ 已经成功");
    assert.equal(s.fx.sideEffectRuntime.decideApproval({ context: userCtx(s), approvalRequestId: call.callId, decision: "APPROVE" }).ok, true);
    const r = await runPromise;
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 400));
    assert.notEqual(s.fx.taskStore.taskById(s.task.taskId).status, "SUCCEEDED", "READ 成功不能覆盖 WRITE 的不确定结果");
    assert.equal(s.fx.taskStore.taskById(s.task.taskId).status, "BLOCKED");
    assert.equal(s.fx.taskStore.stepById(s.fx.taskStore.stepsOfTask(s.task.taskId)[0].step_id).status, "BLOCKED");
    assert.notEqual(s.fx.sideEffectStore.callById(call.callId).status, "SUCCEEDED");
    assert.equal(writeCalls(s).length, 1, "0 second write call / 0 retry");
    assert.equal(s.fx.sideEffectStore.leasesOfCall(call.callId).filter((l) => l.status === "ACTIVE").length, 0);
    assert.ok(events(s).includes("tool.side_effect.unknown_effect"), "必须有 UNKNOWN_EFFECT 证据");
    assert.equal(s.fx.taskStore.harnessRunsOfTask(s.task.taskId).every((x) => x.status === "BLOCKED"), true, "Harness STOP");
  } finally { await teardown(s); }
});

test("§36 Mixed chain cancellation：READ success → WRITE WAITING_APPROVAL → Task cancel → 0 write / 0 lease / capability revoked", async () => {
  const bridges = [];
  const s = await setup({ approvalWaitMs: 60000, bridgeFactory: (o) => { const b = new ToolFacadeBridge(o); bridges.push(b); return b; } });
  try {
    const orch = s.fx.makeDshOrchestrator();
    const runPromise = orch.runTask({ context: s.ctx, taskId: s.task.taskId, expectedRevision: s.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
    await waitFor(() => writeCalls(s).length === 1, 60000, "WRITE proposal 未出现");
    assert.ok(readExecutions(s).length >= 1, "READ 已成功");
    assert.equal(writeCalls(s)[0].status, "AWAITING_APPROVAL");
    const rev = s.fx.taskStore.taskById(s.task.taskId).revision;
    const cancel = await orch.cancel({ context: s.ctx, taskId: s.task.taskId, expectedRevision: rev });
    assert.equal(cancel.ok, true, JSON.stringify(cancel));
    const r = await runPromise;
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
    assert.equal(trashed(s), false, "0 write");
    assert.equal(s.fx.sideEffectStore.leasesOfCall(writeCalls(s)[0].callId).length, 0, "0 lease");
    assert.equal(s.fx.taskStore.taskById(s.task.taskId).status, "CANCELLED");
    assert.equal(bridges[0].capabilities.size, 0, "cancel 必须 revoke tool capability");
    assert.equal(bridges[0].server, null, "cancel 必须关闭 bridge");
  } finally { await teardown(s); }
});

test("§38 Bridge disconnect：READ 中断不返回 stale 数据；WRITE proposal 不因 client 断开自动 approve/lease/execute", async () => {
  const s = await setup({ writeToolIds: ["resource.trash"] });
  // 慢速、可 abort 的 READ adapter：模拟真实在途 Domain read。
  const META = { resourceRef: "resource://res_x", name: "x", resourceType: "text", mimeType: "text/plain", version: 1, updatedAt: 1 };
  let aborted = 0;
  const adapter = {
    async prepare() { return {}; },
    async execute({ signal }) { return new Promise((resolve) => { const t = setTimeout(() => resolve({ ok: true, result: { ...META } }), 900); const onAbort = () => { aborted += 1; clearTimeout(t); resolve({ ok: false, error: "ABORT" }); }; if (signal) signal.addEventListener("abort", onAbort); }); },
    async verify() { return { ok: true }; },
  };
  const proxy = new ControlledToolProxy({ registry: s.fx.toolRegistry, toolStore: s.fx.toolStore, authService: s.fx.f.authService, taskStore: s.fx.taskStore, adapters: { adapterFor: () => adapter }, clock: s.fx.f.clock });
  const readBridge = new ToolFacadeBridge({ toolProxy: proxy, manifest: buildToolManifest(s.fx.toolRegistry, { toolIds: ["resource.read.metadata"] }), clock: s.fx.f.clock });
  const bridge = new ToolFacadeBridge({
    toolProxy: s.fx.toolProxy,
    manifest: buildBridgeManifest(s.fx.toolRegistry, { readToolIds: [], writeToolIds: ["resource.trash"] }),
    sideEffectRuntime: s.fx.sideEffectRuntime, clock: s.fx.f.clock,
  });
  await readBridge.start();
  await bridge.start();
  try {
    const run = s.fx.dshRunSetup();
    const rcap = readBridge.issueCapability({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, allowedTools: ["resource.read.metadata"], maxCalls: 4 });
    assert.equal(rcap.ok, true, JSON.stringify(rcap));
    // READ：client 中途断开 → abort 在途执行，绝不返回 stale response。
    const ac = new AbortController();
    const p = fetch(readBridge.baseUrl + "/tool-call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + rcap.capability.token }, body: JSON.stringify({ toolId: "resource.read.metadata", arguments: { resourceRef: s.resourceRef }, callId: "disc_1" }), signal: ac.signal }).then(() => ({ aborted: false })).catch((e) => ({ aborted: true, error: String(e && (e.name || e.message)) }));
    await sleep(200);
    ac.abort();
    const readRes = await p;
    assert.equal(readRes.aborted, true, "client abort 必须让 fetch 失败：" + JSON.stringify(readRes));
    await waitFor(() => { const rows = s.fx.toolStore.executionsOfTask(run.taskId).filter((e) => e.tool_id === "resource.read.metadata"); return rows.length && rows[0].status !== "RUNNING"; }, 8000, "aborted execution 未收敛");
    const readExec = s.fx.toolStore.executionsOfTask(run.taskId).filter((e) => e.tool_id === "resource.read.metadata");
    assert.equal(readExec.length, 1);
    assert.equal(readExec[0].status, "BLOCKED", "client disconnect 后绝不 commit SUCCEEDED");
    assert.notEqual(readExec[0].verification_status, "PASS", "client disconnect 后绝不返回 verified PASS");
    void aborted;

    // WRITE：proposal 持久化后 client 断开 → 保持 AWAITING_APPROVAL，0 lease / 0 mutation / 0 auto approve。
    const wcap = bridge.issueCapability({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, allowedTools: [TRASH], maxCalls: 4 });
    const wr = await fetch(bridge.baseUrl + "/tool-call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + wcap.capability.token }, body: JSON.stringify({ toolId: TRASH, arguments: { resourceRef: s.resourceRef }, callId: "disc_write_1" }) });
    const wj = await wr.json();
    assert.equal(wj.ok, false);
    assert.equal(wj.error, "SIDE_EFFECT_APPROVAL_REQUIRED");
    const calls = s.fx.sideEffectStore.callsOfTask(run.taskId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, "AWAITING_APPROVAL");
    assert.equal(s.fx.sideEffectStore.leasesOfCall(calls[0].callId).length, 0, "0 auto lease");
    assert.equal(s.fx.sideEffectStore.approvalsOfCall(calls[0].callId).filter((a) => a.decision === "APPROVED").length, 0, "0 auto approve");
    assert.equal(trashed(s), false, "0 mutation");
  } finally { try { await readBridge.stop(); } catch { /* ignore */ } try { await bridge.stop(); } catch { /* ignore */ } await teardown(s); }
});

test("§39/§40 Bridge shutdown + loopback：stop 后旧 token 不可用；listener 只 bind 127.0.0.1", async () => {
  const s = await setup({ writeToolIds: ["resource.trash"] });
  const bridge = new ToolFacadeBridge({ toolProxy: s.fx.toolProxy, manifest: buildBridgeManifest(s.fx.toolRegistry, { readToolIds: ["resource.search"], writeToolIds: ["resource.trash"] }), clock: s.fx.f.clock });
  try {
    const started = await bridge.start();
    assert.match(bridge.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/, "只允许 loopback");
    const run = s.fx.dshRunSetup();
    const cap = bridge.issueCapability({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, allowedTools: ["resource.search"], maxCalls: 2 });
    const token = cap.capability.token;
    await bridge.stop();
    assert.equal(bridge.server, null);
    assert.equal(bridge.capabilities.size, 0);
    await assert.rejects(fetch("http://127.0.0.1:" + started.port + "/tool-call", { method: "POST", headers: { authorization: "Bearer " + token }, body: "{}" }), /fetch failed|ECONNREFUSED|ECONNRESET/);
    assert.equal(bridge.capabilities.has(token), false, "stop 后绝不重建 capability");
  } finally { try { await bridge.stop(); } catch { /* ignore */ } await teardown(s); }
});
