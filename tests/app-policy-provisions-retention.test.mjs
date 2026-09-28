/**
 * D5-03 第四批 · app_policy_provisions 保留规则（测试即合同）。
 *
 * 产品口径（v21）：内置策略"首次使用才给，撤销后永不再给"。这条口径成立的前提是
 * **只要组织还在，撤权记录（(organization_id, app_id, policy_key) 行 + 其 revoked_at 墓碑）
 * 就永远不被删除、不被改写**。本文件把这条规则立成可执行的合同：
 *
 *   R1 撤销后反复"重播种 / 重试"（resource / model / mcp 三族）→ 墓碑逐字段不变、撤权不复活；
 *   R2 其它组织操作（部门 / 集合 / 资源 / App 状态 / 定向授权与撤销 / 另一个组织播种 / 审计读取）
 *      → 一条撤权记录都不许消失或被改写；
 *   R3 应用重启（关库 → 重开 → 重放迁移链 → 重新登录 → 再播种）→ 墓碑跨重启保持；
 *   R4 正式重授：只清撤销标记，不删行、不重复建行；再撤销仍只有一行；
 *   R5 resetInstallation：现状刻画 + "组织整体消失"路径的安全不变量（判断证据，不改产品代码）；
 *   R6 源码级守卫：electron/** 里除登记的组织删除路径外，任何 app_policy_provisions 行删除都 FAIL。
 *
 * 临时目录前缀 oa-d503d-retention-，与 mcp-policy-e2e.mjs 的 oa-d503b- 命名空间分开。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createResourceFixture, reopenResourceRuntime, tempRoot } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createModelBundle } = require(path.join(ROOT, "electron", "model-bootstrap.cjs"));
const { createMcpBundle } = require(path.join(ROOT, "electron", "mcp-bootstrap.cjs"));
const { createIdentityService } = require(path.join(ROOT, "electron", "identity-bootstrap.cjs"));
const { APP_POLICY_KEYS } = require(path.join(ROOT, "electron", "identity-store.cjs"));

const TABLE = "app_policy_provisions";
const ADMIN_LOGIN = { identifier: "admin@openarc.test", password: "admin-password-1" };
const TEMP_DIRS = [];
test.after(() => {
  for (const dir of TEMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
const tmpDir = (prefix = "oa-d503d-retention-") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
};

/* ══════════════════════ 公共取值器 ══════════════════════ */

const rowKey = (row) => row.organization_id + "|" + row.app_id + "|" + row.policy_key;
/** 一行撤权记录的可比较快照（只取业务字段，忽略 SQLite 行序）。 */
const rowSnapshot = (row) => ({
  organization_id: row.organization_id,
  app_id: row.app_id,
  policy_key: row.policy_key,
  provisioned_at: row.provisioned_at,
  provisioned_by: row.provisioned_by,
  revoked_at: row.revoked_at,
  revoked_by: row.revoked_by,
});
const snapshotRows = (store, orgId = null) =>
  store.allPolicyProvisions().filter((r) => orgId === null || r.organization_id === orgId).map(rowSnapshot).sort((a, b) => (rowKey(a) < rowKey(b) ? -1 : 1));
const snapshotRow = (store, orgId, appId, policyKey) => {
  const row = store.policyProvisionByKey({ organizationId: orgId, appId, policyKey });
  return row ? rowSnapshot(row) : null;
};
const pairList = (store, orgId) => store.allPolicyProvisions().filter((r) => r.organization_id === orgId).map((r) => r.app_id + "|" + r.policy_key).sort();
const countRows = (store, orgId, appId, policyKey) =>
  store.db.prepare("SELECT COUNT(*) c FROM " + TABLE + " WHERE organization_id = ? AND app_id = ? AND policy_key = ?").get(orgId, appId, policyKey).c;
/** baseline 形状的 grant 行：app 级（三个 id 全空）+ baseline scope。 */
const baselineGrantOf = (store, orgId, appId, resourceType) =>
  store.appGrantsForApp(appId).find((g) => g.organization_id === orgId && String(g.resource_type) === resourceType && !g.resource_id && !g.collection_id && !g.department_id && String(g.scope) === "") || null;

