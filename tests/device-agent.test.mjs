/**
 * D3-03 · device-agent.test
 * §73 §41：Agent 没有"任意设备权限" —— 它只能用**当前 User** 对目标设备的 device.use。
 * Agent 不能绕过 Device Gate。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createDeviceFixture, pairDevice, deviceDomain } from "./device-fixtures.mjs";

const require = createRequire(import.meta.url);
const authzDomain = require("../electron/authorization-domain.cjs");
const { DEVICE_ACTION, REASON } = deviceDomain;

/** §73 场景：App = ai，且 ai 被授权可使用 Agent（resource.useByAgent 不在常规集合里，必须单独给）。 */
function grantAiApp(fx) {
  const r = fx.authService.grantAppResourcePermission({
    context: fx.adminCtx(),
    appId: "ai",
    resourceType: "document",
    actions: ["resource.view", "resource.read", "resource.search", "resource.preview", "resource.useByAgent"],
  });
  assert.equal(r.ok, true, "ai app grant failed: " + JSON.stringify(r));
}

test("User + App + Agent + Resource + Device 全允许 → ALLOW", async () => {
  const fx = await createDeviceFixture();
  const reg = fx.authService.registerResource({ context: fx.adminCtx(), resourceType: "document", scope: "ORGANIZATION", name: "Agent Doc", status: "active" });
  const ref = reg.resource.resourceId;
  grantAiApp(fx);
  fx.authService.grantResourcePermission({ context: fx.adminCtx(), principalType: "USER", principalId: fx.users.alice, resourceId: ref, actions: ["resource.read", "resource.search", "resource.useByAgent"], permissionSet: "VIEWER" });
  const paired = await pairDevice(fx, { fingerprint: "fp_agent_1" });
  fx.deviceService.grantDeviceAccess({ context: fx.adminCtx(), deviceId: paired.device.deviceId, principalType: "USER", principalId: fx.users.alice, actions: [DEVICE_ACTION.USE] });

  const ctx = fx.ctx("alice", { appId: "ai", agent: { agentId: "agent_1", useByAgent: true } });
  const res = fx.deviceService.authorizeExecution({ context: ctx, resourceRef: ref, deviceId: paired.device.deviceId, action: DEVICE_ACTION.USE, agent: { useByAgent: true } });
  assert.equal(res.ok, true);
});

test("撤销 device.use 后，Agent 的下一请求立刻 DENY（不能绕设备门）", async () => {
  const fx = await createDeviceFixture();
  const reg = fx.authService.registerResource({ context: fx.adminCtx(), resourceType: "document", scope: "ORGANIZATION", name: "Agent Doc 2", status: "active" });
  const ref = reg.resource.resourceId;
  grantAiApp(fx);
  fx.authService.grantResourcePermission({ context: fx.adminCtx(), principalType: "USER", principalId: fx.users.alice, resourceId: ref, actions: ["resource.read", "resource.useByAgent"], permissionSet: "VIEWER" });
  const paired = await pairDevice(fx, { fingerprint: "fp_agent_2" });
  fx.deviceService.grantDeviceAccess({ context: fx.adminCtx(), deviceId: paired.device.deviceId, principalType: "USER", principalId: fx.users.alice, actions: [DEVICE_ACTION.USE] });
  const ctx = fx.ctx("alice", { appId: "ai", agent: { agentId: "agent_2" } });
  assert.equal(fx.deviceService.authorizeExecution({ context: ctx, resourceRef: ref, deviceId: paired.device.deviceId }).ok, true);

  fx.deviceService.disableDevice({ context: fx.adminCtx(), deviceId: paired.device.deviceId });
  const after = fx.deviceService.authorizeExecution({ context: ctx, resourceRef: ref, deviceId: paired.device.deviceId });
  assert.equal(after.ok, false);
  assert.equal(after.side, "DEVICE");
  assert.equal(after.error, REASON.DEVICE_DISABLED);
});

test("Agent 不能自己给自己加设备权限：访问授权必须由管理员下发", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx, { fingerprint: "fp_agent_3" });
  const grant = fx.deviceService.grantDeviceAccess({ context: fx.ctx("alice", { agent: { agentId: "agent_3" } }), deviceId: paired.device.deviceId, principalType: "USER", principalId: fx.users.alice, actions: [DEVICE_ACTION.USE] });
  assert.equal(grant.ok, false, "普通用户/Agent 不能自己给自己发设备授权");
  assert.equal(grant.error, REASON.NOT_SUPER_ADMIN);
});
