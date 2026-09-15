/** D4-03B Final Closure · Tool Facade capability 安全边界（run 隔离 / TTL / maxCalls / 注入 / 撤销 / 跨域）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { ToolFacadeBridge } = require("../electron/tool-facade-bridge.cjs");
const { buildToolManifest } = require("../electron/tool-registry.cjs");

const VISIBLE = "OPENARC_DSH_VISIBLE_RESOURCE";
const HIDDEN = "OPENARC_DSH_HIDDEN_RESOURCE";
const TOOL_IDS = ["resource.read.metadata", "resource.search"];

async function setup({ bridgeClock = null } = {}) {
  const fx = await createToolHarnessFixture({ withAdapters: true });
  const visible = await fx.createResource(VISIBLE);
  const hidden = await fx.createResource(HIDDEN);
  await fx.f.searchService.indexResource(visible.resource.resourceId);
  await fx.f.searchService.indexResource(hidden.resource.resourceId);
  const toolGrant = fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]);
  const manifest = buildToolManifest(fx.toolRegistry, { toolIds: TOOL_IDS });
  const bridge = new ToolFacadeBridge({ toolProxy: fx.toolProxy, manifest, clock: bridgeClock || fx.f.clock });
  await bridge.start();
  const origClose = fx.close.bind(fx);
  fx.close = async () => { for (const b of fx.__otherBridges || []) { try { await b.stop(); } catch { /* ignore */ } } try { await bridge.stop(); } catch { /* ignore */ } await origClose(); };
  return { fx, bridge, manifest, visible, hidden, toolGrant };
}
async function call(bridge, token, body) {
  const res = await fetch(bridge.baseUrl + "/tool-call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
function issue(bridge, fx, { context = null, run = null, maxCalls = 4, ttlMs = 60000, allowedTools = TOOL_IDS } = {}) {
  const r = run || fx.dshRunSetup(context);
  const cap = bridge.issueCapability({ context: r.context, taskId: r.taskId, stepId: r.stepId, runId: r.runId, allowedTools, maxCalls, ttlMs });
  return { run: r, cap };
}
const spyGet = (fx) => { const orig = fx.f.resourceService.get.bind(fx.f.resourceService); const box = { calls: 0 }; fx.f.resourceService.get = (...a) => { box.calls += 1; return orig(...a); }; return box; };

test("listener 只 bind 127.0.0.1 + 未知 / Model capability → 401", async () => {
  const { fx, bridge } = await setup();
  try {
    assert.match(bridge.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    const unknown = await call(bridge, "tpx_nope", { toolId: "resource.search", arguments: { query: "x" } });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.json.error, "TOOL_CAPABILITY_UNAUTHORIZED");
    const modelToken = "mpx_" + "A".repeat(20);
    const cross = await call(bridge, modelToken, { toolId: "resource.search", arguments: { query: "x" } });
    assert.equal(cross.status, 401);
    assert.equal(cross.json.error, "TOOL_CAPABILITY_UNAUTHORIZED");
  } finally { await fx.close(); }
});

test("wrong-run：bridge A 的 capability 在 bridge B → 401 + 0 proposal", async () => {
  const { fx, bridge, manifest } = await setup();
  try {
    const other = new ToolFacadeBridge({ toolProxy: fx.toolProxy, manifest, clock: fx.f.clock });
    await other.start();
    fx.__otherBridges = [other];
    const { run, cap } = issue(bridge, fx);
    assert.equal(cap.ok, true, JSON.stringify(cap));
    const r = await call(other, cap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE } });
    assert.equal(r.status, 401);
    assert.equal(fx.toolStore.proposalsOfTask(run.taskId).length, 0);
    const state = bridge.capabilityState(cap.capability.token);
    assert.equal(state.runId, run.runId);
  } finally { await fx.close(); }
});

test("expired capability → 401 + 0 Domain call", async () => {
  let now = 1_000_000;
  const { fx, bridge } = await setup({ bridgeClock: () => now });
  try {
    const { run, cap } = issue(bridge, fx, { ttlMs: 10 });
    now += 1000;
    const box = spyGet(fx);
    const r = await call(bridge, cap.capability.token, { toolId: "resource.read.metadata", arguments: { resourceRef: "resource://res_x" } });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, "TOOL_CAPABILITY_UNAUTHORIZED");
    assert.equal(box.calls, 0);
    assert.equal(fx.toolStore.executionsOfTask(run.taskId).length, 0);
  } finally { await fx.close(); }
});

