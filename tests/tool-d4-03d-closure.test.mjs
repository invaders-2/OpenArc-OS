/** D4-03D Closure · Tool-call Identity Seal：mandatory callId + runId/callId/toolId/arguments fingerprint。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ToolFacadeBridge, BRIDGE_ERROR, isValidCallId, TOOL_CAPABILITY_PREFIX } = require("../electron/tool-facade-bridge.cjs");
const { ControlledToolProxy } = require("../electron/controlled-tool-proxy.cjs");
const { buildBridgeManifest } = require("../electron/tool-registry.cjs");

const ROOT = path.join(import.meta.dirname, "..");
const PLUGIN = path.join(ROOT, "electron", "dsh-openarc-read-tools", "index.js");
const TRASH = "resource.trash";
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); });
const TOOL_IDS = ["resource.search", "resource.read.metadata", "resource.trash"];

function slowAdapter() {
  return {
    async prepare() { return {}; },
    async execute() { await sleep(250); return { ok: true, result: { items: [], count: 0, truncated: false } }; },
    async verify() { return { ok: true }; },
  };
}

async function setup({ slow = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3dc-"));
  const fx = await createToolHarnessFixture({ withAdapters: true, dbPath: path.join(root, "identity.db"), storeRoot: path.join(root, "library"), keepData: true, sideEffectRuntimeDir: path.join(root, "runtime"), facadeWriteToolIds: [TRASH] });
  const created = await fx.createResource("D3DC A");
  const second = await fx.createResource("D3DC B");
  for (const res of [created, second]) {
    fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: res.resource.resourceId, actions: ["resource.read", "resource.delete"] });
    fx.grantUserResource(res.resource.resourceId, fx.f.users.admin, ["resource.read", "resource.delete", "resource.useByAgent"]);
    await fx.f.searchService.indexResource(res.resource.resourceId);
  }
  fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata", "tool.resource.trash"]);
  const manifest = buildBridgeManifest(fx.toolRegistry, { readToolIds: ["resource.search", "resource.read.metadata"], writeToolIds: [TRASH] });
  const proxy = slow ? new ControlledToolProxy({ registry: fx.toolRegistry, toolStore: fx.toolStore, authService: fx.f.authService, taskStore: fx.taskStore, adapters: { adapterFor: () => slowAdapter() }, clock: fx.f.clock }) : fx.toolProxy;
  const bridge = new ToolFacadeBridge({ toolProxy: proxy, manifest, sideEffectRuntime: fx.sideEffectRuntime, clock: fx.f.clock });
  await bridge.start();
  const run = fx.dshRunSetup();
  const origClose = fx.close.bind(fx);
  fx.close = async () => { try { await bridge.stop(); } catch { /* ignore */ } await origClose(); };
  return { root, fx, bridge, created, second, resourceRef: created.resource.resourceRef, secondRef: second.resource.resourceRef, run };
}
async function teardown(s) { try { await s.fx.close(); } catch { /* ignore */ } try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* ignore */ } }
async function call(bridge, token, body, raw = false) {
  const res = await fetch(bridge.baseUrl + "/tool-call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: raw ? body : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
const issue = (s, { maxCalls = 8 } = {}) => {
  const cap = s.bridge.issueCapability({ context: s.run.context, taskId: s.run.taskId, stepId: s.run.stepId, runId: s.run.runId, allowedTools: TOOL_IDS, maxCalls, ttlMs: 60000 });
  assert.equal(cap.ok, true, JSON.stringify(cap));
  return cap;
};
const search = (s, token, callId, query = "D3DC") => call(s.bridge, token, { toolId: "resource.search", arguments: { query }, callId });
const trash = (s, token, callId, resourceRef = null) => call(s.bridge, token, { toolId: TRASH, arguments: { resourceRef: resourceRef || s.resourceRef }, callId });
const userCtx = (s) => ({ sessionRef: s.fx.f.sessions.admin, source: "user" });
const trashed = (s, ref = null) => s.fx.f.resourceService.sideEffectPrecondition({ resourceRef: ref || s.resourceRef }).trashed;
const calls = (s) => s.fx.sideEffectStore.callsOfTask(s.run.taskId);

test("§3/§4 callId Mandatory Gate：missing / invalid callId → 400 TOOL_CALL_ID_REQUIRED，0 budget / 0 proposal / 0 execution / 0 SideEffectCall", async () => {
  const s = await setup();
  try {
    const cap = issue(s);
    const t = cap.capability.token;
    // validator 单元
    for (const good of ["call_1", "a", "x".repeat(256), "  a  ", "01J8Z-abc.def_ghi"]) assert.equal(isValidCallId(good), true, good);
    for (const bad of [undefined, null, "", "   ", 123, true, {}, [], "x".repeat(257), "a\u0000b", "a\nb", "a\tb", "a\u007fb"]) assert.equal(isValidCallId(bad), false, String(bad));
    // Bridge：READ / WRITE 同一 identity contract
    const bodies = [
      { toolId: "resource.search", arguments: { query: "x" } },
      { toolId: "resource.search", arguments: { query: "x" }, callId: null },
      { toolId: "resource.search", arguments: { query: "x" }, callId: "" },
      { toolId: "resource.search", arguments: { query: "x" }, callId: "   " },
      { toolId: "resource.search", arguments: { query: "x" }, callId: 123 },
      { toolId: "resource.search", arguments: { query: "x" }, callId: true },
      { toolId: "resource.search", arguments: { query: "x" }, callId: {} },
      { toolId: "resource.search", arguments: { query: "x" }, callId: [] },
      { toolId: "resource.search", arguments: { query: "x" }, callId: "x".repeat(257) },
      { toolId: "resource.search", arguments: { query: "x" }, callId: "a\u0000b" },
      { toolId: "resource.search", arguments: { query: "x" }, callId: "a\nb" },
      { toolId: TRASH, arguments: { resourceRef: s.resourceRef } },
      { toolId: TRASH, arguments: { resourceRef: s.resourceRef }, callId: "" },
    ];
    for (const body of bodies) {
      const r = await call(s.bridge, t, body);
      assert.equal(r.status, 400, JSON.stringify(body) + " → " + JSON.stringify(r.json));
      assert.equal(r.json.error, BRIDGE_ERROR.CALL_ID_REQUIRED);
    }
    assert.equal(s.bridge.stats.calls, 0, "invalid callId 绝不消耗 budget");
    assert.equal(s.bridge.capabilityState(t).calls, 0);
    assert.equal(s.fx.toolStore.proposalsOfTask(s.run.taskId).length, 0, "0 ToolProposal");
    assert.equal(s.fx.toolStore.executionsOfTask(s.run.taskId).length, 0, "0 ToolExecution");
    assert.equal(calls(s).length, 0, "0 SideEffectCall");
    assert.equal(trashed(s), false, "0 mutation");
  } finally { await teardown(s); }
});

test("§8/§13/§14 exact duplicate + terminal WRITE replay：same approvalRequestId / 1 SideEffectCall / 0 second mutation / 0 extra budget", async () => {
  const s = await setup();
  try {
    const cap = issue(s);
    const t = cap.capability.token;
    // READ exact duplicate
    const r1 = await search(s, t, "dup_read_1");
    const r2 = await search(s, t, "dup_read_1");
    assert.equal(r1.json.ok, true);
    assert.deepEqual(r2.json, r1.json);
    assert.equal(s.fx.toolStore.executionsOfTask(s.run.taskId).filter((e) => e.tool_id === "resource.search").length, 1);
    assert.equal(s.bridge.capabilityState(t).calls, 1, "duplicate 0 extra budget");
    // WRITE exact duplicate
    const w1 = await trash(s, t, "dup_write_1");
    assert.equal(w1.json.error, "SIDE_EFFECT_APPROVAL_REQUIRED");
    const authorityId = w1.json.approvalRequestId;
    const w2 = await trash(s, t, "dup_write_1");
    assert.equal(w2.json.approvalRequestId, authorityId);
    assert.equal(calls(s).length, 1);
    assert.equal(s.bridge.capabilityState(t).calls, 2, "WRITE duplicate 0 extra budget");
    // terminal WRITE replay
    assert.equal(s.fx.sideEffectRuntime.decideApproval({ context: userCtx(s), approvalRequestId: authorityId, decision: "APPROVE" }).ok, true);
    const exec = await s.fx.sideEffectRuntime.executeApproved({ callId: authorityId, holderId: "exec_1" });
    assert.equal(exec.ok, true, JSON.stringify(exec).slice(0, 300));
    assert.equal(s.fx.sideEffectStore.callById(authorityId).status, "SUCCEEDED");
    assert.equal(trashed(s), true);
    const beforeRev = s.fx.taskStore.taskById(s.run.taskId).revision;
    const w3 = await trash(s, t, "dup_write_1");
    assert.equal(w3.json.error, "SIDE_EFFECT_APPROVAL_REQUIRED");
    assert.equal(w3.json.approvalRequestId, authorityId, "terminal replay 返回原 binding");
    assert.equal(calls(s).length, 1, "0 second SideEffectCall");
    assert.equal(s.fx.sideEffectStore.approvalsOfCall(authorityId).length, 1, "0 second approval");
    assert.equal(s.fx.sideEffectStore.leasesOfCall(authorityId).length, 1, "0 second lease");
    assert.equal(s.fx.sideEffectStore.callById(authorityId).verificationStatus, "PASS");
    assert.equal(s.bridge.capabilityState(t).calls, 2, "terminal replay 0 extra budget");
    void beforeRev;
  } finally { await teardown(s); }
});

test("§10 READ→WRITE same-callId collision：409 TOOL_CALL_ID_CONFLICT；绝不把 READ result 当成 WRITE success；0 SideEffectCall / 0 mutation", async () => {
  const s = await setup();
  try {
    const cap = issue(s);
    const t = cap.capability.token;
    const read = await search(s, t, "collision_1");
    assert.equal(read.json.ok, true);
    const conflict = await trash(s, t, "collision_1");
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error, BRIDGE_ERROR.CALL_ID_CONFLICT);
    assert.ok(!("result" in conflict.json) || conflict.json.result == null, "绝不返回旧 READ result");
    assert.equal(calls(s).length, 0, "0 SideEffectCall");
    assert.equal(trashed(s), false, "0 mutation");
    assert.equal(s.fx.sideEffectStore.approvalsOfCall("collision_1").length, 0);
    assert.equal(s.bridge.capabilityState(t).calls, 1, "conflict 0 extra budget");
    assert.equal(s.bridge.stats.conflicts, 1);
  } finally { await teardown(s); }
});

test("§11 WRITE→READ same-callId collision：409 TOOL_CALL_ID_CONFLICT；绝不返回 SIDE_EFFECT_APPROVAL_REQUIRED 冒充 READ result", async () => {
  const s = await setup();
  try {
    const cap = issue(s);
    const t = cap.capability.token;
    const w = await trash(s, t, "collision_2");
    assert.equal(w.json.error, "SIDE_EFFECT_APPROVAL_REQUIRED");
    assert.equal(calls(s).length, 1);
    const conflict = await search(s, t, "collision_2");
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error, BRIDGE_ERROR.CALL_ID_CONFLICT);
    assert.notEqual(conflict.json.error, "SIDE_EFFECT_APPROVAL_REQUIRED");
    assert.equal(s.fx.toolStore.executionsOfTask(s.run.taskId).length, 0, "0 READ execution");
    assert.equal(calls(s).length, 1, "原 SideEffectCall binding 不被覆盖");
    assert.equal(s.bridge.capabilityState(t).calls, 1);
  } finally { await teardown(s); }
});

