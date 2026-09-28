/**
 * D5-03 第六批 · App 授权的组织隔离（取数层 + 判权层 + 双组织行为级证据）。
 *
 * 背景（第五批登记、本批要修的核心漏洞）：
 *   · 取数 `AuthorizationStore.appGrantsForApp(appId)` 只按 app_id 过滤，完全不看 organization_id；
 *   · 判权 `evaluateAppAuthorization` 只比对 grant.app_id + 目标覆盖，没有任何组织判断；
 *   · MCP 路径更明确地把空组织行当通配：`!g.organization_id || g.organization_id === actor.organizationId`。
 *   后果：指向**别的组织**（甚至已被删除的组织）的同形 grant 能让本组织已撤销的权限复活（T5/T5b 实测）。
 *
 * 本文件把修复后的契约立成可执行的证据。同一个库里构造 **A / B 两个真实组织**
 * （node 层允许；真机没有第二个组织入口），逐条对照：
 *
 *   O1 取数契约：按 (app, organization) 取；空/缺失组织退化为**空集**，不是全表；
 *   O2 通用资源域：A 获权/撤权都不改变 B 的结果；
 *   O3 模型域：同上（ModelService 里 app grant 的取数路径）；
 *   O4 MCP 域：同上（原来带 `!g.organization_id` 通配分支的那条路径）；
 *   O5 异组织同形行不能复活 B 已撤销的权限（资源 / 模型 / MCP 三域各一条）；
 *   O6 organization_id = '' 的行不构成通配（三域各一条 + 阳性对照）；
 *   O7 判权层纵深防御：把**全表**直接喂给纯函数，异组织行仍然不放行（不经 store）；
 *   O8 本组织行为不变：A/B 各 15 对播种、唯一键含组织、撤权与正式重授权互不影响；
 *   O9 治理视图逐行不变：视图行集合与字段 == 旧实现（全表 + 按组织过滤）的逐行结果。
 *
 * 产品语义只改"看哪些行"：本组织内的播种 / 撤权 / 正式重授 / scope 与资源覆盖 /
 * User ∩ App ∩ Scope 交集一律不动。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createModelFixture } from "./model-fixtures.mjs";
import { pw } from "./device-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createModelBundle } = require("../electron/model-bootstrap.cjs");
const { createMcpBundle } = require("../electron/mcp-bootstrap.cjs");
const domain = require("../electron/authorization-domain.cjs");

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
test.after(() => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

/** 专门用来验"空组织行不构成通配"的 App：不出现在任何 baseline 清单里。 */
const PROBE_APP = "org-isolation-probe";
const READ_ACTIONS = ["resource.view", "resource.search", "resource.preview", "resource.read"];

/**
 * 同一库里的两个真实组织：
 *   A = 主组织（admin / alice / dana，device-fixtures 的 orgId）
 *   B = foreignOrgId（bob + 一个 B 自己的 ADMIN，用来读 B 的治理投影）
 * 两个组织各自的 resource / model / mcp baseline 都按**产品播种路径**写入（不是手写行）。
 */
