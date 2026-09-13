/** D3-04A 探针 02 · LINKED Resource / source state / Resource × Device。 */
import fs from "node:fs";
import path from "node:path";
import { Probe, createResourceFixture, pairDevice } from "./lib.mjs";

const p = new Probe("02-linked-device", "LINKED / source state / Device Offline / Revoked");
const f = await createResourceFixture();
const ctx = f.ctx("alice");
try {
  const src = f.writeSource("linked.txt", "linked content");
  const link = f.resourceService.createLinked({ context: ctx, sourcePath: src, name: "Linked" });
  p.assert("valid linked -> AVAILABLE", link.ok && link.resource.storageMode === "LINKED" && link.resource.availability === "AVAILABLE", link.error || "ok");
  const read = await f.resourceService.readText({ context: ctx, resourceRef: link.resource.resourceRef });
  p.assert("linked read 真实内容", read.ok && read.text === "linked content", read.error || "ok");

  fs.rmSync(src);
  const missing = f.resourceService.get({ context: ctx, resourceRef: link.resource.resourceRef });
  p.assert("source removed -> SOURCE_MISSING（不伪装 AVAILABLE）", missing.resource.availability === "SOURCE_MISSING", missing.resource.availability);

  const src2 = f.writeSource("changed.txt", "original");
  const link2 = f.resourceService.createLinked({ context: ctx, sourcePath: src2, name: "Changed" });
  fs.writeFileSync(src2, "original plus more");
  const changed = f.resourceService.get({ context: ctx, resourceRef: link2.resource.resourceRef });
  p.assert("source modified -> SOURCE_CHANGED", changed.resource.availability === "SOURCE_CHANGED", changed.resource.availability);

  const real = f.writeSource("sym-real.txt", "real");
  const sym = path.join(f.sourceDir, "link-sym.txt");
  fs.symlinkSync(real, sym);
  const symRes = f.resourceService.createLinked({ context: ctx, sourcePath: sym, name: "Sym" });
  p.assert("LINKED symlink 第一版拒绝", !symRes.ok && symRes.error === "LINKED_SYMLINK_REJECTED", symRes.error);

  const dev = await pairDevice(f, { displayName: "Offline GPU" });
  f.deviceStore.setConnectivity(dev.device.deviceId, "OFFLINE");
  const remote = f.resourceService.createLinked({ context: ctx, sourcePath: real, name: "Remote", storageDeviceId: dev.device.deviceId });
  const remoteGot = f.resourceService.get({ context: ctx, resourceRef: remote.resource.resourceRef });
  p.assert("Device Offline -> DEVICE_OFFLINE", remoteGot.resource.availability === "DEVICE_OFFLINE", remoteGot.resource.availability);
  const remoteRead = await f.resourceService.readText({ context: ctx, resourceRef: remote.resource.resourceRef });
  p.assert("Device Offline -> content 不可读", !remoteRead.ok && remoteRead.error === "DEVICE_OFFLINE", remoteRead.error);

  const dev2 = await pairDevice(f, { displayName: "Revoked GPU" });
  const revoked = f.resourceService.createLinked({ context: ctx, sourcePath: real, name: "Revoked", storageDeviceId: dev2.device.deviceId });
  const rev = f.deviceService.revokeDevice({ context: f.adminCtx(), deviceId: dev2.device.deviceId });
  const revGot = f.resourceService.get({ context: ctx, resourceRef: revoked.resource.resourceRef });
  p.assert("Device Revoked -> DEVICE_REVOKED 且不可读", rev.ok && revGot.resource.availability === "DEVICE_REVOKED" && !(await f.resourceService.readText({ context: ctx, resourceRef: revoked.resource.resourceRef })).ok, revGot.resource.availability);
} finally {
  f.close();
}
p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