test("§12 WRITE A→WRITE B same-callId collision：只允许 1 SideEffectCall，且只绑定 resourceA", async () => {
  const s = await setup();
  try {
    const cap = issue(s);
    const t = cap.capability.token;
    const a = await trash(s, t, "collision_3", s.resourceRef);
    assert.equal(a.json.error, "SIDE_EFFECT_APPROVAL_REQUIRED");
    const b = await trash(s, t, "collision_3", s.secondRef);
    assert.equal(b.status, 409);
    assert.equal(b.json.error, BRIDGE_ERROR.CALL_ID_CONFLICT);
    assert.equal(calls(s).length, 1, "只允许 1 SideEffectCall");
    assert.equal(calls(s)[0].preconditionsSafe.resourceRef, s.resourceRef, "绑定 resourceA");
    assert.equal(trashed(s, s.secondRef), false, "resourceB 0 mutation");
    assert.equal(s.bridge.capabilityState(t).calls, 1);
  } finally { await teardown(s); }
});

test("§9 same tool + different args collision：canonical arguments fingerprint 不同 → 409", async () => {
  const s = await setup();
  try {
    const cap = issue(s);
    const t = cap.capability.token;
    const a = await search(s, t, "collision_4", "ALPHA");
    assert.equal(a.json.ok, true);
    const b = await search(s, t, "collision_4", "BETA");
    assert.equal(b.status, 409);
    assert.equal(b.json.error, BRIDGE_ERROR.CALL_ID_CONFLICT);
    assert.equal(s.fx.toolStore.executionsOfTask(s.run.taskId).filter((e) => e.tool_id === "resource.search").length, 1, "0 second execution");
    // canonical fingerprint：key 顺序不影响 identity（同 args 不同 key 顺序仍是 duplicate）
    const c1 = await call(s.bridge, t, { toolId: "resource.search", arguments: { query: "GAMMA", limit: 3 }, callId: "canon_1" });
    const c2 = await call(s.bridge, t, { toolId: "resource.search", arguments: { limit: 3, query: "GAMMA" }, callId: "canon_1" });
    assert.equal(c1.json.ok, true);
    assert.deepEqual(c2.json, c1.json, "canonical fingerprint 必须与 key insertion order 无关");
  } finally { await teardown(s); }
});

