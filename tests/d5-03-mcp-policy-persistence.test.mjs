/**
 * D5-03 第二批 · 内置策略持久化（撤权不被复活）+ MCP 部分授权写路径。
 *
 * 覆盖三件事，全部走产品同一条代码路径（真实 IdentityStore / AuthorizationStore /
 * AuthorizationService / GovernanceService / McpService / ResourceService）：
 *
 *   ① 播种语义：首次使用才给（无提供记录）；有记录（含已撤销）不再 upsert；
 *   ② 治理撤销写墓碑、正式重授清墓碑；非 baseline 形状撤销不影响 baseline 记录；
 *   ③ MCP 部分授权：mcp.view/use/manage/test 可授予，跨 namespace 与越权一律拒绝；
 *      只有 mcp.view 时工具名 / 描述 / 参数 / hash 四类都不外泄。
 *
 * 真机（Electron）留待下一批；本文件是 node 层证据。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createMcpFixture, ECHO } from "./mcp-fixtures.mjs";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createMcpBundle } = require("../electron/mcp-bootstrap.cjs");
const { createModelBundle } = require("../electron/model-bootstrap.cjs");
const { createIdentityService } = require("../electron/identity-bootstrap.cjs");
const { ResourceService } = require("../electron/resource-service.cjs");
const { ResourceStore } = require("../electron/resource-store.cjs");
const { GovernanceService } = require("../electron/governance-service.cjs");
const { MCP_ACTIONS_ALL } = require("../electron/mcp-domain.cjs");

const tmpDirs = [];
const tmpDir = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), name + "-")); tmpDirs.push(d); return d; };
test.after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

/** device-fixtures 场景 + 真实 GovernanceService（治理写路径就是它，不是测试替身）。 */
function withGovernance(fx) {
  const resourceStore = new ResourceStore({ identity: fx.identity, clock: fx.clock });
  return new GovernanceService({ identity: fx.identity, authService: fx.authService, authStore: fx.store, resourceStore });
}

const mcpGrantsOf = (fx, orgId) => fx.store.appGrantsForApp("mcp-center").filter((g) => g.organization_id === orgId && g.resource_type === "mcp");
const modelGrantsOf = (fx, orgId, appId) => fx.store.appGrantsForApp(appId).filter((g) => g.organization_id === orgId && g.resource_type === "model");
const provisionOf = (fx, orgId, appId, policyKey) => fx.store.policyProvisionByKey({ organizationId: orgId, appId, policyKey });

async function withMcp(fn, options = {}) {
  const fx = await createMcpFixture(options);
  try {
    return await fn(fx, withGovernance(fx));
  } finally {
    await fx.close();
  }
}

// ---------------------------------------------------------------------------
// ① 播种语义（mcp / model / resource 三族同一口径）
// ---------------------------------------------------------------------------

test("P1 · 新组织首次使用拿到 mcp baseline 并留下提供记录；重复播种不再 upsert", async () => {
  await withMcp(async (fx) => {
    const bundle = createMcpBundle({ identityStore: fx.identity, authorization: fx.authService, authStore: fx.store, userDataDir: tmpDir("oa-d503-mcp"), safeStorage: null, clock: fx.clock });
    const seededAdmin = provisionOf(fx, fx.orgId, "mcp-center", "mcp");
    assert.ok(seededAdmin, "装配播种必须留下提供记录");
    assert.equal(seededAdmin.revoked_at, null);
    assert.equal(mcpGrantsOf(fx, fx.orgId).length, 1, "同一组织同一 App 只允许一行 mcp baseline");

    const first = bundle.seedMcpAppPolicy({ organizationId: fx.foreignOrgId, grantedBy: "admin" });
    assert.deepEqual(first, { ok: true, seeded: true }, "从未提供过的组织第一次要拿到 baseline");
    const grants = mcpGrantsOf(fx, fx.foreignOrgId);
    assert.equal(grants.length, 1);
    assert.deepEqual(JSON.parse(grants[0].actions).sort(), [...MCP_ACTIONS_ALL].sort());
    const record = provisionOf(fx, fx.foreignOrgId, "mcp-center", "mcp");
    assert.equal(record.revoked_at, null);
    assert.equal(typeof record.provisioned_at, "number");
    assert.equal(record.provisioned_by, "admin");
    const provisionedAt = record.provisioned_at;

    assert.deepEqual(bundle.seedMcpAppPolicy({ organizationId: fx.foreignOrgId, grantedBy: "admin" }), { ok: true, seeded: false }, "有提供记录就不再 upsert");
    assert.equal(mcpGrantsOf(fx, fx.foreignOrgId).length, 1, "重复播种不得产生第二行");
    assert.equal(provisionOf(fx, fx.foreignOrgId, "mcp-center", "mcp").provisioned_at, provisionedAt, "最早提供时刻不被覆盖");
  });
});

