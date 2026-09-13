/**
 * D3-04A · resource-linked.test —— LINKED Resource / source state / Device 交集。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createResourceFixture } from "./resource-fixtures.mjs";
import { pairDevice } from "./device-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const ctx = f.ctx("alice");

test("valid linked source：AVAILABLE + 读取原文件内容", async () => {
  const src = f.writeSource("linked.txt", "linked content");
  const link = f.resourceService.createLinked({ context: ctx, sourcePath: src, name: "Linked" });
  assert.equal(link.ok, true);
  assert.equal(link.resource.storageMode, "LINKED");
  assert.equal(link.resource.availability, "AVAILABLE");
  const read = await f.resourceService.readText({ context: ctx, resourceRef: link.resource.resourceRef });
  assert.equal(read.ok, true);
  assert.equal(read.text, "linked content");
});

test("source removed -> SOURCE_MISSING，不伪装 AVAILABLE", async () => {
  const src = f.writeSource("missing.txt", "will disappear");
  const link = f.resourceService.createLinked({ context: ctx, sourcePath: src, name: "Missing" });
  fs.rmSync(src);
  const got = f.resourceService.get({ context: ctx, resourceRef: link.resource.resourceRef });
  assert.equal(got.resource.availability, "SOURCE_MISSING");
  const read = await f.resourceService.readText({ context: ctx, resourceRef: link.resource.resourceRef });
  assert.equal(read.ok, false);
  assert.equal(read.error, "SOURCE_MISSING");
});

test("source modified -> SOURCE_CHANGED", async () => {
  const src = f.writeSource("changed.txt", "original");
  const link = f.resourceService.createLinked({ context: ctx, sourcePath: src, name: "Changed" });
  fs.writeFileSync(src, "original plus more bytes");
  const got = f.resourceService.get({ context: ctx, resourceRef: link.resource.resourceRef });
  assert.equal(got.resource.availability, "SOURCE_CHANGED");
  const read = await f.resourceService.readText({ context: ctx, resourceRef: link.resource.resourceRef });
  assert.equal(read.error, "SOURCE_CHANGED");
});

test("LINKED symlink 第一版拒绝", async () => {
  const real = f.writeSource("real.txt", "real target");
  const linkPath = path.join(f.sourceDir, "sym.txt");
  fs.symlinkSync(real, linkPath);
  const res = f.resourceService.createLinked({ context: ctx, sourcePath: linkPath, name: "Sym" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "LINKED_SYMLINK_REJECTED");
});

test("Device Offline -> metadata 可显示，content 不可读", async () => {
  const device = await pairDevice(f, { displayName: "Remote GPU" });
  f.deviceStore.setConnectivity(device.device.deviceId, "OFFLINE");
  const src = f.writeSource("remote.txt", "remote content");
  const link = f.resourceService.createLinked({ context: ctx, sourcePath: src, name: "Remote", storageDeviceId: device.device.deviceId });
  assert.equal(link.ok, true);
  const got = f.resourceService.get({ context: ctx, resourceRef: link.resource.resourceRef });
  assert.equal(got.resource.availability, "DEVICE_OFFLINE");
  const read = await f.resourceService.readText({ context: ctx, resourceRef: link.resource.resourceRef });
  assert.equal(read.ok, false);
  assert.equal(read.error, "DEVICE_OFFLINE");
});

test("Device Revoked -> LINKED 不得继续读取", async () => {
  const device = await pairDevice(f, { displayName: "Revoked GPU" });
  const src = f.writeSource("revoked.txt", "revoked content");
  const link = f.resourceService.createLinked({ context: ctx, sourcePath: src, name: "Revoked", storageDeviceId: device.device.deviceId });
  const rev = f.deviceService.revokeDevice({ context: f.adminCtx(), deviceId: device.device.deviceId });
  assert.equal(rev.ok, true);
  const got = f.resourceService.get({ context: ctx, resourceRef: link.resource.resourceRef });
  assert.equal(got.resource.availability, "DEVICE_REVOKED");
  const read = await f.resourceService.readText({ context: ctx, resourceRef: link.resource.resourceRef });
  assert.equal(read.error, "DEVICE_REVOKED");
});
