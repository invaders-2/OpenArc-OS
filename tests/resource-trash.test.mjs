/**
 * D3-04A · resource-trash.test —— Trash / Restore / Permanent Delete / GC safety。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const ctx = f.ctx("alice");

test("delete -> Trash：normal query 不含、direct get 报 trashed、read 被拒", async () => {
  const src = f.writeSource("trash.txt", "trash me");
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: src, name: "Trash Me" });
  const ref = imp.resource.resourceRef;
  const del = f.resourceService.delete({ context: ctx, resourceRef: ref });
  assert.equal(del.ok, true);

  const list = f.resourceService.list({ context: ctx });
  assert.equal(list.items.some((i) => i.resourceId === imp.resource.resourceId), false);
  // D3-02 授权层查询同样不含（registry.status = deleted）
  const authzList = f.authService.listAuthorizedResources({ context: ctx });
  assert.equal(authzList.items.some((i) => i.resourceId === imp.resource.resourceId), false);

  const got = f.resourceService.get({ context: ctx, resourceRef: ref });
  assert.equal(got.ok, true);
  assert.equal(got.resource.trashed, true);
  assert.equal(got.resource.availability, "TRASHED");

  const read = await f.resourceService.readText({ context: ctx, resourceRef: ref });
  assert.equal(read.ok, false);
  assert.equal(read.error, "RESOURCE_TRASHED");
});

test("restore：同一个 ResourceRef 重新可用", async () => {
  const src = f.writeSource("restore.txt", "restore me");
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: src, name: "Restore Me" });
  const ref = imp.resource.resourceRef;
  f.resourceService.delete({ context: ctx, resourceRef: ref });
  const res = f.resourceService.restore({ context: ctx, resourceRef: ref });
  assert.equal(res.ok, true);
  assert.equal(res.resource.resourceRef, ref);
  assert.equal(res.resource.trashed, false);
  const read = await f.resourceService.readText({ context: ctx, resourceRef: ref });
  assert.equal(read.text, "restore me");
});

test("permanentDelete：Resource 消失，content GC 安全", async () => {
  const content = "shared content payload";
  const a = f.writeSource("shared-a.txt", content);
  const b = f.writeSource("shared-b.txt", content);
  const r1 = await f.resourceService.importManaged({ context: ctx, sourcePath: a, name: "Shared A" });
  const r2 = await f.resourceService.importManaged({ context: ctx, sourcePath: b, name: "Shared B" });
  const contentId = f.resourceStore.libraryResourceById(r1.resource.resourceId).content_object_id;
  assert.equal(contentId, f.resourceStore.libraryResourceById(r2.resource.resourceId).content_object_id);
  const objPath = f.managedStore.objectPath(r1.resource.checksum);
  assert.ok(fs.existsSync(objPath));

  const pd1 = f.resourceService.permanentDelete({ context: ctx, resourceRef: r1.resource.resourceRef });
  assert.equal(pd1.ok, true);
  assert.equal(pd1.contentGc.refs, 1);
  assert.equal(pd1.contentGc.removed, false);
  assert.equal(f.resourceStore.contentObjectById(contentId).status, "OBJECT_READY");
  assert.ok(fs.existsSync(objPath), "shared content object 不能被误删");

  const pd2 = f.resourceService.permanentDelete({ context: ctx, resourceRef: r2.resource.resourceRef });
  assert.equal(pd2.ok, true);
  assert.equal(pd2.contentGc.refs, 0);
  assert.equal(pd2.contentGc.removed, true);
  assert.equal(f.resourceStore.contentObjectById(contentId).status, "DELETED");
  assert.equal(fs.existsSync(objPath), false);

  const gone = f.resourceService.get({ context: ctx, resourceRef: r1.resource.resourceRef });
  assert.equal(gone.ok, false);
});

test("permanentDelete 清理 grants", async () => {
  const src = f.writeSource("grant-cleanup.txt", "grant cleanup");
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: src, name: "Grant Cleanup" });
  const rid = imp.resource.resourceId;
  const g = f.authService.grantResourcePermission({ context: f.adminCtx(), principalType: "USER", principalId: f.users.dana, resourceId: rid, permissionSet: "VIEWER" });
  assert.equal(g.ok, true);
  assert.ok(f.store.grantsForResource(rid).length >= 1);
  f.resourceService.permanentDelete({ context: ctx, resourceRef: imp.resource.resourceRef });
  assert.equal(f.store.grantsForResource(rid).length, 0);
});