test("P2 · 治理撤销 mcp baseline → 写墓碑，再播种不复活", async () => {
  await withMcp(async (fx, governance) => {
    const bundle = createMcpBundle({ identityStore: fx.identity, authorization: fx.authService, authStore: fx.store, userDataDir: tmpDir("oa-d503-mcp"), safeStorage: null, clock: fx.clock });
    const admin = { sessionRef: fx.sessions.admin, appId: "mcp-center", source: "ui" };
    const grantId = governance.getAppAccess({ context: admin, appId: "mcp-center" }).grants.find((g) => g.resourceType === "mcp").grantId;
    const adminUserId = fx.identity.userById(fx.users.admin).id;

    const rev = governance.revokeAppAccess({ context: admin, grantId });
    assert.equal(rev.ok, true, JSON.stringify(rev));
    assert.equal(rev.changed, true);
    assert.equal(fx.store.appGrantById(grantId), null, "撤销必须是真删行");
    const record = provisionOf(fx, fx.orgId, "mcp-center", "mcp");
    assert.equal(typeof record.revoked_at, "number", "baseline 形状撤销必须写墓碑");
    assert.equal(record.revoked_by, adminUserId, "墓碑要记是谁撤的");

    assert.deepEqual(bundle.seedMcpAppPolicy({ organizationId: fx.orgId, grantedBy: adminUserId }), { ok: true, seeded: false });
    assert.equal(mcpGrantsOf(fx, fx.orgId).length, 0, "撤销后永不再给");
    assert.equal(governance.getAppAccess({ context: admin, appId: "mcp-center" }).grants.some((g) => g.resourceType === "mcp"), false);
  });
});

test("P3 · 正式重授恢复 mcp 权限、清墓碑，且播种不再重复写", async () => {
  await withMcp(async (fx, governance) => {
    const bundle = createMcpBundle({ identityStore: fx.identity, authorization: fx.authService, authStore: fx.store, userDataDir: tmpDir("oa-d503-mcp"), safeStorage: null, clock: fx.clock });
    const admin = { sessionRef: fx.sessions.admin, appId: "mcp-center", source: "ui" };
    const grantId = governance.getAppAccess({ context: admin, appId: "mcp-center" }).grants.find((g) => g.resourceType === "mcp").grantId;
    governance.revokeAppAccess({ context: admin, grantId });
    const revoked = provisionOf(fx, fx.orgId, "mcp-center", "mcp");
    assert.equal(typeof revoked.revoked_at, "number");

    const reg = governance.grantAppAccess({ context: admin, appId: "mcp-center", resourceType: "mcp", scope: "ORGANIZATION", actions: ["mcp.view", "mcp.use", "mcp.manage", "mcp.test"] });
    assert.equal(reg.ok, true, JSON.stringify(reg));
    assert.equal(reg.created, true, "撤销后重新授予是新行，不是复用旧行");
    const restored = provisionOf(fx, fx.orgId, "mcp-center", "mcp");
    assert.equal(restored.revoked_at, null, "正式重授必须清墓碑");
    assert.equal(restored.revoked_by, null);
    assert.equal(restored.provisioned_at, revoked.provisioned_at, "提供时刻保留");
    const view = governance.getAppAccess({ context: admin, appId: "mcp-center" });
    const row = view.grants.find((g) => g.resourceType === "mcp");
    assert.deepEqual([...row.actions].sort(), ["mcp.manage", "mcp.test", "mcp.use", "mcp.view"], "getAppAccess 必须回显 mcp.* 与可撤销句柄");
    assert.equal(bundle.seedMcpAppPolicy({ organizationId: fx.orgId }).seeded, false);
    assert.equal(mcpGrantsOf(fx, fx.orgId).length, 1, "重授之后播种仍不得再写第二行");
  });
});