/** 核心合同：before 里的每一行撤权记录必须仍然存在，且逐字段不变。 */
function assertRowsPreserved(store, before, label) {
  const now = new Map(store.allPolicyProvisions().map((r) => [rowKey(r), rowSnapshot(r)]));
  for (const row of before) {
    const key = rowKey(row);
    const current = now.get(key);
    assert.ok(current, label + "：撤权记录行被删掉了 → " + key);
    assert.deepEqual(current, row, label + "：撤权记录被改写 → " + key);
  }
}

/** 首次播种 + 撤销 canvas(resource) 与 mcp-center(mcp)，返回撤销前后证据。 */
async function seedAndRevoke(f) {
  const adminCtx = f.adminCtx();
  const adminUserId = String(f.users.admin);
  const bundles = {
    model: createModelBundle({ identityStore: f.identity, authorization: f.authService, authStore: f.store, userDataDir: tmpDir("oa-d503d-retention-model-"), safeStorage: null, clock: f.clock }),
    mcp: createMcpBundle({ identityStore: f.identity, authorization: f.authService, authStore: f.store, userDataDir: tmpDir("oa-d503d-retention-mcp-"), safeStorage: null, clock: f.clock }),
  };
  const trigger = await f.resourceService.createResource({ context: f.ctx("alice"), resourceType: "text", name: "SeedTrigger", content: "seed" });
  assert.equal(trigger.ok, true, "resource baseline 播种触发器必须成功：" + JSON.stringify(trigger));
  const canvasGrant = baselineGrantOf(f.store, f.orgId, "canvas", "");
  const mcpGrant = baselineGrantOf(f.store, f.orgId, "mcp-center", "mcp");
  assert.ok(canvasGrant, "canvas 的 resource baseline 必须先存在");
  assert.ok(mcpGrant, "mcp-center 的 mcp baseline 必须先存在");
  assert.equal(f.governanceService.revokeAppAccess({ context: adminCtx, grantId: canvasGrant.id }).changed, true);
  assert.equal(f.governanceService.revokeAppAccess({ context: adminCtx, grantId: mcpGrant.id }).changed, true);
  const tombstones = {
    canvas: snapshotRow(f.store, f.orgId, "canvas", "resource"),
    mcp: snapshotRow(f.store, f.orgId, "mcp-center", "mcp"),
  };
  assert.equal(typeof tombstones.canvas.revoked_at, "number", "canvas 撤销必须写墓碑");
  assert.equal(typeof tombstones.mcp.revoked_at, "number", "mcp 撤销必须写墓碑");
  assert.equal(tombstones.canvas.revoked_by, adminUserId);
  assert.equal(baselineGrantOf(f.store, f.orgId, "canvas", ""), null, "撤销必须是真删 grant 行");
  return { bundles, adminUserId };
}

/* ══════════════════════ R1 ══════════════════════ */

test("R1 · 组织仍存在时：撤销后反复重播种/重试，撤权记录不消失、撤权不复活", async () => {
  const f = await createResourceFixture();
  try {
    const { bundles, adminUserId } = await seedAndRevoke(f);
    const before = snapshotRows(f.store, f.orgId);
    assert.equal(before.length > 0, true, "撤权记录不能为空");

    for (let round = 1; round <= 3; round++) {
      const again = await f.resourceService.createResource({ context: f.ctx("alice"), resourceType: "text", name: "Reseed" + round, content: "x" });
      assert.equal(again.ok, true, "第 " + round + " 次资源操作必须成功：" + JSON.stringify(again));
      assert.deepEqual(bundles.model.seedModelAppPolicy({ organizationId: f.orgId, grantedBy: adminUserId }), { ok: true, seeded: false }, "第 " + round + " 次 model 重播种必须跳过");
      assert.deepEqual(bundles.mcp.seedMcpAppPolicy({ organizationId: f.orgId, grantedBy: adminUserId }), { ok: true, seeded: false }, "第 " + round + " 次 mcp 重播种必须跳过");

      assertRowsPreserved(f.store, before, "第 " + round + " 次重播种后");
      assert.equal(baselineGrantOf(f.store, f.orgId, "canvas", ""), null, "重播种不得把撤销的 canvas resource baseline 种回来");
      assert.equal(baselineGrantOf(f.store, f.orgId, "mcp-center", "mcp"), null, "重播种不得把撤销的 mcp baseline 种回来");
      assert.equal(countRows(f.store, f.orgId, "canvas", "resource"), 1, "撤权记录必须恰好一行");
      assert.equal(countRows(f.store, f.orgId, "mcp-center", "mcp"), 1, "撤权记录必须恰好一行");
    }
    assert.deepEqual(snapshotRows(f.store, f.orgId), before, "反复重播种后撤权记录必须逐字段不变");
  } finally {
    f.close();
  }
});

