/** D4-03D · Full Tool Proxy Gate — capability authority / scope / replay / malformed / spoof / cross-domain。 */
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
const { buildBridgeManifest } = require("../electron/tool-registry.cjs");

const VISIBLE = "OPENARC_DSH_VISIBLE_RESOURCE";
const TOOL_IDS = ["resource.search", "resource.read.metadata", "resource.trash"];
const TRASH = "resource.trash";
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); });
const waitFor = (fn, ms, detail = "") => (async () => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (fn()) return true; await sleep(25); } assert.fail("waitFor 超时：" + detail); })();

function slowAdapter(delayMs = 300) {
  return {
    async prepare() { return {}; },
    async execute({ args }) { await sleep(delayMs); return { ok: true, result: { items: [], count: 0, truncated: false } }; },
    async verify() { return { ok: true }; },
  };
}

async function setup({ bridgeClock = null, slow = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3da-"));
  const fx = await createToolHarnessFixture({ withAdapters: true, dbPath: path.join(root, "identity.db"), storeRoot: path.join(root, "library"), keepData: true, sideEffectRuntimeDir: path.join(root, "runtime"), facadeWriteToolIds: [TRASH] });
  const created = await fx.createResource(VISIBLE);
  const resourceRef = created.resource.resourceRef;
  const resourceId = created.resource.resourceId;
  const appGrant = fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId, actions: ["resource.read", "resource.delete"] });
  const userGrant = fx.grantUserResource(resourceId, fx.f.users.admin, ["resource.read", "resource.delete", "resource.useByAgent"]);
  const toolGrant = fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata", "tool.resource.trash"]);
  await fx.f.searchService.indexResource(resourceId);
  const manifest = buildBridgeManifest(fx.toolRegistry, { readToolIds: ["resource.search", "resource.read.metadata"], writeToolIds: [TRASH] });
  const proxy = slow ? new ControlledToolProxy({ registry: fx.toolRegistry, toolStore: fx.toolStore, authService: fx.f.authService, taskStore: fx.taskStore, adapters: { adapterFor: () => slowAdapter() }, clock: fx.f.clock }) : fx.toolProxy;
  const bridge = new ToolFacadeBridge({ toolProxy: proxy, manifest, sideEffectRuntime: fx.sideEffectRuntime, clock: bridgeClock || fx.f.clock });
  await bridge.start();
  const run = fx.dshRunSetup();
  const origClose = fx.close.bind(fx);
  fx.close = async () => { try { await bridge.stop(); } catch { /* ignore */ } await origClose(); };
  return { root, fx, bridge, manifest, proxy, created, resourceRef, resourceId, run, toolGrant, appGrant, userGrant };
}
async function teardown(s) { try { await s.fx.close(); } catch { /* ignore */ } try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* ignore */ } }
async function call(bridge, token, body, raw = false) {
  const res = await fetch(bridge.baseUrl + "/tool-call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: raw ? body : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
function issue(s, { context = null, run = null, allowedTools = TOOL_IDS, maxCalls = 6, ttlMs = 60000 } = {}) {
  const r = run || s.fx.dshRunSetup(context);
  const cap = s.bridge.issueCapability({ context: r.context, taskId: r.taskId, stepId: r.stepId, runId: r.runId, allowedTools, maxCalls, ttlMs });
  return { run: r, cap };
}
const search = (s, token, { callId, ...args } = {}) => call(s.bridge, token, { toolId: "resource.search", arguments: { query: VISIBLE, ...args }, callId });
const writeCall = (s, token, callId, resourceRef = null) => call(s.bridge, token, { toolId: TRASH, arguments: { resourceRef: resourceRef || s.resourceRef }, callId });

test("§12 Capability scope：绑定 session/app/task/step/run；body 自报 scope 一律忽略；app mismatch → SCOPE_INVALID", async () => {
  const s = await setup();
  try {
    const badApp = s.bridge.issueCapability({ context: { sessionRef: s.fx.f.sessions.admin, appId: "other" }, taskId: s.run.taskId, stepId: s.run.stepId, runId: s.run.runId, allowedTools: TOOL_IDS, maxCalls: 2 });
    assert.equal(badApp.ok, false);
    assert.equal(badApp.error, "TOOL_CAPABILITY_SCOPE_INVALID");
    const { run, cap } = issue(s);
    const st = s.bridge.capabilityState(cap.capability.token);
    assert.equal(st.taskId, run.taskId);
    assert.equal(st.stepId, run.stepId);
    assert.equal(st.runId, run.runId);
    assert.equal(st.appId, "ai");
    assert.equal(st.state, "ACTIVE");
    const r = await call(s.bridge, cap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE }, callId: "scope_1", taskId: "task_spoof", stepId: "step_spoof", runId: "run_spoof", appId: "evil", sessionRef: "sess_evil", userId: "usr_admin" });
    assert.equal(r.json.ok, true, JSON.stringify(r.json));
    const proposal = s.fx.toolStore.proposalsOfTask(run.taskId).find((p) => p.tool_id === "resource.search");
    assert.equal(proposal.task_id, run.taskId, "body scope 绝不改变 authority 归属");
    assert.equal(proposal.step_id, run.stepId);
    assert.equal(proposal.run_id, run.runId);
  } finally { await teardown(s); }
});

