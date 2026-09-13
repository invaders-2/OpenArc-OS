/**
 * D3-02 · authorization-race.test
 * Grant Race / DB 约束 / 事务（§50）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createFixture, tempDbPath } from "./authorization-fixtures.mjs";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { AuthorizationStore } = require("../electron/authorization-store.cjs");
const domain = require("../electron/authorization-domain.cjs");

const { dir, dbPath } = tempDbPath();
const f = await createFixture({ dbPath });
// 第二个**独立连接**：真实模拟两个进程同时写同一个库。
const second = new IdentityStore({ path: dbPath }).open();
const store2 = new AuthorizationStore({ identity: second });

after(() => {
  try {
    second.close();
  } catch {
    /* ignore */
  }
  f.close();
  try {
    require("node:fs").rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("两连接并发 grant 同 principal/resource → 只有一行，动作并集", async () => {
  const rid = f.resources.alpha.resourceId;
  const base = { principalType: "USER", principalId: f.created.erin, resourceId: rid, organizationId: f.orgId };
  await Promise.all([
    f.identity.transact(() => f.store.upsertResourceGrant({ ...base, actions: ["resource.read"] })),
    second.transact(() => store2.upsertResourceGrant({ ...base, actions: ["resource.download"] })),
  ]);
  const rows = f.store.grantsForResource(rid).filter((g) => g.principal_type === "USER" && g.principal_id === f.created.erin);
  assert.equal(rows.length, 1);
  const actions = domain.grantActions(rows[0]);
  assert.ok(actions.includes("resource.read"));
  assert.ok(actions.includes("resource.download"));
});

test("数据库 UNIQUE 约束真实存在：裸重复 INSERT 被拒绝", () => {
  const rid = f.resources.orgDoc.resourceId;
  f.store.upsertResourceGrant({ principalType: "USER", principalId: f.created.bob, resourceId: rid, actions: ["resource.read"], organizationId: f.orgId });
  let threw = false;
  try {
    f.identity.connection
      .prepare(
        "INSERT INTO resource_grants (id, principal_type, principal_id, resource_id, collection_id, resource_type, department_id, scope, actions, organization_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(domain.newId("GRANT"), "USER", f.created.bob, rid, "", "", "", "", "[]", f.orgId, 0, 0);
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
});

test("并发 revoke 同一 grant：一个 changed，另一个 NO_CHANGE，不抛异常", async () => {
  const g = f.store.upsertResourceGrant({ principalType: "USER", principalId: f.created.charlie, resourceId: f.resources.alpha.resourceId, actions: ["resource.read"], organizationId: f.orgId });
  const results = await Promise.all([
    f.identity.transact(() => f.store.revokeResourceGrant(g.grant.id)),
    second.transact(() => store2.revokeResourceGrant(g.grant.id)),
  ]);
  assert.equal(results.filter((r) => r.changed).length, 1);
  assert.equal(results.filter((r) => !r.changed).length, 1);
});
