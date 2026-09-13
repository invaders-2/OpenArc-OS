/** D3-04B · resource-memory.test —— Memory CRUD / subtype / privacy / app boundary / agent。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");
const dana = f.ctx("dana");
const bob = f.ctx("bob"); // foreign org

test("Memory 是正式 Resource：create/read/edit/rename/tag/move/delete/restore", async () => {
  const col = f.resourceService.createCollection({ context: alice, name: "Memories" });
  const mem = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "私人测试记忆", content: "secret content", memorySubtype: "personal-preference", collectionId: col.collection.collectionId, tags: ["private"] });
  assert.equal(mem.ok, true);
  assert.equal(mem.resource.resourceType, "memory");
  const read = await f.resourceService.readText({ context: alice, resourceRef: mem.resource.resourceId });
  assert.equal(read.text, "secret content");
  const edit = await f.resourceService.replaceText({ context: alice, resourceRef: mem.resource.resourceId, text: "secret content v2", expectedVersion: 1 });
  assert.equal(edit.ok, true);
  assert.equal(edit.resource.version, 2);
  f.resourceService.updateMetadata({ context: alice, resourceRef: mem.resource.resourceId, name: "Rename" });
  f.resourceService.setCollection({ context: alice, resourceRef: mem.resource.resourceId, collectionId: null });
  f.resourceService.delete({ context: alice, resourceRef: mem.resource.resourceId });
  assert.equal(f.resourceService.list({ context: alice }).items.some((i) => i.resourceId === mem.resource.resourceId), false);
  f.resourceService.restore({ context: alice, resourceRef: mem.resource.resourceId });
  assert.equal((await f.resourceService.readText({ context: alice, resourceRef: mem.resource.resourceId })).ok, true);
});

test("memory subtype 冻结集合；Resource Type 仍是 memory", async () => {
  const bad = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "Bad", content: "x", memorySubtype: "not-real" });
  assert.equal(bad.ok, false);
  for (const sub of ["personal-preference", "project-memory", "decision-memory", "conversation-memory", "agent-memory"]) {
    const r = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "M " + sub, content: "x", memorySubtype: sub });
    assert.equal(r.ok, true);
    assert.equal(r.resource.resourceType, "memory");
    assert.equal(r.resource.memorySubtype, sub);
  }
});

test("Personal Memory 隐私：同组织 User B / 跨组织 / direct ref 全部不可见", async () => {
  const mem = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "Private A", content: "top secret 私人", memorySubtype: "personal-preference" });
  const ref = mem.resource.resourceId;
  const danaGet = f.resourceService.get({ context: dana, resourceRef: ref });
  assert.equal(danaGet.ok, false);
  const danaRead = await f.resourceService.readText({ context: dana, resourceRef: ref });
  assert.equal(danaRead.ok, false);
  const danaInspector = f.resourceService.getInspector({ context: dana, resourceRef: ref });
  assert.equal(danaInspector.ok, false);
  const danaQuery = f.resourceService.queryResources({ context: dana, category: "memory" });
  assert.equal(danaQuery.items.some((i) => i.resourceId === ref), false);
  const bobQuery = f.resourceService.queryResources({ context: bob, category: "all" });
  assert.equal(bobQuery.total, 0);
  assert.equal(JSON.stringify(danaInspector).includes("top secret"), false);
});

test("Memory app boundary：resource-library 可读，image-generator 不能读 Memory", async () => {
  const mem = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "AppBound", content: "m" });
  const g = f.authService.grantResourcePermission({ context: f.adminCtx(), principalType: "USER", principalId: f.users.dana, resourceId: mem.resource.resourceId, permissionSet: "VIEWER" });
  assert.equal(g.ok, true);
  const viaLibrary = f.resourceService.read({ context: dana, resourceRef: mem.resource.resourceId });
  assert.equal(viaLibrary.ok, true);
  const viaImage = f.resourceService.read({ context: { ...dana, appId: "image-generator" }, resourceRef: mem.resource.resourceId });
  assert.equal(viaImage.ok, false);
});

test("Memory agent boundary：无 useByAgent -> DENY；grant 后 ALLOW", async () => {
  const mem = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "AgentMem", content: "m" });
  f.authService.grantResourcePermission({ context: f.adminCtx(), principalType: "USER", principalId: f.users.dana, resourceId: mem.resource.resourceId, permissionSet: "VIEWER" });
  const denied = f.authService.authorize({ context: { ...dana, appId: "resource-library", agentSessionId: "ags_b" }, action: "resource.read", resource: mem.resource.resourceId });
  assert.equal(denied.decision, "DENY");
  assert.equal(denied.reasonCode, "AGENT_USE_NOT_AUTHORIZED");
  f.authService.grantResourcePermission({ context: f.adminCtx(), principalType: "USER", principalId: f.users.dana, resourceId: mem.resource.resourceId, actions: ["resource.useByAgent"] });
  const allowed = f.authService.authorize({ context: { ...dana, appId: "resource-library", agentSessionId: "ags_b" }, action: "resource.read", resource: mem.resource.resourceId });
  assert.equal(allowed.decision, "ALLOW");
});