test("§17/§18 concurrent exact duplicate + concurrent payload collision：恰好一个 winner", async () => {
  const s = await setup({ slow: true });
  try {
    const cap = issue(s);
    const t = cap.capability.token;
    const [d1, d2] = await Promise.all([search(s, t, "conc_dup", "SAME"), search(s, t, "conc_dup", "SAME")]);
    assert.equal(d1.json.ok, true);
    assert.deepEqual(d2.json, d1.json);
    assert.equal(s.fx.toolStore.executionsOfTask(s.run.taskId).filter((e) => e.tool_id === "resource.search").length, 1, "并发 exact duplicate → 1 execution");
    assert.equal(s.bridge.capabilityState(t).calls, 1, "并发 exact duplicate → 1 budget");
    const [c1, c2] = await Promise.all([search(s, t, "conc_coll", "ONE"), search(s, t, "conc_coll", "TWO")]);
    const statuses = [c1.status, c2.status].sort();
    assert.deepEqual(statuses, [200, 409], "并发不同 payload：一个 winner + 一个 conflict：" + JSON.stringify([c1, c2]));
    const winner = c1.status === 200 ? c1 : c2;
    const loser = c1.status === 200 ? c2 : c1;
    assert.equal(winner.json.ok, true);
    assert.equal(loser.json.error, BRIDGE_ERROR.CALL_ID_CONFLICT);
    assert.equal(s.fx.toolStore.executionsOfTask(s.run.taskId).filter((e) => e.tool_id === "resource.search").length, 2, "总 execution = 2（前一个 dup + 一个 winner）");
    assert.equal(s.bridge.stats.conflicts, 1);
    assert.equal(s.bridge.capabilityState(t).calls, 2);
  } finally { await teardown(s); }
});

