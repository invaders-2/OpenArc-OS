/**
 * D3-03 · device-pairing.test
 * Pairing Credential：短时、单次、只存 hash、绑组织、验 Service Identity（§15 §16 §19 §47 §60）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceFixture, deviceDomain, SERVICE_IDENTITY } from "./device-fixtures.mjs";

const { REASON, PAIRING_STATUS } = deviceDomain;

test("createPairing：secret 随机、只返回一次，库里只有 sha256", async () => {
  const fx = await createDeviceFixture();
  const a = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });
  const b = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });
  assert.equal(a.ok, true);
  assert.notEqual(a.secret, b.secret);
  assert.ok(a.secret.length >= 40);
  assert.equal(a.pairing.status, PAIRING_STATUS.ISSUED);
  assert.equal(a.pairing.expiresAt, fx.now() + 60000);
  const stored = fx.deviceStore.pairingBySecretHash(deviceDomain.pairingSecretHash(a.secret));
  assert.ok(stored);
  assert.notEqual(stored.secret_hash, a.secret);
  assert.equal(stored.secret_hash.length, 64);
});

test("Pairing 成功 → 设备 ACTIVE + 凭据生效；token 变 CONSUMED（不是被删掉）", async () => {
  const fx = await createDeviceFixture();
  const created = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });
  const res = fx.deviceService.consumePairing({
    secret: created.secret,
    serviceIdentitySeen: SERVICE_IDENTITY,
    deviceIdentity: { displayName: "GPU", platform: "darwin", architecture: "arm64", fingerprint: "fp_pair_ok_1" },
  });
  assert.equal(res.ok, true);
  assert.equal(res.device.status, "ACTIVE");
  assert.equal(res.credential.credentialVersion, 1);
  assert.equal(fx.deviceStore.pairingById(created.pairing.id).status, PAIRING_STATUS.CONSUMED);
  assert.equal(fx.deviceStore.pairingById(created.pairing.id).consumed_by_device_id, res.device.deviceId);
});

test("过期边界：now >= expiresAt 即失效（before / at / after 三点）", async () => {
  const fx = await createDeviceFixture();
  const mk = (label) => {
    const created = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });
    return created;
  };
  // before：差 1ms 仍可用
  const p1 = mk();
  fx.advance(59999);
  const okRes = fx.deviceService.consumePairing({ secret: p1.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: { displayName: "A", fingerprint: "fp_before" } });
  assert.equal(okRes.ok, true, "到期前必须可用");

  // at：恰好到期即拒绝
  const p2 = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });
  fx.advance(60000);
  const atRes = fx.deviceService.consumePairing({ secret: p2.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: { displayName: "B", fingerprint: "fp_at" } });
  assert.equal(atRes.ok, false);
  assert.equal(atRes.error, REASON.PAIRING_TOKEN_EXPIRED);
  assert.equal(fx.deviceStore.pairingById(p2.pairing.id).status, PAIRING_STATUS.EXPIRED);

  // after：继续拒绝
  fx.advance(1000);
  const afterRes = fx.deviceService.consumePairing({ secret: p2.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: { displayName: "C", fingerprint: "fp_after" } });
  assert.equal(afterRes.ok, false);
  assert.equal(afterRes.error, REASON.PAIRING_TOKEN_EXPIRED);
  assert.equal(fx.deviceStore.allDevices().length, 1, "过期 token 不得注册设备");
});

test("未知 token / 组织不匹配 / Service Identity 不匹配 一律 DENY", async () => {
  const fx = await createDeviceFixture();
  const unknown = fx.deviceService.consumePairing({ secret: "not-a-real-secret", serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: {} });
  assert.equal(unknown.error, REASON.PAIRING_TOKEN_UNKNOWN);

  const created = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });
  const badSvc = fx.deviceService.consumePairing({ secret: created.secret, serviceIdentitySeen: "svc_wrong", deviceIdentity: {} });
  assert.equal(badSvc.error, REASON.SERVICE_IDENTITY_MISMATCH);

  const okSvc = fx.deviceService.consumePairing({ secret: created.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: { organizationId: "org_other00000000000000" } });
  assert.equal(okSvc.error, REASON.PAIRING_TOKEN_ORGANIZATION_MISMATCH);
  assert.equal(fx.deviceStore.allDevices().length, 0, "失败路径不得留下设备");
});

test("撤销未使用的 pairing：之后不可再用", async () => {
  const fx = await createDeviceFixture();
  const created = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });
  assert.equal(fx.deviceService.revokePairing({ context: fx.adminCtx(), pairingId: created.pairing.id }).ok, true);
  const res = fx.deviceService.consumePairing({ secret: created.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: {} });
  assert.equal(res.ok, false);
  assert.equal(res.error, REASON.PAIRING_TOKEN_REVOKED);
  assert.equal(fx.deviceStore.allDevices().length, 0);
});
