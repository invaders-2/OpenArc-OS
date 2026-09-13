/**
 * D3-03 · device-session-auth.test
 * 设备管理动作必须过会话闸门 + 授权（§13 §14 §51 §52）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceFixture, pairDevice, deviceDomain } from "./device-fixtures.mjs";

const { DEVICE_ACTION } = deviceDomain;

test("无会话 / 伪造会话：全部管理动作 DENY", async () => {
  const fx = await createDeviceFixture();
  const { device } = await pairDevice(fx);
  const cases = [
    fx.deviceService.createPairing({ context: { appId: "resource-library" } }),
    fx.deviceService.disableDevice({ context: { sessionRef: "sess_forged" }, deviceId: device.deviceId }),
    fx.deviceService.revokeDevice({ context: {}, deviceId: device.deviceId }),
    fx.deviceService.renameDevice({ context: { sessionRef: "sess_forged" }, deviceId: device.deviceId, displayName: "x" }),
    fx.deviceService.listDevices({}),
  ];
  for (const res of cases) assert.equal(res.ok, false, "无有效会话必须 DENY");
  assert.equal(fx.deviceStore.deviceById(device.deviceId).status, "ACTIVE");
});

test("普通用户：没有 device.pair / device.manage，直接调用 Domain 也 DENY（不能只靠隐藏按钮）", async () => {
  const fx = await createDeviceFixture();
  const { device } = await pairDevice(fx);
  const pair = fx.deviceService.createPairing({ context: fx.ctx("alice") });
  assert.equal(pair.ok, false);
  assert.equal(pair.error, deviceDomain.REASON.NOT_SUPER_ADMIN);
  const disable = fx.deviceService.disableDevice({ context: fx.ctx("alice"), deviceId: device.deviceId });
  assert.equal(disable.ok, false);
  assert.equal(disable.error, deviceDomain.REASON.NOT_SUPER_ADMIN);
  const revoke = fx.deviceService.revokeDevice({ context: fx.ctx("dana"), deviceId: device.deviceId });
  assert.equal(revoke.ok, false);
  assert.equal(revoke.error, deviceDomain.REASON.NOT_SUPER_ADMIN, "部门管理员默认不得 revoke");
  assert.equal(fx.deviceStore.deviceById(device.deviceId).status, "ACTIVE");
});

test("普通用户对未授权设备：device.use DENY（默认拒绝）", async () => {
  const fx = await createDeviceFixture();
  const { device } = await pairDevice(fx);
  const res = fx.deviceService.authorizeDeviceById({ context: fx.ctx("alice"), deviceId: device.deviceId, action: DEVICE_ACTION.USE });
  assert.equal(res.ok, false);
  assert.equal(res.reason, deviceDomain.REASON.NOT_FOUND_OR_FORBIDDEN);
});

test("显式授权后普通用户可以 device.use；未授予的动作仍然 DENY", async () => {
  const fx = await createDeviceFixture();
  const { device } = await pairDevice(fx);
  const grant = fx.deviceService.grantDeviceAccess({
    context: fx.adminCtx(),
    deviceId: device.deviceId,
    principalType: "USER",
    principalId: fx.users.alice,
    actions: [DEVICE_ACTION.USE],
  });
  assert.equal(grant.ok, true);
  assert.equal(fx.deviceService.authorizeDeviceById({ context: fx.ctx("alice"), deviceId: device.deviceId, action: DEVICE_ACTION.USE }).ok, true);
  assert.equal(fx.deviceService.authorizeDeviceById({ context: fx.ctx("alice"), deviceId: device.deviceId, action: DEVICE_ACTION.MANAGE }).ok, false);
});

test("会话被撤销后，设备动作立刻 DENY（不缓存授权结论）", async () => {
  const fx = await createDeviceFixture();
  const { device } = await pairDevice(fx);
  fx.deviceService.grantDeviceAccess({ context: fx.adminCtx(), deviceId: device.deviceId, principalType: "USER", principalId: fx.users.alice, actions: [DEVICE_ACTION.USE] });
  assert.equal(fx.deviceService.authorizeDeviceById({ context: fx.ctx("alice"), deviceId: device.deviceId, action: DEVICE_ACTION.USE }).ok, true);
  const logout = fx.identity.logout(fx.sessions.alice);
  assert.equal(logout.ok, true);
  const after = fx.deviceService.authorizeDeviceById({ context: fx.ctx("alice"), deviceId: device.deviceId, action: DEVICE_ACTION.USE });
  assert.equal(after.ok, false);
});