/* ══════════════════════ R2 ══════════════════════ */

test("R2 · 其它组织操作不得让任何撤权记录消失或被改写", async () => {
  const f = await createResourceFixture();
  try {
    const { bundles, adminUserId } = await seedAndRevoke(f);
    const before = snapshotRows(f.store, f.orgId);
    const adminCtx = f.adminCtx();
    const totalBefore = f.store.allPolicyProvisions().length;

    const dept = f.governanceService.createDepartment({ context: adminCtx, name: "RetentionDept" });
    assert.equal(dept.ok, true, "建部门必须成功：" + JSON.stringify(dept));
    const col = f.authService.createCollection({ context: adminCtx, name: "RetentionCol", departmentId: dept.department.id, scope: "DEPARTMENT" });
    assert.equal(col.ok, true, "建集合必须成功：" + JSON.stringify(col));
    const res = f.authService.registerResource({ context: adminCtx, resourceId: "res_retention_000001", resourceType: "document", ownerUserId: adminUserId, scope: "ORGANIZATION", name: "RetentionRes" });
    assert.equal(res.ok, true, "注册资源必须成功：" + JSON.stringify(res));
    f.store.setAppStatus("photoshop", "disabled");
    f.store.setAppStatus("photoshop", "enabled");
    f.store.upsertApp({ appId: "photoshop", name: "Photoshop（改名）", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });

    // 定向（非 baseline 形状）授权 + 撤销：不得创建 baseline 记录，也不得改动同族已有 baseline 记录
    const photoshopBefore = snapshotRow(f.store, f.orgId, "photoshop", "resource");
    assert.equal(typeof photoshopBefore.provisioned_at, "number", "photoshop 的 resource baseline 记录必须先存在（它是表内提供者）");
    const targeted = f.store.upsertAppGrant({ appId: "settings", resourceType: "image", actions: ["resource.view", "resource.read"], grantedBy: adminUserId, organizationId: f.orgId });
    assert.equal(snapshotRow(f.store, f.orgId, "settings", "resource"), null, "定向授权不得创建 resource 族 baseline 记录");
    assert.equal(f.governanceService.revokeAppAccess({ context: adminCtx, grantId: targeted.grant.id }).changed, true);
    assert.equal(snapshotRow(f.store, f.orgId, "settings", "resource"), null, "定向撤销不得创建 baseline 记录");
    assert.deepEqual(snapshotRow(f.store, f.orgId, "photoshop", "resource"), photoshopBefore, "定向授权/撤销不得改动同族已有 baseline 记录");

    // 另一个组织的首次播种：不得牵连本组织的撤权记录
    assert.deepEqual(bundles.model.seedModelAppPolicy({ organizationId: f.foreignOrgId, grantedBy: adminUserId }).ok, true);
    assert.deepEqual(bundles.mcp.seedMcpAppPolicy({ organizationId: f.foreignOrgId, grantedBy: adminUserId }), { ok: true, seeded: true }, "另一组织首次 mcp 播种必须成功");
    assert.equal(f.store.policyProvisionByKey({ organizationId: f.foreignOrgId, appId: "mcp-center", policyKey: "mcp" }) !== null, true);

    // 只读路径与自检
    assert.equal(Array.isArray(f.store.authorizationAudit()), true);
    assert.equal(Array.isArray(f.identity.allUsers()), true);
    assert.deepEqual(f.identity.invariants(), [], "身份库自检必须为空");

    assert.equal(f.store.allPolicyProvisions().length >= totalBefore, true, "撤权记录总数只增不减");
    assertRowsPreserved(f.store, before, "其它组织操作后");
    assert.equal(countRows(f.store, f.orgId, "canvas", "resource"), 1);
    assert.equal(countRows(f.store, f.orgId, "mcp-center", "mcp"), 1);
    assert.equal(baselineGrantOf(f.store, f.orgId, "canvas", ""), null, "撤权不得复活");
    assert.equal(baselineGrantOf(f.store, f.orgId, "mcp-center", "mcp"), null, "撤权不得复活");
  } finally {
    f.close();
  }
});

/* ══════════════════════ R3 ══════════════════════ */

