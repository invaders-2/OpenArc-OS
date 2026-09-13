/** D3-04C · resource-index-recovery.test —— 索引中断恢复 / 派生数据可从权威表重建 / 重启持久化。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createResourceFixture, reopenResourceRuntime, tempRoot, pw } from "./resource-fixtures.mjs";

const cleanups = [];
after(() => {
  for (const dir of cleanups) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("中断的索引作业 RUNNING -> QUEUED，中断的文档 INDEXING -> PENDING", async () => {
  const f = await createResourceFixture();
  const ctx = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "RecoverMe", content: "recover-token" });
  await f.searchService.indexResource(r.resource.resourceId);

  const job = f.searchStore.enqueueJob({ resourceId: r.resource.resourceId, resourceVersion: 1, id: "idx_recover_1" });
  assert.equal(job.state, "QUEUED");
  f.searchStore.updateJob("idx_recover_1", "RUNNING");
  assert.equal(f.searchStore.nextJobs(10).some((j) => j.id === "idx_recover_1"), false, "RUNNING 不应再被取用");
  f.searchStore.setDocumentStatus(r.resource.resourceId, "INDEXING");

  const res = f.searchService.recoverStartup();
  assert.equal(res.ok, true);
  const recoveredJob = f.identity.connection.prepare("SELECT state FROM resource_index_jobs WHERE id='idx_recover_1'").get();
  assert.equal(recoveredJob.state, "QUEUED");
  assert.equal(f.searchStore.nextJobs(10).some((j) => j.id === "idx_recover_1"), true);
  const doc = f.searchStore.documentById(r.resource.resourceId);
  assert.equal(doc.index_status, "PENDING");

  // 恢复后的 PENDING 文档在下次 search 时会被重新索引为 READY
  const search = await f.searchService.search({ context: ctx, query: "recover-token", limit: 5 });
  assert.equal(search.total, 1);
  assert.equal(f.searchStore.documentById(r.resource.resourceId).index_status, "READY");
  // recoverStartup 幂等
  assert.equal(f.searchService.recoverStartup().ok, true);
  assert.equal(f.searchStore.documentById(r.resource.resourceId).index_status, "READY", "READY 不应被恢复流程改坏");
  f.close();
});

test("rebuildFromAuthoritative：索引可整体清除，权威 Resource 不受影响并可由 search 重建", async () => {
  const f = await createResourceFixture();
  const ctx = f.ctx("alice");
  const r1 = await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "Rebuild A", content: "rebuild-token one" });
  const r2 = await f.resourceService.createResource({ context: ctx, resourceType: "memory", name: "Rebuild B", content: "rebuild-token two", memorySubtype: "project-memory" });
  await f.searchService.search({ context: ctx, query: "rebuild-token", limit: 10 });
  assert.ok(f.searchStore.countDocuments() >= 2);

  const cleared = f.searchService.rebuildFromAuthoritative({ organizationId: f.orgId });
  assert.equal(cleared.ok, true);
  assert.ok(cleared.cleared >= 2);
  // 权威表仍在
  assert.equal(f.resourceStore.resourceRowById(r1.resource.resourceId) != null, true);
  assert.equal(f.resourceStore.resourceRowById(r2.resource.resourceId) != null, true);
  assert.equal(f.searchStore.documentById(r1.resource.resourceId), null);

  const rebuilt = await f.searchService.search({ context: ctx, query: "rebuild-token", limit: 10 });
  assert.equal(rebuilt.total, 2);
  assert.equal(f.searchStore.documentById(r1.resource.resourceId).index_status, "READY");
  f.close();
});

test("重启持久化：索引与 FTS 落盘，重开后 search 不依赖重建也命中", async () => {
  const root = tempRoot("oa-d3-04c-index-restart");
  cleanups.push(root);
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const f = await createResourceFixture({ dbPath, storeRoot });
  const ctx = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "Persist", content: "persist-token body" });
  await f.searchService.indexResource(r.resource.resourceId);
  const before = await f.searchService.search({ context: ctx, query: "persist-token", limit: 5 });
  assert.equal(before.total, 1);
  f.identity.close();

  const reopened = reopenResourceRuntime({ dbPath, storeRoot });
  const login = await reopened.identity.login({ identifier: "alice@openarc.test", password: pw("alice") });
  const aliceCtx = { sessionRef: login.session.ref, appId: "resource-library" };
  const doc = reopened.searchStore.documentById(r.resource.resourceId);
  assert.ok(doc, "索引文档应随库持久化");
  assert.equal(doc.index_status, "READY");
  const after2 = await reopened.searchService.search({ context: aliceCtx, query: "persist-token", limit: 5 });
  assert.equal(after2.total, 1);
  assert.equal(after2.items[0].resourceId, r.resource.resourceId);
  reopened.identity.close();
});