test("maxCalls=2：第三次 TOOL_CAPABILITY_EXHAUSTED + 0 Domain call", async () => {
  const { fx, bridge } = await setup();
  try {
    const { cap } = issue(bridge, fx, { maxCalls: 2 });
    const a = await call(bridge, cap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE }, callId: "c1" });
    const b = await call(bridge, cap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE }, callId: "c2" });
    assert.equal(a.json.ok, true, JSON.stringify(a.json));
    assert.equal(b.json.ok, true, JSON.stringify(b.json));
    const c = await call(bridge, cap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE }, callId: "c3" });
    assert.equal(c.status, 429);
    assert.equal(c.json.error, "TOOL_CAPABILITY_EXHAUSTED");
    assert.equal(bridge.capabilityState(cap.capability.token).calls, 2);
  } finally { await fx.close(); }
});

test("WRITE / 未授权 tool / toolId 注入 → NOT_ALLOWED + 0 execution", async () => {
  const { fx, bridge } = await setup();
  try {
    const { run, cap } = issue(bridge, fx);
    for (const toolId of ["test.write", "test.echo", "../../shell", "resource.search;rm -rf", "resource.search/../../x", "shell.exec"]) {
      const r = await call(bridge, cap.capability.token, { toolId, arguments: { target: "x", message: "x", query: "x" }, callId: "inj_" + toolId });
      assert.equal(r.status, 403, toolId + " → " + JSON.stringify(r.json));
      assert.equal(r.json.error, "TOOL_NOT_ALLOWED_BY_CAPABILITY");
    }
    assert.equal(fx.toolStore.executionsOfTask(run.taskId).length, 0);
  } finally { await fx.close(); }
});

test("duplicate ACP call（同 callId）→ 只 1 次 Domain execution", async () => {
  const { fx, bridge } = await setup();
  try {
    const { run, cap } = issue(bridge, fx);
    let searches = 0;
    const orig = fx.f.searchService.search.bind(fx.f.searchService);
    fx.f.searchService.search = (...a) => { searches += 1; return orig(...a); };
    const first = await call(bridge, cap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE }, callId: "dup_1" });
    const second = await call(bridge, cap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE }, callId: "dup_1" });
    assert.equal(first.json.ok, true, JSON.stringify(first.json));
    assert.deepEqual(second.json, first.json);
    assert.equal(searches, 1, "duplicate 不得产生第二次 Domain call");
    assert.equal(fx.toolStore.proposalsOfTask(run.taskId).length, 1);
    assert.equal(fx.toolStore.executionsOfTask(run.taskId).length, 1);
  } finally { await fx.close(); }
});

test("stale tool contract → TOOL_CONTRACT_STALE，不静默继续", async () => {
  const { fx, bridge } = await setup();
  try {
    const { cap } = issue(bridge, fx);
    fx.toolRegistry.register({ ...fx.toolRegistry.get("resource.search", 1), version: 2 });
    const r = await call(bridge, cap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE }, callId: "stale_1" });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "TOOL_CONTRACT_STALE");
  } finally { await fx.close(); }
});

test("Session revoke：Tool 2 → DENY + 0 Domain read", async () => {
  const { fx, bridge, visible } = await setup();
  try {
    const { run, cap } = issue(bridge, fx);
    const ok = await call(bridge, cap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE }, callId: "rv_session_1" });
    assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
    const box = spyGet(fx);
    fx.f.identity.logout(run.context.sessionRef);
    const denied = await call(bridge, cap.capability.token, { toolId: "resource.read.metadata", arguments: { resourceRef: visible.resource.resourceRef }, callId: "rv_session_2" });
    assert.equal(denied.json.ok, false);
    assert.equal(box.calls, 0);
    assert.ok(["TOOL_FORBIDDEN", "TOOL_AUTHORIZATION_REVOKED", "TOOL_APP_NOT_GRANTED"].includes(denied.json.error), denied.json.error);
  } finally { await fx.close(); }
});

test("App disable：Tool 2 → DENY + 0 Domain read", async () => {
  const { fx, bridge, visible } = await setup();
  try {
    const { cap } = issue(bridge, fx);
    const ok = await call(bridge, cap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE }, callId: "rv_app_1" });
    assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
    const box = spyGet(fx);
    fx.f.store.setAppStatus("ai", "disabled");
    const denied = await call(bridge, cap.capability.token, { toolId: "resource.read.metadata", arguments: { resourceRef: visible.resource.resourceRef }, callId: "rv_app_2" });
    assert.equal(denied.json.ok, false);
    assert.equal(box.calls, 0);
  } finally { await fx.close(); }
});

