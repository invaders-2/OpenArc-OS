/**
 * D3-03 · device-resource-intersection.test
 * §72 Resource Library 验收契约：**资源权限与设备权限是交集**。
 * 这一条不实现 Resource Library，只用 D3-02 已有的资源授权 + D3-03 的设备授权做组合证明。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createDeviceFixture, pairDevice, deviceDomain } from "./device-fixtures.mjs";

const require = createRequire(import.meta.url);
const authzDomain = require("../electron/authorization-domain.cjs");
const { DEVICE_ACTION, REASON } = deviceDomain;

/** 造一个真实资源（可指定 owner 与是否给 alice 读权限）；返回 resourceRef。 */
function seedResource(fx, { ownerUserId = null, scope = "ORGANIZATION", grantToAlice = true, name = "Design Spec" } = {}) {
  const reg = fx.authService.registerResource({
    context: fx.adminCtx(),
    resourceType: "document",
    ownerUserId,
    scope,
    name,
    status: "active",
  });
  assert.equal(reg.ok, true, "registerResource failed: " + JSON.stringify(reg));
  const ref = reg.resource.resourceId || reg.resource.resource_id;
  // D3-02 的授权链里 App 也要被授权：这里把 resource-library 当系统 UI 全局开放（与既有夹具同口径）
  const appGrant = fx.authService.grantAppResourcePermission({ context: fx.adminCtx(), appId: "resource-library", actions: authzDomain.RESOURCE_ACTIONS });
  assert.equal(appGrant.ok, true, "grantAppResourcePermission failed: " + JSON.stringify(appGrant));
  if (grantToAlice) {
    const grant = fx.authService.grantResourcePermission({
      context: fx.adminCtx(),
      principalType: "USER",
      principalId: fx.users.alice,
      resourceId: ref,
      actions: ["resource.read"],
      permissionSet: "VIEWER",
    });
    assert.equal(grant.ok, true, "grantResourcePermission failed: " + JSON.stringify(grant));
  }
  return ref;
}

test("有资源权限但无设备权限 → DENY（side=DEVICE）", async () => {
  const fx = await createDeviceFixture();
  const ref = seedResource(fx);
  const paired = await pairDevice(fx, { fingerprint: "fp_inter_1" });
  const res = fx.deviceService.authorizeExecution({ context: fx.ctx("alice"), resourceRef: ref, deviceId: paired.device.deviceId, action: DEVICE_ACTION.USE });
  assert.equal(res.ok, false);
  assert.equal(res.side, "DEVICE");
  assert.equal(res.reason, REASON.NOT_FOUND_OR_FORBIDDEN);
});

test("有设备权限但无资源权限 → DENY（side=RESOURCE）", async () => {
  const fx = await createDeviceFixture();
  // 个人资源、owner 是 admin：dana 既不是 owner 也没有任何 grant，且组织策略不覆盖 PERSONAL
  const ref = seedResource(fx, { ownerUserId: fx.users.admin, scope: "PERSONAL", grantToAlice: false, name: "Admin Personal" });
  const paired = await pairDevice(fx, { fingerprint: "fp_inter_2" });
  fx.deviceService.grantDeviceAccess({ context: fx.adminCtx(), deviceId: paired.device.deviceId, principalType: "USER", principalId: fx.users.dana, actions: [DEVICE_ACTION.USE] });
  // dana 有设备权限，但对这份资源没有任何权限
  const res = fx.deviceService.authorizeExecution({ context: fx.ctx("dana"), resourceRef: ref, deviceId: paired.device.deviceId, action: DEVICE_ACTION.USE });
  assert.equal(res.ok, false);
  assert.equal(res.side, "RESOURCE");
  assert.equal(res.error, REASON.RESOURCE_NOT_AUTHORIZED);
  assert.ok(res.resourceReasonCode, "必须把 D3-02 的失败原因透出来");
});

test("两侧都成立 → ALLOW（side=BOTH）", async () => {
  const fx = await createDeviceFixture();
  const ref = seedResource(fx);
  const paired = await pairDevice(fx, { fingerprint: "fp_inter_3" });
  fx.deviceService.grantDeviceAccess({ context: fx.adminCtx(), deviceId: paired.device.deviceId, principalType: "USER", principalId: fx.users.alice, actions: [DEVICE_ACTION.USE] });
  const res = fx.deviceService.authorizeExecution({ context: fx.ctx("alice"), resourceRef: ref, deviceId: paired.device.deviceId, action: DEVICE_ACTION.USE });
  assert.equal(res.ok, true);
  assert.equal(res.side, "BOTH");
  assert.equal(res.resource.decision, "ALLOW");
});

test("设备被撤销后，即使资源权限仍在 → DENY（交集随设备状态收缩）", async () => {
  const fx = await createDeviceFixture();
  const ref = seedResource(fx);
  const paired = await pairDevice(fx, { fingerprint: "fp_inter_4" });
  fx.deviceService.grantDeviceAccess({ context: fx.adminCtx(), deviceId: paired.device.deviceId, principalType: "USER", principalId: fx.users.alice, actions: [DEVICE_ACTION.USE] });
  assert.equal(fx.deviceService.authorizeExecution({ context: fx.ctx("alice"), resourceRef: ref, deviceId: paired.device.deviceId, action: DEVICE_ACTION.USE }).ok, true);
  fx.deviceService.revokeDevice({ context: fx.adminCtx(), deviceId: paired.device.deviceId });
  const after = fx.deviceService.authorizeExecution({ context: fx.ctx("alice"), resourceRef: ref, deviceId: paired.device.deviceId, action: DEVICE_ACTION.USE });
  assert.equal(after.ok, false);
  assert.equal(after.side, "DEVICE");
  assert.equal(after.error, REASON.DEVICE_REVOKED);
});