test("R3 · 应用重启（关库 → 重开 → 重放迁移 → 重新登录 → 再播种）墓碑保持", async () => {
  const root = tempRoot("oa-d503d-retention-restart-");
  TEMP_DIRS.push(root);
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const f = await createResourceFixture({ dbPath, storeRoot });
  let reopened = null;
  try {
    const { bundles, adminUserId } = await seedAndRevoke(f);
    const before = snapshotRows(f.store, f.orgId);
    const orgId = f.orgId;
    f.identity.close();

    // 应用重启：新实例、无内存守卫（这正是"原来重启后第一次资源操作会复活"的那条路径）
    reopened = reopenResourceRuntime({ dbPath, storeRoot });
    assert.deepEqual(snapshotRows(reopened.authStore, orgId), before, "重开库 + 重放迁移链后撤权记录必须逐字段不变");
    const login = await reopened.identity.login(ADMIN_LOGIN);
    assert.equal(login.ok, true, "重启后重新登录必须成功：" + JSON.stringify(login.error || null));
    const trigger = await reopened.resourceService.createResource({ context: { sessionRef: login.session.ref, appId: "resource-library", source: "ui" }, resourceType: "text", name: "AfterRestart", content: "after" });
    assert.equal(trigger.ok, true, "重启后第一次资源操作必须成功：" + JSON.stringify(trigger));
    assert.deepEqual(snapshotRows(reopened.authStore, orgId), before, "重启后的播种不得改动撤权记录");
    assert.equal(baselineGrantOf(reopened.authStore, orgId, "canvas", ""), null, "重启后不得把撤销的 canvas baseline 种回来");
    assert.equal(baselineGrantOf(reopened.authStore, orgId, "mcp-center", "mcp"), null, "重启后不得把撤销的 mcp baseline 种回来");

    // 重启后的新装配实例再播种一遍
    const model2 = createModelBundle({ identityStore: reopened.identity, authorization: reopened.authService, authStore: reopened.authStore, userDataDir: tmpDir("oa-d503d-retention-model2-"), safeStorage: null });
    const mcp2 = createMcpBundle({ identityStore: reopened.identity, authorization: reopened.authService, authStore: reopened.authStore, userDataDir: tmpDir("oa-d503d-retention-mcp2-"), safeStorage: null });
    assert.deepEqual(model2.seedModelAppPolicy({ organizationId: orgId, grantedBy: adminUserId }), { ok: true, seeded: false });
    assert.deepEqual(mcp2.seedMcpAppPolicy({ organizationId: orgId, grantedBy: adminUserId }), { ok: true, seeded: false });
    assert.deepEqual(snapshotRows(reopened.authStore, orgId), before, "重启后重播种不得改动撤权记录");
    assert.equal(countRows(reopened.authStore, orgId, "canvas", "resource"), 1);
    assert.equal(countRows(reopened.authStore, orgId, "mcp-center", "mcp"), 1);
  } finally {
    if (reopened) { try { reopened.identity.close(); } catch { /* 已关闭 */ } }
    f.close();
  }
});

/* ══════════════════════ R4 ══════════════════════ */

test("R4 · 正式重授只清撤销标记：不删行、不重复建行、最早提供时刻保留", async () => {
  const f = await createResourceFixture();
  try {
    const { adminUserId } = await seedAndRevoke(f);
    const revoked = snapshotRow(f.store, f.orgId, "canvas", "resource");
    assert.equal(typeof revoked.revoked_at, "number");

    for (let cycle = 1; cycle <= 2; cycle++) {
      const regrant = f.governanceService.grantAppAccess({ context: f.adminCtx(), appId: "canvas", actions: ["resource.view", "resource.read"] });
      assert.equal(regrant.ok, true, "第 " + cycle + " 轮正式重授必须成功：" + JSON.stringify(regrant));
      const restored = snapshotRow(f.store, f.orgId, "canvas", "resource");
      assert.equal(restored.revoked_at, null, "第 " + cycle + " 轮重授必须清撤销标记");
      assert.equal(restored.revoked_by, null, "第 " + cycle + " 轮重授必须清撤销人");
      assert.equal(restored.provisioned_at, revoked.provisioned_at, "第 " + cycle + " 轮重授不得改写最早提供时刻");
      assert.equal(restored.provisioned_by, revoked.provisioned_by, "第 " + cycle + " 轮重授不得改写提供人");
      assert.equal(countRows(f.store, f.orgId, "canvas", "resource"), 1, "重授不得新增行");

      const grant = baselineGrantOf(f.store, f.orgId, "canvas", "");
      assert.ok(grant, "第 " + cycle + " 轮重授必须真的写回 grant 行");
      assert.equal(f.governanceService.revokeAppAccess({ context: f.adminCtx(), grantId: grant.id }).changed, true);
      const again = snapshotRow(f.store, f.orgId, "canvas", "resource");
      assert.equal(typeof again.revoked_at, "number", "第 " + cycle + " 轮再撤销必须重新写墓碑");
      assert.equal(again.provisioned_at, revoked.provisioned_at, "再撤销不得改写最早提供时刻");
      assert.equal(countRows(f.store, f.orgId, "canvas", "resource"), 1, "再撤销不得新增行");
    }

    // clearPolicyRevoked 是"只清标记"的唯一入口：记录不存在时不得凭空造行
    const totalBefore = f.store.allPolicyProvisions().length;
    assert.equal(f.store.clearPolicyRevoked({ organizationId: f.orgId, appId: "browser", policyKey: "tool" }), null, "记录不存在时清墓碑不得造行");
    assert.equal(f.store.allPolicyProvisions().length, totalBefore);
    assert.equal(snapshotRow(f.store, f.orgId, "browser", "tool"), null);
  } finally {
    f.close();
  }
});

