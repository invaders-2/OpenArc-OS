/**
 * D3-03 · device-impersonation.test
 * Device A 的凭据不能宣称自己是 Device B；指纹与 deviceId 必须一致（§33 §34 §59）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceFixture, pairDevice, deviceDomain } from "./device-fixtures.mjs";

const { REASON } = deviceDomain;

test("心跳里 deviceId = 另一台设备 → DENY", async () => {
  const fx = await createDeviceFixture();
  const a = await pairDevice(fx, { displayName: "A", fingerprint: "fp_imp_a" });
  const b = await pairDevice(fx, { displayName: "B", fingerprint: "fp_imp_b" });
  const connA = { ...fx.deviceService.authenticateConnection({ fingerprint: "fp_imp_a" }), close: () => {} };
  assert.equal(connA.deviceId, a.device.deviceId);

  const spoof = fx.deviceService.heartbeat({ connection: connA, payload: { deviceId: b.device.deviceId, agentVersion: "9.9.9" } });
  assert.equal(spoof.ok, false);
  assert.equal(spoof.error, REASON.DEVICE_IDENTITY_MISMATCH);

  const good = fx.deviceService.heartbeat({ connection: connA, payload: { deviceId: a.device.deviceId, agentVersion: "1.0.0" } });
  assert.equal(good.ok, true);
});

test("连接上的凭据指纹与凭据行不一致 → DENY（防伪造连接对象）", async () => {
  const fx = await createDeviceFixture();
  const a = await pairDevice(fx, { fingerprint: "fp_cred_a" });
  const conn = { ...fx.deviceService.authenticateConnection({ fingerprint: "fp_cred_a" }), close: () => {} };
  conn.credential = { ...conn.credential, fingerprint: "fp_forged" };
  const res = fx.deviceService.heartbeat({ connection: conn, payload: { deviceId: a.device.deviceId } });
  assert.equal(res.ok, false);
  assert.equal(res.error, REASON.DEVICE_CREDENTIAL_MISMATCH);
});

test("未注册指纹不得解析出任何设备（第一层就挡住）", async () => {
  const fx = await createDeviceFixture();
  await pairDevice(fx, { fingerprint: "fp_known" });
  const res = fx.deviceService.authenticateConnection({ fingerprint: "fp_unknown_attacker" });
  assert.equal(res.ok, false);
  assert.equal(res.error, REASON.DEVICE_CREDENTIAL_UNKNOWN);
});