/**
 * D5-03 第二批 · App Grant 的跨组织唯一键 + 内置策略提供记录（表结构 / 形状规则 / 迁移）。
 *
 * 这一层测"数据与约束"本身：
 *   · app_resource_grants 的唯一键含 organization_id（同 App 同 scope 的组织间不再互相覆盖）；
 *   · baseline 形状规则（写墓碑 / 记"已提供"只认它；定向授权撤销不碰它）；
 *   · v20 → v21 迁移：保数据、可重放、按可恢复证据补写记录、无法判定的情形不伪造。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createFixture, tempDbPath } from "./authorization-fixtures.mjs";

const require = createRequire(import.meta.url);
const { IdentityStore, MIGRATIONS, SCHEMA_VERSION, APP_POLICY_KEYS, baselinePolicyKeyOf, policyFamilyOfAppGrant } = require("../electron/identity-store.cjs");
const { AuthorizationStore } = require("../electron/authorization-store.cjs");
const { DatabaseSync } = require("node:sqlite");

const uniqueKeysOf = (db, table) =>
  db
    .prepare(`PRAGMA index_list(${table})`)
    .all()
    .filter((i) => i.unique)
    .map((i) => db.prepare(`PRAGMA index_info(${i.name})`).all().map((c) => c.name));

const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** node:sqlite 返回 null-prototype 行；比较前统一成普通对象。 */
const plain = (rows) => rows.map((r) => ({ ...r }));

const NOW = 1700000000000;