async function createDualOrgFixture() {
  const f = await createModelFixture();
  const A = f.orgId;
  const B = f.foreignOrgId;
  const seedDir = tmpDir("oa-d503f-seed-");
  const bundles = {
    model: createModelBundle({ identityStore: f.identity, authorization: f.authService, authStore: f.store, userDataDir: seedDir, safeStorage: null, clock: f.clock }),
    mcp: createMcpBundle({ identityStore: f.identity, authorization: f.authService, authStore: f.store, userDataDir: seedDir, safeStorage: null, clock: f.clock }),
  };
  // A 的 model / mcp baseline 由 bundle 装配时的"首个 ADMIN 的组织"播种；B 必须显式补一次。
  assert.deepEqual(bundles.model.seedModelAppPolicy({ organizationId: B, grantedBy: "test:d503f" }), { ok: true, seeded: true });
  assert.deepEqual(bundles.mcp.seedMcpAppPolicy({ organizationId: B, grantedBy: "test:d503f" }), { ok: true, seeded: true });

  const bAdminRes = await f.identity.createUser({ identifier: "badmin@org-iso.test", password: pw("badmin"), displayName: "B Admin", role: "ADMIN", teamId: B });
  assert.equal(bAdminRes.ok, true, JSON.stringify(bAdminRes));
  const bAdminLogin = await f.identity.login({ identifier: "badmin@org-iso.test", password: pw("badmin") });
  assert.equal(bAdminLogin.ok, true, JSON.stringify(bAdminLogin));
  const sessions = { ...f.sessions, bAdmin: bAdminLogin.session.ref };

  // B 的 resource baseline 走产品首用路径（#ensureBuiltinPolicy 按会话组织播种后再放行写入）。
  const resA = await f.resourceService.createResource({ context: f.ctx("alice"), resourceType: "text", name: "OrgIso A", content: "a" });
  const resB = await f.resourceService.createResource({ context: { sessionRef: sessions.bob, appId: "resource-library", source: "ui" }, resourceType: "text", name: "OrgIso B", content: "b" });
  assert.equal(resA.ok, true, "A 的资源必须建成功：" + JSON.stringify(resA));
  assert.equal(resB.ok, true, "B 的资源必须建成功：" + JSON.stringify(resB));

  const fx = {
    ...f,
    A,
    B,
    bundles,
    mcpService: bundles.mcp.mcpService,
    sessions,
    resA: resA.resource.resourceId,
    resB: resB.resource.resourceId,
    close: async () => { try { await bundles.mcp.mcpService.dispose(); } catch { /* ignore */ } f.close(); },
  };
  seedPersonalModel(fx, "alice");
  seedPersonalModel(fx, "bob");
  return fx;
}

async function withFixture(fn) {
  const fx = await createDualOrgFixture();
  try {
    return await fn(fx);
  } finally {
    await fx.close();
  }
}

/** 每个组织一个 PERSONAL 默认模型：resolveModel 才会走到 App 授权判定，而不是 MODEL_CONFIG_UNAVAILABLE。 */
function seedPersonalModel(fx, key) {
  const context = { sessionRef: fx.sessions[key], appId: "settings", source: "ui" };
  const p = fx.modelService.createProvider({ context, displayName: "OrgIso " + key, baseUrl: "http://127.0.0.1:9", scope: "PERSONAL", credentialSecret: "FAKE_D503F_" + key });
  assert.equal(p.ok, true, JSON.stringify(p));
  const m = fx.modelService.createModel({ context, providerId: p.provider.providerId, remoteModelId: "orgiso-1", capabilities: ["chat"], scope: "PERSONAL" });
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.equal(fx.modelService.setDefault({ context, capability: "chat", configId: m.model.configId, scope: "PERSONAL" }).ok, true);
}

function registerProbeApp(fx) {
  fx.store.upsertApp({ appId: PROBE_APP, name: "组织隔离探针 App", publisher: "test", status: "enabled", builtIn: 0 });
  assert.equal(fx.store.appById(PROBE_APP).status, "enabled");
}

/** 三域各一条端到端判权：判据都是产品同一条调用链。 */
const readDecision = (fx, key, appId, resourceId) =>
  fx.authService.authorize({ context: { sessionRef: fx.sessions[key], appId }, action: "resource.read", resource: { resourceId } }).decision;
const resolveModel = (fx, key, appId) => fx.modelService.resolveModel({ context: { sessionRef: fx.sessions[key], appId }, capability: "chat" });
const listMcp = (fx, key, appId) => fx.mcpService.listConnections({ context: { sessionRef: fx.sessions[key], appId } });

const grantProbe = (fx, organizationId, { resourceType = "", actions }) =>
  fx.store.upsertAppGrant({ appId: PROBE_APP, resourceType, actions, grantedBy: "test:d503f", organizationId });

const probeRows = (fx, organizationId) => fx.store.allAppGrants().filter((g) => g.app_id === PROBE_APP && g.organization_id === organizationId);

/** 旧实现口径：全表按 app_id 取，再在 JS 里按组织过滤（本轮把它换成带组织的 SQL 取数）。 */
const legacyRowsFor = (fx, appId, organizationId) => fx.store.allAppGrants().filter((g) => g.app_id === appId && g.organization_id === organizationId);

const B_CTX = (fx, extra = {}) => ({ sessionRef: fx.sessions.bAdmin, appId: "resource-library", source: "ui", ...extra });

/* ══════════════════════ O1 · 取数契约 ══════════════════════ */

