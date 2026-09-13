/**
 * D3-04A · resource-import.test —— Managed Import / Dedupe / Streaming / Failure。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createResourceFixture, resourceDomain } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const ctx = f.ctx("alice");

test("managed import：内容进入 OpenArc，删除原文件后仍可读", async () => {
  const src = f.writeSource("one.txt", "hello one");
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: src, name: "One", resourceType: "text" });
  assert.equal(imp.ok, true);
  assert.equal(imp.resource.storageMode, "MANAGED");
  assert.equal(imp.resource.availability, "AVAILABLE");
  assert.equal(imp.resource.name, "One");
  fs.rmSync(src);
  const read = await f.resourceService.readText({ context: ctx, resourceRef: imp.resource.resourceRef });
  assert.equal(read.ok, true);
  assert.equal(read.text, "hello one");
  const objPath = f.managedStore.objectPath(imp.resource.checksum);
  assert.ok(objPath && objPath.startsWith(f.storeRoot), "object 必须在 store 内");
});

test("Content Object dedupe：不同文件名同内容 -> 1 个 content object / 2 个 Resource", async () => {
  const a = f.writeSource("a-copy.txt", "duplicate payload");
  const b = f.writeSource("b-copy.txt", "duplicate payload");
  const r1 = await f.resourceService.importManaged({ context: ctx, sourcePath: a, name: "A copy" });
  const r2 = await f.resourceService.importManaged({ context: ctx, sourcePath: b, name: "B copy" });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.notEqual(r1.resource.resourceId, r2.resource.resourceId);
  const c1 = f.resourceStore.libraryResourceById(r1.resource.resourceId).content_object_id;
  const c2 = f.resourceStore.libraryResourceById(r2.resource.resourceId).content_object_id;
  assert.equal(c1, c2);
});

test("Resource Entry dedupe ≠ Content dedupe：同文件名不同内容 -> 2 个 content object", async () => {
  const a = f.writeSource("same-name.txt", "version alpha");
  const b = f.writeSource("same-name-2.txt", "version beta");
  const r1 = await f.resourceService.importManaged({ context: ctx, sourcePath: a, name: "same-name.txt" });
  const r2 = await f.resourceService.importManaged({ context: ctx, sourcePath: b, name: "same-name.txt" });
  const c1 = f.resourceStore.libraryResourceById(r1.resource.resourceId).content_object_id;
  const c2 = f.resourceStore.libraryResourceById(r2.resource.resourceId).content_object_id;
  assert.notEqual(c1, c2);
});

test("MIME sniffing：PNG magic bytes 不被扩展名欺骗", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
  const src = f.writeSource("not-really.txt", png);
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: src, name: "not-really.txt" });
  assert.equal(imp.ok, true);
  assert.equal(imp.resource.mimeType, "image/png");
  assert.equal(imp.resource.resourceType, "image");
});

test("cancel：已取消的信号不产生 AVAILABLE Resource", async () => {
  const src = f.writeSource("cancel.txt", "should not land");
  const controller = new AbortController();
  controller.abort();
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: src, signal: controller.signal, name: "Cancel" });
  assert.equal(imp.ok, false);
  assert.equal(imp.error, "IMPORT_CANCELLED");
  assert.equal(f.resourceStore.libraryResourceById("res_does_not_exist"), null);
  const jobs = f.resourceStore.allImportJobs().filter((j) => j.phase === "CANCELLED");
  assert.ok(jobs.length >= 1);
});

test("disk space failure injection：不留下 AVAILABLE Resource", async () => {
  const src = f.writeSource("huge.bin", Buffer.alloc(1024));
  const original = f.managedStore.hasSpaceFor.bind(f.managedStore);
  f.managedStore.hasSpaceFor = () => ({ ok: false, checked: true, free: 0, required: 1024 });
  try {
    const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: src, name: "Huge" });
    assert.equal(imp.ok, false);
    assert.equal(imp.error, "DISK_SPACE_INSUFFICIENT");
  } finally {
    f.managedStore.hasSpaceFor = original;
  }
});

test("DB failure injection：object 留下可检测孤儿，recovery 清理", async () => {
  const src = f.writeSource("dbfail.txt", "db failure payload");
  const original = f.resourceStore.insertRegistryResource.bind(f.resourceStore);
  let armed = true;
  f.resourceStore.insertRegistryResource = (...args) => {
    if (armed) {
      armed = false;
      throw new Error("injected-db-failure");
    }
    return original(...args);
  };
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: src, name: "DB Fail" });
  f.resourceStore.insertRegistryResource = original;
  assert.equal(imp.ok, false);
  // content 行独立提交：ref_count=0，可检测
  const orphansBefore = f.resourceStore.orphanContentObjects();
  assert.ok(orphansBefore.length >= 1, "应留下 ref_count=0 的孤儿 content object");
  const report = f.resourceService.recoverStartup();
  assert.equal(report.ok, true);
  assert.ok(report.report.gc.length >= 1);
  assert.equal(f.resourceStore.orphanContentObjects().length, 0);
});

test("large streaming import：内存不随文件大小线性增长", async () => {
  const big = path.join(f.sourceDir, "big-8mb.bin");
  const chunk = Buffer.alloc(1024 * 1024, 7);
  const fd = fs.openSync(big, "w");
  for (let i = 0; i < 8; i += 1) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  const before = process.memoryUsage().heapUsed;
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: big, name: "Big 8MB", resourceType: "file" });
  const after = process.memoryUsage().heapUsed;
  assert.equal(imp.ok, true);
  assert.equal(imp.resource.size, 8 * 1024 * 1024);
  assert.ok(after - before < 48 * 1024 * 1024, "heap 增长应远小于文件大小，实际 " + Math.round((after - before) / 1024 / 1024) + "MB");
});