/* ══════════════════════ R5 · resetInstallation ══════════════════════ */

test("R5 · resetInstallation 是唯一「组织整体消失」路径：现状刻画 + 安全不变量（判断证据，不改产品代码）", async (t) => {
  const dir = tmpDir("oa-d503d-retention-reset-");
  const ID = "admin@d503d-retention.test";
  const PW = "retention-password-1";
  const open = () => createIdentityService({ userDataDir: dir, safeStorage: null, allowAdmin: true, serviceIdentity: "svc_d503d_retention" });

  const a = open();
  let oldOrg = null;
  let beforePairs = null;
  let orphan = null;
  let tombstoneBefore = null;
  try {
    assert.equal((await a.service.dispatch({ type: "identity/initialize", identifier: ID, password: PW, displayName: "Admin" })).ok, true);
    const login = await a.service.dispatch({ type: "identity/login", identifier: ID, password: PW });
    assert.equal(login.ok, true, "登录必须成功：" + JSON.stringify(login));
    oldOrg = login.snapshot.teamId;
    const trigger = await a.resourceService.createResource({ context: { sessionRef: login.snapshot.sessionRef, appId: "resource-library", source: "ui" }, resourceType: "text", name: "ResetSeed", content: "x" });
    assert.equal(trigger.ok, true, JSON.stringify(trigger));
    beforePairs = pairList(a.authStore, oldOrg);
    assert.equal(beforePairs.length, 15, "首次使用必须播满 10 resource + 4 model + 1 mcp：" + JSON.stringify(beforePairs));

    const mcpGrant = a.authStore.appGrantsForApp("mcp-center").find((g) => g.organization_id === oldOrg && g.resource_type === "mcp");
    assert.ok(mcpGrant, "mcp baseline 必须先存在");
    assert.equal(a.governanceService.revokeAppAccess({ context: { sessionRef: login.snapshot.sessionRef, appId: "mcp-center", source: "ui" }, grantId: mcpGrant.id }).changed, true);
    tombstoneBefore = snapshotRow(a.authStore, oldOrg, "mcp-center", "mcp");
    assert.equal(typeof tombstoneBefore.revoked_at, "number");

    const reset = a.store.resetInstallation({ confirm: "DELETE-ALL-IDENTITY-DATA" });
    assert.equal(reset.ok, true, "resetInstallation 必须成功：" + JSON.stringify(reset));
    const count = (sql) => a.store.connection.prepare(sql).get().c;
    assert.equal(count("SELECT COUNT(*) c FROM users"), 0);
    assert.equal(count("SELECT COUNT(*) c FROM teams"), 0);
    assert.equal(count("SELECT COUNT(*) c FROM installations"), 0);
    assert.equal(count("SELECT COUNT(*) c FROM sessions"), 0);
    assert.equal(count("SELECT COUNT(*) c FROM audit_log") > 0, true, "审计留痕不得被重置删掉");
    assert.deepEqual(a.store.invariants(), [], "重置后身份库自检仍为空（现有不变量不检查指向已删组织的孤儿行）");

    orphan = {
      provisions: count("SELECT COUNT(*) c FROM " + TABLE + " WHERE organization_id = '" + oldOrg + "'"),
      grants: count("SELECT COUNT(*) c FROM app_resource_grants WHERE organization_id = '" + oldOrg + "'"),
      tombstone: snapshotRow(a.authStore, oldOrg, "mcp-center", "mcp"),
    };
    assert.equal(orphan.provisions, 15, "现状：resetInstallation 不清理 app_policy_provisions（残留行指向已删除的组织）");
    assert.equal(orphan.grants, 15, "现状：resetInstallation 同样不清理 app_resource_grants");
    assert.deepEqual(orphan.tombstone, tombstoneBefore, "现状：墓碑原样留在孤儿行上");
    t.diagnostic("resetInstallation 现状：残留 provisions=" + orphan.provisions + " grants=" + orphan.grants + "（旧组织 " + oldOrg + " 已从 teams 删除）");
  } finally {
    a.store.close();
  }

  const b = open();
  try {
    assert.equal((await b.service.dispatch({ type: "identity/initialize", identifier: ID, password: PW, displayName: "Admin" })).ok, true);
    const login2 = await b.service.dispatch({ type: "identity/login", identifier: ID, password: PW });
    assert.equal(login2.ok, true, "重置后重新初始化 + 登录必须成功：" + JSON.stringify(login2));
    const newOrg = login2.snapshot.teamId;
    assert.notEqual(newOrg, oldOrg, "重新初始化必须产生新的组织 id（否则旧墓碑会压住新组织的首次播种）");
    const trigger2 = await b.resourceService.createResource({ context: { sessionRef: login2.snapshot.sessionRef, appId: "resource-library", source: "ui" }, resourceType: "text", name: "ResetSeed2", content: "y" });
    assert.equal(trigger2.ok, true, JSON.stringify(trigger2));
    const afterPairs = pairList(b.authStore, newOrg);
    assert.deepEqual(afterPairs, beforePairs, "新组织必须拿到与重置前同一套完整播种（旧组织的墓碑不得抑制新组织）");
    const newMcp = snapshotRow(b.authStore, newOrg, "mcp-center", "mcp");
    assert.equal(newMcp.revoked_at, null, "新组织的 mcp 是首次使用，不是旧撤销的复活");
    assert.notEqual(newMcp.organization_id, oldOrg);
    assert.equal(b.store.connection.prepare("SELECT COUNT(*) c FROM users WHERE team_id = ?").get(oldOrg).c, 0, "没有任何用户属于旧组织 → 旧组织的授权行/撤权行对所有授权判定都不可达");
    const view = b.governanceService.getAppAccess({ context: { sessionRef: login2.snapshot.sessionRef, appId: "mcp-center", source: "ui" }, appId: "mcp-center" });
    assert.equal(view.ok, true, JSON.stringify(view));
    assert.equal(view.grants.filter((g) => g.resourceType === "mcp").length, 1, "新组织只看到自己那一行 mcp 授权，看不到旧组织的残留行");
    assert.deepEqual(snapshotRow(b.authStore, oldOrg, "mcp-center", "mcp"), orphan.tombstone, "旧组织的孤儿墓碑保持原样，不被新组织播种改写");
    t.diagnostic("重置后新组织播种 " + afterPairs.length + " 对，与重置前一致；旧组织孤儿行仍为 " + orphan.provisions + " 条（新组织仅见自己的 1 行 mcp 授权）");
  } finally {
    b.store.close();
  }
});