test("P4 · 非 baseline 形状撤销不碰 baseline 记录；TOOL 形状各归各族", async () => {
  await withMcp(async (fx, governance) => {
    const admin = { sessionRef: fx.sessions.admin, appId: "mcp-center", source: "ui" };
    const mcpBefore = provisionOf(fx, fx.orgId, "mcp-center", "mcp");
    assert.equal(mcpBefore.revoked_at, null);

    // ① 针对具体 resource 的授权：撤销不得写墓碑
    const scoped = fx.store.upsertAppGrant({ appId: "mcp-center", resourceId: "res_specific_1", resourceType: "", actions: ["resource.read"], grantedBy: fx.users.admin, organizationId: fx.orgId });
    assert.equal(governance.revokeAppAccess({ context: admin, grantId: scoped.grant.id }).changed, true);
    assert.deepEqual(provisionOf(fx, fx.orgId, "mcp-center", "mcp"), mcpBefore, "定向授权撤销不得影响 baseline 记录");

    // ② memory 这类 resource_type 定向行同样不算 baseline（不创建、不改动 resource 族记录）
    const resourceBefore = provisionOf(fx, fx.orgId, "resource-library", "resource");
    const memory = fx.store.upsertAppGrant({ appId: "resource-library", resourceType: "memory", actions: ["resource.read"], grantedBy: fx.users.admin, organizationId: fx.orgId });
    governance.revokeAppAccess({ context: admin, grantId: memory.grant.id });
    assert.deepEqual(provisionOf(fx, fx.orgId, "resource-library", "resource"), resourceBefore, "memory 定向行不是 baseline");

    // ③ scope=TOOL 的 tool grant 归 tool 族：撤销写 tool 墓碑，不动 mcp 记录
    const tool = fx.store.upsertAppGrant({ appId: "mcp-center", scope: "TOOL", resourceType: "tool", actions: ["tool.resource.search"], grantedBy: fx.users.admin, organizationId: fx.orgId });
    assert.equal(provisionOf(fx, fx.orgId, "mcp-center", "tool").revoked_at, null);
    governance.revokeAppAccess({ context: admin, grantId: tool.grant.id });
    assert.equal(typeof provisionOf(fx, fx.orgId, "mcp-center", "tool").revoked_at, "number", "tool 族撤销要写墓碑");
    assert.deepEqual(provisionOf(fx, fx.orgId, "mcp-center", "mcp"), mcpBefore, "tool 撤销不得牵连 mcp 族");
  });
});

