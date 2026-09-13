/**
 * D3-03 · device-pairing-replay.test
 * 成功配对后重复提交同一 token：必须 DENY（同 IP / 同 hostname 也不行，§18 §63）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceFixture, deviceDomain, SERVICE_IDENTITY } from "./device-fixtures.mjs";

const { REASON } = deviceDomain;

test("replay：同一 token 第二次提交 DENY，且不会产生第二台设备", async () => {
  const fx = await createDeviceFixture();
  const created = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });
  const first = fx.deviceService.consumePairing({ secret: created.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: { displayName: "A", fingerprint: "fp_replay_a" } });
  assert.equal(first.ok, true);
  const second = fx.deviceService.consumePairing({ secret: created.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: { displayName: "B", fingerprint: "fp_replay_b" } });
  assert.equal(second.ok, false);
  assert.equal(second.error, REASON.PAIRING_TOKEN_ALREADY_USED);
  assert.equal(fx.deviceStore.allDevices().length, 1);
});

test("replay 不因来源看起来可信而放行（同 IP / 同 hostname）", async () => {
  const fx = await createDeviceFixture();
  const created = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });
  const identity = { displayName: "WS", platform: "darwin", architecture: "arm64", fingerprint: "fp_same", hostname: "same-host", ip: "127.0.0.1" };
  assert.equal(fx.deviceService.consumePairing({ secret: created.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: identity }).ok, true);
  const replay = fx.deviceService.consumePairing({ secret: created.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: identity });
  assert.equal(replay.ok, false);
  assert.equal(replay.error, REASON.PAIRING_TOKEN_ALREADY_USED);
});

test("配对成功后 pairing secret 不再具备任何设备认证能力（§16）", async () => {
  const fx = await createDeviceFixture();
  const created = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });
  const paired = fx.deviceService.consumePairing({ secret: created.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: { displayName: "A", fingerprint: "fp_bootstrap" } });
  assert.equal(paired.ok, true);
  // 用过 pairing secret 当"设备凭据"来认证：必须失败（它根本不是凭据指纹）
  const auth = fx.deviceService.authenticateConnection({ fingerprint: created.secret });
  assert.equal(auth.ok, false);
  assert.equal(auth.error, REASON.DEVICE_CREDENTIAL_UNKNOWN);
});
