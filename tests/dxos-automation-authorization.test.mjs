/**
 * Z1 · 定时自动化同步「定义即授权」（全离线：真实 identity.db + 真实 plugin-service + 假 MCP 传输）。
 *
 * 产品已批准：管理员（认证会话）创建并启用某个自动化定义 = 对该定义声明的动作范围授权；
 * 到点执行集成类动作时凭该定义的授权记录通过，不再逐次人工审批。覆盖：
 *   ① 授权路径：创建并启用 → 到点执行领星动作 → 真调用 stub 传输并回结果；run 审计含授权来源；
 *   ② 拒绝路径：无授权记录 / 定义停用 / 动作超出声明范围 / 传输未注入 → 结构化拒绝且 0 次外发；
 *   ③ 失效路径：停用后再启用才恢复放行；删除定义后原授权不再放行（且落撤销审计）；
 *   ④ 授权人有效性策略（可选）：授权账号停用 / 会话失效且策略要求有效 → 拒绝。
 *
 * 只读源：electron/automation-domain.cjs、automation-store.cjs、automation-service.cjs、plugin-service.cjs。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const store = require("../electron/automation-store.cjs");
const { createAutomationBundle } = require("../electron/automation-service.cjs");
const { createPluginBundle } = require("../electron/plugin-service.cjs");

const BASE = Date.UTC(2023, 10, 13, 0, 0, 0);
const USER = "u-auto-authz";
const tmpDirs = [];
const openStores = [];
const openBundles = [];

afterEach(() => {
  store.resetAutomationStoreForTests();
  while (openBundles.length) {
    const bundle = openBundles.pop();
    try { bundle.ziniao.close(); } catch { /* 已关 */ }
    try { bundle.lingxing.close(); } catch { /* 已关 */ }
  }
  while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } }
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(dir); return dir; }
function makeClock() { let value = BASE; return { now: () => value, advance: (ms) => { value += ms; } }; }
function makeAuth() { return { resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: USER } } : { ok: false, error: "no-session" }) }; }
function trackPlugin(bundle) { openBundles.push(bundle); return bundle; }
const okProbe = () => ({ ok: true, status: "ok", detail: "" });

const SAMPLE_SALES = [{ asin: "B0TEST0001", item_name: "样例产品一", volume: 3, amount: 99.5, order_items: 2, sessions: 40, currency_code: "CNY", seller_name: "样例店铺", country: "US", brand: "样例品牌" }];

/** 既有 MCP tools/call 端口形状（createMcpLiveTransport 的调用形状）；每次调用都计数。 */
function makeMcpPort() {
  const calls = [];
  return {
    calls,
    async callTool(request) {
      calls.push({ serverId: request.serverId, toolName: request.toolName, args: request.arguments });
      if (request.toolName === "query_product_performance_asin_lists") return { ok: true, text: JSON.stringify({ code: 1, data: { list: SAMPLE_SALES, total: SAMPLE_SALES.length } }) };
      if (request.toolName === "start_client") return { ok: true, text: "{}" };
      if (request.toolName === "list_stores") return { ok: true, text: JSON.stringify([{ browserOauth: "oauth-1", browserName: "店铺一" }]) };
      return { ok: true, text: JSON.stringify({ code: 1, data: {} }) };
    },
  };
}

/** 真实 identity.db + 真实 automation-service；integrations 由调用方注入（真实 plugin-service 适配器或假适配器）。 */
function openAutomation(integrations, overrides = {}) {
  const dir = tempDir("dxos-auto-authz-");
  const idStore = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(idStore);
  const clock = makeClock();
  const bundle = createAutomationBundle(Object.assign({
    identityStore: idStore,
    authorization: makeAuth(),
    clock: () => clock.now(),
    sleeper: async () => {},
    integrations,
  }, overrides));
  return { idStore, bundle, clock };
}

function enableLingxing(plugin) {
  return plugin.execute("integration/plugins/enable", { id: "lingxing" }, { sessionRef: "s-plugin" });
}

function authRows(idStore, id, action) {
  return idStore.connection.prepare("SELECT * FROM authorization_audit WHERE resource_ref=? AND action=? ORDER BY id").all("automation:" + id, action);
}