/** 造一个真实的 v20 库：两个组织、两张表上的历史授权、审计里的撤销证据。 */
function seedV20(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  for (const m of MIGRATIONS) {
    if (m.version > 20) continue;
    if (typeof m.run === "function") m.run(db);
    else db.exec(m.sql);
  }
  db.exec("PRAGMA user_version = 20");
  db.prepare("INSERT INTO installations (singleton,id,status,created_at,initialized_at) VALUES (1,?,?,?,?)").run("inst_scope00000000000001", "READY", NOW, NOW);
  const teams = [["team_scope_a000000000001", 1], ["team_scope_b000000000001", 0]];
  for (const [id, root] of teams) db.prepare("INSERT INTO teams (id,name,root,created_at) VALUES (?,?,?,?)").run(id, "T " + id, root, NOW);
  const users = [["usr_scope_admin_a00001", "team_scope_a000000000001", "admin-a@scope.test"], ["usr_scope_admin_b00001", "team_scope_b000000000001", "admin-b@scope.test"]];
  for (const [id, teamId, identifier] of users) {
    db
      .prepare(
        "INSERT INTO users (id,installation_id,team_id,identifier,display_name,role,status,auth_version,password_algo,password_params,password_salt,password_hash,password_version,created_at,updated_at) " +
          "VALUES (?,?,?,?,'Legacy','ADMIN','ACTIVE',1,'scrypt','{}',?,?,1,?,?)",
      )
      .run(id, "inst_scope00000000000001", teamId, identifier, Buffer.from([1, 2, 3]), "deadbeef", NOW, NOW);
  }
  const grants = [
    // baseline 形状（resource 族，org A）
    ["GRANT_RL_BASE_A", "resource-library", "", "", "", "", "", '["resource.view","resource.read"]', "usr_scope_admin_a00001", "team_scope_a000000000001", 100, null],
    // collection 定向（非 baseline）
    ["GRANT_PS_COL_A", "photoshop", "", "col_scope_1", "", "", "", '["resource.read"]', "usr_scope_admin_a00001", "team_scope_a000000000001", 200, null],
    // baseline 形状（mcp 族，org B）
    ["GRANT_MCP_BASE_B", "mcp-center", "", "", "mcp", "", "", '["mcp.view","mcp.use"]', "usr_scope_admin_b00001", "team_scope_b000000000001", 300, null],
    // 资源类型定向（非 baseline）
    ["GRANT_CANVAS_IMG_B", "canvas", "", "", "image", "", "", '["resource.read"]', "usr_scope_admin_b00001", "team_scope_b000000000001", 400, null],
  ];
  const insertGrant = db.prepare("INSERT INTO app_resource_grants (id,app_id,resource_id,collection_id,resource_type,department_id,scope,actions,granted_by,organization_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const g of grants) insertGrant.run(...g);
  const insertAudit = db.prepare("INSERT INTO authorization_audit (at,actor_user_id,target_user_id,app_id,department_id,resource_ref,action,decision,reason_code,permission_source,request_id,old_permissions,new_permissions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  // 可恢复证据：ai 的 model 族被治理撤销过（actor 在 org A）
  insertAudit.run(500, "usr_scope_admin_a00001", null, "ai", null, null, "governance.revokeAppPermission", "ALLOW", "ALLOW", "SUPER_ADMIN", null, '["model.use","model.view"]', "[]");
  // 可恢复证据：browser 的 resource 族被治理撤销过
  insertAudit.run(600, "usr_scope_admin_a00001", null, "browser", null, null, "governance.revokeAppPermission", "ALLOW", "ALLOW", "SUPER_ADMIN", null, '["resource.read","resource.view"]', "[]");
  // 定向行撤销：审计里有 resource_ref，不能当 baseline 证据
  insertAudit.run(700, "usr_scope_admin_a00001", null, "ai", null, "res_scope_targeted", "governance.revokeAppPermission", "ALLOW", "ALLOW", "SUPER_ADMIN", null, '["resource.read"]', "[]");
  // 撤销者查不到 team：无法判定组织，跳过
  insertAudit.run(800, null, null, "canvas", null, null, "governance.revokeAppPermission", "ALLOW", "ALLOW", "SUPER_ADMIN", null, '["mcp.view"]', "[]");
  // 授予行不是撤销证据
  insertAudit.run(900, "usr_scope_admin_a00001", null, "browser", null, null, "governance.grantAppPermission", "ALLOW", "ALLOW", "SUPER_ADMIN", null, "[]", '["resource.read"]');
  db.close();
}

test("V1 · schema 版本与唯一键：organization_id 是 app_resource_grants 唯一键的一部分", async () => {
  const f = await createFixture();
  try {
    assert.equal(SCHEMA_VERSION, 30, "schema 冻结值（当前真实版本 v28）");
    assert.equal(f.identity.schemaVersion, SCHEMA_VERSION);
    const keys = uniqueKeysOf(f.identity.connection, "app_resource_grants");
    assert.ok(keys.some((cols) => cols.includes("organization_id")), "唯一键必须含 organization_id：" + JSON.stringify(keys));
    assert.ok(keys.some((cols) => cols.join(",") === "organization_id,app_id,resource_id,collection_id,resource_type,department_id,scope"), JSON.stringify(keys));
    assert.deepEqual([...APP_POLICY_KEYS], ["resource", "model", "mcp", "tool"]);
    assert.ok(hasTable(f.identity.connection, "app_policy_provisions"));
  } finally { f.close(); }
});

test("V2 · 跨组织不再互相覆盖：同一 (app,type,scope) 两个组织各一行，与写入顺序无关", async () => {
  const f = await createFixture();
  try {
    const A = f.orgId;
    const B = f.foreignTeam;
    // 先写 B 再写 A（反向顺序也是同一结论：键里有组织，不存在"谁后写谁赢"）
    const b = f.store.upsertAppGrant({ appId: "mcp-center", resourceType: "mcp", actions: ["mcp.view", "mcp.use"], grantedBy: "sysB", organizationId: B });
    const a = f.store.upsertAppGrant({ appId: "mcp-center", resourceType: "mcp", actions: ["mcp.view"], grantedBy: "sysA", organizationId: A });
    assert.notEqual(a.grant.id, b.grant.id);
    const rows = f.store.allAppGrants().filter((r) => r.app_id === "mcp-center");
    assert.equal(rows.length, 2, "两个组织必须各留一行");
    const rowA = rows.find((r) => r.organization_id === A);
    const rowB = rows.find((r) => r.organization_id === B);
    // 取数按 (app, organization)：每个组织只看到自己那一行（D5-03 第六批）
    assert.deepEqual(f.store.appGrantsForApp("mcp-center", A).map((r) => r.id), [rowA.id]);
    assert.deepEqual(f.store.appGrantsForApp("mcp-center", B).map((r) => r.id), [rowB.id]);
    assert.deepEqual(f.store.appGrantsForApp("mcp-center", ""), [], "空组织不得退化成不过滤");
    assert.deepEqual(f.store.appGrantsForApp("mcp-center"), [], "缺组织不得退化成不过滤");
    assert.deepEqual(JSON.parse(rowA.actions), ["mcp.view"]);
    assert.deepEqual(JSON.parse(rowB.actions), ["mcp.view", "mcp.use"], "后写的组织不得改写另一个组织的行");
    // 再 upsert A：只改 A 的行
    const a2 = f.store.upsertAppGrant({ appId: "mcp-center", resourceType: "mcp", actions: ["mcp.view", "mcp.test"], grantedBy: "sysA2", organizationId: A });
    assert.equal(a2.grant.id, rowA.id, "同组织同键复用同一行（upsert 语义不变）");
    assert.deepEqual(JSON.parse(f.store.appGrantById(rowB.id).actions), ["mcp.view", "mcp.use"]);
    // 按键查询按组织定位
    assert.equal(f.store.appGrantByKey({ appId: "mcp-center", resourceType: "mcp", organizationId: A }).id, rowA.id);
    assert.equal(f.store.appGrantByKey({ appId: "mcp-center", resourceType: "mcp", organizationId: B }).id, rowB.id);
  } finally { f.close(); }
});

test("V3 · 形状规则：只有 app 级 baseline 形状写墓碑 / 记已提供；定向授权不算", () => {
  const base = { resource_id: "", collection_id: "", resource_type: "", department_id: "", scope: "" };
  assert.equal(baselinePolicyKeyOf(base), "resource");
  assert.equal(baselinePolicyKeyOf({ ...base, resource_type: "model" }), "model");
  assert.equal(baselinePolicyKeyOf({ ...base, resource_type: "mcp" }), "mcp");
  assert.equal(baselinePolicyKeyOf({ ...base, resource_type: "tool", scope: "TOOL" }), "tool");
  assert.equal(baselinePolicyKeyOf({ ...base, resource_type: "memory" }), null, "memory 定向行不是 baseline");
  assert.equal(baselinePolicyKeyOf({ ...base, resource_type: "image" }), null);
  assert.equal(baselinePolicyKeyOf({ ...base, resource_type: "model", scope: "ORGANIZATION" }), null, "同族但非基线字样");
  assert.equal(baselinePolicyKeyOf({ ...base, resource_type: "tool", scope: "" }), null, "tool 只走 TOOL scope");
  assert.equal(baselinePolicyKeyOf({ ...base, resource_id: "res_1" }), null);
  assert.equal(baselinePolicyKeyOf({ ...base, collection_id: "col_1" }), null);
  assert.equal(baselinePolicyKeyOf({ ...base, department_id: "dept_1" }), null);
  // 更宽的"同族"判据只用于清墓碑，不用于写墓碑
  assert.equal(policyFamilyOfAppGrant({ ...base, resource_type: "model", scope: "ORGANIZATION" }), "model");
  assert.equal(policyFamilyOfAppGrant({ ...base, resource_type: "memory" }), null);
  assert.equal(policyFamilyOfAppGrant({ ...base, resource_id: "res_1", resource_type: "model" }), null);
});

test("V4 · 写墓碑 / 清墓碑：正式重授（含非基线字样的同族授权）清标记，定向撤销不写标记", async () => {
  const f = await createFixture();
  try {
    const A = f.orgId;
    const adminId = f.admin.id;
    // ① baseline 形状授予 → 记录"已提供"
    const granted = f.svc.grantAppResourcePermission({ context: f.adminCtx, appId: "canvas", actions: ["resource.view", "resource.read"] });
    assert.equal(granted.ok, true, JSON.stringify(granted));
    const record = f.store.policyProvisionByKey({ organizationId: A, appId: "canvas", policyKey: "resource" });
    assert.equal(record.revoked_at, null);
    assert.equal(record.provisioned_by, adminId);
    // ② 撤销 → 墓碑
    const rev = f.svc.revokeAppResourcePermission({ context: f.adminCtx, grantId: granted.grant.id });
    assert.equal(rev.ok, true);
    assert.equal(typeof f.store.policyProvisionByKey({ organizationId: A, appId: "canvas", policyKey: "resource" }).revoked_at, "number");
    assert.equal(f.store.policyProvisionByKey({ organizationId: A, appId: "canvas", policyKey: "resource" }).revoked_by, adminId);
    // ③ 正式重授（scope=ORGANIZATION，同族但非基线字样）→ 清墓碑，已提供事实保留
    const reg = f.svc.grantAppResourcePermission({ context: f.adminCtx, appId: "canvas", scope: "ORGANIZATION", actions: ["resource.view", "resource.read"] });
    assert.equal(reg.ok, true, JSON.stringify(reg));
    const cleared = f.store.policyProvisionByKey({ organizationId: A, appId: "canvas", policyKey: "resource" });
    assert.equal(cleared.revoked_at, null, "正式重授必须清墓碑");
    assert.equal(cleared.revoked_by, null);
    assert.equal(cleared.provisioned_at, record.provisioned_at, "已提供时刻不变");
    // ④ 定向（具体 resource）授予与撤销都不碰 baseline 记录
    const before = { ...f.store.policyProvisionByKey({ organizationId: A, appId: "canvas", policyKey: "resource" }) };
    const scoped = f.svc.grantAppResourcePermission({ context: f.adminCtx, appId: "canvas", resourceId: f.resources.alpha.resourceId, actions: ["resource.read"] });
    assert.equal(scoped.ok, true, JSON.stringify(scoped));
    f.svc.revokeAppResourcePermission({ context: f.adminCtx, grantId: scoped.grant.id });
    assert.deepEqual({ ...f.store.policyProvisionByKey({ organizationId: A, appId: "canvas", policyKey: "resource" }) }, before, "定向授权撤销不得改动 baseline 记录");
    // ⑤ collection 定向同理
    const col = f.svc.grantAppResourcePermission({ context: f.adminCtx, appId: "photoshop", collectionId: f.collections.design.id, actions: ["resource.read"] });
    assert.equal(col.ok, true, JSON.stringify(col));
    assert.equal(f.store.policyProvisionByKey({ organizationId: A, appId: "photoshop", policyKey: "resource" }), null, "定向授予不得创建 baseline 记录");
    f.svc.revokeAppResourcePermission({ context: f.adminCtx, grantId: col.grant.id });
    assert.equal(f.store.policyProvisionByKey({ organizationId: A, appId: "photoshop", policyKey: "resource" }), null);
    // ⑥ TOOL 族：授予 → 已提供；撤销 → tool 墓碑；重授 → 清墓碑（不牵连 resource/model 族）
    const tool = f.svc.grantAppToolPermission({ context: f.adminCtx, appId: "ai", actions: ["tool.resource.trash"] });
    assert.equal(tool.ok, true, JSON.stringify(tool));
    assert.equal(f.store.policyProvisionByKey({ organizationId: A, appId: "ai", policyKey: "tool" }).revoked_at, null);
    assert.equal(f.store.policyProvisionByKey({ organizationId: A, appId: "ai", policyKey: "resource" }), null);
    f.svc.revokeAppResourcePermission({ context: f.adminCtx, grantId: tool.grant.grantId });
    assert.equal(typeof f.store.policyProvisionByKey({ organizationId: A, appId: "ai", policyKey: "tool" }).revoked_at, "number");
    assert.equal(f.svc.grantAppToolPermission({ context: f.adminCtx, appId: "ai", actions: ["tool.resource.trash"] }).ok, true);
    assert.equal(f.store.policyProvisionByKey({ organizationId: A, appId: "ai", policyKey: "tool" }).revoked_at, null);
  } finally { f.close(); }
});

test("V5 · v20 → v21 迁移：保数据、唯一键换掉、按证据补记录、可重放", async () => {
  const { dir, dbPath } = tempDbPath();
  try {
    seedV20(dbPath);
    const before = (() => { const raw = new DatabaseSync(dbPath); const rows = plain(raw.prepare("SELECT * FROM app_resource_grants ORDER BY id").all()); raw.close(); return rows; })();
    assert.equal(before.length, 4);

    const identity = new IdentityStore({ path: dbPath }).open();
    const store = new AuthorizationStore({ identity });
    assert.equal(identity.schemaVersion, 30);
    const after = plain(store.db.prepare("SELECT * FROM app_resource_grants ORDER BY id").all());
    assert.deepEqual(after, before, "迁移必须逐行保数据（id 与全部字段不变）");
    assert.equal(hasTable(store.db, "app_resource_grants_v21"), false, "重建用的临时表必须收干净");
    const keys = uniqueKeysOf(store.db, "app_resource_grants");
    assert.ok(keys.some((cols) => cols.includes("organization_id")), JSON.stringify(keys));
    assert.equal(store.db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'idx_agrants_app'").get().c, 1, "索引要补回来");

    const rows = plain(store.db.prepare("SELECT * FROM app_policy_provisions ORDER BY organization_id, app_id, policy_key").all());
    const compact = rows.map((r) => [r.organization_id, r.app_id, r.policy_key, r.provisioned_at, r.revoked_at, r.revoked_by]);
    assert.deepEqual(compact, [
      ["team_scope_a000000000001", "ai", "model", null, 500, "usr_scope_admin_a00001"],
      ["team_scope_a000000000001", "browser", "resource", null, 600, "usr_scope_admin_a00001"],
      ["team_scope_a000000000001", "resource-library", "resource", 100, null, null],
      ["team_scope_b000000000001", "mcp-center", "mcp", 300, null, null],
    ], "证据补写：" + JSON.stringify(compact));
    const rl = rows.find((r) => r.app_id === "resource-library");
    assert.equal(rl.provisioned_by, "usr_scope_admin_a00001", "已提供记录要带上当时的授予者");
    assert.equal(rows.some((r) => r.app_id === "photoshop"), false, "collection 定向行不得冒充 baseline");
    assert.equal(rows.some((r) => r.app_id === "canvas"), false, "资源类型定向行不得冒充 baseline");
    identity.close();

    // 重放：把版本降回 20 再走一遍迁移链（回滚式夹具与旧库升级都会走这条路径）
    for (let round = 0; round < 2; round += 1) {
      const raw = new DatabaseSync(dbPath);
      raw.exec("PRAGMA user_version = 20");
      raw.close();
      const replay = new AuthorizationStore({ identity: new IdentityStore({ path: dbPath }).open() });
      assert.equal(replay.identity.schemaVersion, 30);
      assert.deepEqual(plain(replay.db.prepare("SELECT * FROM app_resource_grants ORDER BY id").all()), before, "重放不得丢行或改行");
      assert.equal(replay.db.prepare("SELECT COUNT(*) c FROM app_policy_provisions").get().c, rows.length, "重放不得重复补记录");
      assert.deepEqual(
        plain(replay.db.prepare("SELECT organization_id, app_id, policy_key, provisioned_at, revoked_at, revoked_by FROM app_policy_provisions ORDER BY organization_id, app_id, policy_key").all()),
        rows.map((r) => ({ organization_id: r.organization_id, app_id: r.app_id, policy_key: r.policy_key, provisioned_at: r.provisioned_at, revoked_at: r.revoked_at, revoked_by: r.revoked_by })),
        "重放不得覆盖已有记录",
      );
      replay.identity.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("V6 · 诚实边界：没有可恢复证据的历史撤销不会被伪造记录（宁可不补，也不假装知道）", async () => {
  const { dir, dbPath } = tempDbPath();
  try {
    seedV20(dbPath);
    const store = new AuthorizationStore({ identity: new IdentityStore({ path: dbPath }).open() });
    // canvas 在 org B 有资源类型定向行、在审计里只有一条"查不到撤销者"的撤销行：
    // 迁移不写任何记录 —— 这种情况下一次使用仍会补种（无法判定，写在交付说明里）。
    assert.equal(store.policyProvisionByKey({ organizationId: "team_scope_b000000000001", appId: "canvas", policyKey: "mcp" }), null);
    assert.equal(store.policyProvisionByKey({ organizationId: "team_scope_b000000000001", appId: "canvas", policyKey: "resource" }), null);
    store.identity.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});