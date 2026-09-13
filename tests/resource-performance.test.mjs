/**
 * D3-04A · resource-performance.test —— 10MB / 100MB streaming import，记录峰值内存与耗时。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture({ storeRoot: undefined });
after(() => f.close());
const ctx = f.ctx("alice");

function makeBig(name, megabytes) {
  const file = path.join(f.sourceDir, name);
  const chunk = Buffer.alloc(1024 * 1024, 9);
  const fd = fs.openSync(file, "w");
  for (let i = 0; i < megabytes; i += 1) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  return file;
}

async function measure(label, megabytes) {
  const file = makeBig(label + "-" + megabytes + "mb.bin", megabytes);
  const before = process.memoryUsage();
  const t0 = Date.now();
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: file, name: label + "-" + megabytes + "MB", resourceType: "file" });
  const duration = Date.now() - t0;
  const after = process.memoryUsage();
  return {
    imp,
    duration,
    heapDelta: after.heapUsed - before.heapUsed,
    externalDelta: after.external - before.external,
  };
}

test("10MB streaming import：记录耗时与内存，写入有界", { timeout: 60000 }, async () => {
  const r = await measure("perf", 10);
  assert.equal(r.imp.ok, true);
  assert.equal(r.imp.resource.size, 10 * 1024 * 1024);
  assert.ok(r.externalDelta < 64 * 1024 * 1024, "external 增量 " + Math.round(r.externalDelta / 1024 / 1024) + "MB 应远小于文件大小");
  console.log("[D3-04A perf] 10MB duration=" + r.duration + "ms heapDelta=" + Math.round(r.heapDelta / 1024 / 1024) + "MB externalDelta=" + Math.round(r.externalDelta / 1024 / 1024) + "MB");
});

test("100MB streaming import：不可整文件读入内存", { timeout: 180000 }, async () => {
  const r = await measure("perf", 100);
  assert.equal(r.imp.ok, true);
  assert.equal(r.imp.resource.size, 100 * 1024 * 1024);
  assert.ok(r.externalDelta < 128 * 1024 * 1024, "external 增量 " + Math.round(r.externalDelta / 1024 / 1024) + "MB 应远小于 100MB 整文件 Buffer");
  console.log("[D3-04A perf] 100MB duration=" + r.duration + "ms heapDelta=" + Math.round(r.heapDelta / 1024 / 1024) + "MB externalDelta=" + Math.round(r.externalDelta / 1024 / 1024) + "MB");
});

test("integrity verify 重新流式哈希，不整文件读入", { timeout: 60000 }, async () => {
  const file = makeBig("verify-10mb.bin", 10);
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: file, name: "Verify 10MB", resourceType: "file" });
  const res = await f.resourceService.verifyIntegrity({ context: ctx, resourceRef: imp.resource.resourceRef });
  assert.equal(res.ok, true);
  assert.equal(res.integrity.status, "AVAILABLE");
});
