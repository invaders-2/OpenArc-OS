/**
 * D3-04A · resource-version.test —— Version / Optimistic / Restore。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const ctx = f.ctx("alice");

test("v1 import -> v2 replace -> v3 replace -> restore v1 得到 v4", async () => {
  const p1 = f.writeSource("v1.txt", "content v1");
  const p2 = f.writeSource("v2.txt", "content v2");
  const p3 = f.writeSource("v3.txt", "content v3");
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: p1, name: "Versioned" });
  const ref = imp.resource.resourceRef;
  assert.equal(imp.resource.version, 1);

  const r2 = await f.resourceService.replaceContent({ context: ctx, resourceRef: ref, sourcePath: p2, expectedVersion: 1 });
  assert.equal(r2.ok, true);
  assert.equal(r2.resource.version, 2);

  const r3 = await f.resourceService.replaceContent({ context: ctx, resourceRef: ref, sourcePath: p3, expectedVersion: 2 });
  assert.equal(r3.ok, true);
  assert.equal(r3.resource.version, 3);

  const restore = f.resourceService.restoreVersion({ context: ctx, resourceRef: ref, version: 1 });
  assert.equal(restore.ok, true);
  assert.equal(restore.resource.version, 4);
  const read = await f.resourceService.readText({ context: ctx, resourceRef: ref });
  assert.equal(read.text, "content v1");

  const versions = f.resourceStore.versionsOf(imp.resource.resourceId);
  assert.deepEqual(versions.map((v) => v.version), [1, 2, 3, 4]);
});

test("stale expectedVersion -> VERSION_CONFLICT，不静默覆盖", async () => {
  const p1 = f.writeSource("c1.txt", "conflict v1");
  const p2 = f.writeSource("c2.txt", "conflict v2");
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: p1, name: "Conflict" });
  await f.resourceService.replaceContent({ context: ctx, resourceRef: imp.resource.resourceRef, sourcePath: p2, expectedVersion: 1 });
  const stale = await f.resourceService.replaceContent({ context: ctx, resourceRef: imp.resource.resourceRef, sourcePath: p1, expectedVersion: 1 });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "VERSION_CONFLICT");
  const read = await f.resourceService.readText({ context: ctx, resourceRef: imp.resource.resourceRef });
  assert.equal(read.text, "conflict v2");
});

test("restoreVersion 保留旧 Version（不删历史）且版本号单调", async () => {
  const p1 = f.writeSource("m1.txt", "mono v1");
  const p2 = f.writeSource("m2.txt", "mono v2");
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: p1, name: "Mono" });
  await f.resourceService.replaceContent({ context: ctx, resourceRef: imp.resource.resourceRef, sourcePath: p2, expectedVersion: 1 });
  const restore = f.resourceService.restoreVersion({ context: ctx, resourceRef: imp.resource.resourceRef, version: 2 });
  assert.equal(restore.resource.version, 3);
  const versions = f.resourceStore.versionsOf(imp.resource.resourceId).map((v) => v.version);
  assert.deepEqual(versions, [1, 2, 3]);
});

test("read 指定历史 version", async () => {
  const p1 = f.writeSource("h1.txt", "history v1");
  const p2 = f.writeSource("h2.txt", "history v2");
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: p1, name: "History" });
  await f.resourceService.replaceContent({ context: ctx, resourceRef: imp.resource.resourceRef, sourcePath: p2, expectedVersion: 1 });
  const read = await f.resourceService.readText({ context: ctx, resourceRef: imp.resource.resourceRef });
  assert.equal(read.text, "history v2");
  const res = f.resourceService.read({ context: ctx, resourceRef: imp.resource.resourceRef, version: 1 });
  assert.equal(res.ok, true);
  let text = "";
  for await (const c of res.stream) text += c.toString("utf8");
  assert.equal(text, "history v1");
});