test("§19 maxCalls=1 concurrent unique calls：恰好一个消耗 budget，另一个 TOOL_CAPABILITY_EXHAUSTED", async () => {
  const s = await setup({ slow: true });
  try {
    const cap = issue(s, { maxCalls: 1 });
    const t = cap.capability.token;
    const [a, b] = await Promise.all([search(s, t, "unique_1", "ONE"), search(s, t, "unique_2", "TWO")]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 429], "maxCalls=1 并发：一个成功 + 一个 exhausted：" + JSON.stringify([a, b]));
    const ok = a.status === 200 ? a : b;
    const exhausted = a.status === 200 ? b : a;
    assert.equal(ok.json.ok, true);
    assert.equal(exhausted.json.error, "TOOL_CAPABILITY_EXHAUSTED");
    assert.equal(s.bridge.capabilityState(t).calls, 1, "exactly one consumes budget");
    assert.equal(s.bridge.stats.calls, 1);
    assert.ok(s.fx.toolStore.executionsOfTask(s.run.taskId).length <= 1, "Domain/authority total <= 1");
  } finally { await teardown(s); }
});

test("§5/§27 official dsh plugin missing exec.callId fail closed：0 Tool Facade request；有 callId 才发请求", async () => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests += 1; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result: { items: [], count: 0, truncated: false } })); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3cp-"));
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ contractHash: "x", tools: [{ toolId: "resource.search", name: "resource_search", description: "x", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, outputSchema: { type: "object" } }] }));
  try {
    const plugin = await import(pathToFileURL(PLUGIN).href);
    const defs = [];
    plugin.apply({ tools: { register: (def) => defs.push(def) } }, { manifestPath, facadeUrl: "http://127.0.0.1:" + server.address().port, capability: TOOL_CAPABILITY_PREFIX + "probe" });
    assert.equal(defs.length, 1);
    await assert.rejects(() => defs[0].execute({ query: "x" }, {}), /callId/i, "missing exec.callId 必须 safe fail");
    await assert.rejects(() => defs[0].execute({ query: "x" }, { callId: null }), /callId/i);
    await assert.rejects(() => defs[0].execute({ query: "x" }, { callId: "   " }), /callId/i);
    assert.equal(requests, 0, "missing exec.callId → 0 Tool Facade request");
    const result = await defs[0].execute({ query: "x" }, { callId: "call_ok_1" });
    assert.deepEqual(result, { items: [], count: 0, truncated: false });
    assert.equal(requests, 1, "有 callId 才发送请求");
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("§22/§23 Harness callId 不能成为 SideEffectCall authority identity：OpenArc 自己生成 scall_ id", async () => {
  const s = await setup();
  try {
    const cap = issue(s);
    const w = await trash(s, cap.capability.token, "scall_fake_harness_id");
    assert.equal(w.json.error, "SIDE_EFFECT_APPROVAL_REQUIRED");
    const authorityId = w.json.approvalRequestId;
    assert.notEqual(authorityId, "scall_fake_harness_id", "Harness callId 绝不当成 SideEffectCall authority id");
    assert.ok(authorityId.startsWith("scall_"), "SideEffectCall id 来自 OpenArc generator：" + authorityId);
    assert.equal(s.fx.sideEffectStore.callById(authorityId).callId, authorityId);
    assert.equal(calls(s).length, 1);
    assert.equal(calls(s)[0].callId, authorityId);
  } finally { await teardown(s); }
});