test("P5 · model baseline 同一口径：撤销 canvas 后播种不复活，其他 App 不受影响", async () => {
  await withMcp(async (fx, governance) => {
    const bundle = createModelBundle({ identityStore: fx.identity, authorization: fx.authService, authStore: fx.store, userDataDir: tmpDir("oa-d503-model"), safeStorage: null, clock: fx.clock });
    const admin = { sessionRef: fx.sessions.admin, appId: "settings", source: "ui" };
    assert.equal(modelGrantsOf(fx, fx.orgId, "canvas").length, 1);
    assert.equal(modelGrantsOf(fx, fx.orgId, "ai").length, 1);
    const adminUserId = fx.identity.userById(fx.users.admin).id;

    const canvasGrantId = modelGrantsOf(fx, fx.orgId, "canvas")[0].id;
    assert.equal(governance.revokeAppAccess({ context: admin, grantId: canvasGrantId }).changed, true);
    const record = provisionOf(fx, fx.orgId, "canvas", "model");
    assert.equal(typeof record.revoked_at, "number");
    assert.equal(record.revoked_by, adminUserId);

    const reseed = bundle.seedModelAppPolicy({ organizationId: fx.orgId, grantedBy: adminUserId });
    assert.deepEqual(reseed, { ok: true, seeded: false }, "有记录就不再种");
    assert.equal(modelGrantsOf(fx, fx.orgId, "canvas").length, 0, "撤销后永不再给");
    assert.equal(modelGrantsOf(fx, fx.orgId, "ai").length, 1, "同一组织其他 App 的 model baseline 不受影响");
    assert.equal(provisionOf(fx, fx.orgId, "ai", "model").revoked_at, null);
  });
});

test("P6 · resource baseline：撤销后重启（新实例、无内存守卫）不复活", async () => {
  const f = await createResourceFixture();
  try {
    const alice = f.ctx("alice");
    const trigger = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "SeedTrigger", content: "seed" });
    assert.equal(trigger.ok, true, JSON.stringify(trigger));
    const baselineOf = (appId) => f.store.appGrantsForApp(appId).find((g) => g.organization_id === f.orgId && g.resource_type === "" && !g.resource_id && !g.collection_id && !g.department_id && String(g.scope) === "");
    const canvasBaseline = baselineOf("canvas");
    assert.ok(canvasBaseline, "resource baseline 必须先存在：" + JSON.stringify(f.store.appGrantsForApp("canvas")));
    assert.equal(f.store.policyProvisionByKey({ organizationId: f.orgId, appId: "canvas", policyKey: "resource" }).revoked_at, null);

    assert.equal(f.governanceService.revokeAppAccess({ context: f.adminCtx(), grantId: canvasBaseline.id }).changed, true);
    assert.equal(typeof f.store.policyProvisionByKey({ organizationId: f.orgId, appId: "canvas", policyKey: "resource" }).revoked_at, "number");
    const grantCountBefore = f.store.appGrantsForApp("canvas").length;

    // 应用重启：新实例没有旧的 #builtinEnsured 内存守卫，这正是原来"重启后第一次资源操复活"的路径
    const restarted = new ResourceService({ identity: f.identity, resourceStore: f.resourceStore, managedStore: f.managedStore, authService: f.authService, authStore: f.store, deviceService: f.deviceService, clock: f.clock });
    const after = await restarted.createResource({ context: alice, resourceType: "text", name: "AfterRestart", content: "after" });
    assert.equal(after.ok, true, JSON.stringify(after));
    assert.equal(f.store.appGrantsForApp("canvas").some((g) => g.id === canvasBaseline.id), false, "撤销的 baseline 不得被重启后的第一次资源操作补回来");
    assert.equal(f.store.appGrantsForApp("canvas").length, grantCountBefore, "重启后不得新增 baseline 行");
    assert.equal(typeof f.store.policyProvisionByKey({ organizationId: f.orgId, appId: "canvas", policyKey: "resource" }).revoked_at, "number", "墓碑保持");
    assert.equal(f.store.policyProvisionByKey({ organizationId: f.orgId, appId: "ai", policyKey: "resource" }).revoked_at, null, "其他 App 的 resource baseline 记录不受影响");
  } finally {
    f.close();
  }
});

// ---------------------------------------------------------------------------
// ② 真实装配：登录 → 撤销 → 重启 → 再登录
// ---------------------------------------------------------------------------

