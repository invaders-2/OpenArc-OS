/** D3-05 · Data Gate：User×App / Agent / Search / Preview / Picker / Resource lifecycle。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture, searchDomain } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();
const alice = f.ctx("alice");
const dana = f.ctx("dana");

test("Gate-App: User × App 交集（ALLOW/DENY 组合）覆盖 search/read/export", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Intersection", content: "intersection token" });
  const rid = r.resource.resourceId;
  const canvasAlice = { sessionRef: f.sessions.alice, appId: "canvas" };
  // User ALLOW + App DENY
  for (const g of f.store.appGrantsForApp("canvas")) f.governanceService.revokeAppAccess({ context: admin, grantId: g.id });
  assert.equal(f.authService.authorize({ context: canvasAlice, action: "resource.read", resource: rid }).decision, "DENY");
  // App ALLOW + User DENY（dana 无 user grant）
  f.governanceService.grantAppAccess({ context: admin, appId: "canvas", resourceId: rid, actions: ["resource.read", "resource.view", "resource.search", "resource.export"] });
  const canvasDana = { sessionRef: f.sessions.dana, appId: "canvas" };
  assert.equal(f.authService.authorize({ context: canvasDana, action: "resource.read", resource: rid }).decision, "DENY");
  // User ALLOW + App ALLOW
  f.authService.grantResourcePermission({ context: alice, principalType: "USER", principalId: f.users.dana, resourceId: rid, permissionSet: "VIEWER" });
  assert.equal(f.authService.authorize({ context: canvasDana, action: "resource.read", resource: rid }).decision, "ALLOW");
});

test("Gate-Agent: 无 useByAgent → Agent DENY；授予 → ALLOW；撤销 → 下一请求 DENY", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "AgentRes", content: "agent token" });
  const rid = r.resource.resourceId;
  f.governanceService.grantAppAccess({ context: admin, appId: "ai", resourceId: rid, actions: ["resource.read", "resource.view", "resource.search", "resource.useByAgent"] });
  const noAgent = f.authService.grantResourcePermission({ context: alice, principalType: "USER", principalId: f.users.dana, resourceId: rid, actions: ["resource.read", "resource.view", "resource.search"] });
  assert.equal(noAgent.ok, true);
  const agent = { sessionRef: f.sessions.dana, appId: "ai", agentSessionId: "gate-agent" };
  assert.equal(f.authService.authorize({ context: agent, action: "resource.read", resource: rid }).decision, "DENY");
  const g = f.authService.grantResourcePermission({ context: alice, principalType: "USER", principalId: f.users.dana, resourceId: rid, actions: ["resource.read", "resource.view", "resource.search", "resource.useByAgent"] });
  assert.equal(g.ok, true);
  assert.equal(f.authService.authorize({ context: agent, action: "resource.read", resource: rid }).decision, "ALLOW");
  for (const grant of f.store.grantsForResource(rid)) f.authService.revokeResourcePermission({ context: alice, grantId: grant.id });
  assert.equal(f.authService.authorize({ context: agent, action: "resource.read", resource: rid }).decision, "DENY");
});

test("Gate-Search: 零泄漏 + 撤销后无需 reindex 立即消失", async () => {
  const secret = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "GATE_SECRET_NAME", content: "GATE_SECRET_BODY", memorySubtype: "project-memory" });
  await f.resourceService.assignTag({ context: alice, resourceRef: secret.resource.resourceId, name: "GATE_SECRET_TAG" });
  for (const q of ["GATE_SECRET_NAME", "GATE_SECRET_BODY", "GATE_SECRET_TAG"]) {
    const res = await f.searchService.search({ context: dana, query: q, limit: 10 });
    assert.equal(res.total, 0);
    assert.equal(JSON.stringify({ ...res, query: undefined }).includes("GATE_SECRET"), false, q);
  }
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "RevokeSearch", content: "revoke search token" });
  const g = f.authService.grantResourcePermission({ context: alice, principalType: "USER", principalId: f.users.dana, resourceId: r.resource.resourceId, permissionSet: "VIEWER" });
  assert.equal((await f.searchService.search({ context: dana, query: "revoke search", limit: 5 })).total, 1);
  f.authService.revokeResourcePermission({ context: alice, grantId: g.grant.id });
  assert.equal((await f.searchService.search({ context: dana, query: "revoke search", limit: 5 })).total, 0);
});

const PNG = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 6)]);
async function imgResource(name, ctx = alice) {
  const p = f.writeSource(name + ".png", PNG());
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: p, name: name + ".png", mimeType: "image/png" });
  return imp.resource.resourceId;
}

test("Gate-Preview: capability 未过期，但 revoke / disable App 后协议请求 DENY", async () => {
  const rid = await imgResource("PrevRevoke");
  const g = f.authService.grantResourcePermission({ context: alice, principalType: "USER", principalId: f.users.dana, resourceId: rid, permissionSet: "VIEWER" });
  const pv = await f.previewService.preview({ context: dana, resourceRef: rid });
  assert.equal(pv.ok, true);
  assert.equal((await f.previewService.handleProtocolRequest(new Request(pv.url))).status, 200);
  f.authService.revokeResourcePermission({ context: alice, grantId: g.grant.id });
  assert.notEqual((await f.previewService.handleProtocolRequest(new Request(pv.url))).status, 200);
  const rid2 = await imgResource("PrevApp");
  f.governanceService.grantAppAccess({ context: admin, appId: "canvas", resourceId: rid2, actions: ["resource.read", "resource.view", "resource.preview"] });
  const canvasDana = { sessionRef: f.sessions.dana, appId: "canvas" };
  f.authService.grantResourcePermission({ context: alice, principalType: "USER", principalId: f.users.dana, resourceId: rid2, permissionSet: "VIEWER" });
  const pv2 = await f.previewService.preview({ context: canvasDana, resourceRef: rid2 });
  assert.equal(pv2.ok, true);
  f.governanceService.setAppStatus({ context: admin, appId: "canvas", status: "disabled" });
  assert.notEqual((await f.previewService.handleProtocolRequest(new Request(pv2.url))).status, 200);
  f.governanceService.setAppStatus({ context: admin, appId: "canvas", status: "enabled" });
});

test("Gate-Lifecycle: import→search→preview→v2→restore→trash→restore→permanent delete，ref 稳定", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Lifecycle", content: "life v1" });
  const ref = r.resource.resourceRef;
  const rid = r.resource.resourceId;
  assert.equal((await f.searchService.search({ context: alice, query: "life v1", limit: 5 })).total, 1);
  assert.equal((await f.previewService.preview({ context: alice, resourceRef: rid })).ok, true);
  await f.resourceService.replaceText({ context: alice, resourceRef: rid, text: "life v2", expectedVersion: 1 });
  assert.equal((await f.searchService.search({ context: alice, query: "life v2", limit: 5 })).total, 1);
  assert.equal((await f.searchService.search({ context: alice, query: "life v1", limit: 5 })).total, 0);
  f.resourceService.restoreVersion({ context: alice, resourceRef: rid, version: 1 });
  assert.equal((await f.searchService.search({ context: alice, query: "life v1", limit: 5 })).total, 1);
  // ref 稳定（rename / tag / collection / version / trash / restore）
  f.resourceService.updateMetadata({ context: alice, resourceRef: rid, name: "LifecycleRenamed" });
  await f.resourceService.assignTag({ context: alice, resourceRef: rid, name: "lifetag" });
  const col = f.resourceService.createCollection({ context: alice, name: "LifeCol" });
  f.resourceService.setCollection({ context: alice, resourceRef: rid, collectionId: col.collection.collectionId });
  assert.equal(f.resourceService.get({ context: alice, resourceRef: rid }).resource.resourceRef, ref);
  f.resourceService.delete({ context: alice, resourceRef: rid });
  assert.equal((await f.searchService.search({ context: alice, query: "life v1", limit: 5 })).total, 0);
  assert.equal((await f.previewService.preview({ context: alice, resourceRef: rid })).ok, false);
  f.resourceService.restore({ context: alice, resourceRef: rid });
  assert.equal(f.resourceService.get({ context: alice, resourceRef: rid }).resource.resourceRef, ref);
  f.resourceService.permanentDelete({ context: alice, resourceRef: rid });
  await f.searchService.search({ context: alice, query: "life v1", limit: 5 });
  assert.equal(f.searchStore.documentById(rid), null);
  assert.equal(f.store.grantsForResource(rid).length, 0, "永久删除后不得留下幽灵 grant");
});

test("Gate-VersionConflict: 两个客户端基于 v1，第二个保存必须 VERSION_CONFLICT", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Conflict", content: "base" });
  const rid = r.resource.resourceId;
  const a = await f.resourceService.replaceText({ context: alice, resourceRef: rid, text: "A v2", expectedVersion: 1 });
  const b = await f.resourceService.replaceText({ context: alice, resourceRef: rid, text: "B overwrite", expectedVersion: 1 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.error, "VERSION_CONFLICT");
  assert.equal((await f.searchService.search({ context: alice, query: "A v2", limit: 5 })).total, 1);
});

test("Gate-Grants: Trash 时 grant 仍在但 read/preview DENY；Restore 后按当前 grant 重算", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "TrashGrant", content: "trash grant" });
  const rid = r.resource.resourceId;
  const g = f.authService.grantResourcePermission({ context: alice, principalType: "USER", principalId: f.users.dana, resourceId: rid, permissionSet: "VIEWER" });
  assert.equal(g.ok, true);
  assert.equal(f.authService.authorize({ context: dana, action: "resource.read", resource: rid }).decision, "ALLOW");
  f.resourceService.delete({ context: alice, resourceRef: rid });
  assert.equal(f.authService.authorize({ context: dana, action: "resource.read", resource: rid }).decision, "DENY");
  assert.equal((await f.previewService.preview({ context: dana, resourceRef: rid })).ok, false);
  f.resourceService.restore({ context: alice, resourceRef: rid });
  assert.equal(f.authService.authorize({ context: dana, action: "resource.read", resource: rid }).decision, "ALLOW");
});
