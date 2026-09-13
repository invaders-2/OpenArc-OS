/**
 * D3-03 · device-rotation.test
 * 凭据轮换：旧凭据立即失效、版本单调递增、旧版本不能被悄悄继续接受（§28 §29 §64）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceFixture, pairDevice, deviceDomain } from "./device-fixtures.mjs";

const { REASON, CREDENTIAL_STATUS } = deviceDomain;

test("轮换后：新指纹可用，旧指纹 DENY，版本 +1", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx, { fingerprint: "fp_old_0001" });
  const id = paired.device.deviceId;
  assert.equal(fx.deviceService.authenticateConnection({ fingerprint: "fp_old_0001" }).ok, true);

  const rot = fx.deviceService.rotateDeviceCredential({
    context: fx.adminCtx(),
    deviceId: id,
    newIdentity: { fingerprint: "fp_new_0002", subject: "CN=rotated" },
  });
  assert.equal(rot.ok, true);
  assert.equal(rot.credentialVersion, 2);

  const oldAuth = fx.deviceService.authenticateConnection({ fingerprint: "fp_old_0001" });
  assert.equal(oldAuth.ok, false, "旧凭据必须立即失效");
  assert.equal(oldAuth.error, REASON.DEVICE_CREDENTIAL_STALE);
  assert.equal(fx.deviceService.authenticateConnection({ fingerprint: "fp_new_0002" }).ok, true);

  const creds = fx.deviceStore.credentialsOfDevice(id);
  assert.equal(creds.length, 2);
  assert.equal(creds.find((c) => c.credential_version === 1).status, CREDENTIAL_STATUS.ROTATED);
  assert.equal(creds.find((c) => c.credential_version === 2).status, CREDENTIAL_STATUS.ACTIVE);
  assert.equal(fx.deviceStore.deviceById(id).credential_version, 2);
});

test("版本必须单调：不能把 devices.credential_version 改回旧值后再让旧凭据生效", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx, { fingerprint: "fp_v1_aaaa" });
  const id = paired.device.deviceId;
  fx.deviceService.rotateDeviceCredential({ context: fx.adminCtx(), deviceId: id, newIdentity: { fingerprint: "fp_v2_bbbb" } });
  const stale = fx.deviceStore.credentialsOfDevice(id).find((c) => c.credential_version === 1);
  // 篡改：把旧凭据强行改回 ACTIVE，但 devices.credential_version 仍是 2
  fx.deviceStore.db.prepare("UPDATE device_credentials SET status='ACTIVE' WHERE id = ?").run(stale.id);
  const auth = fx.deviceService.authenticateConnection({ fingerprint: "fp_v1_aaaa" });
  assert.equal(auth.ok, false, "版本不一致的旧凭据不得复活");
  assert.equal(auth.error, REASON.DEVICE_CREDENTIAL_STALE);
});

test("轮换会关闭在旧凭据上建立的长连接（§29 rotation race）", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx, { fingerprint: "fp_race_old" });
  let closed = null;
  fx.deviceService.registerConnection({ deviceId: paired.device.deviceId, close: (r) => (closed = r) });
  fx.deviceService.rotateDeviceCredential({ context: fx.adminCtx(), deviceId: paired.device.deviceId, newIdentity: { fingerprint: "fp_race_new" } });
  assert.equal(closed, "CERT_ROTATED");
});

test("撤销后的设备不得再轮换（必须先重新 Pair）", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx);
  fx.deviceService.revokeDevice({ context: fx.adminCtx(), deviceId: paired.device.deviceId });
  const rot = fx.deviceService.rotateDeviceCredential({ context: fx.adminCtx(), deviceId: paired.device.deviceId, newIdentity: { fingerprint: "fp_after_revoke" } });
  assert.equal(rot.ok, false);
  assert.equal(rot.error, REASON.DEVICE_REVOKED);
});