test("O1 · 取数按 (app, organization)：每个组织只看到自己的行；空/缺失组织退化为空集", async () => {
  await withFixture(async (fx) => {
    const canvasA = legacyRowsFor(fx, "canvas", fx.A);
    const canvasB = legacyRowsFor(fx, "canvas", fx.B);
    assert.equal(canvasA.length > 0 && canvasB.length > 0, true, "受控前提：两个组织各自有 canvas 行");

    assert.deepEqual(fx.store.appGrantsForApp("canvas", fx.A).map((g) => g.id).sort(), canvasA.map((g) => g.id).sort(), "A 的取数必须恰好是 A 的行");
    assert.deepEqual(fx.store.appGrantsForApp("canvas", fx.B).map((g) => g.id).sort(), canvasB.map((g) => g.id).sort(), "B 的取数必须恰好是 B 的行");
    assert.deepEqual(fx.store.appGrantsForApp("canvas", fx.A).filter((g) => g.organization_id !== fx.A), [], "A 的取数不得含任何异组织行");
    // 空/缺失组织：不得退化成"只按 app_id"（旧实现在这里会返回两个组织的全部行）。
    assert.deepEqual(fx.store.appGrantsForApp("canvas", ""), [], "空组织必须返回空集");
    assert.deepEqual(fx.store.appGrantsForApp("canvas"), [], "缺组织必须返回空集");
    assert.equal(canvasA.length + canvasB.length > 0, true, "旧实现口径下确实取得到行（对照：不是数据不存在）");
  });
});

/* ══════════════════════ O2 · 通用资源域 ══════════════════════ */

test("O2 · 通用资源域：A 获权/撤权都不改变 B（B 无自己的 grant 时始终 DENY）", async () => {
  await withFixture(async (fx) => {
    // B 的 canvas resource grant 先撤掉：B 变成"没有这个 App 的授权"。
    const canvasResB = fx.store.appGrantsForApp("canvas", fx.B).find((g) => String(g.resource_type) === "");
    assert.ok(canvasResB, "B 的 canvas resource baseline 必须先存在");
    assert.equal(fx.governanceService.revokeAppAccess({ context: B_CTX(fx), grantId: canvasResB.id }).changed, true);

    assert.equal(readDecision(fx, "alice", "canvas", fx.resA), "ALLOW", "A 自己的授权必须放行（本组织行为不变）");
    assert.equal(readDecision(fx, "bob", "canvas", fx.resB), "DENY", "B 没有该 App 的授权 → DENY");

    // A 再正式授予一次（同形，落在 A）：B 的结果不得改变。
    assert.equal(fx.governanceService.grantAppAccess({ context: fx.adminCtx(), appId: "canvas", actions: READ_ACTIONS }).ok, true);
    assert.equal(readDecision(fx, "alice", "canvas", fx.resA), "ALLOW");
    assert.equal(readDecision(fx, "bob", "canvas", fx.resB), "DENY", "A 获权不得让 B 放行");

    // A 撤权：A 立刻 DENY；B 的结果同样不变。
    const canvasResA = fx.store.appGrantsForApp("canvas", fx.A).find((g) => String(g.resource_type) === "");
    assert.equal(fx.governanceService.revokeAppAccess({ context: fx.adminCtx(), grantId: canvasResA.id }).changed, true);
    assert.equal(readDecision(fx, "alice", "canvas", fx.resA), "DENY", "A 撤权必须立刻生效");
    assert.equal(readDecision(fx, "bob", "canvas", fx.resB), "DENY");

    // 反向对照：B 自己授予 → B 放行；A 仍然 DENY。
    assert.equal(fx.governanceService.grantAppAccess({ context: B_CTX(fx), appId: "canvas", actions: READ_ACTIONS }).ok, true, "B 的 Super Admin 必须能给自己组织授予");
    assert.equal(readDecision(fx, "bob", "canvas", fx.resB), "ALLOW", "B 自己的授予必须放行");
    assert.equal(readDecision(fx, "alice", "canvas", fx.resA), "DENY", "B 获权不得让 A 放行");
  });
});

/* ══════════════════════ O3 · 模型域 ══════════════════════ */

