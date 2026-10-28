import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createResourceFixture, reopenResourceRuntime, tempRoot } from "./resource-fixtures.mjs";

test("2A · 画布记忆 query/readText 跨账号隔离，重启保留 owner/scope/canvasId", async () => {
  const root = tempRoot("oa-canvas-memory-restart");
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const fixture = await createResourceFixture({ dbPath, storeRoot, keepData: true });
  const alice = fixture.ctx("alice");
  const dana = fixture.ctx("dana");
  const created = await fixture.resourceService.createResource({
    context: alice,
    resourceType: "memory",
    name: "Canvas account memory",
    content: "alice-canvas-secret",
    memorySubtype: "project-memory",
    attributes: { scope: "canvas", canvasId: "canvas-2a" },
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const resourceRef = created.resource.resourceRef;
  const queryA = fixture.resourceService.queryResources({ context: alice, filter: { resourceType: "memory" } });
  const queryB = fixture.resourceService.queryResources({ context: dana, filter: { resourceType: "memory" } });
  assert.equal(queryA.items.some((row) => row.resourceRef === resourceRef), true);
  assert.equal(queryB.items.some((row) => row.resourceRef === resourceRef), false);
  assert.equal((await fixture.resourceService.readText({ context: dana, resourceRef })).ok, false);
  fixture.close();

  let reopened;
  try {
    reopened = reopenResourceRuntime({ dbPath, storeRoot });
    const aliceLogin = await reopened.identity.login({ identifier: "alice@openarc.test", password: "alice-password-1" });
    const danaLogin = await reopened.identity.login({ identifier: "dana@openarc.test", password: "dana-password-1" });
    const context = { sessionRef: aliceLogin.session.ref, appId: "resource-library", source: "ui" };
    const other = { sessionRef: danaLogin.session.ref, appId: "resource-library", source: "ui" };
    const persisted = reopened.resourceService.get({ context, resourceRef });
    assert.equal(persisted.ok, true, JSON.stringify(persisted));
    assert.equal(persisted.resource.ownerUserId, fixture.users.alice);
    assert.equal(persisted.resource.scope, "PERSONAL");
    assert.equal(persisted.resource.memorySubtype, "project-memory");
    assert.deepEqual(persisted.resource.attributes, { scope: "canvas", canvasId: "canvas-2a" });
    assert.equal((await reopened.resourceService.readText({ context, resourceRef })).text, "alice-canvas-secret");
    assert.equal((await reopened.resourceService.readText({ context: other, resourceRef })).ok, false);
    assert.equal(reopened.resourceService.queryResources({ context: other, filter: { resourceType: "memory" } }).items.some((row) => row.resourceRef === resourceRef), false);
  } finally {
    try { reopened && reopened.identity.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