test("Permission revoke：Tool 2 → DENY + 0 Domain read", async () => {
  const { fx, bridge, visible, toolGrant } = await setup();
  try {
    const { cap } = issue(bridge, fx);
    const ok = await call(bridge, cap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE }, callId: "rv_perm_1" });
    assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
    const rev = fx.f.authService.revokeAppResourcePermission({ context: fx.f.adminCtx(), grantId: toolGrant.grant.grantId });
    assert.equal(rev.ok, true, JSON.stringify(rev));
    const box = spyGet(fx);
    const denied = await call(bridge, cap.capability.token, { toolId: "resource.read.metadata", arguments: { resourceRef: visible.resource.resourceRef }, callId: "rv_perm_2" });
    assert.equal(denied.json.ok, false);
    assert.equal(box.calls, 0);
  } finally { await fx.close(); }
});

test("Resource delete race：search 后删除 → RESOURCE_NOT_AVAILABLE，不返回 stale metadata", async () => {
  const { fx, bridge, visible } = await setup();
  try {
    const { cap } = issue(bridge, fx);
    const ok = await call(bridge, cap.capability.token, { toolId: "resource.search", arguments: { query: VISIBLE }, callId: "del_1" });
    assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
    const del = await fx.f.resourceService.delete({ context: fx.f.adminCtx(), resourceRef: visible.resource.resourceRef });
    assert.equal(del.ok, true, JSON.stringify(del));
    const denied = await call(bridge, cap.capability.token, { toolId: "resource.read.metadata", arguments: { resourceRef: visible.resource.resourceRef }, callId: "del_2" });
    assert.equal(denied.json.ok, false);
    assert.equal(denied.json.error, "RESOURCE_NOT_AVAILABLE");
  } finally { await fx.close(); }
});

test("useByAgent=false（alice 可 read）：DENY + 0 Domain read", async () => {
  const { fx, bridge, visible } = await setup();
  try {
    const alice = { sessionRef: fx.f.sessions.alice, appId: "ai" };
    const { run, cap } = issue(bridge, fx, { context: alice });
    const grant = fx.grantUserResource(visible.resource.resourceId, fx.f.users.alice, ["resource.read"]);
    assert.equal(grant.ok, true, JSON.stringify(grant));
    const box = spyGet(fx);
    const denied = await call(bridge, cap.capability.token, { toolId: "resource.read.metadata", arguments: { resourceRef: visible.resource.resourceRef }, callId: "agent_1" });
    assert.equal(denied.json.ok, false);
    assert.equal(box.calls, 0);
    const dec = fx.toolStore.decisionsOfTask(run.taskId)[0];
    assert.equal(dec.decision, "DENIED");
    assert.ok(["TOOL_FORBIDDEN", "TOOL_AGENT_USE_NOT_AUTHORIZED"].includes(dec.reason_code), dec.reason_code);
  } finally { await fx.close(); }
});

test("search privacy（alice 搜 admin HIDDEN）：0 result，无存在泄漏", async () => {
  const { fx, bridge } = await setup();
  try {
    const alice = { sessionRef: fx.f.sessions.alice, appId: "ai" };
    const { cap } = issue(bridge, fx, { context: alice });
    const r = await call(bridge, cap.capability.token, { toolId: "resource.search", arguments: { query: HIDDEN, limit: 5 }, callId: "priv_1" });
    assert.equal(r.json.ok, true, JSON.stringify(r.json));
    assert.equal(r.json.result.items.length, 0);
    assert.equal(r.json.result.count, 0);
    assert.ok(!JSON.stringify(r.json.result).includes(HIDDEN), "不得泄漏 HIDDEN 存在");
  } finally { await fx.close(); }
});

test("Tool capability 打到 Model Proxy → 401（域隔离）", async () => {
  const { fx, bridge } = await setup();
  try {
    const { cap } = issue(bridge, fx);
    const res = await fetch(fx.proxy.baseUrl + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + cap.capability.token }, body: JSON.stringify({ messages: [] }) });
    assert.equal(res.status, 401);
  } finally { await fx.close(); }
});
