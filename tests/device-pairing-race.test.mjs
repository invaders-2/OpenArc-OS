/**
 * D3-03 · device-pairing-race.test
 * 两个客户端同时用同一个 token：**恰好一个成功**（§17 §57）。
 *
 * 这里刻意用两种真实路径测：
 *   ① store 层原语：同一条 ISSUED 记录连续两次 consume → changes 1 然后 0；
 *   ② 两个独立连接（两个 IdentityStore 打开同一个库文件）并发消费：
 *      允许输家以 SQLITE_BUSY 或 ALREADY_USED 失败，但**必须恰好一台设备**落库。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createDeviceFixture, deviceDomain, pairDevice, tempDbPath, SERVICE_IDENTITY } from "./device-fixtures.mjs";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { DeviceStore } = require("../electron/device-store.cjs");
const { DeviceService } = require("../electron/device-service.cjs");

const { REASON, PAIRING_STATUS } = deviceDomain;

test("store 原语：单次消费只可能成功一次", async () => {
  const fx = await createDeviceFixture();
  const created = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });
  const row = fx.deviceStore.pairingBySecretHash(deviceDomain.pairingSecretHash(created.secret));
  const first = fx.deviceStore.consumePairing(row.id, { deviceId: "dev_race_winner_00000001", at: fx.now() });
  const second = fx.deviceStore.consumePairing(row.id, { deviceId: "dev_race_loser_000000002", at: fx.now() });
  assert.equal(first.consumed, true);
  assert.equal(second.consumed, false);
  assert.equal(fx.deviceStore.pairingById(row.id).status, PAIRING_STATUS.CONSUMED);
  assert.equal(fx.deviceStore.pairingById(row.id).consumed_by_device_id, "dev_race_winner_00000001");
});

test("两个连接并发消费同一 token：恰好一台设备注册成功", async () => {
  const dbPath = tempDbPath("openarc-d3-03-race");
  const fx = await createDeviceFixture({ dbPath });
  const created = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });

  const openSecond = () => {
    const identity = new IdentityStore({ path: dbPath, clock: fx.clock }).open();
    const store = new DeviceStore({ identity, clock: fx.clock });
    const service = new DeviceService({ identity, deviceStore: store, clock: fx.clock, serviceIdentity: SERVICE_IDENTITY });
    return { identity, store, service };
  };
  const b = openSecond();
  const mk = (svc, name) => {
    try {
      return svc.consumePairing({ secret: created.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: { displayName: name, fingerprint: "fp_" + name } });
    } catch (e) {
      return { ok: false, error: "DB_BUSY", thrown: String(e && e.message) };
    }
  };
  const [ra, rb] = await Promise.all([Promise.resolve().then(() => mk(fx.deviceService, "A")), Promise.resolve().then(() => mk(b.service, "B"))]);
  const oks = [ra, rb].filter((r) => r.ok).length;
  assert.equal(oks, 1, "必须恰好一个成功：" + JSON.stringify([ra.error || "ok", rb.error || "ok"]));
  const loser = [ra, rb].find((r) => !r.ok);
  assert.ok([REASON.PAIRING_TOKEN_ALREADY_USED, "DB_BUSY"].includes(loser.error), "输家的失败原因必须是已使用或写冲突：" + loser.error);
  assert.equal(fx.deviceStore.allDevices().length, 1, "绝不能注册两台设备");
  b.identity.close();
});

test("输掉 race 的事务整体回滚：不留下半台设备、不留下已消费的 token", async () => {
  const fx = await createDeviceFixture();
  const created = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });
  const row = fx.deviceStore.pairingBySecretHash(deviceDomain.pairingSecretHash(created.secret));
  // 先让别人消费掉
  fx.deviceStore.consumePairing(row.id, { deviceId: "dev_someone_else_00000001", at: fx.now() });
  const res = fx.deviceService.consumePairing({ secret: created.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: { displayName: "L", fingerprint: "fp_late" } });
  assert.equal(res.ok, false);
  assert.equal(res.error, REASON.PAIRING_TOKEN_ALREADY_USED);
  assert.equal(fx.deviceStore.allDevices().length, 0, "失败者不得留下自己的设备行");
  assert.equal(fx.deviceStore.pairingById(row.id).consumed_by_device_id, "dev_someone_else_00000001");
});