test("P7 · 真机同一条装配路径：撤销 mcp baseline 后重启 + 重新登录仍不复活，重授后跨重启保持", async () => {
  const dir = tmpDir("oa-d503-boot");
  const ID = "admin@d503.test";
  const PW = "d503-password-1";
  const open = () => createIdentityService({ userDataDir: dir, safeStorage: null, allowAdmin: true, serviceIdentity: "svc_d503_probe" });

  const a = open();
  assert.equal((await a.service.dispatch({ type: "identity/initialize", identifier: ID, password: PW, displayName: "Admin" })).ok, true);
  const login1 = await a.service.dispatch({ type: "identity/login", identifier: ID, password: PW });
  assert.equal(login1.ok, true, JSON.stringify(login1));
  const orgId = login1.snapshot.teamId;
  const ctx = { sessionRef: login1.snapshot.sessionRef, appId: "mcp-center", source: "ui" };
  assert.equal(a.authStore.appGrantsForApp("mcp-center").filter((g) => g.organization_id === orgId && g.resource_type === "mcp").length, 1, "登录路径必须完成 mcp baseline 播种");
  const modelRows = () => ["settings", "resource-library", "ai", "canvas"].reduce((n, id) => n + a.authStore.appGrantsForApp(id).filter((g) => g.resource_type === "model").length, 0);
  const modelRowsBefore = modelRows();
  assert.equal(modelRowsBefore, 4, "登录路径必须完成 model baseline 播种");

  const grantId = a.governanceService.getAppAccess({ context: ctx, appId: "mcp-center" }).grants.find((g) => g.resourceType === "mcp").grantId;
  assert.equal(a.governanceService.revokeAppAccess({ context: ctx, grantId }).changed, true);
  const revokedAt = a.authStore.policyProvisionByKey({ organizationId: orgId, appId: "mcp-center", policyKey: "mcp" }).revoked_at;
  assert.equal(typeof revokedAt, "number");
  a.store.close();

  // 重启（应用重启 = 重新装配同一份用户数据目录）
  const b = open();
  assert.equal(b.authStore.appGrantsForApp("mcp-center").filter((g) => g.organization_id === orgId).length, 0, "重启装配不得把撤销的 baseline 种回来");
  const login2 = await b.service.dispatch({ type: "identity/login", identifier: ID, password: PW });
  assert.equal(login2.ok, true);
  assert.equal(b.authStore.appGrantsForApp("mcp-center").filter((g) => g.organization_id === orgId).length, 0, "重新登录不得把撤销的 baseline 种回来");
  assert.equal(b.authStore.policyProvisionByKey({ organizationId: orgId, appId: "mcp-center", policyKey: "mcp" }).revoked_at, revokedAt, "墓碑跨重启保持");
  assert.equal(["settings", "resource-library", "ai", "canvas"].reduce((n, id) => n + b.authStore.appGrantsForApp(id).filter((g) => g.resource_type === "model").length, 0), modelRowsBefore, "重启 + 重新登录不得重复写 model baseline");

  // 正式重授 → 跨重启保持
  const ctx2 = { sessionRef: login2.snapshot.sessionRef, appId: "mcp-center", source: "ui" };
  const reg = b.governanceService.grantAppAccess({ context: ctx2, appId: "mcp-center", resourceType: "mcp", scope: "ORGANIZATION", actions: ["mcp.view", "mcp.use"] });
  assert.equal(reg.ok, true, JSON.stringify(reg));
  assert.equal(b.authStore.policyProvisionByKey({ organizationId: orgId, appId: "mcp-center", policyKey: "mcp" }).revoked_at, null, "重授清墓碑");
  b.store.close();

  const c = open();
  const login3 = await c.service.dispatch({ type: "identity/login", identifier: ID, password: PW });
  assert.equal(login3.ok, true);
  const rows = c.authStore.appGrantsForApp("mcp-center").filter((g) => g.organization_id === orgId && g.resource_type === "mcp");
  assert.equal(rows.length, 1, "重授后跨重启保持恰好一行");
  assert.deepEqual(JSON.parse(rows[0].actions).sort(), ["mcp.use", "mcp.view"]);
  assert.equal(c.authStore.policyProvisionByKey({ organizationId: orgId, appId: "mcp-center", policyKey: "mcp" }).revoked_at, null);
  c.store.close();
});

// ---------------------------------------------------------------------------
// ③ MCP 部分授权写路径 + 只有 mcp.view 时的投影边界
// ---------------------------------------------------------------------------