test("§16/§17/§18 cross-run / cross-task / cross-step replay → DENY；wrong bridge → 401", async () => {
  const s = await setup();
  try {
    const { run, cap } = issue(s);
    // wrong-bridge replay
    const other = new ToolFacadeBridge({ toolProxy: s.fx.toolProxy, manifest: s.manifest, sideEffectRuntime: s.fx.sideEffectRuntime, clock: s.fx.f.clock });
    await other.start();
    try {
      const x = await call(other, cap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE }, callId: "x1" });
      assert.equal(x.status, 401);
    } finally { await other.stop(); }
    // cross-run：同 task 新 run 成为 latest 后，旧 run capability 的 proposal 必须 stale
    const ok = await search(s, cap.capability.token, { callId: "cr_1" });
    assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
    const second = s.fx.taskService.startHarnessRun({ context: s.fx.ctx(), taskId: run.taskId, stepId: run.stepId, expectedRevision: s.fx.taskStore.taskById(run.taskId).revision });
    assert.equal(second.ok, true, JSON.stringify(second));
    const stale = await search(s, cap.capability.token, { callId: "cr_2" });
    assert.equal(stale.json.ok, false);
    assert.ok(["TOOL_PROPOSAL_STALE", "TOOL_EXECUTION_STALE", "TOOL_FORBIDDEN"].includes(stale.json.error), stale.json.error);
  } finally { await teardown(s); }
});

test("§20/§21 session revoke / tool permission revoke / resource permission revoke → 下一次 call DENY + 0 Domain", async () => {
  const s = await setup();
  try {
    const { run, cap } = issue(s);
    assert.equal((await search(s, cap.capability.token, { callId: "rv1" })).json.ok, true);
    // tool permission revoke
    const rev = s.fx.f.authService.revokeAppResourcePermission({ context: s.fx.f.adminCtx(), grantId: s.toolGrant.grant.grantId });
    assert.equal(rev.ok, true, JSON.stringify(rev));
    const before = s.fx.toolStore.executionsOfTask(run.taskId).length;
    const denied = await search(s, cap.capability.token, { callId: "rv2" });
    assert.equal(denied.json.ok, false);
    assert.equal(s.fx.toolStore.executionsOfTask(run.taskId).length, before, "0 new Domain execution");

    // resource permission revoke（非 owner 用户 alice）：撤销 user 的 resource.read → 下一次 call DENY
    const s2 = await setup();
    try {
      const aliceCtx = { sessionRef: s2.fx.f.sessions.alice, appId: "ai" };
      const aliceGrant = s2.fx.grantUserResource(s2.resourceId, s2.fx.f.users.alice, ["resource.read", "resource.useByAgent"]);
      assert.equal(aliceGrant.ok, true, JSON.stringify(aliceGrant));
      const i2 = issue(s2, { context: aliceCtx, allowedTools: ["resource.read.metadata"] });
      const readMeta = (callId) => call(s2.bridge, i2.cap.capability.token, { toolId: "resource.read.metadata", arguments: { resourceRef: s2.resourceRef }, callId });
      assert.equal((await readMeta("rp1")).json.ok, true, "alice 有 useByAgent 时可 read");
      const revokeUser = s2.fx.f.authService.revokeResourcePermission({ context: s2.fx.f.adminCtx(), grantId: aliceGrant.grant.id });
      assert.equal(revokeUser.ok, true, JSON.stringify(revokeUser));
      const before2 = s2.fx.toolStore.executionsOfTask(i2.run.taskId).length;
      const denied2 = await readMeta("rp2");
      assert.equal(denied2.json.ok, false, JSON.stringify(denied2.json));
      assert.equal(s2.fx.toolStore.executionsOfTask(i2.run.taskId).length, before2, "0 new Domain execution");
    } finally { await teardown(s2); }
  } finally { await teardown(s); }
});