// ── ① 授权路径 ─────────────────────────────────────────────────────────────
test("授权路径：创建并启用 → 到点执行领星动作真调用 stub，run 审计含授权来源", async () => {
  const mcp = makeMcpPort();
  let fetchCalls = 0;
  const plugin = trackPlugin(createPluginBundle({
    userDataDir: tempDir("dxos-plugin-authz-"), safeStorage: null, mcpTransport: mcp,
    fetch: async () => { fetchCalls += 1; return { ok: false, status: 0, json: async () => ({}) }; },
    sleeper: (ms) => new Promise((resolve) => setTimeout(resolve, 1)),
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await enableLingxing(plugin)).ok, true);
  const { idStore, bundle, clock } = openAutomation(plugin.automationAdapter);

  const created = await bundle.execute("automation/create", {
    definition: { instruction: "每日同步领星", schedule: { type: "once", at: BASE + 3600000 }, action: { type: "lingxing_cache_sync", args: { days: 1 } } },
  }, { sessionRef: "sess-auto" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.value.automation.id;

  // 授权记录：principal + 定义 id + 动作范围 + 时间（落既有 authorization_audit）。
  const grants = authRows(idStore, id, "automation.authorize");
  assert.equal(grants.length, 1);
  assert.equal(grants[0].decision, "allow");
  assert.equal(grants[0].actor_user_id, USER, "授权人 principal 必须是认证会话解析出的 actor");
  assert.equal(grants[0].permission_source, "automation_definition");
  assert.equal(grants[0].resource_ref, "automation:" + id);
  assert.deepEqual(JSON.parse(grants[0].new_permissions).scope, ["lingxing_cache_sync"]);
  assert.equal(grants[0].at, BASE, "授权时间即创建时间");

  // 到点执行：真调用 stub 传输并回源口径结果。
  clock.advance(3600000);
  const ticked = await bundle.tick();
  assert.equal(ticked.status, "success", JSON.stringify(ticked));
  assert.equal(ticked.result, "领星近 1 天数据已缓存，共 1 条");
  await plugin.lingxing.whenIdle();
  assert.ok(mcp.calls.some((call) => call.toolName === "query_product_performance_asin_lists"), "必须真调用 stub 传输");
  assert.equal(fetchCalls, 0, "领星同步只走 MCP 传输，不得额外 fetch");

  // run 审计：授权来源 principal + definitionId。
  const exec = idStore.connection.prepare("SELECT * FROM authorization_audit WHERE request_id=? AND action=?").get(ticked.runId, "automation.execute");
  assert.ok(exec, "每次运行必须落 execute 审计");
  assert.equal(exec.decision, "allow");
  assert.equal(exec.actor_user_id, USER);
  assert.equal(JSON.parse(exec.new_permissions).definitionId, id);
  assert.equal(JSON.parse(exec.new_permissions).runId, ticked.runId);
  const viaStore = store.authorizationForRun(USER, ticked.runId);
  assert.equal(viaStore.principal, USER);
  assert.equal(viaStore.definitionId, id);
  const run = store.getRun(USER, ticked.runId);
  assert.equal(run.definitionId, id);
  assert.equal(run.authorizedBy, USER);
});

// ── ② 拒绝路径（各自 0 次外发） ─────────────────────────────────────────────
test("拒绝：无授权记录 → AUTOMATION_FORBIDDEN/NO_AUTHORIZATION_RECORD 且 0 次外发", async () => {
  const mcp = makeMcpPort();
  let fetchCalls = 0;
  const plugin = trackPlugin(createPluginBundle({
    userDataDir: tempDir("dxos-plugin-authz-"), safeStorage: null, mcpTransport: mcp,
    fetch: async () => { fetchCalls += 1; return { ok: false, status: 0, json: async () => ({}) }; },
    sleeper: (ms) => new Promise((resolve) => setTimeout(resolve, 1)),
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await enableLingxing(plugin)).ok, true);
  const { idStore, bundle, clock } = openAutomation(plugin.automationAdapter);
  const created = await bundle.execute("automation/create", { definition: { instruction: "无授权", schedule: { type: "once", at: BASE + 1000 }, action: { type: "lingxing_cache_sync", args: { days: 1 } } } }, { sessionRef: "sess-auto" });
  const id = created.value.automation.id;
  // 只删授权/撤销记录（保留 execute 审计不参与状态判定），模拟"没有定义授权记录"。
  idStore.connection.prepare("DELETE FROM authorization_audit WHERE resource_ref=? AND action IN (?,?)").run("automation:" + id, "automation.authorize", "automation.revoke");

  clock.advance(1000);
  const run = await bundle.execute("automation/runNow", { automationId: id, await: true }, { sessionRef: "sess-auto" });
  assert.equal(run.ok, false, JSON.stringify(run));
  assert.equal(run.error, "AUTOMATION_FORBIDDEN");
  assert.equal(run.detail.reasonCode, "NO_AUTHORIZATION_RECORD");
  assert.equal(mcp.calls.length, 0, "无授权记录必须 0 次传输");
  assert.equal(fetchCalls, 0, "无授权记录必须 0 次网络");
  const failedRun = store.listRuns(USER, { automationId: id })[0];
  assert.equal(failedRun.status, "failed");
  const denied = idStore.connection.prepare("SELECT * FROM authorization_audit WHERE request_id=? AND action=?").get(failedRun.id, "automation.execute");
  assert.ok(denied, "被拒绝的运行也要落 execute 审计");
  assert.equal(denied.decision, "deny");
  assert.equal(denied.reason_code, "NO_AUTHORIZATION_RECORD");
});

test("拒绝：定义停用 → AUTOMATION_FORBIDDEN/DEFINITION_DISABLED 且 0 次外发", async () => {
  const mcp = makeMcpPort();
  const plugin = trackPlugin(createPluginBundle({
    userDataDir: tempDir("dxos-plugin-authz-"), safeStorage: null, mcpTransport: mcp,
    sleeper: (ms) => new Promise((resolve) => setTimeout(resolve, 1)),
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await enableLingxing(plugin)).ok, true);
  const { bundle, clock } = openAutomation(plugin.automationAdapter);
  const created = await bundle.execute("automation/create", { definition: { instruction: "停用", schedule: { type: "once", at: BASE + 1000 }, action: { type: "lingxing_cache_sync", args: { days: 1 } } } }, { sessionRef: "sess-auto" });
  const id = created.value.automation.id;
  assert.equal((await bundle.execute("automation/disable", { automationId: id }, { sessionRef: "sess-auto" })).ok, true);

  clock.advance(1000);
  const run = await bundle.execute("automation/runNow", { automationId: id, await: true }, { sessionRef: "sess-auto" });
  assert.equal(run.ok, false);
  assert.equal(run.error, "AUTOMATION_FORBIDDEN");
  assert.equal(run.detail.reasonCode, "DEFINITION_DISABLED");
  assert.equal(mcp.calls.length, 0, "停用后必须 0 次传输");
});

test("拒绝：动作超出声明范围 → AUTOMATION_FORBIDDEN/ACTION_OUT_OF_SCOPE 且 0 次外发", async () => {
  const mcp = makeMcpPort();
  const plugin = trackPlugin(createPluginBundle({
    userDataDir: tempDir("dxos-plugin-authz-"), safeStorage: null, mcpTransport: mcp,
    sleeper: (ms) => new Promise((resolve) => setTimeout(resolve, 1)),
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await enableLingxing(plugin)).ok, true);
  const { idStore, bundle, clock } = openAutomation(plugin.automationAdapter);
  const created = await bundle.execute("automation/create", { definition: { instruction: "范围", schedule: { type: "once", at: BASE + 1000 }, action: { type: "lingxing_cache_sync", args: { days: 1 } } } }, { sessionRef: "sess-auto" });
  const id = created.value.automation.id;
  // 绕过受认证的 update 直接改 action_json：授权范围快照未变，执行时必须拒绝。
  idStore.connection.prepare("UPDATE automations SET action_json=? WHERE id=?").run(JSON.stringify({ type: "dingtalk_group_notify", args: { content: "x" } }), id);

  clock.advance(1000);
  const run = await bundle.execute("automation/runNow", { automationId: id, await: true }, { sessionRef: "sess-auto" });
  assert.equal(run.ok, false);
  assert.equal(run.error, "AUTOMATION_FORBIDDEN");
  assert.equal(run.detail.reasonCode, "ACTION_OUT_OF_SCOPE");
  assert.equal(run.detail.action, "dingtalk_group_notify");
  assert.equal(mcp.calls.length, 0, "越权动作必须 0 次传输");
});

test("拒绝：传输未注入 → AGENT_DEPENDENCY_UNAVAILABLE 且 0 次外发", async () => {
  let fetchCalls = 0;
  const plugin = trackPlugin(createPluginBundle({
    userDataDir: tempDir("dxos-plugin-authz-"), safeStorage: null,
    fetch: async () => { fetchCalls += 1; return { ok: false, status: 0, json: async () => ({}) }; },
    sleeper: (ms) => new Promise((resolve) => setTimeout(resolve, 1)),
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await enableLingxing(plugin)).ok, true, "插件可启用；闸门在传输，不在插件开关");
  const { bundle, clock } = openAutomation(plugin.automationAdapter);
  const created = await bundle.execute("automation/create", { definition: { instruction: "未注入", schedule: { type: "once", at: BASE + 1000 }, action: { type: "lingxing_cache_sync", args: { days: 1 } } } }, { sessionRef: "sess-auto" });
  const id = created.value.automation.id;

  clock.advance(1000);
  const run = await bundle.execute("automation/runNow", { automationId: id, await: true }, { sessionRef: "sess-auto" });
  assert.equal(run.ok, false);
  assert.equal(run.error, "AGENT_DEPENDENCY_UNAVAILABLE", "插件的 INTEGRATION_UNAVAILABLE 归一到依赖缺失码");
  assert.equal(run.detail.dependency, "integrations.lingxingCacheSync");
  assert.equal(run.detail.causeCode, "INTEGRATION_UNAVAILABLE");
  assert.equal(fetchCalls, 0, "传输未注入必须 0 次网络");
});

// ── ③ 失效路径 ─────────────────────────────────────────────────────────────
test("失效：停用撤销授权；重新启用才恢复放行；删除后原授权不再放行并落撤销审计", async () => {
  const mcp = makeMcpPort();
  const plugin = trackPlugin(createPluginBundle({
    userDataDir: tempDir("dxos-plugin-authz-"), safeStorage: null, mcpTransport: mcp,
    sleeper: (ms) => new Promise((resolve) => setTimeout(resolve, 1)),
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await enableLingxing(plugin)).ok, true);
  const { idStore, bundle, clock } = openAutomation(plugin.automationAdapter);
  const created = await bundle.execute("automation/create", { definition: { instruction: "失效", schedule: { type: "once", at: BASE + 1000 }, action: { type: "lingxing_cache_sync", args: { days: 1 } } } }, { sessionRef: "sess-auto" });
  const id = created.value.automation.id;

  clock.advance(1000);
  assert.equal((await bundle.execute("automation/runNow", { automationId: id, await: true }, { sessionRef: "sess-auto" })).ok, true, "首次凭授权放行");
  const callsAfterFirst = mcp.calls.length;

  // 停用 → 撤销记录；原授权不再放行。
  await bundle.execute("automation/disable", { automationId: id }, { sessionRef: "sess-auto" });
  const revoked = authRows(idStore, id, "automation.revoke");
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].decision, "deny");
  assert.equal(revoked[0].reason_code, "DEFINITION_DISABLED");
  assert.equal(store.latestDefinitionAuthorization(id).decision, "deny", "最近授权状态必须是 deny");
  clock.advance(1000);
  const blocked = await bundle.execute("automation/runNow", { automationId: id, await: true }, { sessionRef: "sess-auto" });
  assert.equal(blocked.error, "AUTOMATION_FORBIDDEN");
  assert.equal(blocked.detail.reasonCode, "DEFINITION_DISABLED");
  assert.equal(mcp.calls.length, callsAfterFirst, "停用期间不得再有传输");

  // 重新启用 → 重新落 allow，恢复放行。
  await bundle.execute("automation/enable", { automationId: id }, { sessionRef: "sess-auto" });
  assert.equal(store.latestDefinitionAuthorization(id).decision, "allow");
  clock.advance(1000);
  const resumed = await bundle.execute("automation/runNow", { automationId: id, await: true }, { sessionRef: "sess-auto" });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  await plugin.lingxing.whenIdle();
  assert.ok(mcp.calls.length > callsAfterFirst, "重新启用后必须恢复放行");

  // 删除 → 撤销审计留痕，定义与运行记录级联删除，原授权不再放行。
  const callsBeforeDelete = mcp.calls.length;
  assert.equal((await bundle.execute("automation/delete", { automationId: id }, { sessionRef: "sess-auto" })).ok, true);
  const afterDelete = authRows(idStore, id, "automation.revoke");
  assert.equal(afterDelete.length, 2);
  assert.equal(afterDelete[1].reason_code, "DEFINITION_DELETED");
  assert.equal(store.latestDefinitionAuthorization(id).decision, "deny");
  const gone = await bundle.execute("automation/runNow", { automationId: id, await: true }, { sessionRef: "sess-auto" });
  assert.equal(gone.ok, false);
  assert.equal(gone.error, "AUTOMATION_NOT_FOUND");
  assert.equal(mcp.calls.length, callsBeforeDelete, "删除后不得再有传输");
});

test("补救：升级前已存在、无授权记录的定义，管理员显式启用一次即重新授权", async () => {
  const mcp = makeMcpPort();
  const plugin = trackPlugin(createPluginBundle({
    userDataDir: tempDir("dxos-plugin-authz-"), safeStorage: null, mcpTransport: mcp,
    sleeper: (ms) => new Promise((resolve) => setTimeout(resolve, 1)),
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await enableLingxing(plugin)).ok, true);
  const { idStore, bundle, clock } = openAutomation(plugin.automationAdapter);
  const created = await store.createAutomation(USER, { instruction: "升级前", schedule: { type: "interval", everyMs: 3600000 }, action: { type: "lingxing_cache_sync", args: { days: 1 } } });
  const id = created.id;
  // 模拟升级前遗留：抹掉定义授权/撤销记录（老库没有这些行）。
  idStore.connection.prepare("DELETE FROM authorization_audit WHERE resource_ref=? AND action IN (?,?)").run("automation:" + id, "automation.authorize", "automation.revoke");
  clock.advance(1000);
  const blocked = await bundle.execute("automation/runNow", { automationId: id, await: true }, { sessionRef: "sess-auto" });
  assert.equal(blocked.error, "AUTOMATION_FORBIDDEN");
  assert.equal(blocked.detail.reasonCode, "NO_AUTHORIZATION_RECORD");
  // 管理员显式启用一次 → 重新落授权 → 放行。
  assert.equal((await bundle.execute("automation/enable", { automationId: id }, { sessionRef: "sess-auto" })).ok, true);
  clock.advance(1000);
  const resumed = await bundle.execute("automation/runNow", { automationId: id, await: true }, { sessionRef: "sess-auto" });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  await plugin.lingxing.whenIdle();
  assert.ok(mcp.calls.length >= 1);
});

// ── ④ 授权人有效性策略（可选，失败关闭） ────────────────────────────────────
test("策略：requireActiveAuthorizer 开启后，授权账号停用 / 会话失效一律拒绝", async () => {
  const dir = tempDir("dxos-auto-authz-real-");
  const idStore = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(idStore);
  await idStore.initialize({ identifier: "admin@openarc.test", password: "admin-password-1", displayName: "Admin" });
  const login = await idStore.login({ identifier: "admin@openarc.test", password: "admin-password-1" });
  assert.equal(login.ok, true, JSON.stringify(login));
  const realUserId = login.user.id;
  const sessionRef = login.session.ref;

  const calls = [];
  const clock = makeClock();
  const bundle = createAutomationBundle({
    identityStore: idStore,
    authorization: { resolveActor: ({ context }) => (context && context.sessionRef === sessionRef ? { ok: true, user: { id: realUserId } } : { ok: false, error: "no-session" }) },
    clock: () => clock.now(),
    sleeper: async () => {},
    integrations: { lingxingCacheSync: async () => { calls.push("lingxing"); return "ok"; } },
    authorizationPolicy: { requireActiveAuthorizer: true },
  });
  // 用 interval：create 反复发生，once 的"必须晚于现在"会随假时钟推进而失败。
  const create = (suffix) => bundle.execute("automation/create", { definition: { instruction: "策略" + suffix, schedule: { type: "interval", everyMs: 3600000 }, action: { type: "lingxing_cache_sync", args: { days: 1 } } } }, { sessionRef });

  const a = await create("A");
  assert.equal(a.ok, true, JSON.stringify(a));
  clock.advance(1000);
  const allowed = await bundle.execute("automation/runNow", { automationId: a.value.automation.id, await: true }, { sessionRef });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));

  // 会话失效（撤销全部会话）→ AUTHORIZER_SESSION_EXPIRED。
  idStore.connection.prepare("UPDATE sessions SET revoked_at=?, revoked_reason='test' WHERE user_id=? AND revoked_at IS NULL").run(BASE, realUserId);
  const b = await create("B");
  clock.advance(1000);
  const expired = await bundle.execute("automation/runNow", { automationId: b.value.automation.id, await: true }, { sessionRef });
  assert.equal(expired.ok, false, JSON.stringify(expired));
  assert.equal(expired.error, "AUTOMATION_FORBIDDEN");
  assert.equal(expired.detail.reasonCode, "AUTHORIZER_SESSION_EXPIRED");

  // 账号停用 → AUTHORIZER_INACTIVE（优先于会话判定）。
  idStore.connection.prepare("UPDATE users SET status='DISABLED' WHERE id=?").run(realUserId);
  const c = await create("C");
  clock.advance(1000);
  const inactive = await bundle.execute("automation/runNow", { automationId: c.value.automation.id, await: true }, { sessionRef });
  assert.equal(inactive.ok, false);
  assert.equal(inactive.error, "AUTOMATION_FORBIDDEN");
  assert.equal(inactive.detail.reasonCode, "AUTHORIZER_INACTIVE");
  assert.deepEqual(calls, ["lingxing"], "只在首次有效授权时执行一次");
});

// ── ④b 传输凭证：自动化带定义授权 gate；临时发起不带 gate（双条件不绕过） ──────
test("传输凭证：自动化调用携带定义授权 gate；临时发起的集成命令不带 gate", async () => {
  const seen = [];
  const mcp = {
    async callTool(request, gate) {
      seen.push({ toolName: request.toolName, gate });
      if (request.toolName === "query_product_performance_asin_lists") return { ok: true, text: JSON.stringify({ code: 1, data: { list: SAMPLE_SALES, total: SAMPLE_SALES.length } }) };
      if (request.toolName === "start_client") return { ok: true, text: "{}" };
      return { ok: true, text: JSON.stringify({ code: 1, data: {} }) };
    },
  };
  const plugin = trackPlugin(createPluginBundle({
    userDataDir: tempDir("dxos-plugin-authz-"), safeStorage: null, mcpTransport: mcp,
    sleeper: (ms) => new Promise((resolve) => setTimeout(resolve, 1)),
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }));
  assert.equal((await enableLingxing(plugin)).ok, true);

  // 临时发起（非自动化上下文）：transport 不带 gate，MCP 客户端「开关 + 审批决定」双条件原样生效。
  const adhoc = await plugin.execute("integration/lingxing/cache/sync/start", { days: 1 }, { sessionRef: "s-plugin" });
  assert.equal(adhoc.ok, true, JSON.stringify(adhoc));
  await plugin.lingxing.whenIdle();
  const adhocSales = seen.filter((call) => call.toolName === "query_product_performance_asin_lists");
  assert.ok(adhocSales.length >= 1);
  assert.ok(adhocSales.every((call) => call.gate == null), "临时发起的集成命令不得携带自动化授权 gate");

  // 自动化上下文：transport 带 gate，来源是定义授权（不是第二套审批权威）。
  seen.length = 0;
  const { bundle, clock } = openAutomation(plugin.automationAdapter);
  const created = await bundle.execute("automation/create", { definition: { instruction: "凭证", schedule: { type: "once", at: BASE + 1000 }, action: { type: "lingxing_cache_sync", args: { days: 1 } } } }, { sessionRef: "sess-auto" });
  const id = created.value.automation.id;
  clock.advance(1000);
  const run = await bundle.execute("automation/runNow", { automationId: id, await: true }, { sessionRef: "sess-auto" });
  assert.equal(run.ok, true, JSON.stringify(run));
  await plugin.lingxing.whenIdle();
  const autoSales = seen.filter((call) => call.toolName === "query_product_performance_asin_lists");
  assert.ok(autoSales.length >= 1);
  assert.ok(autoSales.every((call) => call.gate && call.gate.authorization && call.gate.authorization.approval && call.gate.authorization.approval.decision === "ALLOWED"), "自动化调用必须携带定义授权 gate");
  assert.equal(autoSales[0].gate.authorization.approval.reasonCode, "AUTOMATION_DEFINITION_AUTHORIZED");
  assert.equal(autoSales[0].gate.authorization.approval.definitionId, id);
});

// ── ⑤ 范围界定：本地动作不走定义授权闸门（闸门只针对集成/服务端动作） ──────────
test("范围界定：本地动作（open_app）不要求定义授权记录，仍如实执行并落 run", async () => {
  const { idStore, bundle, clock } = openAutomation(null, { desktop: { openApp: async () => "已打开" } });
  const created = await bundle.execute("automation/create", { definition: { instruction: "本地", schedule: { type: "once", at: BASE + 1000 }, action: { type: "open_app", args: { app: "计算器" } } } }, { sessionRef: "sess-auto" });
  const id = created.value.automation.id;
  // 删掉授权记录：本地动作不是外发动作，仍在闸门范围之外，照常执行。
  idStore.connection.prepare("DELETE FROM authorization_audit WHERE resource_ref=?").run("automation:" + id);
  clock.advance(1000);
  const run = await bundle.execute("automation/runNow", { automationId: id, await: true }, { sessionRef: "sess-auto" });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.value.result.result, "已打开");
});