const grantMcp = (governance, fx, appId, actions, scope = "ORGANIZATION") =>
  governance.grantAppAccess({ context: { sessionRef: fx.sessions.admin, appId: "resource-library", source: "ui" }, appId, resourceType: "mcp", scope, actions });

test("S1 · 合法的 mcp.view/use/manage/test 组合能授予并落库、能回显", async () => {
  await withMcp(async (fx, governance) => {
    fx.store.upsertApp({ appId: "skill-runtime", name: "技能运行时", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
    const combos = [["mcp.view"], ["mcp.view", "mcp.use"], ["mcp.manage"], ["mcp.view", "mcp.use", "mcp.manage", "mcp.test"]];
    for (const actions of combos) {
      const res = grantMcp(governance, fx, "skill-runtime", actions);
      assert.equal(res.ok, true, JSON.stringify(actions) + " -> " + JSON.stringify(res));
      const rows = fx.store.appGrantsForApp("skill-runtime").filter((g) => g.resource_type === "mcp");
      assert.equal(rows.length, 1, "同组织同 App 只有一行 mcp grant");
      assert.deepEqual(JSON.parse(rows[0].actions).sort(), [...actions].sort());
      assert.equal(rows[0].organization_id, fx.orgId);
      const view = governance.getAppAccess({ context: { sessionRef: fx.sessions.admin, appId: "resource-library", source: "ui" }, appId: "skill-runtime" });
      const projected = view.grants.find((g) => g.resourceType === "mcp");
      assert.deepEqual([...projected.actions].sort(), [...actions].sort(), "getAppAccess 必须回显刚落库的 mcp.*");
    }
    // permissionSet 不适用于 mcp（与 model 同口径）
    const bad = governance.grantAppAccess({ context: { sessionRef: fx.sessions.admin, appId: "resource-library", source: "ui" }, appId: "skill-runtime", resourceType: "mcp", permissionSet: "VIEWER" });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "INVALID_INPUT");
    assert.equal(grantMcp(governance, fx, "skill-runtime", []).error, "INVALID_INPUT");
  });
});

test("S2 · 跨命名空间动作一律 INVALID_INPUT（mcp / model / resource / tool 互不通用）", async () => {
  await withMcp(async (fx, governance) => {
    const ctx = { sessionRef: fx.sessions.admin, appId: "resource-library", source: "ui" };
    const attempts = [
      { resourceType: "mcp", actions: ["model.use"] },
      { resourceType: "mcp", actions: ["resource.read"] },
      { resourceType: "mcp", actions: ["tool.resource.search"] },
      { resourceType: "mcp", actions: ["mcp.view", "resource.read"] },
      { resourceType: "mcp", actions: ["mcp.use", "model.manage"] },
      { resourceType: "model", actions: ["mcp.view"] },
      { resourceType: "", actions: ["mcp.view"] },
    ];
    for (const attempt of attempts) {
      const res = governance.grantAppAccess({ context: ctx, appId: "skill-runtime", ...attempt });
      assert.equal(res.ok, false, JSON.stringify(attempt));
      assert.equal(res.error, "INVALID_INPUT", JSON.stringify(attempt) + " -> " + JSON.stringify(res));
    }
    assert.equal(fx.store.appGrantsForApp("skill-runtime").length, 0, "被拒的写入不得留下任何 grant 行");
  });
});

test("S3 · 越权拒绝：非 Super Admin 不能授 ORGANIZATION scope 的 mcp.manage", async () => {
  await withMcp(async (fx, governance) => {
    for (const key of ["alice", "dana"]) {
      const res = governance.grantAppAccess({ context: { sessionRef: fx.sessions[key], appId: "resource-library", source: "ui" }, appId: "skill-runtime", resourceType: "mcp", scope: "ORGANIZATION", actions: ["mcp.manage"] });
      assert.equal(res.ok, false, key);
      assert.equal(res.error, "NOT_SUPER_ADMIN", key + " -> " + JSON.stringify(res));
    }
    assert.equal(fx.store.appGrantsForApp("skill-runtime").length, 0, "越权尝试不得留下 grant 行");
    const ok = governance.grantAppAccess({ context: { sessionRef: fx.sessions.admin, appId: "resource-library", source: "ui" }, appId: "skill-runtime", resourceType: "mcp", scope: "ORGANIZATION", actions: ["mcp.manage"] });
    assert.equal(ok.ok, true, "Super Admin 可以授 ORGANIZATION scope 的 mcp.manage：" + JSON.stringify(ok));
  });
});

test("S4 · 只有 mcp.view：状态可见、toolsHidden=true，工具名/描述/参数/hash 四类都不外泄", async () => {
  await withMcp(async (fx, governance) => {
    fx.store.upsertApp({ appId: "skill-runtime", name: "技能运行时", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
    const created = await fx.invoke({ command: "mcp/create", name: "团队回显", transport: "stdio", location: "LOCAL_DEVICE", endpoint: { serverKey: ECHO.serverKey }, visibility: "ORGANIZATION" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    const connected = await fx.invoke({ command: "mcp/connect", connectionId: id });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.deepEqual(connected.connection.tools.map((t) => t.name), ECHO.tools, "有 mcp.use 的宿主 App 必须看得到工具目录（阳性对照）");

    const granted = grantMcp(governance, fx, "skill-runtime", ["mcp.view"]);
    assert.equal(granted.ok, true, JSON.stringify(granted));
    const roCtx = { sessionRef: fx.sessions.alice, appId: "skill-runtime", source: "ui" };
    const view = fx.mcpService.getConnection({ context: roCtx, connectionId: id });
    assert.equal(view.ok, true, JSON.stringify(view));
    assert.equal(view.connection.status, "READY", "连接状态必须可见");
    assert.equal(view.connection.toolsHidden, true);
    assert.deepEqual(view.connection.tools, []);
    assert.equal(view.connection.toolsHash, null);
    const list = fx.mcpService.listConnections({ context: roCtx });
    assert.equal(list.ok, true);
    assert.equal(list.items.length, 1, "团队连接对组织成员可见");
    const log = fx.mcpService.testLog({ context: roCtx, connectionId: id, limit: 50 });
    assert.equal(log.ok, true);
    assert.equal(log.items.some((x) => x.event === "TOOLS_DISCOVERED"), true, "日志本身可见（只是不该带能力数据）");

    const leaks = ["echo_sum", "describe_self", "把两个数字相加", "描述本测试服务", "inputSchema", "properties", "hash="];
    for (const [label, payload] of [["getConnection", view], ["listConnections", list], ["testLog", log]]) {
      const text = JSON.stringify(payload);
      for (const leak of leaks) assert.equal(text.includes(leak), false, label + " 泄漏了 " + leak + "：" + text.slice(0, 240));
      assert.equal(/[0-9a-f]{32,}/.test(text), false, label + " 泄漏了长十六进制 hash：" + text.slice(0, 240));
    }
    assert.equal(JSON.stringify(log).includes("tools=2"), true, "日志可以保留工具数量（不是描述）");
    // 无权 App 也不能靠连接/测试命令绕过去拿工具目录
    assert.equal((await fx.mcpService.connect({ context: roCtx, connectionId: id })).error, "MCP_UNAUTHORIZED");
    assert.equal((await fx.mcpService.test({ context: roCtx, connectionId: id })).error, "MCP_UNAUTHORIZED");
    // 拿到 mcp.use 之后同一连接就可见（证明上面的隐藏是权限判定，不是功能坏了）
    assert.equal(grantMcp(governance, fx, "skill-runtime", ["mcp.view", "mcp.use"]).ok, true);
    const useView = fx.mcpService.getConnection({ context: roCtx, connectionId: id });
    assert.equal(useView.connection.toolsHidden, false);
    assert.deepEqual(useView.connection.tools.map((t) => t.name), ECHO.tools);
  });
});