/* ══════════════════════ R6 · 源码级守卫 ══════════════════════ */

const MIN_SOURCE_FILES = 20;
const ANCHOR_FILES = Object.freeze(["identity-store.cjs", "authorization-store.cjs"]);
/** 组织正式删除路径的白名单：目前没有任何一条路径允许删 app_policy_provisions 行。 */
const ALLOWED_ORG_DELETION_PATHS = Object.freeze([]);
const ROW_DELETION = [
  { name: "DELETE FROM", re: /\bDELETE\s+FROM\s+app_policy_provisions\b/i },
  { name: "DROP TABLE", re: /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?app_policy_provisions\b/i },
  { name: "TRUNCATE", re: /\bTRUNCATE\s+(?:TABLE\s+)?app_policy_provisions\b/i },
];
const CLEANUP_STYLE = /\b(VACUUM|prune|purge|cleanup|wipe|drop)\b/i;

function listElectronSources() {
  const files = new Map();
  const walk = (dir, prefix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = prefix ? prefix + "/" + ent.name : ent.name;
      if (ent.isDirectory()) walk(abs, rel);
      else if (ent.isFile()) files.set(rel, fs.readFileSync(abs, "utf8"));
    }
  };
  walk(path.join(ROOT, "electron"), "");
  if (files.size < MIN_SOURCE_FILES) throw new Error("electron 源码枚举异常：只读到 " + files.size + " 个文件（守卫 fail-closed）");
  for (const name of ANCHOR_FILES) if (!files.has(name)) throw new Error("缺少锚点文件 " + name + "（守卫 fail-closed）");
  return files;
}