test("O3 · 模型域：A/B 各自的 canvas model.use 互不影响（获权与撤权都不越界）", async () => {
  await withFixture(async (fx) => {
    assert.equal(resolveModel(fx, "alice", "canvas").ok, true, "A 的 canvas 必须先能用模型");
    assert.equal(resolveModel(fx, "bob", "canvas").ok, true, "B 的 canvas 必须先能用模型");

    // 撤 B 的 model.use：A 不受影响。
    const modelB = fx.store.appGrantsForApp("canvas", fx.B).find((g) => g.resource_type === "model");
    assert.ok(modelB, "B 的 canvas model baseline 必须先存在");
    assert.equal(fx.governanceService.revokeAppAccess({ context: B_CTX(fx), grantId: modelB.id }).changed, true);
    const deniedB = resolveModel(fx, "bob", "canvas");
    assert.equal(deniedB.ok, false, JSON.stringify(deniedB));
    assert.equal(deniedB.error, "PROXY_UNAUTHORIZED");
    assert.equal(resolveModel(fx, "alice", "canvas").ok, true, "B 撤权不得影响 A");

    // 撤 A 的 model.use：A 变 DENY；B（已撤）不变。
    const modelA = fx.store.appGrantsForApp("canvas", fx.A).find((g) => g.resource_type === "model");
    assert.equal(fx.governanceService.revokeAppAccess({ context: fx.adminCtx(), grantId: modelA.id }).changed, true);
    const deniedA = resolveModel(fx, "alice", "canvas");
    assert.equal(deniedA.ok, false, JSON.stringify(deniedA));
    assert.equal(deniedA.error, "PROXY_UNAUTHORIZED");
    assert.equal(resolveModel(fx, "bob", "canvas").ok, false);

    // 正式重授 A：A 恢复、B 仍然 DENY。
    assert.equal(fx.governanceService.grantAppAccess({ context: fx.adminCtx(), appId: "canvas", resourceType: "model", actions: ["model.view", "model.use"] }).ok, true);
    assert.equal(resolveModel(fx, "alice", "canvas").ok, true, "A 正式重授后必须恢复");
    assert.equal(resolveModel(fx, "bob", "canvas").ok, false, "A 重授不得让 B 恢复");
  });
});

/* ══════════════════════ O4 · MCP 域 ══════════════════════ */

test("O4 · MCP 域：A 的 mcp-center 授权不改变 B；B 撤权不影响 A（原通配分支已删）", async () => {
  await withFixture(async (fx) => {
    assert.equal(listMcp(fx, "admin", "mcp-center").ok, true, "A 的 mcp baseline 必须先可用");
    assert.equal(listMcp(fx, "bob", "mcp-center").ok, true, "B 的 mcp baseline 必须先可用");

    const mcpB = fx.store.appGrantsForApp("mcp-center", fx.B).find((g) => g.resource_type === "mcp");
    assert.ok(mcpB, "B 的 mcp baseline 必须先存在");
    assert.equal(fx.governanceService.revokeAppAccess({ context: B_CTX(fx), grantId: mcpB.id }).changed, true);
    const deniedB = listMcp(fx, "bob", "mcp-center");
    assert.equal(deniedB.ok, false, JSON.stringify(deniedB));
    assert.equal(deniedB.error, "MCP_UNAUTHORIZED");
    assert.equal(deniedB.reason, "app-action-missing");
    assert.equal(listMcp(fx, "admin", "mcp-center").ok, true, "B 撤权不得影响 A");

    // A 正式重授（同形，落在 A）：B 仍被拒。
    assert.equal(fx.governanceService.grantAppAccess({ context: fx.adminCtx(), appId: "mcp-center", resourceType: "mcp", actions: ["mcp.view", "mcp.use", "mcp.manage", "mcp.test"] }).ok, true);
    assert.equal(listMcp(fx, "admin", "mcp-center").ok, true);
    assert.equal(listMcp(fx, "bob", "mcp-center").ok, false, "A 获权不得让 B 放行");

    // A 撤权：A DENY、B 仍 DENY（互不干扰）。
    const mcpA = fx.store.appGrantsForApp("mcp-center", fx.A).find((g) => g.resource_type === "mcp");
    assert.equal(fx.governanceService.revokeAppAccess({ context: fx.adminCtx(), grantId: mcpA.id }).changed, true);
    assert.equal(listMcp(fx, "admin", "mcp-center").ok, false);
    assert.equal(listMcp(fx, "bob", "mcp-center").ok, false);
  });
});

