/**
 * D3-04A · resource-recovery.test —— Import State Machine / Crash Recovery / Orphan GC。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createResourceFixture, resourceDomain } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const ctx = f.ctx("alice");

test("staging 目录中无 job 的临时文件被清理（不删除 objects）", () => {
  const stagingDir = path.join(f.storeRoot, "staging");
  const orphan = path.join(stagingDir, "orphan.part");
  fs.writeFileSync(orphan, "orphan");
  const keep = path.join(f.storeRoot, "objects", "user-unknown-file");
  fs.writeFileSync(keep, "not ours");
  const res = f.resourceService.recoverStartup();
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(orphan), false);
  assert.ok(res.report.stagingOrphans.includes("orphan.part"));
  // **不删除所有未知文件**：objects 下的未知文件不在 DB 中，不被自动删除
  assert.equal(fs.existsSync(keep), true);
  fs.rmSync(keep, { force: true });
});

test("未完成 job：无 resource -> ORPHANED，staging 被清理", () => {
  const job = f.resourceStore.transactSync(() => f.resourceStore.createImportJob({ organizationId: f.orgId, storageMode: "MANAGED", bytesTotal: 10 }));
  const staging = f.managedStore.stagingPath(job.id);
  fs.writeFileSync(staging, "partial");
  const res = f.resourceService.recoverStartup();
  assert.equal(res.ok, true);
  assert.equal(f.resourceStore.importJobById(job.id).phase, "ORPHANED");
  assert.equal(fs.existsSync(staging), false);
});

test("object metadata mismatch 可检测", () => {
  const checksum = "ab".repeat(32);
  f.resourceStore.transactSync(() => f.resourceStore.insertContentObject({ checksum, size: 123, internalKey: resourceDomain.contentInternalKey(checksum), organizationId: f.orgId }));
  const res = f.resourceService.recoverStartup();
  assert.ok(res.report.objectMismatches.some((m) => m.reason === "OBJECT_MISSING"));
});

test("已提交但 job 未标记 AVAILABLE -> recovery 标记 AVAILABLE", async () => {
  const src = f.writeSource("half.txt", "half committed");
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: src, name: "Half" });
  assert.equal(imp.ok, true);
  // 人为把 job 退回 COMMITTING，模拟"commit 成功但状态未更新"
  f.resourceStore.transactSync(() => f.resourceStore.updateImportJob(imp.jobId, { phase: "COMMITTING" }));
  const res = f.resourceService.recoverStartup();
  assert.equal(res.ok, true);
  assert.equal(f.resourceStore.importJobById(imp.jobId).phase, "AVAILABLE");
});