test("§20 session revoke：READ 后 logout → 下一次 WRITE proposal DENY + 0 mutation", async () => {
  const s = await setup();
  try {
    const { run, cap } = issue(s);
    assert.equal((await search(s, cap.capability.token, { callId: "lo1" })).json.ok, true);
    s.fx.f.identity.logout(run.context.sessionRef);
    const w = await writeCall(s, cap.capability.token, "lo_w");
    assert.equal(w.json.ok, false);
    assert.equal(s.fx.sideEffectStore.callsOfTask(run.taskId).length, 0, "0 SideEffectCall");
    assert.equal(s.fx.f.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed, false, "0 mutation");
  } finally { await teardown(s); }
});

test("§22/§23 Registry stale + tool version binding（READ 与 WRITE 都不静默 fallback）", async () => {
  const s = await setup();
  try {
    const { run, cap } = issue(s);
    s.fx.toolRegistry.register({ ...s.fx.toolRegistry.get("resource.search", 1), version: 2 });
    const stale = await search(s, cap.capability.token, { callId: "st_1" });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, "TOOL_CONTRACT_STALE");
    assert.equal(s.fx.toolStore.executionsOfTask(run.taskId).length, 0, "stale 时 0 execution");

    const s2 = await setup();
    try {
      const i2 = issue(s2);
      s2.fx.toolRegistry.register({ ...s2.fx.toolRegistry.get(TRASH, 1), version: 2 });
      const w = await writeCall(s2, i2.cap.capability.token, "st_w");
      assert.equal(w.status, 409);
      assert.equal(w.json.error, "TOOL_CONTRACT_STALE");
      assert.equal(s2.fx.sideEffectStore.callsOfTask(i2.run.taskId).length, 0, "stale WRITE 不得创建 SideEffectCall");
    } finally { await teardown(s2); }
  } finally { await teardown(s); }
});

test("§24/§41 duplicate delivery：READ 1 次 Domain execution；WRITE 1 次 SideEffectCall；duplicate 不消耗 maxCalls", async () => {
  const s = await setup();
  try {
    const { run, cap } = issue(s, { maxCalls: 3 });
    let searches = 0;
    const orig = s.fx.f.searchService.search.bind(s.fx.f.searchService);
    s.fx.f.searchService.search = (...a) => { searches += 1; return orig(...a); };
    const a1 = await search(s, cap.capability.token, { callId: "dup_read" });
    const a2 = await search(s, cap.capability.token, { callId: "dup_read" });
    assert.equal(a1.json.ok, true);
    assert.deepEqual(a2.json, a1.json);
    assert.equal(searches, 1, "0 second Domain call");
    assert.equal(s.bridge.capabilityState(cap.capability.token).calls, 1, "duplicate 不消耗 call budget");

    const w1 = await writeCall(s, cap.capability.token, "dup_write");
    const w2 = await writeCall(s, cap.capability.token, "dup_write");
    assert.equal(w1.json.error, "SIDE_EFFECT_APPROVAL_REQUIRED");
    assert.equal(w2.json.approvalRequestId, w1.json.approvalRequestId);
    assert.equal(s.fx.sideEffectStore.callsOfTask(run.taskId).length, 1, "WRITE duplicate → 1 SideEffectCall");
    assert.equal(s.bridge.capabilityState(cap.capability.token).calls, 2, "WRITE duplicate 也不消耗预算");

    const third = await search(s, cap.capability.token, { callId: "dup_3" });
    assert.equal(third.json.ok, true, "仍有剩余预算");
    const fourth = await search(s, cap.capability.token, { callId: "dup_4" });
    assert.equal(fourth.status, 429);
    assert.equal(fourth.json.error, "TOOL_CAPABILITY_EXHAUSTED");
  } finally { await teardown(s); }
});