/* ══════════════════════ O5 · 异组织同形行不能复活 ══════════════════════ */

test("O5 · 异组织同形行不能使 B 已撤销的权限复活（资源 / 模型 / MCP 三域）", async () => {
  await withFixture(async (fx) => {
    const rowOf = (org, appId, resourceType) => fx.store.appGrantsForApp(appId, org).find((g) => String(g.resource_type) === resourceType);
    const domains = [["canvas", ""], ["canvas", "model"], ["mcp-center", "mcp"]];

    // B 走产品路径撤销三域授权；A 的**同形** baseline 行原样留在库里。
    for (const [appId, resourceType] of domains) {
      const rowB = rowOf(fx.B, appId, resourceType);
      assert.ok(rowB, appId + "/" + resourceType + " 的 B 行必须先存在");
      assert.equal(fx.governanceService.revokeAppAccess({ context: B_CTX(fx), grantId: rowB.id }).changed, true);
      assert.equal(fx.store.appGrantById(rowB.id), null, "撤销必须是真删");
    }
    for (const [appId, resourceType] of domains) {
      assert.ok(rowOf(fx.A, appId, resourceType), "A 的同形行必须仍在库里（这就是「异组织旧授权行」）");
    }

    // B 三域全部 DENY —— 不受 A 同形行影响。
    assert.equal(readDecision(fx, "bob", "canvas", fx.resB), "DENY", "B 撤销后资源读取必须 DENY");
    const modelB = resolveModel(fx, "bob", "canvas");
    assert.equal(modelB.ok, false, JSON.stringify(modelB));
    assert.equal(modelB.error, "PROXY_UNAUTHORIZED", "B 撤销后模型使用必须 DENY");
    const mcpB = listMcp(fx, "bob", "mcp-center");
    assert.equal(mcpB.ok, false, JSON.stringify(mcpB));
    assert.equal(mcpB.error, "MCP_UNAUTHORIZED", "B 撤销后 MCP 必须 DENY");

    // A 自己的行仍然生效（证明 A 的行确实是"有效授权行"，不是废数据）。
    assert.equal(readDecision(fx, "alice", "canvas", fx.resA), "ALLOW");
    assert.equal(resolveModel(fx, "alice", "canvas").ok, true);
    assert.equal(listMcp(fx, "admin", "mcp-center").ok, true);
  });
});

/* ══════════════════════ O6 · 空组织行不构成通配 ══════════════════════ */

test("O6 · organization_id = '' 的行不构成通配：三域都不得放行任何真实组织", async () => {
  await withFixture(async (fx) => {
    registerProbeApp(fx);
    grantProbe(fx, "", { resourceType: "", actions: READ_ACTIONS });
    grantProbe(fx, "", { resourceType: "model", actions: ["model.view", "model.use"] });
    grantProbe(fx, "", { resourceType: "mcp", actions: ["mcp.view", "mcp.use"] });
    assert.deepEqual(probeRows(fx, "").map((g) => g.resource_type).sort(), ["", "mcp", "model"], "受控前提：空组织三行已写入");
    assert.deepEqual(fx.store.appGrantsForApp(PROBE_APP, fx.A), [], "空组织行不得出现在任何真实组织的取数里");

    // 通用资源
    assert.equal(readDecision(fx, "alice", PROBE_APP, fx.resA), "DENY", "空组织行不得授权 A 的资源读取");
    assert.equal(readDecision(fx, "bob", PROBE_APP, fx.resB), "DENY", "空组织行不得授权 B 的资源读取");
    // 模型
    const modelA = resolveModel(fx, "alice", PROBE_APP);
    assert.equal(modelA.ok, false, JSON.stringify(modelA));
    assert.equal(modelA.error, "PROXY_UNAUTHORIZED", "空组织行不得授权模型使用");
    assert.equal(resolveModel(fx, "bob", PROBE_APP).error, "PROXY_UNAUTHORIZED");
    // MCP（原实现的 !g.organization_id 通配分支就在这里放行）
    const mcpA = listMcp(fx, "alice", PROBE_APP);
    assert.equal(mcpA.ok, false, JSON.stringify(mcpA));
    assert.equal(mcpA.error, "MCP_UNAUTHORIZED", "空组织行不得授权 MCP 视图");
    assert.equal(mcpA.reason, "app-action-missing");
    assert.equal(listMcp(fx, "bob", PROBE_APP).error, "MCP_UNAUTHORIZED");

    // 阳性对照：同样的形状落在真实组织 A → A 三域放行，B 仍 DENY（空组织行保持无效）。
    grantProbe(fx, fx.A, { resourceType: "", actions: READ_ACTIONS });
    grantProbe(fx, fx.A, { resourceType: "model", actions: ["model.view", "model.use"] });
    grantProbe(fx, fx.A, { resourceType: "mcp", actions: ["mcp.view", "mcp.use"] });
    assert.equal(readDecision(fx, "alice", PROBE_APP, fx.resA), "ALLOW", "同形行落在 A 必须放行（证明形状有效）");
    assert.equal(resolveModel(fx, "alice", PROBE_APP).ok, true, "同形 model 行落在 A 必须放行");
    assert.equal(listMcp(fx, "alice", PROBE_APP).ok, true, "同形 mcp 行落在 A 必须放行");
    assert.equal(readDecision(fx, "bob", PROBE_APP, fx.resB), "DENY", "落在 A 的行不得授权 B");
    assert.equal(resolveModel(fx, "bob", PROBE_APP).error, "PROXY_UNAUTHORIZED");
    assert.equal(listMcp(fx, "bob", PROBE_APP).error, "MCP_UNAUTHORIZED");
  });
});

