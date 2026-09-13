/**
 * D3-03 · device-disable.test
 * Disable 是**可恢复的管理动作**，与 Revoke 的恢复路径不同（§27 §6）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceFixture, pairDevice, deviceDomain } from "./device-fixtures.mjs";

const { REASON, DEVICE_STATUS } = deviceDomain;

test("disable → DENY；enable → 恢复 ALLOW（同一 deviceId、同一凭据版本）", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx);
  const id = paired.device.deviceId;

  assert.equal(fx.deviceService.disableDevice({ context: fx.adminCtx(), deviceId: id }).ok, true);
  const denied = fx.deviceService.authorizeDeviceById({ context: fx.adminCtx(), deviceId: id });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, REASON.DEVICE_DISABLED);

  const enabled = fx.deviceService.enableDevice({ context: fx.adminCtx(), deviceId: id });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.device.deviceId, id);
  assert.equal(fx.deviceService.authorizeDeviceById({ context: fx.adminCtx(), deviceId: id }).ok, true);
  assert.equal(fx.deviceStore.allDevices().length, 1);
});

test("disable 与 revoke 的原因码不同（禁止混成同一个 Unavailable）", async () => {
  const fx = await createDeviceFixture();
  const a = await pairDevice(fx, { displayName: "A", fingerprint: "fp_dis_a" });
  const b = await pairDevice(fx, { displayName: "B", fingerprint: "fp_dis_b" });
  fx.deviceService.disableDevice({ context: fx.adminCtx(), deviceId: a.device.deviceId });
  fx.deviceService.revokeDevice({ context: fx.adminCtx(), deviceId: b.device.deviceId });
  const reasonA = fx.deviceService.authorizeDeviceById({ context: fx.adminCtx(), deviceId: a.device.deviceId }).error;
  const reasonB = fx.deviceService.authorizeDeviceById({ context: fx.adminCtx(), deviceId: b.device.deviceId }).error;
  assert.equal(reasonA, REASON.DEVICE_DISABLED);
  assert.equal(reasonB, REASON.DEVICE_REVOKED);
  assert.notEqual(reasonA, reasonB);
});

test("disable 期间重连：仍然 DENY，且不会生成第二台设备身份（§63）", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx);
  fx.deviceService.disableDevice({ context: fx.adminCtx(), deviceId: paired.device.deviceId });
  const hb = fx.deviceService.heartbeat({
    connection: { ...fx.deviceService.authenticateConnection({ fingerprint: paired.fingerprint }), close: () => {} },
    payload: { deviceId: paired.device.deviceId },
  });
  assert.equal(hb.ok, false);
  assert.equal(fx.deviceStore.allDevices().length, 1, "重连必须沿用同一 deviceId");
  assert.equal(fx.deviceStore.deviceById(paired.device.deviceId).status, DEVICE_STATUS.DISABLED);
});