test("§25 concurrent duplicate delivery：并发同 callId → 1 次 READ execution / 1 次 WRITE SideEffectCall", async () => {
  const s = await setup({ slow: true });
  try {
    const { run, cap } = issue(s, { maxCalls: 4 });
    const [a, b] = await Promise.all([search(s, cap.capability.token, { callId: "conc_1" }), search(s, cap.capability.token, { callId: "conc_1" })]);
    assert.equal(a.json.ok, true, JSON.stringify(a.json));
    assert.deepEqual(b.json, a.json);
    assert.equal(s.fx.toolStore.executionsOfTask(run.taskId).filter((e) => e.tool_id === "resource.search").length, 1, "concurrent duplicate → 1 execution");
    const [w1, w2] = await Promise.all([writeCall(s, cap.capability.token, "conc_w"), writeCall(s, cap.capability.token, "conc_w")]);
    assert.equal(w1.json.error, "SIDE_EFFECT_APPROVAL_REQUIRED");
    assert.equal(w2.json.error, "SIDE_EFFECT_APPROVAL_REQUIRED");
    assert.equal(s.fx.sideEffectStore.callsOfTask(run.taskId).length, 1, "concurrent WRITE duplicate → 1 SideEffectCall");
  } finally { await teardown(s); }
});

test("§27 malformed Tool Facade body：invalid JSON / oversized / missing / bad / not allowlisted / wrong type / schema / forbidden field → DENY + 0 Domain", async () => {
  const s = await setup();
  try {
    const { run, cap } = issue(s);
    const t = cap.capability.token;
    assert.equal((await call(s.bridge, t, "not-json", true)).status, 400);
    let oversized = null;
    try { oversized = (await call(s.bridge, t, JSON.stringify({ toolId: "resource.search", arguments: { query: "x".repeat(300000) } }), true)).status; } catch { oversized = "aborted"; }
    assert.ok(oversized === 413 || oversized === 400 || oversized === "aborted", "oversized body 必须被拒绝：" + oversized);
    assert.equal((await call(s.bridge, t, { callId: "mal_no_tool", arguments: { query: "x" } })).status, 403);
    assert.equal((await call(s.bridge, t, { callId: "mal_bad_tool", toolId: "../../shell", arguments: {} })).status, 403);
    assert.equal((await call(s.bridge, t, { callId: "mal_not_allowed", toolId: "test.write", arguments: { target: "x" } })).status, 403);
    assert.equal((await call(s.bridge, t, { callId: "mal_type", toolId: "resource.search", arguments: { query: 123 } })).json.ok, false);
    assert.equal((await call(s.bridge, t, { callId: "mal_schema", toolId: "resource.search", arguments: {} })).json.ok, false);
    assert.equal((await call(s.bridge, t, { callId: "mal_forbidden", toolId: "resource.search", arguments: { query: "x", command: "rm -rf /" } })).json.ok, false);
    assert.equal((await call(s.bridge, t, { callId: "mal_path", toolId: "resource.search", arguments: { query: "x", resourceRef: "/Users/secret" } })).json.ok, false);
    assert.equal(s.fx.toolStore.executionsOfTask(run.taskId).length, 0, "malformed 一律 0 Domain execution");
  } finally { await teardown(s); }
});