/* ══════════════════════ O7 · 判权层纵深防御（纯函数，不经 store） ══════════════════════ */

test("O7 · 判权层纵深防御：把全表喂进纯函数，异组织行与空组织行都不放行", async () => {
  await withFixture(async (fx) => {
    registerProbeApp(fx);
    grantProbe(fx, fx.A, { resourceType: "", actions: READ_ACTIONS });
    grantProbe(fx, fx.B, { resourceType: "", actions: READ_ACTIONS });
    grantProbe(fx, "", { resourceType: "", actions: READ_ACTIONS });

    const resource = fx.store.resourceById(fx.resA);
    const user = fx.identity.userById(fx.users.alice);
    const memberships = fx.store.membershipsOfUser(user.id);
    const app = fx.store.appById(PROBE_APP);
    // 取数层被绕过的最坏情况：把**整张表**（含 A / B / 空组织三行）直接喂进来。
    const fullTable = fx.store.allAppGrants().filter((g) => g.app_id === PROBE_APP);
    assert.equal(fullTable.length, 3, "受控前提：全表三行");
    assert.equal(fullTable.filter((g) => g.organization_id === fx.A).length, 1);

    // 只认当前组织那一行。
    assert.deepEqual([...domain.evaluateAppAuthorization({ resource, app, grants: fullTable, organizationId: fx.A }).actions].sort(), [...READ_ACTIONS].sort(), "组织 A 只应拿到 A 那一行的动作");
    assert.deepEqual([...domain.evaluateAppAuthorization({ resource, app, grants: fullTable, organizationId: fx.B }).actions].sort(), [...READ_ACTIONS].sort(), "组织 B 只应拿到 B 那一行的动作");
    assert.deepEqual([...domain.evaluateAppAuthorization({ resource, app, grants: fullTable, organizationId: "" }).actions], [], "空组织：一行都不放行");
    assert.deepEqual([...domain.evaluateAppAuthorization({ resource, app, grants: fullTable, organizationId: undefined }).actions], [], "缺组织：一行都不放行");
    assert.deepEqual([...domain.evaluateAppAuthorization({ resource, app, grants: fullTable, organizationId: null }).actions], [], "null 组织：一行都不放行");

    // 关键：把 A 那一行从全表里删掉（模拟"本组织没有 grant，但全表被喂进来"）→ 即使 B / 空组织行都在，A 也不能放行。
    const withoutA = fullTable.filter((g) => g.organization_id !== fx.A);
    const bypassed = domain.evaluatePolicy({ resource, user, memberships, grants: [], app, appGrants: withoutA, organizationId: fx.A, action: "resource.read" });
    assert.equal(bypassed.decision, "DENY", JSON.stringify(bypassed));
    assert.equal(bypassed.reasonCode, "APP_ACTION_NOT_GRANTED");
    assert.equal(bypassed.allowSources.includes("APP_GRANT"), false, JSON.stringify(bypassed.allowSources));

    // 正向：A 那一行在 → evaluatePolicy 真的 ALLOW，且来源是 APP_GRANT。
    const allowed = domain.evaluatePolicy({ resource, user, memberships, grants: [], app, appGrants: fullTable, organizationId: fx.A, action: "resource.read" });
    assert.equal(allowed.decision, "ALLOW", JSON.stringify(allowed));
    assert.equal(allowed.allowSources.includes("APP_GRANT"), true, JSON.stringify(allowed.allowSources));

    // 空组织行单独存在时也不能放行（组织参数为空的情况）。
    const onlyEmpty = fullTable.filter((g) => !g.organization_id);
    const emptyOrg = domain.evaluatePolicy({ resource, user, memberships, grants: [], app, appGrants: onlyEmpty, organizationId: "", action: "resource.read" });
    assert.equal(emptyOrg.decision, "DENY", JSON.stringify(emptyOrg));
  });
});