/** 抽出所有双引号 / 反引号字符串字面量（SQL 只写在这些里），相邻两个字面量拼接后再查一次，覆盖跨行拼接的 DELETE。 */
function sqlLiterals(src) {
  const parts = [];
  const re = /"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(src))) parts.push(m[1] !== undefined ? m[1] : m[2]);
  return parts;
}

function findRowDeletions(rel, src) {
  const literals = sqlLiterals(src);
  const offences = [];
  for (let i = 0; i < literals.length; i++) {
    const windows = [{ text: literals[i], at: i }];
    if (i + 1 < literals.length) windows.push({ text: literals[i] + literals[i + 1], at: i });
    for (const w of windows) {
      for (const pattern of ROW_DELETION) {
        if (pattern.re.test(w.text)) offences.push({ rel, literal: w.at, kind: pattern.name, text: w.text.slice(0, 160) });
      }
      if (new RegExp("app_policy_provisions", "i").test(w.text) && CLEANUP_STYLE.test(w.text)) {
        offences.push({ rel, literal: w.at, kind: "cleanup-style", text: w.text.slice(0, 160) });
      }
    }
  }
  const allowed = offences.filter((o) => ALLOWED_ORG_DELETION_PATHS.some((p) => p.file === o.rel && o.text.includes(p.statement)));
  return { offences, unallowed: offences.filter((o) => !allowed.includes(o)) };
}

test("R6 · 源码级：electron/** 没有任何未登记的 app_policy_provisions 行删除；正式重授只清撤销标记", () => {
  const sources = listElectronSources();
  let mentions = 0;
  for (const [rel, src] of sources) {
    if (sqlLiterals(src).some((lit) => new RegExp("app_policy_provisions", "i").test(lit))) mentions++;
    const { unallowed } = findRowDeletions(rel, src);
    assert.deepEqual(unallowed, [], "发现未登记的政策提供记录行删除（组织删除路径必须登记到 ALLOWED_ORG_DELETION_PATHS）：" + JSON.stringify(unallowed));
  }
  assert.equal(mentions >= 2, true, "表名必须至少出现在 identity-store.cjs / authorization-store.cjs 的 SQL 字面量里（守卫 fail-closed，实际 " + mentions + " 个文件）");
  assert.deepEqual(ALLOWED_ORG_DELETION_PATHS, [], "本批没有任何组织删除路径：一旦登记就必须给出理由与测试");

  const authSrc = sources.get("authorization-store.cjs");
  const clear = /clearPolicyRevoked:\s*"([^"]+)"/.exec(authSrc);
  assert.ok(clear, "必须能定位 clearPolicyRevoked 的 SQL（守卫 fail-closed）");
  const sql = clear[1].replace(/\s+/g, " ").trim();
  const setClause = /^UPDATE\s+app_policy_provisions\s+SET\s+(.*?)\s+WHERE\s+(.*)$/i.exec(sql);
  assert.ok(setClause, "clearPolicyRevoked 必须是 UPDATE app_policy_provisions SET … WHERE …：" + sql);
  const assigned = setClause[1].split(",").map((s) => s.split("=")[0].trim());
  assert.deepEqual(assigned.slice().sort(), ["revoked_at", "revoked_by", "updated_at"], "正式重授只允许清撤销标记：不得改写 provisioned_at / provisioned_by：" + sql);
  assert.equal(/\bDELETE\b/i.test(sql), false, "正式重授不得删行");
  assert.equal(/provisioned_(at|by)\s*=/i.test(sql), false, "正式重授不得改写提供记录字段");
  assert.equal(/\bWHERE\b/i.test(sql), true, "清撤销标记必须带 WHERE（不得全表更新）");
});
