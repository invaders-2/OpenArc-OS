/**
 * D3-03 · device-cross-org.test
 * Device 绑定 organizationId；Org B 的用户不能仅凭 deviceId 使用 Org A 的设备（§9）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceFixture, pairDevice, deviceDomain } from "./device-fixtures.mjs";

const { REASON } = deviceDomain;

test("跨组织：foreign 用户 list 看不到、get/use 一律 DENY 且理由不泄漏存在性", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx, { fingerprint: "fp_org_a" });
  assert.equal(fx.deviceService.listDevices({ context: fx.ctx("bob") }).items.length, 0, "foreign 组织不应看到任何设备");
  const get = fx.deviceService.getDevice({ context: fx.ctx("bob"), deviceId: paired.device.deviceId });
  assert.equal(get.ok, false);
  assert.equal(get.error, REASON.DEVICE_NOT_FOUND);
  const use = fx.deviceService.authorizeDeviceById({ context: fx.ctx("bob"), deviceId: paired.device.deviceId });
  assert.equal(use.ok, false);
  assert.equal(use.reason, REASON.NOT_FOUND_OR_FORBIDDEN);
});

test("跨组织判定在状态判定之后仍是独立原因码（管理员视角可区分）", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx);
  const device = fx.deviceStore.deviceById(paired.device.deviceId);
  const verdict = fx.deviceService.authorizeDevice({ device, action: "device.use", actor: { userId: fx.users.bob, role: "MEMBER", organizationId: fx.foreignOrgId } });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.error, REASON.CROSS_ORGANIZATION_DEVICE);
});

test("foreign 用户不能发起 Pairing（不是本组织管理员 = 无 device.pair）", async () => {
  const fx = await createDeviceFixture();
  const res = fx.deviceService.createPairing({ context: fx.ctx("bob") });
  assert.equal(res.ok, false);
  assert.equal(res.error, REASON.NOT_SUPER_ADMIN);
});

test("配对 token 绑组织：跨组织设备不得用别组织的 token 注册", async () => {
  const fx = await createDeviceFixture();
  const created = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });
  const res = fx.deviceService.consumePairing({ secret: created.secret, serviceIdentitySeen: fx.serviceIdentity, deviceIdentity: { organizationId: fx.foreignOrgId, fingerprint: "fp_x" } });
  assert.equal(res.ok, false);
  assert.equal(res.error, REASON.PAIRING_TOKEN_ORGANIZATION_MISMATCH);
  assert.equal(fx.deviceStore.allDevices().length, 0);
});