/* ══════════════════════ O8 · 本组织行为不变 ══════════════════════ */

test("O8 · 本组织行为不变：A/B 各 15 对播种、唯一键含组织、撤权与正式重授权互不影响", async () => {
  await withFixture(async (fx) => {
    const pairs = (org) => fx.store.allPolicyProvisions().filter((r) => r.organization_id === org).map((r) => r.app_id + "|" + r.policy_key).sort();
    assert.equal(pairs(fx.A).length, 15, "A 必须播满 15 对：" + JSON.stringify(pairs(fx.A)));
    assert.equal(pairs(fx.B).length, 15, "B 必须播满 15 对：" + JSON.stringify(pairs(fx.B)));
    assert.deepEqual(pairs(fx.A), pairs(fx.B), "两个组织的播种清单必须一致");

    // 唯一键含 organization_id：同 (app, resource_type, scope) 在两个组织各一行，upsert 只改自己那一行。
    const rowA = fx.store.appGrantByKey({ appId: "canvas", resourceType: "model", organizationId: fx.A });
    const rowB = fx.store.appGrantByKey({ appId: "canvas", resourceType: "model", organizationId: fx.B });
    assert.notEqual(rowA.id, rowB.id, "两个组织必须是两行");
    assert.deepEqual(JSON.parse(rowB.actions).sort(), ["model.use", "model.view"]);
    const updatedA = fx.store.upsertAppGrant({ appId: "canvas", resourceType: "model", actions: ["model.view"], grantedBy: "test:d503f", organizationId: fx.A });
    assert.equal(updatedA.grant.id, rowA.id, "同组织同键必须复用同一行（upsert 语义不变）");
    assert.deepEqual(JSON.parse(fx.store.appGrantById(rowB.id).actions).sort(), ["model.use", "model.view"], "改 A 不得动 B 那一行");

    // A 撤权 → A DENY + 墓碑；B 全程不受影响。
    assert.equal(fx.governanceService.revokeAppAccess({ context: fx.adminCtx(), grantId: rowA.id }).changed, true);
    assert.equal(typeof fx.store.policyProvisionByKey({ organizationId: fx.A, appId: "canvas", policyKey: "model" }).revoked_at, "number", "撤销必须写墓碑");
    assert.equal(fx.store.policyProvisionByKey({ organizationId: fx.B, appId: "canvas", policyKey: "model" }).revoked_at, null, "B 的提供记录不得被 A 的撤销改动");
    assert.equal(resolveModel(fx, "alice", "canvas").error, "PROXY_UNAUTHORIZED");
    assert.equal(resolveModel(fx, "bob", "canvas").ok, true, "B 仍有自己的 model.use → 不受 A 撤销影响");

    // 正式重授（同族同形，落在 A）→ 清墓碑、恢复；B 全程不变。
    assert.equal(fx.governanceService.grantAppAccess({ context: fx.adminCtx(), appId: "canvas", resourceType: "model", actions: ["model.view", "model.use"] }).ok, true);
    assert.equal(fx.store.policyProvisionByKey({ organizationId: fx.A, appId: "canvas", policyKey: "model" }).revoked_at, null, "正式重授必须清墓碑");
    assert.equal(resolveModel(fx, "alice", "canvas").ok, true);
    assert.equal(resolveModel(fx, "bob", "canvas").ok, true);
    // 行数与播种清单不变（没有多播、没有漏播）。
    assert.equal(pairs(fx.A).length, 15);
    assert.equal(pairs(fx.B).length, 15);
    assert.equal(fx.store.allAppGrants().filter((g) => g.app_id === "canvas" && g.organization_id === fx.B).length, 2, "B 的 canvas 行数不得被 A 的操作改动");
  });
});

