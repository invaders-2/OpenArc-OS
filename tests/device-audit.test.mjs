/**
 * D3-03 · device-audit.test
 * 审计事件齐全、字段按 §46、**禁止字段物理上写不进去**，且 pairing secret 全库 0 命中（§47）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createDeviceFixture, pairDevice, deviceDomain, tempDbPath, SERVICE_IDENTITY } from "./device-fixtures.mjs";

const { AUDIT_EVENT, AUDIT_FORBIDDEN_KEYS } = deviceDomain;

test("关键事件都被记录：PAIRING_CREATED/USED、DEVICE_REGISTERED/DISABLED/REVOKED/CERT_ROTATED/AUTH_DENIED", async () => {
  const fx = await createDeviceFixture();
  const created = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000, requestId: "req_pair_1" });
  const res = fx.deviceService.consumePairing({ secret: created.secret, serviceIdentitySeen: fx.serviceIdentity, deviceIdentity: { displayName: "GPU", fingerprint: "fp_audit_1" }, requestId: "req_use_1" });
  assert.equal(res.ok, true);
  const id = res.device.deviceId;
  fx.deviceService.disableDevice({ context: fx.adminCtx(), deviceId: id });
  fx.deviceService.enableDevice({ context: fx.adminCtx(), deviceId: id });
  fx.deviceService.rotateDeviceCredential({ context: fx.adminCtx(), deviceId: id, newIdentity: { fingerprint: "fp_audit_2" } });
  fx.deviceService.revokeDevice({ context: fx.adminCtx(), deviceId: id });
  fx.deviceService.authenticateConnection({ fingerprint: "fp_unknown_for_audit" });

  const audit = fx.deviceService.deviceAudit({ context: fx.adminCtx() });
  assert.equal(audit.ok, true);
  const events = new Set(audit.items.map((a) => a.event));
  for (const ev of [AUDIT_EVENT.PAIRING_CREATED, AUDIT_EVENT.PAIRING_USED, AUDIT_EVENT.DEVICE_REGISTERED, AUDIT_EVENT.DEVICE_DISABLED, AUDIT_EVENT.DEVICE_ENABLED, AUDIT_EVENT.CERT_ROTATED, AUDIT_EVENT.DEVICE_REVOKED, AUDIT_EVENT.TLS_AUTH_FAILED]) {
    assert.ok(events.has(ev), "缺少审计事件 " + ev);
  }
  const first = audit.items.find((a) => a.event === AUDIT_EVENT.PAIRING_CREATED);
  for (const f of ["at", "event", "reason_code", "request_id", "actor_user_id", "organization_id"]) assert.ok(f in first, "审计字段缺失 " + f);
  assert.equal(first.request_id, "req_pair_1");
});

test("禁止字段不会落库：即使调用方塞进来也会被剔除", async () => {
  const fx = await createDeviceFixture();
  const paired = await pairDevice(fx);
  fx.deviceStore.appendAudit({
    event: "ATTEMPT_WITH_SECRETS",
    deviceId: paired.device.deviceId,
    detail: { privateKey: "-----BEGIN PRIVATE KEY-----", pairingSecret: "s3cr3t", pem: "x", safe: "kept" },
  });
  const row = fx.deviceStore.allAudit().find((a) => a.event === "ATTEMPT_WITH_SECRETS");
  assert.ok(row);
  assert.equal(row.detail.safe, "kept");
  for (const k of AUDIT_FORBIDDEN_KEYS) assert.equal(k in row.detail, false, "禁止字段泄漏: " + k);
});

test("§47 pairing secret 明文全库 0 命中", async () => {
  const dbPath = tempDbPath("openarc-d3-03-audit");
  const fx = await createDeviceFixture({ dbPath });
  const created = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs: 60000 });
  const res = fx.deviceService.consumePairing({ secret: created.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: { displayName: "GPU", fingerprint: "fp_scan_1" } });
  assert.equal(res.ok, true);
  fx.identity.close();

  const bytes = fs.readFileSync(dbPath);
  const hits = bytes.includes(Buffer.from(created.secret, "utf8")) ? 1 : 0;
  // WAL 里也要查
  const wal = dbPath + "-wal";
  const walHits = fs.existsSync(wal) && fs.readFileSync(wal).includes(Buffer.from(created.secret, "utf8")) ? 1 : 0;
  assert.equal(hits + walHits, 0, "pairing secret 明文不得出现在数据库文件中");
  const hashHits = bytes.includes(Buffer.from(deviceDomain.pairingSecretHash(created.secret), "utf8")) ? 1 : 0;
  assert.equal(hashHits, 1, "应当存的是 sha256（用于反查）");
});

test("审计读取也要过权限：普通用户拿不到", async () => {
  const fx = await createDeviceFixture();
  await pairDevice(fx);
  const res = fx.deviceService.deviceAudit({ context: fx.ctx("alice") });
  assert.equal(res.ok, false);
  assert.equal(res.error, deviceDomain.REASON.NOT_SUPER_ADMIN);
});