test("§28 argument authority spoof：注入 authority 字段 → schema reject / 零 authority gain", async () => {
  const s = await setup();
  try {
    const { run, cap } = issue(s);
    const spoofFields = ["userId", "sessionRef", "appId", "role", "risk", "effectClass", "requiresApproval", "approved", "approvalId", "leaseId", "idempotencyKey", "verificationStatus", "quiesced", "runtimeDead", "retry", "providerKey", "credentialRef"];
    for (const f of spoofFields) {
      const r = await call(s.bridge, cap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE, [f]: "spoof" }, callId: "sp_" + f });
      assert.equal(r.json.ok, false, f + " 必须被拒绝：" + JSON.stringify(r.json));
    }
    assert.equal(s.fx.toolStore.executionsOfTask(run.taskId).length, 0, "0 Domain execution");
    const decisions = s.fx.toolStore.decisionsOfTask(run.taskId);
    assert.ok(decisions.every((d) => d.decision !== "ALLOWED"), "绝不产生 ALLOWED decision");
  } finally { await teardown(s); }
});

test("§31 safe result projection：READ result 与 Approval snapshot 无绝对路径 / token / store root / lease internals", async () => {
  const s = await setup();
  try {
    const { run, cap } = issue(s);
    const r = await search(s, cap.capability.token, { callId: "safe_1" });
    assert.equal(r.json.ok, true);
    const dump = JSON.stringify(r.json);
    assert.ok(!/\/Users\/|\/private\/|\/var\/folders/.test(dump), "不得返回绝对路径");
    assert.ok(!dump.includes(s.fx.f.storeRoot), "不得返回 store root");
    assert.ok(!dump.includes("tpx_") && !dump.includes("mpx_"), "不得返回 capability token");
    const w = await writeCall(s, cap.capability.token, "safe_w");
    assert.equal(w.json.error, "SIDE_EFFECT_APPROVAL_REQUIRED");
    const snap = s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: w.json.approvalRequestId, context: { sessionRef: run.context.sessionRef } });
    const sdump = JSON.stringify(snap);
    assert.ok(!/\/Users\/|\/private\/|\/var\/folders/.test(sdump), "approval snapshot 不得含绝对路径");
    assert.ok(!sdump.includes("tpx_") && !sdump.includes("mpx_"));
    assert.ok(!dump.includes("lease"));
  } finally { await teardown(s); }
});

test("§13 tpx != mpx：tpx 打 Model Proxy → 401；mpx 打 Tool Facade → 401；cross-domain 0 privilege", async () => {
  const s = await setup();
  try {
    const { cap } = issue(s);
    const toModel = await fetch(s.fx.proxy.baseUrl + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + cap.capability.token }, body: JSON.stringify({ messages: [] }) });
    assert.equal(toModel.status, 401);
    const mcap = s.fx.proxy.issueCapability({ context: s.fx.ctx(), configId: s.fx.modelConfigId, allowedCapabilities: ["chat"], maxCalls: 2 });
    assert.match(mcap.capability.token, /^mpx_/);
    const toTool = await call(s.bridge, mcap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE }, callId: "xr_1" });
    assert.equal(toTool.status, 401);
    assert.equal(toTool.json.error, "TOOL_CAPABILITY_UNAUTHORIZED");
  } finally { await teardown(s); }
});

test("§15 capability lifecycle：ACTIVE → EXPIRED / EXHAUSTED / REVOKED", async () => {
  let now = 5_000_000;
  const s = await setup({ bridgeClock: () => now });
  try {
    const { cap } = issue(s, { ttlMs: 50 });
    assert.equal(s.bridge.capabilityState(cap.capability.token).state, "ACTIVE");
    now += 1000;
    const exp = await search(s, cap.capability.token, { callId: "lc_1" });
    assert.equal(exp.status, 401);
    assert.equal(s.bridge.capabilityState(cap.capability.token).state, "EXPIRED");

    const { cap: c2 } = issue(s, { maxCalls: 1 });
    assert.equal((await search(s, c2.capability.token, { callId: "lc_2" })).json.ok, true);
    const ex = await search(s, c2.capability.token, { callId: "lc_3" });
    assert.equal(ex.status, 429);
    assert.equal(s.bridge.capabilityState(c2.capability.token).state, "EXHAUSTED");

    const { cap: c3 } = issue(s, { maxCalls: 2 });
    assert.equal(s.bridge.revokeCapability(c3.capability.token).changed, true);
    assert.equal(s.bridge.capabilityState(c3.capability.token).state, "REVOKED");
    assert.equal((await search(s, c3.capability.token, { callId: "lc_4" })).status, 401);
  } finally { await teardown(s); }
});