/* ══════════════════════ O9 · 治理视图逐行不变 ══════════════════════ */

test("O9 · 治理视图逐行不变：行集合与字段 == 旧实现（全表 + 按组织过滤）", async () => {
  await withFixture(async (fx) => {
    const ctxA = fx.adminCtx();
    const ctxB = B_CTX(fx);
    // 只属于 B 的一行：用来暴露"视图串组织"。
    fx.store.upsertAppGrant({ appId: "photoshop", collectionId: "col_only_b", actions: ["resource.read"], grantedBy: "test:d503f", organizationId: fx.B });
    // A 的 TOOL 授权（TOOL 视图是单独投影）。
    assert.equal(fx.governanceService.grantAppToolAccess({ context: ctxA, appId: "ai", actions: ["tool.resource.trash"] }).ok, true);

    for (const [context, org, label] of [[ctxA, fx.A, "A"], [ctxB, fx.B, "B"]]) {
      for (const appId of ["canvas", "ai", "photoshop", "mcp-center", "resource-library"]) {
        const raw = legacyRowsFor(fx, appId, org);
        const view = fx.governanceService.getAppAccess({ context, appId });
        assert.equal(view.ok, true, label + " getAppAccess " + appId + "：" + JSON.stringify(view));
        assert.deepEqual(view.grants.map((g) => g.grantId).sort(), raw.map((g) => g.id).sort(), label + " " + appId + " 授权列表必须逐行等于旧实现");
        // 逐字段：视图里每一条的投影字段都必须来自它自己那一行。
        const byId = new Map(raw.map((g) => [g.id, g]));
        for (const g of view.grants) {
          const row = byId.get(g.grantId);
          assert.ok(row, label + " 视图出现不属于该组织的 grantId：" + g.grantId);
          assert.equal(g.resourceId, row.resource_id || null);
          assert.equal(g.collectionId, row.collection_id || null);
          assert.equal(g.resourceType, row.resource_type || null);
          assert.equal(g.departmentId, row.department_id || null);
          assert.equal(g.scope, row.scope || null);
          assert.equal(g.expiresAt, row.expires_at || null);
        }
        const tool = fx.governanceService.getAppToolAccess({ context, appId });
        assert.equal(tool.ok, true, label + " getAppToolAccess " + appId);
        assert.deepEqual(tool.grants.map((g) => g.grantId).sort(), raw.filter((g) => String(g.scope) === "TOOL").map((g) => g.id).sort(), label + " " + appId + " TOOL 视图必须逐行等于旧实现");
      }
      const apps = fx.governanceService.listApps({ context });
      assert.equal(apps.ok, true, label + " listApps：" + JSON.stringify(apps));
      for (const item of apps.items) {
        const raw = legacyRowsFor(fx, item.appId, org);
        assert.equal(item.grantCount, raw.length, label + " " + item.appId + " grantCount 必须与旧实现一致");
        assert.equal(item.memoryAccess, raw.some((g) => g.resource_type === "memory"), label + " " + item.appId + " memoryAccess 必须与旧实现一致");
      }
    }

    // B 的独占行只出现在 B 的视图里；TOOL 授权同理。
    assert.equal(fx.governanceService.getAppAccess({ context: ctxA, appId: "photoshop" }).grants.some((g) => g.collectionId === "col_only_b"), false, "A 的视图不得出现 B 的独占行");
    assert.equal(fx.governanceService.getAppAccess({ context: ctxB, appId: "photoshop" }).grants.some((g) => g.collectionId === "col_only_b"), true, "B 的视图必须看到自己的行");
    assert.deepEqual(fx.governanceService.getAppToolAccess({ context: ctxA, appId: "ai" }).grantedActions, ["tool.resource.trash"], "A 的 TOOL 投影");
    assert.deepEqual(fx.governanceService.getAppToolAccess({ context: ctxB, appId: "ai" }).grantedActions, [], "B 不得看到 A 的 TOOL 授权");
  });
});
