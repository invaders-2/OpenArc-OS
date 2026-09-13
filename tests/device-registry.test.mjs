/**
 * D3-03 · device-registry.test
 * Registry 字段完整性、状态机、rename 不换身份、metadata 不能当身份（§4 §5 §6 §44）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceFixture, pairDevice, deviceDomain } from "./device-fixtures.mjs";

const { DEVICE_STATUS, CONNECTIVITY } = deviceDomain;

test("配对成功后设备进入 Registry：字段齐全、状态 ACTIVE、凭据版本 1", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx, { displayName: "Design GPU 1", platform: "darwin", architecture: "arm64" });
  const devices = fx.deviceService.listDevices({ context: fx.adminCtx() });
  assert.equal(devices.ok, true);
  assert.equal(devices.items.length, 1);
  const d = devices.items[0];
  assert.equal(d.deviceId, paired.device.deviceId);
  assert.equal(d.displayName, "Design GPU 1");
  assert.equal(d.platform, "darwin");
  assert.equal(d.architecture, "arm64");
  assert.equal(d.status, DEVICE_STATUS.ACTIVE);
  assert.equal(d.credentialVersion, 1);
  assert.equal(d.organizationId, fx.orgId);
  assert.ok(d.registeredAt != null);
  assert.equal(d.certificateIdentity, paired.fingerprint);
  for (const field of ["deviceId", "displayName", "platform", "status", "lastSeenAt"]) {
    assert.ok(field in d, "缺少 Renderer 可见字段 " + field);
  }
  assert.ok(!("privateKey" in d) && !("secret" in d));
});

test("deviceId 与 D3-02 的 ID 工具同构，且不来自 hostname/IP/MAC", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx, { displayName: "WS", platform: "darwin", architecture: "arm64", identityExtra: { hostname: "design-gpu-01", ip: "10.0.0.7" } });
  assert.match(paired.device.deviceId, deviceDomain.DEVICE_ID_PATTERN);
  const d = fx.deviceStore.deviceById(paired.device.deviceId);
  assert.ok(!String(d.certificate_identity).includes("design-gpu-01"));
  assert.ok(!String(d.certificate_identity).includes("10.0.0.7"));
  const meta = deviceDomain.sanitizeMetadata({ hostname: "design-gpu-01", ip: "10.0.0.7", platform: "darwin" });
  assert.deepEqual(Object.keys(meta), ["platform"]);
});

test("状态机：ACTIVE→DISABLED→ACTIVE→REVOKED；REVOKED 无出边", async () => {
  const fx = await createDeviceFixture();
  const { device } = await pairDevice(fx);
  const id = device.deviceId;
  assert.equal(fx.deviceService.disableDevice({ context: fx.adminCtx(), deviceId: id }).ok, true);
  assert.equal(fx.deviceStore.deviceById(id).status, DEVICE_STATUS.DISABLED);
  assert.equal(fx.deviceService.enableDevice({ context: fx.adminCtx(), deviceId: id }).ok, true);
  assert.equal(fx.deviceStore.deviceById(id).status, DEVICE_STATUS.ACTIVE);
  assert.equal(fx.deviceService.revokeDevice({ context: fx.adminCtx(), deviceId: id }).ok, true);
  assert.equal(fx.deviceStore.deviceById(id).status, DEVICE_STATUS.REVOKED);
  const re = fx.deviceService.enableDevice({ context: fx.adminCtx(), deviceId: id });
  assert.equal(re.ok, false);
  assert.equal(re.error, deviceDomain.REASON.DEVICE_REVOKED);
});

test("rename 只改 displayName：deviceId / 状态 / 证书身份全部不变", async () => {
  const fx = await createDeviceFixture();
  const { device, fingerprint } = await pairDevice(fx, { displayName: "旧名字" });
  const id = device.deviceId;
  const ren = fx.deviceService.renameDevice({ context: fx.adminCtx(), deviceId: id, displayName: "设计部 GPU 工作站" });
  assert.equal(ren.ok, true);
  assert.equal(ren.device.displayName, "设计部 GPU 工作站");
  const row = fx.deviceStore.deviceById(id);
  assert.equal(row.id, id);
  assert.equal(row.certificate_identity, fingerprint);
  assert.equal(fx.deviceStore.allDevices().length, 1, "rename 不能产生第二台设备");
});

test("OFFLINE ≠ REVOKED：离线只改 connectivity，状态不变（§6 §36）", async () => {
  const fx = await createDeviceFixture();
  const { device } = await pairDevice(fx);
  fx.advance(10 * 60 * 1000);
  const off = fx.deviceService.markOffline(device.deviceId, { at: fx.now(), thresholdMs: 1000 });
  assert.equal(off.ok, true);
  assert.equal(off.changed, true);
  const row = fx.deviceStore.deviceById(device.deviceId);
  assert.equal(row.connectivity, CONNECTIVITY.OFFLINE);
  assert.equal(row.status, DEVICE_STATUS.ACTIVE, "离线不得自动变成 REVOKED");
  const statuses = new Set([row.status, row.connectivity]);
  assert.notEqual([...statuses].join("|"), "Unavailable");
});

test("未注册设备 / 不存在的 deviceId：DENY 且理由不泄漏存在性", async () => {
  const fx = await createDeviceFixture();
  const res = fx.deviceService.authorizeDeviceById({ context: fx.adminCtx(), deviceId: "dev_does_not_exist_000000" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, deviceDomain.REASON.NOT_FOUND_OR_FORBIDDEN);
});
