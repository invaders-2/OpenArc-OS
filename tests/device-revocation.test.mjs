/**
 * D3-03 · device-revocation.test
 * 撤销立即生效：不等证书过期；已建立的长连接要断；下一条受保护消息要拒（§25 §26 §27）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceFixture, pairDevice, deviceDomain } from "./device-fixtures.mjs";

const { REASON, DEVICE_STATUS, CREDENTIAL_STATUS, CONNECTIVITY } = deviceDomain;

test("撤销后：凭据立即失效、连接被关闭、下一次认证 DENY", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx);
  const conn = fx.deviceService.authenticateConnection({ fingerprint: paired.fingerprint });
  assert.equal(conn.ok, true, "撤销前必须能认证");

  let closedReason = null;
  fx.deviceService.registerConnection({ deviceId: paired.device.deviceId, close: (r) => (closedReason = r) });

  const rev = fx.deviceService.revokeDevice({ context: fx.adminCtx(), deviceId: paired.device.deviceId, reason: "lost laptop" });
  assert.equal(rev.ok, true);
  assert.equal(rev.device.status, DEVICE_STATUS.REVOKED);
  assert.equal(closedReason, "DEVICE_REVOKED", "已建立连接必须被主动关闭");

  const after = fx.deviceService.authenticateConnection({ fingerprint: paired.fingerprint });
  assert.equal(after.ok, false, "撤销后同一张仍然密码学有效的证书不得再通过");

  const creds = fx.deviceStore.credentialsOfDevice(paired.device.deviceId);
  assert.equal(creds.every((c) => c.status !== CREDENTIAL_STATUS.ACTIVE), true, "撤销必须让活跃凭据全部失效");
  assert.equal(fx.deviceStore.deviceById(paired.device.deviceId).connectivity, CONNECTIVITY.OFFLINE);
});

test("撤销后 authorizeDeviceById 立即 DENY（不缓存在连接里）", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx);
  assert.equal(fx.deviceService.authorizeDeviceById({ context: fx.adminCtx(), deviceId: paired.device.deviceId }).ok, true);
  fx.deviceService.revokeDevice({ context: fx.adminCtx(), deviceId: paired.device.deviceId });
  const res = fx.deviceService.authorizeDeviceById({ context: fx.adminCtx(), deviceId: paired.device.deviceId });
  assert.equal(res.ok, false);
  assert.equal(res.error, REASON.DEVICE_REVOKED);
});

test("撤销是终态：不能再 enable 回来，也不能靠继续心跳复活（§27 §35）", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx);
  const auth = fx.deviceService.authenticateConnection({ fingerprint: paired.fingerprint });
  const connection = { ...auth, close: () => {} };
  fx.deviceService.revokeDevice({ context: fx.adminCtx(), deviceId: paired.device.deviceId });

  const enable = fx.deviceService.enableDevice({ context: fx.adminCtx(), deviceId: paired.device.deviceId });
  assert.equal(enable.ok, false);
  assert.equal(enable.error, REASON.DEVICE_REVOKED);

  const hb = fx.deviceService.heartbeat({ connection, payload: { deviceId: paired.device.deviceId, agentVersion: "1.0.0" } });
  assert.equal(hb.ok, false, "REVOKED 设备不能因为持续心跳恢复授权");
  assert.equal(fx.deviceStore.deviceById(paired.device.deviceId).status, DEVICE_STATUS.REVOKED);
});

test("设备记录不被物理删除：撤销后仍在 Registry 且可查审计（§45）", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx);
  fx.deviceService.revokeDevice({ context: fx.adminCtx(), deviceId: paired.device.deviceId });
  assert.equal(fx.deviceStore.allDevices().length, 1, "安全记录不得被物理删除");
  const audit = fx.deviceService.deviceAudit({ context: fx.adminCtx(), deviceId: paired.device.deviceId });
  assert.equal(audit.ok, true);
  assert.ok(audit.items.some((a) => a.event === "DEVICE_REVOKED"));
});